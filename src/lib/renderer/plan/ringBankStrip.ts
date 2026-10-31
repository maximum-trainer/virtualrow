/**
 * Ring-bank strip (#493 Phase 3c / FR6 / D6a).
 *
 * The shoreline bank for a lake / open-water polygon isn't swept along
 * the route — it hugs the polygon outer ring, going round the water
 * body. For each edge of the ring we emit a quad extending outward by
 * `outwardMeters` along the edge's left-hand (outside) normal in scene
 * XZ, meeting its neighbour at the shared vertex.
 *
 * The output is a plain triangle-list mesh at `BANK_SURFACE_Y`; the
 * existing bank pass binds it and shades it with the same triplanar
 * material the swept-ribbon bank uses, so the shoreline reads as the
 * continuation of the river bank rather than a separate biome.
 *
 * Pure, three-free. The caller normalises the ring to CCW first; a CW
 * ring would extrude inward and bury the bank under the lake.
 */
import type { Vec2XZ } from './waterPolygon';
import { WATER_SURFACE_Y } from './waterStrip';

/** Scene Y of the bank's land plane. One cm above water. */
export const BANK_SURFACE_Y = WATER_SURFACE_Y + 0.01;

export interface RingBankStrip {
  positions: Float32Array; // interleaved x, y, z
  indices: Uint32Array;
}

/**
 * Build an outward-pointing strip around one outer ring. Each ring edge
 * becomes two triangles sitting at `BANK_SURFACE_Y`.
 */
export function buildRingBankStrip(
  ring: Vec2XZ[],
  outwardMeters: number,
): RingBankStrip {
  if (ring.length < 3 || outwardMeters <= 0) {
    return { positions: new Float32Array(), indices: new Uint32Array() };
  }
  const n = ring.length;
  const positions = new Float32Array(n * 2 * 3);
  const indices = new Uint32Array(n * 6);

  for (let i = 0; i < n; i++) {
    const curr = ring[i];
    const next = ring[(i + 1) % n];
    // Edge direction and left-hand (outside, for a CCW ring) perpendicular
    // in XZ. (dx, dz) → outward normal is (dz, -dx).
    const dx = next.x - curr.x;
    const dz = next.z - curr.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = dz / len;
    const nz = -dx / len;
    // Inner vertex (on the shoreline) and outer vertex (outwardMeters away).
    const inner = i * 6;
    positions[inner] = curr.x;
    positions[inner + 1] = BANK_SURFACE_Y;
    positions[inner + 2] = curr.z;
    positions[inner + 3] = curr.x + nx * outwardMeters;
    positions[inner + 4] = BANK_SURFACE_Y;
    positions[inner + 5] = curr.z + nz * outwardMeters;
  }

  // Each ring edge is one quad: (inner_i, outer_i, inner_(i+1), outer_(i+1)).
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    const b = ((i + 1) % n) * 2;
    const o = i * 6;
    indices[o] = a; // inner i
    indices[o + 1] = a + 1; // outer i
    indices[o + 2] = b; // inner i+1
    indices[o + 3] = a + 1; // outer i
    indices[o + 4] = b + 1; // outer i+1
    indices[o + 5] = b; // inner i+1
  }

  return { positions, indices };
}
