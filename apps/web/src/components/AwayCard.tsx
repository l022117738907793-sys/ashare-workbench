/**
 * 「你不在的这段时间」卡片。
 *
 * 这是全站**唯一**会回看玩家自己的持仓变动的地方，所以措辞比数字更重要：
 *
 * - 标题写「这段时间」，不写「你不在的时候赚了/亏了」——
 *   差额是两次估值之差，中间若有过成交，它就不是「行情替我赚的钱」。
 * - 期间成交笔数必须一起显示，否则那个差额会被误读成行情。
 * - 取不到价的持仓单独列出来说明「这几只没算进去」，不静默丢弃。
 * - 价格没动时明说「可能只是休市」，不渲染成一条结论。
 */
import type { AwayReport } from "../lib/awayReport";
import { humanAway } from "../lib/awayReport";
import { beijingDateTime, fmtNum, fmtPct } from "../lib/helpers";
import { Card, Notice } from "./common";

export interface AwayCardProps {
  report: AwayReport;
  onDismiss: () => void;
}

export function AwayCard({ report, onDismiss }: AwayCardProps) {
  const up = report.priceDelta > 0;
  const down = report.priceDelta < 0;
  const flat = report.priceDelta === 0;
  const tone = up ? "tone-good" : down ? "tone-bad" : "tone-muted";

  return (
    <Card
      title="你不在的这段时间"
      subtitle={`离开 ${humanAway(report.awayMs)} · ${beijingDateTime(report.fromAt)} → ${beijingDateTime(report.toAt)}`}
      right={
        <button type="button" className="btn btn-ghost btn-tiny" onClick={onDismiss}>
          知道了
        </button>
      }
    >
      <div className="metric-grid">
        <div className="metric">
          <span className="metric-k">持仓价格变化</span>
          <span className={`metric-v ${tone}`}>
            {report.priceDelta > 0 ? "+" : ""}
            {fmtNum(report.priceDelta)}
          </span>
        </div>
        <div className="metric">
          <span className="metric-k">同口径涨跌</span>
          <span className={`metric-v ${tone}`}>
            {report.thenValue > 0 ? fmtPct((report.priceDelta / report.thenValue) * 100) : "—"}
          </span>
        </div>
        <div className="metric">
          <span className="metric-k">总资产</span>
          <span className="metric-v">
            {fmtNum(report.thenTotal)} → {fmtNum(report.nowTotal)}
          </span>
        </div>
        <div className="metric">
          <span className="metric-k">期间成交</span>
          <span className="metric-v">{report.tradesDuring} 笔</span>
        </div>
      </div>

      {flat ? (
        <Notice tone="info">
          这两次估值算出来的持仓价格没有变化。可能只是这段时间休市，
          也可能是行情确实没动 —— 从这两个数上分不出是哪一种。
        </Notice>
      ) : (
        <ul className="away-list">
          {report.lines.map((l) => (
            <li key={l.code} className="away-row">
              <span className="away-name">
                {l.name} <span className="away-code">{l.code}</span>
              </span>
              <span className="away-nums">
                {fmtNum(l.from)} → {fmtNum(l.to)}
                <span className={l.amount > 0 ? "tone-good" : l.amount < 0 ? "tone-bad" : "tone-muted"}>
                  {" "}
                  {fmtPct(l.pct)}（{l.amount > 0 ? "+" : ""}
                  {fmtNum(l.amount)}）
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {report.tradesDuring > 0 && (
        <Notice tone="warn">
          这段时间里有 {report.tradesDuring} 笔成交（可能是另一个标签页或另一台设备下的单）。
          上表的「持仓价格变化」只统计股数没变过的持仓，所以它衡量的是价格，
          而「总资产」那一行的差额里还混着成交带来的现金变化 —— 两者不能互相印证。
        </Notice>
      )}

      {report.unpriced.length > 0 && (
        <p className="field-hint">
          这 {report.unpriced.length} 只没算进去（取不到价格，或期间股数变过）：
          {report.unpriced.map((u) => u.name).join("、")}。
          <strong>宁可不算，也不编一个数</strong>。
        </p>
      )}

      <p className="field-hint">
        这是两次估值的差，<strong>不是「你不在时赚了多少钱」</strong>。
        中间的价格来自实时行情或最近一次收盘价，两次取数的口径可能不同。
      </p>
    </Card>
  );
}
