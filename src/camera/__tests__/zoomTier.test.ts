import { isAiReconstructed, zoomTier } from '../zoomTier';

// Samsung: 5x optical cap, ~13.9x native-pixel limit.
const CAP = 5;
const NATIVE = 13.86;

describe('zoomTier', () => {
  it('is optical up to the longest lens, including the lens itself', () => {
    expect(zoomTier(1, CAP, NATIVE)).toBe('optical');
    expect(zoomTier(5, CAP, NATIVE)).toBe('optical');
    expect(zoomTier(5.05, CAP, NATIVE)).toBe('optical');
  });

  it('is AI zoom past the lens, up to the native-pixel limit', () => {
    expect(zoomTier(5.1, CAP, NATIVE)).toBe('ai');
    expect(zoomTier(10, CAP, NATIVE)).toBe('ai');
    expect(zoomTier(13.9, CAP, NATIVE)).toBe('ai');
  });

  it('is AI-reconstructed past the native-pixel limit', () => {
    expect(zoomTier(14, CAP, NATIVE)).toBe('reconstructed');
    expect(zoomTier(100, CAP, NATIVE)).toBe('reconstructed');
  });

  it('goes straight from optical to reconstructed when there is no AI-zoom headroom', () => {
    expect(zoomTier(1.2, 1, 1)).toBe('reconstructed');
  });
});

describe('isAiReconstructed', () => {
  it('marks captures beyond the native-pixel limit', () => {
    expect(isAiReconstructed(40, NATIVE)).toBe(true);
    expect(isAiReconstructed(10, NATIVE)).toBe(false);
    expect(isAiReconstructed(NATIVE, NATIVE)).toBe(false);
  });
});
