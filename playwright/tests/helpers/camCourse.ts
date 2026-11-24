/**
 * #753 — rownative course 171 (Head of the Cam) served from the recorded
 * fixtures the unit tests use (`src/__tests__/fixtures/overpass/`), so a spec
 * can import a real gates-only river course without the network.
 */
import { expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockBluetoothPath = path.resolve(__dirname, '../../mock-bluetooth.js');
const fixtures = path.resolve(__dirname, '../../../src/__tests__/fixtures/overpass');
const COURSE = fs.readFileSync(path.join(fixtures, 'course-171.json'), 'utf8');
const OVERPASS = fs.readFileSync(path.join(fixtures, 'overpass-171.json'), 'utf8');

/** Serve course 171, and Overpass either from the recording or failing. */
export async function serveCamCourse(page: Page, overpass: 'recorded' | 'failing'): Promise<void> {
  await page.addInitScript({ content: fs.readFileSync(mockBluetoothPath, 'utf8') });
  // The crash-watch fixture refuses the map hosts by default; Overpass is
  // served here, so let the requests reach `page.route`.
  await page.addInitScript(() => {
    (window as unknown as { __E2E_ENRICHMENT_NETWORK?: boolean }).__E2E_ENRICHMENT_NETWORK = true;
  });
  await page.route('**/rownative/courses/**/171.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: COURSE }),
  );
  await page.route('**/rownative.icu/api/**', (route) => route.abort());
  const headers = { 'Access-Control-Allow-Origin': '*' };
  await page.route((url) => url.hostname === 'overpass-api.de' || url.hostname === 'overpass.kumi.systems', (route) =>
    overpass === 'recorded'
      ? route.fulfill({ status: 200, contentType: 'application/json', headers, body: OVERPASS })
      : route.fulfill({ status: 502, contentType: 'text/plain', headers, body: 'at capacity' }),
  );
}

/** Import course 171 through the Routes screen. */
export async function importCamCourse(page: Page): Promise<void> {
  await page.goto('./');
  await page.getByRole('button', { name: 'Routes', exact: true }).click();
  await page.getByLabel('Rownative course import').waitFor({ state: 'visible' });
  await page.getByLabel('Rownative course ID or link').fill('171');
  await page.getByRole('button', { name: /^Import$/ }).click();
  await expect(page.locator('.route-info-overlay h2')).toContainText('Head of the Cam', { timeout: 15_000 });
}
