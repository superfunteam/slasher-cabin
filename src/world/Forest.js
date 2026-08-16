/**
 * THE FOREST — procedural tree meshes, variable-radius Poisson placement, chunked frustum
 * culling, 3 LOD levels + a cross-card impostor, undergrowth, and per-instance wind phase.
 *
 * OWNER: World agent. See ARCHITECTURE.md §9/§12 and ART_DIRECTION.md §2.2 (bark/foliage
 * swatches), §3.5 (what casts), §10 failure mode A2 (the "same tree stamped everywhere" tell).
 *
 * ---------------------------------------------------------------------------------------
 * PUBLIC API
 * ---------------------------------------------------------------------------------------
 *   const forest = ctx.systems.get('Forest');
 *
 *   forest.occludersNear(position, radius)   -> Array<{x,y,z,radius,height}>
 *       Trunks whose axis is within `radius` metres of `position` in XZ. NoiseSystem and
 *       Campers use this for sound occlusion and line of sight.
 *       !! The returned array AND its entries are POOLED and reused by the next call.
 *          Read them before you call again; never retain them.
 *   forest.densityAt(x, z)  -> 0..1   canopy density (NoiseSystem reads this)
 *   forest.canopyAt(x, z)   -> 0..1   same field (Weather reads this for drip / shelter)
 *   forest.treeAt(i, out)   -> {x,y,z,radius,height,species} for a tree index
 *   forest.setEnabled(bool)
 *   forest.treeCount / forest.stats
 *
 *   Lifecycle: constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose().
 *
 * ---------------------------------------------------------------------------------------
 * HOW THE DRAW-CALL BUDGET IS MET (< 120 for the whole forest)
 * ---------------------------------------------------------------------------------------
 * One InstancedMesh per (species, variant, LOD) for bark and one for foliage — but the
 * variant count collapses as distance grows, because at 80 m nobody can tell two firs apart:
 *
 *   LOD0  0 – 34 m    per-variant   3 leafy species x V x 2 parts  + snag x V x 1
 *   LOD1  34 – 78 m   2 groups      4 species x 2 x (2 or 1)
 *   LOD2  78 – 165 m  1 group       4 species x 1 x (2 or 1)
 *   IMP   165 m +     1 per species 4
 *   undergrowth                     16
 *
 * V = settings.tier(3, 4, 5, 6). Ultra worst case is 42 + 14 + 7 + 4 + 16 = 83, and in
 * practice most LOD0 buckets are empty (a 34 m disc holds ~90 trees across 24 buckets), so a
 * bucket with count 0 is `visible = false` and costs nothing.
 *
 * The visible set is rebuilt only when the camera moves > 1 m or turns > ~3.5 deg (or every
 * 12 frames), by copying pre-baked 16-float matrices — no Matrix4.compose() per frame, no
 * allocation. Chunks are 32 m with a bounding sphere and a per-chunk frustum test.
 *
 * ---------------------------------------------------------------------------------------
 * THINGS OTHER AGENTS SHOULD KNOW
 * ---------------------------------------------------------------------------------------
 *  - Bark and foliage of the same bucket SHARE one `instanceMatrix` object. Do not write to
 *    `mesh.instanceMatrix` from outside; you would move the leaves off the branches.
 *  - Every bucket carries `aWind` (x = flex override, y = phase) and `aExposure` as
 *    InstancedBufferAttributes, per the Materials.js contract. Bark uses flex 0 so the trunk
 *    bends by height; foliage uses a flat 0.45 so a canopy card does not fly 1 m in a gust.
 *  - Trunks are registered with Physics as 'trunk' capsules (height capped at 8 m — sight and
 *    movement only care about the bottom of the tree, and an uncapped 30 m AABB bloats the
 *    broadphase). Handles are released in dispose().
 *  - There is NO GLSL in this file. All shading comes from Materials.get(); if Materials is
 *    missing we fall back to plain MeshStandardMaterials and the forest still renders.
 */

import * as THREE from 'three';
import { Log } from '../core/Log.js';
import { Rand, hashInt, fbm2 } from '../core/Rand.js';

/* ======================================================================================
 * Module-scope scratch — ARCHITECTURE.md §12: no allocation in update().
 * ==================================================================================== */
const _v3 = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _camQuat = new THREE.Quaternion();
const _playerPos = new THREE.Vector3();
const _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _info = {
  x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, slope: 0,
  surface: 'needles', surfaceId: 0, wet: 0, exposure: 1,
  density: 0, flow: 0, path: 0, water: false,
};

const TAU = Math.PI * 2;
/** Golden angle. Real phyllotaxis, ~137.507 degrees. */
const PHYLLO = 2.39996322972865332;

const SP_FIR = 0, SP_PINE = 1, SP_BIRCH = 2, SP_SNAG = 3;
const SPECIES_COUNT = 4;
const SPECIES_NAME = ['fir', 'pine', 'birch', 'snag'];
/** Material keys per species: [bark, foliage|null]. */
const SPECIES_MATS = [
  ['bark-pine', 'foliage-pine'],
  ['bark-pine', 'foliage-pine'],
  ['bark-birch', 'foliage-fern'],
  ['weathered-wood', null],
];

/** Every tunable in one object. */
export const FOREST_TUNING = {
  chunkSize: 32,
  rMin: 3.1,               // densest spacing, metres
  rMax: 11.5,              // thinnest spacing before it reads as a clearing
  lod0: 34, lod1: 78, lod2: 165,
  shadowRange: 34,         // LOD0 band == the cast-shadow band (ART §3.5 "trees < 40 m")
  lodJitter: 0.14,         // per-tree +/- on the LOD rings so the transition is not an arc
  undergrowthChunksPerFrame: 3,
  rebuildMoveEps: 1.0,     // metres
  rebuildTurnEps: 0.06,    // quaternion delta
  rebuildMaxFrames: 12,
  colliderCap: 14000,
  colliderHeightCap: 8.0,
  canopyCell: 4.0,
};
const FT = FOREST_TUNING;

/* ======================================================================================
 * Small math helpers
 * ==================================================================================== */
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function smooth01(a, b, x) {
  if (b === a) return x >= b ? 1 : 0;
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
function lerp(a, b, t) { return a + (b - a) * t; }

/* ======================================================================================
 * Geometry buffer — a tiny init-time mesh accumulator.
 * ==================================================================================== */
class Buf {
  constructor() { this.p = []; this.n = []; this.u = []; this.idx = []; }
  get count() { return this.p.length / 3; }
  get empty() { return this.idx.length === 0; }
  push(x, y, z, nx, ny, nz, u, v) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.u.push(u, v);
    return (this.p.length / 3) - 1;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  toGeometry(name) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    const Big = this.p.length / 3 > 65530;
    g.setIndex(Big ? new THREE.Uint32BufferAttribute(this.idx, 1)
      : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    g.name = name;
    return g;
  }
}

/**
 * Sweep a tapered tube along a polyline with a parallel-transport frame.
 * UVs are in METRES (Materials.js contract): u = arc around the girth, v = arc along.
 *
 * opts:
 *   flare   {h, amp, lobes, phase}  root buttress: widens and lobes the bottom `h` metres
 *   bark    radial noise amplitude, fraction of radius
 *   cap     close the far end with a fan
 *   uvCirc  girth in metres used for u (defaults to the base circumference)
 *   upOnly  {min, offset}  emit ONLY the quads whose normal points up — moss on a log
 */
function emitTube(buf, pts, radii, sides, opts = {}) {
  const n = pts.length;
  if (n < 2 || sides < 3) return;

  const tans = [];
  for (let i = 0; i < n; i++) {
    const t = new THREE.Vector3();
    if (i === 0) t.subVectors(pts[1], pts[0]);
    else if (i === n - 1) t.subVectors(pts[n - 1], pts[n - 2]);
    else t.subVectors(pts[i + 1], pts[i - 1]);
    if (t.lengthSq() < 1e-12) t.set(0, 1, 0);
    tans.push(t.normalize());
  }

  const nors = [], bins = [];
  let nr = new THREE.Vector3();
  {
    const t0 = tans[0];
    const ref = Math.abs(t0.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    nr.crossVectors(ref, t0);
    if (nr.lengthSq() < 1e-10) nr.set(1, 0, 0);
    nr.normalize();
  }
  const q = new THREE.Quaternion();
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      q.setFromUnitVectors(tans[i - 1], tans[i]);
      nr = nr.clone().applyQuaternion(q);
      nr.addScaledVector(tans[i], -nr.dot(tans[i]));
      if (nr.lengthSq() < 1e-10) {
        const ref = Math.abs(tans[i].y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        nr.crossVectors(ref, tans[i]);
      }
      nr.normalize();
    }
    nors.push(nr.clone());
    bins.push(new THREE.Vector3().crossVectors(tans[i], nr).normalize());
  }

  const arc = [0];
  for (let i = 1; i < n; i++) arc.push(arc[i - 1] + pts[i].distanceTo(pts[i - 1]));

  const circ = opts.uvCirc ?? (TAU * Math.max(radii[0], 0.02));
  const flare = opts.flare || null;
  const barkAmp = opts.bark ?? 0;
  const upOnly = opts.upOnly || null;
  const offset = upOnly ? (upOnly.offset ?? 0) : 0;
  const base = buf.count;
  const stride = sides + 1;
  const nyOf = upOnly ? new Float32Array(n * stride) : null;

  for (let i = 0; i < n; i++) {
    const P = pts[i], N = nors[i], B = bins[i], T = tans[i];
    const i1 = Math.min(n - 1, i + 1), i0 = Math.max(0, i - 1);
    const dr = radii[i1] - radii[i0];
    const ds = Math.max(1e-4, arc[i1] - arc[i0]);
    const slope = dr / ds;
    for (let j = 0; j <= sides; j++) {
      const a = ((j % sides) / sides) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      let rr = radii[i];
      if (flare && flare.h > 0) {
        const k = 1 - clamp01(P.y / flare.h);
        if (k > 0) {
          const lobe = 0.5 + 0.5 * Math.cos(a * flare.lobes + flare.phase);
          rr *= 1 + flare.amp * k * k * (0.35 + 0.65 * lobe);
        }
      }
      if (barkAmp > 0) {
        rr *= 1 + barkAmp * (Math.sin(a * 5.0 + arc[i] * 2.7) * 0.55
          + Math.sin(a * 11.0 - arc[i] * 4.3) * 0.3);
      }
      rr += offset;
      const rx = N.x * ca + B.x * sa, ry = N.y * ca + B.y * sa, rz = N.z * ca + B.z * sa;
      let nx = rx - T.x * slope, ny = ry - T.y * slope, nz = rz - T.z * slope;
      const il = 1 / Math.max(1e-6, Math.hypot(nx, ny, nz));
      nx *= il; ny *= il; nz *= il;
      if (nyOf) nyOf[i * stride + j] = ny;
      buf.push(P.x + rx * rr, P.y + ry * rr, P.z + rz * rr, nx, ny, nz,
        (j / sides) * circ, arc[i]);
    }
  }

  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const a0 = base + i * stride + j;
      if (nyOf) {
        const m = (nyOf[i * stride + j] + nyOf[i * stride + j + 1]
          + nyOf[(i + 1) * stride + j] + nyOf[(i + 1) * stride + j + 1]) * 0.25;
        if (m < (upOnly.min ?? 0.15)) continue;
      }
      buf.quad(a0, a0 + 1, a0 + stride + 1, a0 + stride);
    }
  }

  if (opts.cap) {
    const P = pts[n - 1], T = tans[n - 1];
    const r = radii[n - 1];
    const tip = buf.push(P.x + T.x * r * 1.6, P.y + T.y * r * 1.6, P.z + T.z * r * 1.6,
      T.x, T.y, T.z, circ * 0.5, arc[n - 1] + r);
    const ring0 = base + (n - 1) * stride;
    for (let j = 0; j < sides; j++) buf.tri(ring0 + j, ring0 + j + 1, tip);
  }
}

/**
 * One alpha card. Anchored at its BASE so the foliage art (which is drawn base-at-v0)
 * grows the right way up. `taper` narrows the tip.
 */
function emitCard(buf, bx, by, bz, ux, uy, uz, sx, sy, sz, w, h, nx, ny, nz, taper = 0.55) {
  const hw = w * 0.5, tw = hw * taper;
  const tx = bx + ux * h, ty = by + uy * h, tz = bz + uz * h;
  const i0 = buf.push(bx - sx * hw, by - sy * hw, bz - sz * hw, nx, ny, nz, 0, 0);
  const i1 = buf.push(bx + sx * hw, by + sy * hw, bz + sz * hw, nx, ny, nz, 1, 0);
  const i2 = buf.push(tx + sx * tw, ty + sy * tw, tz + sz * tw, nx, ny, nz, 1, 1);
  const i3 = buf.push(tx - sx * tw, ty - sy * tw, tz - sz * tw, nx, ny, nz, 0, 1);
  buf.quad(i0, i1, i2, i3);
}

/** Two cards crossed about the growth axis — the cheapest thing that reads as volume. */
function emitCross(buf, p, up, side, w, h, nrm, taper = 0.55) {
  emitCard(buf, p.x, p.y, p.z, up.x, up.y, up.z, side.x, side.y, side.z,
    w, h, nrm.x, nrm.y, nrm.z, taper);
  const s2x = up.y * side.z - up.z * side.y;
  const s2y = up.z * side.x - up.x * side.z;
  const s2z = up.x * side.y - up.y * side.x;
  const l = 1 / Math.max(1e-6, Math.hypot(s2x, s2y, s2z));
  emitCard(buf, p.x, p.y, p.z, up.x, up.y, up.z, s2x * l, s2y * l, s2z * l,
    w, h, nrm.x, nrm.y, nrm.z, taper);
}

export class Forest {
  constructor(ctx) {
    this.ctx = ctx ?? null;
    this.bus = ctx?.bus ?? null;
    this.scene = ctx?.scene ?? null;

    this.enabled = true;
    this.ready = false;
    this._disposed = false;

    this.group = null;
    this.terrain = null;
    this.mats = null;
    this.physics = null;

    // per-tree arrays (parallel, index = tree id)
    this._n = 0;
    this._tx = null; this._ty = null; this._tz = null;
    this._tmat = null;          // Float32Array(16 * n), pre-composed
    this._tspec = null;         // Uint8Array species
    this._tvar = null;          // Uint8Array variant
    this._trad = null;          // trunk radius at base, world metres
    this._thgt = null;          // total height, world metres
    this._tphase = null;        // wind phase 0..1
    this._texpo = null;         // sky exposure 0..1
    this._tjit = null;          // LOD ring jitter multiplier

    this._chunks = [];
    this._chunkIndex = null;    // Map key -> chunk
    this._cnx = 0; this._cnz = 0; this._cx0 = 0; this._cz0 = 0;

    this._buckets = [];         // every renderable bucket, trees + undergrowth
    this._treeBuckets = null;   // [species][lod][variant] -> bucket
    this._ugBuckets = null;     // [type][variant] -> bucket

    this._ownedGeometries = [];
    this._ownedMaterials = [];
    this._ownedTextures = [];
    this._colliders = [];
    this._unsub = [];

    // canopy field
    this._cgN = 0; this._cgCell = FT.canopyCell; this._cgX0 = 0; this._cgZ0 = 0;
    this._canopy = null;

    // rebuild bookkeeping
    this._lastCamPos = new THREE.Vector3(1e9, 1e9, 1e9);
    this._lastCamQuat = new THREE.Quaternion(2, 0, 0, 0);
    this._framesSinceRebuild = 999;
    this._ugLastPos = new THREE.Vector3(1e9, 1e9, 1e9);
    this._ugQueue = [];
    this._ugRadius = 40;

    // occluder query pool
    this._occOut = [];
    this._occPool = [];

    this._variants = 4;
    this._time = 0;

    this.stats = {
      trees: 0, visible: 0, drawCalls: 0, chunks: 0, chunksVisible: 0,
      undergrowth: 0, rebuilds: 0, genMs: 0, buildMs: 0,
    };
  }

  get treeCount() { return this._n; }

  // =========================================================================================
  // init
  // =========================================================================================
  async init() {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    try {
      this._readSystems();
      this._variants = this.ctx?.settings?.tier?.(3, 4, 5, 6) ?? 5;

      this.group = new THREE.Group();
      this.group.name = 'Forest';
      this.group.matrixAutoUpdate = false;
      this.group.updateMatrix();
      if (this.scene) this.scene.add(this.group);

      const seed = (this.ctx?.settings?.get?.('seed') ?? 0x51a5cab) | 0;
      const rand = new Rand(hashInt(seed ^ 0x0f0235) | 0);

      this._buildCanopyGrid();
      this._placeTrees(rand);
      this._buildChunks();
      this._bakeCanopy();
      this._buildTreeBuckets(new Rand(hashInt(seed ^ 0x7ee511) | 0));
      this._buildUndergrowthBuckets(new Rand(hashInt(seed ^ 0x9a1177) | 0));
      this._registerColliders();
      this._bindEvents();

      this._ugRadius = this.ctx?.settings?.tier?.(22, 30, 38, 46) ?? 38;
      this._pregenUndergrowth();

      this.ready = true;
      this.stats.trees = this._n;
      this.stats.chunks = this._chunks.length;
      this.stats.genMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
      Log.debug(`Forest: ${this._n} trees, ${this._chunks.length} chunks, `
        + `${this._buckets.length} buckets, ${this.stats.genMs.toFixed(0)} ms`);
    } catch (e) {
      Log.error('Forest: init failed — the world will be bare but playable.', e);
      this.ready = false;
    }
  }

  _readSystems() {
    const sys = this.ctx?.systems;
    this.terrain = sys?.get?.('Terrain') ?? null;
    this.mats = sys?.get?.('Materials') ?? null;
    this.physics = sys?.get?.('Physics') ?? null;
    if (!this.terrain) Log.warn('Forest: no Terrain — planting on a flat plane.');
  }

  _bindEvents() {
    if (typeof this.bus?.on !== 'function') return;
    const off = this.bus.on('game:resume', () => { this._framesSinceRebuild = 999; });
    if (typeof off === 'function') this._unsub.push(off);
  }

  /**
   * A material from the shared library, or a local stand-in so the forest still renders when
   * Materials is missing. Locally-made materials are owned and disposed by us.
   */
  _material(name, fallback) {
    try {
      const m = this.mats?.get?.(name);
      if (m && m.isMaterial) return m;
    } catch (e) { Log.once('forest:mat', 'Forest: Materials.get failed', e); }
    const mat = new THREE.MeshStandardMaterial({
      color: fallback?.color ?? 0x2a2a24,
      roughness: fallback?.roughness ?? 0.9,
      metalness: 0.0,
      side: fallback?.side ?? THREE.FrontSide,
      alphaTest: fallback?.alphaTest ?? 0,
      transparent: false,
      name: `forest-fallback-${name}`,
    });
    this._ownedMaterials.push(mat);
    return mat;
  }

  _depthMaterial(name) {
    try { return this.mats?.getDepthMaterial?.(name) ?? null; }
    catch { return null; }
  }

  // =========================================================================================
  // PLACEMENT — variable-radius Poisson disc (Bridson), density-driven
  // =========================================================================================

  _worldBounds() {
    const b = this.terrain?.bounds;
    if (b && Number.isFinite(b.minX)) {
      return { minX: b.minX, minZ: b.minZ, sizeX: b.maxX - b.minX, sizeZ: b.maxZ - b.minZ };
    }
    return { minX: -256, minZ: -256, sizeX: 512, sizeZ: 512 };
  }

  _buildCanopyGrid() {
    const W = this._worldBounds();
    this._cgCell = FT.canopyCell;
    this._cgX0 = W.minX; this._cgZ0 = W.minZ;
    this._cgN = Math.ceil(Math.max(W.sizeX, W.sizeZ) / this._cgCell) + 1;
    this._canopy = new Float32Array(this._cgN * this._cgN);
  }

  /**
   * Spacing at a point, in metres. Returns -1 where a tree may not stand at all: water,
   * steep granite, worn paths, the camp clearing, the build pad, the dock.
   */
  _spacingAt(x, z) {
    const T = this.terrain;
    let y = 0, slope = 0, path = 0, dens = 0.55, surf = 'needles', water = false;
    if (T) {
      const p = T.sampleInfo(x, z, _info);
      y = p.y; slope = p.slope; path = p.path; dens = p.density;
      surf = p.surface; water = p.water;
    } else {
      y = 2 + fbm2(x * 0.01, z * 0.01, 3, 2.0, 0.5) * 6;
      dens = clamp01(0.35 + fbm2(x * 0.02 + 5, z * 0.02 - 3, 3, 2.0, 0.5));
    }
    const wl = T?.waterLevel ?? 0;
    if (water || y < wl + 0.30) return -1;
    if (slope > 0.46) return -1;
    if (path > 0.40) return -1;
    if (surf === 'gravel') return -1;

    const camp = T?.campCenter;
    let campFeather = 1;
    if (camp) {
      const cR = T?.campRadius ?? 46;
      const dc = Math.hypot(x - camp.x, z - camp.z);
      if (dc < cR * 0.94) return -1;
      campFeather = smooth01(cR * 0.94, cR * 1.72, dc);
    }
    const pad = T?.buildSiteCenter;
    let padFeather = 1;
    if (pad) {
      const inner = (T?.buildPadHalf ?? 12) + 7.5 + 3.5;
      const dp = Math.hypot(x - pad.x, z - pad.z);
      if (dp < inner) return -1;
      padFeather = smooth01(inner, inner + 28, dp);
    }
    const dock = T?.dock;
    if (dock && Math.hypot(x - dock.x, z - dock.z) < 11) return -1;

    // Clumps and gaps. A uniform field is the thing that reads as a video game.
    let d = dens;
    d *= clamp(0.34 + 1.05 * fbm2(x * 0.021 + 11.3, z * 0.021 - 7.9, 4, 2.0, 0.5), 0.05, 1.5);
    // thinner along the shore, thicker as the ground rises to the ridge
    d *= 0.46 + 0.54 * smooth01(wl + 0.4, wl + 4.0, y);
    d *= 0.84 + 0.52 * smooth01(6, 24, y);
    d *= campFeather * padFeather;
    d *= 1 - 0.75 * path;
    if (surf === 'granite') d *= 0.24;
    else if (surf === 'moss') d *= 1.12;
    else if (surf === 'mud') d *= 0.72;
    d *= 1 - 0.55 * smooth01(0.26, 0.46, slope);
    d = clamp01(d);
    return FT.rMin + (FT.rMax - FT.rMin) * Math.pow(1 - d, 1.35);
  }

  /** Species weights vary with the ground: birch by water, pine and snags on the exposed rise. */
  _pickSpecies(rand, y, exposure, wet) {
    const wl = this.terrain?.waterLevel ?? 0;
    const low = 1 - smooth01(wl + 0.5, wl + 7.0, y);
    const high = smooth01(8, 26, y);
    let wFir = 0.50 + 0.16 * low - 0.14 * high;
    let wPine = 0.34 - 0.14 * low + 0.20 * high;
    let wBirch = 0.06 + 0.10 * low + 0.05 * wet;
    let wSnag = 0.09 + 0.07 * high * exposure;
    const s = wFir + wPine + wBirch + wSnag;
    let r = rand.next() * s;
    if ((r -= wFir) < 0) return SP_FIR;
    if ((r -= wPine) < 0) return SP_PINE;
    if ((r -= wBirch) < 0) return SP_BIRCH;
    return SP_SNAG;
  }

  _placeTrees(rand) {
    const W = this._worldBounds();
    const cell = FT.rMax;
    const gnx = Math.max(1, Math.ceil(W.sizeX / cell));
    const gnz = Math.max(1, Math.ceil(W.sizeZ / cell));
    const grid = new Array(gnx * gnz);
    const px = [], pz = [], pr = [];
    const active = [];

    const tryInsert = (x, z) => {
      if (x < W.minX || x >= W.minX + W.sizeX || z < W.minZ || z >= W.minZ + W.sizeZ) return -1;
      const r = this._spacingAt(x, z);
      if (!(r > 0)) return -1;
      const gx = clamp(((x - W.minX) / cell) | 0, 0, gnx - 1);
      const gz = clamp(((z - W.minZ) / cell) | 0, 0, gnz - 1);
      for (let b = -1; b <= 1; b++) {
        const cz = gz + b; if (cz < 0 || cz >= gnz) continue;
        for (let a = -1; a <= 1; a++) {
          const cx = gx + a; if (cx < 0 || cx >= gnx) continue;
          const list = grid[cz * gnx + cx];
          if (!list) continue;
          for (let k = 0; k < list.length; k++) {
            const qd = list[k];
            const dx = px[qd] - x, dz = pz[qd] - z;
            const need = r > pr[qd] ? r : pr[qd];
            if (dx * dx + dz * dz < need * need) return -1;
          }
        }
      }
      const id = px.length;
      px.push(x); pz.push(z); pr.push(r);
      const gi = gz * gnx + gx;
      if (!grid[gi]) grid[gi] = [];
      grid[gi].push(id);
      return id;
    };

    // Seeds spread across the map so a clearing cannot split the frontier in two.
    for (let s = 0; s < 320; s++) {
      const id = tryInsert(W.minX + rand.next() * W.sizeX, W.minZ + rand.next() * W.sizeZ);
      if (id >= 0) active.push(id);
    }
    let guard = 0;
    while (active.length && guard++ < 600000) {
      const ai = (rand.next() * active.length) | 0;
      const idx = active[ai];
      const r0 = pr[idx];
      let placed = false;
      for (let k = 0; k < 10; k++) {
        const ang = rand.next() * TAU;
        const rad = r0 * (1 + rand.next());
        const nid = tryInsert(px[idx] + Math.cos(ang) * rad, pz[idx] + Math.sin(ang) * rad);
        if (nid >= 0) { active.push(nid); placed = true; break; }
      }
      if (!placed) { active[ai] = active[active.length - 1]; active.pop(); }
    }

    // ---- bake per-tree records ---------------------------------------------------------
    const n = px.length;
    this._n = n;
    this._tx = new Float32Array(n); this._ty = new Float32Array(n); this._tz = new Float32Array(n);
    this._tmat = new Float32Array(n * 16);
    this._tspec = new Uint8Array(n); this._tvar = new Uint8Array(n);
    this._trad = new Float32Array(n); this._thgt = new Float32Array(n);
    this._tphase = new Float32Array(n); this._texpo = new Float32Array(n);
    this._tjit = new Float32Array(n);

    const T = this.terrain;
    const m = new THREE.Matrix4();
    const qTilt = new THREE.Quaternion();
    const qYaw = new THREE.Quaternion();
    const qOut = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const nrm = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const prevailing = 2.05;   // downwind lean bias, radians

    for (let i = 0; i < n; i++) {
      const x = px[i], z = pz[i];
      const y = T ? T.heightAt(x, z) : 0;
      const expo = T ? T.exposureAt(x, z) : 1;
      const wet = T ? T.wetnessAt(x, z) : 0.3;
      const spec = this._pickSpecies(rand, y, expo, wet);
      const variant = rand.int(0, this._variants - 1);

      // ART §10 A2: per-instance height gauss(19, 5.5) clamped [7, 34], radius correlated.
      let hTarget = clamp(rand.gauss(19, 5.5), 7, 34);
      if (spec === SP_PINE) hTarget *= 1.06;
      else if (spec === SP_BIRCH) hTarget *= 0.62;
      else if (spec === SP_SNAG) hTarget *= 0.66;
      // spacing correlates with size: a tree with room grows bigger
      hTarget *= 0.82 + 0.34 * smooth01(FT.rMin, FT.rMax, pr[i]);

      this._tx[i] = x; this._ty[i] = y; this._tz[i] = z;
      this._tspec[i] = spec; this._tvar[i] = variant;
      this._thgt[i] = hTarget;
      this._tphase[i] = rand.next();
      this._texpo[i] = clamp01(expo);
      this._tjit[i] = 1 + (rand.next() * 2 - 1) * FT.lodJitter;

      // tilt: 32% toward the ground normal, plus a downwind bias and a little noise
      if (T) T.normalAt(x, z, nrm); else nrm.set(0, 1, 0);
      _v3.set(lerp(0, nrm.x, 0.32) + Math.cos(prevailing) * rand.range(0.0, 0.055),
        1,
        lerp(0, nrm.z, 0.32) + Math.sin(prevailing) * rand.range(0.0, 0.055)).normalize();
      qTilt.setFromUnitVectors(up, _v3);
      qYaw.setFromAxisAngle(up, rand.next() * TAU);
      qOut.copy(qTilt).multiply(qYaw);
      pos.set(x, y - 0.10, z);
      scl.set(1, 1, 1);
      m.compose(pos, qOut, scl);
      m.toArray(this._tmat, i * 16);
    }

    // scale is folded in once the variant meshes exist (init order): store target heights now
    this._treeScaleResolved = false;
  }

  /**
   * Fold the per-instance scale into the baked matrices once variant heights are known.
   * scale = targetHeight / variantHeight, clamped so no instance reads as a bonsai or a giant.
   */
  _resolveScales(variantHeights) {
    const n = this._n;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const spec = this._tspec[i], v = this._tvar[i];
      const hv = variantHeights[spec]?.[v] ?? 20;
      const rv = variantHeights[spec]?.radii?.[v] ?? 0.35;
      let sc = clamp(this._thgt[i] / Math.max(1, hv), 0.55, 1.7);
      m.fromArray(this._tmat, i * 16);
      m.decompose(p, q, s);
      s.set(sc, sc, sc);
      m.compose(p, q, s);
      m.toArray(this._tmat, i * 16);
      this._thgt[i] = hv * sc;
      this._trad[i] = rv * sc;
    }
    this._treeScaleResolved = true;
  }

  _buildChunks() {
    const W = this._worldBounds();
    const cs = FT.chunkSize;
    this._cx0 = W.minX; this._cz0 = W.minZ;
    this._cnx = Math.max(1, Math.ceil(W.sizeX / cs));
    this._cnz = Math.max(1, Math.ceil(W.sizeZ / cs));
    const counts = new Int32Array(this._cnx * this._cnz);
    const ci = new Int32Array(this._n);
    for (let i = 0; i < this._n; i++) {
      const cx = clamp(((this._tx[i] - this._cx0) / cs) | 0, 0, this._cnx - 1);
      const cz = clamp(((this._tz[i] - this._cz0) / cs) | 0, 0, this._cnz - 1);
      const k = cz * this._cnx + cx;
      ci[i] = k; counts[k]++;
    }
    this._chunks = new Array(this._cnx * this._cnz);
    for (let k = 0; k < this._chunks.length; k++) {
      const cx = k % this._cnx, cz = (k / this._cnx) | 0;
      this._chunks[k] = {
        k, cx, cz,
        x: this._cx0 + (cx + 0.5) * cs,
        z: this._cz0 + (cz + 0.5) * cs,
        y: 0, r: cs * 0.75,
        trees: counts[k] > 0 ? new Int32Array(counts[k]) : null,
        fill: 0,
        ug: null, ugPending: false,
      };
    }
    for (let i = 0; i < this._n; i++) {
      const c = this._chunks[ci[i]];
      c.trees[c.fill++] = i;
    }
    // bounding spheres that actually contain the crowns
    for (const c of this._chunks) {
      if (!c.trees) {
        c.y = this.terrain ? this.terrain.heightAt(c.x, c.z) : 0;
        continue;
      }
      let minY = Infinity, maxY = -Infinity;
      for (let t = 0; t < c.trees.length; t++) {
        const i = c.trees[t];
        const b = this._ty[i], h = this._thgt[i] || 24;
        if (b < minY) minY = b;
        if (b + h > maxY) maxY = b + h;
      }
      c.y = (minY + maxY) * 0.5;
      const halfY = (maxY - minY) * 0.5;
      c.r = Math.hypot(FT.chunkSize * 0.75, halfY) + 2;
    }
  }

  _bakeCanopy() {
    const g = this._canopy;
    if (!g) return;
    const N = this._cgN, cell = this._cgCell;
    for (let i = 0; i < this._n; i++) {
      if (this._tspec[i] === SP_SNAG) continue;
      const h = this._thgt[i] || 20;
      const rc = h * (this._tspec[i] === SP_BIRCH ? 0.34 : 0.27);
      const gx = (this._tx[i] - this._cgX0) / cell;
      const gz = (this._tz[i] - this._cgZ0) / cell;
      const rr = rc / cell;
      const x0 = Math.max(0, Math.floor(gx - rr)), x1 = Math.min(N - 1, Math.ceil(gx + rr));
      const z0 = Math.max(0, Math.floor(gz - rr)), z1 = Math.min(N - 1, Math.ceil(gz + rr));
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x - gx, z - gz) / Math.max(0.001, rr);
          if (d > 1) continue;
          g[z * N + x] += (1 - d * d) * 1.0;
        }
      }
    }
    for (let i = 0; i < g.length; i++) g[i] = clamp01(g[i] / 2.4);
  }
}

export default Forest;
