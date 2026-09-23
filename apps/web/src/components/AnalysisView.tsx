/** 第二层视图：个股七步分析 + 学习模式 + 「我为什么看好」复盘。 */
import { useState, type ReactNode } from "react";
import {
  generateLearningFeedback,
  learningQuestions,
  reviewThesis,
  type AnalysisReport,
  type LearningFeedback,
  type ReasonItem,
  type StockMetrics,
  type ThesisReview,
} from "@aw/core";
import { sourceLabel, type Quote } from "@aw/data";
import {
  beijingClock,
  fmtNum,
  fmtPct,
  NOT_ENOUGH_BANNER,
  type Tone,
} from "../lib/helpers";
import { Card, Notice, ReasonList, StateBadge } from "./common";

const THESIS_TYPES = ["技术形态", "消息催化", "基本面", "资金流向", "情绪博弈"];
const HORIZONS: Array<{ key: string; label: string }> = [
  { key: "短线", label: "短线 5 日" },
  { key: "波段", label: "波段 20 日" },
  { key: "中线", label: "中线 60 日" },
];

export interface AnalysisProps {
  code: string;
  name: string;
  report: AnalysisReport | null;
  reportError: string | null;
  metrics: StockMetrics | null;
  quote: Quote | null;
  quoteError: string | null;
  /** 当前交易时段文案（非交易时段不发实时请求） */
  sessionText: string;
  snapshotPrice: number | null;
  snapshotAsOf: string | null;
  /** 分类判定（classifyStock）的逐条依据 */
  classificationReasons: ReasonItem[];
  onBack: () => void;
  onOpenSettings: () => void;
  onSaveLearning: (question: string, answer: string) => void;
}

export function AnalysisView(props: AnalysisProps) {
  const {
    code,
    name,
    report,
    reportError,
    metrics,
    quote,
    quoteError,
    sessionText,
    snapshotPrice,
    snapshotAsOf,
    classificationReasons,
    onBack,
    onOpenSettings,
    onSaveLearning,
  } = props;

  if (reportError) {
    return (
      <div className="view">
        <BackBar name={name} code={code} onBack={onBack} />
        <Notice tone="danger" role="alert">
          分析失败：{reportError}
          <br />
          引擎要求个股必须存在于当前快照中；换一只有数据的个股，或到设置页确认数据路径。
          <button type="button" className="btn btn-ghost" onClick={onOpenSettings}>
            去设置
          </button>
        </Notice>
      </div>
    );
  }
  if (!report) {
    return (
      <div className="view">
        <BackBar name={name} code={code} onBack={onBack} />
        <Notice tone="info">正在读取快照…</Notice>
      </div>
    );
  }

  const steps: Array<{ index: string; title: string; state: string; reasons: ReasonItem[]; extra?: ReactNode }> = [
    { index: "①", title: "大盘环境", state: report.market.state, reasons: report.market.reasons, extra: <p className="implication">{report.market.implication}</p> },
    {
      index: "②",
      title: `板块状态 · ${report.sector.name}`,
      state: report.sector.state,
      reasons: report.sector.reasons,
      extra: (
        <p className="row-metrics">
          <span>板块上涨占比 {report.sector.breadth20 === null ? "—" : `${fmtNum(report.sector.breadth20 * 100, 1)}%`}</span>
          <span>强势股 {report.sector.strongCount} 只</span>
          <span>最强成分 {report.sector.strongestMembers.join("、") || "—"}</span>
        </p>
      ),
    },
    { index: "③", title: "个股中期趋势", state: report.stockTrend.state, reasons: report.stockTrend.reasons },
    { index: "④", title: "近期价格行为", state: report.priceAction.state, reasons: report.priceAction.reasons },
    {
      index: "⑤",
      title: "当前位置",
      state: report.position.state,
      reasons: report.position.reasons,
      extra:
        report.position.trendBroken === null && report.position.volumeHeavy === null ? undefined : (
          <p className="row-metrics">
            <span>回调是否破坏趋势：{report.position.trendBroken === null ? "数据不足" : report.position.trendBroken ? "已破坏" : "未破坏"}</span>
            <span>回调量能：{report.position.volumeHeavy === null ? "数据不足" : report.position.volumeHeavy ? "放量" : "缩量/中性"}</span>
          </p>
        ),
    },
    {
      index: "⑥",
      title: "下一步观察",
      state: report.currentType,
      reasons: classificationReasons,
      extra: (
        <ul className="next-steps">
          {report.nextSteps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      ),
    },
    {
      index: "⑦",
      title: "结论",
      state: report.currentType,
      reasons: classificationReasons,
      extra: (
        <>
          <p className="conclusion">{report.conclusion}</p>
          <p className="muted small">
            以下为分类判定的完整依据（classifyStock）。第⑥⑦步共用它，因为「下一步观察」和「结论」都由当前分类决定。
          </p>
          <ul className="why-list">
            {report.why.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </>
      ),
    },
  ];

  return (
    <div className="view">
      <BackBar name={name} code={code} onBack={onBack} />

      <Card title="实时价格" subtitle="行情来自下方标注的数据源；取不到就显示快照价，不猜。">
        {quote ? (
          <div className="quote-head">
            <span className="quote-price">{fmtNum(quote.price)}</span>
            <span className={`quote-change tone-${changeTone(quote.changePct)}`}>{fmtPct(quote.changePct)}</span>
            <div className="quote-meta">
              <span>来源：{sourceLabel(quote.source)}</span>
              <span>报价时间：{quote.asOf === null ? "—" : beijingClock(quote.asOf)}</span>
            </div>
          </div>
        ) : (
          <div className="quote-head">
            <span className="quote-price">{fmtNum(snapshotPrice)}</span>
            <div className="quote-meta">
              <span>来源：本地快照{snapshotAsOf ? `（${snapshotAsOf} 收盘）` : ""}</span>
              <span>实时行情不可用，页面显示快照收盘价，未做任何插值。</span>
            </div>
          </div>
        )}
        {quoteError && (
          <Notice tone="warn">
            实时行情取数失败：{quoteError}
            <br />
            这不影响分析结论 —— 结论基于本地快照的日线数据。
          </Notice>
        )}
        {quote === null && !quoteError && (
          <Notice tone="info">当前为「{sessionText}」，未请求实时行情；显示的是本地快照数据。</Notice>
        )}
      </Card>

      {!report.dataSufficiency.enough && (
        <Notice tone="danger" role="alert">
          <strong>{NOT_ENOUGH_BANNER}</strong>
          <ul className="missing-list">
            {report.dataSufficiency.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          缺失项不会被推算或填充，相关判断一律标注为「数据不足」。
        </Notice>
      )}

      {steps.map((s) => (
        <Card key={s.index} title={`${s.index} ${s.title}`} right={<StateBadge state={s.state} />}>
          {s.extra}
          <ReasonList reasons={s.reasons} />
        </Card>
      ))}

      {metrics && (
        <Card title="引擎指标快照" subtitle="computeStockMetrics 的原始输出（取不到即为 —）">
          <div className="metric-grid">
            <Metric k="可用交易日" v={`${metrics.days} 天`} />
            <Metric k="近5日" v={fmtPct(metrics.ret5)} />
            <Metric k="近10日" v={fmtPct(metrics.ret10)} />
            <Metric k="近20日" v={fmtPct(metrics.ret20)} />
            <Metric k="近60日" v={fmtPct(metrics.ret60)} />
            <Metric k="站上20日线" v={boolText(metrics.above20)} />
            <Metric k="站上60日线" v={boolText(metrics.above60)} />
            <Metric k="20日线上弯" v={boolText(metrics.ma20Up)} />
            <Metric k="60日线上弯" v={boolText(metrics.ma60Up)} />
            <Metric k="距20日线" v={fmtPct(metrics.dist20)} />
            <Metric k="距20日高点" v={fmtPct(metrics.distHigh)} />
            <Metric k="回调幅度" v={fmtPct(metrics.pullback)} />
            <Metric k="量比(5/20)" v={fmtNum(metrics.volRatio)} />
            <Metric k="连续站上20日线" v={`${metrics.daysAbove20} 天`} />
            <Metric k="ATR 标记" v={metrics.atr.available ? metrics.atr.flag : "数据不足"} />
            <Metric k="ATR 值" v={fmtNum(metrics.atr.atr)} />
            <Metric k="波动带" v={fmtNum(metrics.atr.band5)} />
            <Metric k="5日累计变动" v={fmtNum(metrics.atr.move5)} />
          </div>
        </Card>
      )}

      <LearningSection
        report={report}
        metrics={metrics}
        onSave={(q, a) => onSaveLearning(q, a)}
      />
      <ThesisSection report={report} metrics={metrics} />
    </div>
  );
}

function BackBar({ name, code, onBack }: { name: string; code: string; onBack: () => void }) {
  return (
    <div className="back-bar">
      <button type="button" className="btn btn-ghost" onClick={onBack}>
        ← 返回筛选
      </button>
      <span className="back-title">
        {name} <span className="code">{code}</span>
      </span>
    </div>
  );
}

function Metric({ k, v }: { k: string; v: string }) {
  return (
    <div className="metric">
      <span className="metric-k">{k}</span>
      <span className="metric-v">{v}</span>
    </div>
  );
}

function boolText(v: boolean | null): string {
  if (v === null) return "数据不足";
  return v ? "是" : "否";
}

function changeTone(v: number | null): Tone {
  if (v === null) return "muted";
  return v > 0 ? "good" : v < 0 ? "bad" : "muted";
}

function LearningSection({
  report,
  metrics,
  onSave,
}: {
  report: AnalysisReport;
  metrics: StockMetrics | null;
  onSave: (question: string, answer: string) => void;
}) {
  const questions = learningQuestions(report.currentType);
  const [picked, setPicked] = useState<string>(questions[0] ?? "");
  const [answer, setAnswer] = useState("");
  const [feedback, setFeedback] = useState<LearningFeedback | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = () => {
    if (!metrics || answer.trim() === "") return;
    setFeedback(generateLearningFeedback(report.currentType, answer, report, metrics));
    setSaved(false);
  };

  return (
    <Card title="学习模式" subtitle={`按当前分类「${report.currentType}」提问，系统不判对错，只做对照。`}>
      <div className="stack">
        {questions.map((q) => (
          <button
            key={q}
            type="button"
            className={`choice${picked === q ? " choice-active" : ""}`}
            onClick={() => setPicked(q)}
            aria-pressed={picked === q}
          >
            {q}
          </button>
        ))}
      </div>
      <textarea
        className="text-area"
        rows={4}
        placeholder="写下你的判断（会与引擎数据对照，不判对错）"
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        aria-label="学习模式作答"
      />
      <div className="btn-row">
        <button type="button" className="btn btn-primary" onClick={submit} disabled={!metrics || answer.trim() === ""}>
          提交并对照
        </button>
        {feedback && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              onSave(picked, answer);
              setSaved(true);
            }}
          >
            保存到历史
          </button>
        )}
        {saved && <span className="muted small">已保存</span>}
      </div>
      {!metrics && <Notice tone="warn">缺少指标数据，无法生成学习反馈。</Notice>}
      {feedback && (
        <div className="feedback">
          <h4>你的判断</h4>
          <ul>
            {feedback.doneRight.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <h4>容易忽略的地方</h4>
          {feedback.easyToMiss.length > 0 ? (
            <ul>
              {feedback.easyToMiss.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          ) : (
            <p className="muted small">这次你把数据里所有关键因素都提到了。</p>
          )}
          <h4>进一步思考</h4>
          <p>{feedback.thinkFurther}</p>
        </div>
      )}
    </Card>
  );
}

function ThesisSection({ report, metrics }: { report: AnalysisReport; metrics: StockMetrics | null }) {
  const [types, setTypes] = useState<string[]>([]);
  const [horizon, setHorizon] = useState<string>("波段");
  const [text, setText] = useState("");
  const [review, setReview] = useState<ThesisReview | null>(null);

  const toggleType = (t: string) =>
    setTypes((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]));

  const submit = () => {
    if (!metrics) return;
    setReview(reviewThesis({ types, horizon, text }, report, metrics));
  };

  return (
    <Card
      title="我为什么看好"
      subtitle="把理由摊开，和引擎数据逐条对照；系统不否定你的判断。"
    >
      <div className="field">
        <span className="field-label">理由类型（可多选）</span>
        <div className="chips">
          {THESIS_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              className={`chip${types.includes(t) ? " chip-active" : ""}`}
              onClick={() => toggleType(t)}
              aria-pressed={types.includes(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="field-label">时间预期</span>
        <div className="chips">
          {HORIZONS.map((h) => (
            <button
              key={h.key}
              type="button"
              className={`chip${horizon === h.key ? " chip-active" : ""}`}
              onClick={() => setHorizon(h.key)}
              aria-pressed={horizon === h.key}
            >
              {h.label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="field-label">自由文本</span>
        <textarea
          className="text-area"
          rows={4}
          placeholder="例如：板块在加强，量能放大，价格刚站上20日线…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="看好理由"
        />
      </div>
      <div className="btn-row">
        <button type="button" className="btn btn-primary" onClick={submit} disabled={!metrics || (types.length === 0 && text.trim() === "")}>
          与系统依据对照
        </button>
      </div>
      {review && (
        <div className="thesis-review">
          <table className="thesis-table">
            <thead>
              <tr>
                <th>理由类型</th>
                <th>系统依据（数据）</th>
                <th>对照结论</th>
              </tr>
            </thead>
            <tbody>
              {review.rows.map((r) => (
                <tr key={r.reasonType}>
                  <td>{r.reasonType}</td>
                  <td>{r.systemEvidence}</td>
                  <td>{r.conclusion}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="follow-up">{review.followUp}</p>
        </div>
      )}
    </Card>
  );
}
