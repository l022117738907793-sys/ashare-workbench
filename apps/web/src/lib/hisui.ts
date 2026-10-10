/**
 * 教学助手（显示名「交易员」）：状态、形象与（可选的）AI 问答入口。
 *
 * ## 为什么助手没有一个自己的大卡片
 *
 * 琥珀那份接入包建议把助手放在交易区侧边（桌面）或可收起的卡片里（移动端），
 * 明确要求**不遮住下单、暂停或日期**。这个站点是手机优先的单列布局，任何浮层
 * 都会压到下单按钮上。所以这里改成：解释**就地展开在词所在的那段文字下面**，
 * 既不遮任何东西，也省掉了「点完还得找它在哪」。
 *
 * ## AI 是可选的
 *
 * 站点部署在 GitHub Pages 上，纯静态，**不能保管服务端密钥** —— 这一点接入包
 * 的 README 自己也写明了。所以：
 *   - 不带任何配置时：术语解释、常见问题全部离线可用，界面上不出现提问框；
 *   - 配了一个代理地址（设置页填，或构建时给 VITE_HISUI_ENDPOINT）时：出现提问框。
 * 绝不会出现「看起来能问、点了说没接通」的假按钮。
 */
import { readLS, writeLS } from "./helpers";

export type HisuiMood = "neutral" | "thinking" | "explain" | "concern" | "happy" | "sorry";

/**
 * 界面上的显示名。
 *
 * **模块与标识符仍叫 hisui**（`hisui.ts`、`HisuiMood`、`aw.hisui.v1`、
 * `hisui-expressions.webp`）—— 素材原本是《月姬》的翡翠。改名只改了显示名：
 * 存档键一改，用户填过的代理地址就丢了，而那是要用户重新去找一次东西的代价。
 * 内部名与显示名不一致这件事写在 `docs/terms-and-hisui.md` 第五节。
 */
export const HISUI_NAME = "交易员";

/** 表情图在精灵图里的位置：[列, 行]，与琥珀那份 dialogue.json 的 moods 一致 */
export const MOOD_CELL: Record<HisuiMood, [number, number]> = {
  neutral: [0, 0],
  thinking: [1, 0],
  explain: [2, 0],
  concern: [0, 1],
  happy: [1, 1],
  sorry: [2, 1],
};

const LS_HISUI = "aw.hisui.v1";

export interface HisuiSettings {
  /** 代理地址。空字符串 = 不接 AI */
  endpoint: string;
}

export const NO_HISUI: HisuiSettings = { endpoint: "" };

/**
 * 构建期的默认地址。留空就是「这一版不接 AI」。
 *
 * 用 `??` 而不是直接取：`import.meta.env` 在纯 node 测试环境里不存在，
 * 那里会抛 TypeError。
 */
export function defaultEndpoint(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_HISUI_ENDPOINT?.trim() ?? "";
}

export function parseHisuiSettings(raw: string | null): HisuiSettings {
  if (!raw) return { endpoint: defaultEndpoint() };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const endpoint = typeof parsed.endpoint === "string" ? parsed.endpoint.trim() : "";
    return { endpoint };
  } catch {
    return { endpoint: defaultEndpoint() };
  }
}

export function loadHisuiSettings(): HisuiSettings {
  const stored = readLS(LS_HISUI);
  if (stored === null) return { endpoint: defaultEndpoint() };
  return parseHisuiSettings(stored);
}

export function saveHisuiSettings(settings: HisuiSettings): void {
  writeLS(LS_HISUI, JSON.stringify(settings));
}

/** 地址看着像个能 POST 的地方吗。挡掉手滑填的半截东西，别到点了才发现 */
export function isUsableEndpoint(endpoint: string): boolean {
  return /^https:\/\/\S+$/.test(endpoint.trim());
}

// ── 「同时只展开一个词」的极简订阅 ──────────────────────────────
// 一页上会有几十个术语，全开着会变成一屏解释。用模块级的单值 + 订阅来保证
// 只有一个展开，而不必把状态从 App 一路透传到每个段落。

type Listener = () => void;

let openRef: string | null = null;
const listeners = new Set<Listener>();

export function subscribeHisui(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getOpenRef(): string | null {
  return openRef;
}

/** 给 renderToStaticMarkup 用的服务端快照：静态渲染时没有「谁开着」这回事 */
export function getOpenRefServer(): string | null {
  return null;
}

export function setOpenRef(ref: string | null): void {
  if (ref === openRef) return;
  openRef = ref;
  for (const fn of listeners) fn();
}

/** 测试用：把模块级状态清干净，否则用例之间会互相影响 */
export function resetHisui(): void {
  openRef = null;
  listeners.clear();
}

export interface HisuiAnswer {
  mood: HisuiMood;
  answer: string;
}

export interface AskOptions {
  endpoint: string;
  /** 正在问的那个词，没有就传 null */
  term?: string | null;
  /** 已经审核过的解释，作为模型唯一可信的规则来源 */
  context?: string;
  question: string;
  signal?: AbortSignal;
  /** 测的时候换成假的（和 loadDayNews / loadLevelShard 一个约定） */
  fetchImpl?: typeof fetch;
}

const MOODS: HisuiMood[] = ["neutral", "thinking", "explain", "concern", "happy", "sorry"];

/**
 * 向代理问一句。
 *
 * 只发**已经显示在屏幕上的东西**（术语名、它的释义、玩家自己敲的问题）。
 * 接入包 §5 要求按局、按进度裁剪上下文，还要过滤未来信息 —— 那需要服务端
 * 按 runId 重建可见事实，本仓没有后端，所以宁可不发：不发送的东西不会泄露。
 */
export async function askHisui(opts: AskOptions): Promise<HisuiAnswer> {
  const res = await (opts.fetchImpl ?? fetch)(opts.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      term: opts.term ?? null,
      context: opts.context ?? "",
      question: opts.question,
    }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, unknown>;
  const answer = typeof data.answer === "string" ? data.answer.trim() : "";
  if (!answer) throw new Error("空回答");
  const mood = MOODS.includes(data.mood as HisuiMood) ? (data.mood as HisuiMood) : "explain";
  return { mood, answer: answer.slice(0, 600) };
}
