import type { WindowStore } from './rateLimit';

/** In-memory sliding windows: used by tests, and by local development when Upstash isn't configured. */
export function memoryStore(): WindowStore & { sets: Map<string, Map<string, number>> } {
  const sets = new Map<string, Map<string, number>>();
  const get = (key: string) => {
    if (!sets.has(key)) sets.set(key, new Map());
    return sets.get(key)!;
  };
  return {
    sets,
    async hit(key, { cutoffMs, limit, nowMs, member }) {
      const set = get(key);
      for (const [m, score] of set) if (score <= cutoffMs) set.delete(m);
      const used = set.size;
      if (used >= limit) return { allowed: false, used, oldestMs: Math.min(...set.values()) };
      set.set(member, nowMs);
      return { allowed: true, used, oldestMs: null };
    },
  };
}

/**
 * The development rate-limit store. Each Expo Router API route is bundled separately, so it
 * lives on `globalThis` for all routes to share one set of counters. Keyed by version, so a hot
 * reload that changed `WindowStore` doesn't keep an instance built by older code.
 */
const MEMORY_STORE_VERSION = 2;

export function sharedMemoryStore(): WindowStore {
  const g = globalThis as { __superzoomRateLimitStore?: { version: number; store: WindowStore } };
  if (g.__superzoomRateLimitStore?.version !== MEMORY_STORE_VERSION) {
    g.__superzoomRateLimitStore = { version: MEMORY_STORE_VERSION, store: memoryStore() };
  }
  return g.__superzoomRateLimitStore.store;
}
