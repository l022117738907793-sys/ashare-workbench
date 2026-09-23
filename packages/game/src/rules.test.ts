import { describe, expect, it } from "vitest";
import { boardOf, feeRulesAt, isValidBuyQuantity, limitPctAt, lotRulesAt } from "./rules";

describe("板块识别", () => {
  it("按代码前缀区分", () => {
    expect(boardOf("600519.SH")).toBe("main");
    expect(boardOf("000001.SZ")).toBe("main");
    expect(boardOf("300750.SZ")).toBe("chinext");
    expect(boardOf("301001.SZ")).toBe("chinext");
    expect(boardOf("688981.SH")).toBe("star");
    expect(boardOf("830799.BJ")).toBe("bse");
  });
});

describe("费率按日期生效", () => {
  it("印花税 2023-08-28 减半", () => {
    expect(feeRulesAt("2023-08-27").stampDutyRate).toBe(0.001);
    expect(feeRulesAt("2023-08-28").stampDutyRate).toBe(0.0005);
    expect(feeRulesAt("2026-09-23").stampDutyRate).toBe(0.0005);
  });

  it("佣金与过户费不随日期变", () => {
    for (const d of ["2018-01-01", "2026-09-23"]) {
      expect(feeRulesAt(d).commissionRate).toBe(0.00025);
      expect(feeRulesAt(d).transferFeeRate).toBe(0.00001);
    }
  });
});

describe("涨跌停按日期与板块生效", () => {
  it("主板 10%、ST 5%", () => {
    expect(limitPctAt("2026-09-23", "main", false)).toBe(0.1);
    expect(limitPctAt("2026-09-23", "main", true)).toBe(0.05);
  });

  it("科创板自开市即 20%，ST 也是 20%", () => {
    expect(limitPctAt("2019-07-22", "star", false)).toBe(0.2);
    expect(limitPctAt("2026-09-23", "star", true)).toBe(0.2);
  });

  it("创业板 2020-08-24 由 10% 改为 20%，ST 同样跟随", () => {
    expect(limitPctAt("2020-08-23", "chinext", false)).toBe(0.1);
    expect(limitPctAt("2020-08-24", "chinext", false)).toBe(0.2);
    // 关键：创业板 ST 不是主板的 5%
    expect(limitPctAt("2026-09-23", "chinext", true)).toBe(0.2);
  });

  it("北交所 30%", () => {
    expect(limitPctAt("2026-09-23", "bse", false)).toBe(0.3);
  });
});

describe("买入单位按板块", () => {
  it("主板/创业板 100 股起、100 递增", () => {
    expect(lotRulesAt("main")).toEqual({ minShares: 100, increment: 100 });
    expect(isValidBuyQuantity("main", 100)).toBe(true);
    expect(isValidBuyQuantity("main", 150)).toBe(false);
    expect(isValidBuyQuantity("main", 50)).toBe(false);
  });

  it("科创板 200 股起、1 股递增", () => {
    expect(isValidBuyQuantity("star", 100)).toBe(false);
    expect(isValidBuyQuantity("star", 199)).toBe(false);
    expect(isValidBuyQuantity("star", 200)).toBe(true);
    expect(isValidBuyQuantity("star", 201)).toBe(true); // 这是与主板最易混淆之处
  });

  it("非法股数一律拒绝", () => {
    for (const n of [0, -1, 1.5, Number.NaN]) {
      expect(isValidBuyQuantity("main", n)).toBe(false);
      expect(isValidBuyQuantity("star", n)).toBe(false);
    }
  });
});
