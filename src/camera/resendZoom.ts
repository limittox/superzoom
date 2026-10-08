import { isBenignCameraError, isInactiveCancellation } from './cameraErrors';

/** The part of VisionCamera's camera controller this needs. */
export interface ZoomController {
  setZoom(zoom: number): Promise<void>;
}

export interface ResendOptions {
  /** Further attempts after the first, while the camera reports it isn't active yet. */
  retries?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onError?: (error: unknown) => void;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Sends the current zoom to the camera after its session (re)starts. The camera resets its lens
 * zoom to 1x on every restart (back from the result screen or the background), and VisionCamera
 * only sends the zoom when the value changes, so without this a 100x preview would be the main
 * lens plus a 20x digital crop.
 *
 * The session can report started a moment before the camera accepts zoom calls, which CameraX
 * rejects with "Camera is not active"; those attempts are retried rather than dropped. The zoom is
 * read again on each attempt, so a pinch in between is not undone. A superseded call means a newer
 * zoom went through, so it ends the resend.
 */
export async function resendZoom(
  controller: ZoomController | undefined,
  getZoom: () => number,
  { retries = 4, delayMs = 250, sleep = wait, onError = console.error }: ResendOptions = {},
): Promise<void> {
  if (!controller) return;
  for (let attempt = 0; ; attempt++) {
    try {
      await controller.setZoom(getZoom());
      return;
    } catch (error) {
      if (isInactiveCancellation(error) && attempt < retries) {
        await sleep(delayMs);
        continue;
      }
      // Gave up on an inactive camera, or another failure: report it (a superseded call is benign).
      if (isInactiveCancellation(error) || !isBenignCameraError(error)) onError(error);
      return;
    }
  }
}
