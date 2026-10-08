import { resendZoom, type ZoomController } from '../resendZoom';

const inactive = () =>
  new Error(
    'androidx.camera.core.CameraControl$OperationCanceledException: Camera is not active.\n' +
      '    at androidx.camera.camera2.internal.ZoomControl.setZoomRatio(ZoomControl.java:1)',
  );
const superseded = () =>
  new Error(
    'androidx.camera.core.CameraControl$OperationCanceledException: Cancelled due to another zoom value being set.',
  );

function setup(...outcomes: (Error | null)[]) {
  const calls: number[] = [];
  const controller: ZoomController = {
    setZoom: jest.fn(async (zoom: number) => {
      calls.push(zoom);
      const outcome = outcomes.shift();
      if (outcome) throw outcome;
    }),
  };
  const sleep = jest.fn(async () => {});
  const onError = jest.fn();
  return { controller, calls, sleep, onError };
}

describe('resendZoom', () => {
  it('sends the current zoom once when the camera accepts it', async () => {
    const { controller, calls, sleep, onError } = setup(null);
    await resendZoom(controller, () => 5, { sleep, onError });
    expect(calls).toEqual([5]);
    expect(sleep).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('does nothing before the camera has a controller', async () => {
    await expect(resendZoom(undefined, () => 5)).resolves.toBeUndefined();
  });

  it('retries while the camera is not active yet, reading the latest zoom each time', async () => {
    const { controller, calls, sleep, onError } = setup(inactive(), inactive(), null);
    let zoom = 5;
    const run = resendZoom(controller, () => zoom, { sleep, onError, delayMs: 250 });
    zoom = 3; // the user pinched in between
    await run;
    expect(calls).toEqual([5, 3, 3]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a camera that stays inactive after the retries, instead of hiding it', async () => {
    const { controller, calls, onError, sleep } = setup(inactive(), inactive(), inactive());
    await resendZoom(controller, () => 5, { retries: 2, sleep, onError });
    expect(calls).toHaveLength(3);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('stops quietly when a newer zoom superseded the resend', async () => {
    const { controller, calls, sleep, onError } = setup(superseded());
    await resendZoom(controller, () => 5, { sleep, onError });
    expect(calls).toEqual([5]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports other failures without retrying', async () => {
    const failure = new Error('Camera disconnected');
    const { controller, calls, sleep, onError } = setup(failure);
    await resendZoom(controller, () => 5, { sleep, onError });
    expect(calls).toEqual([5]);
    expect(sleep).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
