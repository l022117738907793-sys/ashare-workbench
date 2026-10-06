/**
 * 真实接口验证脚本（不打桩，实际发请求）。
 *
 * 单元测试用的都是假 provider，只验证了逻辑；这个脚本验证**真实数据源**是否可用、
 * 字段解析是否正确。上线前应手动跑一次：
 *
 *   npx vite-node scripts/verify-live.ts
 */
import { eastmoneyProvider } from "../packages/data/src/providers/eastmoney";
import { tencentProvider } from "../packages/data/src/providers/tencent";
import { fetchQuotes, sourceLabel } from "../packages/data/src/quotes";
import { sessionState, sessionLabel, isTradingNow, msUntilNextOpen, beijingTime, marketTime } from "../packages/data/src/session";
import { currencyOf, fromTencentSymbol, parseCode, toTencentSymbol } from "../packages/data/src/codes";

const CODES = [
  "600519.SH",
  "000001.SZ",
  "000300.SH",
  "300750.SZ",
  "00700.HK",
  "00939.HK",
  "7203.JP",
  "6758.JP",
  "005930.KR",
  "000660.KR",
];
/** 用于判断解析是否合理的大致区间 */
const SANITY: Record<string, [number, number]> = {
  "600519.SH": [500, 3000],
  "000001.SZ": [5, 50],
  "000300.SH": [2000, 8000],
  "300750.SZ": [50, 600],
  // 港股：价格是**港币**。provider 不做折算，折算在 snapshot / App 那一层
  "00700.HK": [100, 800],
  "00939.HK": [3, 30],
  // 日股是**日元**、韩股是**韩元**，同样不在这里折算。
  // 区间给得宽：股价本身会动，这里只用来抓「字段下标错了」这种量级错误。
  "7203.JP": [1000, 6000],
  "6758.JP": [1500, 9000],
  "005930.KR": [50000, 500000],
  "000660.KR": [300000, 3000000],
};

let pass = 0;
let fail = 0;
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string) => { fail++; console.log(`  ✗ ${m}`); };

async function main() {
  console.log(`\n验证时刻（北京）：${beijingTime().iso} ${beijingTime().h}:${String(beijingTime().mi).padStart(2, "0")}`);

  // ── 1. 腾讯 provider ────────────────────────────────────────────
  console.log("\n[1] 腾讯 qt.gtimg.cn（GBK 解码 + 字段下标）");
  console.log(`    环境支持: ${tencentProvider.isSupported()}`);
  try {
    const quotes = await tencentProvider.fetchQuotes(CODES);
    console.log(`    返回 ${quotes.length}/${CODES.length} 条`);
    for (const q of quotes) {
      console.log(
        `      ${q.code.padEnd(10)} ${String(q.name).padEnd(10)} 价=${String(q.price).padStart(9)} 涨跌幅=${String(q.changePct).padStart(7)}% 成交额=${q.amount === null ? "null" : (q.amount / 1e8).toFixed(2) + "亿"} 时间=${q.asOf ? new Date(q.asOf).toISOString() : "null"}`,
      );
    }
    quotes.length > 0 ? ok("返回非空") : bad("返回为空");
    quotes.every((q) => q.name && !q.name.includes("\uFFFD")) ? ok("GBK 解码正常（名称无乱码）") : bad("名称疑似乱码");

    for (const q of quotes) {
      const range = SANITY[q.code];
      if (!range || q.price === null) continue;
      q.price >= range[0] && q.price <= range[1]
        ? ok(`${q.code} 价格 ${q.price} 落在合理区间 [${range[0]}, ${range[1]}]`)
        : bad(`${q.code} 价格 ${q.price} 超出合理区间 [${range[0]}, ${range[1]}] —— 字段下标可能错了`);
    }
    const idx = quotes.find((q) => q.code === "000300.SH");
    if (idx) idx.changePct !== null ? ok("指数涨跌幅可解析") : bad("指数涨跌幅为 null");
  } catch (e) {
    bad(`腾讯 provider 抛错：${e instanceof Error ? e.message : e}`);
  }

  // ── 2. 东财 provider（预期被封锁）────────────────────────────────
  console.log("\n[2] 东方财富 push2（预期：本机 IP 被封锁）");
  try {
    const quotes = await eastmoneyProvider.fetchQuotes(CODES);
    quotes.length > 0 ? ok(`东财可用，返回 ${quotes.length} 条（封锁已解除）`) : bad("东财返回空");
  } catch (e) {
    console.log(`    （预期内）东财不可用：${e instanceof Error ? e.message : e}`);
    ok("东财失败被正确抛出，不会污染结果");
  }

  // ── 3. 降级链 ──────────────────────────────────────────────────
  console.log("\n[3] 降级链 fetchQuotes（腾讯优先 → 东财兜底）");
  try {
    const res = await fetchQuotes(CODES);
    console.log(`    生效来源: ${sourceLabel(res.source)} (${res.source})`);
    console.log(`    拿到 ${res.quotes.length} 条，缺失 ${res.missing.length} 条`);
    console.log(`    降级说明: ${res.degradedReason ?? "无"}`);
    res.quotes.length > 0 ? ok("链路返回数据") : bad("链路无数据");
    res.source === "tencent" ? ok("由腾讯提供服务（符合预期）") : bad(`生效来源是 ${res.source}，与预期不符`);
    res.missing.length === 0 ? ok("无缺失代码") : bad(`缺失：${res.missing.join(", ")}`);
  } catch (e) {
    bad(`链路整体失败：${e instanceof Error ? e.message : e}`);
  }

  // ── 4. 交易时段 ────────────────────────────────────────────────
  console.log("\n[4] 交易时段判断（四个市场各一套）");
  const st = sessionState();
  console.log(`    当前状态: ${st} (${sessionLabel(st)})`);
  console.log(`    是否盘中: ${isTradingNow()}`);
  console.log(`    距下次开盘: ${(msUntilNextOpen() / 60000).toFixed(1)} 分钟`);
  {
    /*
     * 日韩用的是 UTC+9，北京是 UTC+8 —— 东京 09:00 = 北京 08:00。
     * 这套换算错了不会报错，只会让「交易中」的绿点早一小时亮起来。
     * 用固定时刻比：北京 08:30 → 日韩已开盘（本地 09:30）、A 股还没开（09:30 差一小时）。
     */
    const at = new Date("2026-10-06T00:30:00Z"); // 北京 08:30 = 东京/首尔 09:30
    const cn = sessionState(at, undefined, "CN");
    const jp = sessionState(at, undefined, "JP");
    const kr = sessionState(at, undefined, "KR");
    console.log(`    北京 08:30 → A 股 ${cn} / 日股 ${jp} / 韩股 ${kr}`);
    cn === "pre" && jp === "open" && kr === "open"
      ? ok("08:30 日韩已开盘而 A 股还在盘前（UTC+9 偏移生效）")
      : bad(`08:30 的时段不对：CN=${cn} JP=${jp} KR=${kr}，预期 pre/open/open`);
    const t = marketTime(at, 540);
    t.h === 9 && t.mi === 30
      ? ok(`marketTime(北京 08:30, +540) = ${t.h}:${String(t.mi).padStart(2, "0")} 当地（东京/首尔）`)
      : bad(`marketTime 偏移不对：得到 ${t.h}:${t.mi}，预期 9:30`);
    // 首尔 09:00–15:30 **没有午休**，用 openPm = closeAm 表达。
    // 日股午休是 11:30–12:30 JST = 北京 10:30–11:30，所以取北京 11:00 比。
    const noon = new Date("2026-10-06T03:00:00Z"); // 北京 11:00 = 首尔/东京 12:00
    const krNoon = sessionState(noon, undefined, "KR");
    const jpNoon = sessionState(noon, undefined, "JP");
    console.log(`    北京 11:00 → 韩股 ${krNoon} / 日股 ${jpNoon}`);
    krNoon === "open" && jpNoon === "lunch"
      ? ok("11:00 韩股连续交易而日股午休（韩股无午休）")
      : bad(`11:00 的时段不对：KR=${krNoon} JP=${jpNoon}，预期 open/lunch`);
  }

  // ── 5. 港股（时段 / 成交额单位 / 时间戳格式）────────────────────
  console.log("\n[5] 港股：时段表、成交额单位、时间戳格式");
  {
    /*
     * 港股三项都容易错，且错了都不报错：
     *  ① 时段表 —— 港股 12:00 午休、16:00 收盘，与 A 股不是一套；
     *  ② 成交额 —— 腾讯给 A 股是**万元**、给港股是**元**，一律 ×10000 会让港股差 10⁴；
     *  ③ 时间戳 —— 港股是 `2026/10/06 16:08:08`（斜杠），原来只认 14 位纯数字 → 静默 null。
     * 用固定时刻比，避免「跑脚本时正好两边都收盘」导致看不出差别。
     */
    const at = new Date("2026-10-06T07:30:00Z"); // 北京 15:30：A 股已收盘、港股还在交易
    const cn = sessionState(at, undefined, "CN");
    const hk = sessionState(at, undefined, "HK");
    console.log(`    北京 15:30 → A 股 ${cn}（${sessionLabel(cn)}）/ 港股 ${hk}（${sessionLabel(hk)}）`);
    cn === "closed" && hk === "open"
      ? ok("15:30 港股仍在交易而 A 股已收盘（时段分表生效）")
      : bad(`15:30 的时段不对：CN=${cn} HK=${hk}，预期 closed/open`);

    try {
      const hkQuotes = await tencentProvider.fetchQuotes(["00700.HK", "00939.HK"]);
      const tx = hkQuotes.find((q) => q.code === "00700.HK");
      tx?.asOf
        ? ok(`港股时间戳可解析：${new Date(tx.asOf).toISOString()}`)
        : bad("港股时间戳解析为 null（斜杠格式没认出来？）");
      tx?.amount !== null && tx?.amount !== undefined && tx.amount > 1e8 && tx.amount < 1e11
        ? ok(`港股成交额量级正常：${(tx.amount / 1e8).toFixed(2)} 亿（元，未再 ×10000）`)
        : bad(`港股成交额量级可疑：${tx?.amount}，疑似按 A 股的「万元」又乘了 10000`);
      // A 股对照：同一时刻的成交额应仍是「万元 ×10000」的口径
      const cnQuotes = await tencentProvider.fetchQuotes(["600519.SH"]);
      const mt = cnQuotes.find((q) => q.code === "600519.SH");
      mt?.amount !== null && mt?.amount !== undefined && mt.amount > 1e8
        ? ok(`A 股成交额口径未变：${(mt.amount / 1e8).toFixed(2)} 亿`)
        : bad(`A 股成交额口径可疑：${mt?.amount}`);
    } catch (e) {
      bad(`港股取价失败：${e instanceof Error ? e.message : e}`);
    }
  }

  // ── 6. 日韩（代码换算 / 时间戳 / 成交额为空）─────────────────────
  console.log("\n[6] 日股与韩股：代码换算、时间戳格式、成交额字段");
  {
    /*
     * 腾讯的 `[2]` 给的是 `7203.T` / `005930.KS` / `247540.KQ`（带交易所后缀），
     * 内部格式没有后缀（`.JP` / `.KR`），所以来回换算必须自己走一遍。
     * 认不出来的代码会静默落回「A 股」，症状是「丰田按 A 股规则成交」且不报错。
     */
    const roundTrips: Array<[string, string]> = [
      ["7203.JP", "jp7203"],
      ["005930.KR", "kr005930"],
    ];
    for (const [code, sym] of roundTrips) {
      const got = toTencentSymbol(code);
      const back = fromTencentSymbol(sym);
      got === sym && back === code
        ? ok(`${code} ↔ ${sym} 来回换算一致`)
        : bad(`${code} ↔ ${sym} 换算不对：toTencentSymbol=${got} fromTencentSymbol=${back}`);
    }
    // 带交易所后缀的写法必须**认不出来**——认出来了就会把 `.T` 当成合法后缀
    (["7203.T", "005930.KS", "247540.KQ"] as const).every((c) => parseCode(c) === null)
      ? ok("带交易所后缀的写法不被接受（不会把 .T/.KS 当成内部格式）")
      : bad("`7203.T` 之类竟然被 parseCode 认下了，后缀解析过宽");
    currencyOf("7203.JP") === "JPY" && currencyOf("005930.KR") === "KRW"
      ? ok("币种推断正确：日股 → JPY、韩股 → KRW")
      : bad(`币种推断不对：${currencyOf("7203.JP")} / ${currencyOf("005930.KR")}`);

    try {
      const qs = await tencentProvider.fetchQuotes(["7203.JP", "005930.KR"]);
      console.log(`    返回 ${qs.length}/2 条`);
      for (const q of qs) {
        console.log(
          `      ${q.code.padEnd(10)} ${String(q.name).padEnd(20)} 价=${String(q.price).padStart(9)} 涨跌幅=${String(q.changePct).padStart(8)}% 成交额=${q.amount === null ? "null" : q.amount} 时间=${q.asOf ? new Date(q.asOf).toISOString() : "null"}`,
        );
      }
      qs.length === 2 ? ok("日韩都拿到了报价") : bad(`只拿到 ${qs.length}/2 条`);
      // 日韩的 [30] 是**北京时间**（东京 15:30 收 = 北京 14:30），格式 `YYYY-MM-DD HH:mm:ss`
      qs.every((q) => q.asOf !== null)
        ? ok("日韩时间戳可解析（短横线 + 空格格式）")
        : bad("日韩时间戳解析为 null");
      // 日韩 [37] 成交额为空（f[37..44] 全空），不该瞎估一个数出来
      qs.every((q) => q.amount === null)
        ? ok("日韩成交额为 null（腾讯这两个市场不给成交额，不猜）")
        : bad(`日韩成交额应为 null，实际 ${qs.map((q) => q.amount).join(", ")}`);
    } catch (e) {
      bad(`日韩取价失败：${e instanceof Error ? e.message : e}`);
    }
  }

  console.log(`\n════════ 结果：${pass} 通过 / ${fail} 失败 ════════`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("脚本异常：", e);
  process.exitCode = 1;
});
