# Tasks

## 1. Project setup

- [x] 1.1 Check VisionCamera v5's release status and compatibility with the current Expo SDK (and New Architecture), pick v5 or v4, and record the choice and reason in design.md decision 2; verify by inspecting the published package how its native permissions are configured under Expo (config plugin or `app.json` keys)
- [x] 1.2 Create the Expo Router TypeScript project at the repo root (keeping `openspec/` and README), enable `"output": "server"` for API routes, and verify `npx expo start` serves the default route
- [x] 1.3 Install `expo-dev-client`, the chosen `react-native-vision-camera`, `react-native-nitro-modules`, `react-native-nitro-image`, `react-native-gesture-handler`, `react-native-reanimated`, `expo-image`, `expo-media-library`, `expo-secure-store`, `@react-native-async-storage/async-storage` and `zustand` with `npx expo install`; verify `npx expo-doctor` reports no issues
- [x] 1.4 Configure `app.json` plugins and permission strings (camera; iOS photo-library add; Android media) and lock the orientation to portrait; verify `npx expo prebuild --clean` generates an `AndroidManifest.xml` with those permissions, and that `npx expo config --type introspect` shows them in the iOS `Info.plist` (iOS prebuild doesn't run on Windows)
- [x] 1.5 Set up Jest with `jest-expo`, ESLint and a `typecheck` script; verify `npm test`, `npm run lint` and `npm run typecheck` all pass on the empty project
- [ ] 1.6 Create EAS dev-build profiles for iOS and Android and verify a dev build installs and launches on one physical device of each platform

## 2. Shared contract

- [x] 2.1 Define shared types in `src/shared/enhance.ts`: the `EnhanceMode` union, the request fields, the success response `{ url, width, height, mode }`, and the error codes (`invalid_mode`, `unsupported_format`, `file_too_large`, `image_too_small`, `image_too_large`, `rate_limited`, `provider_error`, `timeout`, `missing_install_id`); verify the app and server both import them and `npm run typecheck` passes
- [x] 2.2 Implement `chooseUpscaleFactor(width, height, supportedFactors?)` per design decision 7 with unit tests for the 1000×1000, 2000×1500 and 2000×2000 cases plus round-down to supported factors; verify `npm test` passes and no output exceeds 16 MP

## 3. Enhancement service

- [x] 3.1 Implement input validation in `src/server/validate.ts` (magic-byte JPEG/PNG check, 20 MB limit, pure-JS header dimension read, 64 px min side, 4 MP max) with unit tests covering each error code from the `image-enhancement` spec; verify `npm test` passes
- [x] 3.2 Implement the `Upscaler` interface and fal implementation in `src/server/upscaler/` with the mode → endpoint table, confirming each endpoint ID and its upscale-factor parameter against fal docs (record findings in design.md Open Questions); verify with a unit test using a mocked `@fal-ai/client` that each mode calls the right endpoint with the chosen factor
- [x] 3.3 Implement the Upstash-backed per-install sliding-window rate limiter in `src/server/rateLimit.ts` with `DAILY_LIMIT` (default 50); verify unit tests with a mocked Redis client show request 51 in 24 h is rejected with a retry time
- [x] 3.4 Implement `src/app/api/enhance+api.ts` (multipart parsing, install-ID check, validation, rate limit, fal upload and subscribe with 120 s timeout, structured errors, no image logging); verify route tests with mocked fal and Redis cover success, `invalid_mode`, default mode, `rate_limited`, `provider_error` and `timeout`, and that no response or log line contains `FAL_KEY`
- [ ] 3.5 Write `docs/backend.md` covering env vars, local run and EAS Hosting deploy; deploy to EAS Hosting with secrets set, and verify a real `curl` upload of a 1 MP JPEG returns a working result URL for each mode

## 4. Camera and zoom

- [ ] 4.1 Implement camera permission handling and the denied-state screen with an "Open Settings" button; verify on a device that denying shows the explanation and the button opens app settings
- [x] 4.2 Implement lens analysis in `src/camera/lenses.ts` (lens zooms from `minZoom` + `zoomLensSwitchFactors` on iOS, `C = 1` on Android, snapping to common values, optical cap `C`, display-zoom mapping via `neutralZoom`) with unit tests using fixture device lists for a triple-camera iPhone, a single-lens phone and an Android without logical tele; verify `npm test` passes
- [x] 4.3 Implement `computeCrop` and `computeMaxZoom` in `src/camera/crop.ts` per design decision 5, with unit tests for portrait, landscape orientations, `D = 1`, and `D` at max (crop ≥ 1 MP); verify `npm test` passes
- [ ] 4.4 Build the `useZoomCamera` hook and the camera screen: multi-lens rear device, highest-res photo format with quality prioritization, and one zoom shared value driving both hardware zoom (≤ `C`) and the preview scale transform; verify on an iPhone with telephoto that zooming 1x→10x switches lenses without a black frame and the preview keeps scaling past 3x
- [ ] 4.5 Add pinch-to-zoom, lens presets (one per lens plus one beyond-optical), animated preset transitions, the zoom readout with optical vs beyond-optical styling, and tap-to-focus; verify on device that pinch is smooth, clamps at min and max, presets land on the right lens, and the indicator changes past `C`
- [ ] 4.6 Implement capture: guarded shutter (one capture in flight), feedback animation, photo at `H`, then upright via `Photo.toImageAsync()` and crop via nitro-image `cropAsync` without resizing; verify on iOS and Android that an 8x capture matches the preview framing (compare against a screenshot) in both portrait and landscape grips, and that a double tap yields one photo

## 5. Enhancement flow and review

- [x] 5.1 Implement the install ID (`expo-secure-store`), persisted mode and consent settings, and the zustand capture-session store; verify unit tests show mode and consent persist through a store reload and the install ID is stable
- [ ] 5.2 Add the mode picker on the camera and result screens with one-line descriptions (Enhance default); verify on device that a changed mode survives an app restart
- [ ] 5.3 Add the first-run cloud-processing consent sheet; verify that declining uploads nothing (no request in network logs) and still allows saving the original
- [x] 5.4 Implement upload preparation (≤ 4 MP JPEG copy, original kept) and the API client with `AbortController` cancel, stale-response guarding and error-code → message mapping; verify unit tests cover downscale dimensions for 12 MP and 1.5 MP crops, cancel ignoring a late result, and every error code having a message
- [ ] 5.5 Build the result screen: original shown immediately, progress and cancel while enhancing, download of the result to a local file, and retry or switch-mode actions; verify on device against the deployed backend that a capture shows progress, then the result, and that switching to Pro re-runs on the same crop
- [ ] 5.6 Build the before/after comparison (draggable divider, shared pinch and pan) and the AI-enhanced label with mode and the Creative caveat; verify on device that the divider reveals each side, zooming keeps both images aligned, and the Creative label shows the caveat
- [ ] 5.7 Implement save (enhanced, original or both) with photo-library permission handling and confirmation, plus back-to-camera with a discard confirmation that keeps the previous zoom; verify on iOS and Android that saved images appear in the gallery at full resolution and that denial shows the settings prompt

## 6. Integration checks

- [ ] 6.1 Run the full flow (permission → zoom past optical → capture → consent → Enhance → compare → switch to Pro and Creative → save both) on an iPhone with telephoto, an iPhone without one, a Pixel and a Samsung, record results in `docs/device-test-matrix.md`, and verify every `zoom-capture`, `image-enhancement` and `enhanced-photo-review` scenario is checked off or has a filed follow-up
- [ ] 6.2 Run offline, rate-limited (set `DAILY_LIMIT=1` on a staging deploy) and slow-provider checks end to end; verify the app shows the correct message and retry for each and that the original stays saveable
- [x] 6.3 Confirm no secrets are in the app bundle by searching an exported production bundle for `FAL_KEY` and Upstash token values; verify the search finds nothing

## Workflow follow-up

- Archive the change with `/opsx:archive` after review and the device test matrix are complete.
- After archiving, confirm the three capabilities appear under `openspec/specs/`.
