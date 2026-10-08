/**
 * @jest-environment node
 */
import { burstSaverFromEnv, createBurstHandler } from '../burstSaver';

function fakeFs() {
  const files = new Map<string, Uint8Array>();
  const dirs: string[] = [];
  return {
    files,
    dirs,
    fs: {
      mkdir: async (path: string) => void dirs.push(path),
      writeFile: async (path: string, data: Uint8Array) => void files.set(path, data),
    },
  };
}

function burstRequest(meta: unknown, frames: Record<string, Uint8Array>) {
  const form = new FormData();
  form.append('meta', JSON.stringify(meta));
  for (const [name, bytes] of Object.entries(frames)) form.append(name, new Blob([bytes as BlobPart]), name);
  return new Request('http://localhost/api/dev/burst', { method: 'POST', body: form });
}

describe('burst saver (development only)', () => {
  beforeEach(() => jest.spyOn(console, 'info').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  it('is only enabled in development with SAVE_BURSTS_DIR set', () => {
    expect(burstSaverFromEnv({ NODE_ENV: 'development', SAVE_BURSTS_DIR: 'eval/bursts' })).toEqual(
      expect.any(Function),
    );
    expect(burstSaverFromEnv({ NODE_ENV: 'production', SAVE_BURSTS_DIR: 'eval/bursts' })).toBeUndefined();
    expect(burstSaverFromEnv({ NODE_ENV: 'development' })).toBeUndefined();
  });

  it('saves meta.json and each frame under the burst id', async () => {
    const { fs, files } = fakeFs();
    const handler = createBurstHandler('eval/bursts/', async () => fs);
    const res = await handler(
      burstRequest(
        { id: 'b-1', zoom: 30 },
        { 'photo-00.jpg': new Uint8Array([1]), 'video-03.rgba': new Uint8Array([2, 3]), 'night-00.jpg': new Uint8Array([4]) },
      ),
    );
    expect(await res.json()).toEqual({ id: 'b-1', frames: 3 });
    expect([...files.keys()].sort()).toEqual([
      'eval/bursts/b-1/meta.json',
      'eval/bursts/b-1/night-00.jpg',
      'eval/bursts/b-1/photo-00.jpg',
      'eval/bursts/b-1/video-03.rgba',
    ]);
    expect(JSON.parse(new TextDecoder().decode(files.get('eval/bursts/b-1/meta.json')))).toEqual({
      id: 'b-1',
      zoom: 30,
    });
  });

  it('rejects unsafe burst ids and ignores unexpected file names', async () => {
    const { fs, files } = fakeFs();
    const handler = createBurstHandler('eval/bursts', async () => fs);
    expect((await handler(burstRequest({ id: '../x' }, { 'photo-00.jpg': new Uint8Array([1]) }))).status).toBe(400);
    const res = await handler(
      burstRequest({ id: 'b-2' }, { '../evil.jpg': new Uint8Array([1]), 'photo-01.jpg': new Uint8Array([1]) }),
    );
    expect(await res.json()).toEqual({ id: 'b-2', frames: 1 });
    expect([...files.keys()].some((k) => k.includes('evil'))).toBe(false);
  });
});
