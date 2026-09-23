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
import { chunk, fromTencentSymbol, toTencentSymbol } from "../codes";
import type { Quote, QuoteProvider } from "../types";

const BASE = "https://qt.gtimg.cn/q=";
/** 单次请求上限。实测 30/60/100 都只返回 20 条，故固定 20。 */
const BATCH = 20;

/** 实测字段下标（2026-09-23，88 字段）。改动前请重新实测。 */
const FIELD = {
  name: 1,
  code: 2,
  price: 3,
  /** 时间戳，格式 `YYYYMMDDHHmmss`，北京时间 */
  time: 30,
  change: 31,
  changePct: 32,
  /** 成交额，单位「万元」——已实测确认，需 ×10000 折算为元 */
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
 * 把腾讯的 `YYYYMMDDHHmmss`（北京时间）转成毫秒时间戳。
 * 显式按 UTC+8 换算，避免依赖运行机器的本地时区。
 */
function parseBeijingTime(s: string | undefined): number | null {
  if (!s || s.length < 14) return null;
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const h = Number(s.slice(8, 10));
  const mi = Number(s.slice(10, 12));
  const se = Number(s.slice(12, 14));
  if ([y, mo, d, h, mi, se].some((n) => !Number.isFinite(n))) return null;
  return Date.UTC(y, mo - 1, d, h - 8, mi, se);
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

        out.push({
          code: fromTencentSymbol(varName),
          name: f[FIELD.name] || varName,
          price: num(f[FIELD.price]),
          changePct: num(f[FIELD.changePct]),
          change: num(f[FIELD.change]),
          // 万元 → 元
          amount: (() => {
            const wan = num(f[FIELD.amount]);
            return wan === null ? null : wan * 10000;
          })(),
          asOf: parseBeijingTime(f[FIELD.time]),
          source: "tencent",
        });
      }
    }
    return out;
  },
};
