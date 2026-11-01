/**
 * Island-as-land geometry (#493 Phase 3c / FR5 / AC4).
 *
 * An island inside a lake is a hole in the water polygon; the renderer
 * draws it as a flat land mesh sitting just above `WATER_SURFACE_Y` so
 * the water doesn't z-fight through it. The result is the pure data a
 * `sceneryMesh`-style pass or a dedicated flat-land pass can upload
 * once per attach — the mesh does not move.
 *
 * Pure, three-free: the input is already in scene XZ (projected by
 * `ringToSceneXZ`); tessellation reuses the hole-free ear-clipper from
 * `waterPolygon.ts`.
 */
import { WATER_SURFACE_Y } from './waterStrip';
import { earClip, signedArea, type Vec2XZ } from './waterPolygon';

/** How far above the water surface the island plane sits. Enough to avoid
 * z-fighting at the horizon, small enough to look flush at the shore. */
export const ISLAND_SURFACE_Y_OFFSET = 0.05;

export interface IslandLandMesh {
  positions: Float32Array; // interleaved x, y, z
  indices: Uint32Array;
}

/** Build a flat land mesh from one island ring. CCW winding wins. */
export function buildIslandLand(ring: Vec2XZ[]): IslandLandMesh {
  if (ring.length < 3) return { positions: new Float32Array(), indices: new Uint32Array() };
  const normalised = signedArea(ring) > 0 ? ring.slice() : ring.slice().reverse();
  const triangles = earClip(normalised);
  const y = WATER_SURFACE_Y + ISLAND_SURFACE_Y_OFFSET;
  const positions = new Float32Array(normalised.length * 3);
  for (let i = 0; i < normalised.length; i++) {
    positions[i * 3] = normalised[i].x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = normalised[i].z;
  }
  return { positions, indices: new Uint32Array(triangles) };
}

/** Join many islands into one mesh — the pass draws them all in one call. */
export function buildIslandsMesh(islands: Vec2XZ[][]): IslandLandMesh {
  if (islands.length === 0) {
    return { positions: new Float32Array(), indices: new Uint32Array() };
  }
  const metaPositions: Float32Array[] = [];
  const metaIndices: Uint32Array[] = [];
  let vertexOffset = 0;
  for (const island of islands) {
    const mesh = buildIslandLand(island);
    if (mesh.indices.length === 0) continue;
    metaPositions.push(mesh.positions);
    const offset = new Uint32Array(mesh.indices.length);
    for (let i = 0; i < mesh.indices.length; i++) offset[i] = mesh.indices[i] + vertexOffset;
    metaIndices.push(offset);
    vertexOffset += mesh.positions.length / 3;
  }
  const totalPos = metaPositions.reduce((n, c) => n + c.length, 0);
  const totalIdx = metaIndices.reduce((n, c) => n + c.length, 0);
  const positions = new Float32Array(totalPos);
  const indices = new Uint32Array(totalIdx);
  let p = 0;
  let idx = 0;
  for (const c of metaPositions) {
    positions.set(c, p);
    p += c.length;
  }
  for (const c of metaIndices) {
    indices.set(c, idx);
    idx += c.length;
  }
  return { positions, indices };
}
