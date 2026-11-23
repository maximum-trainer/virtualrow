<!--
  RouteMap — the 2D canvas route preview (#542 P1, port of RouteMap.tsx).

  A pure `<canvas>` renderer (not MapLibre): it projects the route's
  coordinates to metres (`latLngToMeters`), fits them to the canvas
  (`createRouteMapTransform`) and draws the bank, the water corridor, the
  route line (optionally split into a completed/remaining segment at
  `progressPercent`), the start/end/current markers and a distance scale. The
  Row screen passes just `route`; `highlightMode` / `progressPercent` are used
  by the workout activity-map overlay in a later slice. DOM, class names and
  the drawing are kept verbatim so the specs that assert around the map keep
  passing; the React memo becomes `$derived` and the draw/resize effects become
  `$effect`s.

  #738: the drawing lives in `routeMapDraw.ts`. With no tile source (by
  design: the demo and guests need no external map data) it draws a vector
  map: bank, blue water corridor, route, labelled start/finish, distance ticks
  and a scale bar.
-->
<script lang="ts">
  import { latLngToMeters } from '../utils/geoUtils';
  import { drawRouteMap } from './routeMapDraw';
  import type { WaterRoute } from '../types/index';
  import './RouteMap.css';

  interface Props {
    route: WaterRoute;
    highlightMode?: boolean;
    /** 0-100, percentage of route completed. */
    progressPercent?: number;
  }

  let { route, highlightMode, progressPercent }: Props = $props();

  let canvas = $state<HTMLCanvasElement | undefined>(undefined);
  // Rendered canvas size, kept in state so the draw effect re-runs on resize.
  let canvasSize = $state({ width: 0, height: 0 });
  // #738: the labels the last draw put on the canvas, for the offline-map spec.
  let drawnLabels = $state<string[]>([]);

  // Convert lat/lng coordinates to planar metre positions + bounds.
  const projection = $derived.by(() => {
    if (!route || !route.coordinates || route.coordinates.length === 0) {
      return {
        points: [] as { x: number; y: number }[],
        bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0 },
      };
    }

    const originLat = route.coordinates[0].lat;
    const originLng = route.coordinates[0].lng;

    const meterPoints = route.coordinates.map((c) => {
      const p = latLngToMeters(c.lat, c.lng, originLat, originLng);
      return { x: p.x, y: p.y };
    });

    let minX = Infinity,
      maxX = -Infinity;
    let minY = Infinity,
      maxY = -Infinity;

    for (const point of meterPoints) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }

    const width = maxX - minX;
    const height = maxY - minY;

    return { points: meterPoints, bounds: { minX, maxX, minY, maxY, width, height } };
  });

  // Draw the route on canvas.
  $effect(() => {
    const el = canvas;
    const { points, bounds } = projection;
    // Track these so the draw re-runs when they change.
    void canvasSize;
    const progress = progressPercent;
    const highlight = highlightMode;

    if (!el || points.length < 2) return;

    const ctx = el.getContext('2d');
    if (!ctx) return;

    // Get actual canvas dimensions.
    const rect = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    // Set canvas size with device pixel ratio for crisp rendering.
    el.width = rect.width * dpr;
    el.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    drawnLabels = drawRouteMap(ctx, {
      points,
      bounds,
      width: rect.width,
      height: rect.height,
      progressPercent: progress,
      highlightMode: highlight,
    });
  });

  /**
   * Track the canvas's rendered size.
   *
   * A ResizeObserver reports the real element size and feeds the draw effect
   * through `canvasSize`, so it also catches container-only changes that a
   * window listener never sees (issue #195).
   */
  $effect(() => {
    const el = canvas;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (
        Math.abs(canvasSize.width - width) < 1 &&
        Math.abs(canvasSize.height - height) < 1
      ) {
        return;
      }
      canvasSize = { width, height };
    });
    observer.observe(el);
    return () => observer.disconnect();
  });
</script>

<div class={`route-map-container ${highlightMode ? 'highlight-mode' : ''}`}>
  <div class="route-map" data-labels={drawnLabels.join('|')}>
    <canvas bind:this={canvas} style="width: 100%; height: 100%;"></canvas>
  </div>
</div>
