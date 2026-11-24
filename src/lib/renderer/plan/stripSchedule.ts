/**
 * #745 VP-25 FR4 — where along the route the water and bank strips take their
 * vertex rows. Ported from the React scene's `routeStripGeometry.ts`
 * (`buildDetailProfile`, `stripProgressSchedule`) and `curve.ts`
 * (`adaptiveSegmentCount`).
 *
 * The engine laid a row every 10 m everywhere: a tight bend faceted while a
 * long straight spent rows nobody could see. Here each stretch earns rows for
 * two reasons, summed: one per {@link TARGET_METRES_BETWEEN_ROWS} of length,
 * and one per {@link MAX_TURN_PER_ROW_DEGREES} of turning. Straight water is
 * sampled more sparsely than before and bends in proportion to how hard they
 * turn.
 *
 * The water, the banks, the water footprint and the river guides all read the
 * same schedule, so their edges stay the same polyline.
 */
import type { RouteCurve } from '../math/curve';
import { vec3 } from '../math/vec3';

/**
 * One row per this many metres of straight route. The React scene used 15 m
 * with an 800-row ceiling; 20 m keeps the demo route under the fixed 10 m
 * layout it replaces once its bends have taken their share (FR4: the triangle
 * count must not rise).
 */
export const TARGET_METRES_BETWEEN_ROWS = 20;
/**
 * Most the centreline may turn between rows. The waterline on the inside of a
 * bend turns harder than the centre (by the ratio of the radii), so this sits
 * below the six degrees at which an edge starts to read as straight.
 */
export const MAX_TURN_PER_ROW_DEGREES = 4;
/** Fewest and most row intervals a route gets. */
export const MIN_ROWS = 128;
export const MAX_ROWS = 6000;
/** Shortest interval worth emitting, metres. */
const MIN_ROW_METRES = 0.5;
/** A single probe's kink (a reconstruction spike) may claim no more than this many rows. */
const MAX_TURN_COST_PER_PROBE = 4;
const MAX_TURN_RADIANS = (MAX_TURN_PER_ROW_DEGREES * Math.PI) / 180;

/** Row intervals a route of this length gets on length alone, clamped. */
export const adaptiveSegmentCount = (routeMetres: number): number => {
  if (!Number.isFinite(routeMetres) || routeMetres <= 0) return MIN_ROWS;
  return Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.ceil(routeMetres / TARGET_METRES_BETWEEN_ROWS)));
};

const cache = new WeakMap<RouteCurve, Float64Array>();

/**
 * Progress (0..1, ascending, first 0 and last 1) of each vertex row along
 * `curve`. Cached per curve.
 */
export const stripSchedule = (curve: RouteCurve): Float64Array => {
  const hit = cache.get(curve);
  if (hit) return hit;
  const lengthMetres = Math.max(1, curve.approximateLength(64));
  // A probe every 2 m, capped: a bend needs probes finer than the turn it
  // makes, and the cap keeps a marathon bounded.
  const probes = Math.max(200, Math.min(8000, Math.ceil(lengthMetres / 2)));
  const t = new Float64Array(probes + 1);
  const cost = new Float64Array(probes + 1);
  const s = { position: vec3(), tangent: vec3(0, 0, -1), angle: 0 };
  curve.sample(0, s);
  let px = s.position[0];
  let pz = s.position[2];
  let cdx = 0;
  let cdz = 0;
  let running = 0;
  for (let i = 1; i <= probes; i++) {
    const at = i / probes;
    curve.sample(at, s);
    const dx = s.position[0] - px;
    const dz = s.position[2] - pz;
    const step = Math.hypot(dx, dz);
    let turn = 0;
    const prev = Math.hypot(cdx, cdz);
    if (step > 0 && prev > 0) {
      const cos = (dx * cdx + dz * cdz) / (step * prev);
      turn = Math.acos(Math.max(-1, Math.min(1, cos)));
    }
    running += step / TARGET_METRES_BETWEEN_ROWS + Math.min(MAX_TURN_COST_PER_PROBE, turn / MAX_TURN_RADIANS);
    t[i] = at;
    cost[i] = running;
    if (step > 0) { cdx = dx; cdz = dz; }
    px = s.position[0];
    pz = s.position[2];
  }
  const wanted = Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.ceil(running)));
  const rows = Math.max(2, Math.min(wanted, Math.floor(lengthMetres / MIN_ROW_METRES)));
  const out = new Float64Array(rows + 1);
  let k = 1;
  for (let r = 1; r < rows; r++) {
    const target = (running * r) / rows;
    while (k < probes && cost[k] < target) k++;
    const span = cost[k] - cost[k - 1];
    const blend = span > 0 ? (target - cost[k - 1]) / span : 0;
    out[r] = t[k - 1] + (t[k] - t[k - 1]) * blend;
  }
  out[rows] = 1;
  cache.set(curve, out);
  return out;
};
