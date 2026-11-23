import { describe, expect, it } from 'vitest';
import {
  BASE_FOV,
  CEILING_CLEARANCE_METRES,
  FOV_MAX_RATE_DEG_PER_S,
  POSITION_TAU,
  VIEW_BLEND_SECONDS,
  bendSignFromTangents,
  createCameraRig,
  portraitFov,
  stepCameraRig,
  type CameraView,
} from '../camera';
import { vec3 } from '../../math/vec3';

// #735 VP-17 — the ride camera follows the rig target through damping and a
// filtered FOV instead of being written straight from the boat each frame.

const DT = 1 / 60;
const tangent = vec3(1, 0, 0);

interface Drive {
  x: number;
  speed: number;
  dt?: number;
  view?: CameraView;
  aspect?: number;
  reducedMotion?: boolean;
  ceilingAt?: (x: number, z: number) => number;
}

const step = (rig: ReturnType<typeof createCameraRig>, d: Drive) =>
  stepCameraRig(rig, {
    boat: vec3(d.x, 0, 0),
    tangent,
    velocityMps: d.speed,
    view: d.view ?? 'chase',
    bendSign: 0,
    dt: d.dt ?? DT,
    aspect: d.aspect ?? 16 / 9,
    reducedMotion: d.reducedMotion,
    ceilingAt: d.ceilingAt,
  });

/** Row at `speed` for `seconds`, returning the boat's x afterwards. */
const rowSteady = (rig: ReturnType<typeof createCameraRig>, x0: number, speed: number, seconds: number) => {
  let x = x0;
  for (let i = 0; i < Math.round(seconds / DT); i += 1) {
    x += speed * DT;
    step(rig, { x, speed });
  }
  return x;
};

describe('camera rig state (#735 VP-17)', () => {
  it('starts on the rig target rather than easing in from the origin', () => {
    const rig = createCameraRig();
    const applied = step(rig, { x: 500, speed: 0 });
    expect(applied.position[0]).toBeCloseTo(500 - 7, 5);
    expect(applied.position[1]).toBeCloseTo(2.6, 5);
    expect(applied.lookAt[0]).toBeCloseTo(500, 5);
    expect(applied.fov).toBeCloseTo(BASE_FOV, 5);
  });

  it('Scenario: a distance correction does not jolt the view', () => {
    const rig = createCameraRig();
    let x = rowSteady(rig, 0, 4, 10);
    const before = { pos: [...rig.applied.position], fov: rig.applied.fov };
    // One frame whose distance jumps 1.5 m: the raw per-frame speed spikes.
    x += 1.5;
    step(rig, { x, speed: 1.5 / DT });
    const moved = Math.hypot(
      rig.applied.position[0] - before.pos[0],
      rig.applied.position[1] - before.pos[1],
      rig.applied.position[2] - before.pos[2],
    );
    expect(moved).toBeLessThan(0.25);
    expect(Math.abs(rig.applied.fov - before.fov)).toBeLessThan(0.1);
  });

  it('Scenario: steady rowing has steady FOV', () => {
    const rig = createCameraRig();
    let x = rowSteady(rig, 0, 4.1, 10);
    const fovs: number[] = [];
    // 20 s of the speeds measured on the live deploy: 4.09-4.19 m/s with a
    // delayed-sample spike to 5.1, 7.1 or 13.4 m/s every couple of seconds.
    const spikes = [5.1, 7.1, 13.4];
    for (let i = 0; i < 20 * 60; i += 1) {
      let speed = 4.09 + 0.1 * ((i * 7919) % 11) / 10;
      if (i % 120 === 60) speed = spikes[(i / 120) % 3 | 0];
      x += speed * DT;
      step(rig, { x, speed });
      fovs.push(rig.applied.fov);
    }
    for (let i = 0; i + 60 <= fovs.length; i += 1) {
      const window = fovs.slice(i, i + 60);
      expect(Math.max(...window) - Math.min(...window)).toBeLessThan(0.5);
    }
  });

  it('rate-limits FOV to 4 degrees a second', () => {
    const rig = createCameraRig();
    step(rig, { x: 0, speed: 0 });
    let prev = rig.applied.fov;
    for (let i = 1; i < 120; i += 1) {
      step(rig, { x: i * 0.2, speed: 12 });
      expect(rig.applied.fov - prev).toBeLessThanOrEqual(FOV_MAX_RATE_DEG_PER_S * DT + 1e-9);
      prev = rig.applied.fov;
    }
    expect(prev).toBeGreaterThan(BASE_FOV);
  });

  it('is frame-rate independent and clamps dt to 100 ms', () => {
    const at60 = createCameraRig();
    const at30 = createCameraRig();
    step(at60, { x: 0, speed: 0 });
    step(at30, { x: 0, speed: 0 });
    for (let i = 0; i < 60; i += 1) step(at60, { x: 10, speed: 0, dt: 1 / 60 });
    for (let i = 0; i < 30; i += 1) step(at30, { x: 10, speed: 0, dt: 1 / 30 });
    expect(at60.applied.position[0]).toBeCloseTo(at30.applied.position[0], 6);

    const clamped = createCameraRig();
    const reference = createCameraRig();
    step(clamped, { x: 0, speed: 0 });
    step(reference, { x: 0, speed: 0 });
    step(clamped, { x: 10, speed: 0, dt: 5 });
    step(reference, { x: 10, speed: 0, dt: 0.1 });
    expect(clamped.applied.position[0]).toBeCloseTo(reference.applied.position[0], 9);
  });

  it('lags a moving boat by about speed x tau, and half that with reduced motion', () => {
    const normal = createCameraRig();
    const reduced = createCameraRig();
    let x = 0;
    for (let i = 0; i < 600; i += 1) {
      x += 4 * DT;
      step(normal, { x, speed: 4 });
      step(reduced, { x, speed: 4, reducedMotion: true });
    }
    const lag = x - 7 - normal.applied.position[0];
    const lagReduced = x - 7 - reduced.applied.position[0];
    expect(lag).toBeCloseTo(4 * POSITION_TAU, 1);
    expect(lagReduced).toBeCloseTo(lag / 2, 1);
  });

  it('pins FOV to the base under prefers-reduced-motion', () => {
    const rig = createCameraRig();
    rowSteady(rig, 0, 0, 0.1);
    for (let i = 0; i < 300; i += 1) step(rig, { x: i, speed: 6, reducedMotion: true });
    expect(rig.applied.fov).toBe(BASE_FOV);
  });

  it('widens the FOV for a portrait canvas', () => {
    const rig = createCameraRig();
    step(rig, { x: 0, speed: 0, aspect: 0.5 });
    expect(rig.applied.fov).toBeCloseTo(portraitFov(BASE_FOV, 0.5), 6);
    expect(rig.applied.fov).toBeGreaterThan(BASE_FOV);
  });

  it('blends a view switch over 0.4 s instead of cutting', () => {
    const rig = createCameraRig();
    step(rig, { x: 0, speed: 0 });
    const chase = [...rig.applied.position];
    step(rig, { x: 0, speed: 0, view: 'high' });
    // One frame in: still close to where the chase camera was.
    expect(Math.abs(rig.applied.position[0] - chase[0])).toBeLessThan(1);
    for (let t = 0; t < VIEW_BLEND_SECONDS + 3; t += DT) step(rig, { x: 0, speed: 0, view: 'high' });
    expect(rig.applied.position[0]).toBeCloseTo(-18, 1);
    expect(rig.applied.position[1]).toBeCloseTo(9, 1);
  });

  it('keeps the damped camera under a bridge deck', () => {
    const rig = createCameraRig();
    step(rig, { x: 0, speed: 0 });
    // The boat rows under a deck 3 m up: the camera must stay below it even
    // while it is still catching up from where it was.
    const ceilingAt = () => 3;
    for (let i = 0; i < 30; i += 1) step(rig, { x: i * 0.5, speed: 4, ceilingAt });
    expect(rig.applied.position[1]).toBeLessThanOrEqual(3 - CEILING_CLEARANCE_METRES + 1e-9);
  });

  it('jumps straight to the target when asked to snap (a seek)', () => {
    const rig = createCameraRig();
    rowSteady(rig, 0, 4, 2);
    stepCameraRig(rig, {
      boat: vec3(30, 0, 0),
      tangent,
      velocityMps: 0,
      view: 'chase',
      bendSign: 0,
      dt: DT,
      aspect: 16 / 9,
      snap: true,
    });
    expect(rig.applied.position[0]).toBeCloseTo(30 - 7, 6);
  });

  it('snaps rather than sweeping when the boat jumps far (restart, new route)', () => {
    const rig = createCameraRig();
    rowSteady(rig, 0, 4, 2);
    step(rig, { x: 5000, speed: 0 });
    expect(rig.applied.position[0]).toBeCloseTo(5000 - 7, 5);
  });
});

describe('bendSignFromTangents (#735 FR5)', () => {
  const ahead = (deg: number) => vec3(Math.cos((deg * Math.PI) / 180), 0, Math.sin((deg * Math.PI) / 180));

  it('puts the side camera on the outside of the bend', () => {
    // Heading +x and turning towards +z (the rig's +perp side): the outside
    // is -perp, so the sign is negative.
    expect(bendSignFromTangents(tangent, ahead(20), 0)).toBe(-1);
    expect(bendSignFromTangents(tangent, ahead(-20), 0)).toBe(1);
  });

  it('keeps its previous side on a straight or barely curved reach', () => {
    expect(bendSignFromTangents(tangent, ahead(0.2), -1)).toBe(-1);
    expect(bendSignFromTangents(tangent, ahead(-0.2), 1)).toBe(1);
    expect(bendSignFromTangents(tangent, ahead(0), 0)).toBe(0);
  });
});
