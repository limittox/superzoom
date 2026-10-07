import { getLensGeometry, type Lens } from '../../../modules/lens-info';

import { analyzeLenses } from '../lenses';
import { clearLensFactorCache, getCachedLensFactors, loadLensFactors } from '../useLensFactors';

jest.mock('../../../modules/lens-info', () => ({ getLensGeometry: jest.fn() }));
const mockedGeometry = getLensGeometry as jest.Mock;

function lens(id: string, focalLength: number, equivalent: number): Lens {
  const diagonalMm = (focalLength * 43.27) / equivalent;
  const pixels = { w: 4080, h: 3060 };
  return { id, focalLength, physicalSize: { w: diagonalMm * 0.8, h: diagonalMm * 0.6 }, pixelArray: pixels, activeArray: pixels };
}
const main = lens('5', 6.3, 23);
const geometry = {
  reference: { ...main, id: '0' },
  lenses: [lens('2', 2.2, 13), main, lens('6', 7.9, 67), lens('7', 18.6, 111)],
  zoomRatioRange: [0.6, 10],
};
const quad = { minZoom: 0.6, maxZoom: 10, zoomLensSwitchFactors: [], physicalDevices: [] };

beforeEach(() => {
  clearLensFactorCache();
  mockedGeometry.mockReset();
});

describe('loadLensFactors', () => {
  it('computes and caches factors once per camera', async () => {
    mockedGeometry.mockResolvedValue(geometry);
    const [a, b] = await Promise.all([loadLensFactors('0'), loadLensFactors('0')]);
    expect(a?.map((f) => f.factor)).toEqual([0.6, 1, 3, 5]);
    expect(b).toBe(a);
    await loadLensFactors('0');
    expect(mockedGeometry).toHaveBeenCalledTimes(1);
    expect(getCachedLensFactors('0')).toBe(a);
  });

  it('keeps the 1x cap when the native query returns null', async () => {
    mockedGeometry.mockResolvedValue(null);
    const factors = await loadLensFactors('0');
    expect(factors).toBeNull();
    expect(analyzeLenses(quad, 'android', factors).opticalCapDevice).toBe(1);
  });

  it('never rejects, and caches the failure', async () => {
    mockedGeometry.mockRejectedValue(new Error('camera service died'));
    await expect(loadLensFactors('0')).resolves.toBeNull();
    expect(getCachedLensFactors('0')).toBeNull();
  });

  it('feeds analyzeLenses a 5x optical cap on the Samsung geometry', async () => {
    mockedGeometry.mockResolvedValue(geometry);
    const info = analyzeLenses(quad, 'android', await loadLensFactors('0'));
    expect(info.opticalCapDisplay).toBe(5);
    expect(info.lenses.map((l) => l.displayZoom)).toEqual([0.6, 1, 3, 5]);
  });
});
