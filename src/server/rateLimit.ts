import type { Redis } from '@upstash/redis';

const WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DAILY_LIMIT = 50;

/** One sliding-window check: drop entries older than `cutoffMs`, then add one unless `limit` is reached. */
export interface WindowHit {
  cutoffMs: number;
  limit: number;
  nowMs: number;
  member: string;
  ttlMs: number;
}

/** `used` counts entries before this hit; `oldestMs` is set when the hit was refused. */
export interface WindowHitResult {
  allowed: boolean;
  used: number;
  oldestMs: number | null;
}

/** The window operation the limiter needs, in one round trip; implemented by Upstash Redis or memory. */
export interface WindowStore {
  hit(key: string, hit: WindowHit): Promise<WindowHitResult>;
}

export type RateLimitResult = { allowed: true; remaining: number } | { allowed: false; retryAt: Date };

export interface RateLimiter {
  check(installId: string, nowMs?: number): Promise<RateLimitResult>;
}

/** Sliding 24-hour window per app installation (design.md decision 8), checked and counted atomically. */
export function createRateLimiter(store: WindowStore, limit: number = DEFAULT_DAILY_LIMIT): RateLimiter {
  return {
    async check(installId, nowMs = Date.now()) {
      const result = await store.hit(`rl:${installId}`, {
        cutoffMs: nowMs - WINDOW_MS,
        limit,
        nowMs,
        member: `${nowMs}:${crypto.randomUUID()}`,
        ttlMs: WINDOW_MS,
      });
      if (!result.allowed) return { allowed: false, retryAt: new Date((result.oldestMs ?? nowMs) + WINDOW_MS) };
      return { allowed: true, remaining: limit - result.used - 1 };
    },
  };
}

/**
 * One script, so a check costs one request: EAS Hosting allows a request only 10 outgoing calls
 * (see docs/backend.md). Returns {allowed (0/1), used, oldest score or ""}.
 */
const HIT_SCRIPT = `
redis.call("ZREMRANGEBYSCORE", KEYS[1], 0, ARGV[1])
local used = redis.call("ZCARD", KEYS[1])
if used >= tonumber(ARGV[2]) then
  local oldest = redis.call("ZRANGE", KEYS[1], 0, 0, "WITHSCORES")
  return {0, used, oldest[2] or ""}
end
redis.call("ZADD", KEYS[1], ARGV[3], ARGV[4])
redis.call("PEXPIRE", KEYS[1], ARGV[5])
return {1, used, ""}`;

export function upstashStore(redis: Redis): WindowStore {
  return {
    async hit(key, { cutoffMs, limit, nowMs, member, ttlMs }) {
      const [allowed, used, oldest] = await redis.eval<string[], [number, number, number | string]>(
        HIT_SCRIPT,
        [key],
        [String(cutoffMs), String(limit), String(nowMs), member, String(ttlMs)],
      );
      return {
        allowed: Number(allowed) === 1,
        used: Number(used),
        oldestMs: oldest === '' || oldest == null ? null : Number(oldest),
      };
    },
  };
}

export function parseDailyLimit(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_DAILY_LIMIT;
}
