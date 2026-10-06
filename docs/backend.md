# Enhancement backend

The app's only server code is one Expo Router API route, [`src/app/api/enhance+api.ts`](../src/app/api/enhance+api.ts), deployed with EAS Hosting (Cloudflare Workers runtime). It receives the cropped photo, runs the selected fal.ai upscaler, and returns a URL to the result. The request/response contract is in [`src/shared/enhance.ts`](../src/shared/enhance.ts). The behaviour is specified in `openspec/changes/add-zoom-camera-mvp/specs/image-enhancement/spec.md`.

## Environment variables

None of these use the `EXPO_PUBLIC_` prefix, so none can end up in the app bundle.

| Variable | Required | Purpose |
|---|---|---|
| `FAL_KEY` | Yes | fal.ai API key ([dashboard → Keys](https://fal.ai/dashboard/keys)). |
| `UPSTASH_REDIS_REST_URL` | Yes in production | Upstash Redis REST URL, used for per-install rate-limit counters. |
| `UPSTASH_REDIS_REST_TOKEN` | Yes in production | Upstash Redis REST token. |
| `DAILY_LIMIT` | No (default `50`) | Enhancements allowed per app install per rolling 24 hours. |

App side: `EXPO_PUBLIC_API_URL` is the origin the app sends requests to (for example `https://superzoom.expo.app`). Leave it unset in development; relative requests then go to the dev server.

## Run locally

1. Create `.env.local` in the repo root (it's git-ignored):

   ```sh
   FAL_KEY=your-fal-key
   # Optional locally. Without these, development falls back to an in-memory
   # limiter that resets when the dev server restarts.
   UPSTASH_REDIS_REST_URL=https://...upstash.io
   UPSTASH_REDIS_REST_TOKEN=...
   DAILY_LIMIT=50
   ```

2. Start the dev server: `npx expo start`. The route is served at `http://localhost:8081/api/enhance`.

3. Try it with any JPEG or PNG between 64 px per side and 4 MP:

   ```sh
   curl -X POST http://localhost:8081/api/enhance \
     -H "X-Install-Id: 3b241101-e2bb-4255-8caf-4136c566a962" \
     -F "image=@crop.jpg;type=image/jpeg" \
     -F "mode=enhance"
   ```

   A successful response is `{"url":"https://...","width":4000,"height":3000,"mode":"enhance"}`. Errors are `{"error":{"code":"...","message":"..."}}`; see `ERROR_CODES` in `src/shared/enhance.ts`.

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

Logs, requests and crashes appear on the EAS Hosting dashboard. Each request logs one JSON line: `{"event":"enhance","outcome":"ok"|<error code>,"mode":...,"ms":...}`. Image data and keys are never logged.

## Models and cost

The mapping lives in `MODEL_TABLE` in [`src/server/upscaler/fal.ts`](../src/server/upscaler/fal.ts), so it can change without an app release.

| Mode | fal endpoint | Approx. cost per request at the 16 MP cap |
|---|---|---|
| `enhance` | `fal-ai/seedvr/upscale/image` | $0.016 |
| `pro` | `fal-ai/topaz/upscale/image` (High Fidelity V2) | $0.08 |
| `creative` | `fal-ai/clarity-upscaler` | $0.48 |

Prices are fal's listed prices as of 2026-10-07. Uploaded inputs and generated outputs are set to expire from fal's storage after one hour.

## Limits enforced by the route

- `X-Install-Id` header required (8–128 characters, letters, digits and dashes).
- JPEG or PNG only, ≤ 20 MB, ≥ 64 px on the short side, ≤ 4 MP. The app downscales larger crops before upload.
- Upscale factor between 2x and 4x, output ≤ 16 MP.
- 120-second provider timeout.
- If the rate limiter's store is unreachable, the route rejects requests (503) rather than skipping the limit.
