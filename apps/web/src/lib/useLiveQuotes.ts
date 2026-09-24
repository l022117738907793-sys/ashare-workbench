/**
 * 实时行情轮询 hook。
 *
 * 行为（对应需求里的实时刷新约束）：
 * - **只轮询传进来的可见标的**（当前个股 + 屏幕上板块的强势成分 + 漏斗顶层），绝不轮询全池；
 * - 交易中按 `intervalMs`（3~5 秒）轮询；
 * - **休市时也拉一次**：行情接口收盘后返回的就是当日收盘价，比快照新。
 *   保证"收盘后 / 周末 / 节假日打开页面，看到的也是最新一个交易日的价格"，而不是旧快照；
 * - 休市期间的其余探测只做时段判断、不发请求，用 `setTimeout(msUntilNextOpen())` 重新武装；
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
/** 兜底探测上限：快照日历以"最后一个交易日"结尾，收盘后 `msUntilNextOpen()` 找不到
 *  下一个交易日时会返回 24 小时兜底值。这里把等待切成 ≤30 分钟一段，
 *  保证隔夜挂着的页面在开盘后 30 分钟内也能自动恢复轮询。
 *  非交易时段的每次探测都**只做时段判断、不发任何行情请求**，所以没有额外流量。 */
const MAX_PROBE_MS = 30 * 60_000;
const ERROR_BACKOFF_MS = 15_000;
/** 休市时的取数间隔。收盘后接口返回的是当日收盘价，半小时问一次足够，
 *  既能让"收盘后打开页面"看到最新价，又不会给接口添流量。 */
const CLOSED_REFRESH_MS = 30 * 60_000;

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
  /** 最近一次成功取数的时刻；休市时用它限流，避免每轮探测都发请求 */
  const lastOkAtRef = useRef<number | null>(null);
  const refresh = useCallback(() => {
    tickRef.current?.();
  }, []);

  useEffect(() => {
    if (!enabled || codeKey === "") {
      setState((s) => ({ ...s, polling: false, nextProbeAt: null }));
      tickRef.current = null;
      return;
    }

    // 每次「进入页面 / 换标的 / 手动刷新」都重新武装一次：下次 tick 必定真的取数
    lastOkAtRef.current = null;

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
      const delay = Math.min(MAX_TIMEOUT, Math.max(MIN_PROBE_MS, Math.min(wait, MAX_PROBE_MS)));
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
      const trading = isTradingNow(now, calendarRef.current);

      // 休市 ≠ 没数据可拿：行情接口收盘后返回的就是当日收盘价。
      // 隔一段时间拉一次，页面才不会一直停在几天前的快照上。
      if (!trading) {
        const since =
          lastOkAtRef.current === null
            ? Number.POSITIVE_INFINITY
            : Date.now() - lastOkAtRef.current;
        if (since < CLOSED_REFRESH_MS) {
          scheduleProbe();
          return;
        }
      }

      setState((s) => ({ ...s, polling: trading, session, nextProbeAt: null }));
      const list = codesRef.current;
      if (list.length === 0) return;

      try {
        const result = await fetchQuotes(list, {
          timeoutMs: Math.max(5000, intervalMs + 2000),
          signal: ctrl.signal,
        });
        if (stopped) return;
        lastOkAtRef.current = Date.now();
        setState({
          result,
          updatedAt: Date.now(),
          error: null,
          session,
          polling: trading,
          nextProbeAt: null,
          today: beijingTime().iso,
        });
        // 交易中按秒轮询；休市则回到"下一次开盘 / 半小时后再看"
        if (trading) timer = setTimeout(() => void tick(), intervalMs);
        else scheduleProbe();
      } catch (err) {
        if (stopped) return;
        const msg = err instanceof Error ? err.message : String(err);
        setState((s) => ({ ...s, error: msg, session, polling: trading }));
        // 失败退避，别把限频的接口打爆
        if (trading) timer = setTimeout(() => void tick(), Math.max(ERROR_BACKOFF_MS, intervalMs * 3));
        else scheduleProbe();
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
