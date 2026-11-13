import type { Clock, TimerCallback, TimerHandle, VirtualClock } from "../core/clock.js";

export class ScopedClock implements Clock {
  readonly virtual = true;
  private readonly pending = new Map<number, number>();

  constructor(private readonly base: VirtualClock) {}

  nowMs(): number {
    return this.base.nowMs();
  }

  schedule(atMs: number, fn: TimerCallback): TimerHandle {
    const dueMs = Math.max(atMs, this.base.nowMs());
    const handle = this.base.schedule(atMs, () => {
      this.pending.delete(handle.id);
      return fn();
    });
    this.pending.set(handle.id, dueMs);
    return handle;
  }

  cancel(handle: TimerHandle): void {
    this.pending.delete(handle.id);
    this.base.cancel(handle);
  }

  sleepUntil(atMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.schedule(atMs, resolve);
    });
  }

  nextDueMs(): number | null {
    let next: number | null = null;
    for (const atMs of this.pending.values()) {
      if (next === null || atMs < next) {
        next = atMs;
      }
    }
    return next;
  }

  pendingCount(): number {
    return this.pending.size;
  }
}

export function earliest(a: number | null, b: number | null): number | null {
  if (a === null) {
    return b;
  }
  return b === null ? a : Math.min(a, b);
}
