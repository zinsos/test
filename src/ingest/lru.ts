export class BoundedSet<T> {
  private readonly entries = new Map<T, true>();

  constructor(private readonly capacity: number) {
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new Error("BoundedSet capacity must be at least 1");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  has(value: T): boolean {
    return this.entries.has(value);
  }

  addIfAbsent(value: T): boolean {
    if (this.entries.has(value)) {
      return false;
    }
    this.entries.set(value, true);
    this.trim();
    return true;
  }

  delete(value: T): boolean {
    return this.entries.delete(value);
  }

  clear(): void {
    this.entries.clear();
  }

  private trim(): void {
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        return;
      }
      this.entries.delete(oldest.value);
    }
  }
}
