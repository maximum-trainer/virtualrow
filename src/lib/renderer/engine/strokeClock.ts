/**
 * Stateful stroke-phase clock (#720 VP-02).
 *
 * The crew pose, oar sweep and oar-splash burst are all driven from a
 * single scalar `phase` in [0, 1). Historically `strokePhase(cadence,
 * elapsed)` rebuilt that phase from scratch each frame as
 * `elapsed * spm / 60 mod 1`, so any change in cadence re-scaled the
 * whole elapsed time and the pose jumped; a 24 → 25 spm step 10 minutes
 * in moves the stateless phase by about a quarter stroke. The PM5 /
 * FTMS / simulator readings wobble by ±1 spm many times a minute, so
 * the athlete sees the rower snap to a new pose every few seconds.
 *
 * This module replaces the stateless function with a small integrator:
 *
 *   phase ← (phase + dt · spm / 60) mod 1
 *
 * A cadence change alters the rate (FR1) and nothing else. Pausing or
 * finishing freezes the phase where it is (FR3). The `dt` fed in is
 * clamped so a background-tab resume can't skip strokes (FR4). The
 * cadence is smoothed with a ~1 s first-order lag (FR5) so a 1-spm
 * step is absorbed over the next second rather than stepping the rate.
 */

export interface StrokeClockState {
  /** Phase in [0, 1); 0 is the catch, 0.5 is the finish. */
  phase: number;
  /** Smoothed cadence in spm; seeded on the first step. */
  smoothedCadenceSpm: number;
}

export interface StepStrokeClock {
  /** Raw cadence from the PM5 / FTMS / sim, in spm. */
  cadence: number;
  /** Time since the previous step. Negative or NaN is treated as 0. */
  dtSeconds: number;
  /** When false (paused, holding, finished) the phase is frozen (FR3). */
  isPlaying: boolean;
}

/** Cadence floor; matches the three-side `useFrame` floor of 18 spm. */
export const MIN_CADENCE_SPM = 18;
/** FR4: a single step never advances more than this many seconds of time. */
export const MAX_STEP_DT_SECONDS = 0.1;
/** FR5: first-order lag time constant for cadence smoothing. */
export const CADENCE_SMOOTH_TIME_CONSTANT_SECONDS = 1.0;

export const createStrokeClock = (): StrokeClockState => ({
  phase: 0,
  smoothedCadenceSpm: 0,
});

/**
 * Advance the clock and return the new phase. Mutates `state` in place
 * so the engine can hold a single instance and call it from the per-
 * frame step. The returned phase is `state.phase`.
 */
export const stepStrokeClock = (state: StrokeClockState, step: StepStrokeClock): number => {
  if (!step.isPlaying) return state.phase;
  const rawDt = Number.isFinite(step.dtSeconds) ? step.dtSeconds : 0;
  const dt = Math.max(0, Math.min(rawDt, MAX_STEP_DT_SECONDS));
  const rawSpm = Math.max(MIN_CADENCE_SPM, Number.isFinite(step.cadence) ? step.cadence : MIN_CADENCE_SPM);
  // Seed the smoothed cadence on the first step so the rate doesn't
  // ramp up from zero at the catch of the very first stroke.
  if (state.smoothedCadenceSpm <= 0) {
    state.smoothedCadenceSpm = rawSpm;
  } else if (dt > 0) {
    const alpha = 1 - Math.exp(-dt / CADENCE_SMOOTH_TIME_CONSTANT_SECONDS);
    state.smoothedCadenceSpm += (rawSpm - state.smoothedCadenceSpm) * alpha;
  }
  const freqHz = state.smoothedCadenceSpm / 60;
  state.phase += dt * freqHz;
  // Modulo 1 that stays in [0, 1) for a positive phase (we never
  // integrate backwards, so no need to handle negative).
  state.phase -= Math.floor(state.phase);
  return state.phase;
};

/** Reset the clock to its initial state (FR3 — new session). */
export const resetStrokeClock = (state: StrokeClockState): void => {
  state.phase = 0;
  state.smoothedCadenceSpm = 0;
};
