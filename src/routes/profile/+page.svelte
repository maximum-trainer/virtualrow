<!--
  Profile screen (#777). A thin shell: the sections and their stores live on
  ProfilePage, which is unit-tested; this file only supplies the base path.
-->
<script lang="ts">
  import { base } from '$app/paths';
  import ProfilePage from '$lib/ui/ProfilePage.svelte';
</script>

<ProfilePage backHref={`${base}/`} />
