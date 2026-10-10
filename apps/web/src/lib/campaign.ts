import { replayPrices, totalAssets, type ReplayState, type SeasonResult } from "@aw/game";

export const CAMPAIGN_STORAGE = "aw.campaign-notes.v1";
export const RISK_TARGET = 10;
export interface DecisionNote { dayIndex: number; action: "observe" | "buy" | "sell"; reason: string }
export const ACTION_LABEL = { observe: "保持观望", buy: "买入计划", sell: "卖出计划" };

/** A separate presentation-layer journal; the trading save and engine stay unchanged. */
export function campaignKey(state: ReplayState): string {
  return `${state.config.label ?? "random"}|${state.config.calendar[state.config.startIndex]}|${state.config.initialCash}`;
}
export function visibleNotes(state: ReplayState, notes: DecisionNote[]): DecisionNote[] {
  return notes.filter(n => Number.isInteger(n.dayIndex) && n.dayIndex >= state.config.startIndex && n.dayIndex <= state.dayIndex
    && Object.hasOwn(ACTION_LABEL, n.action) && typeof n.reason === "string" && n.reason.trim().length >= 6)
    .sort((a,b) => a.dayIndex - b.dayIndex);
}
export function readCampaignNotes(state: ReplayState): DecisionNote[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CAMPAIGN_STORAGE) ?? "null");
    return raw?.key === campaignKey(state) && Array.isArray(raw.notes) ? visibleNotes(state, raw.notes) : [];
  } catch { return []; }
}
export function writeCampaignNotes(state: ReplayState, notes: DecisionNote[]): boolean {
  try {
    localStorage.setItem(CAMPAIGN_STORAGE, JSON.stringify({key: campaignKey(state), notes: visibleNotes(state, notes)}));
    return true;
  } catch { return false; }
}
export function resetCampaignNotes(): void {
  try { localStorage.removeItem(CAMPAIGN_STORAGE); } catch { /* The journal can still work in memory. */ }
}
export function campaignStats(state: ReplayState, notes: DecisionNote[]) {
  const date = state.config.calendar[state.dayIndex];
  const curve = state.equity.filter(p => p.date <= date && p.date >= state.config.calendar[state.config.startIndex]);
  let peak = state.account.initialCash, drawdown = 0;
  for (const point of curve) {
    if (!Number.isFinite(point.total)) continue;
    peak = Math.max(peak, point.total);
    if (peak > 0) drawdown = Math.max(drawdown, (peak - point.total) / peak * 100);
  }
  const noteCount = new Set(visibleNotes(state, notes).map(n => n.dayIndex)).size;
  const goals = [drawdown <= RISK_TARGET, noteCount >= 2, state.finished];
  return { drawdown, noteCount, goals, earned: goals.filter(Boolean).length };
}
/** Report only the interval already advanced; never look at a future price or news item. */
export function dailyReport(state: ReplayState, fromDay: number) {
  const dates = new Set(state.config.calendar.slice(Math.max(state.config.startIndex, fromDay + 1), state.dayIndex + 1));
  const previous = state.equity.find(p => p.date === state.config.calendar[fromDay])?.total;
  const assets = totalAssets(state.account, replayPrices(state));
  const logs = state.log.filter(e => dates.has(e.date));
  return { assets, change: previous === undefined ? null : assets - previous, logs,
    filled: logs.filter(e => e.ok).length, failed: logs.filter(e => !e.ok).length,
    days: Math.max(0, state.dayIndex - fromDay) };
}

/** Export is offered only after the run ends, when the hidden dates can be revealed. */
export function completedReportData(state: ReplayState, result: SeasonResult, notes: DecisionNote[]) {
  if (!state.finished) return null;
  const date = state.config.calendar[state.dayIndex];
  return { title: state.config.label ?? "交易挑战", result, challenge: campaignStats(state, notes),
    decisions: visibleNotes(state,notes).map(n=>({day:n.dayIndex-state.config.startIndex+1,action:ACTION_LABEL[n.action],reason:n.reason})),
    trades: state.account.trades.filter(t=>t.date<=date), scope: "虚拟模拟；一局成绩不代表投资能力。" };
}

export const CHAPTER_FOCUS: Record<string, string> = {
  "2016-11-11": "在全球消息之间，保留自己的判断。",
  "2018-10-11": "面对休市间隙，提前想清自己的计划。",
  "2019-02-25": "面对热闹的市场，记录行动的理由。",
  "2020-02-03": "信息不断变化时，练习处理不确定性。",
  "2020-07-02": "读懂眼前的线索，观察自己的决策过程。",
  "2021-03-10": "把公司的故事与自己的交易计划分开看。",
  "2021-09-01": "从当时的消息中，找出自己的判断依据。",
  "2022-04-25": "面对不确定的盘面，保持决策有据可查。",
  "2023-03-20": "面对主题轮动，记录自己相信的证据。",
  "2024-09-25": "市场安静的时候，观望也可以有理由。",
};
