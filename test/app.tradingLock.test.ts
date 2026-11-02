import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { advisoryLockKey, TradingLock } from "../src/app/tradingLock.js";
import { VirtualClock } from "../src/core/clock.js";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./helpers/db.js";

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) {
      throw new Error("condition not reached");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("advisoryLockKey", () => {
  it("is a stable signed 32-bit key per name", () => {
    expect(advisoryLockKey("snypra-edge:trader:paper")).toBe(advisoryLockKey("snypra-edge:trader:paper"));
    expect(advisoryLockKey("snypra-edge:trader:paper")).not.toBe(advisoryLockKey("snypra-edge:trader:live"));
    expect(Number.isInteger(advisoryLockKey("x"))).toBe(true);
    expect(Math.abs(advisoryLockKey("x"))).toBeLessThanOrEqual(2 ** 31);
  });
});

describe.skipIf(!hasTestDatabase)("TradingLock", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("trading_lock");
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("lets only one holder trade and hands over when the holder releases", async () => {
    const clock = new VirtualClock(0);
    const first = new TradingLock({ db: database.db, name: "test-lock", clock, retryMs: 1_000 });
    const second = new TradingLock({ db: database.db, name: "test-lock", clock, retryMs: 1_000 });
    expect(await first.acquire()).toBe(true);
    expect(first.held()).toBe(true);
    let acquired: boolean | null = null;
    const waiting = second.acquire().then((result) => {
      acquired = result;
    });
    await waitFor(() => clock.pendingCount() > 0);
    await clock.advanceTo(1_000);
    await waitFor(() => clock.pendingCount() > 0);
    expect(acquired).toBeNull();
    await first.release();
    expect(first.held()).toBe(false);
    await clock.advanceTo(2_000);
    await waiting;
    expect(acquired).toBe(true);
    expect(second.held()).toBe(true);
    await second.release();
  });

  it("gives up waiting when asked to stop", async () => {
    const clock = new VirtualClock(0);
    const holder = new TradingLock({ db: database.db, name: "stop-lock", clock });
    expect(await holder.acquire()).toBe(true);
    let stop = false;
    const waiter = new TradingLock({ db: database.db, name: "stop-lock", clock, retryMs: 500 });
    const result = waiter.acquire(() => stop);
    await waitFor(() => clock.pendingCount() > 0);
    stop = true;
    await clock.advanceTo(500);
    expect(await result).toBe(false);
    await holder.release();
    await waiter.release();
  });
});
