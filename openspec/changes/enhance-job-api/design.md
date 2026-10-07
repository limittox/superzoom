# Design

## Context

See proposal.md (Why). The relevant state of the code:

- **`createEnhanceHandler` (`src/server/enhanceHandler.ts`)** does everything inside one `POST`: it validates, applies the rate limit, then `await`s `upscaler.upscale()`. The fal upscaler (`src/server/upscaler/fal.ts`) uses `client.subscribe()` for each pass and chains pass 2 onto pass 1's output URL. An `AbortController` linked to `request.signal` and a 120 s timer cancels the queued fal job (`queue.cancel`) on abort.
- **The app** (`src/enhance/client.ts`, `runner.ts`) does a single `fetch` with an `AbortSignal`, then downloads the result. `runner.cancel()` aborts it, and so does leaving the result screen.
- **fal's queue API** (`@fal-ai/client` 1.10): `queue.submit()` returns a `request_id` right away. `queue.status()` reports `IN_QUEUE` / `IN_PROGRESS` / `COMPLETED`, `queue.result()` returns the output (and throws if the job failed), and `queue.cancel()` drops it. `submit` accepts `startTimeout` (seconds before fal gives up on a job that hasn't started) and `storageSettings`.
- **EAS Hosting** runs API routes as short-lived request handlers. Work after the response (`runTask`/`waitUntil`) is only meant for brief follow-ups, not a 120 s, two-pass job. fal webhooks need a publicly reachable URL, which the LAN dev server isn't.
- **Upstash Redis** already backs the rate limiter. In development without Upstash, a memory store is used.
- **Expo Router dev server:** each `+api.ts` file is bundled on its own. Module-level state in one route isn't visible to another route.

## Goals / Non-Goals

**Goals:**
- Identical behavior on the LAN dev server and on EAS Hosting, with no public callback URL and no background work after a response.
- At most one provider job per pass and one rate-limit charge per job, even with repeated submits or overlapping polls.
- Keep the provider-agnostic seam (`Upscaler`), and keep `MODEL_TABLE`, `planForModel` and `planPasses` as they are.

**Non-Goals:**
- Server push (webhooks, SSE, push notifications) and resuming after the app process dies (see proposal).
- Queue positions or ETAs in the UI. The phase label is enough for now.

## Decisions

### 1. Poll-driven job orchestration
Each `GET /api/enhance/{id}` **advances** the job before answering:

- **Active pass `IN_QUEUE` or `IN_PROGRESS`:** if the pass was queued more than 120 s ago, `queue.cancel` it and mark the job `failed: timeout`. Otherwise report `queued` or `processing`.
- **Active pass `COMPLETED`:** call `queue.result`. If passes remain, `queue.submit` the next pass on this pass's output URL, record its `request_id` and `queuedAt`, and report `processing` with the pass number. If it was the last pass, mark the job `done` with the URL and size (from fal, or the planned size).
- **`queue.result` throws** (the model failed): mark the job `failed: provider_error`, and log the redacted error in development as today.

`POST` does only the first step: upload to fal storage, then `queue.submit` pass 1 with `startTimeout: 120`. That way fal itself drops a job that never starts, even if nobody polls.

- *Why:* nothing runs between requests, so it works on any serverless host and on the dev server. The job advances whenever the app looks, and the app looking is exactly when the result matters.
- *Trade-off:* while the app is in the background, a two-pass job pauses between passes until the next poll. The user gets the result a pass-length later, but it isn't lost. That's acceptable.
- *Alternatives:*
  - fal webhooks: no public URL in development, and they'd need signature checks.
  - `runTask`/`waitUntil` to finish the job after the response: not reliable for two minutes of work on EAS Hosting.
  - Keeping the single request alive with an Android foreground service or background fetch: platform-specific and fragile, and it doesn't help when the network drops.

### 2. Job records in the existing store
`JobStore` has `get`, `put`, `claimRequest` and `lock`, with Upstash and memory implementations next to the rate limiter's store.

- **The record**, `job:{id}` as JSON, holds:
  - the job: `id`, `installId`, `mode`, `createdAt`, the planned `passes` and output size;
  - the active pass: `passIndex`, `falRequestId`, `passQueuedAt`, and `sourceUrl` (fal's URL of the uploaded input or the last pass's output);
  - the outcome: `status`, plus `result` or `error`.

  Records have a 1 h TTL, the same as fal's object expiry. A record holds fal URLs and metadata only, never image bytes (spec: No image retention by the service).
- **The idempotency key**, `jobreq:{installId}:{clientRequestId}`, maps to the job ID, with a 1 h TTL.
- **Job IDs** are `crypto.randomUUID()`. Ownership is enforced on every read and cancel: if the record's `installId` doesn't match the header, the service answers `job_not_found`, the same as a missing job.
- **In development**, the memory job store, and the rate limiter's memory store, live on `globalThis`, so the submit route and the job route share them.
- *Alternative:* encode the job state in a signed token the app sends back. That avoids storage, but cancellation and idempotency both need server-side state anyway.

### 3. One change at a time per job
Overlapping requests (a pause-and-resume race, two screens, or a cancel during a status check) could otherwise queue pass 2 twice or resurrect a cancelled job.
- **The lock:** every change to an active job happens under `job:{id}:lock`, taken with `SET NX PX 60000` and an owner token. It's released with a compare-and-delete script, so an expired lock that someone else has since taken is never released by the old holder.
- **Bounded fal calls:** each fal call in an advance gives up after 15 s, so an advance always ends inside the lock. A slow result fetch is retried on the next poll.
- **Polls without the lock** answer from the stored record without advancing.
- **Cancel:** `DELETE` first sets `job:{id}:cancel`, then waits for the lock (at most its lifetime) and cancels. A status check holding the lock checks the flag before and after asking fal. If set, it cancels whatever pass is active, including one it just queued, and saves the job as cancelled.
- **Failed saves:** if saving a job with a newly queued pass fails, that pass is cancelled, because its handle would otherwise be lost.

### 4. Submit order and idempotency
`POST` runs in this order:
1. Validate the install ID, client request ID (a UUID), body, mode and image.
2. Look up `jobreq:` and return the existing job ID if found. A repeat doesn't count against the rate limit.
3. Rate limit.
4. Save the job record (`queued`, no provider handle yet) **before** `claimRequest` (`SET NX`). A resubmission during the upload gets this ID, and its polls must find the job: it reports `queued` until the upload finishes. If another identical submit won the claim, return its job ID; this one has already used a rate-limit slot, which is rare and acceptable.
5. Under the job's lock, upload to fal and submit pass 1.
6. Store the fal request ID (or cancel at once if a cancel arrived meanwhile) and respond `202 { jobId }`.

A job whose submission never finished (for example, the server stopped mid-upload) times out 120 s after creation. A pass's 120 s start when fal accepts it, not before the upload or status check that led to it.

If step 5 fails (`provider_error`, or `image_too_small` from the model's input limits), the error is returned from the `POST` itself, the job is saved as failed for anyone polling it, and the claim is released, so the app's Retry can submit again with the same request ID.

### 5. API shape (`src/shared/enhance.ts`)
- **`POST /api/enhance`** (multipart: `image`, `mode`, `requestId`; header `X-Install-Id`) → `202 { jobId }`, or the existing error JSON.
- **`GET /api/enhance/{jobId}`** → `200 { jobId, status: 'queued' | 'processing' | 'done' | 'failed' | 'cancelled', pass?, passes?, result?: EnhanceSuccess, error?: { code, message } }`, or `404 job_not_found`.
- **`DELETE /api/enhance/{jobId}`** → `200` with the job's final status: `cancelled`, or `done`/`failed` if it had already ended.
- **New error code:** `job_not_found`. The validation and rate-limit codes are unchanged.
- **Routes:** `src/app/api/enhance/index+api.ts` (POST) and `src/app/api/enhance/[id]+api.ts` (GET, DELETE). Dependencies (upscaler, limiter, job store) are built in one shared `src/server/routeDeps.ts`.

### 6. Upscaler seam
`Upscaler` changes from `upscale()` to three calls:
- `start({ image, width, height, mode })` → the pass plan plus the first pass's handle;
- `advance(job)` → the next state;
- `cancel(job)`.

The fal implementation keeps `MODEL_TABLE`, `planForModel` and `planPasses`. `buildInput` and the `[fal] <mode> pass i/n` dev log are unchanged.

### 7. App: submit, poll, pause in the background
`runner.start(mode)` works like this:
- **Submit:** generate a `requestId` and submit. If the submit fails with a network error, the app is in the background or goes there, retry the same `requestId` when it becomes active again, up to 3 times.
- **Poll:** every 2 s while `AppState` is `active`. Stop the timer on `background`/`inactive`, and poll immediately on `active`. The session records the phase:
  - `queued`;
  - `processing` (pass 1 of 1, or pass 1 of 2);
  - `finishing` (pass 2 of 2).
- **Network failures while polling:** keep retrying. Each status check gives up after 15 s. Returning to the foreground restarts the 30 s allowance and replaces a check that stalled while the app was away. After 30 s of foreground time without a successful poll, fail with `network`.
- **Retry:** a network failure keeps the `jobId` and the submission's `requestId` in the session. Retry resumes the job, or resubmits with the same `requestId` (the service returns the job if it created one). It starts a new submission only after a definite outcome: the job is gone (`job_not_found`), failed or was cancelled.
- **`done`:** download the result as today. `failed` maps the error code to the existing messages.
- **`cancel()`:** abort locally, send `DELETE` (fire-and-forget), and drop late results, using the existing request-ID guards in `session.ts`. Leaving the result screen already calls `cancel()`. A job kept after a network failure is cancelled too, when the user leaves, switches to another mode's result or starts another mode.
- **Cancel during upload** (found in device testing): the upload request isn't aborted. The service queues the job even if the app hangs up, so aborting would leave it running with no ID to cancel it. Instead, the app waits for the job ID in the background and then cancels the job.
- *Why 2 s:* about 30 polls for a 60 s job. Cheap in Redis commands and fal status calls, and responsive enough.

### 8. Logging
One JSON line per job when it reaches a final state: `{"event":"enhance","outcome":"ok" | "cancelled" | <code>,"mode","ms"}`, with `ms` measured from `createdAt`. Submit failures log as today. Polls don't log.

### 9. Testing
Jest, with a fake fal queue (`submit`, `status`, `result`, `cancel`) and the memory job store:
- **Submit:** validation, idempotent resubmission (one job, one rate-limit charge) and the claim race.
- **Advance:** a single pass; two passes (pass 2 on pass 1's URL, `submit` called once even with two concurrent polls); the timeout cancels; a provider failure; ownership; expiry.
- **Cancel:** `queue.cancel`, and no pass 2 afterwards.
- **App runner, with fake timers and a fake `AppState`:** polling pauses in the background and resumes immediately on return; a result that finished while away; the submit retry after a backgrounded failure; 30 s of network failure, then Retry resuming the same job; cancel sends `DELETE`; stale results are dropped.

## Risks / Trade-offs

- [A two-pass job stalls between passes while the app is in the background] → the result still arrives once the app polls. The UI says "Finishing" when pass 2 starts after a return.
- [A job nobody polls stays queued on fal] → `startTimeout: 120` makes fal drop jobs that never start. A job that's already running is bounded by the model's own runtime, and the record expires after 1 h.
- [Redis usage grows with polling] → about 3 commands per poll, at 2 s intervals, and only while the result screen is open and the app is in the foreground.
- [Overlapping identical submits use two rate-limit slots] → rare (only with a lost response plus a simultaneous retry). Documented in decision 4.
- [The dev memory store is lost on a dev server restart] → in-flight jobs report `job_not_found`. The app then offers Retry, which submits again.
- [Changing the contract breaks older app bundles] → only development builds exist, and the app is JavaScript-only, so they update together.

## Migration Plan

1. Ship the server and app together: the dev server now, EAS Hosting later.
2. After deploying, run a device check: switch apps during a Pro job at 30x and come back.
3. Rollback: revert the change. The old synchronous route and client come back together.

Upstash needs no data migration, since job keys are new and expire on their own.

## Open Questions

- The 2 s poll interval and the 30 s network grace period can be tuned during device testing without changing the specs.
