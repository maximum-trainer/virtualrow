// Water pass (#550 FR6, #559 lit receiver): route-aligned strip. P2 ships
// colour and a Gerstner ripple approximation of today's
// `waterMaterial.ts` look. Reflections and caustics are later phases.
// P4 adds a shadow receiver via the shared `sampleShadow` snippet
// (injected from `shaderSnippets.ts` at pipeline-build time).

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

// #730 VP-12 — the rower's conditions (Dawn / Midday / Golden hour /
// Overcast / Dusk). Mirrors `packFrameLighting` in `engine/uniforms.ts`;
// `wgsl.test.ts` checks the size. Midday (and no conditions) packs every
// multiplier as exactly 1 and every shift as 0, so the maths below draws
// the pre-#730 frame unchanged.
struct Lighting {
  sun: vec4<f32>,          // rgb direct-light multiplier, w shadowStrength
  ambient: vec4<f32>,      // rgb ambient multiplier, w sunDisc
  zenith: vec4<f32>,       // rgb day zenith, w cloudThresholdShift
  horizonCool: vec4<f32>,  // rgb, w cloudAlpha
  horizonWarm: vec4<f32>,  // rgb, w waterSpecular
  sunDisc: vec4<f32>,      // rgb disc colour, w exposureBias (postFx)
  cloudTint: vec4<f32>,    // rgb, w cloudCover
  waterTint: vec4<f32>,    // rgb, w fogDensityScale (CPU-side)
};
@group(0) @binding(1) var<uniform> lighting: Lighting;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldXZ: vec2<f32>,
  @location(1) worldPos: vec3<f32>,
  @location(2) viewZ: f32,
};

@vertex
fn vs_main(@location(0) position: vec3<f32>) -> VSOut {
  // Larger wave amplitude so the river visibly rolls under the chase
  // camera; the previous 8/4 cm reads as still water from a 2.6 m cam.
  let k = vec2<f32>(0.9, 0.2);
  let w = dot(k, position.xz) + frame.time * 1.3;
  let dy = sin(w) * 0.18 + sin(w * 1.9 + 0.4) * 0.09;
  let p = vec3<f32>(position.x, position.y + dy, position.z);

  var out: VSOut;
  out.pos = frame.viewProj * vec4<f32>(p, 1.0);
  out.worldXZ = position.xz;
  out.worldPos = p;
  let viewPos = frame.view * vec4<f32>(p, 1.0);
  out.viewZ = -viewPos.z;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let shallow = vec3<f32>(0.22, 0.52, 0.58);
  let deep = vec3<f32>(0.07, 0.22, 0.36);
  // Deeper modulation + a second (orthogonal, lower-freq) ripple so the
  // water surface reads as moving from the chase camera. Previously
  // ripple × 0.6 was too subtle to notice during a row.
  let ripple = 0.5 + 0.5 * sin(in.worldXZ.x * 0.6 + frame.time * 2.0)
                   * cos(in.worldXZ.y * 0.5 - frame.time * 1.1);
  let secondary = 0.5 + 0.5 * sin(in.worldXZ.x * 0.11 - frame.time * 0.6)
                      * cos(in.worldXZ.y * 0.09 + frame.time * 0.4);
  let col = mix(deep, shallow, clamp(ripple * 0.85 + secondary * 0.3 - 0.15, 0.0, 1.0));
  // #730 FR4: Overcast softens the shadow (strength < 1); 1 is today's.
  var lit = sampleShadow(in.worldPos, in.viewZ);
  if (lighting.sun.w < 1.0) {
    lit = mix(1.0, lit, lighting.sun.w);
  }
  // Water takes a lighter shadow — only the reflection dims.
  var shaded = col * (0.75 + 0.25 * lit) * lighting.waterTint.rgb;
  // #730: a low sun lays a glint down the water. waterSpecular is 0 at
  // Midday and under Overcast, so those frames skip it entirely.
  let spec = lighting.horizonWarm.w;
  if (spec > 0.0) {
    let ripple2 = vec3<f32>(
      0.08 * sin(in.worldXZ.x * 1.7 + frame.time * 2.3),
      1.0,
      0.08 * cos(in.worldXZ.y * 1.3 - frame.time * 1.9),
    );
    let n = normalize(ripple2);
    let v = normalize(frame.camPos - in.worldPos);
    let r = reflect(-v, n);
    let glint = pow(max(dot(r, normalize(frame.sunDir)), 0.0), 48.0);
    shaded = shaded + lighting.sun.rgb * (glint * spec * lit);
  }
  // Dissolve into the sky at the horizon in step with the land
  // (HORIZON_HAZE_WGSL), so distant water is not left as a hard blue line.
  let camDist = length(in.worldPos.xz - frame.camPos.xz);
  return vec4<f32>(shaded, horizonAlpha(camDist));
}
