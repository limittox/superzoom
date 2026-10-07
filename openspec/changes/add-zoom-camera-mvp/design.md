# Design

## Context

The repository is empty apart from a README and the OpenSpec scaffold, so every decision below is new. Constraints that shape the approach:

- Both iOS and Android, built with Expo. VisionCamera is a native module, so the app needs a **development build**; Expo Go cannot be used.
- Cloud enhancement is acceptable (see proposal.md, Why). The provider key must not ship in the app.
- Phone lens setups vary a lot. iOS exposes virtual multi-lens devices with well-defined switch-over points. Android support for logical multi-camera (automatic switch to telephoto) depends on the manufacturer.
- Requirements are in `specs/zoom-capture`, `specs/image-enhancement` and `specs/enhanced-photo-review`. This document covers only how to meet them.

## Goals / Non-Goals

**Goals:**
- Feed the upscaler native sensor pixels, never pixels already interpolated by hardware digital zoom.
- Keep the backend tiny and stateless apart from rate-limit counters, deployable from this same repo.
- Isolate the zoom and crop math and the upscale-factor math as pure functions, so they can be unit-tested without a device.

**Non-Goals:**
- Panning the framing off-center while digitally zoomed. The digital crop is always centered in the MVP.
- Landscape UI. The UI is locked to portrait, but photos taken with the phone held sideways are still oriented correctly.
- Asynchronous job handling, push notifications or background uploads.
- Strong device attestation (App Attest or Play Integrity) for rate limiting.

## Decisions

### 1. One Expo project with Expo Router API routes for the backend
The app and the backend live in one Expo Router project. The backend is a single API route (`src/app/api/enhance+api.ts`), deployed with EAS Hosting.
- *Why:* one repo, one language, one deploy tool, shared TypeScript types for the request and response contract.
- *Alternatives:* a separate Cloudflare Worker or Vercel function (more moving parts, but portable if EAS Hosting limits get in the way, because the route handler is a standard `Request → Response` function). A monorepo with workspaces (more than one route needs).
- *Consequence:* the route runs on a Workers-style runtime with no native image library such as `sharp`. That's why the app downscales before upload and the server only validates (see `specs/image-enhancement`, Input pixel limit). The server reads image dimensions from the file header with a pure-JS parser.

### 2. Camera library: react-native-vision-camera v5
VisionCamera is the standard high-performance camera for React Native, with virtual multi-lens devices, high-resolution photo output and Reanimated-driven zoom.
- *Alternatives:* `expo-camera` (simpler, but lacks multi-lens device selection and fine-grained format control, both central to this app).
- *Decision (task 1.1, 2026-10-07):* **v5.2.3**. v5 left beta with 5.0.0 and has had more than 20 stable releases since (5.0.x to 5.2.x, last published 2026-08-20). Its peers are `react-native-nitro-modules` and `react-native-nitro-image` with no version pins. It needs the New Architecture, which Expo SDK 57 uses by default. The v5 package does **not** ship an Expo config plugin (no `app.plugin.js`; the v4 plugin was dropped), so camera permissions are declared directly in `app.json` (`ios.infoPlist.NSCameraUsageDescription`, `android.permissions`). A dev build is still required. The camera code is wrapped in `useZoomCamera`, so a change of camera library stays local.
- *v5 API facts this design depends on:* `CameraDevice.zoomLensSwitchFactors` (iOS: the device's real `virtualDeviceSwitchOverVideoZoomFactors`; **always empty on Android in 5.2.3**), `physicalDevices[].type`, `minZoom`/`maxZoom`, the `zoom` prop accepting a Reanimated `SharedValue`, `usePhotoOutput({ targetResolution, qualityPrioritization })`, and `Photo.toImageAsync()`, which applies orientation and returns a `react-native-nitro-image` `Image`.

### 3. Hybrid zoom: hardware zoom up to the optical cap, preview transform beyond it

> **Superseded for Android** by change `android-telephoto-lenses`: on Android, lens zoom factors now come from the `lens-info` native module (sensor size and focal length per lens), so `C` is the longest telephoto lens instead of `1`. The rear camera is chosen by `pickBackCamera()` rather than VisionCamera's default picker.
Total zoom `Z` (as shown to the user, 1x = main wide lens) is split in two:
- **Hardware zoom** `H = min(Z, C)`, where `C` is the *optical cap*: the native factor of the longest lens. It's applied through the camera's zoom property, so the virtual device switches lenses by itself.
- **Digital factor** `D = Z / H`. Above 1, it's applied only to the preview, as a Reanimated `scale` transform on a clipped container around the camera view.

At capture, the photo is taken at hardware zoom `H` and center-cropped by `D` (decision 5). Hardware zoom never goes past `C`, so the photo holds only native pixels (spec: Zoom beyond the optical range).

- *Display mapping:* on iOS, a virtual device that includes the ultra-wide lens uses a zoom value of 1 for the ultra-wide. Display zoom is `deviceZoom / neutralZoom`, where `neutralZoom` is the first lens switch factor when an ultra-wide is present, and 1 otherwise. On Android (CameraX), a zoom ratio of 1 is already the main lens, so `neutralZoom = 1`.
- *Finding `C`:* on iOS, the lenses' native device-zoom values are `[minZoom, ...zoomLensSwitchFactors]`, taken straight from AVFoundation, and `C` is the last of them. This replaces the field-of-view estimate planned earlier, since v5 exposes no field of view and the switch factors are exact. On Android, v5 always returns empty switch factors, and a focal-length ratio misjudges telephoto lenses because their sensors are smaller. So `C = 1` (the main lens), and the ultra-wide stays reachable when `minZoom < 1`. This keeps the native-pixel guarantee at the cost of telephoto reach on Android (see Risks). Display factors within 10% of a common value (0.5, 2, 3, 5, 10) are snapped to it for labels and presets.
- *Maximum zoom:* `Zmax = C × sqrt(visiblePhotoPixels / 1 MP)`, where `visiblePhotoPixels` is the photo area remaining after matching the preview's aspect ratio (decision 5). This enforces the 1 MP floor in the spec.
- *Gesture:* pinch updates a Reanimated shared value on the UI thread. Both `H` (passed as the camera's animated zoom prop) and the preview `scale` are derived from it, so there's no React re-render per frame.
- *Alternative considered:* letting hardware digital zoom go all the way up and capturing that. Simpler, but the image signal processor upscales before the AI sees it, which is exactly what this app avoids.

### 4. Photo format and capture settings
Pick the highest-resolution photo format the device offers, with quality prioritized over speed. Keep the default image signal processor pipeline (no RAW in the MVP). The capture result is a JPEG or HEIC file on disk with orientation metadata.
- *Alternative:* RAW/DNG, which v5 supports. Deferred to phase 2, where burst merging needs it.

### 5. Crop math as a pure function
`computeCrop(uprightW, uprightH, screenLongOverShort, D)` returns the crop rectangle in upright image coordinates:
1. The photo is first turned into an upright image with `Photo.toImageAsync()`, which applies the capture orientation. Coordinates then match what the user saw, with no EXIF guesswork.
2. Take the region the preview shows in `cover` mode: the largest centered rectangle with the screen's long-to-short ratio, with its long side along the image's long side. This holds for both grips. The UI is locked to portrait, and the sensor's long axis follows the screen's long axis, so a landscape-grip photo's visible region is the same rectangle rotated with it.
3. Center-crop that region by `1/D` per side.

Cropping uses the nitro-image `Image.cropAsync`, and the result is saved with `saveToTemporaryFileAsync('jpg', 0.95)`, without resizing. This replaces `expo-image-manipulator`: nitro-image is already a required VisionCamera peer and works on the orientation-corrected image directly. The same function feeds `Zmax` (decision 3). Unit tests cover portrait, landscape, `D = 1` and `D` at the maximum.

### 6. Upload copy: downscale on the device to at most 4 MP
Before upload, if the crop is over 4 MP, the app scales a copy down to `sqrt(4 MP / pixels)` per side (nitro-image `resizeAsync`, then JPEG 0.9). The full-resolution crop stays local for the comparison and saving. Upload is `multipart/form-data` with fields `image` and `mode`, and an `X-Install-Id` header.

### 7. fal.ai models and upscale-factor selection
Mode to model mapping, kept in one server-side table:

| Mode | fal endpoint (confirmed 2026-10-07) | Key input | Listed price | Cost at 16 MP output |
|---|---|---|---|---|
| `enhance` | `fal-ai/seedvr/upscale/image` (SeedVR2) | `upscale_mode: 'factor'`, `upscale_factor` (float, 1–10) | $0.001 / MP | ≈ $0.016 |
| `pro` | `fal-ai/topaz/upscale/image` | `model: 'High Fidelity V2'`, `upscale_factor` (float, 1–4), `face_enhancement_creativity: 0` | $0.08 per image up to 24 MP | $0.08 |
| `creative` | `fal-ai/clarity-upscaler` | `upscale_factor` (float, 1–4), default creativity 0.35 / resemblance 0.6 | $0.03 / MP | ≈ $0.48 |

All three accept a fractional `upscale_factor`, so no rounding to supported factors is needed in practice (the round-down path stays for future models). All three return `image.url`; only Clarity reliably returns `width`/`height`, so the route falls back to the planned output size. Uploads and outputs are given a 1-hour expiry with fal's `lifecycle` / `storageSettings` options (`expiresIn: '1h'`), which addresses the CDN retention risk below.

- Upscale factor: `f = clamp(sqrt(16 MP / inputPixels), 2, 4)`. If a model accepts only certain factors, round **down** to the nearest supported one, never below 2. Inputs are at most 4 MP, so 2x always fits within 16 MP.
- The server uploads the image to fal storage, calls the model with `fal.subscribe` and a 120 s timeout, and returns `{ url, width, height, mode }`. The URL points at fal's CDN, so the 16 MP result doesn't pass through our route. The app downloads it to a local file for comparison and saving.
- *Alternatives:* Replicate (per-second GPU billing, larger community catalog; keep as a fallback by implementing the model table behind a small `Upscaler` interface). Stability or Topaz direct APIs (more accounts to manage).
- *Alternative for the contract:* an asynchronous job API (submit, then poll). It would handle long Pro and Creative runs and app backgrounding better, but it's more surface than the MVP needs. Revisit if timeouts show up in practice.

### 8. Rate limiting with an install ID and Upstash Redis
The app creates a random UUID on first launch and keeps it in `expo-secure-store`. The server keeps a sliding-window counter per ID in Upstash Redis, using its REST client, which works on edge runtimes. The limit comes from the `DAILY_LIMIT` env var (default 50). Requests without an ID are rejected.
- *Why:* a cost guard with almost no extra infrastructure.
- *Alternative:* IP-based limits (unfair behind carrier NAT), or user accounts (out of scope).

### 9. App structure and state
- Routes: `src/app/index.tsx` (camera), `src/app/result.tsx` (comparison and save), `src/app/api/enhance+api.ts` (server).
- A small zustand store holds the current capture session: original crop URI, upload URI, results by mode, and request state. Mode choice and the cloud-consent flag are saved with AsyncStorage.
- Comparison view: two `expo-image` layers in one Reanimated-transformed container (so pinch and pan move both together). The top layer is clipped by an animated width driven by the divider gesture.
- Cancel: abort the `fetch` with an `AbortController` and ignore late responses using a request ID kept in the store.
- Error codes from the server map to user messages in one table shared with the server's types.

### 10. Configuration
- Server: `FAL_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `DAILY_LIMIT`, all as EAS Hosting secrets. None use the `EXPO_PUBLIC_` prefix, so none can reach the bundle.
- App: `EXPO_PUBLIC_API_URL` (the hosting URL, or the local dev server URL).

### 11. Testing approach
- Jest (`jest-expo`) unit tests for the zoom, crop and upscale-factor functions and the error-code mapping.
- Route handler tests with the fal and Redis clients mocked: validation errors, rate limit, timeout, success.
- Manual device test checklist: an iPhone with a telephoto lens, an iPhone without one, a Pixel, and a Samsung. Covers lens switching, the beyond-optical indicator, crop accuracy (compare against the preview screenshot), orientation, and saving.

## Risks / Trade-offs

- [Android devices may not expose the telephoto lens through a logical multi-camera] → `C` falls back to the main lens, so zoom past 1x is digital on those devices. It's still correct, just less optical reach. Log the detected lens setup to help tune this later.
- [VisionCamera v5 may be too new for the current Expo SDK] → version gate in task 1. The camera is wrapped behind `useZoomCamera`, so moving to v4 stays local.
- [Model fidelity: AI may invent detail, especially in Creative mode at high zoom] → AI-enhanced labeling and the before/after comparison are required by the spec. The original is always saveable.
- [Long Pro or Creative runs could hit hosting or mobile network timeouts] → 120 s server timeout and a clear `timeout` error with retry. The async job API is the planned fallback.
- [Install IDs can be spoofed to get around the rate limit] → acceptable for the MVP. Add App Attest or Play Integrity before a public launch.
- [Enhanced images live on fal's CDN for some retention period] → the disclosure covers cloud processing. Check fal's retention policy and, if possible, request the shortest retention or delete results after download.
- [Costs vary by model and price changes] → the model table lives on the server, so models can change without an app release. The output cap bounds per-request cost.
- [Android telephoto lenses are not used in the MVP, because VisionCamera 5.2.3 reports no switch factors there] → zoom is still correct, just digital past 1x. Watch upstream (the `zoomLensSwitchFactors` TODO in VisionCamera's Android `CameraInfo` extension) and set `C` from it once it's filled in.

## Migration Plan

Greenfield, so nothing to migrate. Deploy order: create the fal and Upstash accounts and set the EAS Hosting secrets → deploy the API route → build the iOS and Android dev builds pointing at it. Rollback means redeploying the previous hosting version. The model table can be changed on the server without an app release.

## Open Questions

- ~~Exact fal endpoint IDs and parameter names.~~ Resolved in task 3.2; see the table in decision 7.
- Creative mode costs about 30 times as much as Enhance at the 16 MP cap (≈ $0.48 vs ≈ $0.016). Consider a lower output cap or a separate daily limit for Creative once real usage is known. This doesn't change the contract.
- Final default for `DAILY_LIMIT`, set once real per-request costs are known.
