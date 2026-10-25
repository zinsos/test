import { describe, expect, it } from "vitest";
import { quoteBuyExactQuoteIn, type CurveReserves } from "../src/chain/curve.js";
import { VirtualClock } from "../src/core/clock.js";
import { SLOT_MS } from "../src/core/constants.js";
import type { MarketDataSource } from "../src/core/contracts.js";
import { createRng } from "../src/core/rng.js";
import type { ExecutionConfig } from "../src/config/strategy.js";
import type { FillResult, OrderRequest } from "../src/core/types.js";
import {
  PaperExecutor,
  attemptSeed,
  drawJitterSlots,
  scheduleAttempt
} from "../src/execution/paperExecutor.js";
import {
  MINT,
  SLOT0,
  SOL,
  T0,
  createEvent,
  curveTradeEvent,
  execConfig,
  initialReserves,
  marketSource,
  newMarket,
  order,
  spotPrice
} from "./execution.fixtures.js";

const FEES = { protocolFeeBps: 95, creatorFeeBps: 30 };

interface Harness {
  clock: VirtualClock;
  market: ReturnType<typeof newMarket>;
  source: MarketDataSource;
  reserves: CurveReserves;
  trade(wallet: string, isBuy: boolean, amount: bigint, atMs: number): Promise<void>;
}

function harness(): Harness {
  const clock = new VirtualClock(T0);
  const market = newMarket();
  market.apply(createEvent());
  const state: Harness = {
    clock,
    market,
    source: marketSource(market, clock),
    reserves: initialReserves(),
    async trade(wallet, isBuy, amount, atMs) {
      await clock.advanceTo(atMs);
      const { event, after } = curveTradeEvent(state.reserves, {
        wallet,
        isBuy,
        amount,
        atMs,
        slot: SLOT0 + Math.floor((atMs - T0) / SLOT_MS)
      });
      market.apply(event);
      state.reserves = after;
    }
  };
  return state;
}

function quietConfig(overrides: Partial<ExecutionConfig> = {}): ExecutionConfig {
  return execConfig({ failureRate: 0, latencySlots: 2, latencyJitterSlots: 0, retryDelaySlots: 3, maxRetries: 2, ...overrides });
}

async function run(h: Harness, executor: PaperExecutor, request: OrderRequest, untilMs: number): Promise<FillResult> {
  const pending = executor.execute(request);
  await h.clock.advanceTo(untilMs);
  return pending;
}

describe("PaperExecutor latency", () => {
  it("fills at the state N slots after the signal, after trades that landed in the latency window", async () => {
    const h = harness();
    const config = quietConfig();
    const executor = new PaperExecutor({ clock: h.clock, market: h.source, config, mode: "paper", seed: "s" });
    const request = order({ quoteBudget: SOL / 2n, maxSlippageBps: 10_000, referencePrice: spotPrice(h.reserves) });
    const atSignal = quoteBuyExactQuoteIn(h.reserves, SOL / 2n, FEES);
    const pending = executor.execute(request);
    await h.trade("Sniper", true, 5n * SOL, T0 + SLOT_MS);
    const afterSniper = quoteBuyExactQuoteIn(h.reserves, SOL / 2n, FEES);
    await h.clock.advanceTo(T0 + 10 * SLOT_MS);
    const fill = await pending;
    expect(fill.success).toBe(true);
    expect(fill.filledAtMs).toBe(T0 + 2 * SLOT_MS);
    expect(fill.filledSlot).toBe(SLOT0 + 2);
    expect(fill.tokenAmount).toBe(afterSniper.tokensOut);
    expect(fill.tokenAmount).toBeLessThan(atSignal.tokensOut);
    expect(fill.slippageBps).toBeGreaterThan(1000);
    expect(fill.requestedAtMs).toBe(T0);
    expect(fill.attempts).toHaveLength(1);
  });

  it("ignores trades after the fill time", async () => {
    const h = harness();
    const executor = new PaperExecutor({ clock: h.clock, market: h.source, config: quietConfig(), seed: "s" });
    const request = order({ quoteBudget: SOL / 2n, maxSlippageBps: 10_000 });
    const expected = quoteBuyExactQuoteIn(h.reserves, SOL / 2n, FEES);
    const pending = executor.execute(request);
    await h.trade("Late", true, 5n * SOL, T0 + 3 * SLOT_MS);
    await h.clock.advanceTo(T0 + 20 * SLOT_MS);
    const fill = await pending;
    expect(fill.tokenAmount).toBe(expected.tokensOut);
  });

  it("fails on slippage when a sniper moves the price beyond the limit, then refuses the retry locally without a fee", async () => {
    const h = harness();
    const executor = new PaperExecutor({ clock: h.clock, market: h.source, config: quietConfig({ maxRetries: 1 }), seed: "s" });
    const request = order({ quoteBudget: SOL / 10n, maxSlippageBps: 1500, referencePrice: spotPrice(h.reserves) });
    const pending = executor.execute(request);
    await h.trade("Sniper", true, 10n * SOL, T0 + SLOT_MS);
    await h.clock.advanceTo(T0 + 20 * SLOT_MS);
    const fill = await pending;
    expect(fill.success).toBe(false);
    expect(fill.error).toBe("slippage_exceeded");
    expect(fill.attempts.map((attempt) => attempt.atMs)).toEqual([T0 + 2 * SLOT_MS, T0 + 5 * SLOT_MS]);
    expect(fill.attempts.map((attempt) => attempt.networkFee)).toEqual([BigInt(quietConfig().baseFeeLamports + quietConfig().priorityFeeLamports), 0n]);
    expect(fill.networkFees).toBe(BigInt(quietConfig().baseFeeLamports + quietConfig().priorityFeeLamports));
    expect(fill.tokenAmount).toBe(0n);
    expect(fill.slippageBps).toBeGreaterThan(1500);
  });
});

describe("PaperExecutor retries", () => {
  it("retries failed transactions on the configured schedule and sums the costs", async () => {
    const h = harness();
    const config = quietConfig({ failureRate: 1, maxRetries: 3, retryDelaySlots: 4, baseFeeLamports: 5_000, priorityFeeLamports: 50_000 });
    const executor = new PaperExecutor({ clock: h.clock, market: h.source, config, seed: "s" });
    const fill = await run(h, executor, order(), T0 + 100 * SLOT_MS);
    expect(fill.success).toBe(false);
    expect(fill.error).toBe("tx_failed");
    expect(fill.attempts.map((attempt) => attempt.atMs)).toEqual([
      T0 + 2 * SLOT_MS,
      T0 + 6 * SLOT_MS,
      T0 + 10 * SLOT_MS,
      T0 + 14 * SLOT_MS
    ]);
    expect(fill.attempts.map((attempt) => attempt.slot)).toEqual([SLOT0 + 2, SLOT0 + 6, SLOT0 + 10, SLOT0 + 14]);
    expect(fill.networkFees).toBe(4n * 55_000n);
    expect(fill.rentPaid).toBe(0n);
  });

  it("stops at the first success", async () => {
    const h = harness();
    const config = quietConfig({ failureRate: 0.5, maxRetries: 5 });
    const executor = new PaperExecutor({ clock: h.clock, market: h.source, config, seed: "retry-seed" });
    const fills: FillResult[] = [];
    for (let index = 0; index < 20; index += 1) {
      fills.push(await run(h, executor, order({ positionId: `p${index}`, signalAtMs: h.clock.nowMs() }), h.clock.nowMs() + 100 * SLOT_MS));
    }
    for (const fill of fills) {
      const successIndex = fill.attempts.findIndex((attempt) => attempt.success);
      if (fill.success) {
        expect(successIndex).toBe(fill.attempts.length - 1);
        expect(fill.attempts.slice(0, -1).every((attempt) => attempt.error === "tx_failed")).toBe(true);
      } else {
        expect(fill.attempts).toHaveLength(6);
      }
    }
    expect(fills.some((fill) => fill.attempts.length > 1)).toBe(true);
  });

  it("does not retry invalid orders and reports unknown mints without cost", async () => {
    const h = harness();
    const executor = new PaperExecutor({ clock: h.clock, market: h.source, config: quietConfig(), seed: "s" });
    const invalid = await run(h, executor, order({ quoteBudget: 0n }), T0 + 50 * SLOT_MS);
    expect(invalid.error).toBe("invalid_order");
    expect(invalid.attempts).toHaveLength(1);
    expect(invalid.networkFees).toBe(0n);
    const unknown = await run(h, executor, order({ mint: "Unknown", signalAtMs: h.clock.nowMs() }), h.clock.nowMs() + 50 * SLOT_MS);
    expect(unknown.error).toBe("no_market");
    expect(unknown.attempts).toHaveLength(0);
  });

  it("keeps attempt times monotonic with jitter and zero retry delay", () => {
    const config = quietConfig({ latencyJitterSlots: 3, retryDelaySlots: 0 });
    const request = order();
    let notBefore = request.signalAtMs;
    for (let attemptIndex = 0; attemptIndex < 10; attemptIndex += 1) {
      const rng = createRng(attemptSeed("x", request, attemptIndex));
      const jitter = drawJitterSlots(rng, config.latencyJitterSlots);
      const schedule = scheduleAttempt(request, config, attemptIndex, jitter, notBefore);
      expect(schedule.atMs).toBeGreaterThanOrEqual(notBefore);
      expect(schedule.delaySlots).toBeGreaterThanOrEqual(config.latencySlots);
      expect(schedule.delaySlots).toBeLessThanOrEqual(config.latencySlots + 3);
      notBefore = schedule.atMs;
    }
  });

  it("draws jitter uniformly within bounds", () => {
    const counts = [0, 0, 0];
    for (let index = 0; index < 3000; index += 1) {
      const jitter = drawJitterSlots(createRng(`j${index}`), 2);
      counts[jitter] = (counts[jitter] ?? 0) + 1;
    }
    for (const count of counts) {
      expect(count).toBeGreaterThan(800);
    }
    expect(drawJitterSlots(() => 0.999999, 2)).toBe(2);
    expect(drawJitterSlots(() => 0.5, 0)).toBe(0);
  });
});

describe("PaperExecutor determinism", () => {
  async function scenario(seed: string): Promise<FillResult[]> {
    const h = harness();
    const config = execConfig({ failureRate: 0.3, latencyJitterSlots: 3, maxRetries: 2 });
    const executor = new PaperExecutor({ clock: h.clock, market: h.source, config, mode: "backtest", seed });
    const fills: FillResult[] = [];
    for (let index = 0; index < 12; index += 1) {
      const start = T0 + index * 20 * SLOT_MS;
      const pending = executor.execute(
        order({ positionId: `p${index}`, signalAtMs: start, signalSlot: SLOT0 + index * 20, maxSlippageBps: 10_000 })
      );
      await h.trade(`w${index}`, true, SOL / 3n, start + SLOT_MS);
      await h.clock.advanceTo(start + 19 * SLOT_MS);
      fills.push(await pending);
    }
    return fills;
  }

  it("reproduces identical fills for the same seed and differs for another seed", async () => {
    const first = await scenario("seed-a");
    const second = await scenario("seed-a");
    expect(second).toEqual(first);
    const other = await scenario("seed-b");
    const timing = (fills: FillResult[]): number[][] => fills.map((fill) => fill.attempts.map((attempt) => attempt.atMs));
    expect(timing(other)).not.toEqual(timing(first));
  });

  it("uses the config seed by default and reports its mode", () => {
    const h = harness();
    const config = execConfig({ seed: "cfg" });
    expect(new PaperExecutor({ clock: h.clock, market: h.source, config }).mode).toBe("paper");
    expect(new PaperExecutor({ clock: h.clock, market: h.source, config, mode: "shadow" }).mode).toBe("shadow");
    expect(attemptSeed("cfg", order(), 1)).toBe(`cfg|${MINT}|buy|pos-1|${T0}|1`);
    expect(attemptSeed("cfg", order({ positionId: null }), 0)).toBe(`cfg|${MINT}|buy|none|${T0}|0`);
  });
});

describe("PaperExecutor token account rent", () => {
  it("charges rent on the first buy of a position, refunds on close, and charges again for a reopened position", async () => {
    const h = harness();
    const config = quietConfig({ ataRentLamports: 2_039_280 });
    const executor = new PaperExecutor({ clock: h.clock, market: h.source, config, seed: "rent" });
    const at = (): number => h.clock.nowMs();
    const first = await run(h, executor, order({ positionId: "A", signalAtMs: at(), maxSlippageBps: 10_000 }), at() + 10 * SLOT_MS);
    const second = await run(h, executor, order({ positionId: "A", signalAtMs: at(), maxSlippageBps: 10_000 }), at() + 10 * SLOT_MS);
    expect(first.rentPaid).toBe(2_039_280n);
    expect(second.rentPaid).toBe(0n);
    expect(executor.trackedPositionCount()).toBe(1);
    const close = await run(
      h,
      executor,
      order({
        side: "sell",
        positionId: "A",
        quoteBudget: null,
        tokenAmount: first.tokenAmount + second.tokenAmount,
        closesPosition: true,
        signalAtMs: at(),
        maxSlippageBps: 10_000
      }),
      at() + 10 * SLOT_MS
    );
    expect(close.success).toBe(true);
    expect(close.rentRefunded).toBe(2_039_280n);
    expect(executor.trackedPositionCount()).toBe(0);
    const reopened = await run(h, executor, order({ positionId: "A", signalAtMs: at(), maxSlippageBps: 10_000 }), at() + 10 * SLOT_MS);
    expect(reopened.rentPaid).toBe(2_039_280n);
    const anonymous = await run(h, executor, order({ positionId: null, signalAtMs: at(), maxSlippageBps: 10_000 }), at() + 10 * SLOT_MS);
    expect(anonymous.rentPaid).toBe(2_039_280n);
  });

  it("bounds the tracked position memory", async () => {
    const h = harness();
    const executor = new PaperExecutor({ clock: h.clock, market: h.source, config: quietConfig(), seed: "cap", maxTrackedPositions: 3 });
    for (let index = 0; index < 6; index += 1) {
      await run(h, executor, order({ positionId: `cap${index}`, signalAtMs: h.clock.nowMs(), quoteBudget: SOL / 1000n, maxSlippageBps: 10_000 }), h.clock.nowMs() + 10 * SLOT_MS);
    }
    expect(executor.trackedPositionCount()).toBe(3);
  });
});

describe("PaperExecutor fills", () => {
  it("reports consistent totals for a sell after a buy", async () => {
    const h = harness();
    const config = quietConfig({ extraPlatformFeeBps: 100 });
    const executor = new PaperExecutor({ clock: h.clock, market: h.source, config, seed: "fills" });
    const buy = await run(h, executor, order({ maxSlippageBps: 10_000 }), T0 + 10 * SLOT_MS);
    const sell = await run(
      h,
      executor,
      order({ side: "sell", quoteBudget: null, tokenAmount: buy.tokenAmount, signalAtMs: h.clock.nowMs(), maxSlippageBps: 10_000 }),
      h.clock.nowMs() + 10 * SLOT_MS
    );
    expect(buy.userQuote).toBe(buy.quoteAmount + buy.protocolFee + buy.creatorFee + buy.extraPlatformFee);
    expect(sell.userQuote).toBe(sell.quoteAmount - sell.protocolFee - sell.creatorFee - sell.extraPlatformFee);
    expect(sell.userQuote).toBeLessThan(buy.userQuote);
    expect(buy.fillPrice).toBeCloseTo(Number(buy.userQuote) / Number(buy.tokenAmount), 12);
    expect(buy.venue).toBe("curve");
    expect(buy.signature).toBeNull();
    expect(buy.error).toBeNull();
  });
});
