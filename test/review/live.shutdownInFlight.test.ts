import { describe, expect, it } from "vitest";
import type { Clock, TimerCallback, TimerHandle } from "../../src/core/clock.js";
import type { Executor } from "../../src/core/contracts.js";
import type { FillResult, OrderRequest } from "../../src/core/types.js";
import { PaperExecutor } from "../../src/execution/paperExecutor.js";
import { ExitEventWatcher } from "../../src/exits/watcher.js";
import { RiskManager } from "../../src/risk/manager.js";
import { MemoryTradingStore } from "../../src/trader/memoryStore.js";
import { Trader } from "../../src/trader/trader.js";
import { MINT_A, T0, createEnv, createLaunch, signalFor, strategy, type TestEnv } from "../trader.fixtures.js";

function liveClockOver(env: TestEnv): Clock {
  return {
    virtual: false,
    nowMs: () => env.clock.nowMs(),
    schedule: (atMs: number, fn: TimerCallback): TimerHandle => env.clock.schedule(atMs, fn),
    cancel: (handle: TimerHandle) => env.clock.cancel(handle),
    sleepUntil: (atMs: number) => env.clock.sleepUntil(atMs)
  };
}

class SlowLandingExecutor implements Executor {
  readonly mode = "live" as const;
  inFlight = 0;

  constructor(
    private readonly inner: PaperExecutor,
    private readonly clock: Clock,
    private readonly settleAfterMs: number
  ) {}

  async execute(order: OrderRequest): Promise<FillResult> {
    this.inFlight += 1;
    try {
      const fill = await this.inner.execute(order);
      await this.clock.sleepUntil(this.clock.nowMs() + this.settleAfterMs);
      return fill;
    } finally {
      this.inFlight -= 1;
    }
  }
}

describe("review live: graceful shutdown abandons a live order that is still settling", () => {
  it("does not finish stopping the trader while a live buy can still land", async () => {
    const env = createEnv();
    const clock = liveClockOver(env);
    const config = strategy();
    const store = new MemoryTradingStore();
    const risk = new RiskManager({ runId: 1, config: config.risk, clock, mode: "paper", store });
    const executor = new SlowLandingExecutor(
      new PaperExecutor({ clock, market: env.source, config: config.execution, mode: "paper" }),
      clock,
      config.execution.fillTimeoutMs + 60_000
    );
    const trader = new Trader({
      runId: 1,
      mode: "live",
      clock,
      bus: env.bus,
      market: env.source,
      executor,
      shadowExecutor: null,
      risk,
      exits: config.exits,
      execution: config.execution,
      watcher: new ExitEventWatcher({ market: env.source, creationWindowSlots: config.scorer.bundleSlotWindow }),
      store,
      reconcile: null
    });
    trader.start();
    await createLaunch(env, MINT_A, T0);
    await env.clock.advanceTo(T0 + 5_000);
    trader.handleSignal(signalFor(env, MINT_A));
    await env.clock.advanceTo(T0 + 6_000);
    expect(executor.inFlight).toBe(1);
    let stopped = false;
    const stopping = trader.stop().then(() => {
      stopped = true;
    });
    await env.clock.advanceTo(T0 + 30_000);
    await Promise.resolve();
    const stoppedWithOrderInFlight = stopped && executor.inFlight > 0;
    const positionsKnownAtStop = store.positions.size;
    await env.clock.advanceTo(T0 + 200_000);
    await stopping;
    expect({ stoppedWithOrderInFlight, positionsKnownAtStop }).toEqual({ stoppedWithOrderInFlight: false, positionsKnownAtStop: 0 });
  });
});
