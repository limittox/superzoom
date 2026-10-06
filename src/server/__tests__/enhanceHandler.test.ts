/**
 * @jest-environment node
 */
import { ENHANCE_PATH, INSTALL_ID_HEADER, LIMITS } from '@/shared/enhance';

import { createEnhanceHandler, type LogEvent } from '../enhanceHandler';
import { createRateLimiter } from '../rateLimit';
import { makeGif, makeJpeg } from '../testing/fixtures';
import { memoryStore } from '../memoryStore';
import { createFalUpscaler } from '../upscaler/fal';

const INSTALL_ID = '3b241101-e2bb-4255-8caf-4136c566a962';

function fakeFal() {
  return {
    storage: { upload: jest.fn().mockResolvedValue('https://fal.media/in.jpg'), transformInput: jest.fn() },
    subscribe: jest.fn().mockResolvedValue({ data: { image: { url: 'https://fal.media/out.jpg' } }, requestId: 'r' }),
  };
}

function setup({ limit = 50, timeoutMs = 1000 } = {}) {
  const fal = fakeFal();
  const logs: LogEvent[] = [];
  const limiter = createRateLimiter(memoryStore(), limit);
  const handler = createEnhanceHandler({
    getUpscaler: () => createFalUpscaler(fal as never),
    getRateLimiter: () => limiter,
    timeoutMs,
    log: (e) => logs.push(e),
  });
  return { fal, logs, handler };
}

function makeRequest({
  image = makeJpeg(1000, 1000) as Uint8Array | null,
  mode,
  installId = INSTALL_ID as string | null,
}: { image?: Uint8Array | null; mode?: string; installId?: string | null } = {}) {
  const form = new FormData();
  if (image) form.append('image', new Blob([image as BlobPart], { type: 'image/jpeg' }), 'crop.jpg');
  if (mode !== undefined) form.append('mode', mode);
  const headers: Record<string, string> = {};
  if (installId) headers[INSTALL_ID_HEADER] = installId;
  return new Request(`http://localhost${ENHANCE_PATH}`, { method: 'POST', body: form, headers });
}

async function call(handler: (r: Request) => Promise<Response>, request: Request) {
  const response = await handler(request);
  return { status: response.status, headers: response.headers, body: await response.json() };
}

describe('POST /api/enhance', () => {
  it('enhances a valid JPEG and returns url, size and mode', async () => {
    const { handler, fal } = setup();
    const res = await call(handler, makeRequest({ mode: 'enhance' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: 'https://fal.media/out.jpg', width: 4000, height: 4000, mode: 'enhance' });
    expect(fal.subscribe.mock.calls[0][0]).toBe('fal-ai/seedvr/upscale/image');
  });

  it('defaults to enhance mode when mode is omitted', async () => {
    const { handler, fal } = setup();
    const res = await call(handler, makeRequest());
    expect(res.body.mode).toBe('enhance');
    expect(fal.subscribe.mock.calls[0][0]).toBe('fal-ai/seedvr/upscale/image');
  });

  it('routes pro mode to Topaz', async () => {
    const { handler, fal } = setup();
    const res = await call(handler, makeRequest({ mode: 'pro' }));
    expect(res.body.mode).toBe('pro');
    expect(fal.subscribe.mock.calls[0][0]).toBe('fal-ai/topaz/upscale/image');
  });

  it('rejects an unknown mode without calling fal', async () => {
    const { handler, fal } = setup();
    const res = await call(handler, makeRequest({ mode: 'ultra' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_mode');
    expect(fal.storage.upload).not.toHaveBeenCalled();
    expect(fal.subscribe).not.toHaveBeenCalled();
  });

  it('rejects a missing install ID', async () => {
    const { handler } = setup();
    const res = await call(handler, makeRequest({ installId: null }));
    expect(res.body.error.code).toBe('missing_install_id');
  });

  it('rejects a body without an image', async () => {
    const { handler } = setup();
    const res = await call(handler, makeRequest({ image: null }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it.each([
    ['unsupported_format', makeGif(), 415],
    ['image_too_small', makeJpeg(50, 50), 422],
    ['image_too_large', makeJpeg(4000, 3000), 422],
  ] as const)('returns %s for invalid images without calling fal', async (code, image, status) => {
    const { handler, fal } = setup();
    const res = await call(handler, makeRequest({ image }));
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(fal.subscribe).not.toHaveBeenCalled();
  });

  it('rejects an oversized upload as file_too_large', async () => {
    const { handler } = setup();
    const res = await call(handler, makeRequest({ image: makeJpeg(1000, 1000, { padTo: LIMITS.maxUploadBytes + 1 }) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('file_too_large');
  });

  it('rate limits after the daily limit with a retry time', async () => {
    const { handler, fal } = setup({ limit: 2 });
    await call(handler, makeRequest());
    await call(handler, makeRequest());
    const res = await call(handler, makeRequest());
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
    expect(new Date(res.body.error.retryAt).getTime()).toBeGreaterThan(Date.now());
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(fal.subscribe).toHaveBeenCalledTimes(2);
  });

  it('maps a fal failure to provider_error', async () => {
    const { handler, fal } = setup();
    fal.subscribe.mockRejectedValue(new Error('fal exploded'));
    const res = await call(handler, makeRequest());
    expect(res.status).toBe(502);
    expect(res.body.error).toEqual({ code: 'provider_error', message: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toContain('exploded');
  });

  it('times out a slow provider', async () => {
    const { handler, fal } = setup({ timeoutMs: 20 });
    fal.subscribe.mockReturnValue(new Promise(() => {}));
    const res = await call(handler, makeRequest());
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('timeout');
  });

  it('fails closed when the rate limiter is unavailable', async () => {
    const { fal } = setup();
    const handler = createEnhanceHandler({
      getUpscaler: () => createFalUpscaler(fal as never),
      getRateLimiter: () => ({ check: () => Promise.reject(new Error('redis down')) }),
      log: () => {},
    });
    const res = await call(handler, makeRequest());
    expect(res.status).toBe(503);
    expect(fal.subscribe).not.toHaveBeenCalled();
  });

  it('logs outcome, mode and timing but no image data', async () => {
    const { handler, logs } = setup();
    await call(handler, makeRequest({ mode: 'creative' }));
    await call(handler, makeRequest({ mode: 'nope' }));
    expect(logs).toEqual([
      { event: 'enhance', outcome: 'ok', mode: 'creative', ms: expect.any(Number) },
      { event: 'enhance', outcome: 'invalid_mode', ms: expect.any(Number) },
    ]);
  });
});
