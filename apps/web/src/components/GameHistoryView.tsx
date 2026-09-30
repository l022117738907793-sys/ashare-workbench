/**
 * 模拟游戏 → 游戏记录。
 *
 * 为什么单独开一屏：实时模式和历史推演各有各的存档（aw.game.v1 / aw.replay.v1），
 * 成交散在两个面板里，想看「我这一路都下了些什么单」得来回切着找。这里把它们
 * 并成一条时间线，每一行都写清楚是在哪一边下的。
 *
 * 这一屏**只读**：没有任何下单、结算、重置入口，进来改不到任何一局的状态。
 * 会动的两处都是「跳转」——点某一行去个股分析，点上面的横幅回到正在跑的那一局。
 */
import { levelById, type SeasonResult, type Trade } from "@aw/game";
import { GAME_DISCLAIMER, type GameState } from "../lib/game";
import type { ReplaySession } from "../lib/replay";
import { fmtNum, fmtPct } from "../lib/helpers";
import { Card, EmptyHint, Notice } from "./common";

export interface GameHistoryProps {
  /** 实时模式的存档；从没开过局时是 idle，这里什么都不取 */
  live: GameState | null;
  /** 正在跑的历史推演；没有就是 null */
  replay: ReplaySession | null;
  /** 跳到个股分析看这只票 */
  onOpenStock: (code: string) => void;
  /** 跳回正在跑的那一局推演 */
  onResumeReplay: () => void;
}

interface Row {
  key: string;
  /** 这笔是在哪一边下的：实时模式 / 历史推演 · 第 N 关 */
  where: string;
  trade: Trade;
}

export function GameHistoryView(props: GameHistoryProps) {
  const { live, replay, onOpenStock, onResumeReplay } = props;

  const level = replay?.levelId ? levelById(replay.levelId) : undefined;
  const replayWhere = `历史推演${level ? ` · 第 ${level.order} 关` : ""}`;

  const rows: Row[] = [];
  if (live?.status === "playing") {
    for (const t of live.account.trades) rows.push({ key: `live-${t.id}`, where: "实时模式", trade: t });
  }
  if (replay) {
    for (const t of replay.state.account.trades) rows.push({ key: `replay-${t.id}`, where: replayWhere, trade: t });
  }
  // 按「这笔是什么时候下的」倒序。两边的 at 都是真实世界的时间戳，可以直接比。
  rows.sort((a, b) => (a.trade.at < b.trade.at ? 1 : a.trade.at > b.trade.at ? -1 : 0));

  const seasons: Array<{ key: string; where: string; s: SeasonResult }> = [];
  if (live?.status === "playing") {
    for (const s of live.account.seasons) seasons.push({ key: `live-${s.season}`, where: "实时模式", s });
  }
  if (replay) {
    for (const s of replay.state.account.seasons) seasons.push({ key: `replay-${s.season}`, where: replayWhere, s });
  }

  return (
    <div className="view">
      {replay && (
        <Notice tone="info">
          有一局历史推演还在跑
          {level ? `（第 ${level.order} 关 · ${level.title}）` : ""}，停在推演第 {replay.state.dayIndex + 1} 天。
          <div className="btn-row">
            <button type="button" className="btn btn-primary btn-tiny" onClick={onResumeReplay}>
              回到正在跑的那一局
            </button>
          </div>
        </Notice>
      )}

      <Card title={`成交记录（${rows.length}）`} subtitle="实时模式与历史推演合在一起，最新下的在最前面">
        {rows.length === 0 ? (
          <EmptyHint>
            还没有任何成交。实时模式下单、或者开一局历史推演，成交之后都会记在这里。
          </EmptyHint>
        ) : (
          <ul className="history-list">
            {rows.map((r) => (
              <li key={r.key} className="history-row">
                <button type="button" className="row-tap" onClick={() => onOpenStock(r.trade.code)}>
                  <span className="row-title">
                    <span className="tag">{r.trade.side === "buy" ? "买入" : "卖出"}</span>
                    <span className="name">{r.trade.name}</span>
                    <span className="code">{r.trade.code}</span>
                    <span className="muted small">{r.where}</span>
                  </span>
                  <span className="row-metrics">
                    {/* 推演的日期是模拟日，和真实下单时间不是一回事，所以标出「模拟」 */}
                    <span>{r.where === "实时模式" ? r.trade.date : `模拟日 ${r.trade.date}`}</span>
                    <span>{r.trade.shares} 股</span>
                    <span>@{fmtNum(r.trade.price)}</span>
                    <span>金额 {fmtNum(r.trade.amount)}</span>
                    <span>费用 {fmtNum(r.trade.fee)}</span>
                    {r.trade.typeAtTrade && <span>当时分类「{r.trade.typeAtTrade}」</span>}
                    <span className="row-action">看这只票 →</span>
                  </span>
                  {r.trade.note && <p className="field-hint">{r.trade.note}</p>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`赛季结算（${seasons.length}）`} subtitle="每一局各算各的，基准都是同期沪深300">
        {seasons.length === 0 ? (
          <EmptyHint>还没有结算过。在任意一边点「结算本季」，成绩会留在这里。</EmptyHint>
        ) : (
          <ul className="stock-list">
            {seasons.map((r) => (
              <li key={r.key} className="stock-row">
                <div className="row-static">
                  <span className="row-title">
                    <span className="tag">{r.where}</span>
                    <span className="name">{r.s.season}</span>
                  </span>
                  <span className="row-metrics">
                    <span>{r.s.startDate} ~ {r.s.endDate}</span>
                    <span>收益 {fmtPct(r.s.totalReturnPct)}</span>
                    <span>基准 {fmtPct(r.s.benchmarkReturnPct)}</span>
                    <span>超额 {fmtPct(r.s.excessReturnPct)}</span>
                    <span>最大回撤 {fmtPct(r.s.maxDrawdownPct)}</span>
                    <span>成交 {r.s.tradeCount} 笔</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="field-hint">{GAME_DISCLAIMER}</p>
    </div>
  );
}
