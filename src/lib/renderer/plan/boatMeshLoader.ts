/**
 * Load the baked boat mesh (#570 D1-b).
 *
 * The baker (`scripts/build-boat-mesh.mjs`) emits `public/assets/boat/shell.bin`
 * with the exact byte layout `boatMesh.ts` documents. The engine prefers the
 * baked buffer so a change to the boat is one file edit + one `npm run
 * build:boat-mesh`, not a redeploy of the engine chunk. When the fetch is
 * unavailable (SSR, test harness, offline, 404) the loader falls back to the
 * procedural generator so the smoke silhouette is identical.
 *
 * Layout (little-endian):
 *   - u32 vertexCount
 *   - u32 indexCount
 *   - vertexCount * BOAT_FLOATS_PER_VERTEX * 4 B float32 vertex data
 *   - indexCount * 2 B uint16 indices
 */

import {
  BOAT_FLOATS_PER_VERTEX,
  buildBoatMesh,
  type BoatMeshBuffers,
} from './boatMesh';

/**
 * #623 Phase 1 / D4-a — the procedural fallback is retained only for
 * SSR + unit tests. A user-facing load failure must surface the
 * `renderer-unavailable` banner instead of silently drawing the
 * procedural hull: callers on the user-facing path set
 * `allowProceduralFallback: false` and treat `source: 'failed'` as the
 * cue to publish the banner.
 */
export type BoatMeshLoadSource = 'baked' | 'procedural' | 'failed';

export interface BoatMeshHandle {
  /** Null when `source: 'failed'` — the caller must not draw. */
  mesh: BoatMeshBuffers | null;
  source: BoatMeshLoadSource;
}

export const HEADER_BYTES = 8;

/** Decode a `shell.bin` buffer; throws on a malformed blob so the loader can fall back. */
export const decodeBoatMesh = (buffer: ArrayBuffer): BoatMeshBuffers => {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error(`boat shell.bin too small: ${buffer.byteLength} B`);
  }
  const view = new DataView(buffer);
  const vertexCount = view.getUint32(0, true);
  const indexCount = view.getUint32(4, true);
  const vertexBytes = vertexCount * BOAT_FLOATS_PER_VERTEX * 4;
  const indexBytes = indexCount * 2;
  const expected = HEADER_BYTES + vertexBytes + indexBytes;
  if (buffer.byteLength !== expected) {
    throw new Error(
      `boat shell.bin size mismatch: got ${buffer.byteLength}, expected ${expected}`,
    );
  }
  // Copy out of the raw buffer so the caller holds standalone typed arrays
  // (and the ArrayBuffer behind the fetch can be released). Also keeps the
  // index data unaligned-safe — DataView reads one u16 at a time.
  const vertices = new Float32Array(vertexCount * BOAT_FLOATS_PER_VERTEX);
  for (let i = 0; i < vertices.length; i++) {
    vertices[i] = view.getFloat32(HEADER_BYTES + i * 4, true);
  }
  const indices = new Uint16Array(indexCount);
  for (let i = 0; i < indexCount; i++) {
    indices[i] = view.getUint16(HEADER_BYTES + vertexBytes + i * 2, true);
  }
  return { vertices, indices, vertexCount, indexCount };
};

export interface LoadBoatMeshOptions {
  /** URL of `shell.bin`. The engine passes an `assetUrl`-prefixed path. */
  url: string;
  /** Overridable fetch for tests. Defaults to `globalThis.fetch`. */
  fetchFn?: typeof fetch;
  /**
   * #623 Phase 1 / D4-a — when `false`, a load failure returns
   * `{ mesh: null, source: 'failed' }` and the caller is expected to
   * surface the renderer-unavailable banner instead of drawing. SSR +
   * unit tests leave this unset (default `true`) so they continue to
   * get the procedural stub.
   */
  allowProceduralFallback?: boolean;
}

/**
 * Try the baked buffer. On any error:
 *   - with `allowProceduralFallback: true` (default; SSR + tests), fall
 *     back to the procedural generator so the caller always has a mesh.
 *   - with `allowProceduralFallback: false` (user-facing engine path),
 *     return `{ mesh: null, source: 'failed' }`; the caller is then
 *     expected to publish the `renderer-unavailable` fallback and
 *     refuse to draw rather than silently use the procedural hull.
 *
 * Never rejects.
 */
export const loadBoatMesh = async (opts: LoadBoatMeshOptions): Promise<BoatMeshHandle> => {
  const allowProcedural = opts.allowProceduralFallback ?? true;
  const failed = (): BoatMeshHandle =>
    allowProcedural ? { mesh: buildBoatMesh(), source: 'procedural' } : { mesh: null, source: 'failed' };
  const fetchFn = opts.fetchFn ?? (globalThis as { fetch?: typeof fetch }).fetch;
  if (!fetchFn) return failed();
  try {
    const res = await fetchFn(opts.url);
    if (!res.ok) return failed();
    const buf = await res.arrayBuffer();
    return { mesh: decodeBoatMesh(buf), source: 'baked' };
  } catch {
    return failed();
  }
};
