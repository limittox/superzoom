import { useEffect } from 'react';
import { type CameraDevice, useCameraDevices } from 'react-native-vision-camera';

function largestPhoto(device: CameraDevice): string {
  try {
    const sizes = device.getSupportedResolutions('photo');
    const best = sizes.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a), sizes[0]);
    return best ? `${best.width}x${best.height}` : 'none';
  } catch (err) {
    return `error: ${String(err)}`;
  }
}

/**
 * Development only: logs every camera VisionCamera can see, so lens setups on real
 * devices (e.g. how a phone exposes its telephoto lenses) can be inspected from the
 * dev server output.
 */
export function useCameraDiagnostics(selected: CameraDevice | undefined) {
  const devices = useCameraDevices();
  useEffect(() => {
    if (!__DEV__ || devices.length === 0) return;
    const summary = devices.map((d) => ({
      id: d.id,
      position: d.position,
      type: d.type,
      name: d.localizedName,
      isVirtual: d.isVirtualDevice,
      selected: d.id === selected?.id,
      minZoom: d.minZoom,
      maxZoom: d.maxZoom,
      switchFactors: d.zoomLensSwitchFactors,
      focalLength: d.focalLength,
      largestPhoto: largestPhoto(d),
      physical: d.physicalDevices.map((p) => ({ id: p.id, type: p.type, focalLength: p.focalLength })),
    }));
    console.log(`[camera-diagnostics] ${JSON.stringify(summary)}`);
  }, [devices, selected?.id]);
}
