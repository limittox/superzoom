import { type CameraCandidate, pickBackCamera } from '../pickBackCamera';

const cam = (c: Partial<CameraCandidate> & { id: string }): CameraCandidate => ({
  position: 'back',
  type: 'wide-angle',
  isVirtualDevice: false,
  physicalDevices: [],
  ...c,
});
const unknownLenses = (n: number) => Array.from({ length: n }, () => ({ type: 'unknown' }));

describe('pickBackCamera', () => {
  it("picks Samsung's logical quad camera over the standalone ultra-wide", () => {
    // As reported by VisionCamera 5.2.3 on a Samsung Galaxy with 0.6x, 1x, 3x and 5x lenses.
    const devices = [
      cam({ id: '0', type: 'quad', isVirtualDevice: true, physicalDevices: unknownLenses(4) }),
      cam({ id: '1', position: 'front' }),
      cam({ id: '2', type: 'ultra-wide-angle' }),
      cam({ id: '3', position: 'front', type: 'telephoto' }),
    ];
    expect(pickBackCamera(devices)?.id).toBe('0');
  });

  it('picks the iPhone triple camera', () => {
    const devices = [
      cam({ id: 'wide' }),
      cam({ id: 'ultra', type: 'ultra-wide-angle' }),
      cam({ id: 'tele', type: 'telephoto' }),
      cam({
        id: 'dual-wide',
        type: 'dual-wide',
        isVirtualDevice: true,
        physicalDevices: [{ type: 'ultra-wide-angle' }, { type: 'wide-angle' }],
      }),
      cam({
        id: 'triple',
        type: 'triple',
        isVirtualDevice: true,
        physicalDevices: [{ type: 'ultra-wide-angle' }, { type: 'wide-angle' }, { type: 'telephoto' }],
      }),
    ];
    expect(pickBackCamera(devices)?.id).toBe('triple');
  });

  it('ignores depth-only cameras', () => {
    const devices = [
      cam({ id: 'wide' }),
      cam({
        id: 'lidar',
        type: 'lidar-depth',
        isVirtualDevice: true,
        physicalDevices: [{ type: 'wide-angle' }, { type: 'lidar-depth' }],
      }),
    ];
    expect(pickBackCamera(devices)?.id).toBe('wide');
  });

  it('prefers the main wide lens among standalone cameras', () => {
    const devices = [cam({ id: 'ultra', type: 'ultra-wide-angle' }), cam({ id: 'wide' })];
    expect(pickBackCamera(devices)?.id).toBe('wide');
  });

  it('returns undefined without a rear camera', () => {
    expect(pickBackCamera([cam({ id: 'front', position: 'front' })])).toBeUndefined();
  });
});
