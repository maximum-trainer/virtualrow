<!--
  Challenges list (#415 Phase 2 / FR2).

  Renders the rownative Speed Orders catalogue with an Active | Upcoming |
  Past filter and a card per challenge. Status comes from the clock
  (`challengeStatusLabel`, AC2.3), not from the filter — a challenge pulled
  from the `active` endpoint can show as Open or Submissions closed as its
  submitEnd passes while the page is open.

  Design notes:

  - `notes` is organiser-authored (AC2.5) and may contain a URL. It is
    rendered as text in a wrapping `<p>`; nothing linkifies it, and `{notes}`
    in Svelte already escapes HTML, so a `<script>` or `<a href>` in it just
    shows as text.
  - The empty state ("No challenges here yet", AC2.4) distinguishes a
    genuine empty list from a loading state. `null` means "still fetching",
    `[]` means "fetched, nothing to show".
  - Nothing fires until the component mounts (AC6.2); the service's
    per-status cache (AC1.4) means switching tabs three times makes one
    request.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { getServices } from './servicesContext';
  import {
    isRaceable,
    paceOf,
    type Challenge,
    type ChallengeResult,
    type ChallengeStatus,
  } from '../services/challengesService';
  import { formatSplit } from '../utils/formatters';
  import { challengeStatusLabel, formatChallengeWindow } from './challengeStatus';

  interface Props {
    /** Called when "Row this course" is clicked (no ghost). */
    onRowChallenge?: (challenge: Challenge) => void;
    /** Called when "Race this time" is clicked on a leaderboard row (#415 Phase 3). */
    onRaceResult?: (challenge: Challenge, result: ChallengeResult) => void;
  }

  let { onRowChallenge, onRaceResult }: Props = $props();

  const services = getServices();

  let status: ChallengeStatus = $state('active');
  let challenges: Challenge[] | null = $state(null);
  let fetchError = $state(false);
  /** Which challenge card has its leaderboard panel open, by id. */
  let openId: string | null = $state(null);
  /** Fetched leaderboards, keyed by challenge id. `undefined` = not fetched. */
  const resultsByChallenge = $state<Record<string, ChallengeResult[] | null>>({});

  async function load(next: ChallengeStatus) {
    status = next;
    challenges = null;
    fetchError = false;
    try {
      challenges = await services.challengesService.listChallenges(next);
    } catch {
      // AC1.5 means listChallenges never rejects, but guard anyway: if the
      // port is ever swapped for one that does, the view still renders.
      fetchError = true;
      challenges = [];
    }
  }

  onMount(() => {
    void load('active');
  });

  const FILTERS: Array<{ key: ChallengeStatus; label: string }> = [
    { key: 'active', label: 'Active' },
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'past', label: 'Past' },
  ];

  function fmtKm(meters: number): string {
    return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
  }

  async function toggleLeaderboard(challenge: Challenge) {
    if (openId === challenge.id) {
      openId = null;
      return;
    }
    openId = challenge.id;
    if (resultsByChallenge[challenge.id] !== undefined) return;
    // null while in-flight so the panel can show a loading state.
    resultsByChallenge[challenge.id] = null;
    resultsByChallenge[challenge.id] = await services.challengesService.challengeResults(
      challenge.id,
    );
  }

  function fmtSeconds(s: number): string {
    const mins = Math.floor(s / 60);
    const secs = s - mins * 60;
    const secStr = secs < 10 ? `0${secs.toFixed(1)}` : secs.toFixed(1);
    return `${mins}:${secStr}`;
  }
</script>

<section class="challenges" data-testid="challenges-list">
  <header class="challenges__header">
    <h1>Challenges</h1>
    <p class="challenges__subtitle">
      Browse rownative Speed Orders. Row the course — your time is yours, nothing is submitted.
    </p>
  </header>

  <nav class="challenges__filters" aria-label="Challenge filter">
    {#each FILTERS as filter (filter.key)}
      <button
        type="button"
        class="challenges__filter"
        class:is-active={status === filter.key}
        aria-pressed={status === filter.key}
        data-testid={`challenges-filter-${filter.key}`}
        onclick={() => void load(filter.key)}
      >
        {filter.label}
      </button>
    {/each}
  </nav>

  {#if challenges === null}
    <p class="challenges__state" data-testid="challenges-loading">Loading challenges…</p>
  {:else if challenges.length === 0}
    <p class="challenges__state" data-testid="challenges-empty">
      {#if fetchError}
        Challenges are unavailable right now. Try again in a moment.
      {:else}
        No challenges here yet.
      {/if}
    </p>
  {:else}
    <ul class="challenges__cards" data-testid="challenges-cards">
      {#each challenges as challenge (challenge.id)}
        {@const label = challengeStatusLabel(challenge)}
        <li class="challenge-card" data-testid="challenge-card" data-challenge-id={challenge.id}>
          <div class="challenge-card__row challenge-card__row--top">
            <h2 class="challenge-card__name">{challenge.name}</h2>
            <span
              class="challenge-card__status badge-{label.toLowerCase().replace(/\s+/g, '-')}"
              data-testid="challenge-status"
            >
              {label}
            </span>
          </div>

          <p class="challenge-card__course" data-testid="challenge-course">
            {challenge.courseName} · {fmtKm(challenge.distanceMeters)}
          </p>

          <p class="challenge-card__window" data-testid="challenge-window">
            {formatChallengeWindow(challenge)}
          </p>

          <div class="challenge-card__meta">
            <span class="challenge-card__results" data-testid="challenge-results-count">
              {challenge.resultsCount} result{challenge.resultsCount === 1 ? '' : 's'}
            </span>
            {#if challenge.hasHandicap}
              <span class="challenge-card__handicap" data-testid="challenge-handicap">
                Handicap
              </span>
            {/if}
            {#if challenge.organizerName}
              <span class="challenge-card__organiser">by {challenge.organizerName}</span>
            {/if}
          </div>

          {#if challenge.notes}
            <!--
              AC2.5: notes are organiser-authored, free text. Svelte's `{…}`
              escapes HTML; we do not linkify a URL in the body because a
              link would be a vector for a route the organiser never
              authorised. Rendered as a plain paragraph with wrapping.
            -->
            <p class="challenge-card__notes" data-testid="challenge-notes">
              {challenge.notes}
            </p>
          {/if}

          <div class="challenge-card__actions">
            {#if onRowChallenge}
              <button
                type="button"
                class="challenge-card__row-button"
                data-testid="challenge-row-button"
                onclick={() => onRowChallenge?.(challenge)}
              >
                Row this course
              </button>
            {/if}
            <button
              type="button"
              class="challenge-card__leaderboard-toggle"
              data-testid="challenge-leaderboard-toggle"
              aria-expanded={openId === challenge.id}
              aria-controls={`leaderboard-${challenge.id}`}
              onclick={() => void toggleLeaderboard(challenge)}
            >
              {openId === challenge.id ? 'Hide leaderboard' : 'Show leaderboard'}
            </button>
          </div>

          {#if openId === challenge.id}
            {@const results = resultsByChallenge[challenge.id]}
            <div
              class="challenge-card__leaderboard"
              id={`leaderboard-${challenge.id}`}
              data-testid="challenge-leaderboard"
            >
              {#if results === null || results === undefined}
                <p class="challenge-card__loading" data-testid="leaderboard-loading">
                  Loading leaderboard…
                </p>
              {:else if results.length === 0}
                <p class="challenge-card__empty" data-testid="leaderboard-empty">
                  No results on this leaderboard yet.
                </p>
                <!--
                  AC4.5 — a challenge with no raceable results still offers
                  the course without a ghost. "Row this course" is already
                  above, so no second button here.
                -->
              {:else}
                <ol class="challenge-card__results-list" data-testid="leaderboard-results">
                  {#each results as result (`${challenge.id}-${result.rank}-${result.displayName}`)}
                    {@const raceable = isRaceable(result)}
                    {@const pace = paceOf(result, challenge.distanceMeters)}
                    <li
                      class="leaderboard-row"
                      data-testid="leaderboard-row"
                      data-raceable={raceable ? 'true' : 'false'}
                    >
                      <span class="leaderboard-row__rank">{result.rank}</span>
                      <span class="leaderboard-row__name">{result.displayName}</span>
                      <span class="leaderboard-row__time">{fmtSeconds(result.rawTimeSeconds)}</span>
                      <!--
                        AC4.3 — corrected time + points are shown but never
                        the ghost. Where handicap applies, the raw time is
                        what is raced.
                      -->
                      {#if result.correctedTimeSeconds !== null}
                        <span
                          class="leaderboard-row__corrected"
                          data-testid="leaderboard-corrected"
                          title="Corrected time (handicap). Shown, never raced."
                        >
                          corr {fmtSeconds(result.correctedTimeSeconds)}
                        </span>
                      {/if}
                      {#if result.points !== null}
                        <span class="leaderboard-row__points">
                          {result.points} pts
                        </span>
                      {/if}
                      {#if raceable && pace !== null && onRaceResult}
                        <button
                          type="button"
                          class="leaderboard-row__race"
                          data-testid="leaderboard-race-button"
                          title={`Row at ${formatSplit(pace)}/500m`}
                          onclick={() => onRaceResult?.(challenge, result)}
                        >
                          Race this time
                        </button>
                      {:else if !raceable}
                        <span
                          class="leaderboard-row__status"
                          data-testid="leaderboard-row-status"
                          aria-label={`Status: ${result.validationStatus}`}
                        >
                          {result.validationStatus}
                        </span>
                      {/if}
                    </li>
                  {/each}
                </ol>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .challenges {
    max-width: 920px;
    margin: 0 auto;
    padding: 1.5rem 1rem 3rem;
    color: #e8ecf3;
  }
  .challenges__header h1 {
    margin: 0 0 0.25rem;
    font-size: 1.75rem;
  }
  .challenges__subtitle {
    margin: 0 0 1.25rem;
    color: #9aa6b8;
  }
  .challenges__filters {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.25rem;
    flex-wrap: wrap;
  }
  .challenges__filter {
    appearance: none;
    background: transparent;
    color: #cfd6e3;
    border: 1px solid #2a3345;
    border-radius: 999px;
    padding: 0.4rem 0.9rem;
    font: inherit;
    cursor: pointer;
  }
  .challenges__filter.is-active {
    background: #1f2a3f;
    border-color: #4a90d9;
    color: #ffffff;
  }
  .challenges__state {
    color: #9aa6b8;
    padding: 1.5rem 0;
    text-align: center;
  }
  .challenges__cards {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 0.9rem;
  }
  .challenge-card {
    background: #10172c;
    border: 1px solid #22304a;
    border-radius: 0.75rem;
    padding: 1rem 1.1rem;
  }
  .challenge-card__row--top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .challenge-card__name {
    margin: 0;
    font-size: 1.15rem;
  }
  .challenge-card__status {
    font-size: 0.75rem;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    background: #2a3850;
    color: #cfd6e3;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .challenge-card__status.badge-open {
    background: #163826;
    color: #7ed9a3;
  }
  .challenge-card__status.badge-submissions-closed {
    background: #3a2029;
    color: #e39aa9;
  }
  .challenge-card__course,
  .challenge-card__window {
    margin: 0.35rem 0;
    color: #cfd6e3;
  }
  .challenge-card__meta {
    display: flex;
    gap: 0.65rem;
    margin: 0.35rem 0;
    color: #9aa6b8;
    flex-wrap: wrap;
    font-size: 0.9rem;
  }
  .challenge-card__handicap {
    background: #2a2544;
    color: #c9b8ff;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .challenge-card__notes {
    margin: 0.6rem 0 0;
    padding: 0.6rem;
    background: #0a1120;
    border-left: 2px solid #4a90d9;
    color: #cfd6e3;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .challenge-card__row-button {
    margin-top: 0.75rem;
    appearance: none;
    background: #4a90d9;
    color: #0a1120;
    border: 0;
    border-radius: 0.5rem;
    padding: 0.55rem 1rem;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .challenge-card__row-button:hover {
    background: #67a6e5;
  }
  .challenge-card__actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
    flex-wrap: wrap;
  }
  .challenge-card__leaderboard-toggle {
    appearance: none;
    background: transparent;
    color: #cfd6e3;
    border: 1px solid #2a3345;
    border-radius: 0.5rem;
    padding: 0.5rem 0.9rem;
    font: inherit;
    cursor: pointer;
  }
  .challenge-card__leaderboard {
    margin-top: 0.8rem;
    padding-top: 0.6rem;
    border-top: 1px solid #22304a;
  }
  .challenge-card__loading,
  .challenge-card__empty {
    margin: 0.4rem 0;
    color: #9aa6b8;
  }
  .challenge-card__results-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 0.3rem;
  }
  .leaderboard-row {
    display: grid;
    grid-template-columns: 2ch minmax(0, 1fr) auto auto auto auto;
    gap: 0.5rem;
    align-items: center;
    padding: 0.35rem 0.4rem;
    border-radius: 0.3rem;
    background: #0a1120;
  }
  .leaderboard-row[data-raceable='false'] {
    opacity: 0.6;
  }
  .leaderboard-row__rank {
    color: #9aa6b8;
    text-align: right;
  }
  .leaderboard-row__name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .leaderboard-row__time {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .leaderboard-row__corrected,
  .leaderboard-row__points {
    font-size: 0.8rem;
    color: #9aa6b8;
    font-variant-numeric: tabular-nums;
  }
  .leaderboard-row__status {
    font-size: 0.75rem;
    color: #e39aa9;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .leaderboard-row__race {
    appearance: none;
    background: #163826;
    color: #7ed9a3;
    border: 1px solid #284d38;
    border-radius: 0.3rem;
    padding: 0.25rem 0.55rem;
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .leaderboard-row__race:hover {
    background: #1e4a30;
  }
</style>
