import { BatchWriter, type BatchTableSpec, type Row } from "../db/batch.js";
import type { Db } from "../db/pool.js";

export interface SerialBatchWriterOptions {
  flushIntervalMs: number;
  flushAtRows: number;
  maxRetries: number;
}

export class SerialBatchWriter {
  private readonly writer: BatchWriter;
  private readonly options: SerialBatchWriterOptions;
  private chain: Promise<void> = Promise.resolve();
  private unflushed = 0;
  private earlyFlushPending = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(db: Db, specs: readonly BatchTableSpec[], options: SerialBatchWriterOptions) {
    this.options = options;
    this.writer = new BatchWriter(db, {
      flushIntervalMs: options.flushIntervalMs,
      maxBufferedRows: Number.MAX_SAFE_INTEGER,
      maxRetries: options.maxRetries
    });
    for (const spec of specs) {
      this.writer.register(spec);
    }
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
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  push(table: string, row: Row): void {
    this.writer.push(table, row);
    this.unflushed += 1;
    if (this.unflushed >= this.options.flushAtRows && !this.earlyFlushPending) {
      this.earlyFlushPending = true;
      void this.flush().finally(() => {
        this.earlyFlushPending = false;
      });
    }
  }

  flush(): Promise<void> {
    const run = this.chain.then(async () => {
      this.unflushed = 0;
      await this.writer.flush();
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  stats(): { buffered: number; written: number; dropped: number } {
    return this.writer.stats();
  }
}
