import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { FRAME_UNIFORMS_BYTES } from '../../engine/uniforms';

// P2-AC7: a syntactically broken shader must fail the Vitest run, not
// Playwright. `WgslReflect` throws on any parser-level problem, so parsing
// each `.wgsl` under the passes dir is the whole check.
const passesDir = dirname(fileURLToPath(import.meta.url)) + '/..';

const shaderFiles = readdirSync(passesDir).filter((f) => f.endsWith('.wgsl'));

describe('pass WGSL shaders parse', () => {
  it('finds at least one shader', () => {
    expect(shaderFiles.length).toBeGreaterThan(0);
  });

  for (const file of shaderFiles) {
    it(`parses ${file}`, () => {
      const src = readFileSync(join(passesDir, file), 'utf8');
      // A `new WgslReflect(src)` call throws on a syntax error.
      const reflect = new WgslReflect(src);
      // Each pass has at least a vertex and a fragment entry point.
      const entries = [...reflect.functions.filter((f) => f.attributes?.some((a) => ['vertex', 'fragment', 'compute'].includes(a.name)))];
      expect(entries.length).toBeGreaterThan(0);
    });
  }
});

// #592: `WgslReflect` only parses syntax, so it accepted an unresolvable
// `textureSampleLevel(texture_depth_2d, sampler, vec2<f32>, 0.0)` call —
// `texture_depth_2d`'s overload requires an i32 level, and the browser
// rejects the module at pipeline creation, blacking out extra-high. Guard
// against the class of bug: any pass that binds a depth texture must call
// `textureSampleLevel` with an integer level (ends with `i`/`u` or is a
// non-literal expression), never an abstract-float literal.
describe('textureSampleLevel on depth textures uses an integer level (#592)', () => {
  const depthTextureFiles = shaderFiles.filter((f) =>
    /\btexture_depth_(2d|cube|2d_array|cube_array)\b/.test(readFileSync(join(passesDir, f), 'utf8')),
  );
  it('finds at least one depth-sampling pass', () => {
    expect(depthTextureFiles.length).toBeGreaterThan(0);
  });
  for (const file of depthTextureFiles) {
    it(`${file} passes an integer level to textureSampleLevel`, () => {
      const src = readFileSync(join(passesDir, file), 'utf8');
      const calls = [...src.matchAll(/textureSampleLevel\s*\(([^)]*)\)/g)];
      expect(calls.length).toBeGreaterThan(0);
      for (const m of calls) {
        const parts = m[1].split(',').map((s) => s.trim());
        // level is the last positional arg; depth overloads take 4 args
        // (tex, sampler, coords, level) — array/cube variants take more,
        // but the level is still last.
        const level = parts[parts.length - 1];
        // Reject bare float literals like `0.0`, `1.5`, `-2.0`. Integer
        // literals (`0`, `0i`, `0u`) and non-literal expressions pass.
        const isFloatLiteral = /^-?\d+\.\d+f?$/.test(level) || /^-?\.\d+f?$/.test(level);
        expect(isFloatLiteral, `${file}: textureSampleLevel level "${level}" must be an integer for depth textures`).toBe(false);
      }
    });
  }
});

/**
 * #588 FR5 / AC5 — uniform-struct size contract.
 *
 * Walks every pass that declares a `Frame` uniform struct and asserts
 * its WGSL-computed byte size matches the CPU-side `FRAME_UNIFORMS_BYTES`
 * (= 272 B = 68 × 4). Pre-#549 the WGSL `Frame` struct grew to 272 B
 * while the JS packer stayed at 256 B / 64 floats; every bind-group
 * creation emitted a WebGPU validation error, every submitted command
 * buffer was dropped, and the whole scene rendered black. This test
 * flips red before any pixel renders when the two sides drift again.
 */
describe('uniform-struct size contract (#588 FR5 / AC5)', () => {
  const framePasses = shaderFiles.filter((f) => /\bstruct\s+Frame\s*\{/.test(readFileSync(join(passesDir, f), 'utf8')));

  it('finds at least one pass declaring the Frame struct', () => {
    expect(framePasses.length).toBeGreaterThan(0);
  });

  for (const file of framePasses) {
    it(`${file}: Frame struct size matches FRAME_UNIFORMS_BYTES (${FRAME_UNIFORMS_BYTES} B)`, () => {
      const src = readFileSync(join(passesDir, file), 'utf8');
      const reflect = new WgslReflect(src);
      const structs = (reflect as unknown as { structs: Array<{ name: string; size: number }> }).structs;
      const frameStruct = structs.find((s) => s.name === 'Frame');
      expect(frameStruct, `${file}: expected a struct named Frame`).toBeDefined();
      // `size` is the uniform-aligned struct size (what the engine
      // allocates); the bind-group validation checks the uniform-
      // aligned size against the buffer's minBindingSize.
      expect(frameStruct?.size, `${file}: Frame WGSL size`).toBe(FRAME_UNIFORMS_BYTES);
    });
  }
});

/**
 * #588 FR5 / AC5 — per-pass binding-group layout contract.
 *
 * The uniform-struct size contract above catches size drift; this
 * catches structure drift. For each `.wgsl` under `passes/`, walk the
 * reflected bind groups and compare the `{group, binding, name,
 * resourceType}` rows against a committed snapshot
 * (`wgsl-bindings.snapshot.json`). Any add/remove/reorder/rename of a
 * `@group`/`@binding` fails the test before any pipeline is created —
 * so a renumbered binding that would have produced a WebGPU
 * validation error at runtime is caught in the vitest run instead.
 *
 * Snapshot is regenerated with `node scripts/snapshot-wgsl-bindings.mjs`
 * on a deliberate layout change and reviewed as a one-line JSON diff.
 */
interface BindingRow {
  group: number;
  binding: number;
  name: string;
  resourceType: number;
}

const normaliseBindings = (reflect: WgslReflect): BindingRow[] => {
  // `getBindGroups()` is a sparse array indexed by @group; each slot
  // is itself a sparse array indexed by @binding. Walk flatly and
  // skip holes.
  const groups = (reflect as unknown as {
    getBindGroups(): Array<Array<BindingRow | undefined> | undefined>;
  }).getBindGroups();
  const rows: BindingRow[] = [];
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
  rows.sort((a, b) => a.group - b.group || a.binding - b.binding);
  return rows;
};

describe('per-pass binding-group layout snapshot (#588 FR5 / AC5)', () => {
  const snapshotPath = join(passesDir, '__tests__', 'wgsl-bindings.snapshot.json');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, BindingRow[]>;

  it('snapshot covers every shader under passes/', () => {
    for (const file of shaderFiles) {
      expect(snapshot[file], `${file}: missing from wgsl-bindings.snapshot.json — run \`node scripts/snapshot-wgsl-bindings.mjs\``).toBeDefined();
    }
  });

  it('snapshot has no stale entries', () => {
    for (const file of Object.keys(snapshot)) {
      expect(shaderFiles, `${file}: snapshot entry has no matching .wgsl — run \`node scripts/snapshot-wgsl-bindings.mjs\``).toContain(file);
    }
  });

  for (const file of shaderFiles) {
    it(`${file}: binding-group layout matches snapshot`, () => {
      const src = readFileSync(join(passesDir, file), 'utf8');
      const reflect = new WgslReflect(src);
      const current = normaliseBindings(reflect);
      // Compare JSON strings so a mismatch prints the full diff.
      expect(JSON.stringify(current, null, 2)).toBe(
        JSON.stringify(snapshot[file] ?? [], null, 2),
      );
    });
  }
});
