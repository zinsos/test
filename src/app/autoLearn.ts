import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseStrategyConfig, type StrategyConfig } from "../config/strategy.js";
import type { Clock } from "../core/clock.js";
import type { RiskStatus } from "../core/contracts.js";
import { moduleLogger } from "../core/logger.js";
import type { Position, TradingMode } from "../core/types.js";
import { jsonSafe, type Db, type DbClient } from "../db/pool.js";
import { overridesHash, ownerOnlySettings, shortHash, strategyHash, undoOverrides } from "../lab/identity.js";
import type { LearnedSettings } from "../lab/learned.js";
import {
  countApplyAttempt,
  latestAppliedAtMs,
  loadPendingPromotion,
  loadPromotion,
  lockPendingPromotion,
  rejectPromotion,
  type Promotion
} from "../lab/promotions.js";
import { applyOverrides, deepMerge, isPlainObject, type JsonObject } from "../lab/variants.js";
import { canonicalJson } from "../trader/runs.js";
import { CARRY_ENDED_BY, carryOf } from "./carry.js";
import { Repeater } from "./repeater.js";

const log = moduleLogger("app.auto-learn");

export const AUTO_LEARN_INTERVAL_MS = 5 * 60_000;
export const AUTO_LEARN_INITIAL_DELAY_MS = 60_000;
export const AUTO_LEARN_RESTART_DELAY_MS = 2_000;
export const MAX_APPLY_ATTEMPTS = 3;
const HOUR_MS = 3_600_000;

export type AutoLearnOutcome =
  | "disabled"
  | "live_mode"
  | "restart_pending"
  | "none_pending"
  | "other_settings"
  | "file_changed"
  | "rate_limited"
  | "waiting_positions"
  | "waiting_risk"
  | "rejected"
  | "applied";

export interface AutoLearnResult {
  outcome: AutoLearnOutcome;
  promotionId: number | null;
  detail: string | null;
}

export interface AutoLearnTrader {
  isRunning(): boolean;
  isBusy(): boolean;
  inFlightCount(): number;
  openPositions(): Position[];
  halt(): void;
}

export interface AutoLearnTrading {
  mode: TradingMode;
  runId: number;
  trader: AutoLearnTrader;
  risk: { status(): RiskStatus };
}

export interface AutoLearnOptions {
  db: Db;
  clock: Clock;
  config: StrategyConfig;
  learned: LearnedSettings;
  strategyPath: string | null;
  trading: AutoLearnTrading;
  restart: () => void;
}

interface PlannedChange {
  overlay: JsonObject;
  previousOverlay: JsonObject;
  appliedHash: string;
  undo: JsonObject | null;
  target: Promotion | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function result(outcome: AutoLearnOutcome, promotionId: number | null = null, detail: string | null = null): AutoLearnResult {
  return { outcome, promotionId, detail };
}

function json(value: unknown): string {
  return JSON.stringify(jsonSafe(value));
}

export function waitReason(trading: AutoLearnTrading): { outcome: AutoLearnOutcome; detail: string } | null {
  const status = trading.risk.status();
  if (!trading.trader.isRunning()) {
    return { outcome: "waiting_risk", detail: "the trader is not running" };
  }
  if (status.killed) {
    return { outcome: "waiting_risk", detail: "the kill switch is on; a promotion never resets it" };
  }
  if (status.haltedForDay) {
    return { outcome: "waiting_risk", detail: "the daily loss limit halted entries; a promotion never resets it" };
  }
  if (trading.trader.isBusy() || trading.trader.inFlightCount() > 0 || trading.trader.openPositions().length > 0) {
    return { outcome: "waiting_positions", detail: "waiting until no position is open or pending" };
  }
  return null;
}

export class AutoLearnApplier {
  private readonly options: AutoLearnOptions;
  private restartRequested = false;
  private lastLogged = "";

  constructor(options: AutoLearnOptions) {
    this.options = options;
  }

  get restartPending(): boolean {
    return this.restartRequested;
  }

  async tick(): Promise<AutoLearnResult> {
    const outcome = await this.evaluate();
    const key = `${outcome.outcome}:${outcome.promotionId ?? ""}:${outcome.detail ?? ""}`;
    if (key !== this.lastLogged) {
      this.lastLogged = key;
      const fields = { ...outcome, settings: shortHash(this.options.learned.settingsHash) };
      if (outcome.outcome === "none_pending" || outcome.outcome === "disabled") {
        log.debug(fields, "auto-learn check");
      } else {
        log.info(fields, "auto-learn check");
      }
    }
    return outcome;
  }

  private async evaluate(): Promise<AutoLearnResult> {
    const { config, trading, db, learned, clock } = this.options;
    if (this.restartRequested) {
      return result("restart_pending");
    }
    if (!config.lab.autoLearn.enabled) {
      return result("disabled");
    }
    if (trading.mode !== "paper") {
      return result("live_mode");
    }
    const pending = await loadPendingPromotion(db);
    if (!pending) {
      return result("none_pending");
    }
    if (pending.baselineHash !== learned.settingsHash) {
      return result("other_settings", pending.id, `it was learned for settings ${shortHash(pending.baselineHash)}, this paper trader runs ${shortHash(learned.settingsHash)}`);
    }
    const planned = await this.plan(pending);
    if (typeof planned === "string") {
      await rejectPromotion(db, pending.id, clock.nowMs(), planned);
      return result("rejected", pending.id, planned);
    }
    const minHours = config.lab.autoLearn.minHoursBetweenPromotions;
    const lastAt = minHours > 0 ? await latestAppliedAtMs(db) : null;
    if (lastAt !== null && clock.nowMs() - lastAt < minHours * HOUR_MS) {
      return result("rate_limited", pending.id, `the last change was applied less than ${minHours}h ago`);
    }
    const fileProblem = await this.fileProblem();
    if (fileProblem) {
      return result("file_changed", pending.id, fileProblem);
    }
    const waiting = waitReason(trading);
    if (waiting) {
      return result(waiting.outcome, pending.id, waiting.detail);
    }
    return this.apply(pending, planned);
  }

  private async fileProblem(): Promise<string | null> {
    const file = this.options.strategyPath;
    if (file === null) {
      return null;
    }
    try {
      const raw: unknown = JSON.parse(await readFile(file, "utf8"));
      if (canonicalJson(parseStrategyConfig(raw)) === canonicalJson(this.options.config)) {
        return null;
      }
    } catch {
      return `${path.basename(file)} cannot be read as a strategy file any more; restart the service after fixing it`;
    }
    return `${path.basename(file)} on disk differs from the settings this service started with (including lab.autoLearn); restart it first`;
  }

  private async plan(pending: Promotion): Promise<PlannedChange | string> {
    const { learned, config, db } = this.options;
    if (overridesHash(pending.overrides) !== pending.overridesHash) {
      return "the stored overrides do not match their hash";
    }
    if (pending.kind === "revert") {
      const target = pending.targetId === null ? null : await loadPromotion(db, pending.targetId);
      if (!target || target.status !== "applied" || target.id !== learned.eventId || target.previousOverlay === null) {
        return "the change it would undo is no longer the latest learned change in effect";
      }
      try {
        const appliedHash = strategyHash(applyOverrides(config, target.previousOverlay));
        if (appliedHash !== target.baselineHash) {
          return "undoing it would not restore the settings from before that change";
        }
        return { overlay: target.previousOverlay, previousOverlay: learned.overlay, appliedHash, undo: null, target };
      } catch (error) {
        return `the settings from before that change are no longer valid: ${messageOf(error)}`;
      }
    }
    try {
      const ownerOnly = ownerOnlySettings(pending.overrides, learned.config);
      if (ownerOnly.length > 0) {
        return `it changes settings only the owner changes (${ownerOnly.join(", ")})`;
      }
      const next = applyOverrides(learned.config, pending.overrides);
      if (canonicalJson(next) === canonicalJson(learned.config)) {
        return "it does not change any setting";
      }
      const overlay = deepMerge(learned.overlay, pending.overrides);
      if (!isPlainObject(overlay)) {
        return "the learned changes could not be combined";
      }
      const appliedHash = strategyHash(next);
      if (strategyHash(applyOverrides(config, overlay)) !== appliedHash) {
        return "the learned changes would not reproduce the settings the lab tested";
      }
      const undo = undoOverrides(learned.config, pending.overrides);
      const restores = strategyHash(applyOverrides(next, undo)) === learned.settingsHash;
      return { overlay, previousOverlay: learned.overlay, appliedHash, undo: restores ? undo : null, target: null };
    } catch (error) {
      return `its settings are invalid: ${messageOf(error)}`;
    }
  }

  private async apply(pending: Promotion, planned: PlannedChange): Promise<AutoLearnResult> {
    const { db, clock, trading, config, learned } = this.options;
    const atMs = clock.nowMs();
    const attempts = await countApplyAttempt(db, pending.id, atMs);
    if (attempts === null) {
      return result("none_pending");
    }
    if (attempts > MAX_APPLY_ATTEMPTS) {
      const note = `it could not be applied in ${MAX_APPLY_ATTEMPTS} attempts`;
      await rejectPromotion(db, pending.id, atMs, note);
      return result("rejected", pending.id, note);
    }
    const client: DbClient = await db.connect();
    let halted = false;
    try {
      await client.query("BEGIN");
      const locked = await lockPendingPromotion(client, pending.id);
      if (!locked) {
        await client.query("ROLLBACK");
        return result("none_pending");
      }
      const waiting = waitReason(trading);
      if (waiting) {
        await client.query("ROLLBACK");
        await client.query("UPDATE promotions SET apply_attempts = greatest(0, apply_attempts - 1) WHERE id = $1", [pending.id]);
        return result(waiting.outcome, pending.id, waiting.detail);
      }
      trading.trader.halt();
      halted = true;
      const carry = carryOf(trading.runId, trading.risk.status(), config.risk.startingBankrollSol, atMs);
      const at = new Date(atMs);
      const what = pending.kind === "revert" ? `undid ${planned.target?.name ?? "the last change"}` : `applied ${pending.name}`;
      const note = `${what}; paper run #${trading.runId} ended and the next run continues its bankroll, peak and day`;
      await client.query(`UPDATE strategy_runs SET ended_at = $2, summary = $3 WHERE id = $1 AND ended_at IS NULL`, [
        trading.runId,
        at,
        json({ endedBy: CARRY_ENDED_BY, promotionId: pending.id, promotion: pending.name, kind: pending.kind, carry })
      ]);
      await client.query(
        `UPDATE promotions
            SET status = 'applied', applied_at = $2, updated_at = $2, note = $3, root_hash = $4, previous_overlay = $5, overlay = $6,
                applied_hash = $7, undo = $8, evidence = evidence || $9::jsonb
          WHERE id = $1 AND status = 'pending'`,
        [
          pending.id,
          at,
          note,
          learned.rootHash,
          json(planned.previousOverlay),
          json(planned.overlay),
          planned.appliedHash,
          planned.undo === null ? null : json(planned.undo),
          json({ applied: { atMs, previousHash: learned.settingsHash, newHash: planned.appliedHash, endedRunId: trading.runId, carry } })
        ]
      );
      if (planned.target) {
        await client.query(
          `UPDATE promotions SET status = 'reverted', probation_result = 'reverted', updated_at = $2,
                  note = CASE WHEN note IS NULL THEN $3 ELSE note || '; ' || $3 END
            WHERE id = $1 AND status = 'applied'`,
          [planned.target.id, at, `undone by promotion #${pending.id}`]
        );
      }
      await client.query("COMMIT");
      log.warn({ promotionId: pending.id, name: pending.name, kind: pending.kind, endedRunId: trading.runId }, "auto-learn changed the paper settings, restarting");
      this.requestRestart();
      return result("applied", pending.id, note);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (halted) {
        log.error({ err: error, promotionId: pending.id, attempts }, "auto-learn failed after halting the trader, restarting to resume trading");
        this.requestRestart();
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private requestRestart(): void {
    if (this.restartRequested) {
      return;
    }
    this.restartRequested = true;
    this.options.restart();
  }
}

export function autoLearnRepeater(applier: AutoLearnApplier, clock: Clock, intervalMs = AUTO_LEARN_INTERVAL_MS): Repeater {
  return new Repeater({
    clock,
    name: "auto-learn",
    intervalMs,
    initialDelayMs: Math.min(intervalMs, AUTO_LEARN_INITIAL_DELAY_MS),
    run: async () => {
      await applier.tick();
    }
  });
}

export function resolveStrategyPath(file: string | undefined, cwd: string = process.cwd()): string | null {
  if (!file) {
    return null;
  }
  const resolved = path.resolve(cwd, file);
  return existsSync(resolved) ? resolved : null;
}
