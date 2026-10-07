# Device test matrix

Results for task 6.1 of `openspec/changes/add-zoom-camera-mvp`. Fill in one column per device with ✅, ❌ (link the follow-up issue) or n/a. Generated from the spec scenarios, so every scenario has a row.

Devices: **A** = iPhone with telephoto, **B** = iPhone without telephoto, **C** = Pixel, **D** = Samsung.

| Capability | Requirement | Scenario | A | B | C | D | Notes |
|---|---|---|---|---|---|---|---|
| zoom-capture | Camera permission | First launch grants permission |  |  |  |  |  |
| zoom-capture | Camera permission | Permission denied |  |  |  |  |  |
| zoom-capture | Live rear-camera preview | Multi-lens device |  |  |  |  |  |
| zoom-capture | Live rear-camera preview | Single-lens device |  |  |  |  |  |
| zoom-capture | Pinch-to-zoom | Pinch out |  |  |  |  |  |
| zoom-capture | Pinch-to-zoom | Pinch at the limit |  |  |  |  |  |
| zoom-capture | Zoom presets | Tap telephoto preset |  |  |  |  |  |
| zoom-capture | Seamless lens switching | Zooming past the telephoto threshold |  |  |  |  |  |
| zoom-capture | Zoom beyond the optical range | Zoom past optical |  |  |  |  |  |
| zoom-capture | Maximum zoom bound by native pixels | Maximum reached |  |  |  |  |  |
| zoom-capture | Zoom level indicator | Entering the beyond-optical range |  |  |  |  |  |
| zoom-capture | Tap to focus | Tap a subject |  |  |  |  |  |
| zoom-capture | Capture crops to the framed region | Capture at digital zoom |  |  |  |  |  |
| zoom-capture | Capture crops to the framed region | Capture within the optical range |  |  |  |  |  |
| zoom-capture | Capture crops to the framed region | Device rotated |  |  |  |  |  |
| zoom-capture | Shutter feedback | Double tap on shutter |  |  |  |  |  |
| image-enhancement | Enhancement request | Successful enhancement |  |  |  |  |  |
| image-enhancement | Enhancement request | Mode omitted |  |  |  |  |  |
| image-enhancement | Enhancement modes | Pro mode |  |  |  |  |  |
| image-enhancement | Enhancement modes | Unknown mode |  |  |  |  |  |
| image-enhancement | Output size limit | Small crop |  |  |  |  |  |
| image-enhancement | Output size limit | Medium crop |  |  |  |  |  |
| image-enhancement | Input pixel limit | Large crop |  |  |  |  |  |
| image-enhancement | Input validation | Unsupported format |  |  |  |  |  |
| image-enhancement | Input validation | Oversized upload |  |  |  |  |  |
| image-enhancement | Input validation | Image too small |  |  |  |  |  |
| image-enhancement | Credentials stay server-side | Inspecting the app |  |  |  |  |  |
| image-enhancement | Per-device rate limit | Limit exceeded |  |  |  |  |  |
| image-enhancement | Structured errors | Provider failure |  |  |  |  |  |
| image-enhancement | Structured errors | Slow provider |  |  |  |  |  |
| image-enhancement | No image retention by the service | After a request completes |  |  |  |  |  |
| enhanced-photo-review | Mode selection | Default mode |  |  |  |  |  |
| enhanced-photo-review | Mode selection | Mode remembered |  |  |  |  |  |
| enhanced-photo-review | Cloud processing disclosure | First capture |  |  |  |  |  |
| enhanced-photo-review | Cloud processing disclosure | Consent declined |  |  |  |  |  |
| enhanced-photo-review | Automatic enhancement after capture | Waiting for the result |  |  |  |  |  |
| enhanced-photo-review | Automatic enhancement after capture | Cancel |  |  |  |  |  |
| enhanced-photo-review | Upload preparation | Large crop |  |  |  |  |  |
| enhanced-photo-review | Upload preparation | Small crop |  |  |  |  |  |
| enhanced-photo-review | Before/after comparison | Drag the divider |  |  |  |  |  |
| enhanced-photo-review | Before/after comparison | Zoom into the comparison |  |  |  |  |  |
| enhanced-photo-review | AI-enhanced labeling | Creative result |  |  |  |  |  |
| enhanced-photo-review | Retry and switch mode | Try another mode |  |  |  |  |  |
| enhanced-photo-review | Retry and switch mode | Network failure |  |  |  |  |  |
| enhanced-photo-review | Retry and switch mode | Rate limited |  |  |  |  |  |
| enhanced-photo-review | Save to gallery | Save both |  |  |  |  |  |
| enhanced-photo-review | Save to gallery | Gallery permission denied |  |  |  |  |  |
| enhanced-photo-review | Return to camera | Leave without saving |  |  |  |  |  |

## Device details

| | Model | OS version | Lenses detected (zoom presets shown) | Max zoom shown |
|---|---|---|---|---|
| A |  |  |  |  |
| B |  |  |  |  |
| C |  |  |  |  |
| D |  |  |  |  |

## Capturing a phone's camera list

Development builds log every camera the camera library can see when the camera screen opens (`src/camera/useCameraDiagnostics.ts`; release builds skip it). With the dev server running (`npx expo start`), open the app and look for a line starting with `[camera-diagnostics]` in the dev server output. It lists each camera's ID, type, zoom range, focal length, largest photo size, and the physical lenses behind it, plus which camera the app selected (`"selected": true`).

Example (Samsung with 0.6x/1x/3x/5x lenses, 2026-10-07): `id 0` "Back Quad Camera", virtual, zoom 0.6–10, physical lenses `2`/`5`/`6`/`7` at 2.2/6.3/7.9/18.6 mm. The app should select `id 0`.

## Android telephoto lenses (change `android-telephoto-lenses`)

Device: user's Samsung (Back Quad Camera, lenses 0.6x/1x/3x/5x), Android dev build `377003c5`, 2026-10-07.

| Check | Result |
|---|---|
| Rear camera selected | ✅ `id 0` "Back Quad Camera" (`"selected": true`) |
| Lens factors from `lens-info` | ✅ 0.60 → 0.6x, 1.00 → 1x, 2.74 → 3x, 5.06 → 5x (`[lens-factors]` log) |
| Presets | ✅ 0.6x, 1x, 3x, 5x shown (after fixing the React Compiler caching bug in `useLensFactors`) |
| Capture at 3x | ✅ EXIF 7.9 mm → 3x lens |
| Capture at 5x, distant subject, good light | ✅ EXIF 18.6 mm → 5x lens |
| Capture at 5x, closer/dimmer scene | ⚠️ EXIF 7.9 mm → the phone used a crop of the 3x lens; flagged by the dev lens check. Expected Samsung behaviour (telephoto minimum focus distance / low light), not an app bug |
| Zoom indicator optical up to 5x, AI zoom above | ✅ confirmed by the user |
| Pinch to ~5x | ⚠️ a pinch ending just below 5x (e.g. 4.96x, shown as "5x") stays on the 3x lens. Fixed with lens detents: a pinch ending within 6% of a lens settles exactly on it |
| 5x lens choice by scene | ✅ far subject in good light → 18.6 mm (5x lens) at 5x, 5.7x and 10x, whether reached by preset or pinch. Close or dim subjects → 7.9 mm (3x lens crop) even at exactly 5.00x hardware zoom: the phone's own choice, flagged by the dev lens check |
| 10x capture (max preset): 5x hardware zoom + center crop | ✅ EXIF 18.6 mm → 5x lens with 2x digital crop; saved crop matched the preview framing (confirmed by the user) |
| Forced `null` lens geometry → 1x cap, capture works | ✅ covered by unit tests (`useLensFactors`, `analyzeLenses` fallback); on-device toggle skipped at the user's request (2026-10-07) |

## Extreme zoom to 100x (change `extreme-zoom-100x`)

Device: user's Samsung (Back Quad Camera, Android 16), Android dev builds `b61858ad` and `00fdc96e`, 2026-10-07. Later checks on the same build with the dev server, 2026-10-07.

| Check | Result |
|---|---|
| 30x capture, Enhance | ✅ 21.2 s, one SeedVR2 pass at 8.66x (`[fal]` log) |
| 30x capture, Pro | ✅ 41.9 s, two Topaz passes (4x, then 2.16x) |
| 30x capture, Creative | ✅ 47.7 s, two Clarity passes |
| Cancel in the app during enhancement | ✅ before task 4.4, a cancelled job kept running on fal and queued later requests, so two Creative runs timed out at 120 s. After 4.4, leaving the result screen during a 100x Pro run logged `cancelled` after 7.5 s with no second pass; a cancelled Enhance retry logged `cancelled` after 10.9 s |
| Presets 10x/30x/100x, tier badges at 5x and ≈13.9x, brace hint | ✅ presets 0.6/1/3/5/10/30/100; optical → AI ZOOM → AI-RECONSTRUCTED as expected; the brace hint appears in the reconstructed tier (confirmed by the user) |
| 50x framing against the preview, with preview stabilization | ✅ 50.04x on the 5x lens (18.6 mm): the saved original matched a screenshot of the preview, so preview stabilization stays |
| 100x, Enhance | ❌ → ✅ first attempts failed with fal 422: SeedVR2 needs 128 px per side (95×204 crop), then at least 256 px when the output exceeds 1080p (128×275 upload at 10x). Fixed in task 4.5: tiny crops are enlarged to 128 px for upload, and Enhance's factor is capped to a 1920×1080 output for inputs under 256 px. Retest: 100x on the 5x lens → one SeedVR2 pass at 6.98x, 5.0 s, labeled "AI-reconstructed (Enhance)"; 50x → 4.71x, 6.1 s |
| 100x, Pro | ✅ 32.7 s on the 128×275 upload (45.7 s on the 95×204 upload before 4.5), two Topaz passes (4x, then 2.5x), labeled "AI-reconstructed (Pro)" |
| 100x, Creative | ✅ 37.1 s on the 128×275 upload (17.4 s on the 95×204 upload before 4.5), two Clarity passes (4x, then 2.5x), labeled "AI-reconstructed (Creative)" |
| 100x lens choice | ⚠️ one 100x capture of a closer or dimmer subject used the 3x lens (7.9 mm); far, well-lit subjects used the 5x lens. The phone's choice, as with the telephoto change |
| Night extension capabilities (`getExtensionInfo`) | ✅ night, bokeh and face-retouch honour `CONTROL_ZOOM_RATIO` over 0.6x–10x, largest JPEG 4080×3060; no capture latency reported. See the quality-gap item in `docs/follow-ups.md` |
