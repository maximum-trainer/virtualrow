#!/usr/bin/env node
/*
 * Build the bundled rownative-index snapshot (#822 phase 1).
 *
 * The browser needs every rownative course as a map pin at its real
 * location (FR8) without any runtime network call (NFR3), so this
 * script fetches the upstream index once at build / CI time, filters
 * it to the set Dan agreed on (D14: established status, valid
 * WGS84 centre), and writes `public/assets/rownative/rownative-index.json`
 * as a stably-sorted, pretty-printed array.
 *
 * Usage:
 *   node scripts/build_rownative_index.mjs           # fetch + write
 *   node scripts/build_rownative_index.mjs --dry-run # fetch + count
 *
 * The upstream index already carries `center_lat` / `center_lon` per
 * course (confirmed on the public mirror 2026-11-24), so this script
 * does NOT fetch per-course detail JSON — a plain re-shape of the
 * mirror's index plus the filter rule covers phase 1.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  buildBundledIndex,
  isUsableMirrorEntry,
} from '../src/lib/services/rownativeBundledIndex.ts';

const MIRROR_INDEX_URL = 'https://raw.githubusercontent.com/rownative/courses/main/courses/index.json';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(here, '..', 'public', 'assets', 'rownative', 'rownative-index.json');

async function fetchMirrorIndex() {
  const response = await fetch(MIRROR_INDEX_URL);
  if (!response.ok) {
    throw new Error(`Mirror index HTTP ${response.status} at ${MIRROR_INDEX_URL}`);
  }
  const raw = await response.json();
  if (!Array.isArray(raw)) {
    throw new Error('Mirror index is not an array');
  }
  return raw;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  let raw;
  try {
    raw = await fetchMirrorIndex();
  } catch (err) {
    // CI job may run on a day the mirror is unreachable; stay green
    // (the committed snapshot on main is still the source of truth).
    console.warn(`[rownative-index] skip: ${err instanceof Error ? err.message : err}`);
    process.exit(0);
  }

  const kept = raw.filter(isUsableMirrorEntry).length;
  const dropped = raw.length - kept;
  const bundled = buildBundledIndex(raw);
  const json = `${JSON.stringify(bundled, null, 2)}\n`;
  const gzSize = gzipSync(json).byteLength;

  console.log(`[rownative-index] upstream=${raw.length} kept=${kept} dropped=${dropped} gzip=${gzSize}B`);

  if (gzSize > 100 * 1024) {
    // NFR5 (#822): the snapshot must stay under 100 KB gzipped.
    throw new Error(`Bundle too large: ${gzSize} B gzipped (> 100 KB).`);
  }

  if (dryRun) {
    console.log('[rownative-index] --dry-run: no file written.');
    return;
  }

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, json, 'utf8');
  console.log(`[rownative-index] wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
