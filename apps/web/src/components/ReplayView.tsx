/**
 * 历史推演视图 —— 「把你放回真实的某一天」。
 *
 * ⚠️ 与分析红线的关系：红线禁止的是**程序给出买卖建议**。本页是玩家自己的决策沙盒，
 * 买卖按钮表达的是玩家的操作意图。因此本页允许出现「买入/卖出」，但必须满足三条：
 *   1. 常驻免责声明；2. 不出现任何引导性方向的文案；3. 引擎分类只作客观依据展示。
 *
 * 与实时模式最需要讲清楚的一条规矩：**今天下单，按次一交易日开盘价成交**。
 * 玩家看到的是一整天的完整走势，若按当天收盘价成交就等于开了天眼。
 */
import { useEffect, useMemo, useState } from "react";
import {
  boardOf,
  describeRules,
  LOT_SIZE,
  totalAssets,
  type ReplayState,
  type SeasonResult,
  type Side,
} from "@aw/game";
import type { Currency, MarketGroup } from "@aw/core";
import { displayDate, maskDate, maskDatesIn, replayPrices, settleReplay, type ReplayMode } from "../lib/replay";
import { fmtNum, fmtPct } from "../lib/helpers";
import { EmptyHint, KV, RichP } from "./common";
import { StockPicker } from "./StockPicker";
import { amountOf, changePctOf, type PickStock } from "../lib/picks";
import { GAME_DISCLAIMER } from "../lib/game";
import { useDayNews } from "../lib/useDayNews";
import { DayNewsCard } from "./DayNewsCard";
import { ReplayChart } from "./ReplayChart";
import "./replay-view.css";

/** 市场的中文名，界面各处复用 */
const MARKET_NAME: Record<string, string> = { CN: "A 股", HK: "港股", US: "美股", JP: "日股", KR: "韩股" };

export interface ReplayViewProps {
  state: ReplayState;
  /** 模式 3（随机）为 true：只显示第几天，结算时才揭晓真实日期 */
  hideDate: boolean;
  /** 模式 2（传奇）的节点名 */
  label: string;
  /**
   * 可下单的标的清单。
   *
   * **只能来自这一局自己的标的池**（`state.config.instruments`）：
   * 随机模式是当前快照，传奇模式是那一关的历史分片。用当前快照去下单 2016 年的关卡，
   * 玩家会搜到当时根本还没上市的票，然后每一笔委托都提示「没有行情」。
   */
  stocks: Array<{
    code: string;
    name: string;
    /** 申万一级行业，用于候选清单分组。老分片没有这一列。境外的填市场名（港股/美股） */
    industry?: string;
    /**
     * 标的所属市场。
     *
     * 缺省按 `"CN"` —— 老分片里没有这一列，而那些分片全是 A 股。
     * 界面靠它决定写「T+1」还是「T+0」、提示几股起买。
     */
    market?: MarketGroup;
    /**
     * 计价币种。
     *
     * **价格已经折成人民币了**（折算发生在分片加载时），这一列只用来在界面上标注一句
     * 「原以港币计价、已折成人民币」，引擎全程只认人民币。
     */
    currency?: Currency;
    /** 与日历对齐的收盘价，算当日涨跌幅用 */
    close?: Array<number | null>;
    /** 与日历对齐的成交量，算当日成交额用 */
    volume?: Array<number | null>;
    /**
     * 窗口**前一天**的收盘价。
     *
     * 开局第一天（`dayIndex === 0`）`close[-1]` 不存在，没有它那一天所有股票的
     * 涨跌幅都算不出来，候选榜单会整个空掉 —— 而第一天恰恰是玩家最需要
     * 有人告诉他「有什么可买」的时候。
     */
    prevClose?: number | null;
  }>;
  benchmarkName: string;
  /**
   * 传奇模式（模式 2）的开局简报。
   *
   * 随机模式不传——那一局的规则就是「不告诉你这是哪一天」；
   * 传奇模式的规则相反：「这是哪一天、当时公开的信息有哪些」全都摊开给你看，
   * 因为你本来就知道后来发生了什么，装不知道才是不诚实的。
   */
  briefing?: { startDate: string; theme: string; lines: string[]; note?: string } | undefined;
  /**
   * 这一局是哪种推演。
   *
   * 页头那句眉题原来只按 `hideDate` 二分（藏日期 = 随机挑战，否则 = 传奇推演），
   * 于是回溯模式会被写成「传奇推演」—— 可它根本不是关卡。做法上加了这一列，
   * 而不是再去拆 `hideDate` 的含义：藏不藏日期和「这是哪一种玩法」是两件事。
   */
  mode?: ReplayMode;
  onOrder: (code: string, side: Side, shares: number) => { ok: boolean; reason?: string };
  onCancel: (orderId: string) => void;
  /** 推进 n 个交易日 */
  onAdvance: (n: number) => void;
  onExit: () => void;
}

/** 序列里的第 i 项，不是有限数就当没有（分片里可能是 null）。 */
function numOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function accountFirstCode(state: ReplayState, stocks: ReplayViewProps["stocks"]): string {
  const holding = state.account.holdings.find((h) => stocks.some((s) => s.code === h.code));
  return holding?.code ?? stocks.find((s) => {
    const inst = state.config.instruments.find((i) => i.code === s.code);
    return typeof inst?.close[state.dayIndex] === "number";
  })?.code ?? stocks[0]?.code ?? "";
}

function Metric({ k, v, tone }: { k: string; v: string; tone?: "good" | "bad" | "muted" }) {
  return (
    <div className="replay-metric">
      <span className="replay-metric-k">{k}</span>
      <span className={`replay-metric-v${tone ? ` tone-${tone}` : ""}`}>{v}</span>
    </div>
  );
}

export function ReplayView(props: ReplayViewProps) {
  const { state, hideDate, label, stocks, benchmarkName, briefing, mode = "legend", onOrder, onCancel, onAdvance, onExit } = props;

  const [side, setSide] = useState<Side>("buy");
  const [code, setCode] = useState(() => accountFirstCode(state, stocks));
  const [sharesText, setSharesText] = useState("100");
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [lastSeason, setLastSeason] = useState<SeasonResult | null>(null);
  const [lastSeasonDay, setLastSeasonDay] = useState(0);
  const [showStocks, setShowStocks] = useState(false);
  const [mobilePane, setMobilePane] = useState<"trade" | "market" | "account">("trade");

  const { account, calendar, startIndex } = {
    account: state.account,
    calendar: state.config.calendar,
    startIndex: state.config.startIndex,
  };
  const dayNo = state.dayIndex - startIndex + 1;
  const date = calendar[state.dayIndex] ?? "";
  const totalDays = calendar.length - startIndex;

  // 这一天的资讯：离线归档，按日期读一份。取不到就当没有，不编。
  const dayNews = useDayNews(date);

  const prices = useMemo(() => replayPrices(state), [state]);

  /**
   * 「不知道买什么」那份榜单的数据来源。
   *
   * 涨跌幅取的是**当天的收盘对前一天收盘** —— 推演里一天已经走完，
   * 这个数就是玩家在这一步看到的那根 K 线的涨跌，和界面上其他地方一致。
   */
  const pickRows = useMemo<PickStock[]>(() => {
    const day = state.dayIndex;
    return stocks.map((s) => {
      const close = s.close ?? [];
      const price = numOrNull(close[day]);
      // 第一天没有「昨天」，用分片带进来的窗口前一天收盘价顶替
      const prev = day > 0 ? numOrNull(close[day - 1]) : numOrNull(s.prevClose);
      return {
        code: s.code,
        name: s.name,
        sector: s.industry ?? "",
        price,
        changePct: changePctOf(price, prev),
        amount: amountOf(price, numOrNull((s.volume ?? [])[day])),
      };
    });
  }, [stocks, state.dayIndex]);
  const stockByCode = useMemo(() => new Map(stocks.map((s) => [s.code, s])), [stocks]);
  const picked = code ? stockByCode.get(code) : undefined;

  /**
   * 市场决定三件事：当天能不能卖、几股起买、有没有涨跌停。
   *
   * 这三条必须和引擎里 `packages/game/src/rules.ts` 的判断一致 ——
   * 界面写「T+1」而引擎按 T+0 放行，玩家会以为自己卖不掉，白等一天。
   */
  const pickedMarket = picked?.market ?? "CN";
  const isOverseas = pickedMarket !== "CN";
  const tPlusOne = pickedMarket === "CN";
  // 日股是 100 股一手（単元株）；港股各股不同、分片里没有这份数据，按 100 简化
  const minLot = pickedMarket === "US" || pickedMarket === "KR" ? 1 : 100;
  /** 快捷股数：A 股/港股一手 100 股，美股与韩股 1 股起 */
  const quickShares = minLot === 1 ? [1, 10, 100] : [100, 300, 500];
  /** A 股的后缀是噪音，港美股的 `.HK` / `.US` 是信息 —— 只剥前者 */
  const shortCode = (c: string) => c.replace(/\.(SH|SZ|BJ)$/, "");
  const holding = account.holdings.find((h) => h.code === code);
  const shares = Number(sharesText);

  const holdingsValue = account.holdings.reduce((sum, h) => {
    const price = prices[h.code];
    return sum + (price === null || price === undefined ? h.avgCost : price) * h.shares;
  }, 0);
  const assets = totalAssets(account, prices);
  const totalReturnPct = account.initialCash > 0 ? (assets / account.initialCash - 1) * 100 : 0;
  const pnlTone = (v: number) => (v >= 0 ? "good" : "bad");

  // 推进只由「下一天」「结束」两个按钮触发，没有定时器，所以没有需要清理的副作用。

  function submit() {
    setFeedback(null);
    if (!code) return setFeedback({ ok: false, msg: "请先选择股票。" });
    if (!Number.isInteger(shares) || shares <= 0) {
      return setFeedback({ ok: false, msg: "委托股数必须为正整数。" });
    }
    const res = onOrder(code, side, shares);
    setFeedback(
      res.ok
        ? { ok: true, msg: `已挂单：${side === "buy" ? "买入" : "卖出"} ${shares} 股，将在次一交易日开盘价成交。` }
        : { ok: false, msg: res.reason ?? "挂单失败。" },
    );
    if (res.ok) setSharesText("100");
  }

  function finish() {
    const { result } = settleReplay(state, `${label} · ${displayDate(state, hideDate)}`);
    setLastSeason(result);
    setLastSeasonDay(dayNo);
  }

  const pending = state.pending;
  const recentLog = state.log.slice(-12).reverse();

  const selectedPrice = picked ? prices[picked.code] ?? null : null;
  const selectedRow = pickRows.find((s) => s.code === code);
  const progress = Math.min(100, (dayNo / Math.max(1, totalDays)) * 100);
  const nextDate = calendar[state.dayIndex + 1];
  const nextDayLabel = nextDate ? maskDate(state, nextDate, hideDate) : "本局已结束";

  return (
    <div className="view replay-game" data-mobile-pane={mobilePane}>
      <header className="replay-mission">
        <div>
          <p className="replay-eyebrow">{mode === "backtrack" ? "RECENT REVIEW / 回溯复盘" : hideDate ? "RANDOM CHALLENGE / 随机挑战" : "HISTORICAL CAMPAIGN / 传奇推演"}</p>
          <h1>{label}</h1>
          <p className="replay-mission-note">{briefing ? maskDatesIn(state, briefing.theme, hideDate) : mode === "backtrack" ? "从您挑的那一天开始，按当天的真实行情往下走。全程只有 A 股。" : "回到一个未知的交易日，用当时的信息作出自己的判断。"}</p>
        </div>
        <div className="replay-mission-meta">
          <span className="replay-date">{hideDate ? `第 ${dayNo} 天` : date}</span>
          <button type="button" className="btn btn-ghost btn-tiny" onClick={() => {
            if (confirm("退出本局？当前账户与成交记录将清空，不可恢复。")) onExit();
          }}>退出游戏 ↗</button>
        </div>
      </header>

      <div className="replay-timebar">
        <div className="replay-day-status">
          <span className="replay-status-dot"/>
          <div><strong>{state.finished ? "推演完成" : "当前交易日"}</strong><span>第 {dayNo} / {totalDays} 个交易日</span></div>
        </div>
        <div className="replay-time-actions">
          <button type="button" className="btn btn-primary" disabled={state.finished} onClick={() => onAdvance(1)}>下一天 →</button>
          <button type="button" className="btn btn-ghost replay-skip" disabled={state.finished} onClick={() => {
            if (confirm("直接推进到本局最后一天？期间的委托将照常撮合。")) onAdvance(totalDays - dayNo);
          }}>结束 »</button>
        </div>
        <div className="replay-progress" role="progressbar" aria-label="推演进度" aria-valuemin={0} aria-valuemax={totalDays} aria-valuenow={dayNo}><span style={{ width: `${progress}%` }}/></div>
      </div>

      <section className="replay-account" aria-label="模拟账户">
        <Metric k="账户总资产 / 元" v={fmtNum(assets)} />
        <Metric k="可用资金" v={fmtNum(account.cash)} />
        <Metric k="持仓市值" v={fmtNum(holdingsValue)} />
        <Metric k="总收益率" v={fmtPct(totalReturnPct)} tone={pnlTone(totalReturnPct)} />
        <Metric k="成交笔数" v={`${account.trades.length} 笔`} />
      </section>

      <div className="replay-phone-tabs" role="group" aria-label="推演功能切换">
        <button type="button" aria-pressed={mobilePane === "trade"} onClick={() => setMobilePane("trade")}>下单交易</button>
        <button type="button" aria-pressed={mobilePane === "market"} onClick={() => setMobilePane("market")}>行情资讯</button>
        <button type="button" aria-pressed={mobilePane === "account"} onClick={() => setMobilePane("account")}>持仓成绩</button>
      </div>
      <div className="replay-workspace">
        <section className="replay-panel replay-stock-selection">
          <div className="replay-stock-search field">
              <label className="field-label" htmlFor="replay-code">股票</label>
              <div className="replay-search-row"><input id="replay-code" className="text-input" placeholder="搜索股票名称或代码" value={code} onChange={(e) => {
                const v = e.target.value.trim();
                const hit = stocks.find((s) => s.code === v || s.name === v);
                setCode(hit ? hit.code : v);
                setFeedback(null);
                setShowStocks(true);
              }}/><button type="button" className="btn btn-ghost" aria-expanded={showStocks} aria-controls="replay-stock-list" onClick={() => setShowStocks((p) => !p)}>{showStocks ? "收起列表 ▴" : "更换股票 ▾"}</button></div>
              {showStocks && <div id="replay-stock-list"><StockPicker rows={pickRows} query={picked ? "" : code} activeCode={picked ? code : undefined} onPick={(c) => { setCode(c); setFeedback(null); setShowStocks(false); }}/></div>}
            </div>
        </section>
        <div className="replay-market-column">
          <section className="replay-panel replay-market-panel">
            <header className="replay-panel-head">
              <div><p className="replay-eyebrow">MARKET / 当时的市场</p><h2>{picked?.name ?? "选择观察标的"}<span className="replay-stock-code">{picked ? shortCode(picked.code) : ""}</span></h2></div>
              <div className="replay-quote"><strong>{selectedPrice === null ? "—" : fmtNum(selectedPrice)}</strong><span className={selectedRow?.changePct === null || selectedRow?.changePct === undefined ? "tone-muted" : `tone-${pnlTone(selectedRow.changePct)}`}>{fmtPct(selectedRow?.changePct ?? null)} <small>当日涨跌</small></span></div>
            </header>
            <details className="replay-chart-details">
              <summary>查看走势图与成交标记 <span>＋</span></summary>
            <ReplayChart state={state} code={code} hideDate={hideDate}/>
            <p className="replay-data-note">{picked?.industry ? `${picked.industry} · ` : ""}历史行情 · 红涨绿跌 · 买卖标记按真实成交日显示{isOverseas ? ` · 原以${picked?.currency === "HKD" ? "港币" : "美元"}计价，此处已按当日汇率折成人民币` : ""}</p>
            </details>
          </section>

          <div className="replay-information">
            {briefing && <details className="replay-details">
              <summary><span>开局简报<small>{hideDate ? "入场时的公开信息" : `${briefing.startDate} · 入场时的公开信息`}</small></span><span className="replay-expand"><span className="replay-expand-closed">展开 +</span><span className="replay-expand-open">收起 −</span></span></summary>
              <div className="replay-details-body"><ul className="briefing-list">{briefing.lines.map((line, i) => <li key={i}>{maskDatesIn(state, line, hideDate)}</li>)}</ul><RichP className="hint">简报只写到进场那天。后续发生的事，需要您在推演中观察。</RichP>{briefing.note && <RichP className="hint">{maskDatesIn(state, briefing.note, hideDate)}</RichP>}</div>
            </details>}
            <details className="replay-details">
              <summary><span>当天资讯<small>{dayNews.loading ? "正在读取归档" : dayNews.news?.items.length ? `${dayNews.news.items.length} 条历史归档` : "当前日期暂无资讯归档"}</small></span><span className="replay-expand"><span className="replay-expand-closed">展开 +</span><span className="replay-expand-open">收起 −</span></span></summary>
              <div className="replay-details-body"><DayNewsCard loading={dayNews.loading} missing={dayNews.missing} items={dayNews.news?.items ?? []} source={dayNews.news?.source} mask={(t) => maskDatesIn(state, t, hideDate)}/></div>
            </details>
            {picked && (
              // 每个市场的规则不一样，而这正是加港美股的意义：
              // 同一个「买 100 股」的动作，三个市场付的费用、能不能当天卖、几股起买全都不同。
              // 默认给境外标的展开，因为差异最多、玩家最容易按 A 股的习惯去操作。
              <details className="replay-details" open={isOverseas}>
                <summary><span>{MARKET_NAME[pickedMarket]}交易规则<small>和 A 股逐条对照</small></span><span className="replay-expand"><span className="replay-expand-closed">展开 +</span><span className="replay-expand-open">收起 −</span></span></summary>
                <div className="replay-details-body">
                  <ul className="briefing-list">{describeRules(date, boardOf(picked.code), pickedMarket).map((line, i) => <li key={i}>{line}</li>)}</ul>
                  <RichP className="hint">费用按{hideDate ? "当时" : date}的规则计算。港股与美股按本币原价成交，界面上的金额已折成人民币；汇率变动也会计入您的收益。</RichP>
                </div>
              </details>
            )}
          </div>
        </div>

        <aside className="replay-trade-column">
          <section className="replay-panel replay-order-panel">
            <header className="replay-panel-head"><div><p className="replay-eyebrow">YOUR MOVE / 您的决策</p><h2>模拟下单</h2></div><span className="replay-rule-tag">{tPlusOne ? "T+1" : "T+0"}</span></header>
            <div className="replay-order-body">
              <div className="replay-side-tabs" aria-label="委托方向"><button type="button" className={side === "buy" ? "is-active" : ""} aria-pressed={side === "buy"} onClick={() => { setSide("buy"); setFeedback(null); }}>买入</button><button type="button" className={side === "sell" ? "is-active" : ""} aria-pressed={side === "sell"} onClick={() => { setSide("sell"); setFeedback(null); }}>卖出</button></div>
              <div className="replay-order-stock"><span>当前标的</span><strong>{picked ? picked.name : "请先选择股票"}{selectedPrice !== null && <small> · ¥ {fmtNum(selectedPrice)}</small>}</strong></div>
              <div className="field"><label className="field-label" htmlFor="replay-shares">委托股数</label><input id="replay-shares" className="text-input text-input-num" type="number" min={1} step={minLot} value={sharesText} onChange={(e) => setSharesText(e.target.value)}/><div className="replay-quantity-buttons">{quickShares.map((n) => <button key={n} type="button" onClick={() => setSharesText(String(n))}>{n} 股</button>)}{side === "sell" && holding && <button type="button" disabled={holding.sellable === 0} onClick={() => setSharesText(String(holding.sellable))}>可卖全部</button>}</div><p className="field-hint">{pickedMarket === "US"
  ? "美股 1 股起买 · 无涨跌停 · 当日买入当日可卖"
  : pickedMarket === "HK"
    ? "港股按手交易，本模拟统一按 100 股一手 · 无涨跌停 · 当日买入当日可卖"
    : pickedMarket === "JP"
      ? "日股一手 100 股（単元株）· 无涨跌停百分比 · 当日买入当日可卖"
      : pickedMarket === "KR"
        ? "韩股 1 股起 · 涨跌停 ±30% · 当日买入当日可卖，卖出收 0.20% 证券交易税"
        : `常规一手 ${LOT_SIZE} 股 · 科创板至少 200 股 · 当日买入次日才可卖`}{holding ? ` · 持有 ${holding.shares} / 可卖 ${holding.sellable}` : ""}</p></div>
              <div className="replay-order-estimate"><span>按收盘价参考金额</span><strong>{selectedPrice !== null && shares > 0 && Number.isFinite(shares) ? `¥ ${fmtNum(selectedPrice * shares)}` : "—"}</strong></div>
              <div className="replay-matching-note"><span aria-hidden="true">◷</span><p>今天挂单，按<strong>次一交易日开盘价</strong>撮合。金额以实际成交价、滑点和费用为准。</p></div>
              <button type="button" className="btn btn-primary replay-submit" disabled={state.finished} onClick={submit}>{state.finished ? "推演已结束" : `挂出${side === "buy" ? "买" : "卖"}单 →`}</button>
              {feedback && <p className={feedback.ok ? "replay-feedback is-ok" : "replay-feedback is-error"} role="status">{feedback.msg}</p>}
            </div>
          </section>

          <details className="replay-panel replay-pending-panel" key={pending.length === 0 ? "empty" : "pending"} open={pending.length > 0 || undefined}><summary><span>待成交委托</span><span className="replay-count">{pending.length} 笔 ＋</span></summary><div className="replay-pending-body"><p className="replay-next-open">下次撮合：{nextDayLabel}</p>{pending.length === 0 ? <EmptyHint>暂无挂单。提交委托后，点「下一天」等待成交。</EmptyHint> : <ul className="replay-order-list">{pending.map((o) => <li key={o.id}><div><strong><span className={`replay-side-label ${o.side}`}>{o.side === "buy" ? "买" : "卖"}</span>{o.name}</strong><span>{o.shares} 股 · {maskDate(state, o.placedAt, hideDate)}挂出</span></div><button type="button" className="btn btn-ghost btn-tiny" onClick={() => onCancel(o.id)}>撤单</button></li>)}</ul>}<p className="field-hint">次日无开盘价（停牌或数据缺失）时作废；请查看推演日志。</p></div></details>
        </aside>
      </div>

      <section className="replay-panel replay-holdings-panel"><header className="replay-panel-head"><div><h2>我的持仓 <span className="replay-count">{account.holdings.length}</span></h2><p>按{hideDate ? "当前交易日" : date}收盘价估值 · A 股当日买入次日才可卖{mode === "backtrack" ? "" : "，港美股当日可卖 · 境外标的已折成人民币"}</p></div></header>{account.holdings.length === 0 ? <div className="replay-empty-holdings"><span aria-hidden="true">◇</span><div><strong>还没有持仓</strong><p>挂出买单，再推进一个交易日。成交的股票会出现在这里。</p></div></div> : <div className="replay-holding-list">{account.holdings.map((h) => {
        const price = prices[h.code] ?? null;
        const pnl = price === null ? null : (price - h.avgCost) * h.shares;
        return <div key={h.code} className="replay-holding-row"><div className="replay-holding-name"><strong>{h.name}</strong><span>{shortCode(h.code)}</span></div><div><span>持有 / 可卖</span><strong>{h.shares} / {h.sellable}</strong></div><div><span>成本 / 收盘</span><strong>{fmtNum(h.avgCost)} / {price === null ? "—" : fmtNum(price)}</strong></div><div><span>持仓盈亏</span><strong className={pnl === null ? "tone-muted" : `tone-${pnlTone(pnl)}`}>{pnl === null ? "—" : fmtNum(pnl)}</strong></div><button type="button" className="btn btn-ghost btn-tiny" onClick={() => { setCode(h.code); setSide("sell"); setSharesText(String(h.sellable || 100)); setFeedback(null); setMobilePane("trade"); requestAnimationFrame(() => document.getElementById("replay-shares")?.scrollIntoView({ behavior: "smooth", block: "center" })); }}>查看 / 卖出 ↗</button></div>;
      })}</div>}</section>

      <div className="replay-bottom-grid">
        <section className="replay-panel replay-results"><header className="replay-panel-head"><div><p className="replay-eyebrow">PERFORMANCE / 本局表现</p><h2>{state.finished ? "本局结算" : "阶段成绩"}</h2></div><button type="button" className="btn btn-primary btn-tiny" onClick={finish}>{state.finished ? "结算本局" : "查看阶段结算"}</button></header><div className="replay-results-body">{state.finished ? <p className="replay-result-note">已走完最后一个交易日。查看成绩后，可退出游戏开始新一局。</p> : <p className="replay-result-note">阶段结算只查看当前成绩，您仍可继续推进和下单。</p>}{lastSeason ? <><p className="replay-snapshot-date">截至第 {lastSeasonDay} 天{lastSeasonDay !== dayNo ? " · 可重新查看最新成绩" : ""}</p><div className="kv-list"><KV k="本局区间" v={hideDate ? `第 1 天 → 第 ${lastSeasonDay} 天` : `${lastSeason.startDate} → ${lastSeason.endDate}`}/><KV k="期末总资产" v={`${fmtNum(lastSeason.finalAssets)} 元`}/><KV k="总收益率" v={fmtPct(lastSeason.totalReturnPct)}/><KV k={`同期${benchmarkName}`} v={fmtPct(lastSeason.benchmarkReturnPct)}/><KV k="超额收益" v={fmtPct(lastSeason.excessReturnPct)}/><KV k="最大回撤" v={fmtPct(-lastSeason.maxDrawdownPct)}/><KV k="胜率" v={lastSeason.winRatePct === null ? "—（无平仓）" : fmtPct(lastSeason.winRatePct)}/><KV k="成交笔数" v={`${lastSeason.tradeCount} 笔`}/></div></> : <div className="replay-result-empty"><span>{account.trades.length} 笔成交</span><strong className={`tone-${pnlTone(totalReturnPct)}`}>{fmtPct(totalReturnPct)}</strong><small>查看结算，对照同期{benchmarkName}、回撤与胜率。</small></div>}</div></section>
        <details className="replay-panel replay-log-panel replay-log-details"><summary><span>推演日志 · 最近 {recentLog.length} 条</span><span>＋</span></summary><div className="replay-log-body">{recentLog.length === 0 ? <EmptyHint>尚无成交记录。推进交易日后，撮合结果会记录在这里。</EmptyHint> : <ul className="replay-log-list">{recentLog.map((e, i) => <li key={`${e.date}-${e.code}-${i}`}><span className={`replay-log-dot${e.ok ? " is-ok" : ""}`}/><p className={e.ok ? "" : "tone-muted"}>{maskDatesIn(state, e.text, hideDate)}</p></li>)}</ul>}</div></details>
      </div>
      <p className="game-disclaimer replay-disclaimer" role="note">{`⚠️ ${GAME_DISCLAIMER}`}</p>
    </div>
  );
}
