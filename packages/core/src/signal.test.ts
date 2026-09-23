import { describe, expect, it } from "vitest";
import { defaultRules, type StockData } from "./engine";
import {
  deriveSignal,
  deriveSignals,
  signalCounts,
  SIGNAL_ORDER,
  type SignalAction,
} from "./signal";

/**
 * 造一只走势可控的股票。
 * `trend` 为日涨幅，序列按几何式累乘，便于构造"强势/走弱/高位"等形态。
 */
function makeStock(over: {
  code?: string;
  name?: string;
  trend?: number;
  days?: number;
  volume?: number;
  isST?: boolean;
} = {}): StockData {
  const { code = "600000.SH", name = "测试股", trend = 0, days = 120, volume = 1000, isST = false } = over;
  const close: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  const vol: number[] = [];
  let p = 100;
  for (let i = 0; i < days; i += 1) {
    p = p * (1 + trend / 100);
    close.push(Math.round(p * 100) / 100);
    high.push(Math.round(p * 1.01 * 100) / 100);
    low.push(Math.round(p * 0.99 * 100) / 100);
    vol.push(volume);
  }
  return {
    code,
    name,
    industry: "测试行业",
    industryCode: "801000.SI",
    weight: 1,
    isST,
    close,
    high,
    low,
    volume: vol,
  };
}

describe("信号动作映射", () => {
  it("明确的上升趋势 → 买入或增持", () => {
    // 日均 +1%，20 日约 +22%，站上所有均线且放量
    const s = deriveSignal(makeStock({ trend: 1, volume: 2000 }), defaultRules);
    expect(["买入", "增持"]).toContain(s.action);
    expect(s.strength).toBeGreaterThan(50);
  });

  it("持续下跌 → 卖出", () => {
    const s = deriveSignal(makeStock({ trend: -1.2 }), defaultRules);
    expect(s.action).toBe("卖出");
  });

  it("暴涨后处于高位 → 减持", () => {
    // 日均 +3%，20 日约 +80%，触发高位观察
    const s = deriveSignal(makeStock({ trend: 3, volume: 2500 }), defaultRules);
    expect(s.action).toBe("减持");
  });

  it("数据不足 → 观望且强度为 0", () => {
    const s = deriveSignal(makeStock({ days: 10 }), defaultRules);
    expect(s.action).toBe("观望");
    expect(s.strength).toBe(0);
  });

  it("动作取值永远合法", () => {
    for (const trend of [-3, -1, -0.2, 0, 0.2, 1, 3]) {
      const s = deriveSignal(makeStock({ trend }), defaultRules);
      expect(SIGNAL_ORDER).toContain(s.action);
      expect(s.strength).toBeGreaterThanOrEqual(0);
      expect(s.strength).toBeLessThanOrEqual(100);
      expect(Number.isInteger(s.strength)).toBe(true);
    }
  });
});

describe("参考价位", () => {
  it("止损低于买入价、目标高于现价", () => {
    const stock = makeStock({ trend: 0.8, volume: 2000 });
    const s = deriveSignal(stock, defaultRules);
    const price = stock.close[stock.close.length - 1];

    expect(s.levels.entry).not.toBeNull();
    expect(s.levels.stop).not.toBeNull();
    expect(s.levels.target).not.toBeNull();
    expect(s.levels.stop!).toBeLessThan(s.levels.entry!);
    expect(s.levels.target!).toBeGreaterThan(price);
  });

  it("压力位就是最近 20 日最高收盘价", () => {
    const stock = makeStock({ trend: 0.5 });
    const s = deriveSignal(stock, defaultRules);
    const expected = Math.max(...stock.close.slice(-20));
    expect(s.levels.resistance).toBeCloseTo(expected, 2);
  });

  it("取不到 ATR 时不硬造止损目标（数据不足的股票退化为压力位）", () => {
    const s = deriveSignal(makeStock({ days: 20 }), defaultRules);
    // 20 日不足以算 MA60，止损可能为 null，但绝不应出现 NaN
    for (const v of [s.levels.entry, s.levels.stop, s.levels.target, s.levels.resistance]) {
      if (v !== null) expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe("信号强度单调性", () => {
  it("同为上涨，放量的强度不低于缩量", () => {
    const heavy = deriveSignal(makeStock({ trend: 0.8, volume: 3000 }), defaultRules);
    const light = deriveSignal(makeStock({ trend: 0.8, volume: 300 }), defaultRules);
    expect(heavy.strength).toBeGreaterThanOrEqual(light.strength);
  });

  it("强度不会因动量微调而越界", () => {
    const strong = deriveSignal(makeStock({ trend: 2, volume: 5000 }), defaultRules);
    expect(strong.strength).toBeLessThanOrEqual(100);
    const weak = deriveSignal(makeStock({ trend: -2, volume: 100 }), defaultRules);
    expect(weak.strength).toBeGreaterThanOrEqual(0);
  });
});

describe("批量派生与排序", () => {
  const stocks = [
    makeStock({ code: "A.SH", name: "跌的", trend: -1.5 }),
    makeStock({ code: "B.SH", name: "涨的", trend: 1, volume: 2000 }),
    makeStock({ code: "C.SH", name: "平的", trend: 0 }),
    makeStock({ code: "D.SH", name: "数据少", days: 10 }),
  ];

  it("返回每只股票一条信号", () => {
    expect(deriveSignals(stocks, defaultRules)).toHaveLength(stocks.length);
  });

  it("按强度降序", () => {
    const out = deriveSignals(stocks, defaultRules);
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i - 1].strength).toBeGreaterThanOrEqual(out[i].strength);
    }
  });

  it("上涨的排在下跌的前面", () => {
    const out = deriveSignals(stocks, defaultRules);
    const upIdx = out.findIndex((s) => s.code === "B.SH");
    const downIdx = out.findIndex((s) => s.code === "A.SH");
    expect(upIdx).toBeLessThan(downIdx);
  });

  it("分组计数之和等于总数", () => {
    const out = deriveSignals(stocks, defaultRules);
    const counts = signalCounts(out);
    const sum = SIGNAL_ORDER.reduce((acc, k) => acc + counts[k], 0);
    expect(sum).toBe(stocks.length);
  });

  it("空输入返回空数组", () => {
    expect(deriveSignals([], defaultRules)).toEqual([]);
    expect(signalCounts([])).toEqual({ 买入: 0, 增持: 0, 持有: 0, 减持: 0, 卖出: 0, 观望: 0 });
  });
});

describe("依据与文案", () => {
  it("始终带判断依据，且包含信号自身的说明", () => {
    const s = deriveSignal(makeStock({ trend: 0.8 }), defaultRules);
    expect(s.reasons.length).toBeGreaterThanOrEqual(5);
    expect(s.reasons.some((r) => r.key === "signal.action")).toBe(true);
    expect(s.reasons.some((r) => r.key === "signal.levels")).toBe(true);
  });

  it("headline 非空且带动作含义", () => {
    for (const trend of [-2, 0, 1, 3]) {
      const s = deriveSignal(makeStock({ trend }), defaultRules);
      expect(s.headline.length).toBeGreaterThan(0);
    }
  });

  it("levels 依据里说明这是技术测算而非承诺", () => {
    const s = deriveSignal(makeStock({ trend: 0.8 }), defaultRules);
    const lv = s.reasons.find((r) => r.key === "signal.levels")!;
    expect(lv.note).toContain("非承诺");
  });
});

describe("ST 股与边界", () => {
  it("ST 股仍能产出合法信号（不崩）", () => {
    const s = deriveSignal(makeStock({ trend: 0.5, isST: true }), defaultRules);
    expect(SIGNAL_ORDER).toContain(s.action as SignalAction);
  });

  it("全 null 序列不崩，给出观望", () => {
    const stock = makeStock();
    stock.close = stock.close.map(() => null);
    stock.high = stock.high.map(() => null);
    stock.low = stock.low.map(() => null);
    stock.volume = stock.volume.map(() => null);
    const s = deriveSignal(stock, defaultRules);
    expect(s.action).toBe("观望");
    expect(s.levels.entry).toBeNull();
  });

  it("零成交量的股票不产生 NaN 强度", () => {
    const s = deriveSignal(makeStock({ trend: 0.5, volume: 0 }), defaultRules);
    expect(Number.isFinite(s.strength)).toBe(true);
  });
});
