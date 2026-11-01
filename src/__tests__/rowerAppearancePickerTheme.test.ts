import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The picker sits on the light home-page panel. Its CSS came over from the
 * React dark overlay with white-on-transparent text, so the summary and every
 * slot label rendered white on white (found in the #672 laptop look check).
 * It now takes its colours from the theme tokens like the Rower switch beside it.
 */
describe('RowerAppearancePicker.css follows the theme', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/lib/ui/RowerAppearancePicker.css'), 'utf8');

  it('hard-codes no white text, border or background', () => {
    expect(css).not.toMatch(/rgba\(\s*255\s*,\s*255\s*,\s*255/);
  });

  it('colours the summary and labels from text tokens', () => {
    expect(css).toMatch(/\.rower-appearance-summary\s*{[^}]*color:\s*var\(--color-text-/);
    expect(css).toMatch(/\.rower-appearance-label\s*{[^}]*color:\s*var\(--color-text-/);
  });
});
