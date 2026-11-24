/**
 * Where a rownative course's geometry comes from (issue #194).
 *
 * A rownative course file is a list of polygons. Most are *gates* — small
 * quadrilaterals a boat must row through — and reducing each to its centroid
 * gives a chain of two or three points, which the engine faithfully renders as
 * a straight line down a river that bends. The mirror's `distance_m` is no help
 * either: its own SCHEMA.md defines it as the centroid-to-centroid chain
 * length, so it is straight-line by construction (Castle to Crane: 19.6 km
 * declared for a ~21 km race).
 *
 * This module resolves the best geometry available, in a fixed precedence, and
 * says which one it used so the UI can be honest about it:
 *
 *   track → path → polygon-path → osm-derived → gate-chain
 *
 * Everything here runs before `createRoute()`. The 3D engine is untouched: give
 * it a real water path and it already renders correct curvature and scale.
 *
 * ## Where a real path comes from (#208, #747)
 *
 * Two things outrank the polygons:
 *
 * - `track`: a line the rower attached to the course id (R-8 of #194,
 *   `trackAttachmentStore`). Held to `GATE_TOLERANCE_M`, because a wrong
 *   upload must not quietly replace the course.
 * - `path`: the course file's optional top-level `path`, merged upstream in
 *   rownative/courses#26 (from #23). Its SCHEMA.md rule is that the path
 *   passes within 250 m of each gate centroid, or the gate's own extent if
 *   larger, so that is the tolerance it is held to here
 *   (`upstreamPathTolerance`). It runs start to finish by contract, so it is
 *   oriented but not trimmed at the gates. Few courses carry one yet; the rest still go
 *   through the chain below, so #743 remains the fix for most of them.
 *
 * Legacy files still store a traced line as a polygon (`polygon-path`).
 * `rownativeMirrorContract.test.ts` guards the shape against the live mirror
 * under `ROWNATIVE_CONTRACT_CHECK=1`.
 */

import type { Coordinate, GeometrySource } from '../types/index';
import { polylineLengthMeters } from '../utils/coordinateUtils';
import { roundCourseCorners, stakeTurnCentres } from '../utils/courseCorners';
import {
  maxVertexExtentMeters,
  projectPointOntoPolyline,
  reversePolyline,
  rotateLoopToStart,
  slicePolyline,
} from '../utils/polylineGeometry';

export type { GeometrySource };

/**
 * How close the final polyline must pass to every gate centroid, in metres,
 * for a rower-attached track, a traced polygon or a map-derived line. Roughly
 * half the median gate extent across the mirror's courses.
 */
export const GATE_TOLERANCE_M = 40;

/** #747: upstream's own rule for a course file's `path` (courses SCHEMA.md). */
export const UPSTREAM_PATH_TOLERANCE_M = 250;

/** How far from a gate a line may pass, per gate. */
export type GateTolerance = (gate: CourseGate) => number;

/** The strict rule: `GATE_TOLERANCE_M` for every gate. */
export const strictGateTolerance: GateTolerance = () => GATE_TOLERANCE_M;

/**
 * #747 FR1: a course file's `path` is held to upstream's rule, 250 m or the
 * gate polygon's own extent if that is larger.
 */
export const upstreamPathTolerance: GateTolerance = (gate) =>
  Math.max(UPSTREAM_PATH_TOLERANCE_M, gate.extentMeters ?? 0);

/** A polygon needs at least this many distinct vertices to be a path candidate. */
export const PATH_MIN_VERTICES = 12;

/**
 * …and must span at least this far end to end. Course 61's 13-vertex, 125 m
 * "Gate 1" stays a gate; course 277's 18-vertex, 8.9 km "Route" does not.
 */
export const PATH_MIN_EXTENT_M = 250;

/** Start and finish this close together along a candidate means it is a loop. */
export const LOOP_CLOSURE_M = 300;

/** A candidate must be longer than this before loop handling applies. */
export const LOOP_MIN_LENGTH_M = 1000;

/**
 * A gate chain shorter than this is not a course, it is an out-and-back whose
 * start and finish sit on top of each other (course 175: 24 m for a real row).
 *
 * R-7 states the condition as "first and last gate centroids < 300 m apart",
 * but AC-9 requires course 153 — a 35-gate out-and-back on the Charles whose
 * start and finish are 20 m apart — to import as a normal gate chain. Chain
 * length subsumes both: it is never shorter than the end-to-end separation, so
 * this rejects 175 (24 m) and keeps 153 (9.9 km).
 */
export const DEGENERATE_CHAIN_LENGTH_M = 300;

/** A single vertex of a rownative course polygon. */
export interface RownativeCoursePolygonPoint {
  lat: number;
  lon: number;
}

export interface RownativeCoursePolygon {
  name?: string;
  order?: number;
  /** Optional upstream hint. `"path"` forces a polygon to be treated as a line. */
  kind?: string;
  points?: RownativeCoursePolygonPoint[];
}

/** The subset of a course file this module reads. */
export interface RownativeCourseGeometryInput {
  id: string;
  name?: string;
  polygons?: RownativeCoursePolygon[];
  /**
   * Optional upstream traced path (rownative/courses#23, merged in #26):
   * start to finish, not closed on a loop. Resolved as source `path` (#747).
   */
  path?: RownativeCoursePolygonPoint[];
}

/** A gate the boat must row through, reduced to its centroid. */
export interface CourseGate {
  name: string;
  order: number;
  center: Coordinate;
  /** The gate polygon's own width, vertex to vertex, in metres (#743). */
  extentMeters?: number;
}

/** The geometry chosen for a course, and how it was arrived at. */
export interface ResolvedGeometry {
  coordinates: Coordinate[];
  source: GeometrySource;
  /** 0–1. How closely the polyline hugs the gates; 0 for a bare gate chain. */
  confidence: number;
  gates: Coordinate[];
  /** Human-readable notes about candidates that were tried and rejected. */
  warnings: string[];
  /** #753 FR1: gate centres where the course turns back (a stake or turn buoy). */
  stakeTurns: Coordinate[];
}

/** No source could produce a usable path, and the gate chain is degenerate. */
export class RownativeGeometryUnavailableError extends Error {
  readonly courseId: string;
  readonly courseName: string;
  constructor(courseId: string, courseName: string) {
    super(
      `${courseName} (${courseId}) starts and finishes in the same place, so its gates `
      + 'describe no path at all — importing it would row a few metres and stop. '
      + 'Attach a track (GPX, KML or GeoJSON) of the course to import it. It will also import '
      + 'once rownative adds a traced path for it.',
    );
    this.name = 'RownativeGeometryUnavailableError';
    this.courseId = courseId;
    this.courseName = courseName;
  }
}

/** A candidate line missed a gate, so it cannot be this course's path. */
export class GateFidelityError extends Error {
  readonly gateName: string;
  readonly offsetMeters: number;
  readonly allowedMeters: number;
  constructor(gateName: string, offsetMeters: number, allowedMeters: number = GATE_TOLERANCE_M) {
    super(
      `That line passes ${Number.isFinite(offsetMeters) ? `${Math.round(offsetMeters)} m` : 'too far'} `
      + `from the "${gateName}" gate, more than the ${Math.round(allowedMeters)} m allowed. `
      + 'It is not a path around this course.',
    );
    this.name = 'GateFidelityError';
    this.gateName = gateName;
    this.offsetMeters = offsetMeters;
    this.allowedMeters = allowedMeters;
  }
}

/** Something that can propose a water path through a course's gates. */
export interface WaterwayPathOptions {
  /**
   * Each gate's own width in metres, in the same order as the gate centres.
   * A wide gate across open water may sit further from a mapped centreline
   * than a narrow one on a canal (#743).
   */
  gateExtentsMeters?: number[];
}

export interface WaterwayPathProvider {
  findPath(gates: Coordinate[], options?: WaterwayPathOptions): Promise<Coordinate[] | null>;
}

export interface ResolveCourseGeometryOptions {
  /** A user-attached track, which outranks everything else. */
  attachedTrack?: Coordinate[] | null;
  /** Optional OSM-backed provider. Any failure falls through silently. */
  osmProvider?: WaterwayPathProvider | null;
}

const UNORDERED_POLYGON_SORT_KEY = Number.MAX_SAFE_INTEGER;

function isUsablePoint(point: RownativeCoursePolygonPoint): boolean {
  return Number.isFinite(point?.lat) && Number.isFinite(point?.lon);
}

function toCoordinates(points: RownativeCoursePolygonPoint[] | undefined): Coordinate[] {
  return (points ?? []).filter(isUsablePoint).map((point) => ({ lat: point.lat, lng: point.lon }));
}

function centroid(points: Coordinate[]): Coordinate | null {
  if (points.length === 0) return null;
  const lat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const lng = points.reduce((sum, point) => sum + point.lng, 0) / points.length;
  return { lat, lng };
}

/** Drop a polygon's repeated closing vertex so vertex counts are comparable. */
function dropClosingVertex(vertices: Coordinate[]): Coordinate[] {
  const last = vertices.length - 1;
  if (last > 0 && vertices[0].lat === vertices[last].lat && vertices[0].lng === vertices[last].lng) {
    return vertices.slice(0, last);
  }
  return vertices;
}

/** A polygon shaped like a traced line rather than a gate (R-6). */
export function isPathShaped(vertices: Coordinate[]): boolean {
  return vertices.length >= PATH_MIN_VERTICES && maxVertexExtentMeters(vertices) >= PATH_MIN_EXTENT_M;
}

/** A path-shaped polygon, or an attached track, awaiting validation. */
export interface PathCandidate {
  name: string;
  /** The polygon's own `order`, kept so a rejected candidate can revert to a
   *  gate in its original place in the chain. */
  order: number;
  vertices: Coordinate[];
}

export interface ClassifiedPolygons {
  gates: CourseGate[];
  candidates: PathCandidate[];
}

/**
 * Split a course's polygons into gates and path candidates.
 *
 * Path candidates are never chained by `order` — course 277 files its "Route"
 * polygon with `order: 2`, after the finish.
 */
export function classifyPolygons(course: RownativeCourseGeometryInput): ClassifiedPolygons {
  const ordered = [...(course.polygons ?? [])].sort(
    (a, b) => (a.order ?? UNORDERED_POLYGON_SORT_KEY) - (b.order ?? UNORDERED_POLYGON_SORT_KEY),
  );

  const gates: CourseGate[] = [];
  const candidates: PathCandidate[] = [];

  ordered.forEach((polygon, index) => {
    const vertices = toCoordinates(polygon.points);
    if (vertices.length === 0) return;
    const name = polygon.name?.trim() || `Polygon ${index + 1}`;

    // Shape is judged on distinct vertices, but the centroid is still the mean
    // of every point as filed — including a ring's repeated closing vertex —
    // so gate-chain courses resolve exactly as they did before this change.
    if (polygon.kind === 'path' || isPathShaped(dropClosingVertex(vertices))) {
      candidates.push({ name, order: polygon.order ?? index, vertices: dropClosingVertex(vertices) });
      return;
    }
    const center = centroid(vertices);
    if (center) {
      gates.push({
        name,
        order: polygon.order ?? index,
        center,
        extentMeters: maxVertexExtentMeters(dropClosingVertex(vertices)),
      });
    }
  });

  return { gates, candidates };
}

/**
 * The gate a course starts at.
 *
 * Name first, `order` second: course 257 files Start and Finish *after* its
 * five waypoints, so lowest-order alone would pick WP1.
 */
function findStartGate(gates: CourseGate[]): CourseGate | undefined {
  return gates.find((gate) => /^\s*start\b/i.test(gate.name)) ?? gates[0];
}

function findFinishGate(gates: CourseGate[]): CourseGate | undefined {
  return [...gates].reverse().find((gate) => /\b(finish|end)\b/i.test(gate.name)) ?? gates[gates.length - 1];
}

/** How many neighbours in a cyclic sequence step upwards. */
function cyclicAscendingCount(orders: number[]): number {
  if (orders.length < 2) return 0;
  let ascending = 0;
  for (let i = 0; i < orders.length; i++) {
    if (orders[(i + 1) % orders.length] > orders[i]) ascending++;
  }
  return ascending;
}

function worstGateOffset(
  line: Coordinate[],
  gates: CourseGate[],
): { gate: CourseGate; offsetMeters: number } | null {
  let worst: { gate: CourseGate; offsetMeters: number } | null = null;
  for (const gate of gates) {
    const offsetMeters = projectPointOntoPolyline(gate.center, line).offsetMeters;
    if (!worst || offsetMeters > worst.offsetMeters) worst = { gate, offsetMeters };
  }
  return worst;
}

/** The gate a line misses by the most beyond its tolerance, or null if none is missed. */
function worstGateMiss(
  line: Coordinate[],
  gates: CourseGate[],
  tolerance: GateTolerance,
): { gate: CourseGate; offsetMeters: number; allowedMeters: number } | null {
  let worst: { gate: CourseGate; offsetMeters: number; allowedMeters: number } | null = null;
  for (const gate of gates) {
    const offsetMeters = projectPointOntoPolyline(gate.center, line).offsetMeters;
    const allowedMeters = tolerance(gate);
    if (offsetMeters <= allowedMeters) continue;
    if (!worst || offsetMeters - allowedMeters > worst.offsetMeters - worst.allowedMeters) {
      worst = { gate, offsetMeters, allowedMeters };
    }
  }
  return worst;
}

function meanGateOffset(line: Coordinate[], gates: CourseGate[]): number {
  if (gates.length === 0) return 0;
  const total = gates.reduce(
    (sum, gate) => sum + projectPointOntoPolyline(gate.center, line).offsetMeters,
    0,
  );
  return total / gates.length;
}

/** Outcome of trying to make a candidate line into this course's path. */
export type CandidateFit =
  | { ok: true; coordinates: Coordinate[]; meanOffsetMeters: number; isLoop: boolean }
  | { ok: false; error: GateFidelityError };

/**
 * Orient, trim and validate a candidate line against a course's gates
 * (R-4, R-4a, R-4b, R-4c).
 *
 * Point-to-segment offsets decide fidelity; gate `order` only chooses which way
 * round a loop is rowed and never rejects a candidate on its own, because
 * upstream ordering is not always right (course 257 has WP4 and WP5 swapped).
 */
export function fitCandidateToGates(
  candidate: Coordinate[],
  gates: CourseGate[],
  tolerance: GateTolerance = strictGateTolerance,
  { trimToGates = true }: { trimToGates?: boolean } = {},
): CandidateFit {
  if (candidate.length < 2) {
    return { ok: false, error: new GateFidelityError('start', Number.POSITIVE_INFINITY) };
  }
  if (gates.length === 0) {
    return { ok: true, coordinates: candidate, meanOffsetMeters: 0, isLoop: false };
  }

  const worst = worstGateMiss(candidate, gates, tolerance);
  if (worst) {
    return { ok: false, error: new GateFidelityError(worst.gate.name, worst.offsetMeters, worst.allowedMeters) };
  }

  const startGate = findStartGate(gates);
  const finishGate = findFinishGate(gates);
  if (!startGate || !finishGate || startGate === finishGate) {
    return {
      ok: true,
      coordinates: candidate,
      meanOffsetMeters: meanGateOffset(candidate, gates),
      isLoop: false,
    };
  }

  const totalLength = polylineLengthMeters(candidate);
  const startAlong = projectPointOntoPolyline(startGate.center, candidate).alongMeters;
  const finishAlong = projectPointOntoPolyline(finishGate.center, candidate).alongMeters;
  const isLoop = Math.abs(startAlong - finishAlong) <= LOOP_CLOSURE_M && totalLength > LOOP_MIN_LENGTH_M;

  let fitted: Coordinate[];
  if (isLoop) {
    // Row the whole ring from the start gate, in whichever direction visits the
    // intermediate gates closest to ascending order.
    const intermediate = gates.filter((gate) => gate !== startGate && gate !== finishGate);
    const forwardOrders = intermediate
      .map((gate) => ({
        gate,
        along: (projectPointOntoPolyline(gate.center, candidate).alongMeters - startAlong + totalLength) % totalLength,
      }))
      .sort((a, b) => a.along - b.along)
      .map((entry) => entry.gate.order);
    const backwardOrders = [...forwardOrders].reverse();

    const oriented = cyclicAscendingCount(backwardOrders) > cyclicAscendingCount(forwardOrders)
      ? reversePolyline(candidate)
      : candidate;
    const orientedStart = projectPointOntoPolyline(startGate.center, oriented).alongMeters;
    fitted = rotateLoopToStart(oriented, orientedStart);
  } else {
    const oriented = startAlong <= finishAlong ? candidate : reversePolyline(candidate);
    // An upstream `path` is drawn start to finish by contract, so all of it is
    // the course; trimming it at the gates' projections would only shorten a
    // line drawn a little to one side (#747).
    const from = projectPointOntoPolyline(startGate.center, oriented).alongMeters;
    const to = projectPointOntoPolyline(finishGate.center, oriented).alongMeters;
    fitted = trimToGates ? slicePolyline(oriented, from, to) : oriented;
  }

  // Trimming can cut a gate off the end of the line, so re-check what survived.
  const worstAfterFit = worstGateMiss(fitted, gates, tolerance);
  if (worstAfterFit) {
    return {
      ok: false,
      error: new GateFidelityError(worstAfterFit.gate.name, worstAfterFit.offsetMeters, worstAfterFit.allowedMeters),
    };
  }
  if (fitted.length < 2 || polylineLengthMeters(fitted) <= 0) {
    return { ok: false, error: new GateFidelityError(startGate.name, Number.POSITIVE_INFINITY) };
  }

  return { ok: true, coordinates: fitted, meanOffsetMeters: meanGateOffset(fitted, gates), isLoop };
}

function confidenceFor(meanOffsetMeters: number): number {
  return Math.min(1, Math.max(0, 1 - meanOffsetMeters / GATE_TOLERANCE_M));
}

/** Gates in course order, which is what the chain fallback rows. */
function orderedGates(gates: CourseGate[]): CourseGate[] {
  const sortKey = (gate: CourseGate) => (Number.isFinite(gate.order) ? gate.order : UNORDERED_POLYGON_SORT_KEY);
  return [...gates].sort((a, b) => sortKey(a) - sortKey(b));
}

function orderedGateCenters(gates: CourseGate[]): Coordinate[] {
  return orderedGates(gates).map((gate) => gate.center);
}

/** A fillet may cut this share of a gate's width inside its centre... */
const FILLET_CUT_GATE_SHARE = 0.4;
/** ...but never less than this, nor more than this (well inside tolerance). */
const FILLET_CUT_MIN_M = 8;
const FILLET_CUT_MAX_M = 25;

const filletCutFor = (gate: CourseGate): number =>
  Math.min(FILLET_CUT_MAX_M, Math.max(FILLET_CUT_MIN_M, (gate.extentMeters ?? 0) * FILLET_CUT_GATE_SHARE));

/**
 * Round a line's corners (#743), unless doing so would carry it further from
 * a gate than a path is allowed to be. Rounding is cosmetic; passing the gates
 * is the contract. `cornerGates`, when given, is index-aligned with `line` and
 * lets each fillet size itself to the gate it rounds.
 */
function roundedWithinTolerance(
  line: Coordinate[],
  gates: CourseGate[],
  cornerGates?: CourseGate[],
): Coordinate[] {
  const rounded = roundCourseCorners(
    line,
    cornerGates ? { maxCutMeters: cornerGates.map(filletCutFor) } : {},
  );
  if (rounded === line) return line;
  const worst = worstGateOffset(rounded, gates);
  return worst && worst.offsetMeters > GATE_TOLERANCE_M ? line : rounded;
}

/**
 * Choose the geometry for a course, trying each source in precedence order.
 *
 * @throws RownativeGeometryUnavailableError when nothing works and the gate
 *   chain is degenerate — better no route than a 24 m straight line.
 */
export async function resolveCourseGeometry(
  course: RownativeCourseGeometryInput,
  options: ResolveCourseGeometryOptions = {},
): Promise<ResolvedGeometry> {
  const resolved = await resolveLine(course, options);
  // #753 FR1: whatever line won, the stakes are where the gates turn back.
  return { ...resolved, stakeTurns: stakeTurnCentres(orderedGateCenters(classifyPolygons(course).gates)) };
}

async function resolveLine(
  course: RownativeCourseGeometryInput,
  options: ResolveCourseGeometryOptions,
): Promise<Omit<ResolvedGeometry, 'stakeTurns'>> {
  const { gates, candidates } = classifyPolygons(course);
  const gateCenters = gates.map((gate) => gate.center);
  const warnings: string[] = [];

  // 1. A track the rower attached outranks everything, under the strict rule.
  const attached = options.attachedTrack?.length ? options.attachedTrack : null;
  if (attached && attached.length >= 2) {
    const fit = fitCandidateToGates(attached, gates);
    if (fit.ok) {
      return {
        coordinates: fit.coordinates,
        source: 'track',
        confidence: confidenceFor(fit.meanOffsetMeters),
        gates: gateCenters,
        warnings,
      };
    }
    warnings.push(`Attached track ignored: ${fit.error.message}`);
  }

  // 1b. The course file's own `path` (#747), under upstream's rule.
  const upstreamPath = toCoordinates(course.path);
  if (upstreamPath.length >= 2) {
    const fit = fitCandidateToGates(upstreamPath, gates, upstreamPathTolerance, { trimToGates: false });
    if (fit.ok) {
      return {
        coordinates: fit.coordinates,
        source: 'path',
        confidence: confidenceFor(fit.meanOffsetMeters),
        gates: gateCenters,
        warnings,
      };
    }
    warnings.push(`Course path ignored: ${fit.error.message}`);
  }

  // 2. Path-shaped polygons already in the course file. Each is judged on its
  //    own; the best passing one wins and the rest are discarded, never folded
  //    back in as bogus gates.
  if (candidates.length > 0) {
    const evaluated = candidates.map((candidate) => ({
      candidate,
      fit: fitCandidateToGates(candidate.vertices, gates),
    }));
    const passing = evaluated
      .filter(
        (entry): entry is { candidate: PathCandidate; fit: Extract<CandidateFit, { ok: true }> } => entry.fit.ok,
      )
      .sort((a, b) => a.fit.meanOffsetMeters - b.fit.meanOffsetMeters);

    if (passing.length > 0) {
      const [best] = passing;
      for (const other of evaluated) {
        if (other.candidate === best.candidate) continue;
        warnings.push(
          other.fit.ok
            ? `Ignored alternative traced path "${other.candidate.name}".`
            : `Discarded traced path "${other.candidate.name}": ${other.fit.error.message}`,
        );
      }
      return {
        coordinates: best.fit.coordinates,
        source: 'polygon-path',
        confidence: confidenceFor(best.fit.meanOffsetMeters),
        gates: gateCenters,
        warnings,
      };
    }

    // Nothing passed: these polygons are long "row through here" zones, not a
    // path (course 237's WP1/WP3). Treat them as gates and carry on.
    warnings.push(
      `No traced path in this course passes within ${GATE_TOLERANCE_M} m of every gate; using the gate outline.`,
    );
    for (const candidate of candidates) {
      const center = centroid(candidate.vertices);
      if (center) {
        gates.push({ name: candidate.name, order: candidate.order, center });
        gateCenters.push(center);
      }
    }
  }

  // #756 FR1: a gate chain that goes nowhere fails here, before any network
  // lookup. The reason is in the course file itself, so the rower should not
  // wait half a minute for a waterway search to be told so.
  const chain = orderedGateCenters(gates);
  if (chain.length >= 2 && polylineLengthMeters(chain) < DEGENERATE_CHAIN_LENGTH_M) {
    throw new RownativeGeometryUnavailableError(course.id, course.name ?? `Course ${course.id}`);
  }

  // 3. OSM waterway centrelines, when a provider is supplied. Network-tolerant
  //    by contract: any failure falls through to the gate chain.
  if (options.osmProvider && gates.length >= 2) {
    try {
      const inOrder = orderedGates(gates);
      const derived = await options.osmProvider.findPath(
        inOrder.map((gate) => gate.center),
        { gateExtentsMeters: inOrder.map((gate) => gate.extentMeters ?? 0) },
      );
      if (derived && derived.length >= 2) {
        // The walk joins the centreline to off-line gates with straight
        // run-ins; round those joints before judging the line against the gates.
        const fit = fitCandidateToGates(roundedWithinTolerance(derived, gates), gates);
        if (fit.ok) {
          return {
            coordinates: fit.coordinates,
            source: 'osm-derived',
            confidence: confidenceFor(fit.meanOffsetMeters),
            gates: gateCenters,
            warnings,
          };
        }
        warnings.push(`Map-derived path ignored: ${fit.error.message}`);
      }
    } catch {
      // Overpass is best-effort; never let it block or fail an import.
    }
  }

  // 4. The gate centroid chain — today's behaviour, honestly labelled. A chain
  //    of fewer than two gates is a broken course file rather than an
  //    out-and-back, and is left for the caller to report as such. A
  //    degenerate chain was refused above, before the lookup.

  // Straight legs between gate centres, with each turn rounded so the boat,
  // camera and water ribbon do not pivot on the spot at a gate (#743).
  return {
    coordinates: roundedWithinTolerance(chain, gates, orderedGates(gates)),
    source: 'gate-chain',
    confidence: 0,
    gates: gateCenters,
    warnings,
  };
}
