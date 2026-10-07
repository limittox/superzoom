import * as MediaLibrary from 'expo-media-library';

export type SaveOutcome = 'saved' | 'partial' | 'denied' | 'failed';

export interface SaveResult {
  outcome: SaveOutcome;
  /** Files that were written, so callers can record them and not save them again. */
  saved: string[];
}

/**
 * Saves files to the photo library at full resolution, asking for add-only permission
 * the first time (specs/enhanced-photo-review: Save to gallery). Each file is attempted
 * independently, so one failure doesn't hide the others' success.
 */
export async function saveToGallery(uris: string[]): Promise<SaveResult> {
  let permission = await MediaLibrary.getPermissionsAsync(true, ['photo']);
  if (!permission.granted && permission.canAskAgain) {
    permission = await MediaLibrary.requestPermissionsAsync(true, ['photo']);
  }
  if (!permission.granted) return { outcome: 'denied', saved: [] };

  const saved: string[] = [];
  for (const uri of uris) {
    try {
      await MediaLibrary.Asset.create(uri);
      saved.push(uri);
    } catch {
      // Keep going; the result reports which files made it.
    }
  }
  const outcome: SaveOutcome = saved.length === uris.length ? 'saved' : saved.length > 0 ? 'partial' : 'failed';
  return { outcome, saved };
}
