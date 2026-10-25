import { variantKey } from "../src/lab/identity.js";
import type {
  EvidenceIdentity,
  EvidenceTrade,
  EvidenceWindow,
  LearnerInput,
  LearnerRule,
  LearnerState,
  PaperEvidence,
  PlannedArm
} from "../src/lab/learner.js";

export const HOUR_MS = 3_600_000;
export const T0 = Date.UTC(2026, 9, 20, 0, 0, 0);
export const SETTINGS = "a".repeat(64);
export const OTHER_SETTINGS = "b".repeat(64);
export const ENGINE = "engine-test-0001";
export const WEIGHTS = "hand-v2";
export const IDENTITY: EvidenceIdentity = { settingsHash: SETTINGS, engineVersion: ENGINE, weightsVersion: WEIGHTS };
export const WINDOW_MS = 3 * HOUR_MS;
export const HOLD_MS = HOUR_MS;
export const STEP_MS = WINDOW_MS - HOLD_MS;
export const BET_SOL = 0.048;

export const RULE: LearnerRule = {
  minTrades: 100,
  minWindows: 10,
  maxWindows: 40,
  confirmWindows: 24,
  windowMs: WINDOW_MS,
  familyConfidence: 0.95,
  bootstrapIterations: 2000,
  seed: "learner-test",
  minPaperTrades: 20
};

export const EMPTY_STATE: LearnerState = { tried: new Set(), nominations: 0, confirming: null, pending: null, probation: null };

const JITTER = [0.03, -0.02, 0.01, -0.03, 0.02, 0, -0.01, 0.025, -0.015, 0.005, -0.025, 0.015];
const JITTER_B = [-0.01, 0.02, -0.03, 0.015, 0, 0.025, -0.02, 0.01, 0.03, -0.015, 0.005, -0.005];

export function jitter(index: number): number {
  return JITTER[index % JITTER.length] ?? 0;
}

export function jitterB(index: number): number {
  return JITTER_B[index % JITTER_B.length] ?? 0;
}

export function spread(n: number, mean: number, width = 0.6): number[] {
  return Array.from({ length: n }, (_, index) => mean + (index % 2 === 0 ? width : -width));
}

export function solOf(r: number): number {
  return Math.round(r * BET_SOL * 1e9) / 1e9;
}

export function tradesAt(fromMs: number, rs: readonly number[], tag: string, entryMs = STEP_MS): EvidenceTrade[] {
  return rs.map((r, index) => ({
    r,
    sol: solOf(r),
    mint: `${tag}-${fromMs}-${index}`,
    openedAtMs: fromMs + Math.floor(((index + 1) * entryMs) / (rs.length + 1))
  }));
}

export function planned(name: string, overrides: Record<string, unknown>, options: { ownerOnly?: string[]; holdMs?: number; description?: string } = {}): PlannedArm {
  return {
    name,
    description: options.description ?? `${name} description`,
    overrides,
    key: variantKey(name, overrides),
    ownerOnly: options.ownerOnly ?? [],
    holdMs: options.holdMs ?? HOLD_MS
  };
}

export const STRICT = planned("momentum-strict", { signals: { scoreMomentum: { maxRiskScore: 25 } } });
export const FAST = planned("fast-exits", { exits: { timeStop: { afterSec: 120 } } });

export interface ArmSpec {
  arm: PlannedArm;
  rs: readonly number[] | null;
  sameCoins?: boolean;
  promotable?: boolean;
}

export interface WindowOptions {
  startMs?: number;
  hours?: number;
  labRunId?: number;
  settingsHash?: string | null;
  engineVersion?: string | null;
  weightsVersion?: string | null;
}

export function windowStart(index: number): number {
  return T0 + index * STEP_MS;
}

export function evidenceWindow(index: number, baseline: readonly number[] | null, arms: readonly ArmSpec[], options: WindowOptions = {}): EvidenceWindow {
  const fromMs = options.startMs ?? windowStart(index);
  return {
    labRunId: options.labRunId ?? index + 1,
    fromMs,
    toMs: fromMs + (options.hours ?? 3) * HOUR_MS,
    settingsHash: options.settingsHash === undefined ? SETTINGS : options.settingsHash,
    engineVersion: options.engineVersion === undefined ? ENGINE : options.engineVersion,
    weightsVersion: options.weightsVersion === undefined ? WEIGHTS : options.weightsVersion,
    arms: [
      { name: "baseline", key: variantKey("baseline", {}), isBaseline: true, promotable: false, trades: baseline === null ? null : tradesAt(fromMs, baseline, "b") },
      ...arms.map((spec) => ({
        name: spec.arm.name,
        key: spec.arm.key,
        isBaseline: false,
        promotable: spec.promotable ?? spec.arm.ownerOnly.length === 0,
        trades: spec.rs === null ? null : tradesAt(fromMs, spec.rs, spec.sameCoins ? "b" : spec.arm.name)
      }))
    ]
  };
}

export interface SeriesArm {
  arm: PlannedArm;
  rs: (index: number) => readonly number[] | null;
  sameCoins?: boolean;
  promotable?: boolean;
}

export function series(count: number, baseline: (index: number) => readonly number[] | null, arms: readonly SeriesArm[], startIndex = 0): EvidenceWindow[] {
  return Array.from({ length: count }, (_, offset) => {
    const index = startIndex + offset;
    return evidenceWindow(
      index,
      baseline(index),
      arms.map((entry) => ({ arm: entry.arm, rs: entry.rs(index), sameCoins: entry.sameCoins, promotable: entry.promotable }))
    );
  });
}

export function paperOf(windows: readonly EvidenceWindow[], options: { perWindow?: number; shift?: number; runId?: number; startedAtMs?: number; configMatches?: boolean } = {}): PaperEvidence {
  const trades: EvidenceTrade[] = [];
  for (const window of windows) {
    const replay = window.arms.find((arm) => arm.isBaseline)?.trades ?? [];
    for (const trade of replay.slice(0, options.perWindow ?? replay.length)) {
      const r = trade.r - (options.shift ?? 0);
      trades.push({ r, sol: solOf(r), mint: trade.mint, openedAtMs: trade.openedAtMs + 1_000 });
    }
  }
  return {
    runId: options.runId ?? 7,
    startedAtMs: options.startedAtMs ?? T0 - HOUR_MS,
    configMatches: options.configMatches ?? true,
    trades
  };
}

export function learnerInput(overrides: Partial<LearnerInput> = {}): LearnerInput {
  const windows = overrides.windows ?? [];
  return {
    nowMs: T0 + 400 * HOUR_MS,
    labRunId: 999,
    identity: IDENTITY,
    enabled: true,
    canPromote: true,
    rule: RULE,
    baselineHoldMs: HOLD_MS,
    variants: [STRICT],
    paper: overrides.paper === undefined ? paperOf(windows) : overrides.paper,
    state: EMPTY_STATE,
    scorer: { runs: [], activeVersion: WEIGHTS, rule: { minAucGain: 0.03, minValidationRows: 1000 } },
    ...overrides,
    windows
  };
}
