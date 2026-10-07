/** Which range a zoom is in (specs/zoom-capture: Zoom level indicator). */
export type ZoomTier = 'optical' | 'ai' | 'reconstructed';

/** Zooms within this much of a boundary count as on it, so a lens preset reads as optical. */
export const ZOOM_TIER_TOLERANCE = 0.05;

/**
 * optical: within the longest lens. ai: beyond it, up to the native-pixel limit.
 * reconstructed: beyond the native-pixel limit, where most detail is generated.
 */
export function zoomTier(zoom: number, opticalCap: number, nativeLimit: number): ZoomTier {
  if (zoom > nativeLimit + ZOOM_TIER_TOLERANCE) return 'reconstructed';
  if (zoom > opticalCap + ZOOM_TIER_TOLERANCE) return 'ai';
  return 'optical';
}

/** True when a capture at `zoom` is beyond the native-pixel limit (specs/zoom-capture: Native-pixel limit). */
export function isAiReconstructed(zoom: number, nativeLimit: number): boolean {
  return zoomTier(zoom, nativeLimit, nativeLimit) === 'reconstructed';
}
