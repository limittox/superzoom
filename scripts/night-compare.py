#!/usr/bin/env python3
"""Compares a Night extension photo with a normal photo from the Night A/B lab (docs/follow-ups.md).

    python scripts/night-compare.py eval/bursts/<night id> [--eval-dir eval/night-eval]

The lab uploads both photos uncropped. This script turns the Night photo upright like the normal
one, finds how far the hand moved between the two shots, crops both exactly like
the app does at the lab's zoom (src/camera/crop.ts; the Night crop moved by that shift), and writes `normal-crop.jpg`, `night-crop.jpg`
and a side-by-side `compare.jpg`, plus `summary.json`. With `--eval-dir`, the crops are also copied
with names for scripts/eval-upscalers.mjs, so both can be enhanced the same way.
"""
import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np

MIN_CROP_SHORT_SIDE = 64
ROTATE = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}


def visible_region(width, height, ratio):
    """Port of visibleRegion(): the centred rectangle the full-screen `cover` preview shows."""
    long_side, short_side = max(width, height), min(width, height)
    ratio = max(1.0, ratio)
    if ratio >= long_side / short_side:
        vis_long, vis_short = long_side, long_side / ratio
    else:
        vis_short, vis_long = short_side, short_side * ratio
    portrait = height >= width
    w = round(vis_short if portrait else vis_long)
    h = round(vis_long if portrait else vis_short)
    return (width - w) // 2, (height - h) // 2, w, h


def compute_crop(width, height, ratio, digital_factor):
    """Port of computeCrop()."""
    _, _, rw, rh = visible_region(width, height, ratio)
    factor = min(max(1.0, digital_factor), max(1.0, min(rw, rh) / MIN_CROP_SHORT_SIDE))
    w = min(rw, math.ceil(rw / factor))
    h = min(rh, math.ceil(rh / factor))
    return (width - w) // 2, (height - h) // 2, w, h


def upright_like(img, reference_shape, sensor_orientation):
    """Turns `img` so its orientation (portrait or landscape) matches the reference photo."""
    if (img.shape[0] > img.shape[1]) == (reference_shape[0] > reference_shape[1]):
        return img
    return cv2.rotate(img, ROTATE.get(sensor_orientation or 90, cv2.ROTATE_90_CLOCKWISE))


def shift_to(reference, img, digital_factor):
    """Where `reference`'s content sits in `img`: (dx, dy) in full-resolution pixels and the ECC score.
    Estimated around the crop area (rotation + translation, then only the translation is used)."""
    def gray(a):
        return cv2.cvtColor(a, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255

    h, w = reference.shape[:2]
    # Estimate on the central region a little wider than the crop, at most ~1000 px across.
    span = min(1.0, 3.0 / max(1.0, digital_factor))
    cw, ch = int(w * span), int(h * span)
    x0, y0 = (w - cw) // 2, (h - ch) // 2
    scale = min(1.0, 1000 / max(cw, ch))
    ref = cv2.resize(gray(reference)[y0:y0 + ch, x0:x0 + cw], None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    mov = cv2.resize(gray(img)[y0:y0 + ch, x0:x0 + cw], None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    ref, mov = cv2.GaussianBlur(ref, (0, 0), 1.0), cv2.GaussianBlur(mov, (0, 0), 1.0)
    (sx, sy), _ = cv2.phaseCorrelate(ref, mov, cv2.createHanningWindow(ref.shape[::-1], cv2.CV_32F))
    warp = np.array([[1, 0, sx], [0, 1, sy]], np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6)
    try:
        ecc, warp = cv2.findTransformECC(ref, mov, warp, cv2.MOTION_EUCLIDEAN, criteria, None, 5)
    except cv2.error:
        ecc = float('nan')
    # ECC's warp maps reference to image coordinates; take the centre's displacement at full size.
    centre = np.array([ref.shape[1] / 2, ref.shape[0] / 2, 1.0])
    moved = warp.astype(np.float64) @ centre
    return (moved[0] - centre[0]) / scale, (moved[1] - centre[1]) / scale, float(ecc)


def metrics(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    # Noise: spread of the fine residual; detail: Laplacian variance (also rises with noise).
    residual = g - cv2.GaussianBlur(g, (0, 0), 1.5)
    return {'laplacian_var': round(float(cv2.Laplacian(g, cv2.CV_32F).var()), 1),
            'residual_std': round(float(residual.std()), 2), 'mean': round(float(g.mean()), 1)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('folder')
    parser.add_argument('--eval-dir', help='also write the crops here, named for scripts/eval-upscalers.mjs')
    args = parser.parse_args()
    folder = Path(args.folder)
    meta = json.loads((folder / 'meta.json').read_text(encoding='utf-8'))

    # IMREAD_COLOR applies the EXIF orientation tag where there is one.
    normal = cv2.imread(str(folder / meta['normal']['file']), cv2.IMREAD_COLOR)
    night = cv2.imread(str(folder / meta['night']['file']), cv2.IMREAD_COLOR)
    night = upright_like(night, normal.shape, meta['night'].get('sensorOrientation'))
    if night.shape[:2] != normal.shape[:2]:
        night = cv2.resize(night, normal.shape[1::-1], interpolation=cv2.INTER_AREA)

    factor = float(meta['digitalFactor'])
    dx, dy, ecc = shift_to(normal, night, factor)
    x, y, w, h = compute_crop(normal.shape[1], normal.shape[0], float(meta['previewLongOverShort']), factor)
    # Move the Night crop by whole pixels instead of resampling it, so neither crop is softened.
    nx = int(np.clip(round(x + dx), 0, night.shape[1] - w))
    ny = int(np.clip(round(y + dy), 0, night.shape[0] - h))
    shift = [nx - x, ny - y]
    crops = {'normal': normal[y:y + h, x:x + w], 'night': night[ny:ny + h, nx:nx + w]}
    for name, crop in crops.items():
        cv2.imwrite(str(folder / f'{name}-crop.jpg'), crop, [cv2.IMWRITE_JPEG_QUALITY, 95])
        if args.eval_dir:
            out = Path(args.eval_dir)
            out.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(out / f"{meta['id']}-{name}-{w}x{h}.jpg"), crop, [cv2.IMWRITE_JPEG_QUALITY, 95])

    # Side by side, enlarged to about 1000 px tall with nearest-neighbour so pixels stay visible.
    zoom = max(1, round(1000 / h))
    tiles = []
    for name, crop in crops.items():
        tile = cv2.resize(crop, (w * zoom, h * zoom), interpolation=cv2.INTER_NEAREST)
        cv2.putText(tile, name, (10, 34), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 255), 2)
        tiles.append(tile)
    cv2.imwrite(str(folder / 'compare.jpg'), np.hstack(tiles), [cv2.IMWRITE_JPEG_QUALITY, 90])

    t = meta['night'].get('timingsMs', {})
    summary = {
        'id': meta['id'], 'zoom': meta['zoom'], 'digitalFactor': factor, 'deviceZoom': meta['deviceZoom'],
        'crop': [w, h], 'alignment': {'ecc': round(ecc, 4), 'shift_px': shift},
        'lens_mm': {'normal': meta['normal'].get('focalLength'), 'night': meta['night'].get('focalLength')},
        'night_ms': {'request_to_photo': t.get('stillAvailable', 0) - t.get('captureRequested', 0),
                     'total': t.get('stillAvailable'), 'camera_stop': meta.get('stopMs')},
        'metrics': {name: metrics(crop) for name, crop in crops.items()},
    }
    (folder / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
