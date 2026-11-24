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
  // #734 VP-16 — the surface normal comes from twelve wave trains a golden
  // angle apart plus a detail octave (`waterSlope`, generated from
  // `plan/waterWaves.ts`), so no camera sees the old sin(x)·cos(z)
  // checkerboard. The colour is the body of the water mixed, by Fresnel,
  // toward the sky it reflects (`skyColourToward`, the sky pass's own
  // gradient), plus a lobe of sun. `plan/waterWaves.ts` holds a CPU twin.
  let toCam = frame.camPos - in.worldPos;
  let camDist = length(toCam.xz);
  let v = normalize(toCam);
  let g = waterSlope(in.worldXZ, frame.time, camDist);
  let n = normalize(vec3<f32>(-g.x, 1.0, -g.y));
  // #730 FR4: Overcast softens the shadow (strength < 1); 1 is today's.
  var lit = sampleShadow(in.worldPos, in.viewZ);
  if (lighting.sun.w < 1.0) {
    lit = mix(1.0, lit, lighting.sun.w);
  }
  // Light scattered up out of the water; a shadow dims it, not the sky it reflects.
  let body = WATER_BODY * lighting.waterTint.rgb * (0.7 + 0.3 * lit);
  let nv = clamp(dot(n, v), 0.0, 1.0);
  let r = reflect(-v, n);
  let sky = skyColourToward(vec3<f32>(r.x, max(r.y, 0.0), r.z));
  let fresnel = WATER_F0 + (1.0 - WATER_F0) * pow(1.0 - nv, 5.0);
  var col = mix(body, sky, fresnel);
  // The sun's lobe: none under Overcast (sunDisc 0), brighter for a low
  // sun (waterSpecular, the #730 glint), always masked by the shadow.
  let hv = normalize(v + normalize(frame.sunDir));
  let lobe = pow(max(dot(n, hv), 0.0), WATER_SPECULAR_POWER)
    * lighting.ambient.w * (0.6 + lighting.horizonWarm.w) * lit;
  col = col + vec3<f32>(1.0, 0.96, 0.88) * lighting.sun.rgb * lobe;
  // FR3: dissolve into the sky at the horizon in step with the land
  // (HORIZON_HAZE_WGSL), so the far waterline is soft.
  return vec4<f32>(applyFog(col, in.worldPos - frame.camPos), horizonAlpha(camDist));
}
