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
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
/** 最新一份快照目录名（`data/snapshot_YYYYMMDD`）。 */
function latestSnapshotDir(): string {
  const dirs = readdirSync(join(ROOT, "data")).filter((d) => /^snapshot_\d{8}$/.test(d)).sort();
  const last = dirs.at(-1);
  if (!last) throw new Error("data/ 下没有 snapshot_YYYYMMDD 目录");
  return last;
}

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

  console.log("\n二、进入模拟游戏");
  await evaluate(CLICK("模拟游戏"));
  await sleep(400);
  const inGame = await waitFor(
    `document.body.innerText.includes("模拟游戏")`,
    "模拟游戏页出现",
  );
  check("切到模拟游戏页", inGame);
  check(
    "看到历史推演入口",
    await evaluate<boolean>(`return document.body.innerText.includes("历史推演");`),
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

  // 填股票代码与股数，再点挂单。
  //
  // 这里**点榜单的第一行**来填，而不是直接往输入框塞代码 —— 选股清单就是为
  // 「玩家不知道买什么」而做的，所以端到端就该从它那里走一遍。
  const fillRaw = await evaluate<string>(`
    const codeInput = document.querySelector('input[placeholder*="代码"], input[placeholder*="名称"]');
    if (!codeInput) return "NO_CODE_INPUT";
    const row = document.querySelector('.pick-row');
    if (!row) return "NO_PICK_ROW";
    const name = row.innerText.split("\\n")[0].trim();
    row.click();
    // 点一下只是改 React state，输入框的值要等这次渲染落地；
    // 同步读会读到空字符串，那是时机问题不是功能问题。
    return new Promise((r) => setTimeout(() => {
      const code = codeInput.value;
      if (!code) return r("PICK_DID_NOT_FILL");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      const numInput = [...document.querySelectorAll('input[type="number"]')].pop();
      if (!numInput) return r("NO_QTY_INPUT");
      setter.call(numInput, "100");
      numInput.dispatchEvent(new Event("input", { bubbles: true }));
      r("OK:" + code + ":" + name);
    }, 250));
  `);
  check("填得进标的与股数", fillRaw.startsWith("OK:"), fillRaw);
  // 待成交列表显示的是名字不是代码（见 ReplayView 的 pending 渲染）
  const fillName = fillRaw.split(":")[2] ?? "";
  const fillCode = fillRaw.split(":")[1] ?? "";

  const placed = await evaluate<string>(CLICK("挂单"));
  check("点得到「挂单」按钮", placed === "OK", placed);
  await sleep(400);
  const pendingText = await evaluate<string>(`return document.body.innerText;`);
  check(
    "委托挂在待成交列表里，还没有成交",
    pendingText.includes("待成交委托") &&
      pendingText.includes(fillName) &&
      !new RegExp(`已成交[\\s\\S]{0,200}${fillName}`).test(pendingText),
    `填的是 ${fillCode} ${fillName}`,
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
  await evaluate(CLICK("模拟游戏"));
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
    await waitFor(`document.body.innerText.includes("传奇模式") || document.body.innerText.includes("历史推演")`, "回到开局"),
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
   * 榜单只显示前 8 行，所以没法靠数 DOM 来核对整池。改用一个更强的办法：
   * 拿一只**当前快照里有、但那一关的分片里没有**的票去搜，页面上必须说「没找到」。
   * 如果池子错用了当前快照，这只票就会被搜出来，测试当场失败。
   */
  const shard = JSON.parse(
    readFileSync(join(ROOT, "data/history", `level-${level.id}.json`), "utf-8"),
  ) as { instruments: Array<{ code: string; name: string }> };
  const shardCodes = new Set(shard.instruments.map((i) => i.code));
  const snapshotStocks = JSON.parse(
    readFileSync(join(ROOT, "data", latestSnapshotDir(), "stocks.json"), "utf-8"),
  ) as Array<{ code: string; name: string }>;
  const notYet = snapshotStocks.find((s) => !shardCodes.has(s.code));

  const pickCount = await evaluate<number>(`return document.querySelectorAll('.pick-row').length;`);
  check("下单卡里列出了候选股票（不是让人对着空白框发呆）", pickCount > 0, `${pickCount} 行`);

  if (notYet) {
    const searched = await evaluate<string>(`
      const input = document.querySelector('input[placeholder*="代码"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, ${JSON.stringify(notYet.name)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return new Promise(r => setTimeout(() => r(document.body.innerText), 200));
    `);
    check(
      `当前快照里的 ${notYet.name}（${notYet.code}）在这一关搜不到`,
      searched.includes("没找到这只票"),
      notYet.code,
    );
  } else {
    check("能在当前快照里找到一只当时还没上市的票", false, "快照与分片完全重合，样本无效");
  }

  await evaluate<string>(`
    const input = document.querySelector('input[placeholder*="代码"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return "OK";
  `);
  /**
   * 榜单上的每一只都必须在那一关的分片里。
   *
   * 界面上只显示 6 位代码（后缀在榜单里是噪音），所以拿数字前缀去对。
   */
  const shownCodes = await evaluate<string[]>(`
    return [...document.querySelectorAll('.pick-code')].map(e => e.textContent.trim());
  `);
  const shardPrefixes = new Set(shard.instruments.map((i) => i.code.split(".")[0]));
  const stray = shownCodes.filter((c) => !shardPrefixes.has(c));
  check(
    "榜单上的每一只都来自这一关的分片",
    shownCodes.length > 0 && stray.length === 0,
    `页面 ${shownCodes.join(", ")}；不在分片里的：${stray.join(", ")}`,
  );

  // 当年成交额居前的那几只，逐个搜名字都应该搜得到
  const want = shard.instruments.slice(0, 3);
  for (const w of want) {
    const found = await evaluate<string>(`
      const input = document.querySelector('input[placeholder*="代码"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, ${JSON.stringify(w.name)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return new Promise(r => setTimeout(() => r(document.body.innerText), 200));
    `);
    check(`搜得到「${w.name}」`, found.includes(w.name), w.code);
  }

  console.log("\n八、在关卡里下单并推进一步");
  const lvCode = await evaluate<string>(`
    const codeInput = document.querySelector('input[placeholder*="代码"], input[placeholder*="名称"]');
    if (!codeInput) return "NO_CODE_INPUT";
    // 点榜单第一行来填：走的是玩家真正会走的那条路
    const row = document.querySelector('.pick-row');
    if (!row) return "NO_PICK_ROW";
    row.click();
    const code = codeInput.value;
    if (!code) return "NO_OPTION";
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
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
  await evaluate(CLICK("模拟游戏"));
  await sleep(800);
  check(
    "刷新后还在推演里，没有退回关卡列表",
    await waitFor(`document.body.innerText.includes("走一天")`, "关卡被还原"),
  );
  const restored = await evaluate<string>(`return document.body.innerText;`);
  check("还原的是同一关（能看到这一关的日期）", restored.includes(level.startDate));
  check("成交记录还在", restored.includes("开盘价") || restored.includes("推演日志"));

  console.log("\n十、回到模拟游戏：你不在的这段时间");
  // 回到模拟游戏页（前面几节都在历史推演里）
  await evaluate(`window.confirm = () => true; return true;`);
  await evaluate(CLICK("退出推演"));
  await sleep(600);
  await evaluate(CLICK("模拟游戏"));
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
  await evaluate(CLICK("模拟游戏"));
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

  /**
   * 实时模式的下单卡也要有候选榜单。
   *
   * 这一条的由来：用户看线上时说「你有一个折叠符号，但是没有给出股票，
   * 玩家很茫然，不知道买什么」—— 那个「折叠符号」就是 `<datalist>` 的箭头，
   * 而它在 iOS Safari 上根本不弹。所以这里盯的是**页面上真的有票**。
   */
  console.log("\n十之二、实时模式的下单候选榜单");
  const livePicks = await evaluate<string>(`
    const rows = [...document.querySelectorAll('.pick-row')];
    return JSON.stringify({ n: rows.length, first: rows[0] ? rows[0].innerText : "" });
  `);
  const livePicksObj = JSON.parse(livePicks) as { n: number; first: string };
  check("实时模式下单卡列出了候选股票", livePicksObj.n > 0, `${livePicksObj.n} 行`);
  check("每一行都带板块和涨跌幅", /[\u4e00-\u9fa5]/.test(livePicksObj.first) && /%/.test(livePicksObj.first), livePicksObj.first.replace(/\n/g, " | "));
  check(
    "榜单下面写明了不是推荐",
    await evaluate<boolean>(`return document.body.innerText.includes("不是推荐");`),
  );

  const clickPick = await evaluate<string>(`
    const row = document.querySelector('.pick-row');
    if (!row) return "NO_ROW";
    row.click();
    const input = document.querySelector('input[placeholder*="代码"]');
    return new Promise(r => setTimeout(() => r(input && input.value ? "OK:" + input.value : "EMPTY"), 200));
  `);
  check("点一行就把代码填进输入框（不直接下单）", clickPick.startsWith("OK:"), clickPick);

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

  console.log("\n十二、板块跳转：点板块跳到该板块的个股");
  await evaluate(CLICK("筛选"));
  await sleep(600);
  // 先滚到板块卡，再点第一个板块 —— 否则本来就在页面顶部，跳不跳看不出来
  await evaluate(`
    const el = document.getElementById("layer-sectors");
    if (el) el.scrollIntoView({ block: "start" });
    return true;
  `);
  await sleep(500);
  const beforeY = await evaluate<number>(`return window.scrollY;`);
  const sectorClick = await evaluate<string>(`
    const el = document.getElementById("layer-sectors");
    if (!el) return "NO_SECTORS";
    const b = [...el.querySelectorAll("button.row-tap")].find(x => x.textContent);
    if (!b) return "NO_ROW";
    b.click();
    return "OK";
  `);
  check("点得到第一个板块", sectorClick === "OK", sectorClick);
  await sleep(1200);
  const afterY = await evaluate<number>(`return window.scrollY;`);
  check(`点板块后页面往下跳了（${Math.round(beforeY)} → ${Math.round(afterY)}）`, afterY > beforeY + 200);

  const landed = await evaluate<string>(`
    const el = document.getElementById("layer-stocks");
    if (!el) return "NO_TARGET";
    const head = document.querySelector(".app-head");
    const headH = head ? head.getBoundingClientRect().height : 0;
    const top = el.getBoundingClientRect().top;
    return JSON.stringify({ top: Math.round(top), headH: Math.round(headH), vh: window.innerHeight });
  `);
  const L = JSON.parse(landed) as { top: number; headH: number; vh: number };
  check(
    `个股卡的标题落在视口里，且没被顶栏挡住（top=${L.top}, 顶栏=${L.headH}, 视口=${L.vh}）`,
    L.top >= L.headH - 4 && L.top < L.vh / 2,
    landed,
  );
  check(
    "跳过去之后确实只显示这个板块",
    await evaluate<boolean>(`return document.body.innerText.includes("已按板块")`),
  );
  check(
    "给得出「回到板块列表」的出口",
    await evaluate<boolean>(`return document.body.innerText.includes("回到板块列表")`),
  );

  // 回头路也要真的走得通：点了要清掉筛选、并滚回板块卡
  const backClick = await evaluate<string>(CLICK("回到板块列表"));
  check("点得到「回到板块列表」", backClick === "OK", backClick);
  await sleep(1200);
  const backY = await evaluate<number>(`return window.scrollY;`);
  check(`点返回后滚回板块（${Math.round(afterY)} → ${Math.round(backY)}）`, backY < afterY - 200);
  check(
    "返回后筛选已清除，第三层恢复成全池",
    await evaluate<boolean>(`
      const t = document.body.innerText;
      return !t.includes("已按板块") && t.includes("全池");
    `),
  );

  console.log("\n十三、卡片可折叠");
  const foldBtn = (label: string) => `[...document.querySelectorAll("button.card-fold")].find(b => b.textContent.includes(${JSON.stringify(label)}))`;
  await evaluate(CLICK("筛选"));
  await sleep(500);
  const h0 = await evaluate<number>(`return document.body.scrollHeight;`);
  const fold2 = await evaluate<string>(`
    const b = ${foldBtn("收起")};
    if (!b) return "NO_BTN";
    b.click();
    return "OK";
  `);
  check("第二层给得出折叠按钮", fold2 === "OK", fold2);
  await sleep(400);
  const h1 = await evaluate<number>(`return document.body.scrollHeight;`);
  check(`折起第二层后页面明显变短（${h0} → ${h1}）`, h1 < h0 - 800);

  const bodyGone = await evaluate<boolean>(`
    const el = document.getElementById("layer-sectors");
    return el !== null && !el.innerText.includes("点此只看该板块");
  `);
  check("折起来之后板块行整块不渲染，不是用 CSS 藏起来", bodyGone);

  await evaluate(`
    const b = ${foldBtn("收起")};
    if (b) b.click();
    return true;
  `);
  await sleep(400);
  const h2 = await evaluate<number>(`return document.body.scrollHeight;`);
  check(`再折起第三层（${h1} → ${h2}）`, h2 < h1 - 300);

  // 折过之后要记住 —— 否则每次打开都得再折一遍，等于没做
  await send("Page.reload", { ignoreCache: true });
  await sleep(3000);
  const remembered = await evaluate<string>(`
    const folded = [...document.querySelectorAll("button.card-fold")].filter(b => b.textContent.includes("展开")).length;
    return JSON.stringify({ folded, h: document.body.scrollHeight });
  `);
  const R = JSON.parse(remembered) as { folded: number; h: number };
  check(`刷新后两层还是折着的（按钮 ${R.folded} 个，高度 ${R.h}）`, R.folded === 2 && R.h < h0);
  check(
    "折着的时候筛选按钮还在（要能清除板块筛选）",
    await evaluate<boolean>(`
      const b = [...document.querySelectorAll("button.card-fold")].find(x => x.textContent.includes("展开"));
      const card = b && b.closest(".card");
      return !!card;
    `),
  );

  // 复原，免得影响后面/下次跑
  await evaluate(`
    for (const b of [...document.querySelectorAll("button.card-fold")]) {
      if (b.textContent.includes("展开")) b.click();
    }
    return true;
  `);
  await sleep(400);
  const h3 = await evaluate<number>(`return document.body.scrollHeight;`);
  check(`展开后恢复原长（${h3}）`, Math.abs(h3 - h0) < 50);

  console.log("\n十三之二、从个股分析空状态点「去筛选」：滚到个股列表并闪一下");

  /**
   * 个股分析页在没选中个股时有个「去筛选」按钮。
   *
   * 只切标签页的话，屏幕上还是原来那张筛选页 —— 用户不知道要往下滚到第三层，
   * 看着像按钮没反应。所以它必须滚过去、闪一下，折着的话还要展开。
   *
   * 空状态只有清空本地数据之后才到得了（选中过的股票不会自己消失），
   * 所以这一节放在最后，前面的存档不再需要了。
   *
   * 这里一律用 waitFor 而不是固定 sleep：清空之后快照要重新拉一遍，
   * 拉多久取决于机器，写死 2500ms 在慢的一次上就会假失败。
   */
  const FLASHING = `(function () {
    const c = document.getElementById("layer-stocks");
    return !!c && c.className.includes("card-flash");
  })()`;
  // 折叠 class 在卡片里的 <header> 上，不在 <section> 上
  const FOLDED = `(function () {
    const c = document.getElementById("layer-stocks");
    return !!c && !!c.querySelector(".card-head-folded");
  })()`;

  await evaluate(CLICK("设置"));
  await waitFor(`document.body.innerText.includes("清空本地数据")`, "设置页打开");
  await evaluate(CLICK("清空本地数据"));
  await waitFor(`document.body.innerText.includes("① 大盘环境")`, "清空后回到筛选页", 60);
  await sleep(1500); // 快照会重新加载

  await evaluate(CLICK("个股分析"));
  check(
    "清空之后个股分析页是空状态",
    await waitFor(`document.body.innerText.includes("还没有选中个股")`, "个股分析空状态", 60),
  );

  const scrollBefore = await evaluate<number>(`return window.scrollY;`);
  await evaluate(CLICK("去筛选"));
  check("点了「去筛选」之后卡片闪起来", await waitFor(FLASHING, "卡片闪起来"));
  /*
   * 滚动用的是 behavior: "smooth"，是**动画**，不是瞬间到位。
   * 只量一次的话，量到的是动画开始前的位置（0），这一条就会随机失败。
   */
  const scrolled = await waitFor(`window.scrollY > ${scrollBefore + 100}`, "页面滚下去");
  const afterJump = await evaluate<string>(`
    const card = document.getElementById("layer-stocks");
    return JSON.stringify({
      y: window.scrollY,
      onWorkbench: document.body.innerText.includes("① 大盘环境"),
      hasCard: !!card,
    });
  `);
  const j = JSON.parse(afterJump) as { y: number; onWorkbench: boolean; hasCard: boolean };
  check("已经切回筛选页", j.onWorkbench && j.hasCard);
  check("页面滚到了个股列表", scrolled && j.y > scrollBefore + 100, `之前 ${scrollBefore}，现在 ${j.y}`);

  check("闪一下就停，不会一直闪下去", await waitFor(`!(${FLASHING})`, "闪完收起"));

  // 折着的时候跳过去要先展开，否则到了那里一眼看不到任何可选的东西
  // 页面上有两个「收起 ▴」（第二层和第三层各一个），得点第三层里那个
  await evaluate(`
    const c = document.getElementById("layer-stocks");
    const b = c && c.querySelector(".card-fold");
    if (!b) return "NOT_FOUND";
    b.click();
    return "OK";
  `);
  check("先折起个股分类", await waitFor(FOLDED, "第三层折起来"));
  await evaluate(CLICK("个股分析"));
  await waitFor(`document.body.innerText.includes("还没有选中个股")`, "再次进入个股分析空状态", 60);
  await evaluate(CLICK("去筛选"));
  check("折着跳过去会自动展开，并照常闪", await waitFor(FLASHING, "展开了并且在闪"));
  check("展开之后不再是折着的", !(await evaluate<boolean>(`return ${FOLDED};`)));

  console.log("\n十三之三、两局并存：实时模式和历史推演互不清空");

  /**
   * 用户提的：先开一局实时模式，中途想玩传奇模式，又不想丢掉实时那边的存档。
   *
   * 两边本来就各存各的（aw.game.v1 / aw.replay.v1），问题出在界面上 ——
   * 推演一旦开局，整页就被 ReplayView 占满，实时那边看不到也回不去。
   * 所以这一节要证明的不只是「存档还在」，而是**切得回去**。
   *
   * 注意上面的「清空本地数据」**不会**动这两个键（它只管设置与历史），
   * 所以这里得自己把两边清干净再开局，否则跑第二次时游戏已经在进行中了。
   */
  await evaluate(`
    localStorage.removeItem("aw.game.v1");
    localStorage.removeItem("aw.replay.v1");
    return "OK";
  `);
  await send("Page.enable");
  await send("Page.reload", { ignoreCache: true });
  await sleep(1800);
  await waitFor(`document.body.innerText.includes("A 股趋势筛选工作台")`, "重新加载");
  await evaluate(CLICK("模拟游戏"));
  check(
    "两边都是空的，回到开局界面",
    await waitFor(`document.body.innerText.includes("以 20 万开始")`, "开局界面", 60),
  );

  // 选 10 万，和默认的 20 万分开，免得后面把「没被动过」看成「被重置了」
  await evaluate(CLICK("10 万"));
  await evaluate(CLICK("以 10 万开始"));
  check(
    "实时模式开局成功",
    await waitFor(`document.body.innerText.includes("账户总览")`, "账户总览"),
  );

  const COEXIST_CASH = `(function () {
    const m = document.body.innerText.match(/可用资金\\n([^\\n]+)/);
    return m ? m[1].trim() : "";
  })()`;
  const coCash0 = await evaluate<string>(`return ${COEXIST_CASH};`);
  // 界面上没有千分位：可用资金显示成 100000
  check("新开局的可用资金就是本金", coCash0.includes("100000"), coCash0);

  // 再开一局历史推演 —— 实时那边不该被动到
  const coexistLevel = LEVELS.find((l) => l.id === "2024-09-25")!;
  await evaluate(CLICK("传奇模式"));
  check(
    "关卡列表出来了",
    await waitFor(`document.body.innerText.includes("${coexistLevel.startDate}")`, "关卡列表"),
  );
  await evaluate(CLICK(coexistLevel.title));
  await sleep(500);
  await evaluate(CLICK(`进入 ${coexistLevel.startDate}`));
  check(
    "推演开局成功",
    await waitFor(
      `document.body.innerText.includes("待成交委托") && document.body.innerText.includes("走一天")`,
      "推演界面",
      60,
    ),
  );

  const coChips = await evaluate<string[]>(`
    return [...document.querySelectorAll(".pane-switch .chip")].map((b) => b.innerText.trim());
  `);
  check("顶上出现了两边的切换条", coChips.length === 2, coChips.join(" | "));
  check(
    "切换条把两边都写清楚了",
    coChips.some((c) => c.includes("实时模式")) && coChips.some((c) => c.includes("历史推演")),
    coChips.join(" | "),
  );

  // 切回实时模式：账户必须还是刚才那一局
  await evaluate(CLICK("实时模式"));
  check(
    "切得回实时模式",
    await waitFor(`document.body.innerText.includes("账户总览")`, "实时模式的账户总览"),
  );
  const coCash1 = await evaluate<string>(`return ${COEXIST_CASH};`);
  check("实时模式的存档没被推演清掉", coCash1 === coCash0, `之前 ${coCash0}，现在 ${coCash1}`);
  check(
    "已经有一局推演在跑时，不再给开局按钮",
    await evaluate<boolean>(`
      const t = document.body.innerText;
      return t.includes("回到正在跑的那一局") && !t.includes("传奇模式 · 10 个历史时刻");
    `),
  );

  // 再切回去
  await evaluate(CLICK("回到正在跑的那一局"));
  check(
    "从卡片上的按钮也能回到推演",
    await waitFor(`document.body.innerText.includes("待成交委托")`, "回到推演界面"),
  );

  // 刷新之后两边都还得在
  await send("Page.enable");
  await send("Page.reload", { ignoreCache: true });
  await sleep(1800);
  await waitFor(`document.body.innerText.includes("A 股趋势筛选工作台")`, "重新加载");
  await evaluate(CLICK("模拟游戏"));
  check(
    "刷新后回到的是推演，不是开局页",
    await waitFor(`document.body.innerText.includes("待成交委托")`, "推演被还原", 60),
  );
  check(
    "刷新后切换条还在",
    (await evaluate<number>(`return document.querySelectorAll(".pane-switch .chip").length;`)) === 2,
  );
  await evaluate(CLICK("实时模式"));
  await waitFor(`document.body.innerText.includes("账户总览")`, "实时模式的账户总览");
  const coCash2 = await evaluate<string>(`return ${COEXIST_CASH};`);
  check("刷新之后实时模式的存档也还在", coCash2 === coCash0, coCash2);

  console.log("\n十四、控制台没有报错");
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
