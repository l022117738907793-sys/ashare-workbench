/**
 * 对着**本地构建产物**点一遍「游戏页文案 + 市场观察的市场分档与分段展开」。
 *
 *   node packages/data/scripts/sync_web_data.mjs --keep 1 --trim-days 120
 *   npm run build -w apps/web
 *   npx vite-node scripts/e2e-workbench.ts
 *
 * 这一批改的全是「点下去才知道对不对」的东西：
 *   - 快进整块删掉之后，推进只剩「下一天」「结束」两个入口；
 *   - 市场观察的分档 chip 与「每次只放三个」的继续展开；
 *   - 章节 5 / 7 改了名。
 * 单测能证明 props 传对了、HTML 里字符串在，证明不了 tab 切换后真的渲染出来、
 * 点 chip 真的会重排列表 —— 所以还是得开浏览器。
 *
 * 断言里最容易写错的一条：**分档的数字是筛之前的**。点「港股」之后
 * 「全部市场 679」还得在，否则点进任何一个分档其它分档就消失了，人换不回去。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DIST = join(ROOT, "apps/web/dist");
const EDGE = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const PORT = 9228;
const CDP_PORT = 9229;
const BASE = `http://127.0.0.1:${PORT}/`;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(join(DIST, "index.html"))) {
  console.error("先构建：npm run build --workspace @aw/web");
  process.exit(1);
}
if (!existsSync(EDGE)) {
  console.error("没找到 Edge");
  process.exit(1);
}

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
  cwd: DIST,
  stdio: "ignore",
});
rmSync("/tmp/edge-e2e-workbench", { recursive: true, force: true });
const browser: ChildProcess = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${CDP_PORT}`,
    "--user-data-dir=/tmp/edge-e2e-workbench",
    "--no-first-run",
    "--window-size=1280,1400",
    "about:blank",
  ],
  { stdio: "ignore" },
);
function cleanup(): void {
  browser.kill("SIGKILL");
  server.kill("SIGKILL");
}
process.on("exit", cleanup);

let ws!: WebSocket;
let msgId = 0;
const pending = new Map<number, (v: unknown) => void>();
function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  msgId += 1;
  const id = msgId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate<T = unknown>(expr: string): Promise<T> {
  const res = (await send("Runtime.evaluate", {
    expression: `(() => { ${expr} })()`,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: T }; exceptionDetails?: { exception?: { description?: string } } };
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? "求值失败");
  return res.result?.value as T;
}
const CLICK = (text: string) => `
  const b = [...document.querySelectorAll("button")].find(x => x.textContent && x.textContent.includes(${JSON.stringify(text)}));
  if (!b) return "NOT_FOUND";
  b.click(); return "OK";
`;
/** 整页可见文本（去标签、压空白），用来查「某个词还在不在」 */
const TEXT = `
  return document.body.innerText.replace(/\\s+/g, " ");
`;
/** ③ 每条个股独有的标记：顶上「交易信号」摘要用的是同一套行样式，会一起数进去 */
const ROWS = `
  return (document.body.innerHTML.match(/打开七步分析/g) ?? []).length;
`;
/** ③ 渲染出来的个股行文本（只取带「打开七步分析」的那些，见 ROWS 的说明） */
const STOCK_ROWS = `
  return [...document.querySelectorAll("button.row-tap")]
    .filter(b => (b.textContent || "").includes("打开七步分析"))
    .map(b => (b.textContent || "").replace(/\\s+/g, " ").trim());
`;
/** 只在「排除」那一组里数行 —— 整页计数会把别的组算进来 */
const EXCLUDE_SECTION = `
  const sec = [...document.querySelectorAll("section.group")]
    .find(s => ((s.querySelector(".group-title") || {}).textContent || "").includes("排除"));
  if (!sec) return null;
  const rows = (sec.innerHTML.match(/打开七步分析/g) ?? []).length;
  const more = sec.querySelector("button.reveal-more");
  return { rows, more: more ? more.textContent.trim() : "" };
`;
/** 市场分档 chip 的文字与选中状态，顺序不变 —— 用来验证「数字是筛之前的」 */
const CHIPS = `
  const wrap = document.querySelector(".chips-market");
  if (!wrap) return null;
  return [...wrap.querySelectorAll("button")].map(b => ({
    text: (b.textContent || "").replace(/\\s+/g, " ").trim(),
    on: b.getAttribute("aria-pressed") === "true",
  }));
`;
/** 「继续展开」按钮：板块那句带「个板块」，个股那句带「只」 */
const MORE = (which: "sector" | "stock") => `
  const want = ${JSON.stringify(which === "sector" ? "个板块" : "只")};
  const b = [...document.querySelectorAll("button.reveal-more")].find(x => x.textContent && x.textContent.includes(want));
  if (!b) return "NOT_FOUND";
  b.click(); return "OK";
`;
async function waitFor(expr: string, label: string, tries = 60): Promise<boolean> {
  for (let i = 0; i < tries; i += 1) {
    if (await evaluate<boolean>(`return ${expr};`)) return true;
    await sleep(250);
  }
  console.log(`    （等待超时：${label}）`);
  return false;
}

try {
  await sleep(2500);
  const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()) as Array<{
    type: string;
    webSocketDebuggerUrl: string;
  }>;
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("没找到页面 target");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((r) => ws.addEventListener("open", () => r()));
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String((ev as MessageEvent).data)) as { id?: number; result?: unknown };
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)!(msg.result);
      pending.delete(msg.id);
    }
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: BASE });
  await waitFor(`document.readyState === "complete"`, "页面加载");
  await evaluate(`
    window.__e2eErrors = [];
    window.addEventListener("error", (e) => window.__e2eErrors.push(String(e.message)));
    window.addEventListener("unhandledrejection", (e) => window.__e2eErrors.push(String(e.reason)));
  `);
  await sleep(1500);

  // ── 一、游戏大厅的文案 ─────────────────────────────────────
  console.log("\n一、游戏页的文案");
  await waitFor(`document.body.innerText.includes("游戏大厅")`, "游戏大厅渲染");
  // 章节清单在「选择传奇关卡 →」后面，不点开就只有玩法三选一
  const openLevels = await evaluate<string>(CLICK("选择传奇关卡"));
  check("点得到「选择传奇关卡」", openLevels === "OK", openLevels);
  await waitFor(`document.body.innerText.includes("温馨提示")`, "关卡清单展开", 40);
  const home = await evaluate<string>(TEXT);
  check("含「温馨提示」", home.includes("温馨提示"));
  check("不再有「这一局要想清楚的是」", !home.includes("这一局要想清楚的是"));
  check("不再有「少爷」", !home.includes("少爷"));
  check("不再有「快进」", !home.includes("快进"));
  check("不再有「走一天」", !home.includes("走一天"));
  check("没有「退出推演」", !home.includes("退出推演"));
  check("章节 5 叫「券商点火」", home.includes("券商点火"));
  check("章节 7 叫「周期股冲顶」", home.includes("周期股冲顶"));
  check("旧章节名已消失（涨得让人坐不住）", !home.includes("涨得让人坐不住"));
  check("旧章节名已消失（最猛的那一段）", !home.includes("最猛的那一段"));

  // ── 二、市场观察：分档 chip ────────────────────────────────
  console.log("\n二、市场观察：市场分档");
  const tab = await evaluate<string>(CLICK("市场观察"));
  check("切到「市场观察」", tab === "OK", tab);
  await waitFor(`document.querySelector(".chips-market") !== null`, "分档 chip 出现", 80);
  const chips = await evaluate<Array<{ text: string; on: boolean }> | null>(CHIPS);
  check("分档 chip 渲染出来了", chips !== null);
  const labels = (chips ?? []).map((c) => c.text).join(" | ");
  console.log(`    chip：${labels}`);
  check("有「全部市场」", labels.includes("全部市场"));
  check("有「A 股」", labels.includes("A 股"));
  check("有「港股」", labels.includes("港股"));
  check("有「日股」", labels.includes("日股"));
  check("有「韩股」", labels.includes("韩股"));
  const onDefault = (chips ?? []).filter((c) => c.on);
  check("默认亮着的是「全部市场」", onDefault.length === 1 && onDefault[0]!.text.includes("全部市场"),
    JSON.stringify(onDefault));
  const base = (chips ?? []).map((c) => c.text).join("|");

  // ── 三、分段展开：每次只放三个 ────────────────────────────
  console.log("\n三、分段展开：每次只放三个");
  const before = await evaluate<number>(ROWS);
  console.log(`    展开前个股行：${before}`);
  check("默认只展开第一组，所以只有 3 条个股行", before === 3, `实际 ${before}`);
  const moreLabels = await evaluate<string[]>(`
    return [...document.querySelectorAll("button.reveal-more")].map(b => (b.textContent || "").trim());
  `);
  check("页面上有「继续展开」按钮", moreLabels.length > 0, `实际 ${moreLabels.length}`);
  console.log(`    还剩多少：${moreLabels.join(" / ")}`);
  const sectorMore = await evaluate<string>(MORE("sector"));
  if (sectorMore === "OK") {
    await sleep(400);
    const afterSectors = await evaluate<string>(TEXT);
    check("点过一次之后板块那句的剩余数变小", !/继续展开（还有 31 个板块）/.test(afterSectors));
  } else {
    check("② 板块的「继续展开」点得到", false, sectorMore);
  }
  const stockMore = await evaluate<string>(MORE("stock"));
  check("③ 个股的「继续展开」点得到", stockMore === "OK", stockMore);
  await sleep(500);
  const after = await evaluate<number>(ROWS);
  console.log(`    点一次之后个股行：${after}`);
  check("点一次多放三个（3 → 6）", after === before + 3, `实际 ${after}`);

  // 「排除」是最大的一组（引擎的兜底桶），也正是用户说「展开有点慢」的那一个
  const openExclude = await evaluate<string>(`
    const head = [...document.querySelectorAll("button.group-head")]
      .find(b => (b.textContent || "").includes("排除"));
    if (!head) return "NOT_FOUND";
    head.click(); return "OK";
  `);
  check("点得到「排除」分组的表头", openExclude === "OK", openExclude);
  await sleep(900);
  const ex1 = await evaluate<{ rows: number; more: string } | null>(EXCLUDE_SECTION);
  check("找得到「排除」那一组", ex1 !== null);
  console.log(`    排除组：${ex1?.rows} 行，${ex1?.more}`);
  check("「排除」展开后只有 3 行（这一组是引擎的兜底桶，几百只）", ex1?.rows === 3, `实际 ${ex1?.rows}`);
  check("并且说明还剩多少只", /还有 \d+ 只/.test(ex1?.more ?? ""), ex1?.more ?? "(无)");
  const t0 = Date.now();
  const moreExclude = await evaluate<string>(`
    const sec = [...document.querySelectorAll("section.group")]
      .find(s => ((s.querySelector(".group-title") || {}).textContent || "").includes("排除"));
    const b = sec && sec.querySelector("button.reveal-more");
    if (!b) return "NOT_FOUND";
    b.click(); return "OK";
  `);
  await sleep(500);
  const ex2 = await evaluate<{ rows: number; more: string } | null>(EXCLUDE_SECTION);
  console.log(`    再放三个用了 ${Date.now() - t0}ms：${ex2?.rows} 行，${ex2?.more}`);
  check("再点一次多放三个（3 → 6）", moreExclude === "OK" && ex2?.rows === 6,
    `${moreExclude} / ${ex2?.rows}`);
  // 这一组到底有多大：从「继续展开（还有 N 只）」反推 —— 用户说的「展开有点慢」就是这一组
  const rest = Number(/还有 (\d+) 只/.exec(ex2?.more ?? "")?.[1] ?? -1);
  console.log(`    「排除」一组共 ${rest + 6} 只（已放 6 只，还剩 ${rest} 只）`);
  check("「排除」确实是最大的一组（>100 只）", rest + 6 > 100, `实际 ${rest + 6}`);

  // ── 四、点分档：数字不能跟着筛 ───────────────────────────
  console.log("\n四、选中一个市场之后，其它分档的数字还得在");
  const clickHk = await evaluate<string>(`
    const wrap = document.querySelector(".chips-market");
    const b = [...wrap.querySelectorAll("button")].find(x => (x.textContent || "").includes("港股"));
    if (!b) return "NOT_FOUND";
    b.click(); return "OK";
  `);
  check("点得到「港股」", clickHk === "OK", clickHk);
  await sleep(600);
  const chips2 = await evaluate<Array<{ text: string; on: boolean }> | null>(CHIPS);
  const on = (chips2 ?? []).filter((c) => c.on);
  check("恰有一个分档处于选中态", on.length === 1, JSON.stringify(on));
  check("选中的是港股", (on[0]?.text ?? "").includes("港股"), on[0]?.text ?? "(无)");
  check(
    "数字没跟着筛选变（仍是筛之前的那份）",
    (chips2 ?? []).map((c) => c.text).join("|") === base,
    `${(chips2 ?? []).map((c) => c.text).join("|")} vs ${base}`,
  );
  const hkRows = await evaluate<string[]>(STOCK_ROWS);
  console.log(`    港股行：${hkRows.map((r) => r.slice(0, 24)).join(" / ")}`);
  check("选港股之后 ③ 的行只剩港股", hkRows.length > 0 && hkRows.every((r) => r.includes(".HK")),
    hkRows.join(" | ").slice(0, 200));
  const clickAgain = await evaluate<string>(`
    const wrap = document.querySelector(".chips-market");
    const b = [...wrap.querySelectorAll("button")].find(x => (x.textContent || "").includes("港股"));
    b.click(); return "OK";
  `);
  check("再点一次回到全部市场", clickAgain === "OK");
  await sleep(500);
  const chips3 = await evaluate<Array<{ text: string; on: boolean }> | null>(CHIPS);
  const onBack = (chips3 ?? []).filter((c) => c.on);
  check("又亮回「全部市场」", onBack.length === 1 && onBack[0]!.text.includes("全部市场"),
    JSON.stringify(onBack));
  const backRows = await evaluate<string[]>(STOCK_ROWS);
  console.log(`    回来后：${backRows.map((r) => r.slice(0, 24)).join(" / ")}`);
  // 不逐字比：分组是按「近 20 日涨幅」算的，实时轮询一到，同一只票会换组，
  // 比文本会偶发假失败。要比的是「判据回来了没有」—— A 股又出现在列表里了。
  // 不比长度：点 chip 会把每组的展开进度重置回三个（`useEffect(..., [query, marketFilter])`），
  // 长度本来就该变。要比的是「判据回来了没有」—— A 股又出现在列表里了。
  check(
    "列表恢复成多市场（A 股又回来了）",
    backRows.length > 0 && backRows.some((r) => /\.(SH|SZ|BJ)/.test(r)),
    backRows.join(" | ").slice(0, 160),
  );

  // ── 五、当年价：茅台在 2020-06-18 那天就是 1405 ──────────
  console.log("\n五、关卡里的价格是当年的盘面价");
  await evaluate(CLICK("游戏大厅"));
  await sleep(600);
  // 关卡是个横向滑动的幻灯片：一次只显示一张章节卡 + 一个「进入 <日期>」按钮，
  // 所以得先点「券商点火」那张卡，按钮才会变成 2020-06-18 那一关。
  const pickChapter = await evaluate<string>(CLICK("券商点火"));
  check("点得到「券商点火」那张章节卡", pickChapter === "OK", pickChapter);
  await sleep(600);
  const enter = await evaluate<string>(CLICK("进入 2020-06-18"));
  check("点得到「进入 2020-06-18」", enter === "OK", enter);
  const inLevel = await waitFor(`document.getElementById("replay-code") !== null`, "推演界面", 80);
  check("进入了 2020-07-02 那一关", inLevel);
  if (inLevel) {
    await evaluate(`
      const input = document.getElementById("replay-code");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, "600519.SH");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    `);
    await sleep(700);
    const panel = await evaluate<string>(`
      const p = document.querySelector(".replay-order-panel") || document.body;
      return p.innerText.replace(/\\s+/g, " ");
    `);
    console.log(`    下单卡：${panel.slice(0, 160)}`);
    // 不复权：2020-06-18 的贵州茅台是 1413.0，前收 1405.0。
    // 前复权那份是 1200 上下（1189.16）—— 那正是这次要改掉的东西。
    check("当天价格是 14 开头（当年盘面价）", /14\d\d(\.\d+)?/.test(panel), panel.slice(0, 120));
    check("不再是前复权那份（看不到 1189）", !panel.includes("1189"), panel.slice(0, 120));
  }

  // ── 六、页面还活着 ──────────────────────────────────────
  console.log("\n六、控制台");
  const errors = await evaluate<string[]>(`return window.__e2eErrors;`);
  check("没有未捕获异常", errors.length === 0, errors.slice(0, 3).join(" / "));
} catch (err) {
  fail += 1;
  failures.push(`未捕获的失败：${String(err)}`);
  console.log(`  ✗ 未捕获的失败：${String(err)}`);
} finally {
  console.log("\n" + "─".repeat(52));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (failures.length > 0) {
    console.log("\n失败清单：");
    for (const f of failures) console.log(`  · ${f}`);
  }
  cleanup();
  await sleep(300);
  process.exit(fail === 0 ? 0 : 1);
}
