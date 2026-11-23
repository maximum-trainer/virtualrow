// Depth-aware (bilateral) blur of the half-resolution SSAO term (#732 FR3).
// Reads the raw AO and the full-resolution depth; writes the blurred AO at
// half resolution. Taps whose linear depth differs from the centre's are
// weighted down, so occlusion does not bleed from a near object onto the
// sky or water behind it. Only the AO factor is blurred, never colour.
// Mirrors `bilateralDepthWeight` in postFxMath.ts.

struct BlurUniforms {
  near: f32,
  far: f32,
  sigma: f32,
  _pad0: f32,
};

@group(0) @binding(0) var aoTex: texture_2d<f32>;
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var<uniform> u: BlurUniforms;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var tri = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 3.0,  1.0),
  );
  var out: VSOut;
  out.pos = vec4<f32>(tri[vi], 0.0, 1.0);
  return out;
}

// WebGPU depth in [0, 1] (near → 0) back to metres.
fn linearDepth(d: f32) -> f32 {
  return (u.near * u.far) / max(u.far - d * (u.far - u.near), 1e-6);
}

fn depthAt(halfPx: vec2<i32>) -> f32 {
  let full = textureDimensions(depthTex);
  let p = clamp(halfPx * 2, vec2<i32>(0, 0), vec2<i32>(full) - vec2<i32>(1, 1));
  return linearDepth(textureLoad(depthTex, p, 0));
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let size = vec2<i32>(textureDimensions(aoTex));
  let c = vec2<i32>(in.pos.xy);
  let centreDepth = depthAt(c);
  var sum = 0.0;
  var weights = 0.0;
  for (var dy = -2; dy <= 2; dy = dy + 1) {
    for (var dx = -2; dx <= 2; dx = dx + 1) {
      let p = clamp(c + vec2<i32>(dx, dy), vec2<i32>(0, 0), size - vec2<i32>(1, 1));
      let rel = abs(depthAt(p) - centreDepth) / max(centreDepth, 1e-3);
      let w = exp(-(rel * rel) / (2.0 * u.sigma * u.sigma));
      sum = sum + textureLoad(aoTex, p, 0).r * w;
      weights = weights + w;
    }
  }
  let ao = sum / max(weights, 1e-4);
  return vec4<f32>(ao, ao, ao, 1.0);
}
