import { useState } from "react";
import sheet from "../assets/hisui-expressions.webp";
import blink from "../assets/hisui-blink.webp";
import { MOOD_CELL, type HisuiMood } from "../lib/hisui";
import { AskBox } from "./Terms";
import { AppIcon } from "./AppIcon";

const TIPS: Array<{label: string; mood: HisuiMood; text: string}> = [
  {label: "先做什么", mood: "neutral", text: "少爷，第一次来可以选择传奇模式。先读开局简报，再看看截至当前日期的走势，记录自己的判断。"},
  {label: "委托与成交", mood: "explain", text: "少爷，历史推演里，委托提交后要等到下一交易日开盘撮合。请先看待成交委托，再点击“走一天”。"},
  {label: "时间与规则", mood: "concern", text: "少爷，快进时日期仍在推进。读信息或整理思路时，可以先暂停。当天新获得的股票，要到下一交易日才可出售。"},
  {label: "怎样复盘", mood: "thinking", text: "少爷，我们可以对照最初的判断、成交记录和资金变化。一次结果还不能说明方法一直有效。"},
];

const START_TIPS = {
  lobby: TIPS[0].text,
  resume: "少爷，您已有一局历史推演。点击继续推演接上原进度，也可以进入独立的实时账户练习。",
  chapter: "少爷，请先读章节简报，再选择虚拟本金。点击进入后，您只能看到当前交易日及以前的信息。",
  replay: "少爷，先查看当前行情与当天资讯，再选择股票、挂出委托。点击“走一天”，检查次日开盘的成交结果；需要思考时请暂停快进。",
  live: "少爷，先选择股票与委托数量，再确认行情价格和交易费用。实时盘会跟随现实时间，休市时请留意页面的成交说明。",
};

export function GameCompanion({onGuide, context = "lobby"}: {onGuide: () => void; context?: keyof typeof START_TIPS}) {
  const [index, setIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const tip = index === 0 ? {...TIPS[0], text: START_TIPS[context]} : TIPS[index];
  const [x,y] = MOOD_CELL[tip.mood];
  const position = `${x * 50}% ${y * 100}%`;
  return <section className="game-companion" aria-label="翡翠教学助手">
    <div className="companion-portrait" role="img" aria-label={`翡翠，${tip.label}`}>
      <span className="companion-frame companion-open" style={{backgroundImage:`url(${sheet})`,backgroundPosition:position}} />
      <span className="companion-frame companion-blink" style={{backgroundImage:`url(${blink})`,backgroundPosition:position}} />
    </div>
    <div className="companion-copy">
      <span className="eyebrow">YOUR MARKET COMPANION</span>
      <h2>不确定下一步？翡翠陪您一起。</h2>
      <p aria-live="polite">{tip.text}</p>
      {expanded && <div className="companion-details">
        <div className="chips">{TIPS.map((t,i) => <button key={t.label} className={`chip${i===index ? " chip-active" : ""}`} aria-pressed={i===index} onClick={() => setIndex(i)}>{t.label}</button>)}</div>
        <AskBox term="模拟游戏操作" context={[START_TIPS[context], ...TIPS.slice(1).map(t => t.text)].join("\n")} />
      </div>}
    </div>
    <div className="companion-actions">
      <button className="btn btn-ghost" type="button" aria-expanded={expanded} onClick={() => setExpanded(v=>!v)}>{expanded ? "收起帮助" : "听翡翠讲解"}</button>
      <button className="text-action" type="button" onClick={onGuide}>完整玩法指南 <AppIcon name="arrow" size={15}/></button>
    </div>
  </section>;
}
