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
  challengeResults: ReturnType<typeof vi.fn> = vi.fn(async () => []),
  overrides?: Partial<Services>,
): Partial<Services> {
  return {
    challengesService: {
      listChallenges,
      challengeResults,
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

  it('shows an inline "course missing from mirror" message when Row returns false (AC3.3)', async () => {
    const list = [challenge({ id: 'orphan' })];
    const onRowChallenge = vi.fn().mockResolvedValue(false);
    const { container } = render(ChallengesListHarness, {
      overrides: stubServices(vi.fn().mockResolvedValue(list)),
      onRowChallenge,
    });

    await waitFor(() =>
      expect(container.querySelector('[data-testid="challenge-row-button"]')).not.toBeNull(),
    );
    // No message before the click.
    expect(container.querySelector('[data-testid="challenge-missing-course"]')).toBeNull();

    await fireEvent.click(container.querySelector('[data-testid="challenge-row-button"]')!);

    await waitFor(() =>
      expect(container.querySelector('[data-testid="challenge-missing-course"]')).not.toBeNull(),
    );
    // The rest of the card is still readable.
    expect(container.querySelector('[data-testid="challenge-course"]')).not.toBeNull();
  });
});

describe('ChallengesList leaderboard panel (#415 Phase 3)', () => {
  it('fetches the leaderboard once when a card is expanded and lists its rows (AC4.2/4.3)', async () => {
    const list = [challenge({ id: 'enschede', distanceMeters: 1044 })];
    const results = [
      {
        rank: 1,
        displayName: 'Sander Roosendaal',
        rawTimeSeconds: 278.0,
        correctedTimeSeconds: null,
        points: 100,
        boatType: null,
        workoutDate: null,
        validationStatus: 'valid',
      },
      {
        rank: 2,
        displayName: 'Pending Peter',
        rawTimeSeconds: 290.0,
        correctedTimeSeconds: null,
        points: null,
        boatType: null,
        workoutDate: null,
        validationStatus: 'pending',
      },
    ];
    const challengeResults = vi.fn().mockResolvedValue(results);
    const { container } = render(ChallengesListHarness, {
      overrides: stubServices(vi.fn().mockResolvedValue(list), challengeResults),
      onRaceResult: vi.fn(),
    });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="challenge-leaderboard-toggle"]')).not.toBeNull(),
    );

    await fireEvent.click(
      container.querySelector('[data-testid="challenge-leaderboard-toggle"]')!,
    );

    await waitFor(() =>
      expect(container.querySelectorAll('[data-testid="leaderboard-row"]')).toHaveLength(2),
    );
    expect(challengeResults).toHaveBeenCalledTimes(1);
    expect(challengeResults).toHaveBeenCalledWith('enschede');

    const rows = container.querySelectorAll('[data-testid="leaderboard-row"]');
    // AC4.2: raceable flag drives presentation; the pending row has no Race button.
    expect(rows[0].getAttribute('data-raceable')).toBe('true');
    expect(rows[0].querySelector('[data-testid="leaderboard-race-button"]')).not.toBeNull();
    expect(rows[1].getAttribute('data-raceable')).toBe('false');
    expect(rows[1].querySelector('[data-testid="leaderboard-race-button"]')).toBeNull();
    expect(rows[1].querySelector('[data-testid="leaderboard-row-status"]')?.textContent)
      .toContain('pending');
  });

  it('shows "No results on this leaderboard yet" when the API returns [] (AC4.5)', async () => {
    const list = [challenge({ id: 'empty' })];
    const { container } = render(ChallengesListHarness, {
      overrides: stubServices(vi.fn().mockResolvedValue(list), vi.fn().mockResolvedValue([])),
      onRowChallenge: vi.fn(),
    });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="challenge-leaderboard-toggle"]')).not.toBeNull(),
    );

    await fireEvent.click(
      container.querySelector('[data-testid="challenge-leaderboard-toggle"]')!,
    );

    await waitFor(() =>
      expect(container.querySelector('[data-testid="leaderboard-empty"]')).not.toBeNull(),
    );
    // Row-the-course is still available: the top-level Row button is unchanged.
    expect(container.querySelector('[data-testid="challenge-row-button"]')).not.toBeNull();
  });

  it('shows the corrected time but no Race button is tied to it (AC4.3)', async () => {
    const list = [challenge({ id: 'hcap', hasHandicap: true, distanceMeters: 1000 })];
    const results = [
      {
        rank: 1,
        displayName: 'Rower',
        rawTimeSeconds: 220.0,
        correctedTimeSeconds: 210.0,
        points: 100,
        boatType: '1x',
        workoutDate: null,
        validationStatus: 'valid',
      },
    ];
    const { container } = render(ChallengesListHarness, {
      overrides: stubServices(vi.fn().mockResolvedValue(list), vi.fn().mockResolvedValue(results)),
      onRaceResult: vi.fn(),
    });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="challenge-leaderboard-toggle"]')).not.toBeNull(),
    );
    await fireEvent.click(
      container.querySelector('[data-testid="challenge-leaderboard-toggle"]')!,
    );

    await waitFor(() =>
      expect(container.querySelector('[data-testid="leaderboard-corrected"]')).not.toBeNull(),
    );
    const button = container.querySelector('[data-testid="leaderboard-race-button"]')!;
    // The button's title names the pace it will set — a function of raw
    // time, not corrected: 220s over 1000m → 110s/500m → 1:50.0 pace.
    expect(button.getAttribute('title')).toContain('1:50');
  });

  it('invokes onRaceResult with the challenge and the clicked row', async () => {
    const list = [challenge({ id: 'enschede', distanceMeters: 1044 })];
    const results = [
      {
        rank: 1,
        displayName: 'Sander Roosendaal',
        rawTimeSeconds: 278.0,
        correctedTimeSeconds: null,
        points: null,
        boatType: null,
        workoutDate: null,
        validationStatus: 'valid',
      },
    ];
    const onRaceResult = vi.fn();
    const { container } = render(ChallengesListHarness, {
      overrides: stubServices(vi.fn().mockResolvedValue(list), vi.fn().mockResolvedValue(results)),
      onRaceResult,
    });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="challenge-leaderboard-toggle"]')).not.toBeNull(),
    );
    await fireEvent.click(
      container.querySelector('[data-testid="challenge-leaderboard-toggle"]')!,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-testid="leaderboard-race-button"]')).not.toBeNull(),
    );

    await fireEvent.click(
      container.querySelector('[data-testid="leaderboard-race-button"]')!,
    );

    expect(onRaceResult).toHaveBeenCalledTimes(1);
    expect(onRaceResult.mock.calls[0][0]).toMatchObject({ id: 'enschede' });
    expect(onRaceResult.mock.calls[0][1]).toMatchObject({ displayName: 'Sander Roosendaal' });
  });
});
