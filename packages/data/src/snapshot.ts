/**
 * 快照加载与实时叠加。
 *
 * 快照是"批量历史"的载体：由 GitHub Actions 每日收盘后生成静态 JSON，
 * 前端直接拉取。这样浏览器不必为 500+ 只股票逐票请求 K 线（会触发限频）。
 * 详见 docs/data-sources.md。
 */
import type { Currency, MarketGroup, SeriesData, Snapshot } from "@aw/core";
import { currencyOf } from "./codes";
import { isCalendarFresh } from "./session";
import type { Quote } from "./types";

export interface SnapshotBundle {
  /** 引擎直接消费的对象 */
  snapshot: Snapshot;
  /** 交易日历 `YYYY-MM-DD[]`，用于交易时段/节假日判断 */
  calendar: string[];
  /** `meta.json` 内容 */
  meta: Record<string, unknown>;
  /** 快照目录名，如 `snapshot_20260922` */
  name: string;
}

/** 快照默认放在站点的 `data/` 下，随构建产物一起发布 */
export const DEFAULT_DATA_BASE = "./data";

interface LoadOptions {
  /** 数据根路径，默认 `./data` */
  base?: string;
  /** 指定快照目录名；默认读取 `latest.json` 自动解析 */
  snapshot?: string;
  /** 覆盖 fetch（便于测试） */
  fetchImpl?: typeof fetch;
}

async function getJson<T>(url: string, f: typeof fetch): Promise<T> {
  const res = await f(url);
  if (!res.ok) throw new Error(`读取 ${url} 失败：HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** 解析最新快照目录名 */
export async function resolveLatestSnapshot(
  base = DEFAULT_DATA_BASE,
  f: typeof fetch = fetch,
): Promise<string> {
  const latest = await getJson<{ snapshot?: string }>(`${base}/latest.json`, f);
  if (!latest.snapshot) throw new Error("latest.json 缺少 snapshot 字段");
  return latest.snapshot;
}

/** 加载完整快照 */
export async function loadSnapshot(options: LoadOptions = {}): Promise<SnapshotBundle> {
  const base = options.base ?? DEFAULT_DATA_BASE;
  const f = options.fetchImpl ?? fetch;
  const name = options.snapshot ?? (await resolveLatestSnapshot(base, f));
  const dir = `${base}/${name}`;

  const [meta, calendar, indices, sectors, stocks, etfs] = await Promise.all([
    getJson<Record<string, unknown>>(`${dir}/meta.json`, f),
    getJson<string[]>(`${dir}/calendar.json`, f),
    getJson<SeriesData[]>(`${dir}/indices.json`, f),
    getJson<Snapshot["sectors"]>(`${dir}/sectors.json`, f),
    getJson<Snapshot["stocks"]>(`${dir}/stocks.json`, f),
    getJson<SeriesData[]>(`${dir}/etfs.json`, f),
  ]);

  return {
    name,
    calendar,
    meta,
    snapshot: { meta, calendar, indices, sectors, stocks, etfs },
  };
}

/**
 * 快照里带的汇率：1 单位外币值多少人民币（与引擎口径一致）。
 *
 * 只放**已经拿到**的币种。拿不到就不放 —— 这里绝不兜底成 1:1：
 * 那等于假装港币就是人民币，价格会凭空少 14%，而且全程没有任何提示。
 */
export type FxRates = Partial<Record<Currency, number>>;

/**
 * 从快照的 `meta` 里读汇率。
 *
 * `fetch_snapshot.py` 把当天中行折算价写在 `meta.hk.fx = {pair, date, rate}`
 * （`rate` 是"1 港币值多少人民币"）。读不到就返回空表，由调用方决定怎么办。
 */
export function fxRatesOfMeta(meta: Record<string, unknown>): FxRates {
  const out: FxRates = {};
  const hk = meta?.hk;
  if (hk && typeof hk === "object") {
    const fx = (hk as { fx?: unknown }).fx;
    if (fx && typeof fx === "object") {
      const rate = (fx as { rate?: unknown }).rate;
      if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) out.HKD = rate;
    }
  }
  return out;
}

/** 折算后保留 4 位小数：够精确到分，又不会拖一串浮点尾巴（与 replay 的 convertShardToCny 同口径） */
function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

function scaleColumn(
  col: Array<number | null> | undefined,
  rate: number,
): Array<number | null> | undefined {
  return col?.map((v) => (v === null || v === undefined ? null : round4(v * rate)));
}

/**
 * 把快照里境外标的的价格折成人民币。**折算必须发生在数据进引擎之前。**
 *
 * 账户是人民币记账的（`Account.cash`、`Trade.amount`、`avgCost` 全是 ¥），
 * 折完之后 `price × shares === amount`、费用按 amount 算、跨标的求和的权益曲线
 * 这几条不变式一条都不用改，与历史推演走 `convertShardToCny` 是同一个道理。
 *
 * 与推演的区别：推演分片带**逐日**汇率序列，快照只带生成当天那**一个**价。
 * 所以这里整条序列用同一个汇率 —— 对「拿最近几天算涨跌幅」反而更干净
 * （涨幅里不会混进汇率波动），代价是更早的历史不是当日汇率口径。
 *
 * ⚠️ **非幂等**：`currency` 字段保持原样（界面要标"原以港币计价"），
 * 所以调两次会折两次。只在**加载快照时调一次**。
 *
 * 换不到汇率的标的**原样留着不动**（不猜、也不按 1:1 顶），
 * 由调用方通过 `currency` 与 `fxRatesOfMeta` 自己判断要不要拦。
 */
export function convertSnapshotToCny(snapshot: Snapshot, rates: FxRates): Snapshot {
  if (!rates || Object.keys(rates).length === 0) return snapshot;

  const conv = <T extends SeriesData>(s: T): T => {
    const cur: Currency = s.currency ?? currencyOf(s.code);
    if (cur === "CNY") return s;
    const rate = rates[cur];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return s;
    return {
      ...s,
      open: scaleColumn(s.open, rate),
      close: scaleColumn(s.close, rate),
      high: scaleColumn(s.high, rate),
      low: scaleColumn(s.low, rate),
      // volume 不折：它是股数，跟币种无关
    };
  };

  return {
    ...snapshot,
    indices: snapshot.indices.map(conv),
    sectors: snapshot.sectors.map(conv),
    stocks: snapshot.stocks.map(conv),
    etfs: snapshot.etfs.map(conv),
  };
}

export interface ApplyLiveOptions {
  /** `YYYY-MM-DD`，北京时间的"今天" */
  today: string;
  /** 是否允许在没有今日 bar 时追加一根新 bar（默认 true） */
  append?: boolean;
  /**
   * 港股交易日历。给了才能按港股自己的交易日判断。
   *
   * 为什么需要：A 股与港股放假不同（国庆那一周 A 股全休、港股照常开市，
   * 反过来佛诞与回归纪念日港股休、A 股开）。不区分就会出现两种错：
   * - 国庆期间拉到港股实时价，却给 A 股也追一根 bar（A 股那天根本没开市）
   * - 港股放假那天把上一场的港股价当成今天的价写进去
   */
  hkCalendar?: string[];
  /**
   * 汇率表。快照已被 `convertSnapshotToCny` 折成人民币、而实时报价仍是本币时
   * **必须传**：否则港股会被「用港币价覆盖人民币收盘价」—— 腾讯 431 港币
   * 当成 ¥431 写进去，比真实人民币价高 14%，而且界面上一切正常。
   *
   * 传了却换不到该标的的汇率时**跳过不写**：宁可让价格停在昨天的收盘价，
   * 也不要写一个把港币当人民币的数字。
   */
  fx?: FxRates;
}

/**
 * 把实时价叠加到快照上，让漏斗在盘中也能反映当前价格。
 *
 * 行为：
 * - 若该序列最后一根 bar 的日期就是今天 → **覆盖**其 close/high/low
 * - 否则**追加**一根新 bar（需要 `today` 与日历）
 * - 追加时 volume 置 null：宁可让量比少算一天，也不要编造成交量
 *   （`valid()` 会自动跳过 null，量比退化为"截至昨日的 20 日"）
 * - **今天不开市的市场只补 null，不写价**（见 `marketTradesToday`）
 *
 * @returns 新的 Snapshot，不修改入参
 */
export function applyLivePrices(
  bundle: SnapshotBundle,
  quotes: Quote[],
  options: ApplyLiveOptions,
): Snapshot {
  const byCode = new Map(quotes.filter((q) => q.price !== null).map((q) => [q.code, q]));
  if (byCode.size === 0) return bundle.snapshot;

  const { calendar } = bundle;
  const lastDate = calendar.at(-1);
  const isToday = lastDate === options.today;
  const append = options.append ?? true;
  const shouldAppend = !isToday && append;

  /**
   * 今天这个市场开不开市。
   *
   * 日历可信就查日历；日历过期（快照没跟上）时退回按周末粗判 ——
   * 与 `@aw/data` 的 `sessionState` 同一套保守策略：宁可多问一次接口，
   * 也不要假装全市场休市、把实时价整片丢掉。
   */
  const marketTradesToday = (market: MarketGroup): boolean => {
    const cal = market === "HK" ? options.hkCalendar : calendar;
    const isWeekend = () => {
      const dow = new Date(`${options.today}T12:00:00Z`).getUTCDay();
      return dow === 0 || dow === 6;
    };
    if (!isCalendarFresh(cal, options.today)) return !isWeekend();
    return cal!.includes(options.today);
  };

  const patch = <T extends SeriesData>(s: T): T => {
    const q = byCode.get(s.code);
    if (!q || q.price === null) return s;

    /*
     * 报价一律是本币（腾讯给港股的就是港币），而快照已经折成人民币。
     * 不折就直接覆盖，等于把 431 港币写成 ¥431。折不了就整支跳过 ——
     * 停在昨天的收盘价是个看得见的旧数字，混进一个「港币当人民币」的
     * 数字则是看不见的错。
     */
    const cur: Currency = s.currency ?? currencyOf(s.code);
    const rate = cur === "CNY" ? 1 : options.fx?.[cur];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return s;
    const price = rate === 1 ? q.price : round4(q.price * rate);

    // 缺省是 A 股：老快照与老 fixture 没有 market 这一列，而那些数据全是 A 股
    const market: MarketGroup = s.market ?? "CN";
    const n = s.close.length;

    if (isToday && n > 0) {
      // 已收盘快照已含今日 bar，用实时价覆盖（收盘后二者相等）
      if (!marketTradesToday(market)) return s;
      const close = [...s.close];
      close[n - 1] = price;
      return { ...s, close };
    }
    if (shouldAppend) {
      // open 只在原本就存在、且与 close 等长时才一起追加，否则置空——
      // 一个长度对不上的 open 数组比没有这一列更危险：历史推演会照它按错误的日期撮合。
      // 追加的这一根是「今天」正在走的 bar，我们并不知道今天的开盘价，
      // 所以补 null 而不是拿当前价冒充（推演也从不使用未收盘的 bar）。
      const open = s.open && s.open.length === n ? [...s.open, null] : undefined;
      // 今天不开市的市场照样要占位，否则各序列长度不一致，
      // 而快照里的日历是所有序列共用的下标 —— 长度一乱，`close[日历长度-1]` 就取到别人头上。
      const closedToday = !marketTradesToday(market);
      return {
        ...s,
        open,
        close: [...s.close, closedToday ? null : price],
        high: [...s.high, closedToday ? null : price],
        low: [...s.low, closedToday ? null : price],
        volume: [...s.volume, null],
      };
    }
    return s;
  };

  return {
    ...bundle.snapshot,
    calendar: shouldAppend ? [...calendar, options.today] : calendar,
    indices: bundle.snapshot.indices.map(patch),
    sectors: bundle.snapshot.sectors.map(patch),
    stocks: bundle.snapshot.stocks.map(patch),
    etfs: bundle.snapshot.etfs.map(patch),
  };
}
