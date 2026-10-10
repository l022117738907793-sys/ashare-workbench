/**
 * 对着**本地构建产物**点一遍「模拟下单」的两层分类，以及实时盘回大厅的那条路。
 *
 *   node packages/data/scripts/sync_web_data.mjs --keep 1 --trim-days 120
 *   npm run build -w apps/web
 *   npx vite preview --port 4399 --strictPort --host 127.0.0.1   # apps/web 下
 *   npx vite-node scripts/e2e-picker.ts
 *
 * 为什么必须有这一层：这两件事都是**布局与状态机**上的事，单测只能静态渲染，
 * 点不动按钮。而它们坏掉的样子都很安静 ——
 *   - 市场胶囊少一排：境外标的照样在池子里，只是永远进不了榜，屏幕上没有任何报错；
 *   - 「返回游戏大厅」点了没反应：得真点一次才知道。
 *
 * 两条关键断言的来历：
 *   1. 筛到某个境外市场之后，榜单**不能只剩 2 只**。`pickCandidates` 按桶摊开，
 *      每个桶只取 2 只；而 20 只港股全在同一个桶里（境外没有行业数据，桶就是市场），
 *      所以不特判「单桶不摊开」的话，玩家点了「港股 20」只会看到 2 行。
 *   2. 点「返回游戏大厅」之后**账户不能没**。那一屏的正确行为是「账户照跑，
 *      只是换了块屏」，回账户之后总资产要和离开前一个数字不差。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:4399/";
const EDGE = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const PORT = 9228;

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

rmSync("/tmp/edge-e2e-picker", { recursive: true, force: true });
const browser: ChildProcess = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${PORT}`,
    "--user-data-dir=/tmp/edge-e2e-picker",
    "--no-first-run",
    "--window-size=430,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);
process.on("exit", () => browser.kill("SIGKILL"));

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
/** 点「市场那一排」里的某一颗胶囊。按 `.pick-markets` 限定范围，免得命中页面上别处的同名词 */
const CLICK_MARKET = (label: string) => `
  const box = document.querySelector(".pick-markets");
  if (!box) return "NO_BOX";
  const b = [...box.querySelectorAll("button")].find(x => x.textContent && x.textContent.trim().startsWith(${JSON.stringify(label)}));
  if (!b) return "NOT_FOUND";
  b.click(); return "OK";
`;
/** 榜单上每一行的代码（`.pick-code` 已经把 .SH/.SZ/.BJ 后缀去掉了，所以 A 股是纯数字） */
const PICK_CODES = `
  return JSON.stringify([...document.querySelectorAll(".pick-row .pick-code")].map(x => x.textContent.trim()));
`;
const MARKET_CHIPS = `
  const box = document.querySelector(".pick-markets");
  return box ? JSON.stringify([...box.querySelectorAll("button")].map(x => x.textContent.trim())) : "NO_BOX";
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
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as Array<{
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

  console.log(`\n一、打开 ${BASE}`);
  await send("Page.navigate", { url: BASE });
  await evaluate(`try { localStorage.clear(); } catch {} return true;`);
  await send("Page.reload", { ignoreCache: true });
  /*
   * 监听器必须在 reload **之后**装：reload 会把 window 连同 `__e2eErrors` 一起换掉，
   * 装在前面等于没装（读到的会是 undefined，而不是一个空数组）。
   */
  await evaluate(`
    window.__e2eErrors = [];
    window.addEventListener("error", (e) => window.__e2eErrors.push(String(e.message)));
    window.addEventListener("unhandledrejection", (e) => window.__e2eErrors.push(String(e.reason)));
    return true;
  `);
  check("页面渲染出标题", await waitFor(`document.body.innerText.includes("股市练习场")`, "标题"));
  check("快照加载完成", await waitFor(`!document.body.innerText.includes("正在加载")`, "加载完成"));

  console.log("\n二、开局并展开选股清单");
  check("默认落在玩法选择上", (await evaluate<string>(`return document.body.innerText;`)).includes("选一种玩法"));
  check("点得动「实时模式」", (await evaluate<string>(CLICK("实时模式"))) === "OK");
  await sleep(400);
  check("点得动开局按钮", (await evaluate<string>(CLICK("开始实时盘"))) === "OK");
  check("进了模拟下单卡", await waitFor(`document.body.innerText.includes("模拟下单")`, "下单卡"));
  const opened = await evaluate<string>(`
    const d = document.querySelector(".game-stock-browser");
    if (!d) return "NO_DETAILS";
    if (!d.open) { const s = d.querySelector("summary"); if (!s) return "NO_SUMMARY"; s.click(); }
    return d.open ? "OK" : "STILL_CLOSED";
  `);
  check("点得开「从列表选择股票」", opened === "OK", opened);
  check("候选清单出得来", await waitFor(`!!document.querySelector(".pick-row")`, "候选行"), "清单空的话多半是 public/data 没同步");

  console.log("\n三、市场那一排（保留原有的三个排序键，再加一层国家分类）");
  check("三个排序键还在", (await evaluate<string>(`return document.body.innerText;`)).includes("涨得最猛"));
  const chips = (await evaluate<string>(MARKET_CHIPS)) ?? "NO_BOX";
  check("市场胶囊那一排渲染出来了", chips !== "NO_BOX", chips);
  const labels = chips.startsWith("[") ? (JSON.parse(chips) as string[]) : [];
  check("有「全部」", labels.some((x) => x.startsWith("全部")), chips);
  check("A 股 / 港股 / 日股 / 韩股 四颗都在", ["A 股", "港股", "日股", "韩股"].every((m) => labels.some((x) => x.startsWith(m))), chips);
  check("胶囊上带只数（不是光秃秃的市场名）", labels.every((x) => /\d+$/.test(x)), chips);

  console.log("\n四、筛到某个市场，榜单就只剩它");
  const all = JSON.parse((await evaluate<string>(PICK_CODES)) ?? "[]") as string[];
  check("默认「全部」是混着的（至少有一个 A 股）", all.some((c) => /^\d{6}$/.test(c)), JSON.stringify(all));

  const hk = await evaluate<string>(CLICK_MARKET("港股"));
  check("点得动「港股」", hk === "OK", hk);
  await sleep(250);
  let codes = JSON.parse((await evaluate<string>(PICK_CODES)) ?? "[]") as string[];
  check("筛到港股之后榜单全是港股", codes.length > 0 && codes.every((c) => c.endsWith(".HK")), JSON.stringify(codes));
  /*
   * 这条是这次修复的核心：20 只港股在同一个桶里，按桶摊开会砍到 2 只。
   * 2 就是 bug 的签名，所以断言「不止 2 只」。
   */
  check(`港股榜单不再被砍到 2 只（实际 ${codes.length} 只）`, codes.length > 2, JSON.stringify(codes));

  const jp = await evaluate<string>(CLICK_MARKET("日股"));
  check("点得动「日股」", jp === "OK", jp);
  await sleep(250);
  codes = JSON.parse((await evaluate<string>(PICK_CODES)) ?? "[]") as string[];
  check("筛到日股之后榜单全是日股", codes.length > 0 && codes.every((c) => c.endsWith(".JP")), JSON.stringify(codes));
  check(`日股榜单不止 2 只（实际 ${codes.length} 只）`, codes.length > 2, JSON.stringify(codes));

  const kr = await evaluate<string>(CLICK_MARKET("韩股"));
  check("点得动「韩股」", kr === "OK", kr);
  await sleep(250);
  codes = JSON.parse((await evaluate<string>(PICK_CODES)) ?? "[]") as string[];
  check("筛到韩股之后榜单全是韩股", codes.length > 0 && codes.every((c) => c.endsWith(".KR")), JSON.stringify(codes));

  const back = await evaluate<string>(CLICK_MARKET("全部"));
  check("点得回「全部」", back === "OK", back);
  await sleep(250);
  const mixed = JSON.parse((await evaluate<string>(PICK_CODES)) ?? "[]") as string[];
  check("「全部」又混回来了", mixed.some((c) => /^\d{6}$/.test(c)), JSON.stringify(mixed));

  console.log("\n五、实时账户回游戏大厅，账户不能没");
  const before = await evaluate<string>(`
    const card = [...document.querySelectorAll(".card")].find(c => c.textContent.includes("总资产"));
    return card ? card.textContent : "";
  `);
  check("账户页有总资产", before.includes("总资产"), before.slice(0, 120));
  const assetsBefore = (before.match(/总资产\s*([\d,.]+)/) ?? [])[1] ?? "";
  check("读到了总资产的数字", /[\d]/.test(assetsBefore), assetsBefore);

  check("标题栏有「← 返回游戏大厅」", (await evaluate<boolean>(`return document.body.innerText.includes("← 返回游戏大厅");`)));
  const toLobby = await evaluate<string>(CLICK("← 返回游戏大厅"));
  check("点得动它", toLobby === "OK", toLobby);
  check("回到了玩法选择那一屏", await waitFor(`document.body.innerText.includes("选一种玩法")`, "玩法选择"));
  check("大厅里明说实时盘还在跑", (await evaluate<string>(`return document.body.innerText;`)).includes("您的实时盘还在跑"));
  const toAccount = await evaluate<string>(CLICK("回到实时账户"));
  check("点得动「回到实时账户」", toAccount === "OK", toAccount);
  check("回到了实时账户", await waitFor(`document.body.innerText.includes("您的实时模拟盘")`, "实时账户"));
  const after = await evaluate<string>(`
    const card = [...document.querySelectorAll(".card")].find(c => c.textContent.includes("总资产"));
    return card ? card.textContent : "";
  `);
  const assetsAfter = (after.match(/总资产\s*([\d,.]+)/) ?? [])[1] ?? "";
  check(
    `来回一趟总资产没变（${assetsBefore} → ${assetsAfter}）`,
    assetsBefore !== "" && assetsAfter === assetsBefore,
    `${assetsBefore} vs ${assetsAfter}`,
  );
  check("回来之后不再显示大厅", !(await evaluate<string>(`return document.body.innerText;`)).includes("选一种玩法"));

  console.log("\n六、控制台");
  const errs = await evaluate<string[]>(`return JSON.stringify(window.__e2eErrors);`);
  const errList = (typeof errs === "string" ? JSON.parse(errs) : errs) as string[];
  check("没有未捕获的异常", errList.length === 0, JSON.stringify(errList));
} catch (err) {
  fail += 1;
  failures.push(`运行中断：${String(err)}`);
  console.log(`\n运行中断：${String(err)}`);
} finally {
  browser.kill("SIGKILL");
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (failures.length > 0) console.log(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(fail === 0 ? 0 : 1);
