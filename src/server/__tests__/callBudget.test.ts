/**
 * @jest-environment node
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { ENHANCE_PATH, INSTALL_ID_HEADER } from '@/shared/enhance';

import { createEnhanceHandlers } from '../enhanceHandler';
import { memoryJobStore } from '../jobStore';
import { memoryStore } from '../memoryStore';
import { createRateLimiter } from '../rateLimit';
import { makeJpeg } from '../testing/fixtures';
import { createFalUpscaler } from '../upscaler/fal';

/**
 * EAS Hosting allows one request 10 outgoing calls ("Too many subrequests" past that; measured
 * 2026-10-10, docs/backend.md). Locally there is no limit, so this counts every call each request
 * makes: one per store operation (each is one Upstash round trip), and per fal call (an upload is
 * two: start, then the PUT).
 */
const BUDGET = 10;
const INSTALL_ID = '3b241101-e2bb-4255-8caf-4136c566a962';

function setup() {
  const usage = new AsyncLocalStorage<{ calls: number }>();
  const spend = (n = 1) => {
    const meter = usage.getStore();
    if (meter) meter.calls += n;
  };
  /** Wraps every method so it counts one call for the request it runs in. */
  const counted = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, key, receiver) {
        const value = Reflect.get(t, key, receiver);
        return typeof value === 'function'
          ? (...args: unknown[]) => {
              spend();
              return value.apply(t, args);
            }
          : value;
      },
    });

  let submitted = 0;
  const fal = {
    upload: jest.fn(async (..._args: unknown[]): Promise<string> => 'https://fal.media/in.jpg'),
    submit: jest.fn(async (..._args: unknown[]) => ({ request_id: `fal-${++submitted}`, status: 'IN_QUEUE' })),
    status: jest.fn(async (..._args: unknown[]): Promise<{ status: string }> => ({ status: 'COMPLETED' })),
    result: jest.fn(async (_e: string, { requestId }: { requestId: string }) => ({
      data: { image: { url: `https://fal.media/${requestId}.jpg` } },
      requestId,
    })),
    cancel: jest.fn(async (..._args: unknown[]) => undefined),
  };
  const client = {
    storage: { upload: (...a: unknown[]) => (spend(2), fal.upload(...a)), transformInput: jest.fn() },
    queue: {
      submit: (...a: unknown[]) => (spend(), fal.submit(...a)),
      status: (...a: unknown[]) => (spend(), fal.status(...a)),
      result: (...a: [string, { requestId: string }]) => (spend(), fal.result(...a)),
      cancel: (...a: unknown[]) => (spend(), fal.cancel(...a)),
    },
  };

  const clock = { now: 1_000_000 };
  const jobs = memoryJobStore(() => clock.now);
  const limiter = createRateLimiter(counted(memoryStore()), 50);
  let ids = 0;
  const handlers = createEnhanceHandlers({
    getUpscaler: () => createFalUpscaler(client as never, undefined, () => clock.now),
    getRateLimiter: () => limiter,
    getJobStore: () => counted(jobs),
    log: () => {},
    now: () => clock.now,
    newId: () => `job-${++ids}`,
    lockRetryMs: 0,
  });

  /** Runs one request and returns its response with the calls it made. */
  async function measure(handler: (r: Request) => Promise<Response>, request: Request) {
    const meter = { calls: 0 };
    const response = await usage.run(meter, () => handler(request));
    return { status: response.status, body: await response.json(), calls: meter.calls };
  }
  return { handlers, fal, jobs, clock, measure };
}

const headers = { [INSTALL_ID_HEADER]: INSTALL_ID };
function submitRequest(mode: string, requestId = '0f8fad5b-d9cb-469f-a165-70867728950e') {
  const form = new FormData();
  // 128 × 275 is a 100x crop: Pro and Creative need two passes for it.
  form.append('image', new Blob([makeJpeg(128, 275) as BlobPart], { type: 'image/jpeg' }), 'crop.jpg');
  form.append('mode', mode);
  form.append('requestId', requestId);
  return new Request(`http://localhost${ENHANCE_PATH}`, { method: 'POST', body: form, headers });
}
const jobRequest = (jobId: string, method: 'GET' | 'DELETE' = 'GET') =>
  new Request(`http://localhost${ENHANCE_PATH}/${jobId}`, { method, headers });

function hold<T>(mock: jest.Mock, value: () => T) {
  let release!: () => void;
  mock.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => (release = resolve));
    return value();
  });
  return () => release();
}
const tick = () => new Promise((r) => setTimeout(r, 10));

describe(`outgoing calls per request (EAS Hosting allows ${BUDGET})`, () => {
  it('a two-pass job: submit, the poll that queues pass 2, the poll that finishes', async () => {
    const { handlers, measure } = setup();
    const submit = await measure(handlers.submit, submitRequest('pro'));
    expect(submit).toMatchObject({ status: 202, calls: 7 });
    const jobId = submit.body.jobId;

    const second = await measure((r) => handlers.status(r, jobId), jobRequest(jobId));
    expect(second).toMatchObject({ body: { status: 'processing', pass: 2 }, calls: 5 });
    const done = await measure((r) => handlers.status(r, jobId), jobRequest(jobId));
    expect(done).toMatchObject({ body: { status: 'done' }, calls: 4 });
    // A finished job is read without the lock.
    expect((await measure((r) => handlers.status(r, jobId), jobRequest(jobId))).calls).toBe(1);
  });

  it('a cancel, and a cancel of a submission by request ID', async () => {
    const { handlers, measure } = setup();
    const jobId = (await measure(handlers.submit, submitRequest('creative'))).body.jobId;
    expect(await measure((r) => handlers.cancel(r, jobId), jobRequest(jobId, 'DELETE'))).toMatchObject({
      body: { status: 'cancelled' },
      calls: 3,
    });

    const other = '1f8fad5b-d9cb-469f-a165-70867728950e';
    await measure(handlers.submit, submitRequest('pro', other));
    const bySubmission = new Request(`http://localhost${ENHANCE_PATH}?requestId=${other}`, { method: 'DELETE', headers });
    expect(await measure(handlers.cancelSubmission, bySubmission)).toMatchObject({
      body: { status: 'cancelled' },
      calls: 4,
    });
  });

  it('a cancel that finds the job locked by a status check, and that check yielding to it', async () => {
    const { handlers, fal, measure } = setup();
    const jobId = (await measure(handlers.submit, submitRequest('creative'))).body.jobId;
    const release = hold(fal.result, () => ({ data: { image: { url: 'https://fal.media/fal-1.jpg' } }, requestId: 'x' }));
    const check = measure((r) => handlers.status(r, jobId), jobRequest(jobId));
    await tick();

    const cancel = await measure((r) => handlers.cancel(r, jobId), jobRequest(jobId, 'DELETE'));
    expect(cancel).toMatchObject({ body: { status: 'cancelled' } });
    expect(cancel.calls).toBeLessThanOrEqual(BUDGET);
    release();
    // Lock and read, status, result, pass 2 submitted, save refused, cancel pass 2, save cancelled.
    expect(await check).toMatchObject({ body: { status: 'cancelled' }, calls: 7 });
  });

  it('a submission that a cancel overtook during the upload', async () => {
    const { handlers, fal, measure } = setup();
    const release = hold(fal.upload, () => 'https://fal.media/in.jpg');
    const submit = measure(handlers.submit, submitRequest('pro'));
    await tick();
    expect((await measure((r) => handlers.cancel(r, 'job-1'), jobRequest('job-1', 'DELETE'))).calls).toBeLessThanOrEqual(
      BUDGET,
    );
    release();
    // The commit finds the job cancelled, and the new pass is cancelled: 7 + 1.
    expect(await submit).toMatchObject({ status: 202, calls: 8 });
  });

  it('a submission whose commit finds the job locked twice', async () => {
    const { handlers, jobs, measure } = setup();
    jest.spyOn(jobs, 'commitStarted').mockResolvedValue('locked');
    expect(await measure(handlers.submit, submitRequest('pro'))).toMatchObject({ status: 503, calls: 9 });
  });

  it('a status check whose save fails, so its new pass is dropped and the lock released', async () => {
    const { handlers, jobs, measure } = setup();
    const jobId = (await measure(handlers.submit, submitRequest('pro'))).body.jobId;
    jest.spyOn(jobs, 'saveAndUnlock').mockRejectedValueOnce(new Error('redis down'));
    expect(await measure((r) => handlers.status(r, jobId), jobRequest(jobId))).toMatchObject({ status: 503, calls: 7 });
  });
});
