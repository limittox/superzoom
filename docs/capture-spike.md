# Capture quality spike

**Status:** closed, 2026-10-09. Four ideas for closing the gap with Samsung's own 30x were tested on the user's Samsung (Back Quad Camera, Android 16). None beat the current path (one photo, then SeedVR2) by enough to build. The development tooling stays on the `feat/burst-spike` branch for a rerun on another phone; it isn't merged.

| Idea | Result |
| --- | --- |
| Full 50 MP sensor readout | ❌ Not offered to apps on this phone |
| Our own multi-frame burst | ❌ About 11 s; after SeedVR2, no better than one photo |
| Samsung's Night extension (its own merge) | ➖ Worse at 30x, slightly crisper at 100x but invents more letters |
| Denoise or soften the crop before upload | ❌ Denoising smears texture and causes made-up letters; softening changes nothing |

One more finding matters for every evaluation: **SeedVR2's output varies from run to run** on the same input, enough to flip a close comparison. Judge models and settings on several crops, not one pair.

## 1. Full sensor resolution

The native app crops the 5x telephoto's full ~50 MP readout; apps get 12.5 MP (4080×3060, 2×2 binned), about 4 times fewer real pixels. Queried with `getSensorModes()` in `modules/lens-info` (`[sensor-modes]` dev log), 2026-10-08:
- No lens has `ULTRA_HIGH_RESOLUTION_SENSOR`, and capture requests can't set `SENSOR_PIXEL_MODE`.
- The 0.6x, 1x and 5x lenses report 2×2 binning. Their maximum-resolution pixel array is still 4080×3060, and maximum-resolution mode offers only 1920×1080.
- No high-resolution (slow-capture) sizes. The largest JPEG, YUV and RAW output is 4080×3060 (4000×3000 on the unbinned 3x lens).
- `RAW_SENSOR` is available on every lens, but binned.

Samsung keeps the 50 MP mode for its own app. Worth querying again on other phones (Pixel, newer Samsung).

## 2. Our own multi-frame burst

**Idea:** hand shake shifts each frame by a fraction of a pixel. Aligning several frames and placing their pixels on a finer grid ("shift-and-add" super-resolution) can recover detail no single frame holds.

**Tooling:**
- **Burst lab** (development builds, "Burst lab" in the dev bar): `src/camera/useBurstLab.ts` takes 16 video frames (centre crop from the frame processor), then 8 photos cropped like a normal capture. They're saved through `POST /api/dev/burst` under `SAVE_BURSTS_DIR` (`src/server/burstSaver.ts`).
- **Merge:** `python scripts/burst-merge.py eval/bursts/<id> [--eval-dir DIR]`.
  - Takes the sharpest frame as the reference.
  - Aligns the others with phase correlation (coarse shift), then OpenCV ECC (sub-pixel rotation and translation). Drops frames with ECC below 0.97 or that are blurry.
  - Writes `single` (the reference, bicubic 2x), `median`, `merged` (Gaussian splats on a 2x grid) and `merged-sharp`.

**Results:**
- **Synthetic burst** (8 frames, 4x downsampled, noise): merged scored +0.45 dB PSNR over single.
- **Real burst at 30x, dim indoor scene** (`eval/bursts/20261008-084105-30x`):
  - **Timing:** 16 video frames in 0.56 s; 8 photos in 10.7 s.
  - **Video frames are unusable.** With full-resolution photo output attached, the frame stream is about 1440×1080, so the 30x crop is 111×240 pixels.
  - **Alignment:** shake moved frames by up to 69 px. ECC alone settled at about 0.94 and ghosted; seeding it with phase correlation gave ECC ≥ 0.998 for all 8 photos.
  - **Merged photo:** much less noise, no visible new detail.
  - **After SeedVR2:** the single raw crop looked crispest.

**Why it didn't help:** the phone already merges frames for each photo (we capture with `qualityPrioritization: 'quality'`), and SeedVR2 denoises. Real detail would need unprocessed full-resolution frames, which apps don't get here (section 1).

**Lesson:** free every native photo buffer (`Photo`, `Image`) once it's used, and copy `getFileDataAsync()` bytes before disposing the photo. The garbage collector doesn't see native memory, and an undisposed burst ran out of memory at photo 5.

## 3. Samsung's Night extension

The Samsung offers apps only three vendor modes: `night`, `bokeh` and `face-retouch`. Night is the only one that merges frames. Its zoom range is 0.6x–10x, with 4080×3060 JPEGs.

**Tooling:**
- **Night A/B** (development builds, dev bar): `src/camera/useNightLab.ts` takes a normal photo, pauses the app's camera, then takes one photo through the Night extension at the same lens zoom.
- **Native capture:** `captureNight` in `modules/lens-info` (`NightCapture.kt`) opens its own Camera2 extension session. A preview stream that is drained and never shown (an ImageReader with PRIVATE format and GPU usage) runs for 1.5 s before the capture so focus and exposure settle. The session accepted it.
- **Compare:** `python scripts/night-compare.py eval/bursts/<id> --eval-dir DIR` crops both like the app. It moves the Night crop by the measured hand shift instead of resampling it.

**Results** (same 5x lens, 18.6 mm, for both photos in every pair):
- **Timing:** about 0.5–0.6 s from request to photo, about 3 s including opening the camera. Pausing the app's camera took 30–40 ms.
- **30x, dim LCD display:** Night was about 15% darker and softer. After SeedVR2, the normal photo was clearly crisper.
- **100x, printed text, good light:** Night was softer before enhancement. After SeedVR2 it was a little crisper than two SeedVR2 runs of the normal crop, but it misread letters ("returo", "MINCHENBUR") that the normal runs got right.

Not worth a production capture path, which would black out the preview for about 3 s per photo. It might help in real low light, which isn't superzoom's main use.

## 4. Denoise or soften before upload

**Idea:** at 100x the normal photo's built-in sharpening and grain get enlarged by SeedVR2, and Night's cleaner frame seemed to do better. So clean the crop before upload?

**Test:** six small crops (four saved 30x/100x uploads, plus the normal crops of both Night pairs). Each was sent through SeedVR2 (noise_scale 0.3) in four variants: unchanged, non-local-means denoise at strength 3 and 6, and a 0.7 px Gaussian soften. That's 24 runs, about $0.08 (`eval/runs/prep/grid-c*.jpg`).

**Result:**
- Both denoise strengths smeared brick, rock and leaf texture. On the 100x text, strength 6 made SeedVR2 invent a letter ("MRICHINBUR").
- Softening was indistinguishable from the unchanged crop.

Keep uploading the crop as it is.

## Rerunning on another phone

1. Check `[sensor-modes]` first. If a lens has `ULTRA_HIGH_RESOLUTION_SENSOR` and a maximum-resolution JPEG or YUV size above 12 MP, full-resolution capture is the experiment to run.
2. Otherwise, the burst and Night labs work as described above. Take several pairs per zoom level of a well-lit, detailed subject, and compare after SeedVR2.
