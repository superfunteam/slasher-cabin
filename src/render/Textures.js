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
// Lacunarity is fixed at 2.0 so `per` doubles with the frequency and stays an integer.
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

  oAlbedo = vec4(clamp(s.albedo, 0.0, 1.0), 1.0);
  oNormal = vec4(clamp(n * 0.5 + 0.5 + dth, 0.0, 1.0), h);
  oORM    = vec4(clamp(s.ao, 0.0, 1.0), s.rough, clamp(s.metal, 0.0, 1.0), cav);
}
`;

//__CHUNK__
