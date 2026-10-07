import { createFalClient } from '@fal-ai/client';

import { LIMITS } from '@/shared/enhance';

import { ApiError } from '../errors';
import type { JobRecord } from '../jobStore';
import {
  createDefaultFalUpscaler,
  createFalUpscaler,
  describeProviderError,
  MODEL_TABLE,
  planForModel,
  planPasses,
} from '../upscaler/fal';

jest.mock('@fal-ai/client', () => ({ createFalClient: jest.fn() }));

type Mode = 'enhance' | 'pro' | 'creative';

/** A fake fal client: uploads return in.jpg, each submit returns the next request ID. */
function fakeFal() {
  let submitted = 0;
  return {
    storage: { upload: jest.fn().mockResolvedValue('https://fal.media/in.jpg'), transformInput: jest.fn() },
    queue: {
      submit: jest.fn(async () => ({ request_id: `fal-${++submitted}`, status: 'IN_QUEUE' })),
      status: jest.fn(async (): Promise<{ status: string }> => ({ status: 'COMPLETED' })),
      result: jest.fn(
        async (): Promise<{ data: unknown; requestId: string }> => ({
          data: { image: { url: 'https://fal.media/out.jpg' } },
          requestId: 'x',
        }),
      ),
      cancel: jest.fn().mockResolvedValue(undefined),
    },
  };
}

const image = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
const start = (mode: Mode, width = 1000, height = 1000) => ({ image, width, height, mode });

/** A job record as the submit route stores it after `start`. */
async function startedJob(fal: ReturnType<typeof fakeFal>, mode: Mode, width = 1000, height = 1000) {
  const started = await createFalUpscaler(fal as never).start(start(mode, width, height));
  const job: JobRecord = {
    id: 'job-1',
    installId: 'install-123',
    mode,
    createdAt: started.passQueuedAt!,
    status: 'queued',
    passIndex: 0,
    ...started,
  };
  return job;
}

describe('fal upscaler: start', () => {
  it.each([
    ['enhance', 'fal-ai/seedvr/upscale/image'],
    ['pro', 'fal-ai/topaz/upscale/image'],
    ['creative', 'fal-ai/clarity-upscaler'],
  ] as const)('%s mode uploads and queues pass 1 on %s with the chosen factor', async (mode, endpoint) => {
    const fal = fakeFal();
    const started = await createFalUpscaler(fal as never).start(start(mode, 2000, 1500));

    expect(fal.storage.upload).toHaveBeenCalledWith(image, { lifecycle: { expiresIn: '1h' } });
    expect(fal.queue.submit).toHaveBeenCalledTimes(1);
    const [calledEndpoint, options] = fal.queue.submit.mock.calls[0] as unknown as [string, Record<string, any>];
    expect(calledEndpoint).toBe(endpoint);
    expect(options.input.image_url).toBe('https://fal.media/in.jpg');
    expect(options.input.upscale_factor).toBeCloseTo(Math.sqrt(16_000_000 / 3_000_000), 6);
    expect(options.storageSettings).toEqual({ expiresIn: '1h' });
    // fal drops a pass that never starts, even if no one polls again.
    expect(options.startTimeout).toBe(LIMITS.providerTimeoutMs / 1000);
    expect(started).toMatchObject({ providerRequestId: 'fal-1', sourceUrl: 'https://fal.media/in.jpg', passes: [expect.any(Number)] });
  });

  it('plans factor 4 for a 1 MP crop', async () => {
    const started = await createFalUpscaler(fakeFal() as never).start(start('enhance'));
    expect(started).toMatchObject({ passes: [4], outputWidth: 4000, outputHeight: 4000 });
  });

  it('every mode has a model', () => {
    expect(Object.keys(MODEL_TABLE).sort()).toEqual(['creative', 'enhance', 'pro']);
  });

  it('maps an upload or submit failure to provider_error without leaking details, and reports it to the hook', async () => {
    const fal = fakeFal();
    const failure = Object.assign(new Error('Unauthorized: key abc123 invalid'), { status: 401 });
    fal.queue.submit.mockRejectedValueOnce(failure);
    const onProviderError = jest.fn();
    const error = await createFalUpscaler(fal as never, onProviderError).start(start('pro')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'provider_error' });
    expect((error as Error).message).not.toContain('abc123');
    expect(onProviderError).toHaveBeenCalledWith(failure);
  });

  it('builds the default client from the API key', () => {
    (createFalClient as jest.Mock).mockReturnValue(fakeFal());
    createDefaultFalUpscaler('secret-key');
    expect(createFalClient).toHaveBeenCalledWith({ credentials: 'secret-key' });
  });
});

describe('fal upscaler: advance', () => {
  it('reports a pass waiting in the queue as queued, and a running one as processing', async () => {
    const fal = fakeFal();
    const job = await startedJob(fal, 'enhance');
    const upscaler = createFalUpscaler(fal as never);

    fal.queue.status.mockResolvedValueOnce({ status: 'IN_QUEUE' });
    expect(await upscaler.advance(job, job.passQueuedAt! + 1000)).toMatchObject({ status: 'queued' });
    fal.queue.status.mockResolvedValueOnce({ status: 'IN_PROGRESS' });
    expect(await upscaler.advance(job, job.passQueuedAt! + 2000)).toMatchObject({ status: 'processing' });
    expect(fal.queue.status).toHaveBeenCalledWith('fal-ai/seedvr/upscale/image', { requestId: 'fal-1' });
    expect(fal.queue.result).not.toHaveBeenCalled();
  });

  it('finishes a single-pass job with planned dimensions when fal omits them', async () => {
    const fal = fakeFal();
    const job = await startedJob(fal, 'enhance');
    const next = await createFalUpscaler(fal as never).advance(job);
    expect(next).toMatchObject({
      status: 'done',
      result: { url: 'https://fal.media/out.jpg', width: 4000, height: 4000, mode: 'enhance' },
    });
    expect(fal.queue.submit).toHaveBeenCalledTimes(1);
  });

  it('prefers dimensions reported by fal', async () => {
    const fal = fakeFal();
    fal.queue.result.mockResolvedValueOnce({
      data: { image: { url: 'https://fal.media/out.jpg', width: 3998, height: 3998 } },
      requestId: 'x',
    });
    const next = await createFalUpscaler(fal as never).advance(await startedJob(fal, 'creative'));
    expect(next.result).toMatchObject({ width: 3998, height: 3998 });
  });

  it('fails the job with provider_error when the model failed', async () => {
    const fal = fakeFal();
    const job = await startedJob(fal, 'pro');
    fal.queue.result.mockRejectedValueOnce(new Error('Unprocessable Entity'));
    const onProviderError = jest.fn();
    const next = await createFalUpscaler(fal as never, onProviderError).advance(job);
    expect(next).toMatchObject({ status: 'failed', error: { code: 'provider_error' } });
    expect(onProviderError).toHaveBeenCalled();
  });

  it('fails the job with provider_error when fal returns no image', async () => {
    const fal = fakeFal();
    const job = await startedJob(fal, 'enhance');
    fal.queue.result.mockResolvedValueOnce({ data: {}, requestId: 'x' });
    expect(await createFalUpscaler(fal as never).advance(job)).toMatchObject({
      status: 'failed',
      error: { code: 'provider_error' },
    });
  });

  it('times out a pass still waiting after 120 s and cancels it', async () => {
    const fal = fakeFal();
    const job = await startedJob(fal, 'creative');
    fal.queue.status.mockResolvedValue({ status: 'IN_QUEUE' });
    const upscaler = createFalUpscaler(fal as never);

    expect(await upscaler.advance(job, job.passQueuedAt! + LIMITS.providerTimeoutMs)).toMatchObject({ status: 'queued' });
    const next = await upscaler.advance(job, job.passQueuedAt! + LIMITS.providerTimeoutMs + 1);
    expect(next).toMatchObject({ status: 'failed', error: { code: 'timeout' } });
    expect(fal.queue.cancel).toHaveBeenCalledWith('fal-ai/clarity-upscaler', { requestId: 'fal-1' });
  });

  it('keeps the job unchanged when a status check fails, until the timeout', async () => {
    const fal = fakeFal();
    const job = await startedJob(fal, 'enhance');
    fal.queue.status.mockRejectedValue(new Error('network'));
    const upscaler = createFalUpscaler(fal as never);
    expect(await upscaler.advance(job, job.passQueuedAt! + 5000)).toEqual(job);
    expect(await upscaler.advance(job, job.passQueuedAt! + LIMITS.providerTimeoutMs + 1)).toMatchObject({
      status: 'failed',
      error: { code: 'timeout' },
    });
  });

  it('leaves finished jobs alone', async () => {
    const fal = fakeFal();
    const job: JobRecord = { ...(await startedJob(fal, 'enhance')), status: 'cancelled' };
    expect(await createFalUpscaler(fal as never).advance(job)).toBe(job);
    expect(fal.queue.status).not.toHaveBeenCalled();
  });
});

describe('fal upscaler: cancel', () => {
  it('cancels the active pass, ignoring failures', async () => {
    const fal = fakeFal();
    const job = await startedJob(fal, 'pro');
    fal.queue.cancel.mockRejectedValueOnce(new Error('already running'));
    await expect(createFalUpscaler(fal as never).cancel(job)).resolves.toBeUndefined();
    expect(fal.queue.cancel).toHaveBeenCalledWith('fal-ai/topaz/upscale/image', { requestId: 'fal-1' });
  });

  it('does nothing for a finished job', async () => {
    const fal = fakeFal();
    const job: JobRecord = { ...(await startedJob(fal, 'pro')), status: 'done' };
    await createFalUpscaler(fal as never).cancel(job);
    expect(fal.queue.cancel).not.toHaveBeenCalled();
  });
});

describe('describeProviderError', () => {
  it('includes status, message and body, and redacts secrets', () => {
    const err = Object.assign(new Error('Forbidden for key abc:123'), {
      status: 403,
      body: { detail: 'User is locked. Reason: Exhausted balance.' },
    });
    const text = describeProviderError(err, ['abc:123']);
    expect(text).toContain('status 403');
    expect(text).toContain('Exhausted balance');
    expect(text).not.toContain('abc:123');
    expect(text).toContain('<redacted>');
  });

  it('never leaves a key prefix when the key straddles the length cut', () => {
    const key = 'fal-key-0123456789:abcdefghijklmnopqrstuvwxyz';
    const err = new Error(`${'x'.repeat(480)}${key} trailing`);
    const text = describeProviderError(err, [key]);
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text).not.toContain('fal-key-0123');
  });
});

describe('extreme-zoom upscaling (two passes for 4x models)', () => {
  // A 100x crop from the Samsung (95x204 px), enlarged to 128x275 for upload: planned factor 10.

  it('splits factors into passes the model accepts', () => {
    expect(planPasses(10, 10)).toEqual([10]);
    expect(planPasses(10, 4)).toEqual([4, 2.5]);
    expect(planPasses(3.2, 4)).toEqual([3.2]);
    expect(planPasses(4, 4)).toEqual([4]);
  });

  it('runs Enhance (SeedVR2) in a single pass, capped so the output fits 1920x1080', async () => {
    const fal = fakeFal();
    const job = await startedJob(fal, 'enhance', 128, 275);
    expect(job.passes).toHaveLength(1);
    expect((fal.queue.submit.mock.calls[0] as unknown as [string, Record<string, any>])[1].input.upscale_factor).toBeCloseTo(1920 / 275, 6);
    const next = await createFalUpscaler(fal as never).advance(job);
    expect(next.result).toEqual({ url: 'https://fal.media/out.jpg', width: 893, height: 1920, mode: 'enhance' });
  });

  it('caps SeedVR2 only for inputs under 256 px on the short side', () => {
    // fal: "Both dimensions must be at least 256 pixels when the output exceeds 1080p".
    expect(planForModel(MODEL_TABLE.enhance, 128, 275)).toEqual({ factor: 1920 / 275, outputWidth: 893, outputHeight: 1920 });
    expect(planForModel(MODEL_TABLE.enhance, 275, 128)).toEqual({ factor: 1920 / 275, outputWidth: 1920, outputHeight: 893 });
    expect(planForModel(MODEL_TABLE.enhance, 256, 550).factor).toBe(10);
    expect(planForModel(MODEL_TABLE.enhance, 1000, 1000).factor).toBe(4);
    expect(planForModel(MODEL_TABLE.pro, 128, 275).factor).toBe(10);
    expect(planForModel(MODEL_TABLE.creative, 128, 275).factor).toBe(10);
  });

  it('rejects a narrow Enhance input that cannot fit the cap even at 2x, before uploading', async () => {
    // 255x5000 at 2x would be 510x10000, beyond SeedVR2's 1920x1080 limit for small inputs.
    expect(() => planForModel(MODEL_TABLE.enhance, 255, 5000)).toThrow(ApiError);
    expect(planForModel(MODEL_TABLE.enhance, 255, 960).factor).toBe(2);
    expect(planForModel(MODEL_TABLE.pro, 255, 5000).factor).toBeGreaterThanOrEqual(2);

    const fal = fakeFal();
    await expect(createFalUpscaler(fal as never).start(start('enhance', 255, 5000))).rejects.toMatchObject({
      code: 'image_too_small',
    });
    expect(fal.storage.upload).not.toHaveBeenCalled();
    expect(fal.queue.submit).not.toHaveBeenCalled();
  });

  it.each(['pro', 'creative'] as const)('runs %s in two passes: 4x, then 2.5x on the first output', async (mode) => {
    const fal = fakeFal();
    fal.queue.result
      .mockResolvedValueOnce({ data: { image: { url: 'https://fal.media/pass1.jpg' } }, requestId: 'x' })
      .mockResolvedValueOnce({ data: { image: { url: 'https://fal.media/pass2.jpg' } }, requestId: 'x' });
    const upscaler = createFalUpscaler(fal as never);
    const job = await startedJob(fal, mode, 128, 275);
    expect(job.passes).toEqual([4, 2.5]);

    const afterPass1 = await upscaler.advance(job, 5000 + job.passQueuedAt!);
    expect(afterPass1).toMatchObject({
      status: 'processing',
      passIndex: 1,
      providerRequestId: 'fal-2',
      sourceUrl: 'https://fal.media/pass1.jpg',
      passQueuedAt: 5000 + job.passQueuedAt!,
    });
    const calls = fal.queue.submit.mock.calls as unknown as [string, Record<string, any>][];
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe(MODEL_TABLE[mode].endpoint);
    expect(calls[1][0]).toBe(MODEL_TABLE[mode].endpoint);
    expect(calls[0][1].input).toMatchObject({ image_url: 'https://fal.media/in.jpg', upscale_factor: 4 });
    expect(calls[1][1].input).toMatchObject({ image_url: 'https://fal.media/pass1.jpg', upscale_factor: 2.5 });
    expect(fal.storage.upload).toHaveBeenCalledTimes(1);

    const done = await upscaler.advance(afterPass1);
    expect(fal.queue.status).toHaveBeenLastCalledWith(MODEL_TABLE[mode].endpoint, { requestId: 'fal-2' });
    expect(done).toMatchObject({ status: 'done', result: { url: 'https://fal.media/pass2.jpg', width: 1280, height: 2750, mode } });
  });

  it('times out pass 2 from when it was queued, not from when the job started', async () => {
    const fal = fakeFal();
    const upscaler = createFalUpscaler(fal as never);
    const job = await startedJob(fal, 'pro', 128, 275);
    // The app was in the background for 5 minutes after pass 1 finished.
    const resumedAt = job.passQueuedAt! + 300_000;
    const afterPass1 = await upscaler.advance(job, resumedAt);
    fal.queue.status.mockResolvedValue({ status: 'IN_PROGRESS' });
    expect(await upscaler.advance(afterPass1, resumedAt + 60_000)).toMatchObject({ status: 'processing', passIndex: 1 });
    expect(await upscaler.advance(afterPass1, resumedAt + LIMITS.providerTimeoutMs + 1)).toMatchObject({
      status: 'failed',
      error: { code: 'timeout' },
    });
    expect(fal.queue.cancel).toHaveBeenCalledWith('fal-ai/topaz/upscale/image', { requestId: 'fal-2' });
  });

  it('maps a failure to queue pass 2 to provider_error', async () => {
    const fal = fakeFal();
    const job = await startedJob(fal, 'pro', 128, 275);
    fal.queue.submit.mockRejectedValueOnce(new Error('pass 2 failed'));
    expect(await createFalUpscaler(fal as never).advance(job)).toMatchObject({
      status: 'failed',
      error: { code: 'provider_error' },
    });
  });

  it('declares per-pass limits from the fal model docs', () => {
    expect(MODEL_TABLE.enhance.maxFactorPerPass).toBe(10);
    expect(MODEL_TABLE.pro.maxFactorPerPass).toBe(4);
    expect(MODEL_TABLE.creative.maxFactorPerPass).toBe(4);
  });
});
