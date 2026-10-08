/**
 * Development-only burst capture helpers (docs/capture-spike.md): cut the zoomed region out of
 * video frames on the camera thread. Both functions are worklets, so they run in the frame
 * processor; they are also plain functions for tests.
 */

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The centre of a frame that the preview shows at `digitalFactor`, widened by `margin` (1.25 = 25%
 * more on each axis) so alignment has room to move. Frames arrive in sensor orientation, but the
 * zoomed region is centred, so the same box works whichever way the phone is held.
 */
export function centerRegion(frameWidth: number, frameHeight: number, digitalFactor: number, margin = 1.25): Region {
  'worklet';
  const scale = Math.min(1, margin / Math.max(1, digitalFactor));
  const width = Math.max(1, Math.round(frameWidth * scale));
  const height = Math.max(1, Math.round(frameHeight * scale));
  return { x: Math.floor((frameWidth - width) / 2), y: Math.floor((frameHeight - height) / 2), width, height };
}

/** Copies `region` out of a 4-byte-per-pixel buffer whose rows are `bytesPerRow` apart. */
export function copyRegion(pixels: Uint8Array, bytesPerRow: number, region: Region): Uint8Array {
  'worklet';
  const rowBytes = region.width * 4;
  const out = new Uint8Array(rowBytes * region.height);
  for (let row = 0; row < region.height; row++) {
    const start = (region.y + row) * bytesPerRow + region.x * 4;
    out.set(pixels.subarray(start, start + rowBytes), row * rowBytes);
  }
  return out;
}
