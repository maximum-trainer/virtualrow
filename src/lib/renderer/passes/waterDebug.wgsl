// Water-debug diagnostics pass (#493 Phase 3d / FR22). Line-list draw
// with a flat colour-per-vertex; no shadows, no fog, so the overlay
// stays legible against the water.

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

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) col: vec3<f32>,
};

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) colour: vec3<f32>,
) -> VSOut {
  var out: VSOut;
  out.pos = frame.viewProj * vec4<f32>(position, 1.0);
  out.col = colour;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  return vec4<f32>(in.col, 1.0);
}
