/**
 * 结算与绩效指标。
 *
 * 关键设计：**必须与基准（沪深300）对比**，否则牛市里人人都是股神，
 * 游戏就失去意义了。`excessReturnPct` 才是真正的成绩。
 */
import { realizedTrades, round2, totalAssets } from "./portfolio";
import type { Account, EquityPoint, SeasonResult } from "./types";

/** 最大回撤 %（正数表示回撤幅度） */
export function maxDrawdownPct(curve: EquityPoint[]): number {
  let peak = Number.NEGATIVE_INFINITY;
  let maxDd = 0;
  for (const p of curve) {
    if (p.total > peak) peak = p.total;
    if (peak > 0) {
      const dd = (peak - p.total) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return round2(maxDd * 100);
}

/** 区间收益率 %：`(末值 / 首值 - 1) * 100` */
export function periodReturnPct(curve: EquityPoint[]): number {
  if (curve.length < 2) return 0;
  const first = curve[0].total;
  const last = curve[curve.length - 1].total;
  if (first <= 0) return 0;
  return round2((last / first - 1) * 100);
}

/** 胜率 %：已平仓交易中盈利的占比；无平仓交易时为 null（而不是 0） */
export function winRatePct(account: Account): number | null {
  const closed = realizedTrades(account);
  if (closed.length === 0) return null;
  const wins = closed.filter((t) => t.pnl > 0).length;
  return round2((wins / closed.length) * 100);
}

export interface SettleInput {
  account: Account;
  /** 本账户的净值曲线 */
  equityCurve: EquityPoint[];
  /** 基准（沪深300）的净值曲线，与 equityCurve 日期对齐 */
  benchmarkCurve: EquityPoint[];
  /** 赛季标识，如 `2026-09` */
  season: string;
  /** 期末可用价格表（用于计算期末总资产） */
  finalPrices: Record<string, number | null>;
}

/**
 * 结算一个赛季。
 *
 * 注意 `finalAssets` 用 `finalPrices` 现场计算，而不是取 `equityCurve` 末值——
 * 避免调用方传入过期曲线导致结算错误。
 */
export function settleSeason(input: SettleInput): SeasonResult {
  const { account, equityCurve, benchmarkCurve, season, finalPrices } = input;

  const finalAssets = totalAssets(account, finalPrices);
  const totalReturnPct = account.initialCash > 0
    ? round2((finalAssets / account.initialCash - 1) * 100)
    : 0;

  const benchmarkReturnPct = periodReturnPct(benchmarkCurve);

  return {
    season,
    startDate: equityCurve[0]?.date ?? "",
    endDate: equityCurve[equityCurve.length - 1]?.date ?? "",
    initialCash: account.initialCash,
    finalAssets,
    totalReturnPct,
    benchmarkReturnPct,
    excessReturnPct: round2(totalReturnPct - benchmarkReturnPct),
    maxDrawdownPct: maxDrawdownPct(equityCurve),
    winRatePct: winRatePct(account),
    tradeCount: account.trades.length,
  };
}

/** 给成绩一个中性描述——注意措辞不得出现买卖建议 */
export function describeSeason(r: SeasonResult): string {
  const beat = r.excessReturnPct;
  if (r.tradeCount === 0) return "本季未产生交易。";
  if (beat > 5) return `跑赢沪深300 ${beat.toFixed(2)} 个百分点。`;
  if (beat > 0) return `小幅跑赢沪深300 ${beat.toFixed(2)} 个百分点。`;
  if (beat === 0) return "与沪深300持平。";
  return `跑输沪深300 ${Math.abs(beat).toFixed(2)} 个百分点。`;
}
