/**
 * Rendered tests for useZoomCamera's learned photo size. The React Compiler memoizes values
 * read from module-level maps during render; the learned size must live in React state so
 * the zoom limit updates after a capture and survives a remount.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import { computeZoomLimits, estimatePhotoSize } from '../crop';

// Minimal stand-ins for the two Reanimated hooks useZoomCamera uses (the official mock needs the native worklets runtime).
jest.mock('react-native-reanimated', () => {
  const { useRef } = require('react');
  return {
    useSharedValue: (initial: unknown) => {
      const ref = useRef({ value: initial });
      return { get: () => ref.current.value, set: (v: unknown) => void (ref.current.value = v) };
    },
    useDerivedValue: (compute: () => unknown) => ({ get: compute }),
  };
});
jest.mock('../../../modules/lens-info', () => ({ getLensGeometry: jest.fn().mockResolvedValue(null) }));
jest.mock('../processCapture', () => ({
  processCapture: jest.fn(async () => ({
    original: { uri: 'file:///orig.jpg', width: 1000, height: 1000 },
    upload: { uri: 'file:///orig.jpg', width: 1000, height: 1000 },
  })),
}));

/** Upright photo size the fake camera returns; set per test. */
let mockPhotoSize = { width: 1500, height: 2000 };
const mockPhotoOutput = {
  capturePhoto: jest.fn(async () => ({
    getFileDataAsync: async () => new ArrayBuffer(0),
    toImageAsync: async () => ({ ...mockPhotoSize }),
  })),
};
const mockDevice = {
  id: '0',
  position: 'back',
  type: 'quad',
  isVirtualDevice: true,
  physicalDevices: [{ type: 'unknown' }, { type: 'unknown' }],
  minZoom: 0.6,
  maxZoom: 10,
  zoomLensSwitchFactors: [],
  getSupportedResolutions: () => [{ width: 4080, height: 3060 }],
};
jest.mock('react-native-vision-camera', () => ({
  CommonResolutions: { HIGHEST_4_3: { width: 30000, height: 40000 } },
  useCameraDevices: () => [mockDevice],
  usePhotoOutput: () => mockPhotoOutput,
}));

const React = require('react') as typeof import('react');
const TestRenderer = require('react-test-renderer') as typeof import('react-test-renderer');
const { Platform } = jest.requireActual('react-native') as typeof import('react-native');

const SCREEN = 852 / 393;
type Hook = ReturnType<typeof import('../useZoomCamera').useZoomCamera>;

function render() {
  const { useZoomCamera } = require('../useZoomCamera') as typeof import('../useZoomCamera');
  const seen: Hook[] = [];
  function Probe() {
    seen.push(useZoomCamera(SCREEN));
    return null;
  }
  let renderer!: ReturnType<typeof TestRenderer.create>;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(React.createElement(Probe));
  });
  return { seen, renderer };
}

describe('useZoomCamera learned photo size (rendered)', () => {
  const originalOS = Platform.OS;
  beforeAll(() => Object.defineProperty(Platform, 'OS', { get: () => 'android', configurable: true }));
  afterAll(() => Object.defineProperty(Platform, 'OS', { get: () => originalOS, configurable: true }));
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  it('lowers the zoom limit after a smaller photo at the optical cap, and keeps it after a remount', async () => {
    // Without lens geometry the optical cap is 1x, and the default display zoom (1x) is at the cap.
    const estimated = estimatePhotoSize(mockDevice.getSupportedResolutions());
    const before = computeZoomLimits(1, estimated.width, estimated.height, SCREEN);
    const learned = computeZoomLimits(1, mockPhotoSize.width, mockPhotoSize.height, SCREEN);
    expect(learned.maxZoom).toBeLessThan(before.maxZoom);
    expect(learned.nativeLimit).toBeLessThan(before.nativeLimit);

    const first = render();
    expect(first.seen.at(-1)!.maxDisplayZoom).toBeCloseTo(before.maxZoom, 6);
    expect(first.seen.at(-1)!.nativeLimit).toBeCloseTo(before.nativeLimit, 6);

    let captured: Awaited<ReturnType<Hook['capture']>> = null;
    await TestRenderer.act(async () => {
      captured = await first.seen.at(-1)!.capture();
    });
    // Captured at 1x, within the native-pixel limit.
    expect(captured!.aiReconstructed).toBe(false);
    expect(first.seen.at(-1)!.maxDisplayZoom).toBeCloseTo(learned.maxZoom, 6);
    expect(first.seen.at(-1)!.nativeLimit).toBeCloseTo(learned.nativeLimit, 6);
    TestRenderer.act(() => first.renderer.unmount());

    // A new mount starts from the learned size, not the estimate.
    const second = render();
    expect(second.seen[0].maxDisplayZoom).toBeCloseTo(learned.maxZoom, 6);
    expect(second.seen[0].nativeLimit).toBeCloseTo(learned.nativeLimit, 6);
    TestRenderer.act(() => second.renderer.unmount());
  });

  it('marks a capture beyond the native-pixel limit as AI-reconstructed', async () => {
    const { seen, renderer } = render();
    const hook = seen.at(-1)!;
    expect(hook.nativeLimit).toBeLessThan(10);
    hook.displayZoom.set(10);
    let captured: Awaited<ReturnType<Hook['capture']>> = null;
    await TestRenderer.act(async () => {
      captured = await hook.capture();
    });
    expect(captured!.aiReconstructed).toBe(true);
    TestRenderer.act(() => renderer.unmount());
  });
});
