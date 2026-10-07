import { enhanceHandlers } from '@/server/routeDeps';

/** Submits an enhancement job and returns its ID (specs/image-enhancement: Enhancement request). */
export function POST(request: Request): Promise<Response> {
  return enhanceHandlers().submit(request);
}

/** Cancels a submission by its `requestId` query parameter, for when the app never received the job ID. */
export function DELETE(request: Request): Promise<Response> {
  return enhanceHandlers().cancelSubmission(request);
}
