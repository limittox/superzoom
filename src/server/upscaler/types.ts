import type { EnhanceMode } from '@/shared/enhance';

export interface UpscaleRequest {
  image: Blob;
  width: number;
  height: number;
  mode: EnhanceMode;
  signal: AbortSignal;
}

export interface UpscaleResult {
  url: string;
  width: number;
  height: number;
}

/**
 * Provider-agnostic upscaler, so the fal implementation can be swapped
 * (e.g. for Replicate) without touching the route. See design.md decision 7.
 */
export interface Upscaler {
  upscale(request: UpscaleRequest): Promise<UpscaleResult>;
}
