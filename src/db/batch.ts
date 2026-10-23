import { moduleLogger } from "../core/logger.js";
import type { Db } from "./pool.js";

const log = moduleLogger("batch");
const MAX_PARAMS = 60_000;

export interface BatchTableSpec {
  table: string;
  columns: readonly string[];
  conflict: string;
  returning?: string;
}

export type Row = readonly unknown[];
export type ReturnedRow = Record<string, unknown>;

export interface BatchWriterHooks {
  onInserted?: (table: string, rows: readonly ReturnedRow[]) => void;
  onDropped?: (table: string, rows: readonly Row[], error: unknown) => void;
}

export interface BatchWriterOptions extends BatchWriterHooks {
  flushIntervalMs: number;
  maxBufferedRows: number;
  maxRetries: number;
  maxBackoffMs?: number;
  retriesWhenStopping?: number;
}

const BASE_BACKOFF_MS = 250;

export class BatchWriter {
  private readonly buffers = new Map<string, Row[]>();
  private readonly specs = new Map<string, BatchTableSpec>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private droppedRows = 0;
  private writtenRows = 0;
  private stopping = false;
  private readonly wakers = new Set<() => void>();

  constructor(
    private readonly db: Db,
    private readonly options: BatchWriterOptions
  ) {}

  register(spec: BatchTableSpec): void {
    this.specs.set(spec.table, spec);
    this.buffers.set(spec.table, []);
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.flush();
    }, this.options.flushIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.beginStop();
    await this.flush();
  }

  beginStop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopping = true;
    for (const wake of [...this.wakers]) {
      wake();
    }
  }

  push(table: string, row: Row): void {
    const buffer = this.buffers.get(table);
    if (!buffer) {
      throw new Error(`table ${table} not registered`);
    }
    buffer.push(row);
    if (buffer.length >= this.options.maxBufferedRows) {
      void this.flush();
    }
  }

  stats(): { buffered: number; written: number; dropped: number } {
    let buffered = 0;
    for (const buffer of this.buffers.values()) {
      buffered += buffer.length;
    }
    return { buffered, written: this.writtenRows, dropped: this.droppedRows };
  }

  async flush(): Promise<void> {
    const previous = this.flushing ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.flushAll());
    this.flushing = current;
    try {
      await current;
    } finally {
      if (this.flushing === current) {
        this.flushing = null;
      }
    }
  }

  private async flushAll(): Promise<void> {
    for (const [table, buffer] of this.buffers) {
      if (buffer.length === 0) {
        continue;
      }
      const spec = this.specs.get(table);
      if (!spec) {
        continue;
      }
      const rows = buffer.splice(0, buffer.length);
      const chunkSize = Math.max(1, Math.floor(MAX_PARAMS / spec.columns.length));
      for (let start = 0; start < rows.length; start += chunkSize) {
        await this.writeChunk(spec, rows.slice(start, start + chunkSize));
      }
    }
  }

  private async writeChunk(spec: BatchTableSpec, rows: Row[]): Promise<void> {
    const params: unknown[] = [];
    const tuples: string[] = [];
    for (const row of rows) {
      const placeholders: string[] = [];
      for (const value of row) {
        params.push(typeof value === "bigint" ? value.toString() : value);
        placeholders.push(`$${params.length}`);
      }
      tuples.push(`(${placeholders.join(",")})`);
    }
    const returning = spec.returning ? ` RETURNING ${spec.returning}` : "";
    const sql = `INSERT INTO ${spec.table} (${spec.columns.join(",")}) VALUES ${tuples.join(",")} ${spec.conflict}${returning}`;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.db.query<ReturnedRow>(sql, params);
        this.writtenRows += rows.length;
        if (spec.returning) {
          this.notify(() => this.options.onInserted?.(spec.table, result.rows));
        }
        return;
      } catch (error) {
        if (attempt >= this.retryLimit()) {
          this.droppedRows += rows.length;
          log.error({ err: error, table: spec.table, rows: rows.length, attempts: attempt + 1 }, "batch insert failed, rows dropped");
          this.notify(() => this.options.onDropped?.(spec.table, rows, error));
          return;
        }
        await this.sleep(Math.min(this.options.maxBackoffMs ?? Number.POSITIVE_INFINITY, BASE_BACKOFF_MS * 2 ** attempt));
      }
    }
  }

  private retryLimit(): number {
    return this.stopping ? Math.min(this.options.maxRetries, this.options.retriesWhenStopping ?? 2) : this.options.maxRetries;
  }

  private notify(hook: () => void): void {
    try {
      hook();
    } catch (error) {
      log.error({ err: error }, "batch writer hook failed");
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopping) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.wakers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.wakers.add(wake);
    });
  }
}
