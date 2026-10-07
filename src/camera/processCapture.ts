import type { Image } from 'react-native-nitro-image';

import { LIMITS } from '@/shared/enhance';
import type { LocalImage } from '@/state/session';

import { computeCrop } from './crop';

/** nitro-image JPEG quality is 0–100. */
const ORIGINAL_QUALITY = 95;
const UPLOAD_QUALITY = 90;

/**
 * Size of the upload copy, keeping aspect ratio: scaled down to at most 4 MP, or enlarged so
 * the short side reaches the service minimum (tiny crops from extreme zoom), else the crop itself.
 */
export function uploadDimensions(
  width: number,
  height: number,
  maxPixels: number = LIMITS.maxInputPixels,
  minSide: number = LIMITS.minSidePx,
) {
  if (width * height > maxPixels) {
    const scale = Math.sqrt(maxPixels / (width * height));
    return { width: Math.floor(width * scale), height: Math.floor(height * scale) };
  }
  const short = Math.min(width, height);
  if (short < minSide) {
    // Round up so both sides stay at or above the minimum.
    const scale = minSide / short;
    return { width: Math.max(minSide, Math.ceil(width * scale)), height: Math.max(minSide, Math.ceil(height * scale)) };
  }
  return { width, height };
}

const toUri = (path: string) => (path.startsWith('file://') ? path : `file://${path}`);

export interface ProcessedCapture {
  original: LocalImage;
  upload: LocalImage;
}

/**
 * Turns a captured photo into the full-resolution crop the user framed, plus the
 * upload copy (design.md decisions 5 and 6). `upright` must already have the capture
 * orientation applied (`Photo.toImageAsync()`).
 */
export async function processCapture(
  upright: Image,
  screenLongOverShort: number,
  digitalFactor: number,
): Promise<ProcessedCapture> {
  const rect = computeCrop(upright.width, upright.height, screenLongOverShort, digitalFactor);
  const isFullFrame = rect.width === upright.width && rect.height === upright.height;
  const cropped = isFullFrame
    ? upright
    : await upright.cropAsync(rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);

  const original: LocalImage = {
    uri: toUri(await cropped.saveToTemporaryFileAsync('jpg', ORIGINAL_QUALITY)),
    width: cropped.width,
    height: cropped.height,
  };

  const target = uploadDimensions(cropped.width, cropped.height);
  if (target.width === cropped.width && target.height === cropped.height) {
    return { original, upload: original };
  }
  const resized = await cropped.resizeAsync(target.width, target.height);
  const upload: LocalImage = {
    uri: toUri(await resized.saveToTemporaryFileAsync('jpg', UPLOAD_QUALITY)),
    width: resized.width,
    height: resized.height,
  };
  return { original, upload };
}
