/**
 * 端到端集成验证：真实快照 → 引擎 → 四层漏斗 + 七步分析。
 *
 * 单元测试用的是 fixture（人造数据），这个脚本用**真实抓取的快照**跑一遍完整链路，
 * 验证 数据格式 → 引擎契约 之间没有错位。
 *
 *   npx vite-node scripts/verify-pipeline.ts [快照目录]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeMarket,
  analyzeSector,
  classifyStock,
  buildReport,
  computeStockMetrics,
  learningQuestions,
  generateLearningFeedback,
  reviewThesis,
  type Snapshot,
  type SectorData,
  type StockData,
} from "../packages/core/src/engine";
import rules from "../packages/core/rules.json";

const ROOT = process.cwd();
const DATA = join(ROOT, "data");

function pickSnapshotDir(arg?: string): string {
  if (arg) return join(ROOT, arg);
  const dirs = readdirSync(DATA).filter((d) => d.startsWith("snapshot_")).sort();
  if (dirs.length === 0) throw new Error("没有快照，先跑 fetch_snapshot.py");
  return join(DATA, dirs.at(-1)!);
}

const dir = pickSnapshotDir(process.argv[2]);
const j = <T>(f: string): T => JSON.parse(readFileSync(join(dir, f), "utf-8"));

const snapshot: Snapshot = {
  indices: j("indices.json"),
  sectors: j("sectors.json"),
  stocks: j("stocks.json"),
  etfs: j("etfs.json"),
};
const meta = j<Record<string, unknown>>("meta.json");

let fail = 0;
const check = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) fail++;
};

console.log(`\n快照: ${dir.split("/").pop()}  asOf=${meta.asOf}`);
console.log(`数据: 指数 ${snapshot.indices.length} / 板块 ${snapshot.sectors.length} / 个股 ${snapshot.stocks.length}\n`);

// ── 第一层：大盘环境 ──────────────────────────────────────────────
console.log("[第1层] 大盘环境");
const market = analyzeMarket(snapshot, rules as never);
console.log(`  状态: ${market.state}`);
console.log(`  含义: ${market.implication}`);
check(["强", "正常", "偏弱", "数据不足"].includes(market.state), `状态取值合法 (${market.state})`);
check(market.reasons.length >= 4, `判断依据 ${market.reasons.length} 条 (≥4)`);
for (const r of market.reasons) {
  console.log(`    · ${r.label} = ${r.value === null ? "null" : r.value.toFixed(2)}  阈值 ${r.threshold}  ${r.pass ? "通过" : "未通过"}`);
}

// ── 第二层：板块强弱 ──────────────────────────────────────────────
console.log("\n[第2层] 板块强弱");
const byCode = new Map(snapshot.stocks.map((s) => [s.code, s]));
const sectorResults = snapshot.sectors.map((sec: SectorData) => analyzeSector(sec, byCode, rules as never));
const ORDER = ["持续强势", "正在加强", "开始活跃", "震荡", "走弱", "数据不足"];
const dist: Record<string, number> = {};
for (const r of sectorResults) dist[r.state] = (dist[r.state] ?? 0) + 1;
console.log(`  分布: ${ORDER.filter((k) => dist[k]).map((k) => `${k} ${dist[k]}`).join(" / ")}`);
check(sectorResults.length === snapshot.sectors.length, `全部 ${sectorResults.length} 个板块都算出了状态`);
check(sectorResults.every((r) => r.reasons.length >= 7), "每个板块判断依据 ≥7 条");
check(sectorResults.every((r) => ORDER.includes(r.state)), "板块状态取值全部合法");
const top = [...sectorResults].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state)).slice(0, 5);
console.log("  最强 5 个:");
for (const s of top) {
  console.log(`    · ${s.name.padEnd(8)} ${s.state.padEnd(6)} 20日=${s.reasons.find((r) => r.key === "sector.ret20")?.value?.toFixed(2) ?? "-"}%  上涨占比=${s.breadth20 === null ? "-" : (s.breadth20 * 100).toFixed(0) + "%"}  强势股=${s.strongCount}  [${s.strongestMembers.join(", ")}]`);
}

// ── 第三层：个股分类 ──────────────────────────────────────────────
console.log("\n[第3层] 个股分类");
const stockResults = snapshot.stocks.map((s: StockData) => classifyStock(s, rules as never));
const TYPES = ["启动观察", "趋势观察", "回调观察", "高位观察", "排除", "数据不足"];
const tdist: Record<string, number> = {};
for (const r of stockResults) tdist[r.type] = (tdist[r.type] ?? 0) + 1;
console.log(`  分布: ${TYPES.filter((t) => tdist[t]).map((t) => `${t} ${tdist[t]}`).join(" / ")}`);
check(stockResults.every((r) => TYPES.includes(r.type)), "个股类型取值全部合法");
check(stockResults.every((r) => r.reasons.length >= 5), "每只股票判断依据 ≥5 条");
const observed = TYPES.filter((t) => tdist[t] && t !== "数据不足");
console.log(`  实际产出类型数: ${observed.length} (不含数据不足)`);
const sample = stockResults.find((r) => r.type !== "数据不足" && r.type !== "排除") ?? stockResults[0];
console.log(`  样例: ${sample.code} ${sample.name} → ${sample.type}${sample.subtype ? " / " + sample.subtype : ""}`);
console.log(`        ATR: available=${sample.atr.available} flag=${sample.atr.flag || "(空)"} atr=${sample.atr.atr?.toFixed(2) ?? "-"} band5=${sample.atr.band5?.toFixed(2) ?? "-"}`);

// ── 第四层：七步分析 ──────────────────────────────────────────────
console.log("\n[第4层] 个股七步分析");
const target = sample.code;
const report = buildReport(snapshot, target, rules as never);
console.log(`  标的: ${target}`);
console.log(`  结论: ${report.conclusion}`);
console.log(`  1 大盘=${report.market.state}  2 板块=${report.sector.state}  3 中期趋势=${report.stockTrend.state}`);
console.log(`  4 价格行为=${report.priceAction.state}  5 位置=${report.position.state}`);
check(report.why.length === 5, `why 恒为 5 条 (实际 ${report.why.length})`);
check(report.nextSteps.length > 0, `下一步观察 ${report.nextSteps.length} 条`);
console.log("  为什么：");
for (const w of report.why) console.log(`    · ${w}`);
console.log(`  数据充分性: ${report.dataSufficiency.enough ? "充分" : "不足 → " + report.dataSufficiency.missing.join("；")}`);

// 红线检查（与引擎单测同款，但在真实数据上再验一遍）
const text = [report.conclusion, ...report.why, ...report.nextSteps].join(" ");
const BAD = ["买入", "卖出", "目标价", "必涨", "必跌"];
const hit = BAD.filter((b) => text.includes(b));
check(hit.length === 0, `输出红线：无买卖信号词 ${hit.length ? "（命中 " + hit.join(",") + "）" : ""}`);

// ── 学习模式 + 复盘 ───────────────────────────────────────────────
console.log("\n[学习模式]");
const qs = learningQuestions(report.currentType);
console.log(`  「${report.currentType}」出题 ${qs.length} 道:`);
for (const q of qs) console.log(`    · ${q}`);
check(qs.length > 0, "学习问题非空");

const metrics = computeStockMetrics(snapshot.stocks.find((s) => s.code === target)!, rules as never);
const fb = generateLearningFeedback(report.currentType, "我看它放量突破了20日线，位置也还行", report, metrics);
console.log(`  反馈-你的判断: ${fb.doneRight.length} 条`);
console.log(`  反馈-容易忽略: ${fb.easyToMiss.length} 条`);
check(fb.thinkFurther.length > 0, "进一步思考非空");

const thesis = reviewThesis(
  { types: ["技术形态", "消息催化"], horizon: "波段20日", text: "我觉得它是趋势观察" },
  report,
  metrics,
);
console.log(`  复盘对照表 ${thesis.rows.length} 行:`);
for (const r of thesis.rows) console.log(`    · ${r.reasonType.padEnd(5)} → ${r.conclusion}`);
check(thesis.rows.length >= 3, "复盘表行数 ≥3");

console.log(`\n════════ 集成验证：${fail === 0 ? "全部通过" : fail + " 项失败"} ════════`);
if (fail > 0) process.exitCode = 1;
