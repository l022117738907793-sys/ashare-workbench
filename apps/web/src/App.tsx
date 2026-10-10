/**
 * 应用外壳：标签页切换（无路由）、快照加载、漏斗计算、实时行情轮询与本地持久化。
 *
 * 数据流：
 *   bundle（静态快照） → 基础漏斗（同时决定"该轮询哪些代码"）
 *   实时报价 → applyLivePrices(bundle) → liveSnapshot → 展示用漏斗 / 七步报告
 * 基础漏斗必须独立算一次：否则"报价 → 快照 → 漏斗 → 轮询代码 → 报价"会自我循环。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  analyzeMarket,
  analyzeSector,
  buildReport,
  classifyStock,
  computeStockMetrics,
  deriveSignal,
  deriveSignals,
  type AnalysisReport,
  type Maybe,
  type SectorResult,
  type StockData,
  type StockMetrics,
  type StockResult,
} from "@aw/core";
import {
  applyLivePrices,
  convertSnapshotToCny,
  currencyOf,
  fxRatesOfMeta,
  fxSeriesOfMeta,
  loadSnapshot,
  sessionLabel,
  sessionState,
  sourceLabel,
  type FxRates,
  type Quote,
  type SessionMarket,
  type SnapshotBundle,
} from "@aw/data";
import {
  executeOrder,
  holdingsValue as calcHoldingsValue,
  MARKET_NAME,
  marketGroupOf,
  type MarketGroup,
  rolloverTradingDay,
  settleSeason,
  totalAssets as calcTotalAssets,
  levelById,
  LEVELS,
  type EquityPoint,
  type ReplayLevel,
  type SeasonResult,
  type Side,
  type Trade,
} from "@aw/game";
import { AppIcon } from "./components/AppIcon";
import { resetCampaignNotes } from "./lib/campaign";
import { GameCompanion } from "./components/GameCompanion";
import { AnalysisView } from "./components/AnalysisView";
import { GameRulesView } from "./components/GameRulesView";
import { GuideView } from "./components/GuideView";
import { GameView, type BacktrackPlan } from "./components/GameView";
import { HistoryView } from "./components/HistoryView";
import { GameHistoryView } from "./components/GameHistoryView";
import { SettingsView } from "./components/SettingsView";
import { WorkbenchView } from "./components/WorkbenchView";
import { ReplayView } from "./components/ReplayView";
import { LevelPicker } from "./components/LevelPicker";
import {
  awayReport,
  humanAway,
  makeMark,
  worthReporting,
  type AwayReport,
  type MarkSnapshot,
} from "./lib/awayReport";
import { Notice } from "./components/common";
import {
  advanceDays,
  cancelOrder,
  placeOrder,
  loadLevelIndex,
  loadLevelShard,
  startLevelReplay,
  restoreLevelReplay,
  startReplay,
  toSave,
  restoreReplay,
  readReplaySave,
  replayAvailable,
  backtrackOptions,
  backtrackStocks,
  BACKTRACK_DAYS,
  LS_REPLAY,
  type BacktrackOption,
  type ReplaySession,
} from "./lib/replay";
import {
  benchmarkCurve,
  CASH_OPTIONS,
  DEFAULT_INITIAL_CASH,
  defaultGameState,
  startGame,
  lastBuyDates,
  LS_GAME,
  parseGameState,
  pushEquity,
  serializeGameState,
  type GameState,

  samePeriodBenchmark,
  gameWatchCodes,
} from "./lib/game";
import {
  beijingClock,
  filterStockResults,
  groupStockResults,
  LS_GUIDE_SEEN,
  LS_SETTINGS,
  LS_STORE,
  LS_TAB,
  marketsPresent,
  mergeRules,
  parseSettings,
  parseStore,
  pushAnalysed,
  pushLearning,
  readLS,
  removeAnalysed,
  removeLS,
  sanitizeDataBase,
  selectPollCodes,
  serializeSettings,
  serializeStore,
  sortSectors,
  stockTypeCounts,
  writeLS,
  type AppSettings,
  type LocalStore,
} from "./lib/helpers";
import { useLiveQuotes } from "./lib/useLiveQuotes";
import { useLiveNews } from "./lib/useLiveNews";

// "rules" 与 "guide" 不是底部 tab，而是子页面：
// "rules" 从模拟游戏进入，"guide" 从页头进入（放在最显眼处，同学才会看到）
// "settings" 也不再占底部一格：它从页头右上角的齿轮进（齿轮是设置最通行的入口，
// 常驻底栏反而不如一个图标省地方）。历史则并进了「个股分析」页，理由见那里的注释。
type Tab = "workbench" | "analysis" | "game" | "rules" | "guide" | "settings";

// 底部导航只留三条主干。三格比五格好按，也不用再猜「历史」和「设置」算不算主功能。
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "game", label: "游戏大厅" },
  { key: "workbench", label: "市场观察" },
  { key: "analysis", label: "学习笔记" },
];

/**
 * 刷新之后能恢复的页面，只有底部那三条主干。
 *
 * 设置、规则、说明都是「进去看一眼就出来」的子页面 —— 刷新后停在那里，
 * 玩家会以为自己被困住了。所以它们只在内存里活着。
 */
const RESTORABLE_TABS: readonly Tab[] = ["game", "workbench", "analysis"];

function loadTab(): Tab {
  const v = readLS(LS_TAB);
  return v !== null && (RESTORABLE_TABS as readonly string[]).includes(v) ? (v as Tab) : "game";
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 模拟游戏的业绩基准 */
const BENCHMARK_CODE = "000300.SH";

function lastClose(close: Maybe[]): number | null {
  for (let i = close.length - 1; i >= 0; i -= 1) {
    const v = close[i];
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

export default function App() {
  const [tab, setTab] = useState<Tab>(loadTab);
  const [settings, setSettings] = useState<AppSettings>(() => parseSettings(readLS(LS_SETTINGS)));
  const [store, setStore] = useState<LocalStore>(() => parseStore(readLS(LS_STORE)));
  // 首次访问提示：只在没看过说明时出现，点过就永久收起
  const [guideSeen, setGuideSeen] = useState<boolean>(() => readLS(LS_GUIDE_SEEN) === "1");
  const openGuide = useCallback(() => {
    setTab("guide");
    setGuideSeen(true);
    writeLS(LS_GUIDE_SEEN, "1");
  }, []);

  useEffect(() => writeLS(LS_SETTINGS, serializeSettings(settings)), [settings]);
  useEffect(() => writeLS(LS_STORE, serializeStore(store)), [store]);
  // 只记三条主干；进设置/规则/说明时不覆盖，免得下次刷新被带到子页面
  useEffect(() => {
    if (RESTORABLE_TABS.includes(tab)) writeLS(LS_TAB, tab);
  }, [tab]);

  // ── 模拟游戏账户（纯本地，无后端）──────────────────────────────
  const [game, setGame] = useState<GameState>(() => parseGameState(readLS(LS_GAME)));
  useEffect(() => writeLS(LS_GAME, serializeGameState(game)), [game]);

  /**
   * 下单卡里当前选中的标的（由 GameView 上报）。
   *
   * 只为了一件事：把它加进 `visibleCodes`，好在成交之前就拿到实时价。
   * 见下面 `visibleCodes` 的 game 分支 —— 没有它，显示价与成交价会是两个时刻的。
   */
  const [gamePick, setGamePick] = useState<string | null>(null);

  /**
   * 「你不在的这段时间」。
   *
   * `awayFromRef` 取的是**进页面那一刻**存档里的旧快照 —— 下面那个 effect 马上会把
   * lastMark 覆盖成「现在」，所以必须先摘下来，否则永远只能比出「离开 0 分钟」。
   */
  const awayFromRef = useRef<MarkSnapshot | null>(game.lastMark);
  const [away, setAway] = useState<AwayReport | null>(null);
  /** 每次进页面只报一次；也是「可以先刷新 lastMark 了」的闸门 */
  const awayChecked = useRef(false);
  /** lastMark 的刷新间隔。太密没有意义，也会一直写 localStorage */
  const MARK_INTERVAL_MS = 60_000;

  // ── 历史推演（模式 3：随机开局）─────────────────────────────
  // 存档里只有进度，行情每次从快照还原 —— 六十万个数字塞不进 localStorage。
  const [replayGeneration, setReplayGeneration] = useState(0);
  const [replay, setReplay] = useState<ReplaySession | null>(null);
  const replayRestored = useRef(false);
  /*
   * 模拟游戏页显示哪一边。
   *
   * 实时模式和历史推演各有各的存档（aw.game.v1 / aw.replay.v1），本来就能同时
   * 存在 —— 问题是推演一开始整页就被它占满，实时那边看不到也回不去，玩家会以为
   * 自己的开局被清掉了。所以给两边一个并排的入口。
   *
   * "history" 是游戏记录：把两边的成交与结算并成一条时间线，只读，可以跳回去。
   */
  const [gamePane, setGamePane] = useState<"live" | "replay" | "history">("live");
  // 传奇模式（模式 2）的关卡选择：只在没开局时出现
  const [legendOpen, setLegendOpen] = useState(false);
  /*
   * 换页回到顶部。
   *
   * 必须用 useLayoutEffect，不能用 useEffect。React 的 effect 是子组件先跑、父组件后跑，
   * 而「去筛选」的跳转（WorkbenchView 里那个 useEffect）用的是 behavior:"smooth"，
   * 是**动画**：父组件随后这句 scrollTo({top:0}) 会当场把它取消掉，玩家点了「去筛选」
   * 却停在页首。layout effect 整批先于 passive effect 执行，顺序就对了。
   */
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [tab, gamePane, legendOpen, game.status]);
  const [legendLoading, setLegendLoading] = useState<string | null>(null);
  const [legendError, setLegendError] = useState<string | null>(null);
  // 站点里发布了哪几关（读 history/index.json）。null = 还没问过。
  const [legendIds, setLegendIds] = useState<string[] | null>(null);
  useEffect(() => {
    if (!replay) return;
    writeLS(LS_REPLAY, JSON.stringify(toSave(replay.state, {
      mode: replay.mode,
      hideDate: replay.hideDate,
      codes: replay.codes,
      levelId: replay.levelId,
    })));
  }, [replay]);

  const rules = useMemo(() => mergeRules(settings.ruleOverrides), [settings.ruleOverrides]);

  // ── 快照加载 ────────────────────────────────────────────────
  const [bundle, setBundle] = useState<SnapshotBundle | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadNonce, setReloadNonce] = useState(0);

  const base = settings.dataBase;
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadSnapshot({ base })
      .then((b) => {
        if (cancelled) return;
        /*
         * 快照里的港股价是**港币**（快照按本币存，与历史推演分片同一约定），
         * 而账户、漏斗、权益曲线全是人民币。折算必须发生在数据进引擎之前 ——
         * 就在这里一次性折掉，下游一行都不用改，与推演走 `convertShardToCny`
         * 是同一个道理。
         *
         * `meta` 里没有汇率时原样返回（不猜、也不按 1:1 顶），
         * 那些标的靠 `currency` 字段在界面上标注。
         *
         * 汇率给**两个**：逐日序列优先，它让历史推演里的境外标的按当天的价折；
         * 标量兜底（序列长度对不上日历、或老快照根本没有这一列时用）。
         * 实时盘只用得到最后一天，两种口径在那一格上是同一个数。
         */
        const fx = fxRatesOfMeta(b.meta);
        const fxSeries = fxSeriesOfMeta(b.meta, b.calendar.length);
        setBundle({ ...b, snapshot: convertSnapshotToCny(b.snapshot, fx, fxSeries) });
        setLoadError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setBundle(null);
        setLoadError(errText(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [base, reloadNonce]);

  const snapshot = bundle?.snapshot ?? null;
  const calendar = bundle?.calendar;

  /**
   * 境外各市场的交易日历（`meta.hk/jp/kr.calendar`，由快照脚本从该市场大盘股日线反推）。
   *
   * 为什么必须与 A 股日历分开：A 股与境外放假不同。国庆那一周 A 股全休、
   * 港股照常开市，只看 A 股日历会整天不发请求，港股价格就永远停在快照里。
   * 日韩同理（日本黄金周、韩国秋夕那几天 A 股照常开市）。
   */
  const calendars = useMemo(() => {
    const out: Partial<Record<SessionMarket, string[]>> = {};
    for (const market of ["HK", "JP", "KR"] as const) {
      const block = (bundle?.meta as Record<string, unknown> | undefined)?.[market.toLowerCase()];
      if (!block || typeof block !== "object") continue;
      const cal = (block as { calendar?: unknown }).calendar;
      if (Array.isArray(cal) && cal.every((d) => typeof d === "string")) out[market] = cal as string[];
    }
    return out;
  }, [bundle]);

  /** 汇率表：1 单位外币值多少人民币。取不到就是空表 —— 调用方必须自己判断，不许当 1:1 */
  const fxRates: FxRates = useMemo(() => (bundle ? fxRatesOfMeta(bundle.meta) : {}), [bundle]);

  /**
   * 某个标的的结算汇率（1 单位本币值多少人民币）；取不到返回 null。
   *
   * **null 不是「按 1:1」** —— 港币当人民币是 14% 的静默偏差，界面上一片正常。
   * 凡是人民币口径的计算（折算价格、算佣金、入账）都必须先过这一关：
   * 拿不到汇率就宁可拒绝下单 / 停在旧价，也不许猜。
   */
  const fxFor = useCallback(
    (code: string): number | null => {
      const cur = currencyOf(code);
      if (cur === "CNY") return 1;
      const rate = fxRates[cur];
      return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : null;
    },
    [fxRates],
  );

  // ── 基础漏斗（用于挑选轮询代码；不叠加实时价）────────────────
  const stockByCode = useMemo(() => {
    const m = new Map<string, StockData>();
    for (const s of snapshot?.stocks ?? []) m.set(s.code, s);
    return m;
  }, [snapshot]);

  const codeByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of snapshot?.stocks ?? []) if (!m.has(s.name)) m.set(s.name, s.code);
    return m;
  }, [snapshot]);

  const [sectorCode, setSectorCode] = useState<string | null>(null);
  /**
   * 「个股分类」的第二种切法：按市场分档。null = 全部市场。
   *
   * 与板块筛选是**叠加**关系，不是二选一：先按板块缩小，再按市场看。
   * 之所以从代码推断而不是读快照的 market 字段，见 helpers.ts 里 filterStockResults 的注释。
   */
  const [marketFilter, setMarketFilter] = useState<MarketGroup | null>(null);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  /**
   * 「去筛选」的跳转信号：每加一，筛选页就滚到「③ 个股分类」并闪一下。
   *
   * 用计数器不用布尔量 —— 连着点两次要闪两次，布尔量第二次点就没反应了。
   */
  const [focusStocks, setFocusStocks] = useState(0);
  const [query, setQuery] = useState("");

  const baseSectors: SectorResult[] = useMemo(() => {
    if (!snapshot) return [];
    return sortSectors(snapshot.sectors.map((s) => analyzeSector(s, stockByCode, rules)));
  }, [snapshot, stockByCode, rules]);

  const baseMarket = useMemo(() => (snapshot ? analyzeMarket(snapshot, rules) : null), [snapshot, rules]);

  const baseStocks: StockResult[] = useMemo(
    () => (snapshot ? snapshot.stocks.map((s) => classifyStock(s, rules)) : []),
    [snapshot, rules],
  );

  const baseMetrics = useMemo(() => {
    const m = new Map<string, StockMetrics>();
    for (const s of snapshot?.stocks ?? []) m.set(s.code, computeStockMetrics(s, rules));
    return m;
  }, [snapshot, rules]);

  const baseRet20 = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const [code, mt] of baseMetrics) m.set(code, mt.ret20);
    return m;
  }, [baseMetrics]);

  const baseGroups = useMemo(
    () => groupStockResults(filterStockResults(baseStocks, stockByCode, { query, industryCode: sectorCode }), baseRet20),
    [baseStocks, stockByCode, query, sectorCode, baseRet20],
  );

  const selectedSectorBase = useMemo(
    () => baseSectors.find((s) => s.code === sectorCode) ?? null,
    [baseSectors, sectorCode],
  );

  const analysisSectorBase = useMemo(() => {
    if (!selectedCode) return null;
    const stock = stockByCode.get(selectedCode);
    if (!stock) return null;
    return baseSectors.find((s) => s.code === stock.industryCode) ?? null;
  }, [baseSectors, selectedCode, stockByCode]);

  // ── 轮询集合：只包含"屏幕上看得见"的标的 ─────────────────────
  const visibleCodes = useMemo(() => {
    if (!snapshot) return [];
    if (tab === "analysis") {
      if (!selectedCode) return [];
      return selectPollCodes({
        selectedStock: selectedCode,
        sectorMemberNames: analysisSectorBase?.strongestMembers ?? [],
        codeByName,
      });
    }
    if (tab === "workbench") {
      const funnelTop = baseGroups.flatMap((g) => g.items.slice(0, 3).map((i) => i.code));
      return selectPollCodes({
        selectedStock: null,
        sectorMemberNames: selectedSectorBase?.strongestMembers ?? [],
        funnelTop,
        codeByName,
      });
    }
    if (tab === "game") {
      /*
       * 模拟游戏要盯的是自己的持仓，**外加正在下的那一单**。
       *
       * 只盯持仓会出岔子：想买的票在买之前没有实时价，下单卡显示的是快照
       * 收盘价（往往是昨收），成交也按这个价；一买入它变成持仓、立刻拿到
       * 实时价，账户瞬间多出一笔浮盈。那不是赚了，是两套价混用。
       * 选中的标的由 GameView 上报（onPickCode），一起进轮询集合。
       */
      return selectPollCodes({
        selectedStock: null,
        sectorMemberNames: [],
        funnelTop: gameWatchCodes(game.account.holdings.map((h) => h.code), gamePick),
        codeByName,
      });
    }
    return []; // 历史 / 设置页没有行情要看，就不请求
  }, [snapshot, tab, selectedCode, analysisSectorBase, selectedSectorBase, baseGroups, codeByName, game.account.holdings, gamePick]);

  const live = useLiveQuotes(visibleCodes, {
    intervalMs: settings.refreshMs,
    calendar,
    calendars,
    enabled: !!snapshot,
    nonce: reloadNonce,
  });

  // 新闻与行情节奏不同：行情 3~5 秒，新闻 3 分钟。只在模拟游戏页且已开局时拉取。
  const news = useLiveNews({
    enabled: tab === "game" && game.status === "playing",
  });

  const session = sessionState(new Date(), calendar);
  /*
   * 境外市场各自的时段与 A 股不同：港股午休 12:00–13:00、收盘 16:00；
   * 日股 09:00–11:30 / 12:30–15:30 JST；韩股 09:00–15:30 KST **没有午休**。
   * 只有拿到该市场的日历才算它的时段 —— 没有日历就等于不知道它放不放假，
   * 那时候退回「按 A 股的说法」而不是硬报一个「交易中」。
   */
  const overseasOpen = (["HK", "JP", "KR"] as const)
    .map((market) => ({ market, state: calendars[market] ? sessionState(new Date(), calendars[market], market) : null }))
    .filter((x) => x.state === "open");
  /*
   * 「此刻能不能按实时价成交」看的是**所有市场合起来**开不开门。
   * 15:00–16:00 这一段 A 股已收盘、港股还在连续竞价；只按 A 股判断，
   * 会把港股的实时成交错标成「按最近收盘价成交」。日韩收盘更早（北京 14:30），
   * 但早盘 08:00 就开，同样会被 A 股时段盖住。
   */
  const isTradingNow = session === "open" || overseasOpen.length > 0;
  const sessionText =
    session === "open"
      ? sessionLabel(session)
      : overseasOpen.length > 0
        ? `${overseasOpen.map((x) => MARKET_NAME[x.market]).join("、")}交易中`
        : sessionLabel(session);

  // ── 实时叠加后的快照与展示用漏斗 ────────────────────────────
  const liveSnapshot = useMemo(() => {
    if (!bundle) return null;
    const quotes = live.result?.quotes ?? [];
    if (quotes.length === 0) return bundle.snapshot;
    return applyLivePrices(bundle, quotes, { today: live.today, calendars, fx: fxRates });
  }, [bundle, live.result, live.today, calendars, fxRates]);

  const quotesByCode = useMemo(() => {
    const m = new Map<string, Quote>();
    for (const q of live.result?.quotes ?? []) m.set(q.code, q);
    return m;
  }, [live.result]);

  const liveSectors: SectorResult[] = useMemo(() => {
    if (!liveSnapshot) return [];
    const byCode = new Map(liveSnapshot.stocks.map((s) => [s.code, s]));
    return sortSectors(liveSnapshot.sectors.map((s) => analyzeSector(s, byCode, rules)));
  }, [liveSnapshot, rules]);

  const liveMarket = useMemo(
    () => (liveSnapshot ? analyzeMarket(liveSnapshot, rules) : baseMarket),
    [liveSnapshot, rules, baseMarket],
  );

  const liveStocks: StockResult[] = useMemo(
    () => (liveSnapshot ? liveSnapshot.stocks.map((s) => classifyStock(s, rules)) : []),
    [liveSnapshot, rules],
  );

  /** 全池交易信号，按强度降序 */
  const liveSignals = useMemo(
    () => (liveSnapshot ? deriveSignals(liveSnapshot.stocks, rules) : []),
    [liveSnapshot, rules],
  );

  /** 当前选中个股的信号（不在池中则为 null） */
  const selectedSignal = useMemo(() => {
    if (!liveSnapshot || !selectedCode) return null;
    const stock = liveSnapshot.stocks.find((s) => s.code === selectedCode);
    return stock ? deriveSignal(stock, rules) : null;
  }, [liveSnapshot, selectedCode, rules]);

  const liveMetrics = useMemo(() => {
    const m = new Map<string, StockMetrics>();
    for (const s of liveSnapshot?.stocks ?? []) m.set(s.code, computeStockMetrics(s, rules));
    return m;
  }, [liveSnapshot, rules]);

  const liveRet20 = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const [code, mt] of liveMetrics) m.set(code, mt.ret20);
    return m;
  }, [liveMetrics]);

  const filteredStocks = useMemo(
    () => filterStockResults(liveStocks, stockByCode, { query, industryCode: sectorCode }),
    [liveStocks, stockByCode, query, sectorCode],
  );

  /**
   * 分档统计必须先于市场筛选算：筛掉港股之后，「港股 20」这个数字还得看得见，
   * 否则点进任何一个市场分档，其它分档就消失了，人就换不回去了。
   */
  const marketOptions = useMemo(() => marketsPresent(filteredStocks), [filteredStocks]);
  const marketCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const r of filteredStocks) {
      const m = marketGroupOf(r.code);
      out[m] = (out[m] ?? 0) + 1;
    }
    return out;
  }, [filteredStocks]);

  const visibleStocks = useMemo(
    () =>
      marketFilter === null
        ? filteredStocks
        : filterStockResults(filteredStocks, stockByCode, { market: marketFilter }),
    [filteredStocks, stockByCode, marketFilter],
  );

  const groups = useMemo(() => groupStockResults(visibleStocks, liveRet20), [visibleStocks, liveRet20]);
  const counts = useMemo(() => stockTypeCounts(groups), [groups]);

  const mainIndexText = useMemo(() => {
    if (!liveSnapshot || !liveMarket) return null;
    const main = liveSnapshot.indices.find((i) => i.code === rules.market.mainIndex);
    if (!main) return null;
    const price = lastClose(main.close);
    const asOf = typeof liveSnapshot.meta?.asOf === "string" ? liveSnapshot.meta.asOf : null;
    return `主指数 ${main.name}（${main.code}）最新收盘 ${price === null ? "—" : price.toFixed(2)}${
      asOf ? ` · 快照数据日期 ${asOf}` : ""
    }`;
  }, [liveSnapshot, liveMarket, rules.market.mainIndex]);

  // ── 个股分析 ────────────────────────────────────────────────
  const analysis = useMemo((): {
    report: AnalysisReport | null;
    error: string | null;
    metrics: StockMetrics | null;
    reasons: ReturnType<typeof classifyStock>["reasons"];
    stock: StockData | null;
  } => {
    if (!liveSnapshot || !selectedCode) {
      return { report: null, error: null, metrics: null, reasons: [], stock: null };
    }
    const stock = liveSnapshot.stocks.find((s) => s.code === selectedCode) ?? null;
    if (!stock) {
      return { report: null, error: `当前快照里没有代码 ${selectedCode}`, metrics: null, reasons: [], stock: null };
    }
    try {
      return {
        report: buildReport(liveSnapshot, selectedCode, rules),
        error: null,
        metrics: computeStockMetrics(stock, rules),
        reasons: classifyStock(stock, rules).reasons,
        stock,
      };
    } catch (e) {
      return { report: null, error: errText(e), metrics: null, reasons: [], stock };
    }
  }, [liveSnapshot, selectedCode, rules]);

  const snapshotPrice = useMemo(() => {
    const s = snapshot?.stocks.find((x) => x.code === selectedCode);
    return s ? lastClose(s.close) : null;
  }, [snapshot, selectedCode]);

  const metaAsOf = typeof bundle?.meta?.asOf === "string" ? (bundle.meta.asOf as string) : null;

  // ── 交互 ────────────────────────────────────────────────────
  const openStock = useCallback(
    (code: string) => {
      setSelectedCode(code);
      setTab("analysis");
      const result =
        liveStocks.find((r) => r.code === code) ?? baseStocks.find((r) => r.code === code) ?? null;
      const stock = stockByCode.get(code);
      if (stock) {
        setStore((s) =>
          pushAnalysed(s, {
            code,
            name: stock.name,
            type: result?.type ?? "数据不足",
            at: Date.now(),
          }),
        );
      }
    },
    [liveStocks, baseStocks, stockByCode],
  );

  const saveLearning = useCallback(
    (question: string, answer: string) => {
      if (!selectedCode) return;
      const stock = stockByCode.get(selectedCode);
      if (!stock) return;
      const type = analysis.report?.currentType ?? "数据不足";
      setStore((s) =>
        pushLearning(s, {
          code: stock.code,
          name: stock.name,
          type,
          question,
          answer,
          at: Date.now(),
        }),
      );
    },
    [selectedCode, stockByCode, analysis.report],
  );

  const clearLocal = useCallback(() => {
    removeLS(LS_SETTINGS);
    removeLS(LS_STORE);
    setSettings(parseSettings(null));
    setStore(parseStore(null));
    setSelectedCode(null);
    setSectorCode(null);
    setMarketFilter(null);
    setQuery("");
    setTab("workbench");
    setReloadNonce((n) => n + 1);
  }, []);

  const degraded = live.result?.degradedReason ?? null;
  const updatedText = live.updatedAt === null ? "—（暂无实时数据）" : beijingClock(live.updatedAt);
  const quoteSourceText = live.result ? sourceLabel(live.result.source) : "—（未取到实时行情）";
  // ── 模拟游戏 ──────────────────────────────────────────────────
  // isTradingNow 与 sessionText 在上面按「所有市场任一开市」算过了

  /** 价格表：先用快照收盘价铺底，再用实时价覆盖。取不到的保持 null（不猜） */
  const gamePricesObj = useMemo(() => {
    const o: Record<string, number | null> = {};
    for (const s of (liveSnapshot ?? snapshot)?.stocks ?? []) o[s.code] = lastClose(s.close);
    /*
     * 快照那一层已经折成人民币（见加载处的 convertSnapshotToCny），
     * 而 `live.result` 里的报价**仍然与本币一致**（腾讯给港股的就是港币）——
     * 所以这里必须自己折一次，否则 431 港币会被当成 ¥431 覆盖掉正确的收盘价。
     */
    for (const [code, q] of quotesByCode) {
      if (q.price === null) continue;
      const rate = fxFor(code);
      if (rate === null) continue; // 拿不到汇率就别覆盖，宁可显示旧的收盘价
      o[code] = rate === 1 ? q.price : Math.round(q.price * rate * 1e4) / 1e4;
    }
    return o;
  }, [liveSnapshot, snapshot, quotesByCode, fxFor]);

  const gamePrices = useMemo(() => new Map(Object.entries(gamePricesObj)), [gamePricesObj]);

  const gameHoldingsValue = useMemo(
    () => calcHoldingsValue(game.account, gamePricesObj),
    [game.account, gamePricesObj],
  );
  const gameTotalAssets = useMemo(
    () => calcTotalAssets(game.account, gamePricesObj),
    [game.account, gamePricesObj],
  );

  /**
   * 回来时对比一次：进页面第一次拿到行情后，拿旧快照和现在比。
   *
   * 闸门 `awayChecked` 卡在三件事上：① 只跑一次；② 等第一次行情**落定**
   * （成功或失败都算落定，失败时用快照收盘价，不能永远不报）；
   * ③ 跑完之后才允许下面的 effect 覆盖 lastMark，保证比的是「离开时」而不是「刚刚」。
   */
  useEffect(() => {
    if (awayChecked.current) return;
    if (!snapshot || game.status !== "playing") return;
    const settled = live.updatedAt !== null || live.error !== null;
    if (!settled) return;

    awayChecked.current = true;
    const then = awayFromRef.current;
    if (!then) return;

    const positions = game.account.holdings.map((h) => ({
      code: h.code,
      name: h.name,
      shares: h.shares,
      price: gamePricesObj[h.code] ?? null,
    }));
    const r = awayReport(then, { at: Date.now(), cash: game.account.cash, positions }, game.account.trades);
    if (worthReporting(r)) setAway(r);
  }, [snapshot, game, gamePricesObj, live.updatedAt, live.error]);

  /**
   * 页面可见时不断刷新 lastMark —— 人一走（切标签页/关掉）它就冻住，
   * 这正是「你不在的这段时间」的起点。
   */
  useEffect(() => {
    if (!awayChecked.current) return;
    if (game.status !== "playing") return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    const at = Date.now();
    const prev = game.lastMark;
    if (prev && at - prev.at < MARK_INTERVAL_MS) return;
    setGame((g) => ({
      ...g,
      lastMark: makeMark(
        at,
        g.account.cash,
        g.account.holdings.map((h) => ({
          code: h.code,
          name: h.name,
          shares: h.shares,
          price: gamePricesObj[h.code] ?? null,
        })),
      ),
    }));
  }, [game.status, game.lastMark, game.account, gamePricesObj, MARK_INTERVAL_MS]);

  /** 切回页面时立刻重新打一个点，避免「刚回来就被算成离开」 */
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible" || game.status !== "playing") return;
      const at = Date.now();
      setGame((g) => ({
        ...g,
        lastMark: makeMark(
          at,
          g.account.cash,
          g.account.holdings.map((h) => ({
            code: h.code,
            name: h.name,
            shares: h.shares,
            price: gamePricesObj[h.code] ?? null,
          })),
        ),
      }));
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [game.status, gamePricesObj]);

  /** 每只股票最近一次建仓日，用于 T+1 解锁 */
  const gameLastBuy = useMemo(() => lastBuyDates(game.account.trades), [game.account.trades]);

  /** 每天记录一个净值点。同一天只记一次，避免每次报价变动都写 localStorage */
  useEffect(() => {
    if (!snapshot || !live.today) return;
    setGame((g) => {
      const last = g.equity[g.equity.length - 1];
      if (last && last.date === live.today) return g;
      return { ...g, equity: pushEquity(g.equity, live.today, calcTotalAssets(g.account, gamePricesObj)) };
    });
  }, [snapshot, live.today, gamePricesObj]);

  /** 基准：沪深300 在「这一局开始到现在」这一段区间的涨跌幅 */
  const benchmarkName = "沪深300";
  const benchmarkReturnPct = useMemo(() => {
    const idx = snapshot?.indices.find((i) => i.code === BENCHMARK_CODE);
    if (!idx) return null;
    // 区间口径与「为什么可能是 null」都写在 samePeriodBenchmark 里
    return samePeriodBenchmark(game.equity, calendar ?? [], idx.close);
  }, [snapshot, calendar, game.equity]);

  const gameResults = useMemo(() => {
    const m = new Map<string, StockResult>();
    for (const r of liveStocks) m.set(r.code, r);
    return m;
  }, [liveStocks]);

  const handleOrder = useCallback(
    (
      code: string,
      side: Side,
      shares: number,
    ): { ok: boolean; reason?: string; trade?: Trade } => {
      const stock = stockByCode.get(code);
      if (!stock) return { ok: false, reason: `快照股票池里没有 ${code}，无法模拟交易` };

      const price = gamePricesObj[code] ?? null;

      /*
       * 先算完再提交，而不是在 setGame 的更新函数里算。
       *
       * 两个原因：① 成交回执要报**真实成交价**（含滑点、含手续费），而更新函数
       * 是延迟执行的，里面算出来的东西拿不出来；② 更新函数必须是纯的 ——
       * 在里面写外部变量虽然在 React 的急切求值下「碰巧能用」，那是实现细节。
       *
       * 并发安全靠下面那句恒等判断：提交时状态已经变了就整笔作废，宁可让人
       * 再点一次，也不能拿旧账户覆盖新账户。
       */
      // 进入新的交易日时先解锁此前建仓的股份（T+1）
      const account = rolloverTradingDay(game.account, live.today, lastBuyDates(game.account.trades));

      /*
       * 汇率缺失就拒绝下单。
       *
       * `executeOrder` / `calcFee` 拿不到 fx 会**按 1:1 处理**（`portfolio.ts:61`）：
       * 港股「最低 100 港币」的佣金会被当成 100 人民币（实差约 14 元），费率项也整块偏掉。
       * 账户余额是人民币口径的，汇率是必需品而不是可选优化 —— 缺了就停，
       * 不能给一个「看着成交了」的错账。
       */
      const fx = fxFor(code);
      if (fx === null) {
        return { ok: false, reason: `缺少 ${code} 的汇率数据，无法按人民币结算，请稍后再试` };
      }

      const res = executeOrder(account, {
        code,
        name: stock.name,
        side,
        shares,
        // 昨收取快照最后一根收盘价，用于涨跌停判断
        quote: { code, name: stock.name, price, prevClose: lastClose(stock.close) },
        date: live.today,
        at: Date.now(),
        isTradingNow,
        isST: stock.isST,
        // 创业板 300xxx / 科创板 688xxx 涨跌停 20%
        isGrowthBoard: code.startsWith("300") || code.startsWith("688"),
        typeAtTrade: gameResults.get(code)?.type,
        // 币种与汇率：市场由代码推（marketGroupOf），汇率必须显式给（港股佣金有最低值）
        fx,
      });

      if (!res.ok) {
        // T+1 解锁这种「顺带发生的事」也要落盘，哪怕下单本身被拒了
        if (account !== game.account) {
          setGame((g) => (g.account === game.account ? { ...g, account } : g));
        }
        return { ok: false, reason: res.reason };
      }

      const committed = res.account;
      setGame((g) => (g.account === game.account ? { ...g, account: committed } : g));
      return { ok: true, trade: res.trade };
    },
    [game.account, stockByCode, gamePricesObj, live.today, isTradingNow, gameResults],
  );

  const handleStartGame = useCallback((initialCash: number) => {
    setGame(startGame(initialCash, Date.now()));
    setGamePane("live");
  }, []);

  const handleResetGame = useCallback(() => setGame(defaultGameState()), []);

  const handleSettle = useCallback((): SeasonResult | null => {
    if (!snapshot || game.equity.length < 2) return null;
    const bench = benchmarkCurve(
      game.equity.map((p) => p.date),
      calendar ?? [],
      snapshot.indices.find((i) => i.code === BENCHMARK_CODE)?.close ?? [],
    );
    const result = settleSeason({
      account: game.account,
      equityCurve: game.equity as EquityPoint[],
      benchmarkCurve: bench,
      season: live.today.slice(0, 7), // YYYY-MM
      finalPrices: gamePricesObj,
    });
    setGame((g) => ({ ...g, account: { ...g.account, seasons: [...g.account.seasons, result] } }));
    return result;
  }, [snapshot, calendar, game.equity, game.account, live.today, gamePricesObj]);

  // ── 历史推演 ────────────────────────────────────────────────
  // 存档回填：快照加载完成之后才能还原（配置要用到行情）。只尝试一次。
  useEffect(() => {
    if (replayRestored.current || replay || !snapshot || !calendar) return;
    const save = readReplaySave(readLS(LS_REPLAY));
    if (!save) return;
    // 先立旗再 await：下面要发网络请求，中间可能重新进来一次
    replayRestored.current = true;

    if (save.levelId) {
      // 传奇模式的行情不在快照里，得把那一关的分片拉下来才能还原
      const levelId = save.levelId;
      void loadLevelShard(levelId)
        .then((shard) => {
          setReplay({
            state: restoreLevelReplay(shard, save),
            mode: "legend",
            hideDate: false,
            codes: save.codes,
            label: save.label || levelId,
            levelId,
          });
          setGamePane("replay");
        })
        .catch((e: unknown) => {
          // 分片没了（换版本、网络不通）时不要静默丢掉玩家的存档，明说一句
          setLegendError(`这一局的关卡数据没读到：${e instanceof Error ? e.message : String(e)}`);
          removeLS(LS_REPLAY);
        });
      return;
    }

    const restored = restoreReplay(snapshot, calendar, save);
    if (restored) {
      setReplay({
        state: restored,
        mode: save.mode,
        hideDate: save.hideDate,
        codes: save.codes,
        label: save.label || "历史推演",
        levelId: null,
      });
      setGamePane("replay");
    }
  }, [snapshot, calendar, replay]);

  const handleStartReplay = useCallback(
    (initialCash: number) => {
      if (!snapshot || !calendar || !replayAvailable(snapshot)) return;
      const state = startReplay(snapshot, calendar, { mode: "random", initialCash });
      resetCampaignNotes();
      setReplayGeneration(g => g + 1);
      setReplay({
        state,
        mode: "random",
        // 用户定下的规则：随机模式开局不告诉你是哪一年哪一天，结算时才揭晓
        hideDate: true,
        codes: state.config.instruments.map((i) => i.code),
        label: "随机开局",
        levelId: null,
      });
      setGamePane("replay");
    },
    [snapshot, calendar],
  );

  /**
   * 回溯模式要摆出来的东西：可选的起点、这段窗口里有多少只 A 股、窗口有多长。
   *
   * 在这里一次算好再传下去，而不是把 `calendar` / `snapshot` 交给 GameView 自己算 ——
   * 大厅是纯展示组件，让它去认识快照的形状，等于把数据管道的细节漏进界面层。
   */
  const backtrackPlan: BacktrackPlan | null = useMemo(() => {
    if (!snapshot || !calendar || !replayAvailable(snapshot)) return null;
    const options = backtrackOptions(calendar);
    if (options.length === 0) return null;
    return { options, stockCount: backtrackStocks(snapshot).length, span: BACKTRACK_DAYS };
  }, [snapshot, calendar]);

  /**
   * 回溯模式开局：起点由玩家在最近一个月里挑。
   *
   * `codes` 显式传进去，把这一局的标的**钉在开局那一刻** —— 不传的话
   * `buildReplayConfig` 会直接用「当前快照里的全部股票」，而快照每天更新，
   * 半路刷新一次就换了一批票，存档里的成交记录会对不上。
   */
  const handleStartBacktrack = useCallback(
    (startIndex: number, initialCash: number) => {
      if (!snapshot || !calendar || !replayAvailable(snapshot)) return;
      const codes = backtrackStocks(snapshot).map((s) => s.code);
      if (codes.length === 0) return;
      const label = `回溯 · ${calendar[startIndex]} 起`;
      setReplay({
        state: startReplay(snapshot, calendar, { mode: "backtrack", initialCash, startIndex, codes, label }),
        mode: "backtrack",
        // 回溯模式是「看着日历复盘」，日期照实显示（和随机模式正相反）
        hideDate: false,
        codes,
        label,
        levelId: null,
      });
      setGamePane("replay");
    },
    [snapshot, calendar],
  );

  // 关卡清单只在页面加载时问一次
  useEffect(() => {
    void loadLevelIndex().then(setLegendIds);
  }, []);

  /** 当前这一局是哪一关（随机模式为 null）。简报就是从这里现查的，不另存一份。 */
  const replayLegend = replay?.levelId ? (levelById(replay.levelId) ?? null) : null;
  const legendReady = (legendIds?.length ?? 0) > 0;

  /** 进入某一关：先把分片拉下来，再开局。分片是几百 KB 的静态文件。 */
  const handleStartLevel = useCallback(
    (level: ReplayLevel, initialCash: number) => {
      setLegendError(null);
      setLegendLoading(level.id);
      void loadLevelShard(level.id)
        .then((shard) => {
          const state = startLevelReplay(shard, initialCash, `${level.order}. ${level.title}`);
          resetCampaignNotes();
      setReplayGeneration(g => g + 1);
          setReplay({
            state,
            mode: "legend",
            // 用户定的规则：传奇模式是纪念性复盘，日期照实显示
            hideDate: false,
            codes: state.config.instruments.map((i) => i.code),
            label: `${level.order}. ${level.title}`,
            levelId: level.id,
          });
          setLegendOpen(false);
          setGamePane("replay");
        })
        .catch((e: unknown) => {
          setLegendError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => setLegendLoading(null));
    },
    [],
  );

  const handleReplayOrder = useCallback(
    (code: string, side: Side, shares: number): { ok: boolean; reason?: string } => {
      if (!replay) return { ok: false, reason: "尚未开局。" };
      const res = placeOrder(replay.state, { code, side, shares });
      if (!res.ok) return { ok: false, reason: res.reason };
      setReplay({ ...replay, state: res.state });
      return { ok: true };
    },
    [replay],
  );

  const handleReplayAdvance = useCallback((n: number) => {
    setReplay((s) => (s ? { ...s, state: advanceDays(s.state, n) } : s));
  }, []);

  const handleReplayCancel = useCallback((orderId: string) => {
    setReplay((s) => (s ? { ...s, state: cancelOrder(s.state, orderId) } : s));
  }, []);

  const handleReplayExit = useCallback(() => {
    setReplay(null);
    setLegendOpen(false);
    setLegendError(null);
    setGamePane("live");
    removeLS(LS_REPLAY);
  }, []);

  // 兜底：推演没了（退出、或者存档在别的标签页被清掉）时别把页面停在空白的那一屏。
  // 「游戏记录」不受影响 —— 它没有推演也照样有内容（至少是实时那边，或者一句空状态）。
  useEffect(() => {
    if (!replay && gamePane === "replay") setGamePane("live");
  }, [replay, gamePane]);

  const missingCount = live.result?.missing.length ?? 0;
  const stockName =
    stockByCode.get(selectedCode ?? "")?.name ?? analysis.stock?.name ?? selectedCode ?? "—";

  return (
    <div className={`app app-${tab}`}>
      <header className="app-head">
        <div className="app-head-row">
          <button className="brand" type="button" onClick={() => setTab("game")} aria-label="股市练习场，返回游戏">
            <span className="brand-mark"><svg viewBox="0 0 28 28" fill="none" aria-hidden="true"><path d="M5 21V15M14 21V7M23 21V11" stroke="currentColor" strokeWidth="4" strokeLinecap="round"/><path d="m3 10 8-5 8 3 7-5" stroke="currentColor" strokeWidth="1.5"/></svg></span>
            <span><strong>股市练习场</strong><small>MARKET PLAYGROUND</small></span>
          </button>
          <nav className="topnav" aria-label="主导航">
            {TABS.map(t => <button key={t.key} className={`topnav-link${tab===t.key ? " active" : ""}`} type="button" onClick={() => setTab(t.key)} aria-current={tab===t.key ? "page" : undefined}><AppIcon name={t.key==="game" ? "game" : t.key==="workbench" ? "chart" : "book"}/>{t.label}</button>)}
          </nav>
          <div className="app-head-actions">
            <button className="head-guide" aria-label="玩法指南" type="button" onClick={openGuide}><AppIcon name="help" size={18}/><span>玩法指南</span></button>
            <button className="head-settings" type="button" onClick={() => setTab("settings")} aria-label="设置" title="设置"><AppIcon name="settings" size={20}/></button>
          </div>
        </div>
      </header>
      <div className="data-strip">
        <span className="data-status"><i/> {tab === "game" && gamePane === "replay" && replay ? "历史推演" : sessionText}</span>
        <span>{tab === "game" && gamePane === "replay" && replay ? (replay.hideDate ? "日期隐藏 · 依据当前可见信息决策" : `模拟日期 ${replay.state.config.calendar[replay.state.dayIndex]}`) : `行情快照 ${metaAsOf ?? "加载中"}`}</span>
        <span className="data-note">虚拟资金 · 学习与体验</span>
        <details className="data-details"><summary>数据状态</summary><div className="data-popover">
          <p>{replay?.hideDate && tab === "game" && gamePane === "replay" ? "随机模式隐藏真实日期。" : `快照 ${bundle?.name ?? "—"} · 更新 ${updatedText}`}</p>
          <p>实时来源 {quoteSourceText} · {visibleCodes.length}只关注标的</p>
          {live.error && <Notice tone="warn">实时行情不可用：{live.error}。当前使用本地快照，请留意行情时间。</Notice>}
          {degraded && <Notice tone="warn">行情降级：{degraded}{missingCount > 0 ? `（${missingCount}只标的按快照显示）` : ""}</Notice>}
          {!live.polling && !live.error && visibleCodes.length > 0 && <p>当前为{sessionText}，非交易时段不轮询行情。</p>}
        </div></details>
      </div>

      <main className="app-main" id="main-content">
        {tab !== "game" && <div className={`page-intro${tab === "workbench" ? " market-page-intro" : ""}`}><span className="eyebrow">{tab === "workbench" ? "OBSERVE THE MARKET" : tab === "analysis" ? "LEARN FROM YOUR DECISIONS" : tab === "settings" ? "YOUR PREFERENCES" : "GET TO KNOW THE GAME"}</span><h1>{tab === "workbench" ? "市场观察" : tab === "analysis" ? "学习笔记" : tab === "settings" ? "设置" : tab === "guide" ? "每一次练习，都从看懂开始。" : "交易规则"}</h1><p>{tab === "workbench" ? "从大盘到个股，看看当前市场发生了什么。此处展示的是当前行情。" : tab === "analysis" ? "留下观察依据，回看自己的判断。" : tab === "settings" ? "调整行情刷新、数据来源与学习助手。" : "先熟悉操作，再在真实的市场历史中练习。"}</p></div>}
        {loading && <Notice tone="info">正在加载快照…</Notice>}
        {loadError && (
          <Notice tone="danger" role="alert">
            快照加载失败：{loadError}
            <br />
            检查「设置 → 数据根路径」是否为 <code>{sanitizeDataBase(settings.dataBase)}</code>，
            以及该目录下是否存在 latest.json。
          </Notice>
        )}

        {!loading && !loadError && !snapshot && <Notice tone="info">没有可用快照。</Notice>}

        {tab === "workbench" && !guideSeen && (
          <div className="guide-banner market-guide-banner">
            <span>
              <strong>第一次用？</strong> 这里有一份使用说明，讲清楚每个结论是怎么来的。
            </span>
            <span className="guide-banner-actions">
              <button type="button" className="btn btn-primary btn-tiny" onClick={openGuide}>
                看看说明
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-tiny"
                onClick={() => {
                  setGuideSeen(true);
                  writeLS(LS_GUIDE_SEEN, "1");
                }}
              >
                不用了
              </button>
            </span>
          </div>
        )}

        {snapshot && liveMarket && !loading && tab === "workbench" && (
          <WorkbenchView
            market={liveMarket}
            sectors={liveSectors}
            groups={groups}
            counts={counts}
            metricsByCode={liveMetrics}
            sectorCode={sectorCode}
            onSelectSector={setSectorCode}
            marketFilter={marketFilter}
            onSelectMarketFilter={setMarketFilter}
            marketOptions={marketOptions}
            marketCounts={marketCounts}
            query={query}
            onQuery={setQuery}
            onOpenStock={openStock}
            quotesByCode={quotesByCode}
            totalStocks={snapshot.stocks.length}
            filteredStocks={visibleStocks.length}
            mainIndexText={mainIndexText}
            signals={liveSignals}
            focusStocks={focusStocks}
          />
        )}

        {!loading && tab === "analysis" && selectedCode && (
          <AnalysisView
            key={selectedCode}
            code={selectedCode}
            name={stockName}
            report={analysis.report}
            reportError={analysis.error}
            metrics={analysis.metrics}
            quote={quotesByCode.get(selectedCode) ?? null}
            quoteError={live.error}
            sessionText={sessionText}
            snapshotPrice={snapshotPrice}
            snapshotAsOf={metaAsOf}
            classificationReasons={analysis.reasons}
            signal={selectedSignal}
            onBack={() => setTab("workbench")}
            onOpenSettings={() => setTab("settings")}
            onSaveLearning={saveLearning}
          />
        )}

        {/*
          「最近分析」和「学习记录」跟着个股分析走，不再单占底部一格。
          理由：这两张表回答的是同一个问题 —— 「我上次看的是哪只、当时答了什么」，
          而这个问题只会在一只股票看完了、想换一只的时候冒出来。放在这儿正好顺路。
        */}
        {!loading && tab === "analysis" && (
          <>
            <HistoryView
              store={store}
              onOpenStock={openStock}
              onRemoveAnalysed={(code) => setStore((s) => removeAnalysed(s, code))}
              onClearAnalysed={() => setStore((s) => ({ ...s, analysed: [] }))}
              onClearLearning={() => setStore((s) => ({ ...s, learning: [] }))}
            />
          </>
        )}

        {!loading && tab === "analysis" && !selectedCode && (
          <div className="view">
            <Notice tone="info">
              还没有选中个股。到「筛选」页点开任意一只个股，或从下面的「最近分析」里重新打开。
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setTab("workbench");
                  setFocusStocks((n) => n + 1);
                }}
              >
                去筛选
              </button>
            </Notice>
          </div>
        )}

        {/*
          游戏页顶部的三条切换：「实时模式 / 历史推演 / 游戏记录」。
          实时模式和历史推演各存各的存档，所以这不是「切换存档」，只是换着看。
          「游戏记录」始终在，哪怕两边都还没开局 —— 它正是要给人「以后来这儿翻」的预期。
        */}
        {!loading && tab === "game" && !legendOpen && (
          <div className="view">
            <div className="chips pane-switch" aria-label="游戏空间">
              <button
                type="button"
                className={`chip${gamePane === "live" ? " chip-active" : ""}`}
                aria-pressed={gamePane === "live"}
                onClick={() => {
                  setGamePane("live");
                  setLegendOpen(false);
                }}
              >
                {game.status === "playing" ? "实时账户" : "游戏大厅"}
              </button>
              {replay && (
                <button
                  type="button"
                  className={`chip${gamePane === "replay" ? " chip-active" : ""}`}
                  aria-pressed={gamePane === "replay"}
                  onClick={() => setGamePane("replay")}
                >
                  历史推演{replayLegend ? ` · 第 ${replayLegend.order} 关` : ""}
                </button>
              )}
              <button
                type="button"
                className={`chip${gamePane === "history" ? " chip-active" : ""}`}
                aria-pressed={gamePane === "history"}
                onClick={() => setGamePane("history")}
              >
                游戏记录
              </button>
            </div>
          </div>
        )}

        {!loading && tab === "game" && gamePane === "replay" && replay && (
          <ReplayView
            key={replayGeneration}
            state={replay.state}
            hideDate={replay.hideDate}
            label={replay.label}
            mode={replay.mode}
            // 用这一局自己的池子：传奇模式的票在历史分片里，不在当前快照里
            stocks={replay.state.config.instruments}
            benchmarkName={benchmarkName}
            briefing={
              replayLegend
                ? {
                    startDate: replayLegend.startDate,
                    theme: replayLegend.theme,
                    lines: replayLegend.briefing,
                  }
                : undefined
            }
            onOrder={handleReplayOrder}
            onCancel={handleReplayCancel}
            onAdvance={handleReplayAdvance}
            onExit={handleReplayExit}
            onRestart={() => replayLegend ? handleStartLevel(replayLegend, replay.state.account.initialCash) : handleStartReplay(replay.state.account.initialCash)}
            onNext={replayLegend && LEVELS[replayLegend.order] ? () => handleStartLevel(LEVELS[replayLegend.order], replay.state.account.initialCash) : undefined}
          />
        )}

        {!loading && tab === "game" && gamePane === "history" && (
          <GameHistoryView
            live={game}
            replay={replay}
            onOpenStock={openStock}
            onResumeReplay={() => {
              setGamePane("replay");
              setLegendOpen(false);
            }}
          />
        )}

        {!loading && tab === "game" && gamePane === "live" && legendOpen && (
          <LevelPicker
            ready={legendReady}
            availableIds={legendIds ?? undefined}
            loadingId={legendLoading}
            error={legendError}
            onStart={handleStartLevel}
            onBack={() => {
              setLegendOpen(false);
              setLegendError(null);
            }}
            cashOptions={[...CASH_OPTIONS]}
            defaultCash={DEFAULT_INITIAL_CASH}
          />
        )}

        {!loading && tab === "game" && gamePane === "live" && !legendOpen && (
          <GameView
            state={game}
            prices={gamePrices}
            quotesByCode={quotesByCode}
            stocks={snapshot?.stocks ?? []}
            resultsByCode={gameResults}
            fxOf={fxFor}
            onOrder={handleOrder}
            onPickCode={setGamePick}
            onStart={handleStartGame}
            onReset={handleResetGame}
            onSettle={handleSettle}
            onOpenRules={() => setTab("rules")}
            news={news}
            sessionText={sessionText}
            isTradingNow={isTradingNow}
            today={live.today}
            benchmarkName={benchmarkName}
            benchmarkReturnPct={benchmarkReturnPct}
            totalAssets={gameTotalAssets}
            holdingsValue={gameHoldingsValue}
            replayReady={snapshot ? replayAvailable(snapshot) : false}
            away={away}
            onDismissAway={() => setAway(null)}
            onStartReplay={handleStartReplay}
            onOpenLegend={() => setLegendOpen(true)}
            onStartBacktrack={handleStartBacktrack}
            backtrack={backtrackPlan}
            replayInProgress={!!replay}
            replaySummary={replay ? { title: replay.label, day: replay.state.dayIndex - replay.state.config.startIndex + 1, totalDays: replay.state.config.calendar.length - replay.state.config.startIndex, finished: replay.state.finished } : undefined}
            onResumeReplay={() => {
              setGamePane("replay");
              setLegendOpen(false);
            }}
          />
        )}

        {tab === "rules" && <GameRulesView onBack={() => setTab("game")} />}

        {tab === "guide" && <GuideView onBack={() => { setTab("game"); setGamePane("live"); setLegendOpen(false); }} />}

        {/*
          设置不再占底部一格，从页头右上角的齿轮进。
          进来之后底栏三条都不高亮 —— 这是有意的：设置是「离开主流程去调一调」，
          不属于任何一条主干。左上角的返回按钮负责把人送回去。
        */}
        {tab === "settings" && (
          <SettingsView
            settings={settings}
            onChange={setSettings}
            rules={rules}
            onBack={() => setTab("game")}
            onReload={() => setReloadNonce((n) => n + 1)}
            onClearLocal={clearLocal}
            snapshotName={bundle?.name ?? null}
            metaAsOf={metaAsOf}
            metaSource={typeof bundle?.meta?.source === "string" ? (bundle.meta.source as string) : null}
            metaDays={typeof bundle?.meta?.days === "number" ? `${bundle.meta.days} 天` : null}
            calendarDays={calendar?.length ?? 0}
            sessionText={sessionText}
            polling={live.polling}
            updatedText={updatedText}
            quoteSourceText={quoteSourceText}
          />
        )}
        {!loading && tab === "game" && <GameCompanion onGuide={openGuide} cue={gamePane === "replay" && replay ? replay.state.finished ? {label: "本局完成", mood: "happy", text: "这段推演已经完成。打开本局战报，把真实结果和您当时的判断放在一起回看。"} : replay.state.pending.length ? {label: "等待撮合", mood: "explain", text: "您的委托已进入队列。推进下一天，开盘回报会告诉您成交情况；也可以先记录今天的理由。"} : {label: "本局挑战", mood: "thinking", text: "先观察眼前的信息，再展开「本局挑战」记下理由。观望也算一次判断，不必为了任务而交易。"} : undefined} context={gamePane === "replay" ? "replay" : legendOpen ? "chapter" : game.status === "playing" ? "live" : replay ? "resume" : "lobby"}/>}
        <footer className="app-footer"><span>MARKET PLAYGROUND</span><span>每一次判断，都值得复盘。</span><span>所有交易均为虚拟模拟</span></footer>
      </main>

      <nav className="tabbar" aria-label="主导航">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`tab${tab === t.key ? " tab-active" : ""}`}
            onClick={() => setTab(t.key)}
            aria-current={tab === t.key ? "page" : undefined}
          >
            <AppIcon name={t.key === "game" ? "game" : t.key === "workbench" ? "chart" : "book"} size={20}/>
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
