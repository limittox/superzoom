/**
 * @jest-environment node
 */
import { Redis } from '@upstash/redis';

import {
  JOB_LOCK_MS,
  JOB_TTL_MS,
  type JobRecord,
  type JobStore,
  memoryJobStore,
  sharedMemoryJobStore,
  upstashJobStore,
} from '../jobStore';
import { memoryStore, sharedMemoryStore } from '../memoryStore';

const job = (overrides: Partial<JobRecord> = {}): JobRecord => ({
  id: 'job-1',
  installId: 'install-123',
  mode: 'enhance',
  createdAt: 1_000_000,
  status: 'queued',
  passes: [],
  outputWidth: 4000,
  outputHeight: 3000,
  passIndex: 0,
  ...overrides,
});

/**
 * Behaviour every store must have. Runs against the memory store always, and against the real
 * Upstash scripts with `UPSTASH_INTEGRATION=1` and the Upstash variables set (keys are unique per
 * run and expire with the job TTL).
 */
function describeJobStore(name: string, make: () => { store: JobStore; prefix: string; createdAt: () => number }) {
  describe(name, () => {
    let store: JobStore;
    let id: (n: number) => string;
    let rec: (n: number, overrides?: Partial<JobRecord>) => JobRecord;
    beforeEach(() => {
      const made = make();
      store = made.store;
      id = (n) => `${made.prefix}-${n}`;
      const createdAt = made.createdAt();
      rec = (n, overrides) => job({ id: id(n), createdAt, ...overrides });
    });

    it('round-trips a job, keeping an empty pass list', async () => {
      await store.put(rec(1));
      expect(await store.get(id(1))).toEqual(rec(1));
      expect(await store.get(id(99))).toBeNull();
    });

    it('creates a job with its request ID once; a second submission gets the first job', async () => {
      expect(await store.create(rec(1), `${id(1)}-req`)).toBe(id(1));
      expect(await store.get(id(1))).toEqual(rec(1));
      expect(await store.create(rec(2), `${id(1)}-req`)).toBe(id(1));
      expect(await store.get(id(2))).toBeNull();
      expect(await store.findRequest('install-123', `${id(1)}-req`)).toBe(id(1));
    });

    it("doesn't create a job for a request ID that was cancelled first", async () => {
      await store.claimRequest('install-123', `${id(1)}-req`, 'cancelled', rec(1).createdAt);
      expect(await store.create(rec(1), `${id(1)}-req`)).toBe('cancelled');
      expect(await store.get(id(1))).toBeNull();
    });

    it("locks and reads an active job, and treats another installation's job as missing", async () => {
      await store.put(rec(1));
      const first = await store.lockAndRead(id(1), 'install-123');
      expect(first).toEqual({ job: rec(1), token: expect.any(String), cancelRequested: false });
      // Locked: a second reader gets the job but no token.
      expect(await store.lockAndRead(id(1), 'install-123')).toMatchObject({ job: rec(1), token: null });
      expect(await store.lockAndRead(id(1), 'install-456')).toEqual({ job: null, token: null, cancelRequested: false });
      expect((await store.lockAndRead(id(99), 'install-123')).job).toBeNull();
    });

    it("reads a finished job without locking it or setting its cancel flag", async () => {
      await store.put(rec(1, { status: 'done' }));
      expect(await store.lockAndRead(id(1), 'install-123', { requestCancel: true })).toEqual({
        job: rec(1, { status: 'done' }),
        token: null,
        cancelRequested: false,
      });
    });

    it('sets the cancel flag for whoever holds the lock to act on', async () => {
      await store.put(rec(1));
      const holder = await store.lockAndRead(id(1), 'install-123');
      const canceller = await store.lockAndRead(id(1), 'install-123', { requestCancel: true });
      expect(canceller).toMatchObject({ token: null, cancelRequested: true });
      // The holder's save yields to the cancel, keeping its lock...
      expect(await store.saveAndUnlock(id(1), holder.token!, rec(1, { status: 'processing' }), { yieldToCancel: true })).toBe(
        'cancel-requested',
      );
      expect((await store.get(id(1)))!.status).toBe('queued');
      // ...then saves the cancelled job and releases it.
      expect(await store.saveAndUnlock(id(1), holder.token!, rec(1, { status: 'cancelled' }))).toBe('saved');
      expect((await store.get(id(1)))!.status).toBe('cancelled');
    });

    it('saves and unlocks, or only unlocks, and never releases a lock it no longer owns', async () => {
      await store.put(rec(1));
      const a = await store.lockAndRead(id(1), 'install-123');
      expect(await store.saveAndUnlock(id(1), a.token!, null, { yieldToCancel: true })).toBe('saved');
      const b = await store.lockAndRead(id(1), 'install-123');
      expect(b.token).toEqual(expect.any(String));
      // A stale token (e.g. after the lock expired) leaves the current owner's lock alone.
      await store.unlock(id(1), 'someone-else');
      expect((await store.lockAndRead(id(1), 'install-123')).token).toBeNull();
      await store.saveAndUnlock(id(1), b.token!, rec(1, { status: 'processing' }));
      expect((await store.get(id(1)))!.status).toBe('processing');
      expect((await store.lockAndRead(id(1), 'install-123')).token).toEqual(expect.any(String));
    });

    it('commits a started job only while it is still waiting, unlocked and not cancelled', async () => {
      const started = (n: number) => rec(n, { providerRequestId: 'fal-1', passes: [4] });
      const cancelled = (n: number) => ({ ...started(n), status: 'cancelled' as const });

      await store.put(rec(1));
      expect(await store.commitStarted(started(1), cancelled(1))).toBe('saved');
      expect((await store.get(id(1)))!.providerRequestId).toBe('fal-1');
      // Already has a pass: a second commit doesn't apply.
      expect(await store.commitStarted(started(1), cancelled(1))).toBe('not-waiting');

      await store.put(rec(2));
      const holder = await store.lockAndRead(id(2), 'install-123');
      expect(await store.commitStarted(started(2), cancelled(2))).toBe('locked');
      await store.unlock(id(2), holder.token!);

      await store.lockAndRead(id(2), 'install-123', { requestCancel: true }).then((r) => store.unlock(id(2), r.token!));
      expect(await store.commitStarted(started(2), cancelled(2))).toBe('cancelled');
      expect((await store.get(id(2)))!.status).toBe('cancelled');

      await store.put(rec(3, { status: 'failed' }));
      expect(await store.commitStarted(started(3), cancelled(3))).toBe('not-waiting');
      expect(await store.commitStarted(started(4), cancelled(4))).toBe('not-waiting');
    });

    it('releases a request ID', async () => {
      await store.create(rec(1), `${id(1)}-req`);
      await store.releaseRequest('install-123', `${id(1)}-req`);
      expect(await store.findRequest('install-123', `${id(1)}-req`)).toBeNull();
    });
  });
}

let runs = 0;
describeJobStore('memoryJobStore', () => ({
  store: memoryJobStore(() => 1_000_000),
  prefix: `m${++runs}`,
  createdAt: () => 1_000_000,
}));

const integration = process.env.UPSTASH_INTEGRATION === '1' ? describeJobStore : () => {};
integration('upstashJobStore (real Upstash)', () => ({
  store: upstashJobStore(
    new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! }),
  ),
  prefix: `test-${crypto.randomUUID()}`,
  createdAt: () => Date.now(),
}));

describe('memoryJobStore expiry', () => {
  it('expires a job an hour after it was created, even when saved again later', async () => {
    let now = 1_000_000;
    const store = memoryJobStore(() => now);
    await store.put(job());
    now += JOB_TTL_MS - 1;
    expect(await store.get('job-1')).not.toBeNull();
    await store.put(job({ status: 'processing' }));
    now += 1;
    expect(await store.get('job-1')).toBeNull();
  });

  it('frees a lock that was never released', async () => {
    let now = 1_000_000;
    const store = memoryJobStore(() => now);
    await store.put(job());
    expect((await store.lockAndRead('job-1', 'install-123')).token).toEqual(expect.any(String));
    expect((await store.lockAndRead('job-1', 'install-123')).token).toBeNull();
    now += JOB_LOCK_MS;
    expect((await store.lockAndRead('job-1', 'install-123')).token).toEqual(expect.any(String));
  });

  it('returns copies, so callers cannot change the stored job', async () => {
    const store = memoryJobStore(() => 1_000_000);
    await store.put(job());
    const read = await store.get('job-1');
    read!.status = 'done';
    expect((await store.get('job-1'))!.status).toBe('queued');
  });
});

describe('upstashJobStore requests', () => {
  it('runs each operation as one Redis call with the job lifetime', async () => {
    const redis = {
      eval: jest.fn().mockResolvedValue(['', '', 0]),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };
    const store = upstashJobStore(redis as unknown as Redis, () => 1_000_000 + 60_000);
    expect(await store.lockAndRead('job-1', 'install-123')).toEqual({ job: null, token: null, cancelRequested: false });
    expect(redis.eval).toHaveBeenLastCalledWith(
      expect.stringContaining('NX'),
      ['job:job-1', 'job:job-1:lock', 'job:job-1:cancel'],
      ['install-123', expect.any(String), String(JOB_LOCK_MS), '0'],
    );

    redis.eval.mockResolvedValueOnce([JSON.stringify(job()), 'tok', 1]);
    expect(await store.lockAndRead('job-1', 'install-123', { requestCancel: true })).toEqual({
      job: job(),
      token: 'tok',
      cancelRequested: true,
    });

    redis.eval.mockResolvedValueOnce('job-1');
    await store.create(job(), 'req-1');
    expect(redis.eval).toHaveBeenLastCalledWith(
      expect.any(String),
      ['job:job-1', 'jobreq:install-123:req-1'],
      [JSON.stringify(job()), String(JOB_TTL_MS - 60_000), 'job-1'],
    );
    expect(redis.eval).toHaveBeenCalledTimes(3);
  });
});

describe('shared development stores', () => {
  it('replaces a shared job store left by older code (e.g. after a hot reload)', () => {
    const g = globalThis as Record<string, unknown>;
    g.__superzoomJobStore = { version: 2, store: { lock: async () => true } };
    const store = sharedMemoryJobStore();
    expect(typeof store.lockAndRead).toBe('function');
    expect(sharedMemoryJobStore()).toBe(store);
  });

  it('replaces a shared rate-limit store left by older code', () => {
    const g = globalThis as Record<string, unknown>;
    g.__superzoomRateLimitStore = { count: async () => 0 };
    expect(typeof sharedMemoryStore().hit).toBe('function');
  });

  it('returns the same job store and rate-limit store on every call, as separate route bundles need', () => {
    expect(sharedMemoryJobStore()).toBe(sharedMemoryJobStore());
    expect(sharedMemoryStore()).toBe(sharedMemoryStore());
    expect(sharedMemoryStore()).not.toBe(memoryStore());
  });
});
