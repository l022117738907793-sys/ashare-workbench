#!/usr/bin/env python3
"""抓历史推演里「当天能看到的资讯」——新浪财经历史首页的新闻标题。

## 为什么要单独抓

实时模式那套新闻是**今天**的快讯（同花顺 / 东方财富的实时接口）。历史推演把
玩家放回 2020 年 2 月 3 日，给他看 2026 年的快讯是荒谬的；更要命的是，那等于
直接告诉他后面发生了什么。所以历史推演一直没有资讯 —— 不是忘了做，是没有
「那一天」的数据。

新浪的财经首页有按日归档：`https://finance.sina.com.cn/head/finance{YYYYMMDD}am.shtml`。
这是当天**上午**那版首页的快照（实测 2010 年起都有），里面的文章链接自带
`/2020-02-03/` 这样的一段路径，所以能拿它反向确认「这条确实是那天的」。

## 为什么一天一个文件

因为剧透。整关 26 天的资讯塞进一个文件，玩家按 F12 就能把后面的剧情全读了。
一天一个文件、按需取，至少不会**顺手**看到 —— 客户端只请求走到的那一天。

（诚实的边界：知道文件名规律的人仍然可以手动去取后面几天。这是静态站点，
没有服务端就没法真正挡住。想彻底封死只能上后端。）

## 用法

    python3 packages/data/scripts/fetch_history_news.py            # 补齐缺的
    python3 packages/data/scripts/fetch_history_news.py --force    # 全部重抓
    python3 packages/data/scripts/fetch_history_news.py --levels 2020-02-03

原始 HTML 缓存在 data/news-cache/（gitignore），重跑不再打人家服务器。
产出 data/history/news/<YYYY-MM-DD>.json，由 sync_web_data.mjs 拷进网页。
"""
from __future__ import annotations

import argparse
import html as htmllib
import http.client
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".."))
if not os.path.exists(os.path.join(ROOT, "package.json")):
    sys.exit(f"根目录算错了：{ROOT} 下没有 package.json")

HISTORY_DIR = os.path.join(ROOT, "data", "history")
NEWS_DIR = os.path.join(HISTORY_DIR, "news")
CACHE_DIR = os.path.join(ROOT, "data", "news-cache")
SNAPSHOT_DIR = os.path.join(ROOT, "data")

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
# 一天最多留几条。首页上能确认日期的链接有一百多条，全留下等于没筛选；
# 玩家在推演里真正会读的也就前几条最大的事。
MAX_PER_DAY = 18
# 两个请求之间的间隔。这是在翻人家的历史归档，不是自己的接口。
DELAY = 1.2

LINK_RE = re.compile(r'<a[^>]+href="(https?://[^"]+)"[^>]*>([^<]{12,60})</a>')
# 这些不是新闻：广告跳转、专题聚合页、行情工具入口。
JUNK_URL = (
    "sax.sina.com.cn/click",
    "/zt_d/",
    "touzi.sina.com.cn",
    "/corp/",
    "login.sina.com.cn",
    "passport.sina.com.cn",
)
JUNK_TITLE = ("专题", "广告", "大字版", "客户端", "手机版")


def log(msg: str) -> None:
    print(msg, flush=True)


class NoArchive(Exception):
    """这一天两版归档都没有（am 和 pm 都是 404）。

    这不是错误，是**缺**：新浪的归档本来就是按天手工发的，有些日子（早年、
    节前补版、系统漏发）就是没有。以前把它当成失败，于是失败率被这些日子
    顶过 20%，脚本自己把自己停了。
    """


def archive_url(day: str, suffix: str) -> str:
    return f"https://finance.sina.com.cn/head/finance{day.replace('-', '')}{suffix}.shtml"


def _read(url: str) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Referer": "https://finance.sina.com.cn/",
            # 不要 gzip：这套归档页偶发 IncompleteRead，压缩流断在半路就整段解不开，
            # 不压缩至少能拿到已经传过来的那部分。
            "Accept-Encoding": "identity",
        },
    )
    buf = b""
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                buf += chunk
    except http.client.IncompleteRead as exc:
        # 实测 2024 年的页面会这样。半份也够标题用了。
        buf += exc.partial
    if not buf:
        raise RuntimeError("空响应")
    return buf


def fetch_html(day: str, force: bool) -> tuple[str, str]:
    """取一天的归档首页，返回 (html, 实际用的 url)。缓存优先。

    **am 优先，404 就退到 pm。** 实测有一批日子只有下午那版（2019-02-18、
    2020-07-22 都是 am 404 / pm 200），退回一步能捞回一大半。
    """
    os.makedirs(CACHE_DIR, exist_ok=True)
    for suffix in ("am", "pm"):
        url = archive_url(day, suffix)
        cache = os.path.join(CACHE_DIR, f"{day}-{suffix}.html")
        # 第一版缓存的文件名不带后缀（那天只有 am 这一条路），别浪费已经抓下来的
        if suffix == "am" and not os.path.exists(cache):
            legacy = os.path.join(CACHE_DIR, f"{day}.html")
            if os.path.exists(legacy):
                cache = legacy
        if os.path.exists(cache) and not force:
            with open(cache, "rb") as f:
                return f.read().decode("utf-8", "ignore"), url
        try:
            buf = _read(url)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                continue  # 这一版没有，试下一版
            raise
        with open(cache, "wb") as f:
            f.write(buf)
        return buf.decode("utf-8", "ignore"), url
    raise NoArchive(day)


def extract(html: str, day: str) -> list[dict[str, str]]:
    """挑出「链接自带这一天」的标题。

    这是唯一的凭据：归档页上还挂着导航、专题、往期推荐，它们没有日期，
    只有当天真正的稿件链接里带着 `/2020-02-03/`。
    """
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for href, raw_title in LINK_RE.findall(html):
        if day not in href:
            continue
        if any(j in href for j in JUNK_URL):
            continue
        # 只要文章页。带查询串的、跳转页的都不算。
        path = href.split("?")[0]
        if not path.endswith((".shtml", ".html")):
            continue
        title = htmllib.unescape(raw_title).strip()
        title = re.sub(r"\s+", " ", title)
        if title in seen or any(j in title for j in JUNK_TITLE):
            continue
        if title.endswith(">>") or title.startswith("图集"):
            continue
        seen.add(title)
        out.append({"title": title, "url": href})
        if len(out) >= MAX_PER_DAY:
            break
    return out


def level_days() -> list[str]:
    """所有关卡日历里的交易日，跨关去重后按时间排。"""
    if not os.path.isdir(HISTORY_DIR):
        sys.exit(f"没有 {HISTORY_DIR}，先跑 scripts/build-history-shards.ts")
    days: set[str] = set()
    for name in sorted(os.listdir(HISTORY_DIR)):
        if not (name.startswith("level-") and name.endswith(".json")):
            continue
        with open(os.path.join(HISTORY_DIR, name), encoding="utf-8") as f:
            shard = json.load(f)
        days.update(shard.get("calendar") or [])
    return sorted(days)


def snapshot_days() -> list[str]:
    """当前快照的日历 —— 随机模式就是在这一段里挑起点。

    这一段会随每天的快照往后走，所以它是「补到现在为止」的，不是一次抓完
    就永久够用。真正的解法是让每日快照的工作流顺手把新出现的那几天补上。
    """
    if not os.path.isdir(SNAPSHOT_DIR):
        return []
    cands = [
        d for d in os.listdir(SNAPSHOT_DIR)
        if d.startswith("snapshot_") and os.path.isdir(os.path.join(SNAPSHOT_DIR, d))
    ]
    if not cands:
        return []
    latest = sorted(cands)[-1]
    path = os.path.join(SNAPSHOT_DIR, latest, "calendar.json")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        cal = json.load(f)
    return [d for d in cal if isinstance(d, str)]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="忽略缓存与已有产出，全部重抓")
    ap.add_argument("--levels", default="", help="只抓这些关卡（逗号分隔的 levelId）")
    ap.add_argument("--no-snapshot", action="store_true", help="不抓当前快照窗口")
    ap.add_argument("--delay", type=float, default=DELAY)
    args = ap.parse_args()

    days = level_days()
    if not args.no_snapshot:
        extra = [d for d in snapshot_days() if d not in days]
        log(f"当前快照窗口另有 {len(extra)} 天需要补")
        days = sorted(days + extra)
    if args.levels:
        keep = {s.strip() for s in args.levels.split(",") if s.strip()}
        days = [d for d in days if any(d in k or k in d for k in keep)]
    if not days:
        sys.exit("没有要抓的日期")

    os.makedirs(NEWS_DIR, exist_ok=True)
    todo = [
        d for d in days
        if args.force or not os.path.exists(os.path.join(NEWS_DIR, f"{d}.json"))
    ]
    log(f"共 {len(days)} 天，待抓 {len(todo)} 天（已有 {len(days) - len(todo)} 天）")
    if not todo:
        return

    empty: list[str] = []
    no_archive: list[str] = []
    failed: list[str] = []
    total = 0
    for i, day in enumerate(todo, 1):
        source_url = archive_url(day, "am")
        try:
            html, source_url = fetch_html(day, args.force)
            items = extract(html, day)
        except NoArchive:
            # 两版都没有。也写一份空文件：界面会说「这一天没抓到」，
            # 而且下次重跑不会再打一遍 —— 空文件本身就是「查过了，没有」的记录。
            no_archive.append(day)
            items = []
        except (urllib.error.URLError, RuntimeError, OSError, ValueError) as exc:
            failed.append(day)
            log(f"[{i}/{len(todo)}] {day} 失败：{type(exc).__name__} {exc}")
            time.sleep(args.delay)
            continue
        if not items and day not in no_archive:
            # 归档页在，但里面没有带当天日期的链接（版式不同的早年页面）。
            empty.append(day)
        version = "下午" if source_url.endswith("pm.shtml") else "上午"
        payload = {
            "date": day,
            "source": "新浪财经首页归档",
            "url": source_url,
            "note": f"当天{version}那版首页上的稿件标题，按页面顺序，最多 18 条。"
            + ("" if items else "这一天没能从归档里取到标题。"),
            "items": items,
        }
        tmp = os.path.join(NEWS_DIR, f".{day}.json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, os.path.join(NEWS_DIR, f"{day}.json"))
        total += len(items)
        if i % 10 == 0 or i == len(todo):
            log(f"[{i}/{len(todo)}] {day} {len(items)} 条")
        time.sleep(args.delay)

    log(f"\n抓到 {total} 条标题，写入 {len(todo) - len(failed)} 个文件 -> {NEWS_DIR}")
    if empty:
        log(f"其中 {len(empty)} 天归档页在但没有当天稿件：{'、'.join(empty[:8])}"
            + ("…" if len(empty) > 8 else ""))
    if no_archive:
        log(f"{len(no_archive)} 天两版归档都没有（不是错误，是那几天没发）："
            f"{'、'.join(no_archive[:8])}" + ("…" if len(no_archive) > 8 else ""))
    if failed:
        log(f"失败 {len(failed)} 天：{'、'.join(failed[:8])}" + ("…" if len(failed) > 8 else ""))
    # 只有真的取不到才算失败。「归档里没有这一天」是数据本身的洞，不该让整个脚本退出。
    if len(failed) > len(todo) * 0.2:
        sys.exit(f"失败率过高（{len(failed)}/{len(todo)}），先查是不是被封了")


if __name__ == "__main__":
    main()
