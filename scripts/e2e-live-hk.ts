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
 * 期望值**从页面自己加载的那份快照里现算**，不写死数字。
 *
 * 为什么：`data/snapshot_*` 每天被 CI 的 `update-snapshot.yml` 换掉一次，收盘价每天都在动，
 * 汇率甚至一天一个报价。断言里一旦写死「431.0 港币 × 0.8584 = 369.97」，第二天就全红 ——
 * 而它红的不是代码坏了，是**数据换了**（实测：快照换成 `snapshot_20261009` 后，
 * 港股池从 20 只缩到 14 只、腾讯 `00700.HK` 整个不在里面了，写死的断言一次挂掉 11 条）。
 *
 * 所以这里只钉**结构与接线**：港股进得了候选、价格确实被折算过、下单卡走的是港股费率。
 * 算式本身由 `packages/game` 的单测覆盖，这里直接用同一个 `previewOrder` 算期望值 ——
 * 验证的是**界面接到了同一个引擎**，不是把数学重算一遍。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { previewOrder } from "@aw/game";

/** 港股里优先拿这几只当靶子（盘子大、常年都在池子里）；都不在就退而求其次拿任意一只有收盘价的 */
const HK_PREFERRED = ["00939.HK", "01299.HK", "00941.HK", "00005.HK", "00388.HK"];

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
/**
 * 页面上「今天」用的是北京时间（`useLiveQuotes` 的 `beijingTime().iso`），
 * 费率档位按它选（印花税 2023-08-28 减半、港股 2021-08-01 与 2023-11-17 各调过一次），
 * 所以这里也得用同一个口径，不能用机器本地时区。
 */
function beijingToday(): string {
  // en-CA 的短日期格式正好是 YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

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
  check("页面渲染出标题", await waitFor(`document.body.innerText.includes("股市练习场")`, "标题"));
  check("快照加载完成", await waitFor(`!document.body.innerText.includes("正在加载")`, "加载完成"));

  /*
   * 现读快照，算出这一趟要比对的期望值。读的是**服务上真的那份**（`data/latest.json`
   * 指向哪个目录就读哪个），不是仓库根 `data/` 里那份 —— 页面用的就是前者。
   */
  const snapName = ((await (await fetch(`${BASE}data/latest.json`)).json()) as { snapshot: string }).snapshot;
  const meta = (await (await fetch(`${BASE}data/${snapName}/meta.json`)).json()) as {
    hk?: { fx?: { rate?: number }; count?: number };
  };
  /* `stocks.json` 是裸数组（早期的副本曾经包成 `{stocks: []}`，两种都认） */
  const rawStocks = await (await fetch(`${BASE}data/${snapName}/stocks.json`)).json();
  const rows: SnapStock[] = Array.isArray(rawStocks) ? rawStocks : rawStocks.stocks;
  const hkRows = rows.filter((r) => r.code.endsWith(".HK"));
  const fxRate = meta.hk?.fx?.rate ?? null;
  check(`快照 ${snapName} 里有港股（${hkRows.length} 只）`, hkRows.length > 0, `meta.hk.count=${meta.hk?.count}`);
  check("快照带港币汇率（缺了下单卡会按 1:1 算错最低佣金）", typeof fxRate === "number" && fxRate > 0, String(fxRate));
  const target =
    HK_PREFERRED.map((c) => hkRows.find((r) => r.code === c && lastClose(r.close) !== null)).find(Boolean) ??
    hkRows.find((r) => lastClose(r.close) !== null);
  if (!target || typeof fxRate !== "number") throw new Error("快照里没有可用的港股靶子，先确认 sync_web_data 跑过");
  const rawClose = lastClose(target.close) as number;
  /** 折算后的参考价。与 `fmtNum` 一致：两位小数（先 toFixed 再 Number，尾随 0 会去掉） */
  const refCny = Number((rawClose * fxRate).toFixed(2));
  const expected = previewOrder(refCny, "buy", 100, beijingToday(), { market: "HK", fx: fxRate });
  const show = (n: number) => String(Number(n.toFixed(2)));
  console.log(
    `    靶子 ${target.code} ${target.name}：收盘 ${rawClose} 港币 × ${fxRate} = ${show(refCny)} 元` +
      ` → 预计成交 ${show(expected.price)} · 金额 ${show(expected.amount)} · 手续费 ${show(expected.fee.total)}`,
  );

  console.log("\n二、进实时盘（游戏大厅是默认视图）");
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

  console.log("\n三、港股进得了候选清单，价格已折成人民币");
  await evaluate(TYPE("#game-code", target.code.split(".")[0]));
  const listed = await waitFor(`document.body.innerText.includes(${JSON.stringify(target.name)})`, `${target.name} 出现在候选里`, 20);
  check(`候选清单里有${target.name}（港股确实进页面了）`, listed, "候选空的话多半是 public/data 没同步");
  const pickText = await evaluate<string>(`
    const row = [...document.querySelectorAll(".pick-row")].find(
      (x) => x.textContent.includes(${JSON.stringify(target.name)}),
    );
    return row ? row.textContent : "";
  `);
  check(
    `候选里显示折成人民币的 ${show(refCny)}（= ${rawClose} 港币 × ${fxRate}）`,
    pickText.includes(show(refCny)),
    pickText.slice(0, 120),
  );
  check("候选里标了「港币」", pickText.includes("港币"), pickText.slice(0, 120));

  console.log("\n四、下单卡按港股口径算");
  await evaluate(TYPE("#game-code", target.code));
  await evaluate(TYPE("#game-shares", "100"));
  const card = await waitFor(`document.body.innerText.includes("预计成交价")`, "下单预览", 20);
  check("填完代码与股数就出下单预览", card);
  const text = await evaluate<string>(`return document.body.innerText;`);
  check(`标的行是 ${target.code} ${target.name}`, text.includes(`${target.code} ${target.name}`), text.slice(0, 200));
  /*
   * 参考价从卡片自己读，再拿它喂 `previewOrder` 算期望值。
   * 不直接拿快照收盘价当输入：盘中跑这一趟时实时行情会把它拽走几点，断言会跟着行情抖。
   * 「折算到底有没有发生」由下面那条 3% 容差断言负责 —— 真没折算的话，
   * 卡上会是 ${rawClose} 港币原价，与折算后的 ${show(refCny)} 差着汇率那 14%，必然被抓。
   */
  const refShown = Number((/参考价\s*([\d.]+)/.exec(text) ?? [])[1]);
  check("下单卡里读得到参考价", Number.isFinite(refShown) && refShown > 0, text.slice(text.indexOf("参考价"), text.indexOf("参考价") + 30));
  check(
    `参考价与「快照收盘 × 汇率」差不到 3%（卡上 ${refShown} vs 折算后的 ${show(refCny)}）`,
    Math.abs(refShown - refCny) / refCny <= 0.03,
    `卡上 ${refShown}，快照算出来 ${show(refCny)}`,
  );
  const cardExp = previewOrder(refShown, "buy", 100, beijingToday(), { market: "HK", fx: fxRate });
  check(`预计成交价 ${show(cardExp.price)}（参考价 + 0.1% 滑点）`, text.includes(show(cardExp.price)), "");
  check(`预计金额 ${show(cardExp.amount)}`, text.includes(show(cardExp.amount)), "");
  check(
    `手续费 ${show(cardExp.fee.total)}（港股 0.25%/最低 100 港元 + 0.1% 双向印花税，折成人民币）`,
    text.includes(show(cardExp.fee.total)),
    text.includes("手续费") ? text.slice(text.indexOf("手续费"), text.indexOf("手续费") + 40) : "没有手续费行",
  );
  check("下单卡副标题写 T+0（港股当日可卖，不是 T+1）", text.includes("港股 T+0"), "");
  check("下单卡副标题不再声称「一手 100 股」", !text.includes("一手 100 股"), "");

  console.log("\n五、A 股这条路径没被改坏");
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
  /* 同样是 3% 容差：A 股折算了的话会变成 close × 某个汇率，差得远不止 3% */
  const cnRef = Number((/参考价\s*([\d.]+)/.exec(cn) ?? [])[1]);
  check(
    `A 股价格没被折算（卡上 ${cnRef}，快照收盘 ${cnClose}，${cnTarget.code}）`,
    Number.isFinite(cnRef) && cnRef > 0 && Math.abs(cnRef - cnClose) / cnClose <= 0.03,
    cn.includes(cnTarget.code) ? cn.slice(cn.indexOf(cnTarget.code), cn.indexOf(cnTarget.code) + 60) : `没有 ${cnTarget.code} 那一行`,
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
