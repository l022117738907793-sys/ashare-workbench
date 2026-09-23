# packages/data/scripts

## fetch_snapshot.py

生成「演示行情快照」的取数脚本：`申万一级行业 + 代表成分股 + 宽基指数 + 主流 ETF`，
用于本仓库的规则引擎/前端演示。脚本按交易日写出 6 个 JSON 文件到
`data/snapshot_<YYYYMMDD>/`。

### 数据来源

| 数据 | 来源 | 说明 |
| --- | --- | --- |
| 申万一级行业列表 | akshare `sw_index_first_info()` | 申万官网口径 |
| 申万行业成分股 + 权重 | akshare `index_component_sw()` | `最新权重` 用于初始排序 |
| 申万行业指数日线 | akshare `index_hist_sw()` | 日线收盘/最高/最低/成交量 |
| 个股、指数、ETF 日线 | 腾讯行情 `web.ifzq.gtimg.cn/appstock/app/fqkline/get` | qfq 前复权，指数用不复权 |
| **总市值** | **东方财富行情列表 `push2.eastmoney.com/api/qt/clist/get`** | 用于按行业选代表股 |

> 市值来源已从 **Tushare `daily_basic`** 切换为 **东方财富行情列表接口**，
> 不再需要 Tushare token，也不再依赖 `tushare` 包。

东方财富接口参数（沪深A股全市场，实测 `data.total` ≈ 5561）：

```
https://push2.eastmoney.com/api/qt/clist/get
  ?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f20
  &fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23
  &fields=f12,f13,f14,f20,f21,f100
  &ut=bd1d9ddb04089700cf9c27f6f7426281
```

- `pn` 页码（从 1 开始），`pz` 每页条数（100），按 `data.total` 翻页取全量。
- `f12` 6 位代码、`f13` 市场（`1`=上海 → `.SH`，`0`=深圳 → `.SZ`）、`f14` 名称、
  `f20` 总市值（元）、`f21` 流通市值（元）、`f100` 东财行业名。
- 量纲：脚本内部把 `f20` 由 **元** 换算为 **万元**（`/1e4`），与原
  `Tushare daily_basic.total_mv` 的单位保持一致；下游只用于排序与判空。
- 请求头沿用脚本内的 `HEADERS`（`User-Agent: Mozilla/5.0` + `Referer: https://gu.qq.com/`），
  单页超时 20s，失败重试 4 次（退避 `0.6s × 尝试次数`）。

### 用法

```bash
# 默认：每行业取前 20 只代表股（等价于 --limit 20）
python3 packages/data/scripts/fetch_snapshot.py

# 指定每行业代表股数量
python3 packages/data/scripts/fetch_snapshot.py --limit 10

# 忽略 data/cache 缓存，重新拉取全部日线
python3 packages/data/scripts/fetch_snapshot.py --fresh

# 不使用市值排序，直接用申万权重排序
python3 packages/data/scripts/fetch_snapshot.py --no-marketcap

# 组合使用
python3 packages/data/scripts/fetch_snapshot.py --limit 10 --fresh --no-marketcap
```

> `--no-tushare` 作为**已废弃的隐藏别名**保留，行为与 `--no-marketcap` 完全一致，
> 老工作流调用不会中断；使用时会在 stderr 打印一条废弃提示。
> 该别名不出现在 `--help` 输出中。

### 运行时依赖

```bash
pip3 install akshare requests
```

| 包 | 用途 |
| --- | --- |
| `akshare` | 申万行业列表/成分股/行业指数日线 |
| `requests` | 腾讯行情 + 东方财富行情列表 |

- **`tushare` 不再需要**（已从脚本中彻底移除，也不再读取 `TUSHARE_TOKEN`）。
- Python 3.9+（本机默认 `python3` 3.9.6 可运行）。

### 降级行为（东方财富不可用时）

市值只影响「每个行业选哪几只代表股」，不影响快照能否生成：

1. `fetch_marketcap_eastmoney()` 抛错（超时/连接被重置/`rc != 0`/翻页失败等）
   → stderr 打印 `[warn] 东方财富市值不可用，退化为权重排序: <原因>`，
   `mv` 保持为空字典；
2. 接口正常但返回 0 条 → stderr 打印
   `[warn] 东方财富市值返回为空，退化为权重排序`；
3. 两种情况都**不会中断脚本**。此时每个成分股的 `total_mv` 为 `None`，
   行业成员退回按 akshare 的 `最新权重` 降序排列，其余逻辑完全不变。

其它既有容错保持不变：单个行业成分股失败只告警并跳过该行业；个股/指数/ETF
日线失败会汇总告警并跳过该标的；交易日不足 60 天的个股被丢弃。

### 输出布局

```
data/
├── cache/                              # 腾讯日线缓存（--fresh 可忽略）
│   ├── sh000300_raw.json
│   └── sh600519_qfq.json
└── snapshot_<YYYYMMDD>/                # 以沪深300最后交易日命名
    ├── meta.json
    ├── calendar.json
    ├── indices.json
    ├── sectors.json
    ├── stocks.json
    └── etfs.json
```

| 文件 | 内容 |
| --- | --- |
| `meta.json` | `asOf` / `source` / `poolNote` / `calendarNote` / `generatedAt` / `days` |
| `calendar.json` | 公共交易日数组（沪深300 日历，最多 120 天） |
| `indices.json` | 沪深300、上证指数、创业板指：`code,name,kind,close,high,low,volume` |
| `sectors.json` | 申万一级行业：`code,name,close,high,low,volume,members[]` |
| `stocks.json` | 代表股：`code,name,industry,industryCode,weight,isST,close,high,low,volume` |
| `etfs.json` | 5 只主流 ETF：`code,name,kind,close,high,low,volume` |

`meta.json` 的 `source` 字段：

```
申万官网(akshare) + 腾讯行情 + 东方财富市值(可用时)
```

### 故障排查

- 东方财富 `clist/get` 偶发 `RemoteDisconnected` / `Empty reply from server`：
  是该接口 CDN 节点/WAF 侧的行为（同一域名下 `stock/get` 正常，`clist/get` 被重置），
  脚本会重试 4 次后走上面的降级路径；稍后重跑或换网络通常可恢复。
- 腾讯行情失败：检查 `data/cache` 是否可写，或用 `--fresh` 重试。

## 历史深度（`--days`）

默认取 130 天、输出 120 天（留 10 天余量用于对齐）。可用 `--days` 拉长：

```bash
python3 packages/data/scripts/fetch_snapshot.py --days 650   # 约 640 个交易日
```

**为什么要拉长**：回测（`scripts/backtest.ts`）的可回放天数 = 历史长度 − 60。
120 天的快照只能回放 60 天，20 日前瞻的非重叠窗口仅 2 个，统计上没有意义；
640 天则能给出约 29 个独立窗口。

**上限 641 根**：腾讯日线接口实测最多返回 641 根（约 2.6 年），
超过会被拒绝（HTTP 501）或截断。申万行业指数本身可回溯到 1999 年，
所以瓶颈在腾讯这边。

### 耗时（实测）

| 步骤 | 耗时 | 说明 |
|---|---|---|
| 1 交易日历 | <1s | 腾讯，有缓存 |
| 2 申万行业与成分股 | ~2min | akshare，32 次串行请求 |
| 3 市值 | 0 或很快 | 东财，失败则退化为权重排序 |
| 4 个股/指数/ETF 日线 | 数秒（有缓存） | 腾讯，8 线程并发 |
| 5 板块日线 + 对齐写出 | **~7min** | **akshare 串行，单个行业约 13s** |

> ⚠️ 第 5 步是瓶颈：31 个申万行业指数串行拉取，每个约 13 秒。
> 这是**正常现象，不是卡死**。判断进程是否活着请看日志推进，
> 不要用 `ps` 的 `%cpu`——那是生命周期平均值，等待网络时会接近 0，容易误判。
