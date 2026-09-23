/** 第三层视图：本地历史（最近分析 + 学习作答）。数据只存在浏览器 localStorage 里。 */
import { beijingDateTime, type LocalStore } from "../lib/helpers";
import { Card, EmptyHint, Notice, StateBadge } from "./common";

export interface HistoryProps {
  store: LocalStore;
  onOpenStock: (code: string) => void;
  onRemoveAnalysed: (code: string) => void;
  onClearAnalysed: () => void;
  onClearLearning: () => void;
  onClearAll: () => void;
}

export function HistoryView(props: HistoryProps) {
  const { store, onOpenStock, onRemoveAnalysed, onClearAnalysed, onClearLearning, onClearAll } = props;

  return (
    <div className="view">
      <Card
        title="最近分析"
        subtitle={`${store.analysed.length} 条 · 按代码去重，最新在前`}
        right={
          store.analysed.length > 0 ? (
            <button type="button" className="btn btn-ghost" onClick={onClearAnalysed}>
              清空
            </button>
          ) : undefined
        }
      >
        {store.analysed.length === 0 ? (
          <EmptyHint>还没有分析记录。在「筛选」里点开任意个股，就会自动记在这里。</EmptyHint>
        ) : (
          <ul className="history-list">
            {store.analysed.map((e) => (
              <li key={e.code} className="history-row">
                <button type="button" className="row-tap" onClick={() => onOpenStock(e.code)}>
                  <span className="row-title">
                    <span className="name">{e.name}</span>
                    <span className="code">{e.code}</span>
                    <StateBadge state={e.type} size="sm" />
                  </span>
                  <span className="row-metrics">
                    <span>{beijingDateTime(e.at)}</span>
                    <span className="row-action">重新打开 →</span>
                  </span>
                </button>
                <button type="button" className="btn btn-ghost btn-tiny" onClick={() => onRemoveAnalysed(e.code)}>
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="学习记录"
        subtitle={`${store.learning.length} 条作答`}
        right={
          store.learning.length > 0 ? (
            <button type="button" className="btn btn-ghost" onClick={onClearLearning}>
              清空
            </button>
          ) : undefined
        }
      >
        {store.learning.length === 0 ? (
          <EmptyHint>还没有学习作答。在「个股分析 → 学习模式」里作答并保存，会记在这里。</EmptyHint>
        ) : (
          <ul className="history-list">
            {store.learning.map((e, i) => (
              <li key={`${e.code}-${e.at}-${i}`} className="history-row history-learning">
                <div className="row-tap row-static">
                  <span className="row-title">
                    <span className="name">{e.name}</span>
                    <span className="code">{e.code}</span>
                    <StateBadge state={e.type} size="sm" />
                    <span className="muted small">{beijingDateTime(e.at)}</span>
                  </span>
                  <span className="learning-q">问：{e.question || "（未选择问题）"}</span>
                  <span className="learning-a">答：{e.answer}</span>
                </div>
                <button type="button" className="btn btn-ghost btn-tiny" onClick={() => onOpenStock(e.code)}>
                  打开个股
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="本地数据" subtitle="全部保存在本机浏览器，不上传任何服务器。">
        <Notice tone="info">
          清空只影响本机的历史与设置；快照数据在 <code>public/data</code> 里，不受影响。
        </Notice>
        <div className="btn-row">
          <button type="button" className="btn btn-danger" onClick={onClearAll}>
            清空本地数据
          </button>
        </div>
      </Card>
    </div>
  );
}
