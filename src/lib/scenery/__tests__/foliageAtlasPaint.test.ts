import { describe, expect, it } from 'vitest';
import { paintFoliage, FOLIAGE_SHAPES, FOLIAGE_VARIANT_COUNT } from '../foliageTexture';
import { buildFoliageMips } from '../foliageMips';
import { paintFoliageAtlas, createFoliageAtlasPainter } from '../foliageAtlasPaint';

// #729 FR2 — the foliage atlas is painted off the main thread and uploaded
// in one writeTexture per mip, every layer packed together.
describe('paintFoliageAtlas (#729 FR2)', () => {
  const size = 16;
  const layers = FOLIAGE_SHAPES.length * FOLIAGE_VARIANT_COUNT;

  it('packs every layer of every mip level, in layer order, matching the per-layer painter', () => {
    const atlas = paintFoliageAtlas(size);
    expect(atlas.layers).toBe(layers);
    expect(atlas.mips.map((m) => m.size)).toEqual([16, 8, 4, 2, 1]);
    for (const mip of atlas.mips) expect(mip.pixels.length).toBe(mip.size * mip.size * 4 * layers);

    // Layer s * variants + v is species s, variant v — the same bytes the
    // per-layer path uploaded.
    const s = 2;
    const v = 3;
    const layer = s * FOLIAGE_VARIANT_COUNT + v;
    const base = paintFoliage(FOLIAGE_SHAPES[s], size, v);
    const stride0 = size * size * 4;
    expect([...atlas.mips[0].pixels.subarray(layer * stride0, (layer + 1) * stride0)]).toEqual([...base]);
    const mip1 = buildFoliageMips(base, size)[0];
    const stride1 = 8 * 8 * 4;
    expect([...atlas.mips[1].pixels.subarray(layer * stride1, (layer + 1) * stride1)]).toEqual([...mip1.pixels]);
  });

  it('paints on the calling thread when no worker is available', async () => {
    const painter = createFoliageAtlasPainter({});
    const atlas = await painter.paint(size);
    expect(atlas.mips[0].pixels.length).toBe(size * size * 4 * layers);
    painter.dispose();
  });

  it('asks the worker to paint and returns its packed levels', async () => {
    const posted: unknown[] = [];
    let listener: ((e: MessageEvent) => void) | null = null;
    const worker = {
      addEventListener: (type: string, l: (e: MessageEvent) => void) => {
        if (type === 'message') listener = l;
      },
      postMessage: (msg: { size: number }) => {
        posted.push(msg);
        queueMicrotask(() => listener?.({ data: { type: 'ok', atlas: paintFoliageAtlas(msg.size) } } as MessageEvent));
      },
      terminate: () => {},
    } as unknown as Worker;
    const painter = createFoliageAtlasPainter({ workerFactory: () => worker });
    const atlas = await painter.paint(size);
    expect(posted).toEqual([{ type: 'paint', size }]);
    expect(atlas.mips).toHaveLength(5);
    painter.dispose();
  });
});
