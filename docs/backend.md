# Enhancement backend

The app's only server code is two Expo Router API routes, deployed with EAS Hosting (Cloudflare Workers runtime):

- [`src/app/api/enhance/index+api.ts`](../src/app/api/enhance/index+api.ts) (`POST`) receives the cropped photo and starts an enhancement job.
- [`src/app/api/enhance/[id]+api.ts`](../src/app/api/enhance/[id]+api.ts) (`GET`, `DELETE`) reports the job, moving it along, or cancels it.

The handlers live in [`src/server/enhanceHandler.ts`](../src/server/enhanceHandler.ts), and the contract is in [`src/shared/enhance.ts`](../src/shared/enhance.ts). The behavior is specified in `openspec/specs/image-enhancement/spec.md`.

## Environment variables

None of these use the `EXPO_PUBLIC_` prefix, so none can end up in the app bundle.

| Variable | Required | Purpose |
|---|---|---|
| `FAL_KEY` | Yes | fal.ai API key ([dashboard → Keys](https://fal.ai/dashboard/keys)). |
| `UPSTASH_REDIS_REST_URL` | Yes in production | Upstash Redis REST URL, used for per-install rate-limit counters and job records. |
| `UPSTASH_REDIS_REST_TOKEN` | Yes in production | Upstash Redis REST token. |
| `DAILY_LIMIT` | No (default `50`) | Enhancements allowed per app install per rolling 24 hours. |
| `SAVE_UPLOADS_DIR` | No, development only | Folder where the dev server keeps a copy of each accepted upload, for building model-evaluation test sets (for example `eval/crops`). Ignored outside development, so production never stores images. |

App side: `EXPO_PUBLIC_API_URL` is the origin the app sends requests to (for example `https://superzoom.expo.app`). Leave it unset in development; relative requests then go to the dev server.

## Run locally

1. Create `.env.local` in the repo root (it's git-ignored):

   ```sh
   FAL_KEY=your-fal-key
   # Optional locally. Without these, development falls back to an in-memory
   # limiter and job store that reset when the dev server restarts.
   UPSTASH_REDIS_REST_URL=https://...upstash.io
   UPSTASH_REDIS_REST_TOKEN=...
   DAILY_LIMIT=50
   ```

2. Start the dev server: `npx expo start`. The routes are served at `http://localhost:8081/api/enhance`. Restart it after adding new route files; without Watchman it may not pick them up.

3. Try it with any JPEG or PNG between 128 px per side and 4 MP. Submit a job with a fresh UUID as `requestId`:

   ```sh
   curl -X POST http://localhost:8081/api/enhance \
     -H "X-Install-Id: 3b241101-e2bb-4255-8caf-4136c566a962" \
     -F "image=@crop.jpg;type=image/jpeg" \
     -F "mode=enhance" \
     -F "requestId=0f8fad5b-d9cb-469f-a165-70867728950e"
   ```

   It answers `202 {"jobId":"..."}` within a few seconds. Then ask for the job every couple of seconds until it's `done`:

   ```sh
   curl http://localhost:8081/api/enhance/<jobId> \
     -H "X-Install-Id: 3b241101-e2bb-4255-8caf-4136c566a962"
   ```

   `{"jobId":"...","status":"processing","mode":"enhance","pass":1,"passes":1}` becomes `{"jobId":"...","status":"done","mode":"enhance","result":{"url":"https://...","width":3200,"height":3200,"mode":"enhance"}}`. Errors are `{"error":{"code":"...","message":"..."}}`; see `ERROR_CODES` in `src/shared/enhance.ts`.

## Test the Upstash scripts

The unit tests run the job store and rate limiter against in-memory versions. To run the same tests against the real Upstash scripts (unique `test-…` keys that expire within the hour), with the two Upstash variables set:

```sh
UPSTASH_INTEGRATION=1 npx jest -c jest.integration.config.js
```

Run it after changing a script in `src/server/jobStore.ts` or `src/server/rateLimit.ts`.

## Deploy to EAS Hosting

1. Log in and link the project (first time only): `npx eas-cli@latest login`, then `npx eas-cli@latest init`.
2. Create the server variables for the `production` environment. Use `secret` visibility so they can't be read back:

   ```sh
   npx eas-cli@latest env:set --environment production --name FAL_KEY --value "..." --visibility secret
   npx eas-cli@latest env:set --environment production --name UPSTASH_REDIS_REST_URL --value "..." --visibility secret
   npx eas-cli@latest env:set --environment production --name UPSTASH_REDIS_REST_TOKEN --value "..." --visibility secret
   npx eas-cli@latest env:set --environment production --name DAILY_LIMIT --value "50" --visibility plaintext
   ```

3. Export and deploy:

   ```sh
   npx expo export --platform web
   npx eas-cli@latest deploy --environment production
   ```

   The first deploy asks for a preview subdomain and prints a preview URL. Promote it with `npx eas-cli@latest deploy --prod --environment production`.

4. Point the app at it: set `EXPO_PUBLIC_API_URL` to the production URL (`eas env:set ... --visibility plaintext` for EAS builds, or in `.env.local` for local builds).

Logs, requests and crashes appear on the EAS Hosting dashboard. Each job logs one JSON line when it ends, and each rejected submission logs one when it's rejected: `{"event":"enhance","outcome":"ok"|"cancelled"|<error code>,"mode":...,"ms":...}`. For a job, `ms` runs from submission to the end. Status checks aren't logged, and image data and keys never are.

## Job API

| Request | Answer |
|---|---|
| `POST /api/enhance` (multipart `image`, `mode`, `requestId`; header `X-Install-Id`) | `202 {"jobId"}`, or a validation or rate-limit error. A resubmission with the same install ID and `requestId` within an hour returns the same job and isn't counted again. |
| `GET /api/enhance/{jobId}` (header `X-Install-Id`) | `200` with `status`: `queued`, `processing` (with `pass` and `passes`), `done` (with `result`: `url`, `width`, `height`, `mode`), `failed` (with `error`) or `cancelled`. |
| `DELETE /api/enhance/{jobId}` (header `X-Install-Id`) | `200` with the job's status: `cancelled`, or `done`/`failed` if it had already ended. |
| `DELETE /api/enhance?requestId=…` (header `X-Install-Id`) | Cancels a submission whose job ID the app never received (its response was lost): the job if it exists, otherwise a marker so a submission still in flight with that `requestId` doesn't start one (it gets `404 job_not_found`). |

An unknown or expired job, or another install's, gets `404 job_not_found`.

**How jobs run.**
- **Nothing runs between requests.** Each `GET` moves the job along: it checks the active pass on fal, starts the second pass when the first one finishes, finishes the job, or times out a pass. That's why it works the same on the dev server and on EAS Hosting, with no webhooks.
- **While nobody asks (the app in the background), a two-pass job waits between passes** and continues on the next `GET`.
- **Overlapping requests don't duplicate a pass or undo a cancel.** Every change to an active job happens under a per-job lock with an owner token. The lock lasts 60 s, longer than any advance, whose fal calls each give up after 15 s (a slow submit is aborted, never abandoned). Other checks report the stored state. A cancel that arrives during a check is recorded as a flag that the check acts on before saving.
- **The upload runs outside the lock.** The submission then saves the job only if it's still waiting for its first pass; if it was cancelled or timed out meanwhile, the new pass is cancelled instead.
- **A dropped connection or the app going to the background doesn't cancel anything.** Only `DELETE` and timeouts stop fal work.
- **Each request makes at most 10 outgoing calls,** fal and Upstash together, because that's all EAS Hosting allows ("Too many subrequests by single Worker invocation" past it; measured 2026-10-10, not documented by Expo). So every store step is one Upstash call: the multi-step ones (create a job with its request ID, lock and read a job with its cancel flag, save and unlock, commit a submission, the rate-limit check) are Lua scripts, and nothing waits on a lock by polling it. A submit makes 7 calls, a status check at most 5, a cancel 3. `src/server/__tests__/callBudget.test.ts` fails if any path goes over 10; locally there's no limit, so only that test catches it.
- **Records expire one hour after submission,** the same as fal's stored files. Job records (`job:{id}` in Upstash, in memory during development) hold the job's state and fal URLs, never image data.

## Models and cost

The mapping lives in `MODEL_TABLE` in [`src/server/upscaler/fal.ts`](../src/server/upscaler/fal.ts), so it can change without an app release.

| Mode | fal endpoint | Max factor per request | Approx. cost at the 16 MP cap | Approx. cost for a 100x crop (128 × 275 upload) |
|---|---|---|---|---|
| `enhance` | `fal-ai/seedvr/upscale/image` (SeedVR2, `noise_scale` 0.3) | 10x | $0.016 | $0.002 (one pass, ≈1.7 MP out) |
| `pro` | `topaz/upscale/image/precision` (Low Resolution V2) | 4x | $0.08 | $0.16 (two passes, ≈3.5 MP out) |
| `creative` | `topaz/upscale/image/generative` (Recovery V2) | 4x | $0.32 | $0.16 (two passes, ≈3.5 MP out) |

Prices are fal's listed prices as of 2026-10-08: SeedVR2 bills per output megapixel, Topaz Precision $0.08 per started 24 MP of output per request, and Topaz Generative $0.08 per started 4 MP per request. The models were chosen in a side-by-side evaluation on real phone crops (`docs/model-evaluation.md`). Uploaded inputs and generated outputs are set to expire from fal's storage after one hour.

**Two-pass upscaling.** The route picks one upscale factor per photo (see limits below). When it exceeds a model's per-request maximum, as with tiny crops from extreme zoom in Pro or Creative, the job runs the model twice: first at its maximum (4x), then at the remainder (for example 2.5x) on the first pass's output. Each pass has its own 120-second timeout. Topaz bills per request (by output size), so Pro and Creative cost about twice as much in that case.

## Limits enforced by the route

- `X-Install-Id` header required (8–128 characters, letters, digits and dashes).
- JPEG or PNG only, ≤ 20 MB, ≥ 128 px on the short side (SeedVR2's minimum), ≤ 4 MP. The app downscales larger crops before upload and enlarges crops under 128 px on the short side (extreme zoom) to 128 px.
- Upscale factor between 2x and 10x, output ≤ 16 MP (two requests for models capped at 4x). Enhance inputs under 256 px on the short side are capped to a 1920 × 1080 output, because SeedVR2 rejects larger outputs for them.
- 120-second timeout per provider pass, from when it's queued on fal (fal also drops a pass that hasn't started by then, via `startTimeout`). Time the app spends in the background between passes doesn't count.
- If the rate limiter's or job store's Redis is unreachable, the routes reject requests (503) rather than skipping the limit.
