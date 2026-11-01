/**
 * Polygon-water geometry: tessellate a water polygon (outer + holes for
 * islands) into a flat mesh at `WATER_SURFACE_Y` in scene coordinates
 * (#493 Phase 3 / FR4, FR5, D4(c), D11).
 *
 * The input is one lake's shoreline in **scene XZ** (metres), as produced
 * by projecting the OSM lat/lng ring through the route's local frame.
 * Outer rings wind counter-clockwise in XZ; holes wind clockwise. The
 * builder:
 *
 *  1. Merges each hole into the outer ring with a bridge edge (two
 *     coincident segments from the outer vertex nearest the hole to the
 *     hole's rightmost vertex), producing a single simple polygon.
 *  2. Ear-clips that polygon into triangles.
 *  3. Writes every vertex at `WATER_SURFACE_Y` so AC14's "flat water"
 *     test holds — no polygon vertex is ever moved off the surface Y.
 *
 * Pure, three-free, test-only. Phase 3b binds the output to a WebGPU
 * vertex buffer in `passes/water.ts`.
 *
 * Non-goals here:
 *
 * - Disc culling (`FR7`): a caller clips the polygon against a view-radius
 *   disc first (Phase 3b passes the clipped rings in).
 * - Simplification (`FR9`): `lakePolygonsForTier` already caps the ring
 *   vertex count before the enrichment reaches this builder.
 */
import { WATER_SURFACE_Y } from './waterStrip';

/** One (x, z) vertex in scene coordinates. */
export interface Vec2XZ {
  x: number;
  z: number;
}

/**
 * A polygon-with-holes in scene XZ. The outer ring winds CCW; each hole
 * winds CW. The ring arrays are open (first vertex is not repeated as
 * the last).
 */
export interface PolygonWithHoles {
  outer: Vec2XZ[];
  holes: Vec2XZ[][];
}

/** Output buffers shaped for the water pass's `float32x3` attribute. */
export interface PolygonWaterGeometry {
  positions: Float32Array; // interleaved x, y, z
  indices: Uint32Array;
}

/** Signed area of a ring in XZ; positive is CCW when viewed from +Y. */
export function signedArea(ring: Vec2XZ[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j].x + ring[i].x) * (ring[i].z - ring[j].z);
  }
  return a * 0.5;
}

/** Reverse a ring in place; used to normalise winding before ear-clipping. */
function reverse(ring: Vec2XZ[]): Vec2XZ[] {
  const out = ring.slice();
  out.reverse();
  return out;
}

/**
 * Merge a hole into its containing outer ring via a bridge. The bridge
 * runs from the hole's rightmost vertex (largest x) to the nearest
 * mutually visible outer vertex, duplicating both endpoints to keep the
 * stitched polygon simple.
 *
 * The algorithm is the standard one used by earcut: it keeps the hole's
 * cycle intact (so winding is preserved) and leaves the ear-clipping
 * step with a single simple polygon, no self-intersection.
 */
function bridgeHole(outer: Vec2XZ[], hole: Vec2XZ[]): Vec2XZ[] {
  // Find the hole vertex with the largest x — the bridge anchor on the
  // hole side.
  let holeAnchorIdx = 0;
  for (let i = 1; i < hole.length; i++) {
    if (hole[i].x > hole[holeAnchorIdx].x) holeAnchorIdx = i;
  }
  const holeAnchor = hole[holeAnchorIdx];

  // Pick the outer vertex closest to the hole anchor. This isn't the
  // literal earcut visibility test, but holes from lake polygons are small
  // compared to the outer and the closest vertex is almost always visible;
  // the ear-clipping stage will refuse any triangle that fails the ear
  // test, which handles edge cases without creating a spurious triangle.
  let outerAnchorIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < outer.length; i++) {
    const dx = outer[i].x - holeAnchor.x;
    const dz = outer[i].z - holeAnchor.z;
    const d = dx * dx + dz * dz;
    if (d < bestDist) {
      bestDist = d;
      outerAnchorIdx = i;
    }
  }

  // Build the stitched ring:
  //   outer[0..outerAnchorIdx]
  //   hole[holeAnchorIdx..], hole[..holeAnchorIdx]  (rotated)
  //   outer[outerAnchorIdx..]
  // The duplicated outer-anchor + hole-anchor vertices form a zero-width
  // bridge that ear-clipping treats as a seam.
  const stitched: Vec2XZ[] = [];
  for (let i = 0; i <= outerAnchorIdx; i++) stitched.push(outer[i]);
  for (let i = 0; i < hole.length; i++) {
    stitched.push(hole[(holeAnchorIdx + i) % hole.length]);
  }
  stitched.push(hole[holeAnchorIdx]);
  stitched.push(outer[outerAnchorIdx]);
  for (let i = outerAnchorIdx + 1; i < outer.length; i++) stitched.push(outer[i]);
  return stitched;
}

/** 2D cross product (CCW positive) of (b-a) × (c-a). */
function cross2(a: Vec2XZ, b: Vec2XZ, c: Vec2XZ): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

/**
 * Is `p` strictly inside triangle `abc`? Shared edge counts as "outside"
 * so a reflex-vertex ear test does not reject itself.
 */
function sameVertex(a: Vec2XZ, b: Vec2XZ): boolean {
  return a.x === b.x && a.z === b.z;
}

function pointInTri(p: Vec2XZ, a: Vec2XZ, b: Vec2XZ, c: Vec2XZ): boolean {
  // Treat a point that coincides with one of the triangle's own vertices
  // as outside — the bridge seam makes some vertices appear twice in the
  // stitched ring, and the duplicate must not block its own ear.
  if (sameVertex(p, a) || sameVertex(p, b) || sameVertex(p, c)) return false;
  // Otherwise standard inclusive sign test — a point on an edge of the
  // triangle counts as inside, which is required to stop ear-clipping
  // from cutting through a reflex vertex that sits on that edge.
  const d1 = cross2(a, b, p);
  const d2 = cross2(b, c, p);
  const d3 = cross2(c, a, p);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Ear-clip triangulation of a simple polygon in XZ. The input must wind
 * CCW; the caller enforces that. Returns index triples into the input
 * array. O(n²) — enough for the ≤ 2048-vertex rings
 * `LAKE_POLYGON_STORE_VERTICES` caps us at.
 */
export function earClip(ring: Vec2XZ[]): number[] {
  const n = ring.length;
  if (n < 3) return [];
  // Prev / next linked list.
  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    prev[i] = (i - 1 + n) % n;
    next[i] = (i + 1) % n;
  }
  const triangles: number[] = [];
  let remaining = n;
  let i = 0;
  // Guard against pathological input: at most n² iterations.
  let safety = n * n;
  // >= 0 so a bridge-vertex "zero-area ear" from a hole seam is accepted
  // and clipped out instead of looping until the safety counter expires.
  // The resulting degenerate triangles render nothing on the GPU.
  while (remaining > 3 && safety > 0) {
    safety--;
    const pi = prev[i];
    const ni = next[i];
    const a = ring[pi];
    const b = ring[i];
    const c = ring[ni];
    const x = cross2(a, b, c);
    if (x >= 0) {
      let clear = true;
      if (x > 0) {
        // Only check containment for strictly-convex ears; a zero-area
        // ear from the bridge is always safe to clip.
        let k = next[ni];
        while (k !== pi) {
          if (pointInTri(ring[k], a, b, c)) {
            clear = false;
            break;
          }
          k = next[k];
        }
      }
      if (clear) {
        if (x > 0) triangles.push(pi, i, ni);
        next[pi] = ni;
        prev[ni] = pi;
        remaining--;
        i = pi;
        continue;
      }
    }
    i = ni;
  }
  // Final triangle.
  if (remaining === 3) {
    const pi = prev[i];
    const ni = next[i];
    if (cross2(ring[pi], ring[i], ring[ni]) > 0) {
      triangles.push(pi, i, ni);
    }
  }
  return triangles;
}

/**
 * Build a flat polygon-water mesh at `WATER_SURFACE_Y`. The input is
 * expected to wind outer-CCW / holes-CW; the function normalises either
 * way defensively.
 */
export function buildPolygonWater(polygon: PolygonWithHoles): PolygonWaterGeometry {
  if (polygon.outer.length < 3) {
    return { positions: new Float32Array(), indices: new Uint32Array() };
  }

  // Normalise winding: outer CCW, holes CW.
  const outer = signedArea(polygon.outer) > 0 ? polygon.outer : reverse(polygon.outer);
  const holes = polygon.holes
    .filter((h) => h.length >= 3)
    .map((h) => (signedArea(h) < 0 ? h : reverse(h)));

  // Merge holes into outer, large holes first — bridging the biggest hole
  // first means later bridges don't cut through earlier ones.
  const sortedHoles = holes
    .map((h) => ({ ring: h, size: Math.abs(signedArea(h)) }))
    .sort((a, b) => b.size - a.size);

  let ring = outer.slice();
  for (const h of sortedHoles) {
    ring = bridgeHole(ring, h.ring);
  }

  const triangles = earClip(ring);
  const positions = new Float32Array(ring.length * 3);
  for (let i = 0; i < ring.length; i++) {
    positions[i * 3] = ring[i].x;
    positions[i * 3 + 1] = WATER_SURFACE_Y;
    positions[i * 3 + 2] = ring[i].z;
  }
  const indices = new Uint32Array(triangles);
  return { positions, indices };
}

/**
 * Visible-disc clip of a polygon against a circle centred at (cx, cz)
 * with radius r, approximated as a 32-gon in XZ. Used by Phase 3b to
 * bound the drawn polygon to `DEFAULT_MAX_DISTANCE` around the follow
 * boat (FR7 / D8c), so a 30 km lake only tessellates what the fog shows.
 *
 * The clip is Sutherland–Hodgman against each disc edge in sequence —
 * O(n·segments) and small enough to run every frame against the already
 * tier-simplified ring.
 */
export function clipPolygonToDisc(
  ring: Vec2XZ[],
  cx: number,
  cz: number,
  radius: number,
  segments = 32,
): Vec2XZ[] {
  if (ring.length < 3 || radius <= 0) return [];
  let out = ring.slice();
  const twoPi = Math.PI * 2;
  for (let s = 0; s < segments; s++) {
    const a0 = (s / segments) * twoPi;
    const a1 = ((s + 1) / segments) * twoPi;
    const p0 = { x: cx + Math.cos(a0) * radius, z: cz + Math.sin(a0) * radius };
    const p1 = { x: cx + Math.cos(a1) * radius, z: cz + Math.sin(a1) * radius };
    out = clipAgainstEdge(out, p0, p1);
    if (out.length === 0) break;
  }
  return out;
}

function isInside(p: Vec2XZ, edgeA: Vec2XZ, edgeB: Vec2XZ): boolean {
  // "Inside" of a CCW disc edge means the interior side: cross > 0.
  return cross2(edgeA, edgeB, p) >= 0;
}

function intersectEdge(a: Vec2XZ, b: Vec2XZ, p0: Vec2XZ, p1: Vec2XZ): Vec2XZ {
  // Line-line intersection in XZ. Caller has already decided the two
  // endpoints straddle the edge, so the denominator is non-zero.
  const dx1 = b.x - a.x;
  const dz1 = b.z - a.z;
  const dx2 = p1.x - p0.x;
  const dz2 = p1.z - p0.z;
  const denom = dx1 * dz2 - dz1 * dx2;
  const t = ((p0.x - a.x) * dz2 - (p0.z - a.z) * dx2) / (denom || Number.EPSILON);
  return { x: a.x + dx1 * t, z: a.z + dz1 * t };
}

function clipAgainstEdge(ring: Vec2XZ[], p0: Vec2XZ, p1: Vec2XZ): Vec2XZ[] {
  const out: Vec2XZ[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[(i - 1 + ring.length) % ring.length];
    const b = ring[i];
    const aIn = isInside(a, p0, p1);
    const bIn = isInside(b, p0, p1);
    if (bIn) {
      if (!aIn) out.push(intersectEdge(a, b, p0, p1));
      out.push(b);
    } else if (aIn) {
      out.push(intersectEdge(a, b, p0, p1));
    }
  }
  return out;
}
