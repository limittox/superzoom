import type { File } from 'expo-file-system';

import { enhanceUrl } from '@/enhance/client';

/**
 * Shared helpers for the development-only capture experiments (the burst lab, docs/capture-spike.md,
 * and the Night A/B lab). Both save to the dev server's `POST /api/dev/burst`.
 */

const UPLOAD_TIMEOUT_MS = 60_000;

/** Rejects with a message naming the step if `promise` takes longer than `ms`. */
export function within<T>(promise: Promise<T>, ms: number, step: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${step} took longer than ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A sortable local timestamp for experiment ids, e.g. `20261008-084105`. */
export const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

export const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Sends one experiment (`meta` JSON plus named files) to the dev server, then deletes the files.
 * Names must match the saver's pattern, e.g. `photo-00.jpg` or `night-00.jpg`.
 */
export async function uploadLabCapture(meta: { id: string }, files: [name: string, file: File][]): Promise<void> {
  const form = new FormData();
  form.append('meta', JSON.stringify(meta));
  for (const [name, file] of files) form.append(name, file, name);
  try {
    const response = await within(
      fetch(enhanceUrl(undefined, '/api/dev/burst'), { method: 'POST', body: form }),
      UPLOAD_TIMEOUT_MS,
      'The upload',
    );
    if (!response.ok) throw new Error(`The dev server refused the upload (HTTP ${response.status}).`);
  } finally {
    for (const [, file] of files) {
      try {
        file.delete();
      } catch {
        // Best effort: the cache is cleared eventually.
      }
    }
  }
}
