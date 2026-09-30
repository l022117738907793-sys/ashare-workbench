import { describe, expect, it } from "vitest";
import {
  PICK_CAVEAT,
  PICK_LIMIT,
  amountOf,
  changePctOf,
  fmtAmount,
  pickCandidates,
  pickScore,
  searchStocks,
  type PickStock,
} from "./picks";

function s(over: Partial<PickStock> & { code: string }): PickStock {
  return { name: over.code, sector: "电子", price: 10, changePct: 0, amount: 1e8, ...over };
}

describe("pickScore：三种问法各自的分数", () => {
  it("涨得最猛看涨跌幅，跌得最狠取负", () => {
    expect(pickScore(s({ code: "a", changePct: 3.2 }), "up")).toBe(3.2);
    expect(pickScore(s({ code: "a", changePct: 3.2 }), "down")).toBe(-3.2);
    expect(pickScore(s({ code: "a", changePct: -5 }), "down")).toBe(5);
  });

  it("成交最热看成交额", () => {
    expect(pickScore(s({ code: "a", amount: 123 }), "hot")).toBe(123);
  });

  it("取不到数就是 null —— 不拿 0 冒充，否则「没有行情」会被排到涨幅榜末尾", () => {
    expect(pickScore(s({ code: "a", changePct: null }), "up")).toBeNull();
    expect(pickScore(s({ code: "a", changePct: null }), "down")).toBeNull();
    expect(pickScore(s({ code: "a", amount: null }), "hot")).toBeNull();
    expect(pickScore(s({ code: "a", amount: 0 }), "hot")).toBeNull();
  });
});

describe("pickCandidates：每个板块都要有人进榜", () => {
  const rows: PickStock[] = [
    // 电子三家，涨幅都很高
    s({ code: "e1", sector: "电子", changePct: 10 }),
    s({ code: "e2", sector: "电子", changePct: 9 }),
    s({ code: "e3", sector: "电子", changePct: 8 }),
    // 银行一家，涨幅低
    s({ code: "b1", sector: "银行", changePct: 1 }),
    // 医药一家
    s({ code: "m1", sector: "医药", changePct: 5 }),
  ];

  it("一个板块不会刷屏：电子只有 2 只进榜，银行虽然涨幅最低也在", () => {
    const got = pickCandidates(rows, "up");
    const codes = got.map((x) => x.code);
    expect(codes.filter((c) => c.startsWith("e"))).toHaveLength(2);
    expect(codes).toContain("b1");
    expect(codes).toContain("m1");
  });

  it("合并之后仍按分数从高到低", () => {
    const got = pickCandidates(rows, "up").map((x) => x.changePct);
    expect(got).toEqual([...got].sort((a, b) => (b as number) - (a as number)));
  });

  it("分数相同时按代码排 —— 同样的输入必须得到同样的榜单", () => {
    const same = [s({ code: "zz", sector: "A", changePct: 3 }), s({ code: "aa", sector: "B", changePct: 3 })];
    expect(pickCandidates(same, "up").map((x) => x.code)).toEqual(["aa", "zz"]);
  });

  it("缺板块名的归到「未分类」，不会被丢掉", () => {
    const got = pickCandidates([s({ code: "x", sector: "", changePct: 4 })], "up");
    expect(got.map((x) => x.code)).toEqual(["x"]);
  });

  it("没有分数的行不进榜", () => {
    const got = pickCandidates([s({ code: "x", changePct: null }), s({ code: "y", changePct: 1 })], "up");
    expect(got.map((x) => x.code)).toEqual(["y"]);
  });

  it("默认最多 8 行，perSector 可调", () => {
    const many: PickStock[] = [];
    for (let i = 0; i < 20; i++) many.push(s({ code: `c${String(i).padStart(2, "0")}`, sector: `S${i}`, changePct: i }));
    expect(pickCandidates(many, "up")).toHaveLength(PICK_LIMIT);
    expect(pickCandidates(many, "up", { perSector: 1, limit: 3 })).toHaveLength(3);
  });

  it("空池子返回空数组，不抛", () => {
    expect(pickCandidates([], "up")).toEqual([]);
  });
});

describe("searchStocks：边打边筛", () => {
  const rows: PickStock[] = [
    s({ code: "600519.SH", name: "贵州茅台", sector: "食品饮料" }),
    s({ code: "600036.SH", name: "招商银行", sector: "银行" }),
    s({ code: "000001.SZ", name: "平安银行", sector: "银行" }),
  ];

  it("没输入时返回空数组 —— 「没输入」和「没匹配上」是两种状态", () => {
    expect(searchStocks(rows, "")).toEqual([]);
    expect(searchStocks(rows, "   ")).toEqual([]);
  });

  it("按名字找", () => {
    expect(searchStocks(rows, "茅台").map((x) => x.code)).toEqual(["600519.SH"]);
  });

  it("按完整代码找", () => {
    expect(searchStocks(rows, "000001.SZ").map((x) => x.name)).toEqual(["平安银行"]);
  });

  it("只打后几位数字也能找到", () => {
    expect(searchStocks(rows, "519").map((x) => x.name)).toEqual(["贵州茅台"]);
    expect(searchStocks(rows, "0036").map((x) => x.name)).toEqual(["招商银行"]);
  });

  it("完整代码排在最前", () => {
    const got = searchStocks([s({ code: "600036.SH", name: "A" }), s({ code: "600036.SH2", name: "B" })], "600036.SH");
    expect(got.map((x) => x.name)).toEqual(["A", "B"]);
  });

  it("一个数字不参与代码模糊匹配（否则一半的票都会被翻出来）", () => {
    expect(searchStocks(rows, "6")).toEqual([]);
  });

  it("但一个汉字仍然算有效线索（同一档的按代码排，保证顺序稳定）", () => {
    expect(searchStocks(rows, "银").map((x) => x.name)).toEqual(["平安银行", "招商银行"]);
  });

  it("找不到就是空数组，由调用方显示「没找到」", () => {
    expect(searchStocks(rows, "不存在的公司")).toEqual([]);
  });
});

describe("涨跌幅与成交额的计算", () => {
  it("正常情况", () => {
    expect(changePctOf(11, 10)).toBeCloseTo(10);
    expect(changePctOf(9, 10)).toBeCloseTo(-10);
  });

  it("昨收取不到、或为 0 时算不出来 —— 返回 null 而不是 0", () => {
    expect(changePctOf(10, null)).toBeNull();
    expect(changePctOf(null, 10)).toBeNull();
    expect(changePctOf(10, 0)).toBeNull();
  });

  it("成交额 = 价 × 量；量取不到或为 0 时返回 null", () => {
    expect(amountOf(10, 1000)).toBe(10000);
    expect(amountOf(10, null)).toBeNull();
    expect(amountOf(10, 0)).toBeNull();
    expect(amountOf(null, 1000)).toBeNull();
  });

  it("成交额按亿/万显示", () => {
    expect(fmtAmount(1.23e9)).toBe("12.3 亿");
    expect(fmtAmount(4.567e7)).toBe("4567 万");
    expect(fmtAmount(1234)).toBe("1234");
    expect(fmtAmount(null)).toBe("—");
  });
});

describe("免责说明", () => {
  it("必须写明「不是推荐」，这是模拟游戏和分析引擎的分界线", () => {
    expect(PICK_CAVEAT).toContain("不是推荐");
  });
});
