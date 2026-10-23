import { describe, expect, it } from "vitest";
import { quoteBuyExactQuoteIn, quoteSell } from "../src/chain/curve.js";
import {
  DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
  DEFAULT_INITIAL_VIRTUAL_QUOTE_RESERVES,
  DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES
} from "../src/core/constants.js";
import type { Executor } from "../src/core/contracts.js";
import type { FillResult, OrderRequest } from "../src/core/types.js";
import { failedFill } from "../src/execution/fill.js";
import { PaperExecutor } from "../src/execution/paperExecutor.js";
import { fractionOf } from "../src/exits/math.js";
import { ENTRY_FAILED_REASON } from "../src/trader/accounting.js";
import { KILL_SWITCH_REASON } from "../src/trader/trader.js";
import {
  MINT_A,
  MINT_B,
  MINT_C,
  PUMP_QUOTE,
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
const FEES = { protocolFeeBps: 95, creatorFeeBps: 30 };

function reservesOf(env: TestEnv, mint: string) {
  const launch = env.market.get(mint);
  if (!launch) {
    throw new Error("missing launch");
  }
  return {
    virtualTokenReserves: launch.virtualTokenReserves,
    virtualQuoteReserves: launch.virtualQuoteReserves,
    realTokenReserves: launch.realTokenReserves,
    realQuoteReserves: launch.realQuoteReserves
  };
}

class FakeLiveExecutor implements Executor {
  readonly mode = "live" as const;
  readonly orders: OrderRequest[] = [];
  private readonly settled = new Map<string, FillResult>();
  private counter = 0;

  constructor(
    private readonly inner: PaperExecutor,
    private readonly unconfirmedBuys: boolean
  ) {}

  async execute(order: OrderRequest): Promise<FillResult> {
    this.orders.push(order);
    this.counter += 1;
    const signature = `live-sig-${this.counter}`;
    const fill = { ...(await this.inner.execute({ ...order, positionId: `live-${order.positionId ?? "none"}` })), signature };
    if (this.unconfirmedBuys && order.side === "buy") {
      this.settled.set(signature, fill);
      return { ...failedFill(order, "unconfirmed", fill.attempts, fill.venue), signature };
    }
    return fill;
  }

  readonly reconcile = async (_order: OrderRequest, signature: string): Promise<FillResult | null> =>
    this.settled.get(signature) ?? null;
}

describe("trader happy path", () => {
  it("buys after latency, takes profit on the ladder, trails out and books exact fees", async () => {
    const env = createEnv();
    const { trader, store, risk } = buildTrader(env);
    await createLaunch(env, MINT_A, T0);
    await env.clock.advanceTo(T0 + 10_000);
    const preTrade = reservesOf(env, MINT_A);
    env.bus.emit("signal", signalFor(env, MINT_A));
    await flushMicrotasks();
    expect(store.signals).toHaveLength(1);
    expect(store.signals[0]?.acted).toBe(true);
    expect(trader.openPositions()).toHaveLength(0);

    await env.clock.advanceTo(T0 + 10_799);
    expect(trader.openPositions()).toHaveLength(0);
    await env.clock.advanceTo(T0 + 10_800);
    const [opened] = trader.openPositions();
    if (!opened) {
      throw new Error("position not opened");
    }
    const expectedBuy = quoteBuyExactQuoteIn(preTrade, SOL / 10n, FEES);
    expect(opened.entryTokens).toBe(expectedBuy.tokensOut);
    expect(opened.entryCost).toBe(expectedBuy.totalCost + NETWORK_FEE + RENT);
    expect(opened.openedAtMs).toBe(T0 + 10_800);
    expect(opened.signalId).toBe(store.signals[0]?.id);
    expect(opened.mode).toBe("paper");
    expect(opened.peakPrice).toBe(opened.entryPrice);
    expect(opened.entryPrice).toBeCloseTo(Number(expectedBuy.totalCost) / Number(expectedBuy.tokensOut), 15);

    await moveQuoteReserves(env, MINT_A, 44n * SOL, T0 + 20_000);
    const atTakeProfit = reservesOf(env, MINT_A);
    await env.clock.advanceTo(T0 + 20_800);
    const afterLadder = trader.openPositions()[0];
    const base = opened.entryTokens;
    const ladderTarget = base - fractionOf(base, 0.5);
    expect(afterLadder?.tokensHeld).toBe(ladderTarget);
    expect(afterLadder?.takeProfitLevelsHit).toBe(1);

    await moveQuoteReserves(env, MINT_A, 50n * SOL, T0 + 30_000);
    await env.clock.advanceTo(T0 + 30_800);
    expect(trader.openPositions()[0]?.tokensHeld).toBe(ladderTarget);

    await moveQuoteReserves(env, MINT_A, 41n * SOL, T0 + 40_000);
    const atTrail = reservesOf(env, MINT_A);
    await env.clock.advanceTo(T0 + 40_800);
    const moonbag = fractionOf(base, 0.1);
    expect(trader.openPositions()[0]?.tokensHeld).toBe(moonbag);

    await moveQuoteReserves(env, MINT_A, 36n * SOL, T0 + 50_000);
    const atMoonbag = reservesOf(env, MINT_A);
    await env.clock.advanceTo(T0 + 50_800);
    expect(trader.openPositions()).toHaveLength(0);

    const closed = store.positions.get(opened.id);
    expect(closed?.status).toBe("closed");
    expect(closed?.exitReason).toBe("moonbag_trail");
    expect(closed?.closedAtMs).toBe(T0 + 50_800);
    const fills = store.fillsFor(opened.id);
    expect(fills.map((entry) => entry.order.reason)).toEqual(["smart_convergence", "take_profit", "trailing_stop", "moonbag_trail"]);
    const sell1 = quoteSell(atTakeProfit, base - ladderTarget, FEES);
    const sell2 = quoteSell(atTrail, ladderTarget - moonbag, FEES);
    const sell3 = quoteSell(atMoonbag, moonbag, FEES);
    expect(fills[1]?.fill.userQuote).toBe(sell1.netQuote);
    expect(fills[2]?.fill.userQuote).toBe(sell2.netQuote);
    expect(fills[3]?.fill.userQuote).toBe(sell3.netQuote);
    expect(fills[3]?.fill.rentRefunded).toBe(RENT);
    const expectedProceeds = sell1.netQuote + sell2.netQuote + sell3.netQuote - 3n * NETWORK_FEE + RENT;
    expect(closed?.proceeds).toBe(expectedProceeds);
    const tradingFees =
      expectedBuy.protocolFee +
      expectedBuy.creatorFee +
      sell1.protocolFee +
      sell1.creatorFee +
      sell2.protocolFee +
      sell2.creatorFee +
      sell3.protocolFee +
      sell3.creatorFee;
    expect(closed?.feesPaid).toBe(tradingFees + 4n * NETWORK_FEE);
    const [trade] = store.closedTrades();
    expect(trade?.pnl).toBe(expectedProceeds - opened.entryCost);
    expect(trade?.holdSec).toBe(40);
    expect(trade?.peakMultiple).toBeGreaterThan(2.5);
    expect(risk.status().realizedPnlLamports).toBe(trade?.pnl);
    expect(fills.map((entry) => entry.position.meta.fillSeq)).toEqual([0, 1, 2, 3]);
  });
});

describe("trader entry gating", () => {
  it("records every skipped or rejected signal with its reason", async () => {
    const env = createEnv();
    const config = strategy((c) => {
      c.risk.maxConcurrent = 1;
    });
    const { trader, store } = buildTrader(env, { config });
    await createLaunch(env, MINT_A, T0);
    await createLaunch(env, MINT_B, T0 + 1_000);
    await createLaunch(env, MINT_C, T0 + 2_000, { quoteMint: PUMP_QUOTE });
    await env.clock.advanceTo(T0 + 5_000);
    trader.handleSignal(signalFor(env, MINT_A));
    trader.handleSignal(signalFor(env, MINT_B));
    trader.handleSignal(signalFor(env, MINT_C));
    trader.handleSignal(signalFor(env, "UnknownMint111111111111111111111111111111111"));
    trader.recordRejection(signalFor(env, MINT_B), "risk_too_high");
    await flushMicrotasks();
    expect(store.signals.map((signal) => [signal.acted, signal.skipReason])).toEqual([
      [true, null],
      [false, "max_concurrent"],
      [false, "quote_mint_not_tradable"],
      [false, "launch_not_in_memory"],
      [false, "risk_too_high"]
    ]);
    expect(trader.hasOpenPosition(MINT_A)).toBe(true);
    expect(trader.isBusy()).toBe(true);
    await env.clock.advanceTo(T0 + 6_000);
    expect(trader.primaryPositions()).toHaveLength(1);
  });

  it("skips launches whose stream had a gap, like the backtest does", async () => {
    const env = createEnv();
    const { trader, store } = buildTrader(env);
    await createLaunch(env, MINT_A, T0);
    await env.clock.advanceTo(T0 + 5_000);
    const launch = env.market.get(MINT_A);
    if (launch) {
      launch.dataComplete = false;
    }
    trader.handleSignal(signalFor(env, MINT_A));
    await flushMicrotasks();
    expect(store.signals.map((signal) => [signal.acted, signal.skipReason])).toEqual([[false, "incomplete_data"]]);
    expect(trader.hasOpenPosition(MINT_A)).toBe(false);
  });

  it("rejects a second entry on the same mint and the same dev", async () => {
    const env = createEnv();
    const { trader, store } = buildTrader(env);
    await createLaunch(env, MINT_A, T0);
    await createLaunch(env, MINT_B, T0 + 1_000, { devWallet: "DevAAAAAAAA", creator: "DevAAAAAAAA" });
    await env.clock.advanceTo(T0 + 5_000);
    trader.handleSignal(signalFor(env, MINT_A));
    await env.clock.advanceTo(T0 + 6_000);
    trader.handleSignal(signalFor(env, MINT_A));
    trader.handleSignal(signalFor(env, MINT_B));
    await flushMicrotasks();
    expect(store.signals.map((signal) => signal.skipReason)).toEqual([null, "already_holding_mint", "dev_daily_limit"]);
  });

  it("books a failed entry as a closed position that costs the network fees and frees the dev slot", async () => {
    const env = createEnv();
    const config = strategy((c) => {
      c.execution.failureRate = 1;
    });
    const { trader, store, risk } = buildTrader(env, { config });
    await createLaunch(env, MINT_A, T0);
    await env.clock.advanceTo(T0 + 5_000);
    trader.handleSignal(signalFor(env, MINT_A));
    await env.clock.advanceTo(T0 + 20_000);
    expect(trader.openPositions()).toHaveLength(0);
    const [failed] = store.closedPositions();
    expect(failed?.exitReason).toBe(ENTRY_FAILED_REASON);
    expect(failed?.entryCost).toBe(3n * NETWORK_FEE);
    expect(failed?.signalId).toBe(store.signals[0]?.id);
    expect(store.fillsFor(failed?.id ?? "")).toHaveLength(1);
    expect(risk.status().realizedPnlLamports).toBe(-3n * NETWORK_FEE);
    expect(trader.stats().entriesFailed).toBe(1);
    expect(trader.isBusy()).toBe(false);
    trader.handleSignal(signalFor(env, MINT_A));
    await flushMicrotasks();
    expect(store.signals[1]?.acted).toBe(true);
  });
});

describe("trader live mode with shadow", () => {
  it("keeps a paper shadow beside the live position and reconciles an unconfirmed live buy", async () => {
    const env = createEnv();
    const config = strategy();
    const liveInner = new PaperExecutor({ clock: env.clock, market: env.source, config: { ...config.execution, latencySlots: 1 } });
    const live = new FakeLiveExecutor(liveInner, true);
    const shadow = new PaperExecutor({ clock: env.clock, market: env.source, config: config.execution, mode: "shadow" });
    const { trader, store } = buildTrader(env, {
      mode: "live",
      config,
      executor: live,
      shadowExecutor: shadow,
      reconcile: live.reconcile
    });
    await createLaunch(env, MINT_A, T0);
    await env.clock.advanceTo(T0 + 10_000);
    env.bus.emit("signal", signalFor(env, MINT_A));
    await env.clock.advanceTo(T0 + 11_000);
    const shadowOnly = trader.openPositions();
    expect(shadowOnly).toHaveLength(1);
    expect(shadowOnly[0]?.mode).toBe("shadow");
    expect(trader.stats().unconfirmedFills).toBe(1);
    await env.clock.advanceTo(T0 + 21_000);
    const positions = trader.openPositions();
    expect(positions).toHaveLength(2);
    const livePosition = positions.find((position) => position.mode === "live");
    const shadowPosition = positions.find((position) => position.mode === "shadow");
    expect(livePosition).toBeDefined();
    expect(shadowPosition?.shadowOf).toBe(livePosition?.id);
    expect(trader.primaryPositions()).toHaveLength(1);
    await moveQuoteReserves(env, MINT_A, 44n * SOL, T0 + 30_000);
    await env.clock.advanceTo(T0 + 31_000);
    for (const position of trader.openPositions()) {
      expect(position.takeProfitLevelsHit).toBe(1);
      expect(position.tokensHeld).toBeLessThan(position.entryTokens);
    }
    expect(store.fillsFor(livePosition?.id ?? "")).toHaveLength(2);
    expect(store.fillsFor(shadowPosition?.id ?? "")).toHaveLength(2);
    expect(live.orders.map((order) => order.side)).toEqual(["buy", "sell"]);
  });
});

describe("trader risk protections", () => {
  it("flattens every position with an emergency sell when the kill switch trips", async () => {
    const env = createEnv();
    const config = strategy((c) => {
      c.risk.startingBankrollSol = 1;
      c.risk.fractionPerTrade = 0.1;
      c.risk.killSwitchDrawdownFraction = 0.01;
      c.risk.dailyLossLimitFraction = 0.5;
    });
    const { trader, store, risk } = buildTrader(env, { config });
    await createLaunch(env, MINT_A, T0);
    await moveQuoteReserves(env, MINT_A, 40n * SOL, T0 + 5_000);
    await env.clock.advanceTo(T0 + 10_000);
    trader.handleSignal(signalFor(env, MINT_A));
    await env.clock.advanceTo(T0 + 11_000);
    expect(trader.openPositions()).toHaveLength(1);
    expect(risk.isKilled()).toBe(false);
    await moveQuoteReserves(env, MINT_A, 36n * SOL, T0 + 20_000);
    expect(risk.isKilled()).toBe(true);
    await env.clock.advanceTo(T0 + 21_000);
    expect(trader.openPositions()).toHaveLength(0);
    const [closed] = store.closedPositions();
    expect(closed?.exitReason).toBe(KILL_SWITCH_REASON);
    const lastFill = store.fillsFor(closed?.id ?? "").at(-1);
    expect(lastFill?.order.urgency).toBe("emergency");
    expect(lastFill?.order.maxSlippageBps).toBe(config.execution.emergencySellSlippageBps);
    trader.handleSignal(signalFor(env, MINT_A));
    await flushMicrotasks();
    expect(store.signals.at(-1)?.skipReason).toBe("killed");
  });

  it("liquidates open positions at the current quote and restores positions after a restart", async () => {
    const env = createEnv();
    const first = buildTrader(env);
    await createLaunch(env, MINT_A, T0);
    await env.clock.advanceTo(T0 + 5_000);
    first.trader.handleSignal(signalFor(env, MINT_A));
    await env.clock.advanceTo(T0 + 6_000);
    const open = first.trader.openPositions();
    expect(open).toHaveLength(1);
    await first.trader.stop();

    const second = buildTrader(env);
    expect(second.trader.restore(open)).toBe(1);
    expect(second.trader.primaryPositions()).toHaveLength(1);
    expect(second.trader.liquidateAll("backtest_end")).toBe(1);
    const [closed] = second.store.closedPositions();
    expect(closed?.exitReason).toBe("backtest_end");
    expect(closed?.tokensHeld).toBe(0n);
    const sell = quoteSell(reservesOf(env, MINT_A), open[0]?.entryTokens ?? 0n, FEES);
    expect(closed?.proceeds).toBe(sell.netQuote - NETWORK_FEE + RENT);
    expect(second.risk.status().realizedPnlLamports).toBe((closed?.proceeds ?? 0n) - (closed?.entryCost ?? 0n));
  });

  it("uses the injected smart exit counter as an emergency exit trigger", async () => {
    const env = createEnv();
    let exited = 0;
    const { trader, store } = buildTrader(env, { smartExitCount: () => exited });
    await createLaunch(env, MINT_A, T0);
    await moveQuoteReserves(env, MINT_A, 32n * SOL, T0 + 2_000);
    await env.clock.advanceTo(T0 + 5_000);
    trader.handleSignal(signalFor(env, MINT_A));
    await env.clock.advanceTo(T0 + 6_000);
    exited = 2;
    await moveQuoteReserves(env, MINT_A, 33n * SOL, T0 + 7_000);
    await env.clock.advanceTo(T0 + 8_000);
    expect(store.closedPositions()[0]?.exitReason).toBe("smart_exit");
  });

  it("evaluates time stops on the clock timer without any trades", async () => {
    const env = createEnv();
    const { trader, store } = buildTrader(env);
    await createLaunch(env, MINT_A, T0);
    await env.clock.advanceTo(T0 + 5_000);
    trader.handleSignal(signalFor(env, MINT_A));
    await env.clock.advanceTo(T0 + 6_000);
    expect(trader.openPositions()).toHaveLength(1);
    await env.clock.advanceTo(T0 + 5_000 + 305_000 + 2_000);
    expect(store.closedPositions()[0]?.exitReason).toBe("time_stop");
  });
});

describe("trader fixtures sanity", () => {
  it("starts from the default pump curve", () => {
    const env = createEnv();
    expect(env.market.size).toBe(0);
    expect(DEFAULT_INITIAL_VIRTUAL_QUOTE_RESERVES).toBe(30n * SOL);
    expect(DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVES).toBeGreaterThan(DEFAULT_INITIAL_REAL_TOKEN_RESERVES);
  });
});
