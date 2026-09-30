/** 第一层～第三层：大盘环境 → 板块强弱 → 个股分类（漏斗）。 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { MarketResult, SectorResult, StockMetrics } from "@aw/core";
import { sourceLabel, type Quote } from "@aw/data";
import {
  fmtNum,
  fmtPct,
  fmtRatio,
  hasInsufficientReason,
  NOT_ENOUGH_BANNER,
  readLS,
  writeLS,
  type StockGroup,
} from "../lib/helpers";
import type { TradeSignal } from "@aw/core";
import { Card, EmptyHint, Notice, ReasonList, StateBadge } from "./common";
import { SignalBadge, SignalSummary } from "./SignalCard";

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
  /** 全池交易信号，按强度降序 */
  signals: TradeSignal[];
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
    signals,
  } = props;

  const firstNonEmpty = groups.findIndex((g) => g.items.length > 0);
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  /**
   * 第二层、第三层整卡的折叠状态。
   *
   * 这两层加起来能占好几屏，折起来之后读别的层不用一路滚。
   * 默认展开：一进来就把内容藏掉，等于让人先点一下才看得到东西。
   * 但选择会记住（localStorage），折过一次之后每次打开都是折着的。
   */
  const [folds, setFolds] = useState<Folds>(() => parseFolds(readLS(FOLD_KEY)));
  function toggleFold(key: keyof Folds): void {
    setFolds((f) => {
      const next: Folds = { ...f, [key]: !f[key] };
      writeLS(FOLD_KEY, JSON.stringify(next));
      return next;
    });
  }

  /**
   * 选中板块后跳到第三层。
   *
   * 板块有三十来个，第三层在它们下面好几屏；不跳的话点完屏幕上什么都没变，
   * 会让人以为没点上。只在「用户真的换了一个板块」时跳：清除筛选（null）不跳，
   * 否则点「清除」会被莫名其妙地往下带一段。
   */
  const jumpedTo = useRef<string | null>(null);
  useEffect(() => {
    if (!sectorCode) {
      jumpedTo.current = null;
      return;
    }
    if (jumpedTo.current === sectorCode) return;
    jumpedTo.current = sectorCode;
    scrollBelowHeader(document.getElementById(STOCK_LAYER_ID));
  }, [sectorCode]);
  const isOpen = (type: string, idx: number) =>
    closed[type] === undefined ? idx === firstNonEmpty : !closed[type];
  const toggle = (type: string, idx: number) =>
    setClosed((s) => ({ ...s, [type]: isOpen(type, idx) }));

  const selectedSector = sectors.find((s) => s.code === sectorCode) ?? null;
  const signalByCode = useMemo(() => new Map(signals.map((s) => [s.code, s])), [signals]);

  return (
    <div className="view">
      <SignalSummary signals={signals} />

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
        id={SECTOR_LAYER_ID}
        title="② 板块强弱"
        subtitle={`申万口径 · 共 ${sectors.length} 个板块，按强度排序`}
        folded={folds.sectors}
        onToggleFold={() => toggleFold("sectors")}
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
                    <span className="row-action">
                      {active ? "已选中：第三层只显示该板块（再点一下取消）" : "点此只看该板块，并跳到下面的个股 ↓"}
                    </span>
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
        id={STOCK_LAYER_ID}
        folded={folds.stocks}
        onToggleFold={() => toggleFold("stocks")}
        title="③ 个股分类"
        subtitle={
          selectedSector
            ? `已按板块「${selectedSector.name}」过滤 · 命中 ${filteredStocks} / ${totalStocks} 只`
            : `全池 ${totalStocks} 只 · 命中 ${filteredStocks} 只`
        }
        right={
          // 跳下来之后要能跳回去。否则想换个板块得自己往上翻好几屏 —— 那就成了死胡同
          selectedSector ? (
            <button
              type="button"
              className="chip chip-active"
              onClick={() => {
                onSelectSector(null);
                scrollBelowHeader(document.getElementById(SECTOR_LAYER_ID));
              }}
            >
              ↑ 回到板块列表
            </button>
          ) : undefined
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
                            {signalByCode.get(r.code) && <SignalBadge signal={signalByCode.get(r.code)!} size="sm" />}
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

/**
 * 卡片锚点 id。点板块时会跳到这张卡。
 * 改这里要同步改 e2e 里的断言。
 */
const STOCK_LAYER_ID = "layer-stocks";
const SECTOR_LAYER_ID = "layer-sectors";

/**
 * 把某个元素滚到「粘性顶栏下面」。
 *
 * 不能直接用 `scrollIntoView({block:"start"})`：顶栏是 `position: sticky`，
 * 卡片顶端会被压在它下面，跳过去反而看不到标题。所以自己量一下顶栏高度再滚。
 * 顶栏高度随宽度变化（meta 那行会折行），所以要每次现量，不能写死。
 */
function scrollBelowHeader(el: HTMLElement | null): void {
  if (!el || typeof window === "undefined") return;
  const head = document.querySelector(".app-head");
  const offset = head instanceof HTMLElement ? head.getBoundingClientRect().height + 8 : 8;
  const top = window.scrollY + el.getBoundingClientRect().top - offset;
  window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

export interface Folds {
  sectors: boolean;
  stocks: boolean;
}

const FOLD_KEY = "aw.folds.v1";
const NO_FOLDS: Folds = { sectors: false, stocks: false };

/**
 * 解析存下来的折叠状态。
 *
 * 只认真正的 `true`：存档被手改过、或者是旧版本写的 json，都退回「全展开」。
 * 这里不能抛 —— 折叠状态坏了顶多是页面长一点，不该让整页打不开。
 */
export function parseFolds(raw: string | null): Folds {
  if (!raw) return NO_FOLDS;
  try {
    const parsed = JSON.parse(raw) as Partial<Folds> | null;
    if (!parsed || typeof parsed !== "object") return NO_FOLDS;
    return { sectors: parsed.sectors === true, stocks: parsed.stocks === true };
  } catch {
    return NO_FOLDS;
  }
}

function reasonValue(s: SectorResult, key: string): number | null {
  return s.reasons.find((r) => r.key === key)?.value ?? null;
}
