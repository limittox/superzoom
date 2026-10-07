import { uploadDimensions } from '@/camera/processCapture';
import { useSession } from '@/state/session';

import { File } from 'expo-file-system';

import { downloadResult, EnhanceRequestError, enhanceUrl, requestEnhancement } from '../client';
import { ALL_FAILURE_CODES, failureMessage } from '../messages';
import { createEnhancementRunner } from '../runner';

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

describe('requestEnhancement', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const respond = (status: number, body: unknown) =>
    jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });

  it('posts the upload with mode and install ID and returns the result', async () => {
    global.fetch = respond(200, { url: 'https://fal.media/out.jpg', width: 4000, height: 4000, mode: 'pro' });
    const result = await requestEnhancement(img('file:///up.jpg'), 'pro', new AbortController().signal);

    expect(result.url).toBe('https://fal.media/out.jpg');
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('/api/enhance');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'X-Install-Id': 'install-123' });
    // The image part is an expo-file-system File for the upload copy, not a { uri } descriptor.
    expect(File).toHaveBeenCalledWith('file:///up.jpg');
  });

  it('maps a server error body to its code and message', async () => {
    global.fetch = respond(429, { error: { code: 'rate_limited', message: 'x', retryAt: '2030-01-01T10:00:00Z' } });
    const error = await requestEnhancement(img('u'), 'enhance', new AbortController().signal).catch((e) => e);
    expect(error).toBeInstanceOf(EnhanceRequestError);
    expect(error.failure).toMatchObject({ code: 'rate_limited', retryAt: '2030-01-01T10:00:00Z' });
  });

  it('reports a network failure when offline', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed'));
    const error = await requestEnhancement(img('u'), 'enhance', new AbortController().signal).catch((e) => e);
    expect(error.failure.code).toBe('network');
    expect(error.failure.message).toMatch(/reach the enhancement server/);
  });

  it('reports cancelled when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    global.fetch = jest.fn().mockRejectedValue(new Error('Aborted'));
    const error = await requestEnhancement(img('u'), 'enhance', controller.signal).catch((e) => e);
    expect(error.failure.code).toBe('cancelled');
  });
});

describe('downloadResult', () => {
  const result = { url: 'https://fal.media/out.jpg', width: 4000, height: 3000, mode: 'enhance' as const };
  const fileMock = File as unknown as jest.Mock & { downloadFileAsync: jest.Mock };

  it('returns the downloaded file', async () => {
    const image = await downloadResult(result, new AbortController().signal);
    expect(image).toEqual({ uri: expect.stringMatching(/^file:\/\/\/cache\/enhanced-enhance-/), width: 4000, height: 3000 });
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

describe('enhancement runner', () => {
  beforeEach(() => {
    useSession.getState().clear();
    useSession.getState().startSession(img('orig'), img('up'), 5);
  });

  it('stores the result of a completed run', async () => {
    const runner = createEnhancementRunner(async () => img('out', 4000, 4000));
    await runner.start('enhance');
    expect(useSession.getState().results.enhance).toEqual(img('out', 4000, 4000));
  });

  it('ignores a result that arrives after cancel', async () => {
    let finish!: (v: ReturnType<typeof img>) => void;
    const signals: AbortSignal[] = [];
    const discard = jest.fn();
    const runner = createEnhancementRunner(
      (_u, _m, signal) =>
        new Promise((resolve) => {
          signals.push(signal);
          finish = resolve;
        }),
      discard,
    );
    const pending = runner.start('pro');
    await Promise.resolve();
    runner.cancel();
    expect(signals[0].aborted).toBe(true);
    finish(img('late'));
    await pending;
    expect(useSession.getState().results).toEqual({});
    expect(useSession.getState().request).toEqual({ status: 'idle' });
    expect(discard).toHaveBeenCalledWith('late');
    // The original crop is still available.
    expect(useSession.getState().original?.uri).toBe('orig');
  });

  it('aborts the previous run when a new mode starts', async () => {
    const signals: AbortSignal[] = [];
    const resolvers: ((v: ReturnType<typeof img>) => void)[] = [];
    const discard = jest.fn();
    const runner = createEnhancementRunner(
      (_u, _m, signal) =>
        new Promise((resolve) => {
          signals.push(signal);
          resolvers.push(resolve);
        }),
      discard,
    );
    const first = runner.start('enhance');
    const second = runner.start('creative');
    expect(signals[0].aborted).toBe(true);
    resolvers[0](img('stale'));
    resolvers[1](img('fresh'));
    await Promise.all([first, second]);
    expect(useSession.getState().results).toEqual({ creative: img('fresh') });
    expect(discard).toHaveBeenCalledWith('stale');
    expect(discard).not.toHaveBeenCalledWith('fresh');
  });

  it('records failures', async () => {
    const runner = createEnhancementRunner(async () => {
      throw new EnhanceRequestError({ code: 'timeout', message: 'slow' });
    });
    await runner.start('pro');
    expect(useSession.getState().request).toEqual({
      status: 'error',
      mode: 'pro',
      error: { code: 'timeout', message: 'slow' },
    });
  });
});
