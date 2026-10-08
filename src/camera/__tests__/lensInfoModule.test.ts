import { captureNight, getExtensionInfo, getLensGeometry, getSensorModes } from '../../../modules/lens-info';

describe('lens-info module wrapper', () => {
  it('returns null where the native module is unavailable (iOS, web, Jest)', async () => {
    await expect(getLensGeometry('0')).resolves.toBeNull();
    await expect(getExtensionInfo('0')).resolves.toBeNull();
    await expect(getSensorModes()).resolves.toBeNull();
  });

  it('rejects a Night capture where the native module is unavailable', async () => {
    await expect(captureNight('0', 5)).rejects.toThrow(/development build/);
  });
});
