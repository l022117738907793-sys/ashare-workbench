/**
 * 把历史推演界面渲染成一张静态 HTML，用来目视检查排版。
 *
 * 单个组件没法用浏览器直接打开，但 `renderToStaticMarkup` 出来的就是真实 DOM，
 * 配上构建产物里的同一份 CSS，就能用无头浏览器截图 —— 排版问题只有看得见才算发现。
 *
 *   npx vite-node scripts/preview-replay.ts [快照目录] [输出路径] [hideDate:0|1]
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ReplayView } from "../apps/web/src/components/ReplayView";
import { placeOrder, advanceDay, settleReplay, pendingFor } from "../packages/game/src/replay";
import { startReplay } from "../apps/web/src/lib/replay";
import type { Snapshot, StockData } from "../packages/core/src/engine";

const ROOT = process.cwd();
const DATA = join(ROOT, "data");

function pickSnapshot(arg?: string): string {
  if (arg) return join(DATA, arg);
  const newest = readdirSync(DATA).filter((n) => /^snapshot_\d{8}$/.test(n)).sort().pop();
  if (!newest) throw new Error("data/ 下没有快照");
  return join(DATA, newest);
}

const dir = pickSnapshot(process.argv[2]);
const out = process.argv[3] ?? "/tmp/replay-preview.html";
const hideDate = process.argv[4] !== "0";

const calendar = JSON.parse(readFileSync(join(dir, "calendar.json"), "utf8")) as string[];
const stocks = JSON.parse(readFileSync(join(dir, "stocks.json"), "utf8")) as StockData[];
const snapshot: Snapshot = {
  calendar,
  indices: JSON.parse(readFileSync(join(dir, "indices.json"), "utf8")),
  sectors: JSON.parse(readFileSync(join(dir, "sectors.json"), "utf8")),
  stocks,
  etfs: JSON.parse(readFileSync(join(dir, "etfs.json"), "utf8")),
};

// 造一个「玩了一会儿」的局面：挂单、成交、持仓、再来一笔待成交
let state = startReplay(snapshot, calendar, {
  mode: "random",
  initialCash: 200_000,
  startIndex: 30,
  codes: stocks.slice(0, 12).map((s) => s.code),
});
const picks = state.config.instruments
  .filter((i) => (i.open[31] ?? 0) > 0)
  .slice(0, 3);
for (const p of picks) {
  const r = placeOrder(state, { code: p.code, side: "buy", shares: 100, typeAtTrade: "趋势观察" });
  if (r.ok) state = r.state;
}
state = advanceDay(state);
state = advanceDay(state);
const more = state.config.instruments.find((i) => (i.open[34] ?? 0) > 0);
if (more) {
  const r = placeOrder(state, { code: more.code, side: "buy", shares: 200, typeAtTrade: "启动观察" });
  if (r.ok) state = r.state;
}
state = advanceDay(state);

const html = renderToStaticMarkup(
  createElement(ReplayView, {
    state,
    hideDate,
    label: "随机开局",
    stocks,
    benchmarkName: "沪深300",
    onOrder: () => ({ ok: true }),
    onCancel: () => {},
    onAdvance: () => {},
    onExit: () => {},
  }),
);

const cssFile = readdirSync(join(ROOT, "apps/web/dist/assets")).find((f) => f.endsWith(".css"));
const css = cssFile ? readFileSync(join(ROOT, "apps/web/dist/assets", cssFile), "utf8") : "";

writeFileSync(
  out,
  `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>历史推演预览</title>
<style>${css}</style>
</head><body><div class="app"><main class="app-main">${html}</main></div></body></html>`,
  "utf8",
);

const settled = settleReplay(state);
console.log(`已写出 ${out}`);
console.log(`  快照      ${dir.replace(ROOT + "/", "")}`);
console.log(`  当前      ${state.dayIndex} / ${calendar.length - 1} 天（${calendar[state.dayIndex]}）`);
console.log(`  已成交    ${state.account.trades.length} 笔，持仓 ${state.account.holdings.length} 只`);
console.log(`  待成交    ${pendingFor(state).length} 笔`);
console.log(`  现金      ${state.account.cash.toFixed(2)}`);
console.log(`  试算总收益 ${settled.result.totalReturnPct.toFixed(2)}%`);
console.log(`  标的数    ${state.config.instruments.length}`);
