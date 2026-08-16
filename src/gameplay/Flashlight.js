/**
 * THE LANTERN — the player's amber kerosene lamp.
 *
 * The class is called `Flashlight` because `ARCHITECTURE.md §9` and `main.js` say so. It is not
 * a flashlight. It is a pressure lamp with a brass fount, a sooted glass chimney, a wire bail
 * and a sheet-metal hood, and it is simultaneously the only reason the player can read the
 * manual and the single most likely reason they get caught.
 *
 * OWNER: Player agent. Owns exactly this file.
 *
 * ---------------------------------------------------------------------------------------------
 * PUBLIC API — the contract other agents code against
 * ---------------------------------------------------------------------------------------------
 *   const lamp = ctx.systems.get('Flashlight');
 *
 *   lamp.on                     bool    is the wick lit (true the instant ignition starts)
 *   lamp.lit                    bool    getter: on AND actually producing light
 *   lamp.toggle()                       tap: ignite (0.9 s) / douse (0.25 s). Emits noise:emit.
 *   lamp.setOn(bool) / ignite() / douse()
 *   lamp.intensity              0..~1.2 effective multiplier on nominal beam intensity.
 *                                       light.intensity === TUNING.coreIntensity * intensity
 *   lamp.fuel                   0..1    normalized fuel. lamp.fuelUnits is the 0..100 GDD value.
 *   lamp.addFuel(units)                 scavengeable refill. Default 45 (GDD §11.2). Returns added.
 *   lamp.refill()                       fill to capacity.
 *   lamp.light                  THREE.SpotLight  — the shadow-casting core. VolumetricFog reads
 *                                       this and samples its shadow map. Frustum is kept tight:
 *                                       near 0.22, far 16.0, fov tracks light.angle.
 *   lamp.spill                  THREE.SpotLight  — shadowless 6% leak (ART_DIRECTION §3.2)
 *   lamp.glow                   THREE.PointLight — near-field: hands, held lumber, the page
 *   lamp.pageLight              THREE.SpotLight  — manual page bounce (ART_DIRECTION §3.2/§13.8)
 *   lamp.object                 THREE.Group      — the lantern mesh. World-space, spring-lagged.
 *
 *   --- THE HOOD (GAME_DESIGN §9.6, §11.2) --------------------------------------------------
 *   lamp.hoodLevel              0..1    0 = open (see far, be seen far). 1 = shuttered.
 *   lamp.setHood(level)                 set the shutter target directly (Campers/HUD may use it)
 *   lamp.hooded                 bool    getter: hoodLevel > 0.5 — the GDD's binary predicate
 *   lamp.hoodFactor             0..1    1.00 open → 0.18 fully hooded (GDD §9.4)
 *
 *   --- WHAT CAMPERS READ -------------------------------------------------------------------
 *   lamp.visibilityContribution 0..1    THE number. GDD §9.4 `flameVisibility` BEFORE the
 *                                       occlusion test. Instantaneous — it samples this frame's
 *                                       flicker, so a gutter is a real detection spike.
 *   lamp.illumination           0..1    GDD §11.2 `lum` contribution: 0.55 open, 0.22 hooded.
 *   lamp.flamePosition          Vector3 world position of the flame. DO NOT MUTATE. Copy it.
 *   lamp.getFlamePosition(out)          safe copy into your own vector.
 *   lamp.flameVisibilityFor(eye)        optional: does the §9.4 LOS ray via Physics for you.
 *   lamp.flameRateFor(eye, fovSens, diffMul)
 *                                       optional: the whole §9.4 `flameRate` formula, one call,
 *                                       so the constant never diverges between two files.
 *
 *   Flashlight.TUNING / lamp.TUNING     every number in one place.
 *
 * ---------------------------------------------------------------------------------------------
 * NUMBERS AND WHERE THEY COME FROM (nothing here is invented)
 * ---------------------------------------------------------------------------------------------
 *   ART_DIRECTION §3.2   core SpotLight #ffb865, intensity 40, decay 2, angle 0.42, penumbra
 *                        0.55, distance 14, one shadow map. Shadowless spill at angle 0.95,
 *                        intensity 2.4 (6%), distance 9. Held low and LEFT at
 *                        (-0.34, -0.22, -0.45) camera-space, aimed 8° down and 4° left.
 *                        Flicker 1/f at 0.9 Hz ±7% plus a 40 ms hard dropout at 0.4%/s.
 *                        Fully hooded reads at 0.10 intensity, reached over 0.12 s.
 *   AUDIO_DIRECTION §4.2 the lantern's flicker LFO sits at 11.5 Hz. That is the third octave.
 *   GAME_DESIGN §11.2    fuel 100 units, burn 0.55/s open, 0.22/s hooded, can restores 45,
 *                        ignite 0.9 s, douse 0.25 s, lum +0.55 / +0.22, below 15 units the
 *                        flame gutters 0.6–1.0 at 3 Hz and the flicker IS a detection spike.
 *   GAME_DESIGN §9.4     hoodFactor 0.18, flame visible to 180 m, R_flame exponent 1.1,
 *                        flameRate = 0.36 * 0.55 * flameRangeF * flameVisibility * fovSens.
 *   GAME_DESIGN §9.6     hood: cone 35%, intensity 40%, burn 0.22/s. Douse click radius 5.
 *
 * The two hood curves are deliberately different exponents and this is the whole mechanic:
 *
 *     beam / lum   fall as  h^1.35   — back-loaded: you keep most of your working light until
 *                                      the shutter is nearly closed
 *     hoodFactor   falls as h^0.80   — front-loaded: the first third of the shutter buys a
 *                                      disproportionate amount of darkness
 *
 * So a half-hood is genuinely the best trade in the game, which is the only justification for
 * making the shutter analog instead of a toggle. Both curves land exactly on the documents'
 * endpoints at h = 1: beam 0.10 (ART), lum 0.55 × 0.40 = 0.22 (GDD), hoodFactor 0.18 (GDD).
 *
 * ---------------------------------------------------------------------------------------------
 * DOCUMENTED DEVIATIONS (flagged, not hidden)
 * ---------------------------------------------------------------------------------------------
 *   D1  The toggle click emits `kind:'brush'` at radius 5, intensity 0.10. GAME_DESIGN §9.6
 *       specifies "the click is radius 5" but the canonical twelve `noise:emit` kinds contain
 *       nothing metallic and quiet. This follows the precedent AUDIO_DIRECTION §1.2 C4 set for
 *       the player's breathing: take the nearest canonical kind campers actually respond to,
 *       keep the document's radius, and say so out loud. Owner to resolve: Director agent.
 *   D2  ART_DIRECTION §3.2 puts the lantern in the LEFT hand; the brief for this file said
 *       lower-right. ART_DIRECTION is a binding rank-3 document and it is also mechanically
 *       right (GAME_DESIGN §4.3 keeps the right hand for the mallet), so left wins. It is one
 *       number: TUNING.handOffset.x, or call setHandOffset().
 *   D3  sfx ids `lantern_ignite` / `lantern_douse` / `lantern_hood` / `lantern_unhood` /
 *       `lantern_refuel` / `lantern_gutter` do not yet exist in AUDIO_DIRECTION's recipe list.
 *       They are emitted anyway; an unknown id is a no-op in AudioEngine. Owner: Audio agent.
 */

import * as THREE from 'three';
import { Log } from '../core/Log.js';
import { Rand } from '../core/Rand.js';

/* ==============================================================================================
 * Module-scope scratch. ARCHITECTURE.md §12: no allocation in update().
 * ============================================================================================ */
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _v3d = new THREE.Vector3();
const _v3e = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e1 = new THREE.Euler(0, 0, 0, 'YXZ');
const _e2 = new THREE.Euler(0, 0, 0, 'YXZ');
const _colA = new THREE.Color();
const _colB = new THREE.Color();

const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;
/** Frame-rate independent exponential approach. */
const approach = (dt, tau) => 1 - Math.exp(-dt / Math.max(1e-4, tau));

/* ==============================================================================================
 * TUNING — every constant, one place, exported so a tuner never has to read the class.
 * ============================================================================================ */
export const TUNING = {
  /* --- colour ------------------------------------------------------------------------- */
  flameColor: 0xffb865,          // ART_DIRECTION §2.3 `lantern`
  flameColorLow: 0xff5f18,       // what a starved wick reddens to
  pageColor: 0xf2efe6,

  /* --- core spot (ART_DIRECTION §3.2) ------------------------------------------------- */
  coreIntensity: 40,
  coreAngle: 0.42,
  corePenumbra: 0.55,
  coreDistance: 14,
  decay: 2,
  shadowNear: 0.22,
  shadowFar: 16.0,
  shadowBias: -0.00075,
  shadowNormalBias: 0.028,

  /* --- shadowless spill: real lanterns leak ------------------------------------------- */
  spillIntensity: 2.4,
  spillAngle: 0.95,
  spillPenumbra: 1.0,
  spillDistance: 9,

  /* --- near-field glow: the player's own hands and the lumber in them ------------------ */
  glowIntensity: 2.9,
  glowDistance: 3.6,

  /* --- manual page bounce (ART_DIRECTION §3.2 row 9) ---------------------------------- */
  pageIntensity: 3.0,
  pageAngle: 1.2,
  pagePenumbra: 1.0,
  pageDistance: 2.2,

  /* --- where it is carried (ART_DIRECTION §3.2, hard rule) ---------------------------- */
  handOffset: new THREE.Vector3(-0.34, -0.22, -0.45),
  stowOffset: new THREE.Vector3(-0.12, -0.20, 0.16),   // added when both hands are full
  aimPitchDeg: -8,               // 8° down
  aimYawDeg: 4,                  // 4° left
  hoodAimPitchDeg: -31,          // extra downward pitch at full hood: the pool at your feet

  /* --- fuel (GAME_DESIGN §11.2) ------------------------------------------------------- */
  fuelCapacity: 100,
  burnOpen: 0.55,                // units/s → 3:02
  burnHooded: 0.22,              // units/s → 7:35
  canRestores: 45,
  lowFuelUnits: 15,
  gutterHz: 3.0,                 // the low-fuel gutter frequency
  gutterFloor: 0.60,             // low-fuel instantaneous range is 0.60..1.00
  blowoutUnits: 4.0,             // below this a gutter in real wind can put the wick out
  blowoutChance: 0.18,

  /* --- transitions -------------------------------------------------------------------- */
  igniteSeconds: 0.9,
  douseSeconds: 0.25,
  hoodSeconds: 0.42,             // player shutter travel
  hoodPanicSeconds: 0.12,        // ART_DIRECTION §3.2 reflex hood
  tapSeconds: 0.22,              // tap-vs-hold discriminator on Input 'lantern'

  /* --- the hood, as curves (see header) ----------------------------------------------- */
  lumOpen: 0.55,
  hoodLumMul: 0.40,
  hoodBeamMul: 0.10,
  hoodConeMul: 0.35,
  hoodFactorMin: 0.18,
  hoodVisExp: 0.80,
  hoodIntExp: 1.35,

  /* --- flicker ------------------------------------------------------------------------ */
  octaveHz: [0.9, 3.7, 11.5],
  octaveAmp: [0.055, 0.022, 0.010],   // ±0.087 at rest ≈ ART's ±7%
  moveGain: 2.4,                      // flicker amplitude vs normalized speed
  windGain: 1.1,
  microChancePerSec: 0.004,           // ART: 40 ms hard dropout at 0.4%/s
  microSeconds: 0.04,
  microDepth: 0.72,
  majorChancePerSec: 0.020,           // the rare big gutter, scaled by wind/speed/low fuel
  majorSecondsMin: 0.22,
  majorSecondsMax: 0.55,
  majorDepthMin: 0.42,
  majorDepthMax: 0.70,
  flickerMin: 0.16,
  flickerMax: 1.22,

  /* --- carriage: the spring that keeps it off the camera ------------------------------ */
  springK: 96,                   // rad²/s² — stiffness of the hand chase
  springZeta: 0.42,              // deliberately under-damped: it swings
  springSnapDist: 1.2,           // teleport guard
  aimTau: 0.085,                 // beam lags the look by this time constant
  swingPitchGain: 2.4,
  swingRollGain: 3.0,
  swingMaxRad: 0.34,
  bobAmplitude: 0.021,
  bobHz: 1.9,
  footImpulse: 0.75,
  refSpeed: 3.4,                 // speed that counts as "running" for flicker/swing

  /* --- noise (D1) --------------------------------------------------------------------- */
  clickKind: 'brush',
  clickRadius: 5,
  clickIntensity: 0.10,
  shutterRadius: 3,
  shutterIntensity: 0.06,
};

/** GAME_DESIGN §9.4 — the flame percept, kept here so only one file owns the constants. */
export const FLAME_DETECTION = {
  K: 0.36,
  flameWeight: 0.55,
  range: 180,
  rangeExp: 1.1,
  noiseFloor: 0.02,
};

/* ==============================================================================================
 * The class
 * ============================================================================================ */
export class Flashlight {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx?.bus ?? null;
    this.scene = ctx?.scene ?? null;
    this.camera = ctx?.camera ?? null;
    this.settings = ctx?.settings ?? null;
    this.state = ctx?.state ?? null;

    /** @type {typeof TUNING} */
    this.TUNING = TUNING;

    // ---------------------------------------------------------------- public state
    this.on = false;
    this.hoodLevel = 0;
    this.fuel = 1;
    this.intensity = 0;
    this.visibilityContribution = 0;
    this.illumination = 0;
    this.hoodFactor = 1;
    this.flamePosition = new THREE.Vector3();
    /** Live flame colour, recomputed each frame. Read by _applyMesh(). */
    this._flameColorNow = new THREE.Color(TUNING.flameColor);

    /** @type {THREE.SpotLight|null} */ this.light = null;
    /** @type {THREE.SpotLight|null} */ this.spill = null;
    /** @type {THREE.PointLight|null} */ this.glow = null;
    /** @type {THREE.SpotLight|null} */ this.pageLight = null;
    /** @type {THREE.Group|null} */ this.object = null;

    this.stats = {
      fuelUnits: TUNING.fuelCapacity,
      flicker: 1,
      hood: 0,
      visibility: 0,
      speed: 0,
      wind: 0,
    };

    // ---------------------------------------------------------------- internals
    this._fuelUnits = TUNING.fuelCapacity;
    this._ignite = 0;              // 0..1 wick ramp
    this._hoodTarget = 0;
    this._hoodRate = TUNING.hoodSeconds;
    this._flicker = 1;
    this._flameHealth = 1;

    this._gutter = { t: 0, dur: 0, depth: 0 };
    this._micro = { t: 0 };

    this._speed = 0;               // player speed, m/s
    this._speedNorm = 0;
    this._windNorm = 0;
    this._crouched = false;
    this._carryStow = 0;           // 0 = hand free, 1 = both hands full, lamp goes to the belt
    this._carryStowTarget = 0;

    this._handIdeal = new THREE.Vector3();
    this._lagPos = new THREE.Vector3();
    this._lagVel = new THREE.Vector3();
    this._aimDir = new THREE.Vector3(0, 0, -1);
    this._targetObj = null;
    this._pageTargetObj = null;
    this._springAccum = 0;
    this._primed = false;          // has the rig been snapped to the camera at least once

    this._bobPhase = 0;
    this._footKick = 0;
    this._footSign = 1;

    // Input tap-vs-hold discriminator.
    this._keyDown = false;
    this._keyHeld = 0;
    this._tapPending = false;
    this._holdEngaged = false;

    this._pageOpen = false;
    this._sfxHoodLatched = false;

    // Deterministic noise. Seeded from settings so the flicker is reproducible for the
    // screenshot harness (ARCHITECTURE.md §6 — the seeded RNG only, never the global one).
    const seed = (ctx?.settings?.get?.('seed') ?? 0x51a5cab) ^ 0x1a37e5;
    this._rand = new Rand(seed);
    this._tables = [
      this._makeNoiseTable(256),
      this._makeNoiseTable(256),
      this._makeNoiseTable(256),
    ];

    // Owned GPU resources, tracked for dispose().
    this._geoms = [];
    this._mats = [];
    this._textures = [];
    this._unsubs = [];

    // Cached refs, resolved lazily and defensively — every one of these may be missing.
    this._globalUniforms = null;
    this._materialsChecked = false;

    // Animated parts of the mesh, filled in by _buildMesh().
    this._parts = {
      flame: null,
      halo: null,
      glass: null,
      glassSheen: null,
      sleeve: null,
      wick: null,
    };

    this._disposed = false;
  }

  /* ------------------------------------------------------------------------------------------
   * Lifecycle
   * ---------------------------------------------------------------------------------------- */

  async init() {
    try {
      this._adoptFuelFromState();
      this._buildMesh();
      this._buildLights();
      this._bindEvents();
      this._snapToCamera();
      Log.debug('Flashlight: lantern ready,', this._fuelUnits.toFixed(0), 'units of kerosene');
    } catch (e) {
      // A broken lantern must not take down the night.
      Log.error('Flashlight.init failed — the player will build in moonlight.', e);
    }
  }

  update(dt, elapsed) {
    if (this._disposed) return;
    const d = clamp(dt || 0, 0, 0.1);

    this._readWorld(d);
    this._readInput(d);
    this._stepHood(d);
    this._stepFuel(d);
    this._stepFlicker(d, elapsed || 0);
    this._stepCarriage(d);
    this._applyLights();
    this._applyMesh(d);
    this._publish();
  }

  resize(_w, _h) { /* nothing resolution-dependent lives here */ }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    for (const off of this._unsubs) { try { off?.(); } catch { /* noop */ } }
    this._unsubs.length = 0;

    const drop = (o) => { try { o?.parent?.remove(o); } catch { /* noop */ } };

    if (this.light) { this.light.dispose?.(); drop(this.light); }
    if (this.spill) { this.spill.dispose?.(); drop(this.spill); }
    if (this.glow) { this.glow.dispose?.(); drop(this.glow); }
    if (this.pageLight) { this.pageLight.dispose?.(); drop(this.pageLight); }
    drop(this._targetObj);
    drop(this._pageTargetObj);
    if (this.object) drop(this.object);

    for (const g of this._geoms) { try { g.dispose(); } catch { /* noop */ } }
    for (const m of this._mats) { try { m.dispose(); } catch { /* noop */ } }
    for (const t of this._textures) { try { t.dispose(); } catch { /* noop */ } }
    this._geoms.length = 0;
    this._mats.length = 0;
    this._textures.length = 0;

    this.light = null;
    this.spill = null;
    this.glow = null;
    this.pageLight = null;
    this.object = null;
    this._targetObj = null;
    this._pageTargetObj = null;
    this._parts = { flame: null, halo: null, glass: null, glassSheen: null, sleeve: null, wick: null };
  }

  /* ------------------------------------------------------------------------------------------
   * Public verbs
   * ---------------------------------------------------------------------------------------- */

  /**
   * True while there is actually a flame — NOT the same as `on`, which is the input state.
   * Dousing takes 0.25 s and igniting takes 0.9 s, and for those fractions of a second there
   * is still fire in your hand. Campers see it. That is deliberate: tapping F does not make
   * you safe instantly, it makes you safe a quarter-second from now.
   */
  get lit() { return this._ignite > 0.02; }
  get hooded() { return this.hoodLevel > 0.5; }
  get fuelUnits() { return this._fuelUnits; }
  set fuelUnits(v) { this.setFuelUnits(v); }
  get igniting() { return this.on && this._ignite < 0.999; }

  toggle() { return this.setOn(!this.on); }

  ignite() { return this.setOn(true); }

  douse() { return this.setOn(false); }

  /**
   * @param {boolean} v
   * @returns {boolean} the resulting `on` state — false if there was no fuel to light.
   */
  setOn(v) {
    const want = !!v;
    if (want === this.on) return this.on;
    if (want && this._fuelUnits <= 0) {
      // A dry lamp still makes the noise. That is the joke and it is not a funny one.
      this._emitClick(0.6);
      this._sfx('lantern_ignite', 0.5, 1.14);
      return false;
    }
    this.on = want;
    this._emitClick(1.0);
    this._sfx(want ? 'lantern_ignite' : 'lantern_douse', 1.0, want ? 1.0 : 1.06);
    return this.on;
  }

  /**
   * Set the shutter target. 0 = fully open, 1 = fully hooded.
   * @param {number} level
   * @param {number} [seconds] travel time; defaults to the player's 0.42 s. Pass
   *   TUNING.hoodPanicSeconds for the ART_DIRECTION §3.2 reflex hood.
   */
  setHood(level, seconds) {
    this._hoodTarget = clamp01(level);
    this._hoodRate = Number.isFinite(seconds) ? Math.max(0.02, seconds) : TUNING.hoodSeconds;
    return this._hoodTarget;
  }

  hoodClose(seconds) { return this.setHood(1, seconds); }
  hoodOpen(seconds) { return this.setHood(0, seconds); }

  /**
   * Pour in a fuel can. GAME_DESIGN §11.2: a can restores 45 units.
   * @returns {number} units actually added (0 if already full).
   */
  addFuel(units = TUNING.canRestores) {
    const before = this._fuelUnits;
    this.setFuelUnits(this._fuelUnits + (Number.isFinite(units) ? units : 0));
    const added = this._fuelUnits - before;
    if (added > 0.01) this._sfx('lantern_refuel', 0.85, 1.0);
    return added;
  }

  refill() { return this.addFuel(TUNING.fuelCapacity); }

  setFuelUnits(v) {
    const n = Number.isFinite(v) ? v : 0;
    this._fuelUnits = clamp(n, 0, TUNING.fuelCapacity);
    this.fuel = this._fuelUnits / TUNING.fuelCapacity;
    this._writeFuelToState();
    return this._fuelUnits;
  }

  /** ART_DIRECTION §3.2 hard rule is left-hand carry; this is the one number that moves it. */
  setHandOffset(x, y, z) { TUNING.handOffset.set(x, y, z); }

  /** 0 = a hand free, 1 = both hands under a beam and the lamp is on the belt. */
  setCarryLoad(v) { this._carryStowTarget = clamp01(v); }

  /** Safe copy — never hand out `flamePosition` itself. */
  getFlamePosition(out) {
    const v = out ?? new THREE.Vector3();
    return v.copy(this.flamePosition);
  }

  /**
   * GAME_DESIGN §9.4 `flameVisibility`, occlusion included. Optional convenience for Campers —
   * it spends one Physics LOS query (budget 96/frame, ~0.35 µs each).
   * @param {THREE.Vector3} eye camper eye position
   * @returns {number} 0..1
   */
  flameVisibilityFor(eye) {
    if (!this.lit || !eye) return 0;
    const phys = this.ctx?.systems?.get?.('Physics');
    if (phys && typeof phys.lineOfSight === 'function') {
      let clearLine = true;
      try { clearLine = phys.lineOfSight(this.flamePosition, eye) === true; }
      catch { clearLine = true; }
      if (!clearLine) return 0;
    }
    return this.visibilityContribution;
  }

  /**
   * The whole of GAME_DESIGN §9.4 in one call, so the constants never drift between files.
   * `dDetect/dt = max(bodyRate, flameRate)` — the caller still owns that max.
   * @returns {number} detection accrual per second from the flame alone, noise floor applied.
   */
  flameRateFor(eye, fovSens = 1, diffMul = 1) {
    const vis = this.flameVisibilityFor(eye);
    if (vis <= 0) return 0;
    const d = this.flamePosition.distanceTo(eye);
    const rangeF = clamp01(1 - Math.pow(d / FLAME_DETECTION.range, FLAME_DETECTION.rangeExp));
    const rate = FLAME_DETECTION.K * FLAME_DETECTION.flameWeight * rangeF * vis
      * clamp01(fovSens) * (Number.isFinite(diffMul) ? diffMul : 1);
    return rate < FLAME_DETECTION.noiseFloor ? 0 : rate;
  }

  /* ------------------------------------------------------------------------------------------
   * Per-frame stages
   * ---------------------------------------------------------------------------------------- */

  /** Sample the world: player speed, wind, camera. All of it optional. */
  _readWorld(dt) {
    const sys = this.ctx?.systems;

    // Speed. Prefer polling Player (frame-coherent); the player:move listener is the fallback
    // for the frames where Player has not published yet.
    const player = sys?.get?.('Player');
    if (player) {
      if (Number.isFinite(player.speed)) {
        this._speed = player.speed;
      } else if (player.velocity && Number.isFinite(player.velocity.x)) {
        const v = player.velocity;
        this._speed = Math.hypot(v.x, v.z);
      }
      if (typeof player.isCrouched === 'boolean') this._crouched = player.isCrouched;
    }
    this._speedNorm = clamp01(this._speed / TUNING.refSpeed);

    // Wind. Materials owns the canonical uniform; Weather is the fallback.
    if (!this._materialsChecked) {
      this._materialsChecked = true;
      const mats = sys?.get?.('Materials');
      const gu = mats?.globalUniforms;
      if (gu && gu.uWind && gu.uWind.value) this._globalUniforms = gu;
    }
    const gu = this._globalUniforms;
    if (gu) {
      const w = gu.uWind.value;
      const gust = Number.isFinite(gu.uWindGust?.value) ? gu.uWindGust.value : 0;
      this._windNorm = clamp01(Math.hypot(w.x, w.z) / 1.4 * 0.75 + gust * 0.45);
    } else {
      const weather = sys?.get?.('Weather');
      const w = weather?.wind;
      this._windNorm = clamp01(Number.isFinite(w) ? w : 0.2);
    }

    // The carry stow blend.
    this._carryStow += (this._carryStowTarget - this._carryStow) * approach(dt, 0.22);

    // Foot kick decays.
    this._footKick *= Math.exp(-dt * 7.5);
  }

  /**
   * Input: tap toggles, hold hoods. GAME_DESIGN §4.1 binds both to `lantern`.
   * `settings.holdToToggle` accessibility path is honoured if the setting exists.
   */
  _readInput(dt) {
    const input = this.ctx?.systems?.get?.('Input');
    if (!input || typeof input.isDown !== 'function') return;

    // While a real menu is up and a director exists, the lamp does not answer the keyboard.
    const st = this.state;
    if (st && st.phase === 'menu' && this.ctx?.systems?.has?.('NightManager')) return;

    const down = input.isDown('lantern');
    const holdToToggle = this.settings?.get?.('holdToToggle') === true;

    if (down && !this._keyDown) {
      this._keyDown = true;
      this._keyHeld = 0;
      this._tapPending = true;
      this._holdEngaged = false;
    } else if (down) {
      this._keyHeld += dt;
      if (this._tapPending && this._keyHeld >= TUNING.tapSeconds) {
        // Held past the discriminator: this is a hood, not a toggle.
        this._tapPending = false;
        this._holdEngaged = true;
        if (holdToToggle) {
          // Accessibility: one press latches the shutter, a second press releases it.
          this.setHood(this.hoodLevel > 0.5 ? 0 : 1);
        } else {
          this.setHood(1);
        }
      }
    } else if (this._keyDown) {
      this._keyDown = false;
      if (this._tapPending) {
        this.toggle();
      } else if (this._holdEngaged && !holdToToggle) {
        this.setHood(0);
      }
      this._tapPending = false;
      this._holdEngaged = false;
      this._keyHeld = 0;
    }
  }

  /** Shutter travel + the metal cue. */
  _stepHood(dt) {
    const prev = this.hoodLevel;
    const step = dt / this._hoodRate;
    if (this.hoodLevel < this._hoodTarget) {
      this.hoodLevel = Math.min(this._hoodTarget, this.hoodLevel + step);
    } else if (this.hoodLevel > this._hoodTarget) {
      this.hoodLevel = Math.max(this._hoodTarget, this.hoodLevel - step);
    }

    // A real shutter is a two-part sound: the scrape of travel and the latch at the stop.
    // Fire once per direction, on the leading edge, with hysteresis so a jittered key never
    // machine-guns it.
    const h = this.hoodLevel;
    if (!this._sfxHoodLatched && h > 0.08 && h > prev) {
      this._sfxHoodLatched = true;
      this._sfx('lantern_hood', 0.9, 1.0);
      this._emitShutter();
    } else if (this._sfxHoodLatched && h < 0.04 && h < prev) {
      this._sfxHoodLatched = false;
      this._sfx('lantern_unhood', 0.75, 1.05);
      this._emitShutter();
    }

    // GDD §9.4's binary predicate, exposed as a smooth curve that hits 0.18 at h = 1.
    this.hoodFactor = mix(1, TUNING.hoodFactorMin, Math.pow(h, TUNING.hoodVisExp));
  }

  /** Kerosene burns whether or not you are using the light. */
  _stepFuel(dt) {
    // Ignition ramp — 0.9 s up (GDD §11.2), 0.25 s down.
    const target = this.on ? 1 : 0;
    const rate = this.on ? 1 / TUNING.igniteSeconds : 1 / TUNING.douseSeconds;
    if (this._ignite < target) this._ignite = Math.min(1, this._ignite + dt * rate);
    else if (this._ignite > target) this._ignite = Math.max(0, this._ignite - dt * rate);

    if (this.on && this._fuelUnits > 0) {
      const burn = mix(TUNING.burnOpen, TUNING.burnHooded, this.hoodLevel);
      // Only a lit wick burns fuel; the ignition ramp burns proportionally.
      this._fuelUnits = Math.max(0, this._fuelUnits - burn * dt * Math.max(0.35, this._ignite));
      if (this._fuelUnits <= 0) {
        this._fuelUnits = 0;
        this.on = false;
        // It does not click out. It just stops, which is worse.
        this._sfx('lantern_gutter', 0.8, 0.92);
        Log.debug('Flashlight: out of kerosene');
      }
      this.fuel = this._fuelUnits / TUNING.fuelCapacity;
      this._writeFuelToState();
    }

    // Below 15 units the flame is starved: shorter, redder, and it gutters (GDD §11.2).
    this._flameHealth = mix(0.46, 1, clamp01(this._fuelUnits / TUNING.lowFuelUnits));
  }

  /**
   * The flicker model. Three value-noise octaves at 0.9 / 3.7 / 11.5 Hz, a movement and wind
   * gain on their amplitude, the ART_DIRECTION 40 ms micro-dropout, a rarer real gutter, and
   * the GDD's 3 Hz starvation wobble below 15 units. Deterministic: the tables come from the
   * seeded RNG, so two runs of the same seed flicker identically.
   */
  _stepFlicker(dt, elapsed) {
    const T = TUNING;

    // --- continuous octaves
    let amp = 0;
    for (let i = 0; i < 3; i++) {
      amp += (this._noise(elapsed * T.octaveHz[i], i) * 2 - 1) * T.octaveAmp[i];
    }
    const agitation = 1 + T.moveGain * this._speedNorm + T.windGain * this._windNorm;
    amp *= agitation;

    // --- low fuel: a 3 Hz wobble. GDD §11.2 is exact — below 15 units the instantaneous value
    //     swings 0.60..1.00 — so the envelope is a full-depth 0→1 cosine, not a partial one.
    //     Slightly biased low with the 0.85 exponent: a starved wick spends more of its time
    //     down than up, which is what makes it read as dying rather than as a strobe.
    const starve = 1 - clamp01(this._fuelUnits / T.lowFuelUnits);
    let starveDip = 0;
    if (starve > 0) {
      const w = Math.pow(0.5 - 0.5 * Math.cos(elapsed * T.gutterHz * Math.PI * 2), 0.85);
      starveDip = starve * (1 - T.gutterFloor) * w;
    }

    // --- discrete events. Poisson-ish, sampled from the seeded stream (not per-frame noise).
    const eventScale = 1 + 2.2 * this._speedNorm + 3.0 * this._windNorm + 4.0 * starve;

    if (this._micro.t > 0) this._micro.t -= dt;
    else if (this._rand.next() < T.microChancePerSec * eventScale * dt) {
      this._micro.t = T.microSeconds;
    }

    const g = this._gutter;
    if (g.t > 0) {
      g.t -= dt;
      if (g.t <= 0) this._maybeBlowOut();
    } else if (this._rand.next() < T.majorChancePerSec * (eventScale - 1) * dt) {
      g.dur = mix(T.majorSecondsMin, T.majorSecondsMax, this._rand.next());
      g.depth = mix(T.majorDepthMin, T.majorDepthMax, this._rand.next());
      g.t = g.dur;
      if (this.lit) this._sfx('lantern_gutter', 0.35 + 0.4 * g.depth, mix(0.9, 1.2, this._rand.next()));
    }

    let gutterDip = 0;
    if (g.t > 0 && g.dur > 0) {
      // Fast collapse, slow recovery — a flame that has been knocked does not snap back.
      const u = 1 - g.t / g.dur;                       // 0 at onset → 1 at the end
      const env = u < 0.22 ? u / 0.22 : Math.pow(1 - (u - 0.22) / 0.78, 1.7);
      gutterDip = g.depth * env;
    }
    const microDip = this._micro.t > 0 ? T.microDepth : 0;

    this._flicker = clamp(1 + amp - starveDip - gutterDip - microDip, T.flickerMin, T.flickerMax);
  }

  /** Wind can take a starving wick. Rare, late, and it is never a surprise you did not earn. */
  _maybeBlowOut() {
    if (!this.on) return;
    if (this._fuelUnits > TUNING.blowoutUnits) return;
    if (this._windNorm < 0.55) return;
    if (this._rand.next() > TUNING.blowoutChance) return;
    this.on = false;
    this._sfx('lantern_douse', 0.7, 0.95);
    Log.debug('Flashlight: the wind took it');
  }

  /**
   * The carriage. A lantern is a pendulum on a bail, hanging from a fist that is itself
   * attached to a big man walking. Nothing here is bolted to the camera: the body chases the
   * hand on an under-damped spring and hangs plumb; the beam chases the look on a slower
   * filter. That lag is the whole reason it does not read as an amateur FPS.
   */
  _stepCarriage(dt) {
    const cam = this.camera;
    if (!cam || !this.object) return;

    cam.updateMatrixWorld?.();

    // --- head bob and the footstep kick, in camera space
    const bobGain = (this.settings?.get?.('reducedMotion') ? 0.35 : 1)
      * (this.settings?.get?.('headBob') === false ? 0.5 : 1);
    this._bobPhase += dt * TUNING.bobHz * Math.PI * 2 * (0.55 + 1.1 * this._speedNorm);
    if (this._bobPhase > Math.PI * 4) this._bobPhase -= Math.PI * 4;
    const bobY = Math.sin(this._bobPhase) * TUNING.bobAmplitude * this._speedNorm * bobGain;
    const bobX = Math.sin(this._bobPhase * 0.5) * TUNING.bobAmplitude * 0.8 * this._speedNorm * bobGain;

    // --- ideal hand position, camera space → world
    _v3a.copy(TUNING.handOffset);
    _v3a.addScaledVector(TUNING.stowOffset, this._carryStow);
    if (this._crouched) _v3a.y += 0.06;                 // the fist rides higher when folded up
    _v3a.x += bobX;
    _v3a.y += bobY - this._footKick * 0.018 * bobGain;
    this._handIdeal.copy(_v3a).applyMatrix4(cam.matrixWorld);

    if (!this._primed) this._snapToCamera();

    // A teleport (night transition, respawn) must not fling the lamp across the map.
    if (this._lagPos.distanceToSquared(this._handIdeal) > TUNING.springSnapDist * TUNING.springSnapDist) {
      this._lagPos.copy(this._handIdeal);
      this._lagVel.set(0, 0, 0);
    }

    // --- spring, substepped at 120 Hz so a 30 fps frame cannot blow it up
    const k = TUNING.springK;
    const c = 2 * TUNING.springZeta * Math.sqrt(k);
    this._springAccum += dt;
    let steps = 0;
    const H = 1 / 120;
    while (this._springAccum >= H && steps < 8) {
      this._springAccum -= H;
      steps++;
      _v3b.copy(this._handIdeal).sub(this._lagPos).multiplyScalar(k);
      _v3b.addScaledVector(this._lagVel, -c);
      this._lagVel.addScaledVector(_v3b, H);
      this._lagPos.addScaledVector(this._lagVel, H);
    }
    if (steps >= 8) this._springAccum = 0;

    this.object.position.copy(this._lagPos);

    // --- orientation: yaw follows the head, pitch/roll are pendulum only. A hanging lamp
    //     stays plumb no matter where you look, and that is what sells the weight.
    _e1.setFromQuaternion(cam.quaternion, 'YXZ');
    const yaw = _e1.y;

    _v3c.copy(this._handIdeal).sub(this._lagPos);        // lag vector, world
    _q1.setFromAxisAngle(_v3d.set(0, 1, 0), -yaw);
    _v3c.applyQuaternion(_q1);                            // → yaw-local space

    const swingPitch = clamp(_v3c.z * TUNING.swingPitchGain, -TUNING.swingMaxRad, TUNING.swingMaxRad);
    const swingRoll = clamp(-_v3c.x * TUNING.swingRollGain, -TUNING.swingMaxRad, TUNING.swingMaxRad);
    const kick = this._footKick * this._footSign * 0.10;

    _e2.set(swingPitch, yaw, swingRoll + kick, 'YXZ');
    this.object.quaternion.setFromEuler(_e2);
    this.object.updateMatrixWorld(true);

    // --- flame world position: the wick sits inside the chimney, 0.115 m above the fount base
    _v3d.set(0, 0.115, 0);
    this.flamePosition.copy(_v3d).applyMatrix4(this.object.matrixWorld);

    // --- beam aim: camera forward, 8° down and 4° left, plus the hood's extra downward pitch,
    //     then filtered. The beam arrives where you looked a tenth of a second ago.
    const pitch = _e1.x + TUNING.aimPitchDeg * DEG + this.hoodLevel * TUNING.hoodAimPitchDeg * DEG;
    _e2.set(clamp(pitch, -1.45, 1.45), yaw + TUNING.aimYawDeg * DEG, 0, 'YXZ');
    _q2.setFromEuler(_e2);
    _v3e.set(0, 0, -1).applyQuaternion(_q2);
    this._aimDir.lerp(_v3e, approach(dt, TUNING.aimTau));
    if (this._aimDir.lengthSq() < 1e-6) this._aimDir.copy(_v3e);
    this._aimDir.normalize();
  }

  /** Push every computed scalar into the actual Three lights. */
  _applyLights() {
    const T = TUNING;
    const h = this.hoodLevel;

    // The two hood curves. See the header for why they are different exponents.
    const hp = Math.pow(h, T.hoodIntExp);
    const beamMul = mix(1, T.hoodBeamMul, hp);
    const nearMul = mix(1, T.hoodLumMul, hp);
    const coneMul = mix(1, T.hoodConeMul, h);

    const alive = this._ignite * this._flicker * this._flameHealth;
    this.intensity = clamp(alive * beamMul, 0, 1.4);

    // Colour: a starved wick reddens. Also reddens through a gutter, because it is the same
    // physics — less air, less complete combustion.
    _colA.setHex(T.flameColor);
    _colB.setHex(T.flameColorLow);
    const redness = clamp01((1 - this._flameHealth) / 0.54 * 0.85 + (1 - clamp01(this._flicker)) * 0.5);
    // Instance-owned, not module scratch: _applyMesh() reads this on the same frame and a
    // shared scratch colour across two methods is exactly the kind of coupling that breaks
    // silently the first time someone reorders the update stages.
    const flameCol = this._flameColorNow.copy(_colA).lerp(_colB, redness);

    const core = this.light;
    if (core) {
      const on = this.intensity > 0.004;
      core.visible = on;
      core.intensity = T.coreIntensity * this.intensity;
      core.angle = T.coreAngle * coneMul;
      core.penumbra = mix(T.corePenumbra, 0.92, h);       // a shuttered lamp has no hard edge
      core.distance = T.coreDistance * mix(1, 0.45, h);
      core.color.copy(flameCol);
      core.position.copy(this.flamePosition);
      // castShadow is set once from the tier; skip the whole pass when the lamp is dark.
      if (this._shadowCapable) core.castShadow = on && this.intensity > 0.05;
      if (this._targetObj) {
        this._targetObj.position.copy(this.flamePosition).addScaledVector(this._aimDir, 10);
      }
    }

    const spill = this.spill;
    if (spill) {
      spill.visible = this.intensity > 0.004;
      // The spill is a leak, not a beam: it barely narrows and it survives the hood better.
      spill.intensity = T.spillIntensity * alive * mix(1, 0.5, hp);
      spill.angle = T.spillAngle * mix(1, 0.7, h);
      spill.distance = T.spillDistance * mix(1, 0.6, h);
      spill.color.copy(flameCol);
      spill.position.copy(this.flamePosition);
    }

    const glow = this.glow;
    if (glow) {
      // The near field is what lights the player's own hands and the lumber on their shoulder.
      // It is the thing the hood takes away last, which is exactly GDD §9.6's "intensity 40%".
      glow.visible = alive > 0.004;
      glow.intensity = T.glowIntensity * alive * nearMul;
      glow.distance = T.glowDistance * mix(1, 0.72, h);
      glow.color.copy(flameCol);
      glow.position.copy(this.flamePosition);
    }

    const page = this.pageLight;
    if (page) {
      page.visible = this._pageOpen && alive > 0.02;
      if (page.visible && this.camera) {
        page.intensity = T.pageIntensity * alive * mix(1, 0.55, hp);
        // The page hangs in front of the chest; the bounce comes off the paper back at the face.
        _v3a.set(0, -0.30, -0.52).applyMatrix4(this.camera.matrixWorld);
        page.position.copy(_v3a);
        if (this._pageTargetObj) {
          this.camera.getWorldPosition(_v3b);
          this._pageTargetObj.position.copy(_v3b);
        }
      }
    }
  }

  /** Drive the mesh: flame size, glass emissive, shutter travel. */
  _applyMesh(dt) {
    const p = this._parts;
    const alive = clamp(this._ignite * this._flicker * this._flameHealth, 0, 1.4);

    if (p.flame) {
      const vis = alive > 0.01;
      p.flame.visible = vis;
      if (vis) {
        const s = 0.55 + 0.45 * alive;
        p.flame.scale.set(mix(0.72, 1.0, this._flameHealth) * (0.9 + 0.1 * s), s, mix(0.72, 1.0, this._flameHealth) * (0.9 + 0.1 * s));
        // Lateral lean: wind and running push the flame off the wick.
        const lean = (this._windNorm * 0.22 + this._speedNorm * 0.18) * Math.sin(this._bobPhase * 0.7);
        p.flame.rotation.z = lean;
        if (p.flame.material) {
          p.flame.material.opacity = clamp01(0.55 + 0.45 * alive);
          p.flame.material.color.copy(this._flameColorNow);
        }
      }
    }

    if (p.halo) {
      const vis = alive > 0.01;
      p.halo.visible = vis;
      if (vis) {
        const s = 0.6 + 0.9 * alive * mix(1, 0.4, this.hoodLevel);
        p.halo.scale.setScalar(s);
        if (p.halo.material) {
          p.halo.material.opacity = clamp01(0.10 + 0.24 * alive) * mix(1, 0.35, this.hoodLevel);
          p.halo.material.color.copy(this._flameColorNow);
        }
      }
    }

    // The glass catches it. This is the detail that makes the object read as glass rather than
    // as a transparent cylinder: the chimney itself glows, unevenly, through its own soot.
    if (p.glass?.material) {
      p.glass.material.emissiveIntensity = alive * 0.85 * mix(1, 0.5, this.hoodLevel);
      p.glass.material.emissive.copy(this._flameColorNow);
    }
    if (p.glassSheen) {
      p.glassSheen.visible = alive > 0.01;
      if (p.glassSheen.material) {
        p.glassSheen.material.opacity = clamp01(0.06 + 0.20 * alive) * mix(1, 0.45, this.hoodLevel);
        p.glassSheen.material.color.copy(this._flameColorNow);
      }
    }

    if (p.wick?.material) {
      // The wick char glows dull red for a moment after a douse.
      p.wick.material.emissiveIntensity = clamp01(this._ignite * 1.6);
    }

    // The shutter: a sheet-metal sleeve that rises over the chimney.
    if (p.sleeve) {
      const h = this.hoodLevel;
      p.sleeve.visible = h > 0.004;
      p.sleeve.position.y = mix(0.062, 0.128, h);
      p.sleeve.scale.y = mix(0.15, 1.0, h);
      p.sleeve.rotation.y = mix(0, 0.55, h);
    }
  }

  /** Publish the numbers other systems read. */
  _publish() {
    const alive = this._ignite * this._flicker;

    // GDD §11.2: "The flicker is a detection spike — lightF and flameVisibility both sample the
    // instantaneous value." Both of the following are therefore this frame's value, not a mean.
    const hp = Math.pow(this.hoodLevel, TUNING.hoodIntExp);
    const nearMul = mix(1, TUNING.hoodLumMul, hp);

    if (this.lit) {
      // A guttering flame is smaller but it is still a point of fire in a black forest, so its
      // visibility floors well above its illumination.
      const visHealth = 0.45 + 0.55 * this._flameHealth;
      this.visibilityContribution = clamp01(this.hoodFactor * clamp01(alive) * visHealth);
      this.illumination = clamp01(TUNING.lumOpen * nearMul * clamp01(alive) * this._flameHealth);
    } else {
      this.visibilityContribution = 0;
      this.illumination = 0;
    }

    const s = this.stats;
    s.fuelUnits = this._fuelUnits;
    s.flicker = this._flicker;
    s.hood = this.hoodLevel;
    s.visibility = this.visibilityContribution;
    s.speed = this._speed;
    s.wind = this._windNorm;
  }

  /* ------------------------------------------------------------------------------------------
   * Construction
   * ---------------------------------------------------------------------------------------- */

  _buildLights() {
    const scene = this.scene;
    const T = TUNING;
    const tierIdx = this.settings?.tierIndex ?? 3;
    this._shadowCapable = tierIdx >= 1;                    // medium and up (ART §3.3 ledger)

    // --- core, the only shadow caster the player carries
    const core = new THREE.SpotLight(T.flameColor, 0, T.coreDistance, T.coreAngle, T.corePenumbra, T.decay);
    core.name = 'lantern-core';
    core.castShadow = this._shadowCapable;
    // Tight frustum. VolumetricFog samples this map for the cone; a sloppy near/far here is
    // what makes god rays band and swim.
    core.shadow.mapSize.set(
      this.settings?.tier?.(512, 1024, 2048, 2048) ?? 1024,
      this.settings?.tier?.(512, 1024, 2048, 2048) ?? 1024,
    );
    core.shadow.camera.near = T.shadowNear;
    core.shadow.camera.far = T.shadowFar;
    core.shadow.bias = T.shadowBias;
    core.shadow.normalBias = T.shadowNormalBias;
    core.shadow.focus = 1.0;
    core.shadow.camera.updateProjectionMatrix();
    core.visible = false;

    const target = new THREE.Object3D();
    target.name = 'lantern-aim';
    core.target = target;

    // --- spill: no shadow, wide, weak. Real lanterns leak (ART_DIRECTION §3.2).
    const spill = new THREE.SpotLight(T.flameColor, 0, T.spillDistance, T.spillAngle, T.spillPenumbra, T.decay);
    spill.name = 'lantern-spill';
    spill.castShadow = false;
    spill.target = target;
    spill.visible = false;

    // --- near-field: the player's own hands and whatever is in them
    const glow = new THREE.PointLight(T.flameColor, 0, T.glowDistance, T.decay);
    glow.name = 'lantern-glow';
    glow.castShadow = false;
    glow.visible = false;

    // --- manual page bounce (ART_DIRECTION §3.2 row 9, owned by this file)
    const page = new THREE.SpotLight(T.pageColor, 0, T.pageDistance, T.pageAngle, T.pagePenumbra, T.decay);
    page.name = 'lantern-page-bounce';
    page.castShadow = false;
    page.visible = false;
    const pageTarget = new THREE.Object3D();
    pageTarget.name = 'lantern-page-aim';
    page.target = pageTarget;

    this.light = core;
    this.spill = spill;
    this.glow = glow;
    this.pageLight = page;
    this._targetObj = target;
    this._pageTargetObj = pageTarget;

    if (scene) {
      scene.add(core, target, spill, glow, page, pageTarget);
    } else {
      Log.warn('Flashlight: no scene on ctx — the lantern exists but is not in the world.');
    }
  }

  _buildMesh() {
    const T = TUNING;
    const group = new THREE.Group();
    group.name = 'lantern';
    group.matrixAutoUpdate = true;

    const brassTex = this._makeBrassTexture(192);
    const sootTex = this._makeSootTexture(128);

    // ---------------------------------------------------------------- materials
    const matBrass = new THREE.MeshStandardMaterial({
      color: 0x9a7440, metalness: 0.86, roughness: 0.44, map: brassTex ?? null,
    });
    const matBrassDark = new THREE.MeshStandardMaterial({
      color: 0x5e4523, metalness: 0.82, roughness: 0.62, map: brassTex ?? null,
    });
    const matSteel = new THREE.MeshStandardMaterial({
      color: 0x3b3d3f, metalness: 0.88, roughness: 0.54,
    });
    const matSleeve = new THREE.MeshStandardMaterial({
      color: 0x2e3134, metalness: 0.9, roughness: 0.48, side: THREE.DoubleSide,
    });
    const matGlass = new THREE.MeshPhysicalMaterial({
      color: 0xb9c6bd,
      metalness: 0.0,
      roughness: 0.10,
      transparent: true,
      opacity: 0.20,
      side: THREE.DoubleSide,
      depthWrite: false,
      ior: 1.52,
      emissive: new THREE.Color(T.flameColor),
      emissiveIntensity: 0,
      map: sootTex ?? null,
    });
    const matSheen = new THREE.MeshBasicMaterial({
      color: T.flameColor,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
    });
    const matFlame = new THREE.MeshBasicMaterial({
      color: T.flameColor,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const matHalo = new THREE.MeshBasicMaterial({
      color: T.flameColor,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
    });
    const matWick = new THREE.MeshStandardMaterial({
      color: 0x120d0a, roughness: 1.0, metalness: 0,
      emissive: new THREE.Color(0xff3a08), emissiveIntensity: 0,
    });
    this._mats.push(matBrass, matBrassDark, matSteel, matSleeve, matGlass, matSheen, matFlame, matHalo, matWick);

    // ---------------------------------------------------------------- geometry
    // Everything is in metres. Overall height ~0.22 m, fount radius 0.046 m — a real
    // hurricane lamp, held 0.45 m from the eye, so it occupies the lower-left of frame.

    // Fount: a squat brass reservoir with a rolled foot.
    const fountProfile = [
      [0.000, 0.000], [0.030, 0.000], [0.044, 0.006], [0.047, 0.016],
      [0.046, 0.032], [0.040, 0.044], [0.030, 0.051], [0.022, 0.055],
      [0.021, 0.060], [0.000, 0.060],
    ];
    const gFount = this._lathe(fountProfile, 24);
    const fount = new THREE.Mesh(gFount, matBrass);
    fount.name = 'lantern-fount';
    group.add(fount);

    // Burner gallery — the perforated collar the chimney sits in.
    const gCollar = new THREE.CylinderGeometry(0.026, 0.023, 0.016, 20, 1, true);
    this._geoms.push(gCollar);
    const collar = new THREE.Mesh(gCollar, matBrassDark);
    collar.position.y = 0.068;
    group.add(collar);

    const gCrown = new THREE.TorusGeometry(0.026, 0.0035, 6, 20);
    this._geoms.push(gCrown);
    const crown = new THREE.Mesh(gCrown, matBrassDark);
    crown.rotation.x = Math.PI / 2;
    crown.position.y = 0.077;
    group.add(crown);

    // The wick and its knurled adjuster — the small honest detail that reads at 0.45 m.
    const gWick = new THREE.BoxGeometry(0.013, 0.010, 0.0022);
    this._geoms.push(gWick);
    const wick = new THREE.Mesh(gWick, matWick);
    wick.position.y = 0.082;
    group.add(wick);

    const gKnob = new THREE.CylinderGeometry(0.008, 0.008, 0.004, 12);
    this._geoms.push(gKnob);
    const knob = new THREE.Mesh(gKnob, matSteel);
    knob.rotation.z = Math.PI / 2;
    knob.position.set(0.030, 0.062, 0);
    group.add(knob);

    // Glass chimney: bulges over the flame, waists, then flares at the top.
    const chimneyProfile = [
      [0.024, 0.078], [0.030, 0.092], [0.032, 0.108], [0.030, 0.126],
      [0.024, 0.144], [0.021, 0.158], [0.023, 0.168],
    ];
    const gGlass = this._lathe(chimneyProfile, 24, true);
    const glass = new THREE.Mesh(gGlass, matGlass);
    glass.name = 'lantern-chimney';
    glass.renderOrder = 3;
    group.add(glass);

    // A back-side additive shell inside the glass: this is what makes the chimney *catch*
    // the light instead of merely being see-through.
    const gSheen = this._lathe(chimneyProfile.map(([r, y]) => [r * 0.94, y]), 20, true);
    const sheen = new THREE.Mesh(gSheen, matSheen);
    sheen.renderOrder = 4;
    group.add(sheen);

    // Top guard: four wire uprights and a cap ring.
    const gUpright = new THREE.CylinderGeometry(0.0016, 0.0016, 0.095, 5);
    this._geoms.push(gUpright);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const up = new THREE.Mesh(gUpright, matSteel);
      up.position.set(Math.cos(a) * 0.033, 0.124, Math.sin(a) * 0.033);
      group.add(up);
    }
    const gCap = new THREE.TorusGeometry(0.030, 0.0028, 6, 18);
    this._geoms.push(gCap);
    const cap = new THREE.Mesh(gCap, matSteel);
    cap.rotation.x = Math.PI / 2;
    cap.position.y = 0.172;
    group.add(cap);

    // Wire bail handle — a half torus on two lugs, hanging back over the top.
    const gBail = new THREE.TorusGeometry(0.040, 0.0022, 6, 22, Math.PI);
    this._geoms.push(gBail);
    const bail = new THREE.Mesh(gBail, matSteel);
    bail.position.y = 0.176;
    bail.rotation.z = 0;
    bail.rotation.y = 0.12;
    group.add(bail);

    const gLug = new THREE.CylinderGeometry(0.0026, 0.0026, 0.006, 8);
    this._geoms.push(gLug);
    for (let i = 0; i < 2; i++) {
      const lug = new THREE.Mesh(gLug, matSteel);
      lug.rotation.z = Math.PI / 2;
      lug.position.set(i === 0 ? 0.030 : -0.030, 0.174, 0);
      group.add(lug);
    }

    // THE HOOD. A sheet-metal sleeve that rises over the chimney. It is the mechanic, so it
    // is also the most legible moving part on the object.
    const gSleeve = new THREE.CylinderGeometry(0.036, 0.036, 0.096, 20, 1, true, 0, Math.PI * 1.62);
    this._geoms.push(gSleeve);
    const sleeve = new THREE.Mesh(gSleeve, matSleeve);
    sleeve.name = 'lantern-hood';
    sleeve.position.y = 0.062;
    sleeve.scale.y = 0.15;
    sleeve.visible = false;
    group.add(sleeve);

    // Flame: a teardrop lathe on the wick, additive.
    const flameProfile = [
      [0.0000, 0.000], [0.0042, 0.004], [0.0058, 0.011], [0.0052, 0.020],
      [0.0034, 0.029], [0.0014, 0.036], [0.0000, 0.040],
    ];
    const gFlame = this._lathe(flameProfile, 12);
    const flame = new THREE.Mesh(gFlame, matFlame);
    flame.name = 'lantern-flame';
    flame.position.y = 0.086;
    flame.renderOrder = 6;
    flame.visible = false;
    group.add(flame);

    // Halo: the bloom seed. ART_DIRECTION §2.4 lets the lantern hotspot clip AgX; this is it.
    const gHalo = new THREE.SphereGeometry(0.030, 10, 8);
    this._geoms.push(gHalo);
    const halo = new THREE.Mesh(gHalo, matHalo);
    halo.name = 'lantern-halo';
    halo.position.y = 0.100;
    halo.renderOrder = 7;
    halo.visible = false;
    group.add(halo);

    this._parts.flame = flame;
    this._parts.halo = halo;
    this._parts.glass = glass;
    this._parts.glassSheen = sheen;
    this._parts.sleeve = sleeve;
    this._parts.wick = wick;

    this.object = group;
    if (this.scene) this.scene.add(group);
  }

  _bindEvents() {
    const bus = this.bus;
    if (!bus || typeof bus.on !== 'function') return;
    const keep = (fn) => { if (typeof fn === 'function') this._unsubs.push(fn); };

    // Speed fallback for the frames Player has not been polled on.
    keep(bus.on('player:move', (p) => {
      if (p && Number.isFinite(p.speed)) this._speed = p.speed;
      if (p && typeof p.crouched === 'boolean') this._crouched = p.crouched;
    }));

    // A footstep kicks the pendulum. `loud` is 0..1 in the canonical payload.
    keep(bus.on('player:footstep', (p) => {
      const loud = p && Number.isFinite(p.loud) ? clamp01(p.loud) : 0.4;
      this._footKick = Math.min(1.4, this._footKick + TUNING.footImpulse * (0.4 + loud));
      this._footSign = -this._footSign;
      this._lagVel.y -= 0.06 * (0.4 + loud);
    }));

    // The manual needs light on it; ART_DIRECTION gives that light to this file.
    keep(bus.on('ui:blueprint-open', () => { this._pageOpen = true; }));
    keep(bus.on('ui:blueprint-close', () => { this._pageOpen = false; }));

    // A full lamp at dusk. He fills it before he starts; he does not light it until he needs it.
    keep(bus.on('night:begin', () => {
      this.setFuelUnits(TUNING.fuelCapacity);
      this.on = false;
      this._ignite = 0;
      this.setHood(0, 0.05);
      this.hoodLevel = 0;
      this._sfxHoodLatched = false;
      this._primed = false;
    }));

    const kill = () => { this.on = false; this._pageOpen = false; };
    keep(bus.on('night:complete', kill));
    keep(bus.on('night:failed', kill));

    // Hands full → the lamp goes to the belt and swings a great deal more.
    keep(bus.on('build:pickup', (p) => {
      const m = p?.part?.mass;
      this.setCarryLoad(Number.isFinite(m) ? clamp01((m - 6) / 30) : 0.7);
    }));
    const freeHands = () => this.setCarryLoad(0);
    keep(bus.on('build:drop', freeHands));
    keep(bus.on('build:place', freeHands));

    // Weather is the wind fallback when Materials is absent.
    keep(bus.on('weather:change', (p) => {
      if (!this._globalUniforms && p && Number.isFinite(p.wind)) this._windNorm = clamp01(p.wind);
    }));

    // Shadow map size follows the tier.
    keep(bus.on('settings:changed', ({ key } = {}) => {
      if (key !== 'quality' && key !== '*') return;
      const size = this.settings?.tier?.(512, 1024, 2048, 2048) ?? 1024;
      this._shadowCapable = (this.settings?.tierIndex ?? 3) >= 1;
      if (this.light) {
        this.light.shadow.mapSize.set(size, size);
        this.light.shadow.map?.dispose?.();
        this.light.shadow.map = null;
        this.light.castShadow = this._shadowCapable;
      }
    }));
  }

  /* ------------------------------------------------------------------------------------------
   * Helpers — kept in this file because it owns exactly one file (golden rule 1)
   * ---------------------------------------------------------------------------------------- */

  /** @param {number[][]} profile [radius, y] pairs */
  _lathe(profile, segments, openEnded = false) {
    const pts = [];
    for (const [r, y] of profile) pts.push(new THREE.Vector2(r, y));
    const g = new THREE.LatheGeometry(pts, segments);
    if (openEnded) g.computeVertexNormals();
    this._geoms.push(g);
    return g;
  }

  _makeNoiseTable(n) {
    const t = new Float32Array(n);
    for (let i = 0; i < n; i++) t[i] = this._rand.next();
    return t;
  }

  /** Smoothed 1D value noise over a fixed table. Deterministic, allocation-free, ~8 ns. */
  _noise(x, channel) {
    const tab = this._tables[channel] ?? this._tables[0];
    const n = tab.length;
    const xf = Math.floor(x);
    const f = x - xf;
    const i0 = ((xf % n) + n) % n;
    const i1 = (i0 + 1) % n;
    const u = f * f * (3 - 2 * f);
    return tab[i0] + (tab[i1] - tab[i0]) * u;
  }

  _snapToCamera() {
    const cam = this.camera;
    if (!cam) return;
    cam.updateMatrixWorld?.();
    _v3a.copy(TUNING.handOffset).applyMatrix4(cam.matrixWorld);
    this._lagPos.copy(_v3a);
    this._handIdeal.copy(_v3a);
    this._lagVel.set(0, 0, 0);
    cam.getWorldDirection(this._aimDir);
    if (this._aimDir.lengthSq() < 1e-6) this._aimDir.set(0, 0, -1);
    this.flamePosition.copy(_v3a).setY(_v3a.y + 0.115);
    if (this.object) this.object.position.copy(_v3a);
    this._primed = true;
  }

  /* ------------------------------------------------------------------- procedural textures */

  _canvasTexture(size, fill) {
    const doc = globalThis.document;
    if (!doc || typeof doc.createElement !== 'function') return null;
    try {
      const c = doc.createElement('canvas');
      c.width = size;
      c.height = size;
      const g = c.getContext('2d');
      if (!g) return null;
      const img = g.createImageData(size, size);
      fill(img.data, size);
      g.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(c);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      this._textures.push(tex);
      return tex;
    } catch (e) {
      Log.once('lantern-tex', 'Flashlight: canvas texture unavailable, using flat materials.', e);
      return null;
    }
  }

  /** Brass with a lifetime of handling on it: verdigris in the low spots, polish on the high. */
  _makeBrassTexture(size) {
    const rand = new Rand((this.settings?.get?.('seed') ?? 0) ^ 0xb2a55);
    const tab = new Float32Array(64);
    for (let i = 0; i < 64; i++) tab[i] = rand.next();
    const noise = (x, y) => {
      const xi = Math.floor(x) & 7, yi = Math.floor(y) & 7;
      const xf = x - Math.floor(x), yf = y - Math.floor(y);
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      const a = tab[(yi * 8 + xi) & 63];
      const b = tab[(yi * 8 + ((xi + 1) & 7)) & 63];
      const c = tab[(((yi + 1) & 7) * 8 + xi) & 63];
      const d = tab[(((yi + 1) & 7) * 8 + ((xi + 1) & 7)) & 63];
      return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
    };
    return this._canvasTexture(size, (data, n) => {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const u = x / n, v = y / n;
          const grain = noise(u * 7, v * 7) * 0.55 + noise(u * 23, v * 23) * 0.30 + noise(u * 61, v * 61) * 0.15;
          const streak = 0.5 + 0.5 * Math.sin(v * 41 + grain * 5);
          const patina = Math.max(0, grain - 0.62) * 2.4;
          const k = 0.72 + grain * 0.42 + streak * 0.10;
          const i = (y * n + x) * 4;
          data[i] = clamp(196 * k - patina * 90, 0, 255);
          data[i + 1] = clamp(148 * k - patina * 20, 0, 255);
          data[i + 2] = clamp(78 * k + patina * 62, 0, 255);
          data[i + 3] = 255;
        }
      }
    });
  }

  /** Soot on the chimney: heavier at the top, streaked where a thumb has wiped it. */
  _makeSootTexture(size) {
    const rand = new Rand((this.settings?.get?.('seed') ?? 0) ^ 0x50075);
    const tab = new Float32Array(64);
    for (let i = 0; i < 64; i++) tab[i] = rand.next();
    return this._canvasTexture(size, (data, n) => {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const u = x / n, v = y / n;
          const t = tab[(((y >> 3) & 7) * 8 + ((x >> 3) & 7)) & 63];
          const streak = 0.5 + 0.5 * Math.sin(u * 29 + t * 9);
          // v = 0 at the base of the lathe profile, 1 at the top: soot climbs.
          const soot = clamp01(Math.pow(v, 1.6) * (0.55 + 0.45 * t) * (0.6 + 0.4 * streak));
          const k = clamp(232 - soot * 178, 0, 255);
          const i = (y * n + x) * 4;
          data[i] = k;
          data[i + 1] = clamp(k * 1.01, 0, 255);
          data[i + 2] = clamp(k * 0.97, 0, 255);
          data[i + 3] = 255;
        }
      }
    });
  }

  /* ------------------------------------------------------------------------- state plumbing */

  _adoptFuelFromState() {
    const st = this.state;
    if (!st) return;
    // GAME_DESIGN §20.2 requests `lanternFuel` on GameState but ARCHITECTURE §8 does not carry
    // it yet. Adopt it if it is there; otherwise own the number here and never add a field to
    // somebody else's save file.
    if (Number.isFinite(st.lanternFuel)) {
      this._ownsFuelField = true;
      this.setFuelUnits(st.lanternFuel);
    } else {
      this._ownsFuelField = false;
      this.fuel = this._fuelUnits / TUNING.fuelCapacity;
    }
  }

  _writeFuelToState() {
    if (this._ownsFuelField && this.state) this.state.lanternFuel = this._fuelUnits;
  }

  /* ------------------------------------------------------------------------------ emitters */

  /**
   * D1: the metallic click. GAME_DESIGN §9.6 fixes radius 5; the canonical kind list has no
   * quiet metallic entry, so this follows AUDIO_DIRECTION §1.2 C4's precedent and uses the
   * nearest canonical kind campers actually respond to.
   */
  _emitClick(scale = 1) {
    if (!this.bus) return;
    this.bus.emit('noise:emit', {
      // A fresh vector, not `flamePosition` — a listener may hold the payload for a second
      // and a live reference would drift with the player. These fire a handful of times a
      // night, so the allocation is free and the aliasing bug it prevents is not.
      position: this.flamePosition.clone(),
      radius: TUNING.clickRadius * scale,
      intensity: TUNING.clickIntensity * scale,
      kind: TUNING.clickKind,
    });
  }

  _emitShutter() {
    if (!this.bus) return;
    this.bus.emit('noise:emit', {
      position: this.flamePosition.clone(),
      radius: TUNING.shutterRadius,
      intensity: TUNING.shutterIntensity,
      kind: TUNING.clickKind,
    });
  }

  _sfx(id, volume = 1, rate = 1) {
    if (!this.bus) return;
    this.bus.emit('audio:sfx', { id, position: this.flamePosition.clone(), volume, rate });
  }
}

Flashlight.TUNING = TUNING;
Flashlight.FLAME_DETECTION = FLAME_DETECTION;

export default Flashlight;
