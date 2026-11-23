<!--
  Test fixture (#777): provides a given AuthStore via the Svelte auth context
  and renders ProfilePage, so a unit test drives it through real context
  resolution. Lives under src/__tests__ (coverage-excluded).
-->
<script lang="ts">
  import { setAuth } from '../../lib/ui/authContext';
  import type { AuthStore } from '../../lib/ui/auth.svelte';
  import type { CrewPreferenceStore } from '../../lib/ui/useCrewPreference.svelte';
  import type { RowerAppearanceStore } from '../../lib/ui/useRowerAppearance.svelte';
  import ProfilePage from '../../lib/ui/ProfilePage.svelte';

  const props: {
    store: AuthStore;
    backHref?: string;
    crew?: CrewPreferenceStore;
    rowerAppearance?: RowerAppearanceStore;
  } = $props();
  // svelte-ignore state_referenced_locally
  setAuth(props.store);
</script>

<ProfilePage backHref={props.backHref} crew={props.crew} rowerAppearance={props.rowerAppearance} />
