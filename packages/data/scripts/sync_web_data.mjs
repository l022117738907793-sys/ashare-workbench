#!/usr/bin/env node
/**
 * 把最新的快照同步到网页端的静态资源目录。
 *
 * 为什么要同步而不是让网页直接读 `data/`：
 * GitHub Pages 只发布构建产物（`apps/web/dist`），仓库根目录的 `data/`
 * 不会被发布。所以必须把快照复制进 `apps/web/public/`，由 Vite 一起打包。
 *
 * 为什么需要裁剪：长历史快照（--days 650）对回测有用，但引擎的指标窗口最大只有
 * 60 日（MA60/ret60），把 640 天全量发给浏览器纯属浪费——实测 640 天版本
 * gzip 后 980KB，而 120 天只有约 100KB。所以 `data/` 保留完整深度供回测，
 * 发布到网页端时按 --trim-days 裁剪。
 *
 * 用法：
 *   node packages/data/scripts/sync_web_data.mjs              # 同步并裁到 120 天
 *   node packages/data/scripts/sync_web_data.mjs --trim-days 250
 *   node packages/data/scripts/sync_web_data.mjs --no-trim    # 不裁剪（调试用）
 *   node packages/data/scripts/sync_web_data.mjs --keep 5     # 保留最近 5 份
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const DATA_DIR = join(ROOT, "data");
const TARGET = join(ROOT, "apps", "web", "public", "data");

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}

if (!existsSync(DATA_DIR)) {
  console.error(`没有找到数据目录：${DATA_DIR}`);
  console.error("先运行：python3 packages/data/scripts/fetch_snapshot.py");
  process.exit(1);
}

// 只认 `snapshot_<8位日期>`。与下面的清理逻辑用同一个正则——
// 两边不一致会导致"选出来的最新快照"和"允许保留的快照"不是同一批
const SNAPSHOT_RE = /^snapshot_\d{8}$/;
const snapshots = readdirSync(DATA_DIR)
  .filter((d) => SNAPSHOT_RE.test(d) && statSync(join(DATA_DIR, d)).isDirectory())
  .sort();

if (snapshots.length === 0) {
  console.error("没有找到任何快照目录，先运行 fetch_snapshot.py");
  process.exit(1);
}

const latest = snapshots.at(-1);
const src = join(DATA_DIR, latest);
const dest = join(TARGET, latest);

// 校验必需要文件齐全，避免发布半截快照
const REQUIRED = ["meta.json", "calendar.json", "indices.json", "sectors.json", "stocks.json", "etfs.json"];
const missing = REQUIRED.filter((f) => !existsSync(join(src, f)));
if (missing.length > 0) {
  console.error(`快照 ${latest} 缺少文件：${missing.join(", ")}`);
  process.exit(1);
}

mkdirSync(TARGET, { recursive: true });
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });

// ── 裁剪到引擎实际需要的深度 ─────────────────────────────────
// 只裁发布副本，`data/` 源快照保持完整，回测仍可用长历史。
const noTrim = process.argv.includes("--no-trim");
const trimDays = argValue("--trim-days", 120);

if (!noTrim && trimDays > 0) {
  const calPath = join(dest, "calendar.json");
  const calendar = JSON.parse(readFileSync(calPath, "utf-8"));
  if (calendar.length > trimDays) {
    const keepFrom = calendar.length - trimDays;
    const kept = calendar.slice(keepFrom);
    writeFileSync(calPath, JSON.stringify(kept));

    const cutSeries = (arr) =>
      arr.map((s) => ({
        ...s,
        close: s.close.slice(keepFrom),
        high: s.high.slice(keepFrom),
        low: s.low.slice(keepFrom),
        volume: s.volume.slice(keepFrom),
      }));

    for (const name of ["indices", "sectors", "stocks", "etfs"]) {
      const f = join(dest, `${name}.json`);
      if (!existsSync(f)) continue;
      writeFileSync(f, JSON.stringify(cutSeries(JSON.parse(readFileSync(f, "utf-8")))));
    }

    // meta.days 必须跟着改，否则界面显示的天数与实际不符
    const metaPath = join(dest, "meta.json");
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      meta.days = kept.length;
      meta.webTrimmedFrom = calendar.length;
      writeFileSync(metaPath, JSON.stringify(meta));
    }
    console.log(`  裁剪发布副本：${calendar.length} 天 -> ${kept.length} 天（源快照保持完整）`);
  }
}

writeFileSync(join(TARGET, "latest.json"), JSON.stringify({ snapshot: latest }));

// 控制部署产物体积：运行期只通过 latest.json 读取**一份**快照，
// 历史快照打进 dist 只会白白占用 Pages 带宽，所以默认只保留最新的一份。
// 需要回滚到旧数据时再调大。
//
// 两个必须遵守的约束（都踩过坑）：
//   1. 只认 `snapshot_<8位日期>`，否则 `snapshot_dev` 这类目录会被当成"更新的快照"
//      （字母序里 `snapshot_dev` > `snapshot_20260923`），把真实数据挤掉；
//   2. 刚刚同步的那一份永远不能删——否则 latest.json 会指向不存在的目录，
//      站点直接加载失败。
const keep = argValue("--keep", 1);
if (keep > 0) {
  const published = readdirSync(TARGET)
    .filter((d) => SNAPSHOT_RE.test(d) && d !== latest && statSync(join(TARGET, d)).isDirectory())
    .sort();
  for (const old of published.slice(0, Math.max(0, published.length - keep + 1))) {
    rmSync(join(TARGET, old), { recursive: true, force: true });
    console.log(`  清理旧快照 ${old}`);
  }
}

console.log(`同步快照 ${latest} -> apps/web/public/data`);
