import { describe, expect, it } from "vitest";
import type { Executor } from "../../src/core/contracts.js";
import type { FillResult, OrderRequest } from "../../src/core/types.js";
import { failedFill } from "../../src/execution/fill.js";
import { PaperExecutor } from "../../src/execution/paperExecutor.js";
import { MINT_A, SOL, T0, buildTrader, createEnv, createLaunch, moveQuoteReserves, signalFor, strategy } from "../trader.fixtures.js";

class LateLandingSellExecutor implements Executor {
  readonly mode = "live" as const;
  readonly sells: OrderRequest[] = [];
  walletTokens = 0n;

  constructor(private readonly inner: PaperExecutor) {}

  async execute(order: OrderRequest): Promise<FillResult> {
    if (order.side === "buy") {
      const fill = await this.inner.execute(order);
      this.walletTokens += fill.tokenAmount;
      return fill;
    }
    this.sells.push(order);
    if (this.sells.length === 1) {
      this.walletTokens -= order.tokenAmount ?? 0n;
      return { ...failedFill(order, "unconfirmed", [], "curve"), signature: "sig-sell-late" };
    }
    if (this.walletTokens <= 0n) {
      return failedFill(order, "no_balance", [], "curve");
    }
    return this.inner.execute(order);
  }
}

describe("review money: a sell whose outcome stayed unknown leaves a phantom position", () => {
  it("eventually closes the position once the wallet no longer holds the tokens", async () => {
    const env = createEnv();
    const config = strategy();
    const inner = new PaperExecutor({ clock: env.clock, market: env.source, config: config.execution });
    const executor = new LateLandingSellExecutor(inner);
    const reconcile = async (): Promise<FillResult | null> => null;
    const { trader, risk } = buildTrader(env, { config, executor, mode: "live", reconcile });
    await createLaunch(env, MINT_A, T0);
    await env.clock.advanceTo(T0 + 5_000);
    trader.handleSignal(signalFor(env, MINT_A));
    await env.clock.advanceTo(T0 + 10_000);
    expect(trader.primaryPositions()).toHaveLength(1);
    await moveQuoteReserves(env, MINT_A, 20n * SOL, T0 + 20_000);
    await env.clock.advanceTo(T0 + 2 * 3_600_000);
    expect(executor.walletTokens).toBe(0n);
    expect({
      open: trader.primaryPositions().length,
      sellsSubmitted: executor.sells.length,
      phantomUnrealizedPositive: risk.status().unrealizedPnlLamports > -SOL / 10n
    }).toEqual({ open: 0, sellsSubmitted: expect.any(Number), phantomUnrealizedPositive: false });
    expect(executor.sells.length).toBeLessThan(20);
  });
});
