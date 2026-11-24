/**
 * #764 VP-36 FR4 — treelines on the real woods: `f45-treeline-strip`
 * instances laid end to end along the part of each wood's outline that faces
 * the course, where the map puts it.
 *
 * Pure. Woods under 0.2 ha are left out beyond 600 m, where they would be a
 * speck; nothing is placed past the landscape's reach. The nearest strips are
 * kept when the tier's budget (FR8) is smaller than the woods ask for.
 */
import type { LandCoverFeature, ScenePoint } from '../services/landscapeService';

export const TREELINE_MODEL_ID = 'f45-treeline-strip';
/** The strip's authored length along its local X, metres. */
export const TREELINE_STRIP_M = 100;
/** A last piece shorter than this along a chain gets no strip of its own. */
export const TREELINE_MIN_PIECE_M = 40;
/** How far inside the wood a strip's centre sits: half its 6 m depth. */
export const TREELINE_INSET_M = 3;
export const SMALL_WOOD_M2 = 2000;
export const SMALL_WOOD_REACH_M = 600;
export const TREELINE_REACH_M = 2000;
/** FR8 — resident strips at `medium`; other tiers scale it. */
export const TREELINE_BUDGET_MEDIUM = 300;

export interface TreelineInstance {
  x: number;
  z: number;
  /** About +Y; the strip's local +X maps to (cos yaw, 0, -sin yaw) (`mat4FromRotationY`). */
  yaw: number;
  /** Distance from the course, metres. */
  distance: number;
}

export interface TreelinePlan {
  instances: TreelineInstance[];
  /** Woodland polygons considered (FR10 telemetry). */
  woodlandPolygons: number;
}

const WOODLAND = new Set(['wood', 'forest']);

/** Shoelace area in the XZ plane; positive when the ring winds anticlockwise (x right, z up). */
export const signedArea = (ring: ScenePoint[]): number => {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return sum / 2;
};

const nearestOnCourse = (course: ScenePoint[], x: number, z: number): { point: ScenePoint; distance: number } => {
  let best: ScenePoint = course[0];
  let bestD = Infinity;
  for (let i = 0; i < course.length; i += 1) {
    const a = course[i];
    const b = course[Math.min(i + 1, course.length - 1)];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a[0]) * dx + (z - a[1]) * dz) / len2)) : 0;
    const px = a[0] + t * dx;
    const pz = a[1] + t * dz;
    const d = Math.hypot(x - px, z - pz);
    if (d < bestD) {
      bestD = d;
      best = [px, pz];
    }
  }
  return { point: best, distance: bestD };
};

/** Strips along one chain of course-facing edges, every 100 m, inset into the wood. */
const stripsAlong = (chain: Array<{ a: ScenePoint; b: ScenePoint; inward: ScenePoint }>, course: ScenePoint[]) => {
  const out: TreelineInstance[] = [];
  // Walk the chain as one polyline, cutting it into 100 m pieces.
  const points: Array<{ p: ScenePoint; inward: ScenePoint }> = [{ p: chain[0].a, inward: chain[0].inward }];
  for (const edge of chain) points.push({ p: edge.b, inward: edge.inward });
  const total = chain.reduce((sum, e) => sum + Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]), 0);
  const at = (s: number): { p: ScenePoint; inward: ScenePoint } => {
    let left = s;
    for (const edge of chain) {
      const len = Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1]);
      if (left <= len || edge === chain[chain.length - 1]) {
        const t = len > 0 ? Math.min(1, left / len) : 0;
        return { p: [edge.a[0] + (edge.b[0] - edge.a[0]) * t, edge.a[1] + (edge.b[1] - edge.a[1]) * t], inward: edge.inward };
      }
      left -= len;
    }
    return points[points.length - 1];
  };
  for (let start = 0; start < total; start += TREELINE_STRIP_M) {
    const end = Math.min(total, start + TREELINE_STRIP_M);
    if (end - start < TREELINE_MIN_PIECE_M) break;
    const from = at(start).p;
    const to = at(end).p;
    const mid = at((start + end) / 2);
    const x = mid.p[0] + mid.inward[0] * TREELINE_INSET_M;
    const z = mid.p[1] + mid.inward[1] * TREELINE_INSET_M;
    out.push({ x, z, yaw: Math.atan2(-(to[1] - from[1]), to[0] - from[0]), distance: nearestOnCourse(course, x, z).distance });
  }
  return out;
};

export const planTreelines = (
  features: LandCoverFeature[],
  course: ScenePoint[],
  maxInstances = TREELINE_BUDGET_MEDIUM,
): TreelinePlan => {
  const woods = features.filter((f) => f.shape === 'polygon' && WOODLAND.has(f.kind));
  const instances: TreelineInstance[] = [];
  if (course.length === 0) return { instances, woodlandPolygons: woods.length };

  for (const wood of woods) {
    const ring = wood.points;
    const closed = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
    const open = closed ? ring.slice(0, -1) : ring;
    if (open.length < 3) continue;
    const area = signedArea(open);
    const nearest = Math.min(...open.map(([x, z]) => nearestOnCourse(course, x, z).distance));
    if (nearest > TREELINE_REACH_M) continue;
    if (Math.abs(area) < SMALL_WOOD_M2 && nearest > SMALL_WOOD_REACH_M) continue;
    const ccw = area > 0;

    // Each edge, with its inward unit normal, and whether it faces the course.
    const edges = open.map((a, i) => {
      const b = open[(i + 1) % open.length];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      // Outward normal of an anticlockwise ring is (dz, -dx).
      const out: ScenePoint = ccw ? [dz / len, -dx / len] : [-dz / len, dx / len];
      const mx = (a[0] + b[0]) / 2;
      const mz = (a[1] + b[1]) / 2;
      const c = nearestOnCourse(course, mx, mz).point;
      const faces = out[0] * (c[0] - mx) + out[1] * (c[1] - mz) > 0;
      return { a, b, inward: [-out[0], -out[1]] as ScenePoint, faces };
    });

    // Chains of consecutive facing edges, starting after a non-facing one so
    // a chain that wraps past the ring's first vertex stays whole.
    const firstAway = edges.findIndex((e) => !e.faces);
    if (firstAway === -1) {
      instances.push(...stripsAlong(edges, course));
      continue;
    }
    let chain: typeof edges = [];
    for (let k = 1; k <= edges.length; k += 1) {
      const edge = edges[(firstAway + k) % edges.length];
      if (edge.faces) {
        chain.push(edge);
        continue;
      }
      if (chain.length > 0) instances.push(...stripsAlong(chain, course));
      chain = [];
    }
  }

  instances.sort((p, q) => p.distance - q.distance);
  return { instances: instances.slice(0, Math.max(0, maxInstances)), woodlandPolygons: woods.length };
};
