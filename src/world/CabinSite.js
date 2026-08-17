/**
 * CabinSite.js — THE BUILD PLOT AND THE CABIN ITSELF
 * ==================================================
 *
 * OWNER: Build agent. This is the object the whole game is about: the puzzle's board, the
 * joke's punchline, and the story's last room. It owns the plot, the slot graph in world space,
 * every part mesh, the ghost preview, and the growing structure — including how a WRONG join
 * looks from twenty metres away by lantern light.
 *
 * ---------------------------------------------------------------------------------------------
 * PUBLIC API (verified against src/gameplay/BuildSystem.js, tools/check.mjs, Blueprint.js,
 *             Campers.js, Navmesh.js, NoiseSystem.js)
 *
 *   new CabinSite(ctx); await init(); update(dt, elapsed); resize(w, h); dispose();
 *
 *   slots                       -> Slot[]      every slot, nights 1..7 (90 of them)
 *   slotsForNight(n)            -> Slot[]
 *   slotById(id)                -> Slot|null
 *   slotWorldTransform(slotId)  -> { position, quaternion, scale }
 *   setInstalled(slotId, partOrId, correctOrInfo, torque)
 *   clearInstalled(slotId)
 *   clearObstruction(slotId) / restoreObstruction(slotId)
 *   showGhost(slotId, partId, valid)
 *   hideGhost()
 *   partMesh(partId, part?)     -> THREE.Object3D
 *   onBuildChanged(slotId, featureHeights)
 *   progress                    -> 0..1
 *   bounds                      -> THREE.Box3   (world)
 *   center / origin / plotCenter-> THREE.Vector3 (world)  — Navmesh/NoiseSystem/Campers read these
 *   features                    -> [{ id, position, height, pale, minInstalled }]  — Campers §9.5
 *   footprint                   -> { halfX, halfZ, deckY, plateY, ridgeY }
 *
 * ---------------------------------------------------------------------------------------------
 * COORDINATE CONTRACT — read this before changing a number.
 *
 * Two frames coexist deliberately, because two consumers want different things:
 *
 *   PLOT-LOCAL   Slot.position, Slot.transform.position, Slot.rotation.
 *                Origin at the centre of the flattened pad, y = 0 at pad level, +X along the
 *                ridge (east), +Z south, -Z north. `Blueprint.js` draws the diagram in these
 *                metres (`_adoptCabinSite`), so they must stay small and centred.
 *
 *   WORLD        Slot.px / .py / .pz, and everything `slotWorldTransform()` returns.
 *                `BuildSystem` compares slot positions against the player's eye, so its fields
 *                are absolute. It takes its fast path on any slot carrying finite `px`,
 *                `acceptsType` and `yawCandidates` and then uses our objects verbatim — which
 *                is exactly what we want: this file, not the fallback graph, is the plot.
 *
 * `this.group` is parented to the scene at the world site origin, so all geometry below is
 * authored in plot-local metres.
 *
 * ---------------------------------------------------------------------------------------------
 * THE BUILDING — real, and every canonical number lands on it.
 *
 *   Platform    6.40 m (X) x 3.20 m (Z) outside the sills.
 *               6 stone piers: 4 corners + the two long-wall mid-span points.
 *               6 sill beams of 3.20 m: two per long wall (spliced over the mid pier), one per
 *               short wall. Half-lapped at all four corners. That is exactly the Night 1
 *               manifest with nothing cut and nothing left over.
 *   Floor       2x10 joists at 400 mm (16") centres, flush-framed in galvanised hangers between
 *               the long sills, tops level with the sill tops at y = 0.62.
 *   Cabin       4.80 m (X) x 3.20 m (Z), from x = -3.20 to x = +1.60.
 *               The remaining 1.60 m at the east end is the porch (STORY §6 Night 7).
 *   Walls       6x6 corner posts, 2x6 studs at 400 mm centres, double top plate, real headers
 *               and rough openings for one door and two windows.
 *   Roof        6 king-post trusses, 4.00 m span, 1.10 m rise, at 960 mm centres over the 4.80 m
 *               cabin — which is why the ridge beam is 4.80 m after you cut 340 mm off it.
 *               0.40 m eave overhang each side. Corrugated tin on purlins.
 *   Heights     pad 0 / pier top 0.40 / sill 0.51 / deck 0.62 / plate 3.09 / apex 4.19.
 *
 * ---------------------------------------------------------------------------------------------
 * SLOT COUNTS. `GAME_DESIGN.md` §2 is canon (12/14/13/16/10/17/8 = 90) and `GAME_DESIGN.md`
 * §0.2 C1 deletes `STORY.md` §6.0's 28-slot Night Seven *by name*. `BuildSystem.js` already
 * resolved this in writing and the shortfall comedy engine hard-codes slot ids from it
 * (`B-04`, `TR-06`, `H-03`, `W-NORTH`, `BAT-05`, `DFR-01`, `CHR-B-4`), so the ids and counts
 * here match it exactly.
 *
 * STORY's Night Seven still arrives in full — the hearth stone, the chimney, the porch, the
 * table, the sink with a window over it, the flue, the doorframe with four pencil marks at 91,
 * 108, 124 and 141 cm — as DRESSING gated on the chairs rather than as slots. The house Night
 * Seven describes is the house that gets built. It just is not eight more things to carry.
 *
 * ---------------------------------------------------------------------------------------------
 * WRONGNESS IS THE ONLY FEEDBACK CHANNEL, so it is exaggerated past spec on purpose. §6.4 says
 * a Rotated join sits 6 mm proud. Six millimetres is invisible at 4 m in the dark, so what the
 * player actually sees is 6 mm of offset PLUS a bright chamfered end-grain face turned to
 * camera, PLUS bolts standing proud with their threads showing in galvanised steel — the
 * brightest thing on the site at night. See `VISUALS`.
 *
 * RENDERING. Every static member is authored once into a per-material bucket and merged into
 * ONE BufferGeometry per material (9 draw calls for the entire cabin, ghost included), rebuilt
 * only when a join changes — never per frame, never in `update()` unless dirty.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Log } from '../core/Log.js';
import { Rand, hash2 } from '../core/Rand.js';

// =================================================================================================
// PLAN — every dimension of the building, in plot-local metres. Nothing below invents a number.
// =================================================================================================

const P = Object.freeze({
  HX: 3.20,            // platform half-length  (6.40 m of platform along X)
  HZ: 1.60,            // platform half-depth   (3.20 m along Z)
  CAB_W: -3.20,        // cabin west wall centreline
  CAB_E: 1.60,         // cabin east wall centreline (the door wall, onto the porch)
  SILL: 0.22,          // sill section, square
  PIER_W: 0.52, PIER_H: 0.40,
  PIER_Y: 0.20,        // pier centre; top face at 0.40
  SILL_Y: 0.51,        // sill centre; bottom 0.40 on the pier, top 0.62
  DECK_Y: 0.62,        // top of sills and of the flush-framed joists
  BOARD_T: 0.03,       // subfloor board thickness
  JOIST_D: 0.24, JOIST_T: 0.08, JOIST_PITCH: 0.40,   // 2x10 at 16" centres
  POST: 0.18, POST_H: 2.40,
  STUD_T: 0.09, STUD_D: 0.14, STUD_PITCH: 0.40,
  PLATE_T: 0.07,
  PLATE_Y: 0.62 + 2.40 + 0.035,          // 3.055 — centre of the double top plate
  BEAR_Y: 0.62 + 2.40 + 0.07,            // 3.09  — truss bearing
  TRUSS_SPAN: 4.00, TRUSS_RISE: 1.10, TRUSS_T: 0.14, CHORD_D: 0.09,
  APEX_Y: 0.62 + 2.40 + 0.07 + 1.10,     // 4.19
  RIDGE_W: 0.22, RIDGE_D: 0.30, RIDGE_L: 4.80,
  TRUSS_PITCH: 0.96,
  DOOR_W: 0.90, DOOR_H: 2.05, DOOR_T: 0.05,
  WIN_W: 1.10, WIN_H: 0.86,
  HATCH_X0: -2.00, HATCH_X1: -0.80,      // the crawlspace hatch that shortens two deck courses
});

/**
 * The roof pitch, derived rather than typed: 1.10 m of rise over a 2.00 m half-span.
 * `ROOF_A` is the angle a member on the slope makes with the horizontal. Sign convention that
 * everything on the roof obeys: `rotateX(side * ROOF_A)` where `side = sign(z)` puts a piece
 * authored flat in XZ onto that slope with its face still pointing at the sky. Getting this
 * backwards silently builds a butterfly roof, which is how the first pass of this file read.
 */
const ROOF_RUN = P.HZ + 0.40;                       // 2.00 — half span to the eave
const ROOF_A = Math.atan2(P.TRUSS_RISE, ROOF_RUN);  // 0.5028 rad, a 5:9 pitch
/** Height of the roof plane at a given |z|. */
const roofY = (z) => P.APEX_Y - P.TRUSS_RISE * (Math.abs(z) / ROOF_RUN);

/** Pier ring, in placement order — corners plus the long-wall mid-span splices. */
const PIER_XZ = [
  [-P.HX, -P.HZ], [0, -P.HZ], [P.HX, -P.HZ],
  [P.HX, P.HZ], [0, P.HZ], [-P.HX, P.HZ],
];

/**
 * Which dressing nodes are the "before" and "after" of an obstruction, per slot. Exactly one of
 * each pair is drawn. `BuildSystem.removeObstruction()` flips it through `clearObstruction()`.
 * Only P-01 has one (STORY §1.4); the table exists so a second obstruction is data, not code.
 */
const OBSTRUCTION_DRESSING = Object.freeze({
  'P-01': { standing: 'dress:county-stake', pulled: 'dress:county-stake-pulled' },
});

/** Truss stations: six at 960 mm over the 4.80 m cabin, first and last on the gable walls. */
const TRUSS_X = [-3.20, -2.24, -1.28, -0.32, 0.64, 1.60];

/** Corner post stations, in the order `C-NW, C-NE, C-SE, C-SW`. */
const CORNER_XZ = [[P.CAB_W, -P.HZ], [P.CAB_E, -P.HZ], [P.CAB_E, P.HZ], [P.CAB_W, P.HZ]];
const CORNER_ID = ['C-NW', 'C-NE', 'C-SE', 'C-SW'];

/** Hero stud stations — the six the manual bothers to number. The infill is dressing. */
const STUD_XZ = [[-1.60, -P.HZ], [0.00, -P.HZ], [P.CAB_E, -0.75], [0.00, P.HZ], [-1.60, P.HZ], [P.CAB_W, 0.00]];

/**
 * How a join reads from outside, per `BuildSystem.visualStateFor()`. Values are deliberately
 * larger than §6.4's 6 mm: this is the puzzle's only feedback channel and it must survive four
 * metres of rain and a hooded lantern. `lift` is metres, `tilt` is radians about the member's
 * transverse axis, `out` is metres along the outward normal, `bolt` is how far the fasteners
 * stand proud (galvanised steel — the brightest thing on the site).
 */
const VISUALS = Object.freeze({
  flush:   { lift: 0.000, tilt: 0.000, out: 0.000, bolt: 0.000, split: false },
  proud:   { lift: 0.006, tilt: 0.008, out: 0.020, bolt: 0.010, split: false },
  gapped:  { lift: 0.016, tilt: 0.013, out: 0.008, bolt: 0.014, split: false },
  sagging: { lift: -0.026, tilt: -0.026, out: 0.004, bolt: 0.018, split: false },
  split:   { lift: 0.004, tilt: 0.011, out: 0.012, bolt: 0.016, split: true },
});

const MAT = Object.freeze({
  lumber: 'sawn-lumber',
  weathered: 'weathered-wood',
  galv: 'galvanized-steel',
  rust: 'rusted-steel',
  tin: 'corrugated-tin',
  stone: 'granite',
  concrete: 'concrete',
  glass: 'glass-dirty',
  rope: 'rope',
});

const CH = 0.008;           // default chamfer on dimensional lumber — 8 mm, an eased arris
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// =================================================================================================
// GEOMETRY PRIMITIVES
//
// Everything is non-indexed with exactly { position, normal, uv } so `mergeGeometries` never
// refuses a bucket. UVs are in METRES so the wood grain tiles physically and end grain reads
// across the cut rather than along it.
// =================================================================================================

function uvFor(px, py, pz, nx, ny, nz, out) {
  const ax = nx < 0 ? -nx : nx, ay = ny < 0 ? -ny : ny, az = nz < 0 ? -nz : nz;
  if (ax >= ay && ax >= az) { out[0] = pz; out[1] = py; }        // end grain: rings across the cut
  else if (ay >= az) { out[0] = px; out[1] = pz; }               // top / bottom: grain along length
  else { out[0] = px; out[1] = py; }                             // sides: grain along length
}

const _uv = [0, 0];

function pushVert(A, x, y, z, nx, ny, nz) {
  A.p.push(x, y, z);
  A.n.push(nx, ny, nz);
  uvFor(x, y, z, nx, ny, nz, _uv);
  A.u.push(_uv[0], _uv[1]);
}

/** Emit a triangle with an explicit outward normal. */
function pushTri(A, a, b, c, nx, ny, nz) {
  pushVert(A, a[0], a[1], a[2], nx, ny, nz);
  pushVert(A, b[0], b[1], b[2], nx, ny, nz);
  pushVert(A, c[0], c[1], c[2], nx, ny, nz);
}

/** Emit a quad, auto-flipping the winding so it faces `n`. Saves reasoning about 44 orientations. */
function pushQuad(A, a, b, c, d, nx, ny, nz) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  if (cx * nx + cy * ny + cz * nz < 0) {
    pushTri(A, a, d, c, nx, ny, nz);
    pushTri(A, a, c, b, nx, ny, nz);
  } else {
    pushTri(A, a, b, c, nx, ny, nz);
    pushTri(A, a, c, d, nx, ny, nz);
  }
}

function finish(A) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(A.p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(A.n, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(A.u, 2));
  return g;
}

const R3 = 1 / Math.sqrt(3);

/**
 * A box with flat chamfered arrises: 6 inset faces, 12 edge facets, 8 corner facets.
 * Sharp box edges are what make procedural lumber read as programmer art; a chamfer catches a
 * highlight along every edge and the thing suddenly looks milled.
 */
function chamferBox(w, h, d, c = CH) {
  const hx = w * 0.5, hy = h * 0.5, hz = d * 0.5;
  const cc = Math.min(c, Math.min(hx, Math.min(hy, hz)) * 0.42);
  const ix = hx - cc, iy = hy - cc, iz = hz - cc;
  const A = { p: [], n: [], u: [] };
  // k: 0 = point pushed out on X, 1 = on Y, 2 = on Z
  const V = (sx, sy, sz, k) => (
    k === 0 ? [sx * hx, sy * iy, sz * iz]
      : k === 1 ? [sx * ix, sy * hy, sz * iz]
        : [sx * ix, sy * iy, sz * hz]);

  for (const s of [1, -1]) {
    pushQuad(A, V(s, -1, -1, 0), V(s, 1, -1, 0), V(s, 1, 1, 0), V(s, -1, 1, 0), s, 0, 0);
    pushQuad(A, V(-1, s, -1, 1), V(1, s, -1, 1), V(1, s, 1, 1), V(-1, s, 1, 1), 0, s, 0);
    pushQuad(A, V(-1, -1, s, 2), V(1, -1, s, 2), V(1, 1, s, 2), V(-1, 1, s, 2), 0, 0, s);
  }
  const r2 = Math.SQRT1_2;
  for (const sy of [1, -1]) for (const sz of [1, -1]) {
    pushQuad(A, V(-1, sy, sz, 1), V(1, sy, sz, 1), V(1, sy, sz, 2), V(-1, sy, sz, 2), 0, sy * r2, sz * r2);
  }
  for (const sx of [1, -1]) for (const sz of [1, -1]) {
    pushQuad(A, V(sx, -1, sz, 2), V(sx, 1, sz, 2), V(sx, 1, sz, 0), V(sx, -1, sz, 0), sx * r2, 0, sz * r2);
  }
  for (const sx of [1, -1]) for (const sy of [1, -1]) {
    pushQuad(A, V(sx, sy, -1, 0), V(sx, sy, 1, 0), V(sx, sy, 1, 1), V(sx, sy, -1, 1), sx * r2, sy * r2, 0);
  }
  for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) {
    pushTri(A, V(sx, sy, sz, 0), V(sx, sy, sz, 1), V(sx, sy, sz, 2), sx * R3, sy * R3, sz * R3);
  }
  return finish(A);
}

/** A cylinder, non-indexed, axis +Y, centred. Bolts, nails, pipe, rungs. */
function cylGeo(rTop, rBot, h, seg = 10) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, Math.max(3, seg | 0), 1, false);
  const ng = g.toNonIndexed();
  g.dispose();
  if (!ng.getAttribute('uv')) ng.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((ng.getAttribute('position').count) * 2), 2));
  ng.deleteAttribute('tangent');
  return ng;
}

/**
 * A corrugated sheet lying in XZ: ribs run along Z, the profile varies in X, thickness in Y.
 * Normals come from the analytic derivative so the ribs shade smoothly and catch the moon in
 * exactly the way a wet tin roof does.
 */
function corrugatedGeo(w, l, thick = 0.006, pitch = 0.076, amp = 0.011) {
  const cols = Math.max(8, Math.round((w / pitch) * 6));
  const A = { p: [], n: [], u: [] };
  const hz = l * 0.5;
  const k = TAU / pitch;
  const prof = new Float32Array(cols + 1);
  const nrm = new Float32Array((cols + 1) * 2);
  for (let i = 0; i <= cols; i++) {
    const x = -w * 0.5 + (i / cols) * w;
    prof[i] = Math.sin(x * k) * amp;
    const dy = Math.cos(x * k) * amp * k;
    const il = 1 / Math.sqrt(1 + dy * dy);
    nrm[i * 2] = -dy * il; nrm[i * 2 + 1] = il;
  }
  const X = (i) => -w * 0.5 + (i / cols) * w;
  for (let i = 0; i < cols; i++) {
    const x0 = X(i), x1 = X(i + 1), y0 = prof[i], y1 = prof[i + 1];
    const n0x = nrm[i * 2], n0y = nrm[i * 2 + 1];
    // top skin
    pushVert(A, x0, y0, -hz, n0x, n0y, 0); pushVert(A, x1, y1, -hz, nrm[(i + 1) * 2], nrm[(i + 1) * 2 + 1], 0); pushVert(A, x1, y1, hz, nrm[(i + 1) * 2], nrm[(i + 1) * 2 + 1], 0);
    pushVert(A, x0, y0, -hz, n0x, n0y, 0); pushVert(A, x1, y1, hz, nrm[(i + 1) * 2], nrm[(i + 1) * 2 + 1], 0); pushVert(A, x0, y0, hz, n0x, n0y, 0);
    // underside
    const b0 = y0 - thick, b1 = y1 - thick;
    pushVert(A, x0, b0, -hz, -n0x, -n0y, 0); pushVert(A, x1, b1, hz, -nrm[(i + 1) * 2], -nrm[(i + 1) * 2 + 1], 0); pushVert(A, x1, b1, -hz, -nrm[(i + 1) * 2], -nrm[(i + 1) * 2 + 1], 0);
    pushVert(A, x0, b0, -hz, -n0x, -n0y, 0); pushVert(A, x0, b0, hz, -n0x, -n0y, 0); pushVert(A, x1, b1, hz, -nrm[(i + 1) * 2], -nrm[(i + 1) * 2 + 1], 0);
    // the two long edges
    pushQuad(A, [x0, y0, -hz], [x1, y1, -hz], [x1, b1, -hz], [x0, b0, -hz], 0, 0, -1);
    pushQuad(A, [x0, y0, hz], [x1, y1, hz], [x1, b1, hz], [x0, b0, hz], 0, 0, 1);
  }
  // the two cut ends
  pushQuad(A, [X(0), prof[0], -hz], [X(0), prof[0], hz], [X(0), prof[0] - thick, hz], [X(0), prof[0] - thick, -hz], -1, 0, 0);
  pushQuad(A, [X(cols), prof[cols], -hz], [X(cols), prof[cols], hz], [X(cols), prof[cols] - thick, hz], [X(cols), prof[cols] - thick, -hz], 1, 0, 0);
  return finish(A);
}

// =================================================================================================
// KIT — accumulates geometry into per-material buckets. One Kit per node.
// =================================================================================================

class Kit {
  constructor() { this.buckets = new Map(); }

  push(mat, g) {
    let a = this.buckets.get(mat);
    if (!a) { a = []; this.buckets.set(mat, a); }
    a.push(g);
    return g;
  }

  /** A chamfered member. `ry` yaws it about its centre; +X is the member's length axis. */
  box(mat, w, h, d, x, y, z, ry = 0, c = CH) {
    const g = chamferBox(w, h, d, c);
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    return this.push(mat, g);
  }

  /** A thin steel plate: tiny chamfer so it still catches a highlight on its edge. */
  plate(mat, w, h, d, x, y, z, ry = 0) { return this.box(mat, w, h, d, x, y, z, ry, 0.0025); }

  cyl(mat, rTop, rBot, h, x, y, z, seg = 8, rot = null) {
    const g = cylGeo(rTop, rBot, h, seg);
    if (rot === 'x') g.rotateX(Math.PI / 2);
    else if (rot === 'z') g.rotateZ(Math.PI / 2);
    g.translate(x, y, z);
    return this.push(mat, g);
  }

  /**
   * A strut between two points in the ZY plane, extruded `t` thick along X. This is how every
   * truss web and rafter is placed: give it the two joints and it works out the angle.
   */
  strutZY(mat, az, ay, bz, by, depth, t, x, c = CH) {
    const dz = bz - az, dy = by - ay;
    const len = Math.hypot(dz, dy);
    if (len < 1e-4) return null;
    const g = chamferBox(t, depth, len, c);
    g.rotateX(-Math.atan2(dy, dz));
    g.translate(x, (ay + by) * 0.5, (az + bz) * 0.5);
    return this.push(mat, g);
  }

  /** A driven nail: head proud, shank buried. Reads as a black dot until the lantern finds it. */
  nail(x, y, z, dir = 'y', r = 0.0055) {
    this.cyl(MAT.rust, r * 2.1, r * 2.1, 0.004, x, y, z, 6, dir === 'y' ? null : dir);
    this.cyl(MAT.rust, r, r, 0.02, x - (dir === 'x' ? 0.011 : 0), y - (dir === 'y' ? 0.011 : 0), z - (dir === 'z' ? 0.011 : 0), 6, dir === 'y' ? null : dir);
  }

  /**
   * A galvanised joist hanger: back plate, seat, two side flanges, two stamped stiffening ribs
   * and six nails. `w` is the joist thickness it cradles, `h` the joist depth.
   */
  hanger(x, y, z, w, h, ry = 0, nails = true) {
    const t = 0.0035, f = 0.045;
    const k = new Kit();
    k.plate(MAT.galv, w + t * 2, h * 0.86, t, 0, -h * 0.07, -f * 0.5 - t);
    k.plate(MAT.galv, w + t * 2, t, f, 0, -h * 0.5 + t * 0.5, -t * 0.5);
    k.plate(MAT.galv, t, h * 0.78, f, -(w * 0.5 + t * 0.5), -h * 0.10, -t * 0.5);
    k.plate(MAT.galv, t, h * 0.78, f, (w * 0.5 + t * 0.5), -h * 0.10, -t * 0.5);
    k.plate(MAT.galv, w * 0.34, 0.006, f * 0.8, 0, -h * 0.5 + 0.006, -t * 0.5);   // stamped rib
    if (nails) {
      k.nail(-(w * 0.5 + t), h * 0.16, -0.006, 'x', 0.0045);
      k.nail((w * 0.5 + t), h * 0.16, -0.006, 'x', 0.0045);
      k.nail(-(w * 0.5 + t), -h * 0.22, -0.006, 'x', 0.0045);
      k.nail((w * 0.5 + t), -h * 0.22, -0.006, 'x', 0.0045);
    }
    this.absorb(k, x, y, z, ry);
  }

  /** A hurricane tie: an L-strap with a quarter twist, wrapping plate to truss chord. */
  tie(x, y, z, ry = 0) {
    const k = new Kit();
    const t = 0.0032;
    k.plate(MAT.galv, 0.038, 0.13, t, 0, 0.02, 0.030);
    k.plate(MAT.galv, 0.038, t, 0.062, 0, -0.043, 0.0);
    k.plate(MAT.galv, t, 0.075, 0.038, -0.019, -0.070, -0.024);
    k.plate(MAT.galv, 0.030, 0.006, 0.006, 0, 0.055, 0.030);      // stamped rib
    k.nail(0, 0.058, 0.033, 'z', 0.0042);
    k.nail(0, -0.005, 0.033, 'z', 0.0042);
    k.nail(-0.022, -0.086, -0.024, 'x', 0.0042);
    this.absorb(k, x, y, z, ry);
  }

  /** A carriage bolt: dome head, square neck, shank, washer, hex nut. Class C fastener. */
  bolt(x, y, z, len = 0.16, r = 0.010, dir = 'y', proud = 0) {
    const k = new Kit();
    const L = len + proud;
    k.cyl(MAT.galv, r * 1.35, r * 1.9, 0.011, 0, L * 0.5 + 0.005, 0, 8);
    k.box(MAT.galv, r * 1.6, 0.012, r * 1.6, 0, L * 0.5 - 0.008, 0, 0, 0.0015);
    k.cyl(MAT.galv, r, r, L, 0, 0, 0, 8);
    k.cyl(MAT.galv, r * 2.0, r * 2.0, 0.004, 0, -L * 0.5 + 0.004, 0, 8);
    k.cyl(MAT.galv, r * 1.7, r * 1.7, 0.011, 0, -L * 0.5 - 0.004, 0, 6);
    if (dir === 'x') for (const [m, list] of k.buckets) for (const g of list) g.rotateZ(Math.PI / 2);
    else if (dir === 'z') for (const [m, list] of k.buckets) for (const g of list) g.rotateX(Math.PI / 2);
    this.absorb(k, x, y, z, 0);
  }

  /** Merge another Kit's buckets into this one, offset and yawed. */
  absorb(kit, x = 0, y = 0, z = 0, ry = 0) {
    for (const [mat, list] of kit.buckets) {
      for (let i = 0; i < list.length; i++) {
        const g = list[i];
        if (ry) g.rotateY(ry);
        if (x || y || z) g.translate(x, y, z);
        this.push(mat, g);
      }
    }
    kit.buckets.clear();
  }

  dispose() {
    for (const list of this.buckets.values()) for (const g of list) g.dispose();
    this.buckets.clear();
  }
}

// =================================================================================================
// SLOT FACTORY
// =================================================================================================

function mkSlot(o) {
  const yaw = o.yaw ?? 0;
  const pos = new THREE.Vector3(o.p[0], o.p[1], o.p[2]);
  const eul = new THREE.Euler(0, yaw, 0, 'YXZ');
  const req = o.req ?? [];
  return {
    // --- the brief's schema (plot-local; Blueprint.js reads `transform.position`)
    id: o.id,
    night: o.night | 0,
    stage: 1,
    kind: o.kind ?? 'fixed',
    position: pos,
    rotation: eul,
    transform: { position: pos, quaternion: new THREE.Quaternion().setFromEuler(eul) },
    requiredPartId: o.partId ?? null,
    requiresSlots: req,
    orientationTolerance: Math.PI / Math.max(1, o.k ?? 4),
    symmetric: (o.sym ?? 4) >= (o.k ?? 4),

    // --- BuildSystem's schema (world; see the coordinate contract in the header)
    px: 0, py: 0, pz: 0,
    group: o.group ?? 'misc',
    acceptsType: o.accepts ?? null,
    partId: o.partId ?? null,
    yaw,
    axis: o.axis ?? 'y',
    yawCandidates: o.k ?? 4,
    symmetryOrder: o.sym ?? 4,
    candidateOffset: o.offset ?? 0,
    requires: req,
    fasteners: o.f ?? 0,
    hardware: o.hw ?? null,
    ratedMass: o.rated ?? 160,
    mirrorOf: o.mirror ?? null,
    hidden: !!o.hidden,
    errata: !!o.errata,
    deferred: o.deferred ?? null,
    obstruction: o.obstruction ?? null,
    requiresCut: o.cut ?? 0,
    feature: o.feature ?? null,
    occupant: !!o.occupant,
    bounds: o.bounds ?? null,
    goal: o.goal ?? null,
    article: o.article ?? null,

    // --- site-internal: how the error transform is built for this member
    _dir: o.dir ?? [1, 0, 0],     // unit vector along the member's length, plot-local
    _out: o.out ?? [0, 1, 0],     // unit vector pointing away from the structure
    _len: o.len ?? 0.5,
  };
}

// =================================================================================================
// Module scratch. update() and _rebuild() reuse these; nothing here allocates per frame.
// =================================================================================================

const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _m3 = new THREE.Matrix4();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _e1 = new THREE.Euler(0, 0, 0, 'YXZ');
const _one = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);

// =================================================================================================

export class CabinSite {
  constructor(ctx) {
    this.ctx = ctx ?? {};
    this.bus = this.ctx.bus ?? null;
    this.scene = this.ctx.scene ?? null;

    /** World position of the plot centre. Navmesh, NoiseSystem and Campers all read this. */
    this.center = new THREE.Vector3(-140, 17.08, 128);
    this.origin = this.center;
    this.plotCenter = this.center;
    this.yaw = 0;

    this.group = null;
    this._meshes = new Map();          // material name -> THREE.Mesh (one draw call each)
    this._nodes = new Map();           // node id -> { buckets, visible, anchor, requires, ... }
    this._slots = [];
    this._slotById = new Map();
    this._byNight = [[], [], [], [], [], [], [], []];   // 1-indexed
    this._installed = new Map();       // slotId -> { partId, visual, outcome, torque, candidate }
    this._dressing = [];               // { id, requires:[slotId] }

    this._partBucketCache = new Map(); // partId -> Map<mat, BufferGeometry>
    this._partGhostCache = new Map();  // partId -> BufferGeometry (merged, material-agnostic)
    this._ownedGeo = [];
    this._ownedMat = [];
    this._mergedGeo = new Map();

    this._ghost = null;
    this._ghostOk = null;
    this._ghostBad = null;
    this._ghostSlot = null;
    this._ghostT = 0;

    this._dirty = true;
    this._disposed = false;
    this._unsubs = [];
    this._features = [];
    this._featureDirty = true;
    this.bounds = new THREE.Box3();

    this._rand = new Rand(((this.ctx.settings?.get?.('seed') ?? 0x51a5cab) ^ 0xcab1) >>> 0);
    this._stats = { drawCalls: 0, members: 0, triangles: 0 };
    this._scratchLists = new Map();
    this._temp = [];
    this._tierIdx = 3;
  }

  // ----------------------------------------------------------------------------------- lifecycle

  async init() {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    const s = this.ctx.settings ?? null;
    this._tier = (l, m, h, u) => (typeof s?.tier === 'function' ? s.tier(l, m, h, u) : u);
    this._tierIdx = s?.tierIndex ?? 3;

    // --- where the plot is. Terrain carved a flat pad for us; trust it, but survive without it.
    const terrain = this.ctx.systems?.get?.('Terrain') ?? null;
    const c = terrain?.buildSiteCenter;
    if (c && Number.isFinite(c.x)) this.center.set(c.x, c.y ?? 0, c.z);
    if (typeof terrain?.heightAt === 'function') {
      const y = terrain.heightAt(this.center.x, this.center.z);
      if (Number.isFinite(y)) this.center.y = y;
    }
    this.origin = this.center;
    this.plotCenter = this.center;

    // --- Script only supplies the stage count. Missing Script must not cost us the plot.
    let script = null;
    try {
      const mod = await import('../story/Script.js');
      script = mod.Script ?? mod.default ?? null;
    } catch (e) {
      Log.debug('CabinSite: Script.js unavailable; using the fallback stage counts.', e?.message ?? e);
    }

    this._buildSlotGraph(script);

    if (this.scene) {
      this.group = new THREE.Group();
      this.group.name = 'CabinSite';
      this.group.position.copy(this.center);
      this.group.rotation.y = this.yaw;
      this.group.updateMatrix();
      this.group.matrixAutoUpdate = false;
      this.scene.add(this.group);
    }

    this._buildMaterialMeshes();
    this._buildGhost();
    this._buildAllNodes();
    this._bindEvents();
    this._applyPreview();
    this._rebuild();

    const ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    Log.debug(`CabinSite: ${this._slots.length} slots (${this._byNight.slice(1).map((a) => a.length).join('/')}), `
      + `${this._nodes.size} nodes, ${this._stats.drawCalls} draw calls, `
      + `${(this._stats.triangles / 1000).toFixed(1)}k tris, ${ms.toFixed(1)}ms.`);
  }

  update(dt, elapsed) {
    if (this._disposed) return;
    if (this._dirty) this._rebuild();
    const g = this._ghost;
    if (g && g.visible) {
      // A slow breath so the ghost never reads as a solid part in peripheral vision.
      this._ghostT += dt;
      const k = 0.78 + 0.22 * Math.sin(this._ghostT * 3.1);
      if (g.material) g.material.opacity = g.userData.baseOpacity * k;
      g.scale.setScalar(1 + 0.004 * Math.sin(this._ghostT * 3.1 + 1.1));
    }
  }

  resize(_w, _h) { /* nothing resolution-dependent lives here */ }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    for (let i = 0; i < this._unsubs.length; i++) { try { this._unsubs[i](); } catch { /* gone */ } }
    this._unsubs.length = 0;

    for (const node of this._nodes.values()) {
      for (const list of node.buckets.values()) for (const g of list) g.dispose();
      node.buckets.clear();
    }
    this._nodes.clear();

    for (const g of this._mergedGeo.values()) g?.dispose?.();
    this._mergedGeo.clear();
    for (const g of this._temp) g?.dispose?.();
    this._temp.length = 0;

    for (const m of this._partBucketCache.values()) for (const g of m.values()) g.dispose();
    this._partBucketCache.clear();
    for (const g of this._partGhostCache.values()) g.dispose();
    this._partGhostCache.clear();

    for (const g of this._ownedGeo) g?.dispose?.();
    for (const m of this._ownedMat) m?.dispose?.();
    this._ownedGeo.length = 0;
    this._ownedMat.length = 0;

    if (this.group) {
      this.group.parent?.remove(this.group);
      this.group.clear();
      this.group = null;
    }
    this._meshes.clear();
    this._ghost = null;
    this._ghostOk = null;
    this._ghostBad = null;
    this._slots.length = 0;
    this._slotById.clear();
    this._installed.clear();
    this._scratchLists.clear();
    this._foreign?.clear();
    this._fallbackMats?.clear();
    this._dressing.length = 0;
    this._features.length = 0;
  }

  // ------------------------------------------------------------------------------- public reads

  /** Every slot in the game, nights 1..7, in dependency order. */
  get slots() { return this._slots; }

  slotsForNight(n) { return this._byNight[clamp(n | 0, 1, 7)] ?? []; }

  slotById(id) { return this._slotById.get(id) ?? null; }

  /**
   * World transform for a slot. `position` and `quaternion` are fresh objects (this is a query,
   * not a per-frame call) so the caller may keep them.
   */
  slotWorldTransform(slotId) {
    const s = typeof slotId === 'string' ? this._slotById.get(slotId) : slotId;
    if (!s) return null;
    const pos = new THREE.Vector3(s.px, s.py, s.pz);
    _e1.set(0, s.yaw + this.yaw, 0);
    return { position: pos, quaternion: new THREE.Quaternion().setFromEuler(_e1), scale: new THREE.Vector3(1, 1, 1) };
  }

  /** 0..1 over all 90 slots. The cabin, as a fraction of a house. */
  get progress() {
    const total = this._slots.length || 1;
    let n = 0;
    for (const rec of this._installed.values()) if (rec) n++;
    return clamp01(n / total);
  }

  get footprint() {
    return { halfX: P.HX, halfZ: P.HZ, deckY: P.DECK_Y, plateY: P.PLATE_Y, ridgeY: P.APEX_Y };
  }

  /**
   * §9.5 — the cabin as an AI percept. Campers reads this to decide what the silhouette on the
   * plot IS, which is what turns the half-built frame into the best hiding place in the game.
   */
  get features() {
    if (this._featureDirty) this._recomputeFeatures();
    return this._features;
  }

  /** Draw calls, members and triangles for the whole site. Read by the perf HUD and by reviews. */
  get stats() { return this._stats; }

  // --------------------------------------------------------------------------------- obstructions

  /**
   * The obstruction standing in `slotId` has been pulled out. Takes the standing object out of the
   * world and lays the pulled one down beside the slot. Returns true if anything changed.
   *
   * Called by `BuildSystem.removeObstruction()` when its 1.10 s action completes (STORY §1.4).
   * Idempotent, and safe to call for a slot that has no obstruction.
   *
   * WHY IT EXISTS. `removeObstruction()` used to clear `Slot.obstruction` — the gameplay flag —
   * and stop. The stake itself lives here, baked into the site-prep dressing, so it kept standing.
   * Measured after a real pull, with the pier seated: the post was still `visible`, spanning
   * y 17.055–17.975 against a pier top face at 17.475. The player pulls the stake, the red mark
   * clears, the ghost goes valid, the pier goes in — and the stake is still sticking half a metre
   * out of the top of it. Two systems disagreeing about the same object, on the first join of the
   * first night, in the one place STORY calls "the tutorial's first input".
   */
  clearObstruction(slotId) {
    const pair = OBSTRUCTION_DRESSING[slotId];
    if (!pair) return false;
    const a = this._setDressingSuppressed(pair.standing, true);
    const b = this._setDressingSuppressed(pair.pulled, false);
    if (a || b) { this._dirty = true; this._featureDirty = true; }
    return a || b;
  }

  /** The inverse, for a fresh Night One. Puts the stake back in the hole. */
  restoreObstruction(slotId) {
    const pair = OBSTRUCTION_DRESSING[slotId];
    if (!pair) return false;
    const a = this._setDressingSuppressed(pair.standing, false);
    const b = this._setDressingSuppressed(pair.pulled, true);
    if (a || b) { this._dirty = true; this._featureDirty = true; }
    return a || b;
  }

  /** Returns true if the flag actually moved, so callers can skip a needless rebuild. */
  _setDressingSuppressed(dressId, suppressed) {
    for (let i = 0; i < this._dressing.length; i++) {
      const d = this._dressing[i];
      if (d.id !== dressId) continue;
      if (d.suppressed === suppressed) return false;
      d.suppressed = suppressed;
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------------------ install / ghost

  /**
   * Seat a part in a slot, with the mistake visible from outside.
   *
   * Accepts BOTH call shapes, because both exist in the repo:
   *   setInstalled(slotId, part|partId, info)                         <- BuildSystem._seatVisual
   *   setInstalled(slotId, partId, correct:boolean, torque:number)    <- the module brief
   */
  setInstalled(slotId, partOrId, correctOrInfo, torque) {
    const slot = this._slotById.get(slotId);
    if (!slot) return;

    let partId = null;
    if (typeof partOrId === 'string') partId = partOrId;
    else if (partOrId && typeof partOrId === 'object') partId = partOrId.partId ?? partOrId.id ?? null;
    if (!partId) partId = slot.requiredPartId;

    let visual = 'flush', outcome = 'seated', tq = 1, candidate = 0, offsetMm = 0;
    if (correctOrInfo && typeof correctOrInfo === 'object') {
      outcome = correctOrInfo.outcome ?? 'seated';
      tq = Number.isFinite(correctOrInfo.torque) ? correctOrInfo.torque : 1;
      candidate = correctOrInfo.candidate | 0;
      offsetMm = Number.isFinite(correctOrInfo.offsetMm) ? correctOrInfo.offsetMm : 0;
      visual = correctOrInfo.visual ?? this._deriveVisual(outcome, tq);
    } else {
      const correct = !!correctOrInfo;
      tq = Number.isFinite(torque) ? torque : (correct ? 1 : 0.6);
      outcome = correct ? 'seated' : (partId === slot.requiredPartId ? 'rotated' : 'wrong-part');
      visual = this._deriveVisual(outcome, tq);
    }
    if (!VISUALS[visual]) visual = 'flush';

    this._installed.set(slotId, { partId, visual, outcome, torque: tq, candidate, offsetMm });
    this._dirty = true;
    this._featureDirty = true;
  }

  clearInstalled(slotId) {
    if (this._installed.delete(slotId)) {
      this._dirty = true;
      this._featureDirty = true;
    }
  }

  /**
   * §6.4.2 — the ghost gives NO orientation cue. Same outline, same opacity, same position for a
   * correct candidate and an incorrect one. `valid` only reflects whether the place is legal
   * (type, dependencies, obstruction), never whether it is right.
   */
  showGhost(slotId, partId, valid) {
    const g = this._ghost;
    if (!g) return;
    const slot = slotId ? this._slotById.get(slotId) : null;
    if (!slot) { this.hideGhost(); return; }

    const pid = partId || slot.requiredPartId;
    const geo = pid ? this._ghostGeometry(pid) : null;
    if (!geo) { this.hideGhost(); return; }

    g.geometry = geo;
    g.position.copy(slot.position);
    g.rotation.set(0, slot.yaw, 0);
    g.material = valid ? this._ghostOk : this._ghostBad;
    g.userData.baseOpacity = valid ? 0.34 : 0.15;
    g.visible = true;
    this._ghostSlot = slot.id;
  }

  hideGhost() {
    if (this._ghost) this._ghost.visible = false;
    this._ghostSlot = null;
  }

  /**
   * The carryable object for a part. Returns a fresh Group per call (BuildSystem owns and moves
   * it) over SHARED cached geometry — never dispose the returned meshes' geometry.
   */
  partMesh(partId, _part = null) {
    const buckets = this._partBuckets(partId);
    if (!buckets || !buckets.size) return null;
    const g = new THREE.Group();
    g.name = `part:${partId}`;
    for (const [mat, geo] of buckets) {
      const m = new THREE.Mesh(geo, this._mat(mat));
      m.castShadow = true;
      m.receiveShadow = true;
      m.name = `${partId}:${mat}`;
      g.add(m);
    }
    g.userData.partId = partId;
    return g;
  }

  /** BuildSystem pokes this after a placement so the site can re-derive the AI silhouette. */
  onBuildChanged(_slotId, _featureHeights) {
    this._featureDirty = true;
    this._dirty = true;
  }

  // =============================================================================================
  // THE SLOT GRAPH
  // =============================================================================================

  _buildSlotGraph(script) {
    const all = [];
    for (let n = 1; n <= 7; n++) {
      const list = this._nightSlots(n);
      const k = Math.max(1, (script?.nightDef?.(n)?.stageCount | 0) || [2, 3, 3, 3, 2, 4, 1][n - 1]);
      // Identical packing to BuildSystem.packStages, so `build:stage-complete { stage: 3 }` and
      // `{ stage: 6 }` — the two story-critical beats — still fire on the same slots.
      for (let i = 0; i < list.length; i++) list[i].stage = Math.min(k, 1 + Math.floor((i * k) / list.length));
      this._byNight[n] = list;
      for (const s of list) {
        s.px = this.center.x + s.position.x;
        s.py = this.center.y + s.position.y;
        s.pz = this.center.z + s.position.z;
        this._slotById.set(s.id, s);
        all.push(s);
      }
    }
    this._slots = all;
  }

  _nightSlots(n) {
    if (n === 1) return this._n1();
    if (n === 2) return this._n2();
    if (n === 3) return this._n3();
    if (n === 4) return this._n4();
    if (n === 5) return this._n5();
    if (n === 6) return this._n6();
    return this._n7();
  }

  /** NIGHT ONE — 6 stone piers, 6 sill beams. 12. */
  _n1() {
    const s = [];
    for (let i = 0; i < 6; i++) {
      s.push(mkSlot({
        id: `P-0${i + 1}`, night: 1, group: 'piers', accepts: 'pier', partId: 'PIER',
        feature: 'piers', p: [PIER_XZ[i][0], P.PIER_Y, PIER_XZ[i][1]],
        // §6.4.2: symmetryOrder === k, so a pier cannot be Rotated. It is a squared boulder.
        k: 4, sym: 4, f: 0, rated: 240, article: '1962-006',
        dir: [1, 0, 0], out: [0, 1, 0], len: P.PIER_W,
        // STORY §1.4 — the county survey stake in the way of the first pier. Silent. No prompt.
        obstruction: i === 0 ? 'county-stake' : null,
      }));
    }
    // Two per long wall (spliced over the mid pier), one per short wall. Exactly 19.2 m of sill
    // for a 19.2 m perimeter: nothing cut, nothing spare.
    const SILL = [
      { id: 'S-01', p: [-1.60, P.SILL_Y, -P.HZ], yaw: 0, req: ['P-01', 'P-02'], dir: [1, 0, 0], out: [0, 0, -1] },
      { id: 'S-02', p: [1.60, P.SILL_Y, -P.HZ], yaw: 0, req: ['P-02', 'P-03'], dir: [1, 0, 0], out: [0, 0, -1] },
      { id: 'S-03', p: [P.HX, P.SILL_Y, 0], yaw: Math.PI / 2, req: ['P-03', 'P-04'], dir: [0, 0, 1], out: [1, 0, 0] },
      { id: 'S-04', p: [1.60, P.SILL_Y, P.HZ], yaw: 0, req: ['P-04', 'P-05'], dir: [1, 0, 0], out: [0, 0, 1] },
      { id: 'S-05', p: [-1.60, P.SILL_Y, P.HZ], yaw: 0, req: ['P-05', 'P-06'], dir: [1, 0, 0], out: [0, 0, 1] },
      { id: 'S-06', p: [-P.HX, P.SILL_Y, 0], yaw: Math.PI / 2, req: ['P-06', 'P-01'], dir: [0, 0, 1], out: [-1, 0, 0] },
    ];
    for (const d of SILL) {
      s.push(mkSlot({
        ...d, night: 1, group: 'sills', accepts: 'beam', partId: 'SILL', feature: 'piers',
        // G1's only failure: a sill goes in end-for-end. k = 2, one correct candidate. The
        // half-lap notch is cut on ONE end only, so a flipped sill will not sit down.
        k: 2, sym: 1, f: 4, rated: 200, article: '1962-024', len: 3.20,
      }));
    }
    return s;
  }

  /** NIGHT TWO — 4 corner posts, 6 wall studs, 4 diagonal braces. 14. */
  _n2() {
    const s = [];
    const postY = P.DECK_Y + P.POST_H * 0.5;
    const sillFor = ['S-01', 'S-02', 'S-04', 'S-05'];
    for (let i = 0; i < 4; i++) {
      s.push(mkSlot({
        id: CORNER_ID[i], night: 2, group: 'posts', accepts: 'post', partId: 'POST',
        feature: 'frame', p: [CORNER_XZ[i][0], postY, CORNER_XZ[i][1]],
        // A 6x6 post is square in section but the mortise for the brace is cut on two faces,
        // so half the candidates are wrong.
        k: 4, sym: 2, f: 3, rated: 340, req: [sillFor[i]], article: '1953-091',
        dir: [0, 1, 0], out: [Math.sign(CORNER_XZ[i][0]) || 1, 0, 0], len: P.POST_H,
      }));
    }
    const wallPosts = [['C-NW', 'C-NE'], ['C-NW', 'C-NE'], ['C-NE', 'C-SE'], ['C-SE', 'C-SW'], ['C-SE', 'C-SW'], ['C-SW', 'C-NW']];
    for (let i = 0; i < 6; i++) {
      const [x, z] = STUD_XZ[i];
      const onEnd = Math.abs(x) === Math.abs(P.CAB_E) && Math.abs(z) !== P.HZ;
      s.push(mkSlot({
        id: `T-0${i + 1}`, night: 2, group: 'studs', accepts: 'post', partId: 'STUD',
        feature: 'frame', p: [x, postY, z], yaw: (onEnd || x === P.CAB_W) ? Math.PI / 2 : 0,
        k: 2, sym: 1, f: 2, rated: 190, req: wallPosts[i], article: '1955-108',
        dir: [0, 1, 0], out: [0, 0, z < 0 ? -1 : 1], len: P.POST_H,
      }));
    }
    // G2 — handedness. The two south braces want the OTHER half of the candidate ring and the
    // ghost does not say so. The bracket itself is the only tell: one leg is longer.
    for (let i = 0; i < 4; i++) {
      const mirrored = i >= 2;
      const [cx, cz] = CORNER_XZ[i];
      s.push(mkSlot({
        id: `B-0${i + 1}`, night: 2, group: 'braces', accepts: 'bracket', partId: 'BRACKET',
        feature: 'frame', p: [cx - Math.sign(cx) * 0.16, P.DECK_Y + P.POST_H - 0.22, cz - Math.sign(cz) * 0.16],
        yaw: Math.atan2(-cz, -cx),
        k: 4, sym: 2, offset: mirrored ? 2 : 0, mirror: mirrored ? `B-0${i - 1}` : null,
        f: 2, rated: 150, req: [CORNER_ID[i]], hw: { id: 'bracket_H', count: 1 },
        article: '1955-124', dir: [1, 0, 0], out: [0, 0, cz < 0 ? -1 : 1], len: 0.22,
      }));
    }
    return s;
  }

  /** NIGHT THREE — 6 truss assemblies, 1 over-long ridge beam, 6 ridge pins. 13. */
  _n3() {
    const s = [];
    const posts = ['C-NW', 'C-NE', 'C-SE', 'C-SW'];
    for (let i = 0; i < 6; i++) {
      s.push(mkSlot({
        id: `TR-0${i + 1}`, night: 3, group: 'trusses', accepts: 'truss', partId: 'TRUSS',
        feature: 'roof-skeleton', p: [TRUSS_X[i], P.BEAR_Y + P.TRUSS_RISE * 0.42, 0],
        k: 2, sym: 1, f: 2, rated: 280, req: posts, article: '1957-141',
        // G3 — two trusses want gusset plates that are in the bag icon and not in the drawing.
        hidden: i === 2 || i === 5,
        hw: (i === 2 || i === 5) ? { id: 'gusset_plate', count: 1 } : null,
        dir: [0, 0, 1], out: [i < 3 ? -1 : 1, 0, 0], len: P.TRUSS_SPAN,
      }));
    }
    s.push(mkSlot({
      id: 'RB-01', night: 3, group: 'ridge', accepts: 'ridge', partId: 'RIDGE',
      feature: 'roof-skeleton', p: [(P.CAB_W + P.CAB_E) * 0.5, P.APEX_Y - P.RIDGE_D * 0.5, 0],
      yaw: 0, k: 2, sym: 2, f: 4, rated: 660, cut: 4.80,
      req: ['TR-01', 'TR-02', 'TR-03', 'TR-04', 'TR-05', 'TR-06'], article: '1962-001',
      dir: [1, 0, 0], out: [0, 1, 0], len: P.RIDGE_L,
    }));
    for (let i = 0; i < 6; i++) {
      s.push(mkSlot({
        id: `RP-0${i + 1}`, night: 3, group: 'ridge-pins', accepts: 'fastener', partId: 'PIN',
        feature: 'roof-skeleton', p: [TRUSS_X[i], P.APEX_Y - 0.02, 0],
        k: 2, sym: 2, f: 1, rated: 90, req: ['RB-01'], article: '1962-006',
        dir: [0, 1, 0], out: [0, 1, 0], len: 0.18,
      }));
    }
    return s;
  }

  /**
   * NIGHT FOUR — 12 subfloor courses, 3 hinges, 1 door. 16.
   * G4: `acceptsType` is length-agnostic, so a 2.40 board seats in a 1.20 slot and hangs a
   * metre and a fifth out over the crawlspace hatch. It is not diagnosed for 90 s (§6.4.1) —
   * but it is VISIBLE the whole time, which is the difference between a puzzle and a trick.
   */
  _n4() {
    const s = [];
    const z0 = -P.HZ + 0.12;
    for (let i = 0; i < 12; i++) {
      const short = (i === 4 || i === 5);          // the two courses the hatch interrupts
      const z = z0 + i * 0.24;
      const len = short ? 1.20 : 2.40;
      const cx = P.CAB_W + 0.02 + len * 0.5;
      s.push(mkSlot({
        id: `SF-${String(i + 1).padStart(2, '0')}`, night: 4, group: 'subfloor', accepts: 'board',
        partId: short ? 'BOARD_12' : 'BOARD_24', feature: 'floor-door',
        p: [cx, P.DECK_Y + P.BOARD_T * 0.5, z], k: 2, sym: 1, f: 2, rated: 120,
        req: [i < 6 ? 'S-01' : 'S-05'], article: short ? '1961-012' : '1961-024',
        dir: [1, 0, 0], out: [0, 1, 0], len,
      }));
    }
    for (let i = 0; i < 3; i++) {
      s.push(mkSlot({
        id: `H-0${i + 1}`, night: 4, group: 'hinges', accepts: 'hinge', partId: 'HINGE',
        feature: 'floor-door', p: [P.CAB_E + 0.09, P.DECK_Y + 0.30 + i * 0.77, -0.95],
        yaw: Math.PI / 2, k: 2, sym: 1, f: 2, rated: 70, req: ['C-NE'],
        hw: i === 2 ? { id: 'hinge_set_brass', count: 1 } : null, article: '1949-003',
        dir: [0, 0, 1], out: [1, 0, 0], len: 0.14,
      }));
    }
    s.push(mkSlot({
      id: 'D-01', night: 4, group: 'door', accepts: 'door', partId: 'DOOR', feature: 'floor-door',
      p: [P.CAB_E + 0.06, P.DECK_Y + P.DOOR_H * 0.5 + 0.03, -0.50], yaw: Math.PI / 2,
      k: 2, sym: 1, f: 0, rated: 150, req: ['H-01', 'H-02', 'H-03'], article: '1953-091',
      dir: [0, 0, 1], out: [1, 0, 0], len: P.DOOR_W,
    }));
    return s;
  }

  /** NIGHT FIVE — 1 north wall panel (71 kg, end-lift), 3 freeform rig anchors, 6 pins. 10. */
  _n5() {
    const s = [];
    const zFace = -P.HZ - P.STUD_D * 0.5 - 0.025;
    s.push(mkSlot({
      id: 'W-NORTH', night: 5, group: 'wall', accepts: 'panel', partId: 'PANEL_N',
      feature: 'wall-north', p: [(P.CAB_W + P.CAB_E) * 0.5, P.DECK_Y + 1.20, zFace],
      k: 2, sym: 2, f: 0, rated: 460, req: ['C-NW', 'C-NE'], article: '1962-048',
      dir: [1, 0, 0], out: [0, 0, -1], len: 4.80,
    }));
    const box = new THREE.Box3(
      new THREE.Vector3(-3.4, -0.2, -P.HZ - 2.6),
      new THREE.Vector3(1.8, 3.4, -P.HZ + 0.4),
    );
    for (let i = 0; i < 3; i++) {
      s.push(mkSlot({
        id: `RIG-N5-${'ABC'[i]}`, kind: 'freeform', night: 5, group: 'rig', accepts: null,
        partId: null, p: [-2.4 + i * 1.6, 0.0, -P.HZ - 0.85], bounds: box, k: 4, sym: 4,
        goal: { type: 'support', target: 'W-NORTH', minUpwardForce: 340, minHeight: 2.05, minDurationSeconds: 8.0 },
        dir: [0, 1, 0], out: [0, 0, -1], len: 1.0,
      }));
    }
    for (let i = 0; i < 6; i++) {
      s.push(mkSlot({
        id: `PN-0${i + 1}`, night: 5, group: 'wall-pins', accepts: 'fastener', partId: 'PIN',
        feature: 'wall-north', p: [-3.00 + i * 0.88, P.DECK_Y + 2.34, zFace - 0.02],
        yaw: Math.PI / 2, k: 2, sym: 2, f: 1, rated: 90, req: ['W-NORTH'], article: '1962-006',
        dir: [0, 0, 1], out: [0, 0, -1], len: 0.18,
      }));
    }
    return s;
  }

  /** NIGHT SIX — 8 roof battens, 6 tin bundles, sink, flue, doorframe. 17. */
  _n6() {
    const s = [];
    // Two purlin runs per slope, each spliced over the truss at x = -1.28.
    const runs = [];
    for (const side of [-1, 1]) {
      for (const t of [0.34, 0.68]) {
        const z = side * ROOF_RUN * t;
        runs.push({ z, y: roofY(z) + 0.030, side });      // purlins sit ON the top chords
      }
    }
    for (let i = 0; i < 8; i++) {
      const r = runs[i >> 1];
      const west = (i & 1) === 0;
      const len = west ? 2.16 : 3.12;
      const cx = west ? (P.CAB_W + len * 0.5) : (P.CAB_E - len * 0.5);
      s.push(mkSlot({
        id: `BAT-0${i + 1}`, night: 6, group: 'battens', accepts: 'batten', partId: 'BATTEN',
        feature: 'roof', p: [cx, r.y, r.z], k: 2, sym: 1, f: 2, rated: 160, req: ['RB-01'],
        // G6 — the printed step for this one is wrong, and the errata slip is in the boathouse.
        errata: i === 4, article: '1971-008',
        dir: [1, 0, 0], out: [0, Math.cos(0.5), r.side * 0.5], len,
      }));
    }
    for (let i = 0; i < 6; i++) {
      const side = i < 3 ? -1 : 1;
      const col = i % 3;
      const last = i === 5;
      s.push(mkSlot({
        id: `SHG-0${i + 1}`, night: 6, group: 'shingles', accepts: 'shingle', partId: 'SHINGLE',
        feature: 'roof', p: [P.CAB_W + 0.80 + col * 1.60, P.APEX_Y - 0.56, side * 1.02],
        k: 4, sym: 4, f: 1, rated: 140, req: [`BAT-0${i + 1}`],
        // G7 — this one continues on tomorrow's sheet. Leaving it open is CORRECT.
        deferred: last ? { blameSlot: 'RB-01', untilNight: 7 } : null, article: '1971-006',
        dir: [1, 0, 0], out: [0, 0.87, side * 0.49], len: 1.60,
      }));
    }
    s.push(mkSlot({
      id: 'SNK-01', night: 6, group: 'fittings', accepts: 'fitting', partId: 'SINK',
      feature: 'roof', p: [-2.20, P.DECK_Y + 0.76, -P.HZ + 0.30], k: 4, sym: 1, f: 2, rated: 100,
      req: ['SF-01'], article: '1962-001', dir: [1, 0, 0], out: [0, 0, 1], len: 0.62,
    }));
    s.push(mkSlot({
      id: 'FLU-01', night: 6, group: 'fittings', accepts: 'fitting', partId: 'FLUE',
      feature: 'roof', p: [-2.60, P.DECK_Y + 1.42, 0.90], k: 2, sym: 2, f: 2, rated: 80,
      req: ['SF-02'], article: '1962-002', dir: [0, 1, 0], out: [1, 0, 0], len: 2.20,
    }));
    s.push(mkSlot({
      id: 'DFR-01', night: 6, group: 'fittings', accepts: 'fitting', partId: 'DOORFRAME',
      feature: 'roof', p: [P.CAB_E, P.DECK_Y + 1.08, -0.50], yaw: Math.PI / 2,
      k: 2, sym: 1, f: 3, rated: 120, req: ['D-01'],
      // The article that does not exist. It has never existed. DFR-01 can never be Seated, and
      // the manual will go on drawing its little open circle for the rest of the game.
      hw: { id: 'article_0000_000', count: 1 }, article: '0000-000',
      dir: [0, 0, 1], out: [1, 0, 0], len: 1.00,
    }));
    return s;
  }

  /**
   * NIGHT SEVEN — two chairs, eight slots. Everything else STORY §6 names for tonight — the
   * hearth stone, the chimney courses, the porch, the table, the roof cap — is dressing that
   * arrives with the first chair leg, because §2 is the canonical slot table and the house is
   * not made of carrying.
   */
  _n7() {
    const s = [];
    const seats = [{ tag: 'A', x: -2.05, z: -0.34, k: 1.00 }, { tag: 'B', x: -2.05, z: 0.46, k: 0.62 }];
    for (const c of seats) {
      const y = P.DECK_Y + P.BOARD_T;
      s.push(mkSlot({
        id: `CHR-${c.tag}-1`, night: 7, group: `chair-${c.tag}`, accepts: 'chair', partId: 'CHAIR_LEG',
        p: [c.x, y + 0.22 * c.k, c.z], k: 4, sym: 2, f: 2, rated: 90, article: '1949-004',
        dir: [0, 1, 0], out: [1, 0, 0], len: 0.44 * c.k,
      }));
      s.push(mkSlot({
        id: `CHR-${c.tag}-2`, night: 7, group: `chair-${c.tag}`, accepts: 'chair', partId: 'CHAIR_SEAT',
        p: [c.x, y + 0.44 * c.k, c.z], k: 4, sym: 2, f: 2, rated: 90, req: [`CHR-${c.tag}-1`],
        article: '1949-001', dir: [1, 0, 0], out: [0, 1, 0], len: 0.42 * c.k,
      }));
      s.push(mkSlot({
        id: `CHR-${c.tag}-3`, night: 7, group: `chair-${c.tag}`, accepts: 'chair', partId: 'CHAIR_BACK',
        p: [c.x - 0.19 * c.k, y + 0.72 * c.k, c.z], k: 4, sym: 2, f: 2, rated: 60,
        req: [`CHR-${c.tag}-2`], article: '1949-001', dir: [0, 0, 1], out: [-1, 0, 0], len: 0.42 * c.k,
      }));
      s.push(mkSlot({
        id: `CHR-${c.tag}-4`, night: 7, group: `chair-${c.tag}`, accepts: 'chair', partId: 'CHAIR_ARM',
        p: [c.x, y + 0.60 * c.k, c.z], k: 4, sym: 2, f: 2, rated: 60, req: [`CHR-${c.tag}-3`],
        // The seventh night's shortfall is not an object. It adds no wrongness and gates nothing.
        // The finished house is silent. It is simply short.
        occupant: c.tag === 'B', article: c.tag === 'B' ? '0000-000' : '1949-002',
        dir: [1, 0, 0], out: [0, 1, 0], len: 0.40 * c.k,
      }));
    }
    return s;
  }

  // =============================================================================================
  // NODES — one per slot, plus the dressing that turns a slot graph into a building
  // =============================================================================================

  _node(id, kit, opts = {}) {
    this._nodes.set(id, {
      id,
      buckets: kit.buckets,
      visible: !!opts.visible,
      slot: opts.slot ?? null,
      anchor: opts.anchor ?? null,
      requires: opts.requires ?? null,
      alt: opts.alt ?? null,
    });
    for (const list of kit.buckets.values()) this._stats.members += list.length;
    kit.buckets = new Map();
    return this._nodes.get(id);
  }

  _buildAllNodes() {
    for (const s of this._slots) {
      const k = new Kit();
      this._slotGeometry(k, s);
      if (!k.buckets.size) { k.dispose(); continue; }
      this._node(`slot:${s.id}`, k, { slot: s, anchor: s.position });
    }
    this._buildDressing();
  }

  /** The correct, in-place, properly jointed member for a slot. */
  _slotGeometry(k, s) {
    const p = s.position;
    switch (s.group) {
      case 'piers': this._gPier(k, p.x, p.y, p.z); break;
      case 'sills': this._gSill(k, s); break;
      case 'posts': this._gPost(k, p.x, p.y, p.z); break;
      case 'studs': this._gStud(k, s); break;
      case 'braces': this._gBrace(k, s); break;
      case 'trusses': this._gTruss(k, p.x); break;
      case 'ridge': this._gRidge(k, p.x, p.y, p.z); break;
      case 'ridge-pins': case 'wall-pins': this._gPin(k, s); break;
      case 'subfloor': this._gDeckCourse(k, s); break;
      case 'hinges': this._gHinge(k, s); break;
      case 'door': this._gDoor(k, s); break;
      case 'wall': this._gWallPanel(k, s); break;
      case 'battens': this._gBatten(k, s); break;
      case 'shingles': this._gTinPanel(k, s); break;
      case 'fittings': this._gFitting(k, s); break;
      default:
        if (s.group.startsWith('chair-')) this._gChairPiece(k, s);
        break;
    }
  }

  // ---- individual members --------------------------------------------------------------------

  _gPier(k, x, y, z) {
    const r = new Rand((hash2(Math.round(x * 10) + 64, Math.round(z * 10) + 64) * 1e9) | 0);
    // A squared boulder: two slightly offset courses, chamfered hard, jittered in plan.
    k.box(MAT.stone, P.PIER_W, P.PIER_H * 0.62, P.PIER_W, x, y - P.PIER_H * 0.18, z, r.range(-0.09, 0.09), 0.030);
    k.box(MAT.stone, P.PIER_W * 0.90, P.PIER_H * 0.46, P.PIER_W * 0.90, x + r.range(-0.02, 0.02), y + P.PIER_H * 0.22, z + r.range(-0.02, 0.02), r.range(-0.12, 0.12), 0.026);
  }

  _gSill(k, s) {
    const p = s.position;
    const alongX = Math.abs(s._dir[0]) > 0.5;
    const L = 3.20, w = P.SILL, h = P.SILL;
    // Half-lapped corner: the outer 220 mm at the outboard end drops to half depth so the
    // crossing sill sits into it. A sill placed end-for-end puts the lap at the wrong end and
    // rides 110 mm high — G1's whole failure mode, and you can see it from the treeline.
    const lapEnd = alongX ? Math.sign(p.x) || 1 : Math.sign(p.z) || 1;
    const body = L - P.SILL;
    if (alongX) {
      k.box(MAT.lumber, body, h, w, p.x - lapEnd * P.SILL * 0.5, p.y, p.z, 0, 0.012);
      k.box(MAT.lumber, P.SILL, h * 0.5, w, p.x + lapEnd * (body * 0.5), p.y - h * 0.25, p.z, 0, 0.010);
    } else {
      k.box(MAT.lumber, w, h, body, p.x, p.y, p.z - lapEnd * P.SILL * 0.5, 0, 0.012);
      k.box(MAT.lumber, w, h * 0.5, P.SILL, p.x, p.y + h * 0.25, p.z + lapEnd * (body * 0.5), 0, 0.010);
    }
    // Two carriage bolts down into the pier at each bearing point.
    const bx = alongX ? [p.x - 1.30, p.x + 1.30] : [p.x, p.x];
    const bz = alongX ? [p.z, p.z] : [p.z - 1.30, p.z + 1.30];
    for (let i = 0; i < 2; i++) k.bolt(bx[i], p.y - 0.02, bz[i], 0.30, 0.010, 'y');
  }

  _gPost(k, x, y, z) {
    k.box(MAT.lumber, P.POST, P.POST_H, P.POST, x, y, z, 0, 0.012);
    // A 6x6 gets a mortise on the two inboard faces for the knee brace: cut as a shallow recess
    // made from two cheeks so the chamfer catches the lantern.
    const sx = Math.sign(x) || 1, sz = Math.sign(z) || 1;
    k.box(MAT.lumber, 0.05, 0.10, P.POST * 0.9, x - sx * (P.POST * 0.5 - 0.02), y + P.POST_H * 0.5 - 0.30, z, 0, 0.006);
    k.box(MAT.lumber, P.POST * 0.9, 0.10, 0.05, x, y + P.POST_H * 0.5 - 0.30, z - sz * (P.POST * 0.5 - 0.02), 0, 0.006);
    // Post base: a galvanised standoff plate keeps the end grain out of the wet.
    k.plate(MAT.galv, P.POST + 0.03, 0.006, P.POST + 0.03, x, y - P.POST_H * 0.5 - 0.004, z);
    k.bolt(x, y - P.POST_H * 0.5 + 0.10, z + P.POST * 0.5, 0.24, 0.009, 'z');
  }

  _gStud(k, s) {
    const p = s.position;
    const ry = s.yaw;
    k.box(MAT.lumber, P.STUD_T, P.POST_H, P.STUD_D, p.x, p.y, p.z, ry, 0.006);
    // Pencil layout crosses on the wide face — the 2.2 m tell that says which way is up.
    k.plate(MAT.rust, 0.0012, 0.004, P.STUD_D * 0.7, p.x + (Math.abs(Math.cos(ry)) > 0.5 ? P.STUD_T * 0.5 : 0), p.y + 0.9, p.z + (Math.abs(Math.cos(ry)) > 0.5 ? 0 : P.STUD_T * 0.5), ry);
    k.hanger(p.x, p.y - P.POST_H * 0.5 + 0.06, p.z, P.STUD_T, 0.16, ry, this._tierIdx >= 2);
  }

  _gBrace(k, s) {
    const p = s.position;
    // A galvanised angle with one leg longer than the other. THAT is G2: get the handedness
    // wrong and the long leg points at the sky instead of down the post.
    const t = 0.004;
    const kk = new Kit();
    kk.plate(MAT.galv, 0.22, t, 0.075, 0.11, 0, 0);
    kk.plate(MAT.galv, t, 0.150, 0.075, 0, -0.075, 0);
    kk.plate(MAT.galv, 0.020, 0.006, 0.006, 0.11, t, 0);           // stamped rib
    kk.plate(MAT.galv, 0.006, 0.090, 0.006, t, -0.075, 0);
    kk.nail(0.055, t, 0.022, 'y', 0.0045);
    kk.nail(0.165, t, -0.022, 'y', 0.0045);
    kk.nail(-t, -0.040, 0.022, 'x', 0.0045);
    kk.nail(-t, -0.115, -0.022, 'x', 0.0045);
    k.absorb(kk, p.x, p.y, p.z, s.yaw);
  }

  /**
   * A king-post truss with real webbing, exactly as drawn on the manual cover: bottom chord,
   * two top chords running past the wall to make a 400 mm eave, king post, two diagonal webs
   * and five galvanised gusset plates.
   */
  _gTruss(k, x) {
    const half = P.TRUSS_SPAN * 0.5;                 // 2.00
    const bot = P.BEAR_Y + P.CHORD_D * 0.5;
    const apex = P.APEX_Y;
    const t = P.TRUSS_T, d = P.CHORD_D;

    k.box(MAT.lumber, t, d, P.TRUSS_SPAN, x, bot, 0, 0, 0.008);
    k.strutZY(MAT.lumber, -half, P.BEAR_Y + d, 0, apex - d * 0.4, d, t, x, 0.008);
    k.strutZY(MAT.lumber, half, P.BEAR_Y + d, 0, apex - d * 0.4, d, t, x, 0.008);
    k.box(MAT.lumber, t * 0.75, apex - P.BEAR_Y - d * 1.4, 0.08, x, (apex - d * 0.5 + P.BEAR_Y + d) * 0.5, 0, 0, 0.006);
    k.strutZY(MAT.lumber, -half * 0.5, P.BEAR_Y + d, -half * 0.30, apex - 0.36, 0.07, t * 0.75, x, 0.006);
    k.strutZY(MAT.lumber, half * 0.5, P.BEAR_Y + d, half * 0.30, apex - 0.36, 0.07, t * 0.75, x, 0.006);

    const gp = (z, y, w, h) => {
      k.plate(MAT.galv, t + 0.008, h, w, x, y, z);
      k.nail(x + t * 0.5 + 0.006, y + h * 0.25, z + w * 0.22, 'x', 0.004);
      k.nail(x + t * 0.5 + 0.006, y - h * 0.25, z - w * 0.22, 'x', 0.004);
    };
    gp(0, apex - 0.16, 0.30, 0.26);
    gp(-half + 0.14, P.BEAR_Y + 0.06, 0.26, 0.22);
    gp(half - 0.14, P.BEAR_Y + 0.06, 0.26, 0.22);
    gp(-half * 0.5, bot + 0.05, 0.24, 0.20);
    gp(half * 0.5, bot + 0.05, 0.24, 0.20);
  }

  _gRidge(k, x, y, z) {
    // A 6x8 on edge, housed 20 mm into each truss peak. The saw kerf from the Night Three cut
    // is still on the west end: a raised, slightly out-of-square face.
    k.box(MAT.lumber, P.RIDGE_L, P.RIDGE_D, P.RIDGE_W, x, y, z, 0, 0.010);
    k.box(MAT.lumber, 0.03, P.RIDGE_D * 0.96, P.RIDGE_W * 0.96, x - P.RIDGE_L * 0.5 - 0.010, y + 0.004, z, 0.035, 0.004);
    for (let i = 0; i < 4; i++) {
      k.bolt(x - 1.8 + i * 1.2, y, z + P.RIDGE_W * 0.5, 0.28, 0.010, 'z');
    }
  }

  _gPin(k, s) {
    const p = s.position;
    const vertical = Math.abs(s._dir[1]) > 0.5;
    k.cyl(MAT.rust, 0.011, 0.011, 0.030, p.x, p.y + (vertical ? 0.075 : 0), p.z + (vertical ? 0 : 0.075), 8, vertical ? null : 'z');
    k.cyl(MAT.rust, 0.006, 0.004, 0.18, p.x, p.y, p.z, 6, vertical ? null : 'z');
  }

  _gDeckCourse(k, s) {
    const p = s.position;
    const len = s._len;
    // Boards are 240 mm nominal with a 3 mm shadow gap. Two courses stop short of the hatch.
    k.box(MAT.weathered, len, P.BOARD_T, 0.234, p.x, p.y, p.z, 0, 0.004);
    const n = Math.max(2, Math.round(len / 0.80));
    for (let i = 0; i <= n; i++) {
      const x = p.x - len * 0.5 + (i / n) * len;
      k.nail(x, p.y + P.BOARD_T * 0.5, p.z - 0.075, 'y', 0.0042);
      k.nail(x, p.y + P.BOARD_T * 0.5, p.z + 0.075, 'y', 0.0042);
    }
  }

  _gHinge(k, s) {
    const p = s.position;
    const kk = new Kit();
    // A strap hinge: leaf, barrel, and a stub of the door leaf, so a missing hinge reads as a
    // gap in a row of three.
    kk.plate(MAT.rust, 0.026, 0.10, 0.005, 0, 0, -0.013);
    kk.cyl(MAT.rust, 0.011, 0.011, 0.10, 0, 0, 0, 8);
    kk.plate(MAT.rust, 0.20, 0.062, 0.005, 0.10, 0, 0.014);
    kk.nail(0.05, 0, 0.018, 'z', 0.004);
    kk.nail(0.16, 0, 0.018, 'z', 0.004);
    kk.nail(0, 0.035, -0.017, 'z', 0.004);
    k.absorb(kk, p.x, p.y, p.z, s.yaw);
  }

  _gDoor(k, s) {
    const kk = new Kit();
    this._doorLeaf(kk, P.DOOR_W, P.DOOR_H, P.DOOR_T);
    k.absorb(kk, s.position.x, s.position.y, s.position.z, s.yaw);
  }

  /** A five-plank ledged-and-braced door. The first domestic shape in the game. */
  _doorLeaf(k, w, h, t) {
    const planks = 5;
    const pw = w / planks;
    for (let i = 0; i < planks; i++) {
      k.box(MAT.weathered, pw - 0.004, h, t, -w * 0.5 + pw * (i + 0.5), 0, 0, 0, 0.005);
    }
    // Z-bracing: two ledges and the diagonal that stops it racking.
    k.box(MAT.weathered, w - 0.03, 0.13, 0.026, 0, h * 0.5 - 0.22, -t * 0.5 - 0.013, 0, 0.005);
    k.box(MAT.weathered, w - 0.03, 0.13, 0.026, 0, -h * 0.5 + 0.22, -t * 0.5 - 0.013, 0, 0.005);
    const dz = (h * 0.5 - 0.22) - (-h * 0.5 + 0.22);
    const dLen = Math.hypot(w - 0.10, dz);
    const gd = chamferBox(dLen, 0.11, 0.024, 0.005);
    gd.rotateZ(Math.atan2(dz, w - 0.10));
    gd.translate(0, 0, -t * 0.5 - 0.013);
    k.push(MAT.weathered, gd);
    for (let i = 0; i < planks; i++) {
      const x = -w * 0.5 + pw * (i + 0.5);
      k.nail(x, h * 0.5 - 0.22, t * 0.5, 'z', 0.0045);
      k.nail(x, -h * 0.5 + 0.22, t * 0.5, 'z', 0.0045);
    }
    // Thumb latch and a wrought handle.
    k.plate(MAT.rust, 0.10, 0.05, 0.008, w * 0.5 - 0.10, 0.02, t * 0.5 + 0.005);
    k.cyl(MAT.rust, 0.010, 0.010, 0.13, w * 0.5 - 0.13, -0.03, t * 0.5 + 0.030, 6, 'x');
  }

  _gWallPanel(k, s) {
    const p = s.position;
    // 4.80 x 2.40 of shiplap sheathing — the one part in the game that needs two people.
    const rows = 12;
    for (let i = 0; i < rows; i++) {
      const y = p.y - 1.20 + (i + 0.5) * (2.40 / rows);
      k.box(MAT.lumber, 4.80, (2.40 / rows) - 0.004, 0.050, p.x, y, p.z, 0, 0.005);
      for (let j = 0; j < 7; j++) k.nail(p.x - 2.20 + j * 0.733, y, p.z - 0.026, 'z', 0.0042);
    }
    // The rough opening for the north window, framed out of the panel: head, sill and jambs.
    const wx = -2.20, wy = p.y + 0.42;
    k.box(MAT.lumber, P.WIN_W + 0.14, 0.09, 0.054, wx, wy + P.WIN_H * 0.5 + 0.05, p.z - 0.004, 0, 0.005);
    k.box(MAT.lumber, P.WIN_W + 0.14, 0.06, 0.054, wx, wy - P.WIN_H * 0.5 - 0.04, p.z - 0.004, 0, 0.005);
    k.box(MAT.lumber, 0.07, P.WIN_H, 0.054, wx - P.WIN_W * 0.5 - 0.035, wy, p.z - 0.004, 0, 0.005);
    k.box(MAT.lumber, 0.07, P.WIN_H, 0.054, wx + P.WIN_W * 0.5 + 0.035, wy, p.z - 0.004, 0, 0.005);
  }

  _gBatten(k, s) {
    const p = s.position;
    const side = p.z < 0 ? -1 : 1;
    const g = chamferBox(s._len, 0.06, 0.10, 0.005);
    g.rotateX(side * ROOF_A);
    g.translate(p.x, p.y, p.z);
    k.push(MAT.lumber, g);
    const n = Math.max(2, Math.round(s._len / 0.96));
    for (let i = 0; i <= n; i++) k.nail(p.x - s._len * 0.5 + (i / n) * s._len, p.y + 0.04, p.z, 'y', 0.004);
  }

  _gTinPanel(k, s) {
    const p = s.position;
    // The bundle you carried becomes a 1.60 m course of corrugated sheet: from 100 mm past the
    // ridge line down to a 180 mm drip over the eave, laid 40 mm proud of the purlins.
    const side = p.z < 0 ? -1 : 1;
    const r0 = -0.10, r1 = ROOF_RUN + 0.18;           // horizontal run the sheet covers
    const len = Math.hypot(r1 - r0, (r1 - r0) * Math.tan(ROOF_A));
    const g = corrugatedGeo(1.60, len, 0.007, 0.078, 0.013);
    g.rotateX(side * ROOF_A);
    const zc = side * (r0 + r1) * 0.5;
    g.translate(p.x, roofY(zc) + 0.070 * Math.cos(ROOF_A), zc - side * 0.070 * Math.sin(ROOF_A));
    k.push(MAT.tin, g);
    // Ring-shank roofing nails, one per crest, along the two purlin lines.
    for (let i = 0; i < 5; i++) {
      const x = p.x - 0.64 + i * 0.32;
      for (const t of [0.34, 0.68]) {
        const z = side * ROOF_RUN * t;
        k.nail(x, roofY(z) + 0.048, z, 'y', 0.0048);
      }
    }
  }

  _gFitting(k, s) {
    const p = s.position;
    if (s.id === 'SNK-01') {
      // The only white thing. A cast enamel basin on a plank plinth, under the window.
      k.box(MAT.concrete, 0.62, 0.34, 0.46, p.x, p.y, p.z, 0, 0.020);
      k.box(MAT.concrete, 0.54, 0.06, 0.38, p.x, p.y + 0.15, p.z, 0, 0.014);
      k.box(MAT.weathered, 0.70, 0.76, 0.50, p.x, p.y - 0.55, p.z, 0, 0.008);
      k.cyl(MAT.galv, 0.014, 0.014, 0.24, p.x, p.y + 0.30, p.z - 0.17, 8);
      k.cyl(MAT.galv, 0.012, 0.012, 0.12, p.x, p.y + 0.40, p.z - 0.11, 8, 'x');
      k.cyl(MAT.galv, 0.020, 0.020, 0.30, p.x, p.y - 0.32, p.z, 8);
      return;
    }
    if (s.id === 'FLU-01') {
      k.cyl(MAT.rust, 0.080, 0.080, 2.20, p.x, p.y, p.z, 12);
      k.cyl(MAT.rust, 0.095, 0.095, 0.05, p.x, p.y - 1.05, p.z, 12);
      k.cyl(MAT.rust, 0.095, 0.095, 0.05, p.x, p.y + 0.20, p.z, 12);
      return;
    }
    // DFR-01 — the doorframe whose article number is 0000-000. It is built out of what he had:
    // jambs, a head, a threshold, and four pencil marks at 91, 108, 124 and 141 cm.
    const kk = new Kit();
    kk.box(MAT.weathered, 0.10, P.DOOR_H + 0.10, 0.14, 0, 0.02, -(P.DOOR_W * 0.5 + 0.05), 0, 0.006);
    kk.box(MAT.weathered, 0.10, P.DOOR_H + 0.10, 0.14, 0, 0.02, (P.DOOR_W * 0.5 + 0.05), 0, 0.006);
    kk.box(MAT.weathered, 0.10, 0.12, P.DOOR_W + 0.20, 0, P.DOOR_H * 0.5 + 0.08, 0, 0, 0.006);
    kk.box(MAT.weathered, 0.16, 0.05, P.DOOR_W + 0.20, 0, -P.DOOR_H * 0.5 - 0.02, 0, 0, 0.008);
    for (const cm of [0.91, 1.08, 1.24, 1.41]) {
      kk.plate(MAT.rust, 0.0015, 0.0035, 0.055, 0.051, cm - P.DOOR_H * 0.5 - 0.04, -(P.DOOR_W * 0.5 + 0.05));
    }
    k.absorb(kk, p.x, p.y, p.z, s.yaw);
  }

  _gChairPiece(k, s) {
    const p = s.position;
    const kScale = s.group.endsWith('B') ? 0.62 : 1.0;
    const m = MAT.weathered;
    const id = s.id;
    if (id.endsWith('-1')) {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        k.box(m, 0.045 * kScale, 0.44 * kScale, 0.045 * kScale, p.x + sx * 0.17 * kScale, p.y, p.z + sz * 0.16 * kScale, 0, 0.004);
      }
      for (const sz of [-1, 1]) k.box(m, 0.36 * kScale, 0.03 * kScale, 0.028 * kScale, p.x, p.y - 0.13 * kScale, p.z + sz * 0.16 * kScale, 0, 0.003);
    } else if (id.endsWith('-2')) {
      k.box(m, 0.42 * kScale, 0.038 * kScale, 0.40 * kScale, p.x, p.y, p.z, 0, 0.006);
      for (let i = 0; i < 3; i++) k.nail(p.x - 0.14 * kScale + i * 0.14 * kScale, p.y + 0.02 * kScale, p.z + 0.16 * kScale, 'y', 0.0035);
    } else if (id.endsWith('-3')) {
      k.box(m, 0.038 * kScale, 0.52 * kScale, 0.042 * kScale, p.x, p.y, p.z - 0.18 * kScale, 0, 0.004);
      k.box(m, 0.038 * kScale, 0.52 * kScale, 0.042 * kScale, p.x, p.y, p.z + 0.18 * kScale, 0, 0.004);
      for (let i = 0; i < 3; i++) {
        k.box(m, 0.024 * kScale, 0.075 * kScale, 0.38 * kScale, p.x, p.y + (i - 1) * 0.14 * kScale, p.z, 0, 0.004);
      }
    } else {
      for (const sz of [-1, 1]) {
        k.box(m, 0.40 * kScale, 0.035 * kScale, 0.055 * kScale, p.x + 0.02 * kScale, p.y, p.z + sz * 0.20 * kScale, 0, 0.005);
        k.box(m, 0.035 * kScale, 0.17 * kScale, 0.045 * kScale, p.x + 0.19 * kScale, p.y - 0.09 * kScale, p.z + sz * 0.20 * kScale, 0, 0.004);
      }
    }
  }

  // ---- dressing -------------------------------------------------------------------------------

  /**
   * `suppressed` is a second, independent gate on a dressing node, for state that is not "a join
   * got installed" — currently only the county stake, which is present from before the first pier
   * and leaves when the player pulls it. `_rebuild()` ANDs it with the `requires` test, so it
   * cannot be undone by the next rebuild the way a bare `node.visible` write would be.
   */
  _dress(id, requires, fn, suppressed = false) {
    const k = new Kit();
    fn(k);
    if (!k.buckets.size) { k.dispose(); return; }
    this._node(`dress:${id}`, k, { requires, visible: (!requires || !requires.length) && !suppressed });
    this._dressing.push({ id: `dress:${id}`, requires: requires ?? [], suppressed });
  }

  _buildDressing() {
    const T = this._tierIdx;

    // --- the site itself: always present, from before the first pier
    this._dress('pad', null, (k) => this._gPad(k));
    this._dress('lantern-post', null, (k) => this._gLanternPost(k));
    // The obstruction pair: one standing in the hole, one lying beside it. Exactly one is drawn.
    this._dress('county-stake', null, (k) => this._gCountyStake(k));
    this._dress('county-stake-pulled', null, (k) => this._gCountyStakePulled(k), true);

    // --- floor frame: the joists arrive with the platform they bear on (keyart-site.png)
    this._dress('joists-w', ['S-01', 'S-05', 'S-06'], (k) => this._gJoists(k, -1, T));
    this._dress('joists-e', ['S-02', 'S-04', 'S-03'], (k) => this._gJoists(k, 1, T));

    // --- stud walls: plates, infill studs at 400 mm, headers and rough openings
    this._dress('wall-n', ['C-NW', 'C-NE', 'T-01', 'T-02'], (k) => this._gWallFrame(k, 'n'));
    this._dress('wall-s', ['C-SW', 'C-SE', 'T-04', 'T-05'], (k) => this._gWallFrame(k, 's'));
    this._dress('wall-e', ['C-NE', 'C-SE', 'T-03'], (k) => this._gWallFrame(k, 'e'));
    this._dress('wall-w', ['C-NW', 'C-SW', 'T-06'], (k) => this._gWallFrame(k, 'w'));

    // --- roof: ties per truss, then fascia and barge once the skeleton is closed
    for (let i = 0; i < 6; i++) {
      this._dress(`ties-${i + 1}`, [`TR-0${i + 1}`], (k) => {
        k.tie(TRUSS_X[i], P.BEAR_Y + 0.02, -P.HZ + 0.04, 0);
        k.tie(TRUSS_X[i], P.BEAR_Y + 0.02, P.HZ - 0.04, Math.PI);
      });
    }
    this._dress('fascia', ['TR-01', 'TR-06'], (k) => this._gFascia(k));

    // --- floor: the east half of each course fills in as the west half is nailed down
    for (let i = 0; i < 12; i++) {
      const id = `SF-${String(i + 1).padStart(2, '0')}`;
      this._dress(`deck-e-${i + 1}`, [id], (k) => this._gDeckEast(k, i));
    }
    this._dress('hatch', ['SF-05', 'SF-06'], (k) => this._gHatch(k));

    // --- fittings and glazing
    this._dress('window-n', ['SNK-01'], (k) => this._gSash(k, -2.20, P.DECK_Y + 1.62, -P.HZ - 0.085, 0));
    this._dress('window-s', ['FLU-01'], (k) => this._gSash(k, -1.40, P.DECK_Y + 1.62, P.HZ + 0.085, Math.PI));
    this._dress('flue-roof', ['FLU-01'], (k) => this._gFlueRoof(k));
    this._dress('ridge-cap', ['SHG-01', 'SHG-02', 'SHG-03', 'SHG-04', 'SHG-05'], (k) => this._gRidgeCap(k));
    this._dress('porch', ['SF-12'], (k) => this._gPorch(k));

    // --- NIGHT SEVEN. Everything STORY §6 puts in the house, arriving with the first chair leg.
    this._dress('interior', ['CHR-A-1'], (k) => this._gInterior(k));
  }

  /**
   * The plot before anything is on it: a chalked rectangle, batter boards and string lines,
   * two dry-laid pad stones under the east wall line, and the survey stake in pier one.
   */
  _gPad(k) {
    const r = new Rand(0x51a5cab ^ 0x9d1);
    const y = 0.012;
    const line = (x0, z0, x1, z1, w = 0.028) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const g = chamferBox(len, 0.004, w, 0.001);
      g.rotateY(-Math.atan2(z1 - z0, x1 - x0));
      g.translate((x0 + x1) * 0.5, y, (z0 + z1) * 0.5);
      k.push(MAT.concrete, g);
    };
    // The building line, chalked and slightly overshot at every corner. He is not a draughtsman.
    line(-P.HX - 0.16, -P.HZ, P.HX + 0.16, -P.HZ);
    line(-P.HX - 0.16, P.HZ, P.HX + 0.16, P.HZ);
    line(-P.HX, -P.HZ - 0.16, -P.HX, P.HZ + 0.16);
    line(P.HX, -P.HZ - 0.16, P.HX, P.HZ + 0.16);
    line(P.CAB_E, -P.HZ - 0.10, P.CAB_E, P.HZ + 0.10, 0.020);
    line(-P.HX - 0.3, -P.HZ - 0.3, P.HX + 0.3, P.HZ + 0.3, 0.014);   // the diagonal he squared it with
    for (const [px, pz] of PIER_XZ) {
      line(px - 0.34, pz, px + 0.34, pz, 0.018);
      line(px, pz - 0.34, px, pz + 0.34, 0.018);
    }
    // Batter boards: two stakes and a cross-board at each corner, with string between them.
    const bb = (x, z, ry) => {
      k.box(MAT.lumber, 0.05, 0.80, 0.05, x - 0.30 * Math.cos(ry), 0.32, z - 0.30 * Math.sin(ry), 0, 0.004);
      k.box(MAT.lumber, 0.05, 0.80, 0.05, x + 0.30 * Math.cos(ry), 0.32, z + 0.30 * Math.sin(ry), 0, 0.004);
      k.box(MAT.lumber, 0.70, 0.09, 0.022, x, 0.66, z, ry, 0.004);
    };
    const off = 0.9;
    bb(-P.HX - off, -P.HZ - off, Math.PI * 0.25);
    bb(P.HX + off, -P.HZ - off, -Math.PI * 0.25);
    bb(P.HX + off, P.HZ + off, Math.PI * 0.25);
    bb(-P.HX - off, P.HZ + off, -Math.PI * 0.25);
    const string = (x0, z0, x1, z1, yy) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const g = chamferBox(len, 0.008, 0.008, 0.002);
      g.rotateY(-Math.atan2(z1 - z0, x1 - x0));
      g.translate((x0 + x1) * 0.5, yy, (z0 + z1) * 0.5);
      k.push(MAT.rope, g);
    };
    string(-P.HX - off - 0.2, -P.HZ, P.HX + off + 0.2, -P.HZ, 0.665);
    string(-P.HX - off - 0.2, P.HZ, P.HX + off + 0.2, P.HZ, 0.665);
    string(-P.HX, -P.HZ - off - 0.2, -P.HX, P.HZ + off + 0.2, 0.662);
    string(P.HX, -P.HZ - off - 0.2, P.HX, P.HZ + off + 0.2, 0.662);

    // The two dry-laid pad stones under the east cabin wall — site prep, not a manual step.
    for (const z of [-P.HZ, P.HZ]) {
      k.box(MAT.stone, 0.44, 0.16, 0.44, P.CAB_E, 0.075, z, r.range(-0.2, 0.2), 0.020);
    }
    // The county survey stake used to be built here. It is now its own dressing node so it can be
    // taken out of the world when the player pulls it — see `_gCountyStake()`.
  }

  /**
   * STORY §1.4 — the county survey stake, driven where pier one goes. Painted, and old.
   *
   * ITS OWN NODE, DELIBERATELY. This was two lines inside `_gPad()`, merged into the shared
   * site-prep batch and therefore permanent. `BuildSystem.removeObstruction()` cleared the slot's
   * `obstruction` flag and nothing else, so after a real 1.10 s pull the post was still standing:
   * measured in the running game at y 17.055–17.975 with the seated pier's top face at 17.475 —
   * **half a metre of "removed" stake spearing straight up through the finished pier.** The
   * gameplay said cleared and the world said otherwise, on the first join of the first night.
   *
   * Split out, it is one 44-triangle node that `clearObstruction()` can switch off. Cost: one
   * extra node, no extra draw call — `_rebuild()` merges by material, and the stake shares
   * `weathered` with the pulled version that replaces it.
   */
  _gCountyStake(k) {
    k.box(MAT.weathered, 0.045, 0.92, 0.045, PIER_XZ[0][0] + 0.14, 0.44, PIER_XZ[0][1] + 0.10, 0.3, 0.004);
    k.plate(MAT.concrete, 0.05, 0.16, 0.006, PIER_XZ[0][0] + 0.14, 0.80, PIER_XZ[0][1] + 0.128, 0.3);
  }

  /**
   * The same stake, pulled and dropped where a man standing over the hole would toss it: clear of
   * the slot, off-square, lying on its side. Hidden until the pull.
   *
   * The game never says a word (§17), so the only way the player learns their 1.10 s of holding E
   * did something permanent is to SEE the thing that was in the way now lying beside the hole.
   * That is the same grammar as the red mark: state is shown on the object, never written down.
   */
  _gCountyStakePulled(k) {
    const [px, pz] = PIER_XZ[0];
    const x = px + 0.60, z = pz + 0.34, yaw = 1.02;
    // +X is the member's length axis; rotateY(yaw) sends it to (cos yaw, 0, -sin yaw).
    const g = chamferBox(0.92, 0.045, 0.045, 0.004);
    g.rotateZ(0.05);                       // one end still proud of the dirt
    g.rotateY(yaw);
    g.translate(x, 0.026, z);
    k.push(MAT.weathered, g);
    // The concrete tag, now face down at the far end.
    const t = chamferBox(0.16, 0.006, 0.05, 0.0025);
    t.rotateY(yaw);
    t.translate(x + 0.30 * Math.cos(yaw), 0.052, z - 0.30 * Math.sin(yaw));
    k.push(MAT.concrete, t);
  }

  /** The post the lantern hangs on. It is the first thing he put in the ground. keyart-site.png. */
  _gLanternPost(k) {
    const x = -P.HX - 0.55, z = -P.HZ - 0.35;
    k.box(MAT.lumber, 0.16, 2.60, 0.16, x, 1.30, z, 0.06, 0.010);
    k.cyl(MAT.rust, 0.010, 0.010, 0.34, x + 0.16, 2.46, z, 8, 'x');
    k.cyl(MAT.rust, 0.008, 0.008, 0.14, x + 0.31, 2.39, z, 8);
    k.cyl(MAT.rust, 0.022, 0.014, 0.05, x + 0.31, 2.31, z, 8);
    k.box(MAT.rust, 0.05, 0.03, 0.05, x + 0.31, 2.34, z, 0, 0.004);
    // A nail with three hooks on it. Everything a carpenter owns ends up on one.
    for (let i = 0; i < 3; i++) k.cyl(MAT.rust, 0.006, 0.006, 0.09, x + 0.09, 1.70 - i * 0.22, z, 6, 'x');
  }

  /** 2x10 joists at 400 mm centres, flush in galvanised hangers, plus mid-span solid blocking. */
  _gJoists(k, side, tier) {
    const x0 = side < 0 ? -P.HX + P.SILL : 0;
    const x1 = side < 0 ? 0 : P.HX - P.SILL;
    const y = P.DECK_Y - P.JOIST_D * 0.5;
    const clear = P.HZ * 2 - P.SILL;
    const n = Math.max(2, Math.floor((x1 - x0) / P.JOIST_PITCH));
    const step = (x1 - x0) / n;
    const hangerEvery = tier >= 2 ? 1 : 3;
    for (let i = 0; i <= n; i++) {
      const x = x0 + i * step;
      if (Math.abs(x) < 0.02 && side > 0) continue;              // the splice joist is shared
      k.box(MAT.lumber, P.JOIST_T, P.JOIST_D, clear, x, y, 0, 0, 0.006);
      if (i % hangerEvery === 0) {
        k.hanger(x, y, -clear * 0.5 + 0.03, P.JOIST_T, P.JOIST_D, 0, tier >= 2);
        k.hanger(x, y, clear * 0.5 - 0.03, P.JOIST_T, P.JOIST_D, Math.PI, tier >= 2);
      }
      // Solid blocking at mid-span, staggered so you can nail both sides. Real, and it reads.
      if (i < n) {
        const bz = (i % 2 === 0) ? 0.06 : -0.06;
        k.box(MAT.lumber, step - P.JOIST_T, P.JOIST_D * 0.92, P.JOIST_T, x + step * 0.5, y, bz, 0, 0.005);
      }
    }
    // Rim joist on the two long walls, sat on the sill, tying the ends.
    for (const z of [-P.HZ + P.SILL * 0.5, P.HZ - P.SILL * 0.5]) {
      k.box(MAT.lumber, x1 - x0, P.JOIST_D, 0.05, (x0 + x1) * 0.5, y, z, 0, 0.005);
    }
  }

  /**
   * A stud wall: bottom plate, studs at 400 mm centres, a doubled top plate, and a real rough
   * opening — king studs, jack studs, a doubled header and cripples over it. This is the thing
   * on the manual cover and it is why the joke works.
   */
  _gWallFrame(k, side) {
    const isNS = side === 'n' || side === 's';
    const z = side === 'n' ? -P.HZ : side === 's' ? P.HZ : 0;
    const x = side === 'e' ? P.CAB_E : side === 'w' ? P.CAB_W : 0;
    const len = isNS ? (P.CAB_E - P.CAB_W) : (P.HZ * 2);
    const c0 = isNS ? P.CAB_W : -P.HZ;
    const ry = isNS ? 0 : Math.PI / 2;
    const yBot = P.DECK_Y + 0.035;
    const yTop = P.DECK_Y + P.POST_H;
    const put = (w, h, d, u, yy, off = 0) => {
      if (isNS) k.box(MAT.lumber, w, h, d, u, yy, z + off, 0, 0.006);
      else k.box(MAT.lumber, d, h, w, x + off, yy, u, 0, 0.006);
    };
    // plates
    put(len, 0.07, P.STUD_D, isNS ? (P.CAB_W + P.CAB_E) * 0.5 : 0, yBot);
    put(len, 0.07, P.STUD_D, isNS ? (P.CAB_W + P.CAB_E) * 0.5 : 0, yTop + 0.035);
    put(len - 0.30, 0.07, P.STUD_D, isNS ? (P.CAB_W + P.CAB_E) * 0.5 : 0, yTop + 0.105);

    // the rough opening for this wall
    let ro = null;
    if (side === 'n') ro = { c: -2.20, w: P.WIN_W, y0: P.DECK_Y + 1.19, y1: P.DECK_Y + 2.05 };
    else if (side === 's') ro = { c: -1.40, w: P.WIN_W, y0: P.DECK_Y + 1.19, y1: P.DECK_Y + 2.05 };
    else if (side === 'e') ro = { c: -0.50, w: P.DOOR_W + 0.05, y0: P.DECK_Y, y1: P.DECK_Y + P.DOOR_H + 0.06 };

    const nStud = Math.max(2, Math.round(len / P.STUD_PITCH));
    for (let i = 1; i < nStud; i++) {
      const u = c0 + i * (len / nStud);
      const inRO = ro && Math.abs(u - ro.c) < ro.w * 0.5 + 0.02;
      if (inRO) {
        // cripples above the header, and below the rough sill on a window
        put(P.STUD_T, Math.max(0.06, yTop - ro.y1 - 0.10), P.STUD_D, u, (yTop + ro.y1 + 0.10) * 0.5);
        if (ro.y0 > P.DECK_Y + 0.20) put(P.STUD_T, ro.y0 - yBot - 0.10, P.STUD_D, u, (ro.y0 + yBot) * 0.5);
        continue;
      }
      put(P.STUD_T, P.POST_H - 0.14, P.STUD_D, u, (yBot + yTop) * 0.5 + 0.02);
    }
    if (ro) {
      for (const s2 of [-1, 1]) {
        const u = ro.c + s2 * (ro.w * 0.5 + P.STUD_T * 0.5);
        put(P.STUD_T, P.POST_H - 0.14, P.STUD_D, u, (yBot + yTop) * 0.5 + 0.02);           // king
        put(P.STUD_T, ro.y1 - ro.y0, P.STUD_D, u - s2 * P.STUD_T, (ro.y0 + ro.y1) * 0.5);  // jack
      }
      // doubled header
      put(ro.w + P.STUD_T * 2, 0.14, P.STUD_D * 0.48, ro.c, ro.y1 + 0.07, -P.STUD_D * 0.25);
      put(ro.w + P.STUD_T * 2, 0.14, P.STUD_D * 0.48, ro.c, ro.y1 + 0.07, P.STUD_D * 0.25);
      if (ro.y0 > P.DECK_Y + 0.20) put(ro.w, 0.07, P.STUD_D, ro.c, ro.y0 - 0.035);          // rough sill
    }
  }

  _gFascia(k) {
    const eave = ROOF_RUN;
    const cx = (P.CAB_W + P.CAB_E) * 0.5;
    // Fascia along both eaves, hung off the rafter tails.
    for (const s of [-1, 1]) {
      k.box(MAT.weathered, P.RIDGE_L + 0.34, 0.19, 0.028, cx, P.BEAR_Y - 0.075, s * (eave + 0.026), 0, 0.005);
    }
    // Barge boards up all four gable rakes: eave corner to apex, at the true pitch.
    for (const gx of [P.CAB_W - 0.11, P.CAB_E + 0.11]) {
      for (const s of [-1, 1]) {
        k.strutZY(MAT.weathered, s * (eave + 0.06), P.BEAR_Y - 0.05, 0, P.APEX_Y + 0.02, 0.19, 0.028, gx, 0.005);
      }
    }
    // Rafter tails: a short block under each truss end, so the eave has depth in silhouette.
    for (let i = 0; i < 6; i++) {
      for (const s of [-1, 1]) {
        k.box(MAT.lumber, P.TRUSS_T, 0.10, 0.30, TRUSS_X[i], P.BEAR_Y - 0.06, s * (eave - 0.15), 0, 0.006);
      }
    }
  }

  _gDeckEast(k, i) {
    const short = (i === 4 || i === 5);
    const z = -P.HZ + 0.12 + i * 0.24;
    const x0 = short ? P.HATCH_X1 : (P.CAB_W + 2.44);
    const x1 = P.CAB_E - 0.02;
    if (x1 - x0 < 0.05) return;
    k.box(MAT.weathered, x1 - x0, P.BOARD_T, 0.234, (x0 + x1) * 0.5, P.DECK_Y + P.BOARD_T * 0.5, z, 0, 0.004);
    const n = Math.max(2, Math.round((x1 - x0) / 0.80));
    for (let j = 0; j <= n; j++) {
      const x = x0 + (j / n) * (x1 - x0);
      k.nail(x, P.DECK_Y + P.BOARD_T * 0.5, z - 0.075, 'y', 0.0042);
      k.nail(x, P.DECK_Y + P.BOARD_T * 0.5, z + 0.075, 'y', 0.0042);
    }
  }

  /** The crawlspace hatch the two short courses stop at: a trimmed opening and a lift-out lid. */
  _gHatch(k) {
    const z0 = -P.HZ + 0.12 + 4 * 0.24 - 0.12, z1 = -P.HZ + 0.12 + 5 * 0.24 + 0.12;
    const y = P.DECK_Y + 0.005;
    k.box(MAT.lumber, P.HATCH_X1 - P.HATCH_X0, 0.05, 0.05, (P.HATCH_X0 + P.HATCH_X1) * 0.5, y, z0, 0, 0.004);
    k.box(MAT.lumber, P.HATCH_X1 - P.HATCH_X0, 0.05, 0.05, (P.HATCH_X0 + P.HATCH_X1) * 0.5, y, z1, 0, 0.004);
    k.box(MAT.lumber, 0.05, 0.05, z1 - z0, P.HATCH_X0, y, (z0 + z1) * 0.5, 0, 0.004);
    k.box(MAT.lumber, 0.05, 0.05, z1 - z0, P.HATCH_X1, y, (z0 + z1) * 0.5, 0, 0.004);
    k.cyl(MAT.rust, 0.026, 0.026, 0.010, (P.HATCH_X0 + P.HATCH_X1) * 0.5, y + 0.03, (z0 + z1) * 0.5, 8);
  }

  /** A six-lite sash with dirty glass. Two stiles, two rails, one mullion, two muntins. */
  _gSash(k, x, y, z, ry) {
    const kk = new Kit();
    const w = P.WIN_W - 0.06, h = P.WIN_H - 0.06, t = 0.042;
    kk.box(MAT.weathered, 0.055, h, t, -w * 0.5 + 0.0275, 0, 0, 0, 0.004);
    kk.box(MAT.weathered, 0.055, h, t, w * 0.5 - 0.0275, 0, 0, 0, 0.004);
    kk.box(MAT.weathered, w, 0.055, t, 0, h * 0.5 - 0.0275, 0, 0, 0.004);
    kk.box(MAT.weathered, w, 0.070, t, 0, -h * 0.5 + 0.035, 0, 0, 0.004);
    kk.box(MAT.weathered, 0.028, h - 0.10, t * 0.8, 0, 0, 0, 0, 0.003);
    for (const yy of [-h / 6, h / 6]) kk.box(MAT.weathered, w - 0.10, 0.026, t * 0.8, 0, yy, 0, 0, 0.003);
    kk.box(MAT.glass, w - 0.10, h - 0.11, 0.004, 0, 0, -0.004, 0, 0.001);
    // A galvanised drip cap over it, because it rains here every night but one.
    kk.plate(MAT.galv, w + 0.16, 0.005, 0.075, 0, h * 0.5 + 0.045, -0.030);
    k.absorb(kk, x, y, z, ry);
  }

  _gFlueRoof(k) {
    const x = -2.60, z = 0.90;
    const yRoof = roofY(z);
    k.plate(MAT.galv, 0.46, 0.006, 0.52, x, yRoof + 0.090, z, 0);
    k.cyl(MAT.rust, 0.082, 0.082, 1.10, x, yRoof + 0.60, z, 12);
    k.cyl(MAT.rust, 0.098, 0.098, 0.05, x, yRoof + 0.14, z, 12);
    k.cyl(MAT.rust, 0.13, 0.13, 0.02, x, yRoof + 1.16, z, 12);
    for (let i = 0; i < 3; i++) {
      const a = i * (TAU / 3);
      k.box(MAT.rust, 0.012, 0.10, 0.012, x + Math.cos(a) * 0.085, yRoof + 1.10, z + Math.sin(a) * 0.085, 0, 0.002);
    }
    k.cyl(MAT.rust, 0.11, 0.11, 0.012, x, yRoof + 1.22, z, 12);
  }

  _gRidgeCap(k) {
    const cx = (P.CAB_W + P.CAB_E) * 0.5;
    const zc = 0.22;
    for (const side of [-1, 1]) {
      const g = corrugatedGeo(P.RIDGE_L + 0.24, 0.50, 0.006, 0.070, 0.008);
      g.rotateX(side * ROOF_A);
      g.translate(cx, roofY(zc) + 0.105 * Math.cos(ROOF_A), side * zc - side * 0.105 * Math.sin(ROOF_A));
      k.push(MAT.tin, g);
    }
    for (let i = 0; i < 7; i++) {
      const x = P.CAB_W + 0.2 + i * ((P.RIDGE_L - 0.4) / 6);
      for (const side of [-1, 1]) k.nail(x, roofY(0.40) + 0.115, side * 0.40, 'y', 0.005);
    }
  }

  /** STORY §6 Night Seven — two posts, a beam, four deck boards, and a step. */
  _gPorch(k) {
    const y = P.DECK_Y + P.BOARD_T * 0.5;
    for (let i = 0; i < 4; i++) {
      const z = -P.HZ + 0.45 + i * 0.78;
      k.box(MAT.weathered, P.HX - P.CAB_E - 0.06, P.BOARD_T, 0.74, (P.CAB_E + P.HX) * 0.5, y, z, 0, 0.004);
    }
    for (const z of [-P.HZ + 0.20, P.HZ - 0.20]) {
      k.box(MAT.lumber, 0.14, 2.34, 0.14, P.HX - 0.16, P.DECK_Y + 1.17, z, 0, 0.008);
      k.plate(MAT.galv, 0.17, 0.006, 0.17, P.HX - 0.16, P.DECK_Y + 0.003, z);
      // knee brace to the beam
      const gb = chamferBox(0.50, 0.09, 0.09, 0.006);
      gb.rotateZ(-Math.PI / 4);
      gb.translate(P.HX - 0.34, P.DECK_Y + 2.16, z);
      k.push(MAT.lumber, gb);
    }
    k.box(MAT.lumber, 0.16, 0.22, P.HZ * 2 - 0.10, P.HX - 0.16, P.DECK_Y + 2.44, 0, 0, 0.008);
    // The step down to the ground.
    k.box(MAT.weathered, 0.34, 0.05, 1.10, P.HX + 0.22, P.DECK_Y - 0.24, -0.30, 0, 0.005);
    k.box(MAT.lumber, 0.10, 0.34, 0.10, P.HX + 0.22, P.DECK_Y - 0.44, -0.78, 0, 0.006);
    k.box(MAT.lumber, 0.10, 0.34, 0.10, P.HX + 0.22, P.DECK_Y - 0.44, 0.18, 0, 0.006);
  }

  /**
   * The interior, per STORY §6 Night Seven: the hearth stone, six chimney courses, the stove,
   * the table, the shelf, the bunk. Every surface correct. Nothing speaks.
   */
  _gInterior(k) {
    const y0 = P.DECK_Y + P.BOARD_T;
    // The hearth stone — 140 kg, and he dragged it from the shoreline.
    k.box(MAT.stone, 1.10, 0.16, 0.90, P.CAB_W + 0.72, y0 + 0.08, -0.10, 0.02, 0.022);
    // Six chimney courses up the west wall, each one slightly out of line with the last.
    const r = new Rand(0x51a5cab ^ 0x7ea77);
    for (let i = 0; i < 6; i++) {
      k.box(MAT.stone, 0.62, 0.19, 0.86 - i * 0.03, P.CAB_W + 0.34 + r.range(-0.012, 0.012), y0 + 0.16 + 0.19 * (i + 0.5), -0.10 + r.range(-0.015, 0.015), r.range(-0.02, 0.02), 0.018);
    }
    // The stove: a plate box on four legs with a door and a flue collar.
    k.box(MAT.rust, 0.52, 0.44, 0.62, -2.60, y0 + 0.46, 0.90, 0, 0.010);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      k.box(MAT.rust, 0.04, 0.24, 0.04, -2.60 + sx * 0.21, y0 + 0.12, 0.90 + sz * 0.26, 0, 0.004);
    }
    k.plate(MAT.rust, 0.008, 0.28, 0.34, -2.60 - 0.264, y0 + 0.44, 0.90, 0);
    k.cyl(MAT.rust, 0.036, 0.036, 0.06, -2.60 - 0.30, y0 + 0.44, 0.90, 8, 'x');
    k.cyl(MAT.rust, 0.088, 0.088, 0.10, -2.60, y0 + 0.72, 0.90, 12);
    // The table, and the shelf over the sink, and a bunk against the south wall.
    k.box(MAT.weathered, 1.20, 0.045, 0.72, -0.60, y0 + 0.74, -0.20, 0, 0.006);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      k.box(MAT.weathered, 0.06, 0.72, 0.06, -0.60 + sx * 0.52, y0 + 0.36, -0.20 + sz * 0.28, 0, 0.005);
    }
    k.box(MAT.weathered, 1.30, 0.028, 0.20, -2.20, y0 + 1.62, -P.HZ + 0.16, 0, 0.004);
    for (const bx of [-2.70, -1.70]) k.box(MAT.weathered, 0.05, 0.16, 0.19, bx, y0 + 1.52, -P.HZ + 0.16, 0, 0.004);
    k.box(MAT.weathered, 1.90, 0.05, 0.78, -1.30, y0 + 0.44, P.HZ - 0.45, 0, 0.006);
    for (const sx of [-1, 1]) {
      k.box(MAT.weathered, 0.07, 0.44, 0.07, -1.30 + sx * 0.90, y0 + 0.22, P.HZ - 0.78, 0, 0.005);
      k.box(MAT.weathered, 0.07, 0.44, 0.07, -1.30 + sx * 0.90, y0 + 0.22, P.HZ - 0.12, 0, 0.005);
    }
  }

  // =============================================================================================
  // PART MESHES — what you carry. Same builders, so the thing in your hands is the thing that
  // ends up in the wall.
  // =============================================================================================

  _partBuckets(partId) {
    let cached = this._partBucketCache.get(partId);
    if (cached) return cached;
    const k = new Kit();
    this._buildPart(k, partId);
    cached = new Map();
    for (const [mat, list] of k.buckets) {
      if (!list.length) continue;
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!merged) continue;
      if (list.length > 1) for (const g of list) g.dispose();
      cached.set(mat, merged);
    }
    k.buckets.clear();
    this._partBucketCache.set(partId, cached);
    return cached;
  }

  _ghostGeometry(partId) {
    let g = this._partGhostCache.get(partId);
    if (g) return g;
    const buckets = this._partBuckets(partId);
    const list = [...buckets.values()];
    if (!list.length) return null;
    g = list.length === 1 ? list[0].clone() : mergeGeometries(list.map((x) => x.clone()), false);
    if (!g) return null;
    this._partGhostCache.set(partId, g);
    return g;
  }

  /** Every carryable article, built at the origin with its length along +X (or +Y for uprights). */
  _buildPart(k, id) {
    const L = MAT.lumber, W = MAT.weathered;
    switch (id) {
      case 'PIER': this._gPier(k, 0, 0, 0); break;
      case 'SILL': case 'BEAM': case 'BEAM_SHORT': {
        const len = id === 'BEAM_SHORT' ? 2.60 : 3.20;
        k.box(L, len - P.SILL, P.SILL, P.SILL, -P.SILL * 0.5, 0, 0, 0, 0.012);
        k.box(L, P.SILL, P.SILL * 0.5, P.SILL, (len - P.SILL) * 0.5, -P.SILL * 0.25, 0, 0, 0.010);
        // the pencil stamp that tells you which way round it goes, at 2.2 m and no further
        k.plate(MAT.rust, 0.10, 0.0015, 0.004, -len * 0.30, P.SILL * 0.5, 0);
        break;
      }
      case 'POST': this._gPost(k, 0, 0, 0); break;
      case 'STUD':
        k.box(L, P.STUD_T, P.POST_H, P.STUD_D, 0, 0, 0, 0, 0.006);
        k.plate(MAT.rust, 0.0015, 0.004, P.STUD_D * 0.7, P.STUD_T * 0.5, 0.28, 0);
        break;
      case 'JOIST':
        k.box(L, 2.76, P.JOIST_D, P.JOIST_T, 0, 0, 0, 0, 0.006);
        break;
      case 'TRUSS': {
        const kk = new Kit();
        this._gTruss(kk, 0);
        for (const [m, list] of kk.buckets) for (const g of list) g.translate(0, -(P.BEAR_Y + P.TRUSS_RISE * 0.42), 0);
        k.absorb(kk, 0, 0, 0, 0);
        break;
      }
      case 'RIDGE':
        // It arrives 5.14 m long. That is the whole of Night Three.
        k.box(L, 5.14, P.RIDGE_D, P.RIDGE_W, 0, 0, 0, 0, 0.010);
        k.plate(MAT.rust, 0.004, P.RIDGE_D * 0.9, P.RIDGE_W + 0.004, 5.14 * 0.5 - 0.34, 0, 0);
        break;
      case 'PANEL': case 'PANEL_N': {
        const len = id === 'PANEL_N' ? 4.80 : 1.20;
        const h = 2.40, rows = id === 'PANEL_N' ? 12 : 6;
        for (let i = 0; i < rows; i++) {
          k.box(L, len, (h / rows) - 0.004, 0.05, 0, -h * 0.5 + (i + 0.5) * (h / rows), 0, 0, 0.005);
        }
        break;
      }
      case 'BOARD_24': k.box(W, 2.40, P.BOARD_T, 0.234, 0, 0, 0, 0, 0.004); break;
      case 'BOARD_12': case 'SISTERING': k.box(W, 1.20, P.BOARD_T, 0.19, 0, 0, 0, 0, 0.004); break;
      case 'BATTEN': k.box(L, 2.80, 0.06, 0.10, 0, 0, 0, 0, 0.005); break;
      case 'SHINGLE': {
        // A strapped bundle of corrugated sheet — a sandbag at 25 m, a roof when you open it.
        for (let i = 0; i < 5; i++) {
          const g = corrugatedGeo(0.60, 0.40, 0.006, 0.076, 0.010);
          g.translate(0, -0.10 + i * 0.045, 0);
          k.push(MAT.tin, g);
        }
        for (const x of [-0.18, 0.18]) k.box(MAT.rope, 0.03, 0.24, 0.42, x, 0, 0, 0, 0.004);
        break;
      }
      case 'DOOR': this._doorLeaf(k, P.DOOR_W, P.DOOR_H, P.DOOR_T); break;
      case 'DOORFRAME': {
        k.box(W, 0.10, P.DOOR_H + 0.10, 0.14, 0, 0, -(P.DOOR_W * 0.5 + 0.05), 0, 0.006);
        k.box(W, 0.10, P.DOOR_H + 0.10, 0.14, 0, 0, (P.DOOR_W * 0.5 + 0.05), 0, 0.006);
        k.box(W, 0.10, 0.12, P.DOOR_W + 0.20, 0, P.DOOR_H * 0.5 + 0.08, 0, 0, 0.006);
        break;
      }
      case 'SINK':
        k.box(MAT.concrete, 0.62, 0.34, 0.46, 0, 0, 0, 0, 0.020);
        k.box(MAT.concrete, 0.54, 0.06, 0.38, 0, 0.15, 0, 0, 0.014);
        k.cyl(MAT.galv, 0.020, 0.020, 0.16, 0, -0.22, 0, 8);
        break;
      case 'FLUE':
        k.cyl(MAT.rust, 0.080, 0.080, 2.20, 0, 0, 0, 12);
        k.cyl(MAT.rust, 0.095, 0.095, 0.05, 0, -1.05, 0, 12);
        break;
      case 'BRACKET': {
        const t = 0.004;
        k.plate(MAT.galv, 0.22, t, 0.075, 0.11, 0, 0);
        k.plate(MAT.galv, t, 0.150, 0.075, 0, -0.075, 0);
        k.plate(MAT.galv, 0.020, 0.006, 0.006, 0.11, t, 0);
        k.plate(MAT.galv, 0.006, 0.090, 0.006, t, -0.075, 0);
        break;
      }
      case 'GUSSET':
        k.plate(MAT.galv, 0.30, 0.26, 0.004, 0, 0, 0);
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) k.nail(sx * 0.10, sy * 0.08, 0.002, 'z', 0.004);
        break;
      case 'HINGE':
        k.plate(MAT.rust, 0.026, 0.10, 0.005, 0, 0, -0.013);
        k.cyl(MAT.rust, 0.011, 0.011, 0.10, 0, 0, 0, 8);
        k.plate(MAT.rust, 0.20, 0.062, 0.005, 0.10, 0, 0.014);
        break;
      case 'PIN':
        k.cyl(MAT.rust, 0.011, 0.011, 0.03, 0, 0.075, 0, 8);
        k.cyl(MAT.rust, 0.006, 0.004, 0.18, 0, 0, 0, 6);
        break;
      case 'FASTENER_BAG':
        k.box(W, 0.16, 0.14, 0.10, 0, 0, 0, 0, 0.010);
        k.box(MAT.rope, 0.05, 0.03, 0.05, 0, 0.08, 0, 0, 0.004);
        break;
      case 'SHIM': k.box(W, 0.14, 0.02, 0.06, 0, 0, 0, 0, 0.003); break;
      case 'TALLOW': k.cyl(MAT.galv, 0.045, 0.045, 0.10, 0, 0, 0, 10); break;
      case 'FELT': k.box(MAT.rope, 0.12, 0.012, 0.12, 0, 0, 0, 0, 0.002); break;
      case 'CHAIR_LEG': k.box(W, 0.05, 0.44, 0.05, 0, 0, 0, 0, 0.004); break;
      case 'CHAIR_SEAT': k.box(W, 0.42, 0.04, 0.40, 0, 0, 0, 0, 0.006); break;
      case 'CHAIR_BACK':
        k.box(W, 0.038, 0.52, 0.042, 0, 0, -0.18, 0, 0.004);
        k.box(W, 0.038, 0.52, 0.042, 0, 0, 0.18, 0, 0.004);
        for (let i = 0; i < 3; i++) k.box(W, 0.024, 0.075, 0.38, 0, (i - 1) * 0.14, 0, 0, 0.004);
        break;
      case 'CHAIR_ARM':
        k.box(W, 0.40, 0.035, 0.055, 0, 0, 0, 0, 0.005);
        k.box(W, 0.035, 0.17, 0.045, 0.17, -0.09, 0, 0, 0.004);
        break;
      default:
        k.box(L, 0.40, 0.20, 0.20, 0, 0, 0, 0, 0.008);
        break;
    }
  }

  // =============================================================================================
  // RENDERING — merge to one geometry per material, rebuild only when a join changes.
  // =============================================================================================

  _mat(name) {
    const m = this.ctx.systems?.get?.('Materials');
    if (m && typeof m.get === 'function' && !m.__failed) {
      const got = m.get(name);
      if (got) return got;
    }
    // Materials is optional. One owned stand-in per name, built here and disposed by dispose().
    let fb = this._fallbackMats?.get(name);
    if (!fb) {
      if (!this._fallbackMats) this._fallbackMats = new Map();
      const tint = name === MAT.galv ? 0x9aa0a3 : name === MAT.rust ? 0x7a4526
        : name === MAT.tin ? 0x7d8487 : name === MAT.stone ? 0x3b464b
          : name === MAT.concrete ? 0x3f4442 : name === MAT.glass ? 0x141b1f
            : name === MAT.weathered ? 0x6b6155 : name === MAT.rope ? 0x5a5038 : 0xa8875c;
      fb = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.72, metalness: name === MAT.galv || name === MAT.tin ? 0.9 : 0.0, name: `cabinsite-${name}` });
      this._fallbackMats.set(name, fb);
      this._ownedMat.push(fb);
    }
    return fb;
  }

  _buildMaterialMeshes() {
    if (!this.group) return;
    for (const name of Object.values(MAT)) {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), this._mat(name));
      mesh.name = `CabinSite:${name}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
      this._meshes.set(name, mesh);
    }
  }

  _buildGhost() {
    if (!this.group) return;
    // Two owned materials, built once at init. The library has no unlit overlay and the ghost
    // is UI drawn in world space, not a surface.
    this._ghostOk = new THREE.MeshBasicMaterial({
      color: 0xdfe6ec, transparent: true, opacity: 0.34, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false, name: 'cabinsite-ghost',
    });
    this._ghostBad = new THREE.MeshBasicMaterial({
      color: 0xd92b2b, transparent: true, opacity: 0.15, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false, name: 'cabinsite-ghost-blocked',
    });
    this._ownedMat.push(this._ghostOk, this._ghostBad);
    const g = new THREE.Mesh(new THREE.BufferGeometry(), this._ghostOk);
    g.name = 'CabinSite:ghost';
    g.visible = false;
    g.castShadow = false;
    g.receiveShadow = false;
    g.renderOrder = 6;
    g.userData.baseOpacity = 0.34;
    this.group.add(g);
    this._ghost = g;
  }

  /**
   * The error transform for one node: a yaw to the placed candidate, a tilt about the member's
   * transverse axis, a lift, and a push along the outward normal. Composed about the slot's own
   * anchor so the member pivots where it actually bears.
   */
  _errorMatrix(slot, rec, out) {
    const v = VISUALS[rec.visual] ?? VISUALS.flush;
    const cand = rec.candidate | 0;
    const k = Math.max(1, slot.yawCandidates | 0);
    const extraYaw = (cand % k) * (TAU / k);
    const inheritedMm = rec.offsetMm || 0;
    if (!extraYaw && v === VISUALS.flush && !inheritedMm) return null;

    const a = slot.position;
    const d = slot._dir, o = slot._out;
    _v1.set(d[0], d[1], d[2]).normalize();
    _v2.set(o[0], o[1], o[2]).normalize();
    // Transverse axis: perpendicular to both the member and its outward face.
    _v3.crossVectors(_v1, _v2);
    if (_v3.lengthSq() < 1e-6) _v3.copy(_up).cross(_v1);
    if (_v3.lengthSq() < 1e-6) _v3.set(0, 0, 1);
    _v3.normalize();

    _q1.setFromAxisAngle(_v3, v.tilt);
    _q2.setFromAxisAngle(_up, extraYaw);
    _q1.premultiply(_q2);

    _m1.makeTranslation(a.x, a.y, a.z);
    _m2.compose(_v1.set(0, 0, 0), _q1, _one);
    _m3.makeTranslation(-a.x, -a.y, -a.z);
    out.multiplyMatrices(_m1, _m2).multiply(_m3);

    _v1.set(o[0], o[1], o[2]).normalize().multiplyScalar(v.out + inheritedMm * 0.001);
    _m1.makeTranslation(_v1.x, _v1.y + v.lift, _v1.z);
    out.premultiply(_m1);
    return out;
  }

  _rebuild() {
    this._dirty = false;
    if (!this.group) return;

    for (const g of this._temp) g.dispose();
    this._temp.length = 0;

    // Dressing visibility follows the joins it hangs off.
    for (const d of this._dressing) {
      const node = this._nodes.get(d.id);
      if (!node) continue;
      let on = true;
      for (let i = 0; i < d.requires.length; i++) {
        if (!this._installed.has(d.requires[i])) { on = false; break; }
      }
      node.visible = !d.suppressed && (on || d.requires.length === 0);
    }

    const lists = this._scratchLists;
    for (const arr of lists.values()) arr.length = 0;

    const em = new THREE.Matrix4();
    this.bounds.makeEmpty();
    let members = 0;

    for (const node of this._nodes.values()) {
      let buckets = node.buckets;
      let mtx = null;

      if (node.slot) {
        const rec = this._installed.get(node.slot.id);
        if (!rec) continue;
        // A part that does not belong here is drawn as ITSELF, at the slot. A short board in a
        // long slot leaves a hole; a long board in a short slot hangs out over the hatch.
        if (rec.partId && rec.partId !== node.slot.requiredPartId) {
          const foreign = this._foreignBuckets(node.slot, rec.partId);
          if (foreign) buckets = foreign;
        }
        mtx = this._errorMatrix(node.slot, rec, em);
      } else if (!node.visible) {
        continue;
      }

      for (const [mat, geos] of buckets) {
        let arr = lists.get(mat);
        if (!arr) { arr = []; lists.set(mat, arr); }
        for (let i = 0; i < geos.length; i++) {
          if (mtx) {
            const c = geos[i].clone();
            c.applyMatrix4(mtx);
            this._temp.push(c);
            arr.push(c);
          } else {
            arr.push(geos[i]);
          }
          members++;
        }
      }
    }

    let draws = 0, tris = 0;
    for (const [name, mesh] of this._meshes) {
      const arr = lists.get(name);
      const prev = this._mergedGeo.get(name);
      if (!arr || !arr.length) {
        mesh.visible = false;
        mesh.geometry = EMPTY_GEO;
        if (prev) { prev.dispose(); this._mergedGeo.delete(name); }
        continue;
      }
      let merged = null;
      try {
        merged = arr.length === 1 ? arr[0].clone() : mergeGeometries(arr, false);
      } catch (e) {
        Log.once('cabinsite:merge', `CabinSite: merge failed for '${name}'.`, e?.message ?? e);
        merged = null;
      }
      if (!merged) { mesh.visible = false; continue; }
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      mesh.geometry = merged;
      mesh.visible = true;
      if (prev) prev.dispose();
      this._mergedGeo.set(name, merged);
      draws++;
      tris += merged.getAttribute('position').count / 3;
      if (merged.boundingBox) {
        _v1.copy(merged.boundingBox.min).add(this.center);
        _v2.copy(merged.boundingBox.max).add(this.center);
        this.bounds.expandByPoint(_v1);
        this.bounds.expandByPoint(_v2);
      }
    }
    if (this.bounds.isEmpty()) {
      this.bounds.setFromCenterAndSize(this.center, _v1.set(P.HX * 2, 0.2, P.HZ * 2));
    }

    this._stats.drawCalls = draws + (this._ghost?.visible ? 1 : 0);
    this._stats.triangles = tris;
    this._stats.members = members;

    // Anything that cares about the cabin's acoustic or navigational footprint gets a nudge.
    const ns = this.ctx.systems?.get?.('NoiseSystem');
    if (typeof ns?.invalidateBuild === 'function') { try { ns.invalidateBuild(); } catch { /* optional */ } }
  }

  /** Geometry for a part sitting in a slot it does not belong in. Cached per (slot, part). */
  _foreignBuckets(slot, partId) {
    const key = `${slot.id}|${partId}`;
    if (!this._foreign) this._foreign = new Map();
    let m = this._foreign.get(key);
    if (m) return m;
    const src = this._partBuckets(partId);
    if (!src || !src.size) return null;
    m = new Map();
    for (const [mat, geo] of src) {
      const g = geo.clone();
      if (slot.yaw) g.rotateY(slot.yaw);
      g.translate(slot.position.x, slot.position.y, slot.position.z);
      m.set(mat, [g]);
      this._ownedGeo.push(g);
    }
    this._foreign.set(key, m);
    return m;
  }

  _deriveVisual(outcome, torque) {
    if (outcome === 'wrong-part') return 'split';
    if (outcome === 'rotated') return 'proud';
    if (outcome === 'wrong-slot') return 'gapped';
    if (torque < 0.62) return 'sagging';
    if (torque < 0.85) return 'gapped';
    return 'flush';
  }

  // =============================================================================================
  // AI PERCEPT / EVENTS / PREVIEW
  // =============================================================================================

  /** §9.5 — which silhouette features exist right now, where they are and how tall they are. */
  _recomputeFeatures() {
    this._featureDirty = false;
    const spec = [
      ['piers', 0.62, 0.40],
      ['frame', P.BEAR_Y, 0.85],
      ['roof-skeleton', P.APEX_Y, 0.80],
      ['floor-door', P.DECK_Y + P.DOOR_H, 0.70],
      ['wall-north', P.DECK_Y + 2.40, 0.90],
      ['roof', P.APEX_Y + 0.30, 0.55],
    ];
    const out = this._features;
    out.length = 0;
    for (const [id, height, pale] of spec) {
      let n = 0, sx = 0, sy = 0, sz = 0;
      for (const s of this._slots) {
        if (s.feature !== id || !this._installed.has(s.id)) continue;
        n++; sx += s.px; sy += s.py; sz += s.pz;
      }
      if (!n) continue;
      // Height is what has ACTUALLY been stood up, capped by what the finished feature would be:
      // three trusses in is not yet a roofline to hide behind.
      const built = Math.max(0.3, (sy / n) - this.center.y + 0.4);
      out.push({
        id,
        position: new THREE.Vector3(sx / n, this.center.y, sz / n),
        height: Math.min(built, height),
        pale,
        minInstalled: 1,
        installed: n,
      });
    }
    return out;
  }

  _bindEvents() {
    const on = (ev, fn) => { const u = this.bus?.on?.(ev, fn); if (u) this._unsubs.push(u); };
    on('night:begin', (p) => {
      this._dirty = true;
      this._featureDirty = true;
      // A fresh Night One puts the stake back in the hole: BuildSystem rebuilds P-01 with its
      // `obstruction` set again, so the world has to agree. Only night 1 — on every later night
      // the stake stays where the player threw it.
      if ((p?.night | 0) === 1) for (const id of Object.keys(OBSTRUCTION_DRESSING)) this.restoreObstruction(id);
    });
    on('build:place', () => { this._dirty = true; this._featureDirty = true; });
    on('build:remove', (p) => { if (p?.slot?.id) this.clearInstalled(p.slot.id); });
  }

  /**
   * Screenshot-harness only. `?shot=…` (or `?build=n`) stands the cabin up to a given night so
   * the canonical shots frame the thing they are named after instead of an empty pad. Never
   * runs during play: without one of those params this returns immediately.
   */
  _applyPreview() {
    let params = null;
    try { params = new URLSearchParams(globalThis.location?.search ?? ''); } catch { return; }
    const hasShot = params.has('shot');
    const buildParam = params.get('build');
    if (!hasShot && buildParam === null) return;

    let night = buildParam !== null ? clamp(parseInt(buildParam, 10) || 0, 0, 7) : 4;
    if (!night) return;
    const shot = params.get('shot');
    if (buildParam === null && shot === 'site-wide') night = 4;

    // A representative run: mostly seated, with the four error states on show so a reviewer can
    // see all of them in one frame. Deterministic — the same frame every time.
    const wrong = {
      'S-04': { visual: 'proud', outcome: 'rotated', torque: 0.9, candidate: 1 },
      'T-02': { visual: 'sagging', outcome: 'under-fastened', torque: 0.55, candidate: 0 },
      'SF-05': { visual: 'gapped', outcome: 'wrong-slot', torque: 0.8, candidate: 0, partId: 'BOARD_24' },
      'B-03': { visual: 'split', outcome: 'wrong-part', torque: 0.5, candidate: 2 },
    };
    for (let n = 1; n <= night; n++) {
      for (const s of this._byNight[n]) {
        if (s.kind === 'freeform') continue;
        if (s.deferred || s.id === 'DFR-01') continue;
        const w = wrong[s.id];
        this.setInstalled(s.id, w?.partId ?? s.requiredPartId, w ?? { outcome: 'seated', torque: 1, visual: 'flush', candidate: 0 });
      }
    }
    Log.debug(`CabinSite: preview build to night ${night} (harness mode).`);
  }
}

/** A single empty geometry shared by every hidden material mesh — never disposed while alive. */
const EMPTY_GEO = new THREE.BufferGeometry();

export default CabinSite;
