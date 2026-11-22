import { describe, expect, it } from 'vitest';
import {
  buildGroundPlane,
  GROUND_HALF_EXTENT_M,
  GROUND_SURFACE_Y,
  GROUND_HAZE_START_M,
  GROUND_HAZE_END_M,
} from '../groundPlane';
import { buildBankStrips } from '../bankStrip';
import { CAMERA_FAR_M } from '../../engine/cameraRange';

/**
 * The land beyond the bank strips. Without it the 60 m banks end in mid-air
 * and every course reads as a canal floating in the sky (#725, #755).
 */
describe('buildGroundPlane', () => {
  it('reaches past the camera far plane in every direction', () => {
    const g = buildGroundPlane();
    expect(GROUND_HALF_EXTENT_M).toBeGreaterThanOrEqual(CAMERA_FAR_M);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < g.positions.length; i += 3) {
      minX = Math.min(minX, g.positions[i]); maxX = Math.max(maxX, g.positions[i]);
      minZ = Math.min(minZ, g.positions[i + 2]); maxZ = Math.max(maxZ, g.positions[i + 2]);
    }
    expect(minX).toBe(-GROUND_HALF_EXTENT_M);
    expect(maxX).toBe(GROUND_HALF_EXTENT_M);
    expect(minZ).toBe(-GROUND_HALF_EXTENT_M);
    expect(maxZ).toBe(GROUND_HALF_EXTENT_M);
  });

  it('is camera-relative: offsets only, centred on the origin', () => {
    const g = buildGroundPlane();
    let sx = 0, sz = 0;
    for (let i = 0; i < g.positions.length; i += 3) { sx += g.positions[i]; sz += g.positions[i + 2]; }
    expect(sx).toBe(0);
    expect(sz).toBe(0);
  });

  it('lies at the height of the bank strips so the two join without a step', () => {
    const bank = buildBankStrips();
    expect(GROUND_SURFACE_Y).toBeCloseTo(bank.positions[1], 6);
    const g = buildGroundPlane();
    for (let i = 1; i < g.positions.length; i += 3) expect(g.positions[i]).toBe(GROUND_SURFACE_Y);
  });

  it('has valid triangles', () => {
    const g = buildGroundPlane();
    expect(g.indices.length % 3).toBe(0);
    expect(g.indices.length).toBeGreaterThanOrEqual(6);
    for (const i of g.indices) expect(i).toBeLessThan(g.positions.length / 3);
  });

  it('has faded fully into the sky before the far plane cuts it off', () => {
    expect(GROUND_HAZE_END_M).toBeLessThan(CAMERA_FAR_M);
    expect(GROUND_HAZE_START_M).toBeLessThan(GROUND_HAZE_END_M);
    // Far enough that the near landscape is not washed out.
    expect(GROUND_HAZE_START_M).toBeGreaterThanOrEqual(300);
  });
});
