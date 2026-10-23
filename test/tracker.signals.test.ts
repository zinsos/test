import { afterEach, describe, expect, it } from "vitest";
import { defaultStrategyConfig, type SignalsConfig, type TrackerConfig } from "../src/config/strategy.js";
import { Bus } from "../src/core/bus.js";
import { VirtualClock } from "../src/core/clock.js";
import type { ScoreProvider } from "../src/core/contracts.js";
import type { LaunchCreatedEvent, LaunchScore, Pubkey, Signal, TradeEvent } from "../src/core/types.js";
import { MarketState } from "../src/market/state.js";
import { TrackedWalletRegistry } from "../src/tracker/registry.js";
import { SignalEngine, type SignalRejectReason } from "../src/tracker/signals.js";

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const SEC = 1_000;
const PUMP_COIN = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const SUPPLY = 1_000_000_000_000_000n;

let signatureCounter = 0;

function createEvent(mint: string, atMs: number, quoteMint = "SOL"): LaunchCreatedEvent {
  signatureCounter += 1;
  return {
    kind: "create",
    tx: { signature: `create-${signatureCounter}`, slot: 1_000, seq: signatureCounter, eventIndex: 0, receivedAtMs: atMs },
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
    tokenTotalSupply: SUPPLY,
    tokenProgram: null,
    quoteMint,
    isMayhemMode: false,
    isCashback: false,
    isHolderReward: false,
    creatorFeeBps: 30,
    depth: 0
  };
}

interface TradeOptions {
  isBuy?: boolean;
  tokenAmount?: bigint;
  virtualTokenReserves?: bigint;
  virtualQuoteReserves?: bigint;
}

function tradeEvent(mint: string, wallet: string, atMs: number, options: TradeOptions = {}): TradeEvent {
  signatureCounter += 1;
  return {
    kind: "trade",
    tx: { signature: `trade-${signatureCounter}`, slot: 1_000 + Math.floor((atMs - T0) / 400), seq: signatureCounter, eventIndex: 0, receivedAtMs: atMs },
    venue: "curve",
    mint,
    pool: null,
    wallet,
    isBuy: options.isBuy ?? true,
    tokenAmount: options.tokenAmount ?? 1_000_000n,
    quoteAmount: 100_000_000n,
    userQuote: 101_000_000n,
    protocolFee: 950_000n,
    creatorFee: 50_000n,
    lpFee: 0n,
    protocolFeeBps: 95,
    creatorFeeBps: 5,
    lpFeeBps: 0,
    virtualTokenReserves: options.virtualTokenReserves ?? 1_070_000_000_000_000n,
    virtualQuoteReserves: options.virtualQuoteReserves ?? 30_100_000_000n,
    realTokenReserves: null,
    realQuoteReserves: null,
    timestampMs: atMs,
    ixName: "buy"
  };
}

function launchScore(mint: string, overrides: Partial<LaunchScore> = {}): LaunchScore {
  return {
    mint,
    launchId: null,
    checkpointSec: 10,
    computedAtMs: T0,
    slot: 1_000,
    score: 30,
    hardBlocked: false,
    flags: [],
    features: { unique_buyers_per_min: 20, buy_sell_count_ratio: 2 },
    contributions: {},
    weightsVersion: "test",
    ...overrides
  };
}

class FakeScores implements ScoreProvider {
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

interface Harness {
  clock: VirtualClock;
  bus: Bus;
  market: MarketState;
  scores: FakeScores;
  engine: SignalEngine;
  signals: Signal[];
  rejected: Array<{ signal: Signal; reason: SignalRejectReason }>;
  feed(event: LaunchCreatedEvent | TradeEvent): Promise<void>;
}

const defaults = defaultStrategyConfig();

function harness(options: { signals?: Partial<SignalsConfig>; convergence?: Partial<TrackerConfig["convergence"]>; tracked?: string[] } = {}): Harness {
  const clock = new VirtualClock(T0);
  const bus = new Bus();
  const market = new MarketState({ maxTradesPerLaunch: 10_000, evictInactiveMs: 3_600_000, evictMaxAgeMs: 86_400_000, quoteMints: null });
  const scores = new FakeScores();
  const signals: Signal[] = [];
  const rejected: Array<{ signal: Signal; reason: SignalRejectReason }> = [];
  const engine = new SignalEngine({
    clock,
    bus,
    market,
    scores,
    tracked: TrackedWalletRegistry.fromWallets(options.tracked ?? ["W1", "W2", "W3", "W4", "W5", "W6", "W7"]),
    signals: { ...defaults.signals, ...options.signals },
    convergence: { ...defaults.tracker.convergence, ...options.convergence },
    onRejected: (signal, reason) => rejected.push({ signal, reason })
  });
  bus.on("signal", (signal) => signals.push(signal));
  engine.start();
  return {
    clock,
    bus,
    market,
    scores,
    engine,
    signals,
    rejected,
    async feed(event) {
      await clock.advanceTo(event.timestampMs);
      market.apply(event);
      bus.emit("chain", event);
      await clock.advanceTo(event.timestampMs);
    }
  };
}

let active: Harness | null = null;

afterEach(async () => {
  await active?.engine.stop();
  active = null;
});

function setup(options: Parameters<typeof harness>[0] = {}): Harness {
  active = harness(options);
  return active;
}

describe("smart convergence", () => {
  it("signals when three distinct tracked wallets buy within the window and the score clears", async () => {
    const h = setup();
    h.scores.latestScores.set("M", launchScore("M", { score: 40 }));
    await h.feed(createEvent("M", T0));
    await h.feed(tradeEvent("M", "W1", T0 + 5 * SEC));
    await h.feed(tradeEvent("M", "W1", T0 + 6 * SEC));
    await h.feed(tradeEvent("M", "Stranger", T0 + 7 * SEC));
    await h.feed(tradeEvent("M", "W2", T0 + 8 * SEC));
    expect(h.signals).toHaveLength(0);
    await h.feed(tradeEvent("M", "W3", T0 + 20 * SEC));
    await h.engine.idle();
    expect(h.signals).toHaveLength(1);
    const signal = h.signals[0];
    expect(signal?.type).toBe("smart_convergence");
    expect(signal?.wallets).toEqual(["W1", "W2", "W3"]);
    expect(signal?.riskScore).toBe(40);
    expect(signal?.atMs).toBe(T0 + 20 * SEC);
    expect(signal?.meta.launchAgeSec).toBe(20);
    expect(signal?.meta.trackedVersion).toBe("static:7");
    expect(h.rejected).toEqual([]);
    expect(h.engine.trackedBuyers("M").map((buyer) => buyer.wallet)).toEqual(["W1", "W2", "W3"]);
  });

  it("drops buyers that fell out of the window", async () => {
    const h = setup({ convergence: { windowSec: 120 } });
    h.scores.latestScores.set("M", launchScore("M"));
    await h.feed(createEvent("M", T0));
    await h.feed(tradeEvent("M", "W1", T0));
    await h.feed(tradeEvent("M", "W2", T0 + 60 * SEC));
    await h.feed(tradeEvent("M", "W3", T0 + 121 * SEC));
    await h.engine.idle();
    expect(h.signals).toHaveLength(0);
    await h.feed(tradeEvent("M", "W4", T0 + 150 * SEC));
    await h.engine.idle();
    expect(h.signals).toHaveLength(1);
    expect(h.signals[0]?.wallets).toEqual(["W2", "W3", "W4"]);
  });

  it("applies the per-mint cooldown and signals again after it expires", async () => {
    const h = setup({ signals: { cooldownPerMintSec: 600 } });
    h.scores.latestScores.set("M", launchScore("M"));
    await h.feed(createEvent("M", T0));
    for (const [index, wallet] of ["W1", "W2", "W3"].entries()) {
      await h.feed(tradeEvent("M", wallet, T0 + (10 + index) * SEC));
    }
    await h.engine.idle();
    await h.feed(tradeEvent("M", "W4", T0 + 30 * SEC));
    await h.engine.idle();
    expect(h.signals).toHaveLength(1);
    expect(h.rejected.map((item) => item.reason)).toEqual(["cooldown"]);
    expect(h.engine.isCoolingDown("M", T0 + 100 * SEC)).toBe(true);
    for (const [index, wallet] of ["W5", "W6", "W7"].entries()) {
      await h.feed(tradeEvent("M", wallet, T0 + (700 + index) * SEC));
    }
    await h.engine.idle();
    expect(h.signals).toHaveLength(2);
    expect(h.signals[1]?.wallets).toEqual(["W5", "W6", "W7"]);
  });

  it("waits for an on-demand score bounded by the clock", async () => {
    const h = setup({ convergence: { waitForScoreMs: 5_000 } });
    h.scores.onDemand = (mint) =>
      new Promise((resolve) => {
        h.clock.schedule(h.clock.nowMs() + 2_000, () => resolve(launchScore(mint, { computedAtMs: h.clock.nowMs(), score: 20 })));
      });
    await h.feed(createEvent("M", T0));
    for (const [index, wallet] of ["W1", "W2", "W3"].entries()) {
      await h.feed(tradeEvent("M", wallet, T0 + (10 + index) * SEC));
    }
    expect(h.signals).toHaveLength(0);
    expect(h.scores.requests).toEqual(["M:convergence"]);
    await h.clock.advanceTo(T0 + 14 * SEC);
    await h.engine.idle();
    expect(h.signals).toHaveLength(1);
    expect(h.signals[0]?.atMs).toBe(T0 + 14 * SEC);
    expect(h.signals[0]?.meta.scoreWaitMs).toBe(2_000);
    expect(h.signals[0]?.riskScore).toBe(20);
  });

  it("rejects when no score arrives before the deadline", async () => {
    const h = setup({ convergence: { waitForScoreMs: 5_000 } });
    h.scores.onDemand = () => new Promise(() => undefined);
    await h.feed(createEvent("M", T0));
    for (const [index, wallet] of ["W1", "W2", "W3"].entries()) {
      await h.feed(tradeEvent("M", wallet, T0 + (10 + index) * SEC));
    }
    await h.clock.advanceTo(T0 + 16 * SEC);
    expect(h.rejected).toEqual([]);
    expect(h.engine.stats().pending).toBe(1);
    await h.clock.advanceTo(T0 + 17 * SEC);
    await h.engine.idle();
    expect(h.signals).toHaveLength(0);
    expect(h.rejected.map((item) => item.reason)).toEqual(["no_score"]);
    expect(h.rejected[0]?.signal.atMs).toBe(T0 + 17 * SEC);
    expect(h.clock.pendingCount()).toBe(0);
  });

  it("re-evaluates when another tracked wallet buys during a pending score wait", async () => {
    const h = setup({ convergence: { waitForScoreMs: 5_000 } });
    let calls = 0;
    h.scores.onDemand = (mint) => {
      calls += 1;
      return calls === 1 ? new Promise(() => undefined) : Promise.resolve(launchScore(mint, { computedAtMs: h.clock.nowMs() }));
    };
    await h.feed(createEvent("M", T0));
    for (const [index, wallet] of ["W1", "W2", "W3", "W4"].entries()) {
      await h.feed(tradeEvent("M", wallet, T0 + (10 + index) * SEC));
    }
    expect(calls).toBe(1);
    await h.clock.advanceTo(T0 + 17 * SEC);
    await h.engine.idle();
    expect(calls).toBe(2);
    expect(h.rejected.map((item) => item.reason)).toEqual(["no_score"]);
    expect(h.rejected[0]?.signal.wallets).toEqual(["W1", "W2", "W3"]);
    expect(h.signals).toHaveLength(1);
    expect(h.signals[0]?.wallets).toEqual(["W1", "W2", "W3", "W4"]);
    expect(h.signals[0]?.atMs).toBe(T0 + 17 * SEC);
  });

  it("rejects hard-blocked and too-risky launches", async () => {
    const h = setup();
    h.scores.latestScores.set("H", launchScore("H", { hardBlocked: true, score: 10 }));
    h.scores.latestScores.set("R", launchScore("R", { score: 80 }));
    for (const mint of ["H", "R"]) {
      await h.feed(createEvent(mint, T0));
      for (const [index, wallet] of ["W1", "W2", "W3"].entries()) {
        await h.feed(tradeEvent(mint, wallet, T0 + (10 + index) * SEC));
      }
    }
    await h.engine.idle();
    expect(h.signals).toHaveLength(0);
    expect(h.rejected.map((item) => [item.signal.mint, item.reason, item.signal.riskScore])).toEqual([
      ["H", "hard_blocked", 10],
      ["R", "risk_too_high", 80]
    ]);
  });

  it("rejects old launches and quote mints that are not traded", async () => {
    const h = setup({ convergence: { maxLaunchAgeSec: 600 } });
    h.scores.latestScores.set("OLD", launchScore("OLD"));
    h.scores.latestScores.set("PQ", launchScore("PQ"));
    await h.feed(createEvent("PQ", T0, PUMP_COIN));
    await h.feed(createEvent("OLD", T0 + SEC));
    for (const [index, wallet] of ["W1", "W2", "W3"].entries()) {
      await h.feed(tradeEvent("PQ", wallet, T0 + (10 + index) * SEC));
    }
    for (const [index, wallet] of ["W1", "W2", "W3"].entries()) {
      await h.feed(tradeEvent("OLD", wallet, T0 + (700 + index) * SEC));
    }
    await h.engine.idle();
    expect(h.signals).toHaveLength(0);
    expect(h.rejected.map((item) => item.reason)).toEqual(["quote_mint_not_allowed", "launch_too_old"]);
    expect(h.scores.requests).toEqual([]);
  });

  it("ignores trades for launches the market does not hold and respects the enabled list", async () => {
    const h = setup({ signals: { enabled: ["score_momentum"] } });
    h.scores.latestScores.set("M", launchScore("M"));
    for (const [index, wallet] of ["W1", "W2", "W3"].entries()) {
      await h.feed(tradeEvent("Unknown", wallet, T0 + index * SEC));
    }
    await h.feed(createEvent("M", T0 + 5 * SEC));
    for (const [index, wallet] of ["W1", "W2", "W3"].entries()) {
      await h.feed(tradeEvent("M", wallet, T0 + (10 + index) * SEC));
    }
    await h.engine.idle();
    expect(h.signals).toHaveLength(0);
    expect(h.rejected).toHaveLength(0);
    expect(h.engine.trackedBuyers("Unknown")).toEqual([]);
    expect(h.engine.trackedBuyers("M")).toHaveLength(3);
  });

  it("releases pending score waits on stop", async () => {
    const h = setup({ convergence: { waitForScoreMs: 60_000 } });
    h.scores.onDemand = () => new Promise(() => undefined);
    await h.feed(createEvent("M", T0));
    for (const [index, wallet] of ["W1", "W2", "W3"].entries()) {
      await h.feed(tradeEvent("M", wallet, T0 + (10 + index) * SEC));
    }
    expect(h.engine.stats().pending).toBe(1);
    await h.engine.stop();
    expect(h.engine.stats().pending).toBe(0);
    expect(h.signals).toHaveLength(0);
  });
});

describe("smart exits", () => {
  it("counts tracked wallets that sold at least half of what they bought since a time", async () => {
    const h = setup();
    await h.feed(createEvent("M", T0));
    await h.feed(tradeEvent("M", "W1", T0 + SEC, { tokenAmount: 1_000n }));
    await h.feed(tradeEvent("M", "W2", T0 + 2 * SEC, { tokenAmount: 1_000n }));
    await h.feed(tradeEvent("M", "Stranger", T0 + 3 * SEC, { tokenAmount: 1_000n }));
    await h.feed(tradeEvent("M", "W1", T0 + 10 * SEC, { isBuy: false, tokenAmount: 400n }));
    expect(h.engine.smartExitCount("M", T0)).toBe(0);
    await h.feed(tradeEvent("M", "W1", T0 + 20 * SEC, { isBuy: false, tokenAmount: 100n }));
    await h.feed(tradeEvent("M", "Stranger", T0 + 21 * SEC, { isBuy: false, tokenAmount: 1_000n }));
    await h.feed(tradeEvent("M", "W3", T0 + 22 * SEC, { isBuy: false, tokenAmount: 1_000n }));
    expect(h.engine.smartExitCount("M", T0)).toBe(1);
    expect(h.engine.smartExitCount("M", T0 + 20 * SEC)).toBe(1);
    expect(h.engine.smartExitCount("M", T0 + 21 * SEC)).toBe(0);
    await h.feed(tradeEvent("M", "W2", T0 + 30 * SEC, { isBuy: false, tokenAmount: 1_000n }));
    await h.feed(tradeEvent("M", "W2", T0 + 31 * SEC, { isBuy: false, tokenAmount: 1n }));
    expect(h.engine.smartExitCount("M", T0)).toBe(2);
    expect(h.engine.smartExitCount("Other", T0)).toBe(0);
    expect(h.engine.stats().smartExits).toBe(2);
  });
});

describe("score momentum", () => {
  const MOMENTUM = { enabled: ["score_momentum"] as Array<"smart_convergence" | "score_momentum"> };

  async function momentumLaunch(h: Harness, mint: string, mcapSol: number, quoteMint = "SOL"): Promise<void> {
    await h.feed(createEvent(mint, T0, quoteMint));
    await h.feed(
      tradeEvent(mint, "Buyer", T0 + 30 * SEC, {
        virtualTokenReserves: SUPPLY,
        virtualQuoteReserves: BigInt(Math.round(mcapSol * 1e9))
      })
    );
    await h.clock.advanceTo(T0 + 60 * SEC);
  }

  it("signals at the configured checkpoint when score, flow and SOL market cap pass", async () => {
    const h = setup({ signals: MOMENTUM });
    await momentumLaunch(h, "M", 50);
    h.bus.emit("score", launchScore("M", { checkpointSec: 30, computedAtMs: T0 + 60 * SEC }));
    expect(h.signals).toHaveLength(0);
    h.bus.emit("score", launchScore("M", { checkpointSec: 60, computedAtMs: T0 + 60 * SEC, score: 25 }));
    expect(h.signals).toHaveLength(1);
    expect(h.signals[0]?.type).toBe("score_momentum");
    expect(h.signals[0]?.riskScore).toBe(25);
    expect(h.signals[0]?.meta.mcapSol).toBeCloseTo(50, 6);
    expect(h.signals[0]?.meta.uniqueBuyersPerMin).toBe(20);
    h.bus.emit("score", launchScore("M", { checkpointSec: 60, computedAtMs: T0 + 60 * SEC }));
    expect(h.rejected.map((item) => item.reason)).toEqual(["cooldown"]);
  });

  it("rejects with the first failing check", async () => {
    const h = setup({ signals: MOMENTUM });
    const cases: Array<[string, number, Partial<LaunchScore>, string]> = [
      ["HB", 50, { hardBlocked: true }, "hard_blocked"],
      ["RISK", 50, { score: 36 }, "risk_too_high"],
      ["SLOW", 50, { features: { unique_buyers_per_min: 5, buy_sell_count_ratio: 3 } }, "low_buyer_rate"],
      ["SELLY", 50, { features: { unique_buyers_per_min: 30, buy_sell_count_ratio: 1.1 } }, "low_buy_sell_ratio"],
      ["NULLF", 50, { features: { unique_buyers_per_min: null, buy_sell_count_ratio: 3 } }, "low_buyer_rate"],
      ["SMALL", 20, {}, "mcap_out_of_band"],
      ["BIG", 200, {}, "mcap_out_of_band"]
    ];
    for (const [mint, mcap, overrides] of cases) {
      await momentumLaunch(h, mint, mcap);
      h.bus.emit("score", launchScore(mint, { checkpointSec: 60, computedAtMs: h.clock.nowMs(), ...overrides }));
    }
    expect(h.signals).toHaveLength(0);
    expect(h.rejected.map((item) => [item.signal.mint, item.reason])).toEqual(cases.map(([mint, , , reason]) => [mint, reason]));
  });

  it("rejects quote mints outside the allowed list", async () => {
    const h = setup({ signals: MOMENTUM });
    await momentumLaunch(h, "PQ", 50, PUMP_COIN);
    h.bus.emit("score", launchScore("PQ", { checkpointSec: 60, computedAtMs: h.clock.nowMs() }));
    expect(h.rejected.map((item) => item.reason)).toEqual(["quote_mint_not_allowed"]);
  });

  it("reports non-SOL launches as not SOL quoted when they are allowed", async () => {
    const h = setup({ signals: { ...MOMENTUM, quoteMints: ["SOL", PUMP_COIN] } });
    await momentumLaunch(h, "PQ", 50, PUMP_COIN);
    h.bus.emit("score", launchScore("PQ", { checkpointSec: 60, computedAtMs: h.clock.nowMs() }));
    expect(h.rejected.map((item) => item.reason)).toEqual(["not_sol_quoted"]);
  });
});

describe("signal engine memory", () => {
  it("evicts the least recently active mints beyond the cap", async () => {
    const clock = new VirtualClock(T0);
    const bus = new Bus();
    const market = new MarketState({ maxTradesPerLaunch: 100, evictInactiveMs: 3_600_000, evictMaxAgeMs: 86_400_000, quoteMints: null });
    const engine = new SignalEngine({
      clock,
      bus,
      market,
      scores: new FakeScores(),
      tracked: TrackedWalletRegistry.fromWallets(["W1"]),
      signals: defaults.signals,
      convergence: defaults.tracker.convergence,
      maxMints: 5,
      pruneEveryEvents: 1_000_000
    });
    engine.start();
    for (let index = 0; index < 12; index += 1) {
      const mint = `M${index}`;
      const create = createEvent(mint, T0 + index * SEC);
      market.apply(create);
      bus.emit("chain", create);
      const buy = tradeEvent(mint, "W1", T0 + index * SEC);
      market.apply(buy);
      bus.emit("chain", buy);
    }
    expect(engine.stats().mints).toBeLessThanOrEqual(6);
    expect(engine.trackedBuyers("M11")).toHaveLength(1);
    expect(engine.trackedBuyers("M0")).toHaveLength(0);
    await engine.stop();
  });
});
