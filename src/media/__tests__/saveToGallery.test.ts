import * as MediaLibrary from 'expo-media-library';

import { saveToGallery } from '../saveToGallery';

jest.mock('expo-media-library', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  Asset: { create: jest.fn() },
}));

const ml = MediaLibrary as jest.Mocked<typeof MediaLibrary>;
const perm = (granted: boolean, canAskAgain = true) => ({ granted, canAskAgain }) as never;

beforeEach(() => jest.resetAllMocks());

describe('saveToGallery', () => {
  it('saves every file when permission is already granted', async () => {
    ml.getPermissionsAsync.mockResolvedValue(perm(true));
    expect(await saveToGallery(['file:///a.jpg', 'file:///b.jpg'])).toBe('saved');
    expect(ml.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(ml.Asset.create).toHaveBeenCalledWith('file:///a.jpg');
    expect(ml.Asset.create).toHaveBeenCalledWith('file:///b.jpg');
  });

  it('asks for write-only photo permission the first time', async () => {
    ml.getPermissionsAsync.mockResolvedValue(perm(false, true));
    ml.requestPermissionsAsync.mockResolvedValue(perm(true));
    expect(await saveToGallery(['file:///a.jpg'])).toBe('saved');
    expect(ml.requestPermissionsAsync).toHaveBeenCalledWith(true, ['photo']);
  });

  it('saves nothing when permission is denied', async () => {
    ml.getPermissionsAsync.mockResolvedValue(perm(false, true));
    ml.requestPermissionsAsync.mockResolvedValue(perm(false, false));
    expect(await saveToGallery(['file:///a.jpg'])).toBe('denied');
    expect(ml.Asset.create).not.toHaveBeenCalled();
  });

  it('does not re-prompt once the user has permanently denied', async () => {
    ml.getPermissionsAsync.mockResolvedValue(perm(false, false));
    expect(await saveToGallery(['file:///a.jpg'])).toBe('denied');
    expect(ml.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('reports a failed write', async () => {
    ml.getPermissionsAsync.mockResolvedValue(perm(true));
    (ml.Asset.create as jest.Mock).mockRejectedValue(new Error('disk full'));
    expect(await saveToGallery(['file:///a.jpg'])).toBe('failed');
  });
});
