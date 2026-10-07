import type { Redis } from '@upstash/redis';

import { JOB_LOCK_MS, JOB_TTL_MS, type JobRecord, memoryJobStore, sharedMemoryJobStore, upstashJobStore } from '../jobStore';
import { memoryStore, sharedMemoryStore } from '../memoryStore';

const job = (overrides: Partial<JobRecord> = {}): JobRecord => ({
  id: 'job-1',
  installId: 'install-123',
  mode: 'enhance',
  createdAt: 1_000_000,
  status: 'queued',
  passes: [4],
  outputWidth: 4000,
  outputHeight: 3000,
  passIndex: 0,
  ...overrides,
});

describe('memoryJobStore', () => {
  it('round-trips a job and returns a copy', async () => {
    const store = memoryJobStore(() => 1_000_000);
    await store.put(job());
    const read = await store.get('job-1');
    expect(read).toEqual(job());
    read!.status = 'done';
    expect((await store.get('job-1'))!.status).toBe('queued');
    expect(await store.get('missing')).toBeNull();
  });

  it('expires a job an hour after it was created', async () => {
    let now = 1_000_000;
    const store = memoryJobStore(() => now);
    await store.put(job());
    now += JOB_TTL_MS - 1;
    expect(await store.get('job-1')).not.toBeNull();
    // Saving it again later doesn't extend its life.
    await store.put(job({ status: 'processing' }));
    now += 1;
    expect(await store.get('job-1')).toBeNull();
  });

  it('returns the first job ID for a repeated request ID, until released', async () => {
    const store = memoryJobStore(() => 1_000_000);
    expect(await store.findRequest('install-123', 'req-1')).toBeNull();
    expect(await store.claimRequest('install-123', 'req-1', 'job-1', 1_000_000)).toBe('job-1');
    expect(await store.claimRequest('install-123', 'req-1', 'job-2', 1_000_000)).toBe('job-1');
    expect(await store.findRequest('install-123', 'req-1')).toBe('job-1');
    // Request IDs are per installation.
    expect(await store.claimRequest('install-456', 'req-1', 'job-3', 1_000_000)).toBe('job-3');

    await store.releaseRequest('install-123', 'req-1');
    expect(await store.claimRequest('install-123', 'req-1', 'job-4', 1_000_000)).toBe('job-4');
  });

  it('lets one holder take a job lock at a time, and frees a lock that was never released', async () => {
    let now = 0;
    const store = memoryJobStore(() => now);
    expect(await store.lock('job-1')).toBe(true);
    expect(await store.lock('job-1')).toBe(false);
    expect(await store.lock('job-2')).toBe(true);
    await store.unlock('job-1');
    expect(await store.lock('job-1')).toBe(true);
    now += JOB_LOCK_MS;
    expect(await store.lock('job-1')).toBe(true);
  });
});

describe('shared development stores', () => {
  it('returns the same job store and rate-limit store on every call, as separate route bundles need', () => {
    expect(sharedMemoryJobStore()).toBe(sharedMemoryJobStore());
    expect(sharedMemoryStore()).toBe(sharedMemoryStore());
    expect(sharedMemoryStore()).not.toBe(memoryStore());
  });
});

describe('upstashJobStore', () => {
  function fakeRedis() {
    const values = new Map<string, unknown>();
    return {
      values,
      get: jest.fn(async (key: string) => values.get(key) ?? null),
      set: jest.fn(async (key: string, value: unknown, opts: { nx?: boolean; px?: number }) => {
        if (opts.nx && values.has(key)) return null;
        values.set(key, value);
        return 'OK';
      }),
      del: jest.fn(async (key: string) => (values.delete(key) ? 1 : 0)),
    };
  }

  it('stores jobs under job:{id} with the remaining lifetime', async () => {
    const redis = fakeRedis();
    const store = upstashJobStore(redis as unknown as Redis, () => 1_000_000 + 60_000);
    await store.put(job());
    expect(redis.set).toHaveBeenCalledWith('job:job-1', job(), { px: JOB_TTL_MS - 60_000 });
    expect(await store.get('job-1')).toEqual(job());
  });

  it('claims request IDs with SET NX and returns the winner', async () => {
    const redis = fakeRedis();
    const store = upstashJobStore(redis as unknown as Redis, () => 1_000_000);
    expect(await store.claimRequest('install-123', 'req-1', 'job-1', 1_000_000)).toBe('job-1');
    expect(await store.claimRequest('install-123', 'req-1', 'job-2', 1_000_000)).toBe('job-1');
    expect(redis.set).toHaveBeenCalledWith('jobreq:install-123:req-1', 'job-1', { nx: true, px: JOB_TTL_MS });
    await store.releaseRequest('install-123', 'req-1');
    expect(await store.findRequest('install-123', 'req-1')).toBeNull();
  });

  it('locks with SET NX and a 15 s expiry', async () => {
    const redis = fakeRedis();
    const store = upstashJobStore(redis as unknown as Redis);
    expect(await store.lock('job-1')).toBe(true);
    expect(await store.lock('job-1')).toBe(false);
    expect(redis.set).toHaveBeenCalledWith('job:job-1:lock', '1', { nx: true, px: JOB_LOCK_MS });
    await store.unlock('job-1');
    expect(await store.lock('job-1')).toBe(true);
  });
});
