<!--
  Profile page (#777). The home for settings that belong to the athlete rather
  than to one row: linked accounts, the rower's appearance (moved off the Row
  screen) and a reserved Preferences section for what comes next. Everything
  here reads and writes the same stores the Row screen used, so nothing new is
  persisted (FR9) and the engine is untouched (FR10).
-->
<script lang="ts">
  import { getAuth } from './authContext';
  import { CrewPreferenceStore } from './useCrewPreference.svelte';
  import { RowerAppearanceStore } from './useRowerAppearance.svelte';
  import RowerAppearancePicker from './RowerAppearancePicker.svelte';
  import './ProfilePage.css';

  interface Props {
    /** Path back to the Row screen; the route passes `base + '/'`. */
    backHref?: string;
    crew?: CrewPreferenceStore;
    rowerAppearance?: RowerAppearanceStore;
  }

  let {
    backHref = '/',
    crew = new CrewPreferenceStore(),
    rowerAppearance = new RowerAppearanceStore(),
  }: Props = $props();

  const auth = getAuth();
  let loginError = $state<string | null>(null);

  function connect() {
    loginError = null;
    auth.login().catch((err: unknown) => {
      loginError = err instanceof Error ? err.message : 'Login failed';
    });
  }
</script>

<section class="profile-page" data-testid="profile-page" aria-labelledby="profile-heading">
  <header class="profile-page__header">
    <a class="profile-page__back" href={backHref}>← Back to Row</a>
    <h1 id="profile-heading" class="profile-page__title">Profile</h1>
  </header>

  <section
    class="profile-section"
    data-testid="profile-section-linked-accounts"
    aria-labelledby="profile-linked-accounts"
  >
    <h2 id="profile-linked-accounts" class="profile-section__title">Linked accounts</h2>
    <ul class="linked-accounts">
      <li class="linked-account" data-testid="linked-account-intervals-icu">
        <div class="linked-account__info">
          <span class="linked-account__name">intervals.icu</span>
          {#if auth.isLoading}
            <span class="linked-account__status">Signing in…</span>
          {:else if auth.isAuthenticated && auth.user}
            <span class="linked-account__status linked-account__status--connected">
              Connected as {auth.user.name}
            </span>
          {:else}
            <span class="linked-account__status">
              Sign in to save your rows and load today's workout.
            </span>
          {/if}
        </div>
        {#if !auth.isLoading}
          {#if auth.isAuthenticated && auth.user}
            <button type="button" class="linked-account__action" onclick={() => auth.logout()}>
              Disconnect
            </button>
          {:else}
            <button
              type="button"
              class="linked-account__action linked-account__action--primary"
              onclick={connect}
            >
              Connect intervals.icu
            </button>
          {/if}
        {/if}
        {#if loginError}
          <p class="linked-account__error" role="alert">{loginError}</p>
        {/if}
      </li>
      <li class="linked-account linked-account--placeholder" data-testid="linked-account-strava">
        <div class="linked-account__info">
          <span class="linked-account__name">Strava</span>
          <span class="linked-account__status">Coming soon.</span>
        </div>
        <button type="button" class="linked-account__action" disabled>Connect Strava</button>
      </li>
    </ul>
  </section>

  <section
    class="profile-section"
    data-testid="profile-section-rower-appearance"
    aria-labelledby="profile-rower-appearance"
  >
    <h2 id="profile-rower-appearance" class="profile-section__title">Your rower</h2>
    <p class="profile-section__hint">Your choices apply to your next row.</p>
    <RowerAppearancePicker
      appearance={rowerAppearance.appearance}
      onChange={rowerAppearance.setSlot.bind(rowerAppearance)}
      crew={crew.preference}
      onCrewChange={(preference) => crew.setPreference(preference)}
    />
  </section>

  <section
    class="profile-section"
    data-testid="profile-section-preferences"
    aria-labelledby="profile-preferences"
  >
    <h2 id="profile-preferences" class="profile-section__title">Preferences</h2>
    <p class="profile-section__hint">
      Units, default route and other preferences will land here.
    </p>
  </section>
</section>
