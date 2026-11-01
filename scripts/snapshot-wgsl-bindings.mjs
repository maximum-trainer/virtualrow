#!/usr/bin/env node
/**
 * One-shot: regenerate the per-pass binding-group snapshot that
 * `src/lib/renderer/passes/__tests__/wgsl.test.ts` asserts against
 * (#588 FR5). Run after a deliberate layout change:
 *
 *   node scripts/snapshot-wgsl-bindings.mjs
 *
 * Commit the resulting JSON. A drift from the committed snapshot is
 * what the test flips red on — the regenerator exists so a planned
 * reorder stays a one-line review diff.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';

const here = dirname(fileURLToPath(import.meta.url));
const passesDir = join(here, '..', 'src', 'lib', 'renderer', 'passes');
const snapshotPath = join(passesDir, '__tests__', 'wgsl-bindings.snapshot.json');

const normaliseBindings = (reflect) => {
  // `getBindGroups()` is a sparse array indexed by @group — holes are
  // valid (a shader may bind group 0 and 2 but not 1). Each slot is a
  // sparse array indexed by @binding. Walk flatly, skipping holes.
  const groups = reflect.getBindGroups();
  const rows = [];
  for (const group of groups) {
    if (!group) continue;
    for (const entry of group) {
      if (!entry) continue;
      rows.push({
        group: entry.group,
        binding: entry.binding,
        name: entry.name,
        resourceType: entry.resourceType,
      });
    }
  }
  rows.sort((a, b) => (a.group - b.group) || (a.binding - b.binding));
  return rows;
};

const shaders = readdirSync(passesDir).filter((f) => f.endsWith('.wgsl')).sort();
const snapshot = {};
for (const file of shaders) {
  const src = readFileSync(join(passesDir, file), 'utf8');
  const reflect = new WgslReflect(src);
  snapshot[file] = normaliseBindings(reflect);
}

writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n');
console.log(`Wrote ${snapshotPath} (${shaders.length} passes)`);
