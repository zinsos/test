import { describe, expect, it } from "vitest";
import { quotePoolBuyExactQuote, quotePoolSell } from "../src/chain/amm.js";
import { decodeLogs } from "../src/chain/events.js";
import { executionImpactBps, quoteBuyExactQuoteIn, quoteBuyExactTokens, quoteSell } from "../src/chain/curve.js";
import { createRng } from "../src/core/rng.js";
import type { TradeEvent } from "../src/core/types.js";
import { platformFeeOn, resolveCurveFees, resolvePoolFees } from "../src/execution/fees.js";
import {
  attemptCosts,
  budgetNetOfPlatformFee,
  computeTradeLeg,
  remainingSlippageBps,
  simulateAttempt,
  slippageVersusReference,
  type SimulateAttemptInput
} from "../src/execution/model.js";
import {
  SOL,
  constantRng,
  curveView,
  execConfig,
  fixture,
  initialReserves,
  order,
  poolView,
  spotPrice
} from "./execution.fixtures.js";

const PASS = constantRng(0.99);

function attempt(overrides: Partial<SimulateAttemptInput> = {}): ReturnType<typeof simulateAttempt> {
  return simulateAttempt({
    order: order(),
    view: curveView(),
    config: execConfig(),
    rng: PASS,
    attempt: 0,
    isFirstBuyOfPosition: false,
    ...overrides
  });
}

describe("fee resolution", () => {
  const defaults = execConfig();

  it("uses observed curve bps and falls back to defaults when unknown", () => {
    expect(resolveCurveFees({ protocolFeeBps: 93, creatorFeeBps: 0, lpFeeBps: -1 }, defaults)).toEqual({
      protocolFeeBps: 93,
      creatorFeeBps: 0
    });
    expect(resolveCurveFees({ protocolFeeBps: -1, creatorFeeBps: -1, lpFeeBps: -1 }, defaults)).toEqual({
      protocolFeeBps: defaults.defaultProtocolFeeBps,
      creatorFeeBps: defaults.defaultCreatorFeeBps
    });
    expect(resolveCurveFees({ protocolFeeBps: Number.NaN, creatorFeeBps: 12, lpFeeBps: -1 }, defaults).protocolFeeBps).toBe(
      defaults.defaultProtocolFeeBps
    );
  });

  it("resolves pool fees per component", () => {
    expect(resolvePoolFees({ protocolFeeBps: 5, creatorFeeBps: -1, lpFeeBps: 20 }, defaults)).toEqual({
      lpFeeBps: 20,
      protocolFeeBps: 5,
      creatorFeeBps: defaults.defaultPoolCreatorFeeBps
    });
    expect(resolvePoolFees({ protocolFeeBps: -1, creatorFeeBps: -1, lpFeeBps: -1 }, defaults)).toEqual({
      lpFeeBps: defaults.defaultPoolLpFeeBps,
      protocolFeeBps: defaults.defaultPoolProtocolFeeBps,
      creatorFeeBps: defaults.defaultPoolCreatorFeeBps
    });
  });

  it("rounds platform fees up and ignores non-positive inputs", () => {
    expect(platformFeeOn(1_000n, 100)).toBe(10n);
    expect(platformFeeOn(1_001n, 100)).toBe(11n);
    expect(platformFeeOn(0n, 100)).toBe(0n);
    expect(platformFeeOn(1_000n, 0)).toBe(0n);
  });

  it("nets the platform fee out of a budget so cost plus fee never exceeds it", () => {
    for (const budget of [1n, 99n, 10_001n, SOL, 7n * SOL + 3n]) {
      for (const bps of [0, 1, 50, 100, 333]) {
        const net = budgetNetOfPlatformFee(budget, bps);
        expect(net + platformFeeOn(net, bps)).toBeLessThanOrEqual(budget);
      }
    }
    expect(budgetNetOfPlatformFee(0n, 100)).toBe(0n);
    expect(budgetNetOfPlatformFee(SOL, 0)).toBe(SOL);
  });
});

describe("curve buys", () => {
  it("matches quoteBuyExactQuoteIn exactly without a platform fee", () => {
    const outcome = attempt();
    const expected = quoteBuyExactQuoteIn(initialReserves(), SOL / 10n, { protocolFeeBps: 95, creatorFeeBps: 30 });
    expect(outcome.success).toBe(true);
    expect(outcome.trade?.tokenAmount).toBe(expected.tokensOut);
    expect(outcome.trade?.quoteAmount).toBe(expected.netQuote);
    expect(outcome.trade?.protocolFee).toBe(expected.protocolFee);
    expect(outcome.trade?.creatorFee).toBe(expected.creatorFee);
    expect(outcome.trade?.userQuote).toBe(expected.totalCost);
    expect(outcome.trade?.extraPlatformFee).toBe(0n);
    expect(outcome.trade?.userQuote).toBeLessThanOrEqual(SOL / 10n);
  });

  it("spends the budget net of the platform fee and charges the fee on what was spent", () => {
    const config = execConfig({ extraPlatformFeeBps: 100 });
    const outcome = attempt({ config });
    const netBudget = budgetNetOfPlatformFee(SOL / 10n, 100);
    const expected = quoteBuyExactQuoteIn(initialReserves(), netBudget, { protocolFeeBps: 95, creatorFeeBps: 30 });
    expect(outcome.trade?.tokenAmount).toBe(expected.tokensOut);
    expect(outcome.trade?.extraPlatformFee).toBe(platformFeeOn(expected.totalCost, 100));
    expect(outcome.trade?.userQuote).toBe(expected.totalCost + platformFeeOn(expected.totalCost, 100));
    expect(outcome.trade?.userQuote).toBeLessThanOrEqual(SOL / 10n);
  });

  it("gets a worse price and larger impact for larger sizes and later curve positions", () => {
    const small = attempt({ order: order({ quoteBudget: SOL / 100n, maxSlippageBps: 10_000 }) });
    const large = attempt({ order: order({ quoteBudget: 5n * SOL, maxSlippageBps: 10_000 }) });
    expect(large.fillPrice).toBeGreaterThan(small.fillPrice ?? 0);
    expect(large.priceImpactBps).toBeGreaterThan(small.priceImpactBps ?? 0);
    const advanced = quoteBuyExactQuoteIn(initialReserves(), 20n * SOL, { protocolFeeBps: 95, creatorFeeBps: 30 }).after;
    const later = attempt({
      view: curveView({ ...advanced }),
      order: order({ quoteBudget: SOL / 100n, maxSlippageBps: 10_000 })
    });
    expect(later.trade?.tokenAmount).toBeLessThan(small.trade?.tokenAmount ?? 0n);
  });

  it("reports impact against the spot price before the trade", () => {
    const outcome = attempt({ order: order({ quoteBudget: 2n * SOL, maxSlippageBps: 10_000 }) });
    const trade = outcome.trade;
    if (!trade) {
      throw new Error("missing trade");
    }
    const execution = Number(trade.quoteAmount) / Number(trade.tokenAmount);
    expect(outcome.priceImpactBps).toBe(executionImpactBps(spotPrice(initialReserves()), execution));
    expect(outcome.priceImpactBps).toBeGreaterThan(500);
  });

  it("buys an exact token amount when no budget is given", () => {
    const tokens = 10_000_000_000_000n;
    const outcome = attempt({ order: order({ quoteBudget: null, tokenAmount: tokens }) });
    const expected = quoteBuyExactTokens(initialReserves(), tokens, { protocolFeeBps: 95, creatorFeeBps: 30 });
    expect(outcome.trade?.tokenAmount).toBe(tokens);
    expect(outcome.trade?.userQuote).toBe(expected.totalCost);
  });

  it("caps a buy at the real token reserves", () => {
    const nearlyDone = curveView({ realTokenReserves: 1_000_000n });
    const outcome = attempt({ view: nearlyDone, order: order({ quoteBudget: 10n * SOL, maxSlippageBps: 10_000 }) });
    expect(outcome.success).toBe(true);
    expect(outcome.trade?.tokenAmount).toBe(1_000_000n);
    expect(outcome.trade?.userQuote).toBeLessThan(10n * SOL);
  });

  it("reproduces the real mainnet SOL dev buy from the create reserves", () => {
    const events = decodeLogs(fixture("K48XDQLk").logs, { signature: "x", slot: 1, seq: 0, receivedAtMs: 0 }).events;
    const trade = events.find((event): event is TradeEvent => event.kind === "trade");
    if (!trade) {
      throw new Error("fixture trade missing");
    }
    const outcome = attempt({
      view: curveView({ protocolFeeBps: trade.protocolFeeBps, creatorFeeBps: trade.creatorFeeBps }),
      order: order({ quoteBudget: trade.userQuote, maxSlippageBps: 10_000 })
    });
    expect(outcome.trade?.tokenAmount).toBe(trade.tokenAmount);
    expect(outcome.trade?.quoteAmount).toBe(trade.quoteAmount);
    expect(outcome.trade?.protocolFee).toBe(trade.protocolFee);
    expect(outcome.trade?.creatorFee).toBe(trade.creatorFee);
    expect(outcome.trade?.userQuote).toBe(trade.userQuote);
  });
});

describe("curve sells", () => {
  const tokens = 30_000_000_000_000n;
  const afterBuy = quoteBuyExactQuoteIn(initialReserves(), 3n * SOL, { protocolFeeBps: 95, creatorFeeBps: 30 }).after;
  const view = curveView({ ...afterBuy });
  const reference = spotPrice(afterBuy);

  it("matches quoteSell and deducts the platform fee from proceeds", () => {
    const config = execConfig({ extraPlatformFeeBps: 100 });
    const outcome = attempt({
      view,
      config,
      order: order({ side: "sell", quoteBudget: null, tokenAmount: tokens, referencePrice: reference, maxSlippageBps: 2000 })
    });
    const expected = quoteSell(afterBuy, tokens, { protocolFeeBps: 95, creatorFeeBps: 30 });
    expect(outcome.success).toBe(true);
    expect(outcome.trade?.quoteAmount).toBe(expected.grossQuote);
    expect(outcome.trade?.extraPlatformFee).toBe(platformFeeOn(expected.netQuote, 100));
    expect(outcome.trade?.userQuote).toBe(expected.netQuote - platformFeeOn(expected.netQuote, 100));
    expect(outcome.slippageBps).toBeGreaterThan(0);
  });

  it("rejects sells without a token amount and zero-output sells", () => {
    const invalid = attempt({ view, order: order({ side: "sell", quoteBudget: SOL, tokenAmount: null }) });
    expect(invalid.error).toBe("invalid_order");
    expect(invalid.sent).toBe(false);
    expect(invalid.networkFee).toBe(0n);
    const dust = attempt({ view, order: order({ side: "sell", quoteBudget: null, tokenAmount: 1n, maxSlippageBps: 10_000 }) });
    expect(dust.error).toBe("no_liquidity");
  });
});

describe("slippage", () => {
  it("fails with slippage_exceeded when the fill is worse than the reference allows and still pays fees", () => {
    const config = execConfig();
    const outcome = attempt({ config, order: order({ referencePrice: spotPrice(initialReserves()) * 0.5, maxSlippageBps: 1500 }) });
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("slippage_exceeded");
    expect(outcome.sent).toBe(true);
    expect(outcome.slippageBps).toBeGreaterThan(1500);
    expect(outcome.networkFee).toBe(BigInt(config.baseFeeLamports + config.priorityFeeLamports));
    expect(outcome.rentPaid).toBe(0n);
    expect(outcome.fillPrice).toBeNull();
  });

  it("accepts a fill exactly at the limit and reports price improvement as negative slippage", () => {
    const probe = attempt({ order: order({ maxSlippageBps: 10_000 }) });
    const slip = probe.slippageBps ?? 0;
    expect(attempt({ order: order({ maxSlippageBps: slip }) }).success).toBe(true);
    expect(attempt({ order: order({ maxSlippageBps: slip - 1 }) }).error).toBe("slippage_exceeded");
    const improved = attempt({ order: order({ referencePrice: spotPrice(initialReserves()) * 2 }) });
    expect(improved.slippageBps).toBeLessThan(0);
  });

  it("measures sells as adverse when proceeds per token fall below the reference", () => {
    expect(slippageVersusReference("sell", 0.9, 1)).toBe(1000);
    expect(slippageVersusReference("buy", 1.1, 1)).toBe(1000);
    expect(slippageVersusReference("buy", 0.9, 1)).toBe(-1000);
    expect(slippageVersusReference("buy", 1, 0)).toBeNull();
    expect(slippageVersusReference("sell", Number.NaN, 1)).toBeNull();
  });

  it("skips the check when no reference price is known", () => {
    const outcome = attempt({ order: order({ referencePrice: 0, maxSlippageBps: 0 }) });
    expect(outcome.success).toBe(true);
    expect(outcome.slippageBps).toBeNull();
  });

  it("splits the remaining slippage budget so the on-chain bound matches the reference bound", () => {
    expect(remainingSlippageBps("buy", 1500, 1600)).toBeNull();
    expect(remainingSlippageBps("buy", 1500, 0)).toBe(Math.floor((0.15 / 1.15) * 10_000));
    expect(remainingSlippageBps("sell", 2000, 500)).toBe(Math.floor((0.15 / 0.95) * 10_000));
    expect(remainingSlippageBps("sell", 2000, -1000)).toBe(Math.floor((0.3 / 1.1) * 10_000));
    expect(remainingSlippageBps("sell", 10_000, 10_000)).toBe(10_000);
    expect(remainingSlippageBps("sell", 9_000, 10_000)).toBeNull();
    const buyBound = (1 + 0.05) * (1 + (remainingSlippageBps("buy", 1500, 500) ?? 0) / 10_000);
    expect(buyBound).toBeLessThanOrEqual(1.15 + 1e-9);
  });
});

describe("failures and costs", () => {
  it("fails with tx_failed when the draw is below the failure rate", () => {
    const config = execConfig({ failureRate: 0.12 });
    const failed = attempt({ config, rng: constantRng(0.05) });
    expect(failed.error).toBe("tx_failed");
    expect(failed.trade).not.toBeNull();
    expect(failed.networkFee).toBe(BigInt(config.baseFeeLamports + config.priorityFeeLamports));
    expect(attempt({ config, rng: constantRng(0.12) }).success).toBe(true);
  });

  it("produces the configured failure rate over many seeds", () => {
    for (const failureRate of [0, 0.12, 0.5, 1]) {
      const config = execConfig({ failureRate });
      let failures = 0;
      const runs = 4000;
      for (let seed = 0; seed < runs; seed += 1) {
        const outcome = attempt({ config, rng: createRng(`seed|${seed}`) });
        if (outcome.error === "tx_failed") {
          failures += 1;
        }
      }
      expect(Math.abs(failures / runs - failureRate)).toBeLessThan(0.025);
    }
  });

  it("charges base and priority fees on every sent attempt without Jito", () => {
    const config = execConfig({ useJito: false, baseFeeLamports: 5_000, priorityFeeLamports: 100_000 });
    expect(attemptCosts(config, true, true)).toEqual({ networkFee: 105_000n, tip: 0n });
    expect(attemptCosts(config, true, false)).toEqual({ networkFee: 105_000n, tip: 0n });
    expect(attemptCosts(config, false, false)).toEqual({ networkFee: 0n, tip: 0n });
  });

  it("charges nothing for failed Jito bundles and the tip on success", () => {
    const config = execConfig({ useJito: true, jitoTipLamports: 1_000_000, failureRate: 0.5 });
    const failed = attempt({ config, rng: constantRng(0.1) });
    expect(failed.error).toBe("tx_failed");
    expect(failed.networkFee).toBe(0n);
    expect(failed.tip).toBe(0n);
    const filled = attempt({ config, rng: constantRng(0.9) });
    expect(filled.success).toBe(true);
    expect(filled.tip).toBe(1_000_000n);
    expect(filled.networkFee).toBe(BigInt(config.baseFeeLamports + config.priorityFeeLamports));
  });

  it("pays token account rent on the first buy of a position only", () => {
    const config = execConfig({ ataRentLamports: 2_039_280 });
    expect(attempt({ config, isFirstBuyOfPosition: true }).rentPaid).toBe(2_039_280n);
    expect(attempt({ config, isFirstBuyOfPosition: false }).rentPaid).toBe(0n);
    expect(attempt({ config, isFirstBuyOfPosition: true, rng: constantRng(0) }).rentPaid).toBe(0n);
  });

  it("refunds rent on a closing sell only when configured", () => {
    const afterBuy = quoteBuyExactQuoteIn(initialReserves(), SOL, { protocolFeeBps: 95, creatorFeeBps: 30 }).after;
    const sell = order({ side: "sell", quoteBudget: null, tokenAmount: 1_000_000_000_000n, referencePrice: spotPrice(afterBuy) });
    const view = curveView({ ...afterBuy });
    expect(attempt({ view, order: { ...sell, closesPosition: true } }).rentRefunded).toBe(2_039_280n);
    expect(attempt({ view, order: { ...sell, closesPosition: false } }).rentRefunded).toBe(0n);
    expect(
      attempt({ view, order: { ...sell, closesPosition: true }, config: execConfig({ refundAtaOnClose: false }) }).rentRefunded
    ).toBe(0n);
    expect(attempt({ view, order: { ...sell, closesPosition: true }, isFirstBuyOfPosition: true }).rentPaid).toBe(0n);
  });
});

describe("venues", () => {
  it("fails a completed curve that has not migrated with curve_complete and charges the attempt", () => {
    const outcome = attempt({ view: curveView({ complete: true }) });
    expect(outcome.error).toBe("curve_complete");
    expect(outcome.sent).toBe(true);
    expect(outcome.networkFee).toBeGreaterThan(0n);
    expect(outcome.trade).toBeNull();
    expect(attempt({ view: curveView({ venue: "curve_post_complete" }) }).error).toBe("curve_complete");
  });

  it("refuses to price a migrated coin until pool reserves are known", () => {
    const outcome = attempt({ view: curveView({ migrated: true, complete: true }) });
    expect(outcome.error).toBe("pool_unavailable");
    expect(outcome.sent).toBe(false);
    expect(outcome.networkFee).toBe(0n);
  });

  it("prices a migrated coin from the post-complete reserves the pool opens with", () => {
    const view = poolView({ venue: "curve_post_complete", lpFeeBps: -1 });
    const outcome = attempt({ view, order: order({ referencePrice: spotPrice(view) }) });
    const expected = quotePoolBuyExactQuote(
      { baseReserves: view.virtualTokenReserves, quoteReserves: view.virtualQuoteReserves },
      SOL / 10n,
      { lpFeeBps: execConfig().defaultPoolLpFeeBps, protocolFeeBps: 93, creatorFeeBps: 30 }
    );
    expect(outcome.success).toBe(true);
    expect(outcome.venue).toBe("pool");
    expect(outcome.trade?.tokenAmount).toBe(expected.baseOut);
  });

  it("uses PumpSwap math with observed pool fees after migration", () => {
    const view = poolView();
    const reserves = { baseReserves: view.virtualTokenReserves, quoteReserves: view.virtualQuoteReserves };
    const fees = { lpFeeBps: 2, protocolFeeBps: 93, creatorFeeBps: 30 };
    const buy = attempt({ view, order: order({ referencePrice: spotPrice(view) }) });
    const expectedBuy = quotePoolBuyExactQuote(reserves, SOL / 10n, fees);
    expect(buy.success).toBe(true);
    expect(buy.venue).toBe("pool");
    expect(buy.trade?.tokenAmount).toBe(expectedBuy.baseOut);
    expect(buy.trade?.quoteAmount).toBe(expectedBuy.quoteIn);
    expect(buy.trade?.lpFee).toBe(expectedBuy.lpFee);
    expect(buy.trade?.userQuote).toBe(expectedBuy.totalCost);
    const sell = attempt({
      view,
      order: order({ side: "sell", quoteBudget: null, tokenAmount: 1_000_000_000_000n, referencePrice: spotPrice(view) })
    });
    const expectedSell = quotePoolSell(reserves, 1_000_000_000_000n, fees);
    expect(sell.trade?.quoteAmount).toBe(expectedSell.quoteOut);
    expect(sell.trade?.userQuote).toBe(expectedSell.netQuote);
    expect(sell.trade?.lpFee).toBe(expectedSell.lpFee);
  });

  it("falls back to default pool fees when none were observed", () => {
    const config = execConfig();
    const view = poolView({ lpFeeBps: -1, protocolFeeBps: -1, creatorFeeBps: -1 });
    const computed = computeTradeLeg(order(), view, config);
    if ("error" in computed) {
      throw new Error(computed.error);
    }
    const expected = quotePoolBuyExactQuote(
      { baseReserves: view.virtualTokenReserves, quoteReserves: view.virtualQuoteReserves },
      SOL / 10n,
      { lpFeeBps: config.defaultPoolLpFeeBps, protocolFeeBps: config.defaultPoolProtocolFeeBps, creatorFeeBps: config.defaultPoolCreatorFeeBps }
    );
    expect(computed.leg.tokenAmount).toBe(expected.baseOut);
  });

  it("rejects exact-token pool buys that would drain the pool", () => {
    const view = poolView();
    expect(attempt({ view, order: order({ quoteBudget: null, tokenAmount: view.virtualTokenReserves }) }).error).toBe("no_liquidity");
  });

  it("treats an empty curve view as having no liquidity", () => {
    expect(attempt({ view: curveView({ virtualTokenReserves: 0n }) }).error).toBe("no_liquidity");
  });
});
