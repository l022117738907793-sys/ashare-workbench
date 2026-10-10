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
  marketGroupOf,
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
  type Currency,
  type ConfigFx,
} from "@aw/game";
import type { Snapshot, StockData as CoreStock } from "@aw/core";

export const LS_REPLAY = "aw.replay.v1";

/**
 * 三种历史推演。
 *
 * - `legend` 传奇模式：行情来自 `history/level-<id>.json` 那份离线分片。
 * - `random` 随机模式：行情来自快照，起点随机，日期对玩家隐藏。
 * - `backtrack` 回溯模式：行情同样来自快照，但起点由玩家在最近一个月里指定，日期照实显示。
 *
 * 后两者共用一套从快照拼配置的代码（`startReplay`），差别只在起点怎么定、日期给不给看。
 */
export type ReplayMode = "random" | "legend" | "backtrack";

/**
 * 存档里**不放行情**。
 *
 * 一份 120 天 × 600 只股票的行情表有五六十万个数字，塞进 localStorage 会直接爆掉配额；
 * 而且行情是只读的、每次都能从快照还原，存它没有任何意义。
 * 所以只存「怎么重建」：起始位置、资金、参与标的，加上真正的进度（账户、委托、净值）。
 */
export interface ReplaySave {
  version: 1;
  mode: ReplayMode;
  /** 模式 3（随机）默认不显示日期，模式 2（传奇）显示 */
  hideDate: boolean;
  startIndex: number;
  initialCash: number;
  /** 参与标的的代码；空数组表示快照里的全部股票 */
  codes: string[];
  /**
   * 传奇模式（模式 2）的关卡 id。
   *
   * 传奇模式的行情**不来自快照**，而是来自 `history/level-<id>.json` 这份离线分片，
   * 所以还原这一局时必须知道是哪一关。null / 缺省 = 随机模式（模式 3），走快照还原。
   */
  levelId: string | null;
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
  mode: ReplayMode;
  /** 模式 3（随机）藏日期，模式 2（传奇）与回溯模式显示 */
  hideDate: boolean;
  /** 参与标的，用于重建配置 */
  codes: string[];
  label: string;
  /**
   * 传奇模式是哪一关（`LEVELS` 里的 id），随机模式为 null。
   *
   * 开局简报不单独存：它就是 `levelById(levelId)`，从 id 现查即可，
   * 存两份反而会出现「简报改了、存档里还是老的」。
   */
  levelId: string | null;
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
    industry: s.industry,
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
  opts: { mode: ReplayMode; initialCash: number; codes?: string[]; startIndex?: number; runDays?: number; label?: string; rnd?: () => number },
): ReplayState {
  const startIndex = opts.startIndex
    ?? pickRandomStartIndex(calendar, opts.runDays ?? MIN_REPLAY_DAYS, opts.rnd ?? Math.random);
  const config = buildReplayConfig(snapshot, calendar, {
    startIndex,
    initialCash: opts.initialCash,
    codes: opts.codes,
    label: opts.label ?? (opts.mode === "random" ? "随机开局" : opts.mode === "backtrack" ? "回溯" : "传奇"),
  });
  return createReplay(config);
}

// ── 回溯模式（模式 4）：在最近一个月里挑一天开始 ────────────────

/**
 * 回溯窗口有多长：22 个交易日 ≈ 一个自然月。
 *
 * 用交易日而不是自然日，是因为快照那几个数组本来就是按交易日排的 —— 说「最近 30 天」
 * 还得回头去数日历查有没有休市，而玩家关心的本来就是「还有几天可以玩」。
 */
export const BACKTRACK_DAYS = 22;

export interface BacktrackOption {
  /** 在快照日历里的下标，直接喂给 `startReplay` 的 `startIndex` */
  index: number;
  date: string;
  /** 从这天开始还能走几个交易日（含当天） */
  remaining: number;
}

/**
 * 回溯模式能选的起点：快照日历的最后 `days` 个交易日，**从早到晚**。
 *
 * 顺序是刻意的。玩家要的是「从哪天开始往后推」，从早到晚读下来就是时间线本身，
 * 也正好最长的一局排在第一个；倒过来排看着像新闻列表，反而要点最下面那条才玩得满。
 */
export function backtrackOptions(calendar: string[], days: number = BACKTRACK_DAYS): BacktrackOption[] {
  const total = calendar.length;
  if (total === 0) return [];
  const first = Math.max(0, total - days);
  const out: BacktrackOption[] = [];
  for (let i = first; i < total; i += 1) {
    out.push({ index: i, date: calendar[i], remaining: total - i });
  }
  return out;
}

/**
 * 回溯模式参与推演的标的：**只放 A 股**。
 *
 * 境外标的在快照里的价格是各自的本币，而账户是人民币记账的 —— 要进引擎就必须先折成
 * 人民币（见 `convertShardToCny`）。传奇模式的分片带着**每日**汇率序列，折得了；
 * 快照里 `meta.hk.fx` 只有一个**标量**（最新那一次报价），拿它铺满一个月等于猜。
 * 港币和人民币差一成多，猜错的后果是玩家的成本凭空少掉那么多，而界面上不会有任何提示 ——
 * 这正是这个仓库一贯拒绝的那种静默偏差。所以宁可这一屏只做 A 股，也不折算着跑。
 */
export function backtrackStocks(snapshot: Snapshot): CoreStock[] {
  return snapshot.stocks.filter((s) => marketGroupOf(s.code) === "CN");
}

/** 把进度的「参数部分」与「状态部分」一起存下来 */export function toSave(
  state: ReplayState,
  meta: { mode: ReplayMode; hideDate: boolean; codes?: string[]; levelId?: string | null },
): ReplaySave {
  return {
    version: 1,
    mode: meta.mode,
    hideDate: meta.hideDate,
    startIndex: state.config.startIndex,
    initialCash: state.config.initialCash,
    codes: meta.codes ?? state.config.instruments.map((i) => i.code),
    levelId: meta.levelId ?? null,
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
    // 认不出来的模式一律当随机：老存档没有这一项，写坏的存档也不该让整局丢掉。
    // 加了新模式就要在这里补一格，否则会被静默降级（回溯那一局会变成藏日期的随机局）。
    mode: s.mode === "legend" ? "legend" : s.mode === "backtrack" ? "backtrack" : "random",
    hideDate: s.hideDate !== false,
    startIndex: s.startIndex,
    initialCash: s.initialCash ?? s.account.initialCash,
    codes: s.codes,
    levelId: typeof s.levelId === "string" ? s.levelId : null,
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
  return applySave(config, calendar, save);
}

/**
 * 把存档里的「进度」盖回一个刚建好的空局上。
 *
 * 两件事必须小心：
 * 1. 快照/分片换了一版时日历长度可能对不上——把 dayIndex 夹回合法范围，
 *    而不是丢弃存档：玩家的成交记录比日历对齐重要得多。
 * 2. 账户、委托、日志、seq 全部原样搬过来，一行都不能重算——重算等于作弊。
 */
function applySave(config: ReplayConfig, calendar: string[], save: ReplaySave): ReplayState {
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
  return (
    text
      .replace(/\d{4}-\d{2}-\d{2}/g, (d) => maskDate(state, d, true))
      // 引擎的日志只写 ISO 日期，但关卡的新闻标题是中文写法（「2月3日」「2020年2月3日」）。
      // 随机模式要藏日期，这两种写法一样会漏，统一换掉。
      .replace(/(?:\d{4}年)?\d{1,2}月\d{1,2}日/g, () => "当天")
  );
}

// ── 传奇模式（模式 2）：关卡 ────────────────────────────────
//
// 和随机模式的根本区别：**行情不来自当前快照**。
// 关卡跑在 2016–2024 年，而快照只有最近 120 天，所以每关备好一份离线分片
// （`data/history/level-<id>.json`，由 scripts/build-history-shards.ts 生成，
// 部署时同步到站点的 `history/` 目录）。

/** 关卡分片放在站点根目录的 `history/`（构建产物，不随 dataBase 设置变） */
export const DEFAULT_HISTORY_BASE = "./history";

/** 关卡分片的结构，与 scripts/build-history-shards.ts 的输出一一对应 */
export interface LevelShard {
  levelId: string;
  startDate: string;
  days: number;
  calendar: string[];
  benchmark: { code: string; name: string; close: Array<number | null> };
  instruments: ReplayInstrument[];
  /**
   * 境外标的用的汇率序列（纯 A 股的关卡没有这一段）。
   *
   * 账户是人民币记账的，所以境外价格必须在进引擎之前折成人民币。
   * 缺了它就只能按本币计价，而港币和人民币差约 13%、美元差约 7 倍——
   * 见 `convertShardToCny`，那种情况会直接抛错而不是硬跑。
   */
  fx?: ShardFx[];
  note: string;
  generatedAt?: string;
}

/** 分片顶层的一条汇率：`currency` 兑人民币，与 `calendar` 等长 */
export interface ShardFx {
  currency: Currency;
  code: string;
  name: string;
  rate: Array<number | null>;
}

/** 分片合不合法。宁可当场说「没有这一关」，也不要拿半截数据开局。 */
export function isLevelShard(raw: unknown): raw is LevelShard {
  if (typeof raw !== "object" || raw === null) return false;
  const s = raw as Partial<LevelShard>;
  if (typeof s.levelId !== "string" || !Array.isArray(s.calendar) || s.calendar.length === 0) return false;
  if (!Array.isArray(s.instruments) || s.instruments.length === 0) return false;
  const n = s.calendar.length;
  // 每一列都必须与日历等长——引擎靠这个长度对齐，对不上会被当成「没有开盘价」
  const colsOk = s.instruments.every(
    (i) => Array.isArray(i.open) && i.open.length === n && Array.isArray(i.close) && i.close.length === n,
  );
  if (!colsOk) return false;
  // 汇率列同样必须与日历等长：短一格就会「第 k 天用错价」，而且不会报错
  if (s.fx !== undefined) {
    if (!Array.isArray(s.fx)) return false;
    if (!s.fx.every((f) => Array.isArray(f?.rate) && f.rate.length === n)) return false;
  }
  return true;
}

/** 折算后的价格保留 4 位小数：够精确到分，又不会拖一串浮点尾巴 */
function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/**
 * 把一条本币价格列折成人民币。
 *
 * 汇率缺的那一天（外盘开市、中行没报价）沿用**上一个已知汇率**——不是跳过，
 * 也不是按 1:1。整条序列从头就一次汇率都拿不到时返回 `null`，交给调用方拒绝开局。
 */
function cnyColumn(
  col: Array<number | null>,
  rate: Array<number | null>,
  firstRate: number,
): Array<number | null> {
  const out: Array<number | null> = [];
  let last: number = firstRate;
  for (let k = 0; k < col.length; k += 1) {
    const r = rate[k];
    if (typeof r === "number" && Number.isFinite(r) && r > 0) last = r;
    const v = col[k];
    out.push(v === null || v === undefined ? null : round4(v * last));
  }
  return out;
}

/**
 * 把分片里境外标的的价格折成人民币。**折算必须发生在数据进引擎之前。**
 *
 * 账户是人民币记账的（`Account.cash`、`Trade.amount`、`avgCost` 全是 ¥），
 * 折完之后 `price × shares === amount`、费用按 amount 算、跨标的求和的权益曲线
 * 这几条不变式一条都不用改，`replayPrices` 直接返回 ¥，四个 `totalAssets` 调用点
 * 也全都不用动。
 *
 * 代价是港美股的涨跌幅里会混进汇率变动。这不是 bug——一个持有美股的中国投资者，
 * 人民币口径的收益本来就把汇率算在内，界面上标注一句说明即可。
 *
 * 换不到汇率就**抛错**，不退回本币接着跑：那等于假装港币就是人民币，
 * 玩家看到的成本会凭空少 13%，而且全程没有任何提示。
 */
export function convertShardToCny(shard: LevelShard): LevelShard {
  const fx = shard.fx;
  const overseas = shard.instruments.filter((i) => i.currency && i.currency !== "CNY");
  if (overseas.length === 0) return shard;
  if (!fx || fx.length === 0) {
    throw new Error(`${shard.levelId} 里有境外标的，却没有汇率序列（fx），无法折成人民币`);
  }

  const byCurrency = new Map<Currency, Array<number | null>>();
  for (const f of fx) byCurrency.set(f.currency, f.rate);

  const instruments = shard.instruments.map((inst) => {
    const cur = inst.currency;
    if (!cur || cur === "CNY") return inst;
    const rate = byCurrency.get(cur);
    if (!rate) {
      throw new Error(`${shard.levelId} 的 ${inst.code} 按 ${cur} 计价，但分片里没有 ${cur} 的汇率`);
    }
    const firstRate = rate.find((r): r is number => typeof r === "number" && Number.isFinite(r) && r > 0);
    if (firstRate === undefined) {
      throw new Error(`${shard.levelId} 的 ${inst.code} 换不到 ${cur} 汇率，拒绝按本币继续跑`);
    }
    return {
      ...inst,
      open: cnyColumn(inst.open, rate, firstRate),
      close: cnyColumn(inst.close, rate, firstRate),
      high: cnyColumn(inst.high, rate, firstRate),
      low: cnyColumn(inst.low, rate, firstRate),
      // prevClose 是窗口**前一天**的价，那天的汇率没在序列里，用首日汇率近似。
      // 差一天，对首日涨跌幅的影响是万分之一量级，比拿窗口内的价硬顶强得多。
      prevClose:
        typeof inst.prevClose === "number" ? round4(inst.prevClose * firstRate) : (inst.prevClose ?? null),
      // volume 不折：它是股数，跟币种无关
    };
  });
  return { ...shard, instruments };
}

/**
 * 站点里发布了哪几关。
 *
 * `history/index.json` 是 build-history-shards.ts 写的一份清单。有了它，
 * 前端不用「试拉一关、失败了算是没有」——那会白白下载几百 KB。
 * 清单本身不存在（还没跑过构建脚本）就返回空数组，不算错误。
 */
export async function loadLevelIndex(
  opts: { base?: string; fetchImpl?: typeof fetch } = {},
): Promise<string[]> {
  const base = (opts.base ?? DEFAULT_HISTORY_BASE).replace(/\/+$/, "");
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(`${base}/index.json`);
    if (!res.ok) return [];
    const raw: unknown = await res.json();
    const levels = (raw as { levels?: unknown }).levels;
    return Array.isArray(levels) ? levels.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export async function loadLevelShard(
  levelId: string,
  opts: { base?: string; fetchImpl?: typeof fetch } = {},
): Promise<LevelShard> {
  const base = (opts.base ?? DEFAULT_HISTORY_BASE).replace(/\/+$/, "");
  const f = opts.fetchImpl ?? fetch;
  const url = `${base}/level-${levelId}.json`;
  const res = await f(url);
  if (!res.ok) throw new Error(`读取 ${url} 失败：HTTP ${res.status}`);
  const raw: unknown = await res.json();
  if (!isLevelShard(raw)) throw new Error(`${url} 不是一份完整的关卡数据`);
  return convertShardToCny(raw);
}

// ── 那一天的资讯（历史推演专用） ──────────────────────────────
//
// 实时模式看的是**今天**的快讯（packages/data/src/news.ts 的滚动接口）。
// 历史推演跑在过去的某一天，滚动接口给不出那天的东西，所以按日期读一份离线
// 快照：`history/news/<YYYY-MM-DD>.json`，由 packages/data/scripts/
// fetch_history_news.py 抓新浪财经首页归档生成，一天十几条标题 + 原文链接。

export interface DayNewsItem {
  title: string;
  url: string;
}

export interface DayNews {
  date: string;
  source: string;
  url?: string;
  note?: string;
  items: DayNewsItem[];
}

/** 日期合不合法。它会被拼进 URL，不能放任意字符串进去。 */
export function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** 一份资讯文件合不合法。宁可当场说「这天没抓到」，也不要渲染半截数据。 */
export function isDayNews(raw: unknown): raw is DayNews {
  if (typeof raw !== "object" || raw === null) return false;
  const o = raw as Record<string, unknown>;
  if (!isIsoDate(o.date)) return false;
  if (!Array.isArray(o.items)) return false;
  return o.items.every(
    (it) =>
      typeof it === "object" &&
      it !== null &&
      typeof (it as DayNewsItem).title === "string" &&
      typeof (it as DayNewsItem).url === "string",
  );
}

/**
 * 读某一天的资讯。
 *
 * 没有这一天（那天不是交易日、或者还没抓到）返回 null —— 这不是错误：
 * 关卡日历里有、资讯没有的日子本来就可能存在。抓取脚本没跑过的仓库整个目录
 * 都不存在，也会走到这条路上。
 */
export async function loadDayNews(
  date: string,
  opts: { base?: string; fetchImpl?: typeof fetch } = {},
): Promise<DayNews | null> {
  if (!isIsoDate(date)) return null;
  const base = (opts.base ?? DEFAULT_HISTORY_BASE).replace(/\/+$/, "");
  const f = opts.fetchImpl ?? fetch;
  const url = `${base}/news/${date}.json`;
  try {
    const res = await f(url);
    if (!res.ok) return null;
    const raw: unknown = await res.json();
    return isDayNews(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 分片顶层的汇率 → 引擎配置里的汇率。
 *
 * 引擎只需要「哪个币种、哪一天什么价」——`code` 和 `name` 是给人看的，不进引擎。
 */
function configFx(shard: LevelShard): ConfigFx[] | undefined {
  if (!shard.fx || shard.fx.length === 0) return undefined;
  return shard.fx.map((f) => ({ currency: f.currency, rate: f.rate }));
}

/** 用一份关卡分片开局。玩家总是从这一关的第 1 天进场，所以 startIndex 恒为 0。 */
export function startLevelReplay(shard: LevelShard, initialCash: number, label?: string): ReplayState {
  return createReplay({
    calendar: [...shard.calendar],
    startIndex: 0,
    initialCash,
    instruments: shard.instruments,
    benchmarkClose: shard.benchmark?.close,
    fx: configFx(shard),
    label: label ?? shard.levelId,
  });
}

/** 用分片还原一局传奇模式。分片没变的话，日历一定对得上。 */
export function restoreLevelReplay(shard: LevelShard, save: ReplaySave): ReplayState {
  const config: ReplayConfig = {
    calendar: [...shard.calendar],
    startIndex: 0,
    initialCash: save.initialCash,
    instruments: shard.instruments,
    benchmarkClose: shard.benchmark?.close,
    fx: configFx(shard),
    label: save.label,
  };
  return applySave(config, shard.calendar, save);
}

export { advanceDay, advanceDays, cancelOrder, jumpTo, placeOrder, replayDate, replayPrices, settleReplay };
export type { ReplayState, SeasonResult, Side, EquityPoint };
