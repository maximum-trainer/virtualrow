import { describe, expect, it } from 'vitest';
import { makeMockDevice } from './_mockWebGPU';
import {
  applyMaxBuildingsPerSegment,
  BUILDING_PROFILE_INDEX,
  BUILDINGS_FLOATS_PER_INSTANCE,
  buildSmokeBuildings,
  createBuildingPool,
  packBuildings,
  packBuildingSizes,
  type BuildingSpec,
} from '../plan/buildings';

describe('buildings plan (P6 FR1 / D1-b / D3-a)', () => {
  const specs: BuildingSpec[] = [
    { x: 10, z: -5, halfWidth: 3, halfDepth: 4, height: 12, profile: 'residential' },
    { x: -10, z: -25, halfWidth: 2, halfDepth: 2, height: 7, profile: 'commercial' },
    { x: 5, z: -45, halfWidth: 4, halfDepth: 3, height: 20 }, // falls back
  ];

  it('packs (x, z, height, bitcast(paletteIndex)) per instance', () => {
    const plan = packBuildings(specs);
    expect(plan.instanceCount).toBe(3);
    expect(plan.instances.length).toBe(3 * BUILDINGS_FLOATS_PER_INSTANCE);
    expect(plan.instances[0]).toBe(10);
    expect(plan.instances[1]).toBe(-5);
    expect(plan.instances[2]).toBe(12);
    // Fourth lane carries the u32 palette index.
    const meta32 = new Uint32Array(plan.instances.buffer);
    expect(meta32[3]).toBe(BUILDING_PROFILE_INDEX.residential);
    expect(meta32[7]).toBe(BUILDING_PROFILE_INDEX.commercial);
    expect(meta32[11]).toBe(BUILDING_PROFILE_INDEX.fallback);
  });

  it('computes footprintM2 from halfWidth × halfDepth × 4', () => {
    const plan = packBuildings(specs);
    // 3*4*4 + 2*2*4 + 4*3*4 = 48 + 16 + 48 = 112
    expect(plan.footprintM2).toBeCloseTo(112, 5);
  });

  it('clamps negative heights to zero', () => {
    const plan = packBuildings([
      { x: 0, z: 0, halfWidth: 1, halfDepth: 1, height: -3, profile: 'commercial' },
    ]);
    expect(plan.instances[2]).toBe(0);
  });

  it('packBuildingSizes keeps a minimum half-size so the shader never gets a zero prism', () => {
    const sizes = packBuildingSizes([
      { x: 0, z: 0, halfWidth: 0, halfDepth: 0, height: 1 },
      { x: 0, z: 0, halfWidth: 2, halfDepth: 3, height: 1 },
    ]);
    expect(sizes[0]).toBeGreaterThan(0);
    expect(sizes[1]).toBeGreaterThan(0);
    expect(sizes[2]).toBe(2);
    expect(sizes[3]).toBe(3);
  });

  it('createBuildingPool uploads both centres + sizes and disposes both', () => {
    const device = makeMockDevice();
    const pool = createBuildingPool(device, specs);
    expect(pool.instanceCount).toBe(3);
    expect(pool.footprintM2).toBeCloseTo(112, 5);
    pool.dispose();
    pool.dispose(); // idempotent
    expect(device.__log.destroyedBuffers).toBe(2);
  });

  it('creates an empty pool without zero-sized buffers', () => {
    const device = makeMockDevice();
    const pool = createBuildingPool(device, []);
    expect(pool.instanceCount).toBe(0);
    expect(pool.footprintM2).toBe(0);
    pool.dispose();
    expect(device.__log.destroyedBuffers).toBe(2);
  });

  it('buildSmokeBuildings produces a deterministic alternating-profile set', () => {
    const specs = buildSmokeBuildings({ count: 8 });
    expect(specs.length).toBe(8);
    // Every spec has a profile index in range.
    for (const s of specs) {
      expect(s.profile).toBeDefined();
      expect(BUILDING_PROFILE_INDEX[s.profile!]).toBeGreaterThanOrEqual(0);
      expect(BUILDING_PROFILE_INDEX[s.profile!]).toBeLessThanOrEqual(3);
    }
    // Odd/even alternates sides along X.
    expect(Math.sign(specs[0].x)).toBe(-1);
    expect(Math.sign(specs[1].x)).toBe(1);
  });
});

describe('applyMaxBuildingsPerSegment (#712 FR6)', () => {
  const mkSpec = (z: number, id: number): BuildingSpec => ({
    x: id,
    z,
    halfWidth: 1,
    halfDepth: 1,
    height: 5,
  });

  it('returns an empty list when the cap is 0 (basic tier parity)', () => {
    const specs = [mkSpec(-10, 0), mkSpec(-30, 1)];
    expect(applyMaxBuildingsPerSegment(specs, 0, 50)).toEqual([]);
  });

  it('returns the full list when the cap is +Infinity (opt out of the budget)', () => {
    const specs = [mkSpec(-10, 0), mkSpec(-30, 1), mkSpec(-70, 2)];
    expect(applyMaxBuildingsPerSegment(specs, Infinity, 50)).toEqual(specs);
  });

  it('caps per 50 m segment, keeping the first N in input order', () => {
    // Four buildings in the first 0..50m segment, two in the second (50..100m).
    const segA = [mkSpec(-5, 0), mkSpec(-15, 1), mkSpec(-25, 2), mkSpec(-45, 3)];
    const segB = [mkSpec(-60, 4), mkSpec(-90, 5)];
    const out = applyMaxBuildingsPerSegment([...segA, ...segB], 2, 50);
    // Two per segment: first two of segA and all of segB survive.
    expect(out.map((s) => s.x)).toEqual([0, 1, 4, 5]);
  });

  it('indexes segments by `|z|` so routes running along +Z or -Z both split evenly', () => {
    // Two buildings at z = -10 and z = +10 land in the same segment because
    // |z| is used; the per-segment cap bites across sign.
    const specs = [mkSpec(-10, 0), mkSpec(10, 1), mkSpec(-70, 2)];
    const out = applyMaxBuildingsPerSegment(specs, 1, 50);
    expect(out.map((s) => s.x)).toEqual([0, 2]);
  });

  it('clamps a non-positive segment length to 1 metre (kept safe)', () => {
    // At segment length 1, z = -1.5 / -3.5 / -5.5 land in segments 1 / 3 / 5
    // — all distinct, so a cap of 1 keeps all three. If the divide hadn't
    // been clamped, dividing by 0 would NaN each index and lump everything
    // into one bucket.
    const specs = [mkSpec(-1.5, 0), mkSpec(-3.5, 1), mkSpec(-5.5, 2)];
    const out = applyMaxBuildingsPerSegment(specs, 1, 0);
    expect(out.length).toBe(3);
  });
});
