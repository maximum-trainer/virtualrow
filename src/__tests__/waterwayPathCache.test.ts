import { describe, expect, it, vi } from 'vitest';
import { WaterwayPathCache, cachedWaterwayProvider } from '../lib/services/waterwayPathCache';
import { ROUTE_ENRICHMENT_CACHE_TTL_MS } from '../lib/services/routeEnrichmentService';

const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
};

const PATH = [
  { lat: 52.2, lng: 0.12 },
  { lat: 52.21, lng: 0.13 },
  { lat: 52.22, lng: 0.15 },
];

describe('waterway path cache (#750 FR6)', () => {
  it('keeps a path per course id for seven days', () => {
    const storage = memoryStorage();
    let now = 1_000;
    const cache = new WaterwayPathCache(() => storage, () => now);
    cache.set('171', PATH);
    expect(cache.get('171')).toEqual(PATH);
    expect(cache.get('172')).toBeNull();
    now += ROUTE_ENRICHMENT_CACHE_TTL_MS + 1;
    expect(cache.get('171')).toBeNull();
  });

  it('reads nothing from a corrupt or missing store', () => {
    const storage = memoryStorage();
    storage.setItem('virtualrow:waterway-path:v1:9', '{not json');
    expect(new WaterwayPathCache(() => storage).get('9')).toBeNull();
    expect(new WaterwayPathCache(() => null).get('9')).toBeNull();
    expect(() => new WaterwayPathCache(() => null).set('9', PATH)).not.toThrow();
  });

  it('answers a second lookup for the same course without asking the provider', async () => {
    const cache = new WaterwayPathCache(() => memoryStorage(), () => 0);
    const storage = memoryStorage();
    const shared = new WaterwayPathCache(() => storage, () => 0);
    const findPath = vi.fn().mockResolvedValue(PATH);
    const provider = cachedWaterwayProvider({ findPath }, '171', shared);
    expect(await provider.findPath([PATH[0], PATH[2]])).toEqual(PATH);
    expect(await provider.findPath([PATH[0], PATH[2]])).toEqual(PATH);
    expect(findPath).toHaveBeenCalledTimes(1);
    expect(cache.get('171')).toBeNull();
  });

  it('does not cache a lookup that found nothing', async () => {
    const storage = memoryStorage();
    const cache = new WaterwayPathCache(() => storage, () => 0);
    const findPath = vi.fn().mockResolvedValue(null);
    const provider = cachedWaterwayProvider({ findPath }, '5', cache);
    expect(await provider.findPath([PATH[0], PATH[2]])).toBeNull();
    expect(await provider.findPath([PATH[0], PATH[2]])).toBeNull();
    expect(findPath).toHaveBeenCalledTimes(2);
  });
});
