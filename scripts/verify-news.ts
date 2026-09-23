/**
 * 新闻链实测（真实发请求）。
 *
 *   npx vite-node scripts/verify-news.ts
 */
import { fetchLatestNews, matchNewsToStock, eastmoneyNewsProvider } from "../packages/data/src/news";

let pass = 0, fail = 0;
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string) => { fail++; console.log(`  ✗ ${m}`); };

async function main() {
  console.log("\n[1] 供应商可用性");
  console.log(`    ${eastmoneyNewsProvider.name} isSupported = ${eastmoneyNewsProvider.isSupported()}`);
  ok("isSupported 无异常");

  console.log("\n[2] 拉取最新新闻");
  const r = await fetchLatestNews(10);
  console.log(`    来源: ${r.source ?? "无"}`);
  console.log(`    条数: ${r.items.length}`);
  console.log(`    降级: ${r.degradedReason ?? "无"}`);
  if (r.items.length === 0) {
    bad(`未取到新闻（${r.degradedReason}）`);
  } else {
    ok(`取到 ${r.items.length} 条`);
    for (const n of r.items.slice(0, 5)) {
      const t = n.timeKnown ? new Date(n.at).toISOString().replace("T", " ").slice(0, 16) + "Z" : "时间未知";
      console.log(`      · [${t}] ${n.title.slice(0, 46)}`);
    }
    r.items.every((n) => n.title.length > 0) ? ok("标题均非空") : bad("存在空标题");
    r.items.every((n) => n.timeKnown) ? ok("时间均解析成功") : bad("存在时间解析失败");
    r.items.every((n, i) => i === 0 || r.items[i - 1].at >= n.at) ? ok("按时间降序") : bad("排序不对");
    const sorted = [...r.items].sort((a, b) => b.at - a.at);
    const newest = sorted[0];
    const ageH = (Date.now() - newest.at) / 3600_000;
    console.log(`    最新一条距今 ${ageH.toFixed(1)} 小时`);
    ageH < 48 ? ok("新闻足够新（<48h）") : bad(`新闻偏旧（${ageH.toFixed(0)}h）`);
  }

  console.log("\n[3] 关键词匹配（不判断利好利空，只筛相关）");
  const fake = [
    { id: "1", title: "贵州茅台发布半年报", digest: "", at: Date.now(), source: "t", timeKnown: true },
    { id: "2", title: "某公司公告", digest: "", at: Date.now(), source: "t", timeKnown: true },
    { id: "3", title: "600519 获北向资金增持", digest: "", at: Date.now(), source: "t", timeKnown: true },
  ];
  const hit = matchNewsToStock(fake, "贵州茅台", "600519.SH");
  console.log(`    命中 ${hit.length} 条: ${hit.map((h) => h.id).join(", ")}`);
  hit.length === 2 ? ok("按名称与代码都能匹配") : bad(`期望 2 条，得到 ${hit.length}`);

  console.log(`\n════════ 结果：${pass} 通过 / ${fail} 失败 ════════`);
  if (fail > 0) process.exitCode = 1;
}
main().catch((e) => { console.error("脚本异常：", e); process.exitCode = 1; });
