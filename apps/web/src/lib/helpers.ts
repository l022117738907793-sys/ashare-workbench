/**
 * 纯函数工具层：漏斗排序/分组/过滤、规则覆盖合并、本地存储序列化、格式化、红线校验。
 *
 * 这里刻意不引用任何 DOM / React / fetch，全部可以在 node 环境下直接跑测试
 * （见 `src/App.test.ts`）。所有"取不到的数"一律返回 `null` 并由格式化函数渲染成 `—`，
 * 绝不补 0、绝不插值 —— 这是产品红线。
 */
import {
  defaultRules,
  type ReasonItem,
  type Rules,
  type SectorResult,
  type StockData,
  type StockResult,
} from "@aw/core";

// ───────────────────────────── 红线 ─────────────────────────────

/** 任何界面都不允许出现的词 */
export const RED_LINE_WORDS = ["买入", "卖出", "目标价", "必涨", "必跌"];

/** 数据不足时的统一横幅文案 */
export const NOT_ENOUGH_BANNER = "【数据不足，不许编造】";

/** 返回文本里命中的红线词（空数组 = 合规） */
export function findRedLineWords(text: string): string[] {
  return RED_LINE_WORDS.filter((w) => text.includes(w));
}

// ───────────────────────────── 格式化 ─────────────────────────────

/** 数字格式化；null/undefined/NaN → `—`（绝不显示 0 冒充） */
export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return Number(v.toFixed(digits)).toString();
}

export function fmtPct(v: number | null | undefined, digits = 2): string {
  const s = fmtNum(v, digits);
  return s === "—" ? s : `${s}%`;
}

/** 0.6213 → `62.1%`（占比类字段用） */
export function fmtRatio(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${Number((v * 100).toFixed(digits)).toString()}%`;
}

/** 成交额：元 → 亿/万 */
export function fmtAmount(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1e8) return `${fmtNum(v / 1e8, 2)} 亿`;
  if (Math.abs(v) >= 1e4) return `${fmtNum(v / 1e4, 2)} 万`;
  return fmtNum(v, 0);
}

/** 时间戳 → 北京时间 `HH:mm:ss`（显式 +8h，不看运行机器时区） */
export function beijingClock(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return "—";
  const d = new Date(ts + 8 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** 时间戳 → 北京时间 `MM-DD HH:mm`（历史记录用；0 表示"时间未知"） */
export function beijingDateTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts) || ts <= 0) return "时间未知";
  const d = new Date(ts + 8 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// ───────────────────────────── 状态配色 ─────────────────────────────

export type Tone = "good" | "warn" | "bad" | "muted";

const GOOD_STATES = new Set([
  "强",
  "持续强势",
  "正在加强",
  "开始活跃",
  "启动观察",
  "启动",
  "上升趋势初期",
  "升势中",
  "突破附近",
]);
const WARN_STATES = new Set(["正常", "震荡", "高位观察", "加速上涨", "高位加速", "高位加速后", "趋势运行中", "调整期", "回调", "回调观察"]);
const BAD_STATES = new Set(["偏弱", "走弱", "下跌趋势", "涨势走弱", "排除", "上涨后回调"]);

export function stateTone(state: string): Tone {
  if (GOOD_STATES.has(state)) return "good";
  if (WARN_STATES.has(state)) return "warn";
  if (BAD_STATES.has(state)) return "bad";
  return "muted";
}

// ───────────────────────────── 判断依据 ─────────────────────────────

export type ReasonStatus = "pass" | "fail" | "unknown";

/** 命中/未命中这类"离散判定"的 threshold 文案（此时 value 为 null 但结论有效） */
const DISCRETE_THRESHOLDS = new Set(["命中", "未命中", "是", "否"]);

export function reasonStatus(r: ReasonItem): ReasonStatus {
  if (r.value === null && !DISCRETE_THRESHOLDS.has(r.threshold)) return "unknown";
  return r.pass ? "pass" : "fail";
}

/**
 * 引擎里用 `1/0` 编码"是/否"的判定项（label 本身就是一个是非命题）。
 * 不能靠"value 是不是 0/1"来猜：`main.ret20` 这类百分比真的可能等于 0.00，
 * 那样会被误显示成"否"。
 */
const BOOLEAN_REASON_KEYS = new Set([
  "main.aboveMA20",
  "main.ma20Up",
  "sector.aboveMA20",
  "stock.aboveMA20",
  "stock.ma20Up",
  "trend.above20",
  "trend.above60",
  "trend.ma20Up",
  "trend.ma60Up",
  "pos.trendBroken",
]);

/** 少数几个 1/0 不是是非题的项，换成可读文案 */
const REASON_VALUE_OVERRIDES: Record<string, Record<number, string>> = {
  "pos.volumeHeavy": { 1: "放量", 0: "缩量/中性" },
};

/**
 * 判断依据右侧的取值文案。
 * 取不到数据时返回 `数据不足`，而不是 0 或空串。
 */
export function reasonValueText(r: ReasonItem): string {
  const override = r.value === null ? undefined : REASON_VALUE_OVERRIDES[r.key]?.[r.value];
  if (override !== undefined) return override;
  if (r.threshold === "是" || r.threshold === "否" || BOOLEAN_REASON_KEYS.has(r.key)) {
    return r.value === 1 ? "是" : r.value === 0 ? "否" : "数据不足";
  }
  if (r.value === null) {
    if (r.threshold === "命中" || r.threshold === "未命中") return r.pass ? "命中" : "未命中";
    return "数据不足";
  }
  return fmtNum(r.value);
}

export function reasonStatusText(r: ReasonItem): string {
  switch (reasonStatus(r)) {
    case "pass":
      return "通过";
    case "fail":
      return "未通过";
    default:
      return "数据不足";
  }
}

/** 逐条依据里是否有"数据不足"的项 —— 有就要在 UI 上显式提示 */
export function hasInsufficientReason(reasons: ReasonItem[]): boolean {
  return reasons.some((r) => reasonStatus(r) === "unknown");
}

// ───────────────────────────── 第二层：板块排序 ─────────────────────────────

export const SECTOR_STATE_ORDER = ["持续强势", "正在加强", "开始活跃", "震荡", "走弱"] as const;

/** 排序优先级：持续强势 0 > 正在加强 1 > 开始活跃 2 > 震荡 3 > 走弱 4；`数据不足` 排最后 */
export function sectorPriority(state: string): number {
  const i = (SECTOR_STATE_ORDER as readonly string[]).indexOf(state);
  return i === -1 ? SECTOR_STATE_ORDER.length : i;
}

/**
 * 板块列表排序：状态优先级 → breadth20 降序 → strongCount 降序 → 代码。
 * 缺数据的项排在同类末尾（`—` 不参与比较，但不会被当成 0 混进"最强"里）。
 */
export function sortSectors(list: SectorResult[]): SectorResult[] {
  return [...list].sort((a, b) => {
    const p = sectorPriority(a.state) - sectorPriority(b.state);
    if (p !== 0) return p;
    const ba = a.breadth20;
    const bb = b.breadth20;
    if (ba !== null && bb !== null && ba !== bb) return bb - ba;
    if (ba === null && bb !== null) return 1;
    if (bb === null && ba !== null) return -1;
    if (a.strongCount !== b.strongCount) return b.strongCount - a.strongCount;
    return a.code.localeCompare(b.code);
  });
}

// ───────────────────────────── 第三层：个股分组 ─────────────────────────────

export const STOCK_TYPE_ORDER = ["启动观察", "趋势观察", "回调观察", "高位观察", "排除", "数据不足"] as const;

export interface StockGroup {
  type: string;
  items: StockResult[];
}

/** 同一分组内：近20日涨幅降序（取不到数据的排后面）→ 代码 */
function sortInGroup(items: StockResult[], ret20: Map<string, number | null> | undefined): StockResult[] {
  if (!ret20) return [...items].sort((a, b) => a.code.localeCompare(b.code));
  return [...items].sort((a, b) => {
    const ra = ret20.get(a.code) ?? null;
    const rb = ret20.get(b.code) ?? null;
    if (ra !== null && rb !== null && ra !== rb) return rb - ra;
    if (ra === null && rb !== null) return 1;
    if (rb === null && ra !== null) return -1;
    return a.code.localeCompare(b.code);
  });
}

/** 按固定顺序分组，始终返回 6 个分组（空组也返回，便于显示计数） */
export function groupStockResults(
  list: StockResult[],
  ret20ByCode?: Map<string, number | null>,
): StockGroup[] {
  const groups: StockGroup[] = STOCK_TYPE_ORDER.map((t) => ({ type: t as string, items: [] }));
  const byType = new Map(groups.map((g) => [g.type, g]));
  const extra = new Map<string, StockResult[]>();
  for (const item of list) {
    const g = byType.get(item.type);
    if (g) g.items.push(item);
    else {
      const e = extra.get(item.type) ?? [];
      e.push(item);
      extra.set(item.type, e);
    }
  }
  for (const g of groups) g.items = sortInGroup(g.items, ret20ByCode);
  // 引擎将来若新增类型，也不能丢数据
  for (const [type, items] of extra) groups.push({ type, items: sortInGroup(items, ret20ByCode) });
  return groups;
}

export function stockTypeCounts(groups: StockGroup[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of groups) out[g.type] = g.items.length;
  return out;
}

// ───────────────────────────── 过滤 ─────────────────────────────

/** 代码/名称文本过滤（大小写不敏感，去空格） */
export function matchStockQuery(code: string, name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return code.toLowerCase().includes(q) || name.toLowerCase().includes(q);
}

export function filterStockResults(
  list: StockResult[],
  byCode: Map<string, StockData>,
  opts: { query?: string; industryCode?: string | null } = {},
): StockResult[] {
  const query = opts.query ?? "";
  const industryCode = opts.industryCode ?? null;
  return list.filter((r) => {
    if (!matchStockQuery(r.code, r.name, query)) return false;
    if (industryCode) {
      const s = byCode.get(r.code);
      if (!s || s.industryCode !== industryCode) return false;
    }
    return true;
  });
}

// ───────────────────────────── 实时轮询代码集合 ─────────────────────────────

export const POLL_LIMIT = 20;

/**
 * 只轮询"屏幕上看得见"的标的：
 *  - 当前打开的个股
 *  - 当前选中板块的强势成分股（注意：引擎给的是**名称**，这里需要 name→code 反查）
 *  - 当前漏斗每组的前 N 名
 * 去重、保持优先级顺序、上限 20（腾讯/东财内部还会再按 20 切批）。
 */
export function selectPollCodes(opts: {
  selectedStock?: string | null;
  sectorMemberNames?: string[];
  funnelTop?: string[];
  codeByName?: Map<string, string>;
  topPerGroup?: number;
  limit?: number;
}): string[] {
  const {
    selectedStock,
    sectorMemberNames = [],
    funnelTop = [],
    codeByName,
    topPerGroup = 3,
    limit = POLL_LIMIT,
  } = opts;
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (code: string | undefined | null) => {
    if (!code || seen.has(code) || out.length >= limit) return;
    seen.add(code);
    out.push(code);
  };

  push(selectedStock);
  for (const name of sectorMemberNames) push(codeByName?.get(name));
  funnelTop.slice(0, topPerGroup * STOCK_TYPE_ORDER.length).forEach(push);
  return out;
}

// ───────────────────────────── 规则阈值覆盖 ─────────────────────────────

export type RuleGroup = "market" | "sector" | "stock";
export type RulesOverride = Partial<Record<RuleGroup, Record<string, number>>>;

const RULE_GROUPS: RuleGroup[] = ["market", "sector", "stock"];

/** 只保留"默认规则里存在、且默认值就是数字"的字段 —— 防止 localStorage 被改坏 */
export function sanitizeRulesOverride(value: unknown): RulesOverride {
  const out: RulesOverride = {};
  if (!value || typeof value !== "object") return out;
  const rec = value as Record<string, unknown>;
  for (const group of RULE_GROUPS) {
    const patch = rec[group];
    if (!patch || typeof patch !== "object") continue;
    const defaults = defaultRules[group] as unknown as Record<string, unknown>;
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      if (typeof defaults[k] !== "number") continue;
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      clean[k] = v;
    }
    if (Object.keys(clean).length > 0) out[group] = clean;
  }
  return out;
}

export function parseRulesOverride(raw: string | null | undefined): RulesOverride {
  if (!raw) return {};
  try {
    return sanitizeRulesOverride(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function mergeRules(override?: RulesOverride | null): Rules {
  // 没有任何覆盖时直接返回默认对象本身：引用稳定，上游 useMemo 不会白算漏斗
  if (!override || overrideCount(override) === 0) return defaultRules;
  const section = <T extends object>(base: T, patch: Record<string, number> | undefined): T => {
    if (!patch) return base;
    const merged: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (typeof (base as unknown as Record<string, unknown>)[k] !== "number") continue;
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (merged[k] !== v) changed = true;
      merged[k] = v;
    }
    return (changed ? merged : base) as T;
  };
  return {
    ...defaultRules,
    market: section(defaultRules.market, override.market),
    sector: section(defaultRules.sector, override.sector),
    stock: section(defaultRules.stock, override.stock),
  };
}

export function ruleValue(rules: Rules, group: RuleGroup, key: string): number {
  const v = (rules[group] as unknown as Record<string, unknown>)[key];
  return typeof v === "number" ? v : Number.NaN;
}

export interface RuleField {
  group: RuleGroup;
  key: string;
  /** 中文说明（含比较方向） */
  label: string;
  step: number;
  unit: string;
}

/** 设置页里暴露的"最有意义"的一小部分阈值（不是全部规则） */
export const RULE_FIELDS: RuleField[] = [
  { group: "market", key: "strong20Pct", label: "大盘「强」：沪深300 近20日涨幅 ≥", step: 0.5, unit: "%" },
  { group: "market", key: "weak20Pct", label: "大盘「偏弱」：近20日涨幅 ≤", step: 0.5, unit: "%" },
  { group: "market", key: "breadthStrong", label: "大盘「强」：上涨家数占比 ≥", step: 0.05, unit: "（0~1）" },
  { group: "sector", key: "strong20Pct", label: "板块「持续强势」：近20日涨幅 ≥", step: 0.5, unit: "%" },
  { group: "sector", key: "strongStockMin", label: "板块内强势股数量 ≥", step: 1, unit: "只" },
  { group: "sector", key: "accelAccelPct", label: "板块「正在加强」：5日加速度 ≥", step: 0.5, unit: "pct" },
  { group: "sector", key: "weak20Pct", label: "板块「走弱」：近20日涨幅 ≤", step: 0.5, unit: "%" },
  { group: "stock", key: "minDays", label: "最少可用交易日 ≥", step: 1, unit: "日" },
  { group: "stock", key: "start20Min", label: "启动观察：近20日涨幅 ≥", step: 0.5, unit: "%" },
  { group: "stock", key: "startVolumeRatio", label: "启动观察：量比 ≥", step: 0.1, unit: "倍" },
  { group: "stock", key: "trendDist20Max", label: "趋势观察：距20日线 ≤", step: 1, unit: "%" },
  { group: "stock", key: "high20Min", label: "高位观察：近20日涨幅 ≥", step: 1, unit: "%" },
  { group: "stock", key: "pullbackMin", label: "回调观察：回调幅度 ≥", step: 0.5, unit: "%" },
  { group: "stock", key: "exclude20Max", label: "排除：近20日涨幅 ≤", step: 0.5, unit: "%" },
];

export function setRuleOverride(
  override: RulesOverride,
  group: RuleGroup,
  key: string,
  value: number,
): RulesOverride {
  if (!Number.isFinite(value)) return clearRuleOverride(override, group, key);
  return { ...override, [group]: { ...(override[group] ?? {}), [key]: value } };
}

export function clearRuleOverride(override: RulesOverride, group: RuleGroup, key: string): RulesOverride {
  const section = { ...(override[group] ?? {}) };
  delete section[key];
  const next: RulesOverride = { ...override };
  if (Object.keys(section).length === 0) delete next[group];
  else next[group] = section;
  return next;
}

export function overrideCount(override: RulesOverride): number {
  return RULE_GROUPS.reduce((n, g) => n + Object.keys(override[g] ?? {}).length, 0);
}

// ───────────────────────────── 设置 ─────────────────────────────

export interface AppSettings {
  /** 数据根路径，默认 `./data` */
  dataBase: string;
  /** 盘中轮询间隔（毫秒），限制在 3000~5000 */
  refreshMs: number;
  ruleOverrides: RulesOverride;
}

export const MIN_REFRESH_MS = 3000;
export const MAX_REFRESH_MS = 5000;

export const DEFAULT_SETTINGS: AppSettings = {
  dataBase: "./data",
  refreshMs: 4000,
  ruleOverrides: {},
};

export function clampRefresh(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_SETTINGS.refreshMs;
  return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, Math.round(ms)));
}

export function sanitizeDataBase(input: string): string {
  const t = (input ?? "").trim();
  if (t === "") return DEFAULT_SETTINGS.dataBase;
  if (/^https?:\/\//i.test(t)) return t.replace(/\/+$/, "");
  const stripped = t.replace(/\/+$/, "");
  return stripped === "" ? "/" : stripped;
}

export function parseSettings(raw: string | null | undefined): AppSettings {
  let obj: unknown = null;
  try {
    obj = raw ? JSON.parse(raw) : null;
  } catch {
    obj = null;
  }
  const rec = (obj && typeof obj === "object" ? obj : {}) as Record<string, unknown>;
  return {
    dataBase: typeof rec.dataBase === "string" ? sanitizeDataBase(rec.dataBase) : DEFAULT_SETTINGS.dataBase,
    refreshMs: typeof rec.refreshMs === "number" ? clampRefresh(rec.refreshMs) : DEFAULT_SETTINGS.refreshMs,
    ruleOverrides: sanitizeRulesOverride(rec.ruleOverrides),
  };
}

export function serializeSettings(s: AppSettings): string {
  return JSON.stringify({
    dataBase: sanitizeDataBase(s.dataBase),
    refreshMs: clampRefresh(s.refreshMs),
    ruleOverrides: sanitizeRulesOverride(s.ruleOverrides),
  });
}

// ───────────────────────────── 本地历史 ─────────────────────────────

export interface AnalysedEntry {
  code: string;
  name: string;
  type: string;
  at: number;
}

export interface LearningEntry extends AnalysedEntry {
  question: string;
  answer: string;
}

export interface LocalStore {
  version: number;
  analysed: AnalysedEntry[];
  learning: LearningEntry[];
}

export const STORE_VERSION = 1;
export const STORE_MAX = 60;

export const EMPTY_STORE: LocalStore = { version: STORE_VERSION, analysed: [], learning: [] };

export const LS_SETTINGS = "aw.settings.v1";
export const LS_STORE = "aw.store.v1";

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function pickEntry(v: unknown): AnalysedEntry | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.code !== "string" || r.code === "") return null;
  return {
    code: r.code,
    name: typeof r.name === "string" ? r.name : r.code,
    type: typeof r.type === "string" ? r.type : "数据不足",
    at: typeof r.at === "number" && Number.isFinite(r.at) ? r.at : 0,
  };
}

export function parseStore(raw: string | null | undefined): LocalStore {
  let obj: unknown = null;
  try {
    obj = raw ? JSON.parse(raw) : null;
  } catch {
    return { ...EMPTY_STORE };
  }
  if (!obj || typeof obj !== "object") return { ...EMPTY_STORE };
  const rec = obj as Record<string, unknown>;
  const analysed = asArray(rec.analysed)
    .map(pickEntry)
    .filter((e): e is AnalysedEntry => e !== null);
  const learning = asArray(rec.learning)
    .map((v) => {
      const base = pickEntry(v);
      if (!base) return null;
      const r = v as Record<string, unknown>;
      const question = typeof r.question === "string" ? r.question : "";
      const answer = typeof r.answer === "string" ? r.answer : "";
      if (answer.trim() === "") return null;
      return { ...base, question, answer } satisfies LearningEntry;
    })
    .filter((e): e is LearningEntry => e !== null);
  return { version: STORE_VERSION, analysed, learning };
}

export function serializeStore(s: LocalStore): string {
  return JSON.stringify({
    version: STORE_VERSION,
    analysed: s.analysed.slice(0, STORE_MAX),
    learning: s.learning.slice(0, STORE_MAX),
  });
}

/** 最近分析：按代码去重，最新的排最前 */
export function pushAnalysed(s: LocalStore, entry: AnalysedEntry, max = STORE_MAX): LocalStore {
  const rest = s.analysed.filter((e) => e.code !== entry.code);
  return { ...s, version: STORE_VERSION, analysed: [entry, ...rest].slice(0, max) };
}

/** 学习记录：不去重（同一个问题可以反复作答），最新的排最前 */
export function pushLearning(s: LocalStore, entry: LearningEntry, max = STORE_MAX): LocalStore {
  return { ...s, version: STORE_VERSION, learning: [entry, ...s.learning].slice(0, max) };
}

export function removeAnalysed(s: LocalStore, code: string): LocalStore {
  return { ...s, analysed: s.analysed.filter((e) => e.code !== code) };
}

// ───────────────────────────── localStorage 薄封装 ─────────────────────────────

export function readLS(key: string): string | null {
  try {
    if (typeof globalThis.localStorage === "undefined") return null;
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLS(key: string, value: string): void {
  try {
    if (typeof globalThis.localStorage === "undefined") return;
    globalThis.localStorage.setItem(key, value);
  } catch {
    /* 隐私模式 / 配额满：静默降级，不影响分析 */
  }
}

export function removeLS(key: string): void {
  try {
    if (typeof globalThis.localStorage === "undefined") return;
    globalThis.localStorage.removeItem(key);
  } catch {
    /* 同上 */
  }
}
