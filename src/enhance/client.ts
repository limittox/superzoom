import { File, Paths } from 'expo-file-system';

import {
  ENHANCE_PATH,
  type EnhanceMode,
  type EnhanceResponse,
  type EnhanceSuccess,
  FORM_FIELDS,
  INSTALL_ID_HEADER,
  isEnhanceError,
} from '@/shared/enhance';
import type { EnhanceFailure, LocalImage } from '@/state/session';
import { getInstallId } from '@/state/settings';

import { failureMessage } from './messages';

export class EnhanceRequestError extends Error {
  constructor(readonly failure: EnhanceFailure) {
    super(failure.message);
    this.name = 'EnhanceRequestError';
  }
}

const fail = (code: EnhanceFailure['code'], retryAt?: string) =>
  new EnhanceRequestError({ code, message: failureMessage({ code, retryAt }), ...(retryAt ? { retryAt } : {}) });

/** In development, relative URLs go to the dev server; release builds set EXPO_PUBLIC_API_URL. */
export function enhanceUrl(base = process.env.EXPO_PUBLIC_API_URL): string {
  return base ? `${base.replace(/\/+$/, '')}${ENHANCE_PATH}` : ENHANCE_PATH;
}

export async function requestEnhancement(
  upload: LocalImage,
  mode: EnhanceMode,
  signal: AbortSignal,
): Promise<EnhanceSuccess> {
  const installId = await getInstallId();
  const form = new FormData();
  // Expo's fetch (the global fetch in SDK 57) rejects React Native's { uri, name, type }
  // descriptors; it takes Blob-like parts, which expo-file-system's File implements.
  form.append(FORM_FIELDS.image, new File(upload.uri), 'crop.jpg');
  form.append(FORM_FIELDS.mode, mode);

  let response: Response;
  try {
    response = await fetch(enhanceUrl(), {
      method: 'POST',
      body: form,
      headers: { [INSTALL_ID_HEADER]: installId },
      signal,
    });
  } catch (err) {
    if (__DEV__ && !signal.aborted) console.warn(`[enhance] request to ${enhanceUrl()} failed:`, err);
    throw fail(signal.aborted ? 'cancelled' : 'network');
  }

  let body: EnhanceResponse;
  try {
    body = (await response.json()) as EnhanceResponse;
  } catch {
    throw fail(signal.aborted ? 'cancelled' : response.ok ? 'provider_error' : 'network');
  }
  if (isEnhanceError(body)) throw fail(body.error.code, body.error.retryAt);
  if (!response.ok || !body.url) throw fail('provider_error');
  return body;
}

/** Deletes a cached file, ignoring files that are already gone. */
export function deleteLocalFile(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Best effort: the OS clears the cache directory eventually.
  }
}

/**
 * Downloads the enhanced image so it can be compared offline and saved at full resolution.
 * The cached file is removed if the user cancelled or the download failed.
 */
export async function downloadResult(result: EnhanceSuccess, signal: AbortSignal): Promise<LocalImage> {
  const destination = new File(Paths.cache, `enhanced-${result.mode}-${Date.now()}.jpg`);
  try {
    const file = await File.downloadFileAsync(result.url, destination);
    if (signal.aborted) throw fail('cancelled');
    return { uri: file.uri, width: result.width, height: result.height };
  } catch (err) {
    deleteLocalFile(destination.uri);
    if (__DEV__ && !signal.aborted && !(err instanceof EnhanceRequestError)) {
      console.warn('[enhance] downloading the result failed:', err);
    }
    if (err instanceof EnhanceRequestError) throw err;
    throw fail(signal.aborted ? 'cancelled' : 'network');
  }
}

/** Full enhancement flow for the session store: request, download, and stale-response guarding. */
export async function runEnhancement(
  upload: LocalImage,
  mode: EnhanceMode,
  signal: AbortSignal,
): Promise<LocalImage> {
  const result = await requestEnhancement(upload, mode, signal);
  return downloadResult(result, signal);
}
