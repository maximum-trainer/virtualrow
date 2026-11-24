// Bank pass (#550 FR7, #559 lit receiver): draws the two riverside strips.
// P2 ports the ground *colour* of `bankMaterial.ts` — procedural ground
// with a mild noise band along the water edge. P5 ported the per-biome
// density tile from React's `bankTriplanar.glsl` `grassDensityModulation`
// chunk: `grassTile` carries a baked density field (R channel) and
// `grass.strength` scales how much it biases the colour, so a lusher
// biome reads lusher at the ride-view camera; `strength = 0` on tiers
// where `isShaderGrassEnabled` is false. P4 adds a shadow receiver via
// the shared `sampleShadow` snippet (injected from `shaderSnippets.ts`
// at pipeline-build time).

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

struct Grass {
  strength: f32,
  tileMetres: f32,
  _pad: vec2<f32>,
  // Linear-space mean of the grass half of the atlas. Far ground uses it in
  // place of the tile, which has no mips and would shimmer at distance.
  grassMean: vec3<f32>,
  _pad2: f32,
  // #725 FR5 — the ground plane's biome mix (fields, scrub, green, marsh in
  // xyzw; woodland in groundWood), taken at the boat each frame.
  groundBiome: vec4<f32>,
  groundWood: f32,
  // #745 FR1 — the land's relief at the boat; the ground plane sits at it.
  groundLift: f32,
  _pad4: f32,
  _pad5: f32,
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
@group(2) @binding(0) var<uniform> grass: Grass;
@group(2) @binding(1) var grassTile: texture_2d<f32>;
@group(2) @binding(2) var grassSampler: sampler;
@group(2) @binding(3) var bankAtlas: texture_2d<f32>;
@group(2) @binding(4) var bankAtlasSampler: sampler;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldXZ: vec2<f32>,
  // (sign, shoreDist). sign kept for compatibility; shoreDist drives the
  // triplanar grass-vs-earth mix in the fragment (0 at the water edge,
  // bankWidth at the outer edge of the strip).
  @location(1) side: vec2<f32>,
  @location(2) worldPos: vec3<f32>,
  @location(3) viewZ: f32,
  // #725 FR5 — biome weights (fields, scrub, green, marsh) and woodland;
  // meadow is what is left over.
  @location(4) biome: vec4<f32>,
  @location(5) wood: f32,
};

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) side: vec2<f32>,
  @location(2) biome: vec4<f32>,
  @location(3) wood: f32,
) -> VSOut {
  var out: VSOut;
  out.pos = frame.viewProj * vec4<f32>(position, 1.0);
  out.worldXZ = position.xz;
  out.side = side;
  out.biome = biome;
  out.wood = wood;
  out.worldPos = position;
  let viewPos = frame.view * vec4<f32>(position, 1.0);
  out.viewZ = -viewPos.z;
  return out;
}

// The land beyond the bank strips (`plan/groundPlane.ts`): one camera-relative
// square at bank height. It is shaded by the same fragment function as the
// strips, with `shoreDist` pinned to the strips' outer-edge value, so the two
// surfaces are the same colour where they meet.
const GROUND_SHORE_DIST_M: f32 = 60.0;
// Where, across the bank strip, plain riverside grass starts giving way to
// the biome's own ground (#725 FR5). Complete at the outer edge.
const BIOME_BLEND_START_M: f32 = 10.0;

@vertex
fn vs_ground(@location(0) position: vec3<f32>) -> VSOut {
  var out: VSOut;
  let world = vec3<f32>(position.x + frame.camPos.x, position.y + grass.groundLift, position.z + frame.camPos.z);
  out.pos = frame.viewProj * vec4<f32>(world, 1.0);
  out.worldXZ = world.xz;
  out.side = vec2<f32>(0.0, GROUND_SHORE_DIST_M);
  out.biome = grass.groundBiome;
  out.wood = grass.groundWood;
  out.worldPos = world;
  let viewPos = frame.view * vec4<f32>(world, 1.0);
  out.viewZ = -viewPos.z;
  return out;
}

fn hash12(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.xyx) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Farmland seen from the water: a patchwork of fields with hedge lines
// between them. Returns a tint (rgb) and how much of the grass texture to
// keep (a): crops and ploughed earth are flatter than pasture.
//
// Rows run on a rotated grid so they never line up with a north-south or
// east-west course; each row is cut into fields of uneven length.
const FIELD_ROW_M: f32 = 140.0;
const FIELD_LEN_M: f32 = 230.0;
const HEDGE_HALF_M: f32 = 2.5;

fn fieldPattern(worldXZ: vec2<f32>, dist: f32) -> vec4<f32> {
  let c = 0.819; // cos 35 deg
  let s = 0.574; // sin 35 deg
  let p = vec2<f32>(worldXZ.x * c - worldXZ.y * s, worldXZ.x * s + worldXZ.y * c);
  let row = floor(p.y / FIELD_ROW_M);
  let along = p.x / FIELD_LEN_M + hash12(vec2<f32>(row, 7.0)) * 5.0;
  let col = floor(along);
  let cell = vec2<f32>(col, row);
  let pick = hash12(cell + vec2<f32>(3.1, 17.7));
  let shade = 0.88 + 0.24 * hash12(cell + vec2<f32>(91.0, 5.3));

  // Pasture is the common case; the rest are share-weighted.
  var tint = vec3<f32>(1.0, 1.0, 1.0);
  var keepTex = 1.0;
  if (pick > 0.86) {
    tint = vec3<f32>(0.55, 0.68, 0.50); // copse / rough woodland floor
  } else if (pick > 0.70) {
    tint = vec3<f32>(1.55, 1.30, 0.62); // ripe crop
    keepTex = 0.35;
  } else if (pick > 0.56) {
    tint = vec3<f32>(1.25, 0.92, 0.66); // ploughed
    keepTex = 0.3;
  } else if (pick > 0.36) {
    tint = vec3<f32>(0.82, 1.08, 0.72); // lush ley
  }
  tint = tint * shade;

  // Hedges: distance to the nearest field boundary, in metres.
  let dRow = min(fract(p.y / FIELD_ROW_M), 1.0 - fract(p.y / FIELD_ROW_M)) * FIELD_ROW_M;
  let dCol = min(fract(along), 1.0 - fract(along)) * FIELD_LEN_M;
  let d = min(dRow, dCol);
  // Widen with distance so a hedge stays about a pixel wide, then fade it
  // out before it would alias.
  let halfW = HEDGE_HALF_M + dist * 0.004;
  let hedge = (1.0 - smoothstep(halfW * 0.6, halfW, d)) * (1.0 - smoothstep(700.0, 1300.0, dist));
  tint = mix(tint, vec3<f32>(0.36, 0.50, 0.33), hedge * 0.85);
  keepTex = mix(keepTex, 1.0, hedge);
  return vec4<f32>(tint, keepTex);
}

// Smooth value noise, 0..1, one lattice cell per unit.
fn valueNoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash12(i);
  let b = hash12(i + vec2<f32>(1.0, 0.0));
  let c = hash12(i + vec2<f32>(0.0, 1.0));
  let d = hash12(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Stripes `periodM` apart along `dir`, faded out before they would alias.
fn stripes(worldXZ: vec2<f32>, dir: vec2<f32>, periodM: f32, dist: f32, fadeM: f32) -> f32 {
  let w = 0.5 + 0.5 * sin(dot(worldXZ, dir) * 6.2832 / periodM);
  return mix(w, 0.5, smoothstep(fadeM * 0.4, fadeM, dist));
}

// #725 FR5 — the ground of each biome as a tint (rgb) and how much of the
// grass texture to keep (a). Tints come from `plan/bankBiome.ts`.
fn meadowGround(worldXZ: vec2<f32>, dist: f32) -> vec4<f32> {
  // Drifts of seed heads and buttercups at tens of metres.
  let drift = valueNoise(worldXZ / 23.0);
  let tint = BIOME_TINT_MEADOW * mix(vec3<f32>(0.92, 0.98, 0.95), vec3<f32>(1.12, 1.06, 0.80), drift);
  return vec4<f32>(tint, 0.85);
}

fn fieldsGround(worldXZ: vec2<f32>, dist: f32) -> vec4<f32> {
  let field = fieldPattern(worldXZ, dist);
  // Drill rows inside cropped and ploughed fields (the ones that drop the
  // grass texture), at 3 m, running with the field rows.
  let rows = stripes(worldXZ, vec2<f32>(0.574, 0.819), 3.0, dist, 160.0);
  let cropped = 1.0 - field.a;
  let striped = field.rgb * mix(1.0, 0.82 + 0.36 * rows, cropped);
  return vec4<f32>(striped * BIOME_TINT_FIELDS, field.a);
}

fn scrubGround(worldXZ: vec2<f32>, dist: f32) -> vec4<f32> {
  // Dry ochre ground with dark gorse and bramble clumps.
  let clumps = smoothstep(0.55, 0.75, valueNoise(worldXZ / 7.0));
  let clumpsFar = mix(clumps, 0.3, smoothstep(120.0, 360.0, dist));
  let tint = mix(BIOME_TINT_SCRUB, BIOME_TINT_SCRUB * vec3<f32>(0.42, 0.55, 0.40), clumpsFar);
  return vec4<f32>(tint, 0.55);
}

fn greenGround(worldXZ: vec2<f32>, dist: f32) -> vec4<f32> {
  // Mown: an even bright green in light and dark mower stripes.
  let band = stripes(worldXZ, vec2<f32>(0.819, -0.574), 10.0, dist, 220.0);
  let tint = BIOME_TINT_GREEN * (0.90 + 0.20 * band);
  return vec4<f32>(tint, 0.35);
}

fn marshGround(worldXZ: vec2<f32>, dist: f32) -> vec4<f32> {
  // Reed beds with dark wet hollows between them.
  let wet = smoothstep(0.58, 0.72, valueNoise(worldXZ / 17.0));
  let tint = mix(BIOME_TINT_MARSH, vec3<f32>(0.30, 0.42, 0.44), wet);
  return vec4<f32>(tint, mix(0.7, 0.2, wet));
}

fn woodlandGround(worldXZ: vec2<f32>, dist: f32) -> vec4<f32> {
  // Moss under the canopy, with patches of leaf litter.
  let litter = smoothstep(0.45, 0.70, valueNoise(worldXZ / 9.0));
  let litterFar = mix(litter, 0.35, smoothstep(140.0, 400.0, dist));
  let tint = mix(BIOME_TINT_WOODLAND, vec3<f32>(0.95, 0.72, 0.46), litterFar * 0.6);
  return vec4<f32>(tint, 0.6);
}

// Mixes the six looks by weight. Patterns with no weight are skipped (no
// texture reads inside, so the branches are safe in non-uniform control flow).
fn biomeGround(biome: vec4<f32>, wood: f32, worldXZ: vec2<f32>, dist: f32) -> vec4<f32> {
  let meadowW = max(0.0, 1.0 - biome.x - biome.y - biome.z - biome.w - wood);
  var acc = vec4<f32>(0.0);
  if (meadowW > 0.001) { acc = acc + meadowGround(worldXZ, dist) * meadowW; }
  if (biome.x > 0.001) { acc = acc + fieldsGround(worldXZ, dist) * biome.x; }
  if (biome.y > 0.001) { acc = acc + scrubGround(worldXZ, dist) * biome.y; }
  if (biome.z > 0.001) { acc = acc + greenGround(worldXZ, dist) * biome.z; }
  if (biome.w > 0.001) { acc = acc + marshGround(worldXZ, dist) * biome.w; }
  if (wood > 0.001) { acc = acc + woodlandGround(worldXZ, dist) * wood; }
  // Low-frequency light and dark over a few hundred metres, so no biome is
  // one flat colour from the high camera.
  let broad = 0.86 + 0.28 * valueNoise(worldXZ / 180.0);
  return vec4<f32>(acc.rgb * broad, acc.a);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  // Base palette: the pre-port damp-grass/dry-grass pair stays as a tint
  // so the triplanar albedo doesn't wash the bank into one neutral grey.
  let baseGreen = vec3<f32>(0.32, 0.42, 0.22);
  let baseDry = vec3<f32>(0.52, 0.49, 0.33);
  // Half-metre speckle; averaged out with distance for the same reason the
  // tile is (see `farTex` below).
  let speckleFar = smoothstep(60.0, 220.0, length(in.worldPos.xz - frame.camPos.xz));
  let paletteNoise = mix(hash12(floor(in.worldXZ * 2.0)), 0.5, speckleFar);
  let paletteTint = mix(baseGreen, baseDry, paletteNoise * 0.4);

  // #591-fu P0b: triplanar albedo port of React `bankTriplanar.glsl`'s
  // grass/earth blend. Both tiles live in one atlas (grass left, earth
  // right); UVs tile every ~4 m so bricks of grass and earth don't
  // register as a seamless carpet.
  const GRASS_U_OFFSET: f32 = 0.0;
  const EARTH_U_OFFSET: f32 = 0.5;
  const HALF_U: f32 = 0.5;
  // #591-fu P2b: coarsen the tiling so grass/earth patches read as
  // metres-scale blobs at ride-view distance rather than averaging to a
  // soft gradient. 0.08 u/m means one atlas half covers ~12 m of bank,
  // close to Biketerra's visible patch size on medium chase cam. Both
  // UVs use the same world-space step so the two halves register.
  const BANK_TILE_FREQ: f32 = 0.08;
  let tileU = fract(in.worldXZ.x * BANK_TILE_FREQ) * HALF_U;
  let tileV = fract(in.worldXZ.y * BANK_TILE_FREQ);
  let grassUv = vec2<f32>(GRASS_U_OFFSET + tileU, tileV);
  let earthUv = vec2<f32>(EARTH_U_OFFSET + tileU, tileV);
  let grassTex = textureSample(bankAtlas, bankAtlasSampler, grassUv).rgb;
  let earthTex = textureSample(bankAtlas, bankAtlasSampler, earthUv).rgb;

  // Shore mix: 0 at the water edge, 1 by ~2.5 m out — matches React's
  // `smoothstep(0.0, 2.5, vBankShoreDist)`. Near the shore the ground
  // reads as wet earth; past the band it reads as lush grass.
  let shoreDist = in.side.y;
  let shoreMix = smoothstep(0.0, 2.5, shoreDist);
  let camDist = length(in.worldPos.xz - frame.camPos.xz);
  // The atlas has no mip chain. Past the middle distance a 12 m tile is
  // sub-pixel and shimmers, so ease to its mean colour instead.
  let farTex = smoothstep(90.0, 320.0, camDist);
  let grassCol = mix(grassTex, grass.grassMean, farTex);
  var albedo = mix(earthTex, grassCol, shoreMix);
  // #725 FR5: the biome's own ground takes over from riverside grass across
  // the bank strip and covers the whole ground plane.
  let ground = biomeGround(in.biome, in.wood, in.worldXZ, camDist);
  let groundW = smoothstep(BIOME_BLEND_START_M, GROUND_SHORE_DIST_M, shoreDist);
  albedo = mix(albedo, mix(grass.grassMean, albedo, ground.a) * ground.rgb, groundW);
  // Palette-tint the albedo so a residential profile keeps the warm
  // sandstone tone and a wetland reads cool/green, same way the
  // triplanar tile is multiplied by `diffuseColor.rgb` on the React side.
  albedo = albedo * paletteTint * 1.6;

  // Macro-scale lushness noise (React's `bankMacroNoise`): a 64 m-grid
  // light/dark modulation so a long bank doesn't read as a repeating
  // 4 m stamp. Keeps near-camera texel density but adds metres-scale
  // variation.
  let macroN = 0.9 + 0.2 * hash12(floor(in.worldXZ * 0.015625));
  var col = albedo * macroN;

  // Biome-density grass modulation (#496 Phase 2, kept from the earlier
  // slice). Scales the colour, not the texture mix, so a wetter biome
  // boosts lushness without turning the shore wet-earth strip green.
  let tileMetres = max(grass.tileMetres, 1.0);
  let densityUv = in.worldXZ / tileMetres;
  let density = mix(textureSample(grassTile, grassSampler, densityUv).r, 0.5, farTex);
  let boost = mix(1.0, 0.72 + 0.56 * density, grass.strength);
  col = col * boost;

  // #591-fu P2a: sky/ground hemisphere ambient + half-lambert, mirroring
  // the term `floraSolid.wgsl` and `sceneryMesh.wgsl` already use. The
  // bank is flat, so the geometric normal is (0, 1, 0) — `sky` always
  // reads 1 and the ground tint drops out, which is the right answer for
  // a horizontal surface facing up at the sky. The sun contribution is
  // half-lambert squared, modulated by the cascade shadow factor so a
  // fully-shadowed bank fragment carries just the hemisphere ambient.
  // #745 FR1: the bank climbs with the route's relief, so take the normal
  // from the surface itself (flat ground gives straight up).
  let faceN = normalize(cross(dpdy(in.worldPos), dpdx(in.worldPos)));
  let n = select(vec3<f32>(0.0, 1.0, 0.0), faceN * sign(faceN.y), abs(faceN.y) > 0.2);
  let sun = normalize(frame.sunDir);
  let halfLambert = clamp(dot(n, sun) * 0.5 + 0.5, 0.0, 1.0);
  let sky = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
  // #730: the conditions tint the ambient and the sun; both are exactly 1
  // at Midday, so the shade below is the pre-#730 value there.
  let ambient = mix(vec3<f32>(0.22, 0.20, 0.18), vec3<f32>(0.42, 0.46, 0.52), sky) * lighting.ambient.rgb;
  var lit = sampleShadow(in.worldPos, in.viewZ);
  // #730 FR4: Overcast softens the shadow; strength 1 leaves it untouched.
  if (lighting.sun.w < 1.0) {
    lit = mix(1.0, lit, lighting.sun.w);
  }
  let shade = ambient + halfLambert * halfLambert * 0.75 * lit * lighting.sun.rgb;
  let shaded = col * shade;
  // Dissolve into the sky behind at the horizon (HORIZON_HAZE_WGSL).
  return vec4<f32>(applyFog(shaded, in.worldPos - frame.camPos), horizonAlpha(camDist));
}
