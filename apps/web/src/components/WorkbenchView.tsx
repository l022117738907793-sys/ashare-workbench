/** 第一层～第三层：大盘环境 → 板块强弱 → 个股分类（漏斗）。 */
import { useState } from "react";
import type { MarketResult, SectorResult, StockMetrics } from "@aw/core";
import { sourceLabel, type Quote } from "@aw/data";
import {
  fmtNum,
  fmtPct,
  fmtRatio,
  hasInsufficientReason,
  NOT_ENOUGH_BANNER,
  type StockGroup,
} from "../lib/helpers";
import { Card, EmptyHint, Notice, ReasonList, StateBadge } from "./common";

export interface WorkbenchProps {
  market: MarketResult;
  sectors: SectorResult[];
  groups: StockGroup[];
  counts: Record<string, number>;
  metricsByCode: Map<string, StockMetrics>;
  sectorCode: string | null;
  onSelectSector: (code: string | null) => void;
  query: string;
  onQuery: (q: string) => void;
  onOpenStock: (code: string) => void;
  quotesByCode: Map<string, Quote>;
  totalStocks: number;
  filteredStocks: number;
  mainIndexText: string | null;
}

export function WorkbenchView(props: WorkbenchProps) {
  const {
    market,
    sectors,
    groups,
    counts,
    metricsByCode,
    sectorCode,
    onSelectSector,
    query,
    onQuery,
    onOpenStock,
    quotesByCode,
    totalStocks,
    filteredStocks,
    mainIndexText,
  } = props;

  const firstNonEmpty = groups.findIndex((g) => g.items.length > 0);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const isOpen = (type: string, idx: number) =>
    closed[type] === undefined ? idx === firstNonEmpty : !closed[type];
  const toggle = (type: string, idx: number) =>
    setClosed((s) => ({ ...s, [type]: isOpen(type, idx) }));

  const selectedSector = sectors.find((s) => s.code === sectorCode) ?? null;

  return (
    <div className="view">
      <Card
        title="① 大盘环境"
        subtitle="沪深300 + 股票池赚钱效应"
        right={<StateBadge state={market.state} size="lg" />}
      >
        <p className="implication">{market.implication}</p>
        {mainIndexText && <p className="muted small">{mainIndexText}</p>}
        {market.state === "数据不足" && <Notice tone="danger">{NOT_ENOUGH_BANNER} 大盘数据缺失，第一层无法判定。</Notice>}
        <ReasonList reasons={market.reasons} />
      </Card>

      <Card
        title="② 板块强弱"
        subtitle={`申万口径 · 共 ${sectors.length} 个板块，按强度排序`}
        right={
          sectorCode ? (
            <button type="button" className="chip chip-active" onClick={() => onSelectSector(null)}>
              清除板块筛选 ✕
            </button>
          ) : undefined
        }
      >
        {sectors.length === 0 ? (
          <EmptyHint>快照里没有板块数据。</EmptyHint>
        ) : (
          <ul className="sector-list">
            {sectors.map((s) => {
              const active = s.code === sectorCode;
              return (
                <li key={s.code} className={`sector-row${active ? " sector-row-active" : ""}`}>
                  <button
                    type="button"
                    className="row-tap"
                    onClick={() => onSelectSector(active ? null : s.code)}
                    aria-pressed={active}
                  >
                    <span className="row-title">
                      <span className="name">{s.name}</span>
                      <StateBadge state={s.state} size="sm" />
                    </span>
                    <span className="row-metrics">
                      <span>上涨占比 {fmtRatio(s.breadth20)}</span>
                      <span>强势股 {s.strongCount} 只</span>
                      <span>近20日 {fmtPct(reasonValue(s, "sector.ret20"))}</span>
                      <span>量比 {fmtNum(reasonValue(s, "sector.volumeRatio"))}</span>
                    </span>
                    <span className="row-members">
                      最强成分：
                      {s.strongestMembers.length > 0 ? s.strongestMembers.join("、") : "—"}
                    </span>
                    <span className="row-action">{active ? "已选中：第三层只显示该板块" : "点此只看该板块 →"}</span>
                  </button>
                  {s.state === "数据不足" && !hasInsufficientReason(s.reasons) && (
                    <p className="muted small">{NOT_ENOUGH_BANNER} 板块数据缺失。</p>
                  )}
                  <ReasonList reasons={s.reasons} />
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card
        title="③ 个股分类"
        subtitle={
          selectedSector
            ? `已按板块「${selectedSector.name}」过滤 · 命中 ${filteredStocks} / ${totalStocks} 只`
            : `全池 ${totalStocks} 只 · 命中 ${filteredStocks} 只`
        }
      >
        <div className="filter-bar">
          <input
            className="text-input"
            type="search"
            inputMode="search"
            placeholder="按代码 / 名称筛选"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            aria-label="按代码或名称筛选个股"
          />
          {(query !== "" || sectorCode) && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                onQuery("");
                onSelectSector(null);
              }}
            >
              重置
            </button>
          )}
        </div>

        <div className="chips">
          {groups.map((g, idx) => (
            <button
              key={g.type}
              type="button"
              className={`chip${isOpen(g.type, idx) ? " chip-active" : ""}`}
              onClick={() => toggle(g.type, idx)}
              aria-expanded={isOpen(g.type, idx)}
            >
              {g.type} {counts[g.type] ?? 0}
            </button>
          ))}
        </div>

        {filteredStocks === 0 && <EmptyHint>当前筛选条件下没有个股。试着清空代码/名称筛选或换一个板块。</EmptyHint>}

        {groups.map((g, idx) => {
          if (g.items.length === 0) return null;
          const open = isOpen(g.type, idx);
          return (
            <section key={g.type} className="group">
              <button
                type="button"
                className="group-head"
                onClick={() => toggle(g.type, idx)}
                aria-expanded={open}
              >
                <span className="group-title">
                  {g.type} <span className="group-count">{g.items.length}</span>
                </span>
                <span className="group-toggle">{open ? "收起" : "展开"}</span>
              </button>
              {g.type === "数据不足" && open && (
                <Notice tone="danger">{NOT_ENOUGH_BANNER} 下列个股可用数据不足，不做任何推断。</Notice>
              )}
              {open && (
                <ul className="stock-list">
                  {g.items.map((r) => {
                    const m = metricsByCode.get(r.code);
                    const q = quotesByCode.get(r.code);
                    return (
                      <li key={r.code} className="stock-row">
                        <button type="button" className="row-tap" onClick={() => onOpenStock(r.code)}>
                          <span className="row-title">
                            <span className="name">{r.name}</span>
                            <span className="code">{r.code}</span>
                            <StateBadge state={r.type} size="sm" />
                            {r.subtype && <span className="tag">{r.subtype}</span>}
                          </span>
                          <span className="row-metrics">
                            <span>近5日 {fmtPct(m?.ret5 ?? null)}</span>
                            <span>近20日 {fmtPct(m?.ret20 ?? null)}</span>
                            <span>距20日线 {fmtPct(m?.dist20 ?? null)}</span>
                            <span>距20日高点 {fmtPct(m?.distHigh ?? null)}</span>
                            <span>量比 {fmtNum(m?.volRatio ?? null)}</span>
                            <span>ATR {m && m.atr.available ? m.atr.flag : "数据不足"}</span>
                          </span>
                          {q && (
                            <span className="row-live">
                              实时 {fmtNum(q.price)} · {fmtPct(q.changePct)} · 来源 {sourceLabel(q.source)}
                            </span>
                          )}
                          <span className="row-action">打开七步分析 →</span>
                        </button>
                        {r.type === "数据不足" && (
                          <p className="danger-text small">{NOT_ENOUGH_BANNER} 该股可用交易日不足，禁止据此推断。</p>
                        )}
                        <ReasonList reasons={r.reasons} />
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </Card>
    </div>
  );
}

function reasonValue(s: SectorResult, key: string): number | null {
  return s.reasons.find((r) => r.key === key)?.value ?? null;
}
