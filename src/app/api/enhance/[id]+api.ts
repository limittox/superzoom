import { enhanceHandlers } from '@/server/routeDeps';

/** Reports an enhancement job, advancing it first (specs/image-enhancement: Job status and result). */
export function GET(request: Request, { id }: Record<string, string>): Promise<Response> {
  return enhanceHandlers().status(request, id);
}

/** Cancels an enhancement job and its queued provider work. */
export function DELETE(request: Request, { id }: Record<string, string>): Promise<Response> {
  return enhanceHandlers().cancel(request, id);
}
