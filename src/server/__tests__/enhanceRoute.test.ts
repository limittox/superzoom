/**
 * @jest-environment node
 */
import { INSTALL_ID_HEADER } from '@/shared/enhance';

import { makeJpeg } from '../testing/fixtures';

jest.mock('@fal-ai/client', () => ({ createFalClient: jest.fn() }));
jest.mock('@upstash/redis', () => ({ Redis: jest.fn() }));

const FAL_KEY = 'fal-secret-key-123:abcdef';
const REDIS_TOKEN = 'upstash-secret-token-xyz';

function request() {
  const form = new FormData();
  form.append('image', new Blob([makeJpeg(1000, 1000) as BlobPart], { type: 'image/jpeg' }));
  return new Request('http://localhost/api/enhance', {
    method: 'POST',
    body: form,
    headers: { [INSTALL_ID_HEADER]: '3b241101-e2bb-4255-8caf-4136c566a962' },
  });
}

/* eslint-disable @typescript-eslint/no-require-imports */
describe('enhance+api route wiring', () => {
  const env = process.env;
  let output: string[];
  let createFalClient: jest.Mock;
  let Redis: jest.Mock;

  beforeEach(() => {
    // Fresh module registry so the route's lazily built clients are rebuilt per test.
    jest.resetModules();
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
    const pipeline = { zadd: jest.fn(), pexpire: jest.fn(), exec: jest.fn().mockResolvedValue([]) };
    pipeline.zadd.mockReturnValue(pipeline);
    pipeline.pexpire.mockReturnValue(pipeline);
    Redis.mockImplementation(() => ({
      zremrangebyscore: jest.fn().mockResolvedValue(0),
      zcard: jest.fn().mockResolvedValue(0),
      zrange: jest.fn().mockResolvedValue([]),
      pipeline: () => pipeline,
    }));
    createFalClient.mockReturnValue({
      storage: { upload: jest.fn().mockResolvedValue('https://fal.media/in.jpg') },
      subscribe: jest.fn().mockResolvedValue({ data: { image: { url: 'https://fal.media/out.jpg' } } }),
    });
  });

  afterEach(() => {
    process.env = env;
    jest.restoreAllMocks();
  });

  const loadRoute = () => require('@/app/api/enhance+api') as typeof import('@/app/api/enhance+api');

  it('builds fal and Upstash clients from env and returns a result', async () => {
    const response = await loadRoute().POST(request());
    const text = await response.text();

    expect({ status: response.status, text }).toMatchObject({ status: 200 });
    expect(JSON.parse(text)).toMatchObject({ url: 'https://fal.media/out.jpg', mode: 'enhance' });
    expect(createFalClient).toHaveBeenCalledWith({ credentials: FAL_KEY });
    expect(Redis).toHaveBeenCalledWith({ url: 'https://example.upstash.io', token: REDIS_TOKEN });
    expect(text).not.toContain(FAL_KEY);
    expect(output.join('\n')).not.toContain(FAL_KEY);
  });

  it('never leaks the key when fal fails', async () => {
    createFalClient.mockReturnValue({
      storage: { upload: jest.fn().mockRejectedValue(new Error(`401 invalid key ${FAL_KEY}`)) },
      subscribe: jest.fn(),
    });
    const response = await loadRoute().POST(request());
    const text = await response.text();

    expect({ status: response.status, text }).toMatchObject({ status: 502 });
    expect(text).not.toContain(FAL_KEY);
    expect(output.join('\n')).not.toContain(FAL_KEY);
    expect(output.join('\n')).not.toContain(REDIS_TOKEN);
  });

  it('requires Upstash outside development', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    process.env.NODE_ENV = 'production';
    const response = await loadRoute().POST(request());
    expect(response.status).toBe(503);
    expect(Redis).not.toHaveBeenCalled();
  });

  it('falls back to an in-memory limiter in development', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    process.env.NODE_ENV = 'development';
    process.env.DAILY_LIMIT = '1';
    const { POST } = loadRoute();
    expect((await POST(request())).status).toBe(200);
    expect((await POST(request())).status).toBe(429);
    expect(Redis).not.toHaveBeenCalled();
  });

  it('reports a configuration error without details when FAL_KEY is missing', async () => {
    delete process.env.FAL_KEY;
    const response = await loadRoute().POST(request());
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe('provider_error');
  });
});
