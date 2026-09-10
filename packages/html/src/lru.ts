// A tiny insertion-ordered LRU over string keys — the shape gsw's hot-path memos share
// (`webgl/runtime`'s `staticFrameCache` was the first of them, hand-rolled). A `Map` iterates in
// insertion order, so the "oldest" entry is just the first key and a hit re-inserts to bump it.
//
// Every consumer memoizes a PURE function, so a hit is byte-identical to a fresh compute and the
// cache is invisible except in cost. Each exposes its own `__reset…ForTest` hook (these are
// module-scoped and survive across tests, so a test that counts computes must start empty).

export interface StringLru<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  clear(): void;
  readonly size: number;
}

export function createStringLru<T>(limit: number): StringLru<T> {
  const entries = new Map<string, T>();
  return {
    get(key) {
      const hit = entries.get(key);
      if (hit === undefined) {
        return undefined;
      }
      entries.delete(key);
      entries.set(key, hit); // LRU bump
      return hit;
    },
    set(key, value) {
      entries.set(key, value);
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        entries.delete(oldest);
      }
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
