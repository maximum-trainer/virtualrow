import { describe, expect, it, vi } from 'vitest';

// The lane constants once lived in `courseFurniture` while `laneClearance`
// read them at module load, and `courseFurniture` imported `laneClearance`
// back. Loaded furniture-first (as the app bundle does), the corridor came
// out NaN or the chunk threw before the page could mount.
describe('lane clearance load order', () => {
  it('gives a finite corridor when courseFurniture loads first', async () => {
    vi.resetModules();
    const furniture = await import('../courseFurniture');
    const clearance = await import('../laneClearance');
    expect(furniture.BUOY_LANE_HALF_WIDTH_METRES).toBe(6.5);
    expect(clearance.FLEET_LANE_HALF_WIDTH_METRES).toBe(8);
    expect(clearance.keepClearHalfWidth()).toBe(12);
  });
});
