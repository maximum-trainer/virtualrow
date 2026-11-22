/**
 * Three-free port of the Catmull-Rom route curve used by the three scene
 * (`src/components/rower3d/curve.ts`, retired in #542).
 *
 * The spline matches three's `CatmullRomCurve3` with tension 0.5 (which
 * `createRouteCurve` used). An open spline uses mirrored virtual endpoints; a
 * closed loop wraps around.
 *
 * `sample(progress)` is parameterised by ARC LENGTH: `progress` is the
 * fraction of the route's length travelled, exactly as the React scene's
 * `getPointAt` + `distanceToProgress` pair behaved. The first cut of this port
 * sampled uniformly in spline-parameter space, which is only the same thing
 * when the control points are evenly spaced. Route points are not: after
 * simplify + upsample they sit anywhere between 5 m and 10 m apart, and a
 * gate-chain course can have a 600 m leg next to a 15 m one. Uniform sampling
 * made the boat cover up to twice the ground per metre rowed on some stretches
 * and half on others, and put everything addressed by progress (shore widths,
 * scenery bands, distance posts, the ghost) in the wrong place by the same
 * factor. The cumulative-length table below is the port of
 * `getCurveDistances`; `sampleUniform` keeps the raw parameter available.
 */

import type { Vec3 } from './vec3';
import { vec3, vec3Normalize, vec3Set } from './vec3';

export interface CurvePoint {
  position: Vec3;
  tangent: Vec3;
  /** Y-axis heading in radians (atan2(x, z) of the tangent). */
  angle: number;
}

/**
 * How near a closed route's last point must sit to its first to count as the
 * same point (scene units = metres). Matches `LOOP_CLOSURE_TOLERANCE_METERS`.
 */
export const CLOSED_LOOP_DUPLICATE_TOLERANCE = 5;

/** Parameter samples per spline span in the arc-length table. */
const TABLE_SAMPLES_PER_SPAN = 4;
/** Table size bounds: enough for a sprint, bounded for a marathon. */
const MIN_TABLE_SAMPLES = 64;
const MAX_TABLE_SAMPLES = 65536;

export class RouteCurve {
  private readonly pts: readonly Vec3[];
  private readonly closed: boolean;
  /** Cumulative length at uniform parameter steps; built on first use. */
  private table: Float64Array | null = null;
  private readonly scratch: CurvePoint = { position: vec3(), tangent: vec3(0, 0, -1), angle: 0 };

  constructor(points: readonly Vec3[], closed = false) {
    this.closed = closed;
    // A lap course arrives with its finish on top of its start. The closed
    // spline already joins last -> first, so keeping the duplicate adds a
    // near-zero span at the seam whose tangent points nowhere useful: bank
    // normals either side of the line disagree and the water shows a seam
    // (#224). `createRouteCurve` popped it; so do we.
    if (closed && points.length >= 4) {
      const first = points[0];
      const last = points[points.length - 1];
      const gap = Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]);
      this.pts = gap <= CLOSED_LOOP_DUPLICATE_TOLERANCE ? points.slice(0, -1) : points;
    } else {
      this.pts = points;
    }
  }

  /** Number of control points (not a distance; see {@link lengthMeters}). */
  get length(): number {
    return this.pts.length;
  }

  /** Arc length of the curve in scene units (metres at `SCENE_SCALE` 1). */
  get lengthMeters(): number {
    if (this.pts.length < 2) return 0;
    const table = this.lengthTable();
    return table[table.length - 1];
  }

  /**
   * Position, tangent and heading at `progress`, a fraction of the curve's
   * arc length in [0, 1].
   */
  sample(progress: number, out?: CurvePoint): CurvePoint {
    if (this.pts.length < 2) return this.sampleUniform(progress, out);
    return this.sampleUniform(this.parameterAtProgress(progress), out);
  }

  /** Fraction of the curve's length that `distance` scene units represents. */
  progressAtDistance(distance: number): number {
    const total = this.lengthMeters;
    if (!(total > 0) || !Number.isFinite(distance)) return 0;
    return Math.max(0, Math.min(1, distance / total));
  }

  /**
   * Spline parameter in [0, 1] for an arc-length fraction: binary search over
   * the cumulative table, then linear interpolation inside the bracket. The
   * port of `distanceToProgress`.
   */
  private parameterAtProgress(progress: number): number {
    const t = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
    const table = this.lengthTable();
    const last = table.length - 1;
    const total = table[last];
    if (!(total > 0)) return t;
    const wanted = t * total;
    let low = 0;
    let high = last;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (table[mid] < wanted) low = mid + 1;
      else high = mid;
    }
    const upper = Math.max(1, low);
    const lower = upper - 1;
    const span = table[upper] - table[lower];
    const within = span > 0 ? (wanted - table[lower]) / span : 0;
    return (lower + within) / last;
  }

  private lengthTable(): Float64Array {
    if (this.table) return this.table;
    const n = this.pts.length;
    const spans = this.closed ? n : n - 1;
    const samples = Math.max(
      MIN_TABLE_SAMPLES,
      Math.min(MAX_TABLE_SAMPLES, spans * TABLE_SAMPLES_PER_SPAN),
    );
    const table = new Float64Array(samples + 1);
    const s = this.scratch;
    this.sampleUniform(0, s);
    let px = s.position[0];
    let py = s.position[1];
    let pz = s.position[2];
    let total = 0;
    for (let i = 1; i <= samples; i += 1) {
      this.sampleUniform(i / samples, s);
      total += Math.hypot(s.position[0] - px, s.position[1] - py, s.position[2] - pz);
      table[i] = total;
      px = s.position[0];
      py = s.position[1];
      pz = s.position[2];
    }
    this.table = table;
    return table;
  }

  /**
   * Sample at a raw spline parameter in [0, 1] (uniform across control
   * points). Geometry and gameplay want {@link sample}; this is for callers
   * that iterate control points.
   */
  sampleUniform(progress: number, out?: CurvePoint): CurvePoint {
    const target = out ?? {
      position: vec3(),
      tangent: vec3(0, 0, -1),
      angle: 0,
    };
    const n = this.pts.length;
    if (n === 0) {
      vec3Set(target.position, 0, 0, 0);
      vec3Set(target.tangent, 0, 0, -1);
      target.angle = 0;
      return target;
    }
    if (n === 1) {
      target.position[0] = this.pts[0][0];
      target.position[1] = this.pts[0][1];
      target.position[2] = this.pts[0][2];
      vec3Set(target.tangent, 0, 0, -1);
      target.angle = 0;
      return target;
    }

    const t = Math.max(0, Math.min(1, progress));
    const segments = this.closed ? n : n - 1;
    const u = t * segments;
    const i = Math.min(Math.floor(u), segments - (this.closed ? 0 : 1));
    const localT = u - i;

    const p0 = this.get(i - 1);
    const p1 = this.get(i);
    const p2 = this.get(i + 1);
    const p3 = this.get(i + 2);

    const tt = localT * localT;
    const ttt = tt * localT;

    // Catmull-Rom basis with tension 0.5.
    const b0 = -0.5 * ttt + tt - 0.5 * localT;
    const b1 = 1.5 * ttt - 2.5 * tt + 1;
    const b2 = -1.5 * ttt + 2 * tt + 0.5 * localT;
    const b3 = 0.5 * ttt - 0.5 * tt;

    target.position[0] = b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0];
    target.position[1] = b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1];
    target.position[2] = b0 * p0[2] + b1 * p1[2] + b2 * p2[2] + b3 * p3[2];

    // Tangent from derivative of the basis.
    const d0 = -1.5 * tt + 2 * localT - 0.5;
    const d1 = 4.5 * tt - 5 * localT;
    const d2 = -4.5 * tt + 4 * localT + 0.5;
    const d3 = 1.5 * tt - localT;

    target.tangent[0] = d0 * p0[0] + d1 * p1[0] + d2 * p2[0] + d3 * p3[0];
    target.tangent[1] = d0 * p0[1] + d1 * p1[1] + d2 * p2[1] + d3 * p3[1];
    target.tangent[2] = d0 * p0[2] + d1 * p1[2] + d2 * p2[2] + d3 * p3[2];
    vec3Normalize(target.tangent, target.tangent);

    target.angle = Math.atan2(target.tangent[0], target.tangent[2]);
    return target;
  }

  /** Length of the curve, approximated by a straight sum of segment chords. */
  /**
   * Arc length of the curve. `samples` is accepted for source compatibility
   * and ignored: every caller now reads the same table {@link sample} uses, so
   * a strip's division count and the boat's distance mapping cannot disagree.
   */
  approximateLength(_samples = 64): number {
    return this.lengthMeters;
  }

  private get(index: number): Vec3 {
    const n = this.pts.length;
    if (this.closed) {
      return this.pts[((index % n) + n) % n];
    }
    if (index < 0) {
      // Mirror the second point across the first for a plausible virtual endpoint.
      const first = this.pts[0];
      const second = this.pts[1] ?? first;
      const out = vec3();
      out[0] = 2 * first[0] - second[0];
      out[1] = 2 * first[1] - second[1];
      out[2] = 2 * first[2] - second[2];
      return out;
    }
    if (index >= n) {
      const last = this.pts[n - 1];
      const prev = this.pts[n - 2] ?? last;
      const out = vec3();
      out[0] = 2 * last[0] - prev[0];
      out[1] = 2 * last[1] - prev[1];
      out[2] = 2 * last[2] - prev[2];
      return out;
    }
    return this.pts[index];
  }
}
