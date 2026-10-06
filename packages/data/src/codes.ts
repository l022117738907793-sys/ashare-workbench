/**
 * 代码格式转换。
 *
 * 本项目内部统一使用 `600519.SH` 形式（沿用快照格式）；境外标的是 `00700.HK`、`AAPL.US`。
 * 各数据源的代码格式差异都在这里收口，不要散落到 provider 里。
 *
 * 这里**只管格式，不管规则**。港股 T+0、美股没有涨跌停这类事在 `@game/rules` 里，
 * 因为那要跟着成交日期变；而代码长什么样永远不变。
 */

/** 交易所后缀。前三个是 A 股，后两个是境外。 */
export type Market = "SH" | "SZ" | "BJ" | "HK" | "US";

/** 规则意义上的市场。同一套交易规则共用一个值，跟交易所不是一回事。 */
export type MarketGroup = "CN" | "HK" | "US";

/** 计价货币。 */
export type Currency = "CNY" | "HKD" | "USD";

/** A 股：6 位数字。港股：4–5 位数字（腾讯是 00700，长实是 01113）。美股：字母，可带 `.` 或 `-`（BRK.B、RDS-A）。 */
const PATTERNS: Array<{ re: RegExp; market: Market }> = [
  { re: /^(\d{6})\.(SH|SZ|BJ)$/i, market: "SH" },
  { re: /^(\d{4,5})\.HK$/i, market: "HK" },
  { re: /^([A-Z][A-Z0-9.\-]{0,9})\.US$/i, market: "US" },
];

/** `600519.SH` → `{ num: "600519", market: "SH" }`；`00700.HK` / `AAPL.US` 同理。认不出返回 null。 */
export function parseCode(code: string): { num: string; market: Market } | null {
  const trimmed = code.trim();
  for (const { re, market } of PATTERNS) {
    const m = re.exec(trimmed);
    if (!m) continue;
    // A 股那条的 market 在捕获组里（SH/SZ/BJ 三种），境外的两条写死在表上
    const actual = market === "SH" ? (m[2].toUpperCase() as Market) : market;
    const num = market === "US" ? m[1].toUpperCase() : m[1];
    return { num, market: actual };
  }
  return null;
}

/** 交易所 → 规则分组。SH/SZ/BJ 共用 A 股那一套。 */
export function marketGroupOf(market: Market): MarketGroup {
  return market === "SH" || market === "SZ" || market === "BJ" ? "CN" : market;
}

/** 代码 → 规则分组。认不出的按 A 股算 —— 池子里绝大多数是 A 股，猜错的代价最小。 */
export function groupOfCode(code: string): MarketGroup {
  const p = parseCode(code);
  return p ? marketGroupOf(p.market) : "CN";
}

/** 代码 → 计价货币。 */
export function currencyOf(code: string): Currency {
  const p = parseCode(code);
  if (!p) return "CNY";
  if (p.market === "HK") return "HKD";
  if (p.market === "US") return "USD";
  return "CNY";
}

/**
 * `600519.SH` → 东方财富 secid。
 * A 股：`1.600519`（1=沪, 0=深/北）；港股：`116.00700`。
 *
 * **美股返回 null。** 东财把美股拆成 105(纳斯达克) / 106(纽交所) / 107(美交所) 三段，
 * 光看 `AAPL.US` 判断不出在哪一段 —— 非要猜就得维护一张交易所表。
 * 硬编码一个错的 secid 不如不返回：调用方会退到腾讯源，那里 `usAAPL` 不分交易所。
 */
export function toEastmoneySecid(code: string): string | null {
  const p = parseCode(code);
  if (!p) return null;
  if (p.market === "HK") return `116.${p.num}`;
  if (p.market === "US") return null;
  const prefix = p.market === "SH" ? "1" : "0";
  return `${prefix}.${p.num}`;
}

/** 东方财富 `f13` 市场标志 + `f12` 代码 → 内部代码。 */
export function fromEastmoney(f12: string, f13: number | string): string {
  const flag = String(f13);
  if (flag === "116") return `${f12}.HK`;
  // 105/106/107 都是美股，但我们分不出具体交易所，统一记成 .US
  if (flag === "105" || flag === "106" || flag === "107") return `${f12.toUpperCase()}.US`;
  return `${f12}.${flag === "1" ? "SH" : "SZ"}`;
}

/** `600519.SH` → 腾讯 symbol。A 股 `sh600519`，港股 `hk00700`，美股 `usAAPL`。 */
export function toTencentSymbol(code: string): string | null {
  const p = parseCode(code);
  if (!p) return null;
  if (p.market === "US") return `us${p.num}`;
  return `${p.market.toLowerCase()}${p.num}`;
}

/** 腾讯 symbol → 内部代码。`sh600519` / `hk00700` / `usAAPL`。 */
export function fromTencentSymbol(symbol: string): string {
  const s = symbol.trim();
  const cn = /^(sh|sz|bj)(\d{6})$/i.exec(s);
  if (cn) return `${cn[2]}.${cn[1].toUpperCase()}`;
  const hk = /^hk(\d{4,5})$/i.exec(s);
  if (hk) return `${hk[1]}.HK`;
  const us = /^us([A-Z][A-Z0-9.\-]{0,9})$/i.exec(s);
  if (us) return `${us[1].toUpperCase()}.US`;
  return symbol;
}

/** 把数组切成固定大小的块，用于批量请求 */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
