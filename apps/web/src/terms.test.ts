/**
 * 术语交互与「那一天的资讯」的渲染冒烟测试（`react-dom/server`，不需要 jsdom）。
 *
 * 两条结构性红线在这里钉死：
 * 1. **术语是 `<button>`，绝不能出现在另一个按钮或链接里面** —— 嵌套的可交互
 *    元素是非法 HTML，浏览器会把它拆开，于是「点了没反应」。
 * 2. **原文链接要是按钮的兄弟节点**，不是子节点（同 NewsPanel）。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DayNewsCard } from "./components/DayNewsCard";
import { AskBox, rich, TermText } from "./components/Terms";
import { TERMS } from "./lib/glossary";
import { resetHisui, saveHisuiSettings, NO_HISUI } from "./lib/hisui";

/**
 * node 环境没有 `localStorage`，而 `readLS` / `writeLS` 会**静默跳过**（见
 * `apps/web/src/lib/helpers.ts`）—— 于是「存了代理地址就能问」这条路径在测试里
 * 永远走不到，断言会得到一条假的通过。补一个最小实现，让设置真的存得进读得回。
 */
const lsStore = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => lsStore.get(k) ?? null,
  setItem: (k: string, v: string) => void lsStore.set(k, v),
  removeItem: (k: string) => void lsStore.delete(k),
  clear: () => lsStore.clear(),
  key: (i: number) => [...lsStore.keys()][i] ?? null,
  get length() {
    return lsStore.size;
  },
} as Storage;

function renderTerm(text: string): string {
  return renderToStaticMarkup(createElement(TermText, { text }));
}

function renderDayNews(over: Partial<Parameters<typeof DayNewsCard>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(DayNewsCard, {
      loading: false,
      missing: false,
      items: [
        { title: "央行开展1.2万亿元逆回购操作", url: "https://finance.sina.com.cn/a/1.shtml" },
        { title: "沪指收盘下跌7.72%", url: "https://finance.sina.com.cn/a/2.shtml" },
      ],
      source: "新浪财经首页归档",
      ...over,
    }),
  );
}

/** 把每个 `<button>…</button>` 抠出来，检查里面没有别的可交互元素 */
function buttonsWithNestedInteractive(html: string): string[] {
  const bad: string[] = [];
  for (const m of html.matchAll(/<button[\s\S]*?<\/button>/g)) {
    // 只看**内部**：m[0] 里必然含它自己的 `<button`，直接 includes 会永远命中
    const inner = m[0].replace(/^<button[^>]*>/, "").replace(/<\/button>$/, "");
    if (inner.includes("<a ") || inner.includes("<button")) bad.push(m[0]);
  }
  return bad;
}

describe("术语：把文字切成蓝词", () => {
  it("没有术语就原样输出，不多包一层", () => {
    expect(renderTerm("今天天气不错")).toBe("今天天气不错");
  });

  it("命中的词渲染成按钮，默认收起", () => {
    const html = renderTerm("滑点是什么");
    expect(html).toContain('class="term"');
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("滑点");
    // 没点开就不该有解释
    expect(html).not.toContain("term-panel");
  });

  it("按钮上带一句短释义做 title（悬停也能看到）", () => {
    const html = renderTerm("滑点是什么");
    const term = TERMS.find((t) => t.id === "滑点");
    expect(html).toContain(`title="${term?.short}"`);
  });

  it("一个词出现两次就是两个按钮", () => {
    const html = renderTerm("涨停了，涨停");
    expect((html.match(/class="term"/g) ?? []).length).toBe(2);
  });

  it("静态渲染时全部收起的那一刻不产生嵌套可交互元素", () => {
    const html = renderTerm("T+1、滑点、涨停、可卖数量，一次全来");
    expect(buttonsWithNestedInteractive(html)).toEqual([]);
  });
});

describe("术语：词条里的加粗", () => {
  it("**x** 变成 <strong>，星号不漏给玩家", () => {
    const html = renderToStaticMarkup(createElement("span", null, rich("按**开盘价**成交")));
    expect(html).toBe("<span>按<strong>开盘价</strong>成交</span>");
  });

  it("没有星号就原样返回字符串", () => {
    expect(rich("普通一句话")).toBe("普通一句话");
  });

  it("词典里每一条的解释渲染后都不含残留星号", () => {
    for (const t of TERMS) {
      const html = renderToStaticMarkup(createElement("span", null, rich(t.full)));
      expect(html.includes("**"), `${t.id} 的解释里有没配对的星号`).toBe(false);
    }
  });
});

describe("那一天的资讯", () => {
  it("渲染标题列表，每条带原文链接", () => {
    const html = renderDayNews();
    expect(html).toContain("那一天的资讯");
    expect(html).toContain("央行开展1.2万亿元逆回购操作");
    expect(html).toContain("沪指收盘下跌7.72%");
    expect((html.match(/查看原文/g) ?? []).length).toBe(2);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it("链接在按钮外面（非法嵌套会被浏览器拆开）", () => {
    const html = renderDayNews();
    expect(buttonsWithNestedInteractive(html)).toEqual([]);
  });

  it("声明不标注利好利空，和实时资讯同一条红线", () => {
    const html = renderDayNews();
    expect(html).toContain("不标注利好利空");
    for (const w of ["利好", "利空", "看涨", "看跌", "建议买"]) {
      expect(html.includes(`>${w}<`), `不应出现 ${w}`).toBe(false);
    }
  });

  it("正在拉的时候说「正在找」，不说「没有」", () => {
    const html = renderDayNews({ loading: true, items: [] });
    expect(html).toContain("正在找这一天的资讯");
    expect(html).not.toContain("没有抓到");
  });

  it("确实没有这一天时明说没抓到，并且强调不拿别处凑数", () => {
    const html = renderDayNews({ missing: true, items: [] });
    expect(html).toContain("没有抓到");
    expect(html).toContain("缺着的就不补");
    expect(html).not.toContain("正在找");
  });

  it("藏日期的模式用传进来的 mask 过一遍标题", () => {
    const html = renderDayNews({
      items: [{ title: "2月3日A股大跌", url: "https://x.dev/1.shtml" }],
      mask: (t) => t.replace(/2月3日/g, "当天"),
    });
    expect(html).toContain("当天A股大跌");
    expect(html).not.toContain("2月3日");
  });

  it("来源写在副标题里", () => {
    expect(renderDayNews()).toContain("来自新浪财经首页归档");
  });
});

describe("AI 问答是可选入口：没配代理就整块不出现", () => {
  /**
   * 用户拍板的一条：**绝不能有「看着能问、点了说没接通」的假入口**。
   * 判断标准不是「按钮能不能点」，而是「设了地址才渲染出这个按钮」。
   *
   * 直接测 `AskBox` 而不是 `TermPanel`：面板静态渲染停在「一句话」那一档，
   * 提问框要展开完整解析才出现 —— 测面板会得到一条看着通过、其实什么都没验的断言。
   */
  const term = TERMS.find((t) => t.id === "滑点") ?? TERMS[0]!;
  const renderAsk = () =>
    renderToStaticMarkup(createElement(AskBox, { term: term.id, context: `${term.id}：${term.full}` }));

  it("没配地址：整块渲染成空字符串", () => {
    saveHisuiSettings(NO_HISUI);
    resetHisui();
    expect(renderAsk()).toBe("");
  });

  it("地址不是 https：照样整块不出现", () => {
    saveHisuiSettings({ endpoint: "http://hisui.example.com/ask" });
    resetHisui();
    expect(renderAsk()).toBe("");
    saveHisuiSettings(NO_HISUI);
    resetHisui();
  });

  it("配了 https 地址：才出现提问框", () => {
    saveHisuiSettings({ endpoint: "https://hisui.example.com/ask" });
    resetHisui();
    try {
      const html = renderAsk();
      expect(html).toContain("问交易员");
      expect(html).toContain("input");
    } finally {
      saveHisuiSettings(NO_HISUI);
      resetHisui();
    }
  });
});
