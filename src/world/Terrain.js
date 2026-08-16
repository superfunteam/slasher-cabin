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
const _fallbackNormal = new THREE.Vector3(0, 1, 0);
const _infoScratch = {
  x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0,
  slope: 0, surface: 'needles', surfaceId: 0,
  wet: 0, exposure: 1, density: 0, flow: 0, path: 0, water: false,
};

/** Canonical surface ids. surfaceAt() returns one of these strings. */
export const SURFACES = ['needles', 'mud', 'moss', 'granite', 'water', 'gravel'];
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

  chunkSize: 32,           // metres
  superChunkSize: 128,     // metres (far field)
  nearRadius: 136,         // beyond this, super-chunks replace 32 m chunks
  skirtDepth: 1.25,
  superSkirtDepth: 3.0,

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

  puddles: { max: 56, minSep: 7.0, minRadius: 0.55, maxRadius: 2.6, depthWindow: 0.16 },
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

/** Squared distance from point to segment, plus the parametric position. */
function segDist2(px, pz, ax, az, bx, bz, out) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = clamp01(t);
  const cx = ax + dx * t, cz = az + dz * t;
  const ex = px - cx, ez = pz - cz;
  if (out) { out.t = t; out.cx = cx; out.cz = cz; }
  return ex * ex + ez * ez;
}

const _segOut = { t: 0, cx: 0, cz: 0 };

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
    this.bounds = {
      minX: this.x0, maxX: this.x0 + size,
      minZ: this.z0, maxZ: this.z0 + size,
      minY: -12, maxY: 48,
      size,
      box: new THREE.Box3(new THREE.Vector3(this.x0, -12, this.z0),
        new THREE.Vector3(this.x0 + size, 48, this.z0 + size)),
    };
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
    this._chunks = [];
    this._superChunks = [];
    this._indexSets = [];
    this._superIndex = null;
    this._disposables = [];
    this._ownMaterial = true;

    this._uniforms = null;
    this._rainTarget = 0.15;
    this._rain = 0.15;
    this._windTarget = 0.2;
    this._wind = 0.2;
    this._time = 0;
    this._lodTimer = 0;
    this._lastCullPos = new THREE.Vector3(1e9, 1e9, 1e9);
    this._fogResolved = false;
    this._unsub = [];

    this.ready = false;
    this.stats = { chunksDrawn: 0, superDrawn: 0, drawCalls: 0, genMs: 0 };
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
    Log.debug(`Terrain: ${this.n}x${this.n} field, ${this._chunks.length} chunks, ` +
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
    // steep west scarp (sigma 22), long east dip-slope (sigma 47)
    const sigma = dx < 0 ? 22.0 : 47.0;
    let ridgeProfile = Math.exp(-Math.pow(dx / sigma, 1.75));
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

        // 3 octaves of full-res detail. Amplitude tapers into the lake so the bed stays smooth.
        const shoreFade = smoothstep(-4, 16, z - this._shoreZ(x));
        const d = (fbm(x * 0.055, z * 0.055, 3, s + 61) - 0.5) * 1.55
          + (fbm(x * 0.21, z * 0.21, 2, s + 67) - 0.5) * 0.42;
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

    // spatial bucket for the stream so the per-cell query is O(1)-ish
    const streamGrid = this._bucketPolyline(stream, 16);

    // ---- write pass -------------------------------------------------------------------------
    for (let j = 0; j < n; j++) {
      const z = this.z0 + j * T.cell;
      for (let i = 0; i < n; i++) {
        const x = this.x0 + i * T.cell;
        const idx = j * n + i;
        let hv = h[idx];

        // --- stream valley + channel ---
        const sp = this._nearestBucketed(streamGrid, x, z, 34);
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
        const jitter = fbm(x * 0.07, z * 0.07, 3, s + 201) - 0.5;
        let type;
        if (depth > 0.0) {
          type = S_WATER;
        } else if (overWater < 1.15 + jitter * 0.8 && slope01 < 0.30) {
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
        w += (fbm(x * 0.09, z * 0.09, 3, s + 313) - 0.5) * 0.22;
        wet[idx] = Math.round(clamp01(w) * 255);

        // ---------------- forest density (Forest.js reads this) ----------------
        let d = fbm(x * 0.0072 + 4.3, z * 0.0072 - 2.7, 4, s + 401);
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
    const stride = 3;

    for (let j = 6; j < n - 6; j += stride) {
      const z = this.z0 + j * T.cell;
      for (let i = 6; i < n - 6; i += stride) {
        const idx = j * n + i;
        const hv = h[idx];
        if (hv < wl + 0.6) continue;                 // in / next to the lake
        if (surf[idx] === S_GRANITE) continue;
        if (flow[idx] < 0.12 && wet[idx] < 96) continue;

        // local minimum over a 5-cell neighbourhood
        let isMin = true;
        for (let dz = -2; dz <= 2 && isMin; dz++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (h[idx + dz * n + dx] < hv - 1e-4) { isMin = false; break; }
          }
        }
        if (!isMin) continue;

        // rim: how far can we grow before we climb out of the depression?
        let radius = 0;
        for (let r = 1; r <= 4; r++) {
          let maxRise = 0;
          for (let a = 0; a < 8; a++) {
            const ang = (a / 8) * Math.PI * 2;
            const sx = Math.round(i + Math.cos(ang) * r);
            const sz = Math.round(j + Math.sin(ang) * r);
            const d = h[sz * n + sx] - hv;
            if (d > maxRise) maxRise = d;
          }
          if (maxRise < P.depthWindow * r * 0.9) radius = r; else break;
        }
        if (radius < 1) continue;

        const x = this.x0 + i * T.cell;
        let tooClose = false;
        for (const p of found) {
          if ((p.x - x) ** 2 + (p.z - z) ** 2 < P.minSep * P.minSep) { tooClose = true; break; }
        }
        if (tooClose) continue;

        const rr = clamp(radius * 0.72 + flow[idx] * 1.4, P.minRadius, P.maxRadius);
        found.push({ x, z, y: hv + 0.025, r: rr, score: flow[idx] + wet[idx] / 255 });
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
    this.campCenter.y = this.heightAt(this.campCenter.x, this.campCenter.z);
    this.buildSiteCenter.y = this.heightAt(this.buildSiteCenter.x, this.buildSiteCenter.z);
    this.latrine.y = this.heightAt(this.latrine.x, this.latrine.z);
    this.dock.y = this.heightAt(this.dock.x, this.dock.z);

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

  // /*__PART3__*/
}

const _ridgeScratch = { x: -55, amp: 18 };
const _crRows = [0, 0, 0, 0];

export default Terrain;
