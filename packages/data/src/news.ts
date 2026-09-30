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
/**
 * 每个 provider 多要几条，留给上层的去重。
 *
 * 实测重复率只有 0.2%，所以 10 条余量已经远超需要 —— 它主要防的是
 * 「碰巧撞上一条重复，列表就少一条」这种偶发，不是常态。
 */
const DEDUPE_HEADROOM = 10;

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
    // 多要一点：上层 fetchLatestNews 会先去重再裁到 limit，
    // 正好要 limit 条的话，去掉一条重复就少一条
    const want = limit + DEDUPE_HEADROOM;
    const url = `${THS_PUSH}${Math.max(1, Math.min(50, want))}`;
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
      .slice(0, want);
  },
};

export const eastmoneyNewsProvider: NewsProvider = {
  name: "eastmoney-724",

  isSupported() {
    return typeof fetch === "function";
  },

  async fetchLatest(limit = 30): Promise<NewsItem[]> {
    const want = limit + DEDUPE_HEADROOM;
    const url = `${EM_724}&pageSize=${Math.max(1, Math.min(100, want))}`;
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
      .slice(0, want);
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
 * 标题归一化：去掉空白和标点，只留字和数字。
 *
 * 同一家媒体同一条稿子两次推送，标题不会差在标点上；差在标点上的那两条
 * 往往是不同版本，不该合并。所以这里只抹掉那些**对意思没有贡献**的字符。
 */
function normTitle(title: string): string {
  return title.replace(/[\s\u3000]/g, "").replace(/[，。！？；：、""''（）()【】\[\]·—…\-–,.!?;:'"]/g, "");
}

/**
 * 去掉重复的新闻，保留每组里**最新的那一条**（`items` 约定为新→旧）。
 *
 * 先量后改：拿 1000 条真实快讯（20 页 × 50 条）数过 ——
 * - 标题完全相同的：**2 组 4 条（0.2%）**
 * - 同一 `id` 出现两次的：**0 次**
 *
 * 所以这个函数很小。它治的不是「刷屏」（刷屏并不存在），是那 0.2%，
 * 以及让下游（面板、审计脚本、将来的任何消费者）不用各自再防一遍。
 *
 * **刻意不做「一条标题包含另一条就算重复」。** 实测 1000 条里只有 1 对这种形状，
 * 而且那一对是两条不同的新闻：
 *   「中国贸促会2026年APEC工商领导人峰会筹备工作进展顺利」
 *   「2026年APEC工商领导人峰会筹备工作进展顺利」
 * 合并它们等于凭空删掉一条真新闻 —— 风险远大于收益。
 */
export function dedupeNews(items: NewsItem[]): NewsItem[] {
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  const out: NewsItem[] = [];
  for (const it of items) {
    const key = normTitle(it.title);
    if (it.id && seenIds.has(it.id)) continue;
    // 标题为空的不参与标题去重（否则所有空标题会被并成一条）
    if (key && seenTitles.has(key)) continue;
    if (it.id) seenIds.add(it.id);
    if (key) seenTitles.add(key);
    out.push(it);
  }
  return out;
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
        // 去重放在这里，所有消费者自动受益。
        // provider 已经按 limit + DEDUPE_HEADROOM 多要过，所以裁完通常还是 limit 条
        items: dedupeNews(items).slice(0, limit),
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
 * 公司名被这些词吞掉时，就不是在说这家公司了。
 *
 * 全部来自实测：`scripts/audit-news-match.ts` 拿 800 条真实快讯 × 619 个真实股票名
 * 跑出来的误命中，只有这一种形状 —— **名字后面接着几个字，凑成了另一个词**：
 *
 *   中国银行  →  中国银【行业】对外金融资产      （说的是银行业，不是中国银行）
 *   上海银行  →  上海银【行间】同业拆放利率      （说的是 Shibor，不是上海银行）
 *   中国石油  →  中国石油【化工】股份            （说的是中国石化 600028，不是中国石油 601857）
 *
 * 判据是「从匹配位置开始的文本是否以某个词开头」，而不是「名字后面跟了什么字」——
 * 后者会误伤：`业` 后面如果是 `绩`（万科A业绩预告），那说的正是这家公司。
 * 所以这里列的是**完整的词**，判据也只有一条：这些词一旦出现，名字就不是名字了。
 *
 * 关键词匹配不可能全对。新增误命中时，把它加进这张表，并在 news.test.ts 里补一条用例。
 */
const GENERIC_PHRASES = [
  // 银行系：把「XX银行」吃成「银行业 / 银行间 / 银行家 / 银行学」
  "中国银行业",
  "银行业",
  "银行间",
  "银行家",
  "银行学",
  "中国人民银行",
  // 石化系：「中国石油」与「中国石化」是两家公司
  "中国石油化工",
  "石油化工",
];

/**
 * 新闻与股票的相关性粗筛。
 *
 * 注意：这是**关键词匹配**，不是语义理解。它的用途是"把可能相关的挑出来给玩家看"，
 * 而不是"判断利好利空" —— 后者本项目不做，也做不到。
 */
export function matchNewsToStock(items: NewsItem[], name: string, code: string): NewsItem[] {
  const num = code.split(".")[0] ?? "";
  // 6 位代码要卡住数字边界，否则 1000001 这种金额会把 000001 算成命中
  const numRe = num ? new RegExp(`(?<!\\d)${num}(?!\\d)`) : null;

  return items.filter((n) => {
    const text = `${n.title} ${n.digest}`;

    // 名字出现，且不是被另一个词吞掉的一部分。
    //
    // 判据是「有没有一个泛词和这次命中**重叠**」：泛词的起点落在 [i, i+len(name)) 里，
    // 就说明名字被它吃掉了。这样两种情况都能盖住：
    //   名字 + 完整泛词   中国银行[业]        → 泛词「银行业」从 i 开始
    //   名字的尾巴 + 泛词  上海银[行间]        → 泛词「银行间」从 i+2 开始
    // 而同一个泛词出现在名字**后面很远**的地方（「中国银行发公告，银行业承压」）
    // 起点 ≥ i+len(name)，不算重叠，名字照常命中。
    let i = text.indexOf(name);
    let nameHit = false;
    while (i >= 0) {
      const swallowed = GENERIC_PHRASES.some((p) => {
        const at = text.indexOf(p, i);
        return at >= 0 && at < i + name.length;
      });
      if (!swallowed) {
        nameHit = true;
        break;
      }
      i = text.indexOf(name, i + 1);
    }

    if (nameHit) return true;
    if (numRe?.test(text)) return true;
    return code !== "" && text.includes(code);
  });
}
