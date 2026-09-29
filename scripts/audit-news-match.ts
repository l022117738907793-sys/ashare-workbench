/**
 * 量一下新闻关键词匹配到底错在哪 —— 改之前量，改之后也能量。
 *
 * 中文没有词边界，`text.includes(name)` 等于把「名字出现过」当成「在说这家公司」。
 * 这个脚本拿**真实快照的 619 个股票名** × 真实快讯跑一遍，把四类东西打出来：
 *
 *   1. 命中股票数，以及修复前/修复后的逐只对照（被挡掉的必须逐条确认是误命中）
 *   2. 名字互为子串的股票对（当前快照里没有，一旦出现就得改匹配策略）
 *   3. 命中处的左右上下文（看是不是嵌在别的词里）
 *   4. 只靠 6 位数字命中的（数字边界问题）
 *
 * 实测结论（2026-09-30，800 条头条）：误命中只有「名字被另一个词吞掉」一种形状，
 * 共 3 例（中国银行业 / 上海银行间 / 中国石油化工），外加 1 例数字边界
 * （受理号 CXSL2601061 命中中信金属 601061）。修完全部消失，且没有误伤任何真命中。
 * 详细结论见 docs/news-sources.md。
 *
 *   npx vite-node scripts/audit-news-match.ts [快照目录]
 *   AUDIT_PAGES=16 npx vite-node scripts/audit-news-match.ts      # 多翻几页，语料更大
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchLatestNews, matchNewsToStock, type NewsItem } from "../packages/data/src/index";

const ROOT = process.cwd();
const DATA = join(ROOT, "data");

function pickSnapshot(arg?: string): string {
  if (arg) return join(DATA, arg);
  const newest = readdirSync(DATA).filter((n) => /^snapshot_\d{8}$/.test(n)).sort().pop();
  if (!newest) throw new Error("data/ 下没有快照");
  return join(DATA, newest);
}

type Stock = { code: string; name: string; industry: string };

const dir = pickSnapshot(process.argv[2]);
const stocks = JSON.parse(readFileSync(join(dir, "stocks.json"), "utf8")) as Stock[];
console.log(`快照 ${dir.replace(ROOT + "/", "")}：${stocks.length} 只股票\n`);

/**
 * 同花顺 provider 只取 page=1&pagesize=50，做统计远远不够。
 * 这里直接翻页抓一批历史头条当语料（实测 page 参数有效，每页 50 条不重复）。
 */
const PAGES = Number(process.env.AUDIT_PAGES ?? 12);
async function fetchCorpus(pages: number): Promise<NewsItem[]> {
  const out: NewsItem[] = [];
  const seen = new Set<string>();
  for (let p = 1; p <= pages; p += 1) {
    const url = `https://news.10jqka.com.cn/tapp/news/push/stock/?page=${p}&tag=&track=website&pagesize=50`;
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
        Referer: "https://news.10jqka.com.cn/",
      },
    });
    if (!res.ok) break;
    const json = (await res.json()) as { data?: { list?: Array<Record<string, unknown>> } | null };
    const list = json.data?.list ?? [];
    if (list.length === 0) break;
    for (const it of list) {
      const id = String(it.id ?? "");
      const title = String(it.title ?? it.digest ?? "").trim();
      if (!id || !title || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        title,
        digest: String(it.digest ?? ""),
        at: 0,
        source: "tonghuashun",
        timeKnown: false,
      });
    }
  }
  return out;
}

/** 顺带确认 provider 本身没坏（它才是线上真正走的那条路） */
const live = await fetchLatestNews(30);
console.log(`provider 健康检查：${live.source ?? "无"}，${live.items.length} 条${live.degradedReason ? `（${live.degradedReason}）` : ""}`);

const items = await fetchCorpus(PAGES);
console.log(`语料：翻 ${PAGES} 页，去重后 ${items.length} 条头条\n`);
if (items.length === 0) process.exit(1);

// ── 1. 一条新闻命中多只股票：其中至少有一部分是误命中 ──────────
const byStock = new Map<string, NewsItem[]>();
/** 修复前的旧实现：裸 includes。留着做「改之前 vs 改之后」的对照，否则没法证明改动没冤枉谁。 */
function legacyMatch(list: NewsItem[], name: string, code: string): NewsItem[] {
  const num = code.split(".")[0] ?? "";
  return list.filter((n) => {
    const text = `${n.title} ${n.digest}`;
    return text.includes(name) || text.includes(num) || text.includes(code);
  });
}

for (const s of stocks) {
  const hit = matchNewsToStock(items, s.name, s.code);
  if (hit.length > 0) byStock.set(s.code, hit);
}

type Clash = { item: NewsItem; codes: string[] };
const clashes: Clash[] = [];
for (const n of items) {
  const codes = stocks
    .filter((s) => matchNewsToStock([n], s.name, s.code).length > 0)
    .map((s) => s.code);
  if (codes.length > 1) clashes.push({ item: n, codes });
}

console.log(`\n命中股票数：${byStock.size}`);

// ── 1b. 改之前 vs 改之后：只有「以前有、现在没有」的才需要逐条看 ──
const legacyMatched = new Set<string>();
for (const s of stocks) {
  if (legacyMatch(items, s.name, s.code).length > 0) legacyMatched.add(s.code);
}
const lost = [...legacyMatched].filter((c) => !byStock.has(c));
const gained = [...byStock.keys()].filter((c) => !legacyMatched.has(c));
console.log(`\n修复前命中 ${legacyMatched.size} 只，修复后 ${byStock.size} 只`);
console.log(`被挡掉的股票（${lost.length} 只，必须逐条确认确实是误命中）：`);
for (const code of lost) {
  const s = stocks.find((x) => x.code === code);
  if (!s) continue;
  for (const n of legacyMatch(items, s.name, s.code)) {
    console.log(`  · ${s.name}（${code}）`);
    console.log(`    标题：${n.title}`);
    console.log(`    摘要：${n.digest.slice(0, 200)}`);
  }
}
console.log(`新增命中的股票（${gained.length} 只，应当为 0）：${gained.join(" ") || "（无）"}`);

console.log(`一条新闻被算到多只股票头上的：${clashes.length} 条`);
for (const c of clashes.slice(0, 20)) {
  const names = c.codes.map((code) => stocks.find((s) => s.code === code)?.name ?? code);
  console.log(`  · ${c.item.title.slice(0, 42)}`);
  console.log(`    → ${names.join(" / ")}`);
}

// ── 2. 股票名是另一个更长名字的一部分（中文没有词边界） ────────
console.log(`\n名字互为子串的股票对（改匹配时必须处理的一类）：`);
const substrPairs: string[] = [];
for (const a of stocks) {
  for (const b of stocks) {
    if (a.code === b.code) continue;
    if (b.name.includes(a.name)) substrPairs.push(`${a.name}(${a.code}) ⊂ ${b.name}(${b.code})`);
  }
}
console.log(substrPairs.length === 0 ? "  （本快照里没有）" : substrPairs.map((p) => `  · ${p}`).join("\n"));

// ── 3. 名字出现在更长词组里：把命中处的上下文挖出来看 ──────────
console.log(`\n命中处的上下文（看看是不是嵌在别的词里）：`);
let shown = 0;
for (const s of stocks) {
  const hit = byStock.get(s.code);
  if (!hit) continue;
  for (const n of hit) {
    const text = `${n.title} ${n.digest}`;
    const i = text.indexOf(s.name);
    if (i < 0) continue;
    const before = text.slice(Math.max(0, i - 6), i);
    const after = text.slice(i + s.name.length, i + s.name.length + 6);
    // 只关心「前后还接着中文字」的，那种才是可能被吞进别的词里的
    const cjk = /[\u4e00-\u9fa5]/;
    const gluedBefore = cjk.test(before.slice(-1));
    const gluedAfter = cjk.test(after.slice(0, 1));
    if (!gluedBefore && !gluedAfter) continue;
    console.log(`  · ${s.name}：…${before}【${s.name}】${after}…`);
    shown += 1;
    if (shown >= 60) break;
  }
  if (shown >= 60) break;
}
if (shown === 0) console.log("  （这一批新闻里没有出现紧贴中文的命中）");

// ── 4. 数字代码匹配是否也会误伤 ────────────────────────────────
console.log(`\n靠 6 位数字命中的（去掉名字匹配后剩下的）：`);
let numericOnly = 0;
for (const s of stocks) {
  const num = s.code.split(".")[0]!;
  for (const n of items) {
    const text = `${n.title} ${n.digest}`;
    if (!new RegExp(`(?<!\\d)${num}(?!\\d)`).test(text)) continue;
    if (matchNewsToStock([n], s.name, s.code).length > 0) continue;
    const i = text.indexOf(num);
    const ctx = text.slice(Math.max(0, i - 8), i + num.length + 8);
    console.log(`  · ${s.code} ${s.name}：…${ctx}…`);
    numericOnly += 1;
    if (numericOnly >= 12) break;
  }
  if (numericOnly >= 12) break;
}
if (numericOnly === 0) console.log("  （没有）");

writeFileSync(
  "/tmp/news-audit.json",
  JSON.stringify(
    {
      fetchedAt: new Date().toISOString(),
      source: live.source,
      count: items.length,
      clashCount: clashes.length,
      substrPairs,
      items: items.map((n) => ({ id: n.id, title: n.title, digest: n.digest })),
    },
    null,
    2,
  ),
);
console.log("\n原始样本已写到 /tmp/news-audit.json（改完匹配规则可以拿同一批数据回归）");
