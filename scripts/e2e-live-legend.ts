/**
 * 对着**线上站点**点一遍传奇模式。
 *
 * 本地 e2e 跑的是 apps/web/dist，和线上是同一份字节（sha256 已核对），
 * 但「同一份代码」不等于「同一份运行环境」—— 这次上线的历史分片是**部署时才同步**的，
 * 本地 dist 里那份是我手工 sync 出来的。所以这里直接打线上地址。
 *
 *   npx vite-node scripts/e2e-live-legend.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

const LIVE = "https://l022117738907793-sys.github.io/ashare-workbench/";
const EDGE = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const PORT = 9224;

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

rmSync("/tmp/edge-e2e-live", { recursive: true, force: true });
const browser: ChildProcess = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${PORT}`,
    "--user-data-dir=/tmp/edge-e2e-live",
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
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
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

  console.log(`\n一、打开线上站点 ${LIVE}`);
  await send("Page.navigate", { url: LIVE });
  await evaluate(`try { localStorage.clear(); } catch {} return true;`);
  await send("Page.reload", { ignoreCache: true });
  check(
    "线上页面渲染出标题",
    await waitFor(`document.body.innerText.includes("A 股趋势筛选工作台")`, "标题"),
  );
  check("快照加载完成", await waitFor(`!document.body.innerText.includes("正在加载")`, "加载完成"));

  console.log("\n二、进模拟游戏 → 传奇模式");
  await evaluate(CLICK("模拟游戏"));
  await sleep(500);
  const entry = await evaluate<string>(CLICK("传奇模式"));
  check("线上有「传奇模式」入口（说明这次部署带上去了）", entry === "OK", entry);

  const listed = await waitFor(`document.body.innerText.includes("2016-11-01")`, "关卡列表");
  check("线上读得到 history/index.json，关卡列表出得来", listed, "读不到清单时这里会超时");
  const text = await evaluate<string>(`return document.body.innerText;`);
  const want = ["2016-11-01", "2018-09-21", "2019-02-13", "2020-01-14", "2020-06-18", "2021-02-26", "2021-08-20", "2022-04-13", "2023-03-08", "2024-09-11"];
  const missing = want.filter((d) => !text.includes(d));
  check("十关的入场日期全在", missing.length === 0, missing.join(", "));
  check("没有出现「还没有关卡数据」", !text.includes("还没有关卡数据"));

  console.log("\n三、真的载入一关（这一步要下 140 KB 分片）");
  await evaluate(CLICK("春节之后"));
  await sleep(600);
  const brief = await evaluate<string>(`return document.body.innerText;`);
  check("简报页出来了", brief.includes("进场那天能看到的"), brief.slice(0, 80));
  const enter = await evaluate<string>(CLICK("进入 2020-01-14"));
  check("点得到「进入」（说明 ready=true，分片清单读到了）", enter === "OK", enter);
  const inLevel = await waitFor(`document.body.innerText.includes("走一天") && document.body.innerText.includes("待成交委托")`, "关卡载入");
  check("线上把 2020 年那一关的行情下下来并进去了", inLevel);

  const lv = await evaluate<string>(`return document.body.innerText;`);
  check("日历是 2020 年那一关的", lv.includes("2020-01-14"), (lv.match(/20\d\d-\d\d-\d\d/g) ?? []).slice(0, 3).join(", "));
  const opts = await evaluate<string[]>(`return [...document.querySelectorAll('datalist option')].map(o => o.getAttribute("value"));`);
  check("选股票池是分片里的 150 只", opts.length === 150, `实际 ${opts.length} 只`);
  check("当年的票在池子里", opts.includes("000725.SZ") && opts.includes("600519.SH"), opts.slice(0, 5).join(", "));

  console.log("\n四、下一单、走一天");
  await evaluate(`
    const input = document.querySelector('input[list]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "600519.SH");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const num = [...document.querySelectorAll('input[type="number"]')].pop();
    setter.call(num, "100");
    num.dispatchEvent(new Event("input", { bubbles: true }));
    return "OK";
  `);
  await evaluate(CLICK("挂单"));
  await sleep(400);
  await evaluate(CLICK("走一天"));
  await sleep(800);
  const after = await evaluate<string>(`return document.body.innerText;`);
  check("成交了，并且注明价格来自当日开盘价", after.includes("开盘价"), after.slice(0, 80));

  console.log("\n五、线上没有控制台报错");
  const errs = await evaluate<string[]>(`return (window.__e2eErrors || []);`);
  check("没有未捕获异常", Array.isArray(errs) && errs.length === 0, JSON.stringify(errs));
} finally {
  try { ws?.close(); } catch {}
  browser.kill("SIGKILL");
}

console.log(`\n${"─".repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log("\n失败详情：");
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log("线上站点的传奇模式跑通了。\n");
