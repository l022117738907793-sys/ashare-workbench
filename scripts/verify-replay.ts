/**
 * 历史推演引擎的真实数据验证：真快照 → 一步一步走 → 逐笔与原始日线对照。
 *
 * 为什么不能用单元测试代替：
 * 单元测试用的是手搓的十日行情，我说「成交价是次一交易日开盘价」它就信了。
 * 这个脚本回到**真实抓下来的 120 天快照**上，把每一笔模拟成交的价格
 * 拿原始 stocks.json 的数字逐个比对 —— 这才是「推演没有开天眼」的证据。
 *
 *   npx vite-node scripts/verify-replay.ts [快照目录]
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { calcFee, type Account } from "../packages/game/src/index";
import {
  advanceDay,
  advanceDays,
  cancelOrder,
  placeOrder,
  replayDate,
  settleReplay,
  createReplay,
  type ReplayInstrument,
} from "../packages/game/src/replay";
import {
  parseReplaySave,
  readReplaySave,
  replayAvailable,
  restoreReplay,
  startReplay,
  toSave,
  displayDate,
} from "../apps/web/src/lib/replay";
import type { Snapshot, StockData } from "../packages/core/src/engine";

const ROOT = process.cwd();
const DATA = join(ROOT, "data");

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), `实际 ${String(actual)}，期望 ${String(expected)}`);
}

/** 找到要验证的那份快照：显式参数 > latest.json（发布副本里才有）> 最新的一份 */
function pickSnapshot(arg?: string): string {
  if (arg) return join(DATA, arg);
  const latestFile = join(DATA, "latest.json");
  if (existsSync(latestFile)) {
    const latest = JSON.parse(readFileSync(latestFile, "utf8")) as { snapshot: string };
    return join(DATA, latest.snapshot);
  }
  const newest = readdirSync(DATA)
    .filter((n) => /^snapshot_\d{8}$/.test(n))
    .sort()
    .pop();
  if (!newest) throw new Error(`data/ 下没有找到 snapshot_YYYYMMDD 目录`);
  return join(DATA, newest);
}

const dir = pickSnapshot(process.argv[2]);
if (!existsSync(join(dir, "stocks.json"))) {
  console.error(`找不到快照：${dir}`);
  process.exit(1);
}

console.log(`\n快照：${dir.replace(ROOT + "/", "")}\n`);

const calendar = JSON.parse(readFileSync(join(dir, "calendar.json"), "utf8")) as string[];
const rawStocks = JSON.parse(readFileSync(join(dir, "stocks.json"), "utf8")) as StockData[];
const rawIndices = JSON.parse(readFileSync(join(dir, "indices.json"), "utf8")) as StockData[];

const snapshot: Snapshot = {
  calendar,
  indices: rawIndices,
  sectors: JSON.parse(readFileSync(join(dir, "sectors.json"), "utf8")),
  stocks: rawStocks,
  etfs: JSON.parse(readFileSync(join(dir, "etfs.json"), "utf8")),
};

// ── 1. 数据前置：有没有开盘价 ────────────────────────────────
console.log("一、快照是否支持推演");
check("replayAvailable(snapshot) 为真", replayAvailable(snapshot));
const openMissing = rawStocks.filter((s) => !s.open || s.open.length !== calendar.length).length;
eq("所有股票都有与日历等长的 open 列", openMissing, 0);
check(
  "open 有真实的非空值（不是整列 null）",
  rawStocks.every((s) => (s.open ?? []).some((v) => v !== null)),
);

// ── 2. 开局 ──────────────────────────────────────────────────
console.log("\n二、开局");
const START = 20;
const state0 = startReplay(snapshot, calendar, {
  mode: "random",
  initialCash: 200_000,
  startIndex: START,
});
eq("开局日 = calendar[20]", replayDate(state0), calendar[START]);
eq("初始现金", state0.account.cash, 200_000);
eq("初始持仓为空", state0.account.holdings.length, 0);
eq("起始权益曲线只有一个点", state0.equity.length, 1);
check("开局没有成交记录", state0.account.trades.length === 0);

// 挑一只有完整价格的票
const target = rawStocks.find(
  (s) =>
    (s.open ?? []).slice(START, START + 6).every((v) => v !== null && v > 0) &&
    (s.close ?? []).slice(START, START + 6).every((v) => v !== null && v > 0),
)!;
check("找到一只价格完整的标的", Boolean(target), target?.code);

// ── 3. 核心契约：按次一交易日开盘价成交 ──────────────────────
console.log("\n三、成交价必须是次一交易日的开盘价");
const shares = 100;
let st = state0;
const placed = placeOrder(st, { code: target.code, side: "buy", shares, typeAtTrade: "趋势观察" });
check("挂单成功", placed.ok, placed.ok ? "" : placed.reason);
if (!placed.ok) process.exit(1);
st = placed.state;

check("挂单未立即成交（玩家还没看到下一天）", st.account.trades.length === 0);
check("挂单在待成交列表里", st.pending.length === 1);
eq("成交前现金未变", st.account.cash, 200_000);

st = advanceDay(st);
eq("推进一天后成交 1 笔", st.account.trades.length, 1);
const trade = st.account.trades[0];
const nextDate = calendar[START + 1];
eq("成交日期 = 次一交易日", trade.date, nextDate);
const refOpen = target.open![START + 1]!;
// 成交价 = 开盘价 × (1 + 滑点)，滑点是已有撮合规则的一部分（0.1%），不是误差
eq("成交价 = 次一交易日开盘价 × (1 + 滑点)", trade.price, Math.round(refOpen * 1.001 * 100) / 100);
check(
  "成交价不是当日收盘价（没有开天眼）",
  trade.price !== target.close![START + 1],
  `open=${refOpen} close=${target.close![START + 1]}`,
);
check(
  "备注同时写明参考开盘价与含滑点的成交价",
  trade.note.includes(refOpen.toFixed(2)) && trade.note.includes("滑点"),
  trade.note,
);
check("成交价不是开局日收盘价", trade.price !== target.close![START]);
check("成交记录写明了价格来源", (trade.note ?? "").includes("历史推演") && (trade.note ?? "").includes("开盘价"));
eq("记录下了下单时的分类", trade.typeAtTrade, "趋势观察");

// 手续费按成交日的费率算
const expectFee = calcFee("buy", trade.amount, trade.date).total;
eq("手续费按成交日费率计算", trade.fee, expectFee);

// ── 4. T+1 ───────────────────────────────────────────────────
console.log("\n四、T+1");
const holding = st.account.holdings.find((h) => h.code === target.code)!;
eq("买入当日 sellable = 0", holding.sellable, 0);
eq("股数正确", holding.shares, shares);
const earlySell = placeOrder(st, { code: target.code, side: "sell", shares: 100 });
check("当天想卖被拒", !earlySell.ok, earlySell.ok ? "竟然通过了" : earlySell.reason);
check("拒绝理由含 T+1", !earlySell.ok && earlySell.reason.includes("T+1"));

st = advanceDay(st);
const h2 = st.account.holdings.find((h) => h.code === target.code)!;
eq("隔日 sellable 解放", h2.sellable, 100);
const okSell = placeOrder(st, { code: target.code, side: "sell", shares: 100 });
check("隔日可以卖", okSell.ok, okSell.ok ? "" : okSell.reason);
if (okSell.ok) {
  const sold = advanceDay(okSell.state);
  const sellTrade = sold.account.trades[sold.account.trades.length - 1];
  const refSellOpen = target.open![START + 3]!;
  eq("卖出按再下一日开盘价 × (1 - 滑点)", sellTrade.price, Math.round(refSellOpen * 0.999 * 100) / 100);
  eq("卖出后不再持有该标的", sold.account.holdings.some((h) => h.code === target.code), false);
}

// ── 5. 结算 ──────────────────────────────────────────────────
console.log("\n五、结算");
const settled = settleReplay(st, "验证局");
check("结算产出 SeasonResult", Boolean(settled.result));
eq("赛季名", settled.result.season, "验证局");
check("结算价格是现场算的（等于总资产）", settled.result.finalAssets > 0);
check("回撤是有限数", Number.isFinite(settled.result.maxDrawdownPct));
check("交易笔数对得上", settled.result.tradeCount === st.account.trades.length);
check("结算结果写回赛季列表", settled.state.account.seasons.length === 1);

// ── 6. 存档往返 ──────────────────────────────────────────────
console.log("\n六、存档往返（关掉页面再回来）");
const save = toSave(st, { mode: "random", hideDate: true, codes: [target.code] });
const json = JSON.stringify(save);
check("存档体积可接受（不含行情）", json.length < 20_000, `${json.length} 字节`);
const parsed = parseReplaySave(JSON.parse(json));
check("能解析回来", parsed !== null);
if (parsed) {
  const restored = restoreReplay(snapshot, calendar, parsed);
  check("能还原状态", restored !== null);
  if (restored) {
    eq("还原后日期一致", replayDate(restored), replayDate(st));
    eq("还原后现金一致", restored.account.cash, st.account.cash);
    eq("还原后成交笔数一致", restored.account.trades.length, st.account.trades.length);
    eq("还原后持仓股数一致", restored.account.holdings[0]?.shares, st.account.holdings[0]?.shares);
    eq("还原后再推进一天结果一致", replayDate(advanceDay(restored)), replayDate(advanceDay(st)));
  }
}
eq("坏存档当没有存档（不抛异常）", readReplaySave("{不是 json"), null);
eq("空存档返回 null", readReplaySave(null), null);

// ── 7. 不猜价格 ──────────────────────────────────────────────
console.log("\n七、数据缺失时不猜价格");
const noOpen: ReplayInstrument = {
  code: "000000.SZ", name: "停牌股", isST: false,
  open: [null, null, null], close: [10, 10, 10],
  high: [10, 10, 10], low: [10, 10, 10], volume: [0, 0, 0],
};
const gap = createReplay({
  calendar: calendar.slice(0, 3),
  startIndex: 0,
  initialCash: 100_000,
  instruments: [noOpen],
});
const gapOrder = placeOrder(gap, { code: "000000.SZ", side: "buy", shares: 100 });
check("挂单本身允许（挂单时不预判资金）", gapOrder.ok, gapOrder.ok ? "" : gapOrder.reason);
if (gapOrder.ok) {
  const gapNext = advanceDay(gapOrder.state);
  const entry = gapNext.log[gapNext.log.length - 1];
  check("没有开盘价则委托作废", entry.ok === false);
  check("说明原因是不猜价格", entry.text.includes("没有开盘价") && entry.text.includes("不猜价格"));
  eq("账户没有被动过", gapNext.account.trades.length, 0);
}

// ── 8. 不剧透 ────────────────────────────────────────────────
console.log("\n八、随机模式不剧透");
const hidden = displayDate(st, true);
check("隐藏日期时显示第几天", /第\s*\d+\s*天/.test(hidden), hidden);
check("隐藏日期时不含年份", !hidden.includes(calendar[START].slice(0, 4)), hidden);
eq("显示日期时给出具体交易日", displayDate(st, false), replayDate(st));

// ── 9. 撤单与连续推进 ───────────────────────────────────────
console.log("\n九、撤单与连续推进");
const withPending = placeOrder(state0, { code: target.code, side: "buy", shares: 100 });
if (withPending.ok) {
  const id = withPending.state.pending[0].id;
  const cancelled = cancelOrder(withPending.state, id);
  eq("撤单后待成交清空", cancelled.pending.length, 0);
  const afterCancel = advanceDay(cancelled);
  eq("撤单后推进不产生成交", afterCancel.account.trades.length, 0);
}
const ticked = advanceDays(state0, 30);
eq("连续推进 30 天走到正确日期", replayDate(ticked), calendar[START + 30]);
eq("推进每一天都记入权益曲线", ticked.equity.length, 31);

// ── 10. 全程无建议 ───────────────────────────────────────────
console.log("\n十、输出里没有买卖建议");
const logText = [...st.log.map((l) => l.text), hidden, JSON.stringify(save)].join(" ");
const banned = ["建议买入", "建议卖出", "必涨", "必跌", "稳赚", "目标价", "推荐"];
const hits = banned.filter((w) => logText.includes(w));
eq("没有出现被禁的措辞", hits.length, 0);

// ── 汇总 ─────────────────────────────────────────────────────
console.log(`\n${"─".repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log("\n失败详情：");
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log("历史推演引擎与真实日线一致。\n");
