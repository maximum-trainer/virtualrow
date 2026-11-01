/**
 * #496 AC4 — the biome-density grass contribution is a shader output of the
 * bank pass, not a per-blade instanced mesh. The React scene's
 * `GRASS_MAX = 80` InstancedMesh was retired at the #542 cutover; this spec
 * is a filesystem regression guard so a future "add grass instances back"
 * stands out at review.
 *
 * No file under `src/lib/renderer/{passes,plan}/` names a grass pool, and
 * no WGSL file beyond `bank.wgsl` references `grassTile`. The bank's
 * fragment shader is the only call site, which is exactly FR2 / AC4.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const planDir = path.resolve(here, '../lib/renderer/plan');
const passesDir = path.resolve(here, '../lib/renderer/passes');

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

describe('#496 AC4 — shader-only grass, no instanced pool', () => {
  it('has no file named grassPool/grassBlade/grassInstance under plan or passes', () => {
    const all = [...listAll(planDir), ...listAll(passesDir)];
    const violators = all.filter((f) =>
      /grass(pool|blade|instance|cluster|tuft)/i.test(path.basename(f)),
    );
    expect(violators).toEqual([]);
  });

  it('only bank.wgsl samples the grassTile texture', () => {
    const wgsl = [...listAll(planDir), ...listAll(passesDir)].filter((f) => f.endsWith('.wgsl'));
    const callers = wgsl.filter((f) => {
      const src = fs.readFileSync(f, 'utf8');
      return /grassTile/.test(src);
    });
    expect(callers.map((f) => path.basename(f))).toEqual(['bank.wgsl']);
  });
});
