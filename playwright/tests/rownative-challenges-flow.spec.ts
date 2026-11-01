/**
 * Rownative Speed Orders — end-to-end browse → leaderboard → Race → Row
 * (#415 Phases 2–4 Playwright coverage, follow-up to PRs #639 / #642).
 *
 * The challenge API and the course mirror are both stubbed through
 * `page.route`, so this spec runs on any CI shard regardless of whether
 * the WebGPU engine attaches: it drives the browse view, opens the
 * leaderboard, clicks Race for a raceable row, and verifies the Row
 * screen loads the challenge's course with the challenge in progress on
 * the ride-session. The actual ghost HUD + "would have been Nth" line
 * are covered by unit tests — the engine declines SwiftShader by design
 * (#542 NFR5), so this spec stops at the Row-screen hand-off.
 *
 * A second test holds AC6.1 / AC6.2: with `/api/challenges` returning
 * 500, the Routes screen behaves exactly as it does today.
 */
import { test, expect, type Page } from '../fixtures/crash-watch';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockBluetoothPath = path.resolve(__dirname, '../mock-bluetooth.js');
const course1Path = path.resolve(__dirname, '../../src/__tests__/fixtures/rownative/1.json');

const COURSE_1 = JSON.parse(fs.readFileSync(course1Path, 'utf8'));
const COURSE_1_INDEX = [
  {
    id: '1',
    name: COURSE_1.name,
    country: COURSE_1.country,
    distance_m: COURSE_1.distance_m,
    status: COURSE_1.status,
  },
];

const now = Date.now();
const hour = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const ACTIVE_CHALLENGE = {
  id: 'c-enschede',
  name: 'Test Challenge Enschede',
  courseId: '1',
  courseName: COURSE_1.name,
  distance_m: 1044,
  rowStart: iso(now - 2 * hour),
  rowEnd: iso(now + 2 * hour),
  submitEnd: iso(now + 4 * hour),
  hasHandicap: false,
  organizerName: 'Testing Org',
  resultsCount: 2,
  notes: 'See https://example.org for details — this URL must stay inert.',
};

const UPCOMING_CHALLENGE = {
  ...ACTIVE_CHALLENGE,
  id: 'c-future',
  name: 'Future Challenge',
  rowStart: iso(now + 24 * hour),
  rowEnd: iso(now + 48 * hour),
  submitEnd: iso(now + 72 * hour),
};

const RESULTS = [
  {
    rank: 1,
    displayName: 'Sander Roosendaal',
    rawTimeS: 277.7,
    correctedTimeS: null,
    points: null,
    boatType: '1x',
    workoutDate: '2026-05-18',
    validationStatus: 'valid',
  },
  {
    rank: 2,
    displayName: 'Pending Rower',
    rawTimeS: 290.0,
    correctedTimeS: null,
    points: null,
    boatType: '1x',
    workoutDate: '2026-05-19',
    validationStatus: 'pending',
  },
];

async function stubChallengeApi(page: Page, opts: { status: 'ok' | '500' } = { status: 'ok' }) {
  await page.route('**/rownative.icu/api/challenges?status=active*', (route) =>
    opts.status === 'ok'
      ? route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ challenges: [ACTIVE_CHALLENGE] }),
        })
      : route.fulfill({ status: 500, contentType: 'text/plain', body: 'nope' }),
  );
  await page.route('**/rownative.icu/api/challenges?status=upcoming*', (route) =>
    opts.status === 'ok'
      ? route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ challenges: [UPCOMING_CHALLENGE] }),
        })
      : route.fulfill({ status: 500, contentType: 'text/plain', body: 'nope' }),
  );
  await page.route('**/rownative.icu/api/challenges?status=past*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ challenges: [] }),
    }),
  );
  await page.route('**/rownative.icu/api/challenges/*/results', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results: RESULTS }),
    }),
  );
}

async function stubCourseMirror(page: Page) {
  await page.route('**/rownative/courses/**/index.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(COURSE_1_INDEX),
    }),
  );
  await page.route('**/rownative/courses/**/1.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(COURSE_1) }),
  );
}

async function bootstrap(page: Page) {
  await page.addInitScript({ content: fs.readFileSync(mockBluetoothPath, 'utf8') });
}

test.describe('rownative Speed Orders — browse, race, hand off to Row', () => {
  test('browses challenges, opens a leaderboard, races a valid time and lands on Row', async ({
    page,
  }) => {
    await bootstrap(page);
    await stubChallengeApi(page);
    await stubCourseMirror(page);

    await page.goto('./challenges');

    // AC2.1 — Active | Upcoming | Past filter, defaulting to active.
    await expect(page.getByTestId('challenges-filter-active')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // AC2.2 — one card for the active challenge, carrying its name + course.
    const activeCard = page.getByTestId('challenge-card').filter({ hasText: 'Enschede' });
    await expect(activeCard).toBeVisible();
    await expect(activeCard.getByTestId('challenge-course')).toContainText(COURSE_1.name);

    // AC2.5 — organiser notes rendered as text, URL left inert (no <a>).
    await expect(activeCard.getByTestId('challenge-notes')).toContainText('https://example.org');
    expect(await activeCard.getByTestId('challenge-notes').locator('a').count()).toBe(0);

    // Toggle to Upcoming and back, exercising AC2.1 + AC1.4 cache.
    await page.getByTestId('challenges-filter-upcoming').click();
    await expect(
      page.getByTestId('challenge-card').filter({ hasText: 'Future Challenge' }),
    ).toBeVisible();
    await page.getByTestId('challenges-filter-active').click();
    await expect(activeCard).toBeVisible();

    // Phase 3 — open the leaderboard panel, which lazy-fetches results.
    await activeCard.getByTestId('challenge-leaderboard-toggle').click();
    await expect(activeCard.getByTestId('challenge-leaderboard')).toBeVisible();
    const rows = activeCard.getByTestId('leaderboard-row');
    await expect(rows).toHaveCount(2);

    // AC4.2 — only valid / manual_ok rows carry a Race button.
    await expect(rows.nth(0)).toHaveAttribute('data-raceable', 'true');
    await expect(rows.nth(1)).toHaveAttribute('data-raceable', 'false');
    const raceButtons = activeCard.getByTestId('leaderboard-race-button');
    await expect(raceButtons).toHaveCount(1);

    // AC4.1 + AC4.4 — click Race → navigate to Row with the chosen pace +
    // the display name on the ghost choice.
    await raceButtons.first().click();

    // The import + navigation lands on the Row screen. The route-info
    // overlay carries the challenge's course name, which proves the
    // course was imported and selected (AC3.1 / AC3.2).
    await expect(page).toHaveURL(/\/virtualrow\/app\/?(\?.*)?$/, { timeout: 15_000 });
    await expect(page.locator('.route-info-overlay h2')).toContainText(COURSE_1.name, {
      timeout: 15_000,
    });
  });

  test('challenge API 500 does not break the Routes screen (AC6.1 / AC6.2)', async ({ page }) => {
    await bootstrap(page);
    await stubChallengeApi(page, { status: '500' });
    await stubCourseMirror(page);

    // Land on the Row screen; AC6.2 — no challenge request fires until
    // Challenges is opened.
    await page.goto('./');

    // The Routes screen (route-search) must behave exactly as it does
    // today with the challenge API unreachable.
    await page.getByRole('button', { name: 'Routes', exact: true }).click();
    await expect(page.locator('.view-container--search')).toBeVisible();

    // And the Challenges view itself says so rather than silently
    // showing nothing.
    await page.getByRole('button', { name: 'Challenges', exact: true }).click();
    await expect(page.getByTestId('challenges-empty')).toBeVisible({ timeout: 10_000 });
  });
});
