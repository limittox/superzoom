/**
 * Errors the camera reports that need no handling.
 *
 * VisionCamera calls `setZoom()` as soon as its controller exists, and again for zoom
 * changes while the camera is paused (result screen, app in background). On Android,
 * CameraX cancels those calls with `OperationCanceledException: Camera is not active.`
 * The initial zoom is applied when the session is configured and later changes go
 * through once the camera is active, so the cancellation is harmless.
 */
const BENIGN_PATTERNS = [/OperationCanceledException/, /Camera is not active/];

export function isBenignCameraError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return BENIGN_PATTERNS.some((pattern) => pattern.test(message));
}

/** `onError` for the camera: drops benign cancellations, reports everything else. */
export function handleCameraError(error: Error): void {
  if (isBenignCameraError(error)) return;
  console.error(error);
}
