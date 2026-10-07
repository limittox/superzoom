import { enhanceHandlers } from '@/server/routeDeps';

/** Submits an enhancement job and returns its ID (specs/image-enhancement: Enhancement request). */
export function POST(request: Request): Promise<Response> {
  return enhanceHandlers().submit(request);
}
