import type { Image } from 'react-native-nitro-image';

import { computeCrop } from '../crop';
import { processCapture } from '../processCapture';

const SCREEN = 852 / 393;

/** A fake nitro-image Image that records operations. */
function fakeImage(width: number, height: number, log: string[] = []): Image {
  return {
    width,
    height,
    cropAsync: jest.fn(async (x1: number, y1: number, x2: number, y2: number) => {
      log.push(`crop ${x1},${y1},${x2},${y2}`);
      return fakeImage(x2 - x1, y2 - y1, log);
    }),
    resizeAsync: jest.fn(async (w: number, h: number) => {
      log.push(`resize ${w}x${h}`);
      return fakeImage(w, h, log);
    }),
    saveToTemporaryFileAsync: jest.fn(async (format: string, quality: number) => {
      log.push(`save ${width}x${height} ${format} ${quality}`);
      return `/tmp/${width}x${height}.${format}`;
    }),
  } as unknown as Image;
}

describe('processCapture', () => {
  it('crops a 12 MP portrait photo at 8x digital and uploads it as-is when under 4 MP', async () => {
    const log: string[] = [];
    const result = await processCapture(fakeImage(3024, 4032, log), SCREEN, 8);
    const rect = computeCrop(3024, 4032, SCREEN, 8);

    expect(log[0]).toBe(`crop ${rect.x},${rect.y},${rect.x + rect.width},${rect.y + rect.height}`);
    expect(result.original).toEqual({
      uri: `file:///tmp/${rect.width}x${rect.height}.jpg`,
      width: rect.width,
      height: rect.height,
    });
    expect(log).toContain(`save ${rect.width}x${rect.height} jpg 95`);
    expect(result.upload).toBe(result.original);
    expect(log.some((l) => l.startsWith('resize'))).toBe(false);
  });

  it('downscales the upload copy of a large crop but keeps the original full size', async () => {
    const log: string[] = [];
    const result = await processCapture(fakeImage(6048, 8064, log), SCREEN, 1.2);

    expect(result.original.width * result.original.height).toBeGreaterThan(4_000_000);
    expect(result.upload.width * result.upload.height).toBeLessThanOrEqual(4_000_000);
    expect(result.upload.width / result.upload.height).toBeCloseTo(result.original.width / result.original.height, 2);
    expect(log.filter((l) => l.startsWith('save')).map((l) => l.split(' ').pop())).toEqual(['95', '90']);
  });

  it('enlarges the upload copy of a tiny 100x crop but keeps the original at sensor size', async () => {
    const log: string[] = [];
    // Samsung at 100x: 5x lens, 20x digital crop of a 3060x4080 photo.
    const result = await processCapture(fakeImage(3060, 4080, log), SCREEN, 20);

    expect(Math.min(result.original.width, result.original.height)).toBeLessThan(128);
    expect(Math.min(result.upload.width, result.upload.height)).toBe(128);
    expect(result.upload.width / result.upload.height).toBeCloseTo(result.original.width / result.original.height, 1);
    expect(log.filter((l) => l.startsWith('save')).map((l) => l.split(' ').pop())).toEqual(['95', '90']);
  });

  it('crops a landscape-grip photo with a landscape rectangle', async () => {
    const result = await processCapture(fakeImage(4032, 3024), SCREEN, 3);
    expect(result.original.width).toBeGreaterThan(result.original.height);
  });
});
