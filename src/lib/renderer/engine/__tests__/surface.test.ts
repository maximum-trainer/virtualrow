// #731 VP-13 — the canvas backing store follows the device pixel ratio.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backingSizeFor, backingSizeForObserved, observeCanvasSize } from '../surface';
import { tierCapsFor } from '../tierCaps';
import { attach } from '../attach';
import { resetWebGPUHealth } from '../health';
import { installGPUStub, makeMockAdapter, makeMockCanvas, makeMockGPU } from '../../__tests__/_mockWebGPU';
import { releaseTelemetry } from '../telemetry';

describe('backingSizeFor (FR1)', () => {
  it.each([
    [1, 'medium', 800, 450],
    [2, 'medium', 1200, 675],
    [2, 'high', 1600, 900],
    [3, 'basic', 800, 450],
  ] as const)('a 800x450 CSS canvas at dpr %s and %s is %sx%s', (dpr, tier, w, h) => {
    const size = backingSizeFor(800, 450, dpr, tierCapsFor(tier));
    expect([size.width, size.height]).toEqual([w, h]);
  });

  it('caps the ratio per tier: 1 / 1 / 1.5 / 2 / 2', () => {
    const ratios = (['basic', 'low', 'medium', 'high', 'extra-high'] as const).map((t) => tierCapsFor(t).maxPixelRatio);
    expect(ratios).toEqual([1, 1, 1.5, 2, 2]);
  });

  it('lowers the scale to the pixel ceiling, never below the CSS size', () => {
    // 1920x1080 at dpr 2 on medium wants 1.5x = 4.7 MP; the ceiling is 2.1 MP.
    const medium = backingSizeFor(1920, 1080, 2, tierCapsFor('medium'));
    expect(medium.width * medium.height).toBeLessThanOrEqual(tierCapsFor('medium').maxBackingPixels);
    expect(medium.scale).toBeGreaterThanOrEqual(1);
    expect(medium.width / medium.height).toBeCloseTo(1920 / 1080, 2);
    // A 2560x1440 monitor at dpr 1 is over the medium ceiling but keeps 1x.
    const big = backingSizeFor(2560, 1440, 1, tierCapsFor('medium'));
    expect([big.width, big.height, big.scale]).toEqual([2560, 1440, 1]);
  });

  it('follows a dpr below 1 (zoomed out) and ignores a bad one', () => {
    expect(backingSizeFor(800, 400, 0.5, tierCapsFor('high'))).toMatchObject({ width: 400, height: 200 });
    expect(backingSizeFor(800, 400, Number.NaN, tierCapsFor('high'))).toMatchObject({ width: 800, height: 400 });
  });
});

describe('backingSizeForObserved (FR2)', () => {
  it('takes the exact device-pixel box when the scale is the full dpr', () => {
    const size = backingSizeForObserved(
      { cssWidth: 800.4, cssHeight: 450.2, devicePixels: { width: 1001, height: 563 } },
      1.25,
      tierCapsFor('medium'),
    );
    expect([size.width, size.height]).toEqual([1001, 563]);
  });

  it('scales the CSS box when the tier caps the ratio', () => {
    const size = backingSizeForObserved(
      { cssWidth: 800, cssHeight: 450, devicePixels: { width: 2400, height: 1350 } },
      3,
      tierCapsFor('medium'),
    );
    expect([size.width, size.height]).toEqual([1200, 675]);
  });
});

describe('observeCanvasSize (FR2)', () => {
  it('reports the device-pixel box from a ResizeObserver, and disconnects', () => {
    const calls: unknown[] = [];
    let disconnected = false;
    let observedBox: string | undefined;
    let fire: ((entries: unknown[]) => void) | null = null;
    const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      constructor(cb: (entries: unknown[]) => void) {
        fire = cb;
      }
      observe(_el: unknown, opts?: { box?: string }) {
        observedBox = opts?.box;
      }
      disconnect() {
        disconnected = true;
      }
    };
    try {
      const stop = observeCanvasSize({} as HTMLCanvasElement, (size) => calls.push(size));
      expect(observedBox).toBe('device-pixel-content-box');
      fire!([
        {
          contentRect: { width: 1, height: 1 },
          contentBoxSize: [{ inlineSize: 640, blockSize: 360 }],
          devicePixelContentBoxSize: [{ inlineSize: 1280, blockSize: 720 }],
        },
      ]);
      expect(calls).toEqual([{ cssWidth: 640, cssHeight: 360, devicePixels: { width: 1280, height: 720 } }]);
      stop();
      expect(disconnected).toBe(true);
    } finally {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
    }
  });

  it('does nothing where there is no ResizeObserver', () => {
    const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = undefined;
    try {
      expect(() => observeCanvasSize({} as HTMLCanvasElement, () => undefined)()).not.toThrow();
    } finally {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
    }
  });
});

describe('the engine sizes its canvas by the dpr (FR1, FR4)', () => {
  const g = globalThis as unknown as { devicePixelRatio?: number; __ROWER3D_SURFACE?: unknown };
  let dpr: number | undefined;
  beforeEach(() => {
    installGPUStub(makeMockGPU(makeMockAdapter()));
    resetWebGPUHealth();
    dpr = g.devicePixelRatio;
  });
  afterEach(() => {
    g.devicePixelRatio = dpr;
    installGPUStub(undefined);
    releaseTelemetry();
  });

  it('backs a 320x240 canvas at dpr 2 on high with 640x480 and publishes __ROWER3D_SURFACE', async () => {
    g.devicePixelRatio = 2;
    const canvas = makeMockCanvas();
    const renderer = (await attach(canvas, { testMode: true, tier: 'high' })) as unknown as {
      _frameOnce: () => void;
      dispose(): void;
    };
    renderer._frameOnce();
    expect([canvas.width, canvas.height]).toEqual([640, 480]);
    expect((globalThis as unknown as { window: { __ROWER3D_SURFACE?: unknown } }).window.__ROWER3D_SURFACE).toEqual({
      cssWidth: 320,
      cssHeight: 240,
      devicePixelRatio: 2,
      scale: 2,
      width: 640,
      height: 480,
      antialias: tierCapsFor('high').antialias,
    });
    // The window grows: the backing store follows, from the CSS size.
    (canvas as unknown as { clientWidth: number }).clientWidth = 400;
    renderer._frameOnce();
    expect([canvas.width, canvas.height]).toEqual([800, 480]);
    renderer.dispose();
  });
});
