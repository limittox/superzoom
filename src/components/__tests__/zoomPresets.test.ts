import { analyzeLenses } from '@/camera/lenses';

import { zoomPresets } from '../ZoomControls';

jest.mock('react-native-reanimated', () => ({}));
jest.mock('react-native-worklets', () => ({ scheduleOnRN: jest.fn() }));

const quad = { minZoom: 0.6, maxZoom: 10, zoomLensSwitchFactors: [], physicalDevices: [] };
const samsung = analyzeLenses(quad, 'android', [
  { factor: 0.6, focalLength: 2.2 },
  { factor: 1, focalLength: 6.3 },
  { factor: 3, focalLength: 7.9 },
  { factor: 5, focalLength: 18.6 },
]);
const mainOnly = analyzeLenses(quad, 'android', null);

describe('zoomPresets', () => {
  it('offers every lens plus 10x, 30x and 100x on the Samsung', () => {
    expect(zoomPresets(samsung, 100)).toEqual([0.6, 1, 3, 5, 10, 30, 100]);
  });

  it('offers a shorter list on a phone capped at 29x', () => {
    expect(zoomPresets(mainOnly, 29)).toEqual([0.6, 1, 10, 20]);
  });

  it('falls back to the maximum when no standard preset fits', () => {
    expect(zoomPresets(mainOnly, 4.5)).toEqual([0.6, 1, 4]);
  });
});
