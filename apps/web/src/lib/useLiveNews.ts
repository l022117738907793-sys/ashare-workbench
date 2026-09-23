/**
 * 新闻轮询 hook。
 *
 * 与行情的 `useLiveQuotes` 分开，因为两者节奏完全不同：
 * 行情盘中要 3~5 秒刷，新闻几分钟刷一次就够 —— 用同一个 hook 会白白浪费请求。
 *
 * 三条原则（与行情链一致）：
 * 1. 失败不编造：取不到就报错，列表留空
 * 2. 页面不可见时不刷（省流量，也避免后台标签页被节流后堆积请求）
 * 3. 展示时必须带来源与时间
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchLatestNews, type NewsItem } from "@aw/data";

export interface LiveNewsState {
  items: NewsItem[];
  source: string | null;
  /** 降级或失败原因；正常时为 null */
  degradedReason: string | null;
  /** 最近一次成功刷新的时间戳 */
  updatedAt: number | null;
  loading: boolean;
  /** 手动刷新 */
  refresh: () => void;
}

export interface UseLiveNewsOptions {
  /** 是否启用（未开局或不在模拟盘页时关掉） */
  enabled: boolean;
  /** 刷新间隔，默认 3 分钟。新闻不需要秒级 */
  intervalMs?: number;
  /** 拉取条数，默认 40 */
  limit?: number;
}

export const DEFAULT_NEWS_INTERVAL_MS = 3 * 60 * 1000;

export function useLiveNews(options: UseLiveNewsOptions): LiveNewsState {
  const { enabled, intervalMs = DEFAULT_NEWS_INTERVAL_MS, limit = 40 } = options;

  const [items, setItems] = useState<NewsItem[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [degradedReason, setDegradedReason] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  /** 防止组件卸载后 setState */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const load = async () => {
      // 页面不可见时不请求 —— 后台标签页的定时器会被浏览器节流，
      // 与其让它堆积，不如回来时再刷
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      setLoading(true);
      try {
        const r = await fetchLatestNews(limit);
        if (cancelled || !alive.current) return;
        // 成功才覆盖：一次失败不应该把已有列表清空
        if (r.items.length > 0) {
          setItems(r.items);
          setSource(r.source);
          setUpdatedAt(Date.now());
        }
        setDegradedReason(r.degradedReason);
      } catch (e) {
        if (cancelled || !alive.current) return;
        setDegradedReason(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled && alive.current) setLoading(false);
      }
    };

    void load();
    timer = setInterval(() => void load(), intervalMs);

    const onVisible = () => {
      // 回到前台立刻补一次
      if (document.visibilityState === "visible") void load();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, [enabled, intervalMs, limit, nonce]);

  return { items, source, degradedReason, updatedAt, loading, refresh };
}
