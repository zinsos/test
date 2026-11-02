export type TimerCallback = () => void | Promise<void>;

export interface TimerHandle {
  readonly id: number;
}

export interface Clock {
  nowMs(): number;
  schedule(atMs: number, fn: TimerCallback): TimerHandle;
  cancel(handle: TimerHandle): void;
  sleepUntil(atMs: number): Promise<void>;
  readonly virtual: boolean;
}

const flushMacrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class SystemClock implements Clock {
  readonly virtual = false;
  private nextId = 1;
  private readonly timers = new Map<number, NodeJS.Timeout>();

  nowMs(): number {
    return Date.now();
  }

  schedule(atMs: number, fn: TimerCallback): TimerHandle {
    const id = this.nextId++;
    const delay = Math.max(0, atMs - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(id);
      Promise.resolve()
        .then(fn)
        .catch(() => undefined);
    }, delay);
    timer.unref?.();
    this.timers.set(id, timer);
    return { id };
  }

  cancel(handle: TimerHandle): void {
    const timer = this.timers.get(handle.id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(handle.id);
    }
  }

  sleepUntil(atMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.schedule(atMs, resolve);
    });
  }
}

interface VirtualTimer {
  id: number;
  atMs: number;
  order: number;
  fn: TimerCallback;
}

export class VirtualClock implements Clock {
  readonly virtual = true;
  private now: number;
  private nextId = 1;
  private nextOrder = 1;
  private heap: VirtualTimer[] = [];
  private readonly cancelled = new Set<number>();
  private readonly active = new Set<number>();
  private readonly errors: unknown[] = [];

  constructor(startMs: number) {
    this.now = startMs;
  }

  nowMs(): number {
    return this.now;
  }

  schedule(atMs: number, fn: TimerCallback): TimerHandle {
    const id = this.nextId++;
    this.active.add(id);
    this.push({ id, atMs: Math.max(atMs, this.now), order: this.nextOrder++, fn });
    return { id };
  }

  cancel(handle: TimerHandle): void {
    if (this.active.delete(handle.id)) {
      this.cancelled.add(handle.id);
    }
  }

  sleepUntil(atMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.schedule(atMs, resolve);
    });
  }

  pendingCount(): number {
    return this.active.size;
  }

  nextDueMs(): number | null {
    this.dropCancelledHead();
    return this.heap[0]?.atMs ?? null;
  }

  drainErrors(): unknown[] {
    return this.errors.splice(0, this.errors.length);
  }

  async advanceTo(targetMs: number): Promise<void> {
    if (targetMs < this.now) {
      await flushMacrotask();
      return;
    }
    for (;;) {
      this.dropCancelledHead();
      const head = this.heap[0];
      if (!head || head.atMs > targetMs) {
        break;
      }
      this.pop();
      this.active.delete(head.id);
      this.now = Math.max(this.now, head.atMs);
      try {
        await head.fn();
      } catch (error) {
        this.errors.push(error);
      }
      await flushMacrotask();
    }
    this.now = targetMs;
    await flushMacrotask();
  }

  async runUntilIdle(limitMs: number): Promise<void> {
    for (;;) {
      const due = this.nextDueMs();
      if (due === null || due > limitMs) {
        break;
      }
      await this.advanceTo(due);
    }
  }

  private dropCancelledHead(): void {
    while (this.heap.length > 0) {
      const head = this.heap[0];
      if (head && this.cancelled.has(head.id)) {
        this.cancelled.delete(head.id);
        this.pop();
      } else {
        break;
      }
    }
  }

  private less(a: VirtualTimer, b: VirtualTimer): boolean {
    return a.atMs < b.atMs || (a.atMs === b.atMs && a.order < b.order);
  }

  private push(timer: VirtualTimer): void {
    const heap = this.heap;
    heap.push(timer);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const parentTimer = heap[parent];
      const current = heap[index];
      if (!parentTimer || !current || !this.less(current, parentTimer)) {
        break;
      }
      heap[parent] = current;
      heap[index] = parentTimer;
      index = parent;
    }
  }

  private pop(): VirtualTimer | undefined {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last) {
      heap[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        const leftTimer = heap[left];
        const rightTimer = heap[right];
        const smallestTimer = heap[smallest];
        if (leftTimer && smallestTimer && this.less(leftTimer, smallestTimer)) {
          smallest = left;
        }
        const candidate = heap[smallest];
        if (rightTimer && candidate && this.less(rightTimer, candidate)) {
          smallest = right;
        }
        if (smallest === index) {
          break;
        }
        const a = heap[index];
        const b = heap[smallest];
        if (!a || !b) {
          break;
        }
        heap[index] = b;
        heap[smallest] = a;
        index = smallest;
      }
    }
    return top;
  }
}
