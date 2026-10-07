import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { getLensGeometry } from '../../modules/lens-info';

import { computeLensFactors, type LensFactor } from './lensGeometry';

/** Results per camera ID; a camera's lenses don't change while the app runs. */
const cache = new Map<string, LensFactor[] | null>();
const pending = new Map<string, Promise<LensFactor[] | null>>();

/** Loads (once) and caches the lens factors for an Android camera. Never rejects. */
export function loadLensFactors(cameraId: string): Promise<LensFactor[] | null> {
  if (cache.has(cameraId)) return Promise.resolve(cache.get(cameraId) ?? null);
  let request = pending.get(cameraId);
  if (!request) {
    request = getLensGeometry(cameraId)
      .then(computeLensFactors)
      .catch(() => null)
      .then((factors) => {
        cache.set(cameraId, factors);
        pending.delete(cameraId);
        return factors;
      });
    pending.set(cameraId, request);
  }
  return request;
}

export function getCachedLensFactors(cameraId: string): LensFactor[] | null | undefined {
  return cache.get(cameraId);
}

/** Test hook. */
export function clearLensFactorCache() {
  cache.clear();
  pending.clear();
}

/**
 * Lens factors for the active Android camera, or null until they load, on iOS, or when
 * unavailable. The camera doesn't wait for them; presets update once they arrive.
 */
export function useLensFactors(device: { id: string } | undefined): LensFactor[] | null {
  const cameraId = Platform.OS === 'android' ? device?.id : undefined;
  const [, rerender] = useState(0);

  useEffect(() => {
    if (!cameraId || cache.has(cameraId)) return;
    let mounted = true;
    loadLensFactors(cameraId).then(() => {
      if (mounted) rerender((n) => n + 1);
    });
    return () => {
      mounted = false;
    };
  }, [cameraId]);

  return cameraId ? (cache.get(cameraId) ?? null) : null;
}
