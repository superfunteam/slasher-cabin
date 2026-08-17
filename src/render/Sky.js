/**
 * Sky.js — the night sky. OWNER: Render agent.
 *
 * Everything in this file exists to make the first 200 ms of a frame read as a photograph
 * taken at f/1.4 under a waxing gibbous moon (ART_DIRECTION.md §1, §2, §3.2).
 *
 * What it draws
 * -------------
 *   1. A BackSide dome (r = 900) carrying an analytic moonlit Rayleigh/Mie sky, the moon disc
 *      with a real phase terminator + limb darkening + fbm maria, the Milky Way, a drifting
 *      backlit cloud layer, and (night >= 5) aurora curtains.
 *   2. A Points star field with a magnitude-correct brightness distribution, blackbody colour
 *      temperatures, round soft sprites, per-star scintillation, and extinction from airmass,
 *      moon glare and cloud cover.
 *
 * What it MANAGES (other systems read these)
 * ------------------------------------------
 *   this.moonDirection   THREE.Vector3   unit vector TO the moon. Materials.globalUniforms
 *                                        .uMoonDir is derived from it; VolumetricFog uses it
 *                                        for the god-ray direction; Postprocessing uses
 *                                        this.moonPosition for the screen-space flare origin.
 *   this.moonLight       DirectionalLight the key. #7d95c4, ~0.06 physical, texel-snapped shadow.
 *   this.moonOcclusion   number 0..1     how much cloud is over the moon RIGHT NOW. A cloud
 *                                        crossing the moon is a gameplay darkness event.
 *   this.hemiLight       HemisphereLight sky bounce.
 *   this.lightningLight  DirectionalLight the flash key (intensity 0 unless flashing).
 *   this.moonPosition    THREE.Vector3   world point of the moon on the dome, refreshed every
 *                                        frame — project it for a lens flare / god-ray origin.
 *   this.moonPhase       number 0..1     illuminated fraction (waxing gibbous -> near full).
 *   this.moonVisibility  number 0..1     getter: (1 - occlusion), zero when the moon is down.
 *   this.lightningLevel  number 0..1     the current flash envelope value.
 *   this.cloudCover      number 0..1     current coverage; setCloudCover(v, immediate) to force.
 *   this.flash(i)        method          fire a ~120 ms 3-stage lightning spike that lights the
 *                                        whole scene and writes Materials uLightning.
 *
 * What it OWNS that is not obviously Sky's
 * ----------------------------------------
 *   `scene.fog`. Materials.js only compiles its analytic height-fog upgrade when someone has
 *   set scene.fog (USE_FOG), so without this there is no aerial perspective anywhere in the
 *   game. Sky claims it only if it is still null at init(), so VolumetricFog can take it
 *   instead simply by setting it first; dispose() hands it back.
 *
 *   VERIFIED AT RUNTIME (2026-08-17): Sky owns it. `scene.fog.name === 'sc-sky-fog'`,
 *   `sky._ownsFog === true`, and VolumetricFog — which is present and real, `render()` is a
 *   function — never assigns scene.fog at all. It integrates its froxel volume into its own
 *   target and Postprocessing composites that separately. The two are NOT fighting: they are
 *   two independent terms, this one analytic and per-material, that one volumetric and
 *   screen-space. The only thing they share is `this.moonDirection`.
 *
 *   `scene.fog.color` is LINEAR RADIANCE, and `scene.fog.density` IS ART §5.1's D0. See
 *   `radiance()` and FOG_D0_CLEAR below — both were wrong, and the colour one by 6.7x.
 *
 * Coupling to Postprocessing
 * --------------------------
 *   Postprocessing owns the output transform (renderer.toneMapping = NoToneMapping, AgX once
 *   in the composite). Both materials here are toneMapped:false and write LINEAR HDR. If you
 *   ever run this module without Postprocessing the sky will look flat and crushed — that is
 *   the missing tone curve, not a bug in the dome.
 *
 * GLSL LIVES IN TEMPLATE LITERALS. Never put a backtick in a shader comment — use 'quotes'.
 * And never '#include' a chunk WebGLProgram already injects into the fragment prefix
 * (colorspace_pars_fragment always; tonemapping_pars_fragment when toneMapped is true) —
 * that is a duplicate-function-body link error a JS syntax check cannot see.
 */
import * as THREE from 'three';
import { Log } from '../core/Log.js';
import { Rand } from '../core/Rand.js';

/* ======================================================================================
 * Palette (ART_DIRECTION.md §2.2). sRGB display hex; THREE.Color converts to linear.
 * ==================================================================================== */
const HEX = {
  skyDeep:     0x080f15,   // zenith, a hair under shadow.base
  skyHorizon:  0x1d2b38,   // the horizon gradient — this is what sells the sky
  skyGround:   0x070b0e,   // below the visible horizon
  moonKey:     0x7d95c4,   // moon.key — the DirectionalLight colour
  moonGlow:    0x8fa6bb,   // fog.lit — the aureole around the moon
  moonBody:    0xd6e0f2,   // moon.spec — the disc itself
  hemiSky:     0x1c2b3a,
  hemiGround:  0x070a08,
  cloudDark:   0x101922,
  cloudLit:    0x3d4e60,
  cloudSilver: 0xb9c8e2,
  milkyWay:    0x8494b8,
  auroraLo:    0x3fce97,   // hue ~155deg — outside the forbidden [100,150] grass band
  auroraHi:    0x9fe6d8,
  lightning:   0xc9d6ee,
  fogNear:     0x2a3a44,   // fog.near, ART §5.1 'Clear' — scene.fog colour
  fogWhite:    0x4a5d6c,   // fog.near, ART §5.1 'Whiteout' — where haze 1.0 lands
};

/**
 * Radiance gains, linear.
 *
 * The hexes above are ART_DIRECTION display-value anchors — the colour the sky should
 * READ as. They are not radiances. AgX is extremely flat in the shadows (a 5x change in
 * linear input moves the encoded output about one tenth), so the dome has to be authored
 * an order of magnitude below its target hex or the night sky comes out as dusk. These
 * numbers were set by reading back the framebuffer at toneMappingExposure 0.62.
 *
 * Ratios matter more than absolutes: horizon / zenith ~= 3.4, cloud-core / clear-sky ~= 0.5,
 * moon aureole / zenith ~= 30, moon disc / zenith ~= 1500.
 */
const GAIN = {
  sky: 0.155,
  ground: 0.10,
  moonGlow: 0.30,
  cloudDark: 0.085,
  cloudLit: 0.10,
  cloudSilver: 0.55,
  milkyWay: 0.022,
  aurora: 0.055,
  lightning: 0.75,
  /**
   * scene.fog.color. See `radiance()` for WHY this is linear and not display.
   *
   * 1.0 would be the ART §5.1 swatch at its exact linear radiance, which measured out at
   * display (0.058, 0.123, 0.213) against keyart-lake's distant-conifer (0.053, 0.107,
   * 0.149) — hue and saturation on the nose (0.73 vs 0.726) but a touch hot. 0.90 is that
   * trim, and it is the ONLY fudge factor in the fog path; everything else is the table.
   */
  fog: 0.90,
};

/** Moon geometry. The real moon is 0.53deg; we run it ~3x for cinematic read. */
const MOON_ANGULAR_RADIUS = 0.0275;   // radians (~1.58deg)

/* Cloud field parameters — MUST stay in sync between the GLSL and the JS mirror below. */
const CLOUD_SCALE = 0.90;
const CLOUD_WARP = 1.25;

/* Module-scope scratch. No allocation in update(). */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fallbackAxis = new THREE.Vector3(1, 0, 0);
const _col = new THREE.Color();

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstepJS = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

/** sRGB hex -> linear-working THREE.Color, as a fresh object (init only). */
function lin(hex) { return new THREE.Color(hex); }

/**
 * sRGB hex -> LINEAR RADIANCE, for `scene.fog.color`.
 *
 * THIS FILE USED TO DO THE OPPOSITE, AND IT WAS THE SINGLE BIGGEST COLOUR DEFECT IN THE GAME.
 * The old helper stored the sRGB DISPLAY fractions of the hex (0x2a3a44 -> 0.165, 0.227,
 * 0.267) on the reasoning that Three composites fog after `colorspace_fragment`, so fogColor
 * is consumed in display space. That reasoning is correct for a default renderer drawing
 * straight to an 8-bit sRGB canvas. It is FALSE here, and here is the whole chain:
 *
 *   Postprocessing renders the scene into an RGBA16F MRT whose texture colorSpace is
 *   LinearSRGBColorSpace, with renderer.toneMapping = NoToneMapping. For a linear target
 *   `linearToOutputTexel` is the IDENTITY, so `colorspace_fragment` is a no-op and the fog
 *   mix that follows it happens in LINEAR RADIANCE, not in display code values. AgX then
 *   runs once, later, in the composite pass — and AgX lifts shadows hard.
 *
 * So the display fractions were being fed in as radiance and then tone mapped a second time.
 * MEASURED, at exposure 0.62, on shot `site-close`: stored fog colour (0.155, 0.216, 0.257)
 * rendered the mid-distance band at display (0.263, 0.327, 0.402) — #435367, saturation 0.35.
 * Feeding the SAME hex as linear radiance (0.023, 0.042, 0.058) rendered it at display
 * (0.058, 0.123, 0.213), saturation 0.73. The first is the "grey wash" ART_DIRECTION §19
 * Trap A1 names; the second is keyart-lake.
 *
 * Every other colour in this file already goes through `lin()` for exactly this reason. Fog
 * was the one exception, and the exception was wrong.
 */
function radiance(hex) { return lin(hex).multiplyScalar(GAIN.fog); }

/** Preallocated so update() never touches the allocator. */
const MOON_KEY_LIN = lin(HEX.moonKey);
const FOG_NEAR_LIN = radiance(HEX.fogNear);
const FOG_WHITE_LIN = radiance(HEX.fogWhite);
const WHITE = new THREE.Color(1, 1, 1);

/**
 * scene.fog.density IS the `D0` of ART_DIRECTION §5.1 — Materials.js reads `fogDensity`
 * straight into its height-fog D0 under FOG_EXP2. The table there runs 0.014 (clear) to
 * 0.078 (whiteout), and `this._haze` is exactly that axis, so these are the endpoints.
 */
const FOG_D0_CLEAR = 0.014;
const FOG_D0_WHITEOUT = 0.078;

/* ======================================================================================
 * GLSL — shared noise library. Identical maths is mirrored in JS further down so that
 * moonOcclusion (a gameplay value) agrees with the cloud the player can actually see.
 * ==================================================================================== */

const GLSL_NOISE = /* glsl */`
float scSat(float x) { return clamp(x, 0.0, 1.0); }

// Dave-Hoskins style float hash. Chosen because it is pure float maths and therefore
// reproducible on the CPU to within ~1e-5, which the moon-occlusion mirror depends on.
float scHash21(vec2 p) {
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float scHash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float scVal2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = scHash21(i);
  float b = scHash21(i + vec2(1.0, 0.0));
  float c = scHash21(i + vec2(0.0, 1.0));
  float d = scHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float scVal3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = p - i;
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = scHash31(i + vec3(0.0, 0.0, 0.0));
  float n100 = scHash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = scHash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = scHash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = scHash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = scHash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = scHash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = scHash31(i + vec3(1.0, 1.0, 1.0));
  float x00 = mix(n000, n100, u.x);
  float x10 = mix(n010, n110, u.x);
  float x01 = mix(n001, n101, u.x);
  float x11 = mix(n011, n111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

// 3 octaves. Used for the domain warp, the cloud base layer, and the aurora.
float scFbm2L(vec2 p) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 3; i++) {
    s += a * scVal2(p);
    n += a;
    p = vec2(p.x * 1.62 - p.y * 1.21, p.x * 1.21 + p.y * 1.62) + vec2(11.3, 7.7);
    a *= 0.5;
  }
  return s / n;
}

// SC_OCT octaves. Tier-driven so 'low' does not pay for cloud detail it cannot see.
float scFbm2(vec2 p) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < SC_OCT; i++) {
    s += a * scVal2(p);
    n += a;
    p = vec2(p.x * 1.62 - p.y * 1.21, p.x * 1.21 + p.y * 1.62) + vec2(11.3, 7.7);
    a *= 0.5;
  }
  return s / n;
}

float scFbm3(vec3 p) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * scVal3(p);
    n += a;
    p = p * 2.03 + vec3(13.1, 7.3, 19.7);
    a *= 0.5;
  }
  return s / n;
}

// Henyey-Greenstein.
float scHG(float mu, float g) {
  float gg = g * g;
  return (1.0 - gg) / pow(max(1.0 + gg - 2.0 * g * mu, 1e-4), 1.5);
}
`;

/**
 * The cloud field. Returns:
 *   x = detailed density 0..1   (what you see)
 *   y = low-frequency thickness (used for transmittance / silver-rim edge detection)
 *
 * The projection divides by a SOFTENED elevation so the coordinate stays bounded at the
 * horizon instead of exploding into aliasing noise.
 */
const GLSL_CLOUD = /* glsl */`
uniform float uCloudCover;
uniform vec2  uCloudDrift;

vec2 scCloudField(vec3 dir) {
  float k = 1.0 / (max(dir.y, -0.05) * 0.92 + 0.145);
  vec2 p = dir.xz * k * ${CLOUD_SCALE.toFixed(4)} + uCloudDrift;
  vec2 w = vec2(scFbm2L(p * 0.42 + 7.31), scFbm2L(p * 0.42 + 23.77)) - 0.5;
  vec2 pw = p + w * ${CLOUD_WARP.toFixed(4)};
  float base = scFbm2L(pw * 0.36 + 3.11);
  float det = scFbm2(pw);
  float n = base * 0.55 + det * 0.45;
  float lo = 1.0 - uCloudCover;
  float d = smoothstep(lo - 0.02, lo + 0.30, n);
  float bd = smoothstep(lo - 0.06, lo + 0.36, base);
  float hz = smoothstep(-0.03, 0.10, dir.y);
  return vec2(d * hz, bd * hz);
}
`;

/* ======================================================================================
 * Sky dome shaders.
 * ==================================================================================== */

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// NB: do NOT '#include <colorspace_pars_fragment>' or '#include <tonemapping_pars_fragment>'
// here. For a ShaderMaterial (not RawShaderMaterial) WebGLProgram ALREADY injects the
// colorspace transfer functions + linearToOutputTexel into the fragment prefix, and it injects
// the whole tonemapping pars chunk too whenever the material is toneMapped and the renderer has
// a tone mapping mode. Including either again is a duplicate-function-body compile error that a
// JS parse can never see — it only shows up as VALIDATE_STATUS false at draw time.
//
// This material is toneMapped:false ON PURPOSE. Postprocessing.js owns the output transform:
// it forces renderer.toneMapping = NoToneMapping and applies AgX exactly once at the end of the
// post chain. The dome therefore writes LINEAR HDR RADIANCE into the HDR MRT. Tone mapping here
// would double-apply the curve and flatten the moon and the stars, which is the whole shot.
// Likewise there is no dither here: the composite pass does the triangular blue-noise dither
// after ITS sRGB encode, which is the only place a display-space dither is meaningful.
const SKY_FRAG = /* glsl */`
varying vec3 vDir;

uniform vec3  uSkyDeep;
uniform vec3  uSkyHorizon;
uniform vec3  uSkyGround;
uniform vec3  uMoonGlow;
uniform vec3  uMoonBody;
uniform vec3  uMilkyWay;
uniform vec3  uCloudDark;
uniform vec3  uCloudLit;
uniform vec3  uCloudSilver;
uniform vec3  uAuroraLo;
uniform vec3  uAuroraHi;
uniform vec3  uLightningCol;

uniform vec3  uMoonDir;
uniform vec3  uMoonT;          // moon disc tangent (screen-right on the disc)
uniform vec3  uMoonB;          // moon disc bitangent (screen-up on the disc)
uniform vec3  uMoonSunLocal;   // sun direction in the moon's local (T,B,toViewer) frame
uniform vec3  uGalPole;
uniform vec3  uGalA;
uniform vec3  uGalB;

uniform float uTime;
uniform float uMoonBright;     // 0..1+, moon above horizon and un-clouded
uniform float uMoonRadius;
uniform float uMoonIntensity;  // linear radiance of the lit disc — allowed to clip AgX
uniform float uHaloGain;
uniform float uNightPhase;     // 0..1, dawn at 1
uniform float uAurora;
uniform float uLightning;
uniform float uMilkyWayGain;
uniform float uPixelAngle;     // radians per pixel — analytic AA, no derivatives needed
uniform float uHaze;           // 0..1 weather haze: lifts and flattens the whole dome

${GLSL_NOISE}
${GLSL_CLOUD}

// ------------------------------------------------------------------ the moon
vec3 scMoonDisc(vec3 dir, float mu, float ang) {
  vec3 outCol = vec3(0.0);
  float R = uMoonRadius;
  if (ang > R * 1.6) return outCol;

  vec2 uv = vec2(dot(dir, uMoonT), dot(dir, uMoonB)) / R;
  float r = length(uv);
  float aa = max(uPixelAngle * 1.4 / R, 1e-4);
  float m = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
  if (m <= 0.0) return outCol;

  float z = sqrt(max(1.0 - min(r * r, 1.0), 0.0));
  vec3 n = vec3(uv.x, uv.y, z);

  // Phase terminator. A real gibbous terminator is ragged — mountains on the limb.
  float lam = dot(n, uMoonSunLocal);
  lam += (scFbm3(n * 16.0) - 0.5) * 0.045;
  float litFrac = smoothstep(-0.055, 0.075, lam);

  // Limb darkening. The moon is a backscattering regolith, so this is mild by design.
  float limb = mix(1.0, pow(max(z, 0.0), 0.34), 0.55);

  // Maria: broad dark basalt plains, sampled in 3D so they foreshorten at the limb.
  float mv = scFbm3(n * 2.3 + 11.0);
  float maria = smoothstep(0.44, 0.68, mv);
  float alb = mix(0.96, 0.58, maria);
  // Highland speckle + one bright ray-crater system.
  alb += (scFbm3(n * 9.0 + 41.0) - 0.5) * 0.16;
  alb += smoothstep(0.90, 1.0, scVal3(n * 5.5 + 61.0)) * 0.26;

  // Earthshine keeps the dark limb from being a hole punched in the sky.
  vec3 body = uMoonBody * (alb * litFrac * limb * uMoonIntensity + 0.020);
  outCol += body * m * uMoonBright;
  return outCol;
}

// ------------------------------------------------------------------ milky way
vec3 scMilkyWay(vec3 dir) {
  float across = dot(dir, uGalPole);
  float band = 1.0 - smoothstep(0.0, 0.34, abs(across));
  if (band <= 0.001) return vec3(0.0);
  float a = atan(dot(dir, uGalB), dot(dir, uGalA));
  float rr = 4.2 + across * 6.0;
  vec2 q = vec2(cos(a), sin(a)) * rr;
  float cloudN = scFbm2L(q * 1.6);
  float dust = scFbm2L(q * 4.3 + 27.0);
  float v = band * (0.35 + 0.95 * cloudN);
  v *= 1.0 - 0.70 * smoothstep(0.38, 0.72, dust);
  return uMilkyWay * v;
}

// ------------------------------------------------------------------ aurora
vec3 scAurora(vec3 dir) {
  if (dir.y < -0.02) return vec3(0.0);
  float a = atan(dir.z, dir.x);
  vec2 q = vec2(cos(a), sin(a)) * 3.1;
  float e = dir.y;

  float h1 = 0.10 + 0.30 * scFbm2L(q * 1.4 + vec2(uTime * 0.021, 0.0));
  float c1 = (1.0 - smoothstep(h1, h1 + 0.44, e)) * smoothstep(h1 - 0.11, h1 + 0.05, e);
  c1 *= 0.30 + 0.90 * scFbm2L(q * 9.5 + vec2(uTime * 0.085, e * 2.2));

  // A second curtain drifting the other way. Slightly too green, slightly too smooth:
  // the whole point is that it is beautiful and faintly wrong.
  float h2 = 0.17 + 0.26 * scFbm2L(q * 2.2 + vec2(-uTime * 0.013, 41.0));
  float c2 = (1.0 - smoothstep(h2, h2 + 0.30, e)) * smoothstep(h2 - 0.08, h2 + 0.04, e);
  c2 *= 0.28 + 0.72 * scFbm2L(q * 13.0 + vec2(-uTime * 0.055, e * 3.1));

  vec3 col = uAuroraLo * c1 + uAuroraHi * (c2 * 0.42);
  // Never competes with the moon, and dies in the horizon murk.
  col *= smoothstep(0.02, 0.16, e);
  return col * uAurora;
}

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;
  float ah = max(h, 0.0);

  // Relative airmass: 1 at zenith, ~7 at the horizon.
  float airmass = 1.0 / (ah * 0.94 + 0.145);
  float mu = clamp(dot(dir, uMoonDir), -1.0, 1.0);
  float ang = acos(mu);

  // Rayleigh: optical depth grows with airmass, phase is the classic (1 + cos^2).
  float rDepth = 1.0 - exp(-airmass * 0.42);
  float rPhase = 0.75 * (1.0 + mu * mu);
  // Mie: the forward-scattering aureole hugging the moon.
  float mDepth = 1.0 - exp(-airmass * 0.075);
  float mPhase = scHG(mu, 0.72);

  // The horizon gradient. This is the single most important line in the file.
  vec3 col = mix(uSkyDeep, uSkyHorizon, rDepth);
  col *= 0.62 + 0.38 * (rPhase * 0.66) * (0.35 + 0.65 * uMoonBright);
  col += uSkyHorizon * rDepth * uHaze * 1.35;

  // Moon aureole — three nested exponentials read as a real atmospheric halo.
  // Three nested exponentials: the tight pearl right off the limb, the aureole, and the
  // broad wash that lifts a third of the sky. A single exp() reads as a fake radial gradient.
  float halo = exp(-ang * 38.0) * 1.05
             + exp(-ang * 7.5) * 0.16
             + exp(-ang * 1.9) * 0.032;
  halo += mPhase * mDepth * 0.06;
  col += uMoonGlow * halo * uMoonBright * uHaloGain * (1.0 + uHaze * 1.6);

  // Milky Way and stars both sit BEHIND the moon glow and the clouds.
  #if SC_MW
  vec3 mw = scMilkyWay(dir);
  mw *= exp(-(airmass - 1.0) * 0.30);                 // atmospheric extinction
  mw *= 1.0 - 0.90 * exp(-ang * 3.2) * uMoonBright;   // washed out near the moon
  mw *= 1.0 - uHaze * 0.85;
  col += mw * uMilkyWayGain * (1.0 - uNightPhase * 0.9);
  #endif

  col += scMoonDisc(dir, mu, ang);

  if (uAurora > 0.002) col += scAurora(dir);

  // ---- clouds, composited over everything above
  if (uCloudCover > 0.004) {
    vec2 cf = scCloudField(dir);
    float d = cf.x;
    float thick = cf.y;
    if (d > 0.002) {
      // Transmittance through the slab; thin edges glow, thick cores go to slate.
      float trans = exp(-thick * 3.6);
      // 'edge' is high where the detail layer has cloud but the low-frequency body does
      // not — i.e. the wispy fringe. That fringe is where a backlit deck goes silver.
      float edge = scSat(d - thick) * 1.6;
      // Broad forward-scatter lobe, not a spotlight: real backlit cloud silvers across a
      // quarter of the sky, and a tight power here reads as a lens artifact instead.
      float moonNear = pow(scSat(mu * 0.5 + 0.5), 3.4);
      float moonCore = pow(scSat(mu), 9.0);

      vec3 cc = mix(uCloudDark, uCloudLit, scSat(moonNear * 0.85 + 0.14 + uHaze * 0.35));
      // The silver rim: backlit thin cloud in front of the moon.
      cc += uCloudSilver * (trans * moonNear * 0.55 + edge * moonNear * 1.05
                            + edge * moonCore * 2.6) * uMoonBright;
      // Ambient top-lighting so cloud away from the moon is not a flat black shape.
      cc += uCloudLit * (0.10 + 0.22 * trans) * (0.35 + 0.65 * rDepth);
      cc += uLightningCol * uLightning * (0.55 + 0.85 * thick);

      col = mix(col, cc, scSat(d));
    }
  }

  // Below the visible horizon the dome is just murk — terrain covers most of it, but the
  // lake shots see it and it must not be a hard seam.
  col = mix(col, uSkyGround + uSkyHorizon * uHaze * 0.6, smoothstep(0.005, -0.075, h));

  // Full-sky lightning luminance spike.
  col += uLightningCol * uLightning * (0.30 + 0.55 * rDepth);

  // Dawn: the sky lifts, desaturates and goes flat. Still cold — nothing in nature is warm.
  float dawn = smoothstep(0.80, 1.0, uNightPhase);
  if (dawn > 0.0) {
    vec3 dawnCol = uSkyHorizon * mix(2.2, 7.0, rDepth);
    col = mix(col, max(col, dawnCol * (0.35 + 0.85 * rDepth)), dawn);
  }

  // LINEAR HDR out. No tone map, no encode of our own — linearToOutputTexel is injected by
  // WebGLProgram and is the identity for the linear float MRT the scene renders into, and the
  // real AgX + grade + dither happen once, in Postprocessing's composite pass.
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);

  #include <colorspace_fragment>
}
`;

/* ======================================================================================
 * Star shaders. Round sprites, magnitude-correct sizes, scintillation, extinction.
 * ==================================================================================== */

const STAR_VERT = /* glsl */`
attribute vec3 aColor;
attribute vec2 aStar;    // x: linear brightness 0..1, y: base sprite size in px
attribute vec2 aTwk;     // x: phase, y: rate

varying vec3 vCol;
varying float vSpike;

uniform vec3  uMoonDir;
uniform float uTime;
uniform float uMoonBright;
uniform float uPixelRatio;
uniform float uStarGain;
uniform float uNightPhase;
uniform float uHaze;

${GLSL_NOISE}
${GLSL_CLOUD}

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;

  vec3 dir = normalize(mat3(modelMatrix) * position);

  float b = aStar.x * uStarGain;

  // --- atmospheric extinction with airmass
  float ah = max(dir.y, 0.0);
  float airmass = 1.0 / (ah * 0.94 + 0.145);
  b *= exp(-(airmass - 1.0) * 0.185);
  b *= smoothstep(-0.03, 0.10, dir.y);

  // --- moon glare
  float ang = acos(clamp(dot(dir, uMoonDir), -1.0, 1.0));
  b *= 1.0 - 0.94 * exp(-ang * 3.4) * uMoonBright;

  // --- weather haze and dawn
  b *= 1.0 - uHaze * 0.80;
  b *= 1.0 - smoothstep(0.78, 0.98, uNightPhase);

  // --- cloud occlusion (the same field the dome draws, evaluated per star)
  if (uCloudCover > 0.004) {
    vec2 cf = scCloudField(dir);
    b *= 1.0 - scSat(cf.x * 1.15);
  }

  // --- scintillation. Two incommensurate rates so it never reads as a sine.
  float amp = 0.08 + 0.34 * scSat((airmass - 1.0) / 5.0);
  float tw = sin(uTime * aTwk.y + aTwk.x) * sin(uTime * aTwk.y * 1.63 + aTwk.x * 3.1);
  b *= 1.0 + amp * tw;

  b = max(b, 0.0);
  vCol = aColor * b;
  vSpike = smoothstep(0.55, 0.95, aStar.x);

  // Brightness drives size as well as intensity — that is what makes a magnitude scale read.
  float s = aStar.y * (0.55 + 0.75 * pow(b, 0.45));
  gl_PointSize = clamp(s, 0.0, 6.0) * uPixelRatio;
  if (b < 0.002) gl_PointSize = 0.0;
}
`;

// Same rule as the dome: no manual tonemapping/colorspace pars (WebGLProgram injects them), and
// toneMapped:false so the stars stay linear HDR until the single AgX in the composite pass.
const STAR_FRAG = /* glsl */`
varying vec3 vCol;
varying float vSpike;

void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;

  // Round, soft, and NEVER square. A gaussian core plus a wide low skirt.
  float core = exp(-r2 * 5.6);
  float skirt = exp(-r2 * 1.5) * 0.20;
  float a = core + skirt;

  // A whisper of a diffraction cross on the brightest stars only.
  float sp = max(0.0, 1.0 - abs(c.x) * 7.0) * max(0.0, 1.0 - abs(c.y) * 1.6)
           + max(0.0, 1.0 - abs(c.y) * 7.0) * max(0.0, 1.0 - abs(c.x) * 1.6);
  a += sp * 0.10 * vSpike;

  a *= smoothstep(1.0, 0.86, sqrt(r2));
  if (a < 0.003) discard;

  gl_FragColor = vec4(vCol * a, 1.0);

  #include <colorspace_fragment>
}
`;

/* ======================================================================================
 * JS mirror of the GLSL cloud field. Keeps moonOcclusion honest.
 * ==================================================================================== */

const fract = (x) => x - Math.floor(x);

function scHash21(px, py) {
  let x = fract(px * 0.1031), y = fract(py * 0.1031), z = fract(px * 0.1031);
  const d = x * (y + 33.33) + y * (z + 33.33) + z * (x + 33.33);
  x += d; y += d; z += d;
  return fract((x + y) * z);
}

function scVal2(px, py) {
  const ix = Math.floor(px), iy = Math.floor(py);
  const fx = px - ix, fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = scHash21(ix, iy);
  const b = scHash21(ix + 1, iy);
  const c = scHash21(ix, iy + 1);
  const d = scHash21(ix + 1, iy + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}

function scFbm2(px, py, oct) {
  let s = 0, a = 0.5, n = 0, x = px, y = py;
  for (let i = 0; i < oct; i++) {
    s += a * scVal2(x, y);
    n += a;
    const nx = x * 1.62 - y * 1.21 + 11.3;
    const ny = x * 1.21 + y * 1.62 + 7.7;
    x = nx; y = ny;
    a *= 0.5;
  }
  return s / n;
}

/** Mirrors scCloudField(). Returns the detailed density only. */
function cloudDensityJS(dx, dy, dz, driftX, driftY, cover, oct) {
  const k = 1 / (Math.max(dy, -0.05) * 0.92 + 0.145);
  const px = dx * k * CLOUD_SCALE + driftX;
  const py = dz * k * CLOUD_SCALE + driftY;
  const wx = scFbm2(px * 0.42 + 7.31, py * 0.42 + 7.31, 3) - 0.5;
  const wy = scFbm2(px * 0.42 + 23.77, py * 0.42 + 23.77, 3) - 0.5;
  const pwx = px + wx * CLOUD_WARP;
  const pwy = py + wy * CLOUD_WARP;
  const base = scFbm2(pwx * 0.36 + 3.11, pwy * 0.36 + 3.11, 3);
  const det = scFbm2(pwx, pwy, oct);
  const n = base * 0.55 + det * 0.45;
  const lo = 1 - cover;
  const d = smoothstepJS(lo - 0.02, lo + 0.30, n);
  const hz = smoothstepJS(-0.03, 0.10, dy);
  return d * hz;
}

/** Crude blackbody -> sRGB. Good enough for a 2 px dot; cheap and monotone in T. */
function blackbodyRGB(T, out) {
  const t = T / 100;
  let r, g, b;
  if (t <= 66) { r = 255; } else { r = 329.7 * Math.pow(t - 60, -0.1332); }
  if (t <= 66) { g = 99.47 * Math.log(t) - 161.12; } else { g = 288.12 * Math.pow(t - 60, -0.0755); }
  if (t >= 66) { b = 255; } else if (t <= 19) { b = 0; } else { b = 138.52 * Math.log(t - 10) - 305.04; }
  out.setRGB(
    clamp01(r / 255), clamp01(g / 255), clamp01(b / 255), THREE.SRGBColorSpace,
  );
  return out;
}

/* ======================================================================================
 * Sky
 * ==================================================================================== */

export class Sky {
  constructor(ctx) {
    this.ctx = ctx ?? {};
    this.bus = this.ctx.bus ?? null;
    this.scene = this.ctx.scene ?? null;

    // ---- public contract -------------------------------------------------------------
    /** Unit vector pointing TO the moon, in world space. */
    this.moonDirection = new THREE.Vector3(0.7935, 0.4384, 0.4218).normalize();
    /** World-space point on the dome where the moon is — for lens flare / god rays. */
    this.moonPosition = new THREE.Vector3();
    /** 0..1 fraction of the moon currently behind cloud. */
    this.moonOcclusion = 0;
    /** 0..1 illuminated fraction of the disc (waxing gibbous across the seven nights). */
    this.moonPhase = 0.72;
    /** The moon key light. Null until init(). */
    this.moonLight = null;
    /** Sky bounce. Null until init(). */
    this.hemiLight = null;
    /** The lightning key. Always in the scene at intensity 0 so light counts never change. */
    this.lightningLight = null;
    /** Current lightning envelope value, 0..1. */
    this.lightningLevel = 0;
    /** Angular radius of the drawn moon, radians. */
    this.moonAngularRadius = MOON_ANGULAR_RADIUS;

    // ---- tunables --------------------------------------------------------------------
    this.cloudCover = 0.38;
    this.auroraStrength = 0;
    /** Global multiplier on the aurora, for a director that wants it dialled back. */
    this._auroraScale = 1;
    this.starGain = 1.0;
    this.haloGain = 1.0;
    this.milkyWayGain = 1.0;
    this.moonBaseIntensity = 0.065;

    // ---- internals -------------------------------------------------------------------
    this.dome = null;
    this.stars = null;
    this.skyMaterial = null;
    this.starMaterial = null;
    this._starGeo = null;
    this._domeGeo = null;
    this._uniforms = null;
    this._starUniforms = null;

    this._time = 0;
    this._driftX = 0;
    this._driftY = 0;
    this._cloudTarget = this.cloudCover;
    this._haze = 0;
    this._hazeTarget = 0;
    this._oct = 5;
    this._shadowExtent = 46;
    this._shadowDist = 240;
    this._shadowTexel = 0.05;
    this._ownsFog = false;
    this._disposed = false;
    this._ready = false;

    this._occDt = 0;
    this._flashT = -1;
    this._flashAmp = 0;
    this._flashDir = 0;
    this._boltDir = new THREE.Vector3(-0.4, 0.55, 0.73).normalize();
    this._shotLightning = null;
    this._windStrength = 0.35;
    this._weatherSeen = false;
    this._hemiBase = 0.35;
    this._starCount = 0;
    this._nextStrike = 1e9;
    this._extLightningPrev = 0;

    try {
      this._rand = this.ctx.rand?.fork ? this.ctx.rand.fork('sky') : new Rand(0x5C1BADE);
    } catch { this._rand = new Rand(0x5C1BADE); }

    this._onWeather = (p) => this._applyWeather(p);
    this._onNight = (p) => this._applyNight(p?.night ?? this.ctx.state?.night ?? 1);
  }

  // ------------------------------------------------------------------ lifecycle

  async init() {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    const s = this.ctx.settings ?? null;
    const tier = (l, m, h, u) => (s?.tier ? s.tier(l, m, h, u) : u);

    this._oct = tier(3, 4, 5, 5);

    try {
      this._buildLights(tier);
      this._buildDome(tier);
      this._buildStars(tier);
      this._installFog();
    } catch (e) {
      Log.error('Sky: build failed — the scene will fall back to flat clear colour.', e);
      return;
    }

    if (this.bus) {
      this.bus.on('weather:change', this._onWeather);
      this.bus.on('night:begin', this._onNight);
    }

    this._applyNight(this.ctx.state?.night ?? 1);
    this._ready = true;

    // Pose everything once so frame 0 is already correct (the shot harness captures early).
    this.update(0, 0);

    const ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    Log.debug(`Sky: dome + ${this._starCount} stars, ${this._oct} cloud octaves, ${ms.toFixed(1)}ms`);
  }

  _buildLights(tier) {
    const scene = this.scene;

    const moon = new THREE.DirectionalLight(lin(HEX.moonKey), this.moonBaseIntensity);
    moon.name = 'sc-moon';
    moon.castShadow = true;
    this._shadowExtent = tier(26, 34, 44, 52);
    this._shadowDist = 240;
    const mapSize = tier(1024, 1024, 2048, 2048);
    moon.shadow.mapSize.set(mapSize, mapSize);
    moon.shadow.bias = -0.0006;
    moon.shadow.normalBias = 0.035;
    moon.shadow.radius = 2;
    const cam = moon.shadow.camera;
    cam.left = -this._shadowExtent;
    cam.right = this._shadowExtent;
    cam.top = this._shadowExtent;
    cam.bottom = -this._shadowExtent;
    cam.near = 1;
    cam.far = this._shadowDist * 2.2;
    cam.updateProjectionMatrix();
    this._shadowTexel = (2 * this._shadowExtent) / mapSize;
    moon.target.position.set(0, 0, 0);
    scene?.add(moon.target);
    scene?.add(moon);
    this.moonLight = moon;

    const hemi = new THREE.HemisphereLight(lin(HEX.hemiSky), lin(HEX.hemiGround), 0.35);
    hemi.name = 'sc-sky-bounce';
    scene?.add(hemi);
    this.hemiLight = hemi;
    this._hemiBase = 0.35;

    // Present from frame 0 at zero intensity: adding a light later forces a full shader
    // recompile of every material in the scene, which is a visible hitch mid-storm.
    const bolt = new THREE.DirectionalLight(lin(HEX.lightning), 0);
    bolt.name = 'sc-lightning';
    bolt.castShadow = false;
    bolt.target.position.set(0, 0, 0);
    scene?.add(bolt.target);
    scene?.add(bolt);
    this.lightningLight = bolt;
  }

  _buildDome(tier) {
    const segs = tier(32, 48, 64, 96);
    this._domeGeo = new THREE.SphereGeometry(900, segs, Math.max(16, segs >> 1));

    this._uniforms = {
      uSkyDeep:      { value: lin(HEX.skyDeep).multiplyScalar(GAIN.sky) },
      uSkyHorizon:   { value: lin(HEX.skyHorizon).multiplyScalar(GAIN.sky) },
      uSkyGround:    { value: lin(HEX.skyGround).multiplyScalar(GAIN.ground) },
      uMoonGlow:     { value: lin(HEX.moonGlow).multiplyScalar(GAIN.moonGlow) },
      uMoonBody:     { value: lin(HEX.moonBody) },
      uMilkyWay:     { value: lin(HEX.milkyWay).multiplyScalar(GAIN.milkyWay) },
      uCloudDark:    { value: lin(HEX.cloudDark).multiplyScalar(GAIN.cloudDark) },
      uCloudLit:     { value: lin(HEX.cloudLit).multiplyScalar(GAIN.cloudLit) },
      uCloudSilver:  { value: lin(HEX.cloudSilver).multiplyScalar(GAIN.cloudSilver) },
      uAuroraLo:     { value: lin(HEX.auroraLo).multiplyScalar(GAIN.aurora) },
      uAuroraHi:     { value: lin(HEX.auroraHi).multiplyScalar(GAIN.aurora) },
      uLightningCol: { value: lin(HEX.lightning).multiplyScalar(GAIN.lightning) },

      uMoonDir:      { value: this.moonDirection.clone() },
      uMoonT:        { value: new THREE.Vector3(1, 0, 0) },
      uMoonB:        { value: new THREE.Vector3(0, 1, 0) },
      uMoonSunLocal: { value: new THREE.Vector3(0.9, 0.12, 0.42).normalize() },
      uGalPole:      { value: new THREE.Vector3(-0.42, 0.63, 0.65).normalize() },
      uGalA:         { value: new THREE.Vector3(1, 0, 0) },
      uGalB:         { value: new THREE.Vector3(0, 0, 1) },

      uTime:         { value: 0 },
      uMoonBright:   { value: 1 },
      uMoonRadius:   { value: MOON_ANGULAR_RADIUS },
      uMoonIntensity:{ value: 2.6 },
      uHaloGain:     { value: this.haloGain },
      uNightPhase:   { value: 0 },
      uAurora:       { value: 0 },
      uLightning:    { value: 0 },
      uMilkyWayGain: { value: this.milkyWayGain },
      uPixelAngle:   { value: 0.001 },
      uHaze:         { value: 0 },
      uCloudCover:   { value: this.cloudCover },
      uCloudDrift:   { value: new THREE.Vector2(0, 0) },
    };

    this.skyMaterial = new THREE.ShaderMaterial({
      name: 'sc-sky',
      uniforms: this._uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      defines: { SC_OCT: this._oct, SC_MW: tier(0, 1, 1, 1) },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      transparent: false,
      fog: false,
      // Postprocessing owns the output transform (renderer.toneMapping = NoToneMapping, AgX once
      // in the composite). toneMapped:false stops WebGLProgram injecting the tonemapping pars
      // chunk, which our shader must not duplicate, and keeps the dome linear HDR.
      toneMapped: false,
    });

    this.dome = new THREE.Mesh(this._domeGeo, this.skyMaterial);
    this.dome.name = 'sc-sky-dome';
    this.dome.renderOrder = -10000;
    this.dome.frustumCulled = false;
    this.dome.matrixAutoUpdate = true;
    this.dome.castShadow = false;
    this.dome.receiveShadow = false;
    this.scene?.add(this.dome);
  }

  _buildStars(tier) {
    const count = tier(900, 1800, 3200, 4800);
    this._starCount = count;
    const r = this._rand;

    const pos = new Float32Array(count * 3);
    const colv = new Float32Array(count * 3);
    const star = new Float32Array(count * 2);
    const twk = new Float32Array(count * 2);

    // Magnitude distribution: N(<m) grows as 10^(0.6 m), so invert that CDF. The result is
    // the thing that reads as a real sky — thousands of near-invisible stars, a handful of
    // bright ones, and nothing in between clumping at one size.
    const mMin = 0.4, mMax = 6.4;
    const K = Math.pow(10, 0.6 * (mMax - mMin));

    for (let i = 0; i < count; i++) {
      // Uniform on the sphere, biased to the visible dome (a shallow skirt below horizon).
      const u = r.range(-0.18, 1.0);
      const y = u;
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const th = r.next() * Math.PI * 2;
      const R = 880;
      pos[i * 3 + 0] = Math.cos(th) * rad * R;
      pos[i * 3 + 1] = y * R;
      pos[i * 3 + 2] = Math.sin(th) * rad * R;

      const m = mMin + Math.log10(1 + r.next() * (K - 1)) / 0.6;
      // Relative flux, normalised so mag 6.4 is barely there and mag 0.4 is a beacon.
      let b = Math.pow(10, -0.4 * (m - mMin));
      b = clamp01(Math.pow(b, 0.62) * 1.02);

      // Colour temperature: mostly cool orange dwarves, a few hot blue-white giants.
      // Brighter stars skew hotter, which is true and also reads better.
      const hot = r.next() < 0.16 + 0.34 * b;
      const T = hot ? r.range(7200, 13500) : r.range(3300, 6400);
      blackbodyRGB(T, _col);
      // Pull everything toward white — the eye is scotopic at these levels and real stars
      // read far less saturated than a blackbody curve suggests.
      _col.lerp(WHITE, 0.42);
      colv[i * 3 + 0] = _col.r;
      colv[i * 3 + 1] = _col.g;
      colv[i * 3 + 2] = _col.b;

      star[i * 2 + 0] = b;
      star[i * 2 + 1] = 1.5 + 2.4 * Math.pow(b, 0.5);
      twk[i * 2 + 0] = r.range(0, Math.PI * 2);
      twk[i * 2 + 1] = r.range(1.4, 5.2);
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(colv, 3));
    g.setAttribute('aStar', new THREE.BufferAttribute(star, 2));
    g.setAttribute('aTwk', new THREE.BufferAttribute(twk, 2));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 900);
    this._starGeo = g;

    const dpr = Number.isFinite(this.ctx.dpr) ? this.ctx.dpr : 1;
    this._starUniforms = {
      uMoonDir:    { value: this._uniforms.uMoonDir.value },
      uTime:       { value: 0 },
      uMoonBright: { value: 1 },
      uPixelRatio: { value: dpr },
      uStarGain:   { value: this.starGain },
      uNightPhase: { value: 0 },
      uHaze:       { value: 0 },
      // Shared by reference with the dome so cloud occlusion can never desynchronise.
      uCloudCover: this._uniforms.uCloudCover,
      uCloudDrift: this._uniforms.uCloudDrift,
    };

    this.starMaterial = new THREE.ShaderMaterial({
      name: 'sc-stars',
      uniforms: this._starUniforms,
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      defines: { SC_OCT: this._oct },
      blending: THREE.AdditiveBlending,
      // transparent:false keeps this in the OPAQUE queue, so renderOrder puts it before the
      // terrain and the terrain's depth write hides the stars it should hide.
      transparent: false,
      depthWrite: false,
      depthTest: true,
      fog: false,
      // Linear HDR out; AgX is applied once, in Postprocessing. See the dome material.
      toneMapped: false,
    });

    this.stars = new THREE.Points(g, this.starMaterial);
    this.stars.name = 'sc-stars';
    this.stars.renderOrder = -9999;
    this.stars.frustumCulled = false;
    this.scene?.add(this.stars);
  }

  /**
   * Materials.js only upgrades its analytic height fog when someone has actually set
   * `scene.fog` — ownership is Sky's until VolumetricFog is real. Without this there is no
   * aerial perspective at all and every distance shot reads as a cardboard cut-out.
   */
  _installFog() {
    const scene = this.scene;
    if (!scene) return;
    if (scene.fog) return;                    // somebody else owns it — leave it alone
    const fog = new THREE.FogExp2(0x000000, FOG_D0_CLEAR);
    fog.color.copy(FOG_NEAR_LIN);
    fog.name = 'sc-sky-fog';
    scene.fog = fog;
    this._ownsFog = true;

    // Give Materials a sane height profile only if VolumetricFog has not shipped yet.
    try {
      const vf = this.ctx.systems?.get?.('VolumetricFog');
      const vfReal = vf && typeof vf.render === 'function';
      const mats = this.ctx.systems?.get?.('Materials');
      if (!vfReal && typeof mats?.setFogParams === 'function') {
        const terrain = this.ctx.systems?.get?.('Terrain');
        const y0 = Number.isFinite(terrain?.waterLevel) ? terrain.waterLevel : 0;
        mats.setFogParams({ D0: FOG_D0_CLEAR, y0, H: 4.2, scatterScale: 1.0, g: 0.55, inscatter: 1.0 });
      }
    } catch (e) {
      Log.debug('Sky: could not hand fog params to Materials —', e?.message ?? e);
    }
  }

  // ------------------------------------------------------------------ per-night / weather

  _applyNight(night) {
    const n = Math.max(1, Math.min(7, Number.isFinite(night) ? night : 1));
    const t = (n - 1) / 6;

    // ART §3.2: the moon rises with the cabin. ARCHITECTURE §10 wants ~0.06 DELIVERED on a
    // night-1 clear sky; 0.065 authored is what lands there once the (now much gentler)
    // haze/cloud terms in _updateMoonLight have taken their cut. 0.098 by night 7.
    this.moonBaseIntensity = lerp(0.065, 0.098, t);
    // Waxing gibbous -> nearly full. Phase angle 64deg -> 20deg.
    const pa = THREE.MathUtils.degToRad(lerp(64, 20, t));
    this.moonPhase = (1 + Math.cos(pa)) * 0.5;
    if (this._uniforms) {
      this._uniforms.uMoonSunLocal.value.set(Math.sin(pa), 0.12, Math.cos(pa)).normalize();
      // The disc is the one thing in the game allowed to clip the tone curve outright
      // (ART §3.1: brightest 0.1%). Measured: below ~7.0 linear AgX rolls it off to a
      // grey coin at 140/255 and the bloom has nothing to bite on.
      this._uniforms.uMoonIntensity.value = lerp(8.0, 13.0, t);
    }

    // Weather.js owns the real schedule; this is the standalone fallback so a solo run of
    // any night still looks like that night (ART §3.1.1 weather table).
    const COVER = [0.28, 0.44, 0.40, 0.72, 0.85, 0.95, 0.22];
    if (!this._weatherSeen) this._cloudTarget = COVER[n - 1];
    // update() re-derives auroraStrength from state.night every frame; this only seeds it.
    this.auroraStrength = n >= 5 ? lerp(0.55, 1.0, clamp01((n - 5) / 2)) * this._auroraScale : 0;

    // Storm nights get a standalone lightning schedule if Weather is not driving us.
    this._nextStrike = (n === 6) ? this._rand.range(4, 12) : 1e9;
  }

  _applyWeather(p) {
    if (!p) return;
    this._weatherSeen = true;
    const rain = Number.isFinite(p.rain) ? clamp01(p.rain) : null;
    const fog = Number.isFinite(p.fog) ? clamp01(p.fog) : null;
    if (rain !== null || fog !== null) {
      const r = rain ?? 0, f = fog ?? 0;
      this._cloudTarget = clamp01(0.20 + r * 0.72 + f * 0.35);
      this._hazeTarget = clamp01(f * 0.85 + r * 0.25);
    }
    const wind = p.wind;
    if (Number.isFinite(wind)) this._windStrength = wind;
  }

  // ------------------------------------------------------------------ lightning

  /**
   * Fire a lightning flash. ~120 ms of core with three stages, then a short afterglow.
   * Lights the WHOLE SCENE: drives `lightningLight`, the dome, and Materials uLightning.
   * @param {number} intensity 0..1+ (1 = a close strike)
   */
  flash(intensity = 1) {
    const a = Number.isFinite(intensity) ? Math.max(0, intensity) : 1;
    if (a <= 0.001) return;
    // A new strike always wins — a second bolt does not politely wait its turn.
    this._flashT = 0;
    this._flashAmp = a;
    this._flashDir = this._rand.range(0, Math.PI * 2);
    // Sheet lightning behind the cloud deck: low elevation, random azimuth.
    const el = this._rand.range(0.18, 0.46);
    const ce = Math.sqrt(Math.max(0, 1 - el * el));
    this._boltDir.set(Math.cos(this._flashDir) * ce, el, Math.sin(this._flashDir) * ce).normalize();
  }

  /** 3-stage envelope. t in seconds since the strike began. */
  _flashEnvelope(t) {
    if (t < 0 || t > 0.72) return 0;
    const tri = (t0, w) => Math.max(0, 1 - Math.abs(t - t0) / w);
    let e = tri(0.014, 0.030) * 1.00;
    e = Math.max(e, tri(0.062, 0.024) * 0.58);
    e = Math.max(e, tri(0.106, 0.032) * 0.86);
    if (t > 0.13) e = Math.max(e, Math.exp(-(t - 0.13) * 7.5) * 0.20);
    return e;
  }

  // ------------------------------------------------------------------ frame

  update(dt, elapsed) {
    if (!this._ready || this._disposed) return;
    const d = Number.isFinite(dt) ? Math.min(dt, 0.1) : 0;
    this._time += d;
    const u = this._uniforms;
    const su = this._starUniforms;
    const state = this.ctx.state ?? null;
    const camera = this.ctx.camera ?? null;

    const ton = clamp01(Number.isFinite(state?.timeOfNight) ? state.timeOfNight : 0);

    // ---- moon ephemeris (matches Materials' fallback exactly: az 118deg, el 26 -> 19)
    const az = THREE.MathUtils.degToRad(118 + 9 * ton);
    const el = THREE.MathUtils.degToRad(26 - 7 * ton);
    const ce = Math.cos(el);
    this.moonDirection.set(Math.sin(az) * ce, Math.sin(el), -Math.cos(az) * ce).normalize();
    u.uMoonDir.value.copy(this.moonDirection);

    // Moon disc frame. Must match the CPU basis or the terminator will spin.
    _v1.copy(_up).cross(this.moonDirection);
    if (_v1.lengthSq() < 1e-6) _v1.copy(_fallbackAxis);
    _v1.normalize();
    _v2.copy(this.moonDirection).cross(_v1).normalize();
    u.uMoonT.value.copy(_v1);
    u.uMoonB.value.copy(_v2);

    // ---- weather / cloud integration
    this._readWeather(d);
    const cs = 1 - Math.exp(-d * 0.55);
    this.cloudCover += (this._cloudTarget - this.cloudCover) * (d > 0 ? cs : 1);
    this._haze += (this._hazeTarget - this._haze) * (d > 0 ? cs : 1);
    u.uCloudCover.value = this.cloudCover;
    u.uHaze.value = this._haze;
    su.uHaze.value = this._haze;

    // Cloud drift. Deliberately slow — a sky that scuds reads as a time-lapse.
    const ws = this._windStrength ?? 0.35;
    this._driftX += d * (0.0085 + ws * 0.020);
    this._driftY += d * (0.0042 + ws * 0.009);
    u.uCloudDrift.value.set(this._driftX, this._driftY);

    // ---- moon occlusion: sample the same field at and around the moon (gameplay value)
    this._occDt = d;
    this._updateOcclusion();

    // ---- brightness bookkeeping
    const above = smoothstepJS(-0.04, 0.10, this.moonDirection.y);
    const dawnFade = 1 - smoothstepJS(0.86, 1.0, ton);
    const moonBright = above * dawnFade * (1 - 0.90 * this.moonOcclusion) * (1 - this._haze * 0.35);
    u.uMoonBright.value = moonBright;
    su.uMoonBright.value = moonBright;
    u.uNightPhase.value = ton;
    su.uNightPhase.value = ton;
    u.uTime.value = this._time;
    su.uTime.value = this._time;
    u.uHaloGain.value = this.haloGain * (1 + this._haze * 0.5);
    u.uMilkyWayGain.value = this.milkyWayGain;
    su.uStarGain.value = this.starGain;

    // Analytic AA width for the moon's limb — cheaper and more portable than fwidth(),
    // which needs a #extension pragma under ESSL1. Measured against the DRAWING BUFFER.
    if (camera?.isPerspectiveCamera && this.ctx.height > 0) {
      const dpr = Number.isFinite(this.ctx.dpr) && this.ctx.dpr > 0 ? this.ctx.dpr : 1;
      u.uPixelAngle.value = (camera.fov * Math.PI / 180) / Math.max(1, this.ctx.height * dpr);
      su.uPixelRatio.value = dpr;
    }

    // ---- aurora (ART: night >= 5, faint, beautiful, slightly wrong)
    //
    // Derived from state.night EVERY FRAME rather than latched on 'night:begin'. NightManager
    // may never fire that event (it is allowed to be missing entirely), and an aurora that
    // only exists if another system remembered to announce itself is an aurora that never
    // ships. The event handler still runs — it just sets the same value earlier.
    const night = Number.isFinite(state?.night) ? state.night : 1;
    const aur = night >= 5 ? lerp(0.55, 1.0, clamp01((night - 5) / 2)) * this._auroraScale : 0;
    this.auroraStrength = aur;
    // Aurora dies as dawn comes up and is swallowed by heavy cloud.
    u.uAurora.value = aur * dawnFade * (1 - this.cloudCover * 0.55);

    // ---- lightning
    this._updateLightning(d);

    // ---- follow the camera; rotate the star sphere slowly toward dawn
    if (camera) {
      this.dome.position.copy(camera.position);
      this.stars.position.copy(camera.position);
      this.moonPosition.copy(camera.position).addScaledVector(this.moonDirection, 890);
    }
    this.stars.rotation.set(0, 0, 0);
    this.stars.rotateOnAxis(_v3.set(-0.42, 0.63, 0.65).normalize(), ton * 0.13);

    // ---- lights
    this._updateMoonLight(d);
    if (this.hemiLight) {
      // Bounded: the sky bounce is fill, and fill that outruns the key turns the forest
      // into flat grey mush (ART §1). Ceiling is 2.4x the base even at a dawn whiteout.
      this.hemiLight.intensity = Math.min(this._hemiBase * 2.4, this._hemiBase
        * (1 + this._haze * 0.55)
        * (1 - 0.42 * this.moonOcclusion)
        * (1 + smoothstepJS(0.86, 1.0, ton) * 0.9));
    }

    // ---- scene fog: colour and density track weather and dawn
    //
    // Density is ART §5.1's D0 axis, clear -> whiteout, and the colour walks the SAME axis
    // between the two 'Near colour' swatches in that table (#2a3a44 -> #4a5d6c). The old code
    // walked toward skyHorizon by a coefficient that DECREASED with haze, i.e. thicker
    // weather made the fog cooler and more sky-like when ART says a whiteout is the one time
    // the fog goes pale and flat. Both quantities are now the table, read left to right.
    if (this._ownsFog && this.scene?.fog) {
      const f = this.scene.fog;
      const haze = this._haze;
      f.density = lerp(FOG_D0_CLEAR, FOG_D0_WHITEOUT, haze);
      // LINEAR radiance out — see radiance(). Dawn lifts it; nothing else touches it.
      _col.copy(FOG_NEAR_LIN)
        .lerp(FOG_WHITE_LIN, haze)
        .multiplyScalar(1 + smoothstepJS(0.86, 1.0, ton) * 1.6);
      f.color.copy(_col);
    }
  }

  _readWeather(dt) {
    let w = null;
    try { w = this.ctx.systems?.get?.('Weather') ?? null; } catch { w = null; }

    if (w) {
      if (Number.isFinite(w.rain) || Number.isFinite(w.fog)) {
        const r = Number.isFinite(w.rain) ? clamp01(w.rain) : 0;
        const f = Number.isFinite(w.fog) ? clamp01(w.fog) : 0;
        this._weatherSeen = true;
        this._cloudTarget = clamp01(0.20 + r * 0.72 + f * 0.35);
        this._hazeTarget = clamp01(f * 0.85 + r * 0.25);
      }
      if (Number.isFinite(w.wind)) this._windStrength = clamp01(w.wind);
    }

    // The shot harness pins lightning on the Shots record when Weather cannot take it.
    let shotLightning = null;
    try {
      const sh = this.ctx.systems?.get?.('Shots');
      const v = sh?.active?.lightning;
      if (Number.isFinite(v)) shotLightning = clamp01(v);
    } catch { shotLightning = null; }
    this._shotLightning = shotLightning;

    // Rising edge on an external lightning value fires our own envelope + light.
    let ext = null;
    const L = w?.lightning;
    if (Number.isFinite(L)) ext = clamp01(L);
    else if (Number.isFinite(L?.value)) ext = clamp01(L.value);
    if (ext !== null) {
      if (ext > 0.35 && this._extLightningPrev <= 0.35) this.flash(ext);
      this._extLightningPrev = ext;
      this._nextStrike = 1e9;                 // Weather is driving; stand down
    } else if (this._nextStrike < 1e8) {
      this._nextStrike -= dt;
      if (this._nextStrike <= 0) {
        this.flash(this._rand.range(0.45, 1.0));
        this._nextStrike = this._rand.range(5, 19);
      }
    }
  }

  _updateOcclusion() {
    const dr = this.moonDirection;
    const cov = this.cloudCover;
    // Centre plus three points on a ring at ~3x the moon radius: a wisp thinner than the
    // disc should not black out the forest.
    let sum = cloudDensityJS(dr.x, dr.y, dr.z, this._driftX, this._driftY, cov, this._oct) * 2;
    let wsum = 2;
    const T = this._uniforms.uMoonT.value;
    const B = this._uniforms.uMoonB.value;
    const rr = MOON_ANGULAR_RADIUS * 3.0;
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      _v4.copy(dr)
        .addScaledVector(T, Math.cos(a) * rr)
        .addScaledVector(B, Math.sin(a) * rr)
        .normalize();
      sum += cloudDensityJS(_v4.x, _v4.y, _v4.z, this._driftX, this._driftY, cov, this._oct);
      wsum += 1;
    }
    const target = clamp01(sum / wsum);
    // Light low-pass so a single-frame noise spike never strobes the key light. Framerate
    // independent: a fixed per-frame lerp would make the darkness event arrive twice as fast
    // at 120 Hz as at 60.
    const k = this._occDt > 0 ? 1 - Math.exp(-this._occDt * 6.0) : 1;
    this.moonOcclusion += (target - this.moonOcclusion) * k;
  }

  _updateLightning(dt) {
    let e = 0;
    if (this._flashT >= 0) {
      this._flashT += dt;
      e = this._flashEnvelope(this._flashT) * this._flashAmp;
      if (this._flashT > 0.72) this._flashT = -1;
    }
    if (this._shotLightning !== null && this._shotLightning !== undefined) {
      e = Math.max(e, this._shotLightning);
    }
    this.lightningLevel = clamp01(e);

    this._uniforms.uLightning.value = this.lightningLevel;

    // Materials updates BEFORE Sky in registration order, so writing max() here both wins
    // the frame and preserves anything Weather already asked for.
    try {
      const mats = this.ctx.systems?.get?.('Materials');
      const gu = mats?.globalUniforms;
      if (gu?.uLightning) {
        gu.uLightning.value = Math.max(gu.uLightning.value ?? 0, this.lightningLevel);
      }
      if (gu?.uMoonDir) gu.uMoonDir.value.copy(this.moonDirection);
    } catch { /* Materials absent — the sky still flashes */ }

    const bolt = this.lightningLight;
    if (bolt) {
      bolt.intensity = this.lightningLevel * 4.5;
      const cam = this.ctx.camera;
      const dir = this._boltDir;
      if (cam) {
        bolt.target.position.copy(cam.position);
        bolt.position.copy(cam.position).addScaledVector(dir, 300);
      } else {
        bolt.position.copy(dir).multiplyScalar(300);
      }
      bolt.target.updateMatrixWorld();
    }
  }

  /**
   * Fit the moon's shadow camera to the player and SNAP IT TO THE TEXEL GRID.
   *
   * Without the snap, sub-texel movement of the shadow frustum makes every shadow edge
   * shimmer and crawl as the player walks — the single most common tell of an amateur
   * directional-shadow setup. We rebuild Three's own light-space basis (which is derived
   * from `Object3D.up` = +Y via lookAt) and quantise the frustum centre in it.
   */
  _updateMoonLight() {
    const light = this.moonLight;
    if (!light) return;

    // ARCHITECTURE §10 specifies the moon key at ~0.06. That is the DELIVERED intensity, not
    // an author-time number to then attenuate away: measured on shot `camp-tents` the old
    // chain shipped 0.0243, well under half spec, and the forest went to mud.
    //
    // Two of the three attenuations were wrong, not just strong:
    //   haze 0.45  -> 0.15. ART §3.1.1: 'a foggy night is a BRIGHTER, flatter night, and that
    //                is physically true'. Haze scatters the key, it does not eat it. The
    //                flattening is the hemi lift below, which already happens.
    //   cloud 0.80 -> 0.62. A cloud crossing the moon must still be a darkness event, but at
    //                0.80 a routine overcast (measured occlusion 0.60) halved the key on its
    //                own, so 'the moon went behind a cloud' had no headroom left to read as
    //                an event. Full occlusion now leaves 38% of the key, not 20%.
    const above = smoothstepJS(-0.04, 0.10, this.moonDirection.y);
    const ton = clamp01(this.ctx.state?.timeOfNight ?? 0);
    light.intensity = this.moonBaseIntensity
      * above
      * (1 - 0.62 * this.moonOcclusion)
      * (1 - this._haze * 0.15)
      * (1 - smoothstepJS(0.88, 1.0, ton) * 0.35);
    light.color.copy(MOON_KEY_LIN);

    // Centre on the player, falling back to the camera.
    let centre = null;
    try {
      const p = this.ctx.systems?.get?.('Player');
      centre = p?.position ?? p?.object?.position ?? null;
    } catch { centre = null; }
    if (!centre && this.ctx.camera) centre = this.ctx.camera.position;
    if (!centre) return;

    // Light-space basis, identical to what LightShadow.updateMatrices() will build.
    const zA = _v1.copy(this.moonDirection);
    const xA = _v2.copy(_up).cross(zA);
    if (xA.lengthSq() < 1e-8) xA.copy(_fallbackAxis);
    xA.normalize();
    const yA = _v3.copy(zA).cross(xA).normalize();

    const texel = this._shadowTexel;
    const cx = Math.round(centre.dot(xA) / texel) * texel;
    const cy = Math.round(centre.dot(yA) / texel) * texel;
    const cz = centre.dot(zA);

    _v4.set(0, 0, 0).addScaledVector(xA, cx).addScaledVector(yA, cy).addScaledVector(zA, cz);

    light.target.position.copy(_v4);
    light.position.copy(_v4).addScaledVector(this.moonDirection, this._shadowDist);
    light.target.updateMatrixWorld();
    light.updateMatrixWorld();
  }

  // ------------------------------------------------------------------ misc API

  /** World-space position of the moon on the dome — for lens flare / god-ray origins. */
  getMoonWorldPosition(out = new THREE.Vector3()) { return out.copy(this.moonPosition); }

  /** 0..1 how much of the moon's light is actually reaching the ground right now. */
  get moonVisibility() { return clamp01((1 - this.moonOcclusion) * (this.moonDirection.y > 0 ? 1 : 0)); }

  /** Force cloud coverage (0..1). Weather may overwrite it on the next `weather:change`. */
  setCloudCover(v, immediate = false) {
    this._cloudTarget = clamp01(v);
    if (immediate) {
      this.cloudCover = this._cloudTarget;
      if (this._uniforms) this._uniforms.uCloudCover.value = this.cloudCover;
    }
  }

  resize(_w, _h) {
    if (this._starUniforms) {
      this._starUniforms.uPixelRatio.value = Number.isFinite(this.ctx.dpr) ? this.ctx.dpr : 1;
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._ready = false;

    if (this.bus) {
      this.bus.off?.('weather:change', this._onWeather);
      this.bus.off?.('night:begin', this._onNight);
    }

    const scene = this.scene;
    if (this.dome) { scene?.remove(this.dome); this.dome = null; }
    if (this.stars) { scene?.remove(this.stars); this.stars = null; }
    this._domeGeo?.dispose(); this._domeGeo = null;
    this._starGeo?.dispose(); this._starGeo = null;
    this.skyMaterial?.dispose(); this.skyMaterial = null;
    this.starMaterial?.dispose(); this.starMaterial = null;

    if (this.moonLight) {
      this.moonLight.shadow?.dispose?.();
      scene?.remove(this.moonLight.target);
      scene?.remove(this.moonLight);
      this.moonLight = null;
    }
    if (this.lightningLight) {
      scene?.remove(this.lightningLight.target);
      scene?.remove(this.lightningLight);
      this.lightningLight = null;
    }
    if (this.hemiLight) { scene?.remove(this.hemiLight); this.hemiLight = null; }

    if (this._ownsFog && scene?.fog) { scene.fog = null; this._ownsFog = false; }

    this._uniforms = null;
    this._starUniforms = null;
  }
}

export default Sky;
