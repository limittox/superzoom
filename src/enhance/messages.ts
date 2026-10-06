import { ERROR_CODES, type EnhanceMode } from '@/shared/enhance';
import type { EnhanceFailure } from '@/state/session';

export type FailureCode = EnhanceFailure['code'];

export const MODE_LABELS: Record<EnhanceMode, { title: string; description: string }> = {
  enhance: { title: 'Enhance', description: 'Balanced and faithful to your photo.' },
  pro: { title: 'Pro', description: 'Highest fidelity. Slower.' },
  creative: { title: 'Creative', description: 'Sharpest look. May invent detail.' },
};

const MESSAGES: Record<FailureCode, string> = {
  network: "Couldn't reach the enhancement server. Check your connection and try again.",
  cancelled: 'Enhancement cancelled.',
  timeout: 'The enhancement took too long. Try again, or pick a faster mode.',
  provider_error: 'The enhancement service had a problem. Please try again.',
  rate_limited: "You've reached today's enhancement limit.",
  invalid_mode: 'That enhancement mode is not available. Update the app and try again.',
  unsupported_format: "This photo's format isn't supported.",
  file_too_large: 'This photo is too large to enhance.',
  image_too_small: 'This crop is too small to enhance. Zoom out a little and try again.',
  image_too_large: 'This crop is too large to enhance.',
  missing_install_id: 'Something went wrong identifying this device. Restart the app and try again.',
  bad_request: 'Something went wrong sending the photo. Please try again.',
};

/** Error codes that a retry might fix. */
export const RETRYABLE: ReadonlySet<FailureCode> = new Set(['network', 'timeout', 'provider_error', 'cancelled']);

export function failureMessage(failure: Pick<EnhanceFailure, 'code' | 'retryAt'>, locale?: string): string {
  const base = MESSAGES[failure.code];
  if (failure.code === 'rate_limited' && failure.retryAt) {
    const when = new Date(failure.retryAt);
    if (!Number.isNaN(when.getTime())) {
      const sameDay = when.toDateString() === new Date().toDateString();
      const time = when.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
      return `${base} You can enhance again ${sameDay ? 'at' : 'tomorrow at'} ${time}.`;
    }
  }
  return base;
}

/** Every server error code plus the client-only ones; used by tests to ensure coverage. */
export const ALL_FAILURE_CODES: FailureCode[] = [...ERROR_CODES, 'network', 'cancelled'];
