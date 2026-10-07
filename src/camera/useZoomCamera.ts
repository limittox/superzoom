import { useCallback, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useDerivedValue, useSharedValue } from 'react-native-reanimated';
import { CommonResolutions, useCameraDevices, usePhotoOutput } from 'react-native-vision-camera';

import { computeZoomLimits, estimatePhotoSize, isFramingClamped, type Size } from './crop';
import { readExifFocalLength } from './exifFocalLength';
import { isAiReconstructed } from './zoomTier';
import { describeLensCheck } from './lensCheck';
import { analyzeLenses, type LensInfo, splitZoom } from './lenses';
import { pickBackCamera } from './pickBackCamera';
import { useLensFactors } from './useLensFactors';
import { type ProcessedCapture, processCapture } from './processCapture';

/** Real photo sizes learned from captures at the optical cap, keyed by device and cap. */
const learnedPhotoSize = new Map<string, Size>();

export interface Capture extends ProcessedCapture {
  /** Zoom the photo actually corresponds to; restored when returning to the camera. */
  displayZoom: number;
  /** The photo was smaller than estimated, so the crop is wider than the preview showed. */
  framingClamped: boolean;
  /** Corrected maximum zoom after this capture. */
  maxDisplayZoom: number;
  /** Taken beyond the native-pixel limit: most detail will be generated (specs/zoom-capture: Native-pixel limit). */
  aiReconstructed: boolean;
  /** Development builds only: which lens took the photo, for display on the result screen. */
  devLensNote?: string;
}

/**
 * Owns the camera device, lens analysis, zoom state and capture pipeline, so the
 * camera library stays behind one hook (design.md decisions 2–5).
 */
export function useZoomCamera(previewLongOverShort: number) {
  const devices = useCameraDevices();
  const device = useMemo(() => pickBackCamera(devices), [devices]);
  const photoOutput = usePhotoOutput({
    targetResolution: CommonResolutions.HIGHEST_4_3,
    containerFormat: 'jpeg',
    qualityPrioritization: 'quality',
  });

  // Android only: real lens zoom factors from the lens-info module (null until loaded or unavailable).
  const lensFactors = useLensFactors(device);
  const lensInfo: LensInfo | null = useMemo(
    () => (device ? analyzeLenses(device, Platform.OS === 'ios' ? 'ios' : 'android', lensFactors) : null),
    [device, lensFactors],
  );
  const sizeKey = device && lensInfo ? `${device.id}@${lensInfo.opticalCapDevice}` : '';
  // Held in state, not read from the module-level map during render: the React Compiler
  // memoizes render-time reads it can't track, so the max zoom would never update.
  const [learnedSizes, setLearnedSizes] = useState<Record<string, Size>>(() => Object.fromEntries(learnedPhotoSize));
  const supportedPhotoSizes = useMemo(() => device?.getSupportedResolutions('photo') ?? [], [device]);
  const photoSize = estimatePhotoSize(supportedPhotoSizes, learnedSizes[sizeKey]);

  // nativeLimit: past it, captures are AI-reconstructed. maxDisplayZoom: up to 100x (64 px crop floor).
  const { nativeLimit, maxZoom: maxDisplayZoom } = lensInfo
    ? computeZoomLimits(lensInfo.opticalCapDisplay, photoSize.width, photoSize.height, previewLongOverShort)
    : { nativeLimit: 1, maxZoom: 1 };
  const minDisplayZoom = lensInfo?.minDisplayZoom ?? 1;

  /** Display zoom, 1x = main lens. Driven by gestures and presets on the UI thread. */
  const displayZoom = useSharedValue(1);
  const deviceZoom = useDerivedValue(() =>
    lensInfo ? splitZoom(displayZoom.get(), lensInfo).deviceZoom : 1,
  );
  const previewScale = useDerivedValue(() =>
    lensInfo ? splitZoom(displayZoom.get(), lensInfo).digitalFactor : 1,
  );

  const busy = useRef(false);
  const capture = useCallback(async (): Promise<Capture | null> => {
    if (busy.current || !lensInfo) return null;
    busy.current = true;
    try {
      const zoom = displayZoom.get();
      const { digitalFactor } = splitZoom(zoom, lensInfo);
      const photo = await photoOutput.capturePhoto({ enableShutterSound: true }, {});
      let devLensNote: string | undefined;
      if (__DEV__) {
        // Development only: log which lens actually took the photo (EXIF focal length). Read before
        // toImageAsync(): read in the background it never settled on Android, likely because the
        // photo's buffer was released first. Bounded so a stuck read can't block the capture.
        const { deviceZoom: hardwareZoom } = splitZoom(zoom, lensInfo);
        try {
          const data = await Promise.race([
            photo.getFileDataAsync(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out after 3 s')), 3000)),
          ]);
          const check = describeLensCheck(zoom, hardwareZoom, readExifFocalLength(new Uint8Array(data)), lensInfo);
          console[check.level](check.message);
          devLensNote = check.message.replace('[lens-check] ', '');
        } catch (err) {
          console.warn("[lens-check] could not read the photo's EXIF data:", err);
          devLensNote = `lens check failed: ${String(err)}`;
        }
      }
      const upright = await photo.toImageAsync();

      const actual = {
        width: Math.min(upright.width, upright.height),
        height: Math.max(upright.width, upright.height),
      };
      // Max zoom depends on the photo size at the optical cap, so only learn from captures taken there.
      if (sizeKey && zoom >= lensInfo.opticalCapDisplay) {
        learnedPhotoSize.set(sizeKey, actual);
        setLearnedSizes((prev) => ({ ...prev, [sizeKey]: actual }));
      }

      const processed = await processCapture(upright, previewLongOverShort, digitalFactor);
      const framingClamped = isFramingClamped(upright.width, upright.height, previewLongOverShort, digitalFactor);
      const limits = computeZoomLimits(lensInfo.opticalCapDisplay, actual.width, actual.height, previewLongOverShort);
      // When clamped, the photo matches the corrected max zoom, not the zoom the preview showed.
      const effectiveZoom = framingClamped ? limits.maxZoom : zoom;
      return {
        ...processed,
        displayZoom: effectiveZoom,
        framingClamped,
        maxDisplayZoom: limits.maxZoom,
        aiReconstructed: isAiReconstructed(effectiveZoom, limits.nativeLimit),
        devLensNote,
      };
    } finally {
      busy.current = false;
    }
  }, [displayZoom, lensInfo, photoOutput, previewLongOverShort, sizeKey]);

  return {
    device,
    lensInfo,
    photoOutput,
    displayZoom,
    deviceZoom,
    previewScale,
    minDisplayZoom,
    maxDisplayZoom,
    nativeLimit,
    capture,
  };
}
