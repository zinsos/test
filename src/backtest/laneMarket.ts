import type { RecorderConfig } from "../config/strategy.js";
import type { Clock } from "../core/clock.js";
import type { MarketDataSource } from "../core/contracts.js";
import type { CurveView, Pubkey } from "../core/types.js";
import type { LaunchState, MarketState } from "../market/state.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export interface EvictionWindow {
  inactiveMs: number;
  maxAgeMs: number;
}

export function evictionWindowOf(memory: Pick<RecorderConfig["memory"], "evictInactiveMinutes" | "evictMaxAgeHours">): EvictionWindow {
  return { inactiveMs: memory.evictInactiveMinutes * MINUTE_MS, maxAgeMs: memory.evictMaxAgeHours * HOUR_MS };
}

export function evictableAt(launch: LaunchState, nowMs: number, window: EvictionWindow): boolean {
  const last = launch.lastTradeAtMs ?? launch.info.createdAtMs;
  return nowMs - last > window.inactiveMs || nowMs - launch.info.createdAtMs > window.maxAgeMs;
}

export class LaneMarket implements MarketDataSource {
  private readonly hidden = new Set<Pubkey>();

  constructor(
    private readonly market: MarketState,
    private readonly clock: Clock
  ) {}

  get(mint: Pubkey): LaunchState | undefined {
    return this.hidden.size > 0 && this.hidden.has(mint) ? undefined : this.market.get(mint);
  }

  launch(mint: Pubkey): LaunchState | undefined {
    return this.get(mint);
  }

  view(mint: Pubkey): CurveView | null {
    return this.get(mint)?.view(this.clock.nowMs()) ?? null;
  }

  latestSlot(): number {
    return this.market.latestSlot;
  }

  sees(mint: Pubkey): boolean {
    return !this.hidden.has(mint);
  }

  hide(mint: Pubkey): void {
    this.hidden.add(mint);
  }

  forget(mint: Pubkey): void {
    this.hidden.delete(mint);
  }

  hiddenCount(): number {
    return this.hidden.size;
  }
}
