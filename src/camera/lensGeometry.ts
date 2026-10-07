import type { Lens, LensGeometry } from '../../modules/lens-info';

import { snapFactor } from './lenses';

export interface LensFactor {
  id: string;
  /** Zoom factor relative to the logical camera (1x), snapped to a common value. */
  factor: number;
  /** Unsnapped factor, for diagnostics. */
  rawFactor: number;
  /** mm, used to check which lens took a photo (EXIF FocalLength). */
  focalLength: number;
}

/** Tolerance when checking the widest lens against CONTROL_ZOOM_RATIO_RANGE's lower bound. */
const ZOOM_RANGE_TOLERANCE = 0.15;

const diagonal = (d: { w: number; h: number }) => Math.hypot(d.w, d.h);
const isPositive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * Field-of-view scale of a lens: usable sensor diagonal (mm) over focal length.
 * A narrower field of view gives a smaller value. Returns null for incomplete data.
 */
function fovScale(lens: Lens): number | null {
  const { focalLength, physicalSize, pixelArray, activeArray } = lens;
  const values = [focalLength, physicalSize?.w, physicalSize?.h, pixelArray?.w, pixelArray?.h, activeArray?.w, activeArray?.h];
  if (!values.every(isPositive)) return null;
  const activeDiagonalMm = diagonal(physicalSize) * (diagonal(activeArray) / diagonal(pixelArray));
  return activeDiagonalMm / focalLength;
}

/**
 * Each lens's zoom factor relative to the logical camera, from field of view rather than
 * focal length alone, since telephoto sensors are smaller (design.md decision 3).
 * Returns null when the data is incomplete or fails the zoom-range sanity check.
 */
export function computeLensFactors(geometry: LensGeometry | null): LensFactor[] | null {
  if (!geometry || !Array.isArray(geometry.lenses) || geometry.lenses.length < 2) return null;
  const reference = fovScale(geometry.reference);
  if (reference === null) return null;

  const factors: LensFactor[] = [];
  for (const lens of geometry.lenses) {
    const scale = fovScale(lens);
    if (scale === null) return null;
    const rawFactor = reference / scale;
    factors.push({ id: lens.id, factor: snapFactor(rawFactor), rawFactor, focalLength: lens.focalLength });
  }
  factors.sort((a, b) => a.rawFactor - b.rawFactor);

  const range = geometry.zoomRatioRange;
  if (range && isPositive(range[0])) {
    const widest = factors[0].rawFactor;
    if (Math.abs(widest - range[0]) / range[0] > ZOOM_RANGE_TOLERANCE) return null;
  }
  return factors;
}
