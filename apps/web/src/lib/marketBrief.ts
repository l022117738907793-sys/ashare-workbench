import type { MarketResult } from "@aw/core";

export function marketMetric(market: MarketResult, key: string): number | null {
  const value = market.reasons.find((reason) => reason.key === key)?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function marketBriefMetrics(market: MarketResult) {
  const trend = marketMetric(market, "main.aboveMA20");
  return [
    { label: "指数走势", value: percent(marketMetric(market, "main.ret20"), true), caption: "沪深300 · 近20个交易日", explanation: "和20个交易日前相比，指数涨了还是跌了。它代表一篮子股票的整体变化，不代表每只股票。" },
    { label: "上涨范围", value: percent(marketMetric(market, "main.breadth")), caption: "快照A股池 · 近20个交易日", explanation: "股票池里，近20个交易日上涨的股票占比。不是今天上涨家数，也不是全市场统计；历史不足的样本仍在当前算法的分母里。" },
    { label: "趋势位置", value: trend === 1 ? "站上均线" : trend === 0 ? "低于均线" : "数据不足", caption: "沪深300 · 20日平均价格", explanation: "指数当前收盘价与过去20个交易日平均价格比较。站上均线只描述位置，不能保证接下来上涨。" },
  ];
}

function percent(value: number | null, signed = false): string {
  if (value === null) return "数据不足";
  return `${signed && value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}
