import { readBodyWithLimit } from './enhanceHandler';
import type { UploadFs } from './uploadSaver';

/** A burst is at most a few dozen frames of a zoomed crop. */
export const MAX_BURST_BYTES = 96 * 1024 * 1024;
const BURST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FRAME_NAME = /^(photo|video|normal|night)-\d{2}\.(jpg|rgba)$/;

const nodeFs = (): Promise<UploadFs> => import('node:fs/promises');

interface MultipartForm {
  get(name: string): Blob | string | null;
  forEach(callback: (value: Blob | string, name: string) => void): void;
}

const json = (status: number, body: unknown) => Response.json(body, { status });

/**
 * `POST /api/dev/burst`: saves a capture experiment (a burst, docs/capture-spike.md, or a Night A/B pair) to
 * `<dir>/<burst id>/`: `meta.json` plus one file per frame. Development only: the route answers
 * 404 unless `SAVE_BURSTS_DIR` is set in development (`burstSaverFromEnv`).
 */
export function createBurstHandler(dir: string, loadFs: () => Promise<UploadFs> = nodeFs) {
  return async function POST(request: Request): Promise<Response> {
    let form: MultipartForm;
    try {
      const body = await readBodyWithLimit(request, MAX_BURST_BYTES);
      form = (await new Response(body as BodyInit, {
        headers: { 'content-type': request.headers.get('content-type') ?? '' },
      }).formData()) as unknown as MultipartForm;
    } catch {
      return json(400, { error: 'Expected a multipart burst of at most 96 MB.' });
    }

    const metaText = form.get('meta');
    let meta: { id?: unknown };
    try {
      meta = JSON.parse(typeof metaText === 'string' ? metaText : '');
    } catch {
      return json(400, { error: 'Missing or invalid "meta" JSON.' });
    }
    if (typeof meta.id !== 'string' || !BURST_ID.test(meta.id)) return json(400, { error: 'Invalid burst id.' });

    const frames: [string, Blob][] = [];
    form.forEach((value, name) => {
      if (name !== 'meta' && typeof value !== 'string' && FRAME_NAME.test(name)) frames.push([name, value]);
    });
    if (frames.length === 0) return json(400, { error: 'No frames.' });

    const fs = await loadFs();
    const folder = `${dir.replace(/[\\/]+$/, '')}/${meta.id}`;
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(`${folder}/meta.json`, new TextEncoder().encode(JSON.stringify(meta, null, 2)));
    for (const [name, blob] of frames) {
      await fs.writeFile(`${folder}/${name}`, new Uint8Array(await blob.arrayBuffer()));
    }
    console.info(`[burst] saved ${frames.length} frames to ${folder}`);
    return json(200, { id: meta.id, frames: frames.length });
  };
}

/** The burst route handler in development with `SAVE_BURSTS_DIR` set; otherwise none (the route answers 404). */
export function burstSaverFromEnv(env: Record<string, string | undefined>) {
  return env.NODE_ENV === 'development' && env.SAVE_BURSTS_DIR ? createBurstHandler(env.SAVE_BURSTS_DIR) : undefined;
}
