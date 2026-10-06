import { describe, expect, it } from "vitest";
import {
  type FxSeries,
  type OverseasSeries,
  alignOverseasToCalendar,
  coverage,
  fxRateOn,
  nonPositiveCount,
  toCny,
} from "./overseas";

/** 造一只境外标的。默认是「美股，三个交易日都有报价」。 */
function series(over: Partial<OverseasSeries> = {}): OverseasSeries {
  return {
    code: "AAPL.US",
    name: "苹果",
    market: "US",
    currency: "USD",
    dates: ["2020-01-02", "2020-01-03", "2020-01-07"],
    open: [100, 101, 103],
    close: [100.5, 101.5, 103.5],
    high: [101, 102, 104],
    low: [99, 100, 102],
    volume: [10, 11, 13],
    ...over,
  };
}

describe("境外标的对齐到 A 股日历", () => {
  it("每一列都和日历等长 —— 这是分片能通过 isLevelShard 的前提", () => {
    const calendar = ["2020-01-02", "2020-01-03", "2020-01-06", "2020-01-07", "2020-01-08"];
    const a = alignOverseasToCalendar(series(), calendar);
    for (const col of [a.open, a.close, a.high, a.low, a.volume]) {
      expect(col).toHaveLength(calendar.length);
    }
  });

  it("外盘休市那天：close 沿用上一个交易日，open/high/low/volume 置空", () => {
    // 美股 01-06 休市（01-02 / 01-03 / 01-07 有报价），但 A 股 01-06 开着
    const calendar = ["2020-01-02", "2020-01-03", "2020-01-06", "2020-01-07"];
    const a = alignOverseasToCalendar(series(), calendar);
    expect(a.open).toEqual([100, 101, null, 103]);
    expect(a.close).toEqual([100.5, 101.5, 101.5, 103.5]);
    expect(a.high).toEqual([101, 102, null, 104]);
    expect(a.low).toEqual([99, 100, null, 102]);
    expect(a.volume).toEqual([10, 11, null, 13]);
    expect(a.closedDays).toBe(1);
    expect(a.staleDays).toBe(1);
  });

  it("填充只能往回看，绝不能拿后一天的收盘价来顶 —— 那是泄露未来", () => {
    const calendar = ["2020-01-02", "2020-01-03", "2020-01-06", "2020-01-07"];
    const a = alignOverseasToCalendar(series(), calendar);
    // 01-06 是休市日。如果实现写成「找最近的一天」而不是「<= 的最近一天」，
    // 这里会拿到 01-07 的 103.5，玩家在 01-06 就能看到隔夜的价格。
    expect(a.close[2]).toBe(101.5);
    expect(a.close[2]).not.toBe(103.5);
  });

  it("close 必须有值 —— 持仓不能在休市日掉回成本价", () => {
    // portfolio.ts 的 holdingsValue 是 `p ?? h.avgCost`：close 给了 null，
    // 持仓会在休市那天按成本价估值，权益曲线凭空跳一下。
    const calendar = ["2020-01-02", "2020-01-03", "2020-01-06"];
    const a = alignOverseasToCalendar(series(), calendar);
    expect(a.close.every((c) => c !== null)).toBe(true);
  });

  it("上市晚于窗口开头：上市前全是 null，不会被硬填成第一天的价", () => {
    // 阿里巴巴-W 是 2019-11-26 上市的
    const baba = series({
      code: "09988.HK",
      name: "阿里巴巴-W",
      market: "HK",
      currency: "HKD",
      dates: ["2019-11-26", "2019-11-27"],
      open: [187, 190],
      close: [188, 192],
      high: [190, 193],
      low: [186, 189],
      volume: [5, 6],
    });
    const calendar = ["2019-11-22", "2019-11-25", "2019-11-26", "2019-11-27"];
    const a = alignOverseasToCalendar(baba, calendar);
    expect(a.close).toEqual([null, null, 188, 192]);
    expect(a.open).toEqual([null, null, 187, 190]);
    expect(coverage(baba, calendar)).toBe(0.5);
  });

  it("prevClose 取窗口第一天之前的那一次收盘", () => {
    const calendar = ["2020-01-03", "2020-01-07"];
    const a = alignOverseasToCalendar(series(), calendar);
    // 01-02 的 100.5，不是 01-03 的 101.5
    expect(a.prevClose).toBe(100.5);
  });

  it("窗口第一天就是序列第一天时，prevClose 是 null 而不是硬编一个", () => {
    const calendar = ["2020-01-02", "2020-01-03"];
    expect(alignOverseasToCalendar(series(), calendar).prevClose).toBeNull();
  });

  it("境外标的永远不是 ST，行业留空 —— 不编一个不存在的分类", () => {
    const a = alignOverseasToCalendar(series(), ["2020-01-02"]);
    expect(a.isST).toBe(false);
    expect(a.industry).toBe("");
    expect(a.market).toBe("US");
    expect(a.currency).toBe("USD");
  });

  it("coverage 只数外盘真的开门的日子", () => {
    const calendar = ["2020-01-02", "2020-01-03", "2020-01-06", "2020-01-07"];
    // 四天里三天开门
    expect(coverage(series(), calendar)).toBe(0.75);
    expect(coverage(series(), [])).toBe(0);
  });

  it("干净的数据没有非正价格", () => {
    const calendar = ["2020-01-02", "2020-01-03", "2020-01-06", "2020-01-07"];
    expect(nonPositiveCount(alignOverseasToCalendar(series(), calendar))).toBe(0);
  });

  it("前复权扣穿成负数的标的能被认出来 —— 负价格进引擎不报错，只会算错", () => {
    // 星巴克 2016 年起整段前复权价是负的：累计股息超过了股价本身。
    // 这种序列必须在合并前挡掉：负 ÷ 负 的涨跌幅是正数，
    // 负数金额又小于可用资金，引擎一路放行，最后结算出一笔看不懂的收益。
    const sbux = series({
      code: "SBUX.US",
      name: "星巴克",
      dates: ["2016-11-01", "2016-11-02"],
      open: [-37.9, -37.6],
      close: [-37.74, -37.17],
      high: [-37.5, -37.1],
      low: [-38.0, -37.8],
      volume: [100, 200],
    });
    const a = alignOverseasToCalendar(sbux, ["2016-11-01", "2016-11-02"]);
    expect(nonPositiveCount(a)).toBe(8); // 4 列 × 2 天
  });
});

describe("汇率", () => {
  const fx: FxSeries = {
    code: "USDCNY",
    name: "美元兑人民币",
    dates: ["2020-01-03", "2020-01-06", "2020-01-07"],
    rate: [6.96, 6.97, 6.98],
  };

  it("取该日或之前最近一次公布价 —— 周末沿用上一次", () => {
    expect(fxRateOn(fx, "2020-01-03")).toBe(6.96);
    expect(fxRateOn(fx, "2020-01-06")).toBe(6.97);
    // 01-04 / 01-05 是周末，中行没公布，用 01-03 的
    expect(fxRateOn(fx, "2020-01-04")).toBe(6.96);
    expect(fxRateOn(fx, "2020-01-05")).toBe(6.96);
    // 晚于最后一档，沿用最后一档
    expect(fxRateOn(fx, "2020-06-01")).toBe(6.98);
  });

  it("汇率序列还没开始时返回 null，不假装是 0", () => {
    expect(fxRateOn(fx, "2019-12-31")).toBeNull();
  });

  it("折成人民币：人民币原样返回，外币乘汇率", () => {
    expect(toCny(1000, "CNY", null)).toBe(1000);
    expect(toCny(1000, "USD", 6.97)).toBe(6970);
    expect(toCny(1000, "HKD", 0.9)).toBeCloseTo(900, 6);
  });

  it("没有汇率就不要算 —— 按 1:1 算会把港币当成人民币，差 16%", () => {
    expect(toCny(1000, "USD", null)).toBeNull();
    expect(toCny(1000, "HKD", 0)).toBeNull();
    expect(toCny(1000, "HKD", Number.NaN)).toBeNull();
  });
});
