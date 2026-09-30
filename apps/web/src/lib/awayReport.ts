/**
 * 「你不在的时候，持仓发生了什么」。
 *
 * 这个文件的全部难点不在于算术，而在于**别把话说错**。三个坑：
 *
 * 1. **这不是「这段时间赚了多少钱」。** 它是两次估值的差。
 *    只要中间有过成交（另一个标签页、手机和电脑同时开着），
 *    差额里就混着买入卖出的影响，不能当成行情涨跌。
 *    所以报告里单独把「期间成交笔数」列出来。
 *
 * 2. **取不到价的持仓不能算进去，也不能当成没变。** 两边都有价格才算这一笔，
 *    只有一边有价的进 `unpriced`，在界面上单独说明。宁可少算一笔，不要编一个数。
 *
 * 3. **休市时价格本来就不动。** 差额为 0 是正常结果，文案要说清"可能只是休市"，
 *    不能渲染成"你的持仓纹丝不动"这种听起来像结论的话。
 *
 * 纯函数，没有 IO，可以单测。
 */
import type { Trade } from "@aw/game";

/** 一次「离开前」的估值快照，存在存档里 */
export interface MarkSnapshot {
  /** 记录时刻（毫秒） */
  at: number;
  cash: number;
  /** 只记**当时取到价格**的持仓；取不到的不记，免得下次误以为它没变 */
  positions: Array<{ code: string; name: string; shares: number; price: number }>;
}

export interface AwayLine {
  code: string;
  name: string;
  shares: number;
  from: number;
  to: number;
  /** 价格变化百分比 */
  pct: number;
  /** 这笔持仓的价格变化金额 */
  amount: number;
}

export interface AwayReport {
  fromAt: number;
  toAt: number;
  awayMs: number;
  /** 两边都有价格的持仓，按金额变化绝对值从大到小 */
  lines: AwayLine[];
  /** 这些持仓的价格变化合计（只含上面那些） */
  priceDelta: number;
  /** 只含「两边都有价」的持仓市值 */
  thenValue: number;
  nowValue: number;
  thenTotal: number;
  nowTotal: number;
  /** 两次总计之差。**含成交的影响**，所以界面上必须和成交笔数一起看 */
  totalDelta: number;
  /** 区间内的成交笔数（左开右闭：走的那一刻不算，回来这一刻算） */
  tradesDuring: number;
  /** 有一边取不到价、没被算进合计的持仓 */
  unpriced: Array<{ code: string; name: string; reason: "then" | "now" }>;
  /** 期间多出来 / 消失的持仓代码（正常情况为空，成交才会造成） */
  opened: string[];
  closed: string[];
}

/** 离开多久才值得报一次。太短没意义，用户只是切了个标签页 */
export const AWAY_MIN_MS = 30 * 60 * 1000;

const round2 = (v: number): number => Math.round(v * 100) / 100;

export function makeMark(
  at: number,
  cash: number,
  positions: Array<{ code: string; name: string; shares: number; price: number | null }>,
): MarkSnapshot {
  return {
    at,
    cash,
    positions: positions
      .filter((p) => p.price !== null && Number.isFinite(p.price) && p.price > 0 && p.shares > 0)
      .map((p) => ({ code: p.code, name: p.name, shares: p.shares, price: p.price as number })),
  };
}

export function awayReport(
  then: MarkSnapshot,
  now: { at: number; cash: number; positions: Array<{ code: string; name: string; shares: number; price: number | null }> },
  trades: Trade[] = [],
): AwayReport {
  const thenByCode = new Map(then.positions.map((p) => [p.code, p]));
  const nowByCode = new Map(now.positions.map((p) => [p.code, p]));

  const lines: AwayLine[] = [];
  const unpriced: AwayReport["unpriced"] = [];
  let thenValue = 0;
  let nowValue = 0;

  for (const t of then.positions) {
    const n = nowByCode.get(t.code);
    if (!n) {
      unpriced.push({ code: t.code, name: t.name, reason: "now" });
      continue;
    }
    if (n.price === null || !Number.isFinite(n.price) || n.price <= 0) {
      unpriced.push({ code: t.code, name: t.name, reason: "now" });
      continue;
    }
    if (t.shares !== n.shares) {
      // 期间股数变了 = 有过成交。用它算"价格变化"就是在撒谎
      unpriced.push({ code: t.code, name: t.name, reason: "then" });
      continue;
    }
    thenValue += t.shares * t.price;
    nowValue += n.shares * n.price;
    lines.push({
      code: t.code,
      name: t.name,
      shares: t.shares,
      from: t.price,
      to: n.price,
      pct: round2(((n.price - t.price) / t.price) * 100),
      amount: round2((n.price - t.price) * t.shares),
    });
  }

  // 现在有、当时没有的（期间买入），记下来但不参与「价格变化」
  const opened: string[] = [];
  for (const n of now.positions) if (!thenByCode.has(n.code)) opened.push(n.code);
  const closed: string[] = [];
  for (const t of then.positions) if (!nowByCode.has(t.code)) closed.push(t.code);

  lines.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  const lo = Math.min(then.at, now.at);
  const hi = Math.max(then.at, now.at);
  const tradesDuring = trades.filter((t) => typeof t.at === "number" && t.at > lo && t.at <= hi).length;

  const thenTotal = round2(then.cash + thenValue);
  const nowTotal = round2(now.cash + nowValue);

  return {
    fromAt: then.at,
    toAt: now.at,
    awayMs: Math.max(0, now.at - then.at),
    lines,
    priceDelta: round2(nowValue - thenValue),
    thenValue: round2(thenValue),
    nowValue: round2(nowValue),
    thenTotal,
    nowTotal,
    totalDelta: round2(nowTotal - thenTotal),
    tradesDuring,
    unpriced,
    opened,
    closed,
  };
}

/**
 * 值不值得给用户看这张卡片。
 *
 * 三条都要满足：离开够久、确实有持仓可比、而且**要么价格动了要么期间有成交**。
 * 什么都不变就不打扰 —— 但「不变」本身在界面上仍然会说清楚（见 GameView）。
 */
export function worthReporting(r: AwayReport): boolean {
  if (r.awayMs < AWAY_MIN_MS) return false;
  if (r.lines.length === 0) return false;
  return true;
}

/** 「3 天 4 小时」这种人话时长 */
export function humanAway(ms: number): string {
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${Math.max(1, min)} 分钟`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时 ${min % 60} 分钟`;
  const days = Math.floor(hours / 24);
  return `${days} 天 ${hours % 24} 小时`;
}
