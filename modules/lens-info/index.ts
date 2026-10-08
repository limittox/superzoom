import { type NativeModule, requireOptionalNativeModule } from 'expo';

export interface LensDimensions {
  w: number;
  h: number;
}

/** Raw Camera2 characteristics of one lens (or of the logical camera itself). */
export interface Lens {
  id: string;
  /** mm */
  focalLength: number;
  /** Sensor size in mm. */
  physicalSize: LensDimensions;
  /** Full sensor size in pixels. */
  pixelArray: LensDimensions;
  /** Usable sensor area in pixels. */
  activeArray: LensDimensions;
}

export interface LensGeometry {
  /** The logical camera; zoom ratio 1.0 is defined relative to it. */
  reference: Lens;
  /** The physical lenses behind it. */
  lenses: Lens[];
  /** CONTROL_ZOOM_RATIO_RANGE, when the OS reports it (Android 11+). */
  zoomRatioRange: [number, number] | null;
}

/** What a Camera2 vendor extension (Night, HDR, …) supports. Fields are null where the OS can't say. */
export interface ExtensionDetails {
  type: 'auto' | 'face-retouch' | 'bokeh' | 'hdr' | 'night' | string;
  /** Whether CONTROL_ZOOM_RATIO is honoured (Android 13+). */
  supportsZoom: boolean | null;
  requestKeys: string[] | null;
  /** The extension's zoom ratio range (Android 15+). */
  zoomRatioRange: [number, number] | null;
  maxJpegSize: LensDimensions | null;
  captureLatencyMs: [number, number] | null;
}

export interface ExtensionInfo {
  sdkInt: number;
  extensions: ExtensionDetails[];
  /** Set when the query failed: the step and the exception. Older native builds omit it. */
  error?: string | null;
}

/** Largest regular and "high resolution" (slower, burst-incapable) output size of one format. */
export interface StreamSizes {
  largest: LensDimensions | null;
  highRes: LensDimensions | null;
}

export type StreamFormats = Record<'jpeg' | 'yuv' | 'raw', StreamSizes>;

/** The output sizes one camera offers apps. Fields are null where the OS is too old to report them. */
export interface CameraSensorModes {
  id: string;
  /** The logical camera this physical lens belongs to; null for a top-level camera. */
  parent: string | null;
  facing: 'back' | 'front' | 'external';
  focalLength: number | null;
  pixelArray: LensDimensions | null;
  logicalMultiCamera: boolean;
  raw: boolean;
  /** ULTRA_HIGH_RESOLUTION_SENSOR: a pixel-binned sensor that can also output unbinned (Android 12+). */
  ultraHighResolution: boolean | null;
  remosaicReprocessing: boolean | null;
  pixelArrayMaxRes: LensDimensions | null;
  binningFactor: LensDimensions | null;
  /** Whether capture requests may set SENSOR_PIXEL_MODE. */
  pixelModeRequestKey: boolean | null;
  default: StreamFormats | null;
  /** Sizes in maximum-resolution pixel mode. */
  maxRes: StreamFormats | null;
}

export interface SensorModesInfo {
  sdkInt: number;
  cameras: CameraSensorModes[];
  error?: string | null;
}

/** One photo through the Night extension. Times are milliseconds since the call. */
export interface NightCaptureResult {
  /** file:// URI of the JPEG in the app cache. */
  uri: string;
  width: number;
  height: number;
  bytes: number;
  /** Degrees the JPEG must turn clockwise to be upright with the phone held in its natural orientation. */
  sensorOrientation: number | null;
  zoomRatio: number;
  /** Whether a preview stream ran before the capture (false: the session refused it). */
  preview: boolean;
  previewSize: LensDimensions | null;
  warmupMs: number;
  openAttempts: number;
  timingsMs: Record<string, number>;
}

declare class LensInfoModule extends NativeModule {
  getLensGeometry(cameraId: string): Promise<LensGeometry | null>;
  getExtensionInfo(cameraId: string): Promise<ExtensionInfo | null>;
  getSensorModes(): Promise<SensorModesInfo>;
  captureNight(cameraId: string, zoomRatio: number, warmupMs: number): Promise<NightCaptureResult>;
}

// Android only. iOS, web and Jest have no native module, so this is null there.
const native = requireOptionalNativeModule<LensInfoModule>('LensInfo');

/** Lens geometry for a logical camera, or null where unavailable (iOS, non-logical cameras, errors). */
export async function getLensGeometry(cameraId: string): Promise<LensGeometry | null> {
  if (!native) return null;
  try {
    return await native.getLensGeometry(cameraId);
  } catch {
    return null;
  }
}

/**
 * Camera2 extension capabilities for a camera (Android 12+), or null where unavailable.
 * Don't call it while VisionCamera queries extensions (`useCameraDeviceExtensions`): both use
 * Android's process-wide extension service, and overlapping calls fail with "Service not registered".
 */
export async function getExtensionInfo(cameraId: string): Promise<ExtensionInfo | null> {
  if (!native?.getExtensionInfo) return null;
  try {
    return await native.getExtensionInfo(cameraId);
  } catch (error) {
    if (__DEV__) console.warn('[extension-info] native query failed:', error);
    return null;
  }
}

/**
 * Output sizes of every camera and physical lens, including the full-resolution sensor mode
 * (Android 12+), or null where unavailable. Development diagnostics: can apps reach the
 * telephoto's unbinned 50 MP?
 */
export async function getSensorModes(): Promise<SensorModesInfo | null> {
  if (!native?.getSensorModes) return null;
  try {
    return await native.getSensorModes();
  } catch (error) {
    if (__DEV__) console.warn('[sensor-modes] native query failed:', error);
    return null;
  }
}

/**
 * Development only: takes one photo through the camera's Night extension (Android 12+) at a zoom
 * ratio, after `warmupMs` of preview for focus and exposure. It opens the camera itself, so the app's
 * camera session must be stopped first. Rejects where unavailable, including builds without it.
 */
export async function captureNight(cameraId: string, zoomRatio: number, warmupMs = 1500): Promise<NightCaptureResult> {
  if (!native?.captureNight) throw new Error('Night capture needs a development build with the latest lens-info module.');
  return native.captureNight(cameraId, zoomRatio, warmupMs);
}
