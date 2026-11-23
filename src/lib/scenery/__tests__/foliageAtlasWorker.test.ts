import { describe, expect, it, vi } from 'vitest';
import { FOLIAGE_SHAPES, FOLIAGE_VARIANT_COUNT } from '../foliageTexture';

// #729 FR2 — the worker paints on request and transfers the packed levels.
describe('foliageAtlasWorker (#729 FR2)', () => {
  it('answers a paint request with every level, transferring their buffers', async () => {
    let onMessage: ((e: MessageEvent) => void) | null = null;
    const postMessage = vi.fn();
    const fakeScope = {
      addEventListener: (type: string, handler: (e: MessageEvent) => void) => {
        if (type === 'message') onMessage = handler;
      },
      postMessage,
    };
    const realSelf = globalThis.self;
    Object.defineProperty(globalThis, 'self', { configurable: true, value: fakeScope });
    try {
      vi.resetModules();
      await import('../foliageAtlasWorker');
      onMessage!({ data: { type: 'ignored' } } as MessageEvent);
      expect(postMessage).not.toHaveBeenCalled();
      onMessage!({ data: { type: 'paint', size: 8 } } as MessageEvent);
      expect(postMessage).toHaveBeenCalledOnce();
      const [reply, transfer] = postMessage.mock.calls[0];
      expect(reply.type).toBe('ok');
      expect(reply.atlas.layers).toBe(FOLIAGE_SHAPES.length * FOLIAGE_VARIANT_COUNT);
      expect(reply.atlas.mips.map((m: { size: number }) => m.size)).toEqual([8, 4, 2, 1]);
      expect(transfer).toHaveLength(4);
    } finally {
      Object.defineProperty(globalThis, 'self', { configurable: true, value: realSelf });
    }
  });
});
