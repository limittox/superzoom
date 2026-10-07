import type { SortedSetStore } from './rateLimit';

/** In-memory sorted sets: used by tests, and by local development when Upstash isn't configured. */
export function memoryStore(): SortedSetStore & { sets: Map<string, Map<string, number>> } {
  const sets = new Map<string, Map<string, number>>();
  const get = (key: string) => {
    if (!sets.has(key)) sets.set(key, new Map());
    return sets.get(key)!;
  };
  return {
    sets,
    async removeOlderThan(key, cutoffMs) {
      for (const [member, score] of get(key)) if (score <= cutoffMs) get(key).delete(member);
    },
    async count(key) {
      return get(key).size;
    },
    async oldestScore(key) {
      const scores = [...get(key).values()];
      return scores.length ? Math.min(...scores) : null;
    },
    async add(key, scoreMs, member) {
      get(key).set(member, scoreMs);
    },
  };
}
