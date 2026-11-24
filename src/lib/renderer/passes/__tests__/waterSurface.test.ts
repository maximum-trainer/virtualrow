// #734 VP-16 FR1/FR2/FR5 — the river strip and the lake polygons shade
// from one snippet, and the sky they reflect is the sky pass's own.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import {
  HORIZON_HAZE_WGSL,
  SAMPLE_SHADOW_WGSL,
  SHADOW_UNIFORMS_WGSL,
  SKY_COLOUR_WGSL,
  AERIAL_FOG_WGSL,
  WATER_SURFACE_WGSL,
} from '../../engine/shaderSnippets';
import { WATER_BODY_COLOUR, WATER_WAVE_TRAINS } from '../../plan/waterWaves';

const passesDir = dirname(fileURLToPath(import.meta.url)) + '/..';
const read = (f: string) => readFileSync(join(passesDir, f), 'utf8');

describe('shared water surface (#734)', () => {
  it.each(['water.ts', 'waterPolygon.ts'])('%s builds its shader from the shared sky and water snippets (FR5)', (f) => {
    expect(read(f)).toContain(
      'SHADOW_UNIFORMS_WGSL + SAMPLE_SHADOW_WGSL + HORIZON_HAZE_WGSL + SKY_COLOUR_WGSL + AERIAL_FOG_WGSL + WATER_SURFACE_WGSL + waterWgsl',
    );
  });

  it('the sky pass draws its gradient from the same snippet the water reflects (FR2)', () => {
    expect(read('sky.ts')).toContain('SKY_COLOUR_WGSL + skyWgsl');
    const sky = read('sky.wgsl');
    expect(sky).toContain('skyHorizonColour(warmShare)');
    expect(sky).toContain('skyZenithColour()');
  });

  it('composes into WGSL that parses', () => {
    const water = SHADOW_UNIFORMS_WGSL + SAMPLE_SHADOW_WGSL + HORIZON_HAZE_WGSL + SKY_COLOUR_WGSL + AERIAL_FOG_WGSL + WATER_SURFACE_WGSL + read('water.wgsl');
    expect(() => new WgslReflect(water)).not.toThrow();
    for (const fn of ['fn waterSlope(', 'fn skyColourToward(', 'fn fs_main(']) expect(water).toContain(fn);
    expect(() => new WgslReflect(SKY_COLOUR_WGSL + read('sky.wgsl'))).not.toThrow();
  });

  it('drops the sin(x)·cos(z) checkerboard for the wave table, Fresnel and a sun lobe (FR1, FR2)', () => {
    const wgsl = read('water.wgsl');
    expect(wgsl).not.toMatch(/sin\(in\.worldXZ\.x[^)]*\)\s*\*\s*cos\(in\.worldXZ\.y/);
    expect(wgsl).toContain('waterSlope(in.worldXZ, frame.time, camDist)');
    expect(wgsl).toContain('skyColourToward(');
    expect(wgsl).toContain('pow(1.0 - nv, 5.0)');
    expect(wgsl).toContain('WATER_SPECULAR_POWER');
    // FR3: the far water still dissolves through the shared horizon haze.
    expect(wgsl).toContain('horizonAlpha(camDist)');
    expect(WATER_SURFACE_WGSL.match(/let c = cos\(/g)).toHaveLength(WATER_WAVE_TRAINS.length + 1);
  });
});

describe('water body colour (#734, #732 FR4)', () => {
  it('the WGSL body colour is the shared WATER_BODY_COLOUR', () => {
    const [r, g, b] = WATER_BODY_COLOUR;
    expect(WATER_SURFACE_WGSL).toContain(`const WATER_BODY: vec3<f32> = vec3<f32>(${r.toFixed(3)}, ${g.toFixed(3)}, ${b.toFixed(3)});`);
    const water = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'water.wgsl'), 'utf8');
    expect(water).toContain('let body = WATER_BODY * lighting.waterTint.rgb');
  });
});
