/**
 * 纯函数测试（node 环境，不引入 jsdom）：
 * 漏斗排序/分组/过滤、轮询代码集合、规则覆盖合并、localStorage 序列化、红线校验。
 *
 * 视图组件不在这里测 —— 它们的判定逻辑全部下沉到 `lib/helpers.ts`，
 * 这样既不用引入 jsdom，也不会让既有 vitest 配置发生变化。
 */
import { describe, expect, it } from "vitest";
import { defaultRules, type ReasonItem, type SectorResult, type StockData, type StockResult } from "@aw/core";
import {
  beijingClock,
  beijingDateTime,
  clampRefresh,
  clearRuleOverride,
  DEFAULT_SETTINGS,
  EMPTY_STORE,
  filterStockResults,
  findRedLineWords,
  fmtNum,
  fmtPct,
  fmtRatio,
  groupStockResults,
  hasInsufficientReason,
  matchStockQuery,
  mergeRules,
  NOT_ENOUGH_BANNER,
  overrideCount,
  parseRulesOverride,
  parseSettings,
  parseStore,
  pushAnalysed,
  pushLearning,
  readLS,
  reasonStatus,
  reasonValueText,
  RED_LINE_WORDS,
  removeAnalysed,
  ruleValue,
  sanitizeDataBase,
  sanitizeRulesOverride,
  sectorPriority,
  selectPollCodes,
  serializeSettings,
  serializeStore,
  setRuleOverride,
  sortSectors,
  stateTone,
  stockTypeCounts,
  writeLS,
} from "./lib/helpers";

// ── 测试脚手架 ────────────────────────────────────────────────

function sector(code: string, state: string, breadth20: number | null, strongCount = 0): SectorResult {
  return { code, name: `板块${code}`, state, reasons: [], breadth20, strongCount, strongestMembers: [] };
}

function stockResult(code: string, type: string): StockResult {
  return { code, name: `股${code}`, type, reasons: [], subtype: null, atr: { available: false, flag: "", atr: null, band5: null, move5: null } };
}

function stockData(code: string, industryCode: string): StockData {
  return {
    code,
    name: `股${code}`,
    industry: "测试行业",
    industryCode,
    weight: 1,
    isST: false,
    close: [1],
    high: [1],
    low: [1],
    volume: [1],
  };
}

function reason(partial: Partial<ReasonItem>): ReasonItem {
  return { key: "k", label: "l", value: null, threshold: "", pass: false, note: "", ...partial };
}

// ── 板块排序 ──────────────────────────────────────────────────

describe("板块排序（第二层优先级）", () => {
  it("优先级：持续强势 > 正在加强 > 开始活跃 > 震荡 > 走弱", () => {
    expect(sectorPriority("持续强势")).toBe(0);
    expect(sectorPriority("正在加强")).toBe(1);
    expect(sectorPriority("开始活跃")).toBe(2);
    expect(sectorPriority("震荡")).toBe(3);
    expect(sectorPriority("走弱")).toBe(4);
    expect(sectorPriority("数据不足")).toBe(5);
  });

  it("排序把强势板块排在前面，未知状态排最后", () => {
    const list = [
      sector("d", "走弱", 0.1),
      sector("a", "持续强势", 0.7),
      sector("z", "数据不足", null),
      sector("c", "开始活跃", 0.4),
      sector("b", "正在加强", 0.6),
    ];
    expect(sortSectors(list).map((s) => s.code)).toEqual(["a", "b", "c", "d", "z"]);
  });

  it("同状态按 breadth20 降序，再按强势股数量降序；缺数据不参与比较", () => {
    const list = [
      sector("x", "震荡", null, 99),
      sector("y", "震荡", 0.5, 1),
      sector("w", "震荡", 0.5, 4),
      sector("v", "震荡", 0.9, 0),
    ];
    expect(sortSectors(list).map((s) => s.code)).toEqual(["v", "w", "y", "x"]);
  });

  it("不修改入参", () => {
    const list = [sector("a", "走弱", 0.1), sector("b", "持续强势", 0.9)];
    const copy = [...list];
    sortSectors(list);
    expect(list).toEqual(copy);
  });
});

// ── 个股分组 ──────────────────────────────────────────────────

describe("个股分组（第三层）", () => {
  it("固定六组顺序，空组也保留，计数正确", () => {
    const groups = groupStockResults([
      stockResult("1", "趋势观察"),
      stockResult("2", "排除"),
      stockResult("3", "趋势观察"),
      stockResult("4", "数据不足"),
    ]);
    expect(groups.map((g) => g.type)).toEqual([
      "启动观察",
      "趋势观察",
      "回调观察",
      "高位观察",
      "排除",
      "数据不足",
    ]);
    const counts = stockTypeCounts(groups);
    expect(counts["趋势观察"]).toBe(2);
    expect(counts["排除"]).toBe(1);
    expect(counts["数据不足"]).toBe(1);
    expect(counts["启动观察"]).toBe(0);
  });

  it("组内按近20日涨幅降序，取不到数据的排最后", () => {
    const ret20 = new Map<string, number | null>([
      ["a", 5],
      ["b", null],
      ["c", 20],
    ]);
    const groups = groupStockResults(
      [stockResult("a", "趋势观察"), stockResult("b", "趋势观察"), stockResult("c", "趋势观察")],
      ret20,
    );
    expect(groups.find((g) => g.type === "趋势观察")?.items.map((i) => i.code)).toEqual(["c", "a", "b"]);
  });

  it("引擎将来新增类型也不会被丢掉", () => {
    const groups = groupStockResults([stockResult("a", "新类型")]);
    expect(groups.at(-1)).toMatchObject({ type: "新类型" });
    expect(groups.at(-1)?.items).toHaveLength(1);
  });
});

// ── 过滤 ─────────────────────────────────────────────────────

describe("个股过滤", () => {
  it("代码/名称匹配，大小写不敏感", () => {
    expect(matchStockQuery("600519.SH", "贵州茅台", "")).toBe(true);
    expect(matchStockQuery("600519.SH", "贵州茅台", "600519")).toBe(true);
    expect(matchStockQuery("600519.SH", "贵州茅台", "茅台")).toBe(true);
    expect(matchStockQuery("600519.SH", "贵州茅台", "五粮液")).toBe(false);
  });

  it("按板块过滤需要 industryCode 命中；过滤掉不存在的股票", () => {
    const list = [stockResult("a", "趋势观察"), stockResult("b", "趋势观察"), stockResult("ghost", "排除")];
    const byCode = new Map([
      ["a", stockData("a", "T1.SI")],
      ["b", stockData("b", "T2.SI")],
    ]);
    expect(filterStockResults(list, byCode, { industryCode: "T1.SI" }).map((r) => r.code)).toEqual(["a"]);
    expect(filterStockResults(list, byCode, { query: "b" }).map((r) => r.code)).toEqual(["b"]);
    expect(filterStockResults(list, byCode, { industryCode: "T1.SI", query: "b" })).toHaveLength(0);
  });
});

// ── 轮询代码集合 ──────────────────────────────────────────────

describe("实时轮询代码集合", () => {
  const codeByName = new Map([
    ["强势0", "S0.SH"],
    ["强势1", "S1.SH"],
  ]);

  it("当前个股优先，板块强势成分按名称反查代码", () => {
    const codes = selectPollCodes({
      selectedStock: "600519.SH",
      sectorMemberNames: ["强势0", "不存在的名字"],
      codeByName,
    });
    expect(codes).toEqual(["600519.SH", "S0.SH"]);
  });

  it("去重且上限 20（内部还会再按 20 切批）", () => {
    const many = Array.from({ length: 40 }, (_, i) => `C${i}`);
    const codes = selectPollCodes({ funnelTop: [...many, "C0"], topPerGroup: 40 });
    expect(codes).toHaveLength(20);
    expect(new Set(codes).size).toBe(20);
    expect(codes[0]).toBe("C0");
  });

  it("空集合返回空数组（页面没有可见标的时不请求行情）", () => {
    expect(selectPollCodes({})).toEqual([]);
  });
});

// ── 规则覆盖 ──────────────────────────────────────────────────

describe("规则阈值覆盖", () => {
  it("默认规则：不传覆盖时返回 defaultRules", () => {
    expect(mergeRules()).toBe(defaultRules);
    expect(mergeRules({})).toBe(defaultRules);
  });

  it("只覆盖指定字段，其余保持默认", () => {
    const rules = mergeRules({ stock: { start20Min: 5 }, market: { strong20Pct: 4 } });
    expect(rules.stock.start20Min).toBe(5);
    expect(rules.market.strong20Pct).toBe(4);
    expect(rules.stock.trend20Min).toBe(defaultRules.stock.trend20Min);
    expect(rules.sector.strong20Pct).toBe(defaultRules.sector.strong20Pct);
    expect(ruleValue(rules, "stock", "start20Min")).toBe(5);
  });

  it("不污染 defaultRules", () => {
    const before = JSON.stringify(defaultRules);
    mergeRules({ stock: { start20Min: 99, exclude20Max: -99 } });
    expect(JSON.stringify(defaultRules)).toBe(before);
  });

  it("非法覆盖被丢弃：未知字段、非数字、把字符串字段写成数字", () => {
    const clean = sanitizeRulesOverride({
      stock: { start20Min: "5", nope: 1, trend20Min: 20 },
      market: { mainIndex: 3, strong20Pct: 6 },
      unknown: { a: 1 },
    } as unknown);
    expect(clean).toEqual({ stock: { trend20Min: 20 }, market: { strong20Pct: 6 } });
    expect(mergeRules(clean).market.mainIndex).toBe(defaultRules.market.mainIndex);
    expect(mergeRules(clean).stock.start20Min).toBe(defaultRules.stock.start20Min);
  });

  it("坏 JSON 不抛错，退化为空覆盖", () => {
    expect(parseRulesOverride("{ 不是 json")).toEqual({});
    expect(parseRulesOverride(null)).toEqual({});
    expect(parseRulesOverride('{"stock":{"minDays":45}}')).toEqual({ stock: { minDays: 45 } });
  });

  it("设置/清除单项覆盖，计数正确", () => {
    let o = setRuleOverride({}, "stock", "minDays", 45);
    o = setRuleOverride(o, "sector", "strongStockMin", 4);
    expect(overrideCount(o)).toBe(2);
    o = clearRuleOverride(o, "stock", "minDays");
    expect(o).toEqual({ sector: { strongStockMin: 4 } });
    o = clearRuleOverride(o, "sector", "strongStockMin");
    expect(o).toEqual({});
    expect(overrideCount(o)).toBe(0);
  });

  it("NaN 视为清除该项", () => {
    const o = setRuleOverride({ stock: { minDays: 45 } }, "stock", "minDays", Number.NaN);
    expect(o).toEqual({});
  });
});

// ── localStorage 序列化 ───────────────────────────────────────

describe("设置序列化", () => {
  it("默认值", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("不是 json")).toEqual(DEFAULT_SETTINGS);
  });

  it("往返一致，且刷新间隔被夹到 3000~5000", () => {
    const s = { dataBase: "./data/", refreshMs: 9999, ruleOverrides: { stock: { minDays: 45 } } };
    const parsed = parseSettings(serializeSettings(s));
    expect(parsed.dataBase).toBe("./data");
    expect(parsed.refreshMs).toBe(5000);
    expect(parsed.ruleOverrides).toEqual({ stock: { minDays: 45 } });
    expect(clampRefresh(1)).toBe(3000);
    expect(clampRefresh(Number.NaN)).toBe(DEFAULT_SETTINGS.refreshMs);
  });

  it("数据路径清洗：去尾斜杠、空值回落默认、保留 http 前缀", () => {
    expect(sanitizeDataBase("  ./data/  ")).toBe("./data");
    expect(sanitizeDataBase("")).toBe("./data");
    expect(sanitizeDataBase("https://cdn.example.com/aw/data/")).toBe("https://cdn.example.com/aw/data");
    expect(sanitizeDataBase("/")).toBe("/");
  });
});

describe("本地历史序列化", () => {
  it("坏数据 → 空结构，不抛错", () => {
    expect(parseStore(null)).toEqual(EMPTY_STORE);
    expect(parseStore("[1,2,3]")).toEqual(EMPTY_STORE);
    expect(parseStore('{"analysed":"nope","learning":null}')).toEqual(EMPTY_STORE);
  });

  it("丢弃没有 code 的记录与空作答", () => {
    const store = parseStore(
      JSON.stringify({
        analysed: [{ name: "没有代码" }, { code: "600519.SH", name: "贵州茅台", type: "趋势观察", at: 1 }],
        learning: [
          { code: "600519.SH", question: "q", answer: "   " },
          { code: "600519.SH", name: "贵州茅台", type: "趋势观察", question: "q", answer: "a", at: 2 },
        ],
      }),
    );
    expect(store.analysed).toHaveLength(1);
    expect(store.learning).toHaveLength(1);
    expect(store.learning[0].answer).toBe("a");
  });

  it("最近分析按代码去重、最新在前，并遵守上限", () => {
    let s = EMPTY_STORE;
    s = pushAnalysed(s, { code: "A", name: "甲", type: "趋势观察", at: 1 });
    s = pushAnalysed(s, { code: "B", name: "乙", type: "排除", at: 2 });
    s = pushAnalysed(s, { code: "A", name: "甲", type: "启动观察", at: 3 });
    expect(s.analysed.map((e) => e.code)).toEqual(["A", "B"]);
    expect(s.analysed[0].type).toBe("启动观察");
    let capped = EMPTY_STORE;
    for (let i = 0; i < 80; i += 1) capped = pushAnalysed(capped, { code: `C${i}`, name: "x", type: "排除", at: i });
    expect(capped.analysed).toHaveLength(60);
    expect(serializeStore(capped).length).toBeGreaterThan(0);
  });

  it("学习作答不去重（可反复作答），可单条删除分析记录", () => {
    let s = EMPTY_STORE;
    s = pushLearning(s, { code: "A", name: "甲", type: "趋势观察", question: "q1", answer: "a1", at: 1 });
    s = pushLearning(s, { code: "A", name: "甲", type: "趋势观察", question: "q1", answer: "a2", at: 2 });
    expect(s.learning).toHaveLength(2);
    expect(s.learning[0].answer).toBe("a2");
    s = pushAnalysed(s, { code: "A", name: "甲", type: "趋势观察", at: 3 });
    expect(removeAnalysed(s, "A").analysed).toHaveLength(0);
    expect(removeAnalysed(s, "不存在").analysed).toHaveLength(1);
  });

  it("往返一致", () => {
    const s = pushAnalysed(EMPTY_STORE, { code: "A", name: "甲", type: "排除", at: 7 });
    expect(parseStore(serializeStore(s))).toEqual(s);
  });

  it("node 环境没有 localStorage 时读写都安全降级", () => {
    expect(typeof globalThis.localStorage).toBe("undefined");
    expect(readLS("aw.test")).toBeNull();
    expect(() => writeLS("aw.test", "1")).not.toThrow();
  });
});

// ── 判断依据渲染 ──────────────────────────────────────────────

describe("判断依据的状态与取值", () => {
  it("value 为 null 且非离散判定 → 数据不足（不是 0）", () => {
    const r = reason({ value: null, threshold: "" });
    expect(reasonStatus(r)).toBe("unknown");
    expect(reasonValueText(r)).toBe("数据不足");
    expect(hasInsufficientReason([r])).toBe(true);
  });

  it("离散判定（命中/未命中、是/否）即便 value 为 null 也有结论", () => {
    expect(reasonStatus(reason({ value: null, threshold: "命中", pass: true }))).toBe("pass");
    expect(reasonValueText(reason({ value: null, threshold: "未命中", pass: false }))).toBe("未命中");
    expect(reasonValueText(reason({ value: 1, threshold: "是", pass: true }))).toBe("是");
    expect(reasonValueText(reason({ value: 0, threshold: "否", pass: false }))).toBe("否");
  });

  it("有数就显示数字，且不插值", () => {
    expect(reasonValueText(reason({ value: 3.14159, threshold: "≥ 3%" }))).toBe("3.14");
    expect(reasonStatus(reason({ value: -1, pass: false }))).toBe("fail");
  });

  it("引擎用 1/0 编码的是非题显示成「是/否」，放量项显示成量能文案", () => {
    expect(reasonValueText(reason({ key: "trend.above20", value: 1, pass: true }))).toBe("是");
    expect(reasonValueText(reason({ key: "trend.above60", value: 0, pass: false }))).toBe("否");
    expect(reasonValueText(reason({ key: "pos.volumeHeavy", value: 1, threshold: "缩量更健康" }))).toBe("放量");
    expect(reasonValueText(reason({ key: "pos.volumeHeavy", value: 0, threshold: "缩量更健康" }))).toBe("缩量/中性");
    // 百分比字段即便恰好是 0 也不能被当成「否」
    expect(reasonValueText(reason({ key: "main.ret20", value: 0, threshold: "≥ 3%" }))).toBe("0");
    expect(reasonStatus(reason({ key: "main.ret20", value: 0, pass: false }))).toBe("fail");
  });

  it("格式化：null 一律 —", () => {
    expect(fmtNum(null)).toBe("—");
    expect(fmtNum(undefined)).toBe("—");
    expect(fmtNum(Number.NaN)).toBe("—");
    expect(fmtPct(null)).toBe("—");
    expect(fmtRatio(0.6213)).toBe("62.1%");
    expect(fmtRatio(null)).toBe("—");
    expect(fmtNum(1.2345, 2)).toBe("1.23");
    expect(fmtNum(2.5)).toBe("2.5"); // 去掉多余的 0，与引擎 fmt() 一致
  });

  it("北京时间格式化（显式 +8，不看本机时区）", () => {
    const ts = Date.UTC(2026, 8, 23, 1, 2, 3); // 北京 09:02:03
    expect(beijingClock(ts)).toBe("09:02:03");
    expect(beijingClock(null)).toBe("—");
    expect(beijingDateTime(ts)).toBe("09-23 09:02");
    expect(beijingDateTime(0)).toBe("时间未知");
  });

  it("状态配色分档", () => {
    expect(stateTone("持续强势")).toBe("good");
    expect(stateTone("震荡")).toBe("warn");
    expect(stateTone("走弱")).toBe("bad");
    expect(stateTone("数据不足")).toBe("muted");
  });
});

// ── 红线 ─────────────────────────────────────────────────────

describe("产品红线", () => {
  it("红线词检测有效", () => {
    expect(findRedLineWords("当前归类为趋势观察")).toEqual([]);
    expect(findRedLineWords("建议买入")).toEqual(["买入"]);
    expect(findRedLineWords("目标价 100 元，必涨")).toEqual(["目标价", "必涨"]);
    expect(RED_LINE_WORDS).toHaveLength(5);
  });

  it("数据不足横幅文案固定", () => {
    expect(NOT_ENOUGH_BANNER).toBe("【数据不足，不许编造】");
  });

  /**
   * 红线扫描：程序不得给出买卖建议。
   *
   * 唯一豁免的是 GameView.tsx —— 模拟盘里「买入/卖出」是**用户自己的操作标签**，
   * 不是程序的建议；若连操作按钮都不能写，模拟盘就无法存在。
   * 豁免名单**写死在这里**，任何人都不能悄悄扩大范围；
   * 并且对 GameView 施加了更严格的替代约束（见下一条测试）。
   */
  const RED_LINE_EXEMPT = ["GameView.tsx"];

  it("所有 .tsx 源码里不出现任何红线词（GameView 除外，含注释）", () => {
    const files = import.meta.glob("./**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<
      string,
      string
    >;
    const names = Object.keys(files);
    expect(names.length).toBeGreaterThanOrEqual(6);

    // 豁免文件必须真实存在，避免名单写错导致"以为豁免了其实没有"
    for (const ex of RED_LINE_EXEMPT) {
      expect(names.some((n) => n.endsWith(ex)), `豁免文件 ${ex} 不存在`).toBe(true);
    }

    for (const [name, text] of Object.entries(files)) {
      if (RED_LINE_EXEMPT.some((ex) => name.endsWith(ex))) continue;
      expect(findRedLineWords(text), `${name} 命中红线词`).toEqual([]);
    }
  });

  /**
   * GameView 的替代约束：允许出现操作标签，但**不得出现任何引导性/建议性文案**，
   * 且必须常驻免责声明。唯有如此，"模拟盘"才不会退化成"荐股"。
   */
  it("GameView 不出现引导性文案，且常驻免责声明", () => {
    const files = import.meta.glob("./**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<
      string,
      string
    >;
    const entry = Object.entries(files).find(([n]) => n.endsWith("GameView.tsx"));
    expect(entry, "找不到 GameView.tsx").toBeTruthy();
    const src = entry![1];

    // 必须常驻免责声明（引用常量而非硬编码，避免两处漂移）
    expect(src).toContain("GAME_DISCLAIMER");

    // 不得出现任何"程序在给建议"的措辞
    const ADVICE = [
      "建议买入", "建议卖出", "推荐买入", "推荐卖出", "值得买", "可以买", "应该买",
      "看涨", "看跌", "抄底", "梭哈", "稳赚", "必赚", "止损位", "止盈位",
    ];
    for (const w of ADVICE) {
      expect(src.includes(w), `GameView 出现引导性文案「${w}」`).toBe(false);
    }
  });
});
