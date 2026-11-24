<!--
  Test fixture (#752 FR2): stub services via context, then the notice.
  Lives under src/__tests__ (coverage-excluded).
-->
<script lang="ts">
  import { setServices } from '../../lib/ui/servicesContext';
  import type { Services } from '../../lib/ports';
  import type { WaterRoute } from '../../lib/types/index';
  import LandCrossingNotice from '../../lib/ui/LandCrossingNotice.svelte';

  const props: {
    overrides: Partial<Services>;
    route: WaterRoute;
    onRouteImported: (route: WaterRoute) => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  setServices(props.overrides);
</script>

<LandCrossingNotice route={props.route} onRouteImported={props.onRouteImported} />
