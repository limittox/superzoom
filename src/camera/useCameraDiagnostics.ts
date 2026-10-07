import { useEffect } from 'react';
import { type CameraDevice, useCameraDeviceExtensions, useCameraDevices } from 'react-native-vision-camera';

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
  // Only the dev logs use the result, so release builds skip the native query.
  const extensions = useCameraDeviceExtensions(__DEV__ ? selected : undefined);
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

  // Vendor processing modes (Auto/HDR/Night use multi-frame processing). VisionCamera 5.2.3 can list
  // them but not enable them yet; logged to see what the phone offers.
  useEffect(() => {
    if (!__DEV__ || !selected || extensions === undefined) return;
    const summary = extensions.map((e) => `${e.type}${e.supportsFrameStreaming ? ' (frame streaming)' : ''}`);
    console.log(`[camera-extensions] camera ${selected.id}: ${summary.length ? summary.join(', ') : 'none'}`);
  }, [extensions, selected]);
}
