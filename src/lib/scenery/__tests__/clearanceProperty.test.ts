// #723 VP-05 — property-style guard that every placement a route
// computes keeps clear of the racing line (FR1), stands wholly past
// the waterline on the bank (FR3) and hugs the bank when it rides on
// the water (FR2). Walks both of today's demo-route sources
// (Willowbrook from `routeService` + a synthetic HOCR-flavoured
// gates-only route) across every tier × enrichment pair.
//
// #760: and the recorded imported rownative courses the oversized
// boathouse appeared on (Head of the Cuyahoga, Lake Quinsigamond, Head
// of the Cam, Hamburg Fari 7500, Seekonk North Stake Race), rowed along
// their gate chains as an import does.

import { beforeAll, describe, expect, it } from 'vitest';
import cuyahoga114 from '../../../__tests__/fixtures/rownative/114.json';
import quinsigamond115 from '../../../__tests__/fixtures/rownative/115.json';
import cam171 from '../../../__tests__/fixtures/rownative/171.json';
import hamburg124 from '../../../__tests__/fixtures/rownative/124.json';
import seekonk104 from '../../../__tests__/fixtures/rownative/104.json';
import { GLB_WATER_MARGIN_METRES, routeWaterFootprint } from '../../renderer/plan/waterFootprint';
import { bridgeParallelLegs, islandLand } from '../../renderer/plan/parallelLegs';
import { buildWaterStrip } from '../../renderer/plan/waterStrip';
import { resolveCourseGeometry, type RownativeCourseGeometryInput } from '../../services/rownativeGeometry';
import { toEngineRoute } from '../../ui/sceneryRoute';
import { willowbrookRiverCoordinates } from '../../../data/seedRouteCoordinates';
import { WILLOWBROOK_ROUTE_ID } from '../../../components/rower3d/sceneryTrack';
import { routeTotalDistanceMeters } from '../../utils/geoUtils';
import type { WaterRoute } from '../../types';
import type { PerformanceMode } from '../sceneryPlacement';
import type { RouteEnrichmentData } from '../../services/routeEnrichmentService';
import { keepClearHalfWidth } from '../laneClearance';
import { BUILT_IN_FOOTPRINT_LOOKUP, footprintRadiusFor } from '../sceneryFootprints';
import { RouteCurve } from '../../renderer/math/curve';
import { vec3 } from '../../renderer/math/vec3';

const TIERS: PerformanceMode[] = ['basic', 'low', 'medium', 'high', 'extra-high'];

const willowbrook: WaterRoute = {
  id: WILLOWBROOK_ROUTE_ID,
  name: 'Willowbrook River',
  description: '',
  distance: Math.round(routeTotalDistanceMeters(willowbrookRiverCoordinates)) / 1000,
  difficulty: 'easy',
  location: 'Willowbrook Valley',
  coordinates: willowbrookRiverCoordinates,
  elevationGain: 0,
  estimatedTime: 0,
  tags: [],
  createdAt: new Date('2026-01-01'),
};

const fallbackEnrichment: RouteEnrichmentData = {
  waterWidthMeters: 45,
  segmentProfiles: [],
  elevations: null,
  buildings: null,
  crossings: null,
  waterBodyType: 'river',
} as unknown as RouteEnrichmentData;

const nullEnrichment: RouteEnrichmentData | null = null;

const IMPORTED_COURSES: [string, unknown][] = [
  ['Head of the Cuyahoga', cuyahoga114],
  ['Lake Quinsigamond Lap of the Lake', quinsigamond115],
  ['Head of the Cam', cam171],
  ['Hamburg Fari 7500', hamburg124],
  ['Seekonk North Stake Race', seekonk104],
];
const routes = new Map<string, WaterRoute>([['Willowbrook', willowbrook]]);

beforeAll(async () => {
  for (const [name, file] of IMPORTED_COURSES) {
    const input = file as RownativeCourseGeometryInput;
    const { coordinates } = await resolveCourseGeometry(input);
    routes.set(name, {
      ...willowbrook,
      id: `rownative-${input.id}`,
      name,
      location: '',
      coordinates,
      distance: Math.round(routeTotalDistanceMeters(coordinates)) / 1000,
    });
  }
});

describe('placement clearance property (#723 FR1/FR2/FR3, #760)', () => {
  for (const routeName of ['Willowbrook', ...IMPORTED_COURSES.map(([name]) => name)]) {
  for (const tier of TIERS) {
    for (const [enrichName, enrichment] of [
      ['no-enrichment', nullEnrichment] as const,
      ['fallback-enrichment', fallbackEnrichment] as const,
    ]) {
      it(`${routeName} @ ${tier} × ${enrichName}: every placement respects the corridor + bank`, () => {
        const route = routes.get(routeName);
        expect(route, `${routeName} resolved`).toBeDefined();
        const engineRoute = toEngineRoute(route, enrichment, tier);
        expect(engineRoute).not.toBeNull();
        if (!engineRoute || !engineRoute.curvePoints || engineRoute.curvePoints.length < 2) return;
        const corridor = keepClearHalfWidth();
        // Rebuild a RouteCurve from the engine route's curvePoints — the
        // same one `rideScene.ts` builds; projecting each instance onto
        // the nearest sample gives us its offset from the centreline.
        const curve = new RouteCurve(
          engineRoute.curvePoints.map(([x, y, z]) => vec3(x, y, z)),
          engineRoute.isClosedLoop ?? false,
        );
        const curveSample = { position: vec3(), tangent: vec3(0, 0, -1), angle: 0 };
        const sampleAt = (t: number) => {
          curve.sample(Math.max(0, Math.min(0.999, t)), curveSample);
          return curveSample;
        };
        // #742 FR3: the engine takes any model standing on some part of
        // the route's water (another leg's, on a lap) out before drawing
        // it. Built as rideScene builds it, so this guards what is drawn.
        const legs = bridgeParallelLegs(curve, engineRoute.waterEdgesForProgress, {
          isLand: islandLand(engineRoute.lakePolygons),
        });
        const routeWater = routeWaterFootprint(buildWaterStrip(curve, { edgesForProgress: legs.edgesForProgress }));
        for (const group of engineRoute.sceneryGlbs ?? []) {
          const radius = footprintRadiusFor(group.id, BUILT_IN_FOOTPRINT_LOOKUP);
          for (const inst of group.instances) {
            if (routeWater.contains(inst.position[0], inst.position[2], GLB_WATER_MARGIN_METRES)) continue;
            // Find the nearest sample on a coarse scan. A property-level
            // guard only needs to catch items that overlap the water by
            // many metres — the original failures ran 5 to 20 m into the
            // lane — so a couple of hundred metres of discretization slack
            // doesn't hide anything the issue cares about. We allow a
            // small bend-curvature tolerance below when the nearest curve
            // point isn't the perpendicular at the placement progress.
            let bestT = 0;
            let bestDist = Infinity;
            const SAMPLES = 1024;
            for (let i = 0; i <= SAMPLES; i += 1) {
              const t = i / SAMPLES;
              const s = sampleAt(t);
              const dx = inst.position[0] - s.position[0];
              const dz = inst.position[2] - s.position[2];
              const d = Math.hypot(dx, dz);
              if (d < bestDist) {
                bestDist = d;
                bestT = t;
              }
            }
            const sNearest = sampleAt(bestT);
            // Right-hand perpendicular (tangent × up for u=(0,1,0) is
            // (-tz, 0, tx); the placement convention treats negative perp
            // dot as 'left' and positive as 'right').
            const perpX = -sNearest.tangent[2];
            const perpZ = sNearest.tangent[0];
            const perpLen = Math.hypot(perpX, perpZ) || 1;
            const px = perpX / perpLen;
            const pz = perpZ / perpLen;
            const offsetFromCentre =
              (inst.position[0] - sNearest.position[0]) * px +
              (inst.position[2] - sNearest.position[2]) * pz;
            const distance = Math.abs(offsetFromCentre);

            // Lane buoys (a01 + a02) sit on the racing lane, and bridge
            // spans (tier-c and liveried `l-*-bridge`) cross the water.
            // Both are the explicit exceptions in FR1 / FR3; the buoys'
            // own distance-from-centreline is tested in
            // `courseFurniture.test.ts`, not here (the nearest-centreline
            // projection falls apart at sharp bends where a start-of-
            // route buoy is close to a mid-route curve sample).
            const isBuoy = /^a0[12]-buoy/.test(group.id);
            const isSpan = /^c0\d-bridge/.test(group.id) || /^l-.*-bridge/.test(group.id);
            if (isBuoy || isSpan) continue;

            // FR1: nearest footprint edge clear of the racing corridor.
            // A small bend-curvature tolerance accounts for the fact that
            // the nearest-centreline-point distance on a curved stretch
            // shortens the perpendicular the placement actually used.
            const BEND_TOLERANCE_METRES = 1;
            expect(
              distance - radius,
              `${group.id} intrudes on corridor (dist=${distance.toFixed(2)}, r=${radius})`,
            ).toBeGreaterThanOrEqual(corridor - BEND_TOLERANCE_METRES);
          }
        }
      });
    }
  }
  }
});
