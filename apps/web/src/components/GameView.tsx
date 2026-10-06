/**
 * 模拟游戏视图。
 *
 * ⚠️ 与「分析红线」的关系（重要，别改错）：
 * 红线禁止的是**程序给出买卖建议**——所以分析引擎的 conclusion / why / nextSteps
 * 以及筛选页、个股分析页里绝不出现「买入/卖出/目标价/必涨/必跌」。
 * 而本页是**玩家自己的决策沙盒**：买卖按钮表达的是用户的操作意图，不是程序的建议。
 * 因此本页允许出现「买入/卖出」，但必须满足三条：
 *   1. 常驻免责声明（GAME_DISCLAIMER）——虚拟资金、不构成投资建议；
 *   2. 不出现任何引导性文案（不为用户判断方向、不作推荐）；
 *   3. 引擎分类只作客观依据展示，不转化为操作建议。
 */
import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_SLIPPAGE,
  LOT_SIZE,
  marketGroupOf,
  reviewReport,
  type ReviewReport,
  type SeasonResult,
  type Side,
  type Trade,
} from "@aw/game";
import type { MarketGroup, StockData, StockResult } from "@aw/core";
import { sourceLabel, type Quote } from "@aw/data";
import { StockPicker } from "./StockPicker";
import { OrderPreview } from "./OrderPreview";
import { amountOf, changePctOf, type PickStock } from "../lib/picks";
import {
  CASH_OPTIONS,
  DEFAULT_INITIAL_CASH,
  GAME_DISCLAIMER,
  positionPnl,
  suggestedMaxShares,
  type GameState,
} from "../lib/game";
import { fmtNum, fmtPct } from "../lib/helpers";
import { Card, EmptyHint, KV, Notice, StateBadge } from "./common";
import "./game-view.css";
import { NewsPanel } from "./NewsPanel";
import { AwayCard } from "./AwayCard";
import { ReviewBlock } from "./ReviewBlock";
import type { AwayReport } from "../lib/awayReport";
import type { LiveNewsState } from "../lib/useLiveNews";

export interface GameViewProps {
  state: GameState;
  /** 价格表：优先实时价，取不到退回快照收盘价 */
  prices: Map<string, number | null>;
  quotesByCode: Map<string, Quote>;
  stocks: StockData[];
  /** 引擎分类，作为客观依据展示（不是操作建议） */
  resultsByCode: Map<string, StockResult>;
  onOrder: (
    code: string,
    side: Side,
    shares: number,
  ) => { ok: boolean; reason?: string; trade?: Trade };
  /**
   * 某个标的的结算汇率（1 单位本币值多少人民币）；A 股返回 1，拿不到返回 null。
   *
   * 实时报价里的**成交额是标的的本币**（腾讯给港股的就是港币），而这一屏别处的
   * 价格都已经折成人民币了 —— 不折就是把两个币种的数字并排放在同一行。
   * 拿不到汇率时退回「按人民币价 × 快照成交量」的估算，那也是人民币口径。
   */
  fxOf?: (code: string) => number | null;
  /**
   * 下单卡里当前选中的标的，选中/清空时上报。
   *
   * 为什么需要这个：行情只给「屏幕上看得见的东西」请求（见 App.tsx 的
   * visibleCodes），而模拟游戏原来只盯**持仓**。于是想买的票在买之前没有实时价，
   * 界面显示的是快照收盘价（往往是昨收），成交也按这个价；一买入它变成持仓、
   * 立刻拿到实时价，账户瞬间多出一笔浮盈 —— 那不是赚了，是两套价混用。
   * 上报之后，选中的标的一起进轮询集合，显示的价和成交的价就是同一个。
   */
  onPickCode?: (code: string | null) => void;
  /** 开局：按选定资金建立新账户 */
  onStart: (initialCash: number) => void;
  onReset: () => void;
  onSettle: () => SeasonResult | null;
  /** 打开撮合规则讲解页 */
  onOpenRules: () => void;
  /** 新闻数据（由 useLiveNews 提供） */
  news: LiveNewsState;
  sessionText: string;
  isTradingNow: boolean;
  /**
   * 当前交易日（北京时间日期）。
   *
   * 下单预览要用它算手续费 —— 卖出印花税 2023-08-28 起从 0.1% 降到 0.05%，
   * 拿错日期会把费用报错。提交订单时 App 用的也是这个值，所以两处不会分家。
   */
  today: string;
  benchmarkName: string;
  benchmarkReturnPct: number | null;
  totalAssets: number;
  holdingsValue: number;
  /** 当前快照带不带开盘价——不带就开不了历史推演 */
  replayReady: boolean;
  /** 已经有一局历史推演在跑：这时不能再开一局，只能回去。 */
  replayInProgress?: boolean;
  /** 回到正在跑的那一局推演。 */
  onResumeReplay?: () => void;
  /** 用随机开局进入历史推演模式 */
  onStartReplay: (initialCash: number) => void;
  /** 打开传奇模式（模式 2）的关卡列表 */
  onOpenLegend: () => void;
  /** 「你不在的这段时间」报告。没有值得说的事时为 null */
  away?: AwayReport | null;
  onDismissAway?: () => void;
}

/** 序列里的第 i 项，不是有限数就当没有（快照里可能是 null）。 */
function numOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function Metric({ k, v, tone }: { k: string; v: string; tone?: "good" | "bad" | "muted" }) {
  return (
    <div className="metric">
      <span className="metric-k">{k}</span>
      <span className={`metric-v${tone ? ` tone-${tone}` : ""}`}>{v}</span>
    </div>
  );
}

/** 装饰性行情插画，不代表当前股票报价或任何策略收益。 */
function MarketIllustration() {
  const candles = [
    [39, 125, 156, 120, 167, false], [62, 123, 147, 111, 159, true],
    [85, 111, 139, 104, 148, true], [108, 117, 136, 109, 151, false],
    [131, 96, 126, 87, 141, true], [154, 84, 117, 74, 129, true],
    [177, 91, 112, 81, 124, false], [200, 75, 99, 61, 115, true],
    [223, 62, 84, 52, 99, true], [246, 70, 91, 58, 103, false],
    [269, 47, 78, 39, 94, true], [292, 42, 65, 28, 74, true],
    [315, 37, 61, 27, 70, false], [338, 24, 48, 13, 64, true],
  ];
  return (
    <div className="game-art" aria-label="历史行情示意插画，非实时数据" role="img">
      <div className="game-art-top"><span className="game-art-dot" /> MARKET REPLAY <span>历史行情示意</span></div>
      <svg viewBox="0 0 380 215" aria-hidden="true">
        <defs>
          <linearGradient id="game-chart-glow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f5a45b" stopOpacity=".22" />
            <stop offset="100%" stopColor="#f5a45b" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[40, 80, 120, 160, 200].map((y) => <line key={y} x1="14" x2="366" y1={y} y2={y} stroke="#343a3e" strokeWidth=".6" />)}
        {[40, 100, 160, 220, 280, 340].map((x) => <line key={x} x1={x} x2={x} y1="12" y2="200" stroke="#343a3e" strokeWidth=".6" />)}
        <path d="M14 178 C38 168 41 161 60 158 S96 165 119 139 S156 126 176 116 S207 108 229 95 S266 77 287 72 S320 53 366 32 L366 200 L14 200Z" fill="url(#game-chart-glow)" />
        <path d="M14 178 C38 168 41 161 60 158 S96 165 119 139 S156 126 176 116 S207 108 229 95 S266 77 287 72 S320 53 366 32" fill="none" stroke="#f5a45b" strokeWidth="2.5" />
        {candles.map(([x, top, bottom, high, low, up]) => (
          <g key={String(x)} stroke={up ? "#c97854" : "#508b7a"} fill={up ? "#c97854" : "#508b7a"}>
            <line x1={Number(x)} x2={Number(x)} y1={Number(high)} y2={Number(low)} />
            <rect x={Number(x) - 5} y={Number(top)} width="10" height={Number(bottom) - Number(top)} rx="1" />
          </g>
        ))}
        <circle cx="366" cy="32" r="4" fill="#f5a45b" />
        <circle cx="366" cy="32" r="9" fill="none" stroke="#f5a45b" strokeOpacity=".35" />
      </svg>
      <div className="game-art-bottom"><span>只看当时的信息</span><strong>决定，由您来做。</strong></div>
    </div>
  );
}

function ModeIcon({ mode }: { mode: "legend" | "live" | "random" }) {
  return (
    <svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      {mode === "legend" ? <><path d="M7 7h18v4c0 8-4 12-9 14C11 23 7 19 7 11Z" /><path d="m16 10 1.8 3.7 4.2.6-3 2.9.7 4.1-3.7-1.9-3.7 1.9.7-4.1-3-2.9 4.2-.6Z" /></> : mode === "live" ? <><path d="M5 23V9m0 14h23" /><path d="m8 18 6-7 5 4 8-10" /><path d="M22 5h5v5" /></> : <><rect x="6" y="6" width="20" height="20" rx="5" /><circle cx="11" cy="11" r="1" /><circle cx="21" cy="11" r="1" /><circle cx="16" cy="16" r="1" /><circle cx="11" cy="21" r="1" /><circle cx="21" cy="21" r="1" /></>}
    </svg>
  );
}

/** 实时账户与历史账户仍使用原来的两个独立存档。 */
function ReplayEntryCard(props: {
  cashChoice: number;
  replayReady: boolean;
  replayInProgress: boolean;
  onResumeReplay?: () => void;
  onStartReplay: (initialCash: number) => void;
  onOpenLegend: () => void;
}) {
  const { cashChoice, replayReady, replayInProgress, onResumeReplay, onStartReplay, onOpenLegend } = props;
  return (
    <section className="game-replay-entry">
      <div>
        <span className="game-eyebrow">另一段市场旅程</span>
        <h2>{replayInProgress ? "您的历史推演还在继续" : "想让时间走得更快？"}</h2>
        <p>{replayInProgress ? "历史盘与实时盘各自保存，回去就能接着玩。" : "回到真实历史，以次日开盘价成交。支持 1.5 秒一天快进，期间仍可挂单。"}</p>
      </div>
      <div className="btn-row">
        {replayInProgress ? (
          <button type="button" className="btn btn-primary" onClick={onResumeReplay}>继续历史推演 →</button>
        ) : (
          <>
            <button type="button" className="btn btn-primary" onClick={onOpenLegend} disabled={!replayReady}>探索传奇关卡 →</button>
            <button type="button" className="btn btn-ghost" onClick={() => onStartReplay(cashChoice)} disabled={!replayReady}>随机开局</button>
          </>
        )}
      </div>
      {!replayReady && !replayInProgress && <p className="field-hint">当前快照缺少开盘价，历史推演暂不可用。</p>}
    </section>
  );
}

export function GameView(props: GameViewProps) {
  const {
    state, prices, quotesByCode, stocks, resultsByCode,
    onOrder, onStart, onReset, onSettle, onOpenRules, news, sessionText, isTradingNow, today,
    benchmarkName, benchmarkReturnPct, totalAssets, holdingsValue,
    replayReady, onStartReplay, onOpenLegend,
    replayInProgress = false, onResumeReplay,
    away = null, onDismissAway,
    onPickCode, fxOf,
  } = props;

  const { account, equity } = state;
  const [side, setSide] = useState<Side>("buy");
  const [selectedMode, setSelectedMode] = useState<"legend" | "live" | "random">(replayInProgress ? "live" : "legend");
  const [cashChoice, setCashChoice] = useState<number>(DEFAULT_INITIAL_CASH);
  const [code, setCode] = useState("");
  const [sharesText, setSharesText] = useState("100");
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [lastSeason, setLastSeason] = useState<SeasonResult | null>(null);
  /** 结算后同时生成复盘报告；重置或重新开局时一起清掉 */
  const [lastReview, setLastReview] = useState<ReviewReport | null>(null);

  const stockByCode = useMemo(() => new Map(stocks.map((s) => [s.code, s])), [stocks]);

  /**
   * 「不知道买什么」那份榜单的数据来源。
   *
   * 涨跌幅的算法要分两种情况，弄反了会显示成 0：
   * - `quotesByCode` 里有这只票 → 说明取到了实时价，快照的最后一根就是**昨收**；
   * - 没有 → 快照的最后一根本身就是最新的收盘价，昨收取倒数第二根。
   *
   * 实时行情只覆盖持仓（见 App.tsx 的 visibleCodes），所以大多数票走的是第二条路 ——
   * 显示的是「最近一个交易日」的涨跌，这一点在榜单下面写着。
   */
  const pickRows = useMemo<PickStock[]>(() => {
    return stocks.map((s) => {
      const q = quotesByCode.get(s.code);
      const n = s.close.length;
      const snapLast = n > 0 ? numOrNull(s.close[n - 1]) : null;
      const snapPrev = n > 1 ? numOrNull(s.close[n - 2]) : null;
      const price = prices.get(s.code) ?? snapLast;
      const isLive = q?.price !== null && q?.price !== undefined;
      const prevClose = isLive ? snapLast : snapPrev;
      /*
       * 实时成交额是**本币**，这一行其余数字都是人民币 —— 不折就并排放了两个币种。
       * 折不了（汇率缺失）时退回「人民币价 × 快照成交量」，那同样是人民币口径。
       */
      const liveAmount = (() => {
        if (q?.amount === null || q?.amount === undefined) return null;
        const rate = fxOf?.(s.code);
        if (rate === null || rate === undefined) return null;
        return rate === 1 ? q.amount : Math.round(q.amount * rate * 1e4) / 1e4;
      })();
      return {
        code: s.code,
        name: s.name,
        sector: s.industry,
        price,
        changePct: q?.changePct ?? changePctOf(price, prevClose),
        amount: liveAmount ?? amountOf(price, n > 0 ? numOrNull(s.volume[n - 1]) : null),
        currency: s.currency,
        signal: resultsByCode.get(s.code)?.type ?? null,
      };
    });
  }, [stocks, prices, quotesByCode, resultsByCode, fxOf]);
  const picked = code ? stockByCode.get(code) : undefined;
  const pickedPrice = code ? (prices.get(code) ?? null) : null;
  const pickedQuote = code ? quotesByCode.get(code) : undefined;
  const pickedResult = code ? resultsByCode.get(code) : undefined;

  /*
   * 把当前选中的标的报上去，好让它进轮询集合。
   *
   * 放在这个组件里而不是 App：输入框是这里的局部状态，为了一个报价把它提到
   * App 去会让每次敲键都重渲染整棵树。
   *
   * 只报**能对上号**的代码 —— 输入框允许边打边看，打到一半的「60」不是股票代码，
   * 报上去会白发一次行情请求。清空时也要报一次 null，否则会停在一只已经不看的
   * 票上一直拉行情。
   */
  useEffect(() => {
    onPickCode?.(picked ? code : null);
  }, [code, picked, onPickCode]);

  const holding = account.holdings.find((h) => h.code === code);
  const shares = Number(sharesText);
  /*
   * 每手股数。A 股统一 100；**港股的「一手」各股不同（腾讯 100、建行 1000…），
   * 快照里没有这份数据**，所以港股这边按 1 股步长走，只当输入提示，不做整手校验
   * ——`validateOrder` 本来也不校验手数。
   */
  const pickedMarket: MarketGroup = picked ? marketGroupOf(picked.code) : "CN";
  const lot = pickedMarket === "CN" ? LOT_SIZE : 1;
  const isHk = pickedMarket === "HK";
  const maxShares = suggestedMaxShares(side, pickedPrice, account.cash, holding?.sellable ?? 0, lot);

  const totalReturnPct = account.initialCash > 0 ? (totalAssets / account.initialCash - 1) * 100 : 0;
  const excessPct = benchmarkReturnPct === null ? null : totalReturnPct - benchmarkReturnPct;
  const pnlTone = (v: number | null) => (v === null ? "muted" : v >= 0 ? "good" : "bad");

  function submit() {
    setFeedback(null);
    if (!code) return setFeedback({ ok: false, msg: "请先选择股票。" });
    if (!Number.isInteger(shares) || shares <= 0) {
      return setFeedback({ ok: false, msg: "委托股数必须为正整数。" });
    }
    const res = onOrder(code, side, shares);
    if (res.ok) {
      const slipText = `含 ${(DEFAULT_SLIPPAGE * 100).toFixed(1)}% 滑点`;
      const fill = res.trade
        ? `成交价 ${fmtNum(res.trade.price)}（参考价 ${
            pickedPrice === null ? "—" : fmtNum(pickedPrice)
          }，${slipText}）· 金额 ${fmtNum(res.trade.amount)} · 手续费 ${fmtNum(res.trade.fee)} 元`
        : "";
      setFeedback({
        ok: true,
        msg: isTradingNow
          ? `已成交 ${shares} 股。${fill}`
          : `已成交 ${shares} 股（当前「${sessionText}」，按最近收盘价成交，非实时价）。${fill}`,
      });
      setSharesText("100");
    } else {
      setFeedback({ ok: false, msg: res.reason ?? "下单失败。" });
    }
  }

  // 未开局：先选玩法，再进入相应的真实游戏流程。
  if (state.status === "idle") {
    const replayBlocked = selectedMode !== "live" && !replayReady;
    const startSelected = () => {
      if (selectedMode === "live") onStart(cashChoice);
      else if (replayInProgress) onResumeReplay?.();
      else if (selectedMode === "legend") onOpenLegend();
      else onStartReplay(cashChoice);
    };
    return (
      <div className="view game-lobby">
        <section className="game-hero">
          <div className="game-hero-copy">
            <span className="game-eyebrow"><span className="game-status-dot" /> 用虚拟资金，体验真实市场</span>
            <h1>回到市场的<br /><em>关键时刻。</em></h1>
            <p>行情由真实历史书写，交易由您决定。<span className="game-hero-secondary"><br />在涨跌之间练习判断，在每一次复盘中积累经验。</span></p>
            <div className="game-hero-facts"><span>真实历史行情</span><i /><span>虚拟资金</span><i /><span>自主决策</span></div>
          </div>
          <MarketIllustration />
        </section>

        {replayInProgress && (
          <section className="game-resume">
            <div><strong>上一次的市场旅程，还等着您。</strong><p>已保存的历史推演可以继续，不影响实时账户。</p></div>
            <button type="button" className="btn btn-primary" onClick={onResumeReplay}>继续推演 →</button>
          </section>
        )}

        <div className="game-section-heading"><div><span className="game-eyebrow">CHOOSE YOUR PLAY</span><h2>选一种玩法，进入市场</h2></div><button type="button" className="game-text-button" onClick={onOpenRules}>第一次玩？先看规则 ↗</button></div>
        <div className="game-mode-grid" role="group" aria-label="选择模拟游戏模式">
          <button type="button" className={`game-mode-card game-mode-legend${selectedMode === "legend" ? " is-selected" : ""}`} aria-pressed={selectedMode === "legend"} disabled={replayInProgress} title={replayInProgress ? "请先继续或结束当前历史推演" : undefined} onClick={() => setSelectedMode("legend")}>
            <div className="game-mode-top"><ModeIcon mode="legend" /><span className="game-mode-tag">推荐先体验</span></div>
            <span className="game-mode-number">01 / 历史关卡</span><strong>传奇模式</strong>
            <p>站在 10 个历史时刻的起点，带着当时的线索作出判断。</p>
            <span className="game-mode-foot">真实日期 · 开局简报 <span>↗</span></span>
          </button>
          <button type="button" className={`game-mode-card${selectedMode === "live" ? " is-selected" : ""}`} aria-pressed={selectedMode === "live"} onClick={() => setSelectedMode("live")}>
            <div className="game-mode-top"><ModeIcon mode="live" /><span className="game-mode-tag game-mode-tag-quiet">跟随今日市场</span></div>
            <span className="game-mode-number">02 / 当下进行时</span><strong>实时模式</strong>
            <p>从今天开始跟随真实行情，适合每天回来观察与交易。</p>
            <span className="game-mode-foot">真实行情 · 独立账户 <span>↗</span></span>
          </button>
          <button type="button" className={`game-mode-card${selectedMode === "random" ? " is-selected" : ""}`} aria-pressed={selectedMode === "random"} disabled={replayInProgress} title={replayInProgress ? "请先继续或结束当前历史推演" : undefined} onClick={() => setSelectedMode("random")}>
            <div className="game-mode-top"><ModeIcon mode="random" /><span className="game-mode-tag game-mode-tag-quiet">未知的挑战</span></div>
            <span className="game-mode-number">03 / 隐藏时间</span><strong>随机模式</strong>
            <p>不告诉您身处哪一年，只凭眼前的信息探索未知行情。</p>
            <span className="game-mode-foot">隐藏日期 · 自主探索 <span>↗</span></span>
          </button>
        </div>

        <section className="game-launch-panel">
          <div className="game-funding"><span className="game-eyebrow">准备您的虚拟本金</span><div className="cash-options">{CASH_OPTIONS.map((c) => <button key={c} type="button" className={`chip${cashChoice === c ? " chip-active" : ""}`} aria-pressed={cashChoice === c} onClick={() => setCashChoice(c)}>{c / 10000} 万</button>)}</div><p>A 股买入一手 100 股，资金量限制可买数量；本金较少时可能买不起一手高价股。</p><p>{selectedMode === "legend" ? "传奇关卡的资金与背景将在选关时确认。" : "仅用于模拟交易 · 账户保存在此浏览器"}</p></div>
          <div className="game-launch-action"><button type="button" className="btn btn-primary game-launch-button" disabled={replayBlocked && !replayInProgress} onClick={startSelected}>{selectedMode === "live" ? `用 ${cashChoice / 10000} 万开始实时盘` : replayInProgress ? "继续已保存的历史推演" : selectedMode === "legend" ? "选择传奇关卡" : `用 ${cashChoice / 10000} 万随机开局`} <span>→</span></button><p>{selectedMode === "live" ? `当前${sessionText}，非交易时段按最近收盘价成交。` : "今日挂单，下一交易日开盘撮合。"}</p></div>
        </section>
        {replayBlocked && !replayInProgress && <Notice tone="warn">当前快照缺少开盘价，历史推演暂不可用。您可以选择实时模式，或等下一次快照更新。</Notice>}
        <div className="game-how-grid"><div><span>01</span><strong>读懂眼前的信息</strong><p>查看行情、新闻与背景，形成自己的判断。</p></div><div><span>02</span><strong>亲手作出决定</strong><p>选股、设置数量、提交委托，体验真实交易规则。</p></div><div><span>03</span><strong>回看每一次交易</strong><p>对照市场基准与交易记录，理解收益和风险。</p></div></div>
        <p className="game-disclaimer" role="note">{GAME_DISCLAIMER} · 账户保存在此浏览器，重置后不可恢复。</p>
      </div>
    );
  }

  return (
    <div className="view game-stage">
      <div className="game-stage-heading"><div><span className="game-eyebrow">LIVE SIMULATION</span><h1>您的实时模拟盘</h1></div><span className="game-session-pill"><span className="game-status-dot" />{sessionText}</span></div>
      {/* 红线要求：常驻且显著 */}
      <p className="game-disclaimer" role="note">
        ⚠️ {GAME_DISCLAIMER}
      </p>

      <Card
        title="账户总览"
        subtitle={`净值点 ${equity.length} 个 · 跑赢 ${benchmarkName} 才算有效成绩`}
        right={
          <button
            type="button"
            className="btn btn-ghost btn-tiny"
            onClick={() => {
              if (confirm("结束本局并回到开局界面？当前持仓与成交记录将清空，不可恢复。")) {
                onReset();
                setLastSeason(null);
                setLastReview(null);
                setFeedback(null);
              }
            }}
          >
            重新开局
          </button>
        }
      >
        <div className="metric-grid">
          <Metric k="总资产" v={fmtNum(totalAssets)} />
          <Metric k="可用资金" v={fmtNum(account.cash)} />
          <Metric k="持仓市值" v={fmtNum(holdingsValue)} />
          <Metric k="总收益率" v={fmtPct(totalReturnPct)} tone={pnlTone(totalReturnPct)} />
        </div>
        {/*
          没有可比区间时自动展开。这句解释本来就是为了「别让玩家以为坏了」，
          折在里面等于没说 —— 刚开局那会儿恰恰是最需要看到它的时候。
          等到基准出来了（走过一个交易日），它自己收回去。
        */}
        <details className="account-comparison" open={benchmarkReturnPct === null}>
          <summary>市场对照与交易统计 <span>＋</span></summary>
          <div className="metric-grid">
          <Metric
            k={`同期${benchmarkName}`}
            v={benchmarkReturnPct === null ? "—" : fmtPct(benchmarkReturnPct)}
          />
          <Metric k="超额收益" v={excessPct === null ? "—" : fmtPct(excessPct)} tone={pnlTone(excessPct)} />
          <Metric k="成交笔数" v={`${account.trades.length} 笔`} />
          <Metric k="持仓只数" v={`${account.holdings.length} 只`} />
        </div>
        {/*
          基准没出来时要说清为什么，别只挂一个「—」——
          玩家会以为坏了，或者更糟：以为自己和指数持平。
        */}
        {benchmarkReturnPct === null && (
          <p className="field-hint">
            还没有可比的区间：这一局刚开始，或者快照里没有{benchmarkName}的行情。
            走过一个交易日之后，这里会显示同期涨跌和超额收益。
          </p>
        )}
        </details>
      </Card>

      {away && onDismissAway && <AwayCard report={away} onDismiss={onDismissAway} />}



      <div className="game-trading-grid">
      <Card
        title="模拟下单"
        subtitle={
          isHk
            ? "港股 T+0：当日买入即可卖出 · 每手股数各股不同，按股填写"
            : `一手 ${LOT_SIZE} 股 · T+1：当日买入次日才可卖`
        }
        right={
          <button type="button" className="btn btn-ghost btn-tiny" onClick={onOpenRules}>
            规则说明
          </button>
        }
      >
        <div className="chips">
          <button
            type="button"
            className={`chip${side === "buy" ? " chip-active" : ""}`}
            onClick={() => setSide("buy")}
          >
            买入
          </button>
          <button
            type="button"
            className={`chip${side === "sell" ? " chip-active" : ""}`}
            onClick={() => setSide("sell")}
          >
            卖出
          </button>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="game-code">
            股票
          </label>
          <input
            id="game-code"
            className="text-input"
            placeholder="输入代码或名称，也可以直接从下面挑"
            value={code}
            onChange={(e) => {
              const v = e.target.value.trim();
              // 打完完整代码或名字时立刻认出来（下面那一列只是候选，允许直接输入）
              const hit = stocks.find((s) => s.code === v || s.name === v);
              setCode(hit ? hit.code : v);
              setFeedback(null);
            }}
          />
          <StockPicker
            rows={pickRows}
            query={code}
            activeCode={picked ? code : undefined}
            onPick={(c) => {
              setCode(c);
              setFeedback(null);
            }}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="game-shares">
            委托股数
          </label>
          <input
            id="game-shares"
            className="text-input text-input-num"
            type="number"
            min={0}
            step={lot}
            value={sharesText}
            onChange={(e) => setSharesText(e.target.value)}
          />
          <div className="game-quantity-chips">
            <button type="button" className="chip chip-tiny" onClick={() => setSharesText("100")}>100 股</button>
            {[0.25, 0.5, 1].map((fraction) => (
              <button
                key={fraction}
                type="button"
                className="chip chip-tiny"
                disabled={fraction === 1 ? maxShares <= 0 : maxShares < lot}
                onClick={() => setSharesText(String(
                  side === "sell" && fraction === 1
                    ? maxShares
                    : Math.floor(maxShares * fraction / lot) * lot || lot,
                ))}
              >
                {fraction === 1 ? (side === "buy" ? "最大可买" : "全部可卖") : fraction === 0.25 ? "1/4" : "1/2"}
              </button>
            ))}
          </div>
          <p className="field-hint">
            {isHk
              ? "港股每手股数各股不同（快照里没有这份数据），这里不强制整手，按股填写即可"
              : `${side === "buy" ? "买入" : "卖出"}需为 ${LOT_SIZE} 股整数倍`}
            {side === "sell" && holding ? `，或一次性卖出全部 ${holding.shares} 股` : ""}
            {maxShares > 0 ? ` · 最多约 ${maxShares} 股` : ""}
          </p>
        </div>

        {picked && (
          <div className="kv-list">
            <KV k="标的" v={`${picked.code} ${picked.name}`} />
            <KV
              k="现价"
              v={
                pickedPrice === null
                  ? "—（无行情，不可下单）"
                  : `${fmtNum(pickedPrice)}${pickedQuote ? ` · ${sourceLabel(pickedQuote.source)}` : " · 本地快照"}`
              }
            />
            {holding && (
              <KV k="当前持仓" v={`${holding.shares} 股 · 可卖 ${holding.sellable} 股 · 成本 ${fmtNum(holding.avgCost)}`} />
            )}
            <OrderPreview
              price={pickedPrice}
              side={side}
              shares={shares}
              cash={account.cash}
              sellable={holding?.sellable ?? 0}
              today={today}
              market={marketGroupOf(picked.code)}
              fx={fxOf?.(picked.code) ?? null}
            />
            {pickedResult && (
              <KV
                k="引擎分类"
                v={
                  <>
                    <StateBadge state={pickedResult.type} size="sm" />
                    {pickedResult.type === "高位观察" && (
                      <span className="muted small">（属高位区间，请自行判断风险）</span>
                    )}
                  </>
                }
              />
            )}
          </div>
        )}

        {/*
          还没拿到实时报价时明说一句。
          这正是用户踩过的坑：下单卡显示的是快照昨收，成交也按它，等实时行情到了
          价格一跳到今天的价，账户立刻多出一笔浮盈。说清楚「这是昨天的价、还会变」，
          比让人自己猜好。
        */}
        {picked && pickedPrice !== null && !pickedQuote && (
          <p className="field-hint">
            现在这个是快照里的最近收盘价（通常是昨收），实时报价还没到。
            选中的标的已经加进行情请求，几秒后会换成实时价。
          </p>
        )}

        {!isTradingNow && (
          <Notice tone="info">
            当前为「{sessionText}」，此时委托按最近收盘价成交，并在成交记录中标注。
          </Notice>
        )}
        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={submit}>
            提交委托
          </button>
        </div>

        {feedback && (
          <Notice tone={feedback.ok ? "ok" : "warn"} role={feedback.ok ? "status" : "alert"}>
            {feedback.msg}
          </Notice>
        )}
      </Card>

      <Card title={`持仓（${account.holdings.length}）`}>
        {account.holdings.length === 0 ? (
          <EmptyHint>暂无持仓。买入成交后会出现在这里。</EmptyHint>
        ) : (
          <ul className="stock-list">
            {account.holdings.map((h) => {
              const pnl = positionPnl(h.shares, h.avgCost, prices.get(h.code));
              return (
                <li key={h.code} className="stock-row">
                  <div className="row-static">
                    <span className="row-title">
                      <button type="button" className="game-holding-pick" onClick={() => { setCode(h.code); setFeedback(null); }}>{h.name} <span>↗</span></button>
                      <span className="code">{h.code}</span>
                    </span>
                    <span className="row-metrics">
                      <span>持仓 {h.shares}</span>
                      <span>可卖 {h.sellable}</span>
                      <span>成本 {fmtNum(h.avgCost)}</span>
                      <span>现价 {fmtNum(prices.get(h.code) ?? null)}</span>
                      {pnl === null ? (
                        <span className="muted">无行情，不估算盈亏</span>
                      ) : (
                        <>
                          <span className={pnl.pnl >= 0 ? "tone-good" : "tone-bad"}>盈亏 {fmtNum(pnl.pnl)}</span>
                          <span className={pnl.pnl >= 0 ? "tone-good" : "tone-bad"}>{fmtPct(pnl.pnlPct)}</span>
                        </>
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      </div>

      <details className="game-detail-section">
        <summary><span>市场资讯</span><span className="game-detail-hint">展开查看最新资讯与持仓相关信息 <span>＋</span></span></summary>
      <NewsPanel
        items={news.items}
        source={news.source}
        degradedReason={news.degradedReason}
        updatedAt={news.updatedAt}
        loading={news.loading}
        onRefresh={news.refresh}
        holdings={account.holdings.map((h) => ({ code: h.code, name: h.name }))}
      />
      </details>

      <details className="game-detail-section">
        <summary><span>成交记录 <small>{account.trades.length} 笔</small></span><span className="game-detail-hint">查看每笔成交 <span>＋</span></span></summary>
      <Card title={`成交记录（${account.trades.length}）`} subtitle="最近 30 笔">
        {account.trades.length === 0 ? (
          <EmptyHint>暂无成交记录。</EmptyHint>
        ) : (
          <ul className="stock-list">
            {[...account.trades].reverse().slice(0, 30).map((t) => (
              <li key={t.id} className="stock-row">
                <div className="row-static">
                  <span className="row-title">
                    <span className="tag">{t.side === "buy" ? "买入" : "卖出"}</span>
                    <span className="name">{t.name}</span>
                    <span className="code">{t.code}</span>
                  </span>
                  <span className="row-metrics">
                    <span>{t.date}</span>
                    <span>{t.shares} 股</span>
                    <span>@{fmtNum(t.price)}</span>
                    <span>金额 {fmtNum(t.amount)}</span>
                    <span>费用 {fmtNum(t.fee)}</span>
                    {t.typeAtTrade && <span>当时分类「{t.typeAtTrade}」</span>}
                  </span>
                  {t.note && <p className="field-hint">{t.note}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      </details>

      <Card title="赛季结算" subtitle="与基准对照，避免牛市里人人都是股神">
        <div className="btn-row">
          <button
            type="button"
            className="btn"
            onClick={() => {
              const r = onSettle();
              setLastSeason(r);
              if (r === null) {
                setLastReview(null);
                setFeedback({ ok: false, msg: "净值点不足，无法结算。" });
                return;
              }
              setFeedback(null);
              // 复盘和结算共用同一份价格表，否则「成交后涨跌」会和上面的期末总资产对不上
              const finalPrices: Record<string, number | null> = {};
              for (const [code, price] of prices) finalPrices[code] = price;
              setLastReview(reviewReport({ account, finalPrices, season: r.season, asOf: r.endDate }));
            }}
          >
            结算本季
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              if (confirm("确定重置模拟游戏？所有持仓与成交记录将清空，不可恢复。")) {
                onReset();
                setLastSeason(null);
                setLastReview(null);
                setFeedback(null);
              }
            }}
          >
            重置模拟游戏
          </button>
        </div>

        {lastSeason && (
          <div className="metric-grid">
            <Metric k="期末总资产" v={fmtNum(lastSeason.finalAssets)} />
            <Metric k="收益率" v={fmtPct(lastSeason.totalReturnPct)} tone={pnlTone(lastSeason.totalReturnPct)} />
            <Metric k={`同期${benchmarkName}`} v={fmtPct(lastSeason.benchmarkReturnPct)} />
            <Metric k="超额收益" v={fmtPct(lastSeason.excessReturnPct)} tone={pnlTone(lastSeason.excessReturnPct)} />
            <Metric k="最大回撤" v={fmtPct(lastSeason.maxDrawdownPct)} />
            <Metric
              k="胜率"
              v={lastSeason.winRatePct === null ? "—（无平仓）" : fmtPct(lastSeason.winRatePct)}
            />
            <Metric k="区间" v={`${lastSeason.startDate} ~ ${lastSeason.endDate}`} />
            <Metric k="成交笔数" v={`${lastSeason.tradeCount} 笔`} />
          </div>
        )}

        {lastReview && <ReviewBlock report={lastReview} />}

        {account.seasons.length > 0 && (
          <ul className="stock-list">
            {account.seasons.map((s) => (
              <li key={s.season} className="stock-row">
                <div className="row-static">
                  <span className="row-title">
                    <span className="name">{s.season}</span>
                  </span>
                  <span className="row-metrics">
                    <span>收益 {fmtPct(s.totalReturnPct)}</span>
                    <span>基准 {fmtPct(s.benchmarkReturnPct)}</span>
                    <span>超额 {fmtPct(s.excessReturnPct)}</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ReplayEntryCard
        cashChoice={cashChoice}
        replayReady={replayReady}
        replayInProgress={replayInProgress}
        onResumeReplay={onResumeReplay}
        onStartReplay={onStartReplay}
        onOpenLegend={onOpenLegend}
      />
    </div>
  );
}
