/**
 * A 股交易时段判断（北京时间）。
 *
 * 用 UTC+8 显式换算，不依赖运行机器的本地时区——用户可能在任何时区打开页面。
 * 节假日判断优先用快照里的交易日历（`calendar.json`）；没有日历时只能按周末粗判。
 */

export type SessionState =
  | "pre" // 开盘前（含集合竞价）
  | "open" // 连续竞价中
  | "lunch" // 午间休市
  | "closed" // 已收盘
  | "weekend" // 周末
  | "holiday"; // 非交易日（由交易日历判定）

export interface BeijingTime {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
  dow: number; // 0=周日
  /** `YYYY-MM-DD` */
  iso: string;
  /** 北京时间的当日零点对应的 UTC 毫秒 */
  dayStartUtc: number;
}

/** 把任意时刻换算成北京时间的各字段 */
export function beijingTime(at: Date = new Date()): BeijingTime {
  // 先得到真正的 UTC 毫秒，再整体 +8h，然后用 getUTC* 读出来
  const bj = new Date(at.getTime() + 8 * 3600_000);
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
    dayStartUtc: Date.UTC(y, mo - 1, d) - 8 * 3600_000,
  };
}

const MIN = 60_000;
/** 北京时间分钟数 */
function minutesOfDay(t: BeijingTime): number {
  return t.h * 60 + t.mi;
}

const OPEN_AM = 9 * 60 + 30; // 09:30
const CLOSE_AM = 11 * 60 + 30; // 11:30
const OPEN_PM = 13 * 60; // 13:00
const CLOSE_PM = 15 * 60; // 15:00

/**
 * 判断当前处于哪个交易时段。
 * @param at 时刻，默认现在
 * @param calendar 快照里的交易日历（`YYYY-MM-DD` 数组）。提供时可识别节假日。
 */
export function sessionState(at: Date = new Date(), calendar?: string[]): SessionState {
  const t = beijingTime(at);

  if (calendar && calendar.length > 0) {
    if (!calendar.includes(t.iso)) {
      return t.dow === 0 || t.dow === 6 ? "weekend" : "holiday";
    }
  } else if (t.dow === 0 || t.dow === 6) {
    return "weekend";
  }

  const m = minutesOfDay(t);
  if (m < OPEN_AM) return "pre";
  if (m <= CLOSE_AM) return "open";
  if (m < OPEN_PM) return "lunch";
  if (m <= CLOSE_PM) return "open";
  return "closed";
}

/** 是否处于连续竞价（唯一需要秒级轮询的时段） */
export function isTradingNow(at: Date = new Date(), calendar?: string[]): boolean {
  return sessionState(at, calendar) === "open";
}

/**
 * 距离下一次开盘的毫秒数。用于决定"多久之后再重新探测"，
 * 避免收盘后还在傻轮询。
 */
export function msUntilNextOpen(at: Date = new Date(), calendar?: string[]): number {
  const t = beijingTime(at);
  const m = minutesOfDay(t);

  if (sessionState(at, calendar) === "open") return 0;

  // 当天还没到 09:30 且今天是交易日 → 今天开盘
  const todayIsTrading = calendar && calendar.length > 0
    ? calendar.includes(t.iso)
    : t.dow !== 0 && t.dow !== 6;

  if (todayIsTrading && m < OPEN_AM) {
    return OPEN_AM * MIN - m * MIN;
  }
  // 午休 → 当天下午开盘
  if (todayIsTrading && m >= CLOSE_AM && m < OPEN_PM) {
    return OPEN_PM * MIN - m * MIN;
  }

  // 否则找下一个交易日
  for (let i = 1; i <= 30; i += 1) {
    const probe = new Date(t.dayStartUtc + i * 24 * 3600_000 + 10 * 3600_000); // 次日 10:00 北京
    const pt = beijingTime(probe);
    const isTrading = calendar && calendar.length > 0
      ? calendar.includes(pt.iso)
      : pt.dow !== 0 && pt.dow !== 6;
    if (isTrading) {
      return pt.dayStartUtc + OPEN_AM * MIN - at.getTime();
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
