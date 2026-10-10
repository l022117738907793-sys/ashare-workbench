/** Historical chapter selection. Briefings contain only information public at entry. */
import { useState } from "react";
import { LEVELS, type ReplayLevel } from "@aw/game";
import { Notice, RichP } from "./common";
import { GAME_DISCLAIMER } from "../lib/game";
import "./level-picker.css";
import { CampaignEmblem, ChapterObjective } from "./Campaign";
import { CHAPTER_FOCUS } from "../lib/campaign";

export interface LevelPickerProps {
  /** At least one history shard is available. */
  ready: boolean;
  /** Actual published chapter IDs; omitted by older callers. */
  availableIds?: readonly string[] | null;
  loadingId: string | null;
  error: string | null;
  onStart: (level: ReplayLevel, initialCash: number) => void;
  onBack: () => void;
  cashOptions: number[];
  defaultCash: number;
}

export interface LevelDetailProps {
  level: ReplayLevel;
  ready: boolean;
  loading: boolean;
  error: string | null;
  cash: number;
  cashOptions: number[];
  onCash: (v: number) => void;
  onStart: () => void;
  onBack: () => void;
  /** Show beside the chapter list rather than as a standalone page. */
  inline?: boolean;
}

/** The exported standalone briefing is also used by static-render smoke tests. */
export function LevelDetail(props: LevelDetailProps) {
  const { level, ready, loading, error, cash, cashOptions, onCash, onStart, onBack, inline = false } = props;

  const briefing = (
    <section className="chapter-briefing" aria-labelledby={`chapter-title-${level.id}`}>
      <div className="chapter-briefing-top">
        <span className="chapter-kicker">CHAPTER {String(level.order).padStart(2, "0")}</span>
        <span className="chapter-selected-label">当前选择</span>
      </div>
      <div className="chapter-cover-top"><CampaignEmblem number={String(level.order).padStart(2,"0")}/><span>真实历史 · 自主决策</span></div>
      <h2 id={`chapter-title-${level.id}`}>{level.title}</h2>
      <p className="chapter-briefing-subtitle">{level.subtitle}</p>

      <dl className="chapter-mission-stats">
        <div><dt>进场日期</dt><dd>{level.startDate}</dd></div>
        <div><dt>推演长度</dt><dd>{level.days}<small> 个交易日</small></dd></div>
      </dl>

      <ChapterObjective/>
      <p className="chapter-focus">{CHAPTER_FOCUS[level.id]}</p>
      <details className="chapter-briefing-details" key={level.id}>
        <summary>开局简报 · 点开阅读 <span>＋</span></summary>
      <div className="chapter-briefing-section">
        <h3><span className="chapter-section-dot" />进场那天能看到的</h3>
        <ul className="chapter-facts">
          {level.briefing.map((line, i) => (
            <li key={i}><span className="chapter-fact-index">{String(i + 1).padStart(2, "0")}</span><span>{line}</span></li>
          ))}
        </ul>
      </div>

      <div className="chapter-question">
        <span>温馨提示</span>
        <p>{level.theme}</p>
      </div>

      </details>

      <fieldset className="chapter-funds">
        <legend>初始虚拟资金</legend>
        <div className="chapter-cash-options">
          {cashOptions.map((v) => (
            <button key={v} type="button" className={`chapter-cash${v === cash ? " is-selected" : ""}`} aria-pressed={v === cash} onClick={() => onCash(v)} disabled={loading}>
              {v / 10000}<span> 万</span>
            </button>
          ))}
        </div>
      </fieldset>

      {error ? <Notice tone="warn">{error}</Notice> : null}

      {ready ? (
        <button type="button" className="chapter-enter" disabled={loading} onClick={onStart}>
          <span>{loading ? "正在载入这一关的行情…" : `进入 ${level.startDate}`}</span>
          <span className="chapter-enter-arrow" aria-hidden="true">{loading ? "…" : "↗"}</span>
        </button>
      ) : (
        <div className="chapter-unavailable" role="status">
          <strong>本章行情暂未就绪</strong>
          <p>这一关还没有关卡数据，可以先选择其他章节，或返回大厅体验随机模式。</p>
        </div>
      )}

      <RichP className="chapter-price-note">
        价格是当年的盘面价，和那会儿屏幕上看到的一样。除权除息日会有一个跳空缺口 ——
        我们不分红，所以那天持仓确实会少掉一点。
      </RichP>
      {!inline ? <button type="button" className="chapter-back" onClick={onBack}>← 返回关卡列表</button> : null}
    </section>
  );

  if (inline) return briefing;
  return <div className="view chapter-view chapter-detail-view"><p className="game-disclaimer" role="note">{GAME_DISCLAIMER}</p>{briefing}</div>;
}

export function LevelPicker(props: LevelPickerProps) {
  const { ready, availableIds, loadingId, error, onStart, onBack, cashOptions, defaultCash } = props;
  const [selectedId, setSelectedId] = useState(LEVELS.find((level) => availableIds?.includes(level.id))?.id ?? LEVELS[0]!.id);
  const [cash, setCash] = useState(defaultCash);
  const selected = LEVELS.find((level) => level.id === selectedId) ?? LEVELS[0]!;
  const isAvailable = (id: string) => ready && (availableIds == null || availableIds.includes(id));

  return (
    <div className="view chapter-view">
      <header className="chapter-page-heading">
        <div>
          <span className="chapter-kicker">HISTORICAL REPLAY / 传奇模式</span>
          <h1>下一段历史，由您入场<span>.</span></h1>
          <p>回到真实的市场。只看当时的信息，亲手做出每一次决定。</p>
        </div>
        <button type="button" className="chapter-back" onClick={onBack}>← 返回游戏大厅</button>
      </header>

      <div className="chapter-mode-strip">
        <span><strong>{LEVELS.length}</strong> 个历史时刻</span>
        <span>公开日期</span>
        <span>次日开盘成交</span>
        <span>按天推进</span>
      </div>

      {!ready ? <Notice tone="warn">当前还没有关卡数据，您仍可查看章节简报。可以先返回游戏大厅玩随机模式。</Notice> : null}

      <div className="chapter-layout">
        <section className="chapter-catalog" aria-label="历史章节列表">
          <div className="chapter-catalog-heading"><h2>章节目录</h2><span><span className="chapter-swipe-hint">左右滑动 · </span>{LEVELS.length} CHAPTERS</span></div>
          <ol className="chapter-grid">
            {LEVELS.map((level) => (
              <li key={level.id}>
                <button type="button" className={`chapter-card${level.id === selectedId ? " is-selected" : ""}`} aria-pressed={level.id === selectedId} onClick={() => setSelectedId(level.id)} disabled={loadingId !== null}>
                  <span className="chapter-card-top"><span className="chapter-number">{String(level.order).padStart(2, "0")}</span><span className="chapter-year">{level.startDate.slice(0, 4)}</span></span>
                  <span className="chapter-card-title">{level.title}</span>
                  <span className="chapter-card-subtitle">{level.subtitle}</span>
                  <span className="chapter-card-footer"><span>{level.startDate}</span><span>{level.days} 交易日</span></span>
                  <span className="chapter-card-status">{!isAvailable(level.id) ? "行情待就绪" : level.id === selectedId ? "查看中的章节" : "查看简报"}<span aria-hidden="true">{level.id === selectedId ? "●" : "↗"}</span></span>
                </button>
              </li>
            ))}
          </ol>
          <p className="chapter-catalog-note">节点按大幅波动或成交异常筛出，不代表这些日子容易赚钱。</p>
        </section>
        <div className="chapter-mission-panel">
          <LevelDetail level={selected} ready={isAvailable(selected.id)} loading={loadingId !== null} error={error} cash={cash} cashOptions={cashOptions} onCash={setCash} onStart={() => onStart(selected, cash)} onBack={onBack} inline />
        </div>
      </div>
      <p className="game-disclaimer chapter-disclaimer" role="note">{GAME_DISCLAIMER}</p>
    </div>
  );
}
