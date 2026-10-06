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
  // React Native's FormData takes a { uri, name, type } descriptor for files.
  form.append(FORM_FIELDS.image, { uri: upload.uri, name: 'crop.jpg', type: 'image/jpeg' } as unknown as Blob);
  form.append(FORM_FIELDS.mode, mode);

  let response: Response;
  try {
    response = await fetch(enhanceUrl(), {
      method: 'POST',
      body: form,
      headers: { [INSTALL_ID_HEADER]: installId },
      signal,
    });
  } catch {
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

/** Downloads the enhanced image so it can be compared offline and saved at full resolution. */
export async function downloadResult(result: EnhanceSuccess, signal: AbortSignal): Promise<LocalImage> {
  const destination = new File(Paths.cache, `enhanced-${result.mode}-${Date.now()}.jpg`);
  try {
    const file = await File.downloadFileAsync(result.url, destination);
    if (signal.aborted) throw fail('cancelled');
    return { uri: file.uri, width: result.width, height: result.height };
  } catch (err) {
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
