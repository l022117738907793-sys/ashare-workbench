/**
 * 「模拟下单」的候选清单。
 *
 * ## 为什么需要它
 *
 * 玩家是大学生不是股民。原来的下单框只有一个空输入框 + 浏览器的 `<datalist>`
 * 自动补全 —— 那个东西在 iOS Safari 里**根本不弹出**（Safari 至今不支持 datalist），
 * 桌面 Chrome 里点开也只是一列六位代码。结果是玩家盯着一个空白框，
 * 不知道能买什么，也不知道该从哪里找。
 *
 * 所以这里把「买什么」从填空题改成选择题：**每个板块挑出当天动得最大的几只**，
 * 再换几种问法排序。
 *
 * ## 一条底线
 *
 * 这是**陈述数据**，不是推荐。列表里出现某只票，只说明它今天的涨跌幅或成交额
 * 在它那个板块里排在前面，和「该不该买」没有任何关系 ——
 * 事实上「涨得最猛」那几张票往往正是最危险的。界面上必须把这句话写出来。
 */

import type { Currency } from "@aw/core";

export type PickKey = "up" | "down" | "hot";

export const PICK_KEYS: PickKey[] = ["up", "down", "hot"];

export const PICK_LABEL: Record<PickKey, string> = {
  up: "涨得最猛",
  down: "跌得最狠",
  hot: "成交最热",
};

/** 榜单下面那句免责说明。改文案要连着测试一起改。 */
export const PICK_CAVEAT = "只是把今天的数据摆出来，不是推荐，也不代表这些票值得买。";

export interface PickStock {
  code: string;
  name: string;
  /** 申万一级行业；取不到时为空串 */
  sector: string;
  price: number | null;
  /** 当日涨跌幅（百分数，-3.2 表示跌 3.2%） */
  changePct: number | null;
  /** 当日成交额（**人民币**，与 price 同口径），「成交最热」用它排序 */
  amount: number | null;
  /**
   * 这只票的**本币**币种，用于界面标注「原以港币计价」。
   *
   * 注意 `price` / `amount` 都已经是人民币了（快照和实时价各折一次）；
   * 这个字段只影响显示，不参与任何计算。缺省当人民币。
   */
  currency?: Currency;
  /** 引擎给这只票的分类。实时模式有，历史推演模式没有 */
  signal?: string | null;
}

export const PICK_LIMIT = 8;
/**
 * 每个板块最多进榜几只。
 *
 * 直接取全市场前 8 只，很可能 8 只全在同一个最热的行业里，玩家就看不到别的板块了。
 * 先按板块摊开再合并，榜单才真的是「各板块里动得最大的那些」。
 */
export const PICK_PER_SECTOR = 2;

/** 这个排序键下，一只股票的分数。取不到就是 null（不参与排序）。 */
export function pickScore(s: PickStock, key: PickKey): number | null {
  if (key === "hot") return s.amount !== null && s.amount > 0 ? s.amount : null;
  if (s.changePct === null) return null;
  return key === "up" ? s.changePct : -s.changePct;
}

/**
 * 候选榜单：每个板块先取分数最高的 `perSector` 只，再从这些里挑总分最高的 `limit` 只。
 *
 * 分数相同时按代码排序，保证**同样的输入必定得到同样的榜单** ——
 * 否则每次重渲染顺序都在跳，玩家会以为按钮在动。
 */
export function pickCandidates(
  rows: PickStock[],
  key: PickKey,
  opts: { limit?: number; perSector?: number } = {},
): PickStock[] {
  const limit = opts.limit ?? PICK_LIMIT;
  const perSector = opts.perSector ?? PICK_PER_SECTOR;

  const scored: Array<{ r: PickStock; v: number }> = [];
  for (const r of rows) {
    const v = pickScore(r, key);
    if (v !== null) scored.push({ r, v });
  }

  const bySector = new Map<string, Array<{ r: PickStock; v: number }>>();
  for (const x of scored) {
    const k = x.r.sector || "未分类";
    const arr = bySector.get(k);
    if (arr) arr.push(x);
    else bySector.set(k, [x]);
  }

  const best: Array<{ r: PickStock; v: number }> = [];
  for (const arr of bySector.values()) {
    arr.sort((a, b) => b.v - a.v || a.r.code.localeCompare(b.r.code));
    best.push(...arr.slice(0, perSector));
  }

  best.sort((a, b) => b.v - a.v || a.r.code.localeCompare(b.r.code));
  return best.slice(0, limit).map((x) => x.r);
}

/** 名字/代码里含查询词的排前面；能完整匹配代码的排最前。 */
function searchRank(s: PickStock, q: string, digits: string): number {
  if (s.code.toLowerCase() === q) return 0;
  if (digits.length > 0 && s.code.replace(/[^0-9]/g, "") === digits) return 1;
  if (s.name.toLowerCase() === q) return 2;
  if (s.name.toLowerCase().startsWith(q)) return 3;
  if (s.code.toLowerCase().startsWith(q)) return 4;
  return 5;
}

/**
 * 边打边筛。查询为空时返回空数组 —— 「没输入」和「输入了没匹配上」是两种
 * 完全不同的状态，调用方要能分开（前者显示榜单，后者显示「没找到」）。
 */
export function searchStocks(rows: PickStock[], query: string, limit = 20): PickStock[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const digits = q.replace(/[^0-9]/g, "");
  const hits = rows.filter((s) => {
    // 代码要打满两个字符才算数：只打一个「6」，六百多只票里一多半都含 6，
    // 那不是在筛选，是在刷屏。名字不受这条限制 —— 一个汉字本身就是有效线索。
    if (q.length >= 2 && s.code.toLowerCase().includes(q)) return true;
    if (s.name.toLowerCase().includes(q)) return true;
    // 只打了后几位数字也要能找到人（「519」→ 600519.SH）
    return digits.length >= 2 && s.code.replace(/[^0-9]/g, "").includes(digits);
  });
  hits.sort((a, b) => searchRank(a, q, digits) - searchRank(b, q, digits) || a.code.localeCompare(b.code));
  return hits.slice(0, limit);
}

/** 当日涨跌幅（百分数）。没有昨收或昨收为 0 时算不出来，返回 null。 */
export function changePctOf(price: number | null, prevClose: number | null): number | null {
  if (price === null || prevClose === null || prevClose === 0) return null;
  return (price / prevClose - 1) * 100;
}

/** 成交额 = 收盘价 × 成交量。拿不到就返回 null，不猜。 */
export function amountOf(price: number | null, volume: number | null): number | null {
  if (price === null || volume === null || volume <= 0) return null;
  return price * volume;
}

/** 成交额显示成「12.3 亿 / 4567 万」，直接写元的话小数点太多没法比。 */
export function fmtAmount(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)} 亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(0)} 万`;
  return String(Math.round(v));
}
