<!--
  LandCrossingNotice — #752 FR2. On a gates-only rownative course, say which
  straight legs cross land and by how much, with the same "Attach track"
  action the course search offers beside it: a track of the course is what
  takes the line off the land. Shows nothing on any other route (FR4).
-->
<script lang="ts">
  import { getServices } from './servicesContext';
  import { landCrossingNote } from '../services/landCrossings';
  import type { WaterRoute } from '../types/index';

  /** What the file picker offers, and what parseTrackFile can actually read. */
  const TRACK_FILE_TYPES = '.gpx,.kml,.geojson,.json';

  interface Props {
    route: WaterRoute;
    onRouteImported: (route: WaterRoute) => void;
  }

  let { route, onRouteImported }: Props = $props();

  const { rownativeService } = getServices();

  let busy = $state(false);
  let error = $state<string | null>(null);

  const crossings = $derived(
    route.source === 'rownative' && route.geometrySource === 'gate-chain' && route.externalId
      ? (route.landCrossings ?? [])
      : [],
  );

  const readFileAsText = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.readAsText(file);
    });

  async function attach(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file || !route.externalId) return;
    error = null;
    busy = true;
    try {
      const { route: traced } = await rownativeService.attachTrack(route.externalId, file.name, await readFileAsText(file));
      onRouteImported(traced);
    } catch (e) {
      // The gate check explains itself: which gate was missed, and by how far.
      error = e instanceof Error ? e.message : 'That file could not be attached.';
    } finally {
      busy = false;
      input.value = '';
    }
  }
</script>

{#if crossings.length > 0}
  <div class="route-land-crossing" data-testid="route-land-crossing">
    {#each crossings as crossing (`${crossing.fromGate}-${crossing.toGate}`)}
      <p class="route-geometry-warning">{landCrossingNote(crossing)}</p>
    {/each}
    <label class="rownative-attach-label">
      <span>{busy ? 'Checking against the course gates…' : 'Attach track'}</span>
      <input
        type="file"
        accept={TRACK_FILE_TYPES}
        class="rownative-attach-input"
        aria-label={`Attach a track to ${route.name}`}
        disabled={busy}
        onchange={(e) => void attach(e.currentTarget)}
      />
    </label>
    {#if error}
      <p class="import-error" role="alert">⚠ {error}</p>
    {/if}
  </div>
{/if}
