<!--
  Pre-row loop configuration (#647 FR1 / FR2). Lets the rower turn looping on
  for the selected route and pick a target: distance (metres), time (minutes),
  or free (end on the rower's call). Hidden on a challenge row where looping
  is force-off (FR9) — the leaderboard is defined on the route's own distance.

  The panel reads and drives the ride-session's `loop` slice through its
  `setLoop*` methods. The in-memory state resets on every `endWorkout`; the
  rower's last choice is persisted to localStorage so they get it back next
  time (D6-a). DOM carries data-testids so Playwright drives it.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { RideSessionStore } from './rideSession.svelte';
  import {
    clampTargetDistanceMeters,
    clampTargetTimeSeconds,
    type RideLoopTargetKind,
  } from './rideLoop';

  interface Props {
    ride: RideSessionStore;
  }
  let { ride }: Props = $props();

  const STORAGE_KEY = 'virtualrow:ride-loop';

  // Local picker state mirrors the store but keeps the unit the user types in
  // (minutes for time; metres for distance). The store normalises on save.
  let distanceMeters = $state(5000);
  let timeMinutes = $state(20);

  onMount(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        enabled?: boolean;
        kind?: RideLoopTargetKind;
        distanceMeters?: number;
        timeSeconds?: number;
      };
      if (typeof parsed.distanceMeters === 'number') {
        distanceMeters = clampTargetDistanceMeters(parsed.distanceMeters);
      }
      if (typeof parsed.timeSeconds === 'number') {
        timeMinutes = Math.round(clampTargetTimeSeconds(parsed.timeSeconds) / 60);
      }
      if (parsed.enabled && parsed.kind) {
        ride.setLoop({
          enabled: true,
          target: pickTarget(parsed.kind),
        });
      }
    } catch {
      // Malformed storage entry: ignore and let the defaults stand.
    }
  });

  const persist = (): void => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          enabled: ride.loop.enabled,
          kind: ride.loop.target.kind,
          distanceMeters: clampTargetDistanceMeters(distanceMeters),
          timeSeconds: clampTargetTimeSeconds(timeMinutes * 60),
        }),
      );
    } catch {
      // localStorage can throw in private mode; the picker still works.
    }
  };

  const pickTarget = (kind: RideLoopTargetKind) => {
    switch (kind) {
      case 'route':
        return { kind };
      case 'free':
        return { kind };
      case 'distance':
        return { kind, value: clampTargetDistanceMeters(distanceMeters) };
      case 'time':
        return { kind, value: clampTargetTimeSeconds(timeMinutes * 60) };
    }
  };

  const toggle = (): void => {
    ride.setLoopEnabled(!ride.loop.enabled);
    // When turning on, make sure the target carries a value matching the picker.
    if (ride.loop.enabled) {
      ride.setLoopTarget(pickTarget(ride.loop.target.kind));
    }
    persist();
  };

  const chooseKind = (kind: RideLoopTargetKind): void => {
    ride.setLoopTarget(pickTarget(kind));
    persist();
  };

  const onDistanceInput = (event: Event): void => {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    distanceMeters = clampTargetDistanceMeters(value);
    if (ride.loop.target.kind === 'distance') ride.setLoopTarget(pickTarget('distance'));
    persist();
  };

  const onTimeInput = (event: Event): void => {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    timeMinutes = Math.round(clampTargetTimeSeconds(value * 60) / 60);
    if (ride.loop.target.kind === 'time') ride.setLoopTarget(pickTarget('time'));
    persist();
  };
</script>

{#if !ride.loopLocked}
  <section class="loop-config" data-testid="loop-config">
    <label class="loop-config-toggle">
      <input
        type="checkbox"
        checked={ride.loop.enabled}
        onchange={toggle}
        data-testid="loop-config-toggle"
      />
      <span>Loop this route past its finish</span>
    </label>
    {#if ride.loop.enabled}
      <div class="loop-config-targets" role="radiogroup" aria-label="Row target">
        <button
          type="button"
          role="radio"
          aria-checked={ride.loop.target.kind === 'distance'}
          class="loop-config-target"
          class:selected={ride.loop.target.kind === 'distance'}
          onclick={() => chooseKind('distance')}
          data-testid="loop-config-target-distance"
        >
          Distance
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={ride.loop.target.kind === 'time'}
          class="loop-config-target"
          class:selected={ride.loop.target.kind === 'time'}
          onclick={() => chooseKind('time')}
          data-testid="loop-config-target-time"
        >
          Time
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={ride.loop.target.kind === 'free'}
          class="loop-config-target"
          class:selected={ride.loop.target.kind === 'free'}
          onclick={() => chooseKind('free')}
          data-testid="loop-config-target-free"
        >
          Free
        </button>
      </div>
      {#if ride.loop.target.kind === 'distance'}
        <label class="loop-config-input">
          <span>Metres</span>
          <input
            type="number"
            min="500"
            max="100000"
            step="100"
            value={distanceMeters}
            oninput={onDistanceInput}
            data-testid="loop-config-distance-input"
          />
        </label>
      {:else if ride.loop.target.kind === 'time'}
        <label class="loop-config-input">
          <span>Minutes</span>
          <input
            type="number"
            min="1"
            max="360"
            step="1"
            value={timeMinutes}
            oninput={onTimeInput}
            data-testid="loop-config-time-input"
          />
        </label>
      {:else}
        <p class="loop-config-free-note">End the row yourself when you're done.</p>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .loop-config {
    margin: 0.75rem 0;
    padding: 0.75rem;
    border-radius: 10px;
    background: rgba(15, 23, 42, 0.6);
    color: #e2e8f0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .loop-config-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-weight: 600;
  }

  .loop-config-targets {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .loop-config-target {
    appearance: none;
    border: 1px solid rgba(148, 163, 184, 0.4);
    background: rgba(30, 41, 59, 0.6);
    color: #e2e8f0;
    padding: 0.3rem 0.8rem;
    border-radius: 999px;
    cursor: pointer;
    font-size: 0.85rem;
  }

  .loop-config-target.selected {
    background: #38bdf8;
    color: #0f172a;
    border-color: #38bdf8;
    font-weight: 600;
  }

  .loop-config-input {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
  }

  .loop-config-input input {
    width: 7rem;
    padding: 0.25rem 0.5rem;
    border-radius: 6px;
    border: 1px solid rgba(148, 163, 184, 0.4);
    background: rgba(15, 23, 42, 0.8);
    color: #e2e8f0;
    font-variant-numeric: tabular-nums;
  }

  .loop-config-free-note {
    margin: 0;
    font-size: 0.85rem;
    color: #cbd5e1;
  }
</style>
