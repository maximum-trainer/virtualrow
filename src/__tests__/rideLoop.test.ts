import { describe, it, expect } from 'vitest';
import {
  defaultRideLoop,
  clampTargetDistanceMeters,
  clampTargetTimeSeconds,
  finishDistanceMeters,
  finishTimeSeconds,
  lapsCompleted,
  currentLap,
  progressAlongRoute,
} from '../lib/ui/rideLoop';

describe('rideLoop (#647)', () => {
  it('defaults to loop off, finishing at the route length', () => {
    const loop = defaultRideLoop();
    expect(loop.enabled).toBe(false);
    expect(loop.target.kind).toBe('route');
    expect(finishDistanceMeters(loop, 2000)).toBe(2000);
    expect(finishTimeSeconds(loop)).toBeNull();
  });

  it('clamps user-entered targets to sane bounds', () => {
    expect(clampTargetDistanceMeters(100)).toBe(500);
    expect(clampTargetDistanceMeters(5500)).toBe(5500);
    expect(clampTargetDistanceMeters(1_000_000)).toBe(100_000);
    expect(clampTargetTimeSeconds(5)).toBe(60);
    expect(clampTargetTimeSeconds(600)).toBe(600);
    expect(clampTargetTimeSeconds(99_999)).toBe(21_600);
  });

  it('resolves a distance target to its own metres, ignoring the route', () => {
    const loop = { enabled: true, target: { kind: 'distance' as const, value: 10_000 } };
    expect(finishDistanceMeters(loop, 2000)).toBe(10_000);
    expect(finishTimeSeconds(loop)).toBeNull();
  });

  it('resolves a time target to seconds and leaves distance unbounded', () => {
    const loop = { enabled: true, target: { kind: 'time' as const, value: 1200 } };
    expect(finishDistanceMeters(loop, 2000)).toBeNull();
    expect(finishTimeSeconds(loop)).toBe(1200);
  });

  it('resolves a free target to no distance and no time finish', () => {
    const loop = { enabled: true, target: { kind: 'free' as const } };
    expect(finishDistanceMeters(loop, 2000)).toBeNull();
    expect(finishTimeSeconds(loop)).toBeNull();
  });

  it('resolves a route target (loop on, length-of-route) to the route length', () => {
    const loop = { enabled: true, target: { kind: 'route' as const } };
    expect(finishDistanceMeters(loop, 2000)).toBe(2000);
  });

  it('a missing or zero target value falls through to no-finish', () => {
    expect(finishDistanceMeters({ enabled: true, target: { kind: 'distance' } }, 2000)).toBeNull();
    expect(finishDistanceMeters({ enabled: true, target: { kind: 'distance', value: 0 } }, 2000)).toBeNull();
    expect(finishTimeSeconds({ enabled: true, target: { kind: 'time' } })).toBeNull();
  });

  it('counts laps as floor(metres / route length)', () => {
    expect(lapsCompleted(0, 2000)).toBe(0);
    expect(lapsCompleted(1999, 2000)).toBe(0);
    expect(lapsCompleted(2000, 2000)).toBe(1);
    expect(lapsCompleted(4500, 2000)).toBe(2);
    expect(lapsCompleted(10_000, 2000)).toBe(5);
    expect(lapsCompleted(100, 0)).toBe(0);
  });

  it('reads the current lap, 1-indexed for the HUD', () => {
    expect(currentLap(0, 2000)).toBe(1);
    expect(currentLap(1999, 2000)).toBe(1);
    expect(currentLap(2000, 2000)).toBe(2);
    expect(currentLap(4500, 2000)).toBe(3);
  });

  it('wraps progress along the route across the seam', () => {
    expect(progressAlongRoute(0, 2000)).toBe(0);
    expect(progressAlongRoute(1000, 2000)).toBe(0.5);
    expect(progressAlongRoute(1999, 2000)).toBeCloseTo(0.9995);
    expect(progressAlongRoute(2000, 2000)).toBe(0);
    expect(progressAlongRoute(2001, 2000)).toBeCloseTo(0.0005);
    expect(progressAlongRoute(5000, 2000)).toBe(0.5);
    expect(progressAlongRoute(500, 0)).toBe(0);
  });
});
