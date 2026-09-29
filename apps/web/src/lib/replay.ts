/**
 * 历史推演的网页侧适配层。
 *
 * `@aw/game` 的 replay.ts 是纯引擎，它不知道快照长什么样、也不知道 localStorage 是什么。
 * 这里负责三件事：把快照翻译成 `ReplayConfig`、把进度存/取到 localStorage、以及
 * 决定「哪些东西该给玩家看」（比如模式 3 不显示日期）。
 */
import {
  advanceDay,
  advanceDays,
  cancelOrder,
  createReplay,
  jumpTo,
  pickRandomStartIndex,
  placeOrder,
  replayDate,
  replayPrices,
  settleReplay,
  MIN_REPLAY_DAYS,
  type Account,
  type EquityPoint,
  type PendingOrder,
  type ReplayConfig,
  type ReplayInstrument,
  type ReplayLogEntry,
  type ReplayState,
  type SeasonResult,
  type Side,
} from "@aw/game";
import type { Snapshot, StockData as CoreStock } from "@aw/core";

export const LS_REPLAY = "aw.replay.v1";

/**
 * 存档里**不放行情**。
 *
 * 一份 120 天 × 600 只股票的行情表有五六十万个数字，塞进 localStorage 会直接爆掉配额；
 * 而且行情是只读的、每次都能从快照还原，存它没有任何意义。
 * 所以只存「怎么重建」：起始位置、资金、参与标的，加上真正的进度（账户、委托、净值）。
 */
export interface ReplaySave {
  version: 1;
  mode: "random" | "legend";
  /** 模式 3（随机）默认不显示日期，模式 2（传奇）显示 */
  hideDate: boolean;
  startIndex: number;
  initialCash: number;
  /** 参与标的的代码；空数组表示快照里的全部股票 */
  codes: string[];
  label: string;
  dayIndex: number;
  account: Account;
  pending: PendingOrder[];
  equity: EquityPoint[];
  log: ReplayLogEntry[];
  finished: boolean;
  seq: number;
}

/** 快照里有没有开盘价——没有就做不了历史推演（不能拿收盘价冒充开盘价） */
export function replayAvailable(snapshot: Snapshot): boolean {
  return snapshot.stocks.some((s) => (s.open ?? []).some((v) => v !== null && v !== undefined));
}

/** 网页里正在进行的一局推演：引擎状态 + 只影响「怎么展示」的元信息 */
export interface ReplaySession {
  state: ReplayState;
  mode: "random" | "legend";
  /** 模式 3（随机）藏日期，模式 2（传奇）显示 */
  hideDate: boolean;
  /** 参与标的，用于重建配置 */
  codes: string[];
  label: string;
}

/** 沪深300 在本快照里的收盘价序列 */
function benchmarkSeries(snapshot: Snapshot): Array<number | null> | undefined {
  const idx = snapshot.indices.find((i) => i.code === "000300.SH") ?? snapshot.indices[0];
  return idx?.close;
}

export function toInstruments(stocks: CoreStock[]): ReplayInstrument[] {
  return stocks.map((s) => ({
    code: s.code,
    name: s.name,
    isST: s.isST,
    // 快照可能比引擎老（没有 open 这一列）。缺就整列 null，
    // 让每一笔委托都明确地「没有开盘价、无法成交」，而不是悄悄用别的价格顶上。
    open: s.open ? [...s.open] : s.close.map(() => null),
    close: [...s.close],
    high: [...s.high],
    low: [...s.low],
    volume: [...s.volume],
  }));
}

export interface StartOptions {
  startIndex: number;
  initialCash: number;
  /** 参与标的；不传则用快照里的全部股票 */
  codes?: string[];
  label?: string;
}

/** 用快照拼出一个推演配置 */
export function buildReplayConfig(
  snapshot: Snapshot,
  calendar: string[],
  opts: StartOptions,
): ReplayConfig {
  const wanted = opts.codes && opts.codes.length > 0 ? new Set(opts.codes) : null;
  const stocks = wanted ? snapshot.stocks.filter((s) => wanted.has(s.code)) : snapshot.stocks;

  return {
    calendar: [...calendar],
    startIndex: opts.startIndex,
    initialCash: opts.initialCash,
    instruments: toInstruments(stocks),
    benchmarkClose: benchmarkSeries(snapshot),
    label: opts.label,
  };
}

/** 从快照开局。`rnd` 可注入，便于测试；默认随机。 */
export function startReplay(
  snapshot: Snapshot,
  calendar: string[],
  opts: { mode: "random" | "legend"; initialCash: number; codes?: string[]; startIndex?: number; runDays?: number; label?: string; rnd?: () => number },
): ReplayState {
  const startIndex = opts.startIndex
    ?? pickRandomStartIndex(calendar, opts.runDays ?? MIN_REPLAY_DAYS, opts.rnd ?? Math.random);
  const config = buildReplayConfig(snapshot, calendar, {
    startIndex,
    initialCash: opts.initialCash,
    codes: opts.codes,
    label: opts.label ?? (opts.mode === "random" ? "随机开局" : "传奇"),
  });
  return createReplay(config);
}

/** 把进度的「参数部分」与「状态部分」一起存下来 */
export function toSave(
  state: ReplayState,
  meta: { mode: "random" | "legend"; hideDate: boolean; codes?: string[] },
): ReplaySave {
  return {
    version: 1,
    mode: meta.mode,
    hideDate: meta.hideDate,
    startIndex: state.config.startIndex,
    initialCash: state.config.initialCash,
    codes: meta.codes ?? state.config.instruments.map((i) => i.code),
    label: state.config.label ?? "",
    dayIndex: state.dayIndex,
    account: state.account,
    pending: state.pending,
    equity: state.equity,
    log: state.log,
    finished: state.finished,
    seq: state.seq,
  };
}

export function parseReplaySave(raw: unknown): ReplaySave | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Partial<ReplaySave>;
  if (s.version !== 1 || typeof s.startIndex !== "number" || typeof s.dayIndex !== "number") return null;
  if (!Array.isArray(s.codes) || !s.account) return null;
  return {
    version: 1,
    mode: s.mode === "legend" ? "legend" : "random",
    hideDate: s.hideDate !== false,
    startIndex: s.startIndex,
    initialCash: s.initialCash ?? s.account.initialCash,
    codes: s.codes,
    label: s.label ?? "",
    dayIndex: s.dayIndex,
    account: s.account,
    pending: s.pending ?? [],
    equity: s.equity ?? [],
    log: s.log ?? [],
    finished: s.finished === true,
    seq: s.seq ?? 0,
  };
}

/** 从 localStorage 的原始字符串还原存档。坏数据一律当没有存档，不要抛异常毁掉整个页面。 */
export function readReplaySave(raw: string | null): ReplaySave | null {
  if (!raw) return null;
  try {
    return parseReplaySave(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * 用存档 + 当前快照还原一局。
 *
 * 快照换了一版（比如又跑了一次每日快照）时，日历长度可能与存档对不上——
 * 那就把 dayIndex 夹回合法范围而不是丢弃存档：玩家的成交记录比日历对齐重要得多。
 */
export function restoreReplay(snapshot: Snapshot, calendar: string[], save: ReplaySave): ReplayState | null {
  if (!replayAvailable(snapshot)) return null;
  const config = buildReplayConfig(snapshot, calendar, {
    startIndex: save.startIndex,
    initialCash: save.initialCash,
    codes: save.codes,
    label: save.label,
  });
  const base = createReplay(config);
  const dayIndex = Math.min(Math.max(save.dayIndex, config.startIndex), Math.max(0, calendar.length - 1));
  const date = calendar[dayIndex] ?? "";

  return {
    ...base,
    dayIndex,
    account: save.account,
    pending: save.pending,
    equity: save.equity.length > 0 ? save.equity : [{ date, total: save.account.cash }],
    log: save.log,
    finished: save.finished || dayIndex >= calendar.length - 1,
    seq: save.seq,
  };
}

/** 参与推演的股票（按快照顺序）。推演里不包含指数与 ETF——先只做股票。 */
export function replayStocks(snapshot: Snapshot): CoreStock[] {
  return snapshot.stocks;
}

/** 玩家看到的「第几天」。模式 3 藏日期，但天数照给，否则玩家会失去进度感。 */
export function displayDate(state: ReplayState, hideDate: boolean): string {
  const index = state.dayIndex - state.config.startIndex + 1;
  return hideDate ? `第 ${index} 天` : replayDate(state);
}

/**
 * 把某个交易日换成「第 N 天」。
 *
 * 模式 3 的规则是不显示日期，但日期会从很多缝里漏出去：日志句子以日期开头、
 * 委托记着挂单那天、结算的赛季名叫「随机开局 · 2026-05-28」。
 * 只要还想藏，这些地方就都得过一遍这个函数。
 */
export function maskDate(state: ReplayState, date: string, hideDate: boolean): string {
  if (!hideDate) return date;
  const i = state.config.calendar.indexOf(date);
  return i < 0 ? "第 ? 天" : `第 ${i - state.config.startIndex + 1} 天`;
}

/** 替换一段文字里出现的所有日期（引擎生成的日志句子就是这样） */
export function maskDatesIn(state: ReplayState, text: string, hideDate: boolean): string {
  if (!hideDate) return text;
  return text.replace(/\d{4}-\d{2}-\d{2}/g, (d) => maskDate(state, d, true));
}

export { advanceDay, advanceDays, cancelOrder, jumpTo, placeOrder, replayDate, replayPrices, settleReplay };
export type { ReplayState, SeasonResult, Side, EquityPoint };
