import { render, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';

import RouteOverviewMap from '../lib/ui/RouteOverviewMap.svelte';
import type { WaterRoute } from '../lib/types/index';

// jsdom has no WebGL, so these drive the SVG-fallback path (#822 FR6 / AC7).
const preview = (id: string, name: string, lat: number, lng: number) => ({
  id,
  name,
  distanceMeters: 2500,
  lat,
  lng,
});

const route = (id: string, name: string, lat: number, lng: number): WaterRoute => ({
  id,
  name,
  description: '',
  distance: 4,
  difficulty: 'moderate',
  location: '',
  coordinates: [
    { lat, lng },
    { lat, lng },
  ],
  elevationGain: 0,
  estimatedTime: 20,
  tags: [],
  createdAt: new Date(0),
});

const STONEHAVEN = [
  preview('175', 'Stonehaven Return', 56.9605, -2.2015),
  preview('181', 'CCRC - Stonehaven Return', 56.9605, -2.2015),
];

function renderMap(props: Record<string, unknown> = {}) {
  const onSelect = vi.fn();
  const onRownativeSelect = vi.fn();
  const utils = render(RouteOverviewMap, {
    routes: [],
    defaultRouteId: null,
    selectedRouteId: null,
    rownativePreviews: STONEHAVEN,
    onSelect,
    onRownativeSelect,
    ...props,
  });
  return { ...utils, onSelect, onRownativeSelect };
}

const popup = (c: HTMLElement) => c.querySelector('[data-testid="route-chooser-popup"]');
const items = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>('[data-testid="route-chooser-item"]'));

describe('route chooser pop-up (#822 FR2-FR6)', () => {
  it('opens on a cluster of co-located routes, listing every member alphabetically', async () => {
    const { container } = renderMap();
    await fireEvent.click(container.querySelector('[data-testid="route-cluster"]')!);

    expect(popup(container)?.getAttribute('role')).toBe('dialog');
    expect(popup(container)?.getAttribute('aria-label')).toMatch(/^2 routes/);
    expect(items(container).map((b) => b.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'CCRC - Stonehaven Return 2.50 km rownative.icu',
      'Stonehaven Return 2.50 km rownative.icu',
    ]);
  });

  it('moves focus with the arrow keys and selects a preview with a click', async () => {
    const { container, onRownativeSelect } = renderMap();
    await fireEvent.click(container.querySelector('[data-testid="route-cluster"]')!);
    const [first, second] = items(container);

    expect(document.activeElement).toBe(first);
    await fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    await fireEvent.keyDown(second, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);

    await fireEvent.click(second);
    expect(onRownativeSelect).toHaveBeenCalledWith(expect.objectContaining({ id: '175' }));
    expect(popup(container)).toBeNull();
  });

  it('closes on Escape and on a click outside it', async () => {
    const { container } = renderMap();
    const cluster = container.querySelector('[data-testid="route-cluster"]')!;

    await fireEvent.click(cluster);
    await fireEvent.keyDown(items(container)[0], { key: 'Escape' });
    expect(popup(container)).toBeNull();

    await fireEvent.click(cluster);
    await fireEvent.pointerDown(document.body);
    expect(popup(container)).toBeNull();
  });

  it('puts the default route first and opens its detail on pick', async () => {
    const mine = route('mine', 'Zeta loop', 56.9606, -2.2014);
    const { container, onSelect } = renderMap({ routes: [mine], defaultRouteId: 'mine' });
    await fireEvent.click(container.querySelector('[data-testid="route-cluster"]')!);

    const first = items(container)[0];
    expect(first.textContent).toContain('★');
    expect(first.textContent).toContain('moderate');
    await fireEvent.click(first);
    expect(onSelect).toHaveBeenCalledWith(mine);
  });

  it('leaves an isolated pin as a direct pick, with no chooser', async () => {
    const { container, onRownativeSelect } = renderMap({
      rownativePreviews: [preview('1', 'Quinsig', 42.27, -71.75), preview('2', 'Thames', 51.5, -0.2)],
    });
    await fireEvent.click(container.querySelector('[data-rownative-id="1"]')!);
    expect(popup(container)).toBeNull();
    expect(onRownativeSelect).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }));
  });
});
