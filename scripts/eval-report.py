#!/usr/bin/env python3
"""Builds a side-by-side comparison page from a model-evaluation run (docs/model-evaluation.md).

    python scripts/eval-report.py eval/runs/<timestamp>

For each crop it writes display copies at one common size (the crop itself enlarged with plain
bicubic resampling as the "no AI" baseline, then every model's result) into `<run>/report/`,
plus `report/data.json` for the comparison page. Every image of a crop has the same pixel size,
so the page can show the same region of each at the same zoom.
"""
import json
import sys
from pathlib import Path

from PIL import Image

DISPLAY_LONG_SIDE = 1600
JPEG_QUALITY = 88


def display_size(width, height):
    scale = DISPLAY_LONG_SIDE / max(width, height)
    return round(width * scale), round(height * scale)


def save_display(image, size, path):
    image.convert('RGB').resize(size, Image.Resampling.LANCZOS).save(path, quality=JPEG_QUALITY)


def main(run_dir):
    run = Path(run_dir)
    results = json.loads((run / 'results.json').read_text(encoding='utf-8'))
    # The folder the run read its crops from (run.json), else the default.
    meta = run / 'run.json'
    crops_dir = Path(json.loads(meta.read_text(encoding='utf-8'))['cropsDir']) if meta.exists() else Path('eval/crops')
    out = run / 'report'
    out.mkdir(exist_ok=True)

    by_crop = {}
    for r in results:
        by_crop.setdefault(r['crop'], []).append(r)

    data = []
    for crop_file, runs in sorted(by_crop.items()):
        crop = Image.open(crops_dir / crop_file)
        size = display_size(*crop.size)
        stem = Path(crop_file).stem
        baseline = f'{stem}__bicubic.jpg'
        # Plain enlargement: what the crop looks like without any AI.
        crop.convert('RGB').resize(size, Image.Resampling.BICUBIC).save(out / baseline, quality=JPEG_QUALITY)
        entries = [{'id': 'bicubic', 'label': 'No AI (bicubic)', 'file': baseline, 'ms': 0, 'cost': 0, 'size': list(crop.size)}]
        for r in sorted(runs, key=lambda r: r['candidate']):
            if r.get('error'):
                entries.append({'id': r['candidate'], 'label': r['label'], 'error': r['error']})
                continue
            result = Image.open(run / r['file'])
            name = f"{stem}__{r['candidate']}.jpg"
            save_display(result, size, out / name)
            entries.append({
                'id': r['candidate'],
                'label': r['label'],
                'file': name,
                'ms': r['ms'],
                'cost': round(r['estimatedCost'], 4),
                'size': list(result.size),
                'passes': len(r['passes']),
            })
        data.append({'crop': crop_file, 'cropSize': list(crop.size), 'display': list(size), 'entries': entries})

    (out / 'data.json').write_text(json.dumps(data, indent=2), encoding='utf-8')
    print(f'{len(data)} crops, {sum(len(d["entries"]) for d in data)} images -> {out}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('usage: eval-report.py eval/runs/<timestamp>')
    main(sys.argv[1])
