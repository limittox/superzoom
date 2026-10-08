import { File, Paths } from 'expo-file-system';
import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';
import type { CameraPhotoOutput } from 'react-native-vision-camera';

import { captureNight } from '../../modules/lens-info';

import { readExifFocalLength } from './exifFocalLength';
import { stamp, uploadLabCapture, within } from './labUpload';
import { type LensInfo, splitZoom } from './lenses';

/**
 * Development-only A/B test of Samsung's Night extension (docs/follow-ups.md, "Close the quality
 * gap"): one normal photo, then one Night photo at the same lens zoom, both uncropped, sent to the
 * dev server for `scripts/night-compare.py`. The Night photo needs the camera to itself, so the
 * hook pauses the app's camera session (`cameraPaused`) while it runs.
 */
const NORMAL_TIMEOUT_MS = 10_000;
/** How long to wait for the camera session to report it stopped before opening the camera anyway. */
const STOP_TIMEOUT_MS = 3000;
/** Preview time before the Night capture, for focus and exposure. */
const NIGHT_WARMUP_MS = 1500;

const log = (message: string) => console.log(`[night] ${message}`);

interface NightLabDeps {
  photoOutput: CameraPhotoOutput;
  lensInfo: LensInfo | null;
  cameraId: string | undefined;
  displayZoom: SharedValue<number>;
  previewLongOverShort: number;
}

export function useNightLab({ photoOutput, lensInfo, cameraId, displayZoom, previewLongOverShort }: NightLabDeps) {
  const [running, setRunning] = useState(false);
  const [cameraPaused, setCameraPaused] = useState(false);
  const stopped = useRef<(() => void) | null>(null);

  /** Pass to the camera's `onStopped`. */
  const onCameraStopped = useCallback(() => {
    stopped.current?.();
    stopped.current = null;
  }, []);

  /** Takes the normal and the Night photo and sends both to the dev server; returns a short summary. */
  const runNight = useCallback(async (): Promise<string> => {
    if (!lensInfo || !cameraId) throw new Error('The camera is not ready.');
    setRunning(true);
    try {
      const zoom = displayZoom.get();
      const { digitalFactor, deviceZoom } = splitZoom(zoom, lensInfo);
      const id = `night-${stamp()}-${Math.round(zoom)}x`;

      // 1. A normal photo, uncropped, with its EXIF (focal length shows which lens took it).
      const normalStarted = Date.now();
      const normalBytes = await within(
        (async () => {
          const photo = await photoOutput.capturePhoto({ enableShutterSound: false }, {});
          try {
            // Copy: the buffer points into the photo's native memory, which dispose() frees.
            return new Uint8Array(await photo.getFileDataAsync()).slice();
          } finally {
            photo.dispose();
          }
        })(),
        NORMAL_TIMEOUT_MS,
        'The normal photo',
      );
      const normalMs = Date.now() - normalStarted;
      log(`${id}: normal photo in ${normalMs} ms`);

      // 2. Release the camera, then 3. the Night photo through our own Camera2 session.
      const stopStarted = Date.now();
      await new Promise<void>((resolve) => {
        stopped.current = resolve;
        setTimeout(resolve, STOP_TIMEOUT_MS);
        setCameraPaused(true);
      });
      const stopMs = Date.now() - stopStarted;
      let night;
      try {
        night = await captureNight(cameraId, deviceZoom, NIGHT_WARMUP_MS);
      } finally {
        setCameraPaused(false);
      }
      const nightFile = new File(night.uri);
      const nightFocal = readExifFocalLength(await nightFile.bytes());
      const t = night.timingsMs;
      const processMs = (t.stillAvailable ?? 0) - (t.captureRequested ?? 0);
      log(`${id}: Night ${night.width}x${night.height} at zoom ${night.zoomRatio}, ${processMs} ms after the request; ${JSON.stringify(night)}`);

      // 4. Send both.
      const normalFile = new File(Paths.cache, `${id}-normal.jpg`);
      normalFile.write(normalBytes);
      const meta = {
        id,
        platform: Platform.OS,
        zoom,
        digitalFactor,
        deviceZoom,
        previewLongOverShort,
        stopMs,
        normal: { file: 'normal-00.jpg', ms: normalMs, bytes: normalBytes.byteLength, focalLength: readExifFocalLength(normalBytes) },
        night: { file: 'night-00.jpg', ...night, focalLength: nightFocal },
      };
      await uploadLabCapture(meta, [
        ['normal-00.jpg', normalFile],
        ['night-00.jpg', nightFile],
      ]);
      log(`${id}: uploaded`);
      return `${id}: Night photo in ${(processMs / 1000).toFixed(1)} s (lens ${nightFocal ?? '?'} mm), normal ${normalMs} ms (lens ${meta.normal.focalLength ?? '?'} mm)`;
    } finally {
      stopped.current = null;
      setCameraPaused(false);
      setRunning(false);
    }
  }, [cameraId, displayZoom, lensInfo, photoOutput, previewLongOverShort]);

  return { runNight, running, cameraPaused, onCameraStopped };
}
