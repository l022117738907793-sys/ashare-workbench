import { describe, expect, it } from "vitest";
import {
  benchmarkCurve,
  CASH_OPTIONS,
  defaultGameState,
  isValidInitialCash,
  startGame,
  DEFAULT_INITIAL_CASH,
  lastBuyDates,
  parseGameState,
  positionPnl,
  pushEquity,
  serializeGameState,
  suggestedMaxShares,
  type GameState,
} from "./game";
import type { Trade } from "@aw/game";

const trade = (over: Partial<Trade>): Trade => ({
  id: "t",
  at: 0,
  date: "2026-09-23",
  code: "600519.SH",
  name: "贵州茅台",
  side: "buy",
  price: 10,
  shares: 100,
  amount: 1000,
  fee: 5,
  ...over,
});

describe("默认状态与开局", () => {
  it("默认是「未开局」，账户为空", () => {
    const s = defaultGameState();
    expect(s.status).toBe("idle");
    expect(s.startedAt).toBeNull();
    expect(s.account.cash).toBe(0);
    expect(s.account.holdings).toEqual([]);
    expect(s.account.trades).toEqual([]);
    expect(s.equity).toEqual([]);
  });

  it("开局后按选定资金建账", () => {
    const s = startGame(200_000, 1_700_000_000_000);
    expect(s.status).toBe("playing");
    expect(s.startedAt).toBe(1_700_000_000_000);
    expect(s.account.cash).toBe(200_000);
    expect(s.account.initialCash).toBe(200_000);
  });

  it("可选资金档位都在合法区间内", () => {
    for (const c of CASH_OPTIONS) {
      expect(isValidInitialCash(c), `${c} 应合法`).toBe(true);
      expect(startGame(c, 0).account.cash).toBe(c);
    }
  });

  it("非法资金回落默认值，不产生离谱账户", () => {
    for (const bad of [0, -1, Number.NaN, 1e12, 999]) {
      expect(isValidInitialCash(bad)).toBe(false);
      expect(startGame(bad, 0).account.cash).toBe(DEFAULT_INITIAL_CASH);
    }
  });

  it("开局会清空上一局的持仓与成交", () => {
    let s = startGame(100_000, 0);
    s = {
      ...s,
      account: { ...s.account, cash: 50_000 },
      equity: [{ date: "2026-09-23", total: 100_000 }],
    };
    const fresh = startGame(300_000, 1);
    expect(fresh.account.cash).toBe(300_000);
    expect(fresh.account.holdings).toEqual([]);
    expect(fresh.equity).toEqual([]);
  });
});

describe("持久化（本地存储可被篡改，坏数据必须退化为默认值）", () => {
  it("往返一致", () => {
    const s = defaultGameState();
    s.account.cash = 123456;
    const back = parseGameState(serializeGameState(s));
    expect(back.account.cash).toBe(123456);
  });

  it("null / 空串 / 坏 JSON → 默认状态，不抛错", () => {
    for (const raw of [null, undefined, "", "{", "null", "[]", '"x"']) {
      const s = parseGameState(raw as string | null);
      // 坏数据退化为「未开局」而不是一个有钱的账户 —— 宁可让用户重新设置
      expect(s.status).toBe("idle");
      expect(s.account.cash).toBe(0);
      expect(s.account.holdings).toEqual([]);
    }
  });

  it("丢弃非法持仓（股数为 0 / 负数 / 非数字）", () => {
    const raw = JSON.stringify({
      account: {
        initialCash: 100,
        cash: 100,
        holdings: [
          { code: "A.SH", name: "A", shares: 0, sellable: 0, avgCost: 1 },
          { code: "B.SH", name: "B", shares: -5, sellable: 0, avgCost: 1 },
          { code: "C.SH", name: "C", shares: "x", sellable: 0, avgCost: 1 },
          { code: "D.SH", name: "D", shares: 10, sellable: 999, avgCost: 1 },
        ],
      },
    });
    const s = parseGameState(raw);
    expect(s.account.holdings.map((h) => h.code)).toEqual(["D.SH"]);
    // sellable 被夹到不超过 shares
    expect(s.account.holdings[0].sellable).toBe(10);
  });

  it("丢弃非法成交记录", () => {
    const raw = JSON.stringify({
      account: {
        initialCash: 100,
        cash: 100,
        holdings: [],
        trades: [
          { code: "A.SH", side: "buy", shares: 1, price: 1 },
          { code: "B.SH", side: "hold", shares: 1, price: 1 }, // 方向非法
          { code: "C.SH", side: "sell", shares: "x", price: 1 }, // 股数非法
        ],
      },
    });
    const s = parseGameState(raw);
    expect(s.account.trades).toHaveLength(1);
    expect(s.account.trades[0].code).toBe("A.SH");
  });

  it("非法 initialCash 回落默认值，cash 缺失时用 initialCash", () => {
    const s = parseGameState(JSON.stringify({ account: { initialCash: -1, holdings: [], trades: [] } }));
    expect(s.account.initialCash).toBe(DEFAULT_INITIAL_CASH);
    expect(s.account.cash).toBe(DEFAULT_INITIAL_CASH);
  });

  it("旧存档（无 status 字段）视为进行中，不能把已有账户清掉", () => {
    const legacy = JSON.stringify({
      version: 1,
      account: { initialCash: 1_000_000, cash: 900_000, holdings: [], trades: [] },
      equity: [{ date: "2026-09-22", total: 1_000_000 }],
    });
    const s = parseGameState(legacy);
    expect(s.status).toBe("playing");
    expect(s.account.cash).toBe(900_000);
    expect(s.equity).toHaveLength(1);
  });

  it("净值点只接受合法项", () => {
    const raw = JSON.stringify({
      account: { initialCash: 100, cash: 100, holdings: [], trades: [] },
      equity: [
        { date: "2026-09-01", total: 100 },
        { date: "2026-09-02", total: "x" },
        { total: 5 },
        null,
      ],
    });
    expect(parseGameState(raw).equity).toEqual([{ date: "2026-09-01", total: 100 }]);
  });
});

describe("最近建仓日（T+1 解锁依据）", () => {
  it("取每只股票最晚的一次建仓日", () => {
    const dates = lastBuyDates([
      trade({ code: "A.SH", date: "2026-09-20" }),
      trade({ code: "A.SH", date: "2026-09-23" }),
      trade({ code: "A.SH", date: "2026-09-21" }),
      trade({ code: "B.SH", date: "2026-09-19" }),
    ]);
    expect(dates["A.SH"]).toBe("2026-09-23");
    expect(dates["B.SH"]).toBe("2026-09-19");
  });

  it("卖出记录不影响解锁日", () => {
    const dates = lastBuyDates([
      trade({ code: "A.SH", date: "2026-09-20" }),
      trade({ code: "A.SH", date: "2026-09-25", side: "sell" }),
    ]);
    expect(dates["A.SH"]).toBe("2026-09-20");
  });

  it("空成交返回空表", () => {
    expect(lastBuyDates([])).toEqual({});
  });
});

describe("净值曲线", () => {
  it("同一天重复记录只更新，不新增点", () => {
    let e = pushEquity([], "2026-09-23", 100);
    e = pushEquity(e, "2026-09-23", 120);
    expect(e).toEqual([{ date: "2026-09-23", total: 120 }]);
  });

  it("按日期追加", () => {
    let e = pushEquity([], "2026-09-22", 100);
    e = pushEquity(e, "2026-09-23", 110);
    expect(e.map((p) => p.date)).toEqual(["2026-09-22", "2026-09-23"]);
  });

  it("乱序日期被丢弃，避免结算区间取错", () => {
    const e = pushEquity([{ date: "2026-09-23", total: 100 }], "2026-09-01", 50);
    expect(e).toEqual([{ date: "2026-09-23", total: 100 }]);
  });

  it("超过上限时裁掉最旧的", () => {
    let e = pushEquity([], "2026-01-01", 1, 3);
    for (const d of ["2026-01-02", "2026-01-03", "2026-01-04"]) e = pushEquity(e, d, 2, 3);
    expect(e).toHaveLength(3);
    expect(e[0].date).toBe("2026-01-02");
  });
});

describe("基准曲线对齐", () => {
  const calendar = ["2026-09-18", "2026-09-19", "2026-09-22", "2026-09-23"];
  const close = [100, 105, null, 110]; // 09-22 缺失（停牌/接口缺）

  it("按日期取指数收盘价", () => {
    const c = benchmarkCurve(["2026-09-18", "2026-09-23"], calendar, close);
    expect(c).toEqual([
      { date: "2026-09-18", total: 100 },
      { date: "2026-09-23", total: 110 },
    ]);
  });

  it("缺失交易日向前回退到最近可用值", () => {
    const c = benchmarkCurve(["2026-09-22"], calendar, close);
    expect(c).toEqual([{ date: "2026-09-22", total: 105 }]);
  });

  it("早于日历起点时跳过，不编造", () => {
    const c = benchmarkCurve(["2026-01-01"], calendar, close);
    expect(c).toEqual([]);
  });
});

describe("浮动盈亏", () => {
  it("盈利", () => {
    expect(positionPnl(200, 100, 110)).toEqual({ value: 22000, pnl: 2000, pnlPct: 10 });
  });

  it("亏损", () => {
    const r = positionPnl(100, 100, 90)!;
    expect(r.pnl).toBe(-1000);
    expect(r.pnlPct).toBe(-10);
  });

  it("取不到价格返回 null —— 不假设涨跌", () => {
    expect(positionPnl(100, 100, null)).toBeNull();
    expect(positionPnl(100, 100, undefined)).toBeNull();
    expect(positionPnl(100, 100, Number.NaN)).toBeNull();
  });

  it("成本为 0 时返回 null，不做除零", () => {
    expect(positionPnl(100, 0, 10)).toBeNull();
  });
});

describe("委托股数上限提示", () => {
  it("卖出上限就是可卖数量", () => {
    expect(suggestedMaxShares("sell", 10, 100000, 300)).toBe(300);
  });

  it("买入上限按可用资金估算，并取整到一手", () => {
    // 100000 / (10 * 1.002) = 9980.04 → 9900
    expect(suggestedMaxShares("buy", 10, 100000, 0)).toBe(9900);
  });

  it("资金不足一手时返回 0", () => {
    expect(suggestedMaxShares("buy", 1000, 500, 0)).toBe(0);
  });

  it("无行情返回 0", () => {
    expect(suggestedMaxShares("buy", null, 100000, 0)).toBe(0);
    expect(suggestedMaxShares("buy", 0, 100000, 0)).toBe(0);
  });
});

describe("新闻轮的节奏常量（放在这里是因为跨模块引用方便）", () => {
  it("自动刷新间隔是 10 分钟，不是更短", async () => {
    const { DEFAULT_NEWS_INTERVAL_MS } = await import("./useLiveNews");
    // 界面有手动刷新按钮，自动刷新只需保持大致最新。
    // 若有人想改短，请先想清楚"用户被新闻刷屏"的代价。
    expect(DEFAULT_NEWS_INTERVAL_MS).toBe(10 * 60 * 1000);
  });
});
