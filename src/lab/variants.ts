import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseStrategyConfig, type StrategyConfig } from "../config/strategy.js";

export const BASELINE_NAME = "baseline";
export const LAB_VARIANTS_FILE = "config/lab-variants.json";
export const LAB_LABEL_PREFIX = "lab:";
export const UNDO_VARIANT_PREFIX = "undo-";

export type JsonObject = { [key: string]: unknown };

export interface LabVariant {
  name: string;
  description: string;
  overrides: JsonObject;
}

const VariantSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,47}$/, "use 1 to 48 lowercase letters, digits, - or _")
    .refine((name) => name !== BASELINE_NAME, `"${BASELINE_NAME}" is reserved`)
    .refine((name) => !name.startsWith(UNDO_VARIANT_PREFIX), `names starting with "${UNDO_VARIANT_PREFIX}" are reserved for the undo arm of a promotion on probation`),
  description: z.string().trim().min(1),
  overrides: z.record(z.string(), z.unknown())
});

const VariantListSchema = z.array(VariantSchema);

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge(base: unknown, overrides: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(overrides)) {
    return structuredClone(overrides);
  }
  const merged: JsonObject = structuredClone(base);
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] = key in merged ? deepMerge(merged[key], value) : structuredClone(value);
  }
  return merged;
}

export function unknownSettings(base: unknown, overrides: JsonObject, prefix = ""): string[] {
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(overrides)) {
    const pathName = prefix ? `${prefix}.${key}` : key;
    if (!isPlainObject(base) || !(key in base)) {
      unknown.push(pathName);
      continue;
    }
    const inner = base[key];
    if (isPlainObject(value) && isPlainObject(inner)) {
      unknown.push(...unknownSettings(inner, value, pathName));
    }
  }
  return unknown;
}

export function changedSettings(before: unknown, after: unknown, prefix = ""): string[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => changedSettings(before[key], after[key], prefix ? `${prefix}.${key}` : key));
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix];
}

export function applyOverrides(baseline: StrategyConfig, overrides: JsonObject): StrategyConfig {
  const unknown = unknownSettings(baseline, overrides);
  if (unknown.length > 0) {
    throw new Error(`unknown strategy settings: ${unknown.join(", ")}`);
  }
  return parseStrategyConfig(deepMerge(baseline, overrides));
}

const SIGNAL_SCOPED: ReadonlyArray<{ prefix: string; signal: StrategyConfig["signals"]["enabled"][number] }> = [
  { prefix: "signals.scoreMomentum.", signal: "score_momentum" },
  { prefix: "tracker.convergence.", signal: "smart_convergence" }
];

const REPLAY_UNUSED: ReadonlyArray<{ prefix: string; except: string | null }> = [
  { prefix: "recorder.", except: "recorder.memory." },
  { prefix: "scorer.deepIntel.", except: null },
  { prefix: "tracker.", except: "tracker.convergence." },
  { prefix: "sweeper.", except: null },
  { prefix: "lab.", except: null }
];

export function unusedInReplay(setting: string): boolean {
  return REPLAY_UNUSED.some((entry) => setting.startsWith(entry.prefix) && !(entry.except !== null && setting.startsWith(entry.except)));
}

export function inertReason(merged: StrategyConfig, changed: readonly string[]): string | null {
  if (changed.length === 0) {
    return "identical to the baseline strategy";
  }
  const enabled = new Set(merged.signals.enabled);
  const disabledSignals = new Set<string>();
  const unused: string[] = [];
  for (const setting of changed) {
    if (unusedInReplay(setting)) {
      unused.push(setting);
      continue;
    }
    const scope = SIGNAL_SCOPED.find((entry) => setting.startsWith(entry.prefix));
    if (!scope || enabled.has(scope.signal)) {
      return null;
    }
    disabledSignals.add(scope.signal);
  }
  const parts: string[] = [];
  if (disabledSignals.size > 0) {
    parts.push(`settings of ${[...disabledSignals].join(" and ")}, which signals.enabled does not include`);
  }
  if (unused.length > 0) {
    parts.push(`settings a replay does not use (${unused.join(", ")}; the recorder, wallet intel, wallet ranking and sweeper run only live, and lab settings only steer the lab)`);
  }
  return `only changes ${parts.join(" and ")}`;
}

export function parseLabVariants(raw: unknown): LabVariant[] {
  const parsed = VariantListSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    throw new Error(`invalid lab variants: ${issues}`);
  }
  const seen = new Set<string>();
  for (const variant of parsed.data) {
    if (seen.has(variant.name)) {
      throw new Error(`invalid lab variants: duplicate name "${variant.name}"`);
    }
    seen.add(variant.name);
  }
  return parsed.data.map((variant) => ({ name: variant.name, description: variant.description, overrides: variant.overrides }));
}

export async function loadLabVariants(filePath: string = LAB_VARIANTS_FILE): Promise<LabVariant[]> {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!existsSync(resolved)) {
    throw new Error(`lab variants file not found: ${filePath}`);
  }
  return parseLabVariants(JSON.parse(await readFile(resolved, "utf8")));
}

export function labRunLabel(labRunId: number, variantName: string): string {
  return `${LAB_LABEL_PREFIX}${labRunId}:${variantName}`;
}

export function isLabLabel(label: string | null | undefined): boolean {
  return typeof label === "string" && label.startsWith(LAB_LABEL_PREFIX);
}
