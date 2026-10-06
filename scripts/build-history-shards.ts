#!/usr/bin/env node
/**
 * 把 data/history-cache/ 的深历史切成传奇模式要用的关卡分片。
 *
 * 为什么要有这一步，而不是让网页直接读缓存：
 * - 缓存是 619 只 × 9 年（2244 根）× 5 个字段，**六十多兆**，不可能发给浏览器；
 * - 一个关卡其实只用到其中 26 天、一百多只股票，切出来一份大约一百多 KB。
 *
 * 选股规则：**按市场分组，各组内按窗口日均成交额（收盘价 × 成交量）从大到小取名额**。
 * 用成交额而不是市值/权重，是因为「当时成交最活跃的那批股票」是可以从数据里算出来的，
 * 而历史权重我们拿不到 —— 拿今天的权重去排 2016 年的股票池才是真的错。
 *
 * 为什么**必须**按市场分组，不能混在一张表里排：
 * 美股大盘股的成交额按美元算是 10^10 量级，A 股多数在 10^8–10^9。直接混排，
 * 美股会把 A 股整个顶掉；而且两种货币的成交额本来就没有可比性。
 * 所以每个市场各自定额（见 MARKET_QUOTA），港股/美股用不完的名额还给 A 股，
 * 每关总数仍然是 --per-level。
 *
 * ── 境外的「缺」和 A 股不是一回事，必须分开处理 ──────────────────
 * A 股：主日历就是沪深300 的交易日，某天在缓存里查不到 = 停牌或数据缺失
 *       → 收盘价留 null；窗口内缺得太多（> MAX_MISSING_RATIO）整只不要。
 * 境外：主日历**仍然是 A 股日历**，此时有三种「缺」，含义完全不同：
 *   ① 外盘休市、A 股开着（美股感恩节）→ close **向后填充**，open/high/low/volume 留 null。
 *      为什么 close 必须填：持仓估值走 portfolio.ts 的 `p ?? h.avgCost` 兜底，
 *      收盘价给 null 会让权益曲线在休市日按成本价重估、凭空跳一下。
 *      open 留 null 是给引擎的信号：那天没法撮合，委托该顺延而不是作废。
 *   ② A 股休市、外盘开着（春节）→ 那根 K 线在 A 股日历上根本不存在，自然被跳过。
 *   ③ 标的还没上市（阿里 2019-11-26）→ 整段 null。判据是「外盘真开门的天数」占比，
 *      低于 MIN_COVERAGE 就不进这一关 —— 见 coverage 的注释，不能用 close 数，
 *      因为 close 被填充过，永远有值。
 *
 * 用法：
 *   npx vite-node scripts/build-history-shards.ts                 # 全部 10 关
 *   npx vite-node scripts/build-history-shards.ts --per-level 80
 *   npx vite-node scripts/build-history-shards.ts --level 2020-02-03
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LEVELS } from "../packages/game/src/levels";

const ROOT = process.cwd();
const CACHE = join(ROOT, "data", "history-cache");
const FX_CACHE = join(ROOT, "data", "fx-cache");
const OUT = join(ROOT, "data", "history");
const BENCHMARK_CODE = "000300.SH";

/** 境外标的「外盘真开门的天数」占窗口的比例低于这个值，说明那会儿还没上市 */
const MIN_COVERAGE = 0.8;

/** A 股口径：窗口内缺收盘价的交易日超过这个比例就整只不要（还没上市 / 长期停牌） */
const MAX_MISSING_RATIO = 0.1;

/**
 * 每个市场的入选名额。**不做跨币种混排**，理由见文件头。
 * 港股/美股凑不满时，剩下的名额自动还给 A 股，所以总数恒定为 --per-level。
 * 这两个数字是按 2016 那一关的实测可用数定的（HK 12 只、US 19 只可用）。
 */
const MARKET_QUOTA: Record<string, number> = { HK: 12, US: 20 };

/** 输出分片时各市场的排列顺序：A 股在前，玩家最熟悉 */
const MARKET_ORDER = ["CN", "HK", "US"];

type Market = "SH" | "SZ" | "BJ" | "HK" | "US";
type Currency = "CNY" | "HKD" | "USD";

const MARKET_LABEL: Record<Market, string> = {
  SH: "沪市",
  SZ: "深市",
  BJ: "北交所",
  HK: "港股",
  US: "美股",
};

interface Series {
  code: string;
  name: string;
  /** 境外缓存才有；A 股缓存没有这两个字段，缺省按 A 股处理 */
  market?: Market;
  currency?: Currency;
  dates: string[];
  open: Array<number | null>;
  close: Array<number | null>;
  high: Array<number | null>;
  low: Array<number | null>;
  volume: Array<number | null>;
}

interface FxSeries {
  code: string;
  name: string;
  dates: string[];
  rate: Array<number | null>;
}

function argValue(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
function argString(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

/** dates 已升序，二分找最后一个 ≤ day 的下标；没有返回 -1 */
function lastIndexAtOrBefore(sorted: string[], day: string): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= day) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** dates 已升序，二分找最后一个 < day 的下标；没有返回 -1（「前一天」必须严格早于 day） */
function lastIndexBefore(sorted: string[], day: string): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < day) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * 四列里非正价格的个数。
 *
 * 为什么需要这个守卫：**前复权（qfq）是从今天往回缩**，高股息老股历年派息累加到一定程度，
 * 历史价会被扣成负数。实测 SBUX 2016 年整条序列是负的（-37.7 起），AVGO/MCD/COST 同理。
 * 而负价格进引擎**不会报错**：负 ÷ 负 的涨跌幅是正数，负数金额又小于可用资金，
 * 一字跌停的边界判定也拦不住 —— 引擎会一路放行，最后在界面上显示一个负的股价。
 * 所以宁可不发这一只，也不能让它进分片。
 */
function nonPositiveCount(cols: Array<Array<number | null>>): number {
  let n = 0;
  for (const col of cols) for (const v of col) if (v != null && !(v > 0)) n += 1;
  return n;
}

if (!existsSync(CACHE)) {
  console.error(`没有找到 ${CACHE}`);
  console.error("先跑：python3 packages/data/scripts/fetch_history.py");
  process.exit(1);
}

const perLevel = argValue("--per-level", 150);
const onlyLevel = argString("--level");

/**
 * code → 申万一级行业名，取自最新快照。
 *
 * 为什么要抄进分片：分片本身只有行情，可「模拟下单」要给不懂股票的玩家一份
 * 「各板块涨得最猛的几只」候选清单 —— 没有行业名就只能铺一个 150 只的大列表。
 * 行业名是**今天**的分类，拿它标注 2016 年的股票不算失真：行业归属本来就极少变。
 * 境外标的在快照里没有行业，下面会按市场名（港股/美股）分组，见 overseasIndustry。
 */
function loadIndustryMap(): Map<string, string> {
  const map = new Map<string, string>();
  const dataDir = join(ROOT, "data");
  if (!existsSync(dataDir)) return map;
  const latest = readdirSync(dataDir).filter((d) => /^snapshot_\d{8}$/.test(d)).sort().at(-1);
  if (!latest) return map;
  const path = join(dataDir, latest, "stocks.json");
  if (!existsSync(path)) return map;
  const list = JSON.parse(readFileSync(path, "utf8")) as Array<{ code?: string; industry?: string }>;
  for (const s of list) if (s.code && s.industry) map.set(s.code, s.industry);
  return map;
}

const industryOf = loadIndustryMap();

/**
 * 汇率：currency → 序列。文件名 USDCNY.json / HKDCNY.json。
 * 汇率和行情一样只存交易日，周末/节假日靠「取最后一个 ≤ 当天的值」顺延。
 */
function loadFx(): Map<Currency, FxSeries> {
  const map = new Map<Currency, FxSeries>();
  if (!existsSync(FX_CACHE)) return map;
  const pairs: Array<[string, Currency]> = [
    ["USDCNY", "USD"],
    ["HKDCNY", "HKD"],
  ];
  for (const [code, currency] of pairs) {
    const path = join(FX_CACHE, `${code}.json`);
    if (!existsSync(path)) continue;
    try {
      map.set(currency, JSON.parse(readFileSync(path, "utf-8")) as FxSeries);
    } catch {
      /* 坏文件就当没有，下面会报出来 */
    }
  }
  return map;
}

// ── 主日历与基准：用沪深300 的交易日 ─────────────────────────
const benchPath = join(CACHE, `${BENCHMARK_CODE}.json`);
if (!existsSync(benchPath)) {
  console.error(`没有找到基准指数缓存 ${benchPath}，先跑 fetch_history.py`);
  process.exit(1);
}
const bench = JSON.parse(readFileSync(benchPath, "utf-8")) as Series;
const calendar = bench.dates;
const calIndex = new Map(calendar.map((d, i) => [d, i]));
console.log(`主日历：${calendar.length} 个交易日 ${calendar[0]} → ${calendar[calendar.length - 1]}`);

const fx = loadFx();
const missingFx = (["USD", "HKD"] as Currency[]).filter((c) => !fx.has(c));
if (missingFx.length > 0) {
  console.warn(`⚠ 缺少汇率：${missingFx.join(" / ")}（跑 python3 packages/data/scripts/fetch_overseas.py --only FX）`);
  console.warn("  缺汇率的境外标的仍然会写进分片，但界面上折算不出来，会显示原币价格。");
}

// ── 每关的窗口 ──────────────────────────────────────────────
const useLevels = LEVELS.filter((l) => !onlyLevel || l.id === onlyLevel);
if (useLevels.length === 0) {
  console.error(`--level ${onlyLevel} 不在 LEVELS 里`);
  process.exit(1);
}

interface Window {
  level: (typeof LEVELS)[number];
  startIndex: number;
  dates: string[];
}
const windows: Window[] = useLevels.map((level) => {
  const startIndex = calIndex.get(level.startDate);
  if (startIndex === undefined) {
    console.error(`关卡 ${level.id} 的 startDate=${level.startDate} 不是交易日`);
    process.exit(1);
  }
  const dates = calendar.slice(startIndex, startIndex + level.days);
  if (dates.length < level.days) {
    console.error(`关卡 ${level.id} 的窗口超出日历末尾（要 ${level.days} 天，只剩 ${dates.length} 天）`);
    process.exit(1);
  }
  return { level, startIndex, dates };
});

// ── 逐只股票读一遍缓存，只留下各关窗口里的那几段 ──────────────
const files = readdirSync(CACHE).filter((f) => f.endsWith(".json") && f !== `${BENCHMARK_CODE}.json`);
console.log(`缓存 ${files.length} 只，开始切分（每关最多取 ${perLevel} 只）\n`);

interface Candidate {
  series: Series;
  market: string;
  currency: Currency;
  sliced: Series;
  prevClose: number | null;
  turnover: number;
  /** 窗口内外盘休市、靠前值填出来的天数（只有境外会 >0），用来在日志里报出来 */
  filled: number;
}

/** 每关收集候选 */
const buckets = new Map<string, Candidate[]>();
for (const w of windows) buckets.set(w.level.id, []);

let read = 0;
let skipped = 0;
/** 因为非正价格被挡掉的 [代码, 关卡, 个数] */
const rejectedNegative: Array<[string, string, number]> = [];

for (const file of files) {
  let raw: Series;
  try {
    raw = JSON.parse(readFileSync(join(CACHE, file), "utf-8")) as Series;
  } catch {
    skipped += 1;
    continue;
  }
  read += 1;

  const market: Market = raw.market ?? "SH"; // A 股缓存没有 market 字段
  const currency: Currency = raw.currency ?? "CNY";
  const overseas = market === "HK" || market === "US";
  const pos = new Map(raw.dates.map((d, i) => [d, i]));

  for (const w of windows) {
    let idx: number[];
    /** 外盘真的开门的天数（只有境外用得上） */
    let traded = 0;
    let filled = 0;

    if (overseas) {
      // 逐个日历日找「最后一个 ≤ 当天的外盘交易日」
      idx = w.dates.map((d) => lastIndexAtOrBefore(raw.dates, d));
      for (let k = 0; k < w.dates.length; k += 1) {
        const i = idx[k]!;
        if (i >= 0 && raw.dates[i] === w.dates[k]) traded += 1;
        else if (i >= 0) filled += 1;
      }
      // 判据必须是「外盘开门的天数」，不能用 close 数 —— close 被填充过，永远有值
      if (traded / w.dates.length < MIN_COVERAGE) continue; // 那个年代还没上市
    } else {
      idx = [];
      let missing = 0;
      for (const d of w.dates) {
        const i = pos.get(d);
        if (i === undefined) {
          missing += 1;
          idx.push(-1);
        } else {
          idx.push(i);
        }
      }
      if (missing / w.dates.length > MAX_MISSING_RATIO) continue; // 那个年代还没上市 / 长期停牌
    }

    /** 精确匹配取数：当天外盘没开门就是 null */
    const pick = <T>(arr: T[] | undefined): Array<T | null> =>
      idx.map((i, k) => (i < 0 || !arr ? null : raw.dates[i] === w.dates[k] ? (arr[i] ?? null) : null));

    /**
     * 向后填充取数：取「最后一个 ≤ 当天」的值，找不到才是 null。
     * A 股不走这条路（停牌就该是 null，不该拿停牌前的价冒充当天成交），
     * 只有境外的 close 用，理由见文件头 ①。
     */
    const carry = (arr: Array<number | null> | undefined): Array<number | null> =>
      idx.map((i) => (i < 0 || !arr ? null : (arr[i] ?? null)));

    const open = pick(raw.open);
    const close = overseas ? carry(raw.close) : pick(raw.close);
    const high = pick(raw.high);
    const low = pick(raw.low);
    const volume = pick(raw.volume);

    // 负价格守卫：挡在成交额计算之前，免得负成交额再污染排序
    const bad = nonPositiveCount([open, close, high, low]);
    if (bad > 0) {
      rejectedNegative.push([raw.code, w.level.id, bad]);
      continue;
    }

    // 日均成交额：收盘价 × 成交量。新浪的成交量单位是股，港股/美股按本币。
    // 休市日 volume 是 null，自然不计入（所以填充出来的 close 不会虚增成交额）。
    let sum = 0;
    let n = 0;
    for (let k = 0; k < close.length; k += 1) {
      const c = close[k];
      const v = volume[k];
      if (c != null && v != null) {
        sum += c * v;
        n += 1;
      }
    }
    if (n === 0) continue;

    // 窗口第一天没有「前一天」可比，可玩家进场那天就想看到当天的涨跌幅。
    // 缓存里有整段历史，顺手把窗口前一天的前复权收盘价也带上 ——
    // 一个数字，十个分片加起来几百字节。
    // 注意用严格早于窗口开头的那一天：境外的 idx[0] 可能落在窗口之前（休市填充），
    // 直接取 idx[0]-1 会取到窗口内的价，涨跌幅就成了 0。
    const beforeIdx = lastIndexBefore(raw.dates, w.dates[0]!);
    const prevClose = beforeIdx >= 0 ? (raw.close[beforeIdx] ?? null) : null;

    buckets.get(w.level.id)!.push({
      series: raw,
      market: overseas ? market : "CN",
      currency,
      prevClose,
      filled,
      sliced: { code: raw.code, name: raw.name, dates: w.dates, open, close, high, low, volume },
      turnover: sum / n,
    });
  }
}
console.log(`读取 ${read} 只（跳过 ${skipped} 个坏文件）\n`);

if (rejectedNegative.length > 0) {
  console.warn(`⚠ 因非正价格挡掉 ${rejectedNegative.length} 个「股票 × 关卡」组合（前复权把高股息老股扣成负数）：`);
  for (const [code, level, n] of rejectedNegative.slice(0, 12)) {
    console.warn(`    ${code} @ ${level}：${n} 个非正值`);
  }
  if (rejectedNegative.length > 12) console.warn(`    …… 另有 ${rejectedNegative.length - 12} 个`);
  console.warn("");
}

// ── 写分片 ──────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });

const summary: Array<Record<string, unknown>> = [];
for (const w of windows) {
  const all = buckets.get(w.level.id)!;

  // 按市场分组，各组内按成交额降序
  const byMarket = new Map<string, Candidate[]>();
  for (const c of all) {
    if (!byMarket.has(c.market)) byMarket.set(c.market, []);
    byMarket.get(c.market)!.push(c);
  }
  for (const list of byMarket.values()) list.sort((a, b) => b.turnover - a.turnover);

  // 先给港股/美股定额，用不完的名额还给 A 股 —— 这样总数恒定为 perLevel，
  // 而且 A 股不会被美股的高成交额顶掉。
  const picked: Candidate[] = [];
  for (const m of ["HK", "US"]) {
    const list = byMarket.get(m) ?? [];
    picked.push(...list.slice(0, MARKET_QUOTA[m] ?? 0));
  }
  const quotaLeft = Math.max(0, perLevel - picked.length);
  picked.push(...(byMarket.get("CN") ?? []).slice(0, quotaLeft));

  // 输出顺序按市场排（A 股在前），组内保持成交额降序
  picked.sort((a, b) => {
    const d = MARKET_ORDER.indexOf(a.market) - MARKET_ORDER.indexOf(b.market);
    return d !== 0 ? d : b.turnover - a.turnover;
  });

  const benchClose = w.dates.map((d) => {
    const i = calIndex.get(d);
    return i === undefined ? null : (bench.close[i] ?? null);
  });

  // 汇率序列与 calendar 等长，供界面把外币价格折成人民币
  const fxAligned = (["USD", "HKD"] as Currency[])
    .filter((c) => fx.has(c))
    .map((c) => {
      const series = fx.get(c)!;
      return {
        currency: c,
        code: series.code,
        name: series.name,
        rate: w.dates.map((d) => {
          const i = lastIndexAtOrBefore(series.dates, d);
          return i < 0 ? null : (series.rate[i] ?? null);
        }),
      };
    });

  const shard = {
    levelId: w.level.id,
    startDate: w.level.startDate,
    days: w.level.days,
    calendar: w.dates,
    benchmark: { code: BENCHMARK_CODE, name: bench.name, close: benchClose },
    instruments: picked.map((p) => ({
      code: p.sliced.code,
      name: p.sliced.name,
      isST: (p.series as unknown as { isST?: boolean }).isST ?? p.sliced.name.includes("ST"),
      /**
       * 境外标的没有申万行业，用市场名（港股/美股）顶上。
       * 不是编一个行业，而是为了让「各板块涨得最猛的几只」那张候选清单
       * 能把它们单独成组；留空的话所有境外标的都会挤进「其他」。
       */
      industry: industryOf.get(p.sliced.code) ?? (p.market === "CN" ? "" : (MARKET_LABEL[p.market as Market] ?? "")),
      /** "CN" / "HK" / "US"，规则按市场分（涨跌停、T+1、印花税都不一样） */
      market: p.market,
      currency: p.currency,
      /** 窗口前一天的收盘价，只有第一天用得上 */
      prevClose: p.prevClose,
      open: p.sliced.open,
      close: p.sliced.close,
      high: p.sliced.high,
      low: p.sliced.low,
      volume: p.sliced.volume,
    })),
    /** 与 calendar 等长；取不到就是 null，界面不要按 1:1 顶上 */
    fx: fxAligned,
    note: "价格为新新浪源前复权价（用今天的复权因子回算），收益连续但不是当年的盘面绝对价位。港股/美股按各自本币计价，界面按当日中行折算价折成人民币记账。",
    generatedAt: new Date().toISOString(),
  };

  const path = join(OUT, `level-${w.level.id}.json`);
  writeFileSync(path, JSON.stringify(shard));
  const kb = statSync(path).size / 1024;

  const b0 = benchClose[0];
  const bN = benchClose[benchClose.length - 1];
  const benchRet = b0 && bN ? ((bN / b0 - 1) * 100).toFixed(2) : "?";
  const nCn = picked.filter((p) => p.market === "CN").length;
  const nHk = picked.filter((p) => p.market === "HK").length;
  const nUs = picked.filter((p) => p.market === "US").length;
  const filledDays = picked.reduce((n, p) => n + p.filled, 0);
  console.log(
    `  ${String(w.level.order).padStart(2)}. ${w.level.id}  候选 ${String(all.length).padStart(3)} 只 → 取 ${String(picked.length).padStart(3)} 只` +
      `（A ${nCn} / 港 ${nHk} / 美 ${nUs}，休市填充 ${filledDays} 处）  ${kb.toFixed(0)} KB  基准 ${benchRet}%`,
  );
  summary.push({
    levelId: w.level.id,
    order: w.level.order,
    candidates: all.length,
    picked: picked.length,
    cn: nCn,
    hk: nHk,
    us: nUs,
    filledDays,
    benchmarkReturnPct: Number(benchRet),
    bytes: statSync(path).size,
  });
}

const totalBytes = summary.reduce((n, s) => n + (s.bytes as number), 0);
console.log(`\n写到 ${OUT}：${summary.length} 个分片，合计 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
console.log("提示：发布到网页还要跑 node packages/data/scripts/sync_web_data.mjs");

// 一份清单，网页用它判断「站点里到底发布了哪几关」。
// 没有它的话，前端就只能靠「试拉一关、失败了算是没有」来判断，白白下载几百 KB。
const indexPath = join(OUT, "index.json");
writeFileSync(
  indexPath,
  JSON.stringify({ levels: summary.map((s) => s.levelId), generatedAt: new Date().toISOString() }),
);
console.log(`清单：${indexPath}`);
