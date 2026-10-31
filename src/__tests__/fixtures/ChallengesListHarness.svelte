<!--
  Test harness (#415 Phase 2): installs a stub services bundle via the
  Svelte services context and renders ChallengesList, so a unit test drives
  the view through real context resolution. Lives under src/__tests__
  (coverage-excluded).
-->
<script lang="ts">
  import { setServices } from '../../lib/ui/servicesContext';
  import type { Services } from '../../lib/ports';
  import type { Challenge } from '../../lib/services/challengesService';
  import ChallengesList from '../../lib/ui/ChallengesList.svelte';

  const props: {
    overrides: Partial<Services>;
    onRowChallenge?: (challenge: Challenge) => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  setServices(props.overrides);
</script>

<ChallengesList onRowChallenge={props.onRowChallenge} />
