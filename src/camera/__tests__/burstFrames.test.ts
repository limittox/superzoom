import { centerRegion, copyRegion } from '../burstFrames';

describe('centerRegion', () => {
  it('takes the centre the preview shows, plus a margin', () => {
    // 30x on the 5x lens: 6x digital, so 1/6 of the frame plus 25%.
    expect(centerRegion(4032, 3024, 6)).toEqual({ x: 1596, y: 1197, width: 840, height: 630 });
  });

  it('never exceeds the frame', () => {
    expect(centerRegion(4032, 3024, 1)).toEqual({ x: 0, y: 0, width: 4032, height: 3024 });
    expect(centerRegion(4032, 3024, 1.1)).toEqual({ x: 0, y: 0, width: 4032, height: 3024 });
  });
});

describe('copyRegion', () => {
  it('copies the region row by row, skipping row padding', () => {
    // A 4x3 frame, 4 bytes per pixel, rows padded to 20 bytes; each pixel stores its x and y.
    const bytesPerRow = 20;
    const pixels = new Uint8Array(bytesPerRow * 3);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 4; x++) pixels.set([x, y, 0, 255], y * bytesPerRow + x * 4);
    }
    const out = copyRegion(pixels, bytesPerRow, { x: 1, y: 1, width: 2, height: 2 });
    expect([...out]).toEqual([1, 1, 0, 255, 2, 1, 0, 255, 1, 2, 0, 255, 2, 2, 0, 255]);
  });
});
