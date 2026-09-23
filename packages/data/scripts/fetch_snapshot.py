#!/usr/bin/env python3
"""生成演示行情快照：申万一级行业 + 代表成分股 + 宽基指数 + 主流 ETF。

数据来源：
- 申万一级行业列表/成分股/行业指数日线：akshare（申万官网口径）
- 个股、指数、ETF 日线：腾讯行情（qfq 前复权）
- 市值：东方财富行情列表接口（push2.eastmoney.com/api/qt/clist/get）
  用于按行业选取代表股；不可用时退化为按申万权重排序

用法：
    python3 packages/data/scripts/fetch_snapshot.py [--limit N] [--fresh] [--no-marketcap]
"""

import argparse
import json
import os
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import requests

# 脚本位于 <root>/packages/data/scripts/，需上溯 4 层到仓库根。
# 用 marker 文件做断言：将来若再挪动目录，这里会立刻报错而不是把数据写错地方。
ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
if not os.path.exists(os.path.join(ROOT, "package.json")):
    raise RuntimeError(f"ROOT 计算错误：{ROOT} 下没有 package.json，脚本位置被移动过？")
CACHE_DIR = os.path.join(ROOT, "data", "cache")
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/"}
DAYS = 130  # 默认多取 10 天以便对齐后裁剪到 120；可用 --days 覆盖
MAX_DAYS = 650  # 腾讯日线接口实测上限 641 根，留一点余量

# 东方财富行情列表：沪深A股全市场（沪主板+科创板 / 深主板+创业板）
EASTMONEY_CLIST_URL = "https://push2.eastmoney.com/api/qt/clist/get"
EASTMONEY_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23"
EASTMONEY_UT = "bd1d9ddb04089700cf9c27f6f7426281"
EASTMONEY_FIELDS = "f12,f13,f14,f20,f21,f100"
EASTMONEY_PAGE_SIZE = 100
EASTMONEY_MAX_PAGES = 200  # 安全上限，防止接口异常时翻页死循环

INDEXES = [
    ("sh000300", "000300.SH", "沪深300"),
    ("sh000001", "000001.SH", "上证指数"),
    ("sz399006", "399006.SZ", "创业板指"),
]

ETFS = [
    ("sh510300", "510300.SH", "沪深300ETF"),
    ("sh510500", "510500.SH", "中证500ETF"),
    ("sz159915", "159915.SZ", "创业板ETF"),
    ("sh512100", "512100.SH", "中证1000ETF"),
    ("sh588000", "588000.SH", "科创50ETF"),
]

TOP_N = 20


def warn(msg):
    print("[warn]", msg, file=sys.stderr)


def fetch_tencent(symbol, datalen=DAYS, qfq=True):
    """返回 [{date, open, close, high, low, volume}, ...] 从旧到新。"""
    kind = "qfq" if qfq else ""
    url = (
        "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
        f"?param={symbol},day,,,{datalen},{kind}"
    )
    last_err = None
    for attempt in range(5):
        try:
            r = requests.get(url, headers=HEADERS, timeout=15)
            # 501 / 429 是腾讯的限流信号（实测并发拉 600+ 标的时必现）。
            # 必须用指数退避 + 随机抖动等待，否则重试只是把限流撞得更狠。
            if r.status_code in (429, 501, 502, 503):
                wait = min(60, 2 ** attempt) + random.uniform(0, 1.5)
                time.sleep(wait)
                last_err = RuntimeError(f"HTTP {r.status_code}（限流，已等待 {wait:.1f}s）")
                continue
            r.raise_for_status()
            data = r.json().get("data", {}).get(symbol, {})
            rows = data.get("qfqday") or data.get("day")
            if not rows:
                raise ValueError(f"{symbol}: empty kline")
            out = []
            for row in rows:
                out.append(
                    {
                        "date": row[0],
                        "open": float(row[1]),
                        "close": float(row[2]),
                        "high": float(row[3]),
                        "low": float(row[4]),
                        "volume": float(row[5]),
                    }
                )
            return out
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(min(30, 1.5 ** attempt) + random.uniform(0, 1.0))
    raise RuntimeError(f"{symbol}: {last_err}")


def eastmoney_page(pn, page_size=EASTMONEY_PAGE_SIZE, attempts=4):
    """取东财行情列表第 pn 页（1-based），返回响应中的 data 字段。"""
    params = {
        "pn": pn,
        "pz": page_size,
        "po": 1,
        "np": 1,
        "fltt": 2,
        "invt": 2,
        "fid": "f20",
        "fs": EASTMONEY_FS,
        "fields": EASTMONEY_FIELDS,
        "ut": EASTMONEY_UT,
    }
    last_err = None
    for attempt in range(attempts):
        try:
            r = requests.get(
                EASTMONEY_CLIST_URL, params=params, headers=HEADERS, timeout=20
            )
            r.raise_for_status()
            payload = r.json()
            if payload.get("rc") != 0:
                raise ValueError(f"rc={payload.get('rc')}")
            data = payload.get("data")
            if data is None:
                raise ValueError("empty data")
            return data
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(0.6 * (attempt + 1))
    raise RuntimeError(f"eastmoney clist pn={pn}: {last_err}")


def fetch_marketcap_eastmoney():
    """翻页拉取全市场总市值，返回 {带后缀代码: 总市值(万元)}。

    东财 f20（总市值）单位为元；原 Tushare daily_basic 的 total_mv 单位为万元，
    这里统一除以 1e4，保持与旧实现完全相同的量纲（下游仅用于排序与判空）。
    """
    page_size = EASTMONEY_PAGE_SIZE
    mv = {}
    total = None
    pn = 1
    while pn <= EASTMONEY_MAX_PAGES:
        data = eastmoney_page(pn, page_size=page_size)
        diff = data.get("diff") or []
        if isinstance(diff, dict):  # 少数情况下接口返回 {"0": {...}, "1": {...}}
            diff = [diff[k] for k in sorted(diff, key=lambda x: int(x))]
        if not diff:
            break
        if total is None:
            total = int(data.get("total") or 0)
        for row in diff:
            code = str(row.get("f12") or "").strip()
            try:
                market = int(row.get("f13"))
            except (TypeError, ValueError):
                continue
            if not code or market not in (0, 1):
                continue
            try:
                mv_yuan = float(row.get("f20"))
            except (TypeError, ValueError):
                continue
            mv[f"{code}.{'SH' if market == 1 else 'SZ'}"] = mv_yuan / 1e4
        if total and (len(mv) >= total or pn * page_size >= total):
            break
        pn += 1
    return mv


def cache_path(symbol, qfq, days=DAYS):
    return os.path.join(CACHE_DIR, f"{symbol}_{'qfq' if qfq else 'raw'}_{days}.json")


def fetch_tencent_cached(symbol, qfq=True, fresh=False, days=DAYS):
    path = cache_path(symbol, qfq, days)
    if not fresh and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    data = fetch_tencent(symbol, qfq=qfq, datalen=days)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    return data


def symbol_for(code):
    """6 位代码转腾讯 symbol。"""
    if code.startswith(("6", "9", "5")):
        return "sh" + code
    return "sz" + code


def ts_code_for(code):
    if code.startswith(("6", "9", "5")):
        return code + ".SH"
    return code + ".SZ"


def align(rows, calendar):
    by_date = {r["date"]: r for r in rows}
    out = {k: [] for k in ("close", "high", "low", "volume")}
    for d in calendar:
        r = by_date.get(d)
        if r is None:
            for k in out:
                out[k].append(None)
        else:
            out["close"].append(r["close"])
            out["high"].append(r["high"])
            out["low"].append(r["low"])
            out["volume"].append(r["volume"])
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=TOP_N, help="每行业代表股数量")
    parser.add_argument(
        "--days",
        type=int,
        default=DAYS,
        help=f"取多少个交易日的历史（默认 {DAYS}，实测上限约 {MAX_DAYS}）。"
        "拉长历史主要用于回测（scripts/backtest.ts），代价是快照体积成比例增长",
    )
    parser.add_argument("--fresh", action="store_true", help="忽略缓存重新拉取")
    parser.add_argument(
        "--no-marketcap",
        dest="no_marketcap",
        action="store_true",
        help="不使用东方财富市值（退化为按申万权重排序）",
    )
    # 废弃别名：老工作流里的 --no-tushare 仍然可用，但不再出现在帮助里
    parser.add_argument(
        "--no-tushare",
        dest="no_marketcap",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    args = parser.parse_args()
    if "--no-tushare" in sys.argv:
        warn("--no-tushare 已废弃，请改用 --no-marketcap（行为完全一致）")

    import warnings

    warnings.filterwarnings("ignore")
    import akshare as ak

    print("1/5 拉取沪深300 获取公共交易日历...")
    hs300 = fetch_tencent_cached("sh000300", qfq=False, fresh=args.fresh, days=args.days)
    calendar = [r["date"] for r in hs300]
    as_of = calendar[-1]
    # 保留 10 天余量用于对齐后裁剪（原设计：取 130 天、输出 120 天）。
    # 注意这里必须跟随 --days，否则拉长历史不会生效——之前就踩过这个坑。
    target_days = max(60, args.days - 10)
    calendar = calendar[-target_days:]
    print(f"    asOf={as_of} days={len(calendar)}（取数 {args.days} 天，裁剪余量 10 天）")

    print("2/5 拉取申万一级行业与成分股...")
    first_info = ak.sw_index_first_info()
    industries = []
    for _, row in first_info.iterrows():
        industries.append(
            {"code": row["行业代码"], "name": row["行业名称"], "members": []}
        )

    for ind in industries:
        code6 = ind["code"].replace(".SI", "")
        try:
            comp = ak.index_component_sw(symbol=code6)
        except Exception as e:  # noqa: BLE001
            warn(f"{ind['name']} 成分股拉取失败: {e}")
            continue
        ind["members"] = [
            {
                "code": str(r["证券代码"]),
                "name": str(r["证券名称"]),
                "weight": float(r["最新权重"]) if r["最新权重"] is not None else 0.0,
            }
            for _, r in comp.iterrows()
        ]
        ind["members"].sort(key=lambda m: m["weight"], reverse=True)
        ind["members"] = ind["members"][: args.limit]
    print(f"    共 {len(industries)} 个行业，代表股 "
          f"{sum(len(i['members']) for i in industries)} 只")

    print("3/5 拉取市值并按行业取代表股...")
    mv = {}
    if not args.no_marketcap:
        try:
            mv = fetch_marketcap_eastmoney()
        except Exception as e:  # noqa: BLE001
            warn(f"东方财富市值不可用，退化为权重排序: {e}")
        if mv:
            print(f"    东财市值 {len(mv)} 条")
        else:
            warn("东方财富市值返回为空，退化为权重排序")
    for ind in industries:
        for m in ind["members"]:
            ts_code = ts_code_for(m["code"])
            m["total_mv"] = mv.get(ts_code)
        has_mv = [m for m in ind["members"] if m["total_mv"]]
        if has_mv and len(has_mv) >= 5:
            ind["members"].sort(key=lambda m: (m["total_mv"] or 0), reverse=True)
        ind["members"] = ind["members"][: args.limit]

    print("4/5 拉取个股/指数/ETF 日线（并发）...")
    tasks = []
    stock_meta = {}
    for ind in industries:
        for m in ind["members"]:
            sym = symbol_for(m["code"])
            tasks.append((sym, m["code"], True))
            stock_meta[m["code"]] = {
                "name": m["name"],
                "industry": ind["name"],
                "industryCode": ind["code"],
                "weight": m["weight"],
            }
    for sym, code, name in INDEXES:
        tasks.append((sym, code, False))
    for sym, code, name in ETFS:
        tasks.append((sym, code, True))

    results = {}
    failures = []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
        futs = {
            ex.submit(fetch_tencent_cached, sym, qfq, args.fresh, args.days): sym
            for sym, _, qfq in tasks
        }
        done = 0
        for fut in as_completed(futs):
            sym = futs[fut]
            done += 1
            try:
                results[sym] = fut.result()
            except Exception as e:  # noqa: BLE001
                failures.append((sym, str(e)))
            if done % 100 == 0:
                print(f"    {done}/{len(tasks)}")
    if failures:
        warn(f"{len(failures)} 个标的失败: {failures[:5]}")
    # 失败率过高时必须让任务失败，而不是产出一份"看起来成功"的残缺快照。
    # 之前就是这样静默产出了 9 个空板块、缺 2 个指数的坏数据。
    fail_rate = len(failures) / max(1, len(tasks))
    if fail_rate > 0.05:
        raise SystemExit(
            f"取数失败率 {fail_rate:.1%}（{len(failures)}/{len(tasks)}）过高，拒绝产出残缺快照。\n"
            f"  多半是被行情接口限流（HTTP 501）。建议：\n"
            f"    1) 等 10-30 分钟再重试；\n"
            f"    2) 降低并发：--workers 2；\n"
            f"    3) 已有 {len(results)} 个标的命中缓存，重跑不会重复取。"
        )

    print("5/5 对齐、裁剪并写出快照...")
    indices = []
    for sym, code, name in INDEXES:
        rows = results.get(sym)
        if not rows:
            warn(f"指数 {code} 缺失，跳过")
            continue
        series = align(rows, calendar)
        indices.append(
            {"code": code, "name": name, "kind": "index", **series}
        )

    etfs = []
    for sym, code, name in ETFS:
        rows = results.get(sym)
        if not rows:
            warn(f"ETF {code} 缺失，跳过")
            continue
        series = align(rows, calendar)
        etfs.append({"code": code, "name": name, "kind": "etf", **series})

    sectors = []
    for ind in industries:
        code6 = ind["code"].replace(".SI", "")
        try:
            hist = ak.index_hist_sw(symbol=code6, period="day")
            hist["日期"] = hist["日期"].astype(str)
            hist = hist[hist["日期"] <= as_of].tail(len(calendar))
            by_date = {str(r["日期"]): r for _, r in hist.iterrows()}
            close, high, low, volume = [], [], [], []
            for d in calendar:
                r = by_date.get(d)
                if r is None:
                    close.append(None)
                    high.append(None)
                    low.append(None)
                    volume.append(None)
                else:
                    close.append(float(r["收盘"]))
                    high.append(float(r["最高"]))
                    low.append(float(r["最低"]))
                    volume.append(float(r["成交量"]))
            sectors.append(
                {
                    "code": ind["code"],
                    "name": ind["name"],
                    "close": close,
                    "high": high,
                    "low": low,
                    "volume": volume,
                    "members": [ts_code_for(m["code"]) for m in ind["members"]],
                }
            )
        except Exception as e:  # noqa: BLE001
            warn(f"行业指数 {ind['name']} 拉取失败: {e}")

    stocks = []
    dropped = 0
    for ind in industries:
        for m in ind["members"]:
            sym = symbol_for(m["code"])
            rows = results.get(sym)
            if not rows:
                dropped += 1
                continue
            series = align(rows, calendar)
            valid = sum(1 for v in series["close"] if v is not None)
            if valid < 60:
                dropped += 1
                continue
            meta = stock_meta[m["code"]]
            stocks.append(
                {
                    "code": ts_code_for(m["code"]),
                    "name": meta["name"],
                    "industry": meta["industry"],
                    "industryCode": meta["industryCode"],
                    "weight": meta["weight"],
                    "isST": "ST" in meta["name"].upper(),
                    **series,
                }
            )
    print(f"    股票 {len(stocks)} 只，跳过 {dropped} 只")

    stock_codes = {s["code"] for s in stocks}
    for s in sectors:
        before = len(s["members"])
        s["members"] = [c for c in s["members"] if c in stock_codes]
        if len(s["members"]) != before:
            warn(f"板块 {s['name']} 成员裁剪 {before} -> {len(s['members'])}")

    out_dir = os.path.join(ROOT, "data", f"snapshot_{as_of.replace('-', '')}")
    os.makedirs(out_dir, exist_ok=True)
    meta = {
        "asOf": as_of,
        "source": "申万官网(akshare) + 腾讯行情 + 东方财富市值(可用时)",
        "poolNote": f"演示股票池：申万一级行业按市值/权重前 {args.limit} 只代表股",
        "calendarNote": "以沪深300交易日为公共日历",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "days": len(calendar),
    }
    for name, obj in [
        ("meta.json", meta),
        ("calendar.json", calendar),
        ("indices.json", indices),
        ("sectors.json", sectors),
        ("stocks.json", stocks),
        ("etfs.json", etfs),
    ]:
        with open(os.path.join(out_dir, name), "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    print(f"完成：{out_dir}")


if __name__ == "__main__":
    main()
