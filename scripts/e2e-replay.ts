/**
 * 真正在浏览器里点一遍历史推演（Edge 无头 + CDP）。
 *
 * 单元测试能证明引擎算得对，视图冒烟能证明它渲染得出来，但都证明不了
 * 「点下去有没有反应」—— 事件处理、状态提升、存档读写这一段只有真浏览器能验。
 * 不装 playwright：Node 22+ 自带 WebSocket，直接说 CDP 协议。
 *
 *   npx vite-node scripts/e2e-replay.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LEVELS } from "@aw/game";

const ROOT = process.cwd();
const DIST = join(ROOT, "apps/web/dist");
const EDGE = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const PORT = 9223;
const BASE = `http://127.0.0.1:${PORT}`;

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

// ── 起静态服务器 ─────────────────────────────────────────────
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
  cwd: DIST,
  stdio: "ignore",
});
let browser: ChildProcess | null = null;

function cleanup(): void {
  browser?.kill("SIGKILL");
  server.kill("SIGKILL");
}
process.on("exit", cleanup);

// ── 起浏览器 ─────────────────────────────────────────────────
// 每次都从干净的 profile 开始：否则上一轮留下的存档会让页面直接进推演，
// 跳过开局界面，测出来的是上一轮的状态
rmSync("/tmp/edge-e2e-replay", { recursive: true, force: true });

browser = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${PORT + 1000}`,
  "--user-data-dir=/tmp/edge-e2e-replay",
  "--window-size=430,900",
  `http://127.0.0.1:${PORT}/`,
], { stdio: "ignore" });

// ── CDP 客户端 ───────────────────────────────────────────────
type Target = { type: string; url: string; webSocketDebuggerUrl: string };

async function findPage(): Promise<Target> {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 1000}/json`);
      const list = (await res.json()) as Target[];
      const page = list.find((t) => t.type === "page" && t.url.includes(`:${PORT}`));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error("找不到浏览器页面");
}

const target = await findPage();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => {
  ws.addEventListener("open", () => resolve(), { once: true });
  ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
});

let msgId = 0;
const pending = new Map<number, (v: unknown) => void>();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(String((ev as MessageEvent).data)) as { id?: number; result?: unknown };
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)!(msg.result);
    pending.delete(msg.id);
  }
});

function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  msgId += 1;
  const id = msgId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** 在页面里求值，返回 JSON 化的结果 */
async function evaluate<T = unknown>(expr: string): Promise<T> {
  const res = (await send("Runtime.evaluate", {
    expression: `(() => { ${expr} })()`,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "求值失败");
  }
  return res.result?.value as T;
}

/** 按可见文字点按钮 */
const CLICK = (text: string) => `
  const btns = [...document.querySelectorAll("button")];
  const b = btns.find(x => x.textContent && x.textContent.includes(${JSON.stringify(text)}));
  if (!b) return "NOT_FOUND";
  b.click();
  return "OK";
`;

async function waitFor(expr: string, label: string, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i += 1) {
    if (await evaluate<boolean>(`return ${expr};`)) return true;
    await sleep(250);
  }
  console.log(`    （等待超时：${label}）`);
  return false;
}

try {
  await send("Runtime.enable");
  await sleep(1200);

  console.log("\n一、页面加载");
  // 双保险：profile 之外的 localStorage 也清一遍
  await evaluate(`try { localStorage.clear(); } catch {} return true;`);
  await send("Page.enable");
  await send("Page.reload", { ignoreCache: true });
  await sleep(1500);
  const loaded = await waitFor(
    `document.body.innerText.includes("A 股趋势筛选工作台")`,
    "标题出现",
  );
  check("页面渲染出标题", loaded);
  check(
    "没有抛出运行时错误（快照加载完成，不是加载态）",
    await waitFor(`!document.body.innerText.includes("正在加载")`, "加载完成"),
  );

  console.log("\n二、进入模拟盘");
  await evaluate(CLICK("模拟盘"));
  await sleep(400);
  const inGame = await waitFor(
    `document.body.innerText.includes("模拟盘")`,
    "模拟盘页出现",
  );
  check("切到模拟盘页", inGame);
  check(
    "看到历史推演入口",
    await evaluate<boolean>(`return document.body.innerText.includes("另一种玩法") || document.body.innerText.includes("历史推演");`),
  );

  console.log("\n三、开局");
  const clicked = await evaluate<string>(CLICK("随机开局"));
  check("点得到「随机开局」按钮", clicked === "OK", clicked);
  await sleep(600);
  const opened = await waitFor(
    `document.body.innerText.includes("待成交委托") && document.body.innerText.includes("走一天")`,
    "推演界面出现",
  );
  check("进入了推演界面", opened);
  const leaked = await evaluate<string[]>(`return document.body.innerText.match(/20\\d\\d-\\d\\d-\\d\\d/g) || [];`);
  check("整页找不到日期（随机模式不剧透）", leaked.length === 0, leaked.slice(0, 5).join(", "));
  check(
    "显示第几天",
    await evaluate<boolean>(`return /第\\s*\\d+\\s*天/.test(document.body.innerText);`),
  );
  check(
    "常驻免责声明",
    await evaluate<boolean>(`return document.body.innerText.includes("不构成投资建议");`),
  );

  console.log("\n四、挂单 → 走一天 → 成交");
  const before = await evaluate<string>(`return document.body.innerText;`);
  const cashBefore = Number((before.match(/可用现金\s*¥?([\d,]+(?:\.\d+)?)/) ?? [])[1]?.replace(/,/g, "") ?? NaN);

  // 填股票代码与股数，再点挂单
  const fill = await evaluate<string>(`
    const codeInput = document.querySelector('input[list], input[placeholder*="代码"], input[placeholder*="名称"]');
    if (!codeInput) return "NO_CODE_INPUT";
    const first = document.querySelector('datalist option');
    const code = first ? first.getAttribute("value") : null;
    if (!code) return "NO_OPTION";
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(codeInput, code);
    codeInput.dispatchEvent(new Event("input", { bubbles: true }));
    const numInput = [...document.querySelectorAll('input[type="number"]')].pop();
    if (!numInput) return "NO_QTY_INPUT";
    setter.call(numInput, "100");
    numInput.dispatchEvent(new Event("input", { bubbles: true }));
    return code;
  `);
  check("填得进标的与股数", !fill.startsWith("NO_"), fill);

  const placed = await evaluate<string>(CLICK("挂单"));
  check("点得到「挂单」按钮", placed === "OK", placed);
  await sleep(400);
  check(
    "委托出现在待成交列表里（挂单不等于成交）",
    await evaluate<boolean>(`return document.body.innerText.includes("待成交委托") && document.body.innerText.includes(${JSON.stringify(fill)});`),
  );

  const step = await evaluate<string>(CLICK("走一天"));
  check("点得到「走一天」", step === "OK", step);
  await sleep(600);
  const after = await evaluate<string>(`return document.body.innerText;`);
  check("走一天后日志里出现了成交记录", /推演日志/.test(after) && /买入|卖出/.test(after) && after !== before);
  check(
    "成交价注明了来自开盘价",
    after.includes("开盘价"),
  );
  check(
    "藏日期的时候日志也只给第几天，不给年月日",
    !/20\d\d-\d\d-\d\d/.test(after),
    (after.match(/20\d\d-\d\d-\d\d/g) ?? []).slice(0, 3).join(", "),
  );

  console.log("\n五、刷新后能续上（存档）");
  await send("Page.enable");
  await send("Page.reload", { ignoreCache: true });
  await sleep(1800);
  await waitFor(`document.body.innerText.includes("A 股趋势筛选工作台")`, "重新加载");
  await evaluate(CLICK("模拟盘"));
  await sleep(600);
  const resumed = await waitFor(
    `document.body.innerText.includes("走一天") && document.body.innerText.includes("推演日志")`,
    "推演被还原",
  );
  check("刷新后回到推演界面而不是开局页", resumed);
  check(
    "刷新后成交记录还在",
    await evaluate<boolean>(`return document.body.innerText.includes("推演日志") && document.body.innerText.includes("开盘价");`),
  );
  check(
    "刷新后依然不给日期",
    await evaluate<boolean>(`return !/20\d\d-\d\d-\d\d/.test(document.body.innerText);`),
  );

  console.log("\n六、结算");
  const settle = await evaluate<string>(CLICK("结算本局"));
  check("点得到「结算本局」", settle === "OK", settle);
  await sleep(600);
  const settled = await evaluate<string>(`return document.body.innerText;`);
  check("结算后给出收益率", /收益率|总收益/.test(settled), settled.slice(0, 120));
  check(
    "结算也不交出日期（否则可以先结算偷看一眼再接着玩）",
    !/20\d\d-\d\d-\d\d/.test(settled),
    (settled.match(/20\d\d-\d\d-\d\d/g) ?? []).slice(0, 3).join(", "),
  );
  check("结算给出的是第几天区间", /第 1 天/.test(settled));
  check(
    "结算里没有承诺性措辞",
    !["必涨", "必跌", "稳赚", "包赚"].some((w) => settled.includes(w)),
  );

  console.log("\n七、传奇模式：选一关 → 开局简报 → 带日期推演");
  // 「退出推演」会弹 confirm；无头浏览器默认返回 false，先把它改掉
  await evaluate(`window.confirm = () => true; return "OK";`);
  const exited = await evaluate<string>(CLICK("退出推演"));
  check("点得到「退出推演」", exited === "OK", exited);
  await sleep(700);
  check(
    "退出后回到开局界面",
    await waitFor(`document.body.innerText.includes("另一种玩法") || document.body.innerText.includes("传奇模式")`, "回到开局"),
  );

  const openLegend = await evaluate<string>(CLICK("传奇模式"));
  check("点得到「传奇模式」入口", openLegend === "OK", openLegend);
  check(
    "关卡列表出来了",
    await waitFor(`document.body.innerText.includes("2016-11-01")`, "关卡列表"),
  );
  const listText = await evaluate<string>(`return document.body.innerText;`);
  // 十关的入场日都应该在列表上（传奇模式恰恰要把日期亮出来）
  const missing = LEVELS.filter((l) => !listText.includes(l.startDate));
  check("十关的入场日期全部列出来", missing.length === 0, missing.map((l) => l.startDate).join(", "));

  // 第 4 关：2020 年春节那一关
  const level = LEVELS.find((l) => l.id === "2020-02-03")!;
  const openLevel = await evaluate<string>(CLICK(level.title));
  check(`点得到第 ${level.order} 关「${level.title}」`, openLevel === "OK", openLevel);
  await sleep(500);
  const brief = await evaluate<string>(`return document.body.innerText;`);
  check("简报页显示进场日期（传奇模式不藏）", brief.includes(level.startDate), level.startDate);
  check("简报页有「进场那天能看到的」", brief.includes("进场那天能看到的"));
  check("简报每一条都渲染出来了", level.briefing.every((line) => brief.includes(line)));
  check("思考题也渲染出来了", brief.includes(level.theme.slice(0, 12)));

  const enter = await evaluate<string>(CLICK(`进入 ${level.startDate}`));
  check("点得到「进入」按钮", enter === "OK", enter);
  const inLevel = await waitFor(
    `document.body.innerText.includes("待成交委托") && document.body.innerText.includes("走一天")`,
    "关卡载入",
  );
  check("载入了这一关的行情并进入推演", inLevel);

  const levelText = await evaluate<string>(`return document.body.innerText;`);
  check(
    "这一关的日历起点与关卡定义一致",
    levelText.includes(level.startDate),
    (levelText.match(/20\d\d-\d\d-\d\d/g) ?? []).slice(0, 4).join(", "),
  );
  check(
    "开局简报也带在推演页上",
    levelText.includes("进场那天能看到的") || levelText.includes(level.theme.slice(0, 12)),
  );
  /**
   * 股票池必须来自分片，不是当前快照。
   *
   * 只能查 datalist：股票名不会出现在可见文字里（option 不进 innerText）。
   * 读磁盘上那一关的分片，把「当年成交额居前」的代码拿出来对。
   */
  const shard = JSON.parse(
    readFileSync(join(ROOT, "data/history", `level-${level.id}.json`), "utf-8"),
  ) as { instruments: Array<{ code: string }> };
  const options = await evaluate<string[]>(`
    return [...document.querySelectorAll('datalist option')].map(o => o.getAttribute("value"));
  `);
  check(
    "datalist 里的标的数量与分片一致（不是当前快照那 600 多只）",
    options.length === shard.instruments.length,
    `页面 ${options.length} 只，分片 ${shard.instruments.length} 只`,
  );
  const want = shard.instruments.slice(0, 5).map((i) => i.code);
  check(
    "当年成交额居前的票在页面上下得出来",
    want.every((c) => options.includes(c)),
    `期望 ${want.join(", ")}；页面 ${options.slice(0, 5).join(", ")}`,
  );

  console.log("\n八、在关卡里下单并推进一步");
  const lvCode = await evaluate<string>(`
    const codeInput = document.querySelector('input[list], input[placeholder*="代码"], input[placeholder*="名称"]');
    if (!codeInput) return "NO_CODE_INPUT";
    const first = document.querySelector('datalist option');
    const code = first ? first.getAttribute("value") : null;
    if (!code) return "NO_OPTION";
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(codeInput, code);
    codeInput.dispatchEvent(new Event("input", { bubbles: true }));
    const numInput = [...document.querySelectorAll('input[type="number"]')].pop();
    if (!numInput) return "NO_QTY_INPUT";
    setter.call(numInput, "100");
    numInput.dispatchEvent(new Event("input", { bubbles: true }));
    return code;
  `);
  check("关卡里填得进标的与股数", !lvCode.startsWith("NO_"), lvCode);
  await evaluate(CLICK("挂单"));
  await sleep(400);
  await evaluate(CLICK("走一天"));
  await sleep(700);
  const lvAfter = await evaluate<string>(`return document.body.innerText;`);
  check("走一天后成交，并注明价格来自开盘价", lvAfter.includes("开盘价"), lvAfter.slice(0, 100));

  console.log("\n九、刷新后回到同一关（存档里存了 levelId）");
  await send("Page.enable");
  await send("Page.reload", { ignoreCache: true });
  await sleep(2000);
  await waitFor(`document.body.innerText.includes("A 股趋势筛选工作台")`, "重新加载");
  await evaluate(CLICK("模拟盘"));
  await sleep(800);
  check(
    "刷新后还在推演里，没有退回关卡列表",
    await waitFor(`document.body.innerText.includes("走一天")`, "关卡被还原"),
  );
  const restored = await evaluate<string>(`return document.body.innerText;`);
  check("还原的是同一关（能看到这一关的日期）", restored.includes(level.startDate));
  check("成交记录还在", restored.includes("开盘价") || restored.includes("推演日志"));

  console.log("\n十、回到模拟盘：你不在的这段时间");
  // 回到模拟盘页（前面几节都在历史推演里）
  await evaluate(`window.confirm = () => true; return true;`);
  await evaluate(CLICK("退出推演"));
  await sleep(600);
  await evaluate(CLICK("模拟盘"));
  await sleep(600);

  /**
   * 直接塞一份存档：有持仓、有净值点，而且 lastMark 是三天前的。
   *
   * 为什么不「先下单再等三天」：这个报告的前提就是时间流逝，
   * 浏览器里没法等。塞存档是唯一能在一次运行里验到它的办法。
   * 塞的是 App 真正读取的那个 key（aw.game.v1），走的是真实的解析路径。
   */
  const seeded = {
    version: 1,
    status: "playing",
    startedAt: Date.now() - 5 * 86400_000,
    account: {
      initialCash: 200_000,
      cash: 100_000,
      holdings: [{ code: "600519.SH", name: "贵州茅台", shares: 100, sellable: 100, avgCost: 1000 }],
      trades: [
        {
          id: "e2e-away-1", at: Date.now() - 5 * 86400_000, date: "2026-09-18",
          code: "600519.SH", name: "贵州茅台", side: "buy",
          price: 1000, shares: 100, amount: 100_000, fee: 30, typeAtTrade: "趋势观察",
        },
      ],
      seasons: [],
    },
    equity: [
      { date: "2026-09-18", total: 200_000 },
      { date: "2026-09-22", total: 205_000 },
    ],
    lastMark: {
      at: Date.now() - 3 * 86400_000,
      cash: 100_000,
      positions: [{ code: "600519.SH", name: "贵州茅台", shares: 100, price: 900 }],
    },
  };
  await evaluate(
    `localStorage.setItem("aw.game.v1", ${JSON.stringify(JSON.stringify(seeded))}); return true;`,
  );
  await send("Page.enable");
  await send("Page.reload", { ignoreCache: true });
  await sleep(1800);
  await waitFor(`!document.body.innerText.includes("正在加载")`, "加载完成");
  await evaluate(CLICK("模拟盘"));
  await sleep(800);

  const awayShown = await waitFor(
    `document.body.innerText.includes("你不在的这段时间")`,
    "离开报告出现",
  );
  check("三天前离开的持仓会报「你不在的这段时间」", awayShown);
  const awayText = await evaluate<string>(`return document.body.innerText;`);
  check("显示离开时长", /离开\s*3\s*天/.test(awayText), awayText.slice(0, 120));
  check("逐条列出持仓的前后价格（900 → 现值）", awayText.includes("900"));
  check("说清这是两次估值的差", awayText.includes("两次估值的差"));
  check("点掉之后卡片消失", (await evaluate<string>(CLICK("知道了"))) === "OK");
  await sleep(400);
  check(
    "点掉之后确实不再显示",
    !(await evaluate<boolean>(`return document.body.innerText.includes("你不在的这段时间");`)),
  );

  console.log("\n十一、结算复盘报告");
  const settleClick = await evaluate<string>(CLICK("结算本季"));
  check("点得到「结算本季」", settleClick === "OK", settleClick);
  await sleep(500);
  const reviewShown = await waitFor(
    `document.body.innerText.includes("别把这张表当成评分")`,
    "复盘出现",
  );
  check("结算后出现复盘报告", reviewShown);
  const reviewText = await evaluate<string>(`return document.body.innerText;`);
  check("逐笔列出当时的分类", reviewText.includes("当时「趋势观察」"));
  check("标出方向和分类对不对得上", reviewText.includes("与当时分类同向"));
  check("成交后涨跌用的是结算时的价", reviewText.includes("成交后"));
  check(
    "必须写明引擎没有测出优势（否则会被当成「跟引擎一致才是玩对了」）",
    reviewText.includes("没有测出优势"),
  );
  check("写明不是对错", reviewText.includes("不是对错"));
  check(
    "复盘里不出现褒贬词",
    !["判断正确", "判断错误", "英明", "失误", "应该买", "应该卖"].some((w) => reviewText.includes(w)),
  );
  const reviewMeta = await evaluate<string>(
    `return JSON.stringify([...document.querySelectorAll(".review-row")].length);`,
  );
  check("复盘里至少列出那一笔成交", Number(JSON.parse(reviewMeta)) >= 1, reviewMeta);

  console.log("\n十二、控制台没有报错");
  const errs = await evaluate<string[]>(`
    return (window.__e2eErrors || []);
  `);
  check("页面未记录到未捕获异常", Array.isArray(errs) && errs.length === 0, JSON.stringify(errs));
} finally {
  ws.close();
  cleanup();
}

console.log(`\n${"─".repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log("\n失败详情：");
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log("浏览器里的历史推演跑通了。\n");
