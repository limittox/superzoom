import { LIMITS } from '@/shared/enhance';

import { validateImage } from '../validate';
import { makeGif, makeJpeg, makePng } from '../testing/fixtures';

describe('validateImage', () => {
  it('accepts a JPEG and reads its size past APP0/EXIF/DQT segments', () => {
    expect(validateImage(makeJpeg(1600, 1200))).toEqual({
      ok: true,
      format: 'jpeg',
      width: 1600,
      height: 1200,
      contentType: 'image/jpeg',
    });
  });

  it('accepts a PNG and reads its size from IHDR', () => {
    expect(validateImage(makePng(800, 600))).toMatchObject({ ok: true, format: 'png', width: 800, height: 600 });
  });

  it('rejects a GIF as unsupported_format', () => {
    expect(validateImage(makeGif())).toMatchObject({ ok: false, code: 'unsupported_format' });
  });

  it('rejects random bytes as unsupported_format', () => {
    expect(validateImage(new Uint8Array([1, 2, 3, 4, 5]))).toMatchObject({ ok: false, code: 'unsupported_format' });
  });

  it('rejects a truncated JPEG with no frame header', () => {
    expect(validateImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toMatchObject({
      ok: false,
      code: 'unsupported_format',
    });
  });

  it('rejects a file over 20 MB as file_too_large', () => {
    const big = makeJpeg(1000, 1000, { padTo: LIMITS.maxUploadBytes + 1 });
    expect(validateImage(big)).toMatchObject({ ok: false, code: 'file_too_large' });
  });

  it('accepts a file of exactly 20 MB', () => {
    const edge = makeJpeg(1000, 1000, { padTo: LIMITS.maxUploadBytes });
    expect(validateImage(edge)).toMatchObject({ ok: true });
  });

  it('rejects a 50x50 image as image_too_small', () => {
    expect(validateImage(makePng(50, 50))).toMatchObject({ ok: false, code: 'image_too_small' });
    expect(validateImage(makeJpeg(1000, 127))).toMatchObject({ ok: false, code: 'image_too_small' });
  });

  it('rejects a 100x crop sent without enlarging (95x204)', () => {
    expect(validateImage(makeJpeg(95, 204))).toMatchObject({ ok: false, code: 'image_too_small' });
  });

  it('accepts a 128 px short side', () => {
    expect(validateImage(makeJpeg(128, 128))).toMatchObject({ ok: true });
  });

  it('rejects a 4000x3000 image as image_too_large', () => {
    expect(validateImage(makeJpeg(4000, 3000))).toMatchObject({ ok: false, code: 'image_too_large' });
  });

  it('accepts exactly 4 MP', () => {
    expect(validateImage(makeJpeg(2000, 2000))).toMatchObject({ ok: true });
  });
});
