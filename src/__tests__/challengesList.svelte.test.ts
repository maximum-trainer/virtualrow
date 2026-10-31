import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';

import ChallengesListHarness from './fixtures/ChallengesListHarness.svelte';
import type { Services } from '../lib/ports';
import type { Challenge } from '../lib/services/challengesService';

/**
 * #415 Phase 2 — ChallengesList DOM contract. The three filters, the
 * empty state (AC2.4), handicap badge (AC2.2), inert notes (AC2.5), and
 * that a card the mirror cannot resolve leaves the rest readable (AC3.3).
 */

function challenge(partial: Partial<Challenge>): Challenge {
  return {
    id: 'c',
    name: 'Challenge',
    courseId: '273',
    courseName: 'Twentekanaal 1 km',
    distanceMeters: 1044,
    rowStart: new Date('2026-11-01T06:00:00Z'),
    rowEnd: new Date('2026-11-30T18:00:00Z'),
    submitEnd: new Date('2026-12-01T18:00:00Z'),
    hasHandicap: false,
    organizerName: null,
    resultsCount: 0,
    notes: null,
    ...partial,
  };
}

function stubServices(
  listChallenges: ReturnType<typeof vi.fn>,
  overrides?: Partial<Services>,
): Partial<Services> {
  return {
    challengesService: {
      listChallenges,
      challengeResults: vi.fn(async () => []),
    } as unknown as Services['challengesService'],
    ...overrides,
  };
}

describe('ChallengesList.svelte', () => {
  it('fetches the active list on mount and renders the three filter buttons', async () => {
    const listChallenges = vi.fn().mockResolvedValue([]);
    const { container } = render(ChallengesListHarness, {
      overrides: stubServices(listChallenges),
    });

    await waitFor(() => expect(listChallenges).toHaveBeenCalledWith('active'));
    expect(container.querySelector('[data-testid="challenges-filter-active"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="challenges-filter-upcoming"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="challenges-filter-past"]')).not.toBeNull();
  });

  it('shows the empty state when the fetched list is empty (AC2.4)', async () => {
    const listChallenges = vi.fn().mockResolvedValue([]);
    const { container } = render(ChallengesListHarness, {
      overrides: stubServices(listChallenges),
    });

    await waitFor(() =>
      expect(container.querySelector('[data-testid="challenges-empty"]')).not.toBeNull(),
    );
    expect(screen.getByTestId('challenges-empty').textContent).toContain('No challenges here yet');
  });

  it('renders a card per challenge with name, course, distance, window, results (AC2.2)', async () => {
    const list = [
      challenge({ id: 'a', name: 'Enschede', hasHandicap: true, resultsCount: 12 }),
      challenge({
        id: 'b',
        name: 'Mortlake Autumn',
        courseName: 'Thames tideway',
        distanceMeters: 6800,
        resultsCount: 1,
      }),
    ];
    const { container } = render(ChallengesListHarness, {
      overrides: stubServices(vi.fn().mockResolvedValue(list)),
    });

    await waitFor(() =>
      expect(container.querySelectorAll('[data-testid="challenge-card"]')).toHaveLength(2),
    );

    const cards = container.querySelectorAll('[data-testid="challenge-card"]');
    expect(cards[0].getAttribute('data-challenge-id')).toBe('a');
    expect(cards[0].querySelector('[data-testid="challenge-handicap"]')).not.toBeNull();
    expect(cards[0].querySelector('[data-testid="challenge-results-count"]')?.textContent)
      .toContain('12 results');

    // 1-result card uses the singular form.
    expect(cards[1].querySelector('[data-testid="challenge-results-count"]')?.textContent)
      .toContain('1 result');
    // No handicap badge on the second card.
    expect(cards[1].querySelector('[data-testid="challenge-handicap"]')).toBeNull();
  });

  it('switches the active filter and re-fetches once per status (AC1.4 / AC2.1)', async () => {
    const listChallenges = vi.fn().mockResolvedValue([]);
    const { container } = render(ChallengesListHarness, {
      overrides: stubServices(listChallenges),
    });

    await waitFor(() => expect(listChallenges).toHaveBeenCalledWith('active'));

    await fireEvent.click(container.querySelector('[data-testid="challenges-filter-upcoming"]')!);
    await waitFor(() => expect(listChallenges).toHaveBeenCalledWith('upcoming'));

    await fireEvent.click(container.querySelector('[data-testid="challenges-filter-past"]')!);
    await waitFor(() => expect(listChallenges).toHaveBeenCalledWith('past'));

    // One call per status; the service's own cache would collapse re-clicks.
    expect(listChallenges).toHaveBeenCalledTimes(3);
  });

  it('renders notes as inert text — a URL inside stays as text, not a link (AC2.5)', async () => {
    const list = [challenge({ notes: 'See http://evil.example/pwn and <b>bold</b> text.' })];
    const { container } = render(ChallengesListHarness, {
      overrides: stubServices(vi.fn().mockResolvedValue(list)),
    });

    await waitFor(() =>
      expect(container.querySelector('[data-testid="challenge-notes"]')).not.toBeNull(),
    );

    const notes = container.querySelector('[data-testid="challenge-notes"]')!;
    // No <a> or <b> element made it in — Svelte escapes HTML, and the view
    // never calls a linkifier.
    expect(notes.querySelector('a')).toBeNull();
    expect(notes.querySelector('b')).toBeNull();
    // The URL is still visible as text.
    expect(notes.textContent).toContain('http://evil.example/pwn');
    expect(notes.textContent).toContain('<b>bold</b>');
  });

  it('invokes onRowChallenge with the clicked challenge', async () => {
    const list = [challenge({ id: 'row-me' })];
    const onRowChallenge = vi.fn();
    const { container } = render(ChallengesListHarness, {
      overrides: stubServices(vi.fn().mockResolvedValue(list)),
      onRowChallenge,
    });

    await waitFor(() =>
      expect(container.querySelector('[data-testid="challenge-row-button"]')).not.toBeNull(),
    );

    await fireEvent.click(container.querySelector('[data-testid="challenge-row-button"]')!);
    expect(onRowChallenge).toHaveBeenCalledTimes(1);
    expect(onRowChallenge.mock.calls[0][0]).toMatchObject({ id: 'row-me' });
  });
});
