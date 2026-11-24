/**
 * #752 FR1 — where a gates-only course line crosses land.
 *
 * A rownative course whose waterway lookup declined is rowed as straight
 * lines between its gates, and a straight line can cut across a peninsula or
 * an island. Each leg is sampled against the water fetched for the course
 * (the shared answer from #752 FR3): inside a mapped water area, or within
 * half a river's width of a waterway mapped only as a line, is water.
 * Anything else, summed along the leg, is land.
 */
import type { Coordinate, LandCrossing } from '../types/index';
import { insideRing, localFrame, parseWaterAreas, type Vec } from './waterAreaCentreline';

/** A leg with more land under it than this is flagged (FR1). */
export const LAND_CROSSING_MIN_M = 20;
/** Sample spacing along a leg. */
const SAMPLE_M = 5;

/** Half widths for a waterway mapped only as a line, by class, in metres. */
const HALF_WIDTH_M: Record<string, number> = { river: 30, canal: 10, stream: 5, tidal_channel: 30, fairway: 50 };

interface Element {
  type?: string;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

const isWaterArea = (e: Element): boolean => e?.tags?.natural === 'water' || e?.tags?.waterway === 'riverbank';

/** A gate the leg runs from or to. */
export interface CrossingGate {
  name: string;
  center: Coordinate;
}

const distanceToSegment = (p: Vec, a: Vec, b: Vec): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t = length2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
};

const halfWidth = (tags: Record<string, string> = {}): number => {
  const width = Number.parseFloat(tags.width ?? '');
  return Number.isFinite(width) && width > 0 ? width / 2 : HALF_WIDTH_M[tags.waterway ?? ''] ?? 0;
};

/**
 * The legs between consecutive gates with more than {@link LAND_CROSSING_MIN_M}
 * of land under them. Null when `elements` hold no water at all, so a course
 * with no water data is never accused of crossing land.
 */
export function findLandCrossings(gates: readonly CrossingGate[], elements: readonly unknown[]): LandCrossing[] | null {
  const water = (elements as Element[]).filter(
    (e) => isWaterArea(e) || (e?.type !== 'relation' && halfWidth(e?.tags) > 0),
  );
  if (water.length === 0 || gates.length < 2) return null;

  const { toLocal } = localFrame(gates[0].center);
  const rings = parseWaterAreas(water.filter(isWaterArea)).map((ring) => ring.map(toLocal));
  const lines = water
    .filter((e) => !isWaterArea(e))
    .map((e) => ({
      half: halfWidth(e.tags),
      points: (e.geometry ?? []).map((g) => toLocal({ lat: g.lat, lng: g.lon })),
    }));
  const onWater = (p: Vec): boolean =>
    rings.some((ring) => insideRing(p, ring))
    || lines.some(({ half, points }) => points.some((q, i) => i > 0 && distanceToSegment(p, points[i - 1], q) <= half));

  const crossings: LandCrossing[] = [];
  for (let i = 0; i < gates.length - 1; i++) {
    const a = toLocal(gates[i].center);
    const b = toLocal(gates[i + 1].center);
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.round(length / SAMPLE_M));
    let dry = 0;
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      if (!onWater({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) dry += 1;
    }
    const metres = (dry / steps) * length;
    if (metres > LAND_CROSSING_MIN_M) {
      crossings.push({
        fromGate: gates[i].name,
        toGate: gates[i + 1].name,
        metres: Math.round(metres),
        from: gates[i].center,
        to: gates[i + 1].center,
      });
    }
  }
  return crossings;
}

/** FR2: the route card's line for one crossing. */
export const landCrossingNote = (crossing: LandCrossing): string =>
  `Crosses land between ${crossing.fromGate} and ${crossing.toGate} (${Math.round(crossing.metres / 10) * 10} m)`;
