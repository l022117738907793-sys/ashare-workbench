/**
 * 下单卡里「这一单大概要花多少钱」的那两行。
 *
 * 为什么单独成一个组件：它是被用户投诉的那一处 —— 下单卡显示 52.50，成交 52.55，
 * 中间那 5 分钱是滑点，但当时界面上没有任何地方说过它，看着就像系统算错了。
 * 现在把参考价、滑点、预计成交价、预计金额、手续费一次摆出来，成交后再报一次实数。
 *
 * ⚠️ 价格一律走 `previewOrder`（`@aw/game`），**不要在这里自己乘滑点**。
 * 预览和真实成交必须是同一段算式，否则这个组件就变成了第二个真相来源 ——
 * 那正是它要修的问题。
 *
 * 抽成独立组件的另一个好处：它只在「选了标的」之后才出现，而这个选择是
 * GameView 的内部状态，静态渲染整张卡点不出来。单独渲染它才测得到。
 */
import { DEFAULT_SLIPPAGE, previewOrder } from "@aw/game";
import { fmtNum } from "../lib/helpers";
import { KV } from "./common";

export interface OrderPreviewProps {
  /** 参考价：实时价优先，取不到退回快照收盘价。null 表示没有行情，不可下单 */
  price: number | null;
  side: "buy" | "sell";
  shares: number;
  /** 可用资金（买入时的上限参考） */
  cash: number;
  /** 可卖数量（卖出时的上限参考） */
  sellable: number;
  /** 交易日，决定印花税档位（2023-08-28 起 0.1% → 0.05%） */
  today: string;
}

export function OrderPreview({ price, side, shares, cash, sellable, today }: OrderPreviewProps) {
  // 没有行情、或者股数还没填/填成负数，就没什么可预览的
  if (price === null || !Number.isFinite(shares) || shares <= 0) return null;

  const preview = previewOrder(price, side, shares, today);
  const slipPct = (DEFAULT_SLIPPAGE * 100).toFixed(1);

  return (
    <>
      <KV
        k="预计成交价"
        v={
          <>
            {fmtNum(preview.price)}
            <span className="muted small">
              （参考价 {fmtNum(price)}，{side === "buy" ? "加" : "减"} {slipPct}% 滑点）
            </span>
          </>
        }
      />
      <KV
        k="预计金额"
        v={
          <>
            {fmtNum(preview.amount)} 元
            <span className="muted small">
              ，手续费 {fmtNum(preview.fee.total)} 元
              {side === "buy" ? `，可用 ${fmtNum(cash)} 元` : `，可卖 ${sellable} 股`}
            </span>
          </>
        }
      />
    </>
  );
}
