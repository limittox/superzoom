import type { EnhanceError, EnhanceErrorCode } from '@/shared/enhance';

/** An error that maps directly to a structured API error response. */
export class ApiError extends Error {
  constructor(
    readonly code: EnhanceErrorCode,
    message: string,
    readonly status: number,
    readonly retryAt?: Date,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const providerError = () => new ApiError('provider_error', 'The enhancement service failed. Please try again.', 502);
export const timeoutError = () => new ApiError('timeout', 'The enhancement took too long. Please try again.', 504);

export function errorResponse(err: ApiError): Response {
  const body: EnhanceError = {
    error: { code: err.code, message: err.message, ...(err.retryAt ? { retryAt: err.retryAt.toISOString() } : {}) },
  };
  const headers: Record<string, string> = {};
  if (err.retryAt) {
    headers['Retry-After'] = String(Math.max(0, Math.ceil((err.retryAt.getTime() - Date.now()) / 1000)));
  }
  return Response.json(body, { status: err.status, headers });
}
