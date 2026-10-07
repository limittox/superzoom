import { create } from 'zustand';

import type { EnhanceErrorCode, EnhanceMode } from '@/shared/enhance';

export interface LocalImage {
  uri: string;
  width: number;
  height: number;
}

export interface EnhanceFailure {
  code: EnhanceErrorCode | 'network' | 'cancelled';
  message: string;
  retryAt?: string;
}

/** Where a pending enhancement is: uploading, waiting in the provider's queue, enhancing, or on its second pass. */
export type EnhancePhase = 'submitting' | 'queued' | 'processing' | 'finishing';

/** What Retry needs to pick up where a request left off. */
export interface RequestHandles {
  /** The job, once the service has accepted it. */
  jobId?: string;
  /** The submission's ID; resubmitting with it returns the same job instead of starting another. */
  requestId?: string;
}

export type RequestState =
  | { status: 'idle' }
  | ({ status: 'pending'; id: number; mode: EnhanceMode; phase: EnhancePhase } & RequestHandles)
  /** Handles are kept when the job may still exist (a network failure), so Retry resumes it. */
  | ({ status: 'error'; mode: EnhanceMode; error: EnhanceFailure } & RequestHandles);

interface SessionState {
  /** Full-resolution crop; used for the comparison and for saving. */
  original: LocalImage | null;
  /** The ≤ 4 MP copy sent to the server. */
  upload: LocalImage | null;
  results: Partial<Record<EnhanceMode, LocalImage>>;
  /** Mode whose result is currently shown. */
  shownMode: EnhanceMode | null;
  request: RequestState;
  saved: { original: boolean; enhanced: Partial<Record<EnhanceMode, boolean>> };
  /** Display zoom when the photo was taken, restored on return to the camera. */
  captureZoom: number;
  /** Development builds only: which lens took the photo (EXIF lens check). */
  devLensNote: string | null;
  /** Captured beyond the native-pixel limit, so results are labeled AI-reconstructed. */
  aiReconstructed: boolean;

  startSession(original: LocalImage, upload: LocalImage, captureZoom: number, aiReconstructed?: boolean): void;
  /** Returns a request ID; results for any other ID are ignored. Pass a `jobId` to resume an existing job. */
  beginRequest(mode: EnhanceMode, handles?: RequestHandles): number;
  /** Updates a pending request's phase or job ID; ignored for a cancelled or superseded request. */
  updateRequest(id: number, patch: { phase?: EnhancePhase; jobId?: string }): void;
  /** Returns false (and stores nothing) if the request was cancelled or superseded. */
  resolveRequest(id: number, mode: EnhanceMode, result: LocalImage): boolean;
  failRequest(id: number, mode: EnhanceMode, error: EnhanceFailure, handles?: RequestHandles): void;
  cancelRequest(): void;
  showMode(mode: EnhanceMode): void;
  markSaved(what: { original?: boolean; enhancedMode?: EnhanceMode }): void;
  clear(): void;
}

let nextRequestId = 1;

/** The handles that are set, so unset ones don't appear as `undefined` keys. */
const defined = ({ jobId, requestId }: RequestHandles): RequestHandles => ({
  ...(jobId ? { jobId } : {}),
  ...(requestId ? { requestId } : {}),
});

const empty = {
  original: null,
  upload: null,
  results: {},
  shownMode: null,
  request: { status: 'idle' } as RequestState,
  saved: { original: false, enhanced: {} },
  devLensNote: null as string | null,
  aiReconstructed: false,
};

export const useSession = create<SessionState>()((set, get) => ({
  ...empty,
  captureZoom: 1,

  startSession: (original, upload, captureZoom, aiReconstructed = false) =>
    set({ ...empty, original, upload, captureZoom, aiReconstructed }),

  beginRequest: (mode, handles = {}) => {
    const id = nextRequestId++;
    set({ request: { status: 'pending', id, mode, phase: handles.jobId ? 'queued' : 'submitting', ...defined(handles) } });
    return id;
  },

  updateRequest: (id, patch) => {
    const { request } = get();
    if (request.status !== 'pending' || request.id !== id) return;
    set({ request: { ...request, ...patch } });
  },

  resolveRequest: (id, mode, result) => {
    const { request, results } = get();
    if (request.status !== 'pending' || request.id !== id) return false;
    set({ results: { ...results, [mode]: result }, shownMode: mode, request: { status: 'idle' } });
    return true;
  },

  failRequest: (id, mode, error, handles = {}) => {
    const { request } = get();
    if (request.status !== 'pending' || request.id !== id) return;
    set({ request: { status: 'error', mode, error, ...defined(handles) } });
  },

  cancelRequest: () => {
    if (get().request.status !== 'idle') set({ request: { status: 'idle' } });
  },

  showMode: (mode) => {
    if (get().results[mode]) set({ shownMode: mode });
  },

  markSaved: ({ original, enhancedMode }) => {
    const { saved } = get();
    set({
      saved: {
        original: saved.original || !!original,
        enhanced: enhancedMode ? { ...saved.enhanced, [enhancedMode]: true } : saved.enhanced,
      },
    });
  },

  clear: () => set({ ...empty }),
}));

/** True if an enhanced image exists that the user hasn't saved. */
export function hasUnsavedEnhancement(state: Pick<SessionState, 'results' | 'saved'>): boolean {
  return (Object.keys(state.results) as EnhanceMode[]).some((mode) => !state.saved.enhanced[mode]);
}
