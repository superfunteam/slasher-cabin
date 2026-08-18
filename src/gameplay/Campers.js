/**
 * Campers.js — THE PEOPLE.
 *
 * OWNER: AI agent. Owns exactly this file.
 *
 * Six specific human beings setting up a summer camp, who happen to be the obstacle. STORY.md is
 * explicit that they are not idiots and not victims-in-waiting, and the whole game only works
 * emotionally if the player believes them — so personality is not flavour text here, it is the
 * branch condition. Bev (bravery 0.85) walks into the dark alone and goes all the way to the far
 * cover point. Teddy (bravery 0.12) turns around, walks to whoever is nearest, and does not leave
 * the lamp line. Same noise, same code path, two completely different nights.
 *
 * ---------------------------------------------------------------------------------------------
 * PUBLIC API — the contract other agents code against
 * ---------------------------------------------------------------------------------------------
 *   const camp = ctx.systems.get('Campers');
 *
 *   camp.agents              CamperAgent[]  live roster for the current night (read-only)
 *   camp.suspicion           0..1           camp-wide; mirrors ctx.state.suspicion
 *   camp.nearestDistance     metres         player → nearest live camper (Infinity if none)
 *   camp.anySeeingPlayer     bool           at least one camper is accruing detection right now
 *   camp.alertLevel          0..1           the loudest state anyone is in
 *   camp.update(dt, elapsed)
 *   camp.dispose()
 *
 *   --- also public, for NightManager / BuildSystem / debug ---------------------------------
 *   camp.detection           0..1           the highest detection meter in the camp
 *   camp.hot                 CamperAgent|null  who is currently looking at you
 *   camp.patrolDensity       int            §13.1, clamped to the night's min/max
 *   camp.reportsTotal        int            reports delivered this run (persisted in state.stats)
 *   camp.rung                int            0..6, the escalation ladder position
 *   camp.agent(id)           CamperAgent|null
 *   camp.spawnRoster(night)                 rebuild the roster (night:begin does this for you)
 *   camp.setScripted(id, opts)              NightManager takes control: { path, look, exit, hold }
 *   camp.releaseScripted(id)
 *   camp.investigate(id, pos, opts)         §17's authored beats: "he heard that." Starts a real
 *                                           Search at a §9.8 error-disc guess. Returns bool.
 *   camp.remove(id, reason)                 the grab, §13.4. Returns false for essential campers.
 *   camp.canGrab(id)                        the three §13.3 conditions, evaluated honestly
 *   camp.registerBody(object3D, concealment)  §13.5 discovery participates from this call on
 *   camp.notifyBodyFound()                  escalation rung 4, if something else found it first
 *   camp.interruptReport(id)                the intercept, §9.7
 *   camp.familiarityOf(id, featureId)       0..1, persists across nights via ctx.state
 *   camp.lum                 0..1           §9.3's illumination ON the player, sampled at 10 Hz
 *   camp.lumParts            {moon,lantern,manual,camp,sky} — the same number, itemised
 *   camp.lightF              0.25 + 1.97*lum — §9.3's light term, so a balance pass can read it
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT `lum` IS MADE OF, AND WHY THE MANUAL IS IN IT
 * ---------------------------------------------------------------------------------------------
 * moon + terrain exposure + Flashlight.illumination + **BlueprintUI.lumBonus** + camp lamps +
 * lightning residual. The manual term is not an afterthought: ART §13.8 mounts a real SpotLight
 * on the open page and BlueprintUI publishes `lumBonus` (0.26 at full open) precisely so this
 * file can add it. Without that one term, standing in the middle of their camp reading the
 * instructions was free — measured at 15 m, moonlit: 15.14 s to be seen with it closed, 6.14 s
 * with it open. That 2.47x is the joke acquiring teeth.
 *
 * ---------------------------------------------------------------------------------------------
 * WHERE THE NUMBERS COME FROM (every one is cited; nothing here is invented where a doc gives one)
 * ---------------------------------------------------------------------------------------------
 *   GAME_DESIGN §9.1   the roster: range R, FOV, torch, hearing threshold, present nights,
 *                      essentialUntilNight. Robin hears at 0.08 — better than the head counselor,
 *                      because ten thousand hours of tools is a stat.
 *   GAME_DESIGN §9.2   the cone: foveal 0–35°, peripheral 35–55° smoothstep 1.00 → 0.20, and the
 *                      one exception (motion inside 3 m always registers at 0.35).
 *   GAME_DESIGN §9.3   THE DERIVED RATE, used verbatim:
 *                        rate = 0.36 * fovSens * rangeF * lightF * motionF * carryF * exposeF
 *                                    * occlF * diffMul
 *                        lightF = 0.25 + 1.97*lum,  motionF { .30/.65/1.00/2.90 }
 *                        noise floor: rate < 0.02 → 0.  Decay 1.2 s grace, 0.25/s (0.45 below 0.3),
 *                        peak memory floor 0.15*peak for 20 s.
 *   GAME_DESIGN §9.4   the flame is a separate percept at R_flame = 180 m and it DOMINATES, it
 *                      does not stack. Flashlight.flameRateFor() owns the formula so the constant
 *                      cannot diverge between two files.
 *   GAME_DESIGN §9.5   Noticing — the cabin is a first-class percept, familiarity persists.
 *   GAME_DESIGN §9.7   the FSM and its exact timers. Curious 6 s, Searching 18/30 s, Noticing 4 s,
 *                      Alerted 3.4 m/s, Panic 2.90 m/s + the deadfall stumble.
 *   GAME_DESIGN §9.8   hearing is NoiseSystem's number and only NoiseSystem's number. There is no
 *                      second model in this file. That equality is the fairness contract.
 *   GAME_DESIGN §13.1  the escalation ladder, rungs 0–6. Being seen is not a game over.
 *   GAME_DESIGN §18.2  the ray budget: 5 for the hot camper every frame, 2 round-robin for
 *                      everyone else, 1 for the flame. Staleness clamp to 1.0 (visible), never to
 *                      the last value.
 *   GAME_DESIGN §20.5  the hot/cold split is a deliberate rejection of a uniform round-robin.
 *                      Do not "fix" it into one.
 *   ART_DIRECTION §8   the silhouette law, the four orthogonal axes, one warm garment each, and
 *                      the walk cycle: torch arm does not swing, head gaze-stabilises, nobody
 *                      stands perfectly still.
 *   ART_DIRECTION §3.2 camper torch: SpotLight #ffe6bb, angle 0.30, penumbra 0.30, intensity 34,
 *                      distance 18, NEVER casts a shadow. Sweep ±34° at 0.11 Hz with 1/f jitter.
 *
 * ---------------------------------------------------------------------------------------------
 * THE BODIES
 * ---------------------------------------------------------------------------------------------
 * No rigged assets exist and none will. Each camper is a joint chain solved on the CPU into a set
 * of rigid segments, and every segment type is ONE InstancedMesh shared across the whole roster:
 * 12 draw calls for the entire cast rather than 17 per person. The rig is deliberately crude
 * because the spec that matters is ART §8.2 — readable as a person, by silhouette alone, at 40 m,
 * with no light on them — and that is won by proportion, stride and arm swing, not by triangles.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------------------------
 *   - It does not model hearing. It asks NoiseSystem, which already models terrain and foliage
 *     occlusion, so the AI hears exactly what the player hears (§9.8).
 *   - It does not end the run. Rung 6 asks NightManager to fail the night; the fallback emit is
 *     the canonical `night:failed` payload and nothing else.
 *   - It does not invent events. ARCHITECTURE §5 is the complete list.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Log } from '../core/Log.js';
import { Rand } from '../core/Rand.js';

// =================================================================================================
// TUNING — one object. A balance pass edits numbers here and never touches logic.
// =================================================================================================

export const CAMPER_TUNING = {
  // --- detection, GAME_DESIGN §9.3 (solved backwards from the four targets; do not round these)
  K: 0.36,
  lightA: 0.25,
  lightB: 1.97,
  motionF: { still: 0.30, crouchWalk: 0.65, walk: 1.00, sprint: 2.90 },
  carryPerSlot: 0.10,
  exposePerSkyline: 0.50,
  noiseFloor: 0.02,
  rangeExp: 1.6,
  decayGrace: 1.20,
  decaySlow: 0.25,
  decayFast: 0.45,
  decayFastBelow: 0.30,
  peakMemory: 20.0,
  peakFloorMul: 0.15,
  flashExpose: 2.00,
  flashExposeTime: 0.25,
  flashMarkError: 3.0,          // §9.4 — they SAW you, they did not hear you

  // --- the cone, §9.2
  fovealFrac: 35 / 55,          // preserves 35°/55° exactly for a 110° counselor
  peripheralFloor: 0.20,
  closeMotionRange: 3.0,
  closeMotionSens: 0.35,
  verticalFovDeg: 70,

  // --- the meter, §9.3
  formingAt: 0.35,
  buildingAt: 0.75,
  holdStillAt: 0.75,            // "camper stops walking"
  // How far the meter must climb before `player:spotted` is published again for the same camper.
  // See `_emitSpotted` — without it the forming band re-emitted at frame rate.
  spottedRepublishStep: 0.10,

  // --- §12.2 / §17 t=2:55 — THE TUTORIAL NIGHT IS THEATRE, AND THIS IS WHAT MAKES IT TRUE.
  // NightManager has written `state.tutorialSafe = (night === 1)` since it was first authored and
  // NOTHING has ever read it, so §12.2's "this is theatre and it is safe" was a comment rather
  // than a guarantee: a player who still had lamp fuel at 4:39 could be detected, Alerted,
  // reported and lose Night 1. The ceiling is what makes it true.
  //
  // THE VALUE IS §17's OWN NUMBER, not a chosen one. §17 t=3:20: "If they don't [crouch]:
  // detection reaches ~0.30 and decays." That is the design telling us what the tutorial night's
  // detection meter is allowed to do, and 0.30 satisfies four separate constraints at once:
  //   < formingAt 0.35    `_meterEvents` never emits `player:spotted` on Night 1, so
  //                       `NightManager.notifySpotted` -> `_escalate('rung2')` -> `enterChase`,
  //                       `Postprocessing.setPanic(1)` and the AudioEngine held-breath mix are all
  //                       unreachable. The Alerted door was already shut; this shuts the OTHER one.
  //   < holdStillAt 0.75  `_tickSearch`'s "camper stops walking" early-out cannot latch, so §17
  //                       t=4:39's "and starts walking" actually happens. The previous 0.92 ceiling
  //                       froze him solid for the whole 30 s search — the lamp's own flame percept
  //                       (§9.4, range 180 m) pins detection at the ceiling from 46 m in ~6 s.
  //   < 1.00              `detection >= 1.0` -> `_fireSpotted` -> `_beginAlert` stays unreachable.
  //   0.62 below NightManager's TUNING.chaseEnterDetection 0.92, which the previous value was
  //   BIT-IDENTICAL to — pinning `detection >= chaseEnterDetection` permanently TRUE on Night 1.
  //   A ceiling must never sit on a threshold; this one is clear of every threshold in the file.
  // He still stops, still swings the torch onto you, still searches, still terrifies. The HUD's
  // "forming" smear (§9.3, 0.01-0.35, 8% opacity, no icon, no number) is exactly the feedback
  // §17 t=3:20 describes, and it is the most the tutorial night is ever allowed to show.
  tutorialDetectionCeil: 0.30,

  // §12.2 "He CANNOT reach the plot." The detection ceiling makes him harmless; this makes him
  // unable to stand on the player, which is a different promise and needs its own number. Only
  // Searching can carry a camper toward the player on Night 1 (patrol routes hold at 183 m,
  // `plotWatchMinNight` is 2, and the scripted walk-in ends at the standoff), so the floor is
  // enforced there. 6.0 m is §9.7's own "the player is on top of him" radius — the distance that
  // would trip Alerted -> Panic on any other night.
  tutorialKeepOut: 6.0,

  // --- FSM timers, §9.7
  noticingTime: 4.0,
  curiousQuiet: 6.0,
  searchToCurious: 18.0,
  searchTotal: 30.0,
  searchArrive: 2.2,            // metres — close enough to the guess to start looking around
  shrugTime: 1.6,
  idleScanPeriod: 4.0,
  idleScanDeg: 40,

  // --- speeds, §9.7 / §9.1
  idleSpeed: 1.20,
  searchSpeed: 1.80,
  alertSpeed: 3.40,
  panicSpeed: 2.90,
  turnRateWalk: 150,            // deg/s
  turnRateRun: 320,
  stumbleChance: 0.50,          // per 4 s on deadfall while Panicking
  stumblePeriod: 4.0,
  stumbleProne: 3.0,

  // --- reports, §9.7
  shortReportSeconds: 26.0,
  longReportSeconds: 40.0,
  witnessRadius: 45.0,          // the cap that makes the intercept arithmetic work
  convergeRadius: 90.0,
  reportMeetDistance: 3.2,
  interceptDistance: 2.0,
  interceptHold: 0.6,

  // --- structure notice, §9.5
  noticeRangeMul: 3.2,
  noticeRate: 0.42,

  // --- body discovery, §13.5
  discoveryHz: 4,
  discoveryRadius: { open: 14.0, concealed: 1.5, submerged: 0 },
  discoveryLum: { open: 0.10, concealed: 0.45, submerged: 2 },

  // --- senses scheduling, §18.2
  hotRays: 5,
  coldPerFrame: 2,
  staleness: 1.0,
  hearHz: 5,
  lumHz: 10,
  skylineHz: 7.5,
  gridRejectBelow: 0.02,

  // --- THE PLOT VIGIL. GAME_DESIGN §3.5 (Tier 2, 58–108 m: "1 patrol passes every ~50 s") and
  // §9.5 (a structure report "routes a patrol past the plot every ~110 s") both require that a
  // camper is periodically inside earshot of the build site. Navmesh authors exactly that route —
  // `the-long-way-round` turns at its own `plot-approach` anchor, 26 m out — and it is the right
  // owner for it. But a route is only as good as the ground it resolves onto: if that waypoint
  // fails to validate, the route silently drops it, every live loop stays 180+ m away, and NOTHING
  // the player builds can ever be heard by anyone. That is not a difficulty setting, it is the
  // game not having a consequence system. So Campers measures the roster's actual closest approach
  // and, when nothing is coming, walks one person out to the site itself. It is a fallback: the
  // instant a real route delivers the proximity, the vigil stands down and never fires.
  plotWatchPeriod: 110.0,       // §9.5's cadence, and the ceiling on how often this may happen
  plotWatchEarshot: 60.0,       // m — somebody is already close enough; do nothing
  plotWatchRouteRange: 70.0,    // m — a walked route already comes this close; do nothing
  plotWatchStandoff: 30.0,      // m — where the vigil stops. Navmesh's keep-out is 16 m (§9.6).
  plotWatchHold: 11.0,          // s standing at the turn, torch on the frame
  // 300 s of walking, which is a lot, and it is measured rather than guessed: the camp resolves
  // ~300 m from the plot at runtime, and 300 m at 1.2 m/s is 250 s. GAME_DESIGN §3.3 puts the
  // camp buildings 142–176 m out, so this budget is roughly twice what the design intends and
  // should be halved the day the site layout matches the document.
  plotWatchTimeout: 300.0,      // s — a vigil never eats a whole night
  plotWatchMinNight: 2,         // §12.2: Night 1's single camper is theatre and must stay theatre

  // --- group behaviour
  shareRadius: 7.0,
  shareCooldown: 6.0,
  pairOffset: 5.5,
  braveThreshold: 0.45,         // below this a camper fetches somebody instead of going alone

  // --- voice, deliberately starved. Long silences are correct.
  voCampGap: 12.0,
  voAgentGap: 30.0,
  voIdleGap: 52.0,

  // --- torch, ART §3.2 / §8.7
  torchColor: 0xffe6bb,
  torchIntensity: 34,
  torchAngle: 0.30,
  torchWideAngle: 0.40,         // §9.1: bev's torch is "yes, wide"
  torchPenumbra: 0.30,
  torchDistance: 18,
  sweepCalmDeg: 34,
  sweepCalmHz: 0.11,
  sweepSearchDeg: 46,
  sweepSearchHz: 0.38,
  sweepJitterDeg: 2,
  torchStopTime: 1.4,           // §8.7 — the sweep stops within 1.4 s. The whole detection language.
  torchHoldTime: 2.1,
  // Slew ceilings, rad/s. These are the numbers the player actually learns: a calm beam CANNOT
  // move faster than sweepCalmRate, so if it does, it is looking for you. The peak speed a ±34°
  // 0.11 Hz sweep demands is 0.593*2π*0.11 = 0.41 rad/s, so 0.90 tracks it with headroom and
  // still sits 4x below the search ceiling. Do not close that gap; the gap IS the tell.
  sweepCalmRate: 0.90,
  sweepSearchRate: 3.60,
  torchTurnDeg: 16,             // §8.7 — after the hold, it rotates onto the thing at 16°/s
  headFollowRate: 2.40,         // the head follows the beam. People look where they point a torch.

  // --- render
  cullDistance: 190,
  animFullDistance: 55,
  animCoarseDistance: 120,
};

/** GAME_DESIGN §9.1, the archetype table. `archetype` drives senses and nothing else. */
export const ARCHETYPES = {
  counselor:        { R: 24, fovDeg: 110, torch: true,  wide: false, hearing: 0.11 },
  kid:              { R: 16, fovDeg: 100, torch: false, wide: false, hearing: 0.18 },
  'head counselor': { R: 28, fovDeg: 115, torch: true,  wide: true,  hearing: 0.09 },
  ranger:           { R: 34, fovDeg: 120, torch: true,  wide: true,  hearing: 0.08 },
};

/**
 * Per-camper facts this file owns: the §9.1 overrides, and the ART §8.2/§8.4 silhouette axes
 * mapped onto the canonical STORY roster. No two campers share more than one axis value.
 */
const IDENTITY = {
  robin: {
    archetype: 'counselor', hearing: 0.08, essentialUntil: 7,
    height: 1.71, build: 0.86, head: 'pony', limbs: 'pockets',
    garment: 0xc4643a, skin: 0x8a6a52, hair: 0x1a1512, pants: 0x2e3a44,
    coat: 0x232b33, capCol: 0x232b33, legs: 'pants', sock: 0x2e3a44,
    stepHz: 1.31, armSwingDeg: 16, bob: 0.030, stopsOften: true,
  },
  dale: {
    archetype: 'counselor', hearing: 0.11, essentialUntil: 4,
    height: 1.75, build: 1.16, head: 'cap', limbs: 'down',
    garment: 0x9c5433, skin: 0x6b5148, hair: 0x3a2a1e, pants: 0x39332b,
    coat: 0x2b2b26, capCol: 0x353a30, legs: 'pants', sock: 0x39332b,
    stepHz: 1.05, armSwingDeg: 15, bob: 0.028, stopsOften: false,
  },
  marg: {
    archetype: 'counselor', hearing: 0.11, essentialUntil: 4,
    height: 1.72, build: 1.04, head: 'capback', limbs: 'wide',
    garment: 0xb8552f, skin: 0x8a6a52, hair: 0x5a4430, pants: 0x2b3c46,
    coat: 0x21303a, capCol: 0x2b3c46, legs: 'shorts', sock: 0x8a6a52,
    stepHz: 1.62, armSwingDeg: 22, bob: 0.034, stopsOften: false,
  },
  coop: {
    archetype: 'counselor', hearing: 0.13, essentialUntil: 4,
    height: 1.68, build: 1.22, head: 'volume', limbs: 'balance',
    garment: 0xc9704a, skin: 0x6b5148, hair: 0x1a1512, pants: 0x4a4436,
    coat: 0x3a352a, capCol: 0x3a352a, legs: 'shorts', sock: 0x6b5148,
    stepHz: 1.55, armSwingDeg: 19, bob: 0.044, stopsOften: false,
  },
  teddy: {
    archetype: 'kid', hearing: 0.18, essentialUntil: 4,
    height: 1.55, build: 0.80, head: 'bun', limbs: 'across',
    garment: 0xc4643a, skin: 0x4a3830, hair: 0x1a1512, pants: 0x39424a,
    coat: 0x2a333a, capCol: 0x2a333a, legs: 'shorts', sock: 0xc4643a,
    stepHz: 1.74, armSwingDeg: 17, bob: 0.026, stopsOften: true,
  },
  bev: {
    archetype: 'head counselor', hearing: 0.09, essentialUntil: 6,
    height: 1.64, build: 1.34, head: 'hood', limbs: 'torchhigh',
    garment: 0xa85333, skin: 0x8a6a52, hair: 0x7a6448, pants: 0x2f3330,
    coat: 0x262a27, capCol: 0x262a27, legs: 'pants', sock: 0x2f3330,
    stepHz: 1.18, armSwingDeg: 14, bob: 0.024, stopsOften: true,
  },
  ranger: {
    archetype: 'ranger', hearing: 0.08, essentialUntil: 0,
    height: 1.80, build: 1.20, head: 'cap', limbs: 'down',
    garment: 0x7a5a34, skin: 0x6b5148, hair: 0x3a2a1e, pants: 0x2a3028,
    coat: 0x232720, capCol: 0x2a3028, legs: 'pants', sock: 0x2a3028,
    stepHz: 1.22, armSwingDeg: 15, bob: 0.030, stopsOften: false,
  },
};

/**
 * Who is actually on the map, per night. This reconciles §9.1's "present nights" column with
 * §2.1's per-night camper COUNT, which the two tables state separately and which must agree:
 * 1, 3, 4, 5, 5, 2, 1. Night 6's density dip is the design (§2.1) — emptiness is the horror —
 * so nothing may raise it.
 */
const NIGHT_ROSTER = {
  1: ['dale'],
  2: ['dale', 'robin', 'marg'],
  3: ['dale', 'robin', 'marg', 'bev'],
  4: ['dale', 'robin', 'marg', 'coop', 'bev'],
  5: ['robin', 'marg', 'coop', 'teddy', 'bev'],
  6: ['robin', 'bev'],
  7: ['robin'],
};

/** Used only if src/story/Script.js cannot be loaded. Degrade, never crash. */
const ROSTER_FALLBACK = [
  { id: 'robin', name: 'Robin Osei-Hall', archetype: 'counselor', walkSpeed: 1.25, curiosity: 0.95, bravery: 0.72, hasTorch: true, torchTint: '#f2e3c4' },
  { id: 'dale', name: 'Dale Pruitt', archetype: 'counselor', walkSpeed: 1.10, curiosity: 0.35, bravery: 0.60, hasTorch: true, torchTint: '#ffc98a' },
  { id: 'marg', name: 'Marguerite Toth', archetype: 'counselor', walkSpeed: 1.35, curiosity: 0.60, bravery: 0.80, hasTorch: true, torchTint: '#eaf0ff' },
  { id: 'coop', name: 'Cooper Vance', archetype: 'counselor', walkSpeed: 1.30, curiosity: 0.45, bravery: 0.40, hasTorch: true, torchTint: '#ffe9b0' },
  { id: 'teddy', name: 'Teddy Nakagawa', archetype: 'kid', walkSpeed: 1.15, curiosity: 0.70, bravery: 0.12, hasTorch: false, torchTint: '#d8e4ea' },
  { id: 'bev', name: 'Beverly Ranczak', archetype: 'head counselor', walkSpeed: 1.05, curiosity: 0.50, bravery: 0.85, hasTorch: true, torchTint: '#ffd08a' },
  { id: 'ranger', name: 'County Ranger', archetype: 'ranger', walkSpeed: 1.20, curiosity: 0.55, bravery: 0.90, hasTorch: true, torchTint: '#fff0d0' },
];

/** Noise kinds the AI must ignore outright (§9.8). Thunder is masking; voice is other campers. */
const IGNORED_NOISE = { thunder: 1, voice: 1, whistle: 1 };

/** §9.7 — the state → alert scalar the rest of the game reads. */
const STATE_ALERT = {
  Idle: 0.00, Scripted: 0.00, Noticing: 0.15, Curious: 0.35,
  Searching: 0.60, Reporting: 0.80, Alerted: 0.85, Panic: 1.00,
};

// =================================================================================================
// Scratch. Module scope, per ARCHITECTURE §12 — nothing in update() allocates.
// =================================================================================================

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _mRoot = new THREE.Matrix4();
const _mA = new THREE.Matrix4();
const _mB = new THREE.Matrix4();
const _mC = new THREE.Matrix4();
const _mD = new THREE.Matrix4();
const _mSeg = new THREE.Matrix4();
const _mLocal = new THREE.Matrix4();
const _eul = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _col = new THREE.Color();
const _noiseOut = {
  event: null, heard: 0, seq: -1, errorRadius: 0, distance: 0,
  point: new THREE.Vector3(), kind: '',
};
const _routeScratch = [];
const _coverScratch = [];
const _pathScratch = [];
const _DEG = Math.PI / 180;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};
/** Shortest signed difference between two angles, radians. */
function angDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function approachAngle(current, target, maxStep) {
  const d = angDelta(current, target);
  if (Math.abs(d) <= maxStep) return target;
  return current + Math.sign(d) * maxStep;
}
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
/**
 * Routes are ranked by how close they bring their walker to the build site, nearest first, so the
 * loop that creates tension is the one that gets a body on it. Hoisted to module scope because
 * `_assignRoutes` sorts with it and a comparator literal inside an update path is an allocation.
 */
function byPlotApproach(a, b) {
  const x = isNum(a?.nearestPlotApproach) ? a.nearestPlotApproach : 1e9;
  const y = isNum(b?.nearestPlotApproach) ? b.nearestPlotApproach : 1e9;
  return x - y;
}

// =================================================================================================
// CamperAgent — one person. Everything mutable about them lives here; nothing here allocates
// after construction.
// =================================================================================================

export class CamperAgent {
  constructor(id, def, ident, rand, index) {
    this.id = id;
    this.index = index;
    this.displayName = def?.name ?? id;
    this.archetype = ident.archetype;

    const A = ARCHETYPES[this.archetype] ?? ARCHETYPES.counselor;
    this.R = A.R;
    this.fovDeg = A.fovDeg;
    this.halfFov = (A.fovDeg * 0.5) * _DEG;
    this.hearingThreshold = ident.hearing ?? A.hearing;
    this.hasTorch = def?.hasTorch !== undefined ? !!def.hasTorch : A.torch;
    this.wideTorch = !!A.wide;
    this.essentialUntilNight = ident.essentialUntil ?? 0;

    // Personality. These are the branch conditions, not decoration.
    this.bravery = isNum(def?.bravery) ? def.bravery : 0.5;
    this.curiosity = isNum(def?.curiosity) ? def.curiosity : 0.5;
    this.walkSpeed = isNum(def?.walkSpeed) ? def.walkSpeed : CAMPER_TUNING.idleSpeed;

    // Silhouette (ART §8.2–§8.4)
    this.height = ident.height;
    this.build = ident.build;
    this.headStyle = ident.head;
    this.limbStyle = ident.limbs;
    this.stepHz = ident.stepHz;
    this.armSwing = ident.armSwingDeg * _DEG;
    this.bobAmp = ident.bob;
    this.stopsOften = !!ident.stopsOften;
    this.garmentColor = ident.garment;
    this.skinColor = ident.skin;
    this.hairColor = ident.hair;
    this.pantsColor = ident.pants;
    this.coatColor = ident.coat ?? ident.pants;
    this.capColor = ident.capCol ?? ident.coat ?? ident.pants;
    this.sockColor = ident.sock ?? ident.skin;
    this.legStyle = ident.legs === 'shorts' ? 'shorts' : 'pants';
    this.torchTint = def?.torchTint ?? '#ffe6bb';
    /** Assigned by _applyPalette once the roster exists. -1 until then. */
    this.visualSlot = -1;

    // Transform
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;                 // body facing
    this.headYaw = 0;             // where the EYES point — this is what the cone test uses
    this.headPitch = 0;
    this.speed = 0;
    this.eyeHeight = this.height * 0.94;
    this.groundType = 'duff';

    // FSM
    this.state = 'Idle';
    this.stateT = 0;
    this.prevState = 'Idle';
    this.alive = true;
    this.spawned = false;
    this.scripted = null;

    // Detection
    this.detection = 0;
    this.detectionPeak = 0;
    this.peakAt = -1e3;
    this.graceT = 0;
    this.rate = 0;
    this.seesPlayer = false;
    this.occlF = 0;
    this.occlAt = -1e3;
    this.skyline = 0;
    this.skylineAt = -1e3;
    this.distanceToPlayer = Infinity;
    this.fovSens = 0;
    this.flashExposeUntil = -1e3;
    this.spottedFired = false;
    /** Level last published on `player:spotted`. -1 = nothing published. See `_emitSpotted`. */
    this.spottedLevel = -1;
    this.reportedThisNight = false;

    // Hearing / knowledge
    this.lastNoisePos = new THREE.Vector3();
    this.lastNoiseAt = -1e3;
    this.lastNoiseHeard = 0;
    this.hasNoise = false;
    this.lastSeq = -1;
    this.hitTimes = [-1e3, -1e3];
    this.hitCount = 0;
    this.investigations = 0;
    this.shareAt = -1e3;
    this.buddy = null;

    // Search plan
    this.searchStage = 0;         // 0 travel, 1 look around, 2 cover points, 3 widen, 4 shrug
    this.searchPoints = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this.searchCount = 0;
    this.searchIdx = 0;
    this.searchDwell = 0;
    this.shrugT = 0;

    // Structure notice (§9.5)
    this.notice = Object.create(null);
    this.familiarity = Object.create(null);
    this.noticingFeature = null;

    // Path following
    this.path = [];
    for (let i = 0; i < 24; i++) this.path.push(new THREE.Vector3());
    this.pathLen = 0;
    this.pathIdx = 0;
    this.pathAt = -1e3;
    this.goal = new THREE.Vector3();
    this.hasGoal = false;
    this.route = null;
    this.routeLeg = 0;
    this.dwell = 0;

    // Plot vigil (see CAMPER_TUNING.plotWatch*). Still `Idle` — this IS patrolling, so senses,
    // hearing and the FSM all behave exactly as they do on a route.
    this.vigil = new THREE.Vector3();
    this.vigilActive = false;
    this.vigilHold = 0;
    this.vigilT = 0;

    // Report
    this.report = null;           // { kind:'short'|'long', t, target, met, pos }
    this.interceptT = 0;

    // Panic
    this.stumbleT = 0;
    this.proneT = 0;

    // Torch
    this.torchYaw = 0;
    this.torchPitch = -0.16;
    this.torchPhase = rand.range(0, Math.PI * 2);
    this.torchHold = 0;
    this.torchStopT = 0;
    this.torchTargetYaw = 0;
    this.torchAimed = false;
    this.lightSlot = -1;
    /** Sweep anchor. Frozen while Searching so the arc does not chase its own head. */
    this.torchAnchorYaw = 0;
    /** Signed rad/s of the beam this frame — the number `readable` means. Public, for debug. */
    this.torchRate = 0;
    this._torchPrevYaw = 0;

    // Animation
    this.animPhase = rand.range(0, 1);
    this.animBob = 0;
    this.animLean = 0;
    this.crouchT = 0;
    this.idleShiftT = rand.range(0, 6);
    this.idleShift = 0;
    this.idleShiftFrom = 0;
    this.idleShiftTo = 0;
    this.idleShiftBlend = 1;      // 0..1 across the 1.1 s transfer (ART §8.7)
    this.breathT = rand.range(0, 3.1);
    this.breath = 0;
    this.cadence = 0;             // gait cycles per second, published for the animator + debug
    this.gazeT = 0;
    this.gazeYaw = 0;
    this.visible = false;
    this.lod = 0;

    // Voice
    this.voAt = -1e3;

    this.rand = rand;
    this.colliderId = -1;
  }

  /** 0..1 — how loud this person's current behaviour is, for `alertLevel`. */
  get alert() { return STATE_ALERT[this.state] ?? 0; }

  get eyePosition() {
    return _v4.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  /** Where the torch is held. Bev holds it high (ART §8.3); everyone else at the hip. */
  handPosition(out) {
    const h = this.limbStyle === 'torchhigh' ? this.height * 0.86 : this.height * 0.62;
    const side = this.limbStyle === 'torchhigh' ? 0.10 : 0.26;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    return out.set(
      this.position.x + c * side * this.build,
      this.position.y + h,
      this.position.z - s * side * this.build,
    );
  }

  setState(next, now) {
    if (this.state === next) return;
    this.prevState = this.state;
    this.state = next;
    this.stateT = 0;
    if (next === 'Searching') this.searchStage = 0;
    if (next === 'Idle') { this.searchCount = 0; this.searchIdx = 0; }
    this.torchAimed = (next === 'Curious' || next === 'Noticing' || next === 'Searching');
    if (this.torchAimed) this.torchStopT = 0;
    if (now !== undefined) this.stateEnteredAt = now;
  }

  resetForNight() {
    this.detection = 0; this.detectionPeak = 0; this.peakAt = -1e3; this.graceT = 0;
    this.rate = 0; this.seesPlayer = false; this.spottedFired = false;
    this.spottedLevel = -1;
    this.reportedThisNight = false; this.report = null; this.interceptT = 0;
    this.hasNoise = false; this.lastSeq = -1; this.hitCount = 0; this.investigations = 0;
    this.hitTimes[0] = -1e3; this.hitTimes[1] = -1e3;
    this.state = 'Idle'; this.stateT = 0; this.scripted = null;
    this.route = null; this.pathLen = 0; this.pathIdx = 0; this.hasGoal = false;
    this.stumbleT = 0; this.proneT = 0; this.buddy = null;
    this.vigilActive = false; this.vigilHold = 0; this.vigilT = 0;
    this.notice = Object.create(null);
    this.noticingFeature = null;
  }
}

// =================================================================================================
// THE SYSTEM
// =================================================================================================

export class Campers {
  constructor(ctx) {
    this.ctx = ctx ?? null;
    this.bus = ctx?.bus ?? null;

    /** @type {CamperAgent[]} live roster for the current night. Public, read-only. */
    this.agents = [];
    /** @type {Map<string, CamperAgent>} every constructed agent, including off-duty ones. */
    this.roster = new Map();

    // ---- the public scalars ------------------------------------------------------------------
    this.suspicion = 0;
    this.nearestDistance = Infinity;
    this.anySeeingPlayer = false;
    this.alertLevel = 0;
    this.detection = 0;
    this.hot = null;

    // ---- escalation --------------------------------------------------------------------------
    this.rung = 0;
    this.reportsTotal = 0;
    this.noiseInvestigations = 0;
    this.patrolDensity = 2;
    this.campLightsOn = false;
    this.kidsRecalled = false;
    this.structureReported = false;
    this.nightMinDensity = 1;
    this.nightMaxDensity = 5;

    // ---- bodies (§13.5) ----------------------------------------------------------------------
    this.bodies = [];
    this._bodyTimer = 0;

    // ---- systems (resolved in init, re-resolved lazily) --------------------------------------
    this._player = null; this._physics = null; this._navmesh = null; this._noise = null;
    this._terrain = null; this._props = null; this._lamp = null; this._hud = null;
    this._voice = null; this._audio = null; this._weather = null; this._sky = null;
    this._cabin = null; this._build = null; this._manual = null;
    this._resolveRetry = 0;

    // ---- published illumination breakdown (§9.3 `lum`), so a balance pass can see the terms ----
    this.lum = 0.06;
    this.lumParts = { moon: 0.06, lantern: 0, manual: 0, camp: 0, sky: 0 };

    // ---- scheduling --------------------------------------------------------------------------
    this._t = 0;
    this._coldCursor = 0;
    this._hearCursor = 0;
    this._lumAt = -1e3;
    this._lum = 0.06;
    this._routeAt = -1e3;
    this._plotWatchAt = -1e3;
    this._plotWatchLast = -1e3;
    /** Diagnostic, public: the roster's closest approach to the plot, and the best live route's. */
    this.nearestToPlot = Infinity;
    this.nearestRouteToPlot = Infinity;
    this._shareAt = -1e3;
    this._pairAt = -1e3;
    this._flashPrev = 0;
    /** §12.2 — 1.0 on every night except the tutorial. Refreshed once per update(), never per agent. */
    this._detectionCeil = 1.0;
    this._tutorialSafe = false;
    this._voCampAt = -1e3;
    this._spottedActive = false;
    this._routeTaken = new Map();

    // ---- render ------------------------------------------------------------------------------
    this.group = null;
    this._meshes = null;          // { key: InstancedMesh }
    this._geoms = [];
    this._mats = [];
    this._lightSlots = [];
    this._maxAgents = 8;
    this._maxLights = 3;

    this._rand = new Rand(((ctx?.settings?.get?.('seed') ?? 0x51a5cab) ^ 0x5a3d17) >>> 0);
    this._unsub = [];
    this._disposed = false;
    this.ready = false;

    this.stats = { updateMs: 0, rays: 0, agents: 0, hearPolls: 0, losCalls: 0 };
  }

  // ===============================================================================================
  // INIT
  // ===============================================================================================

  async init() {
    if (this._disposed) return;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);

    this._script = null;
    try {
      const m = await import('../story/Script.js');
      this._script = m?.Script ?? m?.default ?? null;
    } catch (e) {
      Log.once('campers:script', 'Campers: Script.js unavailable — using the built-in roster.', e?.message ?? e);
    }

    this._resolveSystems();
    this._restoreState();

    try { this._buildBodies(); } catch (e) {
      Log.error('Campers: body build failed — the AI still runs, invisibly.', e);
    }
    try { this._buildLights(); } catch (e) {
      Log.error('Campers: torch build failed — the AI still runs, unlit.', e);
    }

    this._buildRoster();

    // ORDER IS LOAD-BEARING. _applyPalette() walks `roster` to hand every camper a visual slot,
    // so it MUST run after _buildRoster(). It used to be called from the tail of _buildBodies(),
    // which runs first — so it walked an empty Map, every agent kept `visualSlot === -1`, and
    // _updateVisual() skipped all of them. The entire cast was invisible for the whole game.
    // If this ever throws, the campers go invisible again, so it is logged loud, never swallowed.
    try { this._applyPalette(); } catch (e) {
      Log.error('Campers: palette/slot assignment failed — the cast will be INVISIBLE.', e);
      Log.error('Campers palette stack:', e?.stack ?? '(no stack)');
    }
    let slotted = 0;
    for (const a of this.roster.values()) if (a.visualSlot >= 0) slotted++;
    if (this._meshes && slotted === 0) {
      Log.error(`Campers: ${this.roster.size} in the cast and ZERO visual slots assigned.`);
    }

    this.spawnRoster(this.ctx?.state?.night ?? 1);
    this._bindEvents();

    this.ready = true;
    const ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    Log.debug(`Campers: ${this.agents.length} on the map for night ${this.ctx?.state?.night ?? 1}`
      + ` (${this.roster.size} in the cast), ${this._maxLights} torch slots, ${ms.toFixed(1)} ms`);
  }

  _resolveSystems() {
    const s = this.ctx?.systems;
    if (!s?.get) return;
    this._player = s.get('Player') ?? null;
    this._physics = s.get('Physics') ?? null;
    this._navmesh = s.get('Navmesh') ?? null;
    this._noise = s.get('NoiseSystem') ?? null;
    this._terrain = s.get('Terrain') ?? null;
    this._props = s.get('Props') ?? null;
    this._lamp = s.get('Flashlight') ?? null;
    this._hud = s.get('HUD') ?? null;
    this._voice = s.get('VoiceBank') ?? null;
    // main.js registers the audio graph as 'Audio'; ARCHITECTURE §9 names the file AudioEngine.js.
    // Ask for both rather than silently holding null forever.
    this._audio = s.get('AudioEngine') ?? s.get('Audio') ?? null;
    // The open manual is a light source pointed at the player's own face (ART §13.8). It is a
    // `lum` contributor exactly like the lantern, and it is the whole point of §9.4.
    this._manual = s.get('BlueprintUI') ?? null;
    this._weather = s.get('Weather') ?? null;
    this._sky = s.get('Sky') ?? null;
    this._cabin = s.get('CabinSite') ?? null;
    this._build = s.get('BuildSystem') ?? null;
  }

  /** Suspicion, familiarity and report count survive the night boundary (§9.5, §13.1). */
  _restoreState() {
    const st = this.ctx?.state;
    if (!st) return;
    this.suspicion = clamp01(st.suspicion ?? 0);
    if (!st.stats) st.stats = {};
    if (!isNum(st.stats.reportsTotal)) st.stats.reportsTotal = 0;
    this.reportsTotal = st.stats.reportsTotal;
    if (!st.structureKnowledge) {
      st.structureKnowledge = { seenBy: [], enteredBy: [], reportedAs: null, featuresKnown: {} };
    }
    if (!st.camperFamiliarity) st.camperFamiliarity = {};
  }

  _buildRoster() {
    const defs = (Array.isArray(this._script?.campers) && this._script.campers.length)
      ? this._script.campers : ROSTER_FALLBACK;
    let i = 0;
    for (const def of defs) {
      const id = String(def?.id ?? '').toLowerCase();
      if (!id || !IDENTITY[id]) continue;
      const r = new Rand(((this.ctx?.settings?.get?.('seed') ?? 0x51a5cab) ^ (0x9e37 + i * 2654435761)) >>> 0);
      const a = new CamperAgent(id, def, IDENTITY[id], r, i);
      const fam = this.ctx?.state?.camperFamiliarity?.[id];
      if (fam) for (const k of Object.keys(fam)) a.familiarity[k] = clamp01(fam[k]);
      this.roster.set(id, a);
      i++;
    }
    // The Ranger is not in Script.campers; he is conditional (§9.1 note 2) and lives here.
    if (!this.roster.has('ranger')) {
      const def = ROSTER_FALLBACK[ROSTER_FALLBACK.length - 1];
      const r = new Rand(((this.ctx?.settings?.get?.('seed') ?? 0x51a5cab) ^ 0x2b17ac) >>> 0);
      this.roster.set('ranger', new CamperAgent('ranger', def, IDENTITY.ranger, r, i));
    }
  }

  // ===============================================================================================
  // ROSTER / SPAWN
  // ===============================================================================================

  /**
   * Rebuild `agents` for a night. Called automatically on `night:begin`; safe to call directly.
   * @param {number} night 1..7
   */
  spawnRoster(night) {
    const n = clamp(Math.round(night || 1), 1, 7);
    const wanted = NIGHT_ROSTER[n] ?? NIGHT_ROSTER[1];
    this.agents.length = 0;

    for (const id of wanted) {
      const a = this.roster.get(id);
      if (!a) continue;
      if (a.essentialUntilNight === 0 && !a.alive) continue;
      if (!a.alive) continue;                      // dead is dead; §13.5 bodies persist
      a.resetForNight();
      a.spawned = true;
      this._placeAtSpawn(a, n);
      this.agents.push(a);
    }

    // §13.1 rung 5 / §9.1 note 2 — ONE rule, not two.
    if (n >= 6 && this.reportsTotal >= 2) {
      const r = this.roster.get('ranger');
      if (r && r.alive && this.agents.indexOf(r) < 0) {
        r.resetForNight(); r.spawned = true;
        this._placeAtSpawn(r, n);
        this.agents.push(r);
      }
    }

    // §13.1: density is clamped to the night's band so the ladder cannot raise Night 6 off 2.
    this.nightMinDensity = Math.max(1, this.agents.length - 1);
    this.nightMaxDensity = this.agents.length;
    this._recomputeDensity();

    for (const a of this.roster.values()) if (this.agents.indexOf(a) < 0) a.spawned = false;
    this._routeTaken.clear();
    this._routeAt = -1e3;
    this.stats.agents = this.agents.length;
  }

  _placeAtSpawn(a, night) {
    const nav = this._navmesh;
    const anchors = ['camp', 'firepit', 'cabins', 'mess', 'dock', 'woodpile', 'office'];
    let p = null;

    // Start people ON their own loop rather than stacked around the fire. A roster that begins in
    // one huddle spends the first minutes of every night walking out of it, and those are minutes
    // in which nothing can happen to the player. Night 1 is exempt: §12.2 puts `dale` alone and
    // far away on purpose, and that theatre is load-bearing for the tutorial.
    if (night >= CAMPER_TUNING.plotWatchMinNight && Array.isArray(nav?.patrolRoutes)) {
      const routes = nav.patrolRoutes;
      for (let i = 0; i < routes.length; i++) {
        const r = routes[i];
        if (!r || r.enabled === false || !r.points?.length) continue;
        if (night < (r.minNight ?? 1) || night > (r.maxNight ?? 7)) continue;
        if (!Array.isArray(r.preferred) || r.preferred.indexOf(a.id) < 0) continue;
        p = r.points[(a.index + night) % r.points.length];
        break;
      }
    }

    if (!p && nav?.anchor) {
      // Deterministic per (id, night) so a reloaded night looks the same (§18.5).
      const pick = anchors[(a.index * 3 + night * 5) % anchors.length];
      p = nav.anchor(pick) ?? nav.anchor('camp');
    }
    if (!p) p = this._terrain?.campCenter ?? null;
    if (!p) { a.position.set(0, 0, 0); return; }
    const ang = a.rand.range(0, Math.PI * 2);
    const rad = a.rand.range(2, 11);
    const x = p.x + Math.cos(ang) * rad;
    const z = p.z + Math.sin(ang) * rad;
    a.position.set(x, this._groundAt(x, z), z);
    a.yaw = a.rand.range(0, Math.PI * 2);
    a.headYaw = a.yaw;
    a.torchYaw = a.yaw;
  }

  _groundAt(x, z) {
    const t = this._terrain;
    if (t?.heightAt) { const h = t.heightAt(x, z); if (isNum(h)) return h; }
    const p = this._physics;
    if (p?.heightAt) { const h = p.heightAt(x, z); if (isNum(h)) return h; }
    return 0;
  }

  /** @returns {CamperAgent|null} */
  agent(id) { return this.roster.get(String(id ?? '').toLowerCase()) ?? null; }

  // ===============================================================================================
  // EVENTS
  // ===============================================================================================

  _bindEvents() {
    const bus = this.bus;
    if (!bus?.on) return;
    const on = (evt, fn) => { const u = bus.on(evt, fn); if (u) this._unsub.push(u); };

    on('night:begin', (p) => {
      this._restoreState();
      this.noiseInvestigations = 0;
      this.campLightsOn = false;
      this.kidsRecalled = false;
      this.structureReported = false;
      this._spottedActive = false;
      this.rung = this.suspicion >= 0.45 ? 3 : 0;
      this.spawnRoster(p?.night ?? this.ctx?.state?.night ?? 1);
    });

    on('night:complete', () => this._persistState());
    on('night:failed', () => this._persistState());

    // The cabin rewrites the world (§9.6). Navmesh owns the graph edit; we only care that our
    // cached paths are now lies.
    on('build:place', () => this._invalidatePaths());
    on('build:remove', () => this._invalidatePaths());

    on('game:pause', () => { this._paused = true; });
    on('game:resume', () => { this._paused = false; this._flashPrev = 0; });
  }

  _invalidatePaths() {
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      a.pathLen = 0; a.pathIdx = 0; a.pathAt = -1e3;
    }
  }

  _persistState() {
    const st = this.ctx?.state;
    if (!st) return;
    st.suspicion = clamp01(this.suspicion);
    if (!st.stats) st.stats = {};
    st.stats.reportsTotal = this.reportsTotal;
    if (!st.camperFamiliarity) st.camperFamiliarity = {};
    for (const a of this.roster.values()) {
      const keys = Object.keys(a.familiarity);
      if (!keys.length) continue;
      const rec = st.camperFamiliarity[a.id] ?? (st.camperFamiliarity[a.id] = {});
      for (const k of keys) rec[k] = a.familiarity[k];
    }
  }

  // ===============================================================================================
  // FRAME
  // ===============================================================================================

  update(dt, elapsed) {
    if (this._disposed || !this.ready) return;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    const d = clamp(dt || 0, 0, 0.1);
    this._t += d;
    const now = this._t;

    // §12.2's theatre guarantee, read once a frame rather than once per agent per sense.
    this._tutorialSafe = this.ctx?.state?.tutorialSafe === true;
    this._detectionCeil = this._tutorialSafe ? CAMPER_TUNING.tutorialDetectionCeil : 1.0;

    if (--this._resolveRetry <= 0) { this._resolveRetry = 90; this._resolveSystems(); }

    const player = this._player;
    const ppos = player?.position ?? this.ctx?.camera?.position ?? null;

    this._updateIllumination(now, ppos);
    this._updateFlash(now, ppos);
    if (now - this._routeAt > 1.0) { this._routeAt = now; this._assignRoutes(); }
    this._tickPlotWatch(now);
    if (now - this._pairAt > 4.0) { this._pairAt = now; this._pairUp(); }

    // --- senses -------------------------------------------------------------------------------
    this._pickHot(ppos);
    this._sampleOcclusion(now, ppos);
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.alive) continue;
      this._senseVision(a, d, now, ppos);
    }
    this._hear(d, now);
    this._senseStructure(d, now);

    // --- brains and bodies --------------------------------------------------------------------
    let nearest = Infinity, alert = 0, det = 0, seeing = false;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.alive) continue;
      a.stateT += d;
      if (a.scripted) this._tickScripted(a, d, now);
      else this._tickFSM(a, d, now, ppos);
      this._steer(a, d, now);
      this._tickTorch(a, d, now);
      if (a.distanceToPlayer < nearest) nearest = a.distanceToPlayer;
      if (a.alert > alert) alert = a.alert;
      if (a.detection > det) det = a.detection;
      if (a.rate > 0) seeing = true;
    }

    this.nearestDistance = nearest;
    this.alertLevel = alert;
    this.detection = det;
    this.anySeeingPlayer = seeing;

    this._shareKnowledge(now);
    this._tickBodies(d, now);
    this._publishDetection();
    this._updateVisual(d, now);

    this.stats.updateMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  }

  resize(_w, _h) { /* nothing resolution-dependent lives here */ }

  // ===============================================================================================
  // LIGHT ON THE PLAYER — `lum` in §9.3, sampled once for the whole camp at 10 Hz
  // ===============================================================================================

  _updateIllumination(now, ppos) {
    if (now - this._lumAt < 1 / CAMPER_TUNING.lumHz) return;
    this._lumAt = now;
    const parts = this.lumParts;
    if (!ppos) { this._lum = 0.06; this.lum = 0.06; return; }

    // Moonlight. §9.3's "unlit" baseline is 0.06 and that is the moon at full sky.
    let lum = 0.06;
    const sky = this._sky;
    if (sky) {
      const occ = isNum(sky.moonOcclusion) ? clamp01(sky.moonOcclusion) : 0;
      const cloud = isNum(sky.cloudCover) ? clamp01(sky.cloudCover) : 0;
      lum = 0.018 + 0.052 * (1 - Math.max(occ, cloud * 0.8));
    }
    // Terrain exposure — under the canopy it is genuinely darker than in the open.
    const t = this._terrain;
    if (t?.exposureAt) {
      const e = t.exposureAt(ppos.x, ppos.z);
      if (isNum(e)) lum *= lerp(0.55, 1.15, clamp01(e));
    }

    parts.moon = lum;

    // The player's own lamp. §11.2 / §9.4: 0.55 open, 0.22 hooded.
    const lamp = this._lamp;
    let lampC = 0;
    if (lamp && (lamp.lit ?? lamp.on)) {
      lampC = isNum(lamp.illumination) ? lamp.illumination
        : (lamp.hooded ? 0.22 : 0.55);
      lum += lampC;
    }
    parts.lantern = lampC;

    // THE OPEN MANUAL (ART §13.8, GAME_DESIGN §9.3). A bone-white sheet held 40 cm from the face
    // with the lantern on it is a second bounce aimed at the one part of the player a camper can
    // recognise. BlueprintUI mounts a real SpotLight for it and publishes the same number as
    // `lumBonus` (0.26 at full open, its own derivation). Without this line, reading the
    // instructions in the middle of their camp cost NOTHING in stealth terms, and the joke the
    // whole game is built on — the manual is the antagonist — had no mechanical teeth.
    // Null-checked because BlueprintUI is a UI system and may not be registered at all.
    const manual = this._manual;
    let manC = 0;
    if (manual) {
      const b = manual.lumBonus;
      if (isNum(b) && b > 0) manC = clamp01(b);
    }
    lum += manC;
    parts.manual = manC;

    // Camp lights. Props publishes them; a point light 6 m away is a very different night.
    const lights = this._props?.lights;
    if (Array.isArray(lights)) {
      for (let i = 0; i < lights.length; i++) {
        const l = lights[i];
        if (!l || l.visible === false || !(l.intensity > 0)) continue;
        const lp = l.position;
        if (!lp) continue;
        const dx = lp.x - ppos.x, dy = (lp.y - ppos.y), dz = lp.z - ppos.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const range = l.distance > 0 ? l.distance : 18;
        if (d2 > range * range) continue;
        const f = 1 - Math.sqrt(d2) / range;
        lum += clamp01(l.intensity / 26) * f * f * 0.7;
      }
    }

    // Rung 3: the mess hall comes on. A flat floor inside the camp, per §13.1.
    if (this.campLightsOn) {
      const camp = this._terrain?.campCenter ?? this._navmesh?.anchor?.('camp');
      if (camp) {
        const dc = Math.hypot(camp.x - ppos.x, camp.z - ppos.z);
        if (dc < 70) lum += 0.15 * (1 - dc / 70);
      }
    }

    // Lightning. The flash itself is handled as exposeF; this is the residual glow.
    const w = this._weather;
    if (w && w.lightning > 0) lum += clamp01(w.lightning) * 0.45;

    this._lum = clamp01(lum);
    this.lum = this._lum;
  }

  /** §9.3 `lightF` for the current illumination. Published so the tuning can be measured, not argued. */
  get lightF() { return CAMPER_TUNING.lightA + CAMPER_TUNING.lightB * this._lum; }

  /**
   * §9.4 — on a flash, every camper with an unoccluded line to the player inside their cone is
   * flashMarked with a 3 m error radius and enters Curious, AND exposeF = 2.0 persists 0.25 s so
   * the two edges of the tool finally touch.
   */
  _updateFlash(now, ppos) {
    const w = this._weather;
    const l = w ? clamp01(w.lightning ?? 0) : 0;
    const rising = l > 0.45 && this._flashPrev <= 0.45;
    this._flashPrev = l;
    if (!rising || !ppos) return;

    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.alive || a.scripted) continue;
      a.flashExposeUntil = now + CAMPER_TUNING.flashExposeTime;
      if (a.fovSens <= 0 || a.occlF <= 0) continue;
      const r = CAMPER_TUNING.flashMarkError;
      a.lastNoisePos.set(
        ppos.x + a.rand.range(-r, r), ppos.y, ppos.z + a.rand.range(-r, r),
      );
      a.lastNoisePos.y = this._groundAt(a.lastNoisePos.x, a.lastNoisePos.z);
      a.lastNoiseAt = now;
      a.lastNoiseHeard = 0.5;
      a.hasNoise = true;
      if (a.state === 'Idle' || a.state === 'Noticing') a.setState('Curious', now);
    }
  }

  // ===============================================================================================
  // VISION — GAME_DESIGN §9.2 / §9.3, verbatim
  // ===============================================================================================

  /**
   * §18.2: 5 samples every frame for the ONE camper that matters, 1 sample each for two others,
   * round-robin. §20.5 rejects a uniform round-robin and this is why: a player ducking behind a
   * trunk must register now, not 83 ms from now, at exactly the moment they are judging fairness.
   */
  _pickHot(ppos) {
    let best = null, bestDet = -1, nearestInCone = null, nearestD = Infinity;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.alive) continue;
      if (ppos) {
        a.distanceToPlayer = Math.hypot(
          a.position.x - ppos.x, a.position.y - ppos.y, a.position.z - ppos.z,
        );
      } else a.distanceToPlayer = Infinity;
      if (a.detection > bestDet) { bestDet = a.detection; best = a; }
      if (a.fovSens > 0 && a.distanceToPlayer < nearestD) {
        nearestD = a.distanceToPlayer; nearestInCone = a;
      }
    }
    this.hot = (bestDet > 0 ? best : (nearestInCone ?? best));
  }

  _sampleOcclusion(now, ppos) {
    const phys = this._physics;
    if (!ppos) return;
    const hot = this.hot;

    if (hot && hot.alive) {
      this._solveOccl(hot, now, ppos, phys, true);
    }
    // Two cold campers per frame, one chest sample each.
    let done = 0;
    const n = this.agents.length;
    for (let k = 0; k < n && done < CAMPER_TUNING.coldPerFrame; k++) {
      this._coldCursor = (this._coldCursor + 1) % Math.max(1, n);
      const a = this.agents[this._coldCursor];
      if (!a || !a.alive || a === hot) continue;
      this._solveOccl(a, now, ppos, phys, false);
      done++;
    }
    // Staleness clamp: anything older than 1.0 s is forced to VISIBLE, never to its last value.
    // Assuming hidden would let a player park nine campers behind the round-robin.
    for (let i = 0; i < n; i++) {
      const a = this.agents[i];
      if (!a.alive) continue;
      if (now - a.occlAt > CAMPER_TUNING.staleness) {
        a.occlF = (a.fovSens > 0 && a.distanceToPlayer <= a.R) ? 1 : 0;
      }
    }
  }

  _solveOccl(a, now, ppos, phys, full) {
    // Rejection before any ray (§18.2). This is what makes the budget work at all.
    const flameRelevant = full && this._lamp && (this._lamp.lit ?? this._lamp.on);
    if (a.distanceToPlayer > a.R && !flameRelevant) { a.occlF = 0; a.occlAt = now; return; }
    this._updateFovSens(a, ppos);
    if (a.fovSens <= 0) { a.occlF = 0; a.occlAt = now; return; }

    // The occlusion grid answers most forest cases for free — no ray at all.
    const ns = this._noise;
    if (ns?.occlusionBetween) {
      const eye = a.eyePosition;
      _v0.copy(eye);
      _v1.set(ppos.x, ppos.y + 1.0, ppos.z);
      const g = ns.occlusionBetween(_v0, _v1);
      if (isNum(g) && g < CAMPER_TUNING.gridRejectBelow) { a.occlF = 0; a.occlAt = now; return; }
    }

    if (!phys) { a.occlF = 1; a.occlAt = now; return; }
    _v2.copy(a.eyePosition);
    if (full && typeof phys.visibleFraction === 'function') {
      a.occlF = clamp01(phys.visibleFraction(_v2, ppos, this._playerHeight()));
      this.stats.losCalls += 5;
    } else {
      _v3.set(ppos.x, ppos.y + this._playerHeight() * 0.62, ppos.z);
      a.occlF = phys.lineOfSight ? (phys.lineOfSight(_v2, _v3) ? 1 : 0) : 1;
      this.stats.losCalls += 1;
    }
    a.occlAt = now;

    // exposeF's skyline term, refreshed at ~7.5 Hz for the hot camper only (§18.2).
    if (full && typeof phys.skylineFraction === 'function'
      && now - a.skylineAt > 1 / CAMPER_TUNING.skylineHz) {
      a.skylineAt = now;
      let sky = clamp01(phys.skylineFraction(_v2, ppos, this._playerHeight()));
      // The ridge is the level design's exposure trap (§3.4.4) and it must pay off here.
      const t = this._terrain;
      if (t?.nearestRidgePoint) {
        t.nearestRidgePoint(ppos.x, ppos.z, _v3);
        const dr = Math.hypot(_v3.x - ppos.x, _v3.z - ppos.z);
        const above = ppos.y - (_v3.y - 3.0);
        if (dr < 14 && above > -3) sky = Math.max(sky, 0.55 + 0.45 * (1 - dr / 14));
      }
      a.skyline = sky;
      this.stats.losCalls += 5;
    }
  }

  _playerHeight() {
    const p = this._player;
    if (p?.isCrouched) return 1.15;
    return isNum(p?.capsuleHeight) ? p.capsuleHeight : 1.80;
  }

  /** §9.2. Foveal 0–35°, peripheral 35–55° smoothstep 1.00 → 0.20, then zero — with one exception. */
  _updateFovSens(a, ppos) {
    if (!ppos) { a.fovSens = 0; return; }
    const dx = ppos.x - a.position.x, dz = ppos.z - a.position.z;
    const dy = (ppos.y + this._playerHeight() * 0.6) - (a.position.y + a.eyeHeight);
    const flat = Math.hypot(dx, dz);
    if (flat < 1e-4) { a.fovSens = 1; return; }

    // Vertical cone, 70° total.
    const pitch = Math.abs(Math.atan2(dy, flat) - a.headPitch);
    if (pitch > CAMPER_TUNING.verticalFovDeg * 0.5 * _DEG) { a.fovSens = 0; return; }

    const bearing = Math.atan2(dx, -dz);          // -Z is forward
    const off = Math.abs(angDelta(a.headYaw, bearing));
    const outer = a.halfFov;
    const inner = outer * CAMPER_TUNING.fovealFrac;

    if (off <= inner) { a.fovSens = 1; return; }
    if (off <= outer) {
      const f = CAMPER_TUNING.peripheralFloor
        + (1 - CAMPER_TUNING.peripheralFloor) * (1 - smoothstep(inner, outer, off));
      a.fovSens = f;
      return;
    }
    // The exception: motion inside 3 m always registers, whatever way they are facing.
    const moving = this._player ? (this._player.motionState !== 'still') : false;
    a.fovSens = (moving && a.distanceToPlayer < CAMPER_TUNING.closeMotionRange)
      ? CAMPER_TUNING.closeMotionSens : 0;
  }

  _senseVision(a, dt, now, ppos) {
    const T = CAMPER_TUNING;
    let rate = 0;

    if (ppos && a.distanceToPlayer <= a.R && a.fovSens > 0 && a.occlF > 0) {
      const rangeF = clamp01(1 - Math.pow(a.distanceToPlayer / a.R, T.rangeExp));
      const lightF = T.lightA + T.lightB * this._lum;
      const p = this._player;
      const motionF = T.motionF[p?.motionState ?? 'walk'] ?? 1.0;
      const slots = isNum(p?.carrySlots) ? p.carrySlots : 0;
      const carryF = 1 + T.carryPerSlot * slots;
      let exposeF = 1 + T.exposePerSkyline * a.skyline;
      if (now < a.flashExposeUntil) exposeF = Math.max(exposeF, T.flashExpose);
      rate = T.K * a.fovSens * rangeF * lightF * motionF * carryF * exposeF * a.occlF * this._diffMul();
      if (rate < T.noiseFloor) rate = 0;           // THE NOISE FLOOR. This is what makes Freeze true.
    }

    // §9.4 — the flame is a separate percept and it DOMINATES; it does not stack.
    const lamp = this._lamp;
    if (lamp && a.fovSens > 0 && (lamp.lit ?? lamp.on) && a === this.hot
      && typeof lamp.flameRateFor === 'function') {
      _v0.copy(a.eyePosition);
      const fr = lamp.flameRateFor(_v0, a.fovSens, this._diffMul());
      if (isNum(fr) && fr > rate) rate = fr < T.noiseFloor ? 0 : fr;
      this.stats.rays += 1;
    }

    a.rate = rate;
    a.seesPlayer = rate > 0;

    if (rate > 0) {
      a.graceT = 0;
      // The ceiling is 1.0 on every night but the tutorial (§12.2). See `tutorialDetectionCeil`.
      a.detection = Math.min(this._detectionCeil, clamp01(a.detection + rate * dt));
      if (a.detection > a.detectionPeak) { a.detectionPeak = a.detection; a.peakAt = now; }
    } else {
      a.graceT += dt;
      if (a.graceT >= T.decayGrace && a.detection > 0) {
        const dr = a.detection < T.decayFastBelow ? T.decayFast : T.decaySlow;
        let next = a.detection - dr * dt;
        const remembered = (now - a.peakAt < T.peakMemory) ? T.peakFloorMul * a.detectionPeak : 0;
        if (next < remembered) next = remembered;
        a.detection = Math.max(0, next);
        if (a.detection <= 0) { a.detectionPeak = 0; a.spottedFired = false; a.spottedLevel = -1; }
      }
    }
  }

  _diffMul() {
    const d = this.ctx?.settings?.get?.('detectionMul');
    return isNum(d) ? d : 1.0;
  }

  // ===============================================================================================
  // HEARING — §9.8. NoiseSystem's number, and only NoiseSystem's number.
  // ===============================================================================================

  _hear(dt, now) {
    const ns = this._noise;
    if (!ns?.pollNoise) return;
    const per = Math.max(1, Math.ceil(this.agents.length * CAMPER_TUNING.hearHz * dt));
    for (let k = 0; k < per; k++) {
      const n = this.agents.length;
      if (!n) return;
      this._hearCursor = (this._hearCursor + 1) % n;
      const a = this.agents[this._hearCursor];
      if (!a?.alive) continue;
      _v0.set(a.position.x, a.position.y + a.eyeHeight, a.position.z);
      const hit = ns.pollNoise(_v0, a.hearingThreshold, a.lastSeq, _noiseOut, a.index);
      this.stats.hearPolls++;
      if (!hit || !isNum(hit.heard) || hit.heard <= a.hearingThreshold) continue;
      if (IGNORED_NOISE[hit.kind]) { a.lastSeq = Math.max(a.lastSeq, hit.seq ?? -1); continue; }
      a.lastSeq = Math.max(a.lastSeq, hit.seq ?? -1);
      this._noiseHit(a, hit.heard, hit.point, now);
    }
  }

  /**
   * §9.7 — one hit in (thr, 0.35] is Curious; > 0.35 or a second hit inside 8 s is Searching.
   * Curiosity biases the escalation: Robin (0.95) commits on evidence a less interested person
   * would let go, and Dale (0.35) needs telling twice.
   */
  _noiseHit(a, heard, point, now) {
    if (a.scripted) return;                        // senses are read; transitions are suppressed
    a.lastNoisePos.copy(point);
    a.lastNoiseAt = now;
    a.lastNoiseHeard = heard;
    a.hasNoise = true;
    a.hitTimes[a.hitCount % 2] = now;
    a.hitCount++;
    const twoRecent = a.hitCount >= 2
      && (now - a.hitTimes[(a.hitCount - 2) % 2]) < 8.0;

    const escalate = heard > (0.35 - 0.12 * (a.curiosity - 0.5)) || twoRecent;
    if (a.state === 'Alerted' || a.state === 'Panic' || a.state === 'Reporting') return;

    if (escalate) {
      if (a.state !== 'Searching') { this._beginSearch(a, now); this.noiseInvestigations++; }
      else this._restartSweep(a);                      // a fresh hit restarts the sweep, not the clock
      this._say(a, 'heard', now, 0.5);
    } else if (a.state === 'Idle' || a.state === 'Noticing') {
      a.setState('Curious', now);
      this._say(a, 'heard', now, 0.25);
    } else if (a.state === 'Curious') {
      this._beginSearch(a, now);
      this.noiseInvestigations++;
    }
    this._checkRung1();
  }

  // ===============================================================================================
  // THE CABIN AS A PERCEPT — §9.5
  // ===============================================================================================

  _senseStructure(dt, now) {
    const feats = this._features();
    if (!feats || !feats.length) return;
    // One agent per frame; this accrues over seconds, so 60 Hz precision buys nothing.
    const n = this.agents.length;
    if (!n) return;
    const a = this.agents[(this._coldCursor + 1) % n];
    if (!a?.alive || a.state === 'Alerted' || a.state === 'Panic') return;

    const noticeRange = a.R * CAMPER_TUNING.noticeRangeMul;
    for (let i = 0; i < feats.length; i++) {
      const f = feats[i];
      if (!f?.position) continue;
      const fam = a.familiarity[f.id] ?? 0;
      if (fam >= 1) continue;
      const dx = f.position.x - a.position.x, dz = f.position.z - a.position.z;
      const d = Math.hypot(dx, dz);
      if (d > noticeRange) continue;

      const bearing = Math.atan2(dx, -dz);
      const off = Math.abs(angDelta(a.headYaw, bearing));
      if (off > a.halfFov) continue;
      const fovSens = off <= a.halfFov * CAMPER_TUNING.fovealFrac ? 1
        : CAMPER_TUNING.peripheralFloor + 0.8 * (1 - smoothstep(a.halfFov * CAMPER_TUNING.fovealFrac, a.halfFov, off));

      // lightF at the FEATURE, not the player. Fresh-milled lumber is the brightest thing in the
      // night palette, which is an ART decision that is now a gameplay one.
      let lightFs = 0.35 + 0.5 * (f.pale ?? 0.6);
      if (this._lamp && (this._lamp.lit ?? this._lamp.on) && this._player) {
        const dl = Math.hypot(this._player.position.x - f.position.x, this._player.position.z - f.position.z);
        if (dl < 12) lightFs *= f.id === 'interior-light' ? 1.8 : 1.35;
      }
      let occ = 1;
      const ns = this._noise;
      if (ns?.occlusionBetween) {
        _v0.copy(a.eyePosition);
        _v1.set(f.position.x, f.position.y + (f.height ?? 2) * 0.6, f.position.z);
        const g = ns.occlusionBetween(_v0, _v1);
        occ = isNum(g) ? clamp01(g * 1.4) : 1;
      }
      const rate = CAMPER_TUNING.noticeRate * fovSens * clamp01(1 - d / noticeRange)
        * lightFs * (1 - fam) * occ;
      if (rate <= 0.01) continue;

      const cur = (a.notice[f.id] ?? 0) + rate * dt * n;   // dt*n because one agent per frame
      a.notice[f.id] = cur;
      if (cur >= 1.0) {
        a.familiarity[f.id] = 1.0;
        a.notice[f.id] = 1.0;
        a.noticingFeature = f;
        if (!a.scripted) a.setState('Noticing', now);
        this._say(a, 'evidence', now, 0.9);
        this._recordStructureKnowledge(a, f);
      }
      break;                                        // one feature per agent per frame
    }
  }

  /** CabinSite publishes silhouette features; if it does not yet, derive one from the plot. */
  _features() {
    const cs = this._cabin;
    const published = cs?.features ?? (typeof cs?.getFeatures === 'function' ? cs.getFeatures() : null);
    if (Array.isArray(published) && published.length) return published;

    // Fallback: the plot itself becomes a feature once anything is installed. Coarse, but it
    // means the Night 2 beat still fires when CabinSite has not published its schema yet.
    if (!this._fallbackFeatures) {
      const c = cs?.center ?? this._terrain?.buildSiteCenter ?? null;
      if (!c) return null;
      this._fallbackFeatures = [
        { id: 'piers', position: new THREE.Vector3(c.x, c.y, c.z), height: 0.4, pale: 0.4, minInstalled: 1 },
        { id: 'frame', position: new THREE.Vector3(c.x, c.y, c.z), height: 2.4, pale: 0.85, minInstalled: 13 },
        { id: 'roof-skeleton', position: new THREE.Vector3(c.x, c.y, c.z), height: 4.1, pale: 0.8, minInstalled: 27 },
        { id: 'floor-door', position: new THREE.Vector3(c.x, c.y, c.z), height: 2.4, pale: 0.7, minInstalled: 40 },
        { id: 'wall-north', position: new THREE.Vector3(c.x, c.y, c.z), height: 2.4, pale: 0.9, minInstalled: 56 },
        { id: 'roof', position: new THREE.Vector3(c.x, c.y, c.z), height: 4.4, pale: 0.55, minInstalled: 66 },
      ];
    }
    const installed = Object.keys(this.ctx?.state?.installed ?? {}).length;
    this._featureView = this._featureView ?? [];
    this._featureView.length = 0;
    for (const f of this._fallbackFeatures) if (installed >= f.minInstalled) this._featureView.push(f);
    return this._featureView;
  }

  _recordStructureKnowledge(a, f) {
    const sk = this.ctx?.state?.structureKnowledge;
    if (!sk) return;
    if (Array.isArray(sk.seenBy) && sk.seenBy.indexOf(a.id) < 0) sk.seenBy.push(a.id);
    if (!sk.featuresKnown) sk.featuresKnown = {};
    const list = sk.featuresKnown[f.id] ?? (sk.featuresKnown[f.id] = []);
    if (list.indexOf(a.id) < 0) list.push(a.id);
  }

  familiarityOf(id, featureId) {
    const a = this.agent(id);
    return a ? clamp01(a.familiarity[featureId] ?? 0) : 0;
  }

  // ===============================================================================================
  // THE STATE MACHINE — §9.7, with its exact timers
  // ===============================================================================================

  _tickFSM(a, dt, now, ppos) {
    const T = CAMPER_TUNING;

    // Detection thresholds fire regardless of state — the meter is the spine of the whole layer.
    this._meterEvents(a, now);

    switch (a.state) {
      case 'Idle': {
        this._patrol(a, dt, now);
        if (a.detection >= T.formingAt) a.setState('Curious', now);
        break;
      }

      case 'Noticing': {
        a.speed = 0;
        a.hasGoal = false;
        if (a.noticingFeature) this._lookAt(a, a.noticingFeature.position, dt, 2.4);
        if (a.detection >= T.buildingAt) { this._beginSearch(a, now); break; }
        if (a.hasNoise && now - a.lastNoiseAt < 0.4) { this._beginSearch(a, now); break; }
        if (a.stateT >= T.noticingTime) {
          a.noticingFeature = null;
          a.setState('Idle', now);
        }
        break;
      }

      case 'Curious': {
        // Stops. Turns toward lastNoisePos. Raises torch. Speed 0. Six seconds of quiet ends it.
        a.speed = 0;
        a.hasGoal = false;
        if (a.hasNoise) this._lookAt(a, a.lastNoisePos, dt, 2.2);
        if (a.detection >= T.buildingAt) { this._beginSearch(a, now); break; }
        if (a.stateT >= T.curiousQuiet) {
          this._giveUp(a, now);
        }
        break;
      }

      case 'Searching': this._tickSearch(a, dt, now); break;

      case 'Alerted': {
        if (a.detection >= 1 && !a.spottedFired) this._fireSpotted(a, now);
        this._tickReport(a, dt, now, ppos);
        if (ppos && a.distanceToPlayer < 6.0) {
          a.setState('Panic', now);
          this._say(a, 'fear', now, 1.0);
        }
        break;
      }

      case 'Reporting': this._tickReport(a, dt, now, ppos); break;

      case 'Panic': {
        this._tickPanic(a, dt, now, ppos);
        break;
      }

      default: a.setState('Idle', now); break;
    }
  }

  _meterEvents(a, now) {
    const T = CAMPER_TUNING;
    if (a.detection >= 1.0 && !a.spottedFired) {
      this._fireSpotted(a, now);
      if (a.state !== 'Alerted' && a.state !== 'Panic' && a.state !== 'Reporting') {
        this._beginAlert(a, now);
      }
    } else if (a.detection >= T.buildingAt) {
      if (!this._spottedActive || this.detection < a.detection) {
        this._emitSpotted(a, a.detection);
      }
    } else if (a.detection >= T.formingAt && !a.spottedFired) {
      this._emitSpotted(a, a.detection);
      this._say(a, 'heard', now, 0.3);
    }
  }

  /**
   * `player:spotted { camper, level }` — ARCHITECTURE §5's payload, GAME_DESIGN §9.3's meaning.
   *
   * TWO RULES LIVE HERE, both measured rather than assumed.
   *
   * 1. NIGHT 1 DOES NOT PUBLISH IT AT ALL. `tutorialDetectionCeil` 0.30 already sits below
   *    `formingAt`, so on the authored path this branch is never reached on the tutorial night —
   *    but `_fireSpotted` and a future caller are other doors, and §12.2's promise is worth a
   *    lock rather than an arithmetic coincidence. `NightManager.notifySpotted` routes this event
   *    straight into `_escalate('rung2')` and `enterChase('spotted')`, and `Postprocessing` binds
   *    it to `setPanic(1)` with no level test at all. Night 1 is theatre (§12.2); theatre has no
   *    chase phase.
   *
   * 2. IT IS EDGE-TRIGGERED, NOT LEVEL-TRIGGERED. `_meterEvents`' forming branch (0.35..0.75) has
   *    no latch — `spottedFired` is only ever set at detection 1.0 — so it re-emitted on EVERY
   *    frame the meter spent in that band: ~60 Hz of `player:spotted` into a director that counts
   *    `_spottedThisNight++`, a post chain that re-arms full panic, and a Player that re-spikes
   *    fear. Publishing only on a material rise (or a band change) preserves every listener's
   *    behaviour — HUD's arc is driven by `setDetection` every frame regardless, and AudioEngine
   *    latches its own held-breath mix — and costs the bus nothing.
   */
  _emitSpotted(a, level) {
    if (this._tutorialSafe) return;
    const lvl = clamp01(level);
    if (a.spottedLevel >= 0 && lvl < a.spottedLevel + CAMPER_TUNING.spottedRepublishStep
      && !(lvl >= 1 && a.spottedLevel < 1)) return;
    a.spottedLevel = lvl;
    this._spottedActive = true;
    this.bus?.emit?.('player:spotted', { camper: a, level: lvl });
  }

  _fireSpotted(a, now) {
    a.spottedFired = true;
    // §12.2. The ceiling already makes `detection >= 1.0` unreachable on Night 1 and `_beginAlert`
    // refuses the other doors, so this should never run there — but it writes `state.spotted`
    // (which makes `NightManager._maxDetection()` return 1 until `player:hidden`) and arms rung 2
    // with a camp-wide suspicion of +0.25. Those are the two things §12.2 promises cannot happen
    // on the tutorial night, so they get the guard rather than relying on arithmetic upstream.
    if (this._tutorialSafe) {
      Log.once('camp:tutorialspot', 'Campers: Night 1 is theatre (§12.2) — no sighting, no rung 2.');
      return;
    }
    this._emitSpotted(a, 1.0);
    if (this.ctx?.state) this.ctx.state.spotted = true;
    this._say(a, 'call', now, 1.0);
    this._escalate(2, 0.25, 1);
  }

  _publishDetection() {
    const hud = this._hud;
    const hot = this.hot;
    if (hud?.setDetection) {
      if (hot && this.detection > 0) {
        hud.setDetection(this.detection, {
          position: hot.position, source: hot.id, spotted: this.detection >= 1,
        });
      } else hud.setDetection(0);
    }
    if (this._spottedActive && this.detection <= 0) {
      this._spottedActive = false;
      this.bus?.emit?.('player:hidden', {});
    }
  }

  // ------------------------------------------------------------------------------ Searching

  /**
   * Searching must be INTELLIGENT AND READABLE. Predictable-but-tense beats random-and-unfair
   * every time, so the sequence is always the same four moves in the same order:
   *   0 travel to the guess → 1 look around → 2 check cover points → 3 widen → 4 shrug, give up.
   * Bravery decides how many cover points get checked and how far the widen goes; a cautious
   * camper fetches somebody first and never leaves the lamp line.
   */
  _beginSearch(a, now) {
    if (a.scripted) return;
    a.setState('Searching', now);
    a.searchStage = 0;
    a.searchIdx = 0;
    a.searchDwell = 0;
    a.searchCount = 0;
    a.investigations++;

    // The cautious ones go and get someone. That single branch is most of what makes the camp
    // feel authored rather than six copies of one guard.
    if (a.bravery < CAMPER_TUNING.braveThreshold) {
      const mate = this._nearestOther(a, 70);
      if (mate) {
        a.buddy = mate;
        this._goTo(a, mate.position, now);
        this._say(a, 'search', now, 0.5);
        // and tell them about it the moment they are in earshot — see _shareKnowledge
        return;
      }
    }
    this._goTo(a, a.lastNoisePos, now);
    this._say(a, 'search', now, 0.4);
    this._focusSearch(a);
  }

  /**
   * A fresh noise hit while already Searching restarts the SWEEP — stage 0, travel to the new
   * guess — and deliberately does NOT restart `stateT`.
   *
   * It used to do both, and that made §9.7's "→ Idle after **30 s total**" unreachable by anyone
   * making noise faster than once every 30 s. Measured with a severity-1.0 creak every 5 s: the
   * camper closed 9.5 m → 0.8 m and never gave up, because the give-up clock was reset before it
   * could ever expire. `searchTotal` is a budget for one investigation, not for one quiet spell.
   * When it runs out he shrugs and goes Idle; a later noise starts a NEW investigation, which is
   * §9.7's intent and is also the only reading under which the word "total" means anything.
   */
  _restartSweep(a) {
    a.searchStage = 0;
    a.searchIdx = 0;
    a.searchDwell = 0;
    a._widened = false;
  }

  /** Navmesh.setCostModifier so other searchers converge on the same place sensibly. */
  _focusSearch(a) {
    const nav = this._navmesh;
    if (!nav?.setCostModifier || !a.hasNoise) return;
    nav.setCostModifier(`search:${a.id}`, {
      center: a.lastNoisePos, radius: 34, mul: 0.42, ttl: CAMPER_TUNING.searchTotal,
    });
  }

  _tickSearch(a, dt, now) {
    const T = CAMPER_TUNING;

    if (a.stateT >= T.searchTotal) { this._giveUp(a, now); return; }
    if (a.stateT >= T.searchToCurious && a.searchStage >= 3) {
      a.setState('Curious', now);
      return;
    }
    if (a.detection >= T.holdStillAt) { a.speed = 0; a.hasGoal = false; return; }

    // §12.2's second promise, and the only place on Night 1 that can break it. The guess point is
    // a §9.8 error disc around a noise the player made, so it can land on the player; a repeated
    // creak restarts the sweep onto a fresh disc that is a little nearer every time. On the
    // tutorial night he stops at `tutorialKeepOut` and stands there with the beam on you for the
    // rest of the search — which is more frightening than arriving, and provably cannot end with
    // him standing on the player. Every other night is untouched: Searching closes as it always did.
    if (this._tutorialSafe && a.distanceToPlayer <= T.tutorialKeepOut) {
      a.speed = 0;
      a.hasGoal = false;
      if (this._player) this._lookAt(a, this._player.position, dt, 2.4);
      else if (a.hasNoise) this._lookAt(a, a.lastNoisePos, dt, 2.4);
      return;
    }

    switch (a.searchStage) {
      case 0: {                                    // travel to the guess (or to the buddy)
        const dest = (a.buddy && a.buddy.alive && a.bravery < T.braveThreshold && a.stateT < 8)
          ? a.buddy.position : a.lastNoisePos;
        this._goTo(a, dest, now, 1.2);
        const d = Math.hypot(dest.x - a.position.x, dest.z - a.position.z);
        if (d < T.searchArrive + (dest === a.lastNoisePos ? 0 : 1.6)) {
          if (dest !== a.lastNoisePos) {
            // Fetched somebody. Now go together, and now they know.
            this._share(a, a.buddy, now, true);
            a.buddy = null;
            this._goTo(a, a.lastNoisePos, now);
            this._focusSearch(a);
          } else { a.searchStage = 1; a.searchDwell = 0; }
        }
        break;
      }

      case 1: {                                    // stop, square up to the guess, look around
        a.speed = 0; a.hasGoal = false;
        a.searchDwell += dt;
        // Turn the BODY onto the guess and let `_tickTorch` do the sweeping around it. The head
        // used to sweep here too, which fought the beam for control of the same skull.
        const base = Math.atan2(a.lastNoisePos.x - a.position.x, -(a.lastNoisePos.z - a.position.z));
        a.yaw = approachAngle(a.yaw, base, 1.8 * dt);
        if (!a.hasTorch) a.headYaw = approachAngle(a.headYaw, base + Math.sin(a.searchDwell * 2.2) * 45 * _DEG, 3.2 * dt);
        if (a.searchDwell > 2.6) {
          a.searchCount = this._collectCover(a);
          a.searchIdx = 0;
          a.searchStage = a.searchCount > 0 ? 2 : 3;
          a.searchDwell = 0;
        }
        break;
      }

      case 2: {                                    // check the cover points, one at a time
        const p = a.searchPoints[a.searchIdx];
        this._goTo(a, p, now, 1.0);
        const d = Math.hypot(p.x - a.position.x, p.z - a.position.z);
        if (d < 1.8) {
          a.searchDwell += dt;
          a.speed = 0;
          this._lookAt(a, p, dt, 3.0);
          if (a.searchDwell > 1.4) {
            a.searchDwell = 0;
            a.searchIdx++;
            if (a.searchIdx >= a.searchCount) a.searchStage = 3;
          }
        }
        break;
      }

      case 3: {                                    // widen — brave campers go deep, others do not
        if (!a._widened) {
          a._widened = true;
          const nav = this._navmesh;
          const reach = 6 + 22 * a.bravery;
          if (nav?.randomPatrolTarget) {
            nav.randomPatrolTarget(a.rand, a.lastNoisePos, reach, _v0);
            // The cautious will not step outside the lamp line to do it.
            if (a.bravery < T.braveThreshold && nav.litnessAt) {
              const lit = nav.litnessAt(_v0.x, _v0.z);
              if (isNum(lit) && lit < 0.12) _v0.copy(a.lastNoisePos);
            }
            this._goTo(a, _v0, now, 1.0);
          }
        }
        if (!a.hasGoal || Math.hypot(a.goal.x - a.position.x, a.goal.z - a.position.z) < 2.0) {
          a._widened = false;
          this._giveUp(a, now);
        }
        break;
      }

      default: this._giveUp(a, now); break;
    }
  }

  _collectCover(a) {
    const nav = this._navmesh;
    if (!nav?.coverPoints) return 0;
    const want = 1 + Math.round(a.bravery * 2);    // 1..3
    const pts = nav.coverPoints(a.lastNoisePos, clamp(want, 1, 3), _coverScratch, 10 + 8 * a.bravery);
    const n = Math.min(pts.length, 3);
    for (let i = 0; i < n; i++) a.searchPoints[i].copy(pts[i]);
    return n;
  }

  /** The visible shrug. A search that ends with nothing must LOOK like it ended with nothing. */
  _giveUp(a, now) {
    a._widened = false;
    a.hasNoise = false;
    a.hitCount = 0;
    a.shrugT = CAMPER_TUNING.shrugTime;
    a.setState('Idle', now);
    a.buddy = null;
    this._navmesh?.clearCostModifier?.(`search:${a.id}`);
    if (a.rand.next() < 0.35) this._say(a, 'falsealarm', now, 0.4);
  }

  // ------------------------------------------------------------------------------ Alert / report

  _beginAlert(a, now) {
    if (a.scripted) return;

    // §12.2 — the tutorial night has no Alerted state, so it has no report, no rung and no
    // `night:failed`. The detection ceiling above already makes the meter route unreachable; this
    // is the belt to that pair of braces, because Alerted has three other doors (a found body,
    // a report that lost its plan, a shared alarm) and one of them opening on Night 1 would end
    // a run the design promises cannot be lost. He searches instead: visibly rattled, harmless.
    if (this._tutorialSafe) {
      Log.once('camp:tutorialsafe', 'Campers: Night 1 is theatre (§12.2) — Alerted refused; searching instead.');
      if (a.state !== 'Searching') {
        // Without a noise to go to, `_beginSearch` would walk him to a stale point (worst case
        // the world origin). Search where he is standing.
        if (!a.hasNoise) { a.lastNoisePos.copy(a.position); a.lastNoiseAt = now; a.hasNoise = true; }
        this._beginSearch(a, now);
      }
      return;
    }

    a.setState('Alerted', now);
    a.hasGoal = false;
    a.pathLen = 0;
    this._say(a, 'call', now, 1.0);

    // The shout. Canonical kinds only: the head counselor has the whistle, everyone else has
    // a voice, and `voice` is the one kind campers themselves ignore (§9.8) — which is correct,
    // because what actually propagates here is knowledge, below, not sound.
    const kind = a.archetype === 'head counselor' ? 'whistle' : 'voice';
    this.bus?.emit?.('noise:emit', {
      position: a.position.clone(),
      radius: kind === 'whistle' ? 90 : 26,
      intensity: kind === 'whistle' ? 0.90 : 0.30,
      kind,
    });

    this._planReport(a, now);
  }

  /**
   * §9.7 — two kinds of report with different rules, and the 45 m witness cap that makes the
   * intercept arithmetic work at all. A reporter who cannot find a person breaks for the camp,
   * and then they are gone: that is rung 6, and the correct play was three decisions ago.
   */
  _planReport(a, now) {
    const ppos = this._player?.position ?? null;
    const T = CAMPER_TUNING;

    let witness = null;
    if (ppos) {
      let bestD = Infinity;
      for (let i = 0; i < this.agents.length; i++) {
        const o = this.agents[i];
        if (o === a || !o.alive || o.state === 'Panic' || o.report) continue;
        const dp = Math.hypot(o.position.x - ppos.x, o.position.z - ppos.z);
        if (dp > T.witnessRadius) continue;
        const dr = Math.hypot(o.position.x - a.position.x, o.position.z - a.position.z);
        if (dr < bestD) { bestD = dr; witness = o; }
      }
      // Nobody inside the cap: pull the nearest one in. They heard a shout; they walk toward it.
      // Both converging is what puts the meeting inside 45 m without teleporting anybody.
      if (!witness) {
        let bestD2 = Infinity, cand = null;
        for (let i = 0; i < this.agents.length; i++) {
          const o = this.agents[i];
          if (o === a || !o.alive || o.report) continue;
          const dr = Math.hypot(o.position.x - a.position.x, o.position.z - a.position.z);
          if (dr < bestD2 && dr < T.convergeRadius) { bestD2 = dr; cand = o; }
        }
        if (cand) {
          witness = cand;
          if (!cand.scripted) {
            cand.lastNoisePos.copy(a.position);
            cand.lastNoiseAt = now;
            cand.lastNoiseHeard = 0.8;
            cand.hasNoise = true;
            this._beginSearch(cand, now);
          }
        }
      }
    }

    if (witness) {
      a.report = { kind: 'short', t: 0, target: witness, met: false };
      a.setState('Reporting', now);
      return;
    }

    // Long report — the payphone (176 m) or the truck radio (149 m). Not interceptable, by design.
    const nav = this._navmesh;
    let dest = nav?.anchor?.('payphone') ?? nav?.anchor?.('mess') ?? null;
    const truck = nav?.anchor?.('truck') ?? null;
    if (truck && dest) {
      const dt1 = Math.hypot(dest.x - a.position.x, dest.z - a.position.z);
      const dt2 = Math.hypot(truck.x - a.position.x, truck.z - a.position.z);
      if (dt2 < dt1) dest = truck;
    }
    if (!dest) dest = nav?.nearestRally?.(a.position)?.position ?? this._terrain?.campCenter ?? null;
    if (!dest) { a.report = { kind: 'short', t: 0, target: null, met: true }; a.setState('Reporting', now); return; }

    a.report = { kind: 'long', t: 0, target: null, met: false, pos: dest };
    a.setState('Reporting', now);
  }

  _tickReport(a, dt, now, ppos) {
    const T = CAMPER_TUNING;
    const rep = a.report;
    if (!rep) { this._beginAlert(a, now); return; }

    // Intercepted? Short reports are interceptable by design; long ones are not.
    if (rep.kind === 'short' && ppos) {
      const d = Math.hypot(a.position.x - ppos.x, a.position.z - ppos.z);
      if (d < T.interceptDistance) {
        a.interceptT += dt;
        if (a.interceptT >= T.interceptHold) { this.interruptReport(a.id); return; }
      } else a.interceptT = 0;
    }

    if (!rep.met) {
      const dest = rep.kind === 'short' ? (rep.target?.position ?? a.position) : rep.pos;
      this._goTo(a, dest, now, T.alertSpeed / Math.max(0.4, a.walkSpeed));
      const d = Math.hypot(dest.x - a.position.x, dest.z - a.position.z);
      if (d < (rep.kind === 'short' ? T.reportMeetDistance : 2.4)) {
        rep.met = true;
        rep.t = 0;
        if (rep.kind === 'short' && rep.target) this._share(a, rep.target, now, true);
        this._say(a, rep.kind === 'short' ? 'search' : 'call', now, 1.0);
      }
      if (rep.kind === 'short' && rep.target && (!rep.target.alive)) {
        // Their witness is gone. Re-plan; usually that means the long run now.
        a.report = null;
        this._planReport(a, now);
      }
      return;
    }

    a.speed = 0;
    a.hasGoal = false;
    rep.t += dt;
    if (rep.kind === 'short') {
      if (rep.target) this._lookAt(a, rep.target.position, dt, 2.0);
      if (rep.t >= T.shortReportSeconds) this._deliverReport(a, 'short', now);
    } else if (rep.t >= T.longReportSeconds) {
      this._deliverReport(a, 'long', now);
    }
  }

  /** The intercept. Public because the grab and NightManager both need it. */
  interruptReport(id) {
    const a = this.agent(id);
    if (!a || !a.report) return false;
    this._navmesh?.clearCostModifier?.(`search:${a.id}`);
    a.report = null;
    a.interceptT = 0;
    a.setState('Panic', this._t);
    const st = this.ctx?.state;
    if (st?.stats) st.stats.campersEvaded = (st.stats.campersEvaded ?? 0) + 1;
    return true;
  }

  _deliverReport(a, kind, now) {
    a.report = null;
    a.reportedThisNight = true;
    this.reportsTotal++;
    if (this.ctx?.state?.stats) this.ctx.state.stats.reportsTotal = this.reportsTotal;

    if (kind === 'short') {
      this._escalate(3, 0.25, 2);
      this.campLightsOn = true;
      if (this.reportsTotal >= 2) this._escalate(4, 0.35, 1);
      a.setState('Idle', now);
      a.detection = 0;
      this.bus?.emit?.('ui:toast', { text: 'They are talking about it.', ms: 2600 });
      return;
    }

    // Rung 6. The night ends. NightManager owns that verb; we ask before we assert.
    this.rung = 6;
    const nm = this.ctx?.systems?.get?.('NightManager') ?? null;
    const night = this.ctx?.state?.night ?? 1;
    if (typeof nm?.failNight === 'function') nm.failNight('reported');
    else if (typeof nm?.fail === 'function') nm.fail('reported');
    else this.bus?.emit?.('night:failed', { night, reason: 'reported' });
    a.setState('Idle', now);
  }

  // ------------------------------------------------------------------------------ Panic

  _tickPanic(a, dt, now, ppos) {
    const T = CAMPER_TUNING;
    if (a.proneT > 0) {
      a.proneT -= dt;
      a.speed = 0;
      a.hasGoal = false;
      return;
    }
    // Erratic pathing, away from the player, biased toward a rally.
    if (!a.hasGoal || now - a.pathAt > 2.2) {
      const nav = this._navmesh;
      let gx = a.position.x, gz = a.position.z;
      if (ppos) {
        const dx = a.position.x - ppos.x, dz = a.position.z - ppos.z;
        const l = Math.hypot(dx, dz) || 1;
        const jitter = a.rand.range(-0.7, 0.7);
        gx += (dx / l) * 26 + Math.cos(jitter) * 9;
        gz += (dz / l) * 26 + Math.sin(jitter) * 9;
      }
      const rally = nav?.nearestRally?.(a.position);
      if (rally?.position && a.rand.next() < 0.55) { gx = rally.position.x; gz = rally.position.z; }
      _v0.set(gx, this._groundAt(gx, gz), gz);
      this._goTo(a, _v0, now, T.panicSpeed / Math.max(0.4, a.walkSpeed));
    } else {
      this._goTo(a, a.goal, now, T.panicSpeed / Math.max(0.4, a.walkSpeed));
    }

    // §9.7 — stumbles on deadfall, 50% per 4 s, 3.0 s prone. 8% of the map, and it is what makes
    // the chase land at all.
    a.stumbleT += dt;
    if (a.stumbleT >= T.stumblePeriod) {
      a.stumbleT = 0;
      if (a.groundType === 'deadfall' && a.rand.next() < T.stumbleChance) {
        a.proneT = T.stumbleProne;
        this.bus?.emit?.('noise:emit', {
          position: a.position.clone(), radius: 30, intensity: 0.60, kind: 'impact',
        });
      }
    }
    if (a.stateT > 30 && (!ppos || a.distanceToPlayer > 40)) {
      // Cannot be calmed, but they do eventually reach somebody.
      if (!a.report) this._planReport(a, now);
      else a.setState('Reporting', now);
    }
  }

  // ------------------------------------------------------------------------------ Idle patrol

  /**
   * Idle follows a Navmesh patrol route at walking pace and scans ±40° every 4 s. Route slots are
   * exclusive — two campers never hold the same one — and `route.preferred` is honoured first, so
   * Marg gets the dock, Teddy gets the firewood run, and Bev walks her own perimeter.
   */
  _patrol(a, dt, now) {
    // The vigil outranks the route and the dwell, and only ever runs while Idle, so a noise hit
    // still takes this person straight to Curious/Searching out of the middle of it.
    if (a.vigilActive) {
      a.vigilT += dt;
      const d = Math.hypot(a.vigil.x - a.position.x, a.vigil.z - a.position.z);
      if (a.vigilHold <= 0 && d > 2.4) {
        if (a.vigilT > CAMPER_TUNING.plotWatchTimeout) { a.vigilActive = false; return; }
        this._goTo(a, a.vigil, now);
        this._idleScan(a, dt, now);
        return;
      }
      a.vigilHold += dt;
      a.speed = 0;
      a.hasGoal = false;
      const plot = this._plotCenter();
      if (plot) this._lookAt(a, plot, dt, 1.1);
      else this._idleScan(a, dt, now);
      if (a.vigilHold >= CAMPER_TUNING.plotWatchHold) {
        a.vigilActive = false;
        a.pathLen = 0;
        a.dwell = 0;
      }
      return;
    }

    if (a.dwell > 0) {
      a.dwell -= dt;
      a.speed = 0;
      a.hasGoal = false;
      this._idleScan(a, dt, now);
      return;
    }

    const nav = this._navmesh;
    if (!a.route || !nav) {
      // No route available: wander near where we are, so nobody is ever a statue.
      if (!a.hasGoal || Math.hypot(a.goal.x - a.position.x, a.goal.z - a.position.z) < 1.6) {
        if (nav?.randomPatrolTarget) {
          nav.randomPatrolTarget(a.rand, a.position, 26, _v0);
          this._goTo(a, _v0, now);
        } else { a.speed = 0; a.hasGoal = false; }
        a.dwell = a.stopsOften ? a.rand.range(2, 6) : a.rand.range(0, 2);
      } else this._goTo(a, a.goal, now);
      this._idleScan(a, dt, now);
      return;
    }

    const pts = a.route.points;
    if (!pts?.length) { a.route = null; return; }
    const target = pts[a.routeLeg % pts.length];
    this._goTo(a, target, now);
    const d = Math.hypot(target.x - a.position.x, target.z - a.position.z);
    if (d < 2.2) {
      const dwellArr = a.route.dwell;
      a.dwell = (Array.isArray(dwellArr) ? (dwellArr[a.routeLeg % dwellArr.length] || 0) : 0)
        * (a.stopsOften ? 1.25 : 0.85);
      a.routeLeg = (a.routeLeg + 1) % pts.length;
      a.pathLen = 0;
    }
    this._idleScan(a, dt, now);
  }

  /**
   * Scans ±40° every 4 s — but ONLY for campers with no torch. A torch-carrier's head is driven
   * by `_faceTorch` instead; running both put two oscillators on one skull and the beam became
   * unreadable (see `_tickTorch`). Teddy has no torch, so Teddy still does this, and that is a
   * silhouette difference the player can use.
   */
  _idleScan(a, dt, now) {
    const T = CAMPER_TUNING;
    if (a.hasTorch) return;
    const phase = (now * (1 / T.idleScanPeriod) + a.torchPhase) % 1;
    const target = a.yaw + Math.sin(phase * Math.PI * 2) * T.idleScanDeg * _DEG;
    a.headYaw = approachAngle(a.headYaw, target, 1.5 * dt);
    a.headPitch = lerp(a.headPitch, -0.05, clamp01(dt * 2));
  }

  _lookAt(a, p, dt, rate) {
    const bearing = Math.atan2(p.x - a.position.x, -(p.z - a.position.z));
    a.headYaw = approachAngle(a.headYaw, bearing, rate * dt);
    a.yaw = approachAngle(a.yaw, bearing, rate * 0.7 * dt);
    const dy = (p.y + 1.0) - (a.position.y + a.eyeHeight);
    const flat = Math.hypot(p.x - a.position.x, p.z - a.position.z) || 1;
    a.headPitch = lerp(a.headPitch, clamp(Math.atan2(dy, flat), -0.5, 0.4), clamp01(dt * 3));
  }

  // ===============================================================================================
  // SCRIPTED — §9.7. NightManager drives; senses are read but transitions are suppressed.
  // ===============================================================================================

  /**
   * @param {string} id
   * @param {object} opts { path: Vector3[]|null, look: Vector3|null, speed: number,
   *                        hold: seconds, exit: 'Idle'|'Curious'|... }
   *
   * `hold` is seconds STANDING AT THE END OF THE PATH, not seconds since the beat started. It
   * used to be measured from `setScripted`, which meant any beat whose walk was longer than its
   * hold released the instant the last waypoint landed, and `hold: 0` — the obvious way to write
   * "stand there until I say otherwise" — meant "stand there forever", with no way for the beat
   * to end on its own if the director's release never came. Night 1's walk-in was written with
   * `hold: 0` and would have left a man staring at the plot for the remaining six minutes of the
   * night if the creak deferred. `hold <= 0` still means "hold until released", explicitly.
   */
  setScripted(id, opts) {
    const a = this.agent(id);
    if (!a) return false;
    a.scripted = {
      path: Array.isArray(opts?.path) ? opts.path : null,
      idx: 0,
      look: opts?.look ?? null,
      speed: isNum(opts?.speed) ? opts.speed : a.walkSpeed,
      hold: isNum(opts?.hold) ? opts.hold : 0,
      exit: typeof opts?.exit === 'string' ? opts.exit : 'Idle',
      t: 0,
      holdT: 0,                    // seconds standing at the end of the path
    };
    a.setState('Scripted', this._t);
    if (this.agents.indexOf(a) < 0 && a.alive) {
      a.spawned = true;
      this.agents.push(a);
    }
    return true;
  }

  /**
   * AUTHORED INVESTIGATION — "that person heard that, right now." The director's verb, for the
   * beats GAME_DESIGN scripts by hand rather than leaving to the noise field.
   *
   * WHY THIS EXISTS AND WHY IT IS NOT A CHEAT. §17 t=4:39 is the thesis of the game: the first
   * creak, and "the torch turns toward the plot and starts walking." Walking is `Searching`, and
   * `_noiseHit` only escalates to Searching above `0.35 - 0.12*(curiosity - 0.5)` — 0.368 for
   * Dale. A severity-0.45 creak cannot reach 0.368 beyond about 4 m, and its audible radius at a
   * counselor's 0.11 threshold is 21.0 m in open air, so no creak the build system can produce
   * makes a counselor WALK from any distance the player can see him at. One creak buys `Curious`
   * — a turn and a stare — and nothing else, forever. §12.2 says the Night 1 creak "is scripted";
   * this is the other half of that sentence.
   *
   * It changes no behaviour: the guess point comes from NoiseSystem's own §9.8 error disc, and
   * everything after the call is the ordinary `_beginSearch` the senses would have run — travel,
   * look around, check cover, widen, shrug, Idle. `setScripted` is deliberately NOT the tool for
   * this: `_tickTorch` treats 'Scripted' exactly like 'Idle' (the calm ±34° sweep, capped at
   * 0.90 rad/s), and the whole visual tell of §17 is the beam going to `sweepSearchRate` 3.60.
   *
   * @param {string} id
   * @param {THREE.Vector3} position where the sound actually came from
   * @param {object} [opts] `heard` 0..1 (drives the §9.8 error radius; defaults to the camper's
   *                        own threshold), `errorRadius` to override that radius in metres,
   *                        `say` true to let this file pick a 'heard' line. It defaults to FALSE:
   *                        an authored beat names its own line (§17 says DAL_HEAR_01, not "a
   *                        line of that category, about 40% of the time"), and `_say`'s camp and
   *                        agent gaps would otherwise stack a second voice on top of it.
   * @returns {boolean} true if he is now Searching.
   */
  investigate(id, position, opts = null) {
    const a = this.agent(id);
    if (!a?.alive || !position || !isNum(position.x)) return false;
    // Somebody already past Searching is not made calmer by being told again.
    if (a.state === 'Alerted' || a.state === 'Panic' || a.state === 'Reporting') return false;
    if (a.scripted) this.releaseScripted(id);

    const now = this._t;
    const heard = clamp01(isNum(opts?.heard) ? opts.heard : a.hearingThreshold);

    // §9.8 owns the error radius, so an authored investigation guesses exactly as wrongly as a
    // heard one does. errorRadiusFor(0.45) = 11.7 m, which is §17's "a point 12 m off".
    const ns = this._noise;
    if (isNum(opts?.errorRadius)) {
      const ang = a.rand.next() * Math.PI * 2;
      const rad = Math.max(0, opts.errorRadius) * Math.sqrt(a.rand.next());
      a.lastNoisePos.set(position.x + Math.cos(ang) * rad, position.y, position.z + Math.sin(ang) * rad);
      a.lastNoisePos.y = this._groundAt(a.lastNoisePos.x, a.lastNoisePos.z);
    } else if (ns?.investigationPoint) {
      ns.investigationPoint(position, heard, a.rand, a.lastNoisePos, a.index);
    } else {
      a.lastNoisePos.copy(position);
    }

    a.lastNoiseAt = now;
    a.lastNoiseHeard = heard;
    a.hasNoise = true;
    a.hitTimes[a.hitCount % 2] = now;
    a.hitCount++;
    if (a.state === 'Searching') this._restartSweep(a);
    else { this._beginSearch(a, now); this.noiseInvestigations++; }
    if (opts?.say === true) this._say(a, 'heard', now, 0.5);
    this._checkRung1();
    return a.state === 'Searching';
  }

  releaseScripted(id) {
    const a = this.agent(id);
    if (!a?.scripted) return false;
    const exit = a.scripted.exit;
    a.scripted = null;
    a.setState(exit in STATE_ALERT ? exit : 'Idle', this._t);
    return true;
  }

  _tickScripted(a, dt, now) {
    const s = a.scripted;
    s.t += dt;
    if (s.path && s.idx < s.path.length) {
      const p = s.path[s.idx];
      this._goTo(a, p, now, s.speed / Math.max(0.4, a.walkSpeed));
      if (Math.hypot(p.x - a.position.x, p.z - a.position.z) < 1.4) s.idx++;
    } else {
      a.speed = 0;
      a.hasGoal = false;
      s.holdT += dt;
      if (s.look) this._lookAt(a, s.look, dt, 2.0);
      if (s.hold > 0 && s.holdT > s.hold) this.releaseScripted(a.id);
    }
  }

  // ===============================================================================================
  // MOVEMENT
  // ===============================================================================================

  _goTo(a, dest, now, speedMul = 1) {
    a.goal.copy(dest);
    a.hasGoal = true;
    const nav = this._navmesh;

    // Re-path on a cadence, not every frame. A* is amortised but it is not free.
    const stale = now - a.pathAt > 1.6 || a.pathIdx >= a.pathLen;
    if (stale && nav?.findPath) {
      a.pathAt = now;
      const pts = nav.findPath(a.position, dest, _pathScratch);
      const n = Math.min(pts.length, a.path.length);
      for (let i = 0; i < n; i++) a.path[i].copy(pts[i]);
      a.pathLen = n;
      a.pathIdx = n > 1 ? 1 : 0;
    }

    let tx, tz;
    if (a.pathLen > 0 && a.pathIdx < a.pathLen) {
      const wp = a.path[a.pathIdx];
      tx = wp.x; tz = wp.z;
      if (Math.hypot(tx - a.position.x, tz - a.position.z) < 1.3) {
        a.pathIdx++;
        if (a.pathIdx >= a.pathLen) { tx = dest.x; tz = dest.z; }
      }
    } else { tx = dest.x; tz = dest.z; }

    const base = a.state === 'Searching' ? CAMPER_TUNING.searchSpeed
      : (a.state === 'Alerted' || a.state === 'Reporting') ? CAMPER_TUNING.alertSpeed
        : a.state === 'Panic' ? CAMPER_TUNING.panicSpeed
          : a.walkSpeed;
    a.speed = base * speedMul;
    a._moveTX = tx;
    a._moveTZ = tz;
  }

  _steer(a, dt, now) {
    const T = CAMPER_TUNING;
    if (!a.hasGoal || a.speed <= 0 || a.proneT > 0) {
      a.velocity.set(0, 0, 0);
      a.cadence = 0;
      a.animPhase += dt * 0.4;
      this._settle(a, dt);
      return;
    }
    const dx = a._moveTX - a.position.x;
    const dz = a._moveTZ - a.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.06) { a.velocity.set(0, 0, 0); a.cadence = 0; this._settle(a, dt); return; }

    const bearing = Math.atan2(dx, -dz);
    const running = a.state === 'Alerted' || a.state === 'Panic' || a.state === 'Reporting';
    const turn = (running ? T.turnRateRun : T.turnRateWalk) * _DEG * dt;
    a.yaw = approachAngle(a.yaw, bearing, turn);
    if (!a.torchAimed && a.state !== 'Searching') {
      a.headYaw = approachAngle(a.headYaw, a.yaw, turn * 1.4);
    }

    // Only walk forward once roughly facing the way we are going — nobody strafes.
    const align = Math.max(0, Math.cos(angDelta(a.yaw, bearing)));
    const step = a.speed * align * dt;
    const nx = a.position.x + Math.sin(a.yaw) * step;
    const nz = a.position.z - Math.cos(a.yaw) * step;
    a.velocity.set((nx - a.position.x) / Math.max(dt, 1e-4), 0, (nz - a.position.z) / Math.max(dt, 1e-4));
    a.position.x = nx;
    a.position.z = nz;
    a.position.y = this._groundAt(nx, nz);

    const t = this._terrain;
    if (t?.surfaceAt) {
      const s = t.surfaceAt(nx, nz);
      if (typeof s === 'string') a.groundType = s;
    }

    // GAIT CADENCE. ART §8.3 gives each camper a signature rate in Hz and §8.7 says
    // "stride length = speed / stepRate", so the cadence must equal `stepHz` at that camper's own
    // walking speed and scale from there. Real gait splits a speed change between cadence and
    // stride, so both take the square root — which also keeps `strideScale` in `_solveRig`
    // (computed the same way) consistent with this, and that consistency is what stops the feet
    // from skating. The old expression divided speed by `stepHz * 0.86` and multiplied by
    // `stepHz` again, which cancelled the signature out and ran Robin at 1.45 Hz instead of 1.31.
    const sp = Math.sqrt(clamp(a.speed / Math.max(0.4, a.walkSpeed), 0.16, 6.0));
    a.cadence = a.stepHz * sp;
    a.animPhase += a.cadence * dt;

    // Footsteps. Canonical kind and canonical numbers (§9.8), so a camper walking past a hiding
    // player is audible to the player through exactly the same channel the AI listens on.
    const stepPhase = Math.floor(a.animPhase * 2);
    if (stepPhase !== a._lastStep) {
      a._lastStep = stepPhase;
      if (running) {
        this.bus?.emit?.('noise:emit', {
          position: a.position.clone(), radius: 20, intensity: 0.45, kind: 'footstep',
        });
      }
    }
    this._settle(a, dt);
  }

  _settle(a, dt) {
    // ART §8.7: nobody stands still. Weight shifts every 4–9 s, transferred over 1.1 s.
    // The previous version read `smoothstep(0, 1.1, (9 - idleShiftT)/1.1)`, which saturates to 1
    // the instant the timer is re-armed to anything below 7.9 — so the "transfer" was a step and
    // the pose was constant. It is now an explicit from→to blend that actually takes 1.1 s, which
    // is the difference between a person shifting their weight and a mannequin leaning.
    a.idleShiftT -= dt;
    if (a.idleShiftT <= 0) {
      a.idleShiftT = a.rand.range(4, 9);
      a.idleShiftFrom = a.idleShift;
      a.idleShiftTo = a.rand.range(-1, 1);
      a.idleShiftBlend = 0;
    }
    if (a.idleShiftBlend < 1) {
      a.idleShiftBlend = clamp01(a.idleShiftBlend + dt / 1.1);
      const k = smoothstep(0, 1, a.idleShiftBlend);
      a.idleShift = lerp(a.idleShiftFrom, a.idleShiftTo, k);
    }

    // Breath. ART §8.7 wants a 0.7 s plume every 3.1 ± 0.9 s; the froxel injection belongs to the
    // fog agent, but the CHEST still has to move or the figure is a statue between weight shifts.
    a.breathT -= dt;
    if (a.breathT <= 0) a.breathT = 3.1 + a.rand.range(-0.9, 0.9);
    a.breath = Math.max(0, Math.sin(clamp01((3.1 - a.breathT) / 0.7) * Math.PI));

    if (a.shrugT > 0) a.shrugT -= dt;
  }

  // ===============================================================================================
  // PATROL ROUTE ASSIGNMENT — exclusive slots, honouring `preferred` and the schedule windows
  // ===============================================================================================

  _assignRoutes() {
    const nav = this._navmesh;
    if (!nav?.routesFor) return;
    const night = this.ctx?.state?.night ?? 1;
    const ton = this.ctx?.state?.timeOfNight ?? 0;
    const live = nav.routesFor(night, ton, _routeScratch);
    // Nearest-to-the-plot first. Which route a camper walks is this file's decision, and the one
    // that matters is the one that puts a person inside earshot of the thing the player is
    // hammering. Sorted in place on Navmesh's reusable scratch array — no allocation.
    live.sort(byPlotApproach);

    // Release slots whose route left its window, or whose holder is no longer patrolling.
    for (const [rid, holderId] of this._routeTaken) {
      const holder = this.roster.get(holderId);
      let stillLive = false;
      for (let i = 0; i < live.length; i++) if (live[i].id === rid) { stillLive = true; break; }
      if (!stillLive || !holder || !holder.alive || holder.state !== 'Idle' || holder.scripted) {
        this._routeTaken.delete(rid);
        if (holder && holder.route && holder.route.id === rid) holder.route = null;
      }
    }

    // Assign, preferred first. patrolDensity caps how many routes are actually walked.
    let walking = 0;
    for (let i = 0; i < this.agents.length; i++) if (this.agents[i].route) walking++;

    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < this.agents.length; i++) {
        const a = this.agents[i];
        if (!a.alive || a.route || a.scripted || a.state !== 'Idle') continue;
        if (walking >= this.patrolDensity && pass === 1) break;
        for (let r = 0; r < live.length; r++) {
          const route = live[r];
          if (this._routeTaken.has(route.id)) continue;
          const preferred = Array.isArray(route.preferred) && route.preferred.indexOf(a.id) >= 0;
          if (pass === 0 && !preferred) continue;
          this._routeTaken.set(route.id, a.id);
          a.route = route;
          a.routeLeg = 0;
          a.pathLen = 0;
          walking++;
          break;
        }
      }
    }
  }

  _recomputeDensity() {
    const raw = 2 + Math.floor(clamp01(this.suspicion) * 6);
    this.patrolDensity = clamp(raw, this.nightMinDensity, this.nightMaxDensity);
  }

  // ===============================================================================================
  // THE PLOT VIGIL — the guarantee that somebody, sometimes, is close enough to hear the cabin
  // ===============================================================================================

  /** The build site, from whoever is willing to say where it is. */
  _plotCenter() {
    const a = this._navmesh?.anchor?.('plot');
    if (a && isNum(a.x)) return a;
    const cs = this._cabin;
    const c = cs?.center ?? cs?.origin ?? this._terrain?.buildSiteCenter ?? null;
    return (c && isNum(c.x)) ? c : null;
  }

  /**
   * A standing point ~30 m from the plot, on walkable ground, on the side the camper is already
   * on so the approach reads as a patrol arriving rather than a spawn. Rings inward because the
   * ground immediately around the site may be blocked (foliage, the plot's own keep-out); the
   * bearing sweep alternates either side of the camper's own direction for the same reason.
   * @returns {boolean} false only if nobody can say where the plot is.
   */
  _plotApproachPoint(a, out) {
    const plot = this._plotCenter();
    if (!plot) return false;
    const nav = this._navmesh;
    const base = Math.atan2(a.position.x - plot.x, a.position.z - plot.z);
    for (let ring = 0; ring < 4; ring++) {
      const r = CAMPER_TUNING.plotWatchStandoff - ring * 4;      // 30, 26, 22, 18
      for (let k = 0; k < 12; k++) {
        const th = base + (k % 2 ? -1 : 1) * Math.ceil(k * 0.5) * (Math.PI / 6);
        const x = plot.x + Math.sin(th) * r;
        const z = plot.z + Math.cos(th) * r;
        if (nav?.isWalkable && !nav.isWalkable(x, z)) continue;
        out.set(x, this._groundAt(x, z), z);
        return true;
      }
    }
    // Nothing walkable anywhere near the site. Go anyway on the straight bearing — `_goTo` falls
    // back to direct steering when `findPath` fails, and a camper who cannot reach the plot is
    // exactly the failure this whole method exists to survive.
    const x = plot.x + Math.sin(base) * CAMPER_TUNING.plotWatchStandoff;
    const z = plot.z + Math.cos(base) * CAMPER_TUNING.plotWatchStandoff;
    out.set(x, this._groundAt(x, z), z);
    return true;
  }

  /**
   * Once a second: measure how close the camp actually gets to the build site, and if the answer
   * is "never", send one person. Published as `nearestToPlot` / `nearestRouteToPlot` so this is
   * checkable from the console rather than argued about.
   */
  _tickPlotWatch(now) {
    const T = CAMPER_TUNING;
    if (now - this._plotWatchAt < 1.0) return;
    this._plotWatchAt = now;

    const plot = this._plotCenter();
    if (!plot) { this.nearestToPlot = Infinity; this.nearestRouteToPlot = Infinity; return; }

    let nearest = Infinity, routeNearest = Infinity, onVigil = null;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.alive) continue;
      const d = Math.hypot(a.position.x - plot.x, a.position.z - plot.z);
      if (d < nearest) nearest = d;
      const rn = a.route?.nearestPlotApproach;
      if (isNum(rn) && rn < routeNearest) routeNearest = rn;
      if (a.vigilActive) {
        // A vigil PAUSES rather than ends when the camper reacts to something: `_patrol` only runs
        // in Idle, so Noticing/Curious/Searching suspend it for free and it picks up where it left
        // off. Cancelling here instead was measured stopping the walk dead at 47 m — the camper
        // noticed the frame (§9.5), spent 4 s on it, went back to Idle, and then wandered off
        // again having never got close enough for a creak to be audible. Only the states that make
        // the errand moot end it.
        if (a.scripted || a.vigilT > T.plotWatchTimeout
          || a.state === 'Alerted' || a.state === 'Panic' || a.state === 'Reporting') {
          a.vigilActive = false; a.vigilHold = 0;
        } else onVigil = a;
      }
    }
    this.nearestToPlot = nearest;
    this.nearestRouteToPlot = routeNearest;
    if (onVigil) return;

    const night = this.ctx?.state?.night ?? 1;
    if (night < T.plotWatchMinNight && !this.structureReported) return;

    // Covered already: either somebody is inside earshot, or a route being walked comes close
    // enough on its own. Navmesh doing its job is the good case and we stay out of it.
    if (nearest <= T.plotWatchEarshot || routeNearest <= T.plotWatchRouteRange) {
      this._plotWatchLast = now;
      return;
    }
    if (now - this._plotWatchLast < T.plotWatchPeriod) return;

    let pick = null, pickD = Infinity;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.alive || a.scripted || a.state !== 'Idle') continue;
      const d = Math.hypot(a.position.x - plot.x, a.position.z - plot.z);
      if (d < pickD) { pickD = d; pick = a; }
    }
    if (!pick || !this._plotApproachPoint(pick, pick.vigil)) return;
    pick.vigilActive = true;
    pick.vigilHold = 0;
    pick.vigilT = 0;
    pick.dwell = 0;
    pick.pathLen = 0;
    this._plotWatchLast = now;
    Log.once('campers:plotwatch',
      `Campers: no live patrol route comes within ${T.plotWatchRouteRange} m of the build site`
      + ` (best is ${routeNearest === Infinity ? 'none' : routeNearest.toFixed(0) + ' m'}),`
      + ' so a camper is being walked out to it. Fix the route and this stops firing.');
  }

  // ===============================================================================================
  // GROUP BEHAVIOUR — the camp as a social system, not six independent state machines
  // ===============================================================================================

  _pairUp() {
    // Rung 1: campers pair up. The cautious take the brave as their buddy, never each other.
    if (this.rung < 1 && this.suspicion < 0.15) {
      for (let i = 0; i < this.agents.length; i++) {
        if (this.agents[i].state === 'Idle') this.agents[i].buddy = null;
      }
      return;
    }
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.alive || a.state !== 'Idle' || a.scripted) continue;
      if (a.bravery >= CAMPER_TUNING.braveThreshold) continue;
      if (a.buddy && a.buddy.alive && a.buddy.state === 'Idle') continue;
      a.buddy = this._nearestOther(a, 60, true);
    }
  }

  _nearestOther(a, maxDist, braveOnly = false) {
    let best = null, bestD = maxDist;
    for (let i = 0; i < this.agents.length; i++) {
      const o = this.agents[i];
      if (o === a || !o.alive || o.scripted) continue;
      if (braveOnly && o.bravery < CAMPER_TUNING.braveThreshold) continue;
      const d = Math.hypot(o.position.x - a.position.x, o.position.z - a.position.z);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  /**
   * Knowledge propagation. Standing next to somebody who is worried makes you worried, and it
   * makes you worried about the same PLACE. Six state machines become a camp.
   */
  _shareKnowledge(now) {
    if (now - this._shareAt < 0.5) return;
    this._shareAt = now;
    const r2 = CAMPER_TUNING.shareRadius * CAMPER_TUNING.shareRadius;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.alive || !a.hasNoise) continue;
      for (let j = 0; j < this.agents.length; j++) {
        if (i === j) continue;
        const b = this.agents[j];
        if (!b.alive || b.scripted) continue;
        const dx = a.position.x - b.position.x, dz = a.position.z - b.position.z;
        if (dx * dx + dz * dz > r2) continue;
        if (a.lastNoiseAt <= b.lastNoiseAt + 1.0) continue;
        this._share(a, b, now, false);
      }
    }
  }

  _share(from, to, now, forced) {
    if (!to || !to.alive || to.scripted) return;
    if (!forced && now - to.shareAt < CAMPER_TUNING.shareCooldown) return;
    to.shareAt = now;
    to.lastNoisePos.copy(from.lastNoisePos);
    to.lastNoiseAt = from.lastNoiseAt;
    to.lastNoiseHeard = Math.max(to.lastNoiseHeard, from.lastNoiseHeard * 0.85);
    to.hasNoise = true;

    const fromAlert = STATE_ALERT[from.state] ?? 0;
    if (fromAlert >= STATE_ALERT.Searching) {
      if (to.state === 'Idle' || to.state === 'Noticing' || to.state === 'Curious') {
        // The brave go and look. The cautious go Curious and stay where the light is.
        if (to.bravery >= CAMPER_TUNING.braveThreshold || forced) this._beginSearch(to, now);
        else to.setState('Curious', now);
      }
    } else if (fromAlert >= STATE_ALERT.Curious && to.state === 'Idle') {
      to.setState('Curious', now);
    }
    this._say(to, 'search', now, 0.25);
  }

  // ===============================================================================================
  // ESCALATION LADDER — §13.1. Being seen is the start of a sequence, never a game over.
  // ===============================================================================================

  _checkRung1() {
    if (this.noiseInvestigations >= 3 && this.rung < 1) this._escalate(1, 0.10, 0);
  }

  _escalate(rung, suspicionDelta, patrolDelta) {
    if (rung > this.rung) this.rung = rung;
    const st = this.ctx?.state;
    this.suspicion = clamp01(this.suspicion + suspicionDelta);
    if (st) {
      if (typeof st.addSuspicion === 'function') st.addSuspicion(suspicionDelta);
      else st.suspicion = this.suspicion;
      this.suspicion = clamp01(st.suspicion ?? this.suspicion);
    }
    this.nightMaxDensity = Math.min(this.agents.length, this.nightMaxDensity + (patrolDelta || 0));
    this._recomputeDensity();

    if (rung >= 3) this.campLightsOn = true;
    if (rung >= 4 && !this.kidsRecalled) {
      this.kidsRecalled = true;
      // "+1 counselor, −2 kids" — the forest gets emptier and worse.
      for (let i = this.agents.length - 1; i >= 0; i--) {
        const a = this.agents[i];
        if (a.archetype === 'kid') {
          a.spawned = false;
          this.agents.splice(i, 1);
          this._routeTaken.forEach((v, k) => { if (v === a.id) this._routeTaken.delete(k); });
        }
      }
      const bev = this.roster.get('bev');
      if (bev && bev.alive && this.agents.indexOf(bev) < 0) {
        bev.resetForNight();
        bev.spawned = true;
        this._placeAtSpawn(bev, this.ctx?.state?.night ?? 4);
        this.agents.push(bev);
      }
      this.nightMinDensity = Math.max(1, Math.min(this.nightMinDensity, this.agents.length));
      this.nightMaxDensity = Math.max(this.nightMaxDensity, this.agents.length);
      this._recomputeDensity();
    }
    this._persistState();
  }

  /**
   * §9.5 — a structure report is a different thing from a player report, and its real cost is not
   * the suspicion, it is the patrol edge that now routes past your plot every ~110 s.
   */
  structureReport(camperId) {
    if (this.structureReported) return false;
    this.structureReported = true;
    const sk = this.ctx?.state?.structureKnowledge;
    if (sk) sk.reportedAs = 'structure';
    this._escalate(1, 0.15, 0);
    this._navmesh?.addStructurePatrol?.();
    if (camperId) Log.debug(`Campers: ${camperId} filed a structure report. The plot is on a loop now.`);
    return true;
  }

  /** Escalation rung 4, and it is permanent. */
  notifyBodyFound() {
    if (this._bodyFound) return false;
    this._bodyFound = true;
    this._escalate(4, 0.35, 1);
    this.bus?.emit?.('ui:toast', { text: 'The woods have gone quiet.', ms: 3200 });
    return true;
  }

  // ===============================================================================================
  // THE GRAB AND THE BODY — §13.3 / §13.4 / §13.5
  // ===============================================================================================

  /**
   * §13.3 — unaware, alone (no other camper within 20 m), and moving slower than 0.6 m/s. Before
   * their release night an essential character is never all three at once, because they are busy,
   * not because a prompt refuses. If a player contrives it anyway the answer is a silent false.
   */
  canGrab(id) {
    const a = this.agent(id);
    if (!a || !a.alive || this.agents.indexOf(a) < 0) return false;
    const night = this.ctx?.state?.night ?? 1;
    if (night < 4) return false;                                    // the verb does not exist yet
    if (night <= a.essentialUntilNight) return false;               // silent. No feedback. §13.3.
    if (a.detection > 0.25 || a.state === 'Alerted' || a.state === 'Panic') return false;
    if (a.speed > 0.6) return false;
    for (let i = 0; i < this.agents.length; i++) {
      const o = this.agents[i];
      if (o === a || !o.alive) continue;
      if (Math.hypot(o.position.x - a.position.x, o.position.z - a.position.z) < 20) return false;
    }
    return true;
  }

  /** Remove a camper from the world. Returns false (silently) when §13.3 forbids it. */
  remove(id, reason = 'grab') {
    const a = this.agent(id);
    if (!a) return false;
    if (reason === 'grab' && !this.canGrab(id)) return false;
    a.alive = false;
    a.spawned = false;
    a.report = null;
    const i = this.agents.indexOf(a);
    if (i >= 0) this.agents.splice(i, 1);
    this._routeTaken.forEach((v, k) => { if (v === a.id) this._routeTaken.delete(k); });
    this._navmesh?.clearCostModifier?.(`search:${a.id}`);
    if (a.colliderId >= 0) { this._physics?.removeCollider?.(a.colliderId); a.colliderId = -1; }
    const st = this.ctx?.state;
    if (st?.stats) st.stats.kills = (st.stats.kills ?? 0) + 1;
    this._recomputeDensity();
    return true;
  }

  /**
   * §13.5 — register a body so discovery is evaluated against it at 4 Hz. `concealment` is one of
   * 'open' | 'concealed' | 'submerged'. Submerged is never discovered, and that is the whole point
   * of the lake.
   */
  registerBody(object3D, concealment = 'open') {
    if (!object3D) return null;
    const rec = {
      object: object3D,
      position: object3D.position ?? new THREE.Vector3(),
      concealment: (concealment in CAMPER_TUNING.discoveryRadius) ? concealment : 'open',
      found: false,
    };
    this.bodies.push(rec);
    return rec;
  }

  _tickBodies(dt, now) {
    if (!this.bodies.length) return;
    this._bodyTimer += dt;
    if (this._bodyTimer < 1 / CAMPER_TUNING.discoveryHz) return;
    this._bodyTimer = 0;
    const T = CAMPER_TUNING;

    for (let b = 0; b < this.bodies.length; b++) {
      const body = this.bodies[b];
      if (body.found || body.concealment === 'submerged') continue;
      const pos = body.object?.position ?? body.position;
      if (!pos) continue;
      const radius = T.discoveryRadius[body.concealment];
      if (radius <= 0) continue;
      const lumThr = T.discoveryLum[body.concealment];

      for (let i = 0; i < this.agents.length; i++) {
        const a = this.agents[i];
        if (!a.alive) continue;
        const s = a.state;
        if (s !== 'Idle' && s !== 'Curious' && s !== 'Searching' && s !== 'Noticing') continue;
        const dx = pos.x - a.position.x, dz = pos.z - a.position.z;
        const d = Math.hypot(dx, dz);
        if (d > radius) continue;
        const bearing = Math.atan2(dx, -dz);
        if (Math.abs(angDelta(a.headYaw, bearing)) > a.halfFov) continue;

        // Lit? For 'concealed' that means a torch actually aimed at it.
        let lum = 0.12;
        if (body.concealment === 'concealed') {
          const torchOff = Math.abs(angDelta(a.torchYaw, bearing));
          lum = (a.hasTorch && torchOff < CAMPER_TUNING.torchAngle && d < 6) ? 0.9 : 0.05;
        }
        if (lum < lumThr) continue;

        // One grid-occlusion test, NOT a raycast (§13.5).
        const ns = this._noise;
        if (ns?.occlusionBetween) {
          _v0.copy(a.eyePosition);
          _v1.set(pos.x, pos.y + 0.3, pos.z);
          const g = ns.occlusionBetween(_v0, _v1);
          if (isNum(g) && g < 0.02) continue;
        }

        body.found = true;
        this.notifyBodyFound();
        this._say(a, 'fear', now, 1.0);
        this._beginAlert(a, now);
        break;
      }
    }
  }

  // ===============================================================================================
  // TORCHES — the sweeping cone. §9.7's readability lives here; ART §8.7 owns the numbers.
  // ===============================================================================================

  /**
   * THE BEAM. This is the stealth layer's entire user interface, so the rule it obeys is not
   * "look plausible", it is: **one intent per state, and a slew ceiling the player can learn.**
   *
   * The version this replaces composited TWO independent oscillators — a ±34° sweep on top of a
   * head that `_idleScan` was independently swinging ±40° at 0.25 Hz. The sum was a ±74° beam
   * with a beat frequency: unlearnable, and it read as noise rather than as a person looking
   * around. Now there is exactly one oscillator, anchored on the BODY, and the head follows the
   * beam (`_faceTorch`) — which also means the vision cone finally points where the light points,
   * so the visual tell stops lying about where the danger is.
   *
   *   Idle      ±34° @ 0.11 Hz, ceiling 0.90 rad/s   — lazy, wide, plannable
   *   Curious   decelerate to a stop over 1.4 s, HOLD DEAD STILL 2.1 s, then 16°/s onto the thing
   *   Searching ±46° @ 0.38 Hz triangle with end dwells, ceiling 3.60 rad/s — fast and methodical
   *
   * The Idle→Searching ratio is 4x in slew rate and 3.5x in frequency. That gap is the tell.
   */
  _tickTorch(a, dt, now) {
    const T = CAMPER_TUNING;
    if (!a.hasTorch) { a.torchRate = 0; return; }
    const prevYaw = a.torchYaw;

    // 1/f-ish jitter: two incommensurate sines, ±2°. Hand shake, not an oscillator.
    const jitter = Math.sin(now * 2.9 + a.torchPhase * 5.1) * Math.sin(now * 0.71 + a.torchPhase)
      * T.sweepJitterDeg * _DEG;

    if (a.state === 'Idle' || a.state === 'Scripted') {
      a.torchHold = 0;
      a.torchStopT = 0;
      a.torchAnchorYaw = a.yaw;
      const sweep = Math.sin(now * T.sweepCalmHz * Math.PI * 2 + a.torchPhase) * T.sweepCalmDeg * _DEG;
      a.torchTargetYaw = a.yaw + sweep + jitter;
      a.torchYaw = approachAngle(a.torchYaw, a.torchTargetYaw, T.sweepCalmRate * dt);
      a.torchPitch = lerp(a.torchPitch, -0.20, clamp01(dt * 1.5));

    } else if (a.state === 'Curious' || a.state === 'Noticing') {
      a.torchStopT += dt;
      const p = a.noticingFeature?.position ?? (a.hasNoise ? a.lastNoisePos : null);

      if (a.torchStopT < T.torchStopTime) {
        // DECELERATION. The sweep amplitude and the slew ceiling both fall to zero over 1.4 s,
        // so the beam visibly runs out of momentum instead of snapping.
        const k = 1 - smoothstep(0, T.torchStopTime, a.torchStopT);
        const sweep = Math.sin(now * T.sweepCalmHz * Math.PI * 2 + a.torchPhase)
          * T.sweepCalmDeg * _DEG * k;
        a.torchTargetYaw = a.torchAnchorYaw + sweep + jitter * k;
        a.torchYaw = approachAngle(a.torchYaw, a.torchTargetYaw, T.sweepCalmRate * k * dt);
      } else if (a.torchStopT < T.torchStopTime + T.torchHoldTime) {
        // THE HOLD. 2.1 seconds of a beam that does not move. Visible at 180 m; unmistakable.
        // Only the hand shake survives, at a quarter amplitude, so it is still a held object.
        a.torchYaw = approachAngle(a.torchYaw, a.torchYaw + jitter * 0.25, 0.10 * dt);
      } else if (p) {
        // ...then it comes round onto the thing, at a walking-pace 16°/s. Slow enough that you
        // have time to move, fast enough that you know you have been given a deadline.
        const bearing = Math.atan2(p.x - a.position.x, -(p.z - a.position.z));
        a.torchYaw = approachAngle(a.torchYaw, bearing, T.torchTurnDeg * _DEG * dt);
        a.torchAnchorYaw = a.torchYaw;
      }
      if (p) {
        const dy = (p.y + 1.2) - (a.position.y + a.eyeHeight);
        const flat = Math.hypot(p.x - a.position.x, p.z - a.position.z) || 1;
        a.torchPitch = lerp(a.torchPitch, clamp(Math.atan2(dy, flat), -0.6, 0.3), clamp01(dt * 1.4));
      }

    } else if (a.state === 'Searching') {
      // The anchor is the BODY, never the head — anchoring on a head that follows the beam is a
      // positive-feedback loop and the arc walks off into the trees within seconds.
      a.torchStopT = 0;
      a.torchAnchorYaw = a.yaw;
      const ph = (now * T.sweepSearchHz + a.torchPhase) % 1;
      const tri = ph < 0.5 ? smoothstep(0.05, 0.45, ph) : 1 - smoothstep(0.55, 0.95, ph);
      const sweep = (tri * 2 - 1) * T.sweepSearchDeg * _DEG;
      a.torchTargetYaw = a.yaw + sweep + jitter;
      a.torchYaw = approachAngle(a.torchYaw, a.torchTargetYaw, T.sweepSearchRate * dt);
      a.torchPitch = lerp(a.torchPitch, -0.24, clamp01(dt * 2));

    } else {
      // Alerted / Panic / Reporting: locked forward, shaking with the run.
      a.torchStopT = 0;
      a.torchAnchorYaw = a.yaw;
      a.torchYaw = approachAngle(a.torchYaw, a.yaw + jitter * 3, 6.0 * dt);
      a.torchPitch = lerp(a.torchPitch, -0.30, clamp01(dt * 3));
    }

    // Published so the slew ceilings can be measured rather than asserted.
    a.torchRate = dt > 1e-5 ? angDelta(prevYaw, a.torchYaw) / dt : 0;
    a._torchPrevYaw = prevYaw;

    this._faceTorch(a, dt);
  }

  /**
   * ART §8.7's gaze stabilisation, pointed at the right target: for anyone holding a torch the
   * eyes track the BEAM, with lag. This is what makes the cone honest — `_updateFovSens` reads
   * `headYaw`, so from here on the lit arc and the dangerous arc are the same arc.
   */
  _faceTorch(a, dt) {
    const T = CAMPER_TUNING;
    if (a.state === 'Alerted' || a.state === 'Panic' || a.state === 'Reporting') {
      a.headYaw = approachAngle(a.headYaw, a.torchYaw, T.turnRateRun * _DEG * dt);
      return;
    }
    a.headYaw = approachAngle(a.headYaw, a.torchYaw, T.headFollowRate * dt);
    a.headPitch = lerp(a.headPitch, a.torchPitch * 0.55, clamp01(dt * 2.2));
  }

  // ===============================================================================================
  // VOICE — atmosphere, rate-limited hard. Long silences are correct.
  // ===============================================================================================

  _say(a, category, now, weight = 0.5) {
    const T = CAMPER_TUNING;
    if (now - this._voCampAt < T.voCampGap) return false;
    if (now - a.voAt < T.voAgentGap) return false;
    if (category === 'idle' && (now - a.voAt < T.voIdleGap || this.suspicion > 0.3)) return false;
    if (a.rand.next() > weight) return false;
    const vb = this._voice;
    if (!vb?.sayCategory || vb.available === false) return false;
    const handle = vb.sayCategory(category, a.position, a.id);
    if (!handle) return false;
    this._voCampAt = now;
    a.voAt = now;
    return true;
  }

  // ===============================================================================================
  // BODIES — geometry, materials, and the per-frame rig solve
  // ===============================================================================================

  _buildBodies() {
    const scene = this.ctx?.scene;
    if (!scene) return;
    const N = this._maxAgents;
    this.group = new THREE.Group();
    this.group.name = 'Campers';
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);

    const seg = this.ctx?.settings?.tier?.(6, 8, 10, 12) ?? 10;
    const cap = (r, len, sx, sy, sz, oy) => {
      const g = new THREE.CapsuleGeometry(r, len, 3, seg);
      g.scale(sx, sy, sz);
      g.translate(0, oy, 0);
      return g;
    };

    // Every segment's ORIGIN is its parent joint, and it hangs down -Y from there. That makes the
    // rig solve a chain of translate+rotate with no per-segment fixups.
    const G = {};
    G.head = new THREE.SphereGeometry(0.108, seg, Math.max(6, seg - 2));
    G.head.scale(1.0, 1.13, 1.04);
    G.head.translate(0, 0.108, 0);

    // TORSO: a TAPERED cylinder, not a capsule. A capsule is the same width at the waist as at
    // the shoulders, and a silhouette with no taper is a bollard — that is precisely what the
    // first silhouette sheet showed. 0.175 at the shoulder down to 0.132 at the waist is a 25%
    // taper, and the top rim doubles as the shoulder line the head sits on.
    const torso = new THREE.CylinderGeometry(0.175, 0.132, 0.60, seg, 1, false);
    torso.scale(1.22, 1.0, 0.68);
    torso.translate(0, 0.30, 0);                            // pelvis → shoulders, +Y
    G.torso = torso;

    // THE HEM. This piece used to hang to 0.68 m on a 1.77 m body — a mid-thigh overcoat — which
    // buried the thighs and left only 38% of the figure as leg. Humans are ~48% leg and the eye
    // is brutally sensitive to it: short legs is the single strongest 'that is a doll' cue in the
    // whole rig. Shortened to a hip-length hem, which puts the leg break back at 44%.
    G.hips = cap(0.150, 0.02, 1.24, 0.68, 0.86, -0.02);     // the jacket hem — the flare
    G.upperArm = cap(0.049, 0.19, 1.0, 1.0, 1.0, -0.144);
    G.foreArm = cap(0.043, 0.17, 1.0, 1.0, 1.0, -0.128);
    G.thigh = cap(0.073, 0.28, 1.0, 1.0, 1.0, -0.220);
    // Reaches all the way to the ankle joint at -0.415. At -0.198 it stopped 19 mm short and the
    // foot floated, which reads at any distance as a broken puppet.
    G.shin = cap(0.058, 0.30, 1.0, 1.0, 1.0, -0.208);

    // THE WINDBREAKER COLLAR. A period-correct nylon windbreaker's collar is a hard, slightly
    // flared ring above a soft shoulder, and it is worth a whole draw call because it is the
    // element that separates HEAD from TORSO at range. Without it the sphere sits straight on the
    // capsule and the whole figure reads as a bowling pin — which is exactly what it read as.
    const collar = new THREE.CylinderGeometry(0.128, 0.108, 0.11, seg, 1, false);
    collar.translate(0, 0.055, 0);
    G.collar = collar;

    // SHORTS. Camp counsellors in 1986 wore shorts in the rain. One per leg (not a skirt) so the
    // hem swings with the thigh, giving a moving horizontal value break at mid-thigh — which is
    // the cheapest possible cue that a vertical blob has LEGS.
    const shorts = new THREE.CylinderGeometry(0.098, 0.112, 0.235, seg, 1, false);
    shorts.translate(0, -0.112, 0);
    G.shorts = shorts;

    const foot = new THREE.BoxGeometry(0.088, 0.055, 0.205);
    foot.translate(0, -0.030, -0.052);
    G.foot = foot;

    // Cap = dome + brim, merged so it stays one draw call.
    const dome = new THREE.SphereGeometry(0.118, seg, 5, 0, Math.PI * 2, 0, Math.PI * 0.52);
    dome.scale(1.0, 0.82, 1.02);
    dome.translate(0, 0.098, 0);
    const brim = new THREE.BoxGeometry(0.20, 0.018, 0.135);
    brim.translate(0, 0.092, -0.108);
    G.cap = mergeGeometries([dome, brim], false) ?? dome;
    if (G.cap !== dome) { dome.dispose(); brim.dispose(); }

    // Ponytail: a tapered cylinder off the back of the skull, and it swings.
    const pony = new THREE.CylinderGeometry(0.052, 0.026, 0.24, Math.max(5, seg - 4), 1);
    pony.translate(0, -0.12, 0);
    G.pony = pony;

    // Bun / hair volume / hood — one sphere, scaled per camper by the rig.
    G.bun = new THREE.SphereGeometry(0.075, Math.max(6, seg - 2), 5);

    // The torch body itself. A silhouette-bearing object (ART §8.2 axis 4).
    const torch = new THREE.BoxGeometry(0.062, 0.10, 0.062);
    torch.translate(0, -0.05, 0);
    G.torch = torch;

    const skinMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.74, metalness: 0.0, name: 'camper-skin',
    });
    const clothMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.94, metalness: 0.0, name: 'camper-cloth',
    });
    this._mats.push(skinMat, clothMat);

    const SEGS = [
      ['head', G.head, skinMat, 1],
      ['cap', G.cap, clothMat, 1],
      ['pony', G.pony, clothMat, 1],
      ['bun', G.bun, clothMat, 1],
      ['collar', G.collar, clothMat, 1],
      ['torso', G.torso, clothMat, 1],
      ['hips', G.hips, clothMat, 1],
      ['upperArm', G.upperArm, clothMat, 2],
      ['foreArm', G.foreArm, skinMat, 2],
      ['thigh', G.thigh, clothMat, 2],
      ['shorts', G.shorts, clothMat, 2],
      ['shin', G.shin, skinMat, 2],
      ['foot', G.foot, clothMat, 2],
      ['torch', G.torch, clothMat, 1],
    ];

    this._meshes = Object.create(null);
    for (const [key, geo, mat, per] of SEGS) {
      const m = new THREE.InstancedMesh(geo, mat, N * per);
      m.name = `campers-${key}`;
      m.count = N * per;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;                 // one mesh spans the whole map; culling it is wrong
      m.castShadow = true;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      this.group.add(m);
      this._meshes[key] = m;
      this._geoms.push(geo);
    }

    // Park everything off-world until an agent claims a slot.
    _mSeg.makeScale(0, 0, 0);
    for (const key of Object.keys(this._meshes)) {
      const m = this._meshes[key];
      for (let i = 0; i < m.count; i++) m.setMatrixAt(i, _mSeg);
      m.instanceMatrix.needsUpdate = true;
    }
    // NOTE: _applyPalette() is deliberately NOT called here. It needs `roster`, which does not
    // exist yet at this point in init(). Calling it here is the bug that made the cast invisible.
  }

  /** Per-camper colour, written once. Skin, garment, trousers, hair — ART §8.4. */
  _applyPalette() {
    if (!this._meshes) return;
    const set = (key, slot, hex) => {
      const m = this._meshes[key];
      if (!m) return;
      if (!m.instanceColor) {
        m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(m.count * 3), 3);
        for (let i = 0; i < m.count; i++) m.instanceColor.setXYZ(i, 1, 1, 1);
      }
      if (slot >= m.count) return;
      _col.setHex(hex).convertSRGBToLinear();
      m.instanceColor.setXYZ(slot, _col.r, _col.g, _col.b);
      m.instanceColor.needsUpdate = true;
    };
    // The figure is banded on purpose: dark boots, bare/socked shin, dark shorts or trousers,
    // DARK HEM, warm torso, dark collar, skin, hair. Five value changes stacked vertically is what
    // makes a 9 px silhouette at 40 m (ART §7, the Locate row) read as a person rather than a post.
    // The version this replaces painted torso AND hem the same warm colour, so the whole body from
    // the hip to the neck was one uninterrupted orange block with no waist in it.
    let slot = 0;
    for (const a of this.roster.values()) {
      if (slot >= this._maxAgents) break;
      a.visualSlot = slot;
      const shorts = a.legStyle === 'shorts';
      set('head', slot, a.skinColor);
      set('cap', slot, a.capColor);            // a baseball cap is fabric, not hair
      set('pony', slot, a.hairColor);
      set('bun', slot, a.headStyle === 'hood' ? a.coatColor : a.hairColor);
      set('collar', slot, a.coatColor);        // the windbreaker's collar: dark, hard, above soft
      set('torso', slot, a.garmentColor);      // THE warm garment — the palette's payoff (§8.4)
      set('hips', slot, a.coatColor);          // the hem: the value break that gives him a waist
      set('torch', slot, 0x8a8f92);
      for (let s = 0; s < 2; s++) {
        set('upperArm', slot * 2 + s, a.garmentColor);
        set('foreArm', slot * 2 + s, a.skinColor);
        set('thigh', slot * 2 + s, shorts ? a.skinColor : a.pantsColor);
        set('shorts', slot * 2 + s, a.pantsColor);
        set('shin', slot * 2 + s, shorts ? a.sockColor : a.pantsColor);
        set('foot', slot * 2 + s, 0x1c1a18);
      }
      slot++;
    }
  }

  _buildLights() {
    const scene = this.ctx?.scene;
    if (!scene) return;
    this._maxLights = this.ctx?.settings?.tier?.(1, 2, 3, 4) ?? 3;

    // A cheap readable cone. ART §3.2 forbids camper torches from casting shadows and asks for a
    // volumetric cone instead; this is that cone as an additive shell with the falloff baked into
    // vertex alpha, so it costs one draw call and no shader code.
    const len = CAMPER_TUNING.torchDistance;
    const rad = Math.tan(CAMPER_TUNING.torchAngle) * len;
    const cone = new THREE.ConeGeometry(rad, len, 16, 1, true);
    cone.translate(0, -len * 0.5, 0);
    cone.rotateX(-Math.PI * 0.5);                 // apex at origin, axis down -Z
    const pos = cone.attributes.position;
    const colors = new Float32Array(pos.count * 4);
    for (let i = 0; i < pos.count; i++) {
      const t = clamp01(-pos.getZ(i) / len);
      // Two terms, not one. The quadratic alone put all the light in the first 3 m and the far
      // end of the beam vanished, so a sweeping cone read as a bright smudge at the hip instead
      // of as a bar of light travelling across the trees — and the SWEEP is the whole tell.
      // The linear term keeps the far end alive out to 18 m.
      const alpha = ((1 - t) * (1 - t) * 0.68 + (1 - t) * 0.32) * 0.155;
      colors[i * 4] = 1; colors[i * 4 + 1] = 1; colors[i * 4 + 2] = 1;
      colors[i * 4 + 3] = alpha;
    }
    cone.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    this._coneGeo = cone;
    this._geoms.push(cone);

    for (let i = 0; i < this._maxLights; i++) {
      const light = new THREE.SpotLight(
        CAMPER_TUNING.torchColor, CAMPER_TUNING.torchIntensity,
        CAMPER_TUNING.torchDistance, CAMPER_TUNING.torchAngle, CAMPER_TUNING.torchPenumbra, 2,
      );
      light.castShadow = false;                   // NEVER. ART §3.2, and it is the perf line too.
      light.visible = false;
      const target = new THREE.Object3D();
      scene.add(light);
      scene.add(target);
      light.target = target;

      const mat = new THREE.MeshBasicMaterial({
        color: CAMPER_TUNING.torchColor,
        vertexColors: true, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: true,
      });
      this._mats.push(mat);
      const mesh = new THREE.Mesh(cone, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 6;
      scene.add(mesh);

      this._lightSlots.push({ light, target, mesh, agent: null });
    }
  }

  // ===============================================================================================
  // THE RIG SOLVE — a joint chain into rigid segments, once per agent per frame
  // ===============================================================================================

  _updateVisual(dt, now) {
    if (!this._meshes) return;
    const cam = this.ctx?.camera;
    const camPos = cam?.position ?? this._player?.position ?? null;
    const M = this._meshes;

    // Free every slot, then re-claim. Cheaper than tracking, and it guarantees a removed camper
    // leaves no ghost behind.
    for (let i = 0; i < this._maxAgents; i++) this._parkSlot(i);

    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.alive) continue;
      // `visualSlot` starts at -1 and only becomes real in _applyPalette(). The lower bound is
      // not decoration: setMatrixAt(-1, …) writes off the front of the instance buffer.
      const slot = a.visualSlot;
      if (!isNum(slot) || slot < 0 || slot >= this._maxAgents) continue;
      let d = Infinity;
      if (camPos) d = Math.hypot(a.position.x - camPos.x, a.position.z - camPos.z);
      if (d > CAMPER_TUNING.cullDistance) { a.visible = false; continue; }
      a.visible = true;
      a.lod = d < CAMPER_TUNING.animFullDistance ? 0
        : d < CAMPER_TUNING.animCoarseDistance ? 1 : 2;
      this._solveRig(a, slot, dt, now);
    }

    for (const key of Object.keys(M)) M[key].instanceMatrix.needsUpdate = true;
    this._updateLightSlots(now, camPos);
  }

  _parkSlot(slot) {
    const M = this._meshes;
    _mSeg.makeScale(0, 0, 0);
    M.head.setMatrixAt(slot, _mSeg);
    M.cap.setMatrixAt(slot, _mSeg);
    M.pony.setMatrixAt(slot, _mSeg);
    M.bun.setMatrixAt(slot, _mSeg);
    M.collar.setMatrixAt(slot, _mSeg);
    M.torso.setMatrixAt(slot, _mSeg);
    M.hips.setMatrixAt(slot, _mSeg);
    M.torch.setMatrixAt(slot, _mSeg);
    for (let s = 0; s < 2; s++) {
      const j = slot * 2 + s;
      M.upperArm.setMatrixAt(j, _mSeg);
      M.foreArm.setMatrixAt(j, _mSeg);
      M.thigh.setMatrixAt(j, _mSeg);
      M.shorts.setMatrixAt(j, _mSeg);
      M.shin.setMatrixAt(j, _mSeg);
      M.foot.setMatrixAt(j, _mSeg);
    }
  }

  /**
   * ART §8.7. The three things that make a procedural human stop being a mannequin, in order of
   * how much they buy: the arms swing and lag the opposite leg; the head gaze-stabilises against
   * the body; and the torch arm does NOT swing, which is the tell that separates a camper who is
   * looking from one who is walking.
   */
  _solveRig(a, slot, dt, now) {
    const M = this._meshes;
    const s = a.height / 1.75;                     // uniform, propagates down the chain correctly
    const b = a.build;

    const moving = a.speed > 0.05 && a.hasGoal && a.proneT <= 0;
    const running = a.state === 'Alerted' || a.state === 'Panic' || a.state === 'Reporting';
    const p = a.animPhase * Math.PI * 2;

    // STRIDE SOLVED FROM SPEED, NOT GUESSED. `_steer` advances the phase at `cadence` cycles per
    // second, so in one cycle the body covers `speed / cadence` metres and each foot must travel
    // exactly that far relative to the hips. With leg length L that fixes the hip amplitude:
    //     2·L·sin(theta) = speed / cadence
    // The old code used a flat 0.42 rad regardless, which at Robin's speed made every foot slide
    // ~25 cm per step. Feet that skate are the single loudest 'this is a puppet' signal there is.
    const legLen = 0.835 * s;                      // hip joint to sole, in world metres
    const cad = a.cadence > 0.05 ? a.cadence : a.stepHz;
    const stride = moving ? clamp(a.speed / cad, 0, 1.9) : 0;
    const legSwing = moving ? Math.asin(clamp(stride / (2 * legLen), 0, 0.82)) : 0;
    // Everything else that scales with gait scales off the SAME number, so nothing drifts.
    const strideScale = moving ? clamp(legSwing / 0.55, 0.30, 1.90) : 0;
    const bob = moving ? a.bobAmp * Math.abs(Math.sin(p)) * strideScale : 0;
    const roll = moving ? Math.sin(p) * 3.2 * _DEG : a.idleShift * 5.2 * _DEG;
    const lean = a.proneT > 0 ? 1.30 : (running ? 0.20 : (a.state === 'Searching' ? 0.07 : 0.02));
    const crouch = a.state === 'Curious' && a.stateT > 1.5 ? 0.12 : 0;
    a.crouchT = lerp(a.crouchT, crouch, clamp01(dt * 3));

    const hipY = (0.92 - a.crouchT * 0.22) * s + bob * s;
    const proneDrop = a.proneT > 0 ? -0.55 * s : 0;

    // --- root ---------------------------------------------------------------------------------
    _eul.set(0, a.yaw, roll, 'YXZ');
    _quat.setFromEuler(_eul);
    _scale.set(s, s, s);
    _v0.set(a.position.x, a.position.y + hipY + proneDrop, a.position.z);
    _mRoot.compose(_v0, _quat, _scale);

    // --- pelvis hem ---------------------------------------------------------------------------
    _mSeg.copy(_mRoot).scale(_v1.set(b, 1, b));
    M.hips.setMatrixAt(slot, _mSeg);

    // --- spine / torso ------------------------------------------------------------------------
    // ART §8.7: shoulders counter-rotate against the hips, 11°, out of phase by pi.
    const shoulderCounter = moving ? -Math.sin(p) * 11 * _DEG : 0;
    _eul.set(lean, shoulderCounter, 0, 'YXZ');
    _mLocal.makeRotationFromEuler(_eul);
    _mLocal.setPosition(0, 0, 0);
    _mA.multiplyMatrices(_mRoot, _mLocal);        // _mA = chest frame, origin at the pelvis
    // The chest inflates 1.8% on the breath. Invisible as a measurement, decisive as a signal:
    // it is the only thing moving on a camper who has stopped, and stillness is what kills these.
    const breathe = moving ? 1 : 1 + a.breath * 0.018;
    _mSeg.copy(_mA).scale(_v1.set(b * breathe, 1, Math.max(0.8, b * 0.94) * breathe));
    M.torso.setMatrixAt(slot, _mSeg);

    // --- windbreaker collar: the hard ring that separates head from body at 40 m ---------------
    if (a.headStyle === 'hood') {
      _mSeg.makeScale(0, 0, 0);                    // Becca has no neck. That is the whole point.
      M.collar.setMatrixAt(slot, _mSeg);
    } else {
      _mLocal.identity();
      _mLocal.setPosition(0, 0.545, 0);
      _mC.multiplyMatrices(_mA, _mLocal);
      _mSeg.copy(_mC).scale(_v1.set(b * 0.96, 1, b * 0.92));
      M.collar.setMatrixAt(slot, _mSeg);
    }

    // --- head, gaze-stabilised ----------------------------------------------------------------
    a.gazeT += dt;
    const gazeHold = a.gazeT < 0.6 ? 1 : 0;
    a.gazeYaw = lerp(a.gazeYaw, angDelta(a.yaw, a.headYaw), clamp01(dt * (gazeHold ? 6 : 2)));
    if (a.gazeT > 0.6 + a.rand.next() * 0.4) a.gazeT = 0;
    const headBounce = moving ? -Math.sin(p * 2) * 0.012 * strideScale : 0;
    _eul.set(a.headPitch * 0.7, a.gazeYaw - shoulderCounter, 0, 'YXZ');
    _mLocal.makeRotationFromEuler(_eul);
    _mLocal.setPosition(0, 0.62 + headBounce, 0);
    _mB.multiplyMatrices(_mA, _mLocal);           // _mB = neck frame
    const headScale = a.headStyle === 'hood' ? 1.22 : 1.0;
    _mSeg.copy(_mB).scale(_v1.set(headScale, headScale, headScale));
    M.head.setMatrixAt(slot, _mSeg);

    // --- head silhouette accessory (the §8.2 axis that reads first at 40 m) --------------------
    _mSeg.makeScale(0, 0, 0);
    M.cap.setMatrixAt(slot, _mSeg);
    M.pony.setMatrixAt(slot, _mSeg);
    M.bun.setMatrixAt(slot, _mSeg);
    if (a.headStyle === 'cap' || a.headStyle === 'capback') {
      _eul.set(0, a.headStyle === 'capback' ? Math.PI : 0, 0, 'YXZ');
      _mLocal.makeRotationFromEuler(_eul);
      _mLocal.setPosition(0, 0.012, 0);
      _mC.multiplyMatrices(_mB, _mLocal);
      M.cap.setMatrixAt(slot, _mC);
    } else if (a.headStyle === 'pony') {
      // Swings at 0.9× step rate, 90° out of phase (ART §8.3).
      const sw = moving ? Math.sin(p * 0.9 - Math.PI * 0.5) * 0.30 * strideScale : 0;
      _eul.set(0.62 + sw * 0.4, sw, 0, 'YXZ');
      _mLocal.makeRotationFromEuler(_eul);
      _mLocal.setPosition(0, 0.155, 0.088);
      _mC.multiplyMatrices(_mB, _mLocal);
      M.pony.setMatrixAt(slot, _mC);
    } else if (a.headStyle === 'bun') {
      _mLocal.identity();
      _mLocal.setPosition(0, 0.175, 0.070);
      _mC.multiplyMatrices(_mB, _mLocal);
      M.bun.setMatrixAt(slot, _mC);
    } else if (a.headStyle === 'volume') {
      _mLocal.identity();
      _mLocal.setPosition(0, 0.132, 0.006);
      _mC.multiplyMatrices(_mB, _mLocal);
      _mSeg.copy(_mC).scale(_v1.set(1.45, 1.20, 1.42));
      M.bun.setMatrixAt(slot, _mSeg);
    } else if (a.headStyle === 'hood') {
      // No neck. The silhouette is one continuous curve, which is why she is unreadable.
      _mLocal.identity();
      _mLocal.setPosition(0, 0.098, 0.014);
      _mC.multiplyMatrices(_mB, _mLocal);
      _mSeg.copy(_mC).scale(_v1.set(2.05, 1.95, 2.10));
      M.bun.setMatrixAt(slot, _mSeg);
    }

    // --- arms ---------------------------------------------------------------------------------
    // Lag the opposite leg by 0.08 s (ART §8.7) — expressed as a phase offset, so it survives
    // every speed.
    const armLag = moving ? 0.08 * cad * Math.PI * 2 : 0;
    const torchSide = 1;                            // right hand
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? -1 : 1;              // -1 left, +1 right
      const isTorchArm = a.hasTorch && sgn === torchSide;

      const armPhase = Math.sin(p + armLag) * sgn;
      let swing = moving ? -armPhase * a.armSwing * strideScale : 0;
      let outward = 0.09;
      let elbow = -0.28;
      // A human arm swings mostly at the ELBOW: it straightens on the backswing and folds on the
      // way forward, and that fold is what actually reads at range — the upper arm barely moves
      // through 16-22°, but the hand travels twice as far. Without this the arms looked like
      // pendulums bolted to a torso. Positive `armPhase` is this arm forward.
      const elbowPump = moving ? -(0.34 + 0.30 * armPhase) * strideScale : 0;

      if (isTorchArm && (a.torchAimed || a.state !== 'Idle')) {
        // THE TELL (ART §8.7). A stabilised torch arm is a person who is LOOKING; a swinging one
        // is a person who is walking. No `elbowPump` here — that is the entire point.
        // The upper arm stays close to vertical and the ELBOW does the carrying: -0.42/-0.72
        // summed to 65° off vertical at the shoulder, which held the whole arm out horizontally
        // like a sleepwalker. A torch at the hip is a folded elbow, not a raised shoulder.
        swing = a.limbStyle === 'torchhigh' ? -0.62 : -0.10;
        elbow = a.limbStyle === 'torchhigh' ? -0.85 : -1.05;
        outward = 0.13;
      } else if (isTorchArm) {
        swing = -0.24 + swing * 0.18;
        elbow = -0.55 + elbowPump * 0.12;
      } else if (a.limbStyle === 'pockets') {
        // Hands in pockets: the arm is pinned, so the COAT HEM is the moving edge (§8.3).
        swing = -0.10 + swing * 0.35; elbow = -0.95; outward = 0.02;
      } else if (a.limbStyle === 'across') {
        swing = -0.30 + swing * 0.25; elbow = -1.35; outward = -0.02;
      } else if (a.limbStyle === 'balance') {
        outward = 0.34; elbow = -0.20 + elbowPump * 0.45;
      } else if (a.limbStyle === 'down') {
        swing *= 0.70; elbow = -0.18 + elbowPump * 0.55;
      } else if (a.limbStyle === 'wide') {
        outward = 0.16; elbow = -0.28 + elbowPump;
      } else {
        elbow = -0.28 + elbowPump;
      }
      if (a.proneT > 0) { swing = -1.5; elbow = -0.2; }

      _eul.set(swing, 0, sgn * outward, 'YXZ');
      _mLocal.makeRotationFromEuler(_eul);
      _mLocal.setPosition(sgn * 0.200 * b, 0.560, 0);
      _mC.multiplyMatrices(_mA, _mLocal);
      const j = slot * 2 + side;
      _mSeg.copy(_mC).scale(_v1.set(b * 0.94, 1, b * 0.94));
      M.upperArm.setMatrixAt(j, _mSeg);

      _eul.set(elbow, 0, 0, 'YXZ');
      _mLocal.makeRotationFromEuler(_eul);
      _mLocal.setPosition(0, -0.288, 0);
      _mD.multiplyMatrices(_mC, _mLocal);
      M.foreArm.setMatrixAt(j, _mD);

      if (isTorchArm) {
        _mLocal.identity();
        _mLocal.setPosition(0, -0.255, -0.03);
        _mSeg.multiplyMatrices(_mD, _mLocal);
        M.torch.setMatrixAt(slot, _mSeg);
        a._handM = a._handM ?? new THREE.Matrix4();
        a._handM.copy(_mSeg);
      }
    }

    // --- legs ---------------------------------------------------------------------------------
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? -1 : 1;
      const ph = p + (side === 0 ? 0 : Math.PI);
      let hip = moving ? Math.sin(ph) * legSwing : (a.idleShift * sgn > 0 ? 0.03 : -0.03);
      // Knee bends only on the swing half; a straight-through knee is the tell that kills it.
      let knee = moving ? Math.max(0, -Math.cos(ph)) * (running ? 1.15 : 0.72) * strideScale : 0.05;
      if (a.crouchT > 0.01) { hip -= a.crouchT * 2.6; knee += a.crouchT * 4.4; }
      if (a.proneT > 0) { hip = -1.1; knee = 1.5; }

      _eul.set(hip, 0, sgn * 0.035, 'YXZ');
      _mLocal.makeRotationFromEuler(_eul);
      _mLocal.setPosition(sgn * 0.092 * b, -0.02, 0);
      _mC.multiplyMatrices(_mRoot, _mLocal);
      const j = slot * 2 + side;
      _mSeg.copy(_mC).scale(_v1.set(b * 0.95, 1, b * 0.95));
      M.thigh.setMatrixAt(j, _mSeg);

      // Shorts hem, hung off the thigh so it swings with the leg. Hidden on trouser-wearers.
      if (a.legStyle === 'shorts' && a.proneT <= 0) {
        _mSeg.copy(_mC).scale(_v1.set(b * 1.02, 1, b * 1.02));
        M.shorts.setMatrixAt(j, _mSeg);
      } else {
        _mSeg.makeScale(0, 0, 0);
        M.shorts.setMatrixAt(j, _mSeg);
      }

      _eul.set(-knee, 0, 0, 'YXZ');
      _mLocal.makeRotationFromEuler(_eul);
      _mLocal.setPosition(0, -0.440, 0);
      _mD.multiplyMatrices(_mC, _mLocal);
      M.shin.setMatrixAt(j, _mD);

      _eul.set(knee * 0.55 - hip * 0.35, 0, 0, 'YXZ');
      _mLocal.makeRotationFromEuler(_eul);
      _mLocal.setPosition(0, -0.415, 0);
      _mSeg.multiplyMatrices(_mD, _mLocal);
      M.foot.setMatrixAt(j, _mSeg);
    }
  }

  /**
   * Torch slots go to the campers that matter: anyone Curious/Searching/Alerted first, then the
   * nearest. Seven live SpotLights would be a forward-renderer tax nobody agreed to pay.
   */
  _updateLightSlots(now, camPos) {
    const slots = this._lightSlots;
    if (!slots.length) return;

    for (let i = 0; i < this.agents.length; i++) this.agents[i].lightSlot = -1;

    // Rank. Small n; an insertion pass is cheaper than a sort with a comparator closure.
    // PARALLEL ARRAYS, not `{a, score}` objects: this runs every frame for every camper and the
    // object literal was a per-frame allocation, which ARCHITECTURE §12 forbids outright.
    const pickA = this._pickA ?? (this._pickA = []);
    const pickS = this._pickS ?? (this._pickS = []);
    let picked = 0;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.alive || !a.hasTorch || !a.visible) continue;
      const d = camPos ? Math.hypot(a.position.x - camPos.x, a.position.z - camPos.z) : 999;
      const score = (a.alert * 400) - d;
      // Full and not good enough to displace the weakest holder — drop it on the floor.
      if (picked >= slots.length && score <= pickS[picked - 1]) continue;
      let k = picked < slots.length ? picked : slots.length - 1;
      while (k > 0 && pickS[k - 1] < score) { pickS[k] = pickS[k - 1]; pickA[k] = pickA[k - 1]; k--; }
      pickS[k] = score; pickA[k] = a;
      if (picked < slots.length) picked++;
    }

    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const a = i < picked ? pickA[i] : null;
      if (!a) {
        s.light.visible = false;
        s.mesh.visible = false;
        s.agent = null;
        continue;
      }
      a.lightSlot = i;
      s.agent = a;
      a.handPosition(_v0);
      const dir = a.torchYaw;
      const pit = a.torchPitch;
      const cy = Math.cos(pit);
      _v1.set(_v0.x + Math.sin(dir) * cy * 6, _v0.y + Math.sin(pit) * 6, _v0.z - Math.cos(dir) * cy * 6);

      s.light.visible = true;
      s.light.position.copy(_v0);
      s.light.angle = a.wideTorch ? CAMPER_TUNING.torchWideAngle : CAMPER_TUNING.torchAngle;
      s.light.color.set(a.torchTint);
      s.light.intensity = CAMPER_TUNING.torchIntensity * (a.state === 'Alerted' || a.state === 'Panic' ? 1.15 : 1);
      s.target.position.copy(_v1);
      s.target.updateMatrixWorld();

      s.mesh.visible = true;
      s.mesh.position.copy(_v0);
      s.mesh.lookAt(_v1);
      s.mesh.material.color.set(a.torchTint);
      // The cone's WIDTH never changes with state — the player has to be able to learn one cone
      // and trust it. Only the brightness does, and it tracks attention: a searching beam is a
      // brighter beam because the hand is steadier and it is pointed at things, not at the ground.
      const st = a.state;
      const attn = st === 'Searching' ? 1.00
        : (st === 'Alerted' || st === 'Panic' || st === 'Reporting') ? 1.00
          : (st === 'Curious' || st === 'Noticing') ? 0.86
            : 0.62;
      s.mesh.material.opacity = attn * (a.wideTorch ? 0.85 : 1.0);
      s.mesh.scale.set(a.wideTorch ? 1.35 : 1, a.wideTorch ? 1.35 : 1, 1);
      s.mesh.updateMatrixWorld();
    }
  }

  // ===============================================================================================
  // TEARDOWN
  // ===============================================================================================

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.ready = false;

    this._persistState();

    for (const u of this._unsub) { try { u(); } catch { /* already gone */ } }
    this._unsub.length = 0;

    const scene = this.ctx?.scene;
    for (const s of this._lightSlots) {
      s.light.visible = false;
      if (s.light.parent) s.light.parent.remove(s.light);
      if (s.target.parent) s.target.parent.remove(s.target);
      if (s.mesh.parent) s.mesh.parent.remove(s.mesh);
      s.light.dispose?.();
      s.agent = null;
    }
    this._lightSlots.length = 0;

    if (this._meshes) {
      for (const key of Object.keys(this._meshes)) {
        const m = this._meshes[key];
        m.dispose?.();
        if (m.parent) m.parent.remove(m);
      }
      this._meshes = null;
    }
    if (this.group) {
      if (scene && this.group.parent === scene) scene.remove(this.group);
      else if (this.group.parent) this.group.parent.remove(this.group);
      this.group = null;
    }
    for (const g of this._geoms) g.dispose?.();
    this._geoms.length = 0;
    for (const m of this._mats) m.dispose?.();
    this._mats.length = 0;

    const nav = this._navmesh;
    if (nav?.clearCostModifier) {
      for (const a of this.roster.values()) nav.clearCostModifier(`search:${a.id}`);
    }
    const phys = this._physics;
    if (phys?.removeCollider) {
      for (const a of this.roster.values()) {
        if (a.colliderId >= 0) { phys.removeCollider(a.colliderId); a.colliderId = -1; }
      }
    }

    this.agents.length = 0;
    this.roster.clear();
    this.bodies.length = 0;
    this._routeTaken.clear();
    this.hot = null;
  }
}

export default Campers;
