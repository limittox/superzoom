# Design

## Context

See proposal.md for motivation. Facts from the device test on 2026-10-07 (VisionCamera 5.2.3, user's Samsung with 0.6x/1x/3x/5x lenses), from the development-only camera list in `src/camera/useCameraDiagnostics.ts`:

| Camera | VisionCamera report |
|---|---|
| `id 0` "Back Quad Camera" | `type: quad`, `isVirtualDevice: true`, zoom 0.6–10, `zoomLensSwitchFactors: []`, focal length 6.3 mm. Physical lenses `2`, `5`, `6`, `7`, all `type: unknown`, focal lengths 2.2, 6.3, 7.9 and 18.6 mm |
| `id 2` | standalone ultra-wide, zoom 1–8 |

- VisionCamera's Android `zoomLensSwitchFactors` is a stub that always returns `[]`, and its `deviceType` returns `unknown` for physical lenses. Both have TODOs upstream.
- Focal-length ratios misjudge telephoto lenses: 18.6 / 6.3 ≈ 2.95, but that lens is the 5x. The sensor size has to be included.
- VisionCamera's Android device `id` is the Camera2 camera ID, so native code can look up the same camera.
- Captured JPEGs keep the HAL's EXIF data: VisionCamera writes the JPEG bytes and only adds orientation, location and timestamp.
- This change supersedes `add-zoom-camera-mvp` design decision 3's Android rule, "`C = 1` on Android".

## Goals / Non-Goals

**Goals:**
- Use every rear lens the phone exposes through its logical camera, with presets at the lenses' true zoom factors.
- Keep the factor math in TypeScript, so it's unit-tested without a phone.
- Degrade to today's behaviour whenever anything is missing.

**Non-Goals:**
- Selecting a physical lens directly. VisionCamera has no API for CameraX's physical camera ID, and the logical camera already switches lenses by zoom ratio.
- Correcting captures where the phone silently falls back to a main-lens crop (low light, close focus). These are detected and logged in development only.
- Any iOS change.

## Decisions

### 1. Rear camera selection by lens count (already implemented)
`pickBackCamera()` (`src/camera/pickBackCamera.ts`) filters to rear, non-depth cameras and prefers the virtual device with the most physical lenses, then a standalone wide lens. It replaces `useCameraDevice('back', { physicalDevices })`, whose scoring subtracted a point for every lens of a type outside the filter. That penalised Samsung's quad camera (four `unknown` lenses) below the lone ultra-wide.
- *Alternative:* keep VisionCamera's picker with `physicalDevices: ['unknown', …]`. This is fragile and would rank oddly on other phones.

### 2. Local Expo module `lens-info`, Android only, returning raw measurements
Created with `npx create-expo-module@latest --local` in `modules/lens-info`, with `platforms: ["android"]`. One async function:

```
getLensGeometry(cameraId: string): Promise<LensGeometry | null>
LensGeometry = { reference: Lens, lenses: Lens[], zoomRatioRange: [number, number] | null }
Lens = { id, focalLength, physicalSize: {w, h}, pixelArray: {w, h}, activeArray: {w, h} }
```

The Kotlin code uses `CameraManager.getCameraCharacteristics()` for the logical camera (the reference) and for each of its `physicalCameraIds` (API 28+), reading `LENS_INFO_AVAILABLE_FOCAL_LENGTHS[0]`, `SENSOR_INFO_PHYSICAL_SIZE`, `SENSOR_INFO_PIXEL_ARRAY_SIZE`, `SENSOR_INFO_ACTIVE_ARRAY_SIZE` and `CONTROL_ZOOM_RATIO_RANGE` (API 30+). It returns `null` for a non-logical camera, and on any exception. The JS wrapper uses `requireOptionalNativeModule`, so iOS, web and Jest get `null` with no stub.
- *Why raw values:* the factor formula and its edge cases stay in tested TypeScript, and native code stays minimal.
- *Alternatives:* patch VisionCamera (`patch-package` on Kotlin; brittle across upgrades), contribute upstream (right long term, but slow), or a config plugin (can't add Kotlin logic cleanly).

### 3. Zoom factor from field of view
In `src/camera/lensGeometry.ts`, for each lens:

`activeDiagMm = physicalDiag × (activeArrayDiag / pixelArrayDiag)`, `fovScale = activeDiagMm / focalLength`, and `zoomFactor = fovScale(reference) / fovScale(lens)`.

The logical camera is the reference because Android defines `CONTROL_ZOOM_RATIO = 1.0` relative to it. Factors are snapped with the existing `snapFactor()` (within 10% of 0.5/0.6/…/5/10). Sanity check: if `zoomRatioRange` is known, the smallest factor should be within 15% of its lower bound (0.6 on the test phone). Otherwise the result is discarded and the fallback is used.

### 4. `analyzeLenses()` takes optional Android geometry
`analyzeLenses(device, 'android', factors?)`: with factors, the lenses are the distinct snapped factors within `[device.minZoom, device.maxZoom]`, typed ultra-wide below 1, wide at 1 and telephoto above 1. `C` is the largest of them, and `neutralZoom` stays 1. Without factors, behaviour is unchanged (`C = 1`). iOS is unchanged.
- **C uses the snapped factor**, so hardware zoom reaches at least the phone's own switch point (the HAL switches at its nominal 3.0/5.0). A computed 4.8 that stopped short of 5.0 would never engage the 5x lens.

### 5. Loading without blocking the camera
`useLensFactors(device)` calls the module once per device ID and caches the result in a module-level map. Until it resolves, `lensInfo` uses the fallback, so the camera opens immediately and the presets update when factors arrive (normally within one frame). Max-zoom estimation is unchanged; the 12 MP cap already fits binned telephoto output.

### 6. Development-only lens check via EXIF
After each capture in a development build, `photo.getFileDataAsync()` is parsed by a small TS EXIF reader (`src/camera/exifFocalLength.ts`, tag `0x920A` FocalLength in the Exif sub-IFD, rational, both byte orders). The result is compared with the focal length of the lens expected at that zoom and logged as `[lens-check] 5x → 18.6 mm (5x lens)`, or a warning when the phone used a different lens. Production builds skip this, so release memory and latency are unaffected.

### 7. Testing
- Jest: `pickBackCamera` (done), factor maths with a Samsung-like fixture and edge cases (missing fields, single lens, failed sanity check), `analyzeLenses` with factors, and the EXIF parser on synthetic little- and big-endian JPEGs.
- Device: presets 0.6/1/3/5, the `[lens-check]` log showing 7.9 mm at 3x and 18.6 mm at 5x in good light, a crop beyond 5x, and fallback behaviour checked by forcing a `null` result.

## Risks / Trade-offs

- [The phone falls back to a main-lens crop at 3x/5x in low light or close focus] → this is outside the app's control on a logical camera, and those captures carry ISP upscaling. It's detected in development through EXIF. A follow-up could read EXIF in production and tell the user.
- [The computed factor differs from the phone's actual switch point] → snapping covers ±10%, and the EXIF check confirms it on the device. If a phone switches noticeably later than its nominal factor, `C` might sit on the shorter lens; the device check would catch that.
- [Samsung caps third-party zoom at 10x and may hide some lenses on other models] → lenses beyond `maxZoom` are dropped, and missing lenses mean fewer presets, not errors.
- [Some HALs report physical-lens characteristics inconsistently] → the sanity check against `CONTROL_ZOOM_RATIO_RANGE`, plus the fallback.
- [New native code means a new dev build, and each Android build uses EAS quota] → the module is small and has no dependencies. Local `npx expo run:android` is an option.

## Migration Plan

App-only change, no data migration. It needs a new Android development build (EAS `development` profile). Rollback is reverting the commit and rebuilding; behaviour then returns to the main-lens cap.

## Open Questions

- Does the user's exact model switch at nominal 3.0x and 5.0x for third-party apps? This will be answered by the EXIF check on the device and doesn't change the plan.
