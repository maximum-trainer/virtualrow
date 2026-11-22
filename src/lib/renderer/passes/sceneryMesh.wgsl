// Instanced static-mesh scenery pass. Draws GLB-loaded meshes (course
// furniture, structures, …) at per-instance mat4 transforms. Each vertex
// carries its glTF primitive's base colour (so a multi-material model keeps
// trunk/leaves, walls/roof/windows distinct); sun shade from the frame uniform.

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
// One record per instance (96 B, `SCENERY_INSTANCE_BYTES`). `tint.rgb` is
// the colour, `tint.a` how far the authored colour moves to it; `fx.x` is
// the opacity, `fx.y` a lime fresnel rim, `fx.z` how flat (unshaded) the
// tint is, `fx.w` the share of the distance haze it takes. The race ghost (#728 FR2) and the fleet's hulls (#713 D3a) set them;
// everything else draws as authored (tint.a 0, fx.x 1).
struct SceneryInstance {
  model: mat4x4<f32>,
  tint: vec4<f32>,
  fx: vec4<f32>,
};
@group(1) @binding(1) var<storage, read> instances: array<SceneryInstance>;

struct VsIn {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec4<f32>,
};

struct VsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) worldNormal: vec3<f32>,
  @location(1) worldDist: f32,
  @location(2) color: vec4<f32>,
  @location(3) toCamera: vec3<f32>,
  @location(4) @interpolate(flat) instance: u32,
};

@vertex
fn vs_main(in: VsIn, @builtin(instance_index) ii: u32) -> VsOut {
  let model = instances[ii].model;
  let world = model * vec4<f32>(in.position, 1.0);
  let n = (model * vec4<f32>(in.normal, 0.0)).xyz;

  var out: VsOut;
  out.clip = frame.viewProj * world;
  out.worldNormal = normalize(n);
  let d = world.xyz - frame.camPos;
  out.worldDist = length(vec3<f32>(d.x, 0.0, d.z));
  out.color = in.color;
  out.toCamera = frame.camPos - world.xyz;
  out.instance = ii;
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let sun = normalize(frame.sunDir);
  let n = normalize(in.worldNormal);
  // Hemisphere ambient (sky above, ground below) + half-lambert for the
  // sun: the old `0.35 + 0.65*diffuse` had no sky/ground bias, so GLB
  // kit trees and buildings read as uniformly flat and foliage lost its
  // depth. The ambient magnitudes keep an unlit face above the old 0.35
  // floor so nothing goes muddy.
  let halfLambert = clamp(dot(n, sun) * 0.5 + 0.5, 0.0, 1.0);
  let sky = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
  let ambient = mix(vec3<f32>(0.22, 0.20, 0.18), vec3<f32>(0.42, 0.46, 0.52), sky);
  let shade = ambient + halfLambert * halfLambert * 0.75;
  let inst = instances[in.instance];
  let lit = in.color.rgb * shade;
  // #728 FR2 / #713 D3a — per-instance tint. `flat` holds the tint's
  // brightness whatever the light, so the ghost reads the same at dusk
  // as at midday.
  let tinted = mix(inst.tint.rgb * shade, inst.tint.rgb, inst.fx.z);
  var col = mix(lit, tinted, inst.tint.a);
  if (inst.fx.y > 0.0) {
    let v = normalize(in.toCamera);
    let fresnel = pow(1.0 - clamp(abs(dot(n, v)), 0.0, 1.0), 2.0);
    col = col + vec3<f32>(0.55, 1.0, 0.25) * fresnel * inst.fx.y;
  }
  // Fog with the frame's exponential density, but capped at a modest
  // atmospheric-haze ceiling. The baseline fog `[0.001, 0.0005]` reaches
  // `f ≈ 0.84` at 60 m, and `fogCol` is a pale blue-grey `(0.72, 0.78, 0.82)`,
  // so an unclamped mix bleaches mid-distance tier-E scenery (trees, foliage)
  // toward near-pure fog — the trees read as transparent pale silhouettes
  // instead of green/brown. Capping at 0.35 keeps the depth cue while letting
  // the authored tint still show through. Other geometry (bank, water, boat)
  // declares `fog` but doesn't apply it; the sprite flora pass is separate.
  let density = frame.fog.x + frame.fog.y * in.worldDist;
  let f = clamp(1.0 - exp(-density * in.worldDist), 0.0, 1.0);
  let fogCol = vec3<f32>(0.72, 0.78, 0.82);
    // The race ghost opts out (`fx.w` 0): haze over a dark hull would pull
  // it towards the water's brightness (#728 FR2).
  return vec4<f32>(mix(col, fogCol, min(f, 0.35) * inst.fx.w), in.color.a * inst.fx.x);
}
