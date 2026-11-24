// #745 VP-25 FR1 — banks follow the land.
import { describe, expect, it } from 'vitest';
import { BANK_RELIEF_RAMP_METRES, bankReliefAt, bankReliefRamp } from '../bankRelief';
import { BANK_COLUMNS, BANK_LIFT_METRES, buildBankStrips } from '../bankStrip';
import { buildWaterStrip, WATER_SURFACE_Y } from '../waterStrip';
import { RouteCurve } from '../../math/curve';
import { vec3 } from '../../math/vec3';
import {
  buildTerrainProfile,
  getTerrainReliefForProgress,
  MAX_TERRAIN_RELIEF_SCENE_UNITS,
  TERRAIN_RELIEF_SCALE,
} from '../../../services/routeEnrichmentService';

const curve = new RouteCurve(Array.from({ length: 21 }, (_, i) => vec3(0, 0, -i * 100)));

const yRange = (ys: number[]) => Math.max(...ys) - Math.min(...ys);

describe('bank relief (#745 FR1)', () => {
  it('climbs from the waterline over the embankment and holds the relief beyond it', () => {
    expect(bankReliefRamp(0)).toBe(0);
    expect(bankReliefRamp(BANK_RELIEF_RAMP_METRES / 2)).toBeCloseTo(0.5);
    expect(bankReliefRamp(BANK_RELIEF_RAMP_METRES)).toBe(1);
    expect(bankReliefRamp(60)).toBe(1);
    expect(bankReliefAt(2, -5)).toBe(0);
    expect(bankReliefAt(2, 30)).toBe(2);
  });

  it('Scenario: banks follow the land — a 12 m rise moves the bank by the clamped relief and not the water', () => {
    const terrain = buildTerrainProfile(Array.from({ length: 21 }, (_, i) => (12 * i) / 20));
    const relief = (t: number) => getTerrainReliefForProgress(terrain, t);
    const expected = Math.min(MAX_TERRAIN_RELIEF_SCENE_UNITS, 12 * TERRAIN_RELIEF_SCALE);
    const geom = buildBankStrips({ curve, footprint: null, reliefForProgress: relief });
    const cols = BANK_COLUMNS.length;
    const verts = geom.positions.length / 3;
    const ys = (col: number) => {
      const out: number[] = [];
      for (let v = 0; v < verts; v++) if (v % cols === col) out.push(geom.positions[v * 3 + 1]);
      return out;
    };
    // The waterline row stays on the water; the outer row climbs the whole rise.
    expect(yRange(ys(0))).toBeCloseTo(0, 6);
    expect(ys(0)[0]).toBeCloseTo(WATER_SURFACE_Y + BANK_LIFT_METRES, 6);
    expect(yRange(ys(cols - 1))).toBeCloseTo(expected, 3);
    const water = buildWaterStrip(curve, {});
    const wy: number[] = [];
    for (let v = 0; v < water.positions.length / 3; v++) wy.push(water.positions[v * 3 + 1]);
    expect(yRange(wy)).toBe(0);
  });

  it('stays flat with no elevations', () => {
    const geom = buildBankStrips({ curve, footprint: null });
    const ys: number[] = [];
    for (let v = 0; v < geom.positions.length / 3; v++) ys.push(geom.positions[v * 3 + 1]);
    expect(yRange(ys)).toBe(0);
  });

  it('is clamped: a 2 km climb tops out at the relief cap', () => {
    const terrain = buildTerrainProfile([0, 2000]);
    const geom = buildBankStrips({ curve, footprint: null, reliefForProgress: (t) => getTerrainReliefForProgress(terrain, t) });
    let top = -Infinity;
    for (let v = 0; v < geom.positions.length / 3; v++) top = Math.max(top, geom.positions[v * 3 + 1]);
    expect(top).toBeCloseTo(WATER_SURFACE_Y + BANK_LIFT_METRES + MAX_TERRAIN_RELIEF_SCENE_UNITS, 3);
  });
});
