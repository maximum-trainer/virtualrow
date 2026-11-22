// Oar-blade splash particles (#571, reworked by #722 VP-04). Burst-fed
// by `engine/oarSplashParticles.ts` at the catch and finish of each
// stroke; the storage buffer is uploaded whole each frame.
//
// Two kinds share the pool:
//   - drops: small camera-facing specks thrown in a low ballistic arc,
//     hidden the moment they fall back to the water (FR4);
//   - rings: one flat annulus per blade spreading on the water (FR4).
// Both fade out near the camera (FR5) and use the pre-exposed foam colour
// (FR6). Constants marked `mirror` are checked by the engine unit tests.

struct Frame {
  view: mat4x4<f32>,
  proj: mat4x4<f32>,
  viewProj: mat4x4<f32>,
  camPos: vec3<f32>,
  _pad0: f32,
  sunDir: vec3<f32>,
  _pad1: f32,
  fog: vec4<f32>,
  time: f32,
  _pad2: vec3<f32>,
};
@group(0) @binding(0) var<uniform> frame: Frame;

// Each particle is stored as three vec4<f32>:
//   particles[ii*3]     = (x, y, z, age)
//   particles[ii*3 + 1] = (lifetime, size, vx, vz)
//   particles[ii*3 + 2] = (kind, seed, _, _)
@group(2) @binding(0) var<storage, read> particles: array<vec4<f32>>;

const INITIAL_UP: f32 = 1.4;          // mirror: OAR_SPLASH_DROP_INITIAL_UP_MPS
const GRAVITY: f32 = -9.8;            // m/s² (world +Y is up)
const RING_START_RADIUS: f32 = 0.08;  // mirror: OAR_SPLASH_RING_START_RADIUS_METRES
const RING_END_RADIUS: f32 = 0.3;     // mirror: OAR_SPLASH_RING_END_RADIUS_METRES
const DROP_PEAK_ALPHA: f32 = 0.5;
const RING_PEAK_ALPHA: f32 = 0.3;
const NEAR_FADE_START: f32 = 1.5;     // mirror: PARTICLE_NEAR_FADE_START_METRES
const NEAR_FADE_END: f32 = 3.0;       // mirror: PARTICLE_NEAR_FADE_END_METRES
const FOAM_R: f32 = 0.8;              // mirror: foamColour
const FOAM_G: f32 = 0.83;
const FOAM_B: f32 = 0.86;
const FOAM_SUN_WARM: f32 = 0.06;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) lifeFrac: f32,
  @location(2) world: vec3<f32>,
  // x = 1 for a ring, y = 0 once a drop has landed (hide it).
  @location(3) flags: vec2<f32>,
};

const CORNERS = array<vec2<f32>, 6>(
  vec2<f32>(-1.0, -1.0),
  vec2<f32>( 1.0, -1.0),
  vec2<f32>(-1.0,  1.0),
  vec2<f32>( 1.0, -1.0),
  vec2<f32>( 1.0,  1.0),
  vec2<f32>(-1.0,  1.0),
);

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  let a = particles[ii * 3u];
  let b = particles[ii * 3u + 1u];
  let k = particles[ii * 3u + 2u];
  let origin = vec3<f32>(a.x, a.y, a.z);
  let age = a.w;
  let lifetime = b.x;
  let size = b.y;
  let isRing = k.x > 0.5;

  let dead = lifetime <= 0.0 || age >= lifetime;
  let lifeFrac = select(age / max(lifetime, 1e-5), 1.0, dead);
  let corner = CORNERS[vi];

  var world: vec3<f32>;
  var airborne = 1.0;
  if (isRing) {
    let radius = select(mix(RING_START_RADIUS, RING_END_RADIUS, lifeFrac), 0.0, dead);
    world = origin + vec3<f32>(corner.x * radius, 0.0, corner.y * radius);
  } else {
    // Low ballistic arc: x/z drift with the stored velocity, y rises and
    // falls back. Once it is below the launch point it is in the water.
    let dy = INITIAL_UP * age + 0.5 * GRAVITY * age * age;
    airborne = step(0.0, dy);
    let centre = origin + vec3<f32>(b.z * age, dy, b.w * age);
    let scale = select(size * (1.0 - lifeFrac * 0.4), 0.0, dead || dy < 0.0);
    // Billboard the speck around its centre using the camera's right/up.
    let right = vec3<f32>(frame.view[0][0], frame.view[1][0], frame.view[2][0]);
    let up = vec3<f32>(frame.view[0][1], frame.view[1][1], frame.view[2][1]);
    world = centre + (right * corner.x + up * corner.y) * scale;
  }

  var out: VSOut;
  out.pos = frame.viewProj * vec4<f32>(world, 1.0);
  out.local = corner;
  out.lifeFrac = lifeFrac;
  out.world = world;
  out.flags = vec2<f32>(select(0.0, 1.0, isRing), airborne);
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let r = length(in.local);
  var shape: f32;
  var peak: f32;
  if (in.flags.x > 0.5) {
    // Thin annulus that thins further as it spreads.
    let width = mix(0.35, 0.15, in.lifeFrac);
    shape = 1.0 - smoothstep(0.0, width, abs(r - (1.0 - width)));
    peak = RING_PEAK_ALPHA;
  } else {
    let d = clamp(1.0 - r, 0.0, 1.0);
    shape = d * d * in.flags.y;
    peak = DROP_PEAK_ALPHA;
  }
  let fadeIn = smoothstep(0.0, 0.08, in.lifeFrac);
  let fadeOut = 1.0 - smoothstep(0.5, 1.0, in.lifeFrac);
  let near = smoothstep(NEAR_FADE_START, NEAR_FADE_END, distance(in.world, frame.camPos));
  let alpha = shape * fadeIn * fadeOut * near * peak;
  let sunWarm = max(normalize(frame.sunDir).y, 0.0) * FOAM_SUN_WARM;
  let col = vec3<f32>(FOAM_R + sunWarm, FOAM_G, FOAM_B);
  return vec4<f32>(col * alpha, alpha);
}
