/**
 * @jest-environment node
 */
import { INSTALL_ID_HEADER } from '@/shared/enhance';

import { makeJpeg } from '../testing/fixtures';

jest.mock('@fal-ai/client', () => ({ createFalClient: jest.fn() }));
jest.mock('@upstash/redis', () => ({ Redis: jest.fn() }));

const FAL_KEY = 'fal-secret-key-123:abcdef';
const REDIS_TOKEN = 'upstash-secret-token-xyz';
const INSTALL_ID = '3b241101-e2bb-4255-8caf-4136c566a962';

function submitRequest(requestId = '0f8fad5b-d9cb-469f-a165-70867728950e') {
  const form = new FormData();
  form.append('image', new Blob([makeJpeg(1000, 1000) as BlobPart], { type: 'image/jpeg' }));
  form.append('requestId', requestId);
  return new Request('http://localhost/api/enhance', {
    method: 'POST',
    body: form,
    headers: { [INSTALL_ID_HEADER]: INSTALL_ID },
  });
}

const jobRequest = (jobId: string, method: 'GET' | 'DELETE' = 'GET') =>
  new Request(`http://localhost/api/enhance/${jobId}`, { method, headers: { [INSTALL_ID_HEADER]: INSTALL_ID } });

/**
 * Just enough of Upstash for the wiring: plain get/set/del, and `eval` mimicking each script by
 * what it contains. The real scripts run against Upstash in jobStore.test.ts (UPSTASH_INTEGRATION=1).
 */
function fakeRedis() {
  const values = new Map<string, unknown>();
  // Like the real client, values written as JSON strings read back as objects.
  const read = (key: string) => {
    const v = values.get(key);
    return typeof v === 'string' && v.startsWith('{') ? JSON.parse(v) : (v ?? null);
  };
  const active = (job: { status: string }) => job.status === 'queued' || job.status === 'processing';
  const evalScript = async (script: string, keys: string[], args: string[]) => {
    if (script.includes('ZREMRANGEBYSCORE')) return [1, 0, ''];
    if (script.includes('return ARGV[1]') && keys.length === 1) {
      if (values.has(keys[0])) return values.get(keys[0]);
      values.set(keys[0], args[0]);
      return args[0];
    }
    if (script.includes('return ARGV[3]')) {
      if (values.has(keys[1])) return values.get(keys[1]);
      values.set(keys[0], args[0]);
      values.set(keys[1], args[2]);
      return args[2];
    }
    if (script.includes('PTTL')) {
      const job = read(keys[0]);
      if (!job || job.installId !== args[0]) return ['', '', 0];
      if (!active(job)) return [job, '', 0];
      if (args[3] === '1') values.set(keys[2], '1');
      let token = '';
      if (!values.has(keys[1])) values.set(keys[1], (token = args[1]));
      return [job, token, values.has(keys[2]) ? 1 : 0];
    }
    if (script.includes('"cancel-requested"')) {
      if (args[3] === '1' && values.has(keys[2])) return 'cancel-requested';
      if (args[1] !== '') values.set(keys[0], args[1]);
      if (values.get(keys[1]) === args[0]) values.delete(keys[1]);
      return 'saved';
    }
    if (script.includes('"locked"')) {
      if (values.has(keys[1])) return 'locked';
      const job = read(keys[0]);
      if (!job || !active(job) || job.providerRequestId) return 'not-waiting';
      if (values.has(keys[2])) return values.set(keys[0], args[1]), 'cancelled';
      return values.set(keys[0], args[0]), 'saved';
    }
    // The compare-and-delete unlock script.
    return values.get(keys[0]) === args[0] ? (values.delete(keys[0]), 1) : 0;
  };
  return {
    get: jest.fn(async (key: string) => read(key)),
    set: jest.fn(async (key: string, value: unknown, opts: { nx?: boolean }) => {
      if (opts?.nx && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => (values.delete(key) ? 1 : 0)),
    eval: jest.fn(evalScript),
  };
}

function fakeFal() {
  return {
    storage: { upload: jest.fn().mockResolvedValue('https://fal.media/in.jpg') },
    queue: {
      submit: jest.fn().mockResolvedValue({ request_id: 'fal-1', status: 'IN_QUEUE' }),
      status: jest.fn().mockResolvedValueOnce({ status: 'IN_PROGRESS' }).mockResolvedValue({ status: 'COMPLETED' }),
      result: jest.fn().mockResolvedValue({ data: { image: { url: 'https://fal.media/out.jpg' } } }),
      cancel: jest.fn().mockResolvedValue(undefined),
    },
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
describe('enhance API routes wiring', () => {
  const env = process.env;
  let output: string[];
  let createFalClient: jest.Mock;
  let Redis: jest.Mock;

  beforeEach(() => {
    // Fresh module registry so the routes' lazily built clients are rebuilt per test.
    jest.resetModules();
    delete (globalThis as Record<string, unknown>).__superzoomJobStore;
    delete (globalThis as Record<string, unknown>).__superzoomRateLimitStore;
    createFalClient = require('@fal-ai/client').createFalClient;
    Redis = require('@upstash/redis').Redis;

    output = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      jest.spyOn(console, method).mockImplementation((...args) => {
        output.push(args.map(String).join(' '));
      });
    }
    process.env = {
      ...env,
      FAL_KEY,
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: REDIS_TOKEN,
    };
    const redis = fakeRedis();
    Redis.mockImplementation(() => redis);
    createFalClient.mockReturnValue(fakeFal());
  });

  afterEach(() => {
    process.env = env;
    jest.restoreAllMocks();
  });

  const loadRoutes = () => ({
    ...(require('@/app/api/enhance/index+api') as typeof import('@/app/api/enhance/index+api')),
    ...(require('@/app/api/enhance/[id]+api') as typeof import('@/app/api/enhance/[id]+api')),
  });

  it('submits a job, then reports it until done, with clients built from env', async () => {
    const { POST, GET } = loadRoutes();
    const submit = await POST(submitRequest());
    expect(submit.status).toBe(202);
    const { jobId } = await submit.json();

    expect(await (await GET(jobRequest(jobId), { id: jobId })).json()).toMatchObject({ status: 'processing' });
    const done = await GET(jobRequest(jobId), { id: jobId });
    const text = await done.text();
    expect(JSON.parse(text)).toMatchObject({ status: 'done', result: { url: 'https://fal.media/out.jpg', mode: 'enhance' } });

    expect(createFalClient).toHaveBeenCalledWith({ credentials: FAL_KEY });
    expect(Redis).toHaveBeenCalledWith({ url: 'https://example.upstash.io', token: REDIS_TOKEN });
    expect(text).not.toContain(FAL_KEY);
    expect(output.join('\n')).not.toContain(FAL_KEY);
  });

  it('cancels a job through DELETE', async () => {
    const { POST, DELETE } = loadRoutes();
    const { jobId } = await (await POST(submitRequest())).json();
    const res = await DELETE(jobRequest(jobId, 'DELETE'), { id: jobId });
    expect(await res.json()).toMatchObject({ status: 'cancelled' });
    expect(createFalClient.mock.results[0].value.queue.cancel).toHaveBeenCalled();
  });

  it('cancels a submission by request ID through DELETE /api/enhance', async () => {
    // Load the index route alone: both route files export DELETE.
    const index = require('@/app/api/enhance/index+api') as typeof import('@/app/api/enhance/index+api');
    const { jobId } = await (await index.POST(submitRequest())).json();
    const res = await index.DELETE(
      new Request('http://localhost/api/enhance?requestId=0f8fad5b-d9cb-469f-a165-70867728950e', {
        method: 'DELETE',
        headers: { [INSTALL_ID_HEADER]: INSTALL_ID },
      }),
    );
    expect(await res.json()).toMatchObject({ jobId, status: 'cancelled' });
  });

  it('never leaks the key when fal fails', async () => {
    createFalClient.mockReturnValue({
      ...fakeFal(),
      storage: { upload: jest.fn().mockRejectedValue(new Error(`401 invalid key ${FAL_KEY}`)) },
    });
    const response = await loadRoutes().POST(submitRequest());
    const text = await response.text();

    expect({ status: response.status, text }).toMatchObject({ status: 502 });
    expect(text).not.toContain(FAL_KEY);
    expect(output.join('\n')).not.toContain(FAL_KEY);
    expect(output.join('\n')).not.toContain(REDIS_TOKEN);
  });

  it('requires Upstash outside development', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    process.env.NODE_ENV = 'production';
    const response = await loadRoutes().POST(submitRequest());
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe('provider_error');
    expect(Redis).not.toHaveBeenCalled();
  });

  it('shares in-memory jobs and limits between the routes in development', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    process.env.NODE_ENV = 'development';
    process.env.DAILY_LIMIT = '1';
    const { POST } = loadRoutes();
    const { jobId } = await (await POST(submitRequest())).json();
    expect((await POST(submitRequest('1f8fad5b-d9cb-469f-a165-70867728950e'))).status).toBe(429);

    // The job route is bundled separately in the dev server; it must see the same job.
    jest.resetModules();
    const { GET } = loadRoutes();
    expect((await GET(jobRequest(jobId), { id: jobId })).status).toBe(200);
    expect(Redis).not.toHaveBeenCalled();
  });

  it('reports a configuration error without details when FAL_KEY is missing', async () => {
    delete process.env.FAL_KEY;
    const response = await loadRoutes().POST(submitRequest());
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe('provider_error');
  });
});
