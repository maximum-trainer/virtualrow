/**
 * Scenery GLB decode worker.
 *
 * The ride loop streams tier-E / tier-D kit models in as the boat approaches.
 * Fetching the bytes is already async, but decoding the GLB (meshopt + index
 * / vertex readers) and merging its primitives into the engine's single
 * position/normal/colour/index buffers is pure CPU work that used to run on
 * the main thread. On a tier-E tree that took long enough to drop a frame
 * every ~15 s as new chunks came into view. This worker runs that pipeline
 * off-thread and transfers the result back as detached ArrayBuffers, so the
 * main thread only pays for `createBuffer` / `writeBuffer`.
 */

import { loadGlb } from './glbLoader';
import {
  mergeSceneryPrimitives,
  scaleMeshColors,
  VEGETATION_ALBEDO_GAIN,
} from '../renderer/engine/sceneryMeshBuffers';

export interface GlbDecodeRequest {
  type: 'decode';
  requestId: number;
  id: string;
  url: string;
  applyVegetationGain: boolean;
}

export interface GlbDecodeOk {
  type: 'ok';
  requestId: number;
  id: string;
  positions: ArrayBufferLike;
  normals: ArrayBufferLike;
  indices: ArrayBufferLike;
  indicesIs32: boolean;
  colors: ArrayBufferLike;
  baseColor: [number, number, number, number];
}

export interface GlbDecodeErr {
  type: 'err';
  requestId: number;
  id: string;
  message: string;
}

export type GlbDecodeResponse = GlbDecodeOk | GlbDecodeErr;

/**
 * Pure helper so the inline fallback and the worker share the same pipeline.
 * Returns the merged mesh + the primitive-0 base colour. The caller is
 * responsible for transferring / registering the buffers.
 */
export const decodeSceneryGlb = async (
  bytes: Uint8Array,
  applyVegetationGain: boolean,
): Promise<{
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint16Array | Uint32Array;
  colors: Float32Array;
  baseColor: [number, number, number, number];
}> => {
  const model = await loadGlb(bytes);
  const merged = mergeSceneryPrimitives(model.primitives);
  const colors = applyVegetationGain
    ? scaleMeshColors(merged.colors, VEGETATION_ALBEDO_GAIN)
    : merged.colors;
  const baseColor = (model.primitives[0]?.baseColor ?? [1, 1, 1, 1]) as [
    number,
    number,
    number,
    number,
  ];
  return {
    positions: merged.positions,
    normals: merged.normals,
    indices: merged.indices,
    colors,
    baseColor,
  };
};

// The branch below runs only inside a Worker. Guard the registration so the
// module can also be imported from the main thread (the inline fallback does
// that) without hijacking the host's `onmessage`. `self.importScripts` exists
// in Dedicated/SharedWorker scopes but not on `window`, so it is a reliable
// cheap test. We keep `self` typed loosely to avoid pulling the `WebWorker`
// lib into every file that transitively imports this module.
interface WorkerScope {
  importScripts?: unknown;
  postMessage(data: unknown, transfer?: ArrayBuffer[]): void;
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
}
const workerScope = typeof self !== 'undefined' ? (self as unknown as WorkerScope) : null;
const isWorkerScope =
  workerScope !== null &&
  typeof workerScope.importScripts !== 'undefined' &&
  typeof workerScope.postMessage === 'function' &&
  typeof window === 'undefined';

if (isWorkerScope && workerScope) {
  workerScope.addEventListener('message', (event: MessageEvent) => {
    const req = event.data as GlbDecodeRequest | undefined;
    if (!req || req.type !== 'decode') return;
    void (async () => {
      try {
        const res = await fetch(req.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const decoded = await decodeSceneryGlb(bytes, req.applyVegetationGain);
        const transfers: ArrayBuffer[] = [
          decoded.positions.buffer as ArrayBuffer,
          decoded.normals.buffer as ArrayBuffer,
          decoded.indices.buffer as ArrayBuffer,
        ];
        const colorBuf = decoded.colors.buffer as ArrayBuffer;
        if (!transfers.includes(colorBuf)) transfers.push(colorBuf);
        const payload: GlbDecodeOk = {
          type: 'ok',
          requestId: req.requestId,
          id: req.id,
          positions: decoded.positions.buffer,
          normals: decoded.normals.buffer,
          indices: decoded.indices.buffer,
          indicesIs32: decoded.indices instanceof Uint32Array,
          colors: decoded.colors.buffer,
          baseColor: decoded.baseColor,
        };
        workerScope.postMessage(payload, transfers);
      } catch (err) {
        const payload: GlbDecodeErr = {
          type: 'err',
          requestId: req.requestId,
          id: req.id,
          message: err instanceof Error ? err.message : String(err),
        };
        workerScope.postMessage(payload);
      }
    })();
  });
}
