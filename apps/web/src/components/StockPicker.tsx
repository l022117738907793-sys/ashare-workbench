/**
 * 「模拟下单」里的选股清单。
 *
 * 这里是替换 `<datalist>` 的。原来那个输入框在 iOS Safari 上**不弹任何东西**
 * （Safari 至今没实现 datalist），桌面 Chrome 上点开也只有一列六位代码 ——
 * 玩家是大学生不是股民，看到一个空的股票输入框只会茫然。
 *
 * 所以这个清单把「买什么」变成一道选择题：
 * - 没输入时：按板块摊开的榜单（涨得最猛 / 跌得最狠 / 成交最热）
 * - 输入了：边打边筛
 *
 * 点一行就把代码填进上面的输入框，**不直接下单** —— 股数还得自己填，
 * 免得点错一下就把钱花出去。
 */
import { useMemo, useState } from "react";
import { fmtNum, fmtPct } from "../lib/helpers";
import {
  PICK_CAVEAT,
  PICK_KEYS,
  PICK_LABEL,
  fmtAmount,
  pickCandidates,
  searchStocks,
  type PickKey,
  type PickStock,
} from "../lib/picks";

/**
 * 只有**非人民币**的票才标注币种。
 *
 * 港股（将来也许还有美股）的报价在进这一屏之前就折成人民币了（见 App.tsx 的
 * `convertSnapshotToCny` 与 `fxFor`），所以这里显示的数字是元；而玩家在券商 App
 * 里看到的是港币 —— 不标一句「港币」，两边对不上就会被当成数据错了。
 * A 股不标：它本来就是人民币，标了是噪音。
 */
const CUR_NAME: Partial<Record<string, string>> = { HKD: "港币", USD: "美元", JPY: "日元", KRW: "韩元" };

export interface StockPickerProps {  /** 这一局能买的全部标的。只能来自本局的标的池，不能混进别的年份的票 */
  rows: PickStock[];
  /** 输入框里已经打了的字 */
  query: string;
  onPick: (code: string) => void;
  /** 当前选中的代码，用来高亮 */
  activeCode?: string;
}

export function StockPicker({ rows, query, onPick, activeCode }: StockPickerProps) {
  const [key, setKey] = useState<PickKey>("up");
  const searching = query.trim() !== "";
  const hits = useMemo(() => searchStocks(rows, query), [rows, query]);
  const picks = useMemo(() => pickCandidates(rows, key), [rows, key]);
  const list = searching ? hits : picks;

  return (
    <div className="pick-box">
      <div className="pick-head">
        <span className="pick-title">
          {searching ? (hits.length > 0 ? `匹配到 ${hits.length} 只` : "没找到这只票") : "不知道买什么？挑一个"}
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

      {list.length === 0 ? (
        <p className="field-hint">
          {searching
            ? "这一局里没有这只票（历史推演只能用当时已经上市的公司）。清空输入框看榜单。"
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

/** 红涨绿跌（A 股习惯）。0 和取不到都不上色。 */function chgClass(v: number | null): string {
  if (v === null || v === 0) return "";
  return v > 0 ? "chg-up" : "chg-down";
}
