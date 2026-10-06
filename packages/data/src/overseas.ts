/**
 * 把港股 / 美股的日线对齐到 A 股的交易日历上。
 *
 * ── 为什么必须在构建期对齐 ──────────────────────────────────────
 * 引擎（packages/game/src/replay.ts）假定所有标的的价格数组和日历**等长**，
 * 靠下标对齐；apps/web/src/lib/replay.ts 的 isLevelShard 会当场拒收长度不等的分片，
 * 理由是「对不上会被当成『没有开盘价』」——那比报错更糟，因为它不报错。
 * 所以运行时不做对齐，对齐在这里做一次，结果写进分片。
 *
 * ── 三种「缺」要分开处理 ────────────────────────────────────────
 * 港股和美股的开市日和沪深300 不是同一天。两种情况完全不同，不能一把 null 了事：
 *
 *   ① **外盘休市，A 股开着**（美股感恩节、港股佛诞）。
 *      这一天外盘真的没有价格。但**不代表这笔持仓没有价值** —— 它昨天值多少，
 *      今天还是多少。所以：
 *        · `close` 沿用上一个交易日的收盘价（**向后填充**）。
 *          不填的话，portfolio.ts:84 的 holdingsValue 会拿**成本价**兜底
 *          （`p ?? h.avgCost`），持仓在休市那天会凭空跳一下，权益曲线就假了。
 *        · `open` / `high` / `low` / `volume` 置 null。这几个是「当天那一场交易」
 *          才有的东西，休市就是没有。open 为 null 让引擎知道「今天不能成交」，
 *          委托该顺延而不是作废（引擎那边配套改了，见 replay.ts 的 nextFillIndex）。
 *
 *   ② **A 股休市，外盘开着**（春节、国庆）。
 *      这一天根本不在日历上，外盘那根 K 线被**跳过**。不补，也不合并到相邻日 ——
 *      日历是「玩家能行动的日子」，没开门的日子玩家本来就动不了。
 *
 *   ③ **标的还没上市 / 已退市**（阿里巴巴-W 2019-11-26 才上市）。
 *      窗口内缺得太多就整个标的不要，由 coverage() 判断，交给调用方决定阈值。
 *
 * 这个文件和 codes.ts 是配套的：codes.ts 认代码，这里把价格摆到日历上。
 */

import type { Currency, Market } from "./codes";

/** 一只境外标的的原始日线，对应 data/history-cache/<code>.json 的境外部分 */
export interface OverseasSeries {
  code: string;
  name: string;
  market: Market;
  currency: Currency;
  /** 升序，YYYY-MM-DD */
  dates: string[];
  open: Array<number | null>;
  close: Array<number | null>;
  high: Array<number | null>;
  low: Array<number | null>;
  volume: Array<number | null>;
}

/** 对齐到日股日历之后的样子，字段与 ReplayInstrument 兼容 */
export interface AlignedOverseas {
  code: string;
  name: string;
  market: Market;
  currency: Currency;
  isST: boolean;
  industry: string;
  /** 窗口第一天用的「前一天收盘」 */
  prevClose: number | null;
  open: Array<number | null>;
  close: Array<number | null>;
  high: Array<number | null>;
  low: Array<number | null>;
  volume: Array<number | null>;
  /**
   * 有几天的 close 是沿用上一个交易日的（当天外盘休市）。
   * 不参与交易逻辑，只给测试和体检用 —— 没有它就没法断言「填充真的发生了」。
   */
  staleDays: number;
  /** 日历里有几天是外盘休市（open 为 null 但 close 有值） */
  closedDays: number;
}

/**
 * 在升序数组里找「最后一个 <= day 的下标」，找不到返回 -1。
 * 手写二分而不是 indexOf：外盘一年 250 根，窗口 26 天，摊下来差不了多少，
 * 但 indexOf 的写法一旦有人把「向后找最近的」写成「找相等的」就会安静地错。
 */
function lastIndexAtOrBefore(sorted: string[], day: string): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= day) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * 这个窗口里有多少比例的交易日**外盘是开着的**（当天有真实报价）。
 *
 * 不用「有 close」来算，因为 close 是填充过的，永远有值。
 * 用 open 判断：open 只有在标的当天真的有交易时才不是 null。
 */
export function coverage(series: OverseasSeries, calendar: string[]): number {
  if (calendar.length === 0) return 0;
  let n = 0;
  for (const day of calendar) {
    const j = lastIndexAtOrBefore(series.dates, day);
    if (j >= 0 && series.dates[j] === day && series.open[j] != null) n += 1;
  }
  return n / calendar.length;
}

/**
 * 对齐后还有几个**非正**的价格。0 才是干净的数据。
 *
 * 为什么需要这个：前复权（qfq）是从今天往回缩的，一只长期高股息的股票，
 * 把历年股息从历史价格里扣掉之后会**扣穿到负数**。实测 42 只港美股里有 1 只
 * 中招 —— 星巴克 2016-01-04 起整段全负（close = -32.58），不是个别毛刺，
 * 是整条序列都没有意义。
 *
 * 负价格进了引擎不会报错：涨跌幅会算出一个正数（负 ÷ 负），下单校验会通过
 * （负数金额小于可用资金），最后结算出一笔谁也看不懂的收益。
 * 所以宁可在门口挡掉，也不要在结算页上解释。
 */
export function nonPositiveCount(a: AlignedOverseas): number {
  let n = 0;
  for (const col of [a.open, a.close, a.high, a.low]) {
    for (const v of col) if (v != null && !(v > 0)) n += 1;
  }
  return n;
}

/**
 * 把一只境外标的摆到日历上。
 *
 * `prevClose` 取的是窗口**第一天之前**最近一个交易日的收盘价 ——
 * 和 build-history-shards.ts 给 A 股的做法一致（那边是 raw.close[firstIdx - 1]）。
 * 没有它，第一天的涨跌幅算不出来，玩家进场那天看不到任何参照。
 */
export function alignOverseasToCalendar(
  series: OverseasSeries,
  calendar: string[],
): AlignedOverseas {
  const open: Array<number | null> = [];
  const close: Array<number | null> = [];
  const high: Array<number | null> = [];
  const low: Array<number | null> = [];
  const volume: Array<number | null> = [];
  let staleDays = 0;
  let closedDays = 0;

  for (const day of calendar) {
    const j = lastIndexAtOrBefore(series.dates, day);
    if (j < 0) {
      // 整个窗口都在上市之前
      open.push(null);
      close.push(null);
      high.push(null);
      low.push(null);
      volume.push(null);
      continue;
    }
    const exact = series.dates[j] === day;
    const c = series.close[j] ?? null;
    close.push(c);
    if (exact) {
      open.push(series.open[j] ?? null);
      high.push(series.high[j] ?? null);
      low.push(series.low[j] ?? null);
      volume.push(series.volume[j] ?? null);
    } else {
      // 外盘休市：这一场交易不存在，但持仓还在，所以只停「当日价」不停「市值」
      open.push(null);
      high.push(null);
      low.push(null);
      volume.push(null);
      if (c == null) staleDays += 1; // 连前一天都没有，那填充也是空的
      else {
        staleDays += 1;
        closedDays += 1;
      }
    }
  }

  const first = calendar[0];
  let prevClose: number | null = null;
  if (first !== undefined) {
    // 先找到 <= 窗口第一天的下标；如果正好落在第一天，再退一格 ——
    // 「前一天」必须是严格早于窗口开头的那一次收盘。
    // build-history-shards.ts 给 A 股写的 raw.close[firstIdx - 1] 是同一个意思。
    let k = lastIndexAtOrBefore(series.dates, first);
    if (k >= 0 && series.dates[k] === first) k -= 1;
    if (k >= 0) prevClose = series.close[k] ?? null;
  }

  return {
    code: series.code,
    name: series.name,
    market: series.market,
    currency: series.currency,
    // 境外市场没有 ST 这一说，也不分红筹行业 —— 留空而不是编一个
    isST: false,
    industry: "",
    prevClose,
    open,
    close,
    high,
    low,
    volume,
    staleDays,
    closedDays,
  };
}

// ── 汇率 ──────────────────────────────────────────────────────
// data/fx-cache/<PAIR>.json。字段名刻意不叫 open/close：它不是行情，
// 是记账用的系数，混用会让人以为可以拿它做交易。

export interface FxSeries {
  code: string;
  name: string;
  /** 升序，YYYY-MM-DD */
  dates: string[];
  /** 1 单位外币折多少人民币（已经从「100 外币」除过 100） */
  rate: Array<number | null>;
}

/**
 * 某一天用哪一档汇率。取「该日或之前最近一次公布的折算价」——
 * 中行只在工作日公布，周末和节假日沿用上一次，这和真实记账一致。
 * 早于整个汇率序列就返回 null，让调用方自己决定要不要用 1.0 兜底。
 */
export function fxRateOn(series: FxSeries, day: string): number | null {
  const i = lastIndexAtOrBefore(series.dates, day);
  if (i < 0) return null;
  return series.rate[i] ?? null;
}

/**
 * 把外币金额折成人民币。人民币直接返回原值。
 * 没有汇率时返回 null —— 不要静默按 1:1 算，那会把港币当成人民币，
 * 误差 16%，而且是「看起来有数字」的那种错。
 */
export function toCny(amount: number, currency: Currency, rate: number | null): number | null {
  if (currency === "CNY") return amount;
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return null;
  return amount * rate;
}

/** 市场的中文名，界面上要用 */
export const MARKET_LABEL: Record<Market, string> = {
  SH: "沪市",
  SZ: "深市",
  BJ: "北交所",
  HK: "港股",
  US: "美股",
  JP: "日股",
  KR: "韩股",
};

/** 币种符号 */
export const CURRENCY_SYMBOL: Record<Currency, string> = {
  CNY: "¥",
  HKD: "HK$",
  USD: "$",
  JPY: "¥",
  KRW: "₩",
};
