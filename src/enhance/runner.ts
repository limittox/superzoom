import * as Crypto from 'expo-crypto';
import { AppState } from 'react-native';

import type { EnhanceJobStatus, EnhanceMode, EnhanceSuccess } from '@/shared/enhance';
import { type EnhanceFailure, type EnhancePhase, type LocalImage, useSession } from '@/state/session';

import { cancelJob, deleteLocalFile, downloadResult, EnhanceRequestError, fail, getJob, submitJob } from './client';
import { failureMessage } from './messages';

/** How often a running job is checked while the app is in the foreground. */
export const POLL_INTERVAL_MS = 2000;
/** How long status checks may keep failing (app in the foreground) before the app reports a network failure. */
export const NETWORK_GRACE_MS = 30_000;
/** How many times a submission that failed while the app was in the background is resent on return. */
export const SUBMIT_RETRIES = 3;

export interface JobApi {
  submit(upload: LocalImage, mode: EnhanceMode, requestId: string, signal: AbortSignal): Promise<string>;
  get(jobId: string, signal: AbortSignal): Promise<EnhanceJobStatus>;
  cancel(jobId: string): Promise<void>;
  download(result: EnhanceSuccess, signal: AbortSignal): Promise<LocalImage>;
}

/** Whether the app is in the foreground, and changes to it. */
export interface Foreground {
  isActive(): boolean;
  /** Calls `listener` on each change; returns an unsubscribe function. */
  subscribe(listener: (active: boolean) => void): () => void;
}

const appStateForeground: Foreground = {
  // `currentState` can be unknown at launch; only background and inactive count as away.
  isActive: () => AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
  subscribe(listener) {
    const subscription = AppState.addEventListener('change', (state) => listener(state === 'active'));
    return () => subscription.remove();
  },
};

const defaultApi: JobApi = { submit: submitJob, get: getJob, cancel: cancelJob, download: downloadResult };

export interface RunnerOptions {
  api?: JobApi;
  foreground?: Foreground;
  discard?: (uri: string) => void;
  newRequestId?: () => string;
  now?: () => number;
  pollIntervalMs?: number;
  networkGraceMs?: number;
}

const isNetworkFailure = (err: unknown) => err instanceof EnhanceRequestError && err.failure.code === 'network';

/** The progress label for a job's status (specs/enhanced-photo-review: Automatic enhancement after capture). */
export function phaseOf(status: EnhanceJobStatus): EnhancePhase {
  if (status.status === 'queued') return 'queued';
  return status.passes && status.passes > 1 && status.pass === status.passes ? 'finishing' : 'processing';
}

/**
 * Starts, follows and cancels enhancement jobs for the current capture session
 * (enhance-job-api design decision 7). The job runs on the service, so switching apps doesn't
 * cancel it: polling pauses in the background and resumes at once on return. Only the most
 * recent request can update the session; cancelled or superseded requests are dropped.
 */
export function createEnhancementRunner({
  api = defaultApi,
  foreground = appStateForeground,
  discard = deleteLocalFile,
  newRequestId = Crypto.randomUUID,
  now = Date.now,
  pollIntervalMs = POLL_INTERVAL_MS,
  networkGraceMs = NETWORK_GRACE_MS,
}: RunnerOptions = {}) {
  let controller: AbortController | null = null;

  /** Resolves when the app is in the foreground; rejects with `cancelled` on abort. */
  function waitForForeground(signal: AbortSignal): Promise<void> {
    return pause(0, signal).then(() => undefined);
  }

  /**
   * Waits `ms` in the foreground. Time in the background doesn't count: the wait pauses there
   * and ends as soon as the app returns. Resolves true if the app was in the background meanwhile.
   */
  function pause(ms: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let wasAway = !foreground.isActive();
      const cleanup = () => {
        clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener('abort', onAbort);
      };
      const finish = () => {
        cleanup();
        resolve(wasAway);
      };
      const onAbort = () => {
        cleanup();
        reject(fail('cancelled'));
      };
      const unsubscribe = foreground.subscribe((active) => {
        if (active) {
          if (wasAway) finish();
        } else {
          wasAway = true;
          clearTimeout(timer);
        }
      });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) return onAbort();
      if (!wasAway) timer = setTimeout(finish, ms);
    });
  }

  /**
   * Submits, resending with the same request ID if the app went to the background and the upload
   * failed. Cancel doesn't abort the upload: the service would queue the job anyway, and the app
   * needs its ID to cancel it, so the caller cancels the job once the submission returns.
   */
  async function submit(upload: LocalImage, mode: EnhanceMode, signal: AbortSignal): Promise<string> {
    const requestId = newRequestId();
    const uploading = new AbortController().signal;
    for (let attempt = 0; ; attempt++) {
      let wentAway = !foreground.isActive();
      const unsubscribe = foreground.subscribe((active) => {
        if (!active) wentAway = true;
      });
      try {
        return await api.submit(upload, mode, requestId, uploading);
      } catch (err) {
        if (!isNetworkFailure(err) || !wentAway || attempt >= SUBMIT_RETRIES || signal.aborted) throw err;
      } finally {
        unsubscribe();
      }
      await waitForForeground(signal);
    }
  }

  /** Follows a job until it ends, then downloads the result. */
  async function follow(id: number, jobId: string, signal: AbortSignal): Promise<LocalImage> {
    const { updateRequest } = useSession.getState();
    let lastSuccess = now();
    for (;;) {
      let status: EnhanceJobStatus | null = null;
      try {
        status = await api.get(jobId, signal);
        lastSuccess = now();
      } catch (err) {
        // Keep trying through short outages; a job that no longer exists ends the run.
        if (!isNetworkFailure(err) || now() - lastSuccess >= networkGraceMs) throw err;
      }
      if (status) {
        if (status.status === 'done') {
          if (!status.result) throw fail('provider_error');
          return api.download(status.result, signal);
        }
        if (status.status === 'failed') throw fail(status.error?.code ?? 'provider_error', status.error?.retryAt);
        if (status.status === 'cancelled') throw fail('cancelled');
        updateRequest(id, { phase: phaseOf(status) });
      }
      // Background time isn't a network failure; start the grace period again on return.
      if (await pause(pollIntervalMs, signal)) lastSuccess = now();
    }
  }

  return {
    async start(mode: EnhanceMode): Promise<void> {
      const { upload, request, beginRequest, updateRequest, resolveRequest, failRequest } = useSession.getState();
      if (!upload) return;
      // A superseded job's result would never be shown; stop it on the service too.
      if (request.status === 'pending' && request.jobId) void api.cancel(request.jobId);
      controller?.abort();
      const current = new AbortController();
      controller = current;
      const { signal } = current;

      // Retry after a network failure resumes the job, which may have kept running.
      const resumeJobId =
        request.status === 'error' && request.mode === mode && request.error.code === 'network' ? request.jobId : undefined;
      const id = beginRequest(mode, resumeJobId);
      let jobId = resumeJobId;
      try {
        if (!jobId) {
          jobId = await submit(upload, mode, signal);
          if (signal.aborted) {
            void api.cancel(jobId);
            throw fail('cancelled');
          }
          updateRequest(id, { jobId, phase: 'queued' });
        }
        const result = await follow(id, jobId, signal);
        // A result for a cancelled or superseded request is never shown; don't leave it in the cache.
        if (!resolveRequest(id, mode, result)) discard(result.uri);
      } catch (err) {
        const failure: EnhanceFailure =
          err instanceof EnhanceRequestError
            ? err.failure
            : { code: 'network', message: failureMessage({ code: 'network' }) };
        // After a network failure the job may still be running; keep it so Retry can resume it.
        failRequest(id, mode, failure, failure.code === 'network' ? jobId : undefined);
      } finally {
        if (controller === current) controller = null;
      }
    },

    /** Stops waiting and cancels the job on the service (the Cancel button, or leaving the result screen). */
    cancel(): void {
      controller?.abort();
      controller = null;
      const { request, cancelRequest } = useSession.getState();
      if (request.status === 'pending' && request.jobId) void api.cancel(request.jobId);
      cancelRequest();
    },
  };
}

export const enhancementRunner = createEnhancementRunner();
