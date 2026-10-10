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
  // 桌面宽度：本脚本断言的是「整页能看到什么」，而 760px 以下的紧凑布局会把
  // 推演日志、成交委托、简报收进 <details>，把行情/持仓列换成手机分页，整页文本里就没有它们了。
  // 手机布局由 scripts/e2e-mobile.ts 专门覆盖（360/390/430）。
  "--window-size=1280,1400",
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

/**
 * 按可见文字点按钮。
 *
 * **必须把术语按钮（`button.term`）排除掉。** 术语高亮会把界面里的专业词都包成
 * 一个按钮，而它的文字就是那个词本身 —— 比如「待成交委托」卡的空提示写着
 * 「还没有挂单」，于是 `CLICK("挂出")` 会点到那个**解释**按钮上，真正的「挂单」
 * 提交按钮一次都没被按，而 `CLICK` 照样返回 OK。这类按钮不是动作，别让它参与匹配。
 */
const CLICK = (text: string) => `
  const btns = [...document.querySelectorAll("button")].filter(b => !b.classList.contains("term"));
  const b = btns.find(x => x.textContent && x.textContent.includes(${JSON.stringify(text)}));
  if (!b) return "NOT_FOUND";
  b.click();
  return "OK";
`;

/**
 * 按 aria-label 点。
 *
 * 页头右上角那个齿轮没有文字，CLICK() 靠 textContent 找它必然落空 ——
 * 所以图标按钮要单独有一条按无障碍名字找的路径（也顺带证明它真的有无障碍名字）。
 */
/**
 * 展开一个 <details>。
 *
 * 紧凑版把「玩法三步」「股票列表」「开局简报」「走势图」「推演日志」收进了折叠块 ——
 * 折叠时 `innerText` 是空的，所以断言之前必须先点开。这不是绕过测试：
 * 内容本来就该能展开看到，这一步顺带验证它真的展得开。
 */
const OPEN_DETAILS = (selector: string) => `
  const d = document.querySelector(${JSON.stringify(selector)});
  if (!d) return "NO_DETAILS";
  if (!d.open) { const s = d.querySelector("summary"); if (!s) return "NO_SUMMARY"; s.click(); }
  return d.open ? "OK" : "STILL_CLOSED";
`;

const CLICK_LABEL = (label: string) => `
  const b = document.querySelector('button[aria-label=${JSON.stringify(label)}]');
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
    `document.body.innerText.includes("股市练习场")`,
    "标题出现",
  );
  check("页面渲染出标题", loaded);
  check(
    "没有抛出运行时错误（快照加载完成，不是加载态）",
    await waitFor(`!document.body.innerText.includes("正在加载")`, "加载完成"),
  );

  console.log("\n一之二、底部导航只剩三条，设置搬到右上角齿轮");

  /**
   * 用户提的：底栏五格太挤 —— 历史并进个股分析，设置挪到页头齿轮。
   *
   * 这一节查的是**结构**，不是「某个按钮点得动」：底栏多一格少一格，
   * 比按钮失灵更难被发现（点得到别的东西，就以为都对）。
   */
  const tabs = await evaluate<string[]>(`
    return [...document.querySelectorAll(".tabbar button")].map((b) => b.innerText.trim());
  `);
  check("底栏只剩三条", tabs.length === 3, tabs.join(" | "));
  check(
    "底栏是游戏大厅 / 市场观察 / 学习笔记",
    tabs.join("|") === "游戏大厅|市场观察|学习笔记",
    tabs.join(" | "),
  );
  check(
    "历史与设置都不在底栏",
    !tabs.some((t) => t.includes("历史")) && !tabs.some((t) => t.includes("设置")),
    tabs.join(" | "),
  );

  const gearClick = await evaluate<string>(CLICK_LABEL("设置"));
  check("页头找得到齿轮（靠 aria-label，图标没有文字）", gearClick === "OK", gearClick);
  check(
    "点齿轮进设置页",
    await waitFor(`document.body.innerText.includes("清空本地数据")`, "设置页打开"),
  );
  check(
    "设置页自带返回按钮（它不在底栏，否则回不去）",
    await evaluate<boolean>(`return document.body.innerText.includes("← 返回");`),
  );
  check(
    "设置不是底栏的一格，所以三条都不高亮",
    (await evaluate<number>(`return document.querySelectorAll(".tabbar .tab-active").length;`)) === 0,
  );
  await evaluate(CLICK("← 返回"));
  check(
    // 重设计之后落地页是游戏大厅（底栏第一格），进设置之前就在这一页，返回自然回这里
    "返回之后回到进来之前的那一页（落地页是游戏大厅）",
    await waitFor(`document.body.innerText.includes("选一种玩法")`, "游戏大厅", 60),
  );

  console.log("\n二、进入游戏大厅");
  await evaluate(CLICK("游戏大厅"));
  await sleep(400);
  const inGame = await waitFor(
    `document.body.innerText.includes("选一种玩法")`,
    "游戏大厅出现",
  );
  check("切到游戏大厅", inGame);
  /**
   * 开局入口是「选玩法卡片 + 底下一个启动按钮」两步。
   *
   * 老版本是两张入口卡（一张叫「历史推演」），重设计后换成三张玩法卡，
   * 随机/传奇两条路都要先点卡片再按启动 —— 所以这里查的是三张卡都在。
   */
  const modeText = await evaluate<string>(`
    return [...document.querySelectorAll('.game-mode-card')].map(c => c.innerText.replace(/\\s+/g, " ")).join(" || ");
  `);
  check(
    "三种玩法都摆出来了（传奇 / 实时 / 随机）",
    ["传奇模式", "实时模式", "随机模式"].every((m) => modeText.includes(m)),
    modeText.slice(0, 160),
  );

  console.log("\n三、随机模式开局");
  // 落地默认选中「传奇模式」，所以必须先切到随机模式，启动按钮才会变成「用 X 万随机开局」
  const pickedRandom = await evaluate<string>(`
    const card = [...document.querySelectorAll('.game-mode-card')].find(c => c.innerText.includes("随机模式"));
    if (!card) return "NO_CARD";
    card.click();
    return "OK";
  `);
  check("点得到「随机模式」卡片", pickedRandom === "OK", pickedRandom);
  await sleep(300);
  const clicked = await evaluate<string>(CLICK("随机开局"));
  check("点得到「用 10 万随机开局」按钮", clicked === "OK", clicked);
  await sleep(600);
  const opened = await waitFor(
    `document.body.innerText.includes("待成交委托") && document.body.innerText.includes("下一天")`,
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

  console.log("\n四、挂单 → 下一天 → 成交");
  const before = await evaluate<string>(`return document.body.innerText;`);
  const cashBefore = Number((before.match(/可用现金\s*¥?([\d,]+(?:\.\d+)?)/) ?? [])[1]?.replace(/,/g, "") ?? NaN);

  // 填股票代码与股数，再点挂单。
  //
  // 这里**点榜单的第一行**来填，而不是直接往输入框塞代码 —— 选股清单就是为
  // 「玩家不知道买什么」而做的，所以端到端就该从它那里走一遍。
  //
  // 重设计之后这份清单默认是收着的（怕把下单卡撑得太长），要先按「更换股票」展开。
  await evaluate(CLICK("更换股票"));
  await sleep(250);
  const fillRaw = await evaluate<string>(`
    const codeInput = document.querySelector('input[placeholder*="代码"], input[placeholder*="名称"]');
    if (!codeInput) return "NO_CODE_INPUT";
    const row = document.querySelector('.pick-row');
    if (!row) return "NO_PICK_ROW";
    // 名字要单独取：.pick-name 里嵌着一个 .pick-code，直接读 innerText 会连成「沃森生物300142」
    const nameEl = row.querySelector(".pick-name");
    const name = (nameEl ? nameEl.childNodes[0].textContent : row.innerText.split("\\n")[0]).trim();
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

  const placed = await evaluate<string>(CLICK("挂出"));
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

  const step = await evaluate<string>(CLICK("下一天"));
  check("点得到「下一天」", step === "OK", step);
  await sleep(600);
  const after = await evaluate<string>(`return document.body.innerText;`);
  check("下一天后日志里出现了成交记录", /推演日志/.test(after) && /买入|卖出/.test(after) && after !== before);
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
  await waitFor(`document.body.innerText.includes("股市练习场")`, "重新加载");
  await evaluate(CLICK("游戏大厅"));
  await sleep(600);
  const resumed = await waitFor(
    `document.body.innerText.includes("下一天") && document.body.innerText.includes("推演日志")`,
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
  // 这一局还没走完，按钮写的是「查看阶段战报」；走完了才变成「打开本局战报」
  const settle = await evaluate<string>(CLICK("查看阶段战报"));
  check("点得到「查看阶段战报」", settle === "OK", settle);
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
  // 「退出游戏」会弹 confirm；无头浏览器默认返回 false，先把它改掉
  await evaluate(`window.confirm = () => true; return "OK";`);
  const exited = await evaluate<string>(CLICK("退出游戏"));
  check("点得到「退出游戏」", exited === "OK", exited);
  await sleep(700);
  check(
    "退出后回到开局界面",
    await waitFor(`document.body.innerText.includes("传奇模式") || document.body.innerText.includes("历史推演")`, "回到开局"),
  );

  const openLegend = await evaluate<string>(CLICK("传奇模式"));
  check("点得到「传奇模式」卡片", openLegend === "OK", openLegend);
  await sleep(300);
  // 重设计之后进关卡列表是两步：先点玩法卡片，再按底下的「选择传奇关卡」
  const goLevels = await evaluate<string>(CLICK("选择传奇关卡"));
  check("点得到「选择传奇关卡」按钮", goLevels === "OK", goLevels);
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
  const briefOpened = await evaluate<string>(OPEN_DETAILS(".chapter-briefing-details"));
  check("点得开「开局简报」", briefOpened === "OK", briefOpened);
  const brief = await evaluate<string>(`return document.body.innerText;`);
  check("简报页显示进场日期（传奇模式不藏）", brief.includes(level.startDate), level.startDate);
  check("简报页有「进场那天能看到的」", brief.includes("进场那天能看到的"));
  check("简报每一条都渲染出来了", level.briefing.every((line) => brief.includes(line)));
  check("思考题也渲染出来了", brief.includes(level.theme.slice(0, 12)));

  const enter = await evaluate<string>(CLICK(`进入 ${level.startDate}`));
  check("点得到「进入」按钮", enter === "OK", enter);
  const inLevel = await waitFor(
    `document.body.innerText.includes("待成交委托") && document.body.innerText.includes("下一天")`,
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

  // 同样先展开选股清单，否则这里量到的是「收着」而不是「没有候选」
  await evaluate(CLICK("更换股票"));
  await sleep(250);
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
  await evaluate(CLICK("挂出"));
  await sleep(400);
  await evaluate(CLICK("下一天"));
  await sleep(700);
  const lvAfter = await evaluate<string>(`return document.body.innerText;`);
  check("下一天后成交，并注明价格来自开盘价", lvAfter.includes("开盘价"), lvAfter.slice(0, 100));

  console.log("\n九、刷新后回到同一关（存档里存了 levelId）");
  await send("Page.enable");
  await send("Page.reload", { ignoreCache: true });
  await sleep(2000);
  await waitFor(`document.body.innerText.includes("股市练习场")`, "重新加载");
  await evaluate(CLICK("游戏大厅"));
  await sleep(800);
  check(
    "刷新后还在推演里，没有退回关卡列表",
    await waitFor(`document.body.innerText.includes("下一天")`, "关卡被还原"),
  );
  const restored = await evaluate<string>(`return document.body.innerText;`);
  check("还原的是同一关（能看到这一关的日期）", restored.includes(level.startDate));
  check("成交记录还在", restored.includes("开盘价") || restored.includes("推演日志"));

  console.log("\n十、回到模拟游戏：你不在的这段时间");
  // 回到模拟游戏页（前面几节都在历史推演里）
  await evaluate(`window.confirm = () => true; return true;`);
  await evaluate(CLICK("退出游戏"));
  await sleep(600);
  await evaluate(CLICK("游戏大厅"));
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
  await evaluate(CLICK("游戏大厅"));
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
  const picksOpened = await evaluate<string>(OPEN_DETAILS(".game-stock-browser"));
  check("点得开「从列表选择股票」", picksOpened === "OK", picksOpened);
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
  await evaluate(CLICK("市场观察"));
  await sleep(600);
  // v2 市场观察是三层收起：外层「详细数据与筛选」→ 四张卡 → 卡里分组。
  // 板块行在「② 板块强弱」的卡体里，折着就不渲染，先逐层点开。
  await evaluate(`
    const d = document.querySelector("details.market-full-details");
    if (d && !d.open) d.querySelector("summary").click();
    return "OK";
  `);
  await sleep(400);
  for (const t of ["② 板块强弱", "③ 个股分类"]) {
    await evaluate(`
      const card = [...document.querySelectorAll("section.card")]
        .find(c => ((c.querySelector(".card-title") || {}).textContent || "").includes(${JSON.stringify(t)}));
      const b = card && card.querySelector(".card-fold");
      if (b && (b.textContent || "").includes("展开")) b.click();
      return "OK";
    `);
    await sleep(400);
  }
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
    // 个股卡是最后一层，页面可能已经滚到底了，那就没法再把它顶到上半屏 —— 那也算跳到位。
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    return JSON.stringify({
      top: Math.round(top),
      headH: Math.round(headH),
      vh: window.innerHeight,
      y: Math.round(window.scrollY),
      maxScroll: Math.round(maxScroll),
      atBottom: window.scrollY >= maxScroll - 2,
    });
  `);
  const L = JSON.parse(landed) as { top: number; headH: number; vh: number; atBottom: boolean };
  check(
    `个股卡的标题落在视口里，且没被顶栏挡住（top=${L.top}, 顶栏=${L.headH}, 视口=${L.vh}）`,
    L.top >= L.headH - 4 && (L.top < L.vh / 2 || L.atBottom),
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
  /*
   * 按**层的 id** 找按钮，不按「页面上第一个写着收起的」。
   *
   * 今日信号与①大盘环境现在也折得起来，页面上有四颗 `.card-fold`；
   * 靠「第一个」定位的话，这里折的就成了今日信号 —— 断言会失败，
   * 但失败的原因跟这段想验的东西（第二层/第三层折得动）毫无关系。
   */
  const foldIn = (layerId: string) => `document.getElementById(${JSON.stringify(layerId)})?.querySelector("button.card-fold")`;
  await evaluate(CLICK("市场观察"));
  await sleep(500);
  // v2 里三层都是默认收起的，不先把两层展开，下面点到的就是「展开」而不是「收起」。
  await evaluate(`
    const d = document.querySelector("details.market-full-details");
    if (d && !d.open) d.querySelector("summary").click();
    return "OK";
  `);
  await sleep(400);
  /*
   * 四张卡全开之后再量基线。
   *
   * 后面既要验「折起来变短」，又要验「复原之后回到原长」——
   * 基线要是只开了两张卡量的，复原（四张全开）自然对不上，那是脚本自己挖的坑。
   */
  const openCard = (title: string) => `
    const card = [...document.querySelectorAll("section.card")].find(c => {
      const t = c.querySelector(".card-title");
      return t && t.textContent.includes(${JSON.stringify(title)});
    });
    const b = card && card.querySelector("button.card-fold");
    if (b && b.textContent.includes("展开")) b.click();
    return "OK";
  `;
  for (const title of ["今日信号", "① 大盘环境", "② 板块强弱", "③ 个股分类"]) {
    await evaluate(openCard(title));
    await sleep(300);
  }
  await sleep(600);
  const h0 = await evaluate<number>(`return document.body.scrollHeight;`);
  const fold2 = await evaluate<string>(`
    const b = ${foldIn("layer-sectors")};
    if (!b) return "NO_BTN";
    if (!b.textContent.includes("收起")) return "ALREADY_FOLDED";
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
    const b = ${foldIn("layer-stocks")};
    if (b && b.textContent.includes("收起")) b.click();
    return true;
  `);
  await sleep(400);
  const h2 = await evaluate<number>(`return document.body.scrollHeight;`);
  check(`再折起第三层（${h1} → ${h2}）`, h2 < h1 - 300);

  // 折过之后要记住 —— 否则每次打开都得再折一遍，等于没做。
  // v2 里四张卡默认都是折着的，只验「折着」证明不了记住了任何东西：
  // 上面全开过一轮（存的是 false），所以刷新后该开的两张仍然开着。
  await send("Page.reload", { ignoreCache: true });
  await sleep(3000);
  const remembered = await evaluate<string>(`
    const labels = [...document.querySelectorAll("button.card-fold")].map(b => (b.textContent || "").trim());
    return JSON.stringify({ folded: labels.filter(t => t.includes("展开")).length, labels, h: document.body.scrollHeight });
  `);
  const R = JSON.parse(remembered) as { folded: number; labels: string[]; h: number };
  check(
    `刷新后展开的两层还开着、折着的两层还折着（${R.labels.join(" | ")}，高度 ${R.h}）`,
    R.folded === 2 && R.labels[0] === "收起 ▴" && R.h < h0,
  );
  check(
    "折着的时候筛选按钮还在（要能清除板块筛选）",
    await evaluate<boolean>(`
      const b = [...document.querySelectorAll("button.card-fold")].find(x => x.textContent.includes("展开"));
      const card = b && b.closest(".card");
      return !!card;
    `),
  );

  // 复原，免得影响后面/下次跑（刷新之后外层「详细数据与筛选」又是收着的，先点开）
  await evaluate(`
    const d = document.querySelector("details.market-full-details");
    if (d && !d.open) d.querySelector("summary").click();
    return "OK";
  `);
  await sleep(400);
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

  await evaluate(CLICK_LABEL("设置"));
  await waitFor(`document.body.innerText.includes("清空本地数据")`, "设置页打开");
  await evaluate(CLICK("清空本地数据"));
  await waitFor(`document.body.innerText.includes("① 大盘环境")`, "清空后回到筛选页", 60);
  await sleep(1500); // 快照会重新加载

  await evaluate(CLICK("学习笔记"));
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
  await evaluate(CLICK("学习笔记"));
  await waitFor(`document.body.innerText.includes("还没有选中个股")`, "再次进入个股分析空状态", 60);
  await evaluate(CLICK("去筛选"));
  check("折着跳过去会自动展开，并照常闪", await waitFor(FLASHING, "展开了并且在闪"));
  check("展开之后不再是折着的", !(await evaluate<boolean>(`return ${FOLDED};`)));

  console.log("\n十三之三、两局并存：实时账户和历史推演互不清空");

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
  await waitFor(`document.body.innerText.includes("股市练习场")`, "重新加载");
  await evaluate(CLICK("游戏大厅"));
  check(
    "两边都是空的，回到开局界面",
    await waitFor(`document.body.innerText.includes("选一种玩法")`, "开局界面", 60),
  );

  // 选 10 万，和默认的 20 万分开，免得后面把「没被动过」看成「被重置了」
  await evaluate(CLICK("10 万"));
  // 重设计之后开局是两步：先点「实时模式」卡片，再按底下的启动按钮。
  // 刚清过存档，默认选中的是传奇模式，不点这张卡片按钮会一直是「选择传奇关卡」。
  await evaluate(`
    const card = [...document.querySelectorAll('.game-mode-card')].find(c => c.innerText.includes("实时模式"));
    if (card) card.click();
    return "OK";
  `);
  await sleep(300);
  await evaluate(CLICK("开始实时盘"));
  check(
    "实时模式开局成功",
    await waitFor(`document.body.innerText.includes("账户总览")`, "账户总览"),
  );

  const COEXIST_CASH = `(function () {
    const m = document.body.innerText.match(/可用资金\\n([^\\n]+)/);
    return m ? m[1].trim() : "";
  })()`;
  const coCash0 = await evaluate<string>(`return ${COEXIST_CASH};`);
  /*
   * 评审第 1 条：刚开局、没有交易，却显示「同期沪深300 −5.45%　超额收益 +5.45%」，
   * 一进门就「获胜」。根因是基准的起点在拿不到净值起点时退回了快照第一天。
   * 现在应该是「—」加一句说明。
   */
  const benchFresh = await evaluate<string>(`
    const m = [...document.querySelectorAll(".metric")].find((d) => d.textContent.includes("超额收益"));
    const v = m ? m.querySelector(".metric-v").textContent.trim() : "NO_METRIC";
    return JSON.stringify({ v, hint: document.body.innerText.includes("还没有可比的区间") });
  `);
  const bf = JSON.parse(benchFresh) as { v: string; hint: boolean };
  check("刚开局不算「跑赢基准」", bf.v === "—" && bf.hint, `${bf.v} / 说明 ${bf.hint}`);
  // 界面上没有千分位：可用资金显示成 100000
  check("新开局的可用资金就是本金", coCash0.includes("100000"), coCash0);

  // 再开一局历史推演 —— 实时那边不该被动到
  const coexistLevel = LEVELS.find((l) => l.id === "2024-09-25")!;
  // 现在人在实时账户那一屏，玩法卡片不在这 —— 要先按「探索传奇关卡 →」回大厅。
  // 这颗按钮 `disabled={!replayReady}`，快照没加载完时点它是个空操作；
  // 所以等它真能按了再按，否则后面会一路等超时、报出一串跟本意无关的失败。
  const backToLobby = await waitFor(
    `(() => {
        const b = [...document.querySelectorAll("button")].find(x => x.textContent && x.textContent.includes("探索传奇关卡"));
        if (!b || b.disabled) return false;
        b.click();
        return true;
      })()`,
    "回到大厅的入口可以按了",
  );
  check("实时账户那一屏给得出回大厅的入口", backToLobby);
  await sleep(400);
  // 两步走：卡片只负责选中，还要按「选择传奇关卡」才真的进关卡列表
  await evaluate(CLICK("选择传奇关卡"));
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
      `document.body.innerText.includes("待成交委托") && document.body.innerText.includes("下一天")`,
      "推演界面",
      60,
    ),
  );

  const coChips = await evaluate<string[]>(`
    return [...document.querySelectorAll(".pane-switch .chip")].map((b) => b.innerText.trim());
  `);
  // 三格：实时账户 / 历史推演（有推演时才出现）/ 游戏记录（一直在）
  // 第一个 chip 的文案跟着状态走：没开局时写「游戏大厅」，开着实时盘时写「实时账户」
  check("顶上出现了三条切换", coChips.length === 3, coChips.join(" | "));
  check(
    "切换条把两边都写清楚了，外加游戏记录",
    coChips.some((c) => c.includes("实时账户")) &&
      coChips.some((c) => c.includes("历史推演")) &&
      coChips.some((c) => c.includes("游戏记录")),
    coChips.join(" | "),
  );

  // 切回实时模式：账户必须还是刚才那一局
  await evaluate(CLICK("实时账户"));
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
      // 入口的文案跟着状态走：有推演在跑时给「继续历史推演 →」，不再给「探索传奇关卡 →」
      return t.includes("继续历史推演") && !t.includes("探索传奇关卡");
    `),
  );

  // 再切回去
  await evaluate(CLICK("继续历史推演"));
  check(
    "从卡片上的按钮也能回到推演",
    await waitFor(`document.body.innerText.includes("待成交委托")`, "回到推演界面"),
  );

  // 刷新之后两边都还得在
  await send("Page.enable");
  await send("Page.reload", { ignoreCache: true });
  await sleep(1800);
  await waitFor(`document.body.innerText.includes("股市练习场")`, "重新加载");
  await evaluate(CLICK("游戏大厅"));
  check(
    "刷新后回到的是推演，不是开局页",
    await waitFor(`document.body.innerText.includes("待成交委托")`, "推演被还原", 60),
  );
  check(
    "刷新后切换条还在",
    (await evaluate<number>(`return document.querySelectorAll(".pane-switch .chip").length;`)) === 3,
  );
  await evaluate(CLICK("实时账户"));
  await waitFor(`document.body.innerText.includes("账户总览")`, "实时模式的账户总览");
  const coCash2 = await evaluate<string>(`return ${COEXIST_CASH};`);
  check("刷新之后实时模式的存档也还在", coCash2 === coCash0, coCash2);

  console.log("\n十三之四、游戏记录：两边的成交并成一条时间线");

  /**
   * 用户提的：游戏板块要单独有一个历史记录，并且能跳转。
   *
   * 这一屏是**只读**的。所以两件事都要证明：一张表里同时看得到两边下的单，
   * 以及点一行真的能跳去个股分析 —— 没有出口的列表等于又一处死胡同。
   */
  // 先给实时模式下一单，否则这张表是空的，什么都验不出来
  const ghFill = await evaluate<string>(`
    const codeInput = document.querySelector('input[placeholder*="代码"], input[placeholder*="名称"]');
    if (!codeInput) return "NO_CODE_INPUT";
    const row = document.querySelector('.pick-row');
    if (!row) return "NO_PICK_ROW";
    // 名字要单独取：.pick-name 里嵌着一个 .pick-code，直接读 innerText 会连成「沃森生物300142」
    const nameEl = row.querySelector(".pick-name");
    const name = (nameEl ? nameEl.childNodes[0].textContent : row.innerText.split("\\n")[0]).trim();
    row.click();
    return new Promise((r) => setTimeout(() => {
      const numInput = [...document.querySelectorAll('input[type="number"]')].pop();
      if (!numInput) return r("NO_QTY_INPUT");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(numInput, "100");
      numInput.dispatchEvent(new Event("input", { bubbles: true }));
      r("OK:" + name);
    }, 250));
  `);
  check("实时模式下得单（点榜单填代码与股数）", ghFill.startsWith("OK:"), ghFill);

  /**
   * 用户反馈过：「下单前显示本地快照 52.50 元，成交价 52.55 元；买入后行情才更新
   * 到 53.29 元，账户立刻出现浮盈。」那 5 分钱是滑点，但界面上没说过。
   *
   * 这里断言两件事：① 下单前就把「预计成交价」摆出来，而且写明了滑点；
   * ② 它是拿**参考价**算出来的，不是凭空一个数。
   * 至于这个价和真实成交价是否一致，由 `previewOrder` 的单测兜着（同一段算式）。
   */
  const ghPreview = await evaluate<{ text: string; price: string }>(`
    const list = document.querySelector(".kv-list");
    if (!list) return { text: "NO_KV_LIST", price: "" };
    const text = list.innerText;
    const priceInput = document.querySelector('input[placeholder*="代码"], input[placeholder*="名称"]');
    return { text, price: priceInput ? priceInput.value : "" };
  `);
  check(
    "下单前先给出预计成交价，并写明滑点",
    ghPreview.text.includes("预计成交价") && ghPreview.text.includes("滑点"),
    ghPreview.text.replace(/\n/g, " | ").slice(0, 160),
  );
  check(
    "预计成交价旁边标着参考价（不是凭空一个数）",
    ghPreview.text.includes("参考价"),
    ghPreview.text,
  );

  await evaluate(CLICK("提交委托"));
  await sleep(500);

  /**
   * 成交回执要报**真实成交价**，而且和下单前预览的是同一个数。
   * 之前只报「已成交 100 股」，用户只能自己去成交记录里翻，才会觉得「怎么贵了 5 分」。
   */
  const ghReceipt = await evaluate<string>(`
    const n = [...document.querySelectorAll(".notice")].map((e) => e.innerText).join(" | ");
    return n;
  `);
  check(
    "成交回执写明成交价与参考价，并说明差在滑点上",
    ghReceipt.includes("成交价") && ghReceipt.includes("滑点"),
    ghReceipt.slice(0, 200),
  );
  check(
    "回执里的参考价就是下单前预览的参考价",
    (() => {
      const m = ghReceipt.match(/参考价 ([\d.]+)/);
      return m !== null && ghPreview.text.includes(`参考价 ${m[1]}`);
    })(),
    ghReceipt.slice(0, 200),
  );

  // 推演那边也下一单（挂单 → 下一天才成交）
  await evaluate(CLICK("历史推演"));
  check(
    "切到历史推演",
    await waitFor(`document.body.innerText.includes("待成交委托")`, "推演界面"),
  );
  await evaluate(`
    const codeInput = document.querySelector('input[placeholder*="代码"], input[placeholder*="名称"]');
    const row = document.querySelector('.pick-row');
    if (row) row.click();
    return new Promise((r) => setTimeout(() => {
      const numInput = [...document.querySelectorAll('input[type="number"]')].pop();
      if (codeInput && numInput) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(numInput, "100");
        numInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      r("OK");
    }, 250));
  `);
  const ghPlaced = await evaluate<string>(CLICK("挂出"));
  check("推演里也挂得上单", ghPlaced === "OK", ghPlaced);
  await sleep(400);
  await evaluate(CLICK("下一天"));
  await sleep(700);

  await evaluate(CLICK("游戏记录"));
  check(
    "切到游戏记录，两边的成交都在",
    await waitFor(`document.body.innerText.includes("成交记录（")`, "游戏记录界面"),
  );

  /**
   * 这里**必须看成交行本身**，不能看 `document.body.innerText`。
   *
   * 教训：切换条上那两个 chip 的文案恰好就是「实时模式」和「历史推演 · 第 N 关」，
   * 于是 `body.innerText.includes("实时模式")` 与 `includes("历史推演 · 第")`
   * **在一条成交都没有的情况下照样通过** —— 断言看着很合理，实际什么都没验。
   * 换成读 `.history-row` 之后，它当场就暴露出「推演那单根本没成交」这个真问题。
   */
  const ghText = await evaluate<string>(`return document.body.innerText;`);
  const ghRows = await evaluate<string[]>(`
    return [...document.querySelectorAll(".history-row")].map(r => r.innerText.split("\\n").join(" | ").trim());
  `);
  const rowsText = ghRows.join("  //  ");
  check("成交记录里真的有行（不是只有切换条上的字）", ghRows.length >= 2, `实际 ${ghRows.length} 行：${rowsText.slice(0, 200)}`);
  check("实时那单标成「实时模式」", rowsText.includes("实时模式"), rowsText.slice(0, 200));
  check(
    "推演那单标成「模拟日」，并写明是第几关",
    rowsText.includes("模拟日") && /历史推演 · 第 \d+ 关/.test(rowsText),
    rowsText.slice(0, 300),
  );
  check(
    "两笔各属于一边（不是全归到一处）",
    rowsText.includes("实时模式") && rowsText.includes("历史推演 · 第"),
    rowsText.slice(0, 300),
  );
  check("赛季结算也是一张卡", ghText.includes("赛季结算（"));
  check("这一屏照旧带免责声明", ghText.includes("不构成投资建议"));

  // 点一行 → 个股分析
  const ghJump = await evaluate<string>(`
    const row = document.querySelector(".history-row .row-tap");
    if (!row) return "NO_ROW";
    const code = row.querySelector(".code");
    row.click();
    return "OK:" + (code ? code.innerText.trim() : "");
  `);
  check("点得到成交记录里的一行", ghJump.startsWith("OK:"), ghJump);
  const ghCode = ghJump.split(":")[1] ?? "";
  check(
    "点一行跳到个股分析",
    await waitFor(
      `document.querySelector(".tabbar .tab-active") && document.querySelector(".tabbar .tab-active").innerText.trim() === "学习笔记"`,
      "个股分析页出现（底栏标签叫「学习笔记」）",
      60,
    ),
  );
  check(
    "跳过去的是那一行对应的票",
    await evaluate<boolean>(`return document.body.innerText.includes(${JSON.stringify(ghCode)});`),
    ghCode,
  );

  // 回到游戏记录，再从横幅回推演
  await evaluate(CLICK("游戏大厅"));
  await sleep(500);
  await evaluate(CLICK("游戏记录"));
  check(
    "从个股分析绕一圈回来，游戏记录还在",
    await waitFor(`document.body.innerText.includes("成交记录（")`, "游戏记录界面", 60),
  );
  const ghBack = await evaluate<string>(CLICK("回到正在跑的那一局"));
  check("推演还在跑，横幅上给得回得去", ghBack === "OK", ghBack);
  check(
    "点横幅回到推演本身",
    await waitFor(`document.body.innerText.includes("待成交委托")`, "推演界面"),
  );

  console.log("\n十三之五、术语：点两下就有解释，同时只开一个");

  /**
   * 用户提的：「对专业术语标蓝（就是没接触过股票的看不懂的），用户点两下能看到
   * 解析。解析的形式是教学助手来解释。」
   *
   * 「点两下」指的是**两层**：第一下出一句话，第二下（点「让翡翠细讲」）出完整
   * 解释。这里把这两层和「同时只开一个」都验一遍 —— 一屏几十个词，全开着会变成
   * 一屏解释，那是功能没做完而不是功能多。
   */
  // 回到筛选页：这一页术语最密，而且和上一节留下的游戏状态无关
  await evaluate(CLICK("市场观察"));
  await sleep(600);
  /*
   * v2 之后术语基本都在「详细数据与筛选」里面，而它是**默认收起的**。
   * 所以得先按用户的做法把它点开 —— 不点开的话整页一个**可见的**术语按钮都没有，
   * 脚本只能摸到藏在收起区域里的那些（点得到，但展开在看不见的地方）。
   */
  const detailsForTerms = await evaluate<string>(`
    const d = document.querySelector("details.market-full-details");
    if (!d) return "NO_DETAILS";
    if (!d.open) d.querySelector("summary").click();
    return "OK";
  `);
  check("市场观察页里有「详细数据与筛选」", detailsForTerms === "OK", detailsForTerms);
  await sleep(500);
  const termBefore = await evaluate<number>(`return document.querySelectorAll(".term-panel").length;`);
  check("没点之前一个解释都不展开", termBefore === 0, `实际 ${termBefore} 个`);

  /*
   * 只挑**真正在渲染**的那个词。
   *
   * `Card` / `RuleLines` 这些公共组件里到处都是 `TermText`，没切过去的标签页、
   * 折着的卡片、收起来的「详细数据与筛选」里的词都在 DOM 里 ——
   * `querySelector("button.term")` 摸到的很可能是藏在里面的那个。点它照样会展开，
   * 只是展开在看不见的地方，`innerText` 是空的，脚本会以为自己点坏了。
   *
   * 判据是 `checkVisibility()` 而**不是** `getClientRects().length`：实测闭合的
   * `<details>` 里的按钮 `getClientRects()` 仍然返回 1 个矩形（`innerText` 却是空的），
   * 只有 `checkVisibility()` 会给出 false。
   */
  const VISIBLE_TERM = `[...document.querySelectorAll("button.term")].find(b => b.checkVisibility())`;
  const termWord = await evaluate<string>(`
    const b = ${VISIBLE_TERM};
    if (!b) return "NOT_FOUND";
    b.scrollIntoView({ block: "center" });
    const w = b.textContent;
    b.click();
    return w;
  `);
  check("页面上能找到术语按钮", termWord !== "NOT_FOUND", termWord);

  const shortPanel = await waitFor(
    `(() => {
        const p = document.querySelector(".term-panel");
        return !!p && p.innerText.includes("翡翠") && p.innerText.includes("让翡翠细讲");
      })()`,
    "术语气泡",
  );
  if (!shortPanel) {
    const diag = await evaluate<string>(`
      const b = ${VISIBLE_TERM};
      const p = document.querySelector(".term-panel");
      const cs = p ? getComputedStyle(p) : null;
      const vis = (el) => {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          const c = getComputedStyle(n);
          if (c.display === "none" || c.visibility === "hidden") return n.tagName + "." + n.className;
        }
        return null;
      };
      return JSON.stringify({
        word: ${JSON.stringify(termWord)},
        expanded: b ? b.getAttribute("aria-expanded") : null,
        panels: document.querySelectorAll(".term-panel").length,
        terms: document.querySelectorAll("button.term").length,
        visibleTerms: [...document.querySelectorAll("button.term")].filter(x => x.checkVisibility()).length,
        panelText: p ? p.innerText.slice(0, 80) : null,
        panelTextContent: p ? (p.textContent || "").slice(0, 80) : null,
        panelDisplay: cs ? cs.display : null,
        hiddenAncestor: p ? vis(p) : null,
        btnHiddenAncestor: b ? vis(b) : null,
      });
    `);
    console.log(`    [诊断] ${diag}`);
  }
  check("点第一下：原地撑开一句话的解释", shortPanel);

  const termFull = await evaluate<string>(`
    const more = document.querySelector(".term-more");
    if (!more) return "NOT_FOUND";
    more.click();
    return more.textContent;
  `);
  check("气泡里有「让翡翠细讲」这个入口", termFull !== "NOT_FOUND", termFull);
  check(
    "点第二下：换成完整解析（有「是什么、为什么」那几段）",
    await waitFor(
      `(() => {
        const p = document.querySelector(".term-panel");
        return !!p && !p.innerText.includes("让翡翠细讲") && p.innerText.length > 40;
      })()`,
      "完整解析",
    ),
  );

  /**
   * 同时只开一个：点另一个词，前一个必须收起来。
   * 判据是**面板数量恒为 1**，不是「某个词关着」—— 后者在实现只做加法时也会过。
   */
  const exclusive = await evaluate<string>(`
    const all = [...document.querySelectorAll("button.term")];
    const shown = all.filter(b => b.checkVisibility());
    const other = shown.find(b => b.getAttribute("aria-expanded") === "false");
    if (!other) return "NO_OTHER";
    other.click();
    return other.textContent;
  `);
  await sleep(300);
  const panels = await evaluate<number>(`return document.querySelectorAll(".term-panel").length;`);
  check("点另一个词之后，仍然只有一个展开", panels === 1, `实际 ${panels} 个（点了「${exclusive}」）`);

  const collapsed = await evaluate<number>(`
    return [...document.querySelectorAll("button.term")].filter(b => b.getAttribute("aria-expanded") === "true").length;
  `);
  check("展开的词自己也标记成展开了（aria-expanded）", collapsed === 1, `实际 ${collapsed} 个`);

  console.log("\n十三之六、历史推演里也有当天的资讯");

  /**
   * 用户提的：「另外历史推演里面好像没有资讯」。
   *
   * 不是 bug 是没数据：实时那套是滚动接口（只有今天），历史推演跑在过去的某一天，
   * 所以另抓了一份按天的离线归档。这里验的是**它真的接上了**，不是「代码里有这个
   * 组件」—— 所以要求卡片里出现具体条数，而不只是标题。
   */
  await evaluate(CLICK("游戏大厅"));
  await sleep(600);
  const toReplay = await evaluate<string>(CLICK("历史推演"));
  check("推演还开着，切换条上点得回去", toReplay === "OK", toReplay);
  /*
   * 资讯收在「当天资讯」这个折叠块里（重设计时怕把左栏撑太长）。
   * 摘要行折着也看得见，先验它 —— 摘要写着条数，就等于证明归档真的接上了，
   * 而不是「代码里有这个组件」。正文再展开读。
   */
  const newsSummary = await evaluate<string>(`
    const d = [...document.querySelectorAll("details.replay-details")].find(x => x.textContent.includes("当天资讯"));
    return d ? d.querySelector("summary").innerText : "NOT_FOUND";
  `);
  check(
    "推演界面回来了",
    await waitFor(`(function () {
      const d = [...document.querySelectorAll("details.replay-details")].find(x => x.textContent.includes("当天资讯"));
      return !!d;
    })()`, "那一天的资讯卡片", 60),
  );
  check("摘要行就写明有几条历史归档（折着也看得见）", /\d+ 条历史归档/.test(newsSummary), newsSummary);
  await evaluate(`
    const d = [...document.querySelectorAll("details.replay-details")].find(x => x.textContent.includes("当天资讯"));
    if (!d) return "NOT_FOUND";
    d.open = true;
    return "OK";
  `);
  await sleep(300);
  const dayNews = await evaluate<string>(`
    const card = [...document.querySelectorAll("section.card")].find(s => s.textContent.includes("那一天的资讯"));
    return card ? card.innerText : "NO_CARD";
  `);
  check("资讯卡在推演界面里", dayNews !== "NO_CARD", dayNews.slice(0, 60));
  check("写明了来源是离线归档", dayNews.includes("新浪财经首页归档"), dayNews.slice(0, 80));
  check(
    "取不到的日子会明说「没抓到」，不假装当天没有新闻",
    dayNews.includes("条") || dayNews.includes("没有抓到"),
    dayNews.slice(0, 80),
  );
  const dayLinks = await evaluate<number>(`
    const card = [...document.querySelectorAll("section.card")].find(s => s.textContent.includes("那一天的资讯"));
    return card ? card.querySelectorAll("a.news-link").length : -1;
  `);
  check("每条资讯都给了原文链接", dayLinks > 0, `链接 ${dayLinks} 个`);
  check(
    "链接不在按钮里（嵌套可交互元素是非法 HTML）",
    await evaluate<boolean>(`
      const card = [...document.querySelectorAll("section.card")].find(s => s.textContent.includes("那一天的资讯"));
      if (!card) return false;
      for (const m of card.innerHTML.matchAll(/<button[\\s\\S]*?<\\/button>/g)) {
        const inner = m[0].replace(/^<button[^>]*>/, "").replace(/<\\/button>$/, "");
        if (inner.includes("<a ") || inner.includes("<button")) return false;
      }
      return true;
    `),
  );

  /**
   * 术语高亮把专业词都换成了 `<button>`。只要这个按钮落在另一个按钮或链接
   * 里面，就是非法的嵌套可交互元素 —— 浏览器会把结构拆开，表现是「点了没反应」。
   * 单测已经盯住了文案最多的规则页和说明页，这里再对**真实渲染出来的整页**
   * 兜一遍：跑完一路的点击之后，页面上不该存在任何嵌套。
   */
  const nested = await evaluate<string[]>(`
    const bad = [];
    for (const b of document.querySelectorAll("button")) {
      if (b.querySelector("button") || b.querySelector("a")) bad.push("button: " + b.innerText.slice(0, 40));
    }
    for (const a of document.querySelectorAll("a")) {
      if (a.querySelector("a") || a.querySelector("button")) bad.push("a: " + a.innerText.slice(0, 40));
    }
    return bad;
  `);
  check(
    "整页没有嵌套的可交互元素（术语按钮没被塞进别的按钮里）",
    nested.length === 0,
    JSON.stringify(nested).slice(0, 240),
  );

  console.log("\n十三之七、港股与美股：同一个动作，三个市场不一样");

  /**
   * 加港美股的意义全在**规则差异**上：同一句「买 100 股」，
   * 三个市场付的钱、能不能当天卖、几股起买都不一样。
   *
   * 所以这一节不验「界面上能出现港股」这种摆设，而是逐条把差异验出来 ——
   * 而且验的是**引擎真算出来的行为**（可卖数量、成交记录），不是只有文案。
   * 界面说的和引擎做的不一致，玩家就会照 A 股的习惯操作，然后白等一天。
   *
   * 用腾讯（00700.HK）和苹果（AAPL.US）：十个关卡里都有，
   * 所以不管前面进的是哪一关，这一节都跑得起来。
   */
  const pickReplayStock = async (keyword: string, label: string): Promise<string> => {
    // 往输入框里打字本身就会把清单展开（ReplayView 的 onChange 里 setShowStocks(true)）。
    // 注意得打**名字的一部分**：打了完整代码的话 picked 立刻成立，清单会切回榜单。
    const typed = await evaluate<boolean>(`
      const input = document.getElementById("replay-code");
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, ${JSON.stringify(keyword)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    `);
    if (!typed) return "NO_CODE_INPUT";
    await sleep(400);
    /*
     * 打的是**全名**时（ReplayView 的 onChange 里有 `stocks.find(s => s.name === v)`），
     * React 当场就把代码填好了、清单也收回去 —— 这时没有行可点，输入框里已经是答案。
     * 打的是名字的一部分才需要从清单里挑一行。
     */
    const direct = await evaluate<string>(`return document.getElementById("replay-code").value;`);
    if (direct !== keyword) return direct;
    const clicked = await evaluate<string>(`
      const rows = [...document.querySelectorAll(".pick-row")];
      const row = rows.find((r) => r.innerText.includes(${JSON.stringify(label)}));
      if (!row) return "NO_ROW:" + rows.length;
      row.click();
      return "OK";
    `);
    if (clicked !== "OK") return clicked;
    await sleep(400);
    return await evaluate<string>(`
      const input = document.getElementById("replay-code");
      return input ? input.value : "NO_INPUT";
    `);
  };

  /** 某只票选中之后，下单卡上的那几个说法 */
  const orderPanel = async () => {
    // 数据来源说明（原以港币计价…）在「查看走势图与成交标记」里，折叠时读不到
    await evaluate(OPEN_DETAILS(".replay-chart-details"));
    return await evaluate<string>(`
      const tag = document.querySelector(".replay-rule-tag");
      const note = document.querySelector(".replay-data-note");
      const hint = [...document.querySelectorAll(".replay-order-panel .field-hint")].map((e) => e.innerText).join(" | ");
      const quick = [...document.querySelectorAll(".replay-quantity-buttons button")].map((b) => b.innerText).join(",");
      return JSON.stringify({
        tag: tag ? tag.innerText : "",
        note: note ? note.innerText : "",
        hint,
        quick,
      });
    `).then((raw) => JSON.parse(raw) as Record<string, string>);
  };

  /** 折叠块里那块「XX 交易规则」面板 */
  const rulesPanel = async () =>
    await evaluate<string>(`
      const d = [...document.querySelectorAll("details.replay-details")]
        .find((x) => (x.querySelector("summary") || x).innerText.includes("交易规则"));
      if (!d) return JSON.stringify({ open: "", body: "" });
      return JSON.stringify({
        open: d.open ? "true" : "false",
        body: d.querySelector(".replay-details-body") ? d.querySelector(".replay-details-body").innerText : "",
      });
    `).then((raw) => JSON.parse(raw) as Record<string, string>);

  // ── 港股：T+0、无涨跌停、100 股一手、双边印花税、价格折成人民币 ──
  const hkCode = await pickReplayStock("腾讯", "腾讯");
  check("选得到港股（清单里搜「腾讯」能挑出腾讯控股）", hkCode === "00700.HK", hkCode);

  const hkPanel = await orderPanel();
  check("港股标着 T+0（不是 A 股的 T+1）", hkPanel.tag === "T+0", hkPanel.tag);
  check(
    "写明了港股按手交易、当日可卖、无涨跌停",
    hkPanel.hint.includes("100 股一手") && hkPanel.hint.includes("当日买入当日可卖") && hkPanel.hint.includes("无涨跌停"),
    hkPanel.hint,
  );
  check(
    "写明了原以港币计价、已折成人民币",
    hkPanel.note.includes("原以港币计价") && hkPanel.note.includes("已按当日汇率折成人民币"),
    hkPanel.note,
  );

  const hkRules = await rulesPanel();
  check("选港股时规则面板默认展开（差异最多，不用玩家自己去找）", hkRules.open === "true", hkRules.open);
  check(
    "港股规则逐条写清了印花税/佣金/T+0/手数",
    hkRules.body.includes("印花税") &&
      hkRules.body.includes("HK$") &&
      hkRules.body.includes("T+0") &&
      hkRules.body.includes("100"),
    hkRules.body.replace(/\n/g, " / ").slice(0, 200),
  );

  // 真买 100 股，下一天，看引擎给的可卖数量 —— T+0 的话买完当天就是全部可卖
  await evaluate<boolean>(`
    const btn = [...document.querySelectorAll(".replay-quantity-buttons button")].find((b) => b.innerText.includes("100"));
    if (btn) btn.click();
    return !!btn;
  `);
  await sleep(200);
  await evaluate<string>(CLICK("挂出"));
  await sleep(400);
  await evaluate(CLICK("下一天"));
  await sleep(600);
  const hkHolding = await evaluate<string>(`
    const row = [...document.querySelectorAll(".replay-holding-row")].find((r) => r.innerText.includes("腾讯"));
    return row ? row.innerText.replace(/\\n/g, " ") : "NO_HOLDING";
  `);
  check("港股挂单成交后进了持仓", hkHolding !== "NO_HOLDING", hkHolding.slice(0, 80));
  check(
    "港股是 T+0：买完当天就全部可卖（A 股这里会是 0）",
    /持有 \/ 可卖\s*100 \/ 100/.test(hkHolding.replace(/\s+/g, " ")),
    hkHolding.replace(/\s+/g, " ").slice(0, 120),
  );
  check(
    "持仓行写明了境外当日可卖、境外标的已按当天汇率折成人民币",
    await evaluate<boolean>(`
      const p = document.querySelector(".replay-holdings-panel .replay-panel-head p");
      return !!p && p.innerText.includes("港美日韩当日可卖") && p.innerText.includes("境外标的已按当天汇率折成人民币");
    `),
  );

  // ── 美股：1 股起买、零佣金、T+0 ──
  const usCode = await pickReplayStock("苹果", "苹果");
  check("选得到美股（搜索框认「苹果」这个名字）", usCode === "AAPL.US", usCode);

  const usPanel = await orderPanel();
  check("美股也标着 T+0", usPanel.tag === "T+0", usPanel.tag);
  check("美股的快捷股数是 1/10/100（1 股起买）", usPanel.quick.includes("1 股") && usPanel.quick.includes("10 股"), usPanel.quick);
  check("写明了美股 1 股起买", usPanel.hint.includes("美股 1 股起买"), usPanel.hint);
  check("写明了原以美元计价", usPanel.note.includes("原以美元计价"), usPanel.note);

  const usRules = await rulesPanel();
  check("美股规则面板也默认展开", usRules.open === "true", usRules.open);
  check(
    "美股写明零佣金、无印花税、无涨跌停",
    usRules.body.includes("无印花税") && usRules.body.includes("零佣金") && usRules.body.includes("无涨跌停"),
    usRules.body.replace(/\n/g, " / ").slice(0, 200),
  );

  // 买 1 股：A 股会以「至少 100 股」被拒，美股必须放行
  await evaluate<boolean>(`
    const btn = [...document.querySelectorAll(".replay-quantity-buttons button")].find((b) => b.innerText.trim() === "1 股");
    if (btn) btn.click();
    return !!btn;
  `);
  await sleep(200);
  const usPlaced = await evaluate<string>(CLICK("挂出"));
  await sleep(400);
  const usFeedback = await evaluate<string>(`
    const f = document.querySelector(".replay-feedback");
    const pending = [...document.querySelectorAll(".replay-order-list li")].map((li) => li.innerText).join(" | ");
    return JSON.stringify({ f: f ? f.innerText : "", fOk: f ? f.className.includes("is-ok") : false, pending });
  `);
  const usRes = JSON.parse(usFeedback) as { f: string; fOk: boolean; pending: string };
  check("美股买 1 股挂得上（A 股会以「至少 100 股」被拒）", usPlaced === "OK" && usRes.fOk, `${usPlaced} / ${usRes.f}`);
  check("那 1 股挂在待成交列表里", usRes.pending.includes("苹果"), usRes.pending.slice(0, 120));

  // 收尾：把港股那笔卖掉会改成绩单，这里就不动了，留着让后面「控制台没有报错」兜底
  check("港美股看完之后页面还活着", await evaluate<boolean>(`return document.body.innerText.includes("待成交委托");`));

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
