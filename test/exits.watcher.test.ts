import { describe, expect, it, vi } from "vitest";
import {
  ExitEventWatcher,
  createTrackedExitCounter,
  creationWindowBuyers,
  groupFlowSince,
  historyCoversSlot,
  insiderWalletsOf,
  soldFraction
} from "../src/exits/watcher.js";
import { CREATED_SLOT, CREATOR, DEV, MINT, launchHarness } from "./exits.fixtures.js";

const OPEN_SLOT = CREATED_SLOT + 100;
const OPEN_AT_MS = 1_700_000_040_000;
const BUNDLER = "Bundler11111111111111111111111111111111111";
const LATE = "Late111111111111111111111111111111111111111";
const INSIDER = "Insider11111111111111111111111111111111111";
const ME = "Me11111111111111111111111111111111111111111";
const TOKENS = 1_000_000_000n;

function position(overrides: Partial<{ openedSlot: number; openedAtMs: number }> = {}) {
  return { mint: MINT, openedSlot: OPEN_SLOT, openedAtMs: OPEN_AT_MS, ...overrides };
}

function watcherFor(harness: ReturnType<typeof launchHarness>, extra: Partial<ConstructorParameters<typeof ExitEventWatcher>[0]> = {}) {
  return new ExitEventWatcher({ market: { launch: (mint) => harness.market.get(mint) }, creationWindowSlots: 1, ...extra });
}

describe("exit event watcher: dev sells", () => {
  it("measures dev sells since the position opened against holdings at open", () => {
    const harness = launchHarness();
    harness.trade(DEV, true, 100n * TOKENS, CREATED_SLOT);
    harness.trade(DEV, false, 30n * TOKENS, OPEN_SLOT + 5);
    expect(watcherFor(harness).eventsFor(position()).devSoldFraction).toBeCloseTo(0.3, 9);
  });

  it("ignores dev sells made before the position opened", () => {
    const harness = launchHarness();
    harness.trade(DEV, true, 100n * TOKENS, CREATED_SLOT);
    harness.trade(DEV, false, 50n * TOKENS, OPEN_SLOT - 10);
    expect(watcherFor(harness).eventsFor(position()).devSoldFraction).toBe(0);
    harness.trade(DEV, false, 25n * TOKENS, OPEN_SLOT + 1);
    expect(watcherFor(harness).eventsFor(position()).devSoldFraction).toBeCloseTo(0.5, 9);
  });

  it("counts sells in the opening slot", () => {
    const harness = launchHarness();
    harness.trade(DEV, true, 100n * TOKENS, CREATED_SLOT);
    harness.trade(DEV, false, 10n * TOKENS, OPEN_SLOT);
    expect(watcherFor(harness).eventsFor(position()).devSoldFraction).toBeCloseTo(0.1, 9);
  });

  it("treats the creator as a dev wallet as well", () => {
    const harness = launchHarness();
    harness.trade(DEV, true, 60n * TOKENS, CREATED_SLOT);
    harness.trade(CREATOR, true, 40n * TOKENS, CREATED_SLOT);
    harness.trade(CREATOR, false, 40n * TOKENS, OPEN_SLOT + 3);
    expect(watcherFor(harness).eventsFor(position()).devSoldFraction).toBeCloseTo(0.4, 9);
  });

  it("includes dev buys after the open in the basis and caps at one", () => {
    const harness = launchHarness();
    harness.trade(DEV, true, 50n * TOKENS, OPEN_SLOT + 1);
    harness.trade(DEV, false, 25n * TOKENS, OPEN_SLOT + 2);
    expect(watcherFor(harness).eventsFor(position()).devSoldFraction).toBeCloseTo(0.5, 9);
    expect(soldFraction({ heldAtOpen: 10n, boughtSince: 0n, soldSince: 30n })).toBe(1);
    expect(soldFraction({ heldAtOpen: 0n, boughtSince: 0n, soldSince: 30n })).toBe(0);
  });
});

describe("exit event watcher: insiders", () => {
  it("uses creation window buyers and launch insiders but not devs or late buyers", () => {
    const harness = launchHarness();
    harness.trade(DEV, true, 100n * TOKENS, CREATED_SLOT);
    harness.trade(BUNDLER, true, 100n * TOKENS, CREATED_SLOT + 1);
    harness.trade(LATE, true, 100n * TOKENS, CREATED_SLOT + 2);
    harness.trade(INSIDER, true, 100n * TOKENS, CREATED_SLOT + 20);
    harness.launch.insiders.add(INSIDER);
    expect([...creationWindowBuyers(harness.launch, 1)].sort()).toEqual([BUNDLER, DEV].sort());
    expect([...insiderWalletsOf(harness.launch, 1)].sort()).toEqual([BUNDLER, INSIDER].sort());
    harness.trade(LATE, false, 100n * TOKENS, OPEN_SLOT + 1);
    expect(watcherFor(harness).eventsFor(position()).insiderSoldFraction).toBe(0);
    harness.trade(BUNDLER, false, 60n * TOKENS, OPEN_SLOT + 2);
    expect(watcherFor(harness).eventsFor(position()).insiderSoldFraction).toBeCloseTo(0.3, 9);
  });

  it("adds injected insiders and drops excluded wallets", () => {
    const harness = launchHarness();
    harness.trade(ME, true, 100n * TOKENS, CREATED_SLOT + 1);
    harness.trade(LATE, true, 100n * TOKENS, CREATED_SLOT + 30);
    harness.trade(ME, false, 100n * TOKENS, OPEN_SLOT + 1);
    harness.trade(LATE, false, 50n * TOKENS, OPEN_SLOT + 1);
    const extraInsiders = vi.fn(() => [LATE]);
    const watcher = watcherFor(harness, { extraInsiders, excludeWallets: [ME] });
    expect(watcher.eventsFor(position()).insiderSoldFraction).toBeCloseTo(0.5, 9);
    expect(extraInsiders).toHaveBeenCalledWith(MINT);
  });

  it("widens the creation window with more slots", () => {
    const harness = launchHarness();
    harness.trade(LATE, true, 100n * TOKENS, CREATED_SLOT + 3);
    expect(creationWindowBuyers(harness.launch, 1).has(LATE)).toBe(false);
    expect(creationWindowBuyers(harness.launch, 3).has(LATE)).toBe(true);
  });
});

describe("exit event watcher: smart exits and edge cases", () => {
  it("passes the mint and open time to the smart exit counter and sanitises the result", () => {
    const harness = launchHarness();
    const smartExitCount = vi.fn(() => 2.7);
    expect(watcherFor(harness, { smartExitCount }).eventsFor(position()).smartWalletsExited).toBe(2);
    expect(smartExitCount).toHaveBeenCalledWith(MINT, OPEN_AT_MS);
    expect(watcherFor(harness, { smartExitCount: () => Number.NaN }).eventsFor(position()).smartWalletsExited).toBe(0);
    expect(watcherFor(harness, { smartExitCount: () => -3 }).eventsFor(position()).smartWalletsExited).toBe(0);
  });

  it("returns zero dev and insider fractions for unknown launches", () => {
    const watcher = new ExitEventWatcher({ market: { launch: () => undefined }, creationWindowSlots: 1, smartExitCount: () => 3 });
    expect(watcher.eventsFor(position())).toEqual({ devSoldFraction: 0, insiderSoldFraction: 0, smartWalletsExited: 3 });
  });

  it("refuses to attribute sells when the pre open history was truncated", () => {
    const harness = launchHarness(2);
    harness.trade(DEV, true, 100n * TOKENS, CREATED_SLOT);
    harness.trade(LATE, true, 100n * TOKENS, CREATED_SLOT + 5);
    harness.trade(DEV, false, 10n * TOKENS, CREATED_SLOT + 6);
    harness.trade(DEV, false, 10n * TOKENS, OPEN_SLOT + 1);
    expect(historyCoversSlot(harness.launch, OPEN_SLOT)).toBe(false);
    expect(groupFlowSince(harness.launch, new Set([DEV]), OPEN_SLOT)).toEqual({ heldAtOpen: 0n, boughtSince: 0n, soldSince: 0n });
    expect(historyCoversSlot(harness.launch, CREATED_SLOT + 5)).toBe(true);
  });

  it("counts tracked wallets that sold enough since a time", () => {
    const harness = launchHarness();
    const smartA = "SmartA1111111111111111111111111111111111111";
    const smartB = "SmartB1111111111111111111111111111111111111";
    const smartC = "SmartC1111111111111111111111111111111111111";
    harness.trade(smartA, true, 100n * TOKENS, CREATED_SLOT + 10, OPEN_AT_MS - 5000);
    harness.trade(smartB, true, 100n * TOKENS, CREATED_SLOT + 10, OPEN_AT_MS - 5000);
    harness.trade(smartC, true, 100n * TOKENS, CREATED_SLOT + 10, OPEN_AT_MS - 5000);
    harness.trade(LATE, true, 100n * TOKENS, CREATED_SLOT + 10, OPEN_AT_MS - 5000);
    harness.trade(smartA, false, 100n * TOKENS, OPEN_SLOT + 5, OPEN_AT_MS + 2000);
    harness.trade(smartB, false, 30n * TOKENS, OPEN_SLOT + 5, OPEN_AT_MS + 2000);
    harness.trade(smartC, false, 100n * TOKENS, CREATED_SLOT + 11, OPEN_AT_MS - 4000);
    harness.trade(LATE, false, 100n * TOKENS, OPEN_SLOT + 5, OPEN_AT_MS + 2000);
    const tracked = new Set([smartA, smartB, smartC]);
    const counter = createTrackedExitCounter({
      market: { launch: (mint) => harness.market.get(mint) },
      tracked: { isTracked: (wallet) => tracked.has(wallet) },
      minSoldFraction: 0.5
    });
    expect(counter(MINT, OPEN_AT_MS)).toBe(1);
    expect(counter("Unknown", OPEN_AT_MS)).toBe(0);
    const watcher = watcherFor(harness, { smartExitCount: counter });
    expect(watcher.eventsFor(position()).smartWalletsExited).toBe(1);
  });
});
