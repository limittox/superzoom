import { describeLensCheck } from '../lensCheck';
import { analyzeLenses } from '../lenses';

const quad = { minZoom: 0.6, maxZoom: 10, zoomLensSwitchFactors: [], physicalDevices: [] };
const info = analyzeLenses(quad, 'android', [
  { factor: 0.6, focalLength: 2.2 },
  { factor: 1, focalLength: 6.3 },
  { factor: 3, focalLength: 7.9 },
  { factor: 5, focalLength: 18.6 },
]);

describe('describeLensCheck', () => {
  it('confirms the 5x lens at 5x', () => {
    expect(describeLensCheck(5, 5, 18.6, info)).toEqual({ level: 'log', message: '[lens-check] 5x → 18.6 mm (5x lens)' });
  });

  it('confirms the 3x lens at 4x (between lenses)', () => {
    expect(describeLensCheck(4, 4, 7.9, info).level).toBe('log');
  });

  it('expects the 5x lens past the optical range', () => {
    expect(describeLensCheck(12, 5, 18.6, info)).toEqual({ level: 'log', message: '[lens-check] 12x → 18.6 mm (5x lens)' });
  });

  it('warns when the phone used the main lens at 5x', () => {
    const check = describeLensCheck(5, 5, 6.3, info);
    expect(check.level).toBe('warn');
    expect(check.message).toContain('1x lens');
    expect(check.message).toContain('expected the 5x lens (18.6 mm)');
  });

  it('logs without judging when focal lengths are unknown (iOS, fallback)', () => {
    const fallback = analyzeLenses(quad, 'android', null);
    expect(describeLensCheck(3, 1, 6.3, fallback)).toEqual({ level: 'log', message: '[lens-check] 3x → 6.3 mm (unknown lens)' });
  });

  it('reports a missing EXIF focal length', () => {
    expect(describeLensCheck(2, 2, null, info).message).toBe('[lens-check] 2x → no EXIF focal length');
  });
});
