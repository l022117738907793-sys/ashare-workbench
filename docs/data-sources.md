# 数据源实测结论

> 本文档记录**实际发请求验证过**的结果，不是文档推测。验证日期：2026-09-23。
> 验证方式：`curl` 带 `Origin: https://example.github.io`，检查 `Access-Control-Allow-Origin` 响应头与 HTTP 状态码。

## 一、结论速览

| 数据源 | 接口 | CORS | 实测状态 | 定位 |
|---|---|---|---|---|
| 腾讯 | `qt.gtimg.cn/q=` | ✅ `*` | ✅ 稳定 | **实时报价（主）** |
| 腾讯 | `web.ifzq.gtimg.cn/.../fqkline/get` | ✅ `*` | ✅ 稳定 | **日K（主）** |
| 东方财富 | `push2.eastmoney.com/api/qt/*` | ✅ 回显 Origin | ⚠️ **会封锁 IP** | 实时/列表（备） |
| 东方财富 | `push2his.eastmoney.com/.../kline/get` | ✅ 回显 Origin | ⚠️ **会封锁 IP** | K线（备） |
| 新浪 | `hq.sinajs.cn/list=` | ❌ 403 | ❌ 不可用 | — |
| 同花顺 | `quantapi.51ifind.com` | ❌ **无 CORS 头** | ❌ 纯前端不可用 | 需后端 |

## 二、限频与封锁（最重要的运维约束）

东方财富会在请求量上来后**直接丢弃连接**，表现为：

```
* TLS 证书验证通过
* Request completely sent off
* Empty reply from server        ← 服务端接受连接后直接关闭
```

- `HTTP 000`，不是 4xx/5xx
- 换 UA、加/去 `Origin`、加 `Referer: https://quote.eastmoney.com/`、改 http、换 CDN IP —— **全部无效**
- 封锁范围会**逐步扩大**：先是 `push2his`（K线），随后 `clist`/`ulist`（列表/实时），最终连 `stock/get`（单只）也 000
- 对照组：同一时刻腾讯全部正常 → 是东财单方面的封锁，不是本机网络问题

### 架构含义

四层漏斗需要约 **3 个指数 + ~90 个板块 + 500~1000 只个股**的 K 线序列。
纯前端逐票拉取必然触发封锁，**换 IP 也只是推迟**。因此采用**快照 + 实时**双层设计：

```
批量历史（慢变） → 每日快照（GitHub Actions 服务端生成，静态 JSON）
实时报价（快变） → 浏览器直连腾讯，只刷当前关注的少量标的
```

浏览器端每次只发个位数请求，不会触发限频。快照生成在 CI 里跑，每次是全新 IP。

**因此：provider 默认链是「腾讯优先、东财兜底」**，见 `packages/data/src/quotes.ts` 的 `DEFAULT_CHAIN`。

## 三、腾讯接口字段表

### 3.1 日K（`web.ifzq.gtimg.cn`）

```
https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,120,qfq
```

```json
{"code":0,"msg":"","data":{"sh600519":{"qfqday":[
 ["2026-09-16","1273.930","1258.000","1274.980","1254.100","26235.000"]]}}}
```

> ⚠️ **字段顺序是 `[日期, 开, 收, 高, 低, 成交量]`**
> 即 **开、收、高、低**，不是常见的开高低收。写错会导致 K 线全错。

| 项 | 说明 |
|---|---|
| `param` | `<市场><代码>,day,,,<根数>,qfq`；市场前缀 `sh` / `sz` |
| 返回键 | 前复权是 **`qfqday`**；**指数不返回 `qfqday` 而是 `day`** |
| 批量 | ❌ **不支持**（分号连接多个会得到 `param error`），一次一只 |
| 根数 | 请求 120 会返回 121 根 |
| Referer | 实测**不需要**，浏览器可直连 |

**指数返回键不同**这一条极易踩坑：`sh000300` 传了 `qfq` 也只返回 `day`，只认 `qfqday` 会取到空。

### 3.2 实时报价（`qt.gtimg.cn`）

```
https://qt.gtimg.cn/q=sh600519,sz000001
```

- `content-type: text/html; charset=GBK` ← **必须手动解码**
- `Access-Control-Allow-Origin: *`，不需要 Referer
- **批量上限实测 = 20 只**：请求 30 / 60 / 100 只都只返回 20 条

浏览器中 `fetch().text()` 会乱码，需：

```js
const buf = await (await fetch(url)).arrayBuffer()
const text = new TextDecoder('gbk').decode(buf)
```

返回 `v_sh600519="1~贵州茅台~600519~..."`，波浪号分隔，共 88 个字段（无官方文档，实测得出）：

| 下标 | 含义 |
|---|---|
| `[1]` | 名称 |
| `[2]` | 代码 |
| `[3]` | **最新价** |
| `[4]` | 昨收 |
| `[5]` | 今开 |
| `[30]` | 时间戳 `YYYYMMDDHHmmss`（北京时间） |
| `[31]` | **涨跌额** |
| `[32]` | **涨跌幅 %** |
| `[33]` | 最高 |
| `[37]` | **成交额，单位「万元」**（×10000 = 元） |
| `[44]` / `[45]` | 流通市值 / 总市值（亿元） |

## 四、东方财富接口字段表（备用）

### 4.1 批量实时 `ulist.np/get`
`?fltt=2&secids=1.000300,0.399006&fields=f1,f2,f3,f4,f6,f12,f13,f14&ut=fa5fd1943c7b386f172d6893dbfba10b`

市场前缀：`1.` = 上交所，`0.` = 深交所。

| 字段 | 含义 |
|---|---|
| `f2` / `f3` / `f4` / `f6` | 最新价 / 涨跌幅% / 涨跌额 / 成交额(元) |
| `f12` / `f13` / `f14` | 代码 / 市场(1=沪,0=深) / 名称 |

### 4.2 列表 `clist/get`
`?pn=1&pz=100&fltt=2&fid=f20&fs=<筛选器>&fields=f12,f13,f14,f20,f21,f100&ut=bd1d9ddb04089700cf9c27f6f7426281`

| 字段 | 含义 |
|---|---|
| `f20` / `f21` | 总市值 / 流通市值（**元**） |
| `f100` | 所属行业名（东财口径） |
| `f104` / `f105` | 板块内上涨 / 下跌家数 |

筛选器 `fs`：沪深A股全市场 `m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23`（实测 5561 只）；地域 `m:90+t:1`；行业/细分 `m:90+t:2`（496 个，含 Ⅱ/Ⅲ 细分层级，**不是**干净的一级行业）；概念 `m:90+t:3`。

> 坑：不带 `np` 参数时 `diff` 会返回成 `{"0":{...},"1":{...}}` 对象而非数组，需兼容两种形状。

## 五、不可用项与原因

| 来源 | 原因 |
|---|---|
| 新浪 `hq.sinajs.cn` | `403`，需 `Referer: https://finance.sina.com.cn`，浏览器无法伪造 |
| 同花顺 QuantAPI | 响应无 `Access-Control-Allow-Origin`，浏览器直连被 CORS 拦截 |

## 六、同花顺备用路径（需后端代理时）

官方免费版确实存在（iFinD 账号即可登录，无需申请试用）：

1. `refresh_token`（长期）→ `get_access_token` → `access_token`（7 天有效，可自动续）
2. HTTP 直连 `https://quantapi.51ifind.com/api/v1/...`
3. 免费版额度：实时行情 300 万单元格/月、历史行情 100 万/月、日内快照 200 万/月
4. 单 `access_token` 最多绑定 **20 个 IP**

参考：
- <https://quantapi.10jqka.com.cn/gwstatic/static/ds_web/quantapi-web/help-center/permission.html>
- <https://quantapi.10jqka.com.cn/gwstatic/static/ds_web/quantapi-web/help-center/deploy.html>

本机已安装 `ifind-data` skill（`~/.dsh/skills/ifind-data/`），含指标代码表与板块代码表，需要时可查。

## 七、降级链

```
实时报价：  腾讯 qt.gtimg.cn  →  东财 push2  →  快照收盘价
历史K线：   腾讯 ifzq         →  东财 push2his  →  快照内置序列
股票池：    每日快照（CI 服务端生成）
```

每个 provider 实现同一个 `QuoteProvider` 接口。**降级发生时必须在 UI 上标注实际来源**——沿用原项目「数据不足必须明说，不许编造」的红线。`fetchQuotes()` 返回的 `degradedReason` 就是为此存在的。
