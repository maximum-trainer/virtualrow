import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../lib/types/index';
import { bearingRadians, distanceBetweenMeters, polylineLengthMeters } from '../lib/utils/coordinateUtils';
import { projectPointOntoPolyline } from '../lib/utils/polylineGeometry';
import {
  FILLET_MAX_CUT_M,
  FILLET_MAX_RADIUS_M,
  STAKE_TURN_MAX_RADIUS_M,
  STAKE_TURN_MIN_RADIUS_M,
  roundCourseCorners,
} from '../lib/utils/courseCorners';

// #743: a gates-only course is a chain of gate centres. Rowed as-is, the boat,
// camera and water ribbon all pivot on the spot at every gate.

const ORIGIN = { lat: 52, lng: 0 };
const M_PER_DEG_LAT = 111_320;
/** Local metres (x east, y north) to a coordinate near the origin. */
const at = (x: number, y: number): Coordinate => ({
  lat: ORIGIN.lat + y / M_PER_DEG_LAT,
  lng: ORIGIN.lng + x / (M_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180)),
});

const turnsDegrees = (line: Coordinate[]): number[] => {
  const out: number[] = [];
  for (let i = 1; i < line.length - 1; i += 1) {
    let d = bearingRadians(line[i], line[i + 1]) - bearingRadians(line[i - 1], line[i]);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    out.push(Math.abs((d * 180) / Math.PI));
  }
  return out;
};

describe('roundCourseCorners', () => {
  it('leaves a straight chain exactly as it was', () => {
    const chain = [at(0, 0), at(0, 500), at(0, 1200)];
    expect(roundCourseCorners(chain)).toEqual(chain);
  });

  it('returns short input untouched', () => {
    expect(roundCourseCorners([])).toEqual([]);
    expect(roundCourseCorners([at(0, 0), at(0, 10)])).toEqual([at(0, 0), at(0, 10)]);
  });

  it('replaces a right-angle gate turn with an arc', () => {
    const chain = [at(0, 0), at(0, 600), at(600, 600)];
    const rounded = roundCourseCorners(chain);

    // No vertex turns the boat more than a few degrees at once.
    expect(Math.max(...turnsDegrees(rounded))).toBeLessThanOrEqual(16);
    expect(Math.max(...turnsDegrees(chain))).toBeGreaterThan(85);
    // Ends are where the course starts and finishes.
    expect(rounded[0]).toEqual(chain[0]);
    expect(rounded[rounded.length - 1]).toEqual(chain[2]);
    // Still goes past the gate: the fillet may cut at most FILLET_MAX_CUT_M
    // inside the corner, which caps a 90 degree turn at a 36 m radius.
    const miss = projectPointOntoPolyline(chain[1], rounded).offsetMeters;
    expect(miss).toBeGreaterThan(5);
    expect(miss).toBeLessThanOrEqual(FILLET_MAX_CUT_M + 0.5);
    // And is slightly shorter than the square corner, never longer.
    expect(polylineLengthMeters(rounded)).toBeLessThan(polylineLengthMeters(chain));
    expect(polylineLengthMeters(rounded)).toBeGreaterThan(polylineLengthMeters(chain) - 30);
  });

  it('shrinks the fillet on short legs instead of overrunning them', () => {
    const chain = [at(0, 0), at(0, 40), at(40, 40), at(40, 0)];
    const rounded = roundCourseCorners(chain);
    // Every point stays inside the 40 m square the gates describe.
    for (const p of rounded) {
      expect(distanceBetweenMeters(p, at(20, 20))).toBeLessThan(29);
    }
    expect(Math.max(...turnsDegrees(rounded))).toBeLessThanOrEqual(16);
  });

  it('rows round a stake instead of reversing on the spot', () => {
    // Up the lake, round the stake, back down a parallel lane 6 m over.
    const stake = at(0, 1000);
    const chain = [at(0, 0), stake, at(6, 0)];
    const rounded = roundCourseCorners(chain);

    expect(Math.max(...turnsDegrees(rounded))).toBeLessThanOrEqual(16);
    // The turn is an arc about the stake, at a rowable radius.
    const near = rounded.filter((p) => distanceBetweenMeters(p, stake) < STAKE_TURN_MAX_RADIUS_M + 1);
    expect(near.length).toBeGreaterThanOrEqual(8);
    for (const p of near) {
      const r = distanceBetweenMeters(p, stake);
      expect(r).toBeGreaterThanOrEqual(STAKE_TURN_MIN_RADIUS_M - 0.5);
      expect(r).toBeLessThanOrEqual(STAKE_TURN_MAX_RADIUS_M + 0.5);
    }
    // It goes past the far side of the stake, which a fillet never would.
    const furthestNorth = Math.max(...rounded.map((p) => p.lat));
    expect((furthestNorth - stake.lat) * M_PER_DEG_LAT).toBeGreaterThan(STAKE_TURN_MIN_RADIUS_M - 1);
    // And passes within gate tolerance of the stake gate.
    expect(projectPointOntoPolyline(stake, rounded).offsetMeters).toBeLessThanOrEqual(STAKE_TURN_MAX_RADIUS_M + 0.5);
  });

  it('turns the same way the course does', () => {
    const left = roundCourseCorners([at(0, 0), at(0, 400), at(-400, 400)]);
    const right = roundCourseCorners([at(0, 0), at(0, 400), at(400, 400)]);
    // The arc bulges toward the inside of each turn.
    expect(Math.min(...left.map((p) => p.lng))).toBeLessThan(ORIGIN.lng);
    expect(Math.max(...right.map((p) => p.lng))).toBeGreaterThan(ORIGIN.lng);
    expect(left.every((p) => p.lng <= ORIGIN.lng + 1e-9)).toBe(true);
    expect(right.every((p) => p.lng >= ORIGIN.lng - 1e-9)).toBe(true);
  });

  it('uses the widest radius the gate allows on a gentle bend', () => {
    // 40 degrees: the cut limit would allow far more than the maximum radius.
    const a = (40 * Math.PI) / 180;
    const chain = [at(0, 0), at(0, 1000), at(1000 * Math.sin(a), 1000 + 1000 * Math.cos(a))];
    const rounded = roundCourseCorners(chain);
    const arcPoints = rounded.slice(1, -1);
    // Chord between consecutive arc points on a 60 m circle at <= 15 degrees.
    const chord = distanceBetweenMeters(arcPoints[0], arcPoints[1]);
    const stepDeg = turnsDegrees(rounded)[1];
    const radius = chord / (2 * Math.sin((stepDeg * Math.PI) / 360));
    expect(radius).toBeGreaterThan(FILLET_MAX_RADIUS_M - 2);
    expect(radius).toBeLessThan(FILLET_MAX_RADIUS_M + 2);
  });

  it('turns wider when told the gate is wide enough to cut further inside', () => {
    const chain = [at(0, 0), at(0, 600), at(600, 600)];
    const narrow = roundCourseCorners(chain, { maxCutMeters: [undefined, 8, undefined] });
    const wide = roundCourseCorners(chain, { maxCutMeters: [undefined, 25, undefined] });
    const cut = (line: Coordinate[]): number => projectPointOntoPolyline(chain[1], line).offsetMeters;
    expect(cut(narrow)).toBeLessThanOrEqual(8.5);
    expect(cut(wide)).toBeGreaterThan(20);
    expect(cut(wide)).toBeLessThanOrEqual(25.5);
  });

  it('rounds a sharp turn even when the gates are close together', () => {
    // A start gate 18 m from a turning mark: too short to treat as a traced
    // line, and a reversal on the spot if left alone.
    const chain = [at(0, 0), at(0, 18), at(4, -400)];
    const rounded = roundCourseCorners(chain);
    expect(rounded.length).toBeGreaterThan(chain.length);
    expect(Math.max(...turnsDegrees(rounded))).toBeLessThan(60);
  });

  it('leaves the dense vertices of a traced line alone', () => {
    // 8 m steps round a bend, as an OSM centreline has: nothing to fillet.
    const traced = Array.from({ length: 20 }, (_, i) => {
      const a = (i * 6 * Math.PI) / 180;
      return at(80 * Math.sin(a), 80 * (1 - Math.cos(a)));
    });
    expect(roundCourseCorners(traced)).toEqual(traced);
  });
});
