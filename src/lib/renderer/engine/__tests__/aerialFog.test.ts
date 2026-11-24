// #725 VP-07 FR6 — one aerial-perspective fog, used by every lit pass, in
// the sky's own horizon colour.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import {
  AERIAL_FOG_MAX,
  AERIAL_FOG_START_M,
  AERIAL_FOG_WGSL,
  aerialFogAmount,
} from '../shaderSnippets';
import { attach } from '../attach';
import { resetWebGPUHealth } from '../health';
import { installGPUStub, makeMockAdapter, makeMockCanvas, makeMockGPU, type MockGPULog } from '../../__tests__/_mockWebGPU';
import { releaseTelemetry } from '../telemetry';

/** The default `frame.fog.y` (`rideScene`'s baseline fog). */
const FOG_Y = 0.0005;

describe('aerial fog amount (#725 FR6)', () => {
  it('is nothing near the camera, rises with distance and never passes the cap', () => {
    expect(aerialFogAmount(0, FOG_Y)).toBe(0);
    expect(aerialFogAmount(AERIAL_FOG_START_M, FOG_Y)).toBe(0);
    // Near scenery keeps its colour: under 5% at the kit-tree draw distance.
    expect(aerialFogAmount(250, FOG_Y)).toBeLessThan(0.05);
    let last = 0;
    for (const d of [300, 600, 1000, 2000, 5000]) {
      const f = aerialFogAmount(d, FOG_Y);
      expect(f).toBeGreaterThan(last);
      expect(f).toBeLessThanOrEqual(AERIAL_FOG_MAX);
      last = f;
    }
    // A visible depth cue on the far bank and the backdrop.
    expect(aerialFogAmount(1000, FOG_Y)).toBeGreaterThan(0.15);
    // Thicker fog (Overcast, or a nearer view distance) means more haze.
    expect(aerialFogAmount(1000, FOG_Y * 2)).toBeGreaterThan(aerialFogAmount(1000, FOG_Y));
  });

  it('the snippet defines applyFog in the horizon colour', () => {
    expect(AERIAL_FOG_WGSL).toMatch(/fn applyFog\(col: vec3<f32>, toFrag: vec3<f32>\) -> vec3<f32>/);
    expect(AERIAL_FOG_WGSL).toContain('skyColourToward');
  });
});

describe('every lit pass applies the shared fog (#725 FR6)', () => {
  beforeEach(() => {
    installGPUStub(makeMockGPU(makeMockAdapter()));
    resetWebGPUHealth();
  });
  afterEach(() => {
    installGPUStub(undefined);
    releaseTelemetry();
  });

  it('bank, water, buildings, kit scenery, sprite scenery and the boat', async () => {
    const renderer = (await attach(makeMockCanvas(), { testMode: true, tier: 'medium' })) as unknown as {
      _frameOnce(): void;
      _liveDevice: { __log: MockGPULog };
      dispose(): void;
    };
    renderer._frameOnce();
    const modules = renderer._liveDevice.__log.shaderModules;
    renderer.dispose();
    for (const label of ['bank', 'water', 'buildings', 'sceneryMesh', 'scenery', 'boat']) {
      const mod = modules.find((m) => m.label === label);
      expect(mod, label).toBeDefined();
      const fs = mod!.code.slice(mod!.code.indexOf('fn fs_main'));
      expect(fs, `${label} fs_main calls applyFog`).toMatch(/applyFog\(/);
      expect(() => new WgslReflect(mod!.code), `${label} parses`).not.toThrow();
      // wgsl_reflect does not type-check: a vec4 camPos (the boat's Frame)
      // must be swizzled before it meets a vec3 worldPos, or Dawn rejects
      // the module and the ride never starts (caught on SwiftShader).
      if (/camPos:\s*vec4<f32>/.test(mod!.code)) {
        expect(fs, `${label} swizzles its vec4 camPos`).not.toMatch(/-\s*frame\.camPos\s*\)/);
      }
    }
  });
});
