#!/usr/bin/env python3
"""生成演示行情快照：申万一级行业 + 代表成分股 + 宽基指数 + 主流 ETF。

数据来源：
- 申万一级行业列表/成分股/行业指数日线：akshare（申万官网口径）
- 个股、指数、ETF 日线：腾讯行情（qfq 前复权）
- 市值：Tushare daily_basic（用于按行业选取代表股）

用法：
    python3 data/scripts/fetch_snapshot.py [--limit N] [--fresh]
"""

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CACHE_DIR = os.path.join(ROOT, "data", "cache")
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/"}
DAYS = 130  # 多取 10 天以便对齐后裁剪到 120

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
    for attempt in range(4):
        try:
            r = requests.get(url, headers=HEADERS, timeout=15)
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
            time.sleep(0.6 * (attempt + 1))
    raise RuntimeError(f"{symbol}: {last_err}")


def cache_path(symbol, qfq):
    return os.path.join(CACHE_DIR, f"{symbol}_{'qfq' if qfq else 'raw'}.json")


def fetch_tencent_cached(symbol, qfq=True, fresh=False):
    path = cache_path(symbol, qfq)
    if not fresh and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    data = fetch_tencent(symbol, qfq=qfq)
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
    parser.add_argument("--fresh", action="store_true", help="忽略缓存重新拉取")
    parser.add_argument("--no-tushare", action="store_true", help="不使用 Tushare 市值")
    args = parser.parse_args()

    import warnings

    warnings.filterwarnings("ignore")
    import akshare as ak

    print("1/5 拉取沪深300 获取公共交易日历...")
    hs300 = fetch_tencent_cached("sh000300", qfq=False, fresh=args.fresh)
    calendar = [r["date"] for r in hs300]
    as_of = calendar[-1]
    calendar = calendar[-120:]
    print(f"    asOf={as_of} days={len(calendar)}")

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
    if not args.no_tushare:
        try:
            import os

            import tushare as ts

            token = os.environ.get("TUSHARE_TOKEN", "")
            if token:
                pro = ts.pro_api(token)
                df = pro.daily_basic(
                    trade_date=as_of.replace("-", ""),
                    fields="ts_code,total_mv",
                )
                mv = dict(zip(df["ts_code"], df["total_mv"]))
                print(f"    daily_basic {len(mv)} 条")
        except Exception as e:  # noqa: BLE001
            warn(f"Tushare daily_basic 不可用，退化为权重排序: {e}")
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
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {
            ex.submit(fetch_tencent_cached, sym, qfq, args.fresh): sym
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
        "source": "申万官网(akshare) + 腾讯行情 + Tushare daily_basic(可用时)",
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
