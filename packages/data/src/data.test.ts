import { describe, expect, it, vi } from "vitest";
import {
  chunk,
  currencyOf,
  fromEastmoney,
  fromTencentSymbol,
  groupOfCode,
  marketGroupOf,
  parseCode,
  toEastmoneySecid,
  toTencentSymbol,
} from "./codes";
import { fetchQuotes } from "./quotes";
import { beijingTime, isCalendarFresh, isTradingNow, marketTime, msUntilNextOpen, sessionState } from "./session";
import {
  applyLivePrices,
  convertSnapshotToCny,
  fxRatesOfMeta,
  fxSeriesOfMeta,
  type SnapshotBundle,
} from "./snapshot";
import type { Quote, QuoteProvider } from "./types";

/** 北京时间 → 对应 UTC 瞬间 */
function bj(iso: string, h: number, mi = 0): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, h - 8, mi));
}

describe("代码格式转换", () => {
  it("解析内部代码", () => {
    expect(parseCode("600519.SH")).toEqual({ num: "600519", market: "SH" });
    expect(parseCode("000001.SZ")).toEqual({ num: "000001", market: "SZ" });
    expect(parseCode(" 300750.sz ")).toEqual({ num: "300750", market: "SZ" });
    expect(parseCode("600519")).toBeNull();
    expect(parseCode("BAD")).toBeNull();
  });

  it("转东方财富 secid（沪=1, 深=0）", () => {
    expect(toEastmoneySecid("600519.SH")).toBe("1.600519");
    expect(toEastmoneySecid("000001.SZ")).toBe("0.000001");
    expect(toEastmoneySecid("399006.SZ")).toBe("0.399006");
    expect(toEastmoneySecid("000300.SH")).toBe("1.000300");
    expect(toEastmoneySecid("nope")).toBeNull();
  });

  it("转腾讯 symbol 并往返一致", () => {
    expect(toTencentSymbol("600519.SH")).toBe("sh600519");
    expect(toTencentSymbol("000001.SZ")).toBe("sz000001");
    expect(toTencentSymbol("bad")).toBeNull();
    for (const c of ["600519.SH", "000001.SZ", "300750.SZ"]) {
      expect(fromTencentSymbol(toTencentSymbol(c)!)).toBe(c);
    }
  });

  it("东财 f12/f13 还原内部代码", () => {
    expect(fromEastmoney("600519", 1)).toBe("600519.SH");
    expect(fromEastmoney("000001", 0)).toBe("000001.SZ");
    expect(fromEastmoney("000001", "0")).toBe("000001.SZ");
  });

  it("chunk 切块", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
});

describe("境外代码（港股 / 美股）", () => {
  it("解析港股：4–5 位数字，前导零要留住", () => {
    expect(parseCode("00700.HK")).toEqual({ num: "00700", market: "HK" });
    expect(parseCode("09988.HK")).toEqual({ num: "09988", market: "HK" });
    // 长实集团是 4 位，不能因为「A 股是 6 位」就把 4 位拒掉
    expect(parseCode("0700.HK")).toEqual({ num: "0700", market: "HK" });
    expect(parseCode("700.HK")).toBeNull(); // 3 位不是港股代码
    expect(parseCode("00700")).toBeNull(); // 没后缀一律不认
  });

  it("解析美股：字母代码，统一转大写", () => {
    expect(parseCode("AAPL.US")).toEqual({ num: "AAPL", market: "US" });
    expect(parseCode("aapl.us")).toEqual({ num: "AAPL", market: "US" });
    // 伯克希尔 B 类是 BRK.B，代码里带点 —— 不能按分隔点去切
    expect(parseCode("BRK.B.US")).toEqual({ num: "BRK.B", market: "US" });
    expect(parseCode(".US")).toBeNull(); // 空代码
  });

  it("转东方财富 secid：港股 116，美股宁可返回 null", () => {
    expect(toEastmoneySecid("00700.HK")).toBe("116.00700");
    expect(toEastmoneySecid("AAPL.US")).toBeNull();
    // 这一条是给未来的守卫：东财美股要 105/106/107 分交易所，光看代码判断不出，
    // 猜错的 secid 会拉到别的公司的行情 —— 不如返回 null 让调用方退到腾讯源。
    expect(toEastmoneySecid("BABA.US")).toBeNull();
  });

  it("转腾讯 symbol 并往返一致", () => {
    expect(toTencentSymbol("00700.HK")).toBe("hk00700");
    expect(toTencentSymbol("AAPL.US")).toBe("usAAPL");
    for (const c of ["00700.HK", "09988.HK", "AAPL.US", "BRK.B.US"]) {
      expect(fromTencentSymbol(toTencentSymbol(c)!)).toBe(c);
    }
  });

  it("东财 f13 还原：116 是港股，105/106/107 都是美股", () => {
    expect(fromEastmoney("00700", 116)).toBe("00700.HK");
    expect(fromEastmoney("AAPL", 105)).toBe("AAPL.US");
    expect(fromEastmoney("BABA", 106)).toBe("BABA.US");
  });

  it("规则分组：沪深北共用 A 股那一套", () => {
    expect(marketGroupOf("SH")).toBe("CN");
    expect(marketGroupOf("SZ")).toBe("CN");
    expect(marketGroupOf("BJ")).toBe("CN");
    expect(marketGroupOf("HK")).toBe("HK");
    expect(marketGroupOf("US")).toBe("US");
    expect(groupOfCode("600519.SH")).toBe("CN");
    expect(groupOfCode("00700.HK")).toBe("HK");
    expect(groupOfCode("AAPL.US")).toBe("US");
    // 认不出的按 A 股算：池子里绝大多数是 A 股，猜错代价最小
    expect(groupOfCode("乱码")).toBe("CN");
  });

  it("计价货币跟着市场走", () => {
    expect(currencyOf("600519.SH")).toBe("CNY");
    expect(currencyOf("00700.HK")).toBe("HKD");
    expect(currencyOf("AAPL.US")).toBe("USD");
    expect(currencyOf("乱码")).toBe("CNY");
  });
});

describe("日韩代码（东京 / 首尔）", () => {
  it("日股 4 位、韩股 6 位，都不带交易所后缀", () => {
    expect(parseCode("7203.JP")).toEqual({ num: "7203", market: "JP" });
    expect(parseCode("6758.JP")).toEqual({ num: "6758", market: "JP" });
    expect(parseCode("005930.KR")).toEqual({ num: "005930", market: "KR" });
    // 腾讯给的是 005930.KS / 247540.KQ，**内部一律不带交易所后缀** ——
    // KOSPI 与 KOSDAQ 的证券交易税已经趋同，手数也一样是 1 股起
    expect(parseCode("005930.KS")).toBeNull();
    expect(parseCode("247540.KQ")).toBeNull();
    expect(parseCode("7203.T")).toBeNull();
    // 位数不能串：日股是 4 位、港股是 4–5 位，靠后缀区分
    expect(parseCode("7203.KR")).toBeNull();
    expect(parseCode("00593.KR")).toBeNull();
  });

  it("转腾讯 symbol 并往返一致（jp7203 / kr005930）", () => {
    expect(toTencentSymbol("7203.JP")).toBe("jp7203");
    expect(toTencentSymbol("005930.KR")).toBe("kr005930");
    for (const c of ["7203.JP", "6758.JP", "005930.KR", "000660.KR"]) {
      expect(fromTencentSymbol(toTencentSymbol(c)!)).toBe(c);
    }
  });

  it("转东方财富 secid：日股 176、韩股 177（MktNum 是搜索接口确认过的）", () => {
    expect(toEastmoneySecid("7203.JP")).toBe("176.7203");
    expect(toEastmoneySecid("005930.KR")).toBe("177.005930");
  });

  it("东财 f13 还原：176 是日股、177 是韩股", () => {
    expect(fromEastmoney("7203", 176)).toBe("7203.JP");
    expect(fromEastmoney("005930", 177)).toBe("005930.KR");
  });

  it("规则分组与币种", () => {
    expect(groupOfCode("7203.JP")).toBe("JP");
    expect(groupOfCode("005930.KR")).toBe("KR");
    expect(currencyOf("7203.JP")).toBe("JPY");
    expect(currencyOf("005930.KR")).toBe("KRW");
    expect(marketGroupOf("JP")).toBe("JP");
    expect(marketGroupOf("KR")).toBe("KR");
  });
});

describe("交易时段（北京时间，不受本机时区影响）", () => {
  it("换算北京时间", () => {
    const t = beijingTime(bj("2026-09-23", 10, 30));
    expect(t.iso).toBe("2026-09-23");
    expect(t.h).toBe(10);
    expect(t.mi).toBe(30);
  });

  it("识别各时段（2026-09-23 周三）", () => {
    expect(sessionState(bj("2026-09-23", 9, 0))).toBe("pre");
    expect(sessionState(bj("2026-09-23", 10, 0))).toBe("open");
    expect(sessionState(bj("2026-09-23", 11, 30))).toBe("open");
    expect(sessionState(bj("2026-09-23", 12, 0))).toBe("lunch");
    expect(sessionState(bj("2026-09-23", 14, 0))).toBe("open");
    expect(sessionState(bj("2026-09-23", 15, 1))).toBe("closed");
    expect(sessionState(bj("2026-09-23", 20, 0))).toBe("closed");
  });

  it("周末休市（2026-09-26 周六）", () => {
    expect(sessionState(bj("2026-09-26", 10, 0))).toBe("weekend");
    expect(isTradingNow(bj("2026-09-26", 10, 0))).toBe(false);
  });

  it("有交易日历时可识别节假日（2026-10-01 周四，不在日历内）", () => {
    const cal = ["2026-09-30", "2026-10-09"];
    expect(sessionState(bj("2026-10-01", 10, 0), cal)).toBe("holiday");
    expect(sessionState(bj("2026-09-30", 10, 0), cal)).toBe("open");
  });

  it("距下次开盘：盘中为 0，收盘后为正", () => {
    expect(msUntilNextOpen(bj("2026-09-23", 10, 0))).toBe(0);
    expect(msUntilNextOpen(bj("2026-09-23", 20, 0))).toBeGreaterThan(0);
    // 周四晚 → 周五开盘
    const until = msUntilNextOpen(bj("2026-09-24", 20, 0));
    expect(until).toBeGreaterThan(0);
    expect(until).toBeLessThan(24 * 3600_000);
  });

  it("isCalendarFresh：看日历里最新的那一天，且不依赖数组顺序", () => {
    expect(isCalendarFresh(["2026-09-23", "2026-09-25"], "2026-09-24")).toBe(true);
    expect(isCalendarFresh(["2026-09-25", "2026-09-23"], "2026-09-24")).toBe(true);
    expect(isCalendarFresh(["2026-09-24"], "2026-09-24")).toBe(true);
    expect(isCalendarFresh(["2026-09-22", "2026-09-23"], "2026-09-24")).toBe(false);
    expect(isCalendarFresh([], "2026-09-24")).toBe(false);
    expect(isCalendarFresh(undefined, "2026-09-24")).toBe(false);
  });

  it("日历过期时，新交易日不再被误判成休市（这正是页面停在旧快照的根因）", () => {
    const stale = ["2026-09-22", "2026-09-23"]; // 快照没跟上，日历停在 23 号
    // 2026-09-24 周四不在过期日历里：修复前返回 holiday / 不拉行情，现在必须按交易日走
    expect(sessionState(bj("2026-09-24", 10, 0), stale)).toBe("open");
    expect(isTradingNow(bj("2026-09-24", 10, 0), stale)).toBe(true);
    // 收盘后仍是 closed，不该被当成 holiday
    expect(sessionState(bj("2026-09-24", 20, 0), stale)).toBe("closed");
    // 周末判断不受影响
    expect(sessionState(bj("2026-09-26", 10, 0), stale)).toBe("weekend");
  });

  it("日历仍然新鲜时，节假日照旧能识别", () => {
    const fresh = ["2026-09-24", "2026-10-09"];
    expect(sessionState(bj("2026-10-01", 10, 0), fresh)).toBe("holiday");
    expect(sessionState(bj("2026-09-24", 10, 0), fresh)).toBe("open");
  });

  it("日历过期时 msUntilNextOpen 仍能找到下一个工作日", () => {
    const stale = ["2026-09-22", "2026-09-23"];
    const until = msUntilNextOpen(bj("2026-09-24", 20, 0), stale);
    expect(until).toBeGreaterThan(0);
    expect(until).toBeLessThan(24 * 3600_000);
  });
});

describe("日韩交易时段（东京/首尔 UTC+9，北京 UTC+8）", () => {
  it("marketTime 按市场自己的时区换算，别混用北京口径", () => {
    // 北京 2026-10-06 08:00 = 东京/首尔 09:00
    const t = marketTime(bj("2026-10-06", 8, 0), 9 * 60);
    expect(t.iso).toBe("2026-10-06");
    expect(t.h).toBe(9);
    expect(t.mi).toBe(0);
    // 同一个瞬间，北京口径是 08:00 —— 差一小时，用错就会把时段判错一整格
    expect(beijingTime(bj("2026-10-06", 8, 0)).h).toBe(8);
  });

  it("日股 09:00–11:30 / 12:30–15:30 JST（北京 08:00–10:30 / 11:30–14:30）", () => {
    expect(sessionState(bj("2026-10-06", 7, 59), undefined, "JP")).toBe("pre");
    expect(sessionState(bj("2026-10-06", 8, 0), undefined, "JP")).toBe("open");
    expect(sessionState(bj("2026-10-06", 10, 30), undefined, "JP")).toBe("open");
    expect(sessionState(bj("2026-10-06", 10, 31), undefined, "JP")).toBe("lunch");
    expect(sessionState(bj("2026-10-06", 11, 29), undefined, "JP")).toBe("lunch");
    expect(sessionState(bj("2026-10-06", 11, 30), undefined, "JP")).toBe("open");
    expect(sessionState(bj("2026-10-06", 14, 30), undefined, "JP")).toBe("open");
    expect(sessionState(bj("2026-10-06", 14, 31), undefined, "JP")).toBe("closed");
  });

  it("韩股 09:00–15:30 KST 中间**不休息**（北京 08:00–14:30）", () => {
    expect(sessionState(bj("2026-10-06", 7, 59), undefined, "KR")).toBe("pre");
    expect(sessionState(bj("2026-10-06", 8, 0), undefined, "KR")).toBe("open");
    // 北京 10:30 之后 A 股要午休、日股正是午休，韩股一路开着 —— 这一段最容易被漏判
    expect(sessionState(bj("2026-10-06", 11, 30), undefined, "KR")).toBe("open");
    expect(sessionState(bj("2026-10-06", 12, 0), undefined, "KR")).toBe("open");
    expect(sessionState(bj("2026-10-06", 14, 30), undefined, "KR")).toBe("open");
    expect(sessionState(bj("2026-10-06", 14, 31), undefined, "KR")).toBe("closed");
  });

  it("北京 15:30：A 股与日韩都收了，只剩港股还在连续竞价", () => {
    const at = bj("2026-10-06", 15, 30);
    expect(sessionState(at, undefined, "CN")).toBe("closed");
    expect(sessionState(at, undefined, "JP")).toBe("closed");
    expect(sessionState(at, undefined, "KR")).toBe("closed");
    expect(sessionState(at, undefined, "HK")).toBe("open");
  });

  it("北京 08:30：日韩开着、A 股还没开盘（只看 A 股会整天不发请求）", () => {
    const at = bj("2026-10-06", 8, 30);
    expect(sessionState(at, undefined, "CN")).toBe("pre");
    expect(isTradingNow(at, undefined, "JP")).toBe(true);
    expect(isTradingNow(at, undefined, "KR")).toBe(true);
  });

  it("日韩各查各的日历（韩国休市那天日本照常开）", () => {
    const krCal = ["2026-09-30", "2026-10-07"];
    const jpCal = ["2026-09-30", "2026-10-06", "2026-10-07"];
    const at = bj("2026-10-06", 9, 0);
    expect(sessionState(at, krCal, "KR")).toBe("holiday");
    expect(sessionState(at, jpCal, "JP")).toBe("open");
  });

  it("msUntilNextOpen 用市场自己的开盘时间（韩股 09:00 KST = 北京 08:00）", () => {
    // 北京 07:00 距韩股开盘 1 小时，距 A 股开盘（北京 09:30）2.5 小时
    expect(msUntilNextOpen(bj("2026-10-06", 7, 0), undefined, "KR")).toBe(3600_000);
    expect(msUntilNextOpen(bj("2026-10-06", 7, 0), undefined, "CN")).toBe(2.5 * 3600_000);
  });
});

describe("实时行情获取链", () => {
  const quote = (code: string, source: Quote["source"]): Quote => ({
    code,
    name: code,
    price: 10,
    changePct: 1,
    change: 0.1,
    amount: 100,
    asOf: Date.now(),
    source,
  });

  const fake = (
    name: Quote["source"],
    impl: (codes: string[]) => Promise<Quote[]>,
    supported = true,
  ): QuoteProvider => ({ name, isSupported: () => supported, fetchQuotes: impl });

  it("首个来源成功即返回", async () => {
    const res = await fetchQuotes(["A.SH", "B.SZ"], {
      chain: [fake("eastmoney", async (c) => c.map((x) => quote(x, "eastmoney")))],
    });
    expect(res.quotes).toHaveLength(2);
    expect(res.source).toBe("eastmoney");
    expect(res.missing).toEqual([]);
    expect(res.degradedReason).toBeNull();
  });

  it("首个来源抛错 → 降级到下一个，并记录原因", async () => {
    const res = await fetchQuotes(["A.SH"], {
      chain: [
        fake("eastmoney", async () => {
          throw new Error("模拟限频");
        }),
        fake("tencent", async (c) => c.map((x) => quote(x, "tencent"))),
      ],
    });
    expect(res.quotes[0].source).toBe("tencent");
    expect(res.degradedReason).toContain("模拟限频");
  });

  it("部分缺失由下一个来源补齐", async () => {
    const res = await fetchQuotes(["A.SH", "B.SZ", "C.SZ"], {
      chain: [
        fake("eastmoney", async () => [quote("A.SH", "eastmoney")]),
        fake("tencent", async (pending) => pending.map((x) => quote(x, "tencent"))),
        fake("snapshot", async () => [quote("C.SZ", "snapshot")]),
      ],
    });
    expect(res.quotes.map((q) => q.code).sort()).toEqual(["A.SH", "B.SZ", "C.SZ"]);
    expect(res.quotes.find((q) => q.code === "A.SH")!.source).toBe("eastmoney");
    expect(res.quotes.find((q) => q.code === "B.SZ")!.source).toBe("tencent");
    expect(res.missing).toEqual([]);
  });

  it("不支持的环境被跳过", async () => {
    const unsupported = vi.fn(async () => []);
    const res = await fetchQuotes(["A.SH"], {
      chain: [fake("tencent", unsupported, false), fake("eastmoney", async (c) => c.map((x) => quote(x, "eastmoney")))],
    });
    expect(unsupported).not.toHaveBeenCalled();
    expect(res.source).toBe("eastmoney");
  });

  it("全部失败 → 抛错而不是返回空壳", async () => {
    await expect(
      fetchQuotes(["A.SH"], {
        chain: [
          fake("eastmoney", async () => {
            throw new Error("挂了");
          }),
        ],
      }),
    ).rejects.toThrow(/实时行情获取失败/);
  });

  it("取不到的代码进入 missing，不编造", async () => {
    const res = await fetchQuotes(["A.SH", "NOPE.SH"], {
      chain: [fake("eastmoney", async () => [quote("A.SH", "eastmoney")])],
    });
    expect(res.missing).toEqual(["NOPE.SH"]);
    expect(res.quotes).toHaveLength(1);
  });
});

describe("实时价叠加到快照", () => {
  const bundle = (lastDate: string): SnapshotBundle => ({
    name: "snapshot_test",
    calendar: ["2026-09-22", lastDate],
    meta: {},
    snapshot: {
      indices: [{ code: "000300.SH", name: "沪深300", close: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], volume: [1, 2, 3] }],
      sectors: [],
      stocks: [{ code: "600519.SH", name: "贵州茅台", industry: "食品饮料", industryCode: "X", weight: 1, isST: false, close: [10, 20, 30], high: [10, 20, 30], low: [10, 20, 30], volume: [1, 2, 3] }],
      etfs: [],
    },
  });
  const q: Quote = {
    code: "600519.SH", name: "贵州茅台", price: 99,
    changePct: 1, change: 1, amount: 1, asOf: Date.now(), source: "eastmoney",
  };

  it("末根就是今天 → 覆盖收盘价，不新增 bar", () => {
    const out = applyLivePrices(bundle("2026-09-23"), [q], { today: "2026-09-23" });
    const s = out.stocks[0];
    expect(s.close).toEqual([10, 20, 99]);
    expect(out.calendar).toHaveLength(2);
  });

  it("末根不是今天 → 追加 bar，且 volume 为 null（不编造成交量）", () => {
    const out = applyLivePrices(bundle("2026-09-22"), [q], { today: "2026-09-23" });
    const s = out.stocks[0];
    expect(s.close).toEqual([10, 20, 30, 99]);
    expect(s.volume.at(-1)).toBeNull();
    expect(out.calendar).toHaveLength(3);
  });

  it("不修改入参", () => {
    const b = bundle("2026-09-22");
    applyLivePrices(b, [q], { today: "2026-09-23" });
    expect(b.snapshot.stocks[0].close).toEqual([10, 20, 30]);
  });

  it("无报价时原样返回", () => {
    const b = bundle("2026-09-22");
    expect(applyLivePrices(b, [], { today: "2026-09-23" })).toBe(b.snapshot);
  });
});

describe("港股进快照（日历 / 汇率）", () => {
  /** 一只 A 股 + 一只港股。港股那支带 market/currency，与 fetch_snapshot.py 写出来的一致 */
  const bundle = (opts: { lastDate: string; hkClose?: number }): SnapshotBundle => ({
    name: "snapshot_test",
    calendar: ["2026-09-30", opts.lastDate],
    meta: { hk: { calendar: ["2026-09-30", "2026-10-02"], fx: { pair: "HKDCNY", date: "2026-09-30", rate: 0.9 } } },
    snapshot: {
      indices: [],
      sectors: [],
      stocks: [
        { code: "600519.SH", name: "贵州茅台", industry: "食品饮料", industryCode: "X", weight: 1, isST: false, close: [10, 20, 30], high: [10, 20, 30], low: [10, 20, 30], volume: [1, 2, 3] },
        { code: "00700.HK", name: "腾讯控股", industry: "港股", industryCode: "HK", weight: 0, isST: false, market: "HK", currency: "HKD", close: [100, 200, opts.hkClose ?? 428.2], high: [100, 200, 428.2], low: [100, 200, 428.2], volume: [1, 2, 3] },
      ],
      etfs: [],
    },
  });
  const hkQuote: Quote = {
    code: "00700.HK", name: "腾讯控股", price: 431,
    changePct: 1, change: 1, amount: 1, asOf: Date.now(), source: "tencent",
  };
  const cnQuote: Quote = {
    code: "600519.SH", name: "贵州茅台", price: 99,
    changePct: 1, change: 1, amount: 1, asOf: Date.now(), source: "eastmoney",
  };

  it("fxRatesOfMeta 从 meta.hk.fx 读汇率；没有就返回空表（不兜底成 1:1）", () => {
    expect(fxRatesOfMeta({ hk: { fx: { rate: 0.8584 } } })).toEqual({ HKD: 0.8584 });
    expect(fxRatesOfMeta({})).toEqual({});
    expect(fxRatesOfMeta({ hk: { fx: { rate: 0 } } })).toEqual({});
    expect(fxRatesOfMeta({ hk: { fx: { rate: "0.85" } } })).toEqual({});
  });

  it("fxRatesOfMeta 同时读 jp / kr 两块，缺哪块就少哪个币种", () => {
    expect(
      fxRatesOfMeta({
        hk: { fx: { rate: 0.8584 } },
        jp: { fx: { rate: 0.042727 } },
        kr: { fx: { rate: 0.004958 } },
      }),
    ).toEqual({ HKD: 0.8584, JPY: 0.042727, KRW: 0.004958 });
    // 只有日股那块时，不能凭空给韩元安一个汇率
    expect(fxRatesOfMeta({ jp: { fx: { rate: 0.042727 } } })).toEqual({ JPY: 0.042727 });
  });

  it("convertSnapshotToCny 只折境外标的，A 股一位不动", () => {
    const out = convertSnapshotToCny(bundle({ lastDate: "2026-09-30" }).snapshot, { HKD: 0.9 });
    expect(out.stocks[0].close).toEqual([10, 20, 30]);
    expect(out.stocks[1].close).toEqual([90, 180, 385.38]);
    expect(out.stocks[1].high).toEqual([90, 180, 385.38]);
    // currency 保持原样：界面要标「原以港币计价」
    expect(out.stocks[1].currency).toBe("HKD");
  });

  it("convertSnapshotToCny 空汇率表时原样返回（不折、也不报错）", () => {
    const snap = bundle({ lastDate: "2026-09-30" }).snapshot;
    expect(convertSnapshotToCny(snap, {})).toBe(snap);
  });

  it("折不了的币种留着不动，不按 1:1 顶", () => {
    const snap = bundle({ lastDate: "2026-09-30" }).snapshot;
    const out = convertSnapshotToCny(snap, { USD: 7.1 });
    expect(out.stocks[1].close).toEqual([100, 200, 428.2]);
  });

  it("给了逐日汇率就按天折，不再拿一个价乘到底", () => {
    // 这一条是「历史推演里的境外标的」的地基：实时盘只看最后一天，
    // 看不出标量与逐日的差别；推演要从几个月前走到今天，差别就是每格的汇率。
    const snap = bundle({ lastDate: "2026-09-30" }).snapshot;
    const out = convertSnapshotToCny(snap, { HKD: 0.9 }, { HKD: [0.5, 0.8, 0.9] });
    expect(out.stocks[1].close).toEqual([50, 160, 385.38]);
    expect(out.stocks[0].close).toEqual([10, 20, 30]);
  });

  it("序列里没有报价的那天沿用上一个已知汇率（不是插值、也不是补 1）", () => {
    const snap = bundle({ lastDate: "2026-09-30" }).snapshot;
    const out = convertSnapshotToCny(snap, { HKD: 0.9 }, { HKD: [0.5, null, 0.9] });
    expect(out.stocks[1].close).toEqual([50, 100, 385.38]);
  });

  it("序列长度与价格列对不上就退回标量（错位的汇率比没有更糟）", () => {
    const snap = bundle({ lastDate: "2026-09-30" }).snapshot;
    const out = convertSnapshotToCny(snap, { HKD: 0.9 }, { HKD: [0.5] });
    expect(out.stocks[1].close).toEqual([90, 180, 385.38]);
  });

  it("fxSeriesOfMeta 读 meta.<市场>.fxSeries.rate，长度对不上整条丢掉", () => {
    const meta = { hk: { fxSeries: { rate: [0.5, 0.8, 0.9] } } };
    expect(fxSeriesOfMeta(meta, 3)).toEqual({ HKD: [0.5, 0.8, 0.9] });
    // 长度不符 → 丢掉。错位的序列不会报错，只会把 4 月的汇率安到 9 月的价格上
    expect(fxSeriesOfMeta(meta, 4)).toEqual({});
    // 不传 days 表示不检查长度（调用方拿不到日历时的退路）
    expect(fxSeriesOfMeta({ hk: { fxSeries: { rate: [0.5] } } })).toEqual({ HKD: [0.5] });
    // 坏值变 null（折算时沿用上一个已知汇率），整条全坏才算没有
    expect(fxSeriesOfMeta({ hk: { fxSeries: { rate: [0.5, "x", 0] } } }, 3)).toEqual({ HKD: [0.5, null, null] });
    expect(fxSeriesOfMeta({ hk: { fxSeries: { rate: [null, 0] } } }, 2)).toEqual({});
    expect(fxSeriesOfMeta({ hk: { fxSeries: { rate: [] } } })).toEqual({});
    expect(fxSeriesOfMeta({})).toEqual({});
  });

  it("实时价按汇率折过再覆盖（431 港币 → 387.9 人民币，不是 ¥431）", () => {
    const out = applyLivePrices(bundle({ lastDate: "2026-09-30" }), [hkQuote], {
      today: "2026-09-30",
      fx: { HKD: 0.9 },
    });
    expect(out.stocks[1].close).toEqual([100, 200, 387.9]);
  });

  it("没传 fx 时港股的实时价整支跳过（宁可显示旧价，也不把港币当人民币）", () => {
    const out = applyLivePrices(bundle({ lastDate: "2026-09-30" }), [hkQuote], { today: "2026-09-30" });
    expect(out.stocks[1].close).toEqual([100, 200, 428.2]);
  });

  it("港股今天休市 → 补 null 占位，不写价（A 股照常开盘）", () => {
    /*
     * 2026-10-02 是 A 股的交易日（日历里有），但那天港股休市（国庆）。
     * 港股日历必须**新鲜**才会真的去查它 —— 过期日历退回按周末粗判，
     * 那样周五一律算开市（见 session.ts 的 isCalendarFresh）。
     */
    const b = bundle({ lastDate: "2026-09-30" });
    const out = applyLivePrices(b, [cnQuote, hkQuote], {
      today: "2026-10-02",
      calendars: { HK: ["2026-09-30", "2026-10-05", "2026-10-06"] },
      fx: { HKD: 0.9 },
    });
    const hk = out.stocks[1];
    expect(hk.close).toHaveLength(4);
    expect(hk.close.at(-1)).toBeNull();
    expect(hk.volume.at(-1)).toBeNull();
    // A 股那边照常追加，价格是实时价
    expect(out.stocks[0].close).toEqual([10, 20, 30, 99]);
  });
});

describe("日韩进快照（日历 / 汇率）", () => {
  /** 一只 A 股 + 一只日股 + 一只韩股，与 fetch_snapshot.py 写出来的形状一致 */
  const bundle = (lastDate: string): SnapshotBundle => ({
    name: "snapshot_test",
    calendar: ["2026-09-30", lastDate],
    meta: {
      jp: { calendar: ["2026-09-30", "2026-10-05"], fx: { pair: "JPYCNY", date: "2026-09-30", rate: 0.04 } },
      kr: { calendar: ["2026-09-30", "2026-10-05"], fx: { pair: "KRWCNY", date: "2026-09-30", rate: 0.005 } },
    },
    snapshot: {
      indices: [],
      sectors: [],
      etfs: [],
      stocks: [
        { code: "600519.SH", name: "贵州茅台", industry: "食品饮料", industryCode: "X", weight: 1, isST: false, close: [10, 20, 30], high: [10, 20, 30], low: [10, 20, 30], volume: [1, 2, 3] },
        { code: "7203.JP", name: "丰田汽车", industry: "日股", industryCode: "JP", weight: 0, isST: false, market: "JP", currency: "JPY", close: [2800, 2900, 2930.5], high: [2800, 2900, 2937.5], low: [2800, 2900, 2904], volume: [1, 2, 3] },
        { code: "005930.KR", name: "三星电子", industry: "韩股", industryCode: "KR", weight: 0, isST: false, market: "KR", currency: "KRW", close: [260000, 270000, 272000], high: [260000, 270000, 279000], low: [260000, 270000, 270000], volume: [1, 2, 3] },
      ],
    },
  });
  const cnQuote: Quote = {
    code: "600519.SH", name: "贵州茅台", price: 99,
    changePct: 1, change: 1, amount: 1, asOf: Date.now(), source: "eastmoney",
  };
  const jpQuote: Quote = {
    code: "7203.JP", name: "丰田汽车", price: 3000.5,
    changePct: 1, change: 1, amount: 1, asOf: Date.now(), source: "tencent",
  };
  const krQuote: Quote = {
    code: "005930.KR", name: "三星电子", price: 272000,
    changePct: 1, change: 1, amount: 1, asOf: Date.now(), source: "tencent",
  };

  it("convertSnapshotToCny 折日元与韩元，A 股一位不动", () => {
    const out = convertSnapshotToCny(bundle("2026-09-30").snapshot, { JPY: 0.04, KRW: 0.005 });
    expect(out.stocks[0].close).toEqual([10, 20, 30]);
    // 2930.5 JPY × 0.04 = 117.22
    expect(out.stocks[1].close).toEqual([112, 116, 117.22]);
    // 272000 KRW × 0.005 = 1360
    expect(out.stocks[2].close).toEqual([1300, 1350, 1360]);
    // currency 保持原样：界面要标「原以日元/韩元计价」
    expect(out.stocks[1].currency).toBe("JPY");
    expect(out.stocks[2].currency).toBe("KRW");
  });

  it("折不了韩元时，韩股整支留着不动（只有日股被折）", () => {
    const out = convertSnapshotToCny(bundle("2026-09-30").snapshot, { JPY: 0.04 });
    expect(out.stocks[1].close).toEqual([112, 116, 117.22]);
    expect(out.stocks[2].close).toEqual([260000, 270000, 272000]);
  });

  it("日股的实时价按 JPY 折过再覆盖（3000.5 日元 → 120.02 人民币）", () => {
    const out = applyLivePrices(bundle("2026-09-30"), [jpQuote], {
      today: "2026-09-30",
      fx: { JPY: 0.04 },
    });
    expect(out.stocks[1].close).toEqual([2800, 2900, 120.02]);
  });

  it("没传 JPY 时日股的实时价整支跳过（宁可显示旧价，也不把日元当人民币）", () => {
    const out = applyLivePrices(bundle("2026-09-30"), [jpQuote], { today: "2026-09-30" });
    expect(out.stocks[1].close).toEqual([2800, 2900, 2930.5]);
  });

  it("日历按市场各查各的：日股休市补 null，韩股照常写价", () => {
    /*
     * 2026-10-06 是 A 股与韩股的交易日，但日股休市。
     * 两份日历都必须**新鲜**才会真的被查（过期日历退回按周末粗判，
     * 周二一律算开市，测不出差别）——所以日股那份要给到 ≥ today 的日期。
     */
    const out = applyLivePrices(bundle("2026-09-30"), [cnQuote, jpQuote, krQuote], {
      today: "2026-10-06",
      calendars: {
        JP: ["2026-09-30", "2026-10-05", "2026-10-07"],
        KR: ["2026-09-30", "2026-10-05", "2026-10-06", "2026-10-07"],
      },
      fx: { JPY: 0.04, KRW: 0.005 },
    });
    // A 股：日历过期 → 退回按周末粗判（周二算开市），写实时价
    expect(out.stocks[0].close).toEqual([10, 20, 30, 99]);
    // 日股：日历新鲜且不含今天 → 占位 null，不写价
    expect(out.stocks[1].close).toHaveLength(4);
    expect(out.stocks[1].close.at(-1)).toBeNull();
    expect(out.stocks[1].volume.at(-1)).toBeNull();
    // 韩股：日历新鲜且含今天 → 照常写实时价（272000 × 0.005 = 1360）
    expect(out.stocks[2].close).toEqual([260000, 270000, 272000, 1360]);
  });
});
