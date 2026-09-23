import { describe, expect, it, vi } from "vitest";
import { fetchLatestNews, matchNewsToStock, type NewsItem, type NewsProvider } from "./news";

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
