import type { DecodeResult, DecodedChainEvent, PoolTradeEvent } from "../chain/events.js";
import type { Bus } from "../core/bus.js";
import type { Clock } from "../core/clock.js";
import { moduleLogger } from "../core/logger.js";
import type { ChainEvent, IngestGap, Pubkey, TradeEvent } from "../core/types.js";
import type { LaunchState, MarketState } from "../market/state.js";
import type { BatchHandler, GapHandler, StreamMeta, StreamSource } from "./source.js";

const log = moduleLogger("ingest-pipeline");

export type PoolLookup = (pool: Pubkey) => Pubkey | undefined;

export interface IngestPipelineOptions {
  market: MarketState;
  bus: Bus;
  clock: Clock;
  poolLookup?: PoolLookup;
}

export function poolTradeToChain(event: PoolTradeEvent, mint: Pubkey): TradeEvent {
  const { kind: _kind, ...rest } = event;
  return { ...rest, kind: "trade", mint, venue: "pool", pool: event.pool };
}

export function gapAffectsLaunch(gap: IngestGap, launch: Pick<LaunchState, "info">): boolean {
  return gap.fromSlot !== null ? launch.info.createdSlot <= gap.fromSlot : launch.info.createdAtMs <= gap.endedAtMs;
}

export function markGapInMemory(market: MarketState, gap: IngestGap): number {
  let marked = 0;
  for (const launch of market.all()) {
    if (launch.dataComplete && gapAffectsLaunch(gap, launch)) {
      launch.dataComplete = false;
      marked += 1;
    }
  }
  return marked;
}

export class IngestPipeline {
  private readonly market: MarketState;
  private readonly bus: Bus;
  private readonly clock: Clock;
  private poolLookup: PoolLookup | undefined;
  private readonly counters = {
    batches: 0,
    decodedEvents: 0,
    emitted: 0,
    notInMemory: 0,
    poolLookupHits: 0,
    unresolvedPoolTrades: 0,
    poolCreated: 0,
    applyErrors: 0,
    gaps: 0,
    launchesMarkedIncomplete: 0,
    lastSlot: 0,
    processingLagMs: 0
  };

  constructor(options: IngestPipelineOptions) {
    this.market = options.market;
    this.bus = options.bus;
    this.clock = options.clock;
    this.poolLookup = options.poolLookup;
  }

  setPoolLookup(lookup: PoolLookup | undefined): void {
    this.poolLookup = lookup;
  }

  readonly handleBatch: BatchHandler = (batch: DecodeResult, meta: StreamMeta): void => {
    this.counters.batches += 1;
    this.counters.lastSlot = Math.max(this.counters.lastSlot, meta.slot);
    for (const decoded of batch.events) {
      this.handleEvent(decoded);
    }
    this.counters.processingLagMs = Math.max(0, this.clock.nowMs() - meta.receivedAtMs);
  };

  readonly handleGap: GapHandler = (gap: IngestGap): void => {
    this.counters.gaps += 1;
    this.counters.launchesMarkedIncomplete += markGapInMemory(this.market, gap);
    this.bus.emit("gap", gap);
  };

  async attach(source: StreamSource): Promise<() => void> {
    const detachGap = source.onGap(this.handleGap);
    await source.start(this.handleBatch);
    return detachGap;
  }

  stats(): Record<string, number> {
    return { ...this.counters, marketLaunches: this.market.size };
  }

  private handleEvent(decoded: DecodedChainEvent): void {
    this.counters.decodedEvents += 1;
    let chain: ChainEvent | null;
    try {
      chain = this.resolve(decoded);
      if (!chain) {
        return;
      }
      if (this.market.apply(chain).kind === "ignored") {
        this.counters.notInMemory += 1;
      }
    } catch (error) {
      this.counters.applyErrors += 1;
      log.error({ err: error, kind: decoded.kind, signature: decoded.tx.signature }, "failed to apply chain event");
      return;
    }
    this.counters.emitted += 1;
    this.bus.emit("chain", chain);
  }

  private resolve(decoded: DecodedChainEvent): ChainEvent | null {
    if (decoded.kind === "poolCreated") {
      this.counters.poolCreated += 1;
    }
    const chain = this.market.resolve(decoded);
    if (chain || decoded.kind !== "poolTrade") {
      return chain;
    }
    const mint = this.poolLookup?.(decoded.pool);
    if (!mint) {
      this.counters.unresolvedPoolTrades += 1;
      return null;
    }
    this.counters.poolLookupHits += 1;
    return poolTradeToChain(decoded, mint);
  }
}
