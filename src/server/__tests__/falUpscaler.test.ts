import { createFalClient } from '@fal-ai/client';

import { ApiError } from '../errors';
import { createDefaultFalUpscaler, createFalUpscaler, describeProviderError, MODEL_TABLE } from '../upscaler/fal';

jest.mock('@fal-ai/client', () => ({ createFalClient: jest.fn() }));

function fakeFal(output: unknown = { image: { url: 'https://fal.media/out.jpg' } }) {
  return {
    storage: { upload: jest.fn().mockResolvedValue('https://fal.media/in.jpg'), transformInput: jest.fn() },
    subscribe: jest.fn().mockResolvedValue({ data: output, requestId: 'req-1' }),
  };
}

const image = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
const request = (mode: 'enhance' | 'pro' | 'creative', width = 1000, height = 1000) => ({
  image,
  width,
  height,
  mode,
  signal: new AbortController().signal,
});

describe('fal upscaler', () => {
  it.each([
    ['enhance', 'fal-ai/seedvr/upscale/image'],
    ['pro', 'fal-ai/topaz/upscale/image'],
    ['creative', 'fal-ai/clarity-upscaler'],
  ] as const)('%s mode calls %s with the chosen factor', async (mode, endpoint) => {
    const fal = fakeFal();
    const upscaler = createFalUpscaler(fal as never);

    const result = await upscaler.upscale(request(mode, 2000, 1500));

    expect(fal.storage.upload).toHaveBeenCalledWith(image, { lifecycle: { expiresIn: '1h' } });
    expect(fal.subscribe).toHaveBeenCalledTimes(1);
    const [calledEndpoint, options] = fal.subscribe.mock.calls[0];
    expect(calledEndpoint).toBe(endpoint);
    expect(options.input.image_url).toBe('https://fal.media/in.jpg');
    expect(options.input.upscale_factor).toBeCloseTo(Math.sqrt(16_000_000 / 3_000_000), 6);
    expect(options.storageSettings).toEqual({ expiresIn: '1h' });
    expect(result.url).toBe('https://fal.media/out.jpg');
  });

  it('uses factor 4 for a 1 MP crop and reports planned dimensions when fal omits them', async () => {
    const fal = fakeFal();
    const result = await createFalUpscaler(fal as never).upscale(request('enhance'));
    expect(fal.subscribe.mock.calls[0][1].input.upscale_factor).toBe(4);
    expect(result).toEqual({ url: 'https://fal.media/out.jpg', width: 4000, height: 4000 });
  });

  it('prefers dimensions reported by fal', async () => {
    const fal = fakeFal({ image: { url: 'https://fal.media/out.jpg', width: 3998, height: 3998 } });
    const result = await createFalUpscaler(fal as never).upscale(request('creative'));
    expect(result).toMatchObject({ width: 3998, height: 3998 });
  });

  it('every mode has a model', () => {
    expect(Object.keys(MODEL_TABLE).sort()).toEqual(['creative', 'enhance', 'pro']);
  });

  it('maps a provider failure to provider_error without leaking details', async () => {
    const fal = fakeFal();
    fal.subscribe.mockRejectedValue(new Error('Unauthorized: key abc123 invalid'));
    const error = await createFalUpscaler(fal as never).upscale(request('pro')).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('provider_error');
    expect(error.message).not.toContain('abc123');
  });

  it('maps a missing output image to provider_error', async () => {
    const fal = fakeFal({});
    await expect(createFalUpscaler(fal as never).upscale(request('enhance'))).rejects.toMatchObject({
      code: 'provider_error',
    });
  });

  it('maps an abort to timeout even if fal never settles', async () => {
    const fal = fakeFal();
    fal.subscribe.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const pending = createFalUpscaler(fal as never).upscale({ ...request('enhance'), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
  });

  it('builds the default client from the API key', () => {
    (createFalClient as jest.Mock).mockReturnValue(fakeFal());
    createDefaultFalUpscaler('secret-key');
    expect(createFalClient).toHaveBeenCalledWith({ credentials: 'secret-key' });
  });

  it('reports provider errors to the hook', async () => {
    const fal = fakeFal();
    const failure = Object.assign(new Error('Forbidden'), { status: 403, body: { detail: 'Exhausted balance' } });
    fal.storage.upload.mockRejectedValue(failure);
    const onProviderError = jest.fn();
    await createFalUpscaler(fal as never, onProviderError).upscale(request('enhance')).catch(() => {});
    expect(onProviderError).toHaveBeenCalledWith(failure);
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
});
