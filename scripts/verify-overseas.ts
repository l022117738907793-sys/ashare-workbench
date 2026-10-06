/**
 * 体检：把抓到的境外标的对齐到某一关的日历上，看看覆盖率够不够。
 *
 * 为什么要有这个脚本：境外标的的「缺」有两种（外盘休市 / 标的还没上市），
 * 分片一旦生成就看不出来了 —— 分片里只有 null，没有原因。所以在合并**之前**
 * 先跑一遍，把「这只股票在窗口里有多少天是真的开门」摆出来。
 *
 * 用法：
 *   npx vite-node scripts/verify-overseas.ts                # 用第一关的日历
 *   npx vite-node scripts/verify-overseas.ts 2022-04-25     # 指定关卡
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  alignOverseasToCalendar,
  coverage,
  fxRateOn,
  nonPositiveCount,
  type FxSeries,
  type OverseasSeries,
} from "../packages/data/src/overseas";

const ROOT = process.cwd();
const CACHE = join(ROOT, "data", "history-cache");
const FX = join(ROOT, "data", "fx-cache");
const HISTORY = join(ROOT, "apps", "web", "public", "history");

/** 低于这个覆盖率就不要这只标的 —— 剩下的天数不足以让玩家做判断 */
const MIN_COVERAGE = 0.8;

const wanted = process.argv[2];
const indexRaw = JSON.parse(readFileSync(join(HISTORY, "index.json"), "utf-8")) as { levels: string[] };
const levelId = wanted && indexRaw.levels.includes(wanted) ? wanted : indexRaw.levels[0]!;
const shard = JSON.parse(readFileSync(join(HISTORY, `level-${levelId}.json`), "utf-8")) as {
  calendar: string[];
  instruments: Array<{ code: string }>;
};

console.log(`关卡 ${levelId}：${shard.calendar.length} 天 ${shard.calendar[0]} → ${shard.calendar.at(-1)}`);
console.log(`现有标的 ${shard.instruments.length} 只\n`);

const files = readdirSync(CACHE).filter((f) => /\.(HK|US)\.json$/.test(f));
const byMarket = new Map<string, OverseasSeries[]>();
for (const f of files) {
  const s = JSON.parse(readFileSync(join(CACHE, f), "utf-8")) as OverseasSeries;
  const list = byMarket.get(s.market) ?? [];
  list.push(s);
  byMarket.set(s.market, list);
}

let totalStale = 0;
let totalClosed = 0;
const rejected: string[] = [];
const badPrices: string[] = [];

for (const market of ["HK", "US"]) {
  const list = (byMarket.get(market) ?? []).sort((a, b) => a.code.localeCompare(b.code));
  console.log(`── ${market}（${list.length} 只）`);
  for (const s of list) {
    const a = alignOverseasToCalendar(s, shard.calendar);
    const cov = coverage(s, shard.calendar);
    const neg = nonPositiveCount(a);
    totalStale += a.staleDays;
    totalClosed += a.closedDays;
    // 两种「不要」是不同的问题，要分开报：覆盖率不够 = 历史太短，
    // 有非正价格 = 前复权把股息扣穿了，数据本身是坏的（见 overseas.ts 的注释）。
    const flags: string[] = [];
    if (cov < MIN_COVERAGE) {
      flags.push("覆盖率不够");
      rejected.push(s.code);
    }
    if (neg > 0) {
      flags.push(`有 ${neg} 个非正价格`);
      badPrices.push(s.code);
    }
    const flag = flags.length ? `  ✗ ${flags.join(" · ")}` : "";
    console.log(
      `  ${s.code.padEnd(11)} ${s.name.padEnd(8)} 覆盖 ${(cov * 100).toFixed(0).padStart(3)}%  ` +
        `休市 ${String(a.closedDays).padStart(2)} 天  首日 ${String(a.close[0] ?? "—").padStart(8)}  ` +
        `prevClose ${String(a.prevClose ?? "—").padStart(8)}${flag}`,
    );
  }
  console.log("");
}

console.log(`合计：休市填充 ${totalStale} 处，其中 ${totalClosed} 处是「外盘关门但 A 股开着」`);
if (badPrices.length) {
  console.log(`\n⚠ 前复权扣穿成负数的标的（${badPrices.length} 只）：${badPrices.join(", ")}`);
  console.log("这些必须挡掉。负价格进引擎不报错，只会把涨跌幅和结算算出一堆看不懂的数。");
}
if (rejected.length) {
  console.log(`\n覆盖率不足 ${MIN_COVERAGE * 100}% 的标的（${rejected.length} 只）：${rejected.join(", ")}`);
  console.log("这些不会进分片。不是错，是那只股票在这个窗口里还没有足够的历史。");
}

// 汇率：确认窗口内每一天都取得到价
for (const pair of ["USDCNY", "HKDCNY"]) {
  let fx: FxSeries;
  try {
    fx = JSON.parse(readFileSync(join(FX, `${pair}.json`), "utf-8")) as FxSeries;
  } catch {
    console.log(`\n汇率 ${pair}：没有缓存，先跑 fetch_overseas.py --only FX`);
    continue;
  }
  const missing = shard.calendar.filter((d) => fxRateOn(fx, d) == null);
  const first = fxRateOn(fx, shard.calendar[0]!);
  const last = fxRateOn(fx, shard.calendar.at(-1)!);
  console.log(
    `\n汇率 ${pair}：${fx.dates.length} 档 ${fx.dates[0]} → ${fx.dates.at(-1)}；` +
      `窗口内 ${first} → ${last}` +
      (missing.length ? `  ⚠ ${missing.length} 天取不到（${missing[0]} 起）` : "  每一天都取得到"),
  );
}
