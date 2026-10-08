# Model evaluation

How to compare enhancement models on real crops from the phone, before changing `MODEL_TABLE` in [`src/server/upscaler/fal.ts`](../src/server/upscaler/fal.ts). Everything here is development tooling: nothing ships in the app or the hosted backend.

## 1. Collect crops

Start the dev server with `SAVE_UPLOADS_DIR` set, and it keeps a copy of every upload it accepts:

```powershell
$env:REACT_NATIVE_PACKAGER_HOSTNAME = '192.168.1.120'   # the PC's LAN address
$env:SAVE_UPLOADS_DIR = 'D:/code/superzoom/eval/crops'
npx expo start --port 8081
```

Take photos in the app as usual (Enhance mode is cheapest). Each upload is saved as `eval/crops/<time>-<mode>-<width>x<height>.jpg`: exactly what the models receive, after the app's own resizing (crops over 4 MP are scaled down; crops under 128 px on the short side are enlarged). The variable is ignored outside development, and `eval/` is git-ignored.

A useful set covers text, faces, foliage, buildings, fine textures and dim light, at 10x, 30x and 100x.

## 2. Run the candidates

```powershell
node scripts/eval-upscalers.mjs --dry-run                  # list every run and the estimated cost
node scripts/eval-upscalers.mjs --out eval/runs/<name>     # run them (spends fal credit)
```

Options:
- `--only id1,id2`: limit the candidates.
- `--max-crop-mp 0.3`: only the small crops (30x and beyond).
- `--max-mp 4`: output cap.
- `--concurrency 3`: requests in flight.

The candidates and their fal parameters are listed in `CANDIDATES` at the top of the script. Each crop is uploaded once, run through each candidate, and the results are downloaded to the run folder with `results.json` (time, passes, estimated cost, errors).

Notes:
- Outputs are capped at about 4 MP, or a minimum of 2x, instead of production's 16 MP. That's enough to judge detail and much cheaper.
- Models limited to 4x per request run two passes for bigger factors, as production does. A second pass under 1.25x is skipped in favor of one full 4x pass.
- SeedVR2 keeps production's rule for inputs under 256 px: the output is capped at 1920 × 1080.
- Costs are estimates from fal's pricing pages and run high for two-pass Topaz runs.

## 3. Compare

```powershell
python scripts/eval-report.py eval/runs/<name>
```

This writes same-size display copies of every result to `eval/runs/<name>/report/`, plus `data.json`, with a plain bicubic enlargement as the "no AI" baseline. The comparison page (the "Upscaler Bake-off" artifact) shows two results side by side with synced zoom and pan, a contact sheet of every result at the same region, and a picks summary to paste back into the chat.

## Results

| Date | Run | Crops | Candidates | Outcome |
|---|---|---|---|---|
| 2026-10-08 | `small-1` | 4 small crops: text, building and texture at 30x, far detail at 100x | 10 | Picked: SeedVR2 with `noise_scale` 0.3 for text and far detail; Topaz Generative Recovery V2 for building and texture. Never picked: the current Pro (Topaz High Fidelity V2) and Creative (Clarity). Recraft Crisp and AuraSR were barely better than bicubic. Nothing recovers real detail at 100x. |
| 2026-10-08 | `large-1` | 4 larger crops: text, foliage and dim light at 10x, face at 4.6x | 4 finalists | `noise_scale` 0.3 also better at 10x. |
| 2026-10-08 | `qwen-1` | all 8 | Qwen Image 3 Edit (`alibaba/qwen-image-3/edit`), "restore, keep everything" prompt | Barely better than bicubic, sometimes shifts the framing, capped at 2048 px per side (about 2 MP), 27–130 s per image. Not used. |

**Outcome (2026-10-08):** Enhance → SeedVR2 with `noise_scale` 0.3; Pro → Topaz Precision Low Resolution V2 (the most faithful, matching Pro's "highest fidelity"); Creative → Topaz Generative Recovery V2 (rebuilds texture, invents some). Cost about $4.30 in fal credit for the three runs.
