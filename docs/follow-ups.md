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

- ~~**Enhancement is cancelled when switching apps**~~ (reported 2026-10-07). Fixed 2026-10-08 by `enhance-job-api`: enhancement is a job on the service that the app polls, pauses in the background and resumes on return, so switching apps or locking the phone no longer loses the result (`docs/device-test-matrix.md`). Not covered: resuming after Android kills the app process, since the session is in memory.

## Ideas

- **Sensor-crop zoom (Samsung 2x/10x):** use high-resolution sensor crops instead of digital crops where the phone exposes them. Start by measuring whether hardware zoom past a lens is sharper than the app's own crop.
- ~~**Multi-frame burst capture**~~ (requested 2026-10-07). Measured 2026-10-08 and shelved: an 8-photo burst took about 11 s, and after SeedVR2 the merged 30x crop looked no better than one photo, because the phone already merges frames for each photo. Results, tooling and notes for a rerun are in `docs/capture-spike.md`.
- **Close the quality gap with the native camera** (reported 2026-10-07: Samsung's own 30x looks better than superzoom's enhanced 30x). **Spike closed 2026-10-09** (`docs/capture-spike.md`): on this Samsung the biggest cause (50 MP readout) isn't reachable, and neither merging nor pre-upload cleanup beat one photo plus SeedVR2. Rerun the `[sensor-modes]` check on other phones. Likely causes, biggest first:
  - The native app crops the 5x telephoto at full sensor resolution (about 50 MP) past 10x. VisionCamera tops out at 4080×3060 (12.5 MP, pixel-binned), so the native 30x frame has about 4 times more real pixels. **Not reachable by apps on this phone** (checked 2026-10-08, see below).
  - It merges several frames.
  - It processes raw sensor data with phone-specific models. Our upscaler gets one compressed JPEG crop.
  - Small own losses: JPEG at quality 95, then 90 for upload.

  Experiments:
  - ~~Check whether apps can reach the full, unbinned sensor resolution.~~ Checked 2026-10-08 (`getSensorModes` in `modules/lens-info`, `[sensor-modes]` dev log; Android 16). **No.**
    - No lens has the `ULTRA_HIGH_RESOLUTION_SENSOR` capability, and capture requests can't set `SENSOR_PIXEL_MODE`.
    - The 0.6x, 1x and 5x lenses (ids 2, 5, 7) report 2×2 binning. Their "maximum resolution" pixel array is still 4080×3060, and their maximum-resolution stream map offers only 1920×1080.
    - No camera lists high-resolution (slow-capture) sizes. The largest JPEG, YUV and RAW output is 4080×3060 (4000×3000 on the 3x lens, id 6, which isn't binned).
    - So Samsung keeps the 50 MP mode for its own app. What apps do get is `RAW_SENSOR` at 4080×3060 on every lens: unprocessed, but binned.
  - ~~Check which CameraX extensions the phone exposes.~~ Checked 2026-10-07 (`[camera-extensions]` dev log). The Samsung's Back Quad Camera offers only `bokeh`, `face-retouch` and `night`; Auto and HDR aren't exposed to third-party apps. Night (multi-frame low light) is the only candidate. VisionCamera 5.2.3 can't enable extensions, so it would need native CameraX code, and whether zoom and lens switching work in Night mode is untested. Own multi-frame burst capture looks more promising. Research notes (2026-10-07):
    - Night merges several exposures and "can take several seconds, and the user should hold the phone still". Extensions cover preview and still capture only.
    - Extension sessions can have "a reduced set of camera capabilities (such as limited zoom ratio range…)". Zoom ratio support in Night is only mandatory for devices launching on Android 15 or later, so it had to be queried.
    - **Queried 2026-10-07** (`getExtensionInfo` in `modules/lens-info`, `[extension-info]` dev log; Android 16, SDK 36). All three extensions (night, bokeh, face-retouch) honour `CONTROL_ZOOM_RATIO` with a zoom range of **0.6x–10x**, and their largest JPEG is **4080×3060**, the same as VisionCamera's photos. Night also accepts AF/AE triggers and regions, focus distance, flash, JPEG quality and `EXTENSION_STRENGTH`, but not optical stabilization or `SCALER_CROP_REGION`. The phone doesn't report capture latency. So:
      - Night can zoom and presumably switch lenses up to 10x. Past 10x the app would crop the 10x Night shot itself, as it does now.
      - Night doesn't reach the telephoto's full ~50 MP, so it can't close the biggest part of the gap. What it adds is Samsung's own multi-frame merging (noise and possibly detail), which is worth an A/B test at 10x–30x against a normal capture.
      - Using it needs a native Camera2 `CameraExtensionSession` (or CameraX `ExtensionsManager`) capture path alongside VisionCamera's, and a check of how long a Night capture takes in daylight.
      - Android's extension service is process-wide: when our query ran alongside VisionCamera's `useCameraDeviceExtensions`, our client's release unbound the service under CameraX and its lookup failed with "Service not registered". The dev log no longer calls `getExtensionInfo`; the function stays for a future Night capture path, which must not overlap other extension calls.
    - VisionCamera 5.2.3 bundles CameraX 1.7.0-alpha03, including `camera-extensions`, so it's unaffected by Google removing extension support for CameraX ≤ 1.5 from 2026-11-01. Using Night would still need our own native extension session in place of VisionCamera's.
  - ~~**Night A/B**~~ Tested 2026-10-08/09: worse than a normal photo at 30x after SeedVR2; at 100x slightly crisper but it misread more letters. Not worth a capture path that blacks out the preview for about 3 s. Details in `docs/capture-spike.md`.
  - ~~Denoise or soften small crops before upload.~~ Tested 2026-10-09: denoising smears texture and leads SeedVR2 to invent letters; softening changes nothing (`docs/capture-spike.md`).
  - Send small crops as lossless PNG.
  - Benchmark our raw crop (before AI) against the native 30x, to separate input quality from model quality.
  - Multi-frame burst capture and the model evaluation below.
- ~~**Evaluate the enhancement models and find better fits**~~ (requested 2026-10-07). Done 2026-10-08 (`docs/model-evaluation.md`): Enhance now uses SeedVR2 with `noise_scale` 0.3, Pro Topaz Precision Low Resolution V2, and Creative Topaz Generative Recovery V2. No model recovers real detail at 100x; more real input pixels (multi-frame burst, full-resolution sensor crops) are the next lever. Worth re-running the evaluation when fal adds upscalers.
- **Telephoto fallback notice:** tell the user when the phone used a wider lens's crop at a telephoto zoom (close or dim subjects), using the EXIF focal length outside development builds.
