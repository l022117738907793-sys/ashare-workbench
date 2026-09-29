import { describe, expect, it } from "vitest";
import {
  advanceDay,
  advanceDays,
  calcFee,
  cancelOrder,
  createReplay,
  jumpTo,
  pendingFor,
  pickRandomStartIndex,
  placeOrder,
  replayChangePct,
  replayClose,
  replayDate,
  replayDayMoves,
  replayPrices,
  settleReplay,
  type ReplayConfig,
  type ReplayInstrument,
  type ReplayState,
} from "./index";

/** 四个连续交易日，正好够测「当天挂单、次日开盘成交」 */
const CAL = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"];

function series(values: Array<number | null>): Array<number | null> {
  return [...values];
}

function instrument(over: Partial<ReplayInstrument> = {}): ReplayInstrument {
  return {
    code: "600519.SH",
    name: "贵州茅台",
    isST: false,
    // 第一天没有开盘价（当作开局当天，不需要成交），后面三天各有各的开盘价
    open: series([null, 10, 11, 12]),
    close: series([9.5, 10.5, 11.5, 12.5]),
    high: series([13, 13, 13, 13]),
    low: series([9, 9, 9, 9]),
    volume: series([1000, 1000, 1000, 1000]),
    ...over,
  };
}

function config(over: Partial<ReplayConfig> = {}): ReplayConfig {
  return {
    calendar: CAL,
    startIndex: 0,
    initialCash: 200_000,
    instruments: [instrument()],
    benchmarkClose: series([4000, 4040, 4080, 4100]),
    label: "测试局",
    ...over,
  };
}

/** 挂单并断言成功，返回新 state */
function mustPlace(state: ReplayState, code: string, side: "buy" | "sell", shares: number): ReplayState {
  const res = placeOrder(state, { code, side, shares });
  if (!res.ok) throw new Error(`预期能挂单，却被拒：${res.reason}`);
  return res.state;
}

function mustReject(state: ReplayState, code: string, side: "buy" | "sell", shares: number): string {
  const res = placeOrder(state, { code, side, shares });
  if (res.ok) throw new Error("预期被拒，却挂单成功");
  return res.reason;
}

describe("createReplay", () => {
  it("开局当天只有现金，净值曲线先放一个点", () => {
    const s = createReplay(config());
    expect(replayDate(s)).toBe("2026-09-21");
    expect(s.account.cash).toBe(200_000);
    expect(s.account.holdings).toHaveLength(0);
    expect(s.equity).toEqual([{ date: "2026-09-21", total: 200_000 }]);
    expect(s.finished).toBe(false);
  });

  it("起始日越界时夹到合法范围，落在最后一天就直接结束", () => {
    expect(replayDate(createReplay(config({ startIndex: -5 })))).toBe("2026-09-21");
    expect(replayDate(createReplay(config({ startIndex: 99 })))).toBe("2026-09-24");
    expect(createReplay(config({ startIndex: 3 })).finished).toBe(true);
  });
});

describe("成交价必须是次一交易日的开盘价", () => {
  it("在收盘后下单，按明天开盘价成交，不是今天收盘价、也不是明天收盘价", () => {
    let s = createReplay(config());
    s = mustPlace(s, "600519.SH", "buy", 100);

    // 挂单的这一刻账户分文未动——这是「推演」和「实时」在交互上的最大区别
    expect(s.account.trades).toHaveLength(0);
    expect(s.account.cash).toBe(200_000);
    expect(pendingFor(s, "600519.SH")).toHaveLength(1);

    s = advanceDay(s);
    expect(replayDate(s)).toBe("2026-09-22");
    expect(s.account.trades).toHaveLength(1);

    const trade = s.account.trades[0]!;
    expect(trade.date).toBe("2026-09-22");
    expect(trade.price).toBe(10.01); // 开盘价 10 × (1 + 0.1% 滑点)
    expect(trade.price).not.toBe(9.51); // 不是昨天收盘 9.5
    expect(trade.price).not.toBe(11.51); // 不是今天收盘 11.5
    // 成交价里含滑点，所以备注必须把「参考的开盘价」和「实际成交价」都写出来，
    // 否则玩家对着 K 线图会以为成交价算错了
    expect(trade.note).toContain("2026-09-22");
    expect(trade.note).toContain("开盘价 10.00");
    expect(trade.note).toContain("成交价 10.01");
    expect(trade.note).toContain("滑点");
    expect(s.pending).toHaveLength(0);
    expect(s.log.at(-1)?.ok).toBe(true);
    expect(s.log.at(-1)?.text).toContain("当日开盘价 10.00");
  });

  it("没有开盘价就作废并说明，不用别的价格顶替", () => {
    let s = createReplay(config({ instruments: [instrument({ open: series([null, null, 11, 12]) })] }));
    s = mustPlace(s, "600519.SH", "buy", 100);
    s = advanceDay(s);

    expect(s.account.trades).toHaveLength(0);
    expect(s.account.cash).toBe(200_000);
    const entry = s.log.at(-1);
    expect(entry?.ok).toBe(false);
    expect(entry?.text).toContain("没有开盘价");
    expect(entry?.text).toContain("不猜价格");
  });

  it("资金按真实开盘价判断：今天看着买得起，明天开盘涨了就买不起", () => {
    let s = createReplay(config({ initialCash: 1_100 }));
    // 今天收盘 9.5，1100 元看着能买 100 股；明天开盘 10，成交要 1001 + 手续费
    s = mustPlace(s, "600519.SH", "buy", 100);
    s = advanceDay(s);
    // 1100 元其实够（1001 + 5.01），先确认它能成交
    expect(s.account.trades).toHaveLength(1);

    let poor = createReplay(config({ initialCash: 1_000 }));
    poor = mustPlace(poor, "600519.SH", "buy", 100);
    poor = advanceDay(poor);
    expect(poor.account.trades).toHaveLength(0);
    expect(poor.log.at(-1)?.ok).toBe(false);
    expect(poor.log.at(-1)?.text).toContain("资金");
  });

  it("手续费按**成交日**的费率算，不是按下单日", () => {
    // 印花税 2023-08-28 起从千分之 1 减半到万分之 5。下单在 08-25、成交在 08-28，
    // 用错日期会多收一倍——这是历史回放里最容易悄悄错掉的地方。
    const cal = ["2023-08-23", "2023-08-24", "2023-08-25", "2023-08-28"];
    const spread = (v: number, first: number | null = v) => series([first, v, v, v]);
    let s = createReplay({
      calendar: cal,
      startIndex: 0,
      initialCash: 200_000,
      instruments: [
        instrument({
          open: spread(100, null),
          close: spread(100),
          high: spread(100),
          low: spread(100),
          volume: spread(1, null),
        }),
      ],
    });

    s = mustPlace(s, "600519.SH", "buy", 100);
    s = advanceDay(s); // 08-24 买入成交
    expect(s.account.trades[0]!.date).toBe("2023-08-24");

    s = advanceDay(s); // 08-25，T+1 解锁
    expect(s.account.holdings[0]!.sellable).toBe(100);

    s = mustPlace(s, "600519.SH", "sell", 100); // 08-25 下单
    s = advanceDay(s); // 08-28 成交

    const sell = s.account.trades.at(-1)!;
    expect(sell.side).toBe("sell");
    expect(sell.date).toBe("2023-08-28");
    expect(sell.fee).toBe(calcFee("sell", sell.amount, "2023-08-28").total);
    expect(sell.fee).toBeLessThan(calcFee("sell", sell.amount, "2023-08-25").total);
  });
});

describe("T+1 在推演里同样成立", () => {
  it("当天买入的股份当天卖不掉，隔一天才能卖", () => {
    let s = createReplay(config());
    s = mustPlace(s, "600519.SH", "buy", 100);
    s = advanceDay(s); // 09-22 开盘买入

    expect(s.account.holdings[0]!.sellable).toBe(0);
    expect(mustReject(s, "600519.SH", "sell", 100)).toContain("T+1");

    // 再推一天：先解锁，再撮合，所以 09-23 可以挂卖单，但要等到 09-24 才成交
    s = advanceDay(s);
    expect(s.account.holdings[0]!.sellable).toBe(100);
    s = mustPlace(s, "600519.SH", "sell", 100);
    s = advanceDay(s);

    const sell = s.account.trades.at(-1)!;
    expect(sell.date).toBe("2026-09-24");
    expect(sell.price).toBe(11.99); // 开盘 12 × (1 − 0.1%)
    expect(s.account.holdings).toHaveLength(0);
  });

  it("推进顺序是「先解锁再成交」，不会出现当天买当天卖", () => {
    let s = createReplay(config());
    s = mustPlace(s, "600519.SH", "buy", 100);
    s = advanceDay(s);
    // 若实现把撮合放在解锁之前，下面这笔当天买入就立刻变成可卖了
    expect(s.account.holdings[0]!.sellable).toBe(0);
    expect(pendingFor(s)).toHaveLength(0);
  });
});

describe("挂单校验", () => {
  it("买入必须是 100 股整数倍", () => {
    const s = createReplay(config());
    expect(mustReject(s, "600519.SH", "buy", 150)).toContain("100 股的整数倍");
    expect(mustReject(s, "600519.SH", "buy", 0)).toContain("正整数");
    expect(mustReject(s, "600519.SH", "buy", 1.5)).toContain("正整数");
  });

  it("没有持仓不能卖，没有数据不能买", () => {
    const s = createReplay(config());
    expect(mustReject(s, "600519.SH", "sell", 100)).toContain("没有持仓");
    expect(mustReject(s, "000001.SZ", "buy", 100)).toContain("没有这只股票");
  });

  it("结束后不能再下单", () => {
    const s = createReplay(config({ startIndex: 3 }));
    expect(s.finished).toBe(true);
    expect(mustReject(s, "600519.SH", "buy", 100)).toContain("已经结束");
  });

  it("可以撤单，撤掉的不会成交", () => {
    let s = createReplay(config());
    s = mustPlace(s, "600519.SH", "buy", 100);
    const id = s.pending[0]!.id;
    s = cancelOrder(s, id);
    expect(s.pending).toHaveLength(0);

    s = advanceDay(s);
    expect(s.account.trades).toHaveLength(0);
    expect(s.account.cash).toBe(200_000);
  });

  it("委托按挂单先后成交：先卖的拿到钱，后面的买才付得起", () => {
    const cal = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"];
    const px = (v: number, first: number | null = v) => series([first, v, v, v]);
    const flat = (code: string, name: string) =>
      instrument({ code, name, open: px(100, null), close: px(100), high: px(100), low: px(100), volume: px(1, null) });

    let s = createReplay({
      calendar: cal,
      startIndex: 0,
      initialCash: 20_000,
      instruments: [flat("600519.SH", "贵州茅台"), flat("000001.SZ", "平安银行")],
    });

    s = mustPlace(s, "600519.SH", "buy", 100); // 10_010 元
    s = advanceDay(s); // 09-22 买入成交，现金约 9_985
    expect(s.account.holdings).toHaveLength(1);

    s = advanceDay(s); // 09-23 解锁
    s = mustPlace(s, "600519.SH", "sell", 100);
    s = mustPlace(s, "000001.SZ", "buy", 100); // 又一只 10_010 元的，不先卖出茅台就买不起
    expect(s.pending.map((o) => o.code)).toEqual(["600519.SH", "000001.SZ"]);

    s = advanceDay(s); // 09-24 按挂单顺序成交
    const filled = s.log.filter((e) => e.ok && e.date === "2026-09-24");
    expect(filled.map((e) => e.code)).toEqual(["600519.SH", "000001.SZ"]);
    expect(s.account.holdings.map((h) => h.code)).toEqual(["000001.SZ"]);
  });
});

describe("推进与快进", () => {
  it("advanceDay 逐日走，净值曲线一天一个点", () => {
    let s = createReplay(config());
    s = advanceDays(s, 3);
    expect(replayDate(s)).toBe("2026-09-24");
    expect(s.finished).toBe(true);
    expect(s.equity.map((p) => p.date)).toEqual(CAL);
  });

  it("走完之后再推进是空操作", () => {
    const s = advanceDays(createReplay(config()), 99);
    expect(advanceDay(s)).toBe(s);
    expect(advanceDays(s, 5)).toBe(s);
  });

  it("跳转是逐日走的，中途的委托照样成交", () => {
    let s = createReplay(config());
    s = mustPlace(s, "600519.SH", "buy", 100);
    s = jumpTo(s, 3);
    expect(replayDate(s)).toBe("2026-09-24");
    expect(s.account.trades).toHaveLength(1); // 09-22 那次成交没有被跳过
    expect(s.account.trades[0]!.date).toBe("2026-09-22");
  });

  it("jumpTo 不会往回走", () => {
    let s = createReplay(config());
    s = advanceDays(s, 2);
    expect(jumpTo(s, 0)).toBe(s);
  });
});

describe("回放里的行情读取", () => {
  it("涨跌幅缺前一天数据时返回 null，不假装是 0", () => {
    const s = createReplay(config());
    expect(replayChangePct(s, "600519.SH", 1)).toBeCloseTo((10.5 / 9.5 - 1) * 100, 6);
    expect(replayChangePct(s, "600519.SH", 0)).toBeNull();
    expect(replayChangePct(s, "000001.SZ", 1)).toBeNull();
  });

  it("市值表覆盖全部标的，缺价格的记 null", () => {
    const s = createReplay(config({ instruments: [instrument(), instrument({ code: "000001.SZ", name: "平安银行", close: series([1, null, 3, 4]) })] }));
    const prices = replayPrices(s, 1);
    expect(prices["600519.SH"]).toBe(10.5);
    expect(prices["000001.SZ"]).toBeNull();
    expect(replayClose(s, "000001.SZ", 1)).toBeNull();
  });

  it("涨幅榜把最弱的排在最后", () => {
    const s = createReplay(config({
      instruments: [
        instrument({ code: "A.SH", name: "甲", close: series([10, 11, 11, 11]) }),
        instrument({ code: "B.SH", name: "乙", close: series([10, 9, 9, 9]) }),
      ],
    }));
    const { gainers, losers } = replayDayMoves(s, 1);
    expect(gainers[0]!.name).toBe("甲");
    expect(losers[0]!.name).toBe("乙");
  });
});

describe("结算与随机开局", () => {
  it("结算用最终的持仓价格现场算总资产，并带上基准", () => {
    let s = createReplay(config());
    s = mustPlace(s, "600519.SH", "buy", 100);
    s = advanceDays(s, 3); // 一路到 09-24，持仓市值按 12.5 算
    const { result, state } = settleReplay(s);

    expect(result.season).toBe("测试局");
    expect(result.startDate).toBe("2026-09-21");
    expect(result.endDate).toBe("2026-09-24");
    expect(result.tradeCount).toBe(1);
    expect(result.finalAssets).toBeCloseTo(200_000 - 1001 - calcFee("buy", 1001, "2026-09-22").total + 12.5 * 100, 2);
    // 基准 4000 → 4100 = +2.5%
    expect(result.benchmarkReturnPct).toBeCloseTo(2.5, 2);
    expect(state.account.seasons).toHaveLength(1);
  });

  it("没有基准数据时不报超额收益，仍然给收益率和回撤", () => {
    let s = createReplay(config({ benchmarkClose: undefined }));
    s = advanceDays(s, 3);
    const { result } = settleReplay(s);
    expect(result.benchmarkReturnPct).toBe(0);
    expect(result.totalReturnPct).toBe(0);
    expect(result.maxDrawdownPct).toBe(0);
  });

  it("随机开局落在还能玩够天数的范围内，且可复现", () => {
    const cal = Array.from({ length: 100 }, (_, i) => `d${i}`);
    expect(pickRandomStartIndex(cal, 20, () => 0)).toBe(0);
    expect(pickRandomStartIndex(cal, 20, () => 0.999999)).toBe(79);
    expect(pickRandomStartIndex(cal, 20, () => 0.5)).toBe(pickRandomStartIndex(cal, 20, () => 0.5));
    // 日历本身就短于一次完整游玩时，只能从第 0 天开始
    expect(pickRandomStartIndex(["a", "b"], 20, () => 0.9)).toBe(0);
  });
});
