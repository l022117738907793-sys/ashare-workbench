#!/usr/bin/env node
/**
 * make-dev-data.mjs —— 把 packages/core/fixtures 里的一个"真实快照 fixture"
 * 拆成前端 `loadSnapshot()` 期望的目录布局，供本地开发 / 静态演示使用。
 *
 *   apps/web/public/data/
 *   ├── latest.json                 { "snapshot": "snapshot_dev" }
 *   └── snapshot_dev/
 *       ├── meta.json               asOf / source / generatedAt / days ...
 *       ├── calendar.json           YYYY-MM-DD[]，工作日倒推，末位 = asOf
 *       ├── indices.json            fixture.indices 原样
 *       ├── sectors.json            fixture.sectors 原样
 *       ├── stocks.json             fixture.stocks 原样
 *       └── etfs.json               fixture.etfs（fixture 没有该字段时写 []）
 *
 * 红线：只做"搬运 + 补日历/元信息"，绝不改动、补造任何行情数字。
 * fixture 里没有 ETF，就写空数组，不编造。
 *
 * 用法：
 *   node scripts/make-dev-data.mjs
 *   node scripts/make-dev-data.mjs --fixture market_strong_sector_strong_stock_start.json
 *   node scripts/make-dev-data.mjs --asof 2026-09-22 --out public/data
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const repoRoot = resolve(appRoot, "../..");

const DEFAULT_FIXTURE = "market_normal_sector_accel_stock_trend.json";
const SNAPSHOT_NAME = "snapshot_dev";

function parseArgs(argv) {
  const out = { fixture: DEFAULT_FIXTURE, asof: null, out: join(appRoot, "public", "data") };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--fixture") out.fixture = argv[++i];
    else if (a === "--asof") out.asof = argv[++i];
    else if (a === "--out") out.out = resolve(process.cwd(), argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(
        "用法: node scripts/make-dev-data.mjs [--fixture <文件名>] [--asof YYYY-MM-DD] [--out <目录>]",
      );
      process.exit(0);
    } else {
      console.error(`未知参数: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const pad = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** 取"最近一个工作日"（周一~周五）作为数据日期；节假日日历 fixture 里没有，不臆造。 */
function latestWeekday(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return isoOf(d);
}

/**
 * 生成 endsAt 结尾、共 days 个交易日的日历（只剔除周末）。
 * 真实交易日历来自 akshare（见 packages/data/scripts/fetch_snapshot.py），
 * 这里没有节假日数据，因此 meta.calendarNote 会明确说明是"仅剔除周末"的推算日历。
 */
function buildCalendar(endsAt, days) {
  const [y, m, d] = endsAt.split("-").map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));
  const out = [];
  while (out.length < days) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(isoOf(cursor));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return out.reverse();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixturePath = join(repoRoot, "packages", "core", "fixtures", args.fixture);
  const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));

  for (const key of ["indices", "sectors", "stocks"]) {
    if (!Array.isArray(fixture[key])) {
      throw new Error(`fixture 缺少数组字段 ${key}：${fixturePath}`);
    }
  }

  const asOf = args.asof ?? latestWeekday();
  const days = fixture.indices[0]?.close?.length ?? 0;
  if (days <= 0) throw new Error("fixture.indices[0].close 为空，无法推断日历长度");

  const calendar = buildCalendar(asOf, days);
  const etfs = Array.isArray(fixture.etfs) ? fixture.etfs : [];

  const meta = {
    asOf,
    generatedAt: asOf,
    days,
    source: "packages/core/fixtures（真实快照 fixture，开发用）",
    poolNote: `股票池 ${fixture.stocks.length} 只（fixture 原始池，未扩充）`,
    calendarNote: `按工作日倒推 ${days} 天生成，仅剔除周末；fixture 不含节假日数据`,
    devFixture: true,
    fixtureId: fixture.id ?? args.fixture,
    rulesNote: "规则阈值以 @aw/core rules.json 为准；fixture 自带 rules 仅用于一致性测试",
    etfsNote: Array.isArray(fixture.etfs) ? "" : "fixture 不含 etfs 字段，etfs.json 为空数组（不编造）",
    realtimeNote:
      "fixture 股票代码为合成代码（如 P0/TREND），腾讯/东财实时行情无法识别，实时链路会降级为本地快照",
  };

  const dir = join(args.out, SNAPSHOT_NAME);
  mkdirSync(dir, { recursive: true });

  const write = (file, data) =>
    writeFileSync(join(dir, file), `${JSON.stringify(data, null, 2)}\n`, "utf-8");

  writeFileSync(
    join(args.out, "latest.json"),
    `${JSON.stringify({ snapshot: SNAPSHOT_NAME, asOf }, null, 2)}\n`,
    "utf-8",
  );
  write("meta.json", meta);
  write("calendar.json", calendar);
  write("indices.json", fixture.indices);
  write("sectors.json", fixture.sectors);
  write("stocks.json", fixture.stocks);
  write("etfs.json", etfs);

  const bytes = [meta, calendar, fixture.indices, fixture.sectors, fixture.stocks, etfs]
    .reduce((n, v) => n + JSON.stringify(v).length, 0);

  console.log(`fixture : ${args.fixture}`);
  console.log(`输出目录: ${join(args.out, SNAPSHOT_NAME)}`);
  console.log(`asOf    : ${asOf}（日历 ${calendar[0]} ~ ${calendar.at(-1)}，共 ${calendar.length} 天）`);
  console.log(
    `内容    : indices=${fixture.indices.length} sectors=${fixture.sectors.length} stocks=${fixture.stocks.length} etfs=${etfs.length}`,
  );
  console.log(`体积    : 约 ${(bytes / 1024).toFixed(1)} KiB`);
}

main();
