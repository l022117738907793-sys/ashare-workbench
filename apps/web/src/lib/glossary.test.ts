/**
 * 术语词典：找词、切词、以及文案本身的规矩。
 *
 * 这块出错的代价很具体：切错了会把一句话割成「可卖 / 数量」两截还显示成两个
 * 蓝词；漏了词就是玩家看不懂那个词却点不动。所以两件事都测：
 * 匹配行为，和词典里每一条的文案是否守规矩。
 */
import { describe, expect, it } from "vitest";
import { findTerms, splitTerms, termByKey, TERMS } from "./glossary";

describe("术语：找词", () => {
  it("找得出文本里的术语并给出位置", () => {
    const hits = findTerms("今天的滑点是多少");
    expect(hits.map((h) => h.key)).toEqual(["滑点"]);
    expect(hits[0].index).toBe(3);
  });

  it("同一条术语出现两次都要找到", () => {
    const hits = findTerms("涨停了，涨停就是不能再涨了");
    expect(hits.filter((h) => h.key === "涨停")).toHaveLength(2);
  });

  it("重叠时只取长的：可卖数量 不会被切成 可卖 + 数量", () => {
    const parts = splitTerms("可卖数量是 300 股");
    const words = parts.filter((p) => p.term).map((p) => p.text);
    expect(words).toEqual(["可卖数量"]);
  });

  it("「可卖」没有单独收成一条 —— 只有完整的「可卖数量」才给解释", () => {
    // 这是有意的：「可卖」在持仓那一行里就是「可卖数量」的省略写法，给它单独
    // 写一条解释只会让同一件事有两个入口。所以长词赢，短词不存在。
    const parts = splitTerms("可卖数量是 300 股，另外还有 100 股可卖");
    const words = parts.filter((p) => p.term).map((p) => p.text);
    expect(words).toEqual(["可卖数量"]);
    expect(termByKey("可卖")).toBeUndefined();
  });

  it("别名在别处单独出现也要认（昨收价 / 昨收）", () => {
    const parts = splitTerms("昨收价是 10 元；单说昨收，指的也是它");
    const words = parts.filter((p) => p.term).map((p) => p.text);
    expect(words).toEqual(["昨收价", "昨收"]);
  });

  it("别名能落到同一条：昨收价 与 昨收", () => {
    expect(termByKey("昨收价")?.id).toBe("昨收");
    expect(termByKey("昨收")?.id).toBe("昨收");
  });

  it("没命中就原样一段返回，不额外包东西", () => {
    const parts = splitTerms("今天天气不错");
    expect(parts).toEqual([{ text: "今天天气不错" }]);
  });

  it("切出来的片段拼回去等于原文（不能吞字也不能重复）", () => {
    const text = "T+1 规则下，今天买入的股票明天才能卖，涨停价也一样，注意滑点和手续费。";
    const parts = splitTerms(text);
    expect(parts.map((p) => p.text).join("")).toBe(text);
  });
});

describe("术语：词典本身的规矩", () => {
  it("每条都有 id、短释义和完整解释", () => {
    for (const t of TERMS) {
      expect(t.id.length, `${t.id} 的 id`).toBeGreaterThan(0);
      expect(t.short.length, `${t.id} 缺 short`).toBeGreaterThan(4);
      expect(t.full.length, `${t.id} 的 full 太短`).toBeGreaterThan(t.short.length);
    }
  });

  it("id 不重复", () => {
    const ids = TERMS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("短释义只写一句话，不换行、不带 markdown 记号", () => {
    for (const t of TERMS) {
      expect(t.short.includes("\n"), `${t.id} 的 short 里有换行`).toBe(false);
      expect(t.short.includes("**"), `${t.id} 的 short 里有 markdown 星号`).toBe(false);
    }
  });

  it("完整解释里的 ** 是成对的（渲染时会被换成加粗，单数会把星号漏给玩家）", () => {
    for (const t of TERMS) {
      const marks = (t.full.match(/\*\*/g) ?? []).length;
      expect(marks % 2, `${t.id} 的 ** 不成对`).toBe(0);
    }
  });

  it("术语本身在原文里就带标点或空格的不收 —— 切出来会难看", () => {
    for (const t of TERMS) {
      expect(t.id.trim(), `${t.id} 首尾有空白`).toBe(t.id);
    }
  });
});
