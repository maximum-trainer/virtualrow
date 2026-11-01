/**
 * The 1 Hz activity stream behind a completed row (issue #221, R1).
 *
 * Rowers push faster than they need to be recorded — a PM5 notifies at 4 Hz —
 * so the sampler keeps the first packet of each elapsed second and discards
 * the rest. That bounds a session at one sample per second of rowing: about
 * 3,600 for an hour, or roughly 200 kB of plain objects, which is the whole
 * memory footprint of the feature.
 *
 * Position is the rowed `distance` interpolated along the route polyline, the
 * same mapping that puts the boat on the curve in the 3D scene, so the track
 * in the exported file covers the water actually rowed rather than the whole
 * course.
 */
import type { ActivitySample, Coordinate, PM5Data } from '../types/index';
import { cumulativeLengths, interpolateAlong, isClosedLoop } from '../utils/polylineGeometry';

/**
 * Metres below which first-coord ≈ last-coord counts as a closed loop
 * (issue #466, D1(b)). 10 m is lenient enough for a GPX export's rounded
 * closing vertex to still match, strict enough to leave an obvious
 * out-and-back open.
 */
export const LOOP_CLOSURE_EPSILON_METRES = 10;

export class ActivitySampler {
  private samples: ActivitySample[] = [];
  private lastSampledSecond = -1;
  private route: Coordinate[] = [];
  private routeCumulative: number[] = [];
  private routeIsLoop = false;
  private routeTotalMetres = 0;
  /**
   * When the rower is intentionally looping a non-closed route (#647 FR8), the
   * sampler wraps the position in the same way `routeIsLoop` already does for
   * natural loops — so the FIT activity's GPS trace re-walks the route each
   * lap and intervals.icu / Garmin see one continuous row on the route's own
   * shape rather than a straight line past the final vertex.
   */
  private loopActive = false;

  /** Begin a new series. A route of fewer than two points yields samples with no position. */
  start(routeCoordinates: Coordinate[] = []): void {
    this.samples = [];
    this.lastSampledSecond = -1;
    this.route = routeCoordinates.length >= 2 ? routeCoordinates : [];
    this.routeCumulative = this.route.length >= 2 ? cumulativeLengths(this.route) : [];
    this.routeTotalMetres = this.routeCumulative[this.routeCumulative.length - 1] ?? 0;
    this.routeIsLoop = isClosedLoop(this.route, LOOP_CLOSURE_EPSILON_METRES);
  }

  /**
   * Turn the loop-active flag on or off (#647). While on, `positionAt` wraps
   * `distance` modulo the route length even on an open route, so each lap's
   * samples sit on the route's own polyline.
   */
  setLoopActive(active: boolean): void {
    this.loopActive = active;
  }

  /**
   * Record `data` if its elapsed second has not been recorded yet.
   *
   * `distance` is the session's own distance rather than the rower's raw
   * counter, so it is already offset-corrected and monotonic.
   */
  record(data: PM5Data, elapsedSeconds: number, distance: number): void {
    if (elapsedSeconds <= this.lastSampledSecond) return;
    this.lastSampledSecond = elapsedSeconds;
    this.samples.push({
      t: elapsedSeconds,
      distance,
      pace: data.pace,
      power: data.power,
      cadence: data.cadence,
      heartRate: data.heartRate,
      ...this.positionAt(distance),
    });
  }

  getSamples(): ActivitySample[] {
    return this.samples;
  }

  private positionAt(distance: number): Coordinate | Record<string, never> {
    if (this.route.length === 0) return {};
    // On a closed loop, a row that exceeds the loop length wraps back to the
    // start rather than piling every late sample on the last vertex (issue
    // #466, FR4). An open route with the #647 loop feature on wraps the same
    // way, so FIT's GPS trace re-walks the route each lap. Non-loop open
    // routes clamp to the final coordinate via interpolateAlong.
    const wrap = (this.routeIsLoop || this.loopActive) && this.routeTotalMetres > 0;
    const effective = wrap
      ? ((distance % this.routeTotalMetres) + this.routeTotalMetres) % this.routeTotalMetres
      : distance;
    return interpolateAlong(this.route, effective, this.routeCumulative);
  }
}
