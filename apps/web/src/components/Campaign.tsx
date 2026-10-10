import { useEffect, useRef, useState } from "react";
import { type ReplayState, type SeasonResult } from "@aw/game";
import { ACTION_LABEL, RISK_TARGET, campaignStats, completedReportData, dailyReport, visibleNotes, type DecisionNote } from "../lib/campaign";
import { fmtNum, fmtPct } from "../lib/helpers";
import { maskDatesIn } from "../lib/replay";

export function CampaignEmblem({number = "01"}: {number?: string}) {
  return <div className="campaign-emblem" aria-hidden="true"><div className="campaign-orbit"/><div className="campaign-orbit orbit-inner"/><svg viewBox="0 0 100 100"><path d="M50 7 84 25v40L50 93 16 65V25Z"/><path d="m34 43 16-17 16 17M50 26v41M37 59l13 14 13-14"/></svg><span>{number}</span></div>;
}
export function ChapterObjective() {
  return <div className="chapter-objective"><span className="campaign-kicker">CHALLENGE / 本章挑战</span><p>回撤 ≤ {RISK_TARGET}% <i>·</i> 记录 2 次判断 <i>·</i> 完成推演</p><small>观望也是决策。挑战条件只用于本局学习。</small></div>;
}

export function CampaignHUD({state,notes,onSave,hideDate}: {state: ReplayState; notes: DecisionNote[]; onSave: (note: DecisionNote) => boolean; hideDate: boolean}) {
  const stats = campaignStats(state, notes);
  const current = notes.find(n => n.dayIndex === state.dayIndex);
  const [action,setAction] = useState<DecisionNote["action"]>(current?.action ?? "observe");
  const [reason,setReason] = useState(current?.reason ?? "");
  const [feedback,setFeedback] = useState("");
  useEffect(() => { const n = notes.find(n => n.dayIndex === state.dayIndex); setReason(n?.reason ?? ""); setAction(n?.action ?? "observe"); setFeedback(""); }, [state.dayIndex]);
  return <details className="campaign-hud"><summary><span className="campaign-hud-title"><span className="campaign-target">◎</span><strong>本局挑战</strong><small>{stats.noteCount}/2 次判断 · 回撤 {stats.drawdown.toFixed(1)}%</small></span><span className="campaign-stars" aria-label={`${stats.earned} 项条件当前达成`}>{stats.goals.map((ok,i)=><span key={i} className={ok ? "is-earned" : ""}>◆</span>)}<b>＋</b></span></summary>
    <div className="campaign-hud-body"><div className="campaign-goals">{["回撤控制在 10% 以内","记录两个交易日的判断","走完这段历史"].map((text,i)=><div key={text}><span className={stats.goals[i] ? "goal-done" : ""}>{stats.goals[i] ? "✓" : "○"}</span><span>{text}</span></div>)}</div>
    <form className="campaign-journal" onSubmit={e=>{e.preventDefault(); const text=reason.trim(); if(text.length<6) return setFeedback("请写下至少 6 个字的观察或理由。"); const saved=onSave({dayIndex:state.dayIndex,action,reason:text.slice(0,240)}); setFeedback(saved ? "今日判断已保存，战报里可以回看。" : "判断已记下；此浏览器无法保存，刷新后会丢失。");}}>
      <label htmlFor="campaign-reason">第 {state.dayIndex-state.config.startIndex+1} 天 · 我的判断</label><div className="campaign-note-actions" role="group" aria-label="今日决策类型">{(Object.keys(ACTION_LABEL) as DecisionNote["action"][]).map(k=><button key={k} type="button" aria-pressed={action===k} disabled={state.finished} onClick={()=>setAction(k)}>{ACTION_LABEL[k]}</button>)}</div>
      <textarea id="campaign-reason" value={reason} onChange={e=>setReason(e.target.value)} maxLength={240} rows={2} placeholder="我看到了什么？为什么行动，或为什么继续观望？" disabled={state.finished}/><div className="campaign-note-footer"><small>只记录想法，不会替您下单。</small><button type="submit" className="btn btn-primary btn-tiny" disabled={state.finished}>{current ? "更新今日判断" : "记下今日判断"}</button></div>
      {feedback && <p role="status">{feedback}</p>}
    </form>{notes.length>0 && <div className="campaign-note-history"><span>先前的判断</span>{visibleNotes(state,notes).slice(-3).reverse().map(n=><p key={n.dayIndex}><b>DAY {String(n.dayIndex-state.config.startIndex+1).padStart(2,"0")} · {ACTION_LABEL[n.action]}</b>{maskDatesIn(state,n.reason,hideDate)}</p>)}</div>}</div></details>;
}

export function DailyDispatch({state,fromDay,hideDate,onClose}: {state: ReplayState; fromDay: number; hideDate: boolean; onClose:()=>void}) {
  const report = dailyReport(state,fromDay);
  const day=state.dayIndex-state.config.startIndex+1;
  return <section className="daily-dispatch" aria-label="每日回报" aria-live="polite"><header><span className="campaign-kicker">DAY {String(day).padStart(2,"0")} / {report.days>1 ? `${report.days} 个交易日的回报` : "开盘回报"}</span><button type="button" className="dispatch-close" aria-label="收起每日回报" onClick={onClose}>×</button></header><div className="dispatch-metrics"><div><small>资产变化</small><strong className={report.change !== null && report.change < 0 ? "tone-bad" : "tone-good"}>{report.change===null ? "暂无上一日数据" : `${report.change>=0?"+":""}${fmtNum(report.change)}`}<span>{report.change===null ? "" : " 元"}</span></strong></div><div><small>成交 / 未成交</small><strong>{report.filled}<span> / {report.failed}</span></strong></div></div><p>{report.logs.length ? maskDatesIn(state,report.logs[report.logs.length-1].text,hideDate) : "这段时间没有委托成交。继续观察，也是在作出决定。"}</p><small className="dispatch-next">今日信息已更新 · 到「行情资讯」查看当日归档</small></section>;
}

export function CampaignReport({state,result,notes,hideDate,label,onClose,onRestart,onNext}: {state: ReplayState; result: SeasonResult; notes: DecisionNote[]; hideDate: boolean; label: string; onClose:()=>void; onRestart?:()=>void; onNext?:()=>void}) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const stats = campaignStats(state,notes);
  const journal = visibleNotes(state,notes);
  useEffect(()=>{
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow=document.body.style.overflow; document.body.style.overflow="hidden"; closeButton.current?.focus();
    const key=(e: KeyboardEvent)=>{ if(e.key==="Escape") onClose(); if(e.key!=="Tab") return; const controls=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button, a[href], textarea, input, select, [tabindex="0"]')??[]).filter(el=>!el.hasAttribute("disabled")); const first=controls[0],last=controls[controls.length-1]; if(e.shiftKey && document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first?.focus();}};
    document.addEventListener("keydown",key); return()=>{document.body.style.overflow=oldOverflow;document.removeEventListener("keydown",key);previous?.focus();};
  },[onClose]);
  function download() {
    const data=completedReportData(state,result,notes); if(!data) return;
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:"application/json;charset=utf-8"}));
    const link=document.createElement("a");link.href=url;link.download="交易挑战-本局战报.json";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function startAnother(callback?:()=>void) {
    if(callback && confirm("开始新挑战会替换当前推演及判断笔记。需要保留本局结果的话，请先下载战报。确认开始？")) { onClose(); callback(); }
  }
  const conclusion=journal.length>=2 ? "您留下了可以回看的判断。下次重玩，可以比较同一条线索下的不同选择。" : "下次可以在两个不同交易日记录理由，让结果与当时的判断一起留下来。";
  return <div className="campaign-report-backdrop"><div className="campaign-report" role="dialog" aria-modal="true" aria-labelledby="campaign-report-title" ref={dialog}><header><span className="campaign-kicker">{state.finished ? "CAMPAIGN COMPLETE" : "CAMPAIGN CHECKPOINT"}</span><button className="dispatch-close" aria-label="关闭战报" onClick={onClose} ref={closeButton}>×</button></header><div className="report-title"><CampaignEmblem number={String(stats.earned).padStart(2,"0")}/><span className="campaign-kicker">{label}</span><h2 id="campaign-report-title">{state.finished ? "这段历史，留下了您的选择。" : "停下来，看看走过的这段路。"}</h2><p>{state.finished ? "本局战报" : "阶段战报"} · 第 {state.dayIndex-state.config.startIndex+1} 个交易日{hideDate && state.finished ? ` · 日期揭晓 ${result.startDate} — ${result.endDate}` : ""}</p></div><div className="report-stars">{stats.goals.map((ok,i)=><span key={i} className={ok?"is-earned":""}>◆</span>)}<small>{state.finished ? `${stats.earned}/3 项挑战完成` : `${stats.earned}/3 项条件当前达成`}</small></div><div className="report-score-grid"><div><span>本局收益</span><strong className={result.totalReturnPct>=0?"tone-good":"tone-bad"}>{fmtPct(result.totalReturnPct)}</strong></div><div><span>同期基准</span><strong>{fmtPct(result.benchmarkReturnPct)}</strong></div><div><span>最大回撤</span><strong>{result.maxDrawdownPct.toFixed(2)}%</strong></div><div><span>成交次数</span><strong>{result.tradeCount}<small> 笔</small></strong></div></div><div className="report-evidence"><h3>当时的您，是这样想的</h3>{journal.length ? journal.map(n=><article key={n.dayIndex}><span>DAY {String(n.dayIndex-state.config.startIndex+1).padStart(2,"0")} · {ACTION_LABEL[n.action]}</span><p>{maskDatesIn(state,n.reason,hideDate && !state.finished)}</p></article>) : <p>这局还没有留下判断笔记。成交与资金变化仍保存在本局记录中。</p>}</div><div className="report-coach"><span>✦ 复盘提示</span><p>{conclusion}</p></div>{state.finished && <div className="report-next-actions"><button type="button" className="btn btn-ghost" onClick={download}>下载本局战报</button>{onRestart && <button type="button" className="btn btn-ghost" onClick={()=>startAnother(onRestart)}>再挑战一次</button>}{onNext && <button type="button" className="btn btn-primary" onClick={()=>startAnother(onNext)}>进入下一章 →</button>}</div>}<button type="button" className="btn btn-primary report-return" onClick={onClose}>{state.finished ? "回到本局，查看完整记录 →" : "带着新的观察，继续推演 →"}</button><p className="report-footnote">挑战徽章记录本局练习完成情况，一局成绩不代表投资能力。</p></div></div>;
}
