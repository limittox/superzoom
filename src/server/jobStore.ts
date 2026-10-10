import type { Redis } from '@upstash/redis';

import type { EnhanceError, EnhanceMode, EnhanceSuccess, JobState } from '@/shared/enhance';

/** Jobs and their idempotency keys expire this long after the job is created (fal's objects expire after 1 h too). */
export const JOB_TTL_MS = 60 * 60 * 1000;
/**
 * How long a job lock lasts: longer than one advance can take (each fal call in it is bounded,
 * see `FAL_CALL_TIMEOUT_MS`), short enough to recover from a crashed one.
 */
export const JOB_LOCK_MS = 60_000;

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

/** What `lockAndRead` found. `token` is set only for an active job whose lock this caller now holds. */
export interface LockedRead {
  job: JobRecord | null;
  token: string | null;
  cancelRequested: boolean;
}

/**
 * How a submission's last step went: its started job was `saved`; a cancel had been requested,
 * so the `cancelled` version was saved instead; the stored job had stopped waiting for its first
 * pass (cancelled, timed out or expired), so nothing was saved; or another request held the lock.
 */
export type CommitOutcome = 'saved' | 'cancelled' | 'not-waiting' | 'locked';

/**
 * Job records, request IDs, locks and cancel flags. Every method is one round trip to the store:
 * EAS Hosting allows a request only 10 outgoing calls, fal included (docs/backend.md), so the
 * steps that used to take several calls are single scripts.
 */
export interface JobStore {
  get(id: string): Promise<JobRecord | null>;
  /** Saves the job; it expires `JOB_TTL_MS` after `createdAt`. */
  put(job: JobRecord): Promise<void>;
  /** The job ID a submission with this request ID created, if any. */
  findRequest(installId: string, requestId: string): Promise<string | null>;
  /**
   * Saves a new job and records it for its request ID in one step. If the request ID already has
   * a value (a concurrent submission's job, or a cancel), saves nothing and returns that value.
   */
  create(job: JobRecord, requestId: string): Promise<string>;
  /** Records `jobId` for this request ID unless one is already recorded; returns the winner's job ID. */
  claimRequest(installId: string, requestId: string, jobId: string, createdAt: number): Promise<string>;
  releaseRequest(installId: string, requestId: string): Promise<void>;
  /**
   * Reads one installation's job (another installation's reads as missing) and, if it's active,
   * takes its lock and reads its cancel flag. With `requestCancel`, an active job's cancel flag is
   * set first, for whoever holds the lock to act on.
   */
  lockAndRead(id: string, installId: string, options?: { requestCancel?: boolean }): Promise<LockedRead>;
  /**
   * Saves `job` (unless null) and releases the lock if `token` still owns it. With
   * `yieldToCancel` (the job is still active), if a cancel was requested meanwhile, saves nothing,
   * keeps the lock and returns `cancel-requested`.
   */
  saveAndUnlock(
    id: string,
    token: string,
    job: JobRecord | null,
    options?: { yieldToCancel?: boolean },
  ): Promise<'saved' | 'cancel-requested'>;
  /** Releases the lock only if `token` still owns it (an expired lock may belong to someone else by now). */
  unlock(id: string, token: string): Promise<void>;
  /** A submission's last step, without waiting for the lock: see `CommitOutcome`. */
  commitStarted(started: JobRecord, cancelled: JobRecord): Promise<CommitOutcome>;
}

const jobKey = (id: string) => `job:${id}`;
const requestKey = (installId: string, requestId: string) => `jobreq:${installId}:${requestId}`;
const lockKey = (id: string) => `job:${id}:lock`;
const cancelKey = (id: string) => `job:${id}:cancel`;
const newToken = () => crypto.randomUUID();
/** Remaining lifetime of a job created at `createdAt`; at least 1 ms so the store accepts it. */
const remainingMs = (createdAt: number, now: number) => Math.max(1, createdAt + JOB_TTL_MS - now);
const isActive = (job: JobRecord) => job.status === 'queued' || job.status === 'processing';

// The scripts read jobs with cjson only to check fields, and always write the JSON they were
// given: re-encoding in Lua would turn an empty `passes: []` into `{}`.

/** KEYS: job, request. ARGV: job JSON, TTL, job ID. Returns the request ID's winner. */
const CREATE_SCRIPT = `
local existing = redis.call("GET", KEYS[2])
if existing then return existing end
redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
redis.call("SET", KEYS[2], ARGV[3], "PX", ARGV[2])
return ARGV[3]`;

/** KEYS: request. ARGV: job ID, TTL. Records the job ID unless one is recorded; returns the winner. */
const CLAIM_SCRIPT = `
local existing = redis.call("GET", KEYS[1])
if existing then return existing end
redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
return ARGV[1]`;

/**
 * KEYS: job, lock, cancel. ARGV: install ID, new token, lock TTL, "1" to request a cancel.
 * Returns {job JSON or "", token or "", cancel flag 0/1}.
 */
const LOCK_AND_READ_SCRIPT = `
local stored = redis.call("GET", KEYS[1])
if not stored then return {"", "", 0} end
local job = cjson.decode(stored)
if job.installId ~= ARGV[1] then return {"", "", 0} end
if job.status ~= "queued" and job.status ~= "processing" then return {stored, "", 0} end
if ARGV[4] == "1" then
  local ttl = redis.call("PTTL", KEYS[1])
  if ttl > 0 then redis.call("SET", KEYS[3], "1", "PX", ttl) end
end
local token = ""
if redis.call("SET", KEYS[2], ARGV[2], "NX", "PX", ARGV[3]) then token = ARGV[2] end
return {stored, token, redis.call("EXISTS", KEYS[3])}`;

/** KEYS: job, lock, cancel. ARGV: token, job JSON or "", TTL, "1" to yield to a cancel. */
const SAVE_AND_UNLOCK_SCRIPT = `
if ARGV[4] == "1" and redis.call("EXISTS", KEYS[3]) == 1 then return "cancel-requested" end
if ARGV[2] ~= "" then redis.call("SET", KEYS[1], ARGV[2], "PX", ARGV[3]) end
if redis.call("GET", KEYS[2]) == ARGV[1] then redis.call("DEL", KEYS[2]) end
return "saved"`;

/** KEYS: lock. ARGV: token. Deletes the lock only if it still holds this owner's token. */
const UNLOCK_SCRIPT = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`;

/** KEYS: job, lock, cancel. ARGV: started job JSON, cancelled job JSON, TTL. Returns a `CommitOutcome`. */
const COMMIT_STARTED_SCRIPT = `
if redis.call("EXISTS", KEYS[2]) == 1 then return "locked" end
local stored = redis.call("GET", KEYS[1])
if not stored then return "not-waiting" end
local job = cjson.decode(stored)
if (job.status ~= "queued" and job.status ~= "processing") or job.providerRequestId then return "not-waiting" end
if redis.call("EXISTS", KEYS[3]) == 1 then
  redis.call("SET", KEYS[1], ARGV[2], "PX", ARGV[3])
  return "cancelled"
end
redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[3])
return "saved"`;

/** The Upstash client parses JSON in script results; a job may arrive as an object or a string. */
const asJob = (value: unknown): JobRecord | null =>
  !value ? null : typeof value === 'string' ? (JSON.parse(value) as JobRecord) : (value as JobRecord);

export function upstashJobStore(redis: Redis, now: () => number = Date.now): JobStore {
  const ttl = (createdAt: number) => String(remainingMs(createdAt, now()));
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
    async create(job, requestId) {
      return String(
        await redis.eval(
          CREATE_SCRIPT,
          [jobKey(job.id), requestKey(job.installId, requestId)],
          [JSON.stringify(job), ttl(job.createdAt), job.id],
        ),
      );
    },
    async claimRequest(installId, requestId, jobId, createdAt) {
      return String(await redis.eval(CLAIM_SCRIPT, [requestKey(installId, requestId)], [jobId, ttl(createdAt)]));
    },
    async releaseRequest(installId, requestId) {
      await redis.del(requestKey(installId, requestId));
    },
    async lockAndRead(id, installId, options) {
      const token = newToken();
      const [job, owned, cancel] = await redis.eval<string[], [unknown, string, number]>(
        LOCK_AND_READ_SCRIPT,
        [jobKey(id), lockKey(id), cancelKey(id)],
        [installId, token, String(JOB_LOCK_MS), options?.requestCancel ? '1' : '0'],
      );
      return { job: asJob(job), token: owned ? String(owned) : null, cancelRequested: Number(cancel) === 1 };
    },
    async saveAndUnlock(id, token, job, options) {
      const outcome = await redis.eval(
        SAVE_AND_UNLOCK_SCRIPT,
        [jobKey(id), lockKey(id), cancelKey(id)],
        [token, job ? JSON.stringify(job) : '', job ? ttl(job.createdAt) : '1', options?.yieldToCancel ? '1' : '0'],
      );
      return outcome === 'cancel-requested' ? 'cancel-requested' : 'saved';
    },
    async unlock(id, token) {
      await redis.eval(UNLOCK_SCRIPT, [lockKey(id)], [token]);
    },
    async commitStarted(started, cancelled) {
      return (await redis.eval(
        COMMIT_STARTED_SCRIPT,
        [jobKey(started.id), lockKey(started.id), cancelKey(started.id)],
        [JSON.stringify(started), JSON.stringify(cancelled), ttl(started.createdAt)],
      )) as CommitOutcome;
    },
  };
}

/** In-memory job store for tests and for local development without Upstash. Same semantics as the scripts. */
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
  // Copy, as Redis would, so callers can't change the stored job by mutating what they read.
  const copy = (job: JobRecord) => JSON.parse(JSON.stringify(job)) as JobRecord;
  const readJob = (id: string) => {
    const job = read<JobRecord>(jobKey(id));
    return job ? copy(job) : null;
  };
  const putJob = (job: JobRecord) => write(jobKey(job.id), copy(job), remainingMs(job.createdAt, now()));
  const unlockIfOwned = (id: string, token: string) => {
    if (read(lockKey(id)) === token) values.delete(lockKey(id));
  };

  return {
    async get(id) {
      return readJob(id);
    },
    async put(job) {
      putJob(job);
    },
    async findRequest(installId, requestId) {
      return read<string>(requestKey(installId, requestId));
    },
    async create(job, requestId) {
      const key = requestKey(job.installId, requestId);
      const existing = read<string>(key);
      if (existing) return existing;
      putJob(job);
      write(key, job.id, remainingMs(job.createdAt, now()));
      return job.id;
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
    async lockAndRead(id, installId, options) {
      const job = readJob(id);
      if (!job || job.installId !== installId) return { job: null, token: null, cancelRequested: false };
      if (!isActive(job)) return { job, token: null, cancelRequested: false };
      if (options?.requestCancel) write(cancelKey(id), true, remainingMs(job.createdAt, now()));
      let token: string | null = null;
      if (!read(lockKey(id))) {
        token = newToken();
        write(lockKey(id), token, JOB_LOCK_MS);
      }
      return { job, token, cancelRequested: read(cancelKey(id)) != null };
    },
    async saveAndUnlock(id, token, job, options) {
      if (options?.yieldToCancel && read(cancelKey(id)) != null) return 'cancel-requested';
      if (job) putJob(job);
      unlockIfOwned(id, token);
      return 'saved';
    },
    async unlock(id, token) {
      unlockIfOwned(id, token);
    },
    async commitStarted(started, cancelled) {
      if (read(lockKey(started.id))) return 'locked';
      const stored = readJob(started.id);
      if (!stored || !isActive(stored) || stored.providerRequestId) return 'not-waiting';
      if (read(cancelKey(started.id)) != null) {
        putJob(cancelled);
        return 'cancelled';
      }
      putJob(started);
      return 'saved';
    },
  };
}

/** Bump when `JobStore` changes, so the dev server doesn't keep using a store built by older code. */
const MEMORY_STORE_VERSION = 3;

/**
 * The development job store. Each Expo Router API route is bundled separately, so it lives on
 * `globalThis` for the submit and job routes to share. It is keyed by version: after a hot reload
 * that changed the store, `globalThis` would otherwise still hold an instance without the new
 * methods.
 */
export function sharedMemoryJobStore(): JobStore {
  const g = globalThis as { __superzoomJobStore?: { version: number; store: JobStore } };
  if (g.__superzoomJobStore?.version !== MEMORY_STORE_VERSION) {
    g.__superzoomJobStore = { version: MEMORY_STORE_VERSION, store: memoryJobStore() };
  }
  return g.__superzoomJobStore.store;
}
