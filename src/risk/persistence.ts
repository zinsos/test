import type { TradingStore } from "../core/contracts.js";
import type { RiskStatus } from "../core/contracts.js";
import { moduleLogger } from "../core/logger.js";
import { jsonSafe, toBigInt, type Db } from "../db/pool.js";

const log = moduleLogger("risk.persistence");

export type RiskPersistence = Pick<TradingStore, "saveRiskState" | "recordRiskEvent">;

export interface PersistedRiskState {
  runId: number;
  startingBankrollLamports: bigint;
  realizedPnlLamports: bigint;
  peakEquityLamports: bigint;
  dayKey: string;
  dayStartEquityLamports: bigint;
  haltedUntilMs: number | null;
  killed: boolean;
  killReason: string | null;
  state: Record<string, unknown>;
}

export type RiskStateExtra = {
  startingBankrollLamports: string;
  haltedUntilMs: number | null;
  state: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalMs(value: unknown): number | null {
  if (value instanceof Date) {
    return value.getTime();
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function riskStateRow(status: RiskStatus, extra: Record<string, unknown>): PersistedRiskState {
  const startingRaw = extra.startingBankrollLamports;
  return {
    runId: status.runId,
    startingBankrollLamports: typeof startingRaw === "string" || typeof startingRaw === "bigint" ? toBigInt(startingRaw) : 0n,
    realizedPnlLamports: status.realizedPnlLamports,
    peakEquityLamports: status.peakEquityLamports,
    dayKey: status.dayKey,
    dayStartEquityLamports: status.dayStartEquityLamports,
    haltedUntilMs: optionalMs(extra.haltedUntilMs),
    killed: status.killed,
    killReason: status.killReason,
    state: isRecord(extra.state) ? extra.state : {}
  };
}

const UPSERT_RISK_STATE = `
INSERT INTO risk_state (run_id, updated_at, starting_bankroll, realized_pnl, peak_equity, day_key, day_start_equity,
                        halted_until, killed, kill_reason, state)
VALUES ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (run_id) DO UPDATE SET
  updated_at = now(),
  starting_bankroll = EXCLUDED.starting_bankroll,
  realized_pnl = EXCLUDED.realized_pnl,
  peak_equity = EXCLUDED.peak_equity,
  day_key = EXCLUDED.day_key,
  day_start_equity = EXCLUDED.day_start_equity,
  halted_until = EXCLUDED.halted_until,
  killed = EXCLUDED.killed,
  kill_reason = EXCLUDED.kill_reason,
  state = EXCLUDED.state`;

export async function saveRiskStateRow(db: Pick<Db, "query">, row: PersistedRiskState): Promise<void> {
  await db.query(UPSERT_RISK_STATE, [
    row.runId,
    row.startingBankrollLamports.toString(),
    row.realizedPnlLamports.toString(),
    row.peakEquityLamports.toString(),
    row.dayKey,
    row.dayStartEquityLamports.toString(),
    row.haltedUntilMs === null ? null : new Date(row.haltedUntilMs),
    row.killed,
    row.killReason,
    JSON.stringify(jsonSafe(row.state))
  ]);
}

interface RiskStateDbRow {
  run_id: bigint | number;
  starting_bankroll: bigint;
  realized_pnl: bigint;
  peak_equity: bigint;
  day_key: string;
  day_start_equity: bigint;
  halted_until: Date | null;
  killed: boolean;
  kill_reason: string | null;
  state: unknown;
}

export async function loadRiskState(db: Pick<Db, "query">, runId: number): Promise<PersistedRiskState | null> {
  const result = await db.query<RiskStateDbRow>(
    `SELECT run_id, starting_bankroll, realized_pnl, peak_equity, day_key, day_start_equity, halted_until, killed,
            kill_reason, state
       FROM risk_state WHERE run_id = $1`,
    [runId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    runId: Number(row.run_id),
    startingBankrollLamports: toBigInt(row.starting_bankroll),
    realizedPnlLamports: toBigInt(row.realized_pnl),
    peakEquityLamports: toBigInt(row.peak_equity),
    dayKey: row.day_key,
    dayStartEquityLamports: toBigInt(row.day_start_equity),
    haltedUntilMs: row.halted_until ? row.halted_until.getTime() : null,
    killed: row.killed,
    killReason: row.kill_reason,
    state: isRecord(row.state) ? row.state : {}
  };
}

export interface QueuedRiskEvent {
  runId: number;
  atMs: number;
  kind: string;
  detail: Record<string, unknown>;
}

export async function insertRiskEvents(db: Pick<Db, "query">, events: readonly QueuedRiskEvent[]): Promise<void> {
  if (events.length === 0) {
    return;
  }
  const params: unknown[] = [];
  const tuples: string[] = [];
  for (const event of events) {
    params.push(event.runId, new Date(event.atMs), event.kind, JSON.stringify(jsonSafe(event.detail)));
    const base = params.length - 4;
    tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
  }
  await db.query(`INSERT INTO risk_events (run_id, at, kind, detail) VALUES ${tuples.join(",")}`, params);
}

export interface RiskStateDbWriterOptions {
  db: Pick<Db, "query">;
  maxQueuedEvents?: number;
}

const DEFAULT_MAX_QUEUED_EVENTS = 5000;

export class RiskStateDbWriter implements RiskPersistence {
  private readonly db: Pick<Db, "query">;
  private readonly maxQueuedEvents: number;
  private pendingState: PersistedRiskState | null = null;
  private pendingEvents: QueuedRiskEvent[] = [];
  private draining: Promise<void> | null = null;
  private droppedEvents = 0;

  constructor(options: RiskStateDbWriterOptions) {
    this.db = options.db;
    this.maxQueuedEvents = options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS;
  }

  saveRiskState(status: RiskStatus, extra: Record<string, unknown>): void {
    this.pendingState = riskStateRow(status, extra);
    this.kick();
  }

  recordRiskEvent(runId: number, atMs: number, kind: string, detail: Record<string, unknown>): void {
    this.pendingEvents.push({ runId, atMs, kind, detail });
    if (this.pendingEvents.length > this.maxQueuedEvents) {
      const overflow = this.pendingEvents.length - this.maxQueuedEvents;
      this.pendingEvents.splice(0, overflow);
      this.droppedEvents += overflow;
    }
    this.kick();
  }

  stats(): { queuedEvents: number; statePending: boolean; droppedEvents: number } {
    return { queuedEvents: this.pendingEvents.length, statePending: this.pendingState !== null, droppedEvents: this.droppedEvents };
  }

  async flush(): Promise<void> {
    if (this.draining) {
      await this.draining;
    }
    if (this.pendingState || this.pendingEvents.length > 0) {
      this.kick();
      await this.draining;
    }
  }

  private kick(): void {
    if (this.draining) {
      return;
    }
    this.draining = this.drain().finally(() => {
      this.draining = null;
    });
  }

  private async drain(): Promise<void> {
    while (this.pendingState || this.pendingEvents.length > 0) {
      const events = this.pendingEvents.splice(0, this.pendingEvents.length);
      const state = this.pendingState;
      this.pendingState = null;
      try {
        await insertRiskEvents(this.db, events);
      } catch (error) {
        log.error({ err: error, events: events.length }, "risk events write failed");
        this.pendingEvents.unshift(...events);
        this.pendingState = this.pendingState ?? state;
        return;
      }
      if (!state) {
        continue;
      }
      try {
        await saveRiskStateRow(this.db, state);
      } catch (error) {
        log.error({ err: error, runId: state.runId }, "risk state write failed");
        this.pendingState = this.pendingState ?? state;
        return;
      }
    }
  }
}
