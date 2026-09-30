/**
 * 应用外壳：标签页切换（无路由）、快照加载、漏斗计算、实时行情轮询与本地持久化。
 *
 * 数据流：
 *   bundle（静态快照） → 基础漏斗（同时决定"该轮询哪些代码"）
 *   实时报价 → applyLivePrices(bundle) → liveSnapshot → 展示用漏斗 / 七步报告
 * 基础漏斗必须独立算一次：否则"报价 → 快照 → 漏斗 → 轮询代码 → 报价"会自我循环。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  loadSnapshot,
  sessionLabel,
  sessionState,
  sourceLabel,
  type Quote,
  type SnapshotBundle,
} from "@aw/data";
import {
  executeOrder,
  holdingsValue as calcHoldingsValue,
  rolloverTradingDay,
  settleSeason,
  totalAssets as calcTotalAssets,
  levelById,
  type EquityPoint,
  type ReplayLevel,
  type SeasonResult,
  type Side,
  type Trade,
} from "@aw/game";
import { AnalysisView } from "./components/AnalysisView";
import { GameRulesView } from "./components/GameRulesView";
import { GuideView } from "./components/GuideView";
import { GameView } from "./components/GameView";
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
  LS_REPLAY,
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
  { key: "workbench", label: "筛选" },
  { key: "analysis", label: "个股分析" },
  { key: "game", label: "模拟游戏" },
];

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
  const [tab, setTab] = useState<Tab>("workbench");
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
        setBundle(b);
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
    enabled: !!snapshot,
    nonce: reloadNonce,
  });

  // 新闻与行情节奏不同：行情 3~5 秒，新闻 3 分钟。只在模拟游戏页且已开局时拉取。
  const news = useLiveNews({
    enabled: tab === "game" && game.status === "playing",
  });

  const session = sessionState(new Date(), calendar);
  const sessionText = sessionLabel(session);

  // ── 实时叠加后的快照与展示用漏斗 ────────────────────────────
  const liveSnapshot = useMemo(() => {
    if (!bundle) return null;
    const quotes = live.result?.quotes ?? [];
    if (quotes.length === 0) return bundle.snapshot;
    return applyLivePrices(bundle, quotes, { today: live.today });
  }, [bundle, live.result, live.today]);

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

  const groups = useMemo(() => groupStockResults(filteredStocks, liveRet20), [filteredStocks, liveRet20]);
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
    setQuery("");
    setTab("workbench");
    setReloadNonce((n) => n + 1);
  }, []);

  const degraded = live.result?.degradedReason ?? null;
  const updatedText = live.updatedAt === null ? "—（暂无实时数据）" : beijingClock(live.updatedAt);
  const quoteSourceText = live.result ? sourceLabel(live.result.source) : "—（未取到实时行情）";
  // ── 模拟游戏 ──────────────────────────────────────────────────
  const isTradingNow = session === "open";

  /** 价格表：先用快照收盘价铺底，再用实时价覆盖。取不到的保持 null（不猜） */
  const gamePricesObj = useMemo(() => {
    const o: Record<string, number | null> = {};
    for (const s of (liveSnapshot ?? snapshot)?.stocks ?? []) o[s.code] = lastClose(s.close);
    for (const [code, q] of quotesByCode) if (q.price !== null) o[code] = q.price;
    return o;
  }, [liveSnapshot, snapshot, quotesByCode]);

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
    <div className="app">
      <header className="app-head">
        <div className="app-head-row">
          <h1 className="app-title">A 股趋势筛选工作台</h1>
          <span className="app-head-actions">
            <button type="button" className="btn btn-primary btn-tiny" onClick={openGuide}>
              使用说明
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-tiny icon-btn"
              onClick={() => setTab("settings")}
              aria-label="设置"
              title="设置"
            >
              {/* 齿轮用图形而不是文字：底栏里删掉的那一格，在这里只需要一个通用符号 */}
              <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path
                  fill="currentColor"
                  d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Zm0 5.8a2.2 2.2 0 1 1 0-4.4 2.2 2.2 0 0 1 0 4.4Z"
                />
                <path
                  fill="currentColor"
                  d="M20.3 13.4c.1-.5.1-1 .1-1.4s0-.9-.1-1.4l2-1.5-1.9-3.3-2.3.9a7.6 7.6 0 0 0-2.4-1.4L15.4 3h-3.8l-.4 2.3c-.9.3-1.7.8-2.4 1.4l-2.3-.9-1.9 3.3 2 1.5a7.5 7.5 0 0 0 0 2.8l-2 1.5 1.9 3.3 2.3-.9c.7.6 1.5 1.1 2.4 1.4l.4 2.3h3.8l.4-2.3c.9-.3 1.7-.8 2.4-1.4l2.3.9 1.9-3.3-2.1-1.5Zm-1.5 2.4-1.8.7-.4.6a5.8 5.8 0 0 1-1.6 1.4l-.6.4-.1.7-.3 1.8h-2l-.3-1.8-.1-.7-.6-.4c-.6-.3-1.1-.8-1.6-1.4l-.4-.6-.7-.2-1.8-.7.7-2 .5-.6-.2-.7a6 6 0 0 1 0-2.2l.2-.7-.5-.6-.7-2 1.8-.7.7-.2.4-.6c.4-.6 1-.9 1.6-1.3l.6-.4.1-.7.3-1.8h2l.3 1.8.1.7.6.4c.6.4 1.2.7 1.6 1.3l.4.6.7.2 1.8.7-.7 2-.5.6.2.7a6 6 0 0 1 0 2.2l-.2.7.2.6.7 2Z"
                />
              </svg>
            </button>
          </span>
        </div>
        <div className="app-head-meta">
          <span className={`session session-${session}`}>{sessionText}</span>
          {/* 随机模式正在玩的时候，快照名和数据日期都会泄露「这是哪一段行情」——
              日期本身就是这个模式唯一要藏的东西，所以整条换掉 */}
          {replay?.hideDate ? (
            <span title="随机模式不显示日期，避免提前知道是哪一段行情">
              数据日期 已隐藏（随机模式）
            </span>
          ) : (
            <>
              <span>快照 {bundle?.name ?? "—"}</span>
              <span>数据日期 {metaAsOf ?? "—"}</span>
            </>
          )}
        </div>
        <div className="app-head-meta">
          <span>
            最后更新 {updatedText} · 来源 {quoteSourceText}
          </span>
          {visibleCodes.length > 0 && <span>轮询 {visibleCodes.length} 只</span>}
        </div>
        {live.error && (
          <Notice tone="warn">
            实时行情不可用：{live.error}
            <br />
            页面继续使用本地快照的日线数据，结论不受影响。
          </Notice>
        )}
        {degraded && (
          <Notice tone="warn">
            行情降级提示：{degraded}
            {missingCount > 0 ? `（${missingCount} 只没有实时价，按快照显示）` : ""}
          </Notice>
        )}
        {!live.polling && !live.error && live.result === null && visibleCodes.length > 0 && (
          <Notice tone="info">当前为「{sessionText}」，已停止实时轮询（不在交易时段不请求行情）。</Notice>
        )}
      </header>

      <main className="app-main">
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
          <div className="guide-banner">
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
            query={query}
            onQuery={setQuery}
            onOpenStock={openStock}
            quotesByCode={quotesByCode}
            totalStocks={snapshot.stocks.length}
            filteredStocks={filteredStocks.length}
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
            <div className="chips pane-switch">
              <button
                type="button"
                className={`chip${gamePane === "live" ? " chip-active" : ""}`}
                aria-pressed={gamePane === "live"}
                onClick={() => {
                  setGamePane("live");
                  setLegendOpen(false);
                }}
              >
                实时模式
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
            state={replay.state}
            hideDate={replay.hideDate}
            label={replay.label}
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
            replayInProgress={!!replay}
            onResumeReplay={() => {
              setGamePane("replay");
              setLegendOpen(false);
            }}
          />
        )}

        {tab === "rules" && <GameRulesView onBack={() => setTab("game")} />}

        {tab === "guide" && <GuideView onBack={() => setTab("workbench")} />}

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
            onBack={() => setTab("workbench")}
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
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
