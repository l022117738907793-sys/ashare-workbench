import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createReplay, type ReplayState, type Trade } from "@aw/game";
import { describe, expect, it } from "vitest";
import { ReplayChart } from "./ReplayChart";

const CODE = "601318.SH";
const CALENDAR = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-08", "2024-01-09"];

function makeState(close: Array<number | null>, volume: Array<number | null> = close.map(() => 1000)): ReplayState {
  const base = createReplay({
    calendar: CALENDAR,
    startIndex: 2,
    initialCash: 200_000,
    instruments: [{
      code: CODE,
      name: "中国平安",
      isST: false,
      open: close,
      high: close,
      low: close,
      close,
      volume,
    }],
  });
  return { ...base, dayIndex: 3 };
}

function trade(date: string, side: "buy" | "sell" = "buy"): Trade {
  return { id: date, at: Date.parse(`${date}T09:30:00+08:00`), date, code: CODE, name: "中国平安", side, price: 43, shares: 100, amount: 4300, fee: 5 };
}

function render(state: ReplayState, hideDate = true, code = CODE): string {
  return renderToStaticMarkup(createElement(ReplayChart, { state, code, hideDate }));
}

function path(html: string): string {
  return html.match(/class="replay-chart-line" d="([^"]*)"/)?.[1] ?? "";
}

function expectSafeGeometry(html: string): void {
  expect(html).not.toMatch(/(?:NaN|Infinity|undefined)/);
  expect(html).not.toMatch(/(?:cx|cy|x|y|width|height)="-/);
}

describe("ReplayChart historical boundaries", () => {
  it("changing every future price, volume and future trade cannot change rendered chart", () => {
    const knownOnly = makeState([40, 41, 42, 43, null, null], [100, 200, 300, 400, null, null]);
    knownOnly.account.trades = [trade(CALENDAR[2])];
    const withFuture = makeState([40, 41, 42, 43, 98765, 87654], [100, 200, 300, 400, 1e20, 1e25]);
    withFuture.account.trades = [trade(CALENDAR[2]), trade(CALENDAR[4], "sell"), trade(CALENDAR[5])];

    expect(render(withFuture)).toBe(render(knownOnly));
    const html = render(withFuture, false);
    expect(html).toContain("包含4个有效价格");
    expect(html).not.toContain(CALENDAR[4]);
    expect(html).not.toContain(CALENDAR[5]);
    expect(html).not.toContain("98765");
    expect(html.match(/class="replay-trade-dot/g)).toHaveLength(1);
  });

  it("random mode hides actual dates in visible text, ARIA and pre-entry labels", () => {
    const html = render(makeState([40, 41, 42, 43, 44, 45]), true);
    expect(html).not.toMatch(/2024|\d{4}-\d{2}-\d{2}/);
    expect(html).toContain("入场前 2 天");
    expect(html).toContain("第 2 天");
    expect(html).not.toContain("第 -");
  });

  it("legendary mode shows dates through current day without exposing next day", () => {
    const html = render(makeState([40, 41, 42, 43, 44, 45]), false);
    expect(html).toContain(CALENDAR[0]);
    expect(html).toContain(CALENDAR[3]);
    expect(html).not.toContain(CALENDAR[4]);
  });

  it("future-only prices never fill a missing current history", () => {
    const html = render(makeState([null, null, null, null, 44, 45]));
    expect(html).toContain("当前可见区间没有有效行情");
    expect(html).not.toContain('<svg');
    expect(html).not.toContain("¥ 44");
    expectSafeGeometry(html);
  });
});

describe("ReplayChart incomplete data", () => {
  it("zero, negative and non-finite prices are gaps, not fabricated free-stock prices", () => {
    const invalidOnly = makeState([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 44, 45]);
    const html = render(invalidOnly);
    expect(html).toContain("当前可见区间没有有效行情");
    expect(html).not.toContain('<svg');
    expect(html).not.toContain("¥ 0");
    expectSafeGeometry(html);
  });

  it("a missing day breaks the price path and preserves the correct time positions", () => {
    const html = render(makeState([40, null, 42, 43, 44, 45]));
    expect(html).toContain("包含3个有效价格");
    const drawing = path(html);
    expect(drawing.match(/M/g)).toHaveLength(2);
    expect(drawing.match(/L/g)).toHaveLength(1);
    expectSafeGeometry(html);
  });

  it("constant prices and zero volume remain finite and show no volume bars", () => {
    const html = render(makeState([40, 40, 40, 40, 40, 40], [0, 0, 0, 0, 0, 0]));
    expect(html).toContain("包含4个有效价格");
    expect(path(html).match(/L/g)).toHaveLength(3);
    expect(html).not.toContain('class="replay-chart-volume"');
    expectSafeGeometry(html);
  });

  it("invalid volume values cannot corrupt valid prices or chart geometry", () => {
    const html = render(makeState([40, 41, 42, 43, 44, 45], [Number.NaN, Number.POSITIVE_INFINITY, -100, null, 100, 100]));
    expect(html).toContain("包含4个有效价格");
    expect(html).not.toContain('class="replay-chart-volume"');
    expectSafeGeometry(html);
  });

  it("unknown stock and absent volume series render safely", () => {
    const state = makeState([40, 41, 42, 43, 44, 45], []);
    const chart = render(state);
    expectSafeGeometry(chart);
    expect(chart).not.toContain('class="replay-chart-volume"');
    const unknown = render(state, true, "unknown");
    expect(unknown).toContain("当前可见区间没有有效行情");
    expect(unknown).not.toContain('<svg');
  });
});
