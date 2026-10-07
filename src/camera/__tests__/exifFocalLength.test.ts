import { readExifFocalLength } from '../exifFocalLength';

/** Builds a JPEG with an APP1 Exif segment: IFD0 → Exif sub-IFD → FocalLength rational. */
function jpegWithFocal(numerator: number, denominator: number, { little = true, inIfd0 = false } = {}): Uint8Array {
  const tiff: number[] = [];
  const u16 = (n: number) => (little ? [n & 0xff, (n >> 8) & 0xff] : [(n >> 8) & 0xff, n & 0xff]);
  const u32 = (n: number) =>
    little
      ? [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
      : [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const entry = (tag: number, type: number, count: number, value: number) => [...u16(tag), ...u16(type), ...u32(count), ...u32(value)];

  // Layout: header(8) | IFD0 at 8 | Exif IFD | rational
  const ifd0 = 8;
  if (inIfd0) {
    const rationalAt = ifd0 + 2 + 12 + 4;
    tiff.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(ifd0));
    tiff.push(...u16(1), ...entry(0x920a, 5, 1, rationalAt), ...u32(0));
    tiff.push(...u32(numerator), ...u32(denominator));
  } else {
    const exifIfd = ifd0 + 2 + 12 + 4;
    const rationalAt = exifIfd + 2 + 2 * 12 + 4;
    tiff.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(ifd0));
    tiff.push(...u16(1), ...entry(0x8769, 4, 1, exifIfd), ...u32(0));
    // An unrelated tag first (ExposureTime), then FocalLength.
    tiff.push(...u16(2), ...entry(0x829a, 5, 1, 0), ...entry(0x920a, 5, 1, rationalAt), ...u32(0));
    tiff.push(...u32(numerator), ...u32(denominator));
  }
  const app1Payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const app1 = [0xff, 0xe1, ((app1Payload.length + 2) >> 8) & 0xff, (app1Payload.length + 2) & 0xff, ...app1Payload];
  const app0 = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  return new Uint8Array([0xff, 0xd8, ...app0, ...app1, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
}

describe('readExifFocalLength', () => {
  it('reads FocalLength from a little-endian Exif sub-IFD', () => {
    expect(readExifFocalLength(jpegWithFocal(186, 10))).toBeCloseTo(18.6, 5);
  });

  it('reads FocalLength from a big-endian Exif sub-IFD', () => {
    expect(readExifFocalLength(jpegWithFocal(630, 100, { little: false }))).toBeCloseTo(6.3, 5);
  });

  it('accepts FocalLength placed in IFD0', () => {
    expect(readExifFocalLength(jpegWithFocal(79, 10, { inIfd0: true }))).toBeCloseTo(7.9, 5);
  });

  it('returns null for a JPEG without EXIF', () => {
    const plain = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xda, 0, 2]);
    expect(readExifFocalLength(plain)).toBeNull();
  });

  it('returns null for a zero denominator, non-JPEG, and truncated files', () => {
    expect(readExifFocalLength(jpegWithFocal(186, 0))).toBeNull();
    expect(readExifFocalLength(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    const full = jpegWithFocal(186, 10);
    for (const cut of [3, 10, 30, 40, full.length - 12]) {
      expect(() => readExifFocalLength(full.subarray(0, cut))).not.toThrow();
      expect(readExifFocalLength(full.subarray(0, cut))).toBeNull();
    }
  });
});
