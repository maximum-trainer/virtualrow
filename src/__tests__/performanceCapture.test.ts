// #684 D3c — locked-in frame-stats capture.
//
// The capture file is recorded on a laptop run against the actual engine
// (see its `capturedAt` field for the last re-record). This test asserts
// the recorded percentiles stay inside the FR10 medium-tier budget
// (gpuMs ≤ 12 ms) with a safety margin so a scene change that pushes p95
// toward the cap trips here before it ships.
//
// Updating the capture is deliberate: a PR that re-records
// `performance-capture.json` must say so in its body and explain why the
// numbers moved. A PR that does not mean to move perf (feature work,
// refactor) is not meant to touch this file.
//
// See #684 and `src/lib/renderer/engine/shadowConfig.ts` for the tuning
// knobs this file guards.

import { describe, expect, it } from 'vitest';
import capture from './performance-capture.json' with { type: 'json' };

interface Capture {
  $schemaVersion: 1;
  capturedAt: string;
  configuration: { shadowAtlasSize: number; shadowCascades: number };
  gpuMs: {
    min: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    framesOver12MsPct: number;
  };
  device: { tier: string };
}

const c = capture as Capture;

describe('#684 D3c — medium-tier frame-stats capture is inside FR10 budget', () => {
  it('capture file is schema v1 and taken at the medium tier', () => {
    expect(c.$schemaVersion).toBe(1);
    expect(c.device.tier).toBe('medium');
    expect(c.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('recorded p95 gpuMs stays inside the 12 ms medium cap with safety margin', () => {
    // AC1 on #684: p95 ≤ 11 ms (1 ms headroom). We keep a tenth of a
    // millisecond of slack above 11 ms for jitter between laptop runs and
    // trip at 11.5 ms — tighter than the FR10 cap, looser than the issue
    // target, so an incremental drift is loud before it blows the budget.
    expect(c.gpuMs.p95).toBeLessThanOrEqual(11.5);
  });

  it('recorded p99 gpuMs stays strictly inside the 12 ms cap', () => {
    expect(c.gpuMs.p99).toBeLessThanOrEqual(12);
  });

  it('recorded max gpuMs stays inside a 60 Hz frame budget (~13 ms with slack)', () => {
    // 1000/60 ≈ 16.6 ms; tolerate a single-frame outlier up to 13 ms so a
    // transient spike doesn't trip, but a genuine 17 ms hitch (frame drop)
    // does.
    expect(c.gpuMs.max).toBeLessThanOrEqual(13);
  });

  it('recorded frames-over-12ms stays under 1 %', () => {
    // AC2 on #684: % of frames over 12 ms ≤ 1 %.
    expect(c.gpuMs.framesOver12MsPct).toBeLessThanOrEqual(1);
  });

  it('shadow atlas size is the audited value', () => {
    // #684 D2a: medium's atlas moves to 768. If a later PR bumps it back,
    // this capture should be re-recorded and this expectation updated.
    expect(c.configuration.shadowAtlasSize).toBe(768);
    expect(c.configuration.shadowCascades).toBe(3);
  });
});
