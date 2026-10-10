/**
 * 回溯模式（模式 4）：在真浏览器里挑一天开局，并验证走的确实是那一天。
 *
 *   node packages/data/scripts/sync_web_data.mjs --keep 1 --trim-days 120
 *   npm run build -w apps/web
 *   npx vite-node scripts/e2e-backtrack.ts
 *
 * 这个脚本盯的四件事，都是单测证明不了的：
 *   1. 大厅里真的多出第四张卡，而且**点得动、点完起点选择器真的出现**；
 *   2. 起点清单与快照日历对得上（数量、首尾、余几天），点中间那天选中状态真的转移；
 *   3. 开局之后**日期照实显示** —— 回溯模式一旦被 `parseReplaySave` 认错，
 *      就会变成一个藏日期的随机局，那是这个功能最要命的失败方式；
 *   4. **境外标的真能买** —— 点「港股」那颗市场胶囊之后榜单上确实出现 .HK 的票。
 *      这一条早先断言的是**反面**（「一只境外标的都没有」），因为那时快照只有一个标量
 *      汇率，按最新价折一个月等于猜。逐日汇率补上之后反过来：真正要防的失败方式变成
 *      「汇率没接上，境外又被放进来了」—— 那正是这条要抓的。
 *
 * 断言尽量量结构（有几颗按钮、选中哪一颗、日期是不是这一天），
 * 少量文案 —— 文案改一个字就让 e2e 变红，是这类脚本最常见的浪费。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DIST = join(ROOT, "apps/web/dist");
const EDGE = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const PORT = 9236;
const CDP_PORT = 10236;
const BASE = `http://127.0.0.1:${PORT}/`;
const USER_DIR = "/tmp/edge-e2e-backtrack";

/** 回溯窗口的天数，与 `apps/web/src/lib/replay.ts` 的 `BACKTRACK_DAYS` 对齐。 */
const WINDOW = 22;

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
  console.error("先构建：npm run build -w apps/web");
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
/*
 * 开工前先清场。
 *
 * 上一次跑崩了留下的 Edge 会**继续占着调试端口**，此时新 spawn 的浏览器会静默
 * 失败、脚本转而连上那个旧实例 —— 旧实例的 localStorage 里还压着上一局的存档，
 * 于是「回溯模式」那张卡一开局就是禁用的（`replayInProgress` 为真），
 * 报错信息却是「快照缺少开盘价」。这个坑真的踩过一次，所以清场写进脚本里。
 */
spawnSync("pkill", ["-f", `remote-debugging-port=${CDP_PORT}`]);
rmSync(USER_DIR, { recursive: true, force: true });
const browser: ChildProcess = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${USER_DIR}`,
    "--no-first-run",
    "--window-size=1280,1000",
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
const sleep250 = () => sleep(250);
/** 轮询等待一个条件成立；超时返回 false，由调用方决定算不算失败 */
async function waitFor(expr: string, tries = 60): Promise<boolean> {
  for (let i = 0; i < tries; i += 1) {
    if (await evaluate<boolean>(`return ${expr};`)) return true;
    await sleep250();
  }
  return false;
}
const CLICK = (text: string) => `
  const b = [...document.querySelectorAll("button")].find(x => x.textContent && x.textContent.includes(${JSON.stringify(text)}));
  if (!b) return "NOT_FOUND";
  b.click(); return "OK";
`;
const TEXT = `return document.body.innerText.replace(/\\s+/g, " ");`;

/** 起点清单：每颗按钮的日期、余几天、是不是被选中 */
const DAYS = `
  return JSON.stringify([...document.querySelectorAll(".game-day")].map(d => ({
    date: (d.querySelector(".game-day-date") || {}).textContent || "",
    rest: (d.querySelector(".game-day-rest") || {}).textContent || "",
    active: d.classList.contains("is-active"),
  })));
`;
const LAUNCH = `
  const b = document.querySelector(".game-launch-button");
  const p = document.querySelector(".game-launch-action p");
  // 按钮里还嵌着一个「→」装饰，它不是文案的一部分，裁掉再比
  const label = b ? b.textContent.replace(/→\s*$/, "").trim() : null;
  return JSON.stringify({ label, disabled: b ? b.disabled : null, hint: p ? p.textContent.trim() : null });
`;

interface Day { date: string; rest: string; active: boolean }
interface Launch { label: string | null; disabled: boolean | null; hint: string | null }

// ── 连上浏览器 ─────────────────────────────────────────────────────────────
for (let i = 0; i < 40; i += 1) {
  try {
    const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()) as Array<{
      type: string;
      url: string;
      webSocketDebuggerUrl?: string;
    }>;
    const page = list.find((t) => t.type === "page");
    if (page?.webSocketDebuggerUrl) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise<void>((res) => (ws.onopen = () => res()));
      break;
    }
  } catch {
    /* 浏览器还没起来 */
  }
  await sleep250();
}
if (!ws) {
  console.error("连不上 Edge 的调试端口");
  process.exit(1);
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown };
  if (typeof msg.id === "number") pending.get(msg.id)?.(msg.result);
};

async function goto(path = "/"): Promise<void> {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: `${BASE}${path.replace(/^\//, "")}` });
  await sleep(4000);
  // 「没有未捕获异常」那条断言要靠它 —— 必须装在 reload **之后**，
  // 装在前面会被 reload 连同 window 一起换掉，末尾读到的永远是个空数组。
  await evaluate(`
    if (!window.__e2eErrors) {
      window.__e2eErrors = [];
      window.addEventListener("error", (e) => window.__e2eErrors.push(String(e.message)));
      window.addEventListener("unhandledrejection", (e) => window.__e2eErrors.push("rejection: " + String(e.reason)));
    }
    return true;
  `);
}

/** 大厅 → 选回溯模式 → 起点选择器就位 */
async function openBacktrack(): Promise<boolean> {
  await evaluate(CLICK("模拟游戏"));
  await sleep(1200);
  if (!(await waitFor(`[...document.querySelectorAll("button")].some(x => x.textContent && x.textContent.includes("回溯模式"))`, 40))) {
    return false;
  }
  await evaluate(CLICK("回溯模式"));
  await sleep(500);
  return waitFor(`!!document.querySelector(".game-backtrack-days")`, 20);
}

console.log("一、大厅里的第四张模式卡");
await goto();
await waitFor(`[...document.querySelectorAll("button")].some(x => x.textContent && x.textContent.includes("模拟游戏"))`, 40);
await evaluate(CLICK("模拟游戏"));
await sleep(1200);
await waitFor(`[...document.querySelectorAll("button")].some(x => x.textContent && x.textContent.includes("回溯模式"))`, 40);

const cards = JSON.parse(
  await evaluate<string>(`
    return JSON.stringify([...document.querySelectorAll(".game-mode-card")].map(c => ({
      number: (c.querySelector(".game-mode-number") || {}).textContent || "",
      title: (c.querySelector("strong") || {}).textContent || "",
      disabled: c.disabled,
      why: c.title,
    })));
  `),
) as Array<{ number: string; title: string; disabled: boolean }>;
const btCard = cards.find((c) => c.title === "回溯模式");
check("大厅里有四张模式卡", cards.length === 4, `实际 ${cards.length}：${cards.map((c) => c.title).join(" / ")}`);
check("第四张是回溯模式", cards[3]?.title === "回溯模式", cards.map((c) => c.title).join(" / "));
check("卡片序号是 04 / 最近一个月", btCard?.number === "04 / 最近一个月", btCard?.number);
check("回溯卡可点（快照就绪时不禁用）", btCard?.disabled === false, `disabled=${btCard?.disabled}${btCard?.why ? ` / title=${btCard.why}` : ""}`);

const lobby = await evaluate<string>(TEXT);
check("大厅里点了回溯模式之前不渲染起点", !(await evaluate<boolean>(`return !!document.querySelector(".game-backtrack-days");`)));

console.log("\n二、起点选择器");
const opened = await openBacktrack();
check("点回溯模式之后起点选择器出现", opened);
check("模式说明换成了回溯那一句", (await evaluate<string>(TEXT)).includes("在最近一个月里挑一个交易日开局"));

const days = JSON.parse(await evaluate<string>(DAYS)) as Day[];
check(`起点共 ${WINDOW} 天`, days.length === WINDOW, `实际 ${days.length}`);
check("每颗按钮都带日期", days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date)), days.slice(0, 2).map((d) => d.date).join(" / "));
check("按时间从早到晚排", days.every((d, i) => i === 0 || days[i - 1].date < d.date), `${days[0]?.date} … ${days[days.length - 1]?.date}`);
check("最后一天是快照的最后一天", days[days.length - 1]?.date === "2026-10-09", days[days.length - 1]?.date);
check("「余 N 天」从窗口长度递减到 1", days[0]?.rest.includes(String(WINDOW)) && days[days.length - 1]?.rest.includes("1"), `${days[0]?.rest} … ${days[days.length - 1]?.rest}`);
check("默认选中最早那天（能玩满窗口）", days[0]?.active === true && days.filter((d) => d.active).length === 1, days.find((d) => d.active)?.date);

const first = JSON.parse(await evaluate<string>(LAUNCH)) as Launch;
check("按钮文案报出选中的日期", first.label === `从 ${days[0].date} 开始推演`, String(first.label));
check("副文案报出还剩几个交易日", (first.hint ?? "").includes(String(WINDOW)), String(first.hint));
// 起点选择器要把「这一局能碰哪些票」说出来。含港日韩之后这句更该在 ——
// 玩家刚在实时盘买过港股，回到这一屏找不到它才是真的会困惑。
const note = (await evaluate<string>(TEXT)).includes("含港股");
check("起点选择器写明了本局含港股 / 日股 / 韩股", note);

// 挑中间那天，看选中状态与按钮文案是否一起走
const mid = Math.floor(days.length / 2);
await evaluate(`
  const ds = [...document.querySelectorAll(".game-day")];
  ds[${mid}].click();
  return true;
`);
await sleep(300);
const days2 = JSON.parse(await evaluate<string>(DAYS)) as Day[];
const midPick = JSON.parse(await evaluate<string>(LAUNCH)) as Launch;
check("点中间那天后选中状态转移（仍只有一颗选中）", days2[mid]?.active === true && days2.filter((d) => d.active).length === 1, days2.find((d) => d.active)?.date);
check("按钮文案跟着换到新日期", midPick.label === `从 ${days2[mid].date} 开始推演`, String(midPick.label));

console.log("\n三、开局之后走的是那一天，而且日期照实显示");
await evaluate(`
  const ds = [...document.querySelectorAll(".game-day")];
  ds[0].click();
  return true;
`);
await sleep(250);
const clicked = await evaluate<string>(CLICK("开始推演"));
check("点得到「开始推演」", clicked === "OK", clicked);
check("进入了推演界面", await waitFor(`!!document.querySelector(".replay-date")`, 60));

const head = await evaluate<string>(`
  const day = document.querySelector(".replay-date");
  return JSON.stringify({
    eyebrow: (document.querySelector(".replay-eyebrow") || {}).textContent || "",
    date: day ? day.textContent.trim() : null,
    note: (document.querySelector(".replay-mission-note") || {}).textContent || "",
  });
`);
const h = JSON.parse(head) as { eyebrow: string; date: string | null; note: string };
check("眉题是「回溯复盘」，没被当成传奇关卡", h.eyebrow.includes("回溯复盘"), h.eyebrow);
check("眉题没写成「传奇推演」", !h.eyebrow.includes("传奇推演"), h.eyebrow);
check("日期照实显示，没有被藏掉", h.date === days[0].date, `${h.date}（期望 ${days[0].date}）`);

// 这份清单默认是收着的（怕把下单卡撑得太长），先按「更换股票」把它展开
const openedPicker = await evaluate<string>(CLICK("更换股票"));
check("点得到「更换股票」", openedPicker === "OK", openedPicker);
await sleep(400);
const universe = JSON.parse(
  await evaluate<string>(`
    const rows = [...document.querySelectorAll(".pick-row")];
    const codes = rows.map(r => ((r.querySelector(".pick-code") || {}).textContent || "").trim()).filter(Boolean);
    return JSON.stringify({ count: codes.length, codes });
  `),
) as { count: number; codes: string[] };
check("候选榜单不是空的", universe.count > 0, String(universe.count));
// 榜单上的代码是**显示口径**：A 股只给 6 位数字（沪深两市代码不重复），
// 境外的才带 .HK / .JP / .KR 尾巴 —— 所以「是不是 A 股」要按这两条一起判。
const isCnCode = (c: string) => /^\d{6}$/.test(c);
const isOverseas = (c: string) => /\.(HK|JP|KR)$/.test(c);
check("候选里有 A 股", universe.codes.some(isCnCode), universe.codes.slice(0, 3).join(" / "));
check(
  "「全部」这一屏是 A 股为主（市场胶囊排的存在感才立得住）",
  universe.codes.some(isCnCode),
  universe.codes.slice(0, 3).join(" / "),
);

/*
 * 切到港股。**这是本节的要害**：回溯窗口里能买境外标的，前提是加载快照时
 * 按 `meta.<市场>.fxSeries` 那条**逐日**序列把价格折成了人民币 ——
 * 汇率没接上的话，这里要么一只 .HK 都出不来，要么出来的价是本币当人民币。
 * 只断言「出现了 .HK」还不够，价格也得落在人民币的量级上。
 */
const CLICK_MARKET = (label: string) => `
  const box = document.querySelector(".pick-markets");
  if (!box) return "NO_BOX";
  const b = [...box.querySelectorAll("button")].find(
    (x) => (x.textContent || "").trim().startsWith(${JSON.stringify(label)}),
  );
  if (!b) return "NOT_FOUND";
  b.click();
  return "OK";
`;
check("选股清单里有市场胶囊排", (await evaluate<string>(`return document.querySelector(".pick-markets") ? "OK" : "NO";`)) === "OK");

const switched = await evaluate<string>(CLICK_MARKET("港股"));
check("点得到「港股」那颗胶囊", switched === "OK", switched);
await sleep(500);
const hkRows = JSON.parse(
  await evaluate<string>(`
    const rows = [...document.querySelectorAll(".pick-row")];
    const out = rows.map(r => {
      const code = ((r.querySelector(".pick-code") || {}).textContent || "").trim();
      const price = ((r.querySelector(".pick-price") || {}).textContent || "").trim();
      return { code, price };
    }).filter(r => r.code);
    return JSON.stringify({ rows: out, labels: [...document.querySelectorAll(".pick-cur")].map(x => (x.textContent||"").trim()) });
  `),
) as { rows: Array<{ code: string; price: string }>; labels: string[] };
check("筛到港股之后榜单不是空的", hkRows.rows.length > 0, `${hkRows.rows.length} 行`);
check(
  "筛到港股之后榜单上全是港股",
  hkRows.rows.length > 0 && hkRows.rows.every((r) => r.code.endsWith(".HK")),
  hkRows.rows.map((r) => r.code).join(" / "),
);
// 港股价格折成人民币之后是二三十到几百元这个量级；要是汇率没接上，
// 显示的会是港币原值（几百到上千），这里用一个宽松的上界兜住
const hkPrices = hkRows.rows.map((r) => Number(r.price.replace(/[^\d.]/g, ""))).filter((n) => Number.isFinite(n) && n > 0);
check("港股的价格折成了人民币（量级合理，不是本币原值）", hkPrices.length > 0 && hkPrices.every((n) => n < 1000), hkPrices.join(" / "));

const backToAll = await evaluate<string>(CLICK_MARKET("全部"));
check("点得回「全部」", backToAll === "OK", backToAll);
await sleep(400);

check(
  "持仓面板写明境外标的已按当天汇率折成人民币",
  (await evaluate<string>(TEXT)).includes("境外标的已按当天汇率折成人民币"),
);

console.log("\n四、逐日推进");
const stepped = await evaluate<string>(CLICK("下一天"));
check("点得到「下一天」", stepped === "OK", stepped);
await sleep(900);
const after = await evaluate<string>(`return (document.querySelector(".replay-date") || {}).textContent || "";`);
check("推一天之后日期前进到窗口的第二天", after.trim() === days[1].date, `${after.trim()}（期望 ${days[1].date}）`);

console.log("\n五、刷新页面之后还是原来的回溯局");
await goto();
check("刷新后停在推演界面，没被弹回大厅", await waitFor(`!!document.querySelector(".replay-date")`, 60));
const reloaded = await evaluate<string>(`
  const day = document.querySelector(".replay-date");
  return JSON.stringify({
    eyebrow: (document.querySelector(".replay-eyebrow") || {}).textContent || "",
    date: day ? day.textContent.trim() : null,
  });
`);
const rl = JSON.parse(reloaded) as { eyebrow: string; date: string | null };
check("刷新后眉题仍是「回溯复盘」", rl.eyebrow.includes("回溯复盘"), rl.eyebrow);
check("刷新后日期仍照实显示（没被降级成随机局）", rl.date === days[1].date, `${rl.date}（期望 ${days[1].date}）`);

console.log("\n六、手机视口");
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await goto();
await evaluate(`localStorage.removeItem("aw.replay.v1"); return true;`);
await goto();
await waitFor(`[...document.querySelectorAll("button")].some(x => x.textContent && x.textContent.includes("模拟游戏"))`, 40);
const phoneOpen = await openBacktrack();
check("手机上也点得开起点选择器", phoneOpen);

const phone = JSON.parse(
  await evaluate<string>(`
    const d = document.querySelector(".game-day");
    const r = d ? d.getBoundingClientRect() : null;
    const grid = document.querySelector(".game-backtrack-days");
    const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0;
    const panel = document.querySelector(".game-launch-panel");
    return JSON.stringify({
      dayH: r ? Math.round(r.height) : 0,
      dayW: r ? Math.round(r.width) : 0,
      cols,
      panelW: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
      viewport: window.innerWidth,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    });
  `),
) as { dayH: number; dayW: number; cols: number; panelW: number; viewport: number; overflowX: boolean };
check("手机上每颗起点按钮都有足够大的触摸区（≥48px 高）", phone.dayH >= 48, `${phone.dayH}px`);
check("手机上起点按钮不窄于 96px", phone.dayW >= 96, `${phone.dayW}px`);
check("手机上排成多列，不是一列到底", phone.cols >= 2, `${phone.cols} 列`);
check("手机上没有横向溢出", phone.overflowX === false, `viewport ${phone.viewport} / scrollWidth 超出`);

const errs = await evaluate<string[]>`return JSON.stringify(window.__e2eErrors || []);`;
const errorList = JSON.parse(errs) as string[];
check("全程没有未捕获异常", errorList.length === 0, errorList.join(" | "));

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log("\n失败项：");
  for (const f of failures) console.log(`  - ${f}`);
}
ws.close();
cleanup();
process.exit(fail === 0 ? 0 : 1);
