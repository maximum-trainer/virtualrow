<!--
  Test fixture (#777): AuthButton with the profile props, behind a given
  AuthStore. Lives under src/__tests__ (coverage-excluded).
-->
<script lang="ts">
  import { setAuth } from '../../lib/ui/authContext';
  import type { AuthStore } from '../../lib/ui/auth.svelte';
  import AuthButton from '../../lib/ui/AuthButton.svelte';

  const props: { store: AuthStore; profileHref?: string; showProfile?: boolean } = $props();
  // svelte-ignore state_referenced_locally
  setAuth(props.store);
</script>

<AuthButton profileHref={props.profileHref} showProfile={props.showProfile} />
