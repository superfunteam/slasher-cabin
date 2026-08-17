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
 *   undergrowth                     22   (9 kinds; deadfall and stump carry a moss sub-mesh,
 *                                         saplings a stem and a needle sub-mesh)
 *
 * V = settings.tier(3, 4, 5, 6). Ultra worst case is 42 + 14 + 7 + 4 + 22 = 89, and in
 * practice most LOD0 buckets are empty (a 34 m disc holds ~110 trees across 24 buckets), so a
 * bucket with count 0 is `visible = false` and costs nothing.
 *
 * ---------------------------------------------------------------------------------------
 * MEASURED, quality=ultra, 1600x900, seed 0x51a5cab (shots/fx-diag-final.png is the raw dump)
 * ---------------------------------------------------------------------------------------
 *   trees 5846   undergrowth instances 43621   trunk+prop colliders 9671
 *   buckets 57   sub-meshes 89 (the ceiling)   unique bucket geometry 43 105 tris
 *
 *   shot          Forest.stats.drawCalls   renderer.info.calls   scene tris
 *   ridge                  70                     265              836 k
 *   moon                   73                     264            1 008 k
 *   site-close             78                     283            1 685 k
 *   forest-deep            78                     316            1 529 k
 *
 * `drawCalls` counts the COLOUR pass, which is the budget the brief names: peak 78, ceiling 89,
 * both under 120. The renderer's own counter is higher because every shadow-casting light
 * re-draws the LOD0 buckets: with the forest toggled off at the same camera, site-close falls
 * 283 -> 173 and forest-deep 316 -> 186, so the forest's TOTAL cost including shadow passes is
 * 110 and 130 calls respectively. Triangles attributable to the forest: 1 167 k (site-close),
 * 1 118 k (forest-deep), again including shadow passes.
 *
 * Frame time was measured as a median of 30 `render + glFinish` pairs with the forest enabled
 * and disabled. DO NOT TRUST THE ABSOLUTE NUMBERS in this harness: the review browser keeps the
 * tab hidden, several agents' contexts share the GPU, and the same measurement swung between
 * 22 and 120 ms across runs — one pass even timed the forest as NEGATIVE cost. The draw-call
 * and triangle counts above are deterministic and are the numbers to regress against.
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
 *  - The cutout foliage cards are alpha-TESTED, not alpha-to-coverage and not blended. Forest
 *    asserts that on the shared materials at init (`_restoreCutout`) because A2C is inert
 *    against a single-sample buffer and turns every needle card into an opaque quad. If you add
 *    a card material, add its threshold to FOLIAGE_ALPHA_TEST — do not reach for `blending`.
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
/**
 * Every species is authored to this height at EVERY LOD. Variants differ in shape, lean and
 * branch count — never in height — so the per-instance scale (target / CANON_H) is identical
 * for all four meshes and a LOD swap cannot resize a tree.
 */
const CANON_H = 20;
/**
 * Per-LOD tessellation. Index is the LOD band; the impostor is generated separately.
 *
 * LOD0 was 9 sides / 13 segments / 10 whorls / 6 branches. That is a fine tree at 20 m and a
 * bad one at 3 m, which is where the camera now stands: `padClear` is 2.6 m, so the treeline
 * is close enough that a 9-gon trunk shows facets down its silhouette and a 10-whorl crown
 * shows sky between the whorls. 12 sides puts the facet angle at 30 deg, under the point where
 * the specular terminator on a wet trunk reads as a crease, and 14 whorls closes the gaps.
 */
const LOD_SIDES = [12, 7, 4];
const LOD_SEGS = [16, 8, 4];
const LOD_WHORLS = [14, 8, 4];
const LOD_BRANCH = [7, 5, 4];

/**
 * Material keys per species: [bark, foliage|null].
 *
 * Birch used to take 'foliage-fern'. It was the wrong texture twice over: a single fern frond
 * stretched across a 3.4 x 5 m crown card is a five-metre leaf, and it is the card whose mean
 * alpha (0.337) sat just above the 0.30 cutout, so every birch crown in the mid-ground inflated
 * into an opaque quad. The needle sprig tiles finely enough to read as a leaf mass at any
 * distance, which is all ART_DIRECTION §1 asks of a canopy at night ("foliage that reads as
 * silhouette mass rather than individual leaves"). Fern stays where a fern belongs: undergrowth.
 */
const SPECIES_MATS = [
  ['bark-pine', 'foliage-pine'],
  ['bark-pine', 'foliage-pine'],
  ['bark-birch', 'foliage-pine'],
  // Snags used to take 'weathered-wood'. Its albedo is PAL.weathered #6b6155 — luminance 0.135,
  // FOUR TIMES bark.dry (#38312a, 0.032), and it is authored for sawn boards that have sat in
  // the sun on a porch, not for a dead fir standing in seven days of rain. A 20 m column of it
  // is the single brightest thing in the treeline, and snags are 5-10% of the forest: those are
  // the "sparse pale sticks" of shots/ridge-fixed.png. A soaked standing dead conifer keeps its
  // bark for years and reads black at night, so it takes the same bark as its living neighbours.
  ['bark-pine', null],
];

/**
 * ALPHA-TESTED FOLIAGE — the two numbers that stop the canopy being white rectangles.
 *
 * Materials ships both cutout cards at `alphaTest: 0.30`. That single threshold cannot serve
 * both textures, because a mip chain averages alpha toward the texture's MEAN, and the two
 * baked cards sit on opposite sides of 0.30:
 *
 *     foliage-pine  mean alpha 0.106   ->  0.30 discards the WHOLE card two LODs out.
 *                                          Every conifer past ~40 m lost its needles and read
 *                                          as a bare dead stick.
 *     foliage-fern  mean alpha 0.337   ->  0.30 KEEPS the whole card two LODs out.
 *                                          Every fern / birch crown became an opaque quad,
 *                                          which the aerial-perspective term then filled with
 *                                          fog grey: the white rectangles in shots/ridge.png.
 *
 * Straddle the means instead. Below the mean, the coarse mip survives (a distant conifer stays
 * a needle mass, which is what a real one is). Above it, the coarse mip dies out entirely, so a
 * fern fades away rather than inflating into a card. Measured off the baked 1024² textures with
 * a readPixels histogram, not guessed.
 */
const FOLIAGE_ALPHA_TEST = {
  // 0.11 sat just ABOVE the measured 0.106 mean, which is the wrong side of the rule this
  // comment block states: at 0.11 the coarsest mips fall under threshold and a needle card
  // vanishes entirely. That was survivable when a LOD0 card carried one un-tiled sprig; now
  // that the LOD0 spray tiles the sprig up to 4x (see NEEDLE_TILE_M) the card reaches those
  // mips several metres nearer, so the threshold has to drop below the mean to keep it. The
  // side effect is the one we want anyway: more fragments pass, so the mass is more opaque.
  'foliage-pine': 0.085,
  // 0.55 kept only the strongest pinnae of the frond card, which turned an already regular comb
  // into a stark row of palings under a lantern. 0.46 fills the frond back in while staying well
  // clear of the card's 0.337 mean, so a distant fern still fades out instead of inflating.
  'foliage-fern': 0.46,
};

/** Every tunable in one object. */
export const FOREST_TUNING = {
  chunkSize: 32,
  /**
   * SPACING. Was 3.1 / 11.5, which put the mean trunk-to-trunk distance around 6.5 m. A managed
   * second-growth Douglas fir stand runs 2.4-4 m; 6.5 m is a park. From the ridge you could see
   * the sky between every pair of trees, which is why the treeline read as a picket fence
   * instead of the solid black wall of keyart-lake.png. Dropping to 2.55 / 9.4 takes the tree
   * count from 3924 to ~5000 and closes the gaps without touching the LOD budget: LOD0 caps at
   * 384 instances PER species PER variant and a 34 m disc at this spacing holds ~110 firs.
   *
   * 2.55 / 9.4 was tried first and is too far. MEASURED at that spacing, the forest-deep camera
   * had four trunks inside 5.2 m and the nearest at 2.55 m; a 20 m fir whose lowest whorl starts
   * at 2.6 m puts its skirt through the camera, and the frame became an unreadable lattice of
   * lantern-lit branches (shots/fx-a-forestdeep.png). 2.90 is the low end of a real managed
   * Douglas fir stand and leaves a body's width between trunks, which the stealth game needs.
   */
  rMin: 2.90,              // densest spacing, metres
  rMax: 10.2,              // thinnest spacing before it reads as a clearing
  lod0: 34, lod1: 78, lod2: 165,
  /**
   * SHADOW BAND. Only LOD0 casts, and LOD0 already ends at `lod0` metres, so this number is
   * the SECOND gate, not the first — it is here to trim the LOD0 disc further when a bucket's
   * nearest instance is already far enough that its shadow lands under a texel. The lamp that
   * carries the key art (Flashlight `lantern-core`) has shadow.camera.far = 26, so anything
   * past that contributes to the moon pass only, and the moon runs at intensity 0.03.
   */
  /**
   * MEASURED: at 28 m, site-close cost 310 renderer draw calls with the forest on and 172 with
   * it off — 138 calls for 76 visible sub-meshes, i.e. 62 of them were shadow-pass repeats. The
   * lantern's shadow camera has far = 26 and its intensity is 1/r^2, so a trunk at 24 m casts a
   * shadow whose contrast is under a fiftieth of the one at 3 m. 20 m keeps every caster that
   * can throw the key art's "enormous shadows into the pines" and drops the rest.
   */
  shadowRange: 20,
  /**
   * Undergrowth casts on a much tighter leash than trees. A stump throws a readable shadow at
   * 8 m in a lantern beam and nothing at all at 25 m, but it costs a full extra draw either
   * way, x every shadow-casting light. Ferns and salal never cast (see the `cast` flags in
   * `_buildUndergrowthBuckets`) — only the solid deadfall logs and stumps do.
   */
  ugShadowRange: 11,
  /**
   * BUILD-PAD CLEARING — the single number that decides whether the key art exists.
   *
   * `padClear` is how far past the pad edge the last trunk stands, and `padFeather` is how far
   * past THAT the forest returns to full density. These used to be 11.0 and 28.0, which put the
   * nearest trunk 23.4 m from the pad centre and the treeline proper at 51 m. The lantern's
   * shadow camera reaches 26 m and its intensity falls off as 1/r^2, so at 23 m the nearest
   * bark received about a hundredth of the light it gets at 8 m: the frame was lit against a
   * black void, cast its shadow into empty air, and the "enormous shadows thrown up into the
   * pines" of keyart-site.png could not physically happen. There was nothing there to hit.
   *
   * At 2.6 m of clearance the trunks stand just off the flattened pad, 9-13 m from a caretaker
   * standing at the frame — inside the 26 m shadow camera AND inside the part of the 1/r^2
   * curve where bark still reads warm. The feather is short enough that a real wall of forest
   * closes the frame off instead of a distant band across a black gap.
   * The clearing edge stays SPARSE on purpose (the feather leaves ~8-11 m spacing at the rim),
   * because the key art shows half a dozen individually lit trunks, not a hedge.
   *
   * Do not push `padClear` below ~2: the pad half-extent is the WORKING area, not the cabin
   * footprint, and a trunk inside it fouls carry paths and the piers.
   */
  padClear: 2.6,
  /**
   * MEASURED with padFeather 11.0: the nearest trunk to the site-close camera was 11.77 m, and
   * at 1/r^2 from a lantern 2 m away that trunk receives about 3% of the light the frame does —
   * so the treeline behind the frame went to black instead of showing the half-dozen
   * individually modelled trunks of keyart-site.png. The pad half-extent (Terrain's, 12 m) sets
   * the floor and is not mine to move, so the lever left is the feather: shortening it to 7 m
   * brings full stand density to 21.6 m from pad centre instead of 25.6, which thickens the
   * wall right behind the frame without putting a trunk anywhere near the working area.
   */
  padFeather: 7.0,
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
        // Three octaves, not two. Two sines at 5 and 11 lobes produce a beat with a visible
        // period — at 3 m you read the same ridge marching round the trunk. The third term at
        // 19 lobes with a steep vertical rate breaks it into plates the size of real fir bark
        // (~60 mm), which is what the lantern's grazing light needs in order to have anything
        // to model. Sum of weights is 1.0 so `barkAmp` stays the true peak radial deviation.
        rr *= 1 + barkAmp * (Math.sin(a * 5.0 + arc[i] * 2.7) * 0.46
          + Math.sin(a * 11.0 - arc[i] * 4.3) * 0.30
          + Math.sin(a * 19.0 + arc[i] * 9.1) * 0.24);
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
 * TEXEL DENSITY ON A FOLIAGE CARD — the defect that made the near canopy a pile of sticks.
 *
 * Materials.js maps a foliage card's texture EXACTLY ONCE across its quad (§64: "Foliage cards
 * are the exception — those map once across their quad"), and the baked 'needle' card contains
 * seven sprigs whose needles are 0.16 of the card's height. That is correct art at a 0.5 m card
 * and nonsense at a 3.9 m one: the needles become 620 mm spikes. shots/fx-c-forestdeep.png is
 * the proof — the crown over the lantern is a fan of lantern-lit RODS with no needle mass on it
 * at all, because each "needle" is the size of a forearm.
 *
 * Both the baked 'pine-needles' set (Textures.js `_rtOpts`) and the Canvas2D fallback card
 * (Materials.js `_makeTexture`) are created with RepeatWrapping, so the fix is free: emit UVs
 * beyond 0..1 and let the sprig tile. NEEDLE_TILE_M is the world size of one tile.
 */
const NEEDLE_TILE_M = 0.55;
/**
 * Tiling costs distance: a tiled card reaches the top of its mip chain nearer to the camera,
 * and once the mip average falls under `alphaTest` the whole card is discarded. Cap the repeat
 * so a LOD0 card at the 34 m ring still resolves ~21 px per tile.
 */
const NEEDLE_TILE_MAX = 4;

function tileFor(size) {
  const t = size / NEEDLE_TILE_M;
  return t < 1 ? 1 : (t > NEEDLE_TILE_MAX ? NEEDLE_TILE_MAX : t);
}

/**
 * One alpha card. Anchored at its BASE so the foliage art (which is drawn base-at-v0)
 * grows the right way up. `taper` narrows the tip. `tu`/`tv` repeat the texture across the
 * quad; leave them at 1 for art that is authored one-per-card (a fern frond IS one frond).
 */
function emitCard(buf, bx, by, bz, ux, uy, uz, sx, sy, sz, w, h, nx, ny, nz,
  taper = 0.55, tu = 1, tv = 1) {
  const hw = w * 0.5, tw = hw * taper;
  const tx = bx + ux * h, ty = by + uy * h, tz = bz + uz * h;
  // The tip is narrower, so its u range shrinks with it — otherwise the tiling shears and the
  // needles fan out toward the point of the card.
  const u0 = tu * 0.5 * (1 - taper), u1 = tu - u0;
  const i0 = buf.push(bx - sx * hw, by - sy * hw, bz - sz * hw, nx, ny, nz, 0, 0);
  const i1 = buf.push(bx + sx * hw, by + sy * hw, bz + sz * hw, nx, ny, nz, tu, 0);
  const i2 = buf.push(tx + sx * tw, ty + sy * tw, tz + sz * tw, nx, ny, nz, u1, tv);
  const i3 = buf.push(tx - sx * tw, ty - sy * tw, tz - sz * tw, nx, ny, nz, u0, tv);
  buf.quad(i0, i1, i2, i3);
}

/** Two cards crossed about the growth axis — the cheapest thing that reads as volume. */
function emitCross(buf, p, up, side, w, h, nrm, taper = 0.55, tiled = false) {
  const tu = tiled ? tileFor(w) : 1;
  const tv = tiled ? tileFor(h) : 1;
  emitCard(buf, p.x, p.y, p.z, up.x, up.y, up.z, side.x, side.y, side.z,
    w, h, nrm.x, nrm.y, nrm.z, taper, tu, tv);
  const s2x = up.y * side.z - up.z * side.y;
  const s2y = up.z * side.x - up.x * side.z;
  const s2z = up.x * side.y - up.y * side.x;
  const l = 1 / Math.max(1e-6, Math.hypot(s2x, s2y, s2z));
  emitCard(buf, p.x, p.y, p.z, up.x, up.y, up.z, s2x * l, s2y * l, s2z * l,
    w, h, nrm.x, nrm.y, nrm.z, taper, tu, tv);
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

    // Shared cutout foliage we have tuned. We do not own these materials — we only keep the
    // alpha cutout honest on them, and we never dispose them.
    this._cutoutMats = [];
    this._msaa = null;          // null = not probed yet

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
    this._shadows = true;
    this._maxDist = 275;        // impostor cull distance, set from the tier in init()
    this._ugFlat = null;        // flat list of undergrowth buckets, indexed by chunk.ug.b
    this._ugKinds = null;       // [{ name, weight, idx, scale, tilt, sink, wet, shade, open }]
    this._ugTotal = 0;
    this._treeScaleResolved = false;

    this.stats = {
      trees: 0, visible: 0, drawCalls: 0, chunks: 0, chunksVisible: 0,
      undergrowth: 0, ugVisible: 0, rebuilds: 0, genMs: 0, buildMs: 0,
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
      this._restoreCutout();
      this._registerColliders();
      this._bindEvents();

      // Streaming radius for undergrowth. At 38 m the mat of litter stopped inside the lantern's
      // own reach on open ground and the eye read the boundary as a clearing. 54 m puts it past
      // the fog's half-visibility distance in every canonical shot.
      this._ugRadius = this.ctx?.settings?.tier?.(26, 34, 44, 54) ?? 44;
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
    // Materials.setAlphaToCoverage() rewrites alphaTest on every cutout material it owns, and
    // Postprocessing may call it on a quality change. Re-assert our thresholds afterwards or
    // the canopy silently reverts to rectangles mid-night.
    const reassert = () => { if (!this._disposed) this._restoreCutout(); };
    for (const ev of ['night:begin', 'game:resume', 'settings:changed']) {
      const u = this.bus.on(ev, reassert);
      if (typeof u === 'function') this._unsub.push(u);
    }
  }

  /**
   * A material from the shared library, or a local stand-in so the forest still renders when
   * Materials is missing. Locally-made materials are owned and disposed by us.
   */
  _material(name, fallback) {
    try {
      const m = this.mats?.get?.(name);
      if (m && m.isMaterial) { this._tuneCutout(name, m); return m; }
      Log.once(`forest:mat:${name}`,
        `Forest: Materials.get('${name}') returned nothing — using a local stand-in. `
        + 'An untextured card is an opaque quad; expect flat foliage until Materials is up.');
    } catch (e) { Log.once('forest:mat', 'Forest: Materials.get failed', e); }
    // No map means no alpha, and an alphaTest against a=1 passes every fragment. Do NOT ask
    // for a cutout we cannot honour — a dark opaque leaf mass is an honest degradation, a
    // white card is not.
    const mat = new THREE.MeshStandardMaterial({
      color: fallback?.color ?? 0x2a2a24,
      roughness: fallback?.roughness ?? 0.9,
      metalness: 0.0,
      side: fallback?.side ?? THREE.FrontSide,
      alphaTest: 0,
      alphaToCoverage: false,
      transparent: false,
      blending: THREE.NormalBlending,
      name: `forest-fallback-${name}`,
    });
    this._ownedMaterials.push(mat);
    return mat;
  }

  /**
   * Is the colour pass actually multisampled? `alphaToCoverage` is a lie without MSAA: three
   * compiles `ALPHA_TO_COVERAGE`, which replaces the hard `if (a < alphaTest) discard;` with a
   * smoothstep written into `gl_FragColor.a` and resolved by the sample mask. With one sample
   * per pixel there is no mask, nothing is discarded, and every needle card draws as a fully
   * opaque quad that the aerial-perspective term then fills with fog grey.
   *
   * Engine builds the context with `antialias: false` and Postprocessing's targets carry no
   * `samples`, so this returns false today — but ask rather than assume, because the day someone
   * turns MSAA on, true alpha-to-coverage is the better image and we should get out of its way.
   */
  _msaaActive() {
    try {
      const r = this.ctx?.renderer;
      if (!r) return false;
      const rt = typeof r.getRenderTarget === 'function' ? r.getRenderTarget() : null;
      if (rt && (rt.samples | 0) > 0) return true;
      const post = this.ctx?.systems?.get?.('Postprocessing');
      const psam = post?.sceneTarget?.samples ?? post?.target?.samples ?? 0;
      if ((psam | 0) > 0) return true;
      const gl = typeof r.getContext === 'function' ? r.getContext() : null;
      const attrs = gl && typeof gl.getContextAttributes === 'function'
        ? gl.getContextAttributes() : null;
      return !!(attrs && attrs.antialias);
    } catch { return false; }
  }

  /**
   * Restore a real alpha cutout on the shared foliage cards.
   *
   * Materials documents `setAlphaToCoverage(bool)` as the switch Postprocessing is supposed to
   * throw once it renders into a multisampled target (Materials.js §22/§78). Nobody ever threw
   * it, so on high/ultra the cards shipped with A2C on against a single-sample buffer — see
   * `_msaaActive()` for what that does to a card. Throw it here, from the module that owns 95%
   * of the cutout geometry in the scene, and then straddle the per-texture mean alpha with
   * FOLIAGE_ALPHA_TEST so the threshold does the work at every LOD.
   */
  _restoreCutout() {
    this._msaa = this._msaaActive();
    if (this._msaa) return;
    try {
      if (typeof this.mats?.setAlphaToCoverage === 'function') {
        this.mats.setAlphaToCoverage(false);
        Log.debug('Forest: scene target is single-sampled — alpha-to-coverage off, cutout on.');
      }
    } catch (e) { Log.once('forest:a2c', 'Forest: setAlphaToCoverage failed', e); }
    for (let i = 0; i < this._cutoutMats.length; i++) {
      const e = this._cutoutMats[i];
      this._applyCutout(e.name, e.mat, e.depth);
    }
  }

  /** Remember a cutout material and bring it into line. Idempotent; safe to call again. */
  _tuneCutout(name, mat) {
    if (FOLIAGE_ALPHA_TEST[name] === undefined) return;
    let rec = null;
    for (let i = 0; i < this._cutoutMats.length; i++) {
      if (this._cutoutMats[i].mat === mat) { rec = this._cutoutMats[i]; break; }
    }
    if (!rec) {
      rec = { name, mat, depth: this._depthMaterial(name) };
      this._cutoutMats.push(rec);
    }
    if (this._msaa === null) this._msaa = this._msaaActive();
    if (!this._msaa) this._applyCutout(name, rec.mat, rec.depth);
  }

  _applyCutout(name, mat, depth) {
    const want = FOLIAGE_ALPHA_TEST[name];
    if (want === undefined || !mat) return;
    let dirty = false;
    if (mat.alphaToCoverage) { mat.alphaToCoverage = false; dirty = true; }
    if (mat.transparent) { mat.transparent = false; dirty = true; }
    if (mat.blending !== THREE.NormalBlending) { mat.blending = THREE.NormalBlending; dirty = true; }
    if (mat.premultipliedAlpha) { mat.premultipliedAlpha = false; dirty = true; }
    if (Math.abs((mat.alphaTest ?? 0) - want) > 1e-4) { mat.alphaTest = want; dirty = true; }
    if (mat.depthWrite === false) { mat.depthWrite = true; dirty = true; }
    if (dirty) mat.needsUpdate = true;
    // The shadow caster has to cut out on exactly the same threshold or the canopy throws a
    // rectangular shadow that the canopy itself no longer has.
    if (depth) {
      let dd = false;
      if (depth.alphaToCoverage) { depth.alphaToCoverage = false; dd = true; }
      if (Math.abs((depth.alphaTest ?? 0) - want) > 1e-4) { depth.alphaTest = want; dd = true; }
      if (dd) depth.needsUpdate = true;
    }
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
      const inner = (T?.buildPadHalf ?? 12) + FT.padClear;
      const dp = Math.hypot(x - pad.x, z - pad.z);
      if (dp < inner) return -1;
      padFeather = smooth01(inner, inner + FT.padFeather, dp);
    }
    const dock = T?.dock;
    if (dock && Math.hypot(x - dock.x, z - dock.z) < 11) return -1;

    // Clumps and gaps. A uniform field is the thing that reads as a video game.
    let d = dens;
    // The clump term used to average 0.34, which pulled the WHOLE map's density down by two
    // thirds and left the mean trunk spacing at 6.2 m no matter what `rMin` said. Now that the
    // crowns are the right size (7.6 m spread, not 12) the stand has to actually be a stand:
    // averaging 0.52 puts the measured mean spacing near 5 m, which is canopy closure.
    d *= clamp(0.52 + 1.05 * fbm2(x * 0.021 + 11.3, z * 0.021 - 7.9, 4, 2.0, 0.5), 0.08, 1.6);
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

  /**
   * Species weights vary with the ground: birch by water, pine and snags on the exposed rise.
   *
   * BIRCH IS AN ACCENT, NOT A POPULATION. 'bark-birch' is PAL.barkBirch #b9b6a6 — luminance
   * 0.72, twenty-two times bark.dry. That is correct for paper birch and catastrophic in bulk:
   * at 6-21% of 4000 trees it put several hundred near-white 12 m columns through the treeline,
   * and aerial perspective then lifted them further. keyart-lake.png has no birch in it at all;
   * it is a spruce-fir wall. So birch drops to 2-9%, only where the ground is genuinely wet and
   * low, where a real stand of them would be — and its height factor drops from 0.62 to 0.52 so
   * it sits UNDER the conifer canopy and never skylines against the moon.
   */
  _pickSpecies(rand, y, exposure, wet) {
    const wl = this.terrain?.waterLevel ?? 0;
    const low = 1 - smooth01(wl + 0.5, wl + 7.0, y);
    const high = smooth01(8, 26, y);
    let wFir = 0.57 + 0.14 * low - 0.12 * high;
    let wPine = 0.36 - 0.12 * low + 0.22 * high;
    let wBirch = 0.015 + 0.055 * low + 0.020 * wet * low;
    let wSnag = 0.050 + 0.045 * high * exposure;
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
      else if (spec === SP_BIRCH) hTarget *= 0.52;
      else if (spec === SP_SNAG) hTarget *= 0.66;
      // spacing correlates with size: a tree with room grows bigger
      hTarget *= 0.82 + 0.34 * smooth01(FT.rMin, FT.rMax, pr[i]);

      this._tx[i] = x; this._ty[i] = y; this._tz[i] = z;
      this._tspec[i] = spec; this._tvar[i] = variant;
      this._thgt[i] = hTarget;
      // Materials.js reads aWind.y as a phase ONLY when it is > 0.0001; below that it falls
      // back to a hash of the instance origin. Both are per-instance, so nothing ever swayed in
      // unison, but the two paths give different distributions and a tree whose rand landed near
      // zero silently changed phase family. Bias the draw off the floor so every tree in the
      // forest is on the same explicit, uniformly distributed phase.
      this._tphase[i] = 0.02 + 0.97 * rand.next();
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
      const rc = h * (this._tspec[i] === SP_BIRCH ? 0.20 : 0.19);
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
    /**
     * The splat kernel is (1 - d^2) over a disc of radius `rc`, which integrates to HALF the
     * disc's area, so the raw sum under-reads closure by about 2x. Closure in the dense stand is
     * N.pi.rc^2/A = pi(3.0)^2/(5.0)^2 = 1.13, i.e. genuinely closed, and the divisor has to be
     * chosen so that reads as ~1. MEASURED at /2.6: mean 0.135, max 0.947, 68% of cells under
     * 0.2 — a forest that tells Weather there is no shelter anywhere and NoiseSystem that every
     * cell is a clearing. /1.8 puts the closed stands at the top of the range and leaves the
     * lake, the camp, the pad and the granite benches at zero, which is the gradient the
     * consumers actually want.
     */
    for (let i = 0; i < g.length; i++) g[i] = clamp01(g[i] / 1.8);
  }

  /** Chunk bounding spheres, recomputed once per-instance scales are known. */
  _refreshChunkSpheres() {
    for (let k = 0; k < this._chunks.length; k++) {
      const c = this._chunks[k];
      if (!c.trees || !c.trees.length) continue;
      let minY = Infinity, maxY = -Infinity;
      for (let t = 0; t < c.trees.length; t++) {
        const i = c.trees[t];
        const b = this._ty[i], h = this._thgt[i] || 24;
        if (b < minY) minY = b;
        if (b + h > maxY) maxY = b + h;
      }
      c.y = (minY + maxY) * 0.5;
      c.r = Math.hypot(FT.chunkSize * 0.75, (maxY - minY) * 0.5) + 2;
    }
  }

  // =========================================================================================
  // TREE GEOMETRY
  //
  // Every species is authored to the SAME canonical height (CANON_H), at every LOD, so a tree
  // crossing a LOD ring cannot change size — the per-instance scale is `target / CANON_H` and
  // is identical for all four meshes. Variants differ in shape, lean, branch count and bark
  // relief, never in height. That is the whole trick behind a silent LOD transition.
  // =========================================================================================

  /** Build the bark and foliage buffers for one (species, variant, lod). */
  _genTree(spec, rand, lod) {
    const bark = new Buf(), fol = new Buf();
    let radius;
    if (spec === SP_FIR) radius = this._genConifer(bark, fol, rand, lod, true);
    else if (spec === SP_PINE) radius = this._genConifer(bark, fol, rand, lod, false);
    else if (spec === SP_BIRCH) radius = this._genBirch(bark, fol, rand, lod);
    else radius = this._genSnag(bark, rand, lod);
    return { bark, fol, radius };
  }

  /**
   * Fir (dense, drooping, skirted almost to the ground) or pine (bare stem, upswept crown).
   * @returns {number} trunk radius at the base, before flare.
   */
  _genConifer(bark, fol, rand, lod, isFir) {
    const H = CANON_H;
    const r0 = isFir ? rand.range(0.24, 0.31) : rand.range(0.21, 0.28);
    const sides = LOD_SIDES[lod], segs = LOD_SEGS[lod];
    const swayA = rand.range(0.05, 0.55), swayP = rand.next() * TAU;

    const pts = [], radii = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const y = -0.55 + (H + 0.55) * t;
      const bend = swayA * t * t;
      pts.push(new THREE.Vector3(
        Math.sin(swayP + t * 2.1) * bend, y, Math.cos(swayP * 1.7 + t * 1.6) * bend));
      radii.push(Math.max(0.018, r0 * Math.pow(1 - clamp01(y / H), isFir ? 0.95 : 0.78)));
    }
    emitTube(bark, pts, radii, sides, {
      // Root flare: the bottom 1.6 m swells and lobes, so the tree sits IN the ground instead
      // of being pushed into it like a pin. ART_DIRECTION §10 failure mode A2.
      flare: { h: 1.6, amp: 0.85, lobes: rand.int(4, 6), phase: rand.next() * TAU },
      // 0.055 was tuned when the nearest trunk stood 23 m away. `padClear` is 2.6 m now, so a
      // 0.28 m fir shows 15 mm of relief at arm's length — below the normal map's own detail and
      // invisible. 0.090 gives 25 mm plates, which is what actual Douglas fir bark measures, and
      // it is a RADIAL displacement so the trunk's silhouette breaks up too, not just its shading.
      bark: lod === 0 ? 0.090 : (lod === 1 ? 0.038 : 0),
      cap: true, uvCirc: TAU * r0,
    });

    const whorls = LOD_WHORLS[lod];
    const nb = LOD_BRANCH[lod] + (isFir ? 0 : -1);
    /**
     * CROWN PROPORTION — the bug that made the forest unwalkable.
     *
     * `crown0` is the length of the longest branch, i.e. the crown RADIUS. It was 0.30 H. On a
     * 20 m canonical tree that is a 6 m branch and a TWELVE METRE wide crown, and the per-
     * instance scale runs to 1.7, so the biggest firs carried a 20 m spread. Measure a real
     * 20 m Douglas fir in a closed stand and you get 5-7 m of spread. Two consequences, both
     * visible in shots/fx-a-forestdeep.png and fx-b-forestdeep.png: every camera at eye height
     * inside the forest is INSIDE a crown, and the silhouette is a blob where keyart-lake.png
     * has spires. 0.19 H gives a 7.6 m spread — still generous, still closes the canopy at the
     * spacing above, and it costs a third of the foliage overdraw.
     *
     * `t0` is where the lowest live whorl sits. 0.13 put a fir's skirt at 2.6 m, which on a
     * short instance is below head height. A fir in a closed stand self-prunes to roughly a
     * quarter of its height, and keyart-site.png is built on bare trunks with the canopy far
     * overhead — that is the frame the whole game is about, so 0.24 it is.
     */
    const t0 = isFir ? 0.24 : 0.46;
    const droop = isFir ? -0.30 : 0.12;
    const crown0 = (isFir ? 0.190 : 0.170) * H;
    const up = new THREE.Vector3(), side = new THREE.Vector3();
    const nrm = new THREE.Vector3(), base = new THREE.Vector3();
    const core = new THREE.Vector3();

    /**
     * A CANOPY WITH AN INSIDE.
     *
     * The old crown was a shell: one cross of cards at the branch base and, at LOD0 only, one
     * smaller cross halfway out. Seen from the ground that is a ring of leaves with a hole in
     * the middle, and the moon shot showed exactly that — you could see sky through the axis of
     * every tree. Real conifer foliage occupies a VOLUME, and volume is what makes the canopy
     * read near-black: light entering the crown has to miss four or five layers of needles to
     * get out again, and it doesn't.
     *
     * So every branch now carries up to four crosses spaced along its own axis:
     *
     *   inner  0.14 L   wide, short, steeply drooped  — the dark core against the trunk
     *   main   0.00 L   the long primary spray
     *   mid    0.50 L   narrower, carries the branch silhouette outward
     *   tip    0.80 L   a small sprig that breaks the card's straight edge
     *
     * LOD1 keeps main + mid (the mid-ground wants mass, not parallax), LOD2 keeps main only.
     * The cards deliberately OVERLAP: an alpha-tested card at 0.11 threshold passes roughly a
     * third of its area, so three overlapping layers are needed before a needle mass stops
     * being see-through, and that is the whole reason the treeline used to glow with fog.
     */
    for (let w = 0; w < whorls; w++) {
      const tw = t0 + (0.955 - t0) * (whorls === 1 ? 0.55 : w / (whorls - 1));
      const y = tw * H;
      const shape = Math.pow(1 - (tw - t0) / (1.02 - t0), isFir ? 0.70 : 0.85);
      const L = crown0 * shape * rand.range(0.80, 1.18) + 0.22;
      const tr = Math.max(0.02, r0 * (1 - tw));
      for (let b = 0; b < Math.max(2, nb); b++) {
        const ang = w * PHYLLO + (b / Math.max(2, nb)) * TAU + rand.range(-0.19, 0.19);
        const ca = Math.cos(ang), sa = Math.sin(ang);
        up.set(ca, droop + rand.range(-0.10, 0.10), sa).normalize();
        base.set(ca * tr * 0.8, y, sa * tr * 0.8);
        side.set(-sa, 0, ca);
        nrm.set(up.x * 0.35, 1, up.z * 0.35).normalize();
        if (lod === 0 && tw < 0.68) {
          // A real branch under the needles. This is the thing the lantern rim-lights.
          const b0 = base.clone();
          const b1 = base.clone().addScaledVector(up, L * 0.55); b1.y += L * 0.07;
          const b2 = base.clone().addScaledVector(up, L * 0.96); b2.y += L * 0.04;
          emitTube(bark, [b0, b1, b2], [tr * 0.55, tr * 0.30, tr * 0.11], 4,
            { uvCirc: TAU * tr * 0.5 });
        }
        if (lod === 0) {
          // A SPRAY OF SEGMENTS, NOT ONE BRANCH-LENGTH CARD. Four crosses spaced along the
          // branch's own axis, each about a third of its length, overlapping by half. The card
          // that used to run the whole 3.5 m of branch is gone: no single quad is now longer
          // than ~1.3 m, which is what keeps the tiled needle texture at a sane texel density
          // (see NEEDLE_TILE_M) and what stops the crown reading as four flat planes.
          for (let k = 0; k < 4; k++) {
            const t = 0.10 + k * 0.235;
            const wob = (1 - t) * 0.92 + 0.12;      // spray narrows toward the tip
            core.set(base.x + up.x * L * t, base.y + up.y * L * t - L * 0.04 * (1 - t),
              base.z + up.z * L * t);
            emitCross(fol, core, up, side, L * 0.56 * wob, L * 0.36 * wob, nrm,
              0.44 + 0.30 * t, true);
          }
        } else if (lod === 1) {
          // Mid-ground wants mass, not parallax: two long cards, untiled so the mip chain keeps
          // them alive out to the 78 m ring.
          emitCross(fol, base, up, side, L * (isFir ? 0.80 : 0.92), L * 1.06, nrm,
            isFir ? 0.34 : 0.46);
          core.set(base.x + up.x * L * 0.50, base.y + up.y * L * 0.50,
            base.z + up.z * L * 0.50);
          emitCross(fol, core, up, side, L * 0.52, L * 0.62, nrm, 0.30);
        } else {
          emitCross(fol, base, up, side, L * (isFir ? 0.86 : 0.96), L * 1.10, nrm,
            isFir ? 0.34 : 0.46);
        }
      }
    }
    // The leader: a spire, plus a skirt just under it so the tip is not a bare stick against
    // the moon — the top 8% of a fir is the part that is always silhouetted.
    up.set(0, 1, 0); side.set(1, 0, 0); nrm.set(0, 1, 0);
    base.set(0, H * 0.90, 0);
    emitCross(fol, base, up, side, crown0 * 0.52, H * 0.13, nrm, 0.10, lod === 0);
    if (lod <= 1) {
      base.set(0, H * 0.82, 0);
      emitCross(fol, base, up, side, crown0 * 0.78, H * 0.11, nrm, 0.34, lod === 0);
    }
    return r0;
  }

  /** Paper birch: pale slender stem that forks into leaders, ellipsoid crown. */
  _genBirch(bark, fol, rand, lod) {
    const H = CANON_H;
    const r0 = rand.range(0.11, 0.16);
    const sides = Math.max(4, LOD_SIDES[lod] - 1), segs = LOD_SEGS[lod];
    const lean = rand.range(0.35, 1.5), lp = rand.next() * TAU;
    const splitT = rand.range(0.42, 0.58);

    const pts = [], radii = [];
    const ns = Math.max(3, Math.round(segs * splitT) + 1);
    for (let i = 0; i <= ns; i++) {
      const t = i / ns;
      const y = -0.5 + (H * splitT + 0.5) * t;
      pts.push(new THREE.Vector3(
        Math.sin(lp) * lean * t * t, y, Math.cos(lp) * lean * t * t));
      radii.push(Math.max(0.02, r0 * (1 - 0.32 * clamp01(y / H))));
    }
    emitTube(bark, pts, radii, sides, {
      flare: { h: 0.95, amp: 0.55, lobes: rand.int(3, 5), phase: rand.next() * TAU },
      bark: lod === 0 ? 0.034 : 0, uvCirc: TAU * r0,
    });

    const top = pts[pts.length - 1];
    const rTop = radii[radii.length - 1];
    const leaders = lod === 0 ? 3 : 2;
    for (let k = 0; k < leaders; k++) {
      const a = rand.next() * TAU, spread = rand.range(0.09, 0.24);
      const lpts = [], lrad = [];
      const n2 = Math.max(2, Math.round(segs * 0.55));
      for (let i = 0; i <= n2; i++) {
        const t = i / n2;
        const y = top.y + (H - top.y) * t;
        const off = spread * (H - top.y) * t * t;
        lpts.push(new THREE.Vector3(top.x + Math.cos(a) * off, y, top.z + Math.sin(a) * off));
        lrad.push(Math.max(0.010, rTop * (1 - t * 0.92)));
      }
      emitTube(bark, lpts, lrad, Math.max(3, sides - 2), { uvCirc: TAU * r0 * 0.7, cap: true });
    }

    const clusters = [22, 11, 5][lod];
    const cy = H * 0.74, rx = H * 0.20, ry = H * 0.18;
    const up = new THREE.Vector3(), side = new THREE.Vector3();
    const nrm = new THREE.Vector3(), base = new THREE.Vector3();
    for (let c = 0; c < clusters; c++) {
      const a = c * PHYLLO, rr = Math.sqrt((c + 0.5) / clusters);
      const px = Math.cos(a) * rx * rr, pz = Math.sin(a) * rx * rr;
      const py = cy + (rand.next() * 2 - 1) * ry * (1 - rr * 0.45);
      base.set(px, py, pz);
      up.set(px * 0.30, 1, pz * 0.30).normalize();
      side.set(-Math.sin(a), 0, Math.cos(a));
      nrm.set(px * 0.30, 1, pz * 0.30).normalize();
      emitCross(fol, base, up, side, rx * 0.56, ry * 1.05, nrm, 0.58);
    }
    return r0;
  }

  /** A standing dead trunk: torn top, broken stubs, no foliage. */
  _genSnag(bark, rand, lod) {
    const H = CANON_H;
    const r0 = rand.range(0.26, 0.36);
    const sides = Math.max(4, LOD_SIDES[lod] - 1), segs = Math.max(3, LOD_SEGS[lod] - 2);
    const lean = rand.range(0.2, 1.2), lp = rand.next() * TAU;
    const pts = [], radii = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const y = -0.6 + (H + 0.6) * t;
      pts.push(new THREE.Vector3(
        Math.sin(lp) * lean * t * t, y, Math.cos(lp) * lean * t * t));
      radii.push(Math.max(0.05, r0 * Math.pow(1 - clamp01(y / H), 0.55)));
    }
    emitTube(bark, pts, radii, sides, {
      flare: { h: 2.0, amp: 1.0, lobes: rand.int(4, 7), phase: rand.next() * TAU },
      bark: lod === 0 ? 0.115 : 0.040, uvCirc: TAU * r0,
    });

    const tp = pts[pts.length - 1], tipR = radii[radii.length - 1];
    if (lod < 2) {
      const nsp = lod === 0 ? 5 : 3;
      for (let s = 0; s < nsp; s++) {
        const a = (s / nsp) * TAU + rand.range(-0.25, 0.25);
        const h = rand.range(0.3, 1.5);
        emitTube(bark, [
          new THREE.Vector3(tp.x + Math.cos(a) * tipR * 0.55, tp.y - 0.1, tp.z + Math.sin(a) * tipR * 0.55),
          new THREE.Vector3(tp.x + Math.cos(a) * tipR * 0.85, tp.y + h, tp.z + Math.sin(a) * tipR * 0.85),
        ], [tipR * 0.42, 0.012], 4, { cap: true, uvCirc: TAU * tipR * 0.42 });
      }
    }
    const stubs = lod === 0 ? rand.int(3, 6) : (lod === 1 ? 2 : 0);
    for (let s = 0; s < stubs; s++) {
      const t = rand.range(0.20, 0.85);
      const y = t * H, a = rand.next() * TAU;
      const tr = Math.max(0.03, r0 * (1 - t) * 0.7);
      const L = rand.range(0.5, 2.2);
      const d = new THREE.Vector3(Math.cos(a), rand.range(-0.28, 0.14), Math.sin(a)).normalize();
      const b0 = new THREE.Vector3(Math.cos(a) * tr * 0.7, y, Math.sin(a) * tr * 0.7);
      emitTube(bark, [b0, b0.clone().addScaledVector(d, L)], [tr, tr * 0.22], 4,
        { cap: true, uvCirc: TAU * tr });
    }
    return r0;
  }

  /**
   * The distance impostor: three cards crossed about the vertical, tapered to the species
   * silhouette. Not a screen-facing billboard on purpose — a billboard needs a per-frame
   * rotation per instance, which is exactly the allocation-and-upload cost the whole LOD
   * scheme exists to avoid, and at 165 m the parallax error of a fixed cross is sub-pixel.
   */
  _genImpostor(spec, rand) {
    const H = CANON_H;
    if (spec === SP_SNAG) {
      const bark = new Buf();
      emitTube(bark, [
        new THREE.Vector3(0, -0.4, 0),
        new THREE.Vector3(0.1, H * 0.55, 0.05),
        new THREE.Vector3(0.22, H, 0.11),
      ], [0.34, 0.17, 0.045], 4, { cap: true, uvCirc: 2.1 });
      return { bark, fol: null, radius: 0.32 };
    }
    const fol = new Buf();
    // Wider and blunter than before (0.30 H / taper 0.10). A 165 m fir subtends ~7 px of width
    // at 72 deg on a 1600 px frame; a card tapered to 10% is a needle three pixels wide at half
    // height, and the alpha cutout then eats most of what is left. The far treeline of
    // keyart-lake.png is a CONTINUOUS soft silhouette, so the impostor has to be a solid wedge.
    const w = (spec === SP_BIRCH ? 0.22 : 0.185) * H;
    const y0 = (spec === SP_PINE ? 0.40 : (spec === SP_BIRCH ? 0.44 : 0.20)) * H;
    const taper = spec === SP_BIRCH ? 0.80 : 0.17;
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI + rand.range(-0.1, 0.1);
      const ca = Math.cos(a), sa = Math.sin(a);
      const nl = 1 / Math.max(1e-6, Math.hypot(sa, 0.25, -ca));
      emitCard(fol, 0, y0, 0, 0, 1, 0, ca, 0, sa, w, H - y0,
        sa * nl, 0.25 * nl, -ca * nl, taper);
    }
    return { bark: null, fol, radius: 0.24 };
  }

  // =========================================================================================
  // BUCKETS — one InstancedMesh per (species, variant-group, LOD, part)
  // =========================================================================================

  /**
   * Build a bucket: one shared, pre-sized instanceMatrix + aExposure, and 1..2 sub-meshes
   * (bark and foliage, or wood and moss) that reference them. Both sub-meshes get their OWN
   * aWind buffer because the flex override differs — a trunk bends by height, a canopy card
   * must not fly a metre in a gust.
   */
  _makeBucket(name, cap, parts, opts = {}) {
    if (!this.group || !parts || !parts.length) return null;
    cap = Math.max(1, cap | 0);
    const mat = new Float32Array(cap * 16);
    const matAttr = new THREE.InstancedBufferAttribute(mat, 16);
    matAttr.setUsage(THREE.DynamicDrawUsage);
    const ex = new Float32Array(cap * 2);
    for (let i = 0; i < cap; i++) { ex[i * 2] = 1; ex[i * 2 + 1] = 1; }
    const exAttr = new THREE.InstancedBufferAttribute(ex, 2);
    exAttr.setUsage(THREE.DynamicDrawUsage);

    const bk = {
      name, cap, count: 0, near: 1e9,
      lod: opts.lod ?? 0, ug: !!opts.ug,
      mat, matAttr, ex, exAttr, subs: [],
    };

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p || !p.geo || !p.mat) continue;
      const wa = new Float32Array(cap * 2);
      const flex = p.flex ?? 0;
      if (flex > 0) for (let k = 0; k < cap; k++) wa[k * 2] = flex;
      const waAttr = new THREE.InstancedBufferAttribute(wa, 2);
      waAttr.setUsage(THREE.DynamicDrawUsage);
      p.geo.setAttribute('aWind', waAttr);
      p.geo.setAttribute('aExposure', exAttr);

      const mesh = new THREE.InstancedMesh(p.geo, p.mat, cap);
      mesh.instanceMatrix = matAttr;   // shared: bark and foliage cannot drift apart
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;      // we cull per chunk ourselves
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.castShadow = !!p.cast;
      mesh.receiveShadow = p.receive !== false;
      mesh.name = `Forest.${name}.${p.name ?? 'part'}`;
      if (p.depth) mesh.customDepthMaterial = p.depth;
      this.group.add(mesh);
      this._ownedGeometries.push(p.geo);
      bk.subs.push({ mesh, wa, waAttr, cast: !!p.cast });
    }
    if (!bk.subs.length) return null;
    this._buckets.push(bk);
    return bk;
  }

  _buildTreeBuckets(rand) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    const V = Math.max(1, this._variants | 0);
    const groups = [V, 2, 1, 1];
    const tierIdx = this.ctx?.settings?.tier?.(0, 1, 2, 3) ?? 2;
    this._shadows = tierIdx >= 1;
    this._maxDist = this.ctx?.settings?.tier?.(150, 210, 275, 340) ?? 275;

    const perSpecies = new Int32Array(SPECIES_COUNT);
    for (let i = 0; i < this._n; i++) perSpecies[this._tspec[i]]++;

    const capOf = (lod, spec) => {
      const t = Math.max(1, perSpecies[spec]);
      if (lod === 0) return Math.min(t, 384);
      if (lod === 1) return Math.min(t, 1600);
      if (lod === 2) return Math.min(t, 6400);
      return t;
    };

    const seedBase = (this.ctx?.settings?.get?.('seed') ?? 0x51a5cab) | 0;
    const variantHeights = [];
    this._treeBuckets = [];

    for (let s = 0; s < SPECIES_COUNT; s++) {
      const heights = [];
      heights.radii = [];
      this._treeBuckets[s] = [[], [], [], []];

      const barkName = SPECIES_MATS[s][0], folName = SPECIES_MATS[s][1];
      const barkMat = this._material(barkName, { color: 0x342d26, roughness: 0.9 });
      const folMat = folName
        ? this._material(folName, {
          color: 0x16241c, roughness: 0.45, side: THREE.DoubleSide, alphaTest: 0.3,
        }) : null;
      const folDepth = folName ? this._depthMaterial(folName) : null;

      for (let lod = 0; lod < 4; lod++) {
        for (let v = 0; v < groups[lod]; v++) {
          // The SAME seed for the same variant at every LOD: one tree, four fidelities.
          const rep = lod >= 2 ? 0 : v;
          const vr = new Rand(hashInt(((s + 1) * 7919 + (rep + 1) * 104729) ^ seedBase));
          const geo = lod === 3 ? this._genImpostor(s, vr) : this._genTree(s, vr, lod);
          if (lod === 0) { heights[v] = CANON_H; heights.radii[v] = geo.radius * 1.18; }

          const parts = [];
          const tag = `${SPECIES_NAME[s]}-l${lod}-v${v}`;
          if (geo.bark && !geo.bark.empty) {
            parts.push({
              name: 'bark', geo: geo.bark.toGeometry(`${tag}-bark`), mat: barkMat,
              flex: 0, cast: lod === 0, receive: true,
            });
          }
          if (geo.fol && !geo.fol.empty && folMat) {
            parts.push({
              name: 'foliage', geo: geo.fol.toGeometry(`${tag}-fol`), mat: folMat,
              flex: 0.45, cast: lod === 0, receive: true,
              depth: lod === 0 ? folDepth : null,
            });
          }
          this._treeBuckets[s][lod][v] = this._makeBucket(tag, capOf(lod, s), parts, { lod });
        }
      }
      variantHeights[s] = heights;
    }

    // Now that variant heights exist, fold the per-instance scale into the baked matrices.
    this._resolveScales(variantHeights);
    this._refreshChunkSpheres();
    this.stats.buildMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    void rand;
  }

  // =========================================================================================
  // UNDERGROWTH — ferns, huckleberry, salal, deadfall, stumps, roots, saplings
  // Bare ground between trees is the single loudest "this is a video game" tell.
  // =========================================================================================

  _genFern(rand, v) {
    const buf = new Buf();
    const n = 5 + v + rand.int(0, 3);
    for (let i = 0; i < n; i++) {
      const a = i * PHYLLO + rand.range(-0.25, 0.25);
      const L = rand.range(0.42, 0.88);
      const ca = Math.cos(a), sa = Math.sin(a);
      const lift = rand.range(0.50, 1.20);
      const ul = 1 / Math.hypot(ca, lift, sa);
      const nl = 1 / Math.hypot(ca * 0.25, 1, sa * 0.25);
      emitCard(buf, ca * 0.03, 0.015, sa * 0.03,
        ca * ul, lift * ul, sa * ul, -sa, 0, ca,
        L * 0.40, L, ca * 0.25 * nl, nl, sa * 0.25 * nl, 0.22);
    }
    return buf;
  }

  _genShrub(rand, v) {
    const buf = new Buf();
    const n = 7 + v * 3 + rand.int(0, 3);
    const up = new THREE.Vector3(), side = new THREE.Vector3();
    const nrm = new THREE.Vector3(), p = new THREE.Vector3();
    const R = rand.range(0.35, 0.62), Hh = rand.range(0.45, 0.95);
    for (let i = 0; i < n; i++) {
      const a = i * PHYLLO, rr = Math.sqrt((i + 0.4) / n);
      const px = Math.cos(a) * R * rr, pz = Math.sin(a) * R * rr;
      const py = Hh * (0.25 + 0.70 * rand.next()) * (1 - rr * 0.35);
      p.set(px, py * 0.35, pz);
      up.set(px * 0.6, 1, pz * 0.6).normalize();
      side.set(-Math.sin(a), 0, Math.cos(a));
      nrm.set(px * 0.4, 1, pz * 0.4).normalize();
      emitCross(buf, p, up, side, R * 0.62, Hh * 0.72, nrm, 0.55);
    }
    return buf;
  }

  _genSalal(rand, v) {
    const buf = new Buf();
    const n = 6 + v * 2 + rand.int(0, 3);
    for (let i = 0; i < n; i++) {
      const a = i * PHYLLO + rand.range(-0.2, 0.2);
      const L = rand.range(0.26, 0.46);
      const ca = Math.cos(a), sa = Math.sin(a);
      const lift = rand.range(0.16, 0.52);
      const ul = 1 / Math.hypot(ca, lift, sa);
      emitCard(buf, ca * 0.04, 0.03 + rand.next() * 0.14, sa * 0.04,
        ca * ul, lift * ul, sa * ul, -sa, 0, ca,
        L * 0.82, L, 0, 1, 0, 0.85);
    }
    return buf;
  }

  /** A fallen log. The moss buffer keeps ONLY the up-facing quads — moss does not grow under. */
  _genLog(rand, v) {
    const wood = new Buf(), moss = new Buf();
    // 2.6-6.2 m at a scale of up to 1.35 gave 8.4 m logs. Three of those crossing near the
    // camera is a log jam, not a forest floor, and the deadfall kind is placed by a Poisson-free
    // random scatter that has no idea two of them overlap. 2.2-4.6 m, scaled to at most 1.15.
    const L = rand.range(2.2, 4.6), r = rand.range(0.15, 0.29);
    const segs = 5, sag = rand.range(0.0, 0.11);
    const pts = [], radii = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      pts.push(new THREE.Vector3(
        -L * 0.5 + L * t,
        r * 0.72 - Math.sin(t * Math.PI) * sag,
        Math.sin(t * 3.1 + v) * L * 0.035));
      radii.push(r * (1 - 0.34 * t));
    }
    // 7 sides at 0.055 of radial ripple made a corrugated slab, not a log. 9 sides at 0.032
    // rounds the section and keeps the ripple as bark rather than as flutes.
    emitTube(wood, pts, radii, 9, { cap: true, bark: 0.032, uvCirc: TAU * r });
    emitTube(moss, pts, radii, 9, { upOnly: { min: 0.26, offset: 0.014 }, uvCirc: TAU * r });
    // A torn root plate at the butt end, half in the ground.
    const nr = rand.int(2, 4);
    for (let i = 0; i < nr; i++) {
      const a = rand.next() * TAU;
      const d = new THREE.Vector3(Math.cos(a) * 0.6, rand.range(-0.5, 0.6), Math.sin(a) * 0.6).normalize();
      const b0 = new THREE.Vector3(-L * 0.5, r * 0.6, 0);
      emitTube(wood, [b0, b0.clone().addScaledVector(d, rand.range(0.3, 0.8))],
        [r * 0.34, r * 0.09], 4, { cap: true, uvCirc: TAU * r * 0.34 });
    }
    return { wood, moss };
  }

  /**
   * A cut stump. Returns wood AND a moss cap built from the up-facing quads only, on the same
   * `upOnly` path the deadfall logs use — moss grows on the top of a stump and on its north
   * shoulder, never on its underside, and getting that wrong is the tell that a forest was
   * assembled rather than grown.
   */
  _genStump(rand, v) {
    const wood = new Buf(), moss = new Buf();
    const h = rand.range(0.32, 0.95) + v * 0.1, r = rand.range(0.22, 0.42);
    const pts = [], radii = [];
    for (let i = 0; i <= 3; i++) {
      const t = i / 3, y = -0.45 + (h + 0.45) * t;
      pts.push(new THREE.Vector3(0, y, 0));
      radii.push(r * (1 - 0.14 * t));
    }
    // The flare used to be 0.72 m tall at 1.15 amplitude on a stump only 0.32-0.95 m high, so
    // the ENTIRE stump lived inside the buttress curve and came out as a smooth cone. Half the
    // height and two thirds the amplitude leaves a stump with a straight barrel and a flared
    // foot, which is what a chainsaw leaves behind.
    const flare = { h: 0.45, amp: 0.75, lobes: rand.int(4, 7), phase: rand.next() * TAU };
    emitTube(wood, pts, radii, 9, { flare, bark: 0.05, cap: true, uvCirc: TAU * r });
    // The sawn face, a disc of moss just proud of the top, and a lip that laps a few centimetres
    // down the rim. Deliberately NOT the `upOnly` tube path the logs use: a stump's flanks are
    // vertical, their normals have ny ~ 0.05, and `upOnly` would correctly emit nothing at all.
    // Moss on a stump is a cap, not a skin, so it is authored as a cap.
    const nseg = 9, top = h + 0.010, rm = r * (1 - 0.14) + 0.010;
    const cIdx = moss.push(0, top, 0, 0, 1, 0, 0, 0);
    const ring = [], lip = [];
    const drop = rand.range(0.04, 0.13);
    for (let s = 0; s <= nseg; s++) {
      const a = (s % nseg) / nseg * TAU;
      const cx = Math.cos(a), cz = Math.sin(a);
      ring.push(moss.push(cx * rm, top, cz * rm, 0, 1, 0, cx * rm, cz * rm));
      const nl = 1 / Math.hypot(cx, 0.55, cz);
      lip.push(moss.push(cx * rm, top - drop * (0.55 + 0.45 * Math.sin(a * 3 + flare.phase)),
        cz * rm, cx * nl, 0.55 * nl, cz * nl, cx * rm, cz * rm - drop));
    }
    for (let s = 0; s < nseg; s++) {
      moss.tri(cIdx, ring[s], ring[s + 1]);
      moss.quad(ring[s + 1], ring[s], lip[s], lip[s + 1]);
    }
    const nsp = rand.int(3, 5);
    for (let s = 0; s < nsp; s++) {
      const a = (s / nsp) * TAU + rand.range(-0.3, 0.3);
      emitTube(wood, [
        new THREE.Vector3(Math.cos(a) * r * 0.5, h - 0.05, Math.sin(a) * r * 0.5),
        new THREE.Vector3(Math.cos(a) * r * 0.75, h + rand.range(0.06, 0.34), Math.sin(a) * r * 0.75),
      ], [r * 0.26, 0.012], 4, { cap: true, uvCirc: TAU * r * 0.26 });
    }
    return { wood, moss };
  }

  /**
   * NEEDLE DUFF — the low mat of fallen needles, twigs and moss that covers a conifer floor.
   *
   * This is the cheapest thing in the file and it does the most work. Bare ground between trees
   * is the loudest "video game" tell there is (§10 A2), and the fix is not more ferns: a real
   * forest floor is 90% litter and 10% standing plants. The cards lie almost flat with their
   * normals up, in a shallow dome 5-18 cm tall, so from a 1.7 m eye they are seen at a 15-25 deg
   * grazing angle and read as texture on the ground rather than as objects standing on it — and
   * at that angle each one covers a lot of screen for two triangles.
   */
  _genDuff(rand, v) {
    const buf = new Buf();
    // SIZE IS THE WHOLE DESIGN. The first version used 0.45-1.1 m blades and the lantern turned
    // the forest floor into a bonfire of straw (shots/fx-a-forestdeep.png): at 4 m a 0.9 m card
    // carrying the pine-needle texture reads as half a dozen separate 300 mm STICKS, and a
    // hundred of those is not ground cover, it is debris. Duff is 90-240 mm and WIDER than it is
    // long, so the card is a patch rather than a blade and the needle texture tiles inside it.
    const R = rand.range(0.30, 0.62) + v * 0.08;
    const n = 8 + v * 3 + rand.int(0, 4);
    for (let i = 0; i < n; i++) {
      const a = i * PHYLLO + rand.range(-0.3, 0.3);
      const rr = Math.sqrt((i + 0.4) / n);
      const ca = Math.cos(a), sa = Math.sin(a);
      const L = rand.range(0.09, 0.24);
      // outward and barely upward: the patch lies on the ground and lifts at its far edge
      const lift = rand.range(0.06, 0.26);
      const ul = 1 / Math.hypot(ca, lift, sa);
      const y = 0.010 + (1 - rr) * rand.range(0.01, 0.07);
      emitCard(buf, ca * R * rr * 0.6, y, sa * R * rr * 0.6,
        ca * ul, lift * ul, sa * ul, -sa, 0, ca,
        L * 2.1, L, 0, 1, 0, 0.92);
    }
    return buf;
  }

  /**
   * Waist-high bracken. `_genFern` tops out at 0.88 m of frond; a western sword-fern colony in
   * a wet draw is 1.5 m and it is what actually hides a body. Weighted toward shade and wet.
   */
  _genBracken(rand, v) {
    const buf = new Buf();
    const n = 7 + v * 2 + rand.int(0, 3);
    for (let i = 0; i < n; i++) {
      const a = i * PHYLLO + rand.range(-0.22, 0.22);
      const L = rand.range(0.85, 1.55);
      const ca = Math.cos(a), sa = Math.sin(a);
      const lift = rand.range(0.75, 1.9);
      const ul = 1 / Math.hypot(ca, lift, sa);
      const nl = 1 / Math.hypot(ca * 0.3, 1, sa * 0.3);
      emitCard(buf, ca * 0.05, 0.02 + rand.next() * 0.10, sa * 0.05,
        ca * ul, lift * ul, sa * ul, -sa, 0, ca,
        L * 0.34, L, ca * 0.3 * nl, nl, sa * 0.3 * nl, 0.20);
    }
    return buf;
  }

  _genRoots(rand, v) {
    const buf = new Buf();
    const n = 3 + v + rand.int(0, 2);
    for (let i = 0; i < n; i++) {
      const a = i * PHYLLO + rand.range(-0.3, 0.3);
      const ca = Math.cos(a), sa = Math.sin(a);
      const L = rand.range(0.45, 1.15);
      const rise = rand.range(0.05, 0.16);
      const pts = [], radii = [];
      for (let k = 0; k <= 4; k++) {
        const t = k / 4;
        pts.push(new THREE.Vector3(ca * L * t, rise * Math.sin(t * Math.PI) - 0.06, sa * L * t));
        radii.push(Math.max(0.012, 0.10 * (1 - t * 0.82)));
      }
      emitTube(buf, pts, radii, 5, { bark: 0.06, uvCirc: TAU * 0.10 });
    }
    return buf;
  }

  /** Knee-high conifer regeneration — the thing that fills a gap in a real forest. */
  _genSapling(rand) {
    const bark = new Buf(), fol = new Buf();
    const H = rand.range(1.1, 2.3), r = rand.range(0.026, 0.055);
    emitTube(bark, [
      new THREE.Vector3(0, -0.25, 0),
      new THREE.Vector3(0, H * 0.5, 0),
      new THREE.Vector3(rand.range(-0.05, 0.05), H, rand.range(-0.05, 0.05)),
    ], [r * 1.6, r, r * 0.3], 5, { cap: true, uvCirc: TAU * r });
    const up = new THREE.Vector3(), side = new THREE.Vector3();
    const nrm = new THREE.Vector3(), base = new THREE.Vector3();
    const whorls = 5;
    for (let w = 0; w < whorls; w++) {
      const tw = 0.16 + 0.78 * (w / (whorls - 1));
      const L = 0.42 * H * Math.pow(1 - tw, 0.6) + 0.05;
      for (let b = 0; b < 4; b++) {
        const a = w * PHYLLO + (b / 4) * TAU;
        const ca = Math.cos(a), sa = Math.sin(a);
        up.set(ca, -0.16, sa).normalize();
        side.set(-sa, 0, ca);
        nrm.set(ca * 0.3, 1, sa * 0.3).normalize();
        base.set(ca * r, tw * H, sa * r);
        emitCross(fol, base, up, side, L * 0.62, L * 1.05, nrm, 0.32);
      }
    }
    return { bark, fol };
  }

  _buildUndergrowthBuckets(rand) {
    this._ugFlat = [];
    this._ugKinds = [];
    if (!this.group) return;

    const tierIdx = this.ctx?.settings?.tier?.(0, 1, 2, 3) ?? 2;
    // Per-bucket instance ceiling. Raised with the streaming radius below — a bucket that hits
    // its cap silently drops instances in `_push`, and the symptom is a ring of bare ground at
    // exactly the streaming radius, which looks like a bug in the terrain rather than in here.
    const cap = this.ctx?.settings?.tier?.(320, 560, 900, 1300) ?? 900;

    const fernMat = this._material('foliage-fern', {
      color: 0x1d2f22, roughness: 0.4, side: THREE.DoubleSide, alphaTest: 0.3,
    });
    const needleMat = this._material('foliage-pine', {
      color: 0x16241c, roughness: 0.45, side: THREE.DoubleSide, alphaTest: 0.3,
    });
    /**
     * Deadfall and stumps take BARK, not 'weathered-wood'.
     *
     * Same measurement that moved the snags: PAL.weathered is #6b6155, luminance 0.135, and it
     * is authored for sun-bleached sawn boards. On a 0.9 m stump 3 m from a lantern it is the
     * brightest thing in the frame — shots/fx-d-forestdeep.png has three of them standing in the
     * lantern pool reading as tan traffic cones. A stump in this forest is a wet, rotting,
     * half-mossed lump; #38312a with the bark normal is what it looks like. The moss cap
     * (PAL.moss #1d2b1c) is what breaks up the top, and it can only do that against a dark base.
     */
    const woodMat = this._material('bark-pine', { color: 0x2f2a22, roughness: 0.92 });
    const mossMat = this._material('ground-moss', { color: 0x2b3a28, roughness: 0.8 });
    const barkMat = this._material('bark-pine', { color: 0x342d26, roughness: 0.9 });
    const fernDepth = this._depthMaterial('foliage-fern');
    const needleDepth = this._depthMaterial('foliage-pine');

    const add = (name, weight, variants, fn, opt) => {
      const idx = [];
      for (let v = 0; v < variants; v++) {
        const r = rand.fork(`${name}:${v}`);
        let parts = null;
        try { parts = fn(r, v); } catch (e) { Log.once(`forest:ug:${name}`, `Forest: undergrowth '${name}' failed`, e); }
        if (!parts || !parts.length) continue;
        const bk = this._makeBucket(`ug-${name}-${v}`, cap, parts, { lod: 0, ug: true });
        if (bk) { idx.push(this._ugFlat.length); this._ugFlat.push(bk); }
      }
      if (idx.length) {
        this._ugKinds.push({
          name, weight, idx,
          scale: opt?.scale ?? [0.85, 1.35],
          tilt: opt?.tilt ?? 0.85,
          sink: opt?.sink ?? 0.05,
          wet: opt?.wet ?? 0, shade: opt?.shade ?? 0, open: opt?.open ?? 0,
        });
      }
    };

    const cardPart = (name, buf, mat, depth, flex) => [{
      name, geo: buf.toGeometry(`ug-${name}`), mat, flex: flex ?? 0,
      cast: false, receive: true, depth: depth ?? null,
    }];

    // Litter first, and heaviest. A conifer floor is mostly duff; standing plants are the
    // exception, not the rule, and weighting it the other way is what leaves bare ground.
    add('duff', 0.30, 2, (r, v) => cardPart('duff', this._genDuff(r, v), needleMat, null),
      { scale: [0.8, 1.5], tilt: 1.0, sink: 0.01, shade: 0.35 });
    add('fern', 0.24, 2, (r, v) => cardPart('fern', this._genFern(r, v), fernMat, tierIdx >= 2 ? fernDepth : null),
      { scale: [0.8, 1.5], tilt: 0.75, wet: 0.6, shade: 0.5 });
    add('bracken', 0.13, 2, (r, v) => cardPart('bracken', this._genBracken(r, v), fernMat, tierIdx >= 2 ? fernDepth : null),
      { scale: [0.75, 1.25], tilt: 0.7, wet: 0.7, shade: 0.6 });
    // Huckleberry and salal take the NEEDLE card, not the fern card. The baked 'fern' card is a
    // rachis with 22 evenly spaced straight pinnae — correct for a sword fern and, on a broad-
    // leaved shrub, a picket fence. Two of them side by side in a lantern beam is unmistakable:
    // see the crop of shots/fx-e-forestdeep.png, which is a row of white palings on the ground.
    // Neither card is botanically a salal leaf; the needle sprig at least reads as a mass.
    add('huckleberry', 0.21, 2, (r, v) => cardPart('huck', this._genShrub(r, v), needleMat, null),
      { scale: [0.75, 1.4], tilt: 0.6, shade: 0.2, open: 0.3 });
    add('salal', 0.25, 2, (r, v) => cardPart('salal', this._genSalal(r, v), needleMat, null),
      { scale: [0.9, 1.6], tilt: 0.95, wet: 0.3, shade: 0.4 });
    add('deadfall', 0.06, 2, (r, v) => {
      const g = this._genLog(r, v);
      return [
        { name: 'wood', geo: g.wood.toGeometry('ug-log'), mat: woodMat, flex: 0, cast: tierIdx >= 2, receive: true },
        { name: 'moss', geo: g.moss.toGeometry('ug-logmoss'), mat: mossMat, flex: 0, cast: false, receive: true },
      ];
    }, { scale: [0.8, 1.15], tilt: 0.9, sink: 0.12, shade: 0.3 });
    add('stump', 0.07, 2, (r, v) => {
      const g = this._genStump(r, v);
      return [
        { name: 'stump', geo: g.wood.toGeometry('ug-stump'), mat: woodMat, flex: 0, cast: tierIdx >= 2, receive: true },
        { name: 'moss', geo: g.moss.toGeometry('ug-stumpmoss'), mat: mossMat, flex: 0, cast: false, receive: true },
      ];
    }, { scale: [0.85, 1.5], tilt: 0.5, sink: 0.08 });
    add('roots', 0.08, 2, (r, v) => [{
      name: 'roots', geo: this._genRoots(r, v).toGeometry('ug-roots'), mat: barkMat,
      flex: 0, cast: false, receive: true,
    }], { scale: [0.7, 1.2], tilt: 1.0, sink: 0.03, shade: 0.5 });
    add('sapling', 0.11, 1, (r) => {
      const g = this._genSapling(r);
      return [
        { name: 'stem', geo: g.bark.toGeometry('ug-sap'), mat: barkMat, flex: 0, cast: false, receive: true },
        { name: 'needles', geo: g.fol.toGeometry('ug-sapfol'), mat: needleMat, flex: 0.35, cast: false, receive: true, depth: tierIdx >= 2 ? needleDepth : null },
      ];
    }, { scale: [0.7, 1.5], tilt: 0.7, open: 0.6 });
  }

  /**
   * Bake every undergrowth transform up front, per chunk. Streaming this at runtime was the
   * obvious design and the wrong one: it allocates inside update(), which ARCHITECTURE §12
   * forbids, and the whole table is under 3 MB.
   */
  _pregenUndergrowth() {
    if (!this._ugFlat || !this._ugFlat.length || !this._chunks.length) return;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    const seed = (this.ctx?.settings?.get?.('seed') ?? 0x51a5cab) | 0;
    const rand = new Rand(hashInt(seed ^ 0x0dec0de) | 0);
    const T = this.terrain;
    const cs = FT.chunkSize;
    // Candidate samples per 32 m chunk (1024 m²). 180 with an acceptance around 0.5 gave one
    // plant per 11 m² — one fern per two-and-a-half parking spaces, which is a lawn.
    const per = this.ctx?.settings?.tier?.(80, 140, 220, 300) ?? 220;
    const kinds = this._ugKinds;
    if (!kinds.length) return;

    const sB = new Uint8Array(per), sM = new Float32Array(per * 16);
    const sE = new Float32Array(per), sP = new Float32Array(per);
    const wts = new Float64Array(kinds.length);

    const m = new THREE.Matrix4();
    const qTilt = new THREE.Quaternion(), qYaw = new THREE.Quaternion(), qOut = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0), nrm = new THREE.Vector3();
    const pos = new THREE.Vector3(), scl = new THREE.Vector3(), tgt = new THREE.Vector3();
    const wl = T?.waterLevel ?? 0;
    let total = 0;

    for (let ci = 0; ci < this._chunks.length; ci++) {
      const c = this._chunks[ci];
      let k = 0;
      for (let s = 0; s < per && k < per; s++) {
        const x = c.x - cs * 0.5 + rand.next() * cs;
        const z = c.z - cs * 0.5 + rand.next() * cs;
        let y = 0, slope = 0, path = 0, dens = 0.55, wet = 0.3, expo = 1, surf = 'needles';
        if (T) {
          const p = T.sampleInfo(x, z, _info);
          y = p.y; slope = p.slope; path = p.path; dens = p.density;
          wet = p.wet; expo = p.exposure; surf = p.surface;
          if (p.water) continue;
        } else {
          y = fbm2(x * 0.01, z * 0.01, 3, 2.0, 0.5) * 6;
        }
        if (y < wl + 0.12 || slope > 0.62 || path > 0.55 || surf === 'gravel') continue;

        const canopy = this.canopyAt(x, z);
        // Floor raised from 0.22 to 0.46: even the thinnest, most exposed granite bench in a
        // coastal conifer forest has needle drift and moss on it. Nothing but a worn path, open
        // water or the camp clearing should ever be genuinely bare.
        let accept = 0.46 + 0.54 * clamp01(0.40 + 0.85 * dens + 0.45 * canopy);
        accept *= 1 - 0.85 * clamp01(path * 1.8);
        if (surf === 'granite') accept *= 0.20;
        else if (surf === 'moss') accept *= 1.12;
        else if (surf === 'mud') accept *= 0.55;
        if (rand.next() > clamp01(accept)) continue;

        // Kind choice reads the ground: ferns in wet shade, saplings in the gaps.
        let tw = 0;
        for (let q = 0; q < kinds.length; q++) {
          const kd = kinds[q];
          let w = kd.weight;
          w *= 1 + kd.wet * (wet * 2 - 0.6);
          w *= 1 + kd.shade * (canopy * 1.6 - 0.5);
          w *= 1 + kd.open * (1.2 - canopy * 1.8);
          wts[q] = w > 0.0005 ? w : 0.0005;
          tw += wts[q];
        }
        let pick = rand.next() * tw, kidx = kinds.length - 1;
        for (let q = 0; q < kinds.length; q++) { pick -= wts[q]; if (pick <= 0) { kidx = q; break; } }
        const kd = kinds[kidx];
        const flat = kd.idx[rand.int(0, kd.idx.length - 1)];

        if (T) T.normalAt(x, z, nrm); else nrm.set(0, 1, 0);
        tgt.set(lerp(0, nrm.x, kd.tilt), 1, lerp(0, nrm.z, kd.tilt)).normalize();
        qTilt.setFromUnitVectors(up, tgt);
        qYaw.setFromAxisAngle(up, rand.next() * TAU);
        qOut.copy(qTilt).multiply(qYaw);
        const sc = rand.range(kd.scale[0], kd.scale[1]);
        pos.set(x, y - kd.sink * sc, z);
        scl.set(sc, sc, sc);
        m.compose(pos, qOut, scl);
        m.toArray(sM, k * 16);
        sB[k] = flat;
        sE[k] = clamp01(expo * (1 - 0.55 * canopy));
        sP[k] = 0.02 + 0.97 * rand.next();   // see _placeTrees: keep aWind.y off the 0.0001 floor
        k++;

        if (this.physics && (kd.name === 'deadfall' || kd.name === 'stump')) {
          try {
            const h = kd.name === 'stump' ? 0.9 * sc : 0.5 * sc;
            const id = this.physics.addColliderAt(x, y - 0.15, z,
              kd.name === 'stump' ? 'stump' : 'prop',
              { shape: 'capsule', radius: 0.34 * sc, height: h, occlusion: 0.55 });
            if (id >= 0) this._colliders.push(id);
          } catch (e) { Log.once('forest:ugcol', 'Forest: undergrowth collider failed', e); }
        }
      }
      if (k > 0) {
        c.ug = { n: k, b: sB.slice(0, k), m: sM.slice(0, k * 16), e: sE.slice(0, k), p: sP.slice(0, k) };
        total += k;
      } else {
        c.ug = null;
      }
      c.ugPending = false;
    }
    this._ugTotal = total;
    this.stats.undergrowth = total;
    Log.debug(`Forest: ${total} undergrowth instances in `
      + `${((typeof performance !== 'undefined' ? performance.now() : 0) - t0).toFixed(0)} ms`);
  }

  // =========================================================================================
  // COLLIDERS
  // =========================================================================================

  _registerColliders() {
    const ph = this.physics;
    if (!ph || typeof ph.addColliderAt !== 'function') return;
    const n = this._n;
    if (n > FT.colliderCap) {
      Log.warn(`Forest: ${n} trunks exceeds colliderCap ${FT.colliderCap} — registering all `
        + 'anyway; a tree you can walk through is a worse bug than a fat broadphase.');
    }
    for (let i = 0; i < n; i++) {
      const r = Math.max(0.10, this._trad[i] || 0.28);
      const h = Math.min(FT.colliderHeightCap, Math.max(1.2, this._thgt[i] || 18));
      try {
        const id = ph.addColliderAt(this._tx[i], this._ty[i] - 0.10, this._tz[i], 'trunk',
          { shape: 'capsule', radius: r, height: h });
        if (id >= 0) this._colliders.push(id);
      } catch (e) {
        Log.once('forest:col', 'Forest: trunk collider registration failed', e);
        break;
      }
    }
  }

  // =========================================================================================
  // PER-FRAME
  // =========================================================================================

  /**
   * Select the LOD band for every tree in every visible chunk and refill the instance
   * buffers. Zero allocation: every vector, sphere and frustum is module scope, every write
   * is into a pre-sized Float32Array.
   */
  _rebuild(cam) {
    const buckets = this._buckets;
    for (let b = 0; b < buckets.length; b++) { buckets[b].count = 0; buckets[b].near = 1e9; }

    _projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);

    const cx = _camPos.x, cy = _camPos.y, cz = _camPos.z;
    const far = this._maxDist;
    const l0 = FT.lod0, l1 = FT.lod1, l2 = FT.lod2;
    const ugR = this._ugRadius, ugR2 = ugR * ugR;
    const tb = this._treeBuckets, flat = this._ugFlat;
    const chunks = this._chunks;
    const V = Math.max(1, this._variants | 0);
    let visChunks = 0, visTrees = 0, visUg = 0;

    for (let k = 0; k < chunks.length; k++) {
      const c = chunks[k];
      const dx = c.x - cx, dz = c.z - cz;
      const d2 = dx * dx + dz * dz;
      const nearR = l0 + c.r;
      const isNear = d2 < nearR * nearR;
      if (!isNear) {
        const fr = far + c.r;
        if (d2 > fr * fr) continue;
        // Near chunks skip the frustum test on purpose: the shadow pass needs trees that are
        // behind the camera, and 9 chunks of overdraw is cheaper than a missing tree shadow.
        _sphere.center.set(c.x, c.y, c.z);
        _sphere.radius = c.r;
        if (!_frustum.intersectsSphere(_sphere)) continue;
      }
      visChunks++;

      const tr = c.trees;
      if (tr && tb) {
        for (let t = 0; t < tr.length; t++) {
          const i = tr[t];
          const ax = this._tx[i] - cx, ay = this._ty[i] - cy, az = this._tz[i] - cz;
          const d = Math.sqrt(ax * ax + ay * ay + az * az) * this._tjit[i];
          let lod, g;
          if (d < l0) { lod = 0; g = this._tvar[i] % V; }
          else if (d < l1) { lod = 1; g = this._tvar[i] & 1; }
          else if (d < l2) { lod = 2; g = 0; }
          else if (d < far) { lod = 3; g = 0; }
          else continue;
          const bk = tb[this._tspec[i]][lod][g];
          if (bk) { this._push(bk, this._tmat, i * 16, this._texpo[i], this._tphase[i], d); visTrees++; }
        }
      }

      const ug = c.ug;
      if (ug && flat && d2 < (ugR + c.r) * (ugR + c.r)) {
        const um = ug.m;
        for (let j = 0; j < ug.n; j++) {
          const o = j * 16;
          const ex = um[o + 12] - cx, ez = um[o + 14] - cz;
          const dd = ex * ex + ez * ez;
          if (dd > ugR2) continue;
          const bk = flat[ug.b[j]];
          if (bk) { this._push(bk, um, o, ug.e[j], ug.p[j], Math.sqrt(dd)); visUg++; }
        }
      }
    }

    this.stats.chunksVisible = visChunks;
    this.stats.visible = visTrees;
    this.stats.ugVisible = visUg;
    this._flush();
  }

  /** Copy one pre-baked 16-float matrix into a bucket. No Matrix4.compose(), no allocation. */
  _push(bk, src, off, expo, phase, dist) {
    const n = bk.count;
    if (n >= bk.cap) return;
    const d = bk.mat, o = n * 16;
    d[o] = src[off]; d[o + 1] = src[off + 1]; d[o + 2] = src[off + 2]; d[o + 3] = src[off + 3];
    d[o + 4] = src[off + 4]; d[o + 5] = src[off + 5]; d[o + 6] = src[off + 6]; d[o + 7] = src[off + 7];
    d[o + 8] = src[off + 8]; d[o + 9] = src[off + 9]; d[o + 10] = src[off + 10]; d[o + 11] = src[off + 11];
    d[o + 12] = src[off + 12]; d[o + 13] = src[off + 13]; d[o + 14] = src[off + 14]; d[o + 15] = src[off + 15];
    const w = n * 2 + 1;
    bk.ex[n * 2] = expo;
    const subs = bk.subs;
    for (let s = 0; s < subs.length; s++) subs[s].wa[w] = phase;
    if (dist < bk.near) bk.near = dist;
    bk.count = n + 1;
  }

  /** Publish counts, upload only the used range, and decide who casts a shadow. */
  _flush() {
    const shadowOn = this._shadows !== false;
    const sr = FT.shadowRange;
    const ugSr = FT.ugShadowRange;
    let draws = 0;
    const buckets = this._buckets;
    for (let b = 0; b < buckets.length; b++) {
      const bk = buckets[b];
      const n = bk.count;
      const vis = n > 0;
      if (vis) {
        const ma = bk.matAttr;
        if (ma.clearUpdateRanges) { ma.clearUpdateRanges(); ma.addUpdateRange(0, n * 16); }
        ma.needsUpdate = true;
        const ea = bk.exAttr;
        if (ea.clearUpdateRanges) { ea.clearUpdateRanges(); ea.addUpdateRange(0, n * 2); }
        ea.needsUpdate = true;
      }
      // Shadow casting is a band, not a flag: past `shadowRange` a tree's shadow is smaller
      // than a shadow-map texel and costs a full extra draw per casting light to render.
      // ART_DIRECTION §3.5. Undergrowth runs on its own, much shorter leash.
      const cast = vis && shadowOn && bk.lod === 0
        && bk.near < (bk.ug ? ugSr : sr);
      const subs = bk.subs;
      for (let s = 0; s < subs.length; s++) {
        const sub = subs[s];
        sub.mesh.count = n;
        sub.mesh.visible = vis;
        sub.mesh.castShadow = cast && sub.cast;
        if (vis) {
          const wa = sub.waAttr;
          if (wa.clearUpdateRanges) { wa.clearUpdateRanges(); wa.addUpdateRange(0, n * 2); }
          wa.needsUpdate = true;
          draws++;
        }
      }
    }
    this.stats.drawCalls = draws;
  }

  /**
   * Per-frame. Cheap by construction: the visible set is only rebuilt when the camera has
   * actually moved or turned, or every `rebuildMaxFrames` frames, whichever comes first.
   */
  update(dt, elapsed) {
    if (this._disposed || !this.ready) return;
    if (!this.enabled) return;
    this._time = elapsed !== undefined ? elapsed : this._time + (dt || 0);

    const cam = this.ctx?.camera;
    if (!cam) return;

    _camPos.setFromMatrixPosition(cam.matrixWorld);
    _camQuat.setFromRotationMatrix(cam.matrixWorld);

    this._framesSinceRebuild++;
    const moved = _camPos.distanceToSquared(this._lastCamPos);
    const turned = 1 - Math.abs(_camQuat.dot(this._lastCamQuat));

    if (moved > FT.rebuildMoveEps * FT.rebuildMoveEps
      || turned > FT.rebuildTurnEps
      || this._framesSinceRebuild >= FT.rebuildMaxFrames) {
      this._rebuild(cam);
      this._lastCamPos.copy(_camPos);
      this._lastCamQuat.copy(_camQuat);
      this._framesSinceRebuild = 0;
      this.stats.rebuilds++;
    }
  }

  /** Nothing here is resolution-dependent. */
  resize(_w, _h) { }

  // =========================================================================================
  // QUERIES
  // =========================================================================================

  /**
   * Trunks near a point, for sound occlusion (NoiseSystem) and line of sight (Campers).
   *
   * @param {{x:number,y:number,z:number}} position
   * @param {number} [radius=12]  metres, XZ
   * @param {Array} [out]  filled in place and returned; a pooled internal array otherwise
   * @returns {Array<{x,y,z,radius,height,species,dist}>}
   *
   * !! The ENTRY OBJECTS come from an internal pool and are overwritten by the next call.
   *    Read what you need before calling again; never retain them.
   */
  occludersNear(position, radius = 12, out = null) {
    const arr = Array.isArray(out) ? out : this._occOut;
    arr.length = 0;
    if (this._disposed || !position || !this._n || !this._chunks.length) return arr;

    const r = Math.max(0.25, radius);
    const px = position.x || 0, pz = position.z || 0;
    const cs = FT.chunkSize;
    const gx0 = clamp((((px - r) - this._cx0) / cs) | 0, 0, this._cnx - 1);
    const gx1 = clamp((((px + r) - this._cx0) / cs) | 0, 0, this._cnx - 1);
    const gz0 = clamp((((pz - r) - this._cz0) / cs) | 0, 0, this._cnz - 1);
    const gz1 = clamp((((pz + r) - this._cz0) / cs) | 0, 0, this._cnz - 1);
    const pool = this._occPool;
    const cap = 96;

    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const c = this._chunks[gz * this._cnx + gx];
        if (!c || !c.trees) continue;
        for (let t = 0; t < c.trees.length; t++) {
          const i = c.trees[t];
          const dx = this._tx[i] - px, dz = this._tz[i] - pz;
          const tr = this._trad[i] || 0.28;
          const reach = r + tr;
          const d2 = dx * dx + dz * dz;
          if (d2 > reach * reach) continue;
          const k = arr.length;
          if (k >= cap) return arr;
          let rec = pool[k];
          if (!rec) { rec = { x: 0, y: 0, z: 0, radius: 0, height: 0, species: '', dist: 0 }; pool[k] = rec; }
          rec.x = this._tx[i]; rec.y = this._ty[i]; rec.z = this._tz[i];
          rec.radius = tr;
          rec.height = this._thgt[i] || 18;
          rec.species = SPECIES_NAME[this._tspec[i]] ?? 'fir';
          rec.dist = Math.sqrt(d2);
          arr.push(rec);
        }
      }
    }
    return arr;
  }

  /** Canopy density 0..1, bilinear. Weather reads this for shelter and drip. */
  canopyAt(x, z) {
    const g = this._canopy;
    if (!g) return 0;
    const N = this._cgN, cell = this._cgCell;
    const fx = clamp((x - this._cgX0) / cell, 0, N - 1.001);
    const fz = clamp((z - this._cgZ0) / cell, 0, N - 1.001);
    const x0 = fx | 0, z0 = fz | 0;
    const tx = fx - x0, tz = fz - z0;
    const i0 = z0 * N + x0, i1 = i0 + N;
    const a = g[i0] + (g[i0 + 1] - g[i0]) * tx;
    const b = g[i1] + (g[i1 + 1] - g[i1]) * tx;
    return clamp01(a + (b - a) * tz);
  }

  /** Same field. NoiseSystem, AudioEngine and VoiceBank all call it by this name. */
  densityAt(x, z) { return this.canopyAt(x, z); }

  /** Descriptor for one tree index. Fills `out` if given. */
  treeAt(i, out) {
    const o = out ?? { x: 0, y: 0, z: 0, radius: 0, height: 0, species: 'fir', index: -1 };
    if (!this._n || i < 0 || i >= this._n) { o.index = -1; return o; }
    o.index = i;
    o.x = this._tx[i]; o.y = this._ty[i]; o.z = this._tz[i];
    o.radius = this._trad[i] || 0.28;
    o.height = this._thgt[i] || 18;
    o.species = SPECIES_NAME[this._tspec[i]] ?? 'fir';
    return o;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (this.group) this.group.visible = this.enabled;
    if (this.enabled) this._framesSinceRebuild = 999;
  }

  // =========================================================================================
  // TEARDOWN
  // =========================================================================================

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.ready = false;

    for (let i = 0; i < this._unsub.length; i++) {
      try { this._unsub[i]?.(); } catch (e) { Log.once('forest:unsub', 'Forest: unsubscribe threw', e); }
    }
    this._unsub.length = 0;

    const ph = this.physics;
    if (ph && typeof ph.removeCollider === 'function') {
      for (let i = 0; i < this._colliders.length; i++) {
        try { ph.removeCollider(this._colliders[i]); } catch (e) { /* physics already gone */ }
      }
    }
    this._colliders.length = 0;

    for (let b = 0; b < this._buckets.length; b++) {
      const bk = this._buckets[b];
      for (let s = 0; s < bk.subs.length; s++) {
        const mesh = bk.subs[s].mesh;
        if (mesh.parent) mesh.parent.remove(mesh);
        mesh.customDepthMaterial = null;
        try { mesh.dispose?.(); } catch (e) { /* already released */ }
      }
      bk.subs.length = 0;
      bk.mat = null; bk.ex = null; bk.matAttr = null; bk.exAttr = null;
    }
    this._buckets.length = 0;
    this._treeBuckets = null;
    this._ugBuckets = null;
    this._ugFlat = null;
    this._ugKinds = null;

    for (let i = 0; i < this._ownedGeometries.length; i++) {
      try { this._ownedGeometries[i].dispose(); } catch (e) { /* already released */ }
    }
    this._ownedGeometries.length = 0;
    for (let i = 0; i < this._ownedMaterials.length; i++) {
      try { this._ownedMaterials[i].dispose(); } catch (e) { /* already released */ }
    }
    this._ownedMaterials.length = 0;
    for (let i = 0; i < this._ownedTextures.length; i++) {
      try { this._ownedTextures[i].dispose(); } catch (e) { /* already released */ }
    }
    this._ownedTextures.length = 0;
    // Shared library materials — we only tuned their alpha cutout. Drop the references;
    // disposing them here would take the foliage out from under Props and CabinSite.
    this._cutoutMats.length = 0;

    if (this.group) {
      if (this.group.parent) this.group.parent.remove(this.group);
      this.group.clear?.();
      this.group = null;
    }

    for (let i = 0; i < this._chunks.length; i++) {
      const c = this._chunks[i];
      if (c) { c.trees = null; c.ug = null; }
    }
    this._chunks.length = 0;
    this._chunkIndex = null;
    this._canopy = null;
    this._tx = this._ty = this._tz = null;
    this._tmat = null; this._tspec = null; this._tvar = null;
    this._trad = null; this._thgt = null; this._tphase = null;
    this._texpo = null; this._tjit = null;
    this._occOut.length = 0;
    this._occPool.length = 0;
    this._ugQueue.length = 0;
    this._n = 0;
    this.terrain = null; this.mats = null; this.physics = null;
  }
}

export default Forest;
