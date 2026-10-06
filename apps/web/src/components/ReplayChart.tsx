import { useId, useMemo, useState } from "react";
import type { ReplayState } from "@aw/game";
import { fmtNum } from "../lib/helpers";
import { maskDate } from "../lib/replay";

interface ReplayChartProps {
  state: ReplayState;
  code: string;
  hideDate: boolean;
}

function validVolume(volume: number | null | undefined): number | null {
  return typeof volume === "number" && Number.isFinite(volume) && volume >= 0 ? volume : null;
}

/** Chart data is bounded before drawing; future prices never enter the SVG or tooltip. */
export function ReplayChart({ state, code, hideDate }: ReplayChartProps) {
  const [windowDays, setWindowDays] = useState(60);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const id = useId();
  const instrument = state.config.instruments.find((s) => s.code === code);
  const start = Math.max(0, state.dayIndex - windowDays + 1);
  const rows = useMemo(() => {
    if (!instrument) return [];
    return instrument.close.slice(start, state.dayIndex + 1).map((price, i) => ({
      index: start + i,
      // A listed stock cannot have a zero/negative close. Treat invalid feed values as gaps.
      price: typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null,
      volume: validVolume(instrument.volume[start + i]),
    }));
  }, [instrument, start, state.dayIndex]);
  const valid = rows.filter((r): r is typeof r & { price: number } => r.price !== null);
  const active = rows.find((r) => r.index === hoverIndex) ?? rows.at(-1);
  const labelDate = (index: number) => {
    if (hideDate && index < state.config.startIndex) return `入场前 ${state.config.startIndex - index} 天`;
    return maskDate(state, state.config.calendar[index] ?? "", hideDate);
  };
  const width = 720;
  const height = 298;
  const left = 16;
  const right = 63;
  const top = 18;
  const bottom = 66;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const minPrice = valid.length ? Math.min(...valid.map((r) => r.price)) : 0;
  const maxPrice = valid.length ? Math.max(...valid.map((r) => r.price)) : 1;
  const padding = (maxPrice - minPrice || Math.max(maxPrice * 0.02, 0.1)) * 0.18;
  const low = minPrice - padding;
  const high = maxPrice + padding;
  const x = (index: number) => rows.length === 1 ? left + plotWidth / 2 : left + ((index - start) / Math.max(1, rows.length - 1)) * plotWidth;
  const y = (price: number) => top + (1 - (price - low) / (high - low)) * plotHeight;
  const maxVolume = Math.max(1, ...rows.map((r) => r.volume ?? 0));
  let drawing = false;
  const path = rows.map((r) => {
    if (r.price === null) { drawing = false; return ""; }
    const prefix = drawing ? "L" : "M";
    drawing = true;
    return `${prefix}${x(r.index).toFixed(2)},${y(r.price).toFixed(2)}`;
  }).join(" ");
  const trades = state.account.trades.filter((t) => t.code === code).map((trade) => ({
    trade,
    index: state.config.calendar.indexOf(trade.date),
  })).filter(({ index }) => index >= start && index <= state.dayIndex);

  return (
    <div className="replay-chart">
      <div className="replay-chart-tools">
        <div className="replay-chart-reading" aria-live="polite">
          <span>{active ? labelDate(active.index) : "行情待选择"}</span>
          <strong>{active?.price === null || active?.price === undefined ? "—" : `¥ ${fmtNum(active.price)}`}</strong>
          <span>收盘</span>
        </div>
        <div className="replay-chart-ranges" aria-label="走势图范围">
          {[20, 60, 120].map((days) => (
            <button key={days} type="button" aria-pressed={windowDays === days} onClick={() => { setWindowDays(days); setHoverIndex(null); }}>
              {days} 日
            </button>
          ))}
        </div>
      </div>
      {valid.length === 0 ? (
        <div className="replay-chart-empty">
          <span aria-hidden="true">⌁</span>
          <p>{code ? "当前可见区间没有有效行情" : "选择一只股票，查看截至当前交易日的走势"}</p>
          <small>缺失的数据不会用未来行情补齐。</small>
        </div>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${instrument?.name ?? "股票"}截至${labelDate(state.dayIndex)}的收盘价走势，包含${valid.length}个有效价格`} onPointerLeave={() => setHoverIndex(null)}>
          <defs><linearGradient id={`replay-volume-${id}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="currentColor" stopOpacity=".36"/><stop offset="100%" stopColor="currentColor" stopOpacity=".05"/></linearGradient></defs>
          {[0, 1, 2, 3].map((i) => {
            const price = low + (high - low) * (1 - i / 3);
            return <g key={i}><line className="replay-chart-grid" x1={left} x2={width - right} y1={y(price)} y2={y(price)}/><text className="replay-chart-label" x={width - right + 12} y={y(price) + 4}>{fmtNum(price)}</text></g>;
          })}
          {rows.map((r) => r.volume === null || r.volume <= 0 ? null : (
            <rect key={`v-${r.index}`} className="replay-chart-volume" x={x(r.index) - Math.min(5, plotWidth / rows.length * .25)} y={height - 34 - (r.volume / maxVolume) * 31} width={Math.min(10, plotWidth / rows.length * .5)} height={(r.volume / maxVolume) * 31} fill={`url(#replay-volume-${id})`}/>
          ))}
          <path className="replay-chart-line" d={path}/>
          {valid.length === 1 && <circle className="replay-chart-dot" cx={x(valid[0].index)} cy={y(valid[0].price)} r="4"/>}
          {trades.map(({ trade, index }, i) => {
            const row = rows.find((r) => r.index === index);
            if (row?.price === null || row?.price === undefined) return null;
            return <g key={`${trade.at}-${i}`}><circle className={`replay-trade-dot replay-trade-${trade.side}`} cx={x(index)} cy={y(row.price)} r="6"/><text className={`replay-trade-label replay-trade-${trade.side}`} x={x(index)} y={y(row.price) - 12} textAnchor="middle">{trade.side === "buy" ? "买" : "卖"}</text></g>;
          })}
          {active?.price !== null && active?.price !== undefined && hoverIndex !== null && <g><line className="replay-chart-cursor" x1={x(active.index)} x2={x(active.index)} y1={top} y2={height - 34}/><circle className="replay-chart-dot" cx={x(active.index)} cy={y(active.price)} r="4"/></g>}
          <text className="replay-chart-label" x={left} y={height - 8}>{labelDate(start)}</text>
          <text className="replay-chart-label" x={width - right} y={height - 8} textAnchor="end">{labelDate(state.dayIndex)}</text>
          {rows.map((r) => {
            const halfStep = plotWidth / Math.max(1, rows.length - 1) / 2;
            const hitLeft = Math.max(left, x(r.index) - halfStep);
            const hitRight = Math.min(width - right, x(r.index) + halfStep);
            return <rect key={`hit-${r.index}`} x={hitLeft} y={top} width={hitRight - hitLeft} height={height - top - 25} fill="transparent" onPointerEnter={() => setHoverIndex(r.index)}/>;
          })}
        </svg>
      )}
      <div className="replay-chart-caption"><span><i/> 收盘价 <em>▥</em> 成交量</span><span>只展示截至当前交易日的行情</span></div>
    </div>
  );
}
