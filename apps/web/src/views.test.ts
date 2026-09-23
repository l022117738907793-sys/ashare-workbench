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
  learningQuestions,
  type Snapshot,
  type StockData,
} from "@aw/core";
import { AnalysisView } from "./components/AnalysisView";
import { HistoryView } from "./components/HistoryView";
import { SettingsView } from "./components/SettingsView";
import { WorkbenchView } from "./components/WorkbenchView";
import {
  EMPTY_STORE,
  filterStockResults,
  findRedLineWords,
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
    expect(findRedLineWords(html)).toEqual([]);
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
    expect(findRedLineWords(html)).toEqual([]);
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
    expect(findRedLineWords(html)).toEqual([]);
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
        onBack: () => {},
        onOpenSettings: () => {},
        onSaveLearning: () => {},
      }),
    );
    expect(html).toContain("股票不存在: 不存在.SH");
    expect(html).toContain("去设置");
    expect(findRedLineWords(html)).toEqual([]);
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
    expect(findRedLineWords(html)).toEqual([]);
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
    expect(findRedLineWords(html)).toEqual([]);
  });
});
