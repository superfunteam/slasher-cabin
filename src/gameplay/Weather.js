/**
 * Weather — rain, wind, storm fronts, lightning, and the thunder-masking schedule.
 *
 * OWNER: Director agent. File: src/gameplay/Weather.js
 *
 * Weather is not decoration. Every output here is consumed by a gameplay system:
 *
 *   rain      -> maskFloor (NoiseSystem), Mw creak stress (BuildSystem), ground `mud` (Terrain),
 *                surface wetness (Materials), visibility (VolumetricFog)
 *   wind      -> Mw creak stress, the ambient noise floor, foliage motion, lantern gutter
 *   gusts     -> three consequences, all wired below: trees bend (uWind/uWindGust), the lantern
 *                gutters (gustAt(position)), the frame is loaded (windLoad -> BuildSystem's Mw),
 *                and the noise floor rises (maskLevel gust term)
 *   lightning -> Sky.flash(), uLightning, camper flashMark (GAME_DESIGN §9.4), and the masking
 *                window that follows the roll
 *
 * ---------------------------------------------------------------------------------------------
 * CANON NOTE — READ BEFORE "FIXING" THE NIGHT TABLE
 * ---------------------------------------------------------------------------------------------
 * Two documents in this repository disagree about which night is the storm.
 *
 *   STORY.md §5 ("THE WEATHER SCHEDULE") + src/story/Script.js weatherProfile:
 *       NIGHT 5 is the storm (rain 0.70 / wind 0.75 / 6 strikes).
 *       NIGHT 6 is dead air (rain 0.00 / wind 0.20 / gust amp 0.04 / period 90 s / fog 0.80).
 *   GAME_DESIGN.md §0.2 conflict C2 + §7.5:
 *       Night 6 is the storm, Night 5 is the whiteout.
 *
 * This file follows STORY.md, for four reasons:
 *   1. GAME_DESIGN §0.1 ranks STORY.md above itself and says, verbatim, that it is subordinate to
 *      STORY.md on night content. Which weather falls on which night is night content.
 *   2. STORY.md §5 is the only document that specifies gust amplitude and gust period, i.e. it is
 *      the only one that actually specifies a wind *model* rather than a wind *number*.
 *   3. STORY.md §5 addresses this file by name: "Weather.js must not treat 0.20 as 'light breeze'
 *      and generate ordinary gust structure on Night Six."
 *   4. src/story/Script.js — already shipped, already read by NightManager — agrees with STORY.md.
 *      Disagreeing with it would make the game's own data contradict itself.
 *
 * Where GAME_DESIGN.md gives a *mechanism* number rather than a *night* number, GAME_DESIGN wins
 * and is used verbatim: the thunder delay (distance/343 m/s), the 6.0 s envelope floor, the
 * 0 -> 0.85 / 0.4 s ramp / 1.2 s decay envelope, the 25–60 s storm interval, the three storm cells
 * at t = 0.15 / 0.45 / 0.78, the `nextStrikeIn() <= 45 s` guarantee, `noise:emit` kind `thunder`
 * at radius 400 / intensity 1.00, and `exposeF = 2.0` for 0.25 s on a flash.
 *
 * The one place the two documents make an unsatisfiable joint demand is strike count. STORY gives
 * the storm night 6 strikes; GAME_DESIGN §7.5 proves that 6 strikes cannot support a masking
 * mechanic that its own §7.5 calls guaranteed. Both are honoured by `requestCover()`: 6 strikes
 * are *authored* into the night, and further strikes are generated only while the player is
 * actually holding a seating check with no cover inside 45 s. A passive player sees six. A player
 * hammering through the storm gets the storm answering the hammer. See _scheduleStrikes().
 *
 * ---------------------------------------------------------------------------------------------
 * PUBLIC API
 * ---------------------------------------------------------------------------------------------
 *   rain                 float 0..1     instantaneous rainfall
 *   wind                 Vector3        direction * strength, magnitude 0..1.4 (Materials' range)
 *   windStrength         float 0..1     scalar strength, the value in `weather:change`
 *   windGust             float 0..1     gust envelope, spiky, zero between gusts
 *   windLoad             float 0..1     structural load on the frame = base + gust. Use this for
 *                                       BuildSystem's Mw so a gust makes bad joins talk.
 *   fog                  float 0..1
 *   lightning            float 0..1     flash envelope, drives uLightning
 *   isStorming           bool
 *   nextStrikeIn         seconds until the next flash (Infinity when none). CALLABLE: both
 *                        `w.nextStrikeIn` and `w.nextStrikeIn()` work — see callableNumber().
 *   maskLevel            0..1 global audibility suppression. CALLABLE, same as above.
 *   maskFloor            float 0..1     the weather-only component of maskLevel
 *   thunderMaskRemaining seconds of masking left in the current roll (0 when none)
 *   thunderIncomingIn    seconds until the roll arrives (Infinity when no strike is in flight)
 *   flashSeq             int, +1 on every flash. Campers poll this to flashMark (§9.4).
 *   flashExposure        1.0, or 2.0 for 0.25 s after a flash (§9.4)
 *   strikePosition       Vector3, world position of the last strike
 *   wetness, puddle      float 0..1
 *
 *   windAt(position, out) -> Vector3      gust fronts travel downwind; upwind gets it first
 *   gustAt(position)      -> float 0..1   local gust, sheltered by canopy. For the lantern.
 *   requestWind(delta, seconds = 90)      GAME_DESIGN §5.4 rubber band, NightManager
 *   requestGust(strength = 1, delay = 0)  GAME_DESIGN §7.3 cascade cover, BuildSystem
 *   requestCover(within = 45)             GAME_DESIGN §7.5 guarantee, BuildSystem
 *   strike(opts)                          force a strike (NightManager beats, debug)
 *   setNight(n)  clearPins()
 *
 * Emits: `weather:change { rain, wind, fog }` (throttled), `noise:emit { kind:'thunder' }`,
 *        `audio:sfx` for thunder / gust / drip. Nothing else. No new event names.
 */

import * as THREE from 'three';
import { Log } from '../core/Log.js';
import { Rand, hashStr, fbm2, valueNoise2 } from '../core/Rand.js';

// ------------------------------------------------------------------ module scratch (no allocation in update)

const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _v3d = new THREE.Vector3();

/** exp(-x^2). Written as a function because `-a ** 2` is a JavaScript syntax error. */
const gauss = (x) => Math.exp(-(x * x));

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep01 = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

/**
 * A number that can also be called.
 *
 * GAME_DESIGN §7.5 and AUDIO_DIRECTION's cross-module table both contract `Weather.maskLevel()`
 * and `Weather.nextStrikeIn()` as METHODS. The system brief for this file specifies them as
 * PROPERTIES. A plain number throws on call and a plain method reads as NaN in arithmetic, so
 * either choice silently breaks somebody. This satisfies both:
 *
 *     w.maskLevel        -> coerces to the number (valueOf / Symbol.toPrimitive)
 *     w.maskLevel()      -> returns the number
 *     1 - w.maskLevel    -> correct
 *     1 - w.maskLevel()  -> correct
 *
 * The one form that does NOT work is `Number.isFinite(w.maskLevel)` (it is a function object).
 * Plain-number mirrors are published for that case: `maskLevelValue`, `secondsToNextStrike`.
 */
function callableNumber(initial = 0) {
  const f = function () { return f.value; };
  f.value = initial;
  f.valueOf = () => f.value;
  f.toString = () => String(f.value);
  f[Symbol.toPrimitive] = (hint) => (hint === 'string' ? String(f.value) : f.value);
  return f;
}

// ------------------------------------------------------------------ the night table (STORY.md §5)

/**
 * STORY.md §5, transcribed. `gustAmp` and `gustPeriod` exist nowhere else in the repository.
 * Night 7 splits at `calmAt` — "the last 20% of the game has zero masking".
 */
const NIGHT_WEATHER = [
  { rain: 0.00, wind: 0.05, gustAmp: 0.00, gustPeriod: 0,  fog: 0.20, strikes: 0, fogProfile: 'clear' },
  { rain: 0.00, wind: 0.25, gustAmp: 0.18, gustPeriod: 28, fog: 0.30, strikes: 0, fogProfile: 'clear' },
  { rain: 0.40, wind: 0.35, gustAmp: 0.25, gustPeriod: 22, fog: 0.45, strikes: 1, fogProfile: 'drizzle' },
  { rain: 0.60, wind: 0.40, gustAmp: 0.30, gustPeriod: 18, fog: 0.55, strikes: 2, fogProfile: 'rain' },
  { rain: 0.70, wind: 0.75, gustAmp: 0.45, gustPeriod: 11, fog: 0.40, strikes: 6, fogProfile: 'storm' },
  { rain: 0.00, wind: 0.20, gustAmp: 0.04, gustPeriod: 90, fog: 0.80, strikes: 0, fogProfile: 'whiteout' },
  {
    rain: 0.55, wind: 0.65, gustAmp: 0.50, gustPeriod: 9, fog: 0.35, strikes: 4, fogProfile: 'storm',
    calmAt: 0.80,
    calm: { rain: 0.00, wind: 0.03, gustAmp: 0.00, gustPeriod: 0, fog: 0.25, strikes: 0, fogProfile: 'dawn' },
  },
];

/** ART_DIRECTION §5.1 height-fog columns. Selected per night, blended by the front envelope. */
const FOG_PROFILES = {
  clear:    { D0: 0.014, H: 4.2,  g: 0.55, far: 0x54697a },
  drizzle:  { D0: 0.021, H: 4.8,  g: 0.60, far: 0x4a5d6c },
  windmist: { D0: 0.024, H: 5.2,  g: 0.62, far: 0x51636f },
  rain:     { D0: 0.031, H: 5.5,  g: 0.64, far: 0x44545f },
  whiteout: { D0: 0.078, H: 14.0, g: 0.38, far: 0x54697a },
  storm:    { D0: 0.048, H: 8.0,  g: 0.70, far: 0x3d4c58 },
  dawn:     { D0: 0.020, H: 3.4,  g: 0.45, far: 0x6d7e88 },
};

const TUNING = {
  // --- wind
  windUniformScale: 1.4,      // Materials documents uWind magnitude as 0..1.4
  windDirDriftRate: 0.017,    // rad/s of slow veer at strength 1
  windNoiseRate: 0.055,       // Hz-ish of the layered magnitude noise
  gustAttack: 0.85,           // s, 0 -> peak
  gustSustainMin: 0.9,
  gustSustainMax: 3.1,
  gustDecay: 2.4,             // s, peak -> 0
  gustVeer: 0.32,             // rad of heading swing at full gust
  gustFrontSpeed: 13.0,       // m/s the gust front travels downwind
  gustLoadWeight: 0.62,       // how much of windLoad a gust contributes over the base
  gustMaskWeight: 0.22,       // GAME_DESIGN §7.5 wind term, applied to the GUST not the base

  // --- rain
  rainTau: 9.0,               // s, rain never snaps
  rainFloorFraction: 0.14,    // between fronts a rainy night still spits
  windLeadSeconds: 45,        // the wind shift precedes the rain band. A real cold front.

  // --- wetness (mirrors Materials' own integration so the standalone path matches)
  wetFloor: 0.26,
  wetTauUp: 7.0,
  wetTauDown: 68.0,

  // --- lightning (GAME_DESIGN §7.5)
  strikeIntervalMin: 25,
  strikeIntervalMax: 60,
  cellCentres: [0.15, 0.45, 0.78],
  cellHalfWidth: 0.075,
  inCellScale: 0.7,
  outCellScale: 1.6,
  distanceMinKm: 0.4,
  distanceMaxKm: 4.2,
  speedOfSound: 343,          // m/s
  envelopeFloor: 6.0,         // s
  envelopeSpan: 4.0,          // s, at zero distance
  maskPeak: 0.85,
  maskRamp: 0.4,
  maskDecay: 1.2,
  flashExposureSeconds: 0.25, // §9.4
  flashExposureFactor: 2.0,
  minStrikeSpacing: 22,       // s, so requestCover cannot machine-gun the sky
  coverWindow: 45,            // s, the §7.5 guarantee
  thunderNoiseRadius: 400,    // §9.8 canonical table
  thunderNoiseIntensity: 1.0,

  // --- drips (ART §6.1)
  dripChargeTau: 34,
  dripDrainTau: 96,
  dripFall: 6.2,

  // --- event throttling
  changeMinInterval: 0.5,
  changeHeartbeat: 6.0,
  changeEpsRain: 0.035,
  changeEpsWind: 0.045,
  changeEpsFog: 0.035,
};

// ------------------------------------------------------------------ shaders

const STREAK_VERT = /* glsl */`
precision highp float;

uniform float uTime;
uniform vec3  uCamPos;
uniform vec3  uWind;
uniform float uRain;
uniform float uShutter;
uniform float uPxWidth;
uniform vec2  uShellSize;
uniform float uFallSpeed;
uniform float uLightning;
uniform float uMoon;
uniform vec3  uLanternPos;
uniform vec3  uLanternAxis;
uniform vec4  uLanternParams;   // x cosOuter, y cosInner, z intensity, w range
uniform float uFogD0;

attribute vec3  aOffset;
attribute vec4  aParams;        // x shell 0/1, y lenScale, z widthScale, w speedScale
attribute float aSeed;

varying float vAlpha;
varying float vLit;
varying vec2  vQuad;

void main() {
  vQuad = position.xy + vec2(0.5, 0.0);

  #ifdef DRIP
    // aOffset is a live world position written by the CPU pool; aParams.xyz is unused for
    // wrapping and aParams.w carries the fall speed.
    vec3 vel = vec3(uWind.x * 0.22, -aParams.w, uWind.z * 0.22);
    vec3 p = aOffset;
    float alive = aSeed;                 // 0 = slot idle
    float box = 40.0;
  #else
    // Cull instances above the current rainfall: light rain is genuinely fewer drops, not
    // the same drops at lower alpha. Costs nothing and it is the difference between
    // "drizzle" and "someone turned the opacity down".
    float alive = step(aSeed, uRain * 1.06);
    float box = mix(uShellSize.x, uShellSize.y, aParams.x);
    vec3 vel = vec3(uWind.x * 0.55, -uFallSpeed * aParams.w, uWind.z * 0.55);
    vec3 p = aOffset * box + vel * uTime;
    p = mod(p - uCamPos + box * 0.5, box) - box * 0.5 + uCamPos;
  #endif

  vec3 toCam = uCamPos - p;
  float dist = length(toCam);
  vec3 vdir = toCam / max(dist, 1e-4);
  vec3 dir = normalize(vel);

  // Orient the streak ALONG the velocity vector. That is the motion blur: no post pass, no
  // velocity buffer, the geometry is already the smear.
  vec3 side = cross(dir, vdir);
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);

  float len = length(vel) * uShutter * aParams.y;
  float wid = max(aParams.z * 0.013, dist * uPxWidth);

  vec3 wp = p + dir * ((position.y - 0.5) * len) + side * (position.x * wid);

  // --- alpha
  #ifdef DRIP
    float edge = 1.0;
    float shell = 0.0;
  #else
    vec3 rel = abs(p - uCamPos) / (box * 0.5);
    float edge = 1.0 - smoothstep(0.82, 1.0, max(max(rel.x, rel.y), rel.z));
    float shell = aParams.x;
  #endif

  float nearFade = smoothstep(0.30, 1.10, dist);
  float fogFade = exp(-dist * uFogD0 * 0.85);
  float a = alive * edge * nearFade * fogFade * mix(0.78, 0.44, shell);

  #ifndef DRIP
    a *= smoothstep(0.02, 0.22, uRain);
  #endif

  // --- lighting. ART §5.4: streaks inside a light cone are lit at 2.2x. One dot product.
  vec3 toL = p - uLanternPos;
  float dl = length(toL);
  float cosA = dot(toL / max(dl, 1e-4), uLanternAxis);
  float cone = smoothstep(uLanternParams.x, uLanternParams.y, cosA)
             * (1.0 - smoothstep(uLanternParams.w * 0.45, uLanternParams.w, dl));
  // ART §5.4: a streak inside a light cone is lit at 2.2x ambient rain brightness. The ambient
  // term has to be high enough that the 2.2x actually reads as the classic image and not as a
  // slightly less invisible drop.
  vLit = 0.52 + 0.52 * uMoon + 2.20 * cone * uLanternParams.z + 2.60 * uLightning;

  vAlpha = a;
  if (a < 0.002) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // off-screen, no fill cost
    return;
  }
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const STREAK_FRAG = /* glsl */`
precision highp float;

uniform vec3 uRainColor;

varying float vAlpha;
varying float vLit;
varying vec2  vQuad;

void main() {
  // Flat-topped across the streak, not a triangle. A streak is only ~2 px wide: with a
  // triangular profile the rasteriser samples the ramp at a random offset and the drop reads
  // at a third of its intended brightness, which is how rain becomes invisible.
  float across = smoothstep(0.0, 0.45, 1.0 - abs(vQuad.x - 0.5) * 2.0);
  float along = smoothstep(0.0, 0.20, vQuad.y) * (1.0 - smoothstep(0.72, 1.0, vQuad.y));
  float a = vAlpha * across * along;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uRainColor * vLit, a);

  // Composite exactly like every other material in the scene. Without these two chunks the
  // shader writes linear radiance straight into whatever buffer is bound, so rain is graded
  // differently from the world it is falling through — and looks pasted on in one path and
  // invisible in the other.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const RIPPLE_VERT = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uLife;
uniform float uLightning;
uniform float uMoon;
uniform vec3  uCamPos;
uniform float uFogD0;

attribute vec3  aPos;
attribute float aSpawn;
attribute float aScale;

varying float vAlpha;
varying float vLit;

void main() {
  float age = uTime - aSpawn;
  float k = age / uLife;
  if (aSpawn <= 0.0 || k < 0.0 || k > 1.0) {
    vAlpha = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float r = aScale * (0.12 + 0.88 * sqrt(k));
  vec3 wp = aPos + vec3(position.x * r, 0.0, position.z * r);

  float dist = length(uCamPos - wp);
  float fogFade = exp(-dist * uFogD0 * 0.9);
  vAlpha = (1.0 - k) * (1.0 - k) * fogFade * 0.55;
  vLit = 0.30 + 0.45 * uMoon + 1.8 * uLightning;

  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const RIPPLE_FRAG = /* glsl */`
precision highp float;

uniform vec3 uRippleColor;

varying float vAlpha;
varying float vLit;

void main() {
  if (vAlpha < 0.003) discard;
  gl_FragColor = vec4(uRippleColor * vLit, vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ------------------------------------------------------------------

export class Weather {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx?.bus ?? null;

    // ---- public state. Plain properties: Shots.js writes rain/fog/lightning directly.
    this.rain = 0.0;
    this.wind = new THREE.Vector3(0.05 * TUNING.windUniformScale, 0, 0);
    this.windStrength = 0.05;
    this.windGust = 0;
    this.windLoad = 0.05;
    this.fog = 0.20;
    this.lightning = 0;
    this.isStorming = false;
    this.wetness = TUNING.wetFloor;
    this.puddle = 0;
    this.rainAccum = 0;

    this.maskFloor = 0;
    this.thunderMaskRemaining = 0;
    this.thunderIncomingIn = Infinity;
    this.secondsToNextStrike = Infinity;
    this.maskLevelValue = 0;

    this.flashSeq = 0;
    this.flashExposure = 1.0;
    this.strikePosition = new THREE.Vector3(0, 900, -1200);
    this.strikeDistanceKm = 0;
    this.strikeCount = 0;

    // Callable numbers — see callableNumber() for why.
    this.nextStrikeIn = callableNumber(Infinity);
    this.maskLevel = callableNumber(0);

    // ---- night schedule
    this.night = clamp(ctx?.state?.night ?? 1, 1, 7);
    this._profile = NIGHT_WEATHER[0];
    this._active = { rain: 0, wind: 0.05, gustAmp: 0, gustPeriod: 0, fog: 0.2, strikes: 0, fogProfile: 'clear' };
    this._nightDuration = 800;
    this._fronts = [];
    this._frontEnvelope = 0;

    // ---- sim state
    this._t = 0;                 // seconds of simulated night weather
    this._localT = 0;            // 0..1 fallback night clock
    this._tonSeen = -1;
    this._tonSeenAt = -1e9;
    this._paused = false;
    this._disposed = false;
    this._fixedRan = 0;

    this._windAngle = 0;
    this._windBase = 0.05;
    this._windBias = 0;          // requestWind()
    this._windBiasTarget = 0;
    this._windBiasUntil = -1;

    this._gustActive = false;
    this._gustStart = -1e9;
    this._gustPeak = 0;
    this._gustSustain = 0;
    this._gustNextAt = 1e9;
    this._gustVeer = 0;
    this._gustAnnounced = false;

    this._rainTarget = 0;
    this._dripCharge = 0;

    // lightning
    this._strikeTimes = [];      // authored strike times, seconds into the night
    this._strikeCursor = 0;
    this._nextFlashAt = Infinity;
    this._preflickerAt = Infinity;
    this._preflickerAmp = 0;
    this._flashAt = -1e9;
    this._flashPeak = 1;
    this._lastStrikeAt = -1e9;
    this._thunderAt = Infinity;
    this._thunderEnvelope = 0;
    this._rollHoldUntil = -1e9;
    this._rollEndsAt = -1e9;
    this._rollPeak = 0;
    this._coverRequestedUntil = -1e9;

    // ---- pins (Shots.js / debug overrides)
    this._pin = { rain: null, fog: null, lightning: null };
    this._published = { rain: 0, fog: 0, lightning: 0 };
    this._publishedValid = false;

    // ---- event throttle
    this._lastChangeAt = -1e9;
    this._lastChange = { rain: -1, wind: -1, fog: -1 };

    // ---- rendering
    this.group = null;
    this._streaks = null;
    this._drips = null;
    this._ripples = null;
    this._streakMat = null;
    this._dripMat = null;
    this._rippleMat = null;
    this._lightningLight = null;
    this._ownsLightningLight = false;

    this._dripPool = null;
    this._dripAttr = null;
    this._dripSeedAttr = null;
    this._dripParamAttr = null;
    this._rippleSpawnAttr = null;
    this._ripplePosAttr = null;
    this._rippleScaleAttr = null;
    this._rippleCursor = 0;
    this._rippleAccum = 0;
    this._dripAccum = 0;
    this._dripSfxCooldown = 0;
    this._gustSfxCooldown = 0;

    this._gu = null;             // Materials.globalUniforms
    this._materialsSystem = null;
    this._fogAppliedAt = -1e9;

    const seed = ctx?.settings?.get?.('seed') ?? 0x51a5cab;
    this._seed = (seed ^ hashStr('weather')) >>> 0;
    this._rand = new Rand(this._seed);              // simulation — stepped at 60 Hz, deterministic
    this._visRand = new Rand((this._seed ^ 0x1d17) >>> 0);  // presentation — frame-rate dependent
    this._noiseSeed = this._rand.range(0, 4096);

    this._onNightBegin = (p) => this._handleNightBegin(p);
    this._onNightEnd = () => { this._paused = false; };
    this._onPause = () => { this._paused = true; };
    this._onResume = () => { this._paused = false; };
  }

  // ================================================================ lifecycle

  async init() {
    // Script.js is data with no dependencies, but it is another agent's file: never hard-import.
    try {
      const mod = await import('../story/Script.js');
      this._script = mod?.Script ?? mod?.default ?? null;
    } catch (e) {
      this._script = null;
      Log.debug('Weather: Script.js unavailable, using the built-in STORY §5 table.', e?.message ?? e);
    }

    this._resolveGlobalUniforms();
    this.setNight(this.ctx?.state?.night ?? 1);

    try { this._buildRain(); } catch (e) { Log.warn('Weather: rain build failed, running without particles.', e); }
    try { this._ensureLightningLight(); } catch (e) { Log.debug('Weather: no lightning light.', e?.message ?? e); }

    if (this.bus) {
      this.bus.on('night:begin', this._onNightBegin);
      this.bus.on('night:complete', this._onNightEnd);
      this.bus.on('night:failed', this._onNightEnd);
      this.bus.on('game:pause', this._onPause);
      this.bus.on('game:resume', this._onResume);
    }

    this._emitChange(true);
    Log.debug(`Weather ready — night ${this.night}, rain ${this._active.rain.toFixed(2)}, `
      + `wind ${this._active.wind.toFixed(2)}, fog ${this._active.fog.toFixed(2)}, `
      + `${this._strikeTimes.length} authored strike(s).`);
  }

  /** Physics-rate simulation. Deterministic, allocation-free. */
  fixedUpdate(fdt) {
    if (this._disposed || this._paused) return;
    this._fixedRan++;
    // Shots.js writes rain/fog/lightning at the end of a frame; fixedUpdate is the first thing
    // to run in the next one, so the override has to be caught here or the simulation
    // overwrites it before update() ever sees it.
    this._adoptPins();
    this._simulate(fdt);
  }

  /** Presentation: uniforms, particles, events. */
  update(dt, elapsed) {
    if (this._disposed) return;
    const d = clamp(dt || 0, 0, 0.1);

    // If nobody is driving fixedUpdate (a harness, a stripped Engine), still advance.
    if (this._fixedRan === 0 && !this._paused) this._simulate(d);
    this._fixedRan = 0;

    this._adoptPins();
    this._writeUniforms(d);
    // The particle clock is the night clock, not the session clock: `_t` is bounded by the
    // night length, so `velocity * time` inside the wrap never loses float precision on a long
    // session, and it resets cleanly at every night boundary.
    this._updateRain(d, this._t);
    this._maybeEmitChange();
  }

  resize(width, height) {
    if (!this._streakMat) return;
    // World units per metre of distance that cover one pixel — keeps far streaks from
    // sub-pixelling into nothing.
    const fov = (this.ctx?.camera?.fov ?? 72) * Math.PI / 180;
    const px = (2 * Math.tan(fov * 0.5)) / Math.max(1, height || this.ctx?.height || 1080);
    // ~2.4 px minimum. Below about two pixels a streak is a coverage lottery and the rain
    // silently disappears at distance instead of receding.
    const w = clamp(px * 2.4, 0.0006, 0.02);
    this._streakMat.uniforms.uPxWidth.value = w;
    if (this._dripMat) this._dripMat.uniforms.uPxWidth.value = w * 1.5;
  }

  dispose() {
    this._disposed = true;
    if (this.bus) {
      this.bus.off?.('night:begin', this._onNightBegin);
      this.bus.off?.('night:complete', this._onNightEnd);
      this.bus.off?.('night:failed', this._onNightEnd);
      this.bus.off?.('game:pause', this._onPause);
      this.bus.off?.('game:resume', this._onResume);
    }

    if (this.group) {
      this.group.parent?.remove(this.group);
      this.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      this.group = null;
    }
    if (this._ownsLightningLight && this._lightningLight) {
      this._lightningLight.parent?.remove(this._lightningLight);
      this._lightningLight.dispose?.();
    }
    this._lightningLight = null;
    this._streaks = this._drips = this._ripples = null;
    this._streakMat = this._dripMat = this._rippleMat = null;
    this._dripPool = null;
  }

  // ================================================================ schedule

  /** Configure the night. Safe to call at any time. */
  setNight(n) {
    const night = clamp(Math.round(Number(n) || 1), 1, 7);
    this.night = night;
    // A new night is not an external override of the old one.
    this.clearPins();
    const base = NIGHT_WEATHER[night - 1] ?? NIGHT_WEATHER[0];

    // Script.js wins on the numbers it publishes (it is the data layer other agents read);
    // STORY §5 supplies gust structure, which Script does not carry.
    const sp = this._scriptProfile(night);
    const merged = {
      rain: Number.isFinite(sp?.rain) ? clamp01(sp.rain) : base.rain,
      wind: Number.isFinite(sp?.wind) ? clamp01(sp.wind) : base.wind,
      fog: Number.isFinite(sp?.fog) ? clamp01(sp.fog) : base.fog,
      strikes: Number.isFinite(sp?.strikes) ? Math.max(0, sp.strikes | 0) : base.strikes,
      gustAmp: base.gustAmp,
      gustPeriod: base.gustPeriod,
      fogProfile: base.fogProfile,
      calmAt: Number.isFinite(sp?.calmAt) ? sp.calmAt : base.calmAt,
      calm: base.calm ?? null,
    };

    if (sp) {
      const drift = Math.max(
        Math.abs(merged.rain - base.rain),
        Math.abs(merged.wind - base.wind),
        Math.abs(merged.fog - base.fog),
      );
      if (drift > 0.12) {
        Log.once(`weather-drift-${night}`,
          `Weather: Script.js weatherProfile for night ${night} differs from STORY.md §5 by `
          + `${drift.toFixed(2)}. Using Script.js. If the storm has moved nights, read the CANON `
          + 'NOTE at the top of Weather.js before changing anything.');
      }
    }

    this._profile = merged;
    this._nightDuration = this._scriptDuration(night);
    this._t = 0;
    this._localT = 0;
    this._tonSeen = -1;
    this._tonSeenAt = -1e9;
    this._windBias = 0;
    this._windBiasTarget = 0;
    this._windBiasUntil = -1;
    this._rippleAccum = 0;
    this._dripCharge = 0;

    // Per-night deterministic stream, so a replayed night has the same storm.
    this._rand = new Rand((this._seed ^ (night * 0x9e3779b9)) >>> 0);
    this._visRand = new Rand((this._seed ^ (night * 0x85ebca6b) ^ 0x1d17) >>> 0);
    this._noiseSeed = this._rand.range(0, 4096);
    this._windAngle = this._rand.range(0, Math.PI * 2);

    this._buildFronts();
    this.strikeCount = 0;
    this._scheduleStrikes();
    this._resetLightning();
    this._applyProfileAt(0);

    // Snap, not fade: a night begins in its own weather, evaluated at t = 0 rather than
    // inheriting whatever the previous night happened to end on.
    const floor0 = this._active.rain * TUNING.rainFloorFraction;
    this._rainTarget = this._active.rain <= 0.001
      ? 0
      : clamp01(floor0 + (this._active.rain - floor0) * this._frontEnvelope);
    this.rain = this._rainTarget;
    this.windStrength = this._active.wind;
    this.windLoad = this._active.wind;
    this.fog = this._active.fog;
    this.wetness = clamp01(TUNING.wetFloor + this.rain * (1 - TUNING.wetFloor) * 1.35);
    this.rainAccum = this.rain * 0.05;
    this._scheduleNextGust(0);
    this._applyFogProfile(true);

    // Record the snap as ours, or _adoptPins() will read it as somebody pinning the night.
    this._publish();
    this._emitChange();
  }

  _scriptProfile(night) {
    try {
      const s = this._script;
      const def = s?.nightDef?.(night) ?? s?.nights?.[night - 1] ?? null;
      const wp = def?.weatherProfile;
      return wp && typeof wp === 'object' ? wp : null;
    } catch { return null; }
  }

  _scriptDuration(night) {
    try {
      const def = this._script?.nightDef?.(night) ?? this._script?.nights?.[night - 1] ?? null;
      const d = def?.durationSeconds;
      if (Number.isFinite(d) && d > 60 && d < 1e6) return d;
    } catch { /* fall through */ }
    return [800, 975, 950, 1050, 1175, 1400, 1320][night - 1] ?? 900;
  }

  _handleNightBegin(p) {
    const n = Number.isFinite(p?.night) ? p.night : this.ctx?.state?.night;
    this.clearPins();
    this.setNight(n ?? this.night);
  }

  /**
   * Storm fronts. A night is not one weather; it is two to four bands with dry stretches
   * between them. The dry stretches are where the stealth game is tense and the bands are
   * where it is loud. This is the pacing of the night and it is authored here, not felt for.
   */
  _buildFronts() {
    const r = this._rand;
    this._fronts.length = 0;
    const p = this._profile;
    if (p.rain <= 0.01 && p.wind < 0.30) {
      // A still, dry night gets one very soft swell so the world is not a photograph.
      this._fronts.push({ t0: 0.30, peak: 0.55, t1: 0.72, amp: 0.35 });
      return;
    }
    const count = p.rain > 0.5 ? r.int(3, 4) : r.int(2, 3);
    let cursor = r.range(0.02, 0.16);
    for (let i = 0; i < count; i++) {
      const width = r.range(0.16, 0.30);
      const t0 = cursor;
      const t1 = Math.min(1.02, t0 + width);
      this._fronts.push({
        t0,
        peak: t0 + width * r.range(0.35, 0.62),
        t1,
        amp: r.range(0.62, 1.0),
      });
      cursor = t1 + r.range(0.05, 0.16);
      if (cursor > 0.94) break;
    }
    // The heaviest band lands in the back half. Weather escalates inside a night as well as
    // across the seven.
    if (this._fronts.length > 1) {
      let best = 0;
      for (let i = 1; i < this._fronts.length; i++) {
        if (this._fronts[i].peak > this._fronts[best].peak) best = i;
      }
      this._fronts[best].amp = 1.0;
    }
  }

  _frontAt(t) {
    let v = 0;
    for (let i = 0; i < this._fronts.length; i++) {
      const f = this._fronts[i];
      if (t <= f.t0 || t >= f.t1) continue;
      const e = t < f.peak
        ? smoothstep01(f.t0, f.peak, t)
        : 1 - smoothstep01(f.peak, f.t1, t);
      if (e > v) v = e * f.amp;
    }
    return v;
  }

  /**
   * GAME_DESIGN §7.5 strike schedule, with STORY §5's authored strike count.
   *
   * Three storm cells at t = 0.15 / 0.45 / 0.78; interval x0.7 inside a cell, x1.6 between.
   * Nights with 1–2 strikes get them placed inside cells, distant and atmospheric — they are
   * weather, not a mechanic. Nights with 4+ strikes are a schedule you can plan against.
   */
  _scheduleStrikes() {
    const r = this._rand;
    this._strikeTimes.length = 0;
    this._strikeCursor = 0;
    // Clear any flash still pending from the previous night, or Night Six — which has no
    // strikes at all and whose entire design is that nothing covers you — inherits one.
    this._nextFlashAt = Infinity;
    this._preflickerAt = Infinity;
    this._refreshCountdown();
    const n = this._profile.strikes | 0;
    if (n <= 0) return;

    const dur = this._nightDuration;
    const calmAt = Number.isFinite(this._profile.calmAt) ? this._profile.calmAt : 1.0;
    const usable = dur * calmAt;

    if (n <= 3) {
      // Distant, sparse. Placed at the cell centres, jittered.
      for (let i = 0; i < n; i++) {
        const c = TUNING.cellCentres[i % TUNING.cellCentres.length];
        const t = clamp(c + r.range(-0.06, 0.06), 0.04, calmAt - 0.03) * dur;
        this._strikeTimes.push(t);
      }
    } else {
      // Walk the night at the §7.5 interval, scaled by the cell factor, then keep the n
      // strongest slots so the authored count is honoured and the *rhythm* is the schedule's.
      const candidates = [];
      let t = r.range(18, 46);
      while (t < usable) {
        candidates.push(t);
        const frac = t / dur;
        let inCell = false;
        for (let i = 0; i < TUNING.cellCentres.length; i++) {
          if (Math.abs(frac - TUNING.cellCentres[i]) < TUNING.cellHalfWidth * 2.2) { inCell = true; break; }
        }
        const scale = inCell ? TUNING.inCellScale : TUNING.outCellScale;
        t += r.range(TUNING.strikeIntervalMin, TUNING.strikeIntervalMax) * scale;
      }
      if (candidates.length <= n) {
        for (let i = 0; i < candidates.length; i++) this._strikeTimes.push(candidates[i]);
      } else {
        // Keep the ones nearest a cell centre: the storm arrives in cells, not evenly.
        const scored = candidates.map((ct) => {
          const frac = ct / dur;
          let best = 1e9;
          for (let i = 0; i < TUNING.cellCentres.length; i++) {
            best = Math.min(best, Math.abs(frac - TUNING.cellCentres[i]));
          }
          return { t: ct, d: best };
        });
        scored.sort((a, b) => a.d - b.d);
        for (let i = 0; i < n; i++) this._strikeTimes.push(scored[i].t);
        this._strikeTimes.sort((a, b) => a - b);
      }
    }
    this._nextFlashAt = this._strikeTimes.length ? this._strikeTimes[0] : Infinity;
    this._armPreflicker();
    this._refreshCountdown();
  }

  _resetLightning() {
    this.lightning = 0;
    this.flashExposure = 1.0;
    this._flashAt = -1e9;
    this._thunderAt = Infinity;
    this._rollHoldUntil = -1e9;
    this._rollEndsAt = -1e9;
    this._rollPeak = 0;
    this._lastStrikeAt = -1e9;
    this.thunderMaskRemaining = 0;
    this.thunderIncomingIn = Infinity;
  }

  // ================================================================ simulation

  _simulate(dt) {
    this._t += dt;
    const t01 = this._nightProgress(dt);

    this._applyProfileAt(t01);
    this._simWind(dt, t01);
    this._simRain(dt);
    this._simFog(dt, t01);
    this._simLightning(dt);
    this._simWetness(dt);

    // A storm is still a storm after its last strike. It stops being one when the rain and the
    // wind stop, which on Night 7 happens at t = 0.80 and is the whole point of Night 7.
    this.isStorming = (this._active.strikes > 0)
      && (this.rain > 0.30 || this.windStrength > 0.55);

    // Re-apply pins so a pinned value survives the simulation, then record what the simulation
    // produced. _adoptPins() compares against this to tell an external write from our own.
    if (this._pin.rain !== null) this.rain = this._pin.rain;
    if (this._pin.fog !== null) this.fog = this._pin.fog;
    if (this._pin.lightning !== null) this.lightning = this._pin.lightning;
    this._publish();
  }

  /** timeOfNight, trusting NightManager while it is actually moving. */
  _nightProgress(dt) {
    const ton = this.ctx?.state?.timeOfNight;
    if (Number.isFinite(ton) && ton !== this._tonSeen) {
      this._tonSeen = ton;
      this._tonSeenAt = this._t;
    }
    const driven = Number.isFinite(ton) && (this._t - this._tonSeenAt) < 3.0 && ton > 0;
    if (driven) {
      this._localT = clamp01(ton);
      return this._localT;
    }
    this._localT = clamp01(this._localT + dt / Math.max(60, this._nightDuration));
    return this._localT;
  }

  /** Resolve the night's operative profile, including Night 7's calm. */
  _applyProfileAt(t01) {
    const p = this._profile;
    const a = this._active;
    if (Number.isFinite(p.calmAt) && p.calm && t01 >= p.calmAt) {
      // STORY §5: "It stops raining. The last 20% of the game has zero masking."
      // A 30 s transition, so it stops mid-sentence rather than being switched off.
      const k = smoothstep01(p.calmAt, Math.min(1, p.calmAt + 0.035), t01);
      a.rain = lerp(p.rain, p.calm.rain, k);
      a.wind = lerp(p.wind, p.calm.wind, k);
      a.fog = lerp(p.fog, p.calm.fog, k);
      a.gustAmp = lerp(p.gustAmp, p.calm.gustAmp, k);
      a.gustPeriod = lerp(p.gustPeriod || 30, p.calm.gustPeriod || 240, k);
      a.strikes = k > 0.5 ? 0 : p.strikes;
      a.fogProfile = k > 0.5 ? p.calm.fogProfile : p.fogProfile;
    } else {
      a.rain = p.rain;
      a.wind = p.wind;
      a.fog = p.fog;
      a.gustAmp = p.gustAmp;
      a.gustPeriod = p.gustPeriod;
      a.strikes = p.strikes;
      a.fogProfile = p.fogProfile;
    }
    this._frontEnvelope = this._frontAt(t01);
  }

  // ---------------------------------------------------------------- wind

  _simWind(dt, t01) {
    const a = this._active;

    // --- requestWind bias (GAME_DESIGN §5.4 rubber band)
    if (this._windBiasUntil > 0 && this._t > this._windBiasUntil) this._windBiasTarget = 0;
    this._windBias += (this._windBiasTarget - this._windBias) * (1 - Math.exp(-dt / 6.0));

    // --- base magnitude: schedule x front, plus layered noise. Never a sine.
    const nt = this._t * TUNING.windNoiseRate;
    const slow = fbm2(nt * 0.35, this._noiseSeed, 3, 2.0, 0.55);         // -1..1-ish
    const fast = valueNoise2(nt * 2.1, this._noiseSeed + 91.3) * 2 - 1;
    const frontLead = this._frontAt(clamp01(t01 + TUNING.windLeadSeconds / Math.max(60, this._nightDuration)));

    const scheduled = a.wind * (0.72 + 0.42 * frontLead);
    const noisy = scheduled * (1 + slow * 0.34 + fast * 0.11);
    this._windBase = clamp01(Math.max(0, noisy + this._windBias));

    // --- discrete gusts
    this._simGusts(dt, a);

    const gustAdd = this.windGust * a.gustAmp;
    this.windStrength = clamp01(this._windBase + gustAdd);

    // windLoad is what BuildSystem should feed into Mw. A gust does not just move leaves; it
    // puts a moment into every post you did not seat properly.
    this.windLoad = clamp01(this._windBase + gustAdd * (1 + TUNING.gustLoadWeight));

    // --- heading: a slow veer plus a gust-driven swing
    this._windAngle += dt * TUNING.windDirDriftRate * (0.5 + this.windStrength)
      + dt * slow * 0.020;
    const ang = this._windAngle + this._gustVeer * this.windGust;
    const mag = this.windStrength * TUNING.windUniformScale;
    this.wind.set(Math.sin(ang) * mag, 0, Math.cos(ang) * mag);
  }

  _simGusts(dt, a) {
    const period = a.gustPeriod;
    const amp = a.gustAmp;

    if (period <= 0 || amp <= 0.001) {
      this.windGust = Math.max(0, this.windGust - dt * 0.8);
      this._gustActive = false;
      return;
    }

    if (!this._gustActive && this._t >= this._gustNextAt) {
      this._gustActive = true;
      this._gustStart = this._t;
      this._gustPeak = clamp01(this._rand.range(0.55, 1.15));
      this._gustSustain = this._rand.range(TUNING.gustSustainMin, TUNING.gustSustainMax);
      this._gustVeer = this._rand.range(-TUNING.gustVeer, TUNING.gustVeer);
      this._gustAnnounced = false;
    }

    if (this._gustActive) {
      const e = this._t - this._gustStart;
      const total = TUNING.gustAttack + this._gustSustain + TUNING.gustDecay;
      let env;
      if (e < TUNING.gustAttack) {
        env = smoothstep01(0, TUNING.gustAttack, e);
      } else if (e < TUNING.gustAttack + this._gustSustain) {
        // Sustain is not flat — a gust breathes.
        const s = (e - TUNING.gustAttack) / Math.max(0.001, this._gustSustain);
        env = 0.86 + 0.14 * Math.cos(s * 5.1);
      } else {
        env = 1 - smoothstep01(TUNING.gustAttack + this._gustSustain, total, e);
      }
      this.windGust = clamp01(env * this._gustPeak);
      if (e >= total) {
        this._gustActive = false;
        this.windGust = 0;
        this._scheduleNextGust(this._t);
      }
    } else {
      this.windGust = Math.max(0, this.windGust - dt * 0.9);
    }
  }

  _scheduleNextGust(now) {
    const period = this._active.gustPeriod;
    if (period <= 0) { this._gustNextAt = Infinity; return; }
    // Night 6: period 90 s, amplitude 0.04. One slow breath of air a minute and a half. The
    // jitter stays proportional so it is never a metronome and never becomes a breeze.
    this._gustNextAt = now + period * this._rand.range(0.62, 1.45);
  }

  // ---------------------------------------------------------------- rain

  _simRain(dt) {
    const a = this._active;
    const floor = a.rain * TUNING.rainFloorFraction;
    const target = a.rain <= 0.001
      ? 0
      : clamp01(floor + (a.rain - floor) * this._frontEnvelope
          + a.rain * 0.06 * (valueNoise2(this._t * 0.031, this._noiseSeed + 17.7) * 2 - 1));
    this._rainTarget = target;

    if (this._pin.rain === null) {
      this.rain += (target - this.rain) * (1 - Math.exp(-dt / TUNING.rainTau));
      if (this.rain < 0.0015) this.rain = 0;
      this.rain = clamp01(this.rain);
    }

    // Canopy reservoir: charges under rain, drains for minutes after it stops. The drips
    // outlive the weather that made them, which is the whole point of the detail.
    const tau = this.rain > this._dripCharge ? TUNING.dripChargeTau : TUNING.dripDrainTau;
    this._dripCharge += (this.rain - this._dripCharge) * (1 - Math.exp(-dt / tau));
    // Only snap to zero once the sky is actually dry — a floor applied while charging clamps
    // the reservoir to nothing on every 1/60 s step and the canopy never gets wet at all.
    if (this._dripCharge < 0.0008 && this.rain < 0.0008) this._dripCharge = 0;
  }

  _simFog(dt, t01) {
    if (this._pin.fog !== null) return;
    const a = this._active;
    // Wind scours mist; the night gets colder and it comes back. Fog is never a constant.
    const scoured = a.fog * (1 - 0.32 * clamp01(this.windStrength));
    const cold = 0.88 + 0.24 * t01;
    const band = 1 + 0.16 * this._frontEnvelope;
    const target = clamp01(scoured * cold * band);
    this.fog += (target - this.fog) * (1 - Math.exp(-dt / 14.0));
  }

  _simWetness(dt) {
    // Materials owns this integration when it is present; mirror it only when it is not, so
    // the two can never fight over the same uniform.
    if (this._materialsSystem) {
      const gu = this._gu;
      if (gu) {
        this.wetness = gu.uWetness?.value ?? this.wetness;
        this.puddle = gu.uPuddle?.value ?? this.puddle;
        this.rainAccum = gu.uRainAccum?.value ?? this.rainAccum;
      }
      return;
    }
    const target = Math.min(1, TUNING.wetFloor + this.rain * (1 - TUNING.wetFloor) * 1.35);
    const tau = target > this.wetness ? TUNING.wetTauUp : TUNING.wetTauDown;
    this.wetness += (target - this.wetness) * (1 - Math.exp(-dt / tau));
    this.rainAccum = clamp(this.rainAccum + this.rain * dt * 0.030 - dt * 0.0022, 0, 1.2);
    this.puddle = smoothstep01(0.15, 0.85, this.rainAccum);
  }

  // ---------------------------------------------------------------- lightning

  _simLightning(dt) {
    const now = this._t;

    // --- the §7.5 guarantee: a player holding a seating check gets cover inside 45 s.
    this._pollCoverDemand(now);

    // --- pre-flicker: the sky remembers something before it says it.
    if (Number.isFinite(this._preflickerAt) && now >= this._preflickerAt
        && now < this._preflickerAt + 0.14) {
      const k = (now - this._preflickerAt) / 0.14;
      this.lightning = Math.max(this.lightning, this._preflickerAmp * gauss((k - 0.25) * 3.4));
    }

    // --- the flash
    if (now >= this._nextFlashAt && Number.isFinite(this._nextFlashAt)) {
      this._fireFlash(now);
    }

    // --- the flash envelope: 2–3 stages over ~120 ms, then a short afterglow.
    const fe = now - this._flashAt;
    if (fe >= 0 && fe < 0.62) {
      const g0 = gauss((fe - 0.012) / 0.020);
      const g1 = gauss((fe - 0.062) / 0.014) * 0.44;
      const g2 = gauss((fe - 0.098) / 0.022) * 0.86;
      const tail = Math.exp(-fe * 7.0) * 0.075;
      this.lightning = clamp01(Math.max(this.lightning, (g0 + g1 + g2 + tail) * this._flashPeak));
    } else if (fe >= 0.62) {
      this.lightning *= Math.exp(-dt * 9.0);
      if (this.lightning < 0.002) this.lightning = 0;
    }

    // GAME_DESIGN §9.4 — exposure persists 0.25 s, which is what makes the flash a trade.
    this.flashExposure = (fe >= 0 && fe < TUNING.flashExposureSeconds)
      ? TUNING.flashExposureFactor : 1.0;

    // --- thunder arrival
    if (Number.isFinite(this._thunderAt)) {
      this.thunderIncomingIn = Math.max(0, this._thunderAt - now);
      if (now >= this._thunderAt) {
        this._arriveThunder(now);
      }
    } else {
      this.thunderIncomingIn = Infinity;
    }

    // --- roll envelope (0 -> 0.85 over 0.4 s, hold, 1.2 s decay)
    let roll = 0;
    if (now < this._rollEndsAt) {
      const since = now - (this._rollHoldUntil - this._thunderEnvelope);
      if (since < TUNING.maskRamp) {
        roll = this._rollPeak * clamp01(since / TUNING.maskRamp);
      } else if (now <= this._rollHoldUntil) {
        roll = this._rollPeak;
      } else {
        roll = this._rollPeak * (1 - clamp01((now - this._rollHoldUntil) / TUNING.maskDecay));
      }
      this.thunderMaskRemaining = Math.max(0, this._rollEndsAt - now);
    } else {
      this.thunderMaskRemaining = 0;
    }

    // --- the mask.
    // STORY §5 is emphatic that Nights 1, 2, 6 and 7b have ZERO cover, so the floor is rain
    // only. Wind contributes through the GUST, transiently — which is what a gust is: a
    // window, not a climate. GAME_DESIGN §7.5's constant wind term would put 0.044 of
    // permanent cover on Night Six and delete the point of Night Six.
    const gustMask = TUNING.gustMaskWeight * this._active.wind * this.windGust;
    this.maskFloor = clamp01(0.30 * this.rain);
    const level = clamp01(Math.max(this.maskFloor + gustMask, roll));
    this.maskLevel.value = level;
    this.maskLevelValue = level;

    this._refreshCountdown();
  }

  /** Republish the public countdown. Called whenever `_nextFlashAt` moves, not just per step. */
  _refreshCountdown() {
    const next = Number.isFinite(this._nextFlashAt)
      ? Math.max(0, this._nextFlashAt - this._t) : Infinity;
    this.nextStrikeIn.value = next;
    this.secondsToNextStrike = next;
  }

  _armPreflicker() {
    if (!Number.isFinite(this._nextFlashAt)) { this._preflickerAt = Infinity; return; }
    this._preflickerAt = this._nextFlashAt - this._rand.range(0.28, 0.62);
    this._preflickerAmp = this._rand.range(0.09, 0.22);
  }

  _fireFlash(now) {
    const r = this._rand;
    const distanceKm = clamp(
      r.range(TUNING.distanceMinKm, TUNING.distanceMaxKm),
      TUNING.distanceMinKm, TUNING.distanceMaxKm,
    );
    this._commitStrike(now, distanceKm);

    // advance the authored schedule
    while (this._strikeCursor < this._strikeTimes.length
           && this._strikeTimes[this._strikeCursor] <= now) {
      this._strikeCursor++;
    }
    this._nextFlashAt = this._strikeCursor < this._strikeTimes.length
      ? this._strikeTimes[this._strikeCursor]
      : Infinity;
    this._armPreflicker();
    this._refreshCountdown();
  }

  _commitStrike(now, distanceKm) {
    const r = this._rand;
    this._flashAt = now;
    this._lastStrikeAt = now;
    this.strikeCount++;
    this.flashSeq++;
    this.strikeDistanceKm = distanceKm;

    const near = 1 - distanceKm / TUNING.distanceMaxKm;
    this._flashPeak = clamp01(0.46 + 0.54 * near);

    // A real position, upwind-biased: the storm comes from where the wind comes from.
    const windAng = Math.atan2(this.wind.x, this.wind.z);
    const az = windAng + Math.PI + r.range(-0.9, 0.9);
    const dist = distanceKm * 1000;
    const cam = this.ctx?.camera?.position;
    const ox = cam?.x ?? 0;
    const oz = cam?.z ?? 0;
    this.strikePosition.set(ox + Math.sin(az) * dist, r.range(600, 1500), oz + Math.cos(az) * dist);

    // GAME_DESIGN §7.5 / the brief: a real delay from a real distance. The player counts.
    this._thunderAt = now + dist / TUNING.speedOfSound;
    this._thunderEnvelope = TUNING.envelopeFloor + TUNING.envelopeSpan * near;

    // Sky owns the world flash if it can do it; otherwise Weather's own directional light does.
    let sky = null;
    try { sky = this.ctx?.systems?.get?.('Sky') ?? null; } catch { sky = null; }
    if (typeof sky?.flash === 'function') {
      try { sky.flash(this._flashPeak); }
      catch (e) { Log.once('weather-sky-flash', 'Weather: Sky.flash() threw.', e); }
    }

    Log.debug(`Weather: strike ${this.strikeCount} at ${distanceKm.toFixed(2)} km — `
      + `thunder in ${(dist / TUNING.speedOfSound).toFixed(1)} s, `
      + `${this._thunderEnvelope.toFixed(1)} s of cover.`);
  }

  _arriveThunder(now) {
    const near = 1 - this.strikeDistanceKm / TUNING.distanceMaxKm;
    // Overlapping rolls extend rather than restart — a storm does not reset its own thunder.
    this._rollPeak = Math.max(this._rollPeak * (this._rollEndsAt > now ? 1 : 0), TUNING.maskPeak);
    this._rollHoldUntil = Math.max(this._rollHoldUntil, now + this._thunderEnvelope);
    this._rollEndsAt = this._rollHoldUntil + TUNING.maskDecay;
    this._thunderAt = Infinity;

    const id = this.strikeDistanceKm < 1.2 ? 'thunder.near'
      : this.strikeDistanceKm < 2.8 ? 'thunder.mid' : 'thunder.far';

    this._emit('audio:sfx', {
      id,
      position: this.strikePosition,
      volume: clamp01(0.35 + 0.65 * near),
      rate: lerp(1.06, 0.92, near),
    });

    // §9.8 canonical table: kind `thunder`, radius 400, intensity 1.00. Campers ignore it;
    // it exists so NoiseSystem's mask arithmetic has a source event to reason about.
    this._emit('noise:emit', {
      position: this.strikePosition,
      radius: TUNING.thunderNoiseRadius,
      intensity: TUNING.thunderNoiseIntensity,
      kind: 'thunder',
    });
  }

  /**
   * GAME_DESIGN §7.5: "Weather.nextStrikeIn() returns <= 45 s whenever the player is holding a
   * seating check on an un-torqued join. Enforced, not emergent."
   *
   * BuildSystem should call requestCover() explicitly. Until it does, this polls for any of the
   * property names a seating-check implementation is likely to expose, defensively.
   */
  _pollCoverDemand(now) {
    let wants = this._coverRequestedUntil > now;
    if (!wants) {
      try {
        const bs = this.ctx?.systems?.get?.('BuildSystem');
        if (bs) {
          wants = !!(bs.seatingActive || bs.isSeating || bs.seatingHold
            || (bs.seating && bs.seating.active) || bs.holdingSeatingCheck);
        }
      } catch { wants = false; }
    }
    if (!wants) return;
    if (!this._canStrikeNow(now)) return;
    if (Number.isFinite(this._nextFlashAt) && this._nextFlashAt - now <= TUNING.coverWindow) return;
    if (now - this._lastStrikeAt < TUNING.minStrikeSpacing) return;

    const at = now + this._rand.range(6, TUNING.coverWindow - 4);
    this._nextFlashAt = at;
    this._armPreflicker();
    this._refreshCountdown();
    Log.debug(`Weather: cover requested — inserting a strike in ${(at - now).toFixed(1)} s.`);
  }

  _canStrikeNow(now) {
    if (this._active.strikes <= 0) return false;
    if (this.rain < 0.20 && this.windStrength < 0.45) return false;
    return now - this._lastStrikeAt >= TUNING.minStrikeSpacing;
  }

  // ================================================================ public verbs

  /**
   * GAME_DESIGN §5.4 rubber band. NightManager calls requestWind(+0.15) for 90 s when the
   * player is ahead, requestWind(-0.20) when they are far behind. Never touches detection
   * constants — this is why the band is allowed to exist.
   */
  requestWind(delta, seconds = 90) {
    const d = Number.isFinite(delta) ? clamp(delta, -0.6, 0.6) : 0;
    this._windBiasTarget = d;
    this._windBiasUntil = this._t + (Number.isFinite(seconds) ? Math.max(1, seconds) : 90);
    return this._windBiasTarget;
  }

  /**
   * GAME_DESIGN §7.3: on a settle cascade, BuildSystem "asks Weather for a gust to cover it."
   * The cabin makes a noise and the trees make a noise at the same moment, and the player is
   * never told which one saved them.
   */
  requestGust(strength = 1, delay = 0) {
    const s = clamp(Number.isFinite(strength) ? strength : 1, 0.2, 1.6);
    const wait = Math.max(0, Number.isFinite(delay) ? delay : 0);
    if (this._active.gustAmp <= 0.001) return false;   // Night 6 does not get a favour
    this._gustNextAt = Math.min(this._gustNextAt, this._t + wait);
    this._gustPeak = clamp01(Math.max(this._gustPeak, 0.75 * s));
    return true;
  }

  /**
   * GAME_DESIGN §7.5's guarantee, as an explicit call. Returns true if cover is already inside
   * the window or a strike has been scheduled into it; false if this night has no storm to give.
   */
  requestCover(within = TUNING.coverWindow) {
    const w = clamp(Number.isFinite(within) ? within : TUNING.coverWindow, 5, 180);
    this._coverRequestedUntil = this._t + 2.0;
    if (this.thunderMaskRemaining > 0) return true;
    if (Number.isFinite(this._nextFlashAt) && this._nextFlashAt - this._t <= w) return true;
    this._pollCoverDemand(this._t);
    return Number.isFinite(this._nextFlashAt) && this._nextFlashAt - this._t <= w;
  }

  /** Force a strike. NightManager beats and the debug harness; not part of normal play. */
  strike(opts = {}) {
    const km = clamp(
      Number.isFinite(opts.distanceKm) ? opts.distanceKm : this._rand.range(0.4, 4.2),
      TUNING.distanceMinKm, TUNING.distanceMaxKm,
    );
    if (opts.immediate === false) {
      this._nextFlashAt = this._t + Math.max(0.1, opts.inSeconds ?? 3);
      this._armPreflicker();
      this._refreshCountdown();
      return;
    }
    this._commitStrike(this._t, km);
  }

  /**
   * Local wind, including gust-front travel. A gust does not arrive everywhere at once: it
   * crosses the site at ~13 m/s, so the treeline moves before you do.
   */
  windAt(position, out = _v3d) {
    out.copy(this.wind);
    if (!position) return out;
    const g = this.gustAt(position);
    const base = this.windStrength - this.windGust * this._active.gustAmp;
    const mag = clamp01(base + g * this._active.gustAmp) * TUNING.windUniformScale;
    const len = out.length();
    if (len > 1e-5) out.multiplyScalar(mag / len);
    return out;
  }

  /**
   * Local gust 0..1 for the lantern gutter, canvas flap, and anything else that should not
   * see the global scalar. Sheltered under canopy, stronger with height.
   */
  gustAt(position) {
    if (!position) return this.windGust;
    const cam = this.ctx?.camera?.position;
    const wx = this.wind.x;
    const wz = this.wind.z;
    const wl = Math.hypot(wx, wz);
    let phase = 0;
    if (wl > 1e-4 && cam) {
      const dx = position.x - cam.x;
      const dz = position.z - cam.z;
      phase = ((dx * wx + dz * wz) / wl) / TUNING.gustFrontSpeed;   // seconds of lead/lag
    }
    // Re-evaluate the envelope at the shifted time rather than storing a history buffer.
    let env = this.windGust;
    if (this._gustActive) {
      const e = (this._t - phase) - this._gustStart;
      const total = TUNING.gustAttack + this._gustSustain + TUNING.gustDecay;
      if (e <= 0 || e >= total) env = 0;
      else if (e < TUNING.gustAttack) env = smoothstep01(0, TUNING.gustAttack, e) * this._gustPeak;
      else if (e < TUNING.gustAttack + this._gustSustain) env = 0.92 * this._gustPeak;
      else env = (1 - smoothstep01(TUNING.gustAttack + this._gustSustain, total, e)) * this._gustPeak;
    }
    const shelter = 1 - 0.45 * this._canopyAt(position.x, position.z);
    const height = 1 + 0.22 * clamp01((position.y - 2.0) / 10);
    return clamp01(env * shelter * height);
  }

  /** Cheap canopy density 0..1. Uses Forest when it exists, a seeded field otherwise. */
  _canopyAt(x, z) {
    try {
      const f = this.ctx?.systems?.get?.('Forest');
      const c = f?.canopyAt?.(x, z);
      if (Number.isFinite(c)) return clamp01(c);
    } catch { /* fall through */ }
    const n = fbm2(x * 0.019 + 31.7, z * 0.019 - 12.3, 3, 2.0, 0.5);
    let v = clamp01(0.45 + n * 0.75);
    // The plot and the camp terrace are clearings; nothing drips on the piers.
    const dPlot = Math.hypot(x, z);
    v *= smoothstep01(9, 26, dPlot);
    const dCamp = Math.hypot(x - 18, z - 141);
    v *= smoothstep01(12, 34, dCamp);
    return clamp01(v);
  }

  /** Drop any external pin on rain / fog / lightning (Shots.js, debug). */
  clearPins() {
    this._pin.rain = null;
    this._pin.fog = null;
    this._pin.lightning = null;
  }

  // ================================================================ pins & uniforms

  /**
   * Shots.js writes `weather.rain = x` directly, after every system has updated. Detect a write
   * that did not come from us and honour it until the next night begins, so a canonical
   * screenshot actually shows the weather it asked for.
   */
  _adoptPins() {
    if (this._publishedValid) {
      // Anything that differs from the value the simulation itself last produced was written
      // by somebody else this frame.
      if (this.rain !== this._published.rain) this._pin.rain = clamp01(this.rain);
      if (this.fog !== this._published.fog) this._pin.fog = clamp01(this.fog);
      if (this.lightning !== this._published.lightning) this._pin.lightning = clamp01(this.lightning);
    }
    if (this._pin.rain !== null) this.rain = this._pin.rain;
    if (this._pin.fog !== null) this.fog = this._pin.fog;
    if (this._pin.lightning !== null) this.lightning = this._pin.lightning;
    this._publish();
  }

  _publish() {
    this._published.rain = this.rain;
    this._published.fog = this.fog;
    this._published.lightning = this.lightning;
    this._publishedValid = true;
  }

  _resolveGlobalUniforms() {
    if (this._gu) return this._gu;
    try {
      const m = this.ctx?.systems?.get?.('Materials') ?? null;
      this._materialsSystem = m;
      const gu = m?.globalUniforms ?? m?.constructor?.globalUniforms ?? null;
      if (gu && gu.uRain) { this._gu = gu; return gu; }
    } catch { /* fall through */ }
    return null;
  }

  _writeUniforms(dt) {
    const gu = this._gu ?? this._resolveGlobalUniforms();
    if (!gu) return;

    if (gu.uRain) gu.uRain.value = this.rain;
    if (gu.uWind) gu.uWind.value.copy(this.wind);
    if (gu.uWindDir) {
      const l = this.wind.length();
      if (l > 1e-5) gu.uWindDir.value.copy(this.wind).multiplyScalar(1 / l);
    }
    // Materials computes its own gust from a sine at registration slot 2; Weather runs at 15
    // and overwrites it with the real envelope before the frame is drawn. If you ever move
    // Weather earlier than Materials in main.js, the trees will stop gusting.
    if (gu.uWindGust) gu.uWindGust.value = this.windGust;
    if (gu.uLightning) gu.uLightning.value = this.lightning;

    // Wetness/puddles belong to Materials when it is running. Only drive them standalone.
    if (!this._materialsSystem) {
      if (gu.uWetness) gu.uWetness.value = this.wetness;
      if (gu.uRainAccum) gu.uRainAccum.value = Math.min(1, this.rainAccum);
      if (gu.uPuddle) gu.uPuddle.value = this.puddle;
    }

    this._published.rain = this.rain;
    this._published.fog = this.fog;
    this._published.lightning = this.lightning;

    if (this._lightningLight) {
      this._lightningLight.intensity = 4.5 * this.lightning;
      if (this.lightning > 0.01) {
        _v3a.copy(this.strikePosition).sub(this.ctx?.camera?.position ?? _v3b.set(0, 0, 0));
        _v3a.y = Math.max(_v3a.y, 180);
        this._lightningLight.position.copy(_v3a).normalize().multiplyScalar(320);
        this._lightningLight.target.position.set(0, 0, 0);
      }
    }

    // Height fog: ART §5.1 columns, blended by the front. Numeric-only calls do not allocate;
    // colours do, so they are set once per night in _applyFogProfile.
    if (this._t - this._fogAppliedAt > 0.5) this._applyFogProfile(false);
  }

  _applyFogProfile(withColour) {
    const m = this._materialsSystem;
    if (typeof m?.setFogParams !== 'function') return;
    const prof = FOG_PROFILES[this._active.fogProfile] ?? FOG_PROFILES.clear;
    const clear = FOG_PROFILES.clear;
    const k = clamp01(0.42 + 0.58 * this._frontEnvelope) * clamp01(this.fog / Math.max(0.05, this._active.fog || 0.2));
    const kk = clamp01(k);
    try {
      if (withColour) {
        m.setFogParams({
          D0: lerp(clear.D0, prof.D0, kk),
          H: lerp(clear.H, prof.H, kk),
          g: lerp(clear.g, prof.g, kk),
          farColor: prof.far,
        });
      } else {
        m.setFogParams({
          D0: lerp(clear.D0, prof.D0, kk),
          H: lerp(clear.H, prof.H, kk),
          g: lerp(clear.g, prof.g, kk),
        });
      }
    } catch (e) {
      Log.once('weather-fogparams', 'Weather: Materials.setFogParams() threw.', e);
    }
    this._fogAppliedAt = this._t;
  }

  // ================================================================ events

  _emit(name, payload) {
    if (!this.bus) return;
    try { this.bus.emit(name, payload); }
    catch (e) { Log.once(`weather-emit-${name}`, `Weather: emit '${name}' threw.`, e); }
  }

  _maybeEmitChange() {
    const since = this._t - this._lastChangeAt;
    if (since < TUNING.changeMinInterval) return;
    const lc = this._lastChange;
    const moved = Math.abs(this.rain - lc.rain) > TUNING.changeEpsRain
      || Math.abs(this.windLoad - lc.wind) > TUNING.changeEpsWind
      || Math.abs(this.fog - lc.fog) > TUNING.changeEpsFog;
    if (!moved && since < TUNING.changeHeartbeat) return;
    this._emitChange(false);
  }

  _emitChange() {
    // `wind` in the payload is the SCALAR load, not the vector: BuildSystem's Mw wants a
    // number, and a gust that loads the frame should read as a rise in it. Materials also
    // accepts a float here.
    const payload = { rain: this.rain, wind: this.windLoad, fog: this.fog };
    this._lastChange.rain = this.rain;
    this._lastChange.wind = this.windLoad;
    this._lastChange.fog = this.fog;
    this._lastChangeAt = this._t;
    this._emit('weather:change', payload);
  }

  // ================================================================ rendering

  _ensureLightningLight() {
    let sky = null;
    try { sky = this.ctx?.systems?.get?.('Sky') ?? null; } catch { sky = null; }
    if (typeof sky?.flash === 'function') return;      // Sky owns the flash light
    if (!this.ctx?.scene) return;

    // Created at init with intensity 0 so the lights hash never changes mid-game (a new light
    // at strike time means a shader recompile, i.e. a hitch on the best frame in the game).
    // ART §3.2: DirectionalLight, no shadow, peak 4.5, #c9d6ee. ART §3.6 budgets MAX_DIR 2.
    const l = new THREE.DirectionalLight(0xc9d6ee, 0);
    l.castShadow = false;
    l.position.set(-120, 260, -220);
    l.name = 'weather.lightning';
    this.ctx.scene.add(l);
    this.ctx.scene.add(l.target);
    this._lightningLight = l;
    this._ownsLightningLight = true;
  }

  _buildRain() {
    const scene = this.ctx?.scene;
    if (!scene) return;
    const tier = this.ctx?.settings?.tier?.bind(this.ctx.settings)
      ?? ((a, b, c, d) => d);

    const streakCount = tier(700, 1600, 3000, 4800);
    const rippleCount = tier(24, 48, 96, 160);
    const dripCount = tier(12, 24, 40, 56);

    this.group = new THREE.Group();
    this.group.name = 'Weather';
    this.group.frustumCulled = false;
    scene.add(this.group);

    const rainColor = new THREE.Color(0x8fa6bb);
    const rippleColor = new THREE.Color(0x9fb3c4);

    const commonUniforms = () => ({
      uTime: new THREE.Uniform(0),
      uCamPos: new THREE.Uniform(new THREE.Vector3()),
      uWind: new THREE.Uniform(new THREE.Vector3(0, 0, 0)),
      uRain: new THREE.Uniform(0),
      uShutter: new THREE.Uniform(0.030),
      uPxWidth: new THREE.Uniform(0.0022),
      uShellSize: new THREE.Uniform(new THREE.Vector2(16, 62)),
      uFallSpeed: new THREE.Uniform(9.0),
      uLightning: new THREE.Uniform(0),
      uMoon: new THREE.Uniform(0.35),
      uRainColor: new THREE.Uniform(rainColor),
      uLanternPos: new THREE.Uniform(new THREE.Vector3(0, -999, 0)),
      uLanternAxis: new THREE.Uniform(new THREE.Vector3(0, 0, -1)),
      uLanternParams: new THREE.Uniform(new THREE.Vector4(0.86, 0.97, 0, 22)),
      uFogD0: new THREE.Uniform(0.018),
    });

    // ---- streaks -----------------------------------------------------------------------
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.translate(0, 0.5, 0);          // pivot at the drop head, y in [0,1]

    // Attributes are CLONED into each geometry. Sharing a BufferAttribute between geometries
    // means disposing one geometry deletes the other's GPU buffer — a bug that only shows up
    // in dispose(), i.e. on the night boundary, i.e. in the worst possible place.
    const sGeo = new THREE.InstancedBufferGeometry();
    sGeo.setIndex(quad.index.clone());
    sGeo.setAttribute('position', quad.getAttribute('position').clone());
    sGeo.instanceCount = streakCount;

    const off = new Float32Array(streakCount * 3);
    const par = new Float32Array(streakCount * 4);
    const sed = new Float32Array(streakCount);
    const r = new Rand((this._seed ^ 0x5a17) >>> 0);
    for (let i = 0; i < streakCount; i++) {
      off[i * 3 + 0] = r.next();
      off[i * 3 + 1] = r.next();
      off[i * 3 + 2] = r.next();
      // 62% of the drops live in the near 16 m box: ~50x the volumetric density of the far
      // shell, for a third of the instances. That is the whole trick.
      const shell = i < streakCount * 0.62 ? 0 : 1;
      par[i * 4 + 0] = shell;
      par[i * 4 + 1] = r.range(0.7, 1.5) * (shell ? 1.5 : 1.0);
      par[i * 4 + 2] = r.range(0.7, 1.4) * (shell ? 1.8 : 1.0);
      par[i * 4 + 3] = r.range(0.82, 1.22);
      sed[i] = r.next();
    }
    sGeo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 3));
    sGeo.setAttribute('aParams', new THREE.InstancedBufferAttribute(par, 4));
    sGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(sed, 1));
    sGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this._streakMat = new THREE.ShaderMaterial({
      uniforms: commonUniforms(),
      vertexShader: STREAK_VERT,
      fragmentShader: STREAK_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });

    this._streaks = new THREE.Mesh(sGeo, this._streakMat);
    this._streaks.frustumCulled = false;
    this._streaks.renderOrder = 20;
    this._streaks.name = 'weather.rain';
    this.group.add(this._streaks);

    // ---- canopy drips ------------------------------------------------------------------
    const dGeo = new THREE.InstancedBufferGeometry();
    dGeo.setIndex(quad.index.clone());
    dGeo.setAttribute('position', quad.getAttribute('position').clone());
    dGeo.instanceCount = dripCount;

    const dOff = new Float32Array(dripCount * 3);
    const dPar = new Float32Array(dripCount * 4);
    const dSed = new Float32Array(dripCount);
    for (let i = 0; i < dripCount; i++) {
      dPar[i * 4 + 1] = r.range(1.1, 2.0);     // longer streak: a drip is a fat slow drop
      dPar[i * 4 + 2] = r.range(1.6, 2.6);
      dPar[i * 4 + 3] = TUNING.dripFall;
    }
    this._dripAttr = new THREE.InstancedBufferAttribute(dOff, 3);
    this._dripParamAttr = new THREE.InstancedBufferAttribute(dPar, 4);
    this._dripSeedAttr = new THREE.InstancedBufferAttribute(dSed, 1);
    this._dripAttr.setUsage(THREE.DynamicDrawUsage);
    this._dripSeedAttr.setUsage(THREE.DynamicDrawUsage);
    dGeo.setAttribute('aOffset', this._dripAttr);
    dGeo.setAttribute('aParams', this._dripParamAttr);
    dGeo.setAttribute('aSeed', this._dripSeedAttr);
    dGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this._dripMat = new THREE.ShaderMaterial({
      uniforms: commonUniforms(),
      defines: { DRIP: '1' },
      vertexShader: STREAK_VERT,
      fragmentShader: STREAK_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
    this._dripMat.uniforms.uPxWidth.value = 0.0035;

    this._drips = new THREE.Mesh(dGeo, this._dripMat);
    this._drips.frustumCulled = false;
    this._drips.renderOrder = 21;
    this._drips.name = 'weather.drips';
    this.group.add(this._drips);

    this._dripPool = new Array(dripCount);
    for (let i = 0; i < dripCount; i++) {
      this._dripPool[i] = { active: false, x: 0, y: 0, z: 0, groundY: 0 };
    }

    // ---- splash ripples ----------------------------------------------------------------
    const ring = new THREE.RingGeometry(0.55, 1.0, 18, 1);
    ring.rotateX(-Math.PI / 2);

    const pGeo = new THREE.InstancedBufferGeometry();
    pGeo.setIndex(ring.index.clone());
    pGeo.setAttribute('position', ring.getAttribute('position').clone());
    pGeo.instanceCount = rippleCount;

    const rPos = new Float32Array(rippleCount * 3);
    const rSpawn = new Float32Array(rippleCount);
    const rScale = new Float32Array(rippleCount);
    for (let i = 0; i < rippleCount; i++) { rSpawn[i] = -1; rScale[i] = 0.3; }
    this._ripplePosAttr = new THREE.InstancedBufferAttribute(rPos, 3);
    this._rippleSpawnAttr = new THREE.InstancedBufferAttribute(rSpawn, 1);
    this._rippleScaleAttr = new THREE.InstancedBufferAttribute(rScale, 1);
    this._ripplePosAttr.setUsage(THREE.DynamicDrawUsage);
    this._rippleSpawnAttr.setUsage(THREE.DynamicDrawUsage);
    this._rippleScaleAttr.setUsage(THREE.DynamicDrawUsage);
    pGeo.setAttribute('aPos', this._ripplePosAttr);
    pGeo.setAttribute('aSpawn', this._rippleSpawnAttr);
    pGeo.setAttribute('aScale', this._rippleScaleAttr);
    pGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this._rippleMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: new THREE.Uniform(0),
        uLife: new THREE.Uniform(1.15),
        uLightning: new THREE.Uniform(0),
        uMoon: new THREE.Uniform(0.35),
        uCamPos: new THREE.Uniform(new THREE.Vector3()),
        uFogD0: new THREE.Uniform(0.018),
        uRippleColor: new THREE.Uniform(rippleColor),
      },
      vertexShader: RIPPLE_VERT,
      fragmentShader: RIPPLE_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });

    this._ripples = new THREE.Mesh(pGeo, this._rippleMat);
    this._ripples.frustumCulled = false;
    this._ripples.renderOrder = 19;
    this._ripples.name = 'weather.ripples';
    this.group.add(this._ripples);

    quad.dispose();
    ring.dispose();

    this.resize(this.ctx?.width ?? 1920, this.ctx?.height ?? 1080);
  }

  _updateRain(dt, elapsed) {
    if (!this._streakMat) return;
    const cam = this.ctx?.camera;
    if (!cam) return;

    const su = this._streakMat.uniforms;
    const du = this._dripMat?.uniforms;
    const pu = this._rippleMat?.uniforms;

    // moonlight level (Sky if present, else a constant that matches ART §3.2's 0.06 moon)
    let moon = 0.35;
    try {
      const sky = this.ctx.systems?.get?.('Sky');
      if (Number.isFinite(sky?.moonIntensity)) moon = clamp01(sky.moonIntensity * 5);
    } catch { /* keep the default */ }

    const fogD0 = lerp(0.014, 0.070, clamp01(this.fog));

    su.uTime.value = elapsed;
    su.uCamPos.value.copy(cam.position);
    su.uWind.value.copy(this.wind);
    su.uRain.value = this.rain;
    su.uLightning.value = this.lightning;
    su.uMoon.value = moon;
    su.uFogD0.value = fogD0;
    su.uFallSpeed.value = lerp(6.4, 10.4, clamp01(this.rain));
    su.uShutter.value = 0.030;

    this._readLantern(su.uLanternPos.value, su.uLanternAxis.value, su.uLanternParams.value);

    if (du) {
      du.uTime.value = elapsed;
      du.uCamPos.value.copy(cam.position);
      du.uWind.value.copy(this.wind);
      du.uRain.value = 1;
      du.uLightning.value = this.lightning;
      du.uMoon.value = moon;
      du.uFogD0.value = fogD0;
      du.uLanternPos.value.copy(su.uLanternPos.value);
      du.uLanternAxis.value.copy(su.uLanternAxis.value);
      du.uLanternParams.value.copy(su.uLanternParams.value);
    }
    if (pu) {
      pu.uTime.value = elapsed;
      pu.uCamPos.value.copy(cam.position);
      pu.uLightning.value = this.lightning;
      pu.uMoon.value = moon;
      pu.uFogD0.value = fogD0;
    }

    this._updateDrips(dt, elapsed, cam);
    this._updateRipples(dt, elapsed, cam);
  }

  _readLantern(outPos, outAxis, outParams) {
    let fl = null;
    try { fl = this.ctx.systems?.get?.('Flashlight') ?? null; } catch { fl = null; }
    const on = fl ? (fl.on !== false) : false;
    const light = fl?.light ?? fl?.spot ?? fl?.spotLight ?? null;
    if (!on || !light) {
      outParams.set(0.86, 0.97, 0, 22);
      outPos.set(0, -9999, 0);
      return;
    }
    light.getWorldPosition?.(outPos) ?? outPos.copy(light.position);
    if (light.target) {
      light.target.getWorldPosition?.(_v3c) ?? _v3c.copy(light.target.position);
      outAxis.copy(_v3c).sub(outPos);
      if (outAxis.lengthSq() > 1e-8) outAxis.normalize();
    }
    const angle = Number.isFinite(light.angle) ? light.angle : 0.5;
    const penumbra = Number.isFinite(light.penumbra) ? light.penumbra : 0.4;
    const cosOuter = Math.cos(angle);
    const cosInner = Math.cos(angle * (1 - penumbra * 0.85));
    const hood = Number.isFinite(fl?.hoodLevel) ? (1 - 0.82 * clamp01(fl.hoodLevel)) : 1;
    const range = Number.isFinite(light.distance) && light.distance > 1 ? light.distance : 22;
    outParams.set(cosOuter, cosInner, clamp01(hood), range);
  }

  /**
   * Canopy drips. They charge while it rains and keep falling for minutes after it stops:
   * the forest is still raining when the sky has finished. Delayed, quiet, and the reason a
   * player who waits out a shower is still standing in one.
   */
  _updateDrips(dt, elapsed, cam) {
    const pool = this._dripPool;
    if (!pool) return;
    const terrain = this._terrain();

    const rate = this._dripCharge * pool.length * 0.55;
    this._dripAccum += rate * dt;

    const arr = this._dripAttr.array;
    const seeds = this._dripSeedAttr.array;
    let dirty = false;

    for (let i = 0; i < pool.length; i++) {
      const d = pool[i];
      if (d.active) {
        d.y -= TUNING.dripFall * dt;
        d.x += this.wind.x * 0.10 * dt;
        d.z += this.wind.z * 0.10 * dt;
        if (d.y <= d.groundY) {
          d.active = false;
          seeds[i] = 0;
          this._spawnRipple(d.x, d.groundY, d.z, elapsed, 0.34);
          if (this._dripSfxCooldown <= 0) {
            this._dripSfxCooldown = 0.55;
            _v3b.set(d.x, d.groundY, d.z);
            this._emit('audio:sfx', { id: 'drip', position: _v3b, volume: 0.05 });
          }
        } else {
          arr[i * 3 + 0] = d.x;
          arr[i * 3 + 1] = d.y;
          arr[i * 3 + 2] = d.z;
        }
        dirty = true;
      } else if (this._dripAccum >= 1) {
        this._dripAccum -= 1;
        // A drip site: under canopy, near the player, above head height.
        const ang = this._visRand.range(0, Math.PI * 2);
        const rad = 2.5 + this._visRand.next() * this._visRand.next() * 15;
        const x = cam.position.x + Math.cos(ang) * rad;
        const z = cam.position.z + Math.sin(ang) * rad;
        if (this._canopyAt(x, z) < 0.35) continue;
        const gy = terrain ? (terrain.heightAt?.(x, z) ?? 0) : 0;
        d.active = true;
        d.x = x; d.z = z;
        d.groundY = gy;
        d.y = gy + this._visRand.range(3.2, 7.5);
        seeds[i] = 1;
        arr[i * 3 + 0] = x;
        arr[i * 3 + 1] = d.y;
        arr[i * 3 + 2] = z;
        dirty = true;
      }
    }
    this._dripSfxCooldown -= dt;
    if (dirty) {
      this._dripAttr.needsUpdate = true;
      this._dripSeedAttr.needsUpdate = true;
    }

    // A hard gust in a wet canopy shakes a season of water out of it, and it is loud enough
    // to notice and not loud enough to help.
    if (this.windGust > 0.72 && this._dripCharge > 0.15 && this._gustSfxCooldown <= 0) {
      this._gustSfxCooldown = 3.5;
      this._emit('audio:sfx', {
        id: 'wind.gust',
        volume: clamp01(0.3 + 0.6 * this.windGust),
        rate: lerp(0.94, 1.08, this._visRand.next()),
      });
    }
    this._gustSfxCooldown -= dt;
  }

  _updateRipples(dt, elapsed, cam) {
    if (!this._rippleSpawnAttr) return;
    const terrain = this._terrain();
    // Rain finds water: the lake, the ruts, the puddles the night has been filling.
    const density = this.rain * (0.35 + 0.85 * clamp01(this.puddle + (this._active.rain > 0 ? 0.2 : 0)));
    this._rippleAccum += density * 46 * dt;

    let budget = 6;
    while (this._rippleAccum >= 1 && budget-- > 0) {
      this._rippleAccum -= 1;
      const ang = this._visRand.range(0, Math.PI * 2);
      const rad = 1.2 + this._visRand.next() * this._visRand.next() * 18;
      const x = cam.position.x + Math.cos(ang) * rad;
      const z = cam.position.z + Math.sin(ang) * rad;
      let y = 0;
      let ok = false;
      if (terrain) {
        const surf = terrain.surfaceAt?.(x, z);
        y = terrain.heightAt?.(x, z) ?? 0;
        if (surf === 'water') { ok = true; y = Math.max(y, terrain.waterLevel ?? 0); }
        else if (surf === 'mud' && this.puddle > 0.25) ok = true;
        else if (this.puddle > 0.7 && this._visRand.next() < 0.35) ok = true;
      } else {
        ok = this.puddle > 0.3;
      }
      if (!ok) continue;
      this._spawnRipple(x, y + 0.015, z, elapsed, this._visRand.range(0.22, 0.46));
    }
  }

  _spawnRipple(x, y, z, elapsed, scale) {
    if (!this._rippleSpawnAttr) return;
    const i = this._rippleCursor;
    this._rippleCursor = (i + 1) % this._rippleSpawnAttr.count;
    const p = this._ripplePosAttr.array;
    p[i * 3 + 0] = x;
    p[i * 3 + 1] = y;
    p[i * 3 + 2] = z;
    this._rippleSpawnAttr.array[i] = elapsed;
    this._rippleScaleAttr.array[i] = scale;
    this._ripplePosAttr.needsUpdate = true;
    this._rippleSpawnAttr.needsUpdate = true;
    this._rippleScaleAttr.needsUpdate = true;
  }

  _terrain() {
    try { return this.ctx?.systems?.get?.('Terrain') ?? null; } catch { return null; }
  }
}

export { TUNING as WEATHER_TUNING, NIGHT_WEATHER, FOG_PROFILES };
export default Weather;
