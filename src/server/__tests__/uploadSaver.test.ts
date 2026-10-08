/**
 * @jest-environment node
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createUploadSaver, uploadFileName, uploadSaverFromEnv } from '../uploadSaver';

describe('upload saver (development only)', () => {
  it('is only enabled in development with SAVE_UPLOADS_DIR set', () => {
    expect(uploadSaverFromEnv({ NODE_ENV: 'development', SAVE_UPLOADS_DIR: 'eval/crops' })).toEqual(
      expect.any(Function),
    );
    expect(uploadSaverFromEnv({ NODE_ENV: 'production', SAVE_UPLOADS_DIR: 'eval/crops' })).toBeUndefined();
    expect(uploadSaverFromEnv({ NODE_ENV: 'test', SAVE_UPLOADS_DIR: 'eval/crops' })).toBeUndefined();
    expect(uploadSaverFromEnv({ NODE_ENV: 'development' })).toBeUndefined();
    expect(uploadSaverFromEnv({ NODE_ENV: 'development', SAVE_UPLOADS_DIR: '' })).toBeUndefined();
  });

  const at = new Date(2026, 9, 8, 14, 30, 5, 7);

  it('names files by time, mode and size', () => {
    expect(uploadFileName({ mode: 'pro', width: 128, height: 275, contentType: 'image/jpeg' }, at)).toBe(
      '20261008-143005-007-pro-128x275.jpg',
    );
    expect(uploadFileName({ mode: 'enhance', width: 640, height: 480, contentType: 'image/png' }, at)).toBe(
      '20261008-143005-007-enhance-640x480.png',
    );
  });

  it('writes the upload into the folder, creating it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'superzoom-uploads-'));
    jest.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const dir = join(root, 'crops');
      await createUploadSaver(
        dir,
        () => at,
        async () => ({ mkdir, writeFile }),
      )(new Uint8Array([1, 2, 3]), {
        mode: 'creative',
        width: 300,
        height: 200,
        contentType: 'image/jpeg',
      });
      expect(await readdir(dir)).toEqual(['20261008-143005-007-creative-300x200.jpg']);
      expect([...(await readFile(join(dir, '20261008-143005-007-creative-300x200.jpg')))]).toEqual([1, 2, 3]);
    } finally {
      await rm(root, { recursive: true, force: true });
      jest.restoreAllMocks();
    }
  });
});
