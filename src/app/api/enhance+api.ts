import { createEnhanceHandler } from '@/server/enhanceHandler';
import { ApiError } from '@/server/errors';
import { memoryStore } from '@/server/memoryStore';
import { createDefaultRateLimiter, createRateLimiter, parseDailyLimit, type RateLimiter } from '@/server/rateLimit';
import { createDefaultFalUpscaler } from '@/server/upscaler/fal';
import type { Upscaler } from '@/server/upscaler/types';

const configError = () => new ApiError('provider_error', 'The enhancement service is not configured.', 500);

let upscaler: Upscaler | undefined;
let rateLimiter: RateLimiter | undefined;

export const POST = createEnhanceHandler({
  getUpscaler() {
    if (!process.env.FAL_KEY) throw configError();
    return (upscaler ??= createDefaultFalUpscaler(process.env.FAL_KEY));
  },
  getRateLimiter() {
    if (rateLimiter) return rateLimiter;
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      return (rateLimiter = createDefaultRateLimiter(process.env));
    }
    // Local development only: counters live in memory and reset when the dev server restarts.
    if (process.env.NODE_ENV === 'development') {
      return (rateLimiter = createRateLimiter(memoryStore(), parseDailyLimit(process.env.DAILY_LIMIT)));
    }
    throw configError();
  },
});
