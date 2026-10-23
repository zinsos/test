import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeLogs } from "../src/chain/events.js";
import { defaultStrategyConfig } from "../src/config/strategy.js";
import { SOL_QUOTE } from "../src/core/constants.js";
import type { LaunchCreatedEvent } from "../src/core/types.js";
import { createRng } from "../src/core/rng.js";
import { MarketState } from "../src/market/state.js";
import {
  computeOutcome,
  findInsiders,
  findRug,
  mcapAt,
  normalizedTimes,
  outcomeParamsFrom,
  subjectFromLaunchState,
  type OutcomeLaunch,
  type OutcomeParams,
  type OutcomeTrade
} from "../src/recorder/outcomes.js";

const T0 = 1_800_000_000_000;
const S0 = 1_000;
const INITIAL = 1_000n;
const DEV = "Dev1111111111111111111111111111111111111111";
const CREATOR = "Creator111111111111111111111111111111111111";
const BUNDLER = "Bundler11111111111111111111111111111111111";
const RETAIL_A = "RetailA11111111111111111111111111111111111";
const RETAIL_B = "RetailB11111111111111111111111111111111111";
const RETAIL_C = "RetailC11111111111111111111111111111111111";

const config = defaultStrategyConfig();
const params: OutcomeParams = outcomeParamsFrom(config.recorder, config.scorer.bundleSlotWindow);

function launch(overrides: Partial<OutcomeLaunch> = {}): OutcomeLaunch {
  return {
    createdAtMs: T0,
    createdSlot: S0,
    initialMcapQuote: INITIAL,
    devWallets: [DEV, CREATOR],
    completedAtMs: null,
    migratedAtMs: null,
    ...overrides
  };
}

interface TradeSpec {
  sec: number;
  wallet: string;
  buy: boolean;
  tokens: bigint;
  mcap: bigint;
  slot?: number;
  venue?: OutcomeTrade["venue"];
  quote?: bigint;
}

function trade(spec: TradeSpec): OutcomeTrade {
  return {
    atMs: T0 + spec.sec * 1000,
    slot: spec.slot ?? S0 + 10 + Math.floor(spec.sec * 2.5),
    wallet: spec.wallet,
    isBuy: spec.buy,
    venue: spec.venue ?? "curve",
    tokenAmount: spec.tokens,
    quoteAmount: spec.quote ?? 10n,
    mcapQuote: spec.mcap
  };
}

function scale(trades: OutcomeTrade[], factor: bigint): OutcomeTrade[] {
  return trades.map((item) => ({ ...item, mcapQuote: item.mcapQuote * factor, quoteAmount: item.quoteAmount * factor }));
}

function rugScenario(): OutcomeTrade[] {
  return [
    trade({ sec: 0, slot: S0, wallet: DEV, buy: true, tokens: 100n, mcap: 1_100n }),
    trade({ sec: 0, slot: S0 + 1, wallet: BUNDLER, buy: true, tokens: 100n, mcap: 1_200n }),
    trade({ sec: 10, wallet: RETAIL_A, buy: true, tokens: 300n, mcap: 2_000n }),
    trade({ sec: 20, wallet: RETAIL_B, buy: true, tokens: 300n, mcap: 3_000n }),
    trade({ sec: 60, wallet: DEV, buy: false, tokens: 100n, mcap: 2_000n }),
    trade({ sec: 61, wallet: BUNDLER, buy: false, tokens: 100n, mcap: 800n }),
    trade({ sec: 90, wallet: RETAIL_A, buy: false, tokens: 300n, mcap: 500n })
  ];
}

describe("mcap checkpoints", () => {
  it("uses the last trade at or before the checkpoint and the initial mcap before any trade", () => {
    const trades = [
      trade({ sec: 5, wallet: RETAIL_A, buy: true, tokens: 1n, mcap: 1_500n }),
      trade({ sec: 60, wallet: RETAIL_B, buy: true, tokens: 1n, mcap: 2_000n }),
      trade({ sec: 61, wallet: RETAIL_C, buy: true, tokens: 1n, mcap: 2_500n })
    ];
    const times = normalizedTimes(trades, T0);
    const now = T0 + 3_600_000;
    expect(mcapAt([], [], T0, 30, now, INITIAL)).toBe(INITIAL);
    expect(mcapAt(trades, times, T0, 4, now, INITIAL)).toBe(INITIAL);
    expect(mcapAt(trades, times, T0, 30, now, INITIAL)).toBe(1_500n);
    expect(mcapAt(trades, times, T0, 60, now, INITIAL)).toBe(2_000n);
    expect(mcapAt(trades, times, T0, 300, now, INITIAL)).toBe(2_500n);
  });

  it("returns null for checkpoints that are still in the future", () => {
    const outcome = computeOutcome({
      launch: launch(),
      trades: [trade({ sec: 5, wallet: RETAIL_A, buy: true, tokens: 1n, mcap: 1_500n })],
      nowMs: T0 + 45_000,
      params
    });
    expect(outcome.mcap30s).toBe(1_500n);
    expect(outcome.mcap1m).toBeNull();
    expect(outcome.mcap15m).toBeNull();
    expect(outcome.mcap1h).toBeNull();
    expect(outcome.peakMultipleFrom1m).toBeNull();
    expect(outcome.return15mFrom1m).toBeNull();
    expect(outcome.survived15m).toBeNull();
    expect(outcome.status).toBe("alive");
    expect(outcome.finalized).toBe(false);
    expect(outcome.outcomeKnownAtMs).toBeNull();
    expect(outcome.nextCheckAtMs).toBe(T0 + 60_000);
  });

  it("clamps out of order timestamps so checkpoints never go backwards", () => {
    const trades = [
      trade({ sec: 50, wallet: RETAIL_A, buy: true, tokens: 1n, mcap: 2_000n }),
      trade({ sec: 20, wallet: RETAIL_B, buy: true, tokens: 1n, mcap: 3_000n })
    ];
    expect(normalizedTimes(trades, T0)).toEqual([T0 + 50_000, T0 + 50_000]);
    const outcome = computeOutcome({ launch: launch(), trades, nowMs: T0 + 120_000, params });
    expect(outcome.mcap30s).toBe(INITIAL);
    expect(outcome.mcap1m).toBe(3_000n);
  });
});

describe("peak and returns", () => {
  it("computes peak, time to peak, drawdown, final mcap and 1m based returns", () => {
    const trades = [
      trade({ sec: 10, wallet: RETAIL_A, buy: true, tokens: 10n, mcap: 1_500n, quote: 100n }),
      trade({ sec: 60, wallet: RETAIL_B, buy: true, tokens: 10n, mcap: 2_000n, quote: 200n }),
      trade({ sec: 200, wallet: RETAIL_C, buy: true, tokens: 10n, mcap: 6_000n, quote: 300n }),
      trade({ sec: 400, wallet: RETAIL_A, buy: false, tokens: 10n, mcap: 1_500n, quote: 50n }),
      trade({ sec: 890, wallet: RETAIL_B, buy: false, tokens: 5n, mcap: 3_000n, quote: 60n })
    ];
    const outcome = computeOutcome({ launch: launch(), trades, nowMs: T0 + 1_000_000, params });
    expect(outcome.peakMcapQuote).toBe(6_000n);
    expect(outcome.peakAtMs).toBe(T0 + 200_000);
    expect(outcome.timeToPeakSec).toBe(200);
    expect(outcome.finalMcapQuote).toBe(3_000n);
    expect(outcome.maxDrawdownFromPeak).toBeCloseTo(0.75, 10);
    expect(outcome.mcap1m).toBe(2_000n);
    expect(outcome.mcap15m).toBe(3_000n);
    expect(outcome.peakMultipleFrom1m).toBeCloseTo(3, 10);
    expect(outcome.return15mFrom1m).toBeCloseTo(0.5, 10);
    expect(outcome.tradeCount).toBe(5);
    expect(outcome.buyCount).toBe(3);
    expect(outcome.sellCount).toBe(2);
    expect(outcome.uniqueTraders).toBe(3);
    expect(outcome.totalVolumeQuote).toBe(710n);
    expect(outcome.details.peakMultiple).toBeCloseTo(6, 10);
  });

  it("treats a launch that never traded above its start as peaking at creation", () => {
    const trades = [trade({ sec: 10, wallet: RETAIL_A, buy: false, tokens: 10n, mcap: 900n })];
    const outcome = computeOutcome({ launch: launch(), trades, nowMs: T0 + 120_000, params });
    expect(outcome.peakMcapQuote).toBe(INITIAL);
    expect(outcome.peakAtMs).toBe(T0);
    expect(outcome.timeToPeakSec).toBe(0);
    expect(outcome.maxDrawdownFromPeak).toBeCloseTo(0.1, 10);
  });

  it("reports zero drawdown when the last trade is the peak", () => {
    const trades = [trade({ sec: 10, wallet: RETAIL_A, buy: true, tokens: 10n, mcap: 1_900n })];
    const outcome = computeOutcome({ launch: launch(), trades, nowMs: T0 + 120_000, params });
    expect(outcome.maxDrawdownFromPeak).toBe(0);
  });
});

describe("dev selling", () => {
  it("treats dev wallet and creator as dev and caps the sold fraction at one", () => {
    const trades = [
      trade({ sec: 0, slot: S0, wallet: DEV, buy: true, tokens: 100n, mcap: 1_100n }),
      trade({ sec: 30, wallet: CREATOR, buy: false, tokens: 40n, mcap: 1_050n }),
      trade({ sec: 50, wallet: DEV, buy: false, tokens: 30n, mcap: 1_020n })
    ];
    const outcome = computeOutcome({ launch: launch(), trades, nowMs: T0 + 120_000, params });
    expect(outcome.devSoldAtMs).toBe(T0 + 30_000);
    expect(outcome.devSoldFraction).toBeCloseTo(0.7, 10);
    const oversold = computeOutcome({
      launch: launch(),
      trades: [...trades, trade({ sec: 55, wallet: CREATOR, buy: false, tokens: 500n, mcap: 900n })],
      nowMs: T0 + 120_000,
      params
    });
    expect(oversold.devSoldFraction).toBe(1);
  });

  it("returns null when the dev never traded", () => {
    const outcome = computeOutcome({
      launch: launch(),
      trades: [trade({ sec: 5, wallet: RETAIL_A, buy: true, tokens: 1n, mcap: 1_100n })],
      nowMs: T0 + 120_000,
      params
    });
    expect(outcome.devSoldAtMs).toBeNull();
    expect(outcome.devSoldFraction).toBeNull();
  });
});

describe("insiders", () => {
  it("includes dev wallets, same-window bundle buyers and known insiders", () => {
    const trades = rugScenario();
    const insiders = findInsiders(launch({ knownInsiders: [RETAIL_C] }), trades, 1);
    expect([...insiders].sort()).toEqual([BUNDLER, CREATOR, DEV, RETAIL_C].sort());
    const strict = findInsiders(launch(), trades, 0);
    expect(strict.has(BUNDLER)).toBe(false);
  });

  it("uses the first buy only", () => {
    const trades = [
      trade({ sec: 30, slot: S0 + 50, wallet: RETAIL_A, buy: true, tokens: 1n, mcap: 1_100n }),
      trade({ sec: 31, slot: S0, wallet: RETAIL_A, buy: true, tokens: 1n, mcap: 1_200n })
    ];
    expect(findInsiders(launch(), trades, 1).has(RETAIL_A)).toBe(false);
  });
});

describe("rug labelling", () => {
  it("labels an insider dump followed by a collapse as rugged at the first qualifying moment", () => {
    const outcome = computeOutcome({ launch: launch(), trades: rugScenario(), nowMs: T0 + 1_200_000, params });
    expect(outcome.status).toBe("rugged");
    expect(outcome.rugged).toBe(true);
    expect(outcome.died).toBe(false);
    expect(outcome.rugAtMs).toBe(T0 + 60_000);
    expect(outcome.outcomeKnownAtMs).toBe(T0 + 360_000);
    expect(outcome.finalized).toBe(true);
    expect(outcome.nextCheckAtMs).toBeNull();
    expect(outcome.details.insiderCount).toBe(3);
  });

  it("is not final before the lookahead has passed", () => {
    const outcome = computeOutcome({ launch: launch(), trades: rugScenario(), nowMs: T0 + 200_000, params });
    expect(outcome.status).toBe("rugged");
    expect(outcome.finalized).toBe(false);
    expect(outcome.nextCheckAtMs).toBe(T0 + 300_000);
  });

  it("finds a collapse that happens later inside the lookahead window", () => {
    const trades = [
      trade({ sec: 0, slot: S0, wallet: DEV, buy: true, tokens: 100n, mcap: 1_500n }),
      trade({ sec: 20, wallet: RETAIL_A, buy: true, tokens: 500n, mcap: 4_000n }),
      trade({ sec: 100, wallet: DEV, buy: false, tokens: 100n, mcap: 3_000n }),
      trade({ sec: 300, wallet: RETAIL_A, buy: false, tokens: 500n, mcap: 1_000n })
    ];
    const outcome = computeOutcome({ launch: launch(), trades, nowMs: T0 + 2_000_000, params });
    expect(outcome.status).toBe("rugged");
    expect(outcome.rugAtMs).toBe(T0 + 100_000);
  });

  it("ignores collapses beyond the lookahead window", () => {
    const trades = [
      trade({ sec: 0, slot: S0, wallet: DEV, buy: true, tokens: 100n, mcap: 1_500n }),
      trade({ sec: 20, wallet: RETAIL_A, buy: true, tokens: 500n, mcap: 4_000n }),
      trade({ sec: 100, wallet: DEV, buy: false, tokens: 100n, mcap: 3_000n }),
      trade({ sec: 500, wallet: RETAIL_A, buy: false, tokens: 500n, mcap: 1_000n })
    ];
    const outcome = computeOutcome({ launch: launch(), trades, nowMs: T0 + 2_000_000, params });
    expect(outcome.rugged).toBe(false);
  });

  it("does not label a dump that leaves the price above the drop threshold", () => {
    const trades = rugScenario().map((item) => (item.mcapQuote < 1_000n ? { ...item, mcapQuote: 1_600n } : item));
    const outcome = computeOutcome({ launch: launch(), trades, nowMs: T0 + 600_000, params });
    expect(outcome.rugged).toBe(false);
  });

  it("does not label a collapse when insiders sold too little", () => {
    const trades = [
      trade({ sec: 0, slot: S0, wallet: DEV, buy: true, tokens: 100n, mcap: 1_100n }),
      trade({ sec: 0, slot: S0 + 1, wallet: BUNDLER, buy: true, tokens: 100n, mcap: 1_200n }),
      trade({ sec: 20, wallet: RETAIL_B, buy: true, tokens: 300n, mcap: 3_000n }),
      trade({ sec: 60, wallet: DEV, buy: false, tokens: 80n, mcap: 2_000n }),
      trade({ sec: 61, wallet: RETAIL_B, buy: false, tokens: 300n, mcap: 500n })
    ];
    const outcome = computeOutcome({ launch: launch(), trades, nowMs: T0 + 600_000, params });
    expect(outcome.rugged).toBe(false);
  });

  it("only counts insider sells inside the rug window", () => {
    const trades = [
      trade({ sec: 0, slot: S0, wallet: DEV, buy: true, tokens: 100n, mcap: 1_100n }),
      trade({ sec: 20, wallet: RETAIL_B, buy: true, tokens: 300n, mcap: 3_000n }),
      trade({ sec: 30, wallet: DEV, buy: false, tokens: 30n, mcap: 2_800n }),
      trade({ sec: 400, wallet: DEV, buy: false, tokens: 30n, mcap: 2_700n }),
      trade({ sec: 401, wallet: RETAIL_B, buy: false, tokens: 300n, mcap: 500n })
    ];
    const outcome = computeOutcome({ launch: launch(), trades, nowMs: T0 + 2_000_000, params });
    expect(outcome.rugged).toBe(false);
  });

  it("never labels a migrated launch as rugged", () => {
    const outcome = computeOutcome({
      launch: launch({ completedAtMs: T0 + 400_000 }),
      trades: rugScenario(),
      nowMs: T0 + 1_200_000,
      params
    });
    expect(outcome.status).toBe("migrated");
    expect(outcome.rugged).toBe(false);
    expect(outcome.rugAtMs).toBeNull();
  });

  it("does not call a dev exit after the pump already faded a rug", () => {
    const trades = [
      trade({ sec: 0, slot: S0, wallet: DEV, buy: true, tokens: 100n, mcap: 1_100n }),
      trade({ sec: 20, wallet: RETAIL_A, buy: true, tokens: 500n, mcap: 5_000n }),
      trade({ sec: 200, wallet: RETAIL_A, buy: false, tokens: 450n, mcap: 1_400n }),
      trade({ sec: 900, wallet: DEV, buy: false, tokens: 100n, mcap: 1_150n }),
      trade({ sec: 905, wallet: RETAIL_B, buy: true, tokens: 5n, mcap: 1_160n })
    ];
    const outcome = computeOutcome({ launch: launch(), trades, nowMs: T0 + 6_000_000, params });
    expect(outcome.rugged).toBe(false);
    expect(outcome.status).toBe("died");
    expect(outcome.details.peakMultiple).toBe(5);
  });

  it("measures the collapse against the price insiders sold into, not the all-time peak", () => {
    const trades = [
      trade({ sec: 0, slot: S0, wallet: DEV, buy: true, tokens: 400n, mcap: 1_100n }),
      trade({ sec: 20, wallet: RETAIL_A, buy: true, tokens: 500n, mcap: 8_000n }),
      trade({ sec: 200, wallet: RETAIL_A, buy: false, tokens: 200n, mcap: 4_000n }),
      trade({ sec: 600, wallet: RETAIL_B, buy: true, tokens: 50n, mcap: 4_200n }),
      trade({ sec: 650, wallet: DEV, buy: false, tokens: 400n, mcap: 1_000n })
    ];
    const outcome = computeOutcome({ launch: launch(), trades, nowMs: T0 + 6_000_000, params });
    expect(outcome.rugged).toBe(true);
    expect(outcome.rugAtMs).toBe(T0 + 650_000);
  });
});

interface BruteRugParams {
  windowMs: number;
  lookaheadMs: number;
  sellFraction: number;
  dropFraction: number;
}

function bruteForceRug(trades: OutcomeTrade[], times: number[], insiders: Set<string>, initial: bigint, rug: BruteRugParams): number | null {
  for (let index = 0; index < trades.length; index += 1) {
    const tau = times[index] ?? 0;
    const groupStart = times.findIndex((time) => time === tau);
    let maxHoldings = 0n;
    let holdings = 0n;
    const balances = new Map<string, bigint>();
    let windowSold = 0n;
    for (let j = 0; j <= index; j += 1) {
      const trade = trades[j];
      if (!trade || !insiders.has(trade.wallet)) {
        continue;
      }
      const before = balances.get(trade.wallet) ?? 0n;
      const after = before + (trade.isBuy ? trade.tokenAmount : -trade.tokenAmount);
      balances.set(trade.wallet, after);
      holdings += (after > 0n ? after : 0n) - (before > 0n ? before : 0n);
      maxHoldings = holdings > maxHoldings ? holdings : maxHoldings;
      if (!trade.isBuy && (times[j] ?? 0) >= tau - rug.windowMs) {
        windowSold += trade.tokenAmount;
      }
    }
    let level = initial;
    for (let j = 0; j < groupStart; j += 1) {
      const mcap = trades[j]?.mcapQuote ?? 0n;
      const time = times[j] ?? 0;
      if (time < tau - rug.windowMs) {
        level = mcap;
      }
    }
    for (let j = 0; j < groupStart; j += 1) {
      const mcap = trades[j]?.mcapQuote ?? 0n;
      if ((times[j] ?? 0) >= tau - rug.windowMs && mcap > level) {
        level = mcap;
      }
    }
    let low: bigint | null = null;
    for (let j = groupStart; j < trades.length; j += 1) {
      if ((times[j] ?? 0) <= tau + rug.lookaheadMs) {
        const mcap = trades[j]?.mcapQuote ?? 0n;
        low = low === null || mcap < low ? mcap : low;
      }
    }
    const dumped = maxHoldings > 0n && Number(windowSold) >= rug.sellFraction * Number(maxHoldings);
    const collapsed = low !== null && Number(low) <= (1 - rug.dropFraction) * Number(level);
    if (dumped && collapsed) {
      return tau;
    }
  }
  return null;
}

describe("rug detection against a brute force reference", () => {
  it("agrees with an O(n^2) implementation of the same rule on random launches", () => {
    const rng = createRng("rug-property");
    const wallets = [DEV, BUNDLER, RETAIL_A, RETAIL_B, RETAIL_C];
    const insiders = new Set([DEV, BUNDLER]);
    const rug = { windowMs: 120_000, lookaheadMs: 300_000, sellFraction: 0.5, dropFraction: 0.7 };
    let rugs = 0;
    for (let round = 0; round < 400; round += 1) {
      const trades: OutcomeTrade[] = [];
      let sec = 0;
      const count = 2 + Math.floor(rng() * 25);
      for (let index = 0; index < count; index += 1) {
        sec += Math.floor(rng() * 90);
        trades.push(
          trade({
            sec,
            wallet: wallets[Math.floor(rng() * wallets.length)] ?? DEV,
            buy: rng() < 0.55,
            tokens: BigInt(1 + Math.floor(rng() * 100)),
            mcap: BigInt(200 + Math.floor(rng() * 5_000))
          })
        );
      }
      const times = normalizedTimes(trades, T0);
      const expected = bruteForceRug(trades, times, insiders, INITIAL, rug);
      const actual = findRug(trades, times, insiders, INITIAL, rug).rugAtMs;
      expect(actual, `round ${round}`).toBe(expected);
      rugs += expected === null ? 0 : 1;
    }
    expect(rugs).toBeGreaterThan(20);
  });
});

describe("dead labelling", () => {
  it("labels an inactive launch that stayed small as died, known after the inactivity window", () => {
    const trades = [
      trade({ sec: 5, wallet: RETAIL_A, buy: true, tokens: 10n, mcap: 1_300n }),
      trade({ sec: 120, wallet: RETAIL_A, buy: false, tokens: 10n, mcap: 1_200n })
    ];
    const outcome = computeOutcome({ launch: launch(), trades, nowMs: T0 + 40 * 60_000, params });
    expect(outcome.status).toBe("died");
    expect(outcome.died).toBe(true);
    expect(outcome.outcomeKnownAtMs).toBe(T0 + 120_000 + 30 * 60_000);
    expect(outcome.finalized).toBe(true);
  });

  it("keeps a quiet launch alive until the inactivity window passes", () => {
    const trades = [trade({ sec: 120, wallet: RETAIL_A, buy: true, tokens: 10n, mcap: 1_200n })];
    const outcome = computeOutcome({ launch: launch(), trades, nowMs: T0 + 20 * 60_000, params });
    expect(outcome.status).toBe("alive");
    expect(outcome.nextCheckAtMs).toBe(T0 + 120_000 + 30 * 60_000);
  });

  it("does not call a quiet launch dead when it holds a high multiple", () => {
    const trades = [trade({ sec: 120, wallet: RETAIL_A, buy: true, tokens: 10n, mcap: 1_600n })];
    const outcome = computeOutcome({ launch: launch(), trades, nowMs: T0 + 40 * 60_000, params });
    expect(outcome.status).toBe("alive");
    expect(outcome.died).toBe(false);
  });

  it("labels a launch that never traded as died from its creation time", () => {
    const outcome = computeOutcome({ launch: launch(), trades: [], nowMs: T0 + 31 * 60_000, params });
    expect(outcome.status).toBe("died");
    expect(outcome.outcomeKnownAtMs).toBe(T0 + 30 * 60_000);
    expect(outcome.lastTradeAtMs).toBeNull();
    expect(outcome.finalMcapQuote).toBe(INITIAL);
  });
});

describe("migration labelling", () => {
  it("labels completed launches as migrated and keeps tracking for the post migration window", () => {
    const trades = [
      trade({ sec: 10, wallet: RETAIL_A, buy: true, tokens: 10n, mcap: 5_000n }),
      trade({ sec: 600, wallet: RETAIL_B, buy: true, tokens: 10n, mcap: 15_000n })
    ];
    const completed = T0 + 600_000;
    const early = computeOutcome({ launch: launch({ completedAtMs: completed }), trades, nowMs: T0 + 3_600_000, params });
    expect(early.status).toBe("migrated");
    expect(early.migrated).toBe(true);
    expect(early.outcomeKnownAtMs).toBe(completed);
    expect(early.survived15m).toBe(true);
    expect(early.finalized).toBe(false);
    expect(early.nextCheckAtMs).toBe(T0 + 24 * 3_600_000);
    const late = computeOutcome({
      launch: launch({ completedAtMs: completed }),
      trades,
      nowMs: completed + 24 * 3_600_000,
      params
    });
    expect(late.finalized).toBe(true);
  });

  it("derives migration from pool trades when complete events were missed", () => {
    const trades = [
      trade({ sec: 10, wallet: RETAIL_A, buy: true, tokens: 10n, mcap: 5_000n }),
      trade({ sec: 700, wallet: RETAIL_B, buy: true, tokens: 10n, mcap: 16_000n, venue: "pool" })
    ];
    const outcome = computeOutcome({ launch: launch(), trades, nowMs: T0 + 3_600_000, params });
    expect(outcome.status).toBe("migrated");
    expect(outcome.completedAtMs).toBe(T0 + 700_000);
    expect(outcome.peakMcapQuote).toBe(16_000n);
  });

  it("uses the earliest of complete and migrate times", () => {
    const outcome = computeOutcome({
      launch: launch({ completedAtMs: T0 + 900_000, migratedAtMs: T0 + 800_000 }),
      trades: [],
      nowMs: T0 + 3_600_000,
      params
    });
    expect(outcome.completedAtMs).toBe(T0 + 800_000);
    expect(outcome.died).toBe(false);
  });
});

describe("survival at 15 minutes", () => {
  it("survives with recent trading at or above the initial multiple", () => {
    const trades = [trade({ sec: 840, wallet: RETAIL_A, buy: true, tokens: 10n, mcap: 1_200n })];
    expect(computeOutcome({ launch: launch(), trades, nowMs: T0 + 900_000, params }).survived15m).toBe(true);
  });

  it("fails without a trade in the recent window", () => {
    const trades = [trade({ sec: 500, wallet: RETAIL_A, buy: true, tokens: 10n, mcap: 1_200n })];
    expect(computeOutcome({ launch: launch(), trades, nowMs: T0 + 900_000, params }).survived15m).toBe(false);
  });

  it("fails when the 15 minute mcap is below the initial multiple", () => {
    const trades = [trade({ sec: 840, wallet: RETAIL_A, buy: false, tokens: 10n, mcap: 900n })];
    expect(computeOutcome({ launch: launch(), trades, nowMs: T0 + 900_000, params }).survived15m).toBe(false);
  });

  it("ignores trades after the check time", () => {
    const trades = [trade({ sec: 950, wallet: RETAIL_A, buy: true, tokens: 10n, mcap: 1_200n })];
    expect(computeOutcome({ launch: launch(), trades, nowMs: T0 + 1_000_000, params }).survived15m).toBe(false);
  });
});

describe("finalization", () => {
  it("finalizes any launch at the hard age limit even when still alive", () => {
    const trades = [trade({ sec: 86_000, wallet: RETAIL_A, buy: true, tokens: 10n, mcap: 50_000n })];
    const outcome = computeOutcome({ launch: launch(), trades, nowMs: T0 + 24 * 3_600_000, params });
    expect(outcome.status).toBe("alive");
    expect(outcome.finalized).toBe(true);
    expect(outcome.nextCheckAtMs).toBeNull();
  });
});

describe("quote units", () => {
  it("labels pump-coin quoted launches identically to sol quoted ones because multiples are unit free", () => {
    const factor = 7_654_321_000n;
    const sol = computeOutcome({ launch: launch(), trades: rugScenario(), nowMs: T0 + 1_200_000, params });
    const pump = computeOutcome({
      launch: launch({ initialMcapQuote: INITIAL * factor }),
      trades: scale(rugScenario(), factor),
      nowMs: T0 + 1_200_000,
      params
    });
    expect(pump.status).toBe(sol.status);
    expect(pump.rugAtMs).toBe(sol.rugAtMs);
    expect(pump.peakMcapQuote).toBe(sol.peakMcapQuote * factor);
    expect(pump.details.peakMultiple).toBeCloseTo(sol.details.peakMultiple, 10);
    expect(pump.maxDrawdownFromPeak).toBeCloseTo(sol.maxDrawdownFromPeak, 10);
  });

  it("computes outcomes for real pump-quoted and sol-quoted launches replayed into market state", () => {
    interface FixtureTx {
      signature: string;
      slot: number;
      logs: string[];
    }
    const fixtures = JSON.parse(
      readFileSync(new URL("./fixtures/mainnet-transactions.json", import.meta.url), "utf8")
    ) as FixtureTx[];
    const market = new MarketState({ maxTradesPerLaunch: 1000, evictInactiveMs: 1e12, evictMaxAgeMs: 1e12, quoteMints: null });
    const sorted = [...fixtures].sort((a, b) => a.slot - b.slot);
    sorted.forEach((tx, index) => {
      const decoded = decodeLogs(tx.logs, { signature: tx.signature, slot: tx.slot, seq: index + 1, receivedAtMs: 0 });
      for (const event of decoded.events) {
        const chain = market.resolve(event);
        if (chain) {
          market.apply(chain);
        }
      }
    });
    const creates = sorted
      .flatMap((tx) => decodeLogs(tx.logs, { signature: tx.signature, slot: tx.slot, seq: 0, receivedAtMs: 0 }).events)
      .filter((event): event is LaunchCreatedEvent => event.kind === "create");
    const pumpCreate = creates.find((event) => event.quoteMint !== SOL_QUOTE && event.mint.startsWith("Cokr"));
    const solCreate = creates.find((event) => event.quoteMint === SOL_QUOTE);
    expect(pumpCreate && solCreate).toBeTruthy();
    for (const create of [pumpCreate, solCreate]) {
      const state = market.get(create?.mint ?? "");
      expect(state).toBeDefined();
      if (!state) {
        continue;
      }
      const subject = subjectFromLaunchState(1, state);
      const outcome = computeOutcome({ launch: subject.launch, trades: subject.trades, nowMs: state.info.createdAtMs + 600_000, params });
      expect(outcome.initialMcapQuote).toBe(state.initialMcapQuote());
      expect(outcome.tradeCount).toBe(state.trades.length);
      expect(outcome.details.peakMultiple).toBeGreaterThan(1);
      expect(outcome.details.peakMultiple).toBeLessThan(10);
      const devBuy = state.trades.find((item) => item.wallet === state.info.devWallet);
      expect(devBuy).toBeDefined();
      expect(outcome.details.insiderCount).toBeGreaterThanOrEqual(2);
    }
    const pumpState = market.get(pumpCreate?.mint ?? "");
    expect(pumpState?.trades.length).toBe(3);
    expect(pumpState?.trades.every((item) => item.mcapQuote > 0n)).toBe(true);
  });
});
