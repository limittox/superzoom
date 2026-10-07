# Proposal

## Why

On Android, superzoom uses only the main lens up to 1x and crops beyond that. Phones like the user's Samsung have dedicated 3x and 5x telephoto lenses that capture far more real detail, and the app is meant to give the AI as many native pixels as possible. Device testing on 2026-10-07 also found that the app was choosing the standalone ultra-wide camera instead of Samsung's combined "Back Quad Camera", so the "1x" preview was really the 0.6x lens.

The cause is the camera library: VisionCamera 5.2.3 reports no lens switch points on Android, and it labels the lenses inside a logical camera as `unknown`. The phone itself knows each lens's focal length and sensor size, so the real zoom factors can be computed natively.

## What Changes

- **Rear camera selection:** the app picks the rear camera that spans the most lenses (the logical multi-lens camera on Android, the triple camera on iPhone) instead of VisionCamera's default ranking, which preferred a lone ultra-wide on Samsung. The fix is already implemented in the working tree, uncommitted.
- **Android lens factors:** a small local Expo module (`modules/lens-info`, Kotlin) reads each physical lens behind the active logical camera from the Android camera API and returns its 35 mm-equivalent zoom factor relative to the main lens. On iOS it returns nothing, because VisionCamera already reports exact switch factors there.
- **Android zoom range:** when lens factors are known, hardware zoom goes up to the longest telephoto lens (5x on the user's phone, within the camera's reported maximum), and digital crop applies only beyond it. Presets appear for every lens (0.6x, 1x, 3x, 5x). When factors can't be determined, behaviour stays as today: hardware zoom capped at the main lens.
- **Lens verification (development builds):** after each capture, the app reads the photo's EXIF focal length and logs which lens actually took it, to confirm the phone switches to the telephoto at 3x and 5x.
- Out of scope: picking physical lenses directly (VisionCamera doesn't expose physical-camera selection), iOS changes, and correcting for the phone falling back to a main-lens crop in low light (detected and logged only).

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `zoom-capture`: adds requirements for choosing the multi-lens rear camera and for using every telephoto lens a device exposes, including on Android. The capability is introduced by the in-progress change `add-zoom-camera-mvp` (not yet archived to `openspec/specs/`), so this change adds requirements to it rather than modifying existing text, and it should be archived after `add-zoom-camera-mvp`.

## Impact

- **New native code:** `modules/lens-info/` (Expo Modules API: Kotlin for Android, a stub for iOS), autolinked by Expo. **A new development build is required.**
- **Changed code:** `src/camera/pickBackCamera.ts` (new, already written), `src/camera/useZoomCamera.ts`, `src/camera/lenses.ts`, and a dev-only EXIF reader for verification.
- **Dependencies:** none new; the Android side uses the platform `CameraManager` API.
- **Behaviour on other Android phones:** phones without a logical multi-camera, or whose telephoto lenses aren't exposed, keep today's behaviour.
- **Cost:** more hardware zoom means sharper crops, so upload size and enhancement cost don't change.
