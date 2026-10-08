import { burstSaverFromEnv } from '@/server/burstSaver';

const handler = burstSaverFromEnv(process.env);

/** Development only: saves a burst-capture experiment to `SAVE_BURSTS_DIR` (docs/capture-spike.md). */
export function POST(request: Request): Promise<Response> | Response {
  if (!handler) return Response.json({ error: 'Not found.' }, { status: 404 });
  return handler(request);
}
