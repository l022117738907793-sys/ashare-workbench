/**
 * 对着**本地构建产物**点一遍「实时盘 + 日股 / 韩股」。
 *
 *   node packages/data/scripts/sync_web_data.mjs --keep 1 --trim-days 120
 *   npm run build -w apps/web
 *   npx vite preview --port 4399 --strictPort --host 127.0.0.1   # apps/web 下
 *   npx vite-node scripts/e2e-live-jpkr.ts
 *
 * 为什么必须有这一层：`apps/web/public/data/` 是 gitignore 的构建产物，它可能停在
 * **没有日韩标的的旧副本**上（港股那次实测就停在 619 只 / 0 港股）。单测全绿也说明不了
 * 页面上真能看见丰田 —— 只有把页面点开才知道。
 *
 * 断言的数字都是算好的：
 *   快照（A 股公共日历末日 2026-09-30）：
 *     7203.JP   丰田汽车 收 2920.0 日元 × 0.042727 = 124.7628 → 显示 124.76
 *     005930.KR 三星电子 收 269500 韩元 × 0.004958 = 1336.181 → 显示 1336.18
 *   如果页面拉到了实时价（腾讯），会变成：
 *     丰田 2930.5 × 0.042727 = 125.21 / 三星 272000 × 0.004958 = 1348.58
 *   —— **两个都接受**（断言的是「折算发生了」，不是「用了哪一根 bar」）。
 *
 *   真正要抓的是**没折算**：那样屏幕上会出现 2920 / 269500 这种本币原值。
 *   那几个数字看着完全正常，正是这个 bug 能在眼皮底下活下来的原因。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:4399/";
const EDGE = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const PORT = 9227;

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

rmSync("/tmp/edge-e2e-jpkr", { recursive: true, force: true });
const browser: ChildProcess = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${PORT}`,
    "--user-data-dir=/tmp/edge-e2e-jpkr",
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
/** 找出含某个词的候选行文本（候选清单比整页更窄，避免命中别处的同名字符串） */
const ROW_WITH = (word: string) => `
  const row = [...document.querySelectorAll(".pick-row, li, div")].find(
    (x) => x.textContent && x.textContent.includes(${JSON.stringify(word)}) && x.className && String(x.className).includes("pick"),
  ) || [...document.querySelectorAll("li, div")].find(
    (x) => x.textContent && x.textContent.includes(${JSON.stringify(word)}) && x.textContent.length < 120,
  );
  return row ? row.textContent : "";
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

  console.log("\n二、进实时盘");
  check("默认落在游戏大厅的玩法选择上", (await evaluate<string>(`return document.body.innerText;`)).includes("选一种玩法"));
  const live = await evaluate<string>(CLICK("实时模式"));
  check("有「实时模式」玩法可选", live === "OK", live);
  await sleep(400);
  const started = await evaluate<string>(CLICK("开始实时盘"));
  check("开局按钮点得动", started === "OK", started);
  check("进了模拟下单卡", await waitFor(`document.body.innerText.includes("模拟下单")`, "下单卡"));

  console.log("\n三、日股进得了候选清单，价格已折成人民币");
  await evaluate(TYPE("#game-code", "7203"));
  check("候选清单里有丰田汽车（日股确实进页面了）", await waitFor(`document.body.innerText.includes("丰田汽车")`, "丰田汽车", 20), "候选空的话多半是 public/data 没同步");
  const jpRow = await evaluate<string>(ROW_WITH("丰田汽车"));
  check(
    "候选价是折成人民币的 124.76 / 125.21（2920.0 日元 × 0.042727）",
    jpRow.includes("124.76") || jpRow.includes("125.21"),
    jpRow.slice(0, 140),
  );
  check(
    "候选价没有被原样显示成日元（2920 / 2930.5 都不该出现）",
    !jpRow.includes("2920") && !jpRow.includes("2930"),
    jpRow.slice(0, 140),
  );
  check("候选里标了「日元」", jpRow.includes("日元"), jpRow.slice(0, 140));

  console.log("\n四、韩股进得了候选清单，价格已折成人民币");
  await evaluate(TYPE("#game-code", "005930"));
  check("候选清单里有三星电子", await waitFor(`document.body.innerText.includes("三星电子")`, "三星电子", 20));
  const krRow = await evaluate<string>(ROW_WITH("三星电子"));
  check(
    "候选价是折成人民币的 1336.18 / 1348.58（269500 韩元 × 0.004958）",
    krRow.includes("1336.18") || krRow.includes("1348.58"),
    krRow.slice(0, 140),
  );
  check(
    "候选价没有被原样显示成韩元（269500 / 272000 都不该出现）",
    !krRow.includes("269500") && !krRow.includes("272000"),
    krRow.slice(0, 140),
  );
  check("候选里标了「韩元」", krRow.includes("韩元"), krRow.slice(0, 140));

  console.log("\n五、日股下单卡按日股口径");
  await evaluate(TYPE("#game-code", "7203.JP"));
  await evaluate(TYPE("#game-shares", "100"));
  check("填完代码与股数就出下单预览", await waitFor(`document.body.innerText.includes("预计成交价")`, "下单预览", 20));
  let text = await evaluate<string>(`return document.body.innerText;`);
  check("标的行是 7203.JP 丰田汽车", text.includes("7203.JP 丰田汽车"), text.slice(0, 200));
  check("副标题写「日股 T+0」", text.includes("日股 T+0"), "");
  check("副标题写「一手 100 股（単元株）」", text.includes("一手 100 股"), "");
  check("股数提示提到 100 股整数倍（単元株）", text.includes("単元株"), "");
  check(
    "日股零佣金（手续费 0）",
    text.includes("手续费 0 元"),
    text.includes("手续费") ? text.slice(text.indexOf("手续费"), text.indexOf("手续费") + 30) : "没有手续费行",
  );

  console.log("\n六、韩股下单卡按韩股口径");
  await evaluate(TYPE("#game-code", "005930.KR"));
  await evaluate(TYPE("#game-shares", "100"));
  await sleep(500);
  text = await evaluate<string>(`return document.body.innerText;`);
  check("标的行是 005930.KR 三星电子", text.includes("005930.KR 三星电子"), text.slice(0, 200));
  check("副标题写「韩股 T+0」", text.includes("韩股 T+0"), "");
  check("副标题写「证券交易税」而不是「印花税」", text.includes("证券交易税"), "");
  check("股数提示写「韩股 1 股起，没有整手要求」", text.includes("1 股起，没有整手要求"), "");
  check("副标题不再声称「一手 100 股」", !text.includes("一手 100 股"), "");

  console.log("\n七、A 股这条路径没被改坏");
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

  console.log("\n八、没有控制台报错");
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
console.log("本地构建产物里的实时盘日股 / 韩股跑通了。\n");
