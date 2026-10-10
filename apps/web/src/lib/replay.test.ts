/**
 * 传奇模式（模式 2）的网页侧适配层。
 *
 * 这里的重点不是引擎算得对不对（那是 `packages/game/src/replay.test.ts` 的事），
 * 而是三件容易出事的事：
 * 1. **分片校验**：拿到半截数据就开局，比开不了局糟得多；
 * 2. **存档往返**：`levelId` 必须存下来，否则刷新页面以后这一局就找不回来了；
 * 3. **旧存档兼容**：`levelId` 是我后加的字段，老存档里没有，不能被当成坏数据丢掉。
 */
import { describe, expect, it } from "vitest";
import type { Snapshot, StockData } from "@aw/core";
import {
  BACKTRACK_DAYS,
  backtrackOptions,
  backtrackStocks,
  convertShardToCny,
  isLevelShard,
  loadLevelIndex,
  loadLevelShard,
  parseReplaySave,
  replayDate,
  restoreLevelReplay,
  startLevelReplay,
  startReplay,
  toSave,
  type LevelShard,
} from "./replay";

const DAYS = ["2020-01-14", "2020-01-15", "2020-01-16", "2020-01-17"];

function goodShard(): LevelShard {
  return {
    levelId: "2020-02-03",
    startDate: DAYS[0]!,
    days: DAYS.length,
    calendar: [...DAYS],
    benchmark: { code: "000300.SH", name: "沪深300", close: [4000, 4010, 3990, 3950] },
    instruments: [
      {
        code: "600519.SH",
        name: "贵州茅台",
        isST: false,
        open: [1000, 1010, 1005, 990],
        close: [1005, 1008, 995, 985],
        high: [1010, 1015, 1010, 995],
        low: [995, 1000, 990, 980],
        volume: [1000, 1200, 900, 1500],
      },
      {
        code: "000001.SZ",
        name: "平安银行",
        isST: false,
        open: [10, 10.1, 10, 9.9],
        close: [10.1, 10.2, 9.9, 9.8],
        high: [10.2, 10.3, 10.1, 10],
        low: [9.9, 10, 9.8, 9.7],
        volume: [5000, 5200, 4800, 6000],
      },
    ],
    note: "前复权",
  };
}

interface StubResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

const stubFetch = (res: StubResponse | (() => Promise<never>)): typeof fetch =>
  (typeof res === "function" ? res : () => Promise.resolve(res)) as unknown as typeof fetch;

describe("关卡分片校验", () => {
  it("一份正常的分片能通过", () => {
    expect(isLevelShard(goodShard())).toBe(true);
  });

  it("没有股票池的分片不算数", () => {
    expect(isLevelShard({ ...goodShard(), instruments: [] })).toBe(false);
  });

  it("没有日历的分片不算数", () => {
    expect(isLevelShard({ ...goodShard(), calendar: [] })).toBe(false);
  });

  it("某一列和日历长短对不上就不算数", () => {
    const shard = goodShard();
    // 引擎按长度对齐；短一截的 open 会被当成「最后一天没有开盘价」，
    // 这种错不会抛异常，只会让玩家在某一天莫名其妙成交不了
    const broken = structuredClone(shard);
    broken.instruments[0]!.open = [1, 2, 3];
    expect(isLevelShard(broken)).toBe(false);
  });

  it("不是对象的东西一律不算数", () => {
    for (const v of [null, undefined, 42, "x", []]) expect(isLevelShard(v)).toBe(false);
  });
});

describe("读关卡清单", () => {
  it("读到 id 列表", async () => {
    const ids = await loadLevelIndex({
      fetchImpl: stubFetch({ ok: true, status: 200, json: async () => ({ levels: ["a", "b"] }) }),
    });
    expect(ids).toEqual(["a", "b"]);
  });

  it("清单不存在时返回空数组，不抛（还没跑过构建脚本是正常状态）", async () => {
    const ids = await loadLevelIndex({
      fetchImpl: stubFetch({ ok: false, status: 404, json: async () => ({}) }),
    });
    expect(ids).toEqual([]);
  });

  it("网络断了也返回空数组，不能把整个页面拖崩", async () => {
    const ids = await loadLevelIndex({
      fetchImpl: stubFetch(() => Promise.reject(new Error("network"))),
    });
    expect(ids).toEqual([]);
  });

  it("清单里混了非字符串就丢掉那几条", async () => {
    const ids = await loadLevelIndex({
      fetchImpl: stubFetch({ ok: true, status: 200, json: async () => ({ levels: ["a", 7, null, "b"] }) }),
    });
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("读一份关卡分片", () => {
  it("读到合格分片就返回", async () => {
    const shard = goodShard();
    const got = await loadLevelShard("2020-02-03", {
      fetchImpl: stubFetch({ ok: true, status: 200, json: async () => shard }),
    });
    expect(got.levelId).toBe("2020-02-03");
    expect(got.instruments).toHaveLength(2);
  });

  it("HTTP 不是 2xx 时抛出，并且错误里带着 URL", async () => {
    await expect(
      loadLevelShard("2020-02-03", {
        fetchImpl: stubFetch({ ok: false, status: 503, json: async () => ({}) }),
      }),
    ).rejects.toThrow(/level-2020-02-03\.json/);
  });

  it("返回了残缺的 JSON 要拒绝，不能凑合着开局", async () => {
    await expect(
      loadLevelShard("2020-02-03", {
        fetchImpl: stubFetch({ ok: true, status: 200, json: async () => ({ levelId: "2020-02-03" }) }),
      }),
    ).rejects.toThrow(/不是一份完整的关卡数据/);
  });

  it("URL 用的是 history 目录", async () => {
    const seen: string[] = [];
    const f = (async (url: string) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => goodShard() };
    }) as unknown as typeof fetch;
    await loadLevelShard("2020-02-03", { fetchImpl: f });
    expect(seen[0]).toBe("./history/level-2020-02-03.json");
  });
});

describe("用分片开局", () => {
  it("从第 1 天进场，startIndex 恒为 0", () => {
    const state = startLevelReplay(goodShard(), 200_000, "4. 春节之后");
    expect(state.config.startIndex).toBe(0);
    expect(state.dayIndex).toBe(0);
    expect(state.config.calendar).toEqual(DAYS);
    expect(state.account.cash).toBe(200_000);
    expect(state.config.label).toBe("4. 春节之后");
  });

  it("基准接到分片的沪深300 上（传奇模式的基准不能拿当前快照的）", () => {
    const state = startLevelReplay(goodShard(), 200_000);
    expect(state.config.benchmarkClose).toEqual([4000, 4010, 3990, 3950]);
  });

  it("股票池就是分片里的那一批，不多不少", () => {
    const state = startLevelReplay(goodShard(), 200_000);
    expect(state.config.instruments.map((i) => i.code)).toEqual(["600519.SH", "000001.SZ"]);
  });
});

describe("存档往返", () => {
  it("传奇模式的 levelId 存得下、读得回", () => {
    const state = startLevelReplay(goodShard(), 200_000, "4. 春节之后");
    const save = toSave(state, { mode: "legend", hideDate: false, levelId: "2020-02-03" });
    expect(save.levelId).toBe("2020-02-03");

    const back = parseReplaySave(JSON.parse(JSON.stringify(save)));
    expect(back?.levelId).toBe("2020-02-03");
    expect(back?.mode).toBe("legend");
  });

  it("随机模式的 levelId 是 null", () => {
    const state = startLevelReplay(goodShard(), 200_000);
    const save = toSave(state, { mode: "random", hideDate: true });
    expect(save.levelId).toBeNull();
  });

  /**
   * 这条是给真实存在的旧存档用的：`levelId` 是后加的字段，
   * 老存档里根本没有。不能因为它缺失就判定存档损坏 —— 那会把玩家的持仓清掉。
   */
  it("老存档没有 levelId 也要能读进来，当成随机模式", () => {
    const state = startLevelReplay(goodShard(), 200_000);
    const save = toSave(state, { mode: "random", hideDate: true });
    const legacy: Record<string, unknown> = JSON.parse(JSON.stringify(save));
    delete legacy.levelId;

    const back = parseReplaySave(legacy);
    expect(back).not.toBeNull();
    expect(back?.levelId).toBeNull();
    expect(back?.account.initialCash).toBe(200_000);
  });

  it("levelId 不是字符串就当没有", () => {
    const state = startLevelReplay(goodShard(), 200_000);
    const save = toSave(state, { mode: "legend", hideDate: false, levelId: "x" }) as unknown as Record<string, unknown>;
    save.levelId = 123;
    expect(parseReplaySave(save)?.levelId).toBeNull();
  });
});

describe("用分片还原一局", () => {
  it("账户、委托、日志原样搬回来", () => {
    const state = startLevelReplay(goodShard(), 200_000, "4. 春节之后");
    const save = toSave(state, { mode: "legend", hideDate: false, levelId: "2020-02-03" });
    save.dayIndex = 2;
    save.account = { ...save.account, cash: 123_456 };

    const back = restoreLevelReplay(goodShard(), save);
    expect(back.dayIndex).toBe(2);
    expect(back.account.cash).toBe(123_456);
    expect(back.config.startIndex).toBe(0);
  });

  it("分片换了版本、存档的 dayIndex 越界时夹回来，而不是丢掉存档", () => {
    const state = startLevelReplay(goodShard(), 200_000);
    const save = toSave(state, { mode: "legend", hideDate: false, levelId: "2020-02-03" });
    save.dayIndex = 999;

    const back = restoreLevelReplay(goodShard(), save);
    expect(back.dayIndex).toBe(DAYS.length - 1);
    expect(back.finished).toBe(true);
  });
});

/** 一份带港股的关卡：腾讯按港币计价，汇率取 1 港币 = 0.9 人民币 */
function hkShard(): LevelShard {
  const shard = goodShard();
  shard.fx = [{ currency: "HKD", code: "HKDCNY", name: "港币兑人民币", rate: [0.9, 0.9, 0.91, 0.91] }];
  shard.instruments.push({
    code: "00700.HK",
    name: "腾讯控股",
    isST: false,
    market: "HK",
    currency: "HKD",
    prevClose: 300,
    open: [300, 310, 305, 300],
    close: [305, 308, 300, 295],
    high: [310, 315, 310, 300],
    low: [298, 305, 295, 290],
    volume: [1000, 1200, 900, 1500],
  });
  return shard;
}

describe("境外价格折成人民币", () => {
  it("汇率列和日历长短对不上就不算合格分片", () => {
    const s = hkShard();
    s.fx = [{ currency: "HKD", code: "HKDCNY", name: "港币兑人民币", rate: [0.9, 0.9] }];
    // 短一格就会「第 k 天用错价」，而且不会报错
    expect(isLevelShard(s)).toBe(false);
  });

  it("港股价格按当天汇率折算，股数一根手指都不碰", () => {
    const hk = convertShardToCny(hkShard()).instruments.find((i) => i.code === "00700.HK");
    expect(hk?.open[0]).toBe(270); // 300 × 0.9
    expect(hk?.close[0]).toBeCloseTo(274.5, 4); // 305 × 0.9
    expect(hk?.prevClose).toBe(270); // 300 × 0.9
    expect(hk?.volume[0]).toBe(1000); // 股数跟币种无关
    expect(hk?.currency).toBe("HKD"); // 原币种留着，界面要用它标注
  });

  it("A 股原样不动", () => {
    const cn = convertShardToCny(hkShard()).instruments.find((i) => i.code === "600519.SH");
    expect(cn?.close).toEqual([1005, 1008, 995, 985]);
  });

  it("汇率哪天空着就沿用上一个已知值——不是跳过，也不是按 1:1", () => {
    const s = hkShard();
    s.fx![0]!.rate = [0.9, null, null, 0.91];
    const hk = convertShardToCny(s).instruments.find((i) => i.code === "00700.HK");
    expect(hk?.close[0]).toBeCloseTo(274.5, 4); // × 0.9
    expect(hk?.close[1]).toBeCloseTo(277.2, 4); // × 0.9（沿用）
    expect(hk?.close[2]).toBeCloseTo(270, 4); // × 0.9（沿用）
    expect(hk?.close[3]).toBeCloseTo(268.45, 4); // × 0.91
  });

  it("没有境外标的就原样返回，不凭空造一段汇率", () => {
    const s = goodShard();
    expect(convertShardToCny(s)).toBe(s);
  });

  it("有境外标的却没有汇率就抛错，绝不按 1:1 硬跑", () => {
    // 港币和人民币差约 13%，按 1:1 顶替等于让玩家看到的成本凭空少一成多
    const s = hkShard();
    delete s.fx;
    expect(() => convertShardToCny(s)).toThrow(/汇率序列/);
  });

  it("缺的正好是这个币种的汇率，同样抛错", () => {
    const s = hkShard();
    s.fx = [{ currency: "USD", code: "USDCNY", name: "美元兑人民币", rate: [7, 7, 7, 7] }];
    expect(() => convertShardToCny(s)).toThrow(/HKD/);
  });

  it("读分片时自动折算——这是境外价格进引擎的唯一入口", async () => {
    const got = await loadLevelShard("2020-02-03", {
      fetchImpl: stubFetch({ ok: true, status: 200, json: async () => hkShard() }),
    });
    expect(got.instruments.find((i) => i.code === "00700.HK")?.open[0]).toBe(270);
  });
});

// ── 回溯模式（模式 4）──────────────────────────────────────
//
// 30 个交易日的假快照：比窗口（22 天）长，才看得出窗口是从**尾部**截的，
// 而不是「日历有多长就给多长」。

const BT_CAL = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);

function btStock(code: string, name: string, industry: string): StockData {
  const n = BT_CAL.length;
  return {
    code,
    name,
    industry,
    industryCode: "801080.SI",
    weight: 1,
    isST: false,
    open: BT_CAL.map((_, i) => 10 + i * 0.1),
    close: BT_CAL.map((_, i) => 10.05 + i * 0.1),
    high: BT_CAL.map((_, i) => 10.3 + i * 0.1),
    low: BT_CAL.map((_, i) => 9.8 + i * 0.1),
    volume: BT_CAL.map(() => 1000),
  };
}

/** 2 只 A 股 + 港日韩各一只，用来验证「回溯只放 A 股」 */
function btSnapshot(): Snapshot {
  return {
    meta: {},
    calendar: [...BT_CAL],
    indices: [
      {
        code: "000300.SH",
        name: "沪深300",
        open: BT_CAL.map(() => 4000),
        close: BT_CAL.map((_, i) => 4000 + i),
        high: BT_CAL.map(() => 4010),
        low: BT_CAL.map(() => 3990),
        volume: BT_CAL.map(() => 1),
      },
    ],
    sectors: [],
    stocks: [
      btStock("600519.SH", "贵州茅台", "食品饮料"),
      btStock("000001.SZ", "平安银行", "银行"),
      btStock("00700.HK", "腾讯控股", "港股"),
      btStock("7203.JP", "丰田汽车", "日股"),
      btStock("005930.KR", "三星电子", "韩股"),
    ],
    etfs: [],
  };
}

describe("回溯模式：可选的起点", () => {
  it("窗口是日历最后 22 个交易日，从早到晚", () => {
    const opts = backtrackOptions(BT_CAL);
    expect(opts).toHaveLength(BACKTRACK_DAYS);
    expect(opts[0]!.date).toBe(BT_CAL[BT_CAL.length - BACKTRACK_DAYS]);
    expect(opts[opts.length - 1]!.date).toBe(BT_CAL[BT_CAL.length - 1]);
    // 从早到晚。倒过来排的话「能玩满一个月」的那一天会掉到列表最底下
    expect(opts.map((o) => o.date)).toEqual([...opts].map((o) => o.date).sort());
  });

  it("每一天都带「还剩几个交易日」，最后一天剩 1", () => {
    const opts = backtrackOptions(BT_CAL);
    expect(opts[0]!.remaining).toBe(BACKTRACK_DAYS);
    expect(opts[opts.length - 1]!.remaining).toBe(1);
    for (let i = 1; i < opts.length; i += 1) {
      expect(opts[i]!.remaining).toBe(opts[i - 1]!.remaining - 1);
    }
  });

  it("index 是日历下标，不是窗口内的序号", () => {
    // 传错的话开局会跑到窗口以外的日子去，而界面上看不出任何异常
    const opts = backtrackOptions(BT_CAL);
    expect(opts[0]!.index).toBe(BT_CAL.length - BACKTRACK_DAYS);
    for (const o of opts) expect(BT_CAL[o.index]).toBe(o.date);
  });

  it("日历比窗口还短时全给出来，不补空", () => {
    const opts = backtrackOptions(BT_CAL.slice(0, 5));
    expect(opts).toHaveLength(5);
    expect(opts[0]!.remaining).toBe(5);
  });

  it("空日历给空数组（大厅那张卡据此置灰）", () => {
    expect(backtrackOptions([])).toEqual([]);
  });
});

describe("回溯模式：只放 A 股", () => {
  it("港股 / 日股 / 韩股都不进这一局", () => {
    const codes = backtrackStocks(btSnapshot()).map((s) => s.code);
    expect(codes).toEqual(["600519.SH", "000001.SZ"]);
  });

  it("不显式传 codes 的话，境外标的会被一起放进来按本币当人民币", () => {
    // 这条钉的是 handleStartBacktrack 里那句 `codes`。哪天有人把它当冗余删掉，
    // 港股就会按 1:1 混进这一局 —— 玩家的成本凭空少一成多，界面上不会有任何提示。
    const st = startReplay(btSnapshot(), BT_CAL, { mode: "backtrack", initialCash: 100000, startIndex: 8 });
    expect(st.config.instruments).toHaveLength(5);
  });
});

describe("回溯模式：开局", () => {
  const start = () => {
    const snap = btSnapshot();
    const codes = backtrackStocks(snap).map((s) => s.code);
    return startReplay(snap, BT_CAL, {
      mode: "backtrack",
      initialCash: 100000,
      startIndex: 20,
      codes,
      label: `回溯 · ${BT_CAL[20]} 起`,
    });
  };

  it("起点就是玩家挑的那天，股票池只有 A 股", () => {
    const st = start();
    expect(st.config.startIndex).toBe(20);
    expect(replayDate(st)).toBe(BT_CAL[20]);
    expect(st.config.instruments.map((i) => i.code)).toEqual(["600519.SH", "000001.SZ"]);
    expect(st.config.label).toBe("回溯 · 2026-09-21 起");
    expect(st.config.calendar).toEqual(BT_CAL);
  });

  it("窗口起点也能开：第一天就能下单（有开盘价）", () => {
    const snap = btSnapshot();
    const codes = backtrackStocks(snap).map((s) => s.code);
    const st = startReplay(snap, BT_CAL, { mode: "backtrack", initialCash: 100000, startIndex: 8, codes });
    expect(st.config.instruments.every((i) => i.open[8] !== null)).toBe(true);
  });
});

describe("回溯模式的存档往返", () => {
  function btSave(mode: unknown) {
    return parseReplaySave({
      version: 1,
      mode,
      hideDate: false,
      startIndex: 20,
      initialCash: 100000,
      codes: ["600519.SH"],
      levelId: null,
      label: "回溯 · 2026-09-21 起",
      dayIndex: 22,
      account: { cash: 1, initialCash: 100000, holdings: [] },
      pending: [],
      equity: [],
      log: [],
      finished: false,
      seq: 1,
    });
  }

  it("mode 存得下、读得回", () => {
    // 不补 parseReplaySave 那一格的话，回溯局刷新页面会变成**藏日期的随机局**：
    // 日期没了，但账还是那本账，玩家只会觉得「日期凭空消失了」。
    expect(btSave("backtrack")?.mode).toBe("backtrack");
    expect(btSave("backtrack")?.hideDate).toBe(false);
  });

  it("传奇与随机照旧", () => {
    expect(btSave("legend")?.mode).toBe("legend");
    expect(btSave("random")?.mode).toBe("random");
  });

  it("认不出来的模式仍然退回随机，不把整局丢掉", () => {
    expect(btSave("something-else")?.mode).toBe("random");
    expect(btSave(undefined)?.mode).toBe("random");
  });
});
