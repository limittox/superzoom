# Proposal

## Why

Phone cameras lose detail fast once you zoom past the optical lenses. Beyond 3–5x, the stock camera only crops and stretches pixels. superzoom is a camera built for extreme zoom: it gets as much real detail as possible from the optical lenses, then uses a cloud AI upscaler to rebuild a sharp image from the zoomed crop. The repository is empty today, so this change establishes the MVP across iOS and Android.

## What Changes

- New Expo (dev build) React Native app targeting iOS and Android from one codebase.
- Camera screen with pinch-to-zoom that switches smoothly between the device's physical lenses (ultra-wide, wide, telephoto) and continues past the optical limit using a digital crop.
- Photo capture that preserves the sensor's native pixels and crops to exactly the region the user framed, so the AI works from real pixels rather than pixels already interpolated by digital zoom.
- Three enhancement modes the user picks before or after capture:
  - **Enhance** (default): SeedVR2 via fal.ai. Cheap, and stays faithful to the photo.
  - **Pro**: Topaz Image Upscale via fal.ai. Highest fidelity, costs more.
  - **Creative**: Clarity Upscaler via fal.ai. Diffusion-based, adds the most invented detail.
- A small TypeScript backend endpoint that holds the fal.ai API key, accepts the cropped image (which the app downscales to at most 4 MP before upload), runs the selected model, and caps the output at 16 MP to control cost and download size.
- Result screen with a before/after comparison slider, a clear "AI-enhanced" label, and saving of the original crop, the enhanced image, or both to the device gallery.
- Out of scope for this change: on-device enhancement models, multi-frame burst super-resolution (planned for phase 2), user accounts, payments, video, and the front camera.

## Capabilities

### New Capabilities
- `zoom-capture`: Camera preview, permission handling, pinch and preset zoom across physical lenses and beyond the optical limit, and capturing a native-resolution crop of the framed region.
- `image-enhancement`: Backend enhancement service: the request contract, enhancement modes and their model mapping, output size limits, input validation, abuse limits, and error reporting to the app.
- `enhanced-photo-review`: Showing the enhancement progress and result, the before/after comparison, retrying or switching modes, and saving images to the device gallery.

### Modified Capabilities
<!-- None: no existing specs. -->

## Impact

- **New code**: the Expo app (screens, camera, zoom gesture, crop, API client) and the backend API route(s).
- **New dependencies**: `expo`, `expo-router`, `expo-dev-client`, `react-native-vision-camera` (v5, falling back to v4 if v5 is not stable), `react-native-gesture-handler`, `react-native-reanimated`, `expo-image-manipulator`, `expo-media-library`, `expo-image`; on the server, `@fal-ai/client`.
- **External services**: a fal.ai account and API key, billed per request or per megapixel; EAS (builds and hosting of the API routes); and a serverless key-value store (Upstash Redis) for per-device rate-limit counters.
- **Native permissions**: camera, plus photo-library write on iOS and media permissions on Android.
- **Privacy**: captured crops leave the device for processing by fal.ai. The app must say so before the first enhancement.
- **Cost**: every enhancement costs money. The output cap and per-device rate limit bound how much one user can spend.
