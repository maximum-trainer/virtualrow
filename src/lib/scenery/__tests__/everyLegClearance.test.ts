// #760 — scenery stays out of every leg's racing corridor.
import { describe, expect, it } from 'vitest';
import { centrelineIndex, clearOfEveryLeg, EVERY_LEG_BEND_TOLERANCE_METRES } from '../everyLegClearance';
import { keepClearHalfWidth } from '../laneClearance';
import { BUILT_IN_FOOTPRINT_LOOKUP, footprintRadiusFor } from '../sceneryFootprints';

// Out along x = 0, back along x = 40.
const outAndBack: [number, number, number][] = [
  [0, 0, 0], [0, 0, -500], [20, 0, -520], [40, 0, -500], [40, 0, 0],
];

describe('centrelineIndex', () => {
  const index = centrelineIndex(outAndBack);
  it('finds the nearest leg, whichever it is', () => {
    expect(index.distance(10, -250, 50)).toBeCloseTo(10, 9);
    expect(index.distance(35, -250, 50)).toBeCloseTo(5, 9);
    expect(index.distance(20, -540, 50)).toBeCloseTo(20, 9);
  });
  it('reports Infinity beyond the search radius', () => {
    expect(index.distance(200, -250, 50)).toBe(Infinity);
  });
  it('agrees with a brute-force search', () => {
    for (let k = 0; k < 200; k += 1) {
      const x = -60 + ((k * 37) % 160);
      const z = 40 - ((k * 53) % 620);
      let brute = Infinity;
      for (let i = 0; i + 1 < outAndBack.length; i += 1) {
        const [ax, , az] = outAndBack[i];
        const [bx, , bz] = outAndBack[i + 1];
        const dx = bx - ax;
        const dz = bz - az;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
        brute = Math.min(brute, Math.hypot(x - (ax + dx * t), z - (az + dz * t)));
      }
      const got = index.distance(x, z, 60);
      if (brute <= 60) expect(got).toBeCloseTo(brute, 9);
      else expect(got).toBe(Infinity);
    }
  });
});

describe('clearOfEveryLeg', () => {
  const index = centrelineIndex(outAndBack);
  const oak = 'e04-english-oak';
  const r = footprintRadiusFor(oak, BUILT_IN_FOOTPRINT_LOOKUP);
  const corridor = keepClearHalfWidth() - EVERY_LEG_BEND_TOLERANCE_METRES;

  it("drops a tree in the other leg's lane and keeps one clear of both", () => {
    const outside = -(corridor + r + 1);
    const kept = clearOfEveryLeg(
      [
        { id: oak, position: [outside, 0, -250] as [number, number, number] },
        // Clear of the outbound leg, but inside the return leg's corridor.
        { id: oak, position: [40 - (corridor + r) + 2, 0, -250] as [number, number, number] },
      ],
      index,
    );
    expect(kept.map((p) => p.position[0])).toEqual([outside]);
  });

  it('keeps buoys and bridges on the water', () => {
    const onLine = [
      { id: 'a01-buoy-lane-sphere', position: [0, 0, -100] as [number, number, number] },
      { id: 'c02-bridge-road-concrete', position: [20, 0, -100] as [number, number, number] },
    ];
    expect(clearOfEveryLeg(onLine, index)).toHaveLength(2);
  });
});
