// Hull wake foam (#571, reworked by #722 VP-04). One instance per
// particle in the pool, six verts per instance from a static CORNERS
// array. Each patch is a quad lying flat on the water (FR1) that spreads
// and fades over its life (FR2), broken up by value noise so it reads as
// foam rather than a disc. Patches near the camera fade out (FR5) and the
// colour is pre-exposed below bloom's threshold (FR6).
//
// Constants marked `mirror` are checked against the CPU side by
// `engine/__tests__/wakeParticles.test.ts` + `particleLook.test.ts`.

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

// Per particle: (x, y, z, age), (lifetime, size, seed, _). A storage
// buffer lets the vertex shader read each particle via `instance_index`.
@group(2) @binding(0) var<storage, read> particles: array<vec4<f32>>;

const FOAM_Y: f32 = -0.08;            // mirror: WAKE_FOAM_Y
const START_RADIUS: f32 = 0.22;       // mirror: WAKE_START_RADIUS_METRES
const END_RADIUS: f32 = 0.85;         // mirror: WAKE_END_RADIUS_METRES
const PEAK_ALPHA: f32 = 0.32;         // mirror: WAKE_PEAK_ALPHA
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
  @location(3) seed: f32,
};

// Six verts form two triangles over the unit quad [-1, 1] in local space.
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
  let a = particles[ii * 2u];
  let b = particles[ii * 2u + 1u];
  let age = a.w;
  let lifetime = b.x;
  let size = b.y;
  let seed = b.z;

  // Dead particles collapse to zero so they're invisible without a CPU
  // compact — avoids a per-frame GPU-upload shrink.
  let dead = lifetime <= 0.0 || age >= lifetime;
  let lifeFrac = select(age / max(lifetime, 1e-5), 1.0, dead);
  let liveRadius = size * mix(START_RADIUS, END_RADIUS, lifeFrac);
  let radius = select(liveRadius, 0.0, dead);

  // Spin each patch by its seed so neighbours don't share a noise layout.
  let ang = seed * 6.2831853;
  let c = cos(ang);
  let s = sin(ang);
  let corner = CORNERS[vi];
  let rotated = vec2<f32>(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
  let world = vec3<f32>(a.x + rotated.x * radius, FOAM_Y, a.z + rotated.y * radius);

  var out: VSOut;
  out.pos = frame.viewProj * vec4<f32>(world, 1.0);
  out.local = corner;
  out.lifeFrac = lifeFrac;
  out.world = world;
  out.seed = seed;
  return out;
}

fn hash2(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn valueNoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash2(i);
  let b = hash2(i + vec2<f32>(1.0, 0.0));
  let c = hash2(i + vec2<f32>(0.0, 1.0));
  let d = hash2(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  // Soft radial falloff: 1 at the centre, 0 at the quad's inscribed circle.
  let r = length(in.local);
  let radial = 1.0 - smoothstep(0.35, 1.0, r);
  // Break-up: two octaves of value noise; the threshold rises with age so
  // the patch frays into flecks as it spreads.
  let p = in.local * 2.5 + vec2<f32>(in.seed * 17.0, in.seed * 31.0);
  let n = 0.65 * valueNoise(p) + 0.35 * valueNoise(p * 2.3);
  let breakUp = smoothstep(0.25 + 0.3 * in.lifeFrac, 0.75, n);
  let fadeIn = smoothstep(0.0, 0.15, in.lifeFrac);
  let fadeOut = 1.0 - smoothstep(0.4, 1.0, in.lifeFrac);
  let near = smoothstep(NEAR_FADE_START, NEAR_FADE_END, distance(in.world, frame.camPos));
  let alpha = radial * breakUp * fadeIn * fadeOut * near * PEAK_ALPHA;
  let sunWarm = max(normalize(frame.sunDir).y, 0.0) * FOAM_SUN_WARM;
  let col = vec3<f32>(FOAM_R + sunWarm, FOAM_G, FOAM_B);
  return vec4<f32>(col * alpha, alpha);
}
