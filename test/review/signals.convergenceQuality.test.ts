import { afterEach, describe, expect, it } from "vitest";
import { defaultStrategyConfig } from "../../src/config/strategy.js";
import { Bus } from "../../src/core/bus.js";
import { VirtualClock } from "../../src/core/clock.js";
import type { ScoreProvider } from "../../src/core/contracts.js";
import type { LaunchCreatedEvent, LaunchScore, Pubkey, Signal, TradeEvent } from "../../src/core/types.js";
import { MarketState } from "../../src/market/state.js";
import { TrackedWalletRegistry } from "../../src/tracker/registry.js";
import { SignalEngine, type SignalRejectReason } from "../../src/tracker/signals.js";

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const SEC = 1_000;
const MIN = 60 * SEC;
let counter = 0;

function createEvent(mint: string, atMs: number): LaunchCreatedEvent {
  counter += 1;
  return {
    kind: "create",
    tx: { signature: `create-${counter}`, slot: 1_000, seq: counter, eventIndex: 0, receivedAtMs: atMs },
    mint,
    bondingCurve: `${mint}Curve`,
    devWallet: `${mint}Dev`,
    creator: `${mint}Dev`,
    name: mint,
    symbol: mint,
    uri: "",
    timestampMs: atMs,
    virtualTokenReserves: 1_073_000_000_000_000n,
    virtualQuoteReserves: 30_000_000_000n,
    realTokenReserves: 793_100_000_000_000n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    tokenProgram: null,
    quoteMint: "SOL",
    isMayhemMode: false,
    isCashback: false,
    isHolderReward: false,
    creatorFeeBps: 30,
    depth: 0
  };
}

function trade(mint: string, wallet: string, atMs: number, isBuy = true): TradeEvent {
  counter += 1;
  return {
    kind: "trade",
    tx: { signature: `trade-${counter}`, slot: 1_000 + Math.floor((atMs - T0) / 400), seq: counter, eventIndex: 0, receivedAtMs: atMs },
    venue: "curve",
    mint,
    pool: null,
    wallet,
    isBuy,
    tokenAmount: 1_000_000n,
    quoteAmount: 100_000_000n,
    userQuote: 101_000_000n,
    protocolFee: 950_000n,
    creatorFee: 50_000n,
    lpFee: 0n,
    protocolFeeBps: 95,
    creatorFeeBps: 5,
    lpFeeBps: 0,
    virtualTokenReserves: 1_070_000_000_000_000n,
    virtualQuoteReserves: 30_100_000_000n,
    realTokenReserves: null,
    realQuoteReserves: null,
    timestampMs: atMs,
    ixName: isBuy ? "buy" : "sell"
  };
}

function score(mint: string, overrides: Partial<LaunchScore> = {}): LaunchScore {
  return {
    mint,
    launchId: null,
    checkpointSec: 120,
    computedAtMs: T0 + 120 * SEC,
    slot: 1_000,
    score: 30,
    hardBlocked: false,
    flags: [],
    features: { dev_sold_fraction: 0 },
    contributions: {},
    weightsVersion: "test",
    ...overrides
  };
}

class Scores implements ScoreProvider {
  readonly latestScores = new Map<Pubkey, LaunchScore>();
  readonly requests: string[] = [];
  onDemand: (mint: Pubkey) => Promise<LaunchScore | null> = async () => null;

  latest(mint: Pubkey): LaunchScore | null {
    return this.latestScores.get(mint) ?? null;
  }

  scoreNow(mint: Pubkey, reason: string): Promise<LaunchScore | null> {
    this.requests.push(`${mint}:${reason}`);
    return this.onDemand(mint);
  }
}

const defaults = defaultStrategyConfig();
let engine: SignalEngine | null = null;

function setup() {
  const clock = new VirtualClock(T0);
  const bus = new Bus();
  const market = new MarketState({ maxTradesPerLaunch: 10_000, evictInactiveMs: 3_600_000, evictMaxAgeMs: 86_400_000, quoteMints: null });
  const scores = new Scores();
  const signals: Signal[] = [];
  const rejected: Array<{ signal: Signal; reason: SignalRejectReason }> = [];
  engine = new SignalEngine({
    clock,
    bus,
    market,
    scores,
    tracked: TrackedWalletRegistry.fromWallets(["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9"]),
    signals: defaults.signals,
    convergence: defaults.tracker.convergence,
    onRejected: (signal, reason) => rejected.push({ signal, reason })
  });
  bus.on("signal", (signal) => signals.push(signal));
  engine.start();
  const feed = async (event: LaunchCreatedEvent | TradeEvent): Promise<void> => {
    await clock.advanceTo(event.timestampMs);
    market.apply(event);
    bus.emit("chain", event);
    await clock.advanceTo(event.timestampMs);
  };
  return { clock, scores, signals, rejected, feed, engine };
}

afterEach(async () => {
  await engine?.stop();
  engine = null;
});

describe("review: smart convergence signal quality", () => {
  it("does not count a tracked wallet that already sold its whole position as converging", async () => {
    const h = setup();
    h.scores.latestScores.set("M", score("M", { checkpointSec: 10, computedAtMs: T0 + 10 * SEC }));
    await h.feed(createEvent("M", T0));
    await h.feed(trade("M", "W1", T0 + 5 * SEC));
    await h.feed(trade("M", "W1", T0 + 12 * SEC, false));
    await h.feed(trade("M", "W2", T0 + 60 * SEC));
    await h.feed(trade("M", "W3", T0 + 70 * SEC));
    await h.engine.idle();
    expect(h.engine.smartExitCount("M", T0)).toBe(1);
    expect(h.signals).toHaveLength(0);
  });

  it("re-scores instead of accepting on a 40-minute-old checkpoint score", async () => {
    const h = setup();
    h.scores.latestScores.set("M", score("M"));
    h.scores.onDemand = async (mint) =>
      score(mint, { checkpointSec: 2_400, computedAtMs: T0 + 40 * MIN + 10 * SEC, score: 80, hardBlocked: true, flags: ["hard_dev_share", "dev_dumped"] });
    await h.feed(createEvent("M", T0));
    await h.feed(trade("M", "W1", T0 + 40 * MIN));
    await h.feed(trade("M", "W2", T0 + 40 * MIN + 5 * SEC));
    await h.feed(trade("M", "W3", T0 + 40 * MIN + 10 * SEC));
    await h.engine.idle();
    expect(h.scores.requests).toHaveLength(1);
    expect(h.signals).toHaveLength(0);
  });

  it("does not record a rejected cooldown signal for every further tracked buyer after an accepted signal", async () => {
    const h = setup();
    h.scores.latestScores.set("M", score("M", { checkpointSec: 10, computedAtMs: T0 + 10 * SEC }));
    await h.feed(createEvent("M", T0));
    const wallets = ["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9"];
    for (const [index, wallet] of wallets.entries()) {
      await h.feed(trade("M", wallet, T0 + 20 * SEC + index * 5 * SEC));
      await h.engine.idle();
    }
    expect(h.signals).toHaveLength(1);
    expect(h.rejected.map((item) => item.reason)).toEqual([]);
  });
});
