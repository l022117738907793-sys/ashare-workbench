/** 第一层～第三层：大盘环境 → 板块强弱 → 个股分类（漏斗）。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MarketResult, SectorResult, StockMetrics } from "@aw/core";
import { sourceLabel, type Quote } from "@aw/data";
import { MARKET_NAME, type MarketGroup } from "@aw/game";
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
  /**
   * 市场分档（「个股分类」的第二种切法，与板块筛选**叠加**）：null = 全部市场。
   *
   * 判据是**代码**（`marketGroupOf`），不是快照里的 `market` 字段 —— A 股那批 619 只
   * 根本没有这个键，而且代码是唯一在选股和下单两边都解析过的东西：界面上分到「港股」
   * 而成交按 A 股规则走，是这里最难看的一种不一致。
   */
  marketFilter: MarketGroup | null;
  onSelectMarketFilter: (m: MarketGroup | null) => void;
  /** 池子里**实际有标的**的市场，已按固定顺序排好。只有一个（或没有）时这一排整个不显示。 */
  marketOptions: MarketGroup[];
  /** 各市场的只数。**按「还没被市场筛掉」的那份算**，否则点进港股之后其它分档就消失了 */
  marketCounts: Record<string, number>;
  query: string;
  onQuery: (q: string) => void;
  onOpenStock: (code: string) => void;
  quotesByCode: Map<string, Quote>;
  totalStocks: number;
  filteredStocks: number;
  mainIndexText: string | null;
  /** 全池交易信号，按强度降序 */
  signals: TradeSignal[];
  /**
   * 「去筛选」信号：数字每加一，就滚到「③ 个股分类」并闪一下。
   *
   * 个股分析页在没选中个股时会给出这个按钮，但只切标签页是不够的 ——
   * 第三层在板块下面好几屏，切过去屏幕上什么都没变，看着像没点上。
   * 用计数器而不是布尔量：连着点两次要闪两次。
   */
  focusStocks?: number;
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
    marketFilter,
    onSelectMarketFilter,
    marketOptions,
    marketCounts,
    query,
    onQuery,
    onOpenStock,
    quotesByCode,
    totalStocks,
    filteredStocks,
    mainIndexText,
    signals,
    focusStocks = 0,
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
  /**
   * 折叠状态的最新值。
   *
   * 跳转 effect 只在 `focusStocks` 变化时跑，不能把 `folds` 写进依赖数组 ——
   * 那样每折一次卡都会重新滚一遍屏。用 ref 读当下值。
   */
  const foldsRef = useRef(folds);
  foldsRef.current = folds;
  function toggleFold(key: keyof Folds): void {
    setFolds((f) => {
      const next: Folds = { ...f, [key]: !f[key] };
      writeLS(FOLD_KEY, JSON.stringify(next));
      return next;
    });
  }

  /** 「③ 个股分类」正在闪。跳过去之后把它点亮一下，人就找得到该看哪儿了。 */
  const [flashStocks, setFlashStocks] = useState(false);
  const flashTimer = useRef<number | null>(null);
  const flashStockCard = useCallback(() => {
    if (typeof window === "undefined") return;
    // 先落到 false 再在下一帧打开，否则连点两次时 class 没变、动画不会重播
    setFlashStocks(false);
    window.requestAnimationFrame(() => setFlashStocks(true));
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashStocks(false), FLASH_MS);
  }, []);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

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
    flashStockCard();
  }, [sectorCode, flashStockCard]);

  /**
   * 从个股分析页的「去筛选」进来。
   *
   * 只切标签页的话，屏幕上还是原来那张筛选页 —— 得自己一路滚到第三层才知道
   * 该干什么。所以滚过去、闪一下，顺手把折叠展开（折着的话跳过去也没用，
   * 一眼看不到任何可选的东西）。
   */
  useEffect(() => {
    if (!focusStocks) return;
    scrollBelowHeader(document.getElementById(STOCK_LAYER_ID));
    if (foldsRef.current.stocks) toggleFold("stocks");
    flashStockCard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusStocks]);
  const isOpen = (type: string, idx: number) =>
    closed[type] === undefined ? idx === firstNonEmpty : !closed[type];
  const toggle = (type: string, idx: number) => {
    setClosed((s) => ({ ...s, [type]: isOpen(type, idx) }));
    // 重新展开时回到「只展开三个」：折起来再打开通常是想换个角度看，
    // 而不是接着上次看到第几百只。顺带把 DOM 收回去，等于每次展开都重新计时。
    setShown((r) => ({ ...r, [stockKey(type)]: REVEAL_STEP }));
  };

  /**
   * 每次展开只放这么多条，想接着看再点「继续展开」。
   *
   * 这不是装饰：③「排除」一组有四百多只，每只下面还挂一串 `ReasonList`，
   * 一次挂上去就是几千个节点，点「展开」要卡一下。分段渲染把这一下摊成几次。
   * ② 板块有三十来个，理由一样（每个板块也带着自己的 ReasonList）。
   */
  const [shown, setShown] = useState<Record<string, number>>({});
  const revealCount = (key: string) => shown[key] ?? REVEAL_STEP;
  const revealMore = (key: string) =>
    setShown((s) => ({ ...s, [key]: (s[key] ?? REVEAL_STEP) + REVEAL_STEP }));

  /**
   * 换了筛选条件就让所有「继续展开」退回起点。
   *
   * 不退回的话，上一步已经把某个分组摊到第 300 只，换个股池小的筛选条件之后
   * 一进来就是全展开 —— 优化等于白做，而且是在最没必要的时候白做。
   */
  useEffect(() => {
    setShown({});
  }, [query, marketFilter]);

  const selectedSector = sectors.find((s) => s.code === sectorCode) ?? null;
  const signalByCode = useMemo(() => new Map(signals.map((s) => [s.code, s])), [signals]);
  const shownSectors = Math.min(revealCount(SECTORS_KEY), sectors.length);

  return (
    <div className="view">
      <SignalSummary signals={signals} folded={folds.signals} onToggleFold={() => toggleFold("signals")} />

      <Card
        title="① 大盘环境"
        subtitle="沪深300 + 股票池赚钱效应"
        folded={folds.market}
        onToggleFold={() => toggleFold("market")}
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
          <>
          <ul className="sector-list">
            {sectors.slice(0, shownSectors).map((s) => {
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
          {shownSectors < sectors.length && (
            <button type="button" className="btn btn-ghost reveal-more" onClick={() => revealMore(SECTORS_KEY)}>
              继续展开（还有 {sectors.length - shownSectors} 个板块）
            </button>
          )}
          </>
        )}
      </Card>

      <Card
        id={STOCK_LAYER_ID}
        flash={flashStocks}
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
          {(query !== "" || sectorCode || marketFilter !== null) && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                onQuery("");
                onSelectSector(null);
                onSelectMarketFilter(null);
              }}
            >
              重置
            </button>
          )}
        </div>

        {/*
          市场分档。位置在类型 chip 之上：它是「先看哪个市场的股票」，
          比「看哪一类信号」更靠前一层。
          只有一个市场（或市场都没识别出来）时整排不显示 —— 一个只能选「全部」的分档
          占着一行，比没有更碍事。
        */}
        {marketOptions.length > 1 && (
          <div className="chips chips-market">
            <button
              type="button"
              className={`chip${marketFilter === null ? " chip-active" : ""}`}
              onClick={() => onSelectMarketFilter(null)}
              aria-pressed={marketFilter === null}
            >
              全部市场 {Object.values(marketCounts).reduce((n, v) => n + v, 0)}
            </button>
            {marketOptions.map((m) => (
              <button
                key={m}
                type="button"
                className={`chip${marketFilter === m ? " chip-active" : ""}`}
                onClick={() => onSelectMarketFilter(marketFilter === m ? null : m)}
                aria-pressed={marketFilter === m}
              >
                {MARKET_NAME[m]} {marketCounts[m] ?? 0}
              </button>
            ))}
          </div>
        )}

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
          const key = stockKey(g.type);
          const shownItems = Math.min(revealCount(key), g.items.length);
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
                <>
                <ul className="stock-list">
                  {g.items.slice(0, shownItems).map((r) => {
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
                {shownItems < g.items.length && (
                  <button type="button" className="btn btn-ghost reveal-more" onClick={() => revealMore(key)}>
                    继续展开（还有 {g.items.length - shownItems} 只）
                  </button>
                )}
                </>
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
/** 闪一下的时长，要和 styles.css 里 `.card-flash` 的 animation-duration 对齐 */
const FLASH_MS = 1500;
const SECTOR_LAYER_ID = "layer-sectors";

/** 「继续展开」每点一次多放这么多条 */
const REVEAL_STEP = 3;
/** 展开进度在 `shown` 里的键：③ 每个分组各算各的，② 整列共用一个 */
const stockKey = (type: string) => `stock:${type}`;
const SECTORS_KEY = "sectors";

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
  /** ① 大盘环境 */
  market: boolean;
  /** 今日信号（在最上面，折起来能少滚一屏才够到下面三层） */
  signals: boolean;
  sectors: boolean;
  stocks: boolean;
}

const FOLD_KEY = "aw.folds.v1";
const NO_FOLDS: Folds = { market: false, signals: false, sectors: false, stocks: false };

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
    return {
      market: parsed.market === true,
      signals: parsed.signals === true,
      sectors: parsed.sectors === true,
      stocks: parsed.stocks === true,
    };
  } catch {
    return NO_FOLDS;
  }
}

function reasonValue(s: SectorResult, key: string): number | null {
  return s.reasons.find((r) => r.key === key)?.value ?? null;
}
