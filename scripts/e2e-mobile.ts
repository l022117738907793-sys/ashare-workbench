/**
 * 紧凑手机布局：在真浏览器里按 360 / 390 / 430px 各走一遍。
 *
 *   node packages/data/scripts/sync_web_data.mjs --keep 1 --trim-days 120
 *   npm run build -w apps/web
 *   npx vite-node scripts/e2e-mobile.ts
 *
 * 为什么单开一个脚本，而不是把 e2e-replay 调窄：
 * 那个脚本断言的是「**整页**能看到什么」，而 760px 以下的紧凑布局做了两件事 ——
 * 把开局简报、股票列表、走势图、推演日志收进 `<details>`，把推演页的
 * 行情/持仓列换成三个手机分页。两者都让「整页文本」变少，断言口径完全不同。
 * 所以 desktop 的归 e2e-replay（1280px），phone 的归这里。
 *
 * 这里盯的三件事，都是单测证明不了的：
 *   1. 折叠块**真的展得开**（只是有个折叠符号、点了没反应是最糟的情况）；
 *   2. 手机分页切换真的换列（`data-mobile-pane` 与 CSS 对得上）；
 *   3. 三个宽度都**没有横向溢出** —— 手机上的横向滚动条是这类布局最常见的破绽。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DIST = join(ROOT, "apps/web/dist");
const EDGE = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const PORT = 9230;
const CDP_PORT = 9231;
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

/** 轮询等待一个条件成立；超时返回 false，由调用方决定算不算失败 */
async function waitFor(expr: string, tries = 60): Promise<boolean> {
  for (let i = 0; i < tries; i += 1) {
    if (await evaluate<boolean>(`return ${expr};`)) return true;
    await sleep(250);
  }
  return false;
}

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
rmSync("/tmp/edge-e2e-mobile", { recursive: true, force: true });
const browser: ChildProcess = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${CDP_PORT}`,
    "--user-data-dir=/tmp/edge-e2e-mobile",
    "--no-first-run",
    "--window-size=390,844",
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
const TEXT = `return document.body.innerText.replace(/\\s+/g, " ");`;

/** 展开一个折叠块；已经开着就原样返回 OK */
const OPEN_DETAILS = (selector: string) => `
  const d = document.querySelector(${JSON.stringify(selector)});
  if (!d) return "NO_DETAILS";
  if (!d.open) { const s = d.querySelector("summary"); if (!s) return "NO_SUMMARY"; s.click(); }
  return d.open ? "OK" : "STILL_CLOSED";
`;
/** 折叠块当前是不是合着的（`<details>` 没有 open 属性） */
const IS_CLOSED = (selector: string) => `
  const d = document.querySelector(${JSON.stringify(selector)});
  if (!d) return "NO_DETAILS";
  return d.open ? "open" : "closed";
`;
/** 某个选择器算出来的 display —— 手机分页靠它换列 */
const DISPLAY = (selector: string) => `
  const el = document.querySelector(${JSON.stringify(selector)});
  return el ? getComputedStyle(el).display : "MISSING";
`;
const DISPLAY_ALL = (selectors: string[]) => `
  const out = {};
  for (const s of ${JSON.stringify(selectors)}) {
    const el = document.querySelector(s);
    out[s] = el ? getComputedStyle(el).display : "MISSING";
  }
  return JSON.stringify(out);
`;
/** 整页有没有横向溢出：`scrollWidth` 超过视口宽度就是有 */
const OVERFLOW = `
  const de = document.documentElement;
  return JSON.stringify({
    vw: window.innerWidth,
    sw: de.scrollWidth,
    bw: document.body.scrollWidth,
    worst: [...document.querySelectorAll("body *")]
      .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 3)
      .map((e) => (e.className && typeof e.className === "string" ? e.className : e.tagName) + "@" + Math.round(e.getBoundingClientRect().right)),
  });
`;

/**
 * 量第一张卡片的标题栏。
 *
 * 报的四个数里 `ratio` 与上下关系是关键：标题块窄到几十像素时，
 * 中文会在**一个字**处断行（min-content 就是一个字），
 * 「全池 679 只，按信号强度排序」会竖着排成一列。
 */
const CARD_HEAD = `
  const h = document.querySelector(".card-head");
  if (!h) return "NO_CARD";
  const t = h.querySelector(".card-head-text");
  const r = h.querySelector(".card-head-right");
  if (!t) return "NO_TEXT";
  const hb = h.getBoundingClientRect(), tb = t.getBoundingClientRect();
  const rb = r ? r.getBoundingClientRect() : null;
  return JSON.stringify({
    card: Math.round(hb.width),
    text: Math.round(tb.width),
    ratio: Math.round((tb.width / hb.width) * 100),
    rightTop: rb ? Math.round(rb.top) : null,
    textBottom: Math.round(tb.bottom),
    title: (h.querySelector(".card-title") || {}).textContent || "",
  });
`;

/** 切换设备尺寸：媒体查询看的是布局视口宽度，改这个就够了 */
async function resize(width: number, height: number): Promise<void> {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(250);
}

async function main(): Promise<void> {
  // Edge 起来要一点时间，CDP 端口没通之前会 ECONNREFUSED
  type Target = { type: string; url: string; webSocketDebuggerUrl: string };
  let page: Target | undefined;
  for (let i = 0; i < 40 && !page; i += 1) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()) as Target[];
      page = list.find((t) => t.type === "page");
    } catch {
      await sleep(300);
    }
  }
  if (!page) throw new Error("没有可用的页面目标");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(String(e.data)) as { id?: number; result?: unknown };
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg.result);
      pending.delete(msg.id);
    }
  });
  await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: BASE });
  await sleep(2200);
  await evaluate(`
    window.__e2eErrors = [];
    window.addEventListener("error", (e) => window.__e2eErrors.push(String(e.message)));
    window.addEventListener("unhandledrejection", (e) => window.__e2eErrors.push(String(e.reason)));
  `);

  // ── 一、三个宽度都不能有横向溢出 ───────────────────────────
  console.log("\n一、360 / 390 / 430px 没有横向溢出");
  for (const [w, h] of [
    [360, 780],
    [390, 844],
    [430, 932],
  ] as const) {
    await resize(w, h);
    const raw = await evaluate<string>(OVERFLOW);
    const o = JSON.parse(raw) as { vw: number; sw: number; worst: string[] };
    check(
      `${w}px 大厅不横向溢出`,
      o.sw <= o.vw + 1,
      `scrollWidth ${o.sw} > 视口 ${o.vw}${o.worst.length ? ` · ${o.worst.join(", ")}` : ""}`,
    );
  }
  await resize(390, 844);

  // ── 二、大厅：玩法说明与「玩法三步」折叠块 ─────────────────
  console.log("\n二、大厅");
  const modeDesc = await evaluate<string>(DISPLAY(".game-mode-description"));
  check("手机上出现「玩法说明」那行（桌面是隐藏的）", modeDesc !== "none" && modeDesc !== "MISSING", modeDesc);
  const guideClosed = await evaluate<string>(IS_CLOSED(".game-quick-guide"));
  check("「玩法三步」默认是合着的", guideClosed === "closed", guideClosed);
  check("点得开「玩法三步」", (await evaluate<string>(OPEN_DETAILS(".game-quick-guide"))) === "OK");
  const guide = await evaluate<string>(TEXT);
  check("展开后三步都在", ["读懂眼前的信息", "亲手作出决定", "回看每一次交易"].every((s) => guide.includes(s)));
  const lobbyText = await evaluate<string>(TEXT);
  check("大厅仍然没有「快进」「少爷」「走一天」", !/快进|少爷|走一天/.test(lobbyText));

  // ── 三、关卡页：开局简报折叠块 ─────────────────────────────
  console.log("\n三、关卡页");
  check("点得到「选择传奇关卡」", (await evaluate<string>(CLICK("选择传奇关卡"))) === "OK");
  await sleep(700);
  const briefClosed = await evaluate<string>(IS_CLOSED(".chapter-briefing-details"));
  check("「开局简报」默认是合着的", briefClosed === "closed", briefClosed);
  check("点得开「开局简报」", (await evaluate<string>(OPEN_DETAILS(".chapter-briefing-details"))) === "OK");
  const brief = await evaluate<string>(TEXT);
  check("简报里有「进场那天能看到的」", brief.includes("进场那天能看到的"));
  check("简报里有「温馨提示」", brief.includes("温馨提示"));
  {
    const raw = await evaluate<string>(OVERFLOW);
    const o = JSON.parse(raw) as { vw: number; sw: number; worst: string[] };
    check(
      "390px 关卡页不横向溢出",
      o.sw <= o.vw + 1,
      `scrollWidth ${o.sw} > 视口 ${o.vw}${o.worst.length ? ` · ${o.worst.join(", ")}` : ""}`,
    );
  }

  // ── 四、进入一局，验证手机分页真的换列 ─────────────────────
  console.log("\n四、推演的手机分页");
  const entered = await evaluate<string>(CLICK("进入 2020-06-18"));
  if (entered !== "OK") {
    // 关卡是横向幻灯片，默认那张卡不一定是 2020 年那一关；先点卡再进
    await evaluate<string>(CLICK("券商点火"));
    await sleep(500);
  }
  check("进入得了历史推演", (await evaluate<string>(CLICK("进入 2020-06-18"))) === "OK", entered);
  await sleep(1200);

  const tabsDisplay = await evaluate<string>(DISPLAY(".replay-phone-tabs"));
  check("手机上出现三个分页按钮", tabsDisplay !== "none" && tabsDisplay !== "MISSING", tabsDisplay);
  const tabLabels = await evaluate<string>(`
    return [...document.querySelectorAll(".replay-phone-tabs button")].map(b => b.textContent.trim()).join(" / ");
  `);
  check("分页是「下单交易 / 行情资讯 / 持仓成绩」", tabLabels === "下单交易 / 行情资讯 / 持仓成绩", tabLabels);

  const sel = [".replay-workspace", ".replay-market-column", ".replay-trade-column", ".replay-holdings-panel", ".replay-bottom-grid"];
  const paneDisplay = async () => JSON.parse(await evaluate<string>(DISPLAY_ALL(sel))) as Record<string, string>;

  const trade = await paneDisplay();
  check(
    "默认停在「下单交易」：下单列在、行情列与持仓不在",
    trade[".replay-trade-column"] !== "none" &&
      trade[".replay-market-column"] === "none" &&
      trade[".replay-holdings-panel"] === "none",
    JSON.stringify(trade),
  );

  check("点得到「行情资讯」", (await evaluate<string>(CLICK("行情资讯"))) === "OK");
  await sleep(400);
  const market = await paneDisplay();
  check(
    "切到「行情资讯」：行情列在、下单列不在",
    market[".replay-market-column"] !== "none" && market[".replay-trade-column"] === "none",
    JSON.stringify(market),
  );

  check("点得到「持仓成绩」", (await evaluate<string>(CLICK("持仓成绩"))) === "OK");
  await sleep(400);
  const account = await paneDisplay();
  check(
    "切到「持仓成绩」：工作区整块隐藏、持仓面板露出来",
    account[".replay-workspace"] === "none" && account[".replay-holdings-panel"] !== "none",
    JSON.stringify(account),
  );

  const replayOverflow = JSON.parse(await evaluate<string>(OVERFLOW)) as { vw: number; sw: number; worst: string[] };
  check(
    "390px 推演页不横向溢出",
    replayOverflow.sw <= replayOverflow.vw + 1,
    `scrollWidth ${replayOverflow.sw} > 视口 ${replayOverflow.vw}${replayOverflow.worst.length ? ` · ${replayOverflow.worst.join(", ")}` : ""}`,
  );

  // ── 五、推演页的折叠块 ─────────────────────────────────────
  console.log("\n五、推演页的折叠块");
  check("点得到「下单交易」", (await evaluate<string>(CLICK("下单交易"))) === "OK");
  await sleep(400);
  const chartClosed = await evaluate<string>(IS_CLOSED(".replay-chart-details"));
  check("「走势图」默认是合着的", chartClosed === "closed", chartClosed);
  check("点得开「走势图」", (await evaluate<string>(OPEN_DETAILS(".replay-chart-details"))) === "OK");

  const pendingDisplay = await evaluate<string>(DISPLAY(".replay-pending-panel"));
  check("待成交委托是折叠块（details）", pendingDisplay !== "MISSING", pendingDisplay);
  const pendingOpen = await evaluate<string>(`
    const d = document.querySelector(".replay-pending-panel");
    return d && d.tagName === "DETAILS" ? (d.open || d.hasAttribute("open") ? "open" : "closed") : "NOT_DETAILS";
  `);
  check("没有挂单时「待成交委托」是合着的", pendingOpen === "closed", pendingOpen);
  const logOpen = await evaluate<string>(`
    const d = document.querySelector(".replay-log-details");
    return d && d.tagName === "DETAILS" ? (d.open ? "open" : "closed") : "NOT_DETAILS";
  `);
  check("「推演日志」是合着的折叠块", logOpen === "closed", logOpen);
  check("点得开「推演日志」", (await evaluate<string>(OPEN_DETAILS(".replay-log-details"))) === "OK");

  // ── 六、短屏 ───────────────────────────────────────────────
  console.log("\n六、短屏（390×640）");
  await resize(390, 640);
  const short = JSON.parse(await evaluate<string>(OVERFLOW)) as { vw: number; sw: number; worst: string[] };
  check(
    "短屏也不横向溢出",
    short.sw <= short.vw + 1,
    `scrollWidth ${short.sw} > 视口 ${short.vw}${short.worst.length ? ` · ${short.worst.join(", ")}` : ""}`,
  );
  const shortText = await evaluate<string>(TEXT);
  check("短屏下「下一天」「结束」仍在", shortText.includes("下一天") && shortText.includes("结束"));

  // ── 七、卡片标题栏不竖排 ───────────────────────────────────
  //
  // 手机上曾出现：`.card-head` 是 flex 行、`.card-head-right` 是 `flex: 0 0 auto`，
  // 四个信号 chip 占掉两百多像素，标题块被压到几十像素，中文于是**一列一字**。
  // 修法是窄屏下把标题与 chip 排改成上下叠。这里量的是宽度占比与上下关系，
  // 不是某一版文案 —— 文案会变，被挤扁这件事不会。
  console.log("\n七、卡片标题栏不竖排");
  await resize(390, 844);
  check("点得到「市场观察」", (await evaluate<string>(CLICK("市场观察"))) === "OK");
  const gotCard = await waitFor(`document.querySelector(".card-head") !== null`);
  check("卡片渲染出来了", gotCard);
  const head = await evaluate<string>(CARD_HEAD);
  console.log(`    card-head：${head}`);
  if (typeof head === "string" && head.startsWith("{")) {
    const h = JSON.parse(head) as { card: number; text: number; ratio: number; rightTop: number | null; textBottom: number; title: string };
    check("标题块拿到卡片的大部分宽度", h.ratio >= 60, `${h.text}/${h.card} = ${h.ratio}%`);
    check("标题块至少 240px 宽（放得下一行副标题）", h.text >= 240, `${h.text}px`);
    check(
      "chip 排改到标题块下面一行",
      h.rightTop === null || h.rightTop >= h.textBottom - 1,
      `chip top ${h.rightTop} vs 标题 bottom ${h.textBottom}`,
    );
    check("标题文字还在（今日信号）", h.title.includes("今日信号"), h.title);
  } else {
    check("量得到卡片标题栏", false, head);
  }
  const marketOverflow = JSON.parse(await evaluate<string>(OVERFLOW)) as { vw: number; sw: number; worst: string[] };
  check(
    "390px 市场观察页不横向溢出",
    marketOverflow.sw <= marketOverflow.vw + 1,
    `scrollWidth ${marketOverflow.sw} > 视口 ${marketOverflow.vw}${marketOverflow.worst.length ? ` · ${marketOverflow.worst.join(", ")}` : ""}`,
  );

  // ── 八、控制台 ─────────────────────────────────────────────
  console.log("\n八、控制台");
  const errors = await evaluate<string[]>(`return window.__e2eErrors || [];`);
  check("没有未捕获异常", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log("\n" + "─".repeat(52));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (failures.length) {
    console.log("\n失败清单：");
    for (const f of failures) console.log(`  · ${f}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
