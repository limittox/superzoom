import {
  ASSUMED_MAX_PHOTO,
  computeCrop,
  computeZoomLimits,
  estimatePhotoSize,
  isFramingClamped,
  MAX_ZOOM,
  maxDigitalFactor,
  MIN_CROP_SHORT_SIDE,
  nativeDigitalFactor,
  visibleRegion,
} from '../crop';

// iPhone-like screen: 393 x 852 pt.
const SCREEN = 852 / 393;
const PORTRAIT = { w: 3024, h: 4032 };
const LANDSCAPE = { w: 4032, h: 3024 };
// Samsung 5x telephoto, 12.5 MP, upright portrait.
const SAMSUNG_5X = { w: 3060, h: 4080 };

describe('visibleRegion', () => {
  it('crops the sides of a 4:3 portrait photo for a tall screen', () => {
    const r = visibleRegion(PORTRAIT.w, PORTRAIT.h, SCREEN);
    expect(r.height).toBe(4032);
    expect(r.width).toBe(Math.round(4032 / SCREEN));
    expect(r.x).toBe(Math.floor((3024 - r.width) / 2));
    expect(r.y).toBe(0);
  });

  it('crops top and bottom of a landscape-grip photo', () => {
    const r = visibleRegion(LANDSCAPE.w, LANDSCAPE.h, SCREEN);
    expect(r.width).toBe(4032);
    expect(r.height).toBe(Math.round(4032 / SCREEN));
    expect(r.x).toBe(0);
  });

  it('crops the long side when the screen is squarer than the photo', () => {
    const r = visibleRegion(3000, 4000, 1.2);
    expect(r).toEqual({ x: 0, y: 200, width: 3000, height: 3600 });
  });
});

describe('computeCrop', () => {
  it('returns the visible region at D = 1', () => {
    expect(computeCrop(PORTRAIT.w, PORTRAIT.h, SCREEN, 1)).toEqual(visibleRegion(PORTRAIT.w, PORTRAIT.h, SCREEN));
  });

  it('center-crops by 1/D per side in portrait', () => {
    const region = visibleRegion(PORTRAIT.w, PORTRAIT.h, SCREEN);
    const crop = computeCrop(PORTRAIT.w, PORTRAIT.h, SCREEN, 2);
    expect(crop.width).toBe(Math.ceil(region.width / 2));
    expect(crop.height).toBe(2016);
    // Centered within the photo.
    expect(Math.abs(crop.x + crop.width / 2 - PORTRAIT.w / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(crop.y + crop.height / 2 - PORTRAIT.h / 2)).toBeLessThanOrEqual(1);
  });

  it('keeps the landscape orientation for a landscape-grip photo', () => {
    const crop = computeCrop(LANDSCAPE.w, LANDSCAPE.h, SCREEN, 2.5);
    expect(crop.width).toBeGreaterThan(crop.height);
    expect(crop.width / crop.height).toBeCloseTo(SCREEN, 2);
    expect(crop.x + crop.width).toBeLessThanOrEqual(LANDSCAPE.w);
    expect(crop.y + crop.height).toBeLessThanOrEqual(LANDSCAPE.h);
  });

  it('never goes below a 64 px short side, even past the maximum factor', () => {
    for (const { w, h } of [PORTRAIT, LANDSCAPE, { w: 6048, h: 8064 }]) {
      const max = maxDigitalFactor(w, h, SCREEN);
      for (const d of [max, max * 1.001, max * 3]) {
        const crop = computeCrop(w, h, SCREEN, d);
        expect(Math.min(crop.width, crop.height)).toBeGreaterThanOrEqual(MIN_CROP_SHORT_SIDE);
      }
    }
  });

  it('crops a 100x Samsung capture (5x lens, 20x digital) to about 95 x 204 px', () => {
    const crop = computeCrop(SAMSUNG_5X.w, SAMSUNG_5X.h, SCREEN, 20);
    expect(crop).toMatchObject({ width: 95, height: 204 });
  });

  it('leaves crops below the native-pixel limit unchanged by the new floor', () => {
    const native = nativeDigitalFactor(SAMSUNG_5X.w, SAMSUNG_5X.h, SCREEN);
    const crop = computeCrop(SAMSUNG_5X.w, SAMSUNG_5X.h, SCREEN, native);
    expect(crop.width * crop.height).toBeGreaterThanOrEqual(999_000);
    const region = visibleRegion(SAMSUNG_5X.w, SAMSUNG_5X.h, SCREEN);
    expect(crop.width).toBe(Math.ceil(region.width / native));
  });

  it('treats factors below 1 as 1', () => {
    expect(computeCrop(PORTRAIT.w, PORTRAIT.h, SCREEN, 0.5)).toEqual(computeCrop(PORTRAIT.w, PORTRAIT.h, SCREEN, 1));
  });
});

describe('computeZoomLimits', () => {
  it('gives a ~13.9x native-pixel limit and a 100x maximum on the Samsung 5x lens', () => {
    const { nativeLimit, maxZoom } = computeZoomLimits(5, SAMSUNG_5X.w, SAMSUNG_5X.h, SCREEN);
    expect(nativeLimit).toBeCloseTo(13.86, 1);
    expect(maxZoom).toBe(MAX_ZOOM);
  });

  it('caps a main-lens-only 12 MP phone at about 29x', () => {
    const { nativeLimit, maxZoom } = computeZoomLimits(1, 3024, 4032, SCREEN);
    expect(maxZoom).toBeCloseTo(1860 / 64, 1);
    expect(maxZoom).toBeLessThan(MAX_ZOOM);
    expect(nativeLimit).toBeCloseTo(Math.sqrt((1860 * 4032) / 1e6), 2);
  });

  it('keeps the native-pixel limit at the 1 MP rule', () => {
    const region = visibleRegion(PORTRAIT.w, PORTRAIT.h, SCREEN);
    const expected = 3 * Math.sqrt((region.width * region.height) / 1e6);
    expect(computeZoomLimits(3, PORTRAIT.w, PORTRAIT.h, SCREEN).nativeLimit).toBeCloseTo(expected, 6);
  });

  it('allows more zoom with a higher-resolution sensor, up to 100x', () => {
    const small = computeZoomLimits(1, 3024, 4032, SCREEN);
    const large = computeZoomLimits(1, 6048, 8064, SCREEN);
    expect(large.maxZoom).toBeGreaterThan(small.maxZoom);
    expect(large.nativeLimit).toBeGreaterThan(small.nativeLimit);
    expect(computeZoomLimits(10, 6048, 8064, SCREEN).maxZoom).toBe(MAX_ZOOM);
  });

  it('never puts the native-pixel limit above the maximum', () => {
    const { nativeLimit, maxZoom } = computeZoomLimits(40, 6048, 8064, SCREEN);
    expect(nativeLimit).toBeLessThanOrEqual(maxZoom);
  });
});

describe('estimatePhotoSize', () => {
  it('uses the learned size when available', () => {
    expect(estimatePhotoSize([{ width: 8064, height: 6048 }], { width: 3000, height: 4000 })).toEqual({
      width: 3000,
      height: 4000,
    });
  });

  it('caps a 48 MP device at the 12 MP assumption', () => {
    expect(estimatePhotoSize([{ width: 8064, height: 6048 }, { width: 4032, height: 3024 }])).toEqual(
      ASSUMED_MAX_PHOTO,
    );
  });

  it('uses a smaller supported resolution in portrait', () => {
    expect(estimatePhotoSize([{ width: 3264, height: 2448 }, { width: 1920, height: 1080 }])).toEqual({
      width: 2448,
      height: 3264,
    });
  });

  it('falls back to 12 MP when nothing is reported', () => {
    expect(estimatePhotoSize([])).toEqual(ASSUMED_MAX_PHOTO);
  });
});

describe('isFramingClamped', () => {
  it('detects a requested factor beyond the 64 px floor', () => {
    const max = maxDigitalFactor(2448, 3264, SCREEN);
    expect(isFramingClamped(2448, 3264, SCREEN, max)).toBe(false);
    expect(isFramingClamped(2448, 3264, SCREEN, max * 1.05)).toBe(true);
  });
});
