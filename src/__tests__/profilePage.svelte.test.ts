import { render, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import ProfilePageHarness from './fixtures/ProfilePageHarness.svelte';
import AuthButtonProfileHarness from './fixtures/AuthButtonProfileHarness.svelte';
import { AuthStore } from '../lib/ui/auth.svelte';
import { CrewPreferenceStore, CREW_PREFERENCE_STORAGE_KEY } from '../lib/ui/useCrewPreference.svelte';
import { RowerAppearanceStore } from '../lib/ui/useRowerAppearance.svelte';
import { ROWER_APPEARANCE_STORAGE_KEY } from '../lib/services/rowerAppearanceService';
import type { AuthPort } from '../lib/ports';
import type { AuthUser } from '../lib/types/index';

const USER: AuthUser = { id: 'i1', name: 'Dana Rower', email: 'dana@example.com' };

function stubAuth(user: AuthUser | null = null, startLogin = vi.fn(async () => {})): AuthPort {
  return {
    getUser: () => user,
    startLogin,
    handleCallback: vi.fn(async () => null),
    logout: vi.fn(),
    getAccessToken: vi.fn(() => null),
    getLastError: vi.fn(() => null),
    getLastErrorClass: vi.fn(() => null),
    refreshAccessToken: vi.fn(async () => false),
    scheduleRefresh: vi.fn(),
    isAuthenticated: vi.fn(() => user !== null),
  } as unknown as AuthPort;
}

beforeEach(() => {
  localStorage.removeItem(CREW_PREFERENCE_STORAGE_KEY);
  localStorage.removeItem(ROWER_APPEARANCE_STORAGE_KEY);
});

// #777: the profile page hosts linked accounts, the moved appearance picker and
// a reserved Preferences stub.
describe('ProfilePage.svelte', () => {
  it('renders the three sections and a link back to the Row screen', () => {
    const { container } = render(ProfilePageHarness, {
      store: new AuthStore(stubAuth(null)),
      backHref: '/virtualrow/app/',
    });

    expect(container.querySelector('[data-testid="profile-page"]')).not.toBeNull();
    for (const id of ['linked-accounts', 'rower-appearance', 'preferences']) {
      expect(container.querySelector(`[data-testid="profile-section-${id}"] h2`)).not.toBeNull();
    }
    expect(container.querySelector('.profile-page__back')?.getAttribute('href')).toBe(
      '/virtualrow/app/',
    );
  });

  it('defaults the back link to the site root', () => {
    const { container } = render(ProfilePageHarness, { store: new AuthStore(stubAuth(null)) });
    expect(container.querySelector('.profile-page__back')?.getAttribute('href')).toBe('/');
  });

  it('hosts the rower appearance picker, Male / Female / Auto included', () => {
    const { container } = render(ProfilePageHarness, { store: new AuthStore(stubAuth(null)) });
    const section = container.querySelector('[data-testid="profile-section-rower-appearance"]');
    expect(section?.querySelector('[data-testid="rower-appearance"]')).not.toBeNull();
    expect(section?.querySelector('[aria-label="Rower appearance"][role="radiogroup"]')).not.toBeNull();
  });

  it('persists a crew and an appearance change through the shared stores', async () => {
    const crew = new CrewPreferenceStore();
    const rowerAppearance = new RowerAppearanceStore();
    const { container } = render(ProfilePageHarness, {
      store: new AuthStore(stubAuth(null)),
      crew,
      rowerAppearance,
    });

    const female = Array.from(container.querySelectorAll<HTMLElement>('[role="radio"]')).find(
      (el) => el.textContent?.includes('Female'),
    );
    await fireEvent.click(female!);
    expect(crew.preference).toBe('female');
    expect(localStorage.getItem(CREW_PREFERENCE_STORAGE_KEY)).toBe('female');

    const swatch = container.querySelector<HTMLElement>(
      '.rower-appearance-swatches[aria-label="Top"] [role="radio"]:not(.is-selected)',
    );
    await fireEvent.click(swatch!);
    expect(rowerAppearance.appearance.top).not.toBe('navy');
    expect(localStorage.getItem(ROWER_APPEARANCE_STORAGE_KEY)).toContain(
      rowerAppearance.appearance.top,
    );
  });

  it('offers a guest the intervals.icu connect, which starts the sign-in', async () => {
    const startLogin = vi.fn(async () => {});
    const { container } = render(ProfilePageHarness, {
      store: new AuthStore(stubAuth(null, startLogin)),
    });

    const row = container.querySelector('[data-testid="linked-account-intervals-icu"]');
    expect(row?.textContent).toContain('Sign in to save your rows');
    const connect = row?.querySelector<HTMLButtonElement>('.linked-account__action--primary');
    expect(connect?.textContent).toContain('Connect intervals.icu');
    await fireEvent.click(connect!);
    expect(startLogin).toHaveBeenCalledTimes(1);
  });

  it('reports a failed connect next to the row', async () => {
    const startLogin = vi.fn(async () => {
      throw new Error('popup blocked');
    });
    const { container, findByRole } = render(ProfilePageHarness, {
      store: new AuthStore(stubAuth(null, startLogin)),
    });
    await fireEvent.click(container.querySelector('.linked-account__action--primary')!);
    expect((await findByRole('alert')).textContent).toContain('popup blocked');
  });

  it('falls back to a generic message for a non-Error rejection', async () => {
    const startLogin = vi.fn(() => Promise.reject('nope'));
    const { container, findByRole } = render(ProfilePageHarness, {
      store: new AuthStore(stubAuth(null, startLogin)),
    });
    await fireEvent.click(container.querySelector('.linked-account__action--primary')!);
    expect((await findByRole('alert')).textContent).toContain('Login failed');
  });

  it('shows a signed-in athlete as connected, and disconnects', async () => {
    const service = stubAuth(USER);
    const store = new AuthStore(service);
    const { container } = render(ProfilePageHarness, { store });

    const row = container.querySelector('[data-testid="linked-account-intervals-icu"]')!;
    expect(row.textContent).toContain('Connected as Dana Rower');
    const disconnect = row.querySelector<HTMLButtonElement>('.linked-account__action')!;
    expect(disconnect.textContent).toContain('Disconnect');
    await fireEvent.click(disconnect);
    expect(service.logout).toHaveBeenCalledTimes(1);
    expect(store.user).toBeNull();
  });

  it('shows the sign-in in progress without an action', () => {
    const store = new AuthStore(stubAuth(null));
    store.isLoading = true;
    const { container } = render(ProfilePageHarness, { store });
    const row = container.querySelector('[data-testid="linked-account-intervals-icu"]')!;
    expect(row.textContent).toContain('Signing in…');
    expect(row.querySelector('.linked-account__action')).toBeNull();
  });

  it('shows Strava as a disabled placeholder', () => {
    const { container } = render(ProfilePageHarness, { store: new AuthStore(stubAuth(null)) });
    const row = container.querySelector('[data-testid="linked-account-strava"]')!;
    expect(row.textContent).toContain('Coming soon');
    expect(row.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
  });
});

// #777 D2 / D8: AuthButton's ways into the profile page.
describe('AuthButton profile entry points', () => {
  it('gives a guest a Preferences link to the profile page', () => {
    const { container } = render(AuthButtonProfileHarness, {
      store: new AuthStore(stubAuth(null)),
      profileHref: '/virtualrow/app/profile',
    });
    const link = container.querySelector('.auth-profile-link');
    expect(link?.getAttribute('href')).toBe('/virtualrow/app/profile');
    expect(link?.getAttribute('aria-label')).toBe('Preferences');
    expect(container.querySelector('.auth-button--signin')).not.toBeNull();
  });

  it('defaults the profile link to /profile', () => {
    const { container } = render(AuthButtonProfileHarness, { store: new AuthStore(stubAuth(null)) });
    expect(container.querySelector('.auth-profile-link')?.getAttribute('href')).toBe('/profile');
  });

  it('adds Profile to a signed-in athlete’s menu, which closes on click', async () => {
    const { container } = render(AuthButtonProfileHarness, {
      store: new AuthStore(stubAuth(USER)),
      profileHref: '/profile',
    });
    await fireEvent.click(container.querySelector('.auth-user-trigger')!);
    const item = container.querySelector('.auth-dropdown-item--profile');
    expect(item?.getAttribute('role')).toBe('menuitem');
    expect(item?.getAttribute('href')).toBe('/profile');
    item!.addEventListener('click', (e) => e.preventDefault());
    await fireEvent.click(item!);
    expect(container.querySelector('.auth-dropdown')).toBeNull();
  });

  it('hides both entry points during a row', async () => {
    const guest = render(AuthButtonProfileHarness, {
      store: new AuthStore(stubAuth(null)),
      showProfile: false,
    });
    expect(guest.container.querySelector('.auth-profile-link')).toBeNull();

    const signedIn = render(AuthButtonProfileHarness, {
      store: new AuthStore(stubAuth(USER)),
      showProfile: false,
    });
    await fireEvent.click(signedIn.container.querySelector('.auth-user-trigger')!);
    expect(signedIn.container.querySelector('.auth-dropdown-item--profile')).toBeNull();
    expect(signedIn.container.querySelector('.auth-dropdown-item--signout')).not.toBeNull();
  });
});
