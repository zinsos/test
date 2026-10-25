import { describe, expect, it } from "vitest";
import { defaultStrategyConfig } from "../src/config/strategy.js";
import { createRng, type Rng } from "../src/core/rng.js";
import { studentTQuantile } from "../src/core/stats.js";
import type { ClosedTrade } from "../src/core/types.js";
import { loosenedCeilings, overridePaths, ownerOnlySettings, strategyHash, undoOverrides, variantKey } from "../src/lab/identity.js";
import {
  bootstrapTLowerBound,
  confirmConfidenceOf,
  discoveryConfidenceOf,
  evaluateLearning,
  evaluateWeights,
  gainFailures,
  gainStats,
  pairedResults,
  parseStoredTrades,
  selectWindows,
  storedTradesOf,
  tLowerBound,
  windowsAfter,
  type EvidenceTrade,
  type EvidenceWindow,
  type LearnerInput,
  type LearnerReport,
  type LearnerState,
  type OpenCandidate,
  type PlannedArm,
  type ScorerRunEvidence,
  type VariantVerdict,
  type WindowResult
} from "../src/lab/learner.js";
import { applyOverrides, loadLabVariants } from "../src/lab/variants.js";
import {
  EMPTY_STATE,
  evidenceWindow,
  FAST,
  HOLD_MS,
  HOUR_MS,
  IDENTITY,
  jitter,
  jitterB,
  learnerInput,
  OTHER_SETTINGS,
  paperOf,
  planned,
  RULE,
  series,
  SETTINGS,
  solOf,
  spread,
  STEP_MS,
  STRICT,
  T0,
  tradesAt,
  WEIGHTS,
  windowStart
} from "./lab.evidence.js";

function verdictOf(report: LearnerReport, name: string): VariantVerdict {
  const found = report.variants.find((variant) => variant.name === name);
  if (!found) {
    throw new Error(`no verdict for ${name}`);
  }
  return found;
}

function better(count: number, baselineMean: number, variantMean: number, startIndex = 0): EvidenceWindow[] {
  return series(count, (index) => spread(12, baselineMean + jitter(index)), [{ arm: STRICT, rs: (index) => spread(12, variantMean + jitterB(index)) }], startIndex);
}

function candidateFrom(report: LearnerReport, promotionId = 41): OpenCandidate {
  const decision = report.decision;
  if (decision.kind !== "nominate") {
    throw new Error(`expected a nomination, got ${decision.kind}: ${decision.reason}`);
  }
  return {
    promotionId,
    name: decision.name,
    key: decision.key,
    overrides: decision.overrides,
    confirmFromMs: decision.confirmFromMs,
    confirmWindows: decision.confirmWindows,
    index: decision.index
  };
}

function confirming(candidate: OpenCandidate): LearnerState {
  return { ...EMPTY_STATE, confirming: candidate };
}

describe("evidence windows", () => {
  it("picks windows whose entry periods do not overlap, newest first, only with the current settings, replay code, weights and window length", () => {
    const hourly = Array.from({ length: 12 }, (_, index) => evidenceWindow(index, spread(4, 0), [], { startMs: T0 + index * HOUR_MS }));
    const foreign = [
      evidenceWindow(20, spread(4, 0), [], { startMs: T0 + 30 * HOUR_MS, settingsHash: OTHER_SETTINGS }),
      evidenceWindow(21, spread(4, 0), [], { startMs: T0 + 33 * HOUR_MS, weightsVersion: "lab-1-rugged_1h-60" }),
      evidenceWindow(22, spread(4, 0), [], { startMs: T0 + 36 * HOUR_MS, engineVersion: "older-code" }),
      evidenceWindow(23, spread(4, 0), [], { startMs: T0 + 39 * HOUR_MS, hours: 6 }),
      evidenceWindow(24, null, [], { startMs: T0 + 42 * HOUR_MS })
    ];
    const picked = selectWindows([...foreign, ...hourly], IDENTITY, RULE, HOLD_MS);
    expect(picked.map((entry) => entry.labRunId)).toEqual([2, 4, 6, 8, 10, 12]);
    expect(picked.every((entry, index) => index === 0 || (picked[index - 1]?.toMs ?? 0) - HOLD_MS <= entry.fromMs)).toBe(true);
    expect(selectWindows(hourly, IDENTITY, { ...RULE, maxWindows: 2 }, HOLD_MS).map((entry) => entry.labRunId)).toEqual([10, 12]);
    expect(selectWindows(hourly, { ...IDENTITY, settingsHash: OTHER_SETTINGS }, RULE, HOLD_MS)).toEqual([]);
    const after = windowsAfter(hourly, IDENTITY, RULE, HOLD_MS, T0 + 3 * HOUR_MS, () => true, 3);
    expect(after.map((entry) => entry.labRunId)).toEqual([4, 6, 8]);
    const jittered = Array.from({ length: 12 }, (_, index) => evidenceWindow(index, spread(4, 0), [], { startMs: T0 + index * HOUR_MS - index * 20_000 }));
    expect(selectWindows(jittered, IDENTITY, RULE, HOLD_MS).map((entry) => entry.labRunId)).toEqual([2, 4, 6, 8, 10, 12]);
  });

  it("stores each replayed trade with its coin, times and exit and reads it back defensively", () => {
    const trade = (pnl: bigint, cost: bigint, exitReason: string): ClosedTrade => ({
      pnl,
      cost,
      positionId: "p",
      runId: 1,
      mode: "backtest",
      mint: "Mint111",
      signalType: "score_momentum",
      riskScore: 10,
      openedAtMs: T0,
      closedAtMs: T0 + 60_000,
      holdSec: 60,
      proceeds: cost + pnl,
      fees: 0n,
      exitReason,
      peakMultiple: 1
    });
    const stored = storedTradesOf([trade(-13_000_000n, 100_000_000n, "stop_loss"), trade(250_000_000n, 50_000_000n, "take_profit"), trade(5n, 0n, "x")]);
    expect(stored).toEqual([
      { r: -0.13, sol: -0.013, mint: "Mint111", openedAtMs: T0, closedAtMs: T0 + 60_000, exitReason: "stop_loss" },
      { r: 5, sol: 0.25, mint: "Mint111", openedAtMs: T0, closedAtMs: T0 + 60_000, exitReason: "take_profit" }
    ]);
    expect(parseStoredTrades(JSON.parse(JSON.stringify(stored)))).toEqual([
      { r: -0.13, sol: -0.013, mint: "Mint111", openedAtMs: T0 },
      { r: 5, sol: 0.25, mint: "Mint111", openedAtMs: T0 }
    ]);
    expect(parseStoredTrades([[1, 0.1], "junk", { r: Number.NaN, sol: 1, openedAtMs: 1 }, { r: 0.5, sol: 0.01 }, { r: 0.5, sol: 0.01, openedAtMs: 9, mint: "" }])).toEqual([
      { r: 0.5, sol: 0.01, openedAtMs: 9, mint: null }
    ]);
    expect(parseStoredTrades(null)).toBeNull();
  });

  it("does not count a position the window end cut off: trades opened in the last max hold of a window are left out of both arms", () => {
    const fromMs = windowStart(0);
    const window = evidenceWindow(0, null, []);
    const cutOff = { r: 4, sol: solOf(4), mint: "late", openedAtMs: fromMs + 2 * HOUR_MS + 30 * 60_000 };
    const kept = { r: -0.2, sol: solOf(-0.2), mint: "early", openedAtMs: fromMs + 30 * 60_000 };
    window.arms = [
      { name: "baseline", key: variantKey("baseline", {}), isBaseline: true, promotable: false, trades: [kept] },
      { name: STRICT.name, key: STRICT.key, isBaseline: false, promotable: true, trades: [kept, cutOff] }
    ];
    const [result] = pairedResults([window], STRICT.key, HOLD_MS);
    expect(result).toMatchObject({ variantTrades: 1, baselineTrades: 1, variant: -0.2, baseline: -0.2, gain: 0 });
    const [longer] = pairedResults([window], STRICT.key, 2.25 * HOUR_MS);
    expect(longer).toMatchObject({ variantTrades: 1, baselineTrades: 1 });
    const [shorter] = pairedResults([window], STRICT.key, 0.25 * HOUR_MS);
    expect(shorter).toMatchObject({ variantTrades: 2, gain: 4 });
  });
});

describe("statistics over windows", () => {
  it("computes Student t quantiles", () => {
    expect(studentTQuantile(0.975, 10)).toBeCloseTo(2.2281, 4);
    expect(studentTQuantile(0.995, 5)).toBeCloseTo(4.0321, 4);
    expect(studentTQuantile(0.975, 1)).toBeCloseTo(12.7062, 3);
    expect(studentTQuantile(0.9995, 3)).toBeCloseTo(12.924, 3);
    expect(studentTQuantile(0.025, 10)).toBeCloseTo(-2.2281, 4);
    expect(studentTQuantile(0.5, 7)).toBe(0);
    expect(Number.isNaN(studentTQuantile(1, 7))).toBe(true);
  });

  it("uses the more cautious of the t and bootstrap-t bounds, which keeps a strategy that trims rare runners from passing too often", () => {
    const gaussian = (rng: Rng): number => Math.sqrt(-2 * Math.log(Math.max(1e-12, rng()))) * Math.cos(2 * Math.PI * rng());
    const pump = (rng: Rng): number => (rng() < 0.06 ? 2 + 3 * rng() : Math.max(-1, -0.065 + 0.25 * gaussian(rng)));
    const confidence = confirmConfidenceOf(0.95, 1);
    const rng = createRng("left-skewed-null");
    const sims = 1500;
    let tOnly = 0;
    let combined = 0;
    for (let sim = 0; sim < sims; sim += 1) {
      const results: WindowResult[] = [];
      for (let w = 0; w < 16; w += 1) {
        let base = 0;
        let variant = 0;
        for (let k = 0; k < 8; k += 1) {
          const r = pump(rng);
          base += r;
          variant += r > 1.5 ? 0.5 : r + 0.1915;
        }
        results.push({ labRunId: w, fromMs: w, toMs: w + 1, variantTrades: 8, baselineTrades: 8, variant, baseline: base, variantSol: 0, baselineSol: 0, gain: variant - base, gainSol: 0 });
      }
      const gains = results.map((result) => result.gain);
      if ((tLowerBound(gains, confidence) ?? 0) > 0) {
        tOnly += 1;
      }
      const stats = gainStats(results, confidence, { ...RULE, bootstrapIterations: 800 }, [sim]);
      if ((stats.gainLow ?? 0) > 0) {
        combined += 1;
      }
    }
    expect(tOnly / sims).toBeGreaterThan(1 - confidence);
    expect(combined / sims).toBeLessThan(1 - confidence);
    expect(bootstrapTLowerBound([1, 1, 1], 0.95, createRng("x"), 100)).toBe(1);
    expect(bootstrapTLowerBound([1], 0.95, createRng("x"), 100)).toBeNull();
  });

  it("lists every check a gain fails", () => {
    const results: WindowResult[] = [3, -1, -1, -1].map((gain, index) => ({
      labRunId: index,
      fromMs: index,
      toMs: index + 1,
      variantTrades: 10,
      baselineTrades: 10,
      variant: gain - 1,
      baseline: -1,
      variantSol: 0,
      baselineSol: 0,
      gain,
      gainSol: 0
    }));
    const reasons = gainFailures(gainStats(results, 0.95, RULE, ["t"]), 0);
    expect(reasons).toHaveLength(5);
    expect(reasons[0]).toMatch(/^with 95% confidence the gain is not above zero/);
    expect(reasons[1]).toMatch(/^it does not clearly make money on its own/);
    expect(reasons[2]).toBe("better in 1 of 4 windows and worse in 3, so not in most of them");
    expect(reasons[3]).toBe("without its single best window the gain is -1.00 bets per window");
    expect(reasons[4]).toMatch(/^the gain is not steady over time/);
  });
});

describe("discovery: who gets nominated", () => {
  it("keeps collecting below the trade and window thresholds and reports the progress", () => {
    const report = evaluateLearning(learnerInput({ windows: better(4, -0.05, 0.4) }));
    const strict = verdictOf(report, STRICT.name);
    expect(strict.verdict).toBe("collecting");
    expect(strict.progress).toEqual({ trades: 0.48, windows: 0.4 });
    expect(strict.reasons).toEqual(["needs 100 trades in both arms, has 48", "needs 10 non-overlapping windows, has 4"]);
    expect(report.decision).toMatchObject({ kind: "hold", name: null });
    expect(report.decision.reason).toContain("1 still collecting");
    expect(report.windows).toHaveLength(4);
    expect(report.baseline.trades).toBe(48);
  });

  it("never switches settings on the first look: a clearly better variant is only nominated for a test on fresh windows", () => {
    const windows = better(12, 0.05, 0.4);
    const report = evaluateLearning(learnerInput({ windows }));
    const strict = verdictOf(report, STRICT.name);
    expect(strict.verdict).toBe("candidate");
    expect(strict.reasons).toEqual([]);
    expect(strict.stats).toMatchObject({ windows: 12, variantTrades: 144, baselineTrades: 144 });
    expect(strict.stats?.gain).toBeCloseTo(12 * 0.35 + (12 * windows.reduce((acc, _, index) => acc + jitterB(index) - jitter(index), 0)) / 12, 6);
    expect(report.rule).toMatchObject({ comparisons: 1, discoveryConfidence: 0.95 });
    expect(report.decision).toMatchObject({ kind: "nominate", name: STRICT.name, key: STRICT.key, overrides: STRICT.overrides, index: 1, confirmWindows: 24 });
    expect(report.decision.kind === "nominate" ? report.decision.confirmFromMs : 0).toBe(Math.max(...windows.map((window) => window.toMs)));
    expect(report.decision.kind === "nominate" ? report.decision.confidence : 0).toBeCloseTo(confirmConfidenceOf(0.95, 1), 12);
    expect(report.paper.status).toBe("consistent");
  });

  it("says not better when the gain is not clearly above zero, and worse when it is clearly below", () => {
    const loose = planned("momentum-low-buyers", { signals: { scoreMomentum: { minUniqueBuyersPerMin: 8 } } });
    const windows = series(12, (index) => spread(12, 0.05 + jitter(index)), [
      { arm: STRICT, rs: (index) => spread(12, 0.05 + jitterB(index)) },
      { arm: loose, rs: (index) => spread(12, -0.3 + jitterB(index)) }
    ]);
    const report = evaluateLearning(learnerInput({ variants: [STRICT, loose], windows }));
    const strict = verdictOf(report, STRICT.name);
    expect(strict.verdict).toBe("not_better");
    expect(strict.reasons[0]).toMatch(/^with 97\.5% confidence the gain is not above zero/);
    expect(verdictOf(report, loose.name).verdict).toBe("worse");
    expect(report.decision.kind).toBe("hold");
  });

  it("does not promote a stricter filter that earns more per trade but less per window", () => {
    const windows = series(24, (index) => spread(20, 0.04 + jitter(index), 0.2), [{ arm: STRICT, rs: (index) => spread(6, 0.12 + jitterB(index), 0.2) }]);
    const report = evaluateLearning(learnerInput({ windows }));
    const strict = verdictOf(report, STRICT.name);
    expect(strict.stats?.variantPerTrade ?? 0).toBeGreaterThan(strict.stats?.baselinePerTrade ?? 0);
    expect(strict.stats?.gain ?? 0).toBeLessThan(0);
    expect(strict.verdict).not.toBe("candidate");
    expect(report.decision.kind).toBe("hold");
  });

  it("does not nominate a gain that comes from a single hot three-hour window", () => {
    const offsets = [-0.03, 0.04, -0.02, 0.03, 0, -0.04, 0.02, null, -0.01, 0.01, 0.015, -0.015];
    const windows = offsets.map((offset, index) =>
      evidenceWindow(index, spread(12, 0.05 + jitter(index), 0.5), [{ arm: STRICT, rs: offset === null ? spread(40, 0.8, 0.05) : spread(12, 0.05 + jitter(index) + offset, 0.5) }])
    );
    const report = evaluateLearning(learnerInput({ windows }));
    const strict = verdictOf(report, STRICT.name);
    const rest = evaluateLearning(learnerInput({ windows: windows.filter((_, index) => offsets[index] !== null) }));
    expect(Math.abs((verdictOf(rest, STRICT.name).stats?.gain ?? 1) / 12)).toBeLessThan(0.01);
    expect(strict.verdict).not.toBe("candidate");
    expect(report.decision.kind).toBe("hold");
  });

  it("does not let a +0.2% older half count as a steady gain", () => {
    const windows = series(12, (index) => spread(16, 0.02 + jitter(index) / 4, 0.4), [{ arm: STRICT, rs: (index) => spread(16, (index < 6 ? 0.022 : 0.25) + jitter(index) / 4, 0.4) }]);
    const report = evaluateLearning(learnerInput({ windows }));
    const strict = verdictOf(report, STRICT.name);
    expect((strict.stats?.halves.older ?? 1) / 16).toBeLessThan(0.005);
    expect(strict.verdict).not.toBe("candidate");
    expect(strict.reasons.some((reason) => reason.startsWith("the gain is not steady over time"))).toBe(true);
  });

  it("sizes the multiple-comparison correction by every promotable variant with evidence, not by the variants one lab run planned", () => {
    const others = [1, 2, 3, 4, 5].map((index) => planned(`exits-${index}`, { exits: { maxHoldSec: 600 * index + 1800 } }));
    const target = 0.1 + 0.021;
    const windows = series(12, (index) => spread(12, 0.1 + jitter(index)), [
      { arm: STRICT, rs: (index) => spread(12, target + jitterB(index)) },
      ...others.map((arm) => ({ arm, rs: (index: number) => spread(12, 0.1 + jitterB(index)) }))
    ]);
    const full = evaluateLearning(learnerInput({ variants: [STRICT, ...others], windows }));
    const subset = evaluateLearning(learnerInput({ variants: [STRICT], windows }));
    expect(full.rule.comparisons).toBe(6);
    expect(subset.rule.comparisons).toBe(6);
    expect(full.rule.discoveryConfidence).toBeCloseTo(discoveryConfidenceOf(0.95, 6), 12);
    expect(verdictOf(full, STRICT.name).verdict).toBe("not_better");
    expect(verdictOf(subset, STRICT.name).verdict).toBe(verdictOf(full, STRICT.name).verdict);
    expect(full.decision.kind).toBe("hold");
    expect(subset.decision.kind).toBe("hold");
    const alone = evaluateLearning(learnerInput({ variants: [STRICT], windows: series(12, (index) => spread(12, 0.1 + jitter(index)), [{ arm: STRICT, rs: (index) => spread(12, target + jitterB(index)) }]) }));
    expect(alone.rule.comparisons).toBe(1);
    expect(verdictOf(alone, STRICT.name).verdict).toBe("candidate");
    const ownerOnly = series(12, (index) => spread(12, 0.1 + jitter(index)), [
      { arm: STRICT, rs: (index) => spread(12, target + jitterB(index)) },
      ...others.map((arm) => ({ arm, rs: (index: number) => spread(12, 0.1 + jitterB(index)), promotable: false }))
    ]);
    expect(evaluateLearning(learnerInput({ windows: ownerOnly })).rule.comparisons).toBe(1);
  });

  it("forgets evidence from other settings, replay code or scorer weights and counts a variant only under its exact overrides", () => {
    const windows = better(12, 0.05, 0.4);
    for (const identity of [
      { ...IDENTITY, settingsHash: OTHER_SETTINGS },
      { ...IDENTITY, engineVersion: "newer-code" },
      { ...IDENTITY, weightsVersion: "lab-3-rugged_1h-60" }
    ]) {
      const report = evaluateLearning(learnerInput({ identity, windows }));
      expect(report.windows).toEqual([]);
      expect(verdictOf(report, STRICT.name).verdict).toBe("not_run");
      expect(report.decision.kind).toBe("hold");
    }
    const edited = planned(STRICT.name, { signals: { scoreMomentum: { maxRiskScore: 20 } } });
    expect(verdictOf(evaluateLearning(learnerInput({ variants: [edited], windows })), STRICT.name).verdict).toBe("not_run");
  });

  it("never nominates owner-only settings or a change that was already tried with these settings", () => {
    const sizing = planned("bigger-bets", { risk: { fractionPerTrade: 0.2 } }, { ownerOnly: ["risk.fractionPerTrade"] });
    const windows = series(12, (index) => spread(12, 0.05 + jitter(index)), [{ arm: sizing, rs: (index) => spread(12, 0.4 + jitterB(index)) }]);
    const report = evaluateLearning(learnerInput({ variants: [sizing], windows }));
    const verdict = verdictOf(report, "bigger-bets");
    expect(verdict.verdict).toBe("owner_only");
    expect(verdict.reasons[0]).toBe("changes settings only the owner changes (risk.fractionPerTrade); its replays would meet the discovery rule");
    expect(report.decision.kind).toBe("hold");
    const tried = evaluateLearning(learnerInput({ windows: better(12, 0.05, 0.4), state: { ...EMPTY_STATE, tried: new Set([STRICT.key]) } }));
    expect(verdictOf(tried, STRICT.name).verdict).toBe("tried");
    expect(tried.rule.comparisons).toBe(1);
    expect(tried.decision.kind).toBe("hold");
  });

  it("only nominates from the scheduled lab run", () => {
    const report = evaluateLearning(learnerInput({ windows: better(12, 0.05, 0.4), canPromote: false }));
    expect(verdictOf(report, STRICT.name).verdict).toBe("candidate");
    expect(report.decision).toMatchObject({ kind: "hold", name: STRICT.name });
    expect(report.decision.reason).toContain("report-only");
  });

  it("is deterministic for the same evidence", () => {
    const windows = better(12, 0.05, 0.12);
    expect(evaluateLearning(learnerInput({ windows }))).toEqual(evaluateLearning(learnerInput({ windows })));
  });
});

describe("paper trades as evidence", () => {
  const windows = better(12, 0.05, 0.4);

  it("pairs paper fills with the replay by coin and holds when the replay is ten points per trade more optimistic", () => {
    const report = evaluateLearning(learnerInput({ windows, paper: paperOf(windows, { shift: 0.1 }) }));
    expect(report.paper).toMatchObject({ status: "replay_optimistic", matched: 144, replayOnly: 0, paperOnly: 0, coverage: 1, windows: 12 });
    expect(report.paper.bias).toBeCloseTo(0.1, 9);
    expect(report.decision).toMatchObject({ kind: "hold", name: STRICT.name });
    expect(report.decision.reason).toContain("more than the paper fills of the same coins");
  });

  it("holds when the replay took far more trades than the paper trader in the same hours", () => {
    const few = evaluateLearning(learnerInput({ windows, paper: paperOf(windows, { perWindow: 1 }) }));
    expect(few.paper).toMatchObject({ status: "too_few", matched: 12, replayOnly: 132 });
    expect(few.decision.kind).toBe("hold");
    const unmatched = evaluateLearning(learnerInput({ windows, paper: paperOf(windows, { perWindow: 6 }) }));
    expect(unmatched.paper).toMatchObject({ status: "unmatched", matched: 72, replayOnly: 72 });
    expect(unmatched.paper.coverage).toBeCloseTo(0.5, 9);
    expect(unmatched.decision.kind).toBe("hold");
  });

  it("fails closed without a paper run, with a paper run on other settings and before the paper run started", () => {
    expect(evaluateLearning(learnerInput({ windows, paper: null })).decision.kind).toBe("hold");
    const other = evaluateLearning(learnerInput({ windows, paper: paperOf(windows, { configMatches: false }) }));
    expect(other.paper.status).toBe("other_settings");
    expect(other.decision.kind).toBe("hold");
    const late = evaluateLearning(learnerInput({ windows, paper: paperOf(windows, { startedAtMs: windows[11]?.fromMs ?? 0 }) }));
    expect(late.paper).toMatchObject({ status: "too_few", windows: 1, matched: 12 });
  });

  it("subtracts the replay's possible optimism from the variant's own profit", () => {
    const tight = series(12, (index) => spread(12, -0.2 + jitter(index)), [{ arm: STRICT, rs: (index) => spread(12, 0.02 + jitterB(index), 0.05) }]);
    const exact = evaluateLearning(learnerInput({ windows: tight }));
    expect(exact.paper.marginPerTrade).toBe(0);
    expect(verdictOf(exact, STRICT.name).verdict).toBe("candidate");
    const noisy = paperOf(tight);
    noisy.trades = noisy.trades.map((trade, index) => ({ ...trade, r: trade.r + (index % 2 === 0 ? 0.2 : -0.2) }));
    const margin = evaluateLearning(learnerInput({ windows: tight, paper: noisy }));
    expect(margin.paper.status).toBe("consistent");
    expect(margin.paper.marginPerTrade).toBeGreaterThan(0);
    const strict = verdictOf(margin, STRICT.name);
    expect(strict.verdict).toBe("not_better");
    expect(strict.reasons.some((reason) => reason.includes("to cover the replay's optimism"))).toBe(true);
  });
});

describe("confirmation on fresh windows", () => {
  const discovery = better(12, 0.05, 0.4);
  const nominated = evaluateLearning(learnerInput({ windows: discovery }));
  const candidate = candidateFrom(nominated);
  const freshStart = Math.ceil((candidate.confirmFromMs - windowStart(0)) / STEP_MS);

  it("waits for the fixed number of fresh windows and ignores everything from before the nomination", () => {
    const fresh = better(23, 0.05, 0.4, freshStart);
    const report = evaluateLearning(learnerInput({ windows: [...discovery, ...fresh], state: confirming(candidate) }));
    expect(report.confirmation).toMatchObject({ promotionId: 41, collected: 23, needed: 24, complete: false, stats: null });
    expect(report.confirmation?.fromMs).toBe(candidate.confirmFromMs);
    expect(report.decision).toMatchObject({ kind: "hold", name: STRICT.name });
    expect(report.decision.reason).toBe("momentum-strict is being confirmed on fresh data: 23 of 24 windows so far, tested once at the end");
    expect(verdictOf(report, STRICT.name).verdict).toBe("confirming");
  });

  it("confirms a variant that keeps its gain on the fresh windows, tested once at the level for the first nominee", () => {
    const fresh = better(30, 0.05, 0.4, freshStart);
    const report = evaluateLearning(learnerInput({ windows: [...discovery, ...fresh], state: confirming(candidate) }));
    expect(report.confirmation).toMatchObject({ collected: 24, needed: 24, complete: true, reasons: [] });
    expect(report.confirmation?.stats?.windows).toBe(24);
    expect(report.confirmation?.confidence).toBeCloseTo(0.9696, 4);
    expect(report.decision).toMatchObject({ kind: "confirm", promotionId: 41, name: STRICT.name });
  });

  it("rejects a nominee whose edge does not show up again on fresh data, as with a handful of lucky runners", () => {
    const lucky = series(12, (index) => spread(14, 0.05 + jitter(index), 0.3), [
      { arm: STRICT, rs: (index) => [...spread(14, 0.05 + jitter(index), 0.3), ...(index % 2 === 0 ? [4] : [])], sameCoins: true }
    ]);
    const first = evaluateLearning(learnerInput({ windows: lucky }));
    const luckyCandidate = candidateFrom(first);
    const start = Math.ceil((luckyCandidate.confirmFromMs - windowStart(0)) / STEP_MS);
    const fresh = series(luckyCandidate.confirmWindows, (index) => spread(14, 0.05 + jitter(index), 0.3), [{ arm: STRICT, rs: (index) => spread(14, 0.05 + jitter(index), 0.3), sameCoins: true }], start);
    const report = evaluateLearning(learnerInput({ windows: [...lucky, ...fresh], state: confirming(luckyCandidate) }));
    expect(report.decision).toMatchObject({ kind: "reject", promotionId: 41 });
    expect(report.decision.reason).toMatch(/^momentum-strict did not confirm on fresh data: with 96\.96% confidence the gain is not above zero/);
  });

  it("gets stricter with every nominee for the same settings and withdraws one that left the variant list", () => {
    expect(confirmConfidenceOf(0.95, 2)).toBeCloseTo(1 - (0.05 * 6) / (Math.PI * Math.PI * 4), 12);
    const secondNominee = evaluateLearning(learnerInput({ windows: discovery, state: { ...EMPTY_STATE, nominations: 1 } }));
    expect(secondNominee.decision).toMatchObject({ kind: "nominate", index: 2 });
    const gone = evaluateLearning(learnerInput({ windows: discovery, variants: [FAST], state: confirming(candidate) }));
    expect(gone.decision).toMatchObject({ kind: "withdraw", promotionId: 41 });
    expect(evaluateLearning(learnerInput({ windows: discovery, variants: [FAST], canPromote: false, state: confirming(candidate) })).decision.kind).toBe("hold");
  });

  it("waits while a confirmed promotion is pending", () => {
    const report = evaluateLearning(learnerInput({ windows: discovery, state: { ...EMPTY_STATE, pending: { promotionId: 41, kind: "variant", name: STRICT.name } } }));
    expect(report.decision).toMatchObject({ kind: "hold", name: STRICT.name });
    expect(report.decision.reason).toBe("promotion #41 (momentum-strict) waits for the paper trader to apply it");
    expect(verdictOf(report, STRICT.name).verdict).toBe("pending");
  });
});

describe("probation after a switch", () => {
  const undo = planned("undo-41", { signals: { scoreMomentum: { maxRiskScore: 35 } } });
  const probation = { promotionId: 41, name: STRICT.name, undoName: undo.name, undoKey: undo.key, fromMs: windowStart(0), windows: 24 };

  function after(oldMean: number, count: number): LearnerReport {
    const windows = series(count, (index) => spread(12, 0.1 + jitter(index)), [{ arm: undo, rs: (index) => spread(12, oldMean + jitterB(index)) }]);
    return evaluateLearning(learnerInput({ windows, variants: [STRICT, undo], state: { ...EMPTY_STATE, probation } }));
  }

  it("keeps replaying the old settings and undoes the change when they do as well on fresh windows", () => {
    const running = after(0.15, 10);
    expect(running.probation).toMatchObject({ collected: 10, needed: 24, complete: false, result: null });
    expect(running.decision).toMatchObject({ kind: "hold", name: STRICT.name });
    expect(running.variants.map((variant) => variant.name)).toEqual([STRICT.name]);
    const undone = after(0.15, 24);
    expect(undone.probation).toMatchObject({ complete: true, result: "revert" });
    expect(undone.decision).toMatchObject({ kind: "revert", promotionId: 41, name: "undo-41" });
    const kept = after(0.0, 24);
    expect(kept.decision).toMatchObject({ kind: "keep", promotionId: 41 });
    expect(kept.decision.reason).toContain("kept beating the old settings on 24 fresh windows");
  });
});

describe("hourly looks at a sliding window", () => {
  it("keeps the chance of switching to a variant that is exactly as good as the baseline at or below 1 - familyConfidence, although it keeps nominating", () => {
    const SIMULATIONS = 16;
    const HOURS = 24 * 10;
    const rule = { ...RULE, bootstrapIterations: 600 };
    const variant = planned("momentum-loose", { signals: { scoreMomentum: { minUniqueBuyersPerMin: 8 } } });
    const gaussian = (rng: Rng): number => Math.sqrt(-2 * Math.log(Math.max(1e-12, rng()))) * Math.cos(2 * Math.PI * rng());
    const pump = (rng: Rng): number => (rng() < 0.06 ? 2 + 3 * rng() : Math.max(-1, -0.065 + 0.25 * gaussian(rng)));
    let promoted = 0;
    let nominations = 0;
    for (let sim = 0; sim < SIMULATIONS; sim += 1) {
      const rng = createRng(`null-${sim}`);
      const base: EvidenceTrade[] = [];
      const other: EvidenceTrade[] = [];
      const windows: EvidenceWindow[] = [];
      let state: LearnerState = EMPTY_STATE;
      let tried = new Set<string>();
      for (let hour = 0; hour < HOURS && promoted <= SIMULATIONS; hour += 1) {
        for (let k = 0; k < 4; k += 1) {
          const at = hour * HOUR_MS + Math.floor(rng() * HOUR_MS);
          const rb = pump(rng);
          const rv = pump(rng);
          base.push({ r: rb, sol: solOf(rb), mint: `b-${hour}-${k}`, openedAtMs: at });
          other.push({ r: rv, sol: solOf(rv), mint: `v-${hour}-${k}`, openedAtMs: at });
        }
        if (hour < 2) {
          continue;
        }
        const fromMs = (hour - 2) * HOUR_MS;
        const toMs = (hour + 1) * HOUR_MS;
        const inside = (trade: EvidenceTrade): boolean => trade.openedAtMs >= fromMs && trade.openedAtMs < toMs;
        windows.push({
          labRunId: hour,
          fromMs,
          toMs,
          settingsHash: SETTINGS,
          engineVersion: IDENTITY.engineVersion,
          weightsVersion: WEIGHTS,
          arms: [
            { name: "baseline", key: variantKey("baseline", {}), isBaseline: true, promotable: false, trades: base.filter(inside) },
            { name: variant.name, key: variant.key, isBaseline: false, promotable: true, trades: other.filter(inside) }
          ]
        });
        const input: LearnerInput = learnerInput({
          nowMs: toMs,
          labRunId: hour,
          rule,
          variants: [variant],
          windows: windows.slice(-120),
          paper: { runId: 1, startedAtMs: 0, configMatches: true, trades: base.filter((trade) => trade.openedAtMs < toMs) },
          state: { ...state, tried }
        });
        const decision = evaluateLearning(input).decision;
        if (decision.kind === "nominate") {
          nominations += 1;
          state = {
            ...state,
            nominations: state.nominations + 1,
            confirming: { promotionId: hour, name: decision.name, key: decision.key, overrides: decision.overrides, confirmFromMs: decision.confirmFromMs, confirmWindows: decision.confirmWindows, index: decision.index }
          };
        } else if (decision.kind === "confirm") {
          promoted += 1;
          break;
        } else if (decision.kind === "reject" || decision.kind === "withdraw") {
          tried = new Set([...tried, state.confirming?.key ?? ""]);
          state = { ...state, confirming: null };
        }
      }
    }
    expect(nominations).toBeGreaterThan(0);
    expect(promoted / SIMULATIONS).toBeLessThanOrEqual(1 - RULE.familyConfidence);
  }, 120_000);
});

describe("scorer weights rule", () => {
  const RULE_W = { minAucGain: 0.03, minValidationRows: 1000 };

  function run(labRunId: number, startHour: number, gain: number, rows = 1500, base: string | null = WEIGHTS): ScorerRunEvidence {
    const startedAtMs = T0 + startHour * HOUR_MS;
    return {
      labRunId,
      startedAtMs,
      weightsBase: base,
      entries: [
        {
          label: "rugged_1h",
          checkpointSec: 60,
          validationAuc: 0.55 + gain,
          baselineAuc: 0.55,
          validationRows: rows,
          validationFromMs: startedAtMs - 5 * HOUR_MS,
          validationToMs: startedAtMs - HOUR_MS,
          weightsVersion: `lab-${labRunId}-rugged_1h-60`
        }
      ]
    };
  }

  it("is ready only after two runs with non-overlapping validation windows both beat the active weights", () => {
    const report = evaluateWeights([run(3, 2, 0.05), run(5, 6, 0.04), run(4, 3, 0.01)], WEIGHTS, RULE_W);
    expect(report.mode).toBe("report_only");
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]).toMatchObject({ label: "rugged_1h", checkpointSec: 60, verdict: "ready", latest: { labRunId: 5, passes: true }, previous: { labRunId: 3, passes: true } });
    expect(report.best?.latest.weightsVersion).toBe("lab-5-rugged_1h-60");
  });

  it("keeps collecting when the earlier run overlaps, fails or compared other weights, and says not better on a small gain", () => {
    const overlapping = evaluateWeights([run(4, 3, 0.05), run(5, 6, 0.04)], WEIGHTS, RULE_W);
    expect(overlapping.candidates[0]?.verdict).toBe("collecting");
    expect(overlapping.candidates[0]?.reasons).toContain("waiting for an earlier lab run with a non-overlapping validation window");
    const failed = evaluateWeights([run(3, 2, 0.01), run(5, 6, 0.04)], WEIGHTS, RULE_W);
    expect(failed.candidates[0]).toMatchObject({ verdict: "collecting", previous: { labRunId: 3, passes: false } });
    const fewRows = evaluateWeights([run(3, 2, 0.05), run(5, 6, 0.05, 600)], WEIGHTS, RULE_W);
    expect(fewRows.candidates[0]?.verdict).toBe("collecting");
    expect(fewRows.candidates[0]?.reasons[0]).toContain("600 validation rows");
    const otherBase = evaluateWeights([run(3, 2, 0.05), run(5, 6, 0.05)], "lab-1-rugged_1h-60", RULE_W);
    expect(otherBase.candidates[0]?.verdict).toBe("collecting");
    const small = evaluateWeights([run(3, 2, 0.05), run(5, 6, 0.02)], WEIGHTS, RULE_W);
    expect(small.candidates[0]?.verdict).toBe("not_better");
    expect(small.best).toBeNull();
    expect(evaluateWeights([], WEIGHTS, RULE_W)).toMatchObject({ candidates: [], best: null });
  });
});

describe("strategy identity and what may change", () => {
  it("hashes the strategy without the lab section and changes with any other setting", () => {
    const config = defaultStrategyConfig();
    const hash = strategyHash(config);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const lab = structuredClone(config);
    lab.lab.autoLearn.enabled = true;
    lab.lab.autoLearn.minTrades = 400;
    expect(strategyHash(lab)).toBe(hash);
    const bankroll = structuredClone(config);
    bankroll.risk.startingBankrollSol = 0.482;
    expect(strategyHash(bankroll)).not.toBe(hash);
    expect(variantKey("fast-exits", { exits: { maxHoldSec: 60 } })).not.toBe(variantKey("fast-exits", { exits: { maxHoldSec: 61 } }));
    expect(variantKey("a", { x: 1, y: 2 })).toBe(variantKey("a", { y: 2, x: 1 }));
  });

  it("keeps risk limits, sizing, the fill model, lab settings, hard blocks and looser risk-score limits owner-only", async () => {
    const base = defaultStrategyConfig();
    base.signals.scoreMomentum.maxRiskScore = 35;
    expect(
      ownerOnlySettings({ execution: { failureRate: 0 }, lab: { autoLearn: { enabled: true } }, signals: { quoteMints: ["USDC"], scoreMomentum: { minMcapSol: 20 } } }, base)
    ).toEqual(["execution.failureRate", "lab.autoLearn.enabled", "signals.quoteMints"]);
    expect(ownerOnlySettings({ scorer: { hardBlocks: { devShareAbove: 1 } } }, base)).toEqual(["scorer.hardBlocks.devShareAbove"]);
    expect(ownerOnlySettings({ signals: { scoreMomentum: { maxRiskScore: 50 } } }, base)).toEqual(["signals.scoreMomentum.maxRiskScore"]);
    expect(ownerOnlySettings({ signals: { scoreMomentum: { maxRiskScore: 25 } }, exits: { timeStop: { afterSec: 120 } } }, base)).toEqual([]);
    expect(loosenedCeilings({ scorer: { maxRisk: 70 }, tracker: { convergence: { maxRiskScore: 10 } } }, base)).toEqual(["scorer.maxRisk"]);
    expect(overridePaths({ exits: { takeProfit: [{ atMultiple: 2 }], timeStop: { afterSec: 60 } } })).toEqual(["exits.takeProfit", "exits.timeStop.afterSec"]);
    const variants = await loadLabVariants();
    const byName = (name: string): Record<string, unknown> => variants.find((variant) => variant.name === name)?.overrides ?? {};
    expect(ownerOnlySettings(byName("trade-blocked-event-exits"), base)).toEqual(
      expect.arrayContaining(["scorer.hardBlocks.devShareAbove", "signals.scoreMomentum.maxRiskScore", "tracker.convergence.maxRiskScore"])
    );
    expect(ownerOnlySettings(byName("momentum-loose"), base)).toEqual(["signals.scoreMomentum.maxRiskScore"]);
    expect(ownerOnlySettings(byName("momentum-strict"), base)).toEqual([]);
    expect(ownerOnlySettings(byName("fast-exits"), base)).toEqual([]);
  });

  it("builds the undo of a change from the settings before it", () => {
    const before = defaultStrategyConfig();
    const change = { signals: { scoreMomentum: { maxRiskScore: 25 } }, exits: { takeProfit: [{ atMultiple: 1.5, sellFractionOfInitial: 0.5 }] } };
    const undo = undoOverrides(before, change);
    expect(undo).toEqual({ signals: { scoreMomentum: { maxRiskScore: before.signals.scoreMomentum.maxRiskScore } }, exits: { takeProfit: before.exits.takeProfit } });
    expect(strategyHash(applyOverrides(applyOverrides(before, change), undo))).toBe(strategyHash(before));
  });

  it("keeps tradesAt inside the entry period of a window", () => {
    const trades = tradesAt(T0, spread(5, 0), "x");
    expect(trades.every((trade) => trade.openedAtMs > T0 && trade.openedAtMs < T0 + STEP_MS)).toBe(true);
    const plannedArm: PlannedArm = planned("x", {});
    expect(plannedArm.holdMs).toBe(HOLD_MS);
  });
});
