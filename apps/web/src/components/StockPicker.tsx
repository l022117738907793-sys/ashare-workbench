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
  pickAll,
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

/**
 * 搜索时没展开先显示前几条。
 *
 * 20 条足够认出想找的那只（真找不到还有市场胶囊可以缩池子），
 * 但也足够多到不必让人先滚一轮。**这只是显示上限** ——
 * 标题里那个「匹配到 N 只」用的是真实命中数，见 `allHits`。
 */
const SEARCH_LIMIT = 20;

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
  /*
   * 搜索结果**不在这里截断**：`allHits` 是真实的命中数，界面照它说
   * 「匹配到 N 只」；`hits` 只是没展开时先显示前 20 条。
   * 以前 `searchStocks` 内部写死 20，于是打一个「6」也会说「匹配到 20 只」。
   */
  const allHits = useMemo(() => searchStocks(scoped, query), [scoped, query]);
  const picks = useMemo(() => pickCandidates(scoped, key), [scoped, key]);
  const all = useMemo(() => pickAll(scoped, key), [scoped, key]);
  /** false = 先给折好的那一小段；true = 这一屏的全量名册 */
  const [full, setFull] = useState(false);
  const hits = full ? allHits : allHits.slice(0, SEARCH_LIMIT);
  const list = searching ? hits : full ? all : picks;

  const total = searching ? allHits.length : all.length;
  const shown = searching ? hits.length : picks.length;
  /*
   * 展开之后换市场或换问法都可能让池子变小，全量名册短到不比原来长 ——
   * 这时那个「收起」按钮就成了纯噪音（点一下什么都不会变）。用长度判断，
   * 而不是写 effect 去清状态：清状态要等一帧，那一帧里按钮会闪一下。
   */
  const canExpand = total > shown;

  const head = searching
    ? total > 0
      ? `匹配到 ${total} 只`
      : "没找到这只票"
    : full
      ? `全部 ${all.length} 只，按「${PICK_LABEL[key]}」排序`
      : "不知道买什么？挑一个";

  return (
    <div className="pick-box">
      <div className="pick-head">
        <span className="pick-title">{head}</span>
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
        <ul className={`pick-list${full ? " is-full" : ""}`}>
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

      {/*
        「看全部」这一行是补上一个对不上的数字：市场胶囊写「全部 150」，
        清单却只有 8 行 —— 两句话说的是两件事（池子多大 / 榜单多长），
        但玩家只看得到那个 150。点开就是这一屏的全部标的，同一个排序；
        搜索时同理，先说清真实的命中数，再让人决定要不要全看。
      */}
      {list.length > 0 && (
        <div className="pick-foot">
          {!searching && <p className="field-hint pick-caveat">{PICK_CAVEAT}</p>}
          {canExpand && (
            <button
              type="button"
              className="game-text-button pick-all"
              onClick={() => setFull((v) => !v)}
            >
              {full ? `收起，只看前 ${shown} 只` : `看全部 ${total} 只 →`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 红涨绿跌（A 股习惯）。0 和取不到都不上色。 */
function chgClass(v: number | null): string {
  if (v === null || v === 0) return "";
  return v > 0 ? "chg-up" : "chg-down";
}
