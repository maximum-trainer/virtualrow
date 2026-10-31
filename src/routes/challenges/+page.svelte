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
  import { getRideSession } from '$lib/ui/rideSessionContext';
  import { getServices } from '$lib/ui/servicesContext';
  import { paceOf, type Challenge, type ChallengeResult } from '$lib/services/challengesService';

  const services = getServices();
  const routes = getRoutesStore();
  const ride = getRideSession();

  /**
   * AC3.1 / AC3.2 / AC3.3 — "Row this course" imports the course the
   * challenge names, reusing an already-imported one via
   * `findRouteByRownativeId`. A course missing from the mirror is reported
   * next to the card; the rest of the challenge stays readable (AC3.3).
   * The window is never a gate on rowing (AC3.4): we don't check it here.
   */
  async function selectCourseFor(challenge: Challenge): Promise<boolean> {
    const existing = services.routeService.findRouteByRownativeId(challenge.courseId);
    if (existing) {
      routes.selectRoute(existing);
      return true;
    }
    try {
      const route = await services.rownativeService.importCourseById(challenge.courseId);
      routes.routeImported(route);
      return true;
    } catch {
      // The mirror lacks the course. The card above stays readable (AC3.3);
      // the Row/Race button just does nothing.
      return false;
    }
  }

  /**
   * Snapshot the leaderboard this row is being rowed against (#415 Phase 4
   * / AC5.1), so the SessionSummary can rank the row against the field
   * even if the leaderboard moves on while the rower is rowing.
   */
  async function markChallengeInProgress(challenge: Challenge) {
    const results = await services.challengesService.challengeResults(challenge.id);
    ride.challengeInProgress = {
      challengeName: challenge.name,
      courseDistanceMeters: challenge.distanceMeters,
      results,
    };
  }

  async function rowChallenge(challenge: Challenge) {
    // Rowing without a ghost: clear any prior pace-with-name so the HUD
    // doesn't still read "on Sander Roosendaal" for a free row.
    ride.ghostChoice = { kind: 'none' };
    await markChallengeInProgress(challenge);
    const ok = await selectCourseFor(challenge);
    if (ok) void goto(`${base}/`);
  }

  /**
   * #415 Phase 3 — race a leaderboard time as a pace ghost (#338). The
   * raw time is what is raced (AC4.3): a corrected time is a scoring
   * adjustment for a boat class, never the ghost. The HUD label names the
   * athlete (AC4.4) via `displayName` on the GhostChoice.
   */
  async function raceResult(challenge: Challenge, result: ChallengeResult) {
    const pace = paceOf(result, challenge.distanceMeters);
    if (pace === null) return;
    ride.ghostChoice = { kind: 'pace', paceSPer500: pace, displayName: result.displayName };
    await markChallengeInProgress(challenge);
    const ok = await selectCourseFor(challenge);
    if (ok) void goto(`${base}/`);
  }
</script>

<svelte:head>
  <title>Challenges · VirtualRow</title>
</svelte:head>

<ChallengesList onRowChallenge={rowChallenge} onRaceResult={raceResult} />
