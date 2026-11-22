import { render } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';

import Canvas3DHost from '../lib/ui/Canvas3DHost.svelte';
import type { RideAttach } from '../lib/ui/rideCanvas';

// #542 P1 (F5): the ride-canvas seam host. P1 ships a bare canvas; the engine
// track attaches via the `attach` prop.
describe('Canvas3DHost', () => {
  it('renders the canvas container and markers with no engine attached', () => {
    const { container } = render(Canvas3DHost);

    const host = container.querySelector('.rower3d-canvas-container');
    expect(host).not.toBeNull();
    // The seam DOM the non-3D specs assert around.
    expect(host!.querySelector('canvas.rower3d-canvas')).not.toBeNull();
    expect(host!.querySelector('.rower3d-fallback-marker')).not.toBeNull();
    // No engine → the backend marker reads 'stub'.
    expect(
      host!.querySelector('.rower3d-gpu-backend')?.getAttribute('data-backend'),
    ).toBe('stub');
  });

  it('hands the engine the canvas and the passed-through options', async () => {
    const dispose = vi.fn();
    const attach = vi.fn<RideAttach>(() => ({ dispose }));

    const { container } = render(Canvas3DHost, {
      attach,
      tier: 'high',
      route: { id: 'r1' },
      testMode: true,
    });
    await Promise.resolve();

    expect(attach).toHaveBeenCalledTimes(1);
    const [canvasArg, optsArg] = attach.mock.calls[0];
    expect(canvasArg).toBe(container.querySelector('canvas.rower3d-canvas'));
    expect(optsArg).toMatchObject({ tier: 'high', route: { id: 'r1' }, testMode: true });
  });

  it('passes the crew prop through to the engine attach', async () => {
    const dispose = vi.fn();
    const attach = vi.fn<RideAttach>(() => ({ dispose }));

    render(Canvas3DHost, { attach, crew: 'female' });
    await Promise.resolve();

    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach.mock.calls[0][1]).toMatchObject({ crew: 'female' });
  });

  it('disposes the engine handle when the host unmounts', async () => {
    const dispose = vi.fn();
    const attach = vi.fn<RideAttach>(() => ({ dispose }));

    const { unmount } = render(Canvas3DHost, { attach });
    await Promise.resolve();
    unmount();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('shows the unavailable placeholder when the engine declines', async () => {
    const attach = vi.fn<RideAttach>(() => null);

    const { container } = render(Canvas3DHost, { attach });
    await Promise.resolve();
    await Promise.resolve();

    expect(
      container.querySelector('.rower3d-gpu-backend')?.getAttribute('data-backend'),
    ).toBe('unavailable');
  });

  // The React scene took `enrichment` as a prop, so OSM water shape, shore
  // widths and buildings re-dressed the course whenever they arrived
  // (Rower3D.tsx's `useMemo(..., [enrichment])` chain). The Svelte host
  // attached once in `onMount` and never looked at `route` again, so a rower
  // who started before the ~30 s Overpass answer kept the placeholder canal
  // for the whole row. `rebuildOnRouteChange` restores the old behaviour.
  describe('rebuildOnRouteChange', () => {
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    };

    it('re-attaches with the new route when the engine route object changes', async () => {
      const disposeA = vi.fn();
      const disposeB = vi.fn();
      const attach = vi
        .fn<RideAttach>()
        .mockImplementationOnce(() => ({ dispose: disposeA }))
        .mockImplementationOnce(() => ({ dispose: disposeB }));
      const plain = { id: 'r1', enriched: false };
      const enriched = { id: 'r1', enriched: true };

      const { rerender, container } = render(Canvas3DHost, {
        attach,
        route: plain,
        tier: 'medium',
        rebuildOnRouteChange: true,
      });
      await flush();
      expect(attach).toHaveBeenCalledTimes(1);

      await rerender({ attach, route: enriched, tier: 'medium', rebuildOnRouteChange: true });
      await flush();

      expect(disposeA).toHaveBeenCalledTimes(1);
      expect(attach).toHaveBeenCalledTimes(2);
      expect(attach.mock.calls[1][1]).toMatchObject({ route: enriched, tier: 'medium' });
      expect(attach.mock.calls[1][0]).toBe(container.querySelector('canvas.rower3d-canvas'));
      expect(disposeB).not.toHaveBeenCalled();
      expect(
        container.querySelector('.rower3d-gpu-backend')?.getAttribute('data-backend'),
      ).toBe('live');
    });

    it('does nothing when the same route object is passed again', async () => {
      const dispose = vi.fn();
      const attach = vi.fn<RideAttach>(() => ({ dispose }));
      const route = { id: 'r1' };

      const { rerender } = render(Canvas3DHost, { attach, route, rebuildOnRouteChange: true });
      await flush();
      await rerender({ attach, route, tier: 'high', rebuildOnRouteChange: true });
      await flush();

      expect(attach).toHaveBeenCalledTimes(1);
      expect(dispose).not.toHaveBeenCalled();
    });

    it('stays attached once by default, so the test-mode device budget is unchanged', async () => {
      const dispose = vi.fn();
      const attach = vi.fn<RideAttach>(() => ({ dispose }));

      const { rerender } = render(Canvas3DHost, { attach, route: { id: 'a' } });
      await flush();
      await rerender({ attach, route: { id: 'b' } });
      await flush();

      expect(attach).toHaveBeenCalledTimes(1);
      expect(dispose).not.toHaveBeenCalled();
    });

    it('does not retry an engine that declined', async () => {
      const attach = vi.fn<RideAttach>(() => null);

      const { rerender } = render(Canvas3DHost, {
        attach,
        route: { id: 'a' },
        rebuildOnRouteChange: true,
      });
      await flush();
      await rerender({ attach, route: { id: 'b' }, rebuildOnRouteChange: true });
      await flush();

      expect(attach).toHaveBeenCalledTimes(1);
    });

    it('keeps only the latest scene when routes change faster than attach resolves', async () => {
      const disposes = [vi.fn(), vi.fn(), vi.fn()];
      const resolvers: Array<() => void> = [];
      let call = 0;
      const attach = vi.fn<RideAttach>(() => {
        const mine = disposes[call];
        call += 1;
        return new Promise((resolve) => {
          resolvers.push(() => resolve({ dispose: mine }));
        });
      });

      const { rerender, unmount } = render(Canvas3DHost, {
        attach,
        route: { id: 'a' },
        rebuildOnRouteChange: true,
      });
      await flush();
      resolvers[0]();
      await flush();
      await rerender({ attach, route: { id: 'b' }, rebuildOnRouteChange: true });
      await flush();
      await rerender({ attach, route: { id: 'c' }, rebuildOnRouteChange: true });
      await flush();
      // 'c' resolves before 'b': 'b' is stale when it lands and must be dropped.
      resolvers[2]();
      await flush();
      resolvers[1]();
      await flush();

      expect(disposes[0]).toHaveBeenCalledTimes(1);
      expect(disposes[1]).toHaveBeenCalledTimes(1);
      expect(disposes[2]).not.toHaveBeenCalled();

      unmount();
      expect(disposes[2]).toHaveBeenCalledTimes(1);
    });
  });

  // #730 VP-12 FR1 — the rower's conditions reach the engine at attach and
  // as a live update, the way `appearancePatch` does.
  describe('conditions', () => {
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    };

    it('passes the resolved conditions to attach', async () => {
      const attach = vi.fn<RideAttach>(() => ({ dispose: vi.fn() }));
      render(Canvas3DHost, { attach, conditions: 'dusk' });
      await flush();
      expect(attach.mock.calls[0][1]).toMatchObject({ conditions: 'dusk' });
    });

    it('relights the running scene on change without reattaching', async () => {
      const setConditions = vi.fn();
      const attach = vi.fn<RideAttach>(() => ({ dispose: vi.fn(), setConditions }));
      const { rerender } = render(Canvas3DHost, { attach, conditions: 'midday' });
      await flush();
      await rerender({ attach, conditions: 'dusk' });
      await flush();
      expect(attach).toHaveBeenCalledTimes(1);
      expect(setConditions).toHaveBeenLastCalledWith('dusk');
    });
  });

  // #733 VP-15 FR1 — the HUD's covered area reaches the engine at attach
  // and as a live update.
  describe('viewportInsets', () => {
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    };
    const insets = { top: 0, right: 0, bottom: 300, left: 0 };

    it('passes the insets to attach', async () => {
      const attach = vi.fn<RideAttach>(() => ({ dispose: vi.fn() }));
      render(Canvas3DHost, { attach, viewportInsets: insets });
      await flush();
      expect(attach.mock.calls[0][1]).toMatchObject({ viewportInsets: insets });
    });

    it('forwards a change to the running scene without reattaching', async () => {
      const setViewportInsets = vi.fn();
      const attach = vi.fn<RideAttach>(() => ({ dispose: vi.fn(), setViewportInsets }));
      const { rerender } = render(Canvas3DHost, { attach, viewportInsets: insets });
      await flush();
      const next = { ...insets, bottom: 120 };
      await rerender({ attach, viewportInsets: next });
      await flush();
      expect(attach).toHaveBeenCalledTimes(1);
      expect(setViewportInsets).toHaveBeenLastCalledWith(next);
    });
  });
});
