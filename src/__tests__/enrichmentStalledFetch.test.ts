/**
 * #493 AC11 (NFR4) — a stalled Overpass fetch does not block the frame loop.
 *
 * `RouteEnrichmentService.enrichRoute` runs its network work on microtasks, so
 * a fetch that never resolves cannot stall synchronous ticks. This spec stands
 * in for the physics-tick drift bound: with a stalled fetch open, scheduled
 * tasks (setTimeout) continue to fire at their nominal cadence.
 */
import { describe, expect, it } from 'vitest';
import { RouteEnrichmentService } from '../lib/services/routeEnrichmentService';
import type { WaterRoute } from '../lib/types/index';

const route = {
  id: 'stall-1',
  coordinates: [
    { lat: 51.5, lng: -0.11 },
    { lat: 51.5005, lng: -0.11 },
  ],
} as unknown as WaterRoute;

const inlineRunner = async () => ({
  samples: [],
  detected: { waterBodyType: 'unknown' as const, shares: {} as never },
  lakes: [],
});

describe('#493 AC11 — stalled Overpass fetch leaves the tick loop alive', () => {
  it('does not block setTimeout callbacks for at least 5 "frames"', async () => {
    const stalledFetch: typeof fetch = () => new Promise<Response>(() => {});
    const service = new RouteEnrichmentService(stalledFetch, null, inlineRunner as never);

    const pending = service.enrichRoute(route);
    // The returned promise is intentionally orphaned for this test — the fetch
    // never resolves, so no handler fires. The point is that the surrounding
    // event loop keeps running.
    void pending;

    const ticks: number[] = [];
    const start = performance.now();
    await new Promise<void>((resolve) => {
      let count = 0;
      const tick = () => {
        ticks.push(performance.now() - start);
        count += 1;
        if (count >= 5) resolve();
        else setTimeout(tick, 16);
      };
      setTimeout(tick, 16);
    });

    expect(ticks).toHaveLength(5);
    // Each tick is nominally 16 ms; allow generous slack for a loaded CI box.
    for (let i = 1; i < ticks.length; i += 1) {
      expect(ticks[i] - ticks[i - 1]).toBeLessThan(200);
    }
  });
});
