import { describe, expect, it } from "vitest";
import type { VirtualClock } from "../src/core/clock.js";
import type { Executor } from "../src/core/contracts.js";
import type { FillAttempt, FillResult, OrderRequest } from "../src/core/types.js";
import { failedFill, successfulFill } from "../src/execution/fill.js";
import { PaperExecutor } from "../src/execution/paperExecutor.js";
import { EXTERNAL_EXIT_NOTE, EXTERNAL_EXIT_REASON, WALLET_BALANCE_FILL_NOTE } from "../src/trader/accounting.js";
import { PENDING_ENTRY_META } from "../src/trader/pending.js";
import {
  MINT_A,
  MINT_B,
  SOL,
  T0,
  buildTrader,
  createEnv,
  createLaunch,
  flushMicrotasks,
  moveQuoteReserves,
  signalFor,
  strategy,
  type TestEnv
} from "./trader.fixtures.js";

const NETWORK_FEE = 305_000n;
const RENT = 1_513_840n;

interface WalletExecutorOptions {
  clock: VirtualClock;
  inner: PaperExecutor;
  wallet?: Map<string, bigint>;
  readsBalances?: boolean;
  hide?: (order: OrderRequest, index: number) => boolean;
  landsWhenHidden?: boolean;
  settleDelayMs?: number;
  visibleAfterMs?: number;
}

class WalletExecutor implements Executor {
  readonly mode = "live" as const;
  readonly orders: OrderRequest[] = [];
  readonly wallet: Map<string, bigint>;
  readonly tokenBalance?: (mint: string) => Promise<bigint | null>;
  halted = false;

  constructor(private readonly options: WalletExecutorOptions) {
    this.wallet = options.wallet ?? new Map();
    if (options.readsBalances ?? true) {
      this.tokenBalance = async (mint: string) => this.visibleTokens(mint);
    }
  }

  halt(): void {
    this.halted = true;
  }

  sells(): OrderRequest[] {
    return this.orders.filter((order) => order.side === "sell");
  }

  async execute(order: OrderRequest): Promise<FillResult> {
    this.orders.push(order);
    const index = this.orders.length;
    if (this.halted) {
      return failedFill(order, "halted", [], "curve");
    }
    if (order.side === "sell" && this.visibleTokens(order.mint) <= 0n) {
      return failedFill(order, "no_balance", [], "curve");
    }
    const held = this.wallet.get(order.mint) ?? 0n;
    const request = order.side === "sell" && (order.tokenAmount ?? 0n) > held ? { ...order, tokenAmount: held } : order;
    const fill = await this.options.inner.execute(request);
    if (this.options.settleDelayMs) {
      await this.options.clock.sleepUntil(this.options.clock.nowMs() + this.options.settleDelayMs);
    }
    const hidden = this.options.hide?.(order, index) ?? false;
    if (fill.success && (!hidden || (this.options.landsWhenHidden ?? true))) {
      const delta = order.side === "buy" ? fill.tokenAmount : -fill.tokenAmount;
      this.wallet.set(order.mint, (this.wallet.get(order.mint) ?? 0n) + delta);
    }
    const signature = `sig-${index}`;
    if (!hidden) {
      return { ...fill, signature };
    }
    const sent = fill.attempts.at(-1);
    const unknown: FillAttempt = {
      atMs: sent?.atMs ?? order.signalAtMs,
      slot: sent?.slot ?? order.signalSlot,
      success: false,
      error: "unconfirmed",
      networkFee: 0n,
      tip: 0n
    };
    return { ...failedFill(order, "unconfirmed", [...fill.attempts.slice(0, -1), unknown], fill.venue), signature };
  }

  private visibleTokens(mint: string): bigint {
    return this.options.clock.nowMs() < (this.options.visibleAfterMs ?? 0) ? 0n : (this.wallet.get(mint) ?? 0n);
  }
}

function paper(env: TestEnv, config = strategy()): PaperExecutor {
  return new PaperExecutor({ clock: env.clock, market: env.source, config: config.execution });
}

const neverReconciles = async (): Promise<FillResult | null> => null;

async function openLivePosition(env: TestEnv, executor: WalletExecutor, config = strategy()) {
  const harness = buildTrader(env, { config, executor, mode: "live", reconcile: neverReconciles });
  await createLaunch(env, MINT_A, T0);
  await env.clock.advanceTo(T0 + 5_000);
  harness.trader.handleSignal(signalFor(env, MINT_A));
  await env.clock.advanceTo(T0 + 10_000);
  return harness;
}

describe("trader wallet reconciliation of live sells", () => {
  it("closes a position whose sell landed while its outcome stayed unknown, at the current quote, without selling again", async () => {
    const env = createEnv();
    const executor = new WalletExecutor({ clock: env.clock, inner: paper(env), hide: (order) => order.side === "sell" });
    const { trader, store, risk } = await openLivePosition(env, executor);
    const [opened] = trader.primaryPositions();
    expect(opened?.tokensHeld).toBe(executor.wallet.get(MINT_A));
    await moveQuoteReserves(env, MINT_A, 20n * SOL, T0 + 60_000);
    await env.clock.advanceTo(T0 + 3_600_000);
    expect(executor.wallet.get(MINT_A)).toBe(0n);
    expect(executor.sells()).toHaveLength(1);
    expect(trader.primaryPositions()).toHaveLength(0);
    const [closed] = store.closedPositions();
    expect(closed?.exitReason).toBe(EXTERNAL_EXIT_REASON);
    expect(closed?.tokensHeld).toBe(0n);
    expect(closed?.proceeds).toBeGreaterThan(0n);
    expect(store.fillsFor(closed?.id ?? "").map((entry) => entry.fill.error)).toEqual([null, "unconfirmed", EXTERNAL_EXIT_NOTE]);
    expect(risk.status().realizedPnlLamports).toBe((closed?.proceeds ?? 0n) - (closed?.entryCost ?? 0n));
    expect(risk.status().unrealizedPnlLamports).toBe(0n);
    expect(trader.stats().externalExits).toBe(1);
    expect(trader.isBusy()).toBe(false);
  });

  it("treats a no_balance refusal as an empty wallet when balances cannot be read, but only after the RPC lag guard", async () => {
    const env = createEnv();
    const executor = new WalletExecutor({
      clock: env.clock,
      inner: paper(env),
      readsBalances: false,
      hide: (order) => order.side === "sell"
    });
    const { trader, store } = await openLivePosition(env, executor);
    await moveQuoteReserves(env, MINT_A, 20n * SOL, T0 + 12_000);
    await env.clock.advanceTo(T0 + 3_600_000);
    expect(trader.primaryPositions()).toHaveLength(0);
    expect(store.closedPositions()[0]?.exitReason).toBe(EXTERNAL_EXIT_REASON);
    expect(executor.sells().length).toBeLessThanOrEqual(3);
  });

  it("keeps selling a fresh position whose tokens the RPC does not show yet instead of writing it off", async () => {
    const env = createEnv();
    const executor = new WalletExecutor({ clock: env.clock, inner: paper(env), visibleAfterMs: T0 + 25_000 });
    const { trader, store } = await openLivePosition(env, executor);
    await moveQuoteReserves(env, MINT_A, 20n * SOL, T0 + 12_000);
    await env.clock.advanceTo(T0 + 24_000);
    expect(trader.primaryPositions()).toHaveLength(1);
    expect(trader.stats().sellsFailed).toBeGreaterThan(0);
    await env.clock.advanceTo(T0 + 60_000);
    expect(trader.primaryPositions()).toHaveLength(0);
    const [closed] = store.closedPositions();
    expect(closed?.exitReason).not.toBe(EXTERNAL_EXIT_REASON);
    expect(executor.wallet.get(MINT_A)).toBe(0n);
    expect(trader.stats().externalExits).toBe(0);
  });
});

describe("trader live buys whose outcome stays unknown", () => {
  it("adopts the wallet balance when the buy landed, keeping the exposure reserved until then", async () => {
    const env = createEnv();
    const config = strategy((c) => {
      c.risk.maxConcurrent = 1;
    });
    const executor = new WalletExecutor({
      clock: env.clock,
      inner: paper(env, config),
      hide: (order) => order.side === "buy",
      settleDelayMs: 30_000
    });
    const { trader, store, risk } = buildTrader(env, { config, executor, mode: "live", reconcile: neverReconciles });
    await createLaunch(env, MINT_A, T0);
    await createLaunch(env, MINT_B, T0 + 1_000);
    await env.clock.advanceTo(T0 + 5_000);
    trader.handleSignal(signalFor(env, MINT_A));
    await flushMicrotasks();
    const [pendingRow] = store.pendingPositions();
    expect(pendingRow?.meta[PENDING_ENTRY_META]).toBeDefined();
    await env.clock.advanceTo(T0 + 5_000 + 125_000);
    expect(trader.primaryPositions()).toHaveLength(0);
    expect(trader.hasOpenPosition(MINT_A)).toBe(true);
    expect(trader.isBusy()).toBe(true);
    trader.handleSignal(signalFor(env, MINT_B));
    await flushMicrotasks();
    expect(store.signals.map((signal) => signal.skipReason)).toEqual([null, "max_concurrent"]);
    await env.clock.advanceTo(T0 + 300_000);
    const [position] = trader.primaryPositions();
    const budget = executor.orders[0]?.quoteBudget ?? 0n;
    expect(position?.id).toBe(pendingRow?.id);
    expect(position?.tokensHeld).toBe(executor.wallet.get(MINT_A));
    expect(position?.entryCost).toBe(budget + RENT + NETWORK_FEE);
    expect(position?.meta[PENDING_ENTRY_META]).toBeUndefined();
    expect(position?.signalId).toBe(store.signals[0]?.id);
    expect(store.pendingPositions()).toHaveLength(0);
    expect(store.fillsFor(position?.id ?? "")[0]?.fill.error).toBe(WALLET_BALANCE_FILL_NOTE);
    expect(risk.status().unrealizedPnlLamports).toBeLessThan(0n);
    expect(executor.orders.filter((order) => order.side === "buy")).toHaveLength(1);
  });

  it("releases the entry and drops its pending row when the wallet shows the buy never landed", async () => {
    const env = createEnv();
    const executor = new WalletExecutor({
      clock: env.clock,
      inner: paper(env),
      hide: (order) => order.side === "buy",
      landsWhenHidden: false
    });
    const { trader, store } = buildTrader(env, { executor, mode: "live", reconcile: neverReconciles });
    await createLaunch(env, MINT_A, T0);
    await env.clock.advanceTo(T0 + 5_000);
    trader.handleSignal(signalFor(env, MINT_A));
    await env.clock.advanceTo(T0 + 600_000);
    expect(trader.hasOpenPosition(MINT_A)).toBe(false);
    expect(trader.isBusy()).toBe(false);
    expect(store.positions.size).toBe(0);
    expect(trader.stats().entriesFailed).toBe(1);
  });

  it("keeps the network fees of attempts before the one that had to be reconciled", async () => {
    const env = createEnv();
    const config = strategy();
    const inner = paper(env, config);
    const settled = new Map<string, FillResult>();
    const failedOnChain: FillAttempt = { atMs: T0 + 5_000, slot: 1, success: false, error: "slippage_exceeded", networkFee: NETWORK_FEE, tip: 0n };
    const executor: Executor = {
      mode: "live",
      execute: async (order) => {
        const fill = await inner.execute(order);
        if (order.side !== "buy") {
          return fill;
        }
        const landed: FillAttempt = { atMs: T0 + 6_000, slot: 2, success: true, error: null, networkFee: 105_000n, tip: 0n };
        settled.set("sig-late", successfulFill({ order, amounts: fill, quality: fill, attempts: [landed], filledAtMs: T0 + 6_000, filledSlot: 2, rentPaid: RENT, rentRefunded: 0n, signature: "sig-late" }));
        const unknown: FillAttempt = { ...landed, success: false, error: "unconfirmed", networkFee: 0n };
        return { ...failedFill(order, "unconfirmed", [failedOnChain, unknown], "curve"), signature: "sig-late" };
      }
    };
    const { trader } = buildTrader(env, { config, executor, mode: "live", reconcile: async (_order, signature) => settled.get(signature) ?? null });
    await createLaunch(env, MINT_A, T0);
    await env.clock.advanceTo(T0 + 5_000);
    trader.handleSignal(signalFor(env, MINT_A));
    await env.clock.advanceTo(T0 + 30_000);
    const [position] = trader.primaryPositions();
    const landed = settled.get("sig-late");
    expect(position?.entryCost).toBe((landed?.userQuote ?? 0n) + RENT + 105_000n + NETWORK_FEE);
    expect(position?.feesPaid).toBe((landed?.protocolFee ?? 0n) + (landed?.creatorFee ?? 0n) + 105_000n + NETWORK_FEE);
  });
});

describe("trader shutdown and restart in live mode", () => {
  it("halts sends on stop and lets the next process resolve the persisted pending entry from the wallet", async () => {
    const env = createEnv();
    const config = strategy((c) => {
      c.risk.maxConcurrent = 1;
    });
    const wallet = new Map<string, bigint>();
    const first = new WalletExecutor({
      clock: env.clock,
      inner: paper(env, config),
      wallet,
      hide: (order) => order.side === "buy",
      settleDelayMs: 40_000
    });
    const old = buildTrader(env, { config, executor: first, mode: "live", reconcile: neverReconciles });
    await createLaunch(env, MINT_A, T0);
    await createLaunch(env, MINT_B, T0 + 1_000);
    await env.clock.advanceTo(T0 + 5_000);
    old.trader.handleSignal(signalFor(env, MINT_A));
    await flushMicrotasks();
    expect(old.store.flushes).toBeGreaterThan(0);
    await env.clock.advanceTo(T0 + 8_000);
    await old.trader.stop();
    expect(first.halted).toBe(true);
    const pendingRows = old.store.pendingPositions();
    expect(pendingRows).toHaveLength(1);
    await env.clock.advanceTo(T0 + 60_000);
    expect(wallet.get(MINT_A)).toBeGreaterThan(0n);
    expect(old.store.openPositions()).toHaveLength(0);

    const next = new WalletExecutor({ clock: env.clock, inner: paper(env, config), wallet });
    const resumed = buildTrader(env, { config, executor: next, mode: "live", reconcile: neverReconciles });
    expect(resumed.trader.restore(pendingRows)).toBe(1);
    expect(resumed.trader.isBusy()).toBe(true);
    resumed.trader.handleSignal(signalFor(env, MINT_B));
    await flushMicrotasks();
    expect(resumed.store.signals.map((signal) => signal.skipReason)).toEqual(["max_concurrent"]);
    await env.clock.advanceTo(T0 + 250_000);
    const [adopted] = resumed.trader.primaryPositions();
    expect(adopted?.id).toBe(pendingRows[0]?.id);
    expect(adopted?.tokensHeld).toBe(wallet.get(MINT_A));
    expect(adopted?.status).toBe("open");
    expect(resumed.store.fillsFor(adopted?.id ?? "")[0]?.fill.error).toBe(WALLET_BALANCE_FILL_NOTE);
    expect(next.orders).toHaveLength(0);
  });

  it("drops a persisted pending entry on restart when the wallet never received the tokens", async () => {
    const env = createEnv();
    const wallet = new Map<string, bigint>();
    await createLaunch(env, MINT_A, T0);
    await env.clock.advanceTo(T0 + 5_000);
    const stuck = new WalletExecutor({ clock: env.clock, inner: paper(env), wallet, settleDelayMs: 1_000_000, hide: () => true, landsWhenHidden: false });
    const crashed = buildTrader(env, { executor: stuck, mode: "live", reconcile: neverReconciles });
    crashed.trader.handleSignal(signalFor(env, MINT_A));
    await flushMicrotasks();
    crashed.trader.halt();
    const pendingRows = crashed.store.pendingPositions();
    expect(pendingRows).toHaveLength(1);
    const restarted = buildTrader(env, { executor: new WalletExecutor({ clock: env.clock, inner: paper(env), wallet }), mode: "live", reconcile: neverReconciles });
    for (const row of pendingRows) {
      restarted.store.savePosition(row);
    }
    expect(restarted.trader.restore(pendingRows)).toBe(1);
    await env.clock.advanceTo(T0 + 120_000);
    expect(restarted.trader.hasOpenPosition(MINT_A)).toBe(true);
    await env.clock.advanceTo(T0 + 400_000);
    expect(restarted.trader.hasOpenPosition(MINT_A)).toBe(false);
    expect(restarted.store.positions.size).toBe(0);
  });

  it("books tokens that left the wallet while the process was down when it restores an open position", async () => {
    const env = createEnv();
    const wallet = new Map<string, bigint>();
    const before = new WalletExecutor({ clock: env.clock, inner: paper(env), wallet });
    const old = await openLivePosition(env, before);
    const [open] = old.trader.primaryPositions();
    await old.trader.stop();
    const held = open?.tokensHeld ?? 0n;
    wallet.set(MINT_A, held / 4n);
    await env.clock.advanceTo(T0 + 120_000);
    const after = new WalletExecutor({ clock: env.clock, inner: paper(env), wallet });
    const resumed = buildTrader(env, { executor: after, mode: "live", reconcile: neverReconciles });
    expect(resumed.trader.restore(open ? [open] : [])).toBe(1);
    await flushMicrotasks();
    const [position] = resumed.trader.primaryPositions();
    expect(position?.tokensHeld).toBe(held / 4n);
    expect(position?.proceeds).toBeGreaterThan(0n);
    expect(resumed.trader.stats().externalExits).toBe(1);
    expect(resumed.store.fillsFor(position?.id ?? "").at(-1)?.fill.error).toBe(EXTERNAL_EXIT_NOTE);
  });
});

describe("trader busy state", () => {
  it("does not report busy for the sweeper when only a paper shadow position is open", async () => {
    const env = createEnv();
    const config = strategy();
    const rejecting: Executor = { mode: "live", execute: async (order) => failedFill(order, "slippage_exceeded", [], "curve") };
    const shadow = new PaperExecutor({ clock: env.clock, market: env.source, config: config.execution, mode: "shadow" });
    const { trader } = buildTrader(env, { config, executor: rejecting, shadowExecutor: shadow, mode: "live" });
    await createLaunch(env, MINT_A, T0);
    await env.clock.advanceTo(T0 + 5_000);
    trader.handleSignal(signalFor(env, MINT_A));
    await env.clock.advanceTo(T0 + 10_000);
    expect(trader.primaryPositions()).toHaveLength(0);
    expect(trader.openPositions()).toHaveLength(1);
    expect(trader.isBusy()).toBe(false);
  });
});
