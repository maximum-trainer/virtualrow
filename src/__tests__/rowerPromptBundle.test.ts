/**
 * Doc-smoke for the LLM-cad rower prompt bundle (#590 AC9 / T10).
 *
 * The bundle under `prompts/rower-generation/` is checked in so a
 * regenerate run has one deterministic place to look up the aesthetic
 * targets and the proportion-tuning bounds. If a future refactor
 * silently moves or renames these files, the monthly workflow would
 * carry on happily — this doc-smoke keeps the paths honest.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const BUNDLE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..',
  'prompts', 'rower-generation',
);

describe('rower-generation prompt bundle (#590 AC9)', () => {
  it('ships a README that names biketerra, exr-game and mywhoosh', () => {
    const path = join(BUNDLE, 'README.md');
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text.toLowerCase()).toMatch(/biketerra/);
    expect(text.toLowerCase()).toMatch(/exr-game/);
    expect(text.toLowerCase()).toMatch(/mywhoosh/);
  });

  it('ships a per-style brief for each reference', () => {
    for (const slug of ['biketerra', 'exr-game', 'mywhoosh']) {
      const path = join(BUNDLE, `${slug}.md`);
      expect(existsSync(path), `${slug}.md`).toBe(true);
      const text = readFileSync(path, 'utf8');
      expect(text.length).toBeGreaterThan(200);
    }
  });
});
