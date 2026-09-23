# A 股趋势筛选工作台 · 纯前端版

移动端优先的 A 股趋势筛选工作台。四层漏斗筛选 + 个股七步分析 + 学习模式，
**纯静态站，零服务器、零备案**，直接部署到 GitHub Pages。

本项目是 `TushareWorkbench`（Swift + React 双端）的网页版重构：保留全部分析能力，
把数据源换成实时可用的公开行情接口，并把引擎抽成可复用独立包。

## 与旧版的关系

| | 旧版 | 本项目 |
|---|---|---|
| 形态 | iOS App + 网页原型 | 纯网页（移动端优先） |
| 分析引擎 | TS 与 Swift **两套实现**，靠 fixture 测试防漂移 | **一套**（`@aw/core`） |
| 数据源 | akshare 申万 + 腾讯 + **Tushare 市值** | akshare 申万 + 腾讯 + **东方财富市值**（已去除 tushare） |
| 实时性 | 每日快照 | 每日快照 **+ 秒级实时** |
| 部署 | GitHub Pages / Xcode | GitHub Pages |
| 后端 | 无 | 无（数据源支持 CORS 直连） |

## 架构

```
同花顺/东财/腾讯公开行情（浏览器直连）
        ↑
   ┌────┴─────────────────────────────┐
   │  每日快照（GitHub Actions 生成）    │  ← 批量历史：指数/板块/500+ 个股
   │  data/snapshot_<YYYYMMDD>/       │
   └────┬─────────────────────────────┘
        ↓
packages/core   分析引擎（纯函数、零依赖、不碰时间与时区）
packages/data   快照加载 + 多源实时行情（降级链）+ 交易时段判断
apps/web        React 界面
```

**为什么是「快照 + 实时」两层**：四层漏斗需要 500+ 只股票的 K 线，浏览器逐票拉取会被
行情站限频乃至封 IP（实测东财会直接把连接重置）。所以批量历史放服务端每天生成一次，
浏览器只实时刷当前关注的一小部分标的。详见 `docs/data-sources.md`。

## 快速开始

```bash
npm install
npm test                      # 69 个测试：引擎 fixture 一致性 + 数据层

# 生成一份真实快照（需要 python3 + akshare）
pip install akshare requests pandas
python3 packages/data/scripts/fetch_snapshot.py
node packages/data/scripts/sync_web_data.mjs --keep 30

npm run dev --workspace @aw/web
```

没有真实快照也可以先跑：`apps/web/public/data/` 里带了一份从 fixture 生成的演示数据。

## 目录

```
packages/core/          分析引擎
  src/engine.ts         引擎本体（自旧项目逐字节搬移，仅改 1 行 import 路径）
  rules.json            默认阈值
  fixtures/             12 个一致性测试用例
packages/data/          数据层
  src/providers/        腾讯 / 东方财富 provider
  src/quotes.ts         降级链
  src/session.ts        交易时段（北京时间，不依赖本机时区）
  src/snapshot.ts       快照加载 + 实时价叠加
  scripts/              快照生成与同步脚本
apps/web/               网页界面
docs/                   规则规格与数据源实测结论
```

## 部署到 GitHub Pages

1. 新建公开仓库并推送；
2. `Settings → Pages → Source` 选 **GitHub Actions**；
3. push 到 `main` 会自动构建部署，地址形如 `https://<用户名>.github.io/<仓库名>/`。

仓库内已含两个工作流：

- `.github/workflows/update-snapshot.yml` — 每工作日 18:30（北京时间）抓当日快照并提交
- `.github/workflows/deploy-web.yml` — 跑测试 → 同步快照 → 构建 → 部署

**源码里没有任何密钥。** 本版所有数据源都是免密钥的公开接口，不需要配置任何 Secret。

## 产品红线

分析引擎与界面共同遵守，`packages/core` 有测试守护前三条：

1. 任何界面不出现**买入 / 卖出 / 目标价 / 必涨 / 必跌**；
2. 每个分类结论都必须展示逐条判断依据；
3. 数据不足时明确显示 **【数据不足，不许编造】**，绝不用 0 或推测值顶替；
4. 不预测确定的未来走势。

## 已知限制

- **东方财富会封锁高频请求的 IP**（实测），因此默认链是腾讯优先、东财兜底；降级发生时界面会标注实际来源。
- 腾讯实时接口**单次最多 20 只**，且为 **GBK 编码**（已处理）。
- 腾讯 K 线**不支持批量**，一次一只；指数返回键是 `day` 而非 `qfqday`。
- 申万一级行业依赖 akshare，上游改版可能导致快照生成失败（已有降级与告警）。
- 交易日历来自快照的 `calendar.json`，快照未更新时节假日判断会退化为「仅按周末粗判」。

## 开发提示

> ⚠️ **不要把本项目放在 `~/Documents` 或 `~/Desktop`。** 这两个目录默认开启 iCloud
> 「桌面与文稿」同步；磁盘吃紧时 macOS 会把文件卸载成云端占位符（`ls -lO` 显示
> `dataless`），此后读写会报 `Resource deadlock avoided`，且磁盘满时 `brctl download`
> 也救不回来。本项目放在 `~/Developer/` 下就是为了避开这一点。
