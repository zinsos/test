import type { Clock, TimerHandle } from "../core/clock.js";
import { moduleLogger } from "../core/logger.js";

const log = moduleLogger("app.repeater");

export interface RepeaterOptions {
  clock: Clock;
  name: string;
  intervalMs: number;
  run: () => void | Promise<void>;
  initialDelayMs?: number;
}

export class Repeater {
  private readonly options: RepeaterOptions;
  private handle: TimerHandle | null = null;
  private running = false;
  private inflight: Promise<void> | null = null;

  constructor(options: RepeaterOptions) {
    this.options = options;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.scheduleIn(this.options.initialDelayMs ?? this.options.intervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.handle) {
      this.options.clock.cancel(this.handle);
      this.handle = null;
    }
    await this.inflight;
  }

  async runNow(): Promise<void> {
    if (this.inflight) {
      return this.inflight;
    }
    const work = Promise.resolve()
      .then(() => this.options.run())
      .catch((error: unknown) => {
        log.error({ err: error, task: this.options.name }, "periodic task failed");
      })
      .finally(() => {
        this.inflight = null;
      });
    this.inflight = work;
    return work;
  }

  private scheduleIn(delayMs: number): void {
    const clock = this.options.clock;
    this.handle = clock.schedule(clock.nowMs() + delayMs, async () => {
      this.handle = null;
      if (!this.running) {
        return;
      }
      await this.runNow();
      if (this.running) {
        this.scheduleIn(this.options.intervalMs);
      }
    });
  }
}
