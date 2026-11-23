// #731 VP-13 FR3 — FXAA on the final, tone-mapped frame. The classic
// edge-direction FXAA (Lottes): skip low-contrast pixels, find the edge's
// direction from the four diagonal lumas, blend two and four taps along
// it, and keep the four-tap result unless it overshoots the local range.
// `engine/postFxMath.ts` (`fxaa`) is the CPU twin the unit tests run.

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

const FXAA_REDUCE_MIN: f32 = 1.0 / 128.0;
const FXAA_REDUCE_MUL: f32 = 1.0 / 8.0;
const FXAA_SPAN_MAX: f32 = 8.0;
const FXAA_EDGE_MIN: f32 = 0.0312;
const FXAA_EDGE_REL: f32 = 0.125;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var tri = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 3.0,  1.0),
  );
  var out: VSOut;
  let xy = tri[vi];
  out.pos = vec4<f32>(xy, 0.0, 1.0);
  out.uv = vec2<f32>((xy.x + 1.0) * 0.5, 1.0 - (xy.y + 1.0) * 0.5);
  return out;
}

fn fxaaLuma(c: vec3<f32>) -> f32 {
  // Perceptual enough for edge finding whatever the target's encoding.
  return sqrt(dot(c, vec3<f32>(0.299, 0.587, 0.114)));
}

fn tap(uv: vec2<f32>) -> vec3<f32> {
  return textureSampleLevel(src, samp, uv, 0.0).rgb;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let px = 1.0 / vec2<f32>(textureDimensions(src));
  let uv = in.uv;
  let rgbM = tap(uv);
  let lM = fxaaLuma(rgbM);
  let lNW = fxaaLuma(tap(uv + vec2<f32>(-1.0, -1.0) * px));
  let lNE = fxaaLuma(tap(uv + vec2<f32>( 1.0, -1.0) * px));
  let lSW = fxaaLuma(tap(uv + vec2<f32>(-1.0,  1.0) * px));
  let lSE = fxaaLuma(tap(uv + vec2<f32>( 1.0,  1.0) * px));
  let lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  let lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(FXAA_EDGE_MIN, lMax * FXAA_EDGE_REL)) {
    return vec4<f32>(rgbM, 1.0);
  }
  var dir = vec2<f32>(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  let reduce = max((lNW + lNE + lSW + lSE) * 0.25 * FXAA_REDUCE_MUL, FXAA_REDUCE_MIN);
  let rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpMin, vec2<f32>(-FXAA_SPAN_MAX), vec2<f32>(FXAA_SPAN_MAX)) * px;
  let rgbA = 0.5 * (tap(uv + dir * (1.0 / 3.0 - 0.5)) + tap(uv + dir * (2.0 / 3.0 - 0.5)));
  let rgbB = rgbA * 0.5 + 0.25 * (tap(uv + dir * -0.5) + tap(uv + dir * 0.5));
  let lB = fxaaLuma(rgbB);
  if (lB < lMin || lB > lMax) {
    return vec4<f32>(rgbA, 1.0);
  }
  return vec4<f32>(rgbB, 1.0);
}
