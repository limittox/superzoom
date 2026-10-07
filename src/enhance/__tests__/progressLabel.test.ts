import { progressLabel } from '../progressLabel';

describe('progressLabel', () => {
  it('names each phase of a job with the mode', () => {
    expect(progressLabel('submitting', 'enhance')).toBe('Uploading for Enhance…');
    expect(progressLabel('queued', 'pro')).toBe('Queued for Pro…');
    expect(progressLabel('processing', 'creative')).toBe('Enhancing with Creative…');
    expect(progressLabel('finishing', 'pro')).toBe('Finishing Pro (second pass)…');
  });
});
