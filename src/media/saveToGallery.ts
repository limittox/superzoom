import * as MediaLibrary from 'expo-media-library';

export type SaveOutcome = 'saved' | 'denied' | 'failed';

/**
 * Saves files to the photo library at full resolution, asking for add-only permission
 * the first time (specs/enhanced-photo-review: Save to gallery).
 */
export async function saveToGallery(uris: string[]): Promise<SaveOutcome> {
  let permission = await MediaLibrary.getPermissionsAsync(true, ['photo']);
  if (!permission.granted && permission.canAskAgain) {
    permission = await MediaLibrary.requestPermissionsAsync(true, ['photo']);
  }
  if (!permission.granted) return 'denied';
  try {
    for (const uri of uris) await MediaLibrary.Asset.create(uri);
    return 'saved';
  } catch {
    return 'failed';
  }
}
