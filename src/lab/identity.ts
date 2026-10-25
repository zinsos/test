import { createHash } from "node:crypto";
import { parseStrategyConfig, type StrategyConfig } from "../config/strategy.js";
import { canonicalJson } from "../trader/runs.js";
import { isPlainObject, type JsonObject } from "./variants.js";

export const HASH_DISPLAY_LENGTH = 8;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function withoutLabSection(config: StrategyConfig): JsonObject {
  const { lab: _lab, ...strategy } = config;
  return strategy;
}

export function strategyHash(config: StrategyConfig): string {
  return sha256(canonicalJson(withoutLabSection(config)));
}

export function storedStrategyHash(raw: unknown): string | null {
  try {
    return strategyHash(parseStrategyConfig(raw));
  } catch {
    return null;
  }
}

export function overridesHash(overrides: JsonObject): string {
  return sha256(canonicalJson(overrides));
}

export function variantKey(name: string, overrides: JsonObject): string {
  return `${name}#${overridesHash(overrides).slice(0, 16)}`;
}

export function shortHash(hash: string | null): string {
  return hash === null ? "none" : hash.slice(0, HASH_DISPLAY_LENGTH);
}

export function overridePaths(overrides: unknown, prefix = ""): string[] {
  if (!isPlainObject(overrides)) {
    return prefix ? [prefix] : [];
  }
  const keys = Object.keys(overrides).sort();
  if (keys.length === 0) {
    return prefix ? [prefix] : [];
  }
  return keys.flatMap((key) => overridePaths(overrides[key], prefix ? `${prefix}.${key}` : key));
}

const PROMOTABLE_SETTINGS: readonly string[] = [
  "signals.enabled",
  "signals.cooldownPerMintSec",
  "signals.scoreMomentum",
  "exits",
  "scorer.maxRisk",
  "tracker.convergence"
];

export const RISK_CEILINGS: readonly string[] = ["signals.scoreMomentum.maxRiskScore", "tracker.convergence.maxRiskScore", "scorer.maxRisk"];

export function isPromotableSetting(setting: string): boolean {
  return PROMOTABLE_SETTINGS.some((allowed) => setting === allowed || setting.startsWith(`${allowed}.`));
}

export function valueAtPath(source: unknown, setting: string): unknown {
  let current: unknown = source;
  for (const part of setting.split(".")) {
    current = isPlainObject(current) ? current[part] : undefined;
  }
  return current;
}

export function loosenedCeilings(overrides: JsonObject, base: StrategyConfig): string[] {
  return RISK_CEILINGS.filter((setting) => {
    const next = valueAtPath(overrides, setting);
    const current = valueAtPath(base, setting);
    return typeof next === "number" && typeof current === "number" && next > current;
  });
}

export function ownerOnlySettings(overrides: JsonObject, base: StrategyConfig): string[] {
  const outside = overridePaths(overrides).filter((setting) => !isPromotableSetting(setting));
  const loosened = loosenedCeilings(overrides, base).filter((setting) => !outside.includes(setting));
  return [...outside, ...loosened];
}

function setAtPath(target: JsonObject, setting: string, value: unknown): void {
  const parts = setting.split(".");
  let current: JsonObject = target;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!isPlainObject(next)) {
      current[part] = {};
    }
    current = current[part] as JsonObject;
  }
  const last = parts[parts.length - 1];
  if (last !== undefined) {
    current[last] = structuredClone(value);
  }
}

export function undoOverrides(before: StrategyConfig, overrides: JsonObject): JsonObject {
  const undo: JsonObject = {};
  for (const setting of overridePaths(overrides)) {
    setAtPath(undo, setting, valueAtPath(before, setting));
  }
  return undo;
}
