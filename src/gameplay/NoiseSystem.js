/**
 * NoiseSystem — propagation, occlusion, masking.
 *
 * OWNER: AI agent.  Binding specs: GAME_DESIGN.md §9.8 (the model), §9.6 (the 2 m occlusion
 * grid), §7.5 (thunder masking + the mask floor table), §3.3 (the map), AUDIO_DIRECTION.md
 * §1.3 (the kind→loudness contract), ARCHITECTURE.md §5 (`noise:emit`).
 *
 * ---------------------------------------------------------------------------------------------
 * THE MODEL, in one block (GAME_DESIGN.md §9.8, verbatim, plus the two extensions this file owns)
 *
 *   falloff   = clamp01(1 - d / rEff) ^ 1.5
 *   occlusion = product of the 4 strongest blocker factors along the path
 *                 × 0.92 ^ (dense-undergrowth 2 m segments)
 *   mask      = 1 - maskLevel
 *   heard     = intensity * falloff * occlusion * mask
 *
 *   rEff      = radius * (1 + 0.35 * waterFraction)      // the lake extension, see below
 *
 * `heard` is the number `Campers.js` compares against `camper.hearingThreshold`
 * (0.08 Robin / 0.09 Bev / 0.11 counselor / 0.13 Coop / 0.18 Teddy / 0.08 Ranger).
 *
 * Two deliberate properties:
 *
 *  1. THE AUDIBLE RADIUS IS PREDICTABLE AND SOLVABLE. Given a threshold, `audibleRadius()`
 *     inverts the falloff analytically. A creak of intensity 0.7 and radius 46 m is heard by a
 *     counselor (0.11) out to 46 × (1 − (0.11/0.7)^(2/3)) = 32.9 m in the open, every single
 *     time. Unpredictable stealth is bad stealth; the player is meant to learn this number.
 *  2. WHAT THE AI HEARS AND WHAT THE PLAYER HEARS ARE THE SAME NUMBER. `acousticsAt()` returns
 *     the attenuation *and* a lowpass cutoff derived from the identical occlusion walk, so
 *     `AudioEngine` can filter playback with the values the AI reasoned about. If these two ever
 *     diverge the game becomes unfair in a way the player cannot diagnose.
 *
 * ---------------------------------------------------------------------------------------------
 * THE OCCLUSION GRID (GAME_DESIGN.md §9.6)
 *
 * Three byte grids at 2 m over the whole terrain, ~64 KB each:
 *
 *   _gStatic  min acoustic factor of registered STATIC|PROP colliders in the cell (trunk 0.88,
 *             rock/building 0.45–0.50, tent 0.90, crate 0.70 — from `Physics.KINDS`)
 *   _gBuild   the same for LAYER.BUILD — the cabin. Rebaked on build:place / build:remove, so
 *             a placed panel writes 0.65 into the cells it spans and the cabin becomes an
 *             acoustic object the moment it becomes a physical one.
 *   _gEnv     packed: baked flag, water flag, forest density 0..63
 *
 * Queries walk the segment at 2 m and read bytes. No raycasts — §9.6 requires this, and it is
 * also the only way 7 campers × 8 live events can be evaluated every frame inside budget.
 * Blockers are counted with run-length dedupe (a wall crossed at a grazing angle is one wall)
 * and capped at 4, matching `Physics.occlusionAlong()` so the two paths agree.
 *
 * The bake is incremental (a few hundred cells per frame, plot-first). Unbaked cells fall back
 * to direct Terrain queries, so the system is correct — merely coarser — from frame one, and
 * fully correct with no world systems at all.
 *
 * ---------------------------------------------------------------------------------------------
 * MASKING (GAME_DESIGN.md §7.5)
 *
 *   maskFloor = 0.30*rain + 0.22*wind          // 0.037 on Night 7, 0.457 on Night 6
 *   maskLevel = max(maskFloor, thunderEnvelope)
 *
 * Thunder ramps 0 → 0.85 over 0.4 s, holds, decays over 1.2 s. It multiplies intensity; it does
 * NOT shrink `radius` (§7.5.4 — the noise exists, campers just do not resolve it). At 0.85 a
 * hammer at 0.55 arrives as 0.0825, below every counselor's threshold: "masks completely" in
 * practice, at the number the design document specifies.
 *
 * The window is telegraphed, because a mechanic the player cannot see coming is not a mechanic:
 * `maskWindowIncoming` counts down from the lightning flash to the thunder, `maskWindowRemaining`
 * counts the cover down while it lasts. HUD and BuildSystem read them directly.
 *
 * An event stores the mask that was in force WHEN IT HAPPENED. A hammer blow struck under
 * thunder does not become audible when the thunder stops.
 *
 * ---------------------------------------------------------------------------------------------
 * THE LAKE (the one rule this file adds to the spec)
 *
 * A path that crosses water extends the emitter's radius by up to 35%: `rEff = radius *
 * (1 + 0.35 * waterFraction)`. Water is flat, wet and cold and reflects almost everything that
 * hits it, which is why every real lake carries a voice from the far shore. Expressed as a
 * radius extension rather than a gain so it shows up in `audibleRadius()`, on the debug ring,
 * and in the player's mental model: THE SHORELINE IS A DANGEROUS PLACE TO BE LOUD. The boathouse
 * (96 m), the canoe rack (84 m) and the dock (108 m) are all on it.
 *
 * ---------------------------------------------------------------------------------------------
 * PUBLIC API
 *
 *   audibilityAt(listenerPos, ev, listenerId?)     -> 0..1        the §9.8 number
 *   recentNoises                                   -> NoiseEvent[]  live ring buffer
 *   emit(position, radius, intensity, kind)        -> NoiseEvent|null
 *   acousticsAt(listenerPos, ev, out?)             -> { attenuation, lowpassHz, ... }
 *   occlusionBetween(from, to, out?)               -> 0..1
 *   lowpassFor(occlusion, distance, waterFraction) -> Hz
 *   audibleRadius(ev, threshold?, dirX?, dirZ?)    -> metres
 *   pollNoise(listenerPos, threshold, sinceSeq, out, listenerId?) -> out|null
 *   errorRadiusFor(heard)                          -> metres    (§9.8: 4 + 14*(1-heard))
 *   investigationPoint(ev, heard, rand, out)       -> Vector3
 *   maskLevel, maskWindowRemaining, maskWindowIncoming, maskFloor   (live scalars)
 *   playerNoise                                    -> the HUD's self-loudness readout
 *   debugDraw(force?)                              -> ?noisedebug rings
 *
 * `debugDraw` is gated behind `?noisedebug` in the URL.
 */

import * as THREE from 'three';
import { Log } from '../core/Log.js';

// =================================================================================================
// Tuning. Every number here is either lifted from a design document (cited) or owned by this file.
// =================================================================================================

export const TUNING = {
  // --- propagation (GAME_DESIGN.md §9.8) ---
  falloffExp: 1.5,
  blockerCap: 4,              // matches Physics.occlusionAlong(maxBlockers = 4)
  ridgeFactor: 0.50,          // "Terrain ridge (grid cell below heightfield)"
  ridgeBias: 0.15,            // m of clearance before the line counts as blocked
  undergrowthFactor: 0.92,    // "Dense undergrowth (per 2 m)"
  undergrowthThreshold: 0.55, // forest density below this is trunks-and-air, not thicket
  undergrowthMaxSegments: 8,  // floor of 0.92^8 = 0.51 — a thicket is not a wall
  occlusionFloor: 0.02,

  // --- the lake (owned here; see the header) ---
  lakeRadiusGain: 0.35,
  lakeLowpassGain: 1.18,

  // --- ring buffer ---
  poolSize: 64,
  eventLife: 4.0,             // s — "so an AI that was looking elsewhere can still notice"
  coalesceTime: 0.25,         // s — sustained emitters (the saw) refresh instead of flooding
  coalesceDist: 1.5,          // m

  // --- masking (GAME_DESIGN.md §7.5) ---
  maskRainCoef: 0.30,
  maskWindCoef: 0.22,
  thunderPeak: 0.85,
  thunderRamp: 0.40,
  thunderDecay: 1.20,
  thunderEnvelopeStorm: 7.6,  // N6 mean of 6.0 + 4.0*(1 - d/4.2)
  thunderEnvelopeOther: 4.1,  // pre-storm mean of 2.5 + 3.5*(1 - d/4.2)
  flashToThunderDefault: 6.7, // mean of distance 0.4..4.2 km × 2.9 s/km
  windowOpenDelta: 0.18,      // maskLevel above the floor by this much = a real window

  // --- audio hand-off ---
  lowpassOpenHz: 20000,
  lowpassFloorHz: 180,
  lowpassOccExp: 3.5,         // wall 0.45 -> 1.2 kHz; trunk 0.88 -> 12.8 kHz; ridge 0.50 -> 1.8 kHz
  airAbsorptionPerM: 0.010,   // 30 m -> 16.3 kHz, 90 m -> 8.9 kHz, 400 m -> 0.4 kHz

  // --- player feedback ---
  playerAttributionDist: 3.0, // m — a noise this close to the player is the player's
  playerReachRef: 60.0,       // m mapped to level 1.0 on the HUD meter
  playerMeterDecay: 1.6,      // 1/s

  // --- grid ---
  cell: 2.0,
  sampleHeight: 1.2,          // m above ground: ignores 0.4 m piers, catches a 2.4 m frame
  maxSamples: 72,
  bakeRadiusScale: 0.75,      // overlapSphere radius = cell * this

  // --- defaults ---
  defaultThreshold: 0.11,     // a counselor (GAME_DESIGN.md §9.1)
};

/**
 * The canonical `noise:emit` vocabulary — GAME_DESIGN.md §9.8 / AUDIO_DIRECTION.md §1.3.
 * Used to repair malformed payloads and to classify events for the AI and the HUD.
 *   ai      — campers resolve it at all (thunder and voice are explicitly ignored by campers)
 *   player  — attributable to the player, so it drives the self-loudness readout
 */
const KINDS = {
  footstep: { radius: 9, intensity: 0.18, ai: true, player: true, life: 3.0 },
  brush: { radius: 6, intensity: 0.12, ai: true, player: true, life: 3.0 },
  drag: { radius: 22, intensity: 0.38, ai: true, player: true, life: 2.0 },
  drop: { radius: 26, intensity: 0.55, ai: true, player: true, life: 4.0 },
  impact: { radius: 30, intensity: 0.60, ai: true, player: true, life: 4.0 },
  hammer: { radius: 34, intensity: 0.42, ai: true, player: true, life: 3.0 },
  wrench: { radius: 24, intensity: 0.45, ai: true, player: true, life: 3.0 },
  saw: { radius: 90, intensity: 0.62, ai: true, player: true, life: 1.2 },
  creak: { radius: 30, intensity: 0.35, ai: true, player: true, life: 5.0 },
  whistle: { radius: 90, intensity: 0.90, ai: true, player: false, life: 6.0 },
  voice: { radius: 26, intensity: 0.30, ai: false, player: false, life: 2.5 },
  thunder: { radius: 400, intensity: 1.00, ai: false, player: false, life: 10.0 },
};
const DEFAULT_KIND = KINDS.impact;

/** GAME_DESIGN.md §7.5 — rain/wind per night, and therefore the mask floor per night. */
const NIGHT_WEATHER = [
  null,
  { rain: 0.15, wind: 0.20 },   // 1  0.089  almost nothing
  { rain: 0.40, wind: 0.35 },   // 2  0.197  drizzle helps a little
  { rain: 0.10, wind: 0.55 },   // 3  0.151  wind, not rain — the saw needs it
  { rain: 0.75, wind: 0.60 },   // 4  0.357  the loudest night is the safest to be loud in
  { rain: 0.25, wind: 0.30 },   // 5  0.141  fog hides you visually and not at all audibly
  { rain: 0.90, wind: 0.85 },   // 6  0.457  the storm
  { rain: 0.05, wind: 0.10 },   // 7  0.037  dead still
];

/** Local copy of Physics' layer bits, so a missing Physics cannot break this module. */
const LAYER = {
  TERRAIN: 1 << 0, STATIC: 1 << 1, BUILD: 1 << 2, PROP: 1 << 3,
  FOLIAGE: 1 << 4, ACTOR: 1 << 5, WATER: 1 << 6,
};

/** Fallback acoustic factors, keyed by `Physics` collider kind (GAME_DESIGN.md §9.8 table). */
const KIND_OCCLUSION = {
  trunk: 0.88, tree: 0.88, stump: 0.80, rock: 0.50, undergrowth: 0.92, foliage: 0.92,
  wall: 0.65, panel: 0.65, beam: 0.75, post: 0.80, floor: 0.65, roof: 0.65,
  tent: 0.90, building: 0.45, vehicle: 0.45, crate: 0.70, prop: 0.70, part: 0.75,
  actor: 0.85, water: 1.00, terrain: 0.50,
};

// packed _gEnv byte: bit7 baked, bit6 water, bits0..5 density
const ENV_BAKED = 0x80;
const ENV_WATER = 0x40;
const ENV_DENS = 0x3f;

// =================================================================================================
// Module scratch. Nothing below this line allocates during a frame.
// =================================================================================================

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _hits = new Array(64);
const _blockers = new Float64Array(4);   // the 4 strongest factors along a path

/** Shared result of the last occlusion walk. Valid until the next query. */
const _walkResult = {
  occlusion: 1, blockers: 0, ridge: false, ridgeDepth: 0,
  thicket: 0, waterFraction: 0, samples: 0, distance: 0,
};

/** Shared result of the last acousticsAt(). Valid until the next query. */
const _acoustics = {
  heard: 0, attenuation: 0, distance: 0, falloff: 0, occlusion: 1, mask: 0,
  lowpassHz: TUNING.lowpassOpenHz, energyGain: 0, gainDb: -120,
  waterFraction: 0, effectiveRadius: 0, ridge: false, blockers: 0,
};

const _poll = {
  event: null, heard: 0, seq: -1, errorRadius: 0, distance: 0,
  point: new THREE.Vector3(), kind: '',
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Deterministic [0,1) from two integers — used instead of RNG for stable per-camper guesses. */
function hash2i(a, b) {
  let h = (a | 0) * 0x27d4eb2d ^ (b | 0) * 0x165667b1;
  h ^= h >>> 15; h = Math.imul(h, 0x2545f491); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// =================================================================================================
// NoiseEvent — pooled. Never allocated after init().
// =================================================================================================

/**
 * One live noise. Instances are POOLED and RECYCLED: hold a reference for the frame, copy
 * `position` if you need it longer. `seq` is monotonic and is the safe identity to store.
 */
export class NoiseEvent {
  constructor(index) {
    this.index = index;
    this.seq = -1;
    this.position = new THREE.Vector3();
    this.radius = 0;
    this.intensity = 0;
    this.kind = 'impact';
    this.t = 0;              // elapsed seconds at emission
    this.age = 0;
    this.life = TUNING.eventLife;
    this.strength = 0;       // 1 → 0 across `life`; AI weighting, not audibility
    this.alive = false;
    this.aiRelevant = true;
    this.byPlayer = false;
    this.maskAtEmit = 0;     // the mask in force when it happened — see the header
    this.repeats = 0;        // coalesced sustained hits (the saw)
    this.surface = '';
  }

  reset() {
    this.alive = false;
    this.seq = -1;
    this.repeats = 0;
    this.strength = 0;
  }
}

// =================================================================================================

export class NoiseSystem {
  constructor(ctx) {
    this.ctx = ctx ?? null;
    this.bus = ctx?.bus ?? null;
    this.name = 'NoiseSystem';

    // ---- ring buffer -------------------------------------------------------------------------
    this._pool = new Array(TUNING.poolSize);
    for (let i = 0; i < TUNING.poolSize; i++) this._pool[i] = new NoiseEvent(i);
    this._cursor = 0;
    this._seq = 0;

    /** @type {NoiseEvent[]} live events, compacted every frame and after every ingest. */
    this.recentNoises = new Array(TUNING.poolSize);
    this.recentNoises.length = 0;

    // ---- masking -----------------------------------------------------------------------------
    this.maskLevel = 0;              // 0..1, current global audibility suppression
    this.maskFloor = 0;              // 0.30*rain + 0.22*wind
    this.maskWindowRemaining = 0;    // s of thunder cover left (0 = none)
    this.maskWindowIncoming = Infinity; // s until cover opens (Infinity = unknown / none)
    this.maskWindowOpen = false;
    this.rain = 0.15;
    this.wind = 0.20;
    this._eventRain = null;
    this._eventWind = null;
    this._weatherSource = 'night-table';

    this._thunderT = -1;             // seconds into my own envelope, or -1
    this._thunderHold = 0;
    this._flashSeen = -1;            // elapsed time of the last lightning rising edge
    this._flashPrev = 0;
    this._flashToThunder = TUNING.flashToThunderDefault;
    this._windowElapsed = 0;
    this._windowEstimate = 0;

    // ---- player feedback ---------------------------------------------------------------------
    /**
     * The HUD's self-loudness readout. `level` 0..1, `reach` in metres at a counselor's
     * threshold with no cover, `dir*` a unit XZ vector from the player toward the source
     * (a creak points at the cabin; a footstep has `dirValid = false`).
     */
    this.playerNoise = {
      active: false, kind: '', level: 0, reach: 0, intensity: 0,
      x: 0, y: 0, z: 0, dirX: 0, dirZ: 0, dirValid: false,
      age: 0, seq: -1, masked: 0,
    };
    this.playerLoudness = 0;         // smoothed 0..1 meter
    this._playerPos = new THREE.Vector3();
    this._playerPosValid = false;
    this._pendingFootstep = null;
    this._lastFootstepNoiseT = -10;
    this._lastIngested = null;
    this._lastDt = 1 / 60;

    // ---- occlusion grid ----------------------------------------------------------------------
    this.cell = TUNING.cell;
    this.invCell = 1 / TUNING.cell;
    this.gridMinX = -256; this.gridMinZ = -256;
    this.gridNX = 0; this.gridNZ = 0;
    this._gStatic = null; this._gBuild = null; this._gEnv = null;
    this._bakePhase = 0;             // 0 = plot box, 1 = the rest, 2 = done
    this._bakeCursor = 0;
    this._bakeInner = { x0: 0, z0: 0, x1: 0, z1: 0 };
    this._bakeBudget = 512;
    this._buildDirty = false;
    this._buildRect = { x0: 0, z0: 0, x1: 0, z1: 0 };
    this._buildCursor = 0;
    this._plotX = 0; this._plotZ = 0;

    // ---- cache (event slot × listener slot) ---------------------------------------------------
    this._cacheSlots = 12;
    this._cacheOcc = new Float32Array(TUNING.poolSize * this._cacheSlots);
    this._cacheWat = new Float32Array(TUNING.poolSize * this._cacheSlots);
    this._cacheT = new Float32Array(TUNING.poolSize * this._cacheSlots).fill(-1);
    this._cacheTTL = 0.20;

    // ---- refs / state ------------------------------------------------------------------------
    this.terrain = null; this.physics = null; this.weather = null;
    this.forest = null; this.cabinSite = null; this._uniforms = null;
    this._maskSound = LAYER.STATIC | LAYER.PROP;
    this._maskBuild = LAYER.BUILD;

    this._now = 0;
    this._unsubs = [];
    this._disposed = false;
    this._initialised = false;

    this.stats = {
      live: 0, ingested: 0, queries: 0, walks: 0, cacheHits: 0,
      bakeProgress: 0, samples: 0,
    };

    // ---- debug -------------------------------------------------------------------------------
    this.debugEnabled = false;
    try {
      const p = new URLSearchParams(globalThis.location?.search ?? '');
      this.debugEnabled = p.has('noisedebug');
    } catch { /* non-browser */ }
    this._dbg = null;
    this._dbgEl = null;
    this._dbgT = 0;
  }

  // ===============================================================================================
  // Lifecycle
  // ===============================================================================================

  async init() {
    if (this._disposed) return;
    const ctx = this.ctx;
    const sys = ctx?.systems;

    this.terrain = sys?.get?.('Terrain') ?? null;
    this.physics = sys?.get?.('Physics') ?? null;
    this.weather = sys?.get?.('Weather') ?? null;
    this.forest = sys?.get?.('Forest') ?? null;
    this.cabinSite = sys?.get?.('CabinSite') ?? null;

    // Physics publishes its layer bits on the instance; prefer them over the local copy.
    const L = this.physics?.LAYER ?? LAYER;
    this._maskSound = (L.STATIC | L.PROP) >>> 0;
    this._maskBuild = (L.BUILD) >>> 0;

    try {
      const M = await import('../render/Materials.js');
      this._uniforms = M?.globalUniforms ?? M?.Materials?.globalUniforms ?? null;
    } catch {
      this._uniforms = null;   // Materials is optional; the night table covers us.
    }

    this._allocGrid();
    this._resolvePlot();
    this._bakeBudget = ctx?.settings?.tier?.(200, 400, 700, 1100) ?? 512;
    this._refreshWeatherInputs(true);
    this._bind();

    if (!this.physics) {
      Log.once('noise:nophysics',
        'NoiseSystem: no Physics — occlusion falls back to terrain ridges and forest density only.');
    }

    this._initialised = true;
    if (this.debugEnabled) {
      this._buildDebug();
      this._selfTest();
    }
    Log.debug(`NoiseSystem ready: grid ${this.gridNX}×${this.gridNZ} @ ${this.cell} m, ` +
      `bake ${this._bakeBudget} cells/frame`);
  }

  _bind() {
    const bus = this.bus;
    if (!bus) return;
    const on = (ev, fn) => { this._unsubs.push(bus.on(ev, fn)); };

    on('noise:emit', (p) => this._onNoise(p));
    on('player:move', (p) => {
      if (p?.position) { this._playerPos.copy(p.position); this._playerPosValid = true; }
    });
    // Bridge: if Player emits player:footstep but forgets the noise:emit, the core mechanic
    // still works. Deferred one frame and cancelled by a matching noise:emit, so no double count.
    on('player:footstep', (p) => this._onFootstep(p));
    on('weather:change', (p) => {
      if (isNum(p?.rain)) this._eventRain = clamp01(p.rain);
      if (isNum(p?.wind)) this._eventWind = clamp01(p.wind);
      this._refreshWeatherInputs(false);
    });
    on('night:begin', () => {
      this._refreshWeatherInputs(true);
      this._clearAll();
      this._rebakeAll();
    });
    on('build:place', () => this._markBuildDirty());
    on('build:remove', () => this._markBuildDirty());
    on('build:stage-complete', () => this._markBuildDirty());
    on('game:resume', () => { this._flashPrev = 0; });
  }

  // ===============================================================================================
  // Ingest
  // ===============================================================================================

  /**
   * Convenience emitter. Publishes the canonical `noise:emit` so AudioEngine and anyone else
   * hears it too; this system ingests its own bus event. Falls back to direct ingest with no bus.
   * @returns {NoiseEvent|null}
   */
  emit(position, radius, intensity, kind) {
    if (this._disposed || !position) return null;
    const k = KINDS[kind] ? kind : (kind || 'impact');
    const def = KINDS[k] ?? DEFAULT_KIND;
    const r = isNum(radius) ? radius : def.radius;
    const i = isNum(intensity) ? intensity : def.intensity;
    if (this.bus) {
      this._lastIngested = null;
      this.bus.emit('noise:emit', { position, radius: r, intensity: i, kind: k });
      return this._lastIngested;
    }
    return this._ingest(position, r, i, k);
  }

  _onNoise(p) {
    if (this._disposed || !p) return;
    const pos = p.position ?? p.pos ?? null;
    if (!pos || !isNum(pos.x)) return;
    const kind = typeof p.kind === 'string' && p.kind ? p.kind : 'impact';
    const def = KINDS[kind] ?? DEFAULT_KIND;
    const radius = isNum(p.radius) ? p.radius : def.radius;
    const intensity = isNum(p.intensity) ? p.intensity : def.intensity;
    if (kind === 'footstep') this._lastFootstepNoiseT = this._now;
    const ev = this._ingest(pos, radius, intensity, kind);
    if (ev && typeof p.surface === 'string') ev.surface = p.surface;
    this._lastIngested = ev;
  }

  _onFootstep(p) {
    if (this._disposed || !p?.position) return;
    // Remember it; `update()` promotes it only if no footstep noise:emit arrived alongside.
    this._playerPos.copy(p.position);
    this._playerPosValid = true;
    this._pendingFootstep = this._pendingFootstep ?? { x: 0, y: 0, z: 0, loud: 0, surface: '', t: 0 };
    this._pendingFootstep.x = p.position.x;
    this._pendingFootstep.y = p.position.y;
    this._pendingFootstep.z = p.position.z;
    this._pendingFootstep.loud = isNum(p.loud) ? clamp01(p.loud) : 0.18;
    this._pendingFootstep.surface = typeof p.surface === 'string' ? p.surface : '';
    this._pendingFootstep.t = this._now;
  }

  /** @returns {NoiseEvent|null} */
  _ingest(position, radius, intensity, kind) {
    if (this._disposed) return null;
    const def = KINDS[kind] ?? DEFAULT_KIND;
    const r = Math.max(0.5, radius);
    const i = clamp01(intensity);
    const now = this._now;

    // Coalesce sustained emitters (the saw runs continuously for 5.2 s per pass).
    const cd2 = TUNING.coalesceDist * TUNING.coalesceDist;
    for (let n = 0; n < this.recentNoises.length; n++) {
      const e = this.recentNoises[n];
      if (e.kind !== kind || now - e.t > TUNING.coalesceTime) continue;
      const dx = e.position.x - position.x, dy = e.position.y - position.y,
        dz = e.position.z - position.z;
      if (dx * dx + dy * dy + dz * dz > cd2) continue;
      e.t = now; e.age = 0; e.strength = 1;
      e.radius = Math.max(e.radius, r);
      e.intensity = Math.max(e.intensity, i);
      e.maskAtEmit = this.maskLevel;
      e.repeats++;
      this._invalidateCache(e.index);
      if (e.byPlayer) this._notePlayerNoise(e);
      return e;
    }

    const ev = this._pool[this._cursor];
    this._cursor = (this._cursor + 1) % TUNING.poolSize;
    if (ev.alive) {
      Log.once('noise:saturated',
        `NoiseSystem: ${TUNING.poolSize} live events — the oldest is being recycled early.`);
    }
    this._invalidateCache(ev.index);

    ev.position.set(position.x, position.y, position.z);
    ev.radius = r;
    ev.intensity = i;
    ev.kind = kind;
    ev.t = now;
    ev.age = 0;
    ev.life = def.life ?? TUNING.eventLife;
    ev.strength = 1;
    ev.alive = true;
    ev.aiRelevant = def.ai !== false;
    ev.maskAtEmit = this.maskLevel;
    ev.repeats = 0;
    ev.surface = '';
    ev.seq = ++this._seq;
    ev.byPlayer = this._isPlayerCaused(kind, ev.position);

    if (kind === 'thunder') this._openThunder();
    if (ev.byPlayer) this._notePlayerNoise(ev);
    if (this.debugEnabled) this._assignDebugRing(ev);

    this.stats.ingested++;
    this._compact();
    return ev;
  }

  _isPlayerCaused(kind, pos) {
    const def = KINDS[kind];
    if (!def || def.player !== true) return false;
    // The cabin only creaks and only saws because of the player; everything else is proximity.
    if (kind === 'creak' || kind === 'saw' || kind === 'hammer' || kind === 'wrench') return true;
    const p = this._playerRef();
    if (!p) return true;
    const d = TUNING.playerAttributionDist;
    const dx = p.x - pos.x, dy = p.y - pos.y, dz = p.z - pos.z;
    return dx * dx + dy * dy + dz * dz <= d * d;
  }

  _playerRef() {
    if (this._playerPosValid) return this._playerPos;
    const cam = this.ctx?.camera;
    if (cam?.position) return cam.position;
    return null;
  }

  _notePlayerNoise(ev) {
    const pn = this.playerNoise;
    const reach = this.audibleRadius(ev, TUNING.defaultThreshold);
    // Keep whichever of (this, the current readout) is louder while the readout is fresh.
    if (pn.active && pn.age < 0.35 && reach < pn.reach) return;
    pn.active = true;
    pn.kind = ev.kind;
    pn.reach = reach;
    pn.intensity = ev.intensity;
    pn.level = clamp01(reach / TUNING.playerReachRef);
    pn.x = ev.position.x; pn.y = ev.position.y; pn.z = ev.position.z;
    pn.age = 0;
    pn.seq = ev.seq;
    pn.masked = ev.maskAtEmit;
    const p = this._playerRef();
    if (p) {
      const dx = ev.position.x - p.x, dz = ev.position.z - p.z;
      const len = Math.hypot(dx, dz);
      pn.dirValid = len > 1.5;
      pn.dirX = pn.dirValid ? dx / len : 0;
      pn.dirZ = pn.dirValid ? dz / len : 0;
    } else {
      pn.dirValid = false; pn.dirX = 0; pn.dirZ = 0;
    }
    if (pn.level > this.playerLoudness) this.playerLoudness = pn.level;
  }

  // ===============================================================================================
  // Frame
  // ===============================================================================================

  update(dt, elapsed) {
    if (this._disposed || !this._initialised) return;
    const d = isNum(dt) ? clamp(dt, 0, 0.1) : 0;
    this._lastDt = d;
    this._now = isNum(elapsed) ? elapsed : this._now + d;

    this.stats.queries = 0; this.stats.walks = 0;
    this.stats.cacheHits = 0; this.stats.samples = 0;

    this._promotePendingFootstep();
    this._refreshWeatherInputs(false);
    this._updateMask(d);
    this._decay(d);
    this._bakeStep();
    this._buildBakeStep();

    // player readout decay
    const pn = this.playerNoise;
    if (pn.active) {
      pn.age += d;
      if (pn.age > 1.6) pn.active = false;
    }
    this.playerLoudness = Math.max(0, this.playerLoudness - TUNING.playerMeterDecay * d);

    if (this.debugEnabled) this.debugDraw();
  }

  _promotePendingFootstep() {
    const f = this._pendingFootstep;
    if (!f || f.t < 0) return;
    // A real noise:emit for this footstep landed within the same frame — nothing to do.
    if (Math.abs(this._lastFootstepNoiseT - f.t) < 0.05 || this._lastFootstepNoiseT >= f.t) {
      f.t = -1; return;
    }
    if (this._now - f.t > 0.25) { f.t = -1; return; }
    // Map `loud` onto the §9.8 footstep rows so the bridged event carries the canonical numbers.
    const loud = f.loud;
    const intensity = loud <= 0.10 ? 0.08 : loud <= 0.24 ? 0.18 : loud <= 0.36 ? 0.30 : 0.45;
    const radius = intensity <= 0.08 ? 4 : intensity <= 0.18 ? 9 : intensity <= 0.30 ? 14 : 20;
    _v0.set(f.x, f.y, f.z);
    const ev = this._ingest(_v0, radius, intensity, 'footstep');
    if (ev) ev.surface = f.surface;
    f.t = -1;
  }

  _decay(dt) {
    const arr = this._pool;
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i];
      if (!e.alive) continue;
      e.age += dt;
      if (e.age >= e.life) { e.reset(); this._invalidateCache(i); continue; }
      e.strength = 1 - e.age / e.life;
    }
    this._compact();
    this.stats.live = this.recentNoises.length;
  }

  _compact() {
    const arr = this.recentNoises;
    const pool = this._pool;
    let n = 0;
    for (let i = 0; i < pool.length; i++) if (pool[i].alive) arr[n++] = pool[i];
    if (arr.length !== n) arr.length = n;
  }

  _clearAll() {
    for (let i = 0; i < this._pool.length; i++) this._pool[i].reset();
    this.recentNoises.length = 0;
    this._cacheT.fill(-1);
    this.playerNoise.active = false;
    this.playerLoudness = 0;
  }

  resize(_w, _h) { /* resolution independent */ }

  // ===============================================================================================
  // Masking — GAME_DESIGN.md §7.5
  // ===============================================================================================

  /**
   * Resolve rain/wind, in strict priority order. The night table is the floor of last resort:
   * `Materials.globalUniforms` carries plausible-looking defaults (uRain 0.15, a 0.78 wind
   * vector) that are NOT this night's weather until Weather starts driving them, so the
   * uniforms are only trusted when a Weather system exists to be driving them.
   *
   *   1. Weather's own scalars           2. the last `weather:change`
   *   3. the shared uniforms (Weather present)   4. GAME_DESIGN.md §7.5's night table
   */
  _refreshWeatherInputs(force) {
    if (force) { this._eventRain = null; this._eventWind = null; }
    const w = this.weather;
    let rain = null, wind = null, src = '';

    if (w) {
      const r = isNum(w.rain) ? w.rain : isNum(w.rain01) ? w.rain01 : null;
      const v = isNum(w.wind) ? w.wind : isNum(w.wind01) ? w.wind01 : null;
      if (r !== null || v !== null) { rain = r; wind = v; src = 'weather'; }
    }
    if (rain === null && isNum(this._eventRain)) { rain = this._eventRain; src = src || 'event'; }
    if (wind === null && isNum(this._eventWind)) { wind = this._eventWind; src = src || 'event'; }

    if (w && this._uniforms) {
      if (rain === null) {
        const ur = this._uniforms.uRain?.value;
        if (isNum(ur)) { rain = ur; src = src || 'uniforms'; }
      }
      if (wind === null) {
        const uw = this._uniforms.uWind?.value;
        if (uw && isNum(uw.x)) {
          // Wind vector magnitude against the storm's ~1.4 peak, plus the gust term: a gust
          // that bends the canopy raises the floor for exactly as long as it lasts.
          const gust = this._uniforms.uWindGust?.value;
          wind = Math.hypot(uw.x, uw.z) / 1.4 + (isNum(gust) ? gust * 0.35 : 0);
          src = src || 'uniforms';
        }
      }
    }

    if (rain === null || wind === null) {
      const n = clamp(this.ctx?.state?.night ?? 1, 1, 7) | 0;
      const row = NIGHT_WEATHER[n] ?? NIGHT_WEATHER[1];
      if (rain === null) rain = row.rain;
      if (wind === null) wind = row.wind;
      src = src || 'night-table';
    }

    this.rain = clamp01(rain);
    this.wind = clamp01(wind);
    this._weatherSource = src;
    this._recomputeFloor();
  }

  _recomputeFloor() {
    this.maskFloor = clamp01(TUNING.maskRainCoef * this.rain + TUNING.maskWindCoef * this.wind);
  }

  _openThunder() {
    const n = this.ctx?.state?.night ?? 1;
    let env = n >= 6 ? TUNING.thunderEnvelopeStorm : TUNING.thunderEnvelopeOther;
    const w = this.weather;
    const reported = w?.thunderEnvelope?.() ?? w?.maskWindowRemaining;
    if (isNum(reported) && reported > 0.5) env = reported;
    this._thunderT = 0;
    this._thunderHold = env;
    if (this._flashSeen >= 0) {
      const observed = this._now - this._flashSeen;
      if (observed > 0.3 && observed < 20) {
        this._flashToThunder += (observed - this._flashToThunder) * 0.35;
      }
      this._flashSeen = -1;
    }
  }

  _updateMask(dt) {
    // 1. lightning flash — the telegraph. Sky spikes uLightning; Weather may say it directly.
    const lv = this._uniforms?.uLightning?.value;
    if (isNum(lv)) {
      if (lv > 0.15 && this._flashPrev <= 0.15) this._flashSeen = this._now;
      this._flashPrev = lv;
    }

    // 2. my own thunder envelope (from the canonical `noise:emit { kind:'thunder' }`).
    let mine = 0;
    if (this._thunderT >= 0) {
      this._thunderT += dt;
      const t = this._thunderT;
      const { thunderRamp: ramp, thunderDecay: dec, thunderPeak: peak } = TUNING;
      const hold = this._thunderHold;
      if (t < ramp) mine = peak * (t / ramp);
      else if (t < ramp + hold) mine = peak;
      else if (t < ramp + hold + dec) mine = peak * (1 - (t - ramp - hold) / dec);
      else { mine = 0; this._thunderT = -1; }
    }

    // 3. Weather is authoritative when present; max() so neither source can be lost.
    let external = 0;
    const wm = this.weather?.maskLevel?.();
    if (isNum(wm)) external = clamp01(wm);

    this.maskLevel = clamp01(Math.max(this.maskFloor, mine, external));

    // 4. window bookkeeping — measured on the composed level, so it works with or without Weather.
    const above = this.maskLevel - this.maskFloor;
    if (above > TUNING.windowOpenDelta) {
      if (!this.maskWindowOpen) {
        this.maskWindowOpen = true;
        this._windowElapsed = 0;
        this._windowEstimate = this._thunderT >= 0
          ? TUNING.thunderRamp + this._thunderHold + TUNING.thunderDecay
          : (this.ctx?.state?.night ?? 1) >= 6
            ? TUNING.thunderEnvelopeStorm : TUNING.thunderEnvelopeOther;
      }
      this._windowElapsed += dt;
      this.maskWindowRemaining = Math.max(0, this._windowEstimate - this._windowElapsed);
      this.maskWindowIncoming = 0;
    } else {
      if (this.maskWindowOpen) { this.maskWindowOpen = false; this._flashPrev = 0; }
      this.maskWindowRemaining = 0;
      // countdown to the next window: flash → thunder, else Weather's own schedule
      let inc = Infinity;
      if (this._flashSeen >= 0) {
        inc = Math.max(0, this._flashToThunder - (this._now - this._flashSeen));
      } else {
        const nx = this.weather?.nextStrikeIn?.();
        if (isNum(nx) && nx < 600) inc = nx + this._flashToThunder;
      }
      this.maskWindowIncoming = inc;
    }
  }

  /** Current global audibility suppression, 0..1. Mirrors `Weather.maskLevel()` when it exists. */
  getMaskLevel() { return this.maskLevel; }

  /** True while thunder (or an equivalent) is covering the player. */
  isMasked() { return this.maskWindowOpen; }

  // ===============================================================================================
  // The model
  // ===============================================================================================

  /**
   * GAME_DESIGN.md §9.8. `heard = intensity * falloff * occlusion * (1 - mask)`.
   * @param {THREE.Vector3} listenerPos ear position
   * @param {NoiseEvent|{position:THREE.Vector3,radius:number,intensity:number,kind:string}} ev
   * @param {number} [listenerId] 0..11 — enables the 0.2 s occlusion cache for this listener
   * @returns {number} 0..1
   */
  audibilityAt(listenerPos, ev, listenerId = -1) {
    if (this._disposed || !listenerPos || !ev) return 0;
    const src = ev.position ?? ev;
    if (!src || !isNum(src.x)) return 0;

    const def = KINDS[ev.kind] ?? DEFAULT_KIND;
    const radius = isNum(ev.radius) ? ev.radius : def.radius;
    const intensity = clamp01(isNum(ev.intensity) ? ev.intensity : def.intensity);
    if (intensity <= 0 || radius <= 0) return 0;

    this.stats.queries++;

    const dx = listenerPos.x - src.x, dy = listenerPos.y - src.y, dz = listenerPos.z - src.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // Cheap reject before any grid work: even fully unoccluded, nothing is heard past `radius`.
    if (d >= radius * (1 + TUNING.lakeRadiusGain)) return 0;

    let occ = 1, water = 0;
    const slot = this._cacheLookup(ev, listenerId);
    if (slot >= 0) {
      occ = this._cacheOcc[slot]; water = this._cacheWat[slot];
      this.stats.cacheHits++;
    } else {
      _v0.set(src.x, src.y, src.z);
      _v1.set(listenerPos.x, listenerPos.y, listenerPos.z);
      occ = this._walk(_v0, _v1);
      water = _walkResult.waterFraction;
      this._cacheStore(ev, listenerId, occ, water);
    }

    const falloff = this.falloffAt(d, radius, water);
    if (falloff <= 0) return 0;
    const mask = 1 - this._maskFor(ev);
    return clamp01(intensity * falloff * occ * mask);
  }

  /**
   * The perceptual distance curve — GAME_DESIGN.md §9.8, `clamp01(1 - d/r)^1.5`.
   *
   * It is a re-parameterisation of inverse-square, not a replacement for it: the exponent
   * shapes the near field like 1/d² while the emitter's `radius` remains the single knob a
   * designer tunes, so "how far does a creak carry" has an exact, authored answer instead of an
   * emergent one. `acousticsAt().energyGain` is the true 1/d² figure, for gain staging.
   * @returns {number} 0..1
   */
  falloffAt(distance, radius, waterFraction = 0) {
    const rEff = Math.max(1e-3, radius) * (1 + TUNING.lakeRadiusGain * clamp01(waterFraction));
    if (distance >= rEff) return 0;
    if (distance <= 0) return 1;
    return Math.pow(1 - distance / rEff, TUNING.falloffExp);
  }

  /** Invert `falloffAt` for a threshold. Shared by `audibleRadius` and the self-test. */
  _solveRadius(radius, intensity, threshold, occlusion, mask, waterFraction) {
    const I = intensity * occlusion * mask;
    if (I <= threshold) return 0;
    const rEff = radius * (1 + TUNING.lakeRadiusGain * clamp01(waterFraction));
    return rEff * (1 - Math.pow(threshold / I, 1 / TUNING.falloffExp));
  }

  /**
   * Everything about one source→listener path, in one call: the AI's number and the numbers
   * `AudioEngine` needs to make playback sound like the same event.
   *
   *   attenuation  0..1  perceptual, == audibilityAt()
   *   energyGain   0..1  inverse-square with a 1 m reference, for a gain node
   *   gainDb             20*log10(energyGain), floored at -120
   *   lowpassHz          BiquadFilter cutoff for occlusion + air absorption
   *
   * @returns {object} shared result object, valid until the next query — copy what you keep.
   */
  acousticsAt(listenerPos, ev, out = null) {
    const o = out ?? _acoustics;
    o.heard = 0; o.attenuation = 0; o.distance = 0; o.falloff = 0; o.occlusion = 1;
    o.mask = this.maskLevel; o.lowpassHz = TUNING.lowpassOpenHz; o.energyGain = 0;
    o.gainDb = -120; o.waterFraction = 0; o.effectiveRadius = 0; o.ridge = false; o.blockers = 0;
    if (this._disposed || !listenerPos || !ev) return o;

    const src = ev.position ?? ev;
    if (!src || !isNum(src.x)) return o;
    const def = KINDS[ev.kind] ?? DEFAULT_KIND;
    const radius = isNum(ev.radius) ? ev.radius : def.radius;
    const intensity = clamp01(isNum(ev.intensity) ? ev.intensity : def.intensity);

    _v0.set(src.x, src.y, src.z);
    _v1.set(listenerPos.x, listenerPos.y, listenerPos.z);
    const d = _v0.distanceTo(_v1);
    const occ = this._walk(_v0, _v1);
    const water = _walkResult.waterFraction;
    const rEff = radius * (1 + TUNING.lakeRadiusGain * water);
    const falloff = this.falloffAt(d, radius, water);
    const mask = this._maskFor(ev);

    o.distance = d;
    o.occlusion = occ;
    o.waterFraction = water;
    o.effectiveRadius = rEff;
    o.ridge = _walkResult.ridge;
    o.blockers = _walkResult.blockers;
    o.falloff = falloff;
    o.mask = mask;
    o.heard = clamp01(intensity * falloff * occ * (1 - mask));
    o.attenuation = o.heard;
    o.energyGain = clamp01(intensity * occ * (1 - mask) / Math.max(1, d * d));
    o.gainDb = o.energyGain > 1e-6 ? 20 * Math.log10(o.energyGain) : -120;
    o.lowpassHz = this.lowpassFor(occ, d, water);
    return o;
  }

  /**
   * BiquadFilter cutoff for a path. Occlusion darkens (a 0.45 building wall lands near 1.2 kHz,
   * a 0.88 trunk barely touches it); air absorption darkens with distance, which is what makes
   * thunder at 400 m a rumble and a hammer at 30 m a crack. Water opens it slightly.
   * @returns {number} Hz
   */
  lowpassFor(occlusion, distance, waterFraction = 0) {
    const occ = clamp01(occlusion);
    const occHz = TUNING.lowpassFloorHz +
      (TUNING.lowpassOpenHz - TUNING.lowpassFloorHz) * Math.pow(occ, TUNING.lowpassOccExp);
    const airHz = TUNING.lowpassOpenHz * Math.exp(-Math.max(0, distance) * TUNING.airAbsorptionPerM);
    const hz = Math.min(occHz, airHz) * (1 + (TUNING.lakeLowpassGain - 1) * clamp01(waterFraction));
    return clamp(hz, TUNING.lowpassFloorHz, TUNING.lowpassOpenHz);
  }

  /**
   * The distance at which `ev` still reads at `threshold`. This is the learnable number: it is
   * exact, it is stable, and the debug ring draws it.
   * @param {object} ev
   * @param {number} [threshold=0.11] a counselor
   * @param {number} [dirX] optional direction; supplied, the answer accounts for what is in
   *        the way that way (two solve iterations — occlusion depends on distance).
   * @returns {number} metres
   */
  audibleRadius(ev, threshold = TUNING.defaultThreshold, dirX, dirZ) {
    if (!ev) return 0;
    const def = KINDS[ev.kind] ?? DEFAULT_KIND;
    const radius = isNum(ev.radius) ? ev.radius : def.radius;
    const intensity = clamp01(isNum(ev.intensity) ? ev.intensity : def.intensity);
    const thr = Math.max(1e-4, threshold);
    const mask = 1 - this._maskFor(ev);
    const src = ev.position ?? ev;

    let d = this._solveRadius(radius, intensity, thr, 1, mask, 0);
    if (dirX === undefined || !isNum(src?.x) || d <= 0) return d;
    const len = Math.hypot(dirX, dirZ ?? 0) || 1;
    const ux = dirX / len, uz = (dirZ ?? 0) / len;
    for (let iter = 0; iter < 2; iter++) {
      _v0.set(src.x, src.y, src.z);
      _v1.set(src.x + ux * d, src.y, src.z + uz * d);
      if (this.terrain?.heightAt) _v1.y = this.terrain.heightAt(_v1.x, _v1.z) + 1.6;
      const occ = this._walk(_v0, _v1);
      const nd = this._solveRadius(radius, intensity, thr, occ, mask, _walkResult.waterFraction);
      if (Math.abs(nd - d) < 0.25) { d = nd; break; }
      d = nd;
      if (d <= 0) break;
    }
    return d;
  }

  /** GAME_DESIGN.md §9.8: campers investigate an approximate point, not your exact position. */
  errorRadiusFor(heard) { return 4 + 14 * (1 - clamp01(heard)); }

  /**
   * A point inside the error disc for `ev`. Deterministic per (event, listener) when `rand` is
   * omitted, so two campers guess differently and the same camper guesses consistently.
   * @returns {THREE.Vector3}
   */
  investigationPoint(ev, heard, rand = null, out = null, listenerId = 0) {
    const o = out ?? _v2;
    const src = ev?.position ?? ev;
    if (!src || !isNum(src.x)) return o.set(0, 0, 0);
    const r = this.errorRadiusFor(heard);
    const a = rand?.next ? rand.next() : hash2i(ev.seq ?? 0, listenerId);
    const b = rand?.next ? rand.next() : hash2i((ev.seq ?? 0) + 7919, listenerId * 31 + 5);
    const ang = a * Math.PI * 2;
    const rad = r * Math.sqrt(b);
    o.set(src.x + Math.cos(ang) * rad, src.y, src.z + Math.sin(ang) * rad);
    if (this.terrain?.heightAt) o.y = this.terrain.heightAt(o.x, o.z);
    return o;
  }

  /**
   * The camper-facing scan: the loudest live event this listener can hear above `threshold`.
   * @param {THREE.Vector3} listenerPos
   * @param {number} [threshold=0.11]
   * @param {number} [sinceSeq=-1] ignore events at or below this seq (what this camper has heard)
   * @param {object} [out] filled with { event, heard, seq, errorRadius, distance, point, kind }
   * @param {number} [listenerId=-1]
   * @returns {object|null} `out` (shared if omitted), or null if nothing is audible
   */
  pollNoise(listenerPos, threshold = TUNING.defaultThreshold, sinceSeq = -1, out = null,
    listenerId = -1) {
    const o = out ?? _poll;
    o.event = null; o.heard = 0; o.seq = -1; o.errorRadius = 0; o.distance = 0; o.kind = '';
    if (this._disposed || !listenerPos) return null;
    const arr = this.recentNoises;
    let best = null, bestHeard = threshold;
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i];
      if (!e.aiRelevant || e.seq <= sinceSeq) continue;
      const h = this.audibilityAt(listenerPos, e, listenerId);
      if (h > bestHeard) { bestHeard = h; best = e; }
    }
    if (!best) return null;
    o.event = best;
    o.heard = bestHeard;
    o.seq = best.seq;
    o.kind = best.kind;
    o.errorRadius = this.errorRadiusFor(bestHeard);
    o.distance = listenerPos.distanceTo(best.position);
    this.investigationPoint(best, bestHeard, null, o.point, listenerId < 0 ? 0 : listenerId);
    return o;
  }

  /** The mask that applied when `ev` happened (see the header). Live payloads use the current one. */
  _maskFor(ev) {
    return isNum(ev?.maskAtEmit) && ev.alive !== false ? ev.maskAtEmit : this.maskLevel;
  }

  // ===============================================================================================
  // Occlusion walk
  // ===============================================================================================

  /**
   * Product of the 4 strongest blockers along `from`→`to`, times the dense-undergrowth term,
   * times the ridge factor. Fills `_walkResult`.
   * @returns {number} 0..1
   */
  occlusionBetween(from, to, out = null) {
    const f = this._walk(from, to);
    if (out) {
      out.occlusion = f;
      out.blockers = _walkResult.blockers;
      out.ridge = _walkResult.ridge;
      out.ridgeDepth = _walkResult.ridgeDepth;
      out.thicket = _walkResult.thicket;
      out.waterFraction = _walkResult.waterFraction;
      out.distance = _walkResult.distance;
    }
    return f;
  }

  _walk(from, to) {
    const R = _walkResult;
    R.occlusion = 1; R.blockers = 0; R.ridge = false; R.ridgeDepth = 0;
    R.thicket = 0; R.waterFraction = 0; R.samples = 0; R.distance = 0;
    if (this._disposed || !from || !to) return 1;

    const x0 = from.x, y0 = from.y, z0 = from.z;
    const dx = to.x - x0, dy = to.y - y0, dz = to.z - z0;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    R.distance = len;
    if (len < this.cell) return 1;

    this.stats.walks++;

    const steps = clamp(Math.round(len * this.invCell), 1, TUNING.maxSamples);
    const terrain = this.terrain;
    const forest = this.forest;
    const gS = this._gStatic, gB = this._gBuild, gE = this._gEnv;
    const nx = this.gridNX, nz = this.gridNZ;
    const minX = this.gridMinX, minZ = this.gridMinZ, inv = this.invCell;

    _blockers[0] = 1; _blockers[1] = 1; _blockers[2] = 1; _blockers[3] = 1;
    let prevByte = 255;
    let water = 0, thicket = 0;
    let ridge = false, ridgeDepth = 0;

    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const px = x0 + dx * t, pz = z0 + dz * t;
      const py = y0 + dy * t;

      let ix = ((px - minX) * inv) | 0;
      let iz = ((pz - minZ) * inv) | 0;
      const inGrid = gS && ix >= 0 && iz >= 0 && ix < nx && iz < nz;
      const gi = inGrid ? iz * nx + ix : -1;

      // ---- discrete blockers: static world × the cabin -------------------------------------
      let byte = 255;
      if (gi >= 0) {
        const s = gS[gi], b = gB[gi];
        byte = s < b ? s : b;
      }
      if (byte < 255 && byte !== prevByte) {
        // run-length dedupe: a wall crossed at a grazing angle is one wall, not five cells
        this._insertBlocker(byte / 255);
      }
      prevByte = byte;

      // ---- environment: water + undergrowth ------------------------------------------------
      let env = gi >= 0 ? gE[gi] : 0;
      if (!(env & ENV_BAKED)) {
        // not baked yet — ask Terrain directly. Correct, merely slower.
        if (terrain) {
          if (terrain.isWater?.(px, pz)) water++;
          const dens = forest?.densityAt?.(px, pz) ?? terrain.forestDensityAt?.(px, pz);
          if (isNum(dens) && dens > TUNING.undergrowthThreshold) {
            thicket += (dens - TUNING.undergrowthThreshold) / (1 - TUNING.undergrowthThreshold);
          }
        }
      } else {
        if (env & ENV_WATER) water++;
        const dens = (env & ENV_DENS) / 63;
        if (dens > TUNING.undergrowthThreshold) {
          thicket += (dens - TUNING.undergrowthThreshold) / (1 - TUNING.undergrowthThreshold);
        }
      }

      // ---- terrain ridge --------------------------------------------------------------------
      if (terrain?.heightAt) {
        const h = terrain.heightAt(px, pz);
        const depth = h - py;
        if (depth > TUNING.ridgeBias) {
          ridge = true;
          if (depth > ridgeDepth) ridgeDepth = depth;
        }
      }
    }

    if (ridge) this._insertBlocker(TUNING.ridgeFactor);

    let f = _blockers[0] * _blockers[1] * _blockers[2] * _blockers[3];
    const th = Math.min(thicket, TUNING.undergrowthMaxSegments);
    if (th > 0) f *= Math.pow(TUNING.undergrowthFactor, th);

    R.occlusion = clamp(f, TUNING.occlusionFloor, 1);
    R.ridge = ridge;
    R.ridgeDepth = ridgeDepth;
    R.thicket = th;
    R.waterFraction = water / steps;
    R.samples = steps;
    this.stats.samples += steps;
    return R.occlusion;
  }

  /** Keep the 4 strongest (lowest) blocker factors. No allocation, no sort. */
  _insertBlocker(f) {
    const b = _blockers;
    // find the current weakest slot (largest factor) and replace it if `f` is stronger
    let wi = 0, wv = b[0];
    if (b[1] > wv) { wi = 1; wv = b[1]; }
    if (b[2] > wv) { wi = 2; wv = b[2]; }
    if (b[3] > wv) { wi = 3; wv = b[3]; }
    if (f < wv) { b[wi] = f; _walkResult.blockers++; }
  }

  // ===============================================================================================
  // Occlusion cache (event slot × listener slot, 0.2 s TTL)
  // ===============================================================================================

  _cacheLookup(ev, listenerId) {
    if (listenerId < 0 || listenerId >= this._cacheSlots) return -1;
    const idx = ev.index;
    if (!isNum(idx) || idx < 0 || idx >= TUNING.poolSize) return -1;
    const slot = idx * this._cacheSlots + listenerId;
    if (this._now - this._cacheT[slot] > this._cacheTTL) return -1;
    return slot;
  }

  _cacheStore(ev, listenerId, occ, water) {
    if (listenerId < 0 || listenerId >= this._cacheSlots) return;
    const idx = ev.index;
    if (!isNum(idx) || idx < 0 || idx >= TUNING.poolSize) return;
    const slot = idx * this._cacheSlots + listenerId;
    this._cacheOcc[slot] = occ;
    this._cacheWat[slot] = water;
    this._cacheT[slot] = this._now;
  }

  _invalidateCache(index) {
    if (!isNum(index)) return;
    const base = index * this._cacheSlots;
    for (let i = 0; i < this._cacheSlots; i++) this._cacheT[base + i] = -1;
  }

  // ===============================================================================================
  // The grid — GAME_DESIGN.md §9.6
  // ===============================================================================================

  _allocGrid() {
    const b = this.terrain?.bounds;
    const minX = isNum(b?.minX) ? b.minX : -256;
    const maxX = isNum(b?.maxX) ? b.maxX : 256;
    const minZ = isNum(b?.minZ) ? b.minZ : -256;
    const maxZ = isNum(b?.maxZ) ? b.maxZ : 256;
    this.gridMinX = minX; this.gridMinZ = minZ;
    this.gridNX = clamp(Math.ceil((maxX - minX) * this.invCell), 16, 384) | 0;
    this.gridNZ = clamp(Math.ceil((maxZ - minZ) * this.invCell), 16, 384) | 0;
    const n = this.gridNX * this.gridNZ;
    this._gStatic = new Uint8Array(n).fill(255);
    this._gBuild = new Uint8Array(n).fill(255);
    this._gEnv = new Uint8Array(n);
    this._bakePhase = 0;
    this._bakeCursor = 0;
  }

  _resolvePlot() {
    const site = this.cabinSite;
    const c = site?.center ?? site?.origin ?? site?.plotCenter ?? this.terrain?.buildSiteCenter;
    this._plotX = isNum(c?.x) ? c.x : 0;
    this._plotZ = isNum(c?.z) ? c.z : 0;
    // Phase 0 bakes a 128 m box around the plot first — the cells gameplay asks about soonest.
    const half = 64;
    const B = this._bakeInner;
    B.x0 = Math.max(0, ((this._plotX - half - this.gridMinX) * this.invCell) | 0);
    B.x1 = Math.min(this.gridNX - 1, ((this._plotX + half - this.gridMinX) * this.invCell) | 0);
    B.z0 = Math.max(0, ((this._plotZ - half - this.gridMinZ) * this.invCell) | 0);
    B.z1 = Math.min(this.gridNZ - 1, ((this._plotZ + half - this.gridMinZ) * this.invCell) | 0);
  }

  _rebakeAll() {
    if (!this._gEnv) return;
    this._gEnv.fill(0);
    this._gStatic.fill(255);
    this._gBuild.fill(255);
    this._bakePhase = 0;
    this._bakeCursor = 0;
    this._resolvePlot();
  }

  /** Incremental static+environment bake. Plot box first, then the world, row-major. */
  _bakeStep() {
    if (this._bakePhase >= 2 || !this._gEnv) return;
    const budget = this._bakeBudget;
    const nx = this.gridNX, nz = this.gridNZ;
    let done = 0;

    if (this._bakePhase === 0) {
      const B = this._bakeInner;
      const w = Math.max(1, B.x1 - B.x0 + 1);
      const total = w * Math.max(1, B.z1 - B.z0 + 1);
      while (done < budget && this._bakeCursor < total) {
        const k = this._bakeCursor++;
        this._bakeCell(B.x0 + (k % w), B.z0 + ((k / w) | 0));
        done++;
      }
      if (this._bakeCursor >= total) { this._bakePhase = 1; this._bakeCursor = 0; }
    }
    if (this._bakePhase === 1) {
      const total = nx * nz;
      while (done < budget && this._bakeCursor < total) {
        const k = this._bakeCursor++;
        const ix = k % nx, iz = (k / nx) | 0;
        if (!(this._gEnv[k] & ENV_BAKED)) this._bakeCell(ix, iz);
        done++;
      }
      if (this._bakeCursor >= total) { this._bakePhase = 2; this._bakeCursor = 0; }
      this.stats.bakeProgress = this._bakeCursor / Math.max(1, total);
    }
    if (this._bakePhase >= 2) this.stats.bakeProgress = 1;
  }

  _bakeCell(ix, iz) {
    const nx = this.gridNX;
    if (ix < 0 || iz < 0 || ix >= nx || iz >= this.gridNZ) return;
    const gi = iz * nx + ix;
    const x = this.gridMinX + (ix + 0.5) * this.cell;
    const z = this.gridMinZ + (iz + 0.5) * this.cell;
    const terrain = this.terrain;

    // ---- environment ---------------------------------------------------------------------
    let env = ENV_BAKED;
    let dens = 0.35;
    if (terrain) {
      if (terrain.isWater?.(x, z)) env |= ENV_WATER;
      const d = this.forest?.densityAt?.(x, z) ?? terrain.forestDensityAt?.(x, z);
      if (isNum(d)) dens = clamp01(d);
    }
    env |= (Math.round(dens * 63) & ENV_DENS);
    this._gEnv[gi] = env;

    // ---- static occluders ------------------------------------------------------------------
    this._gStatic[gi] = this._sampleColliders(x, z, this._maskSound);
  }

  /** @returns {number} 0..255 byte: the strongest acoustic blocker whose AABB covers this cell. */
  _sampleColliders(x, z, mask) {
    const phys = this.physics;
    if (!phys?.overlapSphere) return 255;
    const y = (this.terrain?.heightAt?.(x, z) ?? 0) + TUNING.sampleHeight;
    _v0.set(x, y, z);
    let n = 0;
    try {
      n = phys.overlapSphere(_v0, this.cell * TUNING.bakeRadiusScale, _hits, mask) | 0;
    } catch (e) {
      Log.once('noise:overlap', 'NoiseSystem: Physics.overlapSphere threw during bake', e);
      return 255;
    }
    let f = 1;
    for (let i = 0; i < n; i++) {
      const c = _hits[i];
      if (!c) continue;
      let o = c.occlusion;
      if (!isNum(o)) o = KIND_OCCLUSION[c.kind] ?? 0.75;
      if (o < f) f = o;
    }
    return Math.round(clamp01(f) * 255);
  }

  _markBuildDirty() {
    // The cabin footprint plus generous margin; re-baked incrementally over the next few frames.
    const half = 26;
    const R = this._buildRect;
    R.x0 = Math.max(0, ((this._plotX - half - this.gridMinX) * this.invCell) | 0);
    R.x1 = Math.min(this.gridNX - 1, ((this._plotX + half - this.gridMinX) * this.invCell) | 0);
    R.z0 = Math.max(0, ((this._plotZ - half - this.gridMinZ) * this.invCell) | 0);
    R.z1 = Math.min(this.gridNZ - 1, ((this._plotZ + half - this.gridMinZ) * this.invCell) | 0);
    this._buildDirty = true;
    this._buildCursor = 0;
  }

  _buildBakeStep() {
    if (!this._buildDirty || !this._gBuild) return;
    const R = this._buildRect;
    const w = Math.max(1, R.x1 - R.x0 + 1);
    const total = w * Math.max(1, R.z1 - R.z0 + 1);
    const budget = 160;
    let done = 0;
    while (done < budget && this._buildCursor < total) {
      const k = this._buildCursor++;
      const ix = R.x0 + (k % w), iz = R.z0 + ((k / w) | 0);
      const gi = iz * this.gridNX + ix;
      const x = this.gridMinX + (ix + 0.5) * this.cell;
      const z = this.gridMinZ + (iz + 0.5) * this.cell;
      this._gBuild[gi] = this._sampleColliders(x, z, this._maskBuild);
      done++;
    }
    if (this._buildCursor >= total) {
      this._buildDirty = false;
      this._cacheT.fill(-1);
    }
  }

  /**
   * Force an immediate rebake of the cabin's acoustic footprint. `BuildSystem`/`CabinSite` may
   * call this after a bulk change; the event handlers already cover the normal path.
   */
  invalidateBuild() { this._markBuildDirty(); }

  /** The combined occlusion factor of one 2 m cell. Debug/inspection. */
  cellFactorAt(x, z) {
    if (!this._gStatic) return 1;
    const ix = ((x - this.gridMinX) * this.invCell) | 0;
    const iz = ((z - this.gridMinZ) * this.invCell) | 0;
    if (ix < 0 || iz < 0 || ix >= this.gridNX || iz >= this.gridNZ) return 1;
    const gi = iz * this.gridNX + ix;
    return (this._gStatic[gi] / 255) * (this._gBuild[gi] / 255);
  }

  // ===============================================================================================
  // Self-test — verifies the model against GAME_DESIGN.md's own worked numbers.
  // ===============================================================================================

  /**
   * Runs the model against the worked examples GAME_DESIGN.md derives its budgets from, using
   * the same methods gameplay calls. If these drift, a design guarantee has silently broken:
   * §7.6's "you may saw when no counselor is within ~57 m" is the Night 3 mechanic.
   */
  _selfTest() {
    // §7.6: saw, radius 90, intensity 0.62, one trunk (0.88), Night 3 mask floor (0.151).
    const maskN3 = 1 - (TUNING.maskRainCoef * 0.10 + TUNING.maskWindCoef * 0.55);
    const rows = [[40, 0.186], [50, 0.137], [55, 0.112], [60, 0.089]];
    let worst = 0;
    for (let i = 0; i < rows.length; i++) {
      const got = 0.62 * this.falloffAt(rows[i][0], 90) * 0.88 * maskN3;
      worst = Math.max(worst, Math.abs(got - rows[i][1]) / rows[i][1]);
    }
    const sawReach = this._solveRadius(90, 0.62, 0.11, 0.88, maskN3, 0);

    // §7.1: a severity-0.7 creak is radius 14 + 46·sev, intensity = severity. Night 1 floor.
    const maskN1 = 1 - (TUNING.maskRainCoef * 0.15 + TUNING.maskWindCoef * 0.20);
    const creakReach = this._solveRadius(14 + 46 * 0.7, 0.7, 0.11, 1, maskN1, 0);
    // The same creak with Robin (0.08) listening, and again from the shoreline.
    const creakRobin = this._solveRadius(14 + 46 * 0.7, 0.7, 0.08, 1, maskN1, 0);
    const creakWater = this._solveRadius(14 + 46 * 0.7, 0.7, 0.11, 1, maskN1, 1);

    Log.info(
      `NoiseSystem self-test — falloff error vs GAME_DESIGN §7.6 worked rows: ` +
      `${(worst * 100).toFixed(2)}%.\n` +
      `  saw   r=90 i=0.62 occ=0.88 N3: audible to a counselor out to ${sawReach.toFixed(1)} m ` +
      `(§7.6 expects ~57)\n` +
      `  creak sev=0.70 N1 open ground: counselor ${creakReach.toFixed(1)} m, ` +
      `Robin ${creakRobin.toFixed(1)} m, across water ${creakWater.toFixed(1)} m`);
  }

  // ===============================================================================================
  // Debug — ?noisedebug
  // ===============================================================================================

  _buildDebug() {
    const scene = this.ctx?.scene;
    if (!scene || this._dbg) return;
    const MAX_EVENTS = 8, SEG = 32;
    const rings = MAX_EVENTS * 2;
    const verts = rings * SEG * 2;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(verts * 3);
    const col = new Float32Array(verts * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false,
      toneMapped: false,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.name = 'noise.debug';
    lines.frustumCulled = false;
    lines.renderOrder = 999;
    scene.add(lines);

    this._dbg = {
      lines, geo, mat, pos, col, SEG, MAX_EVENTS,
      radii: new Float32Array(MAX_EVENTS * SEG),
      seqs: new Int32Array(MAX_EVENTS).fill(-1),
      slotOf: new Int32Array(TUNING.poolSize).fill(-1),
      next: 0,
    };

    // Flat, clinical, one red accent — the manual's typography, applied to instrumentation.
    try {
      const el = document.createElement('div');
      el.id = 'sc-noise-debug';
      el.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:40;padding:8px 10px;' +
        'background:#f4f2ec;color:#111;border:1px solid #111;border-left:4px solid #d92b2b;' +
        'font:11px/1.5 ui-monospace,Menlo,monospace;white-space:pre;pointer-events:none;' +
        'letter-spacing:0.02em';
      document.body.appendChild(el);
      this._dbgEl = el;
    } catch { this._dbgEl = null; }
  }

  _assignDebugRing(ev) {
    const D = this._dbg;
    if (!D) return;
    const slot = D.next;
    D.next = (D.next + 1) % D.MAX_EVENTS;
    // Release whatever held this slot.
    for (let i = 0; i < D.slotOf.length; i++) if (D.slotOf[i] === slot) D.slotOf[i] = -1;
    D.slotOf[ev.index] = slot;
    D.seqs[slot] = ev.seq;

    // Anisotropic audible boundary, sampled once per event — the shape IS the occlusion.
    const SEG = D.SEG;
    for (let s = 0; s < SEG; s++) {
      const a = (s / SEG) * Math.PI * 2;
      D.radii[slot * SEG + s] = this.audibleRadius(
        ev, TUNING.defaultThreshold, Math.cos(a), Math.sin(a));
    }
  }

  /**
   * Expanding rings for live events at their occlusion-attenuated audible radius.
   * Outer dim ring = where a counselor stops hearing it. Bright ring = the wavefront.
   */
  debugDraw(force = false) {
    if (!this.debugEnabled && !force) return;
    if (!this._dbg) this._buildDebug();
    const D = this._dbg;
    if (!D) return;
    const { SEG, pos, col, radii } = D;
    const terrain = this.terrain;
    let v = 0;

    for (let n = 0; n < this.recentNoises.length; n++) {
      const e = this.recentNoises[n];
      const slot = D.slotOf[e.index];
      if (slot < 0 || D.seqs[slot] !== e.seq) continue;

      const wave = clamp01(e.age / 0.75);
      const fade = clamp01(e.strength);
      const hot = e.byPlayer ? 1 : 0;
      // boundary ring, then wavefront ring
      for (let ring = 0; ring < 2; ring++) {
        const scale = ring === 0 ? 1 : wave;
        if (scale <= 0.001) continue;
        const cr = ring === 0 ? 0.55 * fade : 0.95 * fade;
        const r = hot ? 0.85 * cr : 0.35 * cr;
        const g = hot ? 0.17 * cr : 0.58 * cr;
        const b = hot ? 0.17 * cr : 0.77 * cr;
        for (let s = 0; s < SEG; s++) {
          const s2 = (s + 1) % SEG;
          const a0 = (s / SEG) * Math.PI * 2, a1 = (s2 / SEG) * Math.PI * 2;
          const r0 = radii[slot * SEG + s] * scale, r1 = radii[slot * SEG + s2] * scale;
          const x0 = e.position.x + Math.cos(a0) * r0, z0 = e.position.z + Math.sin(a0) * r0;
          const x1 = e.position.x + Math.cos(a1) * r1, z1 = e.position.z + Math.sin(a1) * r1;
          const y0 = (terrain?.heightAt?.(x0, z0) ?? 0) + 0.15;
          const y1 = (terrain?.heightAt?.(x1, z1) ?? 0) + 0.15;
          if (v + 2 > pos.length / 3) break;
          pos[v * 3] = x0; pos[v * 3 + 1] = y0; pos[v * 3 + 2] = z0;
          col[v * 3] = r; col[v * 3 + 1] = g; col[v * 3 + 2] = b; v++;
          pos[v * 3] = x1; pos[v * 3 + 1] = y1; pos[v * 3 + 2] = z1;
          col[v * 3] = r; col[v * 3 + 1] = g; col[v * 3 + 2] = b; v++;
        }
      }
    }

    D.geo.setDrawRange(0, v);
    D.geo.attributes.position.needsUpdate = true;
    D.geo.attributes.color.needsUpdate = true;

    this._dbgT -= this._lastDt;
    if (this._dbgEl && this._dbgT <= 0) {
      this._dbgT = 0.2;
      const inc = this.maskWindowIncoming;
      this._dbgEl.textContent =
        `NOISE  live ${String(this.stats.live).padStart(2)}   walks ${String(this.stats.walks).padStart(3)}` +
        `   cache ${this.stats.cacheHits}\n` +
        `MASK   ${this.maskLevel.toFixed(3)}  floor ${this.maskFloor.toFixed(3)}` +
        `  rain ${this.rain.toFixed(2)} wind ${this.wind.toFixed(2)}\n` +
        `COVER  ${this.maskWindowOpen ? `OPEN ${this.maskWindowRemaining.toFixed(1)} s`
          : (Number.isFinite(inc) ? `in ${inc.toFixed(1)} s` : 'none')}\n` +
        `YOU    ${this.playerNoise.active
          ? `${this.playerNoise.kind} reach ${this.playerNoise.reach.toFixed(1)} m`
          : '—'}\n` +
        `GRID   ${(this.stats.bakeProgress * 100).toFixed(0)}% baked` +
        `${this._buildDirty ? '  (cabin rebaking)' : ''}`;
    }
  }

  // ===============================================================================================

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const u of this._unsubs) { try { u?.(); } catch { /* already gone */ } }
    this._unsubs.length = 0;

    if (this._dbg) {
      this._dbg.lines.parent?.remove(this._dbg.lines);
      this._dbg.geo.dispose();
      this._dbg.mat.dispose();
      this._dbg = null;
    }
    if (this._dbgEl) { this._dbgEl.remove(); this._dbgEl = null; }

    this._gStatic = null; this._gBuild = null; this._gEnv = null;
    this._cacheOcc = null; this._cacheWat = null; this._cacheT = null;
    for (let i = 0; i < this._pool.length; i++) this._pool[i].reset();
    this.recentNoises.length = 0;
    this._pool.length = 0;
    this.terrain = this.physics = this.weather = this.forest = this.cabinSite = null;
    this._uniforms = null;
  }
}

NoiseSystem.TUNING = TUNING;
NoiseSystem.KINDS = KINDS;
NoiseSystem.NIGHT_WEATHER = NIGHT_WEATHER;

export { KINDS as NOISE_KINDS, NIGHT_WEATHER };
export default NoiseSystem;
