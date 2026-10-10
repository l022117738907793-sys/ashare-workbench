import { describe, expect, it } from "vitest";
import {
  PICK_CAVEAT,
  PICK_LIMIT,
  PICK_PER_SECTOR,
  amountOf,
  changePctOf,
  fmtAmount,
  pickCandidates,
  pickMarkets,
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

describe("境外标的按市场分桶，不按 industry", () => {
  it("港股的 industry 就是「港股」，不能当成行业桶键", () => {
    // 一只港股即使 industry 被写成「电子」（数据脏了），也不该混进 A 股的电子桶 ——
    // 按代码推市场是唯一的真相来源。
    const rows: PickStock[] = [
      s({ code: "600519.SH", sector: "电子", changePct: 3 }),
      s({ code: "00700.HK", sector: "电子", changePct: 9 }),
    ];
    // 造一个只有这两个桶、每桶 2 只的池子，看它们是否落在同一个桶里：
    // 同桶则只能进 1 只（perSector=1），异桶则两只都进。
    const got = pickCandidates(rows, "up", { perSector: 1 });
    expect(got.map((x) => x.code).sort()).toEqual(["00700.HK", "600519.SH"]);
  });

  it("全部视图下境外可能一只都不进榜 —— 这正是要有市场筛选的原因", () => {
    const rows: PickStock[] = [];
    // 31 个 A 股行业各 2 只，涨幅从高到低
    for (let i = 0; i < 31; i++) {
      rows.push(s({ code: `60${String(i).padStart(4, "0")}.SH`, sector: `行业${i}`, changePct: 100 - i }));
      rows.push(s({ code: `00${String(i).padStart(4, "0")}.SZ`, sector: `行业${i}`, changePct: 99 - i }));
    }
    // 20 只港股，涨幅全都垫底
    for (let i = 0; i < 20; i++) {
      rows.push(s({ code: `${String(700 + i).padStart(5, "0")}.HK`, sector: "港股", changePct: -i }));
    }

    /*
     * 摊开只保证「每个桶都有机会进候选」，不保证「每个桶都进最终 8 名」：
     * 港股那个桶也交了 2 只，但它们的分数比 A 股 62 个候选都低，合并排序后
     * 排在第 63 位往后。所以「涨得最猛」的全市场前 8 里可以一只港股都没有 ——
     * **这是实话，不该硬塞**。要看见港股，得把池子缩到港股。
     */
    const got = pickCandidates(rows, "up");
    expect(got.filter((x) => x.code.endsWith(".HK"))).toHaveLength(0);

    // 筛到港股之后：单桶不截断，榜就是港股自己的前 8 名
    const hk = rows.filter((r) => r.code.endsWith(".HK"));
    const hkGot = pickCandidates(hk, "up");
    expect(hkGot).toHaveLength(PICK_LIMIT);
    expect(hkGot.every((x) => x.code.endsWith(".HK"))).toBe(true);
  });

  it("只剩一个桶时不摊开 —— 否则「只看港股」会被砍到 2 只", () => {
    const rows: PickStock[] = [];
    for (let i = 0; i < 20; i++) {
      rows.push(s({ code: `${String(700 + i).padStart(5, "0")}.HK`, sector: "港股", changePct: i }));
    }
    expect(pickCandidates(rows, "up")).toHaveLength(PICK_LIMIT);
    // 对照组：桶键确实只有一个，但换成两个桶就恢复成每个桶 2 只
    const two = [...rows, s({ code: "600519.SH", sector: "食品饮料", changePct: 0 })];
    const got = pickCandidates(two, "up");
    expect(got.filter((x) => x.code.endsWith(".HK"))).toHaveLength(PICK_PER_SECTOR);
    expect(got.filter((x) => x.code.endsWith(".SH"))).toHaveLength(1);
  });
});

describe("pickMarkets：只列出池子里真有的市场，顺序固定", () => {
  it("按 PICK_MARKET_ORDER 排，不按出现顺序", () => {
    const rows: PickStock[] = [
      s({ code: "005930.KR", sector: "韩股" }),
      s({ code: "7203.JP", sector: "日股" }),
      s({ code: "600519.SH", sector: "食品饮料" }),
      s({ code: "00700.HK", sector: "港股" }),
    ];
    expect(pickMarkets(rows)).toEqual(["CN", "HK", "JP", "KR"]);
  });

  it("没有的市场不出现（历史关卡大多只有 A 股，那时不渲染这一排）", () => {
    expect(pickMarkets([s({ code: "600519.SH" })])).toEqual(["CN"]);
    expect(pickMarkets([])).toEqual([]);
  });

  it("不写 market 键的 A 股（快照就是这样的）也算 CN", () => {
    expect(pickMarkets([s({ code: "000001.SZ" }), s({ code: "688981.SH" })])).toEqual(["CN"]);
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
