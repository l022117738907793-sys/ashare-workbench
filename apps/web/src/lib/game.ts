/**
 * 模拟盘的本地持久化与界面辅助逻辑。
 *
 * 与撮合规则（@aw/game）分开：那边是纯函数，这边只管「怎么存、怎么取、怎么对齐日期」。
 * 坏数据一律退化为空状态，不抛错——本地存储是用户可随意篡改的。
 */
import {
  createAccount,
  type Account,
  type EquityPoint,
  type Trade,
} from "@aw/game";

export const LS_GAME = "aw.game.v1";
export const GAME_STORE_VERSION = 1;
/** 初始虚拟资金 */
export const DEFAULT_INITIAL_CASH = 1_000_000;
/** 净值曲线最多保留的点数（每交易日一个点，约两年） */
export const EQUITY_MAX = 500;

export interface GameState {
  version: number;
  account: Account;
  /** 净值曲线，用于结算时算收益与最大回撤 */
  equity: EquityPoint[];
}

export function defaultGameState(): GameState {
  return {
    version: GAME_STORE_VERSION,
    account: createAccount(DEFAULT_INITIAL_CASH),
    equity: [],
  };
}

/** 从原始 JSON 还原，任何异常都退化为默认状态 */
export function parseGameState(raw: string | null | undefined): GameState {
  if (!raw) return defaultGameState();
  try {
    const o = JSON.parse(raw) as Partial<GameState>;
    if (!o || typeof o !== "object" || !o.account) return defaultGameState();
    const a = o.account as Partial<Account>;

    const holdings = Array.isArray(a.holdings)
      ? a.holdings
          .filter((h) => h && typeof h.code === "string" && Number.isFinite(h.shares) && h.shares > 0)
          .map((h) => ({
            code: h.code,
            name: typeof h.name === "string" ? h.name : h.code,
            shares: Math.floor(h.shares),
            sellable: Math.max(0, Math.min(Math.floor(h.sellable ?? 0), Math.floor(h.shares))),
            avgCost: Number.isFinite(h.avgCost) ? h.avgCost : 0,
          }))
      : [];

    const trades = Array.isArray(a.trades)
      ? a.trades.filter(
          (t): t is Trade =>
            !!t &&
            typeof t.code === "string" &&
            (t.side === "buy" || t.side === "sell") &&
            Number.isFinite(t.shares) &&
            Number.isFinite(t.price),
        )
      : [];

    const initialCash = Number.isFinite(a.initialCash) && (a.initialCash as number) > 0
      ? (a.initialCash as number)
      : DEFAULT_INITIAL_CASH;

    const equity = Array.isArray(o.equity)
      ? o.equity
          .filter((p) => p && typeof p.date === "string" && Number.isFinite(p.total))
          .slice(-EQUITY_MAX)
      : [];

    return {
      version: GAME_STORE_VERSION,
      account: {
        initialCash,
        cash: Number.isFinite(a.cash) ? (a.cash as number) : initialCash,
        holdings,
        trades,
        seasons: Array.isArray(a.seasons) ? a.seasons : [],
      },
      equity,
    };
  } catch {
    return defaultGameState();
  }
}

export function serializeGameState(s: GameState): string {
  return JSON.stringify(s);
}

/**
 * 每只股票最近一次的买入日，用于 T+1 解锁判断。
 * 取的是 `Trade.date`，即成交当日（北京时间）。
 */
export function lastBuyDates(trades: Trade[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of trades) {
    if (t.side !== "buy") continue;
    const prev = out[t.code];
    if (prev === undefined || t.date > prev) out[t.code] = t.date;
  }
  return out;
}

/**
 * 追加一个净值点。同一天重复访问只更新当天，不新增点，
 * 否则曲线会因多次刷新而被压扁。
 */
export function pushEquity(equity: EquityPoint[], date: string, total: number, max = EQUITY_MAX): EquityPoint[] {
  const last = equity[equity.length - 1];
  if (last && last.date === date) {
    return [...equity.slice(0, -1), { date, total }];
  }
  // 日期必须递增，乱序的丢弃，避免结算时区间取错
  if (last && date < last.date) return equity;
  return [...equity, { date, total }].slice(-max);
}

/**
 * 用指数日线构造与账户净值曲线日期对齐的基准曲线。
 *
 * 找不到对应交易日时向前找最近一天（指数序列与账户曲线可能因停牌/缺失错位）。
 */
export function benchmarkCurve(
  dates: string[],
  calendar: string[],
  indexClose: Array<number | null>,
): EquityPoint[] {
  const byDate = new Map<string, number>();
  for (let i = 0; i < calendar.length; i += 1) {
    const v = indexClose[i];
    if (v !== null && Number.isFinite(v)) byDate.set(calendar[i], v);
  }
  const out: EquityPoint[] = [];
  for (const d of dates) {
    if (byDate.has(d)) {
      out.push({ date: d, total: byDate.get(d)! });
      continue;
    }
    // 向前回退找最近的可用交易日
    for (let i = calendar.length - 1; i >= 0; i -= 1) {
      if (calendar[i] <= d && byDate.has(calendar[i])) {
        out.push({ date: d, total: byDate.get(calendar[i])! });
        break;
      }
    }
  }
  return out;
}

/**
 * 计算某只股票相对成本的浮动盈亏。
 * 取不到价格时返回 null——**不假设涨跌**。
 */
export function positionPnl(
  shares: number,
  avgCost: number,
  price: number | null | undefined,
): { value: number; pnl: number; pnlPct: number } | null {
  if (price === null || price === undefined || !Number.isFinite(price)) return null;
  const value = shares * price;
  const cost = shares * avgCost;
  if (cost <= 0) return null;
  return {
    value: Math.round(value * 100) / 100,
    pnl: Math.round((value - cost) * 100) / 100,
    pnlPct: Math.round(((value - cost) / cost) * 10000) / 100,
  };
}

/** 每笔委托允许的股数上限（按可用资金或可卖数量估算），仅用于输入框提示 */
export function suggestedMaxShares(
  side: "buy" | "sell",
  price: number | null,
  cash: number,
  sellable: number,
): number {
  if (side === "sell") return sellable;
  if (price === null || !Number.isFinite(price) || price <= 0) return 0;
  // 预留 0.2% 给滑点与费用，避免刚好差几毛钱被拒
  const budget = cash / (price * 1.002);
  return Math.max(0, Math.floor(budget / 100) * 100);
}

/** 常驻提示语。红线要求：模拟盘必须显著说明是虚拟的 */
export const GAME_DISCLAIMER = "模拟盘 · 虚拟资金 · 不构成投资建议";
