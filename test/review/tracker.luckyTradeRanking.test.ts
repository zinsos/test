import { describe, expect, it } from "vitest";
import { defaultStrategyConfig } from "../../src/config/strategy.js";
import { compositeWalletScore, exclusionReasons, exclusionRulesFrom } from "../../src/tracker/scoring.js";
import { computeWindowStats } from "../../src/tracker/stats.js";
import { EMPTY_WALLET_FACTS, type RoundTrip } from "../../src/tracker/types.js";

const SOL = 1_000_000_000n;
const DAY = 86_400_000;
const AS_OF = Date.UTC(2026, 9, 20);
const config = defaultStrategyConfig().tracker;
const rules = exclusionRulesFrom(config);
const short = { fromMs: AS_OF - 30 * DAY, toMs: AS_OF };
const long = { fromMs: AS_OF - 90 * DAY, toMs: AS_OF };

let mintCounter = 0;

function trip(pnlLamports: bigint, closedAtMs: number, cost = SOL): RoundTrip {
  mintCounter += 1;
  const openedAtMs = closedAtMs - 10 * 60_000;
  return {
    wallet: "W",
    mint: `M${mintCounter}`,
    openedAtMs,
    openedSlot: 1,
    lastTradeAtMs: closedAtMs,
    cost,
    proceeds: cost + pnlLamports,
    tokensBought: 1_000n,
    tokensSold: 1_000n,
    buys: 1,
    sells: 1,
    entryDelaySec: 120,
    creationSlotEntry: false,
    closedAtMs,
    closeKind: "sold",
    pnl: pnlLamports,
    returnPct: (Number(pnlLamports) / Number(cost)) * 100,
    holdSec: 600
  };
}

function lotteryWallet(): RoundTrip[] {
  const trips: RoundTrip[] = [trip(100n * SOL, AS_OF - 2 * DAY, SOL / 2n), trip(-SOL / 20n, AS_OF - 3 * DAY)];
  for (let index = 0; index < 13; index += 1) {
    trips.push(trip(SOL / 100n, AS_OF - (5 + index) * DAY));
  }
  return trips;
}

function consistentWallet(): RoundTrip[] {
  const trips: RoundTrip[] = [];
  for (let index = 0; index < 60; index += 1) {
    const pnl = index % 3 === 2 ? -SOL / 2n : SOL;
    trips.push(trip(pnl, AS_OF - (1 + (index % 28)) * DAY));
  }
  return trips;
}

function evaluate(trips: RoundTrip[]) {
  const shortStats = computeWindowStats(trips, short);
  const longStats = computeWindowStats(trips, long);
  return {
    shortStats,
    reasons: exclusionReasons(shortStats, longStats, EMPTY_WALLET_FACTS, rules),
    score: compositeWalletScore(shortStats, longStats)
  };
}

describe("review: wallet ranking is dominated by one lucky trade", () => {
  it("ranks a 40/60 consistent +30 SOL trader above a wallet whose PnL is one 100 SOL hit plus dust", () => {
    const lottery = evaluate(lotteryWallet());
    const consistent = evaluate(consistentWallet());
    expect(lottery.reasons).toEqual([]);
    expect(consistent.reasons).toEqual([]);
    expect(lottery.shortStats.pnlExBestSol).toBeLessThan(0.2);
    expect(consistent.score).toBeGreaterThan(lottery.score);
  });
});
