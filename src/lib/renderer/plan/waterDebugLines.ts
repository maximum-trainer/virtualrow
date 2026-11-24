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
 *    straight on the ride canvas rather than only in the summary;
 *  - #745 FR3 — the React scene's river guides (`riverGuideGeometry.ts`):
 *    yellow down the middle of the channel and red along each water edge,
 *    so whether the boat sits on the centreline is visible directly.
 *
 * Pure: the input is already in scene XZ and the pass just binds the
 * resulting vertex buffer. One `float32x3` position + one `float32x3`
 * colour per vertex, interleaved so a single buffer feeds the pass.
 */
import type { Vec2XZ } from './waterPolygon';
import { buildWaterStrip, WATER_SURFACE_Y, type BuildWaterStripOptions } from './waterStrip';
import type { RouteCurve } from '../math/curve';
import { vec3 } from '../math/vec3';

/** Draws just above the water surface so the lines are never hidden under it. */
export const DEBUG_LINE_Y = WATER_SURFACE_Y + 0.02;

export type RGB = [number, number, number];

export const DEBUG_COLOUR_SHORELINE: RGB = [0.1, 0.95, 1];
export const DEBUG_COLOUR_ISLAND: RGB = [1, 0.3, 0.9];
export const DEBUG_COLOUR_ON_LAND: RGB = [1, 0.9, 0.1];
/** #745 FR3 — the React guides' yellow centreline and red water edges. */
export const DEBUG_COLOUR_GUIDE_CENTRE: RGB = [1, 0.83, 0];
export const DEBUG_COLOUR_GUIDE_EDGE: RGB = [1, 0.18, 0.18];

/** #745 FR3 — the channel's centreline and its two water edges, as open polylines. */
export interface RiverGuides {
  centre: Vec2XZ[];
  left: Vec2XZ[];
  right: Vec2XZ[];
}

export interface WaterDebugInput {
  shorelines: Vec2XZ[][];
  islands: Vec2XZ[][];
  onLandSamples: Vec2XZ[];
  /** #745 FR3 — drawn when given. */
  riverGuides?: RiverGuides;
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

function pushPolyline(out: number[], points: Vec2XZ[], colour: RGB) {
  for (let i = 0; i + 1 < points.length; i++) pushLine(out, points[i], points[i + 1], colour);
}

/**
 * #745 FR3 — the guides from the water strip itself: its two edges are the
 * strip's own vertex rows, and the centreline is the curve at the same
 * progress, so a guide that disagrees with the water means the water is
 * wrong, not the guide.
 */
export const buildRiverGuides = (
  curve: RouteCurve | null,
  options: BuildWaterStripOptions = {},
): RiverGuides => {
  const g: RiverGuides = { centre: [], left: [], right: [] };
  if (!curve || curve.length < 2) return g;
  const { positions } = buildWaterStrip(curve, options);
  const rows = positions.length / 6;
  const sample = { position: vec3(), tangent: vec3(0, 0, -1), angle: 0 };
  for (let r = 0; r < rows; r++) {
    curve.sample(rows === 1 ? 0 : r / (rows - 1), sample);
    g.centre.push({ x: sample.position[0], z: sample.position[2] });
    g.left.push({ x: positions[r * 6], z: positions[r * 6 + 2] });
    g.right.push({ x: positions[r * 6 + 3], z: positions[r * 6 + 5] });
  }
  return g;
};

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
  if (input.riverGuides) {
    pushPolyline(data, input.riverGuides.centre, DEBUG_COLOUR_GUIDE_CENTRE);
    pushPolyline(data, input.riverGuides.left, DEBUG_COLOUR_GUIDE_EDGE);
    pushPolyline(data, input.riverGuides.right, DEBUG_COLOUR_GUIDE_EDGE);
  }
  return {
    vertices: new Float32Array(data),
    vertexCount: data.length / 6,
  };
}
