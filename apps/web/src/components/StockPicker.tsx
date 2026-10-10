/**
 * 「模拟下单」里的选股清单。
 *
 * 这里是替换 `<datalist>` 的。原来那个输入框在 iOS Safari 上**不弹任何东西**
 * （Safari 至今没实现 datalist），桌面 Chrome 上点开也只有一列六位代码 ——
 * 玩家是大学生不是股民，看到一个空的股票输入框只会茫然。
 *
 * 所以这个清单把「买什么」变成一道选择题：
 * - 没输入时：按桶摊开的榜单（涨得最猛 / 跌得最狠 / 成交最热）
 * - 输入了：边打边筛
 *
 * 两层分类：**先按市场**（A 股 / 港股 / 美股 / 日股 / 韩股），**再按问法**（三个排序键）。
 * 市场那层不是装饰 —— 没有它，境外标的几乎永远进不了榜，原因见 `picks.ts` 的 `bucketOf`。
 *
 * 点一行就把代码填进上面的输入框，**不直接下单** —— 股数还得自己填，
 * 免得点错一下就把钱花出去。
 */
import { useMemo, useState } from "react";
import { MARKET_NAME, marketGroupOf, type MarketGroup } from "@aw/game";
import { fmtNum, fmtPct } from "../lib/helpers";
import {
  PICK_CAVEAT,
  PICK_KEYS,
  PICK_LABEL,
  fmtAmount,
  pickCandidates,
  pickMarkets,
  searchStocks,
  type PickKey,
  type PickStock,
} from "../lib/picks";

/**
 * 只有**非人民币**的票才标注币种。
 *
 * 港股/美股/日股/韩股的报价在进这一屏之前就折成人民币了（见 App.tsx 的
 * `convertSnapshotToCny` 与 `fxFor`），所以这里显示的数字是元；而玩家在券商 App
 * 里看到的是本币 —— 不标一句「港币」，两边对不上就会被当成数据错了。
 * A 股不标：它本来就是人民币，标了是噪音。
 */
const CUR_NAME: Partial<Record<string, string>> = { HKD: "港币", USD: "美元", JPY: "日元", KRW: "韩元" };

export interface StockPickerProps {
  /** 这一局能买的全部标的。只能来自本局的标的池，不能混进别的年份的票 */
  rows: PickStock[];
  /** 输入框里已经打了的字 */
  query: string;
  onPick: (code: string) => void;
  /** 当前选中的代码，用来高亮 */
  activeCode?: string;
}

export function StockPicker({ rows, query, onPick, activeCode }: StockPickerProps) {
  const [key, setKey] = useState<PickKey>("up");
  /** null = 全部。存的是「玩家的意图」，实际生效的见 `activeMarket` */
  const [market, setMarket] = useState<MarketGroup | null>(null);

  const markets = useMemo(() => pickMarkets(rows), [rows]);
  const marketCounts = useMemo(() => {
    const m = new Map<MarketGroup, number>();
    for (const r of rows) {
      const g = marketGroupOf(r.code);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  }, [rows]);

  /*
   * 存下来的市场在换关卡之后可能已经不在池子里了（比如从实时盘退回某个只有 A 股的
   * 关卡）。这时**当成「全部」**，而不是写个 effect 去清 —— 清状态要等一帧，
   * 那一帧里会先算出空榜单，屏幕闪一下。
   */
  const activeMarket: MarketGroup | null =
    market !== null && markets.includes(market) ? market : null;

  const scoped = useMemo(
    () => (activeMarket === null ? rows : rows.filter((r) => marketGroupOf(r.code) === activeMarket)),
    [rows, activeMarket],
  );

  const searching = query.trim() !== "";
  const hits = useMemo(() => searchStocks(scoped, query), [scoped, query]);
  const picks = useMemo(() => pickCandidates(scoped, key), [scoped, key]);
  const list = searching ? hits : picks;

  return (
    <div className="pick-box">
      <div className="pick-head">
        <span className="pick-title">
          {searching
            ? hits.length > 0
              ? `匹配到 ${hits.length} 只`
              : "没找到这只票"
            : "不知道买什么？挑一个"}
        </span>
        {!searching && (
          <div className="pick-keys">
            {PICK_KEYS.map((k) => (
              <button
                key={k}
                type="button"
                className={`chip chip-tiny${k === key ? " chip-active" : ""}`}
                onClick={() => setKey(k)}
              >
                {PICK_LABEL[k]}
              </button>
            ))}
          </div>
        )}
      </div>

      {/*
        市场那一排：池子里只有一个市场时不渲染（历史关卡大多只有 A 股，
        摆一排只有一个选项的按钮是纯噪音）。搜到哪只票也仍然受这一层约束，
        所以输入时**照样显示**，玩家才看得见自己筛过市场。
      */}
      {markets.length > 1 && (
        <div className="pick-keys pick-markets">
          <button
            type="button"
            className={`chip chip-tiny${activeMarket === null ? " chip-active" : ""}`}
            onClick={() => setMarket(null)}
          >
            全部 {rows.length}
          </button>
          {markets.map((m) => (
            <button
              key={m}
              type="button"
              className={`chip chip-tiny${m === activeMarket ? " chip-active" : ""}`}
              onClick={() => setMarket(m)}
            >
              {MARKET_NAME[m]} {marketCounts.get(m) ?? 0}
            </button>
          ))}
        </div>
      )}

      {list.length === 0 ? (
        <p className="field-hint">
          {searching
            ? activeMarket === null
              ? "这一局里没有这只票（历史推演只能用当时已经上市的公司）。清空输入框看榜单。"
              : `这一局的${MARKET_NAME[activeMarket]}里没有这只票。换一个市场，或清空输入框看榜单。`
            : "这一局还没有可下单的行情。"}
        </p>
      ) : (
        <ul className="pick-list">
          {list.map((s) => (
            <li key={s.code}>
              <button
                type="button"
                className={`pick-row${s.code === activeCode ? " pick-row-on" : ""}`}
                onClick={() => onPick(s.code)}
                title={`填入 ${s.code}`}
              >
                <span className="pick-name">
                  {s.name}
                  <span className="pick-code">{s.code.replace(/\.(SH|SZ|BJ)$/, "")}</span>
                  {(() => {
                    const cur = CUR_NAME[s.currency ?? "CNY"];
                    return cur ? (
                      <span
                        className="pick-cur"
                        title={`这只票以${cur}计价，报价已按汇率折成人民币`}
                      >
                        {cur}
                      </span>
                    ) : null;
                  })()}
                </span>
                <span className="pick-mid">
                  <span className="pick-sector">{s.sector || "—"}</span>
                  {key === "hot" && !searching && <span className="pick-amount">{fmtAmount(s.amount)}</span>}
                </span>
                <span className="pick-num">
                  <span className="pick-price">{fmtNum(s.price)}</span>
                  <span className={`pick-chg ${chgClass(s.changePct)}`}>{fmtPct(s.changePct)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {!searching && list.length > 0 && <p className="field-hint pick-caveat">{PICK_CAVEAT}</p>}
    </div>
  );
}

/** 红涨绿跌（A 股习惯）。0 和取不到都不上色。 */
function chgClass(v: number | null): string {
  if (v === null || v === 0) return "";
  return v > 0 ? "chg-up" : "chg-down";
}
