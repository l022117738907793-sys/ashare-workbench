/**
 * 代码格式转换。
 *
 * 本项目内部统一使用 `600519.SH` 形式（沿用快照格式）；境外标的是 `00700.HK`、`AAPL.US`、
 * `7203.JP`（东京）、`005930.KR`（韩国，KOSPI 与 KOSDAQ 不区分）。
 * 各数据源的代码格式差异都在这里收口，不要散落到 provider 里。
 *
 * 这里**只管格式，不管规则**。港股 T+0、美股没有涨跌停这类事在 `@game/rules` 里，
 * 因为那要跟着成交日期变；而代码长什么样永远不变。
 */

/** 交易所后缀。前三个是 A 股，后面几个是境外。 */
export type Market = "SH" | "SZ" | "BJ" | "HK" | "US" | "JP" | "KR";

/** 规则意义上的市场。同一套交易规则共用一个值，跟交易所不是一回事。 */
export type MarketGroup = "CN" | "HK" | "US" | "JP" | "KR";

/** 计价货币。 */
export type Currency = "CNY" | "HKD" | "USD" | "JPY" | "KRW";

/**
 * A 股：6 位数字。港股：4–5 位数字（腾讯是 00700，长实是 01113）。美股：字母，可带 `.` 或 `-`（BRK.B、RDS-A）。
 * 日股：4 位数字（7203 丰田）。韩股：6 位数字（005930 三星电子）。
 *
 * **日韩都不区分交易所**（日本只有东交所一个主板；韩国 KOSPI/KOSDAQ 的证券交易税率 2026 年起已趋同，
 * 见 `@game/rules` 的 feeRulesAt），所以一个后缀就够，不像美股要拆三段。
 */
const PATTERNS: Array<{ re: RegExp; market: Market }> = [
  { re: /^(\d{6})\.(SH|SZ|BJ)$/i, market: "SH" },
  { re: /^(\d{4,5})\.HK$/i, market: "HK" },
  { re: /^(\d{4})\.JP$/i, market: "JP" },
  { re: /^(\d{6})\.KR$/i, market: "KR" },
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
  if (p.market === "JP") return "JPY";
  if (p.market === "KR") return "KRW";
  return "CNY";
}

/**
 * `600519.SH` → 东方财富 secid。
 * A 股：`1.600519`（1=沪, 0=深/北）；港股：`116.00700`；日股：`176.7203`；韩股：`177.005930`。
 *
 * 日韩的 176/177 不是猜的：东财搜索接口（`searchapi.eastmoney.com/api/suggest/get?type=14`）
 * 返回日股 `MktNum=176`、韩股 `MktNum=177`，两个后缀一一对应。
 *
 * **美股返回 null。** 东财把美股拆成 105(纳斯达克) / 106(纽交所) / 107(美交所) 三段，
 * 光看 `AAPL.US` 判断不出在哪一段 —— 非要猜就得维护一张交易所表。
 * 硬编码一个错的 secid 不如不返回：调用方会退到腾讯源，那里 `usAAPL` 不分交易所。
 */
export function toEastmoneySecid(code: string): string | null {
  const p = parseCode(code);
  if (!p) return null;
  if (p.market === "HK") return `116.${p.num}`;
  if (p.market === "JP") return `176.${p.num}`;
  if (p.market === "KR") return `177.${p.num}`;
  if (p.market === "US") return null;
  const prefix = p.market === "SH" ? "1" : "0";
  return `${prefix}.${p.num}`;
}

/** 东方财富 `f13` 市场标志 + `f12` 代码 → 内部代码。 */
export function fromEastmoney(f12: string, f13: number | string): string {
  const flag = String(f13);
  if (flag === "116") return `${f12}.HK`;
  if (flag === "176") return `${f12}.JP`;
  if (flag === "177") return `${f12}.KR`;
  // 105/106/107 都是美股，但我们分不出具体交易所，统一记成 .US
  if (flag === "105" || flag === "106" || flag === "107") return `${f12.toUpperCase()}.US`;
  return `${f12}.${flag === "1" ? "SH" : "SZ"}`;
}

/**
 * `600519.SH` → 腾讯 symbol。A 股 `sh600519`，港股 `hk00700`，美股 `usAAPL`，
 * 日股 `jp7203`，韩股 `kr005930`。
 *
 * 日韩这条能直接用是因为腾讯的实时报价接口确实认这两个前缀（实测 `q=jp7203,kr005930`
 * 有返回）。但**腾讯没有日韩的历史日线**（`kline/kline?param=jp7203,…` 只给 1 根），
 * 所以快照里的日韩日线得走东财，只有实时价能用腾讯。
 */
export function toTencentSymbol(code: string): string | null {
  const p = parseCode(code);
  if (!p) return null;
  if (p.market === "US") return `us${p.num}`;
  return `${p.market.toLowerCase()}${p.num}`;
}

/** 腾讯 symbol → 内部代码。`sh600519` / `hk00700` / `usAAPL` / `jp7203` / `kr005930`。 */
export function fromTencentSymbol(symbol: string): string {
  const s = symbol.trim();
  const cn = /^(sh|sz|bj)(\d{6})$/i.exec(s);
  if (cn) return `${cn[2]}.${cn[1].toUpperCase()}`;
  const hk = /^hk(\d{4,5})$/i.exec(s);
  if (hk) return `${hk[1]}.HK`;
  const jp = /^jp(\d{4})$/i.exec(s);
  if (jp) return `${jp[1]}.JP`;
  const kr = /^kr(\d{6})$/i.exec(s);
  if (kr) return `${kr[1]}.KR`;
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
