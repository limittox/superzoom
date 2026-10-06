import type { EnhanceMode } from '@/shared/enhance';
import { type EnhanceFailure, type LocalImage, useSession } from '@/state/session';

import { EnhanceRequestError, runEnhancement } from './client';
import { failureMessage } from './messages';

type Run = (upload: LocalImage, mode: EnhanceMode, signal: AbortSignal) => Promise<LocalImage>;

/**
 * Starts and cancels enhancements for the current capture session. Only the most
 * recent request can update the session; cancelled or superseded requests are dropped.
 */
export function createEnhancementRunner(run: Run = runEnhancement) {
  let controller: AbortController | null = null;

  return {
    async start(mode: EnhanceMode): Promise<void> {
      const { upload, beginRequest, resolveRequest, failRequest } = useSession.getState();
      if (!upload) return;
      controller?.abort();
      const current = new AbortController();
      controller = current;
      const id = beginRequest(mode);
      try {
        const result = await run(upload, mode, current.signal);
        resolveRequest(id, mode, result);
      } catch (err) {
        const failure: EnhanceFailure =
          err instanceof EnhanceRequestError
            ? err.failure
            : { code: 'network', message: failureMessage({ code: 'network' }) };
        failRequest(id, mode, failure);
      } finally {
        if (controller === current) controller = null;
      }
    },

    cancel(): void {
      controller?.abort();
      controller = null;
      useSession.getState().cancelRequest();
    },
  };
}

export const enhancementRunner = createEnhancementRunner();
