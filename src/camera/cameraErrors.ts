/**
 * Errors the camera reports that need no handling.
 *
 * VisionCamera calls `setZoom()` as soon as its controller exists, and again for zoom
 * changes while the camera is paused (result screen, app in background). On Android,
 * CameraX cancels those calls with `OperationCanceledException: Camera is not active.`
 * The current zoom is resent whenever the session starts (`resendZoom`, from `onStarted`,
 * retrying while the camera still reports inactive), so the cancellation is harmless.
 *
 * While pinching, each zoom update also cancels the previous one still in flight
 * (`Cancelled due to another zoom value being set.`); the latest value is applied.
 */
const INACTIVE_CANCELLATION = /CameraControl\$OperationCanceledException: Camera is not active/;
/** Native stack frames for a zoom call; the Android error message includes the stack. */
const ZOOM_FRAME = /ZoomControl|setZoomRatio|HybridCameraController\$setZoom/;
/** Superseded zoom update; the message itself identifies it as a zoom call. */
const SUPERSEDED_ZOOM = /CameraControl\$OperationCanceledException: Cancelled due to another zoom value being set/;

/** CameraX rejected a call because the camera isn't active (yet, or any more). */
export function isInactiveCancellation(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  return INACTIVE_CANCELLATION.test(message);
}

/** Only CameraX's cancellations of zoom calls (inactive camera, superseded value); every other error is reported. */
export function isBenignCameraError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  if (SUPERSEDED_ZOOM.test(message)) return true;
  return INACTIVE_CANCELLATION.test(message) && ZOOM_FRAME.test(message);
}

/** `onError` for the camera: drops benign cancellations, reports everything else. */
export function handleCameraError(error: Error): void {
  if (isBenignCameraError(error)) return;
  console.error(error);
}
