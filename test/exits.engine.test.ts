import { describe, expect, it } from "vitest";
import { maxPoolSellForImpact } from "../src/chain/amm.js";
import { maxSellTokensForImpact } from "../src/chain/curve.js";
import { evaluateExit } from "../src/exits/engine.js";
import { applyExitUpdates, readExitState } from "../src/exits/state.js";
import type { ExitContext, ExitDecision } from "../src/exits/types.js";
import {
  ENTRY_PRICE,
  ENTRY_TOKENS,
  MOONBAG_TOKENS,
  OPENED_AT_MS,
  OPENED_SLOT,
  atMultiple,
  curveView,
  exitConfig,
  exitContext,
  makePosition,
  poolView
} from "./exits.fixtures.js";

const SEC = 1000;

function only(decision: ExitDecision) {
  expect(decision.actions).toHaveLength(1);
  const action = decision.actions[0];
  if (!action) {
    throw new Error("missing action");
  }
  return action;
}

function evaluate(overrides: Partial<ExitContext>): ExitDecision {
  return evaluateExit(exitContext(overrides));
}

describe("exit engine: event exits", () => {
  it("sells everything on a dev sell at or above the minimum fraction", () => {
    const action = only(evaluate({ events: { devSoldFraction: 0.1, insiderSoldFraction: 0, smartWalletsExited: 0 } }));
    expect(action).toEqual({
      tokenAmount: ENTRY_TOKENS,
      reason: "dev_sold",
      urgency: "emergency",
      maxSlippageBps: 5000,
      closesPosition: true,
      finalChunk: true
    });
  });

  it("ignores dev sells below the minimum fraction", () => {
    expect(evaluate({ events: { devSoldFraction: 0.09, insiderSoldFraction: 0, smartWalletsExited: 0 } }).actions).toEqual([]);
  });

  it("ignores dev sells when dev sell exits are disabled", () => {
    const config = exitConfig({ events: { devSellExit: false } });
    expect(evaluate({ config, events: { devSoldFraction: 1, insiderSoldFraction: 0, smartWalletsExited: 0 } }).actions).toEqual([]);
  });

  it("does not fire on a zero sold fraction even when the threshold is zero", () => {
    const config = exitConfig({ events: { devSellMinFraction: 0, insiderSellExitFraction: 0 } });
    expect(evaluate({ config }).actions).toEqual([]);
  });

  it("exits when insiders sell at or above the threshold", () => {
    const action = only(evaluate({ events: { devSoldFraction: 0, insiderSoldFraction: 0.3, smartWalletsExited: 0 } }));
    expect(action.reason).toBe("insider_sold");
    expect(action.urgency).toBe("emergency");
    expect(evaluate({ events: { devSoldFraction: 0, insiderSoldFraction: 0.29, smartWalletsExited: 0 } }).actions).toEqual([]);
  });

  it("exits when enough tracked smart wallets exit and treats zero as disabled", () => {
    expect(only(evaluate({ events: { devSoldFraction: 0, insiderSoldFraction: 0, smartWalletsExited: 2 } })).reason).toBe("smart_exit");
    expect(evaluate({ events: { devSoldFraction: 0, insiderSoldFraction: 0, smartWalletsExited: 1 } }).actions).toEqual([]);
    const disabled = exitConfig({ events: { smartExitMinWallets: 0 } });
    expect(evaluate({ config: disabled, events: { devSoldFraction: 0, insiderSoldFraction: 0, smartWalletsExited: 9 } }).actions).toEqual([]);
  });

  it("sells the moonbag on an event exit", () => {
    const position = makePosition({ tokensHeld: MOONBAG_TOKENS, takeProfitLevelsHit: 4, peakPrice: atMultiple(12) });
    const action = only(
      evaluate({ position, price: atMultiple(11), events: { devSoldFraction: 0.5, insiderSoldFraction: 0, smartWalletsExited: 0 } })
    );
    expect(action.tokenAmount).toBe(MOONBAG_TOKENS);
    expect(action.closesPosition).toBe(true);
  });

  it("ranks dev sells above the hard stop and insiders and smart exits in order", () => {
    const all = { devSoldFraction: 1, insiderSoldFraction: 1, smartWalletsExited: 5 };
    expect(only(evaluate({ events: all, price: atMultiple(0.5) })).reason).toBe("dev_sold");
    expect(only(evaluate({ events: { ...all, devSoldFraction: 0 } })).reason).toBe("insider_sold");
  });
});

describe("exit engine: hard stop", () => {
  it("sells everything at entry times the stop multiple with emergency urgency", () => {
    const action = only(evaluate({ price: ENTRY_PRICE * 0.65 }));
    expect(action.reason).toBe("stop_loss");
    expect(action.urgency).toBe("emergency");
    expect(action.maxSlippageBps).toBe(5000);
    expect(action.tokenAmount).toBe(ENTRY_TOKENS);
  });

  it("does not fire just above the stop", () => {
    expect(evaluate({ price: ENTRY_PRICE * 0.66 }).actions).toEqual([]);
  });

  it("beats the time stop and the max hold", () => {
    const action = only(evaluate({ price: ENTRY_PRICE * 0.5, nowMs: OPENED_AT_MS + 4000 * SEC }));
    expect(action.reason).toBe("stop_loss");
  });

  it("sells the moonbag", () => {
    const position = makePosition({ tokensHeld: MOONBAG_TOKENS, takeProfitLevelsHit: 1, peakPrice: atMultiple(1.1) });
    const action = only(evaluate({ position, price: atMultiple(0.6) }));
    expect(action.tokenAmount).toBe(MOONBAG_TOKENS);
  });
});

describe("exit engine: migration", () => {
  it("sells everything on migration in exit mode and marks the migration", () => {
    const config = exitConfig({ migration: { action: "exit" } });
    const nowMs = OPENED_AT_MS + 60 * SEC;
    const decision = evaluate({ config, view: poolView(), nowMs });
    const action = only(decision);
    expect(action.reason).toBe("migration_exit");
    expect(action.urgency).toBe("normal");
    expect(action.tokenAmount).toBe(ENTRY_TOKENS);
    expect(decision.updates.migratedSeen).toBe(true);
    expect(decision.updates.migratedSeenAtMs).toBe(nowMs);
  });

  it("marks the migration in switch mode without selling", () => {
    const nowMs = OPENED_AT_MS + 60 * SEC;
    const decision = evaluate({ view: poolView(), nowMs });
    expect(decision.actions).toEqual([]);
    expect(decision.updates.migratedSeen).toBe(true);
    expect(decision.updates.migratedSeenAtMs).toBe(nowMs);
  });

  it("only acts on the first migration observation", () => {
    const config = exitConfig({ migration: { action: "exit" } });
    const position = makePosition({ migratedSeen: true });
    expect(evaluate({ config, view: poolView(), position }).actions).toEqual([]);
  });

  it("uses the migration trail fraction after a switch", () => {
    const position = makePosition({ migratedSeen: true, peakPrice: atMultiple(2) });
    expect(evaluate({ position, view: poolView(), price: atMultiple(1.5) }).actions).toEqual([]);
    const action = only(evaluate({ position, view: poolView(), price: atMultiple(1.39) }));
    expect(action.reason).toBe("trailing_stop");
    expect(action.tokenAmount).toBe(ENTRY_TOKENS - MOONBAG_TOKENS);
  });

  it("keeps curve trailing tiers in hold mode", () => {
    const config = exitConfig({ migration: { action: "hold" } });
    const position = makePosition({ migratedSeen: true, peakPrice: atMultiple(2) });
    expect(only(evaluate({ config, position, view: poolView(), price: atMultiple(1.5) })).reason).toBe("trailing_stop");
  });

  it("measures the post switch max hold from the migration", () => {
    const migratedAt = OPENED_AT_MS + 3000 * SEC;
    const position = applyExitUpdates(makePosition({ peakPrice: atMultiple(1.05) }), {
      peakPrice: atMultiple(1.05),
      lastPrice: atMultiple(1.05),
      takeProfitLevelsHit: 0,
      migratedSeen: true,
      migratedSeenAtMs: migratedAt,
      liquidating: null
    });
    const price = atMultiple(1.4);
    expect(evaluate({ position, view: poolView(), price, nowMs: OPENED_AT_MS + 3700 * SEC }).actions).toEqual([]);
    const action = only(evaluate({ position, view: poolView(), price, nowMs: migratedAt + 1800 * SEC }));
    expect(action.reason).toBe("migration_max_hold");
  });

  it("uses the plain max hold in hold mode", () => {
    const config = exitConfig({ migration: { action: "hold" } });
    const position = makePosition({ migratedSeen: true, peakPrice: atMultiple(1.05) });
    const action = only(evaluate({ config, position, view: poolView(), price: atMultiple(1.4), nowMs: OPENED_AT_MS + 3600 * SEC }));
    expect(action.reason).toBe("max_hold");
  });

  it("treats a position opened after the migration as already migrated", () => {
    const config = exitConfig({ migration: { action: "exit" } });
    const decision = evaluate({ config, view: poolView(), migratedSlot: OPENED_SLOT - 5 });
    expect(decision.actions).toEqual([]);
    expect(decision.updates.migratedSeen).toBe(true);
    expect(decision.updates.migratedSeenAtMs).toBe(OPENED_AT_MS);
  });

  it("holds actions after a post complete buy until the pool exists", () => {
    const postComplete = curveView({ venue: "curve_post_complete" });
    const decision = evaluate({ view: postComplete, price: atMultiple(0.5) });
    expect(decision.actions).toEqual([]);
    expect(decision.updates.liquidating?.reason).toBe("stop_loss");
  });

  it("holds actions while the curve is complete but not migrated and resumes after", () => {
    const completed = curveView({ complete: true, venue: "curve" });
    const waiting = evaluate({ view: completed, price: atMultiple(0.5) });
    expect(waiting.actions).toEqual([]);
    expect(waiting.updates.liquidating?.reason).toBe("stop_loss");
    const position = applyExitUpdates(makePosition(), waiting.updates);
    const resumed = only(evaluate({ position, view: poolView(), price: atMultiple(0.9) }));
    expect(resumed.reason).toBe("stop_loss");
    expect(resumed.urgency).toBe("emergency");
  });
});

describe("exit engine: take profit ladder", () => {
  it("sells half the entry at 2x to recover the stake", () => {
    const decision = evaluate({ price: atMultiple(2) });
    const action = only(decision);
    expect(action).toEqual({
      tokenAmount: ENTRY_TOKENS / 2n,
      reason: "take_profit",
      urgency: "normal",
      maxSlippageBps: 2000,
      closesPosition: false,
      finalChunk: true
    });
    expect(decision.updates.takeProfitLevelsHit).toBe(1);
  });

  it("sells the next partial at 3x", () => {
    const position = makePosition({ tokensHeld: ENTRY_TOKENS / 2n, takeProfitLevelsHit: 1, peakPrice: atMultiple(2.5) });
    const decision = evaluate({ position, price: atMultiple(3) });
    expect(only(decision).tokenAmount).toBe(1_500_000_000_000n);
    expect(decision.updates.takeProfitLevelsHit).toBe(2);
  });

  it("combines several levels crossed in one jump", () => {
    const decision = evaluate({ price: atMultiple(5.5) });
    expect(only(decision).tokenAmount).toBe(8_000_000_000_000n);
    expect(decision.updates.takeProfitLevelsHit).toBe(3);
  });

  it("never cuts into the moonbag", () => {
    const config = exitConfig({
      takeProfit: [
        { atMultiple: 2, sellFractionOfInitial: 0.6 },
        { atMultiple: 3, sellFractionOfInitial: 0.6 }
      ]
    });
    const position = makePosition({ tokensHeld: 4_000_000_000_000n, takeProfitLevelsHit: 1, peakPrice: atMultiple(2.5) });
    expect(only(evaluate({ config, position, price: atMultiple(3) })).tokenAmount).toBe(3_000_000_000_000n);
    const single = exitConfig({ takeProfit: [{ atMultiple: 2, sellFractionOfInitial: 1 }] });
    const action = only(evaluate({ config: single, price: atMultiple(2) }));
    expect(action.tokenAmount).toBe(ENTRY_TOKENS - MOONBAG_TOKENS);
    expect(action.closesPosition).toBe(false);
  });

  it("does nothing more once only the moonbag is left", () => {
    const position = makePosition({ tokensHeld: MOONBAG_TOKENS, takeProfitLevelsHit: 4, peakPrice: atMultiple(20) });
    const decision = evaluate({ position, price: atMultiple(20) });
    expect(decision.actions).toEqual([]);
    expect(decision.updates.takeProfitLevelsHit).toBe(4);
  });

  it("marks a level without selling when the position is already below its target", () => {
    const position = makePosition({ tokensHeld: MOONBAG_TOKENS, peakPrice: atMultiple(1.9) });
    const decision = evaluate({ position, price: atMultiple(2.05) });
    expect(decision.actions).toEqual([]);
    expect(decision.updates.takeProfitLevelsHit).toBe(1);
  });

  it("sorts unsorted ladder levels", () => {
    const config = exitConfig({
      takeProfit: [
        { atMultiple: 4, sellFractionOfInitial: 0.2 },
        { atMultiple: 2, sellFractionOfInitial: 0.3 }
      ]
    });
    const decision = evaluate({ config, price: atMultiple(2.1) });
    expect(only(decision).tokenAmount).toBe(3_000_000_000_000n);
    expect(decision.updates.takeProfitLevelsHit).toBe(1);
  });

  it("disables the ladder when no levels are configured", () => {
    const config = exitConfig({ takeProfit: [] });
    const decision = evaluate({ config, price: atMultiple(3) });
    expect(decision.actions).toEqual([]);
    expect(decision.updates.takeProfitLevelsHit).toBe(0);
  });
});

describe("exit engine: trailing stop", () => {
  it("is inactive below the first tier", () => {
    const position = makePosition({ peakPrice: atMultiple(1.25) });
    expect(evaluate({ position, price: atMultiple(0.9) }).actions).toEqual([]);
  });

  it("sells all non moonbag tokens at the first tier", () => {
    const position = makePosition({ peakPrice: atMultiple(1.5) });
    expect(evaluate({ position, price: atMultiple(1.13) }).actions).toEqual([]);
    const action = only(evaluate({ position, price: atMultiple(1.125) }));
    expect(action.reason).toBe("trailing_stop");
    expect(action.urgency).toBe("normal");
    expect(action.tokenAmount).toBe(ENTRY_TOKENS - MOONBAG_TOKENS);
    expect(action.closesPosition).toBe(false);
  });

  it.each([
    { peak: 2.5, holds: 1.96, fires: 1.95 },
    { peak: 3.5, holds: 2.88, fires: 2.87 },
    { peak: 6, holds: 5.11, fires: 5.1 }
  ])("tightens as the peak grows to $peak", ({ peak, holds, fires }) => {
    const position = makePosition({ tokensHeld: 3_000_000_000_000n, takeProfitLevelsHit: 3, peakPrice: atMultiple(peak) });
    expect(evaluate({ position, price: atMultiple(holds) }).actions).toEqual([]);
    expect(only(evaluate({ position, price: atMultiple(fires) })).reason).toBe("trailing_stop");
  });

  it("never loosens when a higher tier is configured looser", () => {
    const config = exitConfig({
      trailing: [
        { peakMultiple: 2, trailFraction: 0.2 },
        { peakMultiple: 3, trailFraction: 0.4 }
      ]
    });
    const position = makePosition({ tokensHeld: 3_000_000_000_000n, takeProfitLevelsHit: 2, peakPrice: atMultiple(4) });
    expect(only(evaluate({ config, position, price: atMultiple(3.2) })).reason).toBe("trailing_stop");
  });

  it("leaves the moonbag to its own wider trail", () => {
    const position = makePosition({ tokensHeld: MOONBAG_TOKENS, takeProfitLevelsHit: 2, peakPrice: atMultiple(4) });
    expect(evaluate({ position, price: atMultiple(3) }).actions).toEqual([]);
    expect(evaluate({ position, price: atMultiple(2.21) }).actions).toEqual([]);
    const action = only(evaluate({ position, price: atMultiple(2.2) }));
    expect(action.reason).toBe("moonbag_trail");
    expect(action.tokenAmount).toBe(MOONBAG_TOKENS);
    expect(action.closesPosition).toBe(true);
  });

  it("sells everything in a crash past the moonbag trail", () => {
    const position = makePosition({ peakPrice: atMultiple(2), takeProfitLevelsHit: 1, tokensHeld: ENTRY_TOKENS / 2n });
    const action = only(evaluate({ position, price: atMultiple(1) }));
    expect(action.reason).toBe("moonbag_trail");
    expect(action.tokenAmount).toBe(ENTRY_TOKENS / 2n);
  });

  it("tracks the peak", () => {
    expect(evaluate({ price: atMultiple(1.2) }).updates.peakPrice).toBe(atMultiple(1.2));
    const position = makePosition({ peakPrice: atMultiple(1.2) });
    expect(evaluate({ position, price: atMultiple(1.1) }).updates.peakPrice).toBe(atMultiple(1.2));
    expect(evaluate({ position, price: atMultiple(1.1) }).updates.lastPrice).toBe(atMultiple(1.1));
  });
});

describe("exit engine: time stops", () => {
  const afterTimeStop = OPENED_AT_MS + 300 * SEC;

  it("exits a flat position after the time stop", () => {
    const action = only(evaluate({ price: atMultiple(1.1), nowMs: afterTimeStop }));
    expect(action.reason).toBe("time_stop");
    expect(action.urgency).toBe("normal");
    expect(action.tokenAmount).toBe(ENTRY_TOKENS);
    expect(evaluate({ price: atMultiple(1.1), nowMs: afterTimeStop - 1 }).actions).toEqual([]);
  });

  it("only treats prices inside the flat band as flat", () => {
    expect(evaluate({ price: atMultiple(1.2), nowMs: afterTimeStop }).actions).toEqual([]);
    expect(only(evaluate({ price: atMultiple(0.86), nowMs: afterTimeStop })).reason).toBe("time_stop");
    expect(evaluate({ price: atMultiple(0.8), nowMs: afterTimeStop }).actions).toEqual([]);
  });

  it("skips the flat time stop once a take profit was hit", () => {
    const position = makePosition({ tokensHeld: ENTRY_TOKENS / 2n, takeProfitLevelsHit: 1, peakPrice: atMultiple(2) });
    const decision = evaluate({ position, price: atMultiple(1.6), nowMs: afterTimeStop });
    expect(decision.actions).toEqual([]);
  });

  it("does not time stop a moonbag", () => {
    const position = makePosition({ tokensHeld: MOONBAG_TOKENS, peakPrice: atMultiple(1.28) });
    expect(evaluate({ position, price: atMultiple(1.05), nowMs: afterTimeStop }).actions).toEqual([]);
  });

  it("enforces the max hold on everything including the moonbag", () => {
    const position = makePosition({ tokensHeld: MOONBAG_TOKENS, takeProfitLevelsHit: 4, peakPrice: atMultiple(12) });
    const action = only(evaluate({ position, price: atMultiple(11), nowMs: OPENED_AT_MS + 3600 * SEC }));
    expect(action.reason).toBe("max_hold");
    expect(action.tokenAmount).toBe(MOONBAG_TOKENS);
    expect(evaluate({ position, price: atMultiple(11), nowMs: OPENED_AT_MS + 3599 * SEC }).actions).toEqual([]);
  });
});

describe("exit engine: liquidity aware sizing", () => {
  const thinCurve = curveView({ virtualTokenReserves: 100_000_000_000_000n, virtualQuoteReserves: 5_000_000_000n });
  const flatLater = OPENED_AT_MS + 301 * SEC;

  it("caps a normal sell at the impact budget on the curve and keeps liquidating", () => {
    const capacity = maxSellTokensForImpact(thinCurve, 300);
    const decision = evaluate({ view: thinCurve, price: atMultiple(1.05), nowMs: flatLater });
    const action = only(decision);
    expect(action.tokenAmount).toBe(capacity);
    expect(action.finalChunk).toBe(false);
    expect(action.closesPosition).toBe(false);
    expect(decision.updates.liquidating).toMatchObject({ reason: "time_stop", urgency: "normal", closesPosition: true, targetTokens: 0n });
  });

  it("continues chunking on later evaluations even when the trigger no longer holds", () => {
    const first = evaluate({ view: thinCurve, price: atMultiple(1.05), nowMs: flatLater });
    const capacity = maxSellTokensForImpact(thinCurve, 300);
    let position = applyExitUpdates(makePosition({ tokensHeld: ENTRY_TOKENS - capacity }), first.updates);
    const second = evaluate({ position, view: thinCurve, price: atMultiple(1.25), nowMs: flatLater + 2 * SEC });
    expect(only(second).reason).toBe("time_stop");
    expect(only(second).tokenAmount).toBe(capacity);
    position = applyExitUpdates({ ...position, tokensHeld: ENTRY_TOKENS - 3n * capacity }, second.updates);
    const last = evaluate({ position, view: thinCurve, price: atMultiple(1.25), nowMs: flatLater + 4 * SEC });
    const action = only(last);
    expect(action.tokenAmount).toBe(ENTRY_TOKENS - 3n * capacity);
    expect(action.closesPosition).toBe(true);
    expect(action.finalChunk).toBe(true);
  });

  it("uses the wider emergency impact budget for emergencies", () => {
    const action = only(evaluate({ view: thinCurve, price: atMultiple(0.6) }));
    expect(action.tokenAmount).toBe(ENTRY_TOKENS);
    const veryThin = curveView({ virtualTokenReserves: 10_000_000_000_000n, virtualQuoteReserves: 500_000_000n });
    const capped = only(evaluate({ view: veryThin, price: atMultiple(0.6) }));
    expect(capped.tokenAmount).toBe(maxSellTokensForImpact(veryThin, 3000));
    expect(capped.urgency).toBe("emergency");
  });

  it("uses pool math after migration", () => {
    const pool = poolView({ virtualTokenReserves: 50_000_000_000_000n, virtualQuoteReserves: 2_500_000_000n });
    const position = makePosition({ migratedSeen: true });
    const action = only(evaluate({ position, view: pool, price: atMultiple(1.05), nowMs: flatLater }));
    expect(action.tokenAmount).toBe(maxPoolSellForImpact({ baseReserves: 50_000_000_000_000n, quoteReserves: 2_500_000_000n }, 300));
  });

  it("sells everything when the leftover after a chunk would be dust", () => {
    const capacity = maxSellTokensForImpact(thinCurve, 300);
    const position = makePosition({ tokensHeld: capacity + 100_000_000n });
    const action = only(evaluate({ position, view: thinCurve, price: atMultiple(1.05), nowMs: flatLater }));
    expect(action.tokenAmount).toBe(capacity + 100_000_000n);
    expect(action.closesPosition).toBe(true);
  });

  it("sells everything when even a full chunk is dust", () => {
    const config = exitConfig({ liquidity: { minChunkLamports: 1_000_000_000 } });
    const action = only(evaluate({ config, view: thinCurve, price: atMultiple(1.05), nowMs: flatLater }));
    expect(action.tokenAmount).toBe(ENTRY_TOKENS);
  });

  it("closes the whole position when the partial target left behind is dust", () => {
    const config = exitConfig({ liquidity: { minChunkLamports: 1_000_000_000 } });
    const position = makePosition({ peakPrice: atMultiple(1.5) });
    const decision = evaluate({ config, position, price: atMultiple(1.1) });
    const action = only(decision);
    expect(action.reason).toBe("trailing_stop");
    expect(action.tokenAmount).toBe(ENTRY_TOKENS);
    expect(action.closesPosition).toBe(true);
    expect(decision.updates.liquidating?.targetTokens).toBe(0n);
  });

  it("emits nothing without reserves but remembers the liquidation", () => {
    const empty = curveView({ virtualTokenReserves: 0n, virtualQuoteReserves: 0n });
    const decision = evaluate({ view: empty, price: atMultiple(0.5) });
    expect(decision.actions).toEqual([]);
    expect(decision.updates.liquidating?.reason).toBe("stop_loss");
  });
});

describe("exit engine: liquidation state", () => {
  const thinCurve = curveView({ virtualTokenReserves: 100_000_000_000_000n, virtualQuoteReserves: 5_000_000_000n });

  it("lets a stronger exit take over a partial liquidation", () => {
    const capacity = maxSellTokensForImpact(thinCurve, 300);
    const tp = evaluate({ view: thinCurve, price: atMultiple(2) });
    expect(only(tp).tokenAmount).toBe(capacity);
    expect(tp.updates.liquidating?.targetTokens).toBe(ENTRY_TOKENS / 2n);
    const position = applyExitUpdates(makePosition({ tokensHeld: ENTRY_TOKENS - capacity }), tp.updates);
    const crash = evaluate({ position, view: thinCurve, price: atMultiple(0.6) });
    const action = only(crash);
    expect(action.reason).toBe("stop_loss");
    expect(action.urgency).toBe("emergency");
    expect(action.tokenAmount).toBe(ENTRY_TOKENS - capacity);
    expect(crash.updates.liquidating).toMatchObject({ reason: "stop_loss", targetTokens: 0n });
  });

  it("keeps a full emergency liquidation when a weaker trigger appears", () => {
    const veryThin = curveView({ virtualTokenReserves: 10_000_000_000_000n, virtualQuoteReserves: 500_000_000n });
    const stop = evaluate({ view: veryThin, price: atMultiple(0.6) });
    const sold = maxSellTokensForImpact(veryThin, 3000);
    const position = applyExitUpdates(makePosition({ tokensHeld: ENTRY_TOKENS - sold }), stop.updates);
    const next = evaluate({ position, view: veryThin, price: atMultiple(2.5) });
    expect(only(next).reason).toBe("stop_loss");
    expect(next.updates.liquidating?.urgency).toBe("emergency");
  });

  it("clears the liquidation once the target is reached", () => {
    const tp = evaluate({ price: atMultiple(2) });
    const position = applyExitUpdates(makePosition({ tokensHeld: ENTRY_TOKENS / 2n }), tp.updates);
    const next = evaluate({ position, price: atMultiple(2.1) });
    expect(next.actions).toEqual([]);
    expect(next.updates.liquidating).toBeNull();
  });

  it("persists the liquidation through position meta as JSON", () => {
    const decision = evaluate({ view: thinCurve, price: atMultiple(0.6), sellInFlight: true });
    const position = applyExitUpdates(makePosition(), decision.updates);
    const roundTripped = JSON.parse(JSON.stringify(position.meta)) as Record<string, unknown>;
    const state = readExitState({ meta: roundTripped });
    expect(state.liquidating).toEqual(decision.updates.liquidating);
  });
});

describe("exit engine: sell in flight and guards", () => {
  it("never emits while a sell is in flight but records the decision", () => {
    const decision = evaluate({ price: atMultiple(0.5), sellInFlight: true });
    expect(decision.actions).toEqual([]);
    expect(decision.updates.liquidating?.reason).toBe("stop_loss");
  });

  it("marks ladder levels while in flight and sells them afterwards", () => {
    const inFlight = evaluate({ price: atMultiple(2), sellInFlight: true });
    expect(inFlight.actions).toEqual([]);
    expect(inFlight.updates.takeProfitLevelsHit).toBe(1);
    const position = applyExitUpdates(makePosition(), inFlight.updates);
    const after = evaluate({ position, price: atMultiple(1.9) });
    expect(only(after)).toMatchObject({ reason: "take_profit", tokenAmount: ENTRY_TOKENS / 2n });
    expect(after.updates.takeProfitLevelsHit).toBe(1);
  });

  it("does nothing for closed or empty positions", () => {
    expect(evaluate({ position: makePosition({ status: "closed" }), price: atMultiple(0.1) }).actions).toEqual([]);
    expect(evaluate({ position: makePosition({ tokensHeld: 0n }), price: atMultiple(0.1) }).actions).toEqual([]);
  });

  it("ignores unusable prices for price rules", () => {
    for (const price of [0, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const decision = evaluate({ price, nowMs: OPENED_AT_MS + 400 * SEC });
      expect(decision.actions).toEqual([]);
      expect(decision.updates.peakPrice).toBe(ENTRY_PRICE);
      expect(decision.updates.lastPrice).toBe(ENTRY_PRICE);
    }
    const event = evaluate({ price: 0, events: { devSoldFraction: 1, insiderSoldFraction: 0, smartWalletsExited: 0 } });
    expect(event.actions).toEqual([]);
    expect(event.updates.liquidating?.reason).toBe("dev_sold");
  });
});
