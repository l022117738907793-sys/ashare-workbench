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
  LOT_SIZE,
  totalAssets,
  type ReplayState,
  type SeasonResult,
  type Side,
} from "@aw/game";
import { displayDate, maskDate, maskDatesIn, replayPrices, settleReplay } from "../lib/replay";
import { fmtNum, fmtPct } from "../lib/helpers";
import { Card, EmptyHint, KV, Notice } from "./common";

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
  stocks: Array<{ code: string; name: string }>;
  benchmarkName: string;
  /**
   * 传奇模式（模式 2）的开局简报。
   *
   * 随机模式不传——那一局的规则就是「不告诉你这是哪一天」；
   * 传奇模式的规则相反：「这是哪一天、当时公开的信息有哪些」全都摊开给你看，
   * 因为你本来就知道后来发生了什么，装不知道才是不诚实的。
   */
  briefing?: { startDate: string; theme: string; lines: string[]; note?: string } | undefined;
  onOrder: (code: string, side: Side, shares: number) => { ok: boolean; reason?: string };
  onCancel: (orderId: string) => void;
  /** 推进 n 个交易日 */
  onAdvance: (n: number) => void;
  onExit: () => void;
}

/** 快进速度：1.5 秒一天（用户指定）。快进期间照常可以下单。 */
export const FAST_FORWARD_MS = 1500;

function Metric({ k, v, tone }: { k: string; v: string; tone?: "good" | "bad" | "muted" }) {
  return (
    <div className="metric">
      <span className="metric-k">{k}</span>
      <span className={`metric-v${tone ? ` tone-${tone}` : ""}`}>{v}</span>
    </div>
  );
}

export function ReplayView(props: ReplayViewProps) {
  const { state, hideDate, label, stocks, benchmarkName, briefing, onOrder, onCancel, onAdvance, onExit } = props;

  const [side, setSide] = useState<Side>("buy");
  const [code, setCode] = useState("");
  const [sharesText, setSharesText] = useState("100");
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [lastSeason, setLastSeason] = useState<SeasonResult | null>(null);

  const { account, calendar, startIndex } = {
    account: state.account,
    calendar: state.config.calendar,
    startIndex: state.config.startIndex,
  };
  const dayNo = state.dayIndex - startIndex + 1;
  const date = calendar[state.dayIndex] ?? "";
  const totalDays = calendar.length - startIndex;

  const prices = useMemo(() => replayPrices(state), [state]);
  const stockByCode = useMemo(() => new Map(stocks.map((s) => [s.code, s])), [stocks]);
  const picked = code ? stockByCode.get(code) : undefined;
  const holding = account.holdings.find((h) => h.code === code);
  const shares = Number(sharesText);

  const holdingsValue = account.holdings.reduce((sum, h) => {
    const price = prices[h.code];
    return sum + (price === null || price === undefined ? h.avgCost : price) * h.shares;
  }, 0);
  const assets = totalAssets(account, prices);
  const totalReturnPct = account.initialCash > 0 ? (assets / account.initialCash - 1) * 100 : 0;
  const pnlTone = (v: number) => (v >= 0 ? "good" : "bad");

  // 快进：1.5 秒一天。玩家可以在播放中继续下单——挂单会在各自的开盘时点成交。
  useEffect(() => {
    if (!playing || state.finished) return;
    const t = setInterval(() => onAdvance(1), FAST_FORWARD_MS);
    return () => clearInterval(t);
  }, [playing, state.finished, onAdvance]);

  // 本局走完就自动停下，不然按钮会一直在"播放中"卡住
  useEffect(() => {
    if (state.finished) setPlaying(false);
  }, [state.finished]);

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
  }

  const pending = state.pending;
  const recentLog = state.log.slice(-12).reverse();

  return (
    <div className="view">
      <p className="game-disclaimer" role="note">
        ⚠️ 模拟盘 · 虚拟资金 · 不构成投资建议
      </p>

      {briefing ? (
        <Card title="开局简报" subtitle={`你进场的那一天：${briefing.startDate} · 当时能看到的只有这些`}>
          <ul className="briefing-list">
            {briefing.lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          <Notice tone="info">
            <strong>这一局要想清楚的是：</strong>
            {briefing.theme}
          </Notice>
          <p className="hint">
            你知道后来发生了什么，但当时的人不知道。简报只写到进场那天为止——后面每一天的新闻和行情，
            要自己走一天看一天。
          </p>
          {briefing.note ? <p className="hint">{briefing.note}</p> : null}
        </Card>
      ) : null}

      <Card
        title={label}
        subtitle={`${hideDate ? `第 ${dayNo} 天` : date} · 共 ${totalDays} 个交易日 · 已走 ${dayNo} 天`}
        right={
          <button
            type="button"
            className="btn btn-ghost btn-tiny"
            onClick={() => {
              if (confirm("结束本局历史推演？当前账户与成交记录将清空，不可恢复。")) onExit();
            }}
          >
            退出推演
          </button>
        }
      >
        <Notice tone="info">
          今天下单，<strong>按次一交易日的开盘价成交</strong>。你看到的是已经走完的一整天，
          所以不能用今天收盘价成交 —— 那等于开了天眼。快进期间挂单照样有效。
        </Notice>

        <div className="metric-grid">
          <Metric k="总资产" v={fmtNum(assets)} />
          <Metric k="可用资金" v={fmtNum(account.cash)} />
          <Metric k="持仓市值" v={fmtNum(holdingsValue)} />
          <Metric k="总收益率" v={fmtPct(totalReturnPct)} tone={pnlTone(totalReturnPct)} />
          <Metric k="持仓只数" v={`${account.holdings.length} 只`} />
          <Metric k="成交笔数" v={`${account.trades.length} 笔`} />
        </div>

        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={state.finished}
            onClick={() => onAdvance(1)}
          >
            走一天
          </button>
          <button
            type="button"
            className="btn"
            disabled={state.finished}
            onClick={() => setPlaying((p) => !p)}
          >
            {playing ? "暂停快进" : `快进（${FAST_FORWARD_MS / 1000} 秒/天）`}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={state.finished}
            onClick={() => onAdvance(totalDays - dayNo)}
          >
            直接走到结束
          </button>
        </div>

        {state.finished && (
          <Notice tone="warn">
            本局已经走完最后一个交易日。下面是结算。
          </Notice>
        )}

        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={finish}>
            结算本局
          </button>
        </div>

        {lastSeason && (
          <div className="kv-list">
            {/* 随机模式连结算也不能给日期：玩家随时可以点「结算本局」看一眼再接着玩，
                一旦这里露出年份月份，藏了整局的日期就白藏了 */}
            <KV
              k="本局区间"
              v={
                hideDate
                  ? `第 1 天 → ${displayDate(state, true)}`
                  : `${lastSeason.startDate} → ${lastSeason.endDate}`
              }
            />
            <KV k="期末总资产" v={`${fmtNum(lastSeason.finalAssets)} 元`} />
            <KV k="总收益率" v={fmtPct(lastSeason.totalReturnPct)} />
            <KV k={`同期${benchmarkName}`} v={fmtPct(lastSeason.benchmarkReturnPct)} />
            <KV k="超额收益" v={fmtPct(lastSeason.excessReturnPct)} />
            <KV k="最大回撤" v={fmtPct(-lastSeason.maxDrawdownPct)} />
            <KV k="胜率" v={lastSeason.winRatePct === null ? "—（无平仓）" : fmtPct(lastSeason.winRatePct)} />
            <KV k="成交笔数" v={`${lastSeason.tradeCount} 笔`} />
          </div>
        )}
      </Card>

      <Card
        title="待成交委托"
        subtitle={`${pending.length} 笔 · 将在次一交易日开盘价成交，没有开盘价（停牌）则作废`}
      >
        {pending.length === 0 ? (
          <EmptyHint>还没有挂单。走到下一天就会按开盘价撮合。</EmptyHint>
        ) : (
          <ul className="trade-list">
            {pending.map((o) => (
              <li key={o.id} className="trade-item">
                <span>
                  {o.side === "buy" ? "买入" : "卖出"} {o.name} {o.shares} 股
                  <span className="trade-note">（{maskDate(state, o.placedAt, hideDate)} 挂出）</span>
                </span>
                <button type="button" className="btn btn-ghost btn-tiny" onClick={() => onCancel(o.id)}>
                  撤单
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="模拟下单" subtitle={`一手 ${LOT_SIZE} 股 · T+1：当日买入次日才可卖`}>
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
          <label className="field-label" htmlFor="replay-code">
            股票
          </label>
          <input
            id="replay-code"
            className="text-input"
            list="replay-stock-list"
            placeholder="输入代码或名称，如 600519.SH"
            value={code}
            onChange={(e) => {
              const v = e.target.value.trim();
              const hit = stocks.find((s) => s.code === v || s.name === v);
              setCode(hit ? hit.code : v);
              setFeedback(null);
            }}
          />
          <datalist id="replay-stock-list">
            {stocks.slice(0, 300).map((s) => (
              <option key={s.code} value={s.code}>{`${s.code} ${s.name}`}</option>
            ))}
          </datalist>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="replay-shares">
            委托股数
          </label>
          <input
            id="replay-shares"
            className="text-input text-input-num"
            type="number"
            min={0}
            step={LOT_SIZE}
            value={sharesText}
            onChange={(e) => setSharesText(e.target.value)}
          />
          <p className="field-hint">
            买入需为 {LOT_SIZE} 股整数倍
            {holding ? ` · 当前持有 ${holding.shares} 股，可卖 ${holding.sellable} 股` : ""}
          </p>
        </div>

        <div className="btn-row">
          <button type="button" className="btn btn-primary" disabled={state.finished} onClick={submit}>
            挂单
          </button>
        </div>

        {feedback && (
          <p className={feedback.ok ? "field-hint" : "field-error"} role="status">
            {feedback.msg}
          </p>
        )}

        {picked && prices[picked.code] !== undefined && (
          <div className="kv-list">
            <KV k="标的" v={`${picked.code} ${picked.name}`} />
            <KV k="当日收盘" v={prices[picked.code] === null ? "—（停牌）" : fmtNum(prices[picked.code] as number)} />
            {holding && (
              <KV k="当前持仓" v={`${holding.shares} 股 · 可卖 ${holding.sellable} 股 · 成本 ${fmtNum(holding.avgCost)}`} />
            )}
          </div>
        )}
      </Card>

      <Card title="持仓" subtitle={`按 ${hideDate ? "当日" : date} 收盘价估值`}>
        {account.holdings.length === 0 ? (
          <EmptyHint>暂无持仓。</EmptyHint>
        ) : (
          <ul className="trade-list">
            {account.holdings.map((h) => {
              const price = prices[h.code] ?? null;
              const pnl = price === null ? null : (price - h.avgCost) * h.shares;
              return (
                <li key={h.code} className="trade-item">
                  <span>
                    {h.name} {h.shares} 股
                    <span className="trade-note">
                      （可卖 {h.sellable} · 成本 {fmtNum(h.avgCost)} · 现价 {price === null ? "—" : fmtNum(price)}）
                    </span>
                  </span>
                  <span className={pnl === null ? "tone-muted" : `tone-${pnl >= 0 ? "good" : "bad"}`}>
                    {pnl === null ? "—" : fmtNum(pnl)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="推演日志" subtitle={`最近 ${recentLog.length} 条`}>
        {recentLog.length === 0 ? (
          <EmptyHint>还没有成交记录。</EmptyHint>
        ) : (
          <ul className="trade-list">
            {recentLog.map((e, i) => (
              <li key={`${e.date}-${e.code}-${i}`} className="trade-item">
                <span className={e.ok ? "" : "tone-muted"}>{maskDatesIn(state, e.text, hideDate)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
