/**
 * Bank-strip geometry. Two ribbons of ground running on either side of the
 * water strip; shares the water's `RouteCurve` so bank and water bend
 * together along the GPS polyline. Before this was curve-aware
 * (#549 slice) the bank was hardcoded to a straight 400 m ±20..±80 ribbon,
 * so a boat following a bending route would appear to drift onto bare
 * terrain whenever the curve turned past where the straight bank reached.
 *
 * Falls back to the old straight ribbon when no curve is supplied (smoke
 * pages that mount the engine without a route).
 */

import type { RouteCurve } from '../math/curve';
import { vec3Normalize, vec3, type Vec3 } from '../math/vec3';
import { WATER_SURFACE_Y, buildWaterStrip, type WaterEdges } from './waterStrip';
import { routeWaterFootprint, type WaterFootprint } from './waterFootprint';
import { BANK_BIOME_WEIGHTS, BIOME_BLEND_METRES, writeBiomeWeights } from './bankBiome';
import type { SceneryProfile } from '../../services/routeEnrichmentService';

/**
 * #742 VP-22 FR1 — columns across each bank, as fractions of its width, so
 * the part of a bank lying on another leg's water can be sunk without
 * taking the whole 60 m strip with it.
 */
export const BANK_COLUMNS: readonly number[] = [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1];
/** A bank sits this far above the water (it used to win every overlap). */
export const BANK_LIFT_METRES = 0.1;
/** …and a bank vertex on water sinks this far below it, so the water wins. */
export const BANK_SUNK_METRES = 2;

export interface BankStripGeometry {
  positions: Float32Array; // x,y,z
  /**
   * Per-vertex (sign, shoreDist) pair. `sign` is ±1 as before (left vs right
   * strip, kept for compatibility). `shoreDist` is metres from the water
   * edge: 0 at the inner (shore-side) row of the strip, `bankWidth` at the
   * outer row. The bank pass's triplanar grass/earth blend (#591-fu P0b)
   * reads it to pick wet earth near the shore and lush grass further in.
   */
  sides: Float32Array;
  indices: Uint16Array | Uint32Array;
  /** `uint32` once a long route's banks pass 65 535 vertices. */
  indexFormat: 'uint16' | 'uint32';
  /**
   * #725 FR5 — per-vertex biome weights (`BANK_BIOME_WEIGHTS` floats each, in
   * `BANK_BIOME_SLOTS` order) when `profileForProgress` was given.
   */
  biomes?: Float32Array;
  /** #742 — bank vertices sunk because they lie on the route's water. */
  sunkVertices: number;
  /** #742 — bank triangles left out of `indices` because their centre is on the route's water. */
  droppedTriangles: number;
}

export interface BuildBankStripsOptions {
  curve?: RouteCurve | null;
  /** Default inner edge when no `edgesForProgress` is supplied. */
  waterHalfWidth?: number;
  /** Width of each bank beyond the waterline. */
  bankWidth?: number;
  /** Straight-line length (smoke-page fallback). */
  length?: number;
  /** Vertex columns along the strip. */
  divisions?: number;
  /**
   * Per-progress shore widths (scene units). Bank's inner edge sits at
   * these values; outer edge is `inner + bankWidth`. Omitted → symmetric.
   */
  edgesForProgress?: (progress: number) => WaterEdges;
  /**
   * #742 FR1 — the route's water, to sink bank vertices lying on it (another
   * leg's ribbon). Defaults to the water strip built from the same curve and
   * edges; pass null to keep every bank vertex up.
   */
  footprint?: WaterFootprint | null;
  /**
   * #755 FR4 — a coastal course has land on one side only: the strip on the
   * other (sea) side is not emitted. Omitted → both banks.
   */
  landSide?: 'left' | 'right';
  /**
   * #725 FR5 — each bank's scenery profile along the route. Given, the strips
   * carry per-vertex biome weights (`biomes`) blended over
   * ±`BIOME_BLEND_METRES` of bank.
   */
  profileForProgress?: (progress: number, side: 'left' | 'right') => SceneryProfile;
}

const UP: Vec3 = vec3(0, 1, 0);

export const buildBankStrips = (
  options: BuildBankStripsOptions = {},
): BankStripGeometry => {
  const curve = options.curve ?? null;
  const waterHalfWidth = options.waterHalfWidth ?? 20;
  const bankWidth = options.bankWidth ?? 60;
  const length = options.length ?? 400;
  const defaultDivisions = curve && curve.length >= 2
    ? Math.max(128, Math.min(16000, Math.ceil(curve.approximateLength(64) / 10)))
    : 40;
  const divisions = Math.max(2, options.divisions ?? defaultDivisions);
  const edgesForProgress = options.edgesForProgress
    ?? ((_t: number): WaterEdges => ({ left: waterHalfWidth, right: waterHalfWidth }));

  const columns = BANK_COLUMNS.length;
  const vertsPerStrip = (divisions + 1) * columns;
  const totalVerts = vertsPerStrip * 2;
  const positions = new Float32Array(totalVerts * 3);
  // `sides` packs TWO floats per vertex (sign, shoreDist).
  const sides = new Float32Array(totalVerts * 2);
  const indexCount = divisions * (columns - 1) * 6 * 2;
  const indexFormat = totalVerts > 0xffff ? 'uint32' : 'uint16';
  const indices = indexFormat === 'uint32' ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  const footprint = options.footprint === undefined
    ? curve && curve.length >= 2
      ? routeWaterFootprint(buildWaterStrip(curve, { edgesForProgress, divisions }))
      : null
    : options.footprint;
  let sunkVertices = 0;
  const profileForProgress = options.profileForProgress;
  const biomes = profileForProgress ? new Float32Array(totalVerts * BANK_BIOME_WEIGHTS) : undefined;
  const routeMetres = curve && curve.length >= 2 ? curve.approximateLength(64) : length;
  const blendWindow = BIOME_BLEND_METRES / Math.max(1, routeMetres);

  const sampleCurve = (
    i: number,
    out: { x: number; z: number; perpX: number; perpZ: number },
  ): void => {
    const t = i / divisions;
    if (curve && curve.length >= 2) {
      const s = { position: vec3(), tangent: vec3(0, 0, -1), angle: 0 };
      curve.sample(t, s);
      const perp = vec3();
      perp[0] = s.tangent[1] * UP[2] - s.tangent[2] * UP[1];
      perp[1] = s.tangent[2] * UP[0] - s.tangent[0] * UP[2];
      perp[2] = s.tangent[0] * UP[1] - s.tangent[1] * UP[0];
      vec3Normalize(perp, perp);
      out.x = s.position[0];
      out.z = s.position[2];
      out.perpX = perp[0];
      out.perpZ = perp[2];
    } else {
      out.x = 0;
      out.z = -t * length;
      out.perpX = -1; // tangent (+Z) × up = (-1, 0, 0); matches the old straight bank
      out.perpZ = 0;
    }
  };

  // #742 FR1/FR4: a triangle whose centre is on the route's water is
  // dropped from the index list, so no grass is drawn (or cast into the
  // shadow maps) over another leg's water.
  let droppedTriangles = 0;
  let written = 0;
  const emit = (i0: number, i1: number, i2: number): void => {
    if (footprint !== null) {
      const cx = (positions[i0 * 3] + positions[i1 * 3] + positions[i2 * 3]) / 3;
      const cz = (positions[i0 * 3 + 2] + positions[i1 * 3 + 2] + positions[i2 * 3 + 2]) / 3;
      if (footprint.contains(cx, cz)) {
        droppedTriangles += 1;
        return;
      }
    }
    indices[written] = i0;
    indices[written + 1] = i1;
    indices[written + 2] = i2;
    written += 3;
  };

  const writeStrip = (sign: 1 | -1, vertOffset: number): void => {
    const sample = { x: 0, z: 0, perpX: 0, perpZ: 0 };
    const sideName = sign < 0 ? 'left' : 'right';
    const profileAt = profileForProgress ? (t: number) => profileForProgress(t, sideName) : null;
    const row = new Float32Array(BANK_BIOME_WEIGHTS);
    for (let i = 0; i <= divisions; i += 1) {
      sampleCurve(i, sample);
      const t = i / divisions;
      const { left, right } = edgesForProgress(t);
      const shore = sign < 0 ? left : right;
      if (profileAt) writeBiomeWeights(profileAt, t, blendWindow, row);
      for (let c = 0; c < columns; c += 1) {
        const out = shore + bankWidth * BANK_COLUMNS[c];
        const x = sample.x + sample.perpX * sign * out;
        const z = sample.z + sample.perpZ * sign * out;
        // #742 FR1: a bank vertex on the route's water (another leg) sinks
        // below it, so the water draws there instead of grass.
        const sunk = footprint !== null && footprint.contains(x, z);
        if (sunk) sunkVertices += 1;
        const v = vertOffset + i * columns + c;
        positions[v * 3] = x;
        positions[v * 3 + 1] = WATER_SURFACE_Y + (sunk ? -BANK_SUNK_METRES : BANK_LIFT_METRES);
        positions[v * 3 + 2] = z;
        // (sign, shoreDistMetres): bank.wgsl mixes grass vs earth /
        // wet-shore vs lush-mid off the distance from the waterline.
        sides[v * 2] = sign;
        sides[v * 2 + 1] = bankWidth * BANK_COLUMNS[c];
        if (biomes) biomes.set(row, v * BANK_BIOME_WEIGHTS);
      }
    }
    for (let i = 0; i < divisions; i += 1) {
      for (let c = 0; c < columns - 1; c += 1) {
        // a, b: this station's inner/outer column; d, e: the next station's.
        const a = vertOffset + i * columns + c;
        const b = a + 1;
        const d = a + columns;
        const e = d + 1;
        // Wind so the ground faces up on either side (same convention as the
        // pre-curve straight ribbon the old #269 bug uncovered).
        if (sign > 0) {
          emit(a, d, b);
          emit(b, d, e);
        } else {
          emit(a, b, d);
          emit(b, e, d);
        }
      }
    }
  };

  if (options.landSide !== 'right') writeStrip(-1, 0);
  if (options.landSide !== 'left') writeStrip(1, vertsPerStrip);

  return {
    positions,
    sides,
    ...(biomes ? { biomes } : {}),
    indices: indices.slice(0, written),
    indexFormat,
    sunkVertices,
    droppedTriangles,
  };
};

/**
 * #742 FR4 — the bytes to upload for a bank's index list. With dropped
 * triangles a uint16 list can be an odd length, and WebGPU writes whole
 * 4-byte words: the copy is padded with one zero, which the draw (counted
 * from `indices.length`) never reads.
 */
export const indexUpload = (indices: Uint16Array | Uint32Array): Uint16Array | Uint32Array => {
  if (indices.byteLength % 4 === 0) return indices;
  const padded = new Uint16Array(indices.length + 1);
  padded.set(indices);
  return padded;
};
