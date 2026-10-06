import {
  DEFAULT_SLIPPAGE,
  createAccount,
  executeOrder,
  rolloverTradingDay,
  totalAssets,
  validateOrder,
} from "./portfolio";
import { boardOf, isTPlusOne, isValidBuyQuantity, lotRulesAt, marketGroupOf, type Currency, type MarketGroup } from "./rules";
import { settleSeason } from "./settlement";
import type { Account, EquityPoint, OrderRequest, SeasonResult, Side } from "./types";

/**
 * 历史推演引擎——「把你放回真实的某一天」。
 *
 * 与实时模式的根本区别只有一条：**成交价从哪来**。
 * 实时模式用当下的报价成交；历史推演里玩家看到的是一整天的完整走势（开盘、最高、最低、收盘
 * 全都摆在眼前），所以绝不能用当天收盘价成交——那等于开了天眼。
 * 这里的规则是：**今天下单，按次一交易日的开盘价成交**。
 *
 * 其他一切照搬实时模式：同一套手续费（按成交日期取当时费率）、同一套涨跌停、
 * 同一套 T+1、同一套最小股数。历史回放里的 2020 年就该按 2020 年的规则收税。
 *
 * 全部是纯函数：不读系统时钟、不用随机数、不碰 localStorage。
 * `advanceDay(state)` 返回新的 state，原对象一个字段都不改。
 */

/** 与日历等长的一条标的的历史。缺失的交易日一律是 null，绝不用相邻日顶替。 */
export interface ReplayInstrument {
  code: string;
  name: string;
  isST: boolean;
  /**
   * 申万一级行业名。用来给「模拟下单」的候选清单按板块分组。
   *
   * 可选：老分片里没有这一列，缺了就不分组（而不是把一堆股票塞进「未知」）。
   */
  industry?: string;
  /**
   * 窗口**前一天**的收盘价。
   *
   * 只在下单第一天用得上：那一天 `close[dayIndex - 1]` 不存在，没有它就算不出
   * 当天的涨跌幅 —— 候选榜单在开局第一天会整个空掉，玩家又回到「不知道买什么」。
   */
  prevClose?: number | null;
  /**
   * 这只标的属于哪个市场：`"CN"` / `"HK"` / `"US"`。
   *
   * 缺省按 `"CN"`（老分片没有这一列）。引擎靠它决定 T+1 还是 T+0、有没有涨跌停、
   * 按哪套费率收钱——分片生成时**必须**写对，写错不会报错，只会「A 股按美股规则成交」。
   */
  market?: MarketGroup;
  /**
   * 这只标的的**原**计价币种，只用于界面上标注「港股 / 美股」。
   *
   * 注意 `open`/`close`/`high`/`low`/`prevClose` 这几列**已经折成人民币**了
   * （见 apps/web/src/lib/replay.ts 的 `convertShardToCny`）。引擎全程只认人民币，
   * 所以它不需要知道币种——这一列是留给界面解释「为什么腾讯显示的是 ¥ 而不是 HK$」。
   */
  currency?: Currency;
  open: Array<number | null>;
  close: Array<number | null>;
  high: Array<number | null>;
  low: Array<number | null>;
  volume: Array<number | null>;
}

export interface ReplayConfig {
  /** 交易日历，从旧到新 */
  calendar: string[];
  /** 开局落在日历的哪一天 */
  startIndex: number;
  initialCash: number;
  instruments: ReplayInstrument[];
  /** 基准（沪深300）收盘价，与日历对齐；缺省则结算时不报超额收益 */
  benchmarkClose?: Array<number | null>;
  /**
   * 境外标的的汇率序列，与日历对齐。
   *
   * 只有「最低佣金」用得上（见 `portfolio.calcFee`）：港股的佣金下限是 **100 港币**，
   * 而引擎里所有金额都是人民币，缺了这条序列就会当成「最低 100 元」，小单多收约 15%。
   */
  fx?: ConfigFx[];
  /** 展示用标签，如「2019 年 2 月」「随机开局」 */
  label?: string;
}

/** 一条与 `ReplayConfig.calendar` 等长的汇率：人民币 / 本币 */
export interface ConfigFx {
  currency: Currency;
  rate: Array<number | null>;
}

/** 一张还没成交的委托。它不会立即变成持仓——要等次一交易日开盘。 */
export interface PendingOrder {
  id: string;
  code: string;
  name: string;
  side: Side;
  shares: number;
  /** 挂单当天（玩家做决定的那一天） */
  placedAt: string;
  /** 下单时该股的分类，用于复盘 */
  typeAtTrade?: string;
}

export interface ReplayLogEntry {
  date: string;
  code: string;
  name: string;
  ok: boolean;
  text: string;
}

export interface ReplayState {
  config: ReplayConfig;
  /** 当前处在日历的第几天 */
  dayIndex: number;
  account: Account;
  /** 上一交易日收盘后挂出、等待今日开盘成交的委托 */
  pending: PendingOrder[];
  equity: EquityPoint[];
  log: ReplayLogEntry[];
  finished: boolean;
  /** 委托编号计数器。不用 Date.now()，这样同样的操作序列必定得到同样的结果。 */
  seq: number;
}

export type ReplayOrderResult =
  | { ok: true; state: ReplayState; order: PendingOrder }
  | { ok: false; reason: string };

/** 随机开局至少要有这么多交易日可玩，否则一开局就结束了。 */
export const MIN_REPLAY_DAYS = 20;

function instrumentMap(config: ReplayConfig): Map<string, ReplayInstrument> {
  return new Map(config.instruments.map((i) => [i.code, i]));
}

/** 当前所处日期 */
export function replayDate(state: ReplayState): string {
  return state.config.calendar[state.dayIndex] ?? "";
}

/** 某一天的收盘价表，用于市值计算。不传 index 就是「今天」。 */
export function replayPrices(state: ReplayState, index = state.dayIndex): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const inst of state.config.instruments) {
    out[inst.code] = inst.close[index] ?? null;
  }
  return out;
}

/** 某只股票某一天的收盘价 */
export function replayClose(state: ReplayState, code: string, index = state.dayIndex): number | null {
  const inst = instrumentMap(state.config).get(code);
  return inst?.close[index] ?? null;
}

/**
 * 相对前一交易日的涨跌幅（%）。这是回放里唯一允许玩家看到的「未来」——
 * 也就是已经过去的那一天本身。前一日缺失时返回 null，不要假装是 0。
 */
export function replayChangePct(state: ReplayState, code: string, index = state.dayIndex): number | null {
  const inst = instrumentMap(state.config).get(code);
  if (!inst) return null;
  const now = inst.close[index];
  const prev = index > 0 ? inst.close[index - 1] : null;
  if (now === null || now === undefined || prev === null || prev === undefined || prev === 0) return null;
  return ((now / prev - 1) * 100);
}

/** 当天涨幅榜/跌幅榜，给「今天发生了什么」用 */
export function replayDayMoves(
  state: ReplayState,
  index = state.dayIndex,
  top = 8,
): { gainers: Array<{ code: string; name: string; pct: number }>; losers: Array<{ code: string; name: string; pct: number }> } {
  const rows: Array<{ code: string; name: string; pct: number }> = [];
  for (const inst of state.config.instruments) {
    const pct = replayChangePct(state, inst.code, index);
    if (pct === null) continue;
    rows.push({ code: inst.code, name: inst.name, pct });
  }
  rows.sort((a, b) => b.pct - a.pct);
  return { gainers: rows.slice(0, top), losers: rows.slice(-top).reverse() };
}

/** 每只股票最近一次买入的日期。用于 T+1 解锁，从成交记录推导，不额外维护状态。 */
function lastBuyDates(account: Account): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of account.trades) {
    if (t.side !== "buy") continue;
    const prev = out[t.code];
    if (prev === undefined || t.date > prev) out[t.code] = t.date;
  }
  return out;
}

export function createReplay(config: ReplayConfig): ReplayState {
  const last = Math.max(0, config.calendar.length - 1);
  const startIndex = Math.min(Math.max(0, Math.trunc(config.startIndex)), last);
  const account = createAccount(config.initialCash);
  const date = config.calendar[startIndex] ?? "";

  return {
    config: { ...config, startIndex },
    dayIndex: startIndex,
    account,
    pending: [],
    equity: [{ date, total: account.cash }],
    log: [],
    finished: startIndex >= last,
    seq: 0,
  };
}

/** 已挂出但未成交的委托 */
export function pendingFor(state: ReplayState, code?: string): PendingOrder[] {
  return code === undefined ? state.pending : state.pending.filter((o) => o.code === code);
}

/**
 * 挂一张委托。**不会立即成交**——要等 `advanceDay()` 走到次一交易日开盘。
 *
 * 这里只做「输入是不是明显不对」的检查（标的存在、股数是正整数、买入符合最小股数、
 * 卖出不超过可卖数量）。资金够不够要等真实的开盘价出来才知道，所以放到成交时再判断，
 * 免得因为今天收盘价偏高而误拒一笔明天其实买得起的委托。
 */
export function placeOrder(
  state: ReplayState,
  req: { code: string; side: Side; shares: number; typeAtTrade?: string },
): ReplayOrderResult {
  if (state.finished) return { ok: false, reason: "本局已经结束，无法继续下单" };

  const inst = instrumentMap(state.config).get(req.code);
  if (!inst) return { ok: false, reason: "没有这只股票的历史数据" };

  const { shares, side } = req;
  if (!Number.isInteger(shares) || shares <= 0) return { ok: false, reason: "委托股数必须为正整数" };

  const board = boardOf(req.code);
  // 市场以分片里写的为准，没有这一列（老分片）才从代码后缀推
  const market = inst.market ?? marketGroupOf(req.code);
  if (side === "buy" && !isValidBuyQuantity(board, shares, market)) {
    const lot = lotRulesAt(board, market);
    return {
      ok: false,
      reason: lot.increment === 1
        ? `买入至少 ${lot.minShares} 股（科创板）`
        : `买入必须是 ${lot.minShares} 股的整数倍`,
    };
  }

  if (side === "sell") {
    const holding = state.account.holdings.find((h) => h.code === req.code);
    if (!holding || holding.shares <= 0) return { ok: false, reason: "没有持仓，无法卖出" };
    if (shares > holding.sellable) {
      const locked = holding.shares - holding.sellable;
      // 只有 A 股是 T+1。港股美股当日买入当日可卖，锁住只会让玩家以为系统坏了
      if (isTPlusOne(market) && locked > 0) {
        return { ok: false, reason: `T+1 限制：当日买入的 ${locked} 股需次一交易日才能卖出` };
      }
      return { ok: false, reason: "可卖数量不足" };
    }
  }

  const order: PendingOrder = {
    id: `o${state.seq + 1}`,
    code: inst.code,
    name: inst.name,
    side,
    shares,
    placedAt: replayDate(state),
    typeAtTrade: req.typeAtTrade,
  };

  return {
    ok: true,
    order,
    state: { ...state, pending: [...state.pending, order], seq: state.seq + 1 },
  };
}

/** 撤单。返回未被修改的 state 表示没有这张委托。 */
export function cancelOrder(state: ReplayState, orderId: string): ReplayState {
  const next = state.pending.filter((o) => o.id !== orderId);
  return next.length === state.pending.length ? state : { ...state, pending: next };
}

/** 确定性时间戳：所有「开盘成交」都记在当天 09:30（北京时间）。 */
function openTimestamp(date: string): number {
  return Date.parse(`${date}T09:30:00+08:00`);
}

/**
 * 第 `index` 天、这只标的的汇率（人民币 / 本币）。A 股恒为 1。
 *
 * 取不到就返回 `null`，交给 `calcFee` 按 1:1 处理——影响的只是「最低佣金」那一项，
 * 不会让价格本身算错（价格在分片加载时就已经折成人民币了）。
 */
export function rateAt(
  config: ReplayConfig,
  inst: ReplayInstrument | undefined,
  index: number,
): number | null {
  const currency = inst?.currency;
  if (!currency || currency === "CNY") return 1;
  const series = config.fx?.find((f) => f.currency === currency);
  if (!series) return null;
  // 汇率缺的那天沿用上一个已知值（境外假期、中行没报价）
  for (let k = Math.min(index, series.rate.length - 1); k >= 0; k -= 1) {
    const r = series.rate[k];
    if (typeof r === "number" && Number.isFinite(r) && r > 0) return r;
  }
  return null;
}

/**
 * 用次一交易日的开盘价撮合一笔委托。
 *
 * 没有开盘价（停牌、未上市、数据缺失）就**作废并说明**，绝不拿前一日收盘价顶替——
 * 这也是实时模式里「不猜价格」那条规矩在历史里的样子。
 */
function fillOrder(
  config: ReplayConfig,
  account: Account,
  order: PendingOrder,
  inst: ReplayInstrument | undefined,
  date: string,
  index: number,
): { account: Account; entry: ReplayLogEntry } {
  const base = { date, code: order.code, name: order.name };
  const open = inst?.open[index] ?? null;

  if (open === null || open === undefined || !Number.isFinite(open) || open <= 0) {
    return {
      account,
      entry: { ...base, ok: false, text: `${date} 无法成交：当日没有开盘价（停牌或数据缺失），委托已作废。不猜价格。` },
    };
  }

  const prevClose = inst?.close[index - 1] ?? null;
  const req: OrderRequest = {
    code: order.code,
    name: order.name,
    side: order.side,
    shares: order.shares,
    quote: { code: order.code, name: order.name, price: open, prevClose, suspended: false },
    date,
    at: openTimestamp(date),
    // 历史推演就是在「当天开盘」成交，用 true 避免被写成「非交易时段按最近收盘价成交」
    isTradingNow: true,
    isST: inst?.isST ?? false,
    market: inst?.market,
    fx: rateAt(config, inst, index),
    typeAtTrade: order.typeAtTrade,
  };

  const reason = validateOrder(account, req);
  if (reason) {
    return { account, entry: { ...base, ok: false, text: `${date} 委托未成交：${reason}` } };
  }

  const res = executeOrder(account, req);
  if (!res.ok) {
    return { account, entry: { ...base, ok: false, text: `${date} 委托未成交：${res.reason}` } };
  }

  // 成交记录上写清楚这一笔的价格是怎么来的，复盘时才不会被误读成「按收盘价买的」
  const trades = res.account.trades.slice();
  trades[trades.length - 1] = {
    ...res.trade,
    note:
      `历史推演：按 ${date} 开盘价 ${open.toFixed(2)} 成交，` +
      `成交价 ${res.trade.price.toFixed(2)}（含 ${(DEFAULT_SLIPPAGE * 100).toFixed(1)}% 滑点）`,
  };
  const filled: Account = { ...res.account, trades };

  return {
    account: filled,
    entry: {
      ...base,
      ok: true,
      text:
        `${date} ${order.side === "buy" ? "买入" : "卖出"} ${order.name} ${order.shares} 股 ` +
        `@ ${res.trade.price.toFixed(2)}（当日开盘价 ${open.toFixed(2)}，含 ${(DEFAULT_SLIPPAGE * 100).toFixed(1)}% 滑点）`,
    },
  };
}

/**
 * 推进一个交易日。顺序很重要：
 *   1. 进入新的一天，先做 T+1 解锁（昨天买的今天才能卖）
 *   2. 再按**今天的开盘价**撮合昨天挂出的委托，按挂单先后成交
 * 反过来会让「今天买入、今天卖出」变成可能。
 */
export function advanceDay(state: ReplayState): ReplayState {
  if (state.finished) return state;

  const index = state.dayIndex + 1;
  const date = state.config.calendar[index];
  if (date === undefined) return { ...state, finished: true };

  const map = instrumentMap(state.config);
  let account = rolloverTradingDay(state.account, date, lastBuyDates(state.account));

  const log: ReplayLogEntry[] = [];
  for (const order of state.pending) {
    const res = fillOrder(state.config, account, order, map.get(order.code), date, index);
    account = res.account;
    log.push(res.entry);
  }

  const equity = [...state.equity, { date, total: totalAssets(account, replayPrices(state, index)) }];

  return {
    ...state,
    dayIndex: index,
    account,
    pending: [],
    equity,
    log: [...state.log, ...log],
    finished: index >= state.config.calendar.length - 1,
  };
}

/** 连续推进 n 个交易日（快进用；每一天的委托照常成交） */
export function advanceDays(state: ReplayState, n: number): ReplayState {
  let next = state;
  for (let i = 0; i < n && !next.finished; i += 1) next = advanceDay(next);
  return next;
}

/** 推进到日历上的第 targetIndex 天（剧情节点之间的跳转用），逐日成交，不会跳过任何一天。 */
export function jumpTo(state: ReplayState, targetIndex: number): ReplayState {
  const last = state.config.calendar.length - 1;
  const target = Math.min(Math.max(targetIndex, state.dayIndex), last);
  let next = state;
  while (next.dayIndex < target && !next.finished) next = advanceDay(next);
  return next;
}

/** 基准（沪深300）在已玩过这一段上的净值曲线 */
function benchmarkCurve(state: ReplayState): EquityPoint[] {
  const src = state.config.benchmarkClose;
  if (!src) return [];
  const out: EquityPoint[] = [];
  for (let i = state.config.startIndex; i <= state.dayIndex; i += 1) {
    const v = src[i];
    if (v === null || v === undefined) continue;
    out.push({ date: state.config.calendar[i], total: v });
  }
  return out;
}

/**
 * 结算本局，复用实时模式的 `settleSeason`（同一套收益率、回撤、胜率算法）。
 * 返回结算结果和带赛季记录的新 state，便于调用方直接落库。
 */
export function settleReplay(state: ReplayState, season?: string): { state: ReplayState; result: SeasonResult } {
  const result = settleSeason({
    account: state.account,
    equityCurve: state.equity,
    benchmarkCurve: benchmarkCurve(state),
    season: season ?? state.config.label ?? replayDate(state),
    finalPrices: replayPrices(state),
  });

  return {
    state: { ...state, account: { ...state.account, seasons: [...state.account.seasons, result] } },
    result,
  };
}

/**
 * 随机开局：挑一个「后面还够玩」的起始位置。
 *
 * 传入 rnd 是为了可测——默认 Math.random() 是这里唯一的不确定来源，测试里换成固定序列。
 * 注意这里刻意**不做任何「是不是关键时刻」的筛选**：随机模式的乐趣就在于开局时
 * 谁也不知道接下来会发生什么，事后认出「原来那是 2020 年 2 月」本身就是玩法的一部分。
 */
export function pickRandomStartIndex(
  calendar: string[],
  runDays = MIN_REPLAY_DAYS,
  rnd: () => number = Math.random,
): number {
  const lastStart = calendar.length - 1 - Math.max(1, runDays);
  if (lastStart <= 0) return 0;
  return Math.min(lastStart, Math.floor(rnd() * (lastStart + 1)));
}
