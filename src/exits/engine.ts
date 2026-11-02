import type { CurveView, OrderUrgency } from "../core/types.js";
import { planChunk } from "./liquidity.js";
import { isUsablePrice, valueAtPrice } from "./math.js";
import {
  eventTrigger,
  hardStopTrigger,
  migrationStep,
  moonbagTokensOf,
  takeProfitStep,
  timeTriggers,
  trailingTriggers,
  type RuleInput
} from "./rules.js";
import { readExitState } from "./state.js";
import type {
  ExitAction,
  ExitContext,
  ExitDecision,
  ExitTrigger,
  LiquidationState,
  PositionUpdates
} from "./types.js";

function urgencyRank(urgency: OrderUrgency): number {
  return urgency === "emergency" ? 1 : 0;
}

function moreUrgent(a: OrderUrgency, b: OrderUrgency): OrderUrgency {
  return urgencyRank(a) >= urgencyRank(b) ? a : b;
}

export function strongestTrigger(triggers: readonly (ExitTrigger | null)[]): ExitTrigger | null {
  let best: ExitTrigger | null = null;
  for (const trigger of triggers) {
    if (trigger && (!best || trigger.targetTokens < best.targetTokens)) {
      best = trigger;
    }
  }
  return best;
}

function liquidationFrom(trigger: ExitTrigger, price: number, minChunkLamports: number, nowMs: number): LiquidationState {
  const dustTarget = trigger.targetTokens > 0n && valueAtPrice(trigger.targetTokens, price) < BigInt(minChunkLamports);
  const targetTokens = dustTarget ? 0n : trigger.targetTokens;
  return {
    reason: trigger.reason,
    urgency: trigger.urgency,
    closesPosition: targetTokens === 0n,
    targetTokens,
    startedAtMs: nowMs
  };
}

export function mergeLiquidation(active: LiquidationState | null, candidate: LiquidationState | null): LiquidationState | null {
  if (!active) {
    return candidate;
  }
  if (!candidate) {
    return active;
  }
  const urgency = moreUrgent(active.urgency, candidate.urgency);
  const candidateWins =
    candidate.targetTokens < active.targetTokens ||
    (candidate.targetTokens === active.targetTokens && urgencyRank(candidate.urgency) > urgencyRank(active.urgency));
  return candidateWins ? { ...candidate, urgency } : { ...active, urgency };
}

function stillLiquidating(liquidation: LiquidationState | null, tokensHeld: bigint): LiquidationState | null {
  return liquidation && tokensHeld > liquidation.targetTokens ? liquidation : null;
}

export function awaitingMigration(view: Pick<CurveView, "complete" | "migrated" | "venue">): boolean {
  return !view.migrated && (view.complete || view.venue === "curve_post_complete");
}

function actionFor(ctx: ExitContext, liquidation: LiquidationState): ExitAction | null {
  const tokensHeld = ctx.position.tokensHeld;
  const plan = planChunk(tokensHeld - liquidation.targetTokens, ctx.view, ctx.price, liquidation.urgency, ctx.config.liquidity);
  if (!plan) {
    return null;
  }
  const tokenAmount = plan.tokenAmount > tokensHeld ? tokensHeld : plan.tokenAmount;
  return {
    tokenAmount,
    reason: liquidation.reason,
    urgency: liquidation.urgency,
    maxSlippageBps:
      liquidation.urgency === "emergency" ? ctx.execution.emergencySellSlippageBps : ctx.execution.sellSlippageBps,
    closesPosition: tokenAmount >= tokensHeld,
    finalChunk: plan.finalChunk
  };
}

function canAct(ctx: ExitContext): boolean {
  return !ctx.sellInFlight && !awaitingMigration(ctx.view) && isUsablePrice(ctx.price);
}

export function evaluateExit(ctx: ExitContext): ExitDecision {
  const { position, config, nowMs } = ctx;
  const priceUsable = isUsablePrice(ctx.price);
  const prior = readExitState(position);
  const migration = migrationStep(position, ctx.view, prior, config, nowMs, ctx.migratedSlot ?? null);
  const moonbagTokens = moonbagTokensOf(position, config);
  const ladder = takeProfitStep(position, ctx.price, config, moonbagTokens);
  const updates: PositionUpdates = {
    peakPrice: priceUsable ? Math.max(position.peakPrice, ctx.price) : position.peakPrice,
    lastPrice: priceUsable ? ctx.price : position.lastPrice,
    takeProfitLevelsHit: ladder.levelsHit,
    migratedSeen: migration.migratedSeen,
    migratedSeenAtMs: migration.migratedSeenAtMs,
    liquidating: null
  };
  if (position.status !== "open" || position.tokensHeld <= 0n) {
    return { actions: [], updates };
  }
  const input: RuleInput = {
    position,
    price: ctx.price,
    nowMs,
    config,
    peakPrice: updates.peakPrice,
    takeProfitLevelsHit: ladder.levelsHit,
    migratedSeen: migration.migratedSeen,
    migratedSeenAtMs: migration.migratedSeenAtMs,
    moonbagTokens
  };
  const trigger = strongestTrigger([
    eventTrigger(ctx.events, config),
    hardStopTrigger(input),
    migration.trigger,
    ladder.trigger,
    ...trailingTriggers(input),
    ...timeTriggers(input)
  ]);
  const candidate = trigger ? liquidationFrom(trigger, ctx.price, config.liquidity.minChunkLamports, nowMs) : null;
  const liquidating = stillLiquidating(
    mergeLiquidation(stillLiquidating(prior.liquidating, position.tokensHeld), candidate),
    position.tokensHeld
  );
  updates.liquidating = liquidating;
  if (!liquidating || !canAct(ctx)) {
    return { actions: [], updates };
  }
  const action = actionFor(ctx, liquidating);
  return { actions: action ? [action] : [], updates };
}
