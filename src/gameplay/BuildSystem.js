/**
 * BuildSystem.js — THE BUILD PUZZLE
 * =================================
 *
 * OWNER: Build agent. Implements GAME_DESIGN.md §6 (the build puzzle) and §7 (the creak system)
 * against ARCHITECTURE.md §5's canonical event list. Nothing here invents an event or a `kind`.
 *
 * WHAT THIS FILE IS
 *   - the part taxonomy (§6.1) and the carry-slot arithmetic (§6.2)
 *   - the slot graph (§6.3), including `freeform` slots (§6.7)
 *   - the five-outcome correctness model (§6.4) and discrete yaw candidates (§6.4.2)
 *   - the seating check (§6.5) and fastener accounting (§6.6)
 *   - the creak engine (§7.1–7.3), its caps, its compounding, and its mitigations (§7.4–7.6)
 *   - carrying, dropping, setting down, throwing, and the PROVOKE decoy verb (§9.6)
 *
 * DEGRADATION. Every other system may be missing. `CabinSite` publishes the plot and the ghost;
 * when it is absent this file builds its own slot graph from the canonical night table and draws
 * its own ghost, so the puzzle is playable against a bare `Engine`. `Physics`, `Weather`,
 * `NoiseSystem`, `Player`, `Materials`, `Navmesh` and `Script` are all optional.
 *
 * TONE. Nothing in this file speaks. No toast in this file carries a word: `tool:found` emits
 * `ui:toast { text: '', icon: 'checkbox-filled' }` per §6.9 and that is the entire reward.
 * `inspect()` returns a DIAGNOSIS OBJECT, not prose — numbers and glyph ids for the manual to
 * draw. The manual is the comedian; this file is the thing it is being funny about.
 *
 * -------------------------------------------------------------------------------------------
 * DOCUMENT CONFLICTS, RESOLVED IN WRITING (do not re-open without reading these)
 *
 *  1. SLOT COUNTS. `GAME_DESIGN.md` §2 is the canonical night table (12/14/13/16/10/17/8 = 90,
 *     cumulative 12,26,39,55,65,82,90) and says so explicitly. `Script.js` transcribed
 *     `STORY.md` §6.0's row, whose values (22 trusses, 20 glazing, 28 slots) are the ones
 *     `GAME_DESIGN.md` §0.2 conflict C1 *deletes by name*. This file uses §2's counts.
 *  2. STAGE COUNTS. `Script.beats` triggers `n1_thumbs_up` on `stage-complete { stage: 3 }` and
 *     `n7_final` on `stage: 6` — the two most important beats in the game. So stage counts come
 *     from `Script.nightDef(n).stageCount` (3,3,4,4,5,5,6) when Script is present, falling back
 *     to §2's (2,3,3,3,2,4,1). §2's slots are packed into whichever count is in force; the
 *     authored slot order is a topological order, so contiguous packing never breaks a `requires`.
 *  3. THROW. `GAME_DESIGN.md` §9.6 deletes throwing as *the decoy verb* and §9.8 removes the
 *     `throw` noise kind — PROVOKE replaces it and is implemented here as the canonical decoy.
 *     But `Input.js` (ARCHITECTURE-rank ownership) binds `throwPart: ['KeyG']`, so the verb
 *     exists physically: `throwHeld()` flies a class A/B part on a real arc and lands it with a
 *     canonical `drop` noise. It is not a free lunch — you threw hardware you are short of, and
 *     the stage manifest still counts it.
 *  4. `PIER`. §6.1's part table has no entry for Night 1's six stone piers. One is added here
 *     (`pier`, 31 kg, carry class C, drop noise 0.62). Marked EXT in PART_TYPES.
 *  5. HARDWARE. §6.6 gives fasteners a pocket and a count. Night 2's bracket H and Night 6's
 *     article `0000-000` are hardware, not pocket fasteners, so `Slot.hardware = { id, count }`
 *     is added and folded into the SAME `held / required` ratio §6.4 uses for Under-fastened.
 *     No sixth outcome is introduced.
 *  6. Bindings follow `Input.js`, not §4.1's table: drop is `Q` (tap = loud drop, hold 2.1 s =
 *     silent set-down), throw is `G`, rotate is `R`/`T`, place/seat is LMB, interact is `E`.
 *
 * -------------------------------------------------------------------------------------------
 * PUBLIC API
 *
 *   new BuildSystem(ctx); await init(); update(dt, elapsed); fixedUpdate(fdt); resize(w,h);
 *   dispose();
 *
 *   // state (all read-only)
 *   currentNight  stage  stageCount  heldPart  heldParts  targetSlot  progress
 *   available     installedCount     slotCount  creakRisk  creakDebt   seating
 *   pocket        toolBelt           shortfalls repairIntent  carryClass  carryMass
 *   carrySpeedMultiplier  carryTurnMultiplier  canCrouch  canSprint  blocksView
 *   footstepNoiseMultiplier  maskWindowRemaining  nextStrikeIn  maskLevel
 *
 *   // verbs
 *   pickUp(partOrId)        dropHeld()          setDownHeld()      throwHeld(power = 1)
 *   rotateHeld(dir)         beginPlace()        cancelPlace()
 *   removeJoin(slotId)      topUpFasteners(id)  applyShim(id)      applyTallow(id)
 *   applyFelt(id)           beginRecut(id)      sawPass(id, dt)    provoke(id, holdSeconds)
 *   removeObstruction(slotId)
 *
 *   // reads for other systems
 *   inspect(slotId) -> Diagnosis|null       visualStateFor(slotId) -> string
 *   joinsNear(x, z, r, out) -> count        shortfallInfo(toolId) -> object|null
 *   slotById(id) -> Slot|null               partById(id) -> Part|null
 *   featureHeights() -> { featureId: y }    isDeferred(slotId) -> bool
 *
 *   // statics
 *   BuildSystem.TUNING  .OUTCOMES  .PART_TYPES  .CARRY_CLASSES  .SFX_MAP  .NIGHT_TABLE
 *
 * EVENTS EMITTED (canonical only, exact payload shapes):
 *   build:pickup { part }            build:drop { part }
 *   build:place { part, slot, correct }   build:remove { part, slot }
 *   build:creak { position, severity }    build:stage-complete { stage }
 *   tool:missing { toolId }          tool:found { toolId }
 *   noise:emit { position, radius, intensity, kind }   kinds: drop|impact|hammer|wrench|saw|creak
 *   audio:sfx { id, position?, volume?, rate? }
 *   ui:toast { text, icon, ms }      (text is always the empty string)
 */

import * as THREE from 'three';
import { Log } from '../core/Log.js';
import { Rand, hash2 } from '../core/Rand.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// =================================================================================================
// TUNING — every number here is quoted from GAME_DESIGN.md. A balance pass edits this and nothing
// else. Section references are load-bearing: they are how the next agent audits a change.
// =================================================================================================

export const TUNING = Object.freeze({
  // --- snapping and placement (§6.3, §6.4)
  snapRadius: 0.65,             // m — inside it the carried part ghosts into the slot
  placeReach: 2.40,             // m — how far from the player a slot may be to be a candidate
  pickupReach: 2.40,            // m
  interactDot: 0.35,            // cos of the half-angle of the "am I looking at it" cone
  forcePlaceHold: 3.00,         // s — the Wrong-part verb (§6.4, raised from v1.0's 1.4)
  rotateStepDeg: 15,            // R / T nudge; the SNAP still picks nearest of k (§6.4.2)
  obstructionSeconds: 1.10,     // s — the county survey stake (STORY §1.4). Silent. No prompt.

  // --- the seating check (§6.5)
  rampSeconds: 3.00,            // T_ramp. LINEAR.
  bandCentre: 0.80,
  bandHalfWidth: { story: 0.150, standard: 0.075, gristle: 0.055, nightmare: 0.055 },
  overTorqueCeiling: 0.96,      // p above this splits the wood
  torqueUnder: 0.90,            // multiplier on p when released below the band
  torqueOver: 0.80,             // stored torque for an over-torqued (dimpled) join
  torqueSplit: 0.50,            // stored torque when it splits
  tapInterval: 0.38,            // s — one hammer swing (§4.3)
  tapRadius: 34,                // m (§9.8)
  tapPlan: {                    // [count, intensity] per release band (§6.5)
    under: [3, 0.30], perfect: [4, 0.35], over: [5, 0.40], split: [6, 0.55],
  },
  latencyAllowanceMs: 120,      // §4.1 — the seating check reads event timestamps, not frame time

  // --- wrongness (§6.4)
  wUnderFastened: 0.20,         // × (1 − held/required)
  wRotated: 0.35,
  wWrongSlot: 0.45,             // a reading error, punished less than deliberate vandalism
  wWrongPart: 1.00,
  wRecut: 0.10,                 // you cannot unmake a split (§7.4)
  wErrataCap: 0.35,             // building a G6 step as printed, without the slip (§6.8)
  rotatedOffsetMm: 6,           // the visible offset, and what the next ghost inherits

  // --- the wrong-slot grace window (§6.4.1)
  wrongSlotSilentFor: 90,       // s — lambda is 0, unconditionally
  wrongSlotClampUntil: 240,     // s — then severity <= 0.45 and radius <= 30
  wrongSlotClampSeverity: 0.45,
  wrongSlotClampRadius: 30,

  // --- the creak formula (§7.1)
  creakTickSeconds: 2.00,
  creakJoinsPerFrame: 6,        // "staggered so no more than 6 joins evaluate per frame"
  lambdaBase: 6.0,
  lambdaSeatingWeight: 0.30,    // lambdaRaw = 6.0 * (w + 0.30*s) * ...
  lambdaLoadA: 0.40,
  lambdaLoadB: 0.90,            // ... * (0.40 + 0.90*L) ...
  loadClamp: 2.50,
  windWeight: 0.60, rainWeight: 0.20,   // Mw = 1 + 0.60*wind + 0.20*rain
  coldWeight: 0.50,                     // Mt = 1 + 0.50*timeOfNight
  debtWeight: 0.25,                     // Md = 1 + 0.25*creakDebt

  // --- the caps (§7.2)
  perJoinCap: 1.50,             // creaks/min. The worst join speaks once every 40 s.
  cabinCap: 4.00,               // creaks/min across the whole cabin
  severityBase: 0.25, severityW: 0.55, severityS: 0.30, severityL: 0.20,
  radiusBase: 14, radiusSpan: 46,       // 14 .. 60 m

  // --- creak debt (§7.3)
  debtAccrual: 0.10,            // += 0.10 * severity
  debtDecayPerMinute: 0.15,
  debtMax: 3.0,
  cascadeThreshold: 1.20,
  cascadeCooldown: 180,         // s
  cascadeJoins: [3, 5],
  cascadeWindow: 1.50,          // s
  cascadeRadiusCap: 60,
  debtCarryover: 0.40,          // 40% into the next night

  // --- compounding: a bad join makes its neighbours worse (brief; §7.3's cascade is the cabin
  //     scalar, this is the local one). Bounded so it can never manufacture a spiral on its own.
  neighbourStress: 0.12,        // effective w += 0.12 * mean(neighbour w)
  neighbourStressCap: 0.18,
  neighbourRadius: 2.50,        // m — plus everything joined by `requires`

  // --- mitigation (§7.4)
  shimSeconds: 2.50, shimSeatingGain: 0.35, shimWrongnessGain: 0.15,
  tallowSeconds: 3.00, tallowFactor: 0.45, tallowSeconds_effect: 150, tallowRadius: 3.0,
  feltSeconds: 4.00, feltRadiusFactor: 0.55,
  topUpSeconds: 3.00,
  removeSeconds: 8.00, removeRadius: 24, removeIntensity: 0.45,
  reseatSeconds: 3.00,

  // --- recut (§7.4) and the Night 3 ridge cut (§7.6)
  recutPasses: 8, sawPassSeconds: 5.20, sawPassGap: 2.50,
  ridgePasses: 14,              // 5.14 m -> 4.80 m
  sawRadius: 90, sawIntensity: 0.62,
  sawBindPenalty: 0.50,         // a rushed pass gives half progress and a bind transient

  // --- PROVOKE (§9.6)
  provokeArm: 1.60,             // s to arm
  provokeFuseBase: 2.00, provokeFuseRate: 6.00, provokeFuseMax: 20.00,
  provokeSeverityBase: 0.30, provokeSeverityTorque: 0.45,
  provokeTorqueCost: 0.25,      // permanent
  provokeRefuseW: 0.45,         // joins at or above this are already talking

  // --- carrying (§6.2, §9.8, §10.3)
  pocketCap: 12,                // fasteners
  toolBeltCap: 3,
  partSlots: 4,
  setDownSeconds: 2.10,         // silent
  dropNoise: {                  // §9.8: kind 'drop', radius / intensity by carry class
    A: [8, 0.15], B: [16, 0.35], C: [26, 0.55], D: [40, 0.80], endLift: [40, 0.80], E: [40, 0.80],
  },
  throwSpeed: 11.0,             // m/s at power 1 — a bracket, hard, underarm
  throwLoft: 0.34,              // radians added to the aim pitch
  throwGravity: -22.0,          // ARCHITECTURE §2
  throwMaxMass: 8.0,            // kg — class A and B only. You are a carpenter, not a catapult.
  throwLandRadius: 16, throwLandIntensity: 0.35,   // canonical `drop`, class B row

  // --- the freeform rig (§6.7)
  rigMinUpwardForce: 340,       // newtons
  rigMinHeight: 2.05,           // m
  rigMinDuration: 8.00,         // s, continuous, hands-free
  rigSupportRadius: 1.20,       // m — how close a bearing object must be to the free end
  rigGravity: 9.81,

  // --- housekeeping
  ghostOpacityValid: 0.34,
  ghostOpacityBlocked: 0.15,    // §6.3: dependencies unmet renders in #d92b2b at 15%
  colorGhost: 0xdfe6ec,
  colorRed: 0xd92b2b,           // the manual's red. The only saturated red besides blood.
});

/** The five outcomes of §6.4. `correct` in the event payload is true only for SEATED. */
export const OUTCOMES = Object.freeze({
  SEATED: 'seated',
  UNDER_FASTENED: 'under-fastened',
  ROTATED: 'rotated',
  WRONG_SLOT: 'wrong-slot',
  WRONG_PART: 'wrong-part',
});

/**
 * The brief and the GDD name the same five things differently. Both vocabularies resolve here so
 * a caller written against either one gets the same string back.
 *   PERFECT -> SEATED | RIGHT_ROTATED -> ROTATED | RIGHT_WRONG_SLOT -> WRONG_SLOT
 *   UNDER_TORQUED -> UNDER_FASTENED (the *seating deficit* `s` is a separate axis, see `torque`)
 */
export const OUTCOME_ALIASES = Object.freeze({
  PERFECT: OUTCOMES.SEATED, perfect: OUTCOMES.SEATED, seated: OUTCOMES.SEATED,
  RIGHT_ROTATED: OUTCOMES.ROTATED, rotated: OUTCOMES.ROTATED,
  RIGHT_WRONG_SLOT: OUTCOMES.WRONG_SLOT, wrong_slot: OUTCOMES.WRONG_SLOT,
  'wrong-slot': OUTCOMES.WRONG_SLOT,
  WRONG_PART: OUTCOMES.WRONG_PART, wrong_part: OUTCOMES.WRONG_PART,
  'wrong-part': OUTCOMES.WRONG_PART,
  UNDER_TORQUED: OUTCOMES.UNDER_FASTENED, UNDER_FASTENED: OUTCOMES.UNDER_FASTENED,
  under_fastened: OUTCOMES.UNDER_FASTENED, 'under-fastened': OUTCOMES.UNDER_FASTENED,
});

/** §6.2, verbatim. `slots` is out of 4 part slots; the tool roll is separate and never a slot. */
export const CARRY_CLASSES = Object.freeze({
  A: { slots: 0, speed: 1.00, turn: 1.00, crouch: true, sprint: true, footstep: 1.00 },
  B: { slots: 1, speed: 0.96, turn: 0.95, crouch: true, sprint: true, footstep: 1.05 },
  C: { slots: 2, speed: 0.82, turn: 0.72, crouch: true, sprint: false, footstep: 1.35 },
  D: { slots: 4, speed: 0.63, turn: 0.48, crouch: false, sprint: false, footstep: 1.90 },
  endLift: { slots: 4, speed: 0.52, turn: 0.30, crouch: false, sprint: false, footstep: 2.20 },
  E: { slots: 4, speed: 0.34, turn: 0.30, crouch: false, sprint: false, footstep: 2.60 },
  T: { slots: 0, speed: 1.00, turn: 1.00, crouch: true, sprint: true, footstep: 1.00 },
});

/**
 * §6.1 part taxonomy. `type` is `acceptsType` — the COARSE gate, and it is LENGTH-AGNOSTIC by
 * contract (G4, §6.8): Beam and Beam-short share `beam` and differ only in `length`, which only
 * `partId` checks. `dims` is [x, y, z] in metres for the procedural generator; `read` is the
 * silhouette's read at 25 m in moonlight, which is the ONLY way a part is identified in the dark.
 */
export const PART_TYPES = Object.freeze({
  BEAM: { id: 'BEAM', type: 'beam', length: 3.20, mass: 62, cls: 'D', drop: 0.80, dims: [3.20, 0.20, 0.20], mat: 'lumber', read: 'a line that occludes stars' },
  BEAM_SHORT: { id: 'BEAM_SHORT', type: 'beam', length: 2.60, mass: 48, cls: 'D', drop: 0.78, dims: [2.60, 0.20, 0.20], mat: 'lumber', read: 'the same line, slightly shorter' },
  SILL: { id: 'SILL', type: 'beam', length: 3.20, mass: 62, cls: 'D', drop: 0.80, dims: [3.20, 0.22, 0.22], mat: 'lumber', read: 'a line that occludes stars' },
  POST: { id: 'POST', type: 'post', length: 2.40, mass: 41, cls: 'D', drop: 0.72, dims: [0.18, 2.40, 0.18], mat: 'lumber', read: 'a fencepost' },
  STUD: { id: 'STUD', type: 'post', length: 2.40, mass: 24, cls: 'C', drop: 0.55, dims: [0.10, 2.40, 0.15], mat: 'lumber', read: 'a plank on edge' },
  JOIST: { id: 'JOIST', type: 'joist', length: 2.60, mass: 24, cls: 'C', drop: 0.55, dims: [2.60, 0.24, 0.08], mat: 'lumber', read: 'a plank on edge' },
  TRUSS: { id: 'TRUSS', type: 'truss', length: 4.00, mass: 55, cls: 'D', drop: 0.85, dims: [4.00, 1.10, 0.14], mat: 'lumber', read: 'a shape with a hole in it', shape: 'truss' },
  RIDGE: { id: 'RIDGE', type: 'ridge', length: 5.14, mass: 71, cls: 'D', drop: 0.88, dims: [0.22, 0.30, 5.14], mat: 'lumber', read: 'too long, and you can see it', cutTo: 4.80 },
  PANEL: { id: 'PANEL', type: 'panel', length: 2.40, mass: 33, cls: 'D', drop: 0.75, dims: [1.20, 2.40, 0.04], mat: 'lumber', read: 'a bright grey slab' },
  PANEL_N: { id: 'PANEL_N', type: 'panel', length: 4.80, mass: 71, cls: 'endLift', drop: 0.95, dims: [4.80, 2.40, 0.05], mat: 'lumber', read: 'a wall, walking' },
  BOARD_24: { id: 'BOARD_24', type: 'board', length: 2.40, mass: 9, cls: 'C', drop: 0.40, dims: [2.40, 0.03, 0.20], mat: 'lumber', read: 'a stick' },
  BOARD_12: { id: 'BOARD_12', type: 'board', length: 1.20, mass: 7, cls: 'C', drop: 0.36, dims: [1.20, 0.03, 0.20], mat: 'lumber', read: 'a short plank' },
  BATTEN: { id: 'BATTEN', type: 'batten', length: 2.80, mass: 11, cls: 'C', drop: 0.38, dims: [2.80, 0.04, 0.06], mat: 'lumber', read: 'a wire' },
  SHINGLE: { id: 'SHINGLE', type: 'shingle', length: 0.60, mass: 27, cls: 'C', drop: 0.45, dims: [0.62, 0.22, 0.42], mat: 'lumber', read: 'a sandbag' },
  DOOR: { id: 'DOOR', type: 'door', length: 2.05, mass: 38, cls: 'D', drop: 0.70, dims: [0.90, 2.05, 0.05], mat: 'plank', read: 'the first domestic shape', shape: 'door' },
  SINK: { id: 'SINK', type: 'fitting', length: 0.62, mass: 29, cls: 'C', drop: 0.82, dims: [0.62, 0.34, 0.46], mat: 'granite', read: 'the only white thing' },
  FLUE: { id: 'FLUE', type: 'fitting', length: 2.20, mass: 16, cls: 'C', drop: 0.60, dims: [0.16, 2.20, 0.16], mat: 'steel', read: 'a pipe', shape: 'pipe' },
  DOORFRAME: { id: 'DOORFRAME', type: 'fitting', length: 2.10, mass: 19, cls: 'C', drop: 0.52, dims: [1.00, 2.10, 0.09], mat: 'plank', read: 'a doorway with nothing in it', shape: 'frame' },
  CHAIR_LEG: { id: 'CHAIR_LEG', type: 'chair', length: 0.44, mass: 3, cls: 'B', drop: 0.28, dims: [0.05, 0.44, 0.05], mat: 'plank', read: 'held-item glint' },
  CHAIR_SEAT: { id: 'CHAIR_SEAT', type: 'chair', length: 0.42, mass: 6, cls: 'B', drop: 0.28, dims: [0.42, 0.04, 0.40], mat: 'plank', read: 'held-item glint' },
  CHAIR_BACK: { id: 'CHAIR_BACK', type: 'chair', length: 0.52, mass: 5, cls: 'B', drop: 0.28, dims: [0.42, 0.52, 0.04], mat: 'plank', read: 'held-item glint' },
  CHAIR_ARM: { id: 'CHAIR_ARM', type: 'chair', length: 0.40, mass: 4, cls: 'B', drop: 0.28, dims: [0.40, 0.04, 0.06], mat: 'plank', read: 'held-item glint' },
  BRACKET: { id: 'BRACKET', type: 'bracket', length: 0.22, mass: 1.2, cls: 'B', drop: 0.30, dims: [0.22, 0.22, 0.05], mat: 'bracket', read: 'a black nothing until lantern-lit', shape: 'bracket' },
  HINGE: { id: 'HINGE', type: 'hinge', length: 0.14, mass: 2.1, cls: 'B', drop: 0.32, dims: [0.14, 0.10, 0.03], mat: 'bracket', read: 'glints faintly' },
  PIN: { id: 'PIN', type: 'fastener', length: 0.18, mass: 0.1, cls: 'A', drop: 0.15, dims: [0.02, 0.18, 0.02], mat: 'nail', read: 'invisible; audible rattle', shape: 'pin' },
  FASTENER_BAG: { id: 'FASTENER_BAG', type: 'fastener', length: 0.16, mass: 0.6, cls: 'A', drop: 0.15, dims: [0.16, 0.14, 0.10], mat: 'plank', read: 'invisible; audible rattle', holds: 12 },
  SHIM: { id: 'SHIM', type: 'shim', length: 0.14, mass: 0.3, cls: 'A', drop: 0.10, dims: [0.14, 0.02, 0.06], mat: 'steel', read: 'invisible' },
  TALLOW: { id: 'TALLOW', type: 'tallow', length: 0.10, mass: 1.0, cls: 'A', drop: 0.12, dims: [0.09, 0.10, 0.09], mat: 'steel', read: 'invisible', shape: 'pipe' },
  FELT: { id: 'FELT', type: 'felt', length: 0.12, mass: 0.4, cls: 'A', drop: 0.08, dims: [0.12, 0.01, 0.12], mat: 'plank', read: 'invisible' },
  SISTERING: { id: 'SISTERING', type: 'board', length: 1.20, mass: 7, cls: 'C', drop: 0.36, dims: [1.20, 0.03, 0.18], mat: 'lumber', read: 'a short plank' },
  // EXT — §6.1 has no row for Night 1's six stone piers. See conflict note 4 in the header.
  PIER: { id: 'PIER', type: 'pier', length: 0.52, mass: 31, cls: 'C', drop: 0.62, dims: [0.52, 0.40, 0.52], mat: 'granite', read: 'a squared boulder', ext: true },
  GUSSET: { id: 'GUSSET', type: 'bracket', length: 0.30, mass: 1.6, cls: 'B', drop: 0.30, dims: [0.30, 0.26, 0.04], mat: 'bracket', read: 'a black nothing until lantern-lit', shape: 'bracket' },
});

/**
 * `audio:sfx` id mapping, published so the Audio agent wires it in one place. The ids on the LEFT
 * are the ones GAME_DESIGN.md and STORY.md name (and `join_seat` is story-load-bearing — it is
 * the only sound on the bus during Night Four's kill). The ids on the RIGHT are the recipes that
 * already exist in `ProceduralSFX.RECIPES`.
 */
export const SFX_MAP = Object.freeze({
  join_seat: 'screw.seat',
  join_split: 'wood.split',
  creak_tick: 'creak.t1.s2',
  creak_groan: 'creak.t3.s3',
  hardware_chime: 'ui.chime',
  hardware_tick_steel: 'glass.ping',
  hardware_tick_paper: 'ui.page',
  hardware_tick_cloth: 'canvas.flap',
  impact_wood: 'lumber.knock',
  impact_earth: 'step.mud',
});

/** §2, the canonical night table. `stages` is the fallback; Script's stageCount wins (note 2). */
export const NIGHT_TABLE = Object.freeze([
  { n: 1, title: 'FOUNDATION (A)', slots: 12, stages: 2, seconds: 800, grammar: 'G1', rain: 0.15, wind: 0.20 },
  { n: 2, title: 'UPRIGHTS (B x4) — SUPPORT WHILE FIXING', slots: 14, stages: 3, seconds: 975, grammar: 'G2', rain: 0.40, wind: 0.35 },
  { n: 3, title: 'DO NOT OVERTIGHTEN', slots: 13, stages: 3, seconds: 950, grammar: 'G3', rain: 0.10, wind: 0.55 },
  { n: 4, title: 'IF PARTS ARE MISSING, DO NOT RETURN TO STORE', slots: 16, stages: 3, seconds: 1050, grammar: 'G4', rain: 0.75, wind: 0.60 },
  { n: 5, title: 'THIS STEP REQUIRES TWO PERSONS', slots: 10, stages: 2, seconds: 1175, grammar: 'G5', rain: 0.25, wind: 0.30 },
  { n: 6, title: 'SOLD SEPARATELY', slots: 17, stages: 4, seconds: 1400, grammar: 'G6', rain: 0.90, wind: 0.85 },
  { n: 7, title: 'SOME ASSEMBLY REQUIRED', slots: 8, stages: 1, seconds: Infinity, grammar: 'G7', rain: 0.05, wind: 0.10 },
]);

/** §3.3 named locations, XZ. Used for pile and shortfall placement when Props is absent. */
const MAP = Object.freeze({
  plot: [0, 0], palletA: [4, 12], palletB: [-9, 16], apron: [11, 24], woodpile: [33, 32],
  stump: [29, -5], ridge: [-58, 4], sinkProp: [-48, -35], canoeRack: [61, -58],
  boathouse: [74, -61], dock: [86, -66], toolShed: [-22, 129], cabins: [18, 141],
  truck: [37, 145], messHall: [79, 148], payphone: [84, 154], fallenLog: [-22, -23],
});

/** §6.9 — the missing-hardware comedy engine, per night. `toolId`s match `Script.beats` triggers. */
const SHORTFALLS = Object.freeze({
  1: [{ toolId: 'shim_plate_1961', partId: 'SHIM', at: 'fallenLog', material: 'stone', hintable: false }],
  2: [{ toolId: 'bracket_H', partId: 'BRACKET', at: 'woodpile', material: 'metal', hintable: true, forSlot: 'B-04' }],
  3: [{ toolId: 'gusset_plate', partId: 'GUSSET', at: 'boathouse', material: 'metal', hintable: true, forSlot: 'TR-06' }],
  4: [{ toolId: 'hinge_set_brass', partId: 'HINGE', at: 'boathouse', material: 'metal', hintable: true, forSlot: 'H-03', count: 3 }],
  5: [{ toolId: 'second_person', partId: null, at: null, material: null, hintable: false, forSlot: 'W-NORTH' }],
  6: [
    { toolId: 'errata_slip', partId: null, at: 'boathouse', material: 'paper', hintable: true, forSlot: 'BAT-05' },
    { toolId: 'article_0000_000', partId: null, at: null, material: null, hintable: false, forSlot: 'DFR-01' },
  ],
  7: [{ toolId: 'the_person_in_the_chair', partId: null, at: null, material: null, hintable: false, forSlot: 'CHR-B-4' }],
});

// =================================================================================================
// THE SLOT GRAPH (§6.3)
//
// `CabinSite.js` owns the plot and publishes the layout; this is the fallback that keeps the
// puzzle playable while `CabinSite` is a stub. Authored order is a TOPOLOGICAL order, which is
// what lets `_packStages()` chop it into contiguous stages without ever putting a slot before the
// slot it requires. The 14 x 10 m footprint is §3.3.
// =================================================================================================

const FOOT_X = 7.0;   // half-width  (14 m)
const FOOT_Z = 5.0;   // half-depth  (10 m)

/** Slot factory. Keeps the night definitions below readable. */
function S(id, o) {
  return {
    id,
    kind: o.kind || 'fixed',
    night: o.night | 0,
    stage: 1,
    group: o.group || 'misc',
    acceptsType: o.accepts ?? null,
    partId: o.partId ?? null,
    px: o.p[0], py: o.p[1], pz: o.p[2],
    yaw: o.yaw ?? 0,
    axis: o.axis || 'y',
    yawCandidates: o.k ?? 4,
    symmetryOrder: o.sym ?? 4,
    candidateOffset: o.offset ?? 0,     // G2 mirroring: shifts WHICH candidates are correct
    requires: o.req || [],
    fasteners: o.f ?? 0,
    hardware: o.hw ?? null,             // { id, count } — see conflict note 5
    ratedMass: o.rated ?? 160,
    mirrorOf: o.mirror ?? null,
    hidden: !!o.hidden,                 // G3 — drawn nowhere in the diagram
    errata: !!o.errata,                 // G6 — the printed step for this slot is wrong
    deferred: o.deferred ?? null,       // G7 — leaving it OPEN is correct
    obstruction: o.obstruction ?? null, // the county survey stake
    requiresCut: o.cut ?? 0,            // §7.6 — the part must be sawn to this length first
    feature: o.feature ?? null,         // §9.5 silhouette feature this slot belongs to
    occupant: !!o.occupant,             // N7: the article that is a person
    bounds: o.bounds ?? null,           // freeform only
    goal: o.goal ?? null,               // freeform only
    article: o.article ?? null,         // the manual's article number, §3 ARTICLE_SCHEME
  };
}

/** Ring of six piers: corners plus the two long-wall midpoints. */
const PIER_XZ = [[-FOOT_X, -FOOT_Z], [0, -FOOT_Z], [FOOT_X, -FOOT_Z], [FOOT_X, FOOT_Z], [0, FOOT_Z], [-FOOT_X, FOOT_Z]];
const CORNER_XZ = [[-FOOT_X, -FOOT_Z], [FOOT_X, -FOOT_Z], [FOOT_X, FOOT_Z], [-FOOT_X, FOOT_Z]];
const CORNER_ID = ['C-NW', 'C-NE', 'C-SE', 'C-SW'];

/**
 * Build the slot list for one night. Counts are §2's (see conflict note 1); the sum is 90.
 * @returns {Array} slots in dependency order
 */
function nightSlots(n) {
  const s = [];
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

  if (n === 1) {
    // 6 stone piers + 6 sill beams = 12. Piers are genuinely symmetric (§6.4.2: symmetryOrder = k
    // "used for all of Night 1's piers") so Rotated cannot happen on them. The sills can go in
    // backwards, which is G1's failure mode and the only way to be wrong on Night One.
    for (let i = 0; i < 6; i++) {
      s.push(S(`P-0${i + 1}`, {
        night: 1, group: 'piers', accepts: 'pier', partId: 'PIER', feature: 'piers',
        p: [PIER_XZ[i][0], 0.20, PIER_XZ[i][1]], k: 4, sym: 4, f: 0, rated: 220,
        article: '1962-006', obstruction: i === 0 ? 'county-stake' : null,
      }));
    }
    for (let i = 0; i < 6; i++) {
      const a = PIER_XZ[i], b = PIER_XZ[(i + 1) % 6], m = mid(a, b);
      s.push(S(`S-0${i + 1}`, {
        night: 1, group: 'sills', accepts: 'beam', partId: 'SILL', feature: 'piers',
        p: [m[0], 0.48, m[1]], yaw: Math.atan2(b[1] - a[1], b[0] - a[0]),
        k: 2, sym: 1, f: 4, rated: 180, req: [`P-0${i + 1}`, `P-0${(i + 1) % 6 + 1}`],
        article: '1962-024',
      }));
    }
    return s;
  }

  if (n === 2) {
    // 4 corner posts + 6 wall studs + 4 diagonal braces = 14. G2 lives in `candidateOffset`:
    // the two mirrored braces want the OTHER half of the candidate ring, and the ghost does not
    // say so. Bracket handedness is the whole grammar.
    for (let i = 0; i < 4; i++) {
      s.push(S(CORNER_ID[i], {
        night: 2, group: 'posts', accepts: 'post', partId: 'POST', feature: 'frame',
        p: [CORNER_XZ[i][0], 0.50, CORNER_XZ[i][1]], k: 4, sym: 2, f: 3, rated: 320,
        req: [`S-0${i + 1}`], article: '1953-091',
      }));
    }
    const studXZ = [[-3.5, -FOOT_Z], [3.5, -FOOT_Z], [FOOT_X, 0], [3.5, FOOT_Z], [-3.5, FOOT_Z], [-FOOT_X, 0]];
    for (let i = 0; i < 6; i++) {
      s.push(S(`T-0${i + 1}`, {
        night: 2, group: 'studs', accepts: 'post', partId: 'STUD', feature: 'frame',
        p: [studXZ[i][0], 0.50, studXZ[i][1]], k: 2, sym: 1, f: 2, rated: 180,
        req: [CORNER_ID[i >> 1] || 'C-NW'], article: '1955-108',
      }));
    }
    for (let i = 0; i < 4; i++) {
      const mirrored = i >= 2;
      s.push(S(`B-0${i + 1}`, {
        night: 2, group: 'braces', accepts: 'bracket', partId: 'BRACKET', feature: 'frame',
        p: [CORNER_XZ[i][0] * 0.82, 1.60, CORNER_XZ[i][1] * 0.82], k: 4, sym: 2,
        offset: mirrored ? 2 : 0, mirror: mirrored ? `B-0${i - 1}` : null,
        f: 2, rated: 140, req: [CORNER_ID[i]],
        hw: { id: 'bracket_H', count: 1 }, article: '1955-124',
      }));
    }
    return s;
  }

  if (n === 3) {
    // 6 truss assemblies + 1 over-long ridge beam + 6 ridge pins = 13.
    // G3: two of the trusses want gussets that are in the bag icon and not in the drawing.
    for (let i = 0; i < 6; i++) {
      const z = -FOOT_Z + (i * (FOOT_Z * 2)) / 5;
      s.push(S(`TR-0${i + 1}`, {
        night: 3, group: 'trusses', accepts: 'truss', partId: 'TRUSS', feature: 'roof-skeleton',
        p: [0, 3.05, z], k: 2, sym: 1, f: 2, rated: 260, req: ['C-NW', 'C-NE'],
        hidden: i === 2 || i === 5, hw: (i === 2 || i === 5) ? { id: 'gusset_plate', count: 1 } : null,
        article: '1957-141',
      }));
    }
    s.push(S('RB-01', {
      night: 3, group: 'ridge', accepts: 'ridge', partId: 'RIDGE', feature: 'roof-skeleton',
      p: [0, 4.10, 0], yaw: Math.PI / 2, k: 2, sym: 2, f: 4, rated: 620, cut: 4.80,
      req: ['TR-01', 'TR-02', 'TR-03', 'TR-04', 'TR-05', 'TR-06'], article: '1962-001',
    }));
    for (let i = 0; i < 6; i++) {
      const z = -FOOT_Z + (i * (FOOT_Z * 2)) / 5;
      s.push(S(`RP-0${i + 1}`, {
        night: 3, group: 'ridge-pins', accepts: 'fastener', partId: 'PIN', feature: 'roof-skeleton',
        p: [0, 4.22, z], k: 2, sym: 2, f: 1, rated: 90, req: ['RB-01'], article: '1962-006',
      }));
    }
    return s;
  }

  if (n === 4) {
    // 12 subfloor boards + 3 hinges + 1 door = 16.
    // G4: the manifest is length-ambiguous. Two of the twelve slots want the SHORT board and the
    // rest want the long one; `acceptsType` is length-agnostic by contract, so the wrong board
    // seats and floats, and is not diagnosed until §6.4.1's 90 seconds are up.
    for (let i = 0; i < 12; i++) {
      const short = (i === 4 || i === 9);
      const z = -FOOT_Z + 0.4 + i * ((FOOT_Z * 2 - 0.8) / 11);
      s.push(S(`SF-${String(i + 1).padStart(2, '0')}`, {
        night: 4, group: 'subfloor', accepts: 'board', partId: short ? 'BOARD_12' : 'BOARD_24',
        feature: 'floor-door', p: [0, 0.62, z], k: 2, sym: 1, f: 2, rated: 110,
        req: [`S-0${(i % 6) + 1}`], article: short ? '1961-012' : '1961-024',
      }));
    }
    for (let i = 0; i < 3; i++) {
      s.push(S(`H-0${i + 1}`, {
        night: 4, group: 'hinges', accepts: 'hinge', partId: 'HINGE', feature: 'floor-door',
        p: [-0.45, 0.60 + i * 0.72, FOOT_Z], k: 2, sym: 1, f: 2, rated: 60, req: ['C-SW'],
        hw: i === 2 ? { id: 'hinge_set_brass', count: 1 } : null, article: '1949-003',
      }));
    }
    s.push(S('D-01', {
      night: 4, group: 'door', accepts: 'door', partId: 'DOOR', feature: 'floor-door',
      p: [0, 1.62, FOOT_Z], k: 2, sym: 1, f: 0, rated: 140, req: ['H-01', 'H-02', 'H-03'],
      article: '1953-091',
    }));
    return s;
  }

  if (n === 5) {
    // 1 north wall panel (71 kg, end-lift) + 3 freeform rig anchors + 6 pins = 10.
    // The panel's slot is fixed; the RIG slots are §6.7 physical predicates with no ghost,
    // no highlight and no hint. The manual told you it needs two persons.
    const box = new THREE.Box3(
      new THREE.Vector3(-3.4, -0.2, -FOOT_Z - 2.6),
      new THREE.Vector3(3.4, 3.4, -FOOT_Z + 1.4),
    );
    s.push(S('W-NORTH', {
      night: 5, group: 'wall', accepts: 'panel', partId: 'PANEL_N', feature: 'wall-north',
      p: [0, 1.72, -FOOT_Z + 0.06], k: 2, sym: 2, f: 0, rated: 420,
      req: ['C-NW', 'C-NE'], article: '1962-048',
    }));
    for (let i = 0; i < 3; i++) {
      s.push(S(`RIG-N5-${'ABC'[i]}`, {
        kind: 'freeform', night: 5, group: 'rig', accepts: null, partId: null,
        p: [-2.0 + i * 2.0, 0.0, -FOOT_Z + 0.9], bounds: box,
        goal: {
          type: 'support', target: 'W-NORTH',
          minUpwardForce: TUNING.rigMinUpwardForce,
          minHeight: TUNING.rigMinHeight,
          minDurationSeconds: TUNING.rigMinDuration,
        },
      }));
    }
    for (let i = 0; i < 6; i++) {
      s.push(S(`PN-0${i + 1}`, {
        night: 5, group: 'wall-pins', accepts: 'fastener', partId: 'PIN', feature: 'wall-north',
        p: [-2.4 + i * 0.96, 2.86, -FOOT_Z + 0.10], k: 2, sym: 2, f: 1, rated: 90,
        req: ['W-NORTH'], article: '1962-006',
      }));
    }
    return s;
  }

  if (n === 6) {
    // 8 roof battens + 6 shingle bundles + sink + flue + doorframe = 17. All seven grammars at
    // once, because Night Six is where the manual breaks.
    for (let i = 0; i < 8; i++) {
      s.push(S(`BAT-0${i + 1}`, {
        night: 6, group: 'battens', accepts: 'batten', partId: 'BATTEN', feature: 'roof',
        p: [0, 4.26 - Math.abs(i - 3.5) * 0.12, -FOOT_Z + 0.6 + i * 1.25], k: 2, sym: 1,
        f: 2, rated: 150, req: ['RB-01'], errata: i === 4, article: '1971-008',
      }));
    }
    for (let i = 0; i < 6; i++) {
      const last = i === 5;
      s.push(S(`SHG-0${i + 1}`, {
        night: 6, group: 'shingles', accepts: 'shingle', partId: 'SHINGLE', feature: 'roof',
        p: [-2.4 + i * 0.96, 4.40, 0], k: 4, sym: 4, f: 1, rated: 130,
        req: [`BAT-0${i + 1}`],
        // G7: this one continues on tomorrow's sheet. Leaving it open is CORRECT.
        deferred: last ? { blameSlot: 'RB-01', untilNight: 7 } : null, article: '1971-006',
      }));
    }
    s.push(S('SNK-01', {
      night: 6, group: 'fittings', accepts: 'fitting', partId: 'SINK', feature: 'roof',
      p: [-4.0, 0.72, -3.6], k: 4, sym: 1, f: 2, rated: 90, req: ['SF-01'], article: '1962-001',
    }));
    s.push(S('FLU-01', {
      night: 6, group: 'fittings', accepts: 'fitting', partId: 'FLUE', feature: 'roof',
      p: [3.0, 1.30, -3.6], k: 2, sym: 2, f: 2, rated: 70, req: ['SF-02'], article: '1962-002',
    }));
    s.push(S('DFR-01', {
      night: 6, group: 'fittings', accepts: 'fitting', partId: 'DOORFRAME', feature: 'roof',
      p: [0, 1.06, FOOT_Z - 0.12], k: 2, sym: 1, f: 3, rated: 110, req: ['D-01'],
      // The article that does not exist. It has never existed. DFR-01 can never be Seated, and
      // the manual will go on drawing its little open circle for the rest of the game.
      hw: { id: 'article_0000_000', count: 1 }, article: '0000-000',
    }));
    return s;
  }

  // Night 7 — two chairs, eight slots. Nothing structural remains.
  for (let c = 0; c < 2; c++) {
    const cx = c === 0 ? -1.9 : 1.9;
    const tag = c === 0 ? 'A' : 'B';
    s.push(S(`CHR-${tag}-1`, { night: 7, group: `chair-${tag}`, accepts: 'chair', partId: 'CHAIR_LEG', p: [cx, 0.24, 1.1], k: 4, sym: 2, f: 2, rated: 90, article: '1949-004' }));
    s.push(S(`CHR-${tag}-2`, { night: 7, group: `chair-${tag}`, accepts: 'chair', partId: 'CHAIR_SEAT', p: [cx, 0.46, 1.1], k: 4, sym: 2, f: 2, rated: 90, req: [`CHR-${tag}-1`], article: '1949-001' }));
    s.push(S(`CHR-${tag}-3`, { night: 7, group: `chair-${tag}`, accepts: 'chair', partId: 'CHAIR_BACK', p: [cx, 0.74, 1.3], k: 4, sym: 2, f: 2, rated: 60, req: [`CHR-${tag}-2`], article: '1949-001' }));
    s.push(S(`CHR-${tag}-4`, {
      night: 7, group: `chair-${tag}`, accepts: 'chair', partId: 'CHAIR_ARM', p: [cx, 0.62, 1.1],
      k: 4, sym: 2, f: 2, rated: 60, req: [`CHR-${tag}-3`],
      // The seventh night's shortfall is not an object. It does not gate the seat and it adds no
      // wrongness — the finished house is silent, and that is the point. It is simply short.
      occupant: tag === 'B', article: tag === 'B' ? '0000-000' : '1949-002',
    }));
  }
  return s;
}

/**
 * Pack an authored (topological) slot list into `stageCount` contiguous stages.
 * Contiguity is what guarantees a slot's `requires` are never in a later stage.
 */
function packStages(slots, stageCount) {
  const n = slots.length;
  const k = Math.max(1, Math.min(stageCount | 0 || 1, n));
  for (let i = 0; i < n; i++) slots[i].stage = Math.min(k, 1 + Math.floor((i * k) / n));
  return slots;
}

// =================================================================================================
// Module-scope scratch. Nothing in update()/fixedUpdate() allocates.
// =================================================================================================

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e1 = new THREE.Euler(0, 0, 0, 'YXZ');
const _box = new THREE.Box3();
const _overlap = new Array(48);

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// =================================================================================================

export class BuildSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx?.bus ?? null;
    this.scene = ctx?.scene ?? null;

    // --- night / graph
    this.currentNight = 0;
    this.stageCount = 1;
    this.stage = 1;
    /** @type {Map<string, object>} every slot of nights 1..currentNight — the cabin persists */
    this.slots = new Map();
    /** @type {Array} the current night's slots, in stage order */
    this.nightSlots = [];
    /** @type {Map<string, object>} slotId -> Join (runtime; mirrored into ctx.state.installed) */
    this.joins = new Map();
    /** @type {Array} joins as an array, for allocation-free hot loops */
    this._joinList = [];

    // --- parts
    /** @type {Map<string, object>} every part that exists this night */
    this.parts = new Map();
    /** @type {Array} parts still lying in the pile — the public `available` list */
    this.available = [];
    /** @type {Array} what is in the hands. One class D, or two class C, or four class B. */
    this.heldParts = [];
    this.pocket = { fasteners: 0, shims: 0, tallow: 0, felt: 0, boards: 0 };
    this.toolBelt = ['mallet', 'wrench', 'brace', 'plumb-bob', 'drawknife', 'handsaw'];
    this.shortfalls = [];

    // --- placement
    this.targetSlot = null;
    this.ghostValid = false;
    this._carryYaw = 0;
    this._nearestCandidate = 0;
    this._forceHold = 0;

    // --- the seating check (§6.5)
    this.seating = {
      active: false, slotId: null, p: 0, lo: 0.725, hi: 0.875, centre: TUNING.bandCentre,
      showMeter: false, startedAt: 0,
    };

    // --- creaks
    this.creakDebt = 0;
    this.creakRisk = 0;
    this.lambdaSum = 0;
    this._creakCursor = 0;
    this._cascadeCooldown = 0;
    this._cascadeQueue = [];
    this._cascadeTimer = -1;

    // --- timing / actions
    this._t = 0;                 // build clock: only advances during phase build|chase
    this._elapsed = 0;
    this.action = null;          // { kind, slotId, partId, t, duration, silent }
    this.repairIntent = null;    // what holding E on the current target would do
    this._tapQueue = [];
    for (let i = 0; i < 8; i++) this._tapQueue.push({ live: false, t: 0, n: 0, left: 0, intensity: 0, x: 0, y: 0, z: 0 });
    this._fuses = [];            // PROVOKE delayed creaks
    this._projectiles = [];      // thrown parts
    this._sawGap = 0;

    // --- freeform rig (§6.7)
    this.rig = { active: false, held: 0, force: 0, height: 0, satisfied: false, failedOnce: false, angle: 0, angVel: 0 };

    // --- environment reads
    this._weather = { rain: 0.15, wind: 0.20, fog: 0.0 };
    this._maskLevel = 0;

    // --- input edge tracking (event-timestamped, §6.5 / §4.1)
    this._lmb = false;
    this._lmbWasDown = false;
    this._lmbDownAt = 0;
    this._lmbUpAt = 0;
    this._lmbUpPending = false;
    this._eHold = 0;
    this._qHold = 0;
    this._gHold = 0;

    // --- rendering
    this._group = null;
    this._ghost = null;
    this._ghostMatOk = null;
    this._ghostMatBad = null;
    this._geoCache = new Map();
    this._matCache = new Map();
    this._ownedGeo = [];
    this._ownedMat = [];
    this._handAnchor = null;

    this._unsubs = [];
    this._disposed = false;
    this._rand = new Rand((ctx?.settings?.get?.('seed') ?? 0x51a5cab) ^ 0x8b17d);
    this.script = null;
    this.stats = { evaluated: 0, creaksThisNight: 0, joinsActive: 0 };
  }

  // ------------------------------------------------------------------------------------- init

  async init() {
    // Script is pure data and optional. A dynamic import keeps a missing/broken Script from
    // taking the build puzzle down with it.
    try {
      const mod = await import('../story/Script.js');
      this.script = mod.Script ?? mod.default ?? null;
    } catch (e) {
      this.script = null;
      Log.debug('BuildSystem: Script.js unavailable, using the built-in night table.', e?.message ?? e);
    }

    if (this.scene) {
      this._group = new THREE.Group();
      this._group.name = 'BuildSystem';
      this._group.matrixAutoUpdate = false;
      this.scene.add(this._group);
    }

    this._buildGhost();
    this._buildHandAnchor();

    const on = (ev, fn) => { const u = this.bus?.on?.(ev, fn); if (u) this._unsubs.push(u); };
    on('night:begin', (p) => this.beginNight(p?.night ?? (this.ctx?.state?.night || 1)));
    on('night:complete', () => this._endNight());
    on('night:failed', () => this._endNight());
    on('weather:change', (p) => {
      if (!p) return;
      if (Number.isFinite(p.rain)) this._weather.rain = p.rain;
      if (Number.isFinite(p.wind)) this._weather.wind = p.wind;
      if (Number.isFinite(p.fog)) this._weather.fog = p.fog;
    });
    // Event-timestamped input. The handler runs inside the DOM dispatch, so this is as close to
    // `Input.lastEventTimestamp` as the engine currently offers — a dropped frame costs nothing.
    on('input:mouse', (p) => {
      if (!p || p.button !== 0) return;
      if (p.down) { this._lmbDownAt = now(); this._lmb = true; }
      else { this._lmbUpAt = now(); this._lmbUpPending = this._lmb; this._lmb = false; }
    });

    // If NightManager never fires night:begin (running headless, or it is still a stub), come up
    // on the state's night so the puzzle exists.
    if (this.currentNight === 0) this.beginNight(this.ctx?.state?.night || 1);

    Log.debug(`BuildSystem: night ${this.currentNight}, ${this.nightSlots.length} slots, ` +
      `${this.stageCount} stages, ${this.available.length} parts in the pile.`);
  }

  // -------------------------------------------------------------------------------- getters

  /** The primary part in the hands — the big one, if there is a big one. */
  get heldPart() {
    let best = null;
    for (let i = 0; i < this.heldParts.length; i++) {
      const p = this.heldParts[i];
      if (!best || p.mass > best.mass) best = p;
    }
    return best;
  }

  get installedCount() {
    let n = 0;
    for (let i = 0; i < this.nightSlots.length; i++) if (this.joins.has(this.nightSlots[i].id)) n++;
    return n;
  }

  get slotCount() { return this.nightSlots.length; }

  /** 0..1 across the current night's slots. Deferred slots (G7) count as done when left open. */
  get progress() {
    const total = this.nightSlots.length;
    if (!total) return 0;
    let done = 0;
    for (let i = 0; i < total; i++) {
      const s = this.nightSlots[i];
      if (this.joins.has(s.id)) done++;
      else if (s.deferred) done++;              // leaving it open is correct
      else if (s.kind === 'freeform' && this.rig.satisfied) done++;
    }
    return clamp01(done / total);
  }

  get carrySlotsUsed() {
    let n = 0;
    for (let i = 0; i < this.heldParts.length; i++) n += CARRY_CLASSES[this.heldParts[i].cls]?.slots ?? 0;
    return n;
  }

  /** The heaviest class in the hands — what the body and the camera should read from. */
  get carryClass() {
    let worst = 'A', worstSlots = -1;
    for (let i = 0; i < this.heldParts.length; i++) {
      const c = this.heldParts[i].cls;
      const sl = CARRY_CLASSES[c]?.slots ?? 0;
      if (sl > worstSlots || (sl === worstSlots && (c === 'E' || c === 'endLift'))) { worst = c; worstSlots = sl; }
    }
    return worst;
  }

  get carryMass() {
    let m = 0;
    for (let i = 0; i < this.heldParts.length; i++) m += this.heldParts[i].mass;
    return m;
  }

  /** §6.2 — two class-C parts stack MULTIPLICATIVELY (0.82 x 0.82 = 0.672). Player reads this. */
  get carrySpeedMultiplier() {
    let m = 1;
    for (let i = 0; i < this.heldParts.length; i++) m *= CARRY_CLASSES[this.heldParts[i].cls]?.speed ?? 1;
    return m;
  }

  get carryTurnMultiplier() {
    let m = 1;
    for (let i = 0; i < this.heldParts.length; i++) m *= CARRY_CLASSES[this.heldParts[i].cls]?.turn ?? 1;
    return m;
  }

  get footstepNoiseMultiplier() {
    let m = 1;
    for (let i = 0; i < this.heldParts.length; i++) m = Math.max(m, CARRY_CLASSES[this.heldParts[i].cls]?.footstep ?? 1);
    return m;
  }

  get canCrouch() {
    for (let i = 0; i < this.heldParts.length; i++) if (!CARRY_CLASSES[this.heldParts[i].cls]?.crouch) return false;
    return true;
  }

  get canSprint() {
    for (let i = 0; i < this.heldParts.length; i++) if (!CARRY_CLASSES[this.heldParts[i].cls]?.sprint) return false;
    return true;
  }

  /** §4.3 — class D occludes 28 degrees of the lower frame. You cannot see your feet. */
  get blocksView() {
    const c = this.carryClass;
    return c === 'D' || c === 'endLift' || c === 'E';
  }

  /** Seconds of thunder cover left, telegraphed so the player can plan a 3.0 s ramp + 4 taps. */
  get maskWindowRemaining() {
    const ns = this.ctx?.systems?.get?.('NoiseSystem');
    const w = this.ctx?.systems?.get?.('Weather');
    for (const sys of (ns === w ? [w] : [ns, w])) {
      if (!sys) continue;
      const v = sys.maskWindowRemaining;
      if (typeof v === 'function') { const r = v.call(sys); if (Number.isFinite(r)) return Math.max(0, r); }
      else if (Number.isFinite(v)) return Math.max(0, v);
    }
    // Fallback: infer from the level. A floor is not a window — only a real envelope counts.
    return this.maskLevel > 0.55 ? 1.0 : 0;
  }

  get nextStrikeIn() {
    const w = this.ctx?.systems?.get?.('Weather');
    const v = w?.nextStrikeIn;
    if (typeof v === 'function') { const r = v.call(w); return Number.isFinite(r) ? r : Infinity; }
    return Number.isFinite(v) ? v : Infinity;
  }

  get maskLevel() { return this._maskLevel; }

  // ------------------------------------------------------------------------------ night setup

  /**
   * Stand the cabin up for night `n`. Slots for nights 1..n all exist (the cabin persists and so
   * do its bad joins); only night `n`'s slots count toward `progress` and `stage`.
   */
  beginNight(n) {
    const night = clamp(n | 0 || 1, 1, 7);
    this.currentNight = night;

    const def = this.script?.nightDef?.(night) ?? null;
    const row = NIGHT_TABLE[night - 1];
    this.stageCount = Math.max(1, (def?.stageCount | 0) || row.stages);
    this.stage = 1;

    const site = this.ctx?.systems?.get?.('CabinSite');

    this.slots.clear();
    this.nightSlots.length = 0;
    for (let k = 1; k <= night; k++) {
      let list = null;
      // CabinSite owns the plot when it exists. Accept either a per-night query or a flat list.
      if (site) {
        if (typeof site.slotsForNight === 'function') list = site.slotsForNight(k);
        else if (Array.isArray(site.slots) && site.slots.length) {
          list = site.slots.filter((s) => (s?.night ?? k) === k);
          if (!list.length) list = null;
        }
      }
      if (!list || !list.length) list = packStages(nightSlots(k), (this.script?.nightDef?.(k)?.stageCount | 0) || NIGHT_TABLE[k - 1].stages);
      for (let i = 0; i < list.length; i++) {
        const s = this._normaliseSlot(list[i], k);
        this.slots.set(s.id, s);
        if (k === night) this.nightSlots.push(s);
      }
    }
    this._indexNeighbours();

    // Restore the cabin from the save: a join made badly on Night 2 is still a bad join now.
    this.joins.clear();
    this._joinList.length = 0;
    const saved = this.ctx?.state?.installed;
    if (saved) {
      for (const id of Object.keys(saved)) {
        const slot = this.slots.get(id);
        const rec = saved[id];
        if (!slot || !rec) continue;
        const j = this._makeJoin(slot, rec.partId, rec, null);
        this.joins.set(id, j);
        this._joinList.push(j);
      }
    }

    // Carry 40% of last night's debt (§7.3).
    const carry = this.ctx?.state?.stats?.creakDebtCarry;
    this.creakDebt = Number.isFinite(carry) ? clamp(carry, 0, TUNING.debtMax) : 0;
    this._cascadeCooldown = 0;
    this.stats.creaksThisNight = 0;

    // Weather baseline for the night, until Weather says otherwise (§7.5 mask-floor table).
    this._weather.rain = def?.weatherProfile?.rain ?? row.rain;
    this._weather.wind = def?.weatherProfile?.wind ?? row.wind;

    this._clearParts();
    this._spawnPile(night);
    this._announceShortfalls(night);
    this._recomputeLoads();
    this._rebuildInstalledVisuals();
    this._advanceStage(true);
  }

  /** Accept a foreign Slot (CabinSite's) and fill in every field this file relies on. */
  _normaliseSlot(raw, night) {
    if (!raw) return S('?', { night, p: [0, 0, 0] });
    if (Number.isFinite(raw.px) && raw.acceptsType !== undefined && raw.yawCandidates) return raw;
    const pos = raw.transform?.position ?? raw.position ?? null;
    const s = S(raw.id ?? `X-${this.slots.size}`, {
      night: raw.night ?? night,
      group: raw.group ?? 'misc',
      accepts: raw.acceptsType ?? null,
      partId: raw.partId ?? null,
      p: [pos?.x ?? 0, pos?.y ?? 0, pos?.z ?? 0],
      k: raw.yawCandidates ?? 4,
      sym: raw.symmetryOrder ?? 4,
      offset: raw.candidateOffset ?? 0,
      req: Array.isArray(raw.requires) ? raw.requires : [],
      f: raw.fasteners ?? 0,
      hw: raw.hardware ?? null,
      rated: raw.ratedMass ?? 160,
      mirror: raw.mirrorOf ?? null,
      hidden: raw.hidden, errata: raw.errata, deferred: raw.deferred ?? null,
      obstruction: raw.obstruction ?? null, cut: raw.requiresCut ?? 0,
      feature: raw.feature ?? null, occupant: raw.occupant, bounds: raw.bounds ?? null,
      goal: raw.goal ?? null, article: raw.article ?? null, kind: raw.kind ?? 'fixed',
    });
    s.stage = raw.stage ?? 1;
    if (raw.transform?.quaternion) {
      _e1.setFromQuaternion(raw.transform.quaternion);
      s.yaw = _e1.y;
    }
    return s;
  }

  /** Neighbours = anything joined by `requires`, plus anything within 2.5 m. Compounding (§7.3). */
  _indexNeighbours() {
    const all = [...this.slots.values()];
    for (let i = 0; i < all.length; i++) { all[i].neighbours = []; all[i].dependents = []; }
    const byId = this.slots;
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      for (let r = 0; r < a.requires.length; r++) {
        const b = byId.get(a.requires[r]);
        if (!b) continue;
        if (!a.neighbours.includes(b.id)) a.neighbours.push(b.id);
        if (!b.neighbours.includes(a.id)) b.neighbours.push(a.id);
        if (!b.dependents.includes(a.id)) b.dependents.push(a.id);
      }
    }
    const r2 = TUNING.neighbourRadius * TUNING.neighbourRadius;
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      for (let j = i + 1; j < all.length; j++) {
        const b = all[j];
        const dx = a.px - b.px, dy = a.py - b.py, dz = a.pz - b.pz;
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        if (!a.neighbours.includes(b.id)) a.neighbours.push(b.id);
        if (!b.neighbours.includes(a.id)) b.neighbours.push(a.id);
      }
    }
    // Transitive dependents, for supportedMass. Cheap: 90 slots, once per night.
    for (let i = 0; i < all.length; i++) {
      const seen = new Set();
      const stack = all[i].dependents.slice();
      while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        const s = byId.get(id);
        if (s) for (let d = 0; d < s.dependents.length; d++) stack.push(s.dependents[d]);
      }
      all[i].supportedBy = [...seen];
    }
  }

  // ------------------------------------------------------------------------------- the pile

  /**
   * Spawn exactly the parts the night's manifest consumes (§11.1: "exactly N required — they are
   * the puzzle"), plus the consumables, minus the shortfall. Positions are seeded per §3.3, so
   * two runs of the same seed put the same beam in the same place.
   */
  _spawnPile(night) {
    const rnd = new Rand((hash2(night, 977) * 1e9) | 0);
    const need = new Map();
    for (let i = 0; i < this.nightSlots.length; i++) {
      const s = this.nightSlots[i];
      if (s.kind === 'freeform' || !s.partId || this.joins.has(s.id)) continue;
      need.set(s.partId, (need.get(s.partId) || 0) + 1);
    }

    const short = SHORTFALLS[night] || [];
    const withheld = new Map();
    for (let i = 0; i < short.length; i++) {
      const sh = short[i];
      if (!sh.partId) continue;
      withheld.set(sh.partId, (withheld.get(sh.partId) || 0) + (sh.count || 1));
    }

    const anchors = ['palletA', 'palletB', 'apron'];
    let ai = 0;
    for (const [partId, count] of need) {
      const spec = PART_TYPES[partId];
      if (!spec) continue;
      const hold = withheld.get(partId) || 0;
      const anchor = spec.cls === 'D' || spec.cls === 'endLift' ? MAP.apron : MAP[anchors[ai++ % anchors.length]];
      for (let i = 0; i < count - hold; i++) {
        const a = rnd.range(0, TAU), r = rnd.range(0.6, 2.8);
        this._makePart(partId, anchor[0] + Math.cos(a) * r, anchor[1] + Math.sin(a) * r, rnd);
      }
    }

    // Consumables and spares (§11.1). Deterministic counts, deterministic positions.
    this.pocket.fasteners = TUNING.pocketCap;
    this.pocket.shims = rnd.int(2, 4);
    this.pocket.tallow = rnd.int(1, 2);
    this.pocket.felt = night >= 6 ? 2 : 0;
    this.pocket.boards = rnd.int(2, 3);          // sistering boards, for Recut
    for (let i = 0; i < rnd.int(4, 9); i++) {
      const a = rnd.range(0, TAU), r = rnd.range(4, 30);
      this._makePart('FASTENER_BAG', MAP.palletB[0] + Math.cos(a) * r, MAP.palletB[1] + Math.sin(a) * r, rnd);
    }

    // Night 3's ridge arrives 340 mm over-long and nothing is missing, which is worse.
    if (night === 3) {
      const ridge = [...this.parts.values()].find((p) => p.partId === 'RIDGE');
      if (ridge) { ridge.length = 5.14; ridge.sawProgress = 0; ridge.sawPasses = TUNING.ridgePasses; }
    }

    // The shortfall items themselves, out where §6.9 puts them.
    for (let i = 0; i < short.length; i++) {
      const sh = short[i];
      if (!sh.partId || !sh.at) continue;
      const anchor = MAP[sh.at] || MAP.woodpile;
      for (let c = 0; c < (sh.count || 1); c++) {
        const p = this._makePart(sh.partId, anchor[0] + rnd.range(-2, 2), anchor[1] + rnd.range(-2, 2), rnd);
        if (p) { p.shortfallOf = sh.toolId; p.isShortfall = true; }
      }
    }
  }

  /** Create one part, its mesh, and drop it into `available`. */
  _makePart(partId, x, z, rnd) {
    const spec = PART_TYPES[partId];
    if (!spec) { Log.once(`bs:part:${partId}`, `BuildSystem: unknown partId '${partId}'.`); return null; }
    const id = `${partId}#${this.parts.size}`;
    const y = this._groundAt(x, z);
    const part = {
      id, partId, type: spec.type, name: partId,
      mass: spec.mass, cls: spec.cls, length: spec.length,
      radius: Math.max(0.04, Math.min(spec.dims[1], spec.dims[2]) * 0.5),
      dims: spec.dims, read: spec.read,
      state: 'pile', slotId: null, sawProgress: 0, sawPasses: 0,
      yaw: rnd ? rnd.range(0, TAU) : 0, isShortfall: false, shortfallOf: null,
      object3D: null, home: { x, y, z },
    };
    part.object3D = this._makeMesh(part);
    if (part.object3D) {
      part.object3D.position.set(x, y + spec.dims[1] * 0.5, z);
      part.object3D.rotation.y = part.yaw;
      this._group?.add(part.object3D);
    }
    this.parts.set(id, part);
    this.available.push(part);
    return part;
  }

  /** Prefer CabinSite's generator; otherwise build the silhouette here. */
  _makeMesh(part) {
    const site = this.ctx?.systems?.get?.('CabinSite');
    if (site && typeof site.partMesh === 'function') {
      try {
        const m = site.partMesh(part.partId, part);
        if (m && m.isObject3D) return m;
      } catch (e) { Log.once('bs:partmesh', 'CabinSite.partMesh threw; using the local generator.', e); }
    }
    const spec = PART_TYPES[part.partId];
    if (!spec) return null;
    const geo = this._geometryFor(part.partId, spec);
    const mat = this._materialFor(spec.mat);
    if (!geo || !mat) return null;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = part.id;
    mesh.userData.partId = part.partId;
    return mesh;
  }

  _geometryFor(partId, spec) {
    let g = this._geoCache.get(partId);
    if (g) return g;
    const [dx, dy, dz] = spec.dims;
    switch (spec.shape) {
      case 'truss': {
        // A triangle with webbing: the only silhouette in the game with a HOLE in it.
        const parts = [];
        const chord = new THREE.BoxGeometry(dx, 0.12, dz);
        parts.push(chord.clone().translate(0, -dy * 0.5 + 0.06, 0));
        const rise = Math.hypot(dx * 0.5, dy);
        const left = new THREE.BoxGeometry(rise, 0.10, dz);
        left.rotateZ(Math.atan2(dy, dx * 0.5));
        parts.push(left.clone().translate(-dx * 0.25, 0.02, 0));
        const right = new THREE.BoxGeometry(rise, 0.10, dz);
        right.rotateZ(-Math.atan2(dy, dx * 0.5));
        parts.push(right.clone().translate(dx * 0.25, 0.02, 0));
        parts.push(new THREE.BoxGeometry(0.08, dy * 0.7, dz).translate(0, -0.1, 0));
        g = mergeGeometries(parts);
        chord.dispose(); left.dispose(); right.dispose();
        break;
      }
      case 'bracket': {
        const a = new THREE.BoxGeometry(dx, 0.04, dz).translate(dx * 0.5 - 0.02, 0.02, 0);
        const b = new THREE.BoxGeometry(0.04, dy, dz).translate(0.02, dy * 0.5 - 0.02, 0);
        g = mergeGeometries([a, b]);
        a.dispose(); b.dispose();
        break;
      }
      case 'frame': {
        const l = new THREE.BoxGeometry(0.09, dy, 0.09).translate(-dx * 0.5, 0, 0);
        const r = new THREE.BoxGeometry(0.09, dy, 0.09).translate(dx * 0.5, 0, 0);
        const t = new THREE.BoxGeometry(dx, 0.09, 0.09).translate(0, dy * 0.5, 0);
        g = mergeGeometries([l, r, t]);
        l.dispose(); r.dispose(); t.dispose();
        break;
      }
      case 'pipe':
        g = new THREE.CylinderGeometry(dx * 0.5, dx * 0.5, dy, 8, 1);
        break;
      case 'pin':
        g = new THREE.CylinderGeometry(dx * 0.5, dx * 0.4, dy, 6, 1);
        break;
      case 'door': {
        const leaf = new THREE.BoxGeometry(dx, dy, dz);
        const handle = new THREE.BoxGeometry(0.10, 0.03, 0.05).translate(dx * 0.36, 0, dz);
        g = mergeGeometries([leaf, handle]);
        leaf.dispose(); handle.dispose();
        break;
      }
      default:
        g = new THREE.BoxGeometry(dx, dy, dz);
    }
    if (!g) g = new THREE.BoxGeometry(dx, dy, dz);
    g.computeBoundingBox();
    this._geoCache.set(partId, g);
    this._ownedGeo.push(g);
    return g;
  }

  _materialFor(name) {
    let m = this._matCache.get(name);
    if (m) return m;
    const lib = this.ctx?.systems?.get?.('Materials');
    if (lib && typeof lib.get === 'function') {
      try {
        m = lib.get(name);
        if (m) { this._matCache.set(name, m); return m; }   // library-owned: never disposed here
      } catch { /* fall through to the local material */ }
    }
    const colors = { lumber: 0xb9a07a, plank: 0x6f6350, granite: 0x8d918f, bracket: 0x5a6069, steel: 0x5a6069, nail: 0x4a4038 };
    m = new THREE.MeshStandardMaterial({ color: colors[name] ?? 0x9a8f7c, roughness: 0.78, metalness: name === 'bracket' || name === 'steel' ? 0.9 : 0.0 });
    this._matCache.set(name, m);
    this._ownedMat.push(m);
    return m;
  }

  _buildGhost() {
    if (!this._group) return;
    this._ghostMatOk = new THREE.MeshBasicMaterial({
      color: TUNING.colorGhost, transparent: true, opacity: TUNING.ghostOpacityValid,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    });
    this._ghostMatBad = new THREE.MeshBasicMaterial({
      color: TUNING.colorRed, transparent: true, opacity: TUNING.ghostOpacityBlocked,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    });
    this._ownedMat.push(this._ghostMatOk, this._ghostMatBad);
    const g = new THREE.BoxGeometry(1, 1, 1);
    this._ownedGeo.push(g);
    this._ghost = new THREE.Mesh(g, this._ghostMatOk);
    this._ghost.visible = false;
    this._ghost.renderOrder = 3;
    this._ghost.frustumCulled = false;
    this._group.add(this._ghost);
  }

  /** Where the hands are. Player owns this when Player exists; the camera stands in until then. */
  _buildHandAnchor() {
    const parent = this.ctx?.systems?.get?.('Player')?.handAnchor ?? null;
    if (parent && parent.isObject3D) { this._handAnchor = parent; this._ownsHandAnchor = false; return; }
    const cam = this.ctx?.camera;
    if (!cam) return;
    this._handAnchor = new THREE.Object3D();
    this._handAnchor.name = 'BuildSystem.hands';
    this._handAnchor.position.set(0.30, -0.44, -1.05);
    cam.add(this._handAnchor);
    this._ownsHandAnchor = true;
  }

  // --------------------------------------------------------------------------------- the loop

  update(dt, elapsed) {
    if (this._disposed) return;
    this._elapsed = elapsed || 0;

    const phase = this.ctx?.state?.phase;
    const building = phase === 'build' || phase === 'chase' || phase === undefined;
    const d = Math.min(dt || 0, 0.1);
    if (building) this._t += d;

    this._sampleMask();
    this._updateSnap();      // before input, so a place acts on THIS frame's ghost
    this._pollInput(d);
    this._updateSeating();
    this._updateAction(d);
    this._updateTaps(d);
    this._updateFuses(d);
    this._updateRig(d);

    if (building) this._updateCreaks(d);

    this.stats.joinsActive = this._joinList.length;
  }

  fixedUpdate(fdt) {
    if (this._disposed) return;
    this._simulateCarried(fdt);
    this._simulateProjectiles(fdt);
  }

  resize(_w, _h) { /* no resolution-dependent state */ }

  // ------------------------------------------------------------------------------------ input

  _pollInput(dt) {
    const input = this.ctx?.systems?.get?.('Input');
    if (!input) return;

    // E — context sensitive: pick up, pull the stake, top up, shim, recut, or provoke.
    if (input.isDown?.('interact')) this._eHold += dt; else this._eHold = 0;
    if (input.wasPressed?.('interact')) this._onInteractPressed();
    if (input.wasReleased?.('interact')) this._onInteractReleased();
    if (this._eHold > 0) this._onInteractHeld(this._eHold);

    // Q — tap drops (instant, loud); hold 2.1 s sets down (silent). §10.3.
    if (input.isDown?.('drop')) {
      this._qHold += dt;
      if (this._qHold >= TUNING.setDownSeconds && this.heldParts.length) { this.setDownHeld(); this._qHold = -1e9; }
    } else {
      if (this._qHold > 0 && this._qHold < TUNING.setDownSeconds) this.dropHeld();
      this._qHold = 0;
    }

    // G — throw. Holding charges it; releasing lets go. See conflict note 3.
    if (input.isDown?.('throwPart')) {
      this._gHold = Math.min(this._gHold + dt, 1.2);
    } else if (this._gHold > 0) {
      this.throwHeld(0.45 + 0.55 * clamp01(this._gHold / 1.2));
      this._gHold = 0;
    }

    if (input.wasPressed?.('rotateCW')) this.rotateHeld(1);
    if (input.wasPressed?.('rotateCCW')) this.rotateHeld(-1);

    // LMB — place / seating check / force-place / saw pass.
    const lmb = this._lmb || !!input.mouse?.left;
    const lmbEdge = lmb && !this._lmbWasDown;
    this._lmbWasDown = lmb;
    if (lmb) {
      if (lmbEdge && !this.seating.active && !this.action) this.beginPlace();
      else if (this.action?.kind === 'saw') this._sawHold(dt);
      else if (!this.seating.active && this.targetSlot && !this.ghostValid) this._forceHold += dt;
      if (this._forceHold >= TUNING.forcePlaceHold) { this._forcePlace(); this._forceHold = -1e9; }
    } else {
      this._forceHold = 0;
      if (this.seating.active) this._releaseSeating();
      if (this._lmbUpPending) this._lmbUpPending = false;
    }
  }

  _onInteractPressed() {
    // Priority: the thing under the reticle. A part in the pile beats a slot, because you cannot
    // repair a join with your hands full anyway.
    const part = this._bestPart();
    if (part && this.pickUp(part)) return;
    const slot = this._bestSlot();
    if (!slot) return;
    if (slot.obstruction) { this.removeObstruction(slot.id); return; }
    const join = this.joins.get(slot.id);
    if (join && this._repairFor(join) === 'top-up') this.topUpFasteners(slot.id);
  }

  _onInteractHeld(held) {
    if (this.action) return;
    const slot = this._bestSlot();
    if (!slot) { this.repairIntent = null; return; }
    const join = this.joins.get(slot.id);
    if (!join) { this.repairIntent = null; return; }
    const intent = this._repairFor(join);
    this.repairIntent = intent;
    if (intent === 'shim' && held >= TUNING.shimSeconds * 0.5) this.applyShim(slot.id);
    else if (intent === 'recut' && held >= 1.2) this.beginRecut(slot.id);
    else if (intent === 'felt' && held >= 1.2) this.applyFelt(slot.id);
    else if (intent === 'tallow' && held >= 1.2) this.applyTallow(slot.id);
  }

  _onInteractReleased() {
    // PROVOKE (§9.6): 1.6 s arms it, and every millisecond past that lengthens the fuse. This is
    // the only distraction verb in the game and it is a construction verb.
    const held = this._eHold;
    this._eHold = 0;
    if (held < TUNING.provokeArm || this.action) return;
    const slot = this._bestSlot();
    if (!slot) return;
    const join = this.joins.get(slot.id);
    if (!join || this._repairFor(join) !== 'provoke') return;
    this.provoke(slot.id, held);
  }

  /** The part in the pile you are looking at, within reach. No raycast — proximity plus a cone. */
  _bestPart() {
    const eye = this._eye(_v1);
    this._forward(_fwd);
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < this.available.length; i++) {
      const p = this.available[i];
      if (p.state !== 'pile' && p.state !== 'dropped') continue;
      const o = p.object3D;
      if (!o) continue;
      _v2.copy(o.position).sub(eye);
      const dist = _v2.length();
      if (dist > TUNING.pickupReach + 0.6) continue;
      _v2.multiplyScalar(1 / Math.max(dist, 1e-4));
      const dot = _v2.dot(_fwd);
      if (dot < TUNING.interactDot) continue;
      const score = dot * 2 - dist * 0.35;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  /** The slot you are looking at, within reach. */
  _bestSlot() {
    const eye = this._eye(_v1);
    this._forward(_fwd);
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < this.nightSlots.length; i++) {
      const s = this.nightSlots[i];
      _v2.set(s.px, s.py, s.pz).sub(eye);
      const dist = _v2.length();
      if (dist > TUNING.placeReach + 1.4) continue;
      _v2.multiplyScalar(1 / Math.max(dist, 1e-4));
      const dot = _v2.dot(_fwd);
      if (dot < TUNING.interactDot) continue;
      const score = dot * 2 - dist * 0.3;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    // Older nights' joins are still repairable — that is the redemption loop.
    if (!best) {
      for (const s of this.slots.values()) {
        if (!this.joins.has(s.id)) continue;
        _v2.set(s.px, s.py, s.pz).sub(eye);
        const dist = _v2.length();
        if (dist > TUNING.placeReach + 1.4) continue;
        _v2.multiplyScalar(1 / Math.max(dist, 1e-4));
        const dot = _v2.dot(_fwd);
        if (dot < TUNING.interactDot) continue;
        const score = dot * 2 - dist * 0.3;
        if (score > bestScore) { bestScore = score; best = s; }
      }
    }
    return best;
  }

  // --------------------------------------------------------------------------- snap and ghost

  /**
   * §6.3 / §6.4.2. The carried part ghosts into the slot inside 0.65 m. The yaw snaps to the
   * NEAREST OF k CANDIDATES and the ghost renders IDENTICALLY for every one of them — a correct
   * candidate and an incorrect candidate look exactly the same. The only tell is the part: a
   * chamfer, a bolt pattern, a pencil mark, readable at 2.2 m under the lantern and not beyond.
   */
  _updateSnap() {
    const part = this.heldPart;
    if (!part || this.seating.active || this.action) {
      if (!this.seating.active) this._showGhost(null, false);
      return;
    }

    const pos = part.object3D ? part.object3D.position : this._eye(_v3);
    let best = null, bestD = TUNING.snapRadius;
    for (let i = 0; i < this.nightSlots.length; i++) {
      const s = this.nightSlots[i];
      if (this.joins.has(s.id) || s.kind === 'freeform') continue;
      const dx = s.px - pos.x, dy = s.py - pos.y, dz = s.pz - pos.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < bestD) { bestD = d; best = s; }
    }
    this.targetSlot = best;
    if (!best) { this._showGhost(null, false); this._nearestCandidate = 0; return; }

    const k = Math.max(1, best.yawCandidates | 0);
    const step = TAU / k;
    let rel = this._carryYaw - best.yaw;
    rel = ((rel % TAU) + TAU) % TAU;
    this._nearestCandidate = Math.round(rel / step) % k;

    const typeOk = !best.acceptsType || best.acceptsType === part.type;
    const depsOk = this._dependenciesMet(best);
    const cutOk = !best.requiresCut || (part.sawProgress ?? 0) >= 1;
    this.ghostValid = typeOk && depsOk && cutOk && !best.obstruction;
    this._showGhost(best, this.ghostValid);
  }

  _dependenciesMet(slot) {
    if (!slot.requires?.length) return true;
    for (let i = 0; i < slot.requires.length; i++) {
      const j = this.joins.get(slot.requires[i]);
      if (!j || j.torque < 0.5) return false;    // §6.3: filled AND torque >= 0.5
    }
    return true;
  }

  _showGhost(slot, valid) {
    const site = this.ctx?.systems?.get?.('CabinSite');
    if (site && typeof site.showGhost === 'function') {
      try {
        site.showGhost(slot ? slot.id : null, slot ? (this.heldPart?.partId ?? null) : null, !!valid);
        if (this._ghost) this._ghost.visible = false;
        return;
      } catch (e) { Log.once('bs:ghost', 'CabinSite.showGhost threw; drawing the local ghost.', e); }
    }
    const g = this._ghost;
    if (!g) return;
    if (!slot) { g.visible = false; return; }
    const spec = PART_TYPES[this.heldPart?.partId] ?? null;
    const d = spec?.dims ?? [0.5, 0.5, 0.5];
    g.position.set(slot.px, slot.py, slot.pz);
    // The offset a Rotated dependency inherits, so an error compounds VISIBLY down the graph.
    const inherited = this._inheritedOffsetMm(slot) / 1000;
    g.position.x += inherited;
    g.scale.set(d[0] * 1.03 + 0.02, d[1] * 1.03 + 0.02, d[2] * 1.03 + 0.02);
    g.rotation.set(0, slot.yaw + (TAU / Math.max(1, slot.yawCandidates)) * this._nearestCandidate, 0);
    g.material = valid ? this._ghostMatOk : this._ghostMatBad;
    g.visible = true;
  }

  _inheritedOffsetMm(slot) {
    let mm = 0;
    for (let i = 0; i < (slot.requires?.length || 0); i++) {
      const j = this.joins.get(slot.requires[i]);
      if (j && j.outcome === OUTCOMES.ROTATED) mm += TUNING.rotatedOffsetMm;
    }
    return mm;
  }

  // -------------------------------------------------------------------------- the seating check

  /**
   * §6.5. `p` ramps LINEARLY 0 -> 1 over 3.0 s. The green band is centred at 0.80 with a
   * half-width by difficulty: 900 / 450 / 330 ms of window. `p` is computed from the pointer
   * event timestamp, not the frame in which it was processed — a dropped frame costs nothing.
   *
   * There is NO on-screen meter above `story`. `seating.showMeter` says so; the feedback is the
   * ratchet, whose pitch rises with `p`, and the player who learns the sound is rewarded for it.
   */
  beginPlace() {
    if (this.seating.active || this.action) return false;
    const part = this.heldPart;
    const slot = this.targetSlot;
    if (!part || !slot || !this.ghostValid) return false;
    return this._beginSeating(slot, part);
  }

  cancelPlace() {
    if (!this.seating.active) return;
    this.seating.active = false;
    this.seating.slotId = null;
    this.seating.p = 0;
  }

  _beginSeating(slot, part) {
    const diff = this.ctx?.settings?.get?.('difficulty') ?? 'standard';
    const h = TUNING.bandHalfWidth[diff] ?? TUNING.bandHalfWidth.standard;
    const s = this.seating;
    s.active = true;
    s.slotId = slot.id;
    s.partId = part.id;
    s.p = 0;
    s.centre = TUNING.bandCentre;
    s.lo = TUNING.bandCentre - h;
    s.hi = TUNING.bandCentre + h;
    s.showMeter = diff === 'story' || !!this.ctx?.settings?.get?.('puzzleHints');
    s.startedAt = this._lmbDownAt > 0 ? this._lmbDownAt : now();
    this._sfx('screw.torque', slot, 0.5, 1.0);
    return true;
  }

  _updateSeating() {
    const s = this.seating;
    if (!s.active) return;
    const t = ((this._lmb ? now() : this._lmbUpAt) - s.startedAt) / 1000;
    s.p = clamp01(t / TUNING.rampSeconds);
    // The ratchet climbs with p. This is the whole feedback channel above `story` difficulty.
    if (s.p > 0 && Math.floor(s.p * 12) !== this._lastRatchet) {
      this._lastRatchet = Math.floor(s.p * 12);
      const slot = this.slots.get(s.slotId);
      this._sfx('ui.click', slot, 0.18, 0.85 + 0.5 * s.p);
    }
    if (s.p >= 1 && !this._lmb) this._releaseSeating();
  }

  _releaseSeating() {
    const s = this.seating;
    if (!s.active) return;
    const slot = this.slots.get(s.slotId);
    const part = this.heldParts.find((p) => p.id === s.partId) ?? this.heldPart;
    // Release time comes from the mouseup EVENT, not this frame. §4.1's 120 ms budget.
    const t = ((this._lmbUpAt || now()) - s.startedAt) / 1000;
    const p = clamp01(t / TUNING.rampSeconds);
    s.active = false;
    s.p = p;
    if (!slot || !part) return;

    let torque, band, split = false;
    if (p < s.lo) { torque = p * TUNING.torqueUnder; band = 'under'; }
    else if (p <= s.hi) { torque = 1.0; band = 'perfect'; }
    else if (p <= TUNING.overTorqueCeiling) { torque = TUNING.torqueOver; band = 'over'; }
    else { torque = TUNING.torqueSplit; band = 'split'; split = true; }

    this._install(slot, part, torque, band, split, false);
  }

  /** §6.4: the ghost refuses; the player holds place for 3.0 s and the wood splits. */
  _forcePlace() {
    const part = this.heldPart;
    const slot = this.targetSlot;
    if (!part || !slot || this.ghostValid) return;
    if (this.joins.has(slot.id)) return;
    this._install(slot, part, TUNING.torqueSplit, 'split', true, true);
  }

  /** Queue the hammer taps for a release band. Every tap is a discrete 34 m broadcast (§6.5). */
  _queueTaps(band, slot) {
    const plan = TUNING.tapPlan[band] ?? TUNING.tapPlan.perfect;
    for (let i = 0; i < this._tapQueue.length; i++) {
      const q = this._tapQueue[i];
      if (q.live) continue;
      q.live = true; q.t = 0; q.n = 0; q.left = plan[0]; q.intensity = plan[1];
      q.x = slot.px; q.y = slot.py; q.z = slot.pz;
      return;
    }
  }

  _updateTaps(dt) {
    for (let i = 0; i < this._tapQueue.length; i++) {
      const q = this._tapQueue[i];
      if (!q.live) continue;
      q.t -= dt;
      if (q.t > 0) continue;
      q.t = TUNING.tapInterval;
      q.left--;
      this._noise('hammer', q.x, q.y, q.z, TUNING.tapRadius, q.intensity);
      this.bus?.emit('audio:sfx', {
        id: 'hammer.wood', position: new THREE.Vector3(q.x, q.y, q.z),
        volume: 0.6 + 0.4 * q.intensity, rate: 1.0 + 0.04 * q.n,
      });
      q.n++;
      if (q.left <= 0) q.live = false;
    }
  }

  // --------------------------------------------------------------------------------- carrying

  /**
   * §6.2. Four part slots and a separate three-capacity tool belt. One class D, or two class C,
   * or four class B. Class A goes in the pocket and costs no slot. The tool roll is never a slot,
   * because that choice produced two round trips per structural part.
   */
  pickUp(partOrId) {
    const part = typeof partOrId === 'string' ? (this.parts.get(partOrId) ?? this._partByPartId(partOrId)) : partOrId;
    if (!part || (part.state !== 'pile' && part.state !== 'dropped')) return false;

    const cls = CARRY_CLASSES[part.cls] ?? CARRY_CLASSES.C;
    if (cls.slots === 0) {
      // Pocket items. A fastener bag is 12 loose ones (§6.6).
      const spec = PART_TYPES[part.partId];
      if (part.type === 'fastener') {
        const add = spec?.holds ?? 1;
        if (this.pocket.fasteners >= TUNING.pocketCap) return false;
        this.pocket.fasteners = Math.min(TUNING.pocketCap, this.pocket.fasteners + add);
      } else if (part.type === 'shim') this.pocket.shims++;
      else if (part.type === 'tallow') this.pocket.tallow++;
      else if (part.type === 'felt') this.pocket.felt++;
      this._consume(part);
      this._onPickup(part);
      return true;
    }

    if (this.carrySlotsUsed + cls.slots > TUNING.partSlots) return false;

    part.state = 'held';
    this.heldParts.push(part);
    const idx = this.available.indexOf(part);
    if (idx >= 0) this.available.splice(idx, 1);
    this._carryYaw = 0;
    this._physics()?.releaseCarried?.(part);
    this._onPickup(part);
    return true;
  }

  _onPickup(part) {
    const st = this.ctx?.state;
    if (st?.stats) st.stats.partsCarried = (st.stats.partsCarried | 0) + 1;
    if (st?.inventory && !st.inventory.includes(part.partId)) st.inventory.push(part.partId);
    this.bus?.emit('build:pickup', { part });

    // §6.9: on finding the shortfall, `tool:found`, one clean bell, and an empty checkbox filling
    // in. No words. That is the whole reward.
    if (part.isShortfall && part.shortfallOf) {
      const sh = this.shortfallInfo(part.shortfallOf);
      if (sh && !sh.found) {
        sh.found = true;
        if (this.ctx?.state?.toolsFound && !this.ctx.state.toolsFound.includes(part.shortfallOf)) {
          this.ctx.state.toolsFound.push(part.shortfallOf);
        }
        this.bus?.emit('tool:found', { toolId: part.shortfallOf });
        this.bus?.emit('audio:sfx', { id: 'hardware_chime', volume: 0.7 });
        this.bus?.emit('ui:toast', { text: '', icon: 'checkbox-filled', ms: 1600 });
        if (part.shortfallOf === 'shim_plate_1961') this.ctx?.state?.flag?.('foundShim');
        if (part.shortfallOf === 'hinge_set_brass') this.ctx?.state?.flag?.('stoleHinges');
      }
    }
  }

  /** Q tap. Instant and loud (§10.3). Under pressure, everyone drops. */
  dropHeld() {
    const part = this.heldPart;
    if (!part) return false;
    this._release(part, true);
    return true;
  }

  /** Q held 2.1 s. Silent. The difference between the two is the whole verb. */
  setDownHeld() {
    const part = this.heldPart;
    if (!part) return false;
    this._release(part, false);
    return true;
  }

  _release(part, loud) {
    const idx = this.heldParts.indexOf(part);
    if (idx >= 0) this.heldParts.splice(idx, 1);
    part.state = 'dropped';
    this.available.push(part);
    const o = part.object3D;
    if (o) o.position.y = this._groundAt(o.position.x, o.position.z) + (part.dims[1] * 0.5);
    this._physics()?.releaseCarried?.(part);
    this.bus?.emit('build:drop', { part });
    if (loud && o) {
      const row = TUNING.dropNoise[part.cls] ?? TUNING.dropNoise.C;
      this._noise('drop', o.position.x, o.position.y, o.position.z, row[0], row[1]);
      this.bus?.emit('audio:sfx', {
        id: part.cls === 'B' || part.cls === 'A' ? 'bracket.drop.rock' : 'lumber.drop',
        position: o.position.clone(), volume: row[1],
        rate: 0.9 + 0.3 * (1 - clamp01(part.mass / 70)),
      });
    }
  }

  /**
   * Throw. Class A and B only — you are a carpenter, not a catapult. It flies a real arc and
   * lands with a canonical `drop` noise at the landing point, which will pull a camper, and it
   * costs you a piece of hardware the stage manifest is still counting. See conflict note 3:
   * PROVOKE is the design's decoy verb, and it is better, and this is here because the key is
   * bound and because a thrown bracket is a thing a person can physically do.
   */
  throwHeld(power = 1) {
    const part = this.heldPart;
    if (!part) return false;
    if (part.mass > TUNING.throwMaxMass) { this.dropHeld(); return false; }

    const idx = this.heldParts.indexOf(part);
    if (idx >= 0) this.heldParts.splice(idx, 1);
    part.state = 'thrown';
    this._physics()?.releaseCarried?.(part);

    this._forward(_fwd);
    const speed = TUNING.throwSpeed * clamp(power, 0.2, 1.2);
    const o = part.object3D;
    if (o) this._eye(o.position).addScaledVector(_fwd, 0.6);
    this._projectiles.push({
      part,
      vx: _fwd.x * speed,
      vy: (_fwd.y + TUNING.throwLoft) * speed,
      vz: _fwd.z * speed,
      spin: this._rand.range(-9, 9),
      life: 0,
    });
    this.bus?.emit('build:drop', { part });
    return true;
  }

  _simulateProjectiles(fdt) {
    if (!this._projectiles.length) return;
    for (let i = this._projectiles.length - 1; i >= 0; i--) {
      const p = this._projectiles[i];
      const o = p.part.object3D;
      p.life += fdt;
      p.vy += TUNING.throwGravity * fdt;
      if (o) {
        o.position.x += p.vx * fdt;
        o.position.y += p.vy * fdt;
        o.position.z += p.vz * fdt;
        o.rotation.z += p.spin * fdt;
      }
      const x = o ? o.position.x : 0, z = o ? o.position.z : 0;
      const ground = this._groundAt(x, z) + p.part.dims[1] * 0.5;
      const landed = (p.life > 0.10 && (o ? o.position.y : 0) <= ground) || p.life > 6;
      if (!landed) continue;
      if (o) o.position.y = ground;
      p.part.state = 'dropped';
      this.available.push(p.part);
      this._projectiles.splice(i, 1);
      // The landing point is the noise. That is the mechanic: you chose where a camper goes.
      const speed = Math.hypot(p.vx, p.vy, p.vz);
      const inten = clamp01(TUNING.throwLandIntensity * (0.55 + 0.45 * clamp01(speed / 14)));
      this._noise('drop', x, ground, z, TUNING.throwLandRadius, inten);
      this.bus?.emit('audio:sfx', {
        id: 'bracket.drop.rock', position: new THREE.Vector3(x, ground, z),
        volume: inten, rate: 0.95 + this._rand.range(-0.06, 0.06),
      });
    }
  }

  /** R / T. Free yaw; the SNAP still picks the nearest of k, and the ghost never tells you which. */
  rotateHeld(dir) {
    if (!this.heldPart) return;
    this._carryYaw += (dir >= 0 ? 1 : -1) * TUNING.rotateStepDeg * Math.PI / 180;
    this._carryYaw = ((this._carryYaw % TAU) + TAU) % TAU;
  }

  /** Hands lag and swing and clatter into trees. Physics owns the sim; we own the hand anchor. */
  _simulateCarried(fdt) {
    const phys = this._physics();
    if (!this.heldParts.length) return;
    const anchor = this._handAnchor;
    for (let i = 0; i < this.heldParts.length; i++) {
      const part = this.heldParts[i];
      const o = part.object3D;
      if (!o) continue;
      if (phys && anchor && typeof phys.simulateCarried === 'function') {
        // Physics writes the resolved world transform onto the part's Object3D and emits the
        // impact noises itself (radius 18, kind 'impact') — hauling IS the risk.
        phys.simulateCarried(part, anchor, fdt);
        o.rotation.y += 0;    // yaw offset is applied through the anchor, below
      } else if (anchor) {
        anchor.updateWorldMatrix(true, false);
        anchor.getWorldPosition(_v1);
        anchor.getWorldQuaternion(_q1);
        o.position.lerp(_v1, Math.min(1, fdt * 12));
        o.quaternion.slerp(_q1, Math.min(1, fdt * 10));
      }
      if (i === 0 && anchor) anchor.rotation.y = this._carryYaw;
    }
  }

  // ------------------------------------------------------------------- correctness (§6.4)

  /**
   * Resolve a placement into exactly one of the five outcomes. `correct` in `build:place` is true
   * only for SEATED.
   *
   *   SEATED          right type, right partId, yaw in a correct candidate, fasteners sufficient
   *   UNDER-FASTENED  as Seated, but held < required. Torque capped. Fully repairable.
   *   ROTATED         right part, right slot, yaw in one of the k − symmetryOrder wrong candidates
   *   WRONG SLOT      right type, wrong partId. Silent for 90 s (§6.4.1). This is the reading error.
   *   WRONG PART      wrong type, forced through a 3.0 s hold. The wood splits.
   */
  _evaluate(slot, part, forced) {
    if (!slot || !part) return { outcome: OUTCOMES.WRONG_PART, w: TUNING.wWrongPart, ratio: 0 };
    const typeOk = !slot.acceptsType || slot.acceptsType === part.type;
    if (!typeOk || forced) {
      return { outcome: OUTCOMES.WRONG_PART, w: TUNING.wWrongPart, ratio: 1 };
    }

    // Hardware and pocket fasteners are counted together against the same requirement (note 5).
    const needF = slot.fasteners | 0;
    const needH = slot.hardware?.count | 0;
    const haveF = Math.min(needF, this.pocket.fasteners);
    const haveH = this._hasHardware(slot.hardware) ? needH : 0;
    const need = needF + needH;
    const have = haveF + haveH;
    const ratio = need > 0 ? have / need : 1;

    if (slot.partId && part.partId !== slot.partId) {
      return { outcome: OUTCOMES.WRONG_SLOT, w: TUNING.wWrongSlot, ratio };
    }

    const k = Math.max(1, slot.yawCandidates | 0);
    const sym = clamp(slot.symmetryOrder | 0 || k, 1, k);
    const off = slot.candidateOffset | 0;
    const rel = ((this._nearestCandidate - off) % k + k) % k;
    if (rel >= sym) return { outcome: OUTCOMES.ROTATED, w: TUNING.wRotated, ratio };

    if (ratio < 1) {
      return { outcome: OUTCOMES.UNDER_FASTENED, w: TUNING.wUnderFastened * (1 - ratio), ratio };
    }
    return { outcome: OUTCOMES.SEATED, w: 0, ratio };
  }

  _hasHardware(hw) {
    if (!hw) return true;
    // The shortfall item has to have been found and carried in. `article_0000_000` never can be.
    const sh = this.shortfallInfo(hw.id);
    if (sh) return !!sh.found;
    return true;
  }

  /** Seat a part into a slot and record the join. This is where the game's memory is written. */
  _install(slot, part, torque, band, split, forced) {
    if (!slot || !part) return null;
    if (this.joins.has(slot.id)) return null;

    const evalr = this._evaluate(slot, part, forced);
    let w = evalr.w;

    // G6: building a step as printed, without the errata slip, caps the join at w = 0.35.
    if (slot.errata && !this._flag('foundErrata') && w < TUNING.wErrataCap) w = TUNING.wErrataCap;
    // G7: filling a slot the manual deferred to tomorrow's sheet is a 1.0 on the ridge, not here.
    if (slot.deferred) {
      const blame = this.joins.get(slot.deferred.blameSlot);
      if (blame) { blame.w = Math.max(blame.w, TUNING.wWrongPart); this._syncJoin(blame); }
      w = Math.max(w, TUNING.wWrongPart);
    }

    // §6.4: Under-fastened caps torque at 0.5 + 0.5 * (held/required).
    let t = clamp01(torque);
    if (evalr.outcome === OUTCOMES.UNDER_FASTENED) t = Math.min(t, 0.5 + 0.5 * evalr.ratio);

    // Consume the hardware. The manual will keep drawing the open circles either way.
    const needF = slot.fasteners | 0;
    this.pocket.fasteners = Math.max(0, this.pocket.fasteners - Math.min(needF, this.pocket.fasteners));

    const join = this._makeJoin(slot, part.partId, {
      partId: part.partId, correct: evalr.outcome === OUTCOMES.SEATED, torque: t,
      w, outcome: evalr.outcome, fastenerRatio: evalr.ratio, split: !!split,
      candidate: this._nearestCandidate,
    }, part);
    this.joins.set(slot.id, join);
    this._joinList.push(join);

    // Take it out of the hands and stand it in the slot.
    const idx = this.heldParts.indexOf(part);
    if (idx >= 0) this.heldParts.splice(idx, 1);
    part.state = 'placed';
    part.slotId = slot.id;
    this._physics()?.releaseCarried?.(part);
    this._seatVisual(join);
    this._registerCollider(join);
    this._recomputeLoads();
    this.stats.evaluated++;

    // Feedback, §6.4's table. A hollow thunk is the same sample, faster, quieter, shorter-tailed.
    if (split) {
      this.bus?.emit('audio:sfx', { id: 'join_split', position: this._slotVec(slot), volume: 1.0 });
      this._noise('impact', slot.px, slot.py, slot.pz, 30, 0.60);
    } else if (evalr.outcome === OUTCOMES.UNDER_FASTENED) {
      this.bus?.emit('audio:sfx', { id: 'join_seat', position: this._slotVec(slot), volume: 0.63, rate: 1.18 });
    } else {
      this.bus?.emit('audio:sfx', { id: 'join_seat', position: this._slotVec(slot), volume: 1.0, rate: 1.0 });
    }
    if (!forced) this._queueTaps(band, slot);

    if (evalr.outcome === OUTCOMES.SEATED && band === 'perfect') {
      const st = this.ctx?.state;
      if (st?.stats) st.stats.perfectJoins = (st.stats.perfectJoins | 0) + 1;
    }

    this.bus?.emit('build:place', { part, slot, correct: evalr.outcome === OUTCOMES.SEATED });
    this._worldChanged(slot);
    this._advanceStage(false);
    return join;
  }

  /** The serializable record plus its runtime fields. `ctx.state.installed` is the save file. */
  _makeJoin(slot, partId, rec, part) {
    const j = {
      slotId: slot.id,
      slot,
      part: part ?? null,
      partId: partId ?? rec?.partId ?? null,
      night: slot.night,
      correct: !!rec?.correct,
      torque: Number.isFinite(rec?.torque) ? rec.torque : 1,
      w: Number.isFinite(rec?.w) ? rec.w : 0,
      outcome: rec?.outcome ?? (rec?.correct ? OUTCOMES.SEATED : OUTCOMES.UNDER_FASTENED),
      fastenerRatio: Number.isFinite(rec?.fastenerRatio) ? rec.fastenerRatio : 1,
      split: !!rec?.split,
      candidate: rec?.candidate | 0,
      age: Number.isFinite(rec?.age) ? rec.age : 0,
      supportedMass: 0,
      lambda: 0,
      nextTick: this._rand.range(0, TUNING.creakTickSeconds),   // stagger from birth
      shimmed: !!rec?.shimmed,
      felted: !!rec?.felted,
      tallowUntil: 0,
      recutProgress: Number.isFinite(rec?.recutProgress) ? rec.recutProgress : 0,
      collider: -1,
    };
    this._syncJoin(j);
    return j;
  }

  _syncJoin(j) {
    const st = this.ctx?.state;
    if (!st?.installed) return;
    // ARCHITECTURE §8 names partId / correct / torque. The rest is what makes a bad Night-2 join
    // still a bad join on Night 5 — plain serializable data, no Three.js objects.
    st.installed[j.slotId] = {
      partId: j.partId, correct: j.correct, torque: j.torque,
      w: j.w, outcome: j.outcome, night: j.night, age: j.age,
      fastenerRatio: j.fastenerRatio, split: j.split, candidate: j.candidate,
      shimmed: j.shimmed, felted: j.felted, recutProgress: j.recutProgress,
    };
  }

  /** L = supportedMass / ratedMass. Adding weight above a join is what makes it speak. */
  _recomputeLoads() {
    for (let i = 0; i < this._joinList.length; i++) {
      const j = this._joinList[i];
      let m = 0;
      const sup = j.slot.supportedBy || [];
      for (let k = 0; k < sup.length; k++) {
        const other = this.joins.get(sup[k]);
        if (other) m += PART_TYPES[other.partId]?.mass ?? 0;
      }
      j.supportedMass = m;
    }
  }

  // -------------------------------------------------------------------------- repairs (§7.4)

  /** What holding E on this join would do. One verb at a time, so the prompt is never a menu. */
  _repairFor(join) {
    if (!join) return null;
    if (join.outcome === OUTCOMES.UNDER_FASTENED && this.pocket.fasteners > 0 && this._hasHardware(join.slot.hardware)) return 'top-up';
    if (join.w >= 0.20 && this.pocket.boards > 0) return 'recut';
    if (join.torque < 0.85 && this.pocket.shims > 0 && !join.shimmed) return 'shim';
    if (this.currentNight >= 6 && this.pocket.felt > 0 && !join.felted && join.w > 0) return 'felt';
    if (this.pocket.tallow > 0 && join.lambda > 0.4) return 'tallow';
    if (join.w < TUNING.provokeRefuseW && this.currentNight !== 7) return 'provoke';
    return null;
  }

  /** 3.0 s, silent, and `w` goes to 0. The only fully forgiving repair in the game (§6.6). */
  topUpFasteners(slotId) {
    const j = this.joins.get(slotId);
    if (!j || j.outcome !== OUTCOMES.UNDER_FASTENED) return false;
    if (this.pocket.fasteners <= 0 || !this._hasHardware(j.slot.hardware)) return false;
    this._startAction('top-up', slotId, TUNING.topUpSeconds, true, () => {
      const need = Math.max(0, (j.slot.fasteners | 0) - Math.round((j.slot.fasteners | 0) * j.fastenerRatio));
      this.pocket.fasteners = Math.max(0, this.pocket.fasteners - need);
      j.fastenerRatio = 1;
      j.w = 0;
      j.correct = true;
      j.outcome = OUTCOMES.SEATED;
      this._syncJoin(j);
      this._seatVisual(j);
      this.bus?.emit('ui:toast', { text: '', icon: 'checkbox-filled', ms: 1200 });
    });
    return true;
  }

  /** The cheat everyone loves. 2.5 s, silent, one wedge: s -= 0.35, and w -= 0.15 if it applies. */
  applyShim(slotId) {
    const j = this.joins.get(slotId);
    if (!j || this.pocket.shims <= 0 || j.shimmed) return false;
    this._startAction('shim', slotId, TUNING.shimSeconds, true, () => {
      this.pocket.shims--;
      j.shimmed = true;
      j.torque = clamp01(j.torque + TUNING.shimSeatingGain);
      if (j.outcome === OUTCOMES.ROTATED || j.outcome === OUTCOMES.WRONG_SLOT) {
        j.w = Math.max(0, j.w - TUNING.shimWrongnessGain);
      }
      this._syncJoin(j);
      this._seatVisual(j);
    });
    return true;
  }

  /** Strictly temporary. lambda x 0.45 for 150 s on every join within 3 m. Buys you one haul. */
  applyTallow(slotId) {
    const j = this.joins.get(slotId);
    if (!j || this.pocket.tallow <= 0) return false;
    this._startAction('tallow', slotId, TUNING.tallowSeconds, true, () => {
      this.pocket.tallow--;
      const until = this._t + TUNING.tallowSeconds_effect;
      const r2 = TUNING.tallowRadius * TUNING.tallowRadius;
      for (let i = 0; i < this._joinList.length; i++) {
        const o = this._joinList[i];
        const dx = o.slot.px - j.slot.px, dy = o.slot.py - j.slot.py, dz = o.slot.pz - j.slot.pz;
        if (dx * dx + dy * dy + dz * dz <= r2) o.tallowUntil = until;
      }
    });
    return true;
  }

  /** Reduces the NOISE, not the creak. The join still moves; the camp stops hearing it so far. */
  applyFelt(slotId) {
    const j = this.joins.get(slotId);
    if (!j || this.pocket.felt <= 0 || j.felted || this.currentNight < 6) return false;
    this._startAction('felt', slotId, TUNING.feltSeconds, true, () => {
      this.pocket.felt--;
      j.felted = true;
      this._syncJoin(j);
    });
    return true;
  }

  /**
   * §6.3 / §7.4. Removal is always allowed, costs 8 s, and is loud: `wrench`, 24 m, 0.45.
   * Undoing is loud. This is the redemption loop and it must exist.
   */
  removeJoin(slotId) {
    const j = this.joins.get(slotId);
    if (!j) return false;
    // Refused while anything that depends on it is filled — remove those first.
    const deps = j.slot.dependents || [];
    for (let i = 0; i < deps.length; i++) if (this.joins.has(deps[i])) return false;

    this._startAction('remove', slotId, TUNING.removeSeconds, false, () => {
      const part = j.part;
      this._noise('wrench', j.slot.px, j.slot.py, j.slot.pz, TUNING.removeRadius, TUNING.removeIntensity);
      this.bus?.emit('audio:sfx', { id: 'nail.pull', position: this._slotVec(j.slot), volume: 0.8 });
      this._unregisterCollider(j);
      this.joins.delete(slotId);
      const li = this._joinList.indexOf(j);
      if (li >= 0) this._joinList.splice(li, 1);
      if (this.ctx?.state?.installed) delete this.ctx.state.installed[slotId];
      if (part) {
        part.state = 'dropped';
        part.slotId = null;
        this.available.push(part);
        if (part.object3D) {
          part.object3D.position.set(j.slot.px + 0.5, this._groundAt(j.slot.px + 0.5, j.slot.pz) + part.dims[1] * 0.5, j.slot.pz);
          part.object3D.rotation.set(0, this._rand.range(0, TAU), 0);
          part.object3D.visible = true;
        }
      }
      this._recomputeLoads();
      this._worldChanged(j.slot);
      this.bus?.emit('build:remove', { part: part ?? null, slot: j.slot });
    });
    return true;
  }

  /**
   * RECUT (§7.4) — available from Night One, because the handsaw has been in the tool roll since
   * Night One (conflict C4). 8 passes x 5.2 s, a 2.5 s minimum gap, 90 m of noise while a pass is
   * live, interruptible, and `w -> 0.10` because you cannot unmake a split. A recut join still
   * creaks. It is a scar.
   */
  beginRecut(slotId) {
    const j = this.joins.get(slotId);
    if (!j || this.pocket.boards <= 0) return false;
    const deps = j.slot.dependents || [];
    for (let i = 0; i < deps.length; i++) if (this.joins.has(deps[i])) return false;
    this.action = { kind: 'saw', slotId, t: 0, duration: TUNING.sawPassSeconds, silent: false, target: 'join', passes: TUNING.recutPasses };
    return true;
  }

  /** The N3 ridge cut and the Recut share one verb; only the pass count differs (§7.6). */
  sawPass(target, dt) {
    if (typeof target === 'string') { this.beginRecut(target); return; }
    this._sawHold(dt);
  }

  _sawHold(dt) {
    const a = this.action;
    if (!a || a.kind !== 'saw') return;
    if (!a.inPass) {
      // Begin a pass. Starting one before the 2.5 s gap has elapsed binds the blade: half
      // progress and a bind transient. There is no way to be strong at a saw. The only
      // technique is patience, which is the one thing that costs time.
      a.inPass = true;
      a.bound = this._sawGap > 0;
    }
    a.t += dt;
    const slot = this.slots.get(a.slotId);
    const pos = a.target === 'part' ? (a.part?.object3D?.position ?? null) : null;
    const x = pos ? pos.x : (slot?.px ?? 0), y = pos ? pos.y : (slot?.py ?? 0), z = pos ? pos.z : (slot?.pz ?? 0);
    this._noise('saw', x, y, z, TUNING.sawRadius, TUNING.sawIntensity);

    if (a.t < TUNING.sawPassSeconds) return;
    a.t = 0;
    a.inPass = false;
    this._sawGap = TUNING.sawPassGap;
    const gain = (a.bound ? TUNING.sawBindPenalty : 1) / a.passes;
    a.bound = false;

    if (a.target === 'part' && a.part) {
      a.part.sawProgress = clamp01((a.part.sawProgress || 0) + gain);
      if (a.part.sawProgress >= 1) {
        a.part.length = PART_TYPES[a.part.partId]?.cutTo ?? a.part.length;
        this.ctx?.state?.flag?.('cutTheGroundSill');
        this.action = null;
      }
      return;
    }

    const j = this.joins.get(a.slotId);
    if (!j) { this.action = null; return; }
    j.recutProgress = clamp01(j.recutProgress + gain);
    this._syncJoin(j);
    if (j.recutProgress >= 1) {
      this.pocket.boards = Math.max(0, this.pocket.boards - 1);
      j.w = TUNING.wRecut;
      j.torque = 0;                 // you must then re-seat
      j.outcome = j.w > 0 ? OUTCOMES.UNDER_FASTENED : OUTCOMES.SEATED;
      j.correct = false;
      j.recutProgress = 0;
      this._syncJoin(j);
      this._seatVisual(j);
      this.action = null;
    }
  }

  /**
   * PROVOKE (§9.6) — the only distraction verb in the game, and it is a construction verb.
   * You loosen a join you built, on purpose, to pull a patrol to a location you chose. The fuse
   * is set by how long past 1.6 s you hold. The cost is permanent, and it compounds: provoke the
   * same join four times and it starts creaking on its own, forever, for real.
   */
  provoke(slotId, holdSeconds = TUNING.provokeArm) {
    const j = this.joins.get(slotId);
    if (!j) return false;
    if (j.w >= TUNING.provokeRefuseW) return false;         // already talking
    if (this.currentNight === 7) return false;              // the house is finished and silent
    const delay = clamp(TUNING.provokeFuseBase + (holdSeconds - TUNING.provokeArm) * TUNING.provokeFuseRate,
      TUNING.provokeFuseBase, TUNING.provokeFuseMax);
    const severity = clamp01(TUNING.provokeSeverityBase + TUNING.provokeSeverityTorque * (1 - j.torque));
    j.torque = clamp01(j.torque - TUNING.provokeTorqueCost);
    this._syncJoin(j);
    this._fuses.push({ slotId, t: delay, severity });
    this.bus?.emit('audio:sfx', { id: 'screw.strip', position: this._slotVec(j.slot), volume: 0.35 });
    return delay;
  }

  _updateFuses(dt) {
    for (let i = this._fuses.length - 1; i >= 0; i--) {
      const f = this._fuses[i];
      f.t -= dt;
      if (f.t > 0) continue;
      this._fuses.splice(i, 1);
      const j = this.joins.get(f.slotId);
      if (j) this._fireCreak(j, f.severity);
    }
  }

  /** STORY §1.4: pull the government stake out of the ground and build on the hole. */
  removeObstruction(slotId) {
    const slot = this.slots.get(slotId);
    if (!slot?.obstruction) return false;
    this._startAction('obstruction', slotId, TUNING.obstructionSeconds, true, () => {
      slot.obstruction = null;
      this.ctx?.state?.flag?.('pulledCountyStake');
    });
    return true;
  }

  _startAction(kind, slotId, duration, silent, done) {
    if (this.action) return false;
    this.action = { kind, slotId, t: 0, duration, silent, done };
    return true;
  }

  _updateAction(dt) {
    if (this._sawGap > 0) this._sawGap -= dt;
    const a = this.action;
    if (!a || a.kind === 'saw') return;
    a.t += dt;
    if (a.t < a.duration) return;
    this.action = null;
    try { a.done?.(); } catch (e) { Log.warn(`BuildSystem: action '${a.kind}' threw.`, e); }
  }

  // ------------------------------------------------------------------- THE CREAK ENGINE (§7)

  /**
   * §7.1, evaluated per JOIN, per 2.0 s tick, staggered so no more than 6 joins evaluate in a
   * frame. A perfectly Seated, perfectly torqued join has w = 0 and s = 0, so lambda = 0:
   * A CORRECT CABIN IS SILENT FOREVER. That has to be true — it is the reward for reading the
   * manual, and it is what makes the silence of the finished house on Night Seven land.
   */
  _updateCreaks(dt) {
    // creakDebt decays at 0.15/min. v1.0's 0.02 was 7.5x too slow to matter.
    this.creakDebt = clamp(this.creakDebt - (TUNING.debtDecayPerMinute / 60) * dt, 0, TUNING.debtMax);
    if (this._cascadeCooldown > 0) this._cascadeCooldown -= dt;
    this._drainCascade(dt);

    const n = this._joinList.length;
    if (!n) { this.lambdaSum = 0; this.creakRisk = 0; return; }

    const wind = this._weather.wind, rain = this._weather.rain;
    const ton = clamp01(this.ctx?.state?.timeOfNight ?? 0);
    const Mw = 1 + TUNING.windWeight * wind + TUNING.rainWeight * rain;
    const Mt = 1 + TUNING.coldWeight * ton;
    const Md = 1 + TUNING.debtWeight * this.creakDebt;
    const env = Mw * Mt * Md;

    // The cabin cap needs the sum, so lambda is refreshed for every join each frame (90 joins of
    // scalar arithmetic — ~2 microseconds) and only the TICK is staggered.
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const j = this._joinList[i];
      j.age += dt;
      j.lambda = this._lambdaFor(j, env);
      sum += j.lambda;
    }
    this.lambdaSum = sum;

    // CABIN_CAP: when the sum exceeds 4.0/min every join is scaled down. A bad cabin is a WORSE
    // cabin, not a continuous alarm — and this is what guarantees the 3-voice creak cap holds.
    const scale = sum > TUNING.cabinCap ? TUNING.cabinCap / sum : 1;

    let evaluated = 0;
    for (let i = 0; i < n && evaluated < TUNING.creakJoinsPerFrame; i++) {
      const j = this._joinList[this._creakCursor % n];
      this._creakCursor++;
      j.nextTick -= dt;
      if (j.nextTick > 0) continue;
      j.nextTick += TUNING.creakTickSeconds;
      evaluated++;
      const lambda = j.lambda * scale;
      if (lambda <= 0) continue;
      const P = 1 - Math.exp(-lambda * TUNING.creakTickSeconds / 60);
      if (this._rand.next() < P) this._fireCreak(j, -1);
    }

    this.creakRisk = clamp01(0.65 * (sum / TUNING.cabinCap) + 0.35 * (this.creakDebt / TUNING.cascadeThreshold));

    if (this.creakDebt > TUNING.cascadeThreshold && this._cascadeCooldown <= 0) this._cascade();
  }

  /**
   * lambdaRaw = 6.0 * (w + 0.30*s) * (0.40 + 0.90*L) * Mw * Mt * Md, capped at PER_JOIN_CAP.
   * `w` here is the join's own wrongness PLUS a bounded share of its neighbours' — one bad join
   * makes the joins around it more likely to speak, which is what makes a bad corner of the cabin
   * read as a bad corner rather than as one bad bolt.
   */
  _lambdaFor(j, env) {
    // §6.4.1: a Wrong-slot join is unconditionally silent for its first 90 seconds. That window is
    // the diagnostic the design always claimed to have and never budgeted.
    if (j.outcome === OUTCOMES.WRONG_SLOT && j.age < TUNING.wrongSlotSilentFor) return 0;

    const w = clamp01(j.w + this._neighbourStress(j));
    const s = clamp01(1 - j.torque);
    if (w <= 0 && s <= 0) return 0;
    const L = clamp(j.supportedMass / Math.max(1, j.slot.ratedMass), 0, TUNING.loadClamp);
    let lambda = TUNING.lambdaBase * (w + TUNING.lambdaSeatingWeight * s)
      * (TUNING.lambdaLoadA + TUNING.lambdaLoadB * L) * env;
    if (j.tallowUntil > this._t) lambda *= TUNING.tallowFactor;
    return Math.min(lambda, TUNING.perJoinCap);
  }

  _neighbourStress(j) {
    const ns = j.slot.neighbours;
    if (!ns || !ns.length) return 0;
    let sum = 0, count = 0;
    for (let i = 0; i < ns.length; i++) {
      const o = this.joins.get(ns[i]);
      if (!o) continue;
      sum += o.w; count++;
    }
    if (!count) return 0;
    return Math.min(TUNING.neighbourStressCap, TUNING.neighbourStress * (sum / count));
  }

  /**
   * §7.1's "On a hit". Four severity tiers fall out of the curve rather than being enumerated:
   * ProceduralSFX buckets 0..1 into t0..t3 (`creakTier`), 240 Hz and a 1.9 s envelope at the top.
   * The worst tier is a sixty-metre groan and it is meant to be an "oh no".
   */
  _fireCreak(j, forcedSeverity) {
    const s = clamp01(1 - j.torque);
    const L = clamp(j.supportedMass / Math.max(1, j.slot.ratedMass), 0, TUNING.loadClamp);
    let severity = forcedSeverity >= 0 ? clamp01(forcedSeverity) : clamp01(
      TUNING.severityBase + TUNING.severityW * clamp01(j.w + this._neighbourStress(j))
      + TUNING.severityS * s + TUNING.severityL * Math.min(L, 1.5),
    );
    let radius = TUNING.radiusBase + TUNING.radiusSpan * severity;

    // §6.4.1's grace clamps: 90–240 s a Wrong-slot join is a symptom, not an alarm.
    if (j.outcome === OUTCOMES.WRONG_SLOT && j.age < TUNING.wrongSlotClampUntil) {
      severity = Math.min(severity, TUNING.wrongSlotClampSeverity);
      radius = Math.min(radius, TUNING.wrongSlotClampRadius);
    }
    if (j.felted) radius *= TUNING.feltRadiusFactor;   // the felt pad quiets the noise, not the creak

    const pos = this._slotVec(j.slot);
    // The emission order is fixed by §7.1 and other systems rely on it.
    this.bus?.emit('build:creak', { position: pos, severity });
    this.bus?.emit('noise:emit', { position: pos, radius, intensity: severity, kind: 'creak' });
    this.bus?.emit('audio:sfx', {
      id: severity > 0.7 ? 'creak_groan' : 'creak_tick', position: pos,
      rate: 0.8 + 0.5 * (1 - severity),
    });

    this.creakDebt = clamp(this.creakDebt + TUNING.debtAccrual * severity, 0, TUNING.debtMax);
    const st = this.ctx?.state;
    if (st) {
      st.creaks = (st.creaks | 0) + 1;
      if (st.stats) st.stats.creaksTotal = (st.stats.creaksTotal | 0) + 1;
    }
    this.stats.creaksThisNight++;
    return severity;
  }

  /**
   * §7.3's cascade: at creakDebt > 1.2 the cabin settles — 3 to 5 joins inside 1.5 s, radii
   * summed and capped at 60 m — and Weather is asked for a gust to cover it. Then 180 s of
   * cooldown, so it cannot machine-gun. One error never reaches here; three errors on a wet
   * night do, in about eight minutes. That is the intended climax and not a routine event.
   */
  _cascade() {
    if (!this._joinList.length) return;
    this._cascadeCooldown = TUNING.cascadeCooldown;

    // The worst joins speak, loudest first.
    const pick = this._joinList.slice().sort((a, b) => b.lambda - a.lambda);
    const count = Math.min(pick.length, this._rand.int(TUNING.cascadeJoins[0], TUNING.cascadeJoins[1]));
    let radiusBudget = TUNING.cascadeRadiusCap;
    this._cascadeQueue.length = 0;
    for (let i = 0; i < count; i++) {
      const j = pick[i];
      if (!j) break;
      this._cascadeQueue.push({ join: j, t: (i / Math.max(1, count - 1)) * TUNING.cascadeWindow });
      radiusBudget -= 6;
    }
    this._cascadeTimer = 0;

    const weather = this.ctx?.systems?.get?.('Weather');
    if (typeof weather?.requestWind === 'function') {
      try { weather.requestWind(0.22, 8); } catch { /* Weather may not take a duration */ }
    }
    Log.debug(`BuildSystem: settle cascade, ${count} joins, creakDebt ${this.creakDebt.toFixed(2)}`);
  }

  _drainCascade(dt) {
    if (this._cascadeTimer < 0) return;
    this._cascadeTimer += dt;
    for (let i = this._cascadeQueue.length - 1; i >= 0; i--) {
      const e = this._cascadeQueue[i];
      if (this._cascadeTimer < e.t) continue;
      this._cascadeQueue.splice(i, 1);
      if (this.joins.has(e.join.slotId)) this._fireCreak(e.join, -1);
    }
    if (!this._cascadeQueue.length) this._cascadeTimer = -1;
  }

  _sampleMask() {
    const ns = this.ctx?.systems?.get?.('NoiseSystem');
    const w = this.ctx?.systems?.get?.('Weather');
    for (const sys of (ns === w ? [w] : [ns, w])) {
      if (!sys) continue;
      const v = sys.maskLevel;
      if (typeof v === 'function') { const r = v.call(sys); if (Number.isFinite(r)) { this._maskLevel = clamp01(r); return; } }
      else if (Number.isFinite(v)) { this._maskLevel = clamp01(v); return; }
    }
    // §7.5's constant floor: maskFloor = 0.30*rain + 0.22*wind. Nothing covers Night Seven.
    this._maskLevel = clamp01(0.30 * this._weather.rain + 0.22 * this._weather.wind);
  }

  // --------------------------------------------------------------- the freeform rig (§6.7)

  /**
   * Night Five's escape hatch. There are no snap points and no correct answer, only a working
   * one: any arrangement of world objects that holds the panel's free end above 2.05 m for 8
   * continuous seconds with the player's hands empty passes, and `build:place` fires with
   * `correct: true` for a join the manual never specified.
   *
   * The first single-handed attempt is a scripted, unpunished failure. The manual told you it
   * needs two persons. The game is allowed to let you find that out.
   */
  _updateRig(dt) {
    if (this.currentNight !== 5) return;
    const slot = this.slots.get('W-NORTH');
    const j = slot ? this.joins.get('W-NORTH') : null;
    if (!slot || this.rig.satisfied) return;

    // The panel is pinned at one end the moment it is placed; the free end is a 1-DOF pendulum.
    if (!j) { this.rig.active = false; return; }
    this.rig.active = true;

    const halfSpan = (PART_TYPES.PANEL_N?.dims?.[0] ?? 4.8) * 0.5;
    const pivotY = slot.py;
    // Support: sum the bearing capacity of anything standing under the free end.
    const freeX = slot.px + halfSpan * Math.cos(this.rig.angle);
    const freeY = pivotY + halfSpan * Math.sin(this.rig.angle);
    const support = this._supportUnder(freeX, slot.pz, freeY);
    this.rig.force = support.force;
    this.rig.height = freeY;

    const handsEmpty = this.heldParts.length === 0;
    const enough = support.force >= TUNING.rigMinUpwardForce && support.topY >= TUNING.rigMinHeight;

    if (enough) {
      // Resting on the rig.
      this.rig.angle += (Math.asin(clamp((support.topY - pivotY) / halfSpan, -1, 1)) - this.rig.angle) * Math.min(1, dt * 6);
      this.rig.angVel = 0;
    } else {
      // Falling. This is the scripted failure the first time, and it costs nothing.
      this.rig.angVel += (-9.81 / halfSpan) * Math.cos(this.rig.angle) * dt;
      this.rig.angle = Math.max(-0.42, this.rig.angle + this.rig.angVel * dt);
      if (this.rig.angle <= -0.41 && !this.rig.failedOnce) {
        this.rig.failedOnce = true;
        this._unregisterCollider(j);
        this.joins.delete('W-NORTH');
        const li = this._joinList.indexOf(j);
        if (li >= 0) this._joinList.splice(li, 1);
        if (this.ctx?.state?.installed) delete this.ctx.state.installed['W-NORTH'];
        if (j.part) { j.part.state = 'dropped'; j.part.slotId = null; this.available.push(j.part); }
        this.rig.angle = 0; this.rig.angVel = 0;
        // free and silent, and no `w` is recorded
        this.bus?.emit('build:remove', { part: j.part ?? null, slot });
      }
    }

    if (enough && handsEmpty && freeY >= TUNING.rigMinHeight) this.rig.held += dt;
    else this.rig.held = 0;

    if (this.rig.held >= TUNING.rigMinDuration) {
      this.rig.satisfied = true;
      j.w = 0; j.correct = true; j.torque = Math.max(j.torque, 0.8); j.outcome = OUTCOMES.SEATED;
      this._syncJoin(j);
      for (const s of this.nightSlots) if (s.kind === 'freeform') s.satisfied = true;
      this.ctx?.state?.flag?.('riggedCounterweight');
      this.bus?.emit('build:place', { part: j.part ?? null, slot, correct: true });
      this._advanceStage(false);
    }
  }

  /** What is standing under a point, and how hard it can push up. Physics when it exists. */
  _supportUnder(x, z, _y) {
    let force = 0, topY = 0;
    const phys = this._physics();
    if (phys && typeof phys.overlapSphere === 'function') {
      _v1.set(x, TUNING.rigMinHeight * 0.5, z);
      const n = phys.overlapSphere(_v1, TUNING.rigSupportRadius + TUNING.rigMinHeight, _overlap, 0xffffffff);
      for (let i = 0; i < Math.min(n, _overlap.length); i++) {
        const c = _overlap[i];
        if (!c) continue;
        const maxY = c.maxY ?? c.top ?? 0;
        if (maxY < 0.35) continue;
        topY = Math.max(topY, maxY);
        force += 900;   // a stump, a canoe, a ladder, a placed part: all of them bear a person
      }
    }
    // Dropped parts and placed joins bear load too, whether or not Physics is here to say so.
    const r2 = (TUNING.rigSupportRadius + 0.6) * (TUNING.rigSupportRadius + 0.6);
    for (let i = 0; i < this.available.length; i++) {
      const p = this.available[i];
      const o = p.object3D;
      if (!o || p.state === 'held') continue;
      const dx = o.position.x - x, dz = o.position.z - z;
      if (dx * dx + dz * dz > r2) continue;
      const top = o.position.y + p.dims[1] * 0.5;
      topY = Math.max(topY, top);
      force += p.mass * TUNING.rigGravity * 4;    // stacked timber carries far more than it weighs
    }
    return { force, topY };
  }

  // ---------------------------------------------------------------------------- diagnosis

  /**
   * The manual's own voice: numbers and glyph ids, no prose. `BlueprintUI` draws this; nothing
   * prints it. `glyph` is always a member of `Script.glyphs`.
   *
   * The seventh night's diagnosis is the joke and the horror in one object: the chair is
   * assembled correctly, and the manifest is short one article, and the article is a person.
   */
  inspect(slotId) {
    const slot = this.slots.get(slotId);
    if (!slot) return null;
    const j = this.joins.get(slotId);
    const needF = slot.fasteners | 0;
    const needH = slot.hardware?.count | 0;

    const d = {
      slotId, article: slot.article, night: slot.night, stage: slot.stage,
      filled: !!j,
      partId: j?.partId ?? null,
      expectedPartId: slot.partId,
      outcome: j?.outcome ?? null,
      correct: !!j?.correct,
      torque: j ? Math.round(j.torque * 100) / 100 : null,
      seatingDeficit: j ? Math.round((1 - j.torque) * 100) / 100 : null,
      wrongness: j ? Math.round(j.w * 100) / 100 : null,
      loadFactor: j ? Math.round(clamp(j.supportedMass / Math.max(1, slot.ratedMass), 0, TUNING.loadClamp) * 100) / 100 : 0,
      supportedMass: j ? Math.round(j.supportedMass) : 0,
      ratedMass: slot.ratedMass,
      creaksPerMinute: j ? Math.round(j.lambda * 100) / 100 : 0,
      severityIfItSpeaks: j ? Math.round(this._severityPreview(j) * 100) / 100 : 0,
      offsetMm: j?.outcome === OUTCOMES.ROTATED ? TUNING.rotatedOffsetMm : this._inheritedOffsetMm(slot),
      fastenersHeld: j ? Math.round((needF + needH) * j.fastenerRatio) : Math.min(needF, this.pocket.fasteners),
      fastenersRequired: needF + needH,
      hardware: slot.hardware ? { id: slot.hardware.id, required: needH, supplied: this._hasHardware(slot.hardware) ? needH : 0 } : null,
      dependenciesMet: this._dependenciesMet(slot),
      obstruction: slot.obstruction,
      hidden: !!slot.hidden,
      errata: !!slot.errata,
      deferred: !!slot.deferred,
      shimmed: !!j?.shimmed,
      felted: !!j?.felted,
      recutProgress: j ? Math.round(j.recutProgress * 100) / 100 : 0,
      silentForAnother: j?.outcome === OUTCOMES.WRONG_SLOT
        ? Math.max(0, Math.round(TUNING.wrongSlotSilentFor - j.age)) : 0,
      visual: this.visualStateFor(slotId),
      repairs: [],
      glyph: 'circle-number',
    };

    // Night Seven. Everything is correct. The manifest is short one article.
    if (slot.occupant) {
      d.occupantRequired = 1;
      d.occupantSupplied = 0;
      d.substitutionPermitted = false;
      d.glyph = 'mascot-hand-raised';
    }

    if (!j) {
      if (!slot.occupant) {
        d.glyph = slot.obstruction ? 'red-slash-circle'
          : slot.deferred ? 'dotted-outline'
            : !d.dependenciesMet ? 'red-slash-circle' : 'arrow-straight';
      }
      return d;
    }

    if (j.outcome === OUTCOMES.ROTATED) { d.glyph = 'mirror'; d.repairs.push('remove', 'recut'); }
    else if (j.outcome === OUTCOMES.WRONG_SLOT) { d.glyph = 'red-slash-circle'; d.repairs.push('remove'); }
    else if (j.outcome === OUTCOMES.WRONG_PART) { d.glyph = 'red-exclamation-triangle'; d.repairs.push('recut'); }
    else if (j.outcome === OUTCOMES.UNDER_FASTENED) { d.glyph = 'bag-count'; d.repairs.push('top-up'); }
    else if (j.split) { d.glyph = 'red-exclamation-triangle'; d.repairs.push('recut'); }
    else if (j.torque < 0.8) { d.glyph = 'arrow-curved'; d.repairs.push('reseat', 'shim'); }
    else d.glyph = 'tick';

    if (slot.occupant) d.glyph = 'mascot-hand-raised';
    if (j.torque < 0.85 && !j.shimmed) d.repairs.push('shim');
    if (this.currentNight >= 6 && !j.felted && j.w > 0) d.repairs.push('felt');
    if (j.lambda > 0.4) d.repairs.push('tallow');
    return d;
  }

  _severityPreview(j) {
    const s = clamp01(1 - j.torque);
    const L = clamp(j.supportedMass / Math.max(1, j.slot.ratedMass), 0, TUNING.loadClamp);
    return clamp01(TUNING.severityBase + TUNING.severityW * clamp01(j.w + this._neighbourStress(j))
      + TUNING.severityS * s + TUNING.severityL * Math.min(L, 1.5));
  }

  /**
   * What `CabinSite` should draw. The player must be able to look at the cabin and see what is
   * wrong with it, from outside, in moonlight, without opening anything.
   */
  visualStateFor(slotId) {
    const j = this.joins.get(slotId);
    if (!j) return 'empty';
    if (j.split || j.outcome === OUTCOMES.WRONG_PART) return 'split';
    if (j.outcome === OUTCOMES.ROTATED) return 'proud';        // 6 mm, and it rings when struck
    if (j.outcome === OUTCOMES.WRONG_SLOT) return 'gapped';    // the far end floats
    if (j.torque < 0.62) return 'sagging';
    if (j.torque < 0.85) return 'gapped';
    return 'flush';
  }

  isDeferred(slotId) { return !!this.slots.get(slotId)?.deferred; }
  slotById(id) { return this.slots.get(id) ?? null; }
  partById(id) { return this.parts.get(id) ?? null; }
  shortfallInfo(toolId) {
    for (let i = 0; i < this.shortfalls.length; i++) if (this.shortfalls[i].toolId === toolId) return this.shortfalls[i];
    return null;
  }

  /** §9.5 — the cabin as an AI percept. Which silhouette features exist, and how tall they are. */
  featureHeights() {
    const out = {};
    for (const j of this._joinList) {
      const f = j.slot.feature;
      if (!f) continue;
      const top = j.slot.py + (PART_TYPES[j.partId]?.dims?.[1] ?? 0.4) * 0.5;
      out[f] = Math.max(out[f] ?? 0, top);
    }
    return out;
  }

  /** Joins inside a radius. Campers and NoiseSystem use it; fills `out` by index, no allocation. */
  joinsNear(x, z, r, out) {
    let n = 0;
    const r2 = r * r;
    for (let i = 0; i < this._joinList.length && n < (out?.length ?? 0); i++) {
      const j = this._joinList[i];
      const dx = j.slot.px - x, dz = j.slot.pz - z;
      if (dx * dx + dz * dz <= r2) out[n++] = j;
    }
    return n;
  }

  // ------------------------------------------------------------------------------- stages

  /** A stage is complete when every one of its slots is filled — or correctly left open (G7). */
  _stageComplete(stage) {
    let any = false;
    for (let i = 0; i < this.nightSlots.length; i++) {
      const s = this.nightSlots[i];
      if (s.stage !== stage) continue;
      any = true;
      if (this.joins.has(s.id)) continue;
      if (s.deferred) continue;
      if (s.kind === 'freeform' && this.rig.satisfied) continue;
      return false;
    }
    return any;
  }

  _advanceStage(silent) {
    let guard = 0;
    while (this.stage <= this.stageCount && this._stageComplete(this.stage) && guard++ < 16) {
      if (!silent) {
        this.bus?.emit('build:stage-complete', { stage: this.stage });
        // §11.1: +2 fastener bags and +1 sistering board at each stage complete.
        this.pocket.fasteners = Math.min(TUNING.pocketCap, this.pocket.fasteners + 24);
        this.pocket.boards++;
      }
      this.stage++;
    }
    if (this.stage > this.stageCount) this.stage = this.stageCount;
  }

  /**
   * §6.9 layer 1. The manifest flags the shortfall in red at t = 0 — the joke is not that you
   * discover it, the joke is the presentation. `tool:missing` is the channel; the manual draws
   * the red outline and the 40 x 40 m contour inset. Night 5's second person and Night 6's
   * article 0000-000 never enter the hint ladder at any layer, and they never will.
   */
  _announceShortfalls(night) {
    this.shortfalls.length = 0;
    const defs = SHORTFALLS[night] || [];
    const scripted = this.script?.nightDef?.(night)?.shortfallItems ?? null;
    for (let i = 0; i < defs.length; i++) {
      const d = defs[i];
      const anchor = d.at ? MAP[d.at] : null;
      const meta = scripted?.find?.((s) => s.id === d.toolId) ?? null;
      const rec = {
        toolId: d.toolId,
        label: meta?.label ?? d.toolId,
        tier: meta?.tier ?? (anchor ? (Math.hypot(anchor[0], anchor[1]) < 50 ? 1 : Math.hypot(anchor[0], anchor[1]) < 120 ? 2 : 3) : null),
        position: anchor ? new THREE.Vector3(anchor[0], this._groundAt(anchor[0], anchor[1]), anchor[1]) : null,
        material: d.material,          // drives §6.9's material-appropriate 1.8 s cue
        hintable: !!d.hintable,        // false = it is not in the world and never was
        forSlot: d.forSlot ?? null,
        found: false,
        announcedAt: this._t,
      };
      this.shortfalls.push(rec);
      this.bus?.emit('tool:missing', { toolId: d.toolId });
    }
  }

  _endNight() {
    // 40% of the debt carries into tomorrow (§7.3). The cabin remembers.
    const st = this.ctx?.state;
    if (st?.stats) st.stats.creakDebtCarry = this.creakDebt * TUNING.debtCarryover;
    this.cancelPlace();
    this.action = null;
    this._fuses.length = 0;
    this._cascadeQueue.length = 0;
    this._cascadeTimer = -1;
    for (let i = 0; i < this._tapQueue.length; i++) this._tapQueue[i].live = false;
  }

  // ------------------------------------------------------------------- world integration

  /** Seat the part's mesh in the slot, with the error visible from outside. */
  _seatVisual(join) {
    const site = this.ctx?.systems?.get?.('CabinSite');
    if (site && typeof site.setInstalled === 'function') {
      try {
        site.setInstalled(join.slotId, join.part ?? null, {
          outcome: join.outcome, torque: join.torque, w: join.w,
          visual: this.visualStateFor(join.slotId),
          offsetMm: join.outcome === OUTCOMES.ROTATED ? TUNING.rotatedOffsetMm : 0,
          candidate: join.candidate,
        });
        return;
      } catch (e) { Log.once('bs:setinstalled', 'CabinSite.setInstalled threw; seating locally.', e); }
    }
    const o = join.part?.object3D;
    const s = join.slot;
    if (!o) return;
    const k = Math.max(1, s.yawCandidates | 0);
    const visual = this.visualStateFor(join.slotId);
    const offset = (join.outcome === OUTCOMES.ROTATED ? TUNING.rotatedOffsetMm : 0) / 1000
      + this._inheritedOffsetMm(s) / 1000;
    o.position.set(s.px + offset, s.py + (visual === 'proud' ? 0.006 : 0), s.pz);
    o.rotation.set(0, s.yaw + (TAU / k) * join.candidate, 0);
    // A loose join hangs; a wrong-slot join floats at the far end. Both read at 25 m.
    if (visual === 'sagging') o.rotation.z = -0.035;
    else if (visual === 'gapped') o.rotation.z = 0.018;
    else if (visual === 'split') o.rotation.z = 0.012;
    else o.rotation.z = 0;
    o.visible = true;
  }

  _rebuildInstalledVisuals() {
    for (let i = 0; i < this._joinList.length; i++) {
      const j = this._joinList[i];
      if (!j.part && j.partId) {
        // Restored from the save: make the mesh so the cabin from earlier nights is standing.
        const spec = PART_TYPES[j.partId];
        if (spec) {
          const p = this._makePart(j.partId, j.slot.px, j.slot.pz, this._rand);
          if (p) {
            const ai = this.available.indexOf(p);
            if (ai >= 0) this.available.splice(ai, 1);
            p.state = 'placed'; p.slotId = j.slotId; j.part = p;
          }
        }
      }
      this._seatVisual(j);
      this._registerCollider(j);
    }
    this._recomputeLoads();
  }

  /**
   * §9.6, "the cabin rewrites the world". A placed part is a hard LOS blocker and a 0.65 sound
   * blocker, and patrol edges bend around it. Panels installed = safety earned.
   */
  _registerCollider(join) {
    const phys = this._physics();
    if (!phys || typeof phys.addColliderAt !== 'function' || join.collider >= 0) return;
    const spec = PART_TYPES[join.partId];
    if (!spec) return;
    const kindMap = {
      panel: 'panel', beam: 'beam', ridge: 'beam', post: 'post', joist: 'beam',
      board: 'floor', batten: 'roof', shingle: 'roof', truss: 'roof', door: 'wall',
      fitting: 'prop', pier: 'rock', bracket: 'prop', hinge: 'prop', fastener: 'prop', chair: 'prop',
    };
    try {
      join.collider = phys.addColliderAt(
        join.slot.px, join.slot.py, join.slot.pz,
        kindMap[spec.type] ?? 'prop',
        { halfExtents: { x: spec.dims[0] * 0.5, y: spec.dims[1] * 0.5, z: spec.dims[2] * 0.5 }, yaw: join.slot.yaw },
      );
    } catch (e) { Log.once('bs:collider', 'Physics.addColliderAt rejected a build collider.', e); }
  }

  _unregisterCollider(join) {
    const phys = this._physics();
    if (join.collider >= 0 && typeof phys?.removeCollider === 'function') {
      try { phys.removeCollider(join.collider); } catch { /* already gone */ }
    }
    join.collider = -1;
  }

  /** Tell the two systems that own a model of the plot that the plot changed. */
  _worldChanged(slot) {
    const nav = this.ctx?.systems?.get?.('Navmesh');
    // TODO(api): Navmesh.rebuildAround(x, z, radius) — §9.6 bounds this to the AABB + 3 m.
    if (typeof nav?.rebuildAround === 'function') {
      try { nav.rebuildAround(slot.px, slot.pz, 4.5); } catch { /* optional */ }
    }
    const ns = this.ctx?.systems?.get?.('NoiseSystem');
    // TODO(api): NoiseSystem.writeOcclusion(x, z, halfX, halfZ, factor) — the 2 m byte grid.
    if (typeof ns?.onBuildChanged === 'function') {
      try { ns.onBuildChanged(slot.px, slot.pz); } catch { /* optional */ }
    }
    const site = this.ctx?.systems?.get?.('CabinSite');
    if (typeof site?.onBuildChanged === 'function') {
      try { site.onBuildChanged(slot.id, this.featureHeights()); } catch { /* optional */ }
    }
  }

  // ------------------------------------------------------------------------------- helpers

  _physics() {
    const p = this.ctx?.systems?.get?.('Physics');
    return p && !p.__failed ? p : null;
  }

  _groundAt(x, z) {
    const phys = this._physics();
    if (typeof phys?.heightAt === 'function') {
      const y = phys.heightAt(x, z);
      if (Number.isFinite(y)) return y;
    }
    const terr = this.ctx?.systems?.get?.('Terrain');
    if (typeof terr?.heightAt === 'function') {
      const y = terr.heightAt(x, z);
      if (Number.isFinite(y)) return y;
    }
    return 0;
  }

  /** The eye, from Player when Player exists, from the camera when it does not. */
  _eye(out) {
    const pl = this.ctx?.systems?.get?.('Player');
    if (pl?.position?.isVector3) return out.copy(pl.position).setY(pl.position.y + 1.7);
    const cam = this.ctx?.camera;
    if (cam) return out.copy(cam.position);
    return out.set(0, 1.7, 0);
  }

  _forward(out) {
    const cam = this.ctx?.camera;
    if (!cam) return out.set(0, 0, -1);
    cam.getWorldDirection(out);
    return out;
  }

  _slotVec(slot) { return new THREE.Vector3(slot.px, slot.py, slot.pz); }

  _flag(id) { return !!this.ctx?.state?.storyFlags?.[id]; }

  _partByPartId(partId) {
    for (let i = 0; i < this.available.length; i++) if (this.available[i].partId === partId) return this.available[i];
    return null;
  }

  _consume(part) {
    const i = this.available.indexOf(part);
    if (i >= 0) this.available.splice(i, 1);
    part.state = 'consumed';
    if (part.object3D) {
      this._group?.remove(part.object3D);
      part.object3D.visible = false;
    }
    this._physics()?.disposeCarried?.(part);
  }

  /**
   * The one channel every mechanic in this file resolves into. `kind` is always a member of
   * §9.8's canonical vocabulary; nothing here invents one. Payloads are never pooled.
   */
  _noise(kind, x, y, z, radius, intensity) {
    if (!this.bus) return;
    this.bus.emit('noise:emit', {
      position: new THREE.Vector3(x, y, z),
      radius, intensity: clamp01(intensity), kind,
    });
  }

  _sfx(id, slot, volume = 1, rate = 1) {
    if (!this.bus) return;
    this.bus.emit('audio:sfx', {
      id, position: slot ? this._slotVec(slot) : undefined, volume, rate,
    });
  }

  _clearParts() {
    for (const p of this.parts.values()) {
      this._physics()?.disposeCarried?.(p);
      if (p.object3D) this._group?.remove(p.object3D);
    }
    this.parts.clear();
    this.available.length = 0;
    this.heldParts.length = 0;
    this._projectiles.length = 0;
  }

  // ------------------------------------------------------------------------------- teardown

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    for (let i = 0; i < this._unsubs.length; i++) {
      try { this._unsubs[i](); } catch { /* already gone */ }
    }
    this._unsubs.length = 0;

    for (const j of this._joinList) this._unregisterCollider(j);
    this._clearParts();
    this.joins.clear();
    this._joinList.length = 0;
    this.slots.clear();
    this.nightSlots.length = 0;
    this._fuses.length = 0;
    this._cascadeQueue.length = 0;

    if (this._handAnchor && this._ownsHandAnchor) this._handAnchor.parent?.remove(this._handAnchor);
    this._handAnchor = null;

    if (this._group) {
      this._group.parent?.remove(this._group);
      this._group.clear();
      this._group = null;
    }
    this._ghost = null;

    for (let i = 0; i < this._ownedGeo.length; i++) this._ownedGeo[i]?.dispose?.();
    for (let i = 0; i < this._ownedMat.length; i++) this._ownedMat[i]?.dispose?.();
    this._ownedGeo.length = 0;
    this._ownedMat.length = 0;
    this._geoCache.clear();
    this._matCache.clear();

    this.script = null;
  }
}

// Statics, so a caller does not have to import the loose exports.
BuildSystem.TUNING = TUNING;
BuildSystem.OUTCOMES = OUTCOMES;
BuildSystem.OUTCOME_ALIASES = OUTCOME_ALIASES;
BuildSystem.PART_TYPES = PART_TYPES;
BuildSystem.CARRY_CLASSES = CARRY_CLASSES;
BuildSystem.SFX_MAP = SFX_MAP;
BuildSystem.NIGHT_TABLE = NIGHT_TABLE;

export default BuildSystem;
