import { describe, expect, it } from 'vitest';
import {
  ALWAYS_REVEALED,
  packRevealUniform,
  revealAlpha,
  SCENERY_REVEAL_SECONDS,
  SCENERY_VISIBILITY_METRES,
} from '../sceneryReveal';

// #726 VP-08 FR3 — a model registered mid-ride fades in per instance over
// 1.5 s instead of appearing at full opacity; the shader mirrors this.
describe('revealAlpha (#726 FR3)', () => {
  it('is 0 on the frame the model registers', () => {
    expect(revealAlpha(10, 10, 50)).toBe(0);
  });

  it('ramps linearly over SCENERY_REVEAL_SECONDS', () => {
    expect(SCENERY_REVEAL_SECONDS).toBe(1.5);
    expect(revealAlpha(10.75, 10, 50)).toBeCloseTo(0.5, 6);
    expect(revealAlpha(11.5, 10, 50)).toBe(1);
    expect(revealAlpha(30, 10, 50)).toBe(1);
  });

  it('never goes negative before the reveal time', () => {
    expect(revealAlpha(9, 10, 50)).toBe(0);
  });

  it('skips the fade beyond the visibility distance', () => {
    expect(revealAlpha(10, 10, SCENERY_VISIBILITY_METRES + 1)).toBe(1);
    expect(revealAlpha(10, 10, SCENERY_VISIBILITY_METRES)).toBe(0);
  });

  it('treats ALWAYS_REVEALED as fully visible from the first frame', () => {
    expect(revealAlpha(0, ALWAYS_REVEALED, 0)).toBe(1);
  });

  it('takes a custom fade length and visibility', () => {
    expect(revealAlpha(1, 0, 5, { fadeSeconds: 2, visibilityMetres: 100 })).toBeCloseTo(0.5, 6);
    expect(revealAlpha(0, 0, 101, { fadeSeconds: 2, visibilityMetres: 100 })).toBe(1);
  });
});

describe('packRevealUniform (#726 FR3)', () => {
  it('packs reveal time, fade seconds and visibility for the shader', () => {
    const out = packRevealUniform(12.5);
    expect(Array.from(out)).toEqual([12.5, SCENERY_REVEAL_SECONDS, SCENERY_VISIBILITY_METRES, 0]);
  });

  it('writes into a supplied array', () => {
    const out = new Float32Array(4);
    expect(packRevealUniform(3, out)).toBe(out);
    expect(out[0]).toBe(3);
  });
});
