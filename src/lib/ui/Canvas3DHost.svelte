<!--
  Canvas3DHost — the ride-canvas seam host (#542 P1 / D10-c).

  Renders `.rower3d-canvas-container` and the `<canvas>` the engine draws into,
  and owns the lifecycle at the boundary between the UI-shell track (this
  component) and the engine track (`src/lib/renderer/`). Pass the engine's
  `attach` entrypoint as the `attach` prop and the host mounts it against the
  canvas; omit it and the host shows a bare canvas (no renderer, no three),
  which is what P1 ships until the engine lands (#550 D6-a). The engine never
  edits this file — it implements `attach` in its own package and the ride view
  passes it in.

  The DOM mirrors the React `Rower3D` container: the `.rower3d-fallback-marker`
  and `.rower3d-gpu-backend` markers and the camera-view control are kept so
  the non-3D specs that assert around the canvas keep passing.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { RideAttach, RideRenderer, RideFrame } from './rideCanvas';
  import { crashReporterService } from '../services/crashReporterService';

  export type CanvasBackend = 'stub' | 'live' | 'unavailable';

  interface Props {
    /** The engine's `attach` entrypoint. Omitted in P1 → bare canvas. */
    attach?: RideAttach;
    /** Resolved performance tier (quality axis), passed through to the engine. */
    tier?: string;
    /**
     * #591-fu P2c: resolved "view distance" tier, passed through alongside
     * `tier` so the engine can gate LOD / sprout window independently. Omit
     * to default to `tier`.
     */
    distanceTier?: string;
    /** The selected route the ride draws, passed through to the engine. */
    route?: unknown;
    /** #690 — stable engine route id, passed to `placeFurniture` so hand-authored per-route extras appear. */
    routeId?: string;
    /** True under Playwright. */
    testMode?: boolean;
    /** Live row state the engine pulls each frame (#542 workout slice). */
    getFrame?: () => RideFrame;
    /**
     * Which crewed scull GLB to render (#232 / #443). The shell has already
     * resolved it from the signed-in profile + stored preference; omitted
     * values default to `male`, matching the engine's pre-seam behaviour.
     */
    crew?: 'male' | 'female';
    /**
     * #578 FR2 — initial per-athlete rower appearance palette (RGBA
     * tuples per slot). Omitted = engine default. The shell computes it
     * from `rowerAppearanceService` + `paletteFromPreference`. Live
     * changes come through `appearancePatch` below.
     */
    appearance?: unknown;
    /**
     * #578 FR5 — a key that bumps whenever the palette should change
     * mid-ride, carrying the new palette value. The host watches it and
     * calls `handle.setAppearance` so the Svelte picker doesn't need a
     * handle reference.
     */
    appearancePatch?: { palette: unknown } | undefined;
    /**
     * #730 VP-12 — the rower's resolved conditions (`dawn` | `midday` |
     * `golden` | `overcast` | `dusk`). Passed at attach; a later change
     * relights the running scene through `handle.setConditions`, no
     * reattach. Omitted = the engine default.
     */
    conditions?: string;
    /** #542 AC11: notify the ride view when the backend state changes so it
     *  can swap in the "needs WebGPU" screen on 'unavailable'. */
    onBackend?: (backend: CanvasBackend) => void;
    /**
     * Rebuild the scene when `route` becomes a different object after the
     * first attach. The React scene took enrichment as a prop, so OSM water
     * shape, shore widths and buildings re-dressed the course whenever they
     * arrived; this host attached once and never looked again, so a rower who
     * started before the Overpass answer (about 30 s on the live deploy) kept
     * the placeholder canal for the whole row. The boat does not jump: its
     * distance lives in the session and comes back through `getFrame`.
     * Off by default so a test-mode run still creates exactly one device.
     */
    rebuildOnRouteChange?: boolean;
  }

  let {
    attach,
    tier,
    distanceTier,
    route,
    routeId,
    testMode = false,
    getFrame,
    crew,
    appearance,
    appearancePatch,
    conditions,
    onBackend,
    rebuildOnRouteChange = false,
  }: Props = $props();

  let liveHandle = $state<RideRenderer | null>(null);
  // #578 FR5 — forward palette changes from the Svelte picker. $effect runs
  // on initial attach and on every `appearancePatch` change; the handle
  // getter is a no-op before the engine has returned.
  $effect(() => {
    const patch = appearancePatch;
    if (!patch || !liveHandle) return;
    liveHandle.setAppearance?.(patch.palette);
  });

  // #730 VP-12 FR1 — forward conditions changes the same way.
  $effect(() => {
    const next = conditions;
    if (!next || !liveHandle) return;
    liveHandle.setConditions?.(next);
  });

  let container = $state<HTMLDivElement | undefined>(undefined);
  let canvas = $state<HTMLCanvasElement | undefined>(undefined);
  // 'stub' until the engine attaches; 'live' once it does; 'unavailable' if the
  // engine declined (returned null).
  let backend = $state<CanvasBackend>('stub');

  const setBackend = (next: CanvasBackend, reason?: string): void => {
    const changed = backend !== next;
    backend = next;
    if (changed) {
      onBackend?.(next);
      // #542 FR11 / AC11: one `renderer-unavailable` telemetry per attach
      // decline so the triage pipeline sees how often users hit this path.
      // The reporter's own dedupe window keeps a repeat visit quiet. Fire
      // and forget — the reporter never throws (NFR2).
      if (next === 'unavailable') {
        void crashReporterService.reportCrash({
          kind: 'renderer-unavailable',
          verdict: { crashed: true, reason: reason ?? 'engine-declined' },
        });
      }
    }
  };

  // One attach is "current" at a time. `generation` names it: a result that
  // comes back under an older number belongs to a scene that has since been
  // replaced or unmounted, and is disposed instead of adopted.
  let generation = 0;
  let mounted = false;
  let currentHandle: RideRenderer | null = null;
  let attachedRoute: unknown = undefined;

  const startAttach = (routeForAttach: unknown): void => {
    if (!attach || !canvas) return;
    const mine = (generation += 1);
    attachedRoute = routeForAttach;
    const target = canvas;
    const run = attach;
    // Wrap in Promise.resolve(fn).then so a sync throw inside `attach` lands
    // in the catch path alongside a rejected promise, instead of escaping the
    // effect — AC11 wants the renderer-unavailable telemetry either way.
    Promise.resolve()
      .then(() =>
        run(target, {
          tier,
          distanceTier,
          route: routeForAttach,
          routeId,
          testMode,
          getFrame,
          crew,
          appearance,
          conditions,
        }),
      )
      .then((r) => {
        if (mine !== generation) {
          r?.dispose();
          return;
        }
        currentHandle = r;
        liveHandle = r;
        setBackend(r ? 'live' : 'unavailable', r ? undefined : 'attach-returned-null');
      })
      .catch((err: unknown) => {
        if (mine !== generation) return;
        setBackend('unavailable', err instanceof Error ? err.message : 'attach-threw');
      });
  };

  const releaseCurrent = (): void => {
    currentHandle?.dispose();
    currentHandle = null;
    liveHandle = null;
  };

  onMount(() => {
    if (!attach || !canvas) return;
    mounted = true;
    startAttach(route);
    return () => {
      mounted = false;
      generation += 1;
      releaseCurrent();
    };
  });

  // Late route data (enrichment landing, a tier change that re-plans the
  // scenery): swap the scene for one built from it. Skipped once the engine
  // has declined — a new route does not make WebGPU appear, and asking again
  // would only request another adapter.
  $effect(() => {
    const next = route;
    if (!rebuildOnRouteChange) return;
    untrack(() => {
      if (!mounted || next === attachedRoute) return;
      if (backend === 'unavailable') return;
      releaseCurrent();
      startAttach(next);
    });
  });
</script>

<div class="rower3d-canvas-container" bind:this={container}>
  <!-- Hidden markers: the specs read these without them being visible. -->
  <div class="rower3d-fallback-marker" data-loaded="true" style="display: none;"></div>
  <div class="rower3d-gpu-backend" data-backend={backend} style="display: none;"></div>

  <canvas class="rower3d-canvas" bind:this={canvas}></canvas>

  {#if backend !== 'live'}
    <!-- P1 stub: the engine track replaces this with real frames. Kept out of
         the way of the UI chrome the specs assert on. -->
    <div class="rower3d-stub-placeholder" aria-hidden="true">
      {backend === 'unavailable' ? '3D view unavailable' : ''}
    </div>
  {/if}
</div>
