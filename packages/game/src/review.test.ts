import { describe, expect, it } from "vitest";
import { createAccount } from "./portfolio";
import { alignmentOf, describeReview, REVIEW_CAVEATS, reviewReport } from "./review";
import type { Trade } from "./types";

const trade = (over: Partial<Trade> = {}): Trade => ({
  id: "t1",
  at: 0,
  date: "2026-09-01",
  code: "600519.SH",
  name: "贵州茅台",
  side: "buy",
  price: 100,
  shares: 100,
  amount: 10_000,
  fee: 5,
  ...over,
});

const accountWith = (trades: Trade[]) => ({ ...createAccount(100_000), trades });

describe("方向与当时分类的对得上", () => {
  it("买入配启动/回调/趋势 算一致", () => {
    for (const t of ["启动观察", "回调观察", "趋势观察"]) {
      expect(alignmentOf("buy", t)).toBe("aligned");
    }
  });

  it("买入配高位观察/排除 算反向", () => {
    expect(alignmentOf("buy", "高位观察")).toBe("against");
    expect(alignmentOf("buy", "排除")).toBe("against");
  });

  it("卖出反过来", () => {
    expect(alignmentOf("sell", "高位观察")).toBe("aligned");
    expect(alignmentOf("sell", "排除")).toBe("aligned");
    expect(alignmentOf("sell", "趋势观察")).toBe("against");
    expect(alignmentOf("sell", "启动观察")).toBe("against");
  });

  it("数据不足既不是一致也不是反向，单独算「无从判断」", () => {
    expect(alignmentOf("buy", "数据不足")).toBe("unknown");
    expect(alignmentOf("sell", "数据不足")).toBe("unknown");
  });

  it("老记录没存分类时算 unknown，不猜成「反向」", () => {
    expect(alignmentOf("buy", undefined)).toBe("unknown");
    expect(alignmentOf("sell", undefined)).toBe("unknown");
  });
});

describe("复盘报告", () => {
  const prices = { "600519.SH": 110 };

  it("算出每笔成交之后的涨跌", () => {
    const r = reviewReport({
      account: accountWith([trade({ price: 100 })]),
      finalPrices: prices,
      season: "2026-09",
      asOf: "2026-09-30",
    });
    expect(r.trades[0].laterPct).toBe(10);
  });

  it("取不到期末价时 laterPct 是 null，不当成 0", () => {
    const r = reviewReport({
      account: accountWith([trade({ code: "999999.SH" })]),
      finalPrices: prices,
      season: "2026-09",
      asOf: "2026-09-30",
    });
    expect(r.trades[0].laterPct).toBeNull();
  });

  it("分档计数：一致 / 反向 / 无从判断", () => {
    const r = reviewReport({
      account: accountWith([
        trade({ id: "a", typeAtTrade: "趋势观察" }),
        trade({ id: "b", typeAtTrade: "高位观察" }),
        trade({ id: "c" }), // 没有分类
      ]),
      finalPrices: prices,
      season: "2026-09",
      asOf: "2026-09-30",
    });
    expect(r.counts).toEqual({ aligned: 1, against: 1, unknown: 1 });
  });

  it("两组各自的平均涨跌分开算，取不到价的不进平均", () => {
    const r = reviewReport({
      account: accountWith([
        trade({ id: "a", code: "600519.SH", price: 100, typeAtTrade: "趋势观察" }), // +10%
        trade({ id: "b", code: "999999.SH", price: 100, typeAtTrade: "趋势观察" }), // 没价，排除
      ]),
      finalPrices: prices,
      season: "2026-09",
      asOf: "2026-09-30",
    });
    expect(r.alignedAvgPct).toBe(10);
  });

  it("一组里一笔都没有时平均是 null，不是 0", () => {
    const r = reviewReport({
      account: accountWith([trade({ typeAtTrade: "趋势观察" })]),
      finalPrices: prices,
      season: "2026-09",
      asOf: "2026-09-30",
    });
    expect(r.againstAvgPct).toBeNull();
  });

  it("持仓标出整季有没有动过", () => {
    const account = {
      ...createAccount(100_000),
      holdings: [
        { code: "600519.SH", name: "贵州茅台", shares: 100, sellable: 100, avgCost: 100 },
        { code: "000001.SZ", name: "平安银行", shares: 100, sellable: 100, avgCost: 20 },
      ],
      trades: [trade({ code: "600519.SH" })],
    };
    const r = reviewReport({ account, finalPrices: prices, season: "2026-09", asOf: "2026-09-30" });
    expect(r.holdings.find((h) => h.code === "600519.SH")?.traded).toBe(true);
    expect(r.holdings.find((h) => h.code === "000001.SZ")?.traded).toBe(false);
    expect(r.holdings.find((h) => h.code === "000001.SZ")?.pnlPct).toBeNull();
  });

  it("必须原样带上那几条提醒，尤其是「引擎没有测出优势」", () => {
    const r = reviewReport({
      account: accountWith([trade()]),
      finalPrices: prices,
      season: "2026-09",
      asOf: "2026-09-30",
    });
    expect(r.caveats).toBe(REVIEW_CAVEATS);
    const all = r.caveats.join("");
    expect(all).toContain("没有测出优势");
    expect(all).toContain("不是对错");
  });
});

describe("一句话概括必须中性", () => {
  const base = { season: "2026-09", asOf: "2026-09-30", finalAssets: 0, holdings: [], caveats: [] };

  it("没有操作时说的是「无从复盘」，不是「你什么都没做」", () => {
    const r = { ...base, trades: [], counts: { aligned: 0, against: 0, unknown: 0 }, alignedAvgPct: null, againstAvgPct: null };
    expect(describeReview(r)).toContain("无从复盘");
  });

  it("全都没有分类时明说记录里没有，不假装能判断", () => {
    const r = {
      ...base,
      trades: [{} as never],
      counts: { aligned: 0, against: 0, unknown: 1 },
      alignedAvgPct: null,
      againstAvgPct: null,
    };
    expect(describeReview(r)).toContain("都没有当时的分类");
  });

  it("有分类时报三个数，不带任何褒贬词", () => {
    const r = {
      ...base,
      trades: [{}, {}, {}] as never[],
      counts: { aligned: 2, against: 1, unknown: 0 },
      alignedAvgPct: 1,
      againstAvgPct: -1,
    };
    const s = describeReview(r);
    expect(s).toContain("2 笔与当时分类同向");
    for (const bad of ["正确", "错误", "英明", "失误", "应该"]) {
      expect(s).not.toContain(bad);
    }
  });
});
