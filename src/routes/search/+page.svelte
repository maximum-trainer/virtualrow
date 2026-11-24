<!--
  Routes screen (#542 P1, D1-b). App.tsx's `route-search` view: the map-primary
  route browser (#505) — a MapLibre overview with the modal detail overlay,
  clustering and tile-backdrop cards, plus the drawer catalogue, filters, the
  rownative import and the file import. The catalogue state lives in the shared
  RoutesStore; selecting or importing a route navigates to the Row screen, as
  App.tsx switched `currentView` to `routes`. Class names, data-testids and copy
  are kept verbatim so the Routes Playwright specs keep passing.
-->
<script lang="ts">
  import { base } from '$app/paths';
  import { goto } from '$app/navigation';
  import type { WaterRoute } from '$lib/types/index';
  import {
    externalDistanceNote,
    formatRouteDistanceKm,
    formatSnapshotDistance,
    geometryProvenanceBadge,
  } from '$lib/utils/geometryProvenance';
  import { getAuth } from '$lib/ui/authContext';
  import { getRoutesStore } from '$lib/ui/routesContext';
  import { canRefreshGeometry, extractRouteStatus, routeGeometrySource } from '$lib/ui/routesStore.svelte';
  import { getServices } from '$lib/ui/servicesContext';
  import RouteOverviewMap from '$lib/ui/RouteOverviewMap.svelte';
  import RouteDetailOverlay from '$lib/ui/RouteDetailOverlay.svelte';
  import RownativeRouteImport from '$lib/ui/RownativeRouteImport.svelte';
  import RouteThumbnail from '$lib/ui/RouteThumbnail.svelte';
  import type { RownativeBundledCourse } from '$lib/services/rownativeService';
  import type { RownativePreviewInput } from '$lib/utils/routePinClusters';
  import { routesInView, type MapView } from '$lib/utils/routesInView';

  const auth = getAuth();
  const routes = getRoutesStore();
  const services = getServices();

  // #822 phase 1: every established rownative course renders as a pin on
  // the world map, read from the bundled snapshot (ships with the app, so
  // guests see the pins too — NFR3). Importing one still requires sign-in;
  // see rownativeImport below.
  let rownativePreviews = $state<readonly RownativeBundledCourse[]>([]);
  let rownativeImporting = $state<string | null>(null);

  $effect(() => {
    let cancelled = false;
    void services.rownativeService.getBundledIndex().then((list) => {
      if (!cancelled) rownativePreviews = list;
    });
    return () => {
      cancelled = true;
    };
  });

  // Once the user pans or zooms the overview map, the drawer lists what is in
  // view (their routes and rownative courses) in place of "My routes".
  let mapView = $state<MapView | null>(null);
  const areaList = $derived.by(() => {
    if (!mapView?.userMoved) return null;
    const inView = routesInView(routes.routes, rownativePreviews, mapView.bbox);
    const filter = routes.difficultyFilter;
    return {
      routes: filter === 'all' ? inView.routes : inView.routes.filter((r) => r.difficulty === filter),
      previews: filter === 'all' ? inView.previews : [],
    };
  });
  const listedRoutes = $derived(areaList ? areaList.routes : routes.filteredRoutes);

  // Playwright drives the signed-in flows without a live OAuth round trip.
  const showAuthFeatures = $derived(
    auth.isAuthenticated ||
      (typeof window !== 'undefined' && !!window.__PLAYWRIGHT_TESTING),
  );

  const DIFFICULTIES = ['all', 'easy', 'moderate', 'hard'] as const;

  /** Select a route and go to the Row screen, as App.tsx switched currentView. */
  function selectRoute(route: WaterRoute) {
    routes.selectRoute(route);
    void goto(`${base}/`);
  }

  function importRoute(route: WaterRoute) {
    routes.routeImported(route);
    void goto(`${base}/`);
  }

  /**
   * #822 phase 1 (D15): clicking a rownative preview pin kicks off the
   * existing import flow and opens the detail overlay on success. A
   * signed-out guest is bounced to the sign-in prompt in the drawer so
   * no silent network call happens on a guest session (NFR3).
   */
  async function rownativeImport(preview: RownativePreviewInput) {
    if (!showAuthFeatures) {
      routes.routesDrawerOpen = true;
      return;
    }
    if (rownativeImporting) return;
    rownativeImporting = preview.id;
    try {
      const route = await services.rownativeService.importCourseById(preview.id);
      routes.routeImported(route);
      routes.routeDetailOpen = route;
    } catch (err) {
      routes.importError = err instanceof Error ? err.message : 'Import failed.';
    } finally {
      rownativeImporting = null;
    }
  }

  async function onFileChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const imported = await routes.importFile(file);
    input.value = '';
    if (imported) void goto(`${base}/`);
  }
</script>

<svelte:head>
  <title>VirtualRow — Routes</title>
</svelte:head>

<aside class="app-sidebar"></aside>
<main class="app-main">
  <div class="view-container view-container--search">
    <div
      class="route-search-screen route-search-screen--map-primary"
      data-drawer-open={routes.routesDrawerOpen}
    >
      <div class="route-search-header">
        <h2>Routes</h2>
        <button
          type="button"
          class="btn-routes-drawer-toggle"
          data-testid="routes-drawer-toggle"
          aria-expanded={routes.routesDrawerOpen}
          aria-controls="route-search-drawer"
          onclick={() => (routes.routesDrawerOpen = !routes.routesDrawerOpen)}
        >
          {routes.routesDrawerOpen ? 'Hide list' : 'Show list'}
        </button>
        <button type="button" class="btn-back-to-row" onclick={() => goto(`${base}/`)}>
          ← Back to Row
        </button>
      </div>

      <!-- #505: a MapLibre overview sits above the catalogue, with the modal
           detail overlay (D8), clustering (D4) and tile-backdrop cards (D3). -->
      <section
        class="route-search-section route-overview-section"
        data-testid="route-overview-section"
      >
        <div class="route-overview-section__map">
          <RouteOverviewMap
            routes={routes.routes}
            defaultRouteId={routes.defaultRouteId}
            selectedRouteId={routes.selectedRoute?.id ?? null}
            dimmedRouteIds={routes.dimmedRouteIds}
            onSelect={(route: WaterRoute) => (routes.routeDetailOpen = route)}
            rownativePreviews={rownativePreviews}
            onRownativeSelect={rownativeImport}
            onViewChange={(view) => (mapView = view)}
            offlineBasemap={!showAuthFeatures}
          />
        </div>
      </section>

      <RouteDetailOverlay
        route={routes.routeDetailOpen}
        onClose={() => (routes.routeDetailOpen = null)}
        showBackdrop={showAuthFeatures}
        onStartRow={() => {
          if (routes.routeDetailOpen) {
            selectRoute(routes.routeDetailOpen);
            routes.routeDetailOpen = null;
          }
        }}
      />

      <div class="route-search-drawer" id="route-search-drawer">
        <section class="route-search-section">
          <h3>Add a rownative course</h3>
          {#if showAuthFeatures}
            <p class="route-search-hint">
              Paste a course ID or a rownative.icu link to add it straight away, or search the
              catalogue by name.
            </p>
            <RownativeRouteImport onRouteImported={importRoute} />
          {:else}
            <p class="route-search-hint">
              Sign in with intervals.icu to import courses from rownative.icu.
            </p>
          {/if}
        </section>

        <section class="route-search-section routes-list">
          <div class="routes-list-header">
            <h3 data-testid="routes-list-title">
              {areaList
                ? `Routes in this area (${areaList.routes.length + areaList.previews.length})`
                : 'My routes'}
            </h3>
            <div class="route-filters">
              <div class="filter-group">
                {#each DIFFICULTIES as d (d)}
                  <button
                    type="button"
                    class="filter-btn{routes.difficultyFilter === d ? ' filter-btn--active' : ''}"
                    onclick={() => (routes.difficultyFilter = d)}
                  >
                    {d === 'all' ? 'All' : d.charAt(0).toUpperCase() + d.slice(1)}
                  </button>
                {/each}
              </div>
            </div>
          </div>
          {#each listedRoutes as route (route.id)}
            {@const rownativeStatus = extractRouteStatus(route.tags)}
            {@const isDefault = routes.defaultRouteId === route.id}
            {@const badge = geometryProvenanceBadge(routeGeometrySource(route))}
            {@const extNote = externalDistanceNote(route)}
            <div
              class="route-item {routes.selectedRoute?.id === route.id ? 'active' : ''}"
              onclick={() => selectRoute(route)}
              role="button"
              tabindex="0"
              onkeydown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  selectRoute(route);
                }
              }}
            >
              <div class="route-item-header">
                <h4>{route.name}</h4>
                <div class="route-item-badges">
                  {#if isDefault}
                    <span class="badge route-default-badge">Default</span>
                  {/if}
                  <span class="badge badge-{route.difficulty}">{route.difficulty}</span>
                  {#if route.source === 'rownative'}
                    <span class="badge badge-source">rownative.icu</span>
                  {/if}
                  {#if rownativeStatus}
                    <span class="badge badge-status badge-status--{rownativeStatus}">
                      {rownativeStatus.charAt(0).toUpperCase() + rownativeStatus.slice(1)}
                    </span>
                  {/if}
                  {#if badge}
                    <span class="badge badge-{badge.modifier}" title={badge.title}>
                      {badge.label}
                    </span>
                  {/if}
                </div>
              </div>
              <p class="route-item-location">{route.location}</p>
              <div class="route-item-meta">
                <span>{formatRouteDistanceKm(route.distance)}</span>
                <span>•</span>
                <span>{route.estimatedTime} min</span>
                {#if extNote}
                  <span>•</span>
                  <span class="route-item-external-distance">{extNote}</span>
                {/if}
              </div>
              {#if route.coordinates && route.coordinates.length >= 2}
                <RouteThumbnail
                  coordinates={route.coordinates}
                  width={120}
                  height={60}
                  class="route-item-thumbnail"
                  showBackdrop={showAuthFeatures}
                />
              {/if}
              {#if routes.routeEnrichmentLoading[route.id]}
                <p class="route-item-status">Loading route data…</p>
              {/if}
              {#if routes.routeTracing[route.id]}
                <!-- #750 FR3: the import returned on the gate chain; the river follows. -->
                <p class="route-item-status" role="status" data-testid="route-tracing">Tracing the river…</p>
              {:else if canRefreshGeometry(route)}
                <div class="route-item-refresh" data-testid="route-refresh-geometry">
                  {#if routes.showsRefreshOffer(route)}
                    <span class="route-item-status">This course can now follow the river.</span>
                  {/if}
                  <button
                    type="button"
                    class="btn-refresh-geometry"
                    onclick={(e) => {
                      e.stopPropagation();
                      void routes.refreshGeometry(route);
                    }}
                  >
                    Refresh geometry
                  </button>
                  {#if routes.showsRefreshOffer(route)}
                    <button
                      type="button"
                      class="btn-refresh-geometry btn-refresh-geometry--dismiss"
                      onclick={(e) => {
                        e.stopPropagation();
                        routes.dismissRefreshOffer(route);
                      }}
                    >
                      Not now
                    </button>
                  {/if}
                </div>
              {/if}
              {#if auth.isAuthenticated}
                <button
                  type="button"
                  class="route-default-toggle{isDefault ? ' route-default-toggle--on' : ''}"
                  aria-pressed={isDefault}
                  onclick={(e) => {
                    // The card itself selects the route; the star must not.
                    e.stopPropagation();
                    routes.toggleDefaultRoute(auth.user?.id ?? null, route.id);
                  }}
                >
                  {isDefault ? '★ Remove as default' : '☆ Set as default'}
                </button>
              {/if}
            </div>
          {/each}
          {#if areaList}
            {#each areaList.previews as preview (preview.id)}
              {@const dist = formatSnapshotDistance(preview.distanceMeters)}
              <div
                class="route-item route-item--rownative"
                data-testid="route-item-rownative"
                data-rownative-id={preview.id}
                onclick={() => rownativeImport(preview)}
                role="button"
                tabindex="0"
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void rownativeImport(preview);
                  }
                }}
              >
                <div class="route-item-header">
                  <h4>{preview.name}</h4>
                  <div class="route-item-badges">
                    <span class="badge badge-source">rownative.icu</span>
                  </div>
                </div>
                {#if preview.country && preview.country !== 'Unknown'}
                  <p class="route-item-location">{preview.country}</p>
                {/if}
                <div class="route-item-meta">
                  {#if dist}<span>{dist}</span>{/if}
                  {#if rownativeImporting === preview.id}
                    {#if dist}<span>•</span>{/if}
                    <span class="route-item-status">Importing…</span>
                  {:else if !showAuthFeatures}
                    {#if dist}<span>•</span>{/if}
                    <span>Sign in to row this course</span>
                  {/if}
                </div>
              </div>
            {/each}
            {#if areaList.routes.length + areaList.previews.length === 0}
              <p class="route-search-hint" data-testid="routes-in-view-empty">
                No routes in this area. Zoom out to see more.
              </p>
            {/if}
          {/if}
        </section>

        {#if showAuthFeatures}
          <section class="route-search-section route-file-import">
            <button
              type="button"
              class="btn-import-route"
              aria-expanded={routes.isImportOpen}
              aria-controls="route-file-import-body"
              onclick={() => (routes.isImportOpen = !routes.isImportOpen)}
            >
              Import a file (GPX / KML / GeoJSON)
            </button>
            {#if routes.isImportOpen}
              <div class="route-import" id="route-file-import-body">
                <label for="import-route-name">Route name</label>
                <input
                  id="import-route-name"
                  type="text"
                  class="import-name-input"
                  placeholder="Route name"
                  bind:value={routes.importRouteName}
                />
                <input
                  type="file"
                  accept=".geojson,.json,.gpx,.kml"
                  aria-label="Route file"
                  onchange={onFileChange}
                />
                {#if routes.importError}
                  <p class="import-error" role="alert">⚠ {routes.importError}</p>
                {/if}
              </div>
            {/if}
          </section>
        {/if}
      </div>
    </div>
  </div>
</main>
