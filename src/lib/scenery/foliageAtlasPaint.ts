/**
 * #729 FR2 — paint the foliage sprite atlas off the main thread.
 *
 * The atlas is `FOLIAGE_SHAPES × FOLIAGE_VARIANT_COUNT` painted 256² layers
 * plus a full mip chain each. Painting it inline at attach was one of the
 * long main-thread tasks when a row starts. `paintFoliageAtlas` does the
 * same painting but packs every layer of a mip level into one array, so the
 * upload is one `writeTexture` per mip level; `createFoliageAtlasPainter`
 * runs it in `foliageAtlasWorker` where a Worker exists, and inline (SSR,
 * jsdom) where it does not.
 */
import { paintFoliage, FOLIAGE_SHAPES, FOLIAGE_VARIANT_COUNT } from './foliageTexture';
import { buildFoliageMips } from './foliageMips';

export interface FoliageAtlasLevel {
  /** Edge length of this level, in texels. */
  size: number;
  /** Every layer's RGBA texels, layer after layer. */
  pixels: Uint8Array;
}

export interface FoliageAtlas {
  layers: number;
  /** Level 0 first, down to 1×1. */
  mips: FoliageAtlasLevel[];
}

/** Layer `s * FOLIAGE_VARIANT_COUNT + v` is species `s`, variant `v`. */
export const paintFoliageAtlas = (size: number): FoliageAtlas => {
  const layers = FOLIAGE_SHAPES.length * FOLIAGE_VARIANT_COUNT;
  const sizes: number[] = [];
  for (let s = size; s >= 1; s = Math.floor(s / 2)) sizes.push(s);
  const mips = sizes.map((s) => ({ size: s, pixels: new Uint8Array(s * s * 4 * layers) }));
  for (let shape = 0; shape < FOLIAGE_SHAPES.length; shape += 1) {
    for (let v = 0; v < FOLIAGE_VARIANT_COUNT; v += 1) {
      const layer = shape * FOLIAGE_VARIANT_COUNT + v;
      const base = paintFoliage(FOLIAGE_SHAPES[shape], size, v);
      mips[0].pixels.set(base, layer * size * size * 4);
      const chain = buildFoliageMips(base, size);
      for (let m = 0; m < chain.length && m + 1 < mips.length; m += 1) {
        const level = mips[m + 1];
        level.pixels.set(chain[m].pixels, layer * level.size * level.size * 4);
      }
    }
  }
  return { layers, mips };
};

export interface FoliageAtlasPainter {
  paint(size: number): Promise<FoliageAtlas>;
  dispose(): void;
}

export interface FoliageAtlasPainterOptions {
  /** Builds the worker; omitted (SSR, jsdom) paints on the calling thread. */
  workerFactory?: () => Worker;
}

export interface FoliageAtlasPaintRequest {
  type: 'paint';
  size: number;
}

export type FoliageAtlasPaintResponse = { type: 'ok'; atlas: FoliageAtlas } | { type: 'err'; message: string };

export const createFoliageAtlasPainter = (opts: FoliageAtlasPainterOptions): FoliageAtlasPainter => {
  if (!opts.workerFactory) {
    return {
      paint: async (size) => paintFoliageAtlas(size),
      dispose: () => {},
    };
  }
  const factory = opts.workerFactory;
  let worker: Worker | null = null;
  return {
    paint: (size) =>
      new Promise<FoliageAtlas>((resolve, reject) => {
        try {
          const w = factory();
          worker = w;
          w.addEventListener('message', (event: MessageEvent<FoliageAtlasPaintResponse>) => {
            const msg = event.data;
            if (msg?.type === 'ok') resolve(msg.atlas);
            else reject(new Error(msg?.message ?? 'foliage atlas worker failed'));
            w.terminate();
            if (worker === w) worker = null;
          });
          w.addEventListener('error', (event: ErrorEvent) => {
            // A worker that cannot start still gets the atlas, inline.
            event.preventDefault?.();
            w.terminate();
            if (worker === w) worker = null;
            resolve(paintFoliageAtlas(size));
          });
          const req: FoliageAtlasPaintRequest = { type: 'paint', size };
          w.postMessage(req);
        } catch {
          resolve(paintFoliageAtlas(size));
        }
      }),
    dispose: () => {
      worker?.terminate();
      worker = null;
    },
  };
};
