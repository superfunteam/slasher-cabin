/**
 * Props — Camp Wanaka Pines, the lumber pile, the homestead ruin, and every scattered object.
 *
 * OWNER: World agent.  ARCHITECTURE.md §9 / §12, ART_DIRECTION.md §2, §3.2, §4.4, §6.
 *
 * ---------------------------------------------------------------------------------------------
 * PUBLIC API
 * ---------------------------------------------------------------------------------------------
 *   new Props(ctx) ; await init() ; update(dt, elapsed) ; resize(w,h) ; dispose()
 *
 *   props.lights          THREE.Light[]  — the campfire + the sodium lamp are REAL scene lights;
 *                                          the tent / window glows are fog-proxy lights that are
 *                                          deliberately NOT added to the scene (see below).
 *                                          Consumed by VolumetricFog and Navmesh._collectLights.
 *   props.interactables   [{position:Vector3, id:string, kind:string}]  for BuildSystem.
 *   props.partSites       Map<string,Vector3> — the nine authored part locations, ART §4.4.
 *   props.anchors         Map<string,Vector3> — navigation anchors, read by Navmesh._rawAnchor.
 *   props.getAnchor(name) Vector3|null
 *   props.group           THREE.Group, identity transform, added to ctx.scene.
 *   props.firePosition    Vector3 — the campfire, for Audio / Campers.
 *
 * ---------------------------------------------------------------------------------------------
 * THINGS OTHER AGENTS MUST KNOW
 * ---------------------------------------------------------------------------------------------
 * 1. ZERO PointLights are added to the scene (ART §3.6: Materials compiles MAX_POINT 0). Props
 *    asserts this in init() by walking the scene and warning about any it finds. The camp adds
 *    exactly THREE SpotLights: campfire key, campfire fill, mess-hall sodium lamp.
 * 2. FOG-PROXY LIGHTS. Tent lanterns and lit cabin windows are baked as emissive geometry plus
 *    an additive glow shell — not as real lights, because a real light per tent would blow the
 *    forward-renderer light budget for every material in the game. They still need to scatter in
 *    VolumetricFog, so `lights` also contains PointLights that were never added to the scene.
 *    They carry `userData.fogProxy === true` and `userData.inScene === false`. If you add one to
 *    the scene you will trigger a full shader recompile and break the §3.6 budget.
 * 3. Materials are SHARED — never dispose one you got from `Materials.get()`. Props owns exactly
 *    eight materials of its own (flame, ember, smoke, coal, glow-canvas, glow-window, glow-fire,
 *    contact-decal) plus a stain overlay and four fabric materials opted in through
 *    `Materials.patchMaterial()` (cloth, cloth-warm, tarp-sheet, canvas-lit). `_auditMaterials()`
 *    runs in init() and names, at WARN level, every key that resolved to an untextured fallback —
 *    the silent-grey-boxes failure is now impossible to have without a log line saying so.
 * 3b. The overlay decals in `public/img/decal-*.png` are the ONLY fetched art in this file. They
 *    are loaded fire-and-forget after init(); the stain mesh stays hidden until one lands, so the
 *    game still satisfies "zero binary art assets required" (ARCHITECTURE §1).
 * 4. Geometry UVs are authored IN METRES (Materials.js requires this) — computed from the
 *    world-space position and dominant normal axis after transform, so every box in the camp
 *    gets correct texel density at 10 cm and at 10 m with no per-object UV authoring.
 * 5. CONTACT DARKENING is a single InstancedMesh of multiply-blended decals under every prop.
 *    Nothing in this file floats.
 * 6. STORY COORDINATES. `Script.props` places objects in a frame whose datum is the cabin site
 *    and whose camp sits at datum+(132,74). Terrain puts the camp at datum+(264,-146), so the
 *    story frame is only locally valid. Near-site props are placed at their literal offsets from
 *    `Terrain.buildSiteCenter`; the five camp/water props are re-anchored onto the real camp and
 *    dock (see STORY_ANCHOR). Everything is clamped into `Terrain.bounds`.
 *
 * GLSL LIVES IN TEMPLATE LITERALS. Never put a backtick in a shader comment (ARCHITECTURE §11b);
 * never include <colorspace_pars_fragment> or <tonemapping_pars_fragment> — WebGLProgram already
 * injects both and a second copy is a link error that node --check cannot see.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Log } from '../core/Log.js';
import { Rand, hashStr } from '../core/Rand.js';

/* ==============================================================================================
 * Module-scope scratch — ARCHITECTURE.md §12: no allocation in update().
 * ============================================================================================ */
const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _m4b = new THREE.Matrix4();
const _e = new THREE.Euler();
const _up = new THREE.Vector3(0, 1, 0);
const _col = new THREE.Color();

/** ART_DIRECTION.md §2.2 — sRGB display values. THREE.Color converts to linear for us. */
const PAL = {
  fireCore: 0xffca7a,
  fireMid: 0xff9d4a,
  fireEmber: 0xc9421a,
  coalDark: 0x1a0e08,
  lantern: 0xffb865,
  sodium: 0xff8a2b,
  garmentWarm: 0xc4643a,
  chalk: 0xcfd3cc,
  paper: 0xf2efe6,
};

/** Shared-library material keys (src/render/Materials.js SPECS + ALIASES). */
const M = {
  wood: 'weathered-wood',
  lumber: 'sawn-lumber',
  tin: 'corrugated-tin',
  stone: 'granite',
  steel: 'galvanized-steel',
  rust: 'rusted-steel',
  canvas: 'canvas',
  tarp: 'tarp-plastic',
  rope: 'rope',
  glass: 'glass-dirty',
  concrete: 'concrete',
  bark: 'bark-pine',
  leaf: 'foliage-fern',
};

/* ==============================================================================================
 * Deterministic 1D value noise for the fire flicker. ARCHITECTURE §6: never Math.random().
 * ============================================================================================ */
function ihash1(n) {
  let x = Math.imul(n | 0, 0x27d4eb2d);
  x ^= x >>> 15; x = Math.imul(x, 0x2c1b3c6d);
  x ^= x >>> 13; x = Math.imul(x, 0x297a2d39);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
function vnoise1(t) {
  const i = Math.floor(t), f = t - i;
  const u = f * f * (3 - 2 * f);
  const a = ihash1(i), b = ihash1(i + 1);
  return a + (b - a) * u;
}
/** Sum of three octaves, roughly -1..1. A real flicker model, not per-frame randomness. */
function flicker3(t, seed) {
  return ((vnoise1(t * 1.7 + seed) - 0.5) * 0.55
    + (vnoise1(t * 4.3 + seed * 3.1) - 0.5) * 0.30
    + (vnoise1(t * 11.0 + seed * 7.7) - 0.5) * 0.15) * 2.6;
}

/* ==============================================================================================
 * GLSL
 * ============================================================================================ */
const NOISE_GLSL = /* glsl */`
float scHash21(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float scVal(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = scHash21(i), b = scHash21(i + vec2(1.0, 0.0));
  float c = scHash21(i + vec2(0.0, 1.0)), d = scHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float scFbm(vec2 p){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * scVal(p); p *= 2.03; a *= 0.5; }
  return s;
}
`;

const FLAME_VERT = /* glsl */`
uniform float uTime;
uniform float uFlicker;
attribute vec2 aCorner;
attribute vec4 aInfo;      // x seed, y layer 0..1, z half-width, w height
varying vec2 vUv;
varying float vSeed;
varying float vLayer;
varying float vDepth;
void main(){
  float seed = aInfo.x;
  float layer = aInfo.y;
  float t = uTime * (0.65 + 0.45 * layer) + seed * 7.3;
  float sway = sin(t * 1.9 + seed * 11.0) * 0.20 + sin(t * 3.7 + seed * 5.0) * 0.09;
  float pulse = 0.74 + 0.20 * sin(t * 4.1 + seed * 3.0) + 0.12 * sin(t * 7.9 + seed * 9.0);
  pulse *= mix(1.0, uFlicker, 0.75);
  float w = aInfo.z * (0.86 + 0.30 * pulse);
  float h = aInfo.w * pulse;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  mv.x += aCorner.x * w + sway * aCorner.y * h * 0.85;
  mv.y += aCorner.y * h;
  gl_Position = projectionMatrix * mv;
  vUv = vec2(aCorner.x + 0.5, aCorner.y);
  vSeed = seed;
  vLayer = layer;
  vDepth = -mv.z;
}
`;

const FLAME_FRAG = /* glsl */`
${NOISE_GLSL}
uniform float uTime;
uniform float uIntensity;
uniform float uFogK;
uniform vec3 uCore;
uniform vec3 uMid;
uniform vec3 uEmber;
varying vec2 vUv;
varying float vSeed;
varying float vLayer;
varying float vDepth;
void main(){
  vec2 uv = vUv;
  float x = uv.x * 2.0 - 1.0;
  float taper = 1.0 - pow(clamp(uv.y, 0.0, 1.0), 0.72);
  float body = 1.0 - smoothstep(0.0, 1.0, abs(x) / max(taper, 0.035));
  float n = scFbm(vec2(uv.x * 3.1 + vSeed * 17.0, uv.y * 2.6 - uTime * (1.6 + vLayer * 1.1) + vSeed * 5.0));
  float f = body * (0.50 + 0.95 * n);
  f *= smoothstep(0.0, 0.07, uv.y);
  f *= 1.0 - smoothstep(0.52, 1.0, uv.y);
  f = max(f - 0.17, 0.0) * 1.75;
  vec3 col = mix(uEmber, uMid, smoothstep(0.0, 0.45, f));
  col = mix(col, uCore, smoothstep(0.42, 1.0, f));
  float a = f * uIntensity * (1.0 - vLayer * 0.32) * exp(-vDepth * uFogK);
  gl_FragColor = vec4(col * a, 1.0);
}
`;

const EMBER_VERT = /* glsl */`
uniform float uTime;
uniform float uProjScale;
uniform vec3 uWind;
attribute vec3 aSeed;      // x seed, y 1/lifetime, z rise height
varying float vLife;
varying float vSeed;
varying float vDepth;
void main(){
  float seed = aSeed.x;
  float life = fract(uTime * aSeed.y + seed);
  vLife = life;
  vSeed = seed;
  float rise = life * life * 0.55 + life * 0.45;
  vec3 p = position;
  p.y += rise * aSeed.z;
  float sp = 0.30 + life * 1.5;
  p.x += (sin(life * 9.0 + seed * 23.0) * 0.36 + sin(life * 19.0 + seed * 3.0) * 0.14) * sp
       + uWind.x * life * life * 2.4;
  p.z += (cos(life * 7.3 + seed * 13.0) * 0.34 + cos(life * 17.0 + seed * 5.0) * 0.12) * sp
       + uWind.z * life * life * 2.4;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vDepth = -mv.z;
  gl_PointSize = clamp((0.055 * (1.0 - life * 0.55)) * uProjScale / max(vDepth, 0.35), 1.0, 42.0);
}
`;

const EMBER_FRAG = /* glsl */`
uniform float uIntensity;
uniform float uFogK;
uniform vec3 uCore;
uniform vec3 uEmber;
varying float vLife;
varying float vSeed;
varying float vDepth;
void main(){
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = 1.0 - smoothstep(0.15, 1.0, d);
  a *= a;
  float flick = 0.55 + 0.45 * sin(vLife * 46.0 + vSeed * 31.0);
  a *= pow(1.0 - vLife, 1.5) * flick * uIntensity * exp(-vDepth * uFogK);
  vec3 col = mix(uCore, uEmber, smoothstep(0.05, 0.7, vLife));
  gl_FragColor = vec4(col * a, 1.0);
}
`;

const COAL_VERT = /* glsl */`
varying vec3 vLocal;
varying float vDepth;
void main(){
  vLocal = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const COAL_FRAG = /* glsl */`
${NOISE_GLSL}
uniform float uTime;
uniform float uFlicker;
uniform float uRadius;
uniform float uFogK;
uniform vec3 uCore;
uniform vec3 uEmber;
uniform vec3 uDark;
varying vec3 vLocal;
varying float vDepth;
void main(){
  vec2 p = vLocal.xz;
  float n = scFbm(p * 6.5);
  float n2 = scFbm(p * 21.0 + 11.3);
  float crack = smoothstep(0.52, 0.30, n) * (0.55 + 0.45 * smoothstep(0.60, 0.35, n2));
  float breathe = 0.62 + 0.38 * sin(uTime * 1.6 + n * 24.0) * uFlicker;
  float r = length(p) / max(uRadius, 0.05);
  float heat = crack * breathe * (1.0 - smoothstep(0.45, 1.05, r));
  vec3 col = uDark * 0.35 + uEmber * (heat * 2.4) + uCore * (pow(heat, 3.0) * 5.0);
  gl_FragColor = vec4(col * exp(-vDepth * uFogK * 0.5), 1.0);
}
`;

const GLOW_VERT = /* glsl */`
attribute float aGlow;
varying float vGlow;
varying vec2 vUv;
varying float vDepth;
void main(){
  vGlow = aGlow;
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

/*
 * The additive shell that makes a lit tent glow. Two rules learned the hard way:
 *
 *  - It may only ever be a MODULATION of a surface that is already visible. An additive shell
 *    laid over canvas that renders near-black is not a glowing tent, it is a flat orange card
 *    floating in the dark, with a hard polygon silhouette and nothing inside it. That is why
 *    the lit tents now use the emissive 'canvas-lit' material (see _makeOwnMaterials) and this
 *    shell only adds the lamp's near-field gradient on top.
 *  - Under SC_GLOW_TEX it is multiplied by the canvas colour map, normalised against
 *    uTexRef, so the weave, the mildew blooms and the patched panels show up IN the light.
 *    Flat colour reads as a card; modulated colour reads as cloth.
 */
const GLOW_FRAG = /* glsl */`
${NOISE_GLSL}
uniform vec3 uColor;
uniform float uIntensity;
uniform float uFlicker;
uniform float uFogK;
uniform vec2 uSeam;        // x period in metres, y strength
#ifdef SC_GLOW_TEX
uniform sampler2D uTex;
uniform float uTexAmt;
uniform float uTexRef;
#endif
varying float vGlow;
varying vec2 vUv;
varying float vDepth;
void main(){
  float g = vGlow * uIntensity * uFlicker;
  if (uSeam.y > 0.0) {
    float s = abs(fract(vUv.x / max(uSeam.x, 0.05)) - 0.5) * 2.0;
    float t = abs(fract(vUv.y / max(uSeam.x * 1.6, 0.05)) - 0.5) * 2.0;
    g *= 1.0 - uSeam.y * (smoothstep(0.86, 1.0, s) + smoothstep(0.92, 1.0, t) * 0.6);
  }
  g *= 0.90 + 0.10 * scVal(vUv * 28.0);
  vec3 tint = uColor;
  #ifdef SC_GLOW_TEX
    vec3 weave = texture2D(uTex, vUv).rgb;
    float lum = dot(weave, vec3(0.2126, 0.7152, 0.0722));
    float m = clamp(lum / max(uTexRef, 0.001), 0.42, 1.75);
    g *= mix(1.0, m, uTexAmt);
    tint *= mix(vec3(1.0), weave / max(lum, 0.002), uTexAmt * 0.40);
  #endif
  gl_FragColor = vec4(tint * max(g, 0.0) * exp(-vDepth * uFogK), 1.0);
}
`;

const DECAL_VERT = /* glsl */`
varying vec2 vUv;
varying float vDepth;
void main(){
  vUv = uv;
  #ifdef USE_INSTANCING
    vec4 wp = instanceMatrix * vec4(position, 1.0);
  #else
    vec4 wp = vec4(position, 1.0);
  #endif
  vec4 mv = modelViewMatrix * wp;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

/*
 * Contact darkening. This used to emit vec3(1.0 - a) with MultiplyBlending, which is
 * mathematically the same darkening BUT the fragment itself is near-WHITE everywhere the
 * decal does nothing (the whole outside of the radial falloff, i.e. the corners of every
 * quad). The instant anything upstream does not honour the multiply blend equation for this
 * draw — an MRT/prepass, a depth-only pass, a state-cache miss — 265 white plates appear
 * lying flat on the ground across the camp. They did. That is the "sheets of paper on the
 * grass" defect.
 *
 * The safe formulation is the identical operation written as premultiplied-free straight
 * alpha over BLACK:  dst = 0 * a + dst * (1 - a)  ==  dst * (1 - a).
 * Same maths, and the worst case if a pass ignores blending is an invisible black smudge
 * on already-black ground rather than a blown white card.
 */
const DECAL_FRAG = /* glsl */`
uniform float uStrength;
uniform vec2 uFade;
varying vec2 vUv;
varying float vDepth;
void main(){
  float d = length(vUv - 0.5) * 2.0;
  float a = 1.0 - smoothstep(0.06, 1.0, d);
  a = pow(a, 1.5) * uStrength;
  a *= 1.0 - smoothstep(uFade.x, uFade.y, vDepth);
  if (a < 0.004) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}
`;

/*
 * STAIN OVERLAY. The three public/img decals are RGB with no alpha channel, so the only honest
 * way to use them at night is as a darkening mask: pull a mask out of luminance, remap it with a
 * contrast window, and emit black with that as straight alpha. Identical safety property to
 * DECAL_FRAG — if any pass ignores blending the worst case is a black smudge, never a white card.
 */
const STAIN_VERT = /* glsl */`
attribute vec4 aStainUv;   // xy uv scale, zw uv offset — one sub-rect of the atlas per instance
varying vec2 vUv;
varying vec2 vQuad;
varying float vDepth;
void main(){
  vQuad = uv;
  vUv = uv * aStainUv.xy + aStainUv.zw;
  vec4 wp = instanceMatrix * vec4(position, 1.0);
  vec4 mv = modelViewMatrix * wp;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const STAIN_FRAG = /* glsl */`
uniform sampler2D uTex;
uniform float uStrength;
uniform vec2 uContrast;     // x low, y high — the luminance window that becomes 0..1 stain
uniform vec2 uFade;
varying vec2 vUv;
varying vec2 vQuad;
varying float vDepth;
void main(){
  vec3 t = texture2D(uTex, vUv).rgb;
  float lum = dot(t, vec3(0.2126, 0.7152, 0.0722));
  float m = 1.0 - smoothstep(uContrast.x, uContrast.y, lum);
  // feather the quad edges so a stain never shows its own rectangle
  vec2 e = min(vQuad, 1.0 - vQuad) * 2.0;
  float edge = smoothstep(0.0, 0.34, min(e.x, e.y));
  float a = m * edge * uStrength * (1.0 - smoothstep(uFade.x, uFade.y, vDepth));
  if (a < 0.004) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}
`;

/*
 * Woodsmoke. Additive on purpose: smoke over a near-black sky is only visible because the fire
 * lights it from below, and additive can only ever brighten — so the failure mode is "invisible"
 * rather than "grey polygon". Density falls off with height and the column shears with uWind.
 */
const SMOKE_VERT = /* glsl */`
uniform float uTime;
uniform vec3 uWind;
attribute vec2 aCorner;
attribute vec3 aInfo;      // x seed, y 1/lifetime, z base half-width
varying vec2 vUv;
varying float vLife;
varying float vSeed;
varying float vDepth;
void main(){
  float seed = aInfo.x;
  float life = fract(uTime * aInfo.y + seed);
  float rise = life * 5.2;
  float grow = aInfo.z * (0.35 + life * 2.6);
  vec3 p = position;
  p.y += rise;
  p.x += (sin(life * 3.1 + seed * 19.0) * 0.42) * life + uWind.x * life * life * 3.4;
  p.z += (cos(life * 2.7 + seed * 11.0) * 0.40) * life + uWind.z * life * life * 3.4;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  mv.xy += aCorner * grow;
  gl_Position = projectionMatrix * mv;
  vUv = aCorner + 0.5;
  vLife = life;
  vSeed = seed;
  vDepth = -mv.z;
}
`;

const SMOKE_FRAG = /* glsl */`
${NOISE_GLSL}
uniform float uTime;
uniform float uIntensity;
uniform float uFogK;
uniform vec3 uColor;
varying vec2 vUv;
varying float vLife;
varying float vSeed;
varying float vDepth;
void main(){
  float d = length(vUv - 0.5) * 2.0;
  float a = 1.0 - smoothstep(0.10, 1.0, d);
  a *= a;
  float n = scFbm(vUv * 3.4 + vec2(vSeed * 9.0, -uTime * 0.22));
  a *= 0.35 + 0.95 * n;
  // bright and tight at the coals, wide and gone by the canopy
  a *= (1.0 - vLife) * (1.0 - vLife) * (0.35 + 0.65 * smoothstep(0.0, 0.18, vLife));
  a *= uIntensity * exp(-vDepth * uFogK);
  gl_FragColor = vec4(uColor * a, 1.0);
}
`;

/* ==============================================================================================
 * Geometry helpers
 * ============================================================================================ */

/** Build a TRS matrix. Init-time only — allocates. */
function TRS(x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) {
  const m = new THREE.Matrix4();
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  m.compose(_v3.set(x, y, z), _q, _v3b.set(sx, sy, sz));
  return m;
}

/**
 * Rewrite UVs in METRES from world position + dominant normal axis. This is why every clapboard,
 * every plank and every stone in the camp has correct texel density without hand-authored UVs.
 */
function metricUV(geo, scale, ox, oz) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  if (!pos || !nor) return;
  const n = pos.count;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
    let u, v;
    if (nx >= ny && nx >= nz) { u = pz; v = py; }
    else if (ny >= nz) { u = px; v = pz; }
    else { u = px; v = py; }
    uv[i * 2] = u * scale + ox;
    uv[i * 2 + 1] = v * scale + oz;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Keep exactly the attribute set the merge expects. */
function trimGeo(geo, keepGlow) {
  for (const k of Object.keys(geo.attributes)) {
    if (k === 'position' || k === 'normal' || k === 'uv' || k === 'aExposure') continue;
    if (keepGlow && k === 'aGlow') continue;
    geo.deleteAttribute(k);
  }
  geo.morphAttributes = {};
  geo.clearGroups();
}

/** Taper a canoe/boat hull: squeeze the cross-section toward the bow and stern. */
function taperHull(geo, halfLen, power, keep) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const t = Math.min(1, Math.abs(x) / halfLen);
    const s = 1 - (1 - keep) * Math.pow(t, power);
    pos.setY(i, pos.getY(i) * s);
    pos.setZ(i, pos.getZ(i) * s);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

/** The three additive-glow pseudo-materials Kit understands. Resolved in Props._emit(). */
const GLOW_KEYS = { 'glow-canvas': 1, 'glow-window': 1, 'glow-fire': 1 };

/**
 * A cloth panel: a subdivided unit plane lying in local XZ (normal +Y), displaced in Y so it
 * sags and wrinkles like canvas under its own weight instead of reading as a flat plate.
 *
 * The displacement is in METRES and survives the TRS as long as the caller passes sy === 1 —
 * which is why every call site scales X and Z only. A tent roof made of two rigid boxes has a
 * perfectly straight ridge and a perfectly straight eave; that pair of straight lines is the
 * single strongest "this is a game asset" tell in the camp, and it is what this fixes.
 *
 * @param {number} segU,segV  subdivision
 * @param {number} sag        metres of droop at the panel centre (negative = down)
 * @param {number} wrinkle    metres of fine crease amplitude
 * @param {number} seed
 */
function clothPanel(segU, segV, sag, wrinkle, seed) {
  const g = new THREE.PlaneGeometry(1, 1, segU, segV);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i) + 0.5, v = p.getZ(i) + 0.5;
    const hold = Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
    const w = wrinkle * (
      0.52 * Math.sin(u * 21.7 + v * 8.3 + seed)
      + 0.30 * Math.sin(v * 33.1 - u * 6.9 + seed * 2.7)
      + 0.18 * (ihash1((((u * 256) | 0) * 149 + ((v * 256) | 0) + (seed * 71 | 0)) | 0) - 0.5) * 2
    );
    p.setY(i, sag * hold + w * Math.min(1, hold * 3.2));
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/**
 * Segment/AABB overlap. Used at INIT ONLY, to bake the shadow a camp cot and a duffel bag throw
 * onto the inside of a lit tent's canvas. A glowing tent with nothing in it is a lampshade; a
 * glowing tent with a black cot-shaped hole in the light is somebody's bed.
 * @param {object} b {cx,cy,cz,hx,hy,hz}
 */
function segHitsBox(lx, ly, lz, px, py, pz, b) {
  const d = [px - lx, py - ly, pz - lz];
  const o = [lx, ly, lz];
  const c = [b.cx, b.cy, b.cz];
  const h = [b.hx, b.hy, b.hz];
  let t0 = 0, t1 = 1;
  for (let a = 0; a < 3; a++) {
    const lo = c[a] - h[a], hi = c[a] + h[a];
    if (Math.abs(d[a]) < 1e-7) { if (o[a] < lo || o[a] > hi) return false; continue; }
    let ta = (lo - o[a]) / d[a], tb = (hi - o[a]) / d[a];
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Geometry accumulator. Everything the camp is made of goes through here, is transformed into
 * world space, gets metric UVs and an aExposure attribute, and is merged into one mesh per
 * material — which is what keeps the camp inside the 220-draw-call budget (ART §3.3).
 */
class Kit {
  constructor() {
    this.base = new THREE.Matrix4();
    this.groups = new Map();
    this._tmp = new THREE.Matrix4();
  }

  setBase(m) { this.base.copy(m); return this; }
  clearBase() { this.base.identity(); return this; }

  /**
   * @param {string} mat  shared-library material key, or 'glow-canvas' / 'glow-window'
   * @param {THREE.BufferGeometry} geo  a shared source geometry (cloned here)
   * @param {THREE.Matrix4} m  local transform
   * @param {object} [o]  { exposure, uvScale, uvOffset, keepUV, glow, glowFn }
   */
  add(mat, geo, m, o) {
    const opt = o || {};
    const g = geo.clone();
    this._tmp.multiplyMatrices(this.base, m);
    g.applyMatrix4(this._tmp);
    if (!opt.keepUV) {
      const uo = opt.uvOffset || 0;
      metricUV(g, opt.uvScale === undefined ? 1 : opt.uvScale, uo, uo * 0.61);
    }
    const n = g.attributes.position.count;
    const ex = new Float32Array(n * 2);
    const e = opt.exposure === undefined ? 1 : opt.exposure;
    for (let i = 0; i < n; i++) { ex[i * 2] = e; ex[i * 2 + 1] = 1; }
    g.setAttribute('aExposure', new THREE.BufferAttribute(ex, 2));

    const isGlow = GLOW_KEYS[mat] === 1;
    if (isGlow) {
      const gl = new Float32Array(n);
      const pos = g.attributes.position;
      if (typeof opt.glowFn === 'function') {
        for (let i = 0; i < n; i++) gl[i] = opt.glowFn(pos.getX(i), pos.getY(i), pos.getZ(i));
      } else {
        const v = opt.glow === undefined ? 1 : opt.glow;
        for (let i = 0; i < n; i++) gl[i] = v;
      }
      g.setAttribute('aGlow', new THREE.BufferAttribute(gl, 1));
    }
    // mergeGeometries() refuses a group that mixes indexed and non-indexed geometry, and when it
    // refuses it drops the ENTIRE group — every merged mesh for that material, silently, with one
    // console error. `Kit.UNIT_ICO` is the only non-indexed primitive in the kit, so the granite
    // group (cabin piers, the 1968 foundation stones, the fire ring, the ash bowl) merged with
    // the fire-ring icosahedra and vanished from the camp. Give everything a trivial index: same
    // vertex count, no memory cost worth naming, and the group can never be dropped again.
    if (!g.index) {
      const vc = g.attributes.position.count;
      const idx = vc > 65535 ? new Uint32Array(vc) : new Uint16Array(vc);
      for (let i = 0; i < vc; i++) idx[i] = i;
      g.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    trimGeo(g, isGlow);

    let arr = this.groups.get(mat);
    if (!arr) { arr = []; this.groups.set(mat, arr); }
    arr.push(g);
    return this;
  }

  /** Convenience: an axis-aligned-ish box placed by TRS. */
  box(mat, w, h, d, x, y, z, ry, o) {
    return this.add(mat, Kit.UNIT_BOX, TRS(x, y, z, ry || 0, w, h, d,
      (o && o.rx) || 0, (o && o.rz) || 0), o);
  }

  /** Merge every group into { mat, geometry } pairs. Frees the sources. */
  build() {
    const out = [];
    for (const [mat, list] of this.groups) {
      if (!list.length) continue;
      let merged = null;
      try { merged = mergeGeometries(list, false); } catch (e) {
        Log.warn(`Props: merge failed for '${mat}'`, e);
      }
      for (const g of list) g.dispose();
      if (merged) { merged.computeBoundingSphere(); out.push({ mat, geometry: merged }); }
    }
    this.groups.clear();
    return out;
  }
}
Kit.UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
Kit.UNIT_PLANE = new THREE.PlaneGeometry(1, 1);
Kit.UNIT_CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1);
Kit.UNIT_CYL_HI = new THREE.CylinderGeometry(0.5, 0.5, 1, 16, 1);
Kit.UNIT_CONE = new THREE.ConeGeometry(0.5, 1, 10, 1);
Kit.UNIT_SPHERE = new THREE.SphereGeometry(0.5, 14, 9);
Kit.UNIT_ICO = new THREE.IcosahedronGeometry(0.5, 1);

/**
 * A unit triangular prism: isoceles triangle in XY (apex at +Y), 1 deep in Z. Three.js has no
 * wedge, and without one a gable end has to be faked with a row of boxes of increasing height —
 * which reads as a staircase, not a roof. Used for tent gables and anywhere else a real
 * triangular silhouette matters. Winding is CCW-outward on all five faces.
 */
Kit.UNIT_WEDGE = (() => {
  const A = [-0.5, -0.5], B = [0.5, -0.5], C = [0, 0.5];
  const zf = 0.5, zb = -0.5;
  const p = [];
  const tri = (a, b, c) => p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  tri([A[0], A[1], zf], [B[0], B[1], zf], [C[0], C[1], zf]);   // front cap
  tri([B[0], B[1], zb], [A[0], A[1], zb], [C[0], C[1], zb]);   // back cap
  for (const [u, v] of [[A, B], [B, C], [C, A]]) {
    tri([u[0], u[1], zb], [v[0], v[1], zb], [v[0], v[1], zf]);
    tri([u[0], u[1], zb], [v[0], v[1], zf], [u[0], u[1], zf]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
})();

/* ==============================================================================================
 * Story-prop re-anchoring (see header note 6).
 * frame: 's' = Terrain.buildSiteCenter + literal Script offset, 'camp' / 'dock' = re-anchored.
 * ============================================================================================ */
const STORY_ANCHOR = {
  bev_ashtray: ['camp', 20, -6],
  photo_board: ['camp', 15.5, -8.6],
  swing_seat: ['camp', 27, 21],
  boathouse_door: ['dock', -13, 5],
  dales_torch: ['s', 41, 29],
};

/* The nine authored part sites, ART §4.4. Offsets are resolved against camp / dock / site. */
const PART_SITE_DEFS = [
  ['mess-porch', 'camp', 8.0, -4.0],
  ['canoe-rack', 'dock', 7.5, 8.0],
  ['tool-shed', 'camp', 30.0, -14.0],
  ['dock-box', 'dock', 1.2, -6.0],
  ['laundry-line', 'camp', -15.0, 8.0],
  ['fire-ring', 'camp', 0.0, 4.0],
  ['bus-turnaround', 'camp', 34.0, 26.0],
  ['latrine-wall', 'latrine', 1.6, 0.0],
  ['culvert', 'camp', -40.0, 30.0],
];

export class Props {
  constructor(ctx) {
    this.ctx = ctx || {};
    this.bus = this.ctx.bus || null;

    this.group = new THREE.Group();
    this.group.name = 'sc-props';
    this.group.matrixAutoUpdate = false;

    /** @type {THREE.Light[]} real scene lights first, then fog proxies. */
    this.lights = [];
    /** @type {{position:THREE.Vector3,id:string,kind:string}[]} */
    this.interactables = [];
    /** @type {Map<string,THREE.Vector3>} */
    this.partSites = new Map();
    /** @type {Map<string,THREE.Vector3>} */
    this.anchors = new Map();

    this.firePosition = new THREE.Vector3();
    this.enabled = true;
    this.ready = false;

    this._disposed = false;
    this._terrain = null;
    this._mats = null;
    this._textures = null;
    this._meshes = [];
    this._instanced = [];
    this._ownGeo = [];
    this._ownMat = [];
    /** @type {THREE.Texture[]} textures Props created itself (the stain overlay). */
    this._ownTex = [];
    this._stains = [];          // {m:Matrix4} stain-overlay quads, world space
    this._stainCount = 0;
    this.stainsReady = false;
    /** @type {Map<string,THREE.Material>} material keys Props authors itself, see _makeFabric. */
    this._ownNamed = new Map();
    this._unsub = [];
    this._t = 0;
    this._decals = [];          // {x,y,z,r,s,nx,ny,nz}
    this._decalMesh = null;
    this._proxies = [];
    this._shadowTimer = 0;
    this._sfxTimer = 7.3;
    this._flick = 1;

    this.fireLight = null;
    this.fireFill = null;
    this.sodiumLight = null;
    this.flameMesh = null;
    this.emberPoints = null;
    this.coalMesh = null;

    this.smokeMesh = null;
    this.uFlame = null;
    this.uEmber = null;
    this.uCoal = null;
    this.uSmoke = null;
    this.uGlowFire = null;
    this.uStain = null;
    this.uGlowCanvas = null;
    this.uGlowWindow = null;

    try {
      this.rand = this.ctx.rand && this.ctx.rand.fork
        ? this.ctx.rand.fork('props')
        : new Rand(0x9805 ^ Math.floor(hashStr('props') * 1e9));
    } catch { this.rand = new Rand(0x9805); }
  }

  // ------------------------------------------------------------------------------- lifecycle

  async init() {
    if (this._disposed) return;
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    try {
      this._terrain = (this.ctx.systems && this.ctx.systems.get) ? this.ctx.systems.get('Terrain') : null;
      if (this._terrain && typeof this._terrain.heightAt !== 'function') this._terrain = null;
      this._mats = (this.ctx.systems && this.ctx.systems.get) ? this.ctx.systems.get('Materials') : null;
      if (this._mats && typeof this._mats.get !== 'function') this._mats = null;
      this._textures = (this.ctx.systems && this.ctx.systems.get) ? this.ctx.systems.get('Textures') : null;

      this._tier = (l, m, h, u) => {
        const s = this.ctx.settings;
        return (s && typeof s.tier === 'function') ? s.tier(l, m, h, u) : u;
      };
      this._tierIndex = (this.ctx.settings && this.ctx.settings.tierIndex !== undefined)
        ? this.ctx.settings.tierIndex : 3;

      this._resolveLandmarks();
      this._makeOwnMaterials();
      this._auditMaterials();

      const kit = new Kit();
      this._buildCamp(kit);
      this._buildDock(kit);
      this._buildLatrine(kit);
      this._buildLumberPile(kit);
      this._buildRuins(kit);
      this._buildStoryProps(kit);
      this._emit(kit);

      this._buildScatter();
      this._buildFire();
      this._buildDecals();
      this._buildStains();
      this._publishAnchors();
      this._assertNoPointLights();

      if (this.ctx.scene) this.ctx.scene.add(this.group);
      this.ready = true;
      this._loadStains();
      const ms = ((typeof performance !== 'undefined') ? performance.now() : 0) - t0;
      Log.debug(`Props: ${this._meshes.length} merged + ${this._instanced.length} instanced, `
        + `${this.lights.length} lights, ${this.interactables.length} interactables, `
        + `${this._stainCount} stains, ${ms.toFixed(1)}ms`);
    } catch (e) {
      Log.error('Props.init failed — camp will be absent but the game still runs.', e);
    }
  }

  update(dt, elapsed) {
    if (this._disposed || !this.enabled || !this.ready) return;
    const d = Math.min(Math.max(dt || 0, 0), 0.1);
    this._t = Number.isFinite(elapsed) ? elapsed : this._t + d;
    const t = this._t;

    // ---- the fire: 3-octave flicker, one evaluation, everything hangs off it
    const f = flicker3(t, 3.17);
    const gust = 0.5 + 0.5 * vnoise1(t * 0.31 + 11.0);
    this._flick = 1 + 0.18 * f + 0.06 * (gust - 0.5);
    const fl = this._flick;

    if (this.fireLight) {
      this.fireLight.intensity = 26 * fl;
      this.fireLight.position.x = this.firePosition.x + 0.045 * f;
      this.fireLight.position.z = this.firePosition.z + 0.045 * flicker3(t + 41.7, 8.9);
      _col.setHex(PAL.fireMid).lerp(_col.clone().setHex(PAL.fireCore), Math.max(0, f) * 0.35);
      this.fireLight.color.copy(_col);
    }
    if (this.fireFill) this.fireFill.intensity = 11 * (1 + 0.12 * f);
    if (this.sodiumLight) {
      // A sodium lamp in damp air: a slow, almost-imperceptible breath plus a rare strobe.
      const s = vnoise1(t * 0.9 + 77.0);
      this.sodiumLight.intensity = 28 * (0.96 + 0.05 * s) * (vnoise1(t * 23.0 + 5.0) > 0.985 ? 0.55 : 1);
    }

    if (this.uFlame) { this.uFlame.uTime.value = t; this.uFlame.uFlicker.value = fl; }
    if (this.uEmber) {
      this.uEmber.uTime.value = t;
      const gu = this._globalUniforms();
      if (gu && gu.uWind) this.uEmber.uWind.value.copy(gu.uWind.value);
      const cam = this.ctx.camera;
      if (cam && cam.isPerspectiveCamera) {
        const h = (this.ctx.renderer && this.ctx.renderer.domElement)
          ? this.ctx.renderer.domElement.height : (this.ctx.height || 1080);
        this.uEmber.uProjScale.value = h / (2 * Math.tan(cam.fov * Math.PI / 360));
      }
    }
    if (this.uCoal) { this.uCoal.uTime.value = t; this.uCoal.uFlicker.value = fl; }
    // The ground pool is the fire's own light landing on dirt, so it tracks the fire's flicker
    // exactly — half amplitude, because a pool on a rough surface integrates the flame.
    if (this.uGlowFire) this.uGlowFire.uFlicker.value = 1 + (fl - 1) * 0.55;
    if (this.uSmoke) {
      this.uSmoke.uTime.value = t;
      const gs = this._globalUniforms();
      if (gs && gs.uWind) this.uSmoke.uWind.value.copy(gs.uWind.value);
    }

    // ---- tents and windows breathe on their own slow noise, never in sync with the fire
    if (this.uGlowCanvas) this.uGlowCanvas.uFlicker.value = 0.94 + 0.09 * vnoise1(t * 1.15 + 21.0);
    if (this.uGlowWindow) this.uGlowWindow.uFlicker.value = 0.96 + 0.06 * vnoise1(t * 0.8 + 53.0);

    // ---- fog proxies inherit the flicker so the volumetrics pulse with the fire
    for (let i = 0; i < this._proxies.length; i++) {
      const p = this._proxies[i];
      p.light.intensity = p.base * (p.warm ? (0.95 + 0.08 * vnoise1(t * 1.3 + p.seed)) : 1);
    }

    this._updateShadows(d);
    this._updateAudio(d);
  }

  resize(_w, _h) { /* point size is derived from the camera each frame in update() */ }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.ready = false;
    for (const off of this._unsub) { try { off(); } catch { /* ignore */ } }
    this._unsub.length = 0;

    for (const l of this.lights) {
      if (l && l.userData && l.userData.inScene === false) continue;
      if (l && l.parent) l.parent.remove(l);
      if (l && l.target && l.target.parent) l.target.parent.remove(l.target);
      if (l && l.shadow && l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; }
      if (l && typeof l.dispose === 'function') l.dispose();
    }
    this.lights.length = 0;
    this._proxies.length = 0;

    if (this.group.parent) this.group.parent.remove(this.group);
    this.group.traverse((o) => { if (o.isMesh || o.isPoints) o.geometry = o.geometry; });
    for (const g of this._ownGeo) { try { g.dispose(); } catch { /* ignore */ } }
    for (const m of this._ownMat) { try { m.dispose(); } catch { /* ignore */ } }
    for (const t of this._ownTex) {
      try { t.image && t.image.close && t.image.close(); } catch { /* ignore */ }
      try { t.dispose(); } catch { /* ignore */ }
    }
    this._ownGeo.length = 0;
    this._ownMat.length = 0;
    this._ownTex.length = 0;
    this._stains.length = 0;
    this.smokeMesh = null;
    this._stainMesh = null;
    this._decalMesh = null;
    this._ownNamed.clear();
    this._meshes.length = 0;
    this._instanced.length = 0;
    this.group.clear();
    this.interactables.length = 0;
    this.partSites.clear();
    this.anchors.clear();
    this.flameMesh = this.emberPoints = this.coalMesh = null;
    this.fireLight = this.fireFill = this.sodiumLight = null;
  }

  // ------------------------------------------------------------------------------- accessors

  /** @returns {THREE.Vector3|null} Navmesh calls this before falling back to its own table. */
  getAnchor(name) { return this.anchors.get(name) || null; }

  /** Every light Navmesh should treat as camp illumination. */
  getLightSources() { return this.lights; }

  // ------------------------------------------------------------------------------- internals

  _globalUniforms() {
    if (this._mats && this._mats.globalUniforms) return this._mats.globalUniforms;
    return null;
  }

  /** Ground height with a safe fallback. */
  _h(x, z) { return this._terrain ? this._terrain.heightAt(x, z) : 0; }

  /** Ground normal into `out`. */
  _n(x, z, out) {
    if (this._terrain && typeof this._terrain.normalAt === 'function') return this._terrain.normalAt(x, z, out);
    return out.set(0, 1, 0);
  }

  /** Lowest ground height over a footprint — buildings sit on their lowest corner, never float. */
  _lowest(x, z, hw, hd, ry) {
    const c = Math.cos(ry || 0), s = Math.sin(ry || 0);
    let lo = Infinity;
    for (let i = 0; i < 4; i++) {
      const ox = (i & 1) ? hw : -hw, oz = (i & 2) ? hd : -hd;
      const h = this._h(x + ox * c + oz * s, z - ox * s + oz * c);
      if (h < lo) lo = h;
    }
    return Number.isFinite(lo) ? lo : 0;
  }

  _resolveLandmarks() {
    const t = this._terrain;
    this.campCenter = t && t.campCenter ? t.campCenter.clone() : new THREE.Vector3(124, 0, -18);
    this.siteCenter = t && t.buildSiteCenter ? t.buildSiteCenter.clone() : new THREE.Vector3(-140, 0, 128);
    this.dockPoint = t && t.dock ? t.dock.clone() : new THREE.Vector3(106, 0, -72);
    this.latrinePoint = t && t.latrine ? t.latrine.clone() : new THREE.Vector3(96, 0, 34);
    this.waterLevel = t && Number.isFinite(t.waterLevel) ? t.waterLevel : 0;
    this.campCenter.y = this._h(this.campCenter.x, this.campCenter.z);
    this.siteCenter.y = this._h(this.siteCenter.x, this.siteCenter.z);
  }

  /** camp-local (east, south) -> world. The camp's local frame is world-aligned. */
  _camp(ex, sz, out) { return (out || new THREE.Vector3()).set(this.campCenter.x + ex, 0, this.campCenter.z + sz); }
  _site(ex, sz, out) { return (out || new THREE.Vector3()).set(this.siteCenter.x + ex, 0, this.siteCenter.z + sz); }

  _clampWorld(v) {
    const b = this._terrain && this._terrain.bounds ? this._terrain.bounds : null;
    if (!b) return v;
    const pad = 6;
    const minX = Number.isFinite(b.minX) ? b.minX : -250;
    const maxX = Number.isFinite(b.maxX) ? b.maxX : 250;
    const minZ = Number.isFinite(b.minZ) ? b.minZ : -250;
    const maxZ = Number.isFinite(b.maxZ) ? b.maxZ : 250;
    v.x = Math.min(Math.max(v.x, minX + pad), maxX - pad);
    v.z = Math.min(Math.max(v.z, minZ + pad), maxZ - pad);
    return v;
  }

  /** Resolve one of the three additive-glow pseudo-material keys. */
  _glowMat(name) {
    if (name === 'glow-canvas') return this.matGlowCanvas;
    if (name === 'glow-fire') return this.matFireGlow;
    return this.matGlowWindow;
  }

  /**
   * MATERIAL AUDIT. Every key this file asks for, resolved once, out loud.
   *
   * The failure this exists to catch is silent: `Materials.get('cloth')` for a key that is not
   * in SPECS returns a flat untextured `mid.slate` standard material and warns ONCE, globally —
   * so the second, third and fourth bad key are invisible, and the camp renders as grey boxes
   * with nobody able to say why. This walks every key in M plus every Props-owned key and
   * reports, per key, whether the shared library actually has it and whether the material that
   * came back carries a colour map. Anything without a map is named at WARN level.
   */
  _auditMaterials() {
    const keys = Array.from(new Set([...Object.values(M), ...this._ownNamed.keys()]));
    const flat = [];
    const ok = [];
    for (const k of keys) {
      const own = this._ownNamed.has(k);
      const known = own || !this._mats || typeof this._mats.has !== 'function' || this._mats.has(k);
      let m = null;
      try { m = this._mat(k); } catch (e) { Log.error(`Props: _mat('${k}') threw`, e); }
      const mapped = !!(m && (m.map || m.normalMap || m.roughnessMap));
      // Triplanar surfaces (granite, concrete, every ground material) deliberately bind NO map
      // slots — they sample uTriAlbedo/uTriNormal inside the patched shader instead, and
      // Materials injects its defines into the source rather than onto material.defines. So the
      // honest test for "this is a real material" is mapped OR patched, and the fallback is
      // exactly the thing that is neither: a bare MeshStandardMaterial straight from the ctor.
      const patched = !!(m && typeof m.onBeforeCompile === 'function'
        && m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile);
      if (!known || !(mapped || patched)) {
        flat.push(`${k}${own ? '(own)' : ''}${known ? '' : ':UNKNOWN'}${mapped ? '' : ':NO-MAP'}${patched ? '' : ':UNPATCHED'}`);
      } else ok.push(`${k}${mapped ? '' : ':triplanar'}`);
    }
    this.materialAudit = { total: keys.length, textured: ok.length, flat };
    if (flat.length) {
      Log.warn(`Props: ${flat.length}/${keys.length} material keys are untextured or unknown — `
        + `these render as flat colour: ${flat.join(', ')}`);
    } else {
      Log.debug(`Props: material audit clean — ${ok.length}/${keys.length} keys textured: ${ok.join(' ')}`);
    }
    return this.materialAudit;
  }

  _mat(name) {
    const own = this._ownNamed.get(name);
    if (own) return own;
    if (this._mats) return this._mats.get(name);
    let m = this._fallbackMats && this._fallbackMats.get(name);
    if (!m) {
      // ART §2.2 mid.slate, matte. A fallback must still be inside the palette.
      m = new THREE.MeshStandardMaterial({ color: 0x243740, roughness: 0.9, name: `sc-props-fb-${name}` });
      if (!this._fallbackMats) this._fallbackMats = new Map();
      this._fallbackMats.set(name, m);
      this._ownMat.push(m);
    }
    return m;
  }

  /** Register an interactable. */
  _inter(id, kind, x, y, z) {
    this.interactables.push({ position: new THREE.Vector3(x, y, z), id, kind });
  }

  /** Queue a contact-darkening decal. Nothing in this file floats. */
  _decal(x, z, r, s) {
    const y = this._h(x, z);
    this._n(x, z, _v3c);
    this._decals.push({ x, y, z, r, s: s === undefined ? 0.62 : s, nx: _v3c.x, ny: _v3c.y, nz: _v3c.z });
  }

  /**
   * Queue an overlay-stain quad. Unit plane lies in XY with normal +Z, so a wall stain is
   * (ry) only and a roof stain adds rx. Nothing is created until _buildStains().
   */
  _stain(x, y, z, w, h, ry, rx, rz) {
    this._stains.push(TRS(x, y, z, ry || 0, w, h, 1, rx || 0, rz || 0));
  }

  /** A deterministic sub-rect of the 1024² overlay, so no two stains are the same smear. */
  _stainUv(i) {
    const s = 0.34 + ihash1(i * 7919 + 13) * 0.42;
    const ou = ihash1(i * 104729 + 5) * (1 - s);
    const ov = ihash1(i * 15485863 + 11) * (1 - s);
    const flip = ihash1(i * 611953 + 3) > 0.5 ? -1 : 1;
    return [s * flip, s, flip < 0 ? ou + s : ou, ov];
  }

  /**
   * One InstancedMesh for every stain in the camp. Starts invisible (matStain.visible === false)
   * and is switched on by _loadStains() if and only if the overlay texture arrives.
   */
  _buildStains() {
    this._stainCount = this._stains.length;
    if (!this._stainCount) return;
    const g = new THREE.PlaneGeometry(1, 1);
    const uvs = new Float32Array(this._stainCount * 4);
    for (let i = 0; i < this._stainCount; i++) uvs.set(this._stainUv(i), i * 4);
    g.setAttribute('aStainUv', new THREE.InstancedBufferAttribute(uvs, 4));
    const mesh = this._instance('stain', g, this._stains, {
      material: this.matStain, cast: false, receive: false, renderOrder: 5,
    });
    if (mesh) { mesh.name = 'sc-props-stain'; mesh.visible = false; this._stainMesh = mesh; }
    this._stains.length = 0;
  }

  _emit(kit) {
    const parts = kit.build();
    for (const p of parts) {
      const glow = GLOW_KEYS[p.mat] === 1;
      const mat = glow ? this._glowMat(p.mat) : this._mat(p.mat);
      const mesh = new THREE.Mesh(p.geometry, mat);
      mesh.name = `sc-props-${p.mat}`;
      mesh.castShadow = !glow;
      mesh.receiveShadow = !glow;
      mesh.renderOrder = glow ? 6 : 0;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (glow) mesh.frustumCulled = true;
      this.group.add(mesh);
      this._meshes.push(mesh);
      this._ownGeo.push(p.geometry);

      const depth = this._mats && typeof this._mats.getDepthMaterial === 'function' && !glow
        ? this._mats.getDepthMaterial(p.mat) : null;
      if (depth) mesh.customDepthMaterial = depth;
    }
  }

  _instance(matName, geo, matrices, opts) {
    if (!matrices.length) { geo.dispose(); return null; }
    const o = opts || {};
    const mat = o.material || this._mat(matName);
    const mesh = new THREE.InstancedMesh(geo, mat, matrices.length);
    for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = o.cast !== false;
    mesh.receiveShadow = o.receive !== false;
    mesh.frustumCulled = true;
    mesh.name = `sc-props-i-${matName}`;
    if (o.renderOrder) mesh.renderOrder = o.renderOrder;
    this.group.add(mesh);
    this._instanced.push(mesh);
    this._ownGeo.push(geo);
    const depth = this._mats && typeof this._mats.getDepthMaterial === 'function' && !o.material
      ? this._mats.getDepthMaterial(matName) : null;
    if (depth) mesh.customDepthMaterial = depth;
    return mesh;
  }

  /**
   * ART §3.6: there are no PointLights in the build. Props asserts it.
   */
  _assertNoPointLights() {
    if (!this.ctx.scene) return;
    let n = 0;
    this.ctx.scene.traverse((o) => { if (o && o.isPointLight) n++; });
    if (n > 0) {
      Log.warn(`Props: ${n} PointLight(s) in the scene. ART_DIRECTION §3.6 compiles MAX_POINT 0 — `
        + 'they will not light anything and they cost a shader permutation. Use a SpotLight.');
    }
  }

  _publishAnchors() {
    const set = (name, x, z) => this.anchors.set(name, new THREE.Vector3(x, this._h(x, z), z));
    set('camp', this.campCenter.x, this.campCenter.z);
    set('plot', this.siteCenter.x, this.siteCenter.z);
    set('dock', this.dockPoint.x, this.dockPoint.z);
    set('latrine', this.latrinePoint.x, this.latrinePoint.z);
    set('firepit', this.firePosition.x, this.firePosition.z);
    for (const [name, p] of this.partSites) {
      if (name === 'mess-porch') set('mess', p.x, p.z);
      if (name === 'tool-shed') set('toolshed', p.x, p.z);
      if (name === 'canoe-rack') set('canoe-rack', p.x, p.z);
      if (name === 'laundry-line') set('cabins', p.x + 4, p.z - 10);
      if (name === 'bus-turnaround') set('draw', p.x, p.z);
    }
    const nav = (this.ctx.systems && this.ctx.systems.get) ? this.ctx.systems.get('Navmesh') : null;
    if (nav && typeof nav.setAnchor === 'function') {
      for (const [name, p] of this.anchors) { try { nav.setAnchor(name, p.x, p.z); } catch { /* ignore */ } }
    }
  }

  _updateShadows(dt) {
    this._shadowTimer -= dt;
    if (this._shadowTimer > 0) return;
    this._shadowTimer = 0.45;
    const cam = this.ctx.camera;
    if (!cam) return;
    for (const l of [this.fireLight, this.sodiumLight]) {
      if (!l || !l.castShadow || !l.shadow) continue;
      const near = l.position.distanceToSquared(cam.position) < 55 * 55;
      if (near) l.shadow.needsUpdate = true;
    }
  }

  _updateAudio(dt) {
    if (!this.bus || !this.bus.emit) return;
    this._sfxTimer -= dt;
    if (this._sfxTimer > 0) return;
    const r = this.rand;
    this._sfxTimer = r.range(2.4, 6.5);
    try {
      if (r.chance(0.62)) {
        this.bus.emit('audio:sfx', { id: 'fire-crackle', position: this.firePosition, volume: r.range(0.3, 0.8) });
      } else if (this.radioPosition) {
        this.bus.emit('audio:sfx', { id: 'camp-radio', position: this.radioPosition, volume: 0.35 });
      }
    } catch { /* Audio may be absent; never let it kill the frame */ }
  }

  // =============================================================================================
  // MATERIALS OWNED BY THIS FILE
  // =============================================================================================
  _makeOwnMaterials() {
    const fogK = 0.011;
    this.uFlame = {
      uTime: new THREE.Uniform(0), uFlicker: new THREE.Uniform(1),
      uIntensity: new THREE.Uniform(3.4), uFogK: new THREE.Uniform(fogK),
      uCore: new THREE.Uniform(new THREE.Color(PAL.fireCore).convertSRGBToLinear()),
      uMid: new THREE.Uniform(new THREE.Color(PAL.fireMid).convertSRGBToLinear()),
      uEmber: new THREE.Uniform(new THREE.Color(PAL.fireEmber).convertSRGBToLinear()),
    };
    this.matFlame = new THREE.ShaderMaterial({
      name: 'sc-flame', uniforms: this.uFlame, vertexShader: FLAME_VERT, fragmentShader: FLAME_FRAG,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
      transparent: true, toneMapped: false, side: THREE.DoubleSide,
    });

    this.uEmber = {
      uTime: new THREE.Uniform(0), uProjScale: new THREE.Uniform(900),
      uIntensity: new THREE.Uniform(2.6), uFogK: new THREE.Uniform(fogK),
      uWind: new THREE.Uniform(new THREE.Vector3(0.2, 0, 0.1)),
      uCore: new THREE.Uniform(new THREE.Color(PAL.fireCore).convertSRGBToLinear()),
      uEmber: new THREE.Uniform(new THREE.Color(PAL.fireEmber).convertSRGBToLinear()),
    };
    this.matEmber = new THREE.ShaderMaterial({
      name: 'sc-ember', uniforms: this.uEmber, vertexShader: EMBER_VERT, fragmentShader: EMBER_FRAG,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false,
    });

    this.uCoal = {
      uTime: new THREE.Uniform(0), uFlicker: new THREE.Uniform(1),
      uRadius: new THREE.Uniform(0.86), uFogK: new THREE.Uniform(fogK),
      uCore: new THREE.Uniform(new THREE.Color(PAL.fireCore).convertSRGBToLinear()),
      uEmber: new THREE.Uniform(new THREE.Color(PAL.fireEmber).convertSRGBToLinear()),
      uDark: new THREE.Uniform(new THREE.Color(PAL.coalDark).convertSRGBToLinear()),
    };
    this.matCoal = new THREE.ShaderMaterial({
      name: 'sc-coals', uniforms: this.uCoal, vertexShader: COAL_VERT, fragmentShader: COAL_FRAG,
      toneMapped: false,
    });

    this.uSmoke = {
      uTime: new THREE.Uniform(0), uIntensity: new THREE.Uniform(0.30),
      uFogK: new THREE.Uniform(fogK),
      uWind: new THREE.Uniform(new THREE.Vector3(0.2, 0, 0.1)),
      // Woodsmoke lit from below by an amber fire: a desaturated warm grey, never blue.
      uColor: new THREE.Uniform(new THREE.Color(0x6b584a).convertSRGBToLinear()),
    };
    this.matSmoke = new THREE.ShaderMaterial({
      name: 'sc-smoke', uniforms: this.uSmoke, vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false,
      side: THREE.DoubleSide,
    });

    // The canvas colour map, if Textures is up. Used both as the glow shell's modulator and as
    // the lit tent's emissiveMap, so the SAME dirt shows in the fabric and in the light.
    const canvasSet = (this._textures && typeof this._textures.get === 'function')
      ? this._textures.get('canvas-tent') : null;
    const canvasMap = (canvasSet && canvasSet.map) ? canvasSet.map : null;

    this.uGlowCanvas = {
      uColor: new THREE.Uniform(new THREE.Color(PAL.lantern).convertSRGBToLinear()),
      // 1.35 used to be the ENTIRE lit tent, because the canvas under it was black. The fabric
      // now carries the lamp itself; this is only the near-field gradient laid over it.
      //
      // 0.90 was measured, at ultra, as a flat saturated orange slab: every texel on a 3.5 x 4.4 m
      // tent sat above the bloom knee, so the lamp gradient, the weave, the seams and the baked
      // cot shadow were all clipped into one colour and the tent read as a cardboard box. It also
      // made a tent lamp brighter in frame than the campfire, which breaks ART §3.2's rule that
      // exactly one local source is dominant. 0.40 keeps the tent glowing and puts everything
      // that was being clipped back inside the display range.
      uIntensity: new THREE.Uniform(0.40), uFlicker: new THREE.Uniform(1),
      uFogK: new THREE.Uniform(fogK), uSeam: new THREE.Uniform(new THREE.Vector2(0.95, 0.55)),
      uTex: new THREE.Uniform(canvasMap),
      uTexAmt: new THREE.Uniform(0.95),
      // Approximate linear mean of the canvas albedo (#5c5b46 class). Only a normaliser: the
      // shader clamps around it, so being a little off shifts brightness, never breaks it.
      uTexRef: new THREE.Uniform(0.085),
    };
    this.matGlowCanvas = new THREE.ShaderMaterial({
      name: 'sc-glow-canvas', uniforms: this.uGlowCanvas, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
      defines: canvasMap ? { SC_GLOW_TEX: '' } : {},
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false,
      // No polygonOffset: _buildTent now places the shell outside the canvas (see there).
      side: THREE.DoubleSide,
    });

    this.uGlowWindow = {
      uColor: new THREE.Uniform(new THREE.Color(PAL.lantern).convertSRGBToLinear()),
      uIntensity: new THREE.Uniform(4.6), uFlicker: new THREE.Uniform(1),
      uFogK: new THREE.Uniform(fogK), uSeam: new THREE.Uniform(new THREE.Vector2(1, 0)),
    };
    this.matGlowWindow = new THREE.ShaderMaterial({
      name: 'sc-glow-window', uniforms: this.uGlowWindow, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide,
    });

    // The fire's own ground pool + the warm wash it throws up the stone ring and the bench logs.
    // A separate material from glow-window purely so it can be driven by the FIRE's flicker
    // (this._flick) rather than the tent lamps' slow independent breath — a warm pool on the dirt
    // that does not pulse with the flame above it reads as a painted decal, which is what it was.
    this.uGlowFire = {
      uColor: new THREE.Uniform(new THREE.Color(PAL.fireMid).convertSRGBToLinear()),
      uIntensity: new THREE.Uniform(3.1), uFlicker: new THREE.Uniform(1),
      uFogK: new THREE.Uniform(fogK), uSeam: new THREE.Uniform(new THREE.Vector2(1, 0)),
    };
    this.matFireGlow = new THREE.ShaderMaterial({
      name: 'sc-glow-fire', uniforms: this.uGlowFire, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, side: THREE.DoubleSide,
    });

    // ---- STAIN OVERLAY. public/img/decal-{grunge,rust,moss}-01.png are RGB with no alpha, so
    // they are used the only way an alpha-less photo can safely be used at night: as a DARKENING
    // mask, written as straight alpha over black exactly like the contact decal (see DECAL_FRAG).
    // Worst case if the texture never arrives is an invisible mesh — never a white card.
    this.uStain = {
      uTex: new THREE.Uniform(null),
      uStrength: new THREE.Uniform(0.55),
      uContrast: new THREE.Uniform(new THREE.Vector2(0.34, 0.86)),
      uFade: new THREE.Uniform(new THREE.Vector2(46, 96)),
    };
    this.matStain = new THREE.ShaderMaterial({
      name: 'sc-stain', uniforms: this.uStain, vertexShader: STAIN_VERT, fragmentShader: STAIN_FRAG,
      blending: THREE.NormalBlending, depthWrite: false, transparent: true, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      side: THREE.DoubleSide, visible: false,
    });

    this.uDecal = {
      uStrength: new THREE.Uniform(0.78),
      uFade: new THREE.Uniform(new THREE.Vector2(34, 72)),
    };
    // NormalBlending over a black fragment — see the note above DECAL_FRAG. Never Multiply.
    this.matDecal = new THREE.ShaderMaterial({
      name: 'sc-contact', uniforms: this.uDecal, vertexShader: DECAL_VERT, fragmentShader: DECAL_FRAG,
      blending: THREE.NormalBlending, depthWrite: false, transparent: true, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });

    // ---- Props-owned surfaces. These four keys are NOT in the shared library; before this
    // existed, `_mat('cloth')` / `_mat('cloth-warm')` fell straight through to the Materials
    // fallback (flat untextured `mid.slate`, and Materials logs a warning once). Everything
    // here is opted into the global wetness / wind system through the documented
    // Materials.patchMaterial() path, and everything here is dirty. Nothing is white.

    // Camp cotton: towels on the line, chair slings, the volleyball tape. Weathered and mildewed.
    this.matCloth = this._makeFabric('sc-props-cloth', 0x5f5e4a, 0.92, {
      porosity: 0.9, wetScale: 1.0, uv: [1.4, 1.4], detail: [22, 0.5],
      breakup: [0.26, 24], ao: 0.65, wind: [1.15, 0.95, 0.0, 1.6],
    });
    // The one warm garment class in the props set (flag, life jackets) — ART §2.2 garment.warm,
    // sun-bleached and rain-beaten so it never competes with the fire.
    this.matClothWarm = this._makeFabric('sc-props-cloth-warm', 0x9d5636, 0.90, {
      porosity: 0.9, wetScale: 1.0, uv: [1.4, 1.4], detail: [22, 0.5],
      breakup: [0.24, 18], ao: 0.65, wind: [1.15, 0.95, 0.0, 1.6],
    });
    // The weighted tarp. The shared `tarp-plastic` is authored at roughness 0.28 with
    // wetScale 1.35, which is right for a crumpled cover but turns a 3.2 x 2.4 m sheet lying
    // flat on the ground into one coherent mirror aimed at the moon — a blown white slab.
    // Props keeps its own: same hue, matte, and barely wet-responsive.
    this.matTarpSheet = this._makeFabric('sc-props-tarp-sheet', 0x27343d, 0.72, {
      porosity: 0.30, wetScale: 0.30, uv: [1.6, 1.6], detail: [16, 0.85],
      breakup: [0.30, 9], ao: 0.85, cavity: { contrast: 1.5, bias: 0.10 },
    });

    // ---- LIT TENT CANVAS. ART §6.3: a tent lit from inside is the best image this game has,
    // and it only works if the thing that glows is FABRIC. Before this, the lit tents used the
    // ordinary shared `canvas` material — which, under a 0.06-intensity moon with no local
    // light at the tents (they are fog proxies, header note 2), renders essentially black — and
    // the whole read was carried by the additive shell on top of it. The result was five flat
    // orange polygons floating in the dark with hard edges and no surface: a card, not a tent.
    //
    // The fix is emissive canvas. Same albedo, same weave/dirt/patch maps, and the colour map
    // doubles as the emissiveMap so the light coming through is modulated by the cloth's own
    // grime. Bright panels glow, mildewed ones do not, seams stay dark. No `transmission` — §6.3
    // is explicit that transmission costs a whole second forward pass and is forbidden here.
    this.matCanvasLit = this._makeFabric('sc-props-canvas-lit', 0x5c5b46, 0.86, {
      porosity: 0.9, wetScale: 0.85, uv: [1.1, 1.1], detail: [18, 0.45],
      breakup: [0.22, 20], ao: 0.7,
    });
    this.matCanvasLit.emissive = new THREE.Color(PAL.lantern);
    this.matCanvasLit.emissiveMap = this.matCanvasLit.map || null;
    // Low. The fabric only has to stop being BLACK; the additive shell above supplies the hot
    // gradient around the lamp. Pushed higher the tent becomes an amber cardboard box.
    // Measured: at 0.22 the fabric alone was already at the top of the display range before the
    // additive shell was composited on top of it, so the two together clipped. 0.085 leaves the
    // canvas a dim warm grey on its own and lets the shell supply every bit of the modelling.
    this.matCanvasLit.emissiveIntensity = this.matCanvasLit.emissiveMap ? 0.085 : 0.02;
    this.matCanvasLit.side = THREE.DoubleSide;

    /** Names `_mat()` resolves locally instead of asking the shared library. */
    this._ownNamed.set('cloth', this.matCloth);
    this._ownNamed.set('cloth-warm', this.matClothWarm);
    this._ownNamed.set('tarp-sheet', this.matTarpSheet);
    this._ownNamed.set('canvas-lit', this.matCanvasLit);

    this._ownMat.push(this.matFlame, this.matEmber, this.matCoal, this.matGlowCanvas,
      this.matGlowWindow, this.matFireGlow, this.matSmoke, this.matStain, this.matDecal,
      this.matCloth, this.matClothWarm, this.matTarpSheet, this.matCanvasLit);
  }

  /**
   * Fetch the three overlay decals and hand them to the stain material. Deliberately NOT awaited
   * by init(): the game is contractually required to run with zero binary art assets
   * (ARCHITECTURE §1), so this is fire-and-forget and the stain meshes stay `visible: false`
   * until a texture actually lands. Decoded off-thread via createImageBitmap so a 1024² PNG
   * cannot hitch a frame. Any failure is logged at WARN and the camp simply has no stains.
   */
  _loadStains() {
    if (this._tierIndex < 2) return;                       // low/medium: not worth the bytes
    if (typeof fetch !== 'function' || typeof createImageBitmap !== 'function') return;
    const url = '/img/decal-grunge-01.png';
    fetch(url, { cache: 'force-cache' })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); })
      .then((b) => createImageBitmap(b, { imageOrientation: 'flipY' }))
      .then((bmp) => {
        if (this._disposed) { bmp.close?.(); return; }
        const tex = new THREE.Texture(bmp);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        this._ownTex.push(tex);
        this.uStain.uTex.value = tex;
        this.matStain.visible = true;
        this.matStain.needsUpdate = true;
        if (this._stainMesh) this._stainMesh.visible = true;
        this.stainsReady = true;
        Log.debug(`Props: stain overlay ready (${bmp.width}x${bmp.height}), `
          + `${this._stainCount} quads enabled.`);
      })
      .catch((e) => { Log.warn(`Props: stain overlay '${url}' unavailable — surfaces will be clean.`, e); });
  }

  /**
   * A Props-owned fabric-ish MeshStandardMaterial wearing the shared canvas texture set and
   * patched into the global wetness/wind system. Init-time only.
   * @param {string} name
   * @param {number} hex   sRGB display value (ART_DIRECTION §2)
   * @param {number} rough scalar roughness, used only when no ORM map is bound
   * @param {object} patch Materials.patchMaterial() options
   */
  _makeFabric(name, hex, rough, patch) {
    const m = new THREE.MeshStandardMaterial({
      name, color: new THREE.Color(hex), roughness: rough, metalness: 0,
      side: THREE.DoubleSide, dithering: true,
    });
    try {
      if (this._textures && typeof this._textures.get === 'function') {
        const set = this._textures.get('canvas-tent');
        if (set && set.map) {
          m.map = set.map;
          m.normalMap = set.normalMap || null;
          m.roughnessMap = set.roughnessMap || null;
          // Textures.js bakes ABSOLUTE roughness into the ORM green channel and three
          // multiplies by the scalar, so the scalar has to be 1 or we double-darken it.
          if (m.roughnessMap && set.roughAbsolute !== false) m.roughness = 1;
        }
      }
      if (this._mats && typeof this._mats.patchMaterial === 'function') {
        this._mats.patchMaterial(m, patch);
      }
    } catch (e) { Log.warn(`Props: material patch failed for '${name}' — it will not weather.`, e); }
    return m;
  }

  // =============================================================================================
  // THE FIRE — ART_DIRECTION §3.2. Layered billboards, GPU embers, emissive coals, real flicker.
  // =============================================================================================
  _buildFire() {
    const p = this.firePosition;
    const r = this.rand;

    // ---- layered flame billboards. No visible quad edge: the mask reaches zero well inside it.
    const quads = this._tier(9, 13, 18, 24);
    const pos = new Float32Array(quads * 4 * 3);
    const corner = new Float32Array(quads * 4 * 2);
    const info = new Float32Array(quads * 4 * 4);
    const idx = new Uint16Array(quads * 6);
    for (let i = 0; i < quads; i++) {
      const layer = i / (quads - 1);
      const a = r.next() * Math.PI * 2;
      const rad = 0.10 + 0.34 * Math.pow(layer, 0.7) * r.range(0.4, 1);
      const cx = Math.cos(a) * rad, cz = Math.sin(a) * rad;
      const cy = 0.06 + r.range(0, 0.14);
      const seed = r.next() * 64;
      const w = 0.24 + 0.34 * (1 - layer) + r.range(0, 0.16);
      const h = 0.95 + 0.85 * (1 - layer) + r.range(0, 0.55);
      const C = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]];
      for (let v = 0; v < 4; v++) {
        const o = (i * 4 + v);
        pos[o * 3] = cx; pos[o * 3 + 1] = cy; pos[o * 3 + 2] = cz;
        corner[o * 2] = C[v][0]; corner[o * 2 + 1] = C[v][1];
        info[o * 4] = seed; info[o * 4 + 1] = layer; info[o * 4 + 2] = w; info[o * 4 + 3] = h;
      }
      const b = i * 4;
      idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    fg.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    fg.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
    fg.setIndex(new THREE.BufferAttribute(idx, 1));
    fg.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.2, 0), 3.2);
    const flame = new THREE.Mesh(fg, this.matFlame);
    flame.position.copy(p);
    flame.frustumCulled = true;
    flame.renderOrder = 12;
    flame.name = 'sc-fire-flames';
    this.group.add(flame);
    this.flameMesh = flame;
    this._ownGeo.push(fg);

    // ---- embers: everything is animated in the vertex shader, so update() costs one uniform.
    const n = this._tier(56, 110, 190, 280);
    const ep = new Float32Array(n * 3);
    const es = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = r.next() * Math.PI * 2, rad = Math.sqrt(r.next()) * 0.46;
      ep[i * 3] = Math.cos(a) * rad;
      ep[i * 3 + 1] = 0.12 + r.range(0, 0.2);
      ep[i * 3 + 2] = Math.sin(a) * rad;
      es[i * 3] = r.next() * 97;
      es[i * 3 + 1] = 1 / r.range(1.5, 4.4);
      es[i * 3 + 2] = r.range(2.6, 7.4);
    }
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(ep, 3));
    eg.setAttribute('aSeed', new THREE.BufferAttribute(es, 3));
    eg.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 3.5, 0), 8);
    const pts = new THREE.Points(eg, this.matEmber);
    pts.position.copy(p);
    pts.renderOrder = 13;
    pts.name = 'sc-fire-embers';
    this.group.add(pts);
    this.emberPoints = pts;
    this._ownGeo.push(eg);

    // ---- smoke: a slow column shearing off downwind. Additive and very low intensity — over a
    // near-black sky smoke is only visible because the fire lights it from underneath, and
    // additive blending means the worst possible failure is that it disappears rather than that
    // a grey rectangle appears. Disabled below 'high'; it is the first thing worth cutting.
    const sq = this._tier(0, 0, 10, 16);
    if (sq > 0) {
      const spos = new Float32Array(sq * 4 * 3);
      const scor = new Float32Array(sq * 4 * 2);
      const sinf = new Float32Array(sq * 4 * 3);
      const sidx = new Uint16Array(sq * 6);
      const SC = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
      for (let i = 0; i < sq; i++) {
        const a = r.next() * Math.PI * 2, rad = Math.sqrt(r.next()) * 0.34;
        const cx = Math.cos(a) * rad, cz = Math.sin(a) * rad;
        const seed = r.next() * 53;
        const inv = 1 / r.range(4.2, 8.0);
        const hwq = 0.30 + r.range(0, 0.26);
        for (let v = 0; v < 4; v++) {
          const o = i * 4 + v;
          spos[o * 3] = cx; spos[o * 3 + 1] = 0.72; spos[o * 3 + 2] = cz;
          scor[o * 2] = SC[v][0]; scor[o * 2 + 1] = SC[v][1];
          sinf[o * 3] = seed; sinf[o * 3 + 1] = inv; sinf[o * 3 + 2] = hwq;
        }
        const b = i * 4;
        sidx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
      }
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(spos, 3));
      sg.setAttribute('aCorner', new THREE.BufferAttribute(scor, 2));
      sg.setAttribute('aInfo', new THREE.BufferAttribute(sinf, 3));
      sg.setIndex(new THREE.BufferAttribute(sidx, 1));
      sg.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 3.2, 0), 9);
      const smoke = new THREE.Mesh(sg, this.matSmoke);
      smoke.position.copy(p);
      smoke.renderOrder = 11;
      smoke.name = 'sc-fire-smoke';
      this.group.add(smoke);
      this.smokeMesh = smoke;
      this._ownGeo.push(sg);
    }

    // ---- coals: an emissive gradient bedded into the ash, not a glowing disc
    const cg = new THREE.CircleGeometry(0.92, 22);
    cg.rotateX(-Math.PI / 2);
    const cpos = cg.attributes.position;
    for (let i = 0; i < cpos.count; i++) {
      const x = cpos.getX(i), z = cpos.getZ(i);
      cpos.setY(i, -0.02 + ihash1((x * 91 + z * 137) | 0) * 0.07 * (1 - Math.min(1, Math.hypot(x, z) / 0.92)));
    }
    cg.computeVertexNormals();
    const coal = new THREE.Mesh(cg, this.matCoal);
    coal.position.set(p.x, p.y + 0.06, p.z);
    coal.renderOrder = 2;
    coal.name = 'sc-fire-coals';
    this.group.add(coal);
    this.coalMesh = coal;
    this._ownGeo.push(cg);

    // ---- lights. ART §3.2: ALL locals are SpotLights. The key throws light UP and out of the
    // pit (faces, tree trunks, the underside of the canopy); the fill washes the ground ring.
    // ART §3.2 authors these at distance 12 / 7. Measured on 'camp-fire': a SpotLight's
    // `distance` is a hard window (clamp(1 - (d/cut)^4)) and at 7 m the fill was still
    // contributing enough to leave a crisp 6.6 m ellipse of firelight stamped on the grass —
    // the single most artificial thing in the shot. Intensities are unchanged; the cutoffs are
    // pushed out to where the inverse-square term has already taken the light to nothing.
    const key = new THREE.SpotLight(new THREE.Color(PAL.fireMid), 26, 15.5, 1.35, 1.0, 2);
    key.position.set(p.x, p.y + 0.34, p.z);
    key.target.position.set(p.x + 0.9, p.y + 5.5, p.z + 0.4);
    key.castShadow = this._tierIndex >= 2;
    if (key.castShadow) {
      key.shadow.mapSize.set(this._tier(512, 512, 1024, 1024), this._tier(512, 512, 1024, 1024));
      key.shadow.camera.near = 0.35;
      key.shadow.camera.far = 14;
      key.shadow.bias = -0.0012;
      key.shadow.normalBias = 0.045;
      key.shadow.autoUpdate = false;
      key.shadow.needsUpdate = true;
    }
    this.group.add(key, key.target);
    this.fireLight = key;

    const fill = new THREE.SpotLight(new THREE.Color(PAL.fireMid), 11, 11.0, 1.35, 1.0, 2);
    fill.position.set(p.x, p.y + 2.4, p.z);
    fill.target.position.set(p.x, p.y - 1, p.z);
    fill.castShadow = false;
    this.group.add(fill, fill.target);
    this.fireFill = fill;

    this.lights.push(key, fill);
    key.userData.inScene = true;
    fill.userData.inScene = true;
  }

  /**
   * A light that scatters in VolumetricFog and lights the Navmesh, but is NEVER added to the
   * scene — see header note 2. This is how five tents and eight windows glow for free.
   */
  _proxy(x, y, z, hex, intensity, distance, warm) {
    const l = new THREE.PointLight(new THREE.Color(hex), intensity, distance, 2);
    l.position.set(x, y, z);
    l.userData.fogProxy = true;
    l.userData.inScene = false;
    l.updateMatrixWorld(true);
    this.lights.push(l);
    this._proxies.push({ light: l, base: intensity, warm: !!warm, seed: this.rand.next() * 40 });
    return l;
  }

  // =============================================================================================
  // CONTACT DARKENING — one instanced multiply decal per prop. ART §3.5 / hygiene A3.
  // =============================================================================================
  _buildDecals() {
    if (!this._decals.length) return;
    const g = new THREE.PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    const mats = [];
    for (const d of this._decals) {
      _v3.set(d.nx, d.ny, d.nz);
      if (_v3.lengthSq() < 1e-6) _v3.set(0, 1, 0);
      _q.setFromUnitVectors(_up, _v3.normalize());
      const m = new THREE.Matrix4();
      m.compose(_v3b.set(d.x, d.y + 0.035, d.z), _q, _v3c.set(d.r * 2, 1, d.r * 2));
      mats.push(m);
    }
    const mesh = this._instance('contact', g, mats, {
      material: this.matDecal, cast: false, receive: false, renderOrder: 4,
    });
    if (mesh) { mesh.name = 'sc-props-contact'; this._decalMesh = mesh; }
    this._decals.length = 0;
  }

  // =============================================================================================
  // SCATTER — rocks, stumps, fallen logs. Silhouette variety, never a repeated identical instance.
  // =============================================================================================
  _buildScatter() {
    const t = this._terrain;
    const r = this.rand;
    const want = this._tier(60, 100, 150, 200);
    let cand = [];
    if (t && typeof t.getSpawnCandidates === 'function') {
      try {
        cand = t.getSpawnCandidates(want, (i) => !i.water && i.slope < 0.62 && i.surface !== 'gravel', r);
      } catch (e) { Log.warn('Props: getSpawnCandidates failed', e); cand = []; }
    }
    if (!cand.length) return;

    const keepOut = [this.campCenter, this.siteCenter, this.dockPoint];
    const ok = (x, z) => {
      for (const k of keepOut) {
        const d = (k.x - x) * (k.x - x) + (k.z - z) * (k.z - z);
        if (d < (k === this.campCenter ? 42 * 42 : 16 * 16)) return false;
      }
      return true;
    };

    const rockGeos = [
      new THREE.IcosahedronGeometry(0.5, 1),
      new THREE.DodecahedronGeometry(0.5, 0),
      new THREE.IcosahedronGeometry(0.5, 0),
    ];
    for (const g of rockGeos) {
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const h = ihash1((p.getX(i) * 733 + p.getY(i) * 191 + p.getZ(i) * 57) | 0);
        p.setXYZ(i, p.getX(i) * (0.78 + h * 0.5), p.getY(i) * (0.6 + h * 0.4), p.getZ(i) * (0.8 + h * 0.45));
      }
      g.computeVertexNormals();
      metricUV(g, 1, 0, 0);
      const n = p.count;
      const ex = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) { ex[i * 2] = 1; ex[i * 2 + 1] = 1; }
      g.setAttribute('aExposure', new THREE.BufferAttribute(ex, 2));
      trimGeo(g, false);
    }

    const rockM = [[], [], []];
    const stumpM = [];
    const logM = [];
    let placed = 0;
    for (const c of cand) {
      if (!ok(c.x, c.z)) continue;
      const roll = r.next();
      _v3.set(c.nx, c.ny, c.nz);
      if (_v3.lengthSq() < 1e-6) _v3.set(0, 1, 0);
      _v3.normalize();
      if (roll < 0.62) {
        const s = r.gauss(1.05, 0.44);
        const sc = Math.min(3.4, Math.max(0.34, s));
        _q.setFromUnitVectors(_up, _v3);
        _q.multiply(new THREE.Quaternion().setFromAxisAngle(_up, r.next() * 6.283));
        const m = new THREE.Matrix4().compose(
          _v3b.set(c.x, c.y - sc * 0.20, c.z), _q,
          _v3c.set(sc * r.range(0.8, 1.35), sc * r.range(0.6, 1.05), sc * r.range(0.85, 1.3)),
        );
        rockM[r.int(0, 2)].push(m);
        if (sc > 0.9) this._decal(c.x, c.z, sc * 0.85, 0.5);
      } else if (roll < 0.88) {
        const h = r.range(0.35, 1.25), rad = r.range(0.20, 0.52);
        _q.setFromUnitVectors(_up, _v3.lerp(_up, 0.55).normalize());
        _q.multiply(new THREE.Quaternion().setFromAxisAngle(_up, r.next() * 6.283));
        stumpM.push(new THREE.Matrix4().compose(
          _v3b.set(c.x, c.y + h * 0.42, c.z), _q, _v3c.set(rad * 2, h, rad * 2),
        ));
        this._decal(c.x, c.z, rad * 2.4, 0.66);
      } else {
        const len = r.range(2.4, 7.5), rad = r.range(0.16, 0.42);
        _e.set(r.range(-0.09, 0.09), r.next() * 6.283, Math.PI / 2 + r.range(-0.06, 0.06), 'YXZ');
        _q.setFromEuler(_e);
        logM.push(new THREE.Matrix4().compose(
          _v3b.set(c.x, c.y + rad * 0.72, c.z), _q, _v3c.set(rad * 2, len, rad * 2),
        ));
        this._decal(c.x, c.z, len * 0.4, 0.6);
      }
      if (++placed >= want) break;
    }

    for (let i = 0; i < 3; i++) {
      if (rockM[i].length) this._instance(M.stone, rockGeos[i], rockM[i]);
      else rockGeos[i].dispose();
    }
    if (stumpM.length) this._instance(M.bark, this._auxGeo(Kit.UNIT_CYL_HI, 1), stumpM);
    if (logM.length) this._instance(M.bark, this._auxGeo(Kit.UNIT_CYL, 1), logM);
  }

  /** Clone a unit primitive with metric UVs + aExposure, ready for an InstancedMesh. */
  _auxGeo(src, exposure) {
    const g = src.clone();
    metricUV(g, 1, 0, 0);
    const n = g.attributes.position.count;
    const ex = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { ex[i * 2] = exposure === undefined ? 1 : exposure; ex[i * 2 + 1] = 1; }
    g.setAttribute('aExposure', new THREE.BufferAttribute(ex, 2));
    trimGeo(g, false);
    return g;
  }

  // =============================================================================================
  // CAMP WANAKA PINES
  // =============================================================================================
  _buildCamp(kit) {
    const C = this.campCenter;
    const r = this.rand;

    // ---- the row of counselor cabins, with the gap where Cabin Seven stood (ART §0.1)
    const gapIndex = 3;
    for (let i = 0; i < 6; i++) {
      const ex = -26 + r.range(-1.1, 1.1);
      const sz = -24 + i * 10.4 + r.range(-0.7, 0.7);
      const x = C.x + ex, z = C.z + sz;
      if (i === gapIndex) { this._buildCabinGap(kit, x, z); continue; }
      this._buildCabin(kit, x, z, r.range(-0.06, 0.06) + Math.PI * 0.5, i, i === 1 || i === 4);
    }

    this._buildMessHall(kit, C.x + 15, C.z - 8);
    this._buildTents(kit, C.x + 2, C.z + 20);
    this._buildFirepit(kit, C.x, C.z + 4);
    this._buildArchery(kit, C.x + 27, C.z + 20);
    this._buildFlagpole(kit, C.x + 6, C.z - 19);
    this._buildVolleyball(kit, C.x - 9, C.z - 21);
    this._buildClotheslines(kit, C.x - 15, C.z + 8);
    this._buildToolshed(kit, C.x + 30, C.z - 14);
    this._buildCampClutter(kit);

    for (const [name, frame, ox, oz] of PART_SITE_DEFS) {
      const a = frame === 'camp' ? this.campCenter
        : frame === 'dock' ? this.dockPoint
          : frame === 'latrine' ? this.latrinePoint : this.siteCenter;
      const p = this._clampWorld(new THREE.Vector3(a.x + ox, 0, a.z + oz));
      p.y = this._h(p.x, p.z);
      this.partSites.set(name, p);
      this._inter(`site:${name}`, 'part-site', p.x, p.y, p.z);
    }
  }

  /** The rectangle of old foundation stones in the gap. He does not react. */
  _buildCabinGap(kit, x, z) {
    const r = this.rand;
    const y = this._lowest(x, z, 3.4, 2.6, 0);
    kit.clearBase();
    for (let i = 0; i < 14; i++) {
      const t = i / 14;
      const side = i < 7 ? 1 : -1;
      const u = (i % 7) / 6;
      const px = x + (u - 0.5) * 6.4 + r.range(-0.12, 0.12);
      const pz = z + side * 2.3 + r.range(-0.14, 0.14);
      kit.box(M.stone, r.range(0.42, 0.68), r.range(0.16, 0.26), r.range(0.34, 0.5),
        px, y - 0.03 + r.range(-0.02, 0.02), pz, r.range(-0.3, 0.3) + t * 0.1, { exposure: 0.85 });
    }
    // A rectangle of duff-free ground reads as an absence. Four corner stones, dead level.
    for (let i = 0; i < 4; i++) {
      const px = x + ((i & 1) ? 3.1 : -3.1), pz = z + ((i & 2) ? 2.2 : -2.2);
      kit.box(M.stone, 0.62, 0.34, 0.58, px, y - 0.02, pz, r.range(-0.1, 0.1));
      this._decal(px, pz, 0.85, 0.7);
    }
    this._inter('story:cabin-seven-gap', 'story', x, y, z);
  }

  _buildCampClutter(kit) {
    const C = this.campCenter;
    const r = this.rand;
    // Picnic tables + the radio (ART: the camp is the source of all light and sound).
    for (let i = 0; i < 3; i++) {
      const x = C.x + [6, -4, 12][i], z = C.z + [10, 12, 4][i];
      this._buildPicnicTable(kit, x, z, r.range(0, 3.14), i === 0);
    }
    this._buildWheelbarrow(kit, C.x - 20, C.z - 2, r.range(0, 6.28));
    this._buildCooler(kit, C.x + 3.4, C.z + 7.2, 0.4);
    this._buildCooler(kit, C.x - 2.2, C.z + 9.6, 2.1);
    this._buildCampChairs(kit);
  }

  // =============================================================================================
  // BUILDINGS
  // =============================================================================================
  _buildCabin(kit, x, z, ry, seed, lit) {
    const r = new Rand(0x0CAB1 + seed * 977);
    const w = 6.4 + r.range(-0.5, 0.7);
    const d = 4.6 + r.range(-0.35, 0.45);
    const wallH = 2.35 + r.range(-0.12, 0.18);
    const floor = 0.46;
    const y = this._lowest(x, z, w * 0.6, d * 0.7, ry);
    kit.setBase(TRS(x, y, z, ry));

    const hw = w / 2, hd = d / 2;
    // cabin-local <-> world. TRS composes a pure Y rotation, so the pair is just R and R^T.
    const cR = Math.cos(ry), sR = Math.sin(ry);
    const toW = (lx, ly, lz) => ({ x: x + lx * cR + lz * sR, y: y + ly, z: z - lx * sR + lz * cR });
    const toLX = (px, pz) => (px - x) * cR - (pz - z) * sR;
    const toLZ = (px, pz) => (px - x) * sR + (pz - z) * cR;

    // piers — the cabin is bedded on stone, never floating
    for (let i = 0; i < 6; i++) {
      const px = -hw + (i % 3) * hw, pz = (i < 3 ? -hd : hd) * 0.86;
      kit.box(M.stone, 0.46, floor + 0.34, 0.46, px, floor * 0.5 - 0.18, pz, r.range(-0.2, 0.2));
    }
    // floor platform + skirt
    kit.box(M.wood, w, 0.16, d, 0, floor, 0, 0, { exposure: 0.45 });
    kit.box(M.wood, w + 0.05, 0.30, 0.05, 0, floor - 0.2, hd, 0, { exposure: 0.2 });

    // clapboard walls — nine lapped boards a side, each proud of the last. Real relief, real
    // silhouette, and the moon grazes across it.
    //
    // Six cabins merged into one mesh share one material, so nothing in the standard pipeline
    // gives them per-building variation — instancing's free +/-9% albedo jitter does not apply to
    // merged geometry, which is exactly why the row read as six identical grey boxes from the
    // ridge. `aExposure` is the one per-vertex lever Materials honours: it drives how much
    // weather a surface has taken, and a wetter wall is a darker wall. Spreading it 0.52..0.97
    // across the row gives the six cabins genuinely different values, and the same seed makes the
    // WINDWARD side of each cabin wetter than its lee side, which is how a real row weathers.
    const wet = 0.52 + ihash1(seed * 9173 + 31) * 0.45;
    const boards = 9;
    const bh = wallH / boards;
    for (let b = 0; b < boards; b++) {
      const by = floor + 0.08 + bh * (b + 0.5);
      const prou = 0.045 + (b % 2) * 0.012;
      const sag = Math.sin(b * 1.7 + seed) * 0.006;
      const drip = 1 - (b / boards) * 0.22;                 // the sill courses stay wettest
      kit.box(M.wood, w, bh * 1.06, 0.09 + prou, 0, by + sag, -hd, 0,
        { exposure: wet * drip, uvOffset: b * 0.31 });
      kit.box(M.wood, w, bh * 1.06, 0.09 + prou, 0, by - sag, hd, 0,
        { exposure: Math.min(1, wet * 1.25) * drip, uvOffset: b * 0.17 });
      kit.box(M.wood, 0.09 + prou, bh * 1.06, d, -hw, by, 0, 0,
        { exposure: wet * 0.82 * drip, uvOffset: b * 0.43 });
      kit.box(M.wood, 0.09 + prou, bh * 1.06, d, hw, by, 0, 0,
        { exposure: Math.min(1, wet * 1.15) * drip, uvOffset: b * 0.23 });
    }
    // corner boards
    for (let i = 0; i < 4; i++) {
      kit.box(M.wood, 0.16, wallH, 0.16, (i & 1) ? hw : -hw, floor + wallH * 0.5 + 0.08, (i & 2) ? hd : -hd, 0);
    }

    // ---- ROOF. The ridge runs along X; the eaves are at ±Z; the GABLE TRIANGLES therefore
    // belong at ±X, under the ends of the ridge. They used to be a five-box staircase standing
    // at ±Z — i.e. at the low edge of the roof, poking a lump of wall above the eave line — so
    // no cabin in the camp had a gable at all and every one of them read as a shoebox with a
    // lid. Real wedges, at the right end, plus an overhang big enough to throw an eave shadow.
    const ridgeH = wallH + 1.05 + r.range(-0.1, 0.14);
    const gabH = ridgeH - wallH;
    const eaveOver = 0.44;                      // past the wall at ±Z
    const rakeOver = 0.34;                      // past the wall at ±X
    const eaveY = floor + 0.08 + wallH;
    const slope = Math.atan2(gabH, hd);
    const tanS = gabH / hd;
    const plateD = (hd + eaveOver) / Math.cos(slope);
    const plateW = w + rakeOver * 2;
    for (const s of [-1, 1]) {
      const pz = s * (hd + eaveOver) * 0.5;
      const py = floor + 0.08 + ridgeH - (hd + eaveOver) * tanS * 0.5;
      // The roof is the most exposed surface on the building and the one the ridge shot sees
      // most of; the two slopes weather differently because only one of them faces the weather.
      const roofWet = s < 0 ? 1.0 : 0.62 + wet * 0.3;
      kit.box(M.tin, plateW, 0.07, plateD, 0, py, pz, 0, { rx: s * slope, exposure: roofWet, uvScale: 1 });
      // corrugation. Ribs run down-slope every 26 cm; each one is a shadow line at midday and a
      // grazing specular streak under the moon. This is what makes a tin roof read as tin.
      const ribs = Math.max(6, Math.round(plateW / 0.26));
      for (let k = 0; k < ribs; k++) {
        const rx0 = -plateW * 0.5 + (k + 0.5) * (plateW / ribs);
        kit.box(M.tin, 0.052, 0.155, plateD * 0.995, rx0, py, pz, 0,
          { rx: s * slope, exposure: roofWet, uvScale: 2 });
      }
      // fascia along the eave, rafter tails poking out beneath it
      const ez = s * (hd + eaveOver);
      const ey = eaveY - eaveOver * tanS;
      kit.box(M.wood, plateW, 0.20, 0.05, 0, ey - 0.10, ez, 0, { exposure: 0.85 });
      for (let k = 0; k < 7; k++) {
        const tx = -w * 0.5 + (k + 0.5) * (w / 7);
        kit.box(M.wood, 0.07, 0.11, eaveOver + 0.10, tx, ey - 0.05, s * (hd + eaveOver * 0.5), 0,
          { rx: s * slope, exposure: 0.7 });
      }
      // barge boards up the rake, one each side
      for (const q of [-1, 1]) {
        kit.box(M.wood, 0.06, 0.19, plateD, q * (plateW * 0.5 - 0.03), py - 0.09, pz, 0,
          { rx: s * slope, exposure: 0.8 });
      }
      // moss / weather streak down the slope, sitting just proud of the deck
      const sp = toW(r.range(-1.3, 1.3), py + 0.075, pz);
      this._stain(sp.x, sp.y, sp.z, plateW * 0.5, plateD * 0.72, ry, s * slope - Math.PI / 2, 0);
    }
    kit.box(M.tin, plateW + 0.06, 0.13, 0.34, 0, floor + 0.10 + ridgeH, 0, 0, { uvScale: 2 });
    for (const s of [-1, 1]) {
      kit.add(M.wood, Kit.UNIT_WEDGE, TRS(s * hw, eaveY + gabH * 0.5, 0, Math.PI / 2, d, gabH, 0.11),
        { exposure: 0.8 });
      // a vent louvre in the gable peak — three slats, black behind
      for (let k = 0; k < 3; k++) {
        kit.box(M.wood, 0.06, 0.05, 0.52, s * (hw + 0.02), eaveY + gabH * 0.55 + k * 0.09, 0, 0,
          { rz: 0.22, exposure: 0.6 });
      }
    }

    // ---- STOVEPIPE. Every one of these cabins is heated by a wood stove, and the flue is the
    // one thing that breaks a cabin's rectangle against a treeline at 70 m.
    const fx = -hw * 0.42, fz = hd * 0.30;
    const fRoofY = floor + 0.10 + ridgeH - Math.abs(fz) * (gabH / hd);
    kit.add(M.rust, Kit.UNIT_CYL, TRS(fx, fRoofY + 0.62, fz, 0, 0.15, 1.34, 0.15, 0, 0.035), { exposure: 1 });
    kit.add(M.rust, Kit.UNIT_CONE, TRS(fx + 0.05, fRoofY + 1.36, fz, 0, 0.30, 0.16, 0.30, 0, Math.PI));
    kit.box(M.tin, 0.44, 0.03, 0.44, fx, fRoofY + 0.02, fz, 0.3, { exposure: 1 });   // flashing

    // ---- WINDOWS. Frame, sill that projects and sheds water, head casing, a real mullion cross,
    // and a recessed reveal so the lit pane is INSIDE the wall instead of stuck to the front of it.
    const winY = floor + 1.32;
    const winW = 0.86, winH = 1.02;
    const winsN = [-1.55, 1.55];
    for (const wx of winsN) {
      kit.box(M.wood, winW + 0.22, winH + 0.22, 0.09, wx, winY, -hd - 0.045, 0, { exposure: 0.9 });
      kit.box(M.wood, winW + 0.16, winH + 0.16, 0.16, wx, winY, -hd + 0.06, 0, { exposure: 0.35 });
      kit.box(M.glass, winW, winH, 0.03, wx, winY, -hd + 0.02, 0, { exposure: 0.3 });
      kit.box(M.wood, 0.05, winH + 0.02, 0.07, wx, winY, -hd - 0.06, 0, { exposure: 1 });
      kit.box(M.wood, winW + 0.02, 0.05, 0.07, wx, winY, -hd - 0.06, 0, { exposure: 1 });
      kit.box(M.wood, winW + 0.34, 0.07, 0.17, wx, winY - winH * 0.5 - 0.13, -hd - 0.07, 0,
        { rx: 0.13, exposure: 1 });                                     // sill
      kit.box(M.wood, winW + 0.36, 0.09, 0.20, wx, winY + winH * 0.5 + 0.15, -hd - 0.08, 0,
        { rx: -0.10, exposure: 1 });                                    // head drip cap
      const ws = toW(wx, winY - winH * 0.5 - 0.60, -hd - 0.075);
      this._stain(ws.x, ws.y, ws.z, winW + 0.55, 1.15, ry + Math.PI, 0, 0);
    }
    // gable-end window, and a shutter hanging off one hinge on the far one
    kit.box(M.wood, winW + 0.20, winH + 0.20, 0.10, hw + 0.045, winY, 1.0, Math.PI / 2, { exposure: 0.9 });
    kit.box(M.glass, winW, winH, 0.03, hw - 0.02, winY, 1.0, Math.PI / 2, { exposure: 0.3 });
    kit.box(M.wood, 0.05, winH, 0.06, hw + 0.06, winY, 1.0, Math.PI / 2, { exposure: 1 });
    kit.box(M.wood, 0.44, winH + 0.10, 0.045, hw + 0.10, winY - 0.06, 1.0 - winW * 0.5 - 0.24,
      Math.PI / 2, { rx: 0.26, exposure: 0.75 });

    // ---- FIREWOOD RICK against the east wall. Bedded, stacked, half-collapsed at one end.
    for (let row = 0; row < 4; row++) {
      const n = row === 3 ? 4 : 6;
      for (let k = 0; k < n; k++) {
        const lz = -1.2 + k * 0.30 + r.range(-0.02, 0.02);
        const lyy = 0.16 + row * 0.28 + (row === 3 ? r.range(-0.03, 0.03) : 0);
        kit.add(M.bark, Kit.UNIT_CYL,
          TRS(hw + 0.34 + r.range(-0.03, 0.03), lyy, lz, 0,
            r.range(0.24, 0.30), r.range(0.42, 0.56), r.range(0.24, 0.30), 0, Math.PI / 2 + r.range(-0.05, 0.05)),
          { exposure: 0.55 });
      }
    }
    kit.box(M.tin, 0.90, 0.02, 2.30, hw + 0.34, 1.28, -0.15, 0, { rx: 0.06, exposure: 1 });

    if (lit) {
      // The pane itself, and a HALO on the clapboard around it. A lit window with a hard edge and
      // nothing spilling onto the boards beside it is a decal; the halo is what makes it a light.
      const gw = winW * 0.98, gh = winH * 0.98;
      kit.add('glow-window', Kit.UNIT_PLANE, TRS(-1.55, winY, -hd - 0.09, 0, gw, gh, 1), { glow: 1 });
      kit.add('glow-window', Kit.UNIT_PLANE, TRS(1.55, winY, -hd - 0.09, 0, gw * 0.9, gh, 1), { glow: 0.7 });
      // The halo is authored in CABIN-LOCAL space — the vertices Kit hands the glowFn are already
      // in world space, so they are folded back through R^T first. Measuring a local offset with
      // world coordinates is how the old ground-spill ended up as a hard-edged warm rectangle.
      const halo = new THREE.PlaneGeometry(1, 1, 10, 10);
      for (const wx of winsN) {
        kit.add('glow-window', halo, TRS(wx, winY, -hd - 0.115, 0, 3.0, 2.6, 1), {
          glowFn: (gx, gy2, gz) => {
            const t = 1 - Math.hypot((toLX(gx, gz) - wx) / 1.42, (gy2 - y - winY) / 1.20);
            return t > 0 ? 0.10 * t * t * t : 0;
          },
        });
      }
      halo.dispose();
      // Warm spill on the ground under the window. The falloff MUST reach zero inside the quad.
      // The old term (0.22 - 0.03*d, measured from the cabin centre) was still ~0.10 at the
      // quad's corners, so every lit cabin laid a hard-edged 5.0 x 3.4 m warm rectangle on the
      // grass — a lit slab, not light. Radial from the spill's own centre, squared, to zero.
      const spillC = new THREE.Vector3(0, 0, -hd - 1.5).applyMatrix4(TRS(x, y, z, ry));
      kit.add('glow-window', Kit.UNIT_PLANE,
        TRS(0, -y + this._h(x, z) + 0.05, -hd - 1.5, 0, 5.0, 3.4, 1, -Math.PI / 2),
        {
          glowFn: (gx, gy, gz) => {
            const t = 1 - Math.hypot(gx - spillC.x, gz - spillC.z) / 2.3;
            return t > 0 ? 0.085 * t * t : 0;
          },
        });
      const wp = new THREE.Vector3(-1.55, winY, -hd - 0.4).applyMatrix4(TRS(x, y, z, ry));
      this._proxy(wp.x, wp.y, wp.z, PAL.lantern, 2.4, 9, true);
      this._decal(x, z - hd - 1.2, 2.6, 0.18);
    }

    // porch: deck, three posts (one leaning), a sagging rail, steps, a screen door
    const pd = 1.75;
    kit.box(M.wood, w - 0.3, 0.12, pd, 0, floor, -hd - pd * 0.5, 0, { exposure: 0.9 });
    for (let i = 0; i < 3; i++) {
      const px = (i - 1) * (w * 0.35);
      const lean = i === 2 ? 0.055 : 0.006;
      kit.box(M.wood, 0.13, 2.15, 0.13, px, floor + 1.1, -hd - pd + 0.16, 0, { rz: lean, exposure: 0.7 });
      // stone pad under each post, and a knee brace back to the header — the two details that
      // stop a porch post reading as a floating stick
      kit.box(M.stone, 0.30, 0.16, 0.30, px, floor - 0.06, -hd - pd + 0.16, r.range(-0.3, 0.3));
      for (const q of [-1, 1]) {
        kit.add(M.wood, Kit.UNIT_BOX,
          TRS(px + q * 0.20, floor + 1.92, -hd - pd + 0.16, 0, 0.07, 0.56, 0.07, 0, q * 0.72),
          { exposure: 0.6 });
      }
    }
    kit.box(M.wood, w - 0.4, 0.09, 0.09, 0, floor + 0.92, -hd - pd + 0.16, 0, { rz: -0.012, exposure: 0.7 });
    kit.box(M.wood, w - 0.3, 0.14, 0.12, 0, floor + 2.14, -hd - pd + 0.16, 0, { exposure: 0.7 });
    // porch roof: its own little corrugated shed, with ribs and a drip edge
    kit.box(M.tin, w + 0.35, 0.06, pd + 0.55, 0, floor + 2.28, -hd - pd * 0.55, 0, { rx: 0.20 });
    for (let k = 0; k < Math.round((w + 0.35) / 0.26); k++) {
      const px2 = -(w + 0.35) * 0.5 + (k + 0.5) * 0.26;
      kit.box(M.tin, 0.05, 0.13, pd + 0.52, px2, floor + 2.28, -hd - pd * 0.55, 0,
        { rx: 0.20, uvScale: 2 });
    }
    kit.box(M.wood, w + 0.35, 0.13, 0.04, 0, floor + 2.10, -hd - pd - 0.29, 0, { exposure: 0.85 });
    for (let i = 0; i < 3; i++) {
      kit.box(M.wood, 1.35, 0.09, 0.30, 0, floor - 0.14 * (i + 1), -hd - pd - 0.16 - i * 0.28, 0, { exposure: 0.6 });
      kit.box(M.wood, 0.09, 0.16, 0.30, -0.68, floor - 0.14 * (i + 1) - 0.09, -hd - pd - 0.16 - i * 0.28, 0, { exposure: 0.5 });
      kit.box(M.wood, 0.09, 0.16, 0.30, 0.68, floor - 0.14 * (i + 1) - 0.09, -hd - pd - 0.16 - i * 0.28, 0, { exposure: 0.5 });
    }
    // a bench, a pair of boots and an enamel basin on the porch. Somebody lives here.
    kit.box(M.wood, 1.30, 0.06, 0.34, -w * 0.28, floor + 0.50, -hd - 0.52, 0.03, { exposure: 0.9 });
    for (const q of [-1, 1]) {
      kit.box(M.wood, 0.08, 0.38, 0.30, -w * 0.28 + q * 0.55, floor + 0.29, -hd - 0.52, 0, { exposure: 0.7 });
    }
    for (const q of [-1, 1]) {
      kit.box(M.tarp, 0.11, 0.17, 0.28, w * 0.24 + q * 0.08, floor + 0.20, -hd - 0.46,
        r.range(-0.3, 0.3) + q * 0.15, { exposure: 0.7 });
    }
    kit.add(M.steel, new THREE.CylinderGeometry(0.19, 0.14, 0.11, 14, 1),
      TRS(w * 0.30, floor + 0.62, -hd - pd + 0.42, 0.4, 1, 1, 1, 0.05), { exposure: 0.8 });
    const ajar = seed === 2 ? 0.55 : 0.02;
    kit.setBase(TRS(x, y, z, ry));
    const doorM = TRS(0, floor + 1.12, -hd - 0.06, 0, 1, 1, 1);
    const doorPivot = new THREE.Matrix4().multiplyMatrices(doorM, TRS(0.45, 0, 0, ajar));
    kit.add(M.wood, Kit.UNIT_BOX, new THREE.Matrix4().multiplyMatrices(doorPivot, TRS(-0.45, 0, 0, 0, 0.88, 2.02, 0.05)), { exposure: 0.55 });
    kit.add(M.rope, Kit.UNIT_BOX, new THREE.Matrix4().multiplyMatrices(doorPivot, TRS(-0.45, 0.16, -0.03, 0, 0.72, 1.42, 0.012)), { exposure: 0.5 });

    kit.clearBase();
    // Contact darkening, in WORLD space. These two used to be written as (x, z - hd - pd/2),
    // which is only the porch for a cabin at ry = 0; every cabin in the row is rotated 90 deg,
    // so the porch shadow was landing on the gable end of the cabin next door.
    const pc = toW(0, 0, -hd - pd * 0.5);
    const fw = toW(hw + 0.34, 0, -0.15);
    this._decal(x, z, Math.max(w, d) * 0.62, 0.72);
    this._decal(pc.x, pc.z, w * 0.4, 0.5);
    this._decal(fw.x, fw.z, 1.4, 0.66);
    this._inter(`cabin:${seed}`, 'building', x, y + floor, z);
  }

  _buildMessHall(kit, x, z) {
    const r = new Rand(0x0E55);
    const w = 14.5, d = 9.2, wallH = 3.3, floor = 0.5;
    const ry = 0.04;
    const y = this._lowest(x, z, w * 0.6, d * 0.6, ry);
    kit.setBase(TRS(x, y, z, ry));
    const hw = w / 2, hd = d / 2;
    const cR = Math.cos(ry), sR = Math.sin(ry);
    const toW = (lx, ly, lz) => ({ x: x + lx * cR + lz * sR, y: y + ly, z: z - lx * sR + lz * cR });

    for (let i = 0; i < 8; i++) {
      kit.box(M.stone, 0.55, floor + 0.4, 0.55, -hw + (i % 4) * (w / 3), floor * 0.5 - 0.2, (i < 4 ? -hd : hd) * 0.88, 0);
    }
    kit.box(M.wood, w, 0.18, d, 0, floor, 0, 0, { exposure: 0.4 });

    const boards = 12, bh = wallH / boards;
    for (let b = 0; b < boards; b++) {
      const by = floor + 0.09 + bh * (b + 0.5);
      const pr = 0.034 + (b % 2) * 0.01;
      kit.box(M.wood, w, bh * 1.05, 0.10 + pr, 0, by, -hd, 0, { exposure: 0.95, uvOffset: b * 0.29 });
      kit.box(M.wood, w, bh * 1.05, 0.10 + pr, 0, by, hd, 0, { exposure: 0.95, uvOffset: b * 0.13 });
      kit.box(M.wood, 0.10 + pr, bh * 1.05, d, -hw, by, 0, 0, { exposure: 0.95, uvOffset: b * 0.37 });
      kit.box(M.wood, 0.10 + pr, bh * 1.05, d, hw, by, 0, 0, { exposure: 0.95, uvOffset: b * 0.51 });
    }

    // ---- ROOF. Same correction as the cabins: the gable wedges belong at ±X under the ends of
    // the ridge, not at ±Z where the roof is at its lowest. Corrugation ribs, a deep eave with
    // rafter tails, and a ridge vent, because 14.5 m of unbroken tin is a mirror.
    const ridgeH = wallH + 1.9;
    const gabH = ridgeH - wallH;
    const eaveOver = 0.62;
    const eaveY = floor + 0.09 + wallH;
    const slope = Math.atan2(gabH, hd);
    const tanS = gabH / hd;
    const plateD = (hd + eaveOver) / Math.cos(slope);
    const plateW = w + 0.9;
    for (const s of [-1, 1]) {
      const pz = s * (hd + eaveOver) * 0.5;
      const py = floor + 0.09 + ridgeH - (hd + eaveOver) * tanS * 0.5;
      kit.box(M.tin, plateW, 0.08, plateD, 0, py, pz, 0, { rx: s * slope, uvScale: 1 });
      const ribs = Math.round(plateW / 0.28);
      for (let k = 0; k < ribs; k++) {
        kit.box(M.tin, 0.055, 0.17, plateD * 0.995,
          -plateW * 0.5 + (k + 0.5) * (plateW / ribs), py, pz, 0, { rx: s * slope, uvScale: 2 });
      }
      const ey = eaveY - eaveOver * tanS;
      kit.box(M.wood, plateW, 0.24, 0.06, 0, ey - 0.12, s * (hd + eaveOver), 0, { exposure: 0.85 });
      for (let k = 0; k < 11; k++) {
        kit.box(M.wood, 0.08, 0.13, eaveOver + 0.12, -w * 0.5 + (k + 0.5) * (w / 11), ey - 0.06,
          s * (hd + eaveOver * 0.5), 0, { rx: s * slope, exposure: 0.7 });
      }
      const sp = toW(r.range(-4, 4), py + 0.09, pz);
      this._stain(sp.x, sp.y, sp.z, 4.2, plateD * 0.8, ry, s * slope - Math.PI / 2, 0);
    }
    kit.box(M.tin, plateW + 0.05, 0.14, 0.34, 0, floor + 0.12 + ridgeH, 0, 0, { uvScale: 2 });
    // ridge vent — a raised louvred cap running two thirds of the ridge
    kit.box(M.tin, w * 0.62, 0.20, 0.62, 0, floor + 0.30 + ridgeH, 0, 0, { uvScale: 2 });
    for (let k = 0; k < 9; k++) {
      kit.box(M.rust, w * 0.60, 0.03, 0.05, 0, floor + 0.22 + ridgeH + k * 0.018, -0.30 + k * 0.07, 0);
    }
    for (const s of [-1, 1]) {
      kit.add(M.wood, Kit.UNIT_WEDGE, TRS(s * hw, eaveY + gabH * 0.5, 0, Math.PI / 2, d, gabH, 0.12),
        { exposure: 0.8 });
      for (let k = 0; k < 4; k++) {
        kit.box(M.wood, 0.07, 0.06, 1.0, s * (hw + 0.02), eaveY + gabH * 0.45 + k * 0.11, 0, 0,
          { rz: 0.24, exposure: 0.6 });
      }
    }

    // the stone chimney — four stacked, jittered courses, taller than the ridge
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      const cw = 1.55 - t * 0.42;
      kit.box(M.stone, cw, 0.86, cw * 0.86, hw - 0.35, floor + 0.4 + i * 0.86, 2.2,
        r.range(-0.05, 0.05), { exposure: 1, uvOffset: i * 0.7 });
    }
    kit.box(M.stone, 1.28, 0.16, 1.12, hw - 0.35, floor + 0.4 + 7 * 0.86, 2.2, 0);

    // porch + the sodium lamp, the only fixed light at camp (ART §2.2)
    const pd = 2.6;
    kit.box(M.wood, w - 0.6, 0.14, pd, 0, floor, -hd - pd * 0.5, 0, { exposure: 0.9 });
    for (let i = 0; i < 5; i++) {
      kit.box(M.wood, 0.15, 2.95, 0.15, (i - 2) * (w * 0.21), floor + 1.5, -hd - pd + 0.2, 0, { exposure: 0.7 });
    }
    kit.box(M.wood, w - 0.6, 0.11, 0.11, 0, floor + 1.0, -hd - pd + 0.2, 0, { rz: 0.008, exposure: 0.7 });
    kit.box(M.tin, w + 0.5, 0.07, pd + 0.7, 0, floor + 3.05, -hd - pd * 0.55, 0, { rx: 0.18 });
    for (let i = 0; i < 4; i++) {
      kit.box(M.wood, 2.6, 0.10, 0.32, -2.0, floor - 0.13 * (i + 1), -hd - pd - 0.18 - i * 0.30, 0, { exposure: 0.6 });
    }
    // lamp fixture: a galvanized cone shade on a bracket
    kit.box(M.steel, 0.07, 0.07, 0.5, 2.6, floor + 2.62, -hd - 0.35, 0);
    kit.add(M.steel, Kit.UNIT_CONE, TRS(2.6, floor + 2.46, -hd - 0.62, 0, 0.52, 0.30, 0.52, Math.PI));
    kit.add('glow-window', Kit.UNIT_SPHERE, TRS(2.6, floor + 2.36, -hd - 0.62, 0, 0.20, 0.20, 0.20), { glow: 2.2 });

    // four lit windows: the mess hall is the brightest human thing in the world
    for (let i = 0; i < 4; i++) {
      const wx = -4.8 + i * 3.2;
      kit.box(M.wood, 1.12, 1.35, 0.14, wx, floor + 1.75, -hd, 0);
      kit.box(M.glass, 0.98, 1.22, 0.05, wx, floor + 1.75, -hd - 0.03, 0, { exposure: 0.3 });
      kit.box(M.wood, 0.06, 1.22, 0.06, wx, floor + 1.75, -hd - 0.06, 0);
      kit.add('glow-window', Kit.UNIT_PLANE, TRS(wx, floor + 1.75, -hd - 0.08, 0, 0.96, 1.20, 1),
        { glow: i === 2 ? 0.55 : 1.0 });
    }
    for (let i = 0; i < 2; i++) {
      kit.box(M.glass, 0.98, 1.22, 0.05, hw + 0.02, floor + 1.75, -1.6 + i * 3.2, Math.PI / 2, { exposure: 0.3 });
      kit.add('glow-window', Kit.UNIT_PLANE, TRS(hw + 0.06, floor + 1.75, -1.6 + i * 3.2, Math.PI / 2, 0.96, 1.20, 1), { glow: 0.8 });
    }

    // the bell, on its own post by the door
    kit.box(M.wood, 0.16, 2.9, 0.16, -hw + 1.2, floor + 1.45, -hd - pd - 0.9, 0);
    kit.box(M.wood, 0.7, 0.12, 0.12, -hw + 1.2, floor + 2.82, -hd - pd - 0.9, 0);
    kit.add(M.steel, Kit.UNIT_CONE, TRS(-hw + 1.55, floor + 2.52, -hd - pd - 0.9, 0, 0.44, 0.42, 0.44, Math.PI));
    kit.box(M.steel, 0.03, 0.30, 0.03, -hw + 1.55, floor + 2.40, -hd - pd - 0.9, 0);
    kit.add(M.rope, Kit.UNIT_CYL, TRS(-hw + 1.55, floor + 1.75, -hd - pd - 0.9, 0, 0.016, 1.3, 0.016));

    // screen door, and the clipboard with the only date in the game (Shot 6)
    kit.box(M.wood, 1.05, 2.15, 0.06, 0, floor + 1.18, -hd - 0.05, 0, { exposure: 0.55 });
    kit.box(M.rope, 0.88, 1.55, 0.015, 0, floor + 1.30, -hd - 0.08, 0, { exposure: 0.5 });
    kit.box(M.lumber, 0.26, 0.34, 0.02, -3.0, floor + 1.55, -hd - 0.10, 0, { exposure: 0.4 });

    // the photo board is inside, on the west wall (Script.props photo_board)
    kit.box(M.wood, 2.2, 1.3, 0.06, -hw + 0.2, floor + 1.9, 1.2, Math.PI / 2, { exposure: 0.05 });

    // ---- THE KITCHEN SIDE. A propane tank on a slab, a grease drum, milk crates, a bin with the
    // lid tipped off. This is the wall the sodium lamp actually lights, and it was bare.
    kit.box(M.concrete, 1.5, 0.14, 1.0, hw - 3.6, floor - 0.28, hd + 0.9, 0, { exposure: 1 });
    kit.add(M.steel, Kit.UNIT_CYL, TRS(hw - 3.6, floor + 0.30, hd + 0.9, 0, 0.86, 1.10, 0.86), { exposure: 1 });
    kit.add(M.steel, Kit.UNIT_SPHERE, TRS(hw - 3.6, floor + 0.85, hd + 0.9, 0, 0.86, 0.42, 0.86), { exposure: 1 });
    kit.add(M.rust, Kit.UNIT_CYL, TRS(hw - 3.6, floor + 1.02, hd + 0.9, 0, 0.13, 0.22, 0.13));
    kit.add(M.rust, Kit.UNIT_CYL, TRS(hw - 1.9, floor + 0.16, hd + 1.05, 0.4, 0.58, 0.88, 0.58), { exposure: 1 });
    kit.add(M.rust, Kit.UNIT_CYL, TRS(hw - 1.9, floor + 0.62, hd + 1.05, 0.4, 0.60, 0.05, 0.60));
    for (let i = 0; i < 5; i++) {
      const cx2 = hw - 5.6 - (i % 2) * 0.46, cy2 = floor - 0.18 + ((i / 2) | 0) * 0.31;
      kit.box(M.tarp, 0.42, 0.30, 0.42, cx2, cy2, hd + 0.7, r.range(-0.2, 0.2), { exposure: 0.9 });
    }
    kit.add(M.tarp, Kit.UNIT_CYL, TRS(hw - 0.4, floor + 0.12, hd + 0.8, 0.2, 0.62, 0.86, 0.62), { exposure: 0.9 });
    kit.add(M.tarp, Kit.UNIT_CYL, TRS(hw - 0.1, floor - 0.24, hd + 1.6, 0.9, 0.64, 0.06, 0.64), { exposure: 0.9 });
    const kw = toW(hw - 2.8, 0, hd + 1.0);
    this._decal(kw.x, kw.z, 3.4, 0.72);
    // long weather streak down the north wall under the eave
    const mw = toW(-1.2, floor + wallH * 0.55, -hd - 0.06);
    this._stain(mw.x, mw.y, mw.z, 7.0, wallH * 0.9, ry + Math.PI, 0, 0);

    kit.clearBase();
    const world = new THREE.Vector3(2.6, floor + 2.36, -hd - 0.62).applyMatrix4(TRS(x, y, z, ry));
    const lamp = new THREE.SpotLight(new THREE.Color(PAL.sodium), 28, 16, 1.1, 0.9, 2);
    lamp.position.copy(world);
    lamp.target.position.set(world.x + 0.4, y, world.z - 2.2);
    lamp.castShadow = this._tierIndex >= 2;
    if (lamp.castShadow) {
      const s = this._tier(512, 512, 1024, 1024);
      lamp.shadow.mapSize.set(s, s);
      lamp.shadow.camera.near = 0.4;
      lamp.shadow.camera.far = 18;
      lamp.shadow.bias = -0.0011;
      lamp.shadow.normalBias = 0.04;
      lamp.shadow.autoUpdate = false;
      lamp.shadow.needsUpdate = true;
    }
    lamp.userData.inScene = true;
    this.group.add(lamp, lamp.target);
    this.sodiumLight = lamp;
    this.lights.push(lamp);

    const winW = new THREE.Vector3(0, floor + 1.75, -hd - 0.6).applyMatrix4(TRS(x, y, z, ry));
    this._proxy(winW.x, winW.y, winW.z, PAL.lantern, 3.4, 12, true);

    this._decal(x, z, 8.4, 0.75);
    this._decal(x, z - hd - pd * 0.5, 6.0, 0.5);
    this._inter('mess-hall', 'building', x, y + floor, z);
    this._inter('story:photo_board', 'story', x - hw * 0.9, y + floor + 1.9, z + 1.2);
    this.messHall = new THREE.Vector3(x, y, z);
  }

  _buildToolshed(kit, x, z) {
    const ry = 0.9;
    const y = this._lowest(x, z, 2.2, 1.8, ry);
    kit.setBase(TRS(x, y, z, ry));
    kit.box(M.wood, 3.6, 0.14, 2.8, 0, 0.24, 0, 0, { exposure: 0.4 });
    for (let b = 0; b < 8; b++) {
      const by = 0.32 + 0.28 * (b + 0.5);
      kit.box(M.wood, 3.6, 0.30, 0.10, 0, by, -1.4, 0, { exposure: 0.95, uvOffset: b * 0.4 });
      kit.box(M.wood, 3.6, 0.30, 0.10, 0, by + 0.32, 1.4, 0, { exposure: 0.95, uvOffset: b * 0.2 });
      kit.box(M.wood, 0.10, 0.30, 2.8, -1.8, by + 0.16, 0, 0, { exposure: 0.95 });
      kit.box(M.wood, 0.10, 0.30, 2.8, 1.8, by + 0.16, 0, 0, { exposure: 0.95 });
    }
    kit.box(M.tin, 3.9, 0.06, 3.1, 0, 2.72, 0, 0, { rx: 0.20 });
    kit.box(M.wood, 1.0, 1.95, 0.06, 0.6, 1.25, -1.46, 0, { exposure: 0.5 });
    kit.box(M.rust, 0.10, 0.10, 0.03, 1.0, 1.25, -1.52, 0);
    kit.clearBase();
    this._decal(x, z, 3.0, 0.7);
    this._inter('toolshed', 'building', x, y, z);
  }

  _buildLatrine(kit) {
    const p = this.latrinePoint;
    const x = p.x, z = p.z, ry = 2.4;
    const y = this._lowest(x, z, 1.1, 1.1, ry);
    kit.setBase(TRS(x, y, z, ry));
    kit.box(M.concrete, 1.9, 0.22, 1.9, 0, 0.11, 0, 0, { exposure: 0.7 });
    for (let b = 0; b < 7; b++) {
      const by = 0.24 + 0.32 * (b + 0.5);
      kit.box(M.wood, 1.7, 0.34, 0.09, 0, by, -0.85, 0, { exposure: 0.95, uvOffset: b * 0.5 });
      kit.box(M.wood, 1.7, 0.34, 0.09, 0, by, 0.85, 0, { exposure: 0.95, uvOffset: b * 0.3 });
      kit.box(M.wood, 0.09, 0.34, 1.7, -0.85, by, 0, 0, { exposure: 0.95 });
      kit.box(M.wood, 0.09, 0.34, 1.7, 0.85, by, 0, 0, { exposure: 0.95 });
    }
    kit.box(M.tin, 2.1, 0.06, 2.2, 0, 2.58, 0, 0, { rx: 0.16 });
    kit.box(M.wood, 0.78, 1.85, 0.06, 0, 1.16, -0.90, 0, { exposure: 0.5 });
    kit.box(M.rust, 0.16, 0.05, 0.03, 0.28, 1.16, -0.95, 0);
    kit.add(M.rust, Kit.UNIT_CYL, TRS(0.65, 2.9, 0.4, 0, 0.10, 1.6, 0.10));
    kit.clearBase();
    this._decal(x, z, 1.8, 0.72);
    this._inter('latrine', 'building', x, y, z);
  }

  // =============================================================================================
  // TENTS — the paper-lantern image. ART §6.3: wrap + interior card + seams, never transmission.
  // =============================================================================================
  _buildTents(kit, cx, cz) {
    const r = new Rand(0x7E17);
    const n = 5;
    for (let i = 0; i < n; i++) {
      const a = -0.85 + i * 0.42;
      const rad = 13.5 + r.range(-1.6, 1.6);
      const x = cx + Math.sin(a) * rad + r.range(-0.8, 0.8);
      const z = cz + Math.cos(a) * rad * 0.72 + r.range(-0.8, 0.8);
      this._buildTent(kit, x, z, -a + r.range(-0.12, 0.12), i, i !== 2);
    }
  }

  _buildTent(kit, x, z, ry, seed, lit) {
    const r = new Rand(0x7A17 + seed * 613);
    const W = 3.5 + r.range(-0.25, 0.3);
    const D = 4.4 + r.range(-0.3, 0.35);
    const wallH = 1.32 + r.range(-0.08, 0.1);
    const ridgeH = 2.42 + r.range(-0.1, 0.14);
    const deck = 0.38;
    const y = this._lowest(x, z, W * 0.75, D * 0.75, ry);
    kit.setBase(TRS(x, y, z, ry));
    const hw = W / 2, hd = D / 2;
    const cR = Math.cos(ry), sR = Math.sin(ry);
    const toW = (lx, ly2, lz) => ({ x: x + lx * cR + lz * sR, y: y + ly2, z: z - lx * sR + lz * cR });

    // wooden platform
    for (let i = 0; i < 6; i++) {
      kit.box(M.wood, 0.22, deck + 0.4, 0.22, (i % 2 ? 1 : -1) * (hw + 0.25),
        deck * 0.5 - 0.18, -hd + ((i / 2) | 0) * (D * 0.5) - 0.2, 0);
    }
    for (let b = 0; b < 7; b++) {
      kit.box(M.wood, (W + 0.7) / 7 * 0.96, 0.09, D + 0.6,
        -(W + 0.7) * 0.5 + (W + 0.7) / 7 * (b + 0.5), deck, 0, 0,
        { exposure: 0.85, uvOffset: b * 0.55 });
    }

    // canvas: two side walls, two roof slopes, two gables. A sagging ridge sells the age.
    // A LIT tent's canvas is the emissive 'canvas-lit' variant — the fabric itself carries the
    // lamp, so the tent reads as a paper lantern made of cloth instead of a floating orange
    // card. An unlit tent gets the ordinary shared canvas and stays a silhouette.
    //
    // TWO CORRECTIONS LIVE HERE.
    //
    // 1. The slope panels used to carry `rz: s * slopeAng`, which tilts the OUTER edge UP: every
    //    tent in the camp was a V-shaped valley whose canvas cut straight through its own ridge
    //    pole and gable wedge. Verified numerically before changing it — a plate centred at
    //    +hw/2 with rz = +ang puts its +x end at y+L/2*sin(ang), i.e. above the ridge. The sign
    //    is now negated and the ridge is the high edge, which is what a ridge is.
    // 2. Rigid boxes gave every tent a dead-straight ridge and a dead-straight eave. Canvas
    //    strung between a pole and six guy lines does neither. The panels are now subdivided
    //    cloth that droops between its supports and carries a fine crease field, so the
    //    silhouette against the sky is a curve.
    const CANVAS = lit ? 'canvas-lit' : M.canvas;
    const sag = 0.055;
    const slopeLen = Math.hypot(hw, ridgeH - wallH);
    const slopeAng = Math.atan2(ridgeH - wallH, hw);
    const roofCloth = clothPanel(10, 16, -0.085, 0.020, seed * 3.7 + 1);
    const wallCloth = clothPanel(7, 16, 0.052, 0.016, seed * 5.3 + 2);
    for (const s of [-1, 1]) {
      kit.add(CANVAS, wallCloth,
        TRS(s * hw, deck + 0.05 + wallH * 0.5, 0, 0, wallH, 1, D, 0, -s * Math.PI / 2),
        { exposure: 1, uvOffset: seed * 0.7 });
      kit.add(CANVAS, roofCloth,
        TRS(s * hw * 0.5, deck + 0.05 + (wallH + ridgeH) * 0.5 - sag * 0.5, 0,
          0, slopeLen + 0.06, 1, D, 0, -s * slopeAng),
        { exposure: 1, uvOffset: seed * 0.3 });
      // the seam batten that covers the join, sagging with the panel it is sewn to
      kit.add(M.rope, Kit.UNIT_CYL,
        TRS(s * (hw + 0.02), deck + 0.05 + wallH - 0.01, 0, 0, 0.022, D + 0.05, 0.022, Math.PI / 2));
    }
    roofCloth.dispose();
    wallCloth.dispose();
    // Gable ends. These used to be a row of boxes of increasing height standing in for a
    // triangle; on a LIT tent that row is the silhouette of the brightest object in the frame
    // and it read unmistakably as a bar chart. A real wedge, plus a wall band under it, and on
    // one tent the door flap is tied open — a gap in the wall band, not a missing stair.
    const gabH = ridgeH - wallH;
    const wallY = deck + 0.05 + wallH * 0.5;
    for (const s of [-1, 1]) {
      const doorOpen = s < 0 && seed % 2 === 0;
      if (doorOpen) {
        const sw = Math.max(0.25, (W - 0.95) * 0.5);
        for (const q of [-1, 1]) {
          kit.box(CANVAS, sw, wallH, 0.03, q * (W - sw) * 0.5, wallY, s * hd, 0, { exposure: 1 });
        }
      } else {
        kit.box(CANVAS, W, wallH, 0.03, 0, wallY, s * hd, 0, { exposure: 1 });
      }
      kit.add(CANVAS, Kit.UNIT_WEDGE,
        TRS(0, deck + 0.05 + wallH + gabH * 0.5, s * hd, 0, W, gabH, 0.03), { exposure: 1 });
    }
    // ridge pole, uprights, guy ropes and stakes
    kit.add(M.wood, Kit.UNIT_CYL, TRS(0, deck + 0.05 + ridgeH - sag, 0, 0, 0.07, D + 0.5, 0.07, Math.PI / 2));
    for (const s of [-1, 1]) kit.add(M.wood, Kit.UNIT_CYL, TRS(0, deck + 0.05 + ridgeH * 0.5, s * hd, 0, 0.06, ridgeH, 0.06));
    for (let i = 0; i < 6; i++) {
      const s = i < 3 ? -1 : 1;
      const tz = -hd + 0.6 + (i % 3) * (D * 0.42);
      const gx = s * (hw + 1.05);
      kit.add(M.rope, Kit.UNIT_CYL,
        TRS(s * (hw + 0.52), deck + 0.05 + wallH * 0.72, tz, 0, 0.014, 1.5, 0.014, 0, s * 0.72));
      kit.box(M.wood, 0.05, 0.42, 0.05, gx, -y + this._h(x, z) + 0.12, tz, 0, { rz: s * 0.28 });
    }

    // ---- WHAT IS INSIDE. A folding cot, a duffel, a footlocker with the lamp standing on it.
    // On an unlit tent with the flap tied open these are just dark shapes in a dark hole. On a
    // LIT tent they are the whole picture: they are fed to the glow shell as occluders and their
    // shadows are baked into the canvas, so the fabric carries a cot-shaped black bar and a
    // hunched duffel. A glowing tent with nothing in it is a lampshade.
    const cotY = deck + 0.05;
    const OCC = [
      { cx: -hw * 0.52, cy: cotY + 0.26, cz: 0.15, hx: 0.30, hy: 0.20, hz: hd * 0.62 },   // cot
      { cx: hw * 0.46, cy: cotY + 0.17, cz: -hd * 0.55, hx: 0.24, hy: 0.17, hz: 0.44 },   // duffel
      { cx: hw * 0.40, cy: cotY + 0.20, cz: hd * 0.42, hx: 0.26, hy: 0.20, hz: 0.30 },    // locker
    ];
    kit.box(M.wood, 0.62, 0.06, hd * 1.24, OCC[0].cx, cotY + 0.42, OCC[0].cz, 0.02, { exposure: 0.3 });
    for (const q of [-1, 1]) {
      for (const p2 of [-1, 1]) {
        kit.add(M.steel, Kit.UNIT_CYL,
          TRS(OCC[0].cx + q * 0.26, cotY + 0.20, OCC[0].cz + p2 * hd * 0.54, 0, 0.03, 0.42, 0.03),
          { exposure: 0.2 });
      }
    }
    kit.add('cloth', Kit.UNIT_BOX,
      TRS(OCC[0].cx, cotY + 0.50, OCC[0].cz + 0.25, 0.04, 0.60, 0.10, hd * 0.9), { exposure: 0.25 });
    kit.add('cloth', Kit.UNIT_SPHERE,
      TRS(OCC[1].cx, OCC[1].cy, OCC[1].cz, 0.5, 0.46, 0.34, 0.88), { exposure: 0.25 });
    kit.box(M.lumber, 0.50, 0.40, 0.58, OCC[2].cx, cotY + 0.20, OCC[2].cz, 0.12, { exposure: 0.25 });
    kit.box(M.rust, 0.52, 0.04, 0.06, OCC[2].cx, cotY + 0.30, OCC[2].cz - 0.30, 0.12, { exposure: 0.2 });

    if (lit) {
      // The lamp stands on the footlocker, off-centre and low, so the cot throws a long shadow
      // across the far wall instead of a symmetric halo.
      const ly = cotY + 0.52;
      const lampL = { x: OCC[2].cx, y: ly, z: OCC[2].cz };
      kit.add('glow-canvas', Kit.UNIT_SPHERE, TRS(lampL.x, ly, lampL.z, 0, 0.15, 0.21, 0.15), { glow: 2.2 });
      kit.add(M.rust, Kit.UNIT_CYL, TRS(lampL.x, ly - 0.16, lampL.z, 0, 0.13, 0.10, 0.13), { exposure: 0.3 });

      // A 4-tap area source. One shadow ray gives a hard stencil of a cot; four taps 6 cm apart
      // give it a penumbra, which is what a 12 cm kerosene flame actually casts at 1.5 m.
      const TAPS = [[0, 0, 0], [0.06, 0.01, 0.02], [-0.05, 0.02, -0.03], [0.01, -0.04, 0.06]];
      const falloff = (px, py, pz) => {
        // Kit hands glowFn WORLD positions; fold them back into tent-local so the lamp maths is
        // readable and the tent's yaw cannot silently offset the hot spot.
        const dx = px - x, dz = pz - z;
        const lx = dx * cR - dz * sR, lyy = py - y, lz = dx * sR + dz * cR;
        const ddx = lx - lampL.x, ddy = lyy - lampL.y, ddz = lz - lampL.z;
        const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
        // Sharp enough that the far end of a 4.4 m tent is genuinely dimmer than the panel the
        // lamp is leaning against. A flat shell over a 4 m object is a lit box, not a lamp.
        let g = Math.min(1.0, 0.88 / (0.20 + d2 * 2.45));
        let open = 0;
        for (const t of TAPS) {
          let hit = false;
          for (const b of OCC) {
            if (segHitsBox(lampL.x + t[0], lampL.y + t[1], lampL.z + t[2], lx, lyy, lz, b)) { hit = true; break; }
          }
          if (!hit) open++;
        }
        // Never fully black: canvas bounces, and a hole in a glowing wall reads as a tear.
        return g * (0.11 + 0.89 * (open / TAPS.length));
      };

      // The shell sits just OUTSIDE the canvas, never inside it. Inside, it fails the depth test
      // against its own tent and only shows through a polygonOffset hack — which produced a
      // dashed z-fighting stipple along every panel edge that read as neon piping. Outside, it
      // composites cleanly. It is also kept fractionally SMALLER than the canvas on every axis so
      // its silhouette can never exceed the tent's.
      //
      // It is now SUBDIVIDED. A 24-vertex box interpolates the lamp falloff across a 4.4 m panel
      // from its corners, which is a flat wash; at 16 x 18 the gradient is real and the baked cot
      // shadow has somewhere to live.
      const OUT = 0.045;
      // Built from the SAME crease field as the canvas it covers (identical seed), at a finer
      // subdivision, so the shell hugs the fabric instead of hovering flat over a sagging panel.
      const shellWall = clothPanel(10, 18, 0.052, 0.016, seed * 5.3 + 2);
      const shellRoof = clothPanel(12, 18, -0.085, 0.020, seed * 3.7 + 1);
      const shellGable = new THREE.PlaneGeometry(1, 1, 12, 8);
      for (const s of [-1, 1]) {
        kit.add('glow-canvas', shellWall,
          TRS(s * (hw + OUT), deck + 0.05 + wallH * 0.5, 0, 0, wallH * 0.99, 1, D * 0.99, 0, -s * Math.PI / 2),
          { glowFn: falloff });
        kit.add('glow-canvas', shellRoof,
          TRS(s * hw * 0.5, deck + 0.05 + (wallH + ridgeH) * 0.5 - sag * 0.5 + 0.055, 0,
            0, slopeLen * 0.99, 1, D * 0.99, 0, -s * slopeAng),
          { glowFn: falloff });
        // The gable glow used to be ONE card, W x wallH*1.5, centred at 0.55*wallH: it hung
        // below the tent platform and stopped short of the ridge, so the tent's brightest
        // element had a silhouette that was not the tent's. Now it IS the gable.
        kit.add('glow-canvas', shellGable,
          TRS(0, wallY, s * (hd + OUT), 0, W * 0.99, wallH * 0.99, 1), { glowFn: falloff });
        kit.add('glow-canvas', Kit.UNIT_WEDGE,
          TRS(0, deck + 0.05 + wallH + gabH * 0.5, s * (hd + OUT), 0, W * 0.99, gabH * 0.99, 0.01),
          { glowFn: falloff });
      }
      shellWall.dispose();
      shellRoof.dispose();
      shellGable.dispose();
      const wp = toW(lampL.x, ly, lampL.z);
      this._proxy(wp.x, wp.y, wp.z, PAL.lantern, 3.6, 10, true);
      // Warm spill on the platform boards immediately outside the tied-open flap.
      const spill = new THREE.PlaneGeometry(1, 1, 8, 8);
      kit.add('glow-canvas', spill, TRS(0, deck + 0.10, -hd - 1.05, 0, W * 1.15, 1, 2.3, -Math.PI / 2), {
        glowFn: (px, py, pz) => {
          const dx = px - x, dz = pz - z;
          const lx = dx * cR - dz * sR, lz = dx * sR + dz * cR;
          const t = 1 - Math.hypot(lx / 1.5, (lz + hd + 0.55) / 1.25);
          return t > 0 ? 1.15 * t * t : 0;
        },
      });
      spill.dispose();
    }

    // ---- OUTSIDE. Boots off at the flap, a towel over a guy line, a washbasin on the step.
    for (const q of [-1, 1]) {
      kit.box(M.tarp, 0.11, 0.16, 0.27, q * 0.16 - 0.30, deck + 0.14, -hd - 0.38,
        r.range(-0.25, 0.25) + q * 0.12, { exposure: 0.8 });
    }
    kit.add('cloth', Kit.UNIT_BOX,
      TRS(hw + 0.62, deck + 0.05 + wallH * 0.58, -hd + 1.1, 0.08, 0.42, 0.66, 0.02), { exposure: 1 });
    kit.add(M.steel, new THREE.CylinderGeometry(0.17, 0.13, 0.10, 12, 1),
      TRS(-hw - 0.28, this._h(x, z) - y + 0.06, hd - 0.5, 0.5, 1, 1, 1, 0.06), { exposure: 0.8 });

    kit.clearBase();
    this._decal(x, z, Math.max(W, D) * 0.75, 0.68);
    this._inter(`tent:${seed}`, 'building', x, y + deck, z);
  }

  // =============================================================================================
  // FIREPIT
  // =============================================================================================
  _buildFirepit(kit, x, z) {
    const r = new Rand(0xF12E);
    const y = this._h(x, z);
    this.firePosition.set(x, y, z);
    kit.clearBase();

    // ash bowl, dug slightly in
    kit.add(M.stone, Kit.UNIT_CYL_HI, TRS(x, y - 0.06, z, 0, 2.5, 0.14, 2.5), { exposure: 0.9 });
    // stone ring — fourteen stones, no two the same
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + r.range(-0.09, 0.09);
      const rad = 1.36 + r.range(-0.12, 0.12);
      const s = r.range(0.32, 0.58);
      kit.add(M.stone, Kit.UNIT_ICO,
        TRS(x + Math.cos(a) * rad, y + s * 0.28, z + Math.sin(a) * rad, r.next() * 6.28,
          s * r.range(0.9, 1.4), s * r.range(0.7, 1.1), s * r.range(0.9, 1.3), r.range(-0.2, 0.2)),
        { exposure: 1 });
    }
    // half-burnt logs in the coals
    for (let i = 0; i < 5; i++) {
      const a = r.next() * 6.28, rad = r.range(0.1, 0.55);
      kit.add(M.bark, Kit.UNIT_CYL,
        TRS(x + Math.cos(a) * rad, y + 0.14, z + Math.sin(a) * rad, r.next() * 6.28,
          r.range(0.10, 0.17), r.range(0.7, 1.35), r.range(0.10, 0.17), 0, Math.PI / 2 + r.range(-0.14, 0.14)),
        { exposure: 1 });
    }
    // a cooking grate on two stones, a blackened pot standing on it, a poker in the ashes
    kit.box(M.steel, 0.92, 0.02, 0.62, x, y + 0.52, z, 0.3);
    for (let i = 0; i < 7; i++) kit.box(M.steel, 0.9, 0.025, 0.02, x, y + 0.54, z - 0.28 + i * 0.095, 0.3);
    kit.add(M.rust, new THREE.CylinderGeometry(0.16, 0.13, 0.22, 14, 1),
      TRS(x + 0.24, y + 0.66, z - 0.10, 0.4, 1, 1, 1), { exposure: 1 });
    kit.add(M.rust, Kit.UNIT_CYL, TRS(x + 0.24, y + 0.78, z - 0.10, 0, 0.34, 0.02, 0.34));
    kit.add(M.rust, Kit.UNIT_CYL,
      TRS(x + 0.55, y + 0.90, z - 0.10, 0.4, 0.028, 0.30, 0.028, 0, Math.PI / 2 + 0.3));
    kit.add(M.rust, Kit.UNIT_CYL,
      TRS(x - 1.1, y + 0.42, z + 1.0, 1.9, 0.020, 1.35, 0.020, 0.55, 0.30), { exposure: 1 });

    // ---- THE GROUND POOL. The fire's own light landing on wet dirt, terrain-following, radial,
    // and flickering on the same 3-octave noise as the flame above it. Without this the pit is a
    // bright object sitting in a dark field; with it the fire is the reason the clearing is lit.
    const poolR = 6.8;
    const pg = new THREE.PlaneGeometry(poolR * 2, poolR * 2, 26, 26);
    pg.rotateX(-Math.PI / 2);
    const pp = pg.attributes.position;
    for (let i = 0; i < pp.count; i++) {
      const px = x + pp.getX(i), pz = z + pp.getZ(i);
      pp.setXYZ(i, px, this._h(px, pz) + 0.045, pz);
    }
    pp.needsUpdate = true;
    pg.computeVertexNormals();
    kit.add('glow-fire', pg, TRS(0, 0, 0), {
      glowFn: (px, py, pz) => {
        const dr = Math.hypot(px - x, pz - z) / poolR;
        if (dr >= 1) return 0;
        const t = 1 - dr;
        // squared falloff to zero well inside the quad, plus a hard bright ring of scorched
        // ground right at the stones
        return 0.085 * t * t * t + 0.15 * Math.max(0, 1 - dr * 5.4) ** 2;
      },
    });
    pg.dispose();

    // ---- THE WOODPILE beside the ring, and a splitting round with the axe left in it.
    for (let row = 0; row < 3; row++) {
      const n = 5 - row;
      for (let i = 0; i < n; i++) {
        const lx = x - 3.9 + i * 0.32, lz = z - 3.4;
        kit.add(M.bark, Kit.UNIT_CYL,
          TRS(lx, this._h(lx, lz) + 0.17 + row * 0.30, lz + r.range(-0.04, 0.04), 0,
            r.range(0.26, 0.32), r.range(0.55, 0.78), r.range(0.26, 0.32), 0,
            Math.PI / 2 + r.range(-0.06, 0.06)), { exposure: 0.8 });
      }
    }
    this._decal(x - 3.2, z - 3.4, 1.6, 0.7);
    const rx2 = x + 3.6, rz2 = z - 2.9;
    const ry2 = this._h(rx2, rz2);
    kit.add(M.bark, Kit.UNIT_CYL_HI, TRS(rx2, ry2 + 0.24, rz2, 0.3, 0.62, 0.48, 0.62), { exposure: 1 });
    kit.add(M.wood, Kit.UNIT_CYL, TRS(rx2 + 0.06, ry2 + 0.86, rz2 + 0.10, 0.9, 0.035, 0.80, 0.035, 0.18, 0.12));
    kit.box(M.rust, 0.05, 0.17, 0.22, rx2 + 0.02, ry2 + 0.50, rz2 + 0.03, 0.9, { rz: 0.12, exposure: 1 });
    this._decal(rx2, rz2, 0.9, 0.72);

    // split-log benches, one rolled off its feet
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.35;
      const rad = 3.3 + r.range(-0.25, 0.35);
      const bx = x + Math.cos(a) * rad, bz = z + Math.sin(a) * rad;
      const by = this._h(bx, bz);
      const rolled = i === 3;
      kit.add(M.bark, Kit.UNIT_CYL,
        TRS(bx, by + (rolled ? 0.24 : 0.46), bz, -a + Math.PI / 2 + r.range(-0.07, 0.07),
          0.46, r.range(2.1, 3.0), 0.46, rolled ? 0.34 : 0, Math.PI / 2), { exposure: 1 });
      if (!rolled) {
        for (const s of [-1, 1]) {
          kit.add(M.bark, Kit.UNIT_CYL,
            TRS(bx + Math.cos(-a + Math.PI / 2) * s * 0.85, by + 0.22, bz - Math.sin(-a + Math.PI / 2) * s * 0.85,
              0, 0.24, 0.46, 0.24));
        }
      }
      this._decal(bx, bz, 1.5, 0.62);
    }
    this._decal(x, z, 2.4, 0.55);
    this._inter('firepit', 'landmark', x, y, z);
  }

  // =============================================================================================
  // DOCK, CANOES, LAKE EDGE
  // =============================================================================================
  _buildDock(kit) {
    const r = new Rand(0xD0C4);
    const d = this.dockPoint;
    const x = d.x, z = d.z;
    const y = this._h(x, z);
    const wl = this.waterLevel;
    const deckY = Math.max(y, wl) + 0.62;
    const len = 13.5, wid = 2.1;
    kit.clearBase();

    // planks running out over the water (the lake is at -z from the shore)
    for (let i = 0; i < 22; i++) {
      const pz = z - 0.6 - i * (len / 22);
      kit.box(M.wood, wid, 0.07, (len / 22) * 0.9, x, deckY + r.range(-0.008, 0.008), pz,
        r.range(-0.012, 0.012), { exposure: 1, uvOffset: i * 0.37 });
    }
    for (const s of [-1, 1]) {
      kit.box(M.wood, 0.13, 0.16, len, x + s * (wid * 0.5 - 0.08), deckY - 0.12, z - 0.6 - len * 0.5, 0, { exposure: 0.5 });
    }
    // pilings, some leaning, sunk below the waterline
    const pileM = [];
    for (let i = 0; i < 12; i++) {
      const s = i % 2 ? 1 : -1;
      const pz = z - 0.8 - ((i / 2) | 0) * (len / 6);
      const px = x + s * (wid * 0.5 + 0.02);
      const ph = deckY - (this._h(px, pz) - 1.4);
      _e.set(r.range(-0.05, 0.05), r.next() * 3, r.range(-0.05, 0.05), 'YXZ');
      _q.setFromEuler(_e);
      pileM.push(new THREE.Matrix4().compose(
        _v3b.set(px, deckY - ph * 0.5 + 0.24, pz), _q, _v3c.set(0.22, ph, 0.22)));
      if (((i / 2) | 0) % 2 === 0) {
        pileM.push(new THREE.Matrix4().compose(
          _v3b.set(px, deckY + 0.42, pz), _q, _v3c.set(0.20, 0.9, 0.20)));
      }
    }
    if (pileM.length) this._instance(M.wood, this._auxGeo(Kit.UNIT_CYL, 1), pileM);

    // overturned canoes on the bank
    for (let i = 0; i < 3; i++) {
      const a = 0.4 + i * 0.35;
      const cx = x + 5.0 + i * 1.35 + r.range(-0.3, 0.3);
      const cz = z + 2.4 + i * 0.8 + r.range(-0.4, 0.4);
      this._buildCanoe(kit, cx, cz, a + r.range(-0.15, 0.15), true, i);
    }
    // the canoe rack, two more canoes on it
    const rx = x + 8.2, rz = z + 8.4;
    const ry0 = this._h(rx, rz);
    for (const s of [-1, 1]) {
      kit.box(M.wood, 0.14, 1.55, 0.14, rx + s * 2.3, ry0 + 0.78, rz - 0.5, 0, { rz: s * 0.16 });
      kit.box(M.wood, 0.14, 1.55, 0.14, rx + s * 2.3, ry0 + 0.78, rz + 0.5, 0, { rz: s * 0.16 });
      kit.box(M.wood, 0.12, 0.12, 1.5, rx + s * 2.05, ry0 + 1.42, rz, 0);
    }
    this._buildCanoe(kit, rx, rz, Math.PI / 2, false, 3, ry0 + 1.62);
    this._buildCanoe(kit, rx, rz + 0.02, Math.PI / 2, false, 4, ry0 + 0.92);
    this._decal(rx, rz, 3.2, 0.6);

    // dock box, a coil of rope, a bucket, and the life-jacket rail
    const bx = x + 1.4, bz = z + 0.9;
    const by = this._h(bx, bz);
    kit.box(M.wood, 1.5, 0.66, 0.8, bx, by + 0.33, bz, 0.2, { exposure: 0.9 });
    kit.box(M.wood, 1.56, 0.09, 0.86, bx, by + 0.70, bz, 0.2, { exposure: 1 });
    kit.box(M.rust, 0.10, 0.09, 0.03, bx + 0.6, by + 0.62, bz - 0.36, 0.2);
    this._decal(bx, bz, 1.2, 0.75);
    this._inter('dock-box', 'container', bx, by + 0.7, bz);

    kit.add(M.rope, new THREE.TorusGeometry(0.3, 0.055, 6, 14), TRS(bx - 1.9, by + 0.06, bz + 0.6, 0.7, 1, 1, 1, Math.PI / 2));
    kit.add(M.steel, Kit.UNIT_CYL, TRS(bx - 2.6, by + 0.16, bz - 0.2, 0, 0.28, 0.32, 0.28));

    for (let i = 0; i < 5; i++) {
      const jx = x + 2.6 + i * 0.42, jz = z + 3.6;
      kit.box(M.wood, 0.09, 1.25, 0.09, x + 2.4, this._h(x + 2.4, jz) + 0.62, jz, 0);
      kit.box(M.wood, 0.09, 1.25, 0.09, x + 4.6, this._h(x + 4.6, jz) + 0.62, jz, 0);
      kit.box(M.wood, 2.3, 0.08, 0.08, x + 3.5, this._h(x + 3.5, jz) + 1.2, jz, 0);
      kit.add('cloth-warm', Kit.UNIT_BOX, TRS(jx, this._h(jx, jz) + 0.86, jz + 0.02, 0, 0.34, 0.56, 0.08));
    }
    this._decal(x + 3.5, z + 3.6, 1.6, 0.5);

    // a lantern hook post at the head of the dock — the warm reflection in keyart-lake
    kit.box(M.wood, 0.12, 2.1, 0.12, x - 1.1, deckY + 1.0, z - 1.4, 0);
    kit.box(M.steel, 0.3, 0.05, 0.05, x - 0.98, deckY + 1.95, z - 1.4, 0);
    kit.add('glow-window', Kit.UNIT_SPHERE, TRS(x - 0.85, deckY + 1.80, z - 1.4, 0, 0.14, 0.19, 0.14), { glow: 1.5 });
    this._proxy(x - 0.85, deckY + 1.80, z - 1.4, PAL.lantern, 2.8, 11, true);

    this._decal(x, z + 0.4, 2.6, 0.5);
    this._inter('dock', 'landmark', x, deckY, z - 4);
    this.shorePoint = new THREE.Vector3(x, y, z);
  }

  _buildCanoe(kit, x, z, ry, overturned, seed, forcedY) {
    const r = new Rand(0xCA20E + seed * 331);
    const y = forcedY !== undefined ? forcedY : this._h(x, z) + 0.30;
    const g = Kit.UNIT_SPHERE.clone();
    g.scale(5.05, 0.62, 1.02);
    taperHull(g, 2.52, 2.1, 0.10);
    kit.add(M.wood, g, TRS(x, y, z, ry, 1, overturned ? -1 : 1, 1, 0, r.range(-0.05, 0.05)), { exposure: 0.95 });
    g.dispose();
    // keel strip + gunwale
    kit.box(M.wood, 4.6, 0.05, 0.09, x, y + (overturned ? 0.32 : -0.28), z, ry, { exposure: 1 });
    if (!overturned) {
      for (let i = 0; i < 2; i++) {
        kit.box(M.wood, 0.72, 0.05, 0.24, x + Math.cos(ry) * (i ? 1.2 : -1.2), y + 0.02, z - Math.sin(ry) * (i ? 1.2 : -1.2), ry);
      }
    }
    if (forcedY === undefined) this._decal(x, z, 2.4, 0.66);
    this._inter(`canoe:${seed}`, 'prop', x, y, z);
  }

  // =============================================================================================
  // ARCHERY (THE ORCHARD), FLAGPOLE, VOLLEYBALL, LAUNDRY
  // =============================================================================================
  _buildArchery(kit, x, z) {
    const r = new Rand(0xA2CE);
    kit.clearBase();
    for (let i = 0; i < 4; i++) {
      const bx = x + (i - 1.5) * 3.4 + r.range(-0.2, 0.2);
      const bz = z + r.range(-0.4, 0.4);
      const by = this._h(bx, bz);
      const lean = r.range(-0.10, 0.10);
      kit.add(M.rope, Kit.UNIT_CYL_HI, TRS(bx, by + 0.95, bz, r.range(0, 0.4), 1.35, 0.34, 1.35, Math.PI / 2 + lean));
      for (let k = 0; k < 3; k++) {
        const a = k * 2.094 + 0.4;
        kit.box(M.wood, 0.08, 1.5, 0.08, bx + Math.cos(a) * 0.5, by + 0.55, bz + Math.sin(a) * 0.5, 0,
          { rx: Math.sin(a) * 0.24, rz: -Math.cos(a) * 0.24 });
      }
      this._decal(bx, bz, 1.1, 0.66);
    }
    // shooting-line rail
    for (const s of [-1, 1]) kit.box(M.wood, 0.11, 1.05, 0.11, x + s * 6.2, this._h(x + s * 6.2, z + 9) + 0.5, z + 9, 0);
    kit.box(M.wood, 12.6, 0.08, 0.08, x, this._h(x, z + 9) + 0.98, z + 9, 0, { rz: 0.01 });
    // the orchard the range was cleared into — apple trees gone wild, still in their rows
    this._buildOrchard(x - 3, z + 16, 3, 4, 5.6, 0.24, 0xA22E);
    this._inter('archery', 'landmark', x, this._h(x, z), z);
  }

  _buildOrchard(x, z, rows, cols, spacing, rot, seed) {
    const r = new Rand(seed);
    const trunkM = [];
    const canopyM = [];
    const c = Math.cos(rot), s = Math.sin(rot);
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        if (r.chance(0.16)) continue;                 // gone wild: some are dead and gone
        const lx = (j - (cols - 1) / 2) * spacing + r.range(-0.8, 0.8);
        const lz = (i - (rows - 1) / 2) * spacing + r.range(-0.8, 0.8);
        const px = x + lx * c - lz * s;
        const pz = z + lx * s + lz * c;
        const py = this._h(px, pz);
        const h = r.range(3.2, 5.4);
        const rad = r.range(0.13, 0.24);
        _e.set(r.range(-0.10, 0.10), r.next() * 6.28, r.range(-0.10, 0.10), 'YXZ');
        _q.setFromEuler(_e);
        trunkM.push(new THREE.Matrix4().compose(_v3b.set(px, py + h * 0.42, pz), _q, _v3c.set(rad * 2, h, rad * 2)));
        for (let k = 0; k < 3; k++) {
          _e.set(0, k * 1.05 + r.range(-0.3, 0.3), 0, 'YXZ');
          _q.setFromEuler(_e);
          const cs = r.range(2.4, 3.6);
          canopyM.push(new THREE.Matrix4().compose(
            _v3b.set(px + r.range(-0.3, 0.3), py + h * 0.82 + r.range(-0.3, 0.3), pz + r.range(-0.3, 0.3)),
            _q, _v3c.set(cs, cs * 0.72, cs)));
        }
        this._decal(px, pz, rad * 5, 0.6);
      }
    }
    if (trunkM.length) this._instance(M.bark, this._auxGeo(Kit.UNIT_CYL, 1), trunkM);
    if (canopyM.length) {
      const card = new THREE.PlaneGeometry(1, 1, 1, 1);
      const n = card.attributes.position.count;
      const ex = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) { ex[i * 2] = 1; ex[i * 2 + 1] = 1; }
      card.setAttribute('aExposure', new THREE.BufferAttribute(ex, 2));
      trimGeo(card, false);
      this._instance(M.leaf, card, canopyM, { cast: this._tierIndex >= 2 });
    }
  }

  _buildFlagpole(kit, x, z) {
    const y = this._h(x, z);
    kit.clearBase();
    kit.add(M.concrete, Kit.UNIT_CYL_HI, TRS(x, y + 0.10, z, 0, 1.1, 0.22, 1.1));
    kit.add(M.steel, Kit.UNIT_CYL_HI, TRS(x, y + 3.6, z, 0, 0.13, 7.2, 0.13, 0, 0.004));
    kit.add(M.steel, Kit.UNIT_SPHERE, TRS(x, y + 7.25, z, 0, 0.14, 0.14, 0.14));
    kit.add(M.rope, Kit.UNIT_CYL, TRS(x + 0.09, y + 3.6, z, 0, 0.010, 7.0, 0.010, 0, 0.01));
    kit.box(M.steel, 0.06, 0.22, 0.05, x + 0.12, y + 1.25, z, 0);
    kit.add('cloth-warm', Kit.UNIT_BOX, TRS(x + 0.42, y + 6.5, z, 0.25, 0.86, 0.56, 0.02));
    this._decal(x, z, 1.1, 0.7);
  }

  _buildVolleyball(kit, x, z) {
    const y0 = this._h(x, z);
    kit.clearBase();
    for (const s of [-1, 1]) {
      const px = x + s * 4.6;
      kit.add(M.steel, Kit.UNIT_CYL, TRS(px, this._h(px, z) + 1.15, z, 0, 0.09, 2.3, 0.09, 0, s * 0.02));
      this._decal(px, z, 0.7, 0.7);
    }
    const netY = y0 + 1.85;
    for (let i = 0; i < 15; i++) {
      kit.box(M.rope, 0.012, 0.95, 0.012, x - 4.4 + i * 0.63, netY - 0.48, z, 0);
    }
    for (let i = 0; i < 5; i++) kit.box(M.rope, 8.8, 0.012, 0.012, x, netY - i * 0.235, z, 0);
    // The net tape is grubby canvas, not a warm garment: 8.9 m of `garment.warm` strung across
    // the clearing was the second-brightest horizontal in the frame and read as a lit strip.
    kit.box('cloth', 8.9, 0.09, 0.02, x, netY + 0.03, z, 0);
    kit.box('cloth', 8.9, 0.07, 0.02, x, netY - 0.98, z, 0);
    // a ball in the dirt, and the worn sand rectangle
    kit.add(M.tarp, Kit.UNIT_SPHERE, TRS(x + 2.4, this._h(x + 2.4, z + 3) + 0.11, z + 3, 0, 0.22, 0.22, 0.22));
    this._decal(x + 2.4, z + 3, 0.4, 0.7);
  }

  _buildClotheslines(kit, x, z) {
    const r = new Rand(0xC107);
    kit.clearBase();
    for (let line = 0; line < 2; line++) {
      const lz = z + line * 2.4;
      const x0 = x - 4.5, x1 = x + 4.5;
      for (const px of [x0, x1]) {
        const py = this._h(px, lz);
        kit.box(M.wood, 0.11, 2.15, 0.11, px, py + 1.05, lz, 0, { rz: (px < x ? 0.03 : -0.02) });
        kit.box(M.wood, 0.62, 0.09, 0.09, px, py + 2.02, lz, 0);
        this._decal(px, lz, 0.65, 0.7);
      }
      // catenary: ten segments, actually sagging
      const segs = 10;
      const topY = this._h(x0, lz) + 2.02;
      for (let i = 0; i < segs; i++) {
        const t0 = i / segs, t1 = (i + 1) / segs;
        const sag = (t) => topY - 0.30 * Math.sin(Math.PI * t) - 0.05 * line;
        const px0 = x0 + (x1 - x0) * t0, px1 = x0 + (x1 - x0) * t1;
        const py0 = sag(t0), py1 = sag(t1);
        const mx = (px0 + px1) * 0.5, my = (py0 + py1) * 0.5;
        const L = Math.hypot(px1 - px0, py1 - py0);
        kit.add(M.rope, Kit.UNIT_CYL, TRS(mx, my, lz, 0, 0.012, L, 0.012, 0, Math.PI / 2 + Math.atan2(py1 - py0, px1 - px0)));
      }
      const towels = 3 + line;
      for (let i = 0; i < towels; i++) {
        const t = (i + 0.7) / (towels + 0.4);
        const px = x0 + (x1 - x0) * t;
        const py = topY - 0.30 * Math.sin(Math.PI * t);
        const warm = (i + line) % 3 === 0;
        kit.add(warm ? 'cloth-warm' : 'cloth', Kit.UNIT_BOX,
          TRS(px, py - 0.52, lz, r.range(-0.06, 0.06), 0.52, 1.02, 0.02), { exposure: 1 });
      }
    }
    this._inter('laundry-line', 'landmark', x, this._h(x, z), z);
  }

  // =============================================================================================
  // SMALL PROPS
  // =============================================================================================
  _buildPicnicTable(kit, x, z, ry, withRadio) {
    const y = this._lowest(x, z, 1.0, 0.9, ry);
    kit.setBase(TRS(x, y, z, ry));
    for (let i = 0; i < 5; i++) {
      kit.box(M.wood, 0.30, 0.05, 1.85, -0.62 + i * 0.31, 0.74, 0, 0, { exposure: 1, uvOffset: i * 0.4 });
    }
    for (const s of [-1, 1]) {
      for (let i = 0; i < 2; i++) kit.box(M.wood, 0.28, 0.05, 1.85, s * 1.16, 0.44, 0, 0, { exposure: 0.9 });
      kit.box(M.wood, 0.08, 0.80, 0.10, s * 0.55, 0.38, -0.78, 0, { rz: s * 0.34 });
      kit.box(M.wood, 0.08, 0.80, 0.10, s * 0.55, 0.38, 0.78, 0, { rz: s * 0.34 });
      kit.box(M.wood, 0.08, 0.10, 1.10, s * 1.16, 0.42, -0.78, 0, { rz: 0 });
    }
    kit.box(M.wood, 2.6, 0.07, 0.08, 0, 0.20, 0, 0);
    if (withRadio) {
      kit.box(M.tarp, 0.34, 0.20, 0.16, 0.35, 0.87, 0.25, 0.5, { exposure: 0.9 });
      kit.box(M.steel, 0.20, 0.13, 0.01, 0.35, 0.87, 0.17, 0.5);
      kit.add(M.steel, Kit.UNIT_CYL, TRS(0.52, 1.14, 0.31, 0, 0.008, 0.56, 0.008, 0, 0.22));
      this.radioPosition = new THREE.Vector3(0.35, 0.87, 0.25).applyMatrix4(TRS(x, y, z, ry));
      this._inter('radio', 'prop', this.radioPosition.x, this.radioPosition.y, this.radioPosition.z);
    }
    kit.clearBase();
    this._decal(x, z, 1.5, 0.7);
  }

  _buildWheelbarrow(kit, x, z, ry) {
    const y = this._h(x, z);
    kit.setBase(TRS(x, y, z, ry));
    kit.box(M.steel, 0.78, 0.34, 0.62, 0, 0.52, 0, 0, { rx: 0.16, exposure: 1 });
    kit.box(M.steel, 0.72, 0.02, 0.56, 0, 0.36, 0, 0, { rx: 0.16, exposure: 0.5 });
    for (const s of [-1, 1]) {
      kit.add(M.wood, Kit.UNIT_CYL, TRS(s * 0.24, 0.40, 0.62, 0, 0.045, 1.65, 0.045, -1.30));
      kit.box(M.steel, 0.05, 0.34, 0.05, s * 0.24, 0.20, -0.22, 0, { rz: s * 0.12 });
    }
    kit.add(M.rust, new THREE.TorusGeometry(0.20, 0.055, 6, 14), TRS(0, 0.20, -0.62, Math.PI / 2, 1, 1, 1));
    kit.add(M.steel, Kit.UNIT_CYL, TRS(0, 0.20, -0.62, 0, 0.05, 0.16, 0.05, 0, Math.PI / 2));
    kit.clearBase();
    this._decal(x, z, 0.9, 0.72);
    this._inter('wheelbarrow', 'prop', x, y + 0.5, z);
  }

  _buildCooler(kit, x, z, ry) {
    const y = this._h(x, z);
    kit.setBase(TRS(x, y, z, ry));
    kit.box(M.tarp, 0.72, 0.42, 0.44, 0, 0.21, 0, 0, { exposure: 1 });
    kit.box(M.tarp, 0.76, 0.09, 0.48, 0, 0.46, 0, 0, { rx: ry > 1 ? 0.5 : 0.02, exposure: 1 });
    kit.box(M.steel, 0.10, 0.06, 0.02, 0, 0.30, -0.24, 0);
    kit.clearBase();
    this._decal(x, z, 0.55, 0.75);
    this._inter(`cooler:${Math.round(x)}`, 'container', x, y + 0.4, z);
  }

  _buildCampChairs() {
    const r = new Rand(0xC4A12);
    const frameM = [];
    const seatM = [];
    const C = this.campCenter;
    for (let i = 0; i < 9; i++) {
      const a = r.next() * 6.28;
      const rad = r.range(3.6, 7.2);
      const x = C.x + Math.cos(a) * rad, z = C.z + 4 + Math.sin(a) * rad;
      const y = this._h(x, z);
      const ry = r.next() * 6.28;
      for (let k = 0; k < 4; k++) {
        const ox = (k & 1) ? 0.26 : -0.26, oz = (k & 2) ? 0.24 : -0.24;
        _e.set((k & 2) ? 0.14 : -0.14, ry, (k & 1) ? -0.10 : 0.10, 'YXZ');
        _q.setFromEuler(_e);
        frameM.push(new THREE.Matrix4().compose(
          _v3b.set(x + ox * Math.cos(ry) - oz * Math.sin(ry), y + 0.22, z + ox * Math.sin(ry) + oz * Math.cos(ry)),
          _q, _v3c.set(0.03, 0.46, 0.03)));
      }
      _e.set(0, ry, 0, 'YXZ'); _q.setFromEuler(_e);
      seatM.push(new THREE.Matrix4().compose(_v3b.set(x, y + 0.44, z), _q, _v3c.set(0.54, 0.02, 0.50)));
      _e.set(-0.32, ry, 0, 'YXZ'); _q.setFromEuler(_e);
      seatM.push(new THREE.Matrix4().compose(
        _v3b.set(x - Math.sin(ry) * 0.24, y + 0.68, z - Math.cos(ry) * 0.24), _q, _v3c.set(0.54, 0.48, 0.02)));
      this._decal(x, z, 0.5, 0.6);
    }
    if (frameM.length) this._instance(M.steel, this._auxGeo(Kit.UNIT_CYL, 1), frameM);
    if (seatM.length) this._instance('cloth', this._auxGeo(Kit.UNIT_BOX, 1), seatM, { material: this.matCloth });
  }

  // =============================================================================================
  // THE LUMBER PILE — keyart-site.png. Stacked dimensional lumber, sawhorse, crate, weighted tarp.
  // =============================================================================================
  _buildLumberPile(kit) {
    // ("0x1UMBER" was a LUMBER pun and not valid hex — U, M, B, R are not hex digits.)
    const r = new Rand(0x10B3E2);
    const S = this.siteCenter;
    const cx = S.x + 7.5, cz = S.z + 5.0;
    kit.clearBase();

    // three stacks, each a different section, stickered apart — the silhouette in the keyart
    const stacks = [
      { x: cx, z: cz, w: 0.19, h: 0.045, len: 3.9, cols: 4, rows: 9, ry: 0.10 },
      { x: cx + 1.35, z: cz + 1.5, w: 0.14, h: 0.038, len: 2.6, cols: 5, rows: 6, ry: -0.28 },
      { x: cx - 1.6, z: cz + 2.2, w: 0.235, h: 0.09, len: 4.7, cols: 3, rows: 4, ry: 0.42 },
    ];
    const boardM = [];
    for (const st of stacks) {
      const y0 = this._lowest(st.x, st.z, st.len * 0.5, st.cols * st.w * 0.5, st.ry);
      // dunnage
      for (let i = 0; i < 2; i++) {
        kit.box(M.wood, st.cols * st.w + 0.25, 0.10, 0.12,
          st.x, y0 + 0.05, st.z + (i ? 1 : -1) * st.len * 0.32, st.ry + Math.PI / 2, { exposure: 0.8 });
      }
      for (let row = 0; row < st.rows; row++) {
        const jitter = r.range(-0.035, 0.035);
        for (let col = 0; col < st.cols; col++) {
          if (row === st.rows - 1 && r.chance(0.32)) continue;   // the top course is never full
          const lx = (col - (st.cols - 1) / 2) * (st.w + 0.012) + jitter * (col === 0 ? 1 : 0.2);
          const ly = y0 + 0.12 + row * (st.h + 0.006);
          const lz = r.range(-0.06, 0.06);
          _e.set(0, st.ry + r.range(-0.012, 0.012), 0, 'YXZ');
          _q.setFromEuler(_e);
          const wx = st.x + lx * Math.cos(st.ry) - lz * Math.sin(st.ry);
          const wz = st.z + lx * Math.sin(st.ry) + lz * Math.cos(st.ry);
          boardM.push(new THREE.Matrix4().compose(
            _v3b.set(wx, ly, wz), _q, _v3c.set(st.w, st.h, st.len * r.range(0.95, 1.0))));
        }
      }
      this._decal(st.x, st.z, Math.max(st.len, st.cols * st.w) * 0.6, 0.72);
      this._inter(`lumber:${Math.round(st.x)}`, 'lumber', st.x, y0 + 0.5, st.z);
    }
    if (boardM.length) this._instance(M.lumber, this._auxGeo(Kit.UNIT_BOX, 1), boardM);

    // sawhorses — the exact object in keyart-site.png
    this._buildSawhorse(kit, S.x + 3.6, S.z + 8.2, 0.36);
    this._buildSawhorse(kit, S.x + 5.0, S.z + 9.4, 0.52);

    // the hardware crate, stencilled (the only Latin allowed in the world, ART §2.4)
    const hx = S.x + 9.6, hz = S.z + 8.0;
    const hy = this._lowest(hx, hz, 0.6, 0.45, 0.3);
    kit.box(M.lumber, 1.15, 0.62, 0.82, hx, hy + 0.31, hz, 0.3, { exposure: 1 });
    for (let i = 0; i < 4; i++) kit.box(M.lumber, 1.19, 0.07, 0.07, hx, hy + 0.08 + i * 0.17, hz - 0.42, 0.3);
    kit.box(M.steel, 0.10, 0.10, 0.02, hx + 0.5, hy + 0.34, hz - 0.44, 0.3);
    this._decal(hx, hz, 0.85, 0.76);
    this._inter('hardware-crate', 'container', hx, hy + 0.62, hz);

    // a tin box of joist hangers sitting on the crate — the Night 2 theft object
    kit.box(M.tin, 0.31, 0.09, 0.22, hx - 0.1, hy + 0.67, hz + 0.1, 0.8, { exposure: 1 });
    this._inter('tin-box:hangers', 'part-box', hx - 0.1, hy + 0.72, hz + 0.1);

    // the tarp, weighted with rocks, water pooled in the sags
    this._buildTarp(kit, S.x + 12.2, S.z + 3.4, 0.22);

    // loose offcuts and a bundle of stakes leaning on the pile
    for (let i = 0; i < 7; i++) {
      const ox = cx + r.range(-3.5, 3.5), oz = cz + r.range(-3.5, 3.5);
      const oy = this._h(ox, oz);
      this._n(ox, oz, _v3);
      kit.add(M.lumber, Kit.UNIT_BOX,
        TRS(ox, oy + 0.04, oz, r.next() * 6.28, r.range(0.10, 0.20), 0.045, r.range(0.5, 1.9),
          _v3.z * 0.4, -_v3.x * 0.4), { exposure: 1 });
      this._decal(ox, oz, 0.6, 0.5);
    }
    this.lumberPile = new THREE.Vector3(cx, this._h(cx, cz), cz);
  }

  _buildSawhorse(kit, x, z, ry) {
    const y = this._lowest(x, z, 0.7, 0.5, ry);
    kit.setBase(TRS(x, y, z, ry));
    kit.box(M.lumber, 0.09, 0.13, 1.35, 0, 0.86, 0, 0, { exposure: 1 });
    for (const sz of [-1, 1]) {
      for (const sx of [-1, 1]) {
        kit.add(M.lumber, Kit.UNIT_BOX,
          TRS(sx * 0.31, 0.42, sz * 0.52, 0, 0.07, 0.95, 0.07, sz * 0.28, -sx * 0.33), { exposure: 1 });
      }
      kit.box(M.lumber, 0.62, 0.06, 0.05, 0, 0.36, sz * 0.50, 0, { exposure: 0.9 });
    }
    kit.clearBase();
    this._decal(x, z, 0.85, 0.7);
    this._inter(`sawhorse:${Math.round(x)}`, 'prop', x, y + 0.9, z);
  }

  _buildTarp(kit, x, z, ry) {
    const r = new Rand(0x7A29);
    const y = this._lowest(x, z, 1.6, 1.2, ry);
    // A folded, sagging sheet. The mesh is dense and genuinely crumpled on purpose: a smooth
    // sheet this size lying flat is one continuous specular lobe, and at grazing moon angles
    // that reads as a blown white slab on the grass. Wrinkles at ~12 cm break the lobe into
    // fragments, which is what a wet tarp actually looks like.
    const seg = 22;
    const g = new THREE.PlaneGeometry(3.2, 2.4, seg, seg);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) / 3.2 + 0.5, v = p.getZ(i) / 2.4 + 0.5;
      const edge = Math.min(u, 1 - u, v, 1 - v) * 2;
      const sag = -0.22 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v)
        + 0.06 * Math.sin(u * 9.1) * Math.sin(v * 7.3);
      // deterministic crumple (ARCHITECTURE §6: never Math.random)
      const w = 0.030 * Math.sin(u * 27.4 + v * 9.7) * Math.cos(v * 31.1 - u * 5.3)
        + 0.017 * Math.sin(u * 61.3 - v * 44.9)
        + 0.011 * (ihash1(((u * 512) | 0) * 131 + ((v * 512) | 0)) - 0.5) * 2.0;
      p.setY(i, 0.42 * Math.min(1, edge * 2.2) + sag + w * Math.min(1, edge * 3.0));
    }
    g.computeVertexNormals();
    kit.add('tarp-sheet', g, TRS(x, y, z, ry), { exposure: 1 });
    g.dispose();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * 6.28 + 0.4;
      const rx = x + Math.cos(a) * 1.45, rz = z + Math.sin(a) * 1.05;
      kit.add(M.stone, Kit.UNIT_ICO, TRS(rx, this._h(rx, rz) + 0.14, rz, r.next() * 6.28,
        r.range(0.28, 0.44), r.range(0.2, 0.32), r.range(0.28, 0.44)));
    }
    this._decal(x, z, 2.1, 0.7);
    this._inter('tarp', 'prop', x, y + 0.4, z);
  }

  // =============================================================================================
  // THE HOMESTEAD RUIN — a life on this land before the camp. Discoverable, never signposted.
  // =============================================================================================
  _buildRuins(kit) {
    const r = new Rand(0x2013CE);   // was "0x2U1N", a RUIN pun and not valid hex
    const S = this.siteCenter;
    const x = S.x + 36, z = S.z - 24;
    kit.clearBase();

    // the stone foundation ring, black at the edges
    const rw = 5.6, rd = 4.2;
    for (let i = 0; i < 30; i++) {
      const t = i / 30;
      const a = t * Math.PI * 2;
      const px = x + Math.cos(a) * rw * (0.9 + 0.1 * Math.cos(a * 2));
      const pz = z + Math.sin(a) * rd * (0.9 + 0.1 * Math.sin(a * 3));
      const py = this._h(px, pz);
      kit.add(M.stone, Kit.UNIT_ICO, TRS(px, py + 0.10, pz, r.next() * 6.28,
        r.range(0.36, 0.66), r.range(0.20, 0.40), r.range(0.34, 0.58), r.range(-0.2, 0.2)));
    }
    this._decal(x, z, 5.4, 0.5);

    // the burned doorframe, still standing
    const dx = x - rw * 0.85, dz = z + 0.4;
    const dy = this._h(dx, dz);
    kit.box(M.bark, 0.16, 2.25, 0.18, dx, dy + 1.12, dz - 0.5, 0.14, { exposure: 1 });
    kit.box(M.bark, 0.16, 2.25, 0.18, dx + 0.06, dy + 1.10, dz + 0.5, 0.14, { rz: 0.045, exposure: 1 });
    kit.box(M.bark, 0.18, 0.16, 1.28, dx + 0.03, dy + 2.22, dz, 0.14, { exposure: 1 });
    this._decal(dx, dz, 1.4, 0.72);
    this._inter('story:burned-doorframe', 'story', dx, dy, dz);

    // the rusted stove, on its side, one leg gone
    const sx = x + 1.6, sz = z - 1.2;
    const sy = this._h(sx, sz);
    kit.box(M.rust, 0.82, 1.05, 0.66, sx, sy + 0.40, sz, 0.7, { rz: 0.42, exposure: 1 });
    kit.box(M.rust, 0.86, 0.06, 0.70, sx - 0.22, sy + 0.86, sz, 0.7, { rz: 0.42 });
    kit.add(M.rust, Kit.UNIT_CYL, TRS(sx - 0.44, sy + 1.05, sz, 0.7, 0.15, 0.9, 0.15, 0, 0.42));
    for (let i = 0; i < 3; i++) {
      kit.box(M.rust, 0.06, 0.22, 0.06, sx + 0.3 - i * 0.22, sy + 0.05, sz + 0.24, 0.7, { rz: 0.42 });
    }
    this._decal(sx, sz, 1.0, 0.76);
    this._inter('story:rusted-stove', 'story', sx, sy, sz);

    // the fire-scarred oak: a thick, black, forked trunk that survived whatever happened here
    const ox = x + 6.4, oz = z + 3.2;
    const oy = this._h(ox, oz);
    kit.add(M.bark, Kit.UNIT_CYL_HI, TRS(ox, oy + 3.1, oz, 0.4, 1.05, 6.4, 0.92, 0.03, 0.02), { exposure: 1 });
    for (const s of [-1, 1]) {
      kit.add(M.bark, Kit.UNIT_CYL, TRS(ox + s * 0.9, oy + 6.6, oz + s * 0.3, 0, 0.42, 3.4, 0.42, 0, s * 0.42), { exposure: 1 });
      kit.add(M.bark, Kit.UNIT_CYL, TRS(ox + s * 2.0, oy + 7.8, oz - s * 0.5, 0, 0.22, 2.4, 0.22, s * 0.5, s * 0.6), { exposure: 1 });
    }
    this._decal(ox, oz, 2.4, 0.8);
    this._inter('story:fire-scarred-oak', 'story', ox, oy, oz);

    // the orchard, gone wild, in rows leading away from the house
    this._buildOrchard(x + 4, z + 20, 4, 5, 6.2, -0.32, 0x02CD);

    // the big fallen log at buildSite + (-26,-18): pier 6, the mallet, the 1961 plate (STORY §4.2)
    const lx = S.x - 26, lz = S.z - 18;
    const ly = this._h(lx, lz);
    kit.add(M.bark, Kit.UNIT_CYL_HI, TRS(lx, ly + 0.52, lz, 1.05, 1.04, 9.5, 1.04, 0, Math.PI / 2 + 0.03), { exposure: 1 });
    kit.add(M.bark, Kit.UNIT_CYL, TRS(lx + 3.9, ly + 1.1, lz - 1.6, 1.05, 0.34, 2.2, 0.34, 0.5, 1.2), { exposure: 1 });
    this._decal(lx, lz, 4.2, 0.74);
    this._inter('fallen-log', 'landmark', lx, ly, lz);
  }

  // =============================================================================================
  // STORY PROPS — STORY.md §7 / Script.props. Every one of them inert. If it is never found,
  // that is the point.
  // =============================================================================================
  _buildStoryProps(kit) {
    let list = null;
    try {
      // Script is pure data; a static import would make Props depend on Story loading cleanly.
      list = (globalThis.__SC_SCRIPT_PROPS__ || null);
    } catch { list = null; }
    if (!list) list = this._storyFallback();
    kit.clearBase();
    for (const p of list) {
      if (p.owner && p.owner !== 'Props') continue;
      const pos = this._storyPos(p);
      if (!pos) continue;
      this._placeStoryProp(kit, p.id, pos);
      this._inter(`story:${p.id}`, 'story', pos.x, pos.y, pos.z);
    }
  }

  /** Resolve a Script.props record into a world position. See header note 6. */
  _storyPos(p) {
    const o = STORY_ANCHOR[p.id];
    let ax, az, ox, oz;
    if (o) {
      const frame = o[0];
      const a = frame === 'camp' ? this.campCenter : frame === 'dock' ? this.dockPoint : this.siteCenter;
      ax = a.x; az = a.z; ox = o[1]; oz = o[2];
    } else {
      ax = this.siteCenter.x; az = this.siteCenter.z;
      ox = p.position ? p.position.x : 0;
      oz = p.position ? p.position.z : 0;
    }
    if (!Number.isFinite(ox) || !Number.isFinite(oz)) return null;
    const v = this._clampWorld(new THREE.Vector3(ax + ox, 0, az + oz));
    v.y = this._h(v.x, v.z);
    return v;
  }

  _storyFallback() {
    return [
      { id: 'porcelain_sink', owner: 'Props', position: { x: -38.0, z: -46.0 } },
      { id: 'childs_boot', owner: 'Props', position: { x: 46.0, z: 38.0 } },
      { id: 'ruined_pages_tin', owner: 'Props', position: { x: -12.5, z: 9.0 } },
      { id: 'survey_marker', owner: 'Props', position: { x: 58.0, z: 22.0 } },
      { id: 'bev_ashtray', owner: 'Props', position: { x: 138.0, z: 88.0 } },
      { id: 'boathouse_door', owner: 'Props', position: { x: 70.0, z: -25.0 } },
      { id: 'dales_torch', owner: 'Props', position: { x: 41.0, z: 29.0 } },
      { id: 'rock_floorplan', owner: 'Props', position: { x: -74.0, z: 63.0 } },
      { id: 'swing_seat', owner: 'Props', position: { x: 92.0, z: 58.0 } },
      { id: 'grave', owner: 'Props', position: { x: -22.5, z: 33.0 } },
      { id: 'birch_marks', owner: 'Props', position: { x: -9.4, z: -14.2 } },
    ];
  }

  _placeStoryProp(kit, id, p) {
    const r = new Rand(0x570 + Math.floor(hashStr(id) * 1e6));
    const x = p.x, y = p.y, z = p.z;
    switch (id) {
      case 'porcelain_sink': {
        // propped against a birch, carried here and set down carefully
        kit.box(M.concrete, 0.62, 0.44, 0.48, x, y + 0.30, z, 0.6, { rx: -0.42, exposure: 1 });
        kit.box(M.concrete, 0.62, 0.30, 0.06, x - 0.14, y + 0.62, z - 0.14, 0.6, { rx: -0.42 });
        kit.add(M.bark, Kit.UNIT_CYL_HI, TRS(x - 0.5, y + 3.2, z - 0.35, 0, 0.44, 6.6, 0.44, 0.02, 0.01), { exposure: 1 });
        this._decal(x, z, 0.8, 0.74);
        break;
      }
      case 'childs_boot': {
        // hung on a nail at head height. Not dropped — hung.
        kit.add(M.bark, Kit.UNIT_CYL_HI, TRS(x, y + 3.6, z, 0, 0.38, 7.4, 0.38), { exposure: 1 });
        kit.box(M.wood, 0.14, 0.16, 0.22, x + 0.34, y + 1.62, z, 0.4, { exposure: 0.9 });
        kit.box(M.wood, 0.12, 0.20, 0.12, x + 0.34, y + 1.76, z - 0.02, 0.4, { exposure: 0.9 });
        kit.add(M.rust, Kit.UNIT_CYL, TRS(x + 0.22, y + 1.82, z, 0, 0.012, 0.16, 0.012, 0, Math.PI / 2));
        break;
      }
      case 'ruined_pages_tin': {
        const ry = r.next() * 6.28;
        kit.box(M.tin, 0.36, 0.11, 0.26, x, y + 0.07, z, ry, { exposure: 1 });
        kit.add(M.stone, Kit.UNIT_ICO, TRS(x, y + 0.22, z, ry * 1.3, 0.34, 0.22, 0.30));
        this._decal(x, z, 0.5, 0.78);
        break;
      }
      case 'survey_marker': {
        // brass, 1962, polished bright by something rubbing it
        kit.add(M.concrete, Kit.UNIT_CYL_HI, TRS(x, y + 0.06, z, 0, 0.30, 0.22, 0.30), { exposure: 1 });
        kit.add(M.steel, Kit.UNIT_CYL_HI, TRS(x, y + 0.18, z, 0, 0.13, 0.03, 0.13), { exposure: 1 });
        this._decal(x, z, 0.45, 0.7);
        break;
      }
      case 'bev_ashtray': {
        // a hubcap on the office porch, forty butts, all crushed the same direction
        kit.add(M.steel, new THREE.CylinderGeometry(0.16, 0.12, 0.05, 16, 1),
          TRS(x, y + 0.44, z, 0.3, 1, 1, 1), { exposure: 0.5 });
        for (let i = 0; i < 4; i++) {
          const a = 4.1 + r.range(-0.25, 0.25);
          kit.add('cloth', Kit.UNIT_BOX, TRS(x + Math.cos(a) * 0.08, y + 0.47, z + Math.sin(a) * 0.08, a, 0.006, 0.006, 0.03));
        }
        // her chair, facing 293 degrees — the point where the house used to be
        const face = Math.atan2(this.siteCenter.x - x, this.siteCenter.z - z);
        kit.box(M.wood, 0.50, 0.05, 0.46, x - 0.5, y + 0.42, z, face, { exposure: 0.8 });
        kit.box(M.wood, 0.50, 0.52, 0.05, x - 0.5 - Math.sin(face) * 0.21, y + 0.68, z - Math.cos(face) * 0.21, face, { rx: -0.10 });
        for (let k = 0; k < 4; k++) {
          kit.box(M.wood, 0.04, 0.42, 0.04, x - 0.5 + ((k & 1) ? 0.2 : -0.2), y + 0.21, z + ((k & 2) ? 0.19 : -0.19), face);
        }
        // the small table the hubcap sits on
        kit.box(M.wood, 0.42, 0.05, 0.42, x, y + 0.42, z, 0.3, { exposure: 0.8 });
        for (let k = 0; k < 4; k++) {
          kit.box(M.wood, 0.04, 0.42, 0.04, x + ((k & 1) ? 0.16 : -0.16), y + 0.21, z + ((k & 2) ? 0.16 : -0.16), 0.3);
        }
        this._decal(x - 0.3, z, 1.0, 0.7);
        break;
      }
      case 'boathouse_door': {
        // hinges gone, propped with an oar. It stays open for the rest of the game.
        kit.box(M.wood, 1.02, 2.05, 0.07, x, y + 1.0, z, 0.9, { rz: 0.16, exposure: 1 });
        for (let i = 0; i < 4; i++) kit.box(M.wood, 1.05, 0.10, 0.09, x, y + 0.35 + i * 0.5, z - 0.05, 0.9, { rz: 0.16 });
        kit.add(M.wood, Kit.UNIT_CYL, TRS(x + 0.85, y + 0.95, z + 0.45, 0.9, 0.05, 2.2, 0.05, 0.5, -0.44), { exposure: 1 });
        kit.box(M.wood, 0.18, 0.02, 0.42, x + 1.55, y + 1.85, z + 0.85, 0.9, { rx: 0.5, rz: -0.44 });
        this._decal(x, z, 1.3, 0.74);
        break;
      }
      case 'dales_torch': {
        // still lit, battery dying, beam browning. A man put this down and did not pick it up.
        kit.add(M.steel, Kit.UNIT_CYL, TRS(x, y + 0.05, z, 1.2, 0.055, 0.26, 0.055, 0, Math.PI / 2), { exposure: 1 });
        kit.add('glow-window', Kit.UNIT_SPHERE, TRS(x + 0.12, y + 0.05, z + 0.05, 0, 0.055, 0.055, 0.055), { glow: 0.55 });
        this._proxy(x + 0.12, y + 0.06, z + 0.05, 0xffb06a, 0.9, 5, true);
        this._decal(x, z, 0.5, 0.5);
        break;
      }
      case 'rock_floorplan': {
        // a hand-drawn floor plan carved into a rock face near the ridge
        kit.add(M.stone, Kit.UNIT_ICO, TRS(x, y + 0.9, z, 0.5, 4.2, 2.6, 3.0, 0.1, 0.06), { exposure: 1 });
        // the carving: eleven shallow grooves in a rectangle, lit only by a raking lantern
        for (let i = 0; i < 11; i++) {
          const u = (i / 10 - 0.5);
          kit.box(M.stone, 0.012, 0.9, 0.012, x + u * 1.5, y + 1.5, z - 1.35, 0.5, { exposure: 0.9 });
        }
        kit.box(M.stone, 1.55, 0.012, 0.012, x, y + 1.05, z - 1.36, 0.5);
        kit.box(M.stone, 1.55, 0.012, 0.012, x, y + 1.95, z - 1.36, 0.5);
        this._decal(x, z, 3.0, 0.7);
        break;
      }
      case 'swing_seat': {
        // a rusted swing seat hanging from one chain. The tree is now inside the archery range.
        kit.add(M.bark, Kit.UNIT_CYL_HI, TRS(x, y + 3.4, z, 0, 0.62, 7.0, 0.62, 0.03, 0.02), { exposure: 1 });
        kit.add(M.bark, Kit.UNIT_CYL, TRS(x + 1.3, y + 4.3, z, 0, 0.24, 2.9, 0.24, 0, 1.35), { exposure: 1 });
        for (let i = 0; i < 9; i++) {
          kit.add(M.rust, Kit.UNIT_CYL, TRS(x + 2.2, y + 4.1 - i * 0.19, z, i * 0.9, 0.018, 0.20, 0.018));
        }
        kit.box(M.wood, 0.42, 0.05, 0.20, x + 2.24, y + 2.42, z + 0.10, 0.35, { rz: 0.55, exposure: 1 });
        this._decal(x, z, 2.0, 0.8);
        break;
      }
      case 'grave': {
        // unmarked, small, well-kept, the grass cut by hand
        kit.box(M.wood, 1.15, 0.05, 1.85, x, y + 0.03, z, 0.2, { exposure: 1 });
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * 6.28;
          kit.add(M.stone, Kit.UNIT_ICO,
            TRS(x + Math.cos(a) * 0.75, y + 0.06, z + Math.sin(a) * 1.10, r.next() * 6.28, 0.20, 0.13, 0.18));
        }
        this._decal(x, z, 1.5, 0.42);
        break;
      }
      case 'birch_marks': {
        // four pencil notches at 91, 108, 124 and 141 cm
        kit.add(M.bark, Kit.UNIT_CYL_HI, TRS(x, y + 4.0, z, 0, 0.34, 8.2, 0.34, 0.015, 0.01), { exposure: 1 });
        for (const h of [0.91, 1.08, 1.24, 1.41]) {
          kit.box(M.bark, 0.20, 0.010, 0.012, x, y + h, z - 0.17, 0, { exposure: 0.9 });
        }
        this._decal(x, z, 0.7, 0.72);
        break;
      }
      default: {
        kit.add(M.stone, Kit.UNIT_ICO, TRS(x, y + 0.14, z, r.next() * 6.28, 0.5, 0.3, 0.45));
        this._decal(x, z, 0.6, 0.6);
      }
    }
  }
}

export default Props;
