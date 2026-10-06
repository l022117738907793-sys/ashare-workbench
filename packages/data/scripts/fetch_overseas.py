#!/usr/bin/env python3
"""抓港股 / 美股的历史日线，以及人民币汇率。

和 fetch_history.py 的关系：那个脚本管 A 股（新浪源，`stock_zh_a_daily`），
这个脚本管境外（`stock_hk_daily` / `stock_us_daily`）。两边写进**同一个目录**
`data/history-cache/`，文件名都是 `<代码>.json`，所以 build-history-shards.ts
不用改就能把境外标的当成普通标的一起切分。

三件事值得写在这里，免得下次有人重新踩：

1. **为什么代码要带后缀。** 缓存文件名就是代码本身（`00700.HK.json`），
   因为切分脚本靠文件名认标的。腾讯的港股代码是 5 位、可以是 4 位（长实 00001），
   美股的代码是字母 —— 光看文件名分不出是沪是深是港是美，所以后缀必须有。
   这和 packages/data/src/codes.ts 里的 PATTERNS 是同一套规则。

2. **为什么不抓复权因子。** `adjust="qfq"` 就是前复权，取回来的价已经除过权，
   和 A 股那边口径一致：收益连续，但不是当年的盘面绝对价位。

3. **汇率单独放一个目录。** `data/fx-cache/`，不放 history-cache ——
   切分脚本会把 history-cache 里每个 .json 都当成一只股票的日线来读，
   汇率序列没有 open/high/low，混进去会被当成坏文件跳过（或者更糟：当成一只
   永远停牌的股票）。分开放，谁也不用猜。

用法：
    python3 packages/data/scripts/fetch_overseas.py                 # 增量，缺什么抓什么
    python3 packages/data/scripts/fetch_overseas.py --fresh         # 全部重抓
    python3 packages/data/scripts/fetch_overseas.py --only HK       # 只抓港股
    python3 packages/data/scripts/fetch_overseas.py --limit 3       # 每市场只抓前 3 只（试跑）
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import akshare as ak
except ImportError:  # pragma: no cover
    print("需要 akshare：pip3 install akshare", file=sys.stderr)
    raise

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
CACHE_DIR = os.path.join(ROOT, "data", "history-cache")
FX_DIR = os.path.join(ROOT, "data", "fx-cache")

DEFAULT_FROM = "2016-01-01"
DEFAULT_TO = "2026-12-31"

# ── 股票池 ────────────────────────────────────────────────────
# 名字写死在这里，不从接口取。两个原因：① stock_hk_daily / stock_us_daily
# 只返回 OHLCV，本来就没有名字；② 我们自己挑的中文名比接口给的更统一
# （「阿里巴巴-W」而不是「ALIBABA GROUP HOLDING-SP ADR」）。
#
# 挑的标准：叫得出名字 + 在这十关覆盖的年份里一直有交易 + 彼此不是重复的故事。
# 港股的「-W」「-SW」是同股不同权标记，保留 —— 它本身是个知识点。

HK_POOL: list[tuple[str, str]] = [
    ("00700", "腾讯控股"),
    ("09988", "阿里巴巴-W"),
    ("03690", "美团-W"),
    ("01810", "小米集团-W"),
    ("01211", "比亚迪股份"),
    ("00941", "中国移动"),
    ("00005", "汇丰控股"),
    ("01299", "友邦保险"),
    ("00388", "香港交易所"),
    ("09618", "京东集团-SW"),
    ("09999", "网易-S"),
    ("09888", "百度集团-SW"),
    ("01024", "快手-W"),
    ("02020", "安踏体育"),
    ("00883", "中国海洋石油"),
    ("00939", "建设银行"),
    ("02318", "中国平安"),
    ("00386", "中国石化"),
    ("06862", "海底捞"),
    ("01088", "中国神华"),
]

# 带中概股是有意的：BABA / JD / PDD / NIO 和港股里的 09988 / 09618 是同一家公司。
# 「同一家公司，两个市场，两个价」是这个游戏能讲、而 A 股讲不了的一课。
#
# ⚠️ 加新标的之前先看这一条：**前复权会把长期高股息的美股扣穿成负数。**
# qfq 是「从今天往回缩」，把历年派息从历史价格里减掉；一只股息率高、历史又长的
# 公司（麦当劳、好市多、星巴克、博通），减到 2016 年会减成负的 —— 实测：
#     MCD 最低收盘 -79.26   COST -83.44   SBUX -32.58   AVGO -3.32
# 而成长股 / 低股息的名字（ORCL 17.13、UBER 14.82）都没事。
# 负价格进引擎**不会报错**：负÷负的涨跌幅是正数，负数金额又小于可用资金，
# 引擎一路放行，最后结算出一笔谁也看不懂的收益。
# 所以：挑标的时优先选低股息 / 成长股；合并前用 nonPositiveCount() 挡一道，
# 详见 packages/data/src/overseas.ts 和 scripts/verify-overseas.ts。
# 星巴克原本在这个池子里，就是因为这个原因换成了甲骨文。
US_POOL: list[tuple[str, str]] = [
    ("AAPL", "苹果"),
    ("MSFT", "微软"),
    ("NVDA", "英伟达"),
    ("GOOGL", "谷歌"),
    ("AMZN", "亚马逊"),
    ("META", "Meta"),
    ("TSLA", "特斯拉"),
    ("TSM", "台积电"),
    ("AMD", "超威半导体"),
    ("INTC", "英特尔"),
    ("NFLX", "奈飞"),
    ("BA", "波音"),
    ("KO", "可口可乐"),
    ("ORCL", "甲骨文"),
    ("DIS", "迪士尼"),
    ("JPM", "摩根大通"),
    ("V", "Visa"),
    ("WMT", "沃尔玛"),
    ("BABA", "阿里巴巴"),
    ("JD", "京东"),
    ("PDD", "拼多多"),
    ("NIO", "蔚来"),
]

# akshare 的 currency_boc_sina 收中文币种名
FX_PAIRS: list[tuple[str, str, str]] = [
    ("USD", "美元", "USDCNY"),
    ("HKD", "港币", "HKDCNY"),
]


def _col(df, name: str) -> list:
    """取一列并清成 JSON 能装的东西：NaN / NaT 一律 None。"""
    out = []
    for v in df[name].tolist():
        if v is None:
            out.append(None)
            continue
        try:
            f = float(v)
        except (TypeError, ValueError):
            out.append(None)
            continue
        out.append(None if f != f else round(f, 4))  # f != f 是 NaN 的判据
    return out


def fetch_hk(symbol: str) -> tuple[list[str], dict]:
    df = ak.stock_hk_daily(symbol=symbol, adjust="qfq")
    df = df.dropna(subset=["close"])
    return [str(d)[:10] for d in df["date"].tolist()], {
        "open": _col(df, "open"),
        "close": _col(df, "close"),
        "high": _col(df, "high"),
        "low": _col(df, "low"),
        "volume": _col(df, "volume"),
    }


def fetch_us(symbol: str) -> tuple[list[str], dict]:
    df = ak.stock_us_daily(symbol=symbol, adjust="qfq")
    df = df.dropna(subset=["close"])
    return [str(d)[:10] for d in df["date"].tolist()], {
        "open": _col(df, "open"),
        "close": _col(df, "close"),
        "high": _col(df, "high"),
        "low": _col(df, "low"),
        "volume": _col(df, "volume"),
    }


def write_json(path: str, payload: dict) -> None:
    """先写 .tmp 再 replace —— 抓一半断掉不会留下一个半截的缓存。"""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def in_window(dates: list[str], start: str, end: str) -> list[int]:
    return [i for i, d in enumerate(dates) if start <= d <= end]


def fetch_one(market: str, symbol: str, name: str, start: str, end: str, fresh: bool) -> str:
    code = f"{symbol}.{market}"
    path = os.path.join(CACHE_DIR, f"{code}.json")
    if not fresh and os.path.exists(path):
        return f"  · {name} {code}：已有缓存，跳过"

    fn = fetch_hk if market == "HK" else fetch_us
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            dates, cols = fn(symbol)
            keep = in_window(dates, start, end)
            if not keep:
                return f"  · {name} {code}：窗口内没有数据"
            payload = {
                "code": code,
                "name": name,
                # market / currency 是给 build-history-shards.ts 读的。
                # A 股的缓存里没有这两个字段 —— 那边按 CN / CNY 兜底，见切分脚本。
                "market": market,
                "currency": "HKD" if market == "HK" else "USD",
                "dates": [dates[i] for i in keep],
                **{k: [v[i] for i in keep] for k, v in cols.items()},
            }
            write_json(path, payload)
            return f"  · {name} {code}：{len(keep)} 根 {payload['dates'][0]} → {payload['dates'][-1]}"
        except Exception as e:  # noqa: BLE001
            last_err = e
            if attempt < 2:
                time.sleep(1.5 * (2**attempt))
    return f"  · {name} {code}：失败 {str(last_err)[:90]}"


def fetch_fx(name_cn: str, pair: str, start: str, end: str, fresh: bool) -> str:
    path = os.path.join(FX_DIR, f"{pair}.json")
    if not fresh and os.path.exists(path):
        return f"  · {pair}：已有缓存，跳过"
    try:
        # 这个接口收的是 YYYYMMDD，不是 YYYY-MM-DD：它内部按 start_date[:4] / [4:6]
        # / [6:] 切三段再拼日期。传带横杠的进去会被切成 "2016--0-1-01"，
        # 接口不报错，只安静地回一个空表 —— 排查这个花了不少时间，记在这里。
        df = ak.currency_boc_sina(
            symbol=name_cn,
            start_date=start.replace("-", ""),
            end_date=end.replace("-", ""),
        )
    except Exception as e:  # noqa: BLE001
        return f"  · {pair}：失败 {str(e)[:90]}"

    # 这个接口给的是「100 外币兑人民币」，要除以 100 才是 1 外币的价格。
    # 列名里「中行折算价」是唯一一直有值的（央行中间价那几列常常是 NaN），
    # 而且折算价就是记账口径 —— 用它。
    rate_col = None
    for c in df.columns:
        if "折算价" in str(c):
            rate_col = c
            break
    if rate_col is None:
        return f"  · {pair}：接口没有「折算价」列，实际列 {list(df.columns)}"

    dates: list[str] = []
    rate: list = []
    for _, row in df.iterrows():
        v = row[rate_col]
        try:
            f = float(v) / 100.0
        except (TypeError, ValueError):
            continue
        if f != f or f <= 0:  # NaN / 缺值
            continue
        d = str(row[df.columns[0]])[:10]
        if not (start <= d <= end):
            continue
        dates.append(d)
        rate.append(round(f, 6))

    if not dates:
        return f"  · {pair}：窗口内没有有效汇率"
    write_json(path, {"code": pair, "name": f"{name_cn}兑人民币", "dates": dates, "rate": rate})
    return f"  · {pair}：{len(dates)} 天 {dates[0]} → {dates[-1]}（{rate[0]} → {rate[-1]}）"


def main() -> int:
    ap = argparse.ArgumentParser(description="抓港股 / 美股日线与人民币汇率")
    ap.add_argument("--from", dest="start", default=DEFAULT_FROM, help=f"起始日期，默认 {DEFAULT_FROM}")
    ap.add_argument("--to", dest="end", default=DEFAULT_TO, help=f"结束日期，默认 {DEFAULT_TO}")
    ap.add_argument("--only", choices=["HK", "US", "FX"], help="只抓其中一类")
    ap.add_argument("--limit", type=int, default=0, help="每个市场只抓前 N 只（试跑用）")
    ap.add_argument("--workers", type=int, default=4, help="并发数，默认 4")
    ap.add_argument("--fresh", action="store_true", help="忽略缓存，全部重抓")
    args = ap.parse_args()

    os.makedirs(CACHE_DIR, exist_ok=True)
    os.makedirs(FX_DIR, exist_ok=True)
    print(f"缓存目录 {CACHE_DIR}")
    print(f"汇率目录 {FX_DIR}")
    print(f"窗口 {args.start} → {args.end}\n")

    tasks: list[tuple[str, str, str]] = []
    if args.only in (None, "HK"):
        pool = HK_POOL[: args.limit] if args.limit else HK_POOL
        tasks += [("HK", s, n) for s, n in pool]
    if args.only in (None, "US"):
        pool = US_POOL[: args.limit] if args.limit else US_POOL
        tasks += [("US", s, n) for s, n in pool]

    ok = 0
    if tasks:
        print(f"股票：{len(tasks)} 只")
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            futures = {
                pool.submit(fetch_one, m, s, n, args.start, args.end, args.fresh): (m, s, n)
                for m, s, n in tasks
            }
            for i, fut in enumerate(as_completed(futures), 1):
                line = fut.result()
                if "失败" not in line and "没有数据" not in line:
                    ok += 1
                print(f"[{i}/{len(tasks)}]{line}")

    if args.only in (None, "FX"):
        print("\n汇率：")
        for _ccy, name_cn, pair in FX_PAIRS:
            print(fetch_fx(name_cn, pair, args.start, args.end, args.fresh))

    failed = len(tasks) - ok
    print(f"\n完成：{ok}/{len(tasks)} 只股票")
    if tasks and failed / len(tasks) > 0.05:
        print("失败率超过 5%，返回非零。源不通的时候不要把半份数据当成完整数据。", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
