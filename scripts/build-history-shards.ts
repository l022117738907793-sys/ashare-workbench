#!/usr/bin/env node
/**
 * 把 data/history-cache/ 的深历史切成传奇模式要用的关卡分片。
 *
 * 为什么要有这一步，而不是让网页直接读缓存：
 * - 缓存是 619 只 × 9 年（2244 根）× 5 个字段，**六十多兆**，不可能发给浏览器；
 * - 一个关卡其实只用到其中 26 天、一百多只股票，切出来一份大约一百多 KB。
 *
 * 每只股票在这 26 天里必须有 ≥90% 的交易日有收盘价，否则这只票在那个年代还没上市
 * （或者长期停牌），直接不进这一关的股票池。
 *
 * 选股规则：**按窗口内的日均成交额（收盘价 × 成交量）从大到小取前 N 只**。
 * 用成交额而不是市值/权重，是因为「当时成交最活跃的那批股票」是可以从数据里算出来的，
 * 而历史权重我们拿不到 —— 拿今天的权重去排 2016 年的股票池才是真的错。
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
const OUT = join(ROOT, "data", "history");
const BENCHMARK_CODE = "000300.SH";

interface Series {
  code: string;
  name: string;
  dates: string[];
  open: Array<number | null>;
  close: Array<number | null>;
  high: Array<number | null>;
  low: Array<number | null>;
  volume: Array<number | null>;
}

function argValue(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
function argString(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

if (!existsSync(CACHE)) {
  console.error(`没有找到 ${CACHE}`);
  console.error("先跑：python3 packages/data/scripts/fetch_history.py");
  process.exit(1);
}

const perLevel = argValue("--per-level", 150);
const onlyLevel = argString("--level");

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

/** 每关收集 [股, 该股在窗口内的切片, 日均成交额] */
const buckets = new Map<string, Array<{ series: Series; sliced: Series; turnover: number }>>();
for (const w of windows) buckets.set(w.level.id, []);

let read = 0;
let skipped = 0;
for (const file of files) {
  let raw: Series;
  try {
    raw = JSON.parse(readFileSync(join(CACHE, file), "utf-8")) as Series;
  } catch {
    skipped += 1;
    continue;
  }
  read += 1;
  const pos = new Map(raw.dates.map((d, i) => [d, i]));

  for (const w of windows) {
    const idx: number[] = [];
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
    if (missing / w.dates.length > 0.1) continue; // 那个年代还没上市 / 长期停牌

    const pick = <T>(arr: T[] | undefined): Array<T | null> =>
      idx.map((i) => (i < 0 || !arr ? null : (arr[i] ?? null)));

    const close = pick(raw.close);
    const volume = pick(raw.volume);
    // 日均成交额：收盘价 × 成交量。新浪的成交量单位是股。
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

    buckets.get(w.level.id)!.push({
      series: raw,
      sliced: {
        code: raw.code,
        name: raw.name,
        dates: w.dates,
        open: pick(raw.open),
        close,
        high: pick(raw.high),
        low: pick(raw.low),
        volume,
      },
      turnover: sum / n,
    });
  }
}
console.log(`读取 ${read} 只（跳过 ${skipped} 个坏文件）\n`);

// ── 写分片 ──────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });

const summary: Array<Record<string, unknown>> = [];
for (const w of windows) {
  const all = buckets.get(w.level.id)!;
  all.sort((a, b) => b.turnover - a.turnover);
  const picked = all.slice(0, perLevel);

  const benchClose = w.dates.map((d) => {
    const i = calIndex.get(d);
    return i === undefined ? null : (bench.close[i] ?? null);
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
      open: p.sliced.open,
      close: p.sliced.close,
      high: p.sliced.high,
      low: p.sliced.low,
      volume: p.sliced.volume,
    })),
    note: "价格为新新浪源前复权价（用今天的复权因子回算），收益连续但不是当年的盘面绝对价位。",
    generatedAt: new Date().toISOString(),
  };

  const path = join(OUT, `level-${w.level.id}.json`);
  writeFileSync(path, JSON.stringify(shard));
  const kb = statSync(path).size / 1024;

  const b0 = benchClose[0];
  const bN = benchClose[benchClose.length - 1];
  const benchRet = b0 && bN ? ((bN / b0 - 1) * 100).toFixed(2) : "?";
  console.log(
    `  ${String(w.level.order).padStart(2)}. ${w.level.id}  候选 ${String(all.length).padStart(3)} 只 → 取 ${String(picked.length).padStart(3)} 只  ${kb.toFixed(0)} KB  基准 ${benchRet}%`,
  );
  summary.push({
    levelId: w.level.id,
    order: w.level.order,
    candidates: all.length,
    picked: picked.length,
    benchmarkReturnPct: Number(benchRet),
    bytes: statSync(path).size,
  });
}

const totalBytes = summary.reduce((n, s) => n + (s.bytes as number), 0);
console.log(`\n写到 ${OUT}：${summary.length} 个分片，合计 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

// 一份清单，网页用它判断「站点里到底发布了哪几关」。
// 没有它的话，前端就只能靠「试拉一关、失败了算是没有」来判断，白白下载几百 KB。
const indexPath = join(OUT, "index.json");
writeFileSync(
  indexPath,
  JSON.stringify({ levels: summary.map((s) => s.levelId), generatedAt: new Date().toISOString() }),
);
console.log(`清单：${indexPath}`);
