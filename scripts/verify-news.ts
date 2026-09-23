/**
 * 新闻链实测（真实发请求，**模拟浏览器跨域场景**）。
 *
 * ⚠️ 这个脚本存在的理由（一次真实教训）：
 *
 * 初版 `news.ts` 只用了东财，我用 Node 的 `fetch()` 测出 7/7 通过就上线了。
 * 但 Node 的 fetch **不发 Origin / Referer**，而浏览器的跨域请求会发。
 * 东财对第三方 Origin 直接返回反爬页（HTTP 567），
 * 所以在真实站点上新闻功能是坏的 —— 测试却全绿。
 *
 * 因此这里必须显式带上 Origin 与 Referer，模拟部署后的真实环境。
 *
 *   npx vite-node scripts/verify-news.ts
 */
import {
  eastmoneyNewsProvider,
  fetchLatestNews,
  matchNewsToStock,
  tonghuashunNewsProvider,
  type NewsProvider,
} from "../packages/data/src/news";

/** 部署后的真实来源，浏览器会把它放进 Origin 与 Referer */
const SITE = "https://l022117738907793-sys.github.io";

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  Origin: SITE,
  Referer: `${SITE}/`,
};

let pass = 0;
let fail = 0;
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string) => { fail++; console.log(`  ✗ ${m}`); };

/**
 * 注入浏览器头，让被测 provider 走真实浏览器的那条路。
 * 改全局是刻意的 —— 被测代码本身不该知道"测试模式"。
 */
function installBrowserFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    original(input, {
      ...init,
      headers: { ...BROWSER_HEADERS, ...(init?.headers as Record<string, string> | undefined) },
    })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function probe(label: string, p: NewsProvider) {
  console.log(`\n【单独测试】${label}`);
  if (!p.isSupported()) {
    console.log("    （当前环境不支持）");
    return;
  }
  try {
    const items = await p.fetchLatest(5);
    if (items.length === 0) {
      bad(`${label}: 返回空`);
      return;
    }
    ok(`${label}: ${items.length} 条`);
    for (const n of items.slice(0, 3)) {
      const t = n.timeKnown
        ? new Date(n.at).toISOString().replace("T", " ").slice(0, 16) + "Z"
        : "时间未知";
      console.log(`      · [${t}] ${n.title.slice(0, 48)}`);
    }
    items.every((n) => n.title.length > 0) ? ok("标题均非空") : bad("存在空标题");
    items.every((n) => n.timeKnown) ? ok("时间均解析成功") : bad("存在时间解析失败");
    items.every((n, i) => i === 0 || items[i - 1].at >= n.at) ? ok("按时间降序") : bad("排序不对");
  } catch (e) {
    bad(`${label}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  console.log(`\n模拟浏览器跨域场景（Origin: ${SITE}）`);

  const restore = installBrowserFetch();
  try {
    await probe("同花顺快讯（主力）", tonghuashunNewsProvider);
    // 东财对第三方 Origin 返回反爬页，失败属预期；不计入失败数
    const before = fail;
    await probe("东财 7x24（兜底，预期失败）", eastmoneyNewsProvider);
    if (fail > before) {
      fail = before;
      console.log("      （东财失败属预期：它被反爬拦截，仅作兜底保留）");
    }
  } finally {
    restore();
  }

  console.log("\n【整链】fetchLatestNews（带浏览器头）");
  const restore2 = installBrowserFetch();
  let r;
  try {
    r = await fetchLatestNews(10);
  } finally {
    restore2();
  }
  console.log(`    生效来源: ${r.source ?? "无"}`);
  console.log(`    条数: ${r.items.length}`);
  console.log(`    降级说明: ${r.degradedReason ?? "无"}`);
  if (r.items.length > 0) {
    ok(`链路可用，来源 ${r.source}`);
    const newest = Math.max(...r.items.map((x) => x.at));
    const ageH = (Date.now() - newest) / 3600_000;
    ageH < 48
      ? ok(`新闻足够新（最新一条 ${ageH.toFixed(1)} 小时前）`)
      : bad(`新闻偏旧（${ageH.toFixed(0)}h）`);
  } else {
    bad("链路无可用来源 —— 浏览器里会显示「暂时没有取到新闻」");
  }

  console.log("\n【关键词匹配】只筛相关，不判断利好利空");
  const fake = [
    { id: "1", title: "贵州茅台发布半年报", digest: "", at: Date.now(), source: "t", timeKnown: true },
    { id: "2", title: "完全无关的新闻", digest: "", at: Date.now(), source: "t", timeKnown: true },
    { id: "3", title: "600519 获北向资金增持", digest: "", at: Date.now(), source: "t", timeKnown: true },
  ];
  const hit = matchNewsToStock(fake, "贵州茅台", "600519.SH");
  hit.length === 2 ? ok("按名称与代码都能匹配") : bad(`期望 2 条，得到 ${hit.length}`);

  console.log(`\n════════ 结果：${pass} 通过 / ${fail} 失败 ════════`);
  console.log(
    fail === 0
      ? "\n✅ 全部通过 —— 浏览器里可以正常取到新闻\n"
      : "\n⚠️ 有失败项，浏览器里可能取不到新闻\n",
  );
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("脚本异常：", e);
  process.exitCode = 1;
});
