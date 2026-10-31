import { describe, it, expect } from 'vitest';

import {
  buildIslandLand,
  buildIslandsMesh,
  ISLAND_SURFACE_Y_OFFSET,
} from '../lib/renderer/plan/islandLand';
import {
  buildRingBankStrip,
  BANK_SURFACE_Y,
} from '../lib/renderer/plan/ringBankStrip';
import { WATER_SURFACE_Y } from '../lib/renderer/plan/waterStrip';
import type { Vec2XZ } from '../lib/renderer/plan/waterPolygon';

/**
 * #493 Phase 3c — islands as land + the ring-bank shoreline strip.
 * Pure geometry; the engine passes consume these.
 */

const island: Vec2XZ[] = [
  { x: 0, z: 0 },
  { x: 10, z: 0 },
  { x: 10, z: 10 },
  { x: 0, z: 10 },
];

describe('buildIslandLand (AC4)', () => {
  it('emits every vertex above WATER_SURFACE_Y by ISLAND_SURFACE_Y_OFFSET', () => {
    const mesh = buildIslandLand(island);
    expect(mesh.positions.length).toBe(island.length * 3);
    const y = WATER_SURFACE_Y + ISLAND_SURFACE_Y_OFFSET;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      expect(mesh.positions[i + 1]).toBeCloseTo(y, 6);
    }
  });

  it('tessellates a square island into two triangles', () => {
    const mesh = buildIslandLand(island);
    expect(mesh.indices.length).toBe(6);
  });

  it('returns an empty mesh for a degenerate ring', () => {
    const mesh = buildIslandLand([{ x: 0, z: 0 }, { x: 1, z: 1 }]);
    expect(mesh.positions.length).toBe(0);
    expect(mesh.indices.length).toBe(0);
  });
});

describe('buildIslandsMesh', () => {
  it('merges two islands into one mesh with distinct index spaces', () => {
    const second: Vec2XZ[] = [
      { x: 20, z: 20 },
      { x: 30, z: 20 },
      { x: 30, z: 30 },
      { x: 20, z: 30 },
    ];
    const mesh = buildIslandsMesh([island, second]);
    // 8 vertices total, 4 triangles (2 per island).
    expect(mesh.positions.length).toBe(8 * 3);
    expect(mesh.indices.length).toBe(4 * 3);
    const vertexCount = mesh.positions.length / 3;
    for (let i = 0; i < mesh.indices.length; i++) {
      expect(mesh.indices[i]).toBeGreaterThanOrEqual(0);
      expect(mesh.indices[i]).toBeLessThan(vertexCount);
    }
  });

  it('skips degenerate islands quietly', () => {
    const mesh = buildIslandsMesh([island, [{ x: 0, z: 0 }, { x: 1, z: 1 }]]);
    expect(mesh.indices.length).toBe(6); // only the good island
  });
});

describe('buildRingBankStrip (FR6)', () => {
  it('emits an inner + outer vertex per ring vertex', () => {
    const strip = buildRingBankStrip(island, 2);
    expect(strip.positions.length).toBe(island.length * 2 * 3);
  });

  it('places every vertex at BANK_SURFACE_Y', () => {
    const strip = buildRingBankStrip(island, 2);
    for (let i = 0; i < strip.positions.length; i += 3) {
      expect(strip.positions[i + 1]).toBeCloseTo(BANK_SURFACE_Y, 6);
    }
  });

  it('places outer vertices outside the ring (|outer| > |inner| from centre)', () => {
    const strip = buildRingBankStrip(island, 5);
    // Island is centred at (5, 5); for a CCW ring the outer edge extrudes
    // outward, so the outer vertex is further from (5, 5) than the inner.
    for (let i = 0; i < island.length; i++) {
      const innerX = strip.positions[i * 6];
      const innerZ = strip.positions[i * 6 + 2];
      const outerX = strip.positions[i * 6 + 3];
      const outerZ = strip.positions[i * 6 + 5];
      const dInner = Math.hypot(innerX - 5, innerZ - 5);
      const dOuter = Math.hypot(outerX - 5, outerZ - 5);
      expect(dOuter).toBeGreaterThan(dInner);
    }
  });

  it('emits 2 triangles per ring edge', () => {
    const strip = buildRingBankStrip(island, 2);
    expect(strip.indices.length).toBe(island.length * 6);
  });
});
