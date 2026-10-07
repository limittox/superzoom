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

## Ideas

- **Sensor-crop zoom (Samsung 2x/10x):** use high-resolution sensor crops instead of digital crops where the phone exposes them. Start by measuring whether hardware zoom past a lens is sharper than the app's own crop.
- **Telephoto fallback notice:** tell the user when the phone used a wider lens's crop at a telephoto zoom (close or dim subjects), using the EXIF focal length outside development builds.
