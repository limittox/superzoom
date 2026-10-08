import { Redis } from '@upstash/redis';

import { createEnhanceHandlers } from './enhanceHandler';
import { ApiError } from './errors';
import { type JobStore, sharedMemoryJobStore, upstashJobStore } from './jobStore';
import { sharedMemoryStore } from './memoryStore';
import { createRateLimiter, parseDailyLimit, type RateLimiter, upstashStore } from './rateLimit';
import { createDefaultFalUpscaler } from './upscaler/fal';
import { uploadSaverFromEnv } from './uploadSaver';
import type { Upscaler } from './upscaler/types';

const configError = () => new ApiError('provider_error', 'The enhancement service is not configured.', 500);

let redis: Redis | undefined;
let upscaler: Upscaler | undefined;
let rateLimiter: RateLimiter | undefined;
let jobStore: JobStore | undefined;
let handlers: ReturnType<typeof createEnhanceHandlers> | undefined;

/** Upstash when configured; null in development without it, where memory stores stand in. */
function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return (redis ??= new Redis({ url, token }));
  // Local development only: counters and jobs live in memory and reset when the dev server restarts.
  if (process.env.NODE_ENV === 'development') return null;
  throw configError();
}

/** The job API handlers shared by `/api/enhance` and `/api/enhance/[id]`, with clients built on first use. */
export function enhanceHandlers() {
  return (handlers ??= createEnhanceHandlers({
    getUpscaler() {
      if (!process.env.FAL_KEY) throw configError();
      return (upscaler ??= createDefaultFalUpscaler(process.env.FAL_KEY));
    },
    getRateLimiter() {
      if (rateLimiter) return rateLimiter;
      const client = getRedis();
      const limit = parseDailyLimit(process.env.DAILY_LIMIT);
      return (rateLimiter = createRateLimiter(client ? upstashStore(client) : sharedMemoryStore(), limit));
    },
    getJobStore() {
      if (jobStore) return jobStore;
      const client = getRedis();
      return (jobStore = client ? upstashJobStore(client) : sharedMemoryJobStore());
    },
    // Development only: never keep uploads in production (specs/image-enhancement: No image retention).
    saveUpload: uploadSaverFromEnv(process.env),
  }));
}
