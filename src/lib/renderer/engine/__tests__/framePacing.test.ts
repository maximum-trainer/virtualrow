import { describe, expect, it } from 'vitest';
import {
  FRAME_PACING_CAPACITY,
  createFramePacing,
  recordFrameDt,
  summariseFramePacing,
} from '../framePacing';

// #737 VP-19 FR3 — a 600-sample ring buffer of frame intervals, summarised
// as the percentiles a frame-pacing gate reads.

describe('frame pacing (#737 FR3)', () => {
  it('Scenario: pacing is published', () => {
    const pacing = createFramePacing();
    for (let i = 0; i < 599; i += 1) recordFrameDt(pacing, 16.7);
    recordFrameDt(pacing, 80);
    const s = summariseFramePacing(pacing);
    expect(s.samples).toBe(600);
    expect(s.max).toBe(80);
    expect(s.over50ms).toBe(1);
    expect(s.over25ms).toBe(1);
    expect(s.p50).toBeCloseTo(16.7, 1);
    expect(s.p95).toBeCloseTo(16.7, 1);
    expect(s.longestStallMs).toBe(80);
  });

  it('keeps only the last 600 frames, but remembers the longest stall', () => {
    const pacing = createFramePacing();
    recordFrameDt(pacing, 200);
    for (let i = 0; i < FRAME_PACING_CAPACITY; i += 1) recordFrameDt(pacing, 10);
    const s = summariseFramePacing(pacing);
    expect(s.samples).toBe(FRAME_PACING_CAPACITY);
    expect(s.max).toBe(10);
    expect(s.over25ms).toBe(0);
    expect(s.longestStallMs).toBe(200);
  });

  it('reads percentiles by nearest rank', () => {
    const pacing = createFramePacing();
    for (let i = 1; i <= 100; i += 1) recordFrameDt(pacing, i);
    const s = summariseFramePacing(pacing);
    expect(s.p50).toBe(50);
    expect(s.p95).toBe(95);
    expect(s.p99).toBe(99);
    expect(s.max).toBe(100);
  });

  it('is all zeros before any frame, and ignores a non-finite or negative dt', () => {
    const pacing = createFramePacing();
    recordFrameDt(pacing, Number.NaN);
    recordFrameDt(pacing, -5);
    expect(summariseFramePacing(pacing)).toEqual({
      samples: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
      over25ms: 0,
      over50ms: 0,
      longestStallMs: 0,
    });
  });

  it('writes into the summary it is given instead of allocating one', () => {
    const pacing = createFramePacing();
    recordFrameDt(pacing, 16);
    const out = summariseFramePacing(pacing);
    recordFrameDt(pacing, 40);
    expect(summariseFramePacing(pacing, out)).toBe(out);
    expect(out.max).toBe(40);
  });
});
