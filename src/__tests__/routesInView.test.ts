import { describe, expect, it } from 'vitest';
import { routesInView, type ViewBbox } from '../lib/utils/routesInView';
import type { WaterRoute } from '../lib/types/index';

const route = (id: string, lat: number, lng: number): WaterRoute => ({
  id,
  name: id,
  description: '',
  distance: 1,
  difficulty: 'easy',
  location: '',
  coordinates: [
    { lat, lng },
    { lat: lat + 0.002, lng: lng + 0.002 },
  ],
  elevationGain: 0,
  estimatedTime: 5,
  tags: [],
  createdAt: new Date(0),
});

const preview = (id: string, lat: number, lng: number) => ({ id, name: id, lat, lng });

const STONEHAVEN: ViewBbox = [-2.22, 56.95, -2.18, 56.97];

describe('routesInView (#822)', () => {
  it('keeps routes and previews whose centroid is inside the view', () => {
    const out = routesInView(
      [route('in', 56.96, -2.2), route('out', 51.5, -0.1)],
      [preview('rn-in', 56.961, -2.201), preview('rn-out', -33.8, 151.2)],
      STONEHAVEN,
    );
    expect(out.routes.map((r) => r.id)).toEqual(['in']);
    expect(out.previews.map((p) => p.id)).toEqual(['rn-in']);
  });

  it('drops a preview the user has already imported (it shows as a route)', () => {
    const out = routesInView(
      [route('dup', 56.96, -2.2)],
      [preview('dup', 56.96, -2.2)],
      STONEHAVEN,
    );
    expect(out.routes.map((r) => r.id)).toEqual(['dup']);
    expect(out.previews).toEqual([]);
  });

  it('handles a view that crosses the antimeridian', () => {
    const out = routesInView(
      [],
      [preview('fiji', -17.7, 178.0), preview('samoa', -13.8, -172.1), preview('perth', -31.9, 115.8)],
      [170, -30, -170, 0],
    );
    expect(out.previews.map((p) => p.id).sort()).toEqual(['fiji', 'samoa']);
  });

  it('sorts previews by name so the list is stable as the map pans', () => {
    const out = routesInView(
      [],
      [preview('b', 56.96, -2.2), preview('a', 56.962, -2.2)],
      STONEHAVEN,
    );
    expect(out.previews.map((p) => p.id)).toEqual(['a', 'b']);
  });
});
