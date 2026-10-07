/**
 * Contract between the app and the `/api/enhance` routes: submitting a job, then reading
 * or cancelling it at `/api/enhance/{jobId}`. See openspec/specs/image-enhancement/spec.md.
 */

export const ENHANCE_MODES = ['enhance', 'pro', 'creative'] as const;
export type EnhanceMode = (typeof ENHANCE_MODES)[number];
export const DEFAULT_MODE: EnhanceMode = 'enhance';

export function isEnhanceMode(value: unknown): value is EnhanceMode {
  return typeof value === 'string' && (ENHANCE_MODES as readonly string[]).includes(value);
}

export const ENHANCE_PATH = '/api/enhance';
export const INSTALL_ID_HEADER = 'X-Install-Id';

/** Path of one enhancement job (GET for its status, DELETE to cancel it). */
export function jobPath(jobId: string): string {
  return `${ENHANCE_PATH}/${encodeURIComponent(jobId)}`;
}

/** Multipart form field names. `requestId` is a client-generated UUID that makes resubmitting safe. */
export const FORM_FIELDS = {
  image: 'image',
  mode: 'mode',
  requestId: 'requestId',
} as const;

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
  'job_not_found',
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

/** Response to a successful submission (HTTP 202). */
export interface EnhanceJobCreated {
  jobId: string;
}

export const JOB_STATES = ['queued', 'processing', 'done', 'failed', 'cancelled'] as const;
export type JobState = (typeof JOB_STATES)[number];

/** Response to reading or cancelling a job. */
export interface EnhanceJobStatus {
  jobId: string;
  status: JobState;
  mode: EnhanceMode;
  /** While processing: which provider pass is running (1-based), out of `passes`. */
  pass?: number;
  passes?: number;
  /** Present when `status` is `done`. */
  result?: EnhanceSuccess;
  /** Present when `status` is `failed`. */
  error?: EnhanceError['error'];
}

/** An error response; a failed job's status also carries `error`, but has a `jobId`. */
export function isEnhanceError(body: unknown): body is EnhanceError {
  return (
    typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'object' && !('jobId' in body)
  );
}
