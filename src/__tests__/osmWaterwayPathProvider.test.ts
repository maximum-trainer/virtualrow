import { describe, expect, it, vi } from 'vitest';
import type { Coordinate } from '../lib/types/index';
import { polylineLengthMeters } from '../lib/utils/coordinateUtils';
import { projectPointOntoPolyline } from '../lib/utils/polylineGeometry';
import { OsmWaterwayPathProvider } from '../lib/services/osmWaterwayPathProvider';

// #743. The first cut of this provider (issue #194 R-12) was shelved after a
// spike found a path on only 2 of 5 river courses. Every failure was the same:
// a gate snapped to the nearest mapped VERTEX, and on a long straight reach or
// wide water the nearest vertex is hundreds of metres from a gate that sits
// right on the river. These tests pin the fixes.

const ORIGIN = { lat: 52, lng: 0 };
const M_PER_DEG_LAT = 111_320;
const LNG_SCALE = M_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);
const at = (x: number, y: number): Coordinate => ({
  lat: ORIGIN.lat + y / M_PER_DEG_LAT,
  lng: ORIGIN.lng + x / LNG_SCALE,
});
const way = (...points: [number, number][]) => ({
  type: 'way',
  geometry: points.map(([x, y]) => {
    const c = at(x, y);
    return { lat: c.lat, lon: c.lng };
  }),
});

const overpass = (elements: unknown[], ok = true) => {
  const fetchMock = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 504,
    json: async () => ({ elements }),
  }));
  return {
    fetchMock,
    provider: new OsmWaterwayPathProvider(fetchMock as unknown as typeof fetch, { retryDelayMs: 1 }),
  };
};

/** A river mapped with few vertices: north 2 km, a bend, then east 2 km. */
const SPARSE_RIVER = way([0, 0], [0, 2000], [300, 2300], [2300, 2300]);

describe('OsmWaterwayPathProvider', () => {
  it('follows the river between two gates that sit between mapped vertices', async () => {
    const { provider } = overpass([SPARSE_RIVER]);
    // Both gates are on the water, 1 km from the nearest vertex.
    const start = at(10, 1000);
    const finish = at(1300, 2290);

    const path = await provider.findPath([start, finish]);

    expect(path).not.toBeNull();
    const length = polylineLengthMeters(path!);
    // Along the river: 1000 + 424 + 1000. The straight line is 1826 m.
    expect(length).toBeGreaterThan(2350);
    expect(length).toBeLessThan(2500);
    // It goes round the bend rather than across the land inside it.
    expect(projectPointOntoPolyline(at(0, 2000), path!).offsetMeters).toBeLessThan(5);
    // And it starts and ends at the gates, not somewhere up the bank.
    expect(projectPointOntoPolyline(start, path!).offsetMeters).toBeLessThan(15);
    expect(projectPointOntoPolyline(finish, path!).offsetMeters).toBeLessThan(15);
  });

  it('reaches a gate set out in wide water by leaving the centreline, without a spike', async () => {
    const { provider } = overpass([way([0, 0], [0, 3000])]);
    // A finish line 220 m off the mapped centreline, as on an estuary. The
    // gate itself is 200 m wide, so that is still plainly this water.
    const start = at(0, 100);
    const finish = at(220, 2800);

    const path = await provider.findPath([start, finish], { gateExtentsMeters: [30, 200] });

    expect(path).not.toBeNull();
    expect(path![path!.length - 1]).toEqual(finish);
    // Diagonal run-in: no doubling back along the centreline to a spur.
    const length = polylineLengthMeters(path!);
    expect(length).toBeLessThan(2700 + 220);
    expect(length).toBeGreaterThan(2700);
  });

  it('refuses a small gate that is nowhere near any waterway', async () => {
    const { provider } = overpass([way([0, 0], [0, 3000])]);
    const path = await provider.findPath([at(0, 100), at(220, 2800)], { gateExtentsMeters: [30, 30] });
    expect(path).toBeNull();
  });

  it('refuses to join gates on two waterways that do not connect', async () => {
    const { provider } = overpass([way([0, 0], [0, 2000]), way([500, 0], [500, 2000])]);
    expect(await provider.findPath([at(0, 500), at(500, 1500)])).toBeNull();
  });

  it('refuses a route that only connects by a long way round', async () => {
    // Two reaches 300 m apart that meet 6 km upstream: the "path" between the
    // gates would be 12 km for a 300 m crossing. That is the wrong waterway.
    const { provider } = overpass([way([0, 0], [0, 6000], [300, 6000], [300, 0])]);
    expect(await provider.findPath([at(0, 200), at(300, 200)])).toBeNull();
  });

  it('visits every gate in order on a multi-gate course', async () => {
    const { provider } = overpass([SPARSE_RIVER]);
    const gates = [at(0, 200), at(-8, 1500), at(900, 2300), at(2200, 2310)];

    const path = await provider.findPath(gates);

    expect(path).not.toBeNull();
    let lastAlong = -1;
    for (const gate of gates) {
      const hit = projectPointOntoPolyline(gate, path!);
      expect(hit.offsetMeters).toBeLessThan(15);
      expect(hit.alongMeters).toBeGreaterThan(lastAlong);
      lastAlong = hit.alongMeters;
    }
  });

  it('returns null on open water, where there is no waterway to follow', async () => {
    const { provider } = overpass([]);
    expect(await provider.findPath([at(0, 0), at(0, 2000)])).toBeNull();
  });

  it.each([
    ['a failed response', () => overpass([SPARSE_RIVER], false).provider],
    [
      'a network error',
      () =>
        new OsmWaterwayPathProvider((async () => {
          throw new TypeError('Failed to fetch');
        }) as unknown as typeof fetch),
    ],
  ])('returns null rather than throwing on %s', async (_label, make) => {
    await expect(make().findPath([at(10, 1000), at(1300, 2290)])).resolves.toBeNull();
  });

  it('asks Overpass once per set of gates', async () => {
    const { provider, fetchMock } = overpass([SPARSE_RIVER]);
    const gates = [at(10, 1000), at(1300, 2290)];
    await provider.findPath(gates);
    await provider.findPath(gates);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Measured on the public Overpass server, 2026-11-22: every waterway query
  // took 26-36 s, and a busy server answered 502 "at capacity" in 30 ms. The
  // original 8 s budget therefore never produced a path. The provider now
  // waits long enough and retries a busy answer, inside one overall budget.
  describe('a slow or busy map server', () => {
    const busy = { ok: false, status: 502, json: async () => ({}) };
    const good = { ok: true, status: 200, json: async () => ({ elements: [SPARSE_RIVER] }) };
    const gates = [at(10, 1000), at(1300, 2290)];

    it('retries when the server says it is at capacity', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(busy).mockResolvedValueOnce(busy).mockResolvedValueOnce(good);
      const provider = new OsmWaterwayPathProvider(fetchMock as unknown as typeof fetch, { retryDelayMs: 1 });

      expect(await provider.findPath(gates)).not.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('gives up after a few busy answers and falls through', async () => {
      const fetchMock = vi.fn().mockResolvedValue(busy);
      const provider = new OsmWaterwayPathProvider(fetchMock as unknown as typeof fetch, { retryDelayMs: 1 });

      expect(await provider.findPath(gates)).toBeNull();
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
    });

    it('does not retry an answer that will not change', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });
      const provider = new OsmWaterwayPathProvider(fetchMock as unknown as typeof fetch, { retryDelayMs: 1 });

      expect(await provider.findPath(gates)).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('waits for an answer that takes longer than the old 8 s budget', async () => {
      vi.useFakeTimers();
      try {
        const fetchMock = vi.fn(
          (_url: unknown, init?: RequestInit) =>
            new Promise((resolve, reject) => {
              const timer = setTimeout(() => resolve(good), 30_000);
              init?.signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new DOMException('aborted', 'AbortError'));
              });
            }),
        );
        const provider = new OsmWaterwayPathProvider(fetchMock as unknown as typeof fetch);
        const pending = provider.findPath(gates);
        await vi.advanceTimersByTimeAsync(31_000);
        expect(await pending).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops waiting once the overall budget is spent', async () => {
      vi.useFakeTimers();
      try {
        const fetchMock = vi.fn(
          (_url: unknown, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
            }),
        );
        const provider = new OsmWaterwayPathProvider(fetchMock as unknown as typeof fetch, { budgetMs: 5_000 });
        const pending = provider.findPath(gates);
        await vi.advanceTimersByTimeAsync(5_100);
        expect(await pending).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
