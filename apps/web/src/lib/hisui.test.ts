/**
 * 翡翠问答：只测不发疯的部分 —— 地址判断、存档解析、请求形状。
 *
 * 最要紧的一条是 `askHisui` **发了什么**。接入包 §5 要求按局裁剪上下文、
 * 过滤未来信息，那需要服务端按 runId 重建「此刻可见的事实」；本仓是纯静态
 * 站点，没有后端，所以这条要求的落实方式是**宁可不发**：只发屏幕上已经
 * 显示过的术语名和释义，不发账户、持仓、日期、行情。下面的断言就是在钉这条。
 */
import { describe, expect, it } from "vitest";
import {
  askHisui,
  getOpenRef,
  isUsableEndpoint,
  MOOD_CELL,
  NO_HISUI,
  parseHisuiSettings,
  resetHisui,
  setOpenRef,
  subscribeHisui,
} from "./hisui";

/** 记下请求，返回预设响应 */
function stubFetch(reply: { ok?: boolean; status?: number; body?: unknown }) {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return {
      ok: reply.ok ?? true,
      status: reply.status ?? 200,
      json: async () => reply.body,
    };
  }) as unknown as typeof fetch;
  return { f, seen };
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("翡翠：代理地址", () => {
  it("只认 https 的完整地址", () => {
    expect(isUsableEndpoint("https://my-proxy.example.com/ask")).toBe(true);
    expect(isUsableEndpoint("https://x.dev")).toBe(true);
    // 下面这些填了等于没填，必须当场挡掉，不能等点下去才报错
    expect(isUsableEndpoint("")).toBe(false);
    expect(isUsableEndpoint("   ")).toBe(false);
    expect(isUsableEndpoint("http://my-proxy.example.com/ask")).toBe(false);
    expect(isUsableEndpoint("my-proxy.example.com")).toBe(false);
    expect(isUsableEndpoint("https://")).toBe(false);
    expect(isUsableEndpoint("https://a b")).toBe(false);
  });

  it("没配过就是空的 —— 不猜、不给默认后端", () => {
    expect(NO_HISUI.endpoint).toBe("");
    expect(parseHisuiSettings(null).endpoint).toBe("");
    expect(parseHisuiSettings("").endpoint).toBe("");
  });

  it("存坏了就当没配过，不抛", () => {
    expect(parseHisuiSettings("{不是 json").endpoint).toBe("");
    expect(parseHisuiSettings("null").endpoint).toBe("");
    expect(parseHisuiSettings('{"endpoint":123}').endpoint).toBe("");
  });

  it("存过的地址读回来，两头的空格去掉", () => {
    expect(parseHisuiSettings('{"endpoint":" https://x.dev/ask "}').endpoint).toBe(
      "https://x.dev/ask",
    );
  });
});

describe("翡翠：同时只展开一个词", () => {
  it("订阅者收到通知，取消订阅后不再收到", () => {
    resetHisui();
    let n = 0;
    const off = subscribeHisui(() => {
      n += 1;
    });
    setOpenRef("a:滑点");
    expect(n).toBe(1);
    expect(getOpenRef()).toBe("a:滑点");
    off();
    setOpenRef("a:T+1");
    expect(n).toBe(1);
    expect(getOpenRef()).toBe("a:T+1");
    resetHisui();
    expect(getOpenRef()).toBeNull();
  });

  it("设成同一个值不发通知（不然每渲染一次就多一层通知）", () => {
    resetHisui();
    let n = 0;
    subscribeHisui(() => {
      n += 1;
    });
    setOpenRef("a:滑点");
    setOpenRef("a:滑点");
    expect(n).toBe(1);
    resetHisui();
  });
});

describe("翡翠：问一句", () => {
  it("POST 出去只带术语名、已审核释义、玩家自己的问题", async () => {
    const { f, seen } = stubFetch({ body: { mood: "explain", answer: "少爷，滑点是……" } });
    const got = await askHisui({
      endpoint: "https://proxy.example.com/ask",
      term: "滑点",
      context: "滑点：显示价和成交价差的那一点点。",
      question: "为什么会差？",
      fetchImpl: f,
    });
    expect(got.answer).toContain("滑点");
    expect(got.mood).toBe("explain");

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://proxy.example.com/ask");
    expect(seen[0].init?.method).toBe("POST");
    const body = bodyOf(seen[0].init);
    // 请求体就这三个键 —— 没有账户、没有持仓、没有日期、没有行情
    expect(Object.keys(body).sort()).toEqual(["context", "question", "term"]);
    expect(body.term).toBe("滑点");
  });

  it("非法 mood 退回 explain，不把奇怪的词塞进表情表", async () => {
    const { f } = stubFetch({ body: { mood: "生气", answer: "……" } });
    const got = await askHisui({ endpoint: "https://x.dev/a", question: "q", fetchImpl: f } );
    expect(got.mood).toBe("explain");
    expect(Object.keys(MOOD_CELL)).toContain(got.mood);
  });

  it("回答太长截到 600 字（一屏塞不下，也防止代理失控）", async () => {
    const { f } = stubFetch({ body: { mood: "explain", answer: "啊".repeat(2000) } });
    const got = await askHisui({ endpoint: "https://x.dev/a", question: "q", fetchImpl: f } );
    expect(got.answer.length).toBe(600);
  });

  it("HTTP 失败直接抛，让界面去说「没问上」", async () => {
    const { f } = stubFetch({ ok: false, status: 502 });
    await expect(
      askHisui({ endpoint: "https://x.dev/a", question: "q", fetchImpl: f } ),
    ).rejects.toThrow("HTTP 502");
  });

  it("回了空字符串也算失败 —— 界面上不该出现一个空的翡翠气泡", async () => {
    const { f } = stubFetch({ body: { mood: "explain", answer: "   " } });
    await expect(
      askHisui({ endpoint: "https://x.dev/a", question: "q", fetchImpl: f } ),
    ).rejects.toThrow("空回答");
  });
});
