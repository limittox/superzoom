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
        if (__DEV__) {
          const summary = factors?.map((f) => `${f.id}: ${f.rawFactor.toFixed(2)}x → ${f.factor}x (${f.focalLength} mm)`);
          console.log(`[lens-factors] camera ${cameraId}: ${summary ? summary.join(', ') : 'unavailable (1x cap)'}`);
        }
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
 *
 * The result is held in React state: with the React Compiler on, a value read straight
 * from the module-level cache during render is memoized and never refreshes.
 */
export function useLensFactors(device: { id: string } | undefined): LensFactor[] | null {
  const cameraId = Platform.OS === 'android' ? device?.id : undefined;
  const [loaded, setLoaded] = useState<{ cameraId: string; factors: LensFactor[] | null } | null>(null);

  useEffect(() => {
    if (!cameraId) return;
    let mounted = true;
    // Resolves immediately from the cache after the first load.
    loadLensFactors(cameraId).then((factors) => {
      if (mounted) setLoaded({ cameraId, factors });
    });
    return () => {
      mounted = false;
    };
  }, [cameraId]);

  return cameraId && loaded?.cameraId === cameraId ? loaded.factors : null;
}
