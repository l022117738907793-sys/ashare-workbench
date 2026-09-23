import defaultRules from "../rules.json";

export type Maybe = number | null;

export interface SeriesData {
  code: string;
  name: string;
  kind?: string;
  close: Maybe[];
  high: Maybe[];
  low: Maybe[];
  volume: Maybe[];
}

export interface StockData extends SeriesData {
  industry: string;
  industryCode: string;
  weight: number;
  isST: boolean;
}

export interface SectorData extends SeriesData {
  members: string[];
}

export interface Snapshot {
  meta?: Record<string, unknown>;
  calendar?: string[];
  indices: SeriesData[];
  sectors: SectorData[];
  stocks: StockData[];
  etfs: SeriesData[];
}

export type Rules = typeof defaultRules;

export interface ReasonItem {
  key: string;
  label: string;
  value: number | null;
  threshold: string;
  pass: boolean;
  note: string;
}

export interface ATRInfo {
  available: boolean;
  flag: string;
  atr: number | null;
  band5: number | null;
  move5: number | null;
}

export interface MarketResult {
  state: string;
  reasons: ReasonItem[];
  implication: string;
}

export interface SectorResult {
  code: string;
  name: string;
  state: string;
  reasons: ReasonItem[];
  breadth20: number | null;
  strongCount: number;
  strongestMembers: string[];
}

export interface StockResult {
  code: string;
  name: string;
  type: string;
  reasons: ReasonItem[];
  subtype: string | null;
  atr: ATRInfo;
}

export interface TrendResult {
  state: string;
  reasons: ReasonItem[];
}

export interface PriceActionResult {
  state: string;
  reasons: ReasonItem[];
}

export interface PositionResult {
  state: string;
  reasons: ReasonItem[];
  trendBroken: boolean | null;
  volumeHeavy: boolean | null;
}

export interface DataSufficiency {
  enough: boolean;
  missing: string[];
}

export interface AnalysisReport {
  market: MarketResult;
  sector: SectorResult;
  stockTrend: TrendResult;
  priceAction: PriceActionResult;
  position: PositionResult;
  currentType: string;
  nextSteps: string[];
  conclusion: string;
  why: string[];
  dataSufficiency: DataSufficiency;
}

export interface StockMetrics {
  days: number;
  ret5: number | null;
  ret10: number | null;
  ret20: number | null;
  ret60: number | null;
  above20: boolean | null;
  above60: boolean | null;
  ma20Up: boolean | null;
  ma60Up: boolean | null;
  dist20: number | null;
  distHigh: number | null;
  pullback: number | null;
  volRatio: number | null;
  daysAbove20: number;
  atr: ATRInfo;
  isST: boolean;
}

function valid(arr: Maybe[]): number[] {
  return arr.filter((v): v is number => v !== null && Number.isFinite(v));
}

function avg(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function ret(close: Maybe[], k: number): number | null {
  const v = valid(close);
  if (v.length <= k || v[v.length - 1 - k] === 0) return null;
  return (v[v.length - 1] / v[v.length - 1 - k] - 1) * 100;
}

export function ma(close: Maybe[], x: number): number | null {
  const v = valid(close);
  if (v.length < x) return null;
  return avg(v.slice(-x));
}

export function maPrev(close: Maybe[], x: number, lookback = 5): number | null {
  const v = valid(close);
  if (v.length < x + lookback) return null;
  return avg(v.slice(-x - lookback, v.length - lookback));
}

export function maUp(close: Maybe[], x: number): boolean | null {
  const now = ma(close, x);
  const prev = maPrev(close, x);
  if (now === null || prev === null) return null;
  return now > prev;
}

export function daysAbove(close: Maybe[], ref: number | null): number {
  if (ref === null) return 0;
  let count = 0;
  for (const v of valid(close).reverse()) {
    if (v > ref) count += 1;
    else break;
  }
  return count;
}

export function volRatio(volume: Maybe[]): number | null {
  const v = valid(volume);
  if (v.length < 20) return null;
  return avg(v.slice(-5)) / avg(v.slice(-20));
}

export function atrInfo(
  high: Maybe[],
  low: Maybe[],
  close: Maybe[],
  period = 14,
  multiplier = 1.5,
  minDays = 15,
): ATRInfo {
  const rows: Array<[number, number, number]> = [];
  const hv = valid(high);
  const lv = valid(low);
  const cv = valid(close);
  const n = Math.min(hv.length, lv.length, cv.length);
  for (let i = 0; i < n; i += 1) rows.push([hv[i], lv[i], cv[i]]);
  if (cv.length < minDays || rows.length < period + 1) {
    return { available: false, flag: "", atr: null, band5: null, move5: null };
  }
  const trs: number[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const [h, l, c] = rows[i];
    const pc = rows[i - 1][2];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const atrV = avg(trs.slice(-period));
  const band5 = atrV * Math.sqrt(5) * multiplier;
  const last = cv[cv.length - 1];
  const prev5 = cv[cv.length - 6];
  const move5 = last - prev5;
  let flag = "正常";
  if (move5 > band5) flag = "偏大";
  if (move5 < -band5) flag = "超跌";
  return { available: true, flag, atr: atrV, band5, move5 };
}

function reason(
  key: string,
  label: string,
  value: number | null,
  threshold: string,
  pass: boolean,
  note: string,
): ReasonItem {
  return { key, label, value, threshold, pass, note };
}

function fmt(v: number | null): string {
  if (v === null) return "—";
  return Number(v.toFixed(2)).toString();
}

function findSeries(list: SeriesData[], code: string): SeriesData | undefined {
  return list.find((s) => s.code === code);
}

function lastValid(arr: Maybe[]): number | null {
  const v = valid(arr);
  return v.length ? v[v.length - 1] : null;
}

export function computeStockMetrics(
  stock: StockData,
  rules: Rules,
): StockMetrics {
  const close = stock.close;
  const days = valid(close).length;
  const last = lastValid(close);
  const ma20v = ma(close, 20);
  const ma60v = ma(close, 60);
  const above20 = ma20v === null || last === null ? null : last > ma20v;
  const above60 = ma60v === null || last === null ? null : last > ma60v;
  const vals = valid(close);
  const high20 = vals.length ? Math.max(...vals.slice(-20)) : null;
  const dist20 = ma20v && last !== null ? ((last / ma20v) - 1) * 100 : null;
  const distHigh = last !== null && high20 !== null
    ? ((last / high20) - 1) * 100
    : null;
  return {
    days,
    ret5: ret(close, 5),
    ret10: ret(close, 10),
    ret20: ret(close, 20),
    ret60: ret(close, 60),
    above20,
    above60,
    ma20Up: maUp(close, 20),
    ma60Up: maUp(close, 60),
    dist20,
    distHigh,
    pullback: distHigh === null ? null : -distHigh,
    volRatio: volRatio(stock.volume),
    daysAbove20: daysAbove(close, ma20v),
    atr: atrInfo(
      stock.high,
      stock.low,
      close,
      rules.stock.atrPeriod,
      rules.stock.atrMultiplier,
      rules.stock.atrMinDays,
    ),
    isST: stock.isST,
  };
}

export function analyzeMarket(snapshot: Snapshot, rules: Rules): MarketResult {
  const main = findSeries(snapshot.indices, rules.market.mainIndex);
  const reasons: ReasonItem[] = [];
  if (!main) {
    return {
      state: "数据不足",
      reasons: [
        reason("main.missing", "沪深300 数据", null, "存在", false, "缺少主指数数据"),
      ],
      implication: "数据不足，无法判断大盘环境。",
    };
  }
  const ret20 = ret(main.close, 20);
  const lastMain = lastValid(main.close);
  const ma20m = ma(main.close, 20);
  const above20 = ma20m === null || lastMain === null
    ? null
    : lastMain > ma20m;
  const m20 = maUp(main.close, 20);
  const upCount = snapshot.stocks.filter(
    (s) => (ret(s.close, 20) ?? -999) > 0,
  ).length;
  const breadth = snapshot.stocks.length > 0
    ? upCount / snapshot.stocks.length
    : null;

  reasons.push(
    reason("main.ret20", "沪深300 近20日涨幅", ret20, `≥ ${rules.market.strong20Pct}%`, (ret20 ?? -Infinity) >= rules.market.strong20Pct, ""),
    reason("main.aboveMA20", "价格站上20日线", above20 === null ? null : above20 ? 1 : 0, "是", above20 === true, ""),
    reason("main.ma20Up", "20日线上弯", m20 === null ? null : m20 ? 1 : 0, "是", m20 === true, ""),
    reason("main.breadth", "股票池上涨家数占比", breadth === null ? null : breadth * 100, `≥ ${rules.market.breadthStrong * 100}%`, (breadth ?? -1) >= rules.market.breadthStrong, ""),
  );

  if (ret20 === null || above20 === null || m20 === null || breadth === null) {
    return {
      state: "数据不足",
      reasons,
      implication: "部分市场数据缺失，大盘环境无法判定。",
    };
  }
  let state: string;
  if (
    ret20 >= rules.market.strong20Pct &&
    above20 &&
    m20 &&
    breadth >= rules.market.breadthStrong
  ) {
    state = "强";
  } else if (
    ret20 <= rules.market.weak20Pct ||
    (!above20 && breadth <= rules.market.breadthWeak)
  ) {
    state = "偏弱";
  } else {
    state = "正常";
  }
  const implication = ({
    强: "强环境对趋势交易容错较高，突破与趋势延续更易成立，但仍需逐票确认。",
    正常: "正常环境需要更严格的量价确认，不追高，等待明确信号。",
    偏弱: "偏弱环境突破失败概率较高，优先观察与等待，不把小幅走强当作启动。",
    数据不足: "数据不足，无法判断大盘环境。",
  } as Record<string, string>)[state];
  return { state, reasons, implication };
}

export function analyzeSector(
  sector: SectorData,
  stocksByCode: Map<string, StockData>,
  rules: Rules,
): SectorResult {
  const reasons: ReasonItem[] = [];
  const members = sector.members
    .map((c) => stocksByCode.get(c))
    .filter((s): s is StockData => Boolean(s));
  const r5 = ret(sector.close, 5);
  const r20 = ret(sector.close, 20);
  const r5Prev = retAt(sector.close, 5, 6);
  const lastSec = lastValid(sector.close);
  const ma20s = ma(sector.close, 20);
  const above20 = ma20s === null || lastSec === null
    ? null
    : lastSec > ma20s;
  const vr = volRatio(sector.volume);
  const breadth20 = members.length
    ? members.filter((s) => (ret(s.close, 20) ?? -999) > 0).length / members.length
    : null;
  const strongMembers = members.filter(
    (s) =>
      (ret(s.close, 20) ?? -Infinity) >= rules.sector.strongStock20Pct &&
      (s.close[s.close.length - 1] ?? 0) > (ma(s.close, 20) ?? Infinity) &&
      (ret(s.close, 5) ?? -Infinity) > rules.sector.strongStock5Pct,
  );
  const strongCount = strongMembers.length;
  const strongestMembers = [...strongMembers]
    .sort((a, b) => (ret(b.close, 20) ?? 0) - (ret(a.close, 20) ?? 0))
    .slice(0, 3)
    .map((s) => s.name);
  const accel = r5 !== null && r5Prev !== null ? r5 - r5Prev : null;

  reasons.push(
    reason("sector.ret20", "板块近20日涨幅", r20, "", (r20 ?? -Infinity) >= rules.sector.strong20Pct, ""),
    reason("sector.ret5", "板块近5日涨幅", r5, "", (r5 ?? -Infinity) > rules.sector.strong5Pct, ""),
    reason("sector.aboveMA20", "板块站上20日线", above20 === null ? null : above20 ? 1 : 0, "是", above20 === true, ""),
    reason("sector.volumeRatio", "量比(5日/20日)", vr, "", (vr ?? -1) >= rules.sector.accelVolumeRatio, ""),
    reason("sector.breadth20", "板块内20日上涨家数占比", breadth20 === null ? null : breadth20 * 100, "", (breadth20 ?? -1) >= rules.sector.breadthStrong, ""),
    reason("sector.strongCount", "板块内强势股数量", strongCount, "", strongCount >= rules.sector.strongStockMin, ""),
    reason("sector.accel", "5日较前5日加速度(pct)", accel, "", (accel ?? -Infinity) >= rules.sector.accelAccelPct, ""),
  );

  if (r5 === null || r20 === null || above20 === null || vr === null ||
      breadth20 === null || members.length === 0) {
    return {
      code: sector.code,
      name: sector.name,
      state: "数据不足",
      reasons,
      breadth20,
      strongCount,
      strongestMembers,
    };
  }
  let state = "震荡";
  if (
    r20 >= rules.sector.strong20Pct &&
    r5 > rules.sector.strong5Pct &&
    above20 &&
    breadth20 >= rules.sector.breadthStrong &&
    strongCount >= rules.sector.strongStockMin
  ) {
    state = "持续强势";
  } else if (
    r20 >= rules.sector.accel20Pct &&
    (accel ?? -Infinity) >= rules.sector.accelAccelPct &&
    vr >= rules.sector.accelVolumeRatio &&
    breadth20 >= rules.sector.accelBreadth
  ) {
    state = "正在加强";
  } else if (
    r20 < rules.sector.active20PctMax &&
    r5 >= rules.sector.active5Pct &&
    vr >= rules.sector.activeVolumeRatio &&
    strongCount >= rules.sector.activeStrongStockMin
  ) {
    state = "开始活跃";
  } else if (
    r20 <= rules.sector.weak20Pct ||
    (!above20 && breadth20 <= rules.sector.weakBreadth)
  ) {
    state = "走弱";
  }
  return {
    code: sector.code,
    name: sector.name,
    state,
    reasons,
    breadth20,
    strongCount,
    strongestMembers,
  };
}

function retAt(close: Maybe[], k: number, fromEnd: number): number | null {
  const v = valid(close);
  const end = v.length - fromEnd;
  if (end - k < 0) return null;
  const base = v[end - k];
  if (base === 0) return null;
  return (v[end] / base - 1) * 100;
}

export function classifyStock(
  stock: StockData,
  rules: Rules,
): StockResult {
  const m = computeStockMetrics(stock, rules);
  const reasons: ReasonItem[] = [
    reason("stock.ret5", "近5日涨跌幅", m.ret5, "", true, ""),
    reason("stock.ret10", "近10日涨跌幅", m.ret10, "", true, ""),
    reason("stock.ret20", "近20日涨跌幅", m.ret20, "", true, ""),
    reason("stock.dist20", "距20日线", m.dist20, "", true, ""),
    reason("stock.distHigh", "距20日高点", m.distHigh, "", true, ""),
    reason("stock.volumeRatio", "量比(5日/20日)", m.volRatio, "", true, ""),
    reason("stock.aboveMA20", "站上20日线", m.above20 === null ? null : m.above20 ? 1 : 0, "是", m.above20 === true, ""),
    reason("stock.ma20Up", "20日线上弯", m.ma20Up === null ? null : m.ma20Up ? 1 : 0, "是", m.ma20Up === true, ""),
    reason("stock.daysAbove20", "连续站上20日线天数", m.daysAbove20, "", true, ""),
  ];
  if (m.isST) reasons.push(reason("stock.isST", "ST/风险警示", 1, "否", false, "ST 不进入观察"));

  const bucket = (key: string, label: string, matched: boolean, note: string) => {
    reasons.push(reason(`bucket.${key}`, label, null, matched ? "命中" : "未命中", matched, note));
  };

  if (m.days < rules.stock.minDays) {
    bucket("data", "数据充分性", false, `可用交易日 ${m.days} < ${rules.stock.minDays}`);
    return {
      code: stock.code, name: stock.name, type: "数据不足", reasons,
      subtype: null, atr: m.atr,
    };
  }
  const last5Vol = valid(stock.volume).slice(-5);
  if (last5Vol.length === 5 && last5Vol.every((v) => v === 0)) {
    bucket("data", "数据充分性", false, "最近5个交易日无成交");
    return {
      code: stock.code, name: stock.name, type: "数据不足", reasons,
      subtype: null, atr: m.atr,
    };
  }

  const exclude =
    (m.ret20 ?? Infinity) <= rules.stock.exclude20Max ||
    (m.above20 === false && m.above60 === false && m.ma60Up !== true) ||
    ((m.ret5 ?? Infinity) <= rules.stock.exclude5Max &&
      (m.volRatio ?? -1) >= rules.stock.excludeVolumeRatio);
  bucket("exclude", "排除条件", exclude, exclude ? "命中排除条件" : "未命中");
  if (exclude) {
    return { code: stock.code, name: stock.name, type: "排除", reasons, subtype: null, atr: m.atr };
  }

  const high =
    (m.ret20 ?? -Infinity) >= rules.stock.high20Min ||
    ((m.distHigh ?? -Infinity) >= rules.stock.highDistHighMin &&
      (m.dist20 ?? -Infinity) >= rules.stock.highDist20Min) ||
    ((m.ret5 ?? -Infinity) >= rules.stock.high5Min &&
      (m.volRatio ?? -1) >= rules.stock.highVolumeRatio) ||
    ((m.ret5 ?? Infinity) < rules.stock.highStall5Max &&
      (m.volRatio ?? -1) >= rules.stock.highStallVolumeRatio &&
      (m.ret20 ?? -Infinity) >= rules.stock.highStall20Min);
  bucket("high", "高位观察条件", high, high ? "命中高位条件" : "未命中");
  if (high) {
    return { code: stock.code, name: stock.name, type: "高位观察", reasons, subtype: null, atr: m.atr };
  }

  const pullback =
    (m.pullback ?? -Infinity) >= rules.stock.pullbackMin &&
    (m.ret5 ?? Infinity) <= rules.stock.pullback5Max &&
    (m.ma20Up === true || m.above60 === true);
  bucket("pullback", "回调观察条件", pullback, pullback ? "命中回调条件" : "未命中");
  if (pullback) {
    let subtype = "量能中性";
    if ((m.volRatio ?? Infinity) <= rules.stock.pullbackVolumeLow) subtype = "缩量回调";
    if ((m.volRatio ?? -1) >= rules.stock.pullbackVolumeHigh) subtype = "放量回调";
    return { code: stock.code, name: stock.name, type: "回调观察", reasons, subtype, atr: m.atr };
  }

  const start =
    (m.ret20 ?? -Infinity) >= rules.stock.start20Min &&
    (m.ret20 ?? Infinity) <= rules.stock.start20Max &&
    (m.ret5 ?? -Infinity) > 0 &&
    m.above20 === true &&
    m.ma20Up === true &&
    (m.distHigh ?? -Infinity) >= rules.stock.startDistHighMin &&
    (m.volRatio ?? -1) >= rules.stock.startVolumeRatio &&
    m.daysAbove20 <= rules.stock.startDaysAbove20Max;
  bucket("start", "启动观察条件", start, start ? "命中启动条件" : "未命中");
  if (start) {
    return { code: stock.code, name: stock.name, type: "启动观察", reasons, subtype: null, atr: m.atr };
  }

  const trend =
    m.above20 === true &&
    (m.dist20 ?? Infinity) <= rules.stock.trendDist20Max &&
    (m.distHigh ?? -Infinity) >= rules.stock.trendDistHighMin &&
    (m.ret5 ?? -Infinity) > rules.stock.trend5Min &&
    (((m.ret20 ?? -Infinity) > rules.stock.trend20Min &&
      (m.ret20 ?? Infinity) <= rules.stock.trend20Max) ||
      m.daysAbove20 > 10);
  bucket("trend", "趋势观察条件", trend, trend ? "命中趋势条件" : "未命中");
  if (trend) {
    return { code: stock.code, name: stock.name, type: "趋势观察", reasons, subtype: null, atr: m.atr };
  }

  const fallback = (m.ret20 ?? -Infinity) > 0 && m.above20 === true;
  bucket("fallback", "兜底判断", fallback, fallback ? "站上20日线但动量不足，归入趋势观察" : "未站上20日线或动量不足，归入排除");
  return {
    code: stock.code,
    name: stock.name,
    type: fallback ? "趋势观察" : "排除",
    reasons,
    subtype: null,
    atr: m.atr,
  };
}

export function buildReport(
  snapshot: Snapshot,
  stockCode: string,
  rules: Rules,
): AnalysisReport {
  const stock = snapshot.stocks.find((s) => s.code === stockCode);
  if (!stock) throw new Error(`股票不存在: ${stockCode}`);
  const market = analyzeMarket(snapshot, rules);
  const sectorSrc = snapshot.sectors.find((s) => s.code === stock.industryCode);
  const stocksByCode = new Map(snapshot.stocks.map((s) => [s.code, s]));
  const sector = sectorSrc
    ? analyzeSector(sectorSrc, stocksByCode, rules)
    : {
        code: stock.industryCode,
        name: stock.industry,
        state: "数据不足",
        reasons: [reason("sector.missing", "所属板块数据", null, "存在", false, "缺少板块数据")],
        breadth20: null,
        strongCount: 0,
        strongestMembers: [],
      };
  const stockResult = classifyStock(stock, rules);
  const m = computeStockMetrics(stock, rules);
  const isHigh = stockResult.type === "高位观察";

  // 4.1 中期趋势
  const trendReasons: ReasonItem[] = [
    reason("trend.ret20", "近20日涨跌幅", m.ret20, "", true, ""),
    reason("trend.above20", "价格 vs 20日线", m.above20 === null ? null : m.above20 ? 1 : 0, "", m.above20 === true, ""),
    reason("trend.above60", "价格 vs 60日线", m.above60 === null ? null : m.above60 ? 1 : 0, "", m.above60 === true, ""),
    reason("trend.ma20Up", "20日线上弯", m.ma20Up === null ? null : m.ma20Up ? 1 : 0, "", m.ma20Up === true, ""),
    reason("trend.ma60Up", "60日线上弯", m.ma60Up === null ? null : m.ma60Up ? 1 : 0, "", m.ma60Up === true, ""),
    reason("trend.daysAbove20", "连续站上20日线天数", m.daysAbove20, "", true, ""),
  ];
  let trendState: string;
  if (m.ret20 !== null && m.above20 !== null && m.above60 !== null) {
    if (
      (m.ret20 <= rules.stock.exclude20Max && m.above20 === false) ||
      (m.above60 === false && m.ma60Up !== true)
    ) {
      trendState = "下跌趋势";
    } else if (isHigh) {
      trendState = "高位加速";
    } else if (
      m.above20 === false && m.ma20Up !== true &&
      (m.above60 === false || m.ma60Up !== true || (m.pullback ?? -Infinity) > 12)
    ) {
      trendState = "涨势走弱";
    } else if (
      m.above20 === false && m.above60 === true && m.ma60Up === true &&
      (m.pullback ?? Infinity) <= 12
    ) {
      trendState = "调整期";
    } else if (m.above20 === true && m.ma20Up === true && m.daysAbove20 <= 10) {
      trendState = "上升趋势初期";
    } else if (m.above20 === true && m.ma20Up === true) {
      trendState = "升势中";
    } else {
      trendState = "升势中";
      trendReasons.push(reason("trend.fallback", "兜底", null, "", true, "依据不足，按升势中处理"));
    }
  } else {
    trendState = "数据不足";
  }

  // 4.2 近期价格行为
  const priceReasons: ReasonItem[] = [
    reason("price.ret5", "近5日涨跌幅", m.ret5, "", true, ""),
    reason("price.ret10", "近10日涨跌幅", m.ret10, "", true, ""),
    reason("price.ret20", "近20日涨跌幅", m.ret20, "", true, ""),
    reason("price.volRatio", "量比", m.volRatio, "", true, ""),
    ...(m.atr.available
      ? [reason("price.atr", "ATR 波动标记", m.atr.flag === "正常" ? 0 : m.atr.flag === "偏大" ? 1 : -1, "正常", m.atr.flag === "正常", `ATR=${fmt(m.atr.atr)} 波动带=${fmt(m.atr.band5)}`)]
      : [reason("price.atr", "ATR 波动标记", null, "需要≥15日", false, "数据不足，未计算")]),
  ];
  let priceState: string;
  if (m.ret5 === null || m.ret20 === null) {
    priceState = "数据不足";
  } else if ((m.ret5 ?? -Infinity) >= 15 || isHigh) {
    priceState = "加速上涨";
  } else if (m.ret5 > 0 && m.ret20 >= 3 && m.ret20 <= 15 && (m.volRatio ?? -1) >= 1.2) {
    priceState = "启动";
  } else if ((m.pullback ?? -Infinity) >= 8 && m.ret5 <= 0) {
    priceState = "回调";
  } else if (m.ret20 > 0 && m.above20 === true) {
    priceState = "趋势延续";
  } else {
    priceState = "走弱";
  }

  // 4.3 当前位置
  const posReasons: ReasonItem[] = [
    reason("pos.distHigh", "距20日高点", m.distHigh, "", true, ""),
    reason("pos.dist20", "距20日线", m.dist20, "", true, ""),
    reason("pos.ret5", "近5日涨跌幅", m.ret5, "", true, ""),
    reason("pos.volRatio", "量比", m.volRatio, "", true, ""),
  ];
  let posState: string;
  let trendBroken: boolean | null = null;
  let volumeHeavy: boolean | null = null;
  if (
    (m.distHigh ?? -Infinity) >= -3 && (m.ret5 ?? -Infinity) > 0 &&
    (m.volRatio ?? -1) >= 1.2
  ) {
    posState = "突破附近";
  } else if (isHigh) {
    posState = "高位加速后";
  } else if ((m.pullback ?? -Infinity) >= 8) {
    posState = "上涨后回调";
    trendBroken = !(m.above60 === true && m.ma20Up === true);
    volumeHeavy = (m.volRatio ?? -1) >= 1.5;
    posReasons.push(
      reason("pos.trendBroken", "回调是否破坏趋势", trendBroken ? 1 : 0, "未破坏", !trendBroken, trendBroken ? "跌破60日线或20日线走平/下弯" : "仍在60日线上方且20日线上弯"),
      reason("pos.volumeHeavy", "回调量能", volumeHeavy ? 1 : 0, "缩量更健康", !volumeHeavy, volumeHeavy ? "放量回调" : "缩量或量能中性"),
    );
  } else if (m.above20 === true && (m.pullback ?? Infinity) < 8) {
    posState = "趋势运行中";
  } else {
    posState = "趋势运行中";
  }

  const nextSteps = NEXT_STEPS[stockResult.type] ?? [];
  const conclusion = `当前归类为「${stockResult.type}」`;
  const why = buildWhy(market, sector, stockResult, m);

  const missing: string[] = [];
  if (m.days < rules.stock.minDays) missing.push(`可用交易日仅 ${m.days} 天`);
  if (!m.atr.available) missing.push("ATR 数据不足（需≥15日）");
  if (sector.state === "数据不足") missing.push("所属板块数据不足");
  if (market.state === "数据不足") missing.push("大盘数据不足");

  return {
    market,
    sector,
    stockTrend: { state: trendState, reasons: trendReasons },
    priceAction: { state: priceState, reasons: priceReasons },
    position: { state: posState, reasons: posReasons, trendBroken, volumeHeavy },
    currentType: stockResult.type,
    nextSteps,
    conclusion,
    why,
    dataSufficiency: {
      enough: missing.length === 0,
      missing,
    },
  };
}

function buildWhy(
  market: MarketResult,
  sector: SectorResult,
  stock: StockResult,
  m: StockMetrics,
): string[] {
  const items = [
    `大盘环境为「${market.state}」，${market.state === "数据不足" ? "无法作为趋势背景" : "决定趋势交易的容错空间"}`,
    `所属板块「${sector.name}」状态为「${sector.state}」${sector.state === "数据不足" ? "" : `，板块赚钱效应（上涨占比）约 ${fmt((sector.breadth20 ?? 0) * 100)}%`}`,
    `个股近5日涨幅 ${fmt(m.ret5)}%、近20日涨幅 ${fmt(m.ret20)}%，量比 ${fmt(m.volRatio)}`,
    `价格距20日线 ${fmt(m.dist20)}%、距20日高点 ${fmt(m.distHigh)}%`,
    ...(m.atr.available
      ? [`ATR 波动标记为「${m.atr.flag}」，${m.atr.flag === "正常" ? "当前涨跌处于正常波动范围" : m.atr.flag === "偏大" ? "短期涨幅超过正常波动范围" : "短期跌幅超过正常波动范围"}`]
      : ["ATR 数据不足，未计算正常波动范围"]),
  ];
  return items;
}

export const NEXT_STEPS: Record<string, string[]> = {
  启动观察: [
    "关注是否持续放量并突破20日高点",
    "回踩20日线时是否缩量企稳",
  ],
  趋势观察: [
    "关注趋势能否保持，20日线是否持续上弯",
    "关注回调是否健康：缩量回踩20日线后能否再向上",
  ],
  回调观察: [
    "判断回调是缩量还是放量",
    "关注能否重新放量站回20日线",
  ],
  高位观察: [
    "重点观察是否出现滞涨、放量滞涨",
    "警惕跌破20日线的趋势破位",
  ],
  排除: [
    "关注能否重新站回关键均线（20日/60日）",
    "避免把急跌后的反弹直接当作反转",
  ],
  数据不足: [
    "补足60个交易日后重新分析",
  ],
};

export function learningQuestions(type: string): string[] {
  return LEARNING_QUESTIONS[type] ?? LEARNING_QUESTIONS["数据不足"];
}

export const LEARNING_QUESTIONS: Record<string, string[]> = {
  启动观察: [
    "你会把它放在哪个观察类型？",
    "这次上涨属于启动阶段还是趋势加速？为什么？",
    "如果接下来回调，你最希望看到价格和成交量出现什么变化？",
  ],
  趋势观察: [
    "趋势延续最需要盯住哪个信号？",
    "如果回调，你希望看到缩量还是放量？为什么？",
    "什么情况出现会让你重新判断它不是趋势观察？",
  ],
  高位观察: [
    "什么信号出现会让你警惕？",
    "放量滞涨说明什么？",
    "如果它开始回调，你想先看哪个指标？",
  ],
  回调观察: [
    "回调是缩量还是放量？你认为哪种更健康？",
    "回调是否破坏了上升趋势？你用什么判断？",
    "如果重新向上突破，你想看到什么确认？",
  ],
  排除: [
    "你觉得它被排除的主要原因是什么？",
    "什么条件变化后它值得重新进入观察？",
  ],
  数据不足: ["缺少哪些数据会让你无法判断？"],
};

const KEYWORD_GROUPS: Record<string, string[]> = {
  量能: ["放量", "缩量", "量比", "量能", "成交量"],
  突破: ["突破", "新高", "站上", "站稳", "破位", "跌破"],
  均线: ["20日", "60日", "均线", "支撑", "压力", "日线"],
  位置: ["高位", "低位", "顶部", "底部", "位置", "回调"],
  环境: ["大盘", "市场", "板块", "行业", "赚钱效应", "环境"],
  节奏: ["启动", "加速", "趋势", "延续", "滞涨", "观察"],
};

export interface LearningFeedback {
  doneRight: string[];
  easyToMiss: string[];
  thinkFurther: string;
}

export function generateLearningFeedback(
  type: string,
  answer: string,
  report: AnalysisReport,
  m: StockMetrics,
): LearningFeedback {
  const mentioned = Object.entries(KEYWORD_GROUPS)
    .filter(([, words]) => words.some((w) => answer.includes(w)))
    .map(([k]) => k);
  const doneRight =
    mentioned.length > 0
      ? [
          `你注意到了「${mentioned.join("、")}」这些因素，说明你在按量价关系思考。`,
          "你没有被单一指标带偏，而是在描述价格行为，这一点很好。",
        ]
      : [
          "你给出了自己的判断方向，这是学习的第一步。",
          "接下来可以试着把判断落到具体的价格和成交量信号上。",
        ];

  const facts: Array<[string, boolean]> = [
    ["量能变化（量比 " + fmt(m.volRatio) + "）", /量|放|缩/.test(answer)],
    ["价格与20日线的关系（偏离 " + fmt(m.dist20) + "%）", /20日|均线|日线|支撑|压力/.test(answer)],
    ["距20日高点位置（" + fmt(m.distHigh) + "%）", /高点|新高|突破|位置/.test(answer)],
    ["大盘「" + report.market.state + "」与板块「" + report.sector.state + "」环境", /大盘|市场|板块|行业|环境/.test(answer)],
    ["ATR 波动标记「" + (m.atr.available ? m.atr.flag : "数据不足") + "」", /ATR|波动|超跌/.test(answer)],
  ];
  const easyToMiss = facts.filter(([, covered]) => !covered).map(([label]) => label);

  const further: Record<string, string> = {
    启动观察: "启动确认靠『放量 + 位置』：没有量的突破容易是假突破；位置已经远离20日线时追入的成本和风险都会更高。",
    趋势观察: "趋势是否健康，重点看回调时的量与20日线的方向：缩量回踩说明抛压有限，20日线持续上弯说明趋势还活着。",
    回调观察: "回调本身不可怕，可怕的是放量下跌；你要判断的是趋势有没有被破坏，而不是单纯看跌了多少。",
    高位观察: "高位最危险的不是上涨，而是『放量却涨不动』；滞涨意味着买盘无法继续推高，接下来要看会不会破位。",
    排除: "排除不等于永远不会再看，而是当前价格结构不满足观察条件；先确认它重新站回关键均线，再重新进入观察。",
    数据不足: "没有足够数据时，任何结论都是猜测；先补齐交易日和成交量数据，再谈判断。",
  };
  return {
    doneRight,
    easyToMiss,
    thinkFurther: further[type] ?? "把每个结论都落到具体的价格、成交量和位置数据上。",
  };
}

export interface ThesisInput {
  types: string[];
  horizon: string;
  text: string;
}

export interface ThesisRow {
  reasonType: string;
  systemEvidence: string;
  conclusion: string;
}

export interface ThesisReview {
  rows: ThesisRow[];
  followUp: string;
}

export function reviewThesis(
  input: ThesisInput,
  report: AnalysisReport,
  m: StockMetrics,
): ThesisReview {
  const rows: ThesisRow[] = [];
  if (input.types.includes("技术形态")) {
    const userSaid = input.text.includes(report.currentType);
    const otherTypes = Object.keys(LEARNING_QUESTIONS).filter(
      (t) => t !== report.currentType,
    );
    const conflict = otherTypes.some((t) => input.text.includes(t));
    rows.push({
      reasonType: "技术形态",
      systemEvidence: `系统当前归类「${report.currentType}」：近20日涨幅 ${fmt(m.ret20)}%、距20日线 ${fmt(m.dist20)}%、距20日高点 ${fmt(m.distHigh)}%、量比 ${fmt(m.volRatio)}`,
      conclusion: userSaid ? "一致" : conflict ? "冲突" : "未覆盖",
    });
  }
  if (input.types.includes("消息催化")) {
    rows.push({
      reasonType: "消息催化",
      systemEvidence: "快照没有新闻/公告数据",
      conclusion: "数据不足，不许编造",
    });
  }
  if (input.types.includes("基本面")) {
    rows.push({
      reasonType: "基本面",
      systemEvidence: "快照没有财务数据",
      conclusion: "数据不足",
    });
  }
  if (input.types.includes("资金流向")) {
    rows.push({
      reasonType: "资金流向",
      systemEvidence: "快照没有资金流数据",
      conclusion: "数据不足",
    });
  }
  if (input.types.includes("情绪博弈")) {
    const active = (m.volRatio ?? 0) >= 1.2;
    rows.push({
      reasonType: "情绪博弈",
      systemEvidence: `板块赚钱效应：上涨占比约 ${fmt((report.sector.breadth20 ?? 0) * 100)}%、强势股 ${report.sector.strongCount} 只；个股量比 ${fmt(m.volRatio)}`,
      conclusion: active ? "一致（量能支持情绪面）" : "未覆盖（量能未见明显放大）",
    });
  }
  const horizonMap: Record<string, [number | null, string]> = {
    短线: [m.ret5, "近5日涨跌幅"],
    波段: [m.ret20, "近20日涨跌幅"],
    中线: [m.ret60, "近60日涨跌幅"],
  };
  const [hVal, hLabel] = horizonMap[input.horizon] ?? [null, ""];
  rows.push({
    reasonType: `时间预期（${input.horizon}）`,
    systemEvidence: `${hLabel} ${fmt(hVal)}%`,
    conclusion: hVal === null ? "数据不足" : hVal > 0 ? "一致（该窗口表现为正）" : "冲突（该窗口表现为负）",
  });
  return {
    rows,
    followUp: "你的判断和系统依据有哪些地方不一样？试着说出系统可能没看到、但你看到了的因素。",
  };
}

export { defaultRules };
