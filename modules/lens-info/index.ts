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
}

declare class LensInfoModule extends NativeModule {
  getLensGeometry(cameraId: string): Promise<LensGeometry | null>;
  getExtensionInfo(cameraId: string): Promise<ExtensionInfo | null>;
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

/** Camera2 extension capabilities for a camera (Android 12+), or null where unavailable. */
export async function getExtensionInfo(cameraId: string): Promise<ExtensionInfo | null> {
  if (!native?.getExtensionInfo) return null;
  try {
    return await native.getExtensionInfo(cameraId);
  } catch {
    return null;
  }
}
