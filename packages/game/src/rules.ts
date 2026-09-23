/**
 * 按日期生效的交易规则。
 *
 * 为什么单独成模块：A 股的费率与涨跌停制度**在历史上变过多次**，
 * 而游戏要回放历史。用固定常量会让 2023 年后的印花税、2020 年前的创业板涨跌幅全算错。
 *
 * 这也是一次纠错：初版的 `portfolio.ts` 用的是固定常量，37 个测试全绿，
 * 但那些测试验证的是**简化后的规则**，不是真实规则 —— 测试全绿不等于规则准确。
 *
 * 所有变更日期以交易所公告为准；每条都注明生效日，便于核对与增补。
 */

/** 板块。规则差异主要来自这里 */
export type Board = "main" | "star" | "chinext" | "bse";

export function boardOf(code: string): Board {
  const num = code.split(".")[0];
  if (num.startsWith("688") || num.startsWith("689")) return "star"; // 科创板
  if (num.startsWith("300") || num.startsWith("301")) return "chinext"; // 创业板
  if (num.startsWith("8") || num.startsWith("4")) return "bse"; // 北交所
  return "main";
}

export const BOARD_NAME: Record<Board, string> = {
  main: "主板",
  star: "科创板",
  chinext: "创业板",
  bse: "北交所",
};

export interface FeeRules {
  /** 佣金费率（双向） */
  commissionRate: number;
  /** 单笔最低佣金 */
  commissionMin: number;
  /** 印花税（仅卖出） */
  stampDutyRate: number;
  /** 过户费（双向） */
  transferFeeRate: number;
}

/**
 * 取某日生效的费用规则。
 *
 * 历史变更：
 * - 2023-08-28 起，证券交易印花税由 0.1% 减半至 0.05%（财政部/税务总局公告 2023 年第 39 号）
 * - 2022-04-29 起，过户费下调 50%（沪深均按成交金额 0.001% 双向收取）
 */
export function feeRulesAt(date: string): FeeRules {
  const stampDutyRate = date >= "2023-08-28" ? 0.0005 : 0.001;
  return {
    commissionRate: 0.00025,
    commissionMin: 5,
    stampDutyRate,
    transferFeeRate: 0.00001,
  };
}

export interface LimitRules {
  /** 普通股票涨跌幅 */
  normalPct: number;
  /** ST / 风险警示股涨跌幅 */
  stPct: number;
}

/**
 * 取某日、某板块生效的涨跌停幅度。
 *
 * 历史变更：
 * - 科创板 2019-07-22 开市即 20%
 * - 创业板 2020-08-24 注册制起由 10% 改为 20%
 * - 创业板/科创板的风险警示股**仍是 20%**（不适用主板的 5%）
 * - 北交所 30%
 */
export function limitRulesAt(date: string, board: Board): LimitRules {
  if (board === "bse") return { normalPct: 0.3, stPct: 0.3 };
  if (board === "star") return { normalPct: 0.2, stPct: 0.2 };
  if (board === "chinext") {
    const pct = date >= "2020-08-24" ? 0.2 : 0.1;
    return { normalPct: pct, stPct: pct };
  }
  return { normalPct: 0.1, stPct: 0.05 };
}

/** 单笔涨跌幅 */
export function limitPctAt(date: string, board: Board, isST = false): number {
  const r = limitRulesAt(date, board);
  return isST ? r.stPct : r.normalPct;
}

export interface LotRules {
  /** 最低买入股数 */
  minShares: number;
  /** 超过最低数量后的递增单位 */
  increment: number;
}

/**
 * 取某板块的买入单位规则。
 *
 * - 主板/创业板：100 股起，100 股递增
 * - **科创板：200 股起，之后可按 1 股递增**（这是容易忽略的一条）
 * - 北交所：100 股起，1 股递增
 */
export function lotRulesAt(board: Board): LotRules {
  if (board === "star") return { minShares: 200, increment: 1 };
  if (board === "bse") return { minShares: 100, increment: 1 };
  return { minShares: 100, increment: 100 };
}

/** 校验买入股数是否符合该板块的申报规则 */
export function isValidBuyQuantity(board: Board, shares: number): boolean {
  if (!Number.isInteger(shares) || shares <= 0) return false;
  const r = lotRulesAt(board);
  if (shares < r.minShares) return false;
  if (r.increment === 1) return true;
  return (shares - r.minShares) % r.increment === 0;
}

/** 规则描述，用于界面展示「这一局适用什么规则」 */
export function describeRules(date: string, board: Board): string[] {
  const fee = feeRulesAt(date);
  const limit = limitRulesAt(date, board);
  const lot = lotRulesAt(board);
  return [
    `印花税 ${(fee.stampDutyRate * 100).toFixed(3)}%（仅卖出）`,
    `佣金 ${(fee.commissionRate * 100).toFixed(3)}%，最低 ${fee.commissionMin} 元`,
    `${BOARD_NAME[board]}涨跌停 ±${(limit.normalPct * 100).toFixed(0)}%${limit.stPct !== limit.normalPct ? `（ST ±${(limit.stPct * 100).toFixed(0)}%）` : ""}`,
    lot.increment === 1
      ? `${lot.minShares} 股起，可 1 股递增`
      : `${lot.minShares} 股起，${lot.increment} 股递增`,
  ];
}
