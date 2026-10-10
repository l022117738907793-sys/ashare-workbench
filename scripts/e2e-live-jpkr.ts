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
 * 期望值**从页面自己加载的那份快照里现算**，不写死数字：
 *   - `data/snapshot_*` 每天被 CI 的 `update-snapshot.yml` 换掉一次，收盘价每天都在动，
 *     汇率甚至一天一个报价。写死「2920.0 日元 × 0.042727 = 124.76」这种断言，
 *     第二天就会全红 —— 而它红的不是代码坏了，是**数据换了**。
 *   - 所以这里只钉**结构与接线**：日韩标的进得了候选、价格确实被折算过、
 *     下单卡走的是日股 / 韩股费率。算式本身由 `packages/game` 的单测覆盖。
 *
 *   真正要抓的是**没折算**：那样屏幕上会出现 2920 / 269500 这种本币原值 ——
 *   那几个数字看着完全正常，正是这个 bug 能在眼皮底下活下来的原因。
 *   折算与否用**3% 容差**判定：真没折算的话差的是整个汇率（日元 96%、韩元 99.5%），
 *   而盘中实时行情带来的漂移远小于 3%。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { previewOrder } from "@aw/game";

/** 日股 / 韩股里优先拿这几只当靶子；都不在就退而求其次拿任意一只有收盘价的 */
const JP_PREFERRED = ["7203.JP", "6758.JP", "9984.JP"];
const KR_PREFERRED = ["005930.KR", "000660.KR", "373220.KR"];

interface SnapStock {
  code: string;
  name: string;
  close?: Array<number | null>;
}
/** 快照的 close 是「按日排列、个别日期可能为 null」的数组，最后一个非空就是最新收盘 */
function lastClose(close: Array<number | null> | undefined): number | null {
  if (!Array.isArray(close)) return null;
  for (let i = close.length - 1; i >= 0; i -= 1) if (typeof close[i] === "number") return close[i] as number;
  return null;
}
/** 页面上「今天」用的是北京时间（`useLiveQuotes` 的 `beijingTime().iso`），费率档位按它选 */
function beijingToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
/** 显示口径与 `fmtNum` 一致：两位小数，尾随 0 去掉 */
const show = (n: number) => String(Number(n.toFixed(2)));

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
/**
 * 同上一行，外加它 `.pick-price` 里那个**显示出来的数字**。
 * 「折算发生了没有」要拿这个数字去比，不能拿整行文本 includes —— 行里还有代码、
 * 涨跌幅、板块名等一堆数字，`includes` 很容易撞上无关的巧合。
 */
const ROW_PRICE = (word: string) => `
  const row = [...document.querySelectorAll(".pick-row")].find(
    (x) => x.textContent && x.textContent.includes(${JSON.stringify(word)}),
  );
  if (!row) return "";
  const p = row.querySelector(".pick-price");
  return p ? p.textContent.trim() : "";
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
   * 监听器必须在 reload **之后**装：reload 会把 window 连同 `__e2eErrors` 一起换掉。
   * 装在前面的话末尾那句 `(window.__e2eErrors || [])` 读到的永远是空数组，
   * 「没有未捕获异常」就成了一条**必过**的断言 —— 页面上真抛了错也发现不了。
   */
  await evaluate(`
    window.__e2eErrors = [];
    window.addEventListener("error", (e) => window.__e2eErrors.push(String(e.message)));
    window.addEventListener("unhandledrejection", (e) => window.__e2eErrors.push(String(e.reason)));
    return true;
  `);
  check("页面渲染出标题", await waitFor(`document.body.innerText.includes("交易员")`, "标题"));
  check("快照加载完成", await waitFor(`!document.body.innerText.includes("正在加载")`, "加载完成"));

  /*
   * 现读快照，算出这一趟要比对的期望值。读的是**服务上真的那份**（`data/latest.json`
   * 指向哪个目录就读哪个），不是仓库根 `data/` 里那份 —— 页面用的就是前者。
   */
  const snapName = ((await (await fetch(`${BASE}data/latest.json`)).json()) as { snapshot: string }).snapshot;
  const rawMeta = (await (await fetch(`${BASE}data/${snapName}/meta.json`)).json()) as Record<
    string,
    { fx?: { rate?: number }; count?: number }
  >;
  /* `stocks.json` 是裸数组 */
  const rawStocks = await (await fetch(`${BASE}data/${snapName}/stocks.json`)).json();
  const rows: SnapStock[] = Array.isArray(rawStocks) ? rawStocks : rawStocks.stocks;
  const jpRate = rawMeta.jp?.fx?.rate ?? null;
  const krRate = rawMeta.kr?.fx?.rate ?? null;
  const pick = (suffix: string, preferred: string[]): SnapStock => {
    const pool = rows.filter((r) => r.code.endsWith(suffix) && lastClose(r.close) !== null);
    const hit = preferred.map((c) => pool.find((r) => r.code === c)).find(Boolean) ?? pool[0];
    if (!hit) throw new Error(`快照 ${snapName} 里没有可用的 ${suffix} 靶子，先确认 sync_web_data 跑过`);
    return hit;
  };
  const jp = pick(".JP", JP_PREFERRED);
  const kr = pick(".KR", KR_PREFERRED);
  check(`快照 ${snapName} 里有日股 / 韩股`, rows.some((r) => r.code.endsWith(".JP")) && rows.some((r) => r.code.endsWith(".KR")), `jp.count=${rawMeta.jp?.count} kr.count=${rawMeta.kr?.count}`);
  check("快照带日元与韩元汇率（缺了下单卡会按 1:1 算错最低佣金）", typeof jpRate === "number" && typeof krRate === "number", `JPY=${jpRate} KRW=${krRate}`);
  const jpClose = lastClose(jp.close) as number;
  const krClose = lastClose(kr.close) as number;
  const jpCny = Number((jpClose * (jpRate as number)).toFixed(2));
  const krCny = Number((krClose * (krRate as number)).toFixed(2));
  console.log(
    `    靶子 ${jp.code} ${jp.name}：收盘 ${jpClose} 日元 × ${jpRate} = ${show(jpCny)} 元\n` +
      `    靶子 ${kr.code} ${kr.name}：收盘 ${krClose} 韩元 × ${krRate} = ${show(krCny)} 元`,
  );

  console.log("\n二、进实时盘");
  check("默认落在游戏大厅的玩法选择上", (await evaluate<string>(`return document.body.innerText;`)).includes("选一种玩法"));
  const live = await evaluate<string>(CLICK("实时模式"));
  check("有「实时模式」玩法可选", live === "OK", live);
  await sleep(400);
  const started = await evaluate<string>(CLICK("开始实时盘"));
  check("开局按钮点得动", started === "OK", started);
  check("进了模拟下单卡", await waitFor(`document.body.innerText.includes("模拟下单")`, "下单卡"));

  /*
   * 紧凑版把股票列表收进了「从列表选择股票」折叠块，折叠时 innerText 是空的 —— 先点开，
   * 这一步顺带验证它展得开（玩家要能从列表里挑票，不能只是有个折叠符号）。
   */
  const picksOpened = await evaluate<string>(`
    const d = document.querySelector(".game-stock-browser");
    if (!d) return "NO_DETAILS";
    if (!d.open) { const s = d.querySelector("summary"); if (!s) return "NO_SUMMARY"; s.click(); }
    return d.open ? "OK" : "STILL_CLOSED";
  `);
  check("点得开「从列表选择股票」", picksOpened === "OK", picksOpened);

  console.log("\n三、日股进得了候选清单，价格已折成人民币");
  await evaluate(TYPE("#game-code", jp.code.split(".")[0]));
  check(`候选清单里有${jp.name}（日股确实进页面了）`, await waitFor(`document.body.innerText.includes(${JSON.stringify(jp.name)})`, jp.name, 20), "候选空的话多半是 public/data 没同步");
  const jpRow = await evaluate<string>(ROW_WITH(jp.name));
  const jpShown = Number(await evaluate<string>(ROW_PRICE(jp.name)));
  check(
    `候选价是折成人民币的（卡上 ${jpShown}，快照算出来 ${show(jpCny)} = ${jpClose} 日元 × ${jpRate}）`,
    Number.isFinite(jpShown) && jpShown > 0 && Math.abs(jpShown - jpCny) / jpCny <= 0.03,
    jpRow.slice(0, 140),
  );
  check(
    `候选价没有被原样显示成日元（${jpClose} 不该出现）`,
    !jpRow.includes(show(jpClose)) && !jpRow.includes(String(jpClose)),
    jpRow.slice(0, 140),
  );
  check("候选里标了「日元」", jpRow.includes("日元"), jpRow.slice(0, 140));

  console.log("\n四、韩股进得了候选清单，价格已折成人民币");
  await evaluate(TYPE("#game-code", kr.code.split(".")[0]));
  check(`候选清单里有${kr.name}`, await waitFor(`document.body.innerText.includes(${JSON.stringify(kr.name)})`, kr.name, 20));
  const krRow = await evaluate<string>(ROW_WITH(kr.name));
  const krShown = Number(await evaluate<string>(ROW_PRICE(kr.name)));
  check(
    `候选价是折成人民币的（卡上 ${krShown}，快照算出来 ${show(krCny)} = ${krClose} 韩元 × ${krRate}）`,
    Number.isFinite(krShown) && krShown > 0 && Math.abs(krShown - krCny) / krCny <= 0.03,
    krRow.slice(0, 140),
  );
  check(
    `候选价没有被原样显示成韩元（${krClose} 不该出现）`,
    !krRow.includes(show(krClose)) && !krRow.includes(String(krClose)),
    krRow.slice(0, 140),
  );
  check("候选里标了「韩元」", krRow.includes("韩元"), krRow.slice(0, 140));

  console.log("\n五、日股下单卡按日股口径");
  await evaluate(TYPE("#game-code", jp.code));
  await evaluate(TYPE("#game-shares", "100"));
  check("填完代码与股数就出下单预览", await waitFor(`document.body.innerText.includes("预计成交价")`, "下单预览", 20));
  let text = await evaluate<string>(`return document.body.innerText;`);
  check(`标的行是 ${jp.code} ${jp.name}`, text.includes(`${jp.code} ${jp.name}`), text.slice(0, 200));
  check("副标题写「日股 T+0」", text.includes("日股 T+0"), "");
  check("副标题写「一手 100 股（単元株）」", text.includes("一手 100 股"), "");
  check("股数提示提到 100 股整数倍（単元株）", text.includes("単元株"), "");
  check(
    "日股零佣金（手续费 0）",
    text.includes("手续费 0 元"),
    text.includes("手续费") ? text.slice(text.indexOf("手续费"), text.indexOf("手续费") + 30) : "没有手续费行",
  );

  console.log("\n六、韩股下单卡按韩股口径");
  await evaluate(TYPE("#game-code", kr.code));
  await evaluate(TYPE("#game-shares", "100"));
  await sleep(500);
  text = await evaluate<string>(`return document.body.innerText;`);
  check(`标的行是 ${kr.code} ${kr.name}`, text.includes(`${kr.code} ${kr.name}`), text.slice(0, 200));
  check("副标题写「韩股 T+0」", text.includes("韩股 T+0"), "");
  check("副标题写「证券交易税」而不是「印花税」", text.includes("证券交易税"), "");
  check("股数提示写「韩股 1 股起，没有整手要求」", text.includes("1 股起，没有整手要求"), "");
  check("副标题不再声称「一手 100 股」", !text.includes("一手 100 股"), "");

  console.log("\n七、A 股这条路径没被改坏");
  const cnTarget =
    rows.find((r) => r.code === "600519.SH" && lastClose(r.close) !== null) ??
    rows.find((r) => (r.code.endsWith(".SH") || r.code.endsWith(".SZ")) && lastClose(r.close) !== null);
  if (!cnTarget) throw new Error("快照里没有可用的 A 股靶子");
  const cnClose = lastClose(cnTarget.close) as number;
  await evaluate(TYPE("#game-code", cnTarget.code));
  await evaluate(TYPE("#game-shares", "100"));
  await sleep(500);
  const cn = await evaluate<string>(`return document.body.innerText;`);
  check("A 股仍走 T+1 文案", cn.includes("T+1：当日买入次日才可卖"), "");
  /* 3% 容差：A 股真被折算了的话差的是整个汇率，远不止 3% */
  const cnRef = Number((/参考价\s*([\d.]+)/.exec(cn) ?? [])[1]);
  check(
    `A 股价格没被折算（卡上 ${cnRef}，快照收盘 ${cnClose}，${cnTarget.code}）`,
    Number.isFinite(cnRef) && cnRef > 0 && Math.abs(cnRef - cnClose) / cnClose <= 0.03,
    cn.includes(cnTarget.code) ? cn.slice(cn.indexOf(cnTarget.code), cn.indexOf(cnTarget.code) + 60) : `没有 ${cnTarget.code} 那一行`,
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
