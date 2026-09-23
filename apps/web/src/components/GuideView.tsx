/**
 * 使用说明页。
 *
 * 为什么做进站点而不是只放仓库：这个工具是发给同学用的，
 * 同学只拿到一个链接，不会去翻 GitHub 仓库里的 markdown。
 *
 * 内容与 docs/user-guide.md 对应，但按手机屏幕阅读重排
 * （长文分段、每段一个 Card）。改动时两边要同步。
 */
import { Card, KV, Notice } from "./common";

export function GuideView({ onBack }: { onBack: () => void }) {
  return (
    <div className="view">
      <div className="back-bar">
        <button type="button" className="btn btn-ghost btn-tiny" onClick={onBack}>
          ← 返回
        </button>
        <h2 className="back-title">使用说明</h2>
      </div>

      <Notice tone="info">
        这个工具做一件事：把 A 股按「趋势」筛成几类，并告诉你每一类是怎么判断出来的。
        <br />
        它不是荐股软件，不给买卖建议。
      </Notice>

      <Card title="四层漏斗" subtitle="整个工具的核心结构">
        <p className="rule-body">
          一层层收窄，每一层的结论都建立在上一层之上：
        </p>
        <div className="kv-list">
          <KV k="① 大盘环境" v="现在整体市场适不适合做趋势？" />
          <KV k="② 板块强弱" v="哪些行业在走强、哪些在走弱？" />
          <KV k="③ 个股分类" v="这只股票属于哪一类？" />
          <KV k="④ 个股分析" v="七个步骤拆开看，每步都有依据" />
        </div>
        <p className="rule-body">
          <strong>大盘不好的时候，后面几层的结论要打折看。</strong>
        </p>
      </Card>

      <Card title="五个页面" subtitle="底部标签栏">
        <div className="kv-list">
          <KV k="筛选" v="主页面。大盘环境 → 板块强弱 → 个股分类" />
          <KV k="个股分析" v="点开一只股票后的七步分析 + 学习模式" />
          <KV k="模拟盘" v="100 万虚拟资金，按 A 股真实规则练手" />
          <KV k="历史" v="你分析过什么，存在你自己的浏览器里" />
          <KV k="设置" v="调阈值、改刷新间隔、清空本地数据" />
        </div>
      </Card>

      <Card title="六种分类的含义" subtitle="筛选页第三层">
        <div className="kv-list">
          <KV k="启动观察" v="刚放量启动，站上 20 日线" />
          <KV k="趋势观察" v="已经在趋势里" />
          <KV k="回调观察" v="涨过之后在回调，看回调是否健康" />
          <KV k="高位观察" v="涨太多了，注意滞涨风险" />
          <KV k="排除" v="走势走坏，暂不关注" />
          <KV k="数据不足" v="数据不够，不做判断" />
        </div>
      </Card>

      <Card title="怎么读「判断依据」" subtitle="这是整个工具最重要的东西">
        <p className="rule-body">
          每个结论下面都有一行行小字：
        </p>
        <p className="rule-body mono-sample">
          沪深300 近20日涨幅&nbsp;&nbsp;−2.31&nbsp;&nbsp;阈值 ≥3%&nbsp;&nbsp;未通过
        </p>
        <p className="rule-body">
          读法：<strong>左边是实际值，中间是要求，右边是通过还是没通过。</strong>
        </p>
        <p className="rule-body">
          结论不是拍脑袋来的，是这些条件算出来的。
          <strong>你想反驳结论，就看哪一条依据你不认同。</strong>
        </p>
      </Card>

      <Card title="【数据不足，不许编造】是什么意思" subtitle="不是系统坏了">
        <p className="rule-body">
          如果某只股票可用交易日不够（少于 60 天），或者长期停牌，系统会明确显示
          <strong>「数据不足」</strong>并列出缺什么。
        </p>
        <p className="rule-body">
          <strong>它不会猜。</strong>缺数据就是缺数据，不会用 0 或推测值顶上去。
        </p>
      </Card>

      <Card title="模拟盘规则" subtitle="和真实 A 股一致，点模拟盘页的「规则说明」看详细解释">
        <div className="kv-list">
          <KV k="T+1" v="今天买的明天才能卖" />
          <KV k="涨跌停" v="涨停买不进、跌停卖不出" />
          <KV k="手续费" v="佣金万 2.5（最低 5 元）+ 印花税千 1（卖出）+ 过户费万 0.1" />
          <KV k="滑点" v="买入上浮 0.1%、卖出下浮 0.1%" />
          <KV k="一手" v="100 股整数倍" />
          <KV k="停牌/无行情" v="拒绝下单，不猜价格" />
        </div>
        <p className="rule-body">
          <strong>成绩看超额收益</strong>（你的收益 − 同期沪深300），
          而不是绝对收益 —— 否则牛市里人人都是股神。
        </p>
      </Card>

      <Card title="⚠️ 关于交易信号" subtitle="务必看完这条">
        <Notice tone="warn">
          个股分析页顶部那张信号卡，给出的买入/卖出方向
          <strong>没有证据支持它有效</strong>。
        </Notice>
        <p className="rule-body">
          用它自己的历史数据回测了 580 个交易日，结果是：看多信号比看空信号的前瞻收益只高
          <strong>0.16~0.27 个百分点</strong>，三种统计检验<strong>全部跨越 0</strong>
          —— 也就是和随机无法区分。
        </p>
        <p className="rule-body">
          <strong>说白了：准确度和抛硬币差不多。</strong>
          留着它是因为它展示了完整的判断逻辑，<strong>当观察框架可以，当交易依据不行</strong>。
        </p>
        <p className="rule-body">
          那三个参考价位（买入价 / 止损 / 目标）是 ATR 技术测算，<strong>不是收益承诺</strong>。
        </p>
      </Card>

      <Card title="常见问题">
        <div className="kv-list">
          <KV k="数据实时吗" v="历史日线每工作日 18:30 更新；盘中价格实时（3-5 秒），两者来源不同，页面会标注" />
          <KV k="收盘后价格不动" v="不在交易时段就不请求行情，页面顶部显示当前状态" />
          <KV k="提示「行情降级」" v="数据源按 腾讯→东财→本地快照 自动切换，会明确告诉你实际用的哪个" />
          <KV k="记录会上传吗" v="不会，全存在你自己浏览器的本地存储里" />
          <KV k="为什么只有 92 只股票" v="演示池：31 个申万一级行业各取市值前几只代表股" />
          <KV k="手机上更顺手" v="Safari 分享→添加到主屏幕；Chrome 菜单→添加到主屏幕" />
        </div>
      </Card>

      <Card title="这个工具不做什么" subtitle="明确说清，免得误会">
        <div className="kv-list">
          <KV k="不给买卖建议" v="信号已证明无效，见上" />
          <KV k="不预测涨跌" v="只描述当前状态" />
          <KV k="数据不足不编造" v="缺就显示缺" />
          <KV k="不做实盘交易" v="不接任何券商接口" />
          <KV k="没有基本面数据" v="财报、估值、资金流都没有，纯技术面" />
        </div>
      </Card>

      <p className="field-hint" style={{ textAlign: "center", padding: "12px 0" }}>
        数据来源：申万官网（akshare）+ 腾讯行情 + 东方财富。仅供学习研究，不构成投资建议。
      </p>
    </div>
  );
}
