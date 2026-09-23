/**
 * 模拟盘的类型定义。
 *
 * 设计原则与 @aw/core 一致：纯数据 + 纯函数，不读时间、不碰存储。
 * 「今天是哪天」「现在几点」都由调用方传入，这样撮合逻辑才可单测。
 */

export type Side = "buy" | "sell";

export interface Holding {
  code: string;
  name: string;
  /** 总持股数 */
  shares: number;
  /** 可卖股数。T+1：当日买入的部分不计入 */
  sellable: number;
  /** 每股摊薄成本（含买入费用） */
  avgCost: number;
}

export interface Trade {
  id: string;
  /** 成交时间戳（毫秒） */
  at: number;
  /** 成交交易日 `YYYY-MM-DD`（北京时间） */
  date: string;
  code: string;
  name: string;
  side: Side;
  /** 实际成交价（已含滑点） */
  price: number;
  shares: number;
  /** 成交金额 = price * shares */
  amount: number;
  /** 该笔产生的全部费用（佣金 + 印花税 + 过户费） */
  fee: number;
  /** 下单时该股的引擎分类，用于事后复盘对照 */
  typeAtTrade?: string;
  /** 成交说明，例如「非交易时段，按次一交易日开盘价排队成交」 */
  note?: string;
}

export interface Account {
  /** 初始虚拟资金，用于计算总收益 */
  initialCash: number;
  /** 可用资金 */
  cash: number;
  holdings: Holding[];
  trades: Trade[];
  /** 已归档的赛季结果 */
  seasons: SeasonResult[];
}

/** 撮合所需的行情（由 @aw/data 的 Quote 提供） */
export interface QuoteInput {
  code: string;
  name: string;
  price: number | null;
  /** 昨收，用于涨跌停判断。取不到时不做涨跌停限制 */
  prevClose?: number | null;
  /** 是否停牌。停牌时拒绝下单 */
  suspended?: boolean;
}

export interface OrderRequest {
  code: string;
  name: string;
  side: Side;
  /** 委托股数 */
  shares: number;
  quote: QuoteInput;
  /** 成交交易日 `YYYY-MM-DD`（北京时间） */
  date: string;
  /** 成交时间戳 */
  at: number;
  /** 是否处于连续竞价时段 */
  isTradingNow: boolean;
  /** 该股是否 ST（涨跌停 5%） */
  isST?: boolean;
  /** 该股是否为创业板/科创板（涨跌停 20%） */
  isGrowthBoard?: boolean;
  /** 下单时的引擎分类，写入 Trade 供复盘 */
  typeAtTrade?: string;
  /** 该股当前是否停牌 */
  suspended?: boolean;
}

export type OrderResult =
  | { ok: true; account: Account; trade: Trade }
  | { ok: false; reason: string };

export interface EquityPoint {
  date: string;
  /** 总资产 = 可用资金 + 持仓市值 */
  total: number;
}

export interface SeasonResult {
  /** 赛季标识，如 `2026-09` */
  season: string;
  startDate: string;
  endDate: string;
  initialCash: number;
  finalAssets: number;
  /** 收益率 % */
  totalReturnPct: number;
  /** 基准（沪深300）同期收益率 % */
  benchmarkReturnPct: number;
  /** 超额收益 % = 总收益 - 基准收益 */
  excessReturnPct: number;
  /** 最大回撤 %（正数表示回撤幅度） */
  maxDrawdownPct: number;
  /** 已平仓交易的胜率 %，无平仓交易时为 null */
  winRatePct: number | null;
  tradeCount: number;
}
