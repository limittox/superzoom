import type { Redis } from '@upstash/redis';

const WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DAILY_LIMIT = 50;

/** The sorted-set operations the limiter needs; implemented by Upstash Redis or a test fake. */
export interface SortedSetStore {
  removeOlderThan(key: string, cutoffMs: number): Promise<void>;
  count(key: string): Promise<number>;
  oldestScore(key: string): Promise<number | null>;
  add(key: string, scoreMs: number, member: string, ttlMs: number): Promise<void>;
}

export type RateLimitResult = { allowed: true; remaining: number } | { allowed: false; retryAt: Date };

export interface RateLimiter {
  check(installId: string, nowMs?: number): Promise<RateLimitResult>;
}

/**
 * Sliding 24-hour window per app installation (design.md decision 8).
 * Not atomic: concurrent requests from one install can overshoot by a request or two,
 * which is acceptable for a cost guard.
 */
export function createRateLimiter(store: SortedSetStore, limit: number = DEFAULT_DAILY_LIMIT): RateLimiter {
  return {
    async check(installId, nowMs = Date.now()) {
      const key = `rl:${installId}`;
      await store.removeOlderThan(key, nowMs - WINDOW_MS);
      const used = await store.count(key);
      if (used >= limit) {
        const oldest = (await store.oldestScore(key)) ?? nowMs;
        return { allowed: false, retryAt: new Date(oldest + WINDOW_MS) };
      }
      await store.add(key, nowMs, `${nowMs}:${crypto.randomUUID()}`, WINDOW_MS);
      return { allowed: true, remaining: limit - used - 1 };
    },
  };
}

export function upstashStore(redis: Redis): SortedSetStore {
  return {
    async removeOlderThan(key, cutoffMs) {
      await redis.zremrangebyscore(key, 0, cutoffMs);
    },
    count: (key) => redis.zcard(key),
    async oldestScore(key) {
      const [, score] = await redis.zrange<(string | number)[]>(key, 0, 0, { withScores: true });
      return score == null ? null : Number(score);
    },
    async add(key, scoreMs, member, ttlMs) {
      await redis.pipeline().zadd(key, { score: scoreMs, member }).pexpire(key, ttlMs).exec();
    },
  };
}

export function parseDailyLimit(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_DAILY_LIMIT;
}
