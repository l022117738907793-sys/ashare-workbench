/**
 * 交易信号：把引擎的分类结果转换成可直接执行的买卖建议。
 *
 * 设计说明（与项目历史的区别，别搞混）：
 * 本项目早期版本把「不出现买卖信号」当作硬红线，因为向他人提供买卖建议在
 * 境内需要证券投资咨询资质。该约束已按项目所有者决定移除，本模块即为其替代。
 *
 * 实现上刻意**不改动 `engine.ts`**：
 * 那边是自旧项目逐字节搬移、由 12 个 fixture 守护的行为基线；
 * 信号是叠加在它之上的一层派生逻辑，独立成模块、独立测试，
 * 这样引擎的一致性测试永远不受信号规则调整的影响。
 */
import {
  classifyStock,
  computeStockMetrics,
  ma,
  ret,
  type ReasonItem,
  type Rules,
  type StockData,
  type StockMetrics,
} from "./engine";

/** 信号动作。按可执行程度从强到弱排列 */
export type SignalAction = "买入" | "增持" | "持有" | "减持" | "卖出" | "观望";

export const SIGNAL_ORDER: SignalAction[] = ["买入", "增持", "持有", "减持", "卖出", "观望"];

export interface SignalLevels {
  /** 参考买入/加仓价：20 日线（回踩支撑） */
  entry: number | null;
  /** 参考止损价：20 日线下方 2 倍 ATR */
  stop: number | null;
  /** 参考目标价：现价上方 3 倍 ATR（技术测算，非承诺） */
  target: number | null;
  /** 压力位：20 日最高收盘价 */
  resistance: number | null;
}

export interface TradeSignal {
  code: string;
  name: string;
  action: SignalAction;
  /** 信号强度 0-100，越大越值得执行 */
  strength: number;
  /** 一句话结论 */
  headline: string;
  levels: SignalLevels;
  /** 判断依据（沿用引擎逐条依据，便于核对） */
  reasons: ReasonItem[];
}

/** 分类 → 基础动作。这是信号的主干映射 */
const ACTION_BY_TYPE: Record<string, SignalAction> = {
  启动观察: "买入",
  趋势观察: "增持",
  回调观察: "买入",
  高位观察: "减持",
  排除: "卖出",
  数据不足: "观望",
};

/** 各动作的基础分，再按动量与量能微调 */
const BASE_SCORE: Record<SignalAction, number> = {
  买入: 78,
  增持: 68,
  持有: 58,
  减持: 40,
  卖出: 28,
  观望: 50,
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function lastValid(close: Array<number | null>): number | null {
  for (let i = close.length - 1; i >= 0; i -= 1) {
    const v = close[i];
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

function maxOfValid(close: Array<number | null>, window: number): number | null {
  const vals = close.filter((v): v is number => v !== null && Number.isFinite(v));
  if (vals.length === 0) return null;
  return Math.max(...vals.slice(-window));
}

/**
 * 计算参考价位。
 * 取不到 ATR 时止损退化为 60 日线，目标退化为压力位——**不做无依据的外推**。
 */
function computeLevels(
  stock: StockData,
  m: StockMetrics,
  price: number | null,
  ma20: number | null,
): SignalLevels {
  const atr = m.atr.available ? m.atr.atr : null;
  const resistance = maxOfValid(stock.close, 20);
  const ma60 = ma(stock.close, 60);

  const entry = ma20 ?? price;

  let stop: number | null = null;
  if (entry !== null && atr !== null) stop = round2(entry - 2 * atr);
  else if (ma60 !== null) stop = round2(ma60);

  let target: number | null = null;
  if (price !== null && atr !== null) target = round2(price + 3 * atr);
  else if (resistance !== null) target = round2(resistance);

  return {
    entry: entry === null ? null : round2(entry),
    stop,
    target,
    resistance: resistance === null ? null : round2(resistance),
  };
}

/**
 * 信号强度微调：动量越强、量能越配合，分数越高。
 * 调整幅度受限，避免把"排除"的股票靠动量顶成买入。
 */
function adjustScore(base: number, m: StockMetrics): number {
  let score = base;

  const r20 = m.ret20;
  if (r20 !== null) {
    if (r20 >= 20) score += 8;
    else if (r20 >= 8) score += 5;
    else if (r20 > 0) score += 2;
    else if (r20 <= -10) score -= 8;
    else score -= 3;
  }

  // 量能配合：放量加分，明显缩量减分
  const vr = m.volRatio;
  if (vr !== null && Number.isFinite(vr)) {
    if (vr >= 1.5) score += 6;
    else if (vr >= 1.2) score += 4;
    else if (vr < 0.7) score -= 4;
  }

  // 站上均线加分；跌破双均线明显减分
  if (m.above20 === true) score += 3;
  if (m.above60 === true) score += 3;
  if (m.above20 === false && m.above60 === false) score -= 8;

  // 波动异常时降低把握
  if (m.atr.available && m.atr.flag !== "正常") score -= 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function headlineFor(action: SignalAction, m: StockMetrics, subtype: string | null): string {
  const r20 = m.ret20;
  const r20Text = r20 === null ? "涨幅未知" : `近20日 ${r20 >= 0 ? "+" : ""}${r20.toFixed(2)}%`;
  const vrText = m.volRatio === null || !Number.isFinite(m.volRatio) ? "量比未知" : `量比 ${m.volRatio.toFixed(2)}`;

  switch (action) {
    case "买入":
      return subtype
        ? `回踩确认，${subtype}，${r20Text}，${vrText} —— 可分批建仓`
        : `放量启动且站上 20 日线，${r20Text}，${vrText} —— 可分批建仓`;
    case "增持":
      return `趋势延续中，${r20Text}，${vrText} —— 可持有并逢回调加仓`;
    case "持有":
      return `趋势尚可但动能一般，${r20Text} —— 持有观望，不加仓`;
    case "减持":
      return `已处高位区间，${r20Text}，${vrText} —— 建议减仓锁定利润`;
    case "卖出":
      return `趋势走坏，${r20Text} —— 建议离场，等待重新站上关键均线`;
    case "观望":
      return "数据不足或条件不明，暂不给方向";
  }
}

/** 派生出单只股票的交易信号 */
export function deriveSignal(stock: StockData, rules: Rules): TradeSignal {
  const m = computeStockMetrics(stock, rules);
  const classification = classifyStock(stock, rules);
  const action = ACTION_BY_TYPE[classification.type] ?? "观望";

  const price = lastValid(stock.close);
  const ma20 = ma(stock.close, 20);
  const levels = computeLevels(stock, m, price, ma20);
  const strength = action === "观望" && classification.type === "数据不足"
    ? 0
    : adjustScore(BASE_SCORE[action], m);

  const reasons: ReasonItem[] = [
    ...classification.reasons,
    {
      key: "signal.action",
      label: "信号动作",
      value: null,
      threshold: classification.type,
      pass: true,
      note: headlineFor(action, m, classification.subtype),
    },
    {
      key: "signal.levels",
      label: "参考价位",
      value: price,
      threshold:
        levels.entry === null
          ? "无"
          : `买入 ${levels.entry} / 止损 ${levels.stop ?? "—"} / 目标 ${levels.target ?? "—"}`,
      pass: true,
      note: "止损与目标由 ATR 推算，属技术测算，非承诺",
    },
  ];

  return {
    code: stock.code,
    name: stock.name,
    action,
    strength,
    headline: headlineFor(action, m, classification.subtype),
    levels,
    reasons,
  };
}

/** 批量派生并按信号强度降序（同强度按近20日涨幅降序） */
export function deriveSignals(stocks: StockData[], rules: Rules): TradeSignal[] {
  const signals = stocks.map((s) => deriveSignal(s, rules));
  const rank = new Map<StockData["code"], number | null>();
  for (const s of stocks) {
    rank.set(s.code, ret(s.close, 20));
  }
  return signals.sort((a, b) => {
    if (b.strength !== a.strength) return b.strength - a.strength;
    const ra = rank.get(a.code) ?? Number.NEGATIVE_INFINITY;
    const rb = rank.get(b.code) ?? Number.NEGATIVE_INFINITY;
    return rb - ra;
  });
}

/** 按动作分组计数 */
export function signalCounts(signals: TradeSignal[]): Record<SignalAction, number> {
  const out = { 买入: 0, 增持: 0, 持有: 0, 减持: 0, 卖出: 0, 观望: 0 } as Record<SignalAction, number>;
  for (const s of signals) out[s.action] += 1;
  return out;
}
