import { describe, expect, it } from 'vitest';

import {
  WAKE_FLOATS_PER_PARTICLE,
  WAKE_HALF_WIDTH_METRES,
  WAKE_LIFETIME_SEC_DEFAULT,
  WAKE_POOL_SIZE_DEFAULT,
  WAKE_SPAWN_INTERVAL_SEC_DEFAULT,
  WAKE_STERN_OFFSET_METRES,
  WAKE_END_RADIUS_METRES,
  WAKE_PEAK_ALPHA,
  WAKE_START_RADIUS_METRES,
  WAKE_FOAM_Y,
  WAKE_MAX_INTERPOLATION_METRES,
  activeWakeCount,
  createWakeState,
  updateWake,
  wakeSpriteParams,
} from '../wakeParticles';
import { WATER_SURFACE_Y } from '../../plan/waterStrip';
import { wgslConst, wgslSource } from './wgslConst';

const F = WAKE_FLOATS_PER_PARTICLE;
const live = (s: ReturnType<typeof createWakeState>) => {
  const out: { x: number; y: number; z: number; age: number }[] = [];
  for (let i = 0; i < s.size; i += 1) {
    const b = i * F;
    if (s.pool[b + 4] > 0 && s.pool[b + 3] < s.pool[b + 4]) {
      out.push({ x: s.pool[b], y: s.pool[b + 1], z: s.pool[b + 2], age: s.pool[b + 3] });
    }
  }
  return out;
};

describe('wakeParticles (#571 water-wake slice)', () => {
  it('starts with an empty pool and zero spawns', () => {
    const s = createWakeState();
    expect(s.pool.length).toBe(WAKE_POOL_SIZE_DEFAULT * WAKE_FLOATS_PER_PARTICLE);
    expect(s.cursor).toBe(0);
    expect(s.spawnCount).toBe(0);
    expect(activeWakeCount(s)).toBe(0);
  });

  it('spawns no particles while the boat is still', () => {
    const s = createWakeState();
    for (let i = 0; i < 50; i += 1) {
      updateWake(s, 0, 0, 0, false, 0.016);
    }
    expect(s.spawnCount).toBe(0);
    expect(activeWakeCount(s)).toBe(0);
  });

  it('spawns pairs of particles while moving, roughly at the configured rate', () => {
    const s = createWakeState();
    const dt = WAKE_SPAWN_INTERVAL_SEC_DEFAULT; // one spawn per step
    for (let i = 0; i < 10; i += 1) {
      updateWake(s, 0, 0, 0, true, dt);
    }
    // Each spawn drops two particles (port + starboard). The clock is
    // primed to the full interval, so one pair per step → 2 × 10 = 20.
    expect(s.spawnCount).toBe(20);
    expect(activeWakeCount(s)).toBe(s.spawnCount);
  });

  it('ages particles out of the active window once their lifetime elapses', () => {
    const s = createWakeState();
    updateWake(s, 0, 0, 0, true, WAKE_SPAWN_INTERVAL_SEC_DEFAULT); // 2 spawned
    expect(activeWakeCount(s)).toBe(2);
    // Age past the lifetime without spawning more.
    updateWake(s, 0, 0, 0, false, WAKE_LIFETIME_SEC_DEFAULT + 0.1);
    expect(activeWakeCount(s)).toBe(0);
  });

  it('places the particles behind the stern and offset to port + starboard (heading 0)', () => {
    const s = createWakeState();
    // Heading 0: boat local -Z is world -Z. Stern offset is -3.4 along
    // local -Z → stern world = boat.z + offset. Pair sits ±0.45 along
    // local +X, which is world +X at heading 0.
    updateWake(s, 10, 5, 0, true, WAKE_SPAWN_INTERVAL_SEC_DEFAULT);
    const first = s.pool.subarray(0, WAKE_FLOATS_PER_PARTICLE);
    const second = s.pool.subarray(WAKE_FLOATS_PER_PARTICLE, 2 * WAKE_FLOATS_PER_PARTICLE);
    const port = [first[0], first[2]];
    const stbd = [second[0], second[2]];
    const expectedSternZ = 5 + WAKE_STERN_OFFSET_METRES * Math.cos(0);
    const expectedSternX = 10 + WAKE_STERN_OFFSET_METRES * Math.sin(0);
    expect(port[0]).toBeCloseTo(expectedSternX + WAKE_HALF_WIDTH_METRES, 5);
    expect(port[1]).toBeCloseTo(expectedSternZ, 5);
    expect(stbd[0]).toBeCloseTo(expectedSternX - WAKE_HALF_WIDTH_METRES, 5);
    expect(stbd[1]).toBeCloseTo(expectedSternZ, 5);
  });

  it('rotates stern + lateral offsets with the heading', () => {
    const s = createWakeState();
    // 90° heading rotates boat-local -Z onto world -X. Stern lands at
    // (-stern, _, 0) relative to the boat; port/starboard offsets flip
    // to world ±Z.
    updateWake(s, 0, 0, Math.PI / 2, true, WAKE_SPAWN_INTERVAL_SEC_DEFAULT);
    const first = s.pool.subarray(0, WAKE_FLOATS_PER_PARTICLE);
    expect(first[0]).toBeCloseTo(WAKE_STERN_OFFSET_METRES, 5);
    expect(first[2]).toBeCloseTo(-WAKE_HALF_WIDTH_METRES, 5);
  });

  it('ring-wraps rather than overflowing the pool', () => {
    const s = createWakeState(4); // tiny pool
    // Push many spawns through — never allowed to overwrite the Float32Array.
    for (let i = 0; i < 100; i += 1) {
      updateWake(s, 0, 0, 0, true, WAKE_SPAWN_INTERVAL_SEC_DEFAULT);
    }
    expect(s.pool.length).toBe(4 * WAKE_FLOATS_PER_PARTICLE);
    // cursor stays within 0..size-1
    expect(s.cursor).toBeGreaterThanOrEqual(0);
    expect(s.cursor).toBeLessThan(4);
  });

  it('tolerates dt=0 and negative dt without NaN or stale spawns', () => {
    const s = createWakeState();
    updateWake(s, 0, 0, 0, true, WAKE_SPAWN_INTERVAL_SEC_DEFAULT); // get 2 alive
    const beforeAge = s.pool[3];
    updateWake(s, 0, 0, 0, true, 0);
    expect(s.pool[3]).toBe(beforeAge);
    updateWake(s, 0, 0, 0, true, -0.5);
    expect(Number.isFinite(s.pool[3])).toBe(true);
    expect(s.pool[3]).toBe(beforeAge);
  });

  it('FR1: lays every particle on the water plane, whatever the boat height', () => {
    const s = createWakeState();
    updateWake(s, 0, 0, 0, true, WAKE_SPAWN_INTERVAL_SEC_DEFAULT);
    for (const p of live(s)) {
      expect(p.y).toBeCloseTo(WAKE_FOAM_Y, 6);
    }
    expect(WAKE_FOAM_Y).toBeGreaterThan(WATER_SURFACE_Y);
    expect(WAKE_FOAM_Y - WATER_SURFACE_Y).toBeLessThanOrEqual(0.05);
  });

  it('FR1: the shader builds a flat quad in world XZ, not a camera-facing one', () => {
    const src = wgslSource('wakeParticles.wgsl');
    expect(src).not.toMatch(/frame\.view\s*\*/);
    expect(wgslConst('wakeParticles.wgsl', 'FOAM_Y')).toBeCloseTo(WAKE_FOAM_Y, 6);
  });

  it('FR2: start radius <= 0.25 m, end radius <= 0.9 m, peak alpha <= 0.35', () => {
    expect(wakeSpriteParams(0).radius).toBeLessThanOrEqual(0.25);
    expect(wakeSpriteParams(1).radius).toBeLessThanOrEqual(0.9);
    let peak = 0;
    for (let f = 0; f <= 1; f += 0.01) {
      const { radius, alpha } = wakeSpriteParams(f);
      expect(radius).toBeGreaterThan(0);
      peak = Math.max(peak, alpha);
    }
    expect(peak).toBeLessThanOrEqual(0.35);
    expect(peak).toBeGreaterThan(0.1);
    expect(wakeSpriteParams(0).alpha).toBe(0);
    expect(wakeSpriteParams(1).alpha).toBe(0);
  });

  it('FR2: the shader mirrors the radius and alpha constants', () => {
    expect(wgslConst('wakeParticles.wgsl', 'START_RADIUS')).toBe(WAKE_START_RADIUS_METRES);
    expect(wgslConst('wakeParticles.wgsl', 'END_RADIUS')).toBe(WAKE_END_RADIUS_METRES);
    expect(wgslConst('wakeParticles.wgsl', 'PEAK_ALPHA')).toBe(WAKE_PEAK_ALPHA);
  });

  it('FR3 (Gherkin): a 400 ms frame at 4 m/s spreads catch-up pairs >= 0.25 m apart', () => {
    const s = createWakeState();
    // Establish the previous stern position without spawning.
    updateWake(s, 0, 0, 0, true, 0.001);
    expect(s.spawnCount).toBe(0);
    // Heading 0 → forward is +Z. 0.4 s at 4 m/s = 1.6 m.
    updateWake(s, 0, 1.6, 0, true, 0.4);
    const port = live(s)
      .filter((p) => p.x > 0)
      .map((p) => p.z)
      .sort((a, b) => a - b);
    expect(port.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < port.length; i += 1) {
      expect(port[i] - port[i - 1]).toBeGreaterThanOrEqual(0.25);
    }
  });

  it('FR3: catch-up spawns carry the age of their place on the segment', () => {
    const s = createWakeState();
    updateWake(s, 0, 0, 0, true, 0.001);
    updateWake(s, 0, 1.6, 0, true, 0.4);
    const port = live(s).filter((p) => p.x > 0);
    // The particle furthest astern (smallest z) was dropped earliest.
    const oldest = port.reduce((a, b) => (a.z < b.z ? a : b));
    const newest = port.reduce((a, b) => (a.z > b.z ? a : b));
    expect(oldest.age).toBeGreaterThan(newest.age);
    expect(oldest.age).toBeLessThanOrEqual(0.4);
  });

  it('FR3: a long stall does not flood the pool with particles that would already be dead', () => {
    const s = createWakeState();
    updateWake(s, 0, 0, 0, true, 0.001);
    updateWake(s, 0, 4, 0, true, 10);
    const maxLivePairs = Math.ceil(WAKE_LIFETIME_SEC_DEFAULT / WAKE_SPAWN_INTERVAL_SEC_DEFAULT) + 1;
    expect(s.spawnCount).toBeLessThanOrEqual(maxLivePairs * 2);
    expect(activeWakeCount(s)).toBe(s.spawnCount);
  });

  it('FR3: a teleport (lap seam, restart) does not streak foam across the jump', () => {
    const s = createWakeState();
    updateWake(s, 0, 0, 0, true, 0.001);
    updateWake(s, 0, WAKE_MAX_INTERPOLATION_METRES + 50, 0, true, 0.4);
    const sternZ = WAKE_MAX_INTERPOLATION_METRES + 50 + WAKE_STERN_OFFSET_METRES;
    for (const p of live(s)) {
      expect(p.z).toBeCloseTo(sternZ, 5);
    }
  });
});
