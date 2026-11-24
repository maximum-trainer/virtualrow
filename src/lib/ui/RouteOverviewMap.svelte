<!--
  RouteOverviewMap — map-primary Routes-screen overview (#505, ported to Svelte
  for #542 P1). Lazy-loads MapLibre; when the module or its init fails (jsdom,
  no WebGL, blocked tile host) it falls back to an SVG world sketch of the pins
  so the surface stays usable (NFR1 of #505). Clustering (D4), the modal detail
  overlay (D8) and the OSM-tile backdrop (D3) are handled here and in sibling
  components. DOM, class names, data-testids and copy are kept verbatim so the
  Playwright selectors keep resolving.
-->
<script lang="ts">
  import type { WaterRoute, Coordinate } from '../types/index';
  import { routeCentroid } from '../utils/routeCentroid';
  import {
    clusterRoutePins,
    type ClusteredEntry,
    type RownativePreviewInput,
  } from '../utils/routePinClusters';
  import { overviewFit } from './routeOverviewFit';
  import './RouteOverviewMap.css';

  const FALLBACK_ZOOM = 2;

  interface PlacedPin {
    route: WaterRoute;
    centroid: Coordinate;
  }

  interface Props {
    routes: readonly WaterRoute[];
    defaultRouteId: string | null;
    selectedRouteId: string | null;
    dimmedRouteIds?: ReadonlySet<string>;
    onSelect: (route: WaterRoute) => void;
    /** #822 phase 1: bundled rownative courses the user hasn't imported yet. */
    rownativePreviews?: readonly RownativePreviewInput[];
    /** #822 D15: click handler for a rownative preview pin — import then select. */
    onRownativeSelect?: (preview: RownativePreviewInput) => void;
  }

  let {
    routes,
    defaultRouteId,
    selectedRouteId,
    dimmedRouteIds,
    onSelect,
    rownativePreviews = [],
    onRownativeSelect,
  }: Props = $props();

  let canvasEl = $state<HTMLDivElement | undefined>(undefined);
  // Non-reactive holder for the live MapLibre instance (React's mapInstanceRef).
  let mapInstanceRef: {
    flyTo: (opts: { center: [number, number]; zoom: number; animate?: boolean }) => void;
  } | null = null;

  let mapReady = $state(false);
  let projection = $state<((c: Coordinate) => { x: number; y: number }) | null>(null);
  let containerSize = $state<{ w: number; h: number }>({ w: 0, h: 0 });
  // #505 Phase 2c (D4-b): the live viewport, read from MapLibre's `moveend`
  // event. In the SVG fallback this stays at the FALLBACK_ZOOM / world bbox.
  let viewport = $state<{ zoom: number; bbox: [number, number, number, number] }>({
    zoom: FALLBACK_ZOOM,
    bbox: [-180, -85, 180, 85],
  });

  const pins = $derived.by<PlacedPin[]>(() => {
    const out: PlacedPin[] = [];
    for (const r of routes) {
      const c = routeCentroid(r.coordinates);
      if (c) out.push({ route: r, centroid: c });
    }
    return out;
  });

  // #822 phase 1: rownative preview pins mapped into the same shape the
  // fallback-projection bbox walker reads, so a routes-free catalogue still
  // fits the world around the pins it does have.
  const previewPins = $derived.by<Array<{ lng: number; lat: number }>>(() =>
    rownativePreviews
      .filter(
        (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && !routes.some((r) => r.id === p.id),
      )
      .map((p) => ({ lng: p.lng, lat: p.lat })),
  );

  // #505 Phase 2c (D4-b): cluster against the live viewport, so a user zooming
  // in on a cluster watches it break apart as its members pass the cluster
  // radius. In the SVG fallback the viewport stays at the overview defaults.
  const entries = $derived.by<ClusteredEntry[]>(() =>
    clusterRoutePins(routes, viewport.zoom, viewport.bbox, rownativePreviews),
  );

  // Track rendered size so the fallback SVG and the pin layer agree on pixels.
  $effect(() => {
    const el = canvasEl;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      containerSize = { w: rect.width, h: rect.height };
    };
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  });

  // Try to initialise MapLibre; on any error (jsdom, no WebGL, module missing)
  // fall through to the SVG fallback. The module is imported dynamically so the
  // Routes screen bundle stays light (NFR3 of #505).
  $effect(() => {
    // Read the reactive deps synchronously so the effect re-runs like React's
    // [pins, defaultRouteId] dependency list.
    const currentPins = pins;
    const currentDefault = defaultRouteId;
    const el = canvasEl;

    let cancelled = false;
    let mapInstance: { remove: () => void } | null = null;
    if (!el || currentPins.length === 0) {
      mapReady = false;
      return;
    }

    (async () => {
      try {
        const maplibre = (await import('maplibre-gl')) as unknown as {
          Map: new (opts: Record<string, unknown>) => {
            remove: () => void;
            project: (lnglat: [number, number]) => { x: number; y: number };
            fitBounds: (
              bounds: [[number, number], [number, number]],
              opts?: Record<string, unknown>,
            ) => void;
            flyTo: (opts: { center: [number, number]; zoom: number; animate?: boolean }) => void;
            on: (ev: string, cb: () => void) => void;
            off: (ev: string, cb: () => void) => void;
            getZoom: () => number;
            getBounds: () => {
              getWest: () => number;
              getSouth: () => number;
              getEast: () => number;
              getNorth: () => number;
            };
          };
        };

        const style = {
          version: 8,
          sources: {
            osm: {
              type: 'raster',
              tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
              tileSize: 256,
              maxzoom: 19,
              attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
            },
          },
          layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
        };

        const map = new maplibre.Map({
          container: el,
          style,
          attributionControl: false,
          center: [currentPins[0].centroid.lng, currentPins[0].centroid.lat],
          zoom: 2,
        });
        if (cancelled) {
          map.remove();
          return;
        }
        mapInstance = map;
        mapInstanceRef = map;

        // #738: a lone route fits to its own course; every fit is capped.
        const fit = overviewFit(currentPins, currentDefault);
        if (fit) {
          map.fitBounds(fit.bounds, { padding: fit.padding, maxZoom: fit.maxZoom, animate: false });
        }

        mapReady = true;
        projection = (c: Coordinate) => map.project([c.lng, c.lat]);

        const readViewport = () => {
          const b = map.getBounds();
          viewport = {
            zoom: map.getZoom(),
            bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
          };
        };
        readViewport();
        map.on('moveend', readViewport);
      } catch {
        mapReady = false;
      }
    })();

    return () => {
      cancelled = true;
      mapInstance?.remove();
      mapInstance = null;
      mapInstanceRef = null;
      mapReady = false;
      projection = null;
    };
  });

  // Equirectangular projection for the fallback: a world sketch bounded by the
  // pin set (so a UK-only catalogue doesn't centre on the Atlantic).
  const fallbackProjection = $derived.by(() => {
    const totalPins = pins.length + previewPins.length;
    if (totalPins === 0 || containerSize.w === 0 || containerSize.h === 0) return null;
    let minLng = Infinity;
    let maxLng = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (const p of pins) {
      if (p.centroid.lng < minLng) minLng = p.centroid.lng;
      if (p.centroid.lng > maxLng) maxLng = p.centroid.lng;
      if (p.centroid.lat < minLat) minLat = p.centroid.lat;
      if (p.centroid.lat > maxLat) maxLat = p.centroid.lat;
    }
    for (const p of previewPins) {
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
    }
    const padLng = Math.max(0.5, (maxLng - minLng) * 0.2);
    const padLat = Math.max(0.5, (maxLat - minLat) * 0.2);
    minLng -= padLng;
    maxLng += padLng;
    minLat -= padLat;
    maxLat += padLat;
    const lngRange = maxLng - minLng || 1;
    const latRange = maxLat - minLat || 1;
    const w = containerSize.w;
    const h = containerSize.h;
    return (c: Coordinate) => ({
      x: ((c.lng - minLng) / lngRange) * w,
      y: ((maxLat - c.lat) / latRange) * h,
    });
  });

  const activeProjection = $derived(mapReady && projection ? projection : fallbackProjection);
</script>

<div class="route-overview-map" bind:this={canvasEl} data-testid="route-overview-map">
  {#if !mapReady}
    <svg
      class="route-overview-map__fallback"
      width={containerSize.w || 1}
      height={containerSize.h || 1}
      aria-hidden="true"
    >
      <rect width="100%" height="100%" fill="var(--surface-2, #0f1114)" />
    </svg>
  {/if}
  <div class="route-overview-map__pin-layer">
    {#each entries as entry (entry.kind === 'cluster' ? `cluster-${entry.id}` : entry.route.id)}
      {#if entry.kind === 'cluster'}
        {@const pos = activeProjection ? activeProjection({ lat: entry.lat, lng: entry.lng }) : null}
        <button
          type="button"
          class="route-overview-map__cluster"
          data-testid="route-cluster"
          data-cluster-count={entry.count}
          style="left: {pos ? `${pos.x}px` : '50%'}; top: {pos ? `${pos.y}px` : '50%'};"
          aria-label={`${entry.count} routes near this location — zoom in to see them`}
          onclick={() => {
            const map = mapInstanceRef;
            if (map) {
              map.flyTo({
                center: [entry.lng, entry.lat],
                zoom: Math.min(viewport.zoom + 2, 16),
                animate: false,
              });
            }
          }}
        >
          {entry.count}
        </button>
      {:else if entry.kind === 'pin'}
        {@const centroid = { lat: entry.lat, lng: entry.lng }}
        {@const pos = activeProjection ? activeProjection(centroid) : null}
        {@const isDefault = entry.route.id === defaultRouteId}
        {@const isSelected = entry.route.id === selectedRouteId}
        {@const isDimmed = dimmedRouteIds?.has(entry.route.id) ?? false}
        <button
          type="button"
          class="route-overview-map__pin"
          data-testid="route-pin"
          data-route-id={entry.route.id}
          data-default={isDefault ? 'true' : 'false'}
          data-selected={isSelected ? 'true' : 'false'}
          data-dimmed={isDimmed ? 'true' : 'false'}
          style="left: {pos ? `${pos.x}px` : '50%'}; top: {pos ? `${pos.y}px` : '50%'};"
          aria-label={`Select route ${entry.route.name}`}
          onclick={() => onSelect(entry.route)}
        >
          <svg width="18" height="22" viewBox="0 0 18 22">
            <path
              d="M9 0 C4 0 0 4 0 9 c0 7 9 13 9 13 s9-6 9-13 c0-5-4-9-9-9 z"
              fill={isDefault ? '#ffc400' : isSelected ? '#00b4ff' : '#e8e8e8'}
              stroke="#111"
              stroke-width="1"
            />
            <circle cx="9" cy="9" r="3" fill="#111" />
          </svg>
        </button>
      {:else}
        <!-- #822 phase 1: a rownative course the user hasn't imported yet. -->
        {@const centroid = { lat: entry.lat, lng: entry.lng }}
        {@const pos = activeProjection ? activeProjection(centroid) : null}
        {@const label =
          entry.preview.country && entry.preview.country !== 'Unknown'
            ? `${entry.preview.name ?? entry.preview.id} — ${entry.preview.country}`
            : (entry.preview.name ?? entry.preview.id)}
        <button
          type="button"
          class="route-overview-map__pin route-overview-map__pin--rownative"
          data-testid="route-pin-rownative"
          data-rownative-id={entry.preview.id}
          style="left: {pos ? `${pos.x}px` : '50%'}; top: {pos ? `${pos.y}px` : '50%'};"
          title={label}
          aria-label={`Import rownative course ${label}`}
          onclick={() => onRownativeSelect?.(entry.preview)}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="5" fill="#38d26a" stroke="#0a3d1b" stroke-width="1.25" />
          </svg>
        </button>
      {/if}
    {/each}
  </div>
  {#if pins.length > 0}
    <div class="route-overview-map__attribution" data-testid="route-overview-attribution">
      ©
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
        OpenStreetMap
      </a>
      contributors
    </div>
  {/if}
</div>
