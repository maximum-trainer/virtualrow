import { describe, expect, it } from 'vitest';
import {
  buildWaterDebugMesh,
  DEBUG_COLOUR_ISLAND,
  DEBUG_COLOUR_ON_LAND,
  DEBUG_COLOUR_SHORELINE,
  DEBUG_LINE_Y,
  type RGB,
} from '../lib/renderer/plan/waterDebugLines';
import { WATER_SURFACE_Y } from '../lib/renderer/plan/waterStrip';

const expectColourCloseTo = (actual: readonly number[], expected: RGB) => {
  expect(actual[0]).toBeCloseTo(expected[0], 5);
  expect(actual[1]).toBeCloseTo(expected[1], 5);
  expect(actual[2]).toBeCloseTo(expected[2], 5);
};

const square = [
  { x: 0, z: 0 },
  { x: 10, z: 0 },
  { x: 10, z: 10 },
  { x: 0, z: 10 },
];

describe('buildWaterDebugMesh', () => {
  it('returns an empty mesh when nothing is provided', () => {
    const mesh = buildWaterDebugMesh({ shorelines: [], islands: [], onLandSamples: [] });
    expect(mesh.vertexCount).toBe(0);
    expect(mesh.vertices.length).toBe(0);
  });

  it('emits one line-pair per shoreline edge in cyan', () => {
    const mesh = buildWaterDebugMesh({ shorelines: [square], islands: [], onLandSamples: [] });
    // 4-edge ring → 4 segments → 8 vertex endpoints
    expect(mesh.vertexCount).toBe(8);
    // Each vertex is 6 floats (xyz + rgb)
    expect(mesh.vertices.length).toBe(48);
    // First vertex colour matches the shoreline colour
    expectColourCloseTo([mesh.vertices[3], mesh.vertices[4], mesh.vertices[5]], DEBUG_COLOUR_SHORELINE);
  });

  it('emits island edges in the island colour', () => {
    const mesh = buildWaterDebugMesh({ shorelines: [], islands: [square], onLandSamples: [] });
    expect(mesh.vertexCount).toBe(8);
    expectColourCloseTo([mesh.vertices[3], mesh.vertices[4], mesh.vertices[5]], DEBUG_COLOUR_ISLAND);
  });

  it('emits two crossed segments per on-land sample in the sample colour', () => {
    const mesh = buildWaterDebugMesh({
      shorelines: [],
      islands: [],
      onLandSamples: [{ x: 5, z: 7 }],
    });
    // One plus-sign = 2 segments = 4 vertex endpoints
    expect(mesh.vertexCount).toBe(4);
    expectColourCloseTo([mesh.vertices[3], mesh.vertices[4], mesh.vertices[5]], DEBUG_COLOUR_ON_LAND);
  });

  it('places every vertex at the debug Y just above the water surface', () => {
    const mesh = buildWaterDebugMesh({
      shorelines: [square],
      islands: [square],
      onLandSamples: [{ x: 1, z: 1 }],
    });
    for (let i = 0; i < mesh.vertexCount; i++) {
      const y = mesh.vertices[i * 6 + 1];
      expect(y).toBeCloseTo(DEBUG_LINE_Y, 6);
      expect(y).toBeGreaterThan(WATER_SURFACE_Y);
    }
  });

  it('skips degenerate rings with fewer than two points', () => {
    const mesh = buildWaterDebugMesh({
      shorelines: [[{ x: 0, z: 0 }]],
      islands: [],
      onLandSamples: [],
    });
    expect(mesh.vertexCount).toBe(0);
  });

  it('combines all three input kinds into one interleaved buffer', () => {
    const mesh = buildWaterDebugMesh({
      shorelines: [square],
      islands: [square],
      onLandSamples: [{ x: 0, z: 0 }, { x: 1, z: 1 }],
    });
    // 4+4 shoreline+island segments + 2 plus-signs × 2 segments = 12 segments → 24 endpoints
    expect(mesh.vertexCount).toBe(24);
  });
});
