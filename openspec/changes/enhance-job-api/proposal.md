# Proposal

## Why

Switching apps during an enhancement loses the result (reported 2026-10-07). `POST /api/enhance` holds one HTTP request open for the whole enhancement, up to 120 s and two provider passes. Android drops that request when the app goes to the background. Since `extreme-zoom-100x`, the server treats the disconnect as a cancel and cancels the fal job, so the user pays and gets nothing. The backend is also about to move to EAS Hosting, where a request can't keep working after its client leaves. Enhancement needs to be a job that the server tracks and the app can come back to.

## What Changes

- **BREAKING (app ↔ service contract):** `POST /api/enhance` no longer returns the enhanced image. It validates the upload, applies the rate limit, uploads the image to fal, queues the first pass and returns a **job ID** within a few seconds.
- **New job endpoints:**
  - `GET /api/enhance/{jobId}` returns the job's state: queued, processing, done (download URL and size), failed (error code), cancelled or expired. Each call also moves the job along: it starts the second pass when the first one finishes, and enforces the timeout.
  - `DELETE /api/enhance/{jobId}` cancels the job and its queued fal work.
- **Jobs survive the app:** going to the background or losing the connection no longer cancels anything. The fal job keeps running, and the result is waiting when the app polls again. Only an explicit cancel (the Cancel button, or leaving the result screen) or a timeout stops provider work.
- **Idempotent submit:** the app sends a client-generated request ID with each submit. If a submit's response is lost (for example, the app went to the background mid-upload), resending it returns the same job instead of starting, and charging for, a second one.
- **Timeout per pass:** each provider pass gets up to 120 s from when it's queued, instead of 120 s for the whole HTTP request. Time the app spends in the background, with no one polling, doesn't count against the job.
- **App:**
  - The result screen polls the job every couple of seconds, pauses while the app is in the background, and polls immediately on return.
  - The progress state shows "Queued" or "Enhancing", and "Finishing" during a second pass.
- **Job records** live in the store the rate limiter already uses (Upstash Redis, in memory during development) and expire after an hour, like fal's stored images. They hold job metadata and fal's result URL, never image data.
- Unchanged: validation, the 128 px and 4 MP limits, modes and models, two-pass upscaling, the 16 MP output cap, per-device rate limiting (counted once per job, at submit), structured error codes and log lines without image data.
- Out of scope:
  - Resuming a job after Android kills the app process (the session is in memory).
  - Push notifications when a job finishes.
  - fal webhooks: they need a public URL, which the LAN dev server doesn't have. Polling works in both places.

## Capabilities

### New Capabilities
<!-- None. Jobs are how the existing enhancement service and review flow behave. -->

### Modified Capabilities
- `image-enhancement`:
  - "Enhancement request" becomes a job submission that returns a job ID.
  - "Structured errors" moves the slow-provider timeout to job state.
  - "Abandoned requests stop provider work" becomes explicit cancellation plus timeout; a disconnect no longer cancels.
  - New requirements: job status and result, job ownership and expiry, and idempotent submission.
- `enhanced-photo-review`:
  - "Automatic enhancement after capture" polls the job, and Cancel cancels it on the service.
  - A new requirement covers enhancement surviving a switch to another app and back.

## Impact

- **Server:**
  - `src/app/api/enhance+api.ts` becomes `src/app/api/enhance/index+api.ts` (POST), plus the new `src/app/api/enhance/[id]+api.ts` (GET, DELETE).
  - `src/server/enhanceHandler.ts` is split into submit, status and cancel handlers.
  - A new job store sits next to `src/server/rateLimit.ts` (Upstash and memory variants).
  - `src/server/upscaler/fal.ts` moves from `subscribe` to `queue.submit` / `status` / `result` / `cancel`, with the pass plan stored on the job.
- **Shared contract:** `src/shared/enhance.ts` gets new response types (job created, job status) and the job path.
- **App:**
  - `src/enhance/client.ts` gets submit, poll and cancel calls.
  - `src/enhance/runner.ts` gets a polling loop driven by `AppState`, keeping the existing stale-response guards.
  - `src/state/session.ts` gains progress phases.
  - `src/app/result.tsx` shows the progress label.
- **Compatibility:** app builds that call the old synchronous `POST` stop working once the server is updated. That's acceptable: there are only development builds, and the app is JavaScript-only, so they update together (no new native build needed).
- **Docs:** `docs/backend.md` (API, curl example, job lifecycle and expiry) and `docs/follow-ups.md` (the "Enhancement is cancelled when switching apps" fix).
- **Dependencies:** none new; the fal queue API and `@upstash/redis` are already installed.
- **Cost:** unchanged per job. A small number of extra Redis commands per poll, about one every 2 s while the result screen is open.
