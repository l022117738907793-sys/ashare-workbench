import { describe, expect, it } from "vitest";
import type { Trade } from "@aw/game";
import { AWAY_MIN_MS, awayReport, humanAway, makeMark, worthReporting } from "./awayReport";

const T0 = 1_700_000_000_000;
const HOUR = 3600_000;

const pos = (code: string, name: string, shares: number, price: number | null) => ({
  code,
  name,
  shares,
  price,
});

describe("离开前后的估值对比", () => {
  it("算得出每只持仓的价格变化与合计", () => {
    const then = makeMark(T0, 100_000, [pos("600519.SH", "贵州茅台", 100, 1000)]);
    const now = { at: T0 + 5 * HOUR, cash: 100_000, positions: [pos("600519.SH", "贵州茅台", 100, 1100)] };
    const r = awayReport(then, now);

    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ code: "600519.SH", from: 1000, to: 1100, pct: 10, amount: 10_000 });
    expect(r.priceDelta).toBe(10_000);
    expect(r.totalDelta).toBe(10_000);
  });

  it("下跌时是负数，不是取绝对值", () => {
    const then = makeMark(T0, 0, [pos("000001.SZ", "平安银行", 1000, 10)]);
    const now = { at: T0 + HOUR, cash: 0, positions: [pos("000001.SZ", "平安银行", 1000, 9.5)] };
    const r = awayReport(then, now);

    expect(r.lines[0].amount).toBe(-500);
    expect(r.lines[0].pct).toBe(-5);
    expect(r.priceDelta).toBe(-500);
  });

  it("现金也算进总计 —— 期间成交过的账户，差额不只是行情", () => {
    // 卖掉一半：股数变了，这只票不参与价格对比，但现金和总计要跟上
    const then = makeMark(T0, 0, [pos("600519.SH", "贵州茅台", 100, 1000)]);
    const now = { at: T0 + HOUR, cash: 55_000, positions: [pos("600519.SH", "贵州茅台", 50, 1100)] };
    const r = awayReport(then, now);

    expect(r.lines).toHaveLength(0);
    expect(r.unpriced).toEqual([{ code: "600519.SH", name: "贵州茅台", reason: "then" }]);
  });

  it("当时取不到价的持仓不记进 mark —— 免得下次误以为它没变", () => {
    const m = makeMark(T0, 100, [pos("A", "甲", 100, null), pos("B", "乙", 200, 5)]);
    expect(m.positions).toHaveLength(1);
    expect(m.positions[0].code).toBe("B");
  });

  it("现在取不到价的持仓单独列出来，不算进合计", () => {
    const then = makeMark(T0, 0, [pos("A", "甲", 100, 10), pos("B", "乙", 100, 20)]);
    const now = { at: T0 + HOUR, cash: 0, positions: [pos("A", "甲", 100, 11), pos("B", "乙", 100, null)] };
    const r = awayReport(then, now);

    expect(r.lines).toHaveLength(1);
    expect(r.priceDelta).toBe(100); // 只有甲
    expect(r.unpriced).toEqual([{ code: "B", name: "乙", reason: "now" }]);
  });

  it("已经清仓的持仓按「现在没有」记，不当成跌到 0", () => {
    const then = makeMark(T0, 0, [pos("A", "甲", 100, 10)]);
    const now = { at: T0 + HOUR, cash: 1000, positions: [] };
    const r = awayReport(then, now);

    expect(r.lines).toHaveLength(0);
    expect(r.priceDelta).toBe(0);
    expect(r.closed).toEqual(["A"]);
  });

  it("期间新买的持仓记进 opened，不参与价格对比", () => {
    const then = makeMark(T0, 1000, []);
    const now = { at: T0 + HOUR, cash: 0, positions: [pos("NEW", "新股", 100, 10)] };
    const r = awayReport(then, now);

    expect(r.opened).toEqual(["NEW"]);
    expect(r.lines).toHaveLength(0);
  });

  it("按金额变化的绝对值排序 —— 跌得最狠的排最前，不会被涨的挤下去", () => {
    const then = makeMark(T0, 0, [pos("A", "甲", 100, 10), pos("B", "乙", 100, 10)]);
    const now = {
      at: T0 + HOUR,
      cash: 0,
      positions: [pos("A", "甲", 100, 11), pos("B", "乙", 100, 8)], // +100 / -200
    };
    const r = awayReport(then, now);
    expect(r.lines.map((l) => l.code)).toEqual(["B", "A"]);
  });

  it("期间成交笔数按左开右闭数，走的那一刻不算、回来这一刻算", () => {
    const t = (at: number): Trade =>
      ({ id: `t${at}`, at, date: "2026-01-01", code: "A", name: "甲", side: "buy", price: 1, shares: 100, amount: 100, fee: 0 }) as Trade;

    const then = makeMark(T0, 0, [pos("A", "甲", 100, 10)]);
    const now = { at: T0 + 10 * HOUR, cash: 0, positions: [pos("A", "甲", 100, 10)] };
    const r = awayReport(then, now, [t(T0), t(T0 + HOUR), t(T0 + 10 * HOUR), t(T0 + 11 * HOUR)]);

    expect(r.tradesDuring).toBe(2);
  });

  it("两边价格一样时差额是 0，不编造方向", () => {
    const then = makeMark(T0, 50_000, [pos("A", "甲", 100, 10)]);
    const now = { at: T0 + 20 * HOUR, cash: 50_000, positions: [pos("A", "甲", 100, 10)] };
    const r = awayReport(then, now);

    expect(r.priceDelta).toBe(0);
    expect(r.totalDelta).toBe(0);
    expect(r.lines[0].pct).toBe(0);
  });
});

describe("值不值得报", () => {
  const then = makeMark(T0, 0, [pos("A", "甲", 100, 10)]);
  const nowAt = (at: number) => ({ at, cash: 0, positions: [pos("A", "甲", 100, 11)] });

  it("离开不到 30 分钟不打扰（只是切了个标签页）", () => {
    expect(worthReporting(awayReport(then, nowAt(T0 + 29 * 60_000)))).toBe(false);
  });

  it("超过 30 分钟就报", () => {
    expect(worthReporting(awayReport(then, nowAt(T0 + AWAY_MIN_MS)))).toBe(true);
  });

  it("没有可比持仓时不报（空仓回来没什么可说的）", () => {
    const empty = makeMark(T0, 0, []);
    const r = awayReport(empty, { at: T0 + 10 * HOUR, cash: 0, positions: [] });
    expect(worthReporting(r)).toBe(false);
  });
});

describe("时长说人话", () => {
  it("分钟 / 小时 / 天", () => {
    expect(humanAway(45 * 60_000)).toBe("45 分钟");
    expect(humanAway(3 * HOUR + 20 * 60_000)).toBe("3 小时 20 分钟");
    expect(humanAway(50 * HOUR)).toBe("2 天 2 小时");
  });

  it("不足一分钟也说 1 分钟，不显示 0 分钟", () => {
    expect(humanAway(1000)).toBe("1 分钟");
  });
});
