import {
  DEFAULT_MODE,
  type EnhanceErrorCode,
  type EnhanceJobCreated,
  type EnhanceJobStatus,
  type EnhanceMode,
  FORM_FIELDS,
  INSTALL_ID_HEADER,
  isEnhanceMode,
  LIMITS,
} from '@/shared/enhance';

import { ApiError, errorResponse, providerError } from './errors';
import type { CommitOutcome, JobRecord, JobStore } from './jobStore';
import type { RateLimiter } from './rateLimit';
import type { SaveUpload } from './uploadSaver';
import type { Upscaler } from './upscaler/types';
import { validateImage } from './validate';

/** Structured log line, one per job when it ends and one per rejected submission. Never contains image data or credentials. */
export type LogEvent = {
  event: 'enhance';
  outcome: 'ok' | 'cancelled' | EnhanceErrorCode;
  mode?: EnhanceMode;
  ms: number;
};

export interface EnhanceHandlerDeps {
  getUpscaler: () => Upscaler;
  getRateLimiter: () => RateLimiter;
  getJobStore: () => JobStore;
  log?: (event: LogEvent) => void;
  now?: () => number;
  newId?: () => string;
  /** Pause between attempts when a cancel or a finishing submission finds the job locked (default 250 ms). */
  lockRetryMs?: number;
  /** Development only (`SAVE_UPLOADS_DIR`): keeps a copy of each accepted upload for model evaluation. */
  saveUpload?: SaveUpload;
}

const INSTALL_ID_PATTERN = /^[A-Za-z0-9-]{8,128}$/;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

function readRequestId(form: MultipartForm): string {
  const raw = form.get(FORM_FIELDS.requestId);
  if (typeof raw !== 'string' || !REQUEST_ID_PATTERN.test(raw)) {
    throw badRequest(`A "${FORM_FIELDS.requestId}" field with a UUID is required.`);
  }
  return raw;
}

function readInstallId(request: Request): string {
  const installId = request.headers.get(INSTALL_ID_HEADER);
  if (!installId || !INSTALL_ID_PATTERN.test(installId)) {
    throw new ApiError('missing_install_id', `A valid ${INSTALL_ID_HEADER} header is required.`, 400);
  }
  return installId;
}

const unavailable = () =>
  new ApiError('provider_error', 'The service is temporarily unavailable. Please try again.', 503);
const jobNotFound = () => new ApiError('job_not_found', 'This enhancement job does not exist or has expired.', 404);

/** Store calls fail closed: without the job store there is no job, and without the limiter no cost guard. */
async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch {
    throw unavailable();
  }
}

const isActive = (job: JobRecord) => job.status === 'queued' || job.status === 'processing';

function toStatus(job: JobRecord): EnhanceJobStatus {
  return {
    jobId: job.id,
    status: job.status,
    mode: job.mode,
    // A job still being submitted has no pass plan yet.
    ...(isActive(job) && job.passes.length ? { pass: job.passIndex + 1, passes: job.passes.length } : {}),
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Outgoing-call budget: EAS Hosting allows one request 10 outgoing calls, fal and Upstash together
 * (docs/backend.md). So nothing here waits on a lock by polling it: a cancel tries the lock this
 * many times in all, and a finishing submission tries to commit this many times.
 */
const CANCEL_LOCK_ATTEMPTS = 3;
const COMMIT_ATTEMPTS = 2;

/**
 * Claimed in place of a job ID when the app cancels a submission before learning its job, so a
 * submission still in flight with that request ID doesn't start one.
 */
const CANCELLED_REQUEST = 'cancelled';
const submissionCancelled = () =>
  new ApiError('job_not_found', 'This enhancement was cancelled before it started.', 404);

/**
 * The job API (enhance-job-api design decisions 1–5): `submit` starts a job and returns its ID;
 * `status` advances the job one step and reports it; `cancel` stops it. Nothing runs between
 * requests, so the same handlers work on the dev server and on EAS Hosting.
 *
 * Every change to an active job happens under the job's lock. A cancel that arrives while a
 * status check holds the lock is recorded as a flag, which the holder acts on before saving.
 */
export function createEnhanceHandlers({
  getUpscaler,
  getRateLimiter,
  getJobStore,
  log = (event) => console.info(JSON.stringify(event)),
  now = Date.now,
  newId = () => crypto.randomUUID(),
  lockRetryMs = 250,
  saveUpload,
}: EnhanceHandlerDeps) {
  const logEnd = (job: JobRecord) =>
    log({
      event: 'enhance',
      outcome:
        job.status === 'done' ? 'ok' : job.status === 'cancelled' ? 'cancelled' : (job.error?.code ?? 'provider_error'),
      mode: job.mode,
      ms: now() - job.createdAt,
    });

  /**
   * Cancels an active job whose lock `token` holds: drops its provider work, saves it as cancelled
   * and releases the lock. Call with the cancel flag set: if the save fails, the next check sees
   * the flag and tries again, and the job is logged once, when the save succeeds.
   */
  async function cancelLocked(jobs: JobStore, job: JobRecord, token: string): Promise<JobRecord> {
    await getUpscaler().cancel(job);
    const cancelled: JobRecord = { ...job, status: 'cancelled' };
    await guarded(() => jobs.saveAndUnlock(job.id, token, cancelled));
    logEnd(cancelled);
    return cancelled;
  }

  /**
   * Cancels one of the caller's jobs (a `DELETE` by job ID or by request ID); null if it doesn't
   * exist or isn't theirs. Setting the cancel flag comes first, so whoever holds the lock acts on
   * it before saving and no pass can start afterwards.
   */
  async function cancelJob(jobs: JobStore, id: string, installId: string): Promise<JobRecord | null> {
    let read = await guarded(() => jobs.lockAndRead(id, installId, { requestCancel: true }));
    for (let attempt = 1; read.job && isActive(read.job) && !read.token && attempt < CANCEL_LOCK_ATTEMPTS; attempt++) {
      await sleep(lockRetryMs);
      read = await guarded(() => jobs.lockAndRead(id, installId));
    }
    const { job, token } = read;
    if (!job || !isActive(job)) return job;
    // Still locked: the holder sees the flag and cancels the job before it saves.
    if (!token) return { ...job, status: 'cancelled' };
    let released = false;
    try {
      const cancelled = await cancelLocked(jobs, job, token);
      released = true;
      return cancelled;
    } finally {
      if (!released) await jobs.unlock(id, token).catch(() => {});
    }
  }

  const fail = (err: unknown) => errorResponse(err instanceof ApiError ? err : providerError());

  return {
    /** POST /api/enhance */
    async submit(request: Request): Promise<Response> {
      const started = now();
      let mode: EnhanceMode | undefined;
      try {
        const installId = readInstallId(request);
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
        const requestId = readRequestId(form);
        const bytes = await readImage(form);
        const image = validateImage(bytes);
        if (!image.ok) {
          throw new ApiError(image.code, image.message, STATUS_BY_CODE[image.code] ?? 400);
        }

        const jobs = getJobStore();
        const created = (jobId: string) => Response.json({ jobId } satisfies EnhanceJobCreated, { status: 202 });
        // A resubmission (the app lost the first response) gets the same job, without another charge.
        const existing = await guarded(() => jobs.findRequest(installId, requestId));
        if (existing === CANCELLED_REQUEST) throw submissionCancelled();
        if (existing) return created(existing);

        const limit = await guarded(() => getRateLimiter().check(installId));
        if (!limit.allowed) {
          throw new ApiError('rate_limited', "You've reached today's enhancement limit.", 429, limit.retryAt);
        }

        // The job is saved together with its request ID, before its ID can reach anyone: a
        // resubmission during the upload below gets this ID, and its polls must find the job
        // (reported as queued until the upload finishes).
        const createdAt = now();
        const pending: JobRecord = {
          id: newId(),
          installId,
          mode,
          createdAt,
          status: 'queued',
          passes: [],
          outputWidth: 0,
          outputHeight: 0,
          passIndex: 0,
        };
        const winner = await guarded(() => jobs.create(pending, requestId));
        if (winner === CANCELLED_REQUEST) throw submissionCancelled();
        if (winner !== pending.id) return created(winner);

        if (saveUpload) {
          // Only uploads that start a new job (not resubmissions or rejected requests). Best effort:
          // a failed copy never fails the enhancement.
          await saveUpload(bytes, {
            mode,
            width: image.width,
            height: image.height,
            contentType: image.contentType,
          }).catch((err) => console.warn('[uploads] saving the upload failed:', err));
        }

        // The upload runs without the lock, so a slow one can't outlive it. Polls meanwhile see
        // the job as queued; a cancel or a timeout meanwhile ends it, and the new pass is dropped.
        const upscaler = getUpscaler();
        let job: JobRecord;
        try {
          const first = await upscaler.start({
            image: new Blob([bytes as BlobPart], { type: image.contentType }),
            width: image.width,
            height: image.height,
            mode,
          });
          job = { ...pending, ...first };
        } catch (err) {
          // The job never started: record why for anyone polling it, and let a retry with the
          // same request ID start over.
          const apiError = err instanceof ApiError ? err : providerError();
          await jobs
            .put({ ...pending, status: 'failed', error: { code: apiError.code, message: apiError.message } })
            .catch(() => {});
          await jobs.releaseRequest(installId, requestId).catch(() => {});
          throw apiError;
        }

        // Save the new pass's handle if the job is still waiting for it. Until that succeeds, any
        // error (e.g. Redis) would leave the pass running with no stored handle, so it is
        // cancelled instead.
        const cancelled: JobRecord = { ...job, status: 'cancelled' };
        let outcome: CommitOutcome = 'locked';
        try {
          for (let attempt = 1; attempt <= COMMIT_ATTEMPTS && outcome === 'locked'; attempt++) {
            if (attempt > 1) await sleep(lockRetryMs);
            outcome = await guarded(() => jobs.commitStarted(job, cancelled));
          }
        } catch (err) {
          await upscaler.cancel(job);
          throw err;
        }
        if (outcome === 'locked') {
          // A status check still holds the job. Its stored state stays queued and times out.
          await upscaler.cancel(job);
          throw unavailable();
        }
        if (outcome !== 'saved') {
          // Cancelled, timed out or expired during the upload: the new pass is no longer wanted.
          await upscaler.cancel(job);
          if (outcome === 'cancelled') logEnd(cancelled);
        }
        return created(pending.id);
      } catch (err) {
        const apiError = err instanceof ApiError ? err : providerError();
        log({ event: 'enhance', outcome: apiError.code, mode, ms: now() - started });
        return errorResponse(apiError);
      }
    },

    /** GET /api/enhance/{jobId}: advances the job one step, then reports it. */
    async status(request: Request, jobId: string | undefined): Promise<Response> {
      try {
        const installId = readInstallId(request);
        if (!jobId) throw jobNotFound();
        const jobs = getJobStore();
        const read = await guarded(() => jobs.lockAndRead(jobId, installId));
        if (!read.job) throw jobNotFound();
        let job = read.job;
        // Finished, or another request is working on it and answers for both: report it as stored.
        if (!isActive(job) || !read.token) return Response.json(toStatus(job));
        const token = read.token;
        let released = false;
        try {
          if (read.cancelRequested) {
            job = await cancelLocked(jobs, job, token);
          } else {
            const next = await getUpscaler().advance(job);
            // Most polls change nothing; skip the write then.
            const changed = JSON.stringify(next) !== JSON.stringify(job);
            let outcome: 'saved' | 'cancel-requested';
            try {
              // A cancel that arrived while the provider was being asked wins, including over a
              // pass that was just queued.
              outcome = await jobs.saveAndUnlock(job.id, token, changed ? next : null, {
                yieldToCancel: isActive(next),
              });
            } catch {
              // The new pass's handle wasn't saved (the stored job still points at the previous
              // pass), so drop it; the next check queues it again.
              if (next.providerRequestId && next.providerRequestId !== job.providerRequestId) {
                await getUpscaler().cancel(next);
              }
              throw unavailable();
            }
            if (outcome === 'cancel-requested') {
              job = await cancelLocked(jobs, next, token);
            } else {
              if (changed && !isActive(next)) logEnd(next);
              job = next;
            }
          }
          released = true;
        } finally {
          if (!released) await jobs.unlock(job.id, token).catch(() => {});
        }
        return Response.json(toStatus(job));
      } catch (err) {
        return fail(err);
      }
    },

    /** DELETE /api/enhance/{jobId}: cancels the job and its queued provider work. */
    async cancel(request: Request, jobId: string | undefined): Promise<Response> {
      try {
        const installId = readInstallId(request);
        const job = jobId ? await cancelJob(getJobStore(), jobId, installId) : null;
        if (!job) throw jobNotFound();
        return Response.json(toStatus(job));
      } catch (err) {
        return fail(err);
      }
    },

    /**
     * DELETE /api/enhance?requestId=…: cancels a submission whose job ID the app never received
     * (its response was lost). Cancels the job if it exists; otherwise makes sure a submission
     * still in flight with that request ID won't start one.
     */
    async cancelSubmission(request: Request): Promise<Response> {
      try {
        const installId = readInstallId(request);
        const requestId = new URL(request.url).searchParams.get(FORM_FIELDS.requestId) ?? '';
        if (!REQUEST_ID_PATTERN.test(requestId)) {
          throw badRequest(`A "${FORM_FIELDS.requestId}" query parameter with a UUID is required.`);
        }
        const jobs = getJobStore();
        const winner = await guarded(() => jobs.claimRequest(installId, requestId, CANCELLED_REQUEST, now()));
        if (winner === CANCELLED_REQUEST) return Response.json({ requestId, status: 'cancelled' });
        const job = await cancelJob(jobs, winner, installId);
        if (!job) return Response.json({ requestId, status: 'cancelled' });
        return Response.json(toStatus(job));
      } catch (err) {
        return fail(err);
      }
    },
  };
}
