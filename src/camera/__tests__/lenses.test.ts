import { analyzeLenses, type LensSource, snapFactor, splitZoom } from '../lenses';

const phys = (...types: string[]) => types.map((type) => ({ type }));

// Real AVFoundation values: virtual devices report zoom 1 = ultra-wide.
const iPhone15ProMax: LensSource = {
  minZoom: 1,
  maxZoom: 190,
  zoomLensSwitchFactors: [2, 10],
  physicalDevices: phys('telephoto', 'wide-angle', 'ultra-wide-angle'),
};
const iPhone13Pro: LensSource = {
  minZoom: 1,
  maxZoom: 123,
  zoomLensSwitchFactors: [2, 6],
  physicalDevices: phys('ultra-wide-angle', 'wide-angle', 'telephoto'),
};
const iPhoneDualWideTele: LensSource = {
  minZoom: 1,
  maxZoom: 16,
  zoomLensSwitchFactors: [2],
  physicalDevices: phys('wide-angle', 'telephoto'),
};
const iPhoneSE: LensSource = { minZoom: 1, maxZoom: 16, zoomLensSwitchFactors: [], physicalDevices: [] };
const pixelNoLogicalTele: LensSource = {
  minZoom: 0.6,
  maxZoom: 20,
  zoomLensSwitchFactors: [],
  physicalDevices: phys('ultra-wide-angle', 'wide-angle', 'telephoto'),
};
const androidSingle: LensSource = { minZoom: 1, maxZoom: 8, zoomLensSwitchFactors: [], physicalDevices: [] };

describe('analyzeLenses (iOS)', () => {
  it('maps a triple-camera iPhone with a 5x telephoto', () => {
    const info = analyzeLenses(iPhone15ProMax, 'ios');
    expect(info.neutralZoom).toBe(2);
    expect(info.lenses).toEqual([
      { type: 'ultra-wide-angle', deviceZoom: 1, displayZoom: 0.5 },
      { type: 'wide-angle', deviceZoom: 2, displayZoom: 1 },
      { type: 'telephoto', deviceZoom: 10, displayZoom: 5 },
    ]);
    expect(info.opticalCapDevice).toBe(10);
    expect(info.opticalCapDisplay).toBe(5);
    expect(info.minDisplayZoom).toBe(0.5);
  });

  it('maps a 3x triple camera', () => {
    const info = analyzeLenses(iPhone13Pro, 'ios');
    expect(info.lenses.map((l) => l.displayZoom)).toEqual([0.5, 1, 3]);
    expect(info.opticalCapDisplay).toBe(3);
  });

  it('keeps 1x as the wide lens when there is no ultra-wide', () => {
    const info = analyzeLenses(iPhoneDualWideTele, 'ios');
    expect(info.neutralZoom).toBe(1);
    expect(info.lenses.map((l) => [l.type, l.displayZoom])).toEqual([
      ['wide-angle', 1],
      ['telephoto', 2],
    ]);
    expect(info.opticalCapDevice).toBe(2);
  });

  it('handles a single-lens phone', () => {
    const info = analyzeLenses(iPhoneSE, 'ios');
    expect(info.lenses).toEqual([{ type: 'unknown', deviceZoom: 1, displayZoom: 1 }]);
    expect(info.opticalCapDisplay).toBe(1);
  });
});

describe('analyzeLenses (Android)', () => {
  it('caps at the main lens when the telephoto cannot be located', () => {
    const info = analyzeLenses(pixelNoLogicalTele, 'android');
    expect(info.neutralZoom).toBe(1);
    expect(info.lenses).toEqual([
      { type: 'ultra-wide-angle', deviceZoom: 0.6, displayZoom: 0.6 },
      { type: 'wide-angle', deviceZoom: 1, displayZoom: 1 },
    ]);
    expect(info.opticalCapDevice).toBe(1);
    expect(info.minDisplayZoom).toBe(0.6);
  });

  it('handles a single-lens Android phone', () => {
    const info = analyzeLenses(androidSingle, 'android');
    expect(info.lenses).toEqual([{ type: 'wide-angle', deviceZoom: 1, displayZoom: 1 }]);
  });
});

describe('snapFactor', () => {
  it('snaps values within 10% of a common factor', () => {
    expect(snapFactor(2.9)).toBe(3);
    expect(snapFactor(0.52)).toBe(0.5);
    expect(snapFactor(4.8)).toBe(5);
  });
  it('rounds other values to one decimal', () => {
    expect(snapFactor(6.3)).toBe(6.3);
  });
});

describe('splitZoom', () => {
  const info = analyzeLenses(iPhone13Pro, 'ios'); // neutral 2, cap device 6 (3x)

  it('uses hardware zoom only within the optical range', () => {
    expect(splitZoom(1, info)).toEqual({ deviceZoom: 2, digitalFactor: 1 });
    expect(splitZoom(2, info)).toEqual({ deviceZoom: 4, digitalFactor: 1 });
    expect(splitZoom(3, info)).toEqual({ deviceZoom: 6, digitalFactor: 1 });
  });

  it('holds hardware zoom at the cap and goes digital beyond it', () => {
    expect(splitZoom(10, info)).toEqual({ deviceZoom: 6, digitalFactor: 10 / 3 });
  });

  it('clamps below the minimum', () => {
    expect(splitZoom(0.2, info)).toEqual({ deviceZoom: 1, digitalFactor: 1 });
  });

  it('goes digital past 1x on Android', () => {
    expect(splitZoom(4, analyzeLenses(pixelNoLogicalTele, 'android'))).toEqual({ deviceZoom: 1, digitalFactor: 4 });
  });
});
