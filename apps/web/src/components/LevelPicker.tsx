/**
 * 传奇模式（模式 2）的关卡选择。
 *
 * 十关都是真实的历史节点。和随机模式相反，这里**大方地显示日期**：
 * 传奇模式是纪念性复盘，玩的就是「我知道后来发生了什么，那如果当时是我呢」。
 * 藏日期反而把这个玩法抽掉了。
 *
 * 但有一条底线：**开局简报只写进场那天公开可见的信息**。
 * 顺手写一句「随后就暴跌了」，这一关就没有任何意义了。
 */
import { useState } from "react";
import { LEVELS, type ReplayLevel } from "@aw/game";
import { Card, Notice } from "./common";
import { GAME_DISCLAIMER } from "../lib/game";

export interface LevelPickerProps {
  /** 关卡数据是否已经就位（分片缺少时只能看名单，不能开局） */
  ready: boolean;
  /** 正在加载哪一关，null 表示没有在加载 */
  loadingId: string | null;
  error: string | null;
  onStart: (level: ReplayLevel, initialCash: number) => void;
  onBack: () => void;
  /** 可选资金档位，与实时模拟游戏共用 */
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
}

/**
 * 单关的开局简报页。
 *
 * 单独拆出来是为了能直接渲染它做冒烟测试 —— `renderToStaticMarkup` 点不了按钮，
 * 列表里选一关这个交互测不到，但简报页本身的内容（尤其是那些不许出现的后见之明）必须测得到。
 */
export function LevelDetail(props: LevelDetailProps) {
  const { level: open, ready, loading, error, cash, cashOptions, onCash, onStart, onBack } = props;

  return (
    <div className="view">
      <p className="game-disclaimer" role="note">
        {`⚠️ ${GAME_DISCLAIMER}`}
      </p>

      <Card
        title={`${open.order}. ${open.title}`}
        subtitle={open.subtitle}
        right={
          <button type="button" className="btn btn-ghost btn-tiny" onClick={onBack}>
            返回关卡列表
          </button>
        }
      >
        <Notice tone="info">
          这是 <strong>{open.startDate}</strong> —— 真实的历史交易日。你会从这一天开始，
          一天一天往前走 {open.days} 个交易日。日期是公开的：你知道后来发生了什么，
          问题是在当时的信息下你会怎么做。
        </Notice>

        <h4 className="briefing-h">进场那天能看到的</h4>
        <ul className="briefing-list">
          {open.briefing.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>

        <h4 className="briefing-h">这一局要想清楚的是</h4>
        <p className="briefing-theme">{open.theme}</p>

        <div className="field">
          <label>初始资金</label>
          <div className="chips">
            {cashOptions.map((v) => (
              <button
                key={v}
                type="button"
                className={`chip${v === cash ? " chip-active" : ""}`}
                onClick={() => onCash(v)}
              >
                {v / 10000} 万
              </button>
            ))}
          </div>
        </div>

        {error ? <Notice tone="warn">{error}</Notice> : null}

        {ready ? (
          <button type="button" className="btn btn-primary" disabled={loading} onClick={onStart}>
            {loading ? "正在载入这一关的行情…" : `进入 ${open.startDate}`}
          </button>
        ) : (
          <Notice tone="warn">
            这一关的行情文件没有随站点发布，暂时开不了。需要先跑
            <code> scripts/build-history-shards.ts</code>。
          </Notice>
        )}

        <p className="hint">
          价格用的是前复权价（用今天的复权因子回算），所以收益是连续的，
          但和当年的盘面绝对价位不一样。这是为了让长期持有不会被除权缺口算成亏损。
        </p>
      </Card>
    </div>
  );
}

export function LevelPicker(props: LevelPickerProps) {
  const { ready, loadingId, error, onStart, onBack, cashOptions, defaultCash } = props;
  const [openId, setOpenId] = useState<string | null>(null);
  const [cash, setCash] = useState(defaultCash);

  const open = LEVELS.find((l) => l.id === openId) ?? null;

  if (open) {
    return (
      <LevelDetail
        level={open}
        ready={ready}
        loading={loadingId !== null}
        error={error}
        cash={cash}
        cashOptions={cashOptions}
        onCash={setCash}
        onStart={() => onStart(open, cash)}
        onBack={() => setOpenId(null)}
      />
    );
  }

  return (
    <div className="view">
      <p className="game-disclaimer" role="note">
        {`⚠️ ${GAME_DISCLAIMER}`}
      </p>

      <Card
        title="传奇模式 · 10 个历史时刻"
        subtitle="选一段真实的历史，从它发生之前开始"
        right={
          <button type="button" className="btn btn-ghost btn-tiny" onClick={onBack}>
            返回
          </button>
        }
      >
        <Notice tone="info">
          每一关都是 A 股真实发生过的一段日子。你会从事件发生**之前**的某一天进场，
          一天一步往前走。日期照实显示 —— 这一关玩的是「当时的信息下你会怎么做」，
          不是猜谜。
        </Notice>

        {!ready ? (
          <Notice tone="warn">
            站点的 <code>history/</code> 目录里还没有关卡数据，只能看名单。可以先玩随机模式。
          </Notice>
        ) : null}

        <ol className="level-list">
          {LEVELS.map((l) => (
            <li key={l.id}>
              <button type="button" className="level-item" onClick={() => setOpenId(l.id)}>
                <span className="level-order">{l.order}</span>
                <span className="level-main">
                  <span className="level-title">{l.title}</span>
                  <span className="level-sub">{l.subtitle}</span>
                </span>
                <span className="level-date">{l.startDate}</span>
              </button>
            </li>
          ))}
        </ol>

        <p className="hint">
          这些节点是按「当日或 5 日内出现大幅波动 / 成交异常」筛出来的，筛选规则写在
          <code> docs/game-design.md</code>。它只筛出「有故事的日子」，不代表这些日子容易赚钱。
        </p>
      </Card>
    </div>
  );
}
