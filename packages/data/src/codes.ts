/**
 * 代码格式转换。
 *
 * 本项目内部统一使用 `600519.SH` 形式（沿用快照格式）。
 * 各数据源的代码格式差异都在这里收口，不要散落到 provider 里。
 */

/** `600519.SH` → `{ num: "600519", market: "SH" }` */
export function parseCode(code: string): { num: string; market: "SH" | "SZ" | "BJ" } | null {
  const m = /^(\d{6})\.(SH|SZ|BJ)$/i.exec(code.trim());
  if (!m) return null;
  return { num: m[1], market: m[2].toUpperCase() as "SH" | "SZ" | "BJ" };
}

/** `600519.SH` → 东方财富 secid `1.600519`（1=沪, 0=深） */
export function toEastmoneySecid(code: string): string | null {
  const p = parseCode(code);
  if (!p) return null;
  const prefix = p.market === "SH" ? "1" : "0";
  return `${prefix}.${p.num}`;
}

/** 东方财富 `f13` 市场标志 + `f12` 代码 → 内部代码 */
export function fromEastmoney(f12: string, f13: number | string): string {
  return `${f12}.${String(f13) === "1" ? "SH" : "SZ"}`;
}

/** `600519.SH` → 腾讯 symbol `sh600519` */
export function toTencentSymbol(code: string): string | null {
  const p = parseCode(code);
  if (!p) return null;
  return `${p.market.toLowerCase()}${p.num}`;
}

/** 腾讯 symbol `sh600519` → 内部代码 `600519.SH` */
export function fromTencentSymbol(symbol: string): string {
  const m = /^(sh|sz|bj)(\d{6})$/i.exec(symbol.trim());
  if (!m) return symbol;
  return `${m[2]}.${m[1].toUpperCase()}`;
}

/** 把数组切成固定大小的块，用于批量请求 */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
