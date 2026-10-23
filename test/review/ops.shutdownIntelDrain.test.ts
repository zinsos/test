import { describe, expect, it } from "vitest";
import { defaultStrategyConfig } from "../../src/config/strategy.js";
import { Bus } from "../../src/core/bus.js";
import { VirtualClock } from "../../src/core/clock.js";
import { MarketState } from "../../src/market/state.js";
import { createScorerModule, type IntelRpc } from "../../src/scorer/index.js";

describe("review ops: shutdown while wallet-intel RPC calls are in flight", () => {
  it("stops the scorer promptly instead of waiting for every queued RPC lookup", async () => {
    const hanging: IntelRpc = {
      getSignaturesForAddress: () => new Promise(() => undefined),
      getParsedTransaction: () => new Promise(() => undefined)
    };
    const clock = new VirtualClock(Date.UTC(2026, 9, 20));
    const scorer = createScorerModule({
      db: null,
      rpc: hanging,
      bus: new Bus(),
      market: new MarketState({ maxTradesPerLaunch: 1000, evictInactiveMs: 1e12, evictMaxAgeMs: 1e12, quoteMints: null }),
      clock,
      config: defaultStrategyConfig().scorer,
      mode: "live",
      model: null,
      weightsFile: "config/scorer-weights.json"
    });
    await scorer.start();
    const intel = scorer.intel;
    expect(intel).not.toBeNull();
    void intel?.ensure([{ wallet: "SlowWallet", buySignature: "buy", buySlot: 1 }], clock.nowMs() + 8_000);
    await clock.advanceTo(clock.nowMs() + 8_000);
    const outcome = await Promise.race([
      scorer.stop().then(() => "stopped"),
      new Promise<string>((resolve) => setTimeout(() => resolve("still draining"), 300))
    ]);
    expect(outcome).toBe("stopped");
  });
});
