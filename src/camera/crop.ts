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
