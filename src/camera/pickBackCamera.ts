/** The subset of a VisionCamera `CameraDevice` used to choose the rear camera. */
export interface CameraCandidate {
  id: string;
  position: string;
  type: string;
  isVirtualDevice: boolean;
  physicalDevices: readonly { type: string }[];
}

const DEPTH_TYPES = ['lidar-depth', 'true-depth', 'time-of-flight-depth'];
const isDepth = (type: string) => DEPTH_TYPES.includes(type);

/**
 * Picks the rear camera that spans the most lenses (design.md decision 3).
 *
 * VisionCamera's own picker scores devices by the *types* of their physical lenses, but on
 * Android it reports a logical camera's lenses as `unknown` (Samsung's "Back Quad Camera"),
 * so a lone ultra-wide camera outscored the camera that covers every lens. This prefers the
 * virtual (logical) device with the most physical lenses, ignoring depth-only devices.
 */
export function pickBackCamera<T extends CameraCandidate>(devices: readonly T[]): T | undefined {
  const candidates = devices.filter(
    (d) => d.position === 'back' && !isDepth(d.type) && !d.physicalDevices.some((p) => isDepth(p.type)),
  );
  const score = (d: T) => (d.isVirtualDevice ? d.physicalDevices.length * 10 : 0) + (d.type === 'wide-angle' ? 1 : 0);
  return candidates.reduce<T | undefined>((best, d) => (!best || score(d) > score(best) ? d : best), undefined);
}
