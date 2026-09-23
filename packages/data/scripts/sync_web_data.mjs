#!/usr/bin/env node
/**
 * 把最新的快照同步到网页端的静态资源目录。
 *
 * 为什么要同步而不是让网页直接读 `data/`：
 * GitHub Pages 只发布构建产物（`apps/web/dist`），仓库根目录的 `data/`
 * 不会被发布。所以必须把快照复制进 `apps/web/public/`，由 Vite 一起打包。
 *
 * 用法：
 *   node packages/data/scripts/sync_web_data.mjs            # 同步最新快照，只留 1 份
 *   node packages/data/scripts/sync_web_data.mjs --keep 5   # 保留最近 5 份
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const snapshots = readdirSync(DATA_DIR)
  .filter((d) => d.startsWith("snapshot_") && statSync(join(DATA_DIR, d)).isDirectory())
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
  const RE = /^snapshot_\d{8}$/;
  const published = readdirSync(TARGET)
    .filter((d) => RE.test(d) && d !== latest && statSync(join(TARGET, d)).isDirectory())
    .sort();
  for (const old of published.slice(0, Math.max(0, published.length - keep + 1))) {
    rmSync(join(TARGET, old), { recursive: true, force: true });
    console.log(`  清理旧快照 ${old}`);
  }
}

console.log(`同步快照 ${latest} -> apps/web/public/data`);
