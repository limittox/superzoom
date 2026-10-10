import { Redis } from '@upstash/redis';

import { createRateLimiter, DEFAULT_DAILY_LIMIT, parseDailyLimit, upstashStore } from '../rateLimit';
import { memoryStore } from '../memoryStore';

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);

describe('rate limiter', () => {
  it('allows 50 requests in 24 h and rejects the 51st with a retry time', async () => {
    const limiter = createRateLimiter(memoryStore(), 50);
    for (let i = 0; i < 50; i++) {
      await expect(limiter.check('install-a', T0 + i * 60_000)).resolves.toMatchObject({ allowed: true });
    }
    const rejected = await limiter.check('install-a', T0 + 50 * 60_000);
    expect(rejected).toEqual({ allowed: false, retryAt: new Date(T0 + 24 * HOUR) });
  });

  it('allows again once the oldest request leaves the window', async () => {
    const limiter = createRateLimiter(memoryStore(), 2);
    await limiter.check('a', T0);
    await limiter.check('a', T0 + HOUR);
    expect((await limiter.check('a', T0 + 2 * HOUR)).allowed).toBe(false);
    expect((await limiter.check('a', T0 + 24 * HOUR + 1)).allowed).toBe(true);
  });

  it('counts each installation separately', async () => {
    const limiter = createRateLimiter(memoryStore(), 1);
    expect((await limiter.check('a', T0)).allowed).toBe(true);
    expect((await limiter.check('b', T0)).allowed).toBe(true);
    expect((await limiter.check('a', T0)).allowed).toBe(false);
  });

  it('reports remaining requests', async () => {
    const limiter = createRateLimiter(memoryStore(), 3);
    expect(await limiter.check('a', T0)).toEqual({ allowed: true, remaining: 2 });
  });

  it('does not record rejected requests', async () => {
    const store = memoryStore();
    const limiter = createRateLimiter(store, 1);
    await limiter.check('a', T0);
    await limiter.check('a', T0 + 1);
    expect(store.sets.get('rl:a')!.size).toBe(1);
  });
});

describe('parseDailyLimit', () => {
  it('defaults to 50', () => {
    expect(parseDailyLimit(undefined)).toBe(DEFAULT_DAILY_LIMIT);
    expect(parseDailyLimit('abc')).toBe(50);
    expect(parseDailyLimit('0')).toBe(50);
  });
  it('reads a positive integer', () => {
    expect(parseDailyLimit('5')).toBe(5);
  });
});

describe('upstashStore', () => {
  it('runs a check as one script and maps its result', async () => {
    const redis = { eval: jest.fn().mockResolvedValue([0, 50, String(T0)]) };
    const limiter = createRateLimiter(upstashStore(redis as unknown as Redis), 50);

    expect(await limiter.check('x', T0 + HOUR)).toEqual({ allowed: false, retryAt: new Date(T0 + 24 * HOUR) });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('ZREMRANGEBYSCORE'),
      ['rl:x'],
      [String(T0 + HOUR - 24 * HOUR), '50', String(T0 + HOUR), expect.any(String), String(24 * HOUR)],
    );

    redis.eval.mockResolvedValue([1, 3, '']);
    expect(await limiter.check('x', T0 + HOUR)).toEqual({ allowed: true, remaining: 46 });
    expect(redis.eval).toHaveBeenCalledTimes(2);
  });
});

const integration = process.env.UPSTASH_INTEGRATION === '1' ? describe : describe.skip;
integration('upstashStore (real Upstash)', () => {
  it('counts within the window, refuses past the limit with the oldest entry, and forgets old entries', async () => {
    const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
    const limiter = createRateLimiter(upstashStore(redis), 2);
    const install = `test-${crypto.randomUUID()}`;
    const t0 = Date.now();
    expect(await limiter.check(install, t0)).toEqual({ allowed: true, remaining: 1 });
    expect(await limiter.check(install, t0 + 1000)).toEqual({ allowed: true, remaining: 0 });
    expect(await limiter.check(install, t0 + 2000)).toEqual({ allowed: false, retryAt: new Date(t0 + 24 * HOUR) });
    expect((await limiter.check(install, t0 + 24 * HOUR + 1)).allowed).toBe(true);
    await redis.del(`rl:${install}`);
  });
});
