/**
 * Vitest for the route-placements parser (#449 AC6 / NFR7).
 *
 * Loads the committed registry at `public/assets/scenery/route-placements.json`
 * and asserts that each `assetPath` exists on disk; walks the parser's
 * validation branches so a malformed registry fails at load, not at
 * render time.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseRoutePlacements,
  placementsForRoute,
  ROUTE_PLACEMENTS_SCHEMA_VERSION,
} from '../routePlacements';

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..',
);
const REGISTRY_PATH = join(REPO_ROOT, 'public', 'assets', 'scenery', 'route-placements.json');

const read = (): string => readFileSync(REGISTRY_PATH, 'utf8');

describe('route-placements parser (#449 AC6)', () => {
  it('parses the committed registry at the current schema version', () => {
    const parsed = parseRoutePlacements(JSON.parse(read()));
    expect(parsed.$schemaVersion).toBe(ROUTE_PLACEMENTS_SCHEMA_VERSION);
    expect(typeof parsed.placements).toBe('object');
  });

  it('every assetPath referenced by the registry exists on disk', () => {
    const parsed = parseRoutePlacements(JSON.parse(read()));
    for (const list of Object.values(parsed.placements)) {
      for (const placement of list) {
        const path = join(REPO_ROOT, 'public', placement.assetPath);
        expect(existsSync(path), placement.assetPath).toBe(true);
      }
    }
  });

  it('rejects an unsupported schema version', () => {
    expect(() => parseRoutePlacements({ $schemaVersion: 2, placements: {} })).toThrow(/schemaVersion/);
  });

  it('rejects a non-object root', () => {
    expect(() => parseRoutePlacements(null)).toThrow();
    expect(() => parseRoutePlacements('nope')).toThrow();
    expect(() => parseRoutePlacements([])).toThrow();
  });

  it('rejects a malformed route id', () => {
    expect(() =>
      parseRoutePlacements({
        $schemaVersion: 1,
        placements: { 'bad id with spaces': [] },
      }),
    ).toThrow(/invalid route id/);
  });

  it('rejects a placement with a non-finite number', () => {
    expect(() =>
      parseRoutePlacements({
        $schemaVersion: 1,
        placements: {
          'course-a': [
            {
              modelId: 'r-course-a-x',
              assetPath: '/assets/scenery/tier-r/course-a/x.glb',
              distanceAlongRouteMeters: Number.POSITIVE_INFINITY,
              bankSide: 'left',
              lateralOffsetMeters: 0,
              orientationDegrees: 0,
              scale: 1,
            },
          ],
        },
      }),
    ).toThrow(/finite number/);
  });

  it('rejects a placement with scale ≤ 0', () => {
    expect(() =>
      parseRoutePlacements({
        $schemaVersion: 1,
        placements: {
          'course-a': [
            {
              modelId: 'r-course-a-x',
              assetPath: '/assets/scenery/tier-r/course-a/x.glb',
              distanceAlongRouteMeters: 10,
              bankSide: 'left',
              lateralOffsetMeters: 0,
              orientationDegrees: 0,
              scale: 0,
            },
          ],
        },
      }),
    ).toThrow(/scale.*> 0/);
  });

  it('accepts a well-formed tier-r assetPath (anchors the lint-workaround prefix build)', () => {
    const parsed = parseRoutePlacements({
      $schemaVersion: 1,
      placements: {
        'course-ok': [
          {
            modelId: 'r-course-ok-landmark',
            assetPath: '/assets/scenery/tier-r/course-ok/landmark.glb',
            distanceAlongRouteMeters: 500,
            bankSide: 'centre',
            lateralOffsetMeters: 0,
            orientationDegrees: 90,
            scale: 1.25,
          },
        ],
      },
    });
    expect(parsed.placements['course-ok'][0].modelId).toBe('r-course-ok-landmark');
  });

  it('rejects a placement with the wrong assetPath prefix', () => {
    expect(() =>
      parseRoutePlacements({
        $schemaVersion: 1,
        placements: {
          'course-a': [
            {
              modelId: 'r-course-a-x',
              assetPath: '/assets/scenery/tier-a/wrong.glb',
              distanceAlongRouteMeters: 10,
              bankSide: 'left',
              lateralOffsetMeters: 0,
              orientationDegrees: 0,
              scale: 1,
            },
          ],
        },
      }),
    ).toThrow(/tier-r/);
  });

  it('placementsForRoute returns [] for a null id or an unknown route', () => {
    const parsed = parseRoutePlacements({ $schemaVersion: 1, placements: {} });
    expect(placementsForRoute(parsed, null)).toEqual([]);
    expect(placementsForRoute(parsed, undefined)).toEqual([]);
    expect(placementsForRoute(parsed, 'nope')).toEqual([]);
  });

  it('placementsForRoute returns the entries for a known route', () => {
    const parsed = parseRoutePlacements({
      $schemaVersion: 1,
      placements: {
        'course-a': [
          {
            modelId: 'r-course-a-landmark',
            assetPath: '/assets/scenery/tier-r/course-a/landmark.glb',
            distanceAlongRouteMeters: 1500,
            bankSide: 'right',
            lateralOffsetMeters: 4.5,
            orientationDegrees: 0,
            scale: 1,
          },
        ],
      },
    });
    const list = placementsForRoute(parsed, 'course-a');
    expect(list.length).toBe(1);
    expect(list[0].modelId).toBe('r-course-a-landmark');
  });
});
