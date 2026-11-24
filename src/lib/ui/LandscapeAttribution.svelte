<!--
  #762 VP-34 FR8 — the credits the landscape layers in use require: OSM for
  land cover and built form, the elevation source for terrain. Nothing while
  every layer is unavailable.
-->
<script lang="ts">
  import { landscapeAttribution, type Landscape } from '../services/landscapeService';

  let { landscape }: { landscape: Landscape | null | undefined } = $props();
  const credits = $derived(landscapeAttribution(landscape));
</script>

{#if credits.length > 0}
  <p class="landscape-attribution" data-testid="landscape-attribution">{credits.join(' · ')}</p>
{/if}

<style>
  .landscape-attribution {
    margin: 0.25rem 0 0;
    font-size: 0.7rem;
    opacity: 0.75;
  }
</style>
