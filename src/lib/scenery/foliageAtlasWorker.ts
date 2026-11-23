/**
 * #729 FR2 — paints the foliage atlas in a Worker (see `foliageAtlasPaint`)
 * and transfers the packed mip levels back.
 */
import {
  paintFoliageAtlas,
  type FoliageAtlasPaintRequest,
  type FoliageAtlasPaintResponse,
} from './foliageAtlasPaint';

interface WorkerScope {
  postMessage(data: unknown, transfer?: ArrayBuffer[]): void;
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
}

const scope = self as unknown as WorkerScope;
scope.addEventListener('message', (event: MessageEvent) => {
  const req = event.data as FoliageAtlasPaintRequest | undefined;
  if (req?.type !== 'paint') return;
  try {
    const atlas = paintFoliageAtlas(req.size);
    const reply: FoliageAtlasPaintResponse = { type: 'ok', atlas };
    scope.postMessage(
      reply,
      atlas.mips.map((m) => m.pixels.buffer as ArrayBuffer),
    );
  } catch (err) {
    const reply: FoliageAtlasPaintResponse = {
      type: 'err',
      message: err instanceof Error ? err.message : String(err),
    };
    scope.postMessage(reply);
  }
});
