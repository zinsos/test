export class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(
    private readonly maxSize: number,
    private readonly onEvict: ((key: K, value: V) => void) | null = null
  ) {
    if (maxSize <= 0) {
      throw new Error("lru size must be positive");
    }
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    const previous = this.map.get(key);
    if (previous !== undefined) {
      this.map.delete(key);
      this.onEvict?.(key, previous);
    }
    this.map.set(key, value);
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next();
      if (oldest.done) {
        break;
      }
      const evicted = this.map.get(oldest.value);
      this.map.delete(oldest.value);
      if (evicted !== undefined) {
        this.onEvict?.(oldest.value, evicted);
      }
    }
  }

  delete(key: K): boolean {
    const value = this.map.get(key);
    if (value === undefined) {
      return false;
    }
    this.map.delete(key);
    this.onEvict?.(key, value);
    return true;
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  clear(): void {
    for (const [key, value] of this.map) {
      this.onEvict?.(key, value);
    }
    this.map.clear();
  }
}
