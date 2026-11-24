import { describe, expect, it } from 'vitest';
import {
  LAND_COVER_MAX_TEXELS,
  LAND_COVER_TEXEL_M,
  LandCoverClass,
  buildLandCoverMask,
  classAt,
  classForKind,
  seawardOfCoast,
} from '../lib/scenery/landCoverMask';
import type { LandCoverFeature, ScenePoint } from '../lib/services/landscapeService';

const square = (cx: number, cz: number, half: number): ScenePoint[] => [
  [cx - half, cz - half],
  [cx + half, cz - half],
  [cx + half, cz + half],
  [cx - half, cz + half],
  [cx - half, cz - half],
];
const BOUNDS = { minX: -2000, minZ: -2000, maxX: 2000, maxZ: 2000 };

describe('classForKind (#764 FR1)', () => {
  it('maps every land-cover kind to its class, and coastline to none', () => {
    expect(classForKind('meadow')).toBe(LandCoverClass.pasture);
    expect(classForKind('farmland')).toBe(LandCoverClass.arable);
    expect(classForKind('vineyard')).toBe(LandCoverClass.arable);
    expect(classForKind('forest')).toBe(LandCoverClass.woodland);
    expect(classForKind('heath')).toBe(LandCoverClass.scrub);
    expect(classForKind('wetland')).toBe(LandCoverClass.wetland);
    expect(classForKind('bare_rock')).toBe(LandCoverClass.bare);
    expect(classForKind('beach')).toBe(LandCoverClass.sand);
    expect(classForKind('retail')).toBe(LandCoverClass.built);
    expect(classForKind('tree_row')).toBe(LandCoverClass.hedge);
    expect(classForKind('coastline')).toBeNull();
  });
});

describe('buildLandCoverMask (#764 FR1, FR3)', () => {
  it('puts a wood where the map says it is, and nowhere else (AC)', () => {
    const wood: LandCoverFeature = { kind: 'wood', shape: 'polygon', points: square(500, 0, 150) };
    const mask = buildLandCoverMask({ bounds: BOUNDS, features: [wood] });
    expect(mask.texelM).toBe(LAND_COVER_TEXEL_M);
    expect(mask.width).toBe(500);
    expect(classAt(mask, 500, 0)).toBe(LandCoverClass.woodland);
    expect(classAt(mask, 360, 140)).toBe(LandCoverClass.woodland);
    expect(classAt(mask, 340, 0)).toBe(LandCoverClass.unknown);
    expect(classAt(mask, 500, 170)).toBe(LandCoverClass.unknown);
    expect(classAt(mask, 0, 0)).toBe(LandCoverClass.unknown);
    expect(classAt(mask, 99999, 0)).toBe(LandCoverClass.unknown);
    expect(mask.classesPresent).toEqual([LandCoverClass.woodland]);
  });

  it('keeps water over built-up over woodland over fields, whatever the order', () => {
    const features: LandCoverFeature[] = [
      { kind: 'farmland', shape: 'polygon', points: square(0, 0, 400) },
      { kind: 'residential', shape: 'polygon', points: square(-200, 0, 100) },
      { kind: 'wood', shape: 'polygon', points: square(-200, 0, 150) },
      { kind: 'meadow', shape: 'polygon', points: square(-200, 0, 300) },
    ];
    const mask = buildLandCoverMask({ bounds: BOUNDS, features, water: [square(-200, 0, 30)] });
    expect(classAt(mask, -200, 0)).toBe(LandCoverClass.water);
    expect(classAt(mask, -200, 80)).toBe(LandCoverClass.built);
    expect(classAt(mask, -200, 130)).toBe(LandCoverClass.woodland);
    expect(classAt(mask, 300, 300)).toBe(LandCoverClass.arable);
    // A town is not farmland (AC).
    for (let x = -296; x <= -104; x += 8) expect(classAt(mask, x, 0)).not.toBe(LandCoverClass.arable);
  });

  it('draws hedges and tree rows as lines, counts their length, and skips other lines', () => {
    const features: LandCoverFeature[] = [
      { kind: 'farmland', shape: 'polygon', points: square(0, 0, 400) },
      { kind: 'hedge', shape: 'line', points: [[-300, 50], [300, 50]] },
      { kind: 'tree_row', shape: 'line', points: [[0, -300], [0, 0]] },
      { kind: 'coastline', shape: 'line', points: [[0, 500], [100, 500]] },
      { kind: 'wood', shape: 'line', points: [[0, 600], [100, 600]] },
      { kind: 'wood', shape: 'polygon', points: [[0, 0], [1, 1]] },
    ];
    const mask = buildLandCoverMask({ bounds: BOUNDS, features });
    expect(classAt(mask, 100, 50)).toBe(LandCoverClass.hedge);
    expect(classAt(mask, 0, -150)).toBe(LandCoverClass.hedge);
    expect(classAt(mask, 100, 80)).toBe(LandCoverClass.arable);
    expect(classAt(mask, 50, 500)).toBe(LandCoverClass.unknown);
    expect(mask.hedgeMetres).toBeCloseTo(900);
  });

  it('coarsens its texels for a large area rather than exceed 2048 on a side', () => {
    const mask = buildLandCoverMask({ bounds: { minX: 0, minZ: 0, maxX: 40_000, maxZ: 4_000 }, features: [] });
    expect(mask.width).toBe(LAND_COVER_MAX_TEXELS);
    expect(mask.texelM).toBeCloseTo(40_000 / LAND_COVER_MAX_TEXELS);
    expect(mask.data.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
  });
});

describe('real hedges replace invented ones (#764 FR3, AC)', () => {
  it('marks every texel within 500 m of a hedge, and none well beyond', async () => {
    const { realHedgeNear } = await import('../lib/scenery/landCoverMask');
    const mask = buildLandCoverMask({
      bounds: BOUNDS,
      features: [{ kind: 'hedge', shape: 'line', points: [[0, -100], [0, 100]] }],
    });
    for (const [x, z] of [[0, 0], [490, 0], [0, 590], [-350, 350]] as const) expect(realHedgeNear(mask, x, z)).toBe(true);
    expect(realHedgeNear(mask, 1200, 0)).toBe(false);
    expect(realHedgeNear(mask, 99999, 0)).toBe(false);
    // The bit leaves the class readable.
    expect(classAt(mask, 0, 0)).toBe(LandCoverClass.hedge);
    expect(classAt(mask, 300, 0)).toBe(LandCoverClass.unknown);
    const bare = buildLandCoverMask({ bounds: BOUNDS, features: [] });
    expect(realHedgeNear(bare, 0, 0)).toBe(false);
  });
});

describe('buildLandCoverMask — the coast (#764 FR6)', () => {
  // OSM coastline runs with the land on its left: walking north (scene -z)
  // along x = 300, the land is west and the sea east.
  const coast: LandCoverFeature = { kind: 'coastline', shape: 'line', points: [[300, 2000], [300, -2000]] };

  it('makes everything seaward of the coastline sea, out to the edge of the mask', () => {
    const mask = buildLandCoverMask({ bounds: BOUNDS, features: [coast] });
    expect(classAt(mask, 600, 0)).toBe(LandCoverClass.sea);
    expect(classAt(mask, 1990, -1990)).toBe(LandCoverClass.sea);
    expect(classAt(mask, 1990, 1990)).toBe(LandCoverClass.sea);
    expect(classAt(mask, 0, 0)).toBe(LandCoverClass.unknown);
    expect(classAt(mask, -1990, 1990)).toBe(LandCoverClass.unknown);
    expect(mask.classesPresent).toContain(LandCoverClass.sea);
  });

  it('follows the coastline to the texel', () => {
    const mask = buildLandCoverMask({ bounds: BOUNDS, features: [coast] });
    for (let z = -1996; z < 2000; z += 40) {
      expect(classAt(mask, 305, z)).toBe(LandCoverClass.sea);
      expect(classAt(mask, 295, z)).toBe(LandCoverClass.unknown);
    }
  });

  it('puts the sea over anything the land cover drew past the coast', () => {
    const wood: LandCoverFeature = { kind: 'wood', shape: 'polygon', points: square(300, 0, 100) };
    const mask = buildLandCoverMask({ bounds: BOUNDS, features: [wood, coast], water: [square(350, 0, 20)] });
    expect(classAt(mask, 250, 0)).toBe(LandCoverClass.woodland);
    expect(classAt(mask, 380, 50)).toBe(LandCoverClass.sea);
    expect(classAt(mask, 350, 0)).toBe(LandCoverClass.sea);
  });

  it('keeps a headland land on both sides of its corner', () => {
    // East along z = 0 then north along x = 0: land to the north-west (x < 0, z < 0).
    const headland: LandCoverFeature = { kind: 'coastline', shape: 'line', points: [[-2000, 0], [0, 0], [0, -2000]] };
    const mask = buildLandCoverMask({ bounds: BOUNDS, features: [headland] });
    expect(classAt(mask, -500, -500)).toBe(LandCoverClass.unknown);
    expect(classAt(mask, -20, -20)).toBe(LandCoverClass.unknown);
    expect(classAt(mask, 500, 500)).toBe(LandCoverClass.sea);
    expect(classAt(mask, 20, 20)).toBe(LandCoverClass.sea);
    expect(classAt(mask, 500, -500)).toBe(LandCoverClass.sea);
    expect(classAt(mask, -500, 500)).toBe(LandCoverClass.sea);
  });

  it('takes the whole mask as one side when the coastline lies outside it', () => {
    const west: LandCoverFeature = { kind: 'coastline', shape: 'line', points: [[-3000, 2000], [-3000, -2000]] };
    const east: LandCoverFeature = { kind: 'coastline', shape: 'line', points: [[3000, 2000], [3000, -2000]] };
    expect(classAt(buildLandCoverMask({ bounds: BOUNDS, features: [west] }), 0, 0)).toBe(LandCoverClass.sea);
    const inland = buildLandCoverMask({ bounds: BOUNDS, features: [east] });
    expect(classAt(inland, 0, 0)).toBe(LandCoverClass.unknown);
    expect(inland.classesPresent).not.toContain(LandCoverClass.sea);
  });

  it('answers which side of the coast a point is on, and false with no coastline', () => {
    expect(seawardOfCoast([coast], 600, 0)).toBe(true);
    expect(seawardOfCoast([coast], 0, 0)).toBe(false);
    expect(seawardOfCoast([], 600, 0)).toBe(false);
  });

  it('paints a long wiggly coast over the largest mask in good time', () => {
    const points: ScenePoint[] = [];
    for (let k = 0; k <= 2000; k += 1) points.push([Math.sin(k / 7) * 60, 8000 - k * 8]);
    const big = { minX: -8000, minZ: -8000, maxX: 8000, maxZ: 8000 };
    const start = performance.now();
    const mask = buildLandCoverMask({ bounds: big, features: [{ kind: 'coastline', shape: 'line', points }] });
    expect(performance.now() - start).toBeLessThan(4000);
    expect(classAt(mask, 4000, 0)).toBe(LandCoverClass.sea);
    expect(classAt(mask, -4000, 0)).toBe(LandCoverClass.unknown);
  });
});
