/**
 * #745 VP-25 FR2 — the shore of a drawn lake. Where the polygon water is on
 * (#493), the bank strips laid along the racing line give way to the lake
 * (#742 FR5), and until now nothing took their place: the lake met the flat
 * ground plane with no shoreline. This is the React scene's lake land
 * (`lakeGeometry.ts` `createLakeLandGeometry`, retired at the cutover) for
 * the engine: a band of bank running out from each outer shore, and in from
 * each island's, drawn by the bank pass so it carries the same wet-earth edge,
 * grass and biome ground as the strips.
 *
 * Flat at the strips' height (the React bank climbed 1.5 m; the engine's land
 * beyond the bank is a flat plane, which a raised band would only stand
 * proud of). Where the route's own ribbon runs into or out of the lake the
 * band opens (the React scene's `ribbonClearings`): any band triangle on the
 * ribbon's water, or on the lake, is left out.
 *
 * A geographic surface like `bankStrip`, inside the #623 exception.
 */
import { BANK_LIFT_METRES } from './bankStrip';
import { WATER_SURFACE_Y } from './waterStrip';
import type { LakeOutline } from './waterFootprint';

/** How far the band runs out from the shore, in metres (the React bank's width). */
export const LAKE_SHORE_WIDTH_METRES = 30;
/** An island's band is held to this share of its inradius, so a small island keeps a middle. */
export const ISLAND_BAND_SHARE = 0.5;
/**
 * Longest shore segment, in metres. A long straight edge is cut into pieces
 * this long so the band can open just where the ribbon crosses it.
 */
export const SHORE_SEGMENT_METRES = 10;
/** A sharp corner's offset is held to this many band widths, so it never spikes. */
const MITER_LIMIT = 2;

export interface LakeShoreGeometry {
  positions: Float32Array;
  /** (0, shoreDist) per vertex, as the bank strips' `sides`. */
  sides: Float32Array;
  indices: Uint32Array;
}

export interface LakeShoreOptions {
  width?: number;
  /** Water the band must not cover (the route's ribbon, the lakes). Tested at each triangle's centre. */
  onWater?: (x: number, z: number) => boolean;
}

type Ring = ReadonlyArray<{ x: number; z: number }>;

/** Twice the signed area in x/z. */
const signedArea = (ring: Ring): number => {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.x * b.z - b.x * a.z;
  }
  return s;
};

const perimeter = (ring: Ring): number => {
  let p = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    p += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return p;
};

/** Drops a closing repeat of the first point and cuts long edges into {@link SHORE_SEGMENT_METRES} pieces. */
const open = (ring: Ring): Ring => {
  const n0 = ring.length;
  const closed = n0 > 1 && ring[0].x === ring[n0 - 1].x && ring[0].z === ring[n0 - 1].z;
  const pts = closed ? ring.slice(0, -1) : ring;
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const pieces = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / SHORE_SEGMENT_METRES));
    for (let k = 0; k < pieces; k++) out.push({ x: a.x + ((b.x - a.x) * k) / pieces, z: a.z + ((b.z - a.z) * k) / pieces });
  }
  return out;
};

class Builder {
  positions: number[] = [];
  sides: number[] = [];
  indices: number[] = [];

  /**
   * One band along a closed ring. `outward` is +1 to run away from the
   * ring's inside (a lake's outer shore) and -1 to run into it (an island).
   */
  band(ring: Ring, width: number, outward: 1 | -1, onWater?: (x: number, z: number) => boolean): void {
    const n = ring.length;
    if (n < 3 || width <= 0) return;
    // For a counter-clockwise ring (positive area), (dz, -dx) points out.
    const wind = signedArea(ring) > 0 ? 1 : -1;
    const y = WATER_SURFACE_Y + BANK_LIFT_METRES;
    const base = this.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const prev = ring[(i + n - 1) % n];
      const cur = ring[i];
      const next = ring[(i + 1) % n];
      const n1 = edgeNormal(prev, cur, wind * outward);
      const n2 = edgeNormal(cur, next, wind * outward);
      let mx = n1[0] + n2[0];
      let mz = n1[1] + n2[1];
      const ml = Math.hypot(mx, mz);
      if (ml < 1e-6) { mx = n2[0]; mz = n2[1]; } else { mx /= ml; mz /= ml; }
      // Miter: hold the band's width along both edges, up to a limit.
      const cos = Math.max(1 / MITER_LIMIT, mx * n2[0] + mz * n2[1]);
      const reach = width / cos;
      this.positions.push(cur.x, y, cur.z, cur.x + mx * reach, y, cur.z + mz * reach);
      this.sides.push(0, 0, 0, width);
    }
    for (let i = 0; i < n; i++) {
      const a = base + i * 2; // shore
      const b = a + 1; // outer
      const c = base + ((i + 1) % n) * 2;
      const d = c + 1;
      this.tri(a, c, b, onWater);
      this.tri(b, c, d, onWater);
    }
  }

  private tri(i0: number, i1: number, i2: number, onWater?: (x: number, z: number) => boolean): void {
    const p = this.positions;
    const cx = (p[i0 * 3] + p[i1 * 3] + p[i2 * 3]) / 3;
    const cz = (p[i0 * 3 + 2] + p[i1 * 3 + 2] + p[i2 * 3 + 2]) / 3;
    if (onWater?.(cx, cz)) return;
    // Wind to face the sky (cull is off, but the depth and tests read it).
    const ux = p[i1 * 3] - p[i0 * 3];
    const uz = p[i1 * 3 + 2] - p[i0 * 3 + 2];
    const vx = p[i2 * 3] - p[i0 * 3];
    const vz = p[i2 * 3 + 2] - p[i0 * 3 + 2];
    // y of (u × v) is uz*vx - ux*vz. A corner of a narrow band can fold two
    // inner points together: that triangle has no area and is left out.
    const ny = uz * vx - ux * vz;
    if (Math.abs(ny) < 1e-6) return;
    if (ny > 0) this.indices.push(i0, i1, i2);
    else this.indices.push(i0, i2, i1);
  }
}

const edgeNormal = (a: { x: number; z: number }, b: { x: number; z: number }, sign: number): [number, number] => {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  return [(sign * dz) / l, (-sign * dx) / l];
};

/**
 * The shore bands of every lake: out from each outer ring, and in from each
 * island's ring (narrowed on a small island).
 */
export const buildLakeShore = (
  lakes: ReadonlyArray<LakeOutline>,
  { width = LAKE_SHORE_WIDTH_METRES, onWater }: LakeShoreOptions = {},
): LakeShoreGeometry => {
  const b = new Builder();
  for (const lake of lakes) {
    b.band(open(lake.outer), width, 1, onWater);
    for (const hole of lake.holes) {
      const island = open(hole);
      if (island.length < 3) continue;
      const inradius = Math.abs(signedArea(island)) / 2 / (perimeter(island) / 2);
      b.band(island, Math.min(width, inradius * ISLAND_BAND_SHARE), -1, onWater);
    }
  }
  return {
    positions: new Float32Array(b.positions),
    sides: new Float32Array(b.sides),
    indices: new Uint32Array(b.indices),
  };
};
