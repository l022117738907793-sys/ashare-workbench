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
import {
  boardOf,
  describeRules,
  hasPriceLimit,
  isTPlusOne,
  limitPctAt,
  lotRulesAt,
  marketGroupOf,
  taxName,
} from "./rules";
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
    expect(marketGroupOf("7203.JP")).toBe("JP");
    expect(marketGroupOf("005930.KR")).toBe("KR");
    expect(marketGroupOf("600519.SH")).toBe("CN");
    expect(marketGroupOf("乱码")).toBe("CN");
  });

  it("只有 A 股是 T+1；涨跌停看「能不能用一个百分比表达」", () => {
    expect(isTPlusOne("CN")).toBe(true);
    expect(isTPlusOne("HK")).toBe(false);
    expect(isTPlusOne("US")).toBe(false);
    expect(isTPlusOne("JP")).toBe(false);
    expect(isTPlusOne("KR")).toBe(false);
    expect(hasPriceLimit("CN")).toBe(true);
    expect(hasPriceLimit("KR")).toBe(true); // 韩股就是 ±30%，一个数说完
    expect(hasPriceLimit("HK")).toBe(false);
    expect(hasPriceLimit("US")).toBe(false);
    // 日股有涨跌停，但按前收价分 35 档**绝对金额**（2000 日元以下是 ±100、5000 日元档是 ±400…），
    // 编一个百分比比不限制更错 —— 所以这里报 false，界面上另写一句说明。
    expect(hasPriceLimit("JP")).toBe(false);
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

/** 韩元：1 韩元 = 0.004958 人民币（2026-10-06 中行折算价 ÷ 100） */
const KR_FX = 0.004958;

function krReq(over: Partial<OrderRequest> = {}): OrderRequest {
  return {
    code: "005930.KR",
    name: "三星电子",
    side: "buy",
    shares: 1,
    quote: { code: "005930.KR", name: "三星电子", price: 272000, prevClose: 276000 },
    date: "2026-10-06",
    at: 0,
    isTradingNow: true,
    fx: KR_FX,
    ...over,
  };
}

describe("韩股：卖方证券交易税是日韩里唯一会显著改变盈亏的一项", () => {
  it("2026-01-01 起证券交易税 0.20%，之前是 0.15%", () => {
    // 0.20% 是 A 股印花税（0.05%）的四倍 —— 名字写错会让人低估它
    expect(calcFee("sell", 1000000, "2026-10-06", { market: "KR" }).stampDuty).toBe(2000);
    expect(calcFee("sell", 1000000, "2025-06-02", { market: "KR" }).stampDuty).toBe(1500);
  });

  it("证券交易税只在卖出收；佣金 0.015% 且没有下限", () => {
    const buy = calcFee("buy", 1000000, "2026-10-06", { market: "KR" });
    expect(buy.stampDuty).toBe(0);
    expect(buy.commission).toBe(150);
    // 小单不吃最低佣金 —— 与 A 股的 5 元、港股的 100 港币都不同
    expect(calcFee("buy", 1000, "2026-10-06", { market: "KR" }).commission).toBe(0.15);
  });

  it("日股零佣金零税，但手数是 100 股（単元株）", () => {
    expect(calcFee("sell", 1000000, "2026-10-06", { market: "JP" }).total).toBe(0);
    expect(lotRulesAt("main", "JP")).toEqual({ minShares: 100, increment: 100 });
    expect(lotRulesAt("main", "KR")).toEqual({ minShares: 1, increment: 1 });
  });

  it("韩股 ±30% 不能退回 A 股板块表", () => {
    // 漏传 market 时 boardOf("005930.KR") 会落到 "main" → ±10%，
    // 症状是「三星涨了 15% 就买不进去」，而且不报错
    expect(limitPctAt("2026-10-06", "main", false, "KR")).toBe(0.3);
    expect(limitPctAt("2026-10-06", "main", false)).toBe(0.1);
  });

  it("韩国那项叫「证券交易税」而不是「印花税」", () => {
    expect(taxName("KR")).toBe("证券交易税");
    expect(taxName("CN")).toBe("印花税");
    expect(taxName("HK")).toBe("印花税");

    const kr = describeRules("2026-10-06", boardOf("005930.KR"), "KR").join("\n");
    expect(kr).toContain("证券交易税 0.20%（仅卖出）");
    expect(kr).not.toContain("印花税");
    expect(kr).toContain("佣金 0.015%，无最低");
    expect(kr).toContain("涨跌停 ±30%");
    expect(kr).toContain("T+0");
    expect(kr).toContain("1 股起，可 1 股递增");
  });

  it("日股的涨跌停写成「35 档绝对金额」，不编百分比也不说「无」", () => {
    const jp = describeRules("2026-10-06", boardOf("7203.JP"), "JP").join("\n");
    expect(jp).toContain("35 档");
    expect(jp).not.toContain("±10%");
    expect(jp).not.toContain("无涨跌停");
    expect(jp).toContain("100 股起，100 股递增");
    expect(jp).toContain("T+0");
  });

  it("韩股 T+0：买入当天就能卖（T+2 只是交割，不是可卖限制）", () => {
    const res = executeOrder(createAccount(1000000), krReq({ shares: 2 }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.account.holdings[0]?.sellable).toBe(2);
  });

  it("韩股 +30% 涨停拒买，但 +8.7% 不该被 A 股的 ±10% 误伤", () => {
    // 276000 × 1.3 = 358800 是韩股的涨停价
    const atLimit = krReq({
      shares: 1,
      quote: { code: "005930.KR", name: "三星电子", price: 358800, prevClose: 276000 },
    });
    expect(validateOrder(createAccount(1000000), atLimit)).toContain("涨停");

    // 300000 / 276000 - 1 = +8.7%：按 A 股口径它离 ±10% 只差一点点，
    // 一旦漏传 market 就会换个阈值把结论翻过来
    const near = krReq({
      shares: 1,
      quote: { code: "005930.KR", name: "三星电子", price: 300000, prevClose: 276000 },
    });
    expect(validateOrder(createAccount(1000000), near)).toBeNull();
  });

  it("整局跑通：韩股的买入按 0.015% 佣金收钱，且当天可卖", () => {
    /*
     * 引擎里的金额一律是人民币（境外价在分片加载时就折好了），
     * 所以这里把三星的价格写成「272000 韩元 × 0.005 = 1360 元」。
     * 如果误把韩元价直接填进来，佣金会按 fx=1 算成 40.84 元而不是 204 元。
     */
    const cfg: ReplayConfig = {
      calendar: ["2026-10-06", "2026-10-07"],
      startIndex: 0,
      initialCash: 100000000,
      instruments: [
        {
          code: "005930.KR",
          name: "三星电子",
          isST: false,
          market: "KR",
          currency: "KRW",
          open: [1360, 1360],
          close: [1360, 1360],
          high: [1360, 1360],
          low: [1360, 1360],
          volume: [1, 1],
        },
      ],
      fx: [{ currency: "KRW", rate: [0.005, 0.005] }],
    };
    const placed = placeOrder(createReplay(cfg), {
      code: "005930.KR",
      side: "buy",
      shares: 1000,
    });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;

    const state = advanceDay(placed.state);
    const trade = state.account.trades[0];
    // 开盘 1360 加 0.1% 滑点 = 1361.36，× 1000 股 = 1361360 元
    expect(trade?.price).toBe(1361.36);
    expect(trade?.amount).toBe(1361360);
    // 佣金：1361360 ÷ 0.005 = 272,272,000 韩元 × 0.015% = 40840.8 韩元 × 0.005 = 204.204 → 204.2 元
    // 买入不收证券交易税，也没有过户费
    expect(trade?.fee).toBe(204.2);
    // 韩股 T+0：买入当天就能卖
    expect(state.account.holdings[0]?.sellable).toBe(1000);
  });
});
