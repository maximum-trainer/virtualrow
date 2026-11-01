/**
 * #623 Phase 1 — the shadow stage carries no `floraSolid` field.
 *
 * The procedural flora depth pass is retired; `sceneryMesh` is the
 * only scenery depth path. This spec locks the public shape: the
 * `ShadowStage` interface in `../lib/renderer/engine/shadowStage.ts`
 * has no `floraSolid` key, and no `floraSolidResources` /
 * `floraLeafAtlas` on its options.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const shadowStageSrc = fs.readFileSync(
  path.resolve(here, '../lib/renderer/engine/shadowStage.ts'),
  'utf8',
);

describe('shadowStage after #623 Phase 1', () => {
  it('has no floraSolid field, imports or options', () => {
    expect(shadowStageSrc).not.toMatch(/floraSolid/i);
    expect(shadowStageSrc).not.toMatch(/floraLeafAtlas/i);
    expect(shadowStageSrc).not.toMatch(/floraSolidResources/i);
  });

  it('still wires the sceneryMesh depth path', () => {
    expect(shadowStageSrc).toMatch(/sceneryMesh/);
  });
});
