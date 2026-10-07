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
} from "@/shared/enhance";

import { ApiError, errorResponse, providerError } from "./errors";
import type { JobRecord, JobStore } from "./jobStore";
import type { RateLimiter } from "./rateLimit";
import type { Upscaler } from "./upscaler/types";
import { validateImage } from "./validate";

/** Structured log line, one per job when it ends and one per rejected submission. Never contains image data or credentials. */
export type LogEvent = {
  event: "enhance";
  outcome: "ok" | "cancelled" | EnhanceErrorCode;
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
  /** How long `DELETE` waits for a concurrent status check to release the job. */
  cancelLockWaitMs?: number;
}

const INSTALL_ID_PATTERN = /^[A-Za-z0-9-]{8,128}$/;
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

const fileTooLarge = () =>
  new ApiError("file_too_large", "Images must be 20 MB or smaller.", 413);

/**
 * Reads the request body, giving up as soon as it exceeds `maxBytes`, so a request
 * with a missing or false Content-Length can't make the route buffer an unbounded body.
 */
export async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
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

const badRequest = (message: string) =>
  new ApiError("bad_request", message, 400);

async function readImage(form: MultipartForm): Promise<Uint8Array> {
  const image = form.get(FORM_FIELDS.image);
  if (image == null || typeof image === "string") {
    throw badRequest(`Missing "${FORM_FIELDS.image}" file field.`);
  }
  return new Uint8Array(await image.arrayBuffer());
}

function readMode(form: MultipartForm): EnhanceMode {
  const raw = form.get(FORM_FIELDS.mode);
  if (raw == null || raw === "") return DEFAULT_MODE;
  if (!isEnhanceMode(raw)) {
    throw new ApiError(
      "invalid_mode",
      "Mode must be one of enhance, pro or creative.",
      400,
    );
  }
  return raw;
}

function readRequestId(form: MultipartForm): string {
  const raw = form.get(FORM_FIELDS.requestId);
  if (typeof raw !== "string" || !REQUEST_ID_PATTERN.test(raw)) {
    throw badRequest(
      `A "${FORM_FIELDS.requestId}" field with a UUID is required.`,
    );
  }
  return raw;
}

function readInstallId(request: Request): string {
  const installId = request.headers.get(INSTALL_ID_HEADER);
  if (!installId || !INSTALL_ID_PATTERN.test(installId)) {
    throw new ApiError(
      "missing_install_id",
      `A valid ${INSTALL_ID_HEADER} header is required.`,
      400,
    );
  }
  return installId;
}

const unavailable = () =>
  new ApiError(
    "provider_error",
    "The service is temporarily unavailable. Please try again.",
    503,
  );
const jobNotFound = () =>
  new ApiError(
    "job_not_found",
    "This enhancement job does not exist or has expired.",
    404,
  );

/** Store calls fail closed: without the job store there is no job, and without the limiter no cost guard. */
async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch {
    throw unavailable();
  }
}

const isActive = (job: JobRecord) =>
  job.status === "queued" || job.status === "processing";

function toStatus(job: JobRecord): EnhanceJobStatus {
  return {
    jobId: job.id,
    status: job.status,
    mode: job.mode,
    ...(isActive(job)
      ? { pass: job.passIndex + 1, passes: job.passes.length }
      : {}),
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The job API (enhance-job-api design decisions 1–5): `submit` starts a job and returns its ID;
 * `status` advances the job one step and reports it; `cancel` stops it. Nothing runs between
 * requests, so the same handlers work on the dev server and on EAS Hosting.
 */
export function createEnhanceHandlers({
  getUpscaler,
  getRateLimiter,
  getJobStore,
  log = (event) => console.info(JSON.stringify(event)),
  now = Date.now,
  newId = () => crypto.randomUUID(),
  cancelLockWaitMs = 2000,
}: EnhanceHandlerDeps) {
  const logEnd = (job: JobRecord) =>
    log({
      event: "enhance",
      outcome:
        job.status === "done"
          ? "ok"
          : job.status === "cancelled"
            ? "cancelled"
            : (job.error?.code ?? "provider_error"),
      mode: job.mode,
      ms: now() - job.createdAt,
    });

  /** The caller's job, or `job_not_found` for a missing, expired or other installation's job. */
  async function ownJob(
    request: Request,
    jobId: string | undefined,
  ): Promise<JobRecord> {
    const installId = readInstallId(request);
    if (!jobId) throw jobNotFound();
    const job = await guarded(() => getJobStore().get(jobId));
    if (!job || job.installId !== installId) throw jobNotFound();
    return job;
  }

  const fail = (err: unknown) =>
    errorResponse(err instanceof ApiError ? err : providerError());

  return {
    /** POST /api/enhance */
    async submit(request: Request): Promise<Response> {
      const started = now();
      let mode: EnhanceMode | undefined;
      try {
        const installId = readInstallId(request);
        const maxBodyBytes = LIMITS.maxUploadBytes + MULTIPART_SLACK_BYTES;
        // Cheap early rejection when the client declares its size; the bounded read below covers the rest.
        if (Number(request.headers.get("content-length")) > maxBodyBytes)
          throw fileTooLarge();
        const rawBody = await readBodyWithLimit(request, maxBodyBytes);

        let form: MultipartForm;
        try {
          const contentType = request.headers.get("content-type") ?? "";
          form = (await new Response(rawBody as BodyInit, {
            headers: { "content-type": contentType },
          }).formData()) as unknown as MultipartForm;
        } catch {
          throw badRequest("Expected a multipart/form-data body.");
        }

        mode = readMode(form);
        const requestId = readRequestId(form);
        const bytes = await readImage(form);
        const image = validateImage(bytes);
        if (!image.ok) {
          throw new ApiError(
            image.code,
            image.message,
            STATUS_BY_CODE[image.code] ?? 400,
          );
        }

        const jobs = getJobStore();
        const created = (jobId: string) =>
          Response.json({ jobId } satisfies EnhanceJobCreated, { status: 202 });
        // A resubmission (the app lost the first response) gets the same job, without another charge.
        const existing = await guarded(() =>
          jobs.findRequest(installId, requestId),
        );
        if (existing) return created(existing);

        const limit = await guarded(() => getRateLimiter().check(installId));
        if (!limit.allowed) {
          throw new ApiError(
            "rate_limited",
            "You've reached today's enhancement limit.",
            429,
            limit.retryAt,
          );
        }

        const id = newId();
        const createdAt = now();
        const winner = await guarded(() =>
          jobs.claimRequest(installId, requestId, id, createdAt),
        );
        if (winner !== id) return created(winner);

        let job: JobRecord;
        try {
          const upscaler = getUpscaler();
          const first = await upscaler.start(
            {
              image: new Blob([bytes as BlobPart], { type: image.contentType }),
              width: image.width,
              height: image.height,
              mode,
            },
            createdAt,
          );
          job = {
            id,
            installId,
            mode,
            createdAt,
            status: "queued",
            passIndex: 0,
            ...first,
          };
          try {
            await jobs.put(job);
          } catch {
            await upscaler.cancel(job);
            throw unavailable();
          }
        } catch (err) {
          // No job was created; let a retry with the same request ID start over.
          await jobs.releaseRequest(installId, requestId).catch(() => {});
          throw err;
        }
        return created(job.id);
      } catch (err) {
        const apiError = err instanceof ApiError ? err : providerError();
        log({
          event: "enhance",
          outcome: apiError.code,
          mode,
          ms: now() - started,
        });
        return errorResponse(apiError);
      }
    },

    /** GET /api/enhance/{jobId}: advances the job one step, then reports it. */
    async status(
      request: Request,
      jobId: string | undefined,
    ): Promise<Response> {
      try {
        let job = await ownJob(request, jobId);
        const jobs = getJobStore();
        // Another check already advancing this job answers for both; report the stored state.
        if (isActive(job) && (await guarded(() => jobs.lock(job.id)))) {
          try {
            job = (await guarded(() => jobs.get(job.id))) ?? job;
            if (isActive(job)) {
              const next = await getUpscaler().advance(job, now());
              // Most polls change nothing; skip the write then.
              if (JSON.stringify(next) !== JSON.stringify(job)) {
                await guarded(() => jobs.put(next));
                if (!isActive(next)) logEnd(next);
                job = next;
              }
            }
          } finally {
            await jobs.unlock(job.id).catch(() => {});
          }
        }
        return Response.json(toStatus(job));
      } catch (err) {
        return fail(err);
      }
    },

    /** DELETE /api/enhance/{jobId}: cancels the job and its queued provider work. */
    async cancel(
      request: Request,
      jobId: string | undefined,
    ): Promise<Response> {
      try {
        let job = await ownJob(request, jobId);
        if (!isActive(job)) return Response.json(toStatus(job));
        const jobs = getJobStore();
        // Wait briefly for a concurrent status check, so it can't queue another pass after the cancel.
        const deadline = now() + cancelLockWaitMs;
        let locked = await guarded(() => jobs.lock(job.id));
        while (!locked && now() < deadline) {
          await sleep(100);
          locked = await guarded(() => jobs.lock(job.id));
        }
        try {
          job = (await guarded(() => jobs.get(job.id))) ?? job;
          if (isActive(job)) {
            await getUpscaler().cancel(job);
            job = { ...job, status: "cancelled" };
            await guarded(() => jobs.put(job));
            logEnd(job);
          }
        } finally {
          if (locked) await jobs.unlock(job.id).catch(() => {});
        }
        return Response.json(toStatus(job));
      } catch (err) {
        return fail(err);
      }
    },
  };
}
