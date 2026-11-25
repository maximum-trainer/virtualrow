import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CATCH_LOUDNESS,
  COUNT_HZ,
  COUNT_MS,
  FINISH_HZ,
  FINISH_LOUDNESS,
  FINISH_MS,
  GO_HZ,
  GO_MS,
  SoundSubscriptions,
  type SoundInputs,
  type SoundSubscriptionsDeps,
} from '../lib/ui/soundSubscriptions.svelte';

/**
 * Covers #884 — the sound-toggle wiring restored from React (#339).
 *
 * The harness runs the raf loop synchronously via injected `requestFrame` /
 * `cancelFrame` so a test can `pump(ms)` the stroke clock and inspect what
 * calls landed on the audio service.
 */

function makeHarness() {
  const audio = {
    enable: vi.fn(async () => {}),
    disable: vi.fn(async () => {}),
    isEnabled: vi.fn(() => true),
    setVolume: vi.fn(),
    getVolume: vi.fn(() => 0.5),
    splash: vi.fn(),
    cue: vi.fn(),
    startWater: vi.fn(),
    stopWater: vi.fn(),
  };

  let ticker: (() => void) | null = null;
  let nextHandle = 1;
  let nowMs = 0;
  let reducedMotion = false;

  const deps: SoundSubscriptionsDeps = {
    audioService: audio,
    requestFrame: (cb) => {
      ticker = cb;
      return nextHandle++;
    },
    cancelFrame: () => {
      ticker = null;
    },
    now: () => nowMs,
    reducedMotion: () => reducedMotion,
  };

  const subs = new SoundSubscriptions(deps);

  const defaults: SoundInputs = {
    soundEnabled: false,
    sessionActive: false,
    cadenceSpm: 0,
    intensity: 1,
    startPhase: 'idle',
    countdown: null,
    finished: false,
  };

  const update = (over: Partial<SoundInputs> = {}) => subs.update({ ...defaults, ...over });

  /** Advance simulated time by `ms` and run `count` raf ticks. */
  const pump = (ms: number, count = 1) => {
    for (let i = 0; i < count; i++) {
      nowMs += ms / count;
      const t = ticker;
      if (!t) return;
      ticker = null;
      t();
    }
  };

  return {
    audio,
    subs,
    update,
    pump,
    setReducedMotion: (v: boolean) => (reducedMotion = v),
    setTime: (t: number) => (nowMs = t),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('SoundSubscriptions — water bed (AC1, FR1a)', () => {
  it('starts the water bed only when sound is on AND a workout is active', () => {
    const h = makeHarness();

    h.update({ soundEnabled: true });
    expect(h.audio.startWater).not.toHaveBeenCalled();

    h.update({ sessionActive: true });
    expect(h.audio.startWater).not.toHaveBeenCalled();

    h.update({ soundEnabled: true, sessionActive: true });
    expect(h.audio.startWater).toHaveBeenCalledTimes(1);
    expect(h.audio.stopWater).not.toHaveBeenCalled();
  });

  it('stops the water bed when either flag clears', () => {
    const h = makeHarness();
    h.update({ soundEnabled: true, sessionActive: true });
    h.update({ soundEnabled: false, sessionActive: true });
    expect(h.audio.stopWater).toHaveBeenCalledTimes(1);

    h.update({ soundEnabled: true, sessionActive: true });
    h.update({ soundEnabled: true, sessionActive: false });
    expect(h.audio.stopWater).toHaveBeenCalledTimes(2);
  });

  it('does not restart an already-running water bed on an unrelated input change', () => {
    const h = makeHarness();
    h.update({ soundEnabled: true, sessionActive: true });
    h.update({ soundEnabled: true, sessionActive: true, cadenceSpm: 24 });
    expect(h.audio.startWater).toHaveBeenCalledTimes(1);
  });

  it('skips the water bed when the service reports it is not enabled', () => {
    const h = makeHarness();
    h.audio.isEnabled.mockReturnValue(false);
    h.update({ soundEnabled: true, sessionActive: true });
    expect(h.audio.startWater).not.toHaveBeenCalled();
  });
});

describe('SoundSubscriptions — stroke splashes (AC2, FR1b)', () => {
  it('fires catch and finish splashes on phase crossings with the React loudness constants', () => {
    const h = makeHarness();
    h.update({ soundEnabled: true, sessionActive: true, cadenceSpm: 30, intensity: 0.8 });

    // Seed the clock (dt=0 first tick).
    h.pump(0);
    expect(h.audio.splash).not.toHaveBeenCalled();

    // 30 spm = 0.5 Hz = one stroke per 2 s. `stepStrokeClock` clamps dt to
    // 0.1 s per tick (MAX_STEP_DT_SECONDS), so a 1 s advance is ten ticks.
    // The smoothed cadence seeds on the first non-seed step, so by ~1 s we
    // have crossed 0.5 (finish) and by ~2 s wrapped 0 (catch).
    h.pump(1100, 11);
    expect(h.audio.splash).toHaveBeenCalledWith(FINISH_LOUDNESS * 0.8);

    h.pump(1000, 10);
    expect(h.audio.splash).toHaveBeenCalledWith(CATCH_LOUDNESS * 0.8);
  });

  it('suppresses stroke splashes under prefers-reduced-motion (#344)', () => {
    const h = makeHarness();
    h.setReducedMotion(true);
    h.update({ soundEnabled: true, sessionActive: true, cadenceSpm: 30 });
    h.pump(2500, 25);
    expect(h.audio.splash).not.toHaveBeenCalled();
  });

  it('does not fire splashes when the sound is off', () => {
    const h = makeHarness();
    h.update({ soundEnabled: false, sessionActive: true, cadenceSpm: 30 });
    h.pump(2500, 25);
    expect(h.audio.splash).not.toHaveBeenCalled();
  });

  it('stops the splash loop when the session ends, so a resumed tab does not chatter', () => {
    const h = makeHarness();
    h.update({ soundEnabled: true, sessionActive: true, cadenceSpm: 30 });
    h.pump(0);
    h.pump(1100, 11);
    expect(h.audio.splash).toHaveBeenCalledTimes(1);
    h.update({ soundEnabled: true, sessionActive: false, cadenceSpm: 30 });
    h.audio.splash.mockClear();
    h.pump(5000, 50);
    expect(h.audio.splash).not.toHaveBeenCalled();
  });
});

describe('SoundSubscriptions — race cues (AC3, FR1c)', () => {
  it('chirps the countdown once per number', () => {
    const h = makeHarness();
    h.update({ soundEnabled: true });
    h.update({ soundEnabled: true, countdown: 3, startPhase: 'counting' });
    h.update({ soundEnabled: true, countdown: 3, startPhase: 'counting' });
    h.update({ soundEnabled: true, countdown: 2, startPhase: 'counting' });
    h.update({ soundEnabled: true, countdown: 1, startPhase: 'counting' });

    expect(h.audio.cue.mock.calls.filter((c) => c[0] === COUNT_HZ)).toHaveLength(3);
    expect(h.audio.cue).toHaveBeenCalledWith(COUNT_HZ, COUNT_MS);
  });

  it('chirps "Row!" on the transition into go, once per row', () => {
    const h = makeHarness();
    h.update({ soundEnabled: true, startPhase: 'idle' });
    h.update({ soundEnabled: true, startPhase: 'counting', countdown: 1 });
    h.update({ soundEnabled: true, startPhase: 'go' });
    h.update({ soundEnabled: true, startPhase: 'rowing' });
    expect(h.audio.cue.mock.calls.filter((c) => c[0] === GO_HZ)).toHaveLength(1);
    expect(h.audio.cue).toHaveBeenCalledWith(GO_HZ, GO_MS);
  });

  it('does not chirp "Row!" when the subscriber first sees a row already under way', () => {
    const h = makeHarness();
    h.update({ soundEnabled: true, startPhase: 'rowing' });
    expect(h.audio.cue).not.toHaveBeenCalled();
  });

  it('chirps the finish once and re-arms when it clears (reduced motion does not suppress it)', () => {
    const h = makeHarness();
    h.setReducedMotion(true);
    h.update({ soundEnabled: true, finished: false });
    h.update({ soundEnabled: true, finished: true });
    h.update({ soundEnabled: true, finished: true });
    expect(h.audio.cue.mock.calls.filter((c) => c[0] === FINISH_HZ)).toHaveLength(1);
    expect(h.audio.cue).toHaveBeenCalledWith(FINISH_HZ, FINISH_MS);

    h.update({ soundEnabled: true, finished: false });
    h.update({ soundEnabled: true, finished: true });
    expect(h.audio.cue.mock.calls.filter((c) => c[0] === FINISH_HZ)).toHaveLength(2);
  });

  it('does not chirp cues when the sound is off', () => {
    const h = makeHarness();
    h.update({ soundEnabled: false, countdown: 3, startPhase: 'counting' });
    h.update({ soundEnabled: false, startPhase: 'go' });
    h.update({ soundEnabled: false, finished: true });
    expect(h.audio.cue).not.toHaveBeenCalled();
  });
});

describe('SoundSubscriptions — destroy', () => {
  it('stops the water bed and the clock on destroy', () => {
    const h = makeHarness();
    h.update({ soundEnabled: true, sessionActive: true, cadenceSpm: 30 });
    h.pump(1100, 11);
    h.audio.splash.mockClear();
    h.subs.destroy();
    h.pump(5000, 10);
    expect(h.audio.splash).not.toHaveBeenCalled();
    expect(h.audio.stopWater).toHaveBeenCalled();
  });
});
