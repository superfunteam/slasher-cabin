/**
 * NightManager — THE DIRECTOR.
 *
 * OWNER: Director agent. Owns the night loop, the clock, pacing, story beats, escalation,
 * scoring, saving, and the between-night transition. Every other system plays; this one
 * decides when.
 *
 * ------------------------------------------------------------------------------------------
 * CANON
 *   ARCHITECTURE.md §5   the only events this file emits:
 *                        game:start · night:begin · night:complete · night:failed · story:beat
 *                        (plus ui:toast / audio:sfx / audio:vo, which §5 marks "anyone")
 *   GAME_DESIGN.md §2    the canonical night table — slots, seconds, stages. Transcribed below.
 *   GAME_DESIGN.md §5    the loop, the phase rate table, and §5.4's rubber band
 *   GAME_DESIGN.md §13   the escalation ladder and what actually ends a run
 *   GAME_DESIGN.md §14   autosave slots and what restoring resets
 *   GAME_DESIGN.md §15   the Score object and the card that loses lines
 *   GAME_DESIGN.md §17   the first five minutes — taught by the manual, never by text
 *   STORY.md / Script.js night titles, beats, flags, images, tone
 *
 *   BINDING REVISIONS honoured here:
 *     - THE STORM IS NIGHT 6. Night 5 is the whiteout-fog night (§0.2 C2). The Night-6
 *       weather arc is the only place this file asks Weather for a permissive loud window.
 *     - Gameplay constants are NEVER routed through settings.tier() (§20.4). Quality changes
 *       pixels; difficulty changes numbers. This file reads settings.difficulty only.
 *     - §20.5's six rejections are not re-litigated.
 *
 * ------------------------------------------------------------------------------------------
 * PUBLIC API
 *
 *   new NightManager(ctx); await init(); update(dt, elapsed); resize(w, h); dispose();
 *
 *   // reads (the contract in the brief)
 *   night · phase · timeOfNight (0..1) · tension (0..1) · objective · score
 *
 *   // more reads
 *   blueprint · nightDef · stage · stageCount · slotsTotal · slotsDone · secondsRemaining
 *   patrolDensity · suspicion · lull · pressure · inChase · dawnAt · toneOfNight
 *
 *   // loop control
 *   startNight(n, opts)   completeNight()     failNight(reason)    abandonNight(reason)
 *   setPhase(p)           setTimeOfNight(t)   enterChase(reason)   exitChase(reason)
 *
 *   // pacing (the conductor's baton)
 *   requestLull(seconds, reason)      applyPressure(kind)      setPacingEnabled(on)
 *
 *   // story
 *   fireBeat(id)          chooseEnding(which)
 *
 *   // escalation — Campers calls these; they are the ladder's only entry points
 *   notifySpotted(payload)  notifyInvestigation()  notifyStructureReport()
 *   notifyReport(kind)      notifyBodyFound()      notifyExposed(on)
 *
 *   // scoring
 *   buildScore(final)     reportCard(score, night)
 *
 *   // save / load (§14)
 *   saveSlot(name)        loadSlot(name)      listSaves()      restoreNight(n)
 *
 *   // statics
 *   NightManager.NIGHTS · .TUNING · .CARD_LINES · .ANCHORS
 *
 * Every ctx.systems.get() below is null-checked and every cross-module call is behind a
 * typeof guard. This file must construct, init and run with EVERY other system missing.
 */

import * as THREE from 'three';
import { Log } from '../core/Log.js';
import { Rand } from '../core/Rand.js';
import Script from '../story/Script.js';

// =================================================================================================
// THE CANONICAL NIGHT TABLE — GAME_DESIGN.md §2 and §12.1. No other table in this repository may
// state a different value for any cell here. Script.js's own duration/slot fields predate the
// v2.0 rewrite; where they disagree, THIS table wins (GAME_DESIGN §0.1 rank 5 owns the numbers).
// =================================================================================================

/**
 * severity  = 0.5*rain + 0.3*wind + 0.2*fog  (§2.1, from ART_DIRECTION §4.5)
 * darkness  = the tonal axis, 0 = pure comedy, 1 = no comedy at all. NIGHT 7 IS 1.00.
 * patrolMin/Max floor and cap §13.1's `2 + floor(suspicion*6)`. Night 6 is pinned at 2 both
 * ways: the pacing band may not raise it (§12.7) — emptiness is that night's horror.
 */
export const NIGHTS = Object.freeze([
  Object.freeze({
    n: 1, slots: 12, seconds: 800, stages: 2, cumulative: 12,
    campers: 1, patrolMin: 1, patrolMax: 1,
    rain: 0.15, wind: 0.20, fog: 0.35, severity: 0.23, maskFloor: 0.089,
    tone: 'comedy', darkness: 0.05, grammar: 'G1',
    title: 'FOUNDATION (A)', roster: ['dale'],
  }),
  Object.freeze({
    n: 2, slots: 14, seconds: 975, stages: 3, cumulative: 26,
    campers: 3, patrolMin: 2, patrolMax: 3,
    rain: 0.40, wind: 0.35, fog: 0.50, severity: 0.42, maskFloor: 0.197,
    tone: 'comedy-with-a-witness', darkness: 0.18, grammar: 'G2',
    title: 'UPRIGHTS (B x4) — SUPPORT WHILE FIXING', roster: ['dale', 'marg', 'coop', 'robin'],
  }),
  Object.freeze({
    n: 3, slots: 13, seconds: 950, stages: 3, cumulative: 39,
    campers: 4, patrolMin: 2, patrolMax: 4,
    rain: 0.10, wind: 0.55, fog: 0.65, severity: 0.43, maskFloor: 0.151,
    tone: 'tension', darkness: 0.36, grammar: 'G3',
    title: 'DO NOT OVERTIGHTEN', roster: ['dale', 'marg', 'coop', 'robin', 'bev'],
  }),
  Object.freeze({
    n: 4, slots: 16, seconds: 1050, stages: 3, cumulative: 55,
    campers: 5, patrolMin: 2, patrolMax: 5,
    rain: 0.75, wind: 0.60, fog: 0.55, severity: 0.63, maskFloor: 0.357,
    tone: 'the-comedy-dies', darkness: 0.62, grammar: 'G4',
    title: 'IF PARTS ARE MISSING, DO NOT RETURN TO STORE',
    roster: ['dale', 'marg', 'coop', 'robin', 'bev'],
  }),
  Object.freeze({
    n: 5, slots: 10, seconds: 1175, stages: 2, cumulative: 65,
    campers: 5, patrolMin: 2, patrolMax: 5,
    rain: 0.25, wind: 0.30, fog: 0.85, severity: 0.47, maskFloor: 0.141,
    tone: 'loneliness', darkness: 0.70, grammar: 'G5',
    title: 'THIS STEP REQUIRES TWO PERSONS', roster: ['marg', 'coop', 'robin', 'bev', 'teddy'],
  }),
  Object.freeze({
    // THE STORM IS HERE. Not Night 5. This is the only night where thunder-masking is
    // arithmetically available, and 17 slots of hammering is why it has to be (§7.5).
    n: 6, slots: 17, seconds: 1400, stages: 4, cumulative: 82,
    campers: 2, patrolMin: 2, patrolMax: 2,
    rain: 0.90, wind: 0.85, fog: 0.60, severity: 0.78, maskFloor: 0.457,
    tone: 'dread', darkness: 0.88, grammar: 'G6+G7',
    title: 'SOLD SEPARATELY', roster: ['robin', 'bev'],
  }),
  Object.freeze({
    // No clock. timeOfNight advances on beat completion, not on dt (§2).
    n: 7, slots: 8, seconds: Infinity, stages: 1, cumulative: 90,
    campers: 1, patrolMin: 0, patrolMax: 1,
    rain: 0.05, wind: 0.10, fog: 0.25, severity: 0.13, maskFloor: 0.037,
    tone: 'grief', darkness: 1.00, grammar: 'none',
    title: 'SOME ASSEMBLY REQUIRED', roster: ['robin'],
  }),
]);

// =================================================================================================
// TUNING. A pacing pass edits this object and nothing else. Every number carries its section.
// =================================================================================================

export const TUNING = Object.freeze({
  // --- briefing (§5.1: the clock does NOT run here; it is free and it is where the comedy lands)
  briefingMin: 4.2,          // s — title card 2.4 + hand-wipe 0.9 + a breath. Never shorter.
  briefingHold: 12.0,        // s — auto-advance if the player never closes the manual
  briefingHoldNight1: 15.0,  // s — Night 1 gets longer. The first figure IS the tutorial (§17).
  briefingSkipAfter: 2.6,    // s — after this, closing the manual or moving starts the night

  // --- the first five minutes (§17). Night 1 only; every other night is 0.
  openingHoldSeconds: 300.0, // s — the rubber band stays off the scripted opening (§17 t=4:52)

  // --- night-end (§5.1 "Dawn: No clock, 0:50 card")
  closingImageHold: 6.0,     // s — the last stage lands, then the closing image, then the card
  nightEndAuto: 50.0,        // s — if Menu is absent, advance ourselves rather than stalling

  // --- tension (the conductor's ear)
  tensionAttack: 1.9,        // per second toward a higher value — fear arrives fast
  tensionRelease: 0.34,      // per second toward a lower value — and leaves slowly
  proximityRange: 45.0,      // m — §9.7's rally cap. Inside it, someone is a problem.
  creakMemory: 22.0,         // s — a creak stays in the player's throat this long
  creakWeightFull: 4.0,      // creaks in memory that saturate the creak term

  // --- the lull (horror without rest is noise)
  lullTrigger: 0.72,         // tension above this for lullTriggerFor seconds arms a lull
  lullTriggerFor: 6.0,       // s
  lullRelease: 0.38,         // tension falling below this fires the armed lull
  lullSeconds: 45.0,         // s of enforced quiet
  lullMusic: 0.16,           // Music.setIntensity ceiling during a lull

  // --- pressure (if the player has been safe and productive too long)
  pressureCalm: 0.26,        // tension under this counts as "safe"
  pressureIdleEarly: 78.0,   // s of safe+productive before the director leans in (nights 1-3)
  pressureIdleLate: 56.0,    // s (nights 4-7)
  pressureCooldown: 42.0,    // s between two pressure applications
  pressureProgress: 0.02,    // build progress gained that counts as "productive"

  // --- §5.4 the rubber band. Never touches detection, seating windows or slot counts.
  bandInterval: 8.0,         // s between evaluations
  bandAheadBy: 0.12,         // ahead of the clock by this -> wind +0.15 for 90 s, patrols +1
  bandBehindBy: 0.18,        // behind -> quietly relocate one un-found Tier-3 item
  bandBehindHard: 0.35,      // far behind -> wind -0.20, next creak tick skipped
  bandWind: 0.15,
  bandWindRelief: -0.20,
  bandWindSeconds: 90.0,
  bandCooldown: 90.0,        // s between two applications of the same rung

  // --- chase (§5, §9.7)
  chaseEnterSuspicion: 0.55, // camp suspicion that, with someone close, is a chase
  chaseEnterDetection: 0.92, // a single camper this close to seeing you is a chase
  chaseClearBase: 12.0,      // s of broken line of sight before the chase releases
  chaseClearPerSearcher: 6.0,
  chaseClearMax: 30.0,       // §9.7: 30 s per Searching camper that must give up
  chaseSafeDistance: 25.0,   // m — nobody nearer than this counts as "lost them"
  chaseRidgeRadius: 9.0,     // m — the ridge is a real way out and it costs nothing to reach
  chaseMaxSeconds: 105.0,    // s — a chase that has clearly ended, ends
  chaseMusic: 0.88,

  // --- exposed (§13.2) — a forced retreat, never a game over
  exposedSeconds: 45.0,

  // --- escalation (§13.1)
  suspSpotted: 0.25,
  suspShortReport: 0.25,
  suspStructureReport: 0.15,
  suspInvestigations: 0.10,
  investigationsForRung1: 3,
  suspBodyFound: 0.35,
  reportedSuspicionFloor: 0.45,   // §13.2 — the next night starts here
  rangerAtOffset: 0.15,           // timeOfNight + this (§13.1 rung 5)

  // --- save (§14.1)
  autosaveSeconds: 60.0,
  saveKey: 'slashercabin.save.slots',

  // --- night 7 has no clock: timeOfNight advances on beats, eased
  night7Ease: 0.085,
  night7Ceiling: 0.985,
});

/**
 * §15.2 — the card, and how it dies. `until` is the last night the line is printed.
 * Lines per night must come out 12, 12, 12, 11, 9, 6, 1. There is a self-test in init().
 */
export const CARD_LINES = Object.freeze([
  Object.freeze({ key: 'header', label: 'ASSEMBLY REPORT — STEP {night} OF 7', until: 6, header: true }),
  Object.freeze({ key: 'partsInstalled', label: 'PARTS INSTALLED', until: 6 }),
  Object.freeze({ key: 'joinsCorrect', label: 'JOINS, CORRECT', until: 6 }),
  Object.freeze({ key: 'joinsNotAsIllustrated', label: 'JOINS, NOT AS ILLUSTRATED', until: 6 }),
  Object.freeze({ key: 'joinsRequiringReplacement', label: 'JOINS, REQUIRING REPLACEMENT', until: 6 }),
  Object.freeze({ key: 'fastenersSupplied', label: 'FASTENERS, SUPPLIED', until: 4 }),
  Object.freeze({ key: 'fastenersRequired', label: 'FASTENERS, REQUIRED', until: 4 }),
  Object.freeze({ key: 'creaks', label: 'AUDIBLE FROM STRUCTURE', until: 5 }),
  Object.freeze({ key: 'metresHauled', label: 'DISTANCE CARRIED', until: 5 }),
  Object.freeze({ key: 'timeRemaining', label: 'TIME REMAINING', until: 5 }),
  Object.freeze({ key: 'assemblyQuality', label: 'ASSEMBLY QUALITY', until: 6 }),
  Object.freeze({ key: 'thanks', label: 'THANK YOU FOR CHOOSING SELF-ASSEMBLY.', until: 3, footer: true }),
]);

/**
 * GAME_DESIGN §3.3, in the document's own coordinate frame (origin = the plot). These are the
 * LAST resort: `_anchor()` prefers Navmesh's published anchors, then Terrain's, and only then
 * these. Terrain and Navmesh own the world; §3.3 owns the distances.
 */
export const ANCHORS = Object.freeze({
  plot: [0, 0], cabin_site: [0, 0], build_site: [0, 0],
  pallet_a: [4, 12], pallet_b: [-9, 16], staging: [11, 24],
  woodpile: [33, 32], stump: [29, -5], ridge: [-58, 4], grave: [-36, -18],
  fire_road: [0, 62], sink: [-48, -35], canoe_rack: [61, -58], boathouse: [74, -61],
  dock: [86, -66], archery: [48, 110], tool_shed: [-22, 129], cabins: [18, 141],
  truck: [37, 145], office: [62, 142], mess_hall: [79, 148], payphone: [84, 154],
  county_road: [0, 240], lake: [0, -140],
});

/** Script anchor name -> Navmesh anchor name. Navmesh is authoritative when it has one. */
const NAV_ALIAS = Object.freeze({
  plot: 'plot', cabin_site: 'plot', build_site: 'plot',
  ridge: 'ridge', woodpile: 'woodpile', boathouse: 'boathouse',
  canoe_rack: 'canoe-rack', dock: 'dock', tool_shed: 'toolshed',
  mess_hall: 'mess', cabins: 'cabins', office: 'office', payphone: 'office',
  camp: 'camp', fire_road: 'trail-mid', lake: 'shore',
});

// -------------------------------------------------------------------------------------------
// module-scope scratch. Nothing in update() allocates.
// -------------------------------------------------------------------------------------------
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/** Module-scope so `_countState` allocates nothing at 60 Hz. */
const RE_ALERTED = /alert|panic/i;
const RE_SEARCHING = /search|curious|notic/i;
const RE_ROOF = /doorframe|batten|shingle|roof/i;
const RE_ANSEL = /ansel/i;
const RE_SMALL_CHAIR = /chair[-_ ]?small|small[-_ ]?chair/i;
const RE_ROBIN = /robin/i;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const finite = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** The canonical events this director listens to. Story triggers of kind 'event' index this. */
const WATCHED_EVENTS = Object.freeze([
  'build:pickup', 'build:drop', 'build:place', 'build:remove', 'build:creak',
  'build:stage-complete', 'tool:missing', 'tool:found',
  'player:spotted', 'player:hidden', 'noise:emit',
  'ui:blueprint-open', 'ui:blueprint-close',
]);

// =================================================================================================
export class NightManager {
  constructor(ctx) {
    this.ctx = ctx ?? {};
    this.bus = this.ctx.bus ?? null;

    const seed = finite(this.ctx.settings?.seed ?? this.ctx.settings?.get?.('seed'), 0x51a5cab);
    this.rand = new Rand((seed ^ 0x4d1c7) >>> 0);

    // --- the contract reads -------------------------------------------------------------
    this.night = clamp(Math.round(finite(this.ctx.state?.night, 1)), 1, 7);
    this._phase = this.ctx.state?.phase ?? 'menu';
    this._ton = clamp01(finite(this.ctx.state?.timeOfNight, 0));
    this._tension = 0;
    this._tensionRaw = 0;

    /** Mutated in place — never reallocated. Nothing here is ever rendered as a prompt (§17). */
    this.objective = {
      id: 'menu', kind: 'menu', night: this.night, stage: 1, stageCount: 1,
      slotsDone: 0, slotsTotal: 0, remaining: 0, ratio: 0, phase: 'menu',
      text: null,   // populated only when settings.devTelemetry is on. Never drawn by the game.
    };

    /** The live Score. Mutated in place; buildScore() refreshes it. */
    this._score = this._blankScore();
    this._scoreAt = -1e9;

    // --- night bookkeeping ----------------------------------------------------------------
    this.def = NIGHTS[0];
    this.blueprint = null;
    this._elapsed = 0;          // seconds of wall time this session
    this._phaseT = 0;           // seconds in the current phase
    this._buildSeconds = 0;     // seconds the clock has actually run this night
    this._started = false;      // has game:start been emitted this session
    this._ending = null;        // 'a' | 'b' | 'c' once chosen
    this._nightOver = false;
    this._closingT = -1;        // >= 0 while the closing image is held
    this._autoStartPending = 0; // s until we start the night ourselves when no UI does
    this._manualClosed = false; // the player closed the briefing manual — start the night

    // --- pacing state ---------------------------------------------------------------------
    this._pacingEnabled = true;
    // §17: for the first five minutes of Night 1 the sequence is scripted theatre, so the
    // rubber band (§5.4) may not touch it. Build seconds before the band is allowed to run;
    // 0 on every other night. Held separately from `_pacingEnabled` so that releasing it at
    // t=5:00 cannot silently undo an external setPacingEnabled(false).
    this._openingHold = 0;
    this._bandT = 0;
    this._bandLast = { ahead: -1e9, behind: -1e9, hard: -1e9 };
    this._lull = 0;             // seconds of lull remaining
    this._lullArmed = 0;        // seconds tension has been above lullTrigger
    this._lullReason = null;
    this._pressureIdle = 0;
    this._pressureCool = 0;
    this._pressureIndex = 0;
    this._lastProgress = 0;
    this._patrolBonus = 0;      // pacing-owned patrol adds; the ladder's adds are separate
    this._patrolLadder = 0;
    this._patrolDensity = 2;
    this._structurePatrols = 0; // how many we asked Navmesh for (ladder + pressure)

    // --- chase / exposure ------------------------------------------------------------------
    this._chase = false;
    this._chaseT = 0;
    this._chaseClear = 0;
    this._chaseReason = null;
    this._exposed = 0;

    // --- escalation (§13.1) -----------------------------------------------------------------
    this._rungs = new Set();
    this._investigations = 0;
    this._spottedThisNight = 0;
    this._rangerAt = Infinity;

    // --- creak / noise memory for the tension model -----------------------------------------
    this._creakMemory = 0;
    this._creaksThisNight = 0;
    this._hammerCount = 0;

    // --- story --------------------------------------------------------------------------
    this._beats = [];           // [{ id, trigger, fired, def }]
    this._beatsFired = 0;
    this._scripted = null;      // { id, seconds, t }
    this._onboard = [];         // night 1 only; [{ t, done, fn }]
    this._loonAt = -1;

    // --- save -----------------------------------------------------------------------------
    this._autosaveT = 0;
    this._slots = this._readSlots();

    // --- plumbing --------------------------------------------------------------------------
    this._unsubs = [];
    this._eventBeats = new Map();   // eventName -> [beat records]
    this._disposed = false;
    this._visHandler = null;
    this._sysCache = new Map();
    this._sysCacheAt = -1e9;
  }

  // ===============================================================================================
  // LIFECYCLE
  // ===============================================================================================

  async init() {
    this._bind();
    this._selfTestCard();

    const st = this.ctx.state;
    if (st) {
      // §20.2's requested GameState fields. We never assume they exist; we create them if they
      // do not, because a save written without them must still load.
      if (!st.stats || typeof st.stats !== 'object') st.stats = {};
      const s = st.stats;
      s.reportsTotal = finite(s.reportsTotal, 0);
      s.shortReports = finite(s.shortReports, 0);
      s.longReports = finite(s.longReports, 0);
      s.kills = finite(s.kills, 0);
      s.metresHauled = finite(s.metresHauled, 0);
      s.metresWalked = finite(s.metresWalked, 0);
      s.campersEvaded = finite(s.campersEvaded, 0);
      s.perfectJoins = finite(s.perfectJoins, 0);
      if (!Array.isArray(st.nightsReported)) st.nightsReported = [];
      if (!Array.isArray(st.nightResults)) st.nightResults = [];
      if (!st.storyFlags || typeof st.storyFlags !== 'object') st.storyFlags = {};
      st.suspicionFloor = finite(st.suspicionFloor, 0);
      st.rolloverSlots = finite(st.rolloverSlots, 0);
      st.stagePenalty = finite(st.stagePenalty, 0);
      st.tension = 0;
      st.director = { lull: 0, pressure: 0, chase: false, patrolDensity: 2 };
    }

    this._applyNightDef(this.night, false);

    // If the Menu never opens — a headless run, a screenshot harness, a build with no UI — the
    // game must still play. Start the night ourselves after a beat, but only if nothing else has.
    if (this._phase === 'menu' || !this._phase) {
      const auto = this.ctx.settings?.get?.('autoStart');
      if (auto !== false) this._autoStartPending = 1.2;
    }

    Log.debug(`NightManager ready: night ${this.night}, ${this.def.slots} slots, `
      + `${this.def.stages} stages, ${Number.isFinite(this.def.seconds) ? `${this.def.seconds}s` : 'unclocked'}.`);
  }

  update(dt, elapsed) {
    if (this._disposed) return;
    const d = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
    this._elapsed = Number.isFinite(elapsed) ? elapsed : this._elapsed + d;
    this._phaseT += d;

    if (this._autoStartPending > 0) {
      this._autoStartPending -= d;
      if (this._autoStartPending <= 0) {
        this._autoStartPending = 0;
        if (this._phase === 'menu') this.startNight(this.night, { auto: true });
      }
    }

    switch (this._phase) {
      case 'briefing': this._updateBriefing(d); break;
      case 'build': this._updateBuild(d); break;
      case 'chase': this._updateBuild(d); break;   // the clock runs in chase too (§5.1)
      case 'night-end': this._updateNightEnd(d); break;
      default: break;
    }

    // Tension is computed in every playable phase — the report card and the music both read it.
    if (this._phase === 'build' || this._phase === 'chase' || this._phase === 'briefing') {
      this._updateTension(d);
    } else if (this._tension > 0) {
      this._tension = Math.max(0, this._tension - d * TUNING.tensionRelease);
    }

    this._publish();
  }

  resize(_w, _h) { /* the director owns no pixels */ }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const off of this._unsubs) { try { off?.(); } catch { /* noop */ } }
    this._unsubs.length = 0;
    if (this._visHandler && typeof document !== 'undefined') {
      try { document.removeEventListener('visibilitychange', this._visHandler); } catch { /* noop */ }
    }
    this._visHandler = null;
    // Hand back anything we were holding down in another system.
    this._releaseMusic();
    this._post()?.setPanic?.(0);
    while (this._structurePatrols > 0) { this._nav()?.removeStructurePatrol?.(); this._structurePatrols--; }
    this._beats.length = 0;
    this._eventBeats.clear();
    this._onboard.length = 0;
    this._sysCache.clear();
    this.blueprint = null;
  }

  // ===============================================================================================
  // THE CONTRACT READS
  // ===============================================================================================

  get phase() { return this._phase; }
  get timeOfNight() { return this._ton; }
  get tension() { return this._tension; }
  get score() { return this.buildScore(false); }

  get nightDef() { return this.def; }
  get stage() { return clamp(Math.round(finite(this._build()?.stage, 1)), 1, this.def.stages); }
  get stageCount() { return this.def.stages; }
  get slotsTotal() { return this.def.slots; }
  get slotsDone() { return this._installedThisNight(); }
  get secondsRemaining() {
    if (!Number.isFinite(this.def.seconds)) return Infinity;
    return Math.max(0, (1 - this._ton) * this.def.seconds);
  }
  get dawnAt() { return this.def.seconds; }
  get toneOfNight() { return this.def.tone; }
  get darkness() { return this.def.darkness; }
  get patrolDensity() { return this._patrolDensity; }
  get suspicion() { return clamp01(finite(this.ctx.state?.suspicion, 0)); }
  get lull() { return this._lull > 0 ? this._lull : 0; }
  get pressure() { return this._pressureCool > 0 ? clamp01(this._pressureCool / TUNING.pressureCooldown) : 0; }
  get inChase() { return this._chase; }
  get ending() { return this._ending; }
  get beatsFired() { return this._beatsFired; }

  // ===============================================================================================
  // LOOP CONTROL
  // ===============================================================================================

  /**
   * BRIEFING → BUILD → (CHASE) → NIGHT-END. Menu calls this; so does the between-night
   * transition; so does a restore.
   */
  startNight(n, opts = {}) {
    const night = clamp(Math.round(finite(n, this.night)), 1, 7);
    this._applyNightDef(night, true);

    const st = this.ctx.state;
    if (st) {
      st.night = night;
      st.timeOfNight = 0;
      st.spotted = false;
      st.creaks = 0;
      // §13.2: a reported night leaves the camp watching. The floor persists; the rest resets.
      st.suspicion = clamp01(Math.max(finite(st.suspicionFloor, 0), 0));
      st.chase = false;
      st.scriptedBeat = null;
      st.grabRefused = false;
      st.tutorialSafe = night === 1;
    }

    this._ton = 0;
    this._buildSeconds = 0;
    this._nightOver = false;
    this._closingT = -1;
    this._ending = null;
    this._creakMemory = 0;
    this._creaksThisNight = 0;
    this._hammerCount = 0;
    this._investigations = 0;
    this._spottedThisNight = 0;
    this._rungs.clear();
    this._rangerAt = Infinity;
    this._lull = 0;
    this._lullArmed = 0;
    this._pressureIdle = 0;
    this._pressureCool = 0;
    this._patrolBonus = 0;
    this._patrolLadder = 0;
    this._bandT = 0;
    this._openingHold = night === 1 ? TUNING.openingHoldSeconds : 0;
    this._bandLast.ahead = this._bandLast.behind = this._bandLast.hard = -1e9;
    this._lastProgress = 0;
    this._autosaveT = 0;
    this._exposed = 0;
    this._chase = false;
    this._chaseT = 0;
    this._chaseClear = 0;
    this._scripted = null;
    this._loonAt = -1;
    this._beatsFired = 0;
    this._scoreAt = -1e9;
    this._resetScore();
    while (this._structurePatrols > 0) { this._nav()?.removeStructurePatrol?.(); this._structurePatrols--; }

    // Weather first: it derives its whole schedule from the night, and the storm is Night 6.
    this._weather()?.setNight?.(night);

    // The blueprint IS the night:begin payload. Regenerated from (night, seed), never saved.
    let bp = null;
    try { bp = this._blueprintSys()?.forNight?.(night) ?? null; }
    catch (e) { Log.once('nm:bp', 'NightManager: Blueprint.forNight threw', e); }
    this.blueprint = bp;

    this._buildBeats(night);
    this._buildOnboarding(night);

    // Night 7 takes everything away (§12.8): no HUD, no reticle, no prompts, no creak feedback.
    this._hud()?.setStripped?.(night === 7);

    if (!this._started) {
      this._started = true;
      this._emit('game:start', {});
    }

    this.setPhase('briefing');
    this._phaseT = 0;
    this._emit('night:begin', { night, blueprint: bp });
    this._autosave(`night-${night}-start`);

    // Opening image (Script.nights[n].openingImage) is a sound, not a caption. §17 t=0:00.
    if (night === 1 && !opts.restored) {
      this._emit('audio:sfx', { id: 'crate_settle', volume: 0.9 });
    }

    // §17 t=0:00 — he arrives at dusk with the lamp already burning. MUST come after the
    // night:begin emit above: Flashlight's own handler for that event refills the tank and
    // forces `on = false`, so anything we do before it is overwritten. See _lightTheLamp().
    this._lightTheLamp(night);

    this._applyPatrolDensity();
    this._fireTrigger('night-begin');
    Log.debug(`night:begin ${night} — ${this.def.title} — ${this.def.slots} slots / ${this.def.stages} stages`);
    return true;
  }

  /** All stages done, or dawn with the work complete. Emits night:complete { night, score }. */
  completeNight() {
    if (this._nightOver) return false;
    this._nightOver = true;
    this._fireTrigger('night-complete');

    const score = this.buildScore(true);
    const st = this.ctx.state;
    if (st) {
      st.timeOfNight = this._ton;
      if (Array.isArray(st.nightResults)) st.nightResults[this.night - 1] = score;
      st.rolloverSlots = Math.max(0, this.def.slots - score.partsInstalled);
      // A clean night relaxes the camp a little. It never relaxes the ladder's floor.
      st.suspicionFloor = clamp01(finite(st.suspicionFloor, 0) * 0.75);
    }

    this._endOfNightTeardown();
    this.setPhase('night-end');
    this._phaseT = 0;
    this._emit('night:complete', { night: this.night, score });
    this._autosave(`night-${this.night}-end`);
    return true;
  }

  /**
   * §13.2. `reason` is one of: 'reported' | 'dawn' | 'exposed' | 'evacuated' | 'incomplete' |
   * 'abandoned'. Only 'evacuated' and 'incomplete' set phase 'gameover'; everything else is an
   * escalating consequence, and the next night still happens.
   */
  failNight(reason = 'dawn') {
    if (this._nightOver) return false;
    const st = this.ctx.state;
    const r = String(reason || 'dawn');

    // Does this failure end the run? §13.2's two game-overs, and only those two.
    let final = r;
    if (r === 'reported') {
      if (st) {
        if (!Array.isArray(st.nightsReported)) st.nightsReported = [];
        if (!st.nightsReported.includes(this.night)) st.nightsReported.push(this.night);
        st.suspicionFloor = Math.max(finite(st.suspicionFloor, 0), TUNING.reportedSuspicionFloor);
        st.stagePenalty = finite(st.stagePenalty, 0) + 1;   // the camp posts a watch on the ridge
      }
      const reportedNights = st?.nightsReported?.length ?? 0;
      if (reportedNights >= 3 || this.night >= 6) final = 'evacuated';
    }
    if (r === 'dawn' && this.night === 6 && this._roofOrDoorframeUnbuilt()) final = 'incomplete';

    this._nightOver = true;
    const score = this.buildScore(true);
    if (st) {
      st.timeOfNight = this._ton;
      if (Array.isArray(st.nightResults)) st.nightResults[this.night - 1] = score;
      st.rolloverSlots = Math.max(0, this.def.slots - score.partsInstalled);
    }

    this._endOfNightTeardown();
    if (final === 'evacuated' || final === 'incomplete') {
      this.setPhase('gameover');
    } else {
      this.setPhase('night-end');
    }
    this._phaseT = 0;
    this._emit('night:failed', { night: this.night, reason: final });
    this._autosave(`night-${this.night}-end`);
    Log.debug(`night:failed ${this.night} — ${final}`);
    return true;
  }

  /** Menu's pause-menu "abandon night". No confirmation shaming copy anywhere near this. */
  abandonNight(reason = 'abandoned') {
    if (this._nightOver) { this.setPhase('menu'); return true; }
    return this.failNight(reason === 'abandoned' ? 'abandoned' : String(reason));
  }

  setPhase(p) {
    const next = String(p);
    if (next === this._phase) return this._phase;
    const prev = this._phase;
    this._phase = next;
    this._phaseT = 0;
    try { this.ctx.state?.setPhase?.(next); }
    catch { if (this.ctx.state) this.ctx.state.phase = next; }
    if (this.ctx.state && this.ctx.state.phase !== next) this.ctx.state.phase = next;
    this._syncObjective();
    Log.debug(`phase ${prev} -> ${next}`);
    return this._phase;
  }

  /** Debug / shot harness / restore. Writes straight through to ctx.state so Sky follows. */
  setTimeOfNight(t) {
    this._ton = clamp01(finite(t, this._ton));
    if (this.ctx.state) this.ctx.state.timeOfNight = this._ton;
    if (Number.isFinite(this.def.seconds)) this._buildSeconds = this._ton * this.def.seconds;
    return this._ton;
  }

  /**
   * A suspicion spike. Different music, different camper behaviour, and a real way out —
   * break line of sight and wait, or reach the ridge.
   */
  enterChase(reason = 'spotted') {
    if (this._chase || this._nightOver) return false;
    if (this._phase !== 'build' && this._phase !== 'chase') return false;
    this._chase = true;
    this._chaseT = 0;
    this._chaseClear = 0;
    this._chaseReason = String(reason);
    this.setPhase('chase');
    if (this.ctx.state) this.ctx.state.chase = true;

    this._music()?.setIntensity?.(TUNING.chaseMusic);
    this._post()?.setPanic?.(1);
    // Campers get told the temperature, never told where the player is.
    const c = this._campers();
    if (c && typeof c.setAlertLevel === 'function') { try { c.setAlertLevel(1); } catch { /* noop */ } }
    if (c && typeof c.beginChase === 'function') { try { c.beginChase(this._chaseReason); } catch { /* noop */ } }
    // A chase is loud. Give the storm something to do about it.
    if (this.night >= 4) this._weather()?.requestCover?.(14);
    Log.debug(`chase begins (${this._chaseReason})`);
    return true;
  }

  exitChase(reason = 'lost') {
    if (!this._chase) return false;
    this._chase = false;
    this._chaseT = 0;
    this._chaseClear = 0;
    if (this.ctx.state) this.ctx.state.chase = false;
    if (!this._nightOver) this.setPhase('build');

    this._post()?.setPanic?.(0);
    const c = this._campers();
    if (c && typeof c.endChase === 'function') { try { c.endChase(String(reason)); } catch { /* noop */ } }
    if (c && typeof c.setAlertLevel === 'function') { try { c.setAlertLevel(0); } catch { /* noop */ } }

    // Horror without rest is noise. The lull is not optional after a chase.
    this.requestLull(TUNING.lullSeconds, `chase:${reason}`);
    const st = this.ctx.state;
    if (st?.stats) st.stats.campersEvaded = finite(st.stats.campersEvaded, 0) + 1;
    Log.debug(`chase ends (${reason})`);
    return true;
  }

  // ===============================================================================================
  // PHASE UPDATES
  // ===============================================================================================

  /**
   * BRIEFING. The clock does not run (§5.1). Tonight's manual appears; the comedy lands here
   * and it is given room. The player leaves it by closing the manual or by walking.
   */
  _updateBriefing(dt) {
    void dt;
    if (this._phaseT < TUNING.briefingMin) return;
    const hold = this.night === 1 ? TUNING.briefingHoldNight1 : TUNING.briefingHold;

    let leave = this._phaseT >= hold;
    if (!leave && this._phaseT >= TUNING.briefingSkipAfter) {
      if (this._manualClosed) leave = true;
      else {
        const p = this._player();
        const v = p?.velocity;
        if (v && (v.x * v.x + v.z * v.z) > 0.25) leave = true;
      }
    }
    if (leave) {
      this._manualClosed = false;
      this.setPhase('build');
    }
  }

  /** BUILD (and CHASE — the clock runs in both). Dawn is the only real currency. */
  _updateBuild(dt) {
    if (this._nightOver) return;

    // ---- the clock -------------------------------------------------------------------------
    if (Number.isFinite(this.def.seconds)) {
      this._buildSeconds += dt;
      this._ton = clamp01(this._buildSeconds / this.def.seconds);
    } else {
      // Night 7 (§2): no dawn to beat. Time advances on beat completion, eased so the sky moves.
      const total = Math.max(1, this._beats.length);
      const target = Math.min(TUNING.night7Ceiling, this._beatsFired / total);
      this._ton += (target - this._ton) * (1 - Math.exp(-dt * TUNING.night7Ease));
      if (this._ton < 0) this._ton = 0;
    }
    if (this.ctx.state) this.ctx.state.timeOfNight = this._ton;

    // ---- memory decay ----------------------------------------------------------------------
    if (this._creakMemory > 0) this._creakMemory = Math.max(0, this._creakMemory - dt / TUNING.creakMemory);
    if (this._pressureCool > 0) this._pressureCool = Math.max(0, this._pressureCool - dt);
    if (this._lull > 0) {
      this._lull -= dt;
      if (this._lull <= 0) this._endLull();
    }

    // ---- scripted beats hold the floor ------------------------------------------------------
    if (this._scripted) {
      this._scripted.t += dt;
      if (this._scripted.t >= this._scripted.seconds) this._endScripted();
    }

    // ---- story ------------------------------------------------------------------------------
    this._evalTimeTriggers();
    this._evalProximityTriggers();
    this._evalFlagTriggers();
    this._updateOnboarding(dt);

    // ---- the ladder's timed consequences ------------------------------------------------------
    if (this._ton >= this._rangerAt && !this._rungs.has('ranger')) {
      this._rungs.add('ranger');
      const c = this._campers();
      if (c && typeof c.spawnRanger === 'function') { try { c.spawnRanger(); } catch { /* noop */ } }
      if (this.ctx.state) this.ctx.state.rangerArrived = true;
      Log.debug('escalation rung 5 — the truck.');
    }

    // ---- chase / exposure ---------------------------------------------------------------------
    this._updateThreat(dt);

    // ---- pacing -------------------------------------------------------------------------------
    // §17 t=4:52: "every verb in §9.6 is now motivated, so the director stops holding the floor."
    // Before that, on Night 1 only, the band is silent. It is not a difficulty concession — the
    // band's "behind by > 0.18" response RELOCATES an un-found Tier-3 item (§5.4), and the whole
    // 2:05–2:40 sequence is the player reading a contour inset that points at a fixed fallen log.
    // Moving the sixth pier out from under that inset would break §17's central joke.
    if (this._pacingEnabled && !this._scripted && this._buildSeconds >= this._openingHold) {
      this._bandT += dt;
      if (this._bandT >= TUNING.bandInterval) { this._bandT = 0; this._updateRubberBand(); }
      this._updatePressure(dt);
    }

    // ---- autosave (§14.1) ----------------------------------------------------------------------
    this._autosaveT += dt;
    if (this._autosaveT >= TUNING.autosaveSeconds) { this._autosaveT = 0; this._autosave('checkpoint'); }

    // ---- the end -------------------------------------------------------------------------------
    if (this._closingT >= 0) {
      this._closingT += dt;
      if (this._closingT >= TUNING.closingImageHold) { this._closingT = -1; this.completeNight(); }
      return;
    }
    if (this._workComplete()) { this._beginClosingImage(); return; }
    if (Number.isFinite(this.def.seconds) && this._ton >= 1) {
      // §13.2 'dawn': the night ends with the stage incomplete. Not a game over.
      this.failNight('dawn');
    }
  }

  /** NIGHT-END. Menu renders the card. If Menu is missing we advance ourselves. */
  _updateNightEnd(dt) {
    void dt;
    if (this._menu()) return;   // the UI owns the transition when it exists
    if (this._phaseT < TUNING.nightEndAuto) return;
    const next = this.night + 1;
    if (next > 7) { this.setPhase('menu'); return; }
    if (this.ctx.state) {
      this.ctx.state.night = next;
      try { this.ctx.state.resetNight?.(); } catch { /* noop */ }
    }
    this.startNight(next);
  }

  /** The last slot lands, and the game holds on Script's closingImage before the card. */
  _beginClosingImage() {
    if (this._closingT >= 0) return;
    this._closingT = 0;
    this._music()?.setIntensity?.(0.10);
    Log.debug(`night ${this.night} work complete at timeOfNight ${this._ton.toFixed(3)}`);
  }

  // ===============================================================================================
  // TENSION — the most important number this file produces
  // ===============================================================================================

  /**
   * Five inputs, one scalar, asymmetric smoothing. Fear arrives in a second and leaves in ten,
   * which is what makes a lull feel like relief rather than an absence.
   */
  _updateTension(dt) {
    const nearest = this._nearestCamperDistance();
    const detection = this._maxDetection();
    const susp = this.suspicion;

    // proximity — §9.7's 45 m rally cap is the range at which someone is a problem
    const prox = Number.isFinite(nearest) ? clamp01(1 - nearest / TUNING.proximityRange) : 0;
    // creak pressure — a structure that has been talking is a structure that will be visited
    const creak = clamp01(this._creakMemory);
    // time pressure — only real once the work is behind the clock
    const deficit = Math.max(0, this._ton - this._progressFraction());
    const timePressure = Number.isFinite(this.def.seconds) ? clamp01(deficit / 0.30) : 0;
    // the night's own floor: the tonal axis is a bed, not a spike
    const bed = this.def.darkness * 0.14;

    let raw = clamp01(
      0.34 * prox
      + 0.30 * clamp01(detection)
      + 0.16 * susp
      + 0.10 * creak
      + 0.10 * timePressure,
    );
    raw = clamp01(Math.max(raw, bed));
    if (this._chase) raw = Math.max(raw, 0.86);
    if (this._exposed > 0) raw = 1;
    // A lull is a promise. It caps what the director is allowed to make the player feel.
    if (this._lull > 0 && !this._chase) raw = Math.min(raw, 0.34);

    this._tensionRaw = raw;
    const k = raw > this._tension ? TUNING.tensionAttack : TUNING.tensionRelease;
    this._tension += (raw - this._tension) * (1 - Math.exp(-dt * k));
    this._tension = clamp01(this._tension);

    // Arm and fire the lull off the shape of the curve, not off a timer.
    if (this._tension >= TUNING.lullTrigger) {
      this._lullArmed += dt;
    } else if (this._lullArmed >= TUNING.lullTriggerFor && this._tension <= TUNING.lullRelease) {
      this._lullArmed = 0;
      if (this._lull <= 0) this.requestLull(TUNING.lullSeconds, 'after-spike');
    } else if (this._tension < TUNING.lullRelease * 0.6) {
      this._lullArmed = 0;
    }

    if (this._chase) {
      // Panic follows tension inside a chase; Postprocessing smooths it itself.
      this._post()?.setPanic?.(clamp01(0.55 + 0.45 * this._tension));
    }
  }

  /** Chase entry/exit and the 'exposed' forced retreat. Never teleports anyone. */
  _updateThreat(dt) {
    const detection = this._maxDetection();
    const nearest = this._nearestCamperDistance();
    const alerted = this._alertedCount();

    // --- exposed (§13.2): fully lit within 8 m of 3+ Alerted campers -------------------------
    const exposedNow = alerted >= 3 && Number.isFinite(nearest) && nearest < 8 && this._playerLum() > 0.5;
    if (exposedNow && this._exposed <= 0) {
      this._exposed = TUNING.exposedSeconds;
      const c = this._campers();
      if (c && typeof c.forceSearchAll === 'function') { try { c.forceSearchAll(); } catch { /* noop */ } }
      this.enterChase('exposed');
      Log.debug('exposed — 45 s escape window');
    } else if (this._exposed > 0) {
      this._exposed -= dt;
      if (this._exposed <= 0) {
        this._exposed = 0;
        if (exposedNow) {
          // Still standing in it after 45 s. Someone talks. It is not a game over.
          this.notifyReport('short');
        }
        this.requestLull(TUNING.lullSeconds, 'exposed-survived');
      }
    }

    // --- chase --------------------------------------------------------------------------------
    if (!this._chase) {
      const spike = detection >= TUNING.chaseEnterDetection
        || (this.suspicion >= TUNING.chaseEnterSuspicion && Number.isFinite(nearest) && nearest < 18)
        || this.ctx.state?.spotted === true;
      if (spike) this.enterChase(detection >= TUNING.chaseEnterDetection ? 'seen' : 'suspicion');
      return;
    }

    this._chaseT += dt;

    // Way out #1: the ridge. 58 m west and 11 m up, and it costs nothing to reach (§3.4).
    if (this._playerPos(_v0)) {
      if (this._anchor('ridge', _v1)) {
        const dx = _v0.x - _v1.x, dz = _v0.z - _v1.z;
        if (dx * dx + dz * dz < TUNING.chaseRidgeRadius * TUNING.chaseRidgeRadius) {
          this.exitChase('ridge');
          return;
        }
      }
    }

    // Way out #2: break line of sight and wait.
    const clearNeed = Math.min(
      TUNING.chaseClearMax,
      TUNING.chaseClearBase + TUNING.chaseClearPerSearcher * Math.max(0, this._searchingCount() - 1),
    );
    const hidden = detection < 0.2
      && (!Number.isFinite(nearest) || nearest > TUNING.chaseSafeDistance)
      && this.ctx.state?.spotted !== true;
    if (hidden) {
      this._chaseClear += dt;
      if (this._chaseClear >= clearNeed) { this.exitChase('lost'); return; }
    } else {
      this._chaseClear = Math.max(0, this._chaseClear - dt * 2);
    }

    if (this._chaseT >= TUNING.chaseMaxSeconds && this._tension < 0.55) this.exitChase('timeout');
  }

  // ===============================================================================================
  // PACING — the rubber band (§5.4), the lull, and the lean-in
  // ===============================================================================================

  setPacingEnabled(on) { this._pacingEnabled = !!on; return this._pacingEnabled; }

  /**
   * Pull the patrols, quiet the music, let the player breathe and work. A lull is invisible:
   * every lever it touches is weather, route cost and mix — never a gameplay constant.
   */
  requestLull(seconds = TUNING.lullSeconds, reason = 'director') {
    const s = Math.max(0, finite(seconds, TUNING.lullSeconds));
    if (s <= 0) return 0;
    const fresh = this._lull <= 0;
    this._lull = Math.max(this._lull, s);
    this._lullReason = String(reason);
    if (!fresh) return this._lull;

    // Give back everything pacing has taken, and ask Weather for stillness.
    if (this._patrolBonus > 0) { this._patrolBonus = 0; this._applyPatrolDensity(); }
    while (this._structurePatrols > this._patrolLadder) {
      this._nav()?.removeStructurePatrol?.(); this._structurePatrols--;
    }
    this._weather()?.requestWind?.(-0.12, Math.min(60, s));
    this._music()?.setIntensity?.(TUNING.lullMusic);
    const c = this._campers();
    if (c && typeof c.setPatrolPressure === 'function') { try { c.setPatrolPressure(0); } catch { /* noop */ } }
    if (this.ctx.state?.director) this.ctx.state.director.lull = s;
    Log.debug(`lull ${s.toFixed(0)}s (${this._lullReason})`);
    return this._lull;
  }

  _endLull() {
    this._lull = 0;
    this._lullReason = null;
    // Hand the score back to its own dread scalar — unless a chase started inside the lull,
    // in which case the chase still owns the mix.
    if (this._chase) this._music()?.setIntensity?.(TUNING.chaseMusic);
    else this._releaseMusic();
    if (this.ctx.state?.director) this.ctx.state.director.lull = 0;
    // The player has had their breath. The clock has not stopped.
    this._pressureIdle = 0;
  }

  /**
   * The player has been safe and productive too long. Lean in — with a route, a gust, or a
   * voice. Never with a spawn, never with a teleport, never with a number the player can catch.
   */
  applyPressure(kind = null) {
    if (this._lull > 0 || this._chase || this._scripted) return null;
    if (this._pressureCool > 0) return null;

    const kinds = ['patrol', 'gust', 'voice'];
    const pick = kind && kinds.includes(kind) ? kind : kinds[this._pressureIndex % kinds.length];
    this._pressureIndex++;
    this._pressureCool = TUNING.pressureCooldown;
    this._pressureIdle = 0;

    switch (pick) {
      case 'patrol': {
        // Route a patrol nearer. Navmesh owns the route; we only ask for the structure leg.
        const nav = this._nav();
        if (nav && typeof nav.addStructurePatrol === 'function' && this.night !== 6) {
          try { nav.addStructurePatrol(); this._structurePatrols++; } catch { /* noop */ }
        }
        const c = this._campers();
        if (c && typeof c.requestPatrolNear === 'function' && this._anchor('plot', _v0)) {
          try { c.requestPatrolNear(_v0.x, _v0.z); } catch { /* noop */ }
        } else if (this.def.patrolMax > this.def.patrolMin) {
          this._patrolBonus = Math.min(1, this._patrolBonus + 1);
          this._applyPatrolDensity();
        }
        break;
      }
      case 'gust': {
        // A gust that loads the structure into a creak. The weather does the talking.
        const w = this._weather();
        if (w) {
          try { w.requestGust?.(1.0, 0.6); } catch { /* noop */ }
          try { w.requestWind?.(0.10, 25); } catch { /* noop */ }
        }
        break;
      }
      default: {
        this._callOut();
        break;
      }
    }
    if (this.ctx.state?.director) this.ctx.state.director.pressure = pick;
    Log.debug(`pressure: ${pick}`);
    return pick;
  }

  _updatePressure(dt) {
    if (this._lull > 0 || this._chase || this._scripted) { this._pressureIdle = 0; return; }
    const progress = this._progressFraction();
    const productive = progress > this._lastProgress + TUNING.pressureProgress;
    if (productive) this._lastProgress = progress;

    if (this._tension <= TUNING.pressureCalm) this._pressureIdle += dt;
    else this._pressureIdle = Math.max(0, this._pressureIdle - dt * 1.5);

    const need = this.night <= 3 ? TUNING.pressureIdleEarly : TUNING.pressureIdleLate;
    if (this._pressureIdle >= need) this.applyPressure(null);
  }

  /**
   * §5.4, transcribed. Compares stagesDone/stagesTotal against timeOfNight. Touches weather,
   * patrol count, and one item position. Gameplay constants are never rubber-banded.
   */
  _updateRubberBand() {
    if (!Number.isFinite(this.def.seconds)) return;   // Night 7 has no clock to be behind
    const delta = this._progressFraction() - this._ton;
    const now = this._elapsed;

    if (delta > TUNING.bandAheadBy) {
      if (now - this._bandLast.ahead < TUNING.bandCooldown) return;
      this._bandLast.ahead = now;
      this._weather()?.requestWind?.(TUNING.bandWind, TUNING.bandWindSeconds);
      if (this.def.patrolMax > this.def.patrolMin) {
        this._patrolBonus = Math.min(2, this._patrolBonus + 1);
        this._applyPatrolDensity();
      }
      Log.debug(`band: ahead by ${delta.toFixed(2)} — the night turns`);
    } else if (delta < -TUNING.bandBehindHard) {
      if (now - this._bandLast.hard < TUNING.bandCooldown) return;
      this._bandLast.hard = now;
      this._weather()?.requestWind?.(TUNING.bandWindRelief, TUNING.bandWindSeconds);
      // "the next creak tick is skipped on every join" — BuildSystem owns the tick.
      const bs = this._build();
      if (bs && typeof bs.skipNextCreakTick === 'function') { try { bs.skipNextCreakTick(); } catch { /* noop */ } }
      if (this.ctx.state) this.ctx.state.creakGrace = 1;
      if (this._patrolBonus > 0) { this._patrolBonus = 0; this._applyPatrolDensity(); }
      Log.debug(`band: behind by ${(-delta).toFixed(2)} — a lull`);
    } else if (delta < -TUNING.bandBehindBy) {
      if (now - this._bandLast.behind < TUNING.bandCooldown) return;
      if (this._relocateShortfall()) this._bandLast.behind = now;
    }
  }

  /**
   * Behind by > 0.18: one un-found Tier-3 item is quietly relocated to its Tier-1 fallback —
   * and ONLY while the player has line of sight to neither position. The player reads it as
   * having missed it the first time.
   */
  _relocateShortfall() {
    const bs = this._build();
    const bp = this._blueprintSys();
    let list = null;
    try { list = bp?.shortfallsFor?.(this.night) ?? bs?.shortfalls ?? null; } catch { list = null; }
    if (!Array.isArray(list) || !list.length) return false;

    const found = this.ctx.state?.toolsFound;
    const target = list.find((s) => s && (s.tier | 0) >= 2 && !(Array.isArray(found) && found.includes(s.id)));
    if (!target) return false;

    // The line-of-sight gate. If we cannot test it, we do not do it — an item that teleports in
    // front of the player is the one failure this rung is not allowed to have.
    const phys = this._physics();
    const p = this._player();
    if (phys && typeof phys.lineOfSight === 'function' && p) {
      _v0.copy(p.eyePosition ?? p.headPosition ?? p.position ?? _v0);
      const pos = target.position;
      if (pos && Number.isFinite(pos.x)) {
        _v1.set(pos.x, finite(pos.y, _v0.y), pos.z);
        let visible = false;
        try { visible = !!phys.lineOfSight(_v0, _v1); } catch { visible = false; }
        if (visible) return false;
      }
      if (this._anchor('pallet_b', _v2)) {
        let visible2 = false;
        try { visible2 = !!phys.lineOfSight(_v0, _v2); } catch { visible2 = false; }
        if (visible2) return false;
      }
    }

    let moved = false;
    if (bs && typeof bs.relocateShortfall === 'function') {
      try { moved = !!bs.relocateShortfall(target.id, 1); } catch { moved = false; }
    }
    if (!moved && this.ctx.state) {
      // BuildSystem has no relocation verb yet: publish the intent so it can honour it later.
      this.ctx.state.pacingRelocation = { id: target.id, tier: 1, at: this._ton };
      moved = true;
    }
    if (moved) Log.debug(`band: relocated '${target.id}' to its Tier-1 fallback`);
    return moved;
  }

  /** §13.1: patrolDensity = 2 + floor(suspicion*6), capped AND floored by the night. */
  _applyPatrolDensity() {
    const base = 2 + Math.floor(this.suspicion * 6);
    const v = clamp(base + this._patrolBonus + this._patrolLadder, this.def.patrolMin, this.def.patrolMax);
    if (v === this._patrolDensity) return v;
    this._patrolDensity = v;
    const c = this._campers();
    if (c) {
      if (typeof c.setPatrolDensity === 'function') { try { c.setPatrolDensity(v); } catch { /* noop */ } }
      else { try { c.patrolDensity = v; } catch { /* noop */ } }
    }
    if (this.ctx.state?.director) this.ctx.state.director.patrolDensity = v;
    return v;
  }

  /** "have a camper call out" — a voice, in the world, from a person who is already there. */
  _callOut() {
    const vb = this._vo();
    const roster = this.def.roster;
    const who = roster[this.rand.int(0, roster.length - 1)] ?? 'dale';
    const c = this._campers();
    let pos = null;
    try {
      const list = c?.agents ?? c?.campers ?? c?.list ?? null;
      if (Array.isArray(list)) {
        const hit = list.find((a) => a && a.id === who) ?? list[0];
        if (hit?.position) pos = hit.position;
      }
    } catch { pos = null; }

    if (vb && typeof vb.sayCategory === 'function') {
      try { vb.sayCategory('call', pos, who); return; } catch { /* fall through */ }
    }
    let lines = null;
    try { lines = Script?.linesFor?.('call', this.night) ?? null; } catch { lines = null; }
    if (Array.isArray(lines) && lines.length) {
      const line = lines[this.rand.int(0, lines.length - 1)];
      if (line?.id) this._emit('audio:vo', pos ? { id: line.id, position: pos } : { id: line.id });
    }
  }

  // ===============================================================================================
  // STORY — fire Script.beats at their triggers
  // ===============================================================================================

  /** Fire a beat by id. The 'manual' trigger kind exists for exactly this. */
  fireBeat(id) {
    const key = String(id ?? '');
    if (!key) return false;
    const rec = this._beats.find((b) => b.id === key);
    if (rec) {
      if (rec.fired) return false;
      return this._fireBeatRecord(rec);
    }
    // A beat not in tonight's list (an ending, a global) still fires.
    const def = this._beatDef(key);
    this._applyBeatDef(key, def);
    return true;
  }

  _fireBeatRecord(rec) {
    if (!rec || rec.fired) return false;
    rec.fired = true;
    this._beatsFired++;
    this._applyBeatDef(rec.id, rec.def);
    return true;
  }

  _applyBeatDef(id, def) {
    // Flags first: BlueprintUI and Player both read storyFlags on the story:beat frame.
    const st = this.ctx.state;
    if (st && def && Array.isArray(def.flagsSet)) {
      for (const f of def.flagsSet) this._setFlag(f);
    }
    this._emit('story:beat', { id });

    if (def?.sfx) this._emit('audio:sfx', { id: def.sfx });
    const voIds = Array.isArray(def?.voIds) && def.voIds.length ? def.voIds : (def?.voId ? [def.voId] : null);
    if (voIds && voIds.length) {
      const vb = this._vo();
      const first = voIds[0];
      if (vb && typeof vb.say === 'function') { try { vb.say(first); } catch { this._emit('audio:vo', { id: first }); } }
      else this._emit('audio:vo', { id: first });
    }

    // The three long Scripted beats hold the floor: senses run, state transitions do not.
    const hold = SCRIPTED_BEATS[id];
    if (hold) this._beginScripted(id, hold.seconds, hold.grabRefused);
    Log.debug(`story:beat ${id}`);
  }

  /** storyFlags is plain data on ctx.state. We write it directly so we own what emits a beat. */
  _setFlag(f) {
    const st = this.ctx.state;
    if (!st) return;
    if (!st.storyFlags || typeof st.storyFlags !== 'object') st.storyFlags = {};
    if (st.storyFlags[f] === true) return;
    st.storyFlags[f] = true;
  }

  _beginScripted(id, seconds, grabRefused) {
    this._scripted = { id, seconds: Math.max(1, finite(seconds, 60)), t: 0 };
    if (this.ctx.state) {
      this.ctx.state.scriptedBeat = id;
      this.ctx.state.grabRefused = !!grabRefused;
    }
    const c = this._campers();
    if (c && typeof c.beginScriptedBeat === 'function') { try { c.beginScriptedBeat(id); } catch { /* noop */ } }
    // During a scripted beat the director does not also lean on the player.
    this._pressureIdle = 0;
  }

  _endScripted() {
    const id = this._scripted?.id ?? null;
    this._scripted = null;
    if (this.ctx.state) { this.ctx.state.scriptedBeat = null; this.ctx.state.grabRefused = false; }
    const c = this._campers();
    if (c && typeof c.endScriptedBeat === 'function') { try { c.endScriptedBeat(id); } catch { /* noop */ } }
  }

  _buildBeats(night) {
    this._beats.length = 0;
    this._eventBeats.clear();
    let list = null;
    try { list = Script?.nightDef?.(night)?.beats ?? Script?.nights?.[night - 1]?.beats ?? null; }
    catch { list = null; }
    if (!Array.isArray(list)) return;

    for (const b of list) {
      if (!b?.id) continue;
      const trig = b.trigger ?? { kind: 'manual' };
      const rec = { id: b.id, trigger: trig, fired: false, def: this._beatDef(b.id) };
      this._beats.push(rec);
      if (trig.kind === 'event' && trig.event) {
        const arr = this._eventBeats.get(trig.event) ?? [];
        arr.push(rec);
        this._eventBeats.set(trig.event, arr);
      }
    }
    Log.debug(`night ${night}: ${this._beats.length} beats armed`);
  }

  _beatDef(id) {
    try { return Script?.beat?.(id) ?? Script?.beats?.[id] ?? null; } catch { return null; }
  }

  _fireTrigger(kind, payload = null) {
    for (const rec of this._beats) {
      if (rec.fired || rec.trigger?.kind !== kind) continue;
      if (kind === 'stage-complete') {
        // Script's declared stage numbers predate §2's stage counts; clamp rather than strand.
        const want = clamp(Math.round(finite(rec.trigger.stage, 1)), 1, this.def.stages);
        if (finite(payload?.stage, 0) < want) continue;
      }
      this._fireBeatRecord(rec);
    }
  }

  _evalTimeTriggers() {
    for (const rec of this._beats) {
      if (rec.fired || rec.trigger?.kind !== 'time') continue;
      if (this._ton >= finite(rec.trigger.at, 2)) this._fireBeatRecord(rec);
    }
  }

  _evalFlagTriggers() {
    const flags = this.ctx.state?.storyFlags;
    if (!flags) return;
    for (const rec of this._beats) {
      if (rec.fired || rec.trigger?.kind !== 'flag') continue;
      if (flags[rec.trigger.flag] === true) this._fireBeatRecord(rec);
    }
  }

  _evalProximityTriggers() {
    let any = false;
    for (const rec of this._beats) { if (!rec.fired && rec.trigger?.kind === 'proximity') { any = true; break; } }
    if (!any) return;
    if (!this._playerPos(_v0)) return;
    for (const rec of this._beats) {
      if (rec.fired || rec.trigger?.kind !== 'proximity') continue;
      const t = rec.trigger;
      const r = Math.max(1, finite(t.radius, 8));
      if (!this._anchor(t.anchor, _v1)) continue;
      const dx = _v0.x - _v1.x, dz = _v0.z - _v1.z;
      if (dx * dx + dz * dz > r * r) continue;
      if (t.actor && !this._actorNear(t.actor, _v1, r * 2.5)) continue;
      this._fireBeatRecord(rec);
    }
  }

  _actorNear(id, at, radius) {
    const c = this._campers();
    let list = null;
    try { list = c?.agents ?? c?.campers ?? c?.list ?? null; } catch { list = null; }
    if (!Array.isArray(list)) return true;    // Campers cannot answer: do not block the story
    for (const a of list) {
      if (!a || a.id !== id || !a.position) continue;
      const dx = a.position.x - at.x, dz = a.position.z - at.z;
      return dx * dx + dz * dz <= radius * radius;
    }
    return false;
  }

  /** §13.6. The endings. `which` is 'a' | 'b' | 'c'. */
  chooseEnding(which) {
    const key = String(which ?? '').toLowerCase();
    if (!['a', 'b', 'c'].includes(key)) return false;
    if (this._ending) return false;
    this._ending = key;
    this._setFlag(`ending_${key}`);
    this._setFlag('manualBlank');
    this.fireBeat(`n7_ending_${key}`);
    this.fireBeat('n7_final');
    const p = this._player();
    if (key === 'c' && p && typeof p.lockInput === 'function') { try { p.lockInput(true); } catch { /* noop */ } }
    this._ton = 1;
    if (this.ctx.state) this.ctx.state.timeOfNight = 1;
    this.completeNight();
    return true;
  }

  // ===============================================================================================
  // ESCALATION LADDER (§13.1) — Campers' only entry points
  // ===============================================================================================

  notifySpotted(payload = null) {
    void payload;
    this._spottedThisNight++;
    if (this.ctx.state) this.ctx.state.spotted = true;
    if (this._spottedThisNight === 1) this._escalate('rung2', TUNING.suspSpotted, 1);
    this.enterChase('spotted');
  }

  /** A camper investigated a noise and found nothing. Three of those is rung 1. */
  notifyInvestigation() {
    this._investigations++;
    if (this._investigations === TUNING.investigationsForRung1) {
      this._escalate('rung1', TUNING.suspInvestigations, 0);
    }
  }

  /** §9.5 — someone reported the STRUCTURE, not the man. Worse than the suspicion. */
  notifyStructureReport() {
    if (this._rungs.has('rung1b')) return;
    this._escalate('rung1b', TUNING.suspStructureReport, 0);
    const nav = this._nav();
    if (nav && typeof nav.addStructurePatrol === 'function') {
      try { nav.addStructurePatrol(); this._structurePatrols++; this._patrolLadder++; } catch { /* noop */ }
    }
    const st = this.ctx.state;
    if (st) {
      if (!st.structureKnowledge || typeof st.structureKnowledge !== 'object') {
        st.structureKnowledge = { seenBy: [], enteredBy: [], reportedAs: null, featuresKnown: {} };
      }
      st.structureKnowledge.reportedAs = 'structure';
    }
  }

  /** 'short' (interceptable, 26 s) or 'long' (the payphone, 40 s, rung 6 — the night ends). */
  notifyReport(kind = 'short') {
    const st = this.ctx.state;
    const s = st?.stats;
    if (s) s.reportsTotal = finite(s.reportsTotal, 0) + 1;

    if (String(kind) === 'long') {
      if (s) s.longReports = finite(s.longReports, 0) + 1;
      this._escalate('rung6', 0.30, 0);
      this.failNight('reported');
      return 'long';
    }

    if (s) s.shortReports = finite(s.shortReports, 0) + 1;
    this._escalate('rung3', TUNING.suspShortReport, 2);
    // Rung 3: the camp lights come on. The mess hall is lit; Tier-3 is now suicide.
    this._campLightsOn();
    if (finite(s?.reportsTotal, 0) >= 2) this.notifyBodyFound(true);
    this._checkRanger();
    return 'short';
  }

  /** §13.5. A body was discovered — rung 4, immediately and permanently. */
  notifyBodyFound(viaReports = false) {
    if (this._rungs.has('rung4')) return false;
    this._escalate('rung4', TUNING.suspBodyFound, 1);
    const c = this._campers();
    if (c) {
      if (typeof c.spawnBev === 'function') { try { c.spawnBev(); } catch { /* noop */ } }
      // Kids recalled to cabins: the forest gets emptier and worse.
      if (typeof c.recallKids === 'function') { try { c.recallKids(2); } catch { /* noop */ } }
    }
    if (this.ctx.state) this.ctx.state.bodyFound = true;
    this._checkRanger();
    Log.debug(viaReports ? 'escalation rung 4 (two reports)' : 'escalation rung 4 (body found)');
    return true;
  }

  /** Campers may drive the 'exposed' condition directly if it has a better view than we do. */
  notifyExposed(on) {
    if (on && this._exposed <= 0) { this._exposed = TUNING.exposedSeconds; this.enterChase('exposed'); }
    else if (!on && this._exposed > 0) { this._exposed = 0; this.requestLull(TUNING.lullSeconds, 'exposed-cleared'); }
    return this._exposed > 0;
  }

  _escalate(rung, suspicionDelta, patrolDelta) {
    if (this._rungs.has(rung)) return false;
    this._rungs.add(rung);
    const st = this.ctx.state;
    if (st) {
      if (typeof st.addSuspicion === 'function') st.addSuspicion(suspicionDelta);
      else st.suspicion = clamp01(finite(st.suspicion, 0) + suspicionDelta);
    }
    if (patrolDelta) this._patrolLadder += patrolDelta;
    this._applyPatrolDensity();
    Log.debug(`escalation ${rung}: suspicion -> ${this.suspicion.toFixed(2)}, patrols ${this._patrolDensity}`);
    return true;
  }

  /** Rung 5's single condition (§0.2 C6): night >= 6 AND stats.reportsTotal >= 2. */
  _checkRanger() {
    if (this._rangerAt !== Infinity) return;
    const total = finite(this.ctx.state?.stats?.reportsTotal, 0);
    if (this.night >= 6 && total >= 2) {
      this._rangerAt = Math.min(0.999, this._ton + TUNING.rangerAtOffset);
      Log.debug(`ranger scheduled at timeOfNight ${this._rangerAt.toFixed(2)}`);
    }
  }

  _campLightsOn() {
    const props = this._sys('Props');
    const lights = props?.lights;
    if (!lights) return;
    const arr = Array.isArray(lights) ? lights : (typeof lights.values === 'function' ? Array.from(lights.values()) : null);
    if (!arr) return;
    let lit = 0;
    for (const l of arr) {
      if (lit >= 2) break;
      if (!l || typeof l.intensity !== 'number') continue;
      if (l.userData?.campLight === false) continue;
      l.visible = true;
      if (l.intensity < 1) l.intensity = 1;
      lit++;
    }
    if (this.ctx.state) this.ctx.state.campLightsOn = true;
  }

  // ===============================================================================================
  // SCORING (§15) — the assembly report. Precise, tidy, and quietly appalling about what it is
  // measuring. It never mentions a person, because a flat-pack assembly report has no field
  // for one, and the moment it invents one it has noticed.
  // ===============================================================================================

  _blankScore() {
    return {
      night: 1,
      partsInstalled: 0, partsTotal: 0,
      joinsCorrect: 0, joinsUnderFastened: 0, joinsRotated: 0, joinsWrongSlot: 0, joinsWrongPart: 0,
      perfectJoins: 0, creaks: 0, peakCreakDebt: 0,
      fastenersSupplied: 0, fastenersRequired: 0,
      metresWalked: 0, metresHauled: 0,
      campersEvaded: 0, shortReports: 0, longReports: 0,
      timeUsed: 0, timeRemaining: 0,
      hardwareShortfalls: 0, hardwareRecovered: 0,
      recuts: 0, sawSeconds: 0,
      assemblyQuality: 100,
      // Menu reads these spellings; they are the same numbers under the card's own headings.
      joinsNotAsIllustrated: 0, joinsRequiringReplacement: 0,
      timeUsedSeconds: 0, timeRemainingSeconds: 0,
      lines: [],
    };
  }

  _resetScore() {
    const s = this._score;
    for (const k of Object.keys(s)) {
      if (k === 'lines') s.lines.length = 0;
      else if (typeof s[k] === 'number') s[k] = 0;
    }
    s.assemblyQuality = 100;
    s.night = this.night;
  }

  /**
   * Recompute the running Score. `final` forces a refresh and stamps the card lines.
   * Cached for 0.4 s so a HUD reading `score` every frame costs nothing.
   */
  buildScore(final = false) {
    const s = this._score;
    if (!final && this._elapsed - this._scoreAt < 0.4) return s;
    this._scoreAt = this._elapsed;

    const st = this.ctx.state ?? {};
    const stats = st.stats ?? {};
    const bs = this._build();

    s.night = this.night;
    s.partsTotal = this.def.slots;

    // Buckets, from BuildSystem's join records when it has them, from state.installed when not.
    let installed = 0, correct = 0, under = 0, rotated = 0, wrongSlot = 0, wrongPart = 0;
    const joins = bs?.joins;
    if (joins && typeof joins.forEach === 'function') {
      joins.forEach((j) => {
        if (!j) return;
        if (Number.isFinite(j.night) && j.night !== this.night) return;
        installed++;
        switch (j.outcome) {
          case 'seated': correct++; break;
          case 'under-fastened': under++; break;
          case 'rotated': rotated++; break;
          case 'wrong-slot': wrongSlot++; break;
          case 'wrong-part': wrongPart++; break;
          default: if (j.correct) correct++; else under++; break;
        }
      });
    } else if (st.installed && typeof st.installed === 'object') {
      for (const k of Object.keys(st.installed)) {
        const rec = st.installed[k];
        if (!rec) continue;
        if (Number.isFinite(rec.night) && rec.night !== this.night) continue;
        installed++;
        if (rec.correct) correct++;
        else if (rec.outcome === 'rotated') rotated++;
        else if (rec.outcome === 'wrong-slot') wrongSlot++;
        else if (rec.outcome === 'wrong-part') wrongPart++;
        else under++;
      }
    }
    s.partsInstalled = Math.min(installed, s.partsTotal || installed);
    s.joinsCorrect = correct;
    s.joinsUnderFastened = under;
    s.joinsRotated = rotated;
    s.joinsWrongSlot = wrongSlot;
    s.joinsWrongPart = wrongPart;
    s.joinsNotAsIllustrated = under + rotated;
    s.joinsRequiringReplacement = wrongSlot + wrongPart;

    s.perfectJoins = Math.max(0, Math.round(finite(stats.perfectJoins, 0)));
    s.creaks = Math.max(0, Math.round(finite(st.creaks, this._creaksThisNight)));
    s.peakCreakDebt = Math.max(s.peakCreakDebt, finite(bs?.creakDebt, 0));

    // Hardware. §6.6's pocket fasteners plus the night's shortfall.
    const pocket = bs?.pocket ?? null;
    s.fastenersRequired = Math.max(0, Math.round(finite(bs?.fastenersRequired, s.partsTotal * 6)));
    s.fastenersSupplied = Math.max(0, Math.round(
      finite(bs?.fastenersSupplied, Math.max(0, s.fastenersRequired - finite(pocket?.shortBy, 0))),
    ));
    if (s.fastenersSupplied > s.fastenersRequired) s.fastenersRequired = s.fastenersSupplied;
    let shortfalls = 0, recovered = 0;
    const sf = bs?.shortfalls;
    if (Array.isArray(sf)) {
      shortfalls = sf.length;
      const found = Array.isArray(st.toolsFound) ? st.toolsFound : [];
      for (const x of sf) if (x && found.includes(x.id)) recovered++;
    }
    s.hardwareShortfalls = shortfalls;
    s.hardwareRecovered = recovered;

    s.metresWalked = Math.max(0, Math.round(finite(stats.metresWalked, 0)));
    s.metresHauled = Math.max(0, Math.round(finite(stats.metresHauled, s.metresWalked)));
    s.campersEvaded = Math.max(0, Math.round(finite(stats.campersEvaded, 0)));
    s.shortReports = Math.max(0, Math.round(finite(stats.shortReports, 0)));
    s.longReports = Math.max(0, Math.round(finite(stats.longReports, 0)));
    s.recuts = Math.max(0, Math.round(finite(stats.recuts, 0)));
    s.sawSeconds = Math.max(0, finite(bs?.sawSeconds, finite(stats.sawSeconds, 0)));

    // §15.1's timeRemaining is a fraction. The card renders mm:ss, so publish both.
    s.timeRemaining = clamp01(1 - this._ton);
    s.timeUsed = clamp01(this._ton);
    const dur = Number.isFinite(this.def.seconds) ? this.def.seconds : Math.max(1, this._buildSeconds);
    s.timeRemainingSeconds = Math.max(0, s.timeRemaining * dur);
    s.timeUsedSeconds = Math.max(0, Number.isFinite(this.def.seconds) ? this._buildSeconds : this._buildSeconds);

    // §15.1, transcribed exactly.
    s.assemblyQuality = clamp(
      100
      - 5.0 * s.joinsUnderFastened
      - 8.0 * s.joinsRotated
      - 12.0 * s.joinsWrongSlot
      - 24.0 * s.joinsWrongPart
      - 0.8 * s.creaks
      - 15.0 * s.shortReports
      - 25.0 * s.longReports
      + 2.5 * s.perfectJoins
      + 8.0 * (s.timeRemaining > 0.12 ? 1 : 0),
      0, 100,
    );
    s.assemblyQuality = Math.round(s.assemblyQuality);

    if (final) {
      const card = this.reportCard(s, this.night);
      s.lines.length = 0;
      for (const l of card) s.lines.push(l);
    }
    return s;
  }

  /**
   * §15.2 — the card, and how it dies. Twelve lines on Nights 1–3; from Night 4 it loses a
   * group per night until Night 7's card is one line. Nothing announces the drop.
   */
  reportCard(score, night) {
    const n = clamp(Math.round(finite(night, this.night)), 1, 7);
    const s = score ?? this._score;
    const out = [];
    if (n === 7) {
      out.push({ key: 'complete', label: 'ASSEMBLY COMPLETE.', value: null, centred: true });
      return out;
    }
    const group = (v) => Math.round(finite(v, 0)).toLocaleString('en-US');
    const mmss = (sec) => {
      const t = Math.max(0, Math.round(finite(sec, 0)));
      return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    };
    for (const line of CARD_LINES) {
      if (n > line.until) continue;
      if (line.header) { out.push({ key: line.key, label: line.label.replace('{night}', String(n)), value: null, header: true }); continue; }
      if (line.footer) { out.push({ key: line.key, label: line.label, value: null, footer: true }); continue; }
      let value;
      switch (line.key) {
        case 'partsInstalled': value = `${group(s.partsInstalled)} / ${group(s.partsTotal)}`; break;
        case 'metresHauled': value = `${group(s.metresHauled)} m`; break;
        case 'timeRemaining': value = mmss(s.timeRemainingSeconds); break;
        case 'assemblyQuality': value = `${group(s.assemblyQuality)} / 100`; break;
        default: value = group(s[line.key]); break;
      }
      out.push({ key: line.key, label: line.label, value });
    }
    if (s.assemblyQuality >= 95) out.push({ key: 'perfect', label: 'NO FURTHER ACTION REQUIRED.', value: null, footer: true });
    else if (s.assemblyQuality <= 20) out.push({ key: 'retain', label: 'RETAIN THIS DOCUMENT.', value: null, footer: true });
    return out;
  }

  /** Lines per night must be 12, 12, 12, 11, 9, 6, 1 (§15.2). Verified once, at init. */
  _selfTestCard() {
    const want = [12, 12, 12, 11, 9, 6, 1];
    const s = this._blankScore();
    s.assemblyQuality = 60;   // neither of the two conditional extras
    for (let n = 1; n <= 7; n++) {
      const got = this.reportCard(s, n).length;
      if (got !== want[n - 1]) {
        Log.warn(`NightManager: card line count for night ${n} is ${got}, GAME_DESIGN §15.2 says ${want[n - 1]}.`);
      }
    }
  }

  // ===============================================================================================
  // SAVE / LOAD (§14)
  // ===============================================================================================

  listSaves() { return Object.keys(this._slots); }

  /** Full GameState snapshot into a named slot. Blueprint is never saved — it is derived. */
  saveSlot(name) {
    const key = String(name ?? 'checkpoint');
    const st = this.ctx.state;
    if (!st) return false;
    let snap = null;
    try { snap = typeof st.toJSON === 'function' ? st.toJSON() : JSON.parse(JSON.stringify(st)); }
    catch (e) { Log.once('nm:snap', 'NightManager: could not snapshot GameState', e); return false; }
    if (!snap) return false;
    snap.timeOfNight = this._ton;
    snap.night = this.night;
    snap.director = {
      suspicionFloor: finite(st.suspicionFloor, 0),
      stagePenalty: finite(st.stagePenalty, 0),
      rolloverSlots: finite(st.rolloverSlots, 0),
      nightsReported: Array.isArray(st.nightsReported) ? st.nightsReported.slice() : [],
      rungs: Array.from(this._rungs),
    };
    snap.savedAt = Date.now();
    this._slots[key] = snap;
    this._writeSlots();
    return true;
  }

  loadSlot(name) {
    const key = String(name ?? 'checkpoint');
    const snap = this._slots[key];
    if (!snap) return false;
    const st = this.ctx.state;
    if (!st) return false;
    try { Object.assign(st, snap); }
    catch (e) { Log.once('nm:load', 'NightManager: restore failed', e); return false; }

    this._rungs.clear();
    for (const r of (snap.director?.rungs ?? [])) this._rungs.add(r);

    const night = clamp(Math.round(finite(snap.night, 1)), 1, 7);
    this.startNight(night, { restored: true });
    this.setTimeOfNight(finite(snap.timeOfNight, 0));

    // §14.2 — what restoring RESETS. A mid-chase FSM restores into an unreadable state.
    const c = this._campers();
    if (c) {
      if (typeof c.resetAll === 'function') { try { c.resetAll(); } catch { /* noop */ } }
      if (typeof c.clearDetection === 'function') { try { c.clearDetection(); } catch { /* noop */ } }
    }
    const ns = this._noise();
    if (ns && typeof ns._clearAll === 'function') { try { ns._clearAll(); } catch { /* noop */ } }
    if (st) st.spotted = false;
    this._chase = false;
    this._exposed = 0;
    // Weather re-derives from (night, timeOfNight) — deterministic, so the storm is identical.
    this._weather()?.setNight?.(night);
    Log.debug(`restored slot '${key}': night ${night} at ${this._ton.toFixed(2)}`);
    return true;
  }

  /** §14.3 — "Replay any completed night". Loads that night's `night-<n>-start`. */
  restoreNight(n) {
    const night = clamp(Math.round(finite(n, this.night)), 1, 7);
    if (this._slots[`night-${night}-start`]) return this.loadSlot(`night-${night}-start`);
    this.startNight(night);
    return true;
  }

  _autosave(reason) {
    this.saveSlot(reason);
    // Keep GameState's own single-key save in step; the title screen reads it for "Continue".
    try { this.ctx.state?.save?.(); } catch { /* noop */ }
  }

  _readSlots() {
    try {
      const raw = globalThis.localStorage?.getItem(TUNING.saveKey);
      if (!raw) return Object.create(null);
      const o = JSON.parse(raw);
      return (o && typeof o === 'object') ? o : Object.create(null);
    } catch { return Object.create(null); }
  }

  _writeSlots() {
    try { globalThis.localStorage?.setItem(TUNING.saveKey, JSON.stringify(this._slots)); }
    catch (e) { Log.once('nm:save', 'NightManager: localStorage write failed', e); }
  }

  // ===============================================================================================
  // FIRST-RUN ONBOARDING (§17) — five minutes, zero tutorial text.
  // Everything here is a SOUND, a LIGHT or a SCHEDULE. Nothing here writes a word on screen.
  // ===============================================================================================

  /**
   * THE LAMP IS ALREADY LIT WHEN NIGHT ONE OPENS.
   *
   * THE BUG. `Flashlight` binds `night:begin` and sets `on = false` on every night, and nothing
   * anywhere told the player the lamp existed. §17 forbids tutorial text, STORY.md §A.4 forbids
   * a narrator, and GAME_DESIGN §4.1 hides `F` in a remappable input table nobody reads. So the
   * measured result was a player eleven minutes into Night 1 who had never pressed F, looking at
   * a frame that reads meanY 0.0065 with 93.7% of its pixels below Y 0.02 and no warm pixel in
   * it at all — an unreadable black rectangle, against ART_DIRECTION §3.1.1's 0.018–0.028 window.
   *
   * THE FIX, and why it is this one and not a prompt. Ansel is a joiner who drove up here at dusk
   * to work. A professional does not walk into a black forest carrying an unlit lamp; he lights it
   * at the truck. So the director lights it for him at t=0:00 — during the briefing, so the 0.9 s
   * ignition ramp lands under the title card and the world comes up warm as §17's 3 s fade-in
   * resolves. Not one word is written on screen, no glyph is drawn, and the input table is not
   * mentioned. The lamp simply is what it would be.
   *
   * AND THE VERB IS STILL TAUGHT, by the economy rather than by us. §11.2: 100 units, 0.55/s open.
   *   0:00        lit. The whole taught build sequence (§17 0:14–2:40) happens in warm light.
   *   ~2:34       15 units. The flame starves: shorter, redder, gutters at 3 Hz, audibly.
   *   ~3:02       the tank is dry and it does not click out, it just stops.
   * §17's own t=3:20 line assumes the player is **unlit** when Dale's torch crosses at 45 m —
   * "(§9.3 — unlit, walking, 20 m is 29.9 s to detect)". So the tank running dry at 3:02 lands
   * exactly where the document already wanted the player dark, on the one night that is safe.
   * A player who reads the gutter and hoods or douses at 2:34 banks the difference. That is the
   * §17 crouch lesson again: discovered under motivation, never instructed.
   *
   * NIGHT 1 ONLY. From Night 2 the flame is a 180 m advertisement to three or more people (§9.4)
   * and lighting it for the player would be a trap, not a kindness. Every other night keeps
   * Flashlight's own default: full tank, unlit, in his fist at the treeline.
   */
  _lightTheLamp(night) {
    if (night !== 1) return false;
    const lamp = this._flashlight();
    if (!lamp) return false;
    try {
      // Shutter open first, so the ignition does not come up behind a closed hood.
      if (typeof lamp.setHood === 'function') lamp.setHood(0, 0.05);
      const lit = typeof lamp.ignite === 'function' ? lamp.ignite()
        : typeof lamp.setOn === 'function' ? lamp.setOn(true)
          : (lamp.on = true);
      Log.debug(`§17 t=0:00 — the lamp is lit at the treeline (${lit ? 'burning' : 'refused'}).`);
      return !!lit;
    } catch (e) {
      Log.once('nm:lamp', 'NightManager: could not light the lantern for Night 1', e);
      return false;
    }
  }

  _buildOnboarding(night) {
    this._onboard.length = 0;
    if (night !== 1) return;
    const push = (t, fn, gate) => this._onboard.push({ t, fn, gate: gate ?? null, done: false });

    // t=0:07 — one distant laugh, 140 m NE, occluded. The world before the interface.
    push(6.0, () => this._sayAt('DAL_IDLE_01', 140, 0.7));
    // Around pier 3-4 the player starts hammering casually. A distant voice reacts. Nothing else
    // happens. The hammering is heard: bank it.
    push(90.0, () => this._sayAt('DAL_HEAR_01', 150, 0.6), () => this._hammerCount >= 6);
    // The first class-D lift, then the first creak, are BuildSystem's. We answer the creak.
    // t=4:52 — every verb in §9.6 is now motivated, so the director stops holding the floor.
    // This step used to only set a story flag nothing reads, which made it a no-op; the floor
    // is what §17 actually says is released here, so it releases it. `_openingHold` already
    // gates the band on the same number — clearing it is belt-and-braces plus a legible log.
    push(300.0, () => {
      this._openingHold = 0;
      this._setFlag('sawIntroPanel');
      Log.debug('§17 t=5:00 — the opening is over; the rubber band has the floor.');
    }, null);
  }

  _updateOnboarding(dt) {
    void dt;
    if (this._loonAt >= 0 && this._buildSeconds >= this._loonAt) {
      this._loonAt = -1;
      // A loon answers the first creak from across the water, on the same fundamental.
      this._emitAt('audio:sfx', 'loon_answer', 'lake', 0.75);
    }
    if (!this._onboard.length) return;
    for (const e of this._onboard) {
      if (e.done || this._buildSeconds < e.t) continue;
      if (e.gate && !e.gate()) continue;
      e.done = true;
      try { e.fn(); } catch (err) { Log.once('nm:onboard', 'NightManager: onboarding step threw', err); }
    }
  }

  /** A voice from a person who is somewhere specific, at a bearing, with no subtitle of ours. */
  _sayAt(id, metres, volume) {
    if (!this._anchor('plot', _v0)) _v0.set(0, 0, 0);
    // North-east of the plot, per §17.
    _v1.set(_v0.x + metres * 0.707, _v0.y, _v0.z - metres * 0.707);
    const vb = this._vo();
    if (vb && typeof vb.say === 'function') {
      try { vb.say(id, _v1, { volume }); return; } catch { /* fall through */ }
    }
    this._emit('audio:vo', { id, position: _v1.clone() });
  }

  _emitAt(event, id, anchorName, volume) {
    if (this._anchor(anchorName, _v0)) this._emit(event, { id, position: _v0.clone(), volume });
    else this._emit(event, { id, volume });
  }

  // ===============================================================================================
  // WIRING
  // ===============================================================================================

  _bind() {
    const bus = this.bus;
    if (!bus?.on) return;
    const on = (name, fn) => {
      const off = bus.on(name, Log.guard ? Log.guard(`NightManager:${name}`, fn) : fn);
      if (typeof off === 'function') this._unsubs.push(off);
    };

    for (const name of WATCHED_EVENTS) on(name, (p) => this._onEvent(name, p));

    // §14.1 — tab hidden is a checkpoint refresh, synchronously.
    if (typeof document !== 'undefined' && document.addEventListener) {
      this._visHandler = () => {
        if (document.visibilityState === 'hidden' && this._phase === 'build') this._autosave('checkpoint');
      };
      try { document.addEventListener('visibilitychange', this._visHandler); } catch { this._visHandler = null; }
    }
  }

  _onEvent(name, payload) {
    // 1. story triggers of kind 'event'
    const recs = this._eventBeats.get(name);
    if (recs) {
      for (const rec of recs) {
        if (rec.fired) continue;
        if (!this._matches(rec.trigger.match, payload)) continue;
        this._fireBeatRecord(rec);
      }
    }

    // 2. the director's own reactions
    switch (name) {
      case 'build:stage-complete': {
        const stage = finite(payload?.stage, 1);
        this._fireTrigger('stage-complete', { stage });
        this._autosave('checkpoint');
        // A finished stage is the natural place to let the player breathe.
        if (this._tension > 0.5) this.requestLull(Math.min(30, TUNING.lullSeconds), 'stage-complete');
        break;
      }
      case 'build:creak': {
        this._creaksThisNight++;
        this._creakMemory = clamp01(this._creakMemory + 1 / TUNING.creakWeightFull);
        if (this.night === 1 && this._loonAt < 0 && this._creaksThisNight === 1) {
          this._loonAt = this._buildSeconds + 1.2;   // §17 t=4:39, and the loon answers it
        }
        break;
      }
      case 'noise:emit': {
        const kind = payload?.kind;
        if (kind === 'hammer') this._hammerCount++;
        break;
      }
      case 'player:spotted': this.notifySpotted(payload); break;
      case 'player:hidden': if (this.ctx.state) this.ctx.state.spotted = false; break;
      case 'ui:blueprint-close': this._manualClosed = true; break;
      case 'ui:blueprint-open': this._manualClosed = false; break;
      case 'build:place': this._onPlace(payload); break;
      case 'tool:found': {
        const st = this.ctx.state;
        const id = payload?.toolId;
        if (st && id && Array.isArray(st.toolsFound) && !st.toolsFound.includes(id)) st.toolsFound.push(id);
        break;
      }
      default: break;
    }
  }

  _onPlace(payload) {
    // §13.6 Ending C: `place` with the player as the part. It is the last event the gameplay
    // layer emits, and it arrives here as an ordinary build:place.
    if (this.night !== 7) return;
    const slotId = String(payload?.slot?.id ?? payload?.slot ?? '');
    const partId = String(payload?.part?.partId ?? payload?.part?.id ?? payload?.part ?? '');
    if (RE_ANSEL.test(partId) || RE_SMALL_CHAIR.test(slotId)) {
      this.chooseEnding('c');
    } else if (RE_ROBIN.test(partId)) {
      this.chooseEnding('a');
    }
  }

  _matches(match, payload) {
    if (!match || typeof match !== 'object') return true;
    if (!payload || typeof payload !== 'object') return false;
    for (const k of Object.keys(match)) {
      const want = match[k];
      let got = payload[k];
      if (got == null && payload.part) got = payload.part[k];
      if (got == null && payload.slot) got = payload.slot[k];
      if (String(got) !== String(want)) return false;
    }
    return true;
  }

  /** Publish the director's reads onto ctx.state so Music, HUD and Sky can follow for free. */
  _publish() {
    const st = this.ctx.state;
    if (!st) return;
    st.timeOfNight = this._ton;
    st.tension = this._tension;
    st.phase = this._phase;
    if (st.director) {
      st.director.lull = this._lull > 0 ? this._lull : 0;
      st.director.chase = this._chase;
      st.director.patrolDensity = this._patrolDensity;
      st.director.tension = this._tension;
    }
    this._syncObjective();
  }

  _syncObjective() {
    const o = this.objective;
    const done = this._installedThisNight();
    o.night = this.night;
    o.phase = this._phase;
    o.stage = this.stage;
    o.stageCount = this.def.stages;
    o.slotsDone = done;
    o.slotsTotal = this.def.slots;
    o.remaining = Math.max(0, this.def.slots - done);
    o.ratio = this.def.slots > 0 ? clamp01(done / this.def.slots) : 0;
    o.kind = this._phase === 'chase' ? 'evade' : this._phase === 'build' ? 'build' : this._phase;
    o.id = `${o.kind}-n${this.night}-s${o.stage}`;
    // The world never addresses the player (§17). This string exists for telemetry only, and
    // only when the developer has asked for it.
    o.text = this.ctx.settings?.get?.('devTelemetry')
      ? `N${this.night} ${this.def.title} · stage ${o.stage}/${o.stageCount} · ${done}/${o.slotsTotal}`
      : null;
  }

  _applyNightDef(night, resetState) {
    this.night = clamp(Math.round(finite(night, 1)), 1, 7);
    this.def = NIGHTS[this.night - 1] ?? NIGHTS[0];
    if (resetState && this.ctx.state) this.ctx.state.night = this.night;
    this._score.night = this.night;
    this._syncObjective();
  }

  _endOfNightTeardown() {
    this._releaseMusic();
    this._post()?.setPanic?.(0);
    if (this._chase) { this._chase = false; if (this.ctx.state) this.ctx.state.chase = false; }
    if (this._scripted) this._endScripted();
    this._lull = 0;
    this._exposed = 0;
    while (this._structurePatrols > 0) { this._nav()?.removeStructurePatrol?.(); this._structurePatrols--; }
    this._patrolLadder = 0;
    this._patrolBonus = 0;
  }

  _releaseMusic() {
    const m = this._music();
    if (m && typeof m.setIntensity === 'function') { try { m.setIntensity(null); } catch { /* noop */ } }
  }

  // ===============================================================================================
  // READS FROM OTHER SYSTEMS — every one of them null-checked and guarded
  // ===============================================================================================

  _sys(name) {
    // A tiny cache: system lookup is a Map.get, but the guards around it are not free at 60 Hz.
    if (this._elapsed - this._sysCacheAt > 2.0) { this._sysCache.clear(); this._sysCacheAt = this._elapsed; }
    if (this._sysCache.has(name)) return this._sysCache.get(name);
    let s = null;
    try { s = this.ctx.systems?.get?.(name) ?? null; } catch { s = null; }
    this._sysCache.set(name, s);
    return s;
  }

  _player() { return this._sys('Player'); }
  _campers() { return this._sys('Campers'); }
  _build() { return this._sys('BuildSystem'); }
  _blueprintSys() { return this._sys('Blueprint'); }
  _weather() { return this._sys('Weather'); }
  _nav() { return this._sys('Navmesh'); }
  _noise() { return this._sys('NoiseSystem'); }
  _music() { return this._sys('Music'); }
  _post() { return this._sys('Postprocessing'); }
  _hud() { return this._sys('HUD'); }
  _menu() { return this._sys('Menu'); }
  _vo() { return this._sys('VoiceBank'); }
  _physics() { return this._sys('Physics'); }
  _terrain() { return this._sys('Terrain'); }

  _playerPos(out) {
    const p = this._player();
    const v = p?.position ?? p?.feetPosition ?? null;
    if (!v || !Number.isFinite(v.x)) {
      const cam = this.ctx.camera;
      if (cam?.position && Number.isFinite(cam.position.x)) { out.copy(cam.position); return true; }
      return false;
    }
    out.copy(v);
    return true;
  }

  _nearestCamperDistance() {
    const c = this._campers();
    if (!c) return Infinity;
    try {
      const nd = c.nearestDistance;
      if (typeof nd === 'number' && Number.isFinite(nd)) return nd;
      if (typeof c.nearest?.distance === 'number') return c.nearest.distance;
      const list = c.agents ?? c.campers ?? c.list ?? null;
      if (!Array.isArray(list) || !list.length) return Infinity;
      if (!this._playerPos(_v0)) return Infinity;
      let best = Infinity;
      for (const a of list) {
        const p = a?.position;
        if (!p || !Number.isFinite(p.x)) continue;
        const dx = p.x - _v0.x, dy = (p.y ?? 0) - _v0.y, dz = p.z - _v0.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best) best = d2;
      }
      return best === Infinity ? Infinity : Math.sqrt(best);
    } catch { return Infinity; }
  }

  _maxDetection() {
    if (this.ctx.state?.spotted === true) return 1;
    const c = this._campers();
    if (!c) return 0;
    try {
      if (typeof c.detection === 'number' && Number.isFinite(c.detection)) return clamp01(c.detection);
      if (typeof c.maxDetection === 'number' && Number.isFinite(c.maxDetection)) return clamp01(c.maxDetection);
      const list = c.agents ?? c.campers ?? c.list ?? null;
      if (!Array.isArray(list)) return 0;
      let best = 0;
      for (const a of list) {
        if (!a) continue;
        let v = Number(a.detection);
        if (!Number.isFinite(v)) v = Number(a.detectionLevel);
        if (!Number.isFinite(v)) v = Number(a.awareness);
        if (Number.isFinite(v) && v > best) best = v;
      }
      return clamp01(best);
    } catch { return 0; }
  }

  _countState(match) {
    const c = this._campers();
    if (!c) return 0;
    try {
      const list = c.agents ?? c.campers ?? c.list ?? null;
      if (!Array.isArray(list)) return 0;
      let n = 0;
      for (const a of list) if (a && match.test(String(a.state ?? a.fsm ?? ''))) n++;
      return n;
    } catch { return 0; }
  }

  _alertedCount() { return this._countState(RE_ALERTED); }
  _searchingCount() { return this._countState(RE_SEARCHING); }

  _playerLum() {
    const f = this._flashlight();
    let lum = 0.12;
    try {
      const v = f?.visibilityContribution;
      if (typeof v === 'number' && Number.isFinite(v)) lum = Math.max(lum, clamp01(v));
      else if (typeof v === 'function') lum = Math.max(lum, clamp01(Number(f.visibilityContribution()) || 0));
      if (f?.on) lum = Math.max(lum, 0.55 * (1 - clamp01(finite(f.hoodLevel, 0))));
    } catch { /* noop */ }
    if (this.ctx.state?.campLightsOn) lum = Math.max(lum, 0.30);
    return clamp01(lum);
  }

  _flashlight() { return this._sys('Flashlight'); }

  _installedThisNight() {
    const bs = this._build();
    if (bs && typeof bs.installedCount === 'number') return bs.installedCount;
    const st = this.ctx.state;
    if (st?.installed && typeof st.installed === 'object') {
      let n = 0;
      for (const k of Object.keys(st.installed)) {
        const rec = st.installed[k];
        if (!rec) continue;
        if (Number.isFinite(rec.night) && rec.night !== this.night) continue;
        n++;
      }
      return n;
    }
    return 0;
  }

  /** Progress as the rubber band sees it: stagesDone/stagesTotal, refined by slots inside it. */
  _progressFraction() {
    const bs = this._build();
    if (bs && typeof bs.progress === 'number' && Number.isFinite(bs.progress)) return clamp01(bs.progress);
    const total = Math.max(1, this.def.slots);
    return clamp01(this._installedThisNight() / total);
  }

  _workComplete() {
    if (this.night === 7) return this._ending !== null;
    const bs = this._build();
    if (bs) {
      const done = finite(bs.installedCount, -1);
      const total = finite(bs.slotCount, -1);
      if (done >= 0 && total > 0) return done >= total;
      if (typeof bs.progress === 'number') return bs.progress >= 0.999;
    }
    return this._installedThisNight() >= this.def.slots;
  }

  /** §13.2 'incomplete': Night 6 ends with the roof or the doorframe unbuilt. */
  _roofOrDoorframeUnbuilt() {
    const bs = this._build();
    if (!bs) return false;   // we cannot observe it, so we never assert it
    let sawTarget = false;
    let unbuilt = false;
    try {
      const slots = bs.nightSlots ?? bs.slots ?? null;
      if (!Array.isArray(slots)) return false;
      for (const s of slots) {
        const id = String(s?.id ?? '');
        if (!RE_ROOF.test(id)) continue;
        sawTarget = true;
        if (!bs.joins?.has?.(s.id)) { unbuilt = true; break; }
      }
    } catch { return false; }
    return sawTarget && unbuilt;
  }

  /**
   * Resolve a named position. Navmesh's published anchors win (it snapped them to walkable
   * ground), then Terrain's, then §3.3's table. Writes into `out`, returns success.
   */
  _anchor(name, out = _v0) {
    const key = String(name ?? '').toLowerCase().replace(/-/g, '_');
    const nav = this._nav();
    const navName = NAV_ALIAS[key] ?? key.replace(/_/g, '-');
    if (nav && typeof nav.anchor === 'function') {
      try {
        const a = nav.anchor(navName);
        if (a && Number.isFinite(a.x)) { out.copy(a); return true; }
      } catch { /* noop */ }
    }
    const terr = this._terrain();
    if (terr) {
      const map = { plot: 'buildSiteCenter', cabin_site: 'buildSiteCenter', build_site: 'buildSiteCenter', dock: 'dock', camp: 'campCenter', mess_hall: 'campCenter', cabins: 'campCenter', office: 'campCenter', payphone: 'campCenter' };
      const prop = map[key];
      const v = prop ? terr[prop] : null;
      if (v && Number.isFinite(v.x)) { out.copy(v); return true; }
      if (key === 'ridge' && typeof terr.nearestRidgePoint === 'function') {
        try {
          if (this._playerPos(_v2)) {
            const r = terr.nearestRidgePoint(_v2.x, _v2.z);
            if (r && Number.isFinite(r.x)) { out.copy(r); return true; }
          }
        } catch { /* noop */ }
      }
    }
    const xz = ANCHORS[key];
    if (!xz) return false;
    let y = 0;
    if (terr && typeof terr.heightAt === 'function') { try { y = finite(terr.heightAt(xz[0], xz[1]), 0); } catch { y = 0; } }
    out.set(xz[0], y, xz[1]);
    return true;
  }

  _emit(name, payload) {
    try { this.bus?.emit?.(name, payload); }
    catch (e) { Log.once(`nm:emit:${name}`, `NightManager: '${name}' listener threw`, e); }
  }
}

/**
 * The three long `Scripted` beats (§9.7). During these the camper's senses still run — she
 * still reacts to a creak — but her state transitions are suppressed, and the grab is refused
 * with zero feedback (§13.4). Durations are §5.3's T_beat budget.
 */
const SCRIPTED_BEATS = Object.freeze({
  n4_dale: { seconds: 120, grabRefused: false },
  n6_robin_inside: { seconds: 90, grabRefused: true },
  n6_bev_remembers: { seconds: 60, grabRefused: true },
  n5_two_persons: { seconds: 110, grabRefused: false },
});

NightManager.NIGHTS = NIGHTS;
NightManager.TUNING = TUNING;
NightManager.CARD_LINES = CARD_LINES;
NightManager.ANCHORS = ANCHORS;

export default NightManager;
