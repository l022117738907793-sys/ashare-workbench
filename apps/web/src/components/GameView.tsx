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
import { useMemo, useState } from "react";
import { LOT_SIZE, reviewReport, type ReviewReport, type SeasonResult, type Side } from "@aw/game";
import type { StockData, StockResult } from "@aw/core";
import { sourceLabel, type Quote } from "@aw/data";
import { StockPicker } from "./StockPicker";
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
  onOrder: (code: string, side: Side, shares: number) => { ok: boolean; reason?: string };
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

/**
 * 「历史推演」的入口卡。
 *
 * 开局之后也要留着 —— 玩家常常先开一局实时模式，过一会儿才想试试推演。
 * 这张卡以前只画在未开局的那张界面上，一开局入口就没了，想玩推演只能把实时
 * 那份存档重置掉（用户就是这么踩到的）。
 */
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
    <Card title="历史推演" subtitle="把你放回真实的某一天，一天走一步">
      {replayInProgress ? (
        /*
         * 已经有一局在跑时不能再开一局 —— 那会把那一局冲掉。
         *
         * 两边各有各的存档（aw.game.v1 / aw.replay.v1），本来就能同时进行，
         * 所以这里给的是「回去」，不是「重开」。
         */
        <>
          <Notice tone="info">
            你已经有一局历史推演在跑。它和实时模式各存各的，互不影响。
          </Notice>
          <div className="btn-row">
            <button type="button" className="btn btn-primary" onClick={onResumeReplay}>
              回到正在跑的那一局
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="rule-body">
            从<strong>过去</strong>的某个交易日开局，每点一次「走一天」推进一步，
            走的全是真实发生过的行情。
          </p>
          <p className="rule-body">
            今天下单<strong>按次一交易日的开盘价成交</strong> ——
            你看到的是一整天的完整走势。
          </p>

          <div className="kv-list">
            <KV k="初始资金" v={`${cashChoice / 10000} 万（沿用上面的选择）`} />
            <KV k="结算方式" v="真实历史日线，按当时的规则（费率、涨跌停、T+1 都按那一天算）" />
            <KV k="快进" v="1.5 秒一天，快进期间照常可以挂单" />
          </div>

          {replayReady ? (
            <div className="btn-row">
              <button type="button" className="btn btn-primary" onClick={onOpenLegend}>
                传奇模式 · 10 个历史时刻
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => onStartReplay(cashChoice)}>
                随机开局（不显示日期）
              </button>
            </div>
          ) : (
            <Notice tone="warn">
              当前这份快照里没有开盘价，暂时做不了历史推演。等下一次每日快照更新后再来。
            </Notice>
          )}

          <p className="field-hint">
            <strong>传奇模式</strong>给完整日期和进场简报，<strong>随机模式</strong>不告诉你这是哪一年哪一天 ——
            差别只在开局那一步。
          </p>
        </>
      )}
    </Card>
  );
}

export function GameView(props: GameViewProps) {
  const {
    state, prices, quotesByCode, stocks, resultsByCode,
    onOrder, onStart, onReset, onSettle, onOpenRules, news, sessionText, isTradingNow,
    benchmarkName, benchmarkReturnPct, totalAssets, holdingsValue,
    replayReady, onStartReplay, onOpenLegend,
    replayInProgress = false, onResumeReplay,
    away = null, onDismissAway,
  } = props;

  const { account, equity } = state;
  const [side, setSide] = useState<Side>("buy");
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
      return {
        code: s.code,
        name: s.name,
        sector: s.industry,
        price,
        changePct: q?.changePct ?? changePctOf(price, prevClose),
        amount: q?.amount ?? amountOf(price, n > 0 ? numOrNull(s.volume[n - 1]) : null),
        signal: resultsByCode.get(s.code)?.type ?? null,
      };
    });
  }, [stocks, prices, quotesByCode, resultsByCode]);
  const picked = code ? stockByCode.get(code) : undefined;
  const pickedPrice = code ? (prices.get(code) ?? null) : null;
  const pickedQuote = code ? quotesByCode.get(code) : undefined;
  const pickedResult = code ? resultsByCode.get(code) : undefined;

  const holding = account.holdings.find((h) => h.code === code);
  const shares = Number(sharesText);
  const maxShares = suggestedMaxShares(side, pickedPrice, account.cash, holding?.sellable ?? 0);

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
      setFeedback({
        ok: true,
        msg: isTradingNow
          ? `已成交 ${shares} 股。`
          : `已成交 ${shares} 股（当前「${sessionText}」，按最近收盘价成交，非实时价）。`,
      });
      setSharesText("100");
    } else {
      setFeedback({ ok: false, msg: res.reason ?? "下单失败。" });
    }
  }

  // ── 未开局：先设初始资金 ──────────────────────────────────
  if (state.status === "idle") {
    return (
      <div className="view">
        <p className="game-disclaimer" role="note">
          ⚠️ {GAME_DISCLAIMER}
        </p>

        <Card title="实时模式" subtitle="从现在开始，按现实规则结算">
          <p className="rule-body">
            先选初始资金。A 股一手 100 股 —— 10 万块买不起一手高价股。
          </p>

          <div className="cash-options">
            {CASH_OPTIONS.map((c) => (
              <button
                key={c}
                type="button"
                className={`chip${cashChoice === c ? " chip-active" : ""}`}
                onClick={() => setCashChoice(c)}
              >
                {c / 10000} 万
              </button>
            ))}
          </div>

          <div className="kv-list">
            <KV k="结算方式" v="真实行情，按现实规则（T+1、涨跌停、手续费、滑点）" />
            <KV k="交易时段" v={`${sessionText} · 非交易时段下单按最近收盘价成交并标注`} />
            <KV k="成绩基准" v={`跑赢${benchmarkName}才算有效成绩`} />
            <KV k="数据来源" v="行情：腾讯/东方财富　新闻：东方财富 7x24" />
          </div>

          <Notice tone="info">
            开局后账户不可恢复，但可以随时重置重来。所有数据只存在你自己的浏览器里。
          </Notice>

          <div className="btn-row">
            <button type="button" className="btn btn-primary" onClick={() => onStart(cashChoice)}>
              以 {cashChoice / 10000} 万开始
            </button>
            <button type="button" className="btn btn-ghost" onClick={onOpenRules}>
              撮合规则说明
            </button>
          </div>
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

  return (
    <div className="view">
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
          <Metric
            k={`同期${benchmarkName}`}
            v={benchmarkReturnPct === null ? "—" : fmtPct(benchmarkReturnPct)}
          />
          <Metric k="超额收益" v={excessPct === null ? "—" : fmtPct(excessPct)} tone={pnlTone(excessPct)} />
          <Metric k="成交笔数" v={`${account.trades.length} 笔`} />
          <Metric k="持仓只数" v={`${account.holdings.length} 只`} />
        </div>
      </Card>

      {away && onDismissAway && <AwayCard report={away} onDismiss={onDismissAway} />}

      <NewsPanel
        items={news.items}
        source={news.source}
        degradedReason={news.degradedReason}
        updatedAt={news.updatedAt}
        loading={news.loading}
        onRefresh={news.refresh}
        holdings={account.holdings.map((h) => ({ code: h.code, name: h.name }))}
      />

      <Card
        title="模拟下单"
        subtitle={`一手 ${LOT_SIZE} 股 · T+1：当日买入次日才可卖`}
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
            step={LOT_SIZE}
            value={sharesText}
            onChange={(e) => setSharesText(e.target.value)}
          />
          <p className="field-hint">
            {side === "buy" ? "买入" : "卖出"}需为 {LOT_SIZE} 股整数倍
            {side === "sell" && holding ? `，或一次性卖出全部 ${holding.shares} 股` : ""}
            {maxShares > 0 ? ` · 最多约 ${maxShares} 股` : ""}
          </p>
        </div>

        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={submit}>
            提交委托
          </button>
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

        {!isTradingNow && (
          <Notice tone="info">
            当前为「{sessionText}」，此时委托按最近收盘价成交，并在成交记录中标注。
          </Notice>
        )}
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
                      <span className="name">{h.name}</span>
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
