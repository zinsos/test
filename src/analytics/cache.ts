export interface TtlCacheOptions {
  ttlMs: number;
  maxEntries: number;
  now: () => number;
}

interface CacheEntry {
  expiresAtMs: number;
  value: Promise<unknown>;
}

export class TtlCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly options: TtlCacheOptions) {}

  get size(): number {
    return this.entries.size;
  }

  getOrLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (this.options.ttlMs <= 0 || this.options.maxEntries <= 0) {
      return load();
    }
    const now = this.options.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAtMs > now) {
      return hit.value as Promise<T>;
    }
    const value = load();
    this.entries.delete(key);
    this.entries.set(key, { expiresAtMs: now + this.options.ttlMs, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) {
        this.entries.delete(key);
      }
    });
    this.evict(now);
    return value;
  }

  clear(): void {
    this.entries.clear();
  }

  private evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs <= now) {
        this.entries.delete(key);
      }
    }
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        return;
      }
      this.entries.delete(oldest.value);
    }
  }
}
