import {
  DEFAULT_MODE,
  type EnhanceErrorCode,
  type EnhanceMode,
  type EnhanceSuccess,
  FORM_FIELDS,
  INSTALL_ID_HEADER,
  isEnhanceMode,
  LIMITS,
} from '@/shared/enhance';

import { ApiError, errorResponse, providerError } from './errors';
import type { RateLimiter } from './rateLimit';
import type { Upscaler } from './upscaler/types';
import { validateImage } from './validate';

/** Structured log line. Never contains image data or credentials. */
export type LogEvent = {
  event: 'enhance';
  outcome: 'ok' | EnhanceErrorCode;
  mode?: EnhanceMode;
  ms: number;
};

export interface EnhanceHandlerDeps {
  getUpscaler: () => Upscaler;
  getRateLimiter: () => RateLimiter;
  timeoutMs?: number;
  log?: (event: LogEvent) => void;
}

const INSTALL_ID_PATTERN = /^[A-Za-z0-9-]{8,128}$/;
/** Multipart framing overhead allowed on top of the image size. */
const MULTIPART_SLACK_BYTES = 64 * 1024;

const STATUS_BY_CODE: Partial<Record<EnhanceErrorCode, number>> = {
  file_too_large: 413,
  unsupported_format: 415,
  image_too_small: 422,
  image_too_large: 422,
};

/**
 * The part of the web FormData API the route uses. The project's global `FormData`
 * type comes from React Native and lacks `get`, although the server runtime has it.
 */
interface MultipartForm {
  get(name: string): Blob | string | null;
}

const fileTooLarge = () => new ApiError('file_too_large', 'Images must be 20 MB or smaller.', 413);

/**
 * Reads the request body, giving up as soon as it exceeds `maxBytes`, so a request
 * with a missing or false Content-Length can't make the route buffer an unbounded body.
 */
export async function readBodyWithLimit(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw fileTooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

const badRequest = (message: string) => new ApiError('bad_request', message, 400);

async function readImage(form: MultipartForm): Promise<Uint8Array> {
  const image = form.get(FORM_FIELDS.image);
  if (image == null || typeof image === 'string') {
    throw badRequest(`Missing "${FORM_FIELDS.image}" file field.`);
  }
  return new Uint8Array(await image.arrayBuffer());
}

function readMode(form: MultipartForm): EnhanceMode {
  const raw = form.get(FORM_FIELDS.mode);
  if (raw == null || raw === '') return DEFAULT_MODE;
  if (!isEnhanceMode(raw)) {
    throw new ApiError('invalid_mode', 'Mode must be one of enhance, pro or creative.', 400);
  }
  return raw;
}

export function createEnhanceHandler({
  getUpscaler,
  getRateLimiter,
  timeoutMs = LIMITS.providerTimeoutMs,
  log = (event) => console.info(JSON.stringify(event)),
}: EnhanceHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const started = Date.now();
    let mode: EnhanceMode | undefined;

    try {
      const installId = request.headers.get(INSTALL_ID_HEADER);
      if (!installId || !INSTALL_ID_PATTERN.test(installId)) {
        throw new ApiError('missing_install_id', `A valid ${INSTALL_ID_HEADER} header is required.`, 400);
      }

      const maxBodyBytes = LIMITS.maxUploadBytes + MULTIPART_SLACK_BYTES;
      // Cheap early rejection when the client declares its size; the bounded read below covers the rest.
      if (Number(request.headers.get('content-length')) > maxBodyBytes) throw fileTooLarge();
      const rawBody = await readBodyWithLimit(request, maxBodyBytes);

      let form: MultipartForm;
      try {
        const contentType = request.headers.get('content-type') ?? '';
        form = (await new Response(rawBody as BodyInit, {
          headers: { 'content-type': contentType },
        }).formData()) as unknown as MultipartForm;
      } catch {
        throw badRequest('Expected a multipart/form-data body.');
      }

      mode = readMode(form);
      const bytes = await readImage(form);
      const image = validateImage(bytes);
      if (!image.ok) {
        throw new ApiError(image.code, image.message, STATUS_BY_CODE[image.code] ?? 400);
      }

      let limit;
      try {
        limit = await getRateLimiter().check(installId);
      } catch {
        // Fail closed: without the limiter there is no cost guard.
        throw new ApiError('provider_error', 'The service is temporarily unavailable. Please try again.', 503);
      }
      if (!limit.allowed) {
        throw new ApiError('rate_limited', "You've reached today's enhancement limit.", 429, limit.retryAt);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let result;
      try {
        result = await getUpscaler().upscale({
          image: new Blob([bytes as BlobPart], { type: image.contentType }),
          width: image.width,
          height: image.height,
          mode,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      log({ event: 'enhance', outcome: 'ok', mode, ms: Date.now() - started });
      const body: EnhanceSuccess = { ...result, mode };
      return Response.json(body);
    } catch (err) {
      const apiError = err instanceof ApiError ? err : providerError();
      log({ event: 'enhance', outcome: apiError.code, mode, ms: Date.now() - started });
      return errorResponse(apiError);
    }
  };
}
