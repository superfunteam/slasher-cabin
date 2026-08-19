/**
 * Player.js — the first-person controller.
 *
 * OWNER: Player agent. Owns the camera transform, the capsule, stamina, carry, and fear.
 *
 * ---------------------------------------------------------------------------------------------
 * THE BRIEF, IN ONE LINE
 *
 * He is 6'6" and 280 lb (STORY §2.1) and he is not in a hurry. Every number below exists to make
 * the player feel that before a single word is written on screen. Weight is expressed as
 * acceleration limits, turn limits and lag — never as a scripted animation and never as a joke.
 *
 * ---------------------------------------------------------------------------------------------
 * WHERE THE NUMBERS COME FROM (all binding; nothing here is invented where a doc gives a value)
 *
 *   GAME_DESIGN §10.1  walk 1.60 / crouch 0.90 / sprint 4.20 m/s, accel 7.0, decel 9.0,
 *                      sprint spin-up 1.9 s, step height 0.45, turn cap 220°/s, turn accel
 *                      1400°/s², crouch transition 0.42 s down / 0.55 s up.
 *   GAME_DESIGN §10.2  stamina 100, drain 16.0/s × (1 + 0.6·carryNorm), regen delay 2.2 s,
 *                      regen 11.0/s (15.0/s crouched), exhausted lock until 35.
 *   GAME_DESIGN §6.2   carry classes A/B/C/D/end-lift/E: speed ×, turn ×, crouch/sprint gates,
 *                      footstep-noise ×, 4 part slots.
 *   GAME_DESIGN §3.6   ground types: duff/mud/rock/deadfall — speed × and footstep noise ×.
 *   GAME_DESIGN §9.8   the canonical noise:emit table. Player owns `footstep`, `brush`, `drop`,
 *                      `drag`. Radii and intensities are copied verbatim.
 *   GAME_DESIGN §9.6   crouch eye height, freeze, douse — the verbs.
 *   ART §9.1           FOV 72 / 78 sprint / 68 crouch-still / 62 blueprint. Eye 1.70 / 1.06.
 *   ART §9.2           the handheld model: breathing, 1/f micro-tremor at ±0.09° RMS, the
 *                      figure-8 footstep sway, the landing dip, and the look-lag spring.
 *   ART §9.5           DETECTION IS NOT A LENS EFFECT. Nothing in this file changes exposure,
 *                      FOV, CA or vignette because a camper saw him. Fear moves breathing and
 *                      the tremor and nothing else visual. See `fear` below.
 *   STORY §2.4.1       `handState` — read by BlueprintUI to time the hand-wipe.
 *
 * ---------------------------------------------------------------------------------------------
 * TWO DOCUMENTED CONFLICTS, RESOLVED HERE IN WRITING
 *
 * 1. TURN RATE. GAME_DESIGN §10.1 says cap 220°/s, accel 1400°/s² (and derives "a 180° turn takes
 *    0.71 s" from it). ART §9.2 says the view lags through a critically-damped spring ω = 22,
 *    ζ = 1.0, with turn acceleration clamped to 520°/s². These are not the same quantity and both
 *    are implemented, in series:
 *        mouse → AIM TARGET   (rate-limited: 220°/s cap, 1400°/s² accel — GAME_DESIGN's number,
 *                              and it is what preserves GAME_DESIGN's own 0.71 s arithmetic)
 *             → RENDERED VIEW (follows the aim target through ART's ω = 22 / ζ = 1.0 spring with
 *                              its angular acceleration clamped at 520°/s²)
 *    The aim target is the gameplay authority (it is what the interaction ray uses); the rendered
 *    view is presentation. A flick therefore resolves as a heavy sweep that arrives late, which is
 *    exactly ART's "he physically cannot whip round to look at what spotted him".
 *
 * 2. CROUCH EYE HEIGHT. GAME_DESIGN §9.6 says 1.15 m; ART §9.1 says 1.06 m; Physics TUNING has
 *    `crouchHeight = 1.15`. Both are right about different things: 1.15 is the CAPSULE height and
 *    1.06 is the EYE. Standing is 1.80 capsule / 1.70 eye — the same 0.09–0.10 m of skull above
 *    the eye in both poses, so the two documents are consistent once you notice which is which.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT DO
 *
 *   - It does not jump. There is no jump verb in GAME_DESIGN §9.6 and there will not be one.
 *   - It does not throw. GAME_DESIGN §9.6 deletes the throw verb ("You do not throw things. You
 *     are a carpenter."), so the `throwPart` binding is wired to the silent 2.1 s SET DOWN.
 *   - It does not emit `build:*`. Those belong to BuildSystem even when BuildSystem is absent.
 *   - It does not let fear touch control. Fear is a camera property. The slasher is never panicked.
 *
 * ---------------------------------------------------------------------------------------------
 * THE VERBS THIS FILE OWNS THE KEYS FOR
 *
 *   E                interact / place / repair — forwarded to BuildSystem's hooks
 *   Q  tap           drop, loud (§4.1)                         requires a part in hand
 *   Q  hold 2.1 s    set down, silent (§4.1)                   requires a part in hand
 *   Q  hold 1.1 s    PRY OUT — `BuildSystem.removeJoin()`      requires EMPTY hands + a join
 *   G  hold 2.1 s    set down, silent (§9.6 deleted the throw)
 *
 * The three `Q` verbs are disjoint by hand state, not by convention — see `_updatePry`.
 */

import * as THREE from 'three';
import { Log } from '../core/Log.js';
import { Rand } from '../core/Rand.js';

// =================================================================================================
// Tuning — every constant traceable to a document section.
// =================================================================================================

const T = {
  // --- capsule (GAME_DESIGN §10, Physics TUNING)
  radius: 0.42,             // "wide — you bump things"
  standHeight: 1.80,
  crouchHeight: 1.15,
  standEye: 1.70,
  crouchEye: 1.06,          // ART §9.1
  gravity: -22.0,           // ARCHITECTURE §2. Physics does not apply it; we integrate it.

  // --- speeds (GAME_DESIGN §10.1)
  walkSpeed: 1.60,
  crouchSpeed: 0.90,
  sprintSpeed: 4.20,
  accel: 7.0,               // m/s²  — peak. Reached through the jerk limiter below.
  decel: 9.0,               // m/s²  — peak.
  airControl: 0.18,
  stepHeight: 0.45,         // matches Physics TUNING; used only to clamp the step-up smoothing
  sprintSpinUp: 1.9,        // s, walk → sprint
  sprintSpinDown: 0.55,     // s, sprint → walk on release (undocumented; kept short so letting go
                            // of shift is honest, while getting up to speed is not)

  // Jerk limits. GAME_DESIGN gives peak accel/decel; it does not say how fast that peak arrives.
  // A heavy man does not apply 7 m/s² in the first millisecond. These do NOT change the documented
  // peaks — they only ramp toward them, which is what turns 0.23 s into a ~0.35 s departure and a
  // ~0.30 s stop. This is the whole "you cannot stop dead" requirement.
  accelJerk: 42.0,          // m/s³ toward the accel peak
  decelJerk: 30.0,          // m/s³ toward the decel peak — releasing is slower than committing

  // --- look (see conflict note 1 above)
  degPerPixel: 0.20,        // at settings.mouseSensitivity === 1.0
  aimRateCap: 220,          // °/s   GAME_DESIGN §10.1
  aimAccel: 1400,           // °/s²  GAME_DESIGN §10.1
  viewSpringW: 22.0,        // rad/s ART §9.2
  viewAccelCap: 520,        // °/s²  ART §9.2
  viewSprintExtraLag: 0.06, // s     ART §9.2 "Sprint adds 0.06 s more lag"
  pitchClamp: 88,           // degrees

  // --- body yaw (the thing that makes a big man feel big)
  bodyTurnRate: 190,        // °/s — how fast the hips can chase a new heading
  bodyTurnAccel: 900,       // °/s²
  bodySquareUpRate: 70,     // °/s — when standing still he squares up to the view, slowly

  // --- crouch (GAME_DESIGN §10.1)
  crouchDownTime: 0.42,
  crouchUpTime: 0.55,

  // --- stamina (GAME_DESIGN §10.2)
  staminaMax: 100,
  sprintDrain: 16.0,
  regenDelay: 2.2,
  regenRate: 11.0,
  regenRateCrouched: 15.0,
  exhaustRecover: 35,
  carryMassRef: 70,         // kg — top of class D; normalises carryMass for the drain formula

  // --- footfall cadence. ART §9.2 gives step RATES at the documented gait speeds; we store them
  // as STRIDE LENGTHS (speed / rate) so cadence scales with actual speed instead of moonwalking.
  strideWalk: 1.60 / 1.45,        // 1.103 m  → 1.45 Hz at 1.60 m/s
  strideSprint: 4.20 / 2.35,      // 1.787 m  → 2.35 Hz at 4.20 m/s
  strideCrouch: 0.90 / 0.85,      // 1.059 m  → 0.85 Hz at 0.90 m/s
  strideCarry: 1.008 / 1.20,      // 0.840 m  → 1.20 Hz at class-D speed
  strideEndLift: 0.832 / 0.92,    // 0.904 m  → 0.92 Hz at end-lift speed

  // --- figure-8 sway amplitudes (ART §9.2). [A_x, A_y, A_r°]
  swayWalk: [0.031, 0.022, 0.72],
  swaySprint: [0.054, 0.046, 1.35],
  swayCrouch: [0.014, 0.009, 0.30],
  swayCarryMul: 1.35,       // "×1.35 all" for a heavy part
  swayEndLiftMul: 1.9,
  swayCarryRollBias: 0.4,   // degrees toward the carry shoulder
  swayEndLiftRollBias: 1.1,
  endLiftSurgeHz: 0.7,      // "a 0.7 Hz longitudinal surge of ±4 cm as the beam's mass leads"
  endLiftSurgeAmp: 0.04,

  // --- breathing (ART §9.2)
  breathHzIdle: 0.24,
  breathHzExerted: 0.55,
  breathY: 0.016,
  breathPitch: 0.28,
  breathRoll: 0.11,
  breathInhaleFrac: 0.38,

  // --- micro-tremor (ART §9.2) — "±0.09° RMS is the number"
  tremorRms: 0.09,
  tremorHpHz: 0.5,
  tremorLpHz: 9.0,

  // --- impacts
  footPitchKick: 0.9,       // degrees, ART §9.2 "pitch −0.9° spike, 90 ms decay"
  footKickTau: 0.032,
  landPitchMax: 4.2,        // degrees at fallSpeed >= 9 m/s
  landRefSpeed: 9.0,
  landSpringW: 17.0,        // ζ 0.56 / ω 17 → 12% overshoot, ~0.42 s recovery (ART §9.2)
  landSpringZ: 0.56,
  landDipY: 0.10,           // metres of vertical dip at full impulse
  stepSmoothW: 18.0,        // step-up vertical smoothing

  // --- lean
  strafeRoll: 1.5,          // degrees at full lateral speed
  leanTau: 0.18,

  // --- camera geometry (GAME_DESIGN §4.3)
  neckForward: 0.14,        // camera sits 0.14 m forward of the neck pivot, so a head turn ARCS

  // --- FOV (ART §9.1)
  fovSprint: 78,
  fovCrouchStill: 68,
  fovBlueprint: 62,
  fovTauSprint: 0.35 / 3,
  fovTauCrouch: 0.90 / 3,
  fovTauBlueprint: 0.18 / 3,

  // --- carry pose pitch offsets, degrees (GAME_DESIGN §4.3)
  pitchTool: 0.4,
  pitchC: -2.0,
  pitchD: -4.5,
  pitchE: -7.0,
  posePitchTau: 0.35,

  // --- interaction
  interactRange: 2.6,       // m. No document states a reach; this is a long arm plus half a step.
  interactRayEvery: 3,      // frames — ARCHITECTURE §12 raycast budget
  setDownTime: 2.1,         // s, GAME_DESIGN §4.1 "Set down (2.1 s, silent)"
  // (the lantern tap-vs-hold threshold lives in Flashlight.TUNING.tapSeconds — Flashlight owns
  //  the `lantern` action end to end. Player deliberately holds no lantern timing constant.)

  // --- PRY OUT — the input path for `build:remove` (see `_updatePry`, and the argument above it)
  pryTime: 1.10,            // s of held Q before the 8 s removal starts
  pryReach: 3.00,           // m — between HUD._lookAtSlot's 3.4 and BuildSystem's placeReach 2.4
  pryDot: 0.35,             // cos of the aim cone; the same number HUD and BuildSystem both use
  pryWarnAfter: 0.12,       // s — a flush join carries no standing prompt, but it does get a ring
  pryScanEvery: 3,          // frames — the same budget the interaction ray runs on

  // --- fear (Player-owned; no document assigns these, so they are named and commented)
  fearRise: 1.6,            // /s toward target — fright arrives fast
  fearFall: 0.10,           // /s — and leaves slowly. A full 1.0 takes ten seconds to clear.
  fearProxRange: 22,        // m — a camper inside this starts to weigh on the camera
  fearSpotSpike: 0.55,
  fearQueryEvery: 6,        // frames

  // --- world safety net (GAME_DESIGN §3.2 playable bounds, plus 6 m of grace)
  boundsMinX: -210, boundsMaxX: 250,
  boundsMinZ: -140, boundsMaxZ: 240,
  boundsGrace: 6,
};

/** GAME_DESIGN §6.2 — the carry table. `slots` are part slots out of 4. */
const CARRY = {
  A:       { slots: 0, speed: 1.00, turn: 1.00, crouch: true,  sprint: true,  noise: 1.00, pitch: 0 },
  B:       { slots: 1, speed: 0.96, turn: 0.95, crouch: true,  sprint: true,  noise: 1.05, pitch: T.pitchTool },
  C:       { slots: 2, speed: 0.82, turn: 0.72, crouch: true,  sprint: false, noise: 1.35, pitch: T.pitchC },
  D:       { slots: 4, speed: 0.63, turn: 0.48, crouch: false, sprint: false, noise: 1.90, pitch: T.pitchD },
  endLift: { slots: 4, speed: 0.52, turn: 0.30, crouch: false, sprint: false, noise: 2.20, pitch: T.pitchD },
  E:       { slots: 4, speed: 0.34, turn: 0.30, crouch: false, sprint: false, noise: 2.60, pitch: T.pitchE },
};
const CARRY_ORDER = ['A', 'B', 'C', 'D', 'endLift', 'E'];

/** GAME_DESIGN §3.6 — ground types. Unknown surfaces fall back to `duff`. */
const GROUND = {
  duff:     { speed: 1.00, noise: 0.72, rough: false },
  mud:      { speed: 0.94, noise: 1.15, rough: false },
  rock:     { speed: 1.00, noise: 1.40, rough: false },
  deadfall: { speed: 0.88, noise: 1.85, rough: true },
  // Surfaces other systems may report that are not in §3.6's four:
  wood:     { speed: 1.00, noise: 1.30, rough: false },  // the cabin deck, once there is one
  dirt:     { speed: 1.00, noise: 0.90, rough: false },
  water:    { speed: 0.70, noise: 1.60, rough: false },
};

/** GAME_DESIGN §9.8 — the canonical footstep rows. Do not re-derive these; they are the table. */
const FOOTSTEP_ROW = {
  crouch: { radius: 4,  intensity: 0.08 },
  walk:   { radius: 9,  intensity: 0.18 },
  sprint: { radius: 20, intensity: 0.45 },
  carryD: { radius: 14, intensity: 0.30 },
};

/** GAME_DESIGN §9.8 / AUDIO §1.3 — drop, by carry class. */
const DROP_ROW = {
  A: { radius: 16, intensity: 0.20, sfx: 'drop_hardware' },
  B: { radius: 16, intensity: 0.35, sfx: 'drop_hardware' },
  C: { radius: 26, intensity: 0.55, sfx: 'drop_lumber' },
  D: { radius: 40, intensity: 0.80, sfx: 'drop_lumber' },
  endLift: { radius: 40, intensity: 0.80, sfx: 'drop_lumber' },
  E: { radius: 40, intensity: 0.80, sfx: 'drop_lumber' },
};

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

// =================================================================================================
// Module-scope scratch. Nothing in update()/fixedUpdate() allocates. (ARCHITECTURE §12)
// =================================================================================================

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _quat = new THREE.Quaternion();

/** Pre-allocated event payloads. Reused every frame — listeners must COPY, not retain. */
/** Reused so `HUD.setPrompt()` can be driven every frame without allocating an options object. */
const _promptOpts = { progress: 0 };
const _movePayload = { position: new THREE.Vector3(), speed: 0, crouched: false };
const _footPayload = { position: new THREE.Vector3(), surface: 'duff', loud: 0 };
const _sfxPayload = { id: '', position: new THREE.Vector3(), volume: 1, rate: 1 };

/**
 * Noise positions get a small ring instead of a single scratch: `noise:emit` is the one payload
 * that downstream systems genuinely store (a camper keeps `lastNoisePos`), so a reference handed
 * out must survive a few more emits before it is recycled.
 */
const _noiseRing = [];
for (let i = 0; i < 8; i++) _noiseRing.push({ position: new THREE.Vector3(), radius: 0, intensity: 0, kind: '' });
let _noiseRingI = 0;
function noiseSlot(x, y, z, radius, intensity, kind) {
  const p = _noiseRing[_noiseRingI];
  _noiseRingI = (_noiseRingI + 1) % _noiseRing.length;
  p.position.set(x, y, z);
  p.radius = radius;
  p.intensity = intensity;
  p.kind = kind;
  return p;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Shortest signed angular difference a → b, radians, in (-π, π]. */
function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** Yaw such that forward = (-sin yaw, 0, -cos yaw). Three.js convention: -Z is forward. */
function yawFromDir(dx, dz) { return Math.atan2(-dx, -dz); }

/**
 * GAME_DESIGN §17, the opening frame. At 0:14 the manual lowers and "Ahead: six squares chalked
 * on cleared ground […] and pallet A 12 m away with six pier blocks on it." That sequence — and
 * every beat up to 5:00 — only exists if the player starts AT the plot.
 *
 * The offset is from `Terrain.buildSiteCenter` (the single source of truth for where the plot is,
 * which `CabinSite.center` also derives from), never a second hardcoded world coordinate: a
 * literal here silently desyncs the moment the pad moves. `SPAWN_FALLBACK` is the old constant,
 * used only if Terrain is missing entirely.
 *
 * +Z is south of the pad. The chalked rectangle is 6.40 m along X by 3.20 m along Z, so standing
 * 9 m south on the flat pad (Terrain.buildPad.half = 12) and looking north puts its long face
 * across the frame at roughly 40° of a 72° FOV, near edge 7.4 m, far edge 10.6 m. The small
 * downward pitch drops it into the middle of the frame rather than the very bottom.
 */
const SPAWN_OFFSET = Object.freeze({ x: 0, z: 9.0 });
const SPAWN_PITCH = -6 * Math.PI / 180;
const SPAWN_FALLBACK = Object.freeze({ x: 0, z: 6, yaw: 0 });

/**
 * ART §9.2's "1/f pink noise, 0.5–9 Hz band". Paul Kellet's economy pink filter, driven by a
 * seeded Rand so the frame is reproducible for the screenshot harness, then band-limited by a
 * one-pole high-pass and one-pole low-pass. `calibrate()` measures the filter's own RMS once so
 * the caller can ask for an exact ±0.09° RMS instead of guessing a gain.
 */
class PinkTremor {
  constructor(rand) {
    this.rand = rand;
    this.b0 = 0; this.b1 = 0; this.b2 = 0; this.b3 = 0; this.b4 = 0; this.b5 = 0; this.b6 = 0;
    this.scale = 1;
    this.hp = 0;   // high-pass state (removes the sub-0.5 Hz wander that would read as drift)
    this.lp = 0;   // low-pass state  (removes the >9 Hz buzz that would read as noise)
    this.value = 0;
  }

  _raw() {
    const w = this.rand.next() * 2 - 1;
    this.b0 = 0.99886 * this.b0 + w * 0.0555179;
    this.b1 = 0.99332 * this.b1 + w * 0.0750759;
    this.b2 = 0.96900 * this.b2 + w * 0.1538520;
    this.b3 = 0.86650 * this.b3 + w * 0.3104856;
    this.b4 = 0.55000 * this.b4 + w * 0.5329522;
    this.b5 = -0.7616 * this.b5 - w * 0.0168980;
    const out = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + w * 0.5362;
    this.b6 = w * 0.115926;
    return out * 0.11;
  }

  /**
   * Run the whole chain — pink filter AND the 0.5–9 Hz band — dry, and measure the RMS of what
   * actually comes out, so `value` is normalised to exactly 1.0 RMS. Calibrating the pink source
   * alone would leave the band-pass attenuation unaccounted for and land the tremor at ~0.05°
   * instead of ART §9.2's 0.09°, which is close enough to look right and wrong enough to be wrong.
   */
  calibrate(n = 8192, dt = 1 / 60) {
    for (let i = 0; i < 600; i++) this.step(dt);   // warm the one-pole states
    let s = 0;
    for (let i = 0; i < n; i++) { const x = this.step(dt); s += x * x; }
    const rms = Math.sqrt(s / n);
    this.scale = rms > 1e-9 ? 1 / rms : 1;
    this.value = 0;
    return this.scale;
  }

  /** Step at a fixed rate (called from fixedUpdate at 60 Hz) so the stream is deterministic. */
  step(dt) {
    const x = this._raw();
    const aLp = 1 - Math.exp(-2 * Math.PI * T.tremorLpHz * dt);
    const aHp = 1 - Math.exp(-2 * Math.PI * T.tremorHpHz * dt);
    this.lp += (x - this.lp) * aLp;
    this.hp += (this.lp - this.hp) * aHp;
    this.value = (this.lp - this.hp) * this.scale;
    return this.value;
  }
}

// =================================================================================================
// Player
// =================================================================================================

export class Player {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx?.bus ?? null;
    this.camera = ctx?.camera ?? null;

    // ------------------------------------------------------------------ public state
    /**
     * FEET position — the point where the capsule meets the ground, matching
     * `Physics.moveCapsule(position, …)`. The eye is at `position.y + eyeHeight`.
     * `eyePosition` is published separately for anything that wants the head.
     */
    // Placeholder only. `init()` calls `_applySpawn()`, which puts the player at the build site
    // (GAME_DESIGN §17) derived from Terrain.buildSiteCenter. Nothing should read this before init.
    this.position = new THREE.Vector3(SPAWN_FALLBACK.x, 0, SPAWN_FALLBACK.z);
    this.eyePosition = new THREE.Vector3(SPAWN_FALLBACK.x, T.standEye, SPAWN_FALLBACK.z);
    this.velocity = new THREE.Vector3();

    /** Unit forward direction the player is AIMING (not the lagged render view). */
    this.lookAt = new THREE.Vector3(0, 0, -1);

    this.isCrouched = false;
    this.isSprinting = false;
    this.isMoving = false;
    this.grounded = true;
    this.speed = 0;                 // horizontal m/s
    this.stamina = T.staminaMax;
    this.exhausted = false;
    this.eyeHeight = T.standEye;
    this.capsuleHeight = T.standHeight;
    this.capsuleRadius = T.radius;

    /** Carry. `carriedPart` is the primary part; `carried` is the full 0–4-slot load. */
    this.carriedPart = null;
    this.carried = [];
    this.carryMass = 0;
    this.carryClass = 'A';
    this.carrySlots = 0;
    this.carrySpeedMul = 1;
    this.carryTurnMul = 1;

    /** What the reticle is on. Reused object; `null` when nothing is in reach. */
    this.interactTarget = null;
    this.interactHold = 0;          // seconds the interact button has been held on the target

    /**
     * 0..1. Rises with camper proximity and with being seen; decays slowly.
     * IT NEVER TOUCHES CONTROL. Search this file for `this.fear` — it appears only in the camera
     * layers, in `handState`, and in the call to Postprocessing.setPanic(). The slasher is not
     * frightened. The camera is. That distinction is the character (ART §9.5).
     */
    this.fear = 0;

    /** STORY §2.4.1 — read-only for BlueprintUI, which times the hand-wipe from it. */
    this.handState = 'dry';

    /** AUDIO §4.19 / §4.27 — read by AudioEngine to pick the breath layer. Never a voice. */
    this.breathState = 'CALM';      // 'CALM' | 'WALK' | 'HEAVY' | 'HELD'

    this.surface = 'duff';
    this.groundType = 'duff';
    this.controlEnabled = true;
    this.inputLocked = false;       // NightManager may take the hands away (GAME_DESIGN §4.4)

    // ------------------------------------------------------------------ look / view
    this.aimYaw = 0;
    this.aimPitch = 0;
    this._aimYawVel = 0;
    this._aimPitchVel = 0;
    this.viewYaw = 0;               // rendered — lags aimYaw through ART §9.2's spring
    this.viewPitch = 0;
    this._viewYawVel = 0;
    this._viewPitchVel = 0;
    this.bodyYaw = 0;
    this._bodyYawVel = 0;

    // ------------------------------------------------------------------ internals
    this._crouchT = 0;              // 0 standing … 1 crouched
    this._crouchHeld = false;
    this._crouchToggled = false;
    this._sprintBlend = 0;          // 0 walk … 1 sprint (the 1.9 s spin-up)
    this._accelMag = 0;             // jerk-limited acceleration magnitude
    this._decelMag = 0;
    this._regenTimer = 0;
    this._stillTime = 0;

    this._bobPhase = 0;
    this._footIndex = 0;            // parity → which foot
    this._footKick = 0;
    this._landImpulse = 0;
    this._landVel = 0;
    this._stepSmooth = 0;
    this._stepSmoothVel = 0;
    this._leanRoll = 0;
    this._breathPhase = 0;
    this._posePitch = 0;
    this._poseRoll = 0;
    this._surgePhase = 0;

    this._fov = ctx?.settings?.get?.('fov') ?? 72;
    this._fovBase = this._fov;
    this._blueprintOpen = false;

    this._frame = 0;
    this._brushCooldown = 0;
    this._dragTimer = 0;
    this._fearTarget = 0;
    this._fearNearest = Infinity;
    this._lastPanic = -1;
    this._handStateTimer = 0;
    this._mudTimer = 0;

    this._dropHeld = 0;
    this._setDownHeld = 0;
    this._interactHeldAtRelease = 0;
    this._surfaceTick = 0;

    // --- PRY OUT (`_updatePry`). `_pryScan` is a flat mirror of BuildSystem's slot table, rebuilt
    //     only when that table changes size, so the per-frame scan allocates nothing.
    this._pryHeld = 0;
    this._pryLatched = false;
    this._pryPromptOn = false;
    this._prySlotId = null;
    this._pryRec = { id: null, visual: '' };
    this._pryScan = [];
    this._pryScanSize = -1;
    this._pryPush = (s) => { this._pryScan.push(s); };
    /** How many joins this player has pried out this session. Read by nothing; useful in a probe. */
    this.pryCount = 0;

    this._prevEye = new THREE.Vector3(0, T.standEye, 6);
    this._currEye = new THREE.Vector3(0, T.standEye, 6);

    this._moveOut = { grounded: false };   // reused across every moveCapsule call (Physics reads it)
    this._overlapScratch = new Array(24);

    // Deterministic noise streams, seeded from settings (ARCHITECTURE §6). The unseeded global
    // RNG is never used anywhere in this file; the screenshot harness depends on that.
    const seed = ctx?.settings?.get?.('seed') ?? 0x51a5cab;
    this._rand = new Rand((seed ^ 0x504c4159) | 0);
    this._tremorYaw = new PinkTremor(this._rand.fork('tremor-yaw'));
    this._tremorPitch = new PinkTremor(this._rand.fork('tremor-pitch'));

    // The hand anchor lives in WORLD space, not parented to the camera, because
    // Physics.simulateCarried resolves the part against the world and writes a world transform.
    this.handAnchor = new THREE.Object3D();
    this.handAnchor.name = 'player-hands';
    this.handAnchor.matrixAutoUpdate = true;

    this._unsubs = [];
    this._disposed = false;
    this._warnedNoPhysics = false;
  }

  // ===============================================================================================
  // Lifecycle
  // ===============================================================================================

  async init() {
    const { ctx } = this;

    this._tremorYaw.calibrate();
    this._tremorPitch.calibrate();

    if (ctx?.scene) ctx.scene.add(this.handAnchor);

    // Stand the player in front of the chalked plot before anything samples the ground.
    this._applySpawn();

    // Start on the ground wherever the terrain actually is.
    const h = this._groundHeight(this.position.x, this.position.z);
    if (Number.isFinite(h)) this.position.y = h;
    this._currEye.set(this.position.x, this.position.y + T.standEye, this.position.z);
    this._prevEye.copy(this._currEye);
    this.eyePosition.copy(this._currEye);

    this._fovBase = ctx?.settings?.get?.('fov') ?? 72;
    this._fov = this._fovBase;

    this._bind();
    this._syncCameraImmediate();

    Log.debug('Player ready — 6\'6", 280 lb, capsule r=0.42, eye 1.70.');
  }

  _bind() {
    const bus = this.bus;
    const on = (evt, fn) => { const off = bus?.on?.(evt, fn); if (typeof off === 'function') this._unsubs.push(off); };

    on('ui:blueprint-open', () => { this._blueprintOpen = true; });
    on('ui:blueprint-close', () => { this._blueprintOpen = false; });

    on('player:spotted', (p) => {
      // Fear spikes. Control does not change. Nothing in the lens changes (ART §9.5).
      const lvl = clamp01(typeof p?.level === 'number' ? p.level : 1);
      this.fear = clamp01(Math.max(this.fear, T.fearSpotSpike * lvl));
    });

    on('night:begin', () => { this._resetForNight(); });

    on('settings:changed', ({ key } = {}) => {
      if (key === 'fov' || key === '*') this._fovBase = this.ctx?.settings?.get?.('fov') ?? 72;
    });

    on('story:beat', ({ id } = {}) => {
      // STORY §8.11 / §2.4.1: the hands change state and the wipe does not.
      if (id === 'firstBlood') this.handState = 'bloodied';
    });

    // Standalone playability: if nothing else has claimed pointer lock, claim it on click.
    const canvas = this.ctx?.canvas;
    if (canvas) {
      this._onCanvasClick = () => {
        const input = this.ctx?.systems?.get?.('Input');
        if (!input || input.pointerLocked) return;
        const phase = this.ctx?.state?.phase;
        if (phase === 'menu' || phase === 'gameover' || phase === 'night-end') return;
        input.requestPointerLock?.();
      };
      canvas.addEventListener('click', this._onCanvasClick);
    }
  }

  /**
   * GAME_DESIGN §17 — put the player at the build site, looking at the chalked layout.
   *
   * Derived from `Terrain.buildSiteCenter` so there is exactly one authority on where the plot
   * is. If Terrain is missing (a stripped harness, a failed module) we fall back to the old
   * origin constant rather than crashing — the game is still playable, just not the §17 opening.
   * Ground height is applied by the caller, which runs after this.
   */
  _applySpawn() {
    let x = SPAWN_FALLBACK.x;
    let z = SPAWN_FALLBACK.z;
    let yaw = SPAWN_FALLBACK.yaw;

    const c = this._sys('Terrain')?.buildSiteCenter;
    if (c && Number.isFinite(c.x) && Number.isFinite(c.z)) {
      x = c.x + SPAWN_OFFSET.x;
      z = c.z + SPAWN_OFFSET.z;
      yaw = yawFromDir(c.x - x, c.z - z);   // face the centre of the plot
      Log.debug(
        `Player spawn: (${x.toFixed(1)}, ${z.toFixed(1)}), ` +
        `${Math.hypot(SPAWN_OFFSET.x, SPAWN_OFFSET.z).toFixed(1)} m from the build site, ` +
        `yaw ${(yaw * 180 / Math.PI).toFixed(1)}°.`
      );
    } else {
      Log.warn('Player: no Terrain.buildSiteCenter — spawning at the fallback origin (GAME_DESIGN §17 opening will not read).');
    }

    this.position.set(x, this.position.y, z);
    this.velocity.set(0, 0, 0);

    this.aimYaw = this.viewYaw = this.bodyYaw = yaw;
    this.aimPitch = this.viewPitch = SPAWN_PITCH;
    this._aimYawVel = this._aimPitchVel = 0;
    this._viewYawVel = this._viewPitchVel = 0;
    this._bodyYawVel = 0;

    const cp = Math.cos(this.aimPitch);
    this.lookAt.set(-Math.sin(yaw) * cp, Math.sin(this.aimPitch), -Math.cos(yaw) * cp);
  }

  _resetForNight() {
    this.stamina = T.staminaMax;
    this.exhausted = false;
    this.fear = 0;
    this._regenTimer = 0;
    this._handStateTimer = 0;
  }

  resize(_w, _h) { /* the camera's aspect is Engine's; nothing to do */ }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    for (const off of this._unsubs) { try { off(); } catch { /* noop */ } }
    this._unsubs.length = 0;

    const canvas = this.ctx?.canvas;
    if (canvas && this._onCanvasClick) canvas.removeEventListener('click', this._onCanvasClick);
    this._onCanvasClick = null;

    // Hand anything we are holding back to the world before we go.
    const phys = this._phys();
    for (const part of this.carried) {
      try { phys?.releaseCarried?.(part); } catch { /* noop */ }
    }
    this.carried.length = 0;
    this.carriedPart = null;

    if (this.handAnchor?.parent) this.handAnchor.parent.remove(this.handAnchor);

    // Give the prompt card back before we go, or a forced pry prompt outlives the player.
    this._pryClearPrompt();
    this._pryScan.length = 0;
    this._pryScanSize = -1;

    this.interactTarget = null;
    this._targetRec = null;
  }

  // ===============================================================================================
  // System lookups — every one null-checked; a missing system degrades, never crashes.
  // ===============================================================================================

  _sys(name) {
    const s = this.ctx?.systems?.get?.(name);
    return s && !s.__failed ? s : null;
  }
  _phys() { return this._sys('Physics'); }
  _input() { return this._sys('Input'); }

  /** True while the screenshot harness has the camera pinned — we must not fight it. */
  _shotsFrozen() {
    const shots = this.ctx?.systems?.get?.('Shots');
    return !!(shots && shots.active && shots.frozen);
  }

  _groundHeight(x, z) {
    const phys = this._phys();
    if (phys?.heightAt) { const h = phys.heightAt(x, z); if (Number.isFinite(h)) return h; }
    const terrain = this._sys('Terrain');
    if (terrain?.heightAt) { const h = terrain.heightAt(x, z); if (Number.isFinite(h)) return h; }
    return 0;
  }

  // ===============================================================================================
  // fixedUpdate — 60 Hz. Movement, the capsule, stamina, footfalls, the carried part.
  // ===============================================================================================

  fixedUpdate(fdt) {
    if (this._disposed) return;

    // Tremor is stepped here so its stream is exactly 60 Hz and reproducible from the seed,
    // regardless of the display's refresh rate.
    this._tremorYaw.step(fdt);
    this._tremorPitch.step(fdt);

    if (this._shotsFrozen()) { this._syncFromShots(); return; }

    const phase = this.ctx?.state?.phase ?? 'build';
    this.controlEnabled = (phase === 'build' || phase === 'chase' || phase === 'briefing') && !this.inputLocked;

    const input = this._input();
    const settings = this.ctx?.settings;

    // ---------------------------------------------------------------- 1. intent
    let ix = 0, iy = 0;
    if (input && this.controlEnabled) { ix = input.move?.x ?? 0; iy = input.move?.y ?? 0; }
    const inputMag = Math.min(1, Math.hypot(ix, iy));

    const holdToCrouch = settings?.get?.('holdToCrouch');
    const crouchDown = !!(input && this.controlEnabled && input.isDown?.('crouch'));
    if (holdToCrouch === false) {
      if (input && this.controlEnabled && input.wasPressed?.('crouch')) this._crouchToggled = !this._crouchToggled;
      this._crouchHeld = this._crouchToggled;
    } else {
      this._crouchHeld = crouchDown;
    }

    const cls = CARRY[this.carryClass] ?? CARRY.A;
    // Class D and above cannot crouch at all (GAME_DESIGN §6.2). He is holding a beam on his
    // shoulder; there is nowhere for it to go.
    const wantCrouch = this._crouchHeld && cls.crouch;

    const sprintDown = !!(input && this.controlEnabled && input.isDown?.('sprint'));
    const canSprint = cls.sprint && !wantCrouch && !this.exhausted && this.stamina > 0 && inputMag > 0.35;
    const wantSprint = sprintDown && canSprint;

    // ---------------------------------------------------------------- 2. crouch height
    const crouchRate = wantCrouch ? (1 / T.crouchDownTime) : -(1 / T.crouchUpTime);
    this._crouchT = clamp01(this._crouchT + crouchRate * fdt);
    // Getting small is easy; getting mobile is not (GAME_DESIGN §10.1 note 4).
    this.isCrouched = this._crouchT > 0.5;
    this.capsuleHeight = T.standHeight + (T.crouchHeight - T.standHeight) * this._crouchT;
    this.eyeHeight = T.standEye + (T.crouchEye - T.standEye) * this._crouchT;

    // ---------------------------------------------------------------- 3. sprint spin-up
    // 1.9 s from walk to sprint. "Sprinting is a decision made two seconds ago" (§10.1).
    if (wantSprint) this._sprintBlend = clamp01(this._sprintBlend + fdt / T.sprintSpinUp);
    else this._sprintBlend = clamp01(this._sprintBlend - fdt / T.sprintSpinDown);
    this.isSprinting = this._sprintBlend > 0.05 && inputMag > 0.35;

    // ---------------------------------------------------------------- 4. target speed
    const ground = GROUND[this.groundType] ?? GROUND.duff;
    let base = this.isCrouched ? T.crouchSpeed : T.walkSpeed;
    if (!this.isCrouched) base = T.walkSpeed + (T.sprintSpeed - T.walkSpeed) * this._sprintBlend;
    const targetSpeed = base * this.carrySpeedMul * ground.speed * inputMag;

    // ---------------------------------------------------------------- 5. heading (the body)
    // The input is read against the AIM yaw (so W is always "where I am looking"), but the
    // acceleration is applied along the BODY yaw, and the body chases the wish heading at a
    // limited rate. That is the wide turning circle: you ask for a new direction and he arcs into
    // it. Carrying a beam narrows the rate further via CARRY[].turn.
    if (inputMag > 0.01) {
      const s = Math.sin(this.aimYaw), c = Math.cos(this.aimYaw);
      // forward = (-sin, 0, -cos); right = (cos, 0, -sin)
      const wx = ix * c + iy * -s;
      const wz = ix * -s + iy * -c;
      const wishYaw = yawFromDir(wx, wz);
      this._turnBody(wishYaw, T.bodyTurnRate * this.carryTurnMul, fdt);
    } else {
      // Standing still, he squares his shoulders up to wherever he is looking. Slowly.
      this._turnBody(this.aimYaw, T.bodySquareUpRate * this.carryTurnMul, fdt);
    }

    const bs = Math.sin(this.bodyYaw), bc = Math.cos(this.bodyYaw);
    _fwd.set(-bs, 0, -bc);

    // ---------------------------------------------------------------- 6. acceleration
    const vx = this.velocity.x, vz = this.velocity.z;
    const curSpeed = Math.hypot(vx, vz);
    const wantVx = _fwd.x * targetSpeed;
    const wantVz = _fwd.z * targetSpeed;
    let dvx = wantVx - vx;
    let dvz = wantVz - vz;
    const dvLen = Math.hypot(dvx, dvz);

    const accelerating = targetSpeed > curSpeed - 0.02;
    // Jerk limiting: the documented peak (7.0 / 9.0) is a ceiling he ramps into, not a step.
    if (accelerating) {
      this._accelMag = Math.min(T.accel, this._accelMag + T.accelJerk * fdt);
      this._decelMag = Math.max(0, this._decelMag - T.decelJerk * 1.6 * fdt);
    } else {
      this._decelMag = Math.min(T.decel, this._decelMag + T.decelJerk * fdt);
      this._accelMag = Math.max(0, this._accelMag - T.accelJerk * 1.2 * fdt);
    }
    // A loaded man does not accelerate like an empty one. Scaling by the carry speed multiplier
    // keeps time-to-top-speed roughly constant while the top speed itself drops.
    let a = (accelerating ? this._accelMag : this._decelMag) * this.carrySpeedMul;
    if (!this.grounded) a *= T.airControl;

    if (dvLen > 1e-5) {
      const step = Math.min(dvLen, a * fdt);
      const k = step / dvLen;
      dvx *= k; dvz *= k;
      this.velocity.x += dvx;
      this.velocity.z += dvz;
    }

    // ---------------------------------------------------------------- 7. gravity + collision
    this.velocity.y += T.gravity * fdt;
    if (this.velocity.y < -55) this.velocity.y = -55;

    const wasGrounded = this.grounded;
    const preY = this.position.y;
    const fallSpeed = -this.velocity.y;

    this._integrate(fdt);

    // Landing: a damped spring impulse (ART §9.2). Never a screen shake.
    if (this.grounded && !wasGrounded && fallSpeed > 1.2) {
      const impulse = clamp01(fallSpeed / T.landRefSpeed);
      this._landImpulse = Math.max(this._landImpulse, impulse);
      this._landVel -= impulse * T.landSpringW * 0.9;
      this._emitFootstep(true, impulse);
    }

    // Step-up smoothing: Physics lifts the capsule in one clean move; the head should not.
    if (this._moveOut.steppedUp) {
      const rise = this.position.y - preY;
      if (rise > 0.02) this._stepSmooth -= Math.min(rise, T.stepHeight ?? 0.45);
    }

    // ---------------------------------------------------------------- 8. bookkeeping
    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.isMoving = this.speed > 0.12;
    if (this.isMoving) this._stillTime = 0; else this._stillTime += fdt;

    const dist = this.speed * fdt;
    const stats = this.ctx?.state?.stats;
    if (stats && typeof stats.metresWalked === 'number') stats.metresWalked += dist;

    this._updateSurface();
    this._updateStamina(fdt, wantSprint);
    this._updateFootfall(fdt, dist);
    this._updateDrag(fdt);
    this._softBounds();

    // ---------------------------------------------------------------- 9. eye + carried part
    this._prevEye.copy(this._currEye);
    this._currEye.set(
      this.position.x,
      this.position.y + this.eyeHeight,
      this.position.z,
    );

    this._simulateCarried(fdt);
  }

  /** Rate- and acceleration-limited chase of the body yaw toward a wish heading. */
  _turnBody(wishYaw, rateDegPerSec, fdt) {
    const err = angleDelta(this.bodyYaw, wishYaw);
    const cap = rateDegPerSec * DEG;
    const accel = T.bodyTurnAccel * DEG * (this.carryTurnMul * 0.5 + 0.5);
    // Desired rate that would arrive without overshooting, capped.
    const desired = clamp(err / Math.max(fdt, 1e-4), -cap, cap);
    const dv = clamp(desired - this._bodyYawVel, -accel * fdt, accel * fdt);
    this._bodyYawVel += dv;
    this.bodyYaw += this._bodyYawVel * fdt;
    if (Math.abs(err) < 1e-4) { this.bodyYaw = wishYaw; this._bodyYawVel *= 0.5; }
  }

  /** Push the capsule through the world. Falls back to a bare heightfield if Physics is absent. */
  _integrate(fdt) {
    const phys = this._phys();
    if (phys?.moveCapsule) {
      const res = phys.moveCapsule(this.position, this.velocity, T.radius, this.capsuleHeight, fdt, this._moveOut);
      if (res) {
        this.position.copy(res.position);
        this.velocity.copy(res.velocity);
        this.grounded = !!res.grounded;
        if (res.surface) this.surface = res.surface;
        return;
      }
    }
    if (!this._warnedNoPhysics) {
      this._warnedNoPhysics = true;
      Log.once('player:nophysics', 'Player: Physics missing — using the bare heightfield fallback.');
    }
    // Fallback: integrate, then clamp to the ground. No walls, but the game still plays.
    this.position.x += this.velocity.x * fdt;
    this.position.y += this.velocity.y * fdt;
    this.position.z += this.velocity.z * fdt;
    const gh = this._groundHeight(this.position.x, this.position.z);
    if (this.position.y <= gh) {
      this.position.y = gh;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.grounded = true;
      this._moveOut.grounded = true;
    } else {
      this.grounded = false;
      this._moveOut.grounded = false;
    }
    this._moveOut.steppedUp = false;
  }

  /** Throttled: a 0.6 m box gather is cheap, but there is no reason to do it 60 times a second. */
  _updateSurface() {
    if ((this._surfaceTick = (this._surfaceTick | 0) + 1) % 3 !== 0) return;
    const phys = this._phys();
    let s = this.surface;
    if (phys?.surfaceUnder) { const v = phys.surfaceUnder(this.position); if (v) s = v; }
    else if (phys?.surfaceAt) { const v = phys.surfaceAt(this.position.x, this.position.z); if (v) s = v; }
    this.surface = s;
    this.groundType = GROUND[s] ? s : 'duff';
  }

  /** GAME_DESIGN §10.2, verbatim. */
  _updateStamina(fdt, sprinting) {
    const carryNorm = clamp01(this.carryMass / T.carryMassRef);
    if (sprinting && this.isSprinting && this.isMoving) {
      this.stamina -= T.sprintDrain * (1 + 0.6 * carryNorm) * fdt;
      this._regenTimer = T.regenDelay;
      if (this.stamina <= 0) { this.stamina = 0; this.exhausted = true; }
    } else {
      if (this._regenTimer > 0) this._regenTimer -= fdt;
      else {
        // "the slasher recovers by being still"
        const rate = this.isCrouched ? T.regenRateCrouched : T.regenRate;
        this.stamina = Math.min(T.staminaMax, this.stamina + rate * fdt);
      }
    }
    if (this.exhausted && this.stamina >= T.exhaustRecover) this.exhausted = false;

    // AUDIO §4.19 — three breath states, no FEAR state. He does not make a frightened sound.
    const drained = 1 - this.stamina / T.staminaMax;
    if (drained > 0.60 || this.isSprinting) this.breathState = 'HEAVY';
    else if (this.isMoving) this.breathState = 'WALK';
    else this.breathState = 'CALM';
    this.staminaDrained = drained;
  }

  // ===============================================================================================
  // Footfalls — slow and spaced, driven by distance, not by a timer.
  // ===============================================================================================

  _strideLength() {
    const cls = this.carryClass;
    if (cls === 'endLift' || cls === 'E') return T.strideEndLift;
    if (cls === 'D') return T.strideCarry;
    if (this.isCrouched) return T.strideCrouch;
    if (this.isSprinting) return T.strideWalk + (T.strideSprint - T.strideWalk) * this._sprintBlend;
    if (cls === 'C') return T.strideCarry + (T.strideWalk - T.strideCarry) * 0.5;
    return T.strideWalk;
  }

  _updateFootfall(fdt, dist) {
    if (this._brushCooldown > 0) this._brushCooldown -= fdt;
    this._footKick = this._footKick > 1e-4 ? this._footKick * Math.exp(-fdt / T.footKickTau) : 0;

    if (!this.grounded || !this.isMoving) {
      // Ease the sway phase back toward a foot-down pose rather than freezing mid-stride.
      return;
    }
    const stride = Math.max(0.3, this._strideLength());
    const prev = this._bobPhase;
    // One full figure-8 cycle (2π) is TWO footfalls, one per foot: y = A_y·sin(2p).
    this._bobPhase += (dist / stride) * Math.PI;

    const prevN = Math.floor(prev / Math.PI);
    const nowN = Math.floor(this._bobPhase / Math.PI);
    if (nowN !== prevN) {
      this._footIndex = nowN & 1;
      this._emitFootstep(false, 0);
    }
    if (this._bobPhase > Math.PI * 1024) this._bobPhase -= Math.PI * 1024;
  }

  /**
   * One footfall. GAME_DESIGN §9.8's canonical row is the authority for (radius, intensity);
   * §3.6's ground multiplier and §6.2's carry multiplier scale it from there.
   */
  _emitFootstep(isLanding, landImpulse) {
    const bus = this.bus;
    const cls = this.carryClass;
    let row = FOOTSTEP_ROW.walk;
    if (this.isCrouched) row = FOOTSTEP_ROW.crouch;
    else if (this.isSprinting && this._sprintBlend > 0.5) row = FOOTSTEP_ROW.sprint;
    else if (cls === 'D' || cls === 'endLift' || cls === 'E') row = FOOTSTEP_ROW.carryD;

    const ground = GROUND[this.groundType] ?? GROUND.duff;
    // The carry multiplier only applies where the row is not already the carry row, otherwise the
    // §9.8 number would be counted twice.
    const carryMul = (row === FOOTSTEP_ROW.carryD) ? 1 : (CARRY[cls]?.noise ?? 1);
    const landMul = isLanding ? (1 + 1.2 * landImpulse) : 1;

    const intensity = clamp01(row.intensity * ground.noise * carryMul * landMul);
    const radius = row.radius * Math.sqrt(ground.noise * carryMul * landMul);

    this._footKick = 1;

    if (bus) {
      _footPayload.position.copy(this.position);
      _footPayload.surface = this.surface;
      _footPayload.loud = intensity;
      bus.emit('player:footstep', _footPayload);

      bus.emit('noise:emit', noiseSlot(
        this.position.x, this.position.y, this.position.z,
        radius, intensity, 'footstep',
      ));

      _sfxPayload.id = `step_${this.surface}`;
      _sfxPayload.position.copy(this.position);
      _sfxPayload.volume = clamp01(0.35 + intensity);
      // A heavier load lands lower. Small, but you hear it before you can name it.
      _sfxPayload.rate = 1.06 - 0.14 * clamp01(this.carryMass / T.carryMassRef) + (this._footIndex ? 0.02 : -0.02);
      bus.emit('audio:sfx', _sfxPayload);
    }

    this._maybeBrush();
  }

  /**
   * GAME_DESIGN §9.8 `brush` — radius 6, intensity 0.12. STORY §2.1: "He is too big for this
   * forest and that is a number, not an animation." The number is the 0.42 m capsule.
   */
  _maybeBrush() {
    if (this._brushCooldown > 0) return;
    const phys = this._phys();
    if (!phys?.overlapSphere) return;
    const Layer = phys.constructor?.LAYER ?? phys.LAYER;
    const mask = Layer?.FOLIAGE;
    if (!mask) return;
    _v.set(this.position.x, this.position.y + this.capsuleHeight * 0.5, this.position.z);
    let n = 0;
    try { n = phys.overlapSphere(_v, T.radius + 0.1, this._overlapScratch, mask); }
    catch (e) { Log.once('player:brush', 'Player: overlapSphere threw; brush noise disabled.', e); this._brushCooldown = 1e9; return; }
    if (n <= 0) return;
    this._brushCooldown = 0.7;
    const quiet = this.isCrouched ? 0.35 : 1;
    this.bus?.emit('noise:emit', noiseSlot(
      this.position.x, this.position.y + 0.9, this.position.z, 6, 0.12 * quiet, 'brush',
    ));
    _sfxPayload.id = 'brush_foliage';
    _sfxPayload.position.copy(this.position);
    _sfxPayload.volume = 0.5 * quiet;
    _sfxPayload.rate = 1;
    this.bus?.emit('audio:sfx', _sfxPayload);
  }

  /** GAME_DESIGN §9.8 `drag` — the trailing end of an end-lift or a body, radius 22, 0.38. */
  _updateDrag(fdt) {
    const cls = this.carryClass;
    if ((cls !== 'endLift' && cls !== 'E') || !this.isMoving) { this._dragTimer = 0; return; }
    this._dragTimer -= fdt;
    if (this._dragTimer > 0) return;
    this._dragTimer = 0.8;
    this.bus?.emit('noise:emit', noiseSlot(
      this.position.x, this.position.y, this.position.z, 22, 0.38, 'drag',
    ));
    _sfxPayload.id = cls === 'E' ? 'drag_body' : 'drag_lumber';
    _sfxPayload.position.copy(this.position);
    _sfxPayload.volume = 0.7;
    _sfxPayload.rate = 1;
    this.bus?.emit('audio:sfx', _sfxPayload);
  }

  /**
   * GAME_DESIGN §3.2 gives the playable rectangle and says terrain, water and a wire fence stop
   * him. If those systems are absent this is the only thing between the player and the void, so it
   * only engages 6 m outside the stated bounds and pushes rather than teleports.
   */
  _softBounds() {
    const g = T.boundsGrace;
    const p = this.position;
    let pushed = false;
    if (p.x < T.boundsMinX - g) { p.x = T.boundsMinX - g; if (this.velocity.x < 0) this.velocity.x = 0; pushed = true; }
    if (p.x > T.boundsMaxX + g) { p.x = T.boundsMaxX + g; if (this.velocity.x > 0) this.velocity.x = 0; pushed = true; }
    if (p.z < T.boundsMinZ - g) { p.z = T.boundsMinZ - g; if (this.velocity.z < 0) this.velocity.z = 0; pushed = true; }
    if (p.z > T.boundsMaxZ + g) { p.z = T.boundsMaxZ + g; if (this.velocity.z > 0) this.velocity.z = 0; pushed = true; }
    if (pushed) Log.once('player:bounds', 'Player: hit the soft world bounds (GAME_DESIGN §3.2).');
    if (p.y < -60) { p.y = this._groundHeight(p.x, p.z); this.velocity.set(0, 0, 0); }
  }

  // ===============================================================================================
  // update — presentation, discrete verbs, aiming, fear.
  // ===============================================================================================

  update(dt, elapsed) {
    if (this._disposed) return;
    this._frame++;

    if (this._shotsFrozen()) { this._syncFromShots(); return; }

    this._updateAim(dt);
    this._updateView(dt);
    this._updateVerbs(dt);
    this._updateInteract();
    this._updateFear(dt);
    this._updateHandState(dt);
    this._composeCamera(dt, elapsed);
    this._updateHandAnchor();
    this._emitMove();
  }

  /**
   * Mouse → aim target. GAME_DESIGN §10.1: 220°/s cap, 1400°/s² accel.
   * "the limiter is a GAME rule, not an input-quality artefact" (§4.1). Do not remove it.
   */
  _updateAim(dt) {
    const input = this._input();
    const settings = this.ctx?.settings;
    const sens = settings?.get?.('mouseSensitivity') ?? 1;
    const invert = !!settings?.get?.('invertY');

    // Input already zeroes the mouse accumulator when pointer lock is dropped, and still publishes
    // gamepad look, so there is no lock check here — a pad player never has pointer lock.
    let dx = 0, dy = 0;
    if (input && this.controlEnabled) {
      dx = input.lookDelta?.x ?? 0;
      dy = input.lookDelta?.y ?? 0;
    }

    const step = Math.max(dt, 1e-4);
    // Requested angular rate, in degrees/s, before limiting.
    const reqYaw = (-dx * T.degPerPixel * sens) / step;
    const reqPitch = ((invert ? dy : -dy) * T.degPerPixel * sens) / step;

    const cap = T.aimRateCap * this.carryTurnMul;
    const accel = T.aimAccel * dt;

    const tgtYaw = clamp(reqYaw, -cap, cap);
    const tgtPitch = clamp(reqPitch, -cap, cap);
    this._aimYawVel += clamp(tgtYaw - this._aimYawVel, -accel, accel);
    this._aimPitchVel += clamp(tgtPitch - this._aimPitchVel, -accel, accel);
    // Bleed the rate to zero when the mouse stops, so he coasts to a halt rather than stopping dead.
    if (dx === 0) this._aimYawVel *= Math.exp(-dt * 26);
    if (dy === 0) this._aimPitchVel *= Math.exp(-dt * 26);

    this.aimYaw += this._aimYawVel * DEG * dt;
    this.aimPitch = clamp(this.aimPitch + this._aimPitchVel * DEG * dt, -T.pitchClamp * DEG, T.pitchClamp * DEG);

    // Keep yaw bounded so the float never loses precision over a two-hour night.
    if (this.aimYaw > Math.PI) this.aimYaw -= Math.PI * 2;
    else if (this.aimYaw < -Math.PI) this.aimYaw += Math.PI * 2;

    const cp = Math.cos(this.aimPitch), sp = Math.sin(this.aimPitch);
    this.lookAt.set(-Math.sin(this.aimYaw) * cp, sp, -Math.cos(this.aimYaw) * cp);
  }

  /**
   * Aim target → rendered view. ART §9.2: critically-damped spring ω = 22, ζ = 1.0, with angular
   * acceleration clamped to 520°/s². This clamp is the single most important line in the file for
   * "you are a heavy monster": he cannot whip round to look at what spotted him.
   */
  _updateView(dt) {
    const w = T.viewSpringW / (1 + T.viewSprintExtraLag * T.viewSpringW * this._sprintBlend);
    const z = 1.0;
    const aCap = T.viewAccelCap * DEG;

    const eYaw = angleDelta(this.viewYaw, this.aimYaw);
    let accYaw = w * w * eYaw - 2 * z * w * this._viewYawVel;
    accYaw = clamp(accYaw, -aCap, aCap);
    this._viewYawVel += accYaw * dt;
    this.viewYaw += this._viewYawVel * dt;

    const ePitch = this.aimPitch - this.viewPitch;
    let accPitch = w * w * ePitch - 2 * z * w * this._viewPitchVel;
    accPitch = clamp(accPitch, -aCap, aCap);
    this._viewPitchVel += accPitch * dt;
    this.viewPitch = clamp(this.viewPitch + this._viewPitchVel * dt, -T.pitchClamp * DEG, T.pitchClamp * DEG);

    if (this.viewYaw > Math.PI) this.viewYaw -= Math.PI * 2;
    else if (this.viewYaw < -Math.PI) this.viewYaw += Math.PI * 2;
  }

  // ===============================================================================================
  // Discrete verbs. Read here (not in fixedUpdate) because wasPressed() is frame-scoped.
  // ===============================================================================================

  _updateVerbs(dt) {
    const input = this._input();
    if (!input) return;
    if (!this.controlEnabled) {
      this.interactHold = 0; this._dropHeld = 0; this._setDownHeld = 0;
      this._pryHeld = 0; this._pryLatched = false; this._pryClearPrompt();
      return;
    }

    // ---------------------------------------------------------------- interact / place
    const interactDown = !!input.isDown?.('interact');
    if (interactDown) this.interactHold += dt; else this.interactHold = 0;

    if (input.wasPressed?.('interact')) this._onInteractPress();
    else if (interactDown && this.interactHold > 0.05) this._onInteractHold(this.interactHold);
    if (input.wasReleased?.('interact')) {
      const held = this._interactHeldAtRelease ?? 0;
      this._onInteractRelease(held);
    }
    this._interactHeldAtRelease = this.interactHold;

    // ---------------------------------------------------------------- drop / set down
    // GAME_DESIGN §4.1: a TAP drops — instant, and a 40 m broadcast at class D. A 2.1 s HOLD sets
    // the part down, and makes no sound at all. Under pressure, everyone drops (§10.3).
    // GAME_DESIGN §9.6 deleted the throw verb ("You do not throw things. You are a carpenter."),
    // so the `throwPart` binding is a second, dedicated set-down rather than a throw.
    this._dropHeld = this._holdVerb(input, 'drop', dt, this._dropHeld, true);
    this._setDownHeld = this._holdVerb(input, 'throwPart', dt, this._setDownHeld, false);

    // ---------------------------------------------------------------- pry out (`build:remove`)
    this._updatePry(input, dt);

    // ---------------------------------------------------------------- lantern (GAME_DESIGN §4.1)
    // NOT HANDLED HERE. `Flashlight` reads the `lantern` action itself (Flashlight._readInput):
    // it tracks its own key-down edge, discriminates tap from hold against TUNING.tapSeconds,
    // toggles on a tap release and hoods/unhoods on a hold. Player used to do the same thing,
    // so one 140 ms tap of F ran toggle() TWICE in the same frame — ignite and douse at an
    // identical performance.now(), lantern ending off. Hooding survived only because setHood()
    // is idempotent. One owner per input. Do not re-add a lantern branch to this method.
  }

  /**
   * One tap/hold verb for putting a part down. Returns the new hold timer.
   * `tapDrops` distinguishes the loud tap-drop (`drop`) from the hold-only set-down (`throwPart`).
   * The negative sentinel latches the hold so it cannot fire twice, and so releasing after a
   * completed set-down does not also fire the loud drop.
   */
  _holdVerb(input, action, dt, held, tapDrops) {
    if (input.wasPressed?.(action)) held = 0;
    if (input.isDown?.(action)) {
      if (held >= 0) {
        held += dt;
        if (held >= T.setDownTime && this.carried.length) { this._dropCarried(true); held = -1; }
      }
    } else if (input.wasReleased?.(action)) {
      if (tapDrops && held >= 0 && held < T.setDownTime) this._dropCarried(false);
      held = 0;
    }
    return held;
  }

  // ===============================================================================================
  // PRY OUT — the input path for `BuildSystem.removeJoin()`.
  //
  // WHY THIS KEY, AND WHY IT CANNOT COLLIDE.
  //
  //   `Q` (`drop`) already means one thing: LET GO OF WHAT IS IN YOUR HANDS. A tap drops it loudly,
  //   a 2.1 s hold sets it down silently (GAME_DESIGN §4.1, §10.3). With your hands empty, the only
  //   thing you are still holding is the cabin — so the same key, held, aimed at a join you built,
  //   takes it back out. One key, one meaning, two hand states.
  //
  //   The collision check is structural, not a convention: every existing `Q` verb is gated on
  //   `this.carried.length`, and this one returns immediately unless `carried` is EMPTY. The two
  //   branches are disjoint by construction and cannot both fire from one press. MEASURED, and it
  //   is why the latch below exists: without it a single unbroken press completed the 2.1 s
  //   set-down, emptied the hands, and then armed the pry 1.1 s later — one key, two verbs, on a
  //   player who never let go. A press that ever held a part is spent for the rest of that press.
  //   Nothing else is
  //   touched — `E` interact/repair/provoke, `G` set down, `R`/`T` rotate, `F` lantern (Flashlight
  //   owns that binding end to end) and `LMB` place/seat/saw are all unchanged, and BuildSystem's
  //   own `Q` fallback only runs when Player does not own the carry, where `dropHeld()` on empty
  //   hands is already a no-op.
  //
  //   1.10 s: half the set-down, so the gesture reads as less ceremony than putting a beam down,
  //   and long enough that §10.3's panic-drop reflex cannot tear the foundation out by accident.
  //
  // WHY IT HAD TO EXIST. GAME_DESIGN §6.3 — "Removal (`build:remove`) is always allowed, costs 8 s"
  // — and §7.4's Re-seat is `build:remove` + re-place, the honest fix for a seating deficit. §17
  // spends the beat at 4:52 on it: the first creak fires, Dale turns toward the plot, and "the
  // player must now re-seat (8 s + 3.0 s, loud), or hide, or freeze. All three work." Two of those
  // three had inputs. This is the third.
  //
  // NO TEXT. §17 is binding: the game has not addressed the player since the title card. The verb
  // announces itself the way every other verb in this file does — a pictogram on a keycap, drawn by
  // HUD, through its documented `setPrompt(text, key, opts)`. `remove` is already in HUD's
  // pictogram table; `drop` is already an action HUD can label. Not one word is added anywhere.
  // ===============================================================================================

  /**
   * Held `Q`, empty-handed, aimed at a join → `BuildSystem.removeJoin(slotId)`.
   *
   * Player does not implement removal and does not make its noise: BuildSystem owns the 8 s action,
   * the single `wrench` emit at 24 m / 0.45, the `nail.pull` sfx and the dropped part. All this
   * method does is choose the join, count the hold, and draw the card.
   */
  _updatePry(input, dt) {
    const down = !!input.isDown?.('drop');
    if (!down) { this._pryHeld = 0; this._pryLatched = false; }

    // Hands full: `Q` is the drop and the set-down. Not ours — and this press never becomes ours,
    // even after the set-down empties the hands, or one unbroken hold would put a beam down and
    // then start tearing out the join behind it. Let go and press again to pry.
    if (this.carried.length) { this._pryLatched = true; this._pryReset(); return; }

    const bs = this._sys('BuildSystem');
    if (!bs || typeof bs.removeJoin !== 'function') { this._pryReset(); return; }

    // An 8 s removal is running. Hold the card up and let the ring report it — this is the only
    // progress readout the verb gets, and it is drawn on a keycap rather than said out loud.
    let act = null;
    try { act = bs.action; } catch { act = null; }
    if (act) {
      this._pryHeld = 0;
      this._pryLatched = true;
      if (act.kind === 'remove') this._pryPrompt('remove', clamp01((act.t || 0) / (act.duration || 1)));
      else this._pryClearPrompt();
      return;
    }

    const slotId = this._pryTarget(bs);
    if (slotId !== this._prySlotId) { this._prySlotId = slotId; this._pryHeld = 0; }
    if (!slotId) { this._pryClearPrompt(); return; }

    // §7.4 / §6.3: refused while anything resting on it is still filled. `removeJoin` refuses too;
    // pre-checking is what lets the card say so — with the ✗ glyph, wordlessly — before the hold.
    const blocked = this._pryBlocked(bs, slotId);

    if (down && !this._pryLatched && !blocked) {
      this._pryHeld += dt;
      if (this._pryHeld >= T.pryTime) {
        this._pryLatched = true;
        this._pryHeld = 0;
        let ok = false;
        try { ok = bs.removeJoin(slotId) === true; }
        catch (e) { Log.once('player:pry', 'Player: BuildSystem.removeJoin threw.', e); }
        if (ok) this.pryCount++;
        return;
      }
    }

    // The standing prompt appears only where the cabin is VISIBLY wrong — proud, gapped, sagging,
    // split. A flush join is not nagged about, because the manual does not nag and the game has
    // never once told the player what to do. It still shows up the moment a hold starts on one,
    // which is the wordless "are you sure": release before the ring closes and nothing happened.
    const wrong = this._pryRec.visual !== 'flush';
    if (!wrong && this._pryHeld < T.pryWarnAfter) { this._pryClearPrompt(); return; }

    // One card at a time: while `E` is mid-repair on this join, that verb owns the prompt.
    let intent = null;
    try { intent = bs.repairIntent; } catch { intent = null; }
    if (intent && this._pryHeld <= 0) { this._pryClearPrompt(); return; }

    this._pryPrompt(blocked ? 'blocked' : 'remove', clamp01(this._pryHeld / T.pryTime));
  }

  /**
   * The installed join under the reticle, or null. Rate-limited to `pryScanEvery` frames and
   * allocation-free: the slot list is a cached flat mirror and `visualStateFor()` returns a string.
   */
  _pryTarget(bs) {
    if (this._frame % T.pryScanEvery !== 0) return this._pryRec.id;
    const rec = this._pryRec;
    rec.id = null;
    rec.visual = '';

    const list = this._pryScanList(bs);
    if (!list || !list.length) return null;

    _fwd.copy(this.lookAt);
    let bestScore = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || !Number.isFinite(s.px)) continue;
      _v2.set(s.px, s.py, s.pz).sub(this._currEye);
      const dist = _v2.length();
      if (dist > T.pryReach || dist < 1e-4) continue;
      _v2.multiplyScalar(1 / dist);
      const dot = _v2.dot(_fwd);
      if (dot < T.pryDot) continue;
      let visual = 'empty';
      try { visual = bs.visualStateFor(s.id) || 'empty'; } catch { visual = 'empty'; }
      if (visual === 'empty') continue;          // nothing installed here — nothing to take out
      const score = dot * 2 - dist * 0.3;
      if (score > bestScore) { bestScore = score; rec.id = s.id; rec.visual = visual; }
    }
    return rec.id;
  }

  /** Any dependent still filled refuses the removal (§6.3). Reads only documented BuildSystem API. */
  _pryBlocked(bs, slotId) {
    let slot = null;
    try { slot = bs.slotById?.(slotId) ?? null; } catch { return false; }
    const deps = slot?.dependents;
    if (!deps || !deps.length) return false;
    for (let i = 0; i < deps.length; i++) {
      let v = 'empty';
      try { v = bs.visualStateFor(deps[i]); } catch { /* a stub BuildSystem blocks nothing */ }
      if (v && v !== 'empty') return true;
    }
    return false;
  }

  /**
   * A flat mirror of BuildSystem's slot table, rebuilt only when that table changes size — once a
   * night, not once a frame. `Map.forEach` with a pre-bound callback allocates nothing.
   */
  _pryScanList(bs) {
    let map = null;
    try { map = bs.slots; } catch { map = null; }
    if (!map || typeof map.size !== 'number' || typeof map.forEach !== 'function') {
      try { return bs.nightSlots ?? null; } catch { return null; }
    }
    if (map.size !== this._pryScanSize) {
      this._pryScanSize = map.size;
      this._pryScan.length = 0;
      map.forEach(this._pryPush);
    }
    return this._pryScan;
  }

  /** HUD's documented `setPrompt(text, key, opts)`. A pictogram, a keycap, and a ring. No words. */
  _pryPrompt(icon, progress) {
    const hud = this._sys('HUD');
    if (!hud || typeof hud.setPrompt !== 'function') return;
    _promptOpts.progress = progress;
    try { hud.setPrompt(icon, 'drop', _promptOpts); } catch (e) {
      Log.once('player:pryprompt', 'Player: HUD.setPrompt threw.', e);
    }
    this._pryPromptOn = true;
  }

  /** Hands the prompt back to HUD's own logic. Never touches the hold timer. */
  _pryClearPrompt() {
    if (!this._pryPromptOn) return;
    this._pryPromptOn = false;
    const hud = this._sys('HUD');
    try { hud?.setPrompt?.(null, null); } catch { /* nothing to hand back to */ }
  }

  _pryReset() {
    this._pryHeld = 0;
    this._prySlotId = null;
    this._pryRec.id = null;
    this._pryRec.visual = '';
    this._pryClearPrompt();
  }

  // ===============================================================================================
  // Interaction
  // ===============================================================================================

  _onInteractPress() {
    const bs = this._sys('BuildSystem');
    const target = this.interactTarget;

    // BuildSystem owns pickup, place and the seating check. Ask it first, in the several shapes it
    // might reasonably expose, and let it have the input if it takes it.
    if (bs) {
      try {
        if (typeof bs.onInteract === 'function' && bs.onInteract(target, this) === true) return;
        if (this.carried.length && typeof bs.tryPlace === 'function' && bs.tryPlace(this.carriedPart, this) === true) return;
        if (target?.part && typeof bs.tryPickup === 'function' && bs.tryPickup(target.part, this) === true) return;
      } catch (e) {
        Log.once('player:buildsystem', 'Player: BuildSystem interact hook threw — falling back to local carry.', e);
      }
    }

    // Fallback so the controller is playable and testable with no BuildSystem in the build.
    if (!this.carried.length && target?.object) this._localPickup(target.object, target.part);
  }

  _onInteractHold(held) {
    const bs = this._sys('BuildSystem');
    if (!bs || typeof bs.onInteractHold !== 'function') return;
    try { bs.onInteractHold(this.interactTarget, held, this); }
    catch (e) { Log.once('player:holdhook', 'Player: BuildSystem.onInteractHold threw.', e); }
  }

  _onInteractRelease(held) {
    const bs = this._sys('BuildSystem');
    if (!bs || typeof bs.onInteractRelease !== 'function') return;
    try { bs.onInteractRelease(this.interactTarget, held, this); }
    catch (e) { Log.once('player:relhook', 'Player: BuildSystem.onInteractRelease threw.', e); }
  }

  /**
   * A short forward ray under the reticle. ARCHITECTURE §12 caps the whole game at 12 raycasts a
   * frame, so this fires once every three frames and caches; the reticle is not a sensor and a
   * 50 ms stale target has never been noticed by anyone.
   */
  _updateInteract() {
    if (this._frame % T.interactRayEvery !== 0) return;
    if (!this.controlEnabled) { this.interactTarget = null; return; }

    const phys = this._phys();
    if (!phys?.raycast) { this.interactTarget = null; return; }

    _v.copy(this._currEye);
    _v2.copy(this.lookAt);
    const MASKS = phys.constructor?.MASK ?? phys.MASK;
    const mask = MASKS?.WORLD ?? MASKS?.SOLID ?? 0xffffffff;

    let hit = null;
    try { hit = phys.raycast(_v, _v2, T.interactRange, mask); }
    catch (e) { Log.once('player:ray', 'Player: Physics.raycast threw; interaction disabled.', e); this.interactTarget = null; return; }

    if (!hit) { this.interactTarget = null; return; }

    // Hits are pooled — copy everything we intend to keep, right now.
    if (!this._targetRec) {
      this._targetRec = { object: null, part: null, kind: '', distance: 0, point: new THREE.Vector3(), prompt: '', action: '' };
    }
    const rec = this._targetRec;
    rec.object = hit.object ?? null;
    rec.kind = hit.kind ?? '';
    rec.distance = hit.distance ?? 0;
    if (hit.point) rec.point.copy(hit.point);

    rec.part = this._resolvePart(rec.object) ?? (hit.collider?.part ?? null);

    const carrying = this.carried.length > 0;
    if (carrying) { rec.action = 'place'; rec.prompt = 'place'; }
    else if (rec.part) { rec.action = 'pickup'; rec.prompt = 'pick up'; }
    else if (rec.kind === 'crate' || rec.kind === 'prop') { rec.action = 'interact'; rec.prompt = 'open'; }
    else { this.interactTarget = null; return; }

    this.interactTarget = rec;
  }

  /** Walk up the parent chain looking for something a Part generator would have tagged. */
  _resolvePart(object3D) {
    let o = object3D;
    let guard = 0;
    while (o && guard++ < 8) {
      const ud = o.userData;
      if (ud) {
        if (ud.part) return ud.part;
        if (ud.interactable) return ud.interactable;
        if (ud.partId || ud.isPart) return o;
      }
      o = o.parent;
    }
    return null;
  }

  // ===============================================================================================
  // Carry
  // ===============================================================================================

  /** GAME_DESIGN §6.1/§6.2 — a part's carry class, from its own hint or from its mass. */
  static classForMass(mass, hint) {
    if (hint && CARRY[hint]) return hint;
    const m = Number.isFinite(mass) ? mass : 0;
    if (m < 1.5) return 'A';
    if (m < 8) return 'B';
    if (m < 35) return 'C';
    if (m <= 70) return 'D';
    if (m <= 75) return 'endLift';   // the 71 kg north wall panel — pivoted, not carried
    return 'E';                       // a body. The hearth stone. Dragged.
  }

  /**
   * BuildSystem calls this on a successful pickup. Player accepts it defensively so a part is
   * simply `{ mass, object3D }` if that is all another agent has.
   * @returns {boolean} false if there is no room in the 4 slots.
   */
  setCarried(part) {
    if (!part) return false;
    const mass = part.mass ?? part.massKg ?? 0;
    const cls = Player.classForMass(mass, part.carryClass);
    const slots = CARRY[cls]?.slots ?? 1;
    if (this.carrySlots + slots > 4) return false;

    this.carried.push(part);
    this._phys()?.releaseCarried?.(part);   // so it springs from the hands, not from the ground
    this._recomputeCarry();
    return true;
  }

  /** Remove a specific part (BuildSystem seated it, or took it back). No noise, no event. */
  removeCarried(part) {
    const i = this.carried.indexOf(part);
    if (i < 0) return false;
    this.carried.splice(i, 1);
    this._phys()?.releaseCarried?.(part);
    this._recomputeCarry();
    return true;
  }

  clearCarried() {
    for (const p of this.carried) this._phys()?.releaseCarried?.(p);
    this.carried.length = 0;
    this._recomputeCarry();
  }

  _recomputeCarry() {
    let mass = 0, slots = 0, speed = 1, turn = 1, worst = 0;
    for (const p of this.carried) {
      const m = p?.mass ?? p?.massKg ?? 0;
      const cls = Player.classForMass(m, p?.carryClass);
      const row = CARRY[cls] ?? CARRY.A;
      mass += m;
      slots += row.slots;
      speed *= row.speed;    // GAME_DESIGN §6.2: "two class-C parts stack multiplicatively"
      turn *= row.turn;
      worst = Math.max(worst, CARRY_ORDER.indexOf(cls));
    }
    this.carriedPart = this.carried[0] ?? null;
    this.carryMass = mass;
    this.carrySlots = slots;
    this.carryClass = CARRY_ORDER[worst] ?? 'A';
    this.carrySpeedMul = clamp(speed, 0.25, 1);
    this.carryTurnMul = clamp(turn, 0.25, 1);
    if (!this.carried.length) { this.carryClass = 'A'; this.carrySpeedMul = 1; this.carryTurnMul = 1; }
    // You cannot crouch under a beam and you cannot hold a hammer while dragging a person.
    if (!(CARRY[this.carryClass]?.crouch)) { this._crouchToggled = false; }
  }

  /** Local carry, used only when BuildSystem is absent. Never emits `build:*`. */
  _localPickup(object3D, part) {
    const p = part ?? { object3D, mass: object3D?.userData?.mass ?? 12 };
    if (!p.object3D && !p.mesh && !p.group && !p.root) p.object3D = object3D;
    if (this.setCarried(p)) Log.debug('Player: local pickup (no BuildSystem registered).');
  }

  /**
   * GAME_DESIGN §4.1 / §9.8: DROP is instant and loud; SET DOWN is 2.1 s and silent.
   * "Under pressure, everyone drops."
   */
  _dropCarried(silent) {
    if (!this.carried.length) return;
    const part = this.carried[this.carried.length - 1];
    const cls = Player.classForMass(part?.mass ?? part?.massKg ?? 0, part?.carryClass);

    const bs = this._sys('BuildSystem');
    let handled = false;
    if (bs) {
      try {
        if (typeof bs.dropPart === 'function') handled = bs.dropPart(part, { silent, player: this }) === true;
        else if (typeof bs.onDrop === 'function') handled = bs.onDrop(part, silent, this) === true;
      } catch (e) { Log.once('player:drop', 'Player: BuildSystem drop hook threw.', e); }
    }

    this.removeCarried(part);

    if (handled || silent) return;   // BuildSystem owns the noise if it took the drop; a set-down
                                     // makes none by definition — that is the entire trade.
    const row = DROP_ROW[cls] ?? DROP_ROW.C;
    this.bus?.emit('noise:emit', noiseSlot(
      this.position.x, this.position.y, this.position.z, row.radius, row.intensity, 'drop',
    ));
    _sfxPayload.id = row.sfx;
    _sfxPayload.position.copy(this.position);
    _sfxPayload.volume = 1;
    _sfxPayload.rate = 1;
    this.bus?.emit('audio:sfx', _sfxPayload);
  }

  /**
   * The hand anchor. Not parented to the camera: a carried part lives in world space so it can
   * foul a trunk, and Physics resolves the contact by pivoting it about the grip.
   */
  _updateHandAnchor() {
    const a = this.handAnchor;
    const cls = this.carryClass;

    _euler.set(this.viewPitch * 0.55, this.viewYaw, 0, 'YXZ');
    _quat.setFromEuler(_euler);
    _fwd.set(0, 0, -1).applyQuaternion(_quat);
    _right.set(1, 0, 0).applyQuaternion(_quat);

    // Where the load sits, by class (GAME_DESIGN §4.3's poses, as offsets from the eye).
    let f = 0.62, r = 0.10, u = -0.42;
    if (cls === 'C') { f = 0.72; r = 0.02; u = -0.52; }
    else if (cls === 'D') { f = 0.30; r = 0.30; u = -0.10; }       // on the right shoulder
    else if (cls === 'endLift') { f = 0.55; r = 0.16; u = -0.22; }
    else if (cls === 'E') { f = -0.35; r = 0.00; u = -0.85; }      // both hands back and low

    a.position.set(
      this._currEye.x + _fwd.x * f + _right.x * r,
      this._currEye.y + u + _fwd.y * f,
      this._currEye.z + _fwd.z * f + _right.z * r,
    );
    a.quaternion.copy(_quat);
    a.updateMatrix();
    a.updateMatrixWorld(true);
  }

  _simulateCarried(fdt) {
    if (!this.carried.length) return;
    const phys = this._phys();
    if (!phys?.simulateCarried) return;
    for (let i = 0; i < this.carried.length; i++) {
      try { phys.simulateCarried(this.carried[i], this.handAnchor, fdt); }
      catch (e) { Log.once('player:carrysim', 'Player: Physics.simulateCarried threw.', e); return; }
    }
  }

  // ===============================================================================================
  // Fear — a camera property, never a control property.
  // ===============================================================================================

  _updateFear(dt) {
    if (this._frame % T.fearQueryEvery === 0) this._sampleFearSources();

    const rate = this._fearTarget > this.fear ? T.fearRise : T.fearFall;
    this.fear += clamp(this._fearTarget - this.fear, -rate * dt, rate * dt);
    this.fear = clamp01(this.fear);

    // ART §9.5: the lens does not announce a state change. `setPanic` is a slow scalar the post
    // stack may use for grain/vignette weighting; it is not a stinger and it must never be one.
    const pp = this._sys('Postprocessing');
    if (pp && typeof pp.setPanic === 'function' && Math.abs(this.fear - this._lastPanic) > 0.005) {
      this._lastPanic = this.fear;
      try { pp.setPanic(this.fear); } catch (e) { Log.once('player:panic', 'Player: setPanic threw.', e); }
    }
  }

  _sampleFearSources() {
    const state = this.ctx?.state;
    let target = 0;

    // Camp-wide alert is a low, persistent floor.
    if (state && typeof state.suspicion === 'number') target = Math.max(target, state.suspicion * 0.35);

    // Campers.js is authored by another agent and has not published its collection shape yet.
    // TODO(api): agree on `Campers.list` returning an array of agents with `.position` and
    // `.detection`. Until then, accept an Array, a Set, or a Map of them, and shrug at anything else.
    const campers = this._sys('Campers');
    let nearest = Infinity;
    let maxDetect = 0;
    const raw = campers ? (campers.list ?? campers.campers ?? campers.agents ?? campers.all) : null;
    let iter = null;
    if (Array.isArray(raw)) iter = raw;
    else if (raw instanceof Map) iter = raw.values();
    else if (raw instanceof Set) iter = raw;
    else if (raw && typeof raw[Symbol.iterator] === 'function') iter = raw;
    if (iter) {
      for (const c of iter) {
        if (!c || typeof c !== 'object') continue;
        const p = c.position ?? c.pos;
        if (p && Number.isFinite(p.x)) {
          const dx = p.x - this.position.x, dz = p.z - this.position.z;
          const d = Math.hypot(dx, dz);
          if (d < nearest) nearest = d;
        }
        const det = c.detection ?? c.detect;
        if (typeof det === 'number' && det > maxDetect) maxDetect = det;
      }
    }
    this._fearNearest = nearest;

    if (Number.isFinite(nearest)) {
      target = Math.max(target, clamp01(1 - nearest / T.fearProxRange) * 0.55);
    }
    target = Math.max(target, clamp01(maxDetect) * 0.90);
    if (state?.spotted) target = Math.max(target, 0.75);

    this._fearTarget = clamp01(target);
  }

  /** Public hook: NightManager or Campers may nudge fear for a scripted beat. */
  addFear(amount) { this.fear = clamp01(this.fear + (amount || 0)); }

  /** Public hook: the one input lock in the game (GAME_DESIGN §4.4, Night 7). */
  lockInput(locked) { this.inputLocked = !!locked; }

  // ===============================================================================================
  // handState — STORY §2.4.1. Read-only for BlueprintUI.
  // ===============================================================================================

  _updateHandState(dt) {
    this._handStateTimer -= dt;
    if (this._handStateTimer > 0) return;
    this._handStateTimer = 0.5;

    const state = this.ctx?.state;
    const night = state?.night ?? 1;

    // A week of cold work. By Night 7 they are split and the wipe stops working.
    if (night >= 7) { this.handState = 'split'; return; }
    if (state?.storyFlags?.firstBlood) { this.handState = 'bloodied'; return; }

    if (this.groundType === 'mud' && this.isMoving) this._mudTimer = 25;
    else this._mudTimer = Math.max(0, this._mudTimer - 0.5);
    if (this._mudTimer > 0) { this.handState = 'muddy'; return; }

    const weather = this._sys('Weather');
    const rain = typeof weather?.rain === 'number' ? weather.rain : 0;
    this.handState = rain > 0.2 ? 'wet' : 'dry';
  }

  // ===============================================================================================
  // The camera. ART §9.2's four additive layers, plus the poses from GAME_DESIGN §4.3.
  // ===============================================================================================

  _composeCamera(dt, elapsed) {
    const cam = this.camera;
    if (!cam) return;

    const settings = this.ctx?.settings;
    const reduced = !!settings?.get?.('reducedMotion');
    const bobOn = settings?.get?.('headBob') !== false;
    // ART §9.2: headBob off keeps breathing and tremor at 60% and kills sway and impact.
    // reducedMotion kills the lot; only the crouch lerp and the landing survive, halved.
    const swayW = reduced ? 0 : (bobOn ? 1 : 0);
    const noiseW = reduced ? 0 : (bobOn ? 1 : 0.6);
    const impactW = reduced ? 0.25 : (bobOn ? 1 : 0);

    // -------------------------------------------------- interpolate the 60 Hz eye to frame time
    let alpha = 1;
    const acc = this.ctx?.engine?._accumulator;
    if (typeof acc === 'number' && Number.isFinite(acc)) alpha = clamp01(acc * 60);
    _v.lerpVectors(this._prevEye, this._currEye, alpha);
    this.eyePosition.copy(_v);

    // -------------------------------------------------- springs
    //
    // Both springs are integrated with SEMI-IMPLICIT EULER, which is only conditionally stable:
    // it needs omega*dt < 2*zeta, i.e. dt < 46 ms at stepSmoothW 18. `Engine.MAX_FRAME_DT` allows
    // dt = 100 ms, where the eigenvalue is -5.33 PER FRAME. An evaluator measured the result:
    // _stepSmooth 1560 m, _stepSmoothVel 18679 m/s, camera.position.y swinging +41,847 -> -7,189.
    //
    // It was also UNRECOVERABLE, because the reset below only fires BELOW 1e-4 — a test a diverged
    // spring can never satisfy. So one slow frame while stepping over anything left the camera
    // ringing for the rest of the session, including while standing perfectly still. And because
    // `BuildSystem._eye()` reads this camera, pickup and placement silently stopped working while
    // the world still rendered normally.
    //
    // Fixed by substepping at a bound the integrator is always stable at, rather than by clamping
    // the frame. At SPRING_DT the worst case is omega*dt = 18/240 = 0.075, three orders inside the
    // limit, and at 60 fps the result is within rounding of the old path — the feel is unchanged.
    const SPRING_DT = 1 / 240;
    const nSub = Math.min(64, Math.max(1, Math.ceil(dt / SPRING_DT)));
    const sdt = dt / nSub;
    const lw = T.landSpringW, lz = T.landSpringZ;
    const sw = T.stepSmoothW;
    for (let i = 0; i < nSub; i++) {
      // Landing dip: ζ 0.56 / ω 17 → one 12% overshoot, ~0.42 s recovery (ART §9.2).
      this._landVel += (-lw * lw * this._landImpulse - 2 * lz * lw * this._landVel) * sdt;
      this._landImpulse += this._landVel * sdt;
      // Step-up: absorb the lift, then give it back.
      this._stepSmoothVel += (-sw * sw * this._stepSmooth - 2 * sw * this._stepSmoothVel) * sdt;
      this._stepSmooth += this._stepSmoothVel * sdt;
    }
    if (Math.abs(this._landImpulse) < 1e-4 && Math.abs(this._landVel) < 1e-4) { this._landImpulse = 0; this._landVel = 0; }
    if (Math.abs(this._stepSmooth) < 1e-4) { this._stepSmooth = 0; this._stepSmoothVel = 0; }

    // A guard that CAN fire. The two tests above are floors, so they are unreachable once a spring
    // has run away; these are ceilings. _landImpulse is built from clamp01 and _stepSmooth from
    // min(rise, stepHeight 0.45), so neither has any business exceeding these bounds — reaching
    // one means the integrator has gone unstable and the camera is unusable until it is reset.
    if (!Number.isFinite(this._landImpulse) || !Number.isFinite(this._landVel) || Math.abs(this._landImpulse) > 4) {
      Log.once('player:land-spring', 'Player: landing spring diverged — reset. Report the frame rate this happened at.');
      this._landImpulse = 0; this._landVel = 0;
    }
    if (!Number.isFinite(this._stepSmooth) || !Number.isFinite(this._stepSmoothVel) || Math.abs(this._stepSmooth) > 2) {
      Log.once('player:step-spring', 'Player: step-up spring diverged — reset. Report the frame rate this happened at.');
      this._stepSmooth = 0; this._stepSmoothVel = 0;
    }

    // -------------------------------------------------- footstep sway (the figure-8)
    const cls = this.carryClass;
    let A = T.swayWalk;
    if (this.isCrouched) A = T.swayCrouch;
    else if (this.isSprinting && this._sprintBlend > 0.4) A = T.swaySprint;
    let ax = A[0], ay = A[1], ar = A[2];
    let rollBias = 0;
    if (cls === 'C' || cls === 'D') {
      ax *= T.swayCarryMul; ay *= T.swayCarryMul; ar *= T.swayCarryMul;
      rollBias = T.swayCarryRollBias * (cls === 'D' ? 1 : 0.55);
    } else if (cls === 'endLift' || cls === 'E') {
      ax *= T.swayEndLiftMul; ay *= T.swayEndLiftMul; ar *= T.swayEndLiftMul;
      rollBias = T.swayEndLiftRollBias;
    }
    // Sway fades out with speed so a standing man is not swaying on the spot.
    const gaitW = clamp01(this.speed / 0.45) * swayW;
    const p = this._bobPhase;
    const swayX = Math.sin(p) * ax * gaitW;
    const swayY = Math.sin(2 * p) * ay * gaitW;
    const swayRoll = (Math.sin(p + 0.4) * ar + rollBias) * gaitW * DEG;

    // A 0.7 Hz longitudinal surge as the load's mass leads and trails him (ART §9.2).
    let surge = 0;
    if ((cls === 'endLift' || cls === 'E') && swayW > 0) {
      this._surgePhase += dt * T.endLiftSurgeHz * Math.PI * 2;
      surge = Math.sin(this._surgePhase) * T.endLiftSurgeAmp * clamp01(this.speed / 0.4);
    }

    // -------------------------------------------------- breathing
    // 0.24 Hz idle → 0.55 Hz exerted. Exertion is stamina drain OR fear. Fear changes how he
    // BREATHES; it does not change how he MOVES. That is the whole rule.
    const exertion = clamp01(Math.max(1 - this.stamina / T.staminaMax, this.fear * 0.85, this.speed / T.sprintSpeed * 0.4));
    const breathHz = T.breathHzIdle + (T.breathHzExerted - T.breathHzIdle) * exertion;
    this._breathPhase = (this._breathPhase + dt * breathHz) % 1;
    // Asymmetric envelope: inhale 38% of the cycle, exhale 62%. A slow inhale is unsettling.
    const bp = this._breathPhase;
    let bEnv;
    if (bp < T.breathInhaleFrac) bEnv = -Math.cos((bp / T.breathInhaleFrac) * Math.PI) * 0.5 + 0.5;
    else bEnv = Math.cos(((bp - T.breathInhaleFrac) / (1 - T.breathInhaleFrac)) * Math.PI) * 0.5 + 0.5;
    const bSigned = bEnv * 2 - 1;
    const breathDepth = (0.7 + 0.6 * exertion) * noiseW;
    const breathY = bSigned * T.breathY * breathDepth;
    const breathPitch = bSigned * T.breathPitch * DEG * breathDepth;
    const breathRoll = bSigned * T.breathRoll * DEG * breathDepth;

    // -------------------------------------------------- micro-tremor (1/f, ±0.09° RMS)
    // This alone is what makes the frame read as held by a person. Fear widens it slightly; it is
    // still measured in hundredths of a degree, and it never moves the aim.
    const tremorGain = T.tremorRms * DEG * noiseW * (1 + 0.9 * this.fear);
    const tremorYaw = this._tremorYaw.value * tremorGain;
    const tremorPitch = this._tremorPitch.value * tremorGain;

    // -------------------------------------------------- footfall kick + lean
    const footPitch = -this._footKick * T.footPitchKick * DEG * impactW;
    const landPitch = -this._landImpulse * T.landPitchMax * DEG * (reduced ? 0.4 : 1);
    const landY = -this._landImpulse * T.landDipY * (reduced ? 0.4 : 1);

    // Lean on strafe: lateral velocity relative to the BODY, not the view.
    _right.set(Math.cos(this.bodyYaw), 0, -Math.sin(this.bodyYaw));
    const lateral = this.velocity.x * _right.x + this.velocity.z * _right.z;
    const leanTarget = clamp(-lateral / T.walkSpeed, -1, 1) * T.strafeRoll * DEG * (reduced ? 0 : 1);
    this._leanRoll += (leanTarget - this._leanRoll) * clamp01(dt / T.leanTau);

    // -------------------------------------------------- carry pose
    const poseTarget = (CARRY[cls]?.pitch ?? 0) * DEG;
    this._posePitch += (poseTarget - this._posePitch) * clamp01(dt / T.posePitchTau);
    const poseRollTarget = (cls === 'D' ? 1.4 : cls === 'endLift' ? 1.1 : cls === 'C' ? 0.4 : 0) * DEG;
    this._poseRoll += (poseRollTarget - this._poseRoll) * clamp01(dt / T.posePitchTau);

    // -------------------------------------------------- assemble the rotation
    const yaw = this.viewYaw + tremorYaw;
    const pitch = clamp(
      this.viewPitch + tremorPitch + breathPitch + footPitch + landPitch + this._posePitch,
      -89.5 * DEG, 89.5 * DEG,
    );
    const roll = swayRoll + breathRoll + this._leanRoll + this._poseRoll;

    cam.rotation.order = 'YXZ';   // Engine sets it; re-asserted because a wrong order is silent.
    cam.rotation.set(pitch, yaw, roll);

    // -------------------------------------------------- assemble the position
    // The camera sits 0.14 m forward of the neck pivot (GAME_DESIGN §4.3), so a head turn ARCS:
    // the world shifts laterally before it rotates. It is a two-line change and you feel it.
    _fwd.set(0, 0, -1).applyEuler(cam.rotation);
    _right.set(1, 0, 0).applyEuler(cam.rotation);

    cam.position.set(
      this.eyePosition.x + _fwd.x * (T.neckForward + surge) + _right.x * swayX,
      this.eyePosition.y + swayY + breathY + landY + this._stepSmooth + _fwd.y * (T.neckForward + surge),
      this.eyePosition.z + _fwd.z * (T.neckForward + surge) + _right.z * swayX,
    );

    // -------------------------------------------------- FOV (ART §9.1)
    let fovTarget = this._fovBase;
    let fovTau = T.fovTauSprint;
    if (this._blueprintOpen) { fovTarget = T.fovBlueprint; fovTau = T.fovTauBlueprint; }
    else if (this.isSprinting && this._sprintBlend > 0.4) { fovTarget = T.fovSprint; fovTau = T.fovTauSprint; }
    else if (this.isCrouched && !this.isMoving) { fovTarget = T.fovCrouchStill; fovTau = T.fovTauCrouch; }
    if (reduced) fovTarget = this._fovBase;   // FOV animation is a nausea trigger; honour the flag.
    this._fov += (fovTarget - this._fov) * clamp01(dt / fovTau);
    if (Math.abs(cam.fov - this._fov) > 0.01) {
      cam.fov = this._fov;
      cam.updateProjectionMatrix();
    }

    if (elapsed !== undefined) this._elapsed = elapsed;
  }

  /** Snap the camera exactly onto the eye with no layers — used at init and after a teleport. */
  _syncCameraImmediate() {
    const cam = this.camera;
    if (!cam) return;
    this.viewYaw = this.aimYaw;
    this.viewPitch = this.aimPitch;
    this._viewYawVel = 0; this._viewPitchVel = 0;
    cam.rotation.order = 'YXZ';
    cam.rotation.set(this.viewPitch, this.viewYaw, 0);
    cam.position.copy(this._currEye);
  }

  /**
   * The screenshot harness (`Shots.js`) poses the camera itself and writes `player.position`.
   * It runs after us in registration order, so it wins regardless — but we stop simulating so
   * there is no fight and no drift between the pinned frames.
   */
  _syncFromShots() {
    const cam = this.camera;
    if (!cam) return;
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    this.isMoving = false;
    this._currEye.copy(cam.position);
    this._prevEye.copy(cam.position);
    this.eyePosition.copy(cam.position);
    this.lookAt.set(0, 0, -1).applyQuaternion(cam.quaternion);
  }

  // ===============================================================================================
  // Events out
  // ===============================================================================================

  /** ARCHITECTURE §5 — `player:move { position, speed, crouched }`, every frame. */
  _emitMove() {
    if (!this.bus) return;
    _movePayload.position.copy(this.position);
    _movePayload.speed = this.speed;
    _movePayload.crouched = this.isCrouched;
    this.bus.emit('player:move', _movePayload);
  }

  // ===============================================================================================
  // Public helpers
  // ===============================================================================================

  /** Place the player somewhere and kill all motion. NightManager uses this between nights. */
  teleport(x, y, z, yaw) {
    this.position.set(x, y ?? this._groundHeight(x, z), z);
    this.velocity.set(0, 0, 0);
    if (typeof yaw === 'number') { this.aimYaw = yaw; this.bodyYaw = yaw; }
    this._aimYawVel = 0; this._aimPitchVel = 0; this._bodyYawVel = 0;
    this._landImpulse = 0; this._landVel = 0; this._stepSmooth = 0; this._stepSmoothVel = 0;
    this._currEye.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
    this._prevEye.copy(this._currEye);
    this._moveOut.grounded = false;
    this._syncCameraImmediate();
  }

  /** Fill `outOrigin`/`outDir` with the aim ray. Useful to BuildSystem and HUD. */
  lookRay(outOrigin, outDir) {
    if (outOrigin) outOrigin.copy(this._currEye);
    if (outDir) outDir.copy(this.lookAt);
    return outDir ?? this.lookAt;
  }

  /** Feet position — the same object as `position`, named for callers that want to be explicit. */
  get feetPosition() { return this.position; }
  /** Head position — the same object as `eyePosition`. */
  get headPosition() { return this.eyePosition; }
  /** 0..1 stamina, for HUD. */
  get staminaNorm() { return this.stamina / T.staminaMax; }
  /** GAME_DESIGN §9.3's `motionF` bucket, so Campers never has to guess what the player is doing. */
  get motionState() {
    if (!this.isMoving && this._stillTime > 0.4) return 'still';
    if (this.isSprinting && this._sprintBlend > 0.4) return 'sprint';
    if (this.isCrouched) return 'crouchWalk';
    return 'walk';
  }
}

export { CARRY as PLAYER_CARRY_CLASSES, T as PLAYER_TUNING };
export default Player;
