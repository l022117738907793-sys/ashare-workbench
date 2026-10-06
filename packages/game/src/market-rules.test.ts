/**
 * 港美股接进钱路后的行为锁定。
 *
 * 和 A 股的差别全在规则层：T+0、无涨跌停、另一套费率和手数。
 * 这里逐条钉死，免得日后改 rules.ts 时悄悄退回「所有市场都按 A 股算」——
 * 那种回退不会报错，只会让港股的委托被 T+1 拦住、美股被按千分之一收印花税。
 *
 * 约定：引擎里所有金额都是人民币（境外价格在分片加载时就折好了，
 * 见 apps/web/src/lib/replay.ts 的 `convertShardToCny`），所以这里的
 * fx 指的是「1 单位本币值多少人民币」。
 */
import { describe, expect, it } from "vitest";
import { calcFee, createAccount, executeOrder, validateOrder } from "./portfolio";
import { advanceDay, createReplay, placeOrder, rateAt, type ReplayConfig } from "./replay";
import { hasPriceLimit, isTPlusOne, lotRulesAt, marketGroupOf } from "./rules";
import type { OrderRequest } from "./types";

/** 港股：1 港币 = 0.9 人民币 */
const HK_FX = 0.9;

function req(over: Partial<OrderRequest> = {}): OrderRequest {
  return {
    code: "00700.HK",
    name: "腾讯控股",
    side: "buy",
    shares: 100,
    quote: { code: "00700.HK", name: "腾讯控股", price: 300, prevClose: 300 },
    date: "2020-07-02",
    at: 0,
    isTradingNow: true,
    fx: HK_FX,
    ...over,
  };
}

describe("市场识别", () => {
  it("按代码后缀分市场，认不出的按 A 股", () => {
    expect(marketGroupOf("00700.HK")).toBe("HK");
    expect(marketGroupOf("AAPL.US")).toBe("US");
    expect(marketGroupOf("600519.SH")).toBe("CN");
    expect(marketGroupOf("乱码")).toBe("CN");
  });

  it("只有 A 股是 T+1、只有 A 股有涨跌停", () => {
    expect(isTPlusOne("CN")).toBe(true);
    expect(isTPlusOne("HK")).toBe(false);
    expect(isTPlusOne("US")).toBe(false);
    expect(hasPriceLimit("CN")).toBe(true);
    expect(hasPriceLimit("HK")).toBe(false);
    expect(hasPriceLimit("US")).toBe(false);
  });
});

describe("费率按市场分", () => {
  it("港股 100 港币的最低佣金要按汇率折回人民币", () => {
    // 10000 元 ÷ 0.9 = 11111 港币，按万 2.5 只有 27.8 港币，够不到下限
    expect(calcFee("buy", 10000, "2020-07-02", { market: "HK", fx: HK_FX }).commission).toBe(90);
    // 漏传 fx 就会当成「最低 100 元」，小单凭空多收 11%
    expect(calcFee("buy", 10000, "2020-07-02", { market: "HK" }).commission).toBe(100);
  });

  it("港股金额够大时按万 2.5 收，下限不参与", () => {
    // 90 万 ÷ 0.9 = 100 万港币，万 2.5 = 2500 港币 = 2250 元
    expect(calcFee("buy", 900000, "2020-07-02", { market: "HK", fx: HK_FX }).commission).toBe(2250);
  });

  it("港股印花税买卖双边都收，A 股只有卖出收", () => {
    expect(calcFee("buy", 100000, "2020-07-02", { market: "HK", fx: HK_FX }).stampDuty).toBe(100);
    expect(calcFee("sell", 100000, "2020-07-02", { market: "HK", fx: HK_FX }).stampDuty).toBe(100);
    expect(calcFee("buy", 100000, "2020-07-02").stampDuty).toBe(0);
    expect(calcFee("sell", 100000, "2020-07-02").stampDuty).toBe(100);
  });

  it("美股零佣金、无印花税——「A 股要交税、美股不花钱」本身就是教学点", () => {
    expect(calcFee("sell", 100000, "2020-07-02", { market: "US" }).total).toBe(0);
    expect(calcFee("buy", 100000, "2020-07-02", { market: "US" }).total).toBe(0);
  });

  it("不传 market 就还是 A 股那套（旧调用点不受影响）", () => {
    const a = calcFee("buy", 10000, "2020-07-02");
    const b = calcFee("buy", 10000, "2020-07-02", { market: "CN" });
    expect(a).toEqual(b);
    expect(a.commission).toBe(5); // 万 2.5 只有 2.5 元，按 5 元下限
  });
});

describe("T+0：港股美股当日买入当日可卖", () => {
  it("港股买入后 sellable 就是全部股数", () => {
    const res = executeOrder(createAccount(100000), req({ shares: 100 }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.account.holdings[0]?.sellable).toBe(100);
  });

  it("美股同样当日可卖", () => {
    const res = executeOrder(
      createAccount(100000),
      req({
        code: "AAPL.US",
        name: "苹果",
        shares: 10,
        quote: { code: "AAPL.US", name: "苹果", price: 150, prevClose: 150 },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.account.holdings[0]?.sellable).toBe(10);
  });

  it("A 股买入后当天一股都不能卖", () => {
    const res = executeOrder(
      createAccount(100000),
      req({
        code: "600519.SH",
        name: "贵州茅台",
        fx: null,
        quote: { code: "600519.SH", name: "贵州茅台", price: 300, prevClose: 300 },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.account.holdings[0]?.sellable).toBe(0);
  });

  it("港股当天买的当天就能卖出去", () => {
    const bought = executeOrder(createAccount(100000), req({ shares: 100 }));
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;
    const sell = executeOrder(
      bought.account,
      req({
        side: "sell",
        shares: 100,
        quote: { code: "00700.HK", name: "腾讯控股", price: 310, prevClose: 300 },
      }),
    );
    expect(sell.ok).toBe(true);
  });

  it("A 股当天买的当天卖不掉，而且说的是 T+1 而不是「可卖数量不足」", () => {
    const bought = executeOrder(
      createAccount(100000),
      req({
        code: "600519.SH",
        name: "贵州茅台",
        fx: null,
        quote: { code: "600519.SH", name: "贵州茅台", price: 300, prevClose: 300 },
      }),
    );
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;
    const sell = executeOrder(
      bought.account,
      req({
        code: "600519.SH",
        name: "贵州茅台",
        side: "sell",
        shares: 100,
        fx: null,
        quote: { code: "600519.SH", name: "贵州茅台", price: 310, prevClose: 300 },
      }),
    );
    expect(sell.ok).toBe(false);
    if (sell.ok) return;
    expect(sell.reason).toContain("T+1");
  });
});

describe("涨跌停只对 A 股生效", () => {
  it("港股涨 50% 也照买不误", () => {
    const r = validateOrder(
      createAccount(1000000),
      req({
        shares: 100,
        quote: { code: "00700.HK", name: "腾讯控股", price: 450, prevClose: 300 },
      }),
    );
    expect(r).toBeNull();
  });

  it("同样幅度的 A 股会被涨停拦住", () => {
    const r = validateOrder(
      createAccount(1000000),
      req({
        code: "600519.SH",
        name: "贵州茅台",
        fx: null,
        shares: 100,
        quote: { code: "600519.SH", name: "贵州茅台", price: 450, prevClose: 300 },
      }),
    );
    expect(r).toContain("涨停");
  });
});

describe("手数按市场分", () => {
  it("港股一手 100 股、美股 1 股起", () => {
    expect(lotRulesAt("main", "HK")).toEqual({ minShares: 100, increment: 100 });
    expect(lotRulesAt("main", "US")).toEqual({ minShares: 1, increment: 1 });
  });

  it("美股买 1 股是合法的（A 股至少要 100）", () => {
    expect(
      validateOrder(
        createAccount(1000000),
        req({
          code: "AAPL.US",
          name: "苹果",
          shares: 1,
          quote: { code: "AAPL.US", name: "苹果", price: 150, prevClose: 150 },
        }),
      ),
    ).toBeNull();
    expect(
      validateOrder(
        createAccount(1000000),
        req({
          code: "600519.SH",
          name: "贵州茅台",
          fx: null,
          shares: 1,
          quote: { code: "600519.SH", name: "贵州茅台", price: 150, prevClose: 150 },
        }),
      ),
    ).toContain("100 股");
  });
});

describe("rateAt 取汇率", () => {
  const inst = {
    code: "00700.HK",
    name: "腾讯控股",
    isST: false,
    market: "HK" as const,
    currency: "HKD" as const,
    open: [300, 300, 301],
    close: [300, 301, 301],
    high: [300, 301, 301],
    low: [300, 300, 301],
    volume: [1, 1, 1],
  };
  const config: ReplayConfig = {
    calendar: ["2020-07-02", "2020-07-03", "2020-07-06"],
    startIndex: 0,
    initialCash: 100000,
    instruments: [inst],
    fx: [{ currency: "HKD", rate: [0.9, null, 0.91] }],
  };

  it("A 股恒为 1，不需要汇率", () => {
    expect(rateAt(config, undefined, 0)).toBe(1);
  });

  it("港股取当天的汇率", () => {
    expect(rateAt(config, inst, 0)).toBe(HK_FX);
    expect(rateAt(config, inst, 2)).toBe(0.91);
  });

  it("汇率缺的那天沿用上一个已知值", () => {
    expect(rateAt(config, inst, 1)).toBe(HK_FX);
  });

  it("分片里没有这个币种就返回 null，交给 calcFee 按 1:1 兜底", () => {
    expect(rateAt({ ...config, fx: undefined }, inst, 0)).toBeNull();
  });
});

describe("整局跑通：港股的委托按港币费率收钱", () => {
  function hkConfig(): ReplayConfig {
    return {
      calendar: ["2020-07-02", "2020-07-03"],
      startIndex: 0,
      initialCash: 100000,
      instruments: [
        {
          code: "00700.HK",
          name: "腾讯控股",
          isST: false,
          market: "HK",
          currency: "HKD",
          open: [300, 300],
          close: [300, 300],
          high: [300, 300],
          low: [300, 300],
          volume: [1, 1],
        },
      ],
      fx: [{ currency: "HKD", rate: [0.9, 0.9] }],
    };
  }

  it("次日开盘成交，手续费含 100 港币最低佣金与双边印花税", () => {
    const placed = placeOrder(createReplay(hkConfig()), {
      code: "00700.HK",
      side: "buy",
      shares: 100,
    });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;

    const s1 = advanceDay(placed.state);
    expect(s1.log[0]?.ok).toBe(true);
    const trade = s1.account.trades[0];
    expect(trade).toBeDefined();
    // 开盘 300 加 0.1% 滑点 = 300.3，× 100 股 = 30030 元
    expect(trade?.price).toBe(300.3);
    expect(trade?.amount).toBe(30030);
    // 佣金：100 港币下限 × 0.9 = 90 元
    // 印花税：30030 × 0.1% = 30.03 元（买入也收，这是港股和 A 股最刺眼的差别）
    expect(trade?.fee).toBeCloseTo(120.03, 2);
  });

  it("同一局里 A 股的费率没被带偏", () => {
    const cfg = hkConfig();
    cfg.instruments.push({
      code: "600519.SH",
      name: "贵州茅台",
      isST: false,
      market: "CN",
      currency: "CNY",
      open: [300, 300],
      close: [300, 300],
      high: [300, 300],
      low: [300, 300],
      volume: [1, 1],
    });
    const placed = placeOrder(createReplay(cfg), {
      code: "600519.SH",
      side: "buy",
      shares: 100,
    });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;

    const trade = advanceDay(placed.state).account.trades[0];
    // 佣金 30030 × 万 2.5 = 7.51（高于 5 元下限）、印花税 0、过户费 0.3
    expect(trade?.fee).toBeCloseTo(7.81, 2);
  });
});
