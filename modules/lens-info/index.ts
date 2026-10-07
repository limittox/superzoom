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

declare class LensInfoModule extends NativeModule {
  getLensGeometry(cameraId: string): Promise<LensGeometry | null>;
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
