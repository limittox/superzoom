import type { Redis } from '@upstash/redis';

import type { EnhanceError, EnhanceMode, EnhanceSuccess, JobState } from '@/shared/enhance';

/** Jobs and their idempotency keys expire this long after the job is created (fal's objects expire after 1 h too). */
export const JOB_TTL_MS = 60 * 60 * 1000;
/** Long enough for one advance (a fal status, result and submit call), short enough to recover from a crashed one. */
export const JOB_LOCK_MS = 15_000;

/**
 * One enhancement job (enhance-job-api design decision 2). Holds fal URLs and metadata only,
 * never image data.
 */
export interface JobRecord {
  id: string;
  installId: string;
  mode: EnhanceMode;
  createdAt: number;
  status: JobState;
  /** Planned factor of each provider pass, and the planned output size. */
  passes: number[];
  outputWidth: number;
  outputHeight: number;
  /** 0-based index of the pass that is queued or running. */
  passIndex: number;
  /** The provider's request ID for the active pass, once it is queued. */
  providerRequestId?: string;
  passQueuedAt?: number;
  /** Provider URL of the active pass's input: the upload, or the previous pass's output. */
  sourceUrl?: string;
  result?: EnhanceSuccess;
  error?: EnhanceError['error'];
}

export interface JobStore {
  get(id: string): Promise<JobRecord | null>;
  /** Saves the job; it expires `JOB_TTL_MS` after `createdAt`. */
  put(job: JobRecord): Promise<void>;
  /** The job ID a submission with this request ID created, if any. */
  findRequest(installId: string, requestId: string): Promise<string | null>;
  /** Records `jobId` for this request ID unless one is already recorded; returns the winner's job ID. */
  claimRequest(installId: string, requestId: string, jobId: string, createdAt: number): Promise<string>;
  releaseRequest(installId: string, requestId: string): Promise<void>;
  /** Takes the job's advance lock; false if someone else holds it. */
  lock(id: string): Promise<boolean>;
  unlock(id: string): Promise<void>;
}

const jobKey = (id: string) => `job:${id}`;
const requestKey = (installId: string, requestId: string) => `jobreq:${installId}:${requestId}`;
const lockKey = (id: string) => `job:${id}:lock`;
/** Remaining lifetime of a job created at `createdAt`; at least 1 ms so the store accepts it. */
const remainingMs = (createdAt: number, now: number) => Math.max(1, createdAt + JOB_TTL_MS - now);

export function upstashJobStore(redis: Redis, now: () => number = Date.now): JobStore {
  return {
    async get(id) {
      return (await redis.get<JobRecord>(jobKey(id))) ?? null;
    },
    async put(job) {
      await redis.set(jobKey(job.id), job, { px: remainingMs(job.createdAt, now()) });
    },
    async findRequest(installId, requestId) {
      return (await redis.get<string>(requestKey(installId, requestId))) ?? null;
    },
    async claimRequest(installId, requestId, jobId, createdAt) {
      const key = requestKey(installId, requestId);
      const claimed = await redis.set(key, jobId, { nx: true, px: remainingMs(createdAt, now()) });
      if (claimed === 'OK') return jobId;
      return (await redis.get<string>(key)) ?? jobId;
    },
    async releaseRequest(installId, requestId) {
      await redis.del(requestKey(installId, requestId));
    },
    async lock(id) {
      return (await redis.set(lockKey(id), '1', { nx: true, px: JOB_LOCK_MS })) === 'OK';
    },
    async unlock(id) {
      await redis.del(lockKey(id));
    },
  };
}

/** In-memory job store for tests and for local development without Upstash. */
export function memoryJobStore(now: () => number = Date.now): JobStore {
  const values = new Map<string, { value: unknown; expiresAt: number }>();
  const read = <T>(key: string): T | null => {
    const entry = values.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      values.delete(key);
      return null;
    }
    return entry.value as T;
  };
  const write = (key: string, value: unknown, ttlMs: number) => values.set(key, { value, expiresAt: now() + ttlMs });

  return {
    async get(id) {
      const job = read<JobRecord>(jobKey(id));
      // Copy, as Redis would, so callers can't change the stored job by mutating what they read.
      return job ? (JSON.parse(JSON.stringify(job)) as JobRecord) : null;
    },
    async put(job) {
      write(jobKey(job.id), JSON.parse(JSON.stringify(job)), remainingMs(job.createdAt, now()));
    },
    async findRequest(installId, requestId) {
      return read<string>(requestKey(installId, requestId));
    },
    async claimRequest(installId, requestId, jobId, createdAt) {
      const key = requestKey(installId, requestId);
      const existing = read<string>(key);
      if (existing) return existing;
      write(key, jobId, remainingMs(createdAt, now()));
      return jobId;
    },
    async releaseRequest(installId, requestId) {
      values.delete(requestKey(installId, requestId));
    },
    async lock(id) {
      if (read(lockKey(id))) return false;
      write(lockKey(id), true, JOB_LOCK_MS);
      return true;
    },
    async unlock(id) {
      values.delete(lockKey(id));
    },
  };
}

/**
 * The development job store. Each Expo Router API route is bundled separately, so it lives on
 * `globalThis` for the submit and job routes to share.
 */
export function sharedMemoryJobStore(): JobStore {
  const g = globalThis as { __superzoomJobStore?: JobStore };
  return (g.__superzoomJobStore ??= memoryJobStore());
}
