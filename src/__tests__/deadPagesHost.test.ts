import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #738 FR1: the Pages host moved to `maximum-trainer.github.io` with the org
// transfer (2026-10-29). The old host 404s, so no user-facing doc may link it.
// (DEVELOPMENT.md and scripts/verify-oauth-proxy.mjs still name the old origin
// on purpose: it stays registered for OAuth so links shared before the move
// still complete sign-in. Those are not links.)
const root = join(__dirname, '..', '..');
const docs = [
  'README.md',
  ...readdirSync(join(root, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => join('docs', f)),
];

describe('documentation links (#738)', () => {
  it.each(docs)('%s does not link the dead maximumtrainer.github.io host', (file) => {
    const text = readFileSync(join(root, file), 'utf8');
    expect(text).not.toMatch(/https?:\/\/maximumtrainer\.github\.io/);
  });

  it('README links the live site', () => {
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain(
      'https://maximum-trainer.github.io/virtualrow/',
    );
  });
});
