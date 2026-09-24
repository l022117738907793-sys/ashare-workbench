import { describe, expect, it, vi } from "vitest";
import {
  chunk,
  fromEastmoney,
  fromTencentSymbol,
  parseCode,
  toEastmoneySecid,
  toTencentSymbol,
} from "./codes";
import { fetchQuotes } from "./quotes";
import { beijingTime, isCalendarFresh, isTradingNow, msUntilNextOpen, sessionState } from "./session";
import { applyLivePrices, type SnapshotBundle } from "./snapshot";
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
