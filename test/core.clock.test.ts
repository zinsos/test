import { describe, expect, it } from "vitest";
import { VirtualClock } from "../src/core/clock.js";

describe("VirtualClock", () => {
  it("fires timers in time order and sets now to each timer", async () => {
    const clock = new VirtualClock(1_000);
    const fired: Array<[string, number]> = [];
    clock.schedule(3_000, () => {
      fired.push(["c", clock.nowMs()]);
    });
    clock.schedule(2_000, () => {
      fired.push(["a", clock.nowMs()]);
    });
    clock.schedule(2_000, () => {
      fired.push(["b", clock.nowMs()]);
    });
    await clock.advanceTo(2_500);
    expect(fired).toEqual([
      ["a", 2_000],
      ["b", 2_000]
    ]);
    expect(clock.nowMs()).toBe(2_500);
    await clock.advanceTo(10_000);
    expect(fired.map(([name]) => name)).toEqual(["a", "b", "c"]);
  });

  it("cancels timers and tracks pending count", async () => {
    const clock = new VirtualClock(0);
    const handle = clock.schedule(100, () => {
      throw new Error("should not fire");
    });
    clock.schedule(200, () => undefined);
    expect(clock.pendingCount()).toBe(2);
    clock.cancel(handle);
    expect(clock.pendingCount()).toBe(1);
    await clock.advanceTo(1_000);
    expect(clock.pendingCount()).toBe(0);
    expect(clock.drainErrors()).toEqual([]);
  });

  it("runs async continuations before later timers", async () => {
    const clock = new VirtualClock(0);
    const order: string[] = [];
    const task = async (): Promise<void> => {
      await clock.sleepUntil(100);
      order.push("after-sleep");
      await Promise.resolve();
      order.push("after-microtask");
      clock.schedule(150, () => {
        order.push("nested");
      });
    };
    void task();
    clock.schedule(200, () => {
      order.push("later");
    });
    await clock.advanceTo(300);
    expect(order).toEqual(["after-sleep", "after-microtask", "nested", "later"]);
  });

  it("schedules timers in the past at the current time", async () => {
    const clock = new VirtualClock(500);
    let seen = -1;
    clock.schedule(100, () => {
      seen = clock.nowMs();
    });
    await clock.advanceTo(600);
    expect(seen).toBe(500);
  });
});
