/**
 * 腾讯行情实时 provider（降级用）。
 *
 * 实测（2026-09-23）：`qt.gtimg.cn` 返回 `Access-Control-Allow-Origin: *`，
 * 且**不需要 Referer**，浏览器可直连。
 *
 * 两个坑：
 * 1. 响应是 **GBK** 编码，必须用 `arrayBuffer()` + `TextDecoder("gbk")`，
 *    直接 `res.text()` 会乱码。
 * 2. 返回是 `v_sh600519="1~名称~代码~..."` 波浪号分隔，**没有官方文档**，
 *    字段位置见下方 FIELD 常量（实测 88 个字段）。
 */
import { chunk, fromTencentSymbol, groupOfCode, toTencentSymbol } from "../codes";
import type { Quote, QuoteProvider } from "../types";

const BASE = "https://qt.gtimg.cn/q=";
/** 单次请求上限。实测 30/60/100 都只返回 20 条，故固定 20。 */
const BATCH = 20;

/**
 * 实测字段下标。**改动前请重新实测**——这套下标是抓包数出来的，没有官方文档。
 *
 * - A 股（`sh600519`）：2026-09-23 实测 88 字段。
 * - 港股（`hk00700`）：2026-10-06 实测同为 88 字段，**同一套下标**，
 *   区别只在 `time` 的格式与 `amount` 的单位（见下）。
 * - 日股/韩股（`jp7203`、`kr005930`）：实测只有 72 字段，`amount` 是空的，
 *   且前 72 个字段里没有币种标识——暂不作为行情源。
 */
const FIELD = {
  name: 1,
  code: 2,
  price: 3,
  /** 时间戳。A 股是 `YYYYMMDDHHmmss`，港股是 `2026/10/06 16:08:08`——两种都要认。 */
  time: 30,
  change: 31,
  changePct: 32,
  /** 成交额。**A 股是「万元」，港股已经是「元」**——差别见 `amountOf()`。 */
  amount: 37,
} as const;

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const t = v.trim();
  if (t === "" || t === "-" || t === "--") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * 解析腾讯的时间戳，转成毫秒时间戳。**显式按 UTC+8 换算**，不依赖运行机器的本地时区。
 *
 * 两种格式都要认（2026-10-06 实测）：
 * - A 股：`20260923150000` → 14 位数字
 * - 港股：`2026/10/06 16:08:08` → 带斜杠与冒号
 *
 * 早先只按 14 位切，港股会被切成 `Number("/1") = NaN` 而**静默返回 null**
 * ——行情看着是好的，只是"更新时间"永远不显示，很难查。
 */
function parseBeijingTime(s: string | undefined): number | null {
  if (!s) return null;
  const t = s.trim();

  const parts = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})/.exec(t);
  let y: number, mo: number, d: number, h: number, mi: number, se: number;
  if (parts) {
    [y, mo, d, h, mi, se] = parts.slice(1, 7).map(Number);
  } else if (/^\d{14}$/.test(t)) {
    y = Number(t.slice(0, 4));
    mo = Number(t.slice(4, 6));
    d = Number(t.slice(6, 8));
    h = Number(t.slice(8, 10));
    mi = Number(t.slice(10, 12));
    se = Number(t.slice(12, 14));
  } else {
    return null;
  }

  if ([y, mo, d, h, mi, se].some((n) => !Number.isFinite(n))) return null;
  return Date.UTC(y, mo - 1, d, h - 8, mi, se);
}

/**
 * 成交额换算成「元」。
 *
 * **A 股与港股的单位不一样**（2026-10-06 实测，两侧都用「股数 × 价」对过账）：
 * - A 股：`600519` 给 `479725`，×10000 = 4.797e9 ≈ 3,833,100 股 × 1258.62 ✓
 * - 港股：`00700` 给 `4286181540.580`，也就是 **4.286e9 元，已经是元**
 *   ≈ 10,030,081 股 × 428.2 ✓（`00939`、`01810` 同样对得上）
 *
 * 所以港股**不能**再乘 10000——早先一律乘，港股成交额会大一万倍。
 */
function amountOf(code: string, raw: string | undefined): number | null {
  const v = num(raw);
  if (v === null) return null;
  return groupOfCode(code) === "CN" ? v * 10000 : v;
}

export const tencentProvider: QuoteProvider = {
  name: "tencent",

  isSupported() {
    if (typeof fetch !== "function") return false;
    // Safari 早期版本 / 某些环境没有 GBK 解码器
    try {
      new TextDecoder("gbk");
      return true;
    } catch {
      return false;
    }
  },

  async fetchQuotes(codes: string[]): Promise<Quote[]> {
    const symbols = codes
      .map((c) => toTencentSymbol(c))
      .filter((s): s is string => s !== null);
    if (symbols.length === 0) return [];

    const out: Quote[] = [];

    for (const group of chunk(symbols, BATCH)) {
      const res = await fetch(`${BASE}${group.join(",")}`);
      if (!res.ok) throw new Error(`腾讯行情 HTTP ${res.status}`);

      const buf = await res.arrayBuffer();
      const text = new TextDecoder("gbk").decode(buf);

      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        const varName = trimmed.slice(0, eq).replace(/^v_/, "");
        const payload = trimmed.slice(eq + 1).trim().replace(/;$/, "").replace(/^"/, "").replace(/"$/, "");
        const f = payload.split("~");
        if (f.length < 40) continue; // 停牌或无效代码返回极短串

        const code = fromTencentSymbol(varName);
        out.push({
          code,
          name: f[FIELD.name] || varName,
          price: num(f[FIELD.price]),
          changePct: num(f[FIELD.changePct]),
          change: num(f[FIELD.change]),
          amount: amountOf(code, f[FIELD.amount]),
          asOf: parseBeijingTime(f[FIELD.time]),
          source: "tencent",
        });
      }
    }
    return out;
  },
};
