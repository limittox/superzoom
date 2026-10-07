import { handleCameraError, isBenignCameraError } from '../cameraErrors';

describe('camera errors', () => {
  const inactive = new Error(
    'androidx.camera.core.CameraControl$OperationCanceledException: Camera is not active.\n\tat androidx.camera...',
  );

  it('treats the CameraX "Camera is not active" cancellation as benign', () => {
    expect(isBenignCameraError(inactive)).toBe(true);
  });

  it('reports other camera errors', () => {
    expect(isBenignCameraError(new Error('`zoom` is out of range!'))).toBe(false);
    expect(isBenignCameraError(new Error('Camera device was disconnected'))).toBe(false);
  });

  it('logs only non-benign errors', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    handleCameraError(inactive);
    expect(spy).not.toHaveBeenCalled();
    const real = new Error('Camera device was disconnected');
    handleCameraError(real);
    expect(spy).toHaveBeenCalledWith(real);
    spy.mockRestore();
  });
});
