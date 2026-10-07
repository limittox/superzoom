# Proposal

## Why

The user wants zoom up to 100x, like the "Space Zoom" on their Samsung. Today the app stops where a capture would drop below 1 megapixel of real sensor pixels, about 14x on the test phone (5x telephoto, 12.5 MP photos, about 7.7 MP visible on screen). Past that point the AI upscaler, not the sensor, provides most of the detail. That's acceptable if users are told clearly.

## What Changes

- **Maximum zoom up to 100x.** The 1 MP floor is replaced by a minimum crop size of 64 px on the short side, the same minimum the enhancement service already enforces. The maximum is 100x or the zoom where the crop would fall below that size, whichever is lower. That's 100x on the test Samsung (about a 94 × 204 px crop) and about 29x on phones capped at their main lens.
- **Three zoom tiers in the indicator:** optical (≤ the longest lens), AI zoom (up to the native-pixel limit, which is still computed with the 1 MP rule), and **AI-reconstructed** beyond it, with a short warning that most detail will be generated.
- **Stronger upscaling for tiny crops.** The upscale factor range grows from 2x–4x to 2x–10x, so a 0.02 MP crop becomes about 2 MP. Enhance (SeedVR2) does this in one pass, since it supports up to 10x. Pro (Topaz) and Creative (Clarity) stop at 4x, so they run two passes when more than 4x is needed. The 16 MP output cap and the 4 MP input cap stay.
- **Labelling.** Results from beyond the native-pixel limit are labeled AI-reconstructed, saying most detail was generated, in every mode.
- **Steadier extreme-zoom preview.** Preview stabilization is requested where the camera supports it, and past the native-pixel limit a "brace your phone" hint appears.
- **Zoom presets** reach the new range (up to 100x where available).
- Out of scope: multi-frame burst capture, iOS-specific tuning beyond what the shared code does, and changes to pricing or limits per mode.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `zoom-capture`: the "Maximum zoom bound by native pixels" requirement changes from a 1 MP crop floor to a 64 px minimum crop with a 100x ceiling. "Zoom level indicator" gains the AI-reconstructed tier. New requirements cover the native-pixel limit and the extreme-zoom preview.
- `image-enhancement`: "Output size limit" widens the upscale factor to 2x–10x, using two passes for models capped at 4x.
- `enhanced-photo-review`: "AI-enhanced labeling" adds the AI-reconstructed label for captures beyond the native-pixel limit.

## Impact

- **Changed code:** `src/camera/crop.ts` (limits), `src/camera/useZoomCamera.ts`, `src/components/ZoomControls.tsx` (tiers, presets, hint), `src/app/index.tsx` (preview stabilization), `src/shared/enhance.ts` and `src/shared/upscale.ts` (factor range), `src/server/upscaler/fal.ts` (two-pass), `src/app/result.tsx` and `src/state/session.ts` (label).
- **No new dependencies and no native changes**, so no new dev build is needed. The backend changes take effect on the dev server, or on redeploy once hosted.
- **Cost:** Pro and Creative cost up to about twice as much at extreme zoom because of the second pass. Outputs are small (about 2 MP), so Clarity's per-megapixel cost stays low. Topaz is billed per image, so about $0.16.
- **Quality expectations:** at 100x most detail is invented by the model. The UI says so.
