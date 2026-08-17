/**
 * Terrain — heightfield, chunked LOD mesh, blended ground material, and the collision /
 * sampling API that Physics, Navmesh, Forest, Props and CabinSite all depend on.
 *
 * OWNER: World agent. See ARCHITECTURE.md §9 and ART_DIRECTION.md §5 / §10 (traps 1, 3, 5, 15, 19).
 *
 * GENERATION PIPELINE (deterministic from ctx.settings.seed)
 *   1. Macro pass @4 m  — domain-warped fbm + analytic landmarks (lake basin, shoreline,
 *      cuesta ridge, granite outcrops, southward rise, map rim).
 *   2. Full-res pass @1 m — Catmull-Rom upsample of the macro field + 3 octaves of detail.
 *   3. HYDRAULIC EROSION — 26 000 droplets, radius-2 deposition brush, sediment capacity model.
 *      Byproduct: a per-cell water-flux (drainage) field used later for mud / moss / puddles.
 *   4. THERMAL SLUMP — 4 passes, bedrock-aware talus angle (soil 45°, rock 63°), so the ridge
 *      keeps its scarp while the soil mantle relaxes into believable drainage.
 *   5. CARVING — camp clearing, build pad, stream channel, path network. After erosion so the
 *      flat things stay flat.
 *   6. CLASSIFICATION — surface type, wetness, forest density, sky exposure, vertex AO.
 *
 * The heightmap is a cached Float32Array. heightAt() never evaluates noise.
 */
import * as THREE from 'three';
import { Log } from '../core/Log.js';
import { Rand, hashInt } from '../core/Rand.js';

// ---------------------------------------------------------------------------------------------
// module-scope scratch — ARCHITECTURE.md §12: no allocation in update()
// ---------------------------------------------------------------------------------------------
const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
/** Constant. Never used as an out-parameter — see _normalScratch. */
const _fallbackNormal = new THREE.Vector3(0, 1, 0);
/** Where normalAt() writes when the caller passes no `out`. */
const _normalScratch = new THREE.Vector3(0, 1, 0);
/** Reusable descriptor so getSpawnCandidates() only allocates for points it actually keeps. */
const _infoScratch = {
  x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, slope: 0,
  surface: 'needles', surfaceId: 0, wet: 0, exposure: 1,
  density: 0, flow: 0, path: 0, water: false,
};

/** Canonical surface ids. surfaceAt() returns one of these strings. */
export const SURFACES = ['needles', 'mud', 'moss', 'granite', 'water', 'gravel'];

/**
 * Shared-library material names Terrain will take its ground constants from, best first.
 * These are the real keys in src/render/Materials.js — not guesses.
 */
const GROUND_MATERIAL_NAMES = ['ground-needles', 'ground-moss', 'ground-mud', 'granite'];
const S_NEEDLES = 0, S_MUD = 1, S_MOSS = 2, S_GRANITE = 3, S_WATER = 4, S_GRAVEL = 5;

/**
 * Every tunable in one object (GAME_DESIGN.md §12). Values that affect *gameplay outcomes*
 * (heights, extents, landmark positions) are deliberately NOT routed through settings.tier().
 */
export const TERRAIN_TUNING = {
  worldSize: 512,          // metres, square
  cell: 1.0,               // heightmap spacing, metres
  macroCell: 4.0,          // macro pass spacing
  waterLevel: 0.0,

  // Meshing is a 3-level quadtree: 128 m / 64 m / 32 m nodes, each meshed as a 32x32 quad grid
  // (so the world-space triangle size is 4 m / 2 m / 1 m). A node is drawn when the camera is
  // at least `lodRadii[level]` metres from its AABB, otherwise it recurses into its children.
  // This tiles the plane exactly — no holes, no overlap — and keeps triangles roughly constant
  // in screen space. Skirts hide the seams between levels.
  quadDiv: 32,
  levels: [
    { span: 128, skirt: 4.0 },
    { span: 64, skirt: 2.0 },
    { span: 32, skirt: 1.0 },
  ],
  // Draw-coarse threshold for the 128 m and 64 m levels. Measured, not guessed: a 3000-pose
  // sweep (tools note — see the headless cull harness) peaks at 37 draw calls at 16:9/72 deg
  // and 39 at 90 deg / 21:9, against the < 40 terrain budget. Raising these to 112/54 peaks at
  // 45 and blows it. 1 m triangles still reach 40 m, which is past the fog wall at night.
  lodRadii: [80, 40],

  // Landmarks (world XZ). North is -Z. -Z is forward per ARCHITECTURE.md §2.
  camp: { x: 124, z: -18, rx: 46, rz: 38, grade: 0.012 },
  buildPad: { x: -140, z: 128, half: 12, apron: 7.5 },
  latrine: { x: 96, z: 34 },
  dock: { x: 106, z: -72 },

  erosion: {
    droplets: 26000, maxSteps: 42, radius: 2,
    inertia: 0.045, capacity: 3.4, minCapacity: 0.012,
    deposit: 0.28, erode: 0.28, gravity: 4.0, evaporate: 0.018,
  },
  thermal: { passes: 4, soilTalus: 1.00, rockTalus: 1.96, rate: 0.42 },

  puddles: { max: 56, minSep: 7.0, minRadius: 0.50, maxRadius: 2.20, depthWindow: 0.16 },
  microSink: 0.035,        // max downward-only vertex-shader micro-displacement at LOD0 (m)
};

const T = TERRAIN_TUNING;

// ---------------------------------------------------------------------------------------------
// Fast deterministic noise. Seeded from ctx.settings.seed via Rand.hashInt so the world is
// reproducible; kept local because Rand.valueNoise2's hash2() is ~3x the cost and this runs
// ~2 million times during generation.
// ---------------------------------------------------------------------------------------------
const INV_U32 = 2.3283064365386963e-10;

function ihash(x, y, s) {
  let n = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x85ebca6b) ^ Math.imul(s | 0, 0x9e3779b1);
  n ^= n >>> 15; n = Math.imul(n, 0x2c1b3c6d);
  n ^= n >>> 13; n = Math.imul(n, 0x297a2d39);
  n ^= n >>> 16;
  return (n >>> 0) * INV_U32;
}

/** Value noise, smoothstep-interpolated. */
function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = ihash(xi, yi, s), b = ihash(xi + 1, yi, s);
  const c = ihash(xi, yi + 1, s), d = ihash(xi + 1, yi + 1, s);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}

function fbm(x, y, oct, s, gain = 0.5, lac = 2.0) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x * freq, y * freq, s + i * 131);
    norm += amp; amp *= gain; freq *= lac;
  }
  return sum / norm;
}

/** Ridged multifractal — sharp crests, used for the rock spine and for crack textures. */
function ridged(x, y, oct, s) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(vnoise(x * freq, y * freq, s + i * 977) * 2 - 1);
    sum += amp * n * n;
    norm += amp; amp *= 0.5; freq *= 2;
  }
  return sum / norm;
}

/** Tiling value noise (period in lattice units) — for seamless textures. */
function pnoise(x, y, per, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const p = Math.max(1, per | 0);
  const x0 = ((xi % p) + p) % p, x1 = (x0 + 1) % p;
  const y0 = ((yi % p) + p) % p, y1 = (y0 + 1) % p;
  const a = ihash(x0, y0, s), b = ihash(x1, y0, s);
  const c = ihash(x0, y1, s), d = ihash(x1, y1, s);
  const t = a + (b - a) * u;
  return t + ((c + (d - c) * u) - t) * v;
}

function pfbm(x, y, oct, per, s, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * pnoise(x * freq, y * freq, per * freq, s + i * 313);
    norm += amp; amp *= gain; freq *= 2;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------------------------
// small maths helpers
// ---------------------------------------------------------------------------------------------
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}
const lerp = (a, b, t) => a + (b - a) * t;

/** Catmull-Rom through 4 samples. */
function cr(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}


// ---------------------------------------------------------------------------------------------
// Landmark polylines. Hand-authored: the map is designed, not noised (see brief / GAME_DESIGN §4).
// ---------------------------------------------------------------------------------------------

/** The cuesta ridge: gentle east dip-slope (from camp), steep west scarp (over the build site). */
const RIDGE_NODES = [
  // z,    x,   crestAmp
  [-150, -64, 1.0],
  [-120, -60, 6.0],
  [-95, -58, 12.5],
  [-60, -54, 18.0],
  [-20, -50, 21.5],
  [20, -48, 22.5],
  [55, -52, 21.0],
  [96, -56, 22.0],
  [130, -58, 19.5],
  [170, -62, 21.0],
  [215, -70, 18.5],
  [262, -80, 15.0],
];

/**
 * The stream. Explicit, monotonically-descending bed heights so water never runs uphill.
 * It crosses the ridge at the saddle (-58, 96) — that saddle IS "the draw".
 */
const STREAM_NODES = [
  [-6, 214, 26.0],
  [-24, 176, 22.0],
  [-40, 140, 18.0],
  [-52, 112, 15.0],
  [-58, 96, 13.6],   // the draw. Log crossing here.
  [-66, 74, 11.5],
  [-74, 46, 9.2],
  [-82, 18, 7.2],
  [-88, -14, 5.4],
  [-94, -50, 3.6],
  [-100, -88, 1.8],
  [-106, -126, 0.3],
  [-110, -152, -1.2],
];

/** Worn path network. width/depth in metres; `trace` paths are fainter (the monster's own). */
const PATHS = [
  { id: 'camp-shore', width: 2.3, depth: 0.17, pts: [[124, -18], [118, -40], [112, -58], [106, -72]] },
  { id: 'camp-latrine', width: 1.7, depth: 0.13, pts: [[124, -18], [114, 6], [104, 22], [96, 34]] },
  { id: 'camp-draw', width: 1.9, depth: 0.15, pts: [[124, -18], [78, -6], [34, 16], [-6, 46], [-38, 76], [-58, 96]] },
  { id: 'shore-trail', width: 1.5, depth: 0.11, pts: [[106, -72], [60, -84], [10, -96], [-34, -112], [-58, -124]] },
  { id: 'draw-plot', width: 1.05, depth: 0.08, pts: [[-58, 96], [-84, 110], [-112, 122], [-140, 128]] },
];

// =============================================================================================

export class Terrain {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx?.bus ?? null;

    const size = T.worldSize;
    this.size = size;
    this.cell = T.cell;
    this.n = Math.round(size / T.cell) + 1;          // 513
    this.x0 = -size / 2;
    this.z0 = -size / 2;
    this.invCell = 1 / T.cell;

    // ---- public landmarks (other systems read these; populated in init()) ----
    this.waterLevel = T.waterLevel;
    // `bounds` IS a THREE.Box3 — Physics/Navmesh/Forest hand it straight to intersectsBox() —
    // with the flat scalars hung off it so `bounds.minX` and `bounds.box` both keep working.
    // min.y / max.y are tightened to the real height range at the end of generation.
    this.bounds = new THREE.Box3(
      new THREE.Vector3(this.x0, -12, this.z0),
      new THREE.Vector3(this.x0 + size, 48, this.z0 + size),
    );
    this.bounds.minX = this.x0; this.bounds.maxX = this.x0 + size;
    this.bounds.minZ = this.z0; this.bounds.maxZ = this.z0 + size;
    this.bounds.minY = -12; this.bounds.maxY = 48;
    this.bounds.size = size;
    this.bounds.box = this.bounds;
    this.campCenter = new THREE.Vector3(T.camp.x, 0, T.camp.z);
    this.buildSiteCenter = new THREE.Vector3(T.buildPad.x, 0, T.buildPad.z);
    this.latrine = new THREE.Vector3(T.latrine.x, 0, T.latrine.z);
    this.dock = new THREE.Vector3(T.dock.x, 0, T.dock.z);
    this.ridgeLine = [];
    this.streamPath = [];
    this.logCrossing = null;
    this.paths = [];
    this.puddles = [];
    this.buildPadHalf = T.buildPad.half;
    this.campRadius = Math.max(T.camp.rx, T.camp.rz);

    // ---- data fields (allocated in init) ----
    this._h = null;          // Float32Array heightmap
    this._surf = null;       // Uint8Array surface ids
    this._wet = null;        // Uint8Array 0..255
    this._dens = null;       // Uint8Array forest density
    this._expo = null;       // Uint8Array sky exposure
    this._flow = null;       // Float32Array drainage flux (normalised 0..1)
    this._rock = null;       // Uint8Array bedrock mask
    this._path = null;       // Uint8Array path influence 0..255

    // ---- scene objects ----
    this.group = null;
    this.material = null;
    this.waterMaterial = null;
    this._nodes = [];
    this._sharedIndex = null;
    this._radii = TERRAIN_TUNING.lodRadii;
    this._drawn = 0;
    this._disposables = [];
    this._ownMaterial = true;

    this._uniforms = null;
    this._rainTarget = 0.15;
    this._rain = 0.15;
    this._windTarget = 0.2;
    this._wind = 0.2;
    this._time = 0;
    this._fogResolved = false;
    this._unsub = [];

    this.ready = false;
    this.stats = { chunksDrawn: 0, drawCalls: 0, genMs: 0 };
  }

  // ===========================================================================================
  // init
  // ===========================================================================================
  async init() {
    const t0 = performance.now();
    const seed = (this.ctx?.settings?.get?.('seed') ?? 0x51a5cab) | 0;
    this._seed = hashInt(seed) | 0;
    this._rand = new Rand(seed ^ 0x7e44a1);

    try {
      this._buildHeightfield();
      this._erode();
      this._thermalSlump();
      this._carveLandmarks();
      this._classify();
      this._findPuddles();
      this._resolveLandmarkHeights();
    } catch (e) {
      Log.error('Terrain: generation failed, falling back to a flat field.', e);
      if (!this._h) this._h = new Float32Array(this.n * this.n);
      if (!this._surf) this._surf = new Uint8Array(this.n * this.n).fill(S_NEEDLES);
      if (!this._wet) this._wet = new Uint8Array(this.n * this.n);
      if (!this._dens) this._dens = new Uint8Array(this.n * this.n).fill(160);
      if (!this._expo) this._expo = new Uint8Array(this.n * this.n).fill(200);
      if (!this._flow) this._flow = new Float32Array(this.n * this.n);
      if (!this._rock) this._rock = new Uint8Array(this.n * this.n);
      if (!this._path) this._path = new Uint8Array(this.n * this.n);
    }

    try {
      this._buildTextures();
      this._buildMaterial();
      this._buildMeshes();
    } catch (e) {
      Log.error('Terrain: mesh build failed — queries still work.', e);
    }

    this._bindEvents();
    this.ready = true;
    this.stats.genMs = performance.now() - t0;
    Log.debug(`Terrain: ${this.n}x${this.n} field, ${this._nodes.reduce((a, l) => a + l.list.length, 0)} nodes, ` +
      `${this.puddles.length} puddles, ${this.stats.genMs.toFixed(0)} ms`);
  }

  // ===========================================================================================
  // 1–2. HEIGHTFIELD
  // ===========================================================================================

  /** Shoreline position (world z) for a given world x. North is -Z; water is z < shoreZ. */
  _shoreZ(x) {
    const s = this._seed;
    return -118
      + 26 * Math.sin(x * 0.0102 + 0.7)
      + 22 * (fbm(x * 0.0055, 91.3, 3, s + 41) - 0.5)
      - 38 * Math.exp(-Math.pow((x + 60) / 27, 2))     // granite headland, ridge's north toe
      - 20 * Math.exp(-Math.pow((x + 6) / 17, 2))      // second, smaller outcrop
      + 27 * Math.exp(-Math.pow((x - 118) / 42, 2));   // the camp bay
  }

  /** Ridge crest amplitude and centreline x at a given z. */
  _ridgeAt(z, out) {
    const N = RIDGE_NODES;
    if (z <= N[0][0]) { out.x = N[0][1]; out.amp = N[0][2]; return; }
    if (z >= N[N.length - 1][0]) { out.x = N[N.length - 1][1]; out.amp = N[N.length - 1][2]; return; }
    for (let i = 0; i < N.length - 1; i++) {
      if (z >= N[i][0] && z <= N[i + 1][0]) {
        const t = (z - N[i][0]) / (N[i + 1][0] - N[i][0]);
        const st = t * t * (3 - 2 * t);
        out.x = lerp(N[i][1], N[i + 1][1], st);
        out.amp = lerp(N[i][2], N[i + 1][2], st);
        return;
      }
    }
    out.x = -55; out.amp = 18;
  }

  /**
   * Macro field @4 m: everything structural. Domain-warped fbm plus the analytic landmarks.
   * Also fills the bedrock mask (used by the thermal pass so rock keeps its scarp).
   */
  _macro(x, z, rk) {
    const s = this._seed;

    // --- domain-warped rolling relief -------------------------------------------------------
    const wx = fbm(x * 0.0041 + 13.7, z * 0.0041 - 5.1, 3, s + 7) - 0.5;
    const wz = fbm(x * 0.0041 - 8.3, z * 0.0041 + 21.9, 3, s + 8) - 0.5;
    const px = x * 0.0026 + wx * 0.62;
    const pz = z * 0.0026 + wz * 0.62;
    let h = 18.0 * (fbm(px, pz, 5, s + 3) - 0.44);

    // --- the bowl: rises south, rims east and west -------------------------------------------
    h += 2.0 + 17.0 * smoothstep(-150, 190, z);
    h += 11.0 * smoothstep(168, 250, Math.abs(x));

    // --- the ridge: asymmetric cuesta ---------------------------------------------------------
    this._ridgeAt(z, _ridgeScratch);
    const rx = _ridgeScratch.x;
    const meander = 9.0 * (fbm(z * 0.011, 4.4, 3, s + 17) - 0.5);
    const dx = x - (rx + meander);
    // steep west scarp (sigma 16), long east dip-slope (sigma 48). abs() matters: a negative
    // base with a fractional exponent is NaN, which would poison the entire west half.
    const sigma = dx < 0 ? 16.0 : 48.0;
    const ridgeProfile = Math.exp(-Math.pow(Math.abs(dx) / sigma, 1.75));
    // ridged noise along the crest so it is a spine, not a sausage
    const spine = 0.72 + 0.46 * ridged(x * 0.014, z * 0.010, 3, s + 29);
    let amp = _ridgeScratch.amp * spine;
    // the draw: a wide gaussian notch through the crest at z = 96
    const notch = Math.exp(-Math.pow((z - 96) / 27, 2));
    amp *= (1 - 0.62 * notch);
    const ridgeTerm = amp * ridgeProfile;
    h += ridgeTerm;

    // bedrock where the ridge core is strong or the slope is a scarp
    let rock = clamp01((ridgeProfile - 0.44) * 2.3) * clamp01(amp / 14);

    // --- lake basin, beach, headland outcrops -------------------------------------------------
    const sz = this._shoreZ(x);
    const sd = z - sz;                    // >0 land, <0 water
    let profile;
    if (sd < 0) {
      profile = -Math.min(11, 0.42 * Math.pow(-sd, 0.78));
    } else {
      profile = 0.135 * Math.pow(sd, 1.05);
    }
    const blend = smoothstep(6, 62, sd);
    h = lerp(profile, h, blend);

    // granite knobs running into the water at the ridge's north toe
    const k1 = 10.5 * Math.exp(-Math.pow((x + 60) / 17, 2) - Math.pow((z + 124) / 23, 2));
    const k2 = 6.0 * Math.exp(-Math.pow((x + 50) / 12, 2) - Math.pow((z + 149) / 15, 2));
    const k3 = 4.2 * Math.exp(-Math.pow((x + 6) / 13, 2) - Math.pow((z + 112) / 17, 2));
    const knobs = k1 + k2 + k3;
    h += knobs;
    rock = Math.max(rock, clamp01(knobs / 4.5));

    if (rk) rk.v = rock;
    return h;
  }

  _buildHeightfield() {
    const n = this.n, size = this.size;
    const mc = T.macroCell;
    const mn = Math.round(size / mc) + 1;           // 129
    const macro = new Float32Array(mn * mn);
    const mrock = new Float32Array(mn * mn);
    const rk = { v: 0 };

    for (let j = 0; j < mn; j++) {
      const z = this.z0 + j * mc;
      for (let i = 0; i < mn; i++) {
        const x = this.x0 + i * mc;
        macro[j * mn + i] = this._macro(x, z, rk);
        mrock[j * mn + i] = rk.v;
      }
    }

    const h = new Float32Array(n * n);
    const rock = new Uint8Array(n * n);
    const s = this._seed;
    const ratio = mc / T.cell;                      // 4

    // _shoreZ() depends only on x — 513 evaluations instead of 263 169.
    const shoreLUT = new Float32Array(n);
    for (let i = 0; i < n; i++) shoreLUT[i] = this._shoreZ(this.x0 + i * T.cell);
    this._shoreLUT = shoreLUT;

    const sampleCR = (arr, fi, fj) => {
      const i1 = Math.floor(fi), j1 = Math.floor(fj);
      const tx = fi - i1, tz = fj - j1;
      const cl = (v) => (v < 0 ? 0 : v > mn - 1 ? mn - 1 : v);
      const rows = _crRows;
      for (let r = 0; r < 4; r++) {
        const jj = cl(j1 - 1 + r) * mn;
        rows[r] = cr(arr[jj + cl(i1 - 1)], arr[jj + cl(i1)], arr[jj + cl(i1 + 1)], arr[jj + cl(i1 + 2)], tx);
      }
      return cr(rows[0], rows[1], rows[2], rows[3], tz);
    };

    for (let j = 0; j < n; j++) {
      const z = this.z0 + j * T.cell;
      const fj = j / ratio;
      for (let i = 0; i < n; i++) {
        const x = this.x0 + i * T.cell;
        const fi = i / ratio;
        let v = sampleCR(macro, fi, fj);

        // Full-res detail. Amplitude tapers into the lake so the bed stays smooth. Sub-metre
        // relief is handled by the vertex shader, so 2 octaves here is the right stopping point.
        const shoreFade = smoothstep(-4, 16, z - shoreLUT[i]);
        const d = (fbm(x * 0.055, z * 0.055, 3, s + 61) - 0.5) * 1.55
          + (vnoise(x * 0.21, z * 0.21, s + 67) - 0.5) * 0.40;
        v += d * (0.35 + 0.65 * shoreFade);

        const idx = j * n + i;
        h[idx] = v;
        rock[idx] = Math.round(clamp01(sampleCR(mrock, fi, fj)) * 255);
      }
    }

    this._h = h;
    this._rock = rock;
  }

  // ===========================================================================================
  // 3. HYDRAULIC EROSION (droplet / sediment-capacity model)
  // ===========================================================================================
  _erode() {
    const n = this.n, h = this._h;
    const E = T.erosion;
    const flow = new Float32Array(n * n);
    const rand = new Rand(this._seed ^ 0x104d);

    // deposition brush (radius 2, gaussian-ish), precomputed offsets + weights
    const R = E.radius;
    const bo = [], bw = [];
    let bwSum = 0;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > R * R + 0.001) continue;
        const w = 1 - Math.sqrt(d2) / (R + 1);
        bo.push(dz * n + dx); bw.push(w); bwSum += w;
      }
    }
    for (let i = 0; i < bw.length; i++) bw[i] /= bwSum;
    const bn = bo.length;

    const wl = this.waterLevel;
    const maxIdx = n - 3;

    for (let d = 0; d < E.droplets; d++) {
      let px = 2 + rand.next() * (maxIdx - 2);
      let pz = 2 + rand.next() * (maxIdx - 2);

      // don't erode the lake bed — it is a depositional basin, not a hillside
      if (this._bilinear(h, px, pz) < wl + 0.4) continue;

      let dirX = 0, dirZ = 0;
      let speed = 1, water = 1, sed = 0;

      for (let step = 0; step < E.maxSteps; step++) {
        const ix = px | 0, iz = pz | 0;
        const fx = px - ix, fz = pz - iz;
        const i0 = iz * n + ix;
        const h00 = h[i0], h10 = h[i0 + 1], h01 = h[i0 + n], h11 = h[i0 + n + 1];

        const gx = (h10 - h00) * (1 - fz) + (h11 - h01) * fz;
        const gz = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
        const hOld = (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;

        dirX = dirX * E.inertia - gx * (1 - E.inertia);
        dirZ = dirZ * E.inertia - gz * (1 - E.inertia);
        const len = Math.hypot(dirX, dirZ);
        if (len < 1e-6) break;
        dirX /= len; dirZ /= len;

        px += dirX; pz += dirZ;
        if (px < 2 || pz < 2 || px > maxIdx || pz > maxIdx) break;

        const hNew = this._bilinear(h, px, pz);
        if (hNew < wl + 0.15) { // reached the lake: dump the load and stop
          const di = (pz | 0) * n + (px | 0);
          h[di] += sed * 0.5;
          break;
        }
        const dh = hNew - hOld;

        const cap = Math.max(-dh * speed * water * E.capacity, E.minCapacity);

        if (sed > cap || dh > 0) {
          const amount = dh > 0 ? Math.min(dh, sed) : (sed - cap) * E.deposit;
          sed -= amount;
          // bilinear deposit at the old position
          h[i0] += amount * (1 - fx) * (1 - fz);
          h[i0 + 1] += amount * fx * (1 - fz);
          h[i0 + n] += amount * (1 - fx) * fz;
          h[i0 + n + 1] += amount * fx * fz;
        } else {
          const amount = Math.min((cap - sed) * E.erode, -dh);
          // soften erosion on bedrock — rock resists
          const soft = 1 - 0.72 * (this._rock[i0] / 255);
          const a = amount * soft;
          for (let b = 0; b < bn; b++) {
            const bi = i0 + bo[b];
            if (bi < 0 || bi >= h.length) continue;
            const take = a * bw[b];
            h[bi] -= take;
          }
          sed += a;
        }

        speed = Math.sqrt(Math.max(0, speed * speed - dh * E.gravity));
        water *= (1 - E.evaporate);
        flow[i0] += water;
      }
    }

    // normalise flux with a soft knee so a few torrents don't crush the rest
    let maxF = 1e-6;
    for (let i = 0; i < flow.length; i++) if (flow[i] > maxF) maxF = flow[i];
    const k = 1 / Math.max(1e-6, maxF * 0.16);
    for (let i = 0; i < flow.length; i++) flow[i] = clamp01(flow[i] * k);
    // one blur pass so drainage reads as corridors, not pixels
    this._blurF32(flow, 1);
    this._flow = flow;
  }

  // ===========================================================================================
  // 4. THERMAL SLUMP (bedrock-aware talus)
  // ===========================================================================================
  _thermalSlump() {
    const n = this.n, h = this._h, rock = this._rock;
    const P = T.thermal;
    const delta = new Float32Array(n * n);
    const NB = [-1, 1, -n, n, -n - 1, -n + 1, n - 1, n + 1];
    const DIAG = [0, 0, 0, 0, 1, 1, 1, 1];
    const SQ2 = Math.SQRT2;

    for (let pass = 0; pass < P.passes; pass++) {
      delta.fill(0);
      for (let j = 1; j < n - 1; j++) {
        for (let i = 1; i < n - 1; i++) {
          const idx = j * n + i;
          const talus = lerp(P.soilTalus, P.rockTalus, rock[idx] / 255);
          const hi = h[idx];
          let total = 0;
          for (let b = 0; b < 8; b++) {
            const t = talus * (DIAG[b] ? SQ2 : 1);
            const diff = hi - h[idx + NB[b]];
            if (diff > t) total += diff - t;
          }
          if (total <= 0) continue;
          const scale = P.rate * 0.5;
          for (let b = 0; b < 8; b++) {
            const t = talus * (DIAG[b] ? SQ2 : 1);
            const diff = hi - h[idx + NB[b]];
            if (diff > t) {
              const give = (diff - t) * scale;
              delta[idx] -= give;
              delta[idx + NB[b]] += give;
            }
          }
        }
      }
      for (let i = 0; i < h.length; i++) h[i] += delta[i];
    }
  }

  // ---- small field utilities -----------------------------------------------------------------
  _bilinear(arr, fx, fz) {
    const n = this.n;
    const ix = fx | 0, iz = fz | 0;
    const tx = fx - ix, tz = fz - iz;
    const i0 = iz * n + ix;
    const a = arr[i0] + (arr[i0 + 1] - arr[i0]) * tx;
    const b = arr[i0 + n] + (arr[i0 + n + 1] - arr[i0 + n]) * tx;
    return a + (b - a) * tz;
  }

  _blurF32(arr, radius) {
    const n = this.n;
    const tmp = new Float32Array(arr.length);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let s = 0, c = 0;
        for (let k = -radius; k <= radius; k++) {
          const ii = i + k;
          if (ii < 0 || ii >= n) continue;
          s += arr[j * n + ii]; c++;
        }
        tmp[j * n + i] = s / c;
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let s = 0, c = 0;
        for (let k = -radius; k <= radius; k++) {
          const jj = j + k;
          if (jj < 0 || jj >= n) continue;
          s += tmp[jj * n + i]; c++;
        }
        arr[j * n + i] = s / c;
      }
    }
  }

  // ===========================================================================================
  // 5. CARVING — the human/authored layer. Runs AFTER erosion so flat things stay flat.
  // ===========================================================================================

  /** Robust mean height over a rect — used to auto-level pads to the ground they sit on. */
  _robustLevel(cx, cz, halfX, halfZ) {
    const samples = [];
    const step = Math.max(1, Math.floor(Math.min(halfX, halfZ) / 6));
    for (let z = cz - halfZ; z <= cz + halfZ; z += step) {
      for (let x = cx - halfX; x <= cx + halfX; x += step) {
        samples.push(this.heightAt(x, z));
      }
    }
    if (!samples.length) return 0;
    samples.sort((a, b) => a - b);
    const lo = Math.floor(samples.length * 0.2);
    const hi = Math.ceil(samples.length * 0.8);
    let s = 0;
    for (let i = lo; i < hi; i++) s += samples[i];
    return s / Math.max(1, hi - lo);
  }

  _carveLandmarks() {
    const n = this.n, h = this._h, cellsPerM = 1 / T.cell;
    const pathMask = new Uint8Array(n * n);
    const flatMask = new Uint8Array(n * n);   // camp + pad, for classification
    const s = this._seed;

    // ---- CAMP: a flattened terrace with a gentle drainage grade toward the lake -------------
    const C = T.camp;
    const campLevel = this._robustLevel(C.x, C.z, C.rx * 0.55, C.rz * 0.55);
    this.campCenter.y = campLevel;

    // ---- BUILD SITE: a 24x24 shelf with a graded apron ---------------------------------------
    const B = T.buildPad;
    const padLevel = this._robustLevel(B.x, B.z, B.half, B.half);
    this.buildSiteCenter.y = padLevel;

    // ---- STREAM: resample the authored polyline to 1 m and carve a valley + channel ----------
    const stream = [];
    for (let i = 0; i < STREAM_NODES.length - 1; i++) {
      const a = STREAM_NODES[i], b = STREAM_NODES[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(2, Math.round(len));
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        const st = t * t * (3 - 2 * t);
        // lateral meander so the channel is not a ruled line
        const mx = 5.5 * (fbm(lerp(a[1], b[1], t) * 0.045, 3.1, 3, s + 88) - 0.5);
        stream.push({
          x: lerp(a[0], b[0], st) + mx,
          z: lerp(a[1], b[1], st),
          y: lerp(a[2], b[2], st),
        });
      }
    }
    stream.push({ x: STREAM_NODES.at(-1)[0], z: STREAM_NODES.at(-1)[1], y: STREAM_NODES.at(-1)[2] });
    this.streamPath = stream.map((p) => new THREE.Vector3(p.x, p.y, p.z));

    // Spatial bucket for the stream. Cell size == query radius so a query touches 9 buckets,
    // and a bbox so the other 80% of the map never runs the query at all.
    const streamGrid = this._bucketPolyline(stream, 34);
    const sBox = {
      minX: this._minOf(stream, 'x') - 40, maxX: this._maxOf(stream, 'x') + 40,
      minZ: this._minOf(stream, 'z') - 40, maxZ: this._maxOf(stream, 'z') + 40,
    };

    // ---- write pass -------------------------------------------------------------------------
    for (let j = 0; j < n; j++) {
      const z = this.z0 + j * T.cell;
      for (let i = 0; i < n; i++) {
        const x = this.x0 + i * T.cell;
        const idx = j * n + i;
        let hv = h[idx];

        // --- stream valley + channel ---
        const inStreamBox = x > sBox.minX && x < sBox.maxX && z > sBox.minZ && z < sBox.maxZ;
        const sp = inStreamBox ? this._nearestBucketed(streamGrid, x, z, 34) : null;
        if (sp) {
          const d = Math.sqrt(sp.d2);
          const bedY = sp.p.y;
          // wide U valley: pulls the terrain down toward the bed over ~34 m
          const valleyW = 34 * (0.75 + 0.5 * fbm(z * 0.02, 7.7, 3, s + 91));
          const vw = 1 - smoothstep(valleyW * 0.25, valleyW, d);
          if (vw > 0) {
            const valleyTarget = bedY + 1.1 * Math.pow(d / valleyW * 3.2, 1.55) * 4.0;
            hv = lerp(hv, Math.min(hv, valleyTarget), vw * 0.82);
          }
          // inner channel: 2.6 m half-width, 1.15 m deep, flat bed
          const cw = 1 - smoothstep(1.6, 3.4, d);
          if (cw > 0) hv = lerp(hv, bedY - 0.55, cw);
          // graded banks at the crossing so the stream is fordable at the draw
          const dCross = Math.hypot(x + 58, z - 96);
          if (dCross < 14) {
            const cwx = 1 - smoothstep(6, 14, dCross);
            hv = lerp(hv, Math.max(hv, bedY - 0.18), cwx * 0.6);
          }
        }

        // --- camp clearing ---
        const cdx = (x - C.x) / C.rx, cdz = (z - C.z) / C.rz;
        const cr2 = Math.sqrt(cdx * cdx + cdz * cdz)
          + 0.12 * (fbm(x * 0.03, z * 0.03, 3, s + 12) - 0.5);
        if (cr2 < 1.25) {
          const w = 1 - smoothstep(0.58, 1.22, cr2);
          const target = campLevel + C.grade * (z - C.z);
          hv = lerp(hv, target, w);
          if (w > 0.35) flatMask[idx] = Math.max(flatMask[idx], Math.round(w * 255));
        }

        // --- build pad: hard flat 24x24 core, graded apron ---
        const bdx = Math.abs(x - B.x), bdz = Math.abs(z - B.z);
        const cheb = Math.max(bdx, bdz);
        if (cheb < B.half + B.apron) {
          const w = 1 - smoothstep(B.half, B.half + B.apron, cheb);
          hv = lerp(hv, padLevel, w * w * (3 - 2 * w));
          if (cheb <= B.half) hv = padLevel;
          if (w > 0.3) flatMask[idx] = Math.max(flatMask[idx], Math.round(w * 255));
        }

        h[idx] = hv;
      }
    }

    // ---- PATHS: carve + paint. Second pass so they follow the already-carved ground ----------
    this.paths = [];
    for (const def of PATHS) {
      const pts = this._resamplePath(def.pts, 1.0);
      this.paths.push({ id: def.id, width: def.width, points: pts.map((p) => new THREE.Vector3(p.x, 0, p.z)) });
      const grid = this._bucketPolyline(pts, 12);
      const reach = def.width * 2.6;
      const minX = Math.max(0, Math.floor((this._minOf(pts, 'x') - reach - this.x0) * cellsPerM));
      const maxX = Math.min(n - 1, Math.ceil((this._maxOf(pts, 'x') + reach - this.x0) * cellsPerM));
      const minZ = Math.max(0, Math.floor((this._minOf(pts, 'z') - reach - this.z0) * cellsPerM));
      const maxZ = Math.min(n - 1, Math.ceil((this._maxOf(pts, 'z') + reach - this.z0) * cellsPerM));

      for (let j = minZ; j <= maxZ; j++) {
        const z = this.z0 + j * T.cell;
        for (let i = minX; i <= maxX; i++) {
          const x = this.x0 + i * T.cell;
          const near = this._nearestBucketed(grid, x, z, reach);
          if (!near) continue;
          const d = Math.sqrt(near.d2)
            + 0.42 * def.width * (fbm(x * 0.16, z * 0.16, 2, s + 55) - 0.5);
          const idx = j * n + i;
          // tread: compacted, slightly hollowed, cambered
          const tread = 1 - smoothstep(def.width * 0.35, def.width * 0.9, d);
          if (tread > 0) {
            // flatten laterally toward the centreline height, then sink
            const cH = this.heightAt(near.p.x, near.p.z);
            h[idx] = lerp(h[idx], cH, tread * 0.55) - def.depth * tread;
          }
          const infl = 1 - smoothstep(def.width * 0.8, reach, d);
          if (infl > 0) pathMask[idx] = Math.max(pathMask[idx], Math.round(infl * 255));
        }
      }
    }

    this._path = pathMask;
    this._flat = flatMask;

    // a light 1-cell smooth on carved regions kills the stair-stepping the carve introduces
    this._smoothMasked(pathMask, flatMask);

    // Re-assert the build plot last: BuildSystem snaps parts to a grid on this pad and it must
    // be dead flat, not "flat then smoothed by 7 cm".
    const pi0 = Math.max(0, Math.floor((B.x - B.half - this.x0) * cellsPerM));
    const pi1 = Math.min(n - 1, Math.ceil((B.x + B.half - this.x0) * cellsPerM));
    const pj0 = Math.max(0, Math.floor((B.z - B.half - this.z0) * cellsPerM));
    const pj1 = Math.min(n - 1, Math.ceil((B.z + B.half - this.z0) * cellsPerM));
    for (let j = pj0; j <= pj1; j++) {
      for (let i = pi0; i <= pi1; i++) h[j * n + i] = padLevel;
    }
  }

  _minOf(pts, k) { let m = Infinity; for (const p of pts) if (p[k] < m) m = p[k]; return m; }
  _maxOf(pts, k) { let m = -Infinity; for (const p of pts) if (p[k] > m) m = p[k]; return m; }

  /** Catmull-Rom resample of a control polyline to roughly `step` metres. */
  _resamplePath(ctrl, step) {
    const out = [];
    const P = ctrl.map((p) => ({ x: p[0], z: p[1] }));
    const at = (i) => P[clamp(i, 0, P.length - 1)];
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      const len = Math.hypot(p2.x - p1.x, p2.z - p1.z);
      const steps = Math.max(2, Math.round(len / step));
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        out.push({ x: cr(p0.x, p1.x, p2.x, p3.x, t), z: cr(p0.z, p1.z, p2.z, p3.z, t) });
      }
    }
    out.push({ x: P.at(-1).x, z: P.at(-1).z });
    return out;
  }

  /** Bucket a polyline into a coarse hash grid so nearest-point queries are cheap. */
  _bucketPolyline(pts, cellM) {
    const map = new Map();
    for (const p of pts) {
      const gx = Math.floor(p.x / cellM), gz = Math.floor(p.z / cellM);
      const key = gx * 100003 + gz;
      let list = map.get(key);
      if (!list) { list = []; map.set(key, list); }
      list.push(p);
    }
    return { map, cellM };
  }

  _nearestBucketed(grid, x, z, maxDist) {
    const { map, cellM } = grid;
    const gx = Math.floor(x / cellM), gz = Math.floor(z / cellM);
    const r = Math.max(1, Math.ceil(maxDist / cellM));
    let best = null, bd2 = maxDist * maxDist;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const list = map.get((gx + dx) * 100003 + (gz + dz));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const p = list[i];
          const ex = p.x - x, ez = p.z - z;
          const d2 = ex * ex + ez * ez;
          if (d2 < bd2) { bd2 = d2; best = p; }
        }
      }
    }
    return best ? { p: best, d2: bd2 } : null;
  }

  /** 3x3 smooth, weighted by the union of the supplied masks. */
  _smoothMasked(...masks) {
    const n = this.n, h = this._h;
    const src = Float32Array.from(h);
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const idx = j * n + i;
        let w = 0;
        for (const m of masks) if (m[idx] > w) w = m[idx];
        if (w < 8) continue;
        const a = (src[idx - n - 1] + src[idx - n] + src[idx - n + 1]
          + src[idx - 1] + src[idx] + src[idx + 1]
          + src[idx + n - 1] + src[idx + n] + src[idx + n + 1]) / 9;
        h[idx] = lerp(src[idx], a, (w / 255) * 0.55);
      }
    }
  }

  // ===========================================================================================
  // 6. CLASSIFICATION — surface type, wetness, forest density, sky exposure
  // ===========================================================================================
  _classify() {
    const n = this.n, h = this._h, flow = this._flow, rock = this._rock;
    const pathM = this._path, flatM = this._flat ?? new Uint8Array(n * n);
    const surf = new Uint8Array(n * n);
    const wet = new Uint8Array(n * n);
    const dens = new Uint8Array(n * n);
    const expo = new Uint8Array(n * n);
    const s = this._seed;
    const wl = this.waterLevel;
    const inv2c = 1 / (2 * T.cell);

    // These three noise fields have 11 m - 139 m wavelengths, so evaluating them per 1 m cell
    // is 2.4 million wasted noise lookups. Bake them coarse and interpolate.
    const jn = ((n - 1) >> 1) + 1;            // 2 m
    const dn = ((n - 1) >> 2) + 1;            // 4 m
    const jitF = new Float32Array(jn * jn);
    const wetF = new Float32Array(jn * jn);
    const denF = new Float32Array(dn * dn);
    for (let j = 0; j < jn; j++) {
      const z = this.z0 + j * 2;
      for (let i = 0; i < jn; i++) {
        const x = this.x0 + i * 2;
        jitF[j * jn + i] = fbm(x * 0.07, z * 0.07, 3, s + 201) - 0.5;
        wetF[j * jn + i] = fbm(x * 0.09, z * 0.09, 3, s + 313) - 0.5;
      }
    }
    for (let j = 0; j < dn; j++) {
      const z = this.z0 + j * 4;
      for (let i = 0; i < dn; i++) {
        denF[j * dn + i] = fbm((this.x0 + i * 4) * 0.0072 + 4.3, z * 0.0072 - 2.7, 4, s + 401);
      }
    }
    // ---------------- canopy sky occlusion ----------------
    // A clearing's sky view factor is set by the trees AROUND it, not by the trees standing on
    // it. The old exposure term read only the density at the sample point, so a hole in dense
    // forest — and the camp clearing itself — came out at exposure 1.0 and collected the entire
    // HemisphereLight. The terrain is the only large surface in the game whose normal points
    // straight up at that light, so that single number is why every clearing rendered as the
    // brightest large area in the frame (measured: camp clearing exposure 0.98).
    // Baked on the 4 m grid and sampled bilinearly: 129^2 x 24 taps, once, at load.
    const occF = new Float32Array(dn * dn);
    {
      const RC = [1, 0.7071, 0, -0.7071, -1, -0.7071, 0, 0.7071];
      const RS = [0, 0.7071, 1, 0.7071, 0, -0.7071, -1, -0.7071];
      const RINGS = [1, 2, 4];              // 4 m, 8 m, 16 m out
      const RW = [0.46, 0.34, 0.20];        // a 22 m canopy: near trees subtend far more sky
      for (let j = 0; j < dn; j++) {
        for (let i = 0; i < dn; i++) {
          let acc = 0;
          for (let r = 0; r < 3; r++) {
            const rr = RINGS[r];
            let s = 0;
            for (let a = 0; a < 8; a++) {
              const ii = clamp(i + Math.round(RC[a] * rr), 0, dn - 1);
              const jj = clamp(j + Math.round(RS[a] * rr), 0, dn - 1);
              s += smoothstep(0.34, 0.74, denF[jj * dn + ii]);
            }
            acc += (s * 0.125) * RW[r];
          }
          occF[j * dn + i] = acc;
        }
      }
    }

    const bi = (arr, w, fi, fj) => {
      const ix = fi | 0, iz = fj | 0;
      const tx = fi - ix, tz = fj - iz;
      const i0 = iz * w + ix;
      const a = arr[i0] + (arr[i0 + 1] - arr[i0]) * tx;
      const b = arr[i0 + w] + (arr[i0 + w + 1] - arr[i0 + w]) * tx;
      return a + (b - a) * tz;
    };

    for (let j = 0; j < n; j++) {
      const z = this.z0 + j * T.cell;
      const jm = Math.max(0, j - 1), jp = Math.min(n - 1, j + 1);
      for (let i = 0; i < n; i++) {
        const x = this.x0 + i * T.cell;
        const idx = j * n + i;
        const im = Math.max(0, i - 1), ip = Math.min(n - 1, i + 1);

        const hv = h[idx];
        const gx = (h[j * n + ip] - h[j * n + im]) * inv2c;
        const gz = (h[jp * n + i] - h[jm * n + i]) * inv2c;
        const len = Math.sqrt(gx * gx + gz * gz + 1);
        const ny = 1 / len;
        const nz = -gz / len;                  // north-facing when nz < 0
        const slope01 = Math.acos(clamp(ny, -1, 1)) / (Math.PI * 0.5);

        // concavity (negative laplacian) — hollows collect water and litter
        const lap = (h[j * n + im] + h[j * n + ip] + h[jm * n + i] + h[jp * n + i]) * 0.25 - hv;
        const concave = clamp01(lap * 2.2);

        const depth = wl - hv;
        const overWater = hv - wl;
        const pathW = pathM[idx] / 255;
        const flatW = flatM[idx] / 255;
        const rockW = rock[idx] / 255;
        const flw = flow[idx];

        // ---------------- surface type ----------------
        const fi2 = Math.min(i * 0.5, jn - 1.001), fj2 = Math.min(j * 0.5, jn - 1.001);
        const fi4 = Math.min(i * 0.25, dn - 1.001), fj4 = Math.min(j * 0.25, dn - 1.001);
        const jitter = bi(jitF, jn, fi2, fj2);
        let type;
        if (depth > 0.0) {
          type = S_WATER;
        } else if (pathW > 0.62) {
          type = S_MUD;                                      // a trodden trail beats the beach
        } else if (overWater < 1.70 + jitter * 1.0 && slope01 < 0.34) {
          type = S_GRAVEL;                                   // the beach
        } else if (rockW > 0.55 + jitter * 0.35 || slope01 > 0.40 + jitter * 0.10) {
          type = S_GRANITE;                                  // scarps and outcrops
        } else if (pathW > 0.42 || flatW > 0.55 || flw > 0.70 + jitter * 0.2) {
          type = S_MUD;                                      // trodden ground and drainage
        } else if (
          (nz < -0.13 && slope01 > 0.06 && jitter > -0.20) ||       // north faces
          (overWater < 9 && jitter > -0.05) ||                      // lake margin
          (concave > 0.35 && flw > 0.28)
        ) {
          type = S_MOSS;
        } else {
          type = S_NEEDLES;                                  // duff under the forest
        }
        surf[idx] = type;

        // ---------------- wetness (ART_DIRECTION §5.1 / trap 5) ----------------
        let w = 0;
        w += smoothstep(7, 0, Math.max(0, overWater)) * 0.85;   // shoreline
        w += flw * 0.62;                                        // drainage lines
        w += concave * 0.45;                                    // hollows
        w += pathW * 0.30;                                      // compacted ruts hold water
        w += (type === S_MUD ? 0.18 : 0) + (type === S_MOSS ? 0.22 : 0);
        w -= rockW * 0.12;
        w += bi(wetF, jn, fi2, fj2) * 0.22;
        wet[idx] = Math.round(clamp01(w) * 255);

        // ---------------- forest density (Forest.js reads this) ----------------
        let d = bi(denF, dn, fi4, fj4);
        d = smoothstep(0.34, 0.74, d);
        d *= 1 - smoothstep(0.26, 0.52, slope01);
        d *= smoothstep(0.7, 3.4, overWater);
        d *= 1 - clamp01(flatW * 1.6);
        d *= 1 - clamp01(pathW * 1.35);
        d *= 1 - rockW * 0.85;
        d *= 1 - smoothstep(0.55, 0.95, flw);
        dens[idx] = Math.round(clamp01(d) * 255);

        // ---------------- sky exposure (aExposure per ART_DIRECTION §5.1) ----------------
        let e = 1 - 0.78 * clamp01(d);
        e *= 1 - 0.82 * clamp01(bi(occF, dn, fi4, fj4));   // trees AROUND this point, see above
        e *= 1 - concave * 0.20;
        e = lerp(e, Math.min(1, e + 0.25), clamp01(overWater / 30));  // open ground near the lake
        expo[idx] = Math.round(clamp01(e) * 255);
      }
    }

    this._surf = surf;
    this._wet = wet;
    this._dens = dens;
    this._expo = expo;
  }

  // ===========================================================================================
  // PUDDLES — real local minima, real flat water patches, wetted haloes
  // ===========================================================================================
  _findPuddles() {
    const n = this.n, h = this._h, flow = this._flow, surf = this._surf, wet = this._wet;
    const P = T.puddles;
    const wl = this.waterLevel;
    const found = [];

    for (let j = 6; j < n - 6; j++) {
      const z = this.z0 + j * T.cell;
      for (let i = 6; i < n - 6; i++) {
        const idx = j * n + i;
        const hv = h[idx];
        if (hv < wl + 0.6) continue;                 // in / next to the lake
        if (surf[idx] === S_GRANITE) continue;
        // never inside the flattened camp core or the build plot: those are published
        // landmarks and BuildSystem/Props need dry, predictable ground there
        if (this._flat && this._flat[idx] > 160) continue;
        if (flow[idx] < 0.05 && wet[idx] < 80) continue;

        // strict local minimum over the 8-neighbourhood
        let isMin = true;
        for (let dz = -1; dz <= 1 && isMin; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (h[idx + dz * n + dx] < hv - 1e-5) { isMin = false; break; }
          }
        }
        if (!isMin) continue;

        // grow while the surrounding ring stays a shallow bowl rather than a hillside
        let radius = 0;
        for (let r = 1; r <= 6; r++) {
          let mean = 0, worst = -Infinity;
          for (let a = 0; a < 8; a++) {
            const ang = (a / 8) * Math.PI * 2;
            const sx = clamp(Math.round(i + Math.cos(ang) * r), 0, n - 1);
            const sz = clamp(Math.round(j + Math.sin(ang) * r), 0, n - 1);
            const dd = h[sz * n + sx] - hv;
            mean += dd;
            if (dd > worst) worst = dd;
          }
          mean /= 8;
          // a real depression: the ring is above us on average, and no wall is a cliff
          // an absolute ceiling as well as a per-ring one, so broad flats do not all max out
          if (mean > 0.004 * r && mean < P.depthWindow * r && mean < 0.20
            && worst < P.depthWindow * r * 3.2) radius = r;
          else break;
        }
        if (radius < 1) continue;

        const x = this.x0 + i * T.cell;
        let tooClose = false;
        for (const p of found) {
          if ((p.x - x) ** 2 + (p.z - z) ** 2 < P.minSep * P.minSep) { tooClose = true; break; }
        }
        if (tooClose) continue;

        const jit = ihash(i, j, this._seed ^ 0x5ee);
        const rr = clamp(0.42 + radius * 0.16 * (0.45 + jit * 1.45) + flow[idx] * 0.25,
          P.minRadius, P.maxRadius);
        found.push({ x, z, y: hv + 0.025, r: rr, score: flow[idx] + wet[idx] / 255 + jit * 1.7 });
      }
    }

    found.sort((a, b) => b.score - a.score);
    const chosen = found.slice(0, P.max);

    // wet the surrounding terrain + mark the puddle interior as water for surfaceAt()
    const cellsPerM = 1 / T.cell;
    for (const p of chosen) {
      const rad = p.r * 2.6;
      const i0 = Math.max(0, Math.floor((p.x - rad - this.x0) * cellsPerM));
      const i1 = Math.min(n - 1, Math.ceil((p.x + rad - this.x0) * cellsPerM));
      const j0 = Math.max(0, Math.floor((p.z - rad - this.z0) * cellsPerM));
      const j1 = Math.min(n - 1, Math.ceil((p.z + rad - this.z0) * cellsPerM));
      for (let j = j0; j <= j1; j++) {
        const z = this.z0 + j * T.cell;
        for (let i = i0; i <= i1; i++) {
          const x = this.x0 + i * T.cell;
          const d = Math.hypot(x - p.x, z - p.z);
          const idx = j * n + i;
          const halo = 1 - smoothstep(p.r * 0.7, rad, d);
          if (halo > 0) wet[idx] = Math.max(wet[idx], Math.round(clamp01(0.45 + halo * 0.55) * 255));
          if (d < p.r * 0.82 && h[idx] < p.y + 0.06) surf[idx] = S_WATER;
        }
      }
      this.puddles.push({ position: new THREE.Vector3(p.x, p.y, p.z), radius: p.r });
    }
  }

  /** Resolve the y of every published landmark now that the field is final. */
  _resolveLandmarkHeights() {
    this._tightenBounds();
    this.campCenter.y = this.heightAt(this.campCenter.x, this.campCenter.z);
    this.buildSiteCenter.y = this.heightAt(this.buildSiteCenter.x, this.buildSiteCenter.z);
    this.latrine.y = this.heightAt(this.latrine.x, this.latrine.z);

    // The dock sits ON the waterline, not wherever the control point happened to land.
    // March landward (south, +Z) until we are just clear of the lake.
    let dz = this.dock.z;
    for (let k = 0; k < 200; k++) {
      if (this.heightAt(this.dock.x, dz) > this.waterLevel + 0.12) break;
      dz += 0.5;
    }
    this.dock.z = dz + 1.5;
    this.dock.y = this.heightAt(this.dock.x, this.dock.z);
    /** The waterline directly out from the dock — Props can moor a canoe here. */
    this.shorePoint = new THREE.Vector3(this.dock.x, this.waterLevel, dz - 0.5);

    this.ridgeLine = [];
    const sc = { x: 0, amp: 0 };
    for (let z = -150; z <= 262; z += 12) {
      this._ridgeAt(z, sc);
      // walk east/west a little to find the true local crest
      let bx = sc.x, by = -Infinity;
      for (let dx = -26; dx <= 26; dx += 2) {
        const hh = this.heightAt(sc.x + dx, z);
        if (hh > by) { by = hh; bx = sc.x + dx; }
      }
      this.ridgeLine.push(new THREE.Vector3(bx, by, z));
    }

    for (const p of this.streamPath) p.y = this.heightAt(p.x, p.z);
    for (const path of this.paths) {
      for (const p of path.points) p.y = this.heightAt(p.x, p.z);
    }

    const cx = -58, cz = 96;
    this.logCrossing = {
      position: new THREE.Vector3(cx, this.heightAt(cx, cz) + 0.42, cz),
      direction: new THREE.Vector3(1, 0, 0.28).normalize(),
      length: 7.4,
      radius: 0.34,
    };
  }

  /**
   * Collapse `bounds` onto the height range the generator actually produced, so anything that
   * frustum- or broadphase-tests against it is not testing a 60 m tall slab of empty air.
   */
  _tightenBounds() {
    const h = this._h;
    if (!h || !h.length) return;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < h.length; i++) {
      const v = h[i];
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    lo -= 2; hi += 2;                       // skirts hang below; props stand above
    this.bounds.min.y = lo;
    this.bounds.max.y = hi;
    this.bounds.minY = lo;
    this.bounds.maxY = hi;
  }

  // ===========================================================================================
  // TEXTURES — procedural, zero binary assets, seamless-tiling DataTextures.
  // One 4-channel detail map + one detail normal map, sampled at three world scales
  // (≈26 m / ≈3 m / ≈0.4 m) so the ground has breakup at 10 m AND at 10 cm.
  // ===========================================================================================
  _buildTextures() {
    const st = this.ctx?.settings;
    const dRes = st?.tier?.(128, 192, 256, 256) ?? 256;
    const nRes = st?.tier?.(192, 256, 384, 512) ?? 384;
    const s = this._seed;

    // ---- detail map: r = grain, g = clumps, b = cracks, a = cavity/height -------------------
    const dData = new Uint8Array(dRes * dRes * 4);
    const per = 8;
    for (let j = 0; j < dRes; j++) {
      for (let i = 0; i < dRes; i++) {
        const u = (i / dRes) * per, v = (j / dRes) * per;
        const grain = pfbm(u * 4, v * 4, 4, per * 4, s + 701);
        const clump = pfbm(u, v, 3, per, s + 733, 0.55);
        const crack = 1 - Math.pow(1 - pnoise(u * 2.4, v * 2.4, per * 2.4 | 0, s + 757), 3);
        const cavity = clamp01(pfbm(u * 2, v * 2, 4, per * 2, s + 787) * 0.7 + clump * 0.4);
        const o = (j * dRes + i) * 4;
        dData[o] = Math.round(clamp01(grain) * 255);
        dData[o + 1] = Math.round(clamp01(clump) * 255);
        dData[o + 2] = Math.round(clamp01(crack) * 255);
        dData[o + 3] = Math.round(cavity * 255);
      }
    }
    const texDetail = new THREE.DataTexture(dData, dRes, dRes, THREE.RGBAFormat);
    texDetail.needsUpdate = true;

    // ---- detail normal map: sobel of a two-scale height ------------------------------------
    const hgt = new Float32Array(nRes * nRes);
    const nper = 8;
    for (let j = 0; j < nRes; j++) {
      for (let i = 0; i < nRes; i++) {
        const u = (i / nRes) * nper, v = (j / nRes) * nper;
        hgt[j * nRes + i] =
          0.55 * pfbm(u * 3, v * 3, 3, nper * 3, s + 811)
          + 0.30 * (1 - Math.abs(pnoise(u * 6, v * 6, nper * 6, s + 823) * 2 - 1))
          + 0.15 * pnoise(u * 12, v * 12, nper * 12, s + 829);
      }
    }
    const nData = new Uint8Array(nRes * nRes * 4);
    const wrap = (k) => ((k % nRes) + nRes) % nRes;
    const strength = 5.5;
    for (let j = 0; j < nRes; j++) {
      for (let i = 0; i < nRes; i++) {
        const l = hgt[j * nRes + wrap(i - 1)], r = hgt[j * nRes + wrap(i + 1)];
        const d = hgt[wrap(j - 1) * nRes + i], u2 = hgt[wrap(j + 1) * nRes + i];
        let nx = (l - r) * strength, ny = (d - u2) * strength, nz = 1;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx *= inv; ny *= inv; nz *= inv;
        const o = (j * nRes + i) * 4;
        nData[o] = Math.round((nx * 0.5 + 0.5) * 255);
        nData[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        nData[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
        nData[o + 3] = 255;
      }
    }
    const texNormal = new THREE.DataTexture(nData, nRes, nRes, THREE.RGBAFormat);
    texNormal.needsUpdate = true;

    const maxAniso = this.ctx?.renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;
    const aniso = Math.min(maxAniso, st?.tier?.(1, 2, 8, 16) ?? 8);
    for (const t of [texDetail, texNormal]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = aniso;
      t.colorSpace = THREE.NoColorSpace;   // both are data, not colour
      this._disposables.push(t);
    }

    this.texDetail = texDetail;
    this.texNormal = texNormal;

    this._bindGroundSets();
  }

  /**
   * The REAL baked PBR ground sets, from the shared bakery (`src/render/Textures.js`).
   *
   * Why they are uniforms and not `material.map` / `.normalMap` / `.roughnessMap`: the splat in
   * _patchFragment() replaces `<map_fragment>`, `<roughnessmap_fragment>` and the normal write
   * wholesale, so anything bound to those slots is sampled by chunks that no longer exist — the
   * material would carry three textures it never reads. Binding them as uniforms the splat
   * samples per family is the same bake, the same GPU memory, one owner, and it is the only way
   * to have BOTH a five-way surface splat AND real photographed-looking ground detail.
   *
   * These textures belong to Textures.js. They are NOT pushed to `_disposables` — disposing
   * another system's shared render target would black out every bracket and tree trunk too.
   */
  _bindGroundSets() {
    this._groundSets = null;
    const TX = this.ctx?.systems?.get?.('Textures');
    if (!TX || typeof TX.get !== 'function') {
      Log.once('terrain:tex-none', 'Terrain: no Textures system — ground detail is procedural only.');
      return;
    }
    try {
      const pick = (n) => ((typeof TX.has !== 'function' || TX.has(n)) ? TX.get(n) : null);
      const needles = pick('ground-needles');   // -> pine-needles, tile 1.60 m
      const mud = pick('ground-mud');           // -> wet-earth,    tile 2.00 m
      const moss = pick('ground-moss');         // -> moss,         tile 0.80 m
      const granite = pick('granite');          // -> granite,      tile 1.40 m
      if (needles?.map && mud?.map && moss?.map && granite?.map) {
        this._groundSets = { needles, mud, moss, granite };
        Log.debug('Terrain: ground bound to Textures sets '
          + `${needles.name}/${mud.name}/${moss.name}/${granite.name} `
          + `(${needles.resolution ?? '?'}px, tiles ${needles.tile}/${mud.tile}/${moss.tile}/${granite.tile} m).`);
      } else {
        Log.once('terrain:tex-partial', 'Terrain: Textures returned an incomplete ground set — procedural detail only.');
      }
    } catch (e) {
      Log.once('terrain:tex', 'Terrain: Textures.get() threw — ground falls back to procedural detail.', e);
    }
  }

  // ===========================================================================================
  // MATERIAL
  // ===========================================================================================

  /**
   * The reference ground material from the shared library (`src/render/Materials.js`).
   *
   * We take its NUMBERS, not its shader. Materials patches its ground entries by replacing
   * `<map_fragment>`, `<roughnessmap_fragment>` and `<normal_fragment_maps>` wholesale — and so
   * does our splat. Two owners of the same chunk means whichever patch runs second silently
   * finds no token and does nothing, which is exactly the class of bug that ships looking fine
   * on the author's machine. So Terrain owns the ground shader and integrates with Materials
   * through the two interfaces that compose cleanly: `globalUniforms` and the authored constants.
   *
   * `has()` is probed first so an unknown name never trips the library's fallback path (which
   * returns a grey stand-in AND logs a warning — ARCHITECTURE.md §13 wants a clean console).
   */
  _referenceGroundMaterial() {
    const M = this.ctx?.systems?.get?.('Materials');
    if (!M || typeof M.get !== 'function') return null;
    for (const name of GROUND_MATERIAL_NAMES) {
      try {
        if (typeof M.has === 'function' && !M.has(name)) continue;
        const m = M.get(name);
        // Never adopt the library's own fallback — it is midSlate grey and would tint the
        // whole world blue through `diffuseColor.rgb *= gAlbedo`.
        if (m?.isMaterial && m.name !== 'sc-fallback') return m;
      } catch (e) {
        Log.once('terrain:mats', `Terrain: Materials.get('${name}') threw — using local constants.`, e);
      }
    }
    return null;
  }

  /** Materials.globalUniforms per ARCHITECTURE.md §10, if it exists. */
  _globalUniforms() {
    const M = this.ctx?.systems?.get?.('Materials');
    const g = M?.globalUniforms;
    return (g && typeof g === 'object') ? g : null;
  }

  _buildMaterial() {
    const ref = this._referenceGroundMaterial();
    // We always construct (and therefore always own) the ground material. Cloning a library
    // material would drop its onBeforeCompile anyway — three's Material.copy() does not carry
    // it — so a clone buys nothing but a wrong base colour.
    this._ownMaterial = true;

    const mat = new THREE.MeshStandardMaterial({
      // WHITE on purpose: the splat in _patchFragment IS the albedo (`diffuseColor.rgb *=
      // gAlbedo`). Any tint here multiplies the whole art-directed palette a second time.
      color: 0xffffff,
      // roughness/metalness are ABSOLUTE per-pixel writes in the splat (`roughnessFactor = gRough`
      // replaces the chunk outright, it does not multiply), and there is no roughnessMap bound
      // here. So these must NOT be copied from the library: Materials sets roughness = 1 /
      // metalness = 1 whenever it binds a Textures ORM set, and adopting those would either
      // double-apply or hand three a metallic ground for every path the patch does not reach
      // (depth/shadow prepass, a driver that drops the patch). Pinned, deliberately.
      roughness: 1.0,
      metalness: 0.0,
      dithering: true, side: THREE.FrontSide,
    });
    if (Number.isFinite(ref?.envMapIntensity)) mat.envMapIntensity = ref.envMapIntensity;
    mat.name = 'terrain.ground';
    mat.vertexColors = false;
    mat.flatShading = false;
    if (ref) Log.debug(`Terrain: ground constants from Materials '${ref.name}'.`);

    const g = this._globalUniforms();
    const G = this._groundSets;
    // Samplers must always be bound to something real — an unbound sampler2D is a black texture
    // and a driver warning. When Textures is absent the splat sees uTexMix 0 and never reads
    // them, but they still have to point somewhere, so they point at our own detail map.
    const fbC = this.texDetail, fbN = this.texNormal;
    const U = {
      tDetail: { value: this.texDetail },
      tNrm: { value: this.texNormal },

      // ---- the real ground bakes (see _bindGroundSets) --------------------------------------
      tGrndN: { value: G ? G.needles.map : fbC },
      tGrndM: { value: G ? G.mud.map : fbC },
      tGrndMo: { value: G ? G.moss.map : fbC },
      tGrndG: { value: G ? G.granite.map : fbC },
      // wet-earth is the dominant ground family and the only one authored at `hero` resolution,
      // so its normal (height in .a) and its ORM carry the relief and the micro-occlusion for
      // every family. Four normal maps and four ORMs would be eight more taps for detail that
      // mips away by 8 m.
      tGrndNrm: { value: G ? G.mud.normalMap : fbN },
      tGrndOrm: { value: G ? G.mud.ormMap : fbC },
      // repeats per metre = 1 / the set's authored physical tile size
      uGrndRate: {
        value: new THREE.Vector4(
          G ? 1 / G.needles.tile : 1, G ? 1 / G.mud.tile : 1,
          G ? 1 / G.moss.tile : 1, G ? 1 / G.granite.tile : 1,
        ),
      },
      uTexMix: { value: G ? 1 : 0 },

      uRain: g?.uRain ?? { value: 0.15 },
      uTime: g?.uTime ?? { value: 0 },
      // Share the library's wetness integrator when it exists, so the ground is exactly as wet
      // as every trunk, plank and bracket around it (ART_DIRECTION §5.1). Falls back to our own.
      uWet: g?.uWetness ?? { value: 0.35 },
      uMicro: { value: T.microSink },
      uHeightFog: { value: 1 },
      uFogNear: { value: new THREE.Color(0x2a3a44) },
      uFogFar: { value: new THREE.Color(0x54697a) },
      uFogD0: { value: 0.014 },
      uFogH: { value: 4.2 },
      uFogY0: { value: -1.0 },
      uFogScatter: { value: 1.0 },
    };
    this._uniforms = U;

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = this._patchVertex(shader.vertexShader);
      shader.fragmentShader = this._patchFragment(shader.fragmentShader);
    };
    mat.customProgramCacheKey = () => (this._groundSets ? 'terrain-splat-v2-tex' : 'terrain-splat-v2');

    this.material = mat;
    this._disposables.push(mat);
  }

  _patchVertex(src) {
    let v = src;
    const common = /* glsl */`
attribute vec4 aSplat;
attribute vec4 aMisc;
varying vec4 vSplat;
varying vec4 vMisc;
varying vec3 vWPos;
varying vec3 vWNrm;
uniform float uMicro;

float tHash(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float tNoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = tHash(i), b = tHash(i + vec2(1.0, 0.0));
  float c = tHash(i + vec2(0.0, 1.0)), d = tHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
#include <common>`;
    v = v.replace('#include <common>', common);

    const begin = /* glsl */`
vec3 transformed = vec3( position );
vSplat = aSplat;
vMisc = aMisc;
{
  vec3 wp0 = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  float camD = distance( cameraPosition, wp0 );
  // Downward-only micro displacement: the visual surface never rises above heightAt(),
  // so nothing placed by another system can ever float. Amplitude grows with distance
  // to restore the detail that vertex-decimating LODs throw away.
  float amp = uMicro * mix( 1.0, 3.6, smoothstep( 38.0, 150.0, camD ) );
  float mn = tNoise( wp0.xz * 1.35 ) * 0.62 + tNoise( wp0.xz * 0.41 + 7.3 ) * 0.38;
  transformed.y -= mn * amp;
}
vWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vWNrm = normalize( mat3( modelMatrix ) * objectNormal );`;
    if (v.includes('#include <begin_vertex>')) v = v.replace('#include <begin_vertex>', begin);
    else Log.once('terrain:vtx', 'Terrain: begin_vertex hook missing — micro-detail disabled.');
    return v;
  }

  _patchFragment(src) {
    let f = src;

    const common = /* glsl */`
uniform sampler2D tDetail;
uniform sampler2D tNrm;
uniform sampler2D tGrndN;
uniform sampler2D tGrndM;
uniform sampler2D tGrndMo;
uniform sampler2D tGrndG;
uniform sampler2D tGrndNrm;
uniform sampler2D tGrndOrm;
uniform vec4 uGrndRate;
uniform float uTexMix;
uniform float uRain;
uniform float uWet;
uniform float uHeightFog;
uniform vec3 uFogNear;
uniform vec3 uFogFar;
uniform float uFogD0;
uniform float uFogH;
uniform float uFogY0;
uniform float uFogScatter;
varying vec4 vSplat;
varying vec4 vMisc;
varying vec3 vWPos;
varying vec3 vWNrm;

vec3 gAlbedo = vec3( 0.5 );
float gRough = 0.8;
float gAO = 1.0;
float gWet = 0.0;
vec3 gNrmW = vec3( 0.0, 1.0, 0.0 );

vec3 tSrgb( vec3 c ) {
  return mix( pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), c / 12.92, step( c, vec3( 0.04045 ) ) );
}

/**
 * Detail from a baked albedo set, normalised against its OWN average.
 *
 * The fine tap divided by a very-coarse-mip tap of the same texture is the tile's spatial
 * detail with its mean divided out — it averages to 1.0 per channel. Multiplying an authored
 * palette colour by it therefore keeps the ART_DIRECTION 2.2 / 6.2 value AND hue exactly where
 * they were authored, and lets the bake own only what it should own: grain, clumps, flecks,
 * cavities. Handing the raw bake straight to 'diffuseColor' instead would let a procedural
 * texture silently re-author the palette, which is how ground ends up reading as pale sand.
 *
 * The mean tap is a LOD BIAS, not an absolute LOD, so it costs nothing at distance (both taps
 * converge on the same coarse mip, the ratio goes to 1, and the detail correctly fades out).
 */
vec3 tVar( sampler2D t, vec2 uv, float amt ) {
  vec3 fine = texture2D( t, uv ).rgb;
  vec3 mean = texture2D( t, uv, 6.0 ).rgb;
  vec3 g = clamp( fine / max( mean, vec3( 0.004 ) ), vec3( 0.30 ), vec3( 2.60 ) );
  return mix( vec3( 1.0 ), g, amt );
}

vec4 tTri( sampler2D t, vec3 p, float sc, vec3 an, float w, vec4 planar ) {
  if ( w < 0.004 ) return planar;
  vec3 bw = pow( an, vec3( 4.0 ) );
  bw /= max( bw.x + bw.y + bw.z, 1e-4 );
  vec4 sx = texture2D( t, p.zy * sc );
  vec4 sz = texture2D( t, p.xy * sc );
  return mix( planar, sx * bw.x + planar * bw.y + sz * bw.z, w );
}
#include <common>`;
    f = f.replace('#include <common>', common);

    const surface = /* glsl */`
{
  vec3 wp = vWPos;
  vec3 gn = normalize( vWNrm );
  vec3 an = abs( gn );
  // triplanar kicks in past 35 degrees (cos 35 = 0.819) and is full by 53 degrees
  float triW = smoothstep( 0.82, 0.60, an.y );
  float camDist = distance( cameraPosition, wp );
  float dfade = smoothstep( 16.0, 62.0, camDist );

  vec4 dMacro = texture2D( tDetail, wp.xz * 0.0385 );
  vec2 off = ( dMacro.rg - 0.5 ) * 0.85;
  vec3 wpo = wp + vec3( off.x, 0.0, off.y ) * 2.4;
  vec4 dMesoP = texture2D( tDetail, wpo.xz * 0.322 );
  vec4 dMeso = tTri( tDetail, wpo, 0.322, an, triW, dMesoP );
  vec4 dMicro = texture2D( tDetail, wp.xz * 2.38 + off );

  vec4 nMesoP = texture2D( tNrm, wp.xz * 0.455 );
  vec3 nMeso = tTri( tNrm, wp, 0.455, an, triW, nMesoP ).xyz * 2.0 - 1.0;
  vec3 nMicro = texture2D( tNrm, wp.xz * 1.82 + off ).xyz * 2.0 - 1.0;

  // ---- REAL baked ground detail (Textures.js sets, bound as uniforms — see _bindGroundSets) --
  // Sampled at each set's AUTHORED physical tile rate, so a needle is needle-sized and a granite
  // fleck is fleck-sized. This is the layer that gives the ground surface at 1 m; the procedural
  // dMacro/dMeso above are what keep it alive at 20 m, where a 1.6 m tile has mipped to nothing.
  vec3 vN = vec3( 1.0 ), vM = vec3( 1.0 ), vMo = vec3( 1.0 ), vGr = vec3( 1.0 );
  vec3 texNrm = vec3( 0.0, 0.0, 1.0 );
  float texAO = 1.0, texRough = 0.5, texH = 0.5;
  if ( uTexMix > 0.001 ) {
    // 'off' is the macro domain warp — reusing it stops the four sets tiling in lockstep.
    vN  = tVar( tGrndN,  wp.xz * uGrndRate.x + off * 0.35, uTexMix );
    vM  = tVar( tGrndM,  wp.xz * uGrndRate.y + off * 0.20, uTexMix );
    vMo = tVar( tGrndMo, wp.xz * uGrndRate.z + off * 0.55, uTexMix );
    vGr = tVar( tGrndG,  wp.xz * uGrndRate.w + off * 0.15, uTexMix );
    vec4 gn4 = texture2D( tGrndNrm, wp.xz * uGrndRate.y + off * 0.20 );
    texNrm = gn4.xyz * 2.0 - 1.0;
    texH = gn4.a;                                   // height, per the set's heightInNormalAlpha
    vec4 orm = texture2D( tGrndOrm, wp.xz * uGrndRate.y + off * 0.20 );
    texAO = orm.r;                                  // ORM values are ABSOLUTE — never re-scaled
    texRough = orm.g;
  }

  // ---- height-based splat blend (never a linear lerp — ART_DIRECTION trap 15) ----
  float tot = vSplat.x + vSplat.y + vSplat.z + vSplat.w + vMisc.x;
  vec4 sw = vSplat / max( tot, 1e-3 );
  float gw = vMisc.x / max( tot, 1e-3 );
  float hN  = sw.x + dMeso.a * 0.55;
  float hM  = sw.y + ( 1.0 - dMeso.a ) * 0.35;
  float hMo = sw.z + dMeso.g * 0.60;
  float hG  = sw.w + dMeso.b * 0.70;
  float hGr = gw   + dMicro.a * 0.80;
  float mx = max( max( hN, hM ), max( max( hMo, hG ), hGr ) ) - 0.20;
  float wN = max( hN - mx, 0.0 ), wM = max( hM - mx, 0.0 ), wMo = max( hMo - mx, 0.0 );
  float wG = max( hG - mx, 0.0 ), wGr = max( hGr - mx, 0.0 );
  float ws = wN + wM + wMo + wG + wGr + 1e-5;
  wN /= ws; wM /= ws; wMo /= ws; wG /= ws; wGr /= ws;

  // ---- per-family albedo (ART_DIRECTION 2.2 palette, 6.2 material table) ----
  // The terrain's dominant surface is the table's 'Wet earth / duff' row, authored at #2a221b
  // (0.0165 rel. luminance). foliage.dead #4a4433 (0.0583) is the DRY needle litter that only
  // survives under canopy shelter, so it is the top of the range and must not also be the mean.
  // The previous blend centred on #362f24 (0.0264) - 1.6x the authored wet-earth value - which
  // is most of why the clearing was the brightest large area in the frame.
  vec3 cNeedle = mix( tSrgb( vec3( 0.290, 0.258, 0.196 ) ),   // foliage.dead #4a4433, dry litter
                      tSrgb( vec3( 0.094, 0.076, 0.054 ) ),   // soaked duff #18130e
                      clamp( dMicro.r * 0.70 + dMeso.g * 0.50 + 0.10, 0.0, 1.0 ) );
  cNeedle *= 0.86 + 0.28 * dMicro.g;

  vec3 cMud = mix( tSrgb( vec3( 0.165, 0.133, 0.106 ) ),      // mat.mud #2a221b
                   tSrgb( vec3( 0.133, 0.106, 0.082 ) ),      // track mud #221b15
                   dMeso.a );
  cMud *= 0.82 + 0.36 * dMicro.r;

  vec3 cMoss = mix( tSrgb( vec3( 0.114, 0.169, 0.110 ) ),     // moss #1d2b1c
                    tSrgb( vec3( 0.055, 0.086, 0.055 ) ),
                    dMeso.b );
  cMoss *= 0.80 + 0.42 * dMicro.g;

  vec3 cGran = tSrgb( vec3( 0.231, 0.275, 0.294 ) );          // granite #3b464b
  cGran = mix( cGran, tSrgb( vec3( 0.098, 0.114, 0.125 ) ), smoothstep( 0.62, 0.98, dMicro.b ) );
  cGran = mix( cGran, tSrgb( vec3( 0.416, 0.443, 0.463 ) ), smoothstep( 0.58, 0.86, dMicro.r ) );
  cGran = mix( cGran, tSrgb( vec3( 0.541, 0.573, 0.604 ) ), smoothstep( 0.90, 1.00, dMicro.r ) );
  cGran *= 0.88 + 0.24 * dMacro.g;

  // Gravel's lit pebble tone is capped so the family mean stays under mid.stone #3b464b
  // (0.0582), which ART_DIRECTION 2.2 names as the brightest natural diffuse in the game.
  float peb = smoothstep( 0.35, 0.72, dMicro.g );
  vec3 cGrav = mix( tSrgb( vec3( 0.196, 0.227, 0.243 ) ), tSrgb( vec3( 0.318, 0.348, 0.366 ) ), peb );
  cGrav *= 0.85 + 0.30 * dMicro.r;

  // The bake supplies the detail, the palette above supplies the level and the hue.
  cNeedle *= vN;
  cMud *= vM;
  cMoss *= vMo;
  cGran *= vGr;
  cGrav *= mix( vGr, vM, 0.45 );                         // gravel has no set: granite over mud

  vec3 albedo = cNeedle * wN + cMud * wM + cMoss * wMo + cGran * wG + cGrav * wGr;
  albedo *= 0.90 + 0.20 * dMacro.g;                      // 10 m scale breakup (procedural)
  // One MACRO octave of the wet-earth bake at ~12 m per tile. Everything above is either
  // sub-metre (mips to flat by 8 m) or noise; this is the only real-texture term that is still
  // there at 20-40 m, and it is what stops open ground reading as one poured sheet at distance.
  albedo *= tVar( tGrndM, wp.xz * uGrndRate.y * 0.17, uTexMix * 0.60 );

  // Roughness per the ART_DIRECTION 6.2 material table: wet earth/duff 0.30, mud 0.16, moss 0.72,
  // granite 0.55, gravel 0.78. The duff term used to be 0.90 - a chalk-matte lambertian sheet that
  // returns the entire hemisphere as flat, view-independent diffuse and no specular structure at
  // all. That is the other half of the 'pale sheet' read, and it is why the lantern threw no
  // highlights on the ground.
  float rough = 0.34 * wN + 0.16 * wM + 0.72 * wMo + 0.55 * wG + 0.78 * wGr;
  float poro  = 1.00 * wN + 1.00 * wM + 0.85 * wMo + 0.55 * wG + 0.70 * wGr;
  // The set's ORM.g breaks the specular up at 1 m so the lantern pool is not one flat lobe. It
  // MODULATES the table value rather than replacing it — 6.2 owns the per-family number, the
  // bake owns the variation around it.
  rough *= mix( 1.0, 0.72 + 0.56 * texRough, uTexMix * 0.75 );

  // ---- dirt in crevices ----
  // The bake's own height (normalMap.a) is the physically-correct cavity term at 1 m — it knows
  // where the pits between the clods actually are, which noise can only approximate. Blended in
  // rather than replacing, because it mips flat past ~8 m and the noise still has to carry there.
  float cav = 1.0 - dMeso.a;
  cav = mix( cav, clamp( cav * 0.62 + ( 1.0 - texH ) * 0.55, 0.0, 1.0 ), uTexMix * 0.55 );
  float cavMicro = 1.0 - dMicro.a;
  albedo *= mix( 1.0, 0.58, cav * 0.55 + cavMicro * 0.25 );
  // NOTE: the set's ORM.r is NOT applied to albedo. Ambient occlusion occludes INDIRECT light,
  // it is not a pigment; folding it into diffuse colour here and into gAO below would darken the
  // ground twice for one physical effect. It goes into gAO only, at the bottom of this block.

  // ---- the four-part wetness model (ART_DIRECTION 6.1) ----
  // 6.1 opens with 'The world is damp every night', so W carries a floor. uWet is the Materials
  // accumulating integrator and reads 0.26 on a clear night with uRain 0, which on its own gave
  // W = 0.07 here and a 3% albedo darkening instead of the 38% the model specifies. Measured, on
  // the ridge shot, before this line was fixed.
  float soak = max( uWet, 0.42 );
  float W = clamp( ( 0.30 + 0.70 * vMisc.y ) * soak
                 + uRain * ( 0.22 + 0.55 * vMisc.z )
                 + cav * ( 0.22 + 0.40 * uRain ), 0.0, 1.0 );

  // 1. darkened albedo, scaled by porosity. Water fills the micro-voids and kills diffuse
  //    backscatter, so soil goes to roughly a third and granite barely moves.
  albedo *= mix( 1.0, 0.34, W * poro );

  // 2. crushed roughness - wet surfaces become mirrors, aggressively. Weighted toward cavities:
  //    water stands in the low spots, it does not sheet evenly over an open plane, and crushing
  //    the whole clearing to 0.075 hands the SSR pass a lake.
  rough = mix( rough, 0.075, W * ( 1.0 - dMeso.a * 0.35 ) * ( 0.30 + 0.70 * cav ) );

  // Specular detail below a pixel has to become roughness with distance or the ground mirrors
  // and sparkle-aliases (the Toksvig argument, trap 7). This is the near-field fade: the
  // lantern pool at 0-8 m keeps its full wet sheen, the clearing past ~30 m does not.
  float sfade = smoothstep( 8.0, 34.0, camDist );

  // 3. puddle accumulation in cavities: albedo toward water.body #0b171c, roughness toward 0.02,
  //    normal toward flat. Only on near-level ground, and only once the surface is genuinely wet.
  float pud = smoothstep( 0.55, 0.94, cav * 0.65 + cavMicro * 0.35 )
            * smoothstep( 0.25, 0.75, W )
            * smoothstep( 0.35, 0.10, 1.0 - gn.y )
            * ( 1.0 - sfade * 0.85 );
  albedo = mix( albedo, tSrgb( vec3( 0.043, 0.090, 0.110 ) ), pud * 0.85 );
  rough = mix( rough, 0.020, pud * 0.90 );

  // ---- normal: two-scale, distance-faded into roughness (Toksvig-ish, trap 7) ----
  float nStr = mix( 1.0, 0.18, dfade );
  vec3 nTS = normalize( vec3(
    ( nMeso.xy * 1.15 + nMicro.xy * 0.85 + texNrm.xy * ( 1.35 * uTexMix ) ) * nStr, 1.0 ) );
  nTS = normalize( mix( nTS, vec3( 0.0, 0.0, 1.0 ), max( W * cav * 0.75, pud * 0.90 ) ) );
  rough = clamp( max( mix( rough, rough + 0.18, dfade ), sfade * 0.40 ), 0.030, 1.0 );

  vec3 Tv = normalize( vec3( 1.0, 0.0, 0.0 ) - gn * gn.x );
  vec3 Bv = cross( Tv, gn );
  gNrmW = normalize( Tv * nTS.x + Bv * nTS.y + gn * nTS.z );

  gAlbedo = albedo;
  gRough = rough;
  gWet = W * ( 1.0 - sfade * 0.70 );   // the F0 lift is a near-field read, same reason as sfade
  // The hemisphere / probe term is the ground's dominant illuminant, and the terrain is the only
  // large surface in the game whose normal points straight at it - trees, timber and campers all
  // present near-vertical normals and collect a fraction of it. Occluding it by the baked sky
  // view factor (vMisc.z, which already accounts for canopy density) as well as by terrain
  // horizon AO is what stops a clearing ringed by 30 m pines reading as an open field.
  float skyView = mix( 0.10, 1.0, vMisc.z * vMisc.z );
  gAO = clamp( vMisc.w * skyView * ( 1.0 - 0.35 * cav ) * ( 1.0 - 0.20 * cavMicro )
             * mix( 1.0, texAO, 0.70 * uTexMix ), 0.0, 1.0 );
}
diffuseColor.rgb *= gAlbedo;`;
    if (f.includes('#include <map_fragment>')) f = f.replace('#include <map_fragment>', surface);
    else Log.once('terrain:frag', 'Terrain: map_fragment hook missing — splat disabled.');

    if (f.includes('#include <roughnessmap_fragment>')) {
      f = f.replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;');
    }
    if (f.includes('#include <normal_fragment_begin>')) {
      f = f.replace('#include <normal_fragment_begin>',
        '#include <normal_fragment_begin>\n  normal = normalize( ( viewMatrix * vec4( gNrmW, 0.0 ) ).xyz );');
    }
    if (f.includes('#include <aomap_fragment>')) {
      f = f.replace('#include <aomap_fragment>',
        '#include <aomap_fragment>\n  reflectedLight.indirectDiffuse *= gAO;');
    }
    // ART_DIRECTION 6.1 op 4 — grazing-angle sheen: Schlick F0 0.02 lifted toward 0.06 on wet
    // ground. metalness is pinned to 0 here, so specularColorBlended is just specularColor and
    // writing both keeps three's own invariant. This is the term that puts the lantern's wet
    // glitter on the mud in the key art.
    if (f.includes('#include <lights_physical_fragment>')) {
      f = f.replace('#include <lights_physical_fragment>', /* glsl */`
#include <lights_physical_fragment>
material.specularColor = mix( material.specularColor, vec3( 0.06 ), smoothstep( 0.30, 0.85, gWet ) );
material.specularColorBlended = material.specularColor;`);
    }

    // Analytic exponential HEIGHT fog, applied in scene-linear space before tone mapping
    // (ART_DIRECTION §4.1 / trap 1). Disabled automatically if Sky installs scene.fog.
    const fogCode = /* glsl */`
#include <opaque_fragment>
if ( uHeightFog > 0.001 ) {
  vec3 fA = cameraPosition;
  vec3 fB = vWPos;
  float fd = distance( fA, fB );
  float fdy = fB.y - fA.y;
  float ea = exp( -( fA.y - uFogY0 ) / uFogH );
  float eb = exp( -( fB.y - uFogY0 ) / uFogH );
  float optical = ( abs( fdy ) > 0.05 )
    ? uFogD0 * fd * ( ea - eb ) * uFogH / fdy
    : uFogD0 * fd * ea;
  float ff = 1.0 - exp( -max( optical, 0.0 ) * uFogScatter );
  vec3 fc = mix( uFogNear, uFogFar, smoothstep( 0.0, 95.0, fd ) );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fc, clamp( ff, 0.0, 1.0 ) * uHeightFog );
}`;
    if (f.includes('#include <opaque_fragment>')) f = f.replace('#include <opaque_fragment>', fogCode);
    return f;
  }

  // ===========================================================================================
  // VERTEX AO — horizon-based, baked at 2 m and sampled bilinearly. Gullies go dark, ridges
  // stay bright. This is most of what stops the terrain reading as a grey heightmap.
  // ===========================================================================================
  _bakeAO() {
    const n = this.n;
    const aoN = ((n - 1) >> 1) + 1;               // 257
    const ao = new Uint8Array(aoN * aoN);
    const RAD = [1.5, 4.0, 9.5];
    const DIRS = 8;
    const cs = [], sn = [];
    for (let a = 0; a < DIRS; a++) {
      const ang = (a / DIRS) * Math.PI * 2;
      cs.push(Math.cos(ang)); sn.push(Math.sin(ang));
    }
    for (let j = 0; j < aoN; j++) {
      const z = this.z0 + j * 2;
      for (let i = 0; i < aoN; i++) {
        const x = this.x0 + i * 2;
        const h0 = this.heightAt(x, z);
        let occ = 0;
        for (let a = 0; a < DIRS; a++) {
          let maxTan = 0;
          for (let r = 0; r < RAD.length; r++) {
            const d = RAD[r];
            const hh = this.heightAt(x + cs[a] * d, z + sn[a] * d);
            const t = (hh - h0) / d;
            if (t > maxTan) maxTan = t;
          }
          occ += maxTan / Math.sqrt(1 + maxTan * maxTan);   // sin of the horizon angle
        }
        occ /= DIRS;
        ao[j * aoN + i] = Math.round(clamp01(1 - occ * 1.15) * 255);
      }
    }
    this._ao = ao;
    this._aoN = aoN;
  }

  _aoAt(x, z) {
    const ao = this._ao;
    if (!ao) return 1;
    const aoN = this._aoN;
    let fx = (x - this.x0) * 0.5, fz = (z - this.z0) * 0.5;
    fx = clamp(fx, 0, aoN - 1.001); fz = clamp(fz, 0, aoN - 1.001);
    const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz;
    const i0 = iz * aoN + ix;
    const a = ao[i0] + (ao[i0 + 1] - ao[i0]) * tx;
    const b = ao[i0 + aoN] + (ao[i0 + aoN + 1] - ao[i0 + aoN]) * tx;
    return (a + (b - a) * tz) / 255;
  }

  // ===========================================================================================
  // MESHING — 32 m chunks with 4 shared index LODs, plus 128 m super-chunks for the far field.
  // All chunks share one material and one set of index buffers. Skirts hide LOD cracks.
  // ===========================================================================================
  _buildMeshes() {
    if (!this._ao) this._bakeAO();
    const scene = this.ctx?.scene;
    this.group = new THREE.Group();
    this.group.name = 'Terrain';
    this.group.matrixAutoUpdate = false;

    const DIV = T.quadDiv;
    this._sharedIndex = this._makeIndex(DIV, 1);
    this._radii = T.lodRadii;
    this._nodes = [];

    for (let lv = 0; lv < T.levels.length; lv++) {
      const { span, skirt } = T.levels[lv];
      const cnt = Math.round(this.size / span);
      const list = [];
      const leaf = lv === T.levels.length - 1;
      for (let cz = 0; cz < cnt; cz++) {
        for (let cx = 0; cx < cnt; cx++) {
          const ox = this.x0 + cx * span;
          const oz = this.z0 + cz * span;
          const geo = this._makeGridGeometry(ox, oz, span, DIV, skirt);
          geo.index = this._sharedIndex;
          const mesh = new THREE.Mesh(geo, this.material);
          mesh.name = `terrain.n${lv}.${cx}.${cz}`;
          mesh.position.set(ox, 0, oz);
          mesh.matrixAutoUpdate = false;
          mesh.updateMatrix();
          mesh.frustumCulled = false;              // we cull ourselves, hierarchically
          mesh.visible = false;
          // EVERY level receives. The old rule was `lv > 0`, on the theory that level 0 (the
          // 128 m super-chunks) always sits outside the shadow cascades. It does not: a level-0
          // node is drawn whenever the camera is >= 80 m from its AABB (lodRadii[0]), and
          // ART_DIRECTION 3.2 lands cascade 2 at 130 m — so the whole 80-130 m band was drawn on
          // shadow-rejecting geometry while the 64 m tiles beside it accepted shadows, which is
          // a hard, moving line across the ground exactly where the treeline shadows fall. The
          // ground is also the ONLY surface a lantern shadow can land on, and a flag that is
          // wrong on any level is a flag that will be wrong on the level the player is standing
          // on the next time the LOD radii are retuned. It costs a shadow-map fetch on terrain
          // that is already the cheapest fragment in the frame.
          mesh.receiveShadow = true;
          mesh.castShadow = false;                 // ART_DIRECTION §3.3 caster ledger
          mesh.renderOrder = 0;
          this.group.add(mesh);
          const sph = geo.boundingSphere.clone().translate(new THREE.Vector3(ox, 0, oz));
          sph.radius += 3.0;                       // margin: a child may peak above its parent
          list.push({
            mesh, geo, leaf, sphere: sph,
            minX: ox, maxX: ox + span, minZ: oz, maxZ: oz + span,
            children: null,
          });
          this._disposables.push(geo);
        }
      }
      this._nodes.push({ list, cnt, span });
    }

    // wire the quadtree
    for (let lv = 0; lv < this._nodes.length - 1; lv++) {
      const par = this._nodes[lv], ch = this._nodes[lv + 1];
      for (let cz = 0; cz < par.cnt; cz++) {
        for (let cx = 0; cx < par.cnt; cx++) {
          par.list[cz * par.cnt + cx].children = [
            ch.list[(cz * 2) * ch.cnt + cx * 2],
            ch.list[(cz * 2) * ch.cnt + cx * 2 + 1],
            ch.list[(cz * 2 + 1) * ch.cnt + cx * 2],
            ch.list[(cz * 2 + 1) * ch.cnt + cx * 2 + 1],
          ];
        }
      }
    }

    this._buildWater();
    this._buildPuddles();
    this._buildReeds();
    this._buildLogCrossing();

    if (scene) scene.add(this.group);
  }

  /**
   * Shared index buffer for a `div x div` quad grid at `stride`, including the skirt ring.
   * Vertex layout: [ (div+1)^2 grid ][ 4 x (div+1) skirt: top, bottom, left, right ].
   */
  _makeIndex(div, stride) {
    const W = div + 1;
    const grid = W * W;
    const sTop = grid, sBot = grid + W, sLeft = grid + 2 * W, sRight = grid + 3 * W;
    const idx = [];
    const gi = (c, r) => r * W + c;

    for (let r = 0; r < div; r += stride) {
      for (let c = 0; c < div; c += stride) {
        const i00 = gi(c, r), i10 = gi(c + stride, r);
        const i01 = gi(c, r + stride), i11 = gi(c + stride, r + stride);
        idx.push(i00, i01, i10, i10, i01, i11);   // +Y winding
      }
    }
    for (let c = 0; c < div; c += stride) {
      const a = gi(c, 0), b = gi(c + stride, 0);
      idx.push(a, b, sTop + c, b, sTop + c + stride, sTop + c);              // -Z face
      const a2 = gi(c, div), b2 = gi(c + stride, div);
      idx.push(a2, sBot + c, b2, b2, sBot + c, sBot + c + stride);           // +Z face
    }
    for (let r = 0; r < div; r += stride) {
      const a = gi(0, r), b = gi(0, r + stride);
      idx.push(a, sLeft + r, b, b, sLeft + r, sLeft + r + stride);           // -X face
      const a2 = gi(div, r), b2 = gi(div, r + stride);
      idx.push(a2, b2, sRight + r, b2, sRight + r + stride, sRight + r);     // +X face
    }
    const total = grid + 4 * W;
    const arr = total > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
    return new THREE.BufferAttribute(arr, 1);
  }

  /** Blend the surface map over a 3x3 neighbourhood so splat borders are soft. */
  _splatAt(x, z, out) {
    const n = this.n;
    let ix = Math.round((x - this.x0) * this.invCell);
    let iz = Math.round((z - this.z0) * this.invCell);
    ix = clamp(ix, 0, n - 1); iz = clamp(iz, 0, n - 1);
    out[0] = out[1] = out[2] = out[3] = out[4] = 0;
    let tot = 0;
    for (let dz = -1; dz <= 1; dz++) {
      const jj = clamp(iz + dz, 0, n - 1) * n;
      for (let dx = -1; dx <= 1; dx++) {
        const s = this._surf[jj + clamp(ix + dx, 0, n - 1)];
        const w = (dx === 0 && dz === 0) ? 3 : 1;
        tot += w;
        switch (s) {
          case S_MUD: out[1] += w; break;
          case S_MOSS: out[2] += w; break;
          case S_GRANITE: out[3] += w; break;
          case S_GRAVEL: out[4] += w; break;
          case S_WATER: out[1] += w; break;         // puddle beds read as mud under the water
          default: out[0] += w;
        }
      }
    }
    for (let i = 0; i < 5; i++) out[i] /= tot;
  }

  _makeGridGeometry(ox, oz, span, div, skirtDepth) {
    const W = div + 1;
    const step = span / div;
    const grid = W * W;
    const total = grid + 4 * W;

    const pos = new Float32Array(total * 3);
    const nrm = new Float32Array(total * 3);
    const splat = new Uint8Array(total * 4);
    const misc = new Uint8Array(total * 4);
    // Materials.js documents `aExposure : vec2` as THE optional attribute its wetness shader
    // reads (x = how wet/open, y = validity). Ours is the ground's baked wetness lifted by sky
    // exposure, so any Materials-patched material laid over terrain geometry — a decal, a
    // swapped ground material — is wet in exactly the places the terrain itself is wet.
    const wexp = new Uint8Array(total * 2);
    const sw = _splatScratch;
    const nv = _v3b;

    let minY = Infinity, maxY = -Infinity;

    const writeVert = (vi, lx, lz, y, wx, wz, sink) => {
      pos[vi * 3] = lx; pos[vi * 3 + 1] = y - sink; pos[vi * 3 + 2] = lz;
      this.normalAt(wx, wz, nv);
      nrm[vi * 3] = nv.x; nrm[vi * 3 + 1] = nv.y; nrm[vi * 3 + 2] = nv.z;
      this._splatAt(wx, wz, sw);
      splat[vi * 4] = Math.round(sw[0] * 255);
      splat[vi * 4 + 1] = Math.round(sw[1] * 255);
      splat[vi * 4 + 2] = Math.round(sw[2] * 255);
      splat[vi * 4 + 3] = Math.round(sw[3] * 255);
      const wet = this._sampleU8(this._wet, wx, wz);
      const sky = this._sampleU8(this._expo, wx, wz);
      misc[vi * 4] = Math.round(sw[4] * 255);               // gravel
      misc[vi * 4 + 1] = wet;                               // wetness
      misc[vi * 4 + 2] = sky;                               // sky exposure
      misc[vi * 4 + 3] = Math.round(this._aoAt(wx, wz) * 255);
      wexp[vi * 2] = Math.min(255, Math.round(sky * 0.45 + wet * 0.80));
      wexp[vi * 2 + 1] = 255;                               // validity flag
    };

    for (let r = 0; r < W; r++) {
      const lz = r * step, wz = oz + lz;
      for (let c = 0; c < W; c++) {
        const lx = c * step, wx = ox + lx;
        const y = this.heightAt(wx, wz);
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        writeVert(r * W + c, lx, lz, y, wx, wz, 0);
      }
    }

    // skirt ring: top (r=0), bottom (r=div), left (c=0), right (c=div)
    for (let k = 0; k < W; k++) {
      const lk = k * step;
      writeVert(grid + k, lk, 0, this.heightAt(ox + lk, oz), ox + lk, oz, skirtDepth);
      writeVert(grid + W + k, lk, span, this.heightAt(ox + lk, oz + span), ox + lk, oz + span, skirtDepth);
      writeVert(grid + 2 * W + k, 0, lk, this.heightAt(ox, oz + lk), ox, oz + lk, skirtDepth);
      writeVert(grid + 3 * W + k, span, lk, this.heightAt(ox + span, oz + lk), ox + span, oz + lk, skirtDepth);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('aSplat', new THREE.BufferAttribute(splat, 4, true));
    geo.setAttribute('aMisc', new THREE.BufferAttribute(misc, 4, true));
    geo.setAttribute('aExposure', new THREE.BufferAttribute(wexp, 2, true));
    const cy = (minY + maxY) * 0.5;
    geo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(span * 0.5, cy, span * 0.5),
      Math.hypot(span * 0.7072, (maxY - minY) * 0.5 + skirtDepth) + 0.5,
    );
    geo.boundingBox = new THREE.Box3(
      new THREE.Vector3(0, minY - skirtDepth, 0),
      new THREE.Vector3(span, maxY, span),
    );
    return geo;
  }

  _sampleU8(arr, x, z) {
    if (!arr) return 0;
    const n = this.n;
    let ix = Math.round((x - this.x0) * this.invCell);
    let iz = Math.round((z - this.z0) * this.invCell);
    ix = clamp(ix, 0, n - 1); iz = clamp(iz, 0, n - 1);
    return arr[iz * n + ix];
  }

  // ===========================================================================================
  // WATER — the lake. Gerstner sum, shoreline foam, depth-faded edge (no z-fight at the line).
  // ===========================================================================================
  _buildWater() {
    const step = this.ctx?.settings?.tier?.(4, 3, 2.5, 2) ?? 2.5;
    const minX = this.bounds.minX, maxX = this.bounds.maxX;
    const minZ = this.bounds.minZ, maxZ = -40;
    const nx = Math.round((maxX - minX) / step) + 1;
    const nz = Math.round((maxZ - minZ) / step) + 1;

    const depth = new Float32Array(nx * nz);
    for (let j = 0; j < nz; j++) {
      const z = minZ + j * step;
      for (let i = 0; i < nx; i++) {
        depth[j * nx + i] = this.waterLevel - this.heightAt(minX + i * step, z);
      }
    }

    const pos = [], dep = [], idx = [];
    const map = new Int32Array(nx * nz).fill(-1);
    const keep = (i, j) => depth[j * nx + i] > -0.35;
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        if (!keep(i, j) && !keep(i + 1, j) && !keep(i, j + 1) && !keep(i + 1, j + 1)) continue;
        const ids = [];
        for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const ii = i + di, jj = j + dj, key = jj * nx + ii;
          if (map[key] < 0) {
            map[key] = pos.length / 3;
            pos.push(minX + ii * step, this.waterLevel, minZ + jj * step);
            dep.push(Math.max(0, depth[key]));
          }
          ids.push(map[key]);
        }
        const [a, b, c, d] = ids;   // (0,0) (1,0) (0,1) (1,1)
        idx.push(a, c, b, b, c, d);
      }
    }
    if (!pos.length) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aDepth', new THREE.Float32BufferAttribute(dep, 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();

    const g = this._globalUniforms();
    const WU = {
      uTime: g?.uTime ?? { value: 0 },
      uWind: { value: 0.2 },
      uRain: g?.uRain ?? { value: 0.15 },
    };
    this._waterUniforms = WU;

    const mat = new THREE.MeshStandardMaterial({
      color: 0x0b171c,               // water.body
      roughness: 0.02, metalness: 0.0,
      transparent: true, depthWrite: true,
      side: THREE.FrontSide, dithering: true,
    });
    mat.name = 'terrain.lake';
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, WU);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', /* glsl */`
attribute float aDepth;
varying float vDepth;
varying vec3 vWNrmW;
varying vec3 vWPosW;
uniform float uTime;
uniform float uWind;
vec3 waveTerm( vec2 p, vec2 d, float amp, float len, float spd, float t ) {
  float k = 6.2831853 / len;
  float ph = dot( d, p ) * k + t * spd * k;
  float c = amp * k * cos( ph );
  return vec3( amp * sin( ph ), c * d.x, c * d.y );
}
#include <common>`)
        .replace('#include <begin_vertex>', /* glsl */`
vec3 transformed = vec3( position );
vDepth = aDepth;
{
  vec2 p = ( modelMatrix * vec4( position, 1.0 ) ).xz;
  float shoal = smoothstep( 0.05, 1.8, aDepth );
  float amp = ( 0.55 + 0.9 * uWind ) * shoal;
  vec3 w = vec3( 0.0 );
  w += waveTerm( p, normalize( vec2( 0.92, 0.39 ) ), 0.045 * amp, 5.5, 0.55, uTime );
  w += waveTerm( p, normalize( vec2( 0.61, -0.79 ) ), 0.030 * amp, 3.1, 0.75, uTime );
  w += waveTerm( p, normalize( vec2( -0.30, 0.95 ) ), 0.019 * amp, 1.7, 1.05, uTime );
  w += waveTerm( p, normalize( vec2( 0.99, -0.14 ) ), 0.011 * amp, 0.9, 1.55, uTime );
  transformed.y += w.x;
  vWNrmW = normalize( vec3( -w.y, 1.0, -w.z ) );
  vWPosW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
}`)
        .replace('#include <beginnormal_vertex>',
          '#include <beginnormal_vertex>\n  objectNormal = vec3( 0.0, 1.0, 0.0 );');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', /* glsl */`
varying float vDepth;
varying vec3 vWNrmW;
varying vec3 vWPosW;
uniform float uRain;
#include <common>`)
        .replace('#include <normal_fragment_begin>',
          '#include <normal_fragment_begin>\n  normal = normalize( ( viewMatrix * vec4( normalize( vWNrmW ), 0.0 ) ).xyz );')
        .replace('#include <map_fragment>', /* glsl */`
{
  // shallow water lets the gravel bed through; the shoreline gets a scum/foam line
  float shallow = 1.0 - smoothstep( 0.0, 1.4, vDepth );
  vec3 bed = vec3( 0.031, 0.041, 0.047 );
  diffuseColor.rgb = mix( diffuseColor.rgb, bed, shallow * 0.75 );
  float foam = smoothstep( 0.62, 0.05, vDepth );
  float fj = fract( sin( dot( floor( vWPosW.xz * 3.1 ), vec2( 12.99, 78.23 ) ) ) * 43758.5453 );
  diffuseColor.rgb += vec3( 0.035, 0.045, 0.052 ) * foam * ( 0.45 + 0.55 * fj );
  diffuseColor.a *= smoothstep( 0.0, 0.16, vDepth );
}`)
        .replace('#include <roughnessmap_fragment>', /* glsl */`
float roughnessFactor = roughness + uRain * 0.06 + smoothstep( 0.5, 0.0, vDepth ) * 0.25;`);
    };
    mat.customProgramCacheKey = () => 'terrain-lake-v1';

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'terrain.lake';
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 1;
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    this.group.add(mesh);
    this.water = mesh;
    this.waterMaterial = mat;
    this._disposables.push(geo, mat);
  }

  // ===========================================================================================
  // PUDDLES — real flat water patches in real local minima. One draw call.
  // ===========================================================================================
  _buildPuddles() {
    if (!this.puddles.length) return;
    const segs = this.ctx?.settings?.tier?.(8, 12, 18, 24) ?? 18;
    const geo = new THREE.CircleGeometry(1, segs);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshStandardMaterial({
      color: 0x0b171c, roughness: 0.025, metalness: 0.0,
      transparent: true, depthWrite: false, dithering: true,
    });
    mat.name = 'terrain.puddle';
    mat.envMapIntensity = 1.5;
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', 'varying vec2 vPUv;\n#include <common>')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vPUv = position.xz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', 'varying vec2 vPUv;\n#include <common>')
        .replace('#include <alphatest_fragment>',
          '#include <alphatest_fragment>\n  diffuseColor.a *= 1.0 - smoothstep( 0.68, 1.0, length( vPUv ) );');
    };
    mat.customProgramCacheKey = () => 'terrain-puddle-v1';

    const inst = new THREE.InstancedMesh(geo, mat, this.puddles.length);
    inst.name = 'terrain.puddles';
    inst.frustumCulled = true;
    inst.receiveShadow = false;
    inst.castShadow = false;
    inst.renderOrder = 2;
    const rand = new Rand(this._seed ^ 0x9d13);
    for (let i = 0; i < this.puddles.length; i++) {
      const p = this.puddles[i];
      _quat.setFromAxisAngle(_fallbackNormal, rand.next() * Math.PI * 2);
      _scale.set(p.radius, 1, p.radius * rand.range(0.72, 1.25));
      _mat4.compose(p.position, _quat, _scale);
      inst.setMatrixAt(i, _mat4);
    }
    inst.instanceMatrix.needsUpdate = true;
    this.group.add(inst);
    this.puddleMesh = inst;
    this._disposables.push(geo, mat);
  }

  // ===========================================================================================
  // REEDS — shoreline margin dressing. Instanced clumps, wind-swayed. One draw call.
  // ===========================================================================================
  _buildReeds() {
    const count = this.ctx?.settings?.tier?.(280, 620, 1100, 1600) ?? 1100;
    const rand = new Rand(this._seed ^ 0x3ee5);

    // one clump = 3 tapered blades, 4 segments each
    const bp = [], bn = [], bi = [], bh = [];
    let vo = 0;
    for (let b = 0; b < 3; b++) {
      const ang = (b / 3) * Math.PI * 2 + 0.4;
      const dx = Math.cos(ang) * 0.06, dz = Math.sin(ang) * 0.06;
      const lean = 0.16;
      const SEG = 4;
      for (let s = 0; s <= SEG; s++) {
        const t = s / SEG;
        const y = t * 1.25;
        const w = 0.021 * (1 - t * 0.85);
        const cx = dx + Math.cos(ang) * lean * t * t;
        const cz = dz + Math.sin(ang) * lean * t * t;
        const px = -Math.sin(ang) * w, pz = Math.cos(ang) * w;
        bp.push(cx - px, y, cz - pz, cx + px, y, cz + pz);
        bn.push(Math.cos(ang), 0.35, Math.sin(ang), Math.cos(ang), 0.35, Math.sin(ang));
        bh.push(t, t);
      }
      for (let s = 0; s < SEG; s++) {
        const a = vo + s * 2;
        bi.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
      vo += (SEG + 1) * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(bn, 3));
    geo.setAttribute('aH', new THREE.Float32BufferAttribute(bh, 1));
    geo.setIndex(bi);
    geo.computeBoundingSphere();

    const g = this._globalUniforms();
    const RU = { uTime: g?.uTime ?? { value: 0 }, uWind: { value: 0.2 } };
    this._reedUniforms = RU;

    const mat = new THREE.MeshStandardMaterial({
      color: 0x1a2318, roughness: 0.48, metalness: 0.0, side: THREE.DoubleSide, dithering: true,
    });
    mat.name = 'terrain.reeds';
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, RU);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', /* glsl */`
attribute float aH;
varying float vH;
uniform float uTime;
uniform float uWind;
#include <common>`)
        .replace('#include <begin_vertex>', /* glsl */`
vec3 transformed = vec3( position );
vH = aH;
{
  vec3 ip = vec3( instanceMatrix[ 3 ].xyz );
  float ph = ip.x * 0.7 + ip.z * 0.53;
  float s = ( 0.10 + 0.34 * uWind ) * aH * aH;
  transformed.x += sin( uTime * 1.7 + ph ) * s;
  transformed.z += cos( uTime * 1.31 + ph * 1.7 ) * s * 0.8;
}`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', 'varying float vH;\n#include <common>')
        .replace('#include <map_fragment>', /* glsl */`
#include <map_fragment>
// vertex AO gradient root -> tip; dead straw toward the tips
diffuseColor.rgb *= 0.30 + 0.70 * vH;
diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.070, 0.062, 0.036 ), smoothstep( 0.62, 1.0, vH ) );`);
    };
    mat.customProgramCacheKey = () => 'terrain-reeds-v1';

    const inst = new THREE.InstancedMesh(geo, mat, count);
    inst.name = 'terrain.reeds';
    inst.receiveShadow = false;
    inst.castShadow = false;
    let placed = 0, attempts = 0;
    while (placed < count && attempts < count * 40) {
      attempts++;
      // Walk to the waterline for this x, then jitter into the shallow margin. Sampling the
      // lake box uniformly wastes 95% of the tries in deep water.
      const x = rand.range(this.bounds.minX + 4, this.bounds.maxX - 4);
      let z = -46;
      let found = false;
      for (let k = 0; k < 400; k++) {
        if (this.heightAt(x, z) < this.waterLevel) { found = true; break; }
        z -= 0.75;
        if (z < this.bounds.minZ + 4) break;
      }
      if (!found) continue;
      z += rand.range(-5.5, 1.2);
      const d = this.waterLevel - this.heightAt(x, z);
      if (d < 0.02 || d > 1.05) continue;
      if (this.slopeAt(x, z) > 0.30) continue;
      _quat.setFromAxisAngle(_fallbackNormal, rand.next() * Math.PI * 2);
      const sc = rand.range(0.65, 1.5);
      _scale.set(sc, sc * rand.range(0.8, 1.35), sc);
      _v3.set(x, this.waterLevel - d, z);
      _mat4.compose(_v3, _quat, _scale);
      inst.setMatrixAt(placed++, _mat4);
    }
    inst.count = placed;
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    if (placed > 0) this.group.add(inst);
    this.reeds = inst;
    this._disposables.push(geo, mat);
  }

  // ===========================================================================================
  // LOG CROSSING — the fallen trunk over the stream at the draw.
  // ===========================================================================================
  _buildLogCrossing() {
    const L = this.logCrossing;
    if (!L) return;
    const RINGS = 18, SIDES = 9;
    const pos = [], nrm = [], uv = [], idx = [];
    const dir = L.direction.clone().normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(dir, up).normalize();
    const rand = new Rand(this._seed ^ 0x10c0);

    for (let r = 0; r <= RINGS; r++) {
      const t = r / RINGS;
      const along = (t - 0.5) * L.length;
      // slight sag + taper, and it beds into the banks at both ends
      const sag = -0.20 * Math.sin(t * Math.PI);
      const rad = L.radius * (1.0 - 0.30 * t) * (1 + 0.06 * Math.sin(t * 19));
      const cx = L.position.x + dir.x * along + side.x * Math.sin(t * 2.1) * 0.10;
      const cz = L.position.z + dir.z * along + side.z * Math.sin(t * 2.1) * 0.10;
      const cy = L.position.y + sag;
      for (let s2 = 0; s2 <= SIDES; s2++) {
        const a = (s2 / SIDES) * Math.PI * 2;
        const bumpy = 1 + 0.09 * Math.sin(a * 4 + t * 7) + 0.05 * (rand.next() - 0.5);
        const ox = side.x * Math.cos(a) * rad * bumpy + dir.x * 0;
        const oz = side.z * Math.cos(a) * rad * bumpy;
        const oy = Math.sin(a) * rad * bumpy;
        pos.push(cx + ox, cy + oy, cz + oz);
        const nx = side.x * Math.cos(a), ny = Math.sin(a), nz = side.z * Math.cos(a);
        const il = 1 / Math.hypot(nx, ny, nz);
        nrm.push(nx * il, ny * il, nz * il);
        uv.push(t * 5.5, s2 / SIDES * 1.6);
      }
    }
    const RW = SIDES + 1;
    for (let r = 0; r < RINGS; r++) {
      for (let s2 = 0; s2 < SIDES; s2++) {
        const a = r * RW + s2;
        idx.push(a, a + RW, a + 1, a + 1, a + RW, a + RW + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();

    const nmap = this.texNormal.clone();
    nmap.needsUpdate = true;
    nmap.wrapS = nmap.wrapT = THREE.RepeatWrapping;
    nmap.repeat.set(3, 1.2);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x15120f,               // bark.wet
      roughness: 0.42, metalness: 0.0,
      normalMap: nmap, normalScale: new THREE.Vector2(1.5, 1.5),
      dithering: true,
    });
    mat.name = 'terrain.log';
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'terrain.logCrossing';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.logMesh = mesh;
    this._disposables.push(geo, mat, nmap);
  }

  // ===========================================================================================
  // PUBLIC QUERY API — every method here is allocation-free and safe before init().
  // ===========================================================================================

  /**
   * World-space ground height. Bilinear-filtered from the cached heightmap; never evaluates
   * noise. Safe to call thousands of times per frame. Clamps outside the bounds.
   * @param {number} x @param {number} z @returns {number}
   */
  heightAt(x, z) {
    const H = this._h;
    if (!H) return 0;
    const n = this.n;
    let fx = (x - this.x0) * this.invCell;
    let fz = (z - this.z0) * this.invCell;
    const lim = n - 1.0001;
    if (!(fx >= 0)) fx = 0; else if (fx > lim) fx = lim;
    if (!(fz >= 0)) fz = 0; else if (fz > lim) fz = lim;
    const ix = fx | 0, iz = fz | 0;
    const tx = fx - ix, tz = fz - iz;
    const i0 = iz * n + ix;
    const h00 = H[i0], h10 = H[i0 + 1], h01 = H[i0 + n], h11 = H[i0 + n + 1];
    const a = h00 + (h10 - h00) * tx;
    const b = h01 + (h11 - h01) * tx;
    return a + (b - a) * tz;
  }

  /**
   * Unit surface normal. Central differences over one cell, so it matches the mesh exactly.
   * @param {number} x @param {number} z @param {THREE.Vector3} [outVector3]
   * @returns {THREE.Vector3}
   */
  normalAt(x, z, outVector3) {
    // NB not _fallbackNormal: that is a shared constant (+Y) used as a rotation axis elsewhere,
    // and writing the ground normal into it would quietly corrupt every later reader.
    const out = outVector3 ?? _normalScratch;
    const e = this.cell;
    const hl = this.heightAt(x - e, z), hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e), hu = this.heightAt(x, z + e);
    const gx = (hr - hl) / (2 * e);
    const gz = (hu - hd) / (2 * e);
    const inv = 1 / Math.sqrt(gx * gx + gz * gz + 1);
    out.set(-gx * inv, inv, -gz * inv);
    return out;
  }

  /**
   * Ground material at a point. One of SURFACES.
   * @returns {'needles'|'mud'|'moss'|'granite'|'water'|'gravel'}
   */
  surfaceAt(x, z) {
    if (this.heightAt(x, z) < this.waterLevel - 0.02) return 'water';
    const s = this._surf;
    if (!s) return 'needles';
    const n = this.n;
    let ix = Math.round((x - this.x0) * this.invCell);
    let iz = Math.round((z - this.z0) * this.invCell);
    ix = clamp(ix, 0, n - 1); iz = clamp(iz, 0, n - 1);
    return SURFACES[s[iz * n + ix]] ?? 'needles';
  }

  /** Steepness, 0 = flat, 1 = vertical. Linear in angle: 0.389 at 35 deg, 0.5 at 45 deg. */
  slopeAt(x, z) {
    const e = this.cell;
    const gx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const gz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    const ny = 1 / Math.sqrt(gx * gx + gz * gz + 1);
    return clamp01(Math.acos(clamp(ny, -1, 1)) / (Math.PI * 0.5));
  }

  /** True in the lake or in a puddle. */
  isWater(x, z) {
    if (this.heightAt(x, z) < this.waterLevel - 0.02) return true;
    const s = this._surf;
    if (!s) return false;
    const n = this.n;
    let ix = Math.round((x - this.x0) * this.invCell);
    let iz = Math.round((z - this.z0) * this.invCell);
    ix = clamp(ix, 0, n - 1); iz = clamp(iz, 0, n - 1);
    return s[iz * n + ix] === S_WATER;
  }

  /**
   * Straight-down ray against the heightfield.
   * @returns {number|null} the hit Y, or null if `fromY` is already below ground / out of bounds.
   */
  raycastDown(x, z, fromY = 1e4) {
    if (x < this.bounds.minX || x > this.bounds.maxX
      || z < this.bounds.minZ || z > this.bounds.maxZ) return null;
    const h = this.heightAt(x, z);
    return fromY >= h - 1e-4 ? h : null;
  }

  // ---- extra fields other systems asked for (all O(1), all allocation-free) -----------------

  /** 0..1 canopy density the Forest should plant to. Terrain decides where the forest is. */
  forestDensityAt(x, z) { return this._sampleU8(this._dens, x, z) / 255; }
  /** 0 = sheltered, 1 = open sky. Matches the per-vertex `aExposure` Materials reads. */
  exposureAt(x, z) { return this._sampleU8(this._expo, x, z) / 255; }
  /** 0..1 baked ground wetness (shoreline, drainage, hollows, puddle haloes, ruts). */
  wetnessAt(x, z) { return this._sampleU8(this._wet, x, z) / 255; }
  /** 0..1 proximity to a worn path. > 0.4 means "people walk here". */
  pathInfluenceAt(x, z) { return this._sampleU8(this._path, x, z) / 255; }
  /** 0..1 drainage flux from the erosion pass. High = a gully / seasonal watercourse. */
  flowAt(x, z) {
    const f = this._flow;
    if (!f) return 0;
    const n = this.n;
    let ix = Math.round((x - this.x0) * this.invCell);
    let iz = Math.round((z - this.z0) * this.invCell);
    ix = clamp(ix, 0, n - 1); iz = clamp(iz, 0, n - 1);
    return f[iz * n + ix];
  }
  /** Baked horizon AO, 0 = deep gully, 1 = open. */
  aoAt(x, z) { return this._aoAt(x, z); }
  /** True if the point is inside the world square. */
  contains(x, z) {
    return x >= this.bounds.minX && x <= this.bounds.maxX
      && z >= this.bounds.minZ && z <= this.bounds.maxZ;
  }

  /**
   * Fill a descriptor for a ground point. Pass `out` to reuse an object (allocation-free).
   * @param {number} x @param {number} z @param {object} [out]
   */
  sampleInfo(x, z, out) {
    const o = out ?? {
      x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, slope: 0,
      surface: 'needles', surfaceId: 0, wet: 0, exposure: 1,
      density: 0, flow: 0, path: 0, water: false,
    };
    o.x = x; o.z = z;
    o.y = this.heightAt(x, z);
    this.normalAt(x, z, _v3);
    o.nx = _v3.x; o.ny = _v3.y; o.nz = _v3.z;
    o.slope = clamp01(Math.acos(clamp(_v3.y, -1, 1)) / (Math.PI * 0.5));
    o.surface = this.surfaceAt(x, z);
    o.surfaceId = SURFACES.indexOf(o.surface);
    o.wet = this.wetnessAt(x, z);
    o.exposure = this.exposureAt(x, z);
    o.density = this.forestDensityAt(x, z);
    o.flow = this.flowAt(x, z);
    o.path = this.pathInfluenceAt(x, z);
    o.water = o.surface === 'water';
    return o;
  }

  /**
   * Stratified scatter helper so Forest / Props never duplicate ground-validity logic.
   * Samples a jittered grid across the world (even coverage, no clumping), builds a full
   * `sampleInfo` descriptor for each and keeps the ones `filterFn` accepts.
   *
   *   terrain.getSpawnCandidates(400, (p) => p.surface === 'needles' && p.slope < 0.30, rand)
   *
   * @param {number} count       how many accepted points you want
   * @param {(info:object)=>boolean} [filterFn]
   * @param {import('../core/Rand.js').Rand} [rand]  defaults to ctx.rand
   * @returns {object[]} up to `count` descriptors (fresh objects — init-time use, not per-frame)
   */
  getSpawnCandidates(count = 100, filterFn = null, rand = null) {
    const out = [];
    if (!this._h) return out;
    const r = rand ?? this.ctx?.rand ?? new Rand(this._seed ^ 0x5caa7e);
    const target = Math.max(1, count | 0);
    const cells = Math.max(2, Math.ceil(Math.sqrt(target * 2.2)));
    const cw = this.size / cells;
    const order = new Int32Array(cells * cells);
    for (let i = 0; i < order.length; i++) order[i] = i;
    // Fisher-Yates on the typed array (Rand.shuffle works on any indexable)
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(r.next() * (i + 1));
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }

    const maxAttempts = target * 40;
    let attempts = 0;
    for (let pass = 0; pass < 8 && out.length < target; pass++) {
      for (let k = 0; k < order.length; k++) {
        if (out.length >= target || attempts >= maxAttempts) break;
        attempts++;
        const c = order[k];
        const gx = c % cells, gz = (c / cells) | 0;
        const x = this.bounds.minX + (gx + r.next()) * cw;
        const z = this.bounds.minZ + (gz + r.next()) * cw;
        // Probe into the shared scratch: a scatter of 20 000 trees rejects far more points than
        // it keeps, and only the keepers are worth an object.
        const probe = this.sampleInfo(x, z, _infoScratch);
        if (filterFn) {
          let ok = false;
          try { ok = !!filterFn(probe); } catch (e) { Log.once('terrain:filter', 'Terrain.getSpawnCandidates filter threw', e); return out; }
          if (!ok) continue;
        }
        out.push({ ...probe });
      }
      if (attempts >= maxAttempts) break;
    }
    return out;
  }

  /** Nearest point on the ridge crest — Campers/Navmesh use this for the skyline check. */
  nearestRidgePoint(x, z, out) {
    const o = out ?? _v3b;
    if (!this.ridgeLine.length) return o.set(x, this.heightAt(x, z), z);
    let best = this.ridgeLine[0], bd = Infinity;
    for (const p of this.ridgeLine) {
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return o.copy(best);
  }

  // ===========================================================================================
  // FRAME
  // ===========================================================================================
  _bindEvents() {
    if (!this.bus?.on) return;
    const off = this.bus.on('weather:change', (p) => {
      if (!p) return;
      if (typeof p.rain === 'number') this._rainTarget = clamp01(p.rain);
      if (typeof p.wind === 'number') this._windTarget = clamp01(p.wind);
      const f = typeof p.fog === 'number' ? clamp01(p.fog) : 0.35;
      const U = this._uniforms;
      if (U) {
        U.uFogD0.value = 0.012 + 0.040 * f;
        U.uFogH.value = 4.2 + 4.2 * f;
        U.uFogNear.value.setHex(f > 0.7 ? 0x232d34 : 0x2a3a44);
        U.uFogFar.value.setHex(f > 0.7 ? 0x3d4c58 : 0x54697a);
      }
    });
    if (typeof off === 'function') this._unsub.push(off);
  }

  update(dt, _elapsed) {
    if (!this.ready) return;
    // A non-finite dt would poison uTime, and a NaN in a vertex shader turns the lake invisible.
    const d = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
    this._time += d;
    this._rain += (this._rainTarget - this._rain) * Math.min(1, d * 0.6);
    this._wind += (this._windTarget - this._wind) * Math.min(1, d * 0.5);

    const g = this._globalUniforms();
    const U = this._uniforms;
    if (U) {
      if (!g?.uTime) U.uTime.value = this._time;
      if (!g?.uRain) U.uRain.value = this._rain;
      // Wetness accumulates slowly over the night and never fully dries. When Materials is
      // present this uniform IS its uWetness — it owns the integrator, so we do not touch it.
      if (!g?.uWetness) {
        const wTarget = clamp01(0.22 + this._rain * 0.9);
        U.uWet.value += (wTarget - U.uWet.value) * Math.min(1, d * 0.03);
      }

      if (!this._fogResolved) {
        this._fogResolved = true;
        // Sky owns the aerial/distance term. If it installed scene.fog, stand down.
        if (this.ctx?.scene?.fog) U.uHeightFog.value = 0;
      }
    }
    // Materials.globalUniforms.uWind is a Vector3 (direction * strength, ~0..1.4); our water
    // and reeds want a scalar 0..1. Prefer it so the chop and the trees lean on the same gust.
    const gw = g?.uWind?.value;
    const wind = (gw && Number.isFinite(gw.x))
      ? clamp01(Math.hypot(gw.x, gw.y, gw.z) / 1.4)
      : this._wind;
    if (this._waterUniforms) {
      if (!g?.uTime) this._waterUniforms.uTime.value = this._time;
      if (!g?.uRain) this._waterUniforms.uRain.value = this._rain;
      this._waterUniforms.uWind.value = wind;
    }
    if (this._reedUniforms) {
      if (!g?.uTime) this._reedUniforms.uTime.value = this._time;
      this._reedUniforms.uWind.value = wind;
    }

    this._cull();
  }

  _cull() {
    const cam = this.ctx?.camera;
    if (!cam || !this._nodes?.length) return;

    cam.getWorldPosition(_camPos);
    _projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);

    for (let lv = 0; lv < this._nodes.length; lv++) {
      const list = this._nodes[lv].list;
      for (let i = 0; i < list.length; i++) list[i].mesh.visible = false;
    }

    this._drawn = 0;
    const roots = this._nodes[0].list;
    for (let i = 0; i < roots.length; i++) this._selectNode(roots[i], 0);

    this.stats.chunksDrawn = this._drawn;
    this.stats.drawCalls = this._drawn
      + (this.water ? 1 : 0)
      + (this.puddleMesh ? 1 : 0)
      + (this.reeds?.count > 0 ? 1 : 0)
      + (this.logMesh ? 1 : 0);
  }

  /** Hierarchical select: frustum-reject prunes whole subtrees; distance decides subdivision. */
  _selectNode(nd, level) {
    if (!_frustum.intersectsSphere(nd.sphere)) return;
    if (nd.leaf) { nd.mesh.visible = true; this._drawn++; return; }
    const dx = Math.max(nd.minX - _camPos.x, 0, _camPos.x - nd.maxX);
    const dz = Math.max(nd.minZ - _camPos.z, 0, _camPos.z - nd.maxZ);
    if (dx * dx + dz * dz >= this._radii[level] * this._radii[level]) {
      nd.mesh.visible = true; this._drawn++; return;
    }
    const c = nd.children;
    for (let i = 0; i < 4; i++) this._selectNode(c[i], level + 1);
  }

  resize(_w, _h) { /* resolution independent */ }

  dispose() {
    for (const u of this._unsub) { try { u(); } catch { /* noop */ } }
    this._unsub.length = 0;

    if (this.group) {
      this.group.parent?.remove(this.group);
      this.group.clear();
    }
    for (const d of this._disposables) {
      try { d?.dispose?.(); } catch (e) { Log.once('terrain:dispose', 'Terrain.dispose:', e); }
    }
    this._disposables.length = 0;
    this._nodes.length = 0;
    this._sharedIndex = null;

    this._h = this._surf = this._wet = this._dens = null;
    this._expo = this._flow = this._rock = this._path = this._flat = this._ao = null;
    this.material = this.waterMaterial = null;
    this.water = this.puddleMesh = this.reeds = this.logMesh = null;
    // Textures.js owns these render targets — drop the references, never dispose them.
    this._groundSets = null;
    this.texDetail = this.texNormal = null;
    this.group = null;
    this.ready = false;
  }
}

const _splatScratch = new Float64Array(5);

const _ridgeScratch = { x: -55, amp: 18 };
const _crRows = [0, 0, 0, 0];

export default Terrain;
