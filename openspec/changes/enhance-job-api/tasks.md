# Tasks

## 1. Shared contract

- [x] 1.1 Add the job types to `src/shared/enhance.ts`: `EnhanceJobCreated { jobId }`, `EnhanceJobStatus` (`queued` | `processing` | `done` | `failed` | `cancelled`, with `pass`, `passes`, `result?: EnhanceSuccess`, `error?`), the `requestId` form field, `jobPath(id)`, and the `job_not_found` error code with an app message in `src/enhance/messages.ts`; verify `npm run typecheck` passes and the existing `failureMessage` test (a message for every code) covers `job_not_found`

## 2. Job store

- [x] 2.1 Add `JobStore` (`get`, `put`, `claimRequest`, `releaseRequest`, `lock`/`unlock`) with an Upstash implementation (JSON at `job:{id}`, `jobreq:{installId}:{requestId}` via `SET NX`, lock via `SET NX PX 15000`, 1 h TTLs) and a memory implementation kept on `globalThis` for development; also move the rate limiter's dev memory store onto `globalThis`. Verify unit tests cover put/get round trip, TTL expiry (memory store with an injected clock), `claimRequest` returning the existing job ID on the second claim, and a held lock refusing a second holder

## 3. fal job operations

- [x] 3.1 Change the `Upscaler` seam to `start` / `advance` / `cancel` (design decision 6) and implement it in `src/server/upscaler/fal.ts` with `storage.upload`, `queue.submit` (with `startTimeout: 120` and the 1 h storage settings), `queue.status`, `queue.result` and `queue.cancel`, keeping `MODEL_TABLE`, `planForModel`, `planPasses`, the `[fal]` dev log and the redacted provider-error log; verify fake-queue tests cover single-pass Enhance, two-pass Pro and Creative (pass 2 submitted on pass 1's output URL), `IN_QUEUE` / `IN_PROGRESS` reporting, the 120 s per-pass timeout calling `queue.cancel`, `queue.result` throwing → `provider_error`, and the narrow-input `image_too_small` rejection before any upload

## 4. Job routes

- [x] 4.1 Replace `createEnhanceHandler` with a submit handler in `src/server/enhanceHandler.ts` (design decision 4 order: validate, idempotency lookup, rate limit, create and claim, upload and submit pass 1, `202 { jobId }`); verify handler tests cover a valid submit, a missing or invalid `requestId` → `bad_request`, an idempotent resubmission returning the same job with one rate-limit charge, an upload failure marking the job failed and releasing the claim, and the existing validation and rate-limit cases
- [x] 4.2 Add status and cancel handlers (`GET` advances the job under the lock and returns its status; `DELETE` cancels under the lock), with ownership checks (`job_not_found` for another installation or a missing job) and one final-state log line per job; verify tests cover done, two-pass progress with `pass`/`passes`, two concurrent polls submitting pass 2 once, cancel stopping further passes, cancel after done returning `done`, another installation's job and an expired job → 404 `job_not_found`
- [x] 4.3 Move the route to `src/app/api/enhance/index+api.ts` (POST) and add `src/app/api/enhance/[id]+api.ts` (GET, DELETE), building dependencies in `src/server/routeDeps.ts`; update `enhanceRoute.test.ts` to call both routes end to end with a fake fal queue; verify the tests pass, and in the dev server `curl` a POST then GETs until `done`
- [x] 4.4 Update `docs/backend.md`: the job API (endpoints, status values, `requestId`, `job_not_found`), the poll-driven lifecycle, the per-pass timeout, expiry and the curl example; verify the documented curl sequence works against the dev server

## 5. App

- [x] 5.1 Replace `requestEnhancement` in `src/enhance/client.ts` with `submitJob` (multipart with `requestId`), `getJob` and `cancelJob`, mapping network failures and error bodies as today; verify unit tests with a mocked `fetch` cover a 202 submit, each status, `job_not_found`, a network error, and `cancelJob` never throwing
- [x] 5.2 Rework `src/enhance/runner.ts` around the job (design decision 7): submit with a `requestId` (retried on return to foreground after a backgrounded network failure, up to 3 times), poll every 2 s while `AppState` is active, pause in the background, poll at once on return, fail with `network` after 30 s without a successful poll while keeping the `jobId` so Retry resumes it, download on `done`, and `cancel()` sending `DELETE`; add the phase (`submitting` / `queued` / `processing` / `finishing`) and `jobId` to `src/state/session.ts`; verify tests with fake timers and a fake `AppState` cover background pause and immediate resume, a result finished while away, the submit retry, the 30 s network failure then Retry resuming the same job, cancel sending `DELETE` and dropping a late result, and stale results being discarded
- [x] 5.3 Show the phase on the result screen's progress state ("Queued", "Enhancing", "Finishing") in `src/app/result.tsx`; verify `npm run typecheck` and `npm run lint` pass and a rendered or unit test checks the label for each phase

## 6. Device verification

- [ ] 6.1 On the Samsung with the dev server: start a 30x Pro enhancement, switch to another app for about a minute, and come back; verify the result appears without a new upload (the server log shows one job and one `[fal] pro pass 1/2` and `2/2`) and record it in `docs/device-test-matrix.md`
- [ ] 6.2 Lock the phone during a 100x Creative enhancement, unlock it after 2 minutes, and verify the job finishes (pass 2 starts after unlocking) or reports `timeout`; tap Cancel during another enhancement and leave the result screen during a third, and verify the server logs `cancelled` and starts no further pass; record the results in `docs/device-test-matrix.md`
- [ ] 6.3 Mark the "Enhancement is cancelled when switching apps" fix done in `docs/follow-ups.md`, and run `npm test`, `npm run lint` and `npm run typecheck`; verify all pass

## Workflow follow-up

- Archive this change with `/opsx:archive` once its tasks are complete.
