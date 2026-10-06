import { useCallback, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useDerivedValue, useSharedValue } from 'react-native-reanimated';
import { CommonResolutions, useCameraDevice, usePhotoOutput } from 'react-native-vision-camera';

import { computeMaxZoom } from './crop';
import { analyzeLenses, type LensInfo, splitZoom } from './lenses';
import { type ProcessedCapture, processCapture } from './processCapture';

/** Assumed photo size until the first capture reports the real one (telephoto sensors are often 12 MP). */
const DEFAULT_PHOTO = { width: 3024, height: 4032 };
/** Real photo sizes learned from captures, keyed by device and optical cap. */
const learnedPhotoSize = new Map<string, { width: number; height: number }>();

export interface Capture extends ProcessedCapture {
  displayZoom: number;
}

/**
 * Owns the camera device, lens analysis, zoom state and capture pipeline, so the
 * camera library stays behind one hook (design.md decisions 2–5).
 */
export function useZoomCamera(previewLongOverShort: number) {
  const device = useCameraDevice('back', { physicalDevices: ['ultra-wide-angle', 'wide-angle', 'telephoto'] });
  const photoOutput = usePhotoOutput({
    targetResolution: CommonResolutions.HIGHEST_4_3,
    containerFormat: 'jpeg',
    qualityPrioritization: 'quality',
  });

  const lensInfo: LensInfo | null = useMemo(
    () => (device ? analyzeLenses(device, Platform.OS === 'ios' ? 'ios' : 'android') : null),
    [device],
  );
  const sizeKey = device && lensInfo ? `${device.id}@${lensInfo.opticalCapDevice}` : '';
  const [, rerender] = useState(0);
  const photoSize = learnedPhotoSize.get(sizeKey) ?? DEFAULT_PHOTO;

  const maxDisplayZoom = lensInfo
    ? computeMaxZoom(lensInfo.opticalCapDisplay, photoSize.width, photoSize.height, previewLongOverShort)
    : 1;
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
      const upright = await photo.toImageAsync();

      // Max zoom depends on the photo size at the optical cap, so only learn from captures taken there.
      if (sizeKey && zoom >= lensInfo.opticalCapDisplay) {
        learnedPhotoSize.set(sizeKey, {
          width: Math.min(upright.width, upright.height),
          height: Math.max(upright.width, upright.height),
        });
        rerender((n) => n + 1);
      }

      const processed = await processCapture(upright, previewLongOverShort, digitalFactor);
      return { ...processed, displayZoom: zoom };
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
    capture,
  };
}
