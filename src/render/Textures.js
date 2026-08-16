/**
 * Procedural PBR texture bakery.  OWNER: Materials agent.  See ARCHITECTURE.md §9, §10 and
 * ART_DIRECTION.md §5 (material table), §7.3 (grade LUT), §7.7 (dither blue noise).
 *
 * WHAT THIS IS
 * ------------
 * Every surface in the game gets its detail from here.  Nothing is fetched; nothing is drawn
 * with canvas2d.  Each material is a *height field written as GLSL*, rendered once into a
 * multiple-render-target at init, after which the render targets' `.texture` objects are the
 * game's textures forever.
 *
 * Per material we bake, in ONE fullscreen MRT pass:
 *   attachment 0 -> albedo.rgb (sRGB-encoded) , a = opacity
 *   attachment 1 -> tangent-space normal.rgb  , a = HEIGHT   (for parallax / POM)
 *   attachment 2 -> r = AO, g = roughness, b = metalness, a = cavity
 * ...plus a second, half-resolution single-target pass that writes the height field to .r so
 * that `displacementMap` (which Three samples from the red channel) works out of the box.
 *
 * Attachment 2 is deliberately laid out as glTF "ORM", which is exactly the channel layout
 * `MeshStandardMaterial` expects: aoMap reads .r, roughnessMap reads .g, metalnessMap reads .b.
 * One texture, three slots, no extra memory.  (Three's `texture.channel` defaults to 0 since
 * r151, so aoMap does NOT need a second UV set.)
 *
 * NORMALS are derived by central differences ON THE HEIGHT FUNCTION -- H() is evaluated four
 * extra times per texel at +/- one texel in u and v.  They are never faked from luminance.
 * Occlusion is a 6-tap multi-radius horizon estimate over the same H(), so crevice dirt and
 * contact darkening are real, not a curvature hack.
 *
 * HOW TILING IS ACHIEVED  (no mirroring anywhere)
 * -----------------------------------------------
 * Every noise primitive takes `(p, per)` and wraps its integer lattice coordinate with
 * `mod(cell, per)` before hashing -- a periodic hash.  We always call them as `f(uv * S, S)`
 * with S an *integer* vec2, so every primitive is exactly periodic with period 1 in uv.
 * fbm/ridged use lacunarity 2.0 so each octave's period stays integral.  Sums, products, and
 * DOMAIN WARPS of period-1 functions are period-1 (if w(uv) has period 1 then
 * f(uv + w(uv)) has period 1 too), so a warped, worley-cracked, fbm-stained material is still
 * seamless.  Constant offsets inside the noise domain are also safe.  Nothing here relies on
 * mirrored repeat, and no texture has a visible seam.
 *
 * MULTI-SCALE RULE: every material stacks at least three frequency bands -- a low-frequency
 * stain/zoning layer (metres), a mid-frequency structural layer (centimetres), and a
 * high-frequency grain layer (millimetres).  A single-frequency material reads as fake.
 *
 * Contract: default-export and named-export a class `Textures` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 */

import * as THREE from 'three';
import { Log } from '../core/Log.js';
import { Rand, hashStr } from '../core/Rand.js';

// ---------------------------------------------------------------------------------------------
// SHADER: prelude
// ---------------------------------------------------------------------------------------------

const VERT = /* glsl */`
precision highp float;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const PRELUDE = /* glsl */`
precision highp float;
precision highp int;

in vec2 vUv;

layout(location = 0) out vec4 oAlbedo;
layout(location = 1) out vec4 oNormal;
layout(location = 2) out vec4 oORM;

uniform vec2  uRes;             // bake resolution in texels
uniform float uNormalStrength;  // = physical relief (m) / physical tile size (m)
uniform float uAOStrength;
uniform float uCavity;
uniform float uToksvig;         // slope-variance -> roughness, keeps micro-sparkle after mipping
uniform float uSeed;            // per-material hash-domain offset (from ctx.rand, deterministic)
uniform float uTime;
uniform float uHeightOnly;      // 1.0 during the half-res displacement pass

#define TAU 6.28318530717958648
#define PI  3.14159265358979324
// Author albedo straight from the ART_DIRECTION hex table, in 0..255 sRGB display units.
#define C3(r, g, b) (vec3(r, g, b) * 0.00392156862745098)
`;

// ---------------------------------------------------------------------------------------------
// SHADER: periodic noise library
// ---------------------------------------------------------------------------------------------

const NOISE = /* glsl */`
// ---- wrapping ---------------------------------------------------------------------------
// The one function that makes everything tileable: fold the lattice cell back into [0, per).
vec2 wrap2(vec2 i, vec2 per) { return mod(mod(i, per) + per, per); }

// ---- hashes (Hoskins-style, seeded) -----------------------------------------------------
float hash11(float p) {
  p = fract((p + uSeed) * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3((p + uSeed).xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3((p + uSeed).xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec3 hash32(vec2 p) {
  vec3 p3 = fract(vec3((p + uSeed).xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

// ---- value noise ------------------------------------------------------------------------
float vnoise(vec2 p, vec2 per) {
  vec2 i = floor(p), f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash12(wrap2(i, per));
  float b = hash12(wrap2(i + vec2(1.0, 0.0), per));
  float c = hash12(wrap2(i + vec2(0.0, 1.0), per));
  float d = hash12(wrap2(i + vec2(1.0, 1.0), per));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// ---- gradient ("simplex-ish") noise ------------------------------------------------------
vec2 grad2(vec2 c) {
  vec2 h = hash22(c) * 2.0 - 1.0;
  return h * inversesqrt(max(dot(h, h), 1e-5));
}
float gnoise(vec2 p, vec2 per) {
  vec2 i = floor(p), f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(grad2(wrap2(i, per)), f);
  float b = dot(grad2(wrap2(i + vec2(1.0, 0.0), per)), f - vec2(1.0, 0.0));
  float c = dot(grad2(wrap2(i + vec2(0.0, 1.0), per)), f - vec2(0.0, 1.0));
  float d = dot(grad2(wrap2(i + vec2(1.0, 1.0), per)), f - vec2(1.0, 1.0));
  return clamp(0.5 + 0.72 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y), 0.0, 1.0);
}

// ---- fbm / ridged -------------------------------------------------------------------------
// Lacunarity is fixed at 2.0 so 'per' doubles with the frequency and stays an integer.
// (No backticks in GLSL comments -- this whole block is a JS template literal.)
float fbm(vec2 p, vec2 per, int oct, float gain) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * gnoise(p, per);
    n += a;
    a *= gain;
    p *= 2.0;
    per *= 2.0;
  }
  return s / max(n, 1e-5);
}
float fbmv(vec2 p, vec2 per, int oct, float gain) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * vnoise(p, per);
    n += a;
    a *= gain;
    p *= 2.0;
    per *= 2.0;
  }
  return s / max(n, 1e-5);
}
float ridged(vec2 p, vec2 per, int oct) {
  float a = 0.5, s = 0.0, n = 0.0, prev = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    float v = 1.0 - abs(gnoise(p, per) * 2.0 - 1.0);
    v *= v;
    v *= prev;
    prev = clamp(v * 1.9, 0.0, 1.0);
    s += a * v;
    n += a;
    a *= 0.5;
    p *= 2.0;
    per *= 2.0;
  }
  return s / max(n, 1e-5);
}

// ---- worley / cellular --------------------------------------------------------------------
struct Cell {
  float f1;    // distance to nearest feature
  float f2;    // distance to second nearest (f2 - f1 == cell border)
  float id;    // per-cell random 0..1
  float id2;   // a second decorrelated per-cell random
  vec2  off;   // vector from the sample TO the feature point
  vec2  cell;  // wrapped cell coordinate, safe to hash
};
Cell worley(vec2 p, vec2 per, float jitter) {
  vec2 ip = floor(p), fp = p - ip;
  Cell o;
  o.f1 = 8.0; o.f2 = 8.0; o.id = 0.0; o.id2 = 0.0; o.off = vec2(0.0); o.cell = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 cell = wrap2(ip + g, per);
      vec2 j = hash22(cell);
      vec2 r = g + (0.5 + (j - 0.5) * jitter) - fp;
      float d = dot(r, r);
      if (d < o.f1) {
        o.f2 = o.f1; o.f1 = d;
        o.off = r; o.cell = cell;
      } else if (d < o.f2) {
        o.f2 = d;
      }
    }
  }
  o.f1 = sqrt(o.f1);
  o.f2 = sqrt(o.f2);
  o.id = hash12(o.cell * 1.37 + 4.1);
  o.id2 = hash12(o.cell * 2.71 + 91.7);
  return o;
}

// ---- oriented segment field ----------------------------------------------------------------
// One short line segment per cell.  Used for pine needles, twigs, scratches, boot scuffs,
// lenticels -- anything whose silhouette is a stroke rather than a blob.  Segment half-length
// must stay <= 0.5 cell so the 3x3 search is conservative.
struct Seg { float d; float id; float t; float ang; };
Seg segField(vec2 p, vec2 per, float len, float bias, float spread) {
  vec2 ip = floor(p), fp = p - ip;
  Seg o;
  o.d = 1e9; o.id = 0.0; o.t = 0.0; o.ang = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 cell = wrap2(ip + g, per);
      vec3 h = hash32(cell);
      float ang = bias + (h.z * 2.0 - 1.0) * spread;
      vec2 dir = vec2(cos(ang), sin(ang));
      vec2 q = fp - (g + h.xy);
      float t = clamp(dot(q, dir), -len, len);
      float d = length(q - dir * t);
      if (d < o.d) {
        o.d = d;
        o.id = hash12(cell * 3.11 + 13.7);
        o.t = t / max(len, 1e-4);
        o.ang = ang;
      }
    }
  }
  return o;
}

// ---- domain warp ---------------------------------------------------------------------------
// Returns warped UVs.  The displacement field is itself period-1, so tiling survives.
vec2 warp(vec2 uv, vec2 s, float amt, int oct) {
  float a = fbm(uv * s + vec2(1.7, 9.2), s, oct, 0.5);
  float b = fbm(uv * s + vec2(8.3, 2.8), s, oct, 0.5);
  return uv + amt * (vec2(a, b) - 0.5) * 2.0;
}
`;

// ---------------------------------------------------------------------------------------------
// SHADER: material interface + main
// ---------------------------------------------------------------------------------------------

const DECLS = /* glsl */`
struct Surf { vec3 albedo; float rough; float metal; float ao; };
float H(vec2 uv);
Surf  S(vec2 uv, float h, float ao, vec3 n);
// Opacity, for alpha-to-coverage cards (foliage, fern, dirty glass).  Sets that declare
// { alpha: true } get HAS_ALPHA and must define A(); everything else is solid.
#ifdef HAS_ALPHA
float A(vec2 uv, float h);
#else
float A(vec2 uv, float h) { return 1.0; }
#endif
`;

const MAIN = /* glsl */`
void main() {
  vec2 uv = vUv;
  vec2 e = 1.0 / uRes;

  float h = H(uv);

  // ---- half-resolution displacement pass: red channel only, skip everything expensive.
  if (uHeightOnly > 0.5) {
    oAlbedo = vec4(h, h, h, 1.0);
    oNormal = vec4(0.0);
    oORM = vec4(0.0);
    return;
  }

  // ---- central differences on the HEIGHT FUNCTION (never on luminance).
  float hL = H(uv - vec2(e.x, 0.0));
  float hR = H(uv + vec2(e.x, 0.0));
  float hD = H(uv - vec2(0.0, e.y));
  float hU = H(uv + vec2(0.0, e.y));

  // n = normalize(-dh/du, -dh/dv, 1) with the 1/(2e) folded into z so the result is
  // resolution independent: uNormalStrength is literally relief_metres / tile_metres.
  vec3 n = normalize(vec3((hL - hR) * uNormalStrength,
                          (hD - hU) * uNormalStrength,
                          2.0 * e.x));

  // ---- multi-radius horizon occlusion over the same height field.
  float occ = 0.0;
  for (int i = 0; i < AO_TAPS; i++) {
    float a = float(i) * (TAU / float(AO_TAPS)) + 0.37;
    float r = 3.0 + float(i) * 4.0;
    vec2 d = vec2(cos(a), sin(a)) * e * r;
    float hs = H(uv + d);
    occ += clamp((hs - h) * uNormalStrength / (r * e.x), 0.0, 4.0);
  }
  occ /= float(AO_TAPS);
  float ao = clamp(1.0 - uAOStrength * (occ / (1.0 + occ)), 0.0, 1.0);
  float cav = clamp(1.0 - h, 0.0, 1.0);
  // Broad recesses darken too, not just the sharp edges the horizon taps can see.
  ao *= mix(1.0, smoothstep(-0.20, 0.80, h), uCavity);
  ao = clamp(ao, 0.0, 1.0);

  Surf s = S(uv, h, ao, n);

  // Toksvig-ish: sub-texel slope variance becomes roughness, so mipping the micro detail
  // costs gloss instead of costing relief.  Granite still sparkles at 20 m because of this.
  float sv = (abs(hL - hR) + abs(hD - hU)) * uNormalStrength / (2.0 * e.x);
  s.rough = clamp(sqrt(s.rough * s.rough + uToksvig * sv * sv), 0.02, 1.0);

  // 1/255 triangular dither on the normal so smooth relief does not band in RGBA8.
  float dth = (hash12(gl_FragCoord.xy * 0.7371) - 0.5) / 255.0;

  oAlbedo = vec4(clamp(s.albedo, 0.0, 1.0), clamp(A(uv, h), 0.0, 1.0));
  oNormal = vec4(clamp(n * 0.5 + 0.5 + dth, 0.0, 1.0), h);
  oORM    = vec4(clamp(s.ao, 0.0, 1.0), s.rough, clamp(s.metal, 0.0, 1.0), cav);
}
`;

// ---------------------------------------------------------------------------------------------
// MATERIALS
// Each defines  float H(vec2 uv)  (the height field, 0..1) and
//               Surf  S(vec2 uv, float h, float ao, vec3 n)  (albedo / roughness / metalness).
// H() is called 5 + AO_TAPS times per texel, so keep it lean; S() is called once, so it can be
// generous.  Wherever possible S() derives colour from `h` -- that guarantees the albedo is
// registered to the relief instead of merely correlated with it.
// ---------------------------------------------------------------------------------------------

const M = {};

// --- bark, pine ------------------------------------------------------------------------------
// Deep vertical furrows (ridged, stretched 4:1 along V), worley plates whose borders are the
// cracks, fibre bundles, micro grain, and moss pads that only grow in the fissures.
M['bark-pine'] = /* glsl */`
float H(vec2 uv) {
  // Warp mostly in U: the furrows must meander sideways but stay VERTICAL.
  vec2 w = uv + vec2(0.030, 0.006) * (vec2(
      fbm(uv * vec2(3.0, 1.0) + 1.7, vec2(3.0, 1.0), 3, 0.55),
      fbm(uv * vec2(2.0, 2.0) + 8.3, vec2(2.0, 2.0), 3, 0.55)) - 0.5) * 2.0;
  // Macro furrows: ridged, 7:1 vertical stretch.  This is the dominant read at 3 m.
  float furrow = ridged(w * vec2(21.0, 3.0), vec2(21.0, 3.0), 5);
  // Plates between the furrows: worley cells 6x taller than wide, narrow crack borders.
  Cell c = worley(w * vec2(12.0, 2.0), vec2(12.0, 2.0), 0.85);
  float crack = smoothstep(0.0, 0.085, c.f2 - c.f1);          // 0 inside the crack
  float plate = crack * (0.62 + 0.60 * c.id);                 // plates differ in thickness
  float fibre = fbm(w * vec2(64.0, 9.0), vec2(64.0, 9.0), 4, 0.5);
  float grain = fbm(uv * vec2(300.0, 48.0), vec2(300.0, 48.0), 2, 0.5);
  float h = furrow * 0.56 + plate * 0.20 + fibre * 0.16 + grain * 0.05;
  float mossN = fbm(uv * vec2(6.0, 6.0), vec2(6.0, 6.0), 4, 0.55);
  float moss = smoothstep(0.50, 0.76, mossN) * (1.0 - smoothstep(0.26, 0.60, h));
  h += moss * 0.11 * (0.55 + 0.45 * fbm(uv * vec2(140.0, 140.0), vec2(140.0, 140.0), 2, 0.5));
  return clamp(h, 0.0, 1.0);
}
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  vec3 deep = C3(15.0, 13.0, 11.0);      // fissure floor, below bark.wet #15120f
  vec3 mid  = C3(38.0, 33.0, 28.0);      // bark.dry #38312a
  vec3 crest= C3(78.0, 70.0, 60.0);      // moonlit plate crest -- the only bright bark tone
  vec3 alb = mix(deep, mid, smoothstep(0.02, 0.44, h));
  alb = mix(alb, crest, smoothstep(0.58, 0.98, h));
  // low frequency: whole regions of trunk are darker where rain tracks down
  float stain = fbm(uv * vec2(3.0, 2.0), vec2(3.0, 2.0), 4, 0.6);
  float rainTrack = fbm(uv * vec2(14.0, 2.0), vec2(14.0, 2.0), 3, 0.6);
  alb *= mix(0.68, 1.14, stain) * mix(0.86, 1.06, rainTrack);
  // resin bleed: rare, slightly warm-dark, <2% coverage
  Cell rz = worley(uv * vec2(5.0, 3.0), vec2(5.0, 3.0), 1.0);
  float resin = step(0.93, rz.id) * (1.0 - smoothstep(0.0, 0.30, rz.f1));
  alb = mix(alb, C3(58.0, 42.0, 28.0), resin * 0.8);
  // moss (blue-green to yellow-green, saturation kept under the 0.35 ceiling)
  float mossN = fbm(uv * vec2(6.0, 6.0), vec2(6.0, 6.0), 4, 0.55);
  float moss = smoothstep(0.50, 0.76, mossN) * (1.0 - smoothstep(0.26, 0.60, h));
  vec3 mossCol = mix(C3(29.0, 43.0, 28.0), C3(45.0, 52.0, 30.0),
                     fbm(uv * vec2(30.0, 30.0), vec2(30.0, 30.0), 3, 0.5));
  alb = mix(alb, mossCol, clamp(moss * 1.35, 0.0, 1.0));
  o.albedo = alb * (0.62 + 0.38 * ao);
  o.rough = mix(0.94, 0.74, smoothstep(0.30, 0.92, h));
  o.rough = mix(o.rough, 0.88, clamp(moss * 1.35, 0.0, 1.0));
  o.rough = mix(o.rough, 0.30, resin * 0.8);
  o.metal = 0.0;
  o.ao = ao;
  return o;
}
`;

// --- bark, birch -----------------------------------------------------------------------------
// Papery horizontal striation, dark lenticel dashes, peeling curls with a raised lip.
// ART_DIRECTION: 6% of trees only -- this is compositional punctuation, the one bright vertical.
M['bark-birch'] = /* glsl */`
float H(vec2 uv) {
  vec2 w = warp(uv, vec2(3.0, 3.0), 0.018, 3);
  float band = fbm(w * vec2(2.0, 40.0), vec2(2.0, 40.0), 4, 0.5);
  Seg l = segField(w * vec2(14.0, 22.0), vec2(14.0, 22.0), 0.40, 0.0, 0.10);
  float lent = (1.0 - smoothstep(0.02, 0.13, l.d)) * step(0.55, l.id);
  float peelN = fbm(uv * vec2(4.0, 7.0), vec2(4.0, 7.0), 3, 0.6);
  float peel = smoothstep(0.58, 0.84, peelN);
  float lip = smoothstep(0.76, 0.85, peelN) * (1.0 - smoothstep(0.85, 0.94, peelN));
  float grain = fbm(uv * vec2(180.0, 320.0), vec2(180.0, 320.0), 2, 0.5);
  float h = 0.54 + (band - 0.5) * 0.26 + peel * 0.09 + lip * 0.26 - lent * 0.17 + (grain - 0.5) * 0.07;
  return clamp(h, 0.0, 1.0);
}
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  vec3 paper = C3(185.0, 182.0, 166.0);  // bark.birch #b9b6a6
  vec3 shade = C3(126.0, 123.0, 112.0);
  vec3 dark  = C3(36.0, 31.0, 27.0);
  float band = fbm(uv * vec2(2.0, 40.0), vec2(2.0, 40.0), 4, 0.5);
  vec3 alb = mix(shade, paper, smoothstep(0.30, 0.78, h));
  alb *= mix(0.88, 1.06, band);
  // large soot/algae zoning -- birch is never uniformly white
  float zone = fbm(uv * vec2(2.0, 2.0), vec2(2.0, 2.0), 4, 0.62);
  alb = mix(alb, C3(88.0, 86.0, 78.0), smoothstep(0.52, 0.86, zone) * 0.7);
  // lenticels
  Seg l = segField(warp(uv, vec2(3.0, 3.0), 0.018, 3) * vec2(14.0, 22.0), vec2(14.0, 22.0), 0.40, 0.0, 0.10);
  float lent = (1.0 - smoothstep(0.03, 0.12, l.d)) * step(0.55, l.id);
  alb = mix(alb, dark, clamp(lent * 1.2, 0.0, 1.0));
  // base of the trunk goes charcoal
  float grime = fbm(uv * vec2(9.0, 3.0), vec2(9.0, 3.0), 4, 0.55);
  alb = mix(alb, C3(48.0, 46.0, 42.0), smoothstep(0.62, 0.92, grime) * 0.55);
  o.albedo = alb * (0.66 + 0.34 * ao);
  o.rough = mix(0.72, 0.52, smoothstep(0.35, 0.85, h));   // paper is slightly satin
  o.rough = mix(o.rough, 0.86, lent);
  o.metal = 0.0;
  o.ao = ao;
  return o;
}
`;

// --- forest floor: pine needles ---------------------------------------------------------------
// Two crossed needle layers (a dominant drift direction plus a finer cross-lay), sparse twigs,
// dark humus underneath, patchy moss.  The segment field is what makes it read as *strokes*
// rather than as noise.
M['pine-needles'] = /* glsl */`
float H(vec2 uv) {
  float humus = fbm(uv * vec2(6.0, 6.0), vec2(6.0, 6.0), 5, 0.55);
  float h = humus * 0.34;
  Seg a = segField(uv * vec2(26.0, 26.0), vec2(26.0, 26.0), 0.46, 0.62, 0.50);
  h += (1.0 - smoothstep(0.014, 0.052, a.d)) * (0.24 + 0.12 * a.id);
  Seg b = segField(uv * vec2(38.0, 38.0) + 11.0, vec2(38.0, 38.0), 0.44, -0.95, 0.62);
  h += (1.0 - smoothstep(0.011, 0.044, b.d)) * (0.17 + 0.10 * b.id);
  Seg t = segField(uv * vec2(7.0, 7.0) + 3.0, vec2(7.0, 7.0), 0.48, 1.90, 1.25);
  h += (1.0 - smoothstep(0.020, 0.056, t.d)) * step(0.74, t.id) * 0.34;
  float mos = smoothstep(0.58, 0.80, fbm(uv * vec2(4.0, 4.0) + 5.0, vec2(4.0, 4.0), 4, 0.6));
  h += mos * 0.13 * fbm(uv * vec2(120.0, 120.0), vec2(120.0, 120.0), 2, 0.5);
  h += (fbm(uv * vec2(200.0, 200.0), vec2(200.0, 200.0), 2, 0.5) - 0.5) * 0.06;
  return clamp(h, 0.0, 1.0);
}
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  vec3 humusCol = C3(26.0, 21.0, 16.0);          // near-black rotted duff
  vec3 needleWet = C3(38.0, 34.0, 25.0);
  vec3 needleDry = C3(74.0, 68.0, 51.0);         // foliage.dead #4a4433
  vec3 twigCol = C3(52.0, 45.0, 36.0);
  Seg a = segField(uv * vec2(26.0, 26.0), vec2(26.0, 26.0), 0.46, 0.62, 0.50);
  float na = 1.0 - smoothstep(0.014, 0.052, a.d);
  Seg b = segField(uv * vec2(38.0, 38.0) + 11.0, vec2(38.0, 38.0), 0.44, -0.95, 0.62);
  float nb = 1.0 - smoothstep(0.011, 0.044, b.d);
  Seg t = segField(uv * vec2(7.0, 7.0) + 3.0, vec2(7.0, 7.0), 0.48, 1.90, 1.25);
  float tw = (1.0 - smoothstep(0.020, 0.056, t.d)) * step(0.74, t.id);
  // low frequency: wet patches and dry sheltered patches -- ART_DIRECTION trap 5
  float damp = fbm(uv * vec2(2.0, 2.0), vec2(2.0, 2.0), 4, 0.62);
  vec3 alb = humusCol * mix(1.15, 0.62, damp);
  vec3 needle = mix(needleWet, needleDry, a.id);
  alb = mix(alb, needle * mix(1.1, 0.66, damp), clamp(na * 1.15, 0.0, 1.0));
  alb = mix(alb, mix(needleWet, needleDry, b.id) * mix(1.05, 0.62, damp), clamp(nb * 0.9, 0.0, 1.0));
  alb = mix(alb, twigCol * mix(1.0, 0.6, damp), tw);
  float mos = smoothstep(0.58, 0.80, fbm(uv * vec2(4.0, 4.0) + 5.0, vec2(4.0, 4.0), 4, 0.6));
  vec3 mossCol = mix(C3(29.0, 43.0, 28.0), C3(27.0, 42.0, 38.0),
                     fbm(uv * vec2(9.0, 9.0), vec2(9.0, 9.0), 3, 0.5));
  alb = mix(alb, mossCol, mos * 0.85);
  o.albedo = alb * (0.50 + 0.50 * ao);
  o.rough = mix(0.80, 0.58, clamp(na + nb, 0.0, 1.0));   // needles are waxy
  o.rough = mix(o.rough, 0.74, mos);
  o.rough = mix(o.rough, 0.34, smoothstep(0.55, 0.95, damp) * (1.0 - h));  // wet low spots
  o.metal = 0.0;
  o.ao = ao;
  return o;
}
`;

// --- wet earth / packed mud ---------------------------------------------------------------
// Packed soil with two grades of embedded pebble (real hemisphere domes, not bumps), boot
// scuffs gouged across it, and standing water in the low spots -- roughness 0.05 there, which
// is the surface that gives the frame its sub-0.10 roughness entry (ART_DIRECTION trap 19).
M['wet-earth'] = /* glsl */`
float H(vec2 uv) {
  vec2 w = warp(uv, vec2(3.0, 3.0), 0.024, 3);
  float base = fbm(w * vec2(5.0, 5.0), vec2(5.0, 5.0), 6, 0.55);
  // clods: the compacted-soil lumps that give mud its 10 cm read
  float clod = ridged(w * vec2(11.0, 11.0), vec2(11.0, 11.0), 4);
  float h = 0.10 + base * 0.40 + clod * 0.20;
  // Sparse, size-varied, mostly-buried pebbles.  Density matters more than anything else here:
  // a dense uniform field reads as polka dots, which is the classic procedural tell.
  Cell p1 = worley(w * vec2(18.0, 18.0), vec2(18.0, 18.0), 0.95);
  float rad = 0.13 + 0.26 * p1.id2 * p1.id2;
  h += sqrt(max(0.0, rad * rad - p1.f1 * p1.f1)) * 0.75 * step(0.74, p1.id);
  Cell p2 = worley(w * vec2(52.0, 52.0), vec2(52.0, 52.0), 1.0);
  h += sqrt(max(0.0, 0.0144 - p2.f1 * p2.f1)) * 0.60 * step(0.84, p2.id);
  Seg sc = segField(uv * vec2(9.0, 9.0) + 5.0, vec2(9.0, 9.0), 0.45, 0.35, 1.40);
  h -= (1.0 - smoothstep(0.03, 0.14, sc.d)) * step(0.62, sc.id) * 0.17;
  h += (fbm(uv * vec2(150.0, 150.0), vec2(150.0, 150.0), 3, 0.5) - 0.5) * 0.08;
  return clamp(h, 0.0, 1.0);
}
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  vec3 mud   = C3(42.0, 34.0, 27.0);   // mat.mud #2a221b
  vec3 mudWet= C3(22.0, 18.0, 14.0);
  vec3 dust  = C3(74.0, 64.0, 52.0);
  vec3 water = C3(11.0, 23.0, 28.0);   // water.body #0b171c
  float zone = fbm(uv * vec2(2.0, 2.0), vec2(2.0, 2.0), 5, 0.6);       // low freq wet/dry
  vec3 alb = mix(mudWet, mud, smoothstep(0.18, 0.62, h));
  alb = mix(alb, dust, smoothstep(0.72, 0.98, h) * (1.0 - zone) * 0.8);
  alb *= mix(0.70, 1.16, zone);
  // pebbles read as cool grey stone, but half-buried and mud-smeared -- never clean discs
  vec2 w = warp(uv, vec2(3.0, 3.0), 0.024, 3);
  Cell p1 = worley(w * vec2(18.0, 18.0), vec2(18.0, 18.0), 0.95);
  float rad = 0.13 + 0.26 * p1.id2 * p1.id2;
  float peb = step(0.74, p1.id) * smoothstep(rad, rad * 0.45, p1.f1);
  vec3 pebCol = mix(C3(44.0, 47.0, 48.0), C3(78.0, 80.0, 79.0), p1.id2);
  pebCol *= 0.72 + 0.42 * fbm(uv * vec2(120.0, 120.0), vec2(120.0, 120.0), 3, 0.5);
  alb = mix(alb, pebCol * mix(0.66, 0.94, zone), peb * 0.72);
  // standing water: the ART_DIRECTION §5.1 puddle op, baked as the material's rest state
  float pud = smoothstep(0.34, 0.14, h) * smoothstep(0.42, 0.75, zone);
  alb = mix(alb, water, pud);
  o.albedo = alb * (0.55 + 0.45 * ao);
  o.rough = mix(0.86, 0.62, smoothstep(0.2, 0.9, h));
  o.rough = mix(o.rough, 0.42, peb);
  o.rough = mix(o.rough, 0.05, pud);
  o.metal = 0.0;
  o.ao = mix(ao, ao * 0.85, pud);
  return o;
}
`;

// --- moss ------------------------------------------------------------------------------------
// Clumped at three scales so the silhouette never repeats, with the colour drifting from
// yellow-green to blue-green across metres.  Saturation is held under 0.35 (forbidden band).
M['moss'] = /* glsl */`
float H(vec2 uv) {
  vec2 w = warp(uv, vec2(4.0, 4.0), 0.035, 3);
  Cell c1 = worley(w * vec2(7.0, 7.0), vec2(7.0, 7.0), 1.0);
  Cell c2 = worley(w * vec2(19.0, 19.0), vec2(19.0, 19.0), 1.0);
  Cell c3 = worley(w * vec2(52.0, 52.0), vec2(52.0, 52.0), 1.0);
  float clump = smoothstep(0.62, 0.02, c1.f1) * (0.55 + 0.45 * c1.id);
  clump += smoothstep(0.42, 0.02, c2.f1) * 0.42 * (0.4 + 0.6 * c2.id);
  clump += smoothstep(0.34, 0.04, c3.f1) * 0.20;
  float fuzz = fbm(uv * vec2(150.0, 150.0), vec2(150.0, 150.0), 3, 0.55);
  float h = clump * 0.55 + fbm(w * vec2(3.0, 3.0), vec2(3.0, 3.0), 4, 0.6) * 0.22 + fuzz * 0.14;
  return clamp(h, 0.0, 1.0);
}
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  vec3 blueGreen = C3(27.0, 42.0, 38.0);
  vec3 base      = C3(29.0, 43.0, 28.0);   // #1d2b1c
  vec3 yellow    = C3(51.0, 58.0, 32.0);
  vec3 dead      = C3(58.0, 52.0, 38.0);
  float zone = fbm(uv * vec2(2.0, 2.0), vec2(2.0, 2.0), 4, 0.62);
  vec3 alb = mix(blueGreen, yellow, smoothstep(0.30, 0.78, zone));
  alb = mix(alb, base, 0.42);
  // tips catch the light, the mat under the clumps is nearly black
  alb *= mix(0.34, 1.32, smoothstep(0.10, 0.92, h));
  float deadPatch = smoothstep(0.72, 0.92, fbm(uv * vec2(6.0, 6.0) + 7.0, vec2(6.0, 6.0), 4, 0.55));
  alb = mix(alb, dead, deadPatch * 0.6);
  o.albedo = alb * (0.42 + 0.58 * ao);
  o.rough = mix(0.86, 0.66, smoothstep(0.2, 0.95, h));   // ART_DIRECTION: moss 0.72 nominal
  o.metal = 0.0;
  o.ao = ao;
  return o;
}
`;

// --- granite ---------------------------------------------------------------------------------
// Three-mineral speckle at two grain scales (feldspar #6a7176 / quartz #8a929a /
// biotite #191d20), warped ridged fracture grooves, lichen pads.  uToksvig is high here: this
// is the material ART_DIRECTION calls out for surviving at 20 m without mipping to grey mush.
M['granite'] = /* glsl */`
float H(vec2 uv) {
  vec2 w = warp(uv, vec2(2.0, 2.0), 0.030, 3);
  float frac = ridged(w * vec2(4.0, 4.0), vec2(4.0, 4.0), 4);
  float groove = smoothstep(0.70, 0.99, frac);
  Cell g1 = worley(uv * vec2(90.0, 90.0), vec2(90.0, 90.0), 1.0);
  Cell g2 = worley(uv * vec2(240.0, 240.0), vec2(240.0, 240.0), 1.0);
  float h = 0.56 + (fbm(uv * vec2(8.0, 8.0), vec2(8.0, 8.0), 5, 0.55) - 0.5) * 0.30;
  h += (g1.id - 0.5) * 0.13 * smoothstep(0.0, 0.22, g1.f2 - g1.f1);
  h += (g2.id - 0.5) * 0.06;
  h -= groove * 0.32;
  float lich = smoothstep(0.62, 0.84, fbm(uv * vec2(5.0, 5.0) + 7.0, vec2(5.0, 5.0), 4, 0.6));
  h += lich * 0.05 * fbm(uv * vec2(90.0, 90.0), vec2(90.0, 90.0), 2, 0.5);
  return clamp(h, 0.0, 1.0);
}
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  vec3 feldspar = C3(106.0, 113.0, 118.0);
  vec3 quartz   = C3(138.0, 146.0, 154.0);
  vec3 biotite  = C3(25.0, 29.0, 32.0);
  Cell g1 = worley(uv * vec2(90.0, 90.0), vec2(90.0, 90.0), 1.0);
  Cell g2 = worley(uv * vec2(240.0, 240.0), vec2(240.0, 240.0), 1.0);
  // coarse phenocrysts pick the mineral, fine grain modulates it
  float m = g1.id;
  vec3 alb = feldspar;
  float rough = 0.55;
  if (m < 0.20) { alb = biotite; rough = 0.72; }
  else if (m > 0.78) { alb = quartz; rough = 0.32; }
  float fine = g2.id2;
  alb *= 0.86 + 0.30 * fine;
  if (g2.id < 0.13) { alb = mix(alb, biotite, 0.75); rough = mix(rough, 0.74, 0.75); }
  else if (g2.id > 0.90) { alb = mix(alb, quartz, 0.6); rough = mix(rough, 0.30, 0.6); }
  // low frequency zoning + iron staining (the ONLY warm hue allowed in nature, desaturated)
  float zone = fbm(uv * vec2(3.0, 3.0), vec2(3.0, 3.0), 5, 0.6);
  alb *= mix(0.66, 1.10, zone);
  float iron = smoothstep(0.80, 0.96, fbm(uv * vec2(6.0, 4.0) + 21.0, vec2(6.0, 4.0), 4, 0.6));
  alb = mix(alb, C3(84.0, 66.0, 50.0), iron * 0.35);
  // fracture grooves hold grit
  vec2 w = warp(uv, vec2(2.0, 2.0), 0.030, 3);
  float groove = smoothstep(0.70, 0.99, ridged(w * vec2(4.0, 4.0), vec2(4.0, 4.0), 4));
  alb = mix(alb, C3(22.0, 26.0, 28.0), groove * 0.85);
  rough = mix(rough, 0.88, groove);
  // lichen -- grey-green pads, the most matte thing on the rock
  float lich = smoothstep(0.62, 0.84, fbm(uv * vec2(5.0, 5.0) + 7.0, vec2(5.0, 5.0), 4, 0.6));
  float lichEdge = lich * (0.55 + 0.45 * fbm(uv * vec2(60.0, 60.0), vec2(60.0, 60.0), 3, 0.5));
  alb = mix(alb, C3(122.0, 130.0, 116.0), lichEdge * 0.82);
  rough = mix(rough, 0.92, lichEdge * 0.82);
  o.albedo = alb * (0.60 + 0.40 * ao);
  o.rough = rough;
  o.metal = 0.0;
  o.ao = ao;
  return o;
}
`;

// --- sawn lumber (fresh cut) --------------------------------------------------------------
// Cathedral growth rings from a wandering arc distance field, knots that bend the rings around
// them, and saw-kerf grooves running ACROSS the grain at an integer wave vector (which is what
// keeps them tileable).  ART_DIRECTION §5.3: this is the brightest large surface in the game.
M['sawn-lumber'] = /* glsl */`
float ringField(vec2 uv, out float knotM, out float knotR) {
  // arc(uv.x) is period-1, so |uv.y - arc| tiles in both axes.
  float arc = 0.5
            + 0.20 * sin(uv.x * TAU)
            + 0.07 * sin(uv.x * TAU * 2.0 + 1.1)
            + 0.09 * (fbm(uv * vec2(3.0, 1.0), vec2(3.0, 1.0), 3, 0.6) - 0.5);
  float d = abs(uv.y - arc);
  Cell k = worley(uv * vec2(3.0, 3.0), vec2(3.0, 3.0), 0.9);
  knotM = step(0.82, k.id) * exp(-k.f1 * k.f1 * 30.0);
  knotR = k.f1;
  d = d * (1.0 - 0.72 * knotM) + knotM * k.f1 * 0.55;
  return d;
}
float H(vec2 uv) {
  float knotM, knotR;
  float d = ringField(uv, knotM, knotR);
  float rings = fract(d * 26.0 + (fbm(uv * vec2(6.0, 6.0), vec2(6.0, 6.0), 3, 0.5) - 0.5) * 0.8);
  float late = smoothstep(0.40, 0.60, rings) * (1.0 - smoothstep(0.70, 0.92, rings));
  // saw kerf: two beating frequencies == blade chatter
  float chat = (fbm(uv * vec2(8.0, 8.0), vec2(8.0, 8.0), 2, 0.5) - 0.5) * 0.06;
  float k1 = 0.5 + 0.5 * cos(TAU * (dot(uv, vec2(2.0, 34.0)) + chat));
  float k2 = 0.5 + 0.5 * cos(TAU * (dot(uv, vec2(3.0, 41.0)) - chat));
  float kerf = k1 * 0.7 + k2 * 0.3;
  float fibre = fbm(uv * vec2(140.0, 22.0), vec2(140.0, 22.0), 3, 0.5);
  float h = 0.58 + late * 0.13 - kerf * 0.07 + (fibre - 0.5) * 0.09;
  h += knotM * 0.06;
  return clamp(h, 0.0, 1.0);
}
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  vec3 early = C3(168.0, 135.0, 92.0);   // mat.lumber #a8875c -- +0.55 stops, the hero tone
  vec3 late  = C3(138.0, 106.0, 66.0);
  vec3 knotC = C3(72.0, 52.0, 33.0);
  float knotM, knotR;
  float d = ringField(uv, knotM, knotR);
  float rings = fract(d * 26.0 + (fbm(uv * vec2(6.0, 6.0), vec2(6.0, 6.0), 3, 0.5) - 0.5) * 0.8);
  float lateM = smoothstep(0.38, 0.62, rings) * (1.0 - smoothstep(0.68, 0.94, rings));
  vec3 alb = mix(early, late, lateM);
  // fine ray fleck along the grain -- what makes pine look like pine at 20 cm
  float fleck = fbm(uv * vec2(220.0, 14.0), vec2(220.0, 14.0), 3, 0.5);
  alb *= 0.90 + 0.20 * fleck;
  // low frequency board tone; the mill does not cut two boards the same colour
  alb *= mix(0.88, 1.10, fbm(uv * vec2(2.0, 1.0), vec2(2.0, 1.0), 3, 0.6));
  // knot: dark core, resin ring, and the rings crowding into it
  alb = mix(alb, knotC, smoothstep(0.25, 0.85, knotM));
  alb = mix(alb, C3(46.0, 32.0, 20.0), smoothstep(0.72, 1.0, knotM));
  // freshly-cut kerf tops are paler than the valleys (torn fibre scatters more)
  float kerfTop = smoothstep(0.55, 0.85, h);
  alb *= mix(0.94, 1.06, kerfTop);
  o.albedo = alb * (0.72 + 0.28 * ao);
  // anisotropy stand-in: the kerf valleys stay rougher than the crests, so a raking lantern
  // pulls a directional highlight along the cut (ART_DIRECTION shot 9).
  o.rough = mix(0.82, 0.58, kerfTop);
  o.rough = mix(o.rough, 0.46, smoothstep(0.4, 0.95, knotM));   // resin in the knot
  o.metal = 0.0;
  o.ao = ao;
  return o;
}
`;

// --- weathered plank --------------------------------------------------------------------------
// Silvered grey, earlywood eroded away so the latewood stands proud (raised grain), long
// checks split along the grain, and nail holes bleeding a rust streak downhill.
M['weathered-wood'] = /* glsl */`
float H(vec2 uv) {
  float wob = (fbm(uv * vec2(4.0, 1.0), vec2(4.0, 1.0), 3, 0.6) - 0.5) * 0.10;
  float rings = fract((uv.y + wob) * 22.0);
  float late = smoothstep(0.36, 0.56, rings) * (1.0 - smoothstep(0.66, 0.90, rings));
  float h = 0.46 + late * 0.30;                       // raised grain
  // checks: long thin splits ALONG the grain (bias 0 == horizontal in uv)
  Seg ck = segField(uv * vec2(6.0, 12.0) + 2.0, vec2(6.0, 12.0), 0.48, 0.0, 0.16);
  h -= (1.0 - smoothstep(0.006, 0.030, ck.d)) * step(0.48, ck.id) * 0.42;
  // nail holes
  Cell nl = worley(uv * vec2(4.0, 4.0) + 9.0, vec2(4.0, 4.0), 0.7);
  float nail = step(0.86, nl.id) * (1.0 - smoothstep(0.0, 0.055, nl.f1));
  h -= nail * 0.45;
  h += (fbm(uv * vec2(180.0, 40.0), vec2(180.0, 40.0), 3, 0.5) - 0.5) * 0.10;
  h += (fbm(uv * vec2(3.0, 3.0), vec2(3.0, 3.0), 4, 0.6) - 0.5) * 0.14;   // cupping
  return clamp(h, 0.0, 1.0);
}
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  vec3 silver = C3(138.0, 133.0, 122.0);
  vec3 grey   = C3(107.0, 97.0, 85.0);    // #6b6155
  vec3 dark   = C3(38.0, 34.0, 29.0);
  vec3 rust   = C3(122.0, 69.0, 38.0);    // mat.rust #7a4526, <=8% coverage
  float wob = (fbm(uv * vec2(4.0, 1.0), vec2(4.0, 1.0), 3, 0.6) - 0.5) * 0.10;
  float rings = fract((uv.y + wob) * 22.0);
  float lateM = smoothstep(0.36, 0.56, rings) * (1.0 - smoothstep(0.66, 0.90, rings));
  vec3 alb = mix(grey, silver, lateM * smoothstep(0.35, 0.9, h));
  alb *= mix(0.72, 1.12, fbm(uv * vec2(2.0, 2.0), vec2(2.0, 2.0), 4, 0.62));
  // algae/damp in the shadowed half
  float algae = smoothstep(0.62, 0.88, fbm(uv * vec2(3.0, 3.0) + 13.0, vec2(3.0, 3.0), 4, 0.6));
  alb = mix(alb, C3(58.0, 62.0, 52.0), algae * 0.45);
  // checks go black
  Seg ck = segField(uv * vec2(6.0, 12.0) + 2.0, vec2(6.0, 12.0), 0.48, 0.0, 0.16);
  float check = (1.0 - smoothstep(0.010, 0.030, ck.d)) * step(0.48, ck.id);
  alb = mix(alb, dark, check);
  // nail hole + the rust bleed BELOW it.  worley .off points sample -> feature, so off.y > 0
  // means the sample sits below the nail: exactly where the stain runs.
  Cell nl = worley(uv * vec2(4.0, 4.0) + 9.0, vec2(4.0, 4.0), 0.7);
  float isNail = step(0.86, nl.id);
  float nail = isNail * (1.0 - smoothstep(0.0, 0.055, nl.f1));
  float bleed = isNail * step(0.0, nl.off.y)
              * smoothstep(0.10, 0.0, abs(nl.off.x))
              * smoothstep(0.55, 0.02, nl.off.y)
              * (0.5 + 0.5 * fbm(uv * vec2(40.0, 12.0), vec2(40.0, 12.0), 3, 0.5));
  alb = mix(alb, rust * 0.85, clamp(bleed * 0.75, 0.0, 1.0));
  alb = mix(alb, C3(46.0, 30.0, 20.0), nail);
  o.albedo = alb * (0.62 + 0.38 * ao);
  o.rough = mix(0.92, 0.76, lateM);
  o.rough = mix(o.rough, 0.95, check);
  o.metal = 0.0;
  o.ao = ao;
  return o;
}
`;

// --- galvanized steel -------------------------------------------------------------------------
// SPANGLE.  Each zinc crystal is a worley cell whose height is a LINEAR RAMP along a random
// direction, which makes the derivative constant inside the cell -- i.e. a genuine flat facet
// tilted a few degrees, exactly like real hot-dip galvanizing.  Plus per-cell roughness
// variance, scratches down to bare metal, and incipient white rust.
M['galvanized'] = /* glsl */`
float H(vec2 uv) {
  Cell sp = worley(uv * vec2(14.0, 14.0), vec2(14.0, 14.0), 1.0);
  vec2 hd = hash22(sp.cell * 1.7 + 3.3) * 2.0 - 1.0;
  vec2 dir = hd * inversesqrt(max(dot(hd, hd), 1e-4));
  float facet = dot(-sp.off, dir);
  float dend = fbm((uv + sp.id * 0.37) * vec2(90.0, 90.0), vec2(90.0, 90.0), 3, 0.55);
  float h = 0.5 + facet * 0.42 + (dend - 0.5) * 0.12;
  h -= smoothstep(0.14, 0.0, sp.f2 - sp.f1) * 0.10;               // crystal boundary
  h += (fbm(uv * vec2(3.0, 3.0), vec2(3.0, 3.0), 4, 0.6) - 0.5) * 0.22;   // rolled sheet
  Seg sc = segField(uv * vec2(11.0, 11.0) + 2.0, vec2(11.0, 11.0), 0.48, 0.9, 1.6);
  h -= (1.0 - smoothstep(0.004, 0.018, sc.d)) * step(0.55, sc.id) * 0.12;
  return clamp(h, 0.0, 1.0);
}
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  vec3 zinc = C3(154.0, 160.0, 163.0);   // mat.steel.galv #9aa0a3
  Cell sp = worley(uv * vec2(14.0, 14.0), vec2(14.0, 14.0), 1.0);
  vec3 alb = zinc * (0.90 + 0.20 * sp.id);
  float rough = clamp(0.34 + (sp.id2 - 0.5) * 0.50, 0.10, 0.80);   // +/-0.25 per cell
  float metal = 1.0;
  // crystal boundaries are slightly duller and darker
  float bound = smoothstep(0.16, 0.0, sp.f2 - sp.f1);
  alb *= 1.0 - bound * 0.16;
  rough = mix(rough, 0.62, bound);
  // white rust: chalky zinc oxide, kills metalness and shine
  float wr = smoothstep(0.66, 0.88, fbm(uv * vec2(5.0, 5.0) + 17.0, vec2(5.0, 5.0), 4, 0.6));
  wr *= 0.5 + 0.5 * fbm(uv * vec2(45.0, 45.0), vec2(45.0, 45.0), 3, 0.5);
  alb = mix(alb, C3(185.0, 188.0, 184.0), wr * 0.85);
  rough = mix(rough, 0.88, wr * 0.85);
  metal = mix(metal, 0.18, wr * 0.85);
  // scratches expose polished steel: the one sub-0.20 roughness on the bracket
  Seg sc = segField(uv * vec2(11.0, 11.0) + 2.0, vec2(11.0, 11.0), 0.48, 0.9, 1.6);
  float scratch = (1.0 - smoothstep(0.004, 0.016, sc.d)) * step(0.55, sc.id);
  alb = mix(alb, C3(176.0, 180.0, 182.0), scratch);
  rough = mix(rough, 0.16, scratch);
  metal = mix(metal, 1.0, scratch);
  // grime in the low spots
  alb *= mix(0.66, 1.0, smoothstep(0.15, 0.75, h));
  o.albedo = alb * (0.78 + 0.22 * ao);
  o.rough = rough;
  o.metal = metal;
  o.ao = ao;
  return o;
}
`;

// --- rusted steel -----------------------------------------------------------------------------
// Quantised fbm gives layered scabs with hard steps (rust delaminates in sheets, it does not
// fade), deep pits, flaking edges, and a few islands of surviving bare metal.
M['rusted-steel'] = /* glsl */`
float H(vec2 uv) {
  vec2 w = warp(uv, vec2(3.0, 3.0), 0.030, 4);
  float base = fbm(w * vec2(6.0, 6.0), vec2(6.0, 6.0), 6, 0.55);
  float q = base * 5.0;
  float lay = (floor(q) + smoothstep(0.0, 0.14, fract(q))) / 5.0;   // plateaus + hard lips
  float h = lay * 0.62 + base * 0.16;
  Cell p = worley(uv * vec2(30.0, 30.0), vec2(30.0, 30.0), 1.0);
  h -= (1.0 - smoothstep(0.0, 0.22, p.f1)) * step(0.62, p.id) * 0.34;
  Cell p2 = worley(uv * vec2(80.0, 80.0), vec2(80.0, 80.0), 1.0);
  h -= (1.0 - smoothstep(0.0, 0.24, p2.f1)) * step(0.70, p2.id) * 0.14;
  h += (fbm(uv * vec2(160.0, 160.0), vec2(160.0, 160.0), 3, 0.5) - 0.5) * 0.12;
  return clamp(h, 0.0, 1.0);
}
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  vec3 deepRust = C3(45.0, 28.0, 18.0);
  vec3 midRust  = C3(122.0, 69.0, 38.0);   // mat.rust #7a4526
  vec3 flake    = C3(138.0, 82.0, 48.0);
  vec3 steel    = C3(86.0, 91.0, 93.0);
  vec3 alb = mix(deepRust, midRust, smoothstep(0.10, 0.62, h));
  alb = mix(alb, flake, smoothstep(0.66, 0.95, h));
  // large-scale corrosion zoning; rust is never uniform
  float zone = fbm(uv * vec2(2.0, 2.0), vec2(2.0, 2.0), 5, 0.62);
  alb *= mix(0.68, 1.14, zone);
  float rough = mix(0.95, 0.78, smoothstep(0.2, 0.9, h));
  float metal = 0.28;
  // surviving mill scale / bare metal islands
  float bare = smoothstep(0.80, 0.94, fbm(uv * vec2(4.0, 4.0) + 23.0, vec2(4.0, 4.0), 5, 0.6));
  alb = mix(alb, steel, bare);
  rough = mix(rough, 0.36, bare);
  metal = mix(metal, 1.0, bare);
  // black pit floors
  float pit = smoothstep(0.22, 0.02, h);
  alb = mix(alb, C3(24.0, 17.0, 13.0), pit * 0.8);
  o.albedo = alb * (0.66 + 0.34 * ao);
  o.rough = rough;
  o.metal = metal;
  o.ao = ao;
  return o;
}
`;

// --- canvas, army-surplus tent duck ------------------------------------------------------------
// A real 2/2 twill: which thread lies on top is decided by mod(cx + cy, 4), which produces the
// diagonal wale.  Per-thread slub thickness, fibre fuzz, mildew blotches, a stitched seam and
// the tide-lines a canvas gets where water has wicked and dried.
M['canvas-tent'] = /* glsl */`
float twillH(vec2 uv, out float warpTop, out float threadId) {
  const float N = 96.0;
  vec2 t = uv * vec2(N, N);
  vec2 ci = floor(t), cf = t - ci;
  vec2 wc = wrap2(ci, vec2(N, N));
  warpTop = step(mod(wc.x + wc.y, 4.0), 1.5);
  threadId = hash11(mix(wc.y, wc.x, warpTop) + 0.5);
  float thX = sin(cf.x * PI);
  float thY = sin(cf.y * PI);
  float h = mix(thY, thX, warpTop);
  return h * (0.78 + 0.44 * threadId);
}
float H(vec2 uv) {
  float warpTop, tid;
  float weave = twillH(uv, warpTop, tid);
  float fuzz = fbm(uv * vec2(300.0, 300.0), vec2(300.0, 300.0), 2, 0.5);
  float sag = fbm(uv * vec2(3.0, 3.0), vec2(3.0, 3.0), 4, 0.6);
  float h = 0.34 + weave * 0.34 + (fuzz - 0.5) * 0.10 + (sag - 0.5) * 0.22;
  // seam: doubled fabric down the middle of the tile, with stitch dimples
  float seam = smoothstep(0.016, 0.004, abs(uv.x - 0.5));
  float stitch = smoothstep(0.35, 0.0, abs(fract(uv.y * 44.0) - 0.5));
  h += seam * 0.16 - seam * stitch * 0.20;
  return clamp(h, 0.0, 1.0);
}
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  vec3 duck = C3(92.0, 91.0, 70.0);      // mat.canvas #5c5b46
  float warpTop, tid;
  twillH(uv, warpTop, tid);
  // warp and weft threads are dyed from different lots -- this is most of the "woven" read
  vec3 alb = duck * mix(0.90, 1.08, warpTop) * (0.86 + 0.28 * tid);
  alb *= mix(0.72, 1.10, fbm(uv * vec2(2.0, 2.0), vec2(2.0, 2.0), 4, 0.62));
  // mildew: grey-green blotches, matte
  float mild = smoothstep(0.60, 0.86, fbm(uv * vec2(5.0, 5.0) + 11.0, vec2(5.0, 5.0), 5, 0.6));
  mild *= 0.5 + 0.5 * fbm(uv * vec2(40.0, 40.0), vec2(40.0, 40.0), 3, 0.5);
  alb = mix(alb, C3(56.0, 60.0, 50.0), mild * 0.85);
  // tide lines: a level-set of a smooth field, banded -- exactly how a dried water mark reads
  float field = fbm(uv * vec2(2.0, 3.0) + 31.0, vec2(2.0, 3.0), 4, 0.62);
  float band = fract(field * 7.0);
  float tide = smoothstep(0.06, 0.0, band) * smoothstep(0.20, 0.55, field);
  alb = mix(alb, C3(62.0, 60.0, 46.0), tide * 0.65);
  // seam and stitching
  float seam = smoothstep(0.018, 0.004, abs(uv.x - 0.5));
  alb = mix(alb, duck * 0.78, seam * 0.5);
  o.albedo = alb * (0.60 + 0.40 * ao);
  o.rough = mix(0.92, 0.78, smoothstep(0.25, 0.85, h));
  o.rough = mix(o.rough, 0.95, mild * 0.85);
  o.metal = 0.0;
  o.ao = ao;
  return o;
}
`;

// --- corrugated tin ---------------------------------------------------------------------------
// NOTE FOR Props/CabinSite: the corrugation itself is GEOMETRY (24 segments across a panel,
// ART_DIRECTION §5.2).  This map supplies ONLY the sub-corrugation detail: dents, mill grain,
// scratches, vertical water streaks and rust blooms.  Do not add a corrugation normal on top.
M['corrugated-tin'] = /* glsl */`
float H(vec2 uv) {
  float dent = fbm(uv * vec2(4.0, 4.0), vec2(4.0, 4.0), 4, 0.62);
  float mill = fbm(uv * vec2(400.0, 12.0), vec2(400.0, 12.0), 2, 0.5);
  Seg sc = segField(uv * vec2(9.0, 9.0) + 4.0, vec2(9.0, 9.0), 0.45, 1.5, 0.8);
  float scratch = (1.0 - smoothstep(0.004, 0.020, sc.d)) * step(0.50, sc.id);
  Cell rz = worley(uv * vec2(16.0, 16.0), vec2(16.0, 16.0), 1.0);
  float rust = smoothstep(0.55, 0.16, rz.f1) * step(0.68, rz.id);
  float h = 0.52 + (dent - 0.5) * 0.52 + (mill - 0.5) * 0.10 - scratch * 0.07;
  h += rust * 0.12 * fbm(uv * vec2(120.0, 120.0), vec2(120.0, 120.0), 2, 0.5);
  // fastener dimples on a regular pitch (integer frequency -> tiles)
  vec2 fp = fract(uv * vec2(4.0, 6.0)) - 0.5;
  h -= smoothstep(0.10, 0.02, length(fp)) * 0.18;
  return clamp(h, 0.0, 1.0);
}
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  vec3 tin = C3(125.0, 132.0, 135.0);    // mat.tin #7d8487
  vec3 alb = tin * mix(0.84, 1.10, fbm(uv * vec2(3.0, 3.0), vec2(3.0, 3.0), 4, 0.62));
  float rough = 0.44;
  float metal = 1.0;
  // vertical water streaks: high frequency across, almost none down
  float streak = fbm(uv * vec2(60.0, 2.0), vec2(60.0, 2.0), 3, 0.55);
  alb *= mix(0.78, 1.06, streak);
  rough = mix(rough, 0.66, smoothstep(0.62, 0.15, streak));
  // rust blooms around the fasteners and along the streaks
  Cell rz = worley(uv * vec2(16.0, 16.0), vec2(16.0, 16.0), 1.0);
  float rust = smoothstep(0.55, 0.16, rz.f1) * step(0.68, rz.id);
  rust = clamp(rust * (0.55 + 0.75 * (1.0 - streak)), 0.0, 1.0);
  alb = mix(alb, C3(110.0, 66.0, 41.0), rust * 0.9);
  rough = mix(rough, 0.92, rust * 0.9);
  metal = mix(metal, 0.20, rust * 0.9);
  Seg sc = segField(uv * vec2(9.0, 9.0) + 4.0, vec2(9.0, 9.0), 0.45, 1.5, 0.8);
  float scratch = (1.0 - smoothstep(0.004, 0.016, sc.d)) * step(0.50, sc.id);
  alb = mix(alb, C3(168.0, 172.0, 174.0), scratch);
  rough = mix(rough, 0.20, scratch);
  o.albedo = alb * (0.80 + 0.20 * ao);
  o.rough = rough;
  o.metal = metal;
  o.ao = ao;
  return o;
}
`;

// --- concrete (the foundation piers) -----------------------------------------------------------
// Aggregate exposed only where a wear mask says the cement paste has gone, horizontal form-board
// lines from the shuttering, corner chips with sharp fresh-break interiors, and air voids.
M['concrete'] = /* glsl */`
float H(vec2 uv) {
  float base = fbm(uv * vec2(7.0, 7.0), vec2(7.0, 7.0), 5, 0.55);
  Cell a = worley(uv * vec2(26.0, 26.0), vec2(26.0, 26.0), 1.0);
  float wear = smoothstep(0.44, 0.76, fbm(uv * vec2(3.0, 3.0) + 2.0, vec2(3.0, 3.0), 4, 0.6));
  float agg = (1.0 - smoothstep(0.10, 0.34, a.f1)) * step(0.42, a.id);
  float h = 0.58 + (base - 0.5) * 0.20 + agg * wear * 0.24;
  float form = abs(fract(uv.y * 4.0) - 0.5);
  h -= smoothstep(0.055, 0.0, form) * 0.12;                    // shuttering seam
  Cell c = worley(uv * vec2(6.0, 6.0) + 9.0, vec2(6.0, 6.0), 1.0);
  h -= step(0.88, c.id) * (1.0 - smoothstep(0.0, 0.18, c.f1)) * 0.38;    // chips
  Cell v = worley(uv * vec2(70.0, 70.0), vec2(70.0, 70.0), 1.0);
  h -= step(0.90, v.id) * (1.0 - smoothstep(0.0, 0.30, v.f1)) * 0.26;    // air voids
  h += (fbm(uv * vec2(220.0, 220.0), vec2(220.0, 220.0), 2, 0.5) - 0.5) * 0.07;
  return clamp(h, 0.0, 1.0);
}
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  vec3 paste = C3(92.0, 97.0, 96.0);     // cool grey, stays inside the blue-green world
  vec3 alb = paste * mix(0.70, 1.14, fbm(uv * vec2(2.0, 2.0), vec2(2.0, 2.0), 5, 0.62));
  float rough = 0.76;
  // aggregate: three stone tones, only visible where the paste has worn
  Cell a = worley(uv * vec2(26.0, 26.0), vec2(26.0, 26.0), 1.0);
  float wear = smoothstep(0.44, 0.76, fbm(uv * vec2(3.0, 3.0) + 2.0, vec2(3.0, 3.0), 4, 0.6));
  float agg = (1.0 - smoothstep(0.14, 0.32, a.f1)) * step(0.42, a.id) * wear;
  vec3 stone = a.id2 < 0.33 ? C3(56.0, 60.0, 61.0)
             : (a.id2 < 0.72 ? C3(118.0, 120.0, 116.0) : C3(84.0, 82.0, 76.0));
  alb = mix(alb, stone, agg * 0.9);
  rough = mix(rough, 0.52, agg * 0.9);
  // form lines hold damp and algae
  float form = smoothstep(0.055, 0.0, abs(fract(uv.y * 4.0) - 0.5));
  alb = mix(alb, C3(58.0, 63.0, 58.0), form * 0.55);
  // efflorescence: pale mineral bloom running down
  float eff = smoothstep(0.70, 0.92, fbm(uv * vec2(9.0, 3.0) + 41.0, vec2(9.0, 3.0), 4, 0.6));
  alb = mix(alb, C3(160.0, 162.0, 158.0), eff * 0.45);
  // chip interiors are a fresh, paler break
  Cell c = worley(uv * vec2(6.0, 6.0) + 9.0, vec2(6.0, 6.0), 1.0);
  float chip = step(0.88, c.id) * (1.0 - smoothstep(0.0, 0.18, c.f1));
  alb = mix(alb, C3(126.0, 126.0, 120.0), chip * 0.7);
  o.albedo = alb * (0.62 + 0.38 * ao);
  o.rough = mix(rough, 0.92, smoothstep(0.5, 0.05, h));
  o.metal = 0.0;
  o.ao = ao;
  return o;
}
`;

// --- lake water normal (ANIMATED) ---------------------------------------------------------
// Dual-layer: a broad swell and a finer chop scrolling in different directions, plus a
// capillary band.  Driven by uTime -- Textures re-bakes this target every frame at
// `medium`+ (it is only 512^2, well under 0.1 ms).  Scrolling is a constant offset in the
// noise domain per frame, so the tile stays seamless at every instant.
M['water-normal'] = /* glsl */`
float H(vec2 uv) {
  float t = uTime;
  vec2 a = uv + vec2(0.031, 0.017) * t;
  float ha = fbm(a * vec2(4.0, 4.0), vec2(4.0, 4.0), 4, 0.55);
  vec2 b = uv + vec2(-0.023, 0.041) * t;
  float hb = fbm(b * vec2(11.0, 9.0), vec2(11.0, 9.0), 4, 0.50);
  vec2 c = uv + vec2(0.070, -0.052) * t;
  float hc = fbm(c * vec2(31.0, 27.0), vec2(31.0, 27.0), 3, 0.50);
  return clamp(ha * 0.50 + hb * 0.33 + hc * 0.17, 0.0, 1.0);
}
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  o.albedo = C3(11.0, 23.0, 28.0);   // water.body #0b171c
  o.rough = 0.02;
  o.metal = 0.0;
  o.ao = 1.0;
  return o;
}
`;

// --- shared DETAIL normal ----------------------------------------------------------------------
// The classic AAA close-up trick: one fine, high-frequency normal that Materials layers on
// EVERYTHING at a high tiling rate (8-40 repeats per metre) so a surface still has structure
// when the camera is 20 cm from it and the base map has run out of texels.
M['detail-normal'] = /* glsl */`
float H(vec2 uv) {
  float a = fbm(uv * vec2(24.0, 24.0), vec2(24.0, 24.0), 5, 0.55);
  float b = fbmv(uv * vec2(96.0, 96.0), vec2(96.0, 96.0), 3, 0.50);
  Cell c = worley(uv * vec2(48.0, 48.0), vec2(48.0, 48.0), 1.0);
  float pits = (1.0 - smoothstep(0.0, 0.26, c.f1)) * step(0.70, c.id);
  Seg s = segField(uv * vec2(20.0, 20.0) + 7.0, vec2(20.0, 20.0), 0.46, 0.4, 2.4);
  float scr = (1.0 - smoothstep(0.004, 0.014, s.d)) * step(0.60, s.id);
  return clamp(0.5 + (a - 0.5) * 0.52 + (b - 0.5) * 0.38 - pits * 0.26 - scr * 0.20, 0.0, 1.0);
}
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  o.albedo = vec3(0.5);
  o.rough = 0.5;
  o.metal = 0.0;
  o.ao = ao;
  return o;
}
`;

// --- pine foliage card (ALPHA) -----------------------------------------------------------------
// A sprig of needles for the canopy cards.  Alpha-to-coverage, never alpha-test
// (ART_DIRECTION §5.2) -- Materials should set `alphaToCoverage: true`, not `alphaTest`.
M['foliage-pine'] = /* glsl */`
float needles(vec2 uv, out float id, out float tip) {
  Seg a = segField(uv * vec2(13.0, 13.0), vec2(13.0, 13.0), 0.48, 1.30, 0.34);
  Seg b = segField(uv * vec2(17.0, 17.0) + 6.0, vec2(17.0, 17.0), 0.46, 1.86, 0.30);
  float ma = 1.0 - smoothstep(0.010, 0.030, a.d);
  float mb = 1.0 - smoothstep(0.008, 0.026, b.d);
  id = ma > mb ? a.id : b.id;
  tip = ma > mb ? abs(a.t) : abs(b.t);
  return max(ma, mb);
}
float H(vec2 uv) {
  float id, tip;
  float nm = needles(uv, id, tip);
  // twigs: the woody spine the needles hang off
  Seg t = segField(uv * vec2(5.0, 5.0) + 2.0, vec2(5.0, 5.0), 0.49, 1.55, 0.22);
  float tw = (1.0 - smoothstep(0.012, 0.030, t.d)) * step(0.30, t.id);
  // a needle is a half-round section: highest along its spine, falling to the edges
  return clamp(nm * (0.55 + 0.25 * id) * (1.0 - tip * 0.35) + tw * 0.55, 0.0, 1.0);
}
float A(vec2 uv, float h) {
  float id, tip;
  float nm = needles(uv, id, tip);
  Seg t = segField(uv * vec2(5.0, 5.0) + 2.0, vec2(5.0, 5.0), 0.49, 1.55, 0.22);
  float tw = (1.0 - smoothstep(0.014, 0.028, t.d)) * step(0.30, t.id);
  // taper the far end of each needle so the silhouette is not a blunt capsule
  float taper = 1.0 - smoothstep(0.72, 1.0, tip);
  return clamp(max(nm * taper, tw) * 1.35, 0.0, 1.0);
}
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  float id, tip;
  needles(uv, id, tip);
  vec3 wet = C3(19.0, 31.0, 26.0);      // foliage.wet #131f1a -- the default state, nights 1-7
  vec3 dry = C3(59.0, 68.0, 48.0);      // foliage.dry #3b4430, only under shelter
  vec3 alb = mix(wet, dry, id * 0.55 * smoothstep(0.35, 0.85, fbm(uv * vec2(2.0, 2.0), vec2(2.0, 2.0), 3, 0.6)));
  alb *= 0.80 + 0.34 * id;                                   // per-needle tone spread
  alb = mix(alb, C3(74.0, 68.0, 51.0), smoothstep(0.6, 1.0, tip) * 0.35);   // browning tips
  Seg t = segField(uv * vec2(5.0, 5.0) + 2.0, vec2(5.0, 5.0), 0.49, 1.55, 0.22);
  float tw = (1.0 - smoothstep(0.012, 0.030, t.d)) * step(0.30, t.id);
  alb = mix(alb, C3(46.0, 38.0, 30.0), tw * 0.85);
  o.albedo = alb * (0.72 + 0.28 * ao);
  o.rough = mix(0.42, 0.60, id);         // waxy cuticle: ART_DIRECTION says 0.42 wet
  o.rough = mix(o.rough, 0.86, tw);
  o.metal = 0.0;
  o.ao = ao;
  return o;
}
`;

// --- fern / undergrowth card (ALPHA) -----------------------------------------------------------
// Two fronds per tile: a rachis running along U with tapering pinnae either side.  The vertex
// AO gradient root->tip that ART_DIRECTION asks for belongs on the mesh; here we bake the
// darkening toward the rachis so the leaflets read as separate blades.
M['foliage-fern'] = /* glsl */`
float frondMask(vec2 uv, out float along, out float across, out float leafId) {
  vec2 f = vec2(uv.x, fract(uv.y * 2.0));
  along = uv.x;
  across = abs(f.y - 0.5);
  float lx = fract(uv.x * 24.0);
  leafId = hash11(floor(uv.x * 24.0) + 0.5);
  // leaflet length varies smoothly along the frond (period-1, so it tiles)
  float len = 0.20 + 0.16 * fbm(uv * vec2(3.0, 1.0), vec2(3.0, 1.0), 3, 0.6) + 0.08 * leafId;
  // each leaflet is a lens swept back from the rachis
  float sweep = across * 0.55;
  float blade = smoothstep(0.46, 0.30, abs(lx - 0.5) + sweep);
  float reach = smoothstep(len, len * 0.55, across);
  float rachis = smoothstep(0.028, 0.010, across);
  return clamp(max(blade * reach, rachis), 0.0, 1.0);
}
float H(vec2 uv) {
  float along, across, leafId;
  float m = frondMask(uv, along, across, leafId);
  float rachis = smoothstep(0.030, 0.008, across);
  float vein = 0.5 + 0.5 * cos(fract(uv.x * 24.0) * TAU);
  return clamp(m * (0.42 + 0.20 * leafId) + rachis * 0.42 + m * vein * 0.10, 0.0, 1.0);
}
float A(vec2 uv, float h) {
  float along, across, leafId;
  return clamp(frondMask(uv, along, across, leafId) * 1.4, 0.0, 1.0);
}
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  float along, across, leafId;
  frondMask(uv, along, across, leafId);
  vec3 alb = mix(C3(26.0, 42.0, 34.0), C3(38.0, 52.0, 40.0), leafId);
  alb *= mix(0.55, 1.15, smoothstep(0.0, 0.22, across));    // dark at the root, per ART_DIRECTION
  alb = mix(alb, C3(64.0, 60.0, 40.0), smoothstep(0.80, 0.99, fbm(uv * vec2(4.0, 4.0), vec2(4.0, 4.0), 4, 0.6)) * 0.5);
  float rachis = smoothstep(0.030, 0.008, across);
  alb = mix(alb, C3(52.0, 56.0, 38.0), rachis * 0.7);
  o.albedo = alb * (0.70 + 0.30 * ao);
  // ART_DIRECTION: "a specular sheen so strong the fern reads as a silhouette of highlights"
  o.rough = mix(0.35, 0.52, leafId);
  o.metal = 0.0;
  o.ao = ao;
  return o;
}
`;

// --- fresh blood (ALPHA decal) -----------------------------------------------------------------
// Non-Newtonian: a raised meniscus ring at the edge, a near-mirror interior, satellite droplets.
M['blood'] = /* glsl */`
float pool(vec2 uv) {
  vec2 w = warp(uv, vec2(3.0, 3.0), 0.055, 4);
  float b = fbm(w * vec2(3.0, 3.0), vec2(3.0, 3.0), 5, 0.58);
  float main = smoothstep(0.50, 0.60, b);
  Cell d = worley(uv * vec2(9.0, 9.0) + 4.0, vec2(9.0, 9.0), 1.0);
  float spat = step(0.72, d.id) * smoothstep(0.16, 0.04, d.f1);   // satellite droplets
  return clamp(max(main, spat), 0.0, 1.0);
}
float H(vec2 uv) {
  float p = pool(uv);
  // meniscus: surface tension piles the fluid up at the rim
  float rim = p * (1.0 - p) * 4.0;
  return clamp(p * 0.55 + rim * rim * 0.42, 0.0, 1.0);
}
float A(vec2 uv, float h) { return clamp(pool(uv) * 1.25, 0.0, 1.0); }
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  float p = pool(uv);
  float thin = 1.0 - smoothstep(0.15, 0.75, p);
  // thick blood is blood.fresh; a thin film transmits and goes blood.hot
  vec3 alb = mix(C3(122.0, 22.0, 26.0), C3(122.0, 16.0, 19.0), smoothstep(0.2, 0.9, p));
  alb = mix(alb, C3(168.0, 22.0, 26.0), thin * 0.55);
  alb *= 0.88 + 0.22 * fbm(uv * vec2(30.0, 30.0), vec2(30.0, 30.0), 3, 0.5);
  o.albedo = alb;
  o.rough = mix(0.30, 0.10, smoothstep(0.1, 0.6, p));
  o.metal = 0.0;
  o.ao = ao;
  return o;
}
`;

// --- dried blood ------------------------------------------------------------------------------
M['blood-dry'] = /* glsl */`
float pool(vec2 uv) {
  vec2 w = warp(uv, vec2(3.0, 3.0), 0.05, 4);
  return smoothstep(0.48, 0.62, fbm(w * vec2(3.0, 3.0), vec2(3.0, 3.0), 5, 0.58));
}
float H(vec2 uv) {
  float p = pool(uv);
  // cracked-mud pattern at ~0.8 mm, slightly raised at the crack edges
  Cell c = worley(uv * vec2(70.0, 70.0), vec2(70.0, 70.0), 1.0);
  float crack = smoothstep(0.0, 0.09, c.f2 - c.f1);
  float curl = (1.0 - crack) * 0.0;
  return clamp(p * (0.42 + 0.26 * crack + 0.12 * c.id) + curl
             + (fbm(uv * vec2(180.0, 180.0), vec2(180.0, 180.0), 2, 0.5) - 0.5) * 0.06, 0.0, 1.0);
}
float A(vec2 uv, float h) { return clamp(pool(uv) * 1.3, 0.0, 1.0); }
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  float p = pool(uv);
  Cell c = worley(uv * vec2(70.0, 70.0), vec2(70.0, 70.0), 1.0);
  vec3 alb = mix(C3(58.0, 17.0, 19.0), C3(38.0, 17.0, 19.0), smoothstep(0.2, 0.9, p));
  alb *= 0.86 + 0.28 * c.id;
  alb = mix(alb, C3(24.0, 11.0, 11.0), smoothstep(0.10, 0.0, c.f2 - c.f1));   // black crack floors
  o.albedo = alb * (0.66 + 0.34 * ao);
  o.rough = 0.74;
  o.metal = 0.0;
  o.ao = ao;
  return o;
}
`;

// --- wet skin ----------------------------------------------------------------------------------
// Pores at two scales, fine crease lines, a coarse wrinkle layer, and blotchy subsurface
// mottling.  ART_DIRECTION: desaturated, never pink.
M['skin-wet'] = /* glsl */`
float H(vec2 uv) {
  Cell p1 = worley(uv * vec2(110.0, 110.0), vec2(110.0, 110.0), 1.0);
  Cell p2 = worley(uv * vec2(46.0, 46.0), vec2(46.0, 46.0), 1.0);
  float pore = (1.0 - smoothstep(0.0, 0.22, p1.f1)) * step(0.42, p1.id);
  float cell = smoothstep(0.0, 0.30, p2.f2 - p2.f1);
  Seg cr = segField(uv * vec2(14.0, 14.0) + 3.0, vec2(14.0, 14.0), 0.47, 0.7, 2.2);
  float crease = (1.0 - smoothstep(0.004, 0.020, cr.d)) * step(0.42, cr.id);
  float macro = fbm(uv * vec2(5.0, 5.0), vec2(5.0, 5.0), 4, 0.6);
  return clamp(0.56 + (macro - 0.5) * 0.26 + cell * 0.14 - pore * 0.24 - crease * 0.20, 0.0, 1.0);
}
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  vec3 base = C3(107.0, 81.0, 72.0);    // mat.skin.wet #6b5148
  float mottle = fbm(uv * vec2(3.0, 3.0), vec2(3.0, 3.0), 5, 0.62);
  vec3 alb = base * mix(0.80, 1.14, mottle);
  // subdermal blotching -- slightly cooler, never pink
  alb = mix(alb, C3(88.0, 68.0, 66.0), smoothstep(0.58, 0.86, fbm(uv * vec2(7.0, 7.0) + 11.0, vec2(7.0, 7.0), 4, 0.6)) * 0.45);
  alb = mix(alb, C3(62.0, 48.0, 44.0), smoothstep(0.4, 0.0, h) * 0.4);
  o.albedo = alb * (0.74 + 0.26 * ao);
  // damp: the broad lobe is 0.36, but the low spots hold water and go glossy
  o.rough = mix(0.36, 0.18, smoothstep(0.55, 0.12, h));
  o.metal = 0.0;
  o.ao = ao;
  return o;
}
`;

// --- blue poly tarp ----------------------------------------------------------------------------
M['tarp-plastic'] = /* glsl */`
float H(vec2 uv) {
  // folds: warped ridged noise reads as creased sheet far better than plain fbm
  vec2 w = warp(uv, vec2(2.0, 2.0), 0.070, 3);
  float fold = ridged(w * vec2(3.0, 3.0), vec2(3.0, 3.0), 4);
  float crease = ridged(w * vec2(9.0, 9.0), vec2(9.0, 9.0), 3);
  // scrim: the woven polyethylene mesh under the film
  vec2 t = uv * vec2(120.0, 120.0);
  vec2 ci = floor(t), cf = t - ci;
  float over = step(mod(wrap2(ci, vec2(120.0)).x + wrap2(ci, vec2(120.0)).y, 2.0), 0.5);
  float scrim = mix(sin(cf.y * PI), sin(cf.x * PI), over);
  return clamp(0.42 + fold * 0.34 + crease * 0.14 + scrim * 0.10, 0.0, 1.0);
}
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  vec3 alb = C3(47.0, 69.0, 80.0);      // #2f4550
  alb *= mix(0.78, 1.14, fbm(uv * vec2(3.0, 3.0), vec2(3.0, 3.0), 4, 0.62));
  // abraded fold crests go chalky and pale
  float crest = smoothstep(0.68, 0.95, h);
  alb = mix(alb, C3(120.0, 138.0, 146.0), crest * 0.45);
  // grime pooled in the sags
  alb = mix(alb, C3(34.0, 38.0, 36.0), smoothstep(0.42, 0.05, h) * 0.5);
  o.albedo = alb * (0.70 + 0.30 * ao);
  o.rough = mix(0.24, 0.52, crest);     // plastic sheen except where scuffed
  o.metal = 0.0;
  o.ao = ao;
  return o;
}
`;

// --- rope (3-strand hemp) -----------------------------------------------------------------------
// The rope axis is U.  Strand and yarn helices are integer-coefficient diagonals, which is what
// keeps a twisted structure tileable.
M['rope'] = /* glsl */`
float H(vec2 uv) {
  float strand = fract(uv.y * 3.0 + uv.x * 5.0);
  float sh = sin(strand * PI);
  float yarn = fract(uv.y * 21.0 + uv.x * 26.0);
  float yh = sin(yarn * PI);
  float fibre = fbm(uv * vec2(160.0, 40.0), vec2(160.0, 40.0), 3, 0.5);
  Seg fuzz = segField(uv * vec2(30.0, 30.0) + 8.0, vec2(30.0, 30.0), 0.44, 0.5, 2.6);
  float hair = (1.0 - smoothstep(0.006, 0.020, fuzz.d)) * step(0.68, fuzz.id);
  return clamp(sh * 0.52 + sh * yh * 0.26 + (fibre - 0.5) * 0.12 + hair * 0.12, 0.0, 1.0);
}
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  float strand = fract(uv.y * 3.0 + uv.x * 5.0);
  vec3 alb = C3(110.0, 98.0, 72.0);
  alb *= 0.84 + 0.30 * fbm(uv * vec2(90.0, 24.0), vec2(90.0, 24.0), 3, 0.5);
  alb *= mix(0.72, 1.08, sin(strand * PI));
  // the rope has been dragged through mud
  alb = mix(alb, C3(42.0, 34.0, 27.0), smoothstep(0.62, 0.90, fbm(uv * vec2(4.0, 2.0), vec2(4.0, 2.0), 4, 0.6)) * 0.7);
  o.albedo = alb * (0.60 + 0.40 * ao);
  o.rough = 0.88;
  o.metal = 0.0;
  o.ao = ao;
  return o;
}
`;

// --- dirty glass (ALPHA = grime coverage) --------------------------------------------------------
M['glass-dirty'] = /* glsl */`
float grime(vec2 uv) {
  float film = fbm(uv * vec2(3.0, 3.0), vec2(3.0, 3.0), 5, 0.62);
  float streak = fbm(uv * vec2(40.0, 2.0), vec2(40.0, 2.0), 4, 0.55);
  Cell sp = worley(uv * vec2(28.0, 28.0), vec2(28.0, 28.0), 1.0);
  float spot = step(0.74, sp.id) * smoothstep(0.20, 0.05, sp.f1);
  return clamp(smoothstep(0.42, 0.78, film) * 0.7 + smoothstep(0.55, 0.9, streak) * 0.5 + spot, 0.0, 1.0);
}
float H(vec2 uv) {
  float g = grime(uv);
  float dust = fbm(uv * vec2(200.0, 200.0), vec2(200.0, 200.0), 2, 0.5);
  return clamp(0.5 + g * 0.30 + (dust - 0.5) * 0.10, 0.0, 1.0);
}
float A(vec2 uv, float h) { return clamp(0.10 + grime(uv) * 0.90, 0.0, 1.0); }
Surf S(vec2 uv, float h, float ao, vec3 n) {
  Surf o;
  float g = grime(uv);
  vec3 alb = mix(C3(28.0, 36.0, 40.0), C3(96.0, 92.0, 80.0), g);
  o.albedo = alb * (0.80 + 0.20 * ao);
  o.rough = mix(0.03, 0.72, g);        // clean glass is the mirror; grime kills it
  o.metal = 0.0;
  o.ao = ao;
  return o;
}
`;

// ---------------------------------------------------------------------------------------------
// SET TABLE
//   size    'hero' = base resolution, 'mid' = half, 'small' = quarter (ART_DIRECTION §5:
//           hero surfaces at the tier resolution, "one tier down for everything else")
//   relief  physical relief of the height field, metres
//   tile    physical size the tile is authored for, metres  -> normalStrength = relief / tile
//   disp    bake the dedicated half-res displacementMap (height is ALWAYS in normalMap.a)
// ---------------------------------------------------------------------------------------------

const SET_DEFS = {
  'bark-pine':      { size: 'hero',  relief: 0.050, tile: 1.10, ao: 0.85, cavity: 0.55, toksvig: 0.22, taps: 6, disp: true },
  'bark-birch':     { size: 'mid',   relief: 0.016, tile: 1.10, ao: 0.70, cavity: 0.40, toksvig: 0.18, taps: 6, disp: false },
  'pine-needles':   { size: 'mid',   relief: 0.045, tile: 1.60, ao: 0.95, cavity: 0.60, toksvig: 0.30, taps: 4, disp: true },
  'wet-earth':      { size: 'hero',  relief: 0.060, tile: 2.00, ao: 0.90, cavity: 0.55, toksvig: 0.26, taps: 6, disp: true },
  'moss':           { size: 'mid',   relief: 0.030, tile: 0.80, ao: 0.95, cavity: 0.65, toksvig: 0.30, taps: 6, disp: false },
  'granite':        { size: 'mid',   relief: 0.045, tile: 1.40, ao: 0.75, cavity: 0.40, toksvig: 0.55, taps: 6, disp: true },
  'sawn-lumber':    { size: 'hero',  relief: 0.006, tile: 0.60, ao: 0.55, cavity: 0.30, toksvig: 0.30, taps: 6, disp: false },
  'weathered-wood': { size: 'mid',   relief: 0.010, tile: 0.60, ao: 0.75, cavity: 0.45, toksvig: 0.28, taps: 6, disp: false },
  'galvanized':     { size: 'mid',   relief: 0.0016, tile: 0.25, ao: 0.45, cavity: 0.20, toksvig: 0.40, taps: 6, disp: false },
  'rusted-steel':   { size: 'mid',   relief: 0.004, tile: 0.30, ao: 0.80, cavity: 0.45, toksvig: 0.35, taps: 6, disp: false },
  'canvas-tent':    { size: 'mid',   relief: 0.0018, tile: 0.14, ao: 0.60, cavity: 0.35, toksvig: 0.30, taps: 6, disp: false },
  'corrugated-tin': { size: 'small', relief: 0.004, tile: 0.80, ao: 0.40, cavity: 0.20, toksvig: 0.30, taps: 6, disp: false },
  'concrete':       { size: 'mid',   relief: 0.014, tile: 0.90, ao: 0.80, cavity: 0.45, toksvig: 0.28, taps: 6, disp: true },
  'water-normal':   { size: 'small', relief: 0.045, tile: 3.00, ao: 0.00, cavity: 0.00, toksvig: 0.00, taps: 4, disp: false, animated: true },
  'detail-normal':  { size: 'small', relief: 0.0025, tile: 0.12, ao: 0.30, cavity: 0.15, toksvig: 0.00, taps: 4, disp: false },

  // Foliage cards and decals.  `alpha: true` injects HAS_ALPHA and the set writes opacity into
  // map.a -- use alphaToCoverage, NOT alphaTest (ART_DIRECTION trap 10: alpha-tested pine cards
  // shimmer horribly in motion).
  'foliage-pine':   { size: 'mid',   relief: 0.004, tile: 0.45, ao: 0.55, cavity: 0.30, toksvig: 0.20, taps: 4, disp: false, alpha: true },
  'foliage-fern':   { size: 'mid',   relief: 0.004, tile: 0.55, ao: 0.55, cavity: 0.30, toksvig: 0.20, taps: 4, disp: false, alpha: true },
  'blood':          { size: 'small', relief: 0.002, tile: 0.50, ao: 0.40, cavity: 0.20, toksvig: 0.10, taps: 6, disp: false, alpha: true },
  'blood-dry':      { size: 'small', relief: 0.0016, tile: 0.50, ao: 0.60, cavity: 0.35, toksvig: 0.25, taps: 6, disp: false, alpha: true },
  'skin-wet':       { size: 'mid',   relief: 0.0012, tile: 0.18, ao: 0.45, cavity: 0.25, toksvig: 0.15, taps: 6, disp: false },
  'tarp-plastic':   { size: 'mid',   relief: 0.020, tile: 1.20, ao: 0.70, cavity: 0.40, toksvig: 0.22, taps: 6, disp: false },
  'rope':           { size: 'small', relief: 0.006, tile: 0.09, ao: 0.75, cavity: 0.45, toksvig: 0.30, taps: 6, disp: false },
  'glass-dirty':    { size: 'small', relief: 0.0008, tile: 0.40, ao: 0.30, cavity: 0.15, toksvig: 0.15, taps: 4, disp: false, alpha: true },
};

/**
 * Friendly aliases so consumers can ask by the name that reads best at the call site.
 * Aliases share ONE bake -- they resolve before the cache is touched.
 */
const ALIASES = {
  'ground-needles': 'pine-needles',
  'forest-floor': 'pine-needles',
  'ground-mud': 'wet-earth',
  'mud': 'wet-earth',
  'ground-moss': 'moss',
  'galvanized-steel': 'galvanized',
  'steel-galv': 'galvanized',
  'canvas': 'canvas-tent',
  'tent-canvas': 'canvas-tent',
  'water-lake': 'water-normal',
  'water': 'water-normal',
  'lumber': 'sawn-lumber',
  'plank-weathered': 'weathered-wood',
  'tin': 'corrugated-tin',
  'rock': 'granite',
  'bark': 'bark-pine',
  'birch': 'bark-birch',
  'tarp': 'tarp-plastic',
  'detail': 'detail-normal',
};

/** Names in bake order (canonical only — aliases are not baked separately). */
export const TEXTURE_SETS = Object.keys(SET_DEFS);

/** Every name `get()` accepts, canonical and alias. */
export const TEXTURE_ALIASES = ALIASES;

const SIZE_SCALE = { hero: 1.0, mid: 0.5, small: 0.25 };

// ---------------------------------------------------------------------------------------------
// THE BAKERY
// ---------------------------------------------------------------------------------------------

const _rtOpts = {
  format: THREE.RGBAFormat,
  type: THREE.UnsignedByteType,
  depthBuffer: false,
  stencilBuffer: false,
  generateMipmaps: true,
  minFilter: THREE.LinearMipmapLinearFilter,
  magFilter: THREE.LinearFilter,
  wrapS: THREE.RepeatWrapping,
  wrapT: THREE.RepeatWrapping,
};

export class Textures {
  constructor(ctx) {
    this.ctx = ctx ?? null;
    this.bus = ctx?.bus ?? null;

    /** name -> baked set (the shared, canonical textures) */
    this._sets = new Map();
    /** cacheKey -> set (includes the base sets plus repeat/offset views) */
    this._cache = new Map();
    /** name -> { rt, dispRt, material, size, def } */
    this._rec = new Map();
    /** ExternalTexture views handed out by get(name, { repeat }) */
    this._views = [];

    this._rig = null;
    this._ready = false;
    this._fallback = null;
    this._blueNoise = null;
    this._detailNormal = null;
    this._luts = new Map();

    this._waterLive = false;
    this._waterTime = 0;
    this._waterAccum = 0;
    this._waterStep = 1 / 30;

    this._maxAniso = 1;
    this._baseRes = 512;
    this._bytes = 0;
    this._debugInstalled = false;
  }

  // ------------------------------------------------------------------ lifecycle

  async init() {
    if (this._ready) return;
    const renderer = this.ctx?.renderer;
    if (!renderer) {
      Log.warn('Textures: no ctx.renderer — every get() will return the flat fallback set.');
      return;
    }

    const st = this.ctx.settings;
    this._baseRes = st?.tier ? st.tier(256, 512, 1024, 2048) : 512;
    this._waterStep = st?.tier ? st.tier(1 / 12, 1 / 24, 1 / 30, 1 / 60) : 1 / 30;
    try {
      this._maxAniso = renderer.capabilities?.getMaxAnisotropy?.() ?? 1;
    } catch { this._maxAniso = 1; }

    const t0 = performance.now();
    this._buildRig();

    // Blue noise first — Postprocessing/VolumetricFog want it and it is CPU-side.
    this._blueNoise = this._makeBlueNoise(128);

    for (const name of TEXTURE_SETS) {
      try {
        this._bake(name);
      } catch (e) {
        Log.error(`Textures: bake('${name}') failed — using fallback for it.`, e);
      }
      // Yield to the browser between materials: keeps one 2 s GPU submit from becoming a
      // dropped frame storm, and lets the loading screen (if any) actually paint.
      await _nextTick();
    }

    this._detailNormal = this._sets.get('detail-normal')?.normalMap ?? null;
    this._makeLUT('night');
    this._makeLUT('dawn');

    this._ready = true;
    this._installDebug();

    Log.info(
      `Textures: baked ${this._sets.size} sets at base ${this._baseRes}px in ` +
      `${(performance.now() - t0).toFixed(0)} ms (~${(this._bytes / 1048576).toFixed(0)} MB VRAM incl. mips)`,
    );
  }

  update(dt) {
    if (!this._ready || !this._waterLive) return;
    const d = Number.isFinite(dt) ? Math.min(dt, 0.1) : 0;
    this._waterTime += d;
    this._waterAccum += d;
    if (this._waterAccum < this._waterStep) return;
    this._waterAccum = 0;
    try {
      this._render('water-normal', this._waterTime);
    } catch (e) {
      Log.once('tex:water', 'Textures: water-normal re-bake threw — freezing the ripple.', e);
      this._waterLive = false;
    }
  }

  resize() { /* bake resolution is tier-driven, not viewport-driven */ }

  // ------------------------------------------------------------------ public API

  /**
   * Fetch a baked material set.  Cached by key.
   *
   * @param {string} name  one of TEXTURE_SETS
   * @param {object} [opts]
   * @param {number[]|{x:number,y:number}} [opts.repeat]  tiling rate -> returns a cheap VIEW
   *        (shares the GPU texture, own uv transform).  Omit to get the shared textures.
   * @param {number[]|{x:number,y:number}} [opts.offset]
   * @param {number} [opts.rotation]  radians
   * @returns {{map:THREE.Texture, normalMap:THREE.Texture, roughnessMap:THREE.Texture,
   *            metalnessMap:THREE.Texture, aoMap:THREE.Texture, ormMap:THREE.Texture,
   *            displacementMap:?THREE.Texture, heightInNormalAlpha:boolean,
   *            relief:number, tile:number, name:string}}
   *
   * NOTE: roughnessMap === metalnessMap === aoMap === ormMap.  It is one ORM texture; Three
   * reads .r/.g/.b from the right channels automatically.  Do NOT mutate .repeat on the
   * returned textures unless you asked for a view — they are shared by every material.
   */
  get(rawName, opts) {
    const name = ALIASES[rawName] ?? rawName;
    const key = _cacheKey(name, opts);
    const hit = this._cache.get(key);
    if (hit) return hit;

    let base = this._sets.get(name);
    if (!base) {
      if (!SET_DEFS[name]) {
        Log.once(`tex:unknown:${name}`, `Textures.get('${rawName}'): unknown set — returning fallback. Known: ${TEXTURE_SETS.join(', ')}`);
        return this._fallbackSet();
      }
      if (!this.ctx?.renderer) return this._fallbackSet();
      try {
        if (!this._rig) this._buildRig();
        base = this._bake(name);
      } catch (e) {
        Log.error(`Textures.get('${name}') — lazy bake failed.`, e);
        return this._fallbackSet();
      }
    }
    if (name === 'water-normal') this._waterLive = (this.ctx?.settings?.tierIndex ?? 3) >= 1;

    if (!opts || (!opts.repeat && !opts.offset && opts.rotation === undefined)) return base;

    const view = this._makeView(base, opts);
    this._cache.set(key, view);
    return view;
  }

  /** True if `name` is a known set (or a known alias). */
  has(name) { return !!SET_DEFS[ALIASES[name] ?? name]; }

  /** Canonical name for an alias, or the input if it is already canonical. */
  resolve(name) { return ALIASES[name] ?? name; }

  /** Every name this bakery answers to, canonical first. */
  get names() { return [...TEXTURE_SETS, ...Object.keys(ALIASES)]; }

  /** True once init() has finished baking. */
  get ready() { return this._ready; }

  /** The shared high-frequency detail normal — layer this on everything at 8..40 repeats/m. */
  get detailNormal() {
    if (!this._detailNormal) this._detailNormal = this.get('detail-normal').normalMap;
    return this._detailNormal;
  }

  /**
   * 128x128 RGBA blue-noise (void-and-cluster).  NearestFilter, RepeatWrapping, no mips.
   * R is the pattern; G/B/A are toroidal shifts of it (see _makeBlueNoise).  For temporal
   * dither offset the sample by the golden ratio per frame: `frac(v + frame * 0.6180339887)`.
   */
  get blueNoise() {
    if (!this._blueNoise) this._blueNoise = this._makeBlueNoise(128);
    return this._blueNoise;
  }

  /** 33^3 colour-grade LUT, 'night' | 'dawn' (ART_DIRECTION §7.3). Data3DTexture or null. */
  getLUT(name = 'night') {
    if (!this._luts.has(name)) this._makeLUT(name);
    return this._luts.get(name) ?? null;
  }

  /** Seconds fed to the animated water normal. Writable so Weather can slow the lake down. */
  get waterTime() { return this._waterTime; }
  set waterTime(v) { if (Number.isFinite(v)) this._waterTime = v; }

  // ------------------------------------------------------------------ bake rig

  _buildRig() {
    if (this._rig) return;
    const geom = new THREE.PlaneGeometry(2, 2);
    const scene = new THREE.Scene();
    const camera = new THREE.Camera();
    const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial());
    mesh.frustumCulled = false;
    scene.add(mesh);
    this._rig = { geom, scene, camera, mesh };
  }

  _material(name, def) {
    const seedBase = this.ctx?.settings?.get?.('seed') ?? 0;
    const seed = hashStr(`${name}|${seedBase}`) * 61.0;
    const frag = [
      PRELUDE,
      `#define AO_TAPS ${Math.max(3, def.taps | 0)}`,
      def.alpha ? '#define HAS_ALPHA' : '',
      NOISE,
      DECLS,
      M[name],
      MAIN,
    ].join('\n');

    return new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: frag,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uRes: { value: new THREE.Vector2(1, 1) },
        uNormalStrength: { value: def.relief / Math.max(def.tile, 1e-4) },
        uAOStrength: { value: def.ao },
        uCavity: { value: def.cavity },
        uToksvig: { value: def.toksvig },
        uSeed: { value: seed },
        uTime: { value: 0 },
        uHeightOnly: { value: 0 },
      },
    });
  }

  _bake(name) {
    const def = SET_DEFS[name];
    if (!def) throw new Error(`unknown texture set '${name}'`);
    const existing = this._sets.get(name);
    if (existing) return existing;

    const size = THREE.MathUtils.clamp(
      Math.round(this._baseRes * (SIZE_SCALE[def.size] ?? 0.5)), 64, 2048,
    );

    // MRT: albedo+opacity / normal+height / ORM+cavity.
    const rt = new THREE.WebGLRenderTarget(size, size, { ..._rtOpts, count: 3 });
    rt.texture.name = `${name}.albedo`;
    const [albedoTex, normalTex, ormTex] = rt.textures;
    _configure(albedoTex, THREE.SRGBColorSpace, this._maxAniso, `${name}.albedo`);
    _configure(normalTex, THREE.NoColorSpace, this._maxAniso, `${name}.normal`);
    _configure(ormTex, THREE.NoColorSpace, this._maxAniso, `${name}.orm`);

    let dispRt = null;
    if (def.disp) {
      const ds = Math.max(64, size >> 1);
      dispRt = new THREE.WebGLRenderTarget(ds, ds, { ..._rtOpts, count: 1 });
      _configure(dispRt.texture, THREE.NoColorSpace, 1, `${name}.height`);
      dispRt.texture.minFilter = THREE.LinearMipmapLinearFilter;
    }

    const material = this._material(name, def);
    this._rec.set(name, { rt, dispRt, material, size, def });

    this._render(name, 0);

    this._bytes += size * size * 4 * 3 * 1.34;
    if (dispRt) this._bytes += (size >> 1) * (size >> 1) * 4 * 1.34;

    const set = Object.freeze({
      name,
      map: albedoTex,
      normalMap: normalTex,
      roughnessMap: ormTex,
      metalnessMap: ormTex,
      aoMap: ormTex,
      ormMap: ormTex,
      displacementMap: dispRt ? dispRt.texture : null,
      // Height is ALWAYS available in normalMap.a — that is what a parallax/POM shader reads.
      heightInNormalAlpha: true,
      relief: def.relief,
      tile: def.tile,
      resolution: size,
    });
    this._sets.set(name, set);
    this._cache.set(name, set);
    return set;
  }

  /** Render (or re-render) a set's targets. Restores whatever render state it found. */
  _render(name, time) {
    const rec = this._rec.get(name);
    if (!rec) return;
    const renderer = this.ctx?.renderer;
    if (!renderer) return;
    const { rt, dispRt, material, size } = rec;
    const rig = this._rig;
    if (!rig) return;

    const prevRT = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;

    rig.mesh.material = material;
    material.uniforms.uTime.value = time ?? 0;

    try {
      material.uniforms.uRes.value.set(size, size);
      material.uniforms.uHeightOnly.value = 0;
      renderer.setRenderTarget(rt);
      renderer.render(rig.scene, rig.camera);

      if (dispRt) {
        const ds = dispRt.width;
        material.uniforms.uRes.value.set(ds, ds);
        material.uniforms.uHeightOnly.value = 1;
        renderer.setRenderTarget(dispRt);
        renderer.render(rig.scene, rig.camera);
        material.uniforms.uHeightOnly.value = 0;
      }
    } finally {
      renderer.setRenderTarget(prevRT);
      renderer.autoClear = prevAutoClear;
    }
  }

  // ------------------------------------------------------------------ views & fallback

  /**
   * A tiling view onto a baked set.  Render-target textures cannot be `.clone()`d (Three keeps
   * the GL handle in per-texture properties, so a clone would upload an empty image), but an
   * `ExternalTexture` wrapping the same GL handle binds correctly and carries its own uv
   * transform.  Wrap/filter/anisotropy are GL-object state and therefore shared — which is
   * fine, we set them identically for every consumer.  Falls back to the shared set if the
   * renderer internals ever move.
   */
  _makeView(base, opts) {
    const rep = _vec2(opts.repeat, 1, 1);
    const off = _vec2(opts.offset, 0, 0);
    const rot = Number.isFinite(opts.rotation) ? opts.rotation : 0;
    const wrap = (tex) => {
      const v = this._external(tex);
      if (!v || v === tex) return tex;
      v.repeat.set(rep.x, rep.y);
      v.offset.set(off.x, off.y);
      v.rotation = rot;
      v.center.set(0.5, 0.5);
      return v;
    };
    const orm = wrap(base.ormMap);
    return Object.freeze({
      ...base,
      map: wrap(base.map),
      normalMap: wrap(base.normalMap),
      roughnessMap: orm,
      metalnessMap: orm,
      aoMap: orm,
      ormMap: orm,
      displacementMap: base.displacementMap ? wrap(base.displacementMap) : null,
    });
  }

  _external(tex) {
    if (!tex) return null;
    if (typeof THREE.ExternalTexture !== 'function') return tex;
    try {
      const raw = this.ctx?.renderer?.properties?.get?.(tex)?.__webglTexture;
      if (!raw) return tex;
      const v = new THREE.ExternalTexture(raw);
      v.name = `${tex.name}#view`;
      v.wrapS = tex.wrapS; v.wrapT = tex.wrapT;
      v.minFilter = tex.minFilter; v.magFilter = tex.magFilter;
      v.anisotropy = tex.anisotropy;
      v.colorSpace = tex.colorSpace;
      v.flipY = false;
      v.generateMipmaps = false;
      // Do NOT touch needsUpdate: version must stay 0 or the renderer tries to upload it.
      this._views.push(v);
      return v;
    } catch (e) {
      Log.once('tex:view', 'Textures: could not build a tiling view — sharing the base texture.', e);
      return tex;
    }
  }

  /** 1x1 flat textures so a missing bakery never crashes a consumer. */
  _fallbackSet() {
    if (this._fallback) return this._fallback;
    const mk = (r, g, b, a, srgb, name) => {
      const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1);
      t.name = name;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.needsUpdate = true;
      return t;
    };
    const orm = mk(255, 200, 0, 255, false, 'fallback.orm');
    this._fallback = Object.freeze({
      name: 'fallback',
      map: mk(110, 108, 100, 255, true, 'fallback.albedo'),
      normalMap: mk(128, 128, 255, 128, false, 'fallback.normal'),
      roughnessMap: orm, metalnessMap: orm, aoMap: orm, ormMap: orm,
      displacementMap: null,
      heightInNormalAlpha: true,
      relief: 0, tile: 1, resolution: 1,
    });
    return this._fallback;
  }

  // ------------------------------------------------------------------ blue noise

  /**
   * Void-and-cluster blue noise (Ulichney 1993).  Real blue noise, not white noise with a
   * high-pass: the void-and-cluster ranking guarantees that every threshold slice of the
   * pattern is itself well-distributed, which is exactly the property dithering needs.
   *
   * Implementation note: the naive algorithm rescans all N pixels for the extremum every
   * iteration (N^2 = 268 M compares at 128^2 — about a second of JS).  We keep three
   * per-row extremum caches (max-over-ones, min-over-zeros, max-over-zeros) and only
   * recompute the <=11 rows a splat touched, which drops it to ~35 M and about 80 ms.
   *
   * R is the pattern.  G/B/A are toroidal shifts of it by coprime offsets — cheap
   * decorrelation for multi-channel dither/grain.  They are NOT independent patterns;
   * for per-channel film grain, also offset temporally by the golden ratio.
   */
  _makeBlueNoise(S = 128) {
    const N = S * S;
    const rank = new Int32Array(N).fill(-1);
    const t0 = performance.now();
    const BUDGET_MS = 1400;

    try {
      const R = 4, KW = 2 * R + 1, SIGMA = 1.5;
      const K = new Float32Array(KW * KW);
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          K[(dy + R) * KW + (dx + R)] = Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA));
        }
      }
      const E = new Float32Array(N);
      const B = new Uint8Array(N);
      const cb = [new Float32Array(S), new Float32Array(S), new Float32Array(S)];
      const ci = [new Int32Array(S), new Int32Array(S), new Int32Array(S)];
      const dr = [new Uint8Array(S), new Uint8Array(S), new Uint8Array(S)];
      const markAll = () => { dr[0].fill(1); dr[1].fill(1); dr[2].fill(1); };
      markAll();

      const splat = (idx, sign) => {
        const cx = idx % S, cy = (idx / S) | 0;
        for (let dy = -R; dy <= R; dy++) {
          const y = (cy + dy + S) % S;
          const row = y * S, krow = (dy + R) * KW;
          for (let dx = -R; dx <= R; dx++) {
            E[row + ((cx + dx + S) % S)] += sign * K[krow + dx + R];
          }
          dr[0][y] = 1; dr[1][y] = 1; dr[2][y] = 1;
        }
      };

      // mode 0: max over B==1 | 1: min over B==0 | 2: max over B==0
      const find = (mode) => {
        const wantMax = mode !== 1;
        const want1 = mode === 0 ? 1 : 0;
        const cbm = cb[mode], cim = ci[mode], drm = dr[mode];
        for (let y = 0; y < S; y++) {
          if (!drm[y]) continue;
          let best = wantMax ? -Infinity : Infinity, bi = -1;
          const row = y * S;
          for (let x = 0; x < S; x++) {
            const i = row + x;
            if (B[i] !== want1) continue;
            const e = E[i];
            if (wantMax ? e > best : e < best) { best = e; bi = i; }
          }
          cbm[y] = best; cim[y] = bi; drm[y] = 0;
        }
        let best = wantMax ? -Infinity : Infinity, bi = -1;
        for (let y = 0; y < S; y++) {
          if (cim[y] < 0) continue;
          const e = cbm[y];
          if (wantMax ? e > best : e < best) { best = e; bi = cim[y]; }
        }
        return bi;
      };

      const seed = this.ctx?.settings?.get?.('seed') ?? 0x51a5cab;
      const rnd = new Rand((seed ^ 0x8dedbeef) | 0);
      const Mones = Math.max(1, Math.round(N * 0.1));

      let placed = 0;
      while (placed < Mones) {
        const i = rnd.int(0, N - 1);
        if (B[i]) continue;
        B[i] = 1; splat(i, 1); placed++;
      }

      // relax the initial pattern: move the tightest cluster into the largest void
      for (let it = 0; it < 4096; it++) {
        const c = find(0);
        if (c < 0) break;
        B[c] = 0; splat(c, -1);
        const v = find(1);
        if (v < 0 || v === c) { B[c] = 1; splat(c, 1); break; }
        B[v] = 1; splat(v, 1);
      }

      const initial = B.slice();

      // Phase I — strip clusters, ranking downward from M-1.
      for (let r = Mones - 1; r >= 0; r--) {
        const c = find(0);
        if (c < 0) break;
        B[c] = 0; splat(c, -1); rank[c] = r;
      }

      // restore, then Phase II — fill the largest voids up to half density.
      B.set(initial);
      E.fill(0); markAll();
      for (let i = 0; i < N; i++) if (B[i]) splat(i, 1);
      const half = N >> 1;
      for (let r = Mones; r < half; r++) {
        const v = find(1);
        if (v < 0) break;
        B[v] = 1; splat(v, 1); rank[v] = r;
      }

      // Phase III — the minority is now the ZEROS: re-energise over them and strip their
      // tightest clusters, which is the largest void of the original pattern.
      E.fill(0); markAll();
      for (let i = 0; i < N; i++) if (!B[i]) splat(i, 1);
      for (let r = half; r < N; r++) {
        if ((r & 1023) === 0 && performance.now() - t0 > BUDGET_MS) {
          Log.warn('Textures: blue-noise budget exceeded — filling the tail stochastically.');
          break;
        }
        const v = find(2);
        if (v < 0) break;
        B[v] = 1; splat(v, -1); rank[v] = r;
      }
    } catch (e) {
      Log.warn('Textures: void-and-cluster failed — falling back to hashed noise.', e);
    }

    // Any unranked pixel (budget bail / failure) gets a deterministic pseudo-random rank.
    const rnd2 = new Rand(0x0b10e005);
    for (let i = 0; i < N; i++) if (rank[i] < 0) rank[i] = rnd2.int(0, N - 1);

    const data = new Uint8Array(N * 4);
    const shifts = [[0, 0], [37, 17], [71, 89], [109, 53]];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const o = (y * S + x) * 4;
        for (let c = 0; c < 4; c++) {
          const sx = (x + shifts[c][0]) % S;
          const sy = (y + shifts[c][1]) % S;
          data[o + c] = Math.min(255, Math.floor((rank[sy * S + sx] / N) * 256));
        }
      }
    }

    const tex = new THREE.DataTexture(data, S, S);
    tex.name = 'blue-noise-128';
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    tex.colorSpace = THREE.NoColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    Log.debug(`Textures: blue noise ${S}x${S} in ${(performance.now() - t0).toFixed(0)} ms`);
    return tex;
  }

  // ------------------------------------------------------------------ grade LUT

  /** ART_DIRECTION §7.3 lift/gamma/gain + split saturation, baked to a 33^3 Data3DTexture. */
  _makeLUT(name) {
    if (this._luts.has(name)) return this._luts.get(name);
    const dawn = name === 'dawn';
    const lift = dawn ? [0, 0, 0] : [-0.004, 0.002, 0.014];
    const gamma = dawn ? [1.0, 1.0, 1.0] : [1.02, 1.0, 0.96];
    const gain = dawn ? [1.10, 1.0, 0.86] : [1.06, 1.0, 0.92];
    const sat = dawn ? 0.94 : 0.86;

    const SZ = 33, N = SZ * SZ * SZ;
    const data = new Uint8Array(N * 4);
    const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let i = 0;
    for (let bz = 0; bz < SZ; bz++) {
      for (let gy = 0; gy < SZ; gy++) {
        for (let rx = 0; rx < SZ; rx++) {
          let c = [rx / (SZ - 1), gy / (SZ - 1), bz / (SZ - 1)];
          for (let k = 0; k < 3; k++) {
            let v = (c[k] + lift[k]) * gain[k];
            v = v <= 0 ? 0 : Math.pow(v, 1 / gamma[k]);
            c[k] = v;
          }
          let L = lum(c[0], c[1], c[2]);
          // Split saturation: crushed shadows keep their blue-green, fire cores go creamy.
          let s = sat;
          if (L < 0.08) s = dawn ? 1.06 : 1.18;
          else if (L > 0.75) s = dawn ? 0.82 : 0.70;
          for (let k = 0; k < 3; k++) c[k] = L + (c[k] - L) * s;
          data[i++] = _u8(c[0]);
          data[i++] = _u8(c[1]);
          data[i++] = _u8(c[2]);
          data[i++] = 255;
        }
      }
    }
    const tex = new THREE.Data3DTexture(data, SZ, SZ, SZ);
    tex.name = `lut-${name}`;
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    tex.colorSpace = THREE.NoColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this._luts.set(name, tex);
    return tex;
  }

  // ------------------------------------------------------------------ ?texdebug

  _installDebug() {
    if (this._debugInstalled) return;
    let want = false;
    try { want = (globalThis.location?.search ?? '').includes('texdebug'); } catch { want = false; }
    if (!want) return;
    this._debugInstalled = true;
    globalThis.__TEXDEBUG__ = (opts) => this.debugGrid(opts);
    Log.info('Textures: ?texdebug — call window.__TEXDEBUG__() for the inspection grid.');
  }

  /**
   * Read every baked attachment back and lay it out as a DOM grid of canvases so a critic can
   * inspect albedo / normal / ORM / height at pixel level.  Returns the container element;
   * pass { attach: true } to have it appended to document.body.
   */
  debugGrid({ cell = 220, attach = false, only = null } = {}) {
    const wrap = globalThis.document?.createElement?.('div');
    if (!wrap) return null;
    wrap.style.cssText =
      'position:fixed;inset:0;overflow:auto;z-index:99999;background:#0a1216;' +
      'font:11px/1.4 ui-monospace,Menlo,monospace;color:#aebcdc;padding:12px;' +
      'display:grid;grid-template-columns:repeat(auto-fill,minmax(' + cell + 'px,1fr));gap:10px';

    const renderer = this.ctx?.renderer;
    const names = only ? [].concat(only) : [...this._rec.keys()];
    for (const name of names) {
      const rec = this._rec.get(name);
      if (!rec) continue;
      const layers = [
        ['albedo', rec.rt, 0, rec.size],
        ['normal', rec.rt, 1, rec.size],
        ['ORM (r=ao g=rough b=metal)', rec.rt, 2, rec.size],
      ];
      if (rec.dispRt) layers.push(['height', rec.dispRt, 0, rec.dispRt.width]);
      for (const [label, rt, idx, sz] of layers) {
        const box = globalThis.document.createElement('div');
        const cv = globalThis.document.createElement('canvas');
        cv.width = cv.height = cell;
        cv.style.cssText = 'width:100%;height:auto;image-rendering:pixelated;background:#000;border:1px solid #243740';
        try {
          const buf = new Uint8Array(sz * sz * 4);
          renderer.readRenderTargetPixels(rt, 0, 0, sz, sz, buf, 0, idx);
          const src = globalThis.document.createElement('canvas');
          src.width = sz; src.height = sz;
          const sctx = src.getContext('2d');
          const img = sctx.createImageData(sz, sz);
          img.data.set(buf);
          sctx.putImageData(img, 0, 0);
          const c2 = cv.getContext('2d');
          // readRenderTargetPixels is bottom-up; flip so the grid matches the texture.
          c2.translate(0, cell);
          c2.scale(1, -1);
          c2.drawImage(src, 0, 0, cell, cell);
        } catch (e) {
          Log.warn(`Textures.debugGrid: readback failed for ${name}/${label}`, e);
        }
        const cap = globalThis.document.createElement('div');
        cap.textContent = `${name} · ${label} · ${sz}px`;
        cap.style.cssText = 'margin-top:4px;color:#7d95c4;word-break:break-word';
        box.appendChild(cv);
        box.appendChild(cap);
        wrap.appendChild(box);
      }
    }
    if (attach) globalThis.document.body.appendChild(wrap);
    return wrap;
  }

  // ------------------------------------------------------------------ teardown

  dispose() {
    for (const rec of this._rec.values()) {
      try { rec.rt?.dispose(); } catch { /* ignore */ }
      try { rec.dispRt?.dispose(); } catch { /* ignore */ }
      try { rec.material?.dispose(); } catch { /* ignore */ }
    }
    this._rec.clear();
    this._sets.clear();
    this._cache.clear();

    // Views wrap a GL handle owned by a render target — never dispose them, just unhook.
    for (const v of this._views) { v.sourceTexture = null; }
    this._views.length = 0;

    try { this._rig?.geom?.dispose(); } catch { /* ignore */ }
    try { this._rig?.mesh?.material?.dispose?.(); } catch { /* ignore */ }
    this._rig = null;

    try { this._blueNoise?.dispose(); } catch { /* ignore */ }
    this._blueNoise = null;
    for (const t of this._luts.values()) { try { t.dispose(); } catch { /* ignore */ } }
    this._luts.clear();

    if (this._fallback) {
      for (const k of ['map', 'normalMap', 'ormMap']) {
        try { this._fallback[k]?.dispose(); } catch { /* ignore */ }
      }
      this._fallback = null;
    }
    this._detailNormal = null;
    this._ready = false;
    this._waterLive = false;
    if (globalThis.__TEXDEBUG__) delete globalThis.__TEXDEBUG__;
    this._debugInstalled = false;
  }
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function _configure(tex, colorSpace, aniso, name) {
  tex.name = name;
  tex.colorSpace = colorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = Math.max(1, aniso | 0);
  tex.flipY = false;
}

function _vec2(v, dx, dy) {
  if (!v) return { x: dx, y: dy };
  if (Array.isArray(v)) return { x: v[0] ?? dx, y: v[1] ?? v[0] ?? dy };
  if (typeof v === 'number') return { x: v, y: v };
  return { x: v.x ?? dx, y: v.y ?? dy };
}

function _cacheKey(name, opts) {
  if (!opts || (!opts.repeat && !opts.offset && opts.rotation === undefined)) return name;
  const r = _vec2(opts.repeat, 1, 1);
  const o = _vec2(opts.offset, 0, 0);
  const rot = Number.isFinite(opts.rotation) ? opts.rotation : 0;
  return `${name}@${r.x},${r.y}|${o.x},${o.y}|${rot}`;
}

function _u8(v) {
  return Math.max(0, Math.min(255, Math.round((v <= 0 ? 0 : v >= 1 ? 1 : v) * 255)));
}

/**
 * Yield to the browser between material bakes.
 * NOT requestAnimationFrame: a hidden/background tab throttles rAF to ~1 Hz, which would turn
 * a 1 s bake into a 20 s stall if the player alt-tabs during loading.  A MessageChannel task is
 * a real macrotask (the browser can paint and service input) and is never throttled.
 */
function _nextTick() {
  return new Promise((resolve) => {
    try {
      if (typeof MessageChannel === 'function') {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
        ch.port2.postMessage(0);
        return;
      }
    } catch { /* fall through */ }
    setTimeout(resolve, 0);
  });
}

export default Textures;

