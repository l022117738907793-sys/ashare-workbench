/**
 * 虚拟账户与 A 股撮合规则。
 *
 * 全部为纯函数：入参 `Account` 不被修改，返回新的 `Account`。
 * 不含任何 Date.now() —— 「哪天」「几点」都由调用方传入，保证可单测。
 *
 * 费用与规则尽量贴合 A 股实际，因为这些规则本身就是学习内容：
 *   - T+1：当日买入当日不可卖
 *   - 涨跌停：涨停不可买、跌停不可卖
 *   - 佣金万 2.5（最低 5 元）、印花税千 1（仅卖出）、过户费万 0.1（双向）
 *   - 一手 100 股
 */
import type { Account, Holding, OrderRequest, OrderResult, QuoteInput, Trade } from "./types";

export const COMMISSION_RATE = 0.00025;
export const COMMISSION_MIN = 5;
export const STAMP_DUTY_RATE = 0.001; // 仅卖出
export const TRANSFER_FEE_RATE = 0.00001; // 双向
/** 买入默认滑点，模拟冲击成本 */
export const DEFAULT_SLIPPAGE = 0.001;
/** 一手 */
export const LOT_SIZE = 100;

export interface FeeBreakdown {
  commission: number;
  stampDuty: number;
  transferFee: number;
  total: number;
}

/** 计算单笔费用 */
export function calcFee(side: "buy" | "sell", amount: number): FeeBreakdown {
  const commission = Math.max(amount * COMMISSION_RATE, COMMISSION_MIN);
  const stampDuty = side === "sell" ? amount * STAMP_DUTY_RATE : 0;
  const transferFee = amount * TRANSFER_FEE_RATE;
  return {
    commission: round2(commission),
    stampDuty: round2(stampDuty),
    transferFee: round2(transferFee),
    total: round2(commission + stampDuty + transferFee),
  };
}

/** 价格保留 2 位（A 股最小变动单位 0.01 元） */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** 涨跌停幅度：ST 5%，创业板/科创板 20%，其余 10% */
export function priceLimitPct(isST = false, isGrowthBoard = false): number {
  if (isST) return 0.05;
  if (isGrowthBoard) return 0.2;
  return 0.1;
}

/** 账户里找持仓 */
export function findHolding(account: Account, code: string): Holding | undefined {
  return account.holdings.find((h) => h.code === code);
}

/** 持仓市值合计 */
export function holdingsValue(account: Account, prices: Record<string, number | null>): number {
  return account.holdings.reduce((sum, h) => {
    const p = prices[h.code];
    // 取不到价格时用成本价兜底，宁可保守也不要凭空消失
    return sum + h.shares * (p ?? h.avgCost);
  }, 0);
}

/** 总资产 */
export function totalAssets(account: Account, prices: Record<string, number | null>): number {
  return round2(account.cash + holdingsValue(account, prices));
}

/**
 * T+1 结算：进入新的交易日，把此前买入的股份解锁为可卖。
 * 应在每个交易日开始时（或下单前）调用。
 */
export function rolloverTradingDay(account: Account, date: string, lastTradeDates: Record<string, string>): Account {
  let changed = false;
  const holdings = account.holdings.map((h) => {
    // 若该股最近一次买入日早于今天，则全部解锁
    const boughtOn = lastTradeDates[h.code];
    if (boughtOn !== undefined && boughtOn < date && h.sellable !== h.shares) {
      changed = true;
      return { ...h, sellable: h.shares };
    }
    return h;
  });
  return changed ? { ...account, holdings } : account;
}

/** 下单校验。返回 null 表示通过。 */
export function validateOrder(account: Account, req: OrderRequest): string | null {
  const { quote, side, shares } = req;

  if (quote.suspended) return "该股当前停牌，无法交易";
  if (quote.price === null || !Number.isFinite(quote.price) || quote.price <= 0) {
    return "没有可用行情，无法成交（不猜价格）";
  }
  if (!Number.isInteger(shares) || shares <= 0) return "委托股数必须为正整数";

  const holding = findHolding(account, req.code);

  if (side === "buy") {
    if (shares % LOT_SIZE !== 0) return `买入必须是 ${LOT_SIZE} 股的整数倍`;
  } else {
    if (!holding || holding.shares <= 0) return "没有该股持仓";
    // 卖出允许不足一手，但必须是全部剩余（A 股零股规则）
    if (shares % LOT_SIZE !== 0 && shares !== holding.shares) {
      return `卖出需为 ${LOT_SIZE} 股整数倍，或一次性卖出全部持仓`;
    }
    if (shares > holding.sellable) {
      const locked = holding.shares - holding.sellable;
      return locked > 0
        ? `T+1 限制：当日买入的 ${locked} 股需次一交易日才能卖出`
        : "可卖数量不足";
    }
  }

  // 涨跌停
  const prev = quote.prevClose;
  if (prev !== null && prev !== undefined && prev > 0) {
    const limit = priceLimitPct(req.isST, req.isGrowthBoard);
    const upper = round2(prev * (1 + limit));
    const lower = round2(prev * (1 - limit));
    if (side === "buy" && quote.price >= upper) return `已涨停（${upper}），无法买入`;
    if (side === "sell" && quote.price <= lower) return `已跌停（${lower}），无法卖出`;
  }

  // 资金
  if (side === "buy") {
    const execPrice = round2(quote.price * (1 + DEFAULT_SLIPPAGE));
    const amount = round2(execPrice * shares);
    const need = round2(amount + calcFee("buy", amount).total);
    if (need > account.cash) {
      return `可用资金不足：需要 ${need.toFixed(2)} 元，仅有 ${account.cash.toFixed(2)} 元`;
    }
  }

  return null;
}

let tradeSeq = 0;
/** 生成成交 id。纯函数里唯一的不纯之处，仅用于标识，不影响计算结果。 */
export function nextTradeId(prefix = "t"): string {
  tradeSeq += 1;
  return `${prefix}${Date.now().toString(36)}${tradeSeq.toString(36)}`;
}

/**
 * 执行下单。返回新的 Account 与成交记录；校验不通过时返回原因，账户不变。
 */
export function executeOrder(account: Account, req: OrderRequest): OrderResult {
  const invalid = validateOrder(account, req);
  if (invalid !== null) return { ok: false, reason: invalid };

  const rawPrice = req.quote.price as number;
  const slip = DEFAULT_SLIPPAGE;
  const execPrice = round2(req.side === "buy" ? rawPrice * (1 + slip) : rawPrice * (1 - slip));
  const amount = round2(execPrice * req.shares);
  const fee = calcFee(req.side, amount);

  const note = req.isTradingNow
    ? undefined
    : "非交易时段下单，按最近收盘价成交（非实时价）";

  const trade: Trade = {
    id: nextTradeId(),
    at: req.at,
    date: req.date,
    code: req.code,
    name: req.name,
    side: req.side,
    price: execPrice,
    shares: req.shares,
    amount,
    fee: fee.total,
    typeAtTrade: req.typeAtTrade,
    note,
  };

  const holdings = [...account.holdings];
  const idx = holdings.findIndex((h) => h.code === req.code);

  if (req.side === "buy") {
    // 买入成本含费用，摊薄到每股
    const totalCost = amount + fee.total;
    if (idx >= 0) {
      const h = holdings[idx];
      const newShares = h.shares + req.shares;
      holdings[idx] = {
        ...h,
        shares: newShares,
        avgCost: round4((h.avgCost * h.shares + totalCost) / newShares),
        // T+1：新买入的部分不可卖
        sellable: h.sellable,
      };
    } else {
      holdings.push({
        code: req.code,
        name: req.name,
        shares: req.shares,
        sellable: 0,
        avgCost: round4(totalCost / req.shares),
      });
    }
    return {
      ok: true,
      account: {
        ...account,
        cash: round2(account.cash - totalCost),
        holdings,
        trades: [...account.trades, trade],
      },
      trade,
    };
  }

  // 卖出：净收入扣费
  const h = holdings[idx];
  const net = round2(amount - fee.total);
  const remaining = h.shares - req.shares;
  if (remaining === 0) {
    holdings.splice(idx, 1);
  } else {
    holdings[idx] = { ...h, shares: remaining, sellable: Math.max(0, h.sellable - req.shares) };
  }
  return {
    ok: true,
    account: {
      ...account,
      cash: round2(account.cash + net),
      holdings,
      trades: [...account.trades, trade],
    },
    trade,
  };
}

/** 新建账户 */
export function createAccount(initialCash: number): Account {
  return { initialCash, cash: initialCash, holdings: [], trades: [], seasons: [] };
}

/**
 * 已平仓交易的盈亏（用于胜率）。
 * 采用「先进先出」配对：逐笔卖出，与该股此前的买入按成本价配对。
 */
export function realizedTrades(account: Account): Array<{ code: string; pnl: number }> {
  const open: Record<string, Array<{ shares: number; cost: number }>> = {};
  const out: Array<{ code: string; pnl: number }> = [];

  for (const t of account.trades) {
    if (t.side === "buy") {
      (open[t.code] ??= []).push({ shares: t.shares, cost: (t.amount + t.fee) / t.shares });
      continue;
    }
    let left = t.shares;
    let costBasis = 0;
    const queue = open[t.code] ?? [];
    while (left > 0 && queue.length > 0) {
      const lot = queue[0];
      const take = Math.min(lot.shares, left);
      costBasis += take * lot.cost;
      lot.shares -= take;
      left -= take;
      if (lot.shares === 0) queue.shift();
    }
    if (left > 0) continue; // 无对应买入（异常数据），跳过而不是编造
    const proceeds = t.amount - t.fee;
    out.push({ code: t.code, pnl: round2(proceeds - costBasis) });
  }
  return out;
}

/** 供 UI 使用的报价快照转换为价格表 */
export function priceMap(quotes: QuoteInput[]): Record<string, number | null> {
  const m: Record<string, number | null> = {};
  for (const q of quotes) m[q.code] = q.price;
  return m;
}
