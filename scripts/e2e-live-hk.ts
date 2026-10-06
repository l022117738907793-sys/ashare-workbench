/**
 * 对着**本地构建产物**点一遍「实时盘 + 港股」。
 *
 *   node packages/data/scripts/sync_web_data.mjs --keep 1 --trim-days 120
 *   npm run build -w apps/web
 *   npx vite preview --port 4399 --strictPort --host 127.0.0.1   # apps/web 下
 *   npx vite-node scripts/e2e-live-hk.ts
 *
 * 为什么必须有这一层：`apps/web/public/data/` 是 gitignore 的构建产物，
 * 它可能停在**没有港股的旧副本**上（实测曾经是 619 只 / 0 港股）。单测全绿
 * 也说明不了页面上真能看见港股 —— 只有把页面点开才知道。
 *
 * 断言的数字都是算好的，不是「看起来对」：
 *   - 腾讯 `00700.HK` 快照收盘 431.0 港币 × 0.8584 = 369.9704 → 显示 369.97
 *   - 下单 100 股：参考价 369.9704 → 预计成交价 370.34（+0.1% 滑点）
 *     金额 37034 元；港股手续费 = max(37034/0.8584×0.25%, 100)×0.8584 + 37034×0.1%
 *     = 92.59 + 37.03 = 129.62
 */
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:4399/";
const EDGE = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const PORT = 9226;

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

rmSync("/tmp/edge-e2e-hk", { recursive: true, force: true });
const browser: ChildProcess = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${PORT}`,
    "--user-data-dir=/tmp/edge-e2e-hk",
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
/** React 受控 input：必须走原生 setter，直接改 .value 不会触发 onChange */
const TYPE = (selector: string, value: string) => `
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return "NOT_FOUND";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return "OK";
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
  await evaluate(`
    window.__e2eErrors = [];
    window.addEventListener("error", (e) => window.__e2eErrors.push(String(e.message)));
    window.addEventListener("unhandledrejection", (e) => window.__e2eErrors.push(String(e.reason)));
    return true;
  `);

  console.log(`\n一、打开 ${BASE}`);
  await send("Page.navigate", { url: BASE });
  await evaluate(`try { localStorage.clear(); } catch {} return true;`);
  await send("Page.reload", { ignoreCache: true });
  check("页面渲染出标题", await waitFor(`document.body.innerText.includes("股市练习场")`, "标题"));
  check("快照加载完成", await waitFor(`!document.body.innerText.includes("正在加载")`, "加载完成"));

  console.log("\n二、进实时盘（游戏大厅是默认视图）");
  check("默认落在游戏大厅的玩法选择上", (await evaluate<string>(`return document.body.innerText;`)).includes("选一种玩法"));
  const live = await evaluate<string>(CLICK("实时模式"));
  check("有「实时模式」玩法可选", live === "OK", live);
  await sleep(400);
  const started = await evaluate<string>(CLICK("开始实时盘"));
  check("开局按钮点得动", started === "OK", started);
  check("进了模拟下单卡", await waitFor(`document.body.innerText.includes("模拟下单")`, "下单卡"));

  console.log("\n三、港股进得了候选清单，价格已折成人民币");
  await evaluate(TYPE("#game-code", "00700"));
  const listed = await waitFor(`document.body.innerText.includes("腾讯控股")`, "腾讯控股出现在候选里", 20);
  check("候选清单里有腾讯控股（港股确实进页面了）", listed, "候选空的话多半是 public/data 没同步");
  const pickText = await evaluate<string>(`
    const row = [...document.querySelectorAll(".pick-row, li, div")].find(
      (x) => x.textContent && x.textContent.includes("腾讯控股") && x.textContent.includes("369.97"),
    );
    return row ? row.textContent : "";
  `);
  check("候选里显示 369.97（= 431.0 港币 × 0.8584，折算发生了）", pickText.includes("369.97"), pickText.slice(0, 120));
  check("候选里标了「港币」", pickText.includes("港币"), pickText.slice(0, 120));

  console.log("\n四、下单卡按港股口径算");
  await evaluate(TYPE("#game-code", "00700.HK"));
  await evaluate(TYPE("#game-shares", "100"));
  const card = await waitFor(`document.body.innerText.includes("预计成交价")`, "下单预览", 20);
  check("填完代码与股数就出下单预览", card);
  const text = await evaluate<string>(`return document.body.innerText;`);
  check("标的行是 00700.HK 腾讯控股", text.includes("00700.HK 腾讯控股"), text.slice(0, 200));
  check("预计成交价 370.34（参考价 369.97 + 0.1% 滑点）", text.includes("370.34"), "");
  check("预计金额 37034 元", text.includes("37034"), "");
  check(
    "手续费 129.62（港股 0.25%/最低 100 港元 + 0.1% 双向印花税，折成人民币）",
    text.includes("129.62"),
    text.includes("手续费") ? text.slice(text.indexOf("手续费"), text.indexOf("手续费") + 40) : "没有手续费行",
  );
  check("下单卡副标题写 T+0（港股当日可卖，不是 T+1）", text.includes("港股 T+0"), "");
  check("下单卡副标题不再声称「一手 100 股」", !text.includes("一手 100 股"), "");

  console.log("\n五、A 股这条路径没被改坏");
  await evaluate(TYPE("#game-code", "600519.SH"));
  await evaluate(TYPE("#game-shares", "100"));
  await sleep(500);
  const cn = await evaluate<string>(`return document.body.innerText;`);
  check("A 股仍走 T+1 文案", cn.includes("T+1：当日买入次日才可卖"), "");
  check(
    "A 股价格没被折算（1258.62）",
    cn.includes("1258.62"),
    cn.includes("600519") ? cn.slice(cn.indexOf("600519"), cn.indexOf("600519") + 60) : "没有贵州茅台行",
  );

  console.log("\n六、没有控制台报错");
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
console.log("本地构建产物里的实时盘港股跑通了。\n");
