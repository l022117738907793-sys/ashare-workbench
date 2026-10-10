#!/usr/bin/env python3
"""生成演示行情快照：申万一级行业 + 代表成分股 + 宽基指数 + 主流 ETF + 港股 + 日韩股。

数据来源：
- 申万一级行业列表/成分股/行业指数日线：akshare（申万官网口径）
- 个股、指数、ETF 日线：腾讯行情（qfq 前复权）
- 港股日线：腾讯行情（`hk00700`）—— 腾讯对港股有完整历史
- 日股/韩股日线：Naver（腾讯的日线接口对日韩任何 datalen 都只回 1 根）
- 折算价（HKD/JPY/KRW → CNY）：中国银行折算价（akshare `currency_boc_sina`）
- 市值：东方财富行情列表接口（push2.eastmoney.com/api/qt/clist/get）
  用于按行业选取代表股；不可用时退化为按申万权重排序

用法：
    python3 packages/data/scripts/fetch_snapshot.py [--limit N] [--fresh] [--no-marketcap]
"""

import argparse
import ast
import json
import os
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

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

# 汇率序列取多少**自然日**。默认日历是 120 个交易日，换算成自然日约 170 天；
# 这里给到 260，多出来的余量用来兜住春节那种长假 —— 汇率是自然日报价，
# 多取一段不影响正确性，只多几十行 JSON。
FX_SERIES_DAYS = 260

# 限流重试：原来 5 次、最长等 16 秒，CI 上实测 22.3% 的标的仍会耗尽重试。
# 现在拉长到 8 次、最长等 48 秒，并且退避是全局的（见 note_throttle）。
THROTTLE_ATTEMPTS = 8
THROTTLE_MAX_WAIT = 48.0

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

# 港股标的池。固定名单，不按行业选——港股没有申万那样的行业分类，
# 而且这 20 只就是「历史推演」里用的那批，两处保持同一批标的，
# 玩家在推演里认识的港股，到实时盘里还是这些。
#
# 名单按成交活跃度挑的代表：互联网（腾讯/阿里/美团/小米/京东/网易/百度/快手）、
# 金融（建行/友邦/平安/港交所/汇丰）、运营商与能源（中移动/神华/中海油/中石化）、
# 制造与消费（比亚迪/安踏/海底捞）。
HK_UNIVERSE = [
    ("00700", "腾讯控股"),
    ("09988", "阿里巴巴-W"),
    ("03690", "美团-W"),
    ("01810", "小米集团-W"),
    ("09618", "京东集团-SW"),
    ("09999", "网易-S"),
    ("09888", "百度集团-SW"),
    ("01024", "快手-W"),
    ("00939", "建设银行"),
    ("01299", "友邦保险"),
    ("02318", "中国平安"),
    ("00941", "中国移动"),
    ("00388", "香港交易所"),
    ("00005", "汇丰控股"),
    ("01211", "比亚迪股份"),
    ("02020", "安踏体育"),
    ("01088", "中国神华"),
    ("00883", "中国海洋石油"),
    ("00386", "中国石化"),
    ("06862", "海底捞"),
]

# 恒生指数：港股的交易日历从它的日线日期反推。
# 不手写节假日表——港股一年四季的假期（佛诞、复活节、圣诞）跟 A 股不同，
# 手写一定会过期；指数哪天有 bar，哪天就是港股交易日，这是自维护的。
HK_CALENDAR_SYMBOL = "hkHSI"

# 日股标的池。与港股同理：固定名单，不按行业选（日股没有申万那样的分类），
# 挑的是日经 225 里成交活跃、中文名耳熟能详的 20 只。
# 中文名取自东方财富搜索接口（`searchapi.eastmoney.com/api/suggest/get`，
# 按 `MktNum == 176` 过滤），与行情页显示的名字一致。
JP_UNIVERSE = [
    ("7203", "丰田汽车"),
    ("6758", "索尼"),
    ("6861", "基恩士"),
    ("8306", "三菱日联金融"),
    ("9984", "软银集团"),
    ("9432", "日本电报电话"),
    ("8035", "Tokyo Electron"),
    ("6098", "瑞可利控股"),
    ("4063", "信越化学工业"),
    ("6501", "日立"),
    ("8058", "三菱商事"),
    ("8001", "伊藤忠商事"),
    ("4502", "武田制药"),
    ("4568", "第一三共"),
    ("6367", "大金工业"),
    ("7974", "任天堂"),
    ("4661", "东方乐园"),
    ("3382", "7&I控股"),
    ("6902", "日本电装"),
    ("7267", "本田汽车"),
]

# 韩股标的池。同上，取自东财搜索接口 `MktNum == 177`。
KR_UNIVERSE = [
    ("005930", "三星电子"),
    ("000660", "SK海力士"),
    ("373220", "LG Energy Solution"),
    ("207940", "三星生物制剂"),
    ("005380", "现代汽车"),
    ("000270", "Kia Corp"),
    ("068270", "赛尔群"),
    ("105560", "KB金融集团"),
    ("055550", "新韩金融集团"),
    ("005490", "项浦制铁"),
    ("051910", "LG化学"),
    ("006400", "三星SDI"),
    ("035420", "Naver Corp"),
    ("035720", "Kakao"),
    ("012330", "现代摩比斯"),
    ("028260", "三星物产"),
    ("066570", "LG电子"),
    ("003670", "POSCO Future M"),
    ("015760", "韩国电力公司"),
    ("032830", "三星生命"),
]

# 日韩的历史日线走 Naver —— **腾讯没有**。
# 腾讯的实时接口有日韩（`jp7203` / `kr005930`），但 `fqkline` / `kline` 对日韩
# 任何 datalen、任何区间都只返回 1 根。实测的可用源只有 Naver 这两个。
NAVER_JP_CHART = "https://api.stock.naver.com/chart/foreign/item/{code}.T/day"
NAVER_KR_SISE = "https://api.finance.naver.com/siseJson.naver"
NAVER_JP_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://m.stock.naver.com/"}
NAVER_KR_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://finance.naver.com/"}

# 日韩交易日历的锚点：同市场里不会停牌的大盘股。
# 日韩都没有像恒生指数那样好用的指数日线（Naver 的 foreign 接口对 KOSPI/N225
# 一律返回空数组），所以日历只能从个股反推。取这几只日线日期的**并集**而不是
# 交集 —— 交集会被任何一只临时停牌砍掉一整天。代价是「停牌」与「休市」分不出来，
# 但那两天给别的票补一根 null 只是空档，不影响任何计算。
JP_CALENDAR_ANCHORS = ["7203", "6758", "8306", "9432"]
KR_CALENDAR_ANCHORS = ["005930", "000660", "005380", "015760"]

TOP_N = 20


def warn(msg):
    print("[warn]", msg, file=sys.stderr)


# —— 全局限流闸门 ——————————————————————————————————————————————
# 501 不是「这一个请求太快」，而是腾讯对来源 IP 的**整体**惩罚：同一时刻在飞的
# 请求越多，它惩罚得越久。所以每个线程各自 sleep 是没用的 —— 其他线程会继续把
# 请求打上去，闸门永远关不上。实测 CI 上 4 线程拉 628 个标的失败 140 个（22.3%）。
#
# 正确的做法是**所有线程共用一条冷却时间线**：任何一次 501 都把冷却线往后推，
# 之后每个线程发请求前都要先等这条线过去。等于把并发从「4 个一直打」变成
# 「4 个排队，被罚就全体安静一会儿」。
_throttle_lock = threading.Lock()
_cooldown_until = 0.0


def note_throttle(seconds):
    """把全局冷却线推后，只延不缩。"""
    global _cooldown_until
    with _throttle_lock:
        target = time.monotonic() + seconds
        if target > _cooldown_until:
            _cooldown_until = target


def wait_for_throttle():
    """发请求前过闸门：所有线程共享，冷却期内一律等待。"""
    while True:
        with _throttle_lock:
            remaining = _cooldown_until - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(remaining, 1.0))


def fetch_tencent(symbol, datalen=DAYS, qfq=True):
    """返回 [{date, open, close, high, low, volume}, ...] 从旧到新。"""
    kind = "qfq" if qfq else ""
    url = (
        "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
        f"?param={symbol},day,,,{datalen},{kind}"
    )
    last_err = None
    for attempt in range(THROTTLE_ATTEMPTS):
        try:
            wait_for_throttle()
            r = requests.get(url, headers=HEADERS, timeout=15)
            # 501 / 429 是腾讯的限流信号（实测并发拉 600+ 标的时必现）。
            # 冷却线推后 + 自己也要立刻退避，否则刚被罚完的线程会马上再撞一次。
            if r.status_code in (429, 501, 502, 503):
                wait = min(THROTTLE_MAX_WAIT, 3 * 2 ** attempt) + random.uniform(0, 1.5)
                note_throttle(wait)
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


def eastmoney_page(pn, page_size=EASTMONEY_PAGE_SIZE, attempts=6):
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
            # 东财翻页偶发 502（CI 上实测第 4 页挂过），原来只等 0.6/1.2/1.8 秒太急。
            time.sleep(min(12.0, 0.8 * 2 ** attempt) + random.uniform(0, 0.5))
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


def _naver_get(url, headers, params, parse, attempts=4):
    """Naver 没有腾讯那种「整体惩罚」，所以退避是每请求独立的小退避。"""
    last = None
    for i in range(attempts):
        try:
            resp = requests.get(url, headers=headers, params=params, timeout=25)
            if resp.status_code != 200:
                raise RuntimeError(f"HTTP {resp.status_code}")
            return parse(resp.text)
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(min(20.0, 1.5 * 2**i) + random.uniform(0.0, 1.0))
    raise RuntimeError(str(last)[:120])


def _naver_range(days):
    """Naver 收的是自然日区间，而 days 是交易日 —— 多给一倍余量再裁。"""
    end = (datetime.now(timezone.utc) + timedelta(hours=9)).date()
    start = end - timedelta(days=int(days * 1.6) + 40)
    return start, end


def _parse_naver_kr(text):
    """
    `siseJson.naver` 的回包是 JS 数组字面量，**每一行前面都带缩进**（响应里有
    `\\n\\t\\t\\n` 这种排版空白）。`ast.literal_eval` 在 eval 模式下对表达式开头的
    空白不宽容，直接喂会报 `unexpected indent (<unknown>, line 2)` —— 所以先把
    每行的首尾空白剥掉再交给它。剥完就是干净的 `[[...],[...]]`。
    """
    dedented = "\n".join(line.strip() for line in text.splitlines() if line.strip())
    return ast.literal_eval(dedented)


def fetch_naver_jp(code, days=DAYS):
    """
    日股日线（丰田 `7203`、索尼 `6758`…），返回与 `fetch_tencent` 同形状的
    `[{date, open, close, high, low, volume}]`。

    返回的是**裸 JSON 数组**（不是 `{"chartData": [...]}` 那种包裹），每项形如
    `{'localDate': '20260925', 'closePrice': 2989.5, 'openPrice': 2990.0,
      'highPrice': 3003.0, 'lowPrice': 2979.0, 'accumulatedTradingVolume': 21084000}`。
    `localDate` 是 `YYYYMMDD` **无横杠**，要转成 `YYYY-MM-DD` 才能进 `align`。
    """
    start, end = _naver_range(days)
    payload = _naver_get(
        NAVER_JP_CHART.format(code=code),
        NAVER_JP_HEADERS,
        {
            "startDateTime": start.strftime("%Y%m%d") + "000000",
            "endDateTime": end.strftime("%Y%m%d") + "235959",
        },
        json.loads,
    )
    rows = []
    for it in payload if isinstance(payload, list) else []:
        d = str(it.get("localDate") or "")
        if len(d) != 8 or not d.isdigit():
            continue
        rows.append(
            {
                "date": f"{d[:4]}-{d[4:6]}-{d[6:]}",
                "open": it.get("openPrice"),
                "close": it.get("closePrice"),
                "high": it.get("highPrice"),
                "low": it.get("lowPrice"),
                "volume": it.get("accumulatedTradingVolume"),
            }
        )
    return rows[-days:]


def fetch_naver_kr(code, days=DAYS):
    """
    韩股日线（三星电子 `005930`、SK海力士 `000660`…）。

    两个坑，都踩过：
    1. `siseJson.naver` **不是 JSON**（也不是 JSONP），是 JS 数组字面量：表头行
       用单引号、数据行用双引号。`json.loads` 会报 `JSONDecodeError: Expecting
       value`，得用 `ast.literal_eval` 才吃得下两种引号。
    2. 列序是 **日期 / 开 / 高 / 低 / 收 / 量 / 外资持股比** —— 与腾讯的
       「日期 / 开 / 收 / 高 / 低 / 量」**不同**，照抄腾讯的下标会把高低与收盘对调，
       而且不报错（价格量级都对，只是每根 K 线的形状是错的）。
    """
    start, end = _naver_range(days)
    payload = _naver_get(
        NAVER_KR_SISE,
        NAVER_KR_HEADERS,
        {
            "symbol": code,
            "requestType": "1",
            "startTime": start.strftime("%Y%m%d"),
            "endTime": end.strftime("%Y%m%d"),
            "timeframe": "day",
        },
        _parse_naver_kr,
    )
    rows = []
    for it in payload if isinstance(payload, list) else []:
        if not isinstance(it, (list, tuple)) or len(it) < 6:            continue
        d = str(it[0])
        if len(d) != 8 or not d.isdigit():
            continue  # 表头行 ['날짜', '시가', ...]
        rows.append(
            {
                "date": f"{d[:4]}-{d[4:6]}-{d[6:]}",
                "open": it[1],
                "high": it[2],
                "low": it[3],
                "close": it[4],
                "volume": it[5],
            }
        )
    return rows[-days:]


NAVER_FETCHERS = {"JP": fetch_naver_jp, "KR": fetch_naver_kr}


def fetch_naver_cached(market, code, fresh=False, days=DAYS):
    """
    带缓存的 Naver 拉取，缓存文件与腾讯那套同目录（`data/cache`，已被 .gitignore）。

    **空结果不入缓存**：一次网络抖动回个空数组，如果把它写进缓存，当天剩下的
    所有运行都会拿到空数据，而且要等有人删缓存才会好。宁可下次重拉。
    """
    path = os.path.join(CACHE_DIR, f"{market.lower()}{code}_raw_{days}.json")
    if not fresh and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    data = NAVER_FETCHERS[market](code, days=days)
    if data:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    return data


def build_overseas_market(
    universe, anchors, market, industry, currency_code, calendar, fresh=False, days=DAYS
):
    """
    拉一个境外市场的全部标的，返回 `(stocks, market_calendar, dropped)`。

    两个日历是不同的东西，别混：
    - 序列按**传进来的 `calendar`（A 股公共日历）**对齐 —— 快照里所有序列必须等长，
      下游按同一个下标取数。拿市场自己的日历去 align 会让日韩序列比 A 股长 10 根，
      于是每一个日韩价格都被错位地当成「A 股日历上的第 n 天」，**而且不报错**。
    - `market_calendar` 是**这个市场自己的交易日**（从锚点股日线日期的并集反推），
      只用来判断「今天这个市场开不开市」，放进 `meta.<市场>.calendar`，
      与序列对齐无关（同港股：`meta.hk.calendar` 是恒生指数的日期，序列按 A 股日历对齐）。
    """
    rows_by_code = {}
    dropped = 0
    for num, _cname in universe:
        try:
            rows_by_code[num] = fetch_naver_cached(
                market, num, fresh=fresh, days=days
            )
        except Exception as e:  # noqa: BLE001
            warn(f"{industry} {num} 拉取失败: {str(e)[:80]}")
            dropped += 1

    dates = set()
    for num in anchors:
        for r in rows_by_code.get(num) or []:
            dates.add(r["date"])
    market_calendar = sorted(dates)

    stocks = []
    for num, cname in universe:
        rows = rows_by_code.get(num)
        if rows is None:
            continue
        series = align(rows, calendar)
        valid = sum(1 for v in series["close"] if v is not None)
        if valid < 60:
            warn(f"{industry} {num} 只有 {valid} 天有效数据，跳过")
            dropped += 1
            continue
        stocks.append(
            {
                "code": f"{num}.{market}",
                "name": cname,
                "industry": industry,
                "industryCode": market,
                # weight 是申万行业权重，境外市场没有对应概念，给 0（同港股）。
                "weight": 0.0,
                "isST": False,
                "market": market,
                "currency": currency_code,
                **series,
            }
        )
    return stocks, market_calendar, dropped


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
    # open 是给「历史推演」用的：玩家在收盘后做决定，只能按次一交易日开盘价成交，
    # 用当天收盘价成交等于开了天眼。实时页面与四层漏斗不读它，多存一列不影响引擎。
    out = {k: [] for k in ("open", "close", "high", "low", "volume")}
    for d in calendar:
        r = by_date.get(d)
        if r is None:
            for k in out:
                out[k].append(None)
        else:
            out["open"].append(r.get("open"))
            out["close"].append(r["close"])
            out["high"].append(r["high"])
            out["low"].append(r["low"])
            out["volume"].append(r["volume"])
    return out


def fetch_boc_fx(name_cn, pair, days=FX_SERIES_DAYS):
    """
    取最近 `days` 天的中行折算价，返回 `{pair, code, name, dates, rate}`（按日期升序）；
    取不到返回 None。

    `rate` 是「1 单位外币值多少人民币」，正是引擎要的口径
    （`@aw/game` 的 calcFee 拿它把港股最低佣金折回人民币）。

    **为什么要一整条序列而不是只留最新那一个价。** 历史推演要按**当天**的汇率
    把境外价格折成人民币：拿最新一天的价铺满一个月，等于说这一个月里汇率没动过，
    而港币一个月动一两个点是常事。`data/fx-cache/<PAIR>.json` 里早就有长序列
    （`fetch_overseas.py` 写的，2016 年起），但那是**关卡分片**用的，
    快照这条流水线从来没读过它 —— 所以这里多取几天，自己留一份。

    两个坑（与 packages/data/scripts/fetch_overseas.py 里同源）：
    1. 接口收 `YYYYMMDD`，传带横杠的进去会被安静地切错、回一个空表，不报错。
    2. 接口给的是「100 外币兑人民币」，要除以 100。
       列名里只有「中行折算价」一直有值，央行中间价那几列常是 NaN。
    """
    import akshare as ak  # 与 main() 里的延迟导入一致，避免脚本启动就拉起 akshare

    end = (datetime.now(timezone.utc) + timedelta(hours=8)).date()
    start = end - timedelta(days=days)
    df = ak.currency_boc_sina(
        symbol=name_cn,
        start_date=start.strftime("%Y%m%d"),
        end_date=end.strftime("%Y%m%d"),
    )
    rate_col = None
    for c in df.columns:
        if "折算价" in str(c):
            rate_col = c
            break
    if rate_col is None or len(df) == 0:
        return None

    by_date = {}
    for _, row in df.iterrows():
        try:
            f = float(row[rate_col]) / 100.0
        except (TypeError, ValueError):
            continue
        if f != f or f <= 0:  # NaN 或非法值
            continue
        d = str(row[df.columns[0]])[:10]
        # 接口偶尔对同一天回多行（早晚两次报价），留最后一行即可
        by_date[d] = round(f, 6)
    if not by_date:
        return None
    dates = sorted(by_date)
    return {
        "pair": pair,
        "code": pair,
        "name": f"{name_cn}兑人民币",
        "dates": dates,
        "rate": [by_date[d] for d in dates],
    }


def fx_latest(series):
    """序列里最新那一次报价，落成 `{pair, date, rate}`。取不到返回 None。"""
    if not series or not series["dates"]:
        return None
    return {"pair": series["pair"], "date": series["dates"][-1], "rate": series["rate"][-1]}


def align_fx(series, calendar):
    """
    把汇率序列对齐到快照日历，得到与 `calendar` **等长**的一列；没有报价的那天填 None。

    为什么对齐而不是原样存 dates/rate：调用方（`@aw/data` 的 `fxSeriesOfMeta`）
    要拿它和股票的价格列**按下标**一起走。让它自己去 join 日期，等于把
    「中行哪天没报价」这条规则复制到第二个地方 —— 而折算函数里已经有一条
    「缺的那天沿用上一个已知汇率」（见 `cnyColumn` / `convertSnapshotToCny`）。
    """
    if not series:
        return None
    by_date = dict(zip(series["dates"], series["rate"]))
    aligned = [by_date.get(d) for d in calendar]
    if all(v is None for v in aligned):
        return None
    return {"pair": series["pair"], "code": series["code"], "name": series["name"], "rate": aligned}


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
        "--workers",
        type=int,
        default=4,
        help="并发线程数（默认 4）。调高会被腾讯限流返回 501，反而拉得更差——"
        "实测 8 线程拉 628 个标的时失败了 206 个",
    )
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
    # 磁盘缓存只按「标的 + 天数 + 复权」做键，不含日期：昨天跑过一次，今天再跑会直接命中
    # 昨天的缓存，asOf 停在昨天，产出一份和昨天完全相同的快照——看着像成功，其实没更新。
    # CI 每次都是空跑的干净环境，不受影响；本机重复跑必须加 --fresh。
    _bj = datetime.now(timezone.utc) + timedelta(hours=8)
    _ref = _bj.date()
    while _ref.weekday() >= 5:  # 周末没有新数据，参照日回退到最近的工作日
        _ref -= timedelta(days=1)
    if as_of != _ref.isoformat() and not args.fresh and _bj.hour >= 9:
        warn(
            f"asOf={as_of} 早于最近的工作日（{_ref.isoformat()}）。今天若本该是交易日，"
            f"多半是命中了过期缓存，请加 --fresh 重跑；节假日看到这条可忽略。"
        )

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
            open_ = []
            for d in calendar:
                r = by_date.get(d)
                if r is None:
                    open_.append(None)
                    close.append(None)
                    high.append(None)
                    low.append(None)
                    volume.append(None)
                else:
                    # akshare 的申万行业指数列名是中文，开盘价不一定存在——取不到就存 null，
                    # 不要用收盘价顶替（那会让回放看起来"开盘即收盘"）。
                    # `v != v` 是判断 NaN 的老办法，省得为此把 pandas 引进这个函数。
                    raw_open = r["开盘"] if "开盘" in r else None
                    open_.append(float(raw_open) if raw_open is not None and raw_open == raw_open else None)
                    close.append(float(r["收盘"]))
                    high.append(float(r["最高"]))
                    low.append(float(r["最低"]))
                    volume.append(float(r["成交量"]))
            sectors.append(
                {
                    "code": ind["code"],
                    "name": ind["name"],
                    "open": open_,
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

    # —— 港股 ——
    # 与 A 股共用同一份日历（快照的所有序列必须等长，下游按同一个下标取数）。
    # 港股放假而 A 股开市的日子（圣诞、佛诞、复活节）会留下 null——
    # 那不是缺数据，是那天港股真的没开市，界面照 null 显示空档才对。
    print(f"    拉取港股 {len(HK_UNIVERSE)} 只...")
    hk_calendar = []
    try:
        hsi = fetch_tencent_cached(
            HK_CALENDAR_SYMBOL, qfq=False, fresh=args.fresh, days=args.days
        )
        hk_calendar = [r["date"] for r in hsi]
        print(f"       恒生指数 {len(hk_calendar)} 根，港股交易日历以此为准")
    except Exception as e:  # noqa: BLE001
        warn(f"恒生指数拉取失败，港股交易日历缺失: {str(e)[:90]}")

    hk_stocks = []
    hk_dropped = 0
    for num, cname in HK_UNIVERSE:
        sym = f"hk{num}"
        try:
            rows = fetch_tencent_cached(sym, qfq=False, fresh=args.fresh, days=args.days)
        except Exception as e:  # noqa: BLE001
            warn(f"港股 {sym} 拉取失败: {str(e)[:80]}")
            hk_dropped += 1
            continue
        series = align(rows, calendar)
        valid = sum(1 for v in series["close"] if v is not None)
        if valid < 60:
            warn(f"港股 {sym} 只有 {valid} 天有效数据，跳过")
            hk_dropped += 1
            continue
        hk_stocks.append(
            {
                "code": f"{num}.HK",
                "name": cname,
                "industry": "港股",
                "industryCode": "HK",
                # weight 是申万行业权重，港股没有对应概念，给 0。
                # 它只影响「按权重」的排序，游戏里的选股清单按涨跌/成交额排，用不到。
                "weight": 0.0,
                "isST": False,
                "market": "HK",
                "currency": "HKD",
                **series,
            }
        )
    print(f"    港股 {len(hk_stocks)} 只，跳过 {hk_dropped} 只")

    def safe_boc_fx(name_cn, pair, label):
        """取不到折算价只 warn，不中断快照 —— 与 hk_fx 一直是这个策略。"""
        try:
            got = fetch_boc_fx(name_cn, pair)
        except Exception as e:  # noqa: BLE001
            warn(f"{label}折算价拉取失败: {str(e)[:90]}")
            return None
        if not got:
            warn(f"{label}折算价取到空表，相关标的将无法折算成人民币")
            return None
        latest = fx_latest(got)
        print(f"    {label}折算价 {latest['date']}：{latest['rate']}（序列 {len(got['dates'])} 天）")
        return got

    # 中行的币种名是**「韩国元」不是「韩元」**：传「韩元」会 `KeyError: '韩元'`，
    # 传「韩币」也一样。这个不是笔误，是中行页面上就这么写的。
    hk_fx = safe_boc_fx("港币", "HKDCNY", "港币")

    # —— 日股 / 韩股 ——
    # 与 A 股共用同一份日历：日韩放假而 A 股开市的日子留 null（同港股）。
    # 日历从锚点股日线日期的并集反推 —— Naver 的 foreign 接口对 KOSPI/N225
    # 一律返回空数组，没有指数日线可用。
    # 整块失败只 warn 并跳过：日韩是新增市场，不该因为它拿不到数据就毁掉
    # 整个快照（A 股 + 港股那一大段是完全独立的）。
    jp_stocks, jp_calendar = [], []
    print(f"    拉取日股 {len(JP_UNIVERSE)} 只...")
    try:
        jp_stocks, jp_calendar, jp_dropped = build_overseas_market(
            JP_UNIVERSE,
            JP_CALENDAR_ANCHORS,
            "JP",
            "日股",
            "JPY",
            calendar,
            fresh=args.fresh,
            days=args.days,
        )
        print(
            f"    日股 {len(jp_stocks)} 只，交易日历 {len(jp_calendar)} 天，跳过 {jp_dropped} 只"
        )
    except Exception as e:  # noqa: BLE001
        warn(f"日股整块跳过: {str(e)[:90]}")

    kr_stocks, kr_calendar = [], []
    print(f"    拉取韩股 {len(KR_UNIVERSE)} 只...")
    try:
        kr_stocks, kr_calendar, kr_dropped = build_overseas_market(
            KR_UNIVERSE,
            KR_CALENDAR_ANCHORS,
            "KR",
            "韩股",
            "KRW",
            calendar,
            fresh=args.fresh,
            days=args.days,
        )
        print(
            f"    韩股 {len(kr_stocks)} 只，交易日历 {len(kr_calendar)} 天，跳过 {kr_dropped} 只"
        )
    except Exception as e:  # noqa: BLE001
        warn(f"韩股整块跳过: {str(e)[:90]}")

    jp_fx = safe_boc_fx("日元", "JPYCNY", "日元") if jp_stocks else None
    kr_fx = safe_boc_fx("韩国元", "KRWCNY", "韩元") if kr_stocks else None

    stocks = stocks + hk_stocks + jp_stocks + kr_stocks

    stock_codes = {s["code"] for s in stocks}
    for s in sectors:
        before = len(s["members"])
        s["members"] = [c for c in s["members"] if c in stock_codes]
        if len(s["members"]) != before:
            warn(f"板块 {s['name']} 成员裁剪 {before} -> {len(s['members'])}")

    # 不变量：每一支的每条序列都必须和 A 股公共日历等长 —— 下游是按同一个下标取数的。
    # 破了这条**不会报错**，只会让整条序列错位（港股/日韩比 A 股多出来的那几天会
    # 被当成 A 股日历上的第 n 天），价格看着都正常。所以宁可在这里当场炸掉。
    for s in stocks:
        for col in ("open", "close", "high", "low", "volume"):
            if len(s[col]) != len(calendar):
                raise RuntimeError(
                    f"快照不变量被破坏：{s['code']} 的 {col} 有 {len(s[col])} 根，"
                    f"公共日历是 {len(calendar)} 天（序列必须按公共日历对齐）"
                )

    out_dir = os.path.join(ROOT, "data", f"snapshot_{as_of.replace('-', '')}")
    os.makedirs(out_dir, exist_ok=True)
    meta = {
        "asOf": as_of,
        "source": "申万官网(akshare) + 腾讯行情(A股/港股/实时) + Naver(日韩日线) + 中行折算价 + 东方财富市值(可用时)",
        "poolNote": f"演示股票池：申万一级行业按市值/权重前 {args.limit} 只代表股",
        "calendarNote": "以沪深300交易日为公共日历",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "days": len(calendar),
        # 港股的交易日历与折算价放 meta：快照的顶层文件是按 A 股的四层漏斗设计的，
        # 多塞一个 hk 字段不用改加载器（meta 本来就是自由结构）。
        "hk": {
            "calendar": hk_calendar,
            "calendarNote": "以恒生指数有日线的日期为准，与 A 股日历不同（港股的圣诞、佛诞、复活节 A 股照常开市）",
            "universeNote": f"固定 {len(HK_UNIVERSE)} 只，与历史推演用的是同一批标的",
            "count": len(hk_stocks),
            # rate 是「1 港币值多少人民币」，引擎用它把港股折成人民币记账。
            # 注意这是快照生成当天的价，盘中用它折算会有一点点滞后——港股价格本身
            # 在盘中也会变，两者都是当日口径，够用。
            "fx": fx_latest(hk_fx),
            # 逐日汇率，与 calendar 等长（没有报价的那天是 null）。
            # `fx` 那个标量是「最新的一个价」，实时盘用它；历史推演必须用这一条，
            # 否则等于假设这一百多天里汇率没动过。
            "fxSeries": align_fx(hk_fx, calendar),
        },
        # 日韩照 hk 的形状放 meta：顶层文件是按 A 股的四层漏斗设计的，多塞字段
        # 不用改加载器（meta 本来就是自由结构）。
        "jp": {
            "calendar": jp_calendar,
            "calendarNote": "以丰田、索尼等锚点个股在 Naver 有日线的日期并集为准（日韩没有可用的指数日线，只能从个股反推）",
            "universeNote": f"固定 {len(JP_UNIVERSE)} 只，日经 225 里成交活跃的大盘股",
            "count": len(jp_stocks),
            # rate 是「1 日元值多少人民币」（中行折算价 ÷ 100）
            "fx": fx_latest(jp_fx),
            "fxSeries": align_fx(jp_fx, calendar),
        },
        "kr": {
            "calendar": kr_calendar,
            "calendarNote": "以三星电子、SK海力士等锚点个股在 Naver 有日线的日期并集为准",
            "universeNote": f"固定 {len(KR_UNIVERSE)} 只，KOSPI 权重股",
            "count": len(kr_stocks),
            "fx": fx_latest(kr_fx),
            "fxSeries": align_fx(kr_fx, calendar),
        },
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
