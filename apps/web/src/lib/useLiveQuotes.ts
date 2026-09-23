/**
 * 实时行情轮询 hook。
 *
 * 行为（对应需求里的实时刷新约束）：
 * - **只轮询传进来的可见标的**（当前个股 + 屏幕上板块的强势成分 + 漏斗顶层），绝不轮询全池；
 * - 仅在 `isTradingNow()` 为真时按 `intervalMs`（3~5 秒）轮询；
 * - 非交易时段**不发请求**，用一次 `setTimeout(msUntilNextOpen())` 重新武装；
 * - `document.visibilityState !== "visible"` 时暂停，`visibilitychange` 时恢复；
 * - 失败不隐藏：错误原文进 `error`，由 UI 显示成非惊悚提示条。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  beijingTime,
  fetchQuotes,
  isTradingNow,
  msUntilNextOpen,
  sessionState,
  type QuoteResult,
  type SessionState,
} from "@aw/data";

const MAX_TIMEOUT = 2_147_483_000;
const MIN_PROBE_MS = 30_000;
const ERROR_BACKOFF_MS = 15_000;

export interface LiveQuotesState {
  /** 最近一次成功结果；从未成功时为 null */
  result: QuoteResult | null;
  /** 最近一次成功取数的本地时间戳 */
  updatedAt: number | null;
  /** 最近一次失败原因（原文，不美化） */
  error: string | null;
  /** 当前交易时段 */
  session: SessionState;
  /** 是否正在按秒轮询（false = 已停，等下一次开盘或页面可见） */
  polling: boolean;
  /** 非交易时段：下一次自动探测的时间戳 */
  nextProbeAt: number | null;
  /** 最近一次成功取数时的北京时间日期（用于 applyLivePrices 的 today） */
  today: string;
}

export interface UseLiveQuotesOptions {
  intervalMs: number;
  calendar?: string[];
  enabled?: boolean;
  /** 变化即立刻重启轮询（手动刷新按钮） */
  nonce?: number;
}

export function useLiveQuotes(codes: string[], options: UseLiveQuotesOptions): LiveQuotesState {
  const { intervalMs, calendar, enabled = true, nonce = 0 } = options;
  const codeKey = codes.join("|");
  const calendarKey = calendar && calendar.length > 0 ? calendar.join("|") : "";

  const codesRef = useRef(codes);
  codesRef.current = codes;
  const calendarRef = useRef<string[] | undefined>(calendar);
  calendarRef.current = calendar;

  const [state, setState] = useState<LiveQuotesState>(() => ({
    result: null,
    updatedAt: null,
    error: null,
    session: sessionState(new Date(), calendar),
    polling: false,
    nextProbeAt: null,
    today: beijingTime().iso,
  }));

  const tickRef = useRef<(() => void) | null>(null);
  const refresh = useCallback(() => {
    tickRef.current?.();
  }, []);

  useEffect(() => {
    if (!enabled || codeKey === "") {
      setState((s) => ({ ...s, polling: false, nextProbeAt: null }));
      tickRef.current = null;
      return;
    }

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ctrl = new AbortController();

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    function scheduleProbe() {
      const now = new Date();
      const wait = msUntilNextOpen(now, calendarRef.current);
      const delay = Math.min(MAX_TIMEOUT, Math.max(MIN_PROBE_MS, wait));
      setState((s) => ({
        ...s,
        polling: false,
        session: sessionState(now, calendarRef.current),
        nextProbeAt: Date.now() + delay,
      }));
      timer = setTimeout(() => void tick(), delay);
    }

    async function tick() {
      clearTimer();
      if (stopped) return;

      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        // 页面不可见：完全暂停，等 visibilitychange 唤醒
        setState((s) => ({ ...s, polling: false }));
        return;
      }

      const now = new Date();
      const session = sessionState(now, calendarRef.current);
      if (!isTradingNow(now, calendarRef.current)) {
        scheduleProbe();
        return;
      }

      setState((s) => ({ ...s, polling: true, session, nextProbeAt: null }));
      const list = codesRef.current;
      if (list.length === 0) return;

      try {
        const result = await fetchQuotes(list, {
          timeoutMs: Math.max(5000, intervalMs + 2000),
          signal: ctrl.signal,
        });
        if (stopped) return;
        setState({
          result,
          updatedAt: Date.now(),
          error: null,
          session,
          polling: true,
          nextProbeAt: null,
          today: beijingTime().iso,
        });
        timer = setTimeout(() => void tick(), intervalMs);
      } catch (err) {
        if (stopped) return;
        const msg = err instanceof Error ? err.message : String(err);
        setState((s) => ({ ...s, error: msg, session, polling: true }));
        // 失败退避，别把限频的接口打爆
        timer = setTimeout(() => void tick(), Math.max(ERROR_BACKOFF_MS, intervalMs * 3));
      }
    }

    tickRef.current = () => void tick();

    const onVisibility = () => {
      if (stopped) return;
      if (document.visibilityState === "visible") {
        clearTimer();
        void tick();
      } else {
        clearTimer();
        setState((s) => ({ ...s, polling: false }));
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    void tick();

    return () => {
      stopped = true;
      ctrl.abort();
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibility);
      tickRef.current = null;
    };
  }, [codeKey, calendarKey, enabled, intervalMs, nonce]);

  return { ...state, refresh } as LiveQuotesState & { refresh: () => void };
}
