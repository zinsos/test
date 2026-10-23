import { describe, expect, it } from "vitest";
import type { Executor } from "../../src/core/contracts.js";
import type { FillResult, OrderRequest } from "../../src/core/types.js";
import type { Clock } from "../../src/core/clock.js";
import { failedFill } from "../../src/execution/fill.js";
import { MINT_A, MINT_B, T0, buildTrader, createEnv, createLaunch, flushMicrotasks, signalFor, strategy } from "../trader.fixtures.js";

class UnconfirmedLiveExecutor implements Executor {
  readonly mode = "live" as const;
  readonly orders: OrderRequest[] = [];

  constructor(private readonly clock: Clock, private readonly fillTimeoutMs: number) {}

  async execute(order: OrderRequest): Promise<FillResult> {
    this.orders.push(order);
    await this.clock.sleepUntil(this.clock.nowMs() + this.fillTimeoutMs);
    return { ...failedFill(order, "unconfirmed", [], "curve"), signature: `sig-${this.orders.length}` };
  }
}

describe("review money: risk reservations expire while a live entry is still being reconciled", () => {
  it("keeps counting an unresolved live buy against maxConcurrent", async () => {
    const env = createEnv();
    const config = strategy((c) => {
      c.risk.maxConcurrent = 1;
    });
    const executor = new UnconfirmedLiveExecutor(env.clock, config.execution.fillTimeoutMs);
    const reconcile = async (): Promise<FillResult | null> => null;
    const { trader, store } = buildTrader(env, { config, executor, mode: "live", reconcile });
    await createLaunch(env, MINT_A, T0);
    await createLaunch(env, MINT_B, T0 + 1_000);
    await env.clock.advanceTo(T0 + 5_000);
    trader.handleSignal(signalFor(env, MINT_A));
    await flushMicrotasks();
    await env.clock.advanceTo(T0 + 5_000 + 121_000);
    expect(trader.hasOpenPosition(MINT_A)).toBe(true);
    expect(trader.inFlightCount()).toBe(1);
    trader.handleSignal(signalFor(env, MINT_B));
    await flushMicrotasks();
    expect(store.signals.map((signal) => signal.skipReason)).toEqual([null, "max_concurrent"]);
    expect(executor.orders.filter((order) => order.side === "buy")).toHaveLength(1);
  });
});
