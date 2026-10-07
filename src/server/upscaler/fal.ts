import { createFalClient, type FalClient } from '@fal-ai/client';

import { type EnhanceMode, LIMITS } from '@/shared/enhance';
import { chooseUpscaleFactor, type UpscalePlan } from '@/shared/upscale';

import { ApiError, providerError, timeoutError } from '../errors';
import type { JobRecord } from '../jobStore';
import type { Upscaler } from './types';

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

type FalLike = Pick<FalClient, 'storage' | 'queue'>;

interface FalImageOutput {
  image?: { url?: string; width?: number; height?: number };
}

/** fal drops a queued pass that hasn't started within this many seconds, even if nobody polls. */
const PASS_START_TIMEOUT_S = LIMITS.providerTimeoutMs / 1000;
/**
 * Each fal call in a status check gives up after this long, so one advance (status, result and
 * submit) always finishes well inside the job lock (`JOB_LOCK_MS`).
 */
export const FAL_CALL_TIMEOUT_MS = 15_000;

class FalCallTimeout extends Error {}

/** Stops waiting for a fal call after `FAL_CALL_TIMEOUT_MS`. */
function bounded<T>(call: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FalCallTimeout('fal call timed out')), FAL_CALL_TIMEOUT_MS);
  });
  return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
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

/**
 * fal implementation of the job seam (enhance-job-api design decisions 1 and 6). `start` uploads
 * and queues pass 1; each `advance` checks the active pass and queues the next one on its output.
 */
export function createFalUpscaler(
  client: FalLike,
  onProviderError?: (err: unknown) => void,
  now: () => number = Date.now,
): Upscaler {
  async function submitPass(mode: EnhanceMode, sourceUrl: string, passes: number[], index: number) {
    const spec = MODEL_TABLE[mode];
    if (process.env.NODE_ENV !== 'production') {
      console.info(`[fal] ${mode} pass ${index + 1}/${passes.length}: ${spec.endpoint} at ${passes[index].toFixed(2)}x`);
    }
    const queued = await bounded(
      client.queue.submit(spec.endpoint, {
        input: spec.buildInput(sourceUrl, passes[index]),
        startTimeout: PASS_START_TIMEOUT_S,
        storageSettings: { expiresIn: OBJECT_EXPIRY },
      }),
    );
    // A pass's time starts when fal has it, not before a slow upload or status check.
    return { providerRequestId: queued.request_id, passQueuedAt: now() };
  }

  async function cancelPass(job: JobRecord) {
    if ((job.status !== 'queued' && job.status !== 'processing') || !job.providerRequestId) return;
    try {
      await bounded(client.queue.cancel(MODEL_TABLE[job.mode].endpoint, { requestId: job.providerRequestId }));
    } catch {
      // Best effort: a pass that already started or finished can't be cancelled.
    }
  }

  const failed = (job: JobRecord, error: ApiError): JobRecord => ({
    ...job,
    status: 'failed',
    error: { code: error.code, message: error.message },
  });

  return {
    async start({ image, width, height, mode }) {
      const spec = MODEL_TABLE[mode];
      // Rejects inputs the model can't take before anything is uploaded or billed.
      const plan = planForModel(spec, width, height);
      const passes = planPasses(plan.factor, spec.maxFactorPerPass);
      try {
        const sourceUrl = await client.storage.upload(image, { lifecycle: { expiresIn: OBJECT_EXPIRY } });
        const queued = await submitPass(mode, sourceUrl, passes, 0);
        return { passes, outputWidth: plan.outputWidth, outputHeight: plan.outputHeight, sourceUrl, ...queued };
      } catch (err) {
        onProviderError?.(err);
        throw providerError();
      }
    },

    async advance(job) {
      if (job.status !== 'queued' && job.status !== 'processing') return job;
      if (!job.providerRequestId) {
        // Still being submitted. A submission that never finished (e.g. the server stopped) times out.
        return now() - job.createdAt > LIMITS.providerTimeoutMs ? failed(job, timeoutError()) : job;
      }
      const { endpoint } = MODEL_TABLE[job.mode];
      const requestId = job.providerRequestId;

      let status;
      try {
        status = await bounded(client.queue.status(endpoint, { requestId }));
      } catch (err) {
        // A failed status check says nothing about the job; try again on the next poll.
        onProviderError?.(err);
        status = null;
      }

      if (status?.status !== 'COMPLETED') {
        if (now() - (job.passQueuedAt ?? job.createdAt) > LIMITS.providerTimeoutMs) {
          await cancelPass(job);
          return failed(job, timeoutError());
        }
        if (!status) return job;
        // Pass 1 waiting in fal's queue is "queued"; anything later is "processing".
        return { ...job, status: status.status === 'IN_QUEUE' && job.passIndex === 0 ? 'queued' : 'processing' };
      }

      let output: FalImageOutput;
      try {
        output = (await bounded(client.queue.result(endpoint, { requestId }))).data as FalImageOutput;
      } catch (err) {
        onProviderError?.(err);
        // A slow result fetch is retried on the next poll; anything else means the model failed.
        return err instanceof FalCallTimeout ? job : failed(job, providerError());
      }
      const url = output.image?.url;
      if (!url) return failed(job, providerError());

      const next = job.passIndex + 1;
      if (next < job.passes.length) {
        try {
          const queued = await submitPass(job.mode, url, job.passes, next);
          return { ...job, status: 'processing', passIndex: next, sourceUrl: url, ...queued };
        } catch (err) {
          onProviderError?.(err);
          return failed(job, providerError());
        }
      }
      return {
        ...job,
        status: 'done',
        result: {
          url,
          width: output.image?.width ?? job.outputWidth,
          height: output.image?.height ?? job.outputHeight,
          mode: job.mode,
        },
      };
    },

    cancel: cancelPass,
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
