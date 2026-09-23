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
import { sessionState, sessionLabel, isTradingNow, msUntilNextOpen, beijingTime } from "../packages/data/src/session";

const CODES = ["600519.SH", "000001.SZ", "000300.SH", "300750.SZ"];
/** 用于判断解析是否合理的大致区间 */
const SANITY: Record<string, [number, number]> = {
  "600519.SH": [500, 3000],
  "000001.SZ": [5, 50],
  "000300.SH": [2000, 8000],
  "300750.SZ": [50, 600],
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
  console.log("\n[4] 交易时段判断");
  const st = sessionState();
  console.log(`    当前状态: ${st} (${sessionLabel(st)})`);
  console.log(`    是否盘中: ${isTradingNow()}`);
  console.log(`    距下次开盘: ${(msUntilNextOpen() / 60000).toFixed(1)} 分钟`);
  ok("交易时段计算无异常");

  console.log(`\n════════ 结果：${pass} 通过 / ${fail} 失败 ════════`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("脚本异常：", e);
  process.exitCode = 1;
});
