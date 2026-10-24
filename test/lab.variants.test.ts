import { describe, expect, it } from "vitest";
import { summarizeTrades } from "../src/analytics/metrics.js";
import { parseArgv, UsageError } from "../src/app/args.js";
import { parseLabLabels, progressText } from "../src/app/commands/lab.js";
import { defaultStrategyConfig, loadStrategyConfig } from "../src/config/strategy.js";
import type { ClosedTrade } from "../src/core/types.js";
import {
  applyOverrides,
  changedSettings,
  deepMerge,
  formatLabReport,
  inertReason,
  isLabLabel,
  labRunLabel,
  labSummaryOf,
  loadLabVariants,
  parseLabVariants,
  planVariants,
  positiveCalibration,
  rankVariants,
  topFeatures,
  trainingWindow,
  variantNotes,
  type LabResult,
  type LabVariantResult
} from "../src/lab/index.js";
import type { FeatureReport } from "../src/scorer/tune.js";

const SOL = 1_000_000_000n;
const T = Date.UTC(2026, 9, 20, 12);

function trade(index: number, pnlSol: number, exitReason: string): ClosedTrade {
  const cost = SOL / 10n;
  const pnl = BigInt(Math.round(pnlSol * 1e9));
  return {
    positionId: `p${index}`,
    runId: 1,
    mode: "backtest",
    mint: `Mint${index}`,
    signalType: "score_momentum",
    riskScore: 20,
    openedAtMs: T + index * 60_000,
    closedAtMs: T + index * 60_000 + 90_000,
    holdSec: 90,
    cost,
    proceeds: cost + pnl,
    pnl,
    fees: 1_000_000n,
    exitReason,
    peakMultiple: 1.5
  };
}

function report(feature: string, weight: number, orientedAuc: number | null): FeatureReport {
  return {
    feature,
    coverage: 0.9,
    auc: orientedAuc,
    orientedAuc,
    validationAuc: orientedAuc === null ? null : orientedAuc / 2,
    direction: "higher_riskier",
    coefficient: weight,
    usedInModel: weight > 0,
    suggestedWeight: weight
  };
}

describe("lab variants", () => {
  it("deep-merges objects, replaces arrays and scalars and leaves the base untouched", () => {
    const base = { exits: { takeProfit: [{ atMultiple: 2 }, { atMultiple: 3 }], timeStop: { afterSec: 300, flatBandFraction: 0.15 } }, a: 1 };
    const merged = deepMerge(base, { exits: { takeProfit: [{ atMultiple: 1.5 }], timeStop: { afterSec: 120 } } });
    expect(merged).toEqual({ exits: { takeProfit: [{ atMultiple: 1.5 }], timeStop: { afterSec: 120, flatBandFraction: 0.15 } }, a: 1 });
    expect(base.exits.timeStop.afterSec).toBe(300);
    expect(base.exits.takeProfit).toHaveLength(2);
  });

  it("validates merged configs with the strategy schema and rejects unknown settings", () => {
    const baseline = defaultStrategyConfig();
    const merged = applyOverrides(baseline, { signals: { scoreMomentum: { maxRiskScore: 25 } } });
    expect(merged.signals.scoreMomentum.maxRiskScore).toBe(25);
    expect(merged.signals.scoreMomentum.minUniqueBuyersPerMin).toBe(baseline.signals.scoreMomentum.minUniqueBuyersPerMin);
    expect(baseline.signals.scoreMomentum.maxRiskScore).toBe(35);
    expect(changedSettings(baseline, merged)).toEqual(["signals.scoreMomentum.maxRiskScore"]);
    expect(() => applyOverrides(baseline, { signals: { scoreMomentum: { maxRiskScore: 150 } } })).toThrow(/invalid strategy config: signals.scoreMomentum.maxRiskScore/);
    expect(() => applyOverrides(baseline, { signals: { scoreMomentun: { maxRiskScore: 20 } } })).toThrow(
      "unknown strategy settings: signals.scoreMomentun"
    );
    expect(() => applyOverrides(baseline, { exits: { timeStop: "never" } })).toThrow(/invalid strategy config/);
  });

  it("flags variants that cannot change the result", () => {
    const baseline = defaultStrategyConfig();
    const momentum = applyOverrides(baseline, { signals: { scoreMomentum: { maxRiskScore: 25 } } });
    expect(inertReason(momentum, changedSettings(baseline, momentum))).toMatch(/score_momentum/);
    expect(inertReason(baseline, [])).toBe("identical to the baseline strategy");
    const enabled = applyOverrides(baseline, { signals: { enabled: ["smart_convergence", "score_momentum"] } });
    const strict = applyOverrides(enabled, { signals: { scoreMomentum: { maxRiskScore: 25 } } });
    expect(inertReason(strict, changedSettings(enabled, strict))).toBeNull();
    const exits = applyOverrides(baseline, { exits: { timeStop: { afterSec: 120 } } });
    expect(inertReason(exits, changedSettings(baseline, exits))).toBeNull();
  });

  it("skips variants that only change settings a replay never reads instead of running the baseline under their name", () => {
    const baseline = defaultStrategyConfig();
    const inert = [
      { scorer: { deepIntel: { minBuyersForDeep: 12 } } },
      { recorder: { outcome: { rugDropFraction: 0.5 } } },
      { tracker: { topN: 20, backfill: { enabled: false } } },
      { sweeper: { enabled: true } },
      { scorer: { deepIntel: { maxWalletsPerLaunch: 5 } }, signals: { scoreMomentum: { maxRiskScore: 20 } } }
    ];
    for (const overrides of inert) {
      const merged = applyOverrides(baseline, overrides);
      expect(inertReason(merged, changedSettings(baseline, merged))).toMatch(/^only changes /);
    }
    const mixed = applyOverrides(baseline, { scorer: { deepIntel: { maxWalletsPerLaunch: 5 } }, signals: { scoreMomentum: { maxRiskScore: 20 } } });
    expect(inertReason(mixed, changedSettings(baseline, mixed))).toBe(
      "only changes settings of score_momentum, which signals.enabled does not include and settings a replay does not use (scorer.deepIntel.maxWalletsPerLaunch; the recorder, wallet intel, wallet ranking and sweeper run only live)"
    );
    const effective = [
      { recorder: { memory: { evictInactiveMinutes: 20 } } },
      { tracker: { convergence: { minWallets: 2 } } },
      { scorer: { maxRisk: 40 } },
      { scorer: { deepIntel: { minBuyersForDeep: 12 } }, exits: { maxHoldSec: 900 } }
    ];
    for (const overrides of effective) {
      const merged = applyOverrides(baseline, overrides);
      expect(inertReason(merged, changedSettings(baseline, merged))).toBeNull();
    }
    const { planned } = planVariants(baseline, [{ name: "deep", description: "x", overrides: inert[0] ?? {} }], null, "service config");
    expect(planned[1]).toMatchObject({ config: null, error: expect.stringMatching(/^skipped: only changes settings a replay does not use \(scorer\.deepIntel\.minBuyersForDeep;/) });
  });

  it("parses variant files strictly", () => {
    const good = parseLabVariants([{ name: "a-1", description: "first", overrides: { exits: { maxHoldSec: 600 } } }]);
    expect(good).toEqual([{ name: "a-1", description: "first", overrides: { exits: { maxHoldSec: 600 } } }]);
    expect(() => parseLabVariants([{ name: "baseline", description: "x", overrides: {} }])).toThrow(/reserved/);
    expect(() =>
      parseLabVariants([
        { name: "dup", description: "x", overrides: {} },
        { name: "dup", description: "y", overrides: {} }
      ])
    ).toThrow(/duplicate name "dup"/);
    expect(() => parseLabVariants([{ name: "Bad Name", description: "x", overrides: {} }])).toThrow(/invalid lab variants/);
    expect(() => parseLabVariants([{ name: "x", description: " ", overrides: {} }])).toThrow(/description/);
    expect(() => parseLabVariants({ name: "x" })).toThrow(/invalid lab variants/);
  });

  it("ships about six one-idea variants that all apply to the default and the checked-in strategy", async () => {
    const variants = await loadLabVariants();
    expect(variants.map((variant) => variant.name)).toEqual([
      "momentum-strict",
      "momentum-loose",
      "momentum-low-buyers",
      "fast-exits",
      "no-time-stop",
      "trade-blocked-event-exits"
    ]);
    for (const baseline of [defaultStrategyConfig(), await loadStrategyConfig("config/strategy.json")]) {
      const momentumOn = applyOverrides(baseline, { signals: { enabled: ["smart_convergence", "score_momentum"] } });
      for (const variant of variants) {
        const merged = applyOverrides(momentumOn, variant.overrides);
        expect(changedSettings(momentumOn, merged).length).toBeGreaterThan(0);
        expect(inertReason(merged, changedSettings(momentumOn, merged))).toBeNull();
      }
    }
    const baseline = defaultStrategyConfig();
    const fast = applyOverrides(baseline, variants.find((variant) => variant.name === "fast-exits")?.overrides ?? {});
    expect(fast.exits.takeProfit[0]).toEqual({ atMultiple: 1.5, sellFractionOfInitial: 0.5 });
    expect(fast.exits.timeStop).toEqual({ afterSec: 120, flatBandFraction: baseline.exits.timeStop.flatBandFraction });
    const blocked = applyOverrides(baseline, variants.find((variant) => variant.name === "trade-blocked-event-exits")?.overrides ?? {});
    expect(blocked.scorer.hardBlocks.bundleShareAbove).toBe(1);
    expect(blocked.exits.events.devSellExit).toBe(true);
    expect(applyOverrides(baseline, variants.find((variant) => variant.name === "no-time-stop")?.overrides ?? {}).exits.timeStop.afterSec).toBeGreaterThan(
      baseline.exits.maxHoldSec
    );
  });

  it("plans the baseline first, caps the variants and records invalid or inert ones without running them", () => {
    const baseline = defaultStrategyConfig();
    const { planned, skipped } = planVariants(
      baseline,
      [
        { name: "exits", description: "x", overrides: { exits: { maxHoldSec: 600 } } },
        { name: "broken", description: "x", overrides: { exits: { maxHoldSec: -1 } } },
        { name: "momentum", description: "x", overrides: { signals: { scoreMomentum: { maxRiskScore: 20 } } } },
        { name: "late", description: "x", overrides: { exits: { maxHoldSec: 900 } } }
      ],
      3,
      "service config"
    );
    expect(planned.map((plan) => [plan.variant.name, plan.isBaseline, plan.config !== null])).toEqual([
      ["baseline", true, true],
      ["exits", false, true],
      ["broken", false, false],
      ["momentum", false, false]
    ]);
    expect(planned[0]?.variant.description).toBe("service config");
    expect(planned[1]?.changed).toEqual(["exits.maxHoldSec"]);
    expect(planned[2]?.error).toMatch(/invalid strategy config/);
    expect(planned[3]?.error).toMatch(/^skipped: /);
    expect(skipped).toEqual(["late"]);
  });

  it("labels lab strategy runs so dashboards can leave them out", () => {
    expect(labRunLabel(12, "fast-exits")).toBe("lab:12:fast-exits");
    expect(isLabLabel("lab:12:fast-exits")).toBe(true);
    expect(isLabLabel("paper-1")).toBe(false);
    expect(isLabLabel(null)).toBe(false);
  });
});

describe("lab summaries and report", () => {
  it("summarizes closed trades with the analytics metrics and groups exits", () => {
    const trades = [trade(1, 0.05, "take_profit"), trade(2, -0.03, "stop_loss"), trade(3, 0.02, "take_profit"), trade(4, -0.01, "time_stop")];
    const summary = labSummaryOf(trades);
    const reference = summarizeTrades(trades);
    expect(summary).toEqual({
      trades: 4,
      wins: 2,
      winRate: 0.5,
      expectancySol: reference.expectancySol,
      ciLowSol: reference.decisionCi95?.low ?? null,
      ciHighSol: reference.decisionCi95?.high ?? null,
      totalPnlSol: reference.totalPnlSol,
      maxDrawdownSol: reference.maxDrawdownSol,
      avgHoldSec: 90,
      verdict: "insufficient_data",
      exitReasons: [
        { reason: "take_profit", n: 2, pnlSol: 0.07 },
        { reason: "stop_loss", n: 1, pnlSol: -0.03 },
        { reason: "time_stop", n: 1, pnlSol: -0.01 }
      ]
    });
    expect(Object.keys(summary).sort()).toEqual(
      ["avgHoldSec", "ciHighSol", "ciLowSol", "exitReasons", "expectancySol", "maxDrawdownSol", "totalPnlSol", "trades", "verdict", "winRate", "wins"].sort()
    );
    expect(labSummaryOf([])).toMatchObject({ trades: 0, wins: 0, winRate: null, expectancySol: null, totalPnlSol: 0, exitReasons: [] });
  });

  it("keeps the top features by importance and reports calibration as the label's own positive rate", () => {
    const features = topFeatures([report("a", 2, 0.6), report("b", 9, 0.55), report("c", 0, 0.9), report("d", 9, 0.7)], 3);
    expect(features.map((feature) => feature.name)).toEqual(["d", "b", "a"]);
    expect(features[0]).toEqual({ name: "d", auc: 0.35, direction: "higher_riskier", coverage: 0.9, weight: 9 });
    const buckets = [
      { from: 0, to: 10, count: 4, badRate: 0.25, meanScore: 5 },
      { from: 10, to: 20, count: 0, badRate: null, meanScore: null }
    ];
    expect(positiveCalibration(buckets, "survived_15m")).toEqual([
      { bucket: "0-10", n: 4, positiveRate: 0.75 },
      { bucket: "10-20", n: 0, positiveRate: null }
    ]);
    expect(positiveCalibration(buckets, "rugged_1h")[0]).toEqual({ bucket: "0-10", n: 4, positiveRate: 0.25 });
  });

  it("trains each label on the launches that matured before now", () => {
    const now = T;
    const maturity = { labelHorizonHours: 24, surviveCheckSec: 900, rugLookaheadSec: 300 };
    expect(trainingWindow(now, "survived_15m", maturity, 12)).toEqual({ fromMs: now - 20 * 60_000 - 12 * 3_600_000, toMs: now - 20 * 60_000 });
    expect(trainingWindow(now, "rugged_1h", maturity, 12).toMs).toBe(now - 65 * 60_000);
    expect(trainingWindow(now, "migrated", maturity, 12).toMs).toBe(now - 24 * 3_600_000);
  });

  it("ranks variants by expectancy and prints a readable report", () => {
    const variant = (name: string, expectancySol: number | null, isBaseline = false, error: string | null = null): LabVariantResult => ({
      variantId: 1,
      name,
      description: name,
      isBaseline,
      strategyRunId: error ? null : 5,
      summary: error
        ? null
        : {
            trades: expectancySol === null ? 0 : 10,
            wins: 5,
            winRate: 0.5,
            expectancySol,
            ciLowSol: expectancySol === null ? null : expectancySol - 0.01,
            ciHighSol: expectancySol === null ? null : expectancySol + 0.01,
            totalPnlSol: (expectancySol ?? 0) * 10,
            maxDrawdownSol: 0.02,
            avgHoldSec: 80,
            verdict: "insufficient_data",
            exitReasons: [{ reason: "take_profit", n: 6, pnlSol: 0.1 }]
          },
      error,
      changed: [],
      runtimeMs: 1_500,
      events: 1_000,
      weightsVersion: "hand-v1",
      fingerprint: expectancySol === null ? null : `fp-${expectancySol}`,
      pass: error ? null : 1,
      replayedAlone: name === "quiet" ? "dev history changed" : null
    });
    const variants = [variant("baseline", 0.001, true), variant("fast-exits", 0.004), variant("quiet", null), variant("broken", null, false, "boom")];
    expect(rankVariants(variants).map((entry) => entry.name)).toEqual(["fast-exits", "baseline", "quiet"]);
    const notes = variantNotes([...variants, variant("copycat", 0.001)]) as Record<string, { sameTradesAsBaseline: boolean | null }>;
    expect(Object.fromEntries(Object.entries(notes).map(([name, note]) => [name, note.sameTradesAsBaseline]))).toEqual({
      baseline: null,
      "fast-exits": false,
      quiet: null,
      broken: null,
      copycat: true
    });
    const result: LabResult = {
      labRunId: 7,
      status: "done",
      error: null,
      dataFromMs: T - 6 * 3_600_000,
      dataToMs: T,
      scorer: [
        {
          label: "survived_15m",
          checkpointSec: 30,
          rows: 500,
          positives: 120,
          validationAuc: 0.71,
          baselineAuc: 0.65,
          features: [{ name: "bundle_share", auc: 0.7, direction: "higher_riskier", coverage: 1, weight: 10 }],
          calibration: [],
          weightsVersion: "lab-7-survived_15m-30"
        }
      ],
      scorerSkipped: [{ label: "migrated", checkpointSec: 30, rows: 3, positives: 0, reason: "only 3 matured rows (need 100)" }],
      variants,
      passes: [
        { variants: ["baseline", "fast-exits", "quiet"], runtimeMs: 40_000, events: 1_000, isolated: true, replayedAlone: ["quiet"] },
        { variants: ["copycat"], runtimeMs: 20_000, events: 1_000, isolated: false, replayedAlone: [] }
      ],
      skippedVariants: ["extra"],
      scorerRuntimeMs: 2_000,
      runtimeMs: 65_000,
      pruned: { kept: 20, strategyRuns: 3, positions: 9, fills: 20, signals: 4, weights: 8 }
    };
    const text = formatLabReport(result);
    expect(text).toContain("== lab run 7 (done) ==");
    expect(text).toContain("lab-7-survived_15m-30");
    expect(text).toContain("0.710  0.650");
    expect(text).toMatch(/migrated\s+30s skipped: only 3 matured rows \(need 100\)/);
    const board = text.split("\n").filter((line) => /^\s+\d+\s{2}/.test(line));
    expect(board.map((line) => line.trim().split(/\s+/)[1])).toEqual(["fast-exits", "baseline", "quiet"]);
    expect(text).toMatch(/broken\s+boom/);
    expect(text).toMatch(/extra\s+skipped: over --max-variants/);
    expect(text).toContain("weights  backtests scored with hand-v1");
    expect(text).toContain("total 1m05s");
    expect(text).toContain("pass 1 (3 variants in one replay, 1000 events, quiet replayed alone) 40.0s, pass 2 (copycat, 1000 events) 20.0s");
    expect(text).toContain("2 replay passes for 4 variants");
    expect(text).toContain("pruned   3 lab strategy runs (9 positions, 20 fills, 4 signals) and 8 inactive lab weights");
    expect(text).not.toContain("same trades as the baseline");
    const withCopy = formatLabReport({ ...result, variants: [...variants, variant("copycat", 0.001)] });
    expect(withCopy.split("\n").find((line) => line.includes("copycat"))).toMatch(/insufficient_data, same trades as the baseline$/);
  });
});

describe("lab command line", () => {
  it("parses lab options and labels", () => {
    expect(parseArgv(["lab", "--hours", "3", "--max-variants", "2", "--labels", "survived_15m,rugged_1h"])).toEqual({
      command: "lab",
      options: { hours: 3, "max-variants": 2, labels: "survived_15m,rugged_1h" }
    });
    expect(parseArgv(["lab", "--prune-keep", "20"]).options).toEqual({ "prune-keep": 20 });
    expect(parseLabLabels(undefined)).toEqual(["survived_15m", "rugged_1h", "migrated"]);
    expect(parseLabLabels(" rugged_1h , rugged_1h,migrated")).toEqual(["rugged_1h", "migrated"]);
    expect(() => parseLabLabels("rugged_2h")).toThrow(UsageError);
    expect(() => parseLabLabels(",")).toThrow(UsageError);
    expect(parseArgv(["tune-scorer", "--checkpoint", "30", "--label", "rugged_1h"]).options.label).toBe("rugged_1h");
    expect(parseArgv(["export-dataset", "--checkpoint", "30", "--label", "survived_15m", "--out", "-"]).options.label).toBe("survived_15m");
  });

  it("prints progress lines", () => {
    expect(progressText({ phase: "variant-start", labRunId: 1, name: "fast-exits", index: 1, total: 7 })).toBe("  variant 2/7 fast-exits ...");
    expect(
      progressText({
        phase: "variant-progress",
        labRunId: 1,
        name: "x",
        progress: { virtualNowMs: 0, fromMs: 0, toMs: 1, events: 0, openPositions: 0, closedTrades: 0 }
      })
    ).toBeNull();
  });
});
