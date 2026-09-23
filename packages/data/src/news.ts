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

/** 东财 7x24 快讯。实测（2026-09-23）返回真实数据且 CORS 为 `*`。 */
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

/** 默认新闻链。将来接历史新闻时在这里追加。 */
export const DEFAULT_NEWS_CHAIN: NewsProvider[] = [eastmoneyNewsProvider];

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
