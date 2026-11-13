import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createGlbDecoderPool } from '../glbDecoderPool';
import { VEGETATION_ALBEDO_GAIN } from '../../renderer/engine/sceneryMeshBuffers';

const readAsset = (file: string): Uint8Array =>
  new Uint8Array(readFileSync(path.join(process.cwd(), 'public/assets/scenery', file)));

const fetchFromDisk: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : (input as URL).toString();
  // Pool paths look like `/assets/scenery/tier-x/foo.glb`; strip the base prefix.
  const marker = '/assets/scenery/';
  const idx = url.indexOf(marker);
  if (idx < 0) throw new Error(`unexpected test URL: ${url}`);
  const rel = url.slice(idx + marker.length);
  const bytes = readAsset(rel);
  // Copy so each test gets a fresh buffer — `decode` detaches on the worker
  // path, and we want the inline path to behave the same for the test.
  const copy = new Uint8Array(bytes);
  return new Response(copy, { status: 200 });
};

describe('createGlbDecoderPool (inline fallback)', () => {
  it('fetches a scenery GLB and returns the merged mesh', async () => {
    const pool = createGlbDecoderPool({ fetchImpl: fetchFromDisk });
    const decoded = await pool.decode(
      'a01-buoy-lane-sphere',
      '/assets/scenery/tier-a/a01-buoy-lane-sphere.glb',
      false,
    );
    expect(decoded.positions.length).toBeGreaterThan(0);
    expect(decoded.normals.length).toBe(decoded.positions.length);
    expect(decoded.colors.length).toBe((decoded.positions.length / 3) * 4);
    expect(decoded.indices.length % 3).toBe(0);
    expect(decoded.baseColor).toHaveLength(4);
  });

  it('applies the vegetation gain in-worker when requested', async () => {
    const pool = createGlbDecoderPool({ fetchImpl: fetchFromDisk });
    // Pick any tier-a asset — the gain path is independent of the tier,
    // scaleMeshColors just multiplies RGB. Compare un-gained vs gained.
    const url = '/assets/scenery/tier-a/a01-buoy-lane-sphere.glb';
    const plain = await pool.decode('x', url, false);
    const gained = await pool.decode('y', url, true);
    expect(gained.colors.length).toBe(plain.colors.length);
    // Spot-check: RGB channels are scaled by the gain, alpha is preserved.
    for (let i = 0; i + 3 < plain.colors.length; i += 4) {
      expect(gained.colors[i]).toBeCloseTo(plain.colors[i] * VEGETATION_ALBEDO_GAIN, 5);
      expect(gained.colors[i + 1]).toBeCloseTo(plain.colors[i + 1] * VEGETATION_ALBEDO_GAIN, 5);
      expect(gained.colors[i + 2]).toBeCloseTo(plain.colors[i + 2] * VEGETATION_ALBEDO_GAIN, 5);
      expect(gained.colors[i + 3]).toBe(plain.colors[i + 3]);
    }
  });

  it('rejects when the fetch returns non-OK', async () => {
    const pool = createGlbDecoderPool({
      fetchImpl: async () => new Response(null, { status: 404 }),
    });
    await expect(pool.decode('missing', '/any', false)).rejects.toThrow(/404/);
  });
});

describe('createGlbDecoderPool (worker-backed)', () => {
  it('routes decode + response through the Worker and rebuilds the typed arrays', async () => {
    // Stand up a stub Worker that replies as the real worker would: with
    // transferred ArrayBuffers wrapped by `indicesIs32`. The stub reuses
    // the inline decoder so the pipeline matches the production worker.
    const pool = createGlbDecoderPool({
      workerFactory: () => new StubWorker(),
    });
    const decoded = await pool.decode(
      'a01-buoy-lane-sphere',
      '/assets/scenery/tier-a/a01-buoy-lane-sphere.glb',
      false,
    );
    expect(decoded.positions.length).toBeGreaterThan(0);
    expect(decoded.colors.length).toBe((decoded.positions.length / 3) * 4);
    expect(decoded.indices instanceof Uint16Array || decoded.indices instanceof Uint32Array).toBe(
      true,
    );
    pool.dispose();
  });

  it('rejects pending requests when the worker emits an error event', async () => {
    const pool = createGlbDecoderPool({
      workerFactory: () => new ThrowingWorker(),
    });
    await expect(pool.decode('x', '/assets/scenery/tier-a/anything.glb', false)).rejects.toThrow();
    pool.dispose();
  });
});

type MessageHandler = (event: MessageEvent) => void;

class StubWorker implements Worker {
  onmessage: ((this: Worker, ev: MessageEvent) => unknown) | null = null;
  onmessageerror: ((this: Worker, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: AbstractWorker, ev: ErrorEvent) => unknown) | null = null;
  private listeners: MessageHandler[] = [];

  addEventListener(type: string, listener: EventListener | EventListenerObject): void {
    if (type === 'message') this.listeners.push(listener as MessageHandler);
  }
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return false;
  }
  terminate(): void {}

  postMessage(message: unknown): void {
    const req = message as { requestId: number; id: string; url: string; applyVegetationGain: boolean };
    void (async () => {
      try {
        const bytes = readAsset(req.url.split('/assets/scenery/')[1]);
        const { decodeSceneryGlb } = await import('../glbDecodeWorker');
        const decoded = await decodeSceneryGlb(bytes, req.applyVegetationGain);
        const data = {
          type: 'ok' as const,
          requestId: req.requestId,
          id: req.id,
          positions: decoded.positions.buffer,
          normals: decoded.normals.buffer,
          indices: decoded.indices.buffer,
          indicesIs32: decoded.indices instanceof Uint32Array,
          colors: decoded.colors.buffer,
          baseColor: decoded.baseColor,
        };
        this.dispatch({ data } as MessageEvent);
      } catch (err) {
        const data = {
          type: 'err' as const,
          requestId: req.requestId,
          id: req.id,
          message: (err as Error).message,
        };
        this.dispatch({ data } as MessageEvent);
      }
    })();
  }
  private dispatch(event: MessageEvent): void {
    for (const l of this.listeners) l(event);
    this.onmessage?.(event);
  }
}

class ThrowingWorker implements Worker {
  onmessage = null;
  onmessageerror = null;
  onerror = null;
  private errorListeners: ((event: ErrorEvent) => void)[] = [];
  addEventListener(type: string, listener: EventListener | EventListenerObject): void {
    if (type === 'error') this.errorListeners.push(listener as (event: ErrorEvent) => void);
  }
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return false;
  }
  terminate(): void {}
  postMessage(): void {
    setTimeout(() => {
      const event = new ErrorEvent('error', { message: 'simulated worker crash' });
      for (const l of this.errorListeners) l(event);
    }, 0);
  }
}
