import { describe, expect, it } from "vitest";
import {
  comparePaperLive,
  entryGapBps,
  exitGapBps,
  paperLiveVerdict,
  volumeWeightedPrice,
  weekStartUtc
} from "../src/analytics/compare.js";
import { createRng } from "../src/core/rng.js";
import { fill, MONDAY_MS, pair, SOL } from "./analytics.fixtures.js";

const DAY_MS = 86_400_000;

function noisyPairs(count: number, liveShift: number, seed: string): ReturnType<typeof pair>[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, (_, index) => {
    const paper = (rng() - 0.5) * 0.1;
    const noise = (index % 2 === 0 ? 1 : -1) * 0.002 * (1 + (Math.floor(index / 2) % 5) / 10);
    const live = paper + liveShift + noise;
    return pair(Number(live.toFixed(6)), Number(paper.toFixed(6)), MONDAY_MS + index * 3_600_000);
  });
}

describe("fill price gaps", () => {
  it("computes a volume weighted fee-inclusive price from successful fills of one side", () => {
    const fills = [
      fill({ tokenAmount: 1_000n, userQuote: 100n }),
      fill({ tokenAmount: 3_000n, userQuote: 360n }),
      fill({ tokenAmount: 5_000n, userQuote: 1n, success: false }),
      fill({ side: "sell", tokenAmount: 1_000n, userQuote: 5n })
    ];
    expect(volumeWeightedPrice(fills, "buy")).toBeCloseTo(460 / 4000, 12);
    expect(volumeWeightedPrice(fills, "sell")).toBeCloseTo(5 / 1000, 12);
    expect(volumeWeightedPrice([fill({ success: false })], "buy")).toBeNull();
    expect(volumeWeightedPrice([], "sell")).toBeNull();
  });

  it("reports positive gaps when live fills are worse on entry and exit", () => {
    const live = [fill({ userQuote: 101n, tokenAmount: 1_000n }), fill({ side: "sell", userQuote: 98n, tokenAmount: 1_000n })];
    const paper = [fill({ userQuote: 100n, tokenAmount: 1_000n }), fill({ side: "sell", userQuote: 100n, tokenAmount: 1_000n })];
    expect(entryGapBps(live, paper)).toBeCloseTo(100, 9);
    expect(exitGapBps(live, paper)).toBeCloseTo(200, 9);
    expect(entryGapBps(paper, live)).toBeLessThan(0);
    expect(exitGapBps(live, [])).toBeNull();
  });

  it("anchors weeks on Monday UTC", () => {
    expect(weekStartUtc(MONDAY_MS)).toBe(MONDAY_MS);
    expect(weekStartUtc(MONDAY_MS + 6 * DAY_MS + 23 * 3_600_000)).toBe(MONDAY_MS);
    expect(weekStartUtc(MONDAY_MS + 7 * DAY_MS)).toBe(MONDAY_MS + 7 * DAY_MS);
    expect(weekStartUtc(MONDAY_MS - 1)).toBe(MONDAY_MS - 7 * DAY_MS);
  });
});

describe("comparePaperLive", () => {
  it("returns an empty comparison without pairs", () => {
    const result = comparePaperLive([]);
    expect(result.n).toBe(0);
    expect(result.meanDiffSol).toBeNull();
    expect(result.diffCi95).toBeNull();
    expect(result.verdict).toBe("insufficient_data");
    expect(result.byWeek).toEqual([]);
    expect(result.pairs).toEqual([]);
  });

  it("flags paper as too optimistic when live is significantly worse", () => {
    const result = comparePaperLive(noisyPairs(40, -0.01, "optimistic"));
    expect(result.verdict).toBe("paper_too_optimistic");
    expect(result.meanDiffSol).toBeCloseTo(-0.01, 3);
    expect(result.diffCi95?.high).toBeLessThan(0);
    expect(result.paperBetterShare).toBe(1);
    expect(result.meanLiveSol ?? 0).toBeLessThan(result.meanPaperSol ?? 0);
  });

  it("calls them consistent when the difference is noise", () => {
    const result = comparePaperLive(noisyPairs(60, 0, "consistent"));
    expect(result.verdict).toBe("consistent");
    expect(result.diffCi95?.low).toBeLessThan(0);
    expect(result.diffCi95?.high).toBeGreaterThan(0);
  });

  it("flags paper as too pessimistic when live is significantly better", () => {
    expect(comparePaperLive(noisyPairs(30, 0.02, "pessimistic")).verdict).toBe("paper_too_pessimistic");
  });

  it("waits for the minimum number of pairs", () => {
    const pairs = noisyPairs(19, -0.05, "small");
    expect(comparePaperLive(pairs).verdict).toBe("insufficient_data");
    expect(comparePaperLive(pairs, { minPairs: 10 }).verdict).toBe("paper_too_optimistic");
    expect(paperLiveVerdict(25, 20, null)).toBe("insufficient_data");
  });

  it("measures fill gaps, failures, latency and exit mismatches", () => {
    const base = pair(-0.01, 0.01, MONDAY_MS + 3_600_000);
    const tweaked = {
      ...base,
      live: { ...base.live, exitReason: "stop_loss" },
      liveFills: [
        fill({ success: false, filledAtMs: null }),
        fill({ userQuote: SOL / 10n + SOL / 1000n, filledAtMs: MONDAY_MS + 2_000 }),
        fill({ side: "sell", userQuote: SOL / 10n - SOL / 500n, filledAtMs: MONDAY_MS + 1_000 })
      ],
      paperFills: [fill({ filledAtMs: MONDAY_MS + 400 }), fill({ side: "sell", filledAtMs: MONDAY_MS + 400 })]
    };
    const result = comparePaperLive([tweaked, pair(0.02, 0.02, MONDAY_MS + 7_200_000)]);
    expect(result.entryGap.n).toBe(2);
    expect(result.pairs.find((item) => item.livePositionId === tweaked.live.positionId)?.entryGapBps).toBeCloseTo(100, 6);
    expect(result.pairs.find((item) => item.livePositionId === tweaked.live.positionId)?.exitGapBps).toBeCloseTo(200, 6);
    expect(result.entryGap.meanBps).toBeCloseTo(50, 6);
    expect(result.fillFailureRate.live).toBeCloseTo(1 / 5, 12);
    expect(result.fillFailureRate.paper).toBe(0);
    expect(result.meanFillLatencyMs.paper).toBeCloseTo((400 + 400 + 800 + 800) / 4, 9);
    expect(result.meanFillLatencyMs.live).toBeCloseTo((2_000 + 1_000 + 800 + 800) / 4, 9);
    expect(result.exitReasonMismatchShare).toBeCloseTo(0.5, 12);
    expect(result.totalLiveSol).toBeCloseTo(0.01, 12);
    expect(result.totalPaperSol).toBeCloseTo(0.03, 12);
  });

  it("groups by week and lists the most recent pairs first up to the limit", () => {
    const pairs = [
      pair(0.01, 0.02, MONDAY_MS + DAY_MS),
      pair(0.03, 0.01, MONDAY_MS + 2 * DAY_MS),
      pair(-0.02, 0, MONDAY_MS + 8 * DAY_MS)
    ];
    const result = comparePaperLive(pairs, { detailLimit: 2 });
    expect(result.byWeek.map((week) => [week.weekStartMs, week.n])).toEqual([
      [MONDAY_MS, 2],
      [MONDAY_MS + 7 * DAY_MS, 1]
    ]);
    expect(result.byWeek[0]?.meanDiffSol).toBeCloseTo(0.005, 12);
    expect(result.byWeek[1]?.meanDiffSol).toBeCloseTo(-0.02, 12);
    expect(result.pairs).toHaveLength(2);
    expect(result.pairs[0]?.closedAtMs).toBeGreaterThan(result.pairs[1]?.closedAtMs ?? 0);
  });
});
