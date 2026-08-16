/**
 * VOLUMETRIC FOG + LIGHT SHAFTS.  "Fog is a character." (ART_DIRECTION.md §5)
 *
 * OWNER: Render agent.  See ARCHITECTURE.md §9 and ART_DIRECTION.md §5.1–§5.4.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------------------------
 * A screen-space raymarcher that integrates in-scattered radiance and transmittance along the
 * view ray, from the near plane to scene depth, at a tier-driven fraction of the render
 * resolution, with per-pixel blue-noise ray-start jitter and temporal reprojection.
 *
 * The medium is lit by:
 *   - the moon, sampled against its real shadow map, which is what makes canopy shafts;
 *   - the player's lantern, sampled against its spot shadow map, so trees cut the cone;
 *   - up to N campfire / sodium / torch locals (cone falloff only, no shadow — ART §5.4);
 *   - an ambient sky-scatter term graded near->far (fog.near -> fog.far);
 *   - lightning, which floods the whole medium for the length of the flash.
 * Phase is Henyey-Greenstein with a 0.12 isotropic floor, so looking toward a light blooms and
 * looking away goes dim.  That anisotropy is the entire difference between fog and atmosphere.
 *
 * Density is exponential height falloff modulated by drifting low-frequency noise, PLUS a
 * separate, much denser GROUND MIST layer that follows the terrain, flattens onto the lake at
 * the waterline, pools in hollows, thins on ridges, and is pushed aside by the player.  The
 * layering is the point: see public/img/keyart-lake.png, where the mist sits in a band ON the
 * water rather than filling the frame.
 *
 * ---------------------------------------------------------------------------------------------
 * PUBLIC API (this is what other modules may rely on)
 * ---------------------------------------------------------------------------------------------
 *   fog.enabled            bool     hard off switch.  false => render() is a no-op and the
 *                                   standalone composite quad hides itself.
 *   fog.target             THREE.WebGLRenderTarget | null
 *                                   RGB = in-scattered radiance, LINEAR, pre-tonemap.
 *                                   A   = transmittance of the medium to the scene surface.
 *                                   Composite is:  colour = scene * fog.a + fog.rgb
 *                                   Stable across frames — safe to grab the texture once.
 *   fog.texture            THREE.Texture | null      convenience for target.texture
 *   fog.render()                    integrate one frame into fog.target.  Postprocessing should
 *                                   call this once per frame BEFORE its composite.
 *   fog.resize(w, h)                CSS px; the fog buffer is derived from the drawing buffer.
 *   fog.update(dt, elapsed)         per-frame bookkeeping; also drives render() when there is no
 *                                   Postprocessing system to drive it.
 *   fog.dispose()
 *   fog.setEnabled(bool)
 *   fog.depthTexture       THREE.DepthTexture | null   the prepass depth THIS module owns; null
 *                                   when it is borrowing Postprocessing's depth instead.
 *   fog.resolutionScale    number   0.2..1, settable; reallocates.
 *   fog.stats              { width, height, steps, scale, standalone, cpuMs }
 *   fog.params             tunables (density, mist, scattering) — see DEFAULT_PARAMS.
 *
 * ---------------------------------------------------------------------------------------------
 * INTEGRATION NOTES FOR OTHER AGENTS
 * ---------------------------------------------------------------------------------------------
 * - If `Postprocessing` exposes `depthTexture`, this module uses it and skips its own depth
 *   prepass entirely.  Give it a non-linear device-depth `THREE.DepthTexture` at the main
 *   render resolution and you save a whole scene pass.
 * - If `Postprocessing` exposes `render()`, this module assumes Postprocessing composites the
 *   target and it removes its own fullscreen quad from the scene.  If Postprocessing then fails
 *   to call `fog.render()` for 45 frames, this module falls back to compositing itself so the
 *   game is never silently fog-less.
 * - `Sky` may expose `moonLight` / `moon` / `light` (a DirectionalLight).  Otherwise the
 *   brightest shadow-casting DirectionalLight in the scene is used.
 * - `Flashlight.light` (SpotLight) and `Props.lights` (array of lights, or of objects with a
 *   `.light`) are read defensively every frame.
 * - Nothing here throws if every other system is missing.
 *
 * GLSL-in-JS: no backtick may appear inside any shader string, including in comments
 * (ARCHITECTURE.md §11b).  Shader comments below use 'single quotes'.
 */

import * as THREE from 'three';
import { Log } from '../core/Log.js';

// ------------------------------------------------------------------------------------------
// module-scope scratch — nothing in update()/render() allocates
// ------------------------------------------------------------------------------------------
const _v2 = new THREE.Vector2();
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _col = new THREE.Color();
const _colB = new THREE.Color();

const MAX_LOCALS = 3;
const TERRAIN_TEX = 128;          // texels per side of the mist-floor window
const TERRAIN_SPAN = 320;         // metres covered by that window
const TERRAIN_RECENTER = 96;      // recentre when the player leaves this radius
const TERRAIN_ROWS_PER_FRAME = 10;
const NOISE_TEX = 64;

/** Art-directed defaults.  Every one of these is live-tunable through `fog.params`. */
const DEFAULT_PARAMS = {
  /** Base height-fog density at the fog floor, 1/m.  ART §5.1 clear=0.014 .. whiteout=0.078 */
  density: 0.016,
  /** Fog floor, metres. */
  floorY: -1.0,
  /** Scale height, metres.  ART §5.1: 4.2 clear (shoulder height on the lake path). */
  scaleHeight: 4.4,
  /** Henyey-Greenstein g.  ART §5.1: 0.55 clear .. 0.38 whiteout. */
  hg: 0.62,
  /** Single-scattering albedo. Water droplets are near-white. */
  albedo: 0.92,
  /** How hard the ambient sky-scatter term reads. */
  ambient: 1.15,
  /** Contrast of the drifting density noise. 0 = uniform grey wash (a named failure mode). */
  noiseContrast: 0.95,
  /** Ground-mist top above the mist floor, metres, before pooling/wobble. ART §5.2: ~0.55. */
  mistTop: 0.72,
  /** Vertical feather of the mist ceiling.  Small = a distinct LAYER. */
  mistFeather: 0.52,
  /** Ground-mist density, 1/m.  Much denser than the height fog — that is what makes a layer. */
  mistDensity: 0.30,
  /** How much the noise wobbles the mist ceiling, metres. */
  mistWobble: 0.42,
  /** How much the mist tints itself toward fog.near (self-lit look). */
  mistTint: 0.55,
  /** Multiplier on the moon's volumetric contribution. */
  moonScatter: 1.0,
  /** Multiplier on the lantern's volumetric contribution. */
  lanternScatter: 1.0,
  /** Multiplier on campfire/sodium/torch volumetrics. */
  localScatter: 1.0,
  /** Rain streaks inside a light cone are lit at this multiple. ART §5.4. */
  rainStreak: 2.2,
  /** Far clamp of the march, metres. */
  maxDistance: 150,
};

/** ART_DIRECTION §2.2 fog swatches. */
const PAL = {
  near: 0x2a3a44,
  nearThick: 0x4a5d6c,
  far: 0x54697a,
  farThick: 0x54697a,
  lit: 0x8fa6bb,
  dawnNear: 0x3a4a52,
  dawnFar: 0x6d7e88,
};

// ------------------------------------------------------------------------------------------
// shaders
// ------------------------------------------------------------------------------------------

const FULLSCREEN_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const MARCH_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;

varying vec2 vUv;

uniform sampler2D tDepth;
uniform sampler2D tNoise;
uniform sampler2D tBlue;
uniform sampler2D tTerrain;
uniform sampler2D tHistory;
uniform sampler2D tMoonShadow;
uniform sampler2D tLampShadow;

uniform mat4  uInvProj;
uniform mat4  uCamWorld;
uniform mat4  uPrevViewProj;
uniform vec3  uCamPos;
uniform vec2  uNearFar;
uniform float uFrame;
uniform float uTime;
uniform float uRevDepth;
uniform float uHistoryAmount;
uniform float uBlueSize;

// x base density, y fog floor y, z 1/scaleHeight, w max march distance
uniform vec4  uFogA;
// x hg g, y albedo, z ambient scale, w mist tint
uniform vec4  uFogB;
uniform vec3  uFogNear;
uniform vec3  uFogFar;
uniform vec3  uFogLit;

// x mist top, y mist feather, z mist density, w mist wobble
uniform vec4  uMist;
// x noise scale A, y noise scale B, z contrast, w rain streak gain
uniform vec4  uNoiseCfg;
uniform vec2  uDriftA;
uniform vec2  uDriftB;

// xz = window centre, y = 1.0 when the terrain window is valid
uniform vec3  uTerrainOrigin;
uniform float uTerrainSpan;

uniform vec3  uMoonDir;
uniform vec3  uMoonColor;
uniform mat4  uMoonShadowMat;
uniform vec2  uMoonShadowCfg;      // x enabled, y bias

uniform vec3  uLampPos;
uniform vec3  uLampDir;
uniform vec3  uLampColor;
uniform vec4  uLampCone;           // x cosOuter, y cosInner, z range, w unused
uniform mat4  uLampShadowMat;
uniform vec2  uLampShadowCfg;      // x enabled, y bias

uniform vec3  uLocalPos[LOCALS];
uniform vec3  uLocalColor[LOCALS];
uniform vec3  uLocalDir[LOCALS];
uniform vec4  uLocalParams[LOCALS];  // x cosOuter, y cosInner, z range, w isSpot

uniform vec4  uWeather;            // x rain, y wetness, z lightning, w nightPhase
uniform vec3  uPlayerPos;

const float PI_INV4 = 0.0795774715;

float sat(float x) { return clamp(x, 0.0, 1.0); }

// Henyey-Greenstein, un-normalised (the 1/4pi is folded into the light intensities), with a
// small isotropic floor so back-lit fog never goes fully black.  ART §5.3.
float phaseHG(float c, float g) {
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * c;
  return ((1.0 - g2) / max(pow(max(d, 1e-4), 1.5), 1e-4)) * 0.88 + 0.12;
}

// One unfiltered tap against a three.js shadow map.  The maps are plain depth textures with
// compareFunction disabled under PCFSoftShadowMap, so a straight fetch is legal.
float shadowTap(sampler2D smap, mat4 mtx, vec3 p, float bias) {
  vec4 sc = mtx * vec4(p, 1.0);
  if (sc.w <= 0.0) return 1.0;
  vec3 s = sc.xyz / sc.w;
  if (s.x < 0.002 || s.x > 0.998 || s.y < 0.002 || s.y > 0.998) return 1.0;
  if (s.z <= 0.0 || s.z >= 1.0) return 1.0;
  float d = texture2D(smap, s.xy).x;
  float fwd = step(s.z - bias, d);
  float rev = step(d, s.z + bias);
  return mix(fwd, rev, uRevDepth);
}

// R = mist floor height (terrain, flattened to the waterline over water)
// G = water mask, B = pooling (0 ridge .. 1 hollow), A = local density multiplier
vec4 terrainAt(vec2 xz) {
  vec2 t = (xz - uTerrainOrigin.xz) / uTerrainSpan + 0.5;
  return texture2D(tTerrain, clamp(t, 0.001, 0.999));
}

float densityAt(vec3 p, out float mistAmt) {
  // ---- drifting low-frequency structure.  Uniform fog reads as a grey wash; this is the fix.
  vec2 n1 = p.xz * uNoiseCfg.x + uDriftA + vec2(p.y * 0.011, -p.y * 0.008);
  vec2 n2 = p.xz * uNoiseCfg.y + uDriftB + vec2(-p.y * 0.023, p.y * 0.017);
  float n = texture2D(tNoise, n1).r * 0.66 + texture2D(tNoise, n2).g * 0.34;
  n = mix(0.5, n, uNoiseCfg.z);

  // ---- analytic height fog
  float base = uFogA.x * exp(-max(p.y - uFogA.y, 0.0) * uFogA.z);
  base *= 0.40 + 1.40 * n;

  // ---- ground mist: a LAYER, not a fill
  vec4 tr = terrainAt(p.xz);
  float valid = uTerrainOrigin.y;
  float floorY = mix(uFogA.y + 0.6, tr.r, valid);
  float pool = mix(0.5, tr.b, valid);
  float mult = mix(1.0, tr.a, valid);

  float top = floorY + uMist.x * (0.55 + 1.25 * pool) + (n - 0.5) * uMist.w;

  // the monster leaves a wake in the mist (ART §5.2)
  vec2 dxz = p.xz - uPlayerPos.xz;
  top -= exp(-dot(dxz, dxz) * 0.85) * 0.42;

  float band = sat((top - p.y) / max(uMist.y, 0.04));
  band *= sat((p.y - floorY + 1.30) * 1.5);
  float clump = smoothstep(0.28, 0.88, n);
  mistAmt = band * (0.30 + 0.90 * clump) * mult;

  return base + uMist.z * mistAmt;
}

void main() {
  // ---------------------------------------------------------------- ray + scene depth
  float rawD = texture2D(tDepth, vUv).x;
  rawD = mix(rawD, 1.0 - rawD, uRevDepth);

  vec4 vpos = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 vdir = normalize(vpos.xyz / vpos.w);
  vec3 rd = normalize((uCamWorld * vec4(vdir, 0.0)).xyz);

  float sceneDist = uFogA.w;
  if (rawD < 0.999995) {
    float viewZ = (uNearFar.x * uNearFar.y) / ((uNearFar.y - uNearFar.x) * rawD - uNearFar.y);
    sceneDist = min(viewZ / min(vdir.z, -1e-4), uFogA.w);
  }

  float startD = max(uNearFar.x, 0.10);
  float span = sceneDist - startD;

  vec3 Lacc = vec3(0.0);
  float T = 1.0;

  if (span > 0.0) {
    // ---------------------------------------------------------------- jitter
    // Animated blue noise on the ray start.  This is what turns slice banding into film grain
    // and it is not optional (see the brief).  Golden-ratio temporal offset.
    float bn = texture2D(tBlue, (gl_FragCoord.xy + 0.5) / uBlueSize).r;
    float jitter = fract(bn + uFrame * 0.6180339887);

    float g = uFogB.x;
    float albedo = uFogB.y;
    float invSteps = 1.0 / float(STEPS);
    const float DISTRIB = 0.34;   // blend of linear and quadratic step distribution

    float phaseMoon = phaseHG(dot(uMoonDir, rd), g);

    float f0 = 0.0;
    for (int i = 0; i < STEPS; i++) {
      float u1 = float(i + 1) * invSteps;
      float f1 = u1 * (DISTRIB + (1.0 - DISTRIB) * u1);
      float um = (float(i) + jitter) * invSteps;
      float fm = um * (DISTRIB + (1.0 - DISTRIB) * um);
      float dz = span * (f1 - f0);
      f0 = f1;

      float dist = startD + span * fm;
      vec3 p = uCamPos + rd * dist;

      float mistAmt = 0.0;
      float sigma = densityAt(p, mistAmt);

      if (sigma > 2e-5) {
        // ------------------------------------------------ ambient / aerial in-scatter
        vec3 L = mix(uFogNear, uFogFar, sat(dist * 0.017)) * uFogB.z;
        L += uFogNear * (mistAmt * uFogB.w);
        L += uFogLit * (uWeather.z * 2.4);

        vec3 Lwarm = vec3(0.0);

        // ------------------------------------------------ moon shafts (the money shot)
        float shM = mix(0.85, shadowTap(tMoonShadow, uMoonShadowMat, p, uMoonShadowCfg.y),
                        uMoonShadowCfg.x);
        L += uMoonColor * (phaseMoon * shM);

        // ------------------------------------------------ the lantern (keyart-site.png)
        vec3 toL = uLampPos - p;
        float dl2 = dot(toL, toL);
        float dl = sqrt(max(dl2, 1e-4));
        vec3 ld = toL / dl;
        float coneA = smoothstep(uLampCone.x, uLampCone.y, dot(uLampDir, -ld));
        if (coneA > 0.0) {
          float att = 1.0 / max(dl2, 0.05);
          float rr = dl / max(uLampCone.z, 0.001);
          rr = rr * rr; rr = rr * rr;
          att *= pow(sat(1.0 - rr), 2.0);
          float shL = mix(1.0, shadowTap(tLampShadow, uLampShadowMat, p, uLampShadowCfg.y),
                          uLampShadowCfg.x);
          Lwarm += uLampColor * (coneA * att * shL * phaseHG(dot(ld, rd), g));
        }

        // ------------------------------------------------ campfires / sodium / torches
        for (int k = 0; k < LOCALS; k++) {
          vec4 par = uLocalParams[k];
          if (par.z > 0.0) {
            vec3 t2 = uLocalPos[k] - p;
            float d22 = dot(t2, t2);
            float d2 = sqrt(max(d22, 1e-4));
            vec3 ld2 = t2 / d2;
            float att = 1.0 / max(d22, 0.05);
            float r2 = d2 / par.z;
            r2 = r2 * r2; r2 = r2 * r2;
            att *= pow(sat(1.0 - r2), 2.0);
            float cone = mix(1.0, smoothstep(par.x, par.y, dot(uLocalDir[k], -ld2)), par.w);
            Lwarm += uLocalColor[k] * (att * cone * phaseHG(dot(ld2, rd), g));
          }
        }

        L += Lwarm;

        // ------------------------------------------------ rain streaks inside the cones
        if (uWeather.x > 0.03) {
          vec2 sUV = vec2(p.x * 0.55 + p.z * 0.31, -p.y * 0.085 - uTime * 0.85);
          float st = smoothstep(0.60, 0.95, texture2D(tNoise, sUV).b);
          L += Lwarm * (st * uWeather.x * uNoiseCfg.w);
        }

        // ------------------------------------------------ analytic slice integration
        float Ts = exp(-sigma * dz);
        Lacc += T * (L * albedo) * (1.0 - Ts);
        T *= Ts;
        if (T < 0.006) break;
      }
    }
  }

  vec4 cur = vec4(max(Lacc, vec3(0.0)), clamp(T, 0.0, 1.0));
  vec4 outC = cur;

  // ---------------------------------------------------------------- temporal reprojection
  if (uHistoryAmount > 0.001) {
    vec3 wp = uCamPos + rd * min(sceneDist, uFogA.w);
    vec4 pc = uPrevViewProj * vec4(wp, 1.0);
    if (pc.w > 0.0) {
      vec2 pUV = pc.xy / pc.w * 0.5 + 0.5;
      if (pUV.x > 0.002 && pUV.x < 0.998 && pUV.y > 0.002 && pUV.y < 0.998) {
        vec4 h = texture2D(tHistory, pUV);
        // Rejection: transmittance is the integral of density to the scene surface, so a
        // disocclusion (a tree edge sliding past) moves it hard.  Reject on disagreement,
        // then variance-clamp the radiance so a surviving sample cannot smear.
        float rej = exp(-abs(h.a - cur.a) * 16.0);
        vec3 tol = cur.rgb * 0.85 + vec3(0.02);
        h.rgb = clamp(h.rgb, cur.rgb - tol, cur.rgb + tol);
        h.a = clamp(h.a, cur.a - 0.14, cur.a + 0.14);
        outC = mix(cur, h, uHistoryAmount * rej);
      }
    }
  }

  gl_FragColor = outC;
}
`;

const COMPOSITE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;

uniform sampler2D tFog;
uniform sampler2D tDepth;
uniform vec2 uFogTexel;
uniform vec2 uNearFar;
uniform float uRevDepth;
uniform float uIntensity;

float linZ(float d) {
  d = mix(d, 1.0 - d, uRevDepth);
  return (uNearFar.x * uNearFar.y) / ((uNearFar.y - uNearFar.x) * d - uNearFar.y);
}

void main() {
  vec4 f;

#if UPSAMPLE
  // Depth-aware bilateral upsample.  Without it the fog haloes every silhouette.
  float dc = linZ(texture2D(tDepth, vUv).x);
  vec2 o = uFogTexel;
  vec2 offs[4];
  offs[0] = vec2(-o.x, -o.y);
  offs[1] = vec2( o.x, -o.y);
  offs[2] = vec2(-o.x,  o.y);
  offs[3] = vec2( o.x,  o.y);
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 t = vUv + offs[i];
    float dz = linZ(texture2D(tDepth, t).x);
    float w = exp(-abs(dz - dc) * 0.65) + 1e-3;
    acc += texture2D(tFog, t) * w;
    wsum += w;
  }
  f = acc / max(wsum, 1e-4);
#else
  f = texture2D(tFog, vUv);
#endif

  // RGB is linear HDR in-scatter, A is transmittance.  Custom blending downstream resolves
  // this to  scene * A + RGB.  Tone map the in-scatter with the same operator the scene used.
  gl_FragColor = vec4(f.rgb * uIntensity, clamp(f.a, 0.0, 1.0));

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const BLIT_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
void main() { gl_FragColor = texture2D(tSrc, vUv); }
`;

// ------------------------------------------------------------------------------------------

export class VolumetricFog {
  /** @param {any} ctx */
  constructor(ctx) {
    this.ctx = ctx ?? {};
    this.bus = this.ctx.bus ?? null;

    /** Hard off switch.  Nothing is rendered and nothing is composited when false. */
    this.enabled = true;

    /** @type {THREE.WebGLRenderTarget|null} RGB = in-scatter (linear), A = transmittance. */
    this.target = null;

    /** @type {THREE.WebGLRenderTarget|null} */
    this._history = null;
    /** @type {THREE.WebGLRenderTarget|null} */
    this._depthRT = null;

    this.params = { ...DEFAULT_PARAMS };
    this.stats = { width: 0, height: 0, steps: 0, scale: 1, standalone: true, cpuMs: 0 };

    this._scale = 0.5;
    this._effScale = 0.5;
    this._steps = 24;
    this._locals = 2;
    this._historyAmount = 0.88;

    /**
     * Hard ceilings on buffer area, independent of DPR.  A retina 1080p canvas is a 3840x2160
     * drawing buffer; a full-res HDR fog buffer there is 66 MB and 8.3 M raymarched pixels,
     * which is not a 2.5 ms pass on any laptop.  These caps keep the budget honest while still
     * letting the tier ask for "full".
     */
    this.maxFogPixels = 1.35e6;
    this.maxDepthPixels = 2.15e6;

    this._fw = 1; this._fh = 1;
    this._dw = 1; this._dh = 1;
    this._rw = 1; this._rh = 1;

    this._frame = 0;
    this._renderedFrame = -1;
    this._ownsDepth = true;
    this._blitScene = null;
    this._terrCenterPending = null;
    this._cand = [];
    this._time = 0;
    this._standalone = true;
    this._extAge = 0;
    this._inUpdate = false;
    this._disposed = false;
    this._ready = false;

    // scene graph bits
    this._quadGeo = null;
    this._marchMat = null;
    this._compositeMat = null;
    this._blitMat = null;
    this._marchScene = null;
    this._marchCam = null;
    this._marchMesh = null;
    this._blitMesh = null;
    this._compositeMesh = null;
    this._depthMat = null;

    // owned textures
    this._noiseTex = null;
    this._blueTex = null;
    this._blueOwned = false;
    this._terrainTex = null;
    this._whiteTex = null;

    // terrain window bake
    this._terrData = null;
    this._terrStaging = null;
    this._terrCenter = new THREE.Vector2(0, 0);
    this._terrPending = false;
    this._terrRow = 0;
    this._terrValid = 0;

    // light bookkeeping
    this._moon = null;
    this._lightScanAge = 999;
    this._depthSkips = [];
    this._skipScanAge = 999;

    // matrices for reprojection
    this._prevViewProj = new THREE.Matrix4();
    this._curViewProj = new THREE.Matrix4();
    this._prevCamPos = new THREE.Vector3();
    this._prevCamDir = new THREE.Vector3(0, 0, -1);

    // weather-driven fog state (smoothed)
    this._fogAmt = 0.5;
    this._fogAmtTarget = 0.5;
    this._rain = 0.15;

    this._uniforms = null;
    this._onWeather = (p) => this._applyWeather(p);
    this._onSettings = (p) => { if (!p || p.key === 'quality' || p.key === '*') this._applyTier(true); };
  }

  // ----------------------------------------------------------------------------- lifecycle

  async init() {
    const ctx = this.ctx;
    const renderer = ctx.renderer;
    if (!renderer) {
      Log.warn('VolumetricFog: no ctx.renderer — disabled.');
      this.enabled = false;
      return;
    }

    try {
      // half-float colour targets are required; without them we cannot store HDR in-scatter
      const caps = renderer.capabilities;
      if (caps && caps.isWebGL2 === false) {
        Log.warn('VolumetricFog: WebGL1 context — running without temporal accumulation.');
        this._historyAmount = 0;
      }
    } catch { /* capabilities are advisory */ }

    this._applyTier(false);
    this._buildTextures();
    this._buildMaterials();
    this._buildScenes();

    const w = ctx.width || 1, h = ctx.height || 1;
    this.resize(w, h);

    this._bakeTerrainWindow(true);

    if (this.bus) {
      this.bus.on('weather:change', this._onWeather);
      this.bus.on('settings:changed', this._onSettings);
    }

    // Decide who composites.  If Postprocessing exists with a render(), assume it drives us.
    const post = ctx.systems?.get?.('Postprocessing');
    this._standalone = !(post && typeof post.render === 'function');
    this._extAge = this._standalone ? 999 : 0;
    this._syncComposite();

    this._ready = true;
    Log.debug(`VolumetricFog: ${this._fw}x${this._fh} @ ${this._steps} steps, `
      + `${this._locals} locals, standalone=${this._standalone}`);
  }

  /** @param {number} dt @param {number} elapsed */
  update(dt, elapsed) {
    if (this._disposed || !this._ready) return;
    const t0 = performance.now();
    this._inUpdate = true;

    this._time = Number.isFinite(elapsed) ? elapsed : this._time + (dt || 0);
    const step = Math.min(Math.max(dt || 0, 0), 0.1);

    // who composites?
    const post = this.ctx.systems?.get?.('Postprocessing');
    const postDrives = !!(post && !post.__failed && typeof post.render === 'function');
    this._extAge++;
    const wantStandalone = !(postDrives && this._extAge < 45);
    if (wantStandalone !== this._standalone) {
      this._standalone = wantStandalone;
      this._syncComposite();
      Log.debug(`VolumetricFog: composite mode -> ${wantStandalone ? 'standalone' : 'external'}`);
    }

    this._tickWeather(step);
    this._tickTerrain(step);

    if (this._standalone) this.render();

    this._inUpdate = false;
    this.stats.cpuMs = performance.now() - t0;
  }

  /**
   * Integrate one frame of the medium into `this.target`.
   * Safe to call from Postprocessing before its composite; safe to call twice (second call in
   * the same frame is ignored).
   */
  render() {
    if (this._disposed || !this._ready) return;
    if (!this._inUpdate) this._extAge = 0;
    if (!this.enabled) return;
    if (this._renderedFrame === this._frame && this._frame !== 0) return;

    const ctx = this.ctx;
    const renderer = ctx.renderer;
    const camera = ctx.camera;
    const scene = ctx.scene;
    if (!renderer || !camera || !scene || !this.target) return;

    try {
      const depthTex = this._acquireDepth();
      this._updateUniforms(depthTex);

      const prevRT = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;
      renderer.autoClear = true;

      // 1) march
      renderer.setRenderTarget(this.target);
      renderer.render(this._marchScene, this._marchCam);

      // 2) history blit (keeps `this.target` a stable object for downstream consumers)
      if (this._historyAmount > 0.001 && this._history) {
        this._blitMat.uniforms.tSrc.value = this.target.texture;
        this._blitMesh.visible = true;
        renderer.setRenderTarget(this._history);
        renderer.render(this._blitScene, this._marchCam);
      }

      renderer.setRenderTarget(prevRT);
      renderer.autoClear = prevAutoClear;

      this._renderedFrame = this._frame;
      this._frame++;
      this._captureHistoryMatrices();
    } catch (e) {
      Log.once('fog:render', 'VolumetricFog.render() threw — disabling volumetrics.', e);
      this.enabled = false;
      this._syncComposite();
    }
  }

  /** @param {number} w @param {number} h — CSS px (the drawing buffer is derived). */
  resize(w, h) {
    if (this._disposed) return;
    const renderer = this.ctx.renderer;
    if (!renderer) return;

    let dw = Math.max(1, Math.round(w || 1));
    let dh = Math.max(1, Math.round(h || 1));
    try {
      renderer.getDrawingBufferSize(_v2);
      if (_v2.x > 0 && _v2.y > 0) { dw = Math.round(_v2.x); dh = Math.round(_v2.y); }
    } catch { /* fall back to CSS px */ }

    this._rw = dw; this._rh = dh;

    // Effective scale = the tier's ask, clamped by the area cap.
    let scale = this._scale;
    const area = dw * dh;
    if (area * scale * scale > this.maxFogPixels) {
      scale = Math.sqrt(this.maxFogPixels / Math.max(area, 1));
    }
    scale = Math.min(1, Math.max(0.15, scale));
    this._effScale = scale;

    const fw = Math.max(8, Math.round(dw * scale));
    const fh = Math.max(8, Math.round(dh * scale));

    // Depth prepass: full drawing buffer, but never past its own cap, and never below the fog.
    let ds = 1;
    if (area > this.maxDepthPixels) ds = Math.sqrt(this.maxDepthPixels / area);
    const pw = Math.max(fw, Math.round(dw * ds));
    const ph = Math.max(fh, Math.round(dh * ds));

    if (fw === this._fw && fh === this._fh && pw === this._dw && ph === this._dh
        && this.target && this._depthRT) return;

    this._fw = fw; this._fh = fh;
    this._dw = pw; this._dh = ph;

    const opts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };

    if (this.target) this.target.dispose();
    this.target = new THREE.WebGLRenderTarget(fw, fh, opts);
    this.target.texture.name = 'VolumetricFog.scatter';

    if (this._history) { this._history.dispose(); this._history = null; }
    if (this._historyAmount > 0.001) {
      this._history = new THREE.WebGLRenderTarget(fw, fh, opts);
      this._history.texture.name = 'VolumetricFog.history';
    }

    this._allocDepthRT(pw, ph);

    if (this._marchMat) {
      this._marchMat.uniforms.tHistory.value = this._history ? this._history.texture : this._whiteTex;
    }
    if (this._compositeMat) {
      this._compositeMat.uniforms.tFog.value = this.target.texture;
      this._compositeMat.uniforms.uFogTexel.value.set(0.5 / fw, 0.5 / fh);
      const up = (fw < dw - 1 || fh < dh - 1) ? 1 : 0;
      if (this._compositeMat.defines.UPSAMPLE !== up) {
        this._compositeMat.defines.UPSAMPLE = up;
        this._compositeMat.needsUpdate = true;
      }
    }

    this.stats.width = fw; this.stats.height = fh; this.stats.scale = scale;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.enabled = false;

    if (this.bus) {
      this.bus.off?.('weather:change', this._onWeather);
      this.bus.off?.('settings:changed', this._onSettings);
    }

    if (this._compositeMesh && this._compositeMesh.parent) {
      this._compositeMesh.parent.remove(this._compositeMesh);
    }

    const kill = (rt) => { if (rt) { rt.depthTexture?.dispose?.(); rt.dispose(); } };
    kill(this.target); this.target = null;
    kill(this._history); this._history = null;
    kill(this._depthRT); this._depthRT = null;

    this._quadGeo?.dispose?.(); this._quadGeo = null;
    this._marchMat?.dispose?.(); this._marchMat = null;
    this._compositeMat?.dispose?.(); this._compositeMat = null;
    this._blitMat?.dispose?.(); this._blitMat = null;
    this._depthMat?.dispose?.(); this._depthMat = null;

    this._noiseTex?.dispose?.(); this._noiseTex = null;
    this._terrainTex?.dispose?.(); this._terrainTex = null;
    this._whiteTex?.dispose?.(); this._whiteTex = null;
    if (this._blueOwned) this._blueTex?.dispose?.();
    this._blueTex = null;

    this._marchScene = null; this._blitScene = null; this._marchCam = null;
    this._marchMesh = null; this._blitMesh = null; this._compositeMesh = null;
    this._terrData = null; this._terrStaging = null;
    this._moon = null; this._depthSkips.length = 0;
    this._uniforms = null;
    this._ready = false;
  }

  // ----------------------------------------------------------------------------- accessors

  /** @returns {THREE.Texture|null} */
  get texture() { return this.target ? this.target.texture : null; }

  /** The depth this module owns (null when borrowing Postprocessing's). */
  get depthTexture() { return this._ownsDepth ? (this._depthRT?.depthTexture ?? null) : null; }

  /** True when this module is compositing itself into the main framebuffer. */
  get standalone() { return this._standalone; }

  get resolutionScale() { return this._scale; }
  set resolutionScale(v) {
    const s = Math.min(1, Math.max(0.2, Number(v) || 0.5));
    if (Math.abs(s - this._scale) < 1e-3) return;
    this._scale = s;
    this._fw = -1;
    this.resize(this.ctx.width || this._rw, this.ctx.height || this._rh);
  }

  /** Hard on/off. @param {boolean} v */
  setEnabled(v) {
    this.enabled = !!v;
    this._syncComposite();
  }

  // ----------------------------------------------------------------------------- tiers

  _applyTier(rebuild) {
    const s = this.ctx.settings;
    const tier = (l, m, h, u) => (s && typeof s.tier === 'function' ? s.tier(l, m, h, u) : h);

    this._scale = tier(0.25, 0.5, 0.5, 1.0);
    this._steps = tier(16, 24, 40, 64);
    this._locals = tier(1, 2, 3, 3);
    this._historyAmount = tier(0.0, 0.82, 0.88, 0.92);

    this.stats.steps = this._steps;
    this.stats.scale = this._scale;

    if (rebuild && this._marchMat) {
      this._marchMat.defines.STEPS = this._steps;
      this._marchMat.defines.LOCALS = Math.max(1, this._locals);
      this._marchMat.needsUpdate = true;
      this._rebuildLocalUniformArrays();
      this._fw = -1;
      this.resize(this.ctx.width || this._rw, this.ctx.height || this._rh);
    }
  }

  _rebuildLocalUniformArrays() {
    const n = Math.max(1, this._locals);
    const u = this._marchMat?.uniforms;
    if (!u) return;
    const grow = (arr, make) => {
      while (arr.length < n) arr.push(make());
      arr.length = n;
    };
    grow(u.uLocalPos.value, () => new THREE.Vector3());
    grow(u.uLocalColor.value, () => new THREE.Vector3());
    grow(u.uLocalDir.value, () => new THREE.Vector3(0, -1, 0));
    grow(u.uLocalParams.value, () => new THREE.Vector4(0, 0, 0, 0));
  }

  // ----------------------------------------------------------------------------- resources

  _buildTextures() {
    // ---- 1x1 white, used as a stand-in for every optional sampler
    const wd = new Uint8Array([255, 255, 255, 255]);
    this._whiteTex = new THREE.DataTexture(wd, 1, 1, THREE.RGBAFormat);
    this._whiteTex.needsUpdate = true;

    // ---- tiling multi-octave value noise (fog structure + rain streaks)
    this._noiseTex = this._makeNoiseTexture(NOISE_TEX);

    // ---- blue noise: prefer the shared one from the texture bakery
    const tex = this.ctx.systems?.get?.('Textures');
    let bn = null;
    try { bn = tex?.blueNoise ?? null; } catch { bn = null; }
    if (bn && bn.image) {
      this._blueTex = bn;
      this._blueOwned = false;
    } else {
      this._blueTex = this._makeFallbackBlueNoise(64);
      this._blueOwned = true;
    }

    // ---- terrain / mist-floor window
    this._terrData = new Float32Array(TERRAIN_TEX * TERRAIN_TEX * 4);
    this._terrStaging = new Float32Array(TERRAIN_TEX * TERRAIN_TEX * 4);
    for (let i = 0; i < this._terrData.length; i += 4) {
      this._terrData[i] = 0; this._terrData[i + 1] = 0;
      this._terrData[i + 2] = 0.5; this._terrData[i + 3] = 1;
    }
    this._terrainTex = new THREE.DataTexture(
      this._terrData, TERRAIN_TEX, TERRAIN_TEX, THREE.RGBAFormat, THREE.FloatType,
    );
    this._terrainTex.minFilter = THREE.LinearFilter;
    this._terrainTex.magFilter = THREE.LinearFilter;
    this._terrainTex.wrapS = THREE.ClampToEdgeWrapping;
    this._terrainTex.wrapT = THREE.ClampToEdgeWrapping;
    this._terrainTex.generateMipmaps = false;
    this._terrainTex.needsUpdate = true;
  }

  /**
   * Tileable value noise, 4 octaves in 4 channels.  Deterministic — driven by ctx.rand when it
   * exists, otherwise by an internal integer hash.  No Math.random anywhere.
   */
  _makeNoiseTexture(size) {
    const rand = this.ctx.rand;
    const seedInt = (this.ctx.settings?.get?.('seed') ?? 0x51A5CAB) | 0;
    let state = (seedInt ^ 0x9E3779B9) >>> 0;
    const nextf = () => {
      if (rand && typeof rand.next === 'function') return rand.next();
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };

    const lattices = [4, 8, 16, 2];
    const grids = lattices.map((L) => {
      const g = new Float32Array(L * L);
      for (let i = 0; i < g.length; i++) g[i] = nextf();
      return g;
    });

    const smooth = (t) => t * t * (3 - 2 * t);
    const sample = (g, L, u, v) => {
      const fx = u * L, fz = v * L;
      const ix = Math.floor(fx), iz = Math.floor(fz);
      const tx = smooth(fx - ix), tz = smooth(fz - iz);
      const x0 = ((ix % L) + L) % L, x1 = (x0 + 1) % L;
      const z0 = ((iz % L) + L) % L, z1 = (z0 + 1) % L;
      const a = g[z0 * L + x0] + (g[z0 * L + x1] - g[z0 * L + x0]) * tx;
      const b = g[z1 * L + x0] + (g[z1 * L + x1] - g[z1 * L + x0]) * tx;
      return a + (b - a) * tz;
    };

    const data = new Uint8Array(size * size * 4);
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        const u = x / size, v = z / size;
        // R: two octaves of the big lattice — the drifting fog banks
        let r = sample(grids[0], lattices[0], u, v) * 0.68
              + sample(grids[1], lattices[1], u, v) * 0.32;
        // G: finer structure for the second density layer
        let g = sample(grids[1], lattices[1], u, v) * 0.6
              + sample(grids[2], lattices[2], u, v) * 0.4;
        // B: high frequency — rain streaks read off this one
        let b = sample(grids[2], lattices[2], u, v);
        // A: very low frequency — reserved
        let a = sample(grids[3], lattices[3], u, v);
        const i = (z * size + x) * 4;
        data[i] = Math.max(0, Math.min(255, (r * 255) | 0));
        data[i + 1] = Math.max(0, Math.min(255, (g * 255) | 0));
        data[i + 2] = Math.max(0, Math.min(255, (b * 255) | 0));
        data[i + 3] = Math.max(0, Math.min(255, (a * 255) | 0));
      }
    }

    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    t.name = 'VolumetricFog.noise';
    return t;
  }

  /** Cheap void-and-cluster-ish fallback if Textures is missing.  Deterministic. */
  _makeFallbackBlueNoise(size) {
    const seedInt = (this.ctx.settings?.get?.('seed') ?? 0x51A5CAB) | 0;
    let state = (seedInt ^ 0x2545F491) >>> 0;
    const nextf = () => {
      state ^= state << 13; state >>>= 0;
      state ^= state >> 17;
      state ^= state << 5; state >>>= 0;
      return state / 4294967296;
    };
    const n = size * size;
    const vals = new Float32Array(n);
    for (let i = 0; i < n; i++) vals[i] = nextf();
    // A few relaxation passes push the spectrum toward blue: subtract the local mean.
    const tmp = new Float32Array(n);
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          let s = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const xx = (x + dx + size) % size, yy = (y + dy + size) % size;
              s += vals[yy * size + xx];
            }
          }
          tmp[y * size + x] = vals[y * size + x] - (s / 9 - 0.5) * 0.85;
        }
      }
      vals.set(tmp);
    }
    // rank-normalise to a flat histogram
    const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => vals[a] - vals[b]);
    const data = new Uint8Array(n * 4);
    for (let r = 0; r < n; r++) {
      const v = Math.min(255, ((r / n) * 256) | 0);
      const i = idx[r] * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    t.name = 'VolumetricFog.blueNoiseFallback';
    return t;
  }

  _buildMaterials() {
    const n = Math.max(1, this._locals);
    const localPos = []; const localCol = []; const localDir = []; const localPar = [];
    for (let i = 0; i < n; i++) {
      localPos.push(new THREE.Vector3());
      localCol.push(new THREE.Vector3());
      localDir.push(new THREE.Vector3(0, -1, 0));
      localPar.push(new THREE.Vector4(0, 0, 0, 0));
    }

    const u = {
      tDepth: { value: this._whiteTex },
      tNoise: { value: this._noiseTex },
      tBlue: { value: this._blueTex },
      tTerrain: { value: this._terrainTex },
      tHistory: { value: this._whiteTex },
      tMoonShadow: { value: this._whiteTex },
      tLampShadow: { value: this._whiteTex },

      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uNearFar: { value: new THREE.Vector2(0.05, 1200) },
      uFrame: { value: 0 },
      uTime: { value: 0 },
      uRevDepth: { value: 0 },
      uHistoryAmount: { value: this._historyAmount },
      uBlueSize: { value: 128 },

      uFogA: { value: new THREE.Vector4(0.016, -1.0, 1 / 4.4, 150) },
      uFogB: { value: new THREE.Vector4(0.62, 0.92, 1.15, 0.55) },
      uFogNear: { value: new THREE.Vector3() },
      uFogFar: { value: new THREE.Vector3() },
      uFogLit: { value: new THREE.Vector3() },

      uMist: { value: new THREE.Vector4(0.72, 0.52, 0.30, 0.42) },
      uNoiseCfg: { value: new THREE.Vector4(0.0125, 0.045, 0.95, 2.2) },
      uDriftA: { value: new THREE.Vector2() },
      uDriftB: { value: new THREE.Vector2() },

      uTerrainOrigin: { value: new THREE.Vector3(0, 0, 0) },
      uTerrainSpan: { value: TERRAIN_SPAN },

      uMoonDir: { value: new THREE.Vector3(0.794, 0.438, 0.421) },
      uMoonColor: { value: new THREE.Vector3(0, 0, 0) },
      uMoonShadowMat: { value: new THREE.Matrix4() },
      uMoonShadowCfg: { value: new THREE.Vector2(0, 0.0008) },

      uLampPos: { value: new THREE.Vector3() },
      uLampDir: { value: new THREE.Vector3(0, 0, -1) },
      uLampColor: { value: new THREE.Vector3(0, 0, 0) },
      uLampCone: { value: new THREE.Vector4(0.9, 0.95, 14, 0) },
      uLampShadowMat: { value: new THREE.Matrix4() },
      uLampShadowCfg: { value: new THREE.Vector2(0, 0.0015) },

      uLocalPos: { value: localPos },
      uLocalColor: { value: localCol },
      uLocalDir: { value: localDir },
      uLocalParams: { value: localPar },

      uWeather: { value: new THREE.Vector4(0.15, 0.3, 0, 0) },
      uPlayerPos: { value: new THREE.Vector3(0, 1.7, 0) },
    };

    // colour defaults (linear working space; THREE.Color converts from sRGB for us)
    _col.setHex(PAL.near); u.uFogNear.value.set(_col.r, _col.g, _col.b);
    _col.setHex(PAL.far); u.uFogFar.value.set(_col.r, _col.g, _col.b);
    _col.setHex(PAL.lit); u.uFogLit.value.set(_col.r, _col.g, _col.b);

    this._uniforms = u;

    this._marchMat = new THREE.ShaderMaterial({
      name: 'VolumetricFog.march',
      defines: { STEPS: this._steps, LOCALS: n },
      uniforms: u,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: MARCH_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    this._compositeMat = new THREE.ShaderMaterial({
      name: 'VolumetricFog.composite',
      defines: { UPSAMPLE: this._scale < 0.999 ? 1 : 0 },
      uniforms: {
        tFog: { value: null },
        tDepth: { value: this._whiteTex },
        uFogTexel: { value: new THREE.Vector2(0.001, 0.001) },
        uNearFar: { value: new THREE.Vector2(0.05, 1200) },
        uRevDepth: { value: 0 },
        uIntensity: { value: 1 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      toneMapped: true,
      // result = inScatter + scene * transmittance
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.SrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });

    this._blitMat = new THREE.ShaderMaterial({
      name: 'VolumetricFog.blit',
      uniforms: { tSrc: { value: null } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BLIT_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    this._depthMat = new THREE.MeshBasicMaterial({ colorWrite: false });
    this._depthMat.name = 'VolumetricFog.depthPrepass';
  }

  _buildScenes() {
    this._quadGeo = new THREE.PlaneGeometry(2, 2);
    this._marchCam = new THREE.Camera();

    this._marchScene = new THREE.Scene();
    this._marchMesh = new THREE.Mesh(this._quadGeo, this._marchMat);
    this._marchMesh.frustumCulled = false;
    this._marchScene.add(this._marchMesh);

    this._blitScene = new THREE.Scene();
    this._blitMesh = new THREE.Mesh(this._quadGeo, this._blitMat);
    this._blitMesh.frustumCulled = false;
    this._blitScene.add(this._blitMesh);

    this._compositeMesh = new THREE.Mesh(this._quadGeo, this._compositeMat);
    this._compositeMesh.frustumCulled = false;
    this._compositeMesh.renderOrder = 10000;
    this._compositeMesh.name = 'VolumetricFogComposite';
    this._compositeMesh.matrixAutoUpdate = false;
    this._compositeMesh.userData.fogSkipDepth = true;
  }

  _allocDepthRT(w, h) {
    if (this._depthRT) { this._depthRT.depthTexture?.dispose?.(); this._depthRT.dispose(); }
    const rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    rt.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    rt.depthTexture.format = THREE.DepthFormat;
    rt.depthTexture.minFilter = THREE.NearestFilter;
    rt.depthTexture.magFilter = THREE.NearestFilter;
    rt.texture.name = 'VolumetricFog.depthColour';
    this._depthRT = rt;
  }

  /** Attach or detach the standalone fullscreen composite. */
  _syncComposite() {
    const mesh = this._compositeMesh;
    const scene = this.ctx.scene;
    if (!mesh || !scene) return;
    const want = this.enabled && this._standalone && !this._disposed;
    if (want && mesh.parent !== scene) scene.add(mesh);
    if (!want && mesh.parent) mesh.parent.remove(mesh);
    mesh.visible = want;
  }

  // ----------------------------------------------------------------------------- depth

  /**
   * Prefer Postprocessing's depth (free).  Otherwise render our own prepass with an override
   * material.  Shadow-map updating is suspended during the prepass so we do not pay for the
   * shadow pass twice — the override material is unlit and does not read them anyway.
   */
  _acquireDepth() {
    const post = this.ctx.systems?.get?.('Postprocessing');
    const ext = post && !post.__failed ? post.depthTexture : null;
    if (ext && ext.isTexture) {
      this._ownsDepth = false;
      return ext;
    }
    this._ownsDepth = true;
    this._renderDepthPrepass();
    return this._depthRT ? this._depthRT.depthTexture : this._whiteTex;
  }

  _renderDepthPrepass() {
    const { renderer, scene, camera } = this.ctx;
    if (!renderer || !scene || !camera || !this._depthRT) return;

    this._skipScanAge++;
    if (this._skipScanAge > 30) { this._collectDepthSkips(); this._skipScanAge = 0; }

    const prevRT = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevBg = scene.background;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevAutoClear = renderer.autoClear;

    const skips = this._depthSkips;
    for (let i = 0; i < skips.length; i++) skips[i].visible = false;
    if (this._compositeMesh) this._compositeMesh.visible = false;

    scene.overrideMaterial = this._depthMat;
    scene.background = null;
    renderer.shadowMap.autoUpdate = false;
    renderer.autoClear = true;

    try {
      renderer.setRenderTarget(this._depthRT);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
    } catch (e) {
      Log.once('fog:depth', 'VolumetricFog: depth prepass failed.', e);
    }

    renderer.setRenderTarget(prevRT);
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.autoClear = prevAutoClear;

    for (let i = 0; i < skips.length; i++) skips[i].visible = true;
    this._syncComposite();
  }

  /**
   * Objects that must not contribute to the depth prepass: sky domes, particle sheets, anything
   * that has opted out of depth writes.  Refreshed occasionally, not every frame.
   */
  _collectDepthSkips() {
    const scene = this.ctx.scene;
    const out = this._depthSkips;
    out.length = 0;
    if (!scene) return;
    scene.traverse((o) => {
      if (!o.visible) return;
      if (o === this._compositeMesh) return;
      const ud = o.userData;
      if (ud && (ud.fogSkipDepth || ud.isSky || ud.skipDepth)) { out.push(o); return; }
      const m = o.material;
      if (!m) return;
      const one = Array.isArray(m) ? m[0] : m;
      if (one && one.depthWrite === false && (o.isMesh || o.isPoints || o.isLine)) out.push(o);
    });
  }

  // ----------------------------------------------------------------------------- weather

  _applyWeather(p) {
    if (!p) return;
    if (Number.isFinite(p.fog)) this._fogAmtTarget = Math.min(1, Math.max(0, p.fog));
    if (Number.isFinite(p.rain)) this._rain = Math.min(1, Math.max(0, p.rain));
  }

  _tickWeather(dt) {
    const weather = this.ctx.systems?.get?.('Weather');
    if (weather && Number.isFinite(weather.fog)) this._fogAmtTarget = Math.min(1, Math.max(0, weather.fog));

    const g = this._globals();
    if (g && Number.isFinite(g.uRain?.value)) this._rain = g.uRain.value;
    else if (weather && Number.isFinite(weather.rain)) this._rain = weather.rain;

    // 2 s time constant so a weather:change does not snap the whole medium
    const k = 1 - Math.exp(-dt / 2.0);
    this._fogAmt += (this._fogAmtTarget - this._fogAmt) * k;
  }

  /** @returns {any} Materials.globalUniforms, or null. */
  _globals() {
    const m = this.ctx.systems?.get?.('Materials');
    const g = m && m.globalUniforms;
    return g && typeof g === 'object' ? g : null;
  }

  // ----------------------------------------------------------------------------- terrain

  _tickTerrain() {
    const terrain = this.ctx.systems?.get?.('Terrain');
    if (!terrain || typeof terrain.heightAt !== 'function') return;

    if (!this._terrPending) {
      const p = this._playerPos(_v3a);
      const dx = p.x - this._terrCenter.x;
      const dz = p.z - this._terrCenter.y;
      if (this._terrValid === 0 || dx * dx + dz * dz > TERRAIN_RECENTER * TERRAIN_RECENTER) {
        this._terrCenterPending = { x: p.x, z: p.z };
        this._terrPending = true;
        this._terrRow = 0;
      }
    }

    if (this._terrPending) this._bakeTerrainRows(TERRAIN_ROWS_PER_FRAME);
  }

  _bakeTerrainWindow(sync) {
    const terrain = this.ctx.systems?.get?.('Terrain');
    if (!terrain || typeof terrain.heightAt !== 'function') return;
    const p = this._playerPos(_v3a);
    this._terrCenterPending = { x: p.x, z: p.z };
    this._terrPending = true;
    this._terrRow = 0;
    if (sync) this._bakeTerrainRows(TERRAIN_TEX);
  }

  _bakeTerrainRows(rows) {
    const terrain = this.ctx.systems?.get?.('Terrain');
    if (!terrain || typeof terrain.heightAt !== 'function') { this._terrPending = false; return; }

    const N = TERRAIN_TEX;
    const S = TERRAIN_SPAN;
    const c = this._terrCenterPending || { x: 0, z: 0 };
    const stg = this._terrStaging;
    const waterLevel = Number.isFinite(terrain.waterLevel) ? terrain.waterLevel : 0;

    const pad = terrain.buildSiteCenter;
    const padX = pad && Number.isFinite(pad.x) ? pad.x : 1e9;
    const padZ = pad && Number.isFinite(pad.z) ? pad.z : 1e9;
    const padR = 16;

    const step = S / (N - 1);
    const end = Math.min(N, this._terrRow + rows);

    for (let j = this._terrRow; j < end; j++) {
      const z = c.z - S * 0.5 + j * step;
      for (let i = 0; i < N; i++) {
        const x = c.x - S * 0.5 + i * step;
        const h = terrain.heightAt(x, z);
        const isWater = h <= waterLevel + 0.05;
        const floorY = isWater ? waterLevel : h;

        // pooling: hollow if the neighbourhood mean sits above us
        const hm = 0.25 * (terrain.heightAt(x + 7, z) + terrain.heightAt(x - 7, z)
          + terrain.heightAt(x, z + 7) + terrain.heightAt(x, z - 7));
        let pool = 0.5 + (hm - h) * 0.30;
        pool = pool < 0 ? 0 : (pool > 1 ? 1 : pool);

        // density multiplier: heavier on water (ART x1.6), heaviest in the cold excavation
        let mult = isWater ? 1.75 : 1.0;
        const ddx = x - padX, ddz = z - padZ;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 < padR * padR) {
          const f = 1 - Math.sqrt(d2) / padR;
          mult *= 1 + 1.2 * f * f;
        }

        const o = (j * N + i) * 4;
        stg[o] = floorY;
        stg[o + 1] = isWater ? 1 : 0;
        stg[o + 2] = pool;
        stg[o + 3] = mult;
      }
    }

    this._terrRow = end;
    if (this._terrRow >= N) {
      this._terrData.set(stg);
      this._terrainTex.needsUpdate = true;
      this._terrCenter.set(c.x, c.z);
      this._terrValid = 1;
      this._terrPending = false;
    }
  }

  _playerPos(out) {
    const pl = this.ctx.systems?.get?.('Player');
    if (pl && pl.position && Number.isFinite(pl.position.x)) return out.copy(pl.position);
    const g = this._globals();
    if (g && g.uPlayerPos && Number.isFinite(g.uPlayerPos.value?.x)) return out.copy(g.uPlayerPos.value);
    if (this.ctx.camera) return out.copy(this.ctx.camera.position);
    return out.set(0, 1.7, 0);
  }

  // ----------------------------------------------------------------------------- uniforms

  _updateUniforms(depthTex) {
    const u = this._uniforms;
    const ctx = this.ctx;
    const camera = ctx.camera;
    const g = this._globals();

    u.tDepth.value = depthTex || this._whiteTex;
    u.tHistory.value = this._history ? this._history.texture : this._whiteTex;
    u.tBlue.value = this._blueTex || this._whiteTex;
    u.uBlueSize.value = this._blueTex?.image?.width || 128;

    // ---- camera
    camera.updateMatrixWorld();
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(camera.matrixWorld);
    u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    u.uNearFar.value.set(camera.near, camera.far);
    u.uPrevViewProj.value.copy(this._prevViewProj);

    let reversed = 0;
    try {
      reversed = ctx.renderer.state?.buffers?.depth?.getReversed?.() ? 1 : 0;
    } catch { reversed = 0; }
    u.uRevDepth.value = reversed;

    // ---- weather / time
    const rain = this._rain;
    const lightning = g?.uLightning?.value ?? 0;
    const wetness = g?.uWetness?.value ?? 0.3;
    const nightPhase = g?.uNightPhase?.value
      ?? (Number.isFinite(ctx.state?.timeOfNight) ? ctx.state.timeOfNight : 0);
    u.uWeather.value.set(rain, wetness, lightning, nightPhase);
    u.uTime.value = this._time;
    u.uFrame.value = this._frame % 4096;
    this._playerPos(u.uPlayerPos.value);

    // ---- density profile from the weather state (ART_DIRECTION §5.1)
    const P = this.params;
    const f = this._fogAmt;
    const density = (P.density + f * 0.052 + rain * 0.013) * (1 + lightning * 0.15);
    const H = P.scaleHeight + f * 9.0 + rain * 1.4;
    u.uFogA.value.set(density, P.floorY, 1 / Math.max(H, 0.5), P.maxDistance);

    // thick fog multiply-scatters and loses its forward lobe — that is why a whiteout has no
    // visible shafts (ART §5.3).  g goes 0.62 -> 0.38 as the medium thickens.
    const hg = Math.max(0.05, Math.min(0.9, P.hg - f * 0.24));
    u.uFogB.value.set(hg, P.albedo, P.ambient * (0.75 + f * 0.9), P.mistTint);

    // colours: thicker fog lifts and cools, dawn warms.  No allocation — two module scratches.
    const dawn = Math.min(1, Math.max(0, (nightPhase - 0.85) / 0.15));
    _col.setHex(PAL.near);
    _colB.setHex(PAL.nearThick);
    _col.lerp(_colB, f);
    if (dawn > 0) { _colB.setHex(PAL.dawnNear); _col.lerp(_colB, dawn); }
    u.uFogNear.value.set(_col.r, _col.g, _col.b);

    _col.setHex(PAL.far);
    _colB.setHex(PAL.farThick);
    _col.lerp(_colB, f);
    if (dawn > 0) { _colB.setHex(PAL.dawnFar); _col.lerp(_colB, dawn); }
    u.uFogFar.value.set(_col.r, _col.g, _col.b);

    _col.setHex(PAL.lit);
    u.uFogLit.value.set(_col.r, _col.g, _col.b);

    // ---- ground mist
    u.uMist.value.set(
      P.mistTop * (0.85 + f * 0.9),
      P.mistFeather * (1 + f * 0.7),
      P.mistDensity * (0.55 + f * 1.15) * (1 + rain * 0.35),
      P.mistWobble,
    );

    // ---- noise drift with the wind
    const wind = g?.uWind?.value;
    const wx = wind && Number.isFinite(wind.x) ? wind.x : 0.7;
    const wz = wind && Number.isFinite(wind.z) ? wind.z : 0.35;
    const t = this._time;
    u.uDriftA.value.set(-wx * t * 0.0016, -wz * t * 0.0016);
    u.uDriftB.value.set(-wx * t * 0.0052 + 0.37, -wz * t * 0.0052 - 0.19);
    u.uNoiseCfg.value.set(0.0125, 0.047, P.noiseContrast, P.rainStreak);

    // ---- terrain window
    u.uTerrainOrigin.value.set(this._terrCenter.x, this._terrValid, this._terrCenter.y);
    u.uTerrainSpan.value = TERRAIN_SPAN;

    // ---- lights
    this._lightScanAge++;
    if (this._lightScanAge > 20) { this._findMoon(); this._lightScanAge = 0; }
    this._updateMoon(u, g);
    this._updateLantern(u);
    this._updateLocals(u);

    // ---- temporal
    let hist = this._history ? this._historyAmount : 0;
    if (hist > 0) {
      // Fast rotation invalidates most of the history; ease it out rather than smear.
      camera.getWorldDirection(_v3b);
      const dot = Math.max(-1, Math.min(1, _v3b.dot(this._prevCamDir)));
      const ang = Math.acos(dot);
      const move = _v3a.copy(u.uCamPos.value).sub(this._prevCamPos).length();
      hist *= Math.exp(-ang * 3.2) * Math.exp(-move * 0.35);
    }
    u.uHistoryAmount.value = this._frame < 2 ? 0 : hist;

    // ---- composite uniforms
    if (this._compositeMat) {
      const cu = this._compositeMat.uniforms;
      cu.tFog.value = this.target ? this.target.texture : null;
      cu.tDepth.value = depthTex || this._whiteTex;
      cu.uNearFar.value.set(camera.near, camera.far);
      cu.uRevDepth.value = reversed;
      cu.uFogTexel.value.set(0.5 / Math.max(1, this._fw), 0.5 / Math.max(1, this._fh));
    }
  }

  _captureHistoryMatrices() {
    const camera = this.ctx.camera;
    if (!camera) return;
    this._prevViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._prevCamPos.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(this._prevCamDir);
  }

  _findMoon() {
    const sky = this.ctx.systems?.get?.('Sky');
    let moon = null;
    for (const key of ['moonLight', 'moon', 'light', 'directional']) {
      const c = sky ? sky[key] : null;
      if (c && c.isDirectionalLight) { moon = c; break; }
    }
    if (!moon) {
      let best = -1;
      this.ctx.scene?.traverse?.((o) => {
        if (!o.isDirectionalLight || !o.visible) return;
        const score = (o.castShadow ? 1000 : 1) * Math.max(o.intensity, 0.0001);
        if (score > best) { best = score; moon = o; }
      });
    }
    this._moon = moon;
  }

  _updateMoon(u, g) {
    const moon = this._moon;
    const P = this.params;

    if (moon && moon.visible && moon.intensity > 0) {
      moon.updateMatrixWorld();
      _v3a.setFromMatrixPosition(moon.matrixWorld);
      if (moon.target) { moon.target.updateMatrixWorld(); _v3b.setFromMatrixPosition(moon.target.matrixWorld); }
      else _v3b.set(0, 0, 0);
      _v3a.sub(_v3b);
      if (_v3a.lengthSq() < 1e-8) _v3a.set(0.794, 0.438, 0.421);
      _v3a.normalize();
      u.uMoonDir.value.copy(_v3a);

      const s = moon.intensity * P.moonScatter;
      u.uMoonColor.value.set(moon.color.r * s, moon.color.g * s, moon.color.b * s);

      const sm = moon.shadow;
      const map = sm && sm.map;
      const dtex = map && map.depthTexture;
      const usable = !!(moon.castShadow && dtex && !dtex.compareFunction);
      if (usable) {
        u.tMoonShadow.value = dtex;
        u.uMoonShadowMat.value.copy(sm.matrix);
        u.uMoonShadowCfg.value.set(1, Math.abs(sm.bias || 0) + 0.0009);
      } else {
        u.tMoonShadow.value = this._whiteTex;
        u.uMoonShadowCfg.value.set(0, 0.001);
      }
    } else {
      // No moon light in the scene yet — keep a faint sky direction so the phase term is sane.
      const md = g?.uMoonDir?.value;
      if (md && Number.isFinite(md.x)) u.uMoonDir.value.copy(md);
      u.uMoonColor.value.set(0, 0, 0);
      u.tMoonShadow.value = this._whiteTex;
      u.uMoonShadowCfg.value.set(0, 0.001);
    }
  }

  _updateLantern(u) {
    const lamp = this.ctx.systems?.get?.('Flashlight');
    const light = lamp && lamp.light;
    const P = this.params;

    if (light && light.isSpotLight && light.visible && light.intensity > 0) {
      light.updateMatrixWorld();
      u.uLampPos.value.setFromMatrixPosition(light.matrixWorld);
      if (light.target) {
        light.target.updateMatrixWorld();
        _v3a.setFromMatrixPosition(light.target.matrixWorld);
      } else _v3a.set(0, 0, 0);
      _v3b.copy(_v3a).sub(u.uLampPos.value);
      if (_v3b.lengthSq() < 1e-8) _v3b.set(0, 0, -1);
      u.uLampDir.value.copy(_v3b.normalize());

      const s = light.intensity * P.lanternScatter;
      u.uLampColor.value.set(light.color.r * s, light.color.g * s, light.color.b * s);

      const cosOuter = Math.cos(light.angle);
      const cosInner = Math.cos(light.angle * (1 - (light.penumbra ?? 0)));
      const range = light.distance > 0 ? light.distance : 24;
      u.uLampCone.value.set(cosOuter, Math.max(cosInner, cosOuter + 1e-4), range, 0);

      const sm = light.shadow;
      const map = sm && sm.map;
      const dtex = map && map.depthTexture;
      const usable = !!(light.castShadow && dtex && !dtex.compareFunction);
      if (usable) {
        u.tLampShadow.value = dtex;
        u.uLampShadowMat.value.copy(sm.matrix);
        u.uLampShadowCfg.value.set(1, Math.abs(sm.bias || 0) + 0.0016);
      } else {
        u.tLampShadow.value = this._whiteTex;
        u.uLampShadowCfg.value.set(0, 0.002);
      }
    } else {
      u.uLampColor.value.set(0, 0, 0);
      u.uLampCone.value.set(1, 1, 0, 0);
      u.tLampShadow.value = this._whiteTex;
      u.uLampShadowCfg.value.set(0, 0.002);
    }
  }

  _updateLocals(u) {
    const n = Math.max(1, this._locals);
    const P = this.params;
    const camPos = u.uCamPos.value;

    // gather candidates without allocating: reuse a persistent array
    if (!this._cand) this._cand = [];
    const cand = this._cand;
    cand.length = 0;

    const push = (l) => {
      if (!l) return;
      const light = l.isLight ? l : (l.light && l.light.isLight ? l.light : null);
      if (!light || !light.visible || !(light.intensity > 0)) return;
      if (!(light.isSpotLight || light.isPointLight)) return;
      if (cand.length < 24) cand.push(light);
    };

    const props = this.ctx.systems?.get?.('Props');
    const pl = props && props.lights;
    if (Array.isArray(pl)) { for (let i = 0; i < pl.length; i++) push(pl[i]); }

    const site = this.ctx.systems?.get?.('CabinSite');
    if (site) { push(site.lantern); push(site.light); }

    const campers = this.ctx.systems?.get?.('Campers');
    const agents = campers && campers.agents;
    if (Array.isArray(agents)) {
      for (let i = 0; i < agents.length && cand.length < 24; i++) push(agents[i]?.torch ?? agents[i]?.light);
    }

    // score by intensity / (1 + d^2) — the same rule Materials.assignLights uses
    for (let i = 0; i < cand.length; i++) {
      const l = cand[i];
      l.updateMatrixWorld();
      _v3a.setFromMatrixPosition(l.matrixWorld);
      cand[i].__fogScore = l.intensity / (1 + _v3a.distanceToSquared(camPos));
    }
    cand.sort((a, b) => b.__fogScore - a.__fogScore);

    for (let k = 0; k < n; k++) {
      const par = u.uLocalParams.value[k];
      const l = cand[k];
      if (!l) { par.set(0, 0, 0, 0); u.uLocalColor.value[k].set(0, 0, 0); continue; }

      u.uLocalPos.value[k].setFromMatrixPosition(l.matrixWorld);
      const s = l.intensity * P.localScatter;
      u.uLocalColor.value[k].set(l.color.r * s, l.color.g * s, l.color.b * s);

      const range = l.distance > 0 ? l.distance : 16;
      if (l.isSpotLight) {
        if (l.target) { l.target.updateMatrixWorld(); _v3a.setFromMatrixPosition(l.target.matrixWorld); }
        else _v3a.set(0, 0, 0);
        _v3b.copy(_v3a).sub(u.uLocalPos.value[k]);
        if (_v3b.lengthSq() < 1e-8) _v3b.set(0, -1, 0);
        u.uLocalDir.value[k].copy(_v3b.normalize());
        const co = Math.cos(l.angle);
        const ci = Math.cos(l.angle * (1 - (l.penumbra ?? 0)));
        par.set(co, Math.max(ci, co + 1e-4), range, 1);
      } else {
        u.uLocalDir.value[k].set(0, -1, 0);
        par.set(-1, -0.999, range, 0);
      }
    }
  }
}

export default VolumetricFog;
