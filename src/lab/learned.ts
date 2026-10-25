import type { StrategyConfig } from "../config/strategy.js";
import { moduleLogger } from "../core/logger.js";
import type { TradingMode } from "../core/types.js";
import type { Db, DbClient } from "../db/pool.js";
import { overridePaths, strategyHash } from "./identity.js";
import { isUndefinedTable, latestEvent, type Promotion } from "./promotions.js";
import { applyOverrides, type JsonObject } from "./variants.js";

const log = moduleLogger("lab.learned");

export interface LearnedSettings {
  config: StrategyConfig;
  rootHash: string;
  settingsHash: string;
  overlay: JsonObject;
  eventId: number | null;
  eventName: string | null;
  eventKind: Promotion["kind"] | null;
  appliedAtMs: number | null;
  changes: string[];
  problem: string | null;
}

type Queryable = Pick<Db, "query"> | DbClient;

export function fileSettings(base: StrategyConfig, problem: string | null = null): LearnedSettings {
  const hash = strategyHash(base);
  return {
    config: base,
    rootHash: hash,
    settingsHash: hash,
    overlay: {},
    eventId: null,
    eventName: null,
    eventKind: null,
    appliedAtMs: null,
    changes: [],
    problem
  };
}

export function learnedFrom(base: StrategyConfig, event: Promotion | null): LearnedSettings {
  const root = fileSettings(base);
  if (!event || event.overlay === null || event.appliedHash === null) {
    return root;
  }
  try {
    const config = applyOverrides(base, event.overlay);
    const settingsHash = strategyHash(config);
    if (settingsHash !== event.appliedHash) {
      return fileSettings(base, `the learned changes of promotion #${event.id} no longer produce the settings they were tested with, so the strategy file is used as is`);
    }
    return {
      config,
      rootHash: root.rootHash,
      settingsHash,
      overlay: event.overlay,
      eventId: event.id,
      eventName: event.name,
      eventKind: event.kind,
      appliedAtMs: event.appliedAtMs,
      changes: overridePaths(event.overlay),
      problem: null
    };
  } catch (error) {
    return fileSettings(base, `the learned changes of promotion #${event.id} are no longer valid (${error instanceof Error ? error.message : String(error)}), so the strategy file is used as is`);
  }
}

export function usesLearnedSettings(base: StrategyConfig, mode: TradingMode): boolean {
  return mode === "paper" && base.lab.autoLearn.enabled;
}

export async function loadLearnedSettings(db: Queryable, base: StrategyConfig, mode: TradingMode): Promise<LearnedSettings> {
  if (!usesLearnedSettings(base, mode)) {
    return fileSettings(base);
  }
  try {
    const learned = learnedFrom(base, await latestEvent(db, strategyHash(base)));
    if (learned.problem) {
      log.warn({ problem: learned.problem }, "learned paper settings ignored");
    } else if (learned.eventId !== null) {
      log.info({ promotionId: learned.eventId, changes: learned.changes }, "paper settings include learned changes");
    }
    return learned;
  } catch (error) {
    if (isUndefinedTable(error)) {
      return fileSettings(base);
    }
    throw error;
  }
}
