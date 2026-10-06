import { useCallback, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useDerivedValue, useSharedValue } from 'react-native-reanimated';
import { CommonResolutions, useCameraDevice, usePhotoOutput } from 'react-native-vision-camera';

import { computeMaxZoom, estimatePhotoSize, isFramingClamped, type Size } from './crop';
import { analyzeLenses, type LensInfo, splitZoom } from './lenses';
import { type ProcessedCapture, processCapture } from './processCapture';

/** Real photo sizes learned from captures at the optical cap, keyed by device and cap. */
const learnedPhotoSize = new Map<string, Size>();

export interface Capture extends ProcessedCapture {
  displayZoom: number;
  /** The photo was smaller than estimated, so the crop is wider than the preview showed. */
  framingClamped: boolean;
  /** Corrected maximum zoom after this capture. */
  maxDisplayZoom: number;
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
  const supportedPhotoSizes = useMemo(() => device?.getSupportedResolutions('photo') ?? [], [device]);
  const photoSize = estimatePhotoSize(supportedPhotoSizes, learnedPhotoSize.get(sizeKey));

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

      const actual = {
        width: Math.min(upright.width, upright.height),
        height: Math.max(upright.width, upright.height),
      };
      // Max zoom depends on the photo size at the optical cap, so only learn from captures taken there.
      if (sizeKey && zoom >= lensInfo.opticalCapDisplay) {
        learnedPhotoSize.set(sizeKey, actual);
        rerender((n) => n + 1);
      }

      const processed = await processCapture(upright, previewLongOverShort, digitalFactor);
      return {
        ...processed,
        displayZoom: zoom,
        framingClamped: isFramingClamped(upright.width, upright.height, previewLongOverShort, digitalFactor),
        maxDisplayZoom: computeMaxZoom(lensInfo.opticalCapDisplay, actual.width, actual.height, previewLongOverShort),
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
    capture,
  };
}
