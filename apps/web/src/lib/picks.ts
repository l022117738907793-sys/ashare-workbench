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

import { marketGroupOf, type MarketGroup } from "@aw/game";
import type { Currency } from "@aw/core";

export type PickKey = "up" | "down" | "hot";

export const PICK_KEYS: PickKey[] = ["up", "down", "hot"];

export const PICK_LABEL: Record<PickKey, string> = {
  up: "涨得最猛",
  down: "跌得最狠",
  hot: "成交最热",
};

/** 市场胶囊的固定顺序。与「市场观察」的 `MARKET_ORDER` 一致 —— 同一个概念不摆两种次序。 */
export const PICK_MARKET_ORDER: readonly MarketGroup[] = ["CN", "HK", "US", "JP", "KR"];

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
 * 每个**桶**最多进榜几只。
 *
 * 直接取全市场前 8 只，很可能 8 只全在同一个最热的行业里，玩家就看不到别的板块了。
 * 先按桶摊开再合并，榜单才真的是「各桶里动得最大的那些」。
 *
 * 桶怎么分见 `bucketOf`。
 */
export const PICK_PER_SECTOR = 2;

/**
 * 一只票属于哪个「桶」：**A 股按申万行业，境外按市场**。
 *
 * 境外标的的 `industry` 字段就是市场名（「港股」/「日股」/「韩股」），那不是行业 ——
 * 照搬当行业用，等于给每个境外市场造了一个假的行业桶（而且境外我们本来就没有行业
 * 数据，编一个比不分类更糟）。按代码推市场是唯一的真相来源。
 *
 * 注意：**分桶解决不了境外的可见性**。摊开只保证每个桶都能进候选，不保证进最终 8 名 ——
 * 港股 20 只抵不过 A 股 31 个行业 62 个候选，全市场「涨得最猛」的前 8 里照样可以
 * 一只港股都没有。要看见港股，得先把池子缩到港股（见 `pickMarkets` 与 StockPicker
 * 的市场那一排）。这里分桶的作用是：筛到某个境外市场时它是**唯一的桶**，
 * `pickCandidates` 于是不再摊开（否则 20 只会被砍到 2 只）。
 */
function bucketOf(s: PickStock): string {
  const m = marketGroupOf(s.code);
  if (m !== "CN") return m;
  return s.sector || "未分类";
}

/** 这一批候选里出现了哪些市场。按 `PICK_MARKET_ORDER` 排序，只出现在池子里的才返回。 */
export function pickMarkets(rows: PickStock[]): MarketGroup[] {
  const seen = new Set<MarketGroup>();
  for (const r of rows) seen.add(marketGroupOf(r.code));
  return PICK_MARKET_ORDER.filter((m) => seen.has(m));
}

/** 这个排序键下，一只股票的分数。取不到就是 null（不参与排序）。 */
export function pickScore(s: PickStock, key: PickKey): number | null {
  if (key === "hot") return s.amount !== null && s.amount > 0 ? s.amount : null;
  if (s.changePct === null) return null;
  return key === "up" ? s.changePct : -s.changePct;
}

/**
 * 候选榜单：每个桶先取分数最高的 `perSector` 只，再从这些里挑总分最高的 `limit` 只。
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
    const k = bucketOf(x.r);
    const arr = bySector.get(k);
    if (arr) arr.push(x);
    else bySector.set(k, [x]);
  }

  /*
   * 只有一个桶时不摊开。
   *
   * 摊开的本意是「别让 8 只全挤在同一个行业里」。桶只有一个的时候
   * （比如筛到港股，20 只全在一个桶里）它剩下的唯一效果就是**截断**：
   * 榜单从 20 只被砍到 2 只，而玩家明明刚点了「只看港股」。
   */
  const oneBucket = bySector.size <= 1;
  const best: Array<{ r: PickStock; v: number }> = [];
  for (const arr of bySector.values()) {
    arr.sort((a, b) => b.v - a.v || a.r.code.localeCompare(b.r.code));
    best.push(...(oneBucket ? arr : arr.slice(0, perSector)));
  }

  best.sort((a, b) => b.v - a.v || a.r.code.localeCompare(b.r.code));
  return best.slice(0, limit).map((x) => x.r);
}

/**
 * 全量名册：同一个排序键下的**全部**标的，不摊桶、不截断。
 *
 * 与 `pickCandidates` 是两种东西，缺一不可：
 * - `pickCandidates` 是「不知道买什么」的短名单 —— 每桶 2 只、总共 8 只。
 * - 这个是「我自己找」的完整名册。
 *
 * 为什么必须有：市场那一排胶囊写着「全部 150」，清单往下却只有 8 行。玩家
 * 看到的是一个对不上的数字，会以为数据丢了或者自己没滚到底 —— 而它俩其实
 * 说的是两件事（池子有多大 / 榜单有多长）。把名册摆出来，这个数字才有着落。
 *
 * 取不到分数的（当天没有价格）不进名册：摆一个没有价格的按钮，点了也没用。
 */
export function pickAll(rows: PickStock[], key: PickKey): PickStock[] {
  const scored: Array<{ r: PickStock; v: number }> = [];
  for (const r of rows) {
    const v = pickScore(r, key);
    if (v !== null) scored.push({ r, v });
  }
  scored.sort((a, b) => b.v - a.v || a.r.code.localeCompare(b.r.code));
  return scored.map((x) => x.r);
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
 *
 * **默认不截断**：调用方要显示几条由它自己 `slice`。以前这里写死 20，
 * 界面就照着 20 说「匹配到 20 只」—— 打一个「6」明明命中四百多只。
 * 上限是显示问题，不该藏在搜索里，否则调用方永远说不出那个真实的数字。
 */
export function searchStocks(rows: PickStock[], query: string, limit = Infinity): PickStock[] {
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
