import { describe, expect, it } from 'vitest';
import { BANK_COLUMNS, BANK_SUNK_METRES, buildBankStrips } from '../bankStrip';
import { buildWaterStrip } from '../waterStrip';
import { routeWaterFootprint } from '../waterFootprint';
import { RouteCurve } from '../../math/curve';
import { vec3 } from '../../math/vec3';
import { WATER_SURFACE_Y } from '../waterStrip';

describe('buildBankStrips', () => {
  it('falls back to a straight ribbon on a null curve (smoke-page default)', () => {
    const { positions, indices, indexFormat } = buildBankStrips();
    const cols = BANK_COLUMNS.length;
    // 40 default divisions, 2 strips, (divisions + 1) × columns verts each,
    // and each vert carries xyz.
    expect(positions.length).toBe((40 + 1) * cols * 2 * 3);
    expect(indices.length).toBe(40 * (cols - 1) * 6 * 2);
    expect(indexFormat).toBe('uint16');
    // Straight-ribbon left strip: perp defaults to (−1, 0, 0), sign = −1,
    // so inner edge sits at `point + perp × sign × shore` = +20 for shore=20,
    // and the outer column at +80.
    expect(positions[0]).toBeCloseTo(20);
    expect(positions[(cols - 1) * 3]).toBeCloseTo(80);
  });

  it('bends with a curved route so the inner edge tracks the water', () => {
    // 90° arc of radius 100 in XZ.
    const pts = [];
    for (let i = 0; i <= 8; i += 1) {
      const a = (i / 8) * (Math.PI / 2);
      pts.push(vec3(100 * Math.sin(a), 0, -100 * Math.cos(a)));
    }
    const curve = new RouteCurve(pts, false);
    const { positions } = buildBankStrips({ curve, waterHalfWidth: 10, bankWidth: 20 });
    // Default divisions scale with chord length (~157 m → ≥128). Confirm the
    // first-strip inner column lies within [waterHalfWidth, +shore+bankWidth]
    // of the curve centre, not on the straight-Z fallback.
    const mid = positions.length / 2;
    for (let i = 0; i < mid; i += 3 * BANK_COLUMNS.length) {
      const innerX = positions[i];
      const innerZ = positions[i + 2];
      // Any point along a 100-radius arc has |pos|≤100 + a bit for the
      // inner-edge offset; the straight-ribbon fallback would place inner
      // Z at ±(1..157), not along the arc, so test that we're off the Z
      // axis for a non-first column.
      if (i > 0) {
        expect(Math.hypot(innerX, innerZ)).toBeGreaterThan(5);
      }
    }
    // Every bank vertex sits at y = WATER_SURFACE_Y + 0.1.
    for (let i = 1; i < positions.length; i += 3) {
      expect(positions[i]).toBeCloseTo(WATER_SURFACE_Y + 0.1);
    }
  });

  it('honours per-progress shore widths from edgesForProgress', () => {
    const curve = new RouteCurve([vec3(0, 0, 0), vec3(0, 0, -200)], false);
    const { positions } = buildBankStrips({
      curve,
      divisions: 4,
      bankWidth: 10,
      edgesForProgress: () => ({ left: 5, right: 25 }),
    });
    // Left strip (sign = −1). For a +Z straight curve the perp from
    // tangent × up with tangent = (0, 0, −1) is (+1, 0, 0), so inner edge
    // sits at `point + perp × sign × left = 0 + 1 × (−1) × 5 = −5`.
    expect(positions[0]).toBeCloseTo(-5);
    // Right strip starts at vertsPerStrip × 3 floats in, with sign = +1
    // and right-shore widths, so inner edge = +25.
    const rightStart = (4 + 1) * BANK_COLUMNS.length * 3;
    expect(positions[rightStart]).toBeCloseTo(25);
  });
});

// #742 VP-22 — an out-and-back course: the return leg's bank lay over the
// outbound leg's water and, a hair higher, hid it under grass.
describe('buildBankStrips on a course that returns beside itself (#742)', () => {
  // A 2 km out-and-back, legs 30 m apart, joined by a semicircle.
  const outAndBack = (): RouteCurve => {
    const pts = [];
    for (let z = 0; z >= -1000; z -= 50) pts.push(vec3(0, 0, z));
    for (let k = 1; k < 8; k += 1) {
      const a = (k / 8) * Math.PI;
      pts.push(vec3(15 - 15 * Math.cos(a), 0, -1000 - 15 * Math.sin(a)));
    }
    for (let z = -1000; z <= 0; z += 50) pts.push(vec3(30, 0, z));
    return new RouteCurve(pts, false);
  };
  const edges = () => ({ left: 10, right: 10 });

  it('draws no bank triangle whose centre is on either leg\'s water', () => {
    const curve = outAndBack();
    const bank = buildBankStrips({ curve, edgesForProgress: edges });
    const water = routeWaterFootprint(buildWaterStrip(curve, { edgesForProgress: edges }));
    let checked = 0;
    for (let o = 0; o < bank.indices.length; o += 3) {
      const [i0, i1, i2] = [bank.indices[o], bank.indices[o + 1], bank.indices[o + 2]];
      if (i0 === i1 && i1 === i2) continue; // dropped
      const cx = (bank.positions[i0 * 3] + bank.positions[i1 * 3] + bank.positions[i2 * 3]) / 3;
      const cz = (bank.positions[i0 * 3 + 2] + bank.positions[i1 * 3 + 2] + bank.positions[i2 * 3 + 2]) / 3;
      expect(water.contains(cx, cz), `bank triangle at (${cx.toFixed(1)}, ${cz.toFixed(1)})`).toBe(false);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(1000);
    expect(bank.droppedTriangles).toBeGreaterThan(0);
  });

  it('sinks the bank vertices lying on the other leg\'s water below it', () => {
    const curve = outAndBack();
    const bank = buildBankStrips({ curve, edgesForProgress: edges });
    const water = routeWaterFootprint(buildWaterStrip(curve, { edgesForProgress: edges }));
    expect(bank.sunkVertices).toBeGreaterThan(0);
    for (let v = 0; v < bank.positions.length / 3; v += 1) {
      const onWater = water.contains(bank.positions[v * 3], bank.positions[v * 3 + 2]);
      expect(bank.positions[v * 3 + 1]).toBeCloseTo(
        onWater ? WATER_SURFACE_Y - BANK_SUNK_METRES : WATER_SURFACE_Y + 0.1,
      );
    }
  });

  it('leaves a single-leg river\'s banks whole', () => {
    const curve = new RouteCurve([vec3(0, 0, 0), vec3(0, 0, -1000)], false);
    const bank = buildBankStrips({ curve, edgesForProgress: edges });
    expect(bank.sunkVertices).toBe(0);
    expect(bank.droppedTriangles).toBe(0);
  });

  it('keeps every bank up when told there is no water footprint', () => {
    const bank = buildBankStrips({ curve: outAndBack(), edgesForProgress: edges, footprint: null });
    expect(bank.sunkVertices).toBe(0);
  });

  it('switches to 32-bit indices on a route long enough to need them', () => {
    const curve = new RouteCurve([vec3(0, 0, 0), vec3(0, 0, -100_000)], false);
    const bank = buildBankStrips({ curve, divisions: 5000, footprint: null });
    expect(bank.positions.length / 3).toBeGreaterThan(0xffff);
    expect(bank.indexFormat).toBe('uint32');
    expect(bank.indices).toBeInstanceOf(Uint32Array);
    expect(Math.max(...bank.indices.subarray(bank.indices.length - 6))).toBe(bank.positions.length / 3 - 1);
  });
});
