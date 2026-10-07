import { formatZoom } from '@/ui/theme';

import type { LensInfo } from './lenses';

/** Focal lengths within this fraction count as the same lens. */
const FOCAL_TOLERANCE = 0.1;

export interface LensCheck {
  level: 'log' | 'warn';
  message: string;
}

const close = (a: number, b: number) => Math.abs(a - b) / b <= FOCAL_TOLERANCE;

/**
 * Development aid: says which lens took a photo, from its EXIF focal length, and warns when it
 * isn't the lens expected at that hardware zoom (e.g. the phone used a main-lens crop at 5x in
 * low light). See android-telephoto-lenses design decision 6.
 */
export function describeLensCheck(
  displayZoom: number,
  deviceZoom: number,
  focalLength: number | null,
  info: LensInfo,
): LensCheck {
  const zoom = formatZoom(displayZoom);
  if (focalLength === null) return { level: 'log', message: `[lens-check] ${zoom} → no EXIF focal length` };

  const known = info.lenses.filter((l) => l.focalLength !== undefined);
  const used = known.find((l) => close(focalLength, l.focalLength!));
  const usedLabel = used ? `${formatZoom(used.displayZoom)} lens` : 'unknown lens';
  const text = `[lens-check] ${zoom} → ${focalLength.toFixed(1)} mm (${usedLabel})`;

  // Expected: the longest lens whose native zoom is at or below the hardware zoom used.
  const expected = known.filter((l) => l.deviceZoom <= deviceZoom * 1.001).at(-1);
  if (!expected || !used || used === expected) return { level: 'log', message: text };
  return {
    level: 'warn',
    message: `${text}; expected the ${formatZoom(expected.displayZoom)} lens (${expected.focalLength!.toFixed(1)} mm). The phone may have used a crop of a wider lens, for example in low light or at close focus.`,
  };
}
