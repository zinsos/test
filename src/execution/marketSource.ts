import type { Clock } from "../core/clock.js";
import type { MarketDataSource } from "../core/contracts.js";
import type { MarketState } from "../market/state.js";

export function marketDataSource(market: MarketState, clock: Clock): MarketDataSource {
  return {
    launch: (mint) => market.get(mint),
    view: (mint) => market.get(mint)?.view(clock.nowMs()) ?? null,
    latestSlot: () => market.latestSlot
  };
}
