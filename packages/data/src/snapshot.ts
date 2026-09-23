/**
 * 快照加载与实时叠加。
 *
 * 快照是"批量历史"的载体：由 GitHub Actions 每日收盘后生成静态 JSON，
 * 前端直接拉取。这样浏览器不必为 500+ 只股票逐票请求 K 线（会触发限频）。
 * 详见 docs/data-sources.md。
 */
import type { SeriesData, Snapshot } from "@aw/core";
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

export interface ApplyLiveOptions {
  /** `YYYY-MM-DD`，北京时间的"今天" */
  today: string;
  /** 是否允许在没有今日 bar 时追加一根新 bar（默认 true） */
  append?: boolean;
}

/**
 * 把实时价叠加到快照上，让漏斗在盘中也能反映当前价格。
 *
 * 行为：
 * - 若该序列最后一根 bar 的日期就是今天 → **覆盖**其 close/high/low
 * - 否则**追加**一根新 bar（需要 `today` 与日历）
 * - 追加时 volume 置 null：宁可让量比少算一天，也不要编造成交量
 *   （`valid()` 会自动跳过 null，量比退化为"截至昨日的 20 日"）
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

  const patch = <T extends SeriesData>(s: T): T => {
    const q = byCode.get(s.code);
    if (!q || q.price === null) return s;
    const n = s.close.length;
    if (isToday && n > 0) {
      // 已收盘快照已含今日 bar，用实时价覆盖（收盘后二者相等）
      const close = [...s.close];
      close[n - 1] = q.price;
      return { ...s, close };
    }
    if (shouldAppend) {
      return {
        ...s,
        close: [...s.close, q.price],
        high: [...s.high, q.price],
        low: [...s.low, q.price],
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
