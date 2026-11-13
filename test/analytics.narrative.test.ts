import { describe, expect, it } from "vitest";
import { assessCalibration, outcomeRates, twoProportionZ, type CalibrationGroup, type OutcomeCounts } from "../src/analytics/calibration.js";
import { comparePaperLive } from "../src/analytics/compare.js";
import { approxCount, formatDuration, formatInterval, formatPct, formatSol, groupThousands } from "../src/analytics/format.js";
import { summarizeTrades, type TradeSummary } from "../src/analytics/metrics.js";
import { describeCalibration, describeComparison, describeRecorder, describeSummary } from "../src/analytics/narrative.js";
import { alternating, MONDAY_MS, pair, tradesWithPnls } from "./analytics.fixtures.js";

function counts(n: number, survived: number, rugged: number, survivedKnown = n): OutcomeCounts {
  return { n, survivedKnown, survived, migrated: Math.floor(survived / 10), rugged, died: n - survived - rugged, hardBlocked: 0 };
}

function group(value: OutcomeCounts): CalibrationGroup {
  return { ...value, ...outcomeRates(value), medianPeakMultiple: 1.4, medianPeakFromScore: 1.1 };
}

describe("format", () => {
  it("formats SOL with three to four decimals and a sign", () => {
    expect(formatSol(-0.004)).toBe("-0.004");
    expect(formatSol(-0.0045)).toBe("-0.0045");
    expect(formatSol(0.0123)).toBe("+0.0123");
    expect(formatSol(0.012)).toBe("+0.012");
    expect(formatSol(1.23456)).toBe("+1.235");
    expect(formatSol(12.5, false)).toBe("12.500");
    expect(formatSol(0)).toBe("0.000");
    expect(formatSol(-0.00001)).toBe("0.000");
    expect(formatSol(null)).toBe("n/a");
    expect(formatSol(Number.NaN)).toBe("n/a");
  });

  it("rounds trade counts to two significant digits", () => {
    expect(approxCount(37)).toBe("37");
    expect(approxCount(417)).toBe("420");
    expect(approxCount(1234)).toBe("1,200");
    expect(approxCount(98_765)).toBe("99,000");
    expect(groupThousands(-1234567)).toBe("-1,234,567");
  });

  it("formats percentages, intervals and durations", () => {
    expect(formatPct(0.4567)).toBe("45.7%");
    expect(formatPct(null)).toBe("n/a");
    expect(formatInterval({ low: -0.01, high: 0.002 })).toBe("-0.010 to +0.002");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(200)).toBe("3m 20s");
    expect(formatDuration(7_500)).toBe("2h 5m");
    expect(formatDuration(3_600)).toBe("1h");
    expect(formatDuration(3 * 86_400 + 4_000)).toBe("3.0d");
  });
});

describe("describeSummary", () => {
  it("explains what to do with no trades", () => {
    const narrative = describeSummary(summarizeTrades([]));
    expect(narrative.tone).toBe("neutral");
    expect(narrative.headline).toBe("No closed trades yet");
    expect(narrative.detail).toContain("300+");
  });

  it("matches the user's wording for an unproven setup", () => {
    const summary: TradeSummary = {
      ...summarizeTrades(tradesWithPnls(alternating(200, 0.0101, 0.01))),
      expectancySol: -0.004,
      verdict: "no_edge",
      significance: "inconclusive",
      moreTradesNeeded: 417
    };
    const narrative = describeSummary(summary);
    expect(narrative.headline).toBe("No edge yet: expectancy -0.004 SOL/trade, need ~420 more trades to know");
    expect(narrative.tone).toBe("warn");
    expect(narrative.detail).toContain("tooling working");
  });

  it("calls out a small sample, a real edge and a losing setup", () => {
    const early = describeSummary(summarizeTrades(tradesWithPnls(alternating(40, 0.02, 0.01))));
    expect(early.headline).toBe("Too early: 40 of 100 trades");
    const edge = describeSummary(summarizeTrades(tradesWithPnls(alternating(120, 0.05, 0.01))));
    expect(edge.tone).toBe("good");
    expect(edge.headline).toBe("Edge: +0.020 SOL/trade after fees");
    const losing = describeSummary(summarizeTrades(tradesWithPnls(alternating(200, 0.01, 0.03))));
    expect(losing.tone).toBe("bad");
    expect(losing.headline).toBe("Losing: -0.010 SOL/trade after fees");
    expect(losing.detail).toContain("saved real money");
  });
});

describe("describeComparison", () => {
  it("covers empty, early and optimistic comparisons", () => {
    expect(describeComparison(comparePaperLive([])).headline).toBe("No paper/live pairs yet");
    const early = describeComparison(comparePaperLive([pair(0.01, 0.02, MONDAY_MS)]));
    expect(early.headline).toBe("Too early: 1 of 20 paired trades");
    const pairs = Array.from({ length: 25 }, (_, index) => pair(-0.02 + (index % 3) * 0.0001, 0, MONDAY_MS + index * 1_000));
    const optimistic = describeComparison(comparePaperLive(pairs));
    expect(optimistic.tone).toBe("bad");
    expect(optimistic.headline).toMatch(/^Paper is too optimistic: live makes 0\.0199 SOL\/trade less$/);
    expect(optimistic.detail).toContain("execution model");
  });
});

describe("calibration", () => {
  it("computes the two-proportion z statistic", () => {
    expect(twoProportionZ(60, 100, 40, 100)).toBeCloseTo(2.8284, 3);
    expect(twoProportionZ(0, 0, 1, 2)).toBeNull();
    expect(twoProportionZ(5, 5, 5, 5)).toBeNull();
  });

  it("decides whether the scorer separates outcomes", () => {
    const works = assessCalibration(counts(300, 150, 30), counts(300, 60, 120));
    expect(works.verdict).toBe("scorer_works");
    expect(works.survivalLift).toBeCloseTo(0.3, 12);
    expect(works.rugReduction).toBeCloseTo(0.3, 12);
    expect(assessCalibration(counts(300, 60, 120), counts(300, 150, 30)).verdict).toBe("scorer_inverted");
    expect(assessCalibration(counts(300, 100, 50), counts(300, 98, 50)).verdict).toBe("inconclusive");
    expect(assessCalibration(counts(100, 50, 10), counts(50, 10, 20)).verdict).toBe("insufficient_data");
    expect(assessCalibration(counts(400, 200, 10), counts(400, 100, 10, 20)).verdict).toBe("insufficient_data");
  });

  it("describes each calibration verdict", () => {
    const pass = counts(300, 150, 30);
    const block = counts(300, 60, 120);
    const works = describeCalibration(assessCalibration(pass, block), group(pass), group(block));
    expect(works.headline).toBe("Scorer works: passed launches survive 15m 50.0% vs 20.0% blocked");
    const inverted = describeCalibration(assessCalibration(block, pass), group(block), group(pass));
    expect(inverted.tone).toBe("bad");
    const none = describeCalibration(assessCalibration(counts(0, 0, 0), counts(0, 0, 0)), group(counts(0, 0, 0)), group(counts(0, 0, 0)));
    expect(none.detail).toContain("two weeks");
  });
});

describe("describeRecorder", () => {
  it("tracks progress toward two weeks and spots a stalled stream", () => {
    expect(describeRecorder({ recordingDays: null, lastTradeAgeSec: null, gapCount24h: 0, gapSeconds24h: 0 }).tone).toBe("bad");
    const stalled = describeRecorder({ recordingDays: 3, lastTradeAgeSec: 900, gapCount24h: 1, gapSeconds24h: 120 });
    expect(stalled.headline).toBe("Recorder looks stalled: last trade 15m ago");
    const early = describeRecorder({ recordingDays: 3.25, lastTradeAgeSec: 2, gapCount24h: 0, gapSeconds24h: 0 });
    expect(early.headline).toBe("Recording for 3.3 days");
    expect(early.detail).toContain("10.8 more days");
    const healthy = describeRecorder({ recordingDays: 15, lastTradeAgeSec: 2, gapCount24h: 0, gapSeconds24h: 0 });
    expect(healthy.tone).toBe("good");
  });
});
