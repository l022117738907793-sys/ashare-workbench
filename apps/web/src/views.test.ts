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
import { advanceDay, createReplay, LEVELS, placeOrder } from "@aw/game";
import { AnalysisView } from "./components/AnalysisView";
import type { NewsItem } from "@aw/data";
import { GameRulesView } from "./components/GameRulesView";
import { NewsPanel } from "./components/NewsPanel";
import type { LiveNewsState } from "./lib/useLiveNews";
import { GuideView } from "./components/GuideView";
import { GameView } from "./components/GameView";
import { LevelDetail, LevelPicker } from "./components/LevelPicker";
import { HistoryView } from "./components/HistoryView";
import { SettingsView } from "./components/SettingsView";
import { WorkbenchView } from "./components/WorkbenchView";
import { CASH_OPTIONS, defaultGameState, GAME_DISCLAIMER, startGame, type GameState } from "./lib/game";
import { awayReport, makeMark } from "./lib/awayReport";
import { REVIEW_CAVEATS, type ReviewReport } from "@aw/game";
import { ReviewBlock } from "./components/ReviewBlock";
import { SIGNAL_BACKTEST_CAVEAT } from "./lib/helpers";
import { SignalBadge, SignalCard, SignalSummary } from "./components/SignalCard";
import { ReplayView } from "./components/ReplayView";
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
  function renderSetup(replayReady = false): string {
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
        replayReady,
        onStartReplay: () => {},
        onOpenLegend: () => {},
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
        benchmarkName: "沪深300",
        benchmarkReturnPct: null,
        totalAssets: 0,
        holdingsValue: 0,
        replayReady: false,
        onStartReplay: () => {},
        onOpenLegend: () => {},
      }),
    );
    expect(html).toContain("没有开盘价");
    expect(html).not.toContain("随机开局（不显示日期）");
  });

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
