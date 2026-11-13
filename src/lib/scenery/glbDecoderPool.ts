/**
 * Thin client around `glbDecodeWorker`.
 *
 * `createGlbDecoderPool` picks between a Worker-backed decoder and an inline
 * fallback. In the browser it dynamically imports the worker chunk and sends
 * one request at a time per worker (the ride loop caps concurrent streams at
 * `SCENERY_MAX_PER_TICK`, so one worker is plenty; the pool can be grown
 * later if the stream rate rises). In SSR and jsdom tests `Worker` is
 * undefined — the pool falls back to `decodeSceneryGlb` on the current
 * thread, which keeps the tests fast and the renderer code unchanged.
 */

import {
  decodeSceneryGlb,
  type GlbDecodeRequest,
  type GlbDecodeResponse,
} from './glbDecodeWorker';

export interface DecodedScenery {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint16Array | Uint32Array;
  colors: Float32Array;
  baseColor: [number, number, number, number];
}

export interface GlbDecoderPool {
  decode(id: string, url: string, applyVegetationGain: boolean): Promise<DecodedScenery>;
  dispose(): void;
}

export interface GlbDecoderPoolOptions {
  /**
   * Factory for the worker — the renderer passes
   * `() => new GlbDecodeWorker()` built from Vite's `?worker` import. Omit
   * in tests and SSR to force the inline path.
   */
  workerFactory?: () => Worker;
  /**
   * Overrides `fetch` on the inline path. Only used when the worker is not
   * available; the worker fetches inside its own realm.
   */
  fetchImpl?: typeof fetch;
}

export const createGlbDecoderPool = (
  opts: GlbDecoderPoolOptions = {},
): GlbDecoderPool => {
  // An explicit `workerFactory` opts in (prod callers pass one built from the
  // `?worker` import; tests can pass a stub). Without one we take the inline
  // path — SSR and jsdom do not ship `Worker`, and the ride loop stays
  // identical to the pre-worker behaviour.
  if (opts.workerFactory) {
    return createWorkerPool(opts.workerFactory);
  }
  return createInlinePool(opts.fetchImpl);
};

const createWorkerPool = (factory: () => Worker): GlbDecoderPool => {
  let worker: Worker | null = null;
  let nextRequestId = 1;
  const pending = new Map<
    number,
    { resolve: (mesh: DecodedScenery) => void; reject: (err: Error) => void }
  >();

  const ensure = (): Worker => {
    if (worker) return worker;
    const w = factory();
    w.addEventListener('message', (event: MessageEvent<GlbDecodeResponse>) => {
      const msg = event.data;
      if (!msg) return;
      const slot = pending.get(msg.requestId);
      if (!slot) return;
      pending.delete(msg.requestId);
      if (msg.type === 'ok') {
        slot.resolve({
          positions: new Float32Array(msg.positions),
          normals: new Float32Array(msg.normals),
          indices: msg.indicesIs32
            ? new Uint32Array(msg.indices)
            : new Uint16Array(msg.indices),
          colors: new Float32Array(msg.colors),
          baseColor: msg.baseColor,
        });
      } else {
        slot.reject(new Error(msg.message));
      }
    });
    w.addEventListener('error', (event) => {
      const err = new Error(event.message || 'scenery decode worker error');
      for (const slot of pending.values()) slot.reject(err);
      pending.clear();
      worker?.terminate();
      worker = null;
    });
    worker = w;
    return w;
  };

  return {
    decode(id, url, applyVegetationGain) {
      return new Promise<DecodedScenery>((resolve, reject) => {
        const requestId = nextRequestId++;
        pending.set(requestId, { resolve, reject });
        const req: GlbDecodeRequest = {
          type: 'decode',
          requestId,
          id,
          url,
          applyVegetationGain,
        };
        try {
          ensure().postMessage(req);
        } catch (err) {
          pending.delete(requestId);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    dispose() {
      worker?.terminate();
      worker = null;
      for (const slot of pending.values()) {
        slot.reject(new Error('decoder pool disposed'));
      }
      pending.clear();
    },
  };
};

const createInlinePool = (fetchImpl?: typeof fetch): GlbDecoderPool => {
  const doFetch = fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  return {
    async decode(_id, url, applyVegetationGain) {
      if (!doFetch) throw new Error('fetch is not available for inline GLB decode');
      const res = await doFetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return decodeSceneryGlb(bytes, applyVegetationGain);
    },
    dispose() {
      /* inline pool holds no resources */
    },
  };
};
