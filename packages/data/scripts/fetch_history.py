#!/usr/bin/env python3
"""抓「历史推演」用的深历史日线（传奇模式 10 个关卡要回到 2016–2024）。

为什么不能复用 fetch_snapshot.py：
- 快照走腾讯日线，**实测上限 641 根**，只够回看两年半，够不到 2016–2024 的关卡；
- 快照是「今天的一份切片」，而关卡要的是「那一年那一天的那一段」。

所以这里换新浪源（akshare `stock_zh_a_daily`），实测能一路回到 2001 年。
每只股票抓**一整段 2016-01-01 → 2025-03-31**（约 2244 根，单只 4~5 秒），
按股票缓存成一个个小文件；关卡要从这段里切哪一块，由 build_history_shards.mjs 决定。
这样 10 个关卡共用一份数据，不用为每个关卡重复抓。

**一个必须说清楚的取舍：用的是前复权（qfq）价。**
前复权用的是「今天的」复权因子，所以 2016 年的绝对价位会和当时盘面上看到的不一样
（价格被后来的分红除权压低了）。好处是收益连续、不会凭空出现除权缺口被当成暴跌；
代价是「老玩家会觉得价格不对」。对模拟盘的记账来说前者重要得多，所以选 qfq，
并且在页面上明说。

用法：
    python3 packages/data/scripts/fetch_history.py                 # 增量，已有缓存就跳过
    python3 packages/data/scripts/fetch_history.py --limit 20      # 先试 20 只
    python3 packages/data/scripts/fetch_history.py --workers 6
    python3 packages/data/scripts/fetch_history.py --fresh         # 忽略缓存重抓
"""

import argparse
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

# 脚本位于 <root>/packages/data/scripts/，需上溯 4 层到仓库根。
# 用 marker 文件做断言：将来若再挪动目录，这里会立刻报错而不是把数据写错地方。
ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
if not os.path.exists(os.path.join(ROOT, "package.json")):
    raise RuntimeError(f"ROOT 计算错误：{ROOT} 下没有 package.json，脚本位置被移动过？")

SNAPSHOT_ROOT = os.path.join(ROOT, "data")
CACHE_DIR = os.path.join(ROOT, "data", "history-cache")

DEFAULT_FROM = "2016-01-01"
DEFAULT_TO = "2025-03-31"

# 新浪的市场前缀
EXCHANGE_PREFIX = {"SH": "sh", "SZ": "sz"}

_print_lock = threading.Lock()


def log(msg: str) -> None:
    with _print_lock:
        print(msg, flush=True)


def sina_symbol(code: str):
    """600519.SH → sh600519。北交所在新浪这个接口上没有，返回 None。"""
    parts = code.split(".")
    if len(parts) != 2:
        return None
    num, ex = parts
    prefix = EXCHANGE_PREFIX.get(ex.upper())
    if prefix is None:
        return None
    return f"{prefix}{num}"


def latest_snapshot_dir() -> str:
    """data/ 下最新的 snapshot_YYYYMMDD。"""
    names = [
        n
        for n in os.listdir(SNAPSHOT_ROOT)
        if n.startswith("snapshot_") and len(n) == len("snapshot_20000101") and n[9:].isdigit()
    ]
    if not names:
        raise RuntimeError(f"{SNAPSHOT_ROOT} 下没有 snapshot_YYYYMMDD 目录，先跑 fetch_snapshot.py")
    return os.path.join(SNAPSHOT_ROOT, sorted(names)[-1])


def load_universe(snapshot_dir: str):
    with open(os.path.join(snapshot_dir, "stocks.json"), encoding="utf-8") as f:
        stocks = json.load(f)
    return [(s["code"], s["name"]) for s in stocks]


def fetch_one(code: str, name: str, start: str, end: str, retries: int = 3):
    """返回 (code, payload) 或抛异常。payload 的键都是与 dates 等长的数组。"""
    import akshare as ak

    sym = sina_symbol(code)
    if sym is None:
        raise ValueError(f"新浪接口不支持这个市场：{code}")

    last_err = None
    for attempt in range(retries):
        try:
            df = ak.stock_zh_a_daily(
                symbol=sym,
                start_date=start.replace("-", ""),
                end_date=end.replace("-", ""),
                adjust="qfq",
            )
            if df is None or len(df) == 0:
                raise ValueError("返回空数据（可能是当时还没上市）")

            def col(key):
                if key not in df.columns:
                    return [None] * len(df)
                out = []
                for v in df[key].tolist():
                    try:
                        fv = float(v)
                    except (TypeError, ValueError):
                        out.append(None)
                        continue
                    # NaN != NaN
                    out.append(None if fv != fv else fv)
                return out

            payload = {
                "code": code,
                "name": name,
                "dates": [str(d)[:10] for d in df["date"].tolist()],
                "open": col("open"),
                "close": col("close"),
                "high": col("high"),
                "low": col("low"),
                "volume": col("volume"),
            }
            return code, payload
        except Exception as e:  # noqa: BLE001 — 网络类异常一律重试
            last_err = e
            if attempt < retries - 1:
                time.sleep(1.5 * (2**attempt))
    raise last_err if last_err else RuntimeError("未知失败")


# 基准指数：关卡结算要跟沪深300比。它们不在股票池里，所以单独抓。
INDEXES = [
    ("sh000300", "000300.SH", "沪深300"),
    ("sh000001", "000001.SH", "上证指数"),
    ("sz399006", "399006.SZ", "创业板指"),
]


def fetch_index(code: str, name: str, start: str, end: str, retries: int = 3):
    import akshare as ak

    sym = sina_symbol(code)
    if sym is None:
        raise ValueError(f"{code} 在新浪这个接口上没有对应符号（北交所不支持）")
    last_err = None
    for attempt in range(retries):
        try:
            df = ak.stock_zh_index_daily(symbol=sym)
            if df is None or len(df) == 0:
                raise ValueError("返回空数据")
            if "date" not in df.columns:
                raise ValueError(f"返回的表里没有 date 列（列：{list(df.columns)[:6]}）")
            keep = [r for r in df.to_dict("records") if start <= str(r["date"])[:10] <= end]
            if not keep:
                raise ValueError(f"区间 {start}→{end} 内没有数据")

            def col(key):
                out = []
                for r in keep:
                    try:
                        fv = float(r[key])
                    except (TypeError, ValueError, KeyError):
                        out.append(None)
                        continue
                    out.append(None if fv != fv else fv)
                return out

            return (
                code,
                {
                    "code": code,
                    "name": name,
                    "dates": [str(r["date"])[:10] for r in keep],
                    # 指数没有开盘/成交量这一说（新浪这个接口只给 OHLC），
                    # open 用当日开盘点位；volume 置空，历史推演不读它。
                    "open": col("open"),
                    "close": col("close"),
                    "high": col("high"),
                    "low": col("low"),
                    "volume": [None] * len(keep),
                },
            )
        except Exception as e:  # noqa: BLE001
            last_err = e
            if attempt < retries - 1:
                time.sleep(1.5 * (2**attempt))
    raise last_err if last_err else RuntimeError("未知失败")


def fetch_indices(start: str, end: str, fresh: bool) -> None:
    print("\n基准指数：")
    for _sym, code, label in INDEXES:
        path = os.path.join(CACHE_DIR, f"{code}.json")
        if not fresh and os.path.exists(path):
            print(f"  · {label} {code}：已有缓存，跳过")
            continue
        try:
            _, payload = fetch_index(code, label, start, end)
        except Exception as e:  # noqa: BLE001
            print(f"  · {label} {code}：失败 {str(e)[:80]}")
            continue
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)
        print(f"  · {label} {code}：{len(payload['dates'])} 根 {payload['dates'][0]} → {payload['dates'][-1]}")


def main() -> int:
    ap = argparse.ArgumentParser(description="抓历史推演用的深历史日线（新浪源，前复权）")
    ap.add_argument("--snapshot", help="快照目录，默认取 data/ 下最新的一份")
    ap.add_argument("--from", dest="start", default=DEFAULT_FROM, help=f"起始日期，默认 {DEFAULT_FROM}")
    ap.add_argument("--to", dest="end", default=DEFAULT_TO, help=f"结束日期，默认 {DEFAULT_TO}")
    ap.add_argument("--workers", type=int, default=4, help="并发数，默认 4（并发太高会被限流）")
    ap.add_argument("--limit", type=int, default=0, help="只抓前 N 只，用于试跑")
    ap.add_argument("--fresh", action="store_true", help="忽略已有缓存，重抓")
    ap.add_argument("--indices-only", action="store_true", help="只抓三个基准指数，不碰股票")
    args = ap.parse_args()

    snapshot_dir = args.snapshot or latest_snapshot_dir()
    universe = load_universe(snapshot_dir)
    if args.limit:
        universe = universe[: args.limit]

    os.makedirs(CACHE_DIR, exist_ok=True)
    print(f"快照 {os.path.basename(snapshot_dir)}：{len(universe)} 只  区间 {args.start} → {args.end}")
    print(f"缓存目录 {CACHE_DIR}")

    # 只想补指数时不必再走一遍 600 多只股票的循环
    if args.indices_only:
        fetch_indices(args.start, args.end, args.fresh)
        return 0

    todo = []
    skipped = 0
    for code, name in universe:
        path = os.path.join(CACHE_DIR, f"{code}.json")
        if not args.fresh and os.path.exists(path):
            skipped += 1
            continue
        todo.append((code, name))

    print(f"已有缓存跳过 {skipped} 只，需抓取 {len(todo)} 只\n")
    if not todo:
        print("股票都齐了。")
        fetch_indices(args.start, args.end, args.fresh)
        return 0

    ok = 0
    failed = []
    empty = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
        futures = {
            ex.submit(fetch_one, code, name, args.start, args.end): (code, name)
            for code, name in todo
        }
        for i, fut in enumerate(as_completed(futures), start=1):
            code, name = futures[fut]
            try:
                _, payload = fut.result()
            except Exception as e:  # noqa: BLE001
                msg = str(e)[:80]
                # 「还没上市」不是故障，记下来但不算失败
                if "空数据" in msg or "不支持这个市场" in msg:
                    empty.append((code, name, msg))
                else:
                    failed.append((code, name, msg))
                continue
            path = os.path.join(CACHE_DIR, f"{code}.json")
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
            os.replace(tmp, path)
            ok += 1
            if i % 25 == 0 or i == len(todo):
                el = time.time() - t0
                rate = i / el if el > 0 else 0
                eta = (len(todo) - i) / rate if rate > 0 else 0
                log(f"  [{i}/{len(todo)}] ok={ok} 失败={len(failed)} 已用 {el/60:.1f}min 预计还要 {eta/60:.1f}min")

    el = time.time() - t0
    print(f"\n完成：成功 {ok}，无数据 {len(empty)}，失败 {len(failed)}，用时 {el/60:.1f} 分钟")
    if empty:
        print(f"无数据（还没上市 / 市场不支持），前 10 条：")
        for code, name, msg in empty[:10]:
            print(f"  · {code} {name}：{msg}")
    if failed:
        print(f"失败前 10 条：")
        for code, name, msg in failed[:10]:
            print(f"  · {code} {name}：{msg}")

    # 失败率过高说明是接口/网络出问题，而不是个别股票没数据 —— 明确报错退出，
    # 免得静悄悄产出一份缺胳膊少腿的缓存（fetch_snapshot.py 上踩过这个坑）。
    fetch_indices(args.start, args.end, args.fresh)

    attempted = ok + len(failed)
    if attempted > 0 and len(failed) / attempted > 0.05:
        print(f"\n[error] 失败率 {len(failed)/attempted:.1%} 超过 5%，中止。先查网络或降低 --workers 再重跑。")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
