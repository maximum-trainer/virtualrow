/**
 * #777 — the Profile screen. The rower appearance picker moved here from the
 * Row screen; the header leads to it (a Preferences link for a guest, a Profile
 * item in a signed-in athlete's menu), and a choice made here is what the next
 * row reads.
 */

import { test, expect, type Page } from '../fixtures/crash-watch';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockBluetoothPath = path.resolve(__dirname, '../mock-bluetooth.js');

async function installMocks(page: Page) {
  await page.addInitScript({ content: fs.readFileSync(mockBluetoothPath, 'utf8') });
}

test.describe('profile page', () => {
  test('a guest reaches it from the header and the choice persists', async ({ page }) => {
    await installMocks(page);
    await page.goto('./');
    await page.waitForSelector('.app-header', { timeout: 10_000 });

    // The picker is no longer on the Row screen.
    await expect(page.locator('.btn-try-demo')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="rower-appearance"]')).toHaveCount(0);

    await page.locator('.auth-profile-link').click();
    await expect(page).toHaveURL(/\/profile\/?$/);
    await expect(page.locator('[data-testid="profile-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="profile-section-linked-accounts"]')).toBeVisible();
    await expect(page.locator('[data-testid="profile-section-preferences"]')).toBeVisible();
    await expect(page.locator('[data-testid="linked-account-strava"] button')).toBeDisabled();

    const picker = page.locator(
      '[data-testid="profile-section-rower-appearance"] [data-testid="rower-appearance"]',
    );
    await expect(picker).toHaveCount(1);

    const female = page.getByRole('radio', { name: 'Female', exact: true });
    await female.click();
    await expect(female).toHaveAttribute('aria-checked', 'true');
    expect(await page.evaluate(() => localStorage.getItem('virtualrow:crew'))).toBe('female');

    // Back to the Row screen and in again: the choice survived.
    await page.locator('.profile-page__back').click();
    await expect(page.locator('.btn-try-demo')).toBeVisible({ timeout: 15_000 });
    await page.goto('./profile');
    await expect(page.getByRole('radio', { name: 'Female', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  test('a signed-in athlete reaches it from the account menu', async ({ page }) => {
    await installMocks(page);
    await page.addInitScript(() => {
      sessionStorage.setItem(
        'vr_auth_user',
        JSON.stringify({ id: 'i123', name: 'Alice', email: '' }),
      );
      sessionStorage.setItem('vr_auth_athlete_id', 'i123');
      sessionStorage.setItem('vr_auth_refresh_token', 'test-refresh');
    });
    await page.route('**/proxy/api/oauth/token', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ access_token: 'test-access', expires_in: 3600, token_type: 'Bearer' }),
      });
    });

    await page.goto('./');
    const trigger = page.locator('.auth-user-trigger');
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await trigger.click();
    await page.locator('.auth-dropdown-item--profile').click();

    await expect(page).toHaveURL(/\/profile\/?$/);
    await expect(page.locator('[data-testid="linked-account-intervals-icu"]')).toContainText(
      'Connected as Alice',
    );
  });
});
