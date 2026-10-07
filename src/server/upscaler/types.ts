import type { EnhanceMode } from '@/shared/enhance';

import type { JobRecord } from '../jobStore';

export interface StartRequest {
  image: Blob;
  width: number;
  height: number;
  mode: EnhanceMode;
}

/** The job fields an upscaler fills in when it queues the first pass. */
export type StartedJob = Pick<
  JobRecord,
  'passes' | 'outputWidth' | 'outputHeight' | 'sourceUrl' | 'providerRequestId' | 'passQueuedAt'
>;

/**
 * Provider-agnostic upscaler, so the fal implementation can be swapped (e.g. for Replicate)
 * without touching the routes. Jobs advance only when asked (enhance-job-api design
 * decisions 1 and 6): nothing runs between requests.
 */
export interface Upscaler {
  /** Uploads the image and queues the first pass. Throws `ApiError` (e.g. `image_too_small`, `provider_error`). */
  start(request: StartRequest, now?: number): Promise<StartedJob>;
  /**
   * Checks the active pass and returns the job's next state: still waiting, the next pass
   * queued, done, or failed (`provider_error`, or `timeout` past the per-pass limit, in which
   * case the pass is cancelled). Never throws for provider failures.
   */
  advance(job: JobRecord, now?: number): Promise<JobRecord>;
  /** Asks the provider to drop the active pass. Best effort; never throws. */
  cancel(job: JobRecord): Promise<void>;
}
