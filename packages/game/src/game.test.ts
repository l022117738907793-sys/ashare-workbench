import { describe, expect, it } from "vitest";
import {
  calcFee,
  createAccount,
  executeOrder,
  findHolding,
  maxDrawdownPct,
  periodReturnPct,
  priceLimitPct,
  realizedTrades,
  rolloverTradingDay,
  round2,
  settleSeason,
  totalAssets,
  validateOrder,
  winRatePct,
  type Account,
  type OrderRequest,
  type QuoteInput,
} from "./index";

const QUOTE = (over: Partial<QuoteInput> = {}): QuoteInput => ({
  code: "600519.SH",
  name: "贵州茅台",
  price: 10,
  prevClose: 10,
  ...over,
});

const REQ = (over: Partial<OrderRequest> = {}): OrderRequest => ({
  code: "600519.SH",
  name: "贵州茅台",
  side: "buy",
  shares: 100,
  quote: QUOTE(),
  date: "2026-09-23",
  at: 1_760_000_000_000,
  isTradingNow: true,
  ...over,
});

/** 跑一笔成交，断言成功并返回账户 */
function mustOk(account: Account, req: OrderRequest): Account {
  const res = executeOrder(account, req);
  if (!res.ok) throw new Error(`预期成交，却被拒：${res.reason}`);
  return res.account;
}

describe("费用计算", () => {
  it("佣金万 2.5，不足 5 元按 5 元", () => {
    expect(calcFee("buy", 1000).commission).toBe(5); // 0.25 → 最低 5
    expect(calcFee("buy", 100000).commission).toBe(25); // 100000 * 0.00025
  });

  it("印花税仅卖出收取", () => {
    expect(calcFee("buy", 100000).stampDuty).toBe(0);
    expect(calcFee("sell", 100000).stampDuty).toBe(100);
  });

  it("印花税按成交日生效：2023-08-28 起减半", () => {
    expect(calcFee("sell", 100000, "2023-08-25").stampDuty).toBe(100); // 千1
    expect(calcFee("sell", 100000, "2023-08-28").stampDuty).toBe(50); // 千0.5
    expect(calcFee("sell", 100000, "2026-09-23").stampDuty).toBe(50);
  });

  it("过户费双向收取", () => {
    expect(calcFee("buy", 100000).transferFee).toBe(1);
    expect(calcFee("sell", 100000).transferFee).toBe(1);
  });

  it("总费用 = 三项之和", () => {
    const f = calcFee("sell", 100000);
    expect(f.total).toBe(round2(f.commission + f.stampDuty + f.transferFee));
    expect(f.total).toBe(126); // 25 + 100 + 1
  });
});

describe("涨跌停幅度", () => {
  it("主板 10%、ST 5%、创业板/科创板 20%", () => {
    expect(priceLimitPct(false, false)).toBe(0.1);
    expect(priceLimitPct(true, false)).toBe(0.05);
    expect(priceLimitPct(false, true)).toBe(0.2);
    expect(priceLimitPct(true, true)).toBe(0.05); // ST 优先
  });
});

describe("下单校验", () => {
  const acc = createAccount(100000);

  it("买入必须是一手（100 股）整数倍", () => {
    expect(validateOrder(acc, REQ({ shares: 150 }))).toMatch(/100 股的整数倍/);
    expect(validateOrder(acc, REQ({ shares: 100 }))).toBeNull();
  });

  it("股数必须为正整数", () => {
    expect(validateOrder(acc, REQ({ shares: 0 }))).toMatch(/正整数/);
    expect(validateOrder(acc, REQ({ shares: -100 }))).toMatch(/正整数/);
    expect(validateOrder(acc, REQ({ shares: 100.5 }))).toMatch(/正整数/);
  });

  it("没有行情时拒绝，且不猜价格", () => {
    expect(validateOrder(acc, REQ({ quote: QUOTE({ price: null }) }))).toMatch(/不猜价格/);
    expect(validateOrder(acc, REQ({ quote: QUOTE({ price: 0 }) }))).toMatch(/不猜价格/);
  });

  it("停牌拒绝", () => {
    expect(validateOrder(acc, REQ({ quote: QUOTE({ suspended: true }) }))).toMatch(/停牌/);
  });

  it("资金不足拒绝，并给出差额", () => {
    const poor = createAccount(500);
    const msg = validateOrder(poor, REQ({ shares: 100 }));
    expect(msg).toMatch(/资金不足/);
    expect(msg).toMatch(/500\.00/);
  });

  it("无持仓不能卖", () => {
    expect(validateOrder(acc, REQ({ side: "sell", shares: 100 }))).toMatch(/没有该股持仓/);
  });

  it("涨停不能买、跌停不能卖", () => {
    // 主板 ±10%：prevClose=10 → 上限 11、下限 9
    expect(validateOrder(acc, REQ({ quote: QUOTE({ price: 11, prevClose: 10 }) }))).toMatch(/涨停/);
    const held = mustOk(acc, REQ());
    const unlocked = rolloverTradingDay(held, "2026-09-24", { "600519.SH": "2026-09-23" });
    expect(
      validateOrder(unlocked, REQ({ side: "sell", shares: 100, quote: QUOTE({ price: 9, prevClose: 10 }) })),
    ).toMatch(/跌停/);
  });

  it("ST 股涨跌停为 5%", () => {
    // prevClose=10 → 上限 10.50
    expect(validateOrder(acc, REQ({ quote: QUOTE({ price: 10.5, prevClose: 10 }), isST: true }))).toMatch(/涨停/);
    expect(validateOrder(acc, REQ({ quote: QUOTE({ price: 10.4, prevClose: 10 }), isST: true }))).toBeNull();
  });

  it("创业板 / 科创板涨跌停为 20%（板块由代码推断，不靠手动标记）", () => {
    // 注意股数：科创板最低 200 股，用默认 100 股会先被股数规则拦下
    for (const [code, shares] of [["300750.SZ", 100], ["688981.SH", 200]] as const) {
      expect(
        validateOrder(acc, REQ({ code, shares, quote: QUOTE({ price: 11, prevClose: 10 }) })),
        `${code} 在 11 元不应涨停`,
      ).toBeNull();
      expect(
        validateOrder(acc, REQ({ code, shares, quote: QUOTE({ price: 12, prevClose: 10 }) })),
        `${code} 在 12 元应涨停`,
      ).toMatch(/涨停/);
    }
  });

  it("创业板 20% 是 2020-08-24 起才生效（之前是 10%）", () => {
    // 2020-08-21（注册制前）11 元应判涨停
    expect(
      validateOrder(acc, REQ({
        code: "300750.SZ", shares: 100, date: "2020-08-21",
        quote: QUOTE({ price: 11, prevClose: 10 }),
      })),
    ).toMatch(/涨停/);
    // 2020-08-24 起 11 元不再涨停
    expect(
      validateOrder(acc, REQ({
        code: "300750.SZ", shares: 100, date: "2020-08-24",
        quote: QUOTE({ price: 11, prevClose: 10 }),
      })),
    ).toBeNull();
  });

  it("科创板最低买入 200 股，且可 1 股递增", () => {
    // 100 股不够
    expect(validateOrder(acc, REQ({ code: "688981.SH", shares: 100 }))).toMatch(/至少 200 股/);
    expect(validateOrder(acc, REQ({ code: "688981.SH", shares: 200 }))).toBeNull();
    expect(validateOrder(acc, REQ({ code: "688981.SH", shares: 201 }))).toBeNull(); // 1 股递增
  });

  it("创业板/科创板 ST 仍是 20%，不适用主板的 5%", () => {
    // 创业板 ST：11 元不该涨停（20% 限制）
    expect(
      validateOrder(acc, REQ({ code: "300750.SZ", shares: 100, isST: true, quote: QUOTE({ price: 11, prevClose: 10 }) })),
    ).toBeNull();
    // 主板 ST：10.5 元即涨停（5% 限制）
    expect(
      validateOrder(acc, REQ({ isST: true, quote: QUOTE({ price: 10.5, prevClose: 10 }) })),
    ).toMatch(/涨停/);
  });

  it("没有昨收时不做涨跌停限制", () => {
    expect(validateOrder(acc, REQ({ quote: QUOTE({ price: 99, prevClose: null }) }))).toBeNull();
  });
});

describe("T+1 规则", () => {
  it("当日买入的股份不可卖", () => {
    const acc = mustOk(createAccount(100000), REQ());
    const h = findHolding(acc, "600519.SH")!;
    expect(h.shares).toBe(100);
    expect(h.sellable).toBe(0);
    expect(validateOrder(acc, REQ({ side: "sell", shares: 100 }))).toMatch(/T\+1 限制/);
  });

  it("次一交易日解锁", () => {
    const acc = mustOk(createAccount(100000), REQ());
    // 同一天不解锁
    const same = rolloverTradingDay(acc, "2026-09-23", { "600519.SH": "2026-09-23" });
    expect(findHolding(same, "600519.SH")!.sellable).toBe(0);
    // 次日解锁
    const next = rolloverTradingDay(acc, "2026-09-24", { "600519.SH": "2026-09-23" });
    expect(findHolding(next, "600519.SH")!.sellable).toBe(100);
  });

  it("加仓时已解锁的部分保持可卖", () => {
    let acc = mustOk(createAccount(200000), REQ());
    acc = rolloverTradingDay(acc, "2026-09-24", { "600519.SH": "2026-09-23" });
    acc = mustOk(acc, REQ({ date: "2026-09-24" }));
    const h = findHolding(acc, "600519.SH")!;
    expect(h.shares).toBe(200);
    expect(h.sellable).toBe(100); // 只有第一天买的 100 股可卖
    expect(validateOrder(acc, REQ({ side: "sell", shares: 200 }))).toMatch(/T\+1 限制/);
    expect(validateOrder(acc, REQ({ side: "sell", shares: 100 }))).toBeNull();
  });
});

describe("成交与记账", () => {
  const req = REQ();

  it("买入：成交价含滑点，现金扣减含费用", () => {
    const before = createAccount(100000);
    const res = executeOrder(before, req);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // 10.00 * (1 + 0.001) = 10.01
    expect(res.trade.price).toBe(10.01);
    expect(res.trade.amount).toBe(1001);
    expect(res.trade.fee).toBe(round2(5 + 0 + 0.01));
    expect(res.account.cash).toBe(round2(100000 - 1001 - 5.01));
    expect(findHolding(res.account, "600519.SH")!.avgCost).toBeCloseTo(10.0601, 4);
  });

  it("卖出：成交价含滑点，现金入账扣费", () => {
    let acc = mustOk(createAccount(100000), req);
    acc = rolloverTradingDay(acc, "2026-09-24", { "600519.SH": "2026-09-23" });
    const cashBefore = acc.cash;

    const res = executeOrder(acc, REQ({ side: "sell", shares: 100, quote: QUOTE({ price: 12 }), date: "2026-09-24" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // 12.00 * (1 - 0.001) = 11.988 → 11.99
    expect(res.trade.price).toBe(11.99);
    expect(res.trade.amount).toBe(1199);
    // 佣金 5 + 印花税 1199*0.0005=0.60（2023-08-28 起减半）+ 过户费 0.01
    expect(res.trade.fee).toBe(round2(5 + 1199 * 0.0005 + 1199 * 0.00001));
    expect(res.account.cash).toBe(round2(cashBefore + 1199 - res.trade.fee));
    expect(findHolding(res.account, "600519.SH")).toBeUndefined();
  });

  it("加仓按加权平均摊薄成本", () => {
    let acc = mustOk(createAccount(200000), REQ());
    acc = mustOk(acc, REQ({ quote: QUOTE({ price: 20, prevClose: 20 }) }));
    const h = findHolding(acc, "600519.SH")!;
    expect(h.shares).toBe(200);
    // 两次成本分别约 10.0601 与 20.0700，加权后应落在两者之间且偏向
    expect(h.avgCost).toBeGreaterThan(10.06);
    expect(h.avgCost).toBeLessThan(20.08);
    expect(h.avgCost).toBeCloseTo((10.0601 * 100 + 20.0700 * 100) / 200, 2);
  });

  it("部分卖出后剩余持仓与可卖数正确", () => {
    let acc = mustOk(createAccount(200000), REQ());
    acc = mustOk(acc, REQ());
    acc = rolloverTradingDay(acc, "2026-09-24", { "600519.SH": "2026-09-23" });
    const res = executeOrder(acc, REQ({ side: "sell", shares: 100, date: "2026-09-24" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const h = findHolding(res.account, "600519.SH")!;
    expect(h.shares).toBe(100);
    expect(h.sellable).toBe(100);
  });

  it("不修改入参账户（纯函数）", () => {
    const before = createAccount(100000);
    const snapshot = JSON.stringify(before);
    executeOrder(before, req);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(before.holdings).toHaveLength(0);
    expect(before.cash).toBe(100000);
  });

  it("非交易时段成交会被标注", () => {
    const res = executeOrder(createAccount(100000), REQ({ isTradingNow: false }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trade.note).toMatch(/非交易时段/);
  });

  it("交易时段成交不标注", () => {
    const res = executeOrder(createAccount(100000), REQ({ isTradingNow: true }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trade.note).toBeUndefined();
  });

  it("记录下单时的引擎分类，供复盘对照", () => {
    const res = executeOrder(createAccount(100000), REQ({ typeAtTrade: "趋势观察" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trade.typeAtTrade).toBe("趋势观察");
  });

  it("被拒时不产生任何副作用", () => {
    const acc = createAccount(100);
    const res = executeOrder(acc, REQ());
    expect(res.ok).toBe(false);
    expect(acc.cash).toBe(100);
    expect(acc.trades).toHaveLength(0);
  });
});

describe("已实现盈亏与胜率", () => {
  function tradePair(buyPrice: number, sellPrice: number): Account {
    let acc = mustOk(createAccount(1_000_000), REQ({ quote: QUOTE({ price: buyPrice, prevClose: buyPrice }) }));
    acc = rolloverTradingDay(acc, "2026-09-24", { "600519.SH": "2026-09-23" });
    // 卖出时昨收取当日价，避免恰好落在涨跌停上（涨跌停另有专门用例覆盖）
    acc = mustOk(acc, REQ({ side: "sell", shares: 100, quote: QUOTE({ price: sellPrice, prevClose: sellPrice }), date: "2026-09-24" }));
    return acc;
  }

  it("盈利交易记为正盈亏", () => {
    const closed = realizedTrades(tradePair(10, 12));
    expect(closed).toHaveLength(1);
    expect(closed[0].pnl).toBeGreaterThan(0);
  });

  it("亏损交易记为负盈亏", () => {
    const closed = realizedTrades(tradePair(10, 8));
    expect(closed).toHaveLength(1);
    expect(closed[0].pnl).toBeLessThan(0);
  });

  it("未平仓时无已实现盈亏", () => {
    const acc = mustOk(createAccount(100000), REQ());
    expect(realizedTrades(acc)).toHaveLength(0);
  });

  it("无平仓交易时胜率为 null（而不是 0）", () => {
    expect(winRatePct(createAccount(100000))).toBeNull();
  });

  it("胜率按已平仓交易计算", () => {
    expect(winRatePct(tradePair(10, 12))).toBe(100);
    expect(winRatePct(tradePair(10, 8))).toBe(0);
  });
});

describe("绩效与结算", () => {
  it("最大回撤", () => {
    expect(maxDrawdownPct([{ date: "d1", total: 100 }, { date: "d2", total: 120 }, { date: "d3", total: 90 }])).toBe(25);
    expect(maxDrawdownPct([{ date: "d1", total: 100 }, { date: "d2", total: 110 }])).toBe(0);
    expect(maxDrawdownPct([])).toBe(0);
  });

  it("区间收益率", () => {
    expect(periodReturnPct([{ date: "d1", total: 100 }, { date: "d2", total: 110 }])).toBe(10);
    expect(periodReturnPct([{ date: "d1", total: 100 }, { date: "d2", total: 90 }])).toBe(-10);
    expect(periodReturnPct([])).toBe(0);
  });

  it("结算：跑赢/跑输基准以超额收益表达", () => {
    // 账户状态必须与净值曲线一致：初始 10 万，期末 11 万
    const account: Account = { ...createAccount(100000), cash: 110000 };
    const equity = [
      { date: "2026-09-01", total: 100000 },
      { date: "2026-09-30", total: 110000 },
    ];
    const bench = [
      { date: "2026-09-01", total: 4000 },
      { date: "2026-09-30", total: 4080 }, // 基准 +2%
    ];
    const r = settleSeason({
      account,
      equityCurve: equity,
      benchmarkCurve: bench,
      season: "2026-09",
      finalPrices: {},
    });
    expect(r.totalReturnPct).toBe(10);
    expect(r.benchmarkReturnPct).toBe(2);
    expect(r.excessReturnPct).toBe(8);
    expect(r.tradeCount).toBe(0);
  });

  it("期末资产用最新价格现算，而不是取曲线末值", () => {
    let account = mustOk(createAccount(100000), REQ({ quote: QUOTE({ price: 10 }) }));
    // 持仓 100 股，现价 20 → 市值 2000
    const assets = totalAssets(account, { "600519.SH": 20 });
    expect(assets).toBe(round2(account.cash + 2000));
  });

  it("取不到价格时用成本价兜底，不让持仓凭空消失", () => {
    const account = mustOk(createAccount(100000), REQ({ quote: QUOTE({ price: 10 }) }));
    const assets = totalAssets(account, { "600519.SH": null });
    const h = findHolding(account, "600519.SH")!;
    expect(assets).toBe(round2(account.cash + h.shares * h.avgCost));
  });
});
