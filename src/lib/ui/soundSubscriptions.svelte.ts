/**
 * The audio subscribers that turn a Sound-switched-on row into something you
 * can hear (#884, restoring #339's wiring after the React → SvelteKit cutover).
 *
 * The React port of #339 carried three hooks and an effect: `useStrokeAudio`
 * played a splash on each catch and finish, `useRaceCues` chirped the
 * countdown / "Row!" / finish, and `App.tsx` kept the water bed looping while
 * sound was on AND a workout was active. #542 P1 ported `AudioService` and
 * `SoundPicker` but not these subscribers, so flipping the switch on opened an
 * `AudioContext` with nothing connected to it — the toggle looked broken (#884).
 *
 * The three jobs live in one store so the layout owns one lifecycle:
 *   - Water bed: start / stop on `soundEnabled && sessionActive`.
 *   - Race cues: countdown number, go transition, finish, with the mid-row
 *     remount guard the React hook had.
 *   - Stroke splashes: driven by a local {@link StrokeClockState} keyed off the
 *     rower's cadence, firing on wrap-crossings so a 60 fps drive makes one
 *     splash, not forty (the same reason `useStrokeAudio` acted on transitions).
 *
 * Reduced motion suppresses the stroke splashes (#344), as the React hook did;
 * the countdown and finish cues still play, because a countdown you cannot
 * hear is a countdown you have to watch for.
 */
import { audioService } from '../services/audioService';
import type { AudioPort } from '../ports';
import {
  createStrokeClock,
  resetStrokeClock,
  stepStrokeClock,
  type StrokeClockState,
} from '../renderer/engine/strokeClock';
import type { StartPhase } from './startPhase';

/** `useStrokeAudio` — the blade going in is the sound the stroke is built around. */
export const CATCH_LOUDNESS = 0.9;
/** `useStrokeAudio` — the blade coming out is a smaller event. */
export const FINISH_LOUDNESS = 0.35;

/** `useRaceCues` — the count. Low enough to sit under the note that means go. */
export const COUNT_HZ = 660;
export const COUNT_MS = 110;
/** `useRaceCues` — "Row!". Higher so it is not mistaken for another number. */
export const GO_HZ = 990;
export const GO_MS = 220;
/** `useRaceCues` — the line. Longer because nothing follows it. */
export const FINISH_HZ = 880;
export const FINISH_MS = 320;

/** Injectable timers / adapters so a test drives the loop synchronously. */
export interface SoundSubscriptionsDeps {
  audioService: AudioPort;
  /**
   * Schedules the next raf tick. Returns a non-null handle so the owner can
   * cancel without a stop flag; the production default returns the browser
   * raf handle, and a test's default is a monotonic counter.
   */
  requestFrame: (cb: () => void) => number;
  cancelFrame: (handle: number) => void;
  now: () => number;
  /** Re-evaluated on each update, so a Media Query change takes effect live. */
  reducedMotion: () => boolean;
}

export interface SoundInputs {
  soundEnabled: boolean;
  sessionActive: boolean;
  cadenceSpm: number;
  /** 0..1, from `RideSessionStore.strokeIntensity`. */
  intensity: number;
  startPhase: StartPhase;
  countdown: number | null;
  finished: boolean;
}

const defaultDeps = (): SoundSubscriptionsDeps => ({
  audioService,
  requestFrame:
    typeof requestAnimationFrame !== 'undefined'
      ? (cb) => requestAnimationFrame(() => cb())
      : (cb) => setTimeout(cb, 16) as unknown as number,
  cancelFrame:
    typeof cancelAnimationFrame !== 'undefined'
      ? (h) => cancelAnimationFrame(h)
      : (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  reducedMotion: () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
});

const DEFAULT_INPUTS: SoundInputs = {
  soundEnabled: false,
  sessionActive: false,
  cadenceSpm: 0,
  intensity: 1,
  startPhase: 'idle',
  countdown: null,
  finished: false,
};

export class SoundSubscriptions {
  #deps: SoundSubscriptionsDeps;
  #inputs: SoundInputs = { ...DEFAULT_INPUTS };

  // Water-bed lifecycle (App's `useEffect` on soundEnabled && isWorkoutActive).
  #waterOn = false;

  // Race-cue state (React `useRaceCues`).
  #lastCount: number | null = null;
  #lastPhase: StartPhase | null = null;
  #announcedGo = false;
  #announcedFinish = false;

  // Stroke-audio clock (locally run; the engine's own clock is in the GPU
  // scene and not addressable from the UI layer).
  readonly #clock: StrokeClockState = createStrokeClock();
  #rafHandle: number | null = null;
  #lastTimeMs: number | null = null;

  constructor(deps: Partial<SoundSubscriptionsDeps> = {}) {
    this.#deps = { ...defaultDeps(), ...deps };
  }

  /**
   * Update from the owner's `$effect`. Fires one-shot cues (water bed,
   * countdown, go, finish) synchronously and (re)arms the raf loop for
   * stroke splashes if the gate changed.
   */
  update(next: SoundInputs): void {
    this.#inputs = next;
    const playable = next.soundEnabled && this.#deps.audioService.isEnabled();

    // Water bed: on only when sound is on AND a workout is active. A loop
    // that started on enable alone would play under the route list.
    const wantWater = playable && next.sessionActive;
    if (wantWater !== this.#waterOn) {
      this.#waterOn = wantWater;
      if (wantWater) this.#deps.audioService.startWater();
      else this.#deps.audioService.stopWater();
    }

    // Countdown cue: one per number. A re-render is not a second three.
    if (next.countdown !== this.#lastCount) {
      if (playable && next.countdown !== null) {
        this.#deps.audioService.cue(COUNT_HZ, COUNT_MS);
      }
      this.#lastCount = next.countdown;
    }

    // Go cue, matching `useRaceCues`: the first time this subscriber sees
    // `go`/`rowing` is where the row already was, not a transition into it,
    // so a component remounting mid-row must not chirp "Row!" at a rower a
    // kilometre down the course.
    const startedRowing = next.startPhase === 'go' || next.startPhase === 'rowing';
    const wasFirstSighting = this.#lastPhase === null;
    this.#lastPhase = next.startPhase;
    if (startedRowing) {
      if (!this.#announcedGo) {
        this.#announcedGo = true;
        if (playable && !wasFirstSighting) this.#deps.audioService.cue(GO_HZ, GO_MS);
      }
    } else if (next.startPhase === 'idle' || next.startPhase === 'armed') {
      this.#announcedGo = false;
    }

    // Finish cue — one per finish, re-armed when the finish clears.
    if (next.finished) {
      if (!this.#announcedFinish) {
        this.#announcedFinish = true;
        if (playable) this.#deps.audioService.cue(FINISH_HZ, FINISH_MS);
      }
    } else {
      this.#announcedFinish = false;
    }

    // Stroke-splash raf loop. Runs only while playable, active, and the user
    // has not asked for reduced motion (#344).
    const wantClock = playable && next.sessionActive && !this.#deps.reducedMotion();
    if (wantClock && this.#rafHandle === null) this.#startClock();
    else if (!wantClock && this.#rafHandle !== null) this.#stopClock();
  }

  /** Tear down any running loop and silence the water bed. Idempotent. */
  destroy(): void {
    this.#stopClock();
    if (this.#waterOn) {
      this.#waterOn = false;
      this.#deps.audioService.stopWater();
    }
    this.#lastCount = null;
    this.#lastPhase = null;
    this.#announcedGo = false;
    this.#announcedFinish = false;
  }

  #startClock(): void {
    resetStrokeClock(this.#clock);
    this.#lastTimeMs = null;
    const tick = (): void => {
      // Guard: a late raf fires after a stop.
      if (this.#rafHandle === null) return;
      const t = this.#deps.now();
      const dt = this.#lastTimeMs === null ? 0 : (t - this.#lastTimeMs) / 1000;
      this.#lastTimeMs = t;
      const prevPhase = this.#clock.phase;
      stepStrokeClock(this.#clock, {
        cadence: this.#inputs.cadenceSpm,
        dtSeconds: dt,
        isPlaying: true,
      });
      const nextPhase = this.#clock.phase;
      // Catch — phase wrapped past 0 (new < prev).
      if (nextPhase < prevPhase) {
        this.#deps.audioService.splash(CATCH_LOUDNESS * this.#inputs.intensity);
      } else if (prevPhase < 0.5 && nextPhase >= 0.5) {
        // Finish — crossed the mid-stroke boundary this frame.
        this.#deps.audioService.splash(FINISH_LOUDNESS * this.#inputs.intensity);
      }
      this.#rafHandle = this.#deps.requestFrame(tick);
    };
    this.#rafHandle = this.#deps.requestFrame(tick);
  }

  #stopClock(): void {
    if (this.#rafHandle !== null) {
      this.#deps.cancelFrame(this.#rafHandle);
      this.#rafHandle = null;
    }
    this.#lastTimeMs = null;
    resetStrokeClock(this.#clock);
  }
}
