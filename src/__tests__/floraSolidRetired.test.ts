/**
 * #623 Phase 1 / AC1-AC2 — the procedural solid-flora stage is retired.
 *
 * The compile-time guarantee comes from the deletion of
 * `floraSolidPool.ts`, `floraSolidStage.ts`, `floraSolid.ts`,
 * `floraSolid.wgsl`, `floraSolidDepth.ts`, `floraSolidDepth.wgsl` and
 * their test. This spec adds a runtime check that nothing on disk
 * under `src/lib/renderer/plan` or `src/lib/renderer/passes` carries
 * `floraSolid` in its filename anymore, so a future revive stands out
 * and AC1 stays enforced.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const planDir = path.resolve(here, '../lib/renderer/plan');
const passesDir = path.resolve(here, '../lib/renderer/passes');
const engineDir = path.resolve(here, '../lib/renderer/engine');

const listAll = (dir: string): string[] => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listAll(full));
    else out.push(full);
  }
  return out;
};

describe('#623 Phase 1 retirement of the procedural solid-flora pass', () => {
  it('AC1 — no files named floraSolid* remain under plan/, passes/ or engine/', () => {
    const all = [...listAll(planDir), ...listAll(passesDir), ...listAll(engineDir)];
    const floraSolidFiles = all.filter((f) => /floraSolid/i.test(path.basename(f)));
    expect(floraSolidFiles).toEqual([]);
  });
});
