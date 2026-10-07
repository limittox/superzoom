import { handleCameraError, isBenignCameraError } from '../cameraErrors';

/** Shaped like the error VisionCamera reports on Android: message followed by the native stack. */
const nativeError = (message: string, ...frames: string[]) =>
  new Error([message, ...frames.map((f) => `\tat ${f}`)].join('\n'));

describe('camera errors', () => {
  const inactiveZoom = nativeError(
    'androidx.camera.core.CameraControl$OperationCanceledException: Camera is not active.',
    'androidx.camera.camera2.impl.ZoomControl.applyZoomState(ZoomControl.kt:160)',
    'androidx.camera.camera2.impl.ZoomControl.setZoomRatio(ZoomControl.kt:122)',
    'com.margelo.nitro.camera.hybrids.HybridCameraController$setZoom$1.invokeSuspend(HybridCameraController.kt:135)',
  );

  it('treats the CameraX "Camera is not active" zoom cancellation as benign', () => {
    expect(isBenignCameraError(inactiveZoom)).toBe(true);
  });

  it('treats a zoom value superseded by a newer one as benign', () => {
    const superseded = new Error(
      'androidx.camera.core.CameraControl$OperationCanceledException: Cancelled due to another zoom value being set.\n',
    );
    expect(isBenignCameraError(superseded)).toBe(true);
  });

  it('reports other camera errors', () => {
    expect(isBenignCameraError(new Error('`zoom` is out of range!'))).toBe(false);
    expect(isBenignCameraError(new Error('Camera device was disconnected'))).toBe(false);
  });

  it('reports "not active" cancellations that did not come from a zoom call', () => {
    const focus = nativeError(
      'androidx.camera.core.CameraControl$OperationCanceledException: Camera is not active.',
      'androidx.camera.camera2.impl.FocusMeteringControl.startFocusAndMetering(FocusMeteringControl.kt:210)',
    );
    expect(isBenignCameraError(focus)).toBe(false);
  });

  it('reports other cancellations, even from zoom', () => {
    const closed = nativeError(
      'androidx.camera.core.CameraControl$OperationCanceledException: Camera is closed.',
      'androidx.camera.camera2.impl.ZoomControl.applyZoomState(ZoomControl.kt:160)',
    );
    expect(isBenignCameraError(closed)).toBe(false);
  });

  it('logs only non-benign errors', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    handleCameraError(inactiveZoom);
    expect(spy).not.toHaveBeenCalled();
    const real = new Error('Camera device was disconnected');
    handleCameraError(real);
    expect(spy).toHaveBeenCalledWith(real);
    spy.mockRestore();
  });
});
