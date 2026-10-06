import { LIMITS } from '../enhance';
import { chooseUpscaleFactor } from '../upscale';

const mp = (plan: { outputWidth: number; outputHeight: number }) => plan.outputWidth * plan.outputHeight;

describe('chooseUpscaleFactor', () => {
  it('upscales a 1000x1000 crop 4x to exactly 16 MP', () => {
    const plan = chooseUpscaleFactor(1000, 1000);
    expect(plan).toEqual({ factor: 4, outputWidth: 4000, outputHeight: 4000 });
  });

  it('upscales a 2000x1500 crop to at most 16 MP, keeping 4:3', () => {
    const plan = chooseUpscaleFactor(2000, 1500);
    expect(plan.factor).toBeGreaterThan(2);
    expect(plan.outputWidth).toBeGreaterThanOrEqual(4000);
    expect(plan.outputHeight).toBeGreaterThanOrEqual(3000);
    expect(mp(plan)).toBeLessThanOrEqual(LIMITS.maxOutputPixels);
    expect(plan.outputWidth / plan.outputHeight).toBeCloseTo(4 / 3, 3);
  });

  it('upscales a 2000x2000 (4 MP) crop exactly 2x', () => {
    expect(chooseUpscaleFactor(2000, 2000)).toEqual({ factor: 2, outputWidth: 4000, outputHeight: 4000 });
  });

  it('caps small inputs at 4x', () => {
    expect(chooseUpscaleFactor(300, 200).factor).toBe(4);
  });

  it('rounds down to the nearest supported factor', () => {
    expect(chooseUpscaleFactor(2000, 1500, [2, 4]).factor).toBe(2);
    expect(chooseUpscaleFactor(1000, 1000, [2, 4]).factor).toBe(4);
    expect(chooseUpscaleFactor(1200, 1000, [2, 3, 4]).factor).toBe(3);
  });

  it('rejects inputs that cannot fit 2x within 16 MP', () => {
    expect(() => chooseUpscaleFactor(4000, 3000)).toThrow(RangeError);
  });

  it('rejects when no supported factor fits', () => {
    expect(() => chooseUpscaleFactor(2000, 1500, [4])).toThrow(RangeError);
  });

  it('never exceeds 16 MP across a range of sizes', () => {
    for (let w = 64; w <= 2400; w += 97) {
      for (let h = 64; h <= 2400; h += 113) {
        if (w * h > LIMITS.maxInputPixels) continue;
        const plan = chooseUpscaleFactor(w, h);
        expect(mp(plan)).toBeLessThanOrEqual(LIMITS.maxOutputPixels);
        expect(plan.factor).toBeGreaterThanOrEqual(LIMITS.minUpscale);
        expect(plan.factor).toBeLessThanOrEqual(LIMITS.maxUpscale);
      }
    }
  });
});
