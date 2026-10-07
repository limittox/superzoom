import type { EnhanceMode } from '@/shared/enhance';
import type { EnhancePhase } from '@/state/session';

import { MODE_LABELS } from './messages';

/** Progress text while a job runs (specs/enhanced-photo-review: Automatic enhancement after capture). */
export function progressLabel(phase: EnhancePhase, mode: EnhanceMode): string {
  const title = MODE_LABELS[mode].title;
  switch (phase) {
    case 'submitting':
      return `Uploading for ${title}…`;
    case 'queued':
      return `Queued for ${title}…`;
    case 'processing':
      return `Enhancing with ${title}…`;
    case 'finishing':
      return `Finishing ${title} (second pass)…`;
  }
}
