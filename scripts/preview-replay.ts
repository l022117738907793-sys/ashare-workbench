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
import { LevelDetail, LevelPicker } from "../apps/web/src/components/LevelPicker";
import { NewsPanel } from "../apps/web/src/components/NewsPanel";
import { GameView } from "../apps/web/src/components/GameView";
import { LEVELS } from "../packages/game/src/levels";
import { AwayCard } from "../apps/web/src/components/AwayCard";
import { ReviewBlock } from "../apps/web/src/components/ReviewBlock";
import { awayReport } from "../apps/web/src/lib/awayReport";
import { reviewReport } from "../packages/game/src/review";
import { CASH_OPTIONS, DEFAULT_INITIAL_CASH, defaultGameState } from "../apps/web/src/lib/game";
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
    stocks: state.config.instruments,
    benchmarkName: "沪深300",
    onOrder: () => ({ ok: true }),
    onCancel: () => {},
    onAdvance: () => {},
    onExit: () => {},
  }),
);

const cssFile = readdirSync(join(ROOT, "apps/web/dist/assets")).find((f) => f.endsWith(".css"));
const css = cssFile ? readFileSync(join(ROOT, "apps/web/dist/assets", cssFile), "utf8") : "";

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${css}</style>
</head><body><div class="app"><main class="app-main">${body}</main></div></body></html>`;
}

writeFileSync(out, page("历史推演预览", html), "utf8");

// 顺手把传奇模式的两页也渲染出来（排版问题只有看得见才算发现）
const listHtml = renderToStaticMarkup(
  createElement(LevelPicker, {
    ready: true,
    loadingId: null,
    error: null,
    onStart: () => {},
    onBack: () => {},
    cashOptions: CASH_OPTIONS,
    defaultCash: DEFAULT_INITIAL_CASH,
  }),
);
const briefHtml = renderToStaticMarkup(
  createElement(LevelDetail, {
    level: LEVELS[3]!,
    ready: true,
    loading: false,
    error: null,
    cash: DEFAULT_INITIAL_CASH,
    cashOptions: CASH_OPTIONS,
    onCash: () => {},
    onStart: () => {},
    onBack: () => {},
  }),
);
const dirOf = out.slice(0, out.lastIndexOf("/"));
writeFileSync(`${dirOf}/replay-levels.html`, page("关卡列表预览", listHtml), "utf8");
writeFileSync(`${dirOf}/replay-brief.html`, page("开局简报预览", briefHtml), "utf8");
console.log(`已写出 ${dirOf}/replay-levels.html 与 replay-brief.html`);

// ── 离线持仓估值 + 结算复盘：这两块平时只有「离开一阵」和「点结算」才看得到，
//    预览里直接喂构造好的数据，为的是用眼睛看一眼排版。
const DAY = 86400_000;
const thenMark = {
  at: Date.now() - 3 * DAY,
  cash: 100_000,
  positions: [
    { code: "600519.SH", name: "贵州茅台", shares: 100, price: 900 },
    { code: "000725.SZ", name: "京东方A", shares: 2000, price: 4.1 },
    { code: "601988.SH", name: "中国银行", shares: 5000, price: 5.5 },
  ],
};
const awayHtml = renderToStaticMarkup(
  createElement(AwayCard, {
    report: awayReport(thenMark, {
      at: Date.now(),
      cash: 100_000,
      positions: [
        { code: "600519.SH", name: "贵州茅台", shares: 100, price: 1235.58 },
        { code: "000725.SZ", name: "京东方A", shares: 2000, price: 3.92 },
        { code: "601988.SH", name: "中国银行", shares: 5000, price: 6.01 },
      ],
    }, [
      { id: "a", at: Date.now() - 2 * DAY, date: "2026-09-27", code: "600519.SH", name: "贵州茅台",
        side: "buy", price: 1180, shares: 100, amount: 118_000, fee: 30, typeAtTrade: "趋势观察" },
    ]),
    onDismiss: () => {},
  }),
);

const reviewHtml = renderToStaticMarkup(
  createElement(ReviewBlock, {
    report: reviewReport({
      account: {
        initialCash: 200_000,
        cash: 40_000,
        holdings: [
          { code: "600519.SH", name: "贵州茅台", shares: 100, sellable: 100, avgCost: 1180 },
          { code: "000725.SZ", name: "京东方A", shares: 2000, sellable: 2000, avgCost: 4.3 },
        ],
        trades: [
          { id: "a", at: Date.now() - 6 * DAY, date: "2026-09-18", code: "600519.SH", name: "贵州茅台",
            side: "buy", price: 1000, shares: 100, amount: 100_000, fee: 30, typeAtTrade: "趋势观察" },
          { id: "b", at: Date.now() - 4 * DAY, date: "2026-09-22", code: "000725.SZ", name: "京东方A",
            side: "buy", price: 4.3, shares: 2000, amount: 8_600, fee: 5, typeAtTrade: "回调观察" },
          { id: "c", at: Date.now() - 2 * DAY, date: "2026-09-25", code: "601988.SH", name: "中国银行",
            side: "sell", price: 5.8, shares: 3000, amount: 17_400, fee: 22, typeAtTrade: "高位观察" },
          { id: "d", at: Date.now() - 1 * DAY, date: "2026-09-26", code: "600000.SH", name: "浦发银行",
            side: "buy", price: 9.1, shares: 500, amount: 4_550, fee: 5 },
        ],
        seasons: [],
      },
      finalPrices: { "600519.SH": 1235.58, "000725.SZ": 3.92, "601988.SH": 6.01, "600000.SH": 9.02 },
      season: "2026-09",
      asOf: "2026-09-29",
    }),
  }),
);
writeFileSync(`${dirOf}/game-away.html`, page("你不在的这段时间", awayHtml), "utf8");
writeFileSync(`${dirOf}/game-review.html`, page("结算复盘报告", reviewHtml), "utf8");
console.log(`已写出 ${dirOf}/game-away.html 与 game-review.html`);

// 模拟游戏开局页（看按钮主次）+ 新闻面板（看原文链接）
const setupHtml = renderToStaticMarkup(
  createElement(GameView, {
    state: defaultGameState(),
    prices: new Map(),
    quotesByCode: new Map(),
    stocks: [],
    resultsByCode: new Map(),
    onOrder: () => ({ ok: true }),
    onStart: () => {},
    onReset: () => {},
    onSettle: () => null,
    onOpenRules: () => {},
    news: {
      items: [
        { id: "1", title: "北方长龙：控股股东及一致行动人询价转让已完成，减持1.32%",
          digest: "北方长龙公告称，控股股东及一致行动人询价转让已完成，合计减持 1.32%。本次询价转让不涉及公司控制权变更。",
          at: Date.now() - 600_000, source: "同花顺快讯", timeKnown: true,
          url: "https://news.10jqka.com.cn/20260930/c680413883.shtml" },
        { id: "2", title: "长光华芯：光芯片长期来看不排除有价格下降的可能",
          digest: "", at: Date.now() - 1200_000, source: "同花顺快讯", timeKnown: true,
          url: "https://news.10jqka.com.cn/20260930/c680413486.shtml" },
        { id: "3", title: "这条没有原文地址，不该出现空链接",
          digest: "东财某些条目拿不到 url，渲染时直接跳过。", at: Date.now() - 1800_000,
          source: "东方财富 7x24", timeKnown: true },
        { id: "4", title: "F5美股盘前涨超24%", digest: "", at: Date.now() - 2400_000,
          source: "同花顺快讯", timeKnown: true,
          url: "https://news.10jqka.com.cn/20260930/c680412328.shtml" },
      ],
      source: "同花顺快讯",
      degradedReason: null,
      updatedAt: Date.now(),
      loading: false,
      onRefresh: () => {},
    },
    sessionText: "已收盘",
    isTradingNow: false,
    benchmarkName: "沪深300",
    benchmarkReturnPct: null,
    totalAssets: 0,
    holdingsValue: 0,
    replayReady: true,
    onStartReplay: () => {},
    onOpenLegend: () => {},
  }),
);
writeFileSync(`${dirOf}/game-setup.html`, page("模拟游戏开局页", setupHtml), "utf8");
console.log(`已写出 ${dirOf}/game-setup.html`);

const settled = settleReplay(state);
console.log(`已写出 ${out}`);
console.log(`  快照      ${dir.replace(ROOT + "/", "")}`);
console.log(`  当前      ${state.dayIndex} / ${calendar.length - 1} 天（${calendar[state.dayIndex]}）`);
console.log(`  已成交    ${state.account.trades.length} 笔，持仓 ${state.account.holdings.length} 只`);
console.log(`  待成交    ${pendingFor(state).length} 笔`);
console.log(`  现金      ${state.account.cash.toFixed(2)}`);
console.log(`  试算总收益 ${settled.result.totalReturnPct.toFixed(2)}%`);
console.log(`  标的数    ${state.config.instruments.length}`);
