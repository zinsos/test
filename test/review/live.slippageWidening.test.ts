import { Keypair, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../src/core/clock.js";
import { TradeRefusedError, type BuildRequest, type BuiltTrade, type TradeInstructionBuilder } from "../../src/execution/instructions.js";
import { LiveExecutor } from "../../src/execution/liveExecutor.js";
import { marketDataSource } from "../../src/execution/marketSource.js";
import { LaunchState, launchInfoFromEvent } from "../../src/market/state.js";
import { T0, createEvent, execConfig, newMarket, order } from "../execution.fixtures.js";

class RecordingBuilder implements TradeInstructionBuilder {
  readonly requests: BuildRequest[] = [];

  async build(request: BuildRequest): Promise<BuiltTrade> {
    this.requests.push(request);
    throw new TradeRefusedError("invalid_order", "recorded");
  }
}

describe("review live: the on-chain slippage tolerance grows past the configured cap when the price moved in our favour", () => {
  it("never asks the program for more slippage than order.maxSlippageBps", async () => {
    const market = newMarket();
    const clock = new VirtualClock(T0 + 3_000);
    market.adopt(new LaunchState(launchInfoFromEvent(createEvent())));
    const launch = market.get(createEvent().mint);
    const current = launch?.price() ?? 0;
    const builder = new RecordingBuilder();
    const executor = new LiveExecutor({
      connection: {} as Connection,
      keypair: Keypair.generate(),
      config: execConfig({ maxRetries: 0 }),
      dryRun: true,
      clock,
      market: marketDataSource(market, clock),
      builder
    });
    await executor.execute(order({ maxSlippageBps: 1500, referencePrice: current * 2 }));
    const sent = builder.requests[0]?.slippageBps ?? 0;
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThanOrEqual(1500);
  });
});
