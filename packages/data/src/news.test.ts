import { describe, expect, it, vi } from "vitest";
import {
  fetchLatestNews,
  matchNewsToStock,
  tonghuashunNewsProvider,
  type NewsItem,
  type NewsProvider,
} from "./news";

const item = (over: Partial<NewsItem> = {}): NewsItem => ({
  id: "n1",
  title: "标题",
  digest: "",
  at: Date.now(),
  source: "t",
  timeKnown: true,
  ...over,
});

const fake = (name: string, impl: () => Promise<NewsItem[]>, supported = true): NewsProvider => ({
  name,
  isSupported: () => supported,
  fetchLatest: impl,
});

describe("新闻获取链", () => {
  it("首个来源成功即返回", async () => {
    const r = await fetchLatestNews(5, [fake("a", async () => [item()])]);
    expect(r.items).toHaveLength(1);
    expect(r.source).toBe("a");
    expect(r.degradedReason).toBeNull();
  });

  it("首个来源抛错 → 降级到下一个并记录原因", async () => {
    const r = await fetchLatestNews(5, [
      fake("a", async () => {
        throw new Error("限频");
      }),
      fake("b", async () => [item()]),
    ]);
    expect(r.source).toBe("b");
    expect(r.degradedReason).toContain("限频");
  });

  it("不支持的环境被跳过", async () => {
    const spy = vi.fn(async () => [item()]);
    const r = await fetchLatestNews(5, [fake("a", spy, false), fake("b", async () => [item()])]);
    expect(spy).not.toHaveBeenCalled();
    expect(r.source).toBe("b");
  });

  it("全部失败 → 返回空数组并说明原因，绝不编造", async () => {
    const r = await fetchLatestNews(5, [
      fake("a", async () => []),
      fake("b", async () => {
        throw new Error("挂了");
      }),
    ]);
    expect(r.items).toEqual([]);
    expect(r.source).toBeNull();
    expect(r.degradedReason).toContain("挂了");
  });

  it("返回空数组被视为失败并继续尝试下一个", async () => {
    const r = await fetchLatestNews(5, [fake("a", async () => []), fake("b", async () => [item()])]);
    expect(r.source).toBe("b");
  });
});

describe("新闻与个股匹配", () => {
  const items = [
    item({ id: "1", title: "贵州茅台发布公告" }),
    item({ id: "2", title: "完全无关的新闻" }),
    item({ id: "3", title: "600519 获增持" }),
    item({ id: "4", digest: "涉及贵州茅台的传闻", title: "传闻" }),
  ];

  it("按名称、代码（含后缀与纯数字）匹配", () => {
    const hit = matchNewsToStock(items, "贵州茅台", "600519.SH");
    expect(hit.map((h) => h.id)).toEqual(["1", "3", "4"]);
  });

  it("无命中返回空数组", () => {
    expect(matchNewsToStock(items, "不存在的公司", "999999.SZ")).toEqual([]);
  });

  it("空列表不抛错", () => {
    expect(matchNewsToStock([], "贵州茅台", "600519.SH")).toEqual([]);
  });
});

/**
 * 下面这批用例的来源是实测，不是我坐在椅子上想出来的：
 * `scripts/audit-news-match.ts` 拿 800 条真实快讯 × 619 个真实股票名跑了一遍，
 * 误命中只有「名字被另一个词吞掉」这一种形状，一共 3 例。三例都收在这里。
 */
describe("新闻匹配：名字被别的词吞掉时不算命中", () => {
  const mismatches: Array<[string, string, string, string]> = [
    [
      "中国银行",
      "601988.SH",
      "2026年6月末中国银行业对外金融资产12345亿美元",
      "银行业",
    ],
    [
      "上海银行",
      "601229.SH",
      "上海银行间同业拆放利率（Shibor）多数下行",
      "银行间",
    ],
    [
      "中国石油",
      "601857.SH",
      "贝莱德对中国石油化工股份的多头持仓比例降至5.02%",
      "石油化工",
    ],
  ];

  for (const [name, code, title, swallowedBy] of mismatches) {
    it(`「${name}」不该被「${swallowedBy}」算作命中`, () => {
      expect(matchNewsToStock([item({ title })], name, code)).toEqual([]);
    });
  }

  it("名字在同一篇里先被吞掉、后又真的出现，仍算命中", () => {
    const title = "中国银行业对外金融资产余额公布，中国银行回应称不予置评";
    expect(matchNewsToStock([item({ title })], "中国银行", "601988.SH")).toHaveLength(1);
  });
});

describe("新闻匹配：这些真命中一个都不能误伤", () => {
  /**
   * 每一条都是语料里真实出现过、且**必须**继续算命中的形状。
   * 它们的共同点：名字后面紧跟的字开始了一个新词，而不是把名字补成另一个词。
   * 尤其 `业绩`（业）与 `长期`（长）—— 按「后一个字」拉黑的写法会在这里翻车，
   * 所以实现里比的是完整的词，不是单个字。
   */
  const truePositives: Array<[string, string, string]> = [
    ["比亚迪", "002594.SZ", "比亚迪股份等汽车股走强"],
    ["长飞光纤", "601869.SH", "长飞光纤光缆跌16.42%"],
    ["中国海油", "600938.SH", "中国海油集团增持触及1%刻度"],
    ["国泰海通", "601211.SH", "国泰海通证券担任辅导机构"],
    ["中国联通", "600050.SH", "中国联通吉林分公司与电投绿能签约"],
    ["万科A", "000002.SZ", "万科A今日涨9.9%"],
    ["宁德时代", "300750.SZ", "宁德时代长期看好换电业务"],
    ["万科A", "000002.SZ", "万科A业绩预告：预计扭亏"],
  ];

  for (const [name, code, title] of truePositives) {
    it(`「${name}」在「${title}」里算命中`, () => {
      expect(matchNewsToStock([item({ title })], name, code)).toHaveLength(1);
    });
  }
});

describe("新闻匹配：6 位代码要卡数字边界", () => {
  it("受理号 CXSL2601061 里的 601061 不该命中中信金属", () => {
    // 实测原例：长春高新公告里的受理号 CXSL2601061，把中信金属（601061.SH）算了进去
    const digest =
      "受理号为CXSL2601061、CXSL2601062。";
    expect(matchNewsToStock([item({ digest })], "中信金属", "601061.SH")).toEqual([]);
  });

  it("1,000,001 元这种金额不该命中 000001.SZ", () => {
    expect(matchNewsToStock([item({ title: "成交额1000001元" })], "平安银行", "000001.SZ")).toEqual([]);
  });

  it("独立的 000001 算命中", () => {
    expect(matchNewsToStock([item({ title: "000001 获增持" })], "平安银行", "000001.SZ")).toHaveLength(1);
  });

  it("带后缀的全代码仍然算命中", () => {
    expect(
      matchNewsToStock([item({ title: "000001.SZ 今日停牌" })], "平安银行", "000001.SZ"),
    ).toHaveLength(1);
  });
});

describe("同花顺快讯 provider（离线，模拟其真实响应格式）", () => {
  /**
   * 这个 describe 存在的理由：同花顺的响应格式有两个反直觉之处，
   * 都在实测中踩过 ——
   *   1. 成功码是 `"200"`（字符串，仿 HTTP 语义），不是 0
   *   2. **所有字段都是字符串**：id / ctime / rtime / nature / color
   */
  const realShape = {
    code: "200",
    msg: "成功",
    data: {
      list: [
        {
          id: "5236943",
          title: "美国10年期国债收益率持续走高",
          digest: "升至5.081%，为2007年7月以来最高",
          url: "https://news.10jqka.com.cn/20260923/c1.shtml",
          ctime: "1790178303",
          rtime: "1790178303",
          source: "",
          nature: "0",
          color: "1",
        },
        {
          id: "5236900",
          title: "WTI原油涨超2%",
          digest: "",
          ctime: "1790177325",
          rtime: "1790177325",
        },
      ],
    },
  };

  function withFetch(payload: unknown, fn: () => Promise<void>): Promise<void> {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, json: async () => payload }) as Response) as typeof fetch;
    return fn().finally(() => {
      globalThis.fetch = original;
    });
  }

  it("接受字符串形式的成功码 \"200\"", async () => {
    await withFetch(realShape, async () => {
      const items = await tonghuashunNewsProvider.fetchLatest(5);
      expect(items).toHaveLength(2);
      expect(items[0].title).toBe("美国10年期国债收益率持续走高");
    });
  });

  it("字符串时间戳能正确解析为毫秒", async () => {
    await withFetch(realShape, async () => {
      const items = await tonghuashunNewsProvider.fetchLatest(5);
      expect(items[0].timeKnown).toBe(true);
      expect(items[0].at).toBe(1790178303 * 1000);
      // 按时间降序
      expect(items[0].at).toBeGreaterThan(items[1].at);
    });
  });

  it("不使用 nature / color 字段（本项目不标利好利空）", async () => {
    await withFetch(realShape, async () => {
      const items = await tonghuashunNewsProvider.fetchLatest(5);
      const keys = Object.keys(items[0]);
      expect(keys).not.toContain("nature");
      expect(keys).not.toContain("color");
    });
  });

  it("时间缺失时标记 timeKnown=false，不伪装成 1970", async () => {
    await withFetch(
      { code: "200", data: { list: [{ id: "1", title: "无时间新闻" }] } },
      async () => {
        const items = await tonghuashunNewsProvider.fetchLatest(5);
        expect(items[0].timeKnown).toBe(false);
        expect(items[0].at).toBe(0);
      },
    );
  });

  it("真的失败码（如 500）会抛错，不会静默返回空", async () => {
    await withFetch({ code: "500", msg: "服务异常", data: null }, async () => {
      await expect(tonghuashunNewsProvider.fetchLatest(5)).rejects.toThrow(/500/);
    });
  });

  it("空标题条目被丢弃", async () => {
    await withFetch(
      { code: "200", data: { list: [{ id: "1", title: "" }, { id: "2", title: "有标题" }] } },
      async () => {
        const items = await tonghuashunNewsProvider.fetchLatest(5);
        expect(items).toHaveLength(1);
        expect(items[0].title).toBe("有标题");
      },
    );
  });
});
