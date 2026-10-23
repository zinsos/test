import type { RiskStatus, SignalRecord, TradingStore } from "../core/contracts.js";
import { moduleLogger } from "../core/logger.js";
import type { FillResult, OrderRequest, Position, TradingMode } from "../core/types.js";
import { toNumber, type Db } from "../db/pool.js";
import {
  insertRiskEvents,
  riskStateRow,
  saveRiskStateRow,
  type PersistedRiskState,
  type QueuedRiskEvent
} from "../risk/persistence.js";
import {
  FILL_COLUMNS,
  FILL_INSERT_CONFLICT,
  POSITION_COLUMNS,
  POSITION_UPSERT_CONFLICT,
  SIGNAL_COLUMNS,
  SIGNAL_INSERT_CONFLICT,
  fillRow,
  jsonText,
  positionRow,
  signalRow
} from "./rows.js";

const log = moduleLogger("trader.store");
const MAX_PARAMS = 60_000;
const RISK_EVENT_CHUNK = 2_000;
const LAUNCH_ID_CACHE = 20_000;

export interface PgTradingStoreOptions {
  db: Db;
  flushIntervalMs?: number;
  flushAtRows?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  signalIdBlock?: number;
  maxBufferedRows?: number;
}

export interface RunInput {
  mode: TradingMode;
  label: string | null;
  config: unknown;
  dataFrom: Date | null;
  dataTo: Date | null;
}

export interface TradingStoreStats {
  positionsBuffered: number;
  fillsBuffered: number;
  signalsBuffered: number;
  riskEventsBuffered: number;
  signalIdsReady: number;
  positionsWritten: number;
  fillsWritten: number;
  signalsWritten: number;
  riskEventsWritten: number;
  riskStatesWritten: number;
  writeErrors: number;
  droppedRows: number;
  flushes: number;
}

type Row = readonly unknown[];

interface BufferedSignal {
  id: number | null;
  runId: number;
  record: SignalRecord;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function capFront<T>(rows: T[], max: number): number {
  if (rows.length <= max) {
    return 0;
  }
  const overflow = rows.length - max;
  rows.splice(0, overflow);
  return overflow;
}

export class PgTradingStore implements TradingStore {
  private readonly db: Db;
  private readonly flushIntervalMs: number;
  private readonly flushAtRows: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly signalIdBlock: number;
  private readonly maxBufferedRows: number;
  private readonly positions = new Map<string, Position>();
  private readonly discards = new Set<string>();
  private fills: Row[] = [];
  private signalsWithId: BufferedSignal[] = [];
  private signalsWithoutId: BufferedSignal[] = [];
  private readonly launchIds = new Map<string, number>();
  private riskEvents: QueuedRiskEvent[] = [];
  private readonly riskStates = new Map<number, PersistedRiskState>();
  private readonly signalIds: number[] = [];
  private idRefill: Promise<void> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private earlyFlushPending = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly counters = {
    positionsWritten: 0,
    fillsWritten: 0,
    signalsWritten: 0,
    riskEventsWritten: 0,
    riskStatesWritten: 0,
    writeErrors: 0,
    droppedRows: 0,
    flushes: 0
  };

  constructor(options: PgTradingStoreOptions) {
    this.db = options.db;
    this.flushIntervalMs = options.flushIntervalMs ?? 1_000;
    this.flushAtRows = options.flushAtRows ?? 1_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.signalIdBlock = Math.max(1, options.signalIdBlock ?? 256);
    this.maxBufferedRows = options.maxBufferedRows ?? 100_000;
  }

  async prepare(): Promise<void> {
    await this.refillSignalIds();
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.flush().catch(() => undefined);
    }, this.flushIntervalMs);
    this.timer.unref?.();
    this.refillSignalIdsIfLow();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.idRefill?.catch(() => undefined);
    await this.flush();
  }

  async createRun(input: RunInput): Promise<number> {
    const result = await this.db.query<{ id: unknown }>(
      `INSERT INTO strategy_runs (mode, label, config, data_from, data_to)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.mode, input.label, jsonText(input.config ?? {}), input.dataFrom, input.dataTo]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("strategy run insert returned no id");
    }
    return toNumber(row.id);
  }

  recordSignal(runId: number, record: SignalRecord): Promise<number | null> {
    const id = this.signalIds.shift() ?? null;
    this.refillSignalIdsIfLow();
    if (id === null) {
      this.signalsWithoutId.push({ id, runId, record });
      this.counters.droppedRows += capFront(this.signalsWithoutId, this.maxBufferedRows);
    } else {
      this.signalsWithId.push({ id, runId, record });
      this.counters.droppedRows += capFront(this.signalsWithId, this.maxBufferedRows);
    }
    this.maybeFlushEarly();
    return Promise.resolve(id);
  }

  savePosition(position: Position): void {
    this.positions.set(position.id, position);
    this.maybeFlushEarly();
  }

  discardPendingPosition(positionId: string): void {
    const buffered = this.positions.get(positionId);
    if (buffered && buffered.status !== "pending") {
      return;
    }
    this.positions.delete(positionId);
    this.discards.add(positionId);
    this.maybeFlushEarly();
  }

  recordFill(position: Position, order: OrderRequest, fill: FillResult): void {
    this.fills.push(fillRow(position, order, fill));
    this.counters.droppedRows += capFront(this.fills, this.maxBufferedRows);
    this.maybeFlushEarly();
  }

  recordRiskEvent(runId: number, atMs: number, kind: string, detail: Record<string, unknown>): void {
    this.riskEvents.push({ runId, atMs, kind, detail });
    this.counters.droppedRows += capFront(this.riskEvents, this.maxBufferedRows);
    this.maybeFlushEarly();
  }

  saveRiskState(status: RiskStatus, extra: Record<string, unknown>): void {
    this.riskStates.set(status.runId, riskStateRow(status, extra));
  }

  async finishRun(runId: number, summary: unknown): Promise<void> {
    await this.flush();
    await this.db.query(`UPDATE strategy_runs SET ended_at = now(), summary = $2 WHERE id = $1`, [runId, jsonText(summary)]);
  }

  flush(): Promise<void> {
    const run = this.chain.then(() => this.writeAll());
    this.chain = run.catch(() => undefined);
    return run;
  }

  stats(): TradingStoreStats {
    return {
      positionsBuffered: this.positions.size,
      fillsBuffered: this.fills.length,
      signalsBuffered: this.signalsWithId.length + this.signalsWithoutId.length,
      riskEventsBuffered: this.riskEvents.length,
      signalIdsReady: this.signalIds.length,
      ...this.counters
    };
  }

  private bufferedRows(): number {
    return (
      this.positions.size +
      this.discards.size +
      this.fills.length +
      this.signalsWithId.length +
      this.signalsWithoutId.length +
      this.riskEvents.length
    );
  }

  private maybeFlushEarly(): void {
    if (this.earlyFlushPending || this.bufferedRows() < this.flushAtRows) {
      return;
    }
    this.earlyFlushPending = true;
    void this.flush()
      .catch(() => undefined)
      .finally(() => {
        this.earlyFlushPending = false;
      });
  }

  private refillSignalIdsIfLow(): void {
    if (this.idRefill || this.signalIds.length >= Math.ceil(this.signalIdBlock / 4)) {
      return;
    }
    this.idRefill = this.refillSignalIds()
      .catch((error: unknown) => {
        log.warn({ err: error }, "signal id prefetch failed; signals are written without ids until it recovers");
      })
      .finally(() => {
        this.idRefill = null;
      });
  }

  private async refillSignalIds(): Promise<void> {
    const result = await this.db.query<{ id: unknown }>(
      `SELECT nextval(pg_get_serial_sequence('signals', 'id')) AS id FROM generate_series(1, $1)`,
      [this.signalIdBlock]
    );
    for (const row of result.rows) {
      this.signalIds.push(toNumber(row.id));
    }
  }

  private async writeAll(): Promise<void> {
    this.counters.flushes += 1;
    await this.resolveLaunchIds();
    await this.writePositions();
    await this.writeDiscards();
    await this.writeFills();
    await this.writeSignals();
    await this.writeRiskStates();
    await this.writeRiskEvents();
  }

  private async withRetries(what: string, rows: number, work: () => Promise<void>): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await work();
        return true;
      } catch (error) {
        if (attempt >= this.maxRetries) {
          this.counters.writeErrors += 1;
          log.error({ err: error, what, rows }, "trading store write failed, will retry on the next flush");
          return false;
        }
        await sleep(this.retryDelayMs * 2 ** attempt);
      }
    }
  }

  private async insertRows(table: string, columns: readonly string[], rows: readonly Row[], conflict: string): Promise<void> {
    const chunkSize = Math.max(1, Math.floor(MAX_PARAMS / columns.length));
    for (let start = 0; start < rows.length; start += chunkSize) {
      const chunk = rows.slice(start, start + chunkSize);
      const params: unknown[] = [];
      const tuples = chunk.map((row) => {
        const placeholders = row.map((value) => {
          params.push(typeof value === "bigint" ? value.toString() : value);
          return `$${params.length}`;
        });
        return `(${placeholders.join(",")})`;
      });
      await this.db.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples.join(",")} ${conflict}`, params);
    }
  }

  private launchIdFor(mint: string, known: number | null): number | null {
    return known ?? this.launchIds.get(mint) ?? null;
  }

  private async resolveLaunchIds(): Promise<void> {
    const missing = new Set<string>();
    for (const position of this.positions.values()) {
      if (position.launchId === null && !this.launchIds.has(position.mint)) {
        missing.add(position.mint);
      }
    }
    for (const entry of [...this.signalsWithId, ...this.signalsWithoutId]) {
      if (entry.record.launchId === null && !this.launchIds.has(entry.record.signal.mint)) {
        missing.add(entry.record.signal.mint);
      }
    }
    if (missing.size === 0) {
      return;
    }
    try {
      const result = await this.db.query<{ id: unknown; mint: string }>("SELECT id, mint FROM launches WHERE mint = ANY($1::text[])", [
        [...missing]
      ]);
      for (const row of result.rows) {
        this.launchIds.set(row.mint, toNumber(row.id));
      }
      while (this.launchIds.size > LAUNCH_ID_CACHE) {
        const oldest = this.launchIds.keys().next();
        if (oldest.done) {
          break;
        }
        this.launchIds.delete(oldest.value);
      }
    } catch (error) {
      log.warn({ err: error }, "launch id lookup failed; rows are written without launch ids");
    }
  }

  private async writePositions(): Promise<void> {
    if (this.positions.size === 0) {
      return;
    }
    const batch = [...this.positions.values()].map((position) =>
      position.launchId === null ? { ...position, launchId: this.launchIdFor(position.mint, null) } : position
    );
    this.positions.clear();
    const ok = await this.withRetries("positions", batch.length, () =>
      this.insertRows("positions", POSITION_COLUMNS, batch.map(positionRow), POSITION_UPSERT_CONFLICT)
    );
    if (ok) {
      this.counters.positionsWritten += batch.length;
      return;
    }
    for (const position of batch) {
      if (!this.positions.has(position.id) && !this.discards.has(position.id)) {
        this.positions.set(position.id, position);
      }
    }
  }

  private async writeDiscards(): Promise<void> {
    if (this.discards.size === 0) {
      return;
    }
    const ids = [...this.discards];
    const ok = await this.withRetries("position_discards", ids.length, async () => {
      await this.db.query("DELETE FROM positions WHERE id = ANY($1::text[]) AND status = 'pending'", [ids]);
    });
    if (ok) {
      for (const id of ids) {
        this.discards.delete(id);
      }
    }
  }

  private signalRows(entries: readonly BufferedSignal[], withId: boolean): Row[] {
    return entries.map((entry) => {
      const record = { ...entry.record, launchId: this.launchIdFor(entry.record.signal.mint, entry.record.launchId) };
      const row = signalRow(entry.id, entry.runId, record);
      return withId ? row : row.slice(1);
    });
  }

  private async writeFills(): Promise<void> {
    if (this.fills.length === 0) {
      return;
    }
    const batch = this.fills.splice(0, this.fills.length);
    const ok = await this.withRetries("fills", batch.length, () =>
      this.insertRows("fills", FILL_COLUMNS, batch, FILL_INSERT_CONFLICT)
    );
    if (ok) {
      this.counters.fillsWritten += batch.length;
      return;
    }
    this.fills = [...batch, ...this.fills];
    this.counters.droppedRows += capFront(this.fills, this.maxBufferedRows);
  }

  private async writeSignals(): Promise<void> {
    if (this.signalsWithId.length > 0) {
      const batch = this.signalsWithId.splice(0, this.signalsWithId.length);
      const ok = await this.withRetries("signals", batch.length, () =>
        this.insertRows("signals", SIGNAL_COLUMNS, this.signalRows(batch, true), SIGNAL_INSERT_CONFLICT)
      );
      if (ok) {
        this.counters.signalsWritten += batch.length;
      } else {
        this.signalsWithId = [...batch, ...this.signalsWithId];
      }
    }
    if (this.signalsWithoutId.length > 0) {
      const batch = this.signalsWithoutId.splice(0, this.signalsWithoutId.length);
      const ok = await this.withRetries("signals", batch.length, () =>
        this.insertRows("signals", SIGNAL_COLUMNS.slice(1), this.signalRows(batch, false), "")
      );
      if (ok) {
        this.counters.signalsWritten += batch.length;
      } else {
        this.signalsWithoutId = [...batch, ...this.signalsWithoutId];
      }
    }
  }

  private async writeRiskStates(): Promise<void> {
    if (this.riskStates.size === 0) {
      return;
    }
    const batch = [...this.riskStates.values()];
    this.riskStates.clear();
    for (const state of batch) {
      const ok = await this.withRetries("risk_state", 1, () => saveRiskStateRow(this.db, state));
      if (ok) {
        this.counters.riskStatesWritten += 1;
      } else if (!this.riskStates.has(state.runId)) {
        this.riskStates.set(state.runId, state);
      }
    }
  }

  private async writeRiskEvents(): Promise<void> {
    if (this.riskEvents.length === 0) {
      return;
    }
    const batch = this.riskEvents.splice(0, this.riskEvents.length);
    for (let start = 0; start < batch.length; start += RISK_EVENT_CHUNK) {
      const chunk = batch.slice(start, start + RISK_EVENT_CHUNK);
      const ok = await this.withRetries("risk_events", chunk.length, () => insertRiskEvents(this.db, chunk));
      if (ok) {
        this.counters.riskEventsWritten += chunk.length;
        continue;
      }
      this.riskEvents = [...batch.slice(start), ...this.riskEvents];
      this.counters.droppedRows += capFront(this.riskEvents, this.maxBufferedRows);
      return;
    }
  }
}
