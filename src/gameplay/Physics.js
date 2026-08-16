/**
 * Physics — capsule-vs-world collision, pooled queries, and carried-part simulation.
 *
 * OWNER: Player agent.  See ARCHITECTURE.md §3–§5, §12 and GAME_DESIGN.md §4.1, §4.2, §5.1, §5.3.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------------------------
 * There is no triangle soup in this game. The world collides in two halves:
 *
 *   1. THE GROUND is an analytic heightfield. We ask `Terrain.heightAt(x,z)` / `normalAt(x,z)`.
 *      Exact, O(1), no acceleration structure. If `Terrain` is absent we use a flat plane at y=0.
 *
 *   2. EVERYTHING ELSE is a primitive registered through `addCollider()` — a capsule for a tree
 *      trunk, an oriented box for a wall/panel/crate, a sphere for a boulder — stored in a uniform
 *      spatial hash of 4 m cells. We never raycast a Mesh.
 *
 * Every query is allocation-free after warm-up. Hits come from a small ring pool.
 *
 * ---------------------------------------------------------------------------------------------
 * THE Hit OBJECT IS POOLED. READ THIS.
 * ---------------------------------------------------------------------------------------------
 *   Hit = { point:Vector3, normal:Vector3, distance:number, object:Object3D|null, kind:string,
 *           collider:Collider|null, layer:int, occlusion:number, isTerrain:bool }
 *
 * `raycast()` and `sphereCast()` return an object drawn from a ring of 8 pre-allocated Hits.
 * **A returned Hit is only valid until your 8th subsequent query.** In practice: treat it as
 * valid until the next call. Copy what you need out of it IMMEDIATELY:
 *
 *     const h = physics.raycast(o, d, 30);
 *     if (h) { myVec.copy(h.point); const kind = h.kind; }   // correct
 *     const hits = [physics.raycast(...), physics.raycast(...)];  // WRONG — aliased garbage
 *
 * Never store a Hit. Never put one in an event payload.
 *
 * ---------------------------------------------------------------------------------------------
 * CONVENTIONS OTHER AGENTS MUST MATCH
 * ---------------------------------------------------------------------------------------------
 *   • `moveCapsule(position, ...)` — `position` is the capsule's **FEET** (the base point), not
 *     its centre. The capsule occupies y ∈ [position.y, position.y + height]; its inner segment
 *     runs from position.y + radius to position.y + height - radius. Player's camera sits at
 *     position.y + eyeHeight (1.7).
 *   • Physics does NOT apply gravity. `Player` integrates gravity (-22, GAME_DESIGN §5) into its
 *     own velocity and hands the result in. We only resolve.
 *   • Distances are metres, angles radians unless a name ends in `Deg`.
 *
 * ---------------------------------------------------------------------------------------------
 * RAY BUDGET (ARCHITECTURE.md §12)
 * ---------------------------------------------------------------------------------------------
 *   `this.rayCount` — raycast() + sphereCast() calls in the current frame window. Budget 12.
 *                     Exceeding it logs once, with the count, so the abuser can be found.
 *   `this.losCount` — lineOfSight() / visibleFraction() / skylineFraction() / occlusionAlong()
 *                     calls. These walk the hash and early-out; they are an order of magnitude
 *                     cheaper than a heightfield march, so they get their own, larger budget
 *                     (`TUNING.losBudget`). Campers may call them freely.
 *   Counters are snapshotted into `this.stats` and reset at the top of `update()`, so `stats`
 *   describes one whole frame (offset by one system-ordering boundary).
 */

import * as THREE from 'three';
import { Log } from '../core/Log.js';

// =================================================================================================
// TUNING — one object, per ARCHITECTURE.md; a balance pass never edits logic.
// =================================================================================================

export const TUNING = {
  // --- world
  gravity: -22.0,                 // GAME_DESIGN §5. Physics does not apply it; exported for Player.
  cellSize: 4.0,                  // spatial hash cell, metres

  // --- capsule movement (GAME_DESIGN §5.1)
  capsuleRadius: 0.42,            // "wide — you bump things"
  capsuleHeight: 1.80,            // standing total height (eye at 1.70)
  crouchHeight: 1.15,             // GAME_DESIGN §4.4
  stepHeight: 0.45,               // GAME_DESIGN §5.1 "Step height 0.45 m"
  slopeLimitDeg: 50,              // above this you slide instead of walk
  groundSnap: 0.30,               // how far we glue to the ground going downhill
  skin: 0.002,                    // depenetration overshoot; stops re-contact jitter
  depenIterations: 4,
  maxSubsteps: 4,

  // --- budgets
  rayBudget: 12,                  // ARCHITECTURE.md §12
  losBudget: 96,

  // --- carried parts (GAME_DESIGN §5.3)
  carrySpringK: 28.0,             // "spring (k = 28, damping 0.55)"
  carryDamping: 0.55,             // damping ratio ζ — < 1, so heavy parts overshoot and swing
  carryMassRef: 24.0,             // kg; a joist. Mass is normalised against this.
  carryMaxLag: 0.85,              // m — hard leash so a beam never detaches from the hands
  carryAngularMax: 11.0,          // rad/s
  carryImpactSpeed: 1.2,          // m/s — GAME_DESIGN §5.3 bump threshold
  carryImpactRadius: 18,          // m  — GAME_DESIGN §5.3
  carryImpactCooldown: 0.32,      // s  — a beam scraping a trunk is one noise, not forty
  carryRestitution: 0.22,
  carryFriction: 0.18,
};

const DEG = Math.PI / 180;

// =================================================================================================
// Layers & kinds
// =================================================================================================

/** Collision layers. Masks are bitfields; pass `mask` to any query to filter. */
export const LAYER = {
  TERRAIN: 1 << 0,   // the heightfield itself
  STATIC: 1 << 1,   // trunks, rocks, stumps, tents, buildings — the world as found
  BUILD: 1 << 2,   // the growing cabin: piers, beams, studs, panels
  PROP: 1 << 3,   // crates, pallets, dropped parts, vehicles
  FOLIAGE: 1 << 4,   // undergrowth — soft; does not block movement, barely blocks sound
  ACTOR: 1 << 5,   // campers (Campers may register its own capsules here)
  WATER: 1 << 6,
};

/** Common mask presets. */
export const MASK = {
  ALL: 0xffffffff,
  SOLID: LAYER.TERRAIN | LAYER.STATIC | LAYER.BUILD | LAYER.PROP,
  MOVE: LAYER.TERRAIN | LAYER.STATIC | LAYER.BUILD | LAYER.PROP,
  SIGHT: LAYER.TERRAIN | LAYER.STATIC | LAYER.BUILD | LAYER.PROP,
  SOUND: LAYER.TERRAIN | LAYER.STATIC | LAYER.BUILD | LAYER.PROP | LAYER.FOLIAGE,
  WORLD: LAYER.STATIC | LAYER.BUILD | LAYER.PROP,
};

const SHAPE_SPHERE = 0;
const SHAPE_CAPSULE = 1;
const SHAPE_BOX = 2;

/**
 * kind -> defaults. `occlusion` is the acoustic blocker factor from GAME_DESIGN §4.2 —
 * NoiseSystem multiplies these along the ray. Unknown kinds get a sane default and one warning.
 */
export const KINDS = {
  terrain: { layer: LAYER.TERRAIN, occlusion: 0.50, blocksMove: true, shape: SHAPE_BOX },
  trunk: { layer: LAYER.STATIC, occlusion: 0.88, blocksMove: true, shape: SHAPE_CAPSULE },
  tree: { layer: LAYER.STATIC, occlusion: 0.88, blocksMove: true, shape: SHAPE_CAPSULE },
  stump: { layer: LAYER.STATIC, occlusion: 0.80, blocksMove: true, shape: SHAPE_CAPSULE },
  rock: { layer: LAYER.STATIC, occlusion: 0.50, blocksMove: true, shape: SHAPE_SPHERE },
  undergrowth: { layer: LAYER.FOLIAGE, occlusion: 0.92, blocksMove: false, shape: SHAPE_BOX },
  foliage: { layer: LAYER.FOLIAGE, occlusion: 0.92, blocksMove: false, shape: SHAPE_BOX },
  wall: { layer: LAYER.BUILD, occlusion: 0.65, blocksMove: true, shape: SHAPE_BOX },
  panel: { layer: LAYER.BUILD, occlusion: 0.65, blocksMove: true, shape: SHAPE_BOX },
  beam: { layer: LAYER.BUILD, occlusion: 0.75, blocksMove: true, shape: SHAPE_BOX },
  post: { layer: LAYER.BUILD, occlusion: 0.80, blocksMove: true, shape: SHAPE_BOX },
  floor: { layer: LAYER.BUILD, occlusion: 0.65, blocksMove: true, shape: SHAPE_BOX },
  roof: { layer: LAYER.BUILD, occlusion: 0.65, blocksMove: true, shape: SHAPE_BOX },
  tent: { layer: LAYER.STATIC, occlusion: 0.90, blocksMove: true, shape: SHAPE_BOX },
  building: { layer: LAYER.STATIC, occlusion: 0.45, blocksMove: true, shape: SHAPE_BOX },
  vehicle: { layer: LAYER.PROP, occlusion: 0.45, blocksMove: true, shape: SHAPE_BOX },
  crate: { layer: LAYER.PROP, occlusion: 0.70, blocksMove: true, shape: SHAPE_BOX },
  prop: { layer: LAYER.PROP, occlusion: 0.70, blocksMove: true, shape: SHAPE_BOX },
  part: { layer: LAYER.PROP, occlusion: 0.75, blocksMove: true, shape: SHAPE_BOX },
  actor: { layer: LAYER.ACTOR, occlusion: 0.85, blocksMove: false, shape: SHAPE_CAPSULE },
  water: { layer: LAYER.WATER, occlusion: 1.00, blocksMove: false, shape: SHAPE_BOX },
};

const DEFAULT_KIND = { layer: LAYER.PROP, occlusion: 0.75, blocksMove: true, shape: SHAPE_BOX };

// =================================================================================================
// Module-scope scratch. Nothing below allocates during a frame.
// =================================================================================================

// generic
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m0 = new THREE.Matrix4();
const _box3 = new THREE.Box3();

// moveCapsule (never aliased with query scratch)
const _mcP = new THREE.Vector3();
const _mcV = new THREE.Vector3();
const _mcN = new THREE.Vector3();
const _mcT = new THREE.Vector3();

// carried-part sim
const _carPos = new THREE.Vector3();
const _carQ = new THREE.Quaternion();
const _carA = new THREE.Vector3();
const _carB = new THREE.Vector3();
const _carC = new THREE.Vector3();
const _carQ2 = new THREE.Quaternion();

// scalar narrow-phase results (numbers only — impossible to alias)
const _ray = { t: 0, nx: 0, ny: 1, nz: 0, hit: false };
const _pen = { depth: 0, nx: 0, ny: 1, nz: 0, hit: false, cx: 0, cy: 0, cz: 0 };
const _ss = { ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, s: 0, t: 0 };
const _lp = { x: 0, y: 0, z: 0 };

const MAX_CANDIDATES = 384;
const _cand = new Array(MAX_CANDIDATES).fill(null);

// Reusable descriptor for addColliderAt() — never retained by the collider record.
const _desc = { position: { x: 0, y: 0, z: 0 }, isObject3D: false };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Footstep surface implied by a collider kind, for Player's `player:footstep` payload. */
function surfaceForKind(kind) {
  switch (kind) {
    case 'rock': return 'granite';
    case 'trunk': case 'tree': case 'stump': return 'wood';
    case 'vehicle': return 'metal';
    case 'tent': return 'canvas';
    default: return 'wood';
  }
}

// =================================================================================================
// Collider record — one hidden class, created cold in addCollider(), recycled via a free list.
// =================================================================================================

class Collider {
  constructor(id) {
    this.id = id;
    this.alive = false;
    this.object = null;         // Object3D | null
    this.kind = 'prop';
    this.layer = LAYER.PROP;
    this.occlusion = 0.75;
    this.blocksMove = true;
    this.dynamic = false;
    this.shape = SHAPE_BOX;
    this.userData = null;

    // centre
    this.px = 0; this.py = 0; this.pz = 0;
    // sphere / capsule
    this.radius = 0.5;
    this.half = 0.5;                       // capsule half-segment length
    this.axx = 0; this.axy = 1; this.axz = 0;   // capsule axis (unit)
    // box half-extents
    this.ex = 0.5; this.ey = 0.5; this.ez = 0.5;
    // box basis (world-space orthonormal axes)
    this.ux = 1; this.uy = 0; this.uz = 0;
    this.vx = 0; this.vy = 1; this.vz = 0;
    this.wx = 0; this.wy = 0; this.wz = 1;
    this.axisAligned = true;

    // world AABB
    this.minX = 0; this.minY = 0; this.minZ = 0;
    this.maxX = 0; this.maxY = 0; this.maxZ = 0;

    // hashed cell range
    this.c0 = 0; this.c1 = 0; this.z0 = 0; this.z1 = 0;
    this.hashed = false;

    this._stamp = 0;
  }
}

// -------------------------------------------------------------------------------------------------
// scalar geometry helpers
// -------------------------------------------------------------------------------------------------

/** Closest points between segment (p1,q1) and segment (p2,q2). Writes _ss. */
function segSeg(p1x, p1y, p1z, q1x, q1y, q1z, p2x, p2y, p2z, q2x, q2y, q2z) {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  const EPS = 1e-9;
  let s = 0, t = 0;

  if (a <= EPS && e <= EPS) {
    s = 0; t = 0;
  } else if (a <= EPS) {
    s = 0; t = clamp01(f / e);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) {
      t = 0; s = clamp01(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  _ss.ax = p1x + d1x * s; _ss.ay = p1y + d1y * s; _ss.az = p1z + d1z * s;
  _ss.bx = p2x + d2x * t; _ss.by = p2y + d2y * t; _ss.bz = p2z + d2z * t;
  _ss.s = s; _ss.t = t;
}

/** World point -> collider-local. Writes _lp. */
function toLocal(col, x, y, z) {
  const dx = x - col.px, dy = y - col.py, dz = z - col.pz;
  if (col.axisAligned) { _lp.x = dx; _lp.y = dy; _lp.z = dz; return; }
  _lp.x = dx * col.ux + dy * col.uy + dz * col.uz;
  _lp.y = dx * col.vx + dy * col.vy + dz * col.vz;
  _lp.z = dx * col.wx + dy * col.wy + dz * col.wz;
}

/** Local direction -> world, into out {x,y,z}. */
function dirToWorld(col, lx, ly, lz, out) {
  if (col.axisAligned) { out.x = lx; out.y = ly; out.z = lz; return; }
  out.x = lx * col.ux + ly * col.vx + lz * col.wx;
  out.y = lx * col.uy + ly * col.vy + lz * col.wy;
  out.z = lx * col.uz + ly * col.vz + lz * col.wz;
}

/** Ray vs sphere. Writes _ray. */
function rayVsSphere(ox, oy, oz, dx, dy, dz, maxT, cx, cy, cz, r) {
  _ray.hit = false;
  const mx = ox - cx, my = oy - cy, mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r * r;
  if (c > 0 && b > 0) return;
  const disc = b * b - c;
  if (disc < 0) return;
  const t = -b - Math.sqrt(disc);
  if (t < 0 || t > maxT) return;
  const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
  const inv = 1 / Math.max(1e-8, r);
  _ray.t = t;
  _ray.nx = (px - cx) * inv; _ray.ny = (py - cy) * inv; _ray.nz = (pz - cz) * inv;
  _ray.hit = true;
}

/** Ray vs capsule (segment a..b, radius r). Writes _ray. */
function rayVsCapsule(ox, oy, oz, dx, dy, dz, maxT, ax, ay, az, bx, by, bz, r) {
  _ray.hit = false;
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const oax = ox - ax, oay = oy - ay, oaz = oz - az;
  const baba = bax * bax + bay * bay + baz * baz;
  const bard = bax * dx + bay * dy + baz * dz;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = dx * oax + dy * oay + dz * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;

  const A = baba - bard * bard;
  const B = baba * rdoa - baoa * bard;
  const C = baba * oaoa - baoa * baoa - r * r * baba;

  if (Math.abs(A) > 1e-9) {
    const h = B * B - A * C;
    if (h >= 0) {
      const t = (-B - Math.sqrt(h)) / A;
      const y = baoa + t * bard;
      if (y > 0 && y < baba && t >= 0 && t <= maxT) {
        const inv = 1 / Math.max(1e-8, r);
        const k = y / baba;
        _ray.t = t;
        _ray.nx = (oax + t * dx - bax * k) * inv;
        _ray.ny = (oay + t * dy - bay * k) * inv;
        _ray.nz = (oaz + t * dz - baz * k) * inv;
        _ray.hit = true;
        return;
      }
    }
  }
  // caps
  const y0 = baoa;
  let ccx, ccy, ccz;
  if (y0 <= 0) { ccx = ax; ccy = ay; ccz = az; } else { ccx = bx; ccy = by; ccz = bz; }
  rayVsSphere(ox, oy, oz, dx, dy, dz, maxT, ccx, ccy, ccz, r);
  if (_ray.hit) return;
  // the other cap, in case the ray enters from the far end
  if (y0 <= 0) { ccx = bx; ccy = by; ccz = bz; } else { ccx = ax; ccy = ay; ccz = az; }
  rayVsSphere(ox, oy, oz, dx, dy, dz, maxT, ccx, ccy, ccz, r);
}

/** Ray vs (optionally inflated) oriented box. Writes _ray. Returns miss if the origin is inside. */
function rayVsBox(col, ox, oy, oz, dx, dy, dz, maxT, inflate) {
  _ray.hit = false;
  toLocal(col, ox, oy, oz);
  const lox = _lp.x, loy = _lp.y, loz = _lp.z;
  let ldx, ldy, ldz;
  if (col.axisAligned) { ldx = dx; ldy = dy; ldz = dz; }
  else {
    ldx = dx * col.ux + dy * col.uy + dz * col.uz;
    ldy = dx * col.vx + dy * col.vy + dz * col.vz;
    ldz = dx * col.wx + dy * col.wy + dz * col.wz;
  }
  const ex = col.ex + inflate, ey = col.ey + inflate, ez = col.ez + inflate;

  let tmin = 0, tmax = maxT, axis = -1, sign = 1;

  // X
  if (Math.abs(ldx) < 1e-9) { if (lox < -ex || lox > ex) return; }
  else {
    const inv = 1 / ldx;
    let t1 = (-ex - lox) * inv, t2 = (ex - lox) * inv, sg = ldx > 0 ? -1 : 1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
    if (t1 > tmin) { tmin = t1; axis = 0; sign = sg; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return;
  }
  // Y
  if (Math.abs(ldy) < 1e-9) { if (loy < -ey || loy > ey) return; }
  else {
    const inv = 1 / ldy;
    let t1 = (-ey - loy) * inv, t2 = (ey - loy) * inv; const sg = ldy > 0 ? -1 : 1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
    if (t1 > tmin) { tmin = t1; axis = 1; sign = sg; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return;
  }
  // Z
  if (Math.abs(ldz) < 1e-9) { if (loz < -ez || loz > ez) return; }
  else {
    const inv = 1 / ldz;
    let t1 = (-ez - loz) * inv, t2 = (ez - loz) * inv; const sg = ldz > 0 ? -1 : 1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
    if (t1 > tmin) { tmin = t1; axis = 2; sign = sg; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return;
  }

  if (axis < 0) return;               // origin started inside — report no hit
  if (tmin < 0 || tmin > maxT) return;

  dirToWorld(col, axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0, _lp);
  _ray.t = tmin; _ray.nx = _lp.x; _ray.ny = _lp.y; _ray.nz = _lp.z;
  _ray.hit = true;
}

/**
 * Penetration of a capsule (segment sa..sb, radius r) into a collider.
 * Writes _pen: depth (>0 when overlapping), outward normal (points AWAY from the collider),
 * and the contact point c*.
 */
function penetrateCapsule(sax, say, saz, sbx, sby, sbz, r, col) {
  _pen.hit = false;

  if (col.shape === SHAPE_SPHERE) {
    segSeg(sax, say, saz, sbx, sby, sbz, col.px, col.py, col.pz, col.px, col.py, col.pz);
    const dx = _ss.ax - col.px, dy = _ss.ay - col.py, dz = _ss.az - col.pz;
    const d2 = dx * dx + dy * dy + dz * dz;
    const rr = r + col.radius;
    if (d2 >= rr * rr) return;
    const d = Math.sqrt(d2);
    if (d > 1e-6) { _pen.nx = dx / d; _pen.ny = dy / d; _pen.nz = dz / d; }
    else { _pen.nx = 0; _pen.ny = 1; _pen.nz = 0; }
    _pen.depth = rr - d;
    _pen.cx = _ss.ax - _pen.nx * r; _pen.cy = _ss.ay - _pen.ny * r; _pen.cz = _ss.az - _pen.nz * r;
    _pen.hit = true;
    return;
  }

  if (col.shape === SHAPE_CAPSULE) {
    const cax = col.px - col.axx * col.half, cay = col.py - col.axy * col.half, caz = col.pz - col.axz * col.half;
    const cbx = col.px + col.axx * col.half, cby = col.py + col.axy * col.half, cbz = col.pz + col.axz * col.half;
    segSeg(sax, say, saz, sbx, sby, sbz, cax, cay, caz, cbx, cby, cbz);
    const dx = _ss.ax - _ss.bx, dy = _ss.ay - _ss.by, dz = _ss.az - _ss.bz;
    const d2 = dx * dx + dy * dy + dz * dz;
    const rr = r + col.radius;
    if (d2 >= rr * rr) return;
    const d = Math.sqrt(d2);
    if (d > 1e-6) { _pen.nx = dx / d; _pen.ny = dy / d; _pen.nz = dz / d; }
    else {
      // concentric: shove out horizontally, away from the collider's axis
      let hx = sax - col.px, hz = saz - col.pz;
      const hl = Math.hypot(hx, hz);
      if (hl > 1e-6) { hx /= hl; hz /= hl; } else { hx = 1; hz = 0; }
      _pen.nx = hx; _pen.ny = 0; _pen.nz = hz;
    }
    _pen.depth = rr - d;
    _pen.cx = _ss.bx; _pen.cy = _ss.by; _pen.cz = _ss.bz;
    _pen.hit = true;
    return;
  }

  // ---- capsule vs oriented box: iterate closest point on the segment, then sphere-vs-AABB local.
  // Two refinement passes converge for the shapes we register (walls, panels, crates).
  let px = (sax + sbx) * 0.5, py = (say + sby) * 0.5, pz = (saz + sbz) * 0.5;
  for (let it = 0; it < 2; it++) {
    toLocal(col, px, py, pz);
    const qx = clamp(_lp.x, -col.ex, col.ex);
    const qy = clamp(_lp.y, -col.ey, col.ey);
    const qz = clamp(_lp.z, -col.ez, col.ez);
    dirToWorld(col, qx, qy, qz, _lp);
    const wx = col.px + _lp.x, wy = col.py + _lp.y, wz = col.pz + _lp.z;
    segSeg(sax, say, saz, sbx, sby, sbz, wx, wy, wz, wx, wy, wz);
    px = _ss.ax; py = _ss.ay; pz = _ss.az;
  }

  toLocal(col, px, py, pz);
  const lx = _lp.x, ly = _lp.y, lz = _lp.z;
  const qx = clamp(lx, -col.ex, col.ex);
  const qy = clamp(ly, -col.ey, col.ey);
  const qz = clamp(lz, -col.ez, col.ez);
  const dx = lx - qx, dy = ly - qy, dz = lz - qz;
  const d2 = dx * dx + dy * dy + dz * dz;

  if (d2 > 1e-12) {
    if (d2 >= r * r) return;
    const d = Math.sqrt(d2);
    dirToWorld(col, dx / d, dy / d, dz / d, _lp);
    _pen.nx = _lp.x; _pen.ny = _lp.y; _pen.nz = _lp.z;
    _pen.depth = r - d;
  } else {
    // the segment point is inside the box — leave along the shallowest face
    const px2 = col.ex - Math.abs(lx);
    const py2 = col.ey - Math.abs(ly);
    const pz2 = col.ez - Math.abs(lz);
    let lnx = 0, lny = 0, lnz = 0, pd;
    if (px2 <= py2 && px2 <= pz2) { lnx = lx >= 0 ? 1 : -1; pd = px2; }
    else if (py2 <= pz2) { lny = ly >= 0 ? 1 : -1; pd = py2; }
    else { lnz = lz >= 0 ? 1 : -1; pd = pz2; }
    dirToWorld(col, lnx, lny, lnz, _lp);
    _pen.nx = _lp.x; _pen.ny = _lp.y; _pen.nz = _lp.z;
    _pen.depth = r + pd;
  }
  _pen.cx = px - _pen.nx * r; _pen.cy = py - _pen.ny * r; _pen.cz = pz - _pen.nz * r;
  _pen.hit = true;
}

// =================================================================================================
// Physics
// =================================================================================================

export class Physics {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx?.bus ?? null;

    // --- spatial hash
    this.cell = TUNING.cellSize;
    this._invCell = 1 / this.cell;
    /** @type {Map<number, Collider[]>} */
    this._grid = new Map();
    /** @type {Collider[]} */
    this._colliders = [];
    /** @type {number[]} */
    this._free = [];
    /** @type {Map<any, number>} object3D -> collider id */
    this._byObject = new Map();
    /** @type {Collider[]} colliders that re-bake their transform every fixed step */
    this._dynamic = [];
    this._stamp = 1;
    this.colliderCount = 0;

    // --- Hit ring pool
    this._hits = [];
    for (let i = 0; i < 8; i++) {
      this._hits.push({
        point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
        distance: 0, object: null, kind: '', collider: null,
        layer: 0, occlusion: 1, isTerrain: false,
      });
    }
    this._hitI = 0;

    // --- budgets / telemetry
    this.rayCount = 0;
    this.losCount = 0;
    this.rayBudget = TUNING.rayBudget;
    this.stats = { rays: 0, los: 0, peakRays: 0, peakLos: 0, colliders: 0, carried: 0, cells: 0 };

    // --- terrain handle (resolved lazily; may never exist)
    this._terrain = null;
    this._terrainRetry = 0;

    // --- shared move result (used when the caller passes no `out`)
    this._moveResult = this._makeMoveResult();

    // --- carried-part registry (weak so BuildSystem can drop parts without telling us)
    this._carried = typeof WeakSet === 'function' ? new WeakSet() : null;
    this._carriedCount = 0;

    this._slopeCos = Math.cos(TUNING.slopeLimitDeg * DEG);
    this._disposed = false;
  }

  // -------------------------------------------------------------------------- lifecycle

  async init() {
    this._resolveTerrain();
    if (!this._terrain) {
      Log.warn('Physics: no Terrain.heightAt() — the world collides against a flat plane at y=0.');
    }
    Log.debug(`Physics ready. cell=${this.cell}m slopeLimit=${TUNING.slopeLimitDeg}° step=${TUNING.stepHeight}m`);
  }

  update(_dt, _elapsed) {
    // Snapshot and reset the per-frame budget counters. Physics updates early in the registration
    // order, so this window is "everything since Physics ran last frame" — one whole frame.
    this.stats.rays = this.rayCount;
    this.stats.los = this.losCount;
    if (this.rayCount > this.stats.peakRays) this.stats.peakRays = this.rayCount;
    if (this.losCount > this.stats.peakLos) this.stats.peakLos = this.losCount;
    this.stats.colliders = this.colliderCount;
    this.stats.cells = this._grid.size;
    this.stats.carried = this._carriedCount;

    if (this.rayCount > this.rayBudget) {
      Log.once(
        'physics:ray-budget',
        `Physics: ray budget exceeded — ${this.rayCount} raycast/sphereCast calls in one frame, ` +
        `budget is ${this.rayBudget} (ARCHITECTURE.md §12). Cache results or use lineOfSight().`,
      );
    }
    if (this.losCount > TUNING.losBudget) {
      Log.once(
        'physics:los-budget',
        `Physics: ${this.losCount} line-of-sight queries in one frame (soft budget ${TUNING.losBudget}). ` +
        'Campers should stagger their sight checks across frames.',
      );
    }
    this.rayCount = 0;
    this.losCount = 0;

    // Terrain may be authored later than us; keep an eye out, cheaply.
    if (!this._terrain && --this._terrainRetry <= 0) { this._terrainRetry = 30; this._resolveTerrain(); }
  }

  fixedUpdate(_fdt) {
    // Re-bake colliders that were registered as dynamic (doors, dropped parts, a swinging beam).
    const list = this._dynamic;
    for (let i = 0; i < list.length; i++) {
      const col = list[i];
      if (!col.alive || !col.object) continue;
      this._bakeFromObject(col, col.object);
      this._rehash(col);
    }
  }

  resize(_w, _h) { }

  dispose() {
    this._disposed = true;
    this._grid.clear();
    this._byObject.clear();
    this._colliders.length = 0;
    this._free.length = 0;
    this._dynamic.length = 0;
    this._hits.length = 0;
    this._cand_clear();
    this._terrain = null;
    this.colliderCount = 0;
  }

  _cand_clear() { for (let i = 0; i < MAX_CANDIDATES; i++) _cand[i] = null; }

  // -------------------------------------------------------------------------- terrain

  _resolveTerrain() {
    const t = this.ctx?.systems?.get?.('Terrain');
    this._terrain = (t && !t.__failed && typeof t.heightAt === 'function') ? t : null;
    return this._terrain;
  }

  /** Ground height at (x,z). Falls back to a flat plane at y=0. */
  heightAt(x, z) {
    const t = this._terrain;
    if (t) {
      const h = t.heightAt(x, z);
      if (Number.isFinite(h)) return h;
    }
    return 0;
  }

  /** Ground normal at (x,z), written into `out` (a Vector3). Always unit length. */
  normalAt(x, z, out) {
    const o = out || _v0;
    const t = this._terrain;
    if (t && typeof t.normalAt === 'function') {
      const n = t.normalAt(x, z, o);
      if (n && Number.isFinite(n.x) && Number.isFinite(n.y) && (n.x || n.y || n.z)) {
        if (n !== o) o.set(n.x, n.y, n.z);
        return o.normalize();
      }
    }
    if (!t) { o.set(0, 1, 0); return o; }
    const e = 0.5;
    const hl = this.heightAt(x - e, z), hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e), hu = this.heightAt(x, z + e);
    o.set(hl - hr, 2 * e, hd - hu);
    return o.normalize();
  }

  /** Ground material name at (x,z) — 'needles' | 'mud' | 'moss' | 'granite' | ... Player uses it
   *  for footstep sounds. Returns 'dirt' when Terrain is missing or silent. */
  surfaceAt(x, z) {
    const t = this._terrain;
    if (t && typeof t.surfaceAt === 'function') {
      const s = t.surfaceAt(x, z);
      if (typeof s === 'string' && s) return s;
    }
    return 'dirt';
  }

  // -------------------------------------------------------------------------- collider registry

  /**
   * Register a static (or dynamic) collision primitive.
   *
   * @param {THREE.Object3D|{position:{x,y,z}}} object3D  Source of the transform. If it is an
   *        Object3D we bake its world matrix and its geometry bounding box. A plain
   *        `{position:{x,y,z}}` also works when the caller has no mesh.
   * @param {string} kind  One of KINDS (trunk, wall, panel, tent, building, crate, rock,
   *        undergrowth, prop, part, vehicle, water…). Drives the layer, the acoustic occlusion
   *        factor (GAME_DESIGN §4.2) and the default shape.
   * @param {object} [opts] Optional overrides:
   *        { shape:'capsule'|'box'|'sphere', radius, height, halfExtents:{x,y,z},
   *          offset:{x,y,z}, dynamic:bool, occlusion:number, blocksMove:bool, layer:int,
   *          axis:{x,y,z}, userData:any }
   * @returns {number} handle (collider id), or -1 if it could not be registered.
   */
  addCollider(object3D, kind = 'prop', opts = null) {
    if (this._disposed || !object3D) return -1;

    // Re-registering the same Object3D refreshes it rather than duplicating it.
    if (object3D.isObject3D && this._byObject.has(object3D)) {
      const existing = this._colliders[this._byObject.get(object3D)];
      if (existing && existing.alive) { this.refreshCollider(existing.id); return existing.id; }
    }

    const def = KINDS[kind] || DEFAULT_KIND;
    if (!KINDS[kind]) {
      Log.once(`physics:kind:${kind}`, `Physics: unknown collider kind '${kind}' — treated as 'prop' ` +
        '(layer PROP, occlusion 0.75, blocks movement). Add it to Physics.KINDS if it needs its own factor.');
    }

    const col = this._acquire();
    col.kind = kind;
    col.layer = opts?.layer ?? def.layer;
    col.occlusion = opts?.occlusion ?? def.occlusion;
    col.blocksMove = opts?.blocksMove ?? def.blocksMove;
    col.userData = opts?.userData ?? null;
    col.object = object3D.isObject3D ? object3D : null;
    col.shape = shapeFromName(opts?.shape) ?? def.shape;
    col.dynamic = !!opts?.dynamic;

    if (opts?.axis) {
      const ax = opts.axis, l = Math.hypot(ax.x || 0, ax.y || 0, ax.z || 0) || 1;
      col.axx = (ax.x || 0) / l; col.axy = (ax.y || 0) / l; col.axz = (ax.z || 0) / l;
    } else { col.axx = 0; col.axy = 1; col.axz = 0; }

    this._bakeFromObject(col, object3D, opts);

    col.alive = true;
    this._hash(col);
    this.colliderCount++;
    if (col.object) this._byObject.set(col.object, col.id);
    if (col.dynamic) this._dynamic.push(col);
    return col.id;
  }

  /**
   * Register a primitive from raw numbers — no Object3D required.
   * Forest uses this per instanced trunk; CabinSite uses it per foundation block.
   * For a 'capsule' the point is the BASE (a trunk stands up from where you put it) unless
   * `opts.baseAnchored === false`. For boxes and spheres it is the centre.
   * @returns {number} handle
   */
  addColliderAt(x, y, z, kind = 'prop', opts = null) {
    _desc.position.x = x; _desc.position.y = y; _desc.position.z = z;
    return this.addCollider(_desc, kind, opts);
  }

  /** Remove a collider by handle, or by the Object3D it was registered with. */
  removeCollider(handleOrObject) {
    const col = this._lookup(handleOrObject);
    if (!col || !col.alive) return false;
    this._unhash(col);
    if (col.object) this._byObject.delete(col.object);
    const di = this._dynamic.indexOf(col);
    if (di >= 0) this._dynamic.splice(di, 1);
    col.alive = false;
    col.object = null;
    col.userData = null;
    this._free.push(col.id);
    this.colliderCount--;
    return true;
  }

  /** Re-bake a collider from its Object3D (call after you move a wall). */
  refreshCollider(handleOrObject, opts = null) {
    const col = this._lookup(handleOrObject);
    if (!col || !col.alive || !col.object) return false;
    this._bakeFromObject(col, col.object, opts);
    this._rehash(col);
    return true;
  }

  /** Look up the collider record for a handle or Object3D. Returns null if unknown. */
  getCollider(handleOrObject) { return this._lookup(handleOrObject); }

  _lookup(h) {
    if (typeof h === 'number') return this._colliders[h] ?? null;
    if (h && h.isObject3D) {
      const id = this._byObject.get(h);
      return id === undefined ? null : (this._colliders[id] ?? null);
    }
    if (h instanceof Collider) return h;
    return null;
  }

  _acquire() {
    if (this._free.length) {
      const id = this._free.pop();
      const c = this._colliders[id];
      c.hashed = false;
      c.axisAligned = true;
      return c;
    }
    const c = new Collider(this._colliders.length);
    this._colliders.push(c);
    return c;
  }

  /** Bake world-space shape data from an Object3D (or a plain {position}). */
  _bakeFromObject(col, object3D, opts = null) {
    let cx = 0, cy = 0, cz = 0;
    let ex = 0.5, ey = 0.5, ez = 0.5;
    col.axisAligned = true;
    col.ux = 1; col.uy = 0; col.uz = 0;
    col.vx = 0; col.vy = 1; col.vz = 0;
    col.wx = 0; col.wy = 0; col.wz = 1;

    if (object3D.isObject3D) {
      object3D.updateWorldMatrix(true, false);
      _m0.copy(object3D.matrixWorld);
      _m0.decompose(_v0, _q0, _v1);              // position, quaternion, scale
      const geo = object3D.geometry;
      if (geo) {
        if (!geo.boundingBox) geo.computeBoundingBox();
        const bb = geo.boundingBox;
        if (bb) {
          const lcx = (bb.min.x + bb.max.x) * 0.5;
          const lcy = (bb.min.y + bb.max.y) * 0.5;
          const lcz = (bb.min.z + bb.max.z) * 0.5;
          ex = Math.abs((bb.max.x - bb.min.x) * 0.5 * _v1.x);
          ey = Math.abs((bb.max.y - bb.min.y) * 0.5 * _v1.y);
          ez = Math.abs((bb.max.z - bb.min.z) * 0.5 * _v1.z);
          _v2.set(lcx * _v1.x, lcy * _v1.y, lcz * _v1.z).applyQuaternion(_q0);
          cx = _v0.x + _v2.x; cy = _v0.y + _v2.y; cz = _v0.z + _v2.z;
        } else { cx = _v0.x; cy = _v0.y; cz = _v0.z; }
      } else {
        // A Group: world AABB of everything under it. Cold path — Box3 traversal is fine here.
        _box3.makeEmpty();
        _box3.setFromObject(object3D);
        if (_box3.isEmpty()) { cx = _v0.x; cy = _v0.y; cz = _v0.z; }
        else {
          cx = (_box3.min.x + _box3.max.x) * 0.5;
          cy = (_box3.min.y + _box3.max.y) * 0.5;
          cz = (_box3.min.z + _box3.max.z) * 0.5;
          ex = (_box3.max.x - _box3.min.x) * 0.5;
          ey = (_box3.max.y - _box3.min.y) * 0.5;
          ez = (_box3.max.z - _box3.min.z) * 0.5;
          _q0.identity();
        }
      }
      // Basis from the world rotation.
      const isIdent = Math.abs(_q0.x) < 1e-6 && Math.abs(_q0.y) < 1e-6 && Math.abs(_q0.z) < 1e-6;
      if (!isIdent) {
        col.axisAligned = false;
        _v2.set(1, 0, 0).applyQuaternion(_q0); col.ux = _v2.x; col.uy = _v2.y; col.uz = _v2.z;
        _v2.set(0, 1, 0).applyQuaternion(_q0); col.vx = _v2.x; col.vy = _v2.y; col.vz = _v2.z;
        _v2.set(0, 0, 1).applyQuaternion(_q0); col.wx = _v2.x; col.wy = _v2.y; col.wz = _v2.z;
        if (col.shape === SHAPE_CAPSULE && !opts?.axis) {
          col.axx = col.vx; col.axy = col.vy; col.axz = col.vz;   // capsule follows local +Y
        }
      }
    } else {
      const p = object3D.position || object3D;
      cx = p.x || 0; cy = p.y || 0; cz = p.z || 0;
    }

    // --- explicit overrides win
    if (opts?.halfExtents) {
      ex = Math.abs(opts.halfExtents.x ?? ex);
      ey = Math.abs(opts.halfExtents.y ?? ey);
      ez = Math.abs(opts.halfExtents.z ?? ez);
    }
    if (opts?.offset) { cx += opts.offset.x || 0; cy += opts.offset.y || 0; cz += opts.offset.z || 0; }

    col.px = cx; col.py = cy; col.pz = cz;
    col.ex = Math.max(0.01, ex); col.ey = Math.max(0.01, ey); col.ez = Math.max(0.01, ez);

    if (col.shape === SHAPE_CAPSULE) {
      col.radius = Math.max(0.02, opts?.radius ?? Math.max(col.ex, col.ez));
      const hh = opts?.height ?? (col.ey * 2);
      col.half = Math.max(0.0, hh * 0.5 - col.radius);
      // A trunk registered from raw numbers is anchored at its BASE — you place a tree where it
      // meets the ground, not at its waist. A trunk registered from a Mesh already knows.
      if (!object3D.isObject3D && opts?.baseAnchored !== false) col.py = cy + hh * 0.5;
    } else if (col.shape === SHAPE_SPHERE) {
      col.radius = Math.max(0.02, opts?.radius ?? Math.max(col.ex, col.ey, col.ez));
    }

    this._bakeBounds(col);
  }

  _bakeBounds(col) {
    if (col.shape === SHAPE_SPHERE) {
      const r = col.radius;
      col.minX = col.px - r; col.maxX = col.px + r;
      col.minY = col.py - r; col.maxY = col.py + r;
      col.minZ = col.pz - r; col.maxZ = col.pz + r;
      return;
    }
    if (col.shape === SHAPE_CAPSULE) {
      const r = col.radius, h = col.half;
      const hx = Math.abs(col.axx) * h + r, hy = Math.abs(col.axy) * h + r, hz = Math.abs(col.axz) * h + r;
      col.minX = col.px - hx; col.maxX = col.px + hx;
      col.minY = col.py - hy; col.maxY = col.py + hy;
      col.minZ = col.pz - hz; col.maxZ = col.pz + hz;
      return;
    }
    // box: project half extents onto world axes
    const hx = Math.abs(col.ux) * col.ex + Math.abs(col.vx) * col.ey + Math.abs(col.wx) * col.ez;
    const hy = Math.abs(col.uy) * col.ex + Math.abs(col.vy) * col.ey + Math.abs(col.wy) * col.ez;
    const hz = Math.abs(col.uz) * col.ex + Math.abs(col.vz) * col.ey + Math.abs(col.wz) * col.ez;
    col.minX = col.px - hx; col.maxX = col.px + hx;
    col.minY = col.py - hy; col.maxY = col.py + hy;
    col.minZ = col.pz - hz; col.maxZ = col.pz + hz;
  }

  // -------------------------------------------------------------------------- spatial hash

  _cellOf(v) { return Math.floor(v * this._invCell); }

  _key(cx, cz) {
    const a = clamp(cx, -4090, 4090) + 4096;
    const b = clamp(cz, -4090, 4090) + 4096;
    return (a << 13) | b;
  }

  _hash(col) {
    col.c0 = this._cellOf(col.minX); col.c1 = this._cellOf(col.maxX);
    col.z0 = this._cellOf(col.minZ); col.z1 = this._cellOf(col.maxZ);
    const spanX = col.c1 - col.c0, spanZ = col.z1 - col.z0;
    if (spanX > 64 || spanZ > 64) {
      Log.once('physics:huge-collider',
        `Physics: collider '${col.kind}' spans ${spanX + 1}×${spanZ + 1} cells. Split large ` +
        'geometry (a mess-hall wall, a dock) into per-wall boxes or broadphase will degrade.');
    }
    for (let cx = col.c0; cx <= col.c1; cx++) {
      for (let cz = col.z0; cz <= col.z1; cz++) {
        const k = this._key(cx, cz);
        let bucket = this._grid.get(k);
        if (!bucket) { bucket = []; this._grid.set(k, bucket); }
        bucket.push(col);
      }
    }
    col.hashed = true;
  }

  _unhash(col) {
    if (!col.hashed) return;
    for (let cx = col.c0; cx <= col.c1; cx++) {
      for (let cz = col.z0; cz <= col.z1; cz++) {
        const k = this._key(cx, cz);
        const bucket = this._grid.get(k);
        if (!bucket) continue;
        const i = bucket.indexOf(col);
        if (i >= 0) bucket.splice(i, 1);
        if (bucket.length === 0) this._grid.delete(k);
      }
    }
    col.hashed = false;
  }

  _rehash(col) {
    const c0 = this._cellOf(col.minX), c1 = this._cellOf(col.maxX);
    const z0 = this._cellOf(col.minZ), z1 = this._cellOf(col.maxZ);
    if (col.hashed && c0 === col.c0 && c1 === col.c1 && z0 === col.z0 && z1 === col.z1) return;
    this._unhash(col);
    this._hash(col);
  }

  /** Gather unique colliders whose AABB overlaps the given box. Fills _cand, returns count. */
  _gatherBox(minX, minY, minZ, maxX, maxY, maxZ, mask) {
    const stamp = ++this._stamp;
    let n = 0;
    const c0 = this._cellOf(minX), c1 = this._cellOf(maxX);
    const z0 = this._cellOf(minZ), z1 = this._cellOf(maxZ);
    for (let cx = c0; cx <= c1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const bucket = this._grid.get(this._key(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const col = bucket[i];
          if (col._stamp === stamp || !col.alive) continue;
          col._stamp = stamp;
          if (!(col.layer & mask)) continue;
          if (col.maxX < minX || col.minX > maxX) continue;
          if (col.maxY < minY || col.minY > maxY) continue;
          if (col.maxZ < minZ || col.minZ > maxZ) continue;
          if (n < MAX_CANDIDATES) _cand[n++] = col;
          else { Log.once('physics:cand-overflow', 'Physics: broadphase candidate overflow (384). World is too dense here.'); return n; }
        }
      }
    }
    return n;
  }

  /** Gather unique colliders along a segment (2D DDA in XZ, Y filtered). Fills _cand. */
  _gatherSegment(x0, y0, z0, x1, y1, z1, pad, mask) {
    const stamp = ++this._stamp;
    let n = 0;
    const minY = Math.min(y0, y1) - pad, maxY = Math.max(y0, y1) + pad;

    let cx = this._cellOf(x0), cz = this._cellOf(z0);
    const ecx = this._cellOf(x1), ecz = this._cellOf(z1);
    const dx = x1 - x0, dz = z1 - z0;
    const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(this.cell / dx) : Infinity;
    const tdz = dz !== 0 ? Math.abs(this.cell / dz) : Infinity;
    let tmx = dx !== 0 ? (((dx > 0 ? cx + 1 : cx) * this.cell) - x0) / dx : Infinity;
    let tmz = dz !== 0 ? (((dz > 0 ? cz + 1 : cz) * this.cell) - z0) / dz : Infinity;
    const padCells = pad > 0 ? Math.ceil(pad * this._invCell) : 0;

    for (let guard = 0; guard < 4096; guard++) {
      for (let ox = -padCells; ox <= padCells; ox++) {
        for (let oz = -padCells; oz <= padCells; oz++) {
          const bucket = this._grid.get(this._key(cx + ox, cz + oz));
          if (!bucket) continue;
          for (let i = 0; i < bucket.length; i++) {
            const col = bucket[i];
            if (col._stamp === stamp || !col.alive) continue;
            col._stamp = stamp;
            if (!(col.layer & mask)) continue;
            if (col.maxY < minY || col.minY > maxY) continue;
            if (n < MAX_CANDIDATES) _cand[n++] = col;
            else { Log.once('physics:cand-overflow', 'Physics: broadphase candidate overflow (384).'); return n; }
          }
        }
      }
      if (cx === ecx && cz === ecz) break;
      if (tmx < tmz) { tmx += tdx; cx += stepX; } else { tmz += tdz; cz += stepZ; }
      if (tmx > 1 && tmz > 1 && (cx !== ecx || cz !== ecz)) {
        // numerical drift guard — jump straight to the end cell
        cx = ecx; cz = ecz;
      }
    }
    return n;
  }

  // -------------------------------------------------------------------------- queries

  _hit() { const h = this._hits[this._hitI]; this._hitI = (this._hitI + 1) & 7; return h; }

  /**
   * Cast a ray against the heightfield and the primitive world.
   *
   * @param {THREE.Vector3|{x,y,z}} origin
   * @param {THREE.Vector3|{x,y,z}} direction  need not be normalised
   * @param {number} [maxDist=100]
   * @param {number} [mask=MASK.SOLID]
   * @returns {object|null} POOLED Hit — valid only until your next query. Copy immediately.
   */
  raycast(origin, direction, maxDist = 100, mask = MASK.SOLID) {
    this.rayCount++;
    if (this._disposed || !origin || !direction) return null;

    const ox = origin.x, oy = origin.y, oz = origin.z;
    let dx = direction.x, dy = direction.y, dz = direction.z;
    const dl = Math.hypot(dx, dy, dz);
    if (dl < 1e-9) return null;
    dx /= dl; dy /= dl; dz /= dl;
    const maxT = Math.max(0, maxDist);

    let bestT = maxT, bestCol = null, bnx = 0, bny = 1, bnz = 0;

    // --- primitives
    if (mask & ~LAYER.TERRAIN) {
      const n = this._gatherSegment(ox, oy, oz, ox + dx * maxT, oy + dy * maxT, oz + dz * maxT, 0, mask & ~LAYER.TERRAIN);
      for (let i = 0; i < n; i++) {
        const col = _cand[i];
        this._rayVsCollider(col, ox, oy, oz, dx, dy, dz, bestT, 0);
        if (_ray.hit && _ray.t < bestT) {
          bestT = _ray.t; bestCol = col; bnx = _ray.nx; bny = _ray.ny; bnz = _ray.nz;
        }
      }
    }

    // --- heightfield
    let terrainT = -1;
    if (mask & LAYER.TERRAIN) terrainT = this._marchTerrain(ox, oy, oz, dx, dy, dz, bestT);
    if (terrainT >= 0 && terrainT < bestT) {
      const h = this._hit();
      h.distance = terrainT;
      h.point.set(ox + dx * terrainT, oy + dy * terrainT, oz + dz * terrainT);
      this.normalAt(h.point.x, h.point.z, h.normal);
      h.object = null; h.kind = 'terrain'; h.collider = null;
      h.layer = LAYER.TERRAIN; h.occlusion = 0.50; h.isTerrain = true;
      return h;
    }

    if (!bestCol) return null;
    const h = this._hit();
    h.distance = bestT;
    h.point.set(ox + dx * bestT, oy + dy * bestT, oz + dz * bestT);
    h.normal.set(bnx, bny, bnz);
    h.object = bestCol.object; h.kind = bestCol.kind; h.collider = bestCol;
    h.layer = bestCol.layer; h.occlusion = bestCol.occlusion; h.isTerrain = false;
    return h;
  }

  /**
   * Sweep a sphere. Implemented as a ray against colliders inflated by `radius` — exact for
   * spheres and capsules, and conservative (square corners rather than rounded) for boxes.
   * Same pooled-Hit rules as raycast().
   */
  sphereCast(origin, direction, radius, maxDist = 100, mask = MASK.SOLID) {
    this.rayCount++;
    if (this._disposed || !origin || !direction) return null;
    const r = Math.max(0, radius || 0);

    const ox = origin.x, oy = origin.y, oz = origin.z;
    let dx = direction.x, dy = direction.y, dz = direction.z;
    const dl = Math.hypot(dx, dy, dz);
    if (dl < 1e-9) return null;
    dx /= dl; dy /= dl; dz /= dl;
    const maxT = Math.max(0, maxDist);

    let bestT = maxT, bestCol = null, bnx = 0, bny = 1, bnz = 0;

    if (mask & ~LAYER.TERRAIN) {
      const n = this._gatherSegment(ox, oy, oz, ox + dx * maxT, oy + dy * maxT, oz + dz * maxT, r, mask & ~LAYER.TERRAIN);
      for (let i = 0; i < n; i++) {
        const col = _cand[i];
        this._rayVsCollider(col, ox, oy, oz, dx, dy, dz, bestT, r);
        if (_ray.hit && _ray.t < bestT) {
          bestT = _ray.t; bestCol = col; bnx = _ray.nx; bny = _ray.ny; bnz = _ray.nz;
        }
      }
    }

    // Terrain: march the sphere's underside, which is what a sweep would touch first.
    let terrainT = -1;
    if (mask & LAYER.TERRAIN) terrainT = this._marchTerrain(ox, oy - r, oz, dx, dy, dz, bestT);
    if (terrainT >= 0 && terrainT < bestT) {
      const h = this._hit();
      h.distance = terrainT;
      h.point.set(ox + dx * terrainT, oy - r + dy * terrainT, oz + dz * terrainT);
      this.normalAt(h.point.x, h.point.z, h.normal);
      h.object = null; h.kind = 'terrain'; h.collider = null;
      h.layer = LAYER.TERRAIN; h.occlusion = 0.50; h.isTerrain = true;
      return h;
    }

    if (!bestCol) return null;
    const h = this._hit();
    h.distance = bestT;
    h.point.set(ox + dx * bestT - bnx * r, oy + dy * bestT - bny * r, oz + dz * bestT - bnz * r);
    h.normal.set(bnx, bny, bnz);
    h.object = bestCol.object; h.kind = bestCol.kind; h.collider = bestCol;
    h.layer = bestCol.layer; h.occlusion = bestCol.occlusion; h.isTerrain = false;
    return h;
  }

  _rayVsCollider(col, ox, oy, oz, dx, dy, dz, maxT, inflate) {
    if (col.shape === SHAPE_SPHERE) {
      rayVsSphere(ox, oy, oz, dx, dy, dz, maxT, col.px, col.py, col.pz, col.radius + inflate);
    } else if (col.shape === SHAPE_CAPSULE) {
      rayVsCapsule(ox, oy, oz, dx, dy, dz, maxT,
        col.px - col.axx * col.half, col.py - col.axy * col.half, col.pz - col.axz * col.half,
        col.px + col.axx * col.half, col.py + col.axy * col.half, col.pz + col.axz * col.half,
        col.radius + inflate);
    } else {
      rayVsBox(col, ox, oy, oz, dx, dy, dz, maxT, inflate);
    }
  }

  /**
   * March the analytic heightfield. Returns t along the ray, or -1.
   * Fast path for near-vertical rays (the common ground probe) solves in one step.
   */
  _marchTerrain(ox, oy, oz, dx, dy, dz, maxT) {
    if (!this._terrain && oy <= 0 && dy >= 0) return -1;

    // Straight down / straight up: analytic.
    if (Math.abs(dy) > 0.999) {
      const h = this.heightAt(ox, oz);
      const t = (h - oy) / dy;
      return (t >= 0 && t <= maxT) ? t : -1;
    }

    const step = Math.max(0.35, maxT / 48);
    let prevT = 0;
    let prevD = oy - this.heightAt(ox, oz);
    if (prevD < 0) return 0;                     // started below ground

    for (let t = step; t <= maxT; t += step) {
      const d = (oy + dy * t) - this.heightAt(ox + dx * t, oz + dz * t);
      if (d < 0) {
        // binary refine
        let lo = prevT, hi = t;
        for (let k = 0; k < 6; k++) {
          const mid = (lo + hi) * 0.5;
          const dm = (oy + dy * mid) - this.heightAt(ox + dx * mid, oz + dz * mid);
          if (dm < 0) hi = mid; else lo = mid;
        }
        return (lo + hi) * 0.5;
      }
      prevT = t; prevD = d;
    }
    return -1;
  }

  /**
   * Is there an unobstructed straight line between two points?
   * Cheap: 2D DDA through the hash, early-out on the first blocker, plus a short analytic
   * sample of the heightfield for ridges. Campers call this constantly — it never marches.
   *
   * @param {THREE.Vector3|{x,y,z}} fromVec3
   * @param {THREE.Vector3|{x,y,z}} toVec3
   * @param {number} [mask=MASK.SIGHT]
   * @returns {boolean} true if the line is CLEAR.
   */
  lineOfSight(fromVec3, toVec3, mask = MASK.SIGHT) {
    this.losCount++;
    if (this._disposed || !fromVec3 || !toVec3) return true;
    return !this._segmentBlocked(
      fromVec3.x, fromVec3.y, fromVec3.z,
      toVec3.x, toVec3.y, toVec3.z,
      mask,
    );
  }

  /** Inner LOS walk. Returns true if something blocks. */
  _segmentBlocked(x0, y0, z0, x1, y1, z1, mask) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-5) return false;
    const ux = dx / len, uy = dy / len, uz = dz / len;

    // --- terrain ridge (analytic; the bias stops ground-level endpoints self-blocking)
    if (mask & LAYER.TERRAIN) {
      const steps = Math.min(16, Math.max(3, Math.ceil(len / 3)));
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const sy = y0 + dy * t;
        if (sy < this.heightAt(x0 + dx * t, z0 + dz * t) - 0.15) return true;
      }
    }

    // --- primitives, cell by cell, in order, early-out
    const solid = mask & ~LAYER.TERRAIN;
    if (!solid) return false;

    const stamp = ++this._stamp;
    const minY = Math.min(y0, y1) - 0.01, maxY = Math.max(y0, y1) + 0.01;

    let cx = this._cellOf(x0), cz = this._cellOf(z0);
    const ecx = this._cellOf(x1), ecz = this._cellOf(z1);
    const sdx = x1 - x0, sdz = z1 - z0;
    const stepX = sdx > 0 ? 1 : -1, stepZ = sdz > 0 ? 1 : -1;
    const tdx = sdx !== 0 ? Math.abs(this.cell / sdx) : Infinity;
    const tdz = sdz !== 0 ? Math.abs(this.cell / sdz) : Infinity;
    let tmx = sdx !== 0 ? (((sdx > 0 ? cx + 1 : cx) * this.cell) - x0) / sdx : Infinity;
    let tmz = sdz !== 0 ? (((sdz > 0 ? cz + 1 : cz) * this.cell) - z0) / sdz : Infinity;

    for (let guard = 0; guard < 4096; guard++) {
      const bucket = this._grid.get(this._key(cx, cz));
      if (bucket) {
        for (let i = 0; i < bucket.length; i++) {
          const col = bucket[i];
          if (col._stamp === stamp || !col.alive) continue;
          col._stamp = stamp;
          if (!(col.layer & solid)) continue;
          if (col.maxY < minY || col.minY > maxY) continue;
          this._rayVsCollider(col, x0, y0, z0, ux, uy, uz, len, 0);
          if (_ray.hit) return true;
        }
      }
      if (cx === ecx && cz === ecz) break;
      if (tmx < tmz) { tmx += tdx; cx += stepX; } else { tmz += tdz; cz += stepZ; }
      if (tmx > 1 && tmz > 1 && (cx !== ecx || cz !== ecz)) { cx = ecx; cz = ecz; }
    }
    return false;
  }

  /**
   * Product of acoustic blocker factors along a segment — GAME_DESIGN §4.2.
   * Samples at most `maxBlockers` blockers (default 4, per the spec) and includes the
   * terrain-ridge factor (0.50) when the line passes below the heightfield.
   * NoiseSystem: `heard = intensity * falloff * occlusionAlong(src, ear) * (1 - maskLevel)`.
   * @returns {number} 0..1
   */
  occlusionAlong(fromVec3, toVec3, maxBlockers = 4, mask = MASK.SOUND) {
    this.losCount++;
    if (this._disposed || !fromVec3 || !toVec3) return 1;
    let factor = 1;
    let count = 0;

    const x0 = fromVec3.x, y0 = fromVec3.y, z0 = fromVec3.z;
    const x1 = toVec3.x, y1 = toVec3.y, z1 = toVec3.z;
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-5) return 1;
    const ux = dx / len, uy = dy / len, uz = dz / len;

    if (mask & LAYER.TERRAIN) {
      const steps = Math.min(12, Math.max(3, Math.ceil(len / 4)));
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        if (y0 + dy * t < this.heightAt(x0 + dx * t, z0 + dz * t) - 0.15) {
          factor *= 0.50; count++;
          break;                               // one ridge is one ridge
        }
      }
    }

    const solid = mask & ~LAYER.TERRAIN;
    if (solid) {
      const n = this._gatherSegment(x0, y0, z0, x1, y1, z1, 0, solid);
      for (let i = 0; i < n && count < maxBlockers; i++) {
        const col = _cand[i];
        this._rayVsCollider(col, x0, y0, z0, ux, uy, uz, len, 0);
        if (!_ray.hit) continue;
        factor *= col.occlusion;
        count++;
      }
    }
    return clamp01(factor);
  }

  /**
   * Fraction of a standing target that is visible from `fromVec3` — five samples:
   * head, both shoulders, both hips. This is `occlF` in GAME_DESIGN §4.1.
   * @param {Vector3} fromVec3 observer eye
   * @param {Vector3} targetFeet target's feet position
   * @param {number} [height=1.8]
   * @returns {number} 0..1
   */
  visibleFraction(fromVec3, targetFeet, height = TUNING.capsuleHeight, mask = MASK.SIGHT) {
    if (this._disposed || !fromVec3 || !targetFeet) return 1;
    // lateral axis, perpendicular to the view direction
    let lx = targetFeet.x - fromVec3.x, lz = targetFeet.z - fromVec3.z;
    const ll = Math.hypot(lx, lz);
    if (ll > 1e-5) { const t = lx; lx = -lz / ll; lz = t / ll; } else { lx = 1; lz = 0; }

    let vis = 0;
    // head
    _v1.set(targetFeet.x, targetFeet.y + height * 0.96, targetFeet.z);
    if (this.lineOfSight(fromVec3, _v1, mask)) vis++;
    // shoulders
    _v1.set(targetFeet.x + lx * 0.28, targetFeet.y + height * 0.80, targetFeet.z + lz * 0.28);
    if (this.lineOfSight(fromVec3, _v1, mask)) vis++;
    _v1.set(targetFeet.x - lx * 0.28, targetFeet.y + height * 0.80, targetFeet.z - lz * 0.28);
    if (this.lineOfSight(fromVec3, _v1, mask)) vis++;
    // hips
    _v1.set(targetFeet.x + lx * 0.22, targetFeet.y + height * 0.48, targetFeet.z + lz * 0.22);
    if (this.lineOfSight(fromVec3, _v1, mask)) vis++;
    _v1.set(targetFeet.x - lx * 0.22, targetFeet.y + height * 0.48, targetFeet.z - lz * 0.22);
    if (this.lineOfSight(fromVec3, _v1, mask)) vis++;
    return vis / 5;
  }

  /**
   * Fraction of the target's five body samples whose backdrop is open sky rather than forest,
   * ground, or building — `skylineFraction` in GAME_DESIGN §4.1's `exposeF`. Standing on the
   * ridge, or up on the night-5 trusses, drives this toward 1.
   *
   * @param {Vector3} observerPos  where the looking is coming from
   * @param {Vector3} targetFeet
   * @param {number} [height=1.8]
   * @param {number} [backdrop=70] how far behind the target we look for something to stand against
   * @returns {number} 0..1
   */
  skylineFraction(observerPos, targetFeet, height = TUNING.capsuleHeight, backdrop = 70, mask = MASK.SIGHT) {
    if (this._disposed || !observerPos || !targetFeet) return 0;
    let dx = targetFeet.x - observerPos.x, dz = targetFeet.z - observerPos.z;
    const dl = Math.hypot(dx, dz);
    if (dl < 1e-4) return 0;
    dx /= dl; dz /= dl;
    let lx = -dz, lz = dx;

    let sky = 0;
    for (let i = 0; i < 5; i++) {
      // head, shoulders, hips — same sample set as visibleFraction
      const hy = i === 0 ? 0.96 : (i < 3 ? 0.80 : 0.48);
      const side = i === 0 ? 0 : (i === 1 ? 0.28 : i === 2 ? -0.28 : i === 3 ? 0.22 : -0.22);
      _v2.set(targetFeet.x + lx * side, targetFeet.y + height * hy, targetFeet.z + lz * side);
      // continue past the target, along the same line of sight, slightly rising
      _v3.set(_v2.x + dx * backdrop, _v2.y + backdrop * 0.02, _v2.z + dz * backdrop);
      if (!this._segmentBlocked(_v2.x, _v2.y, _v2.z, _v3.x, _v3.y, _v3.z, mask)) sky++;
    }
    this.losCount += 5;
    return sky / 5;
  }

  /**
   * Everything whose AABB overlaps a sphere. Fills `outArray` BY INDEX with Collider records
   * ({ object, kind, layer, occlusion, px/py/pz, … }) and returns the count. Nothing is
   * allocated: reuse the same array every frame and read only the first `count` entries.
   * Capped at 64 hits.
   *
   * @returns {number} count
   */
  overlapSphere(position, radius, outArray, mask = MASK.ALL) {
    if (this._disposed || !position) return 0;
    const r = Math.max(0, radius || 0), r2 = r * r;
    const n = this._gatherBox(
      position.x - r, position.y - r, position.z - r,
      position.x + r, position.y + r, position.z + r, mask,
    );
    let count = 0;
    const cap = 64;
    for (let i = 0; i < n && count < cap; i++) {
      const col = _cand[i];
      // exact-ish narrow phase: distance from the sphere centre to the collider's AABB
      const cx = clamp(position.x, col.minX, col.maxX);
      const cy = clamp(position.y, col.minY, col.maxY);
      const cz = clamp(position.z, col.minZ, col.maxZ);
      const dx = position.x - cx, dy = position.y - cy, dz = position.z - cz;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      if (outArray) outArray[count] = col;
      count++;
    }
    return count;
  }

  // -------------------------------------------------------------------------- capsule movement

  _makeMoveResult() {
    return {
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),
      grounded: false,
      hitWall: false,
      steppedUp: false,
      sliding: false,
      slopeDeg: 0,
      groundKind: '',
      surface: 'dirt',
      contacts: 0,
    };
  }

  /**
   * Move a capsule through the world and resolve collisions.
   *
   * `position` is the capsule's FEET. The capsule spans y ∈ [position.y, position.y + height].
   * Gravity is NOT applied here — integrate it into `velocity` yourself (TUNING.gravity = -22).
   *
   * @param {THREE.Vector3} position   current feet position (not modified)
   * @param {THREE.Vector3} velocity   current velocity  (not modified)
   * @param {number} radius            0.42 for the player
   * @param {number} height            1.80 standing, 1.15 crouched
   * @param {number} dt                seconds — call from fixedUpdate(1/60)
   * @param {object} [out]             REUSE this object across frames; `out.grounded` from the
   *                                   previous call is read as the was-grounded hint that enables
   *                                   ground snapping.
   * @returns {{position:THREE.Vector3, velocity:THREE.Vector3, normal:THREE.Vector3,
   *            grounded:boolean, hitWall:boolean, steppedUp:boolean, sliding:boolean,
   *            slopeDeg:number, groundKind:string, surface:string, contacts:number}}
   */
  moveCapsule(position, velocity, radius, height, dt, out) {
    const res = (out && typeof out === 'object') ? out : this._moveResult;
    if (!res.position || !res.position.isVector3) res.position = new THREE.Vector3();
    if (!res.velocity || !res.velocity.isVector3) res.velocity = new THREE.Vector3();
    if (!res.normal || !res.normal.isVector3) res.normal = new THREE.Vector3(0, 1, 0);

    const wasGrounded = res.grounded === true;

    res.grounded = false;
    res.hitWall = false;
    res.steppedUp = false;
    res.sliding = false;
    res.contacts = 0;
    res.groundKind = '';
    res.normal.set(0, 1, 0);

    if (!position) { res.slopeDeg = 0; return res; }

    const r = Math.max(0.05, radius || TUNING.capsuleRadius);
    const h = Math.max(2 * r + 0.02, height || TUNING.capsuleHeight);

    _mcP.set(position.x, position.y, position.z);
    if (velocity) _mcV.set(velocity.x, velocity.y, velocity.z); else _mcV.set(0, 0, 0);

    if (this._disposed) {
      res.position.copy(_mcP); res.velocity.copy(_mcV); res.slopeDeg = 0; return res;
    }

    const step = Math.max(0, dt || 0);
    const speed = _mcV.length();
    let sub = 1;
    if (speed * step > r * 0.5) sub = Math.min(TUNING.maxSubsteps, Math.ceil((speed * step) / (r * 0.5)));
    const sdt = step / sub;

    for (let s = 0; s < sub; s++) {
      _mcP.x += _mcV.x * sdt;
      _mcP.y += _mcV.y * sdt;
      _mcP.z += _mcV.z * sdt;
      this._resolveCapsule(_mcP, _mcV, r, h, res);
    }

    // --- ground snapping: keep the heavy man glued to a downhill slope instead of bouncing.
    if (!res.grounded && _mcV.y <= 0.01 && (wasGrounded || (_mcV.y > -4 && (_mcV.x * _mcV.x + _mcV.z * _mcV.z) > 0.0004))) {
      const gh = this.heightAt(_mcP.x, _mcP.z);
      let bestY = -Infinity;
      const drop = _mcP.y - gh;
      if (drop >= -1e-4 && drop <= TUNING.groundSnap) {
        this.normalAt(_mcP.x, _mcP.z, _mcN);
        if (_mcN.y >= this._slopeCos) bestY = gh;
      }
      // colliders below the feet (a floor deck, a foundation sill)
      const n = this._gatherBox(
        _mcP.x - r, _mcP.y - TUNING.groundSnap - 0.05, _mcP.z - r,
        _mcP.x + r, _mcP.y + 0.05, _mcP.z + r, MASK.WORLD,
      );
      for (let i = 0; i < n; i++) {
        const col = _cand[i];
        if (!col.blocksMove) continue;
        if (col.maxY > _mcP.y + 0.02 || col.maxY < _mcP.y - TUNING.groundSnap) continue;
        const cx = clamp(_mcP.x, col.minX, col.maxX), cz = clamp(_mcP.z, col.minZ, col.maxZ);
        const ddx = _mcP.x - cx, ddz = _mcP.z - cz;
        if (ddx * ddx + ddz * ddz > r * r) continue;
        if (col.maxY > bestY) { bestY = col.maxY; res.groundKind = col.kind; }
      }
      if (bestY > -Infinity) {
        _mcP.y = bestY;
        res.grounded = true;
        if (_mcV.y < 0) _mcV.y = 0;
        if (!res.groundKind) res.groundKind = 'terrain';
      }
    }

    res.position.copy(_mcP);
    res.velocity.copy(_mcV);
    res.slopeDeg = Math.acos(clamp(res.normal.y, -1, 1)) / DEG;
    res.surface = (res.groundKind && res.groundKind !== 'terrain')
      ? surfaceForKind(res.groundKind)
      : this.surfaceAt(_mcP.x, _mcP.z);
    return res;
  }

  /** One depenetration pass: terrain first, then primitives, then step-up. Mutates p and v. */
  _resolveCapsule(p, v, r, h, res) {
    // ---- terrain
    const gh = this.heightAt(p.x, p.z);
    if (p.y < gh) {
      this.normalAt(p.x, p.z, _mcN);
      p.y = gh;
      if (_mcN.y >= this._slopeCos) {
        if (v.y < 0) v.y = 0;
        res.grounded = true;
        res.normal.copy(_mcN);
        res.groundKind = 'terrain';
      } else {
        // too steep to stand on: strip the into-surface component and let gravity carry you down
        const d = v.x * _mcN.x + v.y * _mcN.y + v.z * _mcN.z;
        if (d < 0) { v.x -= _mcN.x * d; v.y -= _mcN.y * d; v.z -= _mcN.z * d; }
        res.sliding = true;
        res.normal.copy(_mcN);
      }
    }

    // ---- primitives
    const skin = TUNING.skin;
    let steppedThisCall = false;

    for (let it = 0; it < TUNING.depenIterations; it++) {
      const say = p.y + r, sby = p.y + h - r;
      const n = this._gatherBox(
        p.x - r - skin, p.y - skin, p.z - r - skin,
        p.x + r + skin, p.y + h + skin, p.z + r + skin,
        MASK.WORLD,
      );
      let resolved = 0;

      for (let i = 0; i < n; i++) {
        const col = _cand[i];
        if (!col.blocksMove) continue;
        penetrateCapsule(p.x, say, p.z, p.x, sby, p.z, r, col);
        if (!_pen.hit || _pen.depth <= 1e-6) continue;

        const nx = _pen.nx, ny = _pen.ny, nz = _pen.nz;

        // step-up: a low obstacle we can simply stand on top of (GAME_DESIGN §5.1, 0.45 m)
        if (!steppedThisCall && ny < this._slopeCos) {
          const rise = col.maxY - p.y;
          if (rise > 0.02 && rise <= TUNING.stepHeight) {
            p.y = col.maxY + skin;
            res.steppedUp = true;
            res.grounded = true;
            res.groundKind = col.kind;
            res.normal.set(0, 1, 0);
            if (v.y < 0) v.y = 0;
            steppedThisCall = true;
            resolved++;
            break;                       // re-gather with the new height
          }
        }

        const push = _pen.depth + skin;
        p.x += nx * push; p.y += ny * push; p.z += nz * push;
        res.contacts++;
        resolved++;

        const d = v.x * nx + v.y * ny + v.z * nz;
        if (d < 0) { v.x -= nx * d; v.y -= ny * d; v.z -= nz * d; }

        if (ny >= this._slopeCos) {
          res.grounded = true;
          res.normal.set(nx, ny, nz);
          res.groundKind = col.kind;
          if (v.y < 0) v.y = 0;
        } else if (ny > -this._slopeCos) {
          res.hitWall = true;
        } else if (v.y > 0) {
          v.y = 0;                       // ceiling
        }
      }
      if (!resolved) break;
    }
  }

  /** Convenience: the standing surface directly beneath a world point ('wood' on the build). */
  surfaceUnder(position) {
    if (!position) return 'dirt';
    const n = this._gatherBox(
      position.x - 0.3, position.y - 0.6, position.z - 0.3,
      position.x + 0.3, position.y + 0.1, position.z + 0.3, LAYER.BUILD | LAYER.PROP,
    );
    for (let i = 0; i < n; i++) {
      const col = _cand[i];
      if (col.maxY <= position.y + 0.06 && col.maxY >= position.y - 0.45) return 'wood';
    }
    return this.surfaceAt(position.x, position.z);
  }

  // -------------------------------------------------------------------------- carried parts

  /**
   * Spring-damper simulation of a part carried in the slasher's hands (GAME_DESIGN §5.3).
   *
   * The part is NOT parented to the camera. It lives in world space, lags behind the hands with
   * mass-dependent overshoot (k = 28, ζ = 0.55), and collides with the world — which is the point:
   * a 3.2 m sill beam swung around a trunk clatters, and clatter is `noise:emit`.
   *
   * State is stored on the part as `part.__phys` (Physics owns that field; do not write it).
   * The resolved transform is written back onto the part's Object3D every call.
   *
   * @param {object} part  a BuildSystem Part. Read defensively:
   *        object3D|mesh|group|root (Object3D), mass|massKg (kg), length (m), radius (m),
   *        longAxis ({x,y,z} local, defaults to the mesh's longest bbox axis).
   * @param {THREE.Object3D|{position,quaternion}} targetTransform  the hand anchor.
   * @param {number} dt   seconds (call from fixedUpdate).
   * @returns {object|null} the part's physics state {position, quaternion, velocity, angular,
   *          contact:boolean, impactSpeed:number} — live, do not retain across frames.
   */
  simulateCarried(part, targetTransform, dt) {
    if (this._disposed || !part || !targetTransform) return null;
    const st = this._carriedState(part);
    if (!st) return null;

    // ---- target transform (Object3D or {position, quaternion})
    if (targetTransform.isObject3D) {
      targetTransform.updateWorldMatrix(true, false);
      targetTransform.getWorldPosition(_carPos);
      targetTransform.getWorldQuaternion(_carQ);
    } else {
      const tp = targetTransform.position;
      if (!tp) return st;
      _carPos.set(tp.x, tp.y, tp.z);
      const tq = targetTransform.quaternion;
      if (tq) _carQ.set(tq.x, tq.y, tq.z, tq.w ?? 1); else _carQ.identity();
    }

    if (!st.init) {
      st.position.copy(_carPos);
      st.quaternion.copy(_carQ);
      st.velocity.set(0, 0, 0);
      st.angular.set(0, 0, 0);
      st.init = true;
    }

    const step = Math.min(Math.max(dt || 0, 0), 1 / 45);
    if (step <= 0) return st;

    // ---- linear spring-damper. Heavier part -> lower ω -> more lag, more overshoot.
    const mn = clamp(st.mass / TUNING.carryMassRef, 0.2, 5);
    const w = Math.sqrt(TUNING.carrySpringK / mn);
    const z = TUNING.carryDamping;
    const w2 = w * w, dmp = 2 * z * w;

    st.velocity.x += (w2 * (_carPos.x - st.position.x) - dmp * st.velocity.x) * step;
    st.velocity.y += (w2 * (_carPos.y - st.position.y) - dmp * st.velocity.y) * step;
    st.velocity.z += (w2 * (_carPos.z - st.position.z) - dmp * st.velocity.z) * step;
    st.position.x += st.velocity.x * step;
    st.position.y += st.velocity.y * step;
    st.position.z += st.velocity.z * step;

    // leash — a carried part never detaches, however hard you turn
    _carA.set(st.position.x - _carPos.x, st.position.y - _carPos.y, st.position.z - _carPos.z);
    const lag = _carA.length();
    if (lag > TUNING.carryMaxLag) {
      const k = TUNING.carryMaxLag / lag;
      st.position.set(_carPos.x + _carA.x * k, _carPos.y + _carA.y * k, _carPos.z + _carA.z * k);
      _carA.multiplyScalar(1 / lag);
      const outward = st.velocity.dot(_carA);
      if (outward > 0) st.velocity.addScaledVector(_carA, -outward);
    }

    // ---- angular spring toward the hand orientation
    _carQ2.copy(st.quaternion).invert().premultiply(_carQ);      // delta = target * inv(current)
    if (_carQ2.w < 0) { _carQ2.x = -_carQ2.x; _carQ2.y = -_carQ2.y; _carQ2.z = -_carQ2.z; _carQ2.w = -_carQ2.w; }
    const sinHalf = Math.hypot(_carQ2.x, _carQ2.y, _carQ2.z);
    const angle = 2 * Math.atan2(sinHalf, clamp(_carQ2.w, -1, 1));
    if (sinHalf > 1e-7) {
      _carB.set(_carQ2.x / sinHalf, _carQ2.y / sinHalf, _carQ2.z / sinHalf);
    } else {
      _carB.set(0, 0, 0);
    }
    const wa = w * 1.15, wa2 = wa * wa, dmpA = 2 * z * wa;
    st.angular.x += (wa2 * _carB.x * angle - dmpA * st.angular.x) * step;
    st.angular.y += (wa2 * _carB.y * angle - dmpA * st.angular.y) * step;
    st.angular.z += (wa2 * _carB.z * angle - dmpA * st.angular.z) * step;
    const aMag = st.angular.length();
    if (aMag > TUNING.carryAngularMax) st.angular.multiplyScalar(TUNING.carryAngularMax / aMag);

    if (aMag > 1e-6) {
      const half = aMag * step * 0.5;
      const s = Math.sin(half) / aMag;
      _q2.set(st.angular.x * s, st.angular.y * s, st.angular.z * s, Math.cos(half));
      st.quaternion.premultiply(_q2).normalize();
    }

    // ---- collision: the part as a capsule along its long axis
    st.contact = false;
    st.impactSpeed = 0;
    if (st.cooldown > 0) st.cooldown -= step;

    _carC.set(st.axisX, st.axisY, st.axisZ).applyQuaternion(st.quaternion);
    const ax = st.position.x - _carC.x * st.halfLength;
    const ay = st.position.y - _carC.y * st.halfLength;
    const az = st.position.z - _carC.z * st.halfLength;
    const bx = st.position.x + _carC.x * st.halfLength;
    const by = st.position.y + _carC.y * st.halfLength;
    const bz = st.position.z + _carC.z * st.halfLength;
    const pr = st.radius;

    const minX = Math.min(ax, bx) - pr, maxX = Math.max(ax, bx) + pr;
    const minY = Math.min(ay, by) - pr, maxY = Math.max(ay, by) + pr;
    const minZ = Math.min(az, bz) - pr, maxZ = Math.max(az, bz) + pr;

    const n = this._gatherBox(minX, minY, minZ, maxX, maxY, maxZ, MASK.WORLD);
    let deepest = 0, dnx = 0, dny = 0, dnz = 0, dcx = 0, dcy = 0, dcz = 0, hitKind = '';

    for (let i = 0; i < n; i++) {
      const col = _cand[i];
      if (!col.blocksMove) continue;
      penetrateCapsule(ax, ay, az, bx, by, bz, pr, col);
      if (!_pen.hit || _pen.depth <= 1e-5) continue;
      if (_pen.depth > deepest) {
        deepest = _pen.depth;
        dnx = _pen.nx; dny = _pen.ny; dnz = _pen.nz;
        dcx = _pen.cx; dcy = _pen.cy; dcz = _pen.cz;
        hitKind = col.kind;
      }
    }

    // the ground is a blocker too — a dropped end of a beam drags in the mud
    const ghA = this.heightAt(ax, az), ghB = this.heightAt(bx, bz);
    const lowA = ay - pr - ghA, lowB = by - pr - ghB;
    if (lowA < 0 || lowB < 0) {
      const d = -Math.min(lowA, lowB);
      if (d > deepest) {
        deepest = d; dnx = 0; dny = 1; dnz = 0;
        dcx = lowA < lowB ? ax : bx; dcy = (lowA < lowB ? ay : by) - pr; dcz = lowA < lowB ? az : bz;
        hitKind = 'terrain';
      }
    }

    if (deepest > 0) {
      st.contact = true;
      st.position.x += dnx * deepest;
      st.position.y += dny * deepest;
      st.position.z += dnz * deepest;

      // velocity at the contact point includes the swing — this is what makes a long beam
      // clatter when you turn, even though your hands barely moved.
      _carB.set(dcx - st.position.x, dcy - st.position.y, dcz - st.position.z);
      _carA.copy(st.angular).cross(_carB).add(st.velocity);
      const closing = -(_carA.x * dnx + _carA.y * dny + _carA.z * dnz);
      st.impactSpeed = closing;

      if (closing > 0) {
        const j = (1 + TUNING.carryRestitution) * closing;
        st.velocity.x += dnx * j; st.velocity.y += dny * j; st.velocity.z += dnz * j;
        st.angular.multiplyScalar(1 - TUNING.carryFriction);
      }

      if (closing > TUNING.carryImpactSpeed && st.cooldown <= 0) {
        this._emitCarryImpact(st, dcx, dcy, dcz, closing, hitKind);
        st.cooldown = TUNING.carryImpactCooldown;
      }
    }

    // ---- write the transform back onto the part's mesh
    const obj = st.object;
    if (obj && obj.isObject3D) {
      const parent = obj.parent;
      if (parent && parent.parent) {
        parent.updateWorldMatrix(true, false);
        _m0.copy(parent.matrixWorld).invert();
        obj.position.copy(st.position).applyMatrix4(_m0);
        _m0.extractRotation(parent.matrixWorld);
        _q1.setFromRotationMatrix(_m0).invert();
        obj.quaternion.copy(_q1).multiply(st.quaternion);
      } else {
        obj.position.copy(st.position);
        obj.quaternion.copy(st.quaternion);
      }
      obj.updateMatrix();
    }

    return st;
  }

  _emitCarryImpact(st, x, y, z, speed, kind) {
    if (!this.bus) return;
    // GAME_DESIGN §5.3: intensity = 0.25 + 0.4 * speedNorm, radius 18, kind 'impact'.
    // speedNorm folds in the part's mass: a 62 kg beam lands harder than a 9 kg board.
    const over = clamp01((speed - TUNING.carryImpactSpeed) / 3.8);
    const massF = clamp(st.mass / TUNING.carryMassRef, 0.45, 1.6);
    const speedNorm = clamp01(over * massF);
    const intensity = clamp01(0.25 + 0.40 * speedNorm);

    const pos = new THREE.Vector3(x, y, z);      // event payloads are never pooled
    this.bus.emit('noise:emit', {
      position: pos,
      radius: TUNING.carryImpactRadius,
      intensity,
      kind: 'impact',
    });
    this.bus.emit('audio:sfx', {
      id: kind === 'terrain' ? 'impact_earth' : 'impact_wood',
      position: pos,
      volume: intensity,
      rate: 0.86 + 0.3 * (1 - speedNorm),
    });
  }

  /** Lazily build (and cache) the per-part physics state. */
  _carriedState(part) {
    let st = part.__phys;
    if (st) {
      if (!st.object) st.object = resolveObject(part);
      return st;
    }

    const obj = resolveObject(part);
    const mass = Number.isFinite(part.mass) ? part.mass
      : Number.isFinite(part.massKg) ? part.massKg : 12;

    // long axis + dimensions, from the mesh when we have one
    let axisX = 1, axisY = 0, axisZ = 0;
    let halfLength = Number.isFinite(part.length) ? part.length * 0.5 : 0.6;
    let radius = Number.isFinite(part.radius) ? part.radius : 0.12;

    if (part.longAxis) {
      const l = Math.hypot(part.longAxis.x || 0, part.longAxis.y || 0, part.longAxis.z || 0) || 1;
      axisX = (part.longAxis.x || 0) / l; axisY = (part.longAxis.y || 0) / l; axisZ = (part.longAxis.z || 0) / l;
    } else if (obj && obj.geometry) {
      const geo = obj.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;
      if (bb) {
        const sx = obj.scale?.x ?? 1, sy = obj.scale?.y ?? 1, sz = obj.scale?.z ?? 1;
        const ex = (bb.max.x - bb.min.x) * 0.5 * Math.abs(sx);
        const ey = (bb.max.y - bb.min.y) * 0.5 * Math.abs(sy);
        const ez = (bb.max.z - bb.min.z) * 0.5 * Math.abs(sz);
        if (ex >= ey && ex >= ez) { axisX = 1; axisY = 0; axisZ = 0; halfLength = ex; radius = Math.max(ey, ez); }
        else if (ey >= ez) { axisX = 0; axisY = 1; axisZ = 0; halfLength = ey; radius = Math.max(ex, ez); }
        else { axisX = 0; axisY = 0; axisZ = 1; halfLength = ez; radius = Math.max(ex, ey); }
        halfLength = Math.max(0.05, halfLength - radius);
      }
    }

    st = {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      velocity: new THREE.Vector3(),
      angular: new THREE.Vector3(),
      object: obj,
      mass: clamp(mass, 0.1, 200),
      halfLength: Math.max(0.05, halfLength),
      radius: clamp(radius, 0.04, 0.6),
      axisX, axisY, axisZ,
      cooldown: 0,
      contact: false,
      impactSpeed: 0,
      init: false,
    };
    try {
      Object.defineProperty(part, '__phys', { value: st, enumerable: false, writable: true, configurable: true });
    } catch {
      // frozen / sealed Part — the caller keeps the state instead of us.
      Log.once('physics:frozen-part', 'Physics: could not attach carry state to a Part (frozen object). ' +
        'simulateCarried() will re-initialise it every call.');
    }
    if (this._carried && !this._carried.has(part)) { this._carried.add(part); this._carriedCount++; }
    return st;
  }

  /**
   * Forget a part's carry state (call on build:drop / build:place so the next pickup starts
   * snapped to the hands instead of springing in from the last drop point).
   */
  releaseCarried(part) {
    if (!part) return;
    if (part.__phys) {
      part.__phys.init = false;
      part.__phys.velocity.set(0, 0, 0);
      part.__phys.angular.set(0, 0, 0);
      part.__phys.cooldown = 0;
    }
  }

  /** Drop the state entirely. */
  disposeCarried(part) {
    if (!part) return;
    if (part.__phys) {
      try { delete part.__phys; } catch { part.__phys = null; }
      if (this._carriedCount > 0) this._carriedCount--;
    }
  }
}

// -------------------------------------------------------------------------------------------------

function resolveObject(part) {
  if (!part) return null;
  if (part.isObject3D) return part;
  const o = part.object3D ?? part.mesh ?? part.group ?? part.root ?? part.object ?? null;
  return (o && o.isObject3D) ? o : null;
}

function shapeFromName(name) {
  if (name === 'capsule') return SHAPE_CAPSULE;
  if (name === 'sphere') return SHAPE_SPHERE;
  if (name === 'box' || name === 'aabb' || name === 'obb') return SHAPE_BOX;
  return null;
}

// Handy statics so other modules do not have to import the loose exports.
Physics.LAYER = LAYER;
Physics.MASK = MASK;
Physics.KINDS = KINDS;
Physics.TUNING = TUNING;

export default Physics;
