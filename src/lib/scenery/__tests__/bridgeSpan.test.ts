// #724 VP-06 — bridges span the river. Every bridge model with a span
// profile, placed as a span on a test curve, has its long axis across the
// water, a navigable opening on the racing line and enough headroom; one
// that cannot is swapped for a model that can, or is not placed.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RouteCurve } from '../../renderer/math/curve';
import { vec3 } from '../../renderer/math/vec3';
import {
  BOAT_OAR_HALF_SPAN_METRES,
  MIN_OPENING_WIDTH_METRES,
  MIN_UNDERSIDE_METRES,
  SPAN_SCALE_MAX,
  SPAN_SCALE_MIN,
  fitBridgeSpan,
  placeSpan,
  spanAxisWorld,
  spanCeilingAt,
  type BridgeSpanProfile,
} from '../bridgeSpan';
import { BRIDGE_SPANS } from '../bridgeSpans.generated';
import { placeFurniture } from '../courseFurniture';
import { computeStructurePlacements } from '../sceneryStructures';
import { ASSET_SCALE } from '../sceneryPlacement';

const straight = new RouteCurve([vec3(0, 0, 0), vec3(0, 0, -500), vec3(0, 0, -1000)]);
const bend = new RouteCurve([
  vec3(0, 0, 0),
  vec3(150, 0, -300),
  vec3(450, 0, -450),
  vec3(800, 0, -420),
]);

const degreesOffPerpendicular = (axis: [number, number], tangent: [number, number]): number => {
  const dot = Math.abs(axis[0] * tangent[0] + axis[1] * tangent[1]);
  return (Math.asin(Math.min(1, dot)) * 180) / Math.PI;
};

describe('#724 FR1 — every bridge model carries a span profile', () => {
  it('lists the tier-c, tier-g and tier-l bridges', () => {
    const ids = Object.keys(BRIDGE_SPANS);
    for (const id of [
      'c01-bridge-arch-masonry', 'c02-bridge-road-concrete', 'c03-bridge-truss-steel',
      'c04-bridge-rail-girder', 'c05-bridge-bascule', 'c06-bridge-foot-suspension',
      'c07-bridge-dutch-lift', 'c08-bridge-cantilever', 'g02-bridge-double-decker',
      'g03-bridge-pipeline', 'g04-bridge-tram', 'g05-footbridge-timber',
      'l-barnes-railway-bridge', 'l-fremont-bridge', 'l-ponte-isabella',
    ]) expect(ids).toContain(id);
  });

  it('matches the manifest the generator wrote', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../public/assets/scenery/manifest.json'), 'utf8'),
    ) as { models: Record<string, { span?: BridgeSpanProfile }> };
    const fromManifest = Object.fromEntries(
      Object.entries(manifest.models).filter(([, m]) => m.span).map(([id, m]) => [id, m.span]),
    );
    expect(fromManifest).toEqual(BRIDGE_SPANS);
  });

  it('records the c01 arch: long in X, three arches, the middle one 13 m wide and 5.15 m high', () => {
    const c01 = BRIDGE_SPANS['c01-bridge-arch-masonry'];
    expect(c01.axis).toBe('x');
    expect(c01.length).toBeCloseTo(60, 1);
    expect(c01.openings).toHaveLength(3);
    expect(c01.openings[1]).toEqual({ centre: 0, width: 13, underside: 5.15 });
  });
});

describe('#724 FR3 — fitBridgeSpan', () => {
  const arch: BridgeSpanProfile = {
    axis: 'x', start: -30, length: 60,
    openings: [{ centre: 0, width: 13, underside: 5.15 }],
  };

  it('scales up just enough for a 15 m opening', () => {
    const fit = fitBridgeSpan(arch, 10, 10);
    expect(fit?.scale).toBeCloseTo(15 / 13, 4);
    expect(fit?.opening.centre).toBe(0);
  });

  it('keeps the authored size when nothing needs it bigger', () => {
    const fit = fitBridgeSpan({ ...arch, openings: [{ centre: 0, width: 30, underside: 8 }] }, 10, 10);
    expect(fit?.scale).toBe(1);
  });

  it('scales up so the abutments reach both banks', () => {
    const fit = fitBridgeSpan({ ...arch, openings: [{ centre: 0, width: 30, underside: 8 }] }, 38, 20);
    // The shorter arm is 30 m; the wider bank needs 38 + 2 m.
    expect(fit?.scale).toBeCloseTo(40 / 30, 4);
  });

  it('declines a river the span cannot reach even at the largest scale', () => {
    expect(fitBridgeSpan(arch, 60, 60)).toBeNull();
  });

  it('declines an opening too low or too narrow even at the largest scale', () => {
    expect(fitBridgeSpan({ ...arch, openings: [{ centre: 0, width: 30, underside: 2.5 }] }, 10, 10)).toBeNull();
    expect(fitBridgeSpan({ ...arch, openings: [{ centre: 0, width: 9, underside: 8 }] }, 10, 10)).toBeNull();
    expect(fitBridgeSpan({ ...arch, openings: [] }, 10, 10)).toBeNull();
  });

  it('picks the opening that needs the least scaling', () => {
    const fit = fitBridgeSpan({
      ...arch,
      openings: [
        { centre: -20, width: 13, underside: 4 },
        { centre: 0, width: 13, underside: 5.15 },
        { centre: 20, width: 16, underside: 6 },
      ],
    }, 6, 6);
    expect(fit?.opening.centre).toBe(20);
    expect(fit?.scale).toBe(1);
  });
});

describe('#724 FR2-FR5 — placeSpan, every bridge model, straight and curved', () => {
  for (const id of Object.keys(BRIDGE_SPANS)) {
    for (const [name, curve] of [['straight', straight], ['bend', bend]] as const) {
      for (const progress of [0.2, 0.5, 0.8]) {
        it(`${id} on the ${name} curve at ${progress}`, () => {
          const at = curve.sample(progress);
          const placed = placeSpan({
            id,
            centre: [at.position[0], at.position[2]],
            tangent: [at.tangent[0], at.tangent[2]],
            leftHalfWidth: 10,
            rightHalfWidth: 10,
          });
          if (!placed) {
            // Only when no model, swapped or not, can satisfy the rules.
            throw new Error(`${id} was not placed on a 20 m river`);
          }
          const profile = BRIDGE_SPANS[placed.id];
          const tLen = Math.hypot(at.tangent[0], at.tangent[2]);
          const tangent: [number, number] = [at.tangent[0] / tLen, at.tangent[2] / tLen];
          // FR2: the long axis is within 2° of the perpendicular.
          expect(degreesOffPerpendicular(spanAxisWorld(placed), tangent)).toBeLessThan(2);
          // FR3: scale clamped; the racing line passes through the opening
          // with ≥ 3 m clear each side of the oars and ≥ 15 m in all.
          expect(placed.scale).toBeGreaterThanOrEqual(SPAN_SCALE_MIN);
          expect(placed.scale).toBeLessThanOrEqual(SPAN_SCALE_MAX);
          const axis = spanAxisWorld(placed);
          const along = ((at.position[0] - placed.position[0]) * axis[0]
            + (at.position[2] - placed.position[2]) * axis[1]) / placed.scale;
          const opening = profile.openings.find(
            (o) => Math.abs(along - o.centre) <= o.width / 2,
          );
          expect(opening, 'racing line inside an opening').toBeDefined();
          expect(opening!.width * placed.scale).toBeGreaterThanOrEqual(MIN_OPENING_WIDTH_METRES - 1e-9);
          const clearEachSide = (opening!.width / 2 - Math.abs(along - opening!.centre)) * placed.scale
            - BOAT_OAR_HALF_SPAN_METRES;
          expect(clearEachSide).toBeGreaterThanOrEqual(3);
          // FR4: headroom at the racing line.
          expect(opening!.underside * placed.scale).toBeGreaterThanOrEqual(MIN_UNDERSIDE_METRES - 1e-9);
          expect(placed.ceiling).toBeCloseTo(opening!.underside * placed.scale, 6);
          // Both abutments past the banks.
          expect((profile.start + profile.length - along) * placed.scale).toBeGreaterThan(10);
          expect((along - profile.start) * placed.scale).toBeGreaterThan(10);
        });
      }
    }
  }

  it('keeps the c01 arch as authored on a 20 m river', () => {
    const placed = placeSpan({
      id: 'c01-bridge-arch-masonry', centre: [0, 0], tangent: [0, -1],
      leftHalfWidth: 10, rightHalfWidth: 10,
    });
    expect(placed?.id).toBe('c01-bridge-arch-masonry');
  });

  it('swaps the low truss for a model the boat can pass under', () => {
    const placed = placeSpan({
      id: 'c03-bridge-truss-steel', centre: [0, 0], tangent: [0, -1],
      leftHalfWidth: 10, rightHalfWidth: 10,
    });
    expect(placed).not.toBeNull();
    expect(placed!.id).not.toBe('c03-bridge-truss-steel');
  });

  it('places nothing when no model reaches across the river', () => {
    expect(placeSpan({
      id: 'c01-bridge-arch-masonry', centre: [0, 0], tangent: [0, -1],
      leftHalfWidth: 400, rightHalfWidth: 400,
    })).toBeNull();
  });

  it('places nothing for a model without a span profile', () => {
    expect(placeSpan({
      id: 'a06-finish-tower', centre: [0, 0], tangent: [0, -1],
      leftHalfWidth: 10, rightHalfWidth: 10, fallbacks: [],
    })).toBeNull();
  });
});

describe('#724 FR2 — placeFurniture lays the Willowbrook arch across the river', () => {
  it('turns c01 perpendicular to the tangent, not along it', () => {
    const placements = placeFurniture({
      curve: straight,
      routeMeters: 1000,
      extras: [{ id: 'c01-bridge-arch-masonry', progress: 0.5, side: 'left', kind: 'span' }],
    });
    const bridge = placements.find((p) => p.kind === 'span');
    expect(bridge).toBeDefined();
    const axis = spanAxisWorld({
      id: bridge!.id, rotationY: bridge!.rotationY,
    });
    expect(degreesOffPerpendicular(axis, [0, -1])).toBeLessThan(2);
    expect(bridge!.scale).toBeGreaterThan(1);
    expect(bridge!.ceiling).toBeGreaterThanOrEqual(MIN_UNDERSIDE_METRES);
  });

  it('drops a span no model can fit', () => {
    const placements = placeFurniture({
      curve: straight,
      routeMeters: 1000,
      shoreHalfWidth: () => 400,
      extras: [{ id: 'c01-bridge-arch-masonry', progress: 0.5, side: 'left', kind: 'span' }],
    });
    expect(placements.filter((p) => p.kind === 'span')).toHaveLength(0);
  });
});

describe('#724 FR4 — spanCeilingAt', () => {
  const placed = placeSpan({
    id: 'c01-bridge-arch-masonry', centre: [0, -500], tangent: [0, -1],
    leftHalfWidth: 10, rightHalfWidth: 10,
  })!;

  it('is the deck underside over the racing line', () => {
    expect(spanCeilingAt([placed], 0, -500)).toBeCloseTo(placed.ceiling, 6);
  });

  it('reaches a little past the deck so the camera ducks before it arrives', () => {
    const depth = 12; // the arch is under 10 m deep, plus the 2 m look-ahead
    expect(spanCeilingAt([placed], 0, -500 + depth / 2 + 0.5)).toBeCloseTo(placed.ceiling, 6);
  });

  it('is open sky away from any span', () => {
    expect(spanCeilingAt([placed], 0, -450)).toBe(Number.POSITIVE_INFINITY);
    expect(spanCeilingAt([], 0, -500)).toBe(Number.POSITIVE_INFINITY);
  });

  it('takes the lower of two overlapping spans', () => {
    const low = { ...placed, ceiling: placed.ceiling - 1 };
    expect(spanCeilingAt([placed, low], 0, -500)).toBeCloseTo(placed.ceiling - 1, 6);
  });
});

describe('#724 FR5 — OSM crossings and landmark bridges take the same path', () => {
  it('fits every crossing and landmark bridge across the river', () => {
    const placements = computeStructurePlacements(straight, [
      { id: 'c01-bridge-arch-masonry', progress: 0.3, kind: 'bridge' },
      { id: 'c03-bridge-truss-steel', progress: 0.5, kind: 'bridge' },
      { id: 'l-fremont-bridge', progress: 0.7, kind: 'bridge' },
    ]);
    expect(placements).toHaveLength(3);
    // The truss is too low to row under, so a fallback stands in.
    expect(placements[1].id).not.toBe('c03-bridge-truss-steel');
    for (const p of placements) {
      expect(degreesOffPerpendicular(spanAxisWorld(p), [0, -1])).toBeLessThan(2);
      expect(p.scale / ASSET_SCALE).toBeGreaterThanOrEqual(SPAN_SCALE_MIN);
      expect(p.scale / ASSET_SCALE).toBeLessThanOrEqual(SPAN_SCALE_MAX);
      expect(p.footing).toBe('water');
    }
  });

  it('leaves out a crossing no model can span', () => {
    const wide = { waterWidthMeters: 800 };
    const placements = computeStructurePlacements(
      straight,
      [{ id: 'c01-bridge-arch-masonry', progress: 0.5, kind: 'bridge' }],
      null,
      wide as never,
    );
    expect(placements).toHaveLength(0);
  });
});

describe('#724 FR4 — spanCeilingAt without a fitted ceiling', () => {
  it('reads the underside of the opening over the point', () => {
    const placed = placeSpan({
      id: 'c01-bridge-arch-masonry', centre: [0, -500], tangent: [0, -1],
      leftHalfWidth: 10, rightHalfWidth: 10,
    })!;
    const { ceiling, ...rest } = placed;
    expect(spanCeilingAt([rest], 0, -500)).toBeCloseTo(ceiling, 6);
  });
});
