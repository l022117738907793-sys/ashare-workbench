/**
 * 视图渲染冒烟测试（`react-dom/server`，仍是 node 环境，不需要 jsdom）。
 *
 * 为什么值得单独测：
 * - 用**真实 fixture 数据**（不是手搓 mock）跑一遍完整渲染，能抓出组件里的空值崩溃；
 * - 红线是"任何界面都不出现买入/卖出/目标价/必涨/必跌"，只测纯函数不够 ——
 *   这里直接对**渲染出来的 HTML 字符串**做断言；
 * - 顺带验证「判断依据」「数据不足，不许编造」「数据来源」确实出现在 DOM 里。
 *
 * 本文件用 `createElement` 而非 JSX：vitest 的 include 只匹配 `*.test.ts`。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
/**
 * 去掉标签，只留人眼读到的那串字。
 *
 * 术语高亮会把「板块」「持仓」这类词包成一个 `<button class="term">`，于是原本
 * 连续的短语在源码里被切开（`<h2><button>板块</button><span>强弱</span></h2>`）——
 * 直接对 HTML 字符串做 `toContain` 会误报成「文案丢了」。断言**用户读到什么**
 * 的时候用这个函数，断言**结构**（class、aria、顺序）的时候仍然看原始 HTML。
 */
function plain(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

import {
  analyzeMarket,
  analyzeSector,
  buildReport,
  classifyStock,
  computeStockMetrics,
  defaultRules,
  deriveSignal,
  deriveSignals,
  learningQuestions,
  type Snapshot,
  type StockData,
} from "@aw/core";
import { advanceDay, createReplay, LEVELS, placeOrder, type Trade } from "@aw/game";
import { AnalysisView } from "./components/AnalysisView";
import type { NewsItem } from "@aw/data";
import { GameRulesView } from "./components/GameRulesView";
import { NewsPanel } from "./components/NewsPanel";
import type { LiveNewsState } from "./lib/useLiveNews";
import { GuideView } from "./components/GuideView";
import { GameView } from "./components/GameView";
import { LevelDetail, LevelPicker } from "./components/LevelPicker";
import { HistoryView } from "./components/HistoryView";
import { GameHistoryView } from "./components/GameHistoryView";
import { SettingsView } from "./components/SettingsView";
import { Card } from "./components/common";
import { StockPicker } from "./components/StockPicker";
import type { PickStock } from "./lib/picks";
import { WorkbenchView, parseFolds } from "./components/WorkbenchView";
import { CASH_OPTIONS, defaultGameState, GAME_DISCLAIMER, startGame, type GameState } from "./lib/game";
import { awayReport, makeMark } from "./lib/awayReport";
import { REVIEW_CAVEATS, type ReviewReport } from "@aw/game";
import { OrderPreview } from "./components/OrderPreview";
import { ReviewBlock } from "./components/ReviewBlock";
import { SIGNAL_BACKTEST_CAVEAT } from "./lib/helpers";
import { SignalBadge, SignalCard, SignalSummary } from "./components/SignalCard";
import { ReplayView } from "./components/ReplayView";
import { startLevelReplay, type LevelShard, type ReplaySession } from "./lib/replay";
import {
  EMPTY_STORE,
  filterStockResults,
  groupStockResults,
  NOT_ENOUGH_BANNER,
  parseSettings,
  sortSectors,
  stockTypeCounts,
} from "./lib/helpers";

/** fixture 用 `?raw` 内联，避免为了读文件引入 node:fs（也就不需要 @types/node） */
const FIXTURES = import.meta.glob("../../../packages/core/fixtures/*.json", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

interface Fixture extends Snapshot {
  id: string;
  rules: Record<string, unknown>;
  expected: { market: string; stock: { code: string; type: string } };
}

function loadFixture(name: string): Fixture {
  const key = Object.keys(FIXTURES).find((k) => k.endsWith(`/${name}`));
  if (!key) throw new Error(`fixture 未找到: ${name}（已加载 ${Object.keys(FIXTURES).length} 个）`);
  return JSON.parse(FIXTURES[key]) as Fixture;
}

const devSnapshot = loadFixture("market_normal_sector_active_stock_high.json");

function renderWorkbench(
  snapshot: Snapshot,
  over: Partial<Parameters<typeof WorkbenchView>[0]> = {},
): string {
  const byCode = new Map<string, StockData>(snapshot.stocks.map((s) => [s.code, s]));
  const results = snapshot.stocks.map((s) => classifyStock(s, defaultRules));
  const metrics = new Map(snapshot.stocks.map((s) => [s.code, computeStockMetrics(s, defaultRules)]));
  const ret20 = new Map([...metrics].map(([code, m]) => [code, m.ret20]));
  const groups = groupStockResults(results, ret20);
  return renderToStaticMarkup(
    createElement(WorkbenchView, {
      market: analyzeMarket(snapshot, defaultRules),
      sectors: sortSectors(snapshot.sectors.map((s) => analyzeSector(s, byCode, defaultRules))),
      groups,
      counts: stockTypeCounts(groups),
      metricsByCode: metrics,
      sectorCode: null,
      onSelectSector: () => {},
      query: "",
      onQuery: () => {},
      onOpenStock: () => {},
      quotesByCode: new Map(),
      totalStocks: snapshot.stocks.length,
      filteredStocks: filterStockResults(results, byCode).length,
      mainIndexText: "主指数 沪深300 最新收盘 3750.00",
      signals: deriveSignals(snapshot.stocks, defaultRules),
      ...over,
    }),
  );
}

/** 找一个板块代码，用来测「选中板块之后」的样子 */
function firstSectorCode(snapshot: Snapshot): string {
  const code = snapshot.sectors[0]?.code;
  if (!code) throw new Error("fixture 里没有板块，测不了");
  return code;
}

function renderCard(props: Parameters<typeof Card>[0]): string {
  return renderToStaticMarkup(createElement(Card, props));
}

describe("卡片可折叠", () => {
  it("没传 onToggleFold 就不是折叠卡，不出现按钮", () => {
    const html = renderCard({ title: "① 大盘环境", children: createElement("p", null, "内容") });
    expect(html).not.toContain("card-fold");
  });

  it("传了 onToggleFold 就出现按钮，且默认是展开的", () => {
    const html = renderCard({
      title: "② 板块强弱",
      onToggleFold: () => {},
      children: createElement("p", null, "正文内容"),
    });
    expect(html).toContain("收起 ▴");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("正文内容");
  });

  it("折叠时正文整块不渲染，而不是藏起来", () => {
    // `.card-body` 是 flex 容器，`hidden` 属性压不过它（作者样式赢过浏览器默认样式），
    // 用 CSS 隐藏会「看起来折了但其实还在」，所以必须是条件渲染
    const html = renderCard({
      title: "② 板块强弱",
      folded: true,
      onToggleFold: () => {},
      children: createElement("p", null, "正文内容"),
    });
    expect(html).not.toContain("正文内容");
    expect(html).toContain("展开 ▾");
    expect(html).toContain('aria-expanded="false"');
  });

  it("折叠后头部仍然在，按钮还按得下去", () => {
    const html = renderCard({
      id: "layer-sectors",
      title: "② 板块强弱",
      folded: true,
      onToggleFold: () => {},
      children: createElement("p", null, "x"),
    });
    expect(plain(html)).toContain("② 板块强弱");
    expect(html).toContain('aria-controls="layer-sectors-body"');
  });

  it("折叠时右侧那些筛选按钮还在（折起来也得能清除筛选）", () => {
    const html = renderCard({
      title: "② 板块强弱",
      folded: true,
      onToggleFold: () => {},
      right: createElement("button", { type: "button" }, "清除板块筛选 ✕"),
      children: createElement("p", null, "x"),
    });
    expect(html).toContain("清除板块筛选");
  });
});

/**
 * 跳转过去之后闪一下。
 *
 * 加这个是因为「滚过去」还不够 —— 页面上东西很多，滚过去之后目光未必落
 * 在对的那张卡上。动画本身在 e2e 里看，这里只盯 class 有没有接上。
 */
describe("卡片闪一下（跳转的落点提示）", () => {
  it("默认不闪", () => {
    const html = renderCard({ title: "③ 个股分类", children: createElement("p", null, "x") });
    expect(html).not.toContain("card-flash");
  });

  it("flash 打开时带上 card-flash", () => {
    const html = renderCard({
      title: "③ 个股分类",
      flash: true,
      children: createElement("p", null, "x"),
    });
    expect(html).toContain("card-flash");
  });

  it("闪的同时还能是折叠的，两个 class 各管各的", () => {
    const html = renderCard({
      title: "③ 个股分类",
      flash: true,
      folded: true,
      onToggleFold: () => {},
      children: createElement("p", null, "x"),
    });
    expect(html).toContain("card-flash");
    expect(html).toContain("card-head-folded");
  });
});

describe("折叠状态存档", () => {
  it("没存过 → 全展开", () => {
    expect(parseFolds(null)).toEqual({ sectors: false, stocks: false });
  });

  it("存过 → 按存的来", () => {
    expect(parseFolds('{"sectors":true,"stocks":false}')).toEqual({ sectors: true, stocks: false });
  });

  it("只认真正的 true，别的值当没折", () => {
    // 手改过的存档、或者以后改了字段含义，都不该让某一层莫名其妙地消失
    expect(parseFolds('{"sectors":"yes","stocks":1}')).toEqual({ sectors: false, stocks: false });
  });

  it("坏 json 不抛，退回全展开", () => {
    expect(parseFolds("{不是 json")).toEqual({ sectors: false, stocks: false });
    expect(parseFolds("null")).toEqual({ sectors: false, stocks: false });
    expect(parseFolds('"字符串"')).toEqual({ sectors: false, stocks: false });
  });
});

describe("板块跳转：点板块跳到该板块的个股", () => {
  const sectorCode = firstSectorCode(devSnapshot);

  it("第二层和第三层都给得出折叠按钮", () => {
    const html = renderWorkbench(devSnapshot);
    expect((html.match(/card-fold/g) ?? []).length).toBe(2);
    expect(html).toContain("收起 ▴");
    // 默认展开：一进来就把内容藏掉，等于让人先点一下才看得到东西
    expect(html).not.toContain("展开 ▾");
  });

  it("第三层带锚点 id，跳转才有地方可跳", () => {
    const html = renderWorkbench(devSnapshot);
    expect(html).toContain('id="layer-stocks"');
    expect(html).toContain('id="layer-sectors"');
  });

  it("板块行说清楚点了会跳到下面，而不是只说「只看该板块」", () => {
    const html = renderWorkbench(devSnapshot);
    expect(html).toContain("点此只看该板块，并跳到下面的个股 ↓");
  });

  it("选中板块后，个股卡给一个「回到板块列表」的出口", () => {
    // 跳下去之后没有回头路就是死胡同 —— 想换个板块得自己往上翻好几屏
    const html = renderWorkbench(devSnapshot, { sectorCode });
    expect(html).toContain("回到板块列表");
    expect(html).toContain("已选中：第三层只显示该板块");
  });

  it("没选板块时不给返回按钮", () => {
    expect(renderWorkbench(devSnapshot)).not.toContain("回到板块列表");
  });
});

describe("筛选页渲染", () => {
  const html = renderWorkbench(devSnapshot);

  it("三层结构和判断依据都渲染出来", () => {
    const text = plain(html);
    expect(text).toContain("① 大盘环境");
    expect(text).toContain("② 板块强弱");
    expect(text).toContain("③ 个股分类");
    expect(text).toContain("判断依据");
    expect(html).toContain("上涨占比");
    expect(html).toContain("最强成分");
  });

  it("默认展开第一个非空分组，且每个分类都带判断依据", () => {
    expect(html).toContain("趋势观察");
    expect(html).toContain("打开七步分析");
    // 默认展开的组里，每条个股都有一份 reasons 列表
    const reasonBlocks = html.match(/class="reasons"/g) ?? [];
    expect(reasonBlocks.length).toBeGreaterThanOrEqual(2); // 大盘 + 板块 + 个股
    expect(plain(html)).toContain("近20日涨跌幅");
  });

  it("不出现任何红线词", () => {
  });
});

describe("个股分析页渲染", () => {
  const code = devSnapshot.expected.stock.code;
  const stock = devSnapshot.stocks.find((s) => s.code === code) as StockData;
  const report = buildReport(devSnapshot, code, defaultRules);
  const classification = classifyStock(stock, defaultRules);

  const html = renderToStaticMarkup(
    createElement(AnalysisView, {
      code,
      name: stock.name,
      report,
      reportError: null,
      metrics: computeStockMetrics(stock, defaultRules),
      quote: null,
      quoteError: null,
      sessionText: "已收盘",
      snapshotPrice: stock.close.at(-1) ?? null,
      snapshotAsOf: "2026-09-23",
      classificationReasons: classification.reasons,
      signal: deriveSignal(stock, defaultRules),
      onBack: () => {},
      onOpenSettings: () => {},
      onSaveLearning: () => {},
    }),
  );

  it("七步齐全、顺序正确", () => {
    const titles = ["① 大盘环境", "② 板块状态", "③ 个股中期趋势", "④ 近期价格行为", "⑤ 当前位置", "⑥ 下一步观察", "⑦ 结论"];
    // 顺序要在**读到的文字**里比：术语按钮会把标题切成几段，源码里的 indexOf 会错位
    const text = plain(html);
    let cursor = -1;
    for (const t of titles) {
      const at = text.indexOf(t);
      expect(at, `${t} 应该出现`).toBeGreaterThan(-1);
      expect(at, `${t} 顺序应在上一张卡片之后`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("包含结论、why、下一步与判断依据", () => {
    expect(html).toContain(report.conclusion);
    expect(html).toContain(report.why[0]);
    expect(html).toContain(report.nextSteps[0]);
    expect(html).toContain("判断依据");
    expect(html).toContain("引擎指标快照");
  });

  it("实时价取不到时显示快照价，并标注来源是本地快照", () => {
    expect(html).toContain("来源：本地快照");
    expect(html).toContain("已收盘");
    expect(html).not.toContain("来源：腾讯行情");
  });

  it("学习模式与「我为什么看好」表单都在，且不出现红线词", () => {
    expect(html).toContain("学习模式");
    expect(html).toContain("我为什么看好");
    expect(html).toContain("消息催化");
    expect(html).toContain("资金流向");
    expect(html).toContain("短线 5 日");
    expect(html).toContain("中线 60 日");
    // 学习反馈的三段只在作答后出现，SSR 只能验证问题与表单已就位
    expect(html).toContain(learningQuestions(report.currentType)[0]);
  });
});

describe("数据不足时的红线文案", () => {
  const fx = loadFixture("market_normal_sector_range_stock_insufficient.json");
  const code = fx.expected.stock.code;
  const stock = fx.stocks.find((s) => s.code === code) as StockData;
  const report = buildReport(fx, code, defaultRules);

  it("fixture 本身确实是数据不足", () => {
    expect(report.currentType).toBe("数据不足");
    expect(report.dataSufficiency.enough).toBe(false);
  });

  it("页面显著位置出现【数据不足，不许编造】与缺失清单", () => {
    const html = renderToStaticMarkup(
      createElement(AnalysisView, {
        code,
        name: stock.name,
        report,
        reportError: null,
        metrics: computeStockMetrics(stock, defaultRules),
        quote: null,
        quoteError: null,
        sessionText: "已收盘",
        snapshotPrice: null,
        snapshotAsOf: null,
        classificationReasons: classifyStock(stock, defaultRules).reasons,
        signal: deriveSignal(stock, defaultRules),
        onBack: () => {},
        onOpenSettings: () => {},
        onSaveLearning: () => {},
      }),
    );
    expect(html).toContain(NOT_ENOUGH_BANNER);
    for (const missing of report.dataSufficiency.missing) {
      expect(html).toContain(missing);
    }
    // 取不到的数值只能是「—」或「数据不足」，不能是 0
    expect(html).toContain("—");
  });

  it("引擎抛错（个股不在快照里）时页面给出可操作提示", () => {
    const html = renderToStaticMarkup(
      createElement(AnalysisView, {
        code: "不存在.SH",
        name: "不存在",
        report: null,
        reportError: "股票不存在: 不存在.SH",
        metrics: null,
        quote: null,
        quoteError: null,
        sessionText: "已收盘",
        snapshotPrice: null,
        snapshotAsOf: null,
        classificationReasons: [],
        signal: null,
        onBack: () => {},
        onOpenSettings: () => {},
        onSaveLearning: () => {},
      }),
    );
    expect(html).toContain("股票不存在: 不存在.SH");
    expect(html).toContain("去设置");
  });
});

describe("历史页与设置页渲染", () => {
  it("空历史给出引导文案，不崩", () => {
    const html = renderToStaticMarkup(
      createElement(HistoryView, {
        store: EMPTY_STORE,
        onOpenStock: () => {},
        onRemoveAnalysed: () => {},
        onClearAnalysed: () => {},
        onClearLearning: () => {},
      }),
    );
    expect(html).toContain("还没有分析记录");
    expect(html).toContain("还没有学习作答");
  });

  it("历史并进个股分析之后，清空按钮只留在设置页", () => {
    // 「清空本地数据」原来是历史页第三张卡上的，现在只在设置页。
    // 一个不可撤销的按钮不该跟日常列表挨着放 —— 顺手点到的代价太大。
    const html = renderToStaticMarkup(
      createElement(HistoryView, {
        store: EMPTY_STORE,
        onOpenStock: () => {},
        onRemoveAnalysed: () => {},
        onClearAnalysed: () => {},
        onClearLearning: () => {},
      }),
    );
    expect(html).not.toContain("清空本地数据");
    expect(html).not.toContain("本地数据");
  });

  it("设置页显示快照信息、交易时段与阈值项", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsView, {
        settings: parseSettings(null),
        onChange: () => {},
        rules: defaultRules,
        onReload: () => {},
        onClearLocal: () => {},
        onBack: () => {},
        snapshotName: "snapshot_dev",
        metaAsOf: "2026-09-23",
        metaSource: "fixture",
        metaDays: "90 天",
        calendarDays: 90,
        sessionText: "已收盘",
        polling: false,
        updatedText: "—（暂无实时数据）",
        quoteSourceText: "—（未取到实时行情）",
      }),
    );
    expect(html).toContain("snapshot_dev");
    expect(html).toContain("2026-09-23");
    expect(html).toContain("已收盘");
    expect(html).toContain("大盘环境阈值");
    expect(html).toContain("个股分类阈值");
    expect(html).toContain("./data");
  });

  it("设置页自带出口：从齿轮进来，得有路回去", () => {
    // 设置不再占底部导航，没有这个返回按钮就是死胡同 —— 只能靠浏览器后退。
    const html = renderToStaticMarkup(
      createElement(SettingsView, {
        settings: parseSettings(null),
        onChange: () => {},
        rules: defaultRules,
        onReload: () => {},
        onClearLocal: () => {},
        onBack: () => {},
        snapshotName: null,
        metaAsOf: null,
        metaSource: null,
        metaDays: null,
        calendarDays: 0,
        sessionText: "已收盘",
        polling: false,
        updatedText: "—（暂无实时数据）",
        quoteSourceText: "—（未取到实时行情）",
      }),
    );
    expect(html).toContain("← 返回");
    expect(html).toContain("清空本地数据");
  });
});

// ── 游戏记录（模拟游戏页的第三屏） ──────────────────────────────

describe("游戏记录：实时模式和历史推演的成交并成一条时间线", () => {
  /**
   * 用真实引擎跑出一局传奇推演，别手搓一个长得像 ReplayState 的对象 ——
   * 手搓的那个一旦引擎改了字段，测试还是绿的。
   */
  function legendSession(trades: Trade[] = [], levelId = "2020-02-03"): ReplaySession {
    const days = ["2020-01-20", "2020-01-21", "2020-01-22", "2020-01-23"];
    const shard: LevelShard = {
      levelId,
      startDate: days[0]!,
      days: days.length,
      calendar: [...days],
      benchmark: { code: "000300.SH", name: "沪深300", close: [4000, 4010, 3990, 3950] },
      instruments: [
        {
          code: "600519.SH",
          name: "贵州茅台",
          isST: false,
          open: [1000, 1010, 1005, 990],
          close: [1005, 1008, 995, 985],
          high: [1010, 1015, 1010, 995],
          low: [995, 1000, 990, 980],
          volume: [1000, 1200, 900, 1500],
        },
      ],
      note: "前复权",
    };
    const state = startLevelReplay(shard, 200_000, "4. 春节之后");
    return {
      state: { ...state, account: { ...state.account, trades } },
      mode: "legend",
      hideDate: false,
      codes: ["600519.SH"],
      label: "4. 春节之后",
      levelId,
    };
  }

  const liveTrade: Trade = {
    id: "t1",
    at: 2,
    date: "2026-09-23",
    code: "600519.SH",
    name: "贵州茅台",
    side: "buy",
    price: 100,
    shares: 100,
    amount: 10_000,
    fee: 5,
    typeAtTrade: "趋势观察",
  };

  const replayTrade: Trade = {
    ...liveTrade,
    id: "r1",
    at: 1,
    date: "2020-01-21",
    side: "sell",
    shares: 200,
  };

  /** 一份「实时模式已经开局」的存档 */
  function liveState(trades: Trade[] = [liveTrade]): GameState {
    const base = startGame(200_000, 0);
    return { ...base, account: { ...base.account, trades } };
  }

  function render(over: Partial<Parameters<typeof GameHistoryView>[0]> = {}): string {
    return renderToStaticMarkup(
      createElement(GameHistoryView, {
        live: null,
        replay: null,
        onOpenStock: () => {},
        onResumeReplay: () => {},
        ...over,
      }),
    );
  }

  it("两边都没开局时给出引导，而不是一张空表", () => {
    const html = render();
    expect(html).toContain("还没有任何成交");
    expect(html).toContain("还没有结算过");
    expect(html).toContain(GAME_DISCLAIMER);
  });

  it("实时模式的那笔标「实时模式」，日期不写「模拟日」", () => {
    const html = render({ live: liveState() });
    expect(html).toContain("成交记录（1）");
    expect(html).toContain("实时模式");
    expect(html).toContain("贵州茅台");
    expect(html).not.toContain("模拟日");
  });

  it("推演的那笔写「模拟日」，并标出是哪一关", () => {
    // 推演的日期是模拟出来的，和真实下单时间不是一回事。不标出来，
    // 玩家会以为「2020-01-21」是自己真的在那天下过单。
    const html = render({ replay: legendSession([replayTrade]) });
    expect(html).toContain("模拟日 2020-01-21");
    expect(html).toContain("历史推演 · 第 4 关");
  });

  it("一边一笔时两笔都在，最新的在前", () => {
    const html = render({ live: liveState(), replay: legendSession([replayTrade]) });
    expect(html).toContain("成交记录（2）");
    const firstLive = html.indexOf("2026-09-23");
    const firstReplay = html.indexOf("2020-01-21");
    expect(firstLive).toBeGreaterThan(-1);
    expect(firstReplay).toBeGreaterThan(-1);
    // liveTrade.at = 2 > replayTrade.at = 1，所以实时那笔排在前面
    expect(firstLive).toBeLessThan(firstReplay);
  });

  it("每一行都能跳去个股分析", () => {
    const html = render({ live: liveState(), replay: legendSession([replayTrade]) });
    const jumps = html.split("看这只票 →").length - 1;
    expect(jumps).toBe(2);
  });

  it("推演还在跑时给一条回去的路，没跑时不给", () => {
    expect(render({ replay: legendSession([replayTrade]) })).toContain("回到正在跑的那一局");
    expect(render({ live: liveState() })).not.toContain("回到正在跑的那一局");
  });

  it("赛季结算把两边的成绩分开列，基准只认沪深300", () => {
    const html = render({ live: liveState(), replay: legendSession() });
    expect(html).toContain("同期沪深300");
    // 开关都没点过，所以是空状态 —— 这里要的就是「没成绩时别装作有」
    expect(html).toContain("赛季结算（0）");
  });

  it("这一屏是只读的：没有任何下单、结算或重置入口", () => {
    // 进得来、改不到 —— 手滑一下不会把正在跑的那一局弄坏。
    // 「买入/卖出」标签本身可以有（那是玩家自己下过的单，不是程序的建议），
    // 不能有的是**能改状态**的按钮。所以逐条 <button> 查，而不是查全文 ——
    // 空状态里那句「在任意一边点『结算本季』」只是指路，不是入口。
    const html = render({ live: liveState(), replay: legendSession([replayTrade]) });
    const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]!);
    expect(buttons.length).toBeGreaterThan(0);
    for (const text of buttons) {
      for (const bad of ["重新开局", "重置", "结算本季", "下单", "全部卖出"]) {
        expect(text, `按钮里不该出现「${bad}」`).not.toContain(bad);
      }
    }
    // 买入/卖出只能以「事后标签」的形态出现，不能是按钮文案
    for (const side of ["买入", "卖出"]) {
      const all = html.split(side).length - 1;
      const tags = html.split(`<span class="tag">${side}</span>`).length - 1;
      expect(all, `「${side}」只该出现在分类标签里`).toBe(tags);
    }
  });
});

/** 新闻状态的测试替身 */
function stubNews(over: Partial<LiveNewsState> = {}): LiveNewsState {
  return {
    items: [],
    source: null,
    degradedReason: null,
    updatedAt: null,
    loading: false,
    refresh: () => {},
    ...over,
  };
}

// ── 模拟游戏渲染 ───────────────────────────────────────────────

/**
 * 下单预览：显示价就是成交价。
 *
 * 用户反馈原话：「中国平安下单前显示本地快照 52.50 元，成交价 52.55 元；买入后
 * 行情才更新到 53.29 元，账户立刻出现浮盈。」那 5 分钱是滑点，但界面上没说过，
 * 看着就像算错了。这个组件存在的唯一目的就是把这段差摆在明处。
 *
 * 单独渲染它，是因为它只在「选了标的」之后出现，而那个选择是 GameView 的内部
 * 状态 —— 静态渲染整张下单卡点不出来（同 LevelDetail / ReviewBlock 的处理）。
 */
describe("下单预览：显示价就是成交价", () => {
  function renderPreview(over: Partial<Parameters<typeof OrderPreview>[0]> = {}): string {
    return renderToStaticMarkup(
      createElement(OrderPreview, {
        price: 52.5,
        side: "buy",
        shares: 100,
        cash: 200_000,
        sellable: 0,
        today: "2026-09-30",
        ...over,
      }),
    );
  }

  it("买入：参考价 52.50 → 预计成交价 52.55，并把滑点写清楚", () => {
    const html = renderPreview();
    // 「预计成交价」里的「成交价」现在是个术语按钮，会被切成两段，所以看读到的文字
    const text = plain(html);
    expect(text).toContain("预计成交价");
    expect(text).toContain("52.55");
    expect(text).toContain("参考价 52.5");
    expect(html).toContain("加 0.1% 滑点");
  });

  it("买入：预计金额含手续费和可用资金", () => {
    const html = renderPreview();
    expect(html).toContain("预计金额");
    expect(html).toContain("5255"); // 52.55 × 100
    expect(html).toContain("手续费 5.05"); // max(5255×0.00025, 5)
    expect(html).toContain("可用 200000 元");
  });

  it("卖出：减滑点，并给出可卖数量", () => {
    const html = renderPreview({ price: 20, side: "sell", shares: 100, sellable: 300 });
    expect(html).toContain("19.98"); // 20 × (1 − 0.001)
    expect(html).toContain("减 0.1% 滑点");
    expect(html).toContain("可卖 300 股");
  });

  it("印花税改档前后，卖出的手续费不一样（2023-08-28）", () => {
    const before = renderPreview({ price: 10, side: "sell", shares: 1000, today: "2023-08-25" });
    const after = renderPreview({ price: 10, side: "sell", shares: 1000, today: "2023-08-28" });
    expect(before).not.toBe(after);
  });

  it("没有行情就什么都不显示（不能报一个凭空的成交价）", () => {
    expect(renderPreview({ price: null })).toBe("");
  });

  it("股数没填或填成 0 也不显示", () => {
    expect(renderPreview({ shares: 0 })).toBe("");
    expect(renderPreview({ shares: -100 })).toBe("");
    expect(renderPreview({ shares: Number.NaN })).toBe("");
  });
});

describe("模拟游戏页渲染", () => {
  /**
   * 注意：模拟游戏**允许**出现「买入/卖出」——那是用户的操作标签，不是程序的建议。
   * 模拟游戏允许出现买卖标签（那是用户的操作，不是程序的建议），因此改为断言：
   *   1. 常驻免责声明确实渲染出来了；
   *   2. 不出现任何引导性/建议性文案；
   *   3. 取不到行情时显示"无行情"而不是编造盈亏。
   */
  /**
   * 复盘块单独渲染。
   *
   * 它挂在「结算本季」按钮的回调里（点击才 setLastReview），
   * `renderToStaticMarkup` 点不了按钮，所以像 LevelDetail 那样直接渲染组件本身。
   */
  function renderReview(report: ReviewReport): string {
    return renderToStaticMarkup(createElement(ReviewBlock, { report }));
  }

  function renderGame(over: Partial<Parameters<typeof GameView>[0]> = {}): string {
    // 渲染测试需要一个「进行中」的状态
    const base = startGame(1_000_000, 0);
    const state: GameState = {
      ...base,
      equity: [
        { date: "2026-09-22", total: 1_000_000 },
        { date: "2026-09-23", total: 1_012_000 },
      ],
      account: {
        ...base.account,
        cash: 900_000,
        holdings: [
          { code: "600519.SH", name: "贵州茅台", shares: 200, sellable: 100, avgCost: 100 },
          { code: "999999.SH", name: "无行情股", shares: 100, sellable: 100, avgCost: 50 },
        ],
        trades: [
          {
            id: "t1",
            at: 0,
            date: "2026-09-23",
            code: "600519.SH",
            name: "贵州茅台",
            side: "buy",
            price: 100,
            shares: 200,
            amount: 20_000,
            fee: 5,
            typeAtTrade: "趋势观察",
            note: "非交易时段下单，按最近收盘价成交（非实时价）",
          },
        ],
      },
    };
    return renderToStaticMarkup(
      createElement(GameView, {
        state,
        prices: new Map<string, number | null>([
          ["600519.SH", 110],
          ["999999.SH", null],
        ]),
        quotesByCode: new Map(),
        stocks: [],
        resultsByCode: new Map(),
        onOrder: () => ({ ok: true }),
        onStart: () => {},
        onReset: () => {},
        onSettle: () => null,
        onOpenRules: () => {},
        news: stubNews(),
        sessionText: "已收盘",
        isTradingNow: false,
        today: "2026-09-30",
        benchmarkName: "沪深300",
        benchmarkReturnPct: 1.5,
        totalAssets: 1_012_000,
        holdingsValue: 122_000,
        replayReady: false,
        onStartReplay: () => {},
        onOpenLegend: () => {},
        ...over,
      }),
    );
  }

  it("常驻免责声明", () => {
    const html = renderGame();
    expect(html).toContain(GAME_DISCLAIMER);
    expect(html).toContain("不构成投资建议");
  });

  describe("结算复盘报告", () => {
    const report = (over: Partial<ReviewReport> = {}): ReviewReport => ({
      season: "2026-09",
      asOf: "2026-09-23",
      trades: [
        {
          id: "t1", date: "2026-09-23", code: "600519.SH", name: "贵州茅台",
          side: "buy", price: 100, shares: 200, typeAtTrade: "趋势观察",
          laterPct: 10, aligned: "aligned",
        },
        {
          id: "t2", date: "2026-09-23", code: "000001.SZ", name: "平安银行",
          side: "buy", price: 10, shares: 100, typeAtTrade: "高位观察",
          laterPct: -5, aligned: "against",
        },
      ],
      counts: { aligned: 1, against: 1, unknown: 0 },
      alignedAvgPct: 10,
      againstAvgPct: -5,
      holdings: [
        { code: "600519.SH", name: "贵州茅台", shares: 200, avgCost: 100, pnlPct: 10, traded: true },
        { code: "000001.SZ", name: "平安银行", shares: 100, avgCost: 12, pnlPct: -16.67, traded: false },
      ],
      finalAssets: 1_012_000,
      caveats: REVIEW_CAVEATS,
      ...over,
    });

    it("结算前整块不出现 —— 它只在点过「结算本季」之后渲染", () => {
      // GameView 里 lastReview 初始为 null，所以静态渲染的页面里没有复盘
      expect(renderGame()).not.toContain("别把这张表当成评分");
    });

    it("逐笔列出日期、方向、成交价、当时分类与成交后涨跌", () => {
      const html = renderReview(report());
      expect(html).toContain("贵州茅台");
      expect(html).toContain("2026-09-23 买入");
      expect(html).toContain("当时「趋势观察」");
      expect(html).toContain("与当时分类同向");
      expect(html).toContain("与当时分类反向");
      expect(html).toContain("10%");
      expect(html).toContain("-5%");
    });

    it("两组平均各自带笔数", () => {
      const html = renderReview(report());
      expect(html).toContain("同向的那几笔");
      expect(html).toContain("1 笔 · 之后平均 10%");
      expect(html).toContain("1 笔 · 之后平均 -5%");
    });

    it("老记录没有当时分类时说「记录里没有」，不猜", () => {
      const html = renderReview(
        report({
          trades: [
            {
              id: "old", date: "2026-09-01", code: "600519.SH", name: "贵州茅台",
              side: "buy", price: 100, shares: 100, laterPct: null, aligned: "unknown",
            },
          ],
          counts: { aligned: 0, against: 0, unknown: 1 },
          alignedAvgPct: null,
          againstAvgPct: null,
        }),
      );
      expect(html).toContain("当时分类未记录");
      expect(html).toContain("记录里没有分类");
      expect(html).toContain("没法回答「有没有按依据做」");
      // 取不到价时说「—」，不是编一个 0%
      expect(html).toContain("—");
    });

    it("那几条提醒一条都不能少，尤其是「引擎没有测出优势」", () => {
      const html = renderReview(report());
      expect(html).toContain("没有测出优势");
      expect(html).toContain("不是对错");
      expect(html).toContain("别把这张表当成评分");
      expect(html).toContain("没有因果关系");
    });

    it("持仓区分动过与没动过", () => {
      const html = renderReview(report());
      expect(html).toContain("本季动过");
      expect(html).toContain("本季没动过");
    });

    it("复盘里不许出现褒贬与买卖建议", () => {
      const html = renderReview(report());
      for (const bad of [
        "判断正确", "判断错误", "英明", "失误", "应该买", "应该卖",
        "建议买入", "建议卖出", "必涨", "必跌", "稳赚", "目标价", "抄底",
      ]) {
        expect(html, `不该出现「${bad}」`).not.toContain(bad);
      }
    });
  });

  describe("你不在的这段时间", () => {
    const HOUR = 3600_000;
    const T0 = 1_700_000_000_000;

    /** 走前记了一笔：茅台 100 元 */
    const mark = makeMark(T0, 900_000, [
      { code: "600519.SH", name: "贵州茅台", shares: 200, price: 100 },
    ]);
    const now = (price: number) =>
      awayReport(
        mark,
        {
          at: T0 + 20 * HOUR,
          cash: 900_000,
          positions: [{ code: "600519.SH", name: "贵州茅台", shares: 200, price }],
        },
        [],
      );

    it("没有报告时整张卡片都不出现", () => {
      expect(renderGame()).not.toContain("你不在的这段时间");
    });

    it("有报告时显示时长、逐条对比与合计", () => {
      const html = renderGame({ away: now(110), onDismissAway: () => {} });
      expect(html).toContain("你不在的这段时间");
      expect(html).toContain("离开 20 小时 0 分钟");
      expect(html).toContain("贵州茅台");
      // 金额格式沿用全站一致的 fmtNum（不带千分位）—— 单独在这里加分隔符
      // 会让同一个数字在「账户总览」和这张卡片里长得不一样
      expect(html).toContain("100 → 110");
      expect(html).toContain("+2000");
    });

    it("下跌显示负数，不取绝对值", () => {
      const html = renderGame({ away: now(90), onDismissAway: () => {} });
      expect(html).toContain("-2000");
      expect(html).toContain("-10%");
    });

    it("价格没动时明说「可能只是休市」，不渲染成结论", () => {
      const html = renderGame({ away: now(100), onDismissAway: () => {} });
      expect(html).toContain("可能只是这段时间休市");
    });

    it("必须说清这是两次估值的差，不是「不在时赚的钱」", () => {
      const html = renderGame({ away: now(110), onDismissAway: () => {} });
      expect(html).toContain("两次估值的差");
      expect(html).toContain("不是「你不在时赚了多少钱」");
    });

    it("期间有成交时把成交笔数与「不能互相印证」的提醒一起显示", () => {
      const r = awayReport(
        mark,
        {
          at: T0 + 20 * HOUR,
          cash: 900_000,
          positions: [{ code: "600519.SH", name: "贵州茅台", shares: 200, price: 110 }],
        },
        [
          {
            id: "x", at: T0 + HOUR, date: "2026-01-01", code: "A", name: "甲",
            side: "buy", price: 1, shares: 100, amount: 100, fee: 0,
          },
        ] as never,
      );
      const html = renderGame({ away: r, onDismissAway: () => {} });
      expect(html).toContain("1 笔");
      expect(html).toContain("不能互相印证");
    });

    it("取不到价的持仓被单独列出来，不静默丢掉", () => {
      const r = awayReport(
        makeMark(T0, 0, [
          { code: "600519.SH", name: "贵州茅台", shares: 100, price: 100 },
          { code: "999999.SH", name: "无行情股", shares: 100, price: 50 },
        ]),
        {
          at: T0 + 20 * HOUR,
          cash: 0,
          positions: [
            { code: "600519.SH", name: "贵州茅台", shares: 100, price: 110 },
            { code: "999999.SH", name: "无行情股", shares: 100, price: null },
          ],
        },
        [],
      );
      const html = renderGame({ away: r, onDismissAway: () => {} });
      expect(html).toContain("没算进去");
      expect(html).toContain("无行情股");
      expect(html).toContain("宁可不算，也不编一个数");
    });

    it("这张卡片里不许出现买卖建议", () => {
      const html = renderGame({ away: now(110), onDismissAway: () => {} });
      for (const bad of ["建议买入", "建议卖出", "推荐买", "必涨", "必跌", "稳赚", "目标价", "抄底"]) {
        expect(html, `不该出现「${bad}」`).not.toContain(bad);
      }
    });
  });

  it("不出现任何引导性/建议性文案", () => {
    const html = renderGame();
    for (const w of ["建议买入", "建议卖出", "推荐", "看涨", "看跌", "抄底", "稳赚", "必赚", "目标价"]) {
      expect(html.includes(w), `模拟游戏出现引导性文案「${w}」`).toBe(false);
    }
  });

  it("账户总览与超额收益都渲染", () => {
    const html = renderGame();
    expect(html).toContain("总资产");
    expect(html).toContain("超额收益");
    expect(html).toContain("沪深300");
    // 1,012,000 相对本金 1,000,000 → +1.20%
    expect(html).toContain("1.2");
  });

  it("持仓渲染，且无行情时不编造盈亏", () => {
    const html = renderGame();
    expect(html).toContain("贵州茅台");
    expect(html).toContain("可卖 100");
    // 取不到行情的持仓必须明说，不能显示 0 或猜测
    expect(html).toContain("无行情，不估算盈亏");
  });

  it("成交记录带非交易时段标注与当时分类", () => {
    const html = renderGame();
    expect(html).toContain("非交易时段下单");
    expect(html).toContain("趋势观察");
  });

  it("非交易时段给出明确提示", () => {
    const html = renderGame();
    expect(html).toContain("已收盘");
    expect(html).toContain("按最近收盘价成交");
  });

  it("新闻排在交易之前（信息 → 决策的顺序）", () => {
    const html = renderGame();
    const iAccount = html.indexOf("账户总览");
    const iNews = html.indexOf("市场快讯");
    const iOrder = html.indexOf("模拟下单");
    expect(iAccount).toBeGreaterThanOrEqual(0);
    expect(iNews).toBeGreaterThanOrEqual(0);
    expect(iOrder).toBeGreaterThanOrEqual(0);
    // 账户状态 → 新闻 → 下单，顺序不能反：
    // 新闻是决策依据，放在交易之后会让人先下完单才看到消息
    expect(iAccount).toBeLessThan(iNews);
    expect(iNews).toBeLessThan(iOrder);
  });

  it("无持仓无成交时不崩，给引导文案", () => {
    const empty = startGame(200_000, 0);
    const html = renderGame({ state: empty, totalAssets: empty.account.cash, holdingsValue: 0 });
    expect(plain(html)).toContain("暂无持仓");
    expect(plain(html)).toContain("暂无成交记录");
  });
  it("实时模式已经开局了，历史推演的入口还在", () => {
    // 用户踩到的：先开一局实时，想再玩传奇模式时，入口整张卡都不见了 ——
    // 只画在未开局的那张界面上。想玩推演就只能把实时那份存档重置掉。
    const html = renderGame({
      replayReady: true,
      onStartReplay: () => {},
      onOpenLegend: () => {},
    });
    expect(html).toContain("账户总览"); // 确认是「进行中」那张界面
    expect(html).toContain("历史推演");
    expect(html).toContain("传奇模式 · 10 个历史时刻");
    expect(html).toContain("随机开局（不显示日期）");
  });
  it("推演在跑的时候，进行中的这张界面也只给「回去」", () => {
    const html = renderGame({
      replayReady: true,
      replayInProgress: true,
      onStartReplay: () => {},
      onOpenLegend: () => {},
      onResumeReplay: () => {},
    });
    expect(html).toContain("回到正在跑的那一局");
    expect(html).not.toContain("传奇模式 · 10 个历史时刻");
  });


});

// ── 交易信号渲染 ─────────────────────────────────────────────

describe("交易信号渲染", () => {
  const code = devSnapshot.expected.stock.code;
  const stock = devSnapshot.stocks.find((s) => s.code === code) as StockData;
  const signal = deriveSignal(stock, defaultRules);

  it("信号卡渲染动作、强度与三个参考价位", () => {
    const html = renderToStaticMarkup(createElement(SignalCard, { signal }));
    expect(html).toContain("交易信号");
    expect(html).toContain(signal.action);
    expect(html).toContain(`${signal.strength} / 100`);
    expect(html).toContain("参考买入价");
    expect(html).toContain("参考止损价");
    expect(html).toContain("参考目标价");
    expect(html).toContain("20 日压力位");
  });

  it("如实披露信号无有效区分度", () => {
    const html = renderToStaticMarkup(createElement(SignalCard, { signal }));
    // 文案随回测结论更新，这里断言的是"必须如实披露"这件事本身
    expect(html).toContain(SIGNAL_BACKTEST_CAVEAT);
    expect(html).toContain("无证据支持有效");
    expect(html).toContain("与噪声无法区分");
  });

  it("明确标注参考价位是技术测算而非承诺", () => {
    const html = renderToStaticMarkup(createElement(SignalCard, { signal }));
    expect(html).toContain("技术测算");
    expect(html).toContain("不构成收益承诺");
  });

  it("信号总览按强度排序并给出动作计数", () => {
    const signals = deriveSignals(devSnapshot.stocks, defaultRules);
    const html = renderToStaticMarkup(createElement(SignalSummary, { signals }));
    expect(html).toContain("今日信号");
    expect(html).toContain(`全池 ${signals.length} 只`);
    // 首条应当是强度最高的那只
    expect(html).toContain(signals[0].name);
  });

  it("空信号列表不渲染总览（避免空卡片）", () => {
    const html = renderToStaticMarkup(createElement(SignalSummary, { signals: [] }));
    expect(html).toBe("");
  });

  it("强度配色区分看多与看空", () => {
    const strong = deriveSignal(makeStockLike(), defaultRules);
    const html = renderToStaticMarkup(createElement(SignalBadge, { signal: strong }));
    expect(html).toMatch(/signal-(good|bad|muted)/);
  });
});

/** 造一只简单上涨股，用于配色断言 */
function makeStockLike(): StockData {
  const close: number[] = [];
  for (let i = 0; i < 120; i += 1) close.push(100 + i * 0.5);
  return {
    code: "TEST.SH",
    name: "测试",
    industry: "测试",
    industryCode: "801000.SI",
    weight: 1,
    isST: false,
    close,
    high: close.map((c) => c * 1.01),
    low: close.map((c) => c * 0.99),
    volume: close.map(() => 1000),
  };
}

// ── 规则讲解页渲染 ───────────────────────────────────────────

describe("规则讲解页渲染", () => {
  const html = renderToStaticMarkup(createElement(GameRulesView, { onBack: () => {} }));

  it("覆盖全部关键规则", () => {
    const text = plain(html);
    for (const topic of ["T+1", "涨跌停", "佣金", "印花税", "过户费", "滑点", "一手", "沪深300", "风险报酬比"]) {
      expect(text.includes(topic), `规则页缺少「${topic}」`).toBe(true);
    }
  });

  it("费率数字来自 @aw/game 常量，不是硬编码", () => {
    // 10 万元来回费用：买入 25+1=26、卖出 25+100+1=126，合计 152
    expect(html).toContain("152");
    // 占比 0.152%
    expect(html).toContain("0.152");
  });

  it("明确说明参考价位是技术测算而非承诺", () => {
    expect(html).toContain("技术测算而非承诺");
  });

  it("说明非交易时段为何按最新价而非排队开盘价", () => {
    expect(html).toContain("排队");
    expect(html).toContain("开盘价");
  });
});

// ── 使用说明页渲染 ───────────────────────────────────────────

/**
 * 术语高亮会把一个词渲染成 `<button>`。若它落在另一个按钮或链接里面，就是非法
 * 的嵌套可交互元素 —— 浏览器会把标签拆开重排，用户看到的是「点了没反应」。
 *
 * 上面每个页面的断言都只看文案，看不出这件事，所以单独立一条守着。
 */
function nestedButtonsIn(html: string): string[] {
  const bad: string[] = [];
  for (const m of html.matchAll(/<button[\s\S]*?<\/button>/g)) {
    // 只看**内部**：m[0] 必然含它自己的 `<button` 开标签
    const inner = m[0].replace(/^<button[^>]*>/, "").replace(/<\/button>$/, "");
    if (inner.includes("<button") || inner.includes("<a ")) bad.push(m[0]);
  }
  return bad;
}

describe("术语高亮：正文里也不能造出嵌套按钮", () => {
  it("规则讲解页与使用说明页都干净（这两页正文最多，术语也最密）", () => {
    const pages: Array<[string, string]> = [
      ["规则讲解页", renderToStaticMarkup(createElement(GameRulesView, { onBack: () => {} }))],
      ["使用说明页", renderToStaticMarkup(createElement(GuideView, { onBack: () => {} }))],
    ];
    for (const [name, html] of pages) {
      expect(nestedButtonsIn(html), `${name}里有嵌套的按钮/链接`).toEqual([]);
    }
  });
});

describe("使用说明页渲染", () => {
  const html = renderToStaticMarkup(createElement(GuideView, { onBack: () => {} }));

  it("覆盖三个页面与六种分类", () => {
    for (const kw of ["筛选", "个股分析", "模拟游戏"]) {
      expect(html.includes(kw), `缺少页面说明「${kw}」`).toBe(true);
    }
    for (const kw of ["启动观察", "趋势观察", "回调观察", "高位观察", "排除", "数据不足"]) {
      expect(html.includes(kw), `缺少分类说明「${kw}」`).toBe(true);
    }
  });

  it("导航改成三条之后，说明页不再写「五个页面」", () => {
    // 底栏和说明页是同一件事的两处说法，改了一处忘了另一处，
    // 用户就会照着说明去找一个不存在的按钮。
    expect(html).toContain("三个页面");
    expect(html).not.toContain("五个页面");
    expect(html).toContain("右上角的齿轮");
  });

  it("教用户怎么读判断依据", () => {
    expect(html).toContain("怎么读");
    expect(html).toContain("未通过");
  });

  it("说明【数据不足，不许编造】不是故障", () => {
    expect(html).toContain(NOT_ENOUGH_BANNER);
    expect(html).toContain("它不会猜");
  });

  it("如实告知交易信号无效——这是最重要的一条", () => {
    expect(html).toContain("没有证据支持它有效");
    expect(html).toContain("和随机无法区分");
    expect(html).toContain("当交易依据不行");
  });

  it("讲清模拟游戏规则与免责", () => {
    const text = plain(html);
    for (const kw of ["T+1", "涨跌停", "佣金", "印花税", "滑点", "超额收益"]) {
      expect(text.includes(kw), `缺少规则说明「${kw}」`).toBe(true);
    }
    expect(html).toContain("不构成投资建议");
  });


});

describe("模拟游戏开局界面", () => {
  function renderSetup(replayReady = false, replayInProgress = false): string {
    return renderToStaticMarkup(
      createElement(GameView, {
        state: defaultGameState(), // status = "idle"
        prices: new Map(),
        quotesByCode: new Map(),
        stocks: [],
        resultsByCode: new Map(),
        onOrder: () => ({ ok: true }),
        onStart: () => {},
        onReset: () => {},
        onSettle: () => null,
        onOpenRules: () => {},
        news: stubNews(),
        sessionText: "已收盘",
        isTradingNow: false,
        today: "2026-09-30",
        benchmarkName: "沪深300",
        benchmarkReturnPct: null,
        totalAssets: 0,
        holdingsValue: 0,
        replayReady,
        onStartReplay: () => {},
        onOpenLegend: () => {},
        replayInProgress,
        onResumeReplay: () => {},
      }),
    );
  }

  it("给历史推演留了入口（否则整套引擎没有地方进）", () => {
    const html = renderSetup();
    expect(html).toContain("历史推演");
    expect(html).toContain("把你放回真实的某一天");
  });

  it("快照带开盘价时给得出随机开局按钮", () => {
    const html = renderSetup(true);
    expect(html).toContain("随机开局");
    expect(html).not.toContain("没有开盘价");
  });

  it("传奇模式排在随机前面，而且是主按钮", () => {
    const html = renderSetup(true);
    const legend = html.indexOf("传奇模式 · 10 个历史时刻");
    const random = html.indexOf("随机开局（不显示日期）");
    expect(legend).toBeGreaterThan(-1);
    expect(random).toBeGreaterThan(-1);
    expect(legend, "传奇应该排在随机之前").toBeLessThan(random);
    // 主按钮是 btn-primary；两个按钮各自的那一段里检查
    const legendTag = html.slice(html.lastIndexOf("<button", legend), legend);
    const randomTag = html.slice(html.lastIndexOf("<button", random), random);
    expect(legendTag).toContain("btn-primary");
    expect(randomTag).not.toContain("btn-primary");
  });

  it("传奇模式已经做好了，页面上不该再出现「还没做」", () => {
    // 这句是传奇模式建好之前留下的，上线后被用户看到才发现的
    expect(renderSetup(true)).not.toContain("还没做");
    expect(renderSetup(true)).not.toContain("随机模式是它的地基");
  });

  it("两条路的区别说清楚了：传奇给日期，随机不给", () => {
    // 只断言「这个区别确实写在界面上」，不锁死具体措辞 —— 文案会改，区别不能丢
    const html = renderSetup(true);
    expect(html).toContain("给完整日期");
    expect(html).toContain("不告诉你这是哪一年哪一天");
    expect(html).toContain("差别只在开局那一步");
  });

  it("快照没有开盘价时说明为什么做不了推演", () => {
    const html = renderToStaticMarkup(
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
        news: stubNews(),
        sessionText: "已收盘",
        isTradingNow: false,
        today: "2026-09-30",
        benchmarkName: "沪深300",
        benchmarkReturnPct: null,
        totalAssets: 0,
        holdingsValue: 0,
        replayReady: false,
        onStartReplay: () => {},
        onOpenLegend: () => {},
      }),
    );
    expect(plain(html)).toContain("没有开盘价");
    expect(html).not.toContain("随机开局（不显示日期）");
  });

  it("未开局时显示资金选择，而不是一个空账户", () => {
    const html = renderSetup();
    expect(html).toContain("实时模式");
    for (const c of CASH_OPTIONS) {
      expect(html).toContain(`${c / 10000} 万`);
    }
    // 不应该出现交易界面
    expect(html).not.toContain("模拟下单");
    expect(html).not.toContain("账户总览");
  });

  it("开局界面也常驻免责声明", () => {
    expect(renderSetup()).toContain(GAME_DISCLAIMER);
  });

  it("两张卡各叫各的名字，不再写「另一种玩法」", () => {
    // 用户提的：把「开始一局」改个名字，「另一个玩法：」去掉 ——
    // 并列的两个入口不需要分主次，标题直接写模式名就够了
    const html = renderSetup(true);
    expect(html).toContain("实时模式");
    expect(html).toContain("历史推演");
    expect(html).not.toContain("开始一局");
    expect(html).not.toContain("另一种玩法");
  });

  it("已经有一局推演在跑时，只给「回去」，不再给开局按钮", () => {
    // 两边的存档是分开的（aw.game.v1 / aw.replay.v1），实时模式不该被清掉；
    // 但也不能让玩家顺手再开一局把正在跑的那局冲掉
    const html = renderSetup(true, true);
    expect(html).toContain("回到正在跑的那一局");
    expect(html).toContain("各存各的");
    expect(html).not.toContain("传奇模式 · 10 个历史时刻");
    expect(html).not.toContain("随机开局（不显示日期）");
    // 实时模式那半边照常
    expect(html).toContain("以 20 万开始");
  });

  it("讲清了资金量对选股的限制", () => {
    const html = renderSetup();
    // 「一手」现在是个术语按钮，会被切成两段，所以看读到的文字
    expect(plain(html)).toContain("一手 100 股");
    // 简化文案时把「为什么要有资金档位」压缩成了一句，但这个事实不能丢
    expect(plain(html)).toContain("一手 100 股");
    expect(plain(html)).toContain("买不起一手高价股");
  });
});

// ── 新闻面板渲染 ─────────────────────────────────────────────

describe("新闻面板渲染", () => {
  const mk = (id: string, title: string, digest = "", at = Date.now()): NewsItem => ({
    id,
    title,
    digest,
    at,
    source: "东方财富 7x24",
    timeKnown: true,
  });

  function renderNews(over: Partial<Parameters<typeof NewsPanel>[0]> = {}): string {
    return renderToStaticMarkup(
      createElement(NewsPanel, {
        items: [mk("1", "央行开展逆回购操作"), mk("2", "贵州茅台发布半年报")],
        source: "东方财富 7x24",
        degradedReason: null,
        updatedAt: Date.now(),
        loading: false,
        onRefresh: () => {},
        holdings: [],
        ...over,
      }),
    );
  }

  it("渲染标题、时间与来源", () => {
    const html = renderNews();
    expect(html).toContain("央行开展逆回购操作");
    expect(html).toContain("东方财富 7x24");
    expect(html).toContain("市场快讯");
  });

  it("明确声明不标注利好利空", () => {
    const html = renderNews();
    expect(html).toContain("不标注利好利空");
    // 不能出现任何方向性措辞
    for (const w of ["利好", "利空", "看涨", "看跌", "建议买"]) {
      expect(html.includes(`>${w}<`), `不应出现 ${w}`).toBe(false);
    }
  });

  it("持仓相关新闻单独成栏，文案用「可能相关」而非断言", () => {
    const html = renderNews({ holdings: [{ code: "600519.SH", name: "贵州茅台" }] });
    expect(plain(html)).toContain("持仓相关新闻");
    expect(html).toContain("可能相关，不构成任何判断");
  });

  it("时间解析失败时显示「时间未知」，不显示 1970", () => {
    const html = renderNews({ items: [{ ...mk("9", "时间未知的新闻"), at: 0, timeKnown: false }] });
    expect(html).toContain("时间未知");
    expect(html).not.toContain("1970");
  });

  it("取不到新闻时明说，不编造", () => {
    const html = renderNews({ items: [], degradedReason: "东财快讯 HTTP 501" });
    expect(html).toContain("暂时没有取到新闻");
    expect(html).toContain("东财快讯 HTTP 501");
  });

  it("降级时显示提示", () => {
    const html = renderNews({ degradedReason: "已降级到 x" });
    expect(html).toContain("新闻获取异常");
  });

  it("有原文地址时给出可点的链接，并开在新标签页", () => {
    const html = renderNews({
      items: [
        { ...mk("1", "央行开展逆回购操作"), url: "https://news.10jqka.com.cn/20260930/c680413883.shtml" },
      ],
    });
    expect(html).toContain('href="https://news.10jqka.com.cn/20260930/c680413883.shtml"');
    expect(html).toContain('target="_blank"');
    // 站外链接必须带 noopener，否则对方页面能拿到 window.opener
    expect(html).toContain("noopener");
    expect(html).toContain("查看原文");
  });

  it("没有原文地址时不渲染空链接", () => {
    // mk() 默认不带 url
    const html = renderNews();
    expect(html).not.toContain("查看原文");
    expect(html).not.toContain('href="undefined"');
      expect(html).not.toContain('href=""');
  });

  it("链接在 button 外面 —— a 套在 button 里是非法 HTML", () => {
    const html = renderNews({
      items: [{ ...mk("1", "带链接的新闻"), url: "https://example.com/a" }],
    });
    // 取每个 <button ...>…</button> 的内容，里面都不该有 <a>
    const buttons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b.includes("<a "), `button 里出现了 <a>：${b.slice(0, 80)}`).toBe(false);
    }
  });
});

// ── 历史推演视图 ──────────────────────────────────────────────
// 这一屏是本学期新增玩法的主体，值得单独冒烟：它同时要展示
// 「你以为的价格」和「真实成交的价格」，还背着不剧透的责任。
describe("历史推演视图（ReplayView）", () => {
  const CAL = [
    "2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-08",
    "2024-01-09", "2024-01-10", "2024-01-11", "2024-01-12", "2024-01-15",
  ];

  function mkState() {
    // 用真引擎造状态（不是手搓 mock），保证组件拿到的就是运行时真实形状
    return createReplay({
      calendar: CAL,
      startIndex: 2,
      initialCash: 200_000,
      label: "随机开局",
      instruments: [
        {
          code: "600519.SH", name: "贵州茅台", isST: false,
          open: [1700, 1710, 1720, 1730, 1740, 1750, 1760, 1770, 1780, 1790],
          close: [1710, 1720, 1730, 1740, 1750, 1760, 1770, 1780, 1790, 1800],
          high: [1720, 1730, 1740, 1750, 1760, 1770, 1780, 1790, 1800, 1810],
          low: [1690, 1700, 1710, 1720, 1730, 1740, 1750, 1760, 1770, 1780],
          volume: [1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 1e6],
        },
      ],
    });
  }

  function renderReplay(over: Partial<Parameters<typeof ReplayView>[0]> = {}): string {
    return renderToStaticMarkup(
      createElement(ReplayView, {
        state: mkState(),
        hideDate: true,
        label: "随机开局",
        stocks: [] as StockData[],
        benchmarkName: "沪深300",
        onOrder: () => ({ ok: true }),
        onCancel: () => {},
        onAdvance: () => {},
        onExit: () => {},
        ...over,
      }),
    );
  }

  it("常驻免责声明", () => {
    expect(renderReplay()).toContain(GAME_DISCLAIMER);
  });

  it("隐藏日期时只给第几天，不给具体年月日", () => {
    const html = renderReplay({ hideDate: true });
    expect(html).toContain("第");
    // 开局日 2024-01-04 不能出现在页面上（否则玩家能反推是哪一段行情）
    expect(html).not.toContain("2024-01-04");
    expect(html).not.toContain("2024");
  });

  it("显示日期时给出具体交易日", () => {
    expect(renderReplay({ hideDate: false })).toContain("2024-01-04");
  });

  it("说明成交价来自次一交易日开盘价", () => {
    const html = renderReplay();
    expect(html).toContain("次一交易日");
    expect(html).toContain("开盘价");
  });

  it("提供走一天、快进与结算入口", () => {
    const html = renderReplay();
    expect(html).toContain("走一天");
    expect(html).toContain("快进");
    expect(html).toContain("结算");
  });

  it("藏日期时，日志里的真实日期也要被换成第几天", () => {
    // 引擎生成的日志句子以日期开头，直接渲染就把整段行情的时间泄露了
    const placed = placeOrder(mkState(), { code: "600519.SH", side: "buy", shares: 100 });
    const withTrade = advanceDay(placed.ok ? placed.state : mkState());

    const hidden = renderReplay({ state: withTrade, hideDate: true });
    expect(hidden).toContain("推演日志");
    expect(hidden).not.toMatch(/2024-\d\d-\d\d/);
    expect(hidden).toMatch(/第\s*2\s*天/);

    // 模式 2（传奇）本来就显示日期，不能被连累
    expect(renderReplay({ state: withTrade, hideDate: false })).toMatch(/2024-\d\d-\d\d/);
  });

  it("不允许对界面承诺收益", () => {
    const html = renderReplay();
    for (const word of ["必涨", "必跌", "稳赚", "包赚"]) {
      expect(html).not.toContain(word);
    }
  });
});

describe("传奇模式：关卡列表与开局简报", () => {
  const cashOptions = [100_000, 150_000, 200_000, 250_000, 300_000];

  function renderList(ready = true): string {
    return renderToStaticMarkup(
      createElement(LevelPicker, {
        ready,
        loadingId: null,
        error: null,
        onStart: () => {},
        onBack: () => {},
        cashOptions,
        defaultCash: 200_000,
      }),
    );
  }

  function renderDetail(levelId: string, ready = true): string {
    const level = LEVELS.find((l) => l.id === levelId)!;
    return renderToStaticMarkup(
      createElement(LevelDetail, {
        level,
        ready,
        loading: false,
        error: null,
        cash: 200_000,
        cashOptions,
        onCash: () => {},
        onStart: () => {},
        onBack: () => {},
      }),
    );
  }

  it("列出全部 10 关，每关都带上真实日期", () => {
    const html = renderList();
    expect(LEVELS).toHaveLength(10);
    for (const l of LEVELS) {
      expect(html, `缺了 ${l.title}`).toContain(l.title);
      expect(html, `缺了 ${l.startDate}`).toContain(l.startDate);
    }
  });

  it("没有关卡数据时说明原因，而不是给一个点不动的按钮", () => {
    const html = renderList(false);
    expect(html).toContain("还没有关卡数据");
    expect(html).not.toContain("进入 20");
  });

  /**
   * 传奇模式的规则是**日期照实显示**（用户定的：纪念性复盘，不是猜谜）。
   * 所以这里断言日期必须在，和随机模式那条「不许出现日期」正好相反。
   */
  it("简报页显示进场日期，不是藏着", () => {
    const html = renderDetail("2020-02-03");
    expect(html).toContain("2020-01-14"); // 入场日
    expect(html).toContain("春节之后");
    expect(html).toContain("进场那天能看到的");
  });

  it("简报页把简报的每一条都渲染出来", () => {
    const level = LEVELS.find((l) => l.id === "2020-02-03")!;
    const html = renderDetail("2020-02-03");
    for (const line of level.briefing) expect(html).toContain(line);
    expect(html).toContain(level.theme);
  });

  /**
   * 组件不解析 markdown，所以文案里不能有 `**`。
   * packages/game 那边也有一条同样的用例；这里再测一次渲染结果，
   * 是因为真正会难看的地方是页面，不是数据。
   */
  it("渲染出来的简报里不该出现 markdown 星号", () => {
    for (const l of LEVELS) {
      const html = renderDetail(l.id);
      expect(html, `关卡 ${l.id} 的页面里有 ** 星号`).not.toContain("**");
    }
  });

  /**
   * 和其它所有页面一样，红线扫一遍。
   * 关卡文案是这轮新写的，最容易顺手写出「该买入了」这类话。
   */
  it("关卡列表和每一关的简报都不出现买卖建议字样", () => {
    const banned = ["建议买入", "建议卖出", "推荐买", "必涨", "必跌", "稳赚", "目标价", "抄底", "满仓干"];
    const pages = [renderList(), renderList(false), ...LEVELS.map((l) => renderDetail(l.id))];
    for (const html of pages) {
      for (const w of banned) expect(html, `页面里出现了「${w}」`).not.toContain(w);
    }
  });

  it("所有关卡页面都带免责声明", () => {
    for (const l of LEVELS) expect(renderDetail(l.id)).toContain("不构成投资建议");
    expect(renderList()).toContain("不构成投资建议");
  });
});

/**
 * 「模拟下单」里的选股清单。
 *
 * 这一块是为了修一个真实的可用性问题：原来只有一个空输入框 + `<datalist>`，
 * 而 datalist 在 iOS Safari 上根本不弹 —— 玩家盯着空白框不知道买什么。
 * 所以下面几条断言盯的都是「界面上到底有没有把票列出来」。
 */
describe("选股清单：玩家不必自己知道买哪只", () => {
  const rows: PickStock[] = [
    { code: "600519.SH", name: "贵州茅台", sector: "食品饮料", price: 1235.58, changePct: 2.31, amount: 4.2e9 },
    { code: "002714.SZ", name: "牧原股份", sector: "农林牧渔", price: 42.29, changePct: -1.5, amount: 1.1e9 },
    { code: "601988.SH", name: "中国银行", sector: "银行", price: 5.1, changePct: 0.2, amount: 8.8e8 },
  ];

  function renderPicker(over: Partial<Parameters<typeof StockPicker>[0]> = {}): string {
    return renderToStaticMarkup(
      createElement(StockPicker, { rows, query: "", onPick: () => {}, ...over }),
    );
  }

  it("默认就把票列出来，不是等人输入", () => {
    const html = renderPicker();
    expect(html).toContain("贵州茅台");
    expect(html).toContain("牧原股份");
  });

  it("每行带板块和涨跌幅，玩家才有判断依据", () => {
    const html = renderPicker();
    expect(html).toContain("食品饮料");
    expect(html).toContain("2.31%");
    expect(html).toContain("-1.5%");
  });

  it("涨跌幅按红涨绿跌上色", () => {
    const html = renderPicker();
    expect(html).toContain("chg-up");
    expect(html).toContain("chg-down");
  });

  it("三行都是按钮 —— 点一下只是把代码填进输入框，不直接下单", () => {
    const html = renderPicker();
    expect(html.match(/class="pick-row/g)?.length).toBe(3);
    expect(html).toContain("<button");
  });

  it("三种问法都在：涨得最猛 / 跌得最狠 / 成交最热", () => {
    const html = renderPicker();
    expect(html).toContain("涨得最猛");
    expect(html).toContain("跌得最狠");
    expect(html).toContain("成交最热");
  });

  it("写了「不知道买什么」，直接对着不会选股的人说话", () => {
    expect(renderPicker()).toContain("不知道买什么");
  });

  it("榜单下面必须写明不是推荐，这一条是模拟游戏和分析引擎的分界线", () => {
    expect(renderPicker()).toContain("不是推荐");
  });

  it("输入了就换成搜索结果，并说清楚匹配到几只", () => {
    const html = renderPicker({ query: "茅台" });
    expect(html).toContain("匹配到 1 只");
    expect(html).toContain("贵州茅台");
    expect(html).not.toContain("牧原股份");
  });

  it("没匹配上时说清楚原因，并提醒历史推演只有当时已上市的票", () => {
    const html = renderPicker({ query: "特斯拉" });
    expect(html).toContain("没找到这只票");
    expect(html).toContain("当时已经上市");
  });

  it("搜索时不再显示排序按钮（这时候用不上）", () => {
    expect(renderPicker({ query: "茅台" })).not.toContain("涨得最猛");
  });

  it("池子是空的就说没有行情，而不是显示一个空盒子", () => {
    expect(renderPicker({ rows: [] })).toContain("还没有可下单的行情");
  });

  it("没有查询词时不显示「没找到」", () => {
    expect(renderPicker()).not.toContain("没找到这只票");
  });
});
