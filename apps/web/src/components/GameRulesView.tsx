/**
 * 模拟盘规则讲解。
 *
 * 定位：这些规则本身就是最值得学的部分——T+1、涨跌停、手续费看起来是"限制"，
 * 实际是 A 股交易成本结构与制度约束的直接体现，不懂这些就没法理解真实收益。
 * 所以每一项都写成「规则是什么 → 为什么有这条 → 对收益的实际影响」。
 *
 * 所有数字都从 @aw/game 的常量读取，不在这里重新硬编码一次，
 * 避免将来改了费率而讲解页还在说旧数字。
 */
import {
  COMMISSION_MIN,
  COMMISSION_RATE,
  DEFAULT_SLIPPAGE,
  LOT_SIZE,
  STAMP_DUTY_RATE,
  TRANSFER_FEE_RATE,
  calcFee,
  priceLimitPct,
} from "@aw/game";
import { fmtNum } from "../lib/helpers";
import { Card, KV, Notice } from "./common";

/** 用一笔真实计算做示例，而不是干讲费率 */
function exampleTrade(): { amount: number; buy: ReturnType<typeof calcFee>; sell: ReturnType<typeof calcFee> } {
  const amount = 100_000; // 10 万元成交额，便于心算
  return { amount, buy: calcFee("buy", amount), sell: calcFee("sell", amount) };
}

const pct = (r: number) => `${(r * 100).toFixed(r < 0.001 ? 3 : 2)}%`;

export function GameRulesView({ onBack }: { onBack: () => void }) {
  const ex = exampleTrade();
  const roundTrip = ex.buy.total + ex.sell.total;

  return (
    <div className="view">
      <div className="back-bar">
        <button type="button" className="btn btn-ghost btn-tiny" onClick={onBack}>
          ← 返回模拟盘
        </button>
        <h2 className="back-title">撮合规则说明</h2>
      </div>

      <Notice tone="info">
        模拟盘按 A 股真实规则撮合。理解这些规则比记住任何"结论"都有用——
        它们决定了你的实际收益与真实交易的差距。
      </Notice>

      <Card title="T+1：当日买入，次日才能卖" subtitle="A 股最基础也最容易被忽略的制度约束">
        <p className="rule-body">
          A 股实行 <strong>T+1</strong> 交收：今天买入的股票，要到<strong>下一个交易日</strong>才能卖出。
          当日买入的部分在持仓里显示为「不可卖」，次日自动解锁。
        </p>
        <p className="rule-body">
          <strong>为什么重要：</strong>它意味着你无法当天纠错。早盘追高被套，只能扛到明天——
          这把"当日止损"这条退路直接堵死了，所以买入决策的权重要比 T+0 市场高得多。
        </p>
        <p className="rule-body">
          <strong>资金侧同样受约束：</strong>卖出所得当日可用于继续买入（资金 T+0），
          但取现要到次日。模拟盘实现了股票侧的 T+1。
        </p>
      </Card>

      <Card title="涨跌停：单日价格有上限" subtitle="不是所有价格都能成交">
        <p className="rule-body">
          单日涨跌幅有上限，触及上限后<strong>涨停无法买入、跌停无法卖出</strong>：
        </p>
        <div className="kv-list">
          <KV k="主板" v={`±${pct(priceLimitPct(false, false))}`} />
          <KV k="创业板 / 科创板" v={`±${pct(priceLimitPct(false, true))}`} />
          <KV k="ST / 风险警示股" v={`±${pct(priceLimitPct(true, false))}`} />
        </div>
        <p className="rule-body">
          <strong>为什么重要：</strong>涨停时买不进、跌停时卖不出，这不是模拟盘的 bug，
          而是真实市场的流动性约束。极端行情下"想跑跑不掉"是常态。
        </p>
      </Card>

      <Card title="交易费用：来回一趟吃掉多少" subtitle={`以 ${fmtNum(ex.amount)} 元成交额为例`}>
        <p className="rule-body">A 股三项主要费用，买卖方向不同：</p>
        <div className="kv-list">
          <KV k="佣金" v={`${pct(COMMISSION_RATE)}，单笔最低 ${fmtNum(COMMISSION_MIN)} 元（双向）`} />
          <KV k="印花税" v={`${pct(STAMP_DUTY_RATE)}（仅卖出）`} />
          <KV k="过户费" v={`${pct(TRANSFER_FEE_RATE)}（双向）`} />
        </div>
        <div className="kv-list">
          <KV k="买入费用" v={`${fmtNum(ex.buy.total)} 元（佣金 ${fmtNum(ex.buy.commission)} + 过户费 ${fmtNum(ex.buy.transferFee)}）`} />
          <KV k="卖出费用" v={`${fmtNum(ex.sell.total)} 元（佣金 ${fmtNum(ex.sell.commission)} + 印花税 ${fmtNum(ex.sell.stampDuty)} + 过户费 ${fmtNum(ex.sell.transferFee)}）`} />
          <KV k="来回合计" v={`${fmtNum(roundTrip)} 元，占成交额 ${((roundTrip / ex.amount) * 100).toFixed(3)}%`} />
        </div>
        <p className="rule-body">
          <strong>为什么重要：</strong>来回成本约 {((roundTrip / ex.amount) * 100).toFixed(2)}%，
          意味着频繁交易时，<strong>胜率不变、交易次数翻倍，收益就会被费用吃掉</strong>。
          这是"少动手"在数学上的依据。
        </p>
      </Card>

      <Card title="滑点：成交价和你看到的不一样" subtitle={`默认 ${pct(DEFAULT_SLIPPAGE)}`}>
        <p className="rule-body">
          下单到成交有延迟，且你的买单要吃掉卖一档的挂单。模拟盘按
          <strong>买入价上浮 {pct(DEFAULT_SLIPPAGE)}、卖出价下浮 {pct(DEFAULT_SLIPPAGE)}</strong> 成交，
          用来近似这个冲击成本。
        </p>
        <p className="rule-body">
          <strong>为什么重要：</strong>它让"看到什么价就按什么价成交"的幻觉消失。
          流动性差的股票实际滑点远大于此，模拟盘给的是一个乐观下限。
        </p>
      </Card>

      <Card title="一手 = 100 股" subtitle="以及零股怎么处理">
        <p className="rule-body">
          买入必须是 <strong>{LOT_SIZE} 股</strong>的整数倍；卖出也需为整数倍，
          但可以<strong>一次性卖出全部剩余持仓</strong>（A 股的零股规则）。
        </p>
        <p className="rule-body">
          按一手计算，股价 100 元的股票，一次最少需要约 1 万元——这构成了实际的门槛。
        </p>
      </Card>

      <Card title="非交易时段下单会怎样" subtitle="本模拟盘的处理方式">
        <p className="rule-body">
          非交易时段仍可下单，但按<strong>最近收盘价</strong>成交，
          并在成交记录中标注「非交易时段下单，按最近收盘价成交（非实时价）」。
        </p>
        <p className="rule-body">
          真实的排队机制是：非交易时段的委托会进入次一交易日的集合竞价，按<strong>开盘价</strong>成交。
          模拟盘做不到这一点（纯前端拿不到未来的开盘价），因此选择"按最新价成交 + 明确标注"，
          而不是假装能排队。
        </p>
      </Card>

      <Card title="为什么成绩要和沪深300比" subtitle="这一条决定游戏是否有意义">
        <p className="rule-body">
          只看绝对收益的话，牛市里随便买都赚钱，人人都是股神，游戏就失去了区分度。
        </p>
        <p className="rule-body">
          <strong>超额收益 = 你的收益 − 同期沪深300 收益。</strong>
          它回答的是"你选股择时到底有没有创造价值"，而不是"市场赏了你多少"。
        </p>
        <p className="rule-body">
          同理，<strong>最大回撤</strong>和<strong>胜率</strong>必须一起看：
          收益高但回撤 50% 的策略，多数人拿不住；胜率 90% 但每次都小赚大亏，长期也是亏的。
        </p>
      </Card>

      <Card title="风险报酬比怎么读" subtitle="信号里那个 “x : 1”">
        <p className="rule-body">
          信号给出的三个价位是：参考买入价（20 日线）、参考止损价（买入价下方 2×ATR）、
          参考目标价（现价上方 3×ATR）。
        </p>
        <p className="rule-body">
          风险报酬比 = <strong>（目标价 − 买入价）/（买入价 − 止损价）</strong>。
          比值 2:1 意味着"赚 2 块的可能，对应亏 1 块的风险"。
        </p>
        <p className="rule-body">
          <strong>重要限定：</strong>这些价位由 ATR（真实波幅）推算，是<strong>技术测算而非承诺</strong>。
          ATR 只告诉你近期波动有多大，不告诉你方向——方向来自那个很可能出错的信号。
        </p>
      </Card>
    </div>
  );
}
