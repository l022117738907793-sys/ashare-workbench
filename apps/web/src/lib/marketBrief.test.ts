import { describe, expect, it } from "vitest";
import { marketBriefMetrics, marketMetric } from "./marketBrief";
import type { MarketResult } from "@aw/core";
const market = (values: Record<string, number | null>): MarketResult => ({state:"正常", implication:"", reasons:Object.entries(values).map(([key,value]) => ({key,value,label:key,pass:false,threshold:"",note:""}))});
describe("market brief measurement meanings", () => {
  it("keeps percent units from engine instead of multiplying breadth again", () => {const metrics=marketBriefMetrics(market({"main.ret20":2.34,"main.breadth":62.5,"main.aboveMA20":1}));expect(metrics.map(m=>m.value)).toEqual(["+2.3%","62.5%","站上均线"]);expect(metrics[1].explanation).toContain("不是今天上涨家数");expect(metrics[1].explanation).toContain("历史不足");});
  it("never presents missing data as zero", () => {expect(marketBriefMetrics(market({})).every(m=>m.value==="数据不足")).toBe(true);expect(marketMetric(market({"main.ret20":NaN}),"main.ret20")).toBeNull();});
  it("shows negative return and below-average position accurately", () => {expect(marketBriefMetrics(market({"main.ret20":-3,"main.breadth":0,"main.aboveMA20":0})).map(m=>m.value)).toEqual(["-3.0%","0.0%","低于均线"]);});
});
