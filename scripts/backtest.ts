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

console.log(
  "\n⚠ 以上为行为压测，非策略有效性证明：样本仅 92 只、约 60 个交易日，" +
    "\n  且同一区间内个股高度相关（同涨同跌），统计意义有限。\n",
);

if (errors > 0) process.exitCode = 1;
