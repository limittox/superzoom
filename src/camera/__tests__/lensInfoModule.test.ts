import { getLensGeometry } from '../../../modules/lens-info';

describe('lens-info module wrapper', () => {
  it('returns null where the native module is unavailable (iOS, web, Jest)', async () => {
    await expect(getLensGeometry('0')).resolves.toBeNull();
  });
});
