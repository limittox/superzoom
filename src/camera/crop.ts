/** Crop math for capture (design.md decision 5). Coordinates are in the upright image. */

export const MIN_CROP_PIXELS = 1_000_000;

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The part of an upright photo the full-screen `cover` preview shows: the largest
 * centered rectangle with the screen's long:short ratio, long side along the image's
 * long side (true for both portrait and landscape grips with a portrait-locked UI).
 */
export function visibleRegion(width: number, height: number, screenLongOverShort: number): CropRect {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const ratio = Math.max(1, screenLongOverShort);
  let visLong: number;
  let visShort: number;
  if (ratio >= long / short) {
    visLong = long;
    visShort = long / ratio;
  } else {
    visShort = short;
    visLong = short * ratio;
  }
  const isPortrait = height >= width;
  const w = Math.round(isPortrait ? visShort : visLong);
  const h = Math.round(isPortrait ? visLong : visShort);
  return { x: Math.floor((width - w) / 2), y: Math.floor((height - h) / 2), width: w, height: h };
}

/** Largest digital factor that keeps at least 1 MP of native pixels in the crop. */
export function maxDigitalFactor(width: number, height: number, screenLongOverShort: number): number {
  const region = visibleRegion(width, height, screenLongOverShort);
  return Math.max(1, Math.sqrt((region.width * region.height) / MIN_CROP_PIXELS));
}

/** Maximum display zoom: optical cap times the largest digital factor. */
export function computeMaxZoom(
  opticalCapDisplay: number,
  photoWidth: number,
  photoHeight: number,
  screenLongOverShort: number,
): number {
  return opticalCapDisplay * maxDigitalFactor(photoWidth, photoHeight, screenLongOverShort);
}

/**
 * The crop matching what the preview showed at digital factor `digitalFactor`.
 * The factor is clamped so the crop never drops below 1 MP.
 */
export function computeCrop(
  width: number,
  height: number,
  screenLongOverShort: number,
  digitalFactor: number,
): CropRect {
  const region = visibleRegion(width, height, screenLongOverShort);
  const factor = Math.min(Math.max(1, digitalFactor), maxDigitalFactor(width, height, screenLongOverShort));
  // Round up so the 1 MP floor survives integer rounding.
  const w = Math.min(region.width, Math.ceil(region.width / factor));
  const h = Math.min(region.height, Math.ceil(region.height / factor));
  return { x: Math.floor((width - w) / 2), y: Math.floor((height - h) / 2), width: w, height: h };
}

export interface Size {
  width: number;
  height: number;
}

/** Telephoto sensors are often 12 MP even when the main lens offers more. */
export const ASSUMED_MAX_PHOTO: Size = { width: 3024, height: 4032 };

/**
 * Photo size used for the zoom limit before a real capture at the optical cap is known:
 * the smaller of the device's largest supported photo resolution and 12 MP, in portrait.
 */
export function estimatePhotoSize(supported: readonly Size[], learned?: Size): Size {
  if (learned) return learned;
  const largest = supported.reduce<Size | null>(
    (best, s) => (!best || s.width * s.height > best.width * best.height ? s : best),
    null,
  );
  const pick =
    largest && largest.width * largest.height < ASSUMED_MAX_PHOTO.width * ASSUMED_MAX_PHOTO.height
      ? largest
      : ASSUMED_MAX_PHOTO;
  return { width: Math.min(pick.width, pick.height), height: Math.max(pick.width, pick.height) };
}

/** True when the photo is too small for the requested digital factor, so the crop is wider than the preview. */
export function isFramingClamped(width: number, height: number, screenLongOverShort: number, digitalFactor: number) {
  return digitalFactor > maxDigitalFactor(width, height, screenLongOverShort) + 1e-6;
}
