/**
 * Navmesh — the navigation graph the campers think in.
 *
 * OWNER: AI agent. Registered between CabinSite and Campers (see src/main.js), so by the time
 * init() runs, Terrain, Physics, Forest, Props and CabinSite have all had their init().
 *
 * This is deliberately NOT a polygon navmesh. At this scale (a 512 m square of forest with a
 * clearing in it, seven agents, walk speeds of 1.2–3.4 m/s) a sampled walkable grid plus a
 * hand-designed patrol graph is both cheaper and more controllable — and controllability is the
 * point, because GAME_DESIGN §9 asks the patrols to *mean* something.
 *
 * THREE LAYERS
 *
 *   1. THE GRID (built once in init)
 *      1.5 m cells over Terrain's bounds. A cell is walkable if the slope is under 38°, it is not
 *      water, and no move-blocking collider registered with Physics covers it. Stored as flat
 *      typed arrays: flags (Uint8), traversal cost (Uint16, 1/256 fixed point), connected-region
 *      id (Uint16), ground height (Float32). ~1.0 MB for the world, plus 3 MB of A* workspace.
 *
 *   2. THE COST FIELD — what makes the AI look designed instead of generic.
 *      People walk on the paths Terrain carved. People stay near the lamps and the fire. People
 *      avoid steep ground, wet ground, and dense brush. All four are multipliers baked per cell,
 *      except light (kept separate so `night:begin` can re-bake it for free) and the runtime
 *      modifiers Campers pushes in — "avoid where I just got frightened", "converge on the noise".
 *
 *   3. THE PATROL GRAPH — eight named, hand-authored loops with dwell times and schedule
 *      windows. They are the reason the camp reads as people setting up for a season rather
 *      than guards on rails. Some of them come near the build plot. None of them stop on it.
 *
 * COORDINATE FRAME — read this before you place anything.
 *   STORY §4.2 is doc-canon for landmark positions and puts the build plot at the origin.
 *   `Terrain.js` as shipped generates a different, larger site: build pad at (-140, 128), camp at
 *   (124, -18), dock at (106, -72). The two cannot be reconciled by any similarity transform —
 *   they are different maps. The ground under the campers' feet is the one Terrain actually
 *   generated, so **Terrain is the authority at runtime** and every anchor below is resolved from
 *   `Terrain`'s published landmarks, snapped to a walkable cell, and only then used. STORY §4.2's
 *   numbers are the fallback used when Terrain is missing entirely. If `Props.js` publishes real
 *   camp positions, call `setAnchor()` and the routes re-resolve — no edit to this file needed.
 *
 * PERFORMANCE
 *   Zero allocation in update(). One A* search runs at a time, stepped across frames against a
 *   node-expansion budget, so a camper asking for a 300 m path never causes a hitch. Synchronous
 *   findPath() uses a second workspace so it can never disturb an in-flight async search.
 */
import * as THREE from 'three';
import { Log } from '../core/Log.js';
import { Rand } from '../core/Rand.js';

// =================================================================================================
// Tuning
// =================================================================================================

export const NAV_TUNING = {
  cellSize: 1.5,               // m — grid spacing
  agentRadius: 0.45,           // m — collider dilation when stamping blockers (Physics capsule 0.42)
  maxSlopeDeg: 38,             // above this a camper will not walk it (Physics gives up at 50)
  stepBlockHeight: 1.2,        // GAME_DESIGN §9.6: placed parts >= 1.2 m cut patrol edges
  staticBlockHeight: 0.5,      // a rock lower than the 0.45 m step height is not an obstacle
  headroom: 2.2,               // vertical slab above the ground a collider must intrude on

  // cost field weights
  pathDiscount: 0.48,          // pathInfluence 1.0 -> cost x0.52. People walk on the path.
  litDiscount: 0.30,           // full lamplight -> cost x0.70. People stay near the light.
  slopePenalty: 2.40,          // at the walkable slope limit
  brushPenalty: 1.10,          // dense undergrowth
  wetPenalty: 0.30,            // mud, drainage, puddle haloes
  costMin: 0.35,
  costMax: 24.0,

  // crossings — see addBridge()
  bridgeWidth: 1.7,            // m, walkable corridor stamped over water
  bridgeCost: 0.75,            // cheap: it is the only way across, and everyone knows it

  // the plot repulsion. Routes may pass; nothing parks.
  plotKeepOut: 16.0,           // m — soft repulsion radius around the build site
  plotRepulse: 14.0,           // multiplier at the centre of the keep-out
  plotRepulseStructure: 3.0,   // reduced once a structure report exists (GAME_DESIGN §9.5)
  structurePatrolPeriod: 110,  // s — "routes past the plot every ~110 s"

  // A*
  heuristicWeight: 1.05,       // > 1: paths are near-optimal, not optimal. Deliberate — see _step.
  heuristicUnitCost: 0,        // 0 = derive from the baked cost field; set a number to override
  heuristicPercentile: 0.25,   // which quantile of the cost field the heuristic assumes
  syncExpandCap: 40000,        // hard ceiling for a blocking findPath()
  asyncExpandPerFrame: 1400,   // amortised budget for queued requests
  routeExpandPerFrame: 600,    // idle budget for pre-computing route legs
  heapCapacity: 1 << 15,
  maxPathNodes: 4096,
  smoothLookahead: 28,         // string-pull window, in nodes
  cacheSize: 64,

  // queries
  coverMinSeparation: 4.0,
  patrolSampleTries: 64,
};

/** Cell flag bits. `flags` is a Uint8Array. */
export const NAV_FLAG = {
  OPEN: 1,        // terrain + static colliders permit standing here
  WATER: 2,
  PATH: 4,        // Terrain.pathInfluenceAt > 0.4 — a worn trail
  STEEP: 8,
  BLOCKED: 16,    // a static collider covers it
  BRUSH: 32,      // dense undergrowth (soft — costs, does not block)
  EDGE: 64,       // walkable and adjacent to something that is not — a cover candidate
  CAMP: 128,      // inside the lit camp envelope
};

const F_OPEN = NAV_FLAG.OPEN;
const F_WATER = NAV_FLAG.WATER;
const F_PATH = NAV_FLAG.PATH;
const F_STEEP = NAV_FLAG.STEEP;
const F_BLOCKED = NAV_FLAG.BLOCKED;
const F_BRUSH = NAV_FLAG.BRUSH;
const F_EDGE = NAV_FLAG.EDGE;
const F_CAMP = NAV_FLAG.CAMP;

const INV255 = 1 / 255;
const INV256 = 1 / 256;
const SQRT2 = Math.SQRT2;
const OCTILE_D = SQRT2 - 2;

/** Physics layer bits, mirrored so this file works if Physics never loaded. */
const FALLBACK_LAYER = {
  TERRAIN: 1 << 0, STATIC: 1 << 1, BUILD: 1 << 2,
  PROP: 1 << 3, FOLIAGE: 1 << 4, ACTOR: 1 << 5, WATER: 1 << 6,
};
const FALLBACK_MASK = {
  ALL: 0xffffffff,
  SOLID: FALLBACK_LAYER.TERRAIN | FALLBACK_LAYER.STATIC | FALLBACK_LAYER.BUILD | FALLBACK_LAYER.PROP,
  WORLD: FALLBACK_LAYER.STATIC | FALLBACK_LAYER.BUILD | FALLBACK_LAYER.PROP,
};

/** 8-way neighbourhood. 0–3 orthogonal, 4–7 diagonal (each guarded against corner cutting). */
const NB_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const NB_DZ = [0, 0, 1, -1, 1, -1, 1, -1];
/** For diagonal k, the two orthogonal neighbours that must both be open. */
const NB_GUARD_A = [0, 0, 0, 0, 0, 0, 1, 1];
const NB_GUARD_B = [0, 0, 0, 0, 2, 3, 2, 3];

// =================================================================================================
// Module-scope scratch — ARCHITECTURE.md §12. Nothing below allocates during a frame.
// =================================================================================================

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _colOut = new Array(64);
const _seenCols = new Set();
const _tmpIds = [];

/** Pooled node records. Copy what you need immediately — the eighth call overwrites the first. */
const _nodePool = [];
let _nodePoolAt = 0;
for (let i = 0; i < 8; i++) {
  _nodePool.push({
    index: -1, ix: 0, iz: 0, x: 0, y: 0, z: 0,
    walkable: false, cost: 1, region: 0, flags: 0, lit: 0,
    onPath: false, water: false, edge: false,
  });
}
function nextNode() {
  const n = _nodePool[_nodePoolAt];
  _nodePoolAt = (_nodePoolAt + 1) & 7;
  return n;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

// =================================================================================================
// Binary heap over parallel typed arrays. No objects, no comparator closure.
// =================================================================================================

class NavHeap {
  constructor(capacity) {
    this.idx = new Int32Array(capacity);
    this.key = new Float32Array(capacity);
    this.size = 0;
    this.capacity = capacity;
    this.overflowed = false;
  }

  clear() { this.size = 0; this.overflowed = false; }

  push(index, key) {
    if (this.size >= this.capacity) { this.overflowed = true; return false; }
    let i = this.size++;
    const I = this.idx, K = this.key;
    I[i] = index; K[i] = key;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= K[i]) break;
      const ti = I[p]; I[p] = I[i]; I[i] = ti;
      const tk = K[p]; K[p] = K[i]; K[i] = tk;
      i = p;
    }
    return true;
  }

  /** @returns {number} node index, or -1 when empty. */
  pop() {
    if (this.size === 0) return -1;
    const I = this.idx, K = this.key;
    const top = I[0];
    this.size--;
    if (this.size > 0) {
      I[0] = I[this.size]; K[0] = K[this.size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.size && K[l] < K[m]) m = l;
        if (r < this.size && K[r] < K[m]) m = r;
        if (m === i) break;
        const ti = I[m]; I[m] = I[i]; I[i] = ti;
        const tk = K[m]; K[m] = K[i]; K[i] = tk;
        i = m;
      }
    }
    return top;
  }
}

// =================================================================================================
// A* workspace. One per concurrent search; this file keeps exactly two (sync + async).
// =================================================================================================

class NavSearch {
  constructor(cells, heapCapacity) {
    this.g = new Float32Array(cells);
    this.parent = new Int32Array(cells);
    this.stamp = new Int32Array(cells);
    this.state = new Uint8Array(cells);      // 1 = open, 2 = closed (valid only when stamp matches)
    this.heap = new NavHeap(heapCapacity);
    this.gen = 0;
    this.active = false;
    this.start = -1;
    this.goal = -1;
    this.goalX = 0; this.goalZ = 0;
    this.best = -1;
    this.bestH = Infinity;
    this.expanded = 0;
    this.result = 0;                          // 0 running, 1 found, 2 partial/failed
  }

  begin(start, goal, goalX, goalZ) {
    this.gen++;
    this.heap.clear();
    this.start = start;
    this.goal = goal;
    this.goalX = goalX;
    this.goalZ = goalZ;
    this.best = start;
    this.bestH = Infinity;
    this.expanded = 0;
    this.result = 0;
    this.active = true;
    this.g[start] = 0;
    this.parent[start] = -1;
    this.stamp[start] = this.gen;
    this.state[start] = 1;
  }
}

// =================================================================================================
// Route authoring. Waypoints are (anchor, offset) pairs so the loops survive any site layout.
// `window` is [t0, t1] in GameState.timeOfNight (0 = dusk, 1 = dawn).
// =================================================================================================

/**
 * @typedef {object} RouteWaypoint
 * @property {string} anchor   anchor name to resolve against
 * @property {number} ox       offset east, metres, in the camp's local frame
 * @property {number} oz       offset "toward the water", metres, in the camp's local frame
 * @property {number} dwell    seconds the camper stands here
 * @property {string} note     what they are doing. Never shown. Keeps the loop honest.
 */

const ROUTE_DEFS = [
  {
    id: 'dock-and-back',
    label: 'Dock and back',
    intent: 'The canoes are counted at dusk and counted again later. Marg counts them because '
      + 'the canoes are hers to count.',
    window: [0.00, 0.48], minNight: 1, maxNight: 7,
    preferred: ['marg'], speed: 1.20, loop: true,
    waypoints: [
      { anchor: 'firepit', ox: 0, oz: 0, dwell: 6, note: 'sets down a mug' },
      { anchor: 'shore', ox: 0, oz: 0, dwell: 4, note: 'checks the waterline' },
      { anchor: 'dock', ox: 0, oz: 0, dwell: 14, note: 'walks the boards, torch on the cleats' },
      { anchor: 'canoe-rack', ox: 0, oz: 0, dwell: 9, note: 'counts hulls' },
      { anchor: 'shore', ox: 6, oz: 4, dwell: 0, note: '' },
    ],
  },
  {
    id: 'latrine-run',
    label: 'Latrine run',
    intent: 'Short, frequent, unglamorous, and it takes someone out past the lamp line in the '
      + 'dark for ninety seconds at a time.',
    window: [0.08, 0.96], minNight: 1, maxNight: 7,
    preferred: ['teddy', 'coop'], speed: 1.25, loop: true,
    waypoints: [
      { anchor: 'cabins', ox: 0, oz: 0, dwell: 5, note: '' },
      { anchor: 'latrine', ox: 0, oz: 0, dwell: 16, note: 'torch propped on the door frame' },
      { anchor: 'cabins', ox: -4, oz: 3, dwell: 4, note: '' },
    ],
  },
  {
    id: 'perimeter-check',
    label: 'Perimeter check',
    intent: 'The camp director walks the edge of her own light and looks outward from it. This is '
      + 'the loop that is genuinely trying to catch something.',
    window: [0.28, 0.86], minNight: 2, maxNight: 7,
    preferred: ['bev', 'coop'], speed: 1.15, loop: true,
    waypoints: [
      { anchor: 'firepit', ox: 0, oz: 0, dwell: 4, note: 'checks the fire is banked' },
      { anchor: 'woodpile', ox: 0, oz: 0, dwell: 5, note: 'torch across the stacked rounds' },
      { anchor: 'toolshed', ox: 0, oz: 0, dwell: 7, note: 'tries the padlock' },
      { anchor: 'cabins', ox: 0, oz: 0, dwell: 5, note: 'counts bunks lit' },
      { anchor: 'office', ox: 0, oz: 0, dwell: 6, note: 'looks west, at nothing' },
      { anchor: 'mess', ox: 0, oz: 0, dwell: 5, note: '' },
    ],
  },
  {
    id: 'firewood-fetch',
    label: 'Firewood fetch',
    intent: 'Two armloads before it gets properly cold. Long dwell at the woodpile: the CIT is '
      + 'stationary, facing away, for twenty-two seconds.',
    window: [0.00, 0.38], minNight: 2, maxNight: 7,
    preferred: ['teddy'], speed: 1.10, loop: true,
    waypoints: [
      { anchor: 'cabins', ox: 3, oz: 2, dwell: 4, note: '' },
      { anchor: 'woodpile', ox: 0, oz: 0, dwell: 22, note: 'loading — back turned the whole time' },
      { anchor: 'firepit', ox: 2, oz: -2, dwell: 8, note: 'unloading' },
      { anchor: 'mess', ox: -3, oz: 0, dwell: 6, note: '' },
    ],
  },
  {
    id: 'cabin-to-mess',
    label: 'Cabin to mess',
    intent: 'The late loop. Short, well lit, entirely inside the camp — which is why a camper on '
      + 'it is the safest camper on the map and the worst one to be seen by.',
    window: [0.52, 1.00], minNight: 1, maxNight: 7,
    preferred: ['robin'], speed: 1.20, loop: true,
    waypoints: [
      { anchor: 'cabins', ox: 0, oz: 0, dwell: 5, note: '' },
      { anchor: 'mess', ox: 0, oz: 0, dwell: 18, note: 'dishes, and the radio on low' },
      { anchor: 'office', ox: 0, oz: 0, dwell: 9, note: '' },
      { anchor: 'cabins', ox: 4, oz: -3, dwell: 6, note: '' },
    ],
  },
  {
    id: 'the-long-way-round',
    label: 'The long way round',
    intent: 'The route that costs the player something. It runs the far end of the carved trail '
      + 'network — no lamps, no company — turns at the log crossing, and comes back. Its closest '
      + 'approach to the plot is the tension in the whole night. It is deliberately anchored on '
      + 'the trail rather than at the camp gate, so it can be met twice in one night.',
    window: [0.18, 0.72], minNight: 1, maxNight: 7,
    preferred: ['dale', 'coop'], speed: 1.20, loop: true,
    waypoints: [
      { anchor: 'trail-mid', ox: 0, oz: 0, dwell: 6, note: 'stops where the trail bends' },
      { anchor: 'draw', ox: 0, oz: 0, dwell: 10, note: 'stands on the log crossing, listening' },
      { anchor: 'plot-approach', ox: 0, oz: 0, dwell: 6, note: 'turns here. Does not go further.' },
      { anchor: 'draw', ox: 4, oz: 3, dwell: 4, note: '' },
    ],
  },
  {
    id: 'shoreline-sweep',
    label: 'Shoreline sweep',
    intent: 'Along the water, west, torch out over the lake rather than into the trees. Passes '
      + 'north of the plot at a distance that is safe unless you are carrying something pale.',
    window: [0.44, 0.88], minNight: 2, maxNight: 7,
    preferred: ['marg', 'coop'], speed: 1.25, loop: true,
    waypoints: [
      { anchor: 'dock', ox: 0, oz: 0, dwell: 6, note: '' },
      { anchor: 'shore', ox: 0, oz: 0, dwell: 3, note: '' },
      { anchor: 'shore-west', ox: 0, oz: 0, dwell: 8, note: 'torch out over the water' },
      { anchor: 'shore', ox: 4, oz: -3, dwell: 0, note: '' },
      { anchor: 'boathouse', ox: 0, oz: 0, dwell: 9, note: 'checks the eave' },
    ],
  },
  {
    id: 'plot-detour',
    label: 'Plot detour',
    intent: 'Does not exist until somebody files a structure report. GAME_DESIGN §9.5: a '
      + 'structure report adds a patrol edge that routes past the plot every ~110 s. This is that '
      + 'edge. It is worse than the suspicion it comes with.',
    window: [0.00, 1.00], minNight: 1, maxNight: 7,
    preferred: [], speed: 1.20, loop: true,
    structure: true, enabled: false,
    waypoints: [
      { anchor: 'draw', ox: 0, oz: 0, dwell: 4, note: '' },
      { anchor: 'plot-watch', ox: 0, oz: 0, dwell: 6, note: 'stops. Looks at it. Writes nothing down.' },
      { anchor: 'draw', ox: -5, oz: 4, dwell: 0, note: '' },
    ],
  },
];

/**
 * STORY §4.2 landmark table, in doc-canon coordinates (datum = the ruin footprint). Used ONLY as
 * a fallback layout when Terrain is absent — see the file header on the frame conflict.
 */
const DOC_ANCHORS = {
  plot: [0, 0],
  dock: [-28, -41],
  shore: [-28, -44],
  'shore-west': [-96, -46],
  'canoe-rack': [68, 22],
  boathouse: [86, -52],
  woodpile: [-36, 46],
  toolshed: [118, 40],
  cabins: [104, 96],
  mess: [132, 74],
  office: [146, 60],
  firepit: [110, 84],
  latrine: [92, 52],
  draw: [45, 0],
  ridge: [-130, 0],
};

// =================================================================================================

export class Navmesh {
  constructor(ctx) {
    this.ctx = ctx ?? null;
    this.bus = ctx?.bus ?? null;

    // ---- grid geometry (finalised in init) ----
    this.cell = NAV_TUNING.cellSize;
    this.invCell = 1 / this.cell;
    this.cellDiag = this.cell * SQRT2;
    this.originX = -256;
    this.originZ = -256;
    this.width = 1;
    this.depth = 1;
    this.cells = 1;
    this.bounds = { minX: -256, maxX: 256, minZ: -256, maxZ: 256 };

    // ---- fields ----
    this._flags = null;      // Uint8Array  NAV_FLAG bits
    this._cost = null;       // Uint16Array traversal cost, 1/256 fixed point (light NOT included)
    this._lit = null;        // Uint8Array  0..255 lamp/fire illumination
    this._region = null;     // Uint16Array connected component id, 0 = unwalkable
    this._height = null;     // Float32Array ground height
    this._build = null;      // Uint8Array  1 = blocked by a placed cabin part (cleared separately)

    this._regionSizes = null;
    this._mainRegion = 0;
    this._hUnit = 1;             // per-metre cost the A* heuristic assumes; derived in _bakeCost

    // ---- A* ----
    this._sync = null;
    this._async = null;
    this._pathIdx = new Int32Array(NAV_TUNING.maxPathNodes);
    this._smoothIdx = new Int32Array(NAV_TUNING.maxPathNodes);
    this._pathLen = 0;
    this._vecPool = [];
    /** Result metadata for the last findPath(). Overwritten by the next call. */
    this.pathInfo = { complete: false, nodes: 0, expanded: 0, ms: 0, cached: false, reason: '' };

    // ---- path cache ----
    this._cache = new Map();
    this._cacheVersion = 0;

    // ---- request queue ----
    this._queue = [];
    this._reqPool = [];
    this._nextRequestId = 1;
    this._activeRequest = null;

    // ---- cost modifiers ----
    this._mods = [];
    this._modByName = new Map();

    // ---- anchors & routes ----
    /** @type {Map<string, THREE.Vector3>} */
    this.anchors = new Map();
    this._anchorOverrides = new Map();
    /** @type {object[]} named, hand-designed loops. Public per the module contract. */
    this.patrolRoutes = [];
    this.rallyPoints = [];
    this.hasStructurePatrol = false;
    /** Walkable strips stamped over water — the log at the draw, plus anything addBridge() adds. */
    this.bridges = [];

    // ---- light sources feeding the lit-area cost field ----
    this._lights = [];

    // ---- debug ----
    this._debugGroup = null;
    this._debugScene = null;
    this._debugWanted = false;
    try {
      const p = new URLSearchParams(globalThis.location?.search ?? '');
      this._debugWanted = p.has('navdebug');
    } catch { /* non-browser */ }

    this._unsub = [];
    this._disposed = false;
    this.ready = false;
    this._rand = new Rand((ctx?.settings?.get?.('seed') ?? 0x51a5cab) ^ 0x4a17ed);

    this.stats = {
      buildMs: 0, walkable: 0, blocked: 0, regions: 0,
      searches: 0, cacheHits: 0, expandedLastFrame: 0, queued: 0, routesReady: 0,
    };
  }

  // ===============================================================================================
  // INIT
  // ===============================================================================================

  async init() {
    if (this._disposed) return;
    const t0 = performance.now();

    this._terrain = this.ctx?.systems?.get?.('Terrain') ?? null;
    this._physics = this.ctx?.systems?.get?.('Physics') ?? null;
    this._props = this.ctx?.systems?.get?.('Props') ?? null;
    this._cabinSite = this.ctx?.systems?.get?.('CabinSite') ?? null;

    // Script is pure data with no dependencies, but a dynamic import keeps this module standalone
    // if src/story/Script.js is ever missing or broken.
    this._script = null;
    try {
      const m = await import('../story/Script.js');
      this._script = m?.Script ?? m?.default ?? null;
    } catch (e) {
      Log.once('nav:script', 'Navmesh: Script.js unavailable — routes fall back to all-nights.', e?.message ?? e);
    }

    // Order is load-bearing. Cost does not depend on light (light is applied at query time, so
    // night:begin can re-bake it for free), and the anchors need the regions to snap against —
    // which is why anchors come after the flood fill and the lights come after the anchors.
    try {
      this._resolveBounds();
      this._allocate();
      this._sampleTerrain();
      this._bakeStaticColliders();
      this._bakeCost();
      this._bakeCrossings();
      this._markEdges();
      this._computeRegions();
    } catch (e) {
      Log.error('Navmesh: grid build failed — falling back to an open field.', e);
      this._fallbackGrid();
    }

    try {
      this._buildAnchors();
      this._collectLights();
      this._bakeLight();
      this._buildRoutes();
      this._installPlotRepulsion();
    } catch (e) {
      Log.error('Navmesh: route build failed — pathfinding still works.', e);
      if (!Array.isArray(this.patrolRoutes)) this.patrolRoutes = [];
    }

    this._bindEvents();
    this.ready = true;
    this.stats.buildMs = performance.now() - t0;

    Log.debug(`Navmesh: ${this.width}x${this.depth} @${this.cell}m, `
      + `${this.stats.walkable} walkable / ${this.cells} cells, ${this.stats.regions} regions, `
      + `${this.patrolRoutes.length} routes, ${this.stats.buildMs.toFixed(0)} ms`);

    if (this._debugWanted && this.ctx?.scene) this.debugDraw(this.ctx.scene, true);
  }

  // -------------------------------------------------------------------------------- grid geometry

  _resolveBounds() {
    const t = this._terrain;
    let minX = -224, maxX = 224, minZ = -192, maxZ = 192;   // STORY §4.1, 448 x 384
    if (t?.bounds && Number.isFinite(t.bounds.minX)) {
      minX = t.bounds.minX; maxX = t.bounds.maxX;
      minZ = t.bounds.minZ; maxZ = t.bounds.maxZ;
    }
    this.bounds = { minX, maxX, minZ, maxZ };
    this.cell = NAV_TUNING.cellSize;
    this.invCell = 1 / this.cell;
    this.cellDiag = this.cell * SQRT2;
    this.originX = minX;
    this.originZ = minZ;
    this.width = Math.max(2, Math.ceil((maxX - minX) / this.cell));
    this.depth = Math.max(2, Math.ceil((maxZ - minZ) / this.cell));
    this.cells = this.width * this.depth;
  }

  _allocate() {
    const n = this.cells;
    this._flags = new Uint8Array(n);
    this._cost = new Uint16Array(n);
    this._lit = new Uint8Array(n);
    this._region = new Uint16Array(n);
    this._height = new Float32Array(n);
    this._build = new Uint8Array(n);
    this._regionStack = new Int32Array(n);
    this._sync = new NavSearch(n, NAV_TUNING.heapCapacity);
    this._async = new NavSearch(n, NAV_TUNING.heapCapacity);
  }

  _fallbackGrid() {
    // Every arithmetic path below assumes the arrays exist. If the build threw halfway, make the
    // world a flat open field rather than leaving a half-filled grid that lies about the ground.
    if (!this._flags) this._allocate();
    this._flags.fill(F_OPEN);
    this._cost.fill(256);
    this._lit.fill(0);
    this._build.fill(0);
    this._height.fill(0);
    this._region.fill(1);
    this._regionSizes = [0, this.cells];
    this._mainRegion = 1;
    this._hUnit = 1;
    this.stats.walkable = this.cells;
    this.stats.regions = 1;
  }

  // ------------------------------------------------------------------------------- terrain sample

  _sampleTerrain() {
    const t = this._terrain;
    const w = this.width, d = this.depth;
    const H = this._height, FL = this._flags;
    const c = this.cell, ox = this.originX + c * 0.5, oz = this.originZ + c * 0.5;

    // Pass 1: heights. Everything else derives from the cached grid, so heightAt() is called
    // exactly once per cell rather than five times.
    if (t?.heightAt) {
      for (let j = 0, i = 0; j < d; j++) {
        const z = oz + j * c;
        for (let k = 0; k < w; k++, i++) H[i] = t.heightAt(ox + k * c, z);
      }
    }

    // Pass 2: slope from the cached heights, water/path/brush from Terrain's published fields.
    const maxSlope = Math.tan(NAV_TUNING.maxSlopeDeg * Math.PI / 180);
    const inv2c = 1 / (2 * c);
    for (let j = 0, i = 0; j < d; j++) {
      const z = oz + j * c;
      for (let k = 0; k < w; k++, i++) {
        const x = ox + k * c;
        let f = 0;

        const hl = H[k > 0 ? i - 1 : i];
        const hr = H[k < w - 1 ? i + 1 : i];
        const hd = H[j > 0 ? i - w : i];
        const hu = H[j < d - 1 ? i + w : i];
        const kx = k > 0 && k < w - 1 ? inv2c : this.invCell;
        const kz = j > 0 && j < d - 1 ? inv2c : this.invCell;
        const gx = (hr - hl) * kx, gz = (hu - hd) * kz;
        const grad = Math.sqrt(gx * gx + gz * gz);
        if (grad > maxSlope) f |= F_STEEP;

        if (t) {
          if (t.isWater?.(x, z)) f |= F_WATER;
          else if (t.waterLevel !== undefined && H[i] < t.waterLevel + 0.06) f |= F_WATER;
          if ((t.pathInfluenceAt?.(x, z) ?? 0) > 0.4) f |= F_PATH;
          if ((t.forestDensityAt?.(x, z) ?? 0) > 0.62) f |= F_BRUSH;
        }

        if (!(f & (F_STEEP | F_WATER))) f |= F_OPEN;
        FL[i] = f;
      }
    }
  }

  // ------------------------------------------------------------------------------ static blockers

  /**
   * Stamp every move-blocking collider Physics knows about into the grid.
   *
   * Rather than one overlapSphere per cell (117 000 queries), the world is swept in 8 m
   * super-cells (4 096 queries) and each collider found is rasterised once, by AABB, dilated by
   * the agent radius. A super-cell that saturates overlapSphere's 64-result cap is subdivided.
   */
  _bakeStaticColliders() {
    const phys = this._physics;
    if (!phys || typeof phys.overlapSphere !== 'function') {
      Log.once('nav:nophys', 'Navmesh: Physics unavailable — nothing but terrain blocks movement.');
      return;
    }
    const MASKS = phys.MASK ?? FALLBACK_MASK;
    const LAYERS = phys.LAYER ?? FALLBACK_LAYER;
    const mask = (MASKS.WORLD ?? FALLBACK_MASK.WORLD) | (LAYERS.FOLIAGE ?? FALLBACK_LAYER.FOLIAGE);

    _seenCols.clear();
    const step = 8.0;
    const radius = step * 0.5 * SQRT2 + NAV_TUNING.agentRadius + 0.3;
    let saturated = 0;

    for (let z = this.bounds.minZ + step * 0.5; z < this.bounds.maxZ + step; z += step) {
      for (let x = this.bounds.minX + step * 0.5; x < this.bounds.maxX + step; x += step) {
        _v0.set(x, 0, z);
        // The heightfield spans roughly -12..48; a sphere centred on the ground would miss a
        // canopy collider, so centre it on the local ground and use a generous radius in Y by
        // querying twice where the terrain is steep. One query is enough in practice because
        // overlapSphere measures to the collider AABB, and trunks reach the ground.
        _v0.y = this.heightAt(x, z) + 1.0;
        let n = phys.overlapSphere(_v0, radius, _colOut, mask);
        if (n >= 64) {
          saturated++;
          // Subdivide once. Four quadrant queries at half the radius recover the overflow.
          for (let q = 0; q < 4; q++) {
            const qx = x + ((q & 1) ? step * 0.25 : -step * 0.25);
            const qz = z + ((q & 2) ? step * 0.25 : -step * 0.25);
            _v1.set(qx, this.heightAt(qx, qz) + 1.0, qz);
            const m = phys.overlapSphere(_v1, radius * 0.55, _colOut, mask);
            for (let i = 0; i < m; i++) this._rasteriseCollider(_colOut[i], LAYERS);
          }
          continue;
        }
        for (let i = 0; i < n; i++) this._rasteriseCollider(_colOut[i], LAYERS);
      }
    }

    if (saturated > 0) {
      Log.debug(`Navmesh: ${saturated} super-cells saturated overlapSphere and were subdivided.`);
    }
    Log.debug(`Navmesh: rasterised ${_seenCols.size} colliders.`);
    _seenCols.clear();
  }

  /** @param {object} col a Physics collider record. Read-only — never mutate it. */
  _rasteriseCollider(col, LAYERS) {
    if (!col || col.alive === false) return;
    const id = col.id;
    if (id !== undefined) {
      if (_seenCols.has(id)) return;
      _seenCols.add(id);
    }

    const foliage = (col.layer & (LAYERS.FOLIAGE ?? 0)) !== 0 || col.blocksMove === false;
    const build = (col.layer & (LAYERS.BUILD ?? 0)) !== 0;
    const water = (col.layer & (LAYERS.WATER ?? 0)) !== 0;
    const terrain = (col.layer & (LAYERS.TERRAIN ?? 0)) !== 0;
    if (terrain) return;   // the heightfield is already the ground; it is not an obstacle

    const r = NAV_TUNING.agentRadius;
    const i0 = this._clampIX(Math.floor((col.minX - r - this.originX) * this.invCell));
    const i1 = this._clampIX(Math.ceil((col.maxX + r - this.originX) * this.invCell));
    const j0 = this._clampIZ(Math.floor((col.minZ - r - this.originZ) * this.invCell));
    const j1 = this._clampIZ(Math.ceil((col.maxZ + r - this.originZ) * this.invCell));
    if (i1 < i0 || j1 < j0) return;

    const FL = this._flags;
    const minH = build ? NAV_TUNING.stepBlockHeight : NAV_TUNING.staticBlockHeight;

    for (let j = j0; j <= j1; j++) {
      const base = j * this.width;
      for (let i = i0; i <= i1; i++) {
        const idx = base + i;
        if (water) { FL[idx] |= F_WATER; FL[idx] &= ~F_OPEN; continue; }
        if (foliage) { FL[idx] |= F_BRUSH; continue; }

        // A collider only blocks if it intrudes on the slab a walking person occupies. This is
        // what lets a camper walk across a laid floor deck but not through a standing wall,
        // and it is GAME_DESIGN §9.6's "height >= 1.2 m cuts patrol edges" expressed in geometry.
        const gy = this._height[idx];
        const top = Math.min(col.maxY, gy + NAV_TUNING.headroom);
        const bot = Math.max(col.minY, gy);
        if (top - bot < minH) continue;

        FL[idx] |= F_BLOCKED;
        FL[idx] &= ~F_OPEN;
      }
    }
  }

  // --------------------------------------------------------------------------------------- lights

  /**
   * Find the camp's light sources. Props owns the fires and the lamps but may publish them under
   * any of several plausible names, so: ask, then fall back to walking the scene for point and
   * spot lights, then fall back to the anchors themselves.
   */
  _collectLights() {
    this._lights.length = 0;
    const push = (x, z, radius, intensity) => {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      this._lights.push({ x, z, radius: Math.max(2, radius || 14), intensity: clamp01(intensity ?? 1) });
    };

    const p = this._props;
    const published = p?.lightSources ?? p?.lights ?? (typeof p?.getLightSources === 'function' ? p.getLightSources() : null);
    if (Array.isArray(published)) {
      for (const l of published) {
        const pos = l?.position ?? l;
        push(pos?.x, pos?.z, l?.radius ?? l?.distance, l?.intensity ?? 1);
      }
    }

    if (this._lights.length === 0 && this.ctx?.scene) {
      const cam = this.ctx.camera;
      this.ctx.scene.traverse((o) => {
        if (!o || !(o.isPointLight || o.isSpotLight)) return;
        if (o.intensity <= 0) return;
        // The player's own lantern is parented to the camera; it is not camp light.
        for (let a = o.parent; a; a = a.parent) if (a === cam) return;
        o.getWorldPosition(_v0);
        push(_v0.x, _v0.z, o.distance > 0 ? o.distance : 16, clamp01(o.intensity / 24));
      });
    }

    if (this._lights.length === 0) {
      // No lights registered yet (Props may still be a stub). The camp is lit because there are
      // people in it; light the anchors that would have lamps on them.
      for (const name of ['firepit', 'mess', 'cabins', 'office', 'dock', 'toolshed']) {
        const a = this._rawAnchor(name);
        if (a) push(a.x, a.z, name === 'firepit' ? 22 : 15, name === 'firepit' ? 1.0 : 0.7);
      }
    }
  }

  /** Stamp radial falloff for every light into `_lit`. Cheap enough to redo on night:begin. */
  _bakeLight() {
    const LT = this._lit;
    LT.fill(0);
    const c = this.cell, ox = this.originX + c * 0.5, oz = this.originZ + c * 0.5;
    for (const l of this._lights) {
      const i0 = this._clampIX(Math.floor((l.x - l.radius - this.originX) * this.invCell));
      const i1 = this._clampIX(Math.ceil((l.x + l.radius - this.originX) * this.invCell));
      const j0 = this._clampIZ(Math.floor((l.z - l.radius - this.originZ) * this.invCell));
      const j1 = this._clampIZ(Math.ceil((l.z + l.radius - this.originZ) * this.invCell));
      const invR = 1 / l.radius;
      for (let j = j0; j <= j1; j++) {
        const z = oz + j * c, base = j * this.width;
        for (let i = i0; i <= i1; i++) {
          const x = ox + i * c;
          const dx = x - l.x, dz = z - l.z;
          const t = 1 - Math.sqrt(dx * dx + dz * dz) * invR;
          if (t <= 0) continue;
          const v = Math.min(255, Math.round(t * t * l.intensity * 255));
          const idx = base + i;
          if (v > LT[idx]) LT[idx] = v;
        }
      }
    }
    // Anything meaningfully lit is "the camp" as far as the AI is concerned.
    const FL = this._flags;
    for (let i = 0; i < this.cells; i++) {
      if (LT[i] > 60) FL[i] |= F_CAMP; else FL[i] &= ~F_CAMP;
    }
  }

  // ------------------------------------------------------------------------------------ cost bake

  _bakeCost() {
    const t = this._terrain;
    const FL = this._flags, C = this._cost, H = this._height;
    const w = this.width, d = this.depth, c = this.cell;
    const ox = this.originX + c * 0.5, oz = this.originZ + c * 0.5;
    const maxSlopeTan = Math.tan(NAV_TUNING.maxSlopeDeg * Math.PI / 180);
    const inv2c = 1 / (2 * c);
    const T = NAV_TUNING;
    let walkable = 0, blocked = 0, costSum = 0;
    const HIST_N = 256, HIST_MAX = 8;
    const hist = new Int32Array(HIST_N);

    for (let j = 0, i = 0; j < d; j++) {
      const z = oz + j * c;
      for (let k = 0; k < w; k++, i++) {
        const f = FL[i];
        if (!(f & F_OPEN)) { C[i] = 65535; blocked++; continue; }
        walkable++;
        const x = ox + k * c;

        const hl = H[k > 0 ? i - 1 : i];
        const hr = H[k < w - 1 ? i + 1 : i];
        const hd = H[j > 0 ? i - w : i];
        const hu = H[j < d - 1 ? i + w : i];
        const gx = (hr - hl) * inv2c, gz = (hu - hd) * inv2c;
        const grad = Math.min(maxSlopeTan, Math.sqrt(gx * gx + gz * gz));
        const slope01 = grad / maxSlopeTan;

        const pathInfl = t?.pathInfluenceAt ? clamp01(t.pathInfluenceAt(x, z)) : ((f & F_PATH) ? 1 : 0);
        const density = t?.forestDensityAt ? clamp01(t.forestDensityAt(x, z)) : 0;
        const wet = t?.wetnessAt ? clamp01(t.wetnessAt(x, z)) : 0;
        const brush = Math.max(density, (f & F_BRUSH) ? 0.75 : 0);

        let cost = 1;
        cost *= 1 - T.pathDiscount * pathInfl;
        cost *= 1 + T.slopePenalty * slope01 * slope01;
        cost *= 1 + T.brushPenalty * brush;
        cost *= 1 + T.wetPenalty * wet;

        cost = clamp(cost, T.costMin, T.costMax);
        costSum += cost;
        hist[Math.min(HIST_N - 1, (cost / HIST_MAX * HIST_N) | 0)]++;
        C[i] = Math.min(65534, Math.round(cost * 256));
      }
    }

    this.stats.walkable = walkable;
    this.stats.blocked = blocked;

    // The heuristic's assumed per-metre cost, and the one number that decides whether this file
    // needs a worker. Scale the octile distance by the *minimum* cost and the heuristic is
    // admissible, A* degenerates toward Dijkstra, and a 214 m walk expands 26 000 nodes. Scale it
    // by the mean and the search goes greedy — 20x fewer expansions, but paths came out 64%
    // long, which reads as a camper wandering. The low quartile is the balance: admissible
    // almost everywhere except on the discounted trails, where a slightly long route is
    // indistinguishable from a person taking the path because it is the path.
    const mean = walkable > 0 ? costSum / walkable : 1;
    let target = Math.max(1, Math.floor(walkable * clamp01(T.heuristicPercentile)));
    let acc = 0, q = 1;
    for (let b = 0; b < HIST_N; b++) {
      acc += hist[b];
      if (acc >= target) { q = (b + 0.5) / HIST_N * HIST_MAX; break; }
    }
    this._hUnit = T.heuristicUnitCost > 0 ? T.heuristicUnitCost : clamp(q, 0.25, 4.0);
    this.stats.meanCost = mean;
    this.stats.hUnit = this._hUnit;
    this._cacheVersion++;
  }

  // ------------------------------------------------------------------------------------ bridges

  /**
   * Terrain's stream is a wall: every cell in it is water, so the grid cuts the map in two along
   * it. Terrain also publishes exactly one way across — `logCrossing`, the fallen trunk at the
   * draw. Without stamping it, the shortest walk from the camp to the draw is 392 m around the
   * headwaters instead of 219 m along the carved trail, and the chokepoint the whole west half of
   * the map hangs on does not exist. This puts it back.
   */
  _bakeCrossings() {
    const t = this._terrain;
    const L = t?.logCrossing;
    if (!L?.position || !L?.direction) return;
    const half = (L.length ?? 7.4) * 0.5 + 1.5;   // overshoot so both banks are reached
    const dx = L.direction.x, dz = L.direction.z;
    const inv = Math.hypot(dx, dz) || 1;
    const ax = L.position.x - (dx / inv) * half;
    const az = L.position.z - (dz / inv) * half;
    const bx = L.position.x + (dx / inv) * half;
    const bz = L.position.z + (dz / inv) * half;
    const n = this.addBridge(
      { x: ax, y: L.position.y, z: az },
      { x: bx, y: L.position.y, z: bz },
      NAV_TUNING.bridgeWidth, NAV_TUNING.bridgeCost, false,
    );
    Log.debug(`Navmesh: log crossing at the draw stamped over ${n} cells.`);
  }

  /**
   * Make a strip of ground walkable regardless of what is under it — a log over a stream, a dock
   * deck over water, a plank the player laid down. `Props`/`CabinSite` may call this after init.
   *
   * @param {{x,y,z}} a @param {{x,y,z}} b end points (y is the walking surface height)
   * @param {number} [width] corridor width in metres
   * @param {number} [cost] traversal cost multiplier for the strip
   * @param {boolean} [rebuild] recompute connectivity now (default true; init batches instead)
   * @returns {number} cells stamped
   */
  addBridge(a, b, width = NAV_TUNING.bridgeWidth, cost = NAV_TUNING.bridgeCost, rebuild = true) {
    if (!this._flags || !a || !b) return 0;
    const halfW = Math.max(this.cell * 0.6, width * 0.5);
    const minX = Math.min(a.x, b.x) - halfW, maxX = Math.max(a.x, b.x) + halfW;
    const minZ = Math.min(a.z, b.z) - halfW, maxZ = Math.max(a.z, b.z) + halfW;
    const i0 = this._clampIX(Math.floor((minX - this.originX) * this.invCell));
    const i1 = this._clampIX(Math.ceil((maxX - this.originX) * this.invCell));
    const j0 = this._clampIZ(Math.floor((minZ - this.originZ) * this.invCell));
    const j1 = this._clampIZ(Math.ceil((maxZ - this.originZ) * this.invCell));

    const ex = b.x - a.x, ez = b.z - a.z;
    const elen2 = ex * ex + ez * ez || 1;
    const ay = a.y ?? 0, by = b.y ?? ay;
    const costFixed = Math.min(65534, Math.round(clamp(cost, NAV_TUNING.costMin, NAV_TUNING.costMax) * 256));
    const halfW2 = halfW * halfW;
    let stamped = 0;

    for (let j = j0; j <= j1; j++) {
      const z = this.originZ + (j + 0.5) * this.cell;
      const base = j * this.width;
      for (let i = i0; i <= i1; i++) {
        const x = this.originX + (i + 0.5) * this.cell;
        let s = ((x - a.x) * ex + (z - a.z) * ez) / elen2;
        s = clamp01(s);
        const px = a.x + ex * s, pz = a.z + ez * s;
        const ddx = x - px, ddz = z - pz;
        if (ddx * ddx + ddz * ddz > halfW2) continue;
        const idx = base + i;
        this._flags[idx] = (this._flags[idx] & ~(F_WATER | F_STEEP | F_BLOCKED)) | F_OPEN | F_PATH;
        this._build[idx] = 0;
        this._cost[idx] = costFixed;
        // The deck only lifts you where the ground has fallen away beneath it. A log beds into
        // its banks; walking onto one should not be a step up onto air.
        const deck = lerp(ay, by, s);
        if (deck > this._height[idx]) this._height[idx] = deck;
        stamped++;
      }
    }

    if (stamped) {
      this.bridges.push({
        ax: a.x, az: a.z, bx: b.x, bz: b.z, halfW2, ay, by,
        ex, ez, elen2,
      });
    }

    if (stamped && rebuild) {
      this._markEdges();
      this._computeRegions();
      this._invalidateCache();
    }
    return stamped;
  }

  _markEdges() {
    const FL = this._flags, w = this.width, d = this.depth;
    for (let j = 0; j < d; j++) {
      for (let k = 0; k < w; k++) {
        const i = j * w + k;
        if (!(FL[i] & F_OPEN)) continue;
        let edge = false;
        for (let n = 0; n < 8 && !edge; n++) {
          const nx = k + NB_DX[n], nz = j + NB_DZ[n];
          if (nx < 0 || nz < 0 || nx >= w || nz >= d) { edge = true; break; }
          if (!(FL[nz * w + nx] & F_OPEN)) edge = true;
        }
        if (edge) FL[i] |= F_EDGE; else FL[i] &= ~F_EDGE;
      }
    }
  }

  // ------------------------------------------------------------------------------------- regions

  /**
   * Flood-fill connected components. Two cells in different regions can never be connected, so
   * findPath() rejects them in O(1) instead of expanding the entire grid to discover it — which
   * is the single most important optimisation here, because the lake and the far side of the
   * ridge are large, attractive, and unreachable.
   */
  _computeRegions() {
    const FL = this._flags, R = this._region, S = this._regionStack;
    const w = this.width, d = this.depth;
    R.fill(0);
    const sizes = [0];
    let next = 1;

    for (let seed = 0; seed < this.cells; seed++) {
      if (R[seed] !== 0 || !(FL[seed] & F_OPEN)) continue;
      if (next > 65534) break;
      const id = next++;
      let sp = 0, count = 0;
      S[sp++] = seed;
      R[seed] = id;
      while (sp > 0) {
        const i = S[--sp];
        count++;
        const k = i % w, j = (i / w) | 0;
        for (let n = 0; n < 8; n++) {
          const nx = k + NB_DX[n], nz = j + NB_DZ[n];
          if (nx < 0 || nz < 0 || nx >= w || nz >= d) continue;
          const ni = nz * w + nx;
          if (R[ni] !== 0 || !(FL[ni] & F_OPEN)) continue;
          if (n >= 4) {
            const ga = j * w + k + NB_DX[NB_GUARD_A[n]] + NB_DZ[NB_GUARD_A[n]] * w;
            const gb = j * w + k + NB_DX[NB_GUARD_B[n]] + NB_DZ[NB_GUARD_B[n]] * w;
            if (!(FL[ga] & F_OPEN) || !(FL[gb] & F_OPEN)) continue;
          }
          R[ni] = id;
          if (sp < S.length) S[sp++] = ni;
        }
      }
      sizes[id] = count;
    }

    this._regionSizes = sizes;
    this.stats.regions = next - 1;
    let best = 0, bestSize = -1;
    for (let i = 1; i < sizes.length; i++) if (sizes[i] > bestSize) { bestSize = sizes[i]; best = i; }
    this._mainRegion = best;
  }

  // ===============================================================================================
  // ANCHORS
  // ===============================================================================================

  /** Raw, unsnapped anchor position. Override > Props > Terrain > derived > STORY §4.2. */
  _rawAnchor(name) {
    const ov = this._anchorOverrides.get(name);
    if (ov) return ov;

    const p = this._props;
    const fromProps = (typeof p?.getAnchor === 'function' ? p.getAnchor(name) : null)
      ?? p?.anchors?.get?.(name) ?? p?.anchors?.[name] ?? p?.landmarks?.[name] ?? null;
    if (fromProps && Number.isFinite(fromProps.x) && Number.isFinite(fromProps.z)) {
      return _v0.set(fromProps.x, fromProps.y ?? 0, fromProps.z).clone();
    }

    const t = this._terrain;
    if (t) {
      switch (name) {
        case 'plot': {
          const cs = this._cabinSite;
          const c = cs?.center ?? cs?.origin ?? t.buildSiteCenter;
          if (c) return new THREE.Vector3(c.x, c.y ?? 0, c.z);
          break;
        }
        case 'camp': if (t.campCenter) return t.campCenter.clone(); break;
        case 'dock': if (t.dock) return t.dock.clone(); break;
        case 'shore': if (t.shorePoint) return t.shorePoint.clone(); break;
        case 'latrine': if (t.latrine) return t.latrine.clone(); break;
        case 'draw': if (t.logCrossing?.position) return t.logCrossing.position.clone(); break;
        case 'ridge': {
          const plot = this.anchors.get('plot');
          if (plot && typeof t.nearestRidgePoint === 'function') {
            return t.nearestRidgePoint(plot.x, plot.z, new THREE.Vector3());
          }
          break;
        }
        case 'trail-mid': {
          const p = this._pathAnchor('camp-draw', 0.55) ?? this._pathAnchor('camp-latrine', 0.9);
          if (p) return p;
          break;
        }
        default: break;
      }
    }

    const derived = this._deriveAnchor(name);
    if (derived) return derived;

    const doc = DOC_ANCHORS[name];
    if (doc) return new THREE.Vector3(doc[0], 0, doc[1]);
    return null;
  }

  /**
   * A point at parameter `t` (0..1) along one of the trails Terrain carved. Patrol loops that
   * turn on the trail network rather than at the camp gate stay short enough to be met twice in
   * a night, which is what makes them a patrol rather than a procession.
   * @returns {THREE.Vector3|null}
   */
  _pathAnchor(pathId, t) {
    const paths = this._terrain?.paths;
    if (!Array.isArray(paths)) return null;
    const p = paths.find((x) => x?.id === pathId);
    if (!p?.points?.length) return null;
    const i = clamp(Math.round((p.points.length - 1) * clamp01(t)), 0, p.points.length - 1);
    const pt = p.points[i];
    if (!pt || !Number.isFinite(pt.x)) return null;
    return new THREE.Vector3(pt.x, this.heightAt(pt.x, pt.z), pt.z);
  }

  /**
   * Anchors Terrain does not publish are placed in the camp's own local frame: `fwd` points from
   * the camp centre toward the dock (i.e. toward the water), `right` is its perpendicular. The
   * layout below is STORY §4.2's relative arrangement, expressed in that frame, so it lands on
   * whatever ground Terrain actually generated instead of on a coordinate from a different map.
   */
  _deriveAnchor(name) {
    const camp = this.anchors.get('camp');
    if (!camp) return null;
    const dock = this.anchors.get('dock');
    if (dock) {
      _fwd.set(dock.x - camp.x, 0, dock.z - camp.z);
      if (_fwd.lengthSq() < 1e-4) _fwd.set(0, 0, -1);
      _fwd.normalize();
    } else {
      _fwd.set(0, 0, -1);
    }
    _right.set(_fwd.z, 0, -_fwd.x);

    const T = {
      firepit: [4, 0],
      mess: [-20, 18],
      cabins: [-8, -22],
      office: [-26, 2],
      toolshed: [-32, 26],
      woodpile: [2, 32],
      'canoe-rack': null,
      boathouse: null,
      'shore-west': null,
      latrine: [-30, -34],
      dock: [56, 0],
      shore: [60, 0],
    }[name];

    if (T) {
      return new THREE.Vector3(
        camp.x + _fwd.x * T[0] + _right.x * T[1], 0,
        camp.z + _fwd.z * T[0] + _right.z * T[1],
      );
    }

    // Waterfront anchors hang off the dock, not the camp.
    const d = this.anchors.get('dock') ?? camp;
    if (name === 'canoe-rack') {
      return new THREE.Vector3(d.x + _right.x * 16 - _fwd.x * 4, 0, d.z + _right.z * 16 - _fwd.z * 4);
    }
    if (name === 'boathouse') {
      return new THREE.Vector3(d.x - _right.x * 18 - _fwd.x * 2, 0, d.z - _right.z * 18 - _fwd.z * 2);
    }
    if (name === 'shore-west') {
      // Must actually be on the waterline. Interpolating toward the plot walks over the ridge,
      // so march along the lake edge instead: pick the longitude, then find the water.
      const shore = this.anchors.get('shore') ?? d;
      const plot = this.anchors.get('plot');
      const x = plot ? lerp(shore.x, plot.x, 0.55) : shore.x - _right.x * 60;
      return this._waterlinePoint(x, shore.z);
    }
    return null;
  }

  /**
   * Walk in Z from `startZ` until the ground meets the lake, then step back onto dry land. Both
   * directions are tried, nearest wins; if neither finds water the start point is returned.
   */
  _waterlinePoint(x, startZ) {
    const t = this._terrain;
    const wl = t?.waterLevel ?? 0;
    const minZ = this.bounds.minZ + 2, maxZ = this.bounds.maxZ - 2;
    let best = null, bestD = Infinity;
    for (const dir of [-1, 1]) {
      let z = startZ;
      for (let s = 0; s < 220; s++) {
        z += dir * 2;
        if (z < minZ || z > maxZ) break;
        if (this.heightAt(x, z) < wl + 0.25) {
          const land = z - dir * 3.5;
          const d = Math.abs(land - startZ);
          if (d < bestD) { bestD = d; best = land; }
          break;
        }
      }
    }
    const z = best ?? startZ;
    return new THREE.Vector3(x, this.heightAt(x, z), z);
  }

  _buildAnchors() {
    this.anchors.clear();
    // Order matters: 'camp' and 'dock' define the local frame the derived anchors use.
    const order = [
      'plot', 'camp', 'dock', 'shore', 'latrine', 'draw', 'ridge', 'trail-mid',
      'firepit', 'mess', 'cabins', 'office', 'toolshed', 'woodpile',
      'canoe-rack', 'boathouse', 'shore-west',
    ];
    for (const name of order) {
      let p = null;
      try { p = this._rawAnchor(name); } catch (e) { Log.once(`nav:anchor:${name}`, `Navmesh: anchor '${name}' threw`, e); }
      if (!p) continue;
      p.y = this.heightAt(p.x, p.z);
      this.anchors.set(name, p);
    }

    // Snap every anchor onto walkable ground in the main region. An anchor in the lake or in a
    // trunk is a route that never resolves, and a route that never resolves is a camper standing
    // still for a night.
    for (const [name, p] of this.anchors) {
      if (name === 'plot') continue;               // the plot is allowed to be whatever it is
      const snapped = this._nearestWalkable(p.x, p.z, 34, true);
      if (snapped >= 0) {
        this.worldOf(snapped, _v0);
        p.set(_v0.x, _v0.y, _v0.z);
      } else {
        Log.once(`nav:snap:${name}`, `Navmesh: anchor '${name}' has no walkable ground within 34 m.`);
      }
    }

    // Two derived positions the routes need: where a patrol turns short of the plot, and where a
    // structure patrol stops to look at it.
    const plot = this.anchors.get('plot');
    const draw = this.anchors.get('draw') ?? this.anchors.get('camp');
    if (plot && draw) {
      // 26 m: an ordinary patrol turns here, close enough to hear a mallet, too far to read a
      // silhouette. 12 m: a structure patrol stops here — outside the 14 x 10 m footprint, and
      // near enough that the thing is unmistakably a building.
      this.anchors.set('plot-approach', this._pointToward(plot, draw, NAV_TUNING.plotKeepOut + 10));
      this.anchors.set('plot-watch', this._pointToward(plot, draw, NAV_TUNING.plotKeepOut * 0.75));
    }

    // Rally points — GAME_DESIGN §9.7: an Alerted camper runs to the nearest one.
    this.rallyPoints.length = 0;
    for (const name of ['firepit', 'cabins', 'mess', 'office', 'dock', 'toolshed']) {
      const a = this.anchors.get(name);
      if (a) this.rallyPoints.push({ id: name, position: a.clone() });
    }
  }

  /** A point `dist` metres from `from`, in the direction of `toward`, snapped to walkable ground. */
  _pointToward(from, toward, dist) {
    _v0.set(toward.x - from.x, 0, toward.z - from.z);
    if (_v0.lengthSq() < 1e-6) _v0.set(1, 0, 0);
    _v0.normalize();
    const x = from.x + _v0.x * dist;
    const z = from.z + _v0.z * dist;
    const idx = this._nearestWalkable(x, z, 20, true);
    const out = new THREE.Vector3(x, this.heightAt(x, z), z);
    if (idx >= 0) { this.worldOf(idx, _v1); out.copy(_v1); }
    return out;
  }

  /**
   * Publish or correct an anchor position. `Props.js` should call this in its init() if it places
   * the camp somewhere other than where this file guessed; routes re-resolve immediately.
   * @param {string} name @param {number} x @param {number} z
   */
  setAnchor(name, x, z) {
    if (!name || !Number.isFinite(x) || !Number.isFinite(z)) return false;
    this._anchorOverrides.set(name, new THREE.Vector3(x, this.heightAt(x, z), z));
    if (this.ready) { this._buildAnchors(); this._buildRoutes(); this._invalidateCache(); }
    return true;
  }

  /** @returns {THREE.Vector3|null} the resolved anchor. Do not mutate it. */
  anchor(name) { return this.anchors.get(name) ?? null; }

  // ===============================================================================================
  // ROUTES
  // ===============================================================================================

  _buildRoutes() {
    // Release any leg polylines from a previous resolve.
    for (const r of this.patrolRoutes) r.legs.length = 0;
    this.patrolRoutes = [];

    for (const def of ROUTE_DEFS) {
      const pts = [];
      const dwell = [];
      const notes = [];
      for (const wp of def.waypoints) {
        const a = this.anchors.get(wp.anchor);
        if (!a) continue;
        let x = a.x, z = a.z;
        if (wp.ox || wp.oz) {
          // Offsets are in the camp's local frame so a route reads the same on any layout.
          const camp = this.anchors.get('camp');
          const dock = this.anchors.get('dock');
          if (camp && dock) {
            _fwd.set(dock.x - camp.x, 0, dock.z - camp.z).normalize();
            _right.set(_fwd.z, 0, -_fwd.x);
            x += _fwd.x * wp.ox + _right.x * wp.oz;
            z += _fwd.z * wp.ox + _right.z * wp.oz;
          } else { x += wp.ox; z += wp.oz; }
        }
        const p = this._validateWaypoint(x, z, !!def.structure);
        if (!p) continue;
        pts.push(p);
        dwell.push(wp.dwell || 0);
        notes.push(wp.note || '');
      }

      if (pts.length < 2) {
        Log.once(`nav:route:${def.id}`, `Navmesh: route '${def.id}' could not resolve enough waypoints — disabled.`);
        continue;
      }

      let length = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if (!def.loop && i === pts.length - 1) break;
        length += Math.hypot(b.x - a.x, b.z - a.z);
      }
      let dwellTotal = 0;
      for (const d of dwell) dwellTotal += d;

      const plot = this.anchors.get('plot');
      let nearestPlot = Infinity;
      if (plot) for (const p of pts) nearestPlot = Math.min(nearestPlot, Math.hypot(p.x - plot.x, p.z - plot.z));

      this.patrolRoutes.push({
        id: def.id,
        label: def.label,
        intent: def.intent,
        window: def.window.slice(),
        minNight: def.minNight ?? 1,
        maxNight: def.maxNight ?? 7,
        preferred: def.preferred ? def.preferred.slice() : [],
        speed: def.speed ?? 1.2,
        loop: def.loop !== false,
        structure: !!def.structure,
        enabled: def.enabled !== false,
        points: pts,
        dwell,
        notes,
        lengthMetres: length,
        dwellSeconds: dwellTotal,
        periodSeconds: def.structure
          ? NAV_TUNING.structurePatrolPeriod
          : Math.round(length / (def.speed ?? 1.2) + dwellTotal),
        nearestPlotApproach: nearestPlot,
        legs: [],
        legsReady: 0,
      });
    }

    // Queue the leg polylines as low-priority work — they fill in over the first few frames
    // instead of costing 150 ms of init.
    for (const r of this.patrolRoutes) this._queueRouteLegs(r);
    this.stats.routesReady = 0;
  }

  /**
   * Push a waypoint out of the plot keep-out and onto walkable ground. Routes are allowed to come
   * near the build site — that is the whole tension — but nothing stands on it.
   */
  _validateWaypoint(x, z, isStructureRoute) {
    const plot = this.anchors.get('plot');
    const keep = isStructureRoute ? NAV_TUNING.plotKeepOut * 0.72 : NAV_TUNING.plotKeepOut;
    if (plot) {
      const dx = x - plot.x, dz = z - plot.z;
      const d = Math.hypot(dx, dz);
      if (d < keep) {
        const s = d > 1e-3 ? keep / d : 1;
        x = plot.x + (d > 1e-3 ? dx * s : keep);
        z = plot.z + (d > 1e-3 ? dz * s : 0);
      }
    }
    const idx = this._nearestWalkable(x, z, 26, true);
    if (idx < 0) return null;
    this.worldOf(idx, _v0);
    return new THREE.Vector3(_v0.x, _v0.y, _v0.z);
  }

  _queueRouteLegs(route) {
    const n = route.loop ? route.points.length : route.points.length - 1;
    route.legs.length = 0;
    for (let i = 0; i < n; i++) {
      const a = route.points[i];
      const b = route.points[(i + 1) % route.points.length];
      const leg = { from: i, to: (i + 1) % route.points.length, points: [a.clone(), b.clone()], ready: false, length: 0 };
      route.legs.push(leg);
      this._enqueue(a, b, 0, (pts, ok) => {
        if (this._disposed) return;
        leg.points.length = 0;
        for (const p of pts) leg.points.push(p.clone());
        leg.ready = true;
        leg.length = 0;
        for (let k = 1; k < leg.points.length; k++) {
          leg.length += leg.points[k].distanceTo(leg.points[k - 1]);
        }
        if (ok) route.legsReady++;
        this.stats.routesReady = this.patrolRoutes.reduce((s, r) => s + (r.legsReady >= r.legs.length ? 1 : 0), 0);
      });
    }
  }

  /**
   * Routes that are live right now.
   * @param {number} [night] defaults to ctx.state.night
   * @param {number} [timeOfNight] 0..1, defaults to ctx.state.timeOfNight
   * @param {object[]} [out] reuse an array to avoid allocating
   * @returns {object[]}
   */
  routesFor(night, timeOfNight, out) {
    const n = Number.isFinite(night) ? night : (this.ctx?.state?.night ?? 1);
    const t = Number.isFinite(timeOfNight) ? timeOfNight : (this.ctx?.state?.timeOfNight ?? 0);
    const res = out || [];
    res.length = 0;
    for (const r of this.patrolRoutes) {
      if (!r.enabled) continue;
      if (n < r.minNight || n > r.maxNight) continue;
      if (t < r.window[0] || t > r.window[1]) continue;
      res.push(r);
    }
    return res;
  }

  /** @returns {object|null} */
  route(id) {
    for (const r of this.patrolRoutes) if (r.id === id) return r;
    return null;
  }

  /**
   * The walking polyline for leg `i` of a route. If the background pre-compute has not reached it
   * yet, the leg is solved synchronously now — a camper never waits on us.
   * @returns {THREE.Vector3[]}
   */
  routeLeg(route, i) {
    if (!route?.legs?.length) return [];
    const leg = route.legs[((i % route.legs.length) + route.legs.length) % route.legs.length];
    if (!leg.ready) {
      const pts = this.findPath(route.points[leg.from], route.points[leg.to]);
      leg.points.length = 0;
      for (const p of pts) leg.points.push(p.clone());
      leg.ready = true;
      leg.length = 0;
      for (let k = 1; k < leg.points.length; k++) leg.length += leg.points[k].distanceTo(leg.points[k - 1]);
    }
    return leg.points;
  }

  /**
   * GAME_DESIGN §9.5. A structure report "adds a patrol edge that routes past the plot every
   * ~110 s". Enabling it also softens the plot repulsion, so ordinary patrols stop bending away
   * from a thing the camp now knows is there.
   */
  addStructurePatrol() {
    if (this.hasStructurePatrol) return false;
    this.hasStructurePatrol = true;
    const r = this.patrolRoutes.find((x) => x.structure);
    if (r) r.enabled = true;
    this._installPlotRepulsion();
    this._invalidateCache();
    Log.debug('Navmesh: structure patrol enabled — the plot is now on a loop.');
    return true;
  }

  /** Undo addStructurePatrol(). NightManager may use this between nights. */
  removeStructurePatrol() {
    if (!this.hasStructurePatrol) return false;
    this.hasStructurePatrol = false;
    const r = this.patrolRoutes.find((x) => x.structure);
    if (r) r.enabled = false;
    this._installPlotRepulsion();
    this._invalidateCache();
    return true;
  }

  _installPlotRepulsion() {
    const plot = this.anchors.get('plot');
    if (!plot) return;
    const keep = NAV_TUNING.plotKeepOut;
    const strength = this.hasStructurePatrol ? NAV_TUNING.plotRepulseStructure : NAV_TUNING.plotRepulse;
    const px = plot.x, pz = plot.z;
    this.setCostModifier('__plot', (x, z) => {
      const dx = x - px, dz = z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= keep * keep) return 1;
      const t = 1 - Math.sqrt(d2) / keep;
      return 1 + strength * t * t;
    }, { x: px, z: pz, radius: keep });
  }

  // ===============================================================================================
  // GRID QUERIES
  // ===============================================================================================

  _clampIX(i) { return i < 0 ? 0 : i >= this.width ? this.width - 1 : i; }
  _clampIZ(j) { return j < 0 ? 0 : j >= this.depth ? this.depth - 1 : j; }

  /** Grid index for a world position, or -1 outside the bounds. */
  indexAt(x, z) {
    const i = Math.floor((x - this.originX) * this.invCell);
    const j = Math.floor((z - this.originZ) * this.invCell);
    if (i < 0 || j < 0 || i >= this.width || j >= this.depth) return -1;
    return j * this.width + i;
  }

  /** Clamped grid index — always valid as long as the grid exists. */
  _clampedIndexAt(x, z) {
    const i = this._clampIX(Math.floor((x - this.originX) * this.invCell));
    const j = this._clampIZ(Math.floor((z - this.originZ) * this.invCell));
    return j * this.width + i;
  }

  /** World-space centre of a cell, written into `out`. */
  worldOf(index, out) {
    const o = out || _v0;
    if (index < 0 || index >= this.cells) return o.set(0, 0, 0);
    const i = index % this.width;
    const j = (index / this.width) | 0;
    return o.set(
      this.originX + (i + 0.5) * this.cell,
      this._height ? this._height[index] : 0,
      this.originZ + (j + 0.5) * this.cell,
    );
  }

  /** Ground height, straight from the sampled grid (no Terrain call). */
  heightAt(x, z) {
    if (!this._height) return this._terrain?.heightAt?.(x, z) ?? 0;
    return this._height[this._clampedIndexAt(x, z)];
  }

  /**
   * Can a camper stand here?
   * @param {number} x @param {number} z @returns {boolean}
   */
  isWalkable(x, z) {
    if (!this._flags) return true;
    const i = this.indexAt(x, z);
    if (i < 0) return false;
    return (this._flags[i] & F_OPEN) !== 0 && this._build[i] === 0;
  }

  _open(i) { return (this._flags[i] & F_OPEN) !== 0 && this._build[i] === 0; }

  /**
   * Nearest graph node to a position. Returns a POOLED record — copy what you need immediately;
   * the eighth subsequent call overwrites it (same convention as Physics's Hit records).
   *
   * A position out in the lake or inside a trunk snaps to the closest walkable cell within
   * `searchRadius`. Check `node.index >= 0`: -1 means there is genuinely no ground within reach,
   * and the record's x/y/z then hold the query position unchanged.
   *
   * @param {THREE.Vector3|{x:number,z:number}} position
   * @param {number} [searchRadius] metres, default 48
   * @returns {object} node
   */
  nearestNode(position, searchRadius = 48) {
    const n = nextNode();
    if (!position || !this._flags) {
      n.index = -1; n.walkable = false;
      n.x = position?.x ?? 0; n.z = position?.z ?? 0; n.y = 0;
      return n;
    }
    let idx = this.indexAt(position.x, position.z);
    if (idx < 0 || !this._open(idx)) idx = this._nearestWalkable(position.x, position.z, searchRadius, false);
    if (idx < 0) {
      n.index = -1; n.walkable = false;
      n.x = position.x; n.z = position.z; n.y = this.heightAt(position.x, position.z);
      return n;
    }
    this._fillNode(n, idx);
    return n;
  }

  _fillNode(n, idx) {
    const f = this._flags[idx];
    n.index = idx;
    n.ix = idx % this.width;
    n.iz = (idx / this.width) | 0;
    n.x = this.originX + (n.ix + 0.5) * this.cell;
    n.z = this.originZ + (n.iz + 0.5) * this.cell;
    n.y = this._height[idx];
    n.walkable = (f & F_OPEN) !== 0 && this._build[idx] === 0;
    n.cost = this._cost[idx] * INV256;
    n.region = this._region[idx];
    n.flags = f;
    n.lit = this._lit[idx] * INV255;
    n.onPath = (f & F_PATH) !== 0;
    n.water = (f & F_WATER) !== 0;
    n.edge = (f & F_EDGE) !== 0;
    return n;
  }

  /**
   * Spiral outward for the nearest walkable cell.
   * @param {boolean} mainRegionOnly reject cells that are not in the largest connected component
   * @returns {number} cell index, or -1
   */
  _nearestWalkable(x, z, maxRadius = 24, mainRegionOnly = false) {
    if (!this._flags) return -1;
    const ci = Math.floor((x - this.originX) * this.invCell);
    const cj = Math.floor((z - this.originZ) * this.invCell);
    const maxR = Math.max(1, Math.ceil(maxRadius * this.invCell));
    const w = this.width, d = this.depth;

    for (let r = 0; r <= maxR; r++) {
      let best = -1, bestD2 = Infinity;
      const i0 = ci - r, i1 = ci + r, j0 = cj - r, j1 = cj + r;
      for (let j = j0; j <= j1; j++) {
        if (j < 0 || j >= d) continue;
        const onEdgeRow = (j === j0 || j === j1);
        const stepI = onEdgeRow ? 1 : (i1 - i0 || 1);
        for (let i = i0; i <= i1; i += stepI) {
          if (i < 0 || i >= w) continue;
          const idx = j * w + i;
          if (!this._open(idx)) continue;
          if (mainRegionOnly && this._mainRegion && this._region[idx] !== this._mainRegion) continue;
          const dx = (i - ci), dz = (j - cj);
          const dd = dx * dx + dz * dz;
          if (dd < bestD2) { bestD2 = dd; best = idx; }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /**
   * True when a point is on a stamped crossing rather than on the ground — the log at the draw,
   * a deck, a laid plank. Worth knowing: it is a chokepoint, the footstep is wood, and the
   * ground below is water.
   */
  isBridge(x, z) {
    for (let i = 0; i < this.bridges.length; i++) {
      const b = this.bridges[i];
      let s = ((x - b.ax) * b.ex + (z - b.az) * b.ez) / b.elen2;
      s = clamp01(s);
      const dx = x - (b.ax + b.ex * s), dz = z - (b.az + b.ez * s);
      if (dx * dx + dz * dz <= b.halfW2) return true;
    }
    return false;
  }

  /** Baked lamp/fire illumination, 0..1. Campers may use it as a "would I stand here" proxy. */
  litnessAt(x, z) {
    if (!this._lit) return 0;
    const i = this.indexAt(x, z);
    return i < 0 ? 0 : this._lit[i] * INV255;
  }

  /** Full traversal cost at a point, including light and any active modifiers. */
  costAt(x, z) {
    const i = this.indexAt(x, z);
    if (i < 0 || !this._cost) return Infinity;
    if (!this._open(i)) return Infinity;
    return this._cost[i] * INV256 * this._lightMul(i) * this._modMul(i);
  }

  /** True if two positions are in the same connected component (i.e. a path could exist). */
  sameRegion(a, b) {
    if (!this._region) return true;
    const ia = this._nearestWalkable(a.x, a.z, 24, false);
    const ib = this._nearestWalkable(b.x, b.z, 24, false);
    if (ia < 0 || ib < 0) return false;
    return this._region[ia] === this._region[ib];
  }

  // ===============================================================================================
  // COST MODIFIERS
  // ===============================================================================================

  /**
   * Add or replace a named runtime cost field. Applied multiplicatively during A* expansion, so
   * changes take effect on the very next path with no re-bake.
   *
   *   nav.setCostModifier('robin-scared', { center: pos, radius: 20, mul: 6, ttl: 24 });
   *   nav.setCostModifier('to-the-noise', (x, z) => 1 - 0.4 * falloff(x, z));
   *
   * @param {string} name
   * @param {(x:number, z:number, index:number) => number | {center:{x,z}, radius:number, mul:number, ttl?:number}} fnOrOpts
   *        A function returns a multiplier (> 0; clamped to 0.05..40). An options object is turned
   *        into a smooth radial field: `mul` at the centre, 1 at the rim. `mul < 1` attracts,
   *        `mul > 1` repels. `ttl` expires it automatically, in seconds.
   * @param {{x:number, z:number, radius:number}} [bounds] optional circle outside which the field
   *        is known to be 1. Supplying it means A* skips the call entirely for most nodes; the
   *        options-object form derives it for you.
   * @returns {boolean}
   */
  setCostModifier(name, fnOrOpts, bounds = null) {
    if (!name) return false;
    let fn = null;
    let expires = 0;
    let bx = 0, bz = 0, br2 = Infinity;

    if (typeof fnOrOpts === 'function') {
      fn = fnOrOpts;
      if (bounds && Number.isFinite(bounds.x) && bounds.radius > 0) {
        bx = bounds.x; bz = bounds.z; br2 = bounds.radius * bounds.radius;
      }
    } else if (fnOrOpts && typeof fnOrOpts === 'object') {
      const c = fnOrOpts.center ?? fnOrOpts.position;
      const cx = c?.x ?? fnOrOpts.x ?? 0;
      const cz = c?.z ?? fnOrOpts.z ?? 0;
      const r = Math.max(0.5, fnOrOpts.radius ?? 16);
      const mul = fnOrOpts.mul ?? fnOrOpts.multiplier ?? 4;
      const r2 = r * r;
      fn = (x, z) => {
        const dx = x - cx, dz = z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r2) return 1;
        const t = 1 - Math.sqrt(d2) / r;
        return 1 + (mul - 1) * t * t;
      };
      bx = cx; bz = cz; br2 = r2;
      if (fnOrOpts.ttl > 0) expires = (this.ctx?.clock?.elapsedTime ?? 0) + fnOrOpts.ttl;
    } else {
      return this.clearCostModifier(name);
    }

    const existing = this._modByName.get(name);
    if (existing) {
      existing.fn = fn; existing.expires = expires;
      existing.bx = bx; existing.bz = bz; existing.br2 = br2;
    } else {
      const rec = { name, fn, expires, bx, bz, br2 };
      this._modByName.set(name, rec);
      this._mods.push(rec);
    }
    this._invalidateCache();
    return true;
  }

  /** Remove a named cost field. */
  clearCostModifier(name) {
    const rec = this._modByName.get(name);
    if (!rec) return false;
    this._modByName.delete(name);
    const i = this._mods.indexOf(rec);
    if (i >= 0) this._mods.splice(i, 1);
    this._invalidateCache();
    return true;
  }

  /** Remove every cost field except the permanent plot repulsion. */
  clearCostModifiers() {
    for (let i = this._mods.length - 1; i >= 0; i--) {
      if (this._mods[i].name === '__plot') continue;
      this._modByName.delete(this._mods[i].name);
      this._mods.splice(i, 1);
    }
    this._invalidateCache();
  }

  _lightMul(i) {
    return 1 - NAV_TUNING.litDiscount * (this._lit[i] * INV255);
  }

  _modMul(i) {
    const mods = this._mods;
    const n = mods.length;
    if (n === 0) return 1;
    const ix = i % this.width;
    const iz = (i / this.width) | 0;
    const x = this.originX + (ix + 0.5) * this.cell;
    const z = this.originZ + (iz + 0.5) * this.cell;
    let m = 1;
    for (let k = 0; k < n; k++) {
      const mod = mods[k];
      if (mod.br2 < Infinity) {
        const dx = x - mod.bx, dz = z - mod.bz;
        if (dx * dx + dz * dz >= mod.br2) continue;
      }
      let v = 1;
      try { v = mod.fn(x, z, i); } catch (e) {
        Log.once(`nav:mod:${mod.name}`, `Navmesh: cost modifier '${mod.name}' threw — ignored.`, e);
        v = 1;
      }
      if (!(v > 0)) v = 1;
      m *= v;
      if (m > 40) return 40;
    }
    return m < 0.05 ? 0.05 : m;
  }

  _expireModifiers() {
    if (this._mods.length === 0) return;
    const now = this.ctx?.clock?.elapsedTime ?? 0;
    for (let i = this._mods.length - 1; i >= 0; i--) {
      const m = this._mods[i];
      if (m.expires > 0 && now >= m.expires) {
        this._modByName.delete(m.name);
        this._mods.splice(i, 1);
        this._invalidateCache();
      }
    }
  }

  // ===============================================================================================
  // PATHFINDING
  // ===============================================================================================

  /**
   * Blocking A*. Smoothed with a line-of-sight string-pull so campers walk diagonals across open
   * ground instead of staircasing.
   *
   * @param {THREE.Vector3} from
   * @param {THREE.Vector3} to
   * @param {THREE.Vector3[]} [outArray] reuse this array (and the Vector3s already in it) to make
   *        the call allocation-free. Omit it and you get a fresh array.
   * @returns {THREE.Vector3[]} at least one point when a route exists; empty when nothing does.
   *          Check `nav.pathInfo.complete` to tell a full route from a best-effort partial.
   */
  findPath(from, to, outArray) {
    const out = outArray || [];
    this._reclaim(out);
    const info = this.pathInfo;
    info.complete = false; info.nodes = 0; info.expanded = 0; info.cached = false; info.ms = 0; info.reason = '';

    if (!this.ready || !this._flags || !from || !to) { info.reason = 'not-ready'; return out; }
    const t0 = performance.now();

    let si = this.indexAt(from.x, from.z);
    if (si < 0 || !this._open(si)) si = this._nearestWalkable(from.x, from.z, 18, false);
    let gi = this.indexAt(to.x, to.z);
    if (gi < 0 || !this._open(gi)) gi = this._nearestWalkable(to.x, to.z, 22, false);

    if (si < 0) { info.reason = 'no-start'; return out; }
    if (gi < 0) { info.reason = 'no-goal'; return out; }

    if (si === gi) {
      this._pushPoint(out, from.x, from.z);
      this._pushPoint(out, to.x, to.z);
      info.complete = true; info.nodes = out.length; info.ms = performance.now() - t0;
      return out;
    }

    if (this._region[si] !== this._region[gi]) {
      info.reason = 'unreachable';
      info.ms = performance.now() - t0;
      return out;
    }

    // Cache
    const key = si * 262144 + gi;
    const hit = this._cache.get(key);
    if (hit && hit.version === this._cacheVersion) {
      this._cache.delete(key); this._cache.set(key, hit);   // LRU touch
      this._emitCached(hit, out, from, to);
      info.complete = hit.complete; info.nodes = out.length; info.cached = true;
      info.ms = performance.now() - t0;
      this.stats.cacheHits++;
      return out;
    }

    const ws = this._sync;
    this.worldOf(gi, _v2);
    ws.begin(si, gi, _v2.x, _v2.z);
    const r = this._step(ws, NAV_TUNING.syncExpandCap);
    this.stats.searches++;

    const endNode = (r === 1) ? gi : ws.best;
    const len = this._extract(ws, endNode);
    if (len <= 0) { info.reason = 'no-path'; info.ms = performance.now() - t0; return out; }

    const slen = this._smooth(len);
    this._emit(this._smoothIdx, slen, out, from, to, r === 1);
    this._store(key, this._smoothIdx, slen, r === 1);

    info.complete = r === 1;
    info.nodes = out.length;
    info.expanded = ws.expanded;
    info.ms = performance.now() - t0;
    if (r !== 1) info.reason = 'partial';
    return out;
  }

  /**
   * Amortised A*. The search is stepped across frames against a node budget, so a 300 m request
   * costs a fraction of a millisecond per frame instead of one visible hitch.
   * @returns {Promise<THREE.Vector3[]>} resolves with a fresh array (possibly empty).
   */
  findPathAsync(from, to, priority = 1) {
    return new Promise((resolve) => {
      if (!this.ready) { resolve([]); return; }
      this._enqueue(from, to, priority, (pts) => resolve(pts));
    });
  }

  /**
   * Callback form, for AI code that would rather not hold a Promise.
   * @param {THREE.Vector3} from @param {THREE.Vector3} to
   * @param {(points:THREE.Vector3[], complete:boolean)=>void} callback
   * @returns {number} request id, for cancelPath()
   */
  requestPath(from, to, callback, priority = 1) {
    return this._enqueue(from, to, priority, callback);
  }

  /** Cancel a queued or in-flight request. Its callback never fires. */
  cancelPath(id) {
    if (this._activeRequest && this._activeRequest.id === id) {
      this._activeRequest.cancelled = true;
      return true;
    }
    for (let i = 0; i < this._queue.length; i++) {
      if (this._queue[i].id === id) {
        this._release(this._queue[i]);
        this._queue.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  _enqueue(from, to, priority, callback) {
    const req = this._reqPool.pop() ?? {
      id: 0, fx: 0, fz: 0, tx: 0, tz: 0, priority: 0, cb: null, cancelled: false,
      started: false, si: -1, gi: -1, out: null,
    };
    req.id = this._nextRequestId++;
    req.fx = from.x; req.fz = from.z;
    req.tx = to.x; req.tz = to.z;
    req.priority = priority | 0;
    req.cb = callback;
    req.cancelled = false;
    req.started = false;
    req.si = -1; req.gi = -1;
    req.out = req.out || [];
    req.out.length = 0;
    // Insert by priority (higher first), stable within a priority.
    let i = this._queue.length;
    while (i > 0 && this._queue[i - 1].priority < req.priority) i--;
    this._queue.splice(i, 0, req);
    this.stats.queued = this._queue.length;
    return req.id;
  }

  _release(req) {
    req.cb = null;
    if (req.out) req.out.length = 0;
    if (this._reqPool.length < 32) this._reqPool.push(req);
  }

  _pumpQueue(budget) {
    let remaining = budget;
    while (remaining > 0) {
      if (!this._activeRequest) {
        while (this._queue.length && this._queue[0].cancelled) this._release(this._queue.shift());
        if (!this._queue.length) break;
        this._activeRequest = this._queue.shift();
        this.stats.queued = this._queue.length;
      }
      const req = this._activeRequest;
      if (req.cancelled) { this._release(req); this._activeRequest = null; continue; }

      const ws = this._async;
      if (!req.started) {
        req.started = true;
        let si = this.indexAt(req.fx, req.fz);
        if (si < 0 || !this._open(si)) si = this._nearestWalkable(req.fx, req.fz, 18, false);
        let gi = this.indexAt(req.tx, req.tz);
        if (gi < 0 || !this._open(gi)) gi = this._nearestWalkable(req.tx, req.tz, 22, false);
        req.si = si; req.gi = gi;

        if (si < 0 || gi < 0 || this._region[si] !== this._region[gi]) {
          this._finishRequest(req, -1, false);
          continue;
        }
        if (si === gi) {
          this._reclaim(req.out);
          this._pushPoint(req.out, req.fx, req.fz);
          this._pushPoint(req.out, req.tx, req.tz);
          this._deliver(req, true);
          continue;
        }
        const key = si * 262144 + gi;
        const hit = this._cache.get(key);
        if (hit && hit.version === this._cacheVersion) {
          this._cache.delete(key); this._cache.set(key, hit);
          this._reclaim(req.out);
          _v0.set(req.fx, 0, req.fz); _v1.set(req.tx, 0, req.tz);
          this._emitCached(hit, req.out, _v0, _v1);
          this.stats.cacheHits++;
          this._deliver(req, hit.complete);
          continue;
        }
        this.worldOf(gi, _v2);
        ws.begin(si, gi, _v2.x, _v2.z);
        this.stats.searches++;
      }

      const before = ws.expanded;
      const r = this._step(ws, remaining);
      remaining -= (ws.expanded - before);
      this.stats.expandedLastFrame += (ws.expanded - before);
      if (r === 0) break;                       // still running; resume next frame
      this._finishRequest(req, r === 1 ? req.gi : ws.best, r === 1);
    }
  }

  _finishRequest(req, endNode, complete) {
    if (endNode < 0) { this._deliverEmpty(req); return; }
    const ws = this._async;
    const len = this._extract(ws, endNode);
    if (len <= 0) { this._deliverEmpty(req); return; }
    const slen = this._smooth(len);
    this._reclaim(req.out);
    _v0.set(req.fx, 0, req.fz);
    _v1.set(req.tx, 0, req.tz);
    this._emit(this._smoothIdx, slen, req.out, _v0, _v1, complete);
    this._store(req.si * 262144 + req.gi, this._smoothIdx, slen, complete);
    this._deliver(req, complete);
  }

  _deliver(req, complete) {
    const cb = req.cb;
    // Hand the caller its own array; ours goes back in the pool.
    const pts = [];
    for (const p of req.out) pts.push(p);
    req.out.length = 0;
    this._activeRequest = null;
    this._release(req);
    if (cb) { try { cb(pts, complete); } catch (e) { Log.once('nav:cb', 'Navmesh: path callback threw', e); } }
  }

  _deliverEmpty(req) {
    const cb = req.cb;
    this._activeRequest = null;
    this._release(req);
    if (cb) { try { cb([], false); } catch (e) { Log.once('nav:cb', 'Navmesh: path callback threw', e); } }
  }

  // ---------------------------------------------------------------------------------- the search

  /**
   * Expand up to `budget` nodes.
   * @returns {number} 0 = still running, 1 = goal reached, 2 = exhausted (best-effort available)
   */
  _step(ws, budget) {
    const FL = this._flags, C = this._cost, BD = this._build;
    const w = this.width, d = this.depth;
    const heap = ws.heap;
    const g = ws.g, parent = ws.parent, stamp = ws.stamp, state = ws.state;
    const gen = ws.gen;
    const goal = ws.goal;
    const cell = this.cell, diag = this.cellDiag;
    const hw = NAV_TUNING.heuristicWeight * (this._hUnit || 1);
    const hasMods = this._mods.length > 0;
    const litW = NAV_TUNING.litDiscount;
    const LT = this._lit;

    if (ws.expanded === 0 && heap.size === 0) {
      // First step: seed the open set.
      heap.push(ws.start, this._heuristic(ws.start, goal) * hw);
    }

    let used = 0;
    while (used < budget) {
      const cur = heap.pop();
      if (cur < 0) { ws.active = false; ws.result = 2; return 2; }
      if (stamp[cur] === gen && state[cur] === 2) continue;   // stale heap entry
      stamp[cur] = gen; state[cur] = 2;
      used++; ws.expanded++;

      if (cur === goal) { ws.active = false; ws.result = 1; return 1; }

      // Track the closest node reached, so a failed search still yields a useful partial path.
      const h = this._heuristic(cur, goal);
      if (h < ws.bestH) { ws.bestH = h; ws.best = cur; }

      const cx = cur % w;
      const cz = (cur / w) | 0;
      const gc = g[cur];

      for (let n = 0; n < 8; n++) {
        const nx = cx + NB_DX[n];
        const nz = cz + NB_DZ[n];
        if (nx < 0 || nz < 0 || nx >= w || nz >= d) continue;
        const ni = nz * w + nx;
        if (!(FL[ni] & F_OPEN) || BD[ni] !== 0) continue;
        if (stamp[ni] === gen && state[ni] === 2) continue;

        if (n >= 4) {
          // Corner-cutting prevention: both orthogonal neighbours must be open, or a camper
          // squeezes diagonally between two trunks that are touching.
          const ga = cz * w + cx + NB_DX[NB_GUARD_A[n]] + NB_DZ[NB_GUARD_A[n]] * w;
          const gb = cz * w + cx + NB_DX[NB_GUARD_B[n]] + NB_DZ[NB_GUARD_B[n]] * w;
          if (!(FL[ga] & F_OPEN) || BD[ga] !== 0) continue;
          if (!(FL[gb] & F_OPEN) || BD[gb] !== 0) continue;
        }

        let unit = C[ni] * INV256 * (1 - litW * (LT[ni] * INV255));
        if (hasMods) unit *= this._modMul(ni);
        const ng = gc + (n >= 4 ? diag : cell) * unit;

        if (stamp[ni] === gen && state[ni] === 1 && ng >= g[ni]) continue;
        g[ni] = ng;
        parent[ni] = cur;
        stamp[ni] = gen;
        state[ni] = 1;
        if (!heap.push(ni, ng + this._heuristic(ni, goal) * hw)) {
          // Open set overflow. Stop cleanly and return the best partial rather than corrupting.
          Log.once('nav:heap', 'Navmesh: A* open set overflowed — returning a partial path.');
          ws.active = false; ws.result = 2; return 2;
        }
      }
    }
    return 0;
  }

  /** Octile distance in metres. */
  _heuristic(a, b) {
    const w = this.width;
    const ax = a % w, az = (a / w) | 0;
    const bx = b % w, bz = (b / w) | 0;
    const dx = ax > bx ? ax - bx : bx - ax;
    const dz = az > bz ? az - bz : bz - az;
    const mn = dx < dz ? dx : dz;
    return ((dx + dz) + OCTILE_D * mn) * this.cell;
  }

  /** Walk the parent chain into `_pathIdx`, start-first. @returns {number} length */
  _extract(ws, endNode) {
    const parent = ws.parent, stamp = ws.stamp, gen = ws.gen;
    const buf = this._pathIdx;
    let n = 0;
    let cur = endNode;
    while (cur >= 0 && n < buf.length) {
      buf[n++] = cur;
      if (cur === ws.start) break;
      if (stamp[cur] !== gen) break;
      cur = parent[cur];
    }
    if (n === 0) return 0;
    // reverse in place
    for (let i = 0, j = n - 1; i < j; i++, j--) {
      const t = buf[i]; buf[i] = buf[j]; buf[j] = t;
    }
    this._pathLen = n;
    return n;
  }

  /**
   * String-pull. Repeatedly jump as far ahead as an unobstructed corridor allows. The lookahead
   * is capped so this stays linear on long paths.
   * @returns {number} number of nodes written to `_smoothIdx`
   */
  _smooth(len) {
    const src = this._pathIdx, dst = this._smoothIdx;
    if (len <= 2) { for (let i = 0; i < len; i++) dst[i] = src[i]; return len; }
    const look = NAV_TUNING.smoothLookahead;
    let out = 0;
    let i = 0;
    dst[out++] = src[0];
    while (i < len - 1) {
      const limit = Math.min(len - 1, i + look);
      let j = limit;
      while (j > i + 1) {
        if (this._corridorClear(src[i], src[j])) break;
        j--;
      }
      dst[out++] = src[j];
      if (out >= dst.length - 1) { dst[out - 1] = src[len - 1]; break; }
      i = j;
    }
    if (dst[out - 1] !== src[len - 1] && out < dst.length) dst[out++] = src[len - 1];
    return out;
  }

  /**
   * Is the straight corridor between two cells walkable at agent width? Three parallel DDA walks
   * (centreline plus both shoulders) — cheap, and it stops campers clipping trunk corners.
   */
  _corridorClear(a, b) {
    const w = this.width;
    const ax = this.originX + ((a % w) + 0.5) * this.cell;
    const az = this.originZ + (((a / w) | 0) + 0.5) * this.cell;
    const bx = this.originX + ((b % w) + 0.5) * this.cell;
    const bz = this.originZ + (((b / w) | 0) + 0.5) * this.cell;
    let dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return true;
    const px = (-dz / len) * NAV_TUNING.agentRadius;
    const pz = (dx / len) * NAV_TUNING.agentRadius;
    return this._segmentClear(ax, az, bx, bz)
      && this._segmentClear(ax + px, az + pz, bx + px, bz + pz)
      && this._segmentClear(ax - px, az - pz, bx - px, bz - pz);
  }

  /** Supercover DDA along a segment; every cell it touches must be open. */
  _segmentClear(ax, az, bx, bz) {
    const inv = this.invCell;
    let ix = Math.floor((ax - this.originX) * inv);
    let iz = Math.floor((az - this.originZ) * inv);
    const jx = Math.floor((bx - this.originX) * inv);
    const jz = Math.floor((bz - this.originZ) * inv);
    const w = this.width, d = this.depth;

    if (ix < 0 || iz < 0 || ix >= w || iz >= d) return false;
    if (jx < 0 || jz < 0 || jx >= w || jz >= d) return false;

    const dx = bx - ax, dz = bz - az;
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const cellX = this.cell, cellZ = this.cell;
    const tDeltaX = dx !== 0 ? Math.abs(cellX / dx) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(cellZ / dz) : Infinity;

    const nextBoundaryX = this.originX + (ix + (stepX > 0 ? 1 : 0)) * cellX;
    const nextBoundaryZ = this.originZ + (iz + (stepZ > 0 ? 1 : 0)) * cellZ;
    let tMaxX = dx !== 0 ? (nextBoundaryX - ax) / dx : Infinity;
    let tMaxZ = dz !== 0 ? (nextBoundaryZ - az) / dz : Infinity;

    let guard = 0;
    const guardMax = w + d + 8;
    for (;;) {
      const idx = iz * w + ix;
      if (!(this._flags[idx] & F_OPEN) || this._build[idx] !== 0) return false;
      if (ix === jx && iz === jz) return true;
      if (++guard > guardMax) return false;
      if (tMaxX < tMaxZ) { ix += stepX; tMaxX += tDeltaX; } else { iz += stepZ; tMaxZ += tDeltaZ; }
      if (ix < 0 || iz < 0 || ix >= w || iz >= d) return false;
    }
  }

  // ----------------------------------------------------------------------------- result emission

  /**
   * Take back the Vector3s already in `arr` and empty it. This is what makes calling findPath()
   * with the same `out` array every time genuinely allocation-free: the vectors cycle through
   * `_vecPool` instead of being collected.
   */
  _reclaim(arr) {
    const pool = this._vecPool;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v && v.isVector3 && pool.length < 512) pool.push(v);
    }
    arr.length = 0;
  }

  _pushPoint(out, x, z) {
    const v = this._vecPool.pop() ?? new THREE.Vector3();
    v.set(x, this.heightAt(x, z), z);
    out.push(v);
    return v;
  }

  _emit(idxBuf, len, out, from, to, complete) {
    this._pushPoint(out, from.x, from.z);
    for (let i = 1; i < len - 1; i++) {
      const c = idxBuf[i];
      const ix = c % this.width, iz = (c / this.width) | 0;
      this._pushPoint(out,
        this.originX + (ix + 0.5) * this.cell,
        this.originZ + (iz + 0.5) * this.cell);
    }
    if (complete) {
      this._pushPoint(out, to.x, to.z);
    } else if (len > 1) {
      const c = idxBuf[len - 1];
      const ix = c % this.width, iz = (c / this.width) | 0;
      this._pushPoint(out,
        this.originX + (ix + 0.5) * this.cell,
        this.originZ + (iz + 0.5) * this.cell);
    }
  }

  _emitCached(entry, out, from, to) {
    this._emit(entry.nodes, entry.len, out, from, to, entry.complete);
  }

  _store(key, idxBuf, len, complete) {
    if (len <= 0 || len > 512) return;
    const nodes = new Int32Array(len);
    nodes.set(idxBuf.subarray(0, len));
    this._cache.set(key, { nodes, len, complete, version: this._cacheVersion });
    while (this._cache.size > NAV_TUNING.cacheSize) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
  }

  _invalidateCache() {
    this._cacheVersion++;
    this._cache.clear();
  }

  // ===============================================================================================
  // PATROL / AI HELPERS
  // ===============================================================================================

  /**
   * A plausible place for a camper to wander to. Biased toward cheap ground — which, given the
   * cost field, means the worn paths and the lit camp. That bias is the whole trick: nobody has
   * to be told to prefer the trail.
   *
   * @param {Rand} rand seeded RNG (ARCHITECTURE §6 — never Math.random)
   * @param {THREE.Vector3} [nearPosition] stay within `radius` of this
   * @param {number} [radius] metres, default 45
   * @param {THREE.Vector3} [out] reuse a vector; omit and you get a fresh one
   * @returns {THREE.Vector3}
   */
  randomPatrolTarget(rand, nearPosition = null, radius = 45, out = null) {
    const r = rand ?? this.ctx?.rand ?? this._rand;
    const v = out || new THREE.Vector3();
    if (!this.ready || !this._flags) return v.set(0, 0, 0);

    const tries = NAV_TUNING.patrolSampleTries;
    let fallback = -1;

    for (let k = 0; k < tries; k++) {
      let x, z;
      if (nearPosition) {
        const a = r.next() * Math.PI * 2;
        const d = Math.sqrt(r.next()) * radius;
        x = nearPosition.x + Math.cos(a) * d;
        z = nearPosition.z + Math.sin(a) * d;
      } else {
        x = lerp(this.bounds.minX, this.bounds.maxX, r.next());
        z = lerp(this.bounds.minZ, this.bounds.maxZ, r.next());
      }
      const i = this.indexAt(x, z);
      if (i < 0 || !this._open(i)) continue;
      if (this._mainRegion && this._region[i] !== this._mainRegion) continue;
      if (fallback < 0) fallback = i;
      // Rejection-sample against cost: cheap ground is chosen far more often than expensive.
      const cost = this._cost[i] * INV256 * this._lightMul(i);
      if (r.next() < clamp(0.85 / cost, 0.06, 1)) {
        this.worldOf(i, _v0);
        return v.copy(_v0);
      }
    }

    if (fallback >= 0) { this.worldOf(fallback, _v0); return v.copy(_v0); }
    const camp = this.anchors.get('camp') ?? this.anchors.get('firepit');
    return camp ? v.copy(camp) : v.set(0, 0, 0);
  }

  /**
   * GAME_DESIGN §9.7 — a Searching camper "checks 2–3 cover points chosen by Navmesh". Cover
   * points are walkable cells that sit against something solid: the far side of a trunk, the lee
   * of a rock, the inside corner of a placed wall. They are exactly where a person hides, which
   * is why looking at them is the correct search behaviour.
   *
   * @param {THREE.Vector3} position centre of the search
   * @param {number} [count] how many, default 3
   * @param {THREE.Vector3[]} [out] reused
   * @param {number} [radius] metres, default 14
   * @returns {THREE.Vector3[]}
   */
  coverPoints(position, count = 3, out = null, radius = 14) {
    const res = out || [];
    this._reclaim(res);
    if (!this.ready || !this._flags || !position) return res;

    const rCells = Math.max(1, Math.ceil(radius * this.invCell));
    const ci = Math.floor((position.x - this.originX) * this.invCell);
    const cj = Math.floor((position.z - this.originZ) * this.invCell);
    const minSep2 = NAV_TUNING.coverMinSeparation * NAV_TUNING.coverMinSeparation;
    const r2 = radius * radius;

    _tmpIds.length = 0;
    for (let j = cj - rCells; j <= cj + rCells; j++) {
      if (j < 0 || j >= this.depth) continue;
      for (let i = ci - rCells; i <= ci + rCells; i++) {
        if (i < 0 || i >= this.width) continue;
        const idx = j * this.width + i;
        if (!this._open(idx)) continue;
        if (!(this._flags[idx] & F_EDGE)) continue;
        const x = this.originX + (i + 0.5) * this.cell;
        const z = this.originZ + (j + 0.5) * this.cell;
        const dx = x - position.x, dz = z - position.z;
        const dd = dx * dx + dz * dz;
        if (dd > r2) continue;
        _tmpIds.push(idx, dd);
      }
    }

    // Nearest first, but spread out — otherwise a camper checks the same bush three times.
    for (let n = 0; n < count; n++) {
      let best = -1, bestD = Infinity, bestAt = -1;
      for (let k = 0; k < _tmpIds.length; k += 2) {
        const idx = _tmpIds[k];
        if (idx < 0) continue;
        const dd = _tmpIds[k + 1];
        if (dd >= bestD) continue;
        this.worldOf(idx, _v0);
        let ok = true;
        for (let m = 0; m < res.length; m++) {
          const ddx = res[m].x - _v0.x, ddz = res[m].z - _v0.z;
          if (ddx * ddx + ddz * ddz < minSep2) { ok = false; break; }
        }
        if (!ok) continue;
        best = idx; bestD = dd; bestAt = k;
      }
      if (best < 0) break;
      _tmpIds[bestAt] = -1;
      this.worldOf(best, _v0);
      const v = this._vecPool.pop() ?? new THREE.Vector3();
      v.copy(_v0);
      res.push(v);
    }
    _tmpIds.length = 0;
    return res;
  }

  /**
   * Nearest rally point — GAME_DESIGN §9.7, where an Alerted camper runs to.
   * @returns {{id:string, position:THREE.Vector3}|null}
   */
  nearestRally(position) {
    if (!position || this.rallyPoints.length === 0) return null;
    let best = null, bestD = Infinity;
    for (const r of this.rallyPoints) {
      const d = (r.position.x - position.x) ** 2 + (r.position.z - position.z) ** 2;
      if (d < bestD) { bestD = d; best = r; }
    }
    return best;
  }

  // ===============================================================================================
  // DYNAMIC WORLD — the cabin rewrites the graph as it goes up
  // ===============================================================================================

  /**
   * Re-sample the blockers in a box and rebuild the affected connectivity. GAME_DESIGN §9.6:
   * "only edges within the part's AABB + 3 m are re-evaluated". Called on build:place /
   * build:remove; safe to call directly.
   * @param {number} x @param {number} z @param {number} radius metres
   */
  invalidateArea(x, z, radius = 6) {
    if (!this.ready || !this._flags) return;
    const phys = this._physics;
    const r = radius + 3;
    const i0 = this._clampIX(Math.floor((x - r - this.originX) * this.invCell));
    const i1 = this._clampIX(Math.ceil((x + r - this.originX) * this.invCell));
    const j0 = this._clampIZ(Math.floor((z - r - this.originZ) * this.invCell));
    const j1 = this._clampIZ(Math.ceil((z + r - this.originZ) * this.invCell));

    // Clear the build layer in the box; the static layer is untouched.
    for (let j = j0; j <= j1; j++) {
      const base = j * this.width;
      for (let i = i0; i <= i1; i++) this._build[base + i] = 0;
    }

    if (phys && typeof phys.overlapSphere === 'function') {
      const LAYERS = phys.LAYER ?? FALLBACK_LAYER;
      const buildLayer = LAYERS.BUILD ?? FALLBACK_LAYER.BUILD;
      _v0.set(x, this.heightAt(x, z) + 1.0, z);
      const n = phys.overlapSphere(_v0, r + 2, _colOut, buildLayer);
      for (let k = 0; k < n; k++) {
        const col = _colOut[k];
        if (!col || col.alive === false) continue;
        if (col.blocksMove === false) continue;
        const ar = NAV_TUNING.agentRadius;
        const bi0 = this._clampIX(Math.floor((col.minX - ar - this.originX) * this.invCell));
        const bi1 = this._clampIX(Math.ceil((col.maxX + ar - this.originX) * this.invCell));
        const bj0 = this._clampIZ(Math.floor((col.minZ - ar - this.originZ) * this.invCell));
        const bj1 = this._clampIZ(Math.ceil((col.maxZ + ar - this.originZ) * this.invCell));
        for (let j = bj0; j <= bj1; j++) {
          const base = j * this.width;
          for (let i = bi0; i <= bi1; i++) {
            const idx = base + i;
            const gy = this._height[idx];
            const top = Math.min(col.maxY, gy + NAV_TUNING.headroom);
            const bot = Math.max(col.minY, gy);
            if (top - bot < NAV_TUNING.stepBlockHeight) continue;
            this._build[idx] = 1;
          }
        }
      }
    }

    this._invalidateCache();
    // Route legs that crossed the box are stale. Re-solve them in the background.
    for (const route of this.patrolRoutes) {
      for (const leg of route.legs) {
        if (!leg.ready) continue;
        for (const p of leg.points) {
          if (Math.abs(p.x - x) <= r + 2 && Math.abs(p.z - z) <= r + 2) {
            leg.ready = false;
            if (route.legsReady > 0) route.legsReady--;
            this._enqueue(route.points[leg.from], route.points[leg.to], 0, (pts) => {
              if (this._disposed) return;
              leg.points.length = 0;
              for (const q of pts) leg.points.push(q.clone());
              leg.ready = true;
              route.legsReady++;
            });
            break;
          }
        }
      }
    }
  }

  // ===============================================================================================
  // FRAME
  // ===============================================================================================

  _bindEvents() {
    const bus = this.bus;
    if (!bus?.on) return;
    const add = (name, fn) => {
      try {
        const off = bus.on(name, Log.guard(`nav:${name}`, fn));
        if (typeof off === 'function') this._unsub.push(off);
      } catch (e) { Log.once(`nav:bind:${name}`, `Navmesh: could not subscribe to '${name}'`, e); }
    };

    add('build:place', (p) => this._onBuildChange(p));
    add('build:remove', (p) => this._onBuildChange(p));
    add('night:begin', () => {
      this._collectLights();
      this._bakeLight();
      this._invalidateCache();
      if (this._debugGroup) this._rebuildDebug();
    });
  }

  _onBuildChange(payload) {
    if (!payload) return;
    const src = payload.slot ?? payload.part ?? null;
    const p = src?.position ?? src?.worldPosition
      ?? src?.object3D?.position ?? src?.mesh?.position ?? src?.group?.position ?? null;
    if (p && Number.isFinite(p.x)) {
      this.invalidateArea(p.x, p.z, 6);
    } else {
      const plot = this.anchors.get('plot');
      if (plot) this.invalidateArea(plot.x, plot.z, 12);
    }
  }

  update(dt, _elapsed) {
    if (!this.ready || this._disposed) return;
    this.stats.expandedLastFrame = 0;
    this._expireModifiers();

    // Route pre-computation is priority 0 and runs on a much smaller budget, so the background
    // work of resolving eight patrol loops never competes with a camper who needs a path now.
    const act = this._activeRequest;
    let urgent = act ? act.priority > 0 : false;
    for (let i = 0; i < this._queue.length && !urgent; i++) if (this._queue[i].priority > 0) urgent = true;
    if (act || this._queue.length) {
      this._pumpQueue(urgent ? NAV_TUNING.asyncExpandPerFrame : NAV_TUNING.routeExpandPerFrame);
    }
    void dt;
  }

  resize(_w, _h) { /* nothing resolution-dependent */ }

  // ===============================================================================================
  // DEBUG DRAW  (?navdebug)
  // ===============================================================================================

  /**
   * Render the graph and the patrol routes as lines. Gated behind `?navdebug` so it can never
   * cost anything in a normal session; pass `force` to override the gate from a console.
   * @param {THREE.Scene} scene @param {boolean} on @param {boolean} [force]
   * @returns {boolean} whether the overlay is now visible
   */
  debugDraw(scene, on, force = false) {
    if (on && !this._debugWanted && !force) {
      Log.once('nav:dbg', 'Navmesh.debugDraw ignored — add ?navdebug to the URL (or pass force).');
      return false;
    }
    if (!on) {
      this._teardownDebug();
      return false;
    }
    if (!scene || !this.ready) return false;
    this._debugScene = scene;
    if (this._debugGroup) { this._debugGroup.visible = true; return true; }
    this._rebuildDebug();
    return !!this._debugGroup;
  }

  _rebuildDebug() {
    const scene = this._debugScene ?? this.ctx?.scene;
    if (!scene) return;
    this._teardownDebug(true);

    const group = new THREE.Group();
    group.name = 'navmesh.debug';
    group.renderOrder = 999;
    group.frustumCulled = false;

    // ---- the walkable graph, subsampled, coloured by cost -------------------------------------
    const stride = 2;
    const maxSeg = 60000;
    const pos = [];
    const col = [];
    const c1 = new THREE.Color();
    const c2 = new THREE.Color();
    const lo = new THREE.Color(0x2e6f4a);   // cheap ground
    const hi = new THREE.Color(0xd92b2b);   // expensive ground — the manual's red
    let segs = 0;

    for (let j = 0; j < this.depth - stride && segs < maxSeg; j += stride) {
      for (let i = 0; i < this.width - stride && segs < maxSeg; i += stride) {
        const a = j * this.width + i;
        if (!this._open(a)) continue;
        const ax = this.originX + (i + 0.5) * this.cell;
        const az = this.originZ + (j + 0.5) * this.cell;
        const ay = this._height[a] + 0.06;
        const ca = clamp01((this._cost[a] * INV256 * this._lightMul(a) - 0.4) / 3.0);
        c1.copy(lo).lerp(hi, ca);

        for (let k = 0; k < 2; k++) {
          const bi = i + (k === 0 ? stride : 0);
          const bj = j + (k === 0 ? 0 : stride);
          const b = bj * this.width + bi;
          if (!this._open(b)) continue;
          const cb = clamp01((this._cost[b] * INV256 * this._lightMul(b) - 0.4) / 3.0);
          c2.copy(lo).lerp(hi, cb);
          pos.push(ax, ay, az,
            this.originX + (bi + 0.5) * this.cell, this._height[b] + 0.06,
            this.originZ + (bj + 0.5) * this.cell);
          col.push(c1.r, c1.g, c1.b, c2.r, c2.g, c2.b);
          segs++;
        }
      }
    }

    if (pos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.35, depthWrite: false });
      const lines = new THREE.LineSegments(geo, mat);
      lines.name = 'navmesh.debug.grid';
      lines.frustumCulled = false;
      group.add(lines);
    }

    // ---- routes -------------------------------------------------------------------------------
    for (const route of this.patrolRoutes) {
      const pts = [];
      for (let i = 0; i < route.legs.length; i++) {
        const leg = route.legs[i];
        const lp = leg.ready ? leg.points : [route.points[leg.from], route.points[leg.to]];
        for (let k = 0; k < lp.length; k++) {
          if (i > 0 && k === 0) continue;
          pts.push(new THREE.Vector3(lp[k].x, lp[k].y + 0.35, lp[k].z));
        }
      }
      if (pts.length < 2) continue;
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({
        color: route.structure ? 0xd92b2b : (route.enabled ? 0xffb865 : 0x54606e),
        transparent: true, opacity: route.enabled ? 0.95 : 0.35, depthTest: false, depthWrite: false,
      });
      const line = new THREE.Line(geo, mat);
      line.name = `navmesh.debug.route.${route.id}`;
      line.frustumCulled = false;
      group.add(line);

      // waypoint pips
      const wp = [];
      for (const p of route.points) wp.push(new THREE.Vector3(p.x, p.y + 0.6, p.z));
      const pgeo = new THREE.BufferGeometry().setFromPoints(wp);
      const pmat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.1, sizeAttenuation: true, depthTest: false });
      const pts3 = new THREE.Points(pgeo, pmat);
      pts3.name = `navmesh.debug.wp.${route.id}`;
      pts3.frustumCulled = false;
      group.add(pts3);
    }

    // ---- the plot keep-out ring ---------------------------------------------------------------
    const plot = this.anchors.get('plot');
    if (plot) {
      const ring = [];
      const R = NAV_TUNING.plotKeepOut;
      for (let a = 0; a <= 64; a++) {
        const th = (a / 64) * Math.PI * 2;
        const x = plot.x + Math.cos(th) * R;
        const z = plot.z + Math.sin(th) * R;
        ring.push(new THREE.Vector3(x, this.heightAt(x, z) + 0.3, z));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(ring);
      const mat = new THREE.LineBasicMaterial({ color: 0xd92b2b, transparent: true, opacity: 0.8, depthTest: false });
      const line = new THREE.Line(geo, mat);
      line.name = 'navmesh.debug.keepout';
      line.frustumCulled = false;
      group.add(line);
    }

    scene.add(group);
    this._debugGroup = group;
    Log.debug(`Navmesh debug: ${segs} graph segments, ${this.patrolRoutes.length} routes drawn.`);
  }

  _teardownDebug(keepScene = false) {
    const g = this._debugGroup;
    if (g) {
      g.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material.dispose();
        }
      });
      g.parent?.remove(g);
    }
    this._debugGroup = null;
    if (!keepScene) this._debugScene = null;
  }

  // ===============================================================================================
  // TEARDOWN
  // ===============================================================================================

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.ready = false;

    for (const off of this._unsub) { try { off(); } catch { /* already gone */ } }
    this._unsub.length = 0;

    this._teardownDebug();

    // Fail any outstanding requests rather than leaving promises pending forever.
    if (this._activeRequest) { this._deliverEmpty(this._activeRequest); }
    while (this._queue.length) this._deliverEmpty(this._queue.shift());
    this._reqPool.length = 0;

    this._cache.clear();
    this._mods.length = 0;
    this._modByName.clear();
    this.anchors.clear();
    this._anchorOverrides.clear();
    this.patrolRoutes.length = 0;
    this.rallyPoints.length = 0;
    this.bridges.length = 0;
    this._lights.length = 0;
    this._vecPool.length = 0;

    this._flags = null; this._cost = null; this._lit = null;
    this._region = null; this._height = null; this._build = null;
    this._regionStack = null; this._sync = null; this._async = null;
    this._terrain = null; this._physics = null; this._props = null;
    this._cabinSite = null; this._script = null;
  }
}

// Statics so other modules can read the vocabulary without importing the names separately.
Navmesh.TUNING = NAV_TUNING;
Navmesh.FLAG = NAV_FLAG;

export default Navmesh;
