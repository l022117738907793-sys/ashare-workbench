/**
 * 新闻数据层。
 *
 * 设计要点：
 * 1. **区分「实时新闻」与「历史新闻」** —— 实测结论：
 *    - 实时：东财 7x24 快讯，CORS `*`，浏览器可直连
 *    - 历史：**只有新闻联播文字稿（2016-06 至今）能按日期取**，
 *      且需要预先抓取成静态数据（央视页面不是 API，且很慢）
 * 2. 实时新闻走这里；历史新闻由快照生成脚本预抓，作为静态资源分发。
 * 3. 任何取不到的情况都**明确返回空**，绝不用编造的新闻填充。
 *
 *   npx vite-node scripts/verify-news.ts   # 可实测验证
 */
import type { NewsItem, NewsProvider } from "./news-types";

export { type NewsItem, type NewsProvider } from "./news-types";

/**
 * ⚠️ 东财 7x24 —— **在浏览器里会被反爬拦截**。
 *
 * 实测（2026-09-23）：
 *   Origin: https://<自己的站点>  → HTTP 567（反爬验证页）
 *   Origin: https://np-weblist.eastmoney.com → HTTP 200
 *
 * 也就是说它虽然有 `Access-Control-Allow-Origin: *` 头，
 * 但对**第三方 Origin 直接返回反爬页**。所以不能作为纯前端的主力源，
 * 仅作为兜底保留（将来若放宽即可生效）。
 */
const EM_724 =
  "https://np-weblist.eastmoney.com/comm/web/getFastNewsList" +
  "?client=web&biz=web_724&fastColumn=102&sortEnd=&req_trace=1";

interface EmFastNews {
  code?: string;
  showTime?: string;
  title?: string;
  digest?: string;
  summary?: string;
}

/** 东财返回的时间是 `YYYY-MM-DD HH:mm:ss`（北京时间），显式按 UTC+8 换算 */
function parseBeijingTime(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s.trim());
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +(m[6] ?? 0));
}

/**
 * 同花顺快讯 —— **当前的主力源**。
 *
 * 实测（2026-09-23）：HTTP 200、`Access-Control-Allow-Origin: *`、
 * `Content-Type: application/json`，带第三方 Origin 也正常返回。
 *
 * 注意：返回字段里有 `nature` / `color`（疑似情绪标记）。
 * **本项目不使用它们** —— 新闻只作原文展示，不标利好利空。
 */
const THS_PUSH =
  "https://news.10jqka.com.cn/tapp/news/push/stock/?page=1&tag=&track=website&pagesize=";

/**
 * ⚠️ 同花顺返回的**所有字段都是字符串**（实测确认），
 * 包括 id、ctime、rtime。不要按数字处理。
 */
interface ThsItem {
  id?: string | number;
  title?: string;
  digest?: string;
  url?: string;
  /** 发布时间，Unix **秒**，但以字符串形式返回 */
  ctime?: string | number;
  rtime?: string | number;
  source?: string;
}

/** 把「可能是字符串的数字」安全转成 number */
function numOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export const tonghuashunNewsProvider: NewsProvider = {
  name: "tonghuashun",

  isSupported() {
    return typeof fetch === "function";
  },

  async fetchLatest(limit = 30): Promise<NewsItem[]> {
    const url = `${THS_PUSH}${Math.max(1, Math.min(50, limit))}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`同花顺快讯 HTTP ${res.status}`);

    const json = (await res.json()) as {
      code?: number | string;
      msg?: string;
      data?: { list?: ThsItem[] } | null;
    };
    // 两个坑（都实测踩过）：
    //   1. 同花顺用「200」表示成功（仿 HTTP 语义），不是 0；
    //   2. 而且它是**字符串** "200"，不是数字 200 —— `=== 200` 会失败。
    const raw = json.code;
    const codeNum = typeof raw === "string" ? Number(raw) : raw;
    const codeOk = raw === undefined || codeNum === 0 || codeNum === 200;
    if (!codeOk) {
      throw new Error(`同花顺返回 code=${String(raw)}${json.msg ? ` (${json.msg})` : ""}`);
    }
    const list = json.data?.list ?? [];

    return list
      .map((it): NewsItem | null => {
        const title = (it.title || it.digest || "").trim();
        if (!title) return null;
        // ctime/rtime 是 Unix 秒，但以**字符串**返回（实测）。
        // 缺了就别假装知道时间 —— timeKnown 会是 false。
        const sec = numOf(it.ctime) ?? numOf(it.rtime);
        const at = sec !== null && sec > 0 ? sec * 1000 : 0;
        return {
          id: String(it.id ?? `${sec ?? "x"}-${title.slice(0, 16)}`),
          title,
          digest: (it.digest || "").trim(),
          at,
          source: "同花顺快讯",
          url: it.url,
          timeKnown: at > 0,
        };
      })
      .filter((x): x is NewsItem => x !== null)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  },
};

export const eastmoneyNewsProvider: NewsProvider = {
  name: "eastmoney-724",

  isSupported() {
    return typeof fetch === "function";
  },

  async fetchLatest(limit = 30): Promise<NewsItem[]> {
    const url = `${EM_724}&pageSize=${Math.max(1, Math.min(100, limit))}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`东财快讯 HTTP ${res.status}`);

    const json = (await res.json()) as {
      code?: number;
      data?: { fastNewsList?: EmFastNews[] } | null;
    };
    const list = json.data?.fastNewsList ?? [];

    return list
      .map((it): NewsItem | null => {
        const title = (it.title || it.digest || it.summary || "").trim();
        if (!title) return null;
        const at = parseBeijingTime(it.showTime);
        return {
          id: it.code ?? `${it.showTime ?? ""}-${title.slice(0, 20)}`,
          title,
          digest: (it.digest || it.summary || "").trim(),
          at: at ?? 0,
          source: "东方财富 7x24",
          /** 时间解析失败时标出来，UI 不要显示 "1970-01-01" */
          timeKnown: at !== null,
        };
      })
      .filter((x): x is NewsItem => x !== null)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  },
};

/**
 * 默认新闻链。
 *
 * 顺序依据实测（带第三方 Origin 的真实浏览器场景）：
 *   同花顺 → 可用（CORS `*`，第三方 Origin 也放行）
 *   东财   → 被反爬拦截（HTTP 567），仅作兜底
 *   新浪   → 数据可用但**无 CORS 头**，浏览器读不到，故不纳入
 */
export const DEFAULT_NEWS_CHAIN: NewsProvider[] = [tonghuashunNewsProvider, eastmoneyNewsProvider];

export interface FetchNewsResult {
  items: NewsItem[];
  source: string | null;
  /** 降级或失败原因；成功时为 null */
  degradedReason: string | null;
}

/**
 * 取最新新闻。
 *
 * 与行情链一致的原则：**失败要明说**，返回空数组而不是编造内容。
 */
export async function fetchLatestNews(
  limit = 30,
  chain: NewsProvider[] = DEFAULT_NEWS_CHAIN,
): Promise<FetchNewsResult> {
  const failures: string[] = [];
  for (const p of chain) {
    if (!p.isSupported()) {
      failures.push(`${p.name}: 当前环境不支持`);
      continue;
    }
    try {
      const items = await p.fetchLatest(limit);
      if (items.length === 0) {
        failures.push(`${p.name}: 无返回`);
        continue;
      }
      return {
        items,
        source: p.name,
        degradedReason: failures.length > 0 ? `已降级到 ${p.name}：${failures.join("；")}` : null,
      };
    } catch (err) {
      failures.push(`${p.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { items: [], source: null, degradedReason: failures.join("；") || "无可用新闻源" };
}

/**
 * 新闻与股票的相关性粗筛。
 *
 * 注意：这是**关键词匹配**，不是语义理解。它的用途是"把可能相关的挑出来给玩家看"，
 * 而不是"判断利好利空" —— 后者本项目不做，也做不到。
 */
export function matchNewsToStock(items: NewsItem[], name: string, code: string): NewsItem[] {
  const num = code.split(".")[0];
  return items.filter((n) => {
    const text = `${n.title} ${n.digest}`;
    return text.includes(name) || text.includes(num) || text.includes(code);
  });
}
