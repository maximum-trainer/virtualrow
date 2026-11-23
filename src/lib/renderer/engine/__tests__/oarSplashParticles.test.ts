import { describe, expect, it } from 'vitest';

import {
  OAR_SPLASH_BURST_SIZE,
  OAR_SPLASH_FLOATS_PER_PARTICLE,
  OAR_SPLASH_LATERAL_OFFSET_METRES,
  OAR_SPLASH_LIFETIME_SEC,
  OAR_SPLASH_POOL_SIZE_DEFAULT,
  OAR_SPLASH_DROPS_PER_BLADE,
  OAR_SPLASH_DROP_INITIAL_UP_MPS,
  OAR_SPLASH_DROP_MAX_SIZE_METRES,
  OAR_SPLASH_KIND_DROP,
  OAR_SPLASH_KIND_RING,
  OAR_SPLASH_RING_END_RADIUS_METRES,
  OAR_SPLASH_RING_START_RADIUS_METRES,
  OAR_SPLASH_RING_Y,
  activeOarSplashCount,
  createOarSplashState,
  oarSplashDropHeight,
  updateOarSplash,
} from '../oarSplashParticles';
import { WATER_SURFACE_Y } from '../../plan/waterStrip';
import { wgslConst } from './wgslConst';

describe('oarSplashParticles (#571 slice)', () => {
  it('starts with an empty pool and zero spawns', () => {
    const s = createOarSplashState();
    expect(s.pool.length).toBe(OAR_SPLASH_POOL_SIZE_DEFAULT * OAR_SPLASH_FLOATS_PER_PARTICLE);
    expect(s.cursor).toBe(0);
    expect(s.spawnCount).toBe(0);
    expect(activeOarSplashCount(s)).toBe(0);
  });

  it('spawns nothing while the boat is still', () => {
    const s = createOarSplashState();
    // Phase advances but isPlaying false — no bursts.
    for (let p = 0; p < 1; p += 0.1) {
      updateOarSplash(s, 0, 0, 0, p, false, 0.016);
    }
    expect(s.spawnCount).toBe(0);
  });

  it('bursts both blades on the catch crossing (phase wraps 0.9 → 0.05)', () => {
    const s = createOarSplashState();
    s.lastPhase = 0.9;
    updateOarSplash(s, 0, 0, 0, 0.05, true, 0.016);
    expect(s.spawnCount).toBe(OAR_SPLASH_BURST_SIZE * 2); // port + starboard
    expect(activeOarSplashCount(s)).toBe(OAR_SPLASH_BURST_SIZE * 2);
  });

  it('bursts both blades on the finish crossing (phase 0.45 → 0.55)', () => {
    const s = createOarSplashState();
    s.lastPhase = 0.45;
    updateOarSplash(s, 0, 0, 0, 0.55, true, 0.016);
    expect(s.spawnCount).toBe(OAR_SPLASH_BURST_SIZE * 2);
  });

  it('skips bursts when the phase step stays within [0, 0.5] (mid-drive)', () => {
    const s = createOarSplashState();
    s.lastPhase = 0.2;
    updateOarSplash(s, 0, 0, 0, 0.3, true, 0.016);
    expect(s.spawnCount).toBe(0);
  });

  it('places the burst at the heading-rotated blade tips (heading 0)', () => {
    const s = createOarSplashState();
    s.lastPhase = 0.4;
    // Signature: (state, boatWorldX, boatWorldZ, heading, phase, isPlaying, dt)
    updateOarSplash(s, 10, 5, 0, 0.6, true, 0.016); // crosses finish
    // Heading 0 → starboard = (cos 0, -sin 0) = (1, 0). Port blade sits at
    // (10 - 2.4, _, 5), starboard at (10 + 2.4, _, 5). Spread ±0.3 m.
    const stride = OAR_SPLASH_FLOATS_PER_PARTICLE;
    const first = s.pool.subarray(0, stride);
    const stbdBurstFirst = s.pool.subarray(stride * OAR_SPLASH_BURST_SIZE, stride * (OAR_SPLASH_BURST_SIZE + 1));
    expect(first[0]).toBeCloseTo(10 - OAR_SPLASH_LATERAL_OFFSET_METRES, 0);
    expect(first[2]).toBeCloseTo(5, 0);
    expect(stbdBurstFirst[0]).toBeCloseTo(10 + OAR_SPLASH_LATERAL_OFFSET_METRES, 0);
    expect(stbdBurstFirst[2]).toBeCloseTo(5, 0);
  });

  it('rotates blade placement with the heading (heading 90°)', () => {
    const s = createOarSplashState();
    s.lastPhase = 0.4;
    // Heading π/2 → starboard = (cos 90°, -sin 90°) = (0, -1). Port sits
    // along +Z from the hull, starboard along -Z.
    updateOarSplash(s, 0, 0, Math.PI / 2, 0.6, true, 0.016);
    const stride = OAR_SPLASH_FLOATS_PER_PARTICLE;
    const first = s.pool.subarray(0, stride);
    const stbdBurstFirst = s.pool.subarray(stride * OAR_SPLASH_BURST_SIZE, stride * (OAR_SPLASH_BURST_SIZE + 1));
    expect(first[0]).toBeCloseTo(0, 0);
    expect(first[2]).toBeCloseTo(OAR_SPLASH_LATERAL_OFFSET_METRES, 0);
    expect(stbdBurstFirst[0]).toBeCloseTo(0, 0);
    expect(stbdBurstFirst[2]).toBeCloseTo(-OAR_SPLASH_LATERAL_OFFSET_METRES, 0);
  });

  it('ages particles out of the active window once lifetime elapses', () => {
    const s = createOarSplashState();
    s.lastPhase = 0.9;
    updateOarSplash(s, 0, 0, 0, 0.05, true, 0.016);
    expect(activeOarSplashCount(s)).toBe(OAR_SPLASH_BURST_SIZE * 2);
    updateOarSplash(s, 0, 0, 0, 0.05, false, OAR_SPLASH_LIFETIME_SEC + 0.1);
    expect(activeOarSplashCount(s)).toBe(0);
  });

  it('tolerates dt=0 and negative dt without NaN or stale spawns', () => {
    const s = createOarSplashState();
    s.lastPhase = 0.9;
    updateOarSplash(s, 0, 0, 0, 0.05, true, 0.016);
    const beforeAge = s.pool[3];
    updateOarSplash(s, 0, 0, 0, 0.05, true, 0);
    expect(s.pool[3]).toBe(beforeAge);
    updateOarSplash(s, 0, 0, 0, 0.05, true, -0.5);
    expect(Number.isFinite(s.pool[3])).toBe(true);
    expect(s.pool[3]).toBe(beforeAge);
  });

  it('FR4: a splash is short-lived (<= 0.45 s)', () => {
    expect(OAR_SPLASH_LIFETIME_SEC).toBeLessThanOrEqual(0.45);
  });

  it('FR4: each blade burst is a handful of drops plus one flat ring', () => {
    expect(OAR_SPLASH_BURST_SIZE).toBe(OAR_SPLASH_DROPS_PER_BLADE + 1);
    const s = createOarSplashState();
    s.lastPhase = 0.9;
    updateOarSplash(s, 0, 0, 0, 0.05, true, 0.016);
    const stride = OAR_SPLASH_FLOATS_PER_PARTICLE;
    const kinds: number[] = [];
    for (let i = 0; i < s.spawnCount; i += 1) kinds.push(s.pool[i * stride + 8]);
    expect(kinds.filter((k) => k === OAR_SPLASH_KIND_RING)).toHaveLength(2);
    expect(kinds.filter((k) => k === OAR_SPLASH_KIND_DROP)).toHaveLength(OAR_SPLASH_DROPS_PER_BLADE * 2);
    for (let i = 0; i < s.spawnCount; i += 1) {
      const b = i * stride;
      if (s.pool[b + 8] !== OAR_SPLASH_KIND_RING) continue;
      expect(s.pool[b + 1]).toBeCloseTo(OAR_SPLASH_RING_Y, 6);
      expect(s.pool[b + 6]).toBe(0); // a ring does not drift
      expect(s.pool[b + 7]).toBe(0);
    }
    expect(OAR_SPLASH_RING_Y).toBeGreaterThan(WATER_SURFACE_Y);
    expect(OAR_SPLASH_RING_Y - WATER_SURFACE_Y).toBeLessThanOrEqual(0.05);
  });

  it('FR4: no drop or ring is wider than 0.3 m', () => {
    expect(OAR_SPLASH_DROP_MAX_SIZE_METRES).toBeLessThanOrEqual(0.3);
    expect(OAR_SPLASH_RING_START_RADIUS_METRES).toBeLessThan(OAR_SPLASH_RING_END_RADIUS_METRES);
    expect(OAR_SPLASH_RING_END_RADIUS_METRES).toBeLessThanOrEqual(0.3);
    const s = createOarSplashState();
    // Many bursts so every jitter branch is sampled.
    for (let n = 0; n < 20; n += 1) {
      s.lastPhase = 0.9;
      updateOarSplash(s, 0, 0, 0, 0.05, true, 0.016);
    }
    const stride = OAR_SPLASH_FLOATS_PER_PARTICLE;
    for (let i = 0; i < s.size; i += 1) {
      const b = i * stride;
      if (s.pool[b + 4] <= 0 || s.pool[b + 8] !== OAR_SPLASH_KIND_DROP) continue;
      expect(s.pool[b + 5]).toBeLessThanOrEqual(OAR_SPLASH_DROP_MAX_SIZE_METRES);
    }
  });

  it('FR4: drops follow a low arc and are back in the water before they die', () => {
    let apex = 0;
    for (let t = 0; t <= OAR_SPLASH_LIFETIME_SEC; t += 0.005) apex = Math.max(apex, oarSplashDropHeight(t));
    expect(apex).toBeLessThanOrEqual(0.15);
    expect(apex).toBeGreaterThan(0.03);
    // Nothing persists in mid-air: by the end of the lifetime the drop
    // has fallen back to (or below) where it left the water.
    expect(oarSplashDropHeight(OAR_SPLASH_LIFETIME_SEC)).toBeLessThanOrEqual(0);
  });

  it('FR4: the shader mirrors the arc, size and ring constants', () => {
    const f = 'oarSplashParticles.wgsl';
    expect(wgslConst(f, 'INITIAL_UP')).toBe(OAR_SPLASH_DROP_INITIAL_UP_MPS);
    expect(wgslConst(f, 'RING_START_RADIUS')).toBe(OAR_SPLASH_RING_START_RADIUS_METRES);
    expect(wgslConst(f, 'RING_END_RADIUS')).toBe(OAR_SPLASH_RING_END_RADIUS_METRES);
  });
});
