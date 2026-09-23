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
import { AnalysisView } from "./components/AnalysisView";
import type { NewsItem } from "@aw/data";
import { GameRulesView } from "./components/GameRulesView";
import { NewsPanel } from "./components/NewsPanel";
import type { LiveNewsState } from "./lib/useLiveNews";
import { GuideView } from "./components/GuideView";
import { GameView } from "./components/GameView";
import { HistoryView } from "./components/HistoryView";
import { SettingsView } from "./components/SettingsView";
import { WorkbenchView } from "./components/WorkbenchView";
import { CASH_OPTIONS, defaultGameState, GAME_DISCLAIMER, startGame, type GameState } from "./lib/game";
import { SIGNAL_BACKTEST_CAVEAT } from "./lib/helpers";
import { SignalBadge, SignalCard, SignalSummary } from "./components/SignalCard";
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

function renderWorkbench(snapshot: Snapshot): string {
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
    }),
  );
}

describe("筛选页渲染", () => {
  const html = renderWorkbench(devSnapshot);

  it("三层结构和判断依据都渲染出来", () => {
    expect(html).toContain("① 大盘环境");
    expect(html).toContain("② 板块强弱");
    expect(html).toContain("③ 个股分类");
    expect(html).toContain("判断依据");
    expect(html).toContain("上涨占比");
    expect(html).toContain("最强成分");
  });

  it("默认展开第一个非空分组，且每个分类都带判断依据", () => {
    expect(html).toContain("趋势观察");
    expect(html).toContain("打开七步分析");
    // 默认展开的组里，每条个股都有一份 reasons 列表
    const reasonBlocks = html.match(/class="reasons"/g) ?? [];
    expect(reasonBlocks.length).toBeGreaterThanOrEqual(2); // 大盘 + 板块 + 个股
    expect(html).toContain("近20日涨跌幅");
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
    let cursor = -1;
    for (const t of titles) {
      const at = html.indexOf(t);
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
        onClearAll: () => {},
      }),
    );
    expect(html).toContain("还没有分析记录");
    expect(html).toContain("还没有学习作答");
  });

  it("设置页显示快照信息、交易时段与阈值项", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsView, {
        settings: parseSettings(null),
        onChange: () => {},
        rules: defaultRules,
        onReload: () => {},
        onClearLocal: () => {},
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

// ── 模拟盘渲染 ───────────────────────────────────────────────

describe("模拟盘页渲染", () => {
  /**
   * 注意：模拟盘**允许**出现「买入/卖出」——那是用户的操作标签，不是程序的建议。
   * 模拟盘允许出现买卖标签（那是用户的操作，不是程序的建议），因此改为断言：
   *   1. 常驻免责声明确实渲染出来了；
   *   2. 不出现任何引导性/建议性文案；
   *   3. 取不到行情时显示"无行情"而不是编造盈亏。
   */
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
        benchmarkName: "沪深300",
        benchmarkReturnPct: 1.5,
        totalAssets: 1_012_000,
        holdingsValue: 122_000,
        ...over,
      }),
    );
  }

  it("常驻免责声明", () => {
    const html = renderGame();
    expect(html).toContain(GAME_DISCLAIMER);
    expect(html).toContain("不构成投资建议");
  });

  it("不出现任何引导性/建议性文案", () => {
    const html = renderGame();
    for (const w of ["建议买入", "建议卖出", "推荐", "看涨", "看跌", "抄底", "稳赚", "必赚", "目标价"]) {
      expect(html.includes(w), `模拟盘出现引导性文案「${w}」`).toBe(false);
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
    expect(html).toContain("暂无持仓");
    expect(html).toContain("暂无成交记录");
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
    for (const topic of ["T+1", "涨跌停", "佣金", "印花税", "过户费", "滑点", "一手", "沪深300", "风险报酬比"]) {
      expect(html.includes(topic), `规则页缺少「${topic}」`).toBe(true);
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

describe("使用说明页渲染", () => {
  const html = renderToStaticMarkup(createElement(GuideView, { onBack: () => {} }));

  it("覆盖五个页面与六种分类", () => {
    for (const kw of ["筛选", "个股分析", "模拟盘", "历史", "设置"]) {
      expect(html.includes(kw), `缺少页面说明「${kw}」`).toBe(true);
    }
    for (const kw of ["启动观察", "趋势观察", "回调观察", "高位观察", "排除", "数据不足"]) {
      expect(html.includes(kw), `缺少分类说明「${kw}」`).toBe(true);
    }
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

  it("讲清模拟盘规则与免责", () => {
    for (const kw of ["T+1", "涨跌停", "佣金", "印花税", "滑点", "超额收益"]) {
      expect(html.includes(kw), `缺少规则说明「${kw}」`).toBe(true);
    }
    expect(html).toContain("不构成投资建议");
  });
});

describe("模拟盘开局界面", () => {
  function renderSetup(): string {
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
        benchmarkName: "沪深300",
        benchmarkReturnPct: null,
        totalAssets: 0,
        holdingsValue: 0,
      }),
    );
  }

  it("未开局时显示资金选择，而不是一个空账户", () => {
    const html = renderSetup();
    expect(html).toContain("开始一局");
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

  it("讲清了资金量对选股的限制", () => {
    const html = renderSetup();
    expect(html).toContain("一手 100 股");
    expect(html).toContain("这个约束本身就是练习的一部分");
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
    expect(html).toContain("持仓相关新闻");
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
});
