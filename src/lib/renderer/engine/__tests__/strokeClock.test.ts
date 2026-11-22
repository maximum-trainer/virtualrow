// #720 VP-02 — the stroke clock replaces the stateless
// `strokePhase(cadence, elapsed)` with an integrator so a 1-spm
// cadence wobble can't jump the pose.

import { describe, expect, it } from 'vitest';
import {
  CADENCE_SMOOTH_TIME_CONSTANT_SECONDS,
  MAX_STEP_DT_SECONDS,
  MIN_CADENCE_SPM,
  createStrokeClock,
  resetStrokeClock,
  stepStrokeClock,
} from '../strokeClock';

describe('createStrokeClock (#720 FR1/FR3-FR5)', () => {
  it('starts at phase 0 with no cadence seeded', () => {
    const c = createStrokeClock();
    expect(c.phase).toBe(0);
    expect(c.smoothedCadenceSpm).toBe(0);
  });

  it('FR1: integrates phase at the smoothed cadence', () => {
    const c = createStrokeClock();
    // 60 spm = 1 Hz. One second at 60 spm = one full stroke; step in
    // 20 ms chunks so the dt clamp (FR4) doesn't swallow the rate.
    let phase = 0;
    for (let i = 0; i < 50; i += 1) {
      phase = stepStrokeClock(c, { cadence: 60, dtSeconds: 0.02, isPlaying: true });
    }
    expect(phase).toBeCloseTo(0, 3);
    for (let i = 0; i < 25; i += 1) {
      phase = stepStrokeClock(c, { cadence: 60, dtSeconds: 0.02, isPlaying: true });
    }
    expect(phase).toBeCloseTo(0.5, 3);
  });

  it('FR1: a cadence change alters the rate, never the current phase', () => {
    const c = createStrokeClock();
    // Pre-warm to 24 spm so the smoothed cadence is settled.
    for (let i = 0; i < 50; i += 1) stepStrokeClock(c, { cadence: 24, dtSeconds: 0.1, isPlaying: true });
    const phaseBefore = c.phase;
    // One 16.7 ms frame at a stepped-up cadence — the phase must only
    // advance by ~dt × rate (new smoothed cadence still basically 24).
    const phaseAfter = stepStrokeClock(c, { cadence: 25, dtSeconds: 0.0167, isPlaying: true });
    const delta = (phaseAfter - phaseBefore + 1) % 1;
    expect(delta).toBeLessThan(0.02); // ≪ one stroke
    // The stateless version would have moved phase by
    // elapsedSeconds * (25-24)/60 — roughly 0.08 strokes at t=5 s.
  });

  it('FR3: !isPlaying freezes the phase in place', () => {
    const c = createStrokeClock();
    for (let i = 0; i < 20; i += 1) stepStrokeClock(c, { cadence: 30, dtSeconds: 0.1, isPlaying: true });
    const held = c.phase;
    for (let i = 0; i < 10; i += 1) {
      stepStrokeClock(c, { cadence: 30, dtSeconds: 0.1, isPlaying: false });
    }
    expect(c.phase).toBe(held);
  });

  it('FR3: resetStrokeClock returns phase and smoothed cadence to 0', () => {
    const c = createStrokeClock();
    stepStrokeClock(c, { cadence: 30, dtSeconds: 5, isPlaying: true });
    expect(c.phase).not.toBe(0);
    expect(c.smoothedCadenceSpm).toBeGreaterThan(0);
    resetStrokeClock(c);
    expect(c.phase).toBe(0);
    expect(c.smoothedCadenceSpm).toBe(0);
  });

  it(`FR4: dt clamped to ${MAX_STEP_DT_SECONDS}s so a tab-resume cannot skip strokes`, () => {
    const c = createStrokeClock();
    // Seed the clock.
    stepStrokeClock(c, { cadence: 60, dtSeconds: 0.016, isPlaying: true });
    const before = c.phase;
    // 10-second dt (a long background tab) must only advance the clamped amount.
    const after = stepStrokeClock(c, { cadence: 60, dtSeconds: 10, isPlaying: true });
    const delta = (after - before + 1) % 1;
    // Max dt = 0.1 s × 60 spm / 60 = 0.1 strokes.
    expect(delta).toBeCloseTo(0.1, 6);
  });

  it('FR4: handles non-finite dt gracefully', () => {
    const c = createStrokeClock();
    const phase = stepStrokeClock(c, { cadence: 30, dtSeconds: NaN, isPlaying: true });
    expect(phase).toBe(0);
  });

  it('FR5: cadence is smoothed with a ~1 s first-order lag', () => {
    const c = createStrokeClock();
    // Seed at 20 spm.
    stepStrokeClock(c, { cadence: 20, dtSeconds: 0.016, isPlaying: true });
    expect(c.smoothedCadenceSpm).toBeCloseTo(20, 6);
    // Step the cadence to 40 spm; one 0.016 s frame moves the smoothed
    // cadence by (1 - exp(-0.016 / 1.0)) × (40 - 20) ≈ 0.317 spm.
    stepStrokeClock(c, { cadence: 40, dtSeconds: 0.016, isPlaying: true });
    const expectedAlpha = 1 - Math.exp(-0.016 / CADENCE_SMOOTH_TIME_CONSTANT_SECONDS);
    expect(c.smoothedCadenceSpm - 20).toBeCloseTo(expectedAlpha * 20, 3);
  });

  it(`honours the ${MIN_CADENCE_SPM} spm floor`, () => {
    const c = createStrokeClock();
    stepStrokeClock(c, { cadence: 0, dtSeconds: 0.016, isPlaying: true });
    expect(c.smoothedCadenceSpm).toBeCloseTo(MIN_CADENCE_SPM, 6);
  });

  it('phase stays in [0, 1) across many strokes', () => {
    const c = createStrokeClock();
    for (let i = 0; i < 10_000; i += 1) {
      const phase = stepStrokeClock(c, { cadence: 30, dtSeconds: 0.016, isPlaying: true });
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(1);
    }
  });

  it('matches the Gherkin: 0.40 phase at 24 spm + 16.7 ms at 25 spm → ~0.407', () => {
    const c = createStrokeClock();
    // Drive to phase 0.40 at 24 spm. At 24 spm, one stroke is 2.5 s,
    // so phase 0.40 lands after 1 s. Advance in 50 × 20 ms chunks so
    // the smoothed cadence is firmly at 24.
    for (let i = 0; i < 50; i += 1) stepStrokeClock(c, { cadence: 24, dtSeconds: 0.02, isPlaying: true });
    // Nudge phase exactly to 0.4 so the Gherkin assertion is exact.
    c.phase = 0.4;
    const next = stepStrokeClock(c, { cadence: 25, dtSeconds: 0.0167, isPlaying: true });
    expect(next).toBeCloseTo(0.407, 2);
  });
});
