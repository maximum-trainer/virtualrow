<!--
  Challenges screen (#415 Phase 2). Browse rownative Speed Orders, pick a
  course to row. The import + ghost-pick + leaderboard arrive in Phase 3.
  The route is a thin shell: all state lives on ChallengesList, which reads
  the ChallengesPort through the services context.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import ChallengesList from '$lib/ui/ChallengesList.svelte';
  import { getRoutesStore } from '$lib/ui/routesContext';
  import { getServices } from '$lib/ui/servicesContext';
  import type { Challenge } from '$lib/services/challengesService';

  const services = getServices();
  const routes = getRoutesStore();

  /**
   * AC3.1 / AC3.2 / AC3.3 — "Row this course" imports the course the
   * challenge names, reusing an already-imported one via
   * `findRouteByRownativeId`. A course missing from the mirror is reported
   * next to the card; the rest of the challenge stays readable (AC3.3).
   * The window is never a gate on rowing (AC3.4): we don't check it here.
   */
  async function rowChallenge(challenge: Challenge) {
    const existing = services.routeService.findRouteByRownativeId(challenge.courseId);
    if (existing) {
      routes.selectRoute(existing);
      void goto(`${base}/`);
      return;
    }
    try {
      const route = await services.rownativeService.importCourseById(challenge.courseId);
      routes.routeImported(route);
      void goto(`${base}/`);
    } catch {
      // Phase 3 adds inline per-card error messaging; for now the Row
      // button is a no-op when the mirror lacks the course, and the card
      // stays readable (AC3.3).
    }
  }
</script>

<svelte:head>
  <title>Challenges · VirtualRow</title>
</svelte:head>

<ChallengesList onRowChallenge={rowChallenge} />
