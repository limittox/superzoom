#!/usr/bin/env node
/**
 * Model evaluation: runs every crop in a folder through a set of fal upscalers and settings,
 * downloads the results, and records size, time and estimated cost. See docs/model-evaluation.md.
 *
 *   node scripts/eval-upscalers.mjs --dry-run            # list the runs and the estimated cost
 *   node scripts/eval-upscalers.mjs                      # run them (spends fal credit)
 *   node scripts/eval-upscalers.mjs --only topaz-lowres-v2,seedvr2 --crops eval/crops
 *   node scripts/eval-upscalers.mjs --max-crop-mp 0.3   # only the small (extreme-zoom) crops
 *   node scripts/eval-upscalers.mjs --min-crop-mp 0.3   # only the larger crops
 *
 * Reads FAL_KEY from the environment or .env.local. Outputs go to eval/runs/<timestamp>/.
 * Crops come from the dev server's upload saver (SAVE_UPLOADS_DIR), whose file names end in
 * `-<width>x<height>.jpg`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { createFalClient } from '@fal-ai/client';

// ---------------------------------------------------------------------------------------------
// Settings

const args = parseArgs(process.argv.slice(2));
const CROPS_DIR = args.crops ?? 'eval/crops';
const OUT_DIR = args.out ?? join('eval', 'runs', timestamp());
/** Output cap for the evaluation (production allows 16 MP); keeps cost down, enough to judge detail. */
const MAX_OUTPUT_PIXELS = Number(args['max-mp'] ?? 4) * 1_000_000;
const MAX_UPSCALE = 10;
const MIN_UPSCALE = 2;
const CONCURRENCY = Number(args.concurrency ?? 3);
const DRY_RUN = 'dry-run' in args;

/**
 * Candidates. `maxFactor` is the most one request accepts (two passes beyond it);
 * `fixedFactor` models ignore the planned factor; `png` models need PNG input;
 * `cost(outputMp, passes)` estimates fal's price in USD from its pricing pages (2026-10).
 */
const CANDIDATES = [
  {
    id: 'seedvr2',
    label: 'SeedVR2 (Enhance today)',
    endpoint: 'fal-ai/seedvr/upscale/image',
    maxFactor: 10,
    smallInput: true,
    input: (url, f) => ({ image_url: url, upscale_mode: 'factor', upscale_factor: f, output_format: 'jpg' }),
    cost: (mp) => 0.001 * mp,
  },
  {
    id: 'seedvr2-noise03',
    label: 'SeedVR2, noise_scale 0.3',
    endpoint: 'fal-ai/seedvr/upscale/image',
    maxFactor: 10,
    smallInput: true,
    input: (url, f) => ({ image_url: url, upscale_mode: 'factor', upscale_factor: f, output_format: 'jpg', noise_scale: 0.3 }),
    cost: (mp) => 0.001 * mp,
  },
  {
    id: 'topaz-hf2-legacy',
    label: 'Topaz High Fidelity V2 (Pro today)',
    endpoint: 'fal-ai/topaz/upscale/image',
    maxFactor: 4,
    input: (url, f) => ({ image_url: url, model: 'High Fidelity V2', upscale_factor: f, output_format: 'jpeg', face_enhancement_creativity: 0 }),
    cost: (_mp, passes) => 0.08 * passes,
  },
  {
    id: 'topaz-lowres-v2',
    label: 'Topaz Precision, Low Resolution V2',
    endpoint: 'topaz/upscale/image/precision',
    maxFactor: 4,
    input: (url, f) => ({ image_url: url, model: 'Low Resolution V2', upscale_factor: f, output_format: 'jpeg', face_enhancement_creativity: 0 }),
    cost: (_mp, passes) => 0.08 * passes,
  },
  {
    id: 'topaz-hf3',
    label: 'Topaz Precision, High Fidelity V3',
    endpoint: 'topaz/upscale/image/precision',
    maxFactor: 4,
    input: (url, f) => ({ image_url: url, model: 'High Fidelity V3', upscale_factor: f, output_format: 'jpeg', face_enhancement_creativity: 0 }),
    cost: (_mp, passes) => 0.08 * passes,
  },
  {
    id: 'topaz-recovery-v2',
    label: 'Topaz Generative, Recovery V2',
    endpoint: 'topaz/upscale/image/generative',
    maxFactor: 4,
    input: (url, f) => ({ image_url: url, model: 'Recovery V2', upscale_factor: f, output_format: 'jpeg', face_enhancement_creativity: 0 }),
    cost: (mp, passes) => 0.08 * passes * Math.max(1, Math.ceil(mp / 4)),
  },
  {
    id: 'topaz-recover3',
    label: 'Topaz Generative, Recover 3',
    endpoint: 'topaz/upscale/image/generative',
    maxFactor: 4,
    input: (url, f) => ({ image_url: url, model: 'Recover 3', upscale_factor: f, output_format: 'jpeg', face_enhancement_creativity: 0 }),
    cost: (mp, passes) => 0.08 * passes * Math.max(1, Math.ceil(mp / 4)),
  },
  {
    id: 'clarity',
    label: 'Clarity (Creative today)',
    endpoint: 'fal-ai/clarity-upscaler',
    maxFactor: 4,
    input: (url, f) => ({ image_url: url, upscale_factor: f }),
    cost: (mp) => 0.03 * mp,
  },
  {
    id: 'recraft-crisp',
    label: 'Recraft Crisp',
    endpoint: 'fal-ai/recraft/upscale/crisp',
    fixedFactor: true,
    png: true,
    input: (url) => ({ image_url: url }),
    cost: () => 0.004,
  },
  {
    // A prompt-driven image editor, not an upscaler: it gets the crop enlarged to the output size
    // (it needs 384â€“2048 px per side) and an explicit image_size, and is told to restore it.
    id: 'qwen-image3-edit',
    label: 'Qwen Image 3 Edit (restore prompt)',
    endpoint: 'alibaba/qwen-image-3/edit',
    edit: { maxSide: 2048, minSide: 384, maxPixels: 4_000_000 },
    input: (url, _f, size) => ({
      image_urls: [url],
      prompt:
        'Restore this zoomed-in photo: make it sharp and clear, recover fine detail and texture, and remove blur, ' +
        'noise and compression artifacts. Keep exactly the same scene, framing, composition, colors and any text. ' +
        'Do not add, remove or move anything.',
      negative_prompt: 'blurry, noisy, jpeg artifacts, extra objects, changed text, cartoon, painting, illustration',
      image_size: size,
      enable_prompt_expansion: false,
      output_format: 'jpeg',
      num_images: 1,
    }),
    // $0.04 per image at 1K, $0.075 at 2K.
    cost: (mp) => (mp > 1.1 ? 0.075 : 0.04),
  },
  {
    id: 'aura-sr',
    label: 'AuraSR v2 (4x)',
    endpoint: 'fal-ai/aura-sr',
    fixedFactor: true,
    input: (url) => ({ image_url: url, upscale_factor: 4, checkpoint: 'v2', overlapping_tiles: true }),
    cost: () => 0.001,
    // Fixed at 4x: only worth comparing on small crops.
    maxInputMp: 1,
  },
];

// ---------------------------------------------------------------------------------------------
// Planning (mirrors src/shared/upscale.ts and planForModel / planPasses in src/server/upscaler/fal.ts)

function planFactor(candidate, width, height) {
  let factor = Math.min(MAX_UPSCALE, Math.sqrt(MAX_OUTPUT_PIXELS / (width * height)));
  if (candidate.smallInput && Math.min(width, height) < 256) {
    // SeedVR2: inputs under 256 px may not produce more than 1080p.
    factor = Math.min(factor, 1920 / Math.max(width, height), 1080 / Math.min(width, height));
  }
  return Math.max(MIN_UPSCALE, factor);
}

function planPasses(factor, maxPerPass) {
  const passes = [];
  let remaining = factor;
  while (remaining > maxPerPass * (1 + 1e-9)) {
    passes.push(maxPerPass);
    remaining /= maxPerPass;
  }
  passes.push(remaining);
  return passes;
}

/** Output size for an editing model: as large as it allows, keeping the crop's aspect ratio. */
function editSize(edit, crop) {
  const { width: w, height: h } = crop;
  const scale = Math.min(edit.maxSide / Math.max(w, h), Math.sqrt(edit.maxPixels / (w * h)));
  const size = { width: Math.round(w * scale), height: Math.round(h * scale) };
  if (Math.min(size.width, size.height) < edit.minSide) throw new Error(`${crop.file} is too narrow for this editing model`);
  return size;
}

function planRun(candidate, crop) {
  if (candidate.edit) {
    const size = editSize(candidate.edit, crop);
    const mp = (size.width * size.height) / 1e6;
    return { factor: size.width / crop.width, passes: [1], size, outputMp: mp, cost: candidate.cost(mp) };
  }
  if (candidate.fixedFactor) {
    const factor = candidate.id === 'aura-sr' ? 4 : null;
    const mp = factor ? (crop.width * factor * crop.height * factor) / 1e6 : (crop.width * crop.height * 4) / 1e6;
    return { factor, passes: [factor], outputMp: mp, cost: candidate.cost(mp, 1) };
  }
  let factor = planFactor(candidate, crop.width, crop.height);
  let passes = planPasses(factor, candidate.maxFactor);
  // A second pass of under 1.25x adds little but costs a whole request: do one full pass instead.
  if (passes.length === 2 && passes[1] < 1.25) {
    factor = candidate.maxFactor;
    passes = [factor];
  }
  const outputMp = (crop.width * factor * crop.height * factor) / 1e6;
  return { factor, passes, outputMp, cost: candidate.cost(outputMp, passes.length) };
}

// ---------------------------------------------------------------------------------------------
// Running

async function main() {
  const crops = readdirSync(CROPS_DIR)
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .map((file) => {
      const m = file.match(/-(\d+)x(\d+)\.(jpe?g|png)$/i);
      if (!m) throw new Error(`Can't read the size from ${file}; expected a name ending in -<w>x<h>.jpg`);
      return { file, path: join(CROPS_DIR, file), width: Number(m[1]), height: Number(m[2]) };
    })
    // --max-crop-mp 0.3: only the small crops (extreme zoom), where the model does the most work.
    .filter((c) => !args['max-crop-mp'] || (c.width * c.height) / 1e6 <= Number(args['max-crop-mp']))
    .filter((c) => !args['min-crop-mp'] || (c.width * c.height) / 1e6 > Number(args['min-crop-mp']));
  const only = args.only ? new Set(args.only.split(',')) : null;
  const candidates = CANDIDATES.filter((c) => !only || only.has(c.id));
  if (crops.length === 0) throw new Error(`No crops in ${CROPS_DIR}`);

  const runs = crops.flatMap((crop) =>
    candidates
      .filter((c) => !c.maxInputMp || (crop.width * crop.height) / 1e6 <= c.maxInputMp)
      .map((candidate) => ({ crop, candidate, ...planRun(candidate, crop) })),
  );
  const total = runs.reduce((sum, r) => sum + r.cost, 0);
  console.log(`${crops.length} crops Ã— ${candidates.length} candidates = ${runs.length} runs, about $${total.toFixed(2)}`);
  for (const r of runs) {
    console.log(
      `  ${r.crop.file.padEnd(44)} ${r.candidate.id.padEnd(18)} ` +
        `${r.factor ? `${r.factor.toFixed(2)}x` : 'fixed'} in ${r.passes.length} pass(es) â†’ ${r.outputMp.toFixed(1)} MP  $${r.cost.toFixed(3)}`,
    );
  }
  if (DRY_RUN) return;

  const key = process.env.FAL_KEY ?? readEnvLocal().FAL_KEY;
  if (!key) throw new Error('FAL_KEY is not set (environment or .env.local)');
  const fal = createFalClient({ credentials: key });
  mkdirSync(OUT_DIR, { recursive: true });

  // Upload each crop once (as PNG too, for models that need it).
  const uploads = new Map();
  for (const crop of crops) {
    const jpg = await fal.storage.upload(new Blob([readFileSync(crop.path)], { type: 'image/jpeg' }));
    let png = null;
    if (candidates.some((c) => c.png)) {
      const pngPath = join(OUT_DIR, `${basename(crop.file).replace(/\.\w+$/, '')}.png`);
      execFileSync('python', ['-c', 'import sys;from PIL import Image;Image.open(sys.argv[1]).save(sys.argv[2])', crop.path, pngPath]);
      png = await fal.storage.upload(new Blob([readFileSync(pngPath)], { type: 'image/png' }));
    }
    uploads.set(crop.file, { jpg, png });
  }

  const results = [];
  let next = 0;
  async function worker() {
    while (next < runs.length) {
      const run = runs[next++];
      results.push(await execute(fal, run, uploads.get(run.crop.file)));
      writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const spent = results.reduce((sum, r) => sum + (r.error ? 0 : r.estimatedCost), 0);
  console.log(`Done: ${results.filter((r) => !r.error).length}/${results.length} succeeded, about $${spent.toFixed(2)}. ${OUT_DIR}`);
}

async function execute(fal, run, upload) {
  const { crop, candidate } = run;
  const started = Date.now();
  const record = {
    crop: crop.file,
    cropSize: [crop.width, crop.height],
    candidate: candidate.id,
    label: candidate.label,
    endpoint: candidate.endpoint,
    factor: run.factor,
    passes: run.passes,
    estimatedCost: run.cost,
  };
  try {
    let url = candidate.png ? upload.png : upload.jpg;
    if (run.size) url = await enlargedUpload(fal, crop, run.size);
    let image;
    for (const factor of run.passes) {
      const result = await fal.subscribe(candidate.endpoint, { input: candidate.input(url, factor, run.size) });
      image = result.data?.image ?? result.data?.images?.[0];
      if (!image?.url) throw new Error(`No image in the response: ${JSON.stringify(result.data).slice(0, 300)}`);
      url = image.url;
    }
    const file = `${crop.file.replace(/\.\w+$/, '')}__${candidate.id}.${image.content_type === 'image/png' ? 'png' : 'jpg'}`;
    const bytes = Buffer.from(await (await fetch(image.url)).arrayBuffer());
    writeFileSync(join(OUT_DIR, file), bytes);
    Object.assign(record, { file, width: image.width ?? null, height: image.height ?? null, ms: Date.now() - started });
    console.log(`  ok   ${crop.file} ${candidate.id} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  } catch (err) {
    const body = err?.body ? ` ${JSON.stringify(err.body).slice(0, 300)}` : '';
    Object.assign(record, { error: `${err?.status ?? ''} ${err?.message ?? err}${body}`.trim(), ms: Date.now() - started });
    console.log(`  FAIL ${crop.file} ${candidate.id}: ${record.error}`);
  }
  return record;
}

/** Enlarges a crop locally (Lanczos) to an editing model's output size and uploads it. */
async function enlargedUpload(fal, crop, size) {
  const path = join(OUT_DIR, `${basename(crop.file).replace(/\.\w+$/, '')}__${size.width}x${size.height}.jpg`);
  execFileSync('python', [
    '-c',
    'import sys;from PIL import Image;Image.open(sys.argv[1]).convert("RGB").resize((int(sys.argv[3]),int(sys.argv[4])),Image.Resampling.LANCZOS).save(sys.argv[2],quality=95)',
    crop.path,
    path,
    String(size.width),
    String(size.height),
  ]);
  return fal.storage.upload(new Blob([readFileSync(path)], { type: 'image/jpeg' }));
}

// ---------------------------------------------------------------------------------------------
// Helpers

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const name = a.slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[name] = argv[++i];
    else out[name] = true;
  }
  return out;
}

function readEnvLocal() {
  if (!existsSync('.env.local')) return {};
  return Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
      .filter(Boolean)
      .map(([, k, v]) => [k, v.replace(/^["']|["']$/g, '')]),
  );
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
