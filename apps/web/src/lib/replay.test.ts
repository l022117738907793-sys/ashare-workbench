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
import {
  isLevelShard,
  loadLevelIndex,
  loadLevelShard,
  parseReplaySave,
  restoreLevelReplay,
  startLevelReplay,
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
