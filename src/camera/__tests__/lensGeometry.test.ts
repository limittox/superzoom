import type { Lens, LensGeometry } from '../../../modules/lens-info';

import { computeLensFactors } from '../lensGeometry';

/**
 * A lens whose 35 mm-equivalent focal length is `equivalent`, built from a real focal length
 * and a 4:3 sensor sized to match. Equivalent focal = focal × 43.27 / sensor diagonal.
 */
function lens(id: string, focalLength: number, equivalent: number, pixels = { w: 4080, h: 3060 }): Lens {
  const diagonalMm = (focalLength * 43.27) / equivalent;
  return {
    id,
    focalLength,
    physicalSize: { w: diagonalMm * 0.8, h: diagonalMm * 0.6 },
    pixelArray: { w: pixels.w + 16, h: pixels.h + 12 },
    // Active area is the pixel array minus a small border, same aspect ratio.
    activeArray: { w: pixels.w, h: pixels.h },
  };
}

// Modeled on the user's Samsung: focal lengths 2.2 / 6.3 / 7.9 / 18.6 mm from the device's camera list.
const main = lens('5', 6.3, 23);
const samsung: LensGeometry = {
  reference: { ...main, id: '0' },
  lenses: [lens('2', 2.2, 13), main, lens('6', 7.9, 67), lens('7', 18.6, 111)],
  zoomRatioRange: [0.6, 10],
};

describe('computeLensFactors', () => {
  it('yields 0.6x, 1x, 3x and 5x for the Samsung lens set', () => {
    const factors = computeLensFactors(samsung)!;
    expect(factors.map((f) => f.factor)).toEqual([0.6, 1, 3, 5]);
    expect(factors.map((f) => f.id)).toEqual(['2', '5', '6', '7']);
    expect(factors[3].focalLength).toBe(18.6);
  });

  it('labels a telephoto by field of view, not focal length', () => {
    // 18.6 / 6.3 ≈ 2.95 would suggest 3x; the smaller sensor makes it 5x.
    const factors = computeLensFactors(samsung)!;
    const tele = factors.find((f) => f.id === '7')!;
    expect(18.6 / 6.3).toBeCloseTo(2.95, 2);
    expect(tele.rawFactor).toBeCloseTo(111 / 23, 2);
    expect(tele.factor).toBe(5);
  });

  it('accounts for the active area being smaller than the pixel array', () => {
    const cropped = lens('7', 18.6, 111);
    // Use only the central half of the sensor: half the field of view, twice the zoom.
    cropped.activeArray = { w: cropped.pixelArray.w / 2, h: cropped.pixelArray.h / 2 };
    const factors = computeLensFactors({ ...samsung, lenses: [main, cropped], zoomRatioRange: null })!;
    expect(factors[1].rawFactor).toBeCloseTo((2 * 111) / 23, 1);
  });

  it('works without a reported zoom range', () => {
    expect(computeLensFactors({ ...samsung, zoomRatioRange: null })?.map((f) => f.factor)).toEqual([0.6, 1, 3, 5]);
  });

  it('rejects geometry that disagrees with the reported zoom range', () => {
    expect(computeLensFactors({ ...samsung, zoomRatioRange: [0.5, 10] })).not.toBeNull(); // 0.565 vs 0.5: within 15%
    expect(computeLensFactors({ ...samsung, zoomRatioRange: [0.4, 10] })).toBeNull();
  });

  it('returns null for missing or incomplete data', () => {
    expect(computeLensFactors(null)).toBeNull();
    expect(computeLensFactors({ ...samsung, lenses: [main] })).toBeNull();
    const broken = { ...lens('6', 7.9, 67), physicalSize: { w: 0, h: 0 } };
    expect(computeLensFactors({ ...samsung, lenses: [main, broken] })).toBeNull();
    const noFocal = { ...lens('6', 7.9, 67), focalLength: Number.NaN };
    expect(computeLensFactors({ ...samsung, lenses: [main, noFocal] })).toBeNull();
    expect(computeLensFactors({ ...samsung, reference: { ...main, focalLength: 0 } })).toBeNull();
  });
});
