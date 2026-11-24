// Records real elevation fixtures for the #763 horizon relief tests.
//
//   npx vite-node scripts/record-landscape-fixtures.ts [courseId ...]   (default: 180 277)
//
// For each rownative course in src/__tests__/fixtures/rownative/<id>.json:
// take the route the import resolves (the recorded one in fixtures/osm/<id>.json
// when there is one, else resolved live against Overpass), load its landscape
// the way the app does, and write the elevation grid with the route to
// src/__tests__/fixtures/landscape/<id>.json. Heights are kept to 0.1 m.
// Needs network access to Open-Meteo (and Overpass for a course with no
// recorded route), so run it on a machine outside the cloud proxy.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Coordinate } from '../src/lib/types/index';
import { LandscapeService } from '../src/lib/services/landscapeService';
import { resolveCourseGeometry, type RownativeCourseGeometryInput } from '../src/lib/services/rownativeGeometry';
import { OsmWaterwayPathProvider } from '../src/lib/services/osmWaterwayPathProvider';

const FIXTURES = join(process.cwd(), 'src/__tests__/fixtures');
const OUT = join(FIXTURES, 'landscape');
const ids = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['180', '277'];

const routeFor = async (id: string, course: RownativeCourseGeometryInput): Promise<{ route: Coordinate[]; source: string }> => {
  const recorded = join(FIXTURES, 'osm', `${id}.json`);
  if (existsSync(recorded)) {
    const osm = JSON.parse(readFileSync(recorded, 'utf8')) as { route: Coordinate[] };
    return { route: osm.route, source: 'fixtures/osm' };
  }
  const fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init);
  const resolved = await resolveCourseGeometry(course, { osmProvider: new OsmWaterwayPathProvider(fetchImpl) });
  return { route: resolved.coordinates, source: resolved.source };
};

mkdirSync(OUT, { recursive: true });
for (const id of ids) {
  const course = JSON.parse(readFileSync(join(FIXTURES, 'rownative', `${id}.json`), 'utf8')) as RownativeCourseGeometryInput;
  const { route, source } = await routeFor(id, course);
  console.log(`${id}: route ${route.length} points from ${source}`);
  const service = new LandscapeService({ cache: null, publish: false, layerBudgetMs: 30 * 60_000 });
  const landscape = await service.load(route);
  const grid = landscape.elevation.data;
  if (!grid) {
    console.error(`${id}: no elevation (${landscape.elevation.source}); nothing written`);
    process.exitCode = 1;
    continue;
  }
  const heights = Array.from(grid.heights, (h) => (Number.isFinite(h) ? Math.round(h * 10) / 10 : null));
  const out = {
    courseId: id,
    name: (course as { name?: string }).name ?? '',
    recordedAt: new Date().toISOString(),
    routeSource: source,
    route,
    elevation: { ...grid, heights },
  };
  writeFileSync(join(OUT, `${id}.json`), `${JSON.stringify(out)}\n`);
  console.log(`${id}: ${grid.cols}x${grid.rows} grid, ${landscape.elevation.count} heights, complete=${grid.complete}`);
}
