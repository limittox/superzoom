import type { EnhanceMode } from '@/shared/enhance';

export interface UploadInfo {
  mode: EnhanceMode;
  width: number;
  height: number;
  contentType: string;
}

/** Keeps a copy of an accepted upload. Development only: the service otherwise stores no images. */
export type SaveUpload = (bytes: Uint8Array, info: UploadInfo) => Promise<void>;

/** `20261008-143005-123-pro-128x275.jpg`: sortable by time, with what the evaluation needs. */
export function uploadFileName(info: UploadInfo, at: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-` +
    `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}-${pad(at.getMilliseconds(), 3)}`;
  const ext = info.contentType === 'image/png' ? 'png' : 'jpg';
  return `${stamp}-${info.mode}-${info.width}x${info.height}.${ext}`;
}

/** The file-system calls the saver needs. */
export interface UploadFs {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
}

/** Node's file system, loaded only when an upload is saved, so production bundles never need it. */
const nodeFs = (): Promise<UploadFs> => import('node:fs/promises');

/**
 * Writes each accepted upload to `dir`, to build test sets for evaluating models
 * (`SAVE_UPLOADS_DIR`, development only; see docs/backend.md).
 */
export function createUploadSaver(
  dir: string,
  now: () => Date = () => new Date(),
  loadFs: () => Promise<UploadFs> = nodeFs,
): SaveUpload {
  return async (bytes, info) => {
    const fs = await loadFs();
    await fs.mkdir(dir, { recursive: true });
    // Forward slashes work on Windows too.
    const path = `${dir.replace(/[\\/]+$/, '')}/${uploadFileName(info, now())}`;
    await fs.writeFile(path, bytes);
    console.info(`[uploads] saved ${path}`);
  };
}
