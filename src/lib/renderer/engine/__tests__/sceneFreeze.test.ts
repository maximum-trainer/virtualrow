import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { attach } from '../attach';
import { resetWebGPUHealth } from '../health';
import { installGPUStub, makeMockAdapter, makeMockCanvas, makeMockGPU } from '../../__tests__/_mockWebGPU';
import { releaseTelemetry } from '../telemetry';
import { toEngineRoute } from '../../../ui/sceneryRoute';
import type { WaterRoute } from '../../../types';
import {
  frozenClock,
  frozenProgress,
  frozenStrokeCycle,
  readSceneFreeze,
  frozenVelocity,
} from '../sceneFreeze';

/**
 * Issue #340 — the scene has to be able to hold still (ported to the engine, #745 FR5).
 *
 * A visual baseline is worth nothing if the picture moves between the run that
 * recorded it and the run that checks it. `__ROWER3D_FREEZE` is what a
 * screenshot spec sets to stop the clock, pin the boat to a point on the route
 * and park the oars mid-stroke; these are the pure reads the scene makes of it.
 */
describe('readSceneFreeze', () => {
  it('reads nothing when the host has no freeze set', () => {
    expect(readSceneFreeze({})).toBeNull();
  });

  it('reads the time and progress a test asked for', () => {
    expect(readSceneFreeze({ __ROWER3D_FREEZE: { time: 12.5, progress: 0.31 } })).toEqual({
      time: 12.5,
      progress: 0.31,
    });
  });

  // The hook comes in over an init script, so it is an edge: a half-written
  // object there should leave the scene running rather than pin it to NaN.
  it.each([
    ['a string payload', 'yes'],
    ['a missing progress', { time: 4 }],
    ['a missing time', { progress: 0.5 }],
    ['a non-finite time', { time: Number.NaN, progress: 0.5 }],
    ['a non-finite progress', { time: 4, progress: Number.POSITIVE_INFINITY }],
  ])('ignores %s', (_label, payload) => {
    expect(readSceneFreeze({ __ROWER3D_FREEZE: payload })).toBeNull();
  });

  it('holds progress inside the route and time at or after its start', () => {
    expect(readSceneFreeze({ __ROWER3D_FREEZE: { time: -3, progress: 1.4 } })).toEqual({
      time: 0,
      progress: 1,
    });
    expect(readSceneFreeze({ __ROWER3D_FREEZE: { time: 2, progress: -0.2 } })).toEqual({
      time: 2,
      progress: 0,
    });
  });
});

describe('the frozen readings', () => {
  const freeze = { time: 12.5, progress: 0.31 };

  it('give the live value when nothing is frozen', () => {
    expect(frozenClock(null, 7.25)).toBe(7.25);
    expect(frozenProgress(null, 0.8)).toBe(0.8);
    expect(frozenStrokeCycle(null, 0.42)).toBe(0.42);
  });

  it('give the frozen value when the scene is held', () => {
    expect(frozenClock(freeze, 7.25)).toBe(12.5);
    expect(frozenProgress(freeze, 0.8)).toBe(0.31);
  });

  // The oars have to land in the same place as the clock, or the boat is the
  // one thing in a frozen frame that still moves.
  it('parks the stroke at the fraction of the second the clock stopped on', () => {
    expect(frozenStrokeCycle(freeze, 0.42)).toBe(0.5);
    expect(frozenStrokeCycle({ time: 12, progress: 0 }, 0.42)).toBe(0);
  });
});

describe('frozenVelocity', () => {
  /**
   * Issue #328 put the camera's field of view on a velocity curve, and the
   * freeze pins the clock and the boat's progress but not the physics. A
   * frozen scene would still have been photographed through a slightly
   * different lens each run, and the baselines would have drifted for a
   * reason that has nothing to do with the scene.
   */
  it('reports no speed at all while the scene is frozen', () => {
    expect(frozenVelocity({ time: 12.5, progress: 0.31 }, 4.17)).toBe(0);
  });

  it('reports the real speed while it is not', () => {
    expect(frozenVelocity(null, 4.17)).toBe(4.17);
    expect(frozenVelocity(null, 0)).toBe(0);
  });
});

describe('the engine honours __ROWER3D_FREEZE (#745 FR5)', () => {
  const host = globalThis as { __ROWER3D_FREEZE?: unknown };
  beforeEach(() => {
    installGPUStub(makeMockGPU(makeMockAdapter()));
    resetWebGPUHealth();
  });
  afterEach(() => {
    delete host.__ROWER3D_FREEZE;
    installGPUStub(undefined);
    releaseTelemetry();
  });

  const ride = async (distanceMeters: () => number) => {
    const route = toEngineRoute({
      id: 'freeze', name: 'Freeze', description: '', distance: 2, difficulty: 'easy', location: '',
      coordinates: [{ lat: 0, lng: 0 }, { lat: 0, lng: 0.02 }], elevationGain: 0, estimatedTime: 0, tags: [],
      createdAt: new Date('2026-01-01'),
    } as WaterRoute);
    return (await attach(makeMockCanvas(), {
      testMode: true,
      tier: 'medium',
      route,
      getFrame: () => ({
        paceSPer500: 120, distanceMeters: distanceMeters(), cadence: 24, isPlaying: true, holdBoat: false,
        finished: false, intensityFactor: 1, elapsedSeconds: 10, ghost: null,
      }),
    })) as unknown as {
      _frameOnce: () => void;
      _telemetry: { pos: { progress: number }; crew: { strokePhase: number }; frame: { time?: number } };
      dispose(): void;
    };
  };

  it('pins the boat to the frozen progress and parks the stroke, whatever the rower does', async () => {
    host.__ROWER3D_FREEZE = { time: 12.25, progress: 0.4 };
    let d = 100;
    const r = await ride(() => d);
    r._frameOnce();
    const first = { progress: r._telemetry.pos.progress, phase: r._telemetry.crew.strokePhase };
    d = 900;
    r._frameOnce();
    expect(first.progress).toBeCloseTo(0.4, 2);
    expect(r._telemetry.pos.progress).toBeCloseTo(first.progress, 6);
    expect(r._telemetry.crew.strokePhase).toBeCloseTo(0.25, 6);
    r.dispose();
  });

  it('leaves the ride live with no freeze set', async () => {
    let d = 100;
    const r = await ride(() => d);
    r._frameOnce();
    const before = r._telemetry.pos.progress;
    d = 900;
    for (let i = 0; i < 60; i++) r._frameOnce();
    expect(r._telemetry.pos.progress).toBeGreaterThan(before);
    r.dispose();
  });
});
