/**
 * 历史回放压测（walk-forward）。
 *
 * 目的：现有快照含 120 个交易日 × 92 只个股的真实历史。与其"等几天再跑"，
 * 不如**逐日回放**——对每个历史交易日 D，只用 [0, D] 的数据跑一遍完整链路
 * （四层漏斗 + 信号），再看 D 之后 5/10/20 日的实际涨跌。
 *
 * 这能一次回答三个问题：
 *   1. 引擎在 120 种不同的市场状态下会不会崩、会不会大面积"数据不足"？
 *   2. 买入/卖出信号之后的实际走势是否有区分度？
 *   3. 有没有边界 bug（空序列、极端值、NaN）只在特定日子才暴露？
 *
 * 注意：这是**行为压测，不是投资建议**。样本只有 92 只、约 60 个可回放日，
 * 统计意义有限；结论只用于检查引擎是否自洽，不能当作策略有效性证明。
 *
 *   npx vite-node scripts/backtest.ts [快照目录]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeMarket,
  analyzeSector,
  type Maybe,
  type Snapshot,
  type SeriesData,
  type StockData,
} from "../packages/core/src/engine";
import { deriveSignal, SIGNAL_ORDER, type SignalAction } from "../packages/core/src/signal";
import rules from "../packages/core/rules.json";

const ROOT = process.cwd();
const DATA = join(ROOT, "data");

/** 回看窗口：引擎要求至少 60 个交易日 */
const MIN_DAYS = 60;
/** 前瞻窗口 */
const HORIZONS = [5, 10, 20] as const;

function pickDir(arg?: string): string {
  if (arg) return join(ROOT, arg);
  const dirs = readdirSync(DATA).filter((d) => d.startsWith("snapshot_")).sort();
  if (dirs.length === 0) throw new Error("没有快照，先跑 fetch_snapshot.py");
  return join(DATA, dirs.at(-1)!);
}

const dir = pickDir(process.argv[2]);
const j = <T>(f: string): T => JSON.parse(readFileSync(join(dir, f), "utf-8"));

const full: Snapshot = {
  indices: j("indices.json"),
  sectors: j("sectors.json"),
  stocks: j("stocks.json"),
  etfs: j("etfs.json"),
};
const calendar = j<string[]>("calendar.json");

/** 把序列截断到 [0, upto]（含），模拟"站在第 upto 天收盘时"的信息集 */
function cut<T extends SeriesData>(s: T, upto: number): T {
  const n = upto + 1;
  return {
    ...s,
    close: s.close.slice(0, n),
    high: s.high.slice(0, n),
    low: s.low.slice(0, n),
    volume: s.volume.slice(0, n),
  };
}

function truncate(upto: number): Snapshot {
  return {
    indices: full.indices.map((s) => cut(s, upto)),
    sectors: full.sectors.map((s) => cut(s, upto)),
    stocks: full.stocks.map((s) => cut(s, upto)),
    etfs: full.etfs.map((s) => cut(s, upto)),
  };
}

/** 从第 from 天算起的 k 日前瞻收益 %；越界或缺失返回 null */
function forwardReturn(close: Maybe[], from: number, k: number): number | null {
  const to = from + k;
  if (to >= close.length) return null;
  const a = close[from];
  const b = close[to];
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return (b / a - 1) * 100;
}

interface Sample {
  date: string;
  code: string;
  name: string;
  action: SignalAction;
  strength: number;
  marketState: string;
  /** 每个前瞻窗口的收益 */
  fwd: Record<number, number | null>;
}

const samples: Sample[] = [];
const perDay: Array<{ date: string; market: string; counts: Record<string, number>; insufficient: number }> = [];
let errors = 0;
const errorMessages: string[] = [];

console.log(`\n快照: ${dir.split("/").pop()}  交易日 ${calendar.length} 天`);
console.log(`回放区间: 第 ${MIN_DAYS} 天起（引擎需要 ≥${MIN_DAYS} 日）至倒数第 1 天\n`);

const started = Date.now();

for (let d = MIN_DAYS; d < calendar.length; d += 1) {
  const date = calendar[d];
  const snap = truncate(d);

  let market: ReturnType<typeof analyzeMarket>;
  try {
    market = analyzeMarket(snap, rules as never);
  } catch (e) {
    errors += 1;
    errorMessages.push(`${date} analyzeMarket: ${e instanceof Error ? e.message : e}`);
    continue;
  }

  const byCode = new Map(snap.stocks.map((s) => [s.code, s] as const));
  const counts: Record<string, number> = {};
  let insufficient = 0;

  for (const s of snap.stocks) {
    try {
      const sig = deriveSignal(s, rules as never);
      counts[sig.action] = (counts[sig.action] ?? 0) + 1;
      if (sig.action === "观望") insufficient += 1;

      // 信号强度为 0 或观望的不纳入质量统计（没有方向）
      if (sig.action === "观望") continue;

      const fwd: Record<number, number | null> = {};
      for (const k of HORIZONS) fwd[k] = forwardReturn(full.stocks.find((x) => x.code === s.code)!.close, d, k);

      samples.push({
        date,
        code: s.code,
        name: s.name,
        action: sig.action,
        strength: sig.strength,
        marketState: market.state,
        fwd,
      });
    } catch (e) {
      errors += 1;
      if (errorMessages.length < 10) {
        errorMessages.push(`${date} ${s.code}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // 板块层也跑一遍，确保不崩
  try {
    for (const sec of snap.sectors) analyzeSector(sec, byCode as Map<string, StockData>, rules as never);
  } catch (e) {
    errors += 1;
    errorMessages.push(`${date} analyzeSector: ${e instanceof Error ? e.message : e}`);
  }

  perDay.push({ date, market: market.state, counts, insufficient });
}

const elapsed = Date.now() - started;

// ── 报告 ──────────────────────────────────────────────────────
console.log(`回放完成：${perDay.length} 个交易日，耗时 ${elapsed} ms\n`);

// 防退化警告：CI 每日生成的快照是 120 天，会让回放悄悄退回小样本。
// 这种"结论因数据变少而改变"的情况必须显式提示，否则没人会注意到。
if (perDay.length < 100) {
  console.log(
    `⚠️  可回放天数仅 ${perDay.length} 天（建议 ≥500）。20 日前瞻的独立窗口只有 ` +
      `${Math.floor(perDay.length / 20)} 个，统计上不足以判断信号质量。\n` +
      "   当前快照可能是 CI 默认深度（120 天）。请先生成长历史快照：\n" +
      "     python3 packages/data/scripts/fetch_snapshot.py --days 650\n",
  );
}

// 样本深度足够时，明确说清楚结论的可信度前提
if (perDay.length >= 500) {
  console.log(
    `样本深度充足（${perDay.length} 天，独立窗口约 ${Math.floor(perDay.length / 20)} 个），` +
      "下述统计量具备参考价值。\n",
  );
}

console.log("【1】引擎健壮性");
const crash = errors === 0;
console.log(`  ${crash ? "✓" : "✗"} 异常数: ${errors}${crash ? "（无崩溃）" : ""}`);
for (const m of errorMessages) console.log(`      · ${m}`);

const insufficientHeavy = perDay.filter((p) => p.insufficient > 20);
console.log(
  `  ${insufficientHeavy.length === 0 ? "✓" : "!"} 观望数 >20 的交易日: ${insufficientHeavy.length} / ${perDay.length}` +
    (insufficientHeavy.length ? `（如 ${insufficientHeavy[0].date} 有 ${insufficientHeavy[0].insufficient} 只）` : ""),
);

// 每天都有信号产出
const emptyDays = perDay.filter((p) => Object.keys(p.counts).length === 0);
console.log(`  ${emptyDays.length === 0 ? "✓" : "✗"} 空信号交易日: ${emptyDays.length}`);

// 强度合法性
const badStrength = samples.filter((s) => !Number.isInteger(s.strength) || s.strength < 0 || s.strength > 100);
console.log(`  ${badStrength.length === 0 ? "✓" : "✗"} 强度越界样本: ${badStrength.length}`);

// ── 基准：同期全池平均前瞻收益（判断"跑赢/跑输"，而不是只看绝对值）──
const baseline: Record<number, number | null> = {};
for (const k of HORIZONS) {
  const vals: number[] = [];
  for (let d = MIN_DAYS; d < calendar.length; d += 1) {
    for (const s of full.stocks) {
      const v = forwardReturn(s.close, d, k);
      if (v !== null) vals.push(v);
    }
  }
  baseline[k] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

// 指数同期表现（市场环境）
const hs300 = full.indices.find((i) => i.code === "000300.SH");
const idxStart = hs300?.close[MIN_DAYS] ?? null;
const idxEnd = hs300?.close[calendar.length - 1] ?? null;
const idxReturn =
  idxStart !== null && idxEnd !== null && idxStart !== 0 ? ((idxEnd / idxStart - 1) * 100) : null;

console.log("\n【1.5】市场环境（回放区间）");
console.log(
  `  沪深300: ${idxStart === null ? "—" : idxStart.toFixed(2)} → ${idxEnd === null ? "—" : idxEnd.toFixed(2)}` +
    `  ${idxReturn === null ? "" : (idxReturn >= 0 ? "+" : "") + idxReturn.toFixed(2) + "%"}`,
);
console.log(
  "  全池等权基准: " +
    HORIZONS.map((k) => `+${k}日 ${baseline[k] === null ? "—" : ((baseline[k]! >= 0 ? "+" : "") + baseline[k]!.toFixed(2) + "%")}`).join("  "),
);

console.log("\n【2】各市场状态下的信号分布");
const byMarket = new Map<string, Record<string, number>>();
for (const p of perDay) {
  const acc = byMarket.get(p.market) ?? {};
  for (const [k, v] of Object.entries(p.counts)) acc[k] = (acc[k] ?? 0) + v;
  byMarket.set(p.market, acc);
}
for (const [state, acc] of byMarket) {
  const total = Object.values(acc).reduce((a, b) => a + b, 0);
  const days = perDay.filter((p) => p.market === state).length;
  const parts = SIGNAL_ORDER.filter((a) => acc[a]).map((a) => `${a} ${((acc[a] / total) * 100).toFixed(0)}%`);
  console.log(`  ${state.padEnd(6)}（${days} 天，${total} 个信号）: ${parts.join(" / ")}`);
}

console.log("\n【3】信号质量（前瞻收益，%）");
console.log(`  样本 ${samples.length} 个（已剔除观望）\n`);
console.log("  动作      样本   " + HORIZONS.map((k) => `+${k}日均值`).join("  ") + "   +10日胜率   +10日超额");
for (const action of SIGNAL_ORDER) {
  const group = samples.filter((s) => s.action === action);
  if (group.length === 0) continue;
  const cells = HORIZONS.map((k) => {
    const vals = group.map((s) => s.fwd[k]).filter((v): v is number => v !== null);
    if (vals.length === 0) return "     —     ";
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return `${mean >= 0 ? "+" : ""}${mean.toFixed(2)}%`.padStart(9);
  });
  const win = group.map((s) => s.fwd[10]).filter((v): v is number => v !== null);
  const winRate = win.length ? ((win.filter((v) => v > 0).length / win.length) * 100).toFixed(0) + "%" : "—";
  // 关键：与基准比，而不是与 0 比
  const mean10 = win.length ? win.reduce((a, b) => a + b, 0) / win.length : null;
  const excess = mean10 !== null && baseline[10] !== null ? mean10 - baseline[10] : null;
  console.log(
    `  ${action.padEnd(8)} ${String(group.length).padStart(5)}   ${cells.join("  ")}   ${winRate.padStart(8)}` +
      `   ${excess === null ? "—" : (excess >= 0 ? "+" : "") + excess.toFixed(2) + "pp"}`,
  );
}

console.log("\n【4】强度分组（+10 日均值）");
const buckets: Array<[string, (s: Sample) => boolean]> = [
  ["强度 ≥80", (s) => s.strength >= 80],
  ["强度 60-79", (s) => s.strength >= 60 && s.strength < 80],
  ["强度 40-59", (s) => s.strength >= 40 && s.strength < 60],
  ["强度 <40", (s) => s.strength < 40],
];
for (const [label, pred] of buckets) {
  const g = samples.filter(pred);
  const vals = g.map((s) => s.fwd[10]).filter((v): v is number => v !== null);
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  console.log(
    `  ${label.padEnd(11)} 样本 ${String(g.length).padStart(5)}   +10日均值 ${mean === null ? "—" : (mean >= 0 ? "+" : "") + mean.toFixed(2) + "%"}`,
  );
}

console.log("\n【5】买入信号 vs 卖出信号（方向性检验）");
const buys = samples.filter((s) => s.action === "买入" || s.action === "增持");
const sells = samples.filter((s) => s.action === "卖出" || s.action === "减持");
for (const k of HORIZONS) {
  const bv = buys.map((s) => s.fwd[k]).filter((v): v is number => v !== null);
  const sv = sells.map((s) => s.fwd[k]).filter((v): v is number => v !== null);
  const bm = bv.length ? bv.reduce((a, b) => a + b, 0) / bv.length : null;
  const sm = sv.length ? sv.reduce((a, b) => a + b, 0) / sv.length : null;
  const spread = bm !== null && sm !== null ? bm - sm : null;
  console.log(
    `  +${String(k).padStart(2)}日: 看多 ${bm === null ? "—" : (bm >= 0 ? "+" : "") + bm.toFixed(2) + "%"}` +
      `   看空 ${sm === null ? "—" : (sm >= 0 ? "+" : "") + sm.toFixed(2) + "%"}` +
      `   价差 ${spread === null ? "—" : (spread >= 0 ? "+" : "") + spread.toFixed(2) + "pp"}` +
      `   ${spread !== null && spread > 0 ? "✓ 看多优于看空" : "✗ 看多劣于看空"}`,
  );
}

// ── 统计显著性：分块自助法 ────────────────────────────────────
//
// 为什么必须做这一步：样本按"交易日 × 个股"统计有 5520 个，但
//   (1) 相邻交易日的信号几乎相同（20 日前瞻窗口高度重叠）；
//   (2) 92 只个股同涨同跌（同属一个市场，相关性极高）。
// 直接对这些样本做 t 检验会把有效样本量高估一到两个数量级。
// 分块自助法按"连续日期块"重采样，保留了块内的自相关结构，
// 得到的区间更接近真实不确定性（仍然乐观，因为它没处理个股间相关）。
function blockBootstrapSpread(
  byDate: Array<{ date: string; bull: number[]; bear: number[] }>,
  blockLen: number,
  iterations: number,
): { lo: number; hi: number; mid: number } | null {
  const days = byDate.filter((d) => d.bull.length > 0 || d.bear.length > 0);
  if (days.length < blockLen * 2) return null;

  const nBlocks = Math.floor(days.length / blockLen);
  const spreads: number[] = [];

  for (let it = 0; it < iterations; it += 1) {
    const bull: number[] = [];
    const bear: number[] = [];
    for (let b = 0; b < nBlocks; b += 1) {
      // 随机取一个连续块（起点对齐到 blockLen 的倍数，保证块完整）
      const start = Math.floor(Math.random() * (days.length - blockLen + 1));
      for (let i = start; i < start + blockLen; i += 1) {
        bull.push(...days[i].bull);
        bear.push(...days[i].bear);
      }
    }
    if (bull.length === 0 || bear.length === 0) continue;
    const bm = bull.reduce((a, x) => a + x, 0) / bull.length;
    const sm = bear.reduce((a, x) => a + x, 0) / bear.length;
    spreads.push(bm - sm);
  }

  if (spreads.length < 50) return null;
  spreads.sort((a, b) => a - b);
  const q = (p: number) => spreads[Math.min(spreads.length - 1, Math.floor(p * spreads.length))];
  return { lo: q(0.025), hi: q(0.975), mid: spreads[Math.floor(spreads.length / 2)] };
}

console.log("\n【6】统计显著性检验（分块自助法，块长 10 日 × 2000 次重采样）");
console.log("  H0：看多与看空的前瞻收益无差异。若区间跨越 0，则不能拒绝 H0。\n");

for (const k of HORIZONS) {
  const byDate: Array<{ date: string; bull: number[]; bear: number[] }> = [];
  for (let d = MIN_DAYS; d < calendar.length; d += 1) {
    const day = calendar[d];
    const bull: number[] = [];
    const bear: number[] = [];
    for (const s of full.stocks) {
      const v = forwardReturn(s.close, d, k);
      if (v === null) continue;
      const snapStock = cut(s, d);
      let action: SignalAction;
      try {
        action = deriveSignal(snapStock, rules as never).action;
      } catch {
        continue;
      }
      if (action === "买入" || action === "增持") bull.push(v);
      else if (action === "卖出" || action === "减持") bear.push(v);
    }
    byDate.push({ date: day, bull, bear });
  }

  const ci = blockBootstrapSpread(byDate, 10, 2000);
  if (ci === null) {
    console.log(`  +${k}日: 样本不足以做分块自助（需要至少 ${10 * 2} 个交易日）`);
    continue;
  }
  const crossesZero = ci.lo <= 0 && ci.hi >= 0;
  console.log(
    `  +${String(k).padStart(2)}日  价差中位数 ${(ci.mid >= 0 ? "+" : "") + ci.mid.toFixed(2)}pp` +
      `  95% 区间 [${(ci.lo >= 0 ? "+" : "") + ci.lo.toFixed(2)}, ${(ci.hi >= 0 ? "+" : "") + ci.hi.toFixed(2)}]pp` +
      `  ${crossesZero ? "→ 跨 0，不能拒绝 H0" : "→ 不跨 0，差异显著"}`,
  );
}

// ── 逐日方向检验：最直观也最不依赖分布假设 ────────────────────
//
// 把每个交易日当作一个独立观测（n = 回放天数），比较当天的
// 看多组均值与看空组均值。这同时规避了"个股相关性"与"样本重叠"
// 带来的虚假精度——虽然 20 日窗口仍有重叠，但每个日期只贡献一个数。
console.log("\n【6.5】逐日方向检验（把每天当作一个观测）\n");
for (const k of HORIZONS) {
  let bullWins = 0;
  let bearWins = 0;
  let ties = 0;
  const diffs: number[] = [];
  for (let d = MIN_DAYS; d < calendar.length; d += 1) {
    const bull: number[] = [];
    const bear: number[] = [];
    for (const s of full.stocks) {
      const v = forwardReturn(s.close, d, k);
      if (v === null) continue;
      let action: SignalAction;
      try {
        action = deriveSignal(cut(s, d), rules as never).action;
      } catch {
        continue;
      }
      if (action === "买入" || action === "增持") bull.push(v);
      else if (action === "卖出" || action === "减持") bear.push(v);
    }
    if (bull.length === 0 || bear.length === 0) continue;
    const diff =
      bull.reduce((a, x) => a + x, 0) / bull.length - bear.reduce((a, x) => a + x, 0) / bear.length;
    diffs.push(diff);
    if (diff > 0.05) bullWins += 1;
    else if (diff < -0.05) bearWins += 1;
    else ties += 1;
  }
  const n = diffs.length;
  if (n === 0) {
    console.log(`  +${k}日: 无有效观测`);
    continue;
  }
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const se = sd / Math.sqrt(n);
  const t = se > 0 ? mean / se : 0;
  const pct = ((bearWins / n) * 100).toFixed(0);
  // 重叠校正：h 日前瞻收益按日采样时，相邻观测共享 h-1/h 的窗口，
  // 均值的方差约被放大 h 倍（**仅在随机游走、等间隔、无自相关假设下成立**），
  // 故此处给出 t/√h 作为**粗略的下界参考**，而不是有效方差估计。
  // 更严格的做法是 HAC/Newey-West 或按日期聚类，或直接用非重叠窗口（见【8】）。
  const tAdj = t / Math.sqrt(k);
  const verdict = Math.abs(tAdj) >= 1.96 ? "显著" : "不显著";
  console.log(
    `  +${String(k).padStart(2)}日  有效天数 ${String(n).padStart(2)}` +
      `  看多占优 ${String(bullWins).padStart(2)} 天 / 看空占优 ${String(bearWins).padStart(2)} 天` +
      `  看空占优 ${pct}%  均值差 ${(mean >= 0 ? "+" : "") + mean.toFixed(2)}pp` +
      `  t=${t.toFixed(2)} → 重叠校正后 t≈${tAdj.toFixed(2)}（${verdict}）`,
  );
}
console.log("\n  读法：「看空占优比例」高于 50% 说明该区间内信号方向与市场相反。");
console.log("        但必须看**校正后**的 t：20 日窗口的重叠会把 t 高估约 4.5 倍，");
console.log("        未校正的 t=-5 看似极显著，校正后往往就落在临界值附近。");

// ── 数据质量：null / 停牌导致的删样 ────────────────────────────
//
// forwardReturn 遇到任一端为 null 就丢弃样本。如果停牌与走势相关
// （例如暴跌后停牌），这就是**非随机删样**，会系统性扭曲统计量。
// 因此必须把删样率报出来，而不是假装样本完整。
console.log("\n【8】数据质量：两种「样本减少」必须区分开\n");
console.log("  易混淆点：样本从 5520 降到 3680 并不等于「停牌删样」。两者性质完全不同：");
console.log("    (a) 边界截断——起点靠近序列末尾时 d+k 越界，属于**数据不足**，不是偏差；");
console.log("    (b) 缺失删样——序列中段存在 null（停牌）而被丢弃，**这才是潜在的非随机删样**。\n");

for (const k of HORIZONS) {
  let total = 0;
  let boundary = 0;
  let missing = 0;
  for (let d = MIN_DAYS; d < calendar.length; d += 1) {
    for (const s of full.stocks) {
      total += 1;
      const to = d + k;
      const a = s.close[d];
      const b = to < s.close.length ? s.close[to] : undefined;
      if (to >= s.close.length) boundary += 1;
      else if (a === null || b === null) missing += 1;
    }
  }
  console.log(
    `  +${String(k).padStart(2)}日  总样本 ${total}` +
      `  边界截断 ${String(boundary).padStart(4)}（${((boundary / total) * 100).toFixed(1)}%，非偏差）` +
      `  缺失删样 ${String(missing).padStart(3)}（${((missing / total) * 100).toFixed(3)}%）`,
  );
}

{
  let nullCells = 0;
  let cells = 0;
  let stocksWithNull = 0;
  for (const s of full.stocks) {
    let has = false;
    for (const v of s.close) {
      cells += 1;
      if (v === null) {
        nullCells += 1;
        has = true;
      }
    }
    if (has) stocksWithNull += 1;
  }
  const rate = (nullCells / cells) * 100;
  console.log(
    `\n  收盘价序列 null 占比: ${rate.toFixed(4)}%（${nullCells} / ${cells}），涉及 ${stocksWithNull} / ${full.stocks.length} 只个股`,
  );
  console.log(
    rate < 0.1
      ? "  → 缺失率极低，「非随机删样」在本数据集上**不构成实质威胁**（这一点与理论担忧相反，已实测确认）"
      : "  → 缺失率不可忽略，需做完整样本 vs 可交易样本的敏感性分析",
  );
}

// ── 稀疏（非重叠）检验：彻底回避重叠问题 ──────────────────────
//
// 起点每隔 h 个交易日取一次，使前瞻窗口互不重叠。
// 代价是样本骤减（20 日窗口在 60 天里只剩 3 个起点），
// 因此它的作用是**交叉验证方向**，而不是提供精确估计。
console.log("\n【9】稀疏非重叠检验（每隔 h 日取一个起点）\n");
for (const k of HORIZONS) {
  const spreads: number[] = [];
  for (let d = MIN_DAYS; d + k < calendar.length; d += k) {
    const bull: number[] = [];
    const bear: number[] = [];
    for (const s of full.stocks) {
      const v = forwardReturn(s.close, d, k);
      if (v === null) continue;
      let action: SignalAction;
      try {
        action = deriveSignal(cut(s, d), rules as never).action;
      } catch {
        continue;
      }
      if (action === "买入" || action === "增持") bull.push(v);
      else if (action === "卖出" || action === "减持") bear.push(v);
    }
    if (bull.length === 0 || bear.length === 0) continue;
    spreads.push(
      bull.reduce((a, x) => a + x, 0) / bull.length - bear.reduce((a, x) => a + x, 0) / bear.length,
    );
  }
  if (spreads.length === 0) {
    console.log(`  +${k}日: 起点不足`);
    continue;
  }
  const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const neg = spreads.filter((x) => x < 0).length;
  console.log(
    `  +${String(k).padStart(2)}日  独立起点 ${spreads.length} 个` +
      `  价差均值 ${(mean >= 0 ? "+" : "") + mean.toFixed(2)}pp` +
      `  为负的起点 ${neg}/${spreads.length}` +
      `  ${spreads.length < 5 ? "（起点太少，仅作方向参考）" : ""}`,
  );
}

console.log("\n【7】有效样本量（为什么 5520 这个数字有误导性）");
{
  const nDays = calendar.length - MIN_DAYS;
  console.log(`  回放交易日: ${nDays} 天`);
  console.log(`  20 日前瞻的独立窗口数: 约 ${Math.floor(nDays / 20)} 个（重叠样本会重复计数）`);
  console.log(`  个股数: ${full.stocks.length} 只，但同属一个市场，相关性极高`);
  console.log(`  → 名义样本 5520，有效样本量远低于此，量级更接近"独立窗口数 × 有效板块数"`);
}

console.log(
  `\n⚠ 以上为行为压测，非策略有效性证明：样本 ${full.stocks.length} 只、${perDay.length} 个可回放交易日，` +
    "\n  且个股同属一个市场、高度相关；区间单一，不能外推到其他市场环境。" +
    "\n  另需注意：股票池按当前市值选出，存在前视/生存偏差（详见 README）。\n",
);

if (errors > 0) process.exitCode = 1;
