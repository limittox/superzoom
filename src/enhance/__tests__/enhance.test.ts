import { uploadDimensions } from '@/camera/processCapture';
import { useSession } from '@/state/session';

import { File } from 'expo-file-system';

import {
  cancelJob,
  cancelSubmission,
  downloadResult,
  EnhanceRequestError,
  enhanceUrl,
  getJob,
  submitJob,
} from '../client';
import { ALL_FAILURE_CODES, failureMessage } from '../messages';
import { createEnhancementRunner, type Foreground, type JobApi, phaseOf, POLL_TIMEOUT_MS } from '../runner';

jest.mock('expo-file-system', () => {
  const files = new Map<string, { uri: string; exists: boolean; delete: jest.Mock }>();
  const File = jest.fn((dirOrUri: unknown, name?: string) => {
    const uri = name ? `file:///cache/${name}` : String(dirOrUri);
    if (!files.has(uri)) {
      // Like the real File, the fake is a Blob, so FormData accepts it.
      const entry = Object.assign(new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), {
        uri,
        exists: false,
        delete: jest.fn(() => void (entry.exists = false)),
      });
      files.set(uri, entry);
    }
    return files.get(uri);
  }) as jest.Mock & { downloadFileAsync: jest.Mock };
  File.downloadFileAsync = jest.fn(async (_url: string, destination: { exists: boolean }) => {
    destination.exists = true;
    return destination;
  });
  return { File, Paths: { cache: 'cache' }, __files: files };
});
jest.mock('@/state/settings', () => ({ getInstallId: jest.fn().mockResolvedValue('install-123') }));

const img = (uri: string, width = 1000, height = 1000) => ({ uri, width, height });

describe('uploadDimensions', () => {
  it('scales a 12 MP crop down to at most 4 MP keeping aspect ratio', () => {
    const { width, height } = uploadDimensions(4000, 3000);
    expect(width * height).toBeLessThanOrEqual(4_000_000);
    expect(width * height).toBeGreaterThan(3_990_000);
    expect(width / height).toBeCloseTo(4 / 3, 2);
  });

  it('keeps a 1.5 MP crop at its original size', () => {
    expect(uploadDimensions(1500, 1000)).toEqual({ width: 1500, height: 1000 });
  });

  it('keeps exactly 4 MP', () => {
    expect(uploadDimensions(2000, 2000)).toEqual({ width: 2000, height: 2000 });
  });

  it('enlarges a tiny 100x crop to the 128 px minimum short side, keeping aspect ratio', () => {
    expect(uploadDimensions(95, 204)).toEqual({ width: 128, height: 275 });
    expect(uploadDimensions(204, 95)).toEqual({ width: 275, height: 128 });
  });

  it('keeps a crop whose short side is exactly the minimum', () => {
    expect(uploadDimensions(128, 300)).toEqual({ width: 128, height: 300 });
  });
});

describe('failureMessage', () => {
  it('has a message for every error code', () => {
    for (const code of ALL_FAILURE_CODES) {
      expect(failureMessage({ code })).toEqual(expect.any(String));
      expect(failureMessage({ code }).length).toBeGreaterThan(10);
    }
  });

  it('says when a rate-limited user can try again', () => {
    const retryAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(failureMessage({ code: 'rate_limited', retryAt }, 'en-US')).toMatch(/You can enhance again (tomorrow )?at /);
  });
});

describe('enhanceUrl', () => {
  it('is relative without a base URL (dev server)', () => {
    expect(enhanceUrl('')).toBe('/api/enhance');
  });
  it('joins a configured base URL', () => {
    expect(enhanceUrl('https://superzoom.expo.app/')).toBe('https://superzoom.expo.app/api/enhance');
  });
});

describe('job client', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const respond = (status: number, body: unknown) =>
    jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });
  const failure = async (promise: Promise<unknown>) => (await promise.catch((e: unknown) => e)) as EnhanceRequestError;
  const signal = () => new AbortController().signal;

  it('submits the upload with mode, request ID and install ID, and returns the job ID', async () => {
    global.fetch = respond(202, { jobId: 'job-1' });
    expect(await submitJob(img('file:///up.jpg'), 'pro', 'req-1', signal())).toBe('job-1');

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('/api/enhance');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'X-Install-Id': 'install-123' });
    expect((init.body as FormData).get('mode')).toBe('pro');
    expect((init.body as FormData).get('requestId')).toBe('req-1');
    // The image part is an expo-file-system File for the upload copy, not a { uri } descriptor.
    expect(File).toHaveBeenCalledWith('file:///up.jpg');
  });

  it.each([
    [{ jobId: 'job-1', status: 'queued', mode: 'enhance', pass: 1, passes: 1 }],
    [{ jobId: 'job-1', status: 'processing', mode: 'pro', pass: 2, passes: 2 }],
    [{ jobId: 'job-1', status: 'done', mode: 'enhance', result: { url: 'u', width: 1, height: 1, mode: 'enhance' } }],
    [{ jobId: 'job-1', status: 'failed', mode: 'enhance', error: { code: 'timeout', message: 'slow' } }],
    [{ jobId: 'job-1', status: 'cancelled', mode: 'enhance' }],
  ])('reads a job status (%o)', async (status) => {
    global.fetch = respond(200, status);
    expect(await getJob('job-1', signal())).toEqual(status);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('/api/enhance/job-1');
    expect(init).toMatchObject({ method: 'GET', headers: { 'X-Install-Id': 'install-123' } });
  });

  it('maps a server error body to its code and message', async () => {
    global.fetch = respond(429, { error: { code: 'rate_limited', message: 'x', retryAt: '2030-01-01T10:00:00Z' } });
    const error = await failure(submitJob(img('u'), 'enhance', 'req-1', signal()));
    expect(error).toBeInstanceOf(EnhanceRequestError);
    expect(error.failure).toMatchObject({ code: 'rate_limited', retryAt: '2030-01-01T10:00:00Z' });
  });

  it('maps a missing job to job_not_found', async () => {
    global.fetch = respond(404, { error: { code: 'job_not_found', message: 'gone' } });
    expect((await failure(getJob('job-1', signal()))).failure.code).toBe('job_not_found');
  });

  it('reports a network failure when offline', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed'));
    const error = await failure(getJob('job-1', signal()));
    expect(error.failure.code).toBe('network');
    expect(error.failure.message).toMatch(/reach the enhancement server/);
  });

  it('reports cancelled when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    global.fetch = jest.fn().mockRejectedValue(new Error('Aborted'));
    expect((await failure(submitJob(img('u'), 'enhance', 'req-1', controller.signal))).failure.code).toBe('cancelled');
  });

  it('sends DELETE to cancel a job and never throws', async () => {
    global.fetch = respond(200, { jobId: 'job-1', status: 'cancelled', mode: 'enhance' });
    await cancelJob('job-1');
    expect((global.fetch as jest.Mock).mock.calls[0]).toEqual([
      '/api/enhance/job-1',
      { method: 'DELETE', headers: { 'X-Install-Id': 'install-123' } },
    ]);
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed'));
    await expect(cancelJob('job-1')).resolves.toBeUndefined();
  });

  it('cancels a submission by request ID', async () => {
    global.fetch = respond(200, { requestId: 'req-1', status: 'cancelled' });
    await cancelSubmission('0f8fad5b-d9cb-469f-a165-70867728950e');
    expect((global.fetch as jest.Mock).mock.calls[0]).toEqual([
      '/api/enhance?requestId=0f8fad5b-d9cb-469f-a165-70867728950e',
      { method: 'DELETE', headers: { 'X-Install-Id': 'install-123' } },
    ]);
  });
});

describe('downloadResult', () => {
  const result = { url: 'https://fal.media/out.jpg', width: 4000, height: 3000, mode: 'enhance' as const };
  const fileMock = File as unknown as jest.Mock & { downloadFileAsync: jest.Mock };

  it('returns the downloaded file', async () => {
    const image = await downloadResult(result, new AbortController().signal);
    expect(image).toEqual({
      uri: expect.stringMatching(/^file:\/\/\/cache\/enhanced-enhance-/),
      width: 4000,
      height: 3000,
    });
  });

  it('deletes the file when cancelled during the download', async () => {
    const controller = new AbortController();
    fileMock.downloadFileAsync.mockImplementationOnce(async (_url: string, destination: { exists: boolean }) => {
      destination.exists = true;
      controller.abort();
      return destination;
    });
    const error = await downloadResult(result, controller.signal).catch((e) => e);
    expect(error.failure.code).toBe('cancelled');
    const destination = fileMock.mock.results.at(-1)!.value;
    expect(destination.delete).toHaveBeenCalled();
    expect(destination.exists).toBe(false);
  });

  it('cleans up a partial file when the download fails', async () => {
    fileMock.downloadFileAsync.mockImplementationOnce(async (_url: string, destination: { exists: boolean }) => {
      destination.exists = true;
      throw new Error('connection reset');
    });
    const error = await downloadResult(result, new AbortController().signal).catch((e) => e);
    expect(error.failure.code).toBe('network');
    expect(fileMock.mock.results.at(-1)!.value.exists).toBe(false);
  });
});

describe('phaseOf', () => {
  it('labels the queue, single passes and the second of two passes', () => {
    expect(phaseOf({ jobId: 'j', mode: 'pro', status: 'queued', pass: 1, passes: 2 })).toBe('queued');
    expect(phaseOf({ jobId: 'j', mode: 'enhance', status: 'processing', pass: 1, passes: 1 })).toBe('processing');
    expect(phaseOf({ jobId: 'j', mode: 'pro', status: 'processing', pass: 1, passes: 2 })).toBe('processing');
    expect(phaseOf({ jobId: 'j', mode: 'pro', status: 'processing', pass: 2, passes: 2 })).toBe('finishing');
  });
});

describe('enhancement runner', () => {
  const POLL = 2000;
  const GRACE = 30_000;
  type Status = Awaited<ReturnType<JobApi['get']>>;
  const status = (s: Partial<Status> & Pick<Status, 'status'>): Status => ({ jobId: 'job-1', mode: 'pro', ...s });
  const done = (url = 'https://fal.media/out.jpg') =>
    status({ status: 'done', result: { url, width: 4000, height: 4000, mode: 'pro' } });
  const networkError = () => new EnhanceRequestError({ code: 'network', message: 'offline' });

  /** A controllable app state: starts in the foreground. */
  function fakeForeground() {
    let active = true;
    const listeners = new Set<(active: boolean) => void>();
    const foreground: Foreground = {
      isActive: () => active,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const set = (value: boolean) => {
      active = value;
      for (const listener of [...listeners]) listener(value);
    };
    return { foreground, background: () => set(false), resume: () => set(true) };
  }

  function setup(statuses: (Status | Error)[] = [done()]) {
    const app = fakeForeground();
    const queue = [...statuses];
    const api = {
      submit: jest.fn<Promise<string>, Parameters<JobApi['submit']>>().mockResolvedValue('job-1'),
      get: jest.fn<Promise<Status>, Parameters<JobApi['get']>>(async () => {
        const next = queue.length > 1 ? queue.shift()! : queue[0];
        if (next instanceof Error) throw next;
        return next;
      }),
      cancel: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
      cancelSubmission: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
      download: jest.fn(async (result: { url: string }) => img(result.url, 4000, 4000)),
    };
    const discard = jest.fn();
    let requests = 0;
    const runner = createEnhancementRunner({
      api,
      foreground: app.foreground,
      discard,
      newRequestId: () => `req-${++requests}`,
      now: () => Date.now(),
      pollIntervalMs: POLL,
      networkGraceMs: GRACE,
    });
    return { app, api, discard, runner };
  }

  /** Lets pending promise callbacks run without advancing time. */
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  beforeEach(() => {
    jest.useFakeTimers();
    useSession.getState().clear();
    useSession.getState().startSession(img('orig'), img('up'), 5);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('submits, polls every 2 s with the phase, and stores the downloaded result', async () => {
    const { api, runner } = setup([
      status({ status: 'queued', pass: 1, passes: 2 }),
      status({ status: 'processing', pass: 1, passes: 2 }),
      status({ status: 'processing', pass: 2, passes: 2 }),
      done(),
    ]);
    const run = runner.start('pro');
    await flush();
    expect(api.submit).toHaveBeenCalledWith(img('up'), 'pro', 'req-1', expect.any(AbortSignal));
    expect(useSession.getState().request).toMatchObject({ status: 'pending', jobId: 'job-1', phase: 'queued' });

    await jest.advanceTimersByTimeAsync(POLL);
    expect(useSession.getState().request).toMatchObject({ phase: 'processing' });
    await jest.advanceTimersByTimeAsync(POLL);
    expect(useSession.getState().request).toMatchObject({ phase: 'finishing' });
    await jest.advanceTimersByTimeAsync(POLL);
    await run;
    expect(api.get).toHaveBeenCalledTimes(4);
    expect(useSession.getState().results.pro).toEqual(img('https://fal.media/out.jpg', 4000, 4000));
    expect(useSession.getState().request).toEqual({ status: 'idle' });
  });

  it('pauses polling in the background and polls at once on return', async () => {
    const { app, api, runner } = setup([status({ status: 'processing', pass: 1, passes: 1 })]);
    void runner.start('pro');
    await flush();
    expect(api.get).toHaveBeenCalledTimes(1);

    app.background();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.cancel).not.toHaveBeenCalled();

    app.resume();
    await flush();
    expect(api.get).toHaveBeenCalledTimes(2);
    runner.cancel();
  });

  it('shows a result that finished while the app was away, without a new upload', async () => {
    const { app, api, runner } = setup([
      status({ status: 'processing', pass: 1, passes: 1 }),
      done('https://fal.media/away.jpg'),
    ]);
    const run = runner.start('pro');
    await flush();
    app.background();
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    app.resume();
    await run;
    expect(api.submit).toHaveBeenCalledTimes(1);
    expect(useSession.getState().results.pro?.uri).toBe('https://fal.media/away.jpg');
  });

  it('resubmits with the same request ID when the upload failed while the app was away', async () => {
    const { app, api, runner } = setup([done()]);
    api.submit.mockImplementationOnce(async () => {
      app.background();
      throw networkError();
    });
    const run = runner.start('pro');
    await flush();
    expect(api.submit).toHaveBeenCalledTimes(1);
    app.resume();
    await run;
    expect(api.submit).toHaveBeenCalledTimes(2);
    expect(api.submit.mock.calls.map((c) => c[2])).toEqual(['req-1', 'req-1']);
    expect(useSession.getState().results.pro).toBeDefined();
  });

  it('reports a network failure on submit right away while in the foreground', async () => {
    const { api, runner } = setup();
    api.submit.mockRejectedValueOnce(networkError());
    await runner.start('pro');
    expect(api.submit).toHaveBeenCalledTimes(1);
    expect(useSession.getState().request).toMatchObject({ status: 'error', error: { code: 'network' } });
    expect(useSession.getState().request).not.toHaveProperty('jobId');
  });

  it('fails with network after 30 s of failed polls, keeping the job, and Retry resumes it', async () => {
    const { api, runner } = setup([networkError()]);
    void runner.start('pro');
    await flush();
    await jest.advanceTimersByTimeAsync(GRACE - POLL);
    expect(useSession.getState().request).toMatchObject({ status: 'pending' });
    await jest.advanceTimersByTimeAsync(POLL);
    await flush();
    expect(useSession.getState().request).toEqual({
      status: 'error',
      mode: 'pro',
      error: { code: 'network', message: expect.stringMatching(/reach the enhancement server/) },
      jobId: 'job-1',
      requestId: 'req-1',
    });

    api.get.mockReset().mockResolvedValue(done());
    await runner.start('pro');
    expect(api.submit).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith('job-1', expect.any(AbortSignal));
    expect(useSession.getState().results.pro).toBeDefined();
  });

  it("doesn't count time in the background towards the network failure", async () => {
    const { app, runner } = setup([networkError()]);
    void runner.start('pro');
    await flush();
    await jest.advanceTimersByTimeAsync(GRACE - 2 * POLL);
    app.background();
    await jest.advanceTimersByTimeAsync(60_000);
    app.resume();
    await flush();
    await jest.advanceTimersByTimeAsync(GRACE - 2 * POLL);
    expect(useSession.getState().request).toMatchObject({ status: 'pending' });
    runner.cancel();
  });

  it('submits a new job when Retry follows a failure that ended the job', async () => {
    const { api, runner } = setup([status({ status: 'failed', error: { code: 'timeout', message: 'slow' } })]);
    await runner.start('pro');
    expect(useSession.getState().request).toMatchObject({ status: 'error', error: { code: 'timeout' } });
    expect(useSession.getState().request).not.toHaveProperty('jobId');
    api.get.mockReset().mockResolvedValue(done());
    await runner.start('pro');
    expect(api.submit).toHaveBeenCalledTimes(2);
  });

  it('records a job that no longer exists as job_not_found', async () => {
    const { runner } = setup([new EnhanceRequestError({ code: 'job_not_found', message: 'gone' })]);
    await runner.start('pro');
    expect(useSession.getState().request).toMatchObject({ status: 'error', error: { code: 'job_not_found' } });
  });

  it('cancel stops waiting, sends DELETE, and drops a late result', async () => {
    const { api, discard, runner } = setup([status({ status: 'processing', pass: 1, passes: 1 })]);
    let finishDownload!: () => void;
    const run = runner.start('pro');
    await flush();
    api.get.mockResolvedValueOnce(done('https://fal.media/late.jpg'));
    api.download.mockImplementationOnce(
      (result: { url: string }) =>
        new Promise((resolve) => (finishDownload = () => resolve(img(result.url, 4000, 4000)))),
    );
    await jest.advanceTimersByTimeAsync(POLL);
    runner.cancel();
    expect(api.cancel).toHaveBeenCalledWith('job-1');
    finishDownload();
    await run;
    expect(useSession.getState().results).toEqual({});
    expect(useSession.getState().request).toEqual({ status: 'idle' });
    expect(discard).toHaveBeenCalledWith('https://fal.media/late.jpg');
    // The original crop is still available.
    expect(useSession.getState().original?.uri).toBe('orig');
  });

  it('lets an upload finish after Cancel, then cancels the job it created', async () => {
    const { api, runner } = setup();
    let accept!: () => void;
    let uploadSignal!: AbortSignal;
    api.submit.mockImplementationOnce((_u, _m, _r, signal) => {
      uploadSignal = signal;
      return new Promise((resolve) => (accept = () => resolve('job-late')));
    });
    const run = runner.start('pro');
    await flush();
    runner.cancel();
    expect(useSession.getState().request).toEqual({ status: 'idle' });
    // The service queues the job even if the app hangs up, so the upload isn't aborted...
    expect(uploadSignal.aborted).toBe(false);
    accept();
    await run;
    // ...and the job it created is cancelled as soon as its ID is known.
    expect(api.cancel).toHaveBeenCalledWith('job-late');
    expect(api.get).not.toHaveBeenCalled();
  });

  it('a new mode supersedes the running job: it is cancelled and its result discarded', async () => {
    const { api, runner } = setup([status({ status: 'processing', pass: 1, passes: 1 })]);
    void runner.start('enhance');
    await flush();
    api.submit.mockResolvedValueOnce('job-2');
    api.get.mockReset().mockResolvedValue(done('https://fal.media/fresh.jpg'));
    await runner.start('creative');
    expect(api.cancel).toHaveBeenCalledWith('job-1');
    expect(useSession.getState().results).toEqual({ creative: img('https://fal.media/fresh.jpg', 4000, 4000) });
  });

  /** A status check that, like fetch, only ends when its signal aborts. */
  const hangingGet = (_jobId: string, signal: AbortSignal) =>
    new Promise<Status>((_, reject) =>
      signal.addEventListener('abort', () =>
        reject(new EnhanceRequestError({ code: 'cancelled', message: 'aborted' })),
      ),
    );

  it('replaces a check that stalled while the app was away as soon as it returns, without failing', async () => {
    const { app, api, runner } = setup([status({ status: 'processing', pass: 1, passes: 1 })]);
    api.get.mockImplementationOnce(hangingGet);
    void runner.start('pro');
    await flush();
    expect(api.get).toHaveBeenCalledTimes(1);

    app.background();
    await jest.advanceTimersByTimeAsync(10_000);
    app.resume();
    await flush();
    // The stalled check was abandoned and a new one sent at once; nothing failed.
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(useSession.getState().request).toMatchObject({ status: 'pending' });
    runner.cancel();
  });

  it("doesn't fail on return when a check that started before the app left fails afterwards", async () => {
    const { app, api, runner } = setup([status({ status: 'processing', pass: 1, passes: 1 })]);
    let rejectCheck!: (err: Error) => void;
    api.get.mockImplementationOnce(() => new Promise<Status>((_, reject) => (rejectCheck = reject)));
    void runner.start('pro');
    await flush();
    app.background();
    await jest.advanceTimersByTimeAsync(60_000);
    // The network error lands just as the app comes back.
    rejectCheck(networkError());
    app.resume();
    await flush();
    expect(useSession.getState().request).toMatchObject({ status: 'pending' });
    runner.cancel();
  });

  it('gives up on a check that stalls in the foreground and fails with network after the grace period', async () => {
    const { api, runner } = setup();
    api.get.mockImplementation(hangingGet);
    void runner.start('pro');
    await flush();
    await jest.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + POLL);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(useSession.getState().request).toMatchObject({ status: 'pending' });
    await jest.advanceTimersByTimeAsync(GRACE);
    await flush();
    expect(useSession.getState().request).toMatchObject({
      status: 'error',
      error: { code: 'network' },
      jobId: 'job-1',
    });
  });

  it('resubmits with the same request ID on Retry after a submission failed in the foreground', async () => {
    const { api, runner } = setup();
    api.submit.mockRejectedValueOnce(networkError());
    await runner.start('pro');
    expect(useSession.getState().request).toMatchObject({ status: 'error', requestId: 'req-1' });
    await runner.start('pro');
    expect(api.submit.mock.calls.map((c) => c[2])).toEqual(['req-1', 'req-1']);
    expect(useSession.getState().results.pro).toBeDefined();
  });

  it('cancels a job kept after a network failure when the user leaves or picks another mode', async () => {
    const { api, runner } = setup([networkError()]);
    void runner.start('pro');
    await flush();
    await jest.advanceTimersByTimeAsync(GRACE + POLL);
    await flush();
    expect(useSession.getState().request).toMatchObject({ status: 'error', jobId: 'job-1' });

    // Leaving the result screen.
    runner.cancel();
    expect(api.cancel).toHaveBeenCalledWith('job-1');
    expect(useSession.getState().request).toEqual({ status: 'idle' });
  });

  it('cancels a job kept after a network failure when another mode starts', async () => {
    const { api, runner } = setup([networkError()]);
    void runner.start('pro');
    await flush();
    await jest.advanceTimersByTimeAsync(GRACE + POLL);
    await flush();
    api.submit.mockResolvedValueOnce('job-2');
    api.get.mockReset().mockResolvedValue(done());
    await runner.start('creative');
    expect(api.cancel).toHaveBeenCalledWith('job-1');
    expect(api.submit.mock.calls.at(-1)![2]).toBe('req-2');
  });

  it("doesn't declare a network failure while the app is away, even past the grace period", async () => {
    const { app, api, runner } = setup([networkError()]);
    void runner.start('pro');
    await flush();
    // Failing in the foreground for a while...
    await jest.advanceTimersByTimeAsync(GRACE - 2 * POLL);
    // ...then a check that fails while the app is away, well past the grace period.
    let rejectCheck!: (err: Error) => void;
    api.get.mockImplementationOnce(() => new Promise<Status>((_, reject) => (rejectCheck = reject)));
    await jest.advanceTimersByTimeAsync(2 * POLL);
    app.background();
    await jest.advanceTimersByTimeAsync(60_000);
    rejectCheck(networkError());
    await flush();
    expect(useSession.getState().request).toMatchObject({ status: 'pending' });
    runner.cancel();
  });

  it('cancels by request ID when Cancel comes before the job ID arrived', async () => {
    const { app, api, runner } = setup();
    api.submit.mockImplementationOnce(async () => {
      app.background();
      throw networkError();
    });
    const run = runner.start('pro');
    await flush();
    // The lost upload waits for the app to return; the user cancels instead.
    runner.cancel();
    await run;
    expect(api.cancelSubmission).toHaveBeenCalledWith('req-1');
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it('records failures reported by the job', async () => {
    const { runner } = setup([status({ status: 'failed', error: { code: 'provider_error', message: 'x' } })]);
    await runner.start('pro');
    expect(useSession.getState().request).toEqual({
      status: 'error',
      mode: 'pro',
      error: { code: 'provider_error', message: expect.any(String) },
    });
  });
});
