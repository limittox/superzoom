import { LIMITS } from './enhance';

export interface UpscalePlan {
  factor: number;
  outputWidth: number;
  outputHeight: number;
}

/**
 * Picks the largest upscale factor in [2, 4] whose output stays within 16 MP.
 * When the model only accepts certain factors, rounds down to the nearest
 * supported one (never below 2). See design.md decision 7.
 */
export function chooseUpscaleFactor(
  width: number,
  height: number,
  supportedFactors?: readonly number[],
): UpscalePlan {
  const pixels = width * height;
  if (!(width > 0 && height > 0)) {
    throw new RangeError(`Invalid image size ${width}x${height}`);
  }
  if (pixels * LIMITS.minUpscale ** 2 > LIMITS.maxOutputPixels) {
    throw new RangeError(`Input of ${pixels} px cannot be upscaled ${LIMITS.minUpscale}x within the output limit`);
  }

  let factor = Math.min(LIMITS.maxUpscale, Math.sqrt(LIMITS.maxOutputPixels / pixels));

  if (supportedFactors) {
    const usable = supportedFactors
      .filter((f) => f >= LIMITS.minUpscale && f <= factor)
      .sort((a, b) => b - a);
    if (usable.length === 0) {
      throw new RangeError(`No supported factor between ${LIMITS.minUpscale} and ${factor.toFixed(2)}`);
    }
    factor = usable[0];
  }

  // Floor so rounding can never push the output over the limit.
  return {
    factor,
    outputWidth: Math.floor(width * factor),
    outputHeight: Math.floor(height * factor),
  };
}
