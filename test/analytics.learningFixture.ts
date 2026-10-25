import { READ_AT_MS } from "./analytics.dashboardDom.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const HOSTILE = "<img src=x onerror=alert(1)>";

export function stats(values: Partial<Record<string, number | null>> = {}): Record<string, unknown> {
  return {
    windows: 14,
    confidence: 0.975,
    variantTrades: 150,
    baselineTrades: 168,
    variantPerTrade: 0.21,
    baselinePerTrade: -0.131,
    gain: 4.2,
    gainSol: 0.2,
    gainLow: 1.1,
    gainHigh: 7.3,
    own: 2.25,
    ownLow: 0.9,
    positive: 11,
    negative: 3,
    withoutBest: 3.6,
    older: 4,
    newer: 4.4,
    ...values
  };
}

export function learningFixture(): Record<string, unknown> {
  return {
    available: true,
    error: null,
    inEffect: { autoLearn: true, promotionId: 3, name: "fast-exits", appliedAtMs: READ_AT_MS - 3 * DAY_MS, changes: ["exits.timeStop.afterSec = 120"], problem: null },
    report: {
      labRunId: 12,
      evaluatedAtMs: READ_AT_MS - 600_000,
      settings: "abcd1234",
      engine: "0123456789abcdef",
      enabled: true,
      canPromote: true,
      windowHours: 3,
      minTrades: 100,
      minWindows: 10,
      maxWindows: 40,
      confirmWindows: 24,
      comparisons: 2,
      familyConfidence: 0.95,
      discoveryConfidence: 0.975,
      nextConfirmConfidence: 0.9696,
      windows: 14,
      windowsFromMs: READ_AT_MS - 30 * HOUR_MS,
      windowsToMs: READ_AT_MS,
      baseline: { trades: 168, windows: 14, perTrade: -0.131, perWindow: -1.57, perWindowSol: -0.075, perWindowLow: -2.1, perWindowHigh: -1 },
      variants: [
        {
          name: "momentum-strict",
          description: "score_momentum only enters launches with a risk score of 25 or less.",
          verdict: "confirming",
          reasons: [],
          changes: ["signals.scoreMomentum.maxRiskScore = 25"],
          stats: stats(),
          tradeProgress: 1,
          windowProgress: 1
        },
        {
          name: HOSTILE,
          description: "",
          verdict: "collecting",
          reasons: ["needs 100 trades in both arms, has 41"],
          changes: [],
          stats: stats({ windows: 6, variantTrades: 41, gain: 0.3, gainLow: -2, gainHigh: 2.6, positive: 3, negative: 3 }),
          tradeProgress: 0.41,
          windowProgress: 0.6
        }
      ],
      paper: { status: "consistent", windows: 6, matched: 31, replayOnly: 5, paperOnly: 3, needed: 20, coverage: 0.795, bias: 0.012, biasLow: -0.01, biasHigh: 0.034, paperPerTrade: -0.12, replayPerTrade: -0.11 },
      confirmation: {
        promotionId: 4,
        name: "momentum-strict",
        index: 1,
        confidence: 0.9696,
        fromMs: READ_AT_MS - 20 * HOUR_MS,
        needed: 24,
        collected: 9,
        variantTrades: 98,
        baselineTrades: 110,
        complete: false,
        stats: null,
        reasons: []
      },
      probation: null,
      decision: { kind: "hold", name: "momentum-strict", reason: "momentum-strict is being confirmed on fresh data: 9 of 24 windows so far, tested once at the end" },
      weights: [
        { label: "rugged_1h", checkpointSec: 60, verdict: "ready", latestRunId: 12, latestGain: 0.041, latestRows: 1240, previousRunId: 8, previousGain: 0.035, reasons: [] },
        { label: "survived_15m", checkpointSec: 30, verdict: "not_better", latestRunId: 12, latestGain: 0.004, latestRows: 1100, previousRunId: null, previousGain: null, reasons: ["latest run #12 gains +0.004 AUC (needs +0.030)"] }
      ],
      weightsActive: "hand-v2",
      weightsMinGain: 0.03,
      weightsMinRows: 1000,
      promotion: { id: 4, status: "confirming", name: "momentum-strict" }
    },
    promotions: [
      {
        id: 4,
        kind: "variant",
        name: "momentum-strict",
        status: "confirming",
        note: "momentum-strict looks better on 14 past windows",
        changes: ["signals.scoreMomentum.maxRiskScore = 25"],
        createdAtMs: READ_AT_MS - 20 * HOUR_MS,
        updatedAtMs: READ_AT_MS - 20 * HOUR_MS,
        appliedAtMs: null,
        labRunId: 12,
        confirmIndex: 1,
        confirmWindows: 24,
        windows: 14,
        trades: 150,
        gain: 4.2,
        gainSol: 0.2,
        gainLow: 1.1,
        probationResult: null,
        endedRunId: null
      },
      {
        id: 3,
        kind: "variant",
        name: "fast-exits",
        status: "applied",
        note: "applied fast-exits",
        changes: ["exits.timeStop.afterSec = 120"],
        createdAtMs: READ_AT_MS - 5 * DAY_MS,
        updatedAtMs: READ_AT_MS - 3 * DAY_MS,
        appliedAtMs: READ_AT_MS - 3 * DAY_MS,
        labRunId: 2,
        confirmIndex: 1,
        confirmWindows: 24,
        windows: 24,
        trades: 300,
        gain: 1.9,
        gainSol: 0.09,
        gainLow: 0.4,
        probationResult: "kept",
        endedRunId: 2
      }
    ]
  };
}

export function labResponse(learning: Record<string, unknown>): Record<string, unknown> {
  return {
    available: true,
    runs: 12,
    latest: null,
    run: { id: 12, startedAtMs: READ_AT_MS - HOUR_MS, finishedAtMs: READ_AT_MS - 600_000, status: "done", error: null, dataFromMs: READ_AT_MS - 4 * HOUR_MS, dataToMs: READ_AT_MS - HOUR_MS, notes: {} },
    variants: [],
    scorer: [],
    history: [],
    takeaway: null,
    learning
  };
}
