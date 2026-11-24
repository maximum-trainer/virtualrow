import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';

import Harness from './fixtures/LandCrossingNoticeHarness.svelte';
import type { Services } from '../lib/ports';
import type { WaterRoute } from '../lib/types/index';

const CROSSING = {
  fromGate: 'Start',
  toGate: 'Finish',
  metres: 304,
  from: { lat: 52, lng: 0 },
  to: { lat: 52.01, lng: 0 },
};
const route = (extra: Partial<WaterRoute> = {}) =>
  ({
    id: 'r1',
    name: 'Neck Head',
    source: 'rownative',
    externalId: '900',
    geometrySource: 'gate-chain',
    coordinates: [CROSSING.from, CROSSING.to],
    landCrossings: [CROSSING],
    ...extra,
  }) as unknown as WaterRoute;

const services = (attachTrack = vi.fn()) =>
  ({ rownativeService: { attachTrack } as unknown as Services['rownativeService'] }) as Partial<Services>;

// #752 FR2: the route card says where the line crosses land, and offers the fix.
describe('LandCrossingNotice.svelte', () => {
  it('names the gates and the distance, beside an Attach track action', () => {
    render(Harness, { overrides: services(), route: route(), onRouteImported: vi.fn() });

    expect(screen.getByTestId('route-land-crossing').textContent).toContain(
      'Crosses land between Start and Finish (300 m)',
    );
    expect(screen.getByLabelText('Attach a track to Neck Head')).toBeTruthy();
    expect(screen.getByText('Attach track')).toBeTruthy();
  });

  it('attaches the picked file to the course and hands back the new route', async () => {
    const traced = route({ id: 'r2', geometrySource: 'track', landCrossings: undefined });
    const attachTrack = vi.fn(async () => ({ track: { fileName: 'neck.gpx' }, route: traced }));
    const onRouteImported = vi.fn();
    render(Harness, { overrides: services(attachTrack), route: route(), onRouteImported });

    const file = new File(['<gpx></gpx>'], 'neck.gpx', { type: 'application/gpx+xml' });
    await fireEvent.change(screen.getByLabelText('Attach a track to Neck Head'), { target: { files: [file] } });

    await waitFor(() => expect(onRouteImported).toHaveBeenCalledWith(traced));
    expect(attachTrack).toHaveBeenCalledWith('900', 'neck.gpx', '<gpx></gpx>');
  });

  it('shows the reason when the track is refused', async () => {
    const attachTrack = vi.fn(async () => {
      throw new Error('That track misses Finish by 900 m.');
    });
    render(Harness, { overrides: services(attachTrack), route: route(), onRouteImported: vi.fn() });

    const file = new File(['x'], 'bad.gpx');
    await fireEvent.change(screen.getByLabelText('Attach a track to Neck Head'), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('misses Finish by 900 m'));
  });

  it('shows nothing on a course with no crossing, or with a real line (FR4)', () => {
    const { container } = render(Harness, {
      overrides: services(),
      route: route({ landCrossings: [] }),
      onRouteImported: vi.fn(),
    });
    expect(container.querySelector('[data-testid="route-land-crossing"]')).toBeNull();

    const traced = render(Harness, {
      overrides: services(),
      route: route({ geometrySource: 'track' }),
      onRouteImported: vi.fn(),
    });
    expect(traced.container.querySelector('[data-testid="route-land-crossing"]')).toBeNull();
  });
});
