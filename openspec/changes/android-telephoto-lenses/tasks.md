# Tasks

## 1. Rear camera selection

- [x] 1.1 Land the rear-camera picker already in the working tree (`src/camera/pickBackCamera.ts`, its tests, and `useZoomCamera` using `useCameraDevices()` + `pickBackCamera()`); verify `npm test` covers the Samsung quad, iPhone triple, depth-only and standalone cases and that the dev log on the Samsung shows `"selected": true` for `id 0`
- [x] 1.2 Keep `useCameraDiagnostics` development-only (no output in release builds) and document it in `docs/device-test-matrix.md` as the way to capture a phone's camera list; verify `__DEV__` gates the log and a production `npx expo export --platform android` bundle contains no `[camera-diagnostics]` string

## 2. Native lens-info module

- [x] 2.1 Create the local module with `npx create-expo-module@latest --local` as `modules/lens-info`, Android only (`platforms: ["android"]`), removing the generated example view and events; verify `npx expo-doctor` passes and `npx expo prebuild --platform android --clean` autolinks it (module listed in the generated Android project)
- [x] 2.2 Implement Kotlin `getLensGeometry(cameraId)` per design decision 2 (logical reference + each `physicalCameraIds` entry: focal length, physical size, pixel array, active array; `CONTROL_ZOOM_RATIO_RANGE` on API 30+; `null` for non-logical cameras or on any exception); verify `npx expo run:android` or an EAS build compiles it without warnings about missing API guards
- [x] 2.3 Add the TS wrapper `modules/lens-info/index.ts` using `requireOptionalNativeModule`, with types `LensGeometry` / `Lens`; verify `npm run typecheck` passes and that in Jest (no native module) the wrapper returns `null`

## 3. Zoom factors and lens model

- [x] 3.1 Implement `computeLensFactors(geometry)` in `src/camera/lensGeometry.ts` per design decision 3 (active-area diagonal / focal length, logical camera as reference, snapping, `zoomRatioRange` sanity check); verify unit tests with a Samsung-like fixture yield 0.6/1/3/5, a focal-only 3x/5x trap fixture is labeled by field of view, and missing fields or a failed sanity check return `null`
- [x] 3.2 Extend `analyzeLenses(device, 'android', factors?)` per design decision 4 (lenses from factors within `[minZoom, maxZoom]`, `C` = largest snapped factor, types by factor, unchanged without factors); verify tests cover the 0.6/1/3/5 phone (presets and `C = 5`), a lens above `maxZoom` being dropped, and the unchanged fallback
- [x] 3.3 Add `useLensFactors(device)` (cached per device ID, fallback until resolved) and wire it into `useZoomCamera`; verify the existing camera tests still pass and that a mocked `null` result keeps `C = 1`

## 4. Development lens check

- [x] 4.1 Implement `readExifFocalLength(jpegBytes)` in `src/camera/exifFocalLength.ts` (APP1 Exif → IFD0 → Exif sub-IFD → tag `0x920A`, both byte orders); verify unit tests on synthetic little- and big-endian JPEGs, a JPEG without EXIF, and a truncated file
- [x] 4.2 In development builds only, after each capture log `[lens-check] <zoom>x → <focal> mm (<lens>)` and warn when the focal length doesn't match the lens expected for the hardware zoom used; verify the check is skipped when `__DEV__` is false and that capture timing in production is unchanged (no `getFileDataAsync` call)

## 5. Device verification

- [x] 5.1 Build a new Android development build (`npx eas-cli@latest build --profile development --platform android`) and install it; verify it launches and connects to the dev server
- [x] 5.2 On the user's Samsung in good light: verify presets read 0.6x/1x/3x/5x, the zoom indicator shows 5x as optical and 6x+ as AI zoom, and `[lens-check]` logs ≈7.9 mm at 3x and ≈18.6 mm at 5x; record results in `docs/device-test-matrix.md`
- [x] 5.3 Verify a 12x capture is taken at 5x hardware zoom and center-cropped to the preview framing, and that forcing `getLensGeometry` to return `null` (temporary dev toggle) restores the 1x cap with working capture; record results in `docs/device-test-matrix.md` (done with a 10x capture; the on-device `null` toggle was skipped at the user's request since unit tests cover the fallback)
- [x] 5.4 Run `npm test`, `npm run lint` and `npm run typecheck`, then update `docs/backend.md`/README only if commands changed and add a note to `add-zoom-camera-mvp/design.md` decision 3 pointing to this change; verify all checks pass

## Workflow follow-up

- Archive `add-zoom-camera-mvp` before this change, since this change adds requirements to the `zoom-capture` capability that change introduces.
- Archive this change with `/opsx:archive` once its tasks are complete.
