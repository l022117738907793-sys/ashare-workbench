/**
 * 术语：蓝色的词 + 点开就地展开的解释。
 *
 * ## 交互（两次点击拿到完整解析）
 *
 * 1. 点一下蓝色的词 → 下面就地弹出一句短释义，旁边站着交易员；
 * 2. 短释义下面有「让交易员细讲」→ 点它才展开完整的解析。
 *
 * ## 三个必须守住的实现约束
 *
 * 1. **不遮任何东西。** 琥珀那份接入包要求助手不挡住下单、暂停和日期。这里
 *    因此不做浮层：解释用 `display:block` 的 `<span>` 就地撑开下面一行。
 *    `<span>` 是 phrasing content，放在 `<p>` 里合法 —— 换成 `<div>` 会让
 *    浏览器把 `<p>` 提前闭合，整段排版散架。
 * 2. **只在纯展示文本上用。** 术语本身渲染成 `<button>`，塞进另一个按钮或
 *    链接里就是嵌套的可交互元素，既是非法结构、也没法点。
 * 3. **同时只开一个。** 一页上几十个术语全开着等于一屏都是解释，所以开了新的
 *    就把旧的关掉（模块级单值 + `useSyncExternalStore`）。
 *
 * 静态渲染（测试里的 `renderToStaticMarkup`）拿到的服务端快照恒为 null，
 * 也就是「一个都没开」—— 与首屏真实情况一致。
 */
import { useId, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import hisuiSheet from "../assets/hisui-expressions.webp";
import { splitTerms, type Term } from "../lib/glossary";
import {
  askHisui,
  getOpenRef,
  getOpenRefServer,
  isUsableEndpoint,
  loadHisuiSettings,
  MOOD_CELL,
  setOpenRef,
  subscribeHisui,
  type HisuiMood,
} from "../lib/hisui";

/** 头像：一张 3 列 2 行的表情图，用 background-position 取某一格 */
function Portrait({ mood, size = 44 }: { mood: HisuiMood; size?: number }) {
  const [col, row] = MOOD_CELL[mood];
  return (
    <span
      className="hisui-face"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        // 图片从 src/assets 引入，让 Vite 带上内容哈希和相对路径 ——
        // 站点挂在 GitHub Pages 的子路径下，写死的 /hisui/... 会 404。
        backgroundImage: `url(${hisuiSheet})`,
        backgroundPosition: `${col * 50}% ${row * 100}%`,
      }}
    />
  );
}

/**
 * 「问交易员」的输入框。**没配代理地址就返回 null。**
 *
 * 导出是为了能直接测这一条 —— `TermPanel` 静态渲染停在第一档，看不到它，
 * 而这个「不配就不出现」的规则恰恰是最该钉死的（用户明确要求过不要假入口）。
 */
export function AskBox({ term, context }: { term: string; context: string }) {
  const [endpoint] = useState(() => loadHisuiSettings().endpoint);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ mood: HisuiMood; answer: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 没配代理地址就整块不出现。宁可没有，也不要一个点了说「没接通」的假入口。
  if (!isUsableEndpoint(endpoint)) return null;

  const send = async () => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      setAnswer(await askHisui({ endpoint, term, context, question: q }));
      setQuestion("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="hisui-ask">
      <span className="hisui-ask-row">
        <input
          type="text"
          value={question}
          maxLength={200}
          placeholder={`追问「${term}」…`}
          aria-label={`向交易员追问${term}`}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
        />
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void send()}>
          {busy ? "交易员在想…" : "问交易员"}
        </button>
      </span>
      {error !== null && (
        <span className="hisui-ask-err">
          没问上（{error}）。术语解释不受影响，可以继续看上面的内容。
        </span>
      )}
      {answer !== null && (
        <span className="hisui-ask-answer">
          <Portrait mood={answer.mood} size={32} />
          <span>{answer.answer}</span>
        </span>
      )}
    </span>
  );
}

/**
 * 词条文案里的 `**强调**` 变成加粗。
 *
 * 词典是写成文本的，写的时候顺手用了 markdown 记号；直接塞进 JSX 会把星号
 * 原样显示给玩家（卡片标题上就犯过一次这个错）。所有词条文案都要过这一层。
 */
export function rich(text: string): ReactNode {
  if (!text.includes("**")) return text;
  return text
    .split("**")
    .map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part));
}

/** 就地展开的解释。`stage` 由「有没有点过让交易员细讲」决定 */
export function TermPanel({ term }: { term: Term }) {
  const [stage, setStage] = useState<"short" | "full">("short");
  const mood = term.mood ?? "explain";
  return (
    <span className="term-panel" role="note" aria-label={`${term.id} 的解释`}>
      <span className="term-panel-row">
        <Portrait mood={mood} />
        <span className="term-panel-body">
          <span className="term-panel-who">交易员</span>
          <span className="term-panel-text">{rich(stage === "short" ? term.short : term.full)}</span>
          {stage === "short" && (
            <button type="button" className="term-more" onClick={() => setStage("full")}>
              让交易员细讲
            </button>
          )}
        </span>
      </span>
      {stage === "full" && <AskBox term={term.id} context={`${term.id}：${term.full}`} />}
    </span>
  );
}

/**
 * 把一段纯展示文本里的术语变成蓝色的可点词。
 *
 * 没有命中术语时直接返回原字符串，不额外包一层 —— 免得每个 `<p>` 都多出
 * 一个 `<span>`，也免得已有的测试断言被无谓地改动。
 */
export function TermText({ text }: { text: string }) {
  const parts = useMemo(() => splitTerms(text), [text]);
  const uid = useId().replace(/:/g, "");
  const openRef = useSyncExternalStore(subscribeHisui, getOpenRef, getOpenRefServer);
  const openTerm = parts.find((p) => p.term && `${uid}:${p.term.id}` === openRef)?.term;
  if (!parts.some((p) => p.term)) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) => {
        const term = part.term;
        if (!term) return <span key={i}>{part.text}</span>;
        const ref = `${uid}:${term.id}`;
        const open = openRef === ref;
        return (
          <button
            key={i}
            type="button"
            className="term"
            aria-expanded={open}
            title={term.short}
            onClick={() => setOpenRef(open ? null : ref)}
          >
            {part.text}
          </button>
        );
      })}
      {openTerm && <TermPanel term={openTerm} />}
    </>
  );
}
