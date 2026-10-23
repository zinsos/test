import { describe, expect, it } from "vitest";
import type { Executor } from "../../src/core/contracts.js";
import type { FillAttempt, FillResult, OrderRequest } from "../../src/core/types.js";
import { failedFill, successfulFill } from "../../src/execution/fill.js";
import { PaperExecutor } from "../../src/execution/paperExecutor.js";
import { MINT_A, T0, buildTrader, createEnv, createLaunch, signalFor, strategy } from "../trader.fixtures.js";

const FAILED_ON_CHAIN_FEE = 305_000n;
const LANDED_FEE = 105_000n;

class RetriedThenUnconfirmedExecutor implements Executor {
  readonly mode = "live" as const;
  readonly settled = new Map<string, FillResult>();

  constructor(private readonly inner: PaperExecutor) {}

  async execute(order: OrderRequest): Promise<FillResult> {
    const simulated = await this.inner.execute(order);
    if (order.side !== "buy" || !simulated.success) {
      return simulated;
    }
    const failedAttempt: FillAttempt = { atMs: order.signalAtMs, slot: order.signalSlot, success: false, error: "slippage_exceeded", networkFee: FAILED_ON_CHAIN_FEE, tip: 0n };
    const unknownAttempt: FillAttempt = { atMs: order.signalAtMs + 1_200, slot: order.signalSlot + 3, success: false, error: "unconfirmed", networkFee: 0n, tip: 0n };
    const landedAttempt: FillAttempt = { atMs: order.signalAtMs + 1_200, slot: order.signalSlot + 3, success: true, error: null, networkFee: LANDED_FEE, tip: 0n };
    this.settled.set(
      "sig-late",
      successfulFill({
        order,
        amounts: simulated,
        quality: { fillPrice: simulated.fillPrice, slippageBps: simulated.slippageBps, priceImpactBps: simulated.priceImpactBps },
        attempts: [landedAttempt],
        filledAtMs: order.signalAtMs + 1_200,
        filledSlot: order.signalSlot + 3,
        rentPaid: simulated.rentPaid,
        rentRefunded: 0n,
        signature: "sig-late"
      })
    );
    return { ...failedFill(order, "unconfirmed", [failedAttempt, unknownAttempt], "curve"), signature: "sig-late" };
  }

  readonly reconcile = async (_order: OrderRequest, signature: string): Promise<FillResult | null> => this.settled.get(signature) ?? null;
}

describe("review money: reconciling an unconfirmed live fill drops the fees of earlier attempts", () => {
  it("charges the network fee of the attempt that failed on chain before the unconfirmed one", async () => {
    const env = createEnv();
    const config = strategy();
    const inner = new PaperExecutor({ clock: env.clock, market: env.source, config: config.execution });
    const executor = new RetriedThenUnconfirmedExecutor(inner);
    const { trader } = buildTrader(env, { config, executor, mode: "live", reconcile: executor.reconcile });
    await createLaunch(env, MINT_A, T0);
    await env.clock.advanceTo(T0 + 5_000);
    trader.handleSignal(signalFor(env, MINT_A));
    await env.clock.advanceTo(T0 + 30_000);
    const [position] = trader.primaryPositions();
    expect(position).toBeDefined();
    const landed = executor.settled.get("sig-late");
    const tradeAndRent = (landed?.userQuote ?? 0n) + (landed?.rentPaid ?? 0n);
    expect(position?.entryCost).toBe(tradeAndRent + LANDED_FEE + FAILED_ON_CHAIN_FEE);
  });
});
