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
  import { onMount, tick, untrack } from 'svelte';
  import type { RideAttach, RideRenderer, RideFrame, RideGhostMarker, RideViewportInsets } from './rideCanvas';
  import { CROSSFADE_MS } from './rideCanvas';
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
     * #733 VP-15 — CSS px the HUD covers along each canvas edge. Passed at
     * attach; a change goes through `handle.setViewportInsets`.
     */
    viewportInsets?: RideViewportInsets;
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
    /** #726 VP-08 FR1 — the current scene's load phases, as they settle. */
    onLoadPhase?: (phase: string, status: 'done' | 'failed') => void;
    /** #803 — true while the page's loading screen covers the canvas. */
    loadingOverlayShown?: () => boolean;
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
    viewportInsets,
    conditions,
    onBackend,
    onLoadPhase,
    loadingOverlayShown,
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

  // #733 VP-15 FR1 — forward the HUD's covered area as it changes.
  $effect(() => {
    const next = viewportInsets;
    if (!next || !liveHandle) return;
    liveHandle.setViewportInsets?.(next);
  });

  let container = $state<HTMLDivElement | undefined>(undefined);
  // #741 VP-21 FR5 — a scene rebuilt for late route data is attached to a
  // second canvas laid over the first and faded in over CROSSFADE_MS, while
  // the old scene keeps drawing; then the old one goes. Outside that half
  // second there is exactly one canvas, so the specs see the DOM they know.
  type Slot = { key: number; el?: HTMLCanvasElement; incoming: boolean; shown: boolean };
  let slots = $state<Slot[]>([{ key: 0, incoming: false, shown: true }]);
  let nextSlotKey = 1;
  const canvas = $derived(slots[0]?.el);
  // 'stub' until the engine attaches; 'live' once it does; 'unavailable' if the
  // engine declined (returned null).
  let backend = $state<CanvasBackend>('stub');
  // #728 VP-10 FR2 — the race ghost's marker, as the engine last placed it.
  let ghostMarker = $state<RideGhostMarker | null>(null);

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

  const startAttach = (
    routeForAttach: unknown,
    target: HTMLCanvasElement | undefined = canvas,
    adopt: (r: RideRenderer | null) => boolean = () => true,
  ): void => {
    if (!attach || !target) return;
    const mine = (generation += 1);
    attachedRoute = routeForAttach;
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
          viewportInsets,
          onGhostMarker: (m: RideGhostMarker | null) => {
            if (mine === generation) ghostMarker = m;
          },
          onLoadPhase: (phase: string, status: 'done' | 'failed') => {
            if (mine === generation) onLoadPhase?.(phase, status);
          },
          ...(loadingOverlayShown ? { loadingOverlayShown } : {}),
        }),
      )
      .then((r) => {
        if (mine !== generation) {
          r?.dispose();
          return;
        }
        if (!adopt(r)) return;
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
    ghostMarker = null;
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
      if (fadeTimer) clearTimeout(fadeTimer);
      fadeTimer = null;
      fadingOut?.dispose();
      fadingOut = null;
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
      // #753 FR5: a spec counts the rebuilds a late route causes.
      if (typeof window !== 'undefined') window.__ROWER3D_REBUILDS = (window.__ROWER3D_REBUILDS ?? 0) + 1;
      if (!currentHandle) {
        // Nothing on screen yet: build the newer scene in place.
        releaseCurrent();
        startAttach(next);
        return;
      }
      crossfadeTo(next);
    });
  });

  let fadeTimer: ReturnType<typeof setTimeout> | null = null;
  // The scene being faded out, disposed when the fade ends (or on unmount).
  let fadingOut: RideRenderer | null = null;

  /** #741 FR5 — build `next` on a canvas over the live one, then fade it in. */
  const crossfadeTo = (next: unknown): void => {
    let slot = slots.find((s) => s.incoming);
    if (!slot) {
      slots.push({ key: nextSlotKey++, incoming: true, shown: false });
      slot = slots[slots.length - 1];
    }
    const incomingKey = slot.key;
    // The new canvas is in the DOM after this microtask's render.
    void tick().then(() => {
      const target = slots.find((s) => s.key === incomingKey)?.el;
      if (!mounted || !target) return;
      startAttach(next, target, (r) => {
        const incoming = slots.find((s) => s.key === incomingKey);
        if (!r || !incoming) {
          // Declined or gone: keep the scene on screen, drop the canvas.
          r?.dispose();
          slots = slots.filter((s) => s.key !== incomingKey);
          return false;
        }
        if (fadeTimer) clearTimeout(fadeTimer);
        fadingOut?.dispose();
        fadingOut = currentHandle;
        incoming.shown = true;
        fadeTimer = setTimeout(() => {
          fadeTimer = null;
          fadingOut?.dispose();
          fadingOut = null;
          slots = slots.filter((s) => s.key === incomingKey).map((s) => ({ ...s, incoming: false }));
        }, CROSSFADE_MS);
        return true;
      });
    });
  };
</script>

<div class="rower3d-canvas-container" bind:this={container}>
  <!-- Hidden markers: the specs read these without them being visible. -->
  <div class="rower3d-fallback-marker" data-loaded="true" style="display: none;"></div>
  <div class="rower3d-gpu-backend" data-backend={backend} style="display: none;"></div>

  {#each slots as slot (slot.key)}
    <canvas
      class="rower3d-canvas"
      class:rower3d-canvas-incoming={slot.incoming}
      class:rower3d-canvas-shown={slot.shown}
      style:--crossfade-ms="{CROSSFADE_MS}ms"
      bind:this={slot.el}
    ></canvas>
  {/each}

  {#if ghostMarker}
    <div
      class="ghost-marker"
      data-ahead={ghostMarker.ahead ? 'true' : 'false'}
      style="left: {ghostMarker.x}px; top: {ghostMarker.y}px;"
      aria-hidden="true"
    >
      Ghost {ghostMarker.meters} m
    </div>
  {/if}

  {#if backend !== 'live'}
    <!-- P1 stub: the engine track replaces this with real frames. Kept out of
         the way of the UI chrome the specs assert on. -->
    <div class="rower3d-stub-placeholder" aria-hidden="true">
      {backend === 'unavailable' ? '3D view unavailable' : ''}
    </div>
  {/if}
</div>

<style>
  /* #741 FR5 — the rebuilt scene, over the live one until it has faded in. */
  .rower3d-canvas-incoming {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    transition: opacity var(--crossfade-ms) linear;
  }
  .rower3d-canvas-incoming.rower3d-canvas-shown {
    opacity: 1;
  }
</style>
