// #725 VP-07 FR4 — the far-backdrop ring: from anywhere on the demo route
// no wide stretch of horizon is bare sky over flat grass.
import { describe, expect, it } from 'vitest';
import { toEngineRoute } from '../../ui/sceneryRoute';
import { willowbrookRiverCoordinates } from '../../../data/seedRouteCoordinates';
import { WILLOWBROOK_ROUTE_ID } from '../../../components/rower3d/sceneryTrack';
import { routeTotalDistanceMeters } from '../../utils/geoUtils';
import type { WaterRoute } from '../../types';
import { RouteCurve } from '../../renderer/math/curve';
import { vec3 } from '../../renderer/math/vec3';
import { ASSET_SCALE, RING_RIDGE_ID, RING_SKYLINE_ID } from '../sceneryPlacement';
import { BUILT_IN_FOOTPRINT_LOOKUP } from '../sceneryFootprints';
import { BACKDROP_DRAW_METRES, sceneryCastsShadowFor } from '../../renderer/plan/sceneryDrawDistance';

const willowbrook: WaterRoute = {
  id: WILLOWBROOK_ROUTE_ID,
  name: 'Willowbrook River',
  description: '',
  distance: routeTotalDistanceMeters(willowbrookRiverCoordinates) / 1000,
  difficulty: 'easy',
  location: 'Willowbrook Valley',
  coordinates: willowbrookRiverCoordinates,
  elevationGain: 0,
  estimatedTime: 0,
  tags: [],
  createdAt: new Date('2026-01-01'),
};

/** Models that put something on the horizon. */
const HORIZON = /^f(10|11|12|13|45|46|47)-/;
/** How far the backdrop strips are drawn. */
const SEEN_TO_METRES = BACKDROP_DRAW_METRES;
/** Half the demo river's width, metres. */
const WATER_HALF_METRES = 22;

type Piece = { x: number; z: number; ax: number; az: number; half: number };

const widestBareDegrees = (eye: [number, number], pieces: Piece[], water: [number, number][]): number => {
  const spans: [number, number][] = [];
  // Looking along the river the horizon is water, not bank: those bearings
  // are not bare grass.
  for (const [wx, wz] of water) {
    const d = Math.hypot(wx - eye[0], wz - eye[1]);
    if (d < 1 || d > SEEN_TO_METRES) continue;
    const c = Math.atan2(wz - eye[1], wx - eye[0]);
    const w = Math.max(Math.atan2(WATER_HALF_METRES, d), (1 * Math.PI) / 180);
    spans.push([c - w, c + w]);
    if (c + w > Math.PI) spans.push([c - w - 2 * Math.PI, c + w - 2 * Math.PI]);
    if (c - w < -Math.PI) spans.push([c - w + 2 * Math.PI, c + w + 2 * Math.PI]);
  }
  for (const p of pieces) {
    if (Math.hypot(p.x - eye[0], p.z - eye[1]) > SEEN_TO_METRES) continue;
    const a = Math.atan2(p.z + p.az * p.half - eye[1], p.x + p.ax * p.half - eye[0]);
    const b = Math.atan2(p.z - p.az * p.half - eye[1], p.x - p.ax * p.half - eye[0]);
    let lo = Math.min(a, b);
    let hi = Math.max(a, b);
    if (hi - lo > Math.PI) [lo, hi] = [hi, lo + 2 * Math.PI];
    spans.push([lo, hi]);
    if (hi > Math.PI) spans.push([lo - 2 * Math.PI, hi - 2 * Math.PI]);
  }
  if (spans.length === 0) return 360;
  spans.sort((u, v) => u[0] - v[0]);
  let widest = 0;
  let reach = spans[0][1];
  for (const [lo, hi] of spans) {
    if (lo > reach) widest = Math.max(widest, lo - reach);
    reach = Math.max(reach, hi);
  }
  // Wrap-around gap from the last span back to the first.
  widest = Math.max(widest, spans[0][0] + 2 * Math.PI - reach);
  return (widest * 180) / Math.PI;
};

describe('far-backdrop ring (#725 FR4)', () => {
  const route = toEngineRoute(willowbrook, null, 'medium')!;
  const pieces = (route.sceneryGlbs ?? [])
    .filter((g) => HORIZON.test(g.id))
    .flatMap((g) => {
      const half = (BUILT_IN_FOOTPRINT_LOOKUP(g.id)?.extentX ?? 0) / 2;
      return g.instances.map((i) => ({
        x: i.position[0],
        z: i.position[2],
        // The model's long (X) axis after its yaw.
        ax: Math.cos(i.rotationY),
        az: -Math.sin(i.rotationY),
        half: half * (i.scale / ASSET_SCALE),
      }));
    });

  it('ridges line both banks, and the ring casts no shadows', () => {
    const ids = new Set((route.sceneryGlbs ?? []).map((g) => g.id));
    expect(ids.has(RING_RIDGE_ID)).toBe(true);
    expect(ids.has(RING_SKYLINE_ID)).toBe(true);
    expect(sceneryCastsShadowFor(RING_RIDGE_ID)).toBe(false);
    expect(sceneryCastsShadowFor(RING_SKYLINE_ID)).toBe(false);
  });

  it('from every 250 m of the route no more than 15 degrees of horizon is bare', () => {
    const curve = new RouteCurve(route.curvePoints!.map(([x, y, z]) => vec3(x, y, z)), route.isClosedLoop ?? false);
    const length = curve.lengthMeters;
    const s = { position: vec3(), tangent: vec3(0, 0, -1), angle: 0 };
    // The water: the route, and the river running on past both ends.
    const water: [number, number][] = [];
    for (let m = 0; m <= length; m += 10) {
      curve.sample(Math.min(0.999, m / length), s);
      water.push([s.position[0], s.position[2]]);
    }
    for (const [t, dir] of [[0, -1], [0.999, 1]] as const) {
      curve.sample(t, s);
      for (let m = 10; m <= SEEN_TO_METRES; m += 10) water.push([s.position[0] + dir * s.tangent[0] * m, s.position[2] + dir * s.tangent[2] * m]);
    }
    const gaps: string[] = [];
    let widest = 0;
    for (let m = 0; m <= length; m += 250) {
      curve.sample(Math.min(0.999, m / length), s);
      const g = widestBareDegrees([s.position[0], s.position[2]], pieces, water);
      widest = Math.max(widest, g);
      gaps.push(`${m} m: ${g.toFixed(0)}`);
    }
    expect(widest, gaps.join(', ')).toBeLessThan(15);
  });
});
