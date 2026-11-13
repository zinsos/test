import type { ExitConfig } from "../config/strategy.js";
import type { CurveView, Position } from "../core/types.js";
import { fractionOf, isUsablePrice, maxBigInt, multipleOf } from "./math.js";
import type { ExitEvents, ExitState, ExitTrigger } from "./types.js";

export interface RuleInput {
  position: Position;
  price: number;
  nowMs: number;
  config: ExitConfig;
  peakPrice: number;
  takeProfitLevelsHit: number;
  migratedSeen: boolean;
  migratedSeenAtMs: number | null;
  moonbagTokens: bigint;
}

export interface MigrationStep {
  migratedSeen: boolean;
  migratedSeenAtMs: number | null;
  trigger: ExitTrigger | null;
}

export interface TakeProfitStep {
  levelsHit: number;
  trigger: ExitTrigger | null;
}

const SECOND_MS = 1000;

function closeAll(reason: ExitTrigger["reason"], urgency: ExitTrigger["urgency"]): ExitTrigger {
  return { reason, urgency, targetTokens: 0n };
}

export function baseTokensOf(position: Pick<Position, "entryTokens" | "tokensHeld">): bigint {
  return position.entryTokens > 0n ? position.entryTokens : position.tokensHeld;
}

export function moonbagTokensOf(position: Pick<Position, "entryTokens" | "tokensHeld">, config: ExitConfig): bigint {
  return fractionOf(baseTokensOf(position), config.moonbagFraction);
}

export function eventTrigger(events: ExitEvents, config: ExitConfig): ExitTrigger | null {
  const rules = config.events;
  if (rules.devSellExit && events.devSoldFraction > 0 && events.devSoldFraction >= rules.devSellMinFraction) {
    return closeAll("dev_sold", "emergency");
  }
  if (events.insiderSoldFraction > 0 && events.insiderSoldFraction >= rules.insiderSellExitFraction) {
    return closeAll("insider_sold", "emergency");
  }
  if (rules.smartExitMinWallets > 0 && events.smartWalletsExited >= rules.smartExitMinWallets) {
    return closeAll("smart_exit", "emergency");
  }
  return null;
}

export function hardStopTrigger(input: RuleInput): ExitTrigger | null {
  const { position, price, config } = input;
  if (!isUsablePrice(price) || !isUsablePrice(position.entryPrice)) {
    return null;
  }
  return price <= position.entryPrice * config.stopLossMultiple ? closeAll("stop_loss", "emergency") : null;
}

export function migrationStep(
  position: Position,
  view: CurveView,
  prior: ExitState,
  config: ExitConfig,
  nowMs: number,
  migratedSlot: number | null
): MigrationStep {
  if (position.migratedSeen) {
    return { migratedSeen: true, migratedSeenAtMs: prior.migratedSeenAtMs, trigger: null };
  }
  if (!view.migrated) {
    return { migratedSeen: false, migratedSeenAtMs: null, trigger: null };
  }
  if (migratedSlot !== null && migratedSlot <= position.openedSlot) {
    return { migratedSeen: true, migratedSeenAtMs: position.openedAtMs, trigger: null };
  }
  const trigger = config.migration.action === "exit" ? closeAll("migration_exit", "normal") : null;
  return { migratedSeen: true, migratedSeenAtMs: nowMs, trigger };
}

export function sortedTakeProfitLevels(config: ExitConfig): ExitConfig["takeProfit"] {
  return [...config.takeProfit].sort((a, b) => a.atMultiple - b.atMultiple);
}

function cumulativeSellFraction(levels: ExitConfig["takeProfit"], count: number): number {
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    total += levels[index]?.sellFractionOfInitial ?? 0;
  }
  return Math.min(1, total);
}

export function takeProfitStep(position: Position, price: number, config: ExitConfig, moonbagTokens: bigint): TakeProfitStep {
  const levels = sortedTakeProfitLevels(config);
  const before = Math.min(levels.length, Math.max(0, Math.floor(position.takeProfitLevelsHit)));
  const multiple = multipleOf(price, position.entryPrice);
  let hit = before;
  while (multiple > 0 && hit < levels.length && multiple >= (levels[hit]?.atMultiple ?? Number.POSITIVE_INFINITY)) {
    hit += 1;
  }
  if (hit === before) {
    return { levelsHit: before, trigger: null };
  }
  const base = baseTokensOf(position);
  const target = maxBigInt(moonbagTokens, base - fractionOf(base, cumulativeSellFraction(levels, hit)));
  const trigger: ExitTrigger | null =
    target < position.tokensHeld ? { reason: "take_profit", urgency: "normal", targetTokens: target } : null;
  return { levelsHit: hit, trigger };
}

export function isSwitchedToPool(input: Pick<RuleInput, "migratedSeen" | "config">): boolean {
  return input.migratedSeen && input.config.migration.action === "switch";
}

export function trailFractionFor(peakMultiple: number, input: Pick<RuleInput, "migratedSeen" | "config">): number | null {
  if (isSwitchedToPool(input)) {
    return input.config.migration.trailFraction;
  }
  let fraction: number | null = null;
  for (const tier of input.config.trailing) {
    if (peakMultiple >= tier.peakMultiple) {
      fraction = fraction === null ? tier.trailFraction : Math.min(fraction, tier.trailFraction);
    }
  }
  return fraction;
}

export function trailingTriggers(input: RuleInput): ExitTrigger[] {
  const { position, price, peakPrice, config, moonbagTokens } = input;
  if (!isUsablePrice(price) || !isUsablePrice(peakPrice) || !isUsablePrice(position.entryPrice)) {
    return [];
  }
  const fraction = trailFractionFor(multipleOf(peakPrice, position.entryPrice), input);
  if (fraction === null) {
    return [];
  }
  const triggers: ExitTrigger[] = [];
  if (position.tokensHeld > moonbagTokens && price <= peakPrice * (1 - fraction)) {
    triggers.push({ reason: "trailing_stop", urgency: "normal", targetTokens: moonbagTokens });
  }
  if (price <= peakPrice * (1 - config.moonbagTrailFraction)) {
    triggers.push(closeAll("moonbag_trail", "normal"));
  }
  return triggers;
}

function flatTimeStop(input: RuleInput): ExitTrigger | null {
  const { position, price, nowMs, config, moonbagTokens } = input;
  if (input.takeProfitLevelsHit > 0 || position.tokensHeld <= moonbagTokens) {
    return null;
  }
  if (nowMs - position.openedAtMs < config.timeStop.afterSec * SECOND_MS) {
    return null;
  }
  const multiple = multipleOf(price, position.entryPrice);
  if (multiple <= 0 || Math.abs(multiple - 1) > config.timeStop.flatBandFraction) {
    return null;
  }
  return closeAll("time_stop", "normal");
}

function maxHoldStop(input: RuleInput): ExitTrigger | null {
  const { position, nowMs, config } = input;
  if (isSwitchedToPool(input)) {
    const since = input.migratedSeenAtMs ?? position.openedAtMs;
    return nowMs - since >= config.migration.timeStopSec * SECOND_MS ? closeAll("migration_max_hold", "normal") : null;
  }
  return nowMs - position.openedAtMs >= config.maxHoldSec * SECOND_MS ? closeAll("max_hold", "normal") : null;
}

export function timeTriggers(input: RuleInput): ExitTrigger[] {
  const triggers: ExitTrigger[] = [];
  const flat = flatTimeStop(input);
  if (flat) {
    triggers.push(flat);
  }
  const hold = maxHoldStop(input);
  if (hold) {
    triggers.push(hold);
  }
  return triggers;
}
