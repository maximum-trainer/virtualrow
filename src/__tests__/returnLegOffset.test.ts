import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../lib/types/index';
import { localFrame } from '../lib/services/waterAreaCentreline';
import {
  MAX_RETURN_OFFSET_M,
  gateSide,
  offsetLeg,
  retracesLeg,
  returnLegOffsetMeters,
} from '../lib/services/returnLegOffset';
import { projectPointOntoPolyline } from '../lib/utils/polylineGeometry';

const { toCoordinate, toLocal } = localFrame({ lat: 52.2, lng: 0.12 });
const at = (x: number, y: number): Coordinate => toCoordinate({ x, y });
/** North 1 km. */
const outbound = [at(0, 0), at(0, 500), at(0, 1000)];
const back = [...outbound].reverse();

describe('returnLegOffsetMeters', () => {
  it('is 0.3 of the width, capped at 15 m', () => {
    expect(returnLegOffsetMeters(30)).toBeCloseTo(9);
    expect(returnLegOffsetMeters(200)).toBe(MAX_RETURN_OFFSET_M);
    expect(returnLegOffsetMeters(-5)).toBe(0);
  });
});

describe('retracesLeg', () => {
  it('spots a return leg along the same water', () => {
    expect(retracesLeg(outbound, back)).toBe(true);
  });

  it('does not count a leg that goes somewhere else', () => {
    expect(retracesLeg(outbound, [at(0, 1000), at(800, 1000)])).toBe(false);
  });

  it('needs two points on each side', () => {
    expect(retracesLeg([at(0, 0)], back)).toBe(false);
  });
});

describe('gateSide', () => {
  it('keeps right when the gates sit on the line', () => {
    expect(gateSide(back, [at(0, 1000), at(0, 0)])).toBe(1);
  });

  it('follows gates set to one side', () => {
    // Travelling south, x < 0 (west) is the right-hand side, x > 0 the left.
    expect(gateSide(back, [at(-12, 0)])).toBe(1);
    expect(gateSide(back, [at(12, 0)])).toBe(-1);
  });
});

describe('offsetLeg', () => {
  it('shifts the middle of the leg by the full distance and eases to the ends', () => {
    const shifted = offsetLeg(back, 12, 1);
    const pts = shifted.map(toLocal);
    // Ends stay where they were.
    expect(pts[0].x).toBeCloseTo(0, 3);
    expect(pts[pts.length - 1].x).toBeCloseTo(0, 3);
    // The middle is 12 m to the right of a southbound leg: west.
    const middle = pts.filter((p) => p.y > 100 && p.y < 900);
    expect(middle.length).toBeGreaterThan(0);
    for (const p of middle) expect(p.x).toBeCloseTo(-12, 1);
  });

  it('keeps the outbound and return legs apart except near the stake (#751 acceptance)', () => {
    const shifted = offsetLeg(back, 12, 1);
    const pts = shifted.map(toLocal);
    for (const p of pts.filter((q) => q.y < 900 && q.y > 100)) {
      expect(projectPointOntoPolyline(toCoordinate(p), outbound).offsetMeters).toBeGreaterThanOrEqual(8);
    }
  });

  it('starts at the full offset when the leg leaves a stake (#751 FR4)', () => {
    const pts = offsetLeg(back, 12, 1, { easeStart: false }).map(toLocal);
    expect(pts[0].x).toBeCloseTo(-12, 1);
    expect(pts[0].y).toBeCloseTo(1000, 1);
    expect(pts[pts.length - 1].x).toBeCloseTo(0, 3);
  });

  it('can hold the offset to the end too', () => {
    const pts = offsetLeg(back, 12, 1, { easeStart: false, easeEnd: false }).map(toLocal);
    expect(pts).toHaveLength(back.length);
    for (const p of pts) expect(p.x).toBeCloseTo(-12, 1);
  });

  it('leaves a leg alone when there is nothing to shift', () => {
    expect(offsetLeg(back, 0, 1)).toBe(back);
    expect(offsetLeg([at(0, 0)], 10, 1)).toHaveLength(1);
  });
});
