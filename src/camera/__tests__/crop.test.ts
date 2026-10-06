import { computeCrop, computeMaxZoom, maxDigitalFactor, MIN_CROP_PIXELS, visibleRegion } from '../crop';

// iPhone-like screen: 393 x 852 pt.
const SCREEN = 852 / 393;
const PORTRAIT = { w: 3024, h: 4032 };
const LANDSCAPE = { w: 4032, h: 3024 };

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

  it('never goes below 1 MP, even past the maximum factor', () => {
    for (const { w, h } of [PORTRAIT, LANDSCAPE, { w: 6048, h: 8064 }]) {
      const max = maxDigitalFactor(w, h, SCREEN);
      for (const d of [max, max * 1.001, max * 3]) {
        const crop = computeCrop(w, h, SCREEN, d);
        expect(crop.width * crop.height).toBeGreaterThanOrEqual(MIN_CROP_PIXELS);
      }
    }
  });

  it('treats factors below 1 as 1', () => {
    expect(computeCrop(PORTRAIT.w, PORTRAIT.h, SCREEN, 0.5)).toEqual(computeCrop(PORTRAIT.w, PORTRAIT.h, SCREEN, 1));
  });
});

describe('computeMaxZoom', () => {
  it('scales the optical cap by the 1 MP digital headroom', () => {
    const region = visibleRegion(PORTRAIT.w, PORTRAIT.h, SCREEN);
    const expected = 3 * Math.sqrt((region.width * region.height) / 1e6);
    expect(computeMaxZoom(3, PORTRAIT.w, PORTRAIT.h, SCREEN)).toBeCloseTo(expected, 6);
  });

  it('allows more zoom with a higher-resolution sensor', () => {
    expect(computeMaxZoom(1, 6048, 8064, SCREEN)).toBeGreaterThan(computeMaxZoom(1, 3024, 4032, SCREEN));
  });
});
