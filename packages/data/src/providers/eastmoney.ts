/**
 * 东方财富实时行情 provider。
 *
 * 实测（2026-09-23）：`push2.eastmoney.com` 的 `ulist.np/get`
 * 返回 `Access-Control-Allow-Origin: <回显 Origin>`，浏览器可直连。
 *
 * 注意：同域的 `push2his`（K线）在连续约 10 次请求后会空回复（HTTP 000），
 * 因此本文件**只做实时报价**，不请求 K 线。详见 docs/data-sources.md。
 */
import { chunk, fromEastmoney, toEastmoneySecid } from "../codes";
import type { Quote, QuoteProvider } from "../types";

const BASE = "https://push2.eastmoney.com/api/qt/ulist.np/get";
const UT = "fa5fd1943c7b386f172d6893dbfba10b";
/** 单次请求的代码数上限。实测 50 稳定；调大风险自负。 */
const BATCH = 20;

interface EmRow {
  f2?: number | string;
  f3?: number | string;
  f4?: number | string;
  f6?: number | string;
  f12?: string;
  f13?: number | string;
  f14?: string;
}

/**
 * 把东财的数值字段转成 number|null。
 * `fltt=2` 时缺失值会返回字符串 `"-"`，不能直接当数字用。
 */
function num(v: number | string | undefined): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = v.trim();
  if (t === "" || t === "-" || t === "--") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export const eastmoneyProvider: QuoteProvider = {
  name: "eastmoney",

  isSupported() {
    return typeof fetch === "function";
  },

  async fetchQuotes(codes: string[]): Promise<Quote[]> {
    const valid = codes
      .map((c) => ({ code: c, secid: toEastmoneySecid(c) }))
      .filter((x): x is { code: string; secid: string } => x.secid !== null);
    if (valid.length === 0) return [];

    const bySecid = new Map(valid.map((x) => [x.secid, x.code]));
    const out: Quote[] = [];
    const now = Date.now();

    for (const group of chunk([...bySecid.keys()], BATCH)) {
      const url =
        `${BASE}?fltt=2&invt=2&np=1&secids=${group.join(",")}` +
        `&fields=f2,f3,f4,f6,f12,f13,f14&ut=${UT}`;

      const res = await fetch(url);
      if (!res.ok) throw new Error(`东方财富 HTTP ${res.status}`);

      const json = (await res.json()) as {
        rc?: number;
        data?: { diff?: EmRow[] | Record<string, EmRow> } | null;
      };
      if (json.rc !== 0) throw new Error(`东方财富返回 rc=${json.rc}`);

      const diff = json.data?.diff;
      if (!diff) continue; // 整批无数据，跳过而不是整体失败
      const rows: EmRow[] = Array.isArray(diff) ? diff : Object.values(diff);

      for (const row of rows) {
        if (!row.f12) continue;
        const code = bySecid.get(`${String(row.f13)}.${row.f12}`) ?? fromEastmoney(row.f12, row.f13 ?? 0);
        out.push({
          code,
          name: row.f14 ?? code,
          price: num(row.f2),
          changePct: num(row.f3),
          change: num(row.f4),
          amount: num(row.f6),
          asOf: now,
          source: "eastmoney",
        });
      }
    }
    return out;
  },
};
