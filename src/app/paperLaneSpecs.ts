import type { Env, ModuleName } from "../config/env.js";
import type { StrategyConfig } from "../config/strategy.js";
import type { ScoreProvider } from "../core/contracts.js";
import { moduleLogger } from "../core/logger.js";
import type { LaunchScore, Pubkey } from "../core/types.js";
import { applyOverrides, changedSettings, inertReason, LAB_VARIANTS_FILE, loadLabVariants, type LabVariant } from "../lab/variants.js";
import { hardBlockFlags } from "../scorer/model.js";
import { canonicalJson, PAPER_LANE_LABEL_PREFIX } from "../trader/runs.js";

const log = moduleLogger("app.paper-lanes");

export const ALL_PAPER_VARIANTS = "all";
export const NO_PAPER_VARIANTS = "none";
export const PAPER_VARIANTS_ENV = "PAPER_VARIANTS";
export const PAPER_VARIANTS_SETTING = "lab.livePaperVariants";
const HARD_FLAG_PREFIX = "hard_";

const LANE_SETTINGS: readonly string[] = ["signals.", "tracker.convergence.", "execution.", "exits.", "risk.", "scorer.hardBlocks."];
const IGNORED_SETTINGS: readonly string[] = ["lab."];

export interface PaperVariantRequest {
  names: string[];
  source: string;
}

export interface PaperLaneSpec {
  name: string;
  description: string;
  label: string;
  config: StrategyConfig;
  changed: string[];
}

export function paperLaneLabel(name: string): string {
  return `${PAPER_LANE_LABEL_PREFIX}${name}`;
}

export function laneNameOfLabel(label: string | null | undefined): string | null {
  return typeof label === "string" && label.startsWith(PAPER_LANE_LABEL_PREFIX) ? label.slice(PAPER_LANE_LABEL_PREFIX.length) : null;
}

export function requestedPaperVariants(env: Pick<Env, "PAPER_VARIANTS">, config: StrategyConfig): PaperVariantRequest {
  if (env.PAPER_VARIANTS !== undefined) {
    return { names: [...env.PAPER_VARIANTS], source: PAPER_VARIANTS_ENV };
  }
  return { names: [...config.lab.livePaperVariants], source: PAPER_VARIANTS_SETTING };
}

export function laneCannotApply(setting: string): boolean {
  if (IGNORED_SETTINGS.some((prefix) => setting.startsWith(prefix))) {
    return false;
  }
  return !LANE_SETTINGS.some((prefix) => setting.startsWith(prefix));
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function quoted(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}

function requestedNames(request: PaperVariantRequest, variants: readonly LabVariant[]): string[] {
  const names = [...new Set(request.names)];
  for (const keyword of [ALL_PAPER_VARIANTS, NO_PAPER_VARIANTS]) {
    if (names.includes(keyword) && names.length > 1) {
      throw new Error(`${request.source}: "${keyword}" cannot be combined with variant names`);
    }
  }
  if (names[0] === NO_PAPER_VARIANTS) {
    return [];
  }
  if (names[0] === ALL_PAPER_VARIANTS) {
    return variants.map((variant) => variant.name);
  }
  return names;
}

export function resolvePaperLanes(
  request: PaperVariantRequest,
  variants: readonly LabVariant[],
  base: StrategyConfig,
  variantsFile: string = LAB_VARIANTS_FILE
): PaperLaneSpec[] {
  const names = requestedNames(request, variants);
  const byName = new Map(variants.map((variant) => [variant.name, variant]));
  const unknown = names.filter((name) => !byName.has(name));
  if (unknown.length > 0) {
    const available = variants.length > 0 ? variants.map((variant) => variant.name).join(", ") : "no variants";
    throw new Error(
      `${request.source}: unknown paper ${plural(unknown.length, "variant")} ${quoted(unknown)}; ${variantsFile} defines ${available} ` +
        `(the main paper trader runs the base strategy, list only variants)`
    );
  }
  return names.map((name) => {
    const variant = byName.get(name);
    if (!variant) {
      throw new Error(`${request.source}: unknown paper variant "${name}"`);
    }
    return laneSpecOf(variant, base, request.source);
  });
}

function laneSpecOf(variant: LabVariant, base: StrategyConfig, source: string): PaperLaneSpec {
  let config: StrategyConfig;
  try {
    config = applyOverrides(base, variant.overrides);
  } catch (error) {
    throw new Error(`${source}: paper variant "${variant.name}" is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  config.lab = structuredClone(base.lab);
  const changed = changedSettings(base, config);
  const unsupported = changed.filter(laneCannotApply);
  if (unsupported.length > 0) {
    throw new Error(
      `${source}: paper variant "${variant.name}" changes ${unsupported.length === 1 ? "a setting" : "settings"} a live paper lane cannot apply ` +
        `(lanes share the recorder, scorer and wallet ranking of the service): ${unsupported.join(", ")}`
    );
  }
  const inert = inertReason(config, changed);
  if (inert) {
    log.warn({ variant: variant.name, reason: inert }, "this paper variant trades exactly like the main paper trader");
  }
  return { name: variant.name, description: variant.description, label: paperLaneLabel(variant.name), config, changed };
}

export interface PaperLaneSpecOptions {
  variantsFile?: string;
  loadVariants?: (file: string) => Promise<LabVariant[]>;
}

export async function paperLaneSpecsFor(
  env: Pick<Env, "PAPER_VARIANTS" | "TRADING_MODE">,
  config: StrategyConfig,
  modules: ReadonlySet<ModuleName>,
  options: PaperLaneSpecOptions = {}
): Promise<PaperLaneSpec[]> {
  const request = requestedPaperVariants(env, config);
  if (request.names.length === 0 || (request.names.length === 1 && request.names[0] === NO_PAPER_VARIANTS)) {
    return [];
  }
  if (env.TRADING_MODE === "live") {
    log.warn({ requested: request.names, source: request.source }, "paper strategy lanes run only with TRADING_MODE=paper; ignored in live mode");
    return [];
  }
  if (!modules.has("trader")) {
    log.warn({ requested: request.names, source: request.source }, "paper strategy lanes need the trader module; ignored");
    return [];
  }
  const file = options.variantsFile ?? LAB_VARIANTS_FILE;
  const variants = await (options.loadVariants ?? loadLabVariants)(file);
  return resolvePaperLanes(request, variants, config, file);
}

export type ScoreView = (score: LaunchScore) => LaunchScore;

export function laneScoreView(base: StrategyConfig, lane: StrategyConfig): ScoreView | null {
  if (canonicalJson(base.scorer.hardBlocks) === canonicalJson(lane.scorer.hardBlocks)) {
    return null;
  }
  const hardBlocks = lane.scorer.hardBlocks;
  return (score) => {
    const hardFlags = hardBlockFlags(score.features, hardBlocks);
    return {
      ...score,
      hardBlocked: hardFlags.length > 0,
      flags: [...hardFlags, ...score.flags.filter((flag) => !flag.startsWith(HARD_FLAG_PREFIX))]
    };
  };
}

export class SharedScoreRequests implements ScoreProvider {
  private readonly base: ScoreProvider;
  private readonly inflight = new Map<Pubkey, Promise<LaunchScore | null>>();

  constructor(base: ScoreProvider) {
    this.base = base;
  }

  latest(mint: Pubkey): LaunchScore | null {
    return this.base.latest(mint);
  }

  scoreNow(mint: Pubkey, reason: string): Promise<LaunchScore | null> {
    const existing = this.inflight.get(mint);
    if (existing) {
      return existing;
    }
    const request = this.base.scoreNow(mint, reason).finally(() => {
      if (this.inflight.get(mint) === request) {
        this.inflight.delete(mint);
      }
    });
    this.inflight.set(mint, request);
    return request;
  }

  pending(): number {
    return this.inflight.size;
  }
}

export function viewedScores(scores: ScoreProvider, view: ScoreView | null): ScoreProvider {
  if (!view) {
    return scores;
  }
  return {
    latest: (mint) => {
      const score = scores.latest(mint);
      return score ? view(score) : null;
    },
    scoreNow: async (mint, reason) => {
      const score = await scores.scoreNow(mint, reason);
      return score ? view(score) : null;
    }
  };
}
