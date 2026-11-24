/**
 * #750 VP-27 — the route catalogue follows a rownative course's line as the
 * background waterway lookup refines it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoutesStore, canRefreshGeometry } from '../lib/ui/routesStore.svelte';
import type { Services } from '../lib/ports';
import type { WaterRoute } from '../lib/types/index';
import type { RownativeGeometryEvent } from '../lib/services/rownativeService';

const route = (id: string, over: Partial<WaterRoute> = {}): WaterRoute =>
  ({
    id,
    name: `River ${id}`,
    location: 'UK',
    distance: 2,
    estimatedTime: 30,
    difficulty: 'easy',
    coordinates: [],
    tags: [],
    source: 'rownative',
    externalId: `c${id}`,
    geometrySource: 'gate-chain',
    ...over,
  }) as unknown as WaterRoute;

const setup = (routes: WaterRoute[]) => {
  let listener: ((e: RownativeGeometryEvent) => void) | undefined;
  let hold: ((id: string) => boolean) | undefined;
  const rownative = {
    onGeometryEvent: vi.fn((l: (e: RownativeGeometryEvent) => void) => {
      listener = l;
      return () => {};
    }),
    setGeometryHold: vi.fn((h: (id: string) => boolean) => {
      hold = h;
    }),
    releaseHeldGeometry: vi.fn(),
    refreshGeometry: vi.fn(async (id: string) => routes.find((r) => r.id === id) ?? null),
  };
  const enrichment = {
    readCached: vi.fn(() => ({ data: null, stale: false })),
    enrichRoute: vi.fn(async () => ({}) as never),
    clearCache: vi.fn(),
  };
  const services = {
    routeService: { getAllRoutes: vi.fn(() => [...routes]), getRouteById: vi.fn() },
    routeEnrichmentService: enrichment,
    defaultRoutePreferenceStore: {
      resolveDefaultRouteId: vi.fn(() => null),
      setDefaultRouteId: vi.fn(),
      clearDefaultRouteId: vi.fn(),
    },
    rownativeService: rownative,
  } as unknown as Services;
  const store = new RoutesStore(services);
  store.load();
  return { store, rownative, enrichment, emit: (e: RownativeGeometryEvent) => listener!(e), hold: (id: string) => hold!(id) };
};

describe('RoutesStore and the background waterway lookup (#750)', () => {
  beforeEach(() => window.localStorage.clear());

  it('shows a route as tracing until its lookup settles (FR3)', () => {
    const { store, emit } = setup([route('a')]);
    emit({ kind: 'tracing', routeId: 'a' });
    expect(store.routeTracing.a).toBe(true);
    emit({ kind: 'settled', routeId: 'a' });
    expect(store.routeTracing.a).toBe(false);
  });

  it('reloads the list and re-reads the map data when a line is replaced (FR2, FR7)', () => {
    const a = route('a');
    const { store, emit, enrichment } = setup([a]);
    store.setAthlete('athlete');
    store.selectRoute(a);
    store.routeEnrichments = { a: { stale: true } as never };
    enrichment.enrichRoute.mockClear();

    emit({ kind: 'replaced', route: { ...a, geometrySource: 'osm-derived' } as WaterRoute });

    expect(enrichment.clearCache).toHaveBeenCalledWith('a');
    expect(store.routeEnrichments.a).toBeUndefined();
    expect(store.selectedRoute?.geometrySource).toBe('osm-derived');
    expect(enrichment.enrichRoute).toHaveBeenCalledTimes(1);
  });

  it('holds a new line for the route being rowed and releases it when the row ends (FR4)', () => {
    const a = route('a');
    const { store, rownative, hold } = setup([a, route('b')]);
    store.selectRoute(a);
    expect(hold('a')).toBe(false);
    store.setRowInProgress(true);
    expect(hold('a')).toBe(true);
    expect(hold('b')).toBe(false);
    store.setRowInProgress(false);
    expect(hold('a')).toBe(false);
    expect(rownative.releaseHeldGeometry).toHaveBeenCalledTimes(1);
  });

  it('offers "Refresh geometry" once per course, and runs it (FR5)', async () => {
    const a = route('a');
    const { store, rownative } = setup([a]);
    expect(store.showsRefreshOffer(a)).toBe(true);
    await store.refreshGeometry(a);
    expect(rownative.refreshGeometry).toHaveBeenCalledWith('a');
    expect(store.showsRefreshOffer(a)).toBe(false);
    // Remembered across a reload.
    expect(setup([a]).store.showsRefreshOffer(a)).toBe(false);
  });

  it('can turn the offer down', () => {
    const a = route('a');
    const { store } = setup([a]);
    store.dismissRefreshOffer(a);
    expect(store.showsRefreshOffer(a)).toBe(false);
  });
});

describe('canRefreshGeometry (#750 FR5)', () => {
  it('is offered for a rownative river course on its gate chain only', () => {
    expect(canRefreshGeometry(route('a'))).toBe(true);
    expect(canRefreshGeometry(route('a', { geometrySource: 'osm-derived' }))).toBe(false);
    expect(canRefreshGeometry(route('a', { source: undefined }))).toBe(false);
    expect(canRefreshGeometry(route('a', { name: 'Lake Regatta' }))).toBe(false);
  });
});
