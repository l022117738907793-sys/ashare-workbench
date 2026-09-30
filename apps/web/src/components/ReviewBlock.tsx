/**
 * 复盘报告。
 *
 * 全部内容都由 `@aw/game` 的 `reviewReport` 纯函数算出来，这里只负责措辞与排版。
 * 措辞的红线写在那个文件的头部注释里，这里不再重复，但**一条都不能软化**：
 * 不评判对错、不暗示引擎是对的、缺数据就说缺。
 */
import type { ReviewReport } from "@aw/game";
import { describeReview } from "@aw/game";
import { fmtNum, fmtPct } from "../lib/helpers";
import { Notice } from "./common";

export interface ReviewBlockProps {
  report: ReviewReport;
}

const ALIGN_LABEL: Record<string, string> = {
  aligned: "与当时分类同向",
  against: "与当时分类反向",
  unknown: "记录里没有分类",
};

export function ReviewBlock({ report }: ReviewBlockProps) {
  const r = report;
  const known = r.counts.aligned + r.counts.against;

  return (
    <div className="review-block">
      <h3 className="review-h">复盘</h3>
      <p className="review-lead">{describeReview(r)}</p>

      {known === 0 && r.trades.length > 0 && (
        <Notice tone="info">
          成交记录里没有「当时分类」（这是早期版本下的单），所以只能看结果，
          没法回答「有没有按依据做」。之后的成交都会记下来。
        </Notice>
      )}

      {r.trades.length > 0 && (
        <ul className="review-list">
          {r.trades.slice(0, 30).map((t) => (
            <li key={t.id} className="review-row">
              <span className="review-when">
                {t.date} {t.side === "buy" ? "买入" : "卖出"}
              </span>
              <span className="review-what">
                {t.name} <span className="away-code">{t.code}</span> @{fmtNum(t.price)}
              </span>
              <span className="review-why">
                {t.typeAtTrade ? `当时「${t.typeAtTrade}」` : "当时分类未记录"}
                <span className={`tag tag-align-${t.aligned}`}>{ALIGN_LABEL[t.aligned]}</span>
              </span>
              <span className="review-after">
                成交后{" "}
                <span
                  className={
                    t.laterPct === null ? "tone-muted" : t.laterPct > 0 ? "tone-good" : t.laterPct < 0 ? "tone-bad" : ""
                  }
                >
                  {t.laterPct === null ? "—" : fmtPct(t.laterPct)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {known > 0 && (
        <div className="metric-grid">
          <div className="metric">
            <span className="metric-k">同向的那几笔</span>
            <span className="metric-v">
              {r.counts.aligned} 笔
              {r.alignedAvgPct === null ? "" : ` · 之后平均 ${fmtPct(r.alignedAvgPct)}`}
            </span>
          </div>
          <div className="metric">
            <span className="metric-k">反向的那几笔</span>
            <span className="metric-v">
              {r.counts.against} 笔
              {r.againstAvgPct === null ? "" : ` · 之后平均 ${fmtPct(r.againstAvgPct)}`}
            </span>
          </div>
        </div>
      )}

      {r.holdings.length > 0 && (
        <>
          <h4 className="review-sub">期末持仓：动过的和没动过的</h4>
          <ul className="review-list">
            {r.holdings.map((h) => (
              <li key={h.code} className="review-row">
                <span className="review-what">
                  {h.name} <span className="away-code">{h.code}</span>
                </span>
                <span className="review-why">{h.traded ? "本季动过" : "本季没动过"}</span>
                <span className="review-after">
                  {h.pnlPct === null ? (
                    <span className="tone-muted">无行情</span>
                  ) : (
                    <span className={h.pnlPct > 0 ? "tone-good" : h.pnlPct < 0 ? "tone-bad" : ""}>{fmtPct(h.pnlPct)}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <Notice tone="warn">
        <strong>别把这张表当成评分。</strong>
        <ul className="review-caveats">
          {r.caveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </Notice>

      <p className="field-hint">
        「成交后」用的是结算时的价格（实时价或最近收盘价）。
        单笔的后续涨跌和你的操作之间没有因果关系 —— 一张表说明不了水平。
      </p>
    </div>
  );
}
