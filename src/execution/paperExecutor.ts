import type { ExecutionConfig } from "../config/strategy.js";
import type { Clock } from "../core/clock.js";
import { SLOT_MS } from "../core/constants.js";
import type { Executor, MarketDataSource } from "../core/contracts.js";
import { createRng, type Rng } from "../core/rng.js";
import type { FillAttempt, FillResult, OrderRequest, TradingMode } from "../core/types.js";
import { failedFill, successfulFill } from "./fill.js";
import { RETRYABLE_ATTEMPT_ERRORS, simulateAttempt, type AttemptOutcome } from "./model.js";

export type SimulatedMode = Exclude<TradingMode, "live">;

export interface PaperExecutorOptions {
  clock: Clock;
  market: MarketDataSource;
  config: ExecutionConfig;
  mode?: SimulatedMode;
  seed?: string;
  maxTrackedPositions?: number;
}

export interface AttemptSchedule {
  atMs: number;
  slot: number;
  delaySlots: number;
}

interface TimedOutcome {
  atMs: number;
  slot: number;
  outcome: AttemptOutcome;
}

const DEFAULT_MAX_TRACKED_POSITIONS = 50_000;

export function attemptSeed(seed: string, order: OrderRequest, attempt: number): string {
  return [seed, order.mint, order.side, order.positionId ?? "none", order.signalAtMs, attempt].join("|");
}

export function drawJitterSlots(rng: Rng, maxJitterSlots: number): number {
  if (maxJitterSlots <= 0) {
    return 0;
  }
  return Math.min(maxJitterSlots, Math.floor(rng() * (maxJitterSlots + 1)));
}

export function scheduleAttempt(
  order: OrderRequest,
  config: Pick<ExecutionConfig, "latencySlots" | "retryDelaySlots">,
  attempt: number,
  jitterSlots: number,
  notBeforeMs: number
): AttemptSchedule {
  const delaySlots = config.latencySlots + jitterSlots + attempt * config.retryDelaySlots;
  return {
    atMs: Math.max(notBeforeMs, order.signalAtMs + delaySlots * SLOT_MS),
    slot: order.signalSlot + delaySlots,
    delaySlots
  };
}

function toFillAttempt(timed: TimedOutcome): FillAttempt {
  return {
    atMs: timed.atMs,
    slot: timed.slot,
    success: timed.outcome.success,
    error: timed.outcome.error,
    networkFee: timed.outcome.networkFee,
    tip: timed.outcome.tip
  };
}

export class PaperExecutor implements Executor {
  readonly mode: SimulatedMode;
  private readonly clock: Clock;
  private readonly market: MarketDataSource;
  private readonly config: ExecutionConfig;
  private readonly seed: string;
  private readonly maxTrackedPositions: number;
  private readonly positionsWithTokenAccount = new Map<string, number>();

  constructor(options: PaperExecutorOptions) {
    this.clock = options.clock;
    this.market = options.market;
    this.config = options.config;
    this.mode = options.mode ?? "paper";
    this.seed = options.seed ?? options.config.seed;
    this.maxTrackedPositions = options.maxTrackedPositions ?? DEFAULT_MAX_TRACKED_POSITIONS;
  }

  async execute(order: OrderRequest): Promise<FillResult> {
    const outcomes: TimedOutcome[] = [];
    let notBeforeMs = order.signalAtMs;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      const rng = createRng(attemptSeed(this.seed, order, attempt));
      const schedule = scheduleAttempt(order, this.config, attempt, drawJitterSlots(rng, this.config.latencyJitterSlots), notBeforeMs);
      await this.clock.sleepUntil(schedule.atMs);
      const atMs = Math.max(schedule.atMs, this.clock.nowMs());
      const view = this.market.view(order.mint);
      if (!view) {
        return failedFill(order, "no_market", outcomes.map(toFillAttempt), outcomes.at(-1)?.outcome.venue ?? "curve");
      }
      const outcome = simulateAttempt({
        order,
        view,
        config: this.config,
        rng,
        attempt,
        isFirstBuyOfPosition: this.isFirstBuy(order)
      });
      outcomes.push({ atMs, slot: schedule.slot, outcome });
      if (outcome.success || !outcome.error || !RETRYABLE_ATTEMPT_ERRORS.has(outcome.error)) {
        break;
      }
      notBeforeMs = atMs;
    }
    const fill = this.toFill(order, outcomes);
    if (fill.success) {
      this.trackTokenAccount(order);
    }
    return fill;
  }

  trackedPositionCount(): number {
    return this.positionsWithTokenAccount.size;
  }

  private isFirstBuy(order: OrderRequest): boolean {
    return order.positionId === null || !this.positionsWithTokenAccount.has(order.positionId);
  }

  private trackTokenAccount(order: OrderRequest): void {
    if (order.positionId === null) {
      return;
    }
    if (order.side === "sell") {
      if (order.closesPosition) {
        this.positionsWithTokenAccount.delete(order.positionId);
      }
      return;
    }
    this.positionsWithTokenAccount.set(order.positionId, order.signalAtMs);
    while (this.positionsWithTokenAccount.size > this.maxTrackedPositions) {
      const oldest = this.positionsWithTokenAccount.keys().next();
      if (oldest.done) {
        break;
      }
      this.positionsWithTokenAccount.delete(oldest.value);
    }
  }

  private toFill(order: OrderRequest, outcomes: readonly TimedOutcome[]): FillResult {
    const attempts = outcomes.map(toFillAttempt);
    const last = outcomes.at(-1);
    const success = outcomes.find((timed) => timed.outcome.success);
    const trade = success?.outcome.trade;
    if (!success || !trade) {
      return failedFill(order, last?.outcome.error ?? "no_attempt", attempts, last?.outcome.venue ?? "curve", {
        slippageBps: last?.outcome.slippageBps ?? null,
        priceImpactBps: last?.outcome.priceImpactBps ?? null
      });
    }
    return successfulFill({
      order,
      amounts: trade,
      quality: {
        fillPrice: success.outcome.fillPrice,
        slippageBps: success.outcome.slippageBps,
        priceImpactBps: success.outcome.priceImpactBps
      },
      attempts,
      filledAtMs: success.atMs,
      filledSlot: success.slot,
      rentPaid: success.outcome.rentPaid,
      rentRefunded: success.outcome.rentRefunded,
      signature: null
    });
  }
}
