/**
 * Lens analysis for the hybrid zoom (design.md decision 3).
 *
 * "Device zoom" is the value passed to the camera; "display zoom" is what the user
 * sees, where 1x is the main wide lens.
 */

export type LensType = 'ultra-wide-angle' | 'wide-angle' | 'telephoto';

/** The subset of a VisionCamera `CameraDevice` this module reads. */
export interface LensSource {
  minZoom: number;
  maxZoom: number;
  zoomLensSwitchFactors: readonly number[];
  physicalDevices: readonly { type: string }[];
}

export interface Lens {
  type: LensType | 'unknown';
  deviceZoom: number;
  /** Display factor, snapped to a common value for labels (e.g. 0.5, 3). */
  displayZoom: number;
  /** mm, when known (Android lens geometry); used to check which lens took a photo. */
  focalLength?: number;
}

/** A lens's zoom factor from native lens geometry (see lensGeometry.ts). */
export interface AndroidLensFactor {
  factor: number;
  focalLength: number;
}

export interface LensInfo {
  lenses: Lens[];
  /** Device zoom shown as 1x. */
  neutralZoom: number;
  minDeviceZoom: number;
  /** `C`: the highest hardware zoom that still yields a lens's native pixels, in device units. */
  opticalCapDevice: number;
  /** `C` in display units. */
  opticalCapDisplay: number;
  minDisplayZoom: number;
}

const COMMON_FACTORS = [0.5, 0.6, 0.7, 1, 2, 3, 4, 5, 8, 10];
const LENS_ORDER: LensType[] = ['ultra-wide-angle', 'wide-angle', 'telephoto'];

export function snapFactor(value: number): number {
  for (const common of COMMON_FACTORS) {
    if (Math.abs(value - common) / common <= 0.1) return common;
  }
  return Math.round(value * 10) / 10;
}

function sortedLensTypes(device: LensSource): LensType[] {
  return device.physicalDevices
    .map((d) => d.type)
    .filter((t): t is LensType => (LENS_ORDER as string[]).includes(t))
    .sort((a, b) => LENS_ORDER.indexOf(a) - LENS_ORDER.indexOf(b));
}

export function analyzeLenses(
  device: LensSource,
  platform: 'ios' | 'android',
  androidFactors?: readonly AndroidLensFactor[] | null,
): LensInfo {
  const types = sortedLensTypes(device);

  if (platform === 'ios') {
    // AVFoundation: lens native zooms are the minimum plus each switch-over factor.
    const deviceZooms = [device.minZoom, ...device.zoomLensSwitchFactors].sort((a, b) => a - b);
    const hasUltraWide = types.includes('ultra-wide-angle');
    const neutralZoom = hasUltraWide && deviceZooms.length > 1 ? deviceZooms[1] : deviceZooms[0];
    const lensTypes = types.length === deviceZooms.length ? types : [];
    const lenses = deviceZooms.map((deviceZoom, i) => ({
      type: lensTypes[i] ?? ('unknown' as const),
      deviceZoom,
      displayZoom: snapFactor(deviceZoom / neutralZoom),
    }));
    const opticalCapDevice = deviceZooms[deviceZooms.length - 1];
    return {
      lenses,
      neutralZoom,
      minDeviceZoom: device.minZoom,
      opticalCapDevice,
      opticalCapDisplay: snapFactor(opticalCapDevice / neutralZoom),
      minDisplayZoom: snapFactor(device.minZoom / neutralZoom),
    };
  }

  // Android (CameraX): ratio 1 is the main lens. VisionCamera 5.2.3 reports no switch
  // factors, so lens positions come from native lens geometry when available
  // (android-telephoto-lenses design decision 4); otherwise the cap stays at the main lens.
  if (androidFactors && androidFactors.length > 0) {
    const fromFactors = analyzeAndroidFactors(device, androidFactors);
    if (fromFactors) return fromFactors;
  }
  const lenses: Lens[] = [];
  if (device.minZoom < 1) {
    lenses.push({ type: 'ultra-wide-angle', deviceZoom: device.minZoom, displayZoom: snapFactor(device.minZoom) });
  }
  lenses.push({ type: 'wide-angle', deviceZoom: 1, displayZoom: 1 });
  return {
    lenses,
    neutralZoom: 1,
    minDeviceZoom: device.minZoom,
    opticalCapDevice: 1,
    opticalCapDisplay: 1,
    minDisplayZoom: snapFactor(device.minZoom),
  };
}

export interface ZoomSplit {
  /** Value for the camera's `zoom` prop. */
  deviceZoom: number;
  /** Extra scale applied to the preview and, at capture, as a center crop. */
  digitalFactor: number;
}

/** Splits a display zoom into hardware zoom (≤ C) and a digital factor. */
export function splitZoom(displayZoom: number, info: LensInfo): ZoomSplit {
  'worklet';
  const deviceZoom = Math.max(info.minDeviceZoom, Math.min(displayZoom * info.neutralZoom, info.opticalCapDevice));
  return { deviceZoom, digitalFactor: Math.max(1, (displayZoom * info.neutralZoom) / deviceZoom) };
}

const lensTypeForFactor = (factor: number): LensType =>
  factor < 1 ? 'ultra-wide-angle' : factor === 1 ? 'wide-angle' : 'telephoto';

/**
 * Lenses at their snapped factors within the camera's zoom range. The optical cap is the
 * snapped factor of the longest lens, so hardware zoom reaches the phone's own switch point.
 */
function analyzeAndroidFactors(device: LensSource, factors: readonly AndroidLensFactor[]): LensInfo | null {
  const byFactor = new Map<number, AndroidLensFactor>();
  for (const f of factors) {
    if (f.factor < device.minZoom * 0.95 || f.factor > device.maxZoom * 1.0001) continue;
    if (!byFactor.has(f.factor)) byFactor.set(f.factor, f);
  }
  if (!byFactor.has(1)) return null;

  const lenses: Lens[] = [...byFactor.values()]
    .sort((a, b) => a.factor - b.factor)
    .map((f) => ({
      type: lensTypeForFactor(f.factor),
      // An ultra-wide's snapped label (0.6) can sit just below the camera's real minimum.
      deviceZoom: Math.max(device.minZoom, f.factor),
      displayZoom: f.factor,
      focalLength: f.focalLength,
    }));
  const cap = Math.max(...lenses.map((l) => l.deviceZoom));
  return {
    lenses,
    neutralZoom: 1,
    minDeviceZoom: device.minZoom,
    opticalCapDevice: cap,
    opticalCapDisplay: snapFactor(cap),
    minDisplayZoom: snapFactor(device.minZoom),
  };
}
