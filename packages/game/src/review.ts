/**
 * 赛后复盘：**不是**给成绩打分，是把每笔操作放回当时的语境里。
 *
 * 三条不能违反的规矩：
 *
 * 1. **不评判对错。** 这个模块只回答两个可核查的问题：
 *    ① 你下单的那一刻，引擎给这只票的分类是什么（成交记录里存过）；
 *    ② 成交之后这只票走到了哪里。
 *    至于「该不该做」，样本小到根本推不出来，所以不写。
 *
 * 2. **不暗示引擎是对的。** 引擎这套分类在 640 天回测里**没有测出优势**
 *    （见 docs/ 与 `SIGNAL_BACKTEST_CAVEAT`）。所以「一致」多不代表成绩好。
 *    报告里必须把这句话写出来，否则玩家会以为「跟引擎一致」才是玩对了。
 *
 * 3. **缺数据就说缺。** 老成交记录没有 `typeAtTrade`，那不是「不一致」，
 *    是「记录里没有」，单独一档计数。
 */
import { round2, totalAssets } from "./portfolio";
import type { Account, Side, Trade } from "./types";

/**
 * 分类 → 方向。与 `packages/core/src/signal.ts` 的映射保持一致。
 *
 * 这里**手抄**了一份而不是 import：`@aw/game` 声明零依赖（连 `@aw/core` 都不依赖），
 * 保持它可以在任何环境里跑纯函数。改 signal.ts 的映射时要记得同步这里。
 */
const BUY_SIDE_TYPES = new Set(["启动观察", "回调观察", "趋势观察"]);
const SELL_SIDE_TYPES = new Set(["高位观察", "排除"]);

export type Alignment = "aligned" | "against" | "unknown";

export interface ReviewTrade {
  id: string;
  date: string;
  code: string;
  name: string;
  side: Side;
  price: number;
  shares: number;
  /** 下单当时引擎给的分类；老记录里没有就是 undefined */
  typeAtTrade?: string;
  /**
   * 成交后这只票的**原始**涨跌 %（期末价 / 成交价 - 1）。
   * 对买单，正数是好；对卖单，正数意味着「卖完还在涨」—— 两种都只是事实，不是评价。
   */
  laterPct: number | null;
  /** 这笔的方向和当时分类的方向对不对得上 */
  aligned: Alignment;
}

export interface ReviewHolding {
  code: string;
  name: string;
  shares: number;
  avgCost: number;
  /** 相对成本的浮动盈亏 %；取不到价时为 null */
  pnlPct: number | null;
  /** 整季有没有动过 */
  traded: boolean;
}

export interface ReviewReport {
  season: string;
  asOf: string;
  trades: ReviewTrade[];
  counts: { aligned: number; against: number; unknown: number };
  /** 「一致」那批成交后的平均涨跌 %；样本为 0 时 null */
  alignedAvgPct: number | null;
  againstAvgPct: number | null;
  holdings: ReviewHolding[];
  finalAssets: number;
  /** 必须原样显示给玩家的提醒 */
  caveats: string[];
}

export const REVIEW_CAVEATS = [
  "「一致 / 相悖」说的是这笔操作的方向和当时引擎分类的方向对不对得上，**不是对错**。",
  "引擎这套分类在 640 天回测里**没有测出优势** —— 所以「一致」的比例高，不代表成绩会好。别把跟引擎一致当成玩对了。",
  "「成交后涨跌」只说明后来发生了什么，不说明当时该不该做。笔数越少越不能下结论。",
  "老成交记录里没存「当时分类」的，一律记为「记录里没有」，不猜。",
];

/** 方向对不对得上。买单配买入方向分类算一致，卖单配减持/卖出方向分类算一致。 */
export function alignmentOf(side: Side, typeAtTrade: string | undefined): Alignment {
  if (!typeAtTrade) return "unknown";
  if (side === "buy") {
    if (BUY_SIDE_TYPES.has(typeAtTrade)) return "aligned";
    if (SELL_SIDE_TYPES.has(typeAtTrade)) return "against";
    return "unknown"; // 数据不足
  }
  if (SELL_SIDE_TYPES.has(typeAtTrade)) return "aligned";
  if (BUY_SIDE_TYPES.has(typeAtTrade)) return "against";
  return "unknown";
}

export interface ReviewInput {
  account: Account;
  /** 期末价格表；取不到的保持 null，不算盈亏 */
  finalPrices: Record<string, number | null>;
  season: string;
  asOf: string;
}

export function reviewReport(input: ReviewInput): ReviewReport {
  const { account, finalPrices, season, asOf } = input;

  const laterPctOf = (code: string, price: number): number | null => {
    const now = finalPrices[code];
    if (now === null || now === undefined || !Number.isFinite(now) || now <= 0) return null;
    if (!Number.isFinite(price) || price <= 0) return null;
    return round2((now / price - 1) * 100);
  };

  const trades: ReviewTrade[] = account.trades.map((t: Trade) => ({
    id: t.id,
    date: t.date,
    code: t.code,
    name: t.name,
    side: t.side,
    price: t.price,
    shares: t.shares,
    typeAtTrade: t.typeAtTrade,
    laterPct: laterPctOf(t.code, t.price),
    aligned: alignmentOf(t.side, t.typeAtTrade),
  }));

  const counts = { aligned: 0, against: 0, unknown: 0 };
  for (const t of trades) counts[t.aligned] += 1;

  const avg = (which: Alignment): number | null => {
    const vals = trades.filter((t) => t.aligned === which && t.laterPct !== null).map((t) => t.laterPct as number);
    if (vals.length === 0) return null;
    return round2(vals.reduce((a, b) => a + b, 0) / vals.length);
  };

  const tradedCodes = new Set(account.trades.map((t) => t.code));
  const holdings: ReviewHolding[] = account.holdings.map((h) => {
    const now = finalPrices[h.code];
    const pnlPct =
      now === null || now === undefined || !Number.isFinite(now) || now <= 0 || h.avgCost <= 0
        ? null
        : round2((now / h.avgCost - 1) * 100);
    return { code: h.code, name: h.name, shares: h.shares, avgCost: h.avgCost, pnlPct, traded: tradedCodes.has(h.code) };
  });

  return {
    season,
    asOf,
    trades,
    counts,
    alignedAvgPct: avg("aligned"),
    againstAvgPct: avg("against"),
    holdings,
    finalAssets: totalAssets(account, finalPrices),
    caveats: REVIEW_CAVEATS,
  };
}

/**
 * 一句话概括，措辞必须中性。
 *
 * **不写「你判断得对/错」**，只写「有多少笔的方向和当时的分类对得上」。
 */
export function describeReview(r: ReviewReport): string {
  if (r.trades.length === 0) return "本季没有操作，无从复盘。空仓也是一种选择。";
  const known = r.counts.aligned + r.counts.against;
  if (known === 0) {
    return `本季 ${r.trades.length} 笔操作，成交记录里都没有当时的分类，只能看结果。`;
  }
  return `本季 ${r.trades.length} 笔操作：${r.counts.aligned} 笔与当时分类同向，${r.counts.against} 笔反向，${r.counts.unknown} 笔无从判断。`;
}
