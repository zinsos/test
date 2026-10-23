import { describe, expect, it } from "vitest";
import type { Executor } from "../../src/core/contracts.js";
import type { FillResult, OrderRequest } from "../../src/core/types.js";
import { failedFill } from "../../src/execution/fill.js";
import { PaperExecutor } from "../../src/execution/paperExecutor.js";
import { MINT_A, T0, buildTrader, createEnv, createLaunch, signalFor, strategy } from "../trader.fixtures.js";

class LateLandingBuyExecutor implements Executor {
  readonly mode = "live" as const;
  walletTokens = 0n;
  walletSpent = 0n;

  constructor(private readonly inner: PaperExecutor) {}

  async execute(order: OrderRequest): Promise<FillResult> {
    const landed = await this.inner.execute(order);
    if (order.side === "buy" && landed.success) {
      this.walletTokens += landed.tokenAmount;
      this.walletSpent += landed.userQuote;
      return { ...failedFill(order, "unconfirmed", [], "curve"), signature: "sig-buy-late" };
    }
    return landed;
  }
}

describe("review money: a live buy whose outcome stayed unknown is forgotten", () => {
  it("keeps tracking the exposure of a buy that may have landed", async () => {
    const env = createEnv();
    const config = strategy();
    const inner = new PaperExecutor({ clock: env.clock, market: env.source, config: config.execution });
    const executor = new LateLandingBuyExecutor(inner);
    const reconcile = async (): Promise<FillResult | null> => null;
    const { trader, store, risk } = buildTrader(env, { config, executor, mode: "live", reconcile });
    await createLaunch(env, MINT_A, T0);
    await env.clock.advanceTo(T0 + 5_000);
    trader.handleSignal(signalFor(env, MINT_A));
    await env.clock.advanceTo(T0 + 600_000);
    expect(executor.walletTokens).toBeGreaterThan(0n);
    expect({
      tracked: trader.hasOpenPosition(MINT_A),
      positionsRecorded: store.positions.size,
      realizedLamports: risk.status().realizedPnlLamports
    }).toEqual({ tracked: true, positionsRecorded: 1, realizedLamports: expect.any(BigInt) });
  });
});
