import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeMarket,
  analyzeSector,
  buildReport,
  classifyStock,
  computeStockMetrics,
  type Snapshot,
} from "./engine";

const fixDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures",
);
const fixtures = readdirSync(fixDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(fixDir, f), "utf-8")));

describe("分析引擎与 fixture 一致性", () => {
  it("fixture 数量完整", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(12);
  });

  for (const fx of fixtures) {
    describe(fx.id, () => {
      const snapshot = fx as Snapshot & {
        rules: Record<string, unknown>;
        expected: Record<string, any>;
      };
      const rules = fx.rules as any;
      const targetStock = fx.stocks.find(
        (s: { code: string }) => s.code === fx.expected.stock.code,
      ) ?? fx.stocks.at(-1);

      it("大盘状态", () => {
        const res = analyzeMarket(snapshot, rules);
        expect(res.state).toBe(fx.expected.market);
        expect(res.reasons.length).toBeGreaterThanOrEqual(3);
      });

      it("板块状态", () => {
        const sector = snapshot.sectors[0];
        const stocksByCode = new Map(
          snapshot.stocks.map((s: any) => [s.code, s]),
        );
        const res = analyzeSector(sector, stocksByCode, rules);
        expect(res.state).toBe(fx.expected.sector.state);
        expect(res.reasons.length).toBeGreaterThanOrEqual(5);
      });

      it("个股分类", () => {
        const res = classifyStock(targetStock, rules);
        expect(res.type).toBe(fx.expected.stock.type);
        if (fx.expected.stock.subtype) {
          expect(res.subtype).toContain(fx.expected.stock.subtype);
        }
        if (fx.expected.stock.atrFlag) {
          expect(res.atr.available).toBe(true);
          expect(res.atr.flag).toBe(fx.expected.stock.atrFlag);
        }
        expect(res.reasons.length).toBeGreaterThanOrEqual(5);
      });

      it("七步报告结构与红线", () => {
        const report = buildReport(snapshot, targetStock.code, rules);
        expect(report.currentType).toBe(fx.expected.stock.type);
        expect(report.market.state).toBe(fx.expected.market);
        expect(report.sector.state).toBe(fx.expected.sector.state);
        expect(report.nextSteps.length).toBeGreaterThan(0);
        expect(report.why.length).toBeGreaterThanOrEqual(3);
        const m = computeStockMetrics(targetStock, rules);
        const text = [
          report.conclusion,
          ...report.why,
          ...report.nextSteps,
        ].join(" ");
        for (const bad of ["买入", "卖出", "目标价", "必涨", "必跌"]) {
          expect(text).not.toContain(bad);
        }
        expect(m.days).toBe(targetStock.close.length);
      });
    });
  }
});

describe("大盘广度只数 A 股", () => {
  const base = fixtures[0] as Snapshot & { rules: any };
  const rules = base.rules;
  const breadthOf = (r: { reasons: Array<{ key: string; value: number | null }> }) => {
    const item = r.reasons.find((x) => x.key === "main.breadth");
    expect(item, "main.breadth 应当存在").toBeDefined();
    return item!.value;
  };

  /**
   * 造一批「20 日一路下跌」的港股掺进股票池。
   *
   * 恒生涨跌跟沪深300 不是一回事：这些港股若被算进分母，广度会被明显拉低，
   * 卡在 strong/weak 阈值附近时足以把「大盘环境」的结论翻过来。
   */
  const fallingHk = (n: number): any[] =>
    Array.from({ length: n }, (_, i) => {
      const close = Array.from({ length: 60 }, (_, k) => 100 * Math.pow(0.99, k));
      return {
        code: `${String(700 + i).padStart(5, "0")}.HK`,
        name: `港股${i}`,
        industry: "港股",
        industryCode: "HK",
        weight: 0,
        isST: false,
        market: "HK",
        currency: "HKD",
        open: close,
        close,
        high: close,
        low: close,
        volume: close.map(() => 1),
      };
    });

  it("掺进 40 只下跌的港股，广度与大盘结论都不变", () => {
    const before = analyzeMarket(base, rules);
    const after = analyzeMarket({ ...base, stocks: [...base.stocks, ...fallingHk(40)] }, rules);
    expect(breadthOf(after)).toBe(breadthOf(before));
    expect(after.state).toBe(before.state);
  });

  it("对照组：同样 40 只换成 A 股，广度会被拉下去（证明上面不是空跑）", () => {
    const before = analyzeMarket(base, rules);
    const cnTwins = fallingHk(40).map((s) => ({ ...s, code: s.code.replace(".HK", ".SZ"), market: "CN", currency: "CNY" }));
    const after = analyzeMarket({ ...base, stocks: [...base.stocks, ...cnTwins] }, rules);
    expect(breadthOf(after)).not.toBe(breadthOf(before));
  });
});
