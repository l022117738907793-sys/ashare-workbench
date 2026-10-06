/**
 * 交易时段判断。
 *
 * 用**显式的 UTC 偏移**换算，不依赖运行机器的本地时区——用户可能在任何时区打开页面。
 * A 股与港股是 UTC+8，日股与韩股是 UTC+9（东京/首尔比北京早一小时）。
 * 节假日判断优先用快照里的交易日历（`calendar.json`）；没有日历时只能按周末粗判。
 */

export type SessionState =
  | "pre" // 开盘前（含集合竞价）
  | "open" // 连续竞价中
  | "lunch" // 午间休市
  | "closed" // 已收盘
  | "weekend" // 周末
  | "holiday"; // 非交易日（由交易日历判定）

export interface MarketTime {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
  dow: number; // 0=周日
  /** `YYYY-MM-DD`（**该市场的当地日期**） */
  iso: string;
  /** 该市场当地当日零点对应的 UTC 毫秒 */
  dayStartUtc: number;
}

/** 只有 A 股/港股时留下的名字，现在就是 `MarketTime`。 */
export type BeijingTime = MarketTime;

/** 北京时间相对 UTC 的分钟偏移。A 股与港股都用它。 */
export const BJ_OFFSET_MIN = 8 * 60;

/**
 * 把任意时刻换算成**某市场当地时间**的各字段。
 *
 * @param offsetMin 该市场相对 UTC 的分钟偏移（北京 480、东京/首尔 540）
 *
 * ⚠️ `iso` 与 `dow` 都是**当地**的，不是北京的。这不是细节：东京时间 08:30 时
 * 北京还是 07:30，两者的日期在跨日那一刻会差一天 —— 而交易日历是按当地日期编的。
 */
export function marketTime(at: Date = new Date(), offsetMin = BJ_OFFSET_MIN): MarketTime {
  // 先得到真正的 UTC 毫秒，再整体加偏移，然后用 getUTC* 读出来
  const bj = new Date(at.getTime() + offsetMin * 60_000);
  const y = bj.getUTCFullYear();
  const mo = bj.getUTCMonth() + 1;
  const d = bj.getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    y,
    mo,
    d,
    h: bj.getUTCHours(),
    mi: bj.getUTCMinutes(),
    dow: bj.getUTCDay(),
    iso: `${y}-${pad(mo)}-${pad(d)}`,
    dayStartUtc: Date.UTC(y, mo - 1, d) - offsetMin * 60_000,
  };
}

/** 北京时间（UTC+8）的各字段。A 股与港股用。 */
export function beijingTime(at: Date = new Date()): MarketTime {
  return marketTime(at, BJ_OFFSET_MIN);
}

const MIN = 60_000;
/** 当地时间的分钟数 */
function minutesOfDay(t: MarketTime): number {
  return t.h * 60 + t.mi;
}

/**
 * 快照里的交易日历是否仍然可信。
 *
 * 日历以**最后一个交易日**结尾，本身不含未来日期。快照一旦没跟上（例如每日任务
 * 没跑成功），日历就过期了；此时若继续拿它判定，今天明明是交易日也会被判成
 * `holiday`，于是页面在整个交易日都不去拉实时行情——这正是"页面一直停在旧快照"
 * 的根因之一。
 *
 * 规则：日历必须覆盖到"今天或更晚"才可用；否则退回按周末粗判（宁可多问一次
 * 接口，也不要假装全市场休市）。
 */
export function isCalendarFresh(calendar: string[] | undefined, iso: string): boolean {
  if (!calendar || calendar.length === 0) return false;
  let last = "";
  for (const d of calendar) if (d > last) last = d;
  return last >= iso;
}

/**
 * 交易时段按市场分表。**时段数字是各市场的当地时间**，时区由 `offsetMin` 表达。
 *
 * 香港时间就是北京时间（同为 UTC+8），所以港股只换时段数字、不换时区。
 * 港股的午休是 12:00–13:00（比 A 股晚收半小时），下午 16:00 收盘（比 A 股晚一小时）。
 * 于是 15:00–16:00 这一小时会同时出现「A 股已收盘、港股还在交易」——
 * 这正是把时段做成参数、而不是继续硬编码的原因。
 *
 * 日股与韩股是 **UTC+9**，比北京早一小时：
 * - 日股 09:00–11:30 / 12:30–15:30 JST → 北京 08:00–10:30 / 11:30–14:30
 * - 韩股 09:00–15:30 KST **无午休** → 北京 08:00–14:30
 *
 * ⚠️ 韩股的「无午休」是用 `openPm = closeAm`、`closePm = closeAm` 表达的：
 * `sessionState` 里那个 `m < h.openPm` 分支于是永不成立，09:00–15:30 一路是 open。
 * 不要为了"整齐"给它编一个午休时段 —— 韩国 2016 年起就取消了午休。
 *
 * 于是北京 08:00–08:30 会出现「日韩已开盘、A 股港股都没开」，
 * 11:30–13:00 会出现「日股午休、A 股下午已开盘」这类交叉状态。
 */
export type SessionMarket = "CN" | "HK" | "JP" | "KR";

interface MarketHours {
  /** 相对 UTC 的分钟偏移 */
  offsetMin: number;
  openAm: number;
  closeAm: number;
  openPm: number;
  closePm: number;
}

const HOURS: Record<SessionMarket, MarketHours> = {
  CN: {
    offsetMin: 8 * 60,
    openAm: 9 * 60 + 30, // 09:30
    closeAm: 11 * 60 + 30, // 11:30
    openPm: 13 * 60, // 13:00
    closePm: 15 * 60, // 15:00
  },
  HK: {
    offsetMin: 8 * 60,
    openAm: 9 * 60 + 30, // 09:30
    closeAm: 12 * 60, // 12:00
    openPm: 13 * 60, // 13:00
    closePm: 16 * 60, // 16:00
  },
  JP: {
    offsetMin: 9 * 60,
    openAm: 9 * 60, // 09:00 JST（北京 08:00）
    closeAm: 11 * 60 + 30, // 11:30
    openPm: 12 * 60 + 30, // 12:30
    closePm: 15 * 60 + 30, // 15:30
  },
  KR: {
    offsetMin: 9 * 60,
    openAm: 9 * 60, // 09:00 KST（北京 08:00）
    // 无午休：开盘一路到 15:30，把三个"下午"字段都指到收盘
    closeAm: 15 * 60 + 30,
    openPm: 15 * 60 + 30,
    closePm: 15 * 60 + 30,
  },
};

/**
 * 判断当前处于哪个交易时段。
 * @param at 时刻，默认现在
 * @param calendar 该市场的交易日历（`YYYY-MM-DD` 数组，按**当地日期**编）。提供时可识别节假日。
 * @param market 市场，默认 A 股（老调用方不传也仍然是原来的行为）
 */
export function sessionState(
  at: Date = new Date(),
  calendar?: string[],
  market: SessionMarket = "CN",
): SessionState {
  const h = HOURS[market];
  const t = marketTime(at, h.offsetMin);
  // 日历过期时不能拿它判"非交易日"，否则每个新交易日都会被误判成 holiday
  const usable = isCalendarFresh(calendar, t.iso);

  if (usable && calendar) {
    if (!calendar.includes(t.iso)) {
      return t.dow === 0 || t.dow === 6 ? "weekend" : "holiday";
    }
  } else if (t.dow === 0 || t.dow === 6) {
    return "weekend";
  }

  const m = minutesOfDay(t);
  if (m < h.openAm) return "pre";
  if (m <= h.closeAm) return "open";
  if (m < h.openPm) return "lunch";
  if (m <= h.closePm) return "open";
  return "closed";
}

/** 是否处于连续竞价（唯一需要秒级轮询的时段） */
export function isTradingNow(
  at: Date = new Date(),
  calendar?: string[],
  market: SessionMarket = "CN",
): boolean {
  return sessionState(at, calendar, market) === "open";
}

/**
 * 距离下一次开盘的毫秒数。用于决定"多久之后再重新探测"，
 * 避免收盘后还在傻轮询。
 *
 * 全程用**该市场当地时间**做判断，返回的却是绝对的毫秒差 —— 所以调用方
 * （`useLiveQuotes`）把几个市场的结果取 `Math.min` 是正确的。
 */
export function msUntilNextOpen(
  at: Date = new Date(),
  calendar?: string[],
  market: SessionMarket = "CN",
): number {
  const h = HOURS[market];
  const t = marketTime(at, h.offsetMin);
  const m = minutesOfDay(t);

  if (sessionState(at, calendar, market) === "open") return 0;

  // 当天还没到开盘时间且今天是交易日 → 今天开盘
  const todayIsTrading = isCalendarFresh(calendar, t.iso) && calendar
    ? calendar.includes(t.iso)
    : t.dow !== 0 && t.dow !== 6;

  if (todayIsTrading && m < h.openAm) {
    return h.openAm * MIN - m * MIN;
  }
  // 午休 → 当天下午开盘（韩股没有午休，这个分支恒不成立）
  if (todayIsTrading && m >= h.closeAm && m < h.openPm) {
    return h.openPm * MIN - m * MIN;
  }

  // 否则找下一个交易日
  for (let i = 1; i <= 30; i += 1) {
    const probe = new Date(t.dayStartUtc + i * 24 * 3600_000 + 10 * 3600_000); // 次日 10:00 当地
    const pt = marketTime(probe, h.offsetMin);
    const isTrading = isCalendarFresh(calendar, pt.iso) && calendar
      ? calendar.includes(pt.iso)
      : pt.dow !== 0 && pt.dow !== 6;
    if (isTrading) {
      return pt.dayStartUtc + h.openAm * MIN - at.getTime();
    }
  }
  return 24 * 3600_000; // 兜底：一天后再看
}

export function sessionLabel(s: SessionState): string {
  switch (s) {
    case "pre":
      return "开盘前";
    case "open":
      return "交易中";
    case "lunch":
      return "午间休市";
    case "closed":
      return "已收盘";
    case "weekend":
      return "周末休市";
    case "holiday":
      return "休市";
  }
}
