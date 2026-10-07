import { createFalClient, type FalClient } from '@fal-ai/client';

import type { EnhanceMode } from '@/shared/enhance';
import { chooseUpscaleFactor } from '@/shared/upscale';

import { ApiError, providerError, timeoutError } from '../errors';
import type { UpscaleRequest, UpscaleResult, Upscaler } from './types';

/** Uploaded inputs and generated outputs expire on fal's CDN after this long. */
const OBJECT_EXPIRY = '1h' as const;

interface ModelSpec {
  endpoint: string;
  buildInput(imageUrl: string, factor: number): Record<string, unknown>;
}

/**
 * Mode → fal model. Endpoint IDs and parameters checked against
 * https://fal.ai/models/<endpoint>/llms.txt on 2026-10-07.
 */
export const MODEL_TABLE: Record<EnhanceMode, ModelSpec> = {
  enhance: {
    endpoint: 'fal-ai/seedvr/upscale/image',
    buildInput: (imageUrl, factor) => ({
      image_url: imageUrl,
      upscale_mode: 'factor',
      upscale_factor: factor,
      output_format: 'jpg',
    }),
  },
  pro: {
    endpoint: 'fal-ai/topaz/upscale/image',
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
    buildInput: (imageUrl, factor) => ({
      image_url: imageUrl,
      upscale_factor: factor,
    }),
  },
};

type FalLike = Pick<FalClient, 'storage' | 'subscribe'>;

interface FalImageOutput {
  image?: { url?: string; width?: number; height?: number };
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(timeoutError());
    signal.addEventListener('abort', () => reject(timeoutError()), { once: true });
  });
}

export function createFalUpscaler(client: FalLike): Upscaler {
  return {
    async upscale({ image, width, height, mode, signal }: UpscaleRequest): Promise<UpscaleResult> {
      const spec = MODEL_TABLE[mode];
      const plan = chooseUpscaleFactor(width, height);
      const aborted = rejectOnAbort(signal);
      // Keep an unobserved rejection from surfacing when the request finishes first.
      aborted.catch(() => {});

      try {
        const imageUrl = await Promise.race([
          client.storage.upload(image, { lifecycle: { expiresIn: OBJECT_EXPIRY } }),
          aborted,
        ]);
        const result = await Promise.race([
          client.subscribe(spec.endpoint, {
            input: spec.buildInput(imageUrl, plan.factor),
            abortSignal: signal,
            storageSettings: { expiresIn: OBJECT_EXPIRY },
          }),
          aborted,
        ]);
        const output = result.data as FalImageOutput;
        if (!output.image?.url) throw providerError();
        return {
          url: output.image.url,
          width: output.image.width ?? plan.outputWidth,
          height: output.image.height ?? plan.outputHeight,
        };
      } catch (err) {
        if (err instanceof ApiError) throw err;
        if (signal.aborted) throw timeoutError();
        throw providerError();
      }
    },
  };
}

export function createDefaultFalUpscaler(apiKey: string): Upscaler {
  return createFalUpscaler(createFalClient({ credentials: apiKey }));
}
