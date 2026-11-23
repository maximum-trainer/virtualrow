// Auto-exposure luminance measurement (#574 slice, #732 FR2). A one-pixel
// render-to-texture: samples the HDR scene at a sparse grid, averages the
// LOG of per-sample luminance, and writes the result as the sole R32F texel.
// The composite pass reads that single pixel next and scales the scene
// before tonemap, within ±0.7 EV of the authored exposure.
//
// #732: the sky is left out (only the lower 60% of the frame is metered,
// weighted to the centre), and the value adapts from the previous frame's
// over a 0.6 s time constant instead of jumping, so a cloud or a camera cut
// eases in over ~1.5 s. Mirrors `meteringWeight` / `adaptLogLuminance` in
// postFxMath.ts.

@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
// The previous frame's adapted log-luminance (the other 1×1 texture).
@group(0) @binding(2) var previous: texture_2d<f32>;

struct MeterUniforms {
  dt: f32,
  // 1 on the first frame: take the measurement as-is.
  reset: f32,
  _pad0: f32,
  _pad1: f32,
};
@group(0) @binding(3) var<uniform> m: MeterUniforms;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  // The fragment target is a single pixel; a 1x1 triangle covers it.
  let xy = vec2<f32>(
    f32((vi << 1u) & 2u),
    f32(vi & 2u),
  );
  var out: VSOut;
  out.pos = vec4<f32>(xy * 2.0 - 1.0, 0.0, 1.0);
  return out;
}

const SAMPLE_GRID: u32 = 8u;  // 8×8 = 64 taps across the frame
const INV_GRID: f32 = 1.0 / 8.0;
// Luminance weights per Rec. 709; the HDR scene is linear so this reads
// perceived brightness roughly correctly.
const LUMA_WEIGHTS: vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);
// Clamp per-sample lum so a single over-bright specular doesn't skew the
// log mean; and a floor so log(0) doesn't blow up.
const LUMA_MIN: f32 = 1e-4;
const LUMA_MAX: f32 = 32.0;

const METER_TOP: f32 = 0.4;
const ADAPT_TAU_S: f32 = 0.6;

fn meterWeight(uv: vec2<f32>) -> f32 {
  if (uv.y < METER_TOP) {
    return 0.0;
  }
  let dx = (uv.x - 0.5) * 2.0;
  let dy = ((uv.y - METER_TOP) / (1.0 - METER_TOP) - 0.5) * 2.0;
  return max(0.1, 1.0 - 0.5 * (dx * dx + dy * dy));
}

@fragment
fn fs_main() -> @location(0) f32 {
  var sum = 0.0;
  var weights = 0.0;
  for (var y: u32 = 0u; y < SAMPLE_GRID; y = y + 1u) {
    for (var x: u32 = 0u; x < SAMPLE_GRID; x = x + 1u) {
      // Taps spread over the metered band (the lower 60% of the frame).
      let cell = (vec2<f32>(f32(x), f32(y)) + 0.5) * INV_GRID;
      let uv = vec2<f32>(cell.x, METER_TOP + cell.y * (1.0 - METER_TOP));
      let w = meterWeight(uv);
      let col = textureSampleLevel(scene, samp, uv, 0.0).rgb;
      let lum = clamp(dot(col, LUMA_WEIGHTS), LUMA_MIN, LUMA_MAX);
      sum = sum + log(lum) * w;
      weights = weights + w;
    }
  }
  let measured = sum / max(weights, 1e-4);
  if (m.reset > 0.5) {
    return measured;
  }
  let prev = textureLoad(previous, vec2<i32>(0, 0), 0).r;
  let k = 1.0 - exp(-max(m.dt, 0.0) / ADAPT_TAU_S);
  return prev + (measured - prev) * k;
}
