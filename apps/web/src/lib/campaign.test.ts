import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceDay, createReplay, placeOrder, settleReplay } from "@aw/game";
import { CAMPAIGN_STORAGE, campaignStats, completedReportData, dailyReport, readCampaignNotes, resetCampaignNotes, visibleNotes, writeCampaignNotes, type DecisionNote } from "./campaign";

function run() {
  return createReplay({calendar:["2024-01-02","2024-01-03","2024-01-04"],startIndex:0,initialCash:10000,
    instruments:[{code:"600000.SH",name:"测试标的",isST:false,open:[10,10,9],close:[10,10,9],high:[10,10,9],low:[10,10,9],volume:[10000,10000,10000]}]});
}
const note: DecisionNote={dayIndex:0,action:"observe",reason:"先观察今天的公开信息"};
afterEach(()=>vi.unstubAllGlobals());

describe("Campaign evidence boundaries",()=>{
  it("does not count or display notes from a future day",()=>{
    const state=run();const notes=[note,{...note,dayIndex:2,reason:"未来的消息不能显示"}];
    expect(visibleNotes(state,notes)).toEqual([note]);expect(campaignStats(state,notes).noteCount).toBe(1);
  });
  it("does not use a future equity point to award the risk goal",()=>{
    const state=run();state.equity.push({date:"2024-01-03",total:1});
    expect(campaignStats(state,[]).drawdown).toBe(0);
    const tomorrow={...state,dayIndex:1};expect(campaignStats(tomorrow,[]).drawdown).toBeCloseTo(99.99);
    expect(campaignStats(tomorrow,[]).goals[0]).toBe(false);
  });
  it("requires two distinct observed days; repeated notes and no trades do not manufacture completion",()=>{
    const state=advanceDay(run());const notes=[note,{...note,reason:"另一个相同日期的判断"}];
    expect(campaignStats(state,notes).noteCount).toBe(1);
    expect(campaignStats(state,[note,{...note,dayIndex:1}]).goals).toEqual([true,true,false]);
    const finished=advanceDay(state);expect(campaignStats(finished,[note,{...note,dayIndex:1}]).earned).toBe(3);
    expect(finished.account.trades).toHaveLength(0);
  });
  it("daily results come from executed engine records, without tomorrow's fabricated log",()=>{
    const placed=placeOrder(run(),{code:"600000.SH",side:"buy",shares:100});expect(placed.ok).toBe(true);if(!placed.ok)return;
    const next=advanceDay(placed.state);next.log.push({date:"2024-01-04",code:"600000.SH",name:"测试标的",ok:true,text:"未来交易"});
    const report=dailyReport(next,0);expect(report.filled).toBe(1);expect(report.logs.some(l=>l.text==="未来交易")).toBe(false);
    expect(report.assets).toBeLessThan(10000);expect(report.change).toBeLessThan(0);
  });
  it("does not invent an asset delta when the previous equity point is missing",()=>{
    const state=advanceDay(run());state.equity=[];expect(dailyReport(state,0).change).toBe(null);
  });
  it("rejects malformed decisions while retaining valid observations",()=>{
    const invalid=[{...note,dayIndex:-1},{...note,reason:"短"},{...note,action:"auto"}];
    expect(visibleNotes(run(),[...invalid,note] as DecisionNote[])).toEqual([note]);
  });
  it("does not export a hidden interval before the run ends",()=>{
    const state=run();expect(completedReportData(state,settleReplay(state,"test").result,[note])).toBe(null);
  });
  it("exports completed evidence while excluding a future decision",()=>{
    const state=advanceDay(advanceDay(run()));
    const exported=completedReportData(state,settleReplay(state,"test").result,[note,{...note,dayIndex:3,reason:"不能导出的未来判断"}]);
    expect(exported?.decisions).toHaveLength(1);expect(exported?.result.finalAssets).toBe(10000);
    expect(JSON.stringify(exported)).not.toContain("不能导出的未来判断");
  });
});
describe("Independent campaign journal",()=>{
  it("persists notes without touching the existing trading save, and clears them on a new run",()=>{
    const entries=new Map<string,string>([["aw.replay.v1","existing trading save"]]);
    vi.stubGlobal("localStorage",{getItem:(k:string)=>entries.get(k)??null,setItem:(k:string,v:string)=>entries.set(k,v),removeItem:(k:string)=>entries.delete(k)});
    expect(writeCampaignNotes(run(),[note])).toBe(true);expect(readCampaignNotes(run())).toEqual([note]);
    expect(entries.get("aw.replay.v1")).toBe("existing trading save");resetCampaignNotes();
    expect(entries.has(CAMPAIGN_STORAGE)).toBe(false);expect(entries.get("aw.replay.v1")).toBe("existing trading save");
  });
  it("does not attach a previous chapter's notes to a different run",()=>{
    const entries=new Map<string,string>();vi.stubGlobal("localStorage",{getItem:(k:string)=>entries.get(k)??null,setItem:(k:string,v:string)=>entries.set(k,v)});
    const state=run();writeCampaignNotes(state,[note]);expect(readCampaignNotes({...state,config:{...state.config,label:"another chapter"}})).toEqual([]);
  });
  it("handles corrupt storage and denied persistence without crashing the game",()=>{
    vi.stubGlobal("localStorage",{getItem:()=>"corrupt",setItem:()=>{throw new Error("blocked");},removeItem:()=>{throw new Error("blocked");}});
    expect(readCampaignNotes(run())).toEqual([]);expect(writeCampaignNotes(run(),[note])).toBe(false);expect(()=>resetCampaignNotes()).not.toThrow();
  });
});
