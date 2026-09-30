import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LEVELS, LEVEL_COUNT, LEVEL_DAYS, levelById } from "./levels";

const SHARD_DIR = join(process.cwd(), "data", "history");

interface Shard {
  levelId: string;
  startDate: string;
  days: number;
  calendar: string[];
  benchmark: { code: string; name: string; close: Array<number | null> };
  instruments: Array<{
    code: string;
    name: string;
    isST: boolean;
    open: Array<number | null>;
    close: Array<number | null>;
    high: Array<number | null>;
    low: Array<number | null>;
    volume: Array<number | null>;
  }>;
}

const readShard = (id: string): Shard =>
  JSON.parse(readFileSync(join(SHARD_DIR, `level-${id}.json`), "utf-8")) as Shard;

describe("传奇模式的关卡定义", () => {
  it("一共 10 关，序号从 1 连到 10", () => {
    expect(LEVEL_COUNT).toBe(10);
    expect(LEVELS.map((l) => l.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("关卡 id 不重复，且都是日期格式", () => {
    const ids = LEVELS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("按时间从早到晚排列", () => {
    const starts = LEVELS.map((l) => l.startDate);
    expect([...starts].sort()).toEqual(starts);
  });

  it("每关都有简报和思考题，且简报不是空话", () => {
    for (const l of LEVELS) {
      expect(l.title.length).toBeGreaterThan(0);
      expect(l.theme.length).toBeGreaterThan(10);
      expect(l.briefing.length).toBeGreaterThanOrEqual(2);
      for (const b of l.briefing) expect(b.length).toBeGreaterThan(8);
    }
  });

  /**
   * 用户反馈「跟剧本杀一样，改简单点」之后补的上限。
   *
   * 这一页最容易失控：每关多写一句「当时的气氛」，十关加起来就是一篇散文。
   * 上限比现状宽一点（现在最长一条 35 字、最长 theme 25 字），
   * 目的是挡住慢慢变长，不是卡死改一个字都要改测试。
   */
  it("简报和思考题都要短：简报最多两条，每条一句话，theme 一句话", () => {
    for (const l of LEVELS) {
      expect(l.briefing.length, `${l.id} 简报条数`).toBeLessThanOrEqual(2);
      for (const b of l.briefing) {
        expect(b.length, `${l.id} 这条太长了：${b}`).toBeLessThanOrEqual(40);
      }
      expect(l.theme.length, `${l.id} theme 太长了：${l.theme}`).toBeLessThanOrEqual(30);
    }
  });

  /**
   * 最重要的一条：**简报里不许出现后见之明**。
   * 写关卡文案时最容易犯的错就是顺手写「随后暴跌」，那句话在入场那天是不存在的。
   */
  it("简报里不许剧透后面的走势", () => {
    const spoilers = ["随后", "之后大", "暴跌", "大涨", "见顶", "见底", "一路下跌", "翻倍", "腰斩"];
    for (const l of LEVELS) {
      const text = l.briefing.join("");
      for (const s of spoilers) {
        expect(text, `关卡 ${l.id} 的简报里出现了「${s}」`).not.toContain(s);
      }
    }
  });

  /**
   * 光靠禁词抓不住真正危险的那种写法：把**入场之后才发生的日期**写进简报。
   *
   * 比如第 10 关入场是 2024-09-11，简报里要是写「9 月 24 日金融监管部门开发布会」，
   * 玩家一眼就知道该干什么了，这一关就废了 —— 而这句话一个禁词都不含。
   *
   * 所以规则定死：**简报里一律不写「几月几日」**。日期上头已经给了（关卡列表和
   * 推演页都在显示真实日期），简报再写一遍只可能是想预报什么。
   */
  it("简报里不写具体日期（写了就说明在预报入场之后的事）", () => {
    const md = /\d{1,2}\s*月\s*\d{1,2}\s*日/;
    for (const l of LEVELS) {
      for (const line of l.briefing) {
        expect(md.test(line), `关卡 ${l.id} 的简报里写了具体日期：${line}`).toBe(false);
      }
      expect(md.test(l.subtitle), `关卡 ${l.id} 的副标题里写了具体日期`).toBe(false);
    }
  });

  /** 组件里不解析 markdown，`**这样**` 会原样显示成一堆星号 */
  it("文案里不出现 markdown 星号（网页里不解析，会原样显示）", () => {
    for (const l of LEVELS) {
      const all = [l.title, l.subtitle, l.theme, ...l.briefing].join("");
      expect(all, `关卡 ${l.id} 的文案里有 ** 星号`).not.toContain("**");
    }
  });

  it("levelById 能按 id 取回", () => {
    expect(levelById("2020-02-03")?.order).toBe(4);
    expect(levelById("不存在")).toBeUndefined();
  });
});

/**
 * 下面这些用例要读 data/history/ 的分片。分片是**提交进仓库的发布产物**
 * （见 scripts/build-history-shards.ts），所以 CI 上也在。
 * 它们保证关卡文案里写的日期，和真正的行情数据是同一天 —— 改文案忘改数据会红。
 */
describe("关卡分片与关卡定义对得上", () => {
  for (const level of LEVELS) {
    describe(`${level.order}. ${level.id}`, () => {
      const shard = readShard(level.id);

      it("分片的日历正好是 startDate 起的 days 个交易日", () => {
        expect(shard.startDate).toBe(level.startDate);
        expect(shard.calendar).toHaveLength(level.days);
        expect(shard.calendar[0]).toBe(level.startDate);
        expect(shard.days).toBe(level.days);
      });

      it("日历是递增的、没有重复", () => {
        const sorted = [...shard.calendar].sort();
        expect(shard.calendar).toEqual(sorted);
        expect(new Set(shard.calendar).size).toBe(shard.calendar.length);
      });

      it("股票池不为空，且每只票的每一列都和日历等长", () => {
        expect(shard.instruments.length).toBeGreaterThan(20);
        for (const inst of shard.instruments) {
          // 这一条是引擎的硬要求：长度对不上就会被当成"没有开盘价"
          expect(inst.open, `${inst.code} 的 open`).toHaveLength(shard.calendar.length);
          expect(inst.close, `${inst.code} 的 close`).toHaveLength(shard.calendar.length);
          expect(inst.high, `${inst.code} 的 high`).toHaveLength(shard.calendar.length);
          expect(inst.low, `${inst.code} 的 low`).toHaveLength(shard.calendar.length);
          expect(inst.volume, `${inst.code} 的 volume`).toHaveLength(shard.calendar.length);
        }
      });

      it("代码不重复", () => {
        const codes = shard.instruments.map((i) => i.code);
        expect(new Set(codes).size).toBe(codes.length);
      });

      it("开盘价不能是 0 或负数（那会让每一笔委托都按假价格成交）", () => {
        for (const inst of shard.instruments) {
          for (const v of inst.open) {
            if (v === null) continue;
            expect(v, `${inst.code} 的开盘价`).toBeGreaterThan(0);
          }
        }
      });

      it("基准有收盘价，且窗口内有实际波动", () => {
        expect(shard.benchmark.code).toBe("000300.SH");
        expect(shard.benchmark.close).toHaveLength(shard.calendar.length);
        const vals = shard.benchmark.close.filter((v): v is number => v !== null);
        expect(vals.length).toBeGreaterThan(shard.calendar.length * 0.9);
      });
    });
  }
});
