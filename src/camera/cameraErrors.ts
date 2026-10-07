/**
 * Errors the camera reports that need no handling.
 *
 * VisionCamera calls `setZoom()` as soon as its controller exists, and again for zoom
 * changes while the camera is paused (result screen, app in background). On Android,
 * CameraX cancels those calls with `OperationCanceledException: Camera is not active.`
 * The initial zoom is applied when the session is configured and later changes go
 * through once the camera is active, so the cancellation is harmless.
 */
const INACTIVE_CANCELLATION = /CameraControl\$OperationCanceledException: Camera is not active/;
/** Native stack frames for a zoom call; the Android error message includes the stack. */
const ZOOM_FRAME = /ZoomControl|setZoomRatio|HybridCameraController\$setZoom/;

/** Only CameraX's "not active" cancellation of a zoom call; every other error is reported. */
export function isBenignCameraError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  return INACTIVE_CANCELLATION.test(message) && ZOOM_FRAME.test(message);
}

/** `onError` for the camera: drops benign cancellations, reports everything else. */
export function handleCameraError(error: Error): void {
  if (isBenignCameraError(error)) return;
  console.error(error);
}
