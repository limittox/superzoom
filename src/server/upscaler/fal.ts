import { createFalClient, type FalClient } from '@fal-ai/client';

import { type EnhanceMode, LIMITS } from '@/shared/enhance';
import { chooseUpscaleFactor, type UpscalePlan } from '@/shared/upscale';

import { ApiError, providerError, timeoutError } from '../errors';
import type { UpscaleRequest, UpscaleResult, Upscaler } from './types';

/** Uploaded inputs and generated outputs expire on fal's CDN after this long. */
const OBJECT_EXPIRY = '1h' as const;

interface ModelSpec {
  endpoint: string;
  /** Largest `upscale_factor` the model accepts in one request. */
  maxFactorPerPass: number;
  /**
   * Inputs with a short side under `minSide` may only produce outputs that fit `maxOutput`
   * (in either orientation); the factor is lowered to fit.
   */
  smallInput?: { minSide: number; maxOutput: { long: number; short: number } };
  buildInput(imageUrl: string, factor: number): Record<string, unknown>;
}

/**
 * The upscale plan for one model: the shared plan, with the factor lowered where the model
 * limits small inputs. An input that can't fit even at the 2x minimum (a long, narrow image)
 * is rejected before the provider is called. extreme-zoom-100x design decision 7.
 */
export function planForModel(spec: ModelSpec, width: number, height: number): UpscalePlan {
  const plan = chooseUpscaleFactor(width, height);
  const limit = spec.smallInput;
  if (!limit || Math.min(width, height) >= limit.minSide) return plan;
  const { long, short } = limit.maxOutput;
  const fit = Math.min(long / Math.max(width, height), short / Math.min(width, height));
  if (fit < LIMITS.minUpscale) {
    throw new ApiError(
      'image_too_small',
      `In this mode, images under ${limit.minSide} px on the short side can be at most ${long / LIMITS.minUpscale} × ${short / LIMITS.minUpscale} px.`,
      422,
    );
  }
  const factor = Math.min(plan.factor, fit);
  return { factor, outputWidth: Math.floor(width * factor), outputHeight: Math.floor(height * factor) };
}

/**
 * Splits a total upscale factor into per-request factors for a model capped at
 * `maxPerPass`: full-strength passes first, then the remainder (always > 1).
 * extreme-zoom-100x design decision 4.
 */
export function planPasses(factor: number, maxPerPass: number): number[] {
  const passes: number[] = [];
  let remaining = factor;
  while (remaining > maxPerPass * (1 + 1e-9)) {
    passes.push(maxPerPass);
    remaining /= maxPerPass;
  }
  passes.push(remaining);
  return passes;
}

/**
 * Mode → fal model. Endpoint IDs and parameters checked against
 * https://fal.ai/models/<endpoint>/llms.txt on 2026-10-07.
 */
export const MODEL_TABLE: Record<EnhanceMode, ModelSpec> = {
  enhance: {
    endpoint: 'fal-ai/seedvr/upscale/image',
    maxFactorPerPass: 10,
    // fal 422 (device testing, 2026-10-07): "Both dimensions must be at least 256 pixels when the
    // output exceeds 1080p". 1920×1080 in either orientation satisfies every reading of "1080p".
    smallInput: { minSide: 256, maxOutput: { long: 1920, short: 1080 } },
    buildInput: (imageUrl, factor) => ({
      image_url: imageUrl,
      upscale_mode: 'factor',
      upscale_factor: factor,
      output_format: 'jpg',
    }),
  },
  pro: {
    endpoint: 'fal-ai/topaz/upscale/image',
    maxFactorPerPass: 4,
    buildInput: (imageUrl, factor) => ({
      image_url: imageUrl,
      model: 'High Fidelity V2',
      upscale_factor: factor,
      output_format: 'jpeg',
      face_enhancement_creativity: 0,
    }),
  },
  creative: {
    endpoint: 'fal-ai/clarity-upscaler',
    maxFactorPerPass: 4,
    buildInput: (imageUrl, factor) => ({
      image_url: imageUrl,
      upscale_factor: factor,
    }),
  },
};

type FalLike = Pick<FalClient, 'storage' | 'subscribe' | 'queue'>;

interface FalImageOutput {
  image?: { url?: string; width?: number; height?: number };
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(timeoutError());
    signal.addEventListener('abort', () => reject(timeoutError()), { once: true });
  });
}

/** Short, log-safe description of a fal client error (status, message, response body). */
export function describeProviderError(err: unknown, secrets: string[] = []): string {
  const e = err as { status?: unknown; message?: unknown; body?: unknown };
  const parts = [
    typeof e?.status === 'number' ? `status ${e.status}` : null,
    e?.message ? String(e.message) : String(err),
    e?.body !== undefined ? JSON.stringify(e.body) : null,
  ].filter(Boolean);
  // Redact before truncating, so a key that straddles the cut can't leave its prefix behind.
  let text = parts.join(' | ');
  for (const secret of secrets) if (secret) text = text.split(secret).join('<redacted>');
  return text.slice(0, 500);
}

export function createFalUpscaler(client: FalLike, onProviderError?: (err: unknown) => void): Upscaler {
  return {
    async upscale({ image, width, height, mode, signal }: UpscaleRequest): Promise<UpscaleResult> {
      const spec = MODEL_TABLE[mode];
      const plan = planForModel(spec, width, height);
      const aborted = rejectOnAbort(signal);
      // Keep an unobserved rejection from surfacing when the request finishes first.
      aborted.catch(() => {});

      // fal's abortSignal only stops this client waiting; the job stays queued on fal and keeps
      // billing. On abort (app cancel, disconnect or timeout), cancel the job still in the queue.
      let queuedRequestId: string | undefined;
      const cancelQueuedJob = () => {
        if (!queuedRequestId) return;
        client.queue?.cancel(spec.endpoint, { requestId: queuedRequestId }).catch(() => {});
      };
      signal.addEventListener('abort', cancelQueuedJob, { once: true });

      try {
        const imageUrl = await Promise.race([
          client.storage.upload(image, { lifecycle: { expiresIn: OBJECT_EXPIRY } }),
          aborted,
        ]);
        // Models capped below the planned factor get a second pass on the first pass's output.
        // Both passes share the request's abort signal, so the overall timeout covers them together.
        let url = imageUrl;
        let output: FalImageOutput = {};
        const passes = planPasses(plan.factor, spec.maxFactorPerPass);
        for (const [i, factor] of passes.entries()) {
          if (process.env.NODE_ENV !== 'production') {
            console.info(`[fal] ${mode} pass ${i + 1}/${passes.length}: ${spec.endpoint} at ${factor.toFixed(2)}x`);
          }
          const result = await Promise.race([
            client.subscribe(spec.endpoint, {
              input: spec.buildInput(url, factor),
              abortSignal: signal,
              storageSettings: { expiresIn: OBJECT_EXPIRY },
              onEnqueue: (requestId) => {
                queuedRequestId = requestId;
              },
            }),
            aborted,
          ]);
          queuedRequestId = undefined;
          output = result.data as FalImageOutput;
          if (!output.image?.url) throw providerError();
          url = output.image.url;
        }
        return {
          url,
          width: output.image?.width ?? plan.outputWidth,
          height: output.image?.height ?? plan.outputHeight,
        };
      } catch (err) {
        if (err instanceof ApiError) throw err;
        if (signal.aborted) throw timeoutError();
        onProviderError?.(err);
        throw providerError();
      } finally {
        signal.removeEventListener('abort', cancelQueuedJob);
      }
    },
  };
}

export function createDefaultFalUpscaler(apiKey: string): Upscaler {
  // Outside production, log why fal failed (e.g. "Exhausted balance"); the client only ever
  // sees a generic provider_error, and the key is scrubbed from the log line.
  const logError =
    process.env.NODE_ENV === 'production'
      ? undefined
      : (err: unknown) => console.warn(`[fal] provider error: ${describeProviderError(err, [apiKey])}`);
  return createFalUpscaler(createFalClient({ credentials: apiKey }), logError);
}
