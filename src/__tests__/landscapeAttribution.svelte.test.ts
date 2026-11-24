import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';

import LandscapeAttribution from '../lib/ui/LandscapeAttribution.svelte';
import type { Landscape, LandscapeSource } from '../lib/services/landscapeService';

const landscape = (elevation: LandscapeSource, landCover: LandscapeSource, built: LandscapeSource): Landscape => ({
  origin: { lat: 0, lng: 0 },
  key: 'k',
  elevation: { source: elevation, ms: 0, count: 0, data: null },
  landCover: { source: landCover, ms: 0, count: 0, data: null },
  built: { source: built, ms: 0, count: 0, data: null },
});

// #762 FR8
describe('LandscapeAttribution', () => {
  it('credits OSM and the elevation source while their layers are in use', () => {
    render(LandscapeAttribution, { landscape: landscape('network', 'cache', 'unavailable') });
    const text = screen.getByTestId('landscape-attribution').textContent ?? '';
    expect(text).toContain('© OpenStreetMap contributors');
    expect(text).toContain('Copernicus DEM');
  });

  it('credits only OSM when the terrain is unavailable', () => {
    render(LandscapeAttribution, { landscape: landscape('unavailable', 'unavailable', 'network') });
    const text = screen.getByTestId('landscape-attribution').textContent ?? '';
    expect(text).toBe('© OpenStreetMap contributors');
  });

  it('shows nothing while every layer is unavailable, or before any landscape', () => {
    render(LandscapeAttribution, { landscape: landscape('unavailable', 'unavailable', 'unavailable') });
    render(LandscapeAttribution, { landscape: null });
    expect(screen.queryByTestId('landscape-attribution')).toBeNull();
  });
});
