/**
 * @jest-environment node
 */
import { ENHANCE_PATH, INSTALL_ID_HEADER, LIMITS } from '@/shared/enhance';

import { createEnhanceHandlers, type LogEvent, readBodyWithLimit } from '../enhanceHandler';
import { memoryJobStore } from '../jobStore';
import { memoryStore } from '../memoryStore';
import { createRateLimiter } from '../rateLimit';
import { makeGif, makeJpeg } from '../testing/fixtures';
import { createFalUpscaler } from '../upscaler/fal';

const INSTALL_ID = '3b241101-e2bb-4255-8caf-4136c566a962';
const OTHER_INSTALL = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const REQUEST_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** A fake fal client whose passes finish on the first status check unless told otherwise. */
function fakeFal() {
  let submitted = 0;
  return {
    storage: { upload: jest.fn().mockResolvedValue('https://fal.media/in.jpg'), transformInput: jest.fn() },
    queue: {
      submit: jest.fn(async () => ({ request_id: `fal-${++submitted}`, status: 'IN_QUEUE' })),
      status: jest.fn(async (): Promise<{ status: string }> => ({ status: 'COMPLETED' })),
      result: jest.fn(
        async (_endpoint: string, { requestId }: { requestId: string }): Promise<{ data: unknown; requestId: string }> => ({
          data: { image: { url: `https://fal.media/${requestId}.jpg` } },
          requestId,
        }),
      ),
      cancel: jest.fn().mockResolvedValue(undefined),
    },
  };
}

function setup({ limit = 50 } = {}) {
  const fal = fakeFal();
  const logs: LogEvent[] = [];
  const clock = { now: 1_000_000 };
  const limiter = createRateLimiter(memoryStore(), limit);
  const jobs = memoryJobStore(() => clock.now);
  let ids = 0;
  const handlers = createEnhanceHandlers({
    getUpscaler: () => createFalUpscaler(fal as never),
    getRateLimiter: () => limiter,
    getJobStore: () => jobs,
    log: (e) => logs.push(e),
    now: () => clock.now,
    newId: () => `job-${++ids}`,
    cancelLockWaitMs: 0,
  });
  return { fal, logs, handlers, jobs, clock };
}

function makeRequest({
  image = makeJpeg(1000, 1000) as Uint8Array | null,
  mode,
  requestId = REQUEST_ID as string | null,
  installId = INSTALL_ID as string | null,
}: { image?: Uint8Array | null; mode?: string; requestId?: string | null; installId?: string | null } = {}) {
  const form = new FormData();
  if (image) form.append('image', new Blob([image as BlobPart], { type: 'image/jpeg' }), 'crop.jpg');
  if (mode !== undefined) form.append('mode', mode);
  if (requestId) form.append('requestId', requestId);
  const headers: Record<string, string> = {};
  if (installId) headers[INSTALL_ID_HEADER] = installId;
  return new Request(`http://localhost${ENHANCE_PATH}`, { method: 'POST', body: form, headers });
}

const jobRequest = (jobId: string, method: 'GET' | 'DELETE' = 'GET', installId = INSTALL_ID) =>
  new Request(`http://localhost${ENHANCE_PATH}/${jobId}`, { method, headers: { [INSTALL_ID_HEADER]: installId } });

async function call(handler: (r: Request) => Promise<Response>, request: Request) {
  const response = await handler(request);
  return { status: response.status, headers: response.headers, body: await response.json() };
}

/** Submits a job and returns its ID. */
async function submitted(handlers: ReturnType<typeof setup>['handlers'], options: Parameters<typeof makeRequest>[0] = {}) {
  const res = await call(handlers.submit, makeRequest(options));
  expect(res.status).toBe(202);
  return res.body.jobId as string;
}

const poll = async (handlers: ReturnType<typeof setup>['handlers'], jobId: string, installId = INSTALL_ID) =>
  call((r) => handlers.status(r, jobId), jobRequest(jobId, 'GET', installId));

describe('POST /api/enhance (submit)', () => {
  it('queues pass 1 and returns a job ID without waiting for the result', async () => {
    const { handlers, fal, jobs } = setup();
    const res = await call(handlers.submit, makeRequest({ mode: 'enhance' }));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ jobId: 'job-1' });
    expect(fal.queue.submit).toHaveBeenCalledTimes(1);
    expect((fal.queue.submit.mock.calls[0] as unknown as [string])[0]).toBe('fal-ai/seedvr/upscale/image');
    expect(fal.queue.status).not.toHaveBeenCalled();
    expect(await jobs.get('job-1')).toMatchObject({ status: 'queued', installId: INSTALL_ID, providerRequestId: 'fal-1' });
  });

  it('defaults to enhance mode when mode is omitted, and routes pro mode to Topaz', async () => {
    const { handlers, fal, jobs } = setup();
    await submitted(handlers);
    await submitted(handlers, { mode: 'pro', requestId: '1f8fad5b-d9cb-469f-a165-70867728950e' });
    expect((await jobs.get('job-1'))!.mode).toBe('enhance');
    expect((fal.queue.submit.mock.calls[1] as unknown as [string])[0]).toBe('fal-ai/topaz/upscale/image');
  });

  it('returns the same job for a resubmission, running and charging it once', async () => {
    const { handlers, fal } = setup({ limit: 1 });
    const first = await call(handlers.submit, makeRequest());
    const again = await call(handlers.submit, makeRequest());
    expect(again).toMatchObject({ status: 202, body: { jobId: first.body.jobId } });
    expect(fal.storage.upload).toHaveBeenCalledTimes(1);
    expect(fal.queue.submit).toHaveBeenCalledTimes(1);
    // The limit of 1 was used once: a new request ID is now rate limited.
    const other = await call(handlers.submit, makeRequest({ requestId: '2f8fad5b-d9cb-469f-a165-70867728950e' }));
    expect(other.body.error.code).toBe('rate_limited');
  });

  it.each([
    ['missing', null],
    ['not a UUID', 'abc'],
  ])('rejects a %s request ID as bad_request without calling fal', async (_label, requestId) => {
    const { handlers, fal } = setup();
    const res = await call(handlers.submit, makeRequest({ requestId }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
    expect(fal.storage.upload).not.toHaveBeenCalled();
  });

  it('rejects an unknown mode without calling fal', async () => {
    const { handlers, fal } = setup();
    const res = await call(handlers.submit, makeRequest({ mode: 'ultra' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_mode');
    expect(fal.storage.upload).not.toHaveBeenCalled();
  });

  it('rejects a missing install ID', async () => {
    const { handlers } = setup();
    const res = await call(handlers.submit, makeRequest({ installId: null }));
    expect(res.body.error.code).toBe('missing_install_id');
  });

  it('rejects a body without an image', async () => {
    const { handlers } = setup();
    const res = await call(handlers.submit, makeRequest({ image: null }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it.each([
    ['unsupported_format', makeGif(), 415],
    ['image_too_small', makeJpeg(50, 50), 422],
    ['image_too_large', makeJpeg(4000, 3000), 422],
  ] as const)('returns %s for invalid images without creating a job', async (code, image, status) => {
    const { handlers, fal, jobs } = setup();
    const res = await call(handlers.submit, makeRequest({ image }));
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(fal.queue.submit).not.toHaveBeenCalled();
    expect(await jobs.findRequest(INSTALL_ID, REQUEST_ID)).toBeNull();
  });

  it('rejects an oversized upload as file_too_large', async () => {
    const { handlers } = setup();
    const res = await call(handlers.submit, makeRequest({ image: makeJpeg(1000, 1000, { padTo: LIMITS.maxUploadBytes + 1 }) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('file_too_large');
  });

  it('rate limits after the daily limit with a retry time', async () => {
    const { handlers, fal } = setup({ limit: 2 });
    await submitted(handlers, { requestId: 'a0000000-0000-4000-8000-000000000001' });
    await submitted(handlers, { requestId: 'a0000000-0000-4000-8000-000000000002' });
    const res = await call(handlers.submit, makeRequest({ requestId: 'a0000000-0000-4000-8000-000000000003' }));
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
    expect(new Date(res.body.error.retryAt).getTime()).toBeGreaterThan(Date.now());
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(fal.queue.submit).toHaveBeenCalledTimes(2);
  });

  it('maps a fal upload failure to provider_error, creates no job, and lets the same request ID retry', async () => {
    const { handlers, fal, jobs } = setup();
    fal.storage.upload.mockRejectedValueOnce(new Error('fal exploded'));
    const res = await call(handlers.submit, makeRequest());
    expect(res.status).toBe(502);
    expect(res.body.error).toEqual({ code: 'provider_error', message: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toContain('exploded');
    expect(await jobs.findRequest(INSTALL_ID, REQUEST_ID)).toBeNull();

    const retry = await call(handlers.submit, makeRequest());
    expect(retry.status).toBe(202);
  });

  it('fails closed when the rate limiter or job store is unavailable', async () => {
    const { fal } = setup();
    const base = { getUpscaler: () => createFalUpscaler(fal as never), log: () => {} };
    const noLimiter = createEnhanceHandlers({
      ...base,
      getRateLimiter: () => ({ check: () => Promise.reject(new Error('redis down')) }),
      getJobStore: () => memoryJobStore(),
    });
    expect((await noLimiter.submit(makeRequest())).status).toBe(503);
    const noStore = createEnhanceHandlers({
      ...base,
      getRateLimiter: () => createRateLimiter(memoryStore()),
      getJobStore: () => ({ ...memoryJobStore(), findRequest: () => Promise.reject(new Error('redis down')) }),
    });
    expect((await noStore.submit(makeRequest())).status).toBe(503);
    expect(fal.queue.submit).not.toHaveBeenCalled();
  });

  it('logs rejected submissions with outcome and timing but no image data', async () => {
    const { handlers, logs } = setup();
    await call(handlers.submit, makeRequest({ mode: 'nope' }));
    await submitted(handlers, { mode: 'creative' });
    expect(logs).toEqual([{ event: 'enhance', outcome: 'invalid_mode', ms: expect.any(Number) }]);
  });

  it('rejects an oversized body sent without Content-Length, without reading it all', async () => {
    const { handlers, fal } = setup();
    const chunk = new Uint8Array(1024 * 1024);
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
      },
    });
    const request = new Request(`http://localhost${ENHANCE_PATH}`, {
      method: 'POST',
      body: endless,
      headers: { [INSTALL_ID_HEADER]: INSTALL_ID, 'content-type': 'multipart/form-data; boundary=x' },
      // Required by Node for streaming request bodies.
      duplex: 'half',
    } as RequestInit);
    expect(request.headers.get('content-length')).toBeNull();

    const res = await call(handlers.submit, request);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('file_too_large');
    expect(pulled).toBeLessThan(25);
    expect(fal.queue.submit).not.toHaveBeenCalled();
  });
});

describe('GET /api/enhance/{jobId} (status)', () => {
  it('reports a finished single-pass job with its result, and logs it once', async () => {
    const { handlers, logs, clock } = setup();
    const jobId = await submitted(handlers, { mode: 'enhance' });
    clock.now += 8000;
    const res = await poll(handlers, jobId);
    expect(res).toMatchObject({
      status: 200,
      body: {
        jobId,
        status: 'done',
        mode: 'enhance',
        result: { url: 'https://fal.media/fal-1.jpg', width: 4000, height: 4000, mode: 'enhance' },
      },
    });
    expect(await poll(handlers, jobId)).toMatchObject({ body: { status: 'done' } });
    expect(logs).toEqual([{ event: 'enhance', outcome: 'ok', mode: 'enhance', ms: 8000 }]);
  });

  it('reports queued and processing with the pass while fal works', async () => {
    const { handlers, fal } = setup();
    const jobId = await submitted(handlers, { mode: 'enhance' });
    fal.queue.status.mockResolvedValueOnce({ status: 'IN_QUEUE' }).mockResolvedValueOnce({ status: 'IN_PROGRESS' });
    expect((await poll(handlers, jobId)).body).toEqual({ jobId, status: 'queued', mode: 'enhance', pass: 1, passes: 1 });
    expect((await poll(handlers, jobId)).body).toMatchObject({ status: 'processing', pass: 1, passes: 1 });
  });

  it('runs a tiny Pro crop in two passes, reporting pass 2 of 2 in between', async () => {
    const { handlers, fal } = setup();
    const jobId = await submitted(handlers, { mode: 'pro', image: makeJpeg(128, 275) });
    fal.queue.status.mockResolvedValueOnce({ status: 'COMPLETED' }).mockResolvedValueOnce({ status: 'IN_PROGRESS' });

    expect((await poll(handlers, jobId)).body).toMatchObject({ status: 'processing', pass: 2, passes: 2 });
    expect((await poll(handlers, jobId)).body).toMatchObject({ status: 'processing', pass: 2, passes: 2 });
    const done = await poll(handlers, jobId);
    expect(done.body).toMatchObject({ status: 'done', result: { url: 'https://fal.media/fal-2.jpg', width: 1280, height: 2750 } });
    const factors = (fal.queue.submit.mock.calls as unknown as [string, { input: { upscale_factor: number; image_url: string } }][]).map(
      ([, o]) => [o.input.upscale_factor, o.input.image_url],
    );
    expect(factors).toEqual([
      [4, 'https://fal.media/in.jpg'],
      [2.5, 'https://fal.media/fal-1.jpg'],
    ]);
  });

  it('queues pass 2 once even when two status checks overlap', async () => {
    const { handlers, fal } = setup();
    const jobId = await submitted(handlers, { mode: 'creative', image: makeJpeg(128, 275) });
    let release!: () => void;
    fal.queue.result.mockImplementationOnce(async (_e, { requestId }) => {
      await new Promise<void>((resolve) => (release = resolve));
      return { data: { image: { url: `https://fal.media/${requestId}.jpg` } }, requestId };
    });
    const first = poll(handlers, jobId);
    await new Promise((r) => setTimeout(r, 10));
    // The second check finds the job locked and reports it as stored.
    expect((await poll(handlers, jobId)).body).toMatchObject({ status: 'queued', pass: 1 });
    release();
    expect((await first).body).toMatchObject({ status: 'processing', pass: 2 });
    expect(fal.queue.submit).toHaveBeenCalledTimes(2);
  });

  it('continues a job when the app comes back long after pass 1 finished', async () => {
    const { handlers, fal, clock } = setup();
    const jobId = await submitted(handlers, { mode: 'pro', image: makeJpeg(128, 275) });
    clock.now += 5 * 60_000;
    expect((await poll(handlers, jobId)).body).toMatchObject({ status: 'processing', pass: 2 });
    expect(fal.queue.cancel).not.toHaveBeenCalled();
  });

  it('times out a pass that has waited more than 120 s and cancels it', async () => {
    const { handlers, fal, logs, clock } = setup();
    const jobId = await submitted(handlers, { mode: 'pro' });
    fal.queue.status.mockResolvedValue({ status: 'IN_QUEUE' });
    clock.now += LIMITS.providerTimeoutMs + 1;
    expect((await poll(handlers, jobId)).body).toMatchObject({ status: 'failed', error: { code: 'timeout' } });
    expect(fal.queue.cancel).toHaveBeenCalledWith('fal-ai/topaz/upscale/image', { requestId: 'fal-1' });
    expect(logs.at(-1)).toMatchObject({ outcome: 'timeout', mode: 'pro' });
  });

  it('reports a provider failure as provider_error without details', async () => {
    const { handlers, fal } = setup();
    const jobId = await submitted(handlers);
    fal.queue.result.mockRejectedValueOnce(new Error('model exploded'));
    const res = await poll(handlers, jobId);
    expect(res.body).toMatchObject({ status: 'failed', error: { code: 'provider_error' } });
    expect(JSON.stringify(res.body)).not.toContain('exploded');
  });

  it("answers job_not_found for another installation's job, revealing nothing", async () => {
    const { handlers, fal } = setup();
    const jobId = await submitted(handlers);
    const res = await poll(handlers, jobId, OTHER_INSTALL);
    expect(res).toEqual({ status: 404, headers: expect.anything(), body: { error: { code: 'job_not_found', message: expect.any(String) } } });
    expect(fal.queue.status).not.toHaveBeenCalled();
  });

  it('answers job_not_found for an unknown or expired job', async () => {
    const { handlers, clock } = setup();
    expect((await poll(handlers, 'nope')).status).toBe(404);
    const jobId = await submitted(handlers);
    clock.now += 60 * 60 * 1000;
    expect((await poll(handlers, jobId)).body.error.code).toBe('job_not_found');
  });

  it('requires the install ID', async () => {
    const { handlers } = setup();
    const jobId = await submitted(handlers);
    const res = await call((r) => handlers.status(r, jobId), new Request(`http://localhost${ENHANCE_PATH}/${jobId}`));
    expect(res.body.error.code).toBe('missing_install_id');
  });
});

describe('DELETE /api/enhance/{jobId} (cancel)', () => {
  it('cancels the queued fal pass, starts no further pass, and logs it as cancelled', async () => {
    const { handlers, fal, logs } = setup();
    const jobId = await submitted(handlers, { mode: 'creative', image: makeJpeg(128, 275) });
    const res = await call((r) => handlers.cancel(r, jobId), jobRequest(jobId, 'DELETE'));
    expect(res.body).toEqual({ jobId, status: 'cancelled', mode: 'creative' });
    expect(fal.queue.cancel).toHaveBeenCalledWith('fal-ai/clarity-upscaler', { requestId: 'fal-1' });
    expect(logs.at(-1)).toMatchObject({ outcome: 'cancelled', mode: 'creative' });

    expect((await poll(handlers, jobId)).body.status).toBe('cancelled');
    expect(fal.queue.status).not.toHaveBeenCalled();
    expect(fal.queue.submit).toHaveBeenCalledTimes(1);
  });

  it('leaves a finished job as it is', async () => {
    const { handlers, fal } = setup();
    const jobId = await submitted(handlers);
    await poll(handlers, jobId);
    const res = await call((r) => handlers.cancel(r, jobId), jobRequest(jobId, 'DELETE'));
    expect(res.body).toMatchObject({ status: 'done' });
    expect(fal.queue.cancel).not.toHaveBeenCalled();
  });

  it("can't cancel another installation's job", async () => {
    const { handlers, fal } = setup();
    const jobId = await submitted(handlers);
    const res = await call((r) => handlers.cancel(r, jobId), jobRequest(jobId, 'DELETE', OTHER_INSTALL));
    expect(res.status).toBe(404);
    expect(fal.queue.cancel).not.toHaveBeenCalled();
  });
});

describe('readBodyWithLimit', () => {
  it('returns the whole body when under the limit', async () => {
    const request = new Request('http://localhost/', { method: 'POST', body: new Uint8Array([1, 2, 3]) });
    expect(Array.from(await readBodyWithLimit(request, 10))).toEqual([1, 2, 3]);
  });

  it('throws file_too_large past the limit', async () => {
    const request = new Request('http://localhost/', { method: 'POST', body: new Uint8Array(11) });
    await expect(readBodyWithLimit(request, 10)).rejects.toMatchObject({ code: 'file_too_large' });
  });
});
