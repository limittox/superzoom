import type { Redis } from '@upstash/redis';

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
  it('maps operations onto a mocked Redis client', async () => {
    const exec = jest.fn().mockResolvedValue([1, 1]);
    const pipeline = { zadd: jest.fn(), pexpire: jest.fn(), exec };
    pipeline.zadd.mockReturnValue(pipeline);
    pipeline.pexpire.mockReturnValue(pipeline);
    const redis = {
      zremrangebyscore: jest.fn().mockResolvedValue(0),
      zcard: jest.fn().mockResolvedValue(50),
      zrange: jest.fn().mockResolvedValue(['m', String(T0)]),
      pipeline: jest.fn().mockReturnValue(pipeline),
    };
    const limiter = createRateLimiter(upstashStore(redis as unknown as Redis), 50);

    const result = await limiter.check('x', T0 + HOUR);

    expect(redis.zremrangebyscore).toHaveBeenCalledWith('rl:x', 0, T0 + HOUR - 24 * HOUR);
    expect(redis.zrange).toHaveBeenCalledWith('rl:x', 0, 0, { withScores: true });
    expect(result).toEqual({ allowed: false, retryAt: new Date(T0 + 24 * HOUR) });

    redis.zcard.mockResolvedValue(0);
    await limiter.check('x', T0 + HOUR);
    expect(pipeline.zadd).toHaveBeenCalledWith('rl:x', { score: T0 + HOUR, member: expect.any(String) });
    expect(pipeline.pexpire).toHaveBeenCalledWith('rl:x', 24 * HOUR);
    expect(exec).toHaveBeenCalled();
  });
});
