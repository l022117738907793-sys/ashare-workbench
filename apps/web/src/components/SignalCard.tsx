/**
 * 交易信号的展示组件。
 *
 * 配色沿用 A 股习惯（红涨绿跌）：买入/增持为红、卖出/减持为绿。
 * 强度用进度条表示，参考价位明确标注为「技术测算」而非承诺——
 * 这是产品当前唯一的诚实性要求：可以给方向，但不假装确定。
 */
import { SIGNAL_ORDER, type SignalAction, type TradeSignal } from "@aw/core";
import { fmtNum, SIGNAL_BACKTEST_CAVEAT } from "../lib/helpers";
import { Card, Notice } from "./common";

/** 动作 → 色调。红=看多，绿=看空，灰=不表态 */
function actionTone(action: SignalAction): "good" | "bad" | "muted" {
  if (action === "买入" || action === "增持") return "good";
  if (action === "卖出" || action === "减持") return "bad";
  return "muted";
}

/** 紧凑徽章，用于列表行 */
export function SignalBadge({ signal, size = "md" }: { signal: TradeSignal; size?: "sm" | "md" }) {
  const tone = actionTone(signal.action);
  return (
    <span className={`signal-badge signal-${tone}${size === "sm" ? " signal-sm" : ""}`}>
      {signal.action}
      <span className="signal-strength">{signal.strength}</span>
    </span>
  );
}

/** 完整信号卡，用于个股分析页 */
export function SignalCard({ signal }: { signal: TradeSignal }) {
  const tone = actionTone(signal.action);
  const { levels } = signal;

  return (
    <Card title="交易信号" subtitle="由引擎分类与动量、量能派生；参考价位为技术测算">
      <Notice tone="warn">{SIGNAL_BACKTEST_CAVEAT}</Notice>

      <div className={`signal-hero signal-${tone}`}>
        <span className="signal-action">{signal.action}</span>
        <span className="signal-headline">{signal.headline}</span>
      </div>

      <div className="signal-meter" role="img" aria-label={`信号强度 ${signal.strength} / 100`}>
        <div className={`signal-meter-fill signal-${tone}`} style={{ width: `${signal.strength}%` }} />
      </div>
      <p className="field-hint">信号强度 {signal.strength} / 100</p>

      <div className="metric-grid">
        <div className="metric">
          <span className="metric-k">参考买入价</span>
          <span className="metric-v">{fmtNum(levels.entry)}</span>
        </div>
        <div className="metric">
          <span className="metric-k">参考止损价</span>
          <span className="metric-v">{fmtNum(levels.stop)}</span>
        </div>
        <div className="metric">
          <span className="metric-k">参考目标价</span>
          <span className="metric-v">{fmtNum(levels.target)}</span>
        </div>
        <div className="metric">
          <span className="metric-k">20 日压力位</span>
          <span className="metric-v">{fmtNum(levels.resistance)}</span>
        </div>
      </div>

      {levels.stop !== null && levels.target !== null && levels.entry !== null && (
        <p className="field-hint">
          风险报酬比约{" "}
          {(
            (levels.target - levels.entry) /
            Math.max(0.01, levels.entry - levels.stop)
          ).toFixed(2)}{" "}
          : 1（由 ATR 推算，不构成收益承诺）
        </p>
      )}
    </Card>
  );
}

/** 按动作分组的信号总览，用于筛选页 */
export function SignalSummary({ signals }: { signals: TradeSignal[] }) {
  if (signals.length === 0) return null;
  const counts = new Map<SignalAction, number>();
  for (const s of signals) counts.set(s.action, (counts.get(s.action) ?? 0) + 1);

  const top = signals.slice(0, 5);

  return (
    <Card
      title="今日信号"
      subtitle={`全池 ${signals.length} 只，按信号强度排序`}
      right={
        <span className="chips">
          {SIGNAL_ORDER.filter((a) => counts.get(a)).map((a) => (
            <span key={a} className={`chip chip-static signal-${actionTone(a)}`}>
              {a} {counts.get(a)}
            </span>
          ))}
        </span>
      }
    >
      <ul className="stock-list">
        {top.map((s) => (
          <li key={s.code} className="stock-row">
            <div className="row-static">
              <span className="row-title">
                <span className="name">{s.name}</span>
                <span className="code">{s.code}</span>
                <SignalBadge signal={s} size="sm" />
              </span>
              <span className="row-metrics">
                <span>{s.headline}</span>
              </span>
              <span className="row-metrics">
                <span>买入 {fmtNum(s.levels.entry)}</span>
                <span>止损 {fmtNum(s.levels.stop)}</span>
                <span>目标 {fmtNum(s.levels.target)}</span>
              </span>
            </div>
          </li>
        ))}
      </ul>
      <p className="field-hint">
        参考价位由 ATR 推算，属技术测算，不构成收益承诺。
        信号<strong>尚未通过历史验证</strong>（详见个股分析页的说明），请结合自身判断使用。
      </p>
    </Card>
  );
}
