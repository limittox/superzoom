# Follow-ups

Open verification and work carried over from archived OpenSpec changes.

## From `add-zoom-camera-mvp` (archived 2026-10-07 with 13 tasks open)

Implemented and working on Android, but not verified:

- **iOS:** build a dev client for iPhone (EAS, needs an Apple Developer account) and repeat the camera, zoom and capture checks on an iPhone with and without a telephoto lens.
- **Backend deployment:** deploy `/api/enhance` to EAS Hosting with `FAL_KEY` and Upstash secrets (`docs/backend.md`), point the app at it with `EXPO_PUBLIC_API_URL`, and run a real upload per mode.
- **Camera permission denied:** the explanation screen and "Open Settings".
- **Zoom and capture:** clamping at minimum and maximum zoom, tap-to-focus, landscape-grip capture orientation, and that a double tap on the shutter takes one photo.
- **Settings:** the chosen mode persists across an app restart.
- **Consent:** declining uploads nothing and the original can still be saved.
- **Result screen:** cancel during enhancement; the before/after divider, shared pinch and pan, and the Creative-mode caveat.
- **Saving:** enhanced, original and both, including photo-library permission denial.
- **Failure paths:** offline, rate limited (`DAILY_LIMIT=1` on a staging deploy), and a slow provider.
- **Device matrix:** fill in `docs/device-test-matrix.md` for iPhone with telephoto, iPhone without, Pixel and Samsung.

## Fixes

- **Enhancement is cancelled when switching apps** (reported 2026-10-07). Leaving the app mid-enhancement drops the request, and the result is lost. Likely cause: Android stops the app's network request in the background, the server sees the disconnect, and since `extreme-zoom-100x` it treats that as a cancel and cancels the fal job. Before that change the job finished on fal, but the app never received the result. Options:
  - Switch `/api/enhance` to a job API (submit returns a job ID; the app polls, or resumes when it comes back), so work survives backgrounding. This is the asynchronous contract design.md listed as the fallback.
  - Keep the request alive in the background with a foreground service or background task (Android-specific, and more fragile).
  - Let the server finish a disconnected job and cache the result briefly for the app to fetch when it returns. This is simpler than a full job API, but means separating "user cancelled" from "app went to background".

## Ideas

- **Sensor-crop zoom (Samsung 2x/10x):** use high-resolution sensor crops instead of digital crops where the phone exposes them. Start by measuring whether hardware zoom past a lens is sharper than the app's own crop.
- **Multi-frame burst capture** (requested 2026-10-07; out of scope for `add-zoom-camera-mvp` and `extreme-zoom-100x`). Capture a short burst at the current zoom, align the frames (hand shake gives sub-pixel offsets), and merge them before upscaling, as in Google's "Handheld Multi-Frame Super-Resolution" (Super Res Zoom). That recovers real detail rather than inventing it, which matters most past the native-pixel limit. Things to work out:
  - **Capture:** whether VisionCamera 5 can deliver a fast burst at full resolution (photo output in a loop, or a frame processor at the preview stream's resolution), or whether RAW (DNG) bursts are reachable on the Samsung.
  - **Alignment and merge:** native code (Kotlin/Swift, or C++ in a frame processor) for speed. Only the cropped region needs merging, which keeps it cheap at high zoom.
  - **Robustness:** moving subjects and large shakes need per-tile rejection to avoid ghosting.
  - **Measure first:** compare a merged 30x/100x crop against a single frame before and after enhancement, to confirm the gain is worth the complexity.
- **Close the quality gap with the native camera** (reported 2026-10-07: Samsung's own 30x looks better than superzoom's enhanced 30x). Likely causes, biggest first:
  - The native app crops the 5x telephoto at full sensor resolution (about 50 MP) past 10x. VisionCamera tops out at 4080×3060 (12.5 MP, pixel-binned), so the native 30x frame has about 4 times more real pixels.
  - It merges several frames.
  - It processes raw sensor data with phone-specific models. Our upscaler gets one compressed JPEG crop.
  - Small own losses: JPEG at quality 95, then 90 for upload.

  Experiments:
  - ~~Check which CameraX extensions the phone exposes.~~ Checked 2026-10-07 (`[camera-extensions]` dev log). The Samsung's Back Quad Camera offers only `bokeh`, `face-retouch` and `night`; Auto and HDR aren't exposed to third-party apps. Night (multi-frame low light) is the only candidate. VisionCamera 5.2.3 can't enable extensions, so it would need native CameraX code, and whether zoom and lens switching work in Night mode is untested. Own multi-frame burst capture looks more promising. Research notes (2026-10-07):
    - Night merges several exposures and "can take several seconds, and the user should hold the phone still". Extensions cover preview and still capture only.
    - Extension sessions can have "a reduced set of camera capabilities (such as limited zoom ratio range…)". Zoom ratio support in Night is only mandatory for devices launching on Android 15 or later, so it had to be queried.
    - **Queried 2026-10-07** (`getExtensionInfo` in `modules/lens-info`, `[extension-info]` dev log; Android 16, SDK 36). All three extensions (night, bokeh, face-retouch) honour `CONTROL_ZOOM_RATIO` with a zoom range of **0.6x–10x**, and their largest JPEG is **4080×3060**, the same as VisionCamera's photos. Night also accepts AF/AE triggers and regions, focus distance, flash, JPEG quality and `EXTENSION_STRENGTH`, but not optical stabilization or `SCALER_CROP_REGION`. The phone doesn't report capture latency. So:
      - Night can zoom and presumably switch lenses up to 10x. Past 10x the app would crop the 10x Night shot itself, as it does now.
      - Night doesn't reach the telephoto's full ~50 MP, so it can't close the biggest part of the gap. What it adds is Samsung's own multi-frame merging (noise and possibly detail), which is worth an A/B test at 10x–30x against a normal capture.
      - Using it needs a native Camera2 `CameraExtensionSession` (or CameraX `ExtensionsManager`) capture path alongside VisionCamera's, and a check of how long a Night capture takes in daylight.
      - Android's extension service is process-wide: overlapping queries (ours and VisionCamera's `useCameraDeviceExtensions`) fail with "Service not registered", so a Night capture path must not run alongside other extension calls.
    - VisionCamera 5.2.3 bundles CameraX 1.7.0-alpha03, including `camera-extensions`, so it's unaffected by Google removing extension support for CameraX ≤ 1.5 from 2026-11-01. Using Night would still need our own native extension session in place of VisionCamera's.
  - Send small crops as lossless PNG.
  - Benchmark our raw crop (before AI) against the native 30x, to separate input quality from model quality.
  - Multi-frame burst capture and the model evaluation below.
- **Evaluate the enhancement models and find better fits** (requested 2026-10-07). Today: Enhance = SeedVR2, Pro = Topaz High Fidelity V2, Creative = Clarity Upscaler (`MODEL_TABLE` in `src/server/upscaler/fal.ts`). Suggested approach:
  - **Test set:** real crops from the phone at several zooms (e.g. 3x, 10x, 30x, 100x) and subjects (text, faces, foliage, buildings, low light), including the original-lens reference where possible (e.g. a 5x lens shot to judge a 1x-plus-crop result).
  - **Candidates:** the current three, the other Topaz models on fal (Topaz lists Recovery V2 for "extreme low-resolution images", which may suit 30x–100x crops, plus Standard V2 and Wonder 3), and other fal upscalers worth checking (search fal's upscaling category). Check each one's per-request factor limit and pricing.
  - **Judge:** blind side-by-side comparisons (fidelity versus invented detail), plus latency and cost per result. Possibly a no-reference quality score as a tiebreaker.
  - **Outcome:** possibly different models per zoom tier (optical, AI zoom, AI-reconstructed) rather than per mode. That's a server-only change to the model table.
- **Telephoto fallback notice:** tell the user when the phone used a wider lens's crop at a telephoto zoom (close or dim subjects), using the EXIF focal length outside development builds.
