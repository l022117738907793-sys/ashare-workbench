/**
 * 应用外壳：标签页切换（无路由）、快照加载、漏斗计算、实时行情轮询与本地持久化。
 *
 * 数据流：
 *   bundle（静态快照） → 基础漏斗（同时决定"该轮询哪些代码"）
 *   实时报价 → applyLivePrices(bundle) → liveSnapshot → 展示用漏斗 / 七步报告
 * 基础漏斗必须独立算一次：否则"报价 → 快照 → 漏斗 → 轮询代码 → 报价"会自我循环。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  analyzeMarket,
  analyzeSector,
  buildReport,
  classifyStock,
  computeStockMetrics,
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
import { AnalysisView } from "./components/AnalysisView";
import { HistoryView } from "./components/HistoryView";
import { SettingsView } from "./components/SettingsView";
import { WorkbenchView } from "./components/WorkbenchView";
import { Notice } from "./components/common";
import {
  beijingClock,
  filterStockResults,
  groupStockResults,
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

type Tab = "workbench" | "analysis" | "history" | "settings";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "workbench", label: "筛选" },
  { key: "analysis", label: "个股分析" },
  { key: "history", label: "历史" },
  { key: "settings", label: "设置" },
];

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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

  useEffect(() => writeLS(LS_SETTINGS, serializeSettings(settings)), [settings]);
  useEffect(() => writeLS(LS_STORE, serializeStore(store)), [store]);

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
    return []; // 历史 / 设置页没有行情要看，就不请求
  }, [snapshot, tab, selectedCode, analysisSectorBase, selectedSectorBase, baseGroups, codeByName]);

  const live = useLiveQuotes(visibleCodes, {
    intervalMs: settings.refreshMs,
    calendar,
    enabled: !!snapshot,
    nonce: reloadNonce,
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
  const missingCount = live.result?.missing.length ?? 0;
  const stockName =
    stockByCode.get(selectedCode ?? "")?.name ?? analysis.stock?.name ?? selectedCode ?? "—";

  return (
    <div className="app">
      <header className="app-head">
        <div className="app-head-row">
          <h1 className="app-title">A 股趋势筛选工作台</h1>
          <button type="button" className="btn btn-ghost btn-tiny" onClick={() => setReloadNonce((n) => n + 1)}>
            重新加载
          </button>
        </div>
        <div className="app-head-meta">
          <span className={`session session-${session}`}>{sessionText}</span>
          <span>快照 {bundle?.name ?? "—"}</span>
          <span>数据日期 {metaAsOf ?? "—"}</span>
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
            onBack={() => setTab("workbench")}
            onOpenSettings={() => setTab("settings")}
            onSaveLearning={saveLearning}
          />
        )}

        {!loading && tab === "analysis" && !selectedCode && (
          <div className="view">
            <Notice tone="info">
              还没有选中个股。到「筛选」页点开任意一只个股，或从「历史」里重新打开。
              <button type="button" className="btn btn-ghost" onClick={() => setTab("workbench")}>
                去筛选
              </button>
            </Notice>
          </div>
        )}

        {tab === "history" && (
          <HistoryView
            store={store}
            onOpenStock={openStock}
            onRemoveAnalysed={(code) => setStore((s) => removeAnalysed(s, code))}
            onClearAnalysed={() => setStore((s) => ({ ...s, analysed: [] }))}
            onClearLearning={() => setStore((s) => ({ ...s, learning: [] }))}
            onClearAll={clearLocal}
          />
        )}

        {tab === "settings" && (
          <SettingsView
            settings={settings}
            onChange={setSettings}
            rules={rules}
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
