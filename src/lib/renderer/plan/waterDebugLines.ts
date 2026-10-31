/**
 * Debug-overlay geometry for the water-detection diagnostics pass
 * (#493 Phase 3d / FR22 / AC23).
 *
 * Builds a line-list vertex stream drawing:
 *
 *  - the detected shoreline (polygon outer rings) in bright cyan;
 *  - island outlines (polygon inner rings) in bright magenta;
 *  - on-land route samples as small plus-signs (two short crossed
 *    segments each), so a route that leaves the water is visible
 *    straight on the ride canvas rather than only in the summary.
 *
 * Pure: the input is already in scene XZ and the pass just binds the
 * resulting vertex buffer. One `float32x3` position + one `float32x3`
 * colour per vertex, interleaved so a single buffer feeds the pass.
 */
import type { Vec2XZ } from './waterPolygon';
import { WATER_SURFACE_Y } from './waterStrip';

/** Draws just above the water surface so the lines are never hidden under it. */
export const DEBUG_LINE_Y = WATER_SURFACE_Y + 0.02;

export type RGB = [number, number, number];

export const DEBUG_COLOUR_SHORELINE: RGB = [0.1, 0.95, 1];
export const DEBUG_COLOUR_ISLAND: RGB = [1, 0.3, 0.9];
export const DEBUG_COLOUR_ON_LAND: RGB = [1, 0.9, 0.1];

export interface WaterDebugInput {
  shorelines: Vec2XZ[][];
  islands: Vec2XZ[][];
  onLandSamples: Vec2XZ[];
}

export interface WaterDebugMesh {
  /** Interleaved x, y, z, r, g, b. */
  vertices: Float32Array;
  /** Number of line endpoints (line-list → each pair is one segment). */
  vertexCount: number;
}

const SAMPLE_MARKER_HALF_SIZE = 1.5; // metres in scene XZ

function pushLine(out: number[], a: Vec2XZ, b: Vec2XZ, colour: RGB) {
  out.push(a.x, DEBUG_LINE_Y, a.z, colour[0], colour[1], colour[2]);
  out.push(b.x, DEBUG_LINE_Y, b.z, colour[0], colour[1], colour[2]);
}

function pushRing(out: number[], ring: Vec2XZ[], colour: RGB) {
  if (ring.length < 2) return;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    pushLine(out, a, b, colour);
  }
}

/** Build the debug-line mesh in one pass. Zero inputs → empty mesh. */
export function buildWaterDebugMesh(input: WaterDebugInput): WaterDebugMesh {
  const data: number[] = [];
  for (const ring of input.shorelines) pushRing(data, ring, DEBUG_COLOUR_SHORELINE);
  for (const island of input.islands) pushRing(data, island, DEBUG_COLOUR_ISLAND);
  for (const sample of input.onLandSamples) {
    // A plus sign: two short perpendicular segments crossing at the sample.
    pushLine(
      data,
      { x: sample.x - SAMPLE_MARKER_HALF_SIZE, z: sample.z },
      { x: sample.x + SAMPLE_MARKER_HALF_SIZE, z: sample.z },
      DEBUG_COLOUR_ON_LAND,
    );
    pushLine(
      data,
      { x: sample.x, z: sample.z - SAMPLE_MARKER_HALF_SIZE },
      { x: sample.x, z: sample.z + SAMPLE_MARKER_HALF_SIZE },
      DEBUG_COLOUR_ON_LAND,
    );
  }
  return {
    vertices: new Float32Array(data),
    vertexCount: data.length / 6,
  };
}
