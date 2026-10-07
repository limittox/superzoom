/**
 * Contract between the app and the `/api/enhance` route.
 * See openspec/changes/add-zoom-camera-mvp/specs/image-enhancement/spec.md.
 */

export const ENHANCE_MODES = ['enhance', 'pro', 'creative'] as const;
export type EnhanceMode = (typeof ENHANCE_MODES)[number];
export const DEFAULT_MODE: EnhanceMode = 'enhance';

export function isEnhanceMode(value: unknown): value is EnhanceMode {
  return typeof value === 'string' && (ENHANCE_MODES as readonly string[]).includes(value);
}

export const ENHANCE_PATH = '/api/enhance';
export const INSTALL_ID_HEADER = 'X-Install-Id';

/** Multipart form field names. */
export const FORM_FIELDS = { image: 'image', mode: 'mode' } as const;

export const LIMITS = {
  maxUploadBytes: 20 * 1024 * 1024,
  /** Smallest upload short side. SeedVR2 (Enhance) rejects images under 128 px per side. */
  minSidePx: 128,
  maxInputPixels: 4_000_000,
  maxOutputPixels: 16_000_000,
  minUpscale: 2,
  maxUpscale: 10,
  providerTimeoutMs: 120_000,
} as const;

export interface EnhanceSuccess {
  url: string;
  width: number;
  height: number;
  mode: EnhanceMode;
}

export const ERROR_CODES = [
  'invalid_mode',
  'unsupported_format',
  'file_too_large',
  'image_too_small',
  'image_too_large',
  'rate_limited',
  'provider_error',
  'timeout',
  'missing_install_id',
  'bad_request',
] as const;
export type EnhanceErrorCode = (typeof ERROR_CODES)[number];

export interface EnhanceError {
  error: {
    code: EnhanceErrorCode;
    message: string;
    /** ISO timestamp; present for `rate_limited`. */
    retryAt?: string;
  };
}

export type EnhanceResponse = EnhanceSuccess | EnhanceError;

export function isEnhanceError(body: EnhanceResponse): body is EnhanceError {
  return 'error' in body;
}
