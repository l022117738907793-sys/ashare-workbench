import type { MarketResult, SectorResult } from "@aw/core";
import { marketBriefMetrics } from "../lib/marketBrief";
import { fmtPct } from "../lib/helpers";

export function MarketBrief({ market, sectors, mainIndexText, onSelectSector, onOpenDetails }: {
  market: MarketResult; sectors: SectorResult[]; mainIndexText: string | null;
  onSelectSector: (code: string | null) => void; onOpenDetails: () => void;
}) {
  const description: Record<string, string> = {
    强: "指数与股票池表现较强，接下来可以比较板块；个股仍可能下跌。",
    正常: "指标没有同时达到强势或偏弱条件。先看走势，再比较上涨范围。",
    偏弱: "指数或股票池表现偏弱。先观察风险，观望也是一次有效选择。",
    数据不足: "部分关键数据缺失，暂时无法判断市场状态。不要把缺失当成零。",
  };
  return <section className="market-brief" aria-label="市场重点速览">
    <header><div><span className="market-eyebrow">观察任务 / 先看这三件事</span><h2>市场现在是什么状态？</h2></div><span className="market-state">{market.state}</span></header>
    <p className="market-state-copy">{description[market.state] ?? market.implication}</p>
    <p className="market-scope">A股市场 · 快照分析{mainIndexText ? ` · ${mainIndexText}` : " · 指数数据缺失"}</p>
    <div className="market-key-metrics">{marketBriefMetrics(market).map((metric, index) => <article key={metric.label}>
      <span className="market-metric-label">0{index + 1} / {metric.label}</span><strong>{metric.value}</strong><small>{metric.caption}</small>
      <details><summary>这是什么意思？</summary><p>{metric.explanation}</p></details>
    </article>)}</div>
    <div className="market-sectors-head"><h3>接着看 · 哪些板块值得观察</h3><span>按现有强度排序</span></div>
    <div className="market-sector-shortlist">{sectors.length ? sectors.slice(0, 3).map((sector, index) => <button type="button" key={sector.code} onClick={() => { onOpenDetails(); onSelectSector(sector.code); }}>
      <span className="market-rank">{index + 1}</span><span><b>{sector.name}</b><small>{sector.state} · 近20日 {fmtPct(sector.reasons.find(r => r.key === "sector.ret20")?.value ?? null)}</small></span><span aria-hidden="true">→</span>
    </button>) : <p>暂无可比较的板块数据。</p>}</div>
    <p className="market-reading-guide">读图顺序：市场状态 → 三项依据 → 选一个板块。技术信号和完整榜单在下方展开；排名不等于买入建议。</p>
  </section>;
}
