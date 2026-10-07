import { File, Paths } from 'expo-file-system';

import {
  ENHANCE_PATH,
  type EnhanceJobCreated,
  type EnhanceJobStatus,
  type EnhanceMode,
  type EnhanceSuccess,
  FORM_FIELDS,
  INSTALL_ID_HEADER,
  isEnhanceError,
  jobPath,
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

export const fail = (code: EnhanceFailure['code'], retryAt?: string) =>
  new EnhanceRequestError({ code, message: failureMessage({ code, retryAt }), ...(retryAt ? { retryAt } : {}) });

/** In development, relative URLs go to the dev server; release builds set EXPO_PUBLIC_API_URL. */
export function enhanceUrl(base = process.env.EXPO_PUBLIC_API_URL, path: string = ENHANCE_PATH): string {
  return base ? `${base.replace(/\/+$/, '')}${path}` : path;
}

/** Sends a request and reads its JSON, mapping transport failures and error bodies to `EnhanceRequestError`. */
async function callApi<T>(url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (err) {
    if (__DEV__ && !signal?.aborted) console.warn(`[enhance] request to ${url} failed:`, err);
    throw fail(signal?.aborted ? 'cancelled' : 'network');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw fail(signal?.aborted ? 'cancelled' : response.ok ? 'provider_error' : 'network');
  }
  if (isEnhanceError(body)) throw fail(body.error.code, body.error.retryAt);
  if (!response.ok) throw fail('provider_error');
  return body as T;
}

/**
 * Submits the upload copy and returns the job's ID (specs/image-enhancement: Enhancement request).
 * Resubmitting with the same `requestId` returns the same job, so a submit whose response was
 * lost can safely be sent again.
 */
export async function submitJob(
  upload: LocalImage,
  mode: EnhanceMode,
  requestId: string,
  signal: AbortSignal,
): Promise<string> {
  const installId = await getInstallId();
  const form = new FormData();
  // Expo's fetch (the global fetch in SDK 57) rejects React Native's { uri, name, type }
  // descriptors; it takes Blob-like parts, which expo-file-system's File implements.
  form.append(FORM_FIELDS.image, new File(upload.uri), 'crop.jpg');
  form.append(FORM_FIELDS.mode, mode);
  form.append(FORM_FIELDS.requestId, requestId);
  const body = await callApi<EnhanceJobCreated>(
    enhanceUrl(),
    { method: 'POST', body: form, headers: { [INSTALL_ID_HEADER]: installId } },
    signal,
  );
  if (!body.jobId) throw fail('provider_error');
  return body.jobId;
}

/** Reads a job's status; the service moves the job along as it answers. */
export async function getJob(jobId: string, signal: AbortSignal): Promise<EnhanceJobStatus> {
  const installId = await getInstallId();
  return callApi<EnhanceJobStatus>(
    enhanceUrl(undefined, jobPath(jobId)),
    { method: 'GET', headers: { [INSTALL_ID_HEADER]: installId } },
    signal,
  );
}

/** Asks the service to cancel a job. Best effort: the app has already stopped waiting, so this never throws. */
export async function cancelJob(jobId: string): Promise<void> {
  try {
    const installId = await getInstallId();
    await fetch(enhanceUrl(undefined, jobPath(jobId)), {
      method: 'DELETE',
      headers: { [INSTALL_ID_HEADER]: installId },
    });
  } catch (err) {
    if (__DEV__) console.warn('[enhance] cancelling the job failed:', err);
  }
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
