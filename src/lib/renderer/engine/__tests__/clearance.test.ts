// #737 VP-19 FR4 — the blade clearance the engine publishes on __ROWER3D_CLEARANCE.
import { describe, expect, it } from 'vitest';
import { OAR_REACH_METRES, recordClearance } from '../clearance';
import type { Rower3DClearance } from '../telemetry';

const fresh = (): Rower3DClearance => ({ min: 0, samples: 0, current: null, oarReachM: OAR_REACH_METRES });

describe('recordClearance', () => {
  it('rigs the blades 2.78 m either side of the centreline', () => {
    expect(OAR_REACH_METRES).toBeCloseTo(2.78, 6);
  });

  it('publishes shore distance less the oar reach, and the narrowest so far', () => {
    const c = fresh();
    recordClearance(c, 10);
    expect(c.current).toBeCloseTo(7.22, 6);
    expect(c.min).toBeCloseTo(7.22, 6);
    expect(c.samples).toBe(1);
    recordClearance(c, 4);
    recordClearance(c, 12);
    expect(c.current).toBeCloseTo(9.22, 6);
    expect(c.min).toBeCloseTo(1.22, 6);
    expect(c.samples).toBe(3);
  });

  it('goes negative when the blades are over the bank', () => {
    const c = fresh();
    recordClearance(c, 1);
    expect(c.min).toBeCloseTo(-1.78, 6);
  });

  it('skips frames with no ribbon under the boat, without losing the minimum', () => {
    const c = fresh();
    recordClearance(c, 5);
    recordClearance(c, null);
    expect(c.current).toBeNull();
    expect(c.samples).toBe(1);
    expect(c.min).toBeCloseTo(2.22, 6);
  });
});
