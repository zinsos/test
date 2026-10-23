import { describe, expect, it } from "vitest";
import type { Executor } from "../../src/core/contracts.js";
import type { FillResult, OrderRequest } from "../../src/core/types.js";
import { failedFill } from "../../src/execution/fill.js";
import { PaperExecutor } from "../../src/execution/paperExecutor.js";
import { MINT_A, T0, buildTrader, createEnv, createLaunch, signalFor, strategy } from "../trader.fixtures.js";

class SlippageRejectingLiveExecutor implements Executor {
  readonly mode = "live" as const;

  async execute(order: OrderRequest): Promise<FillResult> {
    return failedFill(order, "slippage_exceeded", [], "curve");
  }
}

describe("review money: a paper shadow position makes the live trader look busy", () => {
  it("lets the hot to cold sweeper run when only shadow positions are open", async () => {
    const env = createEnv();
    const config = strategy();
    const shadow = new PaperExecutor({ clock: env.clock, market: env.source, config: config.execution, mode: "shadow" });
    const { trader } = buildTrader(env, { config, executor: new SlippageRejectingLiveExecutor(), shadowExecutor: shadow, mode: "live" });
    await createLaunch(env, MINT_A, T0);
    await env.clock.advanceTo(T0 + 5_000);
    trader.handleSignal(signalFor(env, MINT_A));
    await env.clock.advanceTo(T0 + 10_000);
    expect(trader.primaryPositions()).toHaveLength(0);
    expect(trader.openPositions()).toHaveLength(1);
    expect(trader.isBusy()).toBe(false);
  });
});
