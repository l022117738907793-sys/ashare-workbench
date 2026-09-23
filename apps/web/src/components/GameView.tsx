/**
 * 模拟盘视图。
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
import { LOT_SIZE, type SeasonResult, type Side } from "@aw/game";
import type { StockData, StockResult } from "@aw/core";
import { sourceLabel, type Quote } from "@aw/data";
import { GAME_DISCLAIMER, positionPnl, suggestedMaxShares, type GameState } from "../lib/game";
import { fmtNum, fmtPct } from "../lib/helpers";
import { Card, EmptyHint, KV, Notice, StateBadge } from "./common";

export interface GameViewProps {
  state: GameState;
  /** 价格表：优先实时价，取不到退回快照收盘价 */
  prices: Map<string, number | null>;
  quotesByCode: Map<string, Quote>;
  stocks: StockData[];
  /** 引擎分类，作为客观依据展示（不是操作建议） */
  resultsByCode: Map<string, StockResult>;
  onOrder: (code: string, side: Side, shares: number) => { ok: boolean; reason?: string };
  onReset: () => void;
  onSettle: () => SeasonResult | null;
  sessionText: string;
  isTradingNow: boolean;
  benchmarkName: string;
  benchmarkReturnPct: number | null;
  totalAssets: number;
  holdingsValue: number;
}

function Metric({ k, v, tone }: { k: string; v: string; tone?: "good" | "bad" | "muted" }) {
  return (
    <div className="metric">
      <span className="metric-k">{k}</span>
      <span className={`metric-v${tone ? ` tone-${tone}` : ""}`}>{v}</span>
    </div>
  );
}

export function GameView(props: GameViewProps) {
  const {
    state, prices, quotesByCode, stocks, resultsByCode,
    onOrder, onReset, onSettle, sessionText, isTradingNow,
    benchmarkName, benchmarkReturnPct, totalAssets, holdingsValue,
  } = props;

  const { account, equity } = state;
  const [side, setSide] = useState<Side>("buy");
  const [code, setCode] = useState("");
  const [sharesText, setSharesText] = useState("100");
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [lastSeason, setLastSeason] = useState<SeasonResult | null>(null);

  const stockByCode = useMemo(() => new Map(stocks.map((s) => [s.code, s])), [stocks]);
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

  return (
    <div className="view">
      {/* 红线要求：常驻且显著 */}
      <p className="game-disclaimer" role="note">
        ⚠️ {GAME_DISCLAIMER}
      </p>

      <Card
        title="账户总览"
        subtitle={`净值点 ${equity.length} 个 · 跑赢 ${benchmarkName} 才算有效成绩`}
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
          <label className="field-label" htmlFor="game-code">
            股票
          </label>
          <input
            id="game-code"
            className="text-input"
            list="game-stock-list"
            placeholder="输入代码或名称，如 600519.SH"
            value={code}
            onChange={(e) => {
              const v = e.target.value.trim();
              const hit = stocks.find((s) => s.code === v || s.name === v);
              setCode(hit ? hit.code : v);
              setFeedback(null);
            }}
          />
          <datalist id="game-stock-list">
            {stocks.slice(0, 300).map((s) => (
              <option key={s.code} value={s.code}>{`${s.code} ${s.name}`}</option>
            ))}
          </datalist>
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
              setFeedback(r === null ? { ok: false, msg: "净值点不足，无法结算。" } : null);
            }}
          >
            结算本季
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              if (confirm("确定重置模拟盘？所有持仓与成交记录将清空，不可恢复。")) {
                onReset();
                setLastSeason(null);
                setFeedback(null);
              }
            }}
          >
            重置模拟盘
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
    </div>
  );
}
