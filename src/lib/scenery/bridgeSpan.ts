/**
 * #724 VP-06 — fit a bridge across the river.
 *
 * `scripts/generate-scenery-manifest.mjs` measures every bridge GLB (FR1):
 * its long axis, where that axis starts, its length, and its navigable
 * openings (centre, width and lowest underside, in scene metres at the
 * authored size). Placing a span then means (FR2-FR4):
 *
 * - turning the long axis perpendicular to the route tangent;
 * - scaling it uniformly within [0.75, 1.6] so one opening is at least
 *   15 m wide with 4.5 m of headroom, and both arms reach past the banks;
 * - sliding it along its axis so that opening is centred on the racing line.
 *
 * A model that cannot do that is swapped for one that can (FR3); if none
 * can, the span is not placed. `spanCeilingAt` then gives the deck
 * underside over a point, so the camera can stay under it (FR4).
 */

import { BRIDGE_SPANS } from './bridgeSpans.generated';
import { SCENERY_FOOTPRINTS } from './sceneryFootprints.generated';

export interface BridgeOpening {
  /** Centre along the long axis, model space (scene metres). */
  centre: number;
  width: number;
  /** Lowest point of the deck over the opening, above the model origin. */
  underside: number;
}

export interface BridgeSpanProfile {
  axis: 'x' | 'z';
  /** Where the long axis starts (its minimum), model space. */
  start: number;
  length: number;
  openings: readonly BridgeOpening[];
}

export const SPAN_SCALE_MIN = 0.75;
export const SPAN_SCALE_MAX = 1.6;
export const MIN_OPENING_WIDTH_METRES = 15;
export const MIN_UNDERSIDE_METRES = 4.5;
/** How far each abutment reaches past the waterline. */
export const ABUTMENT_OVERLAP_METRES = 2;
/** Half the width of a single scull across its oars. */
export const BOAT_OAR_HALF_SPAN_METRES = 3.2;
/** How far outside a span's footprint the camera already ducks under it. */
export const SPAN_CEILING_LOOKAHEAD_METRES = 2;

/**
 * Models tried, in order, when the requested one cannot span the river:
 * the plain road bridge, then the long cantilever.
 */
export const SPAN_FALLBACK_MODELS: readonly string[] = [
  'c02-bridge-road-concrete',
  'c08-bridge-cantilever',
];

export interface SpanFit {
  scale: number;
  opening: BridgeOpening;
}

/**
 * The opening and uniform scale that fit `profile` to a river whose
 * waterline lies `leftHalfWidth` / `rightHalfWidth` either side of the
 * racing line, or null when none does. Both arms are sized for the wider
 * bank, so the result does not depend on which side is which. Of the
 * openings that fit, the one needing the least change of size wins.
 */
export const fitBridgeSpan = (
  profile: BridgeSpanProfile,
  leftHalfWidth: number,
  rightHalfWidth: number,
): SpanFit | null => {
  const bank = Math.max(leftHalfWidth, rightHalfWidth, 0) + ABUTMENT_OVERLAP_METRES;
  const end = profile.start + profile.length;
  let best: SpanFit | null = null;
  for (const opening of profile.openings) {
    const arm = Math.min(end - opening.centre, opening.centre - profile.start);
    if (arm <= 0 || opening.width <= 0 || opening.underside <= 0) continue;
    const needed = Math.max(
      SPAN_SCALE_MIN,
      MIN_UNDERSIDE_METRES / opening.underside,
      MIN_OPENING_WIDTH_METRES / opening.width,
      bank / arm,
    );
    if (needed > SPAN_SCALE_MAX) continue;
    const scale = Math.max(needed, 1);
    if (
      !best
      || scale < best.scale
      || (scale === best.scale && Math.abs(opening.centre) < Math.abs(best.opening.centre))
    ) {
      best = { scale, opening };
    }
  }
  return best;
};

export interface SpanPlacementInput {
  id: string;
  /** World XZ of the racing line where the span crosses. */
  centre: readonly [number, number];
  /** World XZ route tangent there (need not be unit length). */
  tangent: readonly [number, number];
  leftHalfWidth: number;
  rightHalfWidth: number;
  spans?: Readonly<Record<string, BridgeSpanProfile>>;
  fallbacks?: readonly string[];
}

export interface SpanPlacement {
  /** The model placed: the one asked for, or a fallback. */
  id: string;
  position: [number, number, number];
  rotationY: number;
  /** Uniform scale on top of the authored size. */
  scale: number;
  /** World height of the deck underside over the racing line. */
  ceiling: number;
}

/** The world XZ direction of a placed span's long axis. */
export const spanAxisWorld = (
  { id, rotationY }: { id: string; rotationY: number },
  spans: Readonly<Record<string, BridgeSpanProfile>> = BRIDGE_SPANS,
): [number, number] => {
  // rotY maps model +X to (cos, -sin) and model +Z to (sin, cos).
  return spans[id]?.axis === 'z'
    ? [Math.sin(rotationY), Math.cos(rotationY)]
    : [Math.cos(rotationY), -Math.sin(rotationY)];
};

export const placeSpan = ({
  id,
  centre,
  tangent,
  leftHalfWidth,
  rightHalfWidth,
  spans = BRIDGE_SPANS,
  fallbacks = SPAN_FALLBACK_MODELS,
}: SpanPlacementInput): SpanPlacement | null => {
  const heading = Math.atan2(tangent[0], tangent[1]);
  for (const candidate of [id, ...fallbacks.filter((f) => f !== id)]) {
    const profile = spans[candidate];
    if (!profile) continue;
    const fit = fitBridgeSpan(profile, leftHalfWidth, rightHalfWidth);
    if (!fit) continue;
    // rotY(heading) already turns model X across the river; a Z-long
    // model needs the extra quarter turn.
    const rotationY = profile.axis === 'x' ? heading : heading + Math.PI / 2;
    const axis = spanAxisWorld({ id: candidate, rotationY }, spans);
    const shift = fit.scale * fit.opening.centre;
    return {
      id: candidate,
      position: [centre[0] - axis[0] * shift, 0, centre[1] - axis[1] * shift],
      rotationY,
      scale: fit.scale,
      ceiling: fit.scale * fit.opening.underside,
    };
  }
  return null;
};

const undersideAt = (profile: BridgeSpanProfile, along: number): number => {
  const over = profile.openings.find((o) => Math.abs(along - o.centre) <= o.width / 2);
  if (over) return over.underside;
  return profile.openings.reduce((low, o) => Math.min(low, o.underside), Number.POSITIVE_INFINITY);
};

export interface SpanCeilingSource {
  id: string;
  position: readonly [number, number, number];
  rotationY: number;
  /** Uniform scale on top of the authored size (no `ASSET_SCALE`). */
  scale: number;
  /** The fitted underside; when absent, read from the opening over the point. */
  ceiling?: number;
}

/**
 * The lowest deck underside over world point (x, z), or +Infinity when no
 * span covers it. A span covers its footprint grown by
 * `SPAN_CEILING_LOOKAHEAD_METRES`, so a camera closing on it ducks first.
 * A span without a fitted `ceiling` gives the underside of the opening
 * over the point, or of its lowest opening when the point is over a pier.
 */
export const spanCeilingAt = (
  spans: Iterable<SpanCeilingSource>,
  x: number,
  z: number,
  lookahead = SPAN_CEILING_LOOKAHEAD_METRES,
  profiles: Readonly<Record<string, BridgeSpanProfile>> = BRIDGE_SPANS,
): number => {
  let ceiling = Number.POSITIVE_INFINITY;
  for (const span of spans) {
    const profile = profiles[span.id];
    const footprint = SCENERY_FOOTPRINTS[span.id];
    if (!profile || !footprint || !(span.scale > 0)) continue;
    const dx = x - span.position[0];
    const dz = z - span.position[2];
    const c = Math.cos(span.rotationY);
    const s = Math.sin(span.rotationY);
    // Inverse of rotY: world → model, then undo the scale.
    const lx = (c * dx - s * dz) / span.scale;
    const lz = (s * dx + c * dz) / span.scale;
    const pad = lookahead / span.scale;
    const inX = lx >= footprint.minX - pad && lx <= footprint.maxX + pad;
    const inZ = lz >= footprint.minZ - pad && lz <= footprint.maxZ + pad;
    if (!inX || !inZ) continue;
    const here = span.ceiling ?? undersideAt(profile, profile.axis === 'x' ? lx : lz) * span.scale;
    if (here < ceiling) ceiling = here;
  }
  return ceiling;
};
