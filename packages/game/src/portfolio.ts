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
import {
  boardOf,
  feeRulesAt,
  hasPriceLimit,
  isTPlusOne,
  isValidBuyQuantity,
  limitPctAt,
  lotRulesAt,
  marketGroupOf,
  type MarketGroup,
} from "./rules";

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

/**
 * 计算单笔费用。
 *
 * `date` 是成交交易日，必须传 —— 税率变过（印花税 2023-08-28 减半，港股 2021-08-01
 * 与 2023-11-17 各调过一次）。不传时退化为 A 股常量（仅供旧调用点与测试使用）。
 *
 * `opts.market` 换一整套费率（见 rules.ts 的 `feeRulesAt`）。`opts.fx` 是该标的计价
 * 币种兑人民币的汇率，**只有「最低佣金」用得上**：港股最低 100 港币，而这里经手的
 * 金额已经是人民币了，不折回去就变成「最低 100 元」，小单会多收约 15%。
 * 费率本身是百分比，折与不折一个样。
 */
export function calcFee(
  side: "buy" | "sell",
  amount: number,
  date?: string,
  opts: { market?: MarketGroup; fx?: number | null } = {},
): FeeBreakdown {
  const market = opts.market ?? "CN";
  // 缺汇率就按 1:1：A 股本来就该如此；境外调用方必须传 fx（见上）
  const fx = typeof opts.fx === "number" && Number.isFinite(opts.fx) && opts.fx > 0 ? opts.fx : 1;
  const r = date
    ? feeRulesAt(date, market)
    : {
        commissionRate: COMMISSION_RATE,
        commissionMin: COMMISSION_MIN,
        stampDutyRate: STAMP_DUTY_RATE,
        stampDutyBothSides: false,
        transferFeeRate: TRANSFER_FEE_RATE,
      };
  // 回到本币去比最低佣金，算完再折回人民币
  const local = amount / fx;
  const commission = Math.max(local * r.commissionRate, r.commissionMin) * fx;
  const stampDuty = side === "sell" || r.stampDutyBothSides ? amount * r.stampDutyRate : 0;
  const transferFee = amount * r.transferFeeRate;
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

/**
 * 涨跌停幅度（简化常量版）。
 *
 * ⚠️ **不区分日期与板块历史变更**，仅供旧调用点与测试使用。
 * 撮合请用 `limitPctAt(date, board, isST)` —— 创业板 20% 是 2020-08-24 才有的。
 */
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

  const board = boardOf(req.code);
  // 市场从代码推（`.HK` / `.US`），不让调用方传：多一个能传错的地方，就多一种
  // 「按错市场收费」的 bug。汇率推不出来，只能由调用方从分片里带进来。
  const market = req.market ?? marketGroupOf(req.code);
  const fx = req.fx ?? null;
  const lot = lotRulesAt(board, market);

  if (side === "buy") {
    if (!isValidBuyQuantity(board, shares, market)) {
      return lot.increment === 1
        ? `买入至少 ${lot.minShares} 股（${board === "star" ? "科创板" : "该板块"}）`
        : `买入必须是 ${lot.minShares} 股的整数倍`;
    }
  } else {
    if (!holding || holding.shares <= 0) return "没有该股持仓";
    // 卖出允许不足一手，但必须是全部剩余（A 股零股规则）
    if (!isValidBuyQuantity(board, shares, market) && shares !== holding.shares) {
      return `卖出需符合 ${lot.minShares} 股起、${lot.increment} 股递增，或一次性卖出全部持仓`;
    }
    if (shares > holding.sellable) {
      const locked = holding.shares - holding.sellable;
      // 只有 A 股是 T+1。港股美股当日买入当日可卖，锁住只会让玩家以为系统坏了
      if (isTPlusOne(market) && locked > 0) {
        return `T+1 限制：当日买入的 ${locked} 股需次一交易日才能卖出`;
      }
      return "可卖数量不足";
    }
  }

  // 涨跌停：A 股与韩股有（韩股是干净的 ±30%）。给港股/美股/日股套上会凭空拦住合法委托。
  const prev = quote.prevClose;
  if (hasPriceLimit(market) && prev !== null && prev !== undefined && prev > 0) {
    // 按成交日、板块与市场取涨跌幅：创业板 20% 是 2020-08-24 起才生效；韩股恒为 30%。
    // market 必须传进来 —— 漏传会走 A 股那张板块表，把韩股的 ±30% 算成主板的 ±10%，
    // 症状是「三星涨了 15% 就买不进去了」，而且不报错。
    const limit = limitPctAt(req.date, board, req.isST ?? false, market);
    const upper = round2(prev * (1 + limit));
    const lower = round2(prev * (1 - limit));
    if (side === "buy" && quote.price >= upper) return `已涨停（${upper}），无法买入`;
    if (side === "sell" && quote.price <= lower) return `已跌停（${lower}），无法卖出`;
  }

  // 资金
  if (side === "buy") {
    const execPrice = round2(quote.price * (1 + DEFAULT_SLIPPAGE));
    const amount = round2(execPrice * shares);
    const need = round2(amount + calcFee("buy", amount, req.date, { market, fx }).total);
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
 * 「这一单大概会成交成什么样」——下单前的预览。
 *
 * 存在的理由是让**预览和真实成交共用同一段算式**：以前滑点只写在规则页里，
 * 下单的人看到「现价 52.50、成交 52.55」会以为系统算错了。现在界面上的预计
 * 成交价就是这个函数算的，executeOrder 也调它，两边不可能对不上。
 *
 * 它**不做校验**（资金够不够、能不能卖是 validateOrder 的事），只回答价格和钱。
 */
export function previewOrder(
  rawPrice: number,
  side: "buy" | "sell",
  shares: number,
  date?: string,
  opts: { market?: MarketGroup; fx?: number | null } = {},
): { price: number; amount: number; fee: FeeBreakdown } {
  const price = round2(side === "buy" ? rawPrice * (1 + DEFAULT_SLIPPAGE) : rawPrice * (1 - DEFAULT_SLIPPAGE));
  const amount = round2(price * shares);
  return { price, amount, fee: calcFee(side, amount, date, opts) };
}

/**
 * 执行下单。返回新的 Account 与成交记录；校验不通过时返回原因，账户不变。
 */
export function executeOrder(account: Account, req: OrderRequest): OrderResult {
  const invalid = validateOrder(account, req);
  if (invalid !== null) return { ok: false, reason: invalid };

  const market = req.market ?? marketGroupOf(req.code);
  const tPlusOne = isTPlusOne(market);
  const { price: execPrice, amount, fee } = previewOrder(
    req.quote.price as number,
    req.side,
    req.shares,
    req.date,
    { market, fx: req.fx ?? null },
  );

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
        // T+1：新买入的部分不可卖。港股美股是 T+0，当日买入当日就能卖
        sellable: tPlusOne ? h.sellable : newShares,
      };
    } else {
      holdings.push({
        code: req.code,
        name: req.name,
        shares: req.shares,
        sellable: tPlusOne ? 0 : req.shares,
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
