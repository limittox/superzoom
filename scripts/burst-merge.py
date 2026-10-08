#!/usr/bin/env python3
"""Merges a burst from the burst lab (docs/capture-spike.md) and compares it with a single frame.

    python scripts/burst-merge.py eval/bursts/<burst id> [--scale 2]

For each source (photos, video frames) it:
1. picks the sharpest frame as the reference,
2. aligns every frame to it with sub-pixel accuracy (OpenCV ECC, rotation + translation),
3. drops frames that align badly or are blurrier than the rest (motion, focus hunting),
4. warps the kept frames onto a grid `--scale` times finer and takes the per-pixel median
   (shift-and-add super-resolution: hand shake samples the scene at different sub-pixel offsets).

It writes, per source, `<source>-single.png` (the reference enlarged with bicubic, the "one
frame" baseline), `<source>-merged.png` and `<source>-merged-sharp.png` (a light unsharp mask), all
at the same size, plus `summary.json`. With `--eval-dir`, it also copies them as JPEGs named for
scripts/eval-upscalers.mjs, so they can be enhanced and compared on the bake-off page.
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np

ECC_MIN = 0.97          # alignment quality below which a frame is dropped (good alignments score > 0.99)
SHARPNESS_MIN = 0.6     # fraction of the median sharpness below which a frame is dropped
# Frame orientation -> the rotation that turns it upright (checked on a Samsung: 'left' needs clockwise).
ROTATE = {'left': cv2.ROTATE_90_CLOCKWISE, 'right': cv2.ROTATE_90_COUNTERCLOCKWISE, 'down': cv2.ROTATE_180}


def sharpness(gray):
    return float(cv2.Laplacian(gray, cv2.CV_32F).var())


def load_photos(folder, meta):
    frames = []
    for p in meta.get('photos', []):
        img = cv2.imread(str(folder / p['file']), cv2.IMREAD_COLOR)
        if img is not None:
            frames.append(img.astype(np.float32) / 255.0)
    return frames


def load_video(folder, meta, photo_shape):
    frames = []
    for v in meta.get('video', []):
        raw = np.fromfile(folder / v['file'], dtype=np.uint8)
        if raw.size != v['width'] * v['height'] * 4:
            continue
        img = raw.reshape(v['height'], v['width'], 4)
        bgr = img[:, :, :3] if 'bgra' in v['pixelFormat'] else img[:, :, [2, 1, 0]]
        # Frames arrive in sensor orientation; turn them like the photos (portrait or landscape).
        if photo_shape is not None and (bgr.shape[0] > bgr.shape[1]) != (photo_shape[0] > photo_shape[1]):
            bgr = cv2.rotate(bgr, ROTATE.get(v.get('orientation'), cv2.ROTATE_90_CLOCKWISE))
        frames.append(np.ascontiguousarray(bgr).astype(np.float32) / 255.0)
    if frames and photo_shape is not None:
        # The video crop has a 25% margin and a 4:3 shape; cut it to the photos' field of view.
        h, w = frames[0].shape[:2]
        th = int(round(h / 1.25))
        tw = min(w, int(round(th * photo_shape[1] / photo_shape[0])))
        y, x = (h - th) // 2, (w - tw) // 2
        frames = [f[y:y + th, x:x + tw] for f in frames]
    return frames


def align(frames):
    """Returns (reference index, [(index, 2x3 warp frame->reference, ecc)] for frames that aligned)."""
    grays = [cv2.GaussianBlur(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), (0, 0), 1.0) for f in frames]
    sharp = [sharpness(g) for g in grays]
    ref = int(np.argmax(sharp))
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6)
    window = cv2.createHanningWindow(grays[ref].shape[::-1], cv2.CV_32F)
    aligned = []
    for i, g in enumerate(grays):
        if i == ref:
            aligned.append((i, np.eye(2, 3, dtype=np.float32), 1.0))
            continue
        # Hand shake at 30x moves the frame by tens of pixels, too far for ECC to converge from the
        # identity (it settles at ~0.94 with ghosting). Phase correlation finds the coarse shift first.
        (sx, sy), _ = cv2.phaseCorrelate(grays[ref], g, window)
        warp = np.array([[1, 0, sx], [0, 1, sy]], dtype=np.float32)
        try:
            ecc, warp = cv2.findTransformECC(grays[ref], g, warp, cv2.MOTION_EUCLIDEAN, criteria, None, 5)
        except cv2.error:
            continue
        aligned.append((i, warp, float(ecc)))
    median_sharp = float(np.median(sharp))
    kept = [(i, w, e) for i, w, e in aligned if e >= ECC_MIN and sharp[i] >= SHARPNESS_MIN * median_sharp]
    return ref, kept, sharp


#: Width of each sample's footprint on the fine grid, in fine pixels. 1.0 scored best on a
#: synthetic burst (8 frames, 2x): +0.45 dB over one frame, versus +0.1 dB for bilinear splats.
SPLAT_SIGMA = 1.0


def splat_merge(frames, ref, kept, scale, fallback):
    """Shift-and-add: drops every pixel of every kept frame at its exact sub-pixel position on the
    fine grid (Gaussian weights over the 3x3 nearest fine pixels) and averages. Fine pixels no
    sample reached take `fallback`."""
    h, w = frames[ref].shape[:2]
    H, W = h * scale, w * scale
    acc = np.zeros((H * W, 3), np.float64)
    wsum = np.zeros(H * W, np.float64)
    ys, xs = np.mgrid[0:h, 0:w]
    pts = np.stack([xs.ravel(), ys.ravel(), np.ones(xs.size)], axis=0).astype(np.float64)
    for i, warp, _ in kept:
        # ECC's warp maps reference -> frame; invert it to place frame pixels in the reference.
        m = np.linalg.inv(np.vstack([warp.astype(np.float64), [0, 0, 1]]))
        ref_xy = (m @ pts)[:2]
        fx = (ref_xy[0] + 0.5) * scale - 0.5
        fy = (ref_xy[1] + 0.5) * scale - 0.5
        cx0, cy0 = np.round(fx).astype(np.int64), np.round(fy).astype(np.int64)
        colors = frames[i].reshape(-1, 3).astype(np.float64)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                cx, cy = cx0 + dx, cy0 + dy
                wt = np.exp(-((cx - fx) ** 2 + (cy - fy) ** 2) / (2 * SPLAT_SIGMA ** 2))
                ok = (cx >= 0) & (cx < W) & (cy >= 0) & (cy < H)
                idx = cy[ok] * W + cx[ok]
                np.add.at(wsum, idx, wt[ok])
                np.add.at(acc, idx, colors[ok] * wt[ok, None])
    out = fallback.reshape(-1, 3).astype(np.float64).copy()
    filled = wsum > 1e-6
    out[filled] = acc[filled] / wsum[filled, None]
    return out.reshape(H, W, 3).astype(np.float32)


def merge(frames, ref, kept, scale):
    h, w = frames[ref].shape[:2]
    out_size = (w * scale, h * scale)
    # Fine-grid pixel X -> reference pixel x, pixel-centre aligned like cv2.resize: x = (X + 0.5)/s - 0.5.
    offset = 0.5 / scale - 0.5
    to_coarse = np.array([[1 / scale, 0, offset], [0, 1 / scale, offset], [0, 0, 1]], dtype=np.float64)
    stack = []
    for i, warp, _ in kept:
        # ECC's warp maps reference coordinates to frame coordinates, so frame = warp @ to_coarse @ X.
        m = np.vstack([warp.astype(np.float64), [0, 0, 1]]) @ to_coarse
        stack.append(cv2.warpAffine(frames[i], m[:2].astype(np.float32), out_size,
                                    flags=cv2.INTER_CUBIC | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REFLECT))
    median = np.median(np.stack(stack), axis=0)
    single = cv2.resize(frames[ref], out_size, interpolation=cv2.INTER_CUBIC)
    merged = splat_merge(frames, ref, kept, scale, median)
    blur = cv2.GaussianBlur(merged, (0, 0), 1.0)
    sharp = np.clip(merged + 0.8 * (merged - blur), 0, 1)
    return single, median, merged, sharp


def save(path, img):
    cv2.imwrite(str(path), (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('burst')
    parser.add_argument('--scale', type=int, default=2)
    parser.add_argument('--eval-dir', help='also write JPEGs for scripts/eval-upscalers.mjs here')
    args = parser.parse_args()
    folder = Path(args.burst)
    meta = json.loads((folder / 'meta.json').read_text(encoding='utf-8'))

    photos = load_photos(folder, meta)
    sources = {'photo': photos, 'video': load_video(folder, meta, photos[0].shape if photos else None)}
    summary = {'id': meta['id'], 'zoom': meta.get('zoom'), 'scale': args.scale, 'sources': {}}
    for name, frames in sources.items():
        if len(frames) < 2:
            continue
        ref, kept, sharp = align(frames)
        single, median, merged, merged_sharp = merge(frames, ref, kept, args.scale)
        outputs = (('single', single), ('median', median), ('merged', merged), ('merged-sharp', merged_sharp))
        for suffix, img in outputs:
            save(folder / f'{name}-{suffix}.png', img)
            if args.eval_dir:
                out = Path(args.eval_dir)
                out.mkdir(parents=True, exist_ok=True)
                h, w = img.shape[:2]
                cv2.imwrite(str(out / f"{meta['id']}-{name}-{suffix}-{w}x{h}.jpg"),
                            (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 95])
        summary['sources'][name] = {
            'frames': len(frames),
            'kept': len(kept),
            'reference': ref,
            'size': list(frames[ref].shape[1::-1]),
            'ecc': [round(e, 4) for _, _, e in kept],
            'shift_px': [[round(float(w[0, 2]), 2), round(float(w[1, 2]), 2)] for _, w, _ in kept],
            'sharpness': {
                'frames_median': round(float(np.median(sharp)), 6),
                'single': round(sharpness(cv2.cvtColor(single.astype(np.float32), cv2.COLOR_BGR2GRAY)), 6),
                'merged': round(sharpness(cv2.cvtColor(merged.astype(np.float32), cv2.COLOR_BGR2GRAY)), 6),
            },
        }
        print(f"{name}: kept {len(kept)}/{len(frames)} frames (ref {ref}), shifts "
              f"{summary['sources'][name]['shift_px']}")
    (folder / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    print(f'-> {folder}')


if __name__ == '__main__':
    main()
