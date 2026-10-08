import { File, Paths } from 'expo-file-system';
import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';
import { type CameraPhotoOutput, CommonResolutions, useFrameOutput } from 'react-native-vision-camera';
import { scheduleOnRN } from 'react-native-worklets';

import { centerRegion, copyRegion } from './burstFrames';
import { computeCrop } from './crop';
import { pad, stamp, uploadLabCapture, within } from './labUpload';
import { type LensInfo, splitZoom } from './lenses';

/**
 * Development-only burst capture for the measurement spike (docs/capture-spike.md). One burst
 * takes VIDEO_FRAMES consecutive 4K video frames, then PHOTO_FRAMES full photos, at the current
 * zoom, and sends every zoomed crop to the dev server (`POST /api/dev/burst`), which saves them
 * for merging on the PC. Nothing here runs in release builds.
 */
export const VIDEO_FRAMES = 16;
export const PHOTO_FRAMES = 8;
const VIDEO_TIMEOUT_MS = 4000;
/** One photo, from capture to saved crop; a stuck capture fails the burst instead of hanging it. */
const PHOTO_TIMEOUT_MS = 10_000;

const log = (message: string) => console.log(`[burst] ${message}`);

interface VideoFrame {
  bytes: ArrayBuffer;
  width: number;
  height: number;
  timestamp: number;
  pixelFormat: string;
  orientation: string;
}

interface BurstLabDeps {
  photoOutput: CameraPhotoOutput;
  lensInfo: LensInfo | null;
  displayZoom: SharedValue<number>;
  previewLongOverShort: number;
}

export function useBurstLab({ photoOutput, lensInfo, displayZoom, previewLongOverShort }: BurstLabDeps) {
  // While > 0, the frame processor copies the zoomed centre (this digital factor) of every frame.
  const [videoFactor, setVideoFactor] = useState(0);
  const videoFrames = useRef<VideoFrame[]>([]);
  const videoDone = useRef<(() => void) | null>(null);

  const onVideoFrame = useCallback(
    (
      bytes: ArrayBuffer,
      width: number,
      height: number,
      timestamp: number,
      pixelFormat: string,
      orientation: string,
    ) => {
      if (videoFrames.current.length >= VIDEO_FRAMES) return;
      videoFrames.current.push({ bytes, width, height, timestamp, pixelFormat, orientation });
      if (videoFrames.current.length === VIDEO_FRAMES) videoDone.current?.();
    },
    [],
  );

  const frameOutput = useFrameOutput({
    targetResolution: CommonResolutions.UHD_4_3,
    pixelFormat: 'rgb',
    onFrame(frame) {
      'worklet';
      if (videoFactor > 0) {
        // Read the pixels through the frame's plane: Frame.getPixelBuffer() wraps a HardwareBuffer on
        // Android, which needs minSdk 26 (ours is lower). An RGB frame has one plane.
        const plane = frame.getPlanes()[0];
        const region = centerRegion(frame.width, frame.height, videoFactor);
        const crop = copyRegion(new Uint8Array(plane.getPixelBuffer()), plane.bytesPerRow, region);
        scheduleOnRN(
          onVideoFrame,
          crop.buffer as ArrayBuffer,
          region.width,
          region.height,
          frame.timestamp,
          frame.pixelFormat,
          frame.orientation,
        );
      }
      frame.dispose();
    },
  });

  const [running, setRunning] = useState(false);

  /** Takes one burst and sends it to the dev server; returns a short summary. */
  const runBurst = useCallback(async (): Promise<string> => {
    if (!lensInfo) throw new Error('The camera is not ready.');
    setRunning(true);
    try {
      const zoom = displayZoom.get();
      const { digitalFactor, deviceZoom } = splitZoom(zoom, lensInfo);
      const id = `${stamp()}-${Math.round(zoom)}x`;

      // 1. Video frames: arm the frame processor until it has delivered VIDEO_FRAMES.
      videoFrames.current = [];
      const videoStarted = Date.now();
      await new Promise<void>((resolve) => {
        videoDone.current = resolve;
        setTimeout(resolve, VIDEO_TIMEOUT_MS);
        setVideoFactor(Math.max(1.0001, digitalFactor));
      });
      setVideoFactor(0);
      const video = videoFrames.current.slice(0, VIDEO_FRAMES);
      const videoMs = Date.now() - videoStarted;
      log(`${id}: ${video.length} video frames in ${videoMs} ms (${video[0]?.width ?? 0}x${video[0]?.height ?? 0})`);

      // 2. Photos, as fast as the camera takes them, cropped exactly like a normal capture.
      const photos: { uri: string; width: number; height: number; ms: number }[] = [];
      const photoStarted = Date.now();
      const photoErrors: string[] = [];
      for (let i = 0; i < PHOTO_FRAMES; i++) {
        try {
          const { width, height, path } = await within(
            (async () => {
              // Dispose each native buffer as soon as it is used: the JS garbage collector doesn't see
              // their size, so a burst of full-resolution photos otherwise runs the camera out of memory.
              const photo = await photoOutput.capturePhoto({ enableShutterSound: false }, {});
              try {
                const upright = await photo.toImageAsync();
                try {
                  const rect = computeCrop(upright.width, upright.height, previewLongOverShort, digitalFactor);
                  const crop = await upright.cropAsync(rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
                  try {
                    const saved = await crop.saveToTemporaryFileAsync('jpg', 95);
                    return { width: crop.width, height: crop.height, path: saved };
                  } finally {
                    crop.dispose();
                  }
                } finally {
                  upright.dispose();
                }
              } finally {
                photo.dispose();
              }
            })(),
            PHOTO_TIMEOUT_MS,
            `Photo ${i + 1}`,
          );
          log(`${id}: photo ${i + 1}/${PHOTO_FRAMES} ${width}x${height} at ${Date.now() - photoStarted} ms`);
          photos.push({
            uri: path.startsWith('file://') ? path : `file://${path}`,
            width,
            height,
            ms: Date.now() - photoStarted,
          });
        } catch (err) {
          // Keep going: a burst with a missing photo is still worth merging.
          console.warn(`[burst] ${id}: photo ${i + 1}/${PHOTO_FRAMES} failed:`, err);
          photoErrors.push(`photo ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (photos.length === 0 && video.length === 0) {
        throw new Error(`Nothing was captured (${photoErrors.join('; ')}).`);
      }

      // 3. Send everything to the dev server.
      const meta = {
        id,
        platform: Platform.OS,
        zoom,
        digitalFactor,
        deviceZoom,
        previewLongOverShort,
        videoMs,
        video: video.map(({ bytes: _bytes, ...rest }, i) => ({ file: `video-${pad(i)}.rgba`, ...rest })),
        photos: photos.map(({ uri: _uri, ...rest }, i) => ({ file: `photo-${pad(i)}.jpg`, ...rest })),
        photoErrors,
      };
      const files: [string, File][] = [];
      video.forEach((frame, i) => {
        const file = new File(Paths.cache, `burst-${id}-video-${pad(i)}.rgba`);
        file.write(new Uint8Array(frame.bytes));
        files.push([`video-${pad(i)}.rgba`, file]);
      });
      photos.forEach((photo, i) => files.push([`photo-${pad(i)}.jpg`, new File(photo.uri)]));
      const megabytes = video.reduce((sum, f) => sum + f.bytes.byteLength, 0) / 1e6;
      log(`${id}: uploading ${files.length} files (${megabytes.toFixed(1)} MB of video)`);
      await uploadLabCapture(meta, files);
      log(`${id}: uploaded`);
      const failed = photoErrors.length > 0 ? ` (${photoErrors.length} failed: ${photoErrors[0]})` : '';
      return `${id}: ${video.length} video frames in ${videoMs} ms, ${photos.length} photos in ${photos.at(-1)?.ms ?? 0} ms${failed}`;
    } finally {
      setVideoFactor(0);
      setRunning(false);
    }
  }, [displayZoom, lensInfo, photoOutput, previewLongOverShort]);

  return { frameOutput, runBurst, running };
}
