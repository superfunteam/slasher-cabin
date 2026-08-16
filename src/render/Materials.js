/**
 * Shared material library + the global uniform system.
 *
 * OWNER: Materials agent. See ARCHITECTURE.md §10/§12 and ART_DIRECTION.md §2/§5.
 *
 * Every material in the game is created here exactly once during init() and reused. All
 * shader work is done with `onBeforeCompile` so shadows, fog and tone mapping keep working,
 * and every patched program carries a `customProgramCacheKey` so variants never collide.
 *
 * ---------------------------------------------------------------------------------------
 * PUBLIC API (this is the contract other agents code against)
 * ---------------------------------------------------------------------------------------
 *   const mats = ctx.systems.get('Materials');
 *
 *   mats.get('bark-pine')                -> THREE.Material   (shared, never dispose it yourself)
 *   mats.has(name) / mats.list()
 *   mats.getDepthMaterial('foliage-pine')-> THREE.MeshDepthMaterial with the SAME wind
 *                                           displacement, so wind-blown shadows match.
 *                                           Assign to `mesh.customDepthMaterial`.
 *   mats.patchMaterial(myMaterial, opts) -> opt an externally-authored material into the
 *                                           wetness / detail-normal / wind system.
 *   mats.setAlphaToCoverage(bool)        -> Postprocessing may flip this on if it renders
 *                                           into a multisampled target.
 *   mats.heightFog = false               -> disable the height-fog upgrade (Sky/VolumetricFog
 *                                           may want to own the analytic term instead).
 *
 *   Materials.globalUniforms  (static, also `mats.globalUniforms`)
 *     A plain object of THREE.Uniform, created at module scope so it is safe to import and
 *     reference BEFORE Materials has been constructed. Updated once per frame.
 *
 *       uTime        float    seconds since start
 *       uDeltaTime   float    last frame dt
 *       uWind        Vector3  wind direction * strength (m/s-ish, 0..1.4 typical)
 *       uWindDir     Vector3  normalized wind direction
 *       uWindGust    float    0..1 gust envelope, spiky
 *       uPlayerPos   Vector3  world position of the player (falls back to the camera)
 *       uRain        float    0..1 instantaneous rain
 *       uRainAccum   float    0..1 integrated rainfall this night
 *       uWetness     float    0..1 global surface wetness (never below WET_FLOOR)
 *       uPuddle      float    0..1 puddle accumulation level
 *       uLightning   float    0..1 lightning flash envelope
 *       uMoonDir     Vector3  normalized direction TO the moon
 *       uNightPhase  float    0..1 dawn at 1.0
 *
 * ---------------------------------------------------------------------------------------
 * OPTIONAL GEOMETRY ATTRIBUTES (all optional — absent attributes read as 0 and the shader
 * falls back to sensible defaults, so nothing breaks if you never supply them)
 * ---------------------------------------------------------------------------------------
 *   aExposure : vec2  x = sky exposure 0..1 (0 = sheltered, dry), y = 1.0 validity flag.
 *                     If y is not set the surface is treated as fully exposed.
 *                     THIS IS FAILURE MODE #5 IN ART_DIRECTION.md — supply it on trunks,
 *                     the tarp, and anything under the canopy or the cabin roof.
 *   aWind     : vec2  x = flexibility override 0..1 (0 = derive from local height),
 *                     y = phase offset 0..1 (0 = derive from the instance origin).
 *
 * Per-instance sway phase and the ±9% per-instance albedo variation are derived from
 * `instanceMatrix` automatically — you get them for free on any InstancedMesh.
 */

import * as THREE from 'three';
import { Log } from '../core/Log.js';
import { Rand, hashStr } from '../core/Rand.js';

/* ======================================================================================
 * Module-scope scratch — ARCHITECTURE.md §12: no allocation in update().
 * ==================================================================================== */
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _rgb = { r: 0, g: 0, b: 0 };

/* ======================================================================================
 * Palette (ART_DIRECTION.md §2.2 / §2.3). sRGB display values, converted by THREE.Color.
 * ==================================================================================== */
const PAL = {
  shadowAbyss: 0x060b0e,
  shadowBase: 0x0a1216,
  midSlate: 0x243740,
  midStone: 0x3b464b,
  moonKey: 0x7d95c4,
  moonRim: 0xaebcdc,
  moonSpec: 0xd6e0f2,
  fogNear: 0x2a3a44,
  fogFar: 0x54697a,
  fogLit: 0x8fa6bb,
  foliageWet: 0x131f1a,
  foliageDead: 0x4a4433,
  barkDry: 0x38312a,
  barkBirch: 0xb9b6a6,
  waterBody: 0x0b171c,
  bloodFresh: 0x7a1013,
  bloodHot: 0xa8161a,
  bloodDry: 0x3a1113,
  skinWet: 0x6b5148,
  canvas: 0x5c5b46,
  steelGalv: 0x9aa0a3,
  tin: 0x7d8487,
  rust: 0x7a4526,
  lumber: 0xa8875c,
  mud: 0x2a221b,
  mudDeep: 0x221b15,
  moss: 0x1d2b1c,
  fern: 0x1a2a22,
  weathered: 0x6b6155,
  concrete: 0x3f4442,
  tarp: 0x2f4550,
  rope: 0x5a5038,
};

/** The world is damp on every night (ART_DIRECTION.md §5.1). Never fully dry. */
const WET_FLOOR = 0.26;

/* ======================================================================================
 * Global uniforms. Created at module scope so `Materials.globalUniforms` is valid the
 * instant this module is imported, long before any instance exists.
 * ==================================================================================== */
const GLOBAL_UNIFORMS = {
  uTime: new THREE.Uniform(0),
  uDeltaTime: new THREE.Uniform(1 / 60),
  uWind: new THREE.Uniform(new THREE.Vector3(0.7, 0, 0.35)),
  uWindDir: new THREE.Uniform(new THREE.Vector3(0.894, 0, 0.447)),
  uWindGust: new THREE.Uniform(0),
  uPlayerPos: new THREE.Uniform(new THREE.Vector3(0, 1.7, 0)),
  uRain: new THREE.Uniform(0.15),
  uRainAccum: new THREE.Uniform(0.1),
  uWetness: new THREE.Uniform(WET_FLOOR),
  uPuddle: new THREE.Uniform(0),
  uLightning: new THREE.Uniform(0),
  uMoonDir: new THREE.Uniform(new THREE.Vector3(0.794, 0.438, 0.421)),
  uNightPhase: new THREE.Uniform(0),
};

/* ======================================================================================
 * GLSL — shared helper library. Injected into `#include <common>` in both stages.
 * ==================================================================================== */

const GLSL_HELPERS = /* glsl */`
// ------------------------------------------------------------------ Slasher Cabin helpers
float scChannel4(vec4 v, float c) {
  return c < 0.5 ? v.r : (c < 1.5 ? v.g : (c < 2.5 ? v.b : v.a));
}

float scHash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

vec2 scHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float scNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = scHash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = scHash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = scHash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = scHash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = scHash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = scHash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = scHash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = scHash13(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

// Very low frequency breakup. Two octaves is plenty at a 30 m base scale.
float scFbm3(vec3 p) {
  return scNoise3(p) * 0.65 + scNoise3(p * 2.37 + 11.3) * 0.35;
}

float scFbm2(vec2 p) {
  vec3 q = vec3(p, 0.0);
  return scNoise3(q) * 0.58 + scNoise3(q * 2.13 + 7.7) * 0.29 + scNoise3(q * 4.71 + 3.1) * 0.13;
}

// Reoriented normal mapping (Barre-Brisebois & Bouchard). NOT naive addition — this is what
// keeps a detail normal from flattening the macro relief it sits on.
vec3 scRNM(vec3 base, vec3 detail) {
  vec3 t = base + vec3(0.0, 0.0, 1.0);
  vec3 u = detail * vec3(-1.0, -1.0, 1.0);
  return normalize(t * dot(t, u) / max(t.z, 1e-4) - u);
}

// Voronoi cell id + distance to the cell edge — used for galvanizing spangle.
vec3 scVoronoi(vec2 x) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  float md = 8.0;
  vec2 mg = vec2(0.0);
  vec2 mr = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = scHash22(n + g);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < md) { md = d; mg = g; mr = r; }
    }
  }
  vec2 id = scHash22(n + mg);
  return vec3(id.x, sqrt(md), id.y);
}

vec3 scTriBlendWeights(vec3 n, float sharpness) {
  vec3 b = pow(abs(n), vec3(sharpness));
  return b / max(b.x + b.y + b.z, 1e-4);
}

vec4 scTriSample(sampler2D tex, vec3 p, vec3 w) {
  return texture2D(tex, p.zy) * w.x
       + texture2D(tex, p.xz) * w.y
       + texture2D(tex, p.xy) * w.z;
}

// Whiteout/RNM triplanar normal blend. Returns a WORLD-space normal.
vec3 scTriNormal(sampler2D tex, vec3 p, vec3 wn, vec3 w, float strength) {
  vec3 nx = texture2D(tex, p.zy).xyz * 2.0 - 1.0;
  vec3 ny = texture2D(tex, p.xz).xyz * 2.0 - 1.0;
  vec3 nz = texture2D(tex, p.xy).xyz * 2.0 - 1.0;
  nx.xy *= strength; ny.xy *= strength; nz.xy *= strength;
  vec3 an = abs(wn);
  nx = scRNM(vec3(wn.zy, an.x), nx);
  ny = scRNM(vec3(wn.xz, an.y), ny);
  nz = scRNM(vec3(wn.xy, an.z), nz);
  vec3 sn = sign(wn);
  nx.z *= sn.x; ny.z *= sn.y; nz.z *= sn.z;
  return normalize(nx.zyx * w.x + ny.xzy * w.y + nz.xyz * w.z);
}
`;

const GLSL_GLOBAL_UNIFORMS = /* glsl */`
uniform float uTime;
uniform float uDeltaTime;
uniform vec3  uWind;
uniform vec3  uWindDir;
uniform float uWindGust;
uniform vec3  uPlayerPos;
uniform float uRain;
uniform float uRainAccum;
uniform float uWetness;
uniform float uPuddle;
uniform float uLightning;
uniform vec3  uMoonDir;
uniform float uNightPhase;
`;

const GLSL_VERTEX_PARS = /* glsl */`
#include <common>
${GLSL_GLOBAL_UNIFORMS}
${GLSL_HELPERS}
uniform vec4 uScUv;          // xy scale, zw offset
uniform vec4 uWindParams;    // x flexScale, y flutter, z baseY, w topY
uniform vec2 uPlayerPush;    // x radius, y strength
attribute vec2 aExposure;    // x exposure 0..1, y validity flag
attribute vec2 aWind;        // x flex override, y phase override
varying vec3  vScWorldPos;
varying vec3  vScWorldNormal;
varying vec2  vScUv;
varying float vScExposure;
varying float vScInstVar;
`;

const GLSL_FRAGMENT_PARS = /* glsl */`
#include <common>
${GLSL_GLOBAL_UNIFORMS}
${GLSL_HELPERS}
uniform vec4  uScUv;
uniform float uPorosity;      // how much water darkens the albedo (steel 0.05 .. wood 1.0)
uniform float uWetScale;      // per-material wetness receptivity
uniform vec3  uWaterColor;    // puddle / film colour (linear)
uniform vec2  uBreakup;       // x amount, y scale in metres
uniform vec4  uDetailParams;  // x tiling, y strength, z fadeStart, w fadeEnd
uniform vec4  uCavityParams;  // x contrast, y bias, z channel, w invert
uniform float uAo;            // ambient-occlusion strength from the cavity map
uniform float uInstVar;       // per-instance albedo variation (±)
uniform vec4  uTranslucency;  // x strength, y distortion, z power, w wrap
uniform vec3  uTransColor;    // subsurface tint (linear)
uniform vec4  uSpangle;       // x cells/uv, y roughness variance, z normal tilt, w unused
uniform vec4  uRustParams;    // x noise scale, y cavity bias, z coverage, w edge
uniform vec3  uRustColor;
uniform vec4  uWaterParams;   // x normal strength, y flow speed, z chop, w rain response
varying vec3  vScWorldPos;
varying vec3  vScWorldNormal;
varying vec2  vScUv;
varying float vScExposure;
varying float vScInstVar;

#ifdef SC_DETAIL_NORMAL
uniform sampler2D uDetailNormalMap;
#endif
#ifdef SC_CAVITY
uniform sampler2D uCavityMap;
#endif
#ifdef SC_ALPHA_MAP
uniform sampler2D uAlphaMap;
#endif
#ifdef SC_TRIPLANAR
uniform sampler2D uTriAlbedo;
uniform sampler2D uTriNormal;
uniform sampler2D uTriRough;
uniform vec4 uTriParams;      // x scale (1/m), y sharpness, z normal strength, w rough range
#endif

#ifdef SC_TRANSLUCENT
float scTranslucent(vec3 N, vec3 L, vec3 V) {
  vec3 H = normalize(L + N * uTranslucency.y);
  float I = pow(saturate(dot(V, -H)), max(uTranslucency.z, 0.5));
  return I + uTranslucency.w * saturate(dot(N, -L)) * 0.5;
}
#endif
`;

/* ---------------------------------------------------------------------------- vertex main */

/**
 * Wind. Vertex displacement in WORLD space, converted back into object space with the
 * transpose of the model rotation (valid for rotation * uniform scale, which is all the
 * forest ever uses). Phase comes from the instance origin so no two trees sway together.
 */
const GLSL_WIND = /* glsl */`
#ifdef SC_WIND
{
  vec3 scWindV = uWind;
  float scWindLen = length(scWindV);
  vec3 scWDir = scWindLen > 1e-4 ? scWindV / scWindLen : vec3(1.0, 0.0, 0.0);

  vec3 scOrigin = vec3(0.0);
  #ifdef USE_INSTANCING
    scOrigin = instanceMatrix[3].xyz;
  #endif
  vec3 scOriginW = (modelMatrix * vec4(scOrigin, 1.0)).xyz;

  float scPhase = aWind.y > 0.0001
    ? aWind.y * 6.2831853
    : dot(scOriginW.xz, vec2(0.7139, 1.3121)) + scOriginW.y * 0.271;

  float scH = clamp((position.y - uWindParams.z) / max(uWindParams.w - uWindParams.z, 1e-3), 0.0, 1.0);
  float scFlex = aWind.x > 0.0001 ? aWind.x : scH * scH;
  scFlex *= uWindParams.x;

  float scAmp = scFlex * (scWindLen * 0.30 + uWindGust * 0.55);

  // Three detuned sines: never a clean period, so it never reads as animation.
  float scSway = sin(uTime * 0.83 + scPhase) * 0.62
               + sin(uTime * 1.37 + scPhase * 1.71) * 0.27
               + sin(uTime * 0.29 + scPhase * 0.53) * 0.11;

  vec3 scSide = normalize(cross(scWDir, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
  float scFlut = sin(uTime * 5.9 + scPhase * 3.1 + position.x * 3.7)
               * cos(uTime * 4.3 + scPhase * 2.3 + position.z * 3.1);

  vec3 scDisp = scWDir * (scSway * scAmp)
              + scSide * (scFlut * scAmp * uWindParams.y)
              + vec3(0.0, 1.0, 0.0) * (scFlut * scAmp * uWindParams.y * 0.30);

  // Bending shortens the reach: sink a little so the crown does not stretch.
  scDisp.y -= scAmp * abs(scSway) * 0.22 * scFlex;

  // The monster shoulders through the undergrowth.
  if (uPlayerPush.y > 0.0) {
    vec3 scVW = (modelMatrix * vec4(scOrigin, 1.0)).xyz + vec3(0.0, position.y, 0.0);
    #ifdef USE_INSTANCING
      scVW = (modelMatrix * (instanceMatrix * vec4(position, 1.0))).xyz;
    #else
      scVW = (modelMatrix * vec4(position, 1.0)).xyz;
    #endif
    vec3 scAway = scVW - uPlayerPos;
    scAway.y = 0.0;
    float scD = length(scAway);
    float scPush = (1.0 - smoothstep(0.0, uPlayerPush.x, scD)) * uPlayerPush.y * scFlex;
    scDisp += (scD > 1e-3 ? scAway / scD : vec3(1.0, 0.0, 0.0)) * scPush;
  }

  mat3 scM = mat3(modelMatrix);
  #ifdef USE_INSTANCING
    scM = scM * mat3(instanceMatrix);
  #endif
  float scS2 = max(dot(scM[0], scM[0]), 1e-6);
  transformed += (transpose(scM) * scDisp) / scS2;
}
#endif
`;

const GLSL_VERTEX_WORLD = /* glsl */`
{
  vec4 scWP = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    scWP = instanceMatrix * scWP;
  #endif
  scWP = modelMatrix * scWP;
  vScWorldPos = scWP.xyz;

  float scIV = 0.5;
  #ifdef USE_INSTANCING
    vec3 scIO = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
    scIV = fract(sin(dot(scIO.xz, vec2(12.9898, 78.233)) + scIO.y * 0.113) * 43758.5453);
  #endif
  vScInstVar = scIV;

  vScUv = uv * uScUv.xy + uScUv.zw;
  vScExposure = (aExposure.y > 0.5) ? clamp(aExposure.x, 0.0, 1.0) : 1.0;
}
`;

const GLSL_VERTEX_WORLDNORMAL = /* glsl */`
{
  vec3 scON = objectNormal;
  #ifdef USE_INSTANCING
    scON = mat3(instanceMatrix) * scON;
  #endif
  vScWorldNormal = normalize(mat3(modelMatrix) * scON);
}
`;

/* -------------------------------------------------------------------------- fragment main */

/**
 * The prepare block. Everything downstream reads these. Runs once, first thing in main().
 * This is where the whole wetness model lives (ART_DIRECTION.md §5.1).
 */
const GLSL_PREPARE = /* glsl */`
vec3  scWN = normalize(vScWorldNormal);
float scDist = length(vViewPosition);
float scDetailFade = 1.0 - smoothstep(uDetailParams.z, uDetailParams.w, scDist);

#ifdef SC_TRIPLANAR
vec3 scTriW = scTriBlendWeights(scWN, uTriParams.y);
vec3 scTriP = vScWorldPos * uTriParams.x;
#endif

// --- cavity / height. Water pools in here; it does not coat uniformly.
float scCavity = 0.5;
#ifdef SC_CAVITY
  #ifdef SC_TRIPLANAR
    vec4 scCavTex = scTriSample(uCavityMap, scTriP, scTriW);
  #else
    vec4 scCavTex = texture2D(uCavityMap, vScUv);
  #endif
  scCavity = scChannel4(scCavTex, uCavityParams.z);
  scCavity = saturate((scCavity - 0.5 + uCavityParams.y) * uCavityParams.x + 0.5);
  if (uCavityParams.w > 0.5) scCavity = 1.0 - scCavity;
#endif

// --- sky exposure. Under a tree it is measurably drier (FAILURE MODE #5).
float scOpen = vScExposure * mix(0.30, 1.0, saturate(scWN.y * 0.5 + 0.5));
float scW = saturate(uWetness * uWetScale * scOpen);

// --- puddles: cavity > ~0.6 AND close to level. Wheel ruts, tarp folds, the excavation.
float scPuddle = smoothstep(0.52, 0.86, scCavity)
               * smoothstep(0.900, 0.975, scWN.y)
               * uPuddle * uWetScale * scOpen;
scPuddle = saturate(scPuddle);

// --- large-scale breakup (~30 m). Uniform big surfaces are the #1 hobby-project tell.
float scBreak = scFbm3(vScWorldPos / max(uBreakup.y, 0.001));

#ifdef SC_SPANGLE
  vec3 scSpg = scVoronoi(vScUv * uSpangle.x);
  vec2 scSpgTilt = (scHash22(vec2(scSpg.x * 37.13, scSpg.z * 91.7)) - 0.5) * uSpangle.z;
#endif

#ifdef SC_RUST
  float scRust = scFbm2(vScUv * uRustParams.x) + (1.0 - scCavity) * uRustParams.y;
  scRust = smoothstep(uRustParams.z, uRustParams.z + uRustParams.w, scRust);
#endif
`;

/** Replaces <map_fragment>. Triplanar or uv-scaled, then breakup, then the wetness darken. */
const GLSL_MAP = /* glsl */`
#ifdef SC_TRIPLANAR
  diffuseColor *= scTriSample(uTriAlbedo, scTriP, scTriW);
#elif defined( USE_MAP )
  diffuseColor *= texture2D(map, vScUv);
#endif

#ifdef SC_ALPHA_MAP
  diffuseColor.a *= texture2D(uAlphaMap, vScUv).g;
#endif

// per-instance brightness variation (FAILURE MODE #2)
diffuseColor.rgb *= mix(1.0 - uInstVar, 1.0 + uInstVar, vScInstVar);

// low-frequency breakup
diffuseColor.rgb *= mix(1.0, 0.58 + scBreak * 0.88, uBreakup.x);

#ifdef SC_RUST
  diffuseColor.rgb = mix(diffuseColor.rgb, uRustColor * (0.72 + scBreak * 0.56), scRust);
#endif

// 1. WETNESS — darkened albedo, pooled toward the cavities, scaled by porosity.
//    Non-porous things (steel, tin, glass) barely darken; that is why metal POPS in rain.
diffuseColor.rgb *= mix(1.0, mix(0.62, 0.35, scCavity), scW * uPorosity);

// 3. WETNESS — a real water layer in the low spots.
diffuseColor.rgb = mix(diffuseColor.rgb, uWaterColor, scPuddle);
`;

/** Replaces <roughnessmap_fragment>. */
const GLSL_ROUGHNESS = /* glsl */`
float roughnessFactor = roughness;

#ifdef SC_TRIPLANAR
  roughnessFactor *= mix(1.0 - uTriParams.w, 1.0 + uTriParams.w,
                         scTriSample(uTriRough, scTriP, scTriW).g);
#elif defined( USE_ROUGHNESSMAP )
  roughnessFactor *= texture2D(roughnessMap, vScUv).g;
#endif

#ifdef SC_SPANGLE
  roughnessFactor = clamp(roughnessFactor + (scSpg.x - 0.5) * uSpangle.y, 0.03, 1.0);
  // the crystal boundaries themselves are a touch rougher
  roughnessFactor += (1.0 - smoothstep(0.0, 0.10, scSpg.y)) * 0.10;
#endif

#ifdef SC_RUST
  roughnessFactor = mix(roughnessFactor, 0.86, scRust);
#endif

// Toksvig-flavoured: as the detail normal mips away it becomes ROUGHNESS, not flatness.
// This is the fix for FAILURE MODE #7 — a trunk must not become a smooth cylinder at 20 m.
#ifdef SC_DETAIL_NORMAL
  roughnessFactor = min(1.0, roughnessFactor + uDetailParams.y * 0.26 * (1.0 - scDetailFade));
#endif

// 2. WETNESS — crushed roughness. Aggressively. A wet trunk in moonlight has a 0.10 rim
//    and that rim is most of why the frame reads as expensive.
roughnessFactor = mix(roughnessFactor, 0.08, scW * (1.0 - scCavity * 0.4));
roughnessFactor = mix(roughnessFactor, 0.02, scPuddle);
roughnessFactor = clamp(roughnessFactor, 0.015, 1.0);
`;

/** Appended to <metalnessmap_fragment>. */
const GLSL_METALNESS = /* glsl */`
#ifdef SC_RUST
  // corrosion eats the conductor: metalness 1.0 -> 0.15
  metalnessFactor = mix(metalnessFactor, 0.15, scRust);
#endif
`;

/** Replaces <normal_fragment_maps>. */
const GLSL_NORMAL = /* glsl */`
#if defined( USE_NORMALMAP_TANGENTSPACE )
  vec3 scMapN = texture2D(normalMap, vScUv).xyz * 2.0 - 1.0;
  scMapN.xy *= normalScale;
  #ifdef SC_DETAIL_NORMAL
    // 2. DETAIL NORMAL LAYERING — proper RNM blend at ~20x tiling, faded by distance so it
    //    never aliases. This is what survives a 40 cm camera distance on a beam.
    vec3 scDetN = texture2D(uDetailNormalMap, vScUv * uDetailParams.x).xyz * 2.0 - 1.0;
    scDetN.xy *= uDetailParams.y * scDetailFade;
    scMapN = scRNM(scMapN, scDetN);
  #endif
  #ifdef SC_SPANGLE
    scMapN.xy += scSpgTilt;
    scMapN = normalize(scMapN);
  #endif
  normal = normalize(tbn * scMapN);
#elif defined( USE_NORMALMAP_OBJECTSPACE )
  normal = texture2D(normalMap, vScUv).xyz * 2.0 - 1.0;
  #ifdef FLIP_SIDED
    normal = -normal;
  #endif
  #ifdef DOUBLE_SIDED
    normal = normal * faceDirection;
  #endif
  normal = normalize(normalMatrix * normal);
#endif

#ifdef SC_TRIPLANAR
  // 3. TRIPLANAR — no stretching on cliffs, no seams, no uv authoring on terrain.
  vec3 scTN = scTriNormal(uTriNormal, scTriP, scWN, scTriW, uTriParams.z);
  #ifdef SC_DETAIL_NORMAL
    vec3 scTNd = scTriNormal(uDetailNormalMap, scTriP * uDetailParams.x, scTN,
                             scTriBlendWeights(scTN, uTriParams.y),
                             uDetailParams.y * scDetailFade);
    scTN = normalize(mix(scTN, scTNd, 0.85));
  #endif
  normal = normalize((viewMatrix * vec4(scTN, 0.0)).xyz);
#endif

#ifdef SC_WATER
{
  vec2 scWuv = vScWorldPos.xz;
  vec2 scFlow = uWindDir.xz * uTime * uWaterParams.y;
  vec3 scW1 = texture2D(uDetailNormalMap, scWuv * 0.070 + scFlow * 0.30).xyz * 2.0 - 1.0;
  vec3 scW2 = texture2D(uDetailNormalMap, scWuv * 0.021 - scFlow * 0.12).xyz * 2.0 - 1.0;
  vec3 scW3 = texture2D(uDetailNormalMap, scWuv * 0.940 + vec2(uTime * 0.17, -uTime * 0.13)).xyz * 2.0 - 1.0;
  float scChop = uWaterParams.z * (0.55 + uWindGust * 0.8);
  float nx = (scW1.x * 0.62 + scW2.x) * scChop + scW3.x * uRain * uWaterParams.w;
  float ny = (scW1.y * 0.62 + scW2.y) * scChop + scW3.y * uRain * uWaterParams.w;
  vec3 scWaterN = normalize(vec3(nx * uWaterParams.x, 1.0, ny * uWaterParams.x));
  normal = normalize((viewMatrix * vec4(scWaterN, 0.0)).xyz);
}
#endif

// A puddle has no relief. Flatten toward the geometric normal where water has pooled.
normal = normalize(mix(normal, nonPerturbedNormal, scPuddle * 0.92));
`;

/** Appended to <lights_physical_fragment>: the grazing-angle sheen half of the wetness model. */
const GLSL_WET_SPEC = /* glsl */`
{
  // Specular antialiasing (Toksvig / normal-variance). three only derives geometryRoughness
  // from the *geometric* normal, so a strong detail normal over a low roughness sparkles into
  // white noise. Feed the perturbed normal's screen-space variance back into roughness.
  #if defined( SC_DETAIL_NORMAL ) || defined( SC_TRIPLANAR )
    vec3 scNd = max(abs(dFdx(normal)), abs(dFdy(normal)));
    float scNVar = max(max(scNd.x, scNd.y), scNd.z);
    material.roughness = min(1.0, material.roughness + scNVar * (0.45 + uDetailParams.y * 0.55));
  #endif

  // 4. WETNESS — F0 0.02 -> 0.06 where it is properly wet, F90 pushed to 1.0 so the
  //    grazing angles blow out. Metals are excluded; a water film on steel is a puddle,
  //    not a change of conductor.
  float scWetSpec = scW * (1.0 - metalnessFactor);
  float scF0 = mix(0.04, 0.065, smoothstep(0.45, 1.0, scW));
  material.specularColor = mix(material.specularColor, vec3(scF0), scWetSpec);
  material.specularColor = mix(material.specularColor, vec3(0.02), scPuddle);
  material.specularF90 = mix(material.specularF90, 1.0, max(scWetSpec, scPuddle));
  material.specularColorBlended = mix(material.specularColor, diffuseColor.rgb, metalnessFactor);
  material.roughness = max(material.roughness, 0.0);
  #ifdef USE_SHEEN
    // Estevez-Kulla sheen, tightened and brightened by water. This is what makes a
    // backlit fern read as a silhouette of highlights rather than a green shape.
    material.sheenColor *= mix(1.0, 2.4, scW);
    material.sheenRoughness = clamp(mix(material.sheenRoughness, 0.22, scW), 0.07, 1.0);
  #endif
}
`;

/** Appended to <lights_fragment_end>: cheap wrap/backscatter translucency. */
const GLSL_TRANSLUCENCY = /* glsl */`
#ifdef SC_TRANSLUCENT
{
  vec3 scTr = vec3(0.0);
  IncidentLight scIL;
  #if ( NUM_DIR_LIGHTS > 0 )
    for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
      getDirectionalLightInfo(directionalLights[i], scIL);
      scTr += scIL.color * scTranslucent(geometryNormal, scIL.direction, geometryViewDir);
    }
  #endif
  #if ( NUM_POINT_LIGHTS > 0 )
    for (int i = 0; i < NUM_POINT_LIGHTS; i++) {
      getPointLightInfo(pointLights[i], geometryPosition, scIL);
      scTr += scIL.color * scTranslucent(geometryNormal, scIL.direction, geometryViewDir);
    }
  #endif
  #if ( NUM_SPOT_LIGHTS > 0 )
    for (int i = 0; i < NUM_SPOT_LIGHTS; i++) {
      getSpotLightInfo(spotLights[i], geometryPosition, scIL);
      scTr += scIL.color * scTranslucent(geometryNormal, scIL.direction, geometryViewDir);
    }
  #endif
  totalEmissiveRadiance += scTr * uTransColor * diffuseColor.rgb * uTranslucency.x;
}
#endif
`;

/** Replaces <aomap_fragment>: cavity-driven AO on indirect only (ART §7 pass 1 policy). */
const GLSL_AO = /* glsl */`
#ifdef SC_CAVITY
{
  float scAO = mix(1.0, scCavity, uAo);
  reflectedLight.indirectDiffuse *= scAO;
  #if defined( USE_CLEARCOAT )
    clearcoatSpecularIndirect *= scAO;
  #endif
  #if defined( USE_SHEEN )
    sheenSpecularIndirect *= scAO;
  #endif
}
#endif
`;

/**
 * Replaces <fog_fragment> with exponential HEIGHT fog (ART_DIRECTION.md §4.1, FAILURE MODE
 * #1). Only active when Sky/VolumetricFog has actually set `scene.fog`, so ownership is
 * respected: they decide colour and density, we upgrade the falloff to height-based and add
 * the aerial-perspective term plus moon inscatter.
 *
 * NB three composites fog AFTER tone mapping, so `fogColor` is uploaded in display space.
 * uFogFar / uFogLit are therefore Vector3s in sRGB, to match.
 */
const GLSL_FOG = /* glsl */`
#ifdef USE_FOG
{
  vec3 scRay = vScWorldPos - cameraPosition;
  float scRayLen = max(length(scRay), 1e-4);
  float scD0 = uFogParams.x;
  #ifdef FOG_EXP2
    scD0 = max(fogDensity, 0.0004);
  #endif
  float scY0 = uFogParams.y;
  float scH = max(uFogParams.z, 0.25);
  float scDens0 = scD0 * exp(-(cameraPosition.y - scY0) / scH);
  float scOptical;
  if (abs(scRay.y) < 1e-3) {
    scOptical = scDens0 * scRayLen;
  } else {
    scOptical = scDens0 * scH * (1.0 - exp(-scRay.y / scH)) * (scRayLen / scRay.y);
  }
  float fogFactor = 1.0 - exp(-max(scOptical, 0.0) * uFogParams.w);
  fogFactor = clamp(fogFactor, 0.0, 1.0);

  // aerial perspective: near fog is the cold slate, the distance wall is lighter
  vec3 scFogCol = mix(fogColor, uFogFar, smoothstep(12.0, 70.0, scRayLen));
  // Henyey-Greenstein-ish inscatter toward the moon: looking at the moon, the air glows
  float scMu = dot(scRay / scRayLen, uMoonDir);
  float scG = uFogParams2.x;
  float scHG = (1.0 - scG * scG) / pow(1.0 + scG * scG - 2.0 * scG * scMu, 1.5);
  scFogCol = mix(scFogCol, uFogLit, saturate(scHG * 0.16) * uFogParams2.y);
  scFogCol += uFogLit * uLightning * 0.55;

  gl_FragColor.rgb = mix(gl_FragColor.rgb, scFogCol, fogFactor);
}
#endif
`;

const GLSL_FOG_PARS = /* glsl */`
uniform vec4 uFogParams;   // x D0, y y0, z H, w scatterScale
uniform vec2 uFogParams2;  // x HG g, y inscatter strength
uniform vec3 uFogFar;      // sRGB display-space
uniform vec3 uFogLit;      // sRGB display-space
`;

/* ======================================================================================
 * Fallback procedural texture bakery.
 *
 * Textures.js is the real bakery. This exists so Materials NEVER produces a flat untextured
 * surface, even when Textures is missing, still being authored, or fails to init. Kept
 * deliberately small: one shared set per material family, tier-scaled resolution.
 * ==================================================================================== */

const TEX_FAMILY = {
  bark: { kind: 'bark', rough: [0.55, 1.0], tint: 0.36 },
  wood: { kind: 'wood', rough: [0.42, 0.95], tint: 0.30 },
  ground: { kind: 'ground', rough: [0.35, 0.95], tint: 0.42 },
  stone: { kind: 'stone', rough: [0.28, 0.85], tint: 0.34 },
  metal: { kind: 'metal', rough: [0.18, 0.62], tint: 0.18 },
  fabric: { kind: 'fabric', rough: [0.60, 1.0], tint: 0.22 },
  organic: { kind: 'organic', rough: [0.25, 0.75], tint: 0.30 },
  flesh: { kind: 'flesh', rough: [0.22, 0.60], tint: 0.16 },
};

function makeCanvas(size) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    try { return new OffscreenCanvas(size, size); } catch { /* fall through */ }
  }
  return null;
}

/*
 * Fast, SEAMLESSLY TILEABLE value noise, local to the bakery.
 *
 * Rand.js's fbm2/valueNoise2 are the canonical world-space noise and must stay that way,
 * but they are hash-heavy and do not wrap — baking eight families through them cost 4.2 s
 * and left a visible seam on every tile. These wrap the integer lattice at the octave
 * period, so a 1 m plank texture repeats without a hairline.
 */
function fhash(xi, yi, seed) {
  let h = Math.imul(xi | 0, 0x27d4eb2d) ^ Math.imul(yi | 0, 0x165667b1) ^ (seed | 0);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) * 2.3283064365386963e-10;
}

/** Value noise on a lattice that wraps every `period` cells. Coordinates pre-scaled. */
function tnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const a = fhash(x0, y0, seed), b = fhash(x1, y0, seed);
  const c = fhash(x0, y1, seed), d = fhash(x1, y1, seed);
  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return top + (bot - top) * v;
}

/** Tileable fbm over u,v in [0,1). `freq` is the base repeat count and must be an integer. */
function tfbm(u, v, freq, oct, seed) {
  let amp = 0.5, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    const p = Math.max(1, Math.round(freq * f));
    sum += amp * tnoise(u * p, v * p, p, seed + i * 131);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Tileable ridged multifractal — plate edges, fissures, erosion channels. */
function tridged(u, v, freq, oct, seed) {
  let amp = 0.5, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    const p = Math.max(1, Math.round(freq * f));
    const n = 1 - Math.abs(tnoise(u * p, v * p, p, seed + i * 977) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

const TAU = Math.PI * 2;

/** Height field for a material family. Seamless in both axes. */
function bakeHeight(size, kind, seed) {
  const h = new Float32Array(size * size);
  const s = seed | 0;
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    const v = y * inv;
    for (let x = 0; x < size; x++) {
      const u = x * inv;
      let n;
      switch (kind) {
        case 'bark': {
          // vertical fissures: warp the domain, then ridge it for plate edges
          const w = tfbm(u, v, 4, 2, s) * 0.5 - 0.25;
          n = tridged(u + w * 0.10, v * 0.25, 24, 3, s) * 0.66
            + tfbm(u, v, 48, 2, s + 7) * 0.34;
          break;
        }
        case 'wood': {
          // grain rings across the board plus saw-kerf micro-grooves along the cut
          const g = tfbm(u, v, 3, 3, s) * 0.5;
          const rings = Math.abs(Math.sin((v * 8 + g * 1.6) * Math.PI));
          const kerf = Math.sin(v * TAU * Math.round(size / 6)) * 0.5 + 0.5;
          n = rings * 0.50 + tfbm(u, v, 32, 2, s + 3) * 0.28 + kerf * 0.22;
          break;
        }
        case 'ground': {
          n = tfbm(u, v, 6, 4, s) * 0.60
            + tridged(u, v, 20, 2, s + 11) * 0.24
            + tfbm(u, v, 48, 1, s + 19) * 0.16;
          break;
        }
        case 'stone': {
          // three-tone speckle: feldspar / quartz / biotite grain at ~2 mm
          n = tfbm(u, v, 4, 3, s) * 0.40
            + tnoise(u * 40, v * 40, 40, s + 5) * 0.32
            + tnoise(u * 96, v * 96, 96, s + 13) * 0.28;
          break;
        }
        case 'metal': {
          n = 0.55 + tfbm(u, v, 3, 2, s) * 0.30
            + tnoise(u * 72, v * 72, 72, s + 23) * 0.15;
          break;
        }
        case 'fabric': {
          // woven duck: warp and weft at ~1.2 mm
          const cells = Math.max(8, Math.round(size / 5));
          const warp = Math.sin(u * TAU * cells) * 0.5 + 0.5;
          const weft = Math.sin(v * TAU * cells) * 0.5 + 0.5;
          n = (warp * 0.5 + weft * 0.5) * 0.58 + tfbm(u, v, 10, 3, s) * 0.42;
          break;
        }
        case 'organic': {
          const vein = Math.abs(Math.sin((u * 10 + tfbm(u, v, 3, 2, s) * 1.8) * Math.PI));
          n = vein * 0.40 + tfbm(u, v, 24, 3, s + 29) * 0.60;
          break;
        }
        default: { // flesh — pores, no structure
          n = tfbm(u, v, 16, 3, s) * 0.62
            + tnoise(u * 56, v * 56, 56, s + 31) * 0.38;
        }
      }
      h[y * size + x] = n < 0 ? 0 : (n > 1 ? 1 : n);
    }
  }
  return h;
}

/** Sobel-ish height -> tangent-space normal. Wraps, so the normal map tiles too. */
function heightToNormalTexture(h, size, strength) {
  const canvas = makeCanvas(size);
  if (!canvas) return null;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const img = g.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    const rowC = y * size;
    const rowU = (y === 0 ? size - 1 : y - 1) * size;
    const rowD = (y === size - 1 ? 0 : y + 1) * size;
    for (let x = 0; x < size; x++) {
      const xl = x === 0 ? size - 1 : x - 1;
      const xr = x === size - 1 ? 0 : x + 1;
      const nx = (h[rowC + xl] - h[rowC + xr]) * strength;
      const ny = (h[rowU + x] - h[rowD + x]) * strength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const i = (rowC + x) * 4;
      d[i] = (nx * inv * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      d[i + 2] = (inv * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

/** Grayscale remap of a scalar field. Gamma goes through a 256-entry LUT — pow is slow. */
function fieldToTexture(h, size, lo, hi, gamma) {
  const canvas = makeCanvas(size);
  if (!canvas) return null;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const img = g.createImageData(size, size);
  const d = img.data;
  const lut = new Float32Array(257);
  for (let k = 0; k <= 256; k++) lut[k] = (lo + (hi - lo) * Math.pow(k / 256, gamma)) * 255;
  const n = size * size;
  for (let i = 0; i < n; i++) {
    const c = lut[(h[i] * 256) | 0];
    const j = i * 4;
    d[j] = c; d[j + 1] = c; d[j + 2] = c; d[j + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

/** 2x2 box downsample — roughness and cavity are low-frequency by nature. */
function halveField(h, size) {
  const hs = size >> 1;
  const out = new Float32Array(hs * hs);
  for (let y = 0; y < hs; y++) {
    const r0 = (y * 2) * size, r1 = (y * 2 + 1) * size;
    for (let x = 0; x < hs; x++) {
      const c0 = x * 2, c1 = x * 2 + 1;
      out[y * hs + x] = (h[r0 + c0] + h[r0 + c1] + h[r1 + c0] + h[r1 + c1]) * 0.25;
    }
  }
  return out;
}

/**
 * A grayscale albedo-variation map — the material colour tints it, so one baked map serves a
 * whole family. Two scales of variation: the height field (10 cm) and a coarse blotch field
 * (metres), because a single grain size is the tell of a procedural texture.
 */
function albedoTexture(h, size, tintAmount, seed) {
  const canvas = makeCanvas(size);
  if (!canvas) return null;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const img = g.createImageData(size, size);
  const d = img.data;
  const s = (seed | 0) + 977;

  // Blotch at 1/8 resolution, bilinearly resampled — visually identical, 64x cheaper.
  const bs = Math.max(4, size >> 3);
  const blotch = new Float32Array(bs * bs);
  for (let by = 0; by < bs; by++) {
    for (let bx = 0; bx < bs; bx++) {
      blotch[by * bs + bx] = 0.84 + tfbm(bx / bs, by / bs, 3, 3, s) * 0.32;
    }
  }
  const bsample = (u, v) => {
    const fx = u * bs, fy = v * bs;
    const x0 = Math.floor(fx) % bs, y0 = Math.floor(fy) % bs;
    const x1 = (x0 + 1) % bs, y1 = (y0 + 1) % bs;
    const tx = fx - Math.floor(fx), ty = fy - Math.floor(fy);
    const a = blotch[y0 * bs + x0], b = blotch[y0 * bs + x1];
    const c = blotch[y1 * bs + x0], e = blotch[y1 * bs + x1];
    return (a + (b - a) * tx) + ((c + (e - c) * tx) - (a + (b - a) * tx)) * ty;
  };

  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const base = 1 - tintAmount * 0.5 + h[i] * tintAmount;
      let v = base * bsample(x * inv, y * inv);
      v = v < 0 ? 0 : (v > 1 ? 1 : v);
      // a whisper of hue drift so it is never a pure grey multiply
      const j = i * 4;
      d[j] = v * 255 * 1.02;
      d[j + 1] = v * 255;
      d[j + 2] = v * 255 * 0.96;
      d[j + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

/** High-frequency detail normal, layered over every material at ~20x tiling. */
function detailNormalCanvas(size) {
  const h = new Float32Array(size * size);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    const v = y * inv;
    for (let x = 0; x < size; x++) {
      const u = x * inv;
      h[y * size + x] =
        tfbm(u, v, 12, 3, 5501) * 0.52 +
        tnoise(u * 48, v * 48, 48, 5507) * 0.30 +
        tnoise(u * 112, v * 112, 112, 5519) * 0.18;
    }
  }
  return heightToNormalTexture(h, size, 2.2);
}

/** Needle-cluster / frond alpha cards, drawn with Canvas2D (fast, and the shape is the point). */
function foliageCardCanvas(size, kind, seed) {
  const canvas = makeCanvas(size);
  if (!canvas) return null;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const rand = new Rand(seed);
  g.clearRect(0, 0, size, size);
  g.lineCap = 'butt';
  g.lineJoin = 'miter';

  if (kind === 'needle') {
    // several sprigs; each sprig is a stem with needles at ~35 degrees
    const sprigs = 7;
    for (let s = 0; s < sprigs; s++) {
      const x0 = size * (0.08 + 0.84 * (s + rand.range(-0.25, 0.25)) / (sprigs - 1));
      const y0 = size * rand.range(0.94, 1.02);
      const len = size * rand.range(0.55, 0.94);
      const lean = rand.range(-0.30, 0.30);
      const x1 = x0 + len * lean;
      const y1 = y0 - len;
      const shade = 150 + Math.floor(rand.range(-40, 70));
      g.strokeStyle = `rgba(${shade},${shade},${shade},1)`;
      g.lineWidth = Math.max(1, size * 0.006);
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      const needles = 26;
      for (let n = 0; n < needles; n++) {
        const t = n / needles;
        const px = x0 + (x1 - x0) * t;
        const py = y0 + (y1 - y0) * t;
        const nl = size * (0.16 * (1 - t * 0.72)) * rand.range(0.7, 1.25);
        const sh = 120 + Math.floor(rand.range(-45, 90));
        g.strokeStyle = `rgba(${sh},${sh},${sh},1)`;
        g.lineWidth = Math.max(1, size * rand.range(0.0035, 0.006));
        for (const dir of [-1, 1]) {
          const a = -Math.PI / 2 + dir * rand.range(0.55, 0.95);
          g.beginPath();
          g.moveTo(px, py);
          g.lineTo(px + Math.cos(a) * nl, py + Math.sin(a) * nl);
          g.stroke();
        }
      }
    }
  } else {
    // fern frond: a rachis with tapering pinnae
    const x0 = size * 0.5, y0 = size * 1.0;
    const x1 = size * rand.range(0.42, 0.58), y1 = size * 0.04;
    g.strokeStyle = 'rgba(170,170,170,1)';
    g.lineWidth = Math.max(1, size * 0.012);
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    const pinnae = 22;
    for (let n = 0; n < pinnae; n++) {
      const t = n / pinnae;
      const px = x0 + (x1 - x0) * t;
      const py = y0 + (y1 - y0) * t;
      const pl = size * 0.40 * Math.sin((1 - t) * Math.PI * 0.85) * rand.range(0.85, 1.15);
      const sh = 110 + Math.floor(t * 90 + rand.range(-25, 25));
      g.strokeStyle = `rgba(${sh},${sh},${sh},1)`;
      g.lineWidth = Math.max(1, size * 0.016 * (1 - t * 0.5));
      for (const dir of [-1, 1]) {
        const a = -Math.PI / 2 + dir * (0.85 - t * 0.30);
        g.beginPath();
        g.moveTo(px, py);
        g.quadraticCurveTo(
          px + Math.cos(a) * pl * 0.6, py + Math.sin(a) * pl * 0.5,
          px + Math.cos(a) * pl, py + Math.sin(a) * pl * 0.85,
        );
        g.stroke();
      }
    }
  }
  return canvas;
}

/* ======================================================================================
 * Material specifications — ART_DIRECTION.md §5.2 is the source of every number here.
 * ==================================================================================== */

/**
 * spec fields:
 *   color        sRGB hex (ART §5.2 "Albedo")
 *   roughness    dry value (ART §5.2)
 *   metalness    (ART §5.2)
 *   normalScale  (ART §5.2 "Normal x")
 *   porosity     wetness albedo-darkening receptivity (ART §5.1 item 1)
 *   wetScale     how eagerly the surface takes water at all
 *   family       fallback texture family
 *   uv           texture repeats per uv unit
 *   detail       [tiling, strength]  detail-normal layer
 *   breakup      [amount, metres]    low-frequency albedo breakup
 *   ao           cavity->AO strength
 *   triplanar    [scale 1/m, sharpness, normalStrength, roughRange] or null
 *   wind         [flexScale, flutter, baseY, topY] or null
 *   translucent  [strength, distortion, power, wrap] or null
 *   transColor   subsurface tint hex
 *   sheen        [intensity, roughness, colourHex] or null   (needs MeshPhysicalMaterial)
 *   physical     force MeshPhysicalMaterial
 *   side / alphaTest / transparent / opacity / emissiveIntensity
 *   spangle / rust / water   special shader features
 */
const SPECS = {
  'bark-pine': {
    color: PAL.barkDry, roughness: 0.88, metalness: 0.0, normalScale: 1.6,
    porosity: 0.95, wetScale: 1.0, family: 'bark', uv: [1.0, 2.2],
    detail: [18, 0.85], breakup: [0.34, 26], ao: 0.85,
    cavity: { contrast: 1.5, bias: 0.02 },
    wind: [0.16, 0.0, 0.0, 22.0],
    sheen: [0.22, 0.55, PAL.moonRim],
    physical: true,
  },
  'bark-birch': {
    color: PAL.barkBirch, roughness: 0.62, metalness: 0.0, normalScale: 0.9,
    porosity: 0.80, wetScale: 0.9, family: 'bark', uv: [1.0, 1.6],
    detail: [22, 0.55], breakup: [0.26, 30], ao: 0.70,
    cavity: { contrast: 1.3, bias: 0.0 },
    wind: [0.16, 0.0, 0.0, 22.0],
    translucent: [0.55, 0.30, 3.0, 0.25], transColor: 0xc8c2ac,
    sheen: [0.18, 0.60, PAL.moonRim],
    physical: true,
  },
  'foliage-pine': {
    color: PAL.foliageWet, roughness: 0.42, metalness: 0.0, normalScale: 0.7,
    porosity: 0.9, wetScale: 1.0, family: 'organic', uv: [1, 1],
    detail: [14, 0.45], breakup: [0.30, 22], ao: 0.6,
    cavity: { contrast: 1.2, bias: 0.0 },
    card: 'needle', alphaTest: 0.42, side: THREE.DoubleSide,
    wind: [1.0, 0.85, 0.0, 3.2],
    playerPush: [0.0, 0.0],
    translucent: [1.15, 0.36, 3.2, 0.45], transColor: 0x2c4a34,
    sheen: [0.55, 0.32, PAL.moonRim],
    physical: true, depthVariant: true,
  },
  'foliage-fern': {
    color: PAL.fern, roughness: 0.35, metalness: 0.0, normalScale: 0.8,
    porosity: 0.9, wetScale: 1.0, family: 'organic', uv: [1, 1],
    detail: [12, 0.40], breakup: [0.32, 18], ao: 0.55,
    cavity: { contrast: 1.2, bias: 0.0 },
    card: 'fern', alphaTest: 0.38, side: THREE.DoubleSide,
    wind: [1.25, 1.15, 0.0, 1.1],
    playerPush: [0.85, 0.30],
    translucent: [1.55, 0.40, 2.6, 0.55], transColor: 0x35563c,
    // "a specular sheen so strong the fern reads as a silhouette of highlights"
    sheen: [0.95, 0.26, PAL.moonRim],
    physical: true, depthVariant: true,
  },
  'ground-needles': {
    color: PAL.foliageDead, roughness: 0.62, metalness: 0.0, normalScale: 1.2,
    porosity: 1.0, wetScale: 0.92, family: 'ground', uv: [1, 1],
    detail: [14, 0.50], detailFade: [3.0, 18.0], breakup: [0.45, 34], ao: 0.95,
    cavity: { contrast: 1.6, bias: 0.04 },
    triplanar: [0.42, 5.0, 0.85, 0.34],
  },
  'ground-mud': {
    color: PAL.mudDeep, roughness: 0.16, metalness: 0.0, normalScale: 1.8,
    porosity: 1.0, wetScale: 1.25, family: 'ground', uv: [1, 1],
    detail: [16, 0.55], detailFade: [3.0, 16.0], breakup: [0.40, 28], ao: 1.0,
    cavity: { contrast: 1.9, bias: 0.06 },
    triplanar: [0.55, 6.0, 1.05, 0.40],
  },
  'ground-moss': {
    color: PAL.moss, roughness: 0.72, metalness: 0.0, normalScale: 0.5,
    porosity: 0.85, wetScale: 1.05, family: 'organic', uv: [1, 1],
    detail: [18, 0.45], detailFade: [3.0, 16.0], breakup: [0.42, 24], ao: 0.9,
    cavity: { contrast: 1.4, bias: 0.02 },
    triplanar: [0.75, 4.0, 0.70, 0.30],
    translucent: [0.75, 0.42, 2.4, 0.50], transColor: 0x2c4030,
    sheen: [0.30, 0.55, PAL.moonRim], physical: true,
  },
  granite: {
    color: PAL.midStone, roughness: 0.55, metalness: 0.0, normalScale: 1.1,
    porosity: 0.55, wetScale: 1.0, family: 'stone', uv: [1, 1],
    // the sparkle survives at 20 m because the detail normal becomes roughness, not mush
    detail: [22, 0.60], detailFade: [4.0, 22.0], breakup: [0.30, 32], ao: 0.85,
    cavity: { contrast: 1.7, bias: 0.0 },
    triplanar: [0.34, 6.0, 0.90, 0.42],
  },
  'sawn-lumber': {
    // THE brightest large surface in the game. Do not weather it. ART §5.3.
    color: PAL.lumber, roughness: 0.68, metalness: 0.0, normalScale: 1.0,
    porosity: 1.0, wetScale: 0.85, family: 'wood', uv: [0.5, 2.0],
    detail: [24, 0.60], breakup: [0.18, 12], ao: 0.75,
    cavity: { contrast: 1.4, bias: 0.0 },
    anisotropy: [0.32, 0.0],   // saw-kerf grooves run along the cut
    physical: true,
  },
  'weathered-wood': {
    color: PAL.weathered, roughness: 0.82, metalness: 0.0, normalScale: 1.4,
    porosity: 1.0, wetScale: 1.0, family: 'wood', uv: [0.5, 2.0],
    detail: [22, 0.80], breakup: [0.30, 16], ao: 0.9,
    cavity: { contrast: 1.7, bias: 0.05 },
    anisotropy: [0.20, 0.0],
    physical: true,
  },
  'galvanized-steel': {
    color: PAL.steelGalv, roughness: 0.34, metalness: 1.0, normalScale: 0.6,
    porosity: 0.05, wetScale: 0.9, family: 'metal', uv: [2, 2],
    detail: [28, 0.35], breakup: [0.10, 8], ao: 0.55,
    cavity: { contrast: 1.2, bias: 0.0 },
    // Real galvanizing crystallises. Nobody models the spangle. We do.
    spangle: [9.0, 0.26, 0.14],
  },
  'rusted-steel': {
    color: PAL.steelGalv, roughness: 0.42, metalness: 1.0, normalScale: 1.5,
    porosity: 0.30, wetScale: 1.0, family: 'metal', uv: [2, 2],
    detail: [26, 0.75], breakup: [0.16, 6], ao: 0.85,
    cavity: { contrast: 1.5, bias: 0.06 },
    rust: [7.0, 0.55, 0.42, 0.36], rustColor: PAL.rust,
  },
  canvas: {
    color: PAL.canvas, roughness: 0.86, metalness: 0.0, normalScale: 1.1,
    porosity: 0.90, wetScale: 1.0, family: 'fabric', uv: [3, 3],
    detail: [20, 0.65], breakup: [0.20, 10], ao: 0.7,
    cavity: { contrast: 1.3, bias: 0.0 },
    side: THREE.DoubleSide,
    // "a lit tent must glow from inside like a paper lantern"
    translucent: [1.35, 0.28, 2.2, 0.70], transColor: 0x8a8468,
    sheen: [0.45, 0.60, 0xb8b49a], physical: true,
  },
  'corrugated-tin': {
    color: PAL.tin, roughness: 0.44, metalness: 1.0, normalScale: 0.8,
    porosity: 0.05, wetScale: 1.1, family: 'metal', uv: [1.5, 1.5],
    detail: [24, 0.42], breakup: [0.14, 9], ao: 0.6,
    cavity: { contrast: 1.4, bias: 0.10 },
    // rain runs in the valleys: heavy puddle response in the cavities
  },
  concrete: {
    color: PAL.concrete, roughness: 0.88, metalness: 0.0, normalScale: 1.2,
    porosity: 0.80, wetScale: 1.0, family: 'stone', uv: [1, 1],
    detail: [18, 0.55], detailFade: [4.0, 20.0], breakup: [0.26, 20], ao: 0.9,
    cavity: { contrast: 1.6, bias: 0.04 },
    triplanar: [0.55, 5.0, 0.80, 0.34],
  },
  'glass-dirty': {
    color: 0x141b1f, roughness: 0.18, metalness: 0.0, normalScale: 0.35,
    porosity: 0.02, wetScale: 1.2, family: 'stone', uv: [1.5, 1.5],
    detail: [18, 0.18], breakup: [0.35, 4], ao: 0.35,
    cavity: { contrast: 2.1, bias: 0.0 },
    transparent: true, opacity: 0.34, side: THREE.DoubleSide,
    physical: true, ior: 1.52, specularIntensity: 1.0,
  },
  'water-lake': {
    color: PAL.waterBody, roughness: 0.02, metalness: 0.0, normalScale: 1.0,
    porosity: 0.0, wetScale: 0.0, family: 'stone', uv: [1, 1],
    detail: [1, 0], breakup: [0.0, 30], ao: 0.0,
    water: [0.85, 0.020, 0.65, 1.30],
    physical: true, ior: 1.333, specularIntensity: 1.0,
    noCavity: true, noMaps: true,
  },
  'skin-wet': {
    color: PAL.skinWet, roughness: 0.36, metalness: 0.0, normalScale: 0.4,
    porosity: 0.35, wetScale: 0.85, family: 'flesh', uv: [1, 1],
    detail: [24, 0.30], breakup: [0.12, 3], ao: 0.6,
    cavity: { contrast: 1.3, bias: 0.0 },
    translucent: [0.95, 0.24, 3.4, 0.60], transColor: 0x8a3a2c,
    sheen: [0.28, 0.42, 0xc0a9a0], physical: true,
    specularIntensity: 0.72,
  },
  blood: {
    color: PAL.bloodFresh, roughness: 0.10, metalness: 0.0, normalScale: 0.9,
    porosity: 0.10, wetScale: 0.45, family: 'flesh', uv: [2, 2],
    detail: [20, 0.28], breakup: [0.14, 2], ao: 0.5,
    cavity: { contrast: 1.8, bias: 0.0 },
    // subsurface red bleed: a thin film lit from behind goes blood.hot
    translucent: [1.25, 0.20, 4.0, 0.35], transColor: PAL.bloodHot,
    physical: true, ior: 1.36, specularIntensity: 1.0,
  },
  'blood-dry': {
    color: PAL.bloodDry, roughness: 0.74, metalness: 0.0, normalScale: 1.2,
    porosity: 0.75, wetScale: 0.7, family: 'ground', uv: [3, 3],
    detail: [22, 0.65], breakup: [0.22, 3], ao: 0.85,
    cavity: { contrast: 1.9, bias: 0.05 },
  },
  'tarp-plastic': {
    color: PAL.tarp, roughness: 0.28, metalness: 0.0, normalScale: 1.3,
    porosity: 0.06, wetScale: 1.35, family: 'fabric', uv: [1.5, 1.5],
    detail: [16, 0.55], breakup: [0.16, 8], ao: 0.8,
    cavity: { contrast: 2.0, bias: 0.12 },
    side: THREE.DoubleSide,
    sheen: [0.40, 0.34, 0x93a8b4], physical: true,
    translucent: [0.45, 0.30, 3.0, 0.35], transColor: 0x3d5b68,
  },
  rope: {
    color: PAL.rope, roughness: 0.90, metalness: 0.0, normalScale: 1.2,
    porosity: 0.95, wetScale: 1.0, family: 'fabric', uv: [1, 8],
    detail: [26, 0.85], breakup: [0.18, 4], ao: 0.9,
    cavity: { contrast: 1.6, bias: 0.02 },
    anisotropy: [0.45, 1.5708],   // fibres run along the lay
    sheen: [0.35, 0.55, 0x9c9276], physical: true,
  },
};

/** Convenience aliases so other agents can guess the name and still get a material. */
const ALIASES = {
  bark: 'bark-pine',
  'bark-fir': 'bark-pine',
  'bark-douglas-fir': 'bark-pine',
  birch: 'bark-birch',
  needles: 'foliage-pine',
  pine: 'foliage-pine',
  fern: 'foliage-fern',
  undergrowth: 'foliage-fern',
  duff: 'ground-needles',
  'ground-duff': 'ground-needles',
  litter: 'ground-needles',
  mud: 'ground-mud',
  earth: 'ground-mud',
  moss: 'ground-moss',
  rock: 'granite',
  stone: 'granite',
  lumber: 'sawn-lumber',
  wood: 'sawn-lumber',
  plank: 'weathered-wood',
  weathered: 'weathered-wood',
  steel: 'galvanized-steel',
  bracket: 'galvanized-steel',
  galv: 'galvanized-steel',
  nail: 'rusted-steel',
  rust: 'rusted-steel',
  rusted: 'rusted-steel',
  tent: 'canvas',
  tin: 'corrugated-tin',
  roof: 'corrugated-tin',
  glass: 'glass-dirty',
  window: 'glass-dirty',
  water: 'water-lake',
  lake: 'water-lake',
  skin: 'skin-wet',
  camper: 'skin-wet',
  'blood-fresh': 'blood',
  gore: 'blood',
  tarp: 'tarp-plastic',
};

/* ====================================================================================== */

let _missingTokenWarned = false;
function patchSrc(src, token, replacement, where) {
  if (src.indexOf(token) === -1) {
    if (!_missingTokenWarned) {
      _missingTokenWarned = true;
      Log.warn(`Materials: shader token '${token}' not found in ${where} — three.js internals changed.`);
    }
    return src;
  }
  return src.replace(token, replacement);
}

export class Materials {
  /** @param {any} ctx */
  constructor(ctx) {
    this.ctx = ctx ?? {};
    this.bus = this.ctx.bus ?? null;

    /** @type {Map<string, THREE.Material>} */
    this._materials = new Map();
    /** @type {Map<string, any>} */
    this._records = new Map();
    /** @type {Map<string, THREE.MeshDepthMaterial>} */
    this._depthMaterials = new Map();
    /** @type {Set<THREE.Texture>} */
    this._ownedTextures = new Set();
    /** @type {Map<string, any>} */
    this._fallbackSets = new Map();

    this._detailNormal = null;
    this._fallbackMaterial = null;
    this._disposed = false;

    // Deterministic private stream — forking does NOT advance ctx.rand, so other systems
    // keep their sequence (ARCHITECTURE.md §6).
    try {
      this._rand = this.ctx.rand?.fork ? this.ctx.rand.fork('materials') : new Rand(0x5145A11);
    } catch { this._rand = new Rand(0x5145A11); }

    // Wetness / weather integrators.
    this._wet = WET_FLOOR;
    this._rainAccum = 0.08;
    this._puddle = 0;
    this._gust = 0;
    this._gustSeed = hashStr('gust') * 1000;
    this._windAngle = 2.1;
    this._standaloneLightning = 0;
    this._standaloneLightningNext = 9;
    this._time = 0;

    /** Set false if Sky/VolumetricFog wants to own the analytic fog term itself. */
    this.heightFog = true;

    // Fog uniforms are per-material-library (shared across every patched program).
    this._fogUniforms = {
      uFogParams: new THREE.Uniform(new THREE.Vector4(0.014, -1.0, 4.2, 1.0)),
      uFogParams2: new THREE.Uniform(new THREE.Vector2(0.55, 1.0)),
      uFogFar: new THREE.Uniform(srgbVec3(PAL.fogFar)),
      uFogLit: new THREE.Uniform(srgbVec3(PAL.fogLit)),
    };

    this._onWeather = (p) => this._applyWeatherPayload(p);
    this._onNight = () => { this._rainAccum = 0.08; this._puddle = 0; };
  }

  // ------------------------------------------------------------------ static / accessors

  static get globalUniforms() { return GLOBAL_UNIFORMS; }
  get globalUniforms() { return GLOBAL_UNIFORMS; }

  // ------------------------------------------------------------------ lifecycle

  async init() {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    const settings = this.ctx.settings ?? null;
    const tier = (l, m, h, u) => (settings?.tier ? settings.tier(l, m, h, u) : u);
    this._tierIndex = settings?.tierIndex ?? 3;

    this._maxAniso = 1;
    try {
      this._maxAniso = this.ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;
    } catch { this._maxAniso = 1; }
    this._aniso = Math.min(this._maxAniso, tier(1, 2, 8, 16));

    this._textures = this.ctx.systems?.get?.('Textures') ?? null;
    if (!this._textures || typeof this._textures.get !== 'function') {
      Log.warn('Materials: Textures system unavailable — falling back to the local procedural bakery. Surfaces will be plausible but not art-directed.');
      this._textures = null;
    }

    // Fallback maps stay modest on purpose: the detail-normal layer at ~20x tiling is what
    // carries close-range detail, so the base maps only ever need to carry macro variation.
    this._fallbackSize = tier(96, 128, 160, 192);
    this._cardSize = tier(128, 256, 384, 512);

    // Detail normal is mandatory (effect #2), so we never depend on Textures for it.
    this._detailNormal = await this._resolveDetailNormal();

    // Build every material once (ARCHITECTURE.md §12: no new Material after init).
    for (const [name, spec] of Object.entries(SPECS)) {
      try {
        const rec = await this._buildMaterial(name, spec);
        this._materials.set(name, rec.material);
        this._records.set(name, rec);
      } catch (e) {
        Log.error(`Materials: failed to build '${name}'`, e);
      }
    }

    // A neutral stand-in so get() never returns undefined and never returns a purple.
    this._fallbackMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PAL.midSlate),
      roughness: 0.7,
      metalness: 0.0,
      name: 'sc-fallback',
    });

    if (this.bus) {
      this.bus.on('weather:change', this._onWeather);
      this.bus.on('night:begin', this._onNight);
    }

    // Seed from whatever already exists.
    this._readSystems(0);

    const ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    Log.debug(`Materials: ${this._materials.size} materials, ${this._ownedTextures.size} owned textures, ${ms.toFixed(1)}ms`);
  }

  /**
   * @param {string} name
   * @returns {THREE.Material}
   */
  get(name) {
    const key = ALIASES[name] ?? name;
    const m = this._materials.get(key);
    if (m) return m;
    Log.once(`mat:${name}`, `Materials.get('${name}') — unknown material, using the fallback.`);
    return this._fallbackMaterial ?? (this._fallbackMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PAL.midSlate), roughness: 0.7,
    }));
  }

  has(name) { return this._materials.has(ALIASES[name] ?? name); }

  list() { return [...this._materials.keys()]; }

  /**
   * A MeshDepthMaterial carrying the SAME wind displacement + alpha cutout, so wind-blown
   * foliage casts a wind-blown shadow. Assign to `mesh.customDepthMaterial`.
   * @param {string} name
   * @returns {THREE.MeshDepthMaterial|null}
   */
  getDepthMaterial(name) {
    const key = ALIASES[name] ?? name;
    if (this._depthMaterials.has(key)) return this._depthMaterials.get(key);
    const rec = this._records.get(key);
    if (!rec) return null;
    let dm = null;
    try {
      dm = new THREE.MeshDepthMaterial({
        depthPacking: THREE.RGBADepthPacking,
        map: rec.material.map ?? null,
        alphaTest: rec.material.alphaTest ?? 0,
        side: rec.material.side ?? THREE.FrontSide,
        name: `sc-depth-${key}`,
      });
      this._patchDepth(dm, rec);
    } catch (e) {
      Log.warn(`Materials.getDepthMaterial('${name}') failed`, e);
      return null;
    }
    this._depthMaterials.set(key, dm);
    return dm;
  }

  /**
   * Opt an externally-authored MeshStandard/PhysicalMaterial into the global system.
   * Call this BEFORE the material is first rendered.
   * @param {THREE.Material} material
   * @param {object} [options] see SPECS field documentation
   */
  patchMaterial(material, options = {}) {
    if (!material || !material.isMaterial) return material;
    const spec = {
      porosity: 1.0, wetScale: 1.0, uv: [1, 1], detail: [18, 0.6],
      breakup: [0.25, 26], ao: 0.7, cavity: { contrast: 1.4, bias: 0 },
      ...options,
    };
    const rec = {
      name: material.name || 'external', spec, material,
      uniforms: this._makeLocalUniforms(spec),
      defines: [],
      textures: {
        cavity: options.cavityMap ?? null,
        detail: options.detailNormal ?? this._detailNormal,
      },
    };
    this._applyPatch(rec);
    return material;
  }

  /** Postprocessing may enable this if it renders into a multisampled target. */
  setAlphaToCoverage(enabled) {
    for (const [, m] of this._materials) {
      if (m.alphaTest > 0) { m.alphaToCoverage = !!enabled; m.needsUpdate = true; }
    }
  }

  /** Let Sky / VolumetricFog drive the analytic height-fog constants (ART §4.1). */
  setFogParams({ D0, y0, H, scatterScale, g, inscatter, farColor, litColor } = {}) {
    const p = this._fogUniforms.uFogParams.value;
    if (Number.isFinite(D0)) p.x = D0;
    if (Number.isFinite(y0)) p.y = y0;
    if (Number.isFinite(H)) p.z = H;
    if (Number.isFinite(scatterScale)) p.w = scatterScale;
    const p2 = this._fogUniforms.uFogParams2.value;
    if (Number.isFinite(g)) p2.x = Math.min(0.95, Math.max(-0.95, g));
    if (Number.isFinite(inscatter)) p2.y = inscatter;
    if (farColor !== undefined) this._fogUniforms.uFogFar.value.copy(srgbVec3(farColor));
    if (litColor !== undefined) this._fogUniforms.uFogLit.value.copy(srgbVec3(litColor));
  }

  // ------------------------------------------------------------------ per-frame

  update(dt, elapsed) {
    if (this._disposed) return;
    const u = GLOBAL_UNIFORMS;
    const d = Math.min(Math.max(dt || 0, 0), 0.1);
    this._time = Number.isFinite(elapsed) ? elapsed : this._time + d;

    u.uTime.value = this._time;
    u.uDeltaTime.value = d;

    this._readSystems(d);

    // ---- wetness integration. Wetting is fast, drying is slow (ART §5.1).
    const rain = u.uRain.value;
    const target = Math.min(1, WET_FLOOR + rain * (1 - WET_FLOOR) * 1.35);
    const tau = target > this._wet ? 7.0 : 68.0;
    this._wet += (target - this._wet) * (1 - Math.exp(-d / tau));
    u.uWetness.value = this._wet;

    // ---- puddles accumulate over the night and drain slowly.
    this._rainAccum = Math.min(1.2, this._rainAccum + rain * d * 0.030 - d * 0.0022);
    if (this._rainAccum < 0) this._rainAccum = 0;
    u.uRainAccum.value = Math.min(1, this._rainAccum);
    this._puddle = smoothstep(0.15, 0.85, this._rainAccum);
    u.uPuddle.value = this._puddle;

    // ---- gust envelope. Pink-ish: three detuned components, never periodic.
    const t = this._time + this._gustSeed;
    const g = 0.5 + 0.5 * (
      Math.sin(t * 0.37) * 0.45 +
      Math.sin(t * 0.91 + 1.7) * 0.32 +
      Math.sin(t * 2.13 + 4.1) * 0.23
    );
    const windStrength = u.uWind.value.length();
    this._gust = Math.max(0, Math.pow(g, 2.4)) * (0.35 + windStrength * 0.9);
    u.uWindGust.value = this._gust;
  }

  resize(_w, _h) { /* nothing resolution-dependent here */ }

  // ------------------------------------------------------------------ system reads

  _readSystems(dt) {
    const u = GLOBAL_UNIFORMS;
    const sys = this.ctx.systems;

    // ---- Player position (falls back to the camera so the mist wake still works solo).
    let ppos = null;
    try {
      const player = sys?.get?.('Player');
      ppos = player?.position ?? player?.object?.position ?? null;
    } catch { ppos = null; }
    if (!ppos && this.ctx.camera) ppos = this.ctx.camera.position;
    if (ppos && Number.isFinite(ppos.x)) u.uPlayerPos.value.set(ppos.x, ppos.y, ppos.z);

    // ---- Weather.
    let w = null;
    try { w = sys?.get?.('Weather') ?? null; } catch { w = null; }

    if (w && Number.isFinite(w.rain)) {
      u.uRain.value = clamp01(w.rain);
    } else if (!this._weatherEventSeen) {
      // Standalone: Night 1 drizzle with a slow swell so the world is never static.
      u.uRain.value = clamp01(0.15 + 0.10 * Math.sin(this._time * 0.043));
    }

    // wind may be a float (per the weather:change payload), a Vector3, or {x,z}/{dir,strength}
    const raw = w?.wind;
    if (raw && typeof raw === 'object' && Number.isFinite(raw.x) && Number.isFinite(raw.z)) {
      u.uWind.value.set(raw.x, raw.y ?? 0, raw.z);
    } else if (raw && typeof raw === 'object' && raw.direction && Number.isFinite(raw.strength)) {
      _v3a.copy(raw.direction).normalize().multiplyScalar(raw.strength);
      u.uWind.value.copy(_v3a);
    } else {
      const strength = Number.isFinite(raw) ? raw
        : (Number.isFinite(w?.windStrength) ? w.windStrength : (this._weatherWind ?? 0.28));
      // A slowly veering direction; wind that never changes heading reads as a fan.
      this._windAngle += dt * 0.035 * (0.6 + strength);
      const a = this._windAngle + Math.sin(this._time * 0.11) * 0.22;
      u.uWind.value.set(Math.sin(a) * strength * 1.4, 0, Math.cos(a) * strength * 1.4);
    }
    const wl = u.uWind.value.length();
    if (wl > 1e-5) u.uWindDir.value.copy(u.uWind.value).multiplyScalar(1 / wl);

    // ---- Lightning.
    let flash = null;
    try {
      const L = w?.lightning;
      flash = Number.isFinite(L) ? L : (Number.isFinite(L?.value) ? L.value : null);
    } catch { flash = null; }
    if (flash !== null) {
      u.uLightning.value = clamp01(flash);
    } else {
      // Standalone: an occasional distant sheet so the sky is alive with no Weather system.
      this._standaloneLightningNext -= dt;
      if (this._standaloneLightningNext <= 0) {
        this._standaloneLightning = 1;
        this._standaloneLightningNext = this._rand.range(22, 55);
      }
      this._standaloneLightning = Math.max(0, this._standaloneLightning - dt * 3.4);
      // 3-flash envelope, per ART §3.2
      const e = this._standaloneLightning;
      u.uLightning.value = e * (0.55 + 0.45 * Math.abs(Math.sin(e * 34.0)));
    }

    // ---- Night phase.
    const ton = this.ctx.state?.timeOfNight;
    u.uNightPhase.value = Number.isFinite(ton) ? clamp01(ton) : 0;

    // ---- Moon direction. Prefer Sky; otherwise derive from ART §3.2 (az 118, el 26 -> 19).
    let moon = null;
    try {
      const sky = sys?.get?.('Sky');
      moon = sky?.moonDirection ?? sky?.moonDir ?? sky?.moon?.position ?? null;
    } catch { moon = null; }
    if (moon && Number.isFinite(moon.x)) {
      _v3b.set(moon.x, moon.y, moon.z);
      if (_v3b.lengthSq() > 1e-8) u.uMoonDir.value.copy(_v3b.normalize());
    } else {
      const az = 118 * Math.PI / 180;
      const el = (26 - 7 * u.uNightPhase.value) * Math.PI / 180;
      const ce = Math.cos(el);
      u.uMoonDir.value.set(Math.sin(az) * ce, Math.sin(el), -Math.cos(az) * ce).normalize();
    }
  }

  _applyWeatherPayload(p) {
    if (!p) return;
    this._weatherEventSeen = true;
    if (Number.isFinite(p.rain)) GLOBAL_UNIFORMS.uRain.value = clamp01(p.rain);
    if (Number.isFinite(p.wind)) this._weatherWind = p.wind;
    if (Number.isFinite(p.fog)) {
      // A foggy night is a brighter, flatter, *deeper* night (ART §3.2 / §4.1).
      const f = clamp01(p.fog);
      const par = this._fogUniforms.uFogParams.value;
      par.x = 0.014 + f * 0.040;           // D0  clear 0.014 -> storm 0.048
      par.z = 4.2 + f * 3.8;               // H   4.2 -> 8.0
      this._fogUniforms.uFogParams2.value.x = 0.55 + f * 0.16;
    }
  }

  // ------------------------------------------------------------------ material construction

  _makeLocalUniforms(spec) {
    const cav = spec.cavity ?? { contrast: 1.4, bias: 0 };
    return {
      uScUv: new THREE.Uniform(new THREE.Vector4(spec.uv?.[0] ?? 1, spec.uv?.[1] ?? 1, 0, 0)),
      uPorosity: new THREE.Uniform(spec.porosity ?? 1),
      uWetScale: new THREE.Uniform(spec.wetScale ?? 1),
      uWaterColor: new THREE.Uniform(new THREE.Color(PAL.waterBody)),
      uBreakup: new THREE.Uniform(new THREE.Vector2(spec.breakup?.[0] ?? 0.25, spec.breakup?.[1] ?? 26)),
      uDetailParams: new THREE.Uniform(new THREE.Vector4(
        spec.detail?.[0] ?? 18, spec.detail?.[1] ?? 0.6,
        spec.detailFade?.[0] ?? 6.0, spec.detailFade?.[1] ?? 26.0,
      )),
      uCavityParams: new THREE.Uniform(new THREE.Vector4(
        cav.contrast ?? 1.4, cav.bias ?? 0, cav.channel ?? 0, cav.invert ? 1 : 0,
      )),
      uAo: new THREE.Uniform(spec.ao ?? 0.7),
      uInstVar: new THREE.Uniform(spec.instVar ?? 0.09),
      uTranslucency: new THREE.Uniform(new THREE.Vector4(
        spec.translucent?.[0] ?? 0, spec.translucent?.[1] ?? 0.3,
        spec.translucent?.[2] ?? 3.0, spec.translucent?.[3] ?? 0.4,
      )),
      uTransColor: new THREE.Uniform(new THREE.Color(spec.transColor ?? 0xffffff)),
      uSpangle: new THREE.Uniform(new THREE.Vector4(
        spec.spangle?.[0] ?? 8, spec.spangle?.[1] ?? 0.25, spec.spangle?.[2] ?? 0.12, 0,
      )),
      uRustParams: new THREE.Uniform(new THREE.Vector4(
        spec.rust?.[0] ?? 7, spec.rust?.[1] ?? 0.5, spec.rust?.[2] ?? 0.45, spec.rust?.[3] ?? 0.35,
      )),
      uRustColor: new THREE.Uniform(new THREE.Color(spec.rustColor ?? PAL.rust)),
      uWaterParams: new THREE.Uniform(new THREE.Vector4(
        spec.water?.[0] ?? 0.8, spec.water?.[1] ?? 0.02, spec.water?.[2] ?? 0.6, spec.water?.[3] ?? 1.2,
      )),
      uWindParams: new THREE.Uniform(new THREE.Vector4(
        spec.wind?.[0] ?? 0, spec.wind?.[1] ?? 0, spec.wind?.[2] ?? 0, spec.wind?.[3] ?? 1,
      )),
      uPlayerPush: new THREE.Uniform(new THREE.Vector2(
        spec.playerPush?.[0] ?? 0, spec.playerPush?.[1] ?? 0,
      )),
    };
  }

  async _buildMaterial(name, spec) {
    const tierIndex = this._tierIndex ?? 3;
    const set = await this._resolveTextures(name, spec);

    const usePhysical = !!spec.physical || !!spec.sheen || !!spec.anisotropy;
    const Ctor = usePhysical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;

    const params = {
      name: `sc-${name}`,
      color: new THREE.Color(spec.color),
      roughness: spec.roughness ?? 0.7,
      metalness: spec.metalness ?? 0,
      side: spec.side ?? THREE.FrontSide,
      transparent: !!spec.transparent,
      opacity: spec.opacity ?? 1,
      dithering: true,          // helps the 8-bit dark range before post even runs
    };
    if (spec.alphaTest) params.alphaTest = spec.alphaTest;

    const material = new Ctor(params);

    // Textures: never assigned for triplanar surfaces (they need no uvs at all).
    if (!spec.triplanar && !spec.noMaps) {
      if (set.map) material.map = set.map;
      if (set.normal) {
        material.normalMap = set.normal;
        material.normalScale = new THREE.Vector2(spec.normalScale ?? 1, spec.normalScale ?? 1);
      }
      if (set.rough) material.roughnessMap = set.rough;
    }

    if (usePhysical) {
      if (spec.sheen && tierIndex >= 1) {
        material.sheen = spec.sheen[0];
        material.sheenRoughness = spec.sheen[1];
        material.sheenColor = new THREE.Color(spec.sheen[2]);
      }
      if (spec.anisotropy && tierIndex >= 2) {
        material.anisotropy = spec.anisotropy[0];
        material.anisotropyRotation = spec.anisotropy[1];
      }
      if (Number.isFinite(spec.ior)) material.ior = spec.ior;
      if (Number.isFinite(spec.specularIntensity)) material.specularIntensity = spec.specularIntensity;
    }

    const rec = {
      name, spec, material,
      uniforms: this._makeLocalUniforms(spec),
      textures: {
        cavity: spec.noCavity ? null : (set.cavity ?? null),
        detail: this._detailNormal,
        alpha: set.alpha ?? null,
        triAlbedo: set.map ?? null,
        triNormal: set.normal ?? null,
        triRough: set.rough ?? null,
      },
    };

    this._applyPatch(rec);
    return rec;
  }

  /**
   * The single place shader patching happens. Builds the define list, wires uniforms, and
   * installs onBeforeCompile + customProgramCacheKey.
   */
  _applyPatch(rec) {
    const { material, spec, uniforms, textures } = rec;
    const tierIndex = this._tierIndex ?? 3;
    const defines = [];

    // SC_WATER samples the detail normal for its flow map, so it always needs the sampler.
    const hasDetail = !!textures.detail && ((spec.detail?.[1] ?? 0) > 0.001 || !!spec.water);
    const hasCavity = !!textures.cavity;
    const triplanar = spec.triplanar && textures.triAlbedo && textures.triNormal;

    if (hasDetail) defines.push('SC_DETAIL_NORMAL');
    if (hasCavity) defines.push('SC_CAVITY');
    if (textures.alpha) defines.push('SC_ALPHA_MAP');
    if (triplanar) defines.push('SC_TRIPLANAR');
    if (spec.wind && (spec.wind[0] ?? 0) > 0) defines.push('SC_WIND');
    if (spec.translucent && (spec.translucent[0] ?? 0) > 0 && tierIndex >= 1) defines.push('SC_TRANSLUCENT');
    if (spec.spangle && tierIndex >= 1) defines.push('SC_SPANGLE');
    if (spec.rust) defines.push('SC_RUST');
    if (spec.water) defines.push('SC_WATER');

    rec.defines = defines;
    const defineBlock = defines.map((d) => `#define ${d}`).join('\n');
    const cacheKey = `sc:${rec.name}:${defines.join(',')}:${this.heightFog ? 'hf' : ''}`;

    const local = { ...uniforms };
    if (hasDetail) local.uDetailNormalMap = new THREE.Uniform(textures.detail);
    if (hasCavity) local.uCavityMap = new THREE.Uniform(textures.cavity);
    if (textures.alpha) local.uAlphaMap = new THREE.Uniform(textures.alpha);
    if (triplanar) {
      local.uTriAlbedo = new THREE.Uniform(textures.triAlbedo);
      local.uTriNormal = new THREE.Uniform(textures.triNormal);
      local.uTriRough = new THREE.Uniform(textures.triRough ?? textures.triNormal);
      // NB the triplanar normal strength is authored directly — it is NOT multiplied by
      // spec.normalScale, which would double-count and turn wet ground into specular noise.
      local.uTriParams = new THREE.Uniform(new THREE.Vector4(
        spec.triplanar[0], spec.triplanar[1], spec.triplanar[2], spec.triplanar[3],
      ));
    }

    const heightFog = this.heightFog;
    const fogUniforms = this._fogUniforms;

    material.onBeforeCompile = (shader) => {
      // Shared globals + this material's private set. Uniform objects are shared by
      // reference, so one write per frame updates every program.
      for (const k in GLOBAL_UNIFORMS) shader.uniforms[k] = GLOBAL_UNIFORMS[k];
      for (const k in local) shader.uniforms[k] = local[k];
      if (heightFog) for (const k in fogUniforms) shader.uniforms[k] = fogUniforms[k];

      // ------------------------------------------------------------------ vertex
      let v = shader.vertexShader;
      v = patchSrc(v, '#include <common>', `${defineBlock}\n${GLSL_VERTEX_PARS}`, 'vertex');
      v = patchSrc(v, '#include <begin_vertex>', `#include <begin_vertex>\n${GLSL_WIND}`, 'vertex');
      v = patchSrc(v, '#include <defaultnormal_vertex>',
        `#include <defaultnormal_vertex>\n${GLSL_VERTEX_WORLDNORMAL}`, 'vertex');
      v = patchSrc(v, '#include <project_vertex>',
        `${GLSL_VERTEX_WORLD}\n#include <project_vertex>`, 'vertex');
      shader.vertexShader = v;

      // ------------------------------------------------------------------ fragment
      let f = shader.fragmentShader;
      f = patchSrc(f, '#include <common>',
        `${defineBlock}\n${GLSL_FRAGMENT_PARS}\n${heightFog ? GLSL_FOG_PARS : ''}`, 'fragment');
      f = patchSrc(f, '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>\n${GLSL_PREPARE}`, 'fragment');
      f = patchSrc(f, '#include <map_fragment>', GLSL_MAP, 'fragment');
      f = patchSrc(f, '#include <roughnessmap_fragment>', GLSL_ROUGHNESS, 'fragment');
      f = patchSrc(f, '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>\n${GLSL_METALNESS}`, 'fragment');
      f = patchSrc(f, '#include <normal_fragment_maps>', GLSL_NORMAL, 'fragment');
      f = patchSrc(f, '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>\n${GLSL_WET_SPEC}`, 'fragment');
      f = patchSrc(f, '#include <lights_fragment_end>',
        `#include <lights_fragment_end>\n${GLSL_TRANSLUCENCY}`, 'fragment');
      f = patchSrc(f, '#include <aomap_fragment>', GLSL_AO, 'fragment');
      if (heightFog) f = patchSrc(f, '#include <fog_fragment>', GLSL_FOG, 'fragment');
      shader.fragmentShader = f;

      rec.shader = shader;
    };

    material.customProgramCacheKey = () => cacheKey;
    material.needsUpdate = true;
  }

  /** Wind-matched depth variant so shadows sway with the geometry that casts them. */
  _patchDepth(depthMaterial, rec) {
    const { spec, uniforms, textures } = rec;
    const defines = [];
    if (spec.wind && (spec.wind[0] ?? 0) > 0) defines.push('SC_WIND');
    if (textures.alpha) defines.push('SC_ALPHA_MAP');
    const defineBlock = defines.map((d) => `#define ${d}`).join('\n');
    const cacheKey = `sc-depth:${rec.name}:${defines.join(',')}`;

    const local = {
      uScUv: uniforms.uScUv,
      uWindParams: uniforms.uWindParams,
      uPlayerPush: uniforms.uPlayerPush,
    };
    if (textures.alpha) local.uAlphaMap = new THREE.Uniform(textures.alpha);

    depthMaterial.onBeforeCompile = (shader) => {
      for (const k in GLOBAL_UNIFORMS) shader.uniforms[k] = GLOBAL_UNIFORMS[k];
      for (const k in local) shader.uniforms[k] = local[k];

      let v = shader.vertexShader;
      v = patchSrc(v, '#include <common>', `${defineBlock}
#include <common>
${GLSL_GLOBAL_UNIFORMS}
uniform vec4 uScUv;
uniform vec4 uWindParams;
uniform vec2 uPlayerPush;
attribute vec2 aWind;
varying vec2 vScUv;
`, 'depth-vertex');
      v = patchSrc(v, '#include <begin_vertex>', `#include <begin_vertex>\n${GLSL_WIND}`, 'depth-vertex');
      v = patchSrc(v, '#include <project_vertex>',
        'vScUv = uv * uScUv.xy + uScUv.zw;\n#include <project_vertex>', 'depth-vertex');
      shader.vertexShader = v;

      let f = shader.fragmentShader;
      f = patchSrc(f, '#include <common>', `${defineBlock}
#include <common>
varying vec2 vScUv;
#ifdef SC_ALPHA_MAP
uniform sampler2D uAlphaMap;
#endif
`, 'depth-fragment');
      f = patchSrc(f, '#include <map_fragment>', `
#ifdef USE_MAP
  diffuseColor *= texture2D(map, vScUv);
#endif
#ifdef SC_ALPHA_MAP
  diffuseColor.a *= texture2D(uAlphaMap, vScUv).g;
#endif
`, 'depth-fragment');
      shader.fragmentShader = f;
    };

    depthMaterial.customProgramCacheKey = () => cacheKey;
    depthMaterial.needsUpdate = true;
  }

  // ------------------------------------------------------------------ texture resolution

  /** Ask Textures first; fall back to the local bakery. Never throws. */
  async _resolveTextures(name, spec) {
    const out = { map: null, normal: null, rough: null, cavity: null, alpha: null };

    if (this._textures) {
      const size = this.ctx.settings?.tier
        ? this.ctx.settings.tier(256, 512, 1024, 2048)
        : 1024;
      const got = await this._callTextures(name, { size, seed: hashStr(name) * 1e9 | 0, family: spec.family });
      if (got) {
        out.map = pickTex(got, ['map', 'albedo', 'diffuse', 'color', 'baseColor']);
        out.normal = pickTex(got, ['normalMap', 'normal', 'nrm']);
        out.rough = pickTex(got, ['roughnessMap', 'roughness', 'rough', 'orm', 'arm']);
        out.cavity = pickTex(got, ['aoMap', 'ao', 'cavityMap', 'cavity', 'heightMap', 'height', 'displacementMap']);
        out.alpha = pickTex(got, ['alphaMap', 'alpha', 'opacityMap']);
      }
    }

    // ---- fill the gaps locally
    const fam = spec.family ?? 'stone';
    if (!out.map || !out.normal || !out.rough || !out.cavity) {
      const fb = this._getFallbackSet(fam);
      if (fb) {
        out.map = out.map ?? fb.map;
        out.normal = out.normal ?? fb.normal;
        out.rough = out.rough ?? fb.rough;
        out.cavity = out.cavity ?? fb.cavity;
      }
    }

    // ---- foliage cards: the alpha shape IS the material, so we always want one.
    if (spec.card && !out.alpha) {
      const card = this._getCard(spec.card);
      if (card) {
        // The card carries its own albedo variation and alpha; it replaces the family map.
        out.map = card.map;
        out.alpha = card.alpha;
        out.normal = out.normal ?? card.normal;
      }
    }

    for (const k in out) if (out[k]) this._configureTexture(out[k]);
    return out;
  }

  async _callTextures(key, opts) {
    if (!this._textures) return null;
    try {
      const r = this._textures.get(key, opts);
      const res = (r && typeof r.then === 'function') ? await r : r;
      if (!res) return null;
      if (res.isTexture) return { map: res };
      return res;
    } catch (e) {
      Log.once('tex:get', `Materials: Textures.get('${key}') threw — using the local bakery.`, e);
      return null;
    }
  }

  _configureTexture(tex) {
    if (!tex || !tex.isTexture) return;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    if (!tex.anisotropy || tex.anisotropy < this._aniso) tex.anisotropy = this._aniso;
    if (tex.generateMipmaps !== false) {
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
    }
    tex.needsUpdate = true;
  }

  _makeTexture(canvas, colorSpace) {
    if (!canvas) return null;
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = colorSpace ?? THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = this._aniso ?? 1;
    t.needsUpdate = true;
    this._ownedTextures.add(t);
    return t;
  }

  _getFallbackSet(family) {
    if (this._fallbackSets.has(family)) return this._fallbackSets.get(family);
    const cfg = TEX_FAMILY[family] ?? TEX_FAMILY.stone;
    const size = this._fallbackSize ?? 256;
    let set = null;
    try {
      const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
      const seed = (hashStr(family) * 1000) | 0;
      const h = bakeHeight(size, cfg.kind, seed);
      const half = halveField(h, size);
      const hs = size >> 1;
      set = {
        map: this._makeTexture(albedoTexture(h, size, cfg.tint, seed), THREE.SRGBColorSpace),
        normal: this._makeTexture(heightToNormalTexture(h, size, 3.0), THREE.NoColorSpace),
        rough: this._makeTexture(fieldToTexture(half, hs, cfg.rough[0], cfg.rough[1], 0.85), THREE.NoColorSpace),
        cavity: this._makeTexture(fieldToTexture(half, hs, 0.08, 1.0, 1.25), THREE.NoColorSpace),
      };
      Log.debug(`Materials: baked '${family}' ${size}px in ${((typeof performance !== 'undefined' ? performance.now() : 0) - t0).toFixed(1)}ms`);
    } catch (e) {
      Log.warn(`Materials: fallback bakery failed for '${family}'`, e);
      set = null;
    }
    this._fallbackSets.set(family, set);
    return set;
  }

  _getCard(kind) {
    const key = `card:${kind}`;
    if (this._fallbackSets.has(key)) return this._fallbackSets.get(key);
    let card = null;
    try {
      const size = this._cardSize ?? 512;
      const canvas = foliageCardCanvas(size, kind, (hashStr(kind) * 1e6) | 0);
      const tex = this._makeTexture(canvas, THREE.SRGBColorSpace);
      // Alpha lives in the albedo's own alpha channel — one fetch, not two.
      card = { map: tex, alpha: null, normal: null };
    } catch (e) {
      Log.warn(`Materials: foliage card '${kind}' failed`, e);
    }
    this._fallbackSets.set(key, card);
    return card;
  }

  async _resolveDetailNormal() {
    for (const key of ['detail-normal', 'detailNormal', 'detail', 'micro-normal']) {
      const got = await this._callTextures(key, { size: 512, kind: 'detail-normal' });
      const t = got && pickTex(got, ['normalMap', 'normal', 'map']);
      if (t) { this._configureTexture(t); return t; }
    }
    try {
      const size = this.ctx.settings?.tier ? this.ctx.settings.tier(128, 192, 256, 256) : 256;
      return this._makeTexture(detailNormalCanvas(size), THREE.NoColorSpace);
    } catch (e) {
      Log.warn('Materials: could not bake the detail normal — surfaces will lack micro relief.', e);
      return null;
    }
  }

  // ------------------------------------------------------------------ teardown

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    if (this.bus) {
      this.bus.off?.('weather:change', this._onWeather);
      this.bus.off?.('night:begin', this._onNight);
    }

    for (const [, m] of this._materials) {
      m.onBeforeCompile = () => {};
      m.customProgramCacheKey = () => '';
      try { m.dispose(); } catch { /* already gone */ }
    }
    this._materials.clear();
    this._records.clear();

    for (const [, m] of this._depthMaterials) {
      try { m.dispose(); } catch { /* already gone */ }
    }
    this._depthMaterials.clear();

    // Only textures WE baked. Textures.js owns the ones it handed us.
    for (const t of this._ownedTextures) {
      try { t.dispose(); } catch { /* already gone */ }
    }
    this._ownedTextures.clear();
    this._fallbackSets.clear();
    this._detailNormal = null;

    try { this._fallbackMaterial?.dispose(); } catch { /* already gone */ }
    this._fallbackMaterial = null;

    // globalUniforms deliberately survive: other modules hold references to them.
  }
}

/* ====================================================================================== */

function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

function smoothstep(a, b, x) {
  const t = clamp01((x - a) / Math.max(b - a, 1e-6));
  return t * t * (3 - 2 * t);
}

/** sRGB display-space components as a Vector3 — matches how three uploads `fogColor`. */
function srgbVec3(hex) {
  const c = new THREE.Color(hex);
  c.getRGB(_rgb, THREE.SRGBColorSpace);
  return new THREE.Vector3(_rgb.r, _rgb.g, _rgb.b);
}

/** Pull the first present THREE.Texture out of a result object under any of these keys. */
function pickTex(obj, keys) {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (v && v.isTexture) return v;
  }
  return null;
}

/** The art-direction palette, exported so other modules never hand-type a hex. */
Materials.PALETTE = PAL;

export { GLOBAL_UNIFORMS as globalUniforms, PAL as PALETTE };
export default Materials;
