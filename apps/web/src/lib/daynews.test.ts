/**
 * 「那一天的资讯」——离线归档的读取与合法性判断。
 *
 * 这块最要命的一条：**取不到就必须说取不到**。历史推演里宁可少一份材料，
 * 也不能把「我们没抓到」渲染成「那天没发生什么」。所以这里把「文件不在」
 * 「JSON 是坏的」「字段不全」三种情况都测到，它们都必须落到 null，
 * 而不是一个空列表（空列表会和「那天真的没有新闻」混在一起）。
 */
import { describe, expect, it } from "vitest";
import { isDayNews, isIsoDate, loadDayNews, maskDatesIn, type ReplayState } from "./replay";

/** 造一个假的 fetch：按 URL 返回预设内容 */
function stubFetch(routes: Record<string, { ok?: boolean; body?: unknown; throw?: boolean }>) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(String(url));
    const hit = routes[String(url)];
    if (!hit || hit.throw) throw new Error("network down");
    return {
      ok: hit.ok ?? true,
      status: hit.ok === false ? 404 : 200,
      json: async () => hit.body,
    };
  }) as unknown as typeof fetch;
  return { f, calls };
}

const good = {
  date: "2020-02-03",
  source: "新浪财经首页归档",
  url: "https://finance.sina.com.cn/head/finance20200203am.shtml",
  note: "当天上午那版首页上的稿件标题。",
  items: [{ title: "央行开展1.2万亿元逆回购操作", url: "https://finance.sina.com.cn/money/bank/2020-02-03/doc-1.shtml" }],
};

describe("那一天的资讯：读文件", () => {
  it("正常的一份读出来", async () => {
    const { f } = stubFetch({ "./history/news/2020-02-03.json": { body: good } });
    const got = await loadDayNews("2020-02-03", { fetchImpl: f });
    expect(got?.date).toBe("2020-02-03");
    expect(got?.items).toHaveLength(1);
    expect(got?.items[0].title).toContain("逆回购");
  });

  it("没有这一天：返回 null，不是空列表", async () => {
    const { f } = stubFetch({});
    expect(await loadDayNews("2020-02-03", { fetchImpl: f })).toBeNull();
  });

  it("HTTP 404 也返回 null，不抛", async () => {
    const { f } = stubFetch({
      "./history/news/2020-02-03.json": { ok: false },
    });
    expect(await loadDayNews("2020-02-03", { fetchImpl: f })).toBeNull();
  });

  it("JSON 结构不对（没有 items）返回 null，绝不兜底成空数组", async () => {
    const { f } = stubFetch({
      "./history/news/2020-02-03.json": { body: { date: "2020-02-03" } },
    });
    expect(await loadDayNews("2020-02-03", { fetchImpl: f })).toBeNull();
  });

  it("items 里混了一条缺 url 的，整份都不认", async () => {
    const bad = { ...good, items: [...good.items, { title: "只有标题" }] };
    const { f } = stubFetch({ "./history/news/2020-02-03.json": { body: bad } });
    expect(await loadDayNews("2020-02-03", { fetchImpl: f })).toBeNull();
  });

  it("日期不合法就不发请求 —— 它会被拼进 URL", async () => {
    const { f, calls } = stubFetch({});
    expect(await loadDayNews("../../etc/passwd", { fetchImpl: f })).toBeNull();
    expect(await loadDayNews("2020-2-3", { fetchImpl: f })).toBeNull();
    expect(await loadDayNews("", { fetchImpl: f })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("可以换 base（部署在子路径时）", async () => {
    const { f, calls } = stubFetch({
      "https://x.example.com/hist/news/2020-02-03.json": { body: good },
    });
    const got = await loadDayNews("2020-02-03", {
      base: "https://x.example.com/hist/",
      fetchImpl: f,
    });
    expect(got).not.toBeNull();
    expect(calls[0]).toBe("https://x.example.com/hist/news/2020-02-03.json");
  });
});

describe("那一天的资讯：字段校验", () => {
  it("isIsoDate 只认严格的 YYYY-MM-DD", () => {
    expect(isIsoDate("2020-02-03")).toBe(true);
    expect(isIsoDate("2020-2-3")).toBe(false);
    expect(isIsoDate("20200203")).toBe(false);
    expect(isIsoDate(20200203)).toBe(false);
    expect(isIsoDate(null)).toBe(false);
  });

  it("isDayNews 要 date + 每条都有 title 和 url", () => {
    expect(isDayNews(good)).toBe(true);
    expect(isDayNews({ ...good, items: [] })).toBe(true);
    expect(isDayNews({ ...good, date: "2020/02/03" })).toBe(false);
    expect(isDayNews({ ...good, items: "不是数组" })).toBe(false);
    expect(isDayNews(null)).toBe(false);
  });
});

describe("藏日期：新闻标题里的中文日期也会漏", () => {
  const state = { config: { calendar: ["2020-02-03", "2020-02-04", "2020-02-05"], startIndex: 0 } } as unknown as ReplayState;

  it("ISO 日期换成第 N 天", () => {
    expect(maskDatesIn(state, "2020-02-04 大跌", true)).toBe("第 2 天 大跌");
  });

  it("「2月3日」这种写法同样要盖掉 —— 归档标题里到处都是", () => {
    expect(maskDatesIn(state, "2月3日A股大跌", true)).toBe("当天A股大跌");
    expect(maskDatesIn(state, "2020年2月3日开盘", true)).toBe("当天开盘");
  });

  it("不藏的时候一个字都不动（传奇模式要显示真日期）", () => {
    const t = "2月3日A股大跌，2020-02-04 反弹";
    expect(maskDatesIn(state, t, false)).toBe(t);
  });
});
