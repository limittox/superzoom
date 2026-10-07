/** Builds minimal but structurally valid image headers for tests. */

function u16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function segment(marker: number, payload: number[]): number[] {
  return [0xff, marker, ...u16(payload.length + 2), ...payload];
}

export function makeJpeg(width: number, height: number, { withExif = true, padTo = 0 } = {}): Uint8Array {
  const app0 = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const exif = withExif ? segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, ...new Array(40).fill(0)]) : [];
  const dqt = segment(0xdb, [0, ...new Array(64).fill(1)]);
  const sof0 = segment(0xc0, [8, ...u16(height), ...u16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const dht = segment(0xc4, [0, ...new Array(16).fill(0)]);
  const sos = segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]);
  const bytes = [0xff, 0xd8, ...app0, ...exif, ...dqt, ...sof0, ...dht, ...sos, 0x00, 0xff, 0xd9];
  const out = new Uint8Array(Math.max(bytes.length, padTo));
  out.set(bytes);
  return out;
}

export function makePng(width: number, height: number): Uint8Array {
  const ihdr = [...u32(13), 0x49, 0x48, 0x44, 0x52, ...u32(width), ...u32(height), 8, 2, 0, 0, 0, 0, 0, 0, 0];
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr]);
}

export function makeGif(): Uint8Array {
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0]);
}
