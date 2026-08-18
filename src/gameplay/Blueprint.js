/**
 * Blueprint.js — PROCEDURAL IKEA-PARODY ASSEMBLY DIAGRAMS.
 *
 * OWNER: Build agent. Registered in main.js as the system 'Blueprint'.
 *
 * This module turns a night's build manifest into a wordless exploded axonometric that the player
 * must actually read: real 3D part definitions, projected through the dimetric 7°/42° flat-pack
 * projection, with real hidden-line removal, real explode vectors, routed arrows, hardware
 * call-outs, and a mascot who is a scale reference and a viewpoint indicator at the same time.
 *
 * Contracts honoured:
 *   ARCHITECTURE.md §3 (system shape), §5 (emits NO events — page turns have no canonical event),
 *                    §6 (seeded Rand only), §12 (zero allocation in update()).
 *   GAME_DESIGN.md  §6.8 (the seven grammars + the closed glyph set), §6.9 (missing-hardware
 *                    engine), §8.1–8.6 (API, projection, HLR, explode/arrows/packing, authorship,
 *                    the legibility invariant).
 *   STORY.md        §3 (the manual as narrator: two hands, the HANDS struct, the seven-stage
 *                    evolution, BJØRN's construction, the hero panels), §4.2 (landmark positions).
 *
 * THE ONE RULE ABOUT TEXT: the only text in the manual is article numbers, HJEM on the cover, and
 * VIK & SØN in the corner. `Script.panels[].caption` is a developer-facing description of line art
 * and is NEVER drawn. There is no narrator. If you print a caption you have shipped the worst bug
 * in the project.
 *
 * Blueprint owns geometry + layout + rasterisation of the diagram itself. `BlueprintUI.js` owns
 * the paper furniture around it (fold shadow, page-turn animation, the hand-wipe lockout) and
 * bakes `renderPanel()` into an OffscreenCanvas per STORY §3.4. Nothing here draws per frame.
 */

import { Rand, hashInt, hashStr, valueNoise2 } from '../core/Rand.js';
import { Log } from '../core/Log.js';

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 0. CONSTANTS — palette, page, projection
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/** ART_DIRECTION / the Build brief. Warm off-white paper, near-black ink, ONE accent red. */
export const PALETTE = Object.freeze({
  paper: '#f4f1e8',
  paperShade: '#ebe6d9',   // fold valley, page edge
  ink: '#16181a',
  inkSoft: '#3a3f44',      // dimension lines, tick marks
  red: '#d92b2b',
  ghost: '#16181a',        // eraser residue — same ink, drawn at ghostAlpha
  foxing: '#c9b58f',       // damp bloom on the paper, later nights
});

/** Colourblind substitutions for the accent (Script.PANEL_RULES.accentColorblind). */
const ACCENT_CB = Object.freeze({
  deuteranopia: '#0b57d0', protanopia: '#0b57d0', tritanopia: '#c2185b',
});

/**
 * Line weights in PAGE UNITS. The page is 900 units tall; at a 900 px-tall canvas one page unit
 * is one CSS pixel, so `medium` is exactly 2 px at 1x and `heavy` exactly 3 px, per the brief.
 */
export const WEIGHTS = Object.freeze({
  hairline: 1.0,   // dimension witness lines, tick marks, hatching
  thin: 1.5,       // leader lines, arrow shafts, glyph detail
  medium: 2.0,     // EVERY ordinary line in the manual
  heavy: 3.0,      // part silhouette outlines
  figure: 3.0,     // BJØRN's continuous outline
});

/** A4, 1:1.414. Page height 900 units per STORY §3.2. */
export const PAGE = Object.freeze({
  W: 636, H: 900,
  margin: 44,
  gutter: 30,
  footer: 34,      // reserved strip for the panel number + maker's mark
});

const D2R = Math.PI / 180;

/**
 * GAME_DESIGN §8.2 — dimetric 7°/42°. Verticals stay vertical; the two horizontal axes are
 * visually distinguishable, which is the whole of G1: the player matches BJØRN's viewpoint to
 * their own before they decide which side of the plot they are standing on.
 */
export const PROJ = (() => {
  const ax = [Math.cos(7 * D2R), -Math.sin(7 * D2R)];
  const ay = [0, -1];
  const az = [-Math.cos(42 * D2R), -Math.sin(42 * D2R)];
  // Rows of the 2x3 projection matrix.
  const r0 = [ax[0], ay[0], az[0]];
  const r1 = [ax[1], ay[1], az[1]];
  // The null direction of M is the view axis. r0 × r1 points toward the viewer.
  const v = [
    r0[1] * r1[2] - r0[2] * r1[1],
    r0[2] * r1[0] - r0[0] * r1[2],
    r0[0] * r1[1] - r0[1] * r1[0],
  ];
  const vl = Math.hypot(v[0], v[1], v[2]);
  const view = [v[0] / vl, v[1] / vl, v[2] / vl];
  // Pseudo-inverse M⁺ = Mᵀ(MMᵀ)⁻¹ so a screen point can be lifted back onto a 3D ray.
  const a = r0[0] * r0[0] + r0[1] * r0[1] + r0[2] * r0[2];
  const b = r0[0] * r1[0] + r0[1] * r1[1] + r0[2] * r1[2];
  const d = r1[0] * r1[0] + r1[1] * r1[1] + r1[2] * r1[2];
  const det = a * d - b * b;
  const i00 = d / det, i01 = -b / det, i11 = a / det;
  const pinv = [
    [r0[0] * i00 + r1[0] * i01, r0[0] * i01 + r1[0] * i11],
    [r0[1] * i00 + r1[1] * i01, r0[1] * i01 + r1[1] * i11],
    [r0[2] * i00 + r1[2] * i01, r0[2] * i01 + r1[2] * i11],
  ];
  return Object.freeze({ ax, ay, az, view: Object.freeze(view), pinv, r0, r1 });
})();

/** Project a metre-space point to page units at `s` units per metre. */
function projX(x, y, z, s) { return (x * PROJ.ax[0] + y * PROJ.ay[0] + z * PROJ.az[0]) * s; }
function projY(x, y, z, s) { return (x * PROJ.ax[1] + y * PROJ.ay[1] + z * PROJ.az[1]) * s; }
/** Depth toward the viewer. Larger = nearer. */
function depthOf(x, y, z) { return x * PROJ.view[0] + y * PROJ.view[1] + z * PROJ.view[2]; }

/** Nominal drawing scale: page units per metre before the packer rescales a figure. */
const NOMINAL_SCALE = 42;

/** GAME_DESIGN §8.4 — the legibility invariant, in page units (≈ px at 1080p). */
const MIN_SILHOUETTE = 40;

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 1. THE TWO HANDS — STORY.md §3.2, shipping values, verbatim.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

export const HANDS = Object.freeze({
  marit: Object.freeze({
    wobbleAmp: 0.22, cornerOvershoot: 0.00, strokeRepeat: 1.00, ghostAlpha: 0.00,
    wobbleFreq: 0.9, pressureVar: 0.06, closureError: 0.0,
    figure: { heightScale: 1.00, lean: 4.0, shoulders: 'round' },
  }),
  ansel: Object.freeze({
    wobbleAmp: 0.95, cornerOvershoot: 1.80, strokeRepeat: 1.70, ghostAlpha: 0.14,
    wobbleFreq: 3.4, pressureVar: 0.28, closureError: 0.9,
    figure: { heightScale: 1.06, lean: 0.0, shoulders: 'square' },
  }),
});

/**
 * STORY §3.1 — panels in Ansel's hand, by night. Exact counts, not percentages: he draws the
 * pages he needs it to say, and the count is the arc. Night 7 is one mark (the telephone inset).
 */
const ANSEL_PANELS = [0, 0, 1, 2, 5, 9, 13, 1];      // indexed by night; index 0 unused
const PANEL_COUNT = [0, 9, 11, 14, 16, 18, 17, 4];   // STORY §3.1; N7 is the blank + 3 marks

/** STORY §3.6 — the seven-stage evolution, as drawing behaviour rather than adjectives. */
const TONE = Object.freeze({
  1: { key: 'helpful',   redundancy: 2, dimensions: 1, terse: 0.0, red: 0.0, wear: 0.02, sparkle: true },
  2: { key: 'pedantic',  redundancy: 1, dimensions: 3, terse: 0.0, red: 0.7, wear: 0.06, sparkle: false },
  3: { key: 'impatient', redundancy: 0, dimensions: 0, terse: 0.6, red: 0.2, wear: 0.14, sparkle: false },
  4: { key: 'knowing',   redundancy: 0, dimensions: 1, terse: 0.3, red: 0.2, wear: 0.22, sparkle: false },
  5: { key: 'complicit', redundancy: 0, dimensions: 1, terse: 0.2, red: 0.4, wear: 0.34, sparkle: false },
  6: { key: 'wrong',     redundancy: 0, dimensions: 2, terse: 0.4, red: 0.5, wear: 0.52, sparkle: false },
  7: { key: 'gone',      redundancy: 0, dimensions: 0, terse: 1.0, red: 0.0, wear: 0.62, sparkle: false },
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 2. A SINGLE-STROKE ENGINEERING FONT.
 *
 * Article numbers, HJEM and the maker's mark are the only text in the manual, and all three are
 * drawn rather than typeset (STORY §3.5 guard 2: total font failure must not break the joke).
 * Drawing them also means the authorship wobble applies to the numerals — Ansel's article numbers
 * shake, and the traced Ø on Night Six can lean its slash the wrong way.
 *
 * Coordinates are on a 6 × 10 cap box, y = 0 at cap height, y = 10 on the baseline.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

const GLYPHS_VEC = {
  A: [[[0, 10], [3, 0], [6, 10]], [[1.1, 6.6], [4.9, 6.6]]],
  B: [[[0, 0], [0, 10]], [[0, 0], [4.2, 0], [5.6, 1.3], [5.6, 3.6], [4.2, 4.9], [0, 4.9]],
    [[0, 4.9], [4.4, 4.9], [5.9, 6.3], [5.9, 8.6], [4.4, 10], [0, 10]]],
  C: [[[6, 2.1], [4.4, 0], [1.6, 0], [0, 2.1], [0, 7.9], [1.6, 10], [4.4, 10], [6, 7.9]]],
  D: [[[0, 0], [0, 10]], [[0, 0], [3.9, 0], [6, 2.2], [6, 7.8], [3.9, 10], [0, 10]]],
  E: [[[6, 0], [0, 0], [0, 10], [6, 10]], [[0, 4.9], [4.6, 4.9]]],
  F: [[[6, 0], [0, 0], [0, 10]], [[0, 4.9], [4.6, 4.9]]],
  G: [[[6, 2.1], [4.4, 0], [1.6, 0], [0, 2.1], [0, 7.9], [1.6, 10], [4.4, 10], [6, 7.9], [6, 5.2], [3.4, 5.2]]],
  H: [[[0, 0], [0, 10]], [[6, 0], [6, 10]], [[0, 4.9], [6, 4.9]]],
  I: [[[3, 0], [3, 10]], [[1.1, 0], [4.9, 0]], [[1.1, 10], [4.9, 10]]],
  J: [[[5.2, 0], [5.2, 7.8], [3.7, 10], [1.6, 10], [0.1, 8.1]]],
  K: [[[0, 0], [0, 10]], [[6, 0], [0.2, 5.6]], [[2.1, 4.1], [6, 10]]],
  L: [[[0, 0], [0, 10], [5.8, 10]]],
  M: [[[0, 10], [0, 0], [3, 5.2], [6, 0], [6, 10]]],
  N: [[[0, 10], [0, 0], [6, 10], [6, 0]]],
  O: [[[1.6, 0], [4.4, 0], [6, 2.1], [6, 7.9], [4.4, 10], [1.6, 10], [0, 7.9], [0, 2.1], [1.6, 0]]],
  P: [[[0, 10], [0, 0], [4.4, 0], [6, 1.6], [6, 4.1], [4.4, 5.6], [0, 5.6]]],
  Q: [[[1.6, 0], [4.4, 0], [6, 2.1], [6, 7.9], [4.4, 10], [1.6, 10], [0, 7.9], [0, 2.1], [1.6, 0]], [[3.6, 7.4], [6.2, 10.6]]],
  R: [[[0, 10], [0, 0], [4.4, 0], [6, 1.6], [6, 4.1], [4.4, 5.6], [0, 5.6]], [[3.2, 5.6], [6, 10]]],
  S: [[[6, 1.6], [4.4, 0], [1.6, 0], [0, 1.6], [0, 3.4], [1.6, 4.6], [4.4, 5.4], [6, 6.6], [6, 8.4], [4.4, 10], [1.6, 10], [0, 8.4]]],
  T: [[[0, 0], [6, 0]], [[3, 0], [3, 10]]],
  U: [[[0, 0], [0, 7.9], [1.6, 10], [4.4, 10], [6, 7.9], [6, 0]]],
  V: [[[0, 0], [3, 10], [6, 0]]],
  W: [[[0, 0], [1.4, 10], [3, 3.4], [4.6, 10], [6, 0]]],
  X: [[[0, 0], [6, 10]], [[6, 0], [0, 10]]],
  Y: [[[0, 0], [3, 5.2], [6, 0]], [[3, 5.2], [3, 10]]],
  Z: [[[0, 0], [6, 0], [0, 10], [6, 10]]],
  'Ø': [[[1.6, 0], [4.4, 0], [6, 2.1], [6, 7.9], [4.4, 10], [1.6, 10], [0, 7.9], [0, 2.1], [1.6, 0]], [[6.5, -0.7], [-0.5, 10.7]]],
  'Æ': [[[0, 10], [3, 0], [6, 0]], [[1.1, 6.6], [3.6, 6.6]], [[3.3, 4.9], [5.6, 4.9]], [[3.3, 10], [6, 10]]],
  '&': [[[6, 10], [1.3, 3.3], [1.3, 1.6], [2.5, 0], [3.9, 0.7], [3.9, 2.3], [0, 6.4], [0, 8.4], [1.6, 10], [3.4, 10], [4.7, 8.6]]],
  0: [[[1.6, 0], [4.4, 0], [6, 2.1], [6, 7.9], [4.4, 10], [1.6, 10], [0, 7.9], [0, 2.1], [1.6, 0]]],
  1: [[[1.1, 1.9], [3.1, 0], [3.1, 10]], [[1.1, 10], [5.1, 10]]],
  2: [[[0, 2.0], [1.7, 0], [4.1, 0], [5.7, 1.8], [5.7, 3.5], [0, 10], [6, 10]]],
  3: [[[0, 0.9], [1.7, 0], [4.4, 0], [5.8, 1.4], [5.8, 3.4], [4.1, 4.8], [2.4, 4.8]],
    [[4.1, 4.8], [5.8, 6.2], [5.8, 8.4], [4.4, 10], [1.7, 10], [0, 9.1]]],
  4: [[[4.4, 10], [4.4, 0], [0, 7.0], [6, 7.0]]],
  5: [[[6, 0], [0.7, 0], [0.1, 4.4], [1.5, 3.5], [3.9, 3.5], [5.8, 5.0], [5.8, 8.2], [4.2, 10], [1.6, 10], [0, 9.0]]],
  6: [[[5.4, 0.8], [4.0, 0], [2.0, 0], [0.4, 1.8], [0, 5.6], [0, 8.4], [1.7, 10], [4.1, 10], [5.8, 8.5], [5.8, 6.4], [4.2, 5.0], [2.0, 5.0], [0.2, 6.2]]],
  7: [[[0, 0], [6, 0], [2.4, 10]]],
  8: [[[2.0, 4.6], [0.4, 3.4], [0.4, 1.4], [2.0, 0], [4.0, 0], [5.6, 1.4], [5.6, 3.4], [4.0, 4.6], [2.0, 4.6], [0, 6.2], [0, 8.4], [1.8, 10], [4.2, 10], [6, 8.4], [6, 6.2], [4.0, 4.6]]],
  9: [[[0.6, 9.2], [2.0, 10], [4.0, 10], [5.6, 8.2], [6, 4.4], [6, 1.6], [4.3, 0], [2.0, 0], [0.2, 1.5], [0.2, 3.6], [1.8, 5.0], [4.0, 5.0], [5.8, 3.8]]],
  '-': [[[0.6, 5.1], [5.4, 5.1]]],
  '.': [[[2.5, 9.1], [3.5, 9.1], [3.5, 10], [2.5, 10], [2.5, 9.1]]],
  ':': [[[2.5, 2.6], [3.5, 2.6], [3.5, 3.5], [2.5, 3.5], [2.5, 2.6]], [[2.5, 6.6], [3.5, 6.6], [3.5, 7.5], [2.5, 7.5], [2.5, 6.6]]],
  '×': [[[1.2, 3.4], [4.8, 7.4]], [[4.8, 3.4], [1.2, 7.4]]],
  '~': [[[0, 5.9], [1.5, 4.5], [3, 5.9], [4.5, 7.2], [6, 5.9]]],
  '/': [[[0, 10], [6, 0]]],
  '°': [[[2.6, 0], [3.6, 0.5], [3.6, 1.7], [2.6, 2.2], [1.6, 1.7], [1.6, 0.5], [2.6, 0]]],
  '+': [[[3, 2.4], [3, 7.6]], [[0.4, 5.0], [5.6, 5.0]]],
};
/** The Night-Six traced maker's mark: the slash through the Ø leans the wrong way. */
const GLYPH_O_TRACED = [
  [[1.6, 0], [4.4, 0], [6, 2.1], [6, 7.9], [4.4, 10], [1.6, 10], [0, 7.9], [0, 2.1], [1.6, 0]],
  [[-0.5, -0.7], [6.5, 10.7]],
];
const ADVANCE = 8.4;      // uniform advance in cap-box units — reads as a technical drawing
const ADVANCE_NARROW = { '.': 4.4, ':': 4.4, ' ': 5.0, '-': 7.0 };

function advanceOf(ch) { return (ADVANCE_NARROW[ch] ?? ADVANCE); }

function measureText(str, size) {
  let w = 0;
  for (const ch of String(str)) w += advanceOf(ch);
  return (w - (ADVANCE - 6)) * size / 10;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 3. SOLIDS — convex prisms built from real part dimensions, in metres.
 *
 * A part is one or more convex prisms plus non-hull detail polylines (chamfer marks, bolt holes,
 * grain, a door handle). The prisms are what hidden-line removal tests against, which is why the
 * diagram genuinely matches the 3D object instead of resembling it.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/** Extrude a 2D profile along an axis. Returns { verts, edges, faces, planes }. */
function makePrism(profile, axis, aMin, aMax) {
  // Ensure CCW.
  let area = 0;
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i], b = profile[(i + 1) % profile.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const p = area < 0 ? profile.slice().reverse() : profile;
  const n = p.length;
  const verts = new Float64Array(n * 2 * 3);
  const put = (i, u, v, t) => {
    let x, y, z;
    if (axis === 'x') { x = t; y = u; z = v; }
    else if (axis === 'y') { x = u; y = t; z = v; }
    else { x = u; y = v; z = t; }
    verts[i * 3] = x; verts[i * 3 + 1] = y; verts[i * 3 + 2] = z;
  };
  for (let i = 0; i < n; i++) { put(i, p[i][0], p[i][1], aMin); put(i + n, p[i][0], p[i][1], aMax); }
  const edges = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    edges.push([i, j], [i + n, j + n], [i, i + n]);
  }
  const faces = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push([i, j, j + n, i + n]);
  }
  const cap0 = []; const cap1 = [];
  for (let i = 0; i < n; i++) { cap0.push(n - 1 - i); cap1.push(i + n); }
  faces.push(cap0, cap1);
  return finaliseSolid({ verts, edges, faces });
}

/** Recompute outward half-space planes (n·p <= d) from faces + centroid. Mirror-safe. */
function finaliseSolid(s) {
  const { verts, faces } = s;
  const nV = verts.length / 3;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < nV; i++) { cx += verts[i * 3]; cy += verts[i * 3 + 1]; cz += verts[i * 3 + 2]; }
  cx /= nV; cy /= nV; cz /= nV;
  const planes = [];
  for (const f of faces) {
    if (f.length < 3) continue;
    const a = f[0], b = f[1], c = f[2];
    const ux = verts[b * 3] - verts[a * 3], uy = verts[b * 3 + 1] - verts[a * 3 + 1], uz = verts[b * 3 + 2] - verts[a * 3 + 2];
    const vx = verts[c * 3] - verts[a * 3], vy = verts[c * 3 + 1] - verts[a * 3 + 1], vz = verts[c * 3 + 2] - verts[a * 3 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) continue;
    nx /= l; ny /= l; nz /= l;
    let d = nx * verts[a * 3] + ny * verts[a * 3 + 1] + nz * verts[a * 3 + 2];
    if (nx * cx + ny * cy + nz * cz > d) { nx = -nx; ny = -ny; nz = -nz; d = -d; }
    planes.push([nx, ny, nz, d]);
  }
  s.planes = planes;
  s.centroid = [cx, cy, cz];
  return s;
}

function boxProfile(w, h) {
  const x = w / 2, y = h / 2;
  return [[-x, -y], [x, -y], [x, y], [-x, y]];
}

/** A box centred on the origin, long axis given. */
function makeBox(sx, sy, sz, axis = 'x') {
  if (axis === 'x') return makePrism(boxProfile(sy, sz), 'x', -sx / 2, sx / 2);
  if (axis === 'y') return makePrism(boxProfile(sx, sz), 'y', -sy / 2, sy / 2);
  return makePrism(boxProfile(sx, sy), 'z', -sz / 2, sz / 2);
}

function makeCylinder(r, len, axis = 'y', seg = 12) {
  const prof = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    prof.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return makePrism(prof, axis, -len / 2, len / 2);
}

/** A tapered block — a stone pier. */
function makeTaper(wBot, wTop, h, d) {
  const s = makePrism(boxProfile(wBot, d), 'y', -h / 2, h / 2);
  // Pinch the top face inward.
  const k = wTop / wBot;
  for (let i = 0; i < s.verts.length / 3; i++) {
    if (s.verts[i * 3 + 1] > 0) { s.verts[i * 3] *= k; s.verts[i * 3 + 2] *= k; }
  }
  return finaliseSolid(s);
}

function makeWedge(len, h, d) {
  return makePrism([[-len / 2, h / 2], [len / 2, -h / 2], [len / 2, h / 2]], 'z', -d / 2, d / 2);
}

/** Transform a solid: uniform scale, yaw about Y, optional X-mirror, then translate. */
function transformSolid(src, { pos = [0, 0, 0], yaw = 0, mirror = false, scale = 1 } = {}) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const n = src.verts.length / 3;
  const verts = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    let x = src.verts[i * 3] * scale, y = src.verts[i * 3 + 1] * scale, z = src.verts[i * 3 + 2] * scale;
    if (mirror) x = -x;
    const rx = x * c + z * s;
    const rz = -x * s + z * c;
    verts[i * 3] = rx + pos[0]; verts[i * 3 + 1] = y + pos[1]; verts[i * 3 + 2] = rz + pos[2];
  }
  return finaliseSolid({ verts, edges: src.edges, faces: src.faces });
}

function transformPoly(poly, { pos = [0, 0, 0], yaw = 0, mirror = false, scale = 1 } = {}) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const out = [];
  for (const p of poly) {
    let x = p[0] * scale, y = p[1] * scale, z = p[2] * scale;
    if (mirror) x = -x;
    out.push([x * c + z * s + pos[0], y + pos[1], -x * s + z * c + pos[2]]);
  }
  return out;
}

/**
 * Screen-space bounds + near depth for a transformed solid, at unit scale. The HLR inner loop
 * rejects almost every solid on these two comparisons instead of running the plane clip.
 */
function solidBounds(s) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, dMax = -Infinity;
  const n = s.verts.length / 3;
  for (let i = 0; i < n; i++) {
    const x = s.verts[i * 3], y = s.verts[i * 3 + 1], z = s.verts[i * 3 + 2];
    const px = projX(x, y, z, 1), py = projY(x, y, z, 1), d = depthOf(x, y, z);
    if (px < x0) x0 = px; if (px > x1) x1 = px;
    if (py < y0) y0 = py; if (py > y1) y1 = py;
    if (d > dMax) dMax = d;
  }
  s.sx0 = x0; s.sy0 = y0; s.sx1 = x1; s.sy1 = y1; s.dMax = dMax;
  return s;
}

/** Does the ray (p → viewer) enter this convex solid? If so the point is hidden behind it. */
function rayHitsConvex(planes, px, py, pz, eps) {
  const vx = PROJ.view[0], vy = PROJ.view[1], vz = PROJ.view[2];
  let tMin = eps, tMax = 1e9;
  for (let i = 0; i < planes.length; i++) {
    const pl = planes[i];
    const denom = pl[0] * vx + pl[1] * vy + pl[2] * vz;
    const dist = pl[3] - (pl[0] * px + pl[1] * py + pl[2] * pz);
    if (Math.abs(denom) < 1e-9) { if (dist < 0) return false; continue; }
    const t = dist / denom;
    if (denom > 0) { if (t < tMax) tMax = t; } else if (t > tMin) tMin = t;
    if (tMin > tMax) return false;
  }
  return tMax > tMin;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 4. THE PART LIBRARY — GAME_DESIGN §6.1, real dimensions in metres.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

const PART_TYPES = {
  pier: { accepts: 'pier', mass: 34, cls: 'D', dims: [0.52, 0.40, 0.52], build: () => ({
    solids: [makeTaper(0.52, 0.40, 0.40, 0.52)],
    details: [[[-0.17, 0.20, 0.20], [0.17, 0.20, 0.20]]],
  }) },
  beam: { accepts: 'beam', len: 3.2, mass: 62, cls: 'D', dims: [3.2, 0.22, 0.22], build: () => ({
    solids: [makeBox(3.2, 0.22, 0.22, 'x')],
    // The half-lap notch is cut on ONE end only. It is the whole of G1's failure mode, and it is
    // the only mark on the page that says which way round a sill goes.
    details: boltMarks(3.2, 0.111, 4).concat([
      [[1.38, 0.111, -0.11], [1.38, 0.111, 0.11]],
      [[1.38, 0.111, 0.11], [1.60, 0.111, 0.11]],
      [[1.38, 0.0, -0.11], [1.38, 0.111, -0.11]],
    ]),
  }) },
  beamShort: { accepts: 'beam', len: 2.6, mass: 48, cls: 'D', dims: [2.6, 0.22, 0.22], build: () => ({
    solids: [makeBox(2.6, 0.22, 0.22, 'x')],
    details: boltMarks(2.6, 0.111, 3),
  }) },
  post: { accepts: 'post', len: 2.4, mass: 41, cls: 'D', dims: [0.18, 2.4, 0.18], build: () => ({
    solids: [makeBox(0.18, 2.4, 0.18, 'y')],
    // Chamfered top — the only thing that tells you which way up it goes at 2.2 m by lantern.
    details: [[[-0.09, 1.14, 0.09], [0.09, 1.20, 0.09]], [[-0.09, 1.14, -0.09], [0.09, 1.20, -0.09]],
      // The brace mortise, cut on two faces only: half the yaw candidates are wrong.
      [[-0.09, 0.86, 0.09], [-0.09, 1.02, 0.09], [0.02, 1.02, 0.09], [0.02, 0.86, 0.09], [-0.09, 0.86, 0.09]]],
  }) },
  stud: { accepts: 'post', len: 2.4, mass: 22, cls: 'C', dims: [0.09, 2.4, 0.14], build: () => ({
    solids: [makeBox(0.09, 2.4, 0.14, 'y')],
    details: [[[-0.045, 1.10, 0.07], [0.045, 1.10, 0.07]], [[-0.045, -1.10, 0.07], [0.045, -1.10, 0.07]]],
  }) },
  joist: { accepts: 'joist', len: 3.2, mass: 24, cls: 'C', dims: [3.2, 0.24, 0.08], build: () => ({
    solids: [makeBox(3.2, 0.24, 0.08, 'x')],
    details: boltMarks(3.2, 0.041, 2),
  }) },
  truss: { accepts: 'truss', len: 4.0, mass: 55, cls: 'D', dims: [4.0, 1.10, 0.14], build: () => {
    const span = 4.0, rise = 1.10, t = 0.14;
    const solids = [makeBox(span, t, 0.09, 'x')];
    const half = span / 2;
    for (const sgn of [-1, 1]) {
      const len = Math.hypot(half, rise);
      const ang = Math.atan2(rise, half * sgn === half ? half : half);
      const raf = makeBox(len, t, 0.07, 'x');
      // Rotate the rafter about Z into the roof pitch.
      const c = Math.cos(sgn * -ang), s = Math.sin(sgn * -ang);
      for (let i = 0; i < raf.verts.length / 3; i++) {
        const x = raf.verts[i * 3], y = raf.verts[i * 3 + 1];
        raf.verts[i * 3] = x * c - y * s + sgn * half / 2;
        raf.verts[i * 3 + 1] = x * s + y * c + rise / 2;
      }
      solids.push(finaliseSolid(raf));
    }
    // King post.
    const king = makeBox(0.09, rise, 0.09, 'y');
    shift(king, 0, rise / 2, 0);
    solids.push(king);
    /*
     * WEBBING. The keyart truss is not two rafters and a post — it is a fink, and the two
     * diagonals are what make it read as a truss rather than a triangle at 90 px. Each web runs
     * from the bottom chord at ±half/2 up to the rafter's midpoint.
     */
    for (const sgn of [-1, 1]) {
      const ax = sgn * half * 0.50, ay = 0;
      const bx = sgn * half * 0.50, by = rise * 0.50;
      const wl = Math.hypot(bx - ax, by - ay) || 0.01;
      const wang = Math.atan2(by - ay, bx - ax);
      const web = makeBox(wl, 0.07, 0.07, 'x');
      const wc = Math.cos(wang), ws = Math.sin(wang);
      for (let i = 0; i < web.verts.length / 3; i++) {
        const x = web.verts[i * 3], y = web.verts[i * 3 + 1];
        web.verts[i * 3] = x * wc - y * ws + (ax + bx) / 2;
        web.verts[i * 3 + 1] = x * ws + y * wc + (ay + by) / 2;
      }
      solids.push(finaliseSolid(web));
      const dl = Math.hypot(sgn * half * 0.50, rise * 0.50);
      const dang = Math.atan2(rise * 0.50, -sgn * half * 0.50);
      const dia = makeBox(dl, 0.07, 0.07, 'x');
      const dc = Math.cos(dang), ds = Math.sin(dang);
      for (let i = 0; i < dia.verts.length / 3; i++) {
        const x = dia.verts[i * 3], y = dia.verts[i * 3 + 1];
        dia.verts[i * 3] = x * dc - y * ds + sgn * half * 0.25;
        dia.verts[i * 3 + 1] = x * ds + y * dc + rise * 0.25;
      }
      solids.push(finaliseSolid(dia));
    }
    return { solids, details: [] };
  } },
  ridge: { accepts: 'ridge', len: 4.8, mass: 71, cls: 'D', dims: [4.8, 0.22, 0.30], build: () => ({
    solids: [makeBox(4.8, 0.22, 0.30, 'x')],
    details: boltMarks(4.8, 0.111, 6),
  }) },
  panel: { accepts: 'panel', mass: 33, cls: 'D', dims: [1.2, 2.4, 0.02], build: () => ({
    solids: [makeBox(1.2, 2.4, 0.02, 'y')],
    details: [[[-0.6, -0.6, 0.011], [0.6, -0.6, 0.011]], [[-0.6, 0.6, 0.011], [0.6, 0.6, 0.011]]],
  }) },
  wallNorth: { accepts: 'panel', mass: 71, cls: 'end-lift', dims: [4.8, 2.4, 0.03], build: () => ({
    solids: [makeBox(4.8, 2.4, 0.03, 'y')],
    details: [[[-1.6, -1.2, 0.016], [-1.6, 1.2, 0.016]], [[1.6, -1.2, 0.016], [1.6, 1.2, 0.016]]],
  }) },
  board: { accepts: 'board', mass: 9, cls: 'C', dims: [0.2, 2.4, 0.02], build: () => ({
    solids: [makeBox(0.2, 2.4, 0.02, 'y')], details: [],
  }) },
  batten: { accepts: 'batten', mass: 11, cls: 'C', dims: [2.8, 0.05, 0.03], build: () => ({
    solids: [makeBox(2.8, 0.05, 0.03, 'x')], details: [],
  }) },
  shingle: { accepts: 'shingle', mass: 27, cls: 'C', dims: [0.9, 0.22, 0.36], build: () => ({
    solids: [makeBox(0.9, 0.22, 0.36, 'x')],
    details: [[[-0.45, 0.06, -0.18], [0.45, 0.06, -0.18]], [[-0.45, -0.04, -0.18], [0.45, -0.04, -0.18]]],
  }) },
  door: { accepts: 'door', mass: 38, cls: 'D', dims: [0.9, 2.05, 0.045], build: () => ({
    solids: [makeBox(0.9, 2.05, 0.045, 'y')],
    details: [ring(0.32, -0.02, 0.03, 0.035, 8), [[-0.36, -0.72, 0.024], [0.36, -0.72, 0.024]],
      [[-0.36, 0.62, 0.024], [0.36, 0.62, 0.024]]],
  }) },
  sink: { accepts: 'fitting', mass: 29, cls: 'C', dims: [0.62, 0.34, 0.46], build: () => {
    const prof = [];
    for (let i = 0; i <= 10; i++) {
      const a = Math.PI * (i / 10);
      prof.push([Math.cos(a) * 0.31, -0.17 + Math.sin(a) * 0.10]);
    }
    prof.push([-0.31, 0.17], [0.31, 0.17]);
    return { solids: [makePrism(prof, 'z', -0.23, 0.23)], details: [ring(0, 0.16, 0, 0.05, 8)] };
  } },
  flue: { accepts: 'fitting', mass: 16, cls: 'C', dims: [0.15, 2.2, 0.15], build: () => ({
    solids: [makeCylinder(0.075, 2.2, 'y', 12)],
    details: [ring(0, 0.7, 0, 0.085, 12, 'y')],
  }) },
  doorframe: { accepts: 'fitting', mass: 19, cls: 'C', dims: [1.06, 2.1, 0.12], build: () => {
    const a = makeBox(0.08, 2.1, 0.12, 'y'); shift(a, -0.49, 0, 0);
    const b = makeBox(0.08, 2.1, 0.12, 'y'); shift(b, 0.49, 0, 0);
    const c = makeBox(1.06, 0.08, 0.12, 'x'); shift(c, 0, 1.01, 0);
    // The four pencil marks. Not dimensioned. Never explained.
    const marks = [0.91, 1.08, 1.24, 1.41].map((h) => [[-0.53, h - 1.05, 0.061], [-0.42, h - 1.05, 0.061]]);
    return { solids: [a, b, c], details: marks };
  } },
  chair: { accepts: 'chair', mass: 5, cls: 'B', dims: [0.42, 0.86, 0.42], build: () => {
    const solids = [];
    for (const [x, z] of [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]]) {
      const l = makeCylinder(0.019, 0.44, 'y', 8); shift(l, x, -0.21, z); solids.push(l);
    }
    const seat = makeBox(0.42, 0.03, 0.42, 'x'); shift(seat, 0, 0.02, 0); solids.push(seat);
    const bl = makeCylinder(0.019, 0.42, 'y', 8); shift(bl, -0.17, 0.24, 0.17); solids.push(bl);
    const br = makeCylinder(0.019, 0.42, 'y', 8); shift(br, 0.17, 0.24, 0.17); solids.push(br);
    const rail = makeBox(0.38, 0.05, 0.02, 'x'); shift(rail, 0, 0.41, 0.17); solids.push(rail);
    return { solids, details: [] };
  } },
  bracket: { accepts: 'bracket', mass: 1.2, cls: 'B', dims: [0.16, 0.16, 0.05], build: () => ({
    solids: [makePrism([[-0.08, -0.08], [0.08, -0.08], [0.08, -0.05], [-0.05, -0.05], [-0.05, 0.08], [-0.08, 0.08]], 'z', -0.025, 0.025)],
    details: [ring(0.03, -0.065, 0.026, 0.012, 6), ring(-0.065, 0.03, 0.026, 0.012, 6)],
  }) },
  gusset: { accepts: 'bracket', mass: 0.9, cls: 'B', dims: [0.3, 0.22, 0.006], build: () => ({
    solids: [makePrism([[-0.15, -0.11], [0.15, -0.11], [0, 0.11]], 'z', -0.003, 0.003)],
    details: [ring(-0.07, -0.06, 0.004, 0.011, 6), ring(0.07, -0.06, 0.004, 0.011, 6)],
  }) },
  hinge: { accepts: 'hinge', mass: 2.1, cls: 'B', dims: [0.14, 0.10, 0.02], build: () => {
    const a = makeBox(0.062, 0.10, 0.005, 'x'); shift(a, -0.036, 0, 0);
    const b = makeBox(0.062, 0.10, 0.005, 'x'); shift(b, 0.036, 0, 0);
    const k = makeCylinder(0.009, 0.10, 'y', 8);
    return { solids: [a, b, k], details: [] };
  } },
  fastener: { accepts: 'fastener', mass: 0.1, cls: 'A', dims: [0.02, 0.14, 0.02], build: () => {
    const sh = makeCylinder(0.008, 0.13, 'y', 8);
    const hd = makeCylinder(0.017, 0.02, 'y', 6); shift(hd, 0, 0.072, 0);
    return { solids: [sh, hd], details: [] };
  } },
  shim: { accepts: 'shim', mass: 0.3, cls: 'A', dims: [0.30, 0.03, 0.15], build: () => ({
    solids: [makeWedge(0.30, 0.03, 0.15)], details: [],
  }) },
  hearth: { accepts: 'fitting', mass: 140, cls: 'E', dims: [0.9, 0.5, 0.7], build: () => ({
    solids: [makeTaper(0.9, 0.82, 0.5, 0.7)], details: [],
  }) },
  stake: { accepts: 'stake', mass: 1.0, cls: 'A', dims: [0.012, 0.9, 0.012], build: () => ({
    solids: [makeCylinder(0.006, 0.9, 'y', 6)],
    details: [[[0, 0.42, 0], [0.09, 0.47, 0.02], [0.14, 0.40, -0.01]]],
  }) },
};

function shift(s, dx, dy, dz) {
  for (let i = 0; i < s.verts.length / 3; i++) {
    s.verts[i * 3] += dx; s.verts[i * 3 + 1] += dy; s.verts[i * 3 + 2] += dz;
  }
  return finaliseSolid(s);
}

/** A flat ring of `n` points in the XY plane at z — a bolt hole or a knob, as a detail polyline. */
function ring(cx, cy, z, r, n = 8, plane = 'z') {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    if (plane === 'y') out.push([cx + Math.cos(a) * r, cy, z + Math.sin(a) * r]);
    else out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, z]);
  }
  return out;
}

/** Evenly spaced bolt-hole marks along a member's top face — the yaw tell at ≤ 2.2 m. */
function boltMarks(len, top, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = -len / 2 + len * (i + 0.5) / n;
    out.push(ring(x, top, 0, 0.022, 6));
  }
  return out;
}

const PART_CACHE = new Map();
function partGeometry(type) {
  let g = PART_CACHE.get(type);
  if (!g) {
    const def = PART_TYPES[type] ?? PART_TYPES.beam;
    try { g = def.build(); } catch (e) { Log.once('bp:part', `Blueprint: part '${type}' failed`, e); g = { solids: [], details: [] }; }
    PART_CACHE.set(type, g);
  }
  return g;
}

export { PART_TYPES };

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 5. THE NIGHTS — manifest, slot layout, shortfalls.
 *
 * STORY §6.0 is canon on night content (GAME_DESIGN §0.1 rank order), and `Script.nights[]`
 * already encodes it, so everything here reads Script first and falls back to this table when
 * Script is absent. The footprint is STORY §4.2 landmark 1: 11.6 × 7.8 m, long axis E–W.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/*
 * The cabin, in CabinSite's plot-local metres, verbatim from `src/world/CabinSite.js`'s `P`.
 * The diagram is only a puzzle if these are the numbers the player is standing in front of.
 * (v1 carried 11.6 x 7.8 — the *plot*, not the building — and drew a cabin nobody was building.)
 */
const FOOT = { hx: 3.20, hz: 1.60, wall: 2.40, deck: 0.62, plate: 3.09, ridge: 4.19 };

/** Fallback night table — identical numbers to Script.nights, used when Script is missing. */
const NIGHTS_FALLBACK = [
  null,
  { n: 1, name: 'GRUNNMUR', title: 'FOUNDATION (A)', slots: 6, stages: 3, grammar: 'G1', tone: 'helpful' },
  { n: 2, name: 'BJELKELAG', title: 'UPRIGHTS (B ×4) — SUPPORT WHILE FIXING', slots: 9, stages: 3, grammar: 'G2', tone: 'pedantic' },
  { n: 3, name: 'REISVERK', title: 'DO NOT OVERTIGHTEN', slots: 14, stages: 4, grammar: 'G3', tone: 'impatient' },
  { n: 4, name: 'KLEDNING', title: 'IF PARTS ARE MISSING, DO NOT RETURN TO STORE', slots: 18, stages: 4, grammar: 'G4', tone: 'knowing' },
  { n: 5, name: 'TAKSTOL', title: 'THIS STEP REQUIRES TWO PERSONS', slots: 22, stages: 5, grammar: 'G5', tone: 'complicit' },
  { n: 6, name: 'VINDU & DØR', title: 'SOLD SEPARATELY', slots: 20, stages: 5, grammar: 'G6', tone: 'wrong' },
  { n: 7, name: 'HJEM', title: 'SOME ASSEMBLY REQUIRED', slots: 28, stages: 6, grammar: 'G7', tone: 'gone' },
];

const NIGHT_NAME = ['', 'GRUNNMUR', 'BJELKELAG', 'REISVERK', 'KLEDNING', 'TAKSTOL', 'VINDU & DØR', 'HJEM'];

/**
 * THE MISSING-HARDWARE ENGINE (GAME_DESIGN §6.9 + STORY §6.0).
 * Positions are STORY §4.2 landmarks — "the single source of truth for positions". They are
 * advisory to `Props`/`CabinSite`, which own final placement and snap Y to the heightfield.
 * `cue` is the material-appropriate 90-second audio hint; stone gets none, on purpose.
 * `indignity` is the escalation the brief asks for, stated so it cannot be tuned away.
 *
 * `count` / `supplied` are MANIFEST quantities: how many the drawing prints against how many are
 * in the pile. (`BuildSystem.SHORTFALLS` has a `count` too and it means something else — how many
 * objects to withhold and re-spawn. Two tables, two schemas, on purpose.)
 *
 * `partType` names the `PART_TYPES` key this shortfall's contents row is drawn from, and it is
 * what makes the row go red. The manifest used to identify that row by `p.count === short.count`
 * — a coincidence match on a quantity — which meant a shortfall with no `count` reddened nothing
 * at all. That is why NOTHING WAS EVER RED ON NIGHT 1: neither the mallet nor the pier carried a
 * `count`, so `isShort` could not be true, and §6.9's whole "red outline redraws in black with a
 * tick" reward never happened on the night that teaches it.
 */
const SHORTFALLS = {
  1: [
    // Announced by NOBODY at t = 0 — `BuildSystem.SHORTFALLS[1]` marks the mallet `silent`, and
    // it is `type: 'tool'`, so it has no contents row here either. §17 at 2:40 and STORY §6 both
    // depend on the player not knowing it was gone. It is found because it is lying at the log.
    { id: 'mallet', name: 'Mallet', type: 'tool', tier: 1, material: 'metal', cue: null,
      at: { x: -26, z: -18 }, landmark: 'fallen log', dist: 31.6, bearing: 'NW', hintable: false,
      indignity: 'You did not know you were missing it. You had been using your hands.' },
    // THE PREMISE. Six chalk marks, five blocks. §17 at 2:05: "the core comedy, in the first
    // three minutes." `partType: 'pier'` is what puts the contents row in the manual's red.
    { id: 'pier_06', name: 'Pier block, 6 of 6', type: 'part', partType: 'pier', tier: 1, material: 'stone', cue: null,
      at: { x: -26, z: -18 }, landmark: 'fallen log', dist: 31.6, bearing: 'NW', hintable: true, count: 6, supplied: 5,
      indignity: 'Five blocks were supplied for six squares.' },
    { id: 'shim_plate_1961', name: 'Shim', type: 'consumable', tier: 1, material: 'stone', cue: null,
      at: { x: -26, z: -18 }, landmark: 'fallen log', dist: 31.6, bearing: 'NW', hintable: true,
      indignity: 'Pier D sits 11 mm low. The fix panel is a rectangle. It does not care what the rectangle is.' },
  ],
  2: [
    { id: 'bracket_H', name: 'L-bracket H', type: 'hardware', partType: 'bracket', tier: 2, material: 'metal', cue: 'hardware_tick_steel',
      at: { x: -36, z: 46 }, landmark: 'woodpile', dist: 58.4, bearing: 'SW', hintable: true, count: 4, supplied: 3,
      indignity: 'Four are drawn, evenly, numbered H-1 to H-4. Three are in the pile.' },
  ],
  3: [
    { id: 'gusset_plate', name: 'Gusset plate', type: 'hardware', partType: 'gusset', tier: 2, material: 'metal', cue: 'hardware_tick_steel',
      at: { x: 86, z: -52 }, landmark: 'boathouse eave', dist: 100.5, bearing: 'ENE', hintable: true, count: 8, supplied: 6,
      indignity: 'The bag icon says eight. The drawing shows six. Two are behind the geometry.' },
  ],
  4: [
    { id: 'hinge_set_brass', name: 'Hinge set, brass', type: 'hardware', partType: 'hinge', tier: 3, material: 'metal', cue: 'hardware_tick_steel',
      at: { x: 86, z: -52 }, landmark: 'boathouse door', dist: 100.5, bearing: 'ENE', hintable: true, count: 3, supplied: 0,
      indignity: 'They are drawn in situ, screwed to a door that belongs to somebody else.' },
    { id: 'brace_tool', name: 'Brace and bit', type: 'tool', tier: 3, material: 'metal', cue: 'hardware_tick_steel',
      at: { x: 132, z: 74 }, landmark: 'mess hall shelf', dist: 151.3, bearing: 'ESE', hintable: true,
      indignity: 'Inside the lit perimeter. There is no version of this that is not trespass.' },
  ],
  5: [
    { id: 'truss_pin', name: 'Truss pins', type: 'hardware', tier: 3, material: 'metal', cue: 'hardware_tick_steel',
      at: { x: 104, z: 96 }, landmark: "counselors' cabins", dist: 141.6, bearing: 'SE', hintable: true, count: 3, supplied: 0 },
    { id: 'tallow_tin', name: 'Tallow tin', type: 'consumable', tier: 3, material: 'metal', cue: 'hardware_tick_steel',
      at: { x: 132, z: 74 }, landmark: 'mess hall', dist: 151.3, bearing: 'ESE', hintable: true },
    { id: 'second_person', name: null, type: 'person', tier: null, material: null, cue: null,
      at: null, landmark: null, dist: null, bearing: null, hintable: false, phantom: true,
      indignity: 'The missing item is a second person. It is not an object. It cannot be fetched.' },
  ],
  6: [
    { id: 'errata_slip', name: 'Errata slip', type: 'document', tier: 2, material: 'paper', cue: 'hardware_tick_paper',
      at: { x: 86, z: -52 }, landmark: 'boathouse, again', dist: 100.5, bearing: 'ENE', hintable: true },
    { id: 'hinge_set', name: 'Hinge set', type: 'hardware', tier: 3, material: 'metal', cue: 'hardware_tick_steel',
      at: { x: 138, z: 82 }, landmark: 'payphone alcove', dist: 160.6, bearing: 'ESE', hintable: true },
    { id: 'fastener_bag_short', name: 'Fastener bag', type: 'hardware', tier: 1, material: 'cloth', cue: 'hardware_tick_cloth',
      at: { x: -14, z: 26 }, landmark: 'supply pallet', dist: 29.5, bearing: 'SSW', hintable: true, count: 12, supplied: 9 },
    { id: 'article_0000_000', name: '0000-000', type: 'phantom', tier: null, material: null, cue: null,
      at: null, landmark: null, dist: null, bearing: null, hintable: false, phantom: true,
      indignity: 'It is not in the world. It has never been in the world. Never hint it. Never acknowledge the search.' },
  ],
  7: [
    { id: 'tier3_final', name: 'Tier-3 item', type: 'hardware', tier: 3, material: 'metal', cue: 'hardware_tick_steel',
      at: { x: 138, z: 82 }, landmark: 'payphone alcove', dist: 160.6, bearing: 'ESE', hintable: true },
    { id: 'errata_slip_final', name: 'Errata slip', type: 'document', tier: 2, material: 'paper', cue: 'hardware_tick_paper',
      at: { x: 86, z: -52 }, landmark: 'boathouse', dist: 100.5, bearing: 'ENE', hintable: true },
    { id: 'fastener_bag_short_3', name: 'Fastener bag', type: 'hardware', tier: 1, material: 'cloth', cue: 'hardware_tick_cloth',
      at: { x: -14, z: 26 }, landmark: 'supply pallet', dist: 29.5, bearing: 'SSW', hintable: true, count: 12, supplied: 9 },
    { id: 'the_person_in_the_chair', name: null, type: 'person', tier: null, material: null, cue: null,
      at: null, landmark: null, dist: null, bearing: null, hintable: false, phantom: true,
      indignity: 'The parts bracket reads 1. The manual is still doing bits about it.' },
  ],
};

/** Article numbers are never random — STORY §3, the Vik house's own years. */
const ARTICLE_YEARS = [1949, 1953, 1955, 1957, 1961, 1962, 1971, 1984];

function articleNumber(rand, qty) {
  const y = ARTICLE_YEARS[rand.int(0, ARTICLE_YEARS.length - 1)];
  const n = qty != null ? qty : rand.int(1, 340);
  return `${y}-${String(n).padStart(3, '0')}`;
}

/**
 * CabinSite's `partId` is the member's ROLE ('PIER', 'STUD', 'CHAIR_LEG'), reused across every
 * slot in a run. This maps that role onto the drawable solid in the part library above, so the
 * lines on the page are the edges of the member the player is about to pick up.
 */
const SITE_PART_TYPE = Object.freeze({
  PIER: 'pier', SILL: 'beam', POST: 'post', STUD: 'stud', BRACKET: 'bracket',
  TRUSS: 'truss', RIDGE: 'ridge', PIN: 'fastener', BATTEN: 'batten', SHINGLE: 'shingle',
  PANEL_N: 'wallNorth', PANEL: 'panel', DOOR: 'door', HINGE: 'hinge', SINK: 'sink',
  FLUE: 'flue', DOORFRAME: 'doorframe', BOARD: 'board', JOIST: 'joist', SHIM: 'shim',
  HEARTH: 'hearth', GUSSET: 'gusset', STAKE: 'stake',
  CHAIR_LEG: 'chair', CHAIR_SEAT: 'chair', CHAIR_BACK: 'chair', CHAIR_ARM: 'chair',
});

/** Fallback when a role is unknown: pick a library part that accepts the same type. */
const ACCEPTS_FALLBACK = Object.freeze({
  pier: 'pier', beam: 'beam', post: 'post', joist: 'joist', truss: 'truss', ridge: 'ridge',
  panel: 'panel', board: 'board', batten: 'batten', shingle: 'shingle', door: 'door',
  fitting: 'sink', bracket: 'bracket', hinge: 'hinge', fastener: 'fastener', shim: 'shim',
  chair: 'chair', stake: 'stake',
});

function siteTypeFor(m) {
  const role = String(m?.partId ?? '').toUpperCase();
  const byRole = SITE_PART_TYPE[role];
  if (byRole && PART_TYPES[byRole]) return byRole;
  const byAccepts = ACCEPTS_FALLBACK[m?.acceptsType ?? ''];
  if (byAccepts && PART_TYPES[byAccepts]) return byAccepts;
  return 'beam';
}

/** A finite unit 3-vector from CabinSite's `_dir` / `_out`, or null. */
function normOf(v) {
  if (!Array.isArray(v) || v.length < 3) return null;
  const l = Math.hypot(v[0], v[1], v[2]);
  if (!(l > 1e-6)) return null;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * GAME_DESIGN §8.4 — `graphDepth` is the part's depth in the `requires` DAG, and it is what makes
 * deeper parts fly further so the assembly order reads outward-in with no numbering at all.
 */
function computeGraphDepth(slots) {
  const byId = new Map();
  for (const s of slots) byId.set(s.id, s);
  const seen = new Map();
  const depth = (id, guard) => {
    if (seen.has(id)) return seen.get(id);
    if (guard.has(id)) return 0;              // a cycle in someone else's data is not our crash
    guard.add(id);
    const s = byId.get(id);
    let d = 0;
    if (s && Array.isArray(s.requires)) {
      for (const r of s.requires) {
        if (byId.has(r)) d = Math.max(d, 1 + depth(r, guard));
      }
    }
    guard.delete(id);
    seen.set(id, d);
    return d;
  };
  for (const s of slots) s.graphDepth = Math.min(6, depth(s.id, new Set()));
}

/**
 * Slot layout. `CabinSite.js` owns the authoritative transforms; these are the diagram's own
 * plot-local metres and are offered as a proposal used only when CabinSite is not in the build
 * (headless tests, the golden-image tool). See `_slotsFromSite` for the real path.
 */
function layoutNight(n, rand) {
  const slots = []; const parts = [];
  let idc = 0;
  const add = (type, stage, pos, opts = {}) => {
    const pid = `${(opts.prefix ?? type).toUpperCase()}-${String(++idc).padStart(2, '0')}`;
    const t = PART_TYPES[type] ?? PART_TYPES.beam;
    parts.push({
      id: pid, type, acceptsType: t.accepts, mass: t.mass, carryClass: t.cls,
      length: t.len ?? t.dims[0], dims: t.dims,
      articleNo: opts.articleNo ?? articleNumber(rand, opts.qty),
      label: opts.label ?? null,
    });
    slots.push({
      id: `${(opts.slotPrefix ?? 'S')}-${String(idc).padStart(2, '0')}`,
      kind: 'fixed', stage, acceptsType: t.accepts, partId: pid,
      position: { x: pos[0], y: pos[1], z: pos[2] },
      yaw: opts.yaw ?? 0,
      axis: opts.axis ?? 'y',
      normal: opts.normal ?? [0, 1, 0],
      yawCandidates: opts.yawCandidates ?? 4,
      symmetryOrder: opts.symmetryOrder ?? 4,
      requires: opts.requires ?? [],
      fasteners: opts.fasteners ?? 2,
      ratedMass: opts.ratedMass ?? 180,
      mirrorOf: opts.mirrorOf ?? null,
      hidden: !!opts.hidden,
      errata: !!opts.errata,
      graphDepth: opts.depth ?? 0,
      mirror: !!opts.mirror,
    });
    return { pid, slot: slots[slots.length - 1] };
  };

  const { hx, hz, wall } = FOOT;
  if (n === 1) {
    // Six stone piers, six sill beams. Piers are genuinely symmetric: symmetryOrder = k.
    for (let i = 0; i < 6; i++) {
      const x = -hx + (hx * 2) * (i % 3) / 2;
      const z = i < 3 ? -hz : hz;
      add('pier', 1, [x, 0.21, z], { prefix: 'PIER', slotPrefix: 'P', yawCandidates: 4, symmetryOrder: 4, fasteners: 0, qty: 6 });
    }
    for (let i = 0; i < 6; i++) {
      const z = i < 3 ? -hz : hz;
      const x = -hx + (hx * 2) * (i % 3) / 2;
      add('beam', 2, [x, 0.49, z], { prefix: 'SILL', slotPrefix: 'B', axis: 'x', normal: [0, 1, 0],
        yawCandidates: 2, symmetryOrder: 1, fasteners: 4, depth: 1, qty: 6, requires: ['P-01'] });
    }
  } else if (n === 2) {
    // Nine floor joists across the sill. G2: the left bay is drawn, the right is its mirror.
    for (let i = 0; i < 9; i++) {
      const x = -hx + (hx * 2) * i / 8;
      add('joist', 1 + Math.floor(i / 4), [x, 0.62, 0], { prefix: 'JST', slotPrefix: 'J', axis: 'z',
        yaw: Math.PI / 2, yawCandidates: 2, symmetryOrder: 1, fasteners: 3, depth: 1, qty: 9,
        mirror: i > 4, mirrorOf: i > 4 ? `J-0${9 - i}` : null });
    }
  } else if (n === 3) {
    // Four corner posts, fourteen studs. Two gussets are hidden behind the visible geometry.
    const corners = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
    corners.forEach(([x, z], i) => add('post', 1, [x, wall / 2 + 0.62, z], {
      prefix: 'CNR', slotPrefix: 'C', yawCandidates: 4, symmetryOrder: 1, fasteners: 4, depth: 1, qty: 4,
      label: i === 1 ? 'C-NE' : null,
    }));
    for (let i = 0; i < 10; i++) {
      const t = (i % 5 + 1) / 6;
      const z = i < 5 ? -hz : hz;
      add('post', 2 + Math.floor(i / 5), [-hx + hx * 2 * t, wall / 2 + 0.62, z], {
        prefix: 'STD', slotPrefix: 'W', yawCandidates: 4, symmetryOrder: 2, fasteners: 3, depth: 2, qty: 14 });
    }
    for (let i = 0; i < 2; i++) {
      add('gusset', 4, [i ? hx - 0.4 : -hx + 0.4, wall + 0.5, i ? hz : -hz], {
        prefix: 'GUS', slotPrefix: 'G', hidden: true, fasteners: 2, depth: 3, qty: 8 });
    }
  } else if (n === 4) {
    // Sheathing, the door, and G4's vehicle: two top plates that differ only in length.
    add('beam', 1, [0, wall + 0.7, -hz], { prefix: 'PLT', slotPrefix: 'T', axis: 'x', yawCandidates: 2, symmetryOrder: 1, fasteners: 4, depth: 1, qty: 2 });
    add('beamShort', 1, [hx - 1.3, wall + 0.7, hz], { prefix: 'PLT', slotPrefix: 'T', axis: 'x', yawCandidates: 2, symmetryOrder: 1, fasteners: 4, depth: 1, qty: 2 });
    for (let i = 0; i < 12; i++) {
      const x = -hx + (hx * 2) * (i % 6 + 0.5) / 6;
      const z = i < 6 ? -hz : hz;
      add('panel', 2 + Math.floor(i / 6), [x, wall / 2 + 0.62, z], {
        prefix: 'SHT', slotPrefix: 'K', yawCandidates: 2, symmetryOrder: 1, fasteners: 4, depth: 2, qty: 12 });
    }
    add('door', 4, [0, 1.65, hz], { prefix: 'DOR', slotPrefix: 'D', yawCandidates: 2, symmetryOrder: 1, fasteners: 3, depth: 3, qty: 1 });
    for (let i = 0; i < 3; i++) {
      add('hinge', 4, [-0.45, 0.9 + i * 0.55, hz], { prefix: 'HNG', slotPrefix: 'H', yawCandidates: 2, symmetryOrder: 1, fasteners: 2, depth: 4, qty: 3 });
    }
  } else if (n === 5) {
    // Trusses, purlins, ridge, and the 4.8 m north wall panel that requires two persons.
    for (let i = 0; i < 6; i++) {
      add('truss', 1 + Math.floor(i / 3), [-hx + (hx * 2) * i / 5, wall + 1.2, 0], {
        prefix: 'TRS', slotPrefix: 'R', yawCandidates: 2, symmetryOrder: 1, fasteners: 4, depth: 2, qty: 6 });
    }
    add('ridge', 3, [0, FOOT.ridge, 0], { prefix: 'RDG', slotPrefix: 'RB', axis: 'x', yawCandidates: 2, symmetryOrder: 1, fasteners: 6, depth: 3, qty: 1 });
    for (let i = 0; i < 6; i++) {
      add('batten', 4, [0, wall + 0.55 + i * 0.28, (i % 2 ? 1 : -1) * (1.2 + i * 0.22)], {
        prefix: 'PRL', slotPrefix: 'U', axis: 'x', yawCandidates: 2, symmetryOrder: 2, fasteners: 2, depth: 4, qty: 6 });
    }
    add('wallNorth', 5, [0, wall / 2 + 0.62, -hz], { prefix: 'WNR', slotPrefix: 'W', yawCandidates: 2, symmetryOrder: 1, fasteners: 6, depth: 3, qty: 1, ratedMass: 340 });
  } else if (n === 6) {
    for (let i = 0; i < 8; i++) {
      add('batten', 1, [0, wall + 0.5 + (i % 4) * 0.3, (i < 4 ? -1 : 1) * (0.9 + (i % 4) * 0.5)], {
        prefix: 'BTN', slotPrefix: 'A', axis: 'x', yawCandidates: 2, symmetryOrder: 2, fasteners: 2, depth: 2, qty: 8 });
    }
    for (let i = 0; i < 6; i++) {
      add('shingle', 2 + Math.floor(i / 3), [-2.5 + i, FOOT.ridge - 0.35, (i % 2 ? 1 : -1) * 1.1], {
        prefix: 'SHG', slotPrefix: 'N', yawCandidates: 2, symmetryOrder: 2, fasteners: 3, depth: 3, qty: 6 });
    }
    add('sink', 4, [-2.4, 1.5, -hz + 0.3], { prefix: 'SNK', slotPrefix: 'F', yawCandidates: 4, symmetryOrder: 1, fasteners: 2, depth: 3, qty: 1 });
    add('flue', 4, [2.6, wall + 0.5, -1.2], { prefix: 'FLU', slotPrefix: 'F', yawCandidates: 4, symmetryOrder: 4, fasteners: 2, depth: 3, qty: 1 });
    add('doorframe', 5, [0, 1.67, hz], { prefix: 'DFR', slotPrefix: 'E', yawCandidates: 2, symmetryOrder: 1, fasteners: 4, depth: 4, qty: 1, errata: true });
    for (let i = 0; i < 3; i++) {
      add('panel', 5, [1.4 + i * 1.2, 1.5, -hz], { prefix: 'GLZ', slotPrefix: 'V', yawCandidates: 2, symmetryOrder: 1, fasteners: 4, depth: 4, qty: 3 });
    }
  } else {
    // Night 7. Nothing structural remains. Two chairs, a hearth, a roof cap, a porch.
    add('hearth', 1, [-3.4, 0.25, -hz + 0.6], { prefix: 'HTH', slotPrefix: 'X', yawCandidates: 4, symmetryOrder: 2, fasteners: 0, depth: 1, qty: 1 });
    for (let i = 0; i < 4; i++) {
      add('board', 2, [-1.2 + i * 0.8, 0.62, hz + 0.9], { prefix: 'PCH', slotPrefix: 'Y', yawCandidates: 2, symmetryOrder: 2, fasteners: 2, depth: 2, qty: 4 });
    }
    add('batten', 3, [0, FOOT.ridge + 0.12, 0], { prefix: 'CAP', slotPrefix: 'Z', axis: 'x', yawCandidates: 2, symmetryOrder: 2, fasteners: 4, depth: 3, qty: 1 });
    for (let i = 0; i < 2; i++) {
      add('chair', 4 + i, [i ? 0.55 : -0.55, 0.65, i ? -0.3 : 0.3], {
        prefix: 'CHR', slotPrefix: 'Q', yaw: i ? 0.5 : -0.5, yawCandidates: 4, symmetryOrder: 1, fasteners: 4, depth: 4, qty: 2 });
    }
  }
  return { parts, slots };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 6. THE PEN — hand-styled stroking.
 *
 * Every mark in the manual goes through `strokePath`. The hand struct decides whether it looks
 * like a woman who drew for a living or a man who is trying very hard. Deterministic per stroke
 * seed, so a panel is identical every time it is baked (STORY §3.2).
 * ════════════════════════════════════════════════════════════════════════════════════════ */

const _pts = [];   // module-scope scratch; bake-time only, never touched in update()

/** 1-D value noise from the shared deterministic noise, so no new RNG state is created. */
function wob(t, seed) { return valueNoise2(t, seed * 0.7391) * 2 - 1; }

/**
 * @param {CanvasRenderingContext2D} c
 * @param {number[]} pts flat [x0,y0,x1,y1,...] in page units
 */
function strokePath(c, pts, opt) {
  if (!pts || pts.length < 4) return;
  const hand = opt.hand ?? HANDS.marit;
  const w = (opt.weight ?? WEIGHTS.medium) * (opt.weightScale ?? 1);
  const color = opt.color ?? PALETTE.ink;
  const seed = opt.seed ?? 1;
  const closed = !!opt.closed;
  const passes = opt.flat ? 1 : Math.max(1, Math.round(hand.strokeRepeat));
  const jitter = (opt.flat ? 0 : 1) * (opt.jitter ?? 1);

  // Eraser residue first — it was always under there.
  if (!opt.flat && hand.ghostAlpha > 0 && opt.ghost !== false) {
    c.save();
    c.globalAlpha = hand.ghostAlpha;
    c.strokeStyle = PALETTE.ghost;
    c.lineWidth = Math.max(0.6, w - 0.8);
    emit(c, pts, hand, seed + 977, jitter, closed, (3 + (seed % 5)) * 0.9, opt);
    c.restore();
  }

  c.save();
  c.strokeStyle = color;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  if (opt.dash) c.setLineDash(opt.dash);
  for (let p = 0; p < passes; p++) {
    c.globalAlpha = (opt.alpha ?? 1) * (p === 0 ? 1 : 0.72);
    const off = p === 0 ? 0 : 0.6 + (hashInt(seed + p) % 100) / 125;
    const pv = opt.flat ? 0 : hand.pressureVar;
    c.lineWidth = w * (1 + (p === 0 ? 0 : -0.12) + (pv ? (wob(p * 3.1, seed) * pv * 0.5) : 0));
    emit(c, pts, hand, seed + p * 131, jitter, closed, off, opt);
  }
  c.restore();

  function emit(cc, src, h, sd, jf, cl, offset, o) {
    _pts.length = 0;
    // Resample into ~5-unit steps so the wobble reads as a hand and not as a polygon.
    const step = o.step ?? 5.5;
    for (let i = 0; i + 3 < src.length; i += 2) {
      const x0 = src[i], y0 = src[i + 1], x1 = src[i + 2], y1 = src[i + 3];
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      const n = Math.max(1, Math.ceil(len / step));
      for (let k = 0; k < n; k++) _pts.push(x0 + dx * (k / n), y0 + dy * (k / n));
      // Corner overshoot: run past the vertex, then come back. The "trying hard" tell.
      if (h.cornerOvershoot > 0 && i + 5 < src.length && len > 1e-4) {
        const o2 = h.cornerOvershoot;
        _pts.push(x1 + dx / len * o2, y1 + dy / len * o2);
      }
    }
    _pts.push(src[src.length - 2], src[src.length - 1]);
    if (cl) _pts.push(src[0] + (h.closureError ? h.closureError : 0), src[1]);

    cc.beginPath();
    let acc = 0;
    for (let i = 0; i < _pts.length; i += 2) {
      let x = _pts[i], y = _pts[i + 1];
      if (i > 0) acc += Math.hypot(x - _pts[i - 2], y - _pts[i - 1]);
      if (jf && h.wobbleAmp > 0) {
        const ix = i === 0 ? 2 : i;
        const px = _pts[ix - 2], py = _pts[ix - 1];
        const nx0 = (_pts[Math.min(ix, _pts.length - 2)] - px);
        const ny0 = (_pts[Math.min(ix + 1, _pts.length - 1)] - py);
        const l = Math.hypot(nx0, ny0) || 1;
        const a = wob(acc * h.wobbleFreq / 100, sd) * h.wobbleAmp * jf;
        x += (-ny0 / l) * a; y += (nx0 / l) * a;
      }
      if (offset) { x += offset * 0.42; y += offset * 0.31; }
      if (i === 0) cc.moveTo(x, y); else cc.lineTo(x, y);
    }
    cc.stroke();
  }
}

/** Convenience: stroke a list of [x,y] pairs. */
function strokePoly(c, poly, opt) {
  const flat = [];
  for (const p of poly) flat.push(p[0], p[1]);
  strokePath(c, flat, opt);
}

function fillDot(c, x, y, r, color = PALETTE.ink) {
  c.save(); c.fillStyle = color; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); c.restore();
}

function circlePts(cx, cy, r, seg = 24, a0 = 0, a1 = Math.PI * 2) {
  const out = [];
  for (let i = 0; i <= seg; i++) {
    const a = a0 + (a1 - a0) * (i / seg);
    out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return out;
}

/**
 * Draw text in the single-stroke font. The ONLY strings this is ever called with are article
 * numbers, HJEM, VIK & SØN, assembly names on the cover, and numerals inside call-outs.
 */
function drawText(c, str, x, y, size, opt = {}) {
  const s = String(str ?? '');
  const k = size / 10;
  let cx = x;
  if (opt.align === 'center') cx -= measureText(s, size) / 2;
  else if (opt.align === 'right') cx -= measureText(s, size);
  for (const ch of s) {
    const g = (opt.tracedO && ch === 'Ø') ? GLYPH_O_TRACED : GLYPHS_VEC[ch];
    if (g) {
      for (let i = 0; i < g.length; i++) {
        const poly = g[i];
        const flat = [];
        for (const p of poly) flat.push(cx + p[0] * k, y + p[1] * k);
        strokePath(c, flat, {
          hand: opt.hand ?? HANDS.marit, weight: opt.weight ?? WEIGHTS.thin,
          color: opt.color ?? PALETTE.ink, seed: (opt.seed ?? 7) + i * 13 + ch.charCodeAt(0),
          step: 3.2, jitter: opt.jitter ?? 0.7, ghost: false, alpha: opt.alpha ?? 1,
        });
      }
    } else if (ch !== ' ') {
      Log.once(`bp:glyph:${ch}`, `Blueprint: no vector glyph for '${ch}'`);
    }
    cx += advanceOf(ch) * k;
  }
  return cx - x;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 7. BJØRN — the mascot.
 *
 * STORY §3.3: 4.5 heads tall, head a perfect circle, two filled dots for a face, spacing 1.42×
 * anatomical. No mouth, ever, except panel 2.6 and Ending A. He is never in danger and never
 * reacts to anything frightening. That rule is the engine of the whole thing.
 *
 * Marit draws him with rounded shoulders and a slight forward lean, as if listening.
 * Ansel draws him taller, shoulders square, no lean.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

const MASCOT_POSES = {
  'standing-neutral': { la: [[-0.16, 0.42], [-0.18, 0.24]], ra: [[0.16, 0.42], [0.18, 0.24]] },
  'arms-at-sides': { la: [[-0.13, 0.44], [-0.13, 0.22]], ra: [[0.13, 0.44], [0.13, 0.22]] },
  waving: { la: [[-0.28, 0.74], [-0.36, 0.92]], ra: [[0.28, 0.74], [0.36, 0.92]] },
  'arms-up': { la: [[-0.24, 0.80], [-0.20, 1.00]], ra: [[0.24, 0.80], [0.20, 1.00]] },
  'thumbs-up': { la: [[-0.17, 0.42], [-0.19, 0.24]], ra: [[0.22, 0.62], [0.20, 0.76]], thumb: true },
  'scratch-head': { la: [[-0.17, 0.42], [-0.19, 0.24]], ra: [[0.26, 0.76], [0.10, 0.94]], scratch: true },
  hammer: { la: [[-0.17, 0.42], [-0.19, 0.24]], ra: [[0.27, 0.60], [0.30, 0.44]], hammer: true },
  'hand-raised': { la: [[-0.16, 0.42], [-0.18, 0.24]], ra: [[0.26, 0.72], [0.24, 0.96]] },
  tapping: { la: [[-0.20, 0.58], [0.04, 0.50]], ra: [[0.20, 0.58], [-0.04, 0.50]], tap: true },
  pointing: { la: [[-0.16, 0.42], [-0.18, 0.24]], ra: [[0.30, 0.66], [0.52, 0.68]] },
  kneeling: { la: [[-0.20, 0.40], [-0.10, 0.26]], ra: [[0.20, 0.40], [0.10, 0.26]], kneel: true },
  'carry-shoulder': { la: [[-0.20, 0.50], [-0.14, 0.72]], ra: [[0.22, 0.62], [0.14, 0.80]], carry: true },
  'standing-over': { la: [[-0.15, 0.42], [-0.16, 0.22]], ra: [[0.15, 0.42], [0.16, 0.22]], over: true },
  watching: { la: [[-0.14, 0.44], [-0.14, 0.22]], ra: [[0.14, 0.44], [0.14, 0.22]] },
  dragging: { la: [[-0.22, 0.44], [-0.32, 0.30]], ra: [[0.10, 0.44], [-0.24, 0.28]], drag: true },
  seated: { la: [[-0.16, 0.42], [-0.18, 0.28]], ra: [[0.16, 0.42], [0.18, 0.28]], seated: true },
};

/**
 * @param {number} h  height in page units (1.7 m at the figure's scale, or a fixed glyph size)
 */
function drawMascot(c, x, yFeet, h, opt = {}) {
  const hand = opt.hand ?? HANDS.marit;
  const pose = MASCOT_POSES[opt.pose] ?? MASCOT_POSES['standing-neutral'];
  const H = h * (opt.ignoreHandScale ? 1 : hand.figure.heightScale) * (opt.scale ?? 1);
  const lean = (hand.figure.lean * (opt.lean ?? 1)) * D2R;
  const round = hand.figure.shoulders === 'round';
  const seed = opt.seed ?? 31;
  const dotted = !!opt.dotted;
  const col = opt.color ?? PALETTE.ink;
  const wgt = opt.weight ?? WEIGHTS.figure;
  const so = { hand, weight: wgt, color: col, seed, step: 4.0, dash: dotted ? [4, 5] : null, alpha: opt.alpha ?? 1 };

  // Local frame: u right, v up, origin at the feet. Lean tilts everything above the hips.
  const P = (u, v) => {
    let uu = u * H, vv = v * H;
    if (v > 0.42 && lean) {
      const dv = vv - 0.42 * H;
      uu += Math.sin(lean) * dv; vv = 0.42 * H + Math.cos(lean) * dv;
    }
    return [x + uu, yFeet - vv];
  };
  const seg = (a, b, o) => strokePoly(c, [P(a[0], a[1]), P(b[0], b[1])], { ...so, ...o });

  const headR = (1 / 4.5) / 2;                 // head diameter = H/4.5
  const headC = P(0, 1 - headR);
  const shoulderY = 0.70, hipY = 0.44;

  if (pose.kneel) { /* the kneel drops the hips; handled by the leg draw below */ }

  // Head — a perfect circle. Not a mask. A drawing of a face by someone drawing quickly.
  strokePath(c, circlePts(headC[0], headC[1], headR * H, 22), { ...so, closed: false, seed: seed + 3 });
  // Two filled dots. Spacing 1.42× anatomical. Nothing else.
  const eyeDx = headR * H * 0.639;
  const eyeR = Math.max(1.1, wgt * 0.5);
  if (!dotted) {
    fillDot(c, headC[0] - eyeDx, headC[1] - headR * H * 0.08, eyeR, col);
    fillDot(c, headC[0] + eyeDx, headC[1] - headR * H * 0.08, eyeR, col);
  }
  if (opt.mouth) {
    // One flat line, 9 px at page scale. Panel 2.6 and Ending A. Nowhere else, ever.
    const mw = headR * H * 0.62;
    strokePoly(c, [[headC[0] - mw / 2, headC[1] + headR * H * 0.42], [headC[0] + mw / 2, headC[1] + headR * H * 0.42]],
      { ...so, weight: WEIGHTS.hairline * 1.2, seed: seed + 91 });
  }

  // Neck + torso.
  seg([0, 1 - headR * 2], [0, shoulderY + 0.03]);
  const sw = 0.155, hw = 0.115;
  if (round) {
    const t = [];
    t.push(P(-hw, hipY), P(-sw, shoulderY - 0.05));
    for (let i = 0; i <= 6; i++) {
      const a = Math.PI - (Math.PI / 2) * (i / 6);
      t.push(P(Math.cos(a) * sw, shoulderY - 0.05 + Math.sin(a) * 0.05));
    }
    t.push(P(sw, shoulderY - 0.05), P(hw, hipY));
    strokePoly(c, t, { ...so, seed: seed + 11 });
  } else {
    strokePoly(c, [P(-hw, hipY), P(-sw, shoulderY), P(sw, shoulderY), P(hw, hipY)], { ...so, seed: seed + 11 });
  }
  strokePoly(c, [P(-hw, hipY), P(hw, hipY)], { ...so, seed: seed + 12 });

  // Arms — two segments each, from the shoulder to the pose's hand target.
  const shL = [-sw * 0.92, shoulderY - 0.02], shR = [sw * 0.92, shoulderY - 0.02];
  seg(shL, pose.la[0], { seed: seed + 21 }); seg(pose.la[0], pose.la[1], { seed: seed + 22 });
  seg(shR, pose.ra[0], { seed: seed + 23 }); seg(pose.ra[0], pose.ra[1], { seed: seed + 24 });

  // Legs.
  if (pose.seated) {
    seg([-0.09, hipY], [-0.09, 0.24]); seg([-0.09, 0.24], [-0.30, 0.24]);
    seg([0.09, hipY], [0.09, 0.24]); seg([0.09, 0.24], [-0.30, 0.24]);
    seg([-0.30, 0.24], [-0.30, 0.02]);
  } else if (pose.kneel) {
    seg([-0.09, hipY], [-0.12, 0.16]); seg([-0.12, 0.16], [0.14, 0.14]);
    seg([0.09, hipY], [0.12, 0.02]);
  } else {
    seg([-0.09, hipY], [-0.10, 0.02], { seed: seed + 31 });
    seg([0.09, hipY], [0.10, 0.02], { seed: seed + 32 });
    seg([-0.10, 0.02], [-0.17, 0.0], { seed: seed + 33 });
    seg([0.10, 0.02], [0.17, 0.0], { seed: seed + 34 });
  }

  // Pose extras.
  if (pose.hammer) {
    const g = P(pose.ra[1][0], pose.ra[1][1]);
    const head = P(pose.ra[1][0] + 0.02, pose.ra[1][1] - 0.20);
    strokePoly(c, [g, head], { ...so, weight: WEIGHTS.thin, seed: seed + 41 });
    strokePoly(c, [[head[0] - H * 0.05, head[1] - H * 0.012], [head[0] + H * 0.05, head[1] - H * 0.012],
      [head[0] + H * 0.05, head[1] + H * 0.012], [head[0] - H * 0.05, head[1] + H * 0.012],
      [head[0] - H * 0.05, head[1] - H * 0.012]], { ...so, weight: WEIGHTS.medium, seed: seed + 42 });
    // The grip is the only red on the figure. STORY §3.3.
    strokePoly(c, [g, [g[0] + (head[0] - g[0]) * 0.34, g[1] + (head[1] - g[1]) * 0.34]],
      { ...so, color: opt.noRed ? col : PALETTE.red, weight: WEIGHTS.heavy, seed: seed + 43 });
  }
  if (pose.thumb) {
    const g = P(pose.ra[1][0], pose.ra[1][1]);
    strokePoly(c, [g, [g[0] + H * 0.012, g[1] - H * 0.055]], { ...so, weight: WEIGHTS.thin, seed: seed + 44 });
  }
  if (pose.tap) {
    // Motion ticks beside one foot. It is waiting for you.
    const f = P(0.17, 0.0);
    for (let i = 0; i < 3; i++) {
      strokePoly(c, [[f[0] + H * (0.05 + i * 0.028), f[1] - H * 0.02], [f[0] + H * (0.075 + i * 0.028), f[1] - H * 0.045]],
        { ...so, weight: WEIGHTS.hairline, seed: seed + 51 + i });
    }
  }
  if (pose.scratch) {
    for (let i = 0; i < 2; i++) {
      const a = P(0.16 + i * 0.05, 0.98 + i * 0.02);
      strokePoly(c, [a, [a[0] + H * 0.03, a[1] - H * 0.03]], { ...so, weight: WEIGHTS.hairline, seed: seed + 61 + i });
    }
  }
  if (pose.carry) {
    strokePoly(c, [P(-0.62, 0.86), P(0.62, 0.80)], { ...so, weight: WEIGHTS.heavy, seed: seed + 71 });
  }
  return { headC, H, top: yFeet - H };
}

/** The horizontal shape with shoes. It is not a joist. Panel 4.9. No comment is made. */
function drawHorizontalShape(c, x, y, len, opt = {}) {
  const so = { hand: opt.hand ?? HANDS.ansel, weight: WEIGHTS.heavy, color: PALETTE.ink, seed: opt.seed ?? 409, step: 4 };
  const h = len * 0.135;
  strokePoly(c, [[x - len / 2, y], [x + len / 2 - h * 0.9, y], [x + len / 2, y - h * 0.55],
    [x + len / 2 - h * 0.7, y - h], [x - len / 2 + h * 0.5, y - h], [x - len / 2, y - h * 0.5],
    [x - len / 2, y]], { ...so, closed: true });
  // Shoes.
  for (const s of [-1, 1]) {
    strokePoly(c, [[x + len / 2 - h * 0.1, y - h * 0.2 + s * h * 0.30],
      [x + len / 2 + h * 0.55, y - h * 0.34 + s * h * 0.42],
      [x + len / 2 + h * 0.60, y - h * 0.05 + s * h * 0.42],
      [x + len / 2 - h * 0.05, y + h * 0.06 + s * h * 0.30]],
    { ...so, weight: WEIGHTS.medium, seed: (opt.seed ?? 409) + 11 + s, closed: true });
  }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 8. THE ARROW VOCABULARY AND THE GLYPH SET.
 *
 * GAME_DESIGN §6.8's table is a CLOSED SET. Blueprint draws nothing that is not in it.
 * Arrow forms are straight and single-arc only.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

function arrowHead(c, x, y, dx, dy, size, opt = {}) {
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l, uy = dy / l, px = -uy, py = ux;
  c.save();
  c.fillStyle = opt.color ?? PALETTE.ink;
  c.globalAlpha = opt.alpha ?? 1;
  c.beginPath();
  c.moveTo(x, y);
  c.lineTo(x - ux * size + px * size * 0.36, y - uy * size + py * size * 0.36);
  c.lineTo(x - ux * size * 0.76, y - uy * size * 0.76);
  c.lineTo(x - ux * size - px * size * 0.36, y - uy * size - py * size * 0.36);
  c.closePath();
  c.fill();
  c.restore();
}

/** INSERT along this vector. */
function arrowStraight(c, x0, y0, x1, y1, opt = {}) {
  const size = opt.size ?? 13;
  const dx = x1 - x0, dy = y1 - y0;
  const l = Math.hypot(dx, dy) || 1;
  strokePath(c, [x0, y0, x1 - dx / l * size * 0.7, y1 - dy / l * size * 0.7],
    { weight: WEIGHTS.medium, ...opt, step: 6 });
  arrowHead(c, x1, y1, dx, dy, size, opt);
}

/** ROTATE this many degrees — arc length encodes the angle. */
function arrowCurved(c, cx, cy, r, a0, a1, opt = {}) {
  const size = opt.size ?? 11;
  const pts = circlePts(cx, cy, r, 26, a0, a1);
  strokePath(c, pts, { weight: WEIGHTS.medium, ...opt, step: 5 });
  const ex = cx + Math.cos(a1) * r, ey = cy + Math.sin(a1) * r;
  const dir = a1 > a0 ? 1 : -1;
  arrowHead(c, ex, ey, -Math.sin(a1) * dir, Math.cos(a1) * dir, size, opt);
}

/** ALIGN / dimension — double-headed, with witness ticks. */
function arrowDouble(c, x0, y0, x1, y1, opt = {}) {
  const size = opt.size ?? 10;
  const dx = x1 - x0, dy = y1 - y0;
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l, uy = dy / l;
  strokePath(c, [x0 + ux * size * 0.6, y0 + uy * size * 0.6, x1 - ux * size * 0.6, y1 - uy * size * 0.6],
    { weight: WEIGHTS.hairline, color: PALETTE.inkSoft, ...opt, step: 6 });
  arrowHead(c, x1, y1, ux, uy, size, opt);
  arrowHead(c, x0, y0, -ux, -uy, size, opt);
  if (opt.witness) {
    const px = -uy * (opt.witness), py = ux * (opt.witness);
    strokePath(c, [x0 - px * 0.35, y0 - py * 0.35, x0 + px, y0 + py], { weight: WEIGHTS.hairline, color: PALETTE.inkSoft, ...opt });
    strokePath(c, [x1 - px * 0.35, y1 - py * 0.35, x1 + px, y1 + py], { weight: WEIGHTS.hairline, color: PALETTE.inkSoft, ...opt });
  }
  // A dimension with unit divisions and no numeral: G4's only clue is the ratio you count.
  if (opt.divisions > 0) {
    for (let i = 1; i < opt.divisions; i++) {
      const t = i / opt.divisions;
      const mx = x0 + dx * t, my = y0 + dy * t;
      strokePath(c, [mx - (-uy) * 3.4, my - ux * 3.4, mx + (-uy) * 3.4, my + ux * 3.4],
        { weight: WEIGHTS.hairline, color: PALETTE.inkSoft, seed: (opt.seed ?? 5) + i });
    }
  }
}

/** TIGHTEN — the circular torque spiral. */
function arrowCircular(c, cx, cy, r, opt = {}) {
  const pts = [];
  const turns = opt.turns ?? 1.0;
  const n = 40;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = -Math.PI * 0.4 + t * Math.PI * 2 * turns;
    const rr = r * (0.72 + 0.28 * t);
    pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  strokePath(c, pts, { weight: WEIGHTS.medium, ...opt, step: 5 });
  const aEnd = -Math.PI * 0.4 + Math.PI * 2 * turns;
  arrowHead(c, pts[pts.length - 2], pts[pts.length - 1], -Math.sin(aEnd), Math.cos(aEnd), opt.size ?? 11, opt);
}

/** DO NOT DO THIS. The red slash-circle over the variant that looks correct. */
function slashCircle(c, cx, cy, r, opt = {}) {
  const col = opt.color ?? PALETTE.red;
  strokePath(c, circlePts(cx, cy, r, 30), { weight: WEIGHTS.heavy, color: col, ...opt, seed: (opt.seed ?? 3) + 1 });
  const d = r * 0.7071;
  strokePath(c, [cx - d, cy - d, cx + d, cy + d], { weight: WEIGHTS.heavy, color: col, ...opt, seed: (opt.seed ?? 3) + 2 });
  // Redundant encoding: colour is never the only channel (Script.PANEL_RULES).
  strokePath(c, circlePts(cx, cy, r + 4.5, 30), { weight: WEIGHTS.hairline, color: col, dash: [3, 4], ...opt, seed: (opt.seed ?? 3) + 3 });
}

/** A crossed-out panel: the whole figure is forbidden. */
function crossOutBox(c, x, y, w, h, opt = {}) {
  const col = opt.color ?? PALETTE.red;
  strokePath(c, [x, y, x + w, y, x + w, y + h, x, y + h, x, y],
    { weight: WEIGHTS.medium, color: col, dash: [7, 5], ...opt, seed: (opt.seed ?? 8) });
  strokePath(c, [x + 8, y + 8, x + w - 8, y + h - 8], { weight: WEIGHTS.heavy, color: col, ...opt, seed: (opt.seed ?? 8) + 1 });
  strokePath(c, [x + w - 8, y + 8, x + 8, y + h - 8], { weight: WEIGHTS.heavy, color: col, ...opt, seed: (opt.seed ?? 8) + 2 });
}

/** Circled step number. Dashed ring = order is NOT enforced. */
function stepCircle(c, cx, cy, n, opt = {}) {
  const r = opt.r ?? 15;
  strokePath(c, circlePts(cx, cy, r, 24), {
    weight: WEIGHTS.medium, dash: opt.dashed ? [5, 4] : null, ...opt, seed: (opt.seed ?? 2), closed: false,
  });
  drawText(c, String(n), cx, cy - r * 0.52, r * 1.05, { align: 'center', hand: opt.hand, weight: WEIGHTS.thin, seed: (opt.seed ?? 2) + 5, color: opt.color });
}

/** Hardware call-out: a circle with ×N. Numerals only, no words. */
function hardwareCallout(c, cx, cy, count, opt = {}) {
  const r = opt.r ?? 19;
  strokePath(c, circlePts(cx, cy, r, 26), { weight: WEIGHTS.medium, ...opt, seed: (opt.seed ?? 4) });
  const label = `×${count}`;
  drawText(c, label, cx, cy - r * 0.46, r * 0.92, { align: 'center', hand: opt.hand, weight: WEIGHTS.thin, seed: (opt.seed ?? 4) + 3, color: opt.color });
}

/** The bag icon with a count — the stage's hardware manifest. */
function bagIcon(c, x, y, s, count, opt = {}) {
  strokePoly(c, [[x - s * 0.42, y - s * 0.55], [x - s * 0.30, y - s * 0.80], [x + s * 0.30, y - s * 0.80],
    [x + s * 0.42, y - s * 0.55], [x + s * 0.46, y + s * 0.42], [x - s * 0.46, y + s * 0.42],
    [x - s * 0.42, y - s * 0.55]], { weight: WEIGHTS.medium, closed: true, ...opt });
  strokePoly(c, [[x - s * 0.18, y - s * 0.80], [x - s * 0.18, y - s * 0.98], [x + s * 0.18, y - s * 0.98], [x + s * 0.18, y - s * 0.80]],
    { weight: WEIGHTS.thin, ...opt, seed: (opt.seed ?? 6) + 1 });
  drawText(c, `×${count}`, x, y - s * 0.14, s * 0.44, { align: 'center', hand: opt.hand, weight: WEIGHTS.thin, seed: (opt.seed ?? 6) + 2, color: opt.color });
}

/** The fastener ring: one small circle per fastener the stage needs. Filled = in your pocket. */
function fastenerRing(c, cx, cy, r, required, held, opt = {}) {
  for (let i = 0; i < required; i++) {
    const a = -Math.PI / 2 + (i / Math.max(1, required)) * Math.PI * 2;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    strokePath(c, circlePts(x, y, 4.6, 12), { weight: WEIGHTS.thin, ...opt, seed: (opt.seed ?? 9) + i });
    if (i < held) fillDot(c, x, y, 3.0, opt.color ?? PALETTE.ink);
  }
}

/** The mirror glyph: an hourglass over a dashed axis. G2 is in effect for this figure. */
function mirrorGlyph(c, cx, cy, s, opt = {}) {
  strokePoly(c, [[cx - s, cy - s], [cx + s, cy - s], [cx - s, cy + s], [cx + s, cy + s], [cx - s, cy - s]],
    { weight: WEIGHTS.medium, ...opt, closed: true });
}

/** The little telephone. Learning what it means is a Night Six beat. */
function telephoneGlyph(c, cx, cy, s, opt = {}) {
  strokePoly(c, [[cx - s * 0.7, cy + s * 0.5], [cx - s * 0.7, cy - s * 0.1], [cx - s * 0.36, cy - s * 0.42],
    [cx + s * 0.36, cy - s * 0.42], [cx + s * 0.7, cy - s * 0.1], [cx + s * 0.7, cy + s * 0.5]],
  { weight: WEIGHTS.medium, ...opt });
  strokePoly(c, [[cx - s * 0.78, cy + s * 0.5], [cx - s * 0.34, cy + s * 0.5], [cx - s * 0.34, cy + s * 0.22],
    [cx + s * 0.34, cy + s * 0.22], [cx + s * 0.34, cy + s * 0.5], [cx + s * 0.78, cy + s * 0.5]],
  { weight: WEIGHTS.medium, ...opt, seed: (opt.seed ?? 12) + 1 });
  strokePoly(c, [[cx, cy - s * 0.42], [cx, cy - s * 0.86]], { weight: WEIGHTS.thin, ...opt, seed: (opt.seed ?? 12) + 2 });
}

/** The over-torque warning triangle. Red, and it means it. */
function warnTriangle(c, cx, cy, s, opt = {}) {
  const col = opt.color ?? PALETTE.red;
  strokePoly(c, [[cx, cy - s], [cx + s * 0.92, cy + s * 0.66], [cx - s * 0.92, cy + s * 0.66], [cx, cy - s]],
    { weight: WEIGHTS.heavy, color: col, closed: true, ...opt });
  strokePoly(c, [[cx, cy - s * 0.42], [cx, cy + s * 0.16]], { weight: WEIGHTS.heavy, color: col, ...opt, seed: (opt.seed ?? 14) + 1 });
  fillDot(c, cx, cy + s * 0.40, 2.6, col);
}

/** A tick. The manual is pleased. */
function tickMark(c, x, y, s, opt = {}) {
  strokePoly(c, [[x - s * 0.5, y], [x - s * 0.12, y + s * 0.42], [x + s * 0.6, y - s * 0.55]],
    { weight: WEIGHTS.heavy, ...opt });
}

/** A drawn sparkle. Night One only. Nobody is ever this pleased with you again. */
function sparkle(c, x, y, s, opt = {}) {
  strokePoly(c, [[x, y - s], [x, y + s]], { weight: WEIGHTS.thin, ...opt });
  strokePoly(c, [[x - s, y], [x + s, y]], { weight: WEIGHTS.thin, ...opt, seed: (opt.seed ?? 17) + 1 });
  strokePoly(c, [[x - s * 0.6, y - s * 0.6], [x + s * 0.6, y + s * 0.6]], { weight: WEIGHTS.hairline, ...opt, seed: (opt.seed ?? 17) + 2 });
  strokePoly(c, [[x + s * 0.6, y - s * 0.6], [x - s * 0.6, y + s * 0.6]], { weight: WEIGHTS.hairline, ...opt, seed: (opt.seed ?? 17) + 3 });
}

/** The magnifier. Panel 1.4. In case you missed the bolt. */
function magnifier(c, cx, cy, r, opt = {}) {
  strokePath(c, circlePts(cx, cy, r, 28), { weight: WEIGHTS.heavy, ...opt });
  strokePath(c, [cx + r * 0.72, cy + r * 0.72, cx + r * 1.5, cy + r * 1.5], { weight: WEIGHTS.heavy, ...opt, seed: (opt.seed ?? 19) + 1 });
}

/* ── Arrow routing: A* on a page grid, then fitted to the closed set (straight | single arc). ── */

const ROUTE_CELL = 8;

function makeRouteGrid(w, h, obstacles, clearance = 6) {
  const gw = Math.max(1, Math.ceil(w / ROUTE_CELL));
  const gh = Math.max(1, Math.ceil(h / ROUTE_CELL));
  const g = new Uint8Array(gw * gh);
  for (const o of obstacles) {
    const x0 = Math.max(0, Math.floor((o.x - clearance) / ROUTE_CELL));
    const y0 = Math.max(0, Math.floor((o.y - clearance) / ROUTE_CELL));
    const x1 = Math.min(gw - 1, Math.ceil((o.x + o.w + clearance) / ROUTE_CELL));
    const y1 = Math.min(gh - 1, Math.ceil((o.y + o.h + clearance) / ROUTE_CELL));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y * gw + x] = 1;
  }
  return { g, gw, gh };
}

/** Cost 1.0/cell, +2.4 per direction change, +8.0 per crossing (GAME_DESIGN §8.4). */
function routeArrow(grid, ax, ay, bx, by) {
  const { g, gw, gh } = grid;
  const sx = Math.min(gw - 1, Math.max(0, Math.round(ax / ROUTE_CELL)));
  const sy = Math.min(gh - 1, Math.max(0, Math.round(ay / ROUTE_CELL)));
  const tx = Math.min(gw - 1, Math.max(0, Math.round(bx / ROUTE_CELL)));
  const ty = Math.min(gh - 1, Math.max(0, Math.round(by / ROUTE_CELL)));
  const N = gw * gh;
  const cost = new Float32Array(N).fill(Infinity);
  const from = new Int32Array(N).fill(-1);
  const dirOf = new Int8Array(N).fill(-1);
  const open = [sy * gw + sx];
  cost[sy * gw + sx] = 0;
  const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];
  const hEst = (i) => (Math.abs(i % gw - tx) + Math.abs((i / gw | 0) - ty));
  let guard = 0;
  while (open.length && guard++ < 40000) {
    let bi = 0, bv = Infinity;
    for (let i = 0; i < open.length; i++) {
      const v = cost[open[i]] + hEst(open[i]);
      if (v < bv) { bv = v; bi = i; }
    }
    const cur = open.splice(bi, 1)[0];
    if (cur === ty * gw + tx) break;
    const cx = cur % gw, cy = cur / gw | 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d], ny = cy + DY[d];
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const ni = ny * gw + nx;
      if (g[ni] === 1 && ni !== ty * gw + tx) continue;
      const turn = dirOf[cur] >= 0 && dirOf[cur] !== d ? 2.4 : 0;
      const cross = g[ni] === 2 ? 8.0 : 0;
      const nc = cost[cur] + 1 + turn + cross;
      if (nc < cost[ni]) { cost[ni] = nc; from[ni] = cur; dirOf[ni] = d; if (!open.includes(ni)) open.push(ni); }
    }
  }
  const goal = ty * gw + tx;
  if (!isFinite(cost[goal])) return null;
  const path = [];
  for (let i = goal; i >= 0; i = from[i]) {
    path.push([(i % gw) * ROUTE_CELL, (i / gw | 0) * ROUTE_CELL]);
    if (i === sy * gw + sx) break;
  }
  path.reverse();
  for (const p of path) {
    const gi = Math.round(p[1] / ROUTE_CELL) * gw + Math.round(p[0] / ROUTE_CELL);
    if (gi >= 0 && gi < N && g[gi] === 0) g[gi] = 2;   // mark as routed; crossings cost extra
  }
  return path;
}

/** Fit a routed corridor to the closed arrow set: straight if clear, else one arc. */
function drawRoutedArrow(c, grid, ax, ay, bx, by, opt = {}) {
  const path = grid ? routeArrow(grid, ax, ay, bx, by) : null;
  if (!path || path.length < 3) { arrowStraight(c, ax, ay, bx, by, opt); return; }
  // Deviation of the corridor from the chord decides the arc's bulge.
  const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1;
  const nx = -dy / l, ny = dx / l;
  let dev = 0;
  for (const p of path) {
    const d = (p[0] - ax) * nx + (p[1] - ay) * ny;
    if (Math.abs(d) > Math.abs(dev)) dev = d;
  }
  if (Math.abs(dev) < 9) { arrowStraight(c, ax, ay, bx, by, opt); return; }
  const sag = Math.max(-l * 0.6, Math.min(l * 0.6, dev));
  const r = (sag * sag + (l * l) / 4) / (2 * Math.abs(sag));
  const mx = (ax + bx) / 2 + nx * (sag - Math.sign(sag) * r), my = (ay + by) / 2 + ny * (sag - Math.sign(sag) * r);
  const a0 = Math.atan2(ay - my, ax - mx), a1 = Math.atan2(by - my, bx - mx);
  let da = a1 - a0;
  while (da > Math.PI) da -= Math.PI * 2;
  while (da < -Math.PI) da += Math.PI * 2;
  arrowCurved(c, mx, my, r, a0, a0 + da, opt);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 9. FIGURE CONSTRUCTION — explode, hidden-line removal, projection.
 *
 * This is the part that makes the manual a puzzle rather than a picture: the lines on the page
 * are the actual edges of the actual part, occluded by the actual geometry it will sit behind.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * 4 mm. A point this far in front of a face counts as in front of it, which is what lets a
 * solid hide its OWN back edges (true hidden-line removal, not a wireframe) without the faces it
 * is flush against — a sill sitting on a pier — eating its silhouette.
 */
const HLR_EPS = 0.004;
/** Far bound on the ray toward the viewer, in metres. The plot is 6.4 m across. */
const HLR_FAR = 1e3;

/* ── The BSP (GAME_DESIGN §8.3) ────────────────────────────────────────────────────────────
 *
 * §8.3: "Build a BSP tree of the stage's assembled hull, in figure space, once per stage. Each
 * part's silhouette edges are clipped against the BSP."
 *
 * The tree partitions FIGURE SPACE PROJECTED — the (u,v) page plane — with axis-aligned splitting
 * planes, median-split, straddlers duplicated into both children. That is the partition that
 * matters: two solids can only occlude one another if their silhouettes overlap on the page, so
 * a page-plane BSP is the one that actually rejects work. Depth is kept as the third coordinate
 * and resolved exactly at the leaves.
 *
 * The clip itself is EXACT, not sampled. v1 took 16 samples along each edge and bisected the
 * boundaries four times, which quantised every occlusion boundary to ~1/256 of an edge and drew
 * visible stubs of hidden line at the joints. For a convex solid the hidden set of a segment is a
 * single interval and it is computable in closed form — see `hiddenInterval`.
 */
const BSP_LEAF = 6;
const BSP_MAX_DEPTH = 12;

function bspBuild(items, depth) {
  if (items.length <= BSP_LEAF || depth >= BSP_MAX_DEPTH) return { items };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of items) {
    if (it.x0 < x0) x0 = it.x0; if (it.x1 > x1) x1 = it.x1;
    if (it.y0 < y0) y0 = it.y0; if (it.y1 > y1) y1 = it.y1;
  }
  const axis = (x1 - x0) >= (y1 - y0) ? 0 : 1;
  const centres = items.map((it) => (axis ? (it.y0 + it.y1) : (it.x0 + it.x1)) * 0.5);
  centres.sort((a, b) => a - b);
  const split = centres[centres.length >> 1];
  const left = []; const right = [];
  for (const it of items) {
    const lo = axis ? it.y0 : it.x0;
    const hi = axis ? it.y1 : it.x1;
    if (hi <= split) left.push(it);
    else if (lo >= split) right.push(it);
    else { left.push(it); right.push(it); }
  }
  // A split that separates nothing is worse than a leaf.
  if (!left.length || !right.length || left.length === items.length || right.length === items.length) {
    return { items };
  }
  return { axis, split, left: bspBuild(left, depth + 1), right: bspBuild(right, depth + 1) };
}

/** Every occluding solid in the stage's assembled hull, indexed by page-plane silhouette. */
function buildOccluderBSP(instances) {
  const items = [];
  for (const inst of instances) {
    // G3: a part marked hidden is drawn dotted THROUGH the occluder, and never occludes.
    if (inst.occlude === false || inst.dotted) continue;
    for (const q of inst.solids) {
      items.push({ q, inst, x0: q.sx0, y0: q.sy0, x1: q.sx1, y1: q.sy1, stamp: -1 });
    }
  }
  return { root: bspBuild(items, 0), count: items.length };
}

let _bspStamp = 0;
function bspQuery(node, x0, y0, x1, y1, stamp, out) {
  if (!node) return out;
  if (node.items) {
    for (const it of node.items) {
      if (it.stamp === stamp) continue;
      if (x1 < it.x0 || x0 > it.x1 || y1 < it.y0 || y0 > it.y1) continue;
      it.stamp = stamp;
      out.push(it);
    }
    return out;
  }
  const lo = node.axis ? y0 : x0;
  const hi = node.axis ? y1 : x1;
  if (lo < node.split) bspQuery(node.left, x0, y0, x1, y1, stamp, out);
  if (hi > node.split) bspQuery(node.right, x0, y0, x1, y1, stamp, out);
  return out;
}

/* Scratch for the (s,t) polygon clip. Bake-time only; never touched from update(). */
let _cpA = new Float64Array(64);
let _cpB = new Float64Array(64);

/**
 * The exact interval of `s` ∈ [0,1] along A→B that is hidden behind convex solid `q`.
 *
 * A point P(s) is hidden iff the ray P(s) + t·view (t ≥ eps, toward the viewer) enters the solid.
 * Each of the solid's half-spaces n·p ≤ d becomes one linear inequality in (s, t):
 *
 *     (n·(B−A))·s + (n·view)·t  ≤  d − n·A
 *
 * so the feasible (s,t) set is a convex polygon. Clip the rectangle [0,1] × [eps, FAR] against
 * every half-space; the surviving polygon's s-extent IS the hidden interval, because the
 * projection of a convex set onto an axis is a single interval. No sampling, no bisection.
 *
 * @returns {[number,number]|null}
 */
function hiddenInterval(q, ax, ay, az, bx, by, bz, eps) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const vx = PROJ.view[0], vy = PROJ.view[1], vz = PROJ.view[2];
  let n = 4;
  _cpA[0] = 0; _cpA[1] = eps;
  _cpA[2] = 1; _cpA[3] = eps;
  _cpA[4] = 1; _cpA[5] = HLR_FAR;
  _cpA[6] = 0; _cpA[7] = HLR_FAR;
  let src = _cpA, dst = _cpB;
  const planes = q.planes;
  for (let i = 0; i < planes.length; i++) {
    const pl = planes[i];
    const a = pl[0] * dx + pl[1] * dy + pl[2] * dz;
    const b = pl[0] * vx + pl[1] * vy + pl[2] * vz;
    const cc = pl[3] - (pl[0] * ax + pl[1] * ay + pl[2] * az);
    let m = 0;
    for (let k = 0; k < n; k++) {
      const s0 = src[k * 2], t0 = src[k * 2 + 1];
      const j = (k + 1) % n;
      const s1 = src[j * 2], t1 = src[j * 2 + 1];
      const f0 = a * s0 + b * t0 - cc;
      const f1 = a * s1 + b * t1 - cc;
      const in0 = f0 <= 1e-12, in1 = f1 <= 1e-12;
      if (in0) { dst[m * 2] = s0; dst[m * 2 + 1] = t0; m++; }
      if (in0 !== in1) {
        const den = f0 - f1;
        const u = Math.abs(den) < 1e-18 ? 0 : f0 / den;
        dst[m * 2] = s0 + (s1 - s0) * u;
        dst[m * 2 + 1] = t0 + (t1 - t0) * u;
        m++;
      }
      if (m > 28) break;   // a convex clip cannot really reach this; the guard is for NaN input
    }
    n = m;
    if (n < 3) return null;
    const t = src; src = dst; dst = t;
  }
  let s0 = Infinity, s1 = -Infinity;
  for (let k = 0; k < n; k++) {
    const s = src[k * 2];
    if (s < s0) s0 = s;
    if (s > s1) s1 = s;
  }
  if (!(s1 > s0 + 1e-6)) return null;
  return [Math.max(0, s0), Math.min(1, s1)];
}

/* Reused across every edge of a figure. Bake-time only. */
const _cand = [];
const _hid = [];

/**
 * Visible sub-segments of a 3D segment, exactly clipped against the stage's BSP. Pushes
 * [ax,ay,az,bx,by,bz] runs into `out`.
 */
function hlrSegment(bsp, ax, ay, az, bx, by, bz, out) {
  const pax = projX(ax, ay, az, 1), pay = projY(ax, ay, az, 1);
  const pbx = projX(bx, by, bz, 1), pby = projY(bx, by, bz, 1);
  const bx0 = Math.min(pax, pbx), bx1 = Math.max(pax, pbx);
  const by0 = Math.min(pay, pby), by1 = Math.max(pay, pby);
  _cand.length = 0;
  bspQuery(bsp.root, bx0, by0, bx1, by1, ++_bspStamp, _cand);

  _hid.length = 0;
  // If the solid's nearest point is behind the segment's least-near point it cannot hide any of
  // it. One comparison rejects most of what the BSP hands back.
  const dLeast = Math.min(depthOf(ax, ay, az), depthOf(bx, by, bz));
  for (let i = 0; i < _cand.length; i++) {
    const q = _cand[i].q;
    if (q.dMax <= dLeast + HLR_EPS) continue;
    const iv = hiddenInterval(q, ax, ay, az, bx, by, bz, HLR_EPS);
    if (iv) _hid.push(iv);
  }
  if (!_hid.length) {
    out.push([ax, ay, az, bx, by, bz]);
    return out;
  }
  _hid.sort((p, r) => p[0] - r[0]);
  let cursor = 0;
  const emit = (t0, t1) => {
    if (t1 - t0 < 0.006) return;                        // shorter than a pen nib; drop it
    out.push([ax + (bx - ax) * t0, ay + (by - ay) * t0, az + (bz - az) * t0,
      ax + (bx - ax) * t1, ay + (by - ay) * t1, az + (bz - az) * t1]);
  };
  for (const [h0, h1] of _hid) {
    if (h0 > cursor) emit(cursor, h0);
    if (h1 > cursor) cursor = h1;
    if (cursor >= 1) break;
  }
  if (cursor < 1) emit(cursor, 1);
  return out;
}

/** One part, placed. Holds transformed solids for HLR and its projected polylines for drawing. */
function makeInstance(part, slot, offset, opt = {}) {
  const geo = partGeometry(part.type);
  const tr = {
    pos: [slot.position.x + (offset ? offset[0] : 0), slot.position.y + (offset ? offset[1] : 0),
      slot.position.z + (offset ? offset[2] : 0)],
    yaw: (slot.yaw ?? 0) + (opt.yawOffset ?? 0),
    mirror: !!opt.mirror,
    scale: opt.scale ?? 1,
  };
  return {
    partId: part.id, part, slot, tr,
    solids: geo.solids.map((s) => solidBounds(transformSolid(s, tr))),
    details: geo.details.map((d) => transformPoly(d, tr)),
    occlude: opt.occlude !== false,
    dotted: !!opt.dotted,
    red: !!opt.red,
    ghost: !!opt.ghost,
  };
}

/**
 * Project every instance to page-unit polylines with hidden-line removal applied.
 *
 * The BSP is built over the WHOLE instance set including the part being drawn, so a solid hides
 * its own back edges: the 4 mm epsilon means a point on the near face has the ray leaving the
 * solid immediately (t < eps, not hidden) while a point on the far face has it crossing the whole
 * body (t > eps, hidden). That is the difference between the keyart's clean flat-pack solids and
 * v1's wireframe boxes, and it costs one comparison.
 */
function projectInstances(instances, scale) {
  const segs3 = [];
  const out = [];
  const bsp = buildOccluderBSP(instances);
  for (const inst of instances) {
    const polys = [];
    for (const s of inst.solids) {
      for (const [ia, ib] of s.edges) {
        segs3.length = 0;
        const ax = s.verts[ia * 3], ay = s.verts[ia * 3 + 1], az = s.verts[ia * 3 + 2];
        const bx = s.verts[ib * 3], by = s.verts[ib * 3 + 1], bz = s.verts[ib * 3 + 2];
        if (inst.dotted || !bsp.count) {
          polys.push([projX(ax, ay, az, scale), projY(ax, ay, az, scale), projX(bx, by, bz, scale), projY(bx, by, bz, scale)]);
          continue;
        }
        hlrSegment(bsp, ax, ay, az, bx, by, bz, segs3);
        for (const g of segs3) {
          polys.push([projX(g[0], g[1], g[2], scale), projY(g[0], g[1], g[2], scale),
            projX(g[3], g[4], g[5], scale), projY(g[3], g[4], g[5], scale)]);
        }
      }
    }
    const detailPolys = [];
    for (const d of inst.details) {
      const flat = [];
      for (const p of d) flat.push(projX(p[0], p[1], p[2], scale), projY(p[0], p[1], p[2], scale));
      detailPolys.push(flat);
    }
    out.push({ inst, polys, detailPolys });
  }
  return out;
}

function bboxOfDrawn(drawn) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const d of drawn) {
    for (const arr of [d.polys, d.detailPolys]) {
      for (const p of arr) {
        for (let i = 0; i < p.length; i += 2) {
          if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
          if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1];
        }
      }
    }
  }
  if (!isFinite(x0)) return { x0: 0, y0: 0, x1: 1, y1: 1 };
  return { x0, y0, x1, y1 };
}

function partBox(d) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of d.polys) {
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1];
    }
  }
  return isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

function partExtent(d) {
  const b = partBox(d);
  return b ? Math.max(b.x1 - b.x0, b.y1 - b.y0) : 0;
}

/** Centre of a drawn part in figure page units, or null when nothing survived HLR. */
function partCentre(d) {
  const b = partBox(d);
  return b ? [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] : null;
}

/**
 * The part's ASSEMBLY AXIS — the direction it travels the last 1.4 m into its slot, and therefore
 * the direction the exploded view flies it out along.
 *
 * CabinSite publishes it as `_out` (adopted onto `slot.normal`). When it is absent, or degenerate
 * for this member, it is derived from the member's own long axis: a horizontal member goes in
 * downward or outward through the wall it belongs to, an upright goes in from above.
 */
function explodeAxis(slot, part) {
  const n = normOf(slot.normal);
  if (n) return n;
  const dims = part?.dims ?? [1, 1, 1];
  const upright = dims[1] > dims[0] && dims[1] > dims[2];
  if (upright) return [0, 1, 0];                             // a post: it drops in from above
  /*
   * No published normal. Derive one: a member sitting on the footprint's edge belongs to a wall
   * and leaves through that wall; anything inboard leaves upward. Deterministic, and it keeps the
   * headless golden renders honest even with CabinSite out of the build.
   */
  const { hx, hz } = FOOT;
  const ez = Math.abs(Math.abs(slot.position.z) - hz);
  const ex = Math.abs(Math.abs(slot.position.x) - hx);
  if (Math.min(ex, ez) > 0.45) return [0, 1, 0];
  if (ez <= ex) return [0, 0, slot.position.z < 0 ? -1 : 1];
  return [slot.position.x < 0 ? -1 : 1, 0, 0];
}

/**
 * §8.4's "secondary slot axis" — where a collision between two exploded parts gets pushed.
 * The member's own length is the obvious free direction; anything perpendicular to the explode
 * axis will do, so long as it is stable and not the explode axis itself.
 */
function secondaryAxis(slot, primary) {
  const along = normOf(slot.along);
  const cand = along && Math.abs(along[0] * primary[0] + along[1] * primary[1] + along[2] * primary[2]) < 0.9
    ? along
    : (Math.abs(primary[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]);
  // Gram–Schmidt against the explode axis so the push never doubles the explode distance.
  const dot = cand[0] * primary[0] + cand[1] * primary[1] + cand[2] * primary[2];
  const v = [cand[0] - primary[0] * dot, cand[1] - primary[1] * dot, cand[2] - primary[2] * dot];
  return normOf(v) ?? [1, 0, 0];
}

/**
 * Every page whose subject is the assembly, and which therefore reads `panel.figures[0]`.
 * If a renderer below dereferences `panel.figures[0]`, its kind belongs in here.
 */
const FIGURE_KINDS = new Set([
  'exploded', 'mirror', 'brace-sequence', 'collapsed', 'sequence', 'out-of-order',
]);

/**
 * The slot the "do NOT do this" panel is about: a member that can genuinely be seated the wrong
 * way round (a candidate ring wider than its own symmetry, so exactly one candidate is right), or
 * failing that the night's errata slot. A pier is a squared boulder and can never be wrong, so a
 * figure of nothing but piers gets no cross-out — the manual does not warn you about the
 * impossible, which is the joke and also the design.
 */
function crossOutSlot(install) {
  return install.find((s) => (s.yawCandidates ?? 1) > 1 && (s.symmetryOrder ?? 4) === 1)
    ?? install.find((s) => s.errata)
    ?? null;
}
function willCrossOut(install) { return !!crossOutSlot(install); }

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 10. PAGE PACKING — shelf-first guillotine over 3–8 figures per spread.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

function packPage(figures, box) {
  if (!figures.length) return true;
  /*
   * One figure IS the page. v1 gave it its natural rect at the top-left of the cell and left the
   * bottom two-thirds of the sheet blank — every generated assembly panel in the game drew a
   * postage stamp in the corner of an A4 page. A lone figure gets the whole cell and the fit
   * scale magnifies it into that.
   */
  if (figures.length === 1) {
    figures[0].rect = { x: box.x, y: box.y, w: box.w, h: box.h };
    return true;
  }
  const order = figures.slice().sort((a, b) => (b.natural.h * b.natural.w) - (a.natural.h * a.natural.w));
  const shelves = [];
  let cy = box.y;
  for (const f of order) {
    const w = Math.min(f.natural.w, box.w);
    let shelf = shelves[shelves.length - 1];
    if (!shelf || shelf.x + w > box.x + box.w) {
      shelf = { x: box.x, y: cy, h: 0, items: [] };
      shelves.push(shelf);
    }
    shelf.items.push(f);
    f.rect = { x: shelf.x, y: shelf.y, w, h: f.natural.h };
    shelf.x += w + 14;
    shelf.h = Math.max(shelf.h, f.natural.h);
    if (shelf.items.length === 1) cy = shelf.y;
    else cy = shelf.y;
    // Close the shelf when it is full so the next figure starts a new one.
    if (shelf.x > box.x + box.w - 60) { cy = shelf.y + shelf.h + 22; }
  }
  // Justification. Shelves are centred horizontally and the stack is centred vertically, so a
  // half-empty spread reads as a laid-out page rather than as a page that ran out.
  let total = 0;
  for (const s of shelves) total += s.h + 22;
  const slackY = Math.max(0, box.h - total);
  let y = box.y + slackY / 2;
  for (const s of shelves) {
    let used = 0;
    for (const f of s.items) used += f.rect.w + 14;
    used = Math.max(0, used - 14);
    const dx = Math.max(0, (box.w - used) / 2);
    let x = box.x + dx;
    for (const f of s.items) {
      f.rect.x = x;
      f.rect.y = y + (s.h - f.rect.h) / 2;
      x += f.rect.w + 14;
    }
    y += s.h + 22;
  }
  return total <= box.h * 1.02;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 11. THE SYSTEM.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/** Which Script panel id becomes which hero drawing. Everything else is a generated figure. */
const HERO_KIND = {
  '1.1': 'wave', '1.2': 'manifest', '1.3': 'exploded', '1.4': 'bolt-magnifier', '1.5': 'scale-ref',
  '1.6': 'shim-fix', '1.7': 'closing-arms-up',
  '2.1': 'manifest', '2.3': 'angle-pedantry', '2.4': 'mirror', '2.6': 'torque-mouth', '2.7': 'brace-sequence',
  '3.2': 'collapsed', '3.4': 'cut-line', '3.5': 'one-arrow', '3.6': 'hidden-gussets', '3.8': 'tapping',
  '4.1': 'hinge-in-situ', '4.3': 'scale-ambiguity', '4.6': 'light-cone', '4.9': 'horizontal-shape',
  '5.1': 'two-persons', '5.3': 'sequence', '5.4': 'erased-second', '5.7': 'counterweight',
  '6.2': 'out-of-order', '6.5': 'phantom-article', '6.6': 'errata', '6.8': 'kitchen-elevation', '6.9': 'alone',
  '7.blank': 'blank', '7.last': 'last-page', '7.errata_a': 'ending-a', '7.end': 'end-card',
  'x.grab': 'grab-warning',
};

export class Blueprint {
  constructor(ctx) {
    this.ctx = ctx ?? null;
    this.bus = ctx?.bus ?? null;
    this.settings = ctx?.settings ?? null;
    this.state = ctx?.state ?? null;

    this.script = null;
    this.def = null;              // the current night's BlueprintDef
    this.panelIndex = 0;
    this.smudges = [];            // GAME_DESIGN §4.4 — Night Seven, once
    this.stats = { bakeMs: 0, figures: 0, hlrSegments: 0, legibilityFails: 0 };

    this._cache = new Map();      // `${night}:${seed}` -> BlueprintDef
    this._unsubs = [];
    this._seed = 0x51a5cab;
    this._disposed = false;
    try { this._seed = (this.settings?.get?.('seed') ?? this.ctx?.rand?.seed ?? 0x51a5cab) | 0; } catch { /* defaults */ }
  }

  async init() {
    // Script is data, not a system, and it must not be able to take Blueprint down with it.
    try {
      const m = await import('../story/Script.js');
      this.script = m.Script ?? m.default ?? null;
    } catch (e) {
      Log.once('bp:script', 'Blueprint: Script.js unavailable — using the built-in night table.', e?.message ?? e);
      this.script = null;
    }
    if (this.bus?.on) {
      this._unsubs.push(this.bus.on('night:begin', (p) => {
        try { this.forNight(p?.night ?? this.state?.night ?? 1); this.panelIndex = 0; }
        catch (e) { Log.once('bp:nb', 'Blueprint: night:begin failed', e); }
      }));
      this._unsubs.push(this.bus.on('ui:blueprint-open', () => {
        if (!this.def) { try { this.forNight(this.state?.night ?? 1); } catch { /* degrade */ } }
      }));
      // The manual redraws the shortfall's red outline in black with a tick once it is found.
      this._unsubs.push(this.bus.on('tool:found', (p) => {
        const s = this.def?.shortfalls?.find((x) => x.id === p?.toolId);
        if (s) s.found = true;
      }));
    }
    Log.debug('Blueprint ready.');
  }

  /* ── The night's definition ─────────────────────────────────────────────────────────── */

  /**
   * @param {number} n 1..7
   * @returns {object} BlueprintDef — see the module header and GAME_DESIGN §8.1.
   */
  forNight(n) {
    const night = Math.max(1, Math.min(7, Math.round(Number(n) || 1)));
    const key = `${night}:${this._seed}`;
    const hit = this._cache.get(key);
    if (hit) { this.def = hit; return hit; }

    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    const rand = new Rand(hashInt(this._seed ^ Math.imul(night, 0x9e3779b1)));
    const sn = this._nightDef(night);
    const site = this._slotsFromSite(night, rand);
    const { parts, slots } = site ?? layoutNight(night, rand);
    if (!site) computeGraphDepth(slots);
    this._restage(slots, sn.stages);

    const shortfalls = this._chooseShortfalls(night, slots, rand);
    const errata = this._chooseErrata(night, slots, rand);
    const grammars = this._grammarsFor(night);
    const voice = this._manualVoice(night);
    const tone = TONE[night];

    const def = {
      // ── the shape the Build brief requires ──
      night,
      title: sn.title,
      panels: [],
      parts,
      slots,
      missingTool: shortfalls.length
        ? { id: shortfalls[0].id, name: shortfalls[0].name ?? null }
        : { id: null, name: null },
      grammar: grammars[grammars.length - 1],
      errata: errata ? { panel: errata.panelId, nature: errata.nature } : undefined,

      // ── the shape GAME_DESIGN §8.1 requires, as a superset ──
      assemblyName: sn.name,
      stages: [],
      manifest: {},
      grammars,
      shortfalls,
      errataFull: errata,
      authorship: {},
      cover: { word: 'HJEM', makersMark: 'VIK & SØN', articleNo: sn.coverArticle, traced: night === 6 },
      tone: tone.key,
      voice,
      stageCount: sn.stages,
      slotCount: slots.length,
      durationSeconds: sn.duration,
      hardware: this._hardwareFor(slots),
    };

    for (let s = 1; s <= sn.stages; s++) {
      def.stages.push({ index: s, slots: slots.filter((x) => x.stage === s).map((x) => x.id), figures: [], page: null });
    }
    for (const p of parts) {
      const slot = slots.find((s) => s.partId === p.id);
      const m = def.manifest[p.type] ?? (def.manifest[p.type] = { count: 0, tier: 1, articleNo: p.articleNo, partIds: [], position: null });
      m.count++; m.partIds.push(p.id);
      if (slot) m.tier = 1;
    }

    /*
     * THE FIGURES. GAME_DESIGN §8.1 makes `Stage.figures` a required field and v1 emitted `[]` for
     * every stage of every night — perfect metadata describing a drawing that did not exist. This
     * is the drawing: real solids at real plot-local metres, exploded along each part's own
     * assembly axis, hidden-line-removed against the assembled hull, packed onto a page.
     */
    for (const stage of def.stages) {
      stage.figures = this._stageFigures(def, stage);
      stage.page = this._stagePage(def, stage);
    }

    def.panels = this._buildPanels(def, rand);
    for (const p of def.panels) def.authorship[p.id] = p.authorship;

    this.stats.bakeMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    this.stats.figures = def.panels.reduce((a, p) => a + p.figures.length, 0);
    this._cache.set(key, def);
    this.def = def;
    this.panelIndex = 0;
    Log.debug(`Blueprint N${night}: ${def.panels.length} panels, ${slots.length} slots, `
      + `${grammars.join('+')}, ${this.stats.bakeMs.toFixed(1)} ms`);
    return def;
  }

  _nightDef(n) {
    const s = this.script?.nightDef?.(n) ?? null;
    const f = NIGHTS_FALLBACK[n];
    return {
      n,
      name: NIGHT_NAME[n] ?? f.name,
      title: s?.title ? String(s.title).replace(/^NIGHT [A-Z]+ — /, '') : f.title,
      stages: s?.stageCount ?? f.stages,
      slotTarget: s?.slotCount ?? f.slots,
      duration: s?.durationSeconds ?? null,
      grammar: s?.grammar ?? f.grammar,
      coverArticle: this.script?.panels?.[n]?.cover?.articleNo ?? `1962-${String(n).padStart(3, '0')}`,
    };
  }

  /**
   * CabinSite owns the plot, so when it is in the build the diagram is built FROM it rather than
   * merely nudged toward it. Every slot the player will actually stand in front of becomes a slot
   * in the manual, at the same plot-local metres, with the same yaw, the same dependency graph,
   * the same hidden flags and the same article numbers.
   *
   * v1 asked CabinSite only for `position`, matched on ids that never matched (`P-01` against
   * `S-01`, `PIER-01` against `PIER`), and silently kept drawing its own invented layout. The
   * page and the plot were two different buildings, which is exactly the correspondence the
   * puzzle is made of.
   *
   * Coordinate contract (CabinSite.js header): `Slot.position` / `Slot.rotation` are PLOT-LOCAL —
   * the diagram's own space. `px/py/pz` and `slotWorldTransform()` are WORLD. We take plot-local.
   *
   * @returns {{parts:object[], slots:object[]}|null} null when CabinSite is not in the build.
   */
  _slotsFromSite(night, rand) {
    const cs = this.ctx?.systems?.get?.('CabinSite');
    if (!cs) return null;
    let published = null;
    try {
      published = (typeof cs.slotsForNight === 'function' ? cs.slotsForNight(night) : null)
        ?? (Array.isArray(cs.slots) ? cs.slots.filter((s) => (s?.night | 0) === night) : null);
    } catch (e) {
      Log.once('bp:site', 'Blueprint: CabinSite.slotsForNight threw — drawing the proposal instead.', e);
      return null;
    }
    if (!published || !published.length) return null;

    const parts = []; const slots = [];
    const seenId = new Set();
    let n = 0;
    for (const m of published) {
      const pos = m?.transform?.position ?? m?.position;
      if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) continue;
      const type = siteTypeFor(m);
      const t = PART_TYPES[type] ?? PART_TYPES.beam;
      n++;
      // CabinSite reuses one `partId` across a run of identical members (six slots all reading
      // 'PIER'). The manual needs to call them out individually, so the slot id disambiguates.
      const pid = `${String(m.partId ?? type).toUpperCase()}@${m.id}`;
      if (seenId.has(m.id)) continue;
      seenId.add(m.id);
      parts.push({
        id: pid, type, acceptsType: m.acceptsType ?? t.accepts, mass: t.mass, carryClass: t.cls,
        length: Number.isFinite(m._len) && m._len > 0.05 ? m._len : (t.len ?? t.dims[0]),
        dims: t.dims, siteRole: m.partId ?? null,
        articleNo: m.article ?? articleNumber(rand),
        label: m.group ?? null,
      });
      slots.push({
        id: m.id, kind: m.kind ?? 'fixed', stage: Math.max(1, m.stage | 0 || 1),
        acceptsType: m.acceptsType ?? t.accepts, partId: pid,
        position: { x: pos.x, y: Number.isFinite(pos.y) ? pos.y : 0, z: pos.z },
        yaw: Number.isFinite(m.yaw) ? m.yaw : (m.rotation?.y ?? 0),
        axis: m.axis ?? 'y',
        // `_out` is the member's own "away from the structure" unit vector: the assembly axis.
        normal: normOf(m._out) ?? [0, 1, 0],
        along: normOf(m._dir) ?? [1, 0, 0],
        yawCandidates: m.yawCandidates ?? 4,
        symmetryOrder: m.symmetryOrder ?? 4,
        requires: Array.isArray(m.requires) ? m.requires.slice() : [],
        fasteners: m.fasteners | 0,
        ratedMass: m.ratedMass ?? 180,
        mirrorOf: m.mirrorOf ?? null,
        hidden: !!m.hidden,
        errata: !!m.errata,
        graphDepth: 0,
        mirror: !!m.mirrorOf,
        obstruction: m.obstruction ?? null,
        hardware: m.hardware ?? null,
        fromCabinSite: true,
      });
    }
    if (!slots.length) return null;
    // `requires` is a DAG over slot ids; graphDepth is what §8.4 explodes along.
    computeGraphDepth(slots);
    Log.debug(`Blueprint N${night}: adopted ${slots.length}/${n} CabinSite slots.`);
    return { parts, slots };
  }

  /**
   * The fallback layout is authored one stage at a time; CabinSite packs its own slots with
   * `stage = min(k, 1 + floor(i*k/len))`, which is also `BuildSystem.packStages`. Match it, or
   * the night's last stage comes out with zero slots and zero figures — which is precisely how
   * Night One shipped a stage 3 that was `{slots: 0, figures: 0}`.
   */
  _restage(slots, stageCount) {
    const k = Math.max(1, stageCount | 0);
    const byStage = new Map();
    for (const s of slots) {
      const g = byStage.get(s.stage) ?? [];
      g.push(s); byStage.set(s.stage, g);
    }
    if (byStage.size >= k) return;
    for (let i = 0; i < slots.length; i++) {
      slots[i].stage = Math.min(k, 1 + Math.floor((i * k) / slots.length));
    }
  }

  _grammarsFor(n) {
    const g = ['G1'];
    if (n >= 2) g.push('G2');
    if (n >= 3) g.push('G3');
    if (n >= 4) g.push('G4');
    if (n >= 5) g.push('G5');
    if (n >= 6) g.push('G6');
    if (n >= 6) g.push('G7');
    return n === 1 ? ['G1'] : g;
  }

  _manualVoice(n) {
    const v = this.script?.manualVoiceFor?.(n) ?? null;
    const lw = v?.linework ?? null;
    return {
      tone: v?.tone ?? TONE[n].key,
      anselShare: lw?.ansel ?? [0, 0, 0, 0.08, 0.18, 0.33, 0.72, 0][n] ?? 0,
      jitter: lw?.jitter ?? 0,
      doubleStroke: lw?.doubleStroke ?? 0,
      eraserGhosts: lw?.eraserGhosts ?? 0,
      strokeWeight: lw?.strokeWeight ?? 1,
      mascot: v?.mascot ?? null,
      instruction: v?.instruction ?? null,
    };
  }

  /**
   * THE MISSING-HARDWARE ENGINE. Never the first part of a stage; never a part already correctly
   * installed. Escalates from a tool you did not know you needed to a person.
   */
  _chooseShortfalls(night, slots, rand) {
    const src = SHORTFALLS[night] ?? [];
    const scripted = this.script?.nightDef?.(night)?.shortfallItems ?? null;
    const out = [];
    for (const base of src) {
      const s = { ...base, night, found: false };
      const match = scripted?.find?.((x) => x.id === base.id);
      if (match) {
        s.name = match.label ?? s.name;
        s.tier = match.tier ?? s.tier;
        s.scriptNote = match.note ?? null;
      }
      // Bind the shortfall to a slot that is neither the first of its stage nor already placed.
      const eligible = slots.filter((sl, i) => {
        if (s.type === 'person' || s.phantom) return false;
        const firstOfStage = slots.findIndex((q) => q.stage === sl.stage) === i;
        return !firstOfStage && !this.state?.installed?.[sl.id];
      });
      if (eligible.length) {
        const pick = eligible[rand.int(0, eligible.length - 1)];
        s.slotId = pick.id;
        s.stage = pick.stage;
      } else { s.slotId = null; s.stage = null; }
      out.push(s);
    }
    return out;
  }

  /** G6 — the diagram is wrong. Nights 6 and 7 only; STORY says the manual is broken, not evil. */
  _chooseErrata(night, slots, rand) {
    if (night < 6) return null;
    const flagged = slots.filter((s) => s.errata);
    const pool = flagged.length ? flagged : slots.filter((s) => s.stage >= 3);
    if (!pool.length) return null;
    const slot = pool[rand.int(0, pool.length - 1)];
    const natures = [
      { nature: 'reversed', note: 'The printed part is drawn handed the other way round.' },
      { nature: 'transposed', note: 'The printed step puts this part in its neighbour\'s slot.' },
      { nature: 'inverted', note: 'The printed part is drawn upside down, confidently.' },
    ];
    const pick = natures[rand.int(0, natures.length - 1)];
    slot.errata = true;
    return {
      slotId: slot.id,
      partId: slot.partId,
      // Night Seven's errata has no printed page. The last page is Marit's, from 1962, and
      // nothing red is ever stamped on it. BuildSystem reads `slotId`, not `panelId`.
      panelId: night === 6 ? '6.6' : null,
      nature: pick.nature,
      note: pick.note,
      printedTransform: { yaw: (slot.yaw ?? 0) + Math.PI, mirror: pick.nature === 'reversed' },
      correctTransform: { yaw: slot.yaw ?? 0, mirror: false },
      slipId: night === 6 ? 'errata_slip' : 'errata_slip_final',
      cap: 0.35,
    };
  }

  _hardwareFor(slots) {
    let fasteners = 0, brackets = 0;
    for (const s of slots) { fasteners += s.fasteners ?? 0; if (s.acceptsType === 'bracket') brackets++; }
    return { fasteners, brackets };
  }

  /* ── Panels ────────────────────────────────────────────────────────────────────────── */

  _buildPanels(def, rand) {
    const n = def.night;
    // `Script.panelsFor(n)` returns the whole sheet ({ night, tone, cover, panels }), not an array.
    const sheet = this.script?.panelsFor?.(n) ?? null;
    const sheetPanels = Array.isArray(sheet) ? sheet : (sheet?.panels ?? []);
    const scripted = sheetPanels.filter((p) => p && p.night === n);
    const target = PANEL_COUNT[n] ?? 9;
    const panels = [];

    // The cover. HJEM. It is not a product name.
    panels.push(this._panel(def, {
      id: `${n}.0`, kind: 'cover', stage: 0, step: 0, authorship: n === 6 ? 'ansel' : 'marit',
      articleNo: def.cover.articleNo, hero: true, rand,
    }));

    for (const sp of scripted) {
      panels.push(this._panel(def, {
        id: sp.id, kind: HERO_KIND[sp.id] ?? 'exploded', stage: sp.stage ?? 1, step: sp.step ?? null,
        authorship: sp.authorship ?? 'marit', articleNo: sp.articleNo ?? null,
        glyphs: sp.glyphs ?? [], red: !!sp.red, hero: !sp.authored, rand,
      }));
    }

    // Fill to the night's panel count with generated assembly figures, one stage at a time.
    let step = 1;
    const perStage = Math.max(1, Math.ceil((target - panels.length) / Math.max(1, def.stageCount)));
    for (let s = 1; s <= def.stageCount && panels.length < target; s++) {
      for (let k = 0; k < perStage && panels.length < target; k++) {
        panels.push(this._panel(def, {
          id: `${n}.${step + 20}`, kind: n === 7 ? 'last-page' : 'exploded', stage: s, step: step++,
          authorship: 'marit', articleNo: articleNumber(rand), generated: true, rand,
        }));
      }
    }

    // The grab safety warning: from the stage after the player's first grab, on every sheet after.
    if (this.state?.storyFlags?.firstGrab || this.state?.storyFlags?.firstBlood) {
      for (const p of panels) if (p.kind !== 'cover' && p.kind !== 'blank') p.grabWarning = true;
    }

    // Authorship distribution. Script's declared hands are law; the rest is the night's count.
    const forced = panels.filter((p) => p.authorship === 'ansel');
    let need = (ANSEL_PANELS[n] ?? 0) - forced.length;
    if (need > 0) {
      const pool = panels.filter((p) => p.authorship !== 'ansel' && p.kind !== 'cover' && p.kind !== 'blank');
      // Weight toward the back of the sheet: he draws the pages he needs it to say.
      pool.sort((a, b) => (b.step ?? 0) - (a.step ?? 0));
      for (let i = 0; i < pool.length && need > 0; i++) {
        if (rand.next() < 0.62) { pool[i].authorship = 'ansel'; need--; }
      }
      for (let i = 0; i < pool.length && need > 0; i++) {
        if (pool[i].authorship !== 'ansel') { pool[i].authorship = 'ansel'; need--; }
      }
    }

    // Sequence dependency (G5) puts the numbers out of drawing order from Night 5.
    if (n >= 5) {
      const numbered = panels.filter((p) => p.step);
      for (let i = numbered.length - 1; i > 0; i--) {
        if (rand.next() < 0.35) {
          const j = rand.int(0, i);
          const t = numbered[i].step; numbered[i].step = numbered[j].step; numbered[j].step = t;
          numbered[i].dashedStep = true;
        }
      }
    }
    // Night Six: step 14 comes before step 9, and step 9 does not appear.
    if (n === 6) {
      const nine = panels.find((p) => p.step === 9);
      if (nine) nine.step = 14;
      for (const p of panels) if (p.step === 14 && p !== nine) p.step = 15;
    }

    panels.forEach((p, i) => {
      p.index = i;
      if (!/^[0-9]+\.[0-9]+$/.test(p.displayId)) p.displayId = `${n}.${i}`;
    });
    return panels;
  }

  _panel(def, o) {
    const p = {
      id: o.id, index: 0, night: def.night, kind: o.kind, stage: o.stage ?? 1, step: o.step ?? null,
      dashedStep: false, authorship: o.authorship ?? 'marit', articleNo: o.articleNo ?? null,
      glyphs: o.glyphs ?? [], red: !!o.red, hero: !!o.hero, generated: !!o.generated,
      grabWarning: false, figures: [], seed: (hashStr(`${def.night}:${o.id}`) * 1e6) | 0,
      // The number printed in the corner. Script ids like '7.errata_a' are engineering handles,
      // not something a 1962 manual would print, so non-numeric ids get a plain sheet number.
      displayId: /^[0-9]+\.[0-9]+$/.test(String(o.id)) ? String(o.id) : `${def.night}.${o.sheetNo ?? 0}`,
    };
    /*
     * Every page that reads `panel.figures[0]` gets one. v1 built figures for `kind: 'exploded'`
     * alone, so `mirror`, `sequence`, `collapsed`, `brace-sequence` and `out-of-order` — five of
     * the seven grammars' signature pages — silently took their `if (fig)` fallback branch and
     * drew a stub. FIGURE_KINDS is the list of pages whose subject IS the assembly.
     */
    if (FIGURE_KINDS.has(p.kind)) p.figures = this._buildFigures(def, p);
    return p;
  }

  /* ── FIGURES — the drawing itself ──────────────────────────────────────────────────── */

  /**
   * Exploded axonometric figures for one panel's stage. This is the puzzle: real solids at real
   * plot-local metres, exploded along each part's own assembly axis, hidden-line removed against
   * the assembled hull, with the arrow vocabulary that says what to DO with them.
   */
  _buildFigures(def, panel) {
    const f = this._makeFigure(def, panel.stage, {
      id: `${panel.id}-f1`,
      authorship: panel.authorship ?? 'marit',
      stepNumber: panel.step, dashed: !!panel.dashedStep,
      glyphs: panel.glyphs ?? [], seed: panel.seed,
    });
    return f ? [f] : [];
  }

  /** GAME_DESIGN §8.1 — `Stage.figures`. Required, and empty in every build before this one. */
  _stageFigures(def, stage) {
    const f = this._makeFigure(def, stage.index, {
      id: `N${def.night}.S${stage.index}`,
      authorship: (def.voice?.anselShare ?? 0) > 0.5 ? 'ansel' : 'marit',
      stepNumber: stage.index, dashed: false, glyphs: [],
      seed: (hashStr(`${def.night}:stage:${stage.index}`) * 1e6) | 0,
    });
    return f ? [f] : [];
  }

  /** GAME_DESIGN §8.1 — `Stage.page`: the guillotine packer's result for this stage's figures. */
  _stagePage(def, stage) {
    const box = {
      x: PAGE.margin, y: PAGE.margin,
      w: PAGE.W - PAGE.margin * 2, h: PAGE.H - PAGE.margin * 2 - PAGE.footer,
    };
    const fits = packPage(stage.figures, box);
    return {
      width: PAGE.W, height: PAGE.H, box, fits, spread: false,
      rects: stage.figures.map((f) => ({
        figureId: f.id,
        x: f.rect?.x ?? box.x, y: f.rect?.y ?? box.y,
        w: f.rect?.w ?? f.natural.w, h: f.rect?.h ?? f.natural.h,
      })),
    };
  }

  /**
   * One Figure, in the shape GAME_DESIGN §8.1 mandates:
   *
   *   Figure = { id, projection, parts: [{ partId, explodeVector, silhouettePx }],
   *              arrows: [Arrow], stepNumber, dashed, glyphs, authorship }
   *
   * plus the rasterisation payload `_drawFigure` consumes (`drawn`, `leaders`, `bbox`, `natural`).
   * @returns {object|null} null only when the stage has no slots at all.
   */
  _makeFigure(def, stageIndex, o) {
    const stageSlots = def.slots.filter((s) => s.stage === stageIndex);
    if (!stageSlots.length) return null;
    const partOf = (id) => def.parts.find((p) => p.id === id);
    const mirrored = def.grammars.includes('G2') && def.night === 2
      && stageSlots.some((s) => s.mirror);

    /*
     * A flat-pack panel draws a SUB-ASSEMBLY. The cabin is 6.40 x 3.20 m, so a stage of six piers
     * fits on the page in full and is drawn in full — that correspondence between the page and
     * the plot is the whole puzzle. Only a run long enough to turn the page into confetti gets
     * thinned to representatives plus a ×N call-out (which is also what STORY §3.6 says the
     * manual starts doing out loud on Night Three).
     */
    const collect = (dropMirrored) => {
      const g = new Map();
      for (const s of stageSlots) {
        if (dropMirrored && s.mirror) continue;
        const p = partOf(s.partId);
        if (!p) continue;
        const list = g.get(p.type) ?? [];
        list.push(s);
        g.set(p.type, list);
      }
      return g;
    };
    /*
     * G2 draws the left bay and lets the mirror axis stand in for the right. But a stage whose
     * slots are ALL on the mirrored side has nothing left after that filter, and a figure of
     * nothing is the bug this whole pass exists to kill. When the filter would empty the stage,
     * the stage is simply not a mirror page.
     */
    let groups = collect(mirrored);
    let isMirror = mirrored;
    if (!groups.size) { groups = collect(false); isMirror = false; }
    if (!groups.size) return null;
    const MAX_REP = stageSlots.length > 12 ? 4 : 8;
    const install = [];
    const counts = [];
    for (const [type, list] of groups) {
      const take = Math.min(MAX_REP, list.length);
      for (let i = 0; i < take; i++) install.push(list[Math.floor(i * list.length / take)]);
      counts.push({ type, total: list.length, shown: take });
    }
    if (!install.length) return null;

    // Context: the already-placed parts nearest the sub-assembly, so the join reads in situ.
    let cx0 = 0, cy0 = 0, cz0 = 0;
    for (const s of install) { cx0 += s.position.x; cy0 += s.position.y; cz0 += s.position.z; }
    cx0 /= install.length; cy0 /= install.length; cz0 /= install.length;
    const context = def.slots.filter((s) => s.stage < stageIndex)
      .sort((a, b) => (
        Math.hypot(a.position.x - cx0, a.position.y - cy0, a.position.z - cz0)
        - Math.hypot(b.position.x - cx0, b.position.y - cy0, b.position.z - cz0)))
      .slice(0, 8);

    const instances = [];
    for (const s of context) {
      const p = partOf(s.partId);
      if (p) instances.push(makeInstance(p, s, null, { occlude: true }));
    }

    /*
     * EXPLODE VECTORS — GAME_DESIGN §8.4, verbatim: `slotNormal × (1.4 + 0.3 × graphDepth)` in
     * figure space, where graphDepth is the part's depth in the `requires` DAG. Deeper parts fly
     * further, so the assembly order reads outward-in with no numbering at all.
     *
     * The slot normal is CabinSite's `_out` — the member's own "away from the structure" axis —
     * so a sill flies out through the wall it belongs to and a pier flies straight up, which is
     * what makes the leader line legible as a path the part travels rather than as decoration.
     * v1 used a normal that defaulted to [0,1,0] for every slot, so everything went up.
     */
    const parts = [];
    const placed = [];
    for (const s of install) {
      const p = partOf(s.partId);
      if (!p) continue;
      const nrm = explodeAxis(s, p);
      const d = 1.4 + 0.3 * (s.graphDepth ?? 0);
      let off = [nrm[0] * d, nrm[1] * d, nrm[2] * d];
      // Collision resolution: push along the SECONDARY slot axis, 0.15 m steps, max 6 (§8.4).
      const sec = secondaryAxis(s, nrm);
      let px = 0, py = 0;
      for (let it = 0; it < 6; it++) {
        px = projX(s.position.x + off[0], s.position.y + off[1], s.position.z + off[2], NOMINAL_SCALE);
        py = projY(s.position.x + off[0], s.position.y + off[1], s.position.z + off[2], NOMINAL_SCALE);
        let clash = false;
        for (const e of placed) if (Math.hypot(px - e.px, py - e.py) < 26) { clash = true; break; }
        if (!clash) break;
        off = [off[0] + sec[0] * 0.15, off[1] + sec[1] * 0.15, off[2] + sec[2] * 0.15];
      }
      placed.push({ px, py });
      const hidden = !!s.hidden;
      const inst = makeInstance(p, s, off, { occlude: !hidden, dotted: hidden, mirror: false });
      inst.isInstall = true;
      inst.explode = off;
      instances.push(inst);
      parts.push({
        partId: p.id, slotId: s.id, type: p.type, articleNo: p.articleNo,
        explodeVector: [off[0], off[1], off[2]],
        axis: [nrm[0], nrm[1], nrm[2]],
        graphDepth: s.graphDepth ?? 0,
        hidden, fasteners: s.fasteners | 0,
        seatedAt: [s.position.x, s.position.y, s.position.z],
        silhouettePx: 0,          // filled below, once the page fit is known
      });
    }
    if (!parts.length) return null;

    /*
     * THE SEAT. The part drawn again, faintly, where it is going — Script's own caption for panel
     * 1.3 is "a pier block descending into a chalked square on the ground... the square in the
     * drawing is the square on the ground". Without it the leader line points at nothing and the
     * first stage of a night (which has no already-placed context to land on) reads as parts
     * floating over blank paper. It never occludes and it is never counted for legibility.
     */
    for (const s of install) {
      const p = partOf(s.partId);
      if (!p) continue;
      const seat = makeInstance(p, s, null, { occlude: false, dotted: true });
      seat.isSeat = true;
      instances.push(seat);
    }

    const drawn = projectInstances(instances, NOMINAL_SCALE);
    this.stats.hlrSegments += drawn.reduce((a, d) => a + d.polys.length, 0);
    const bbox = bboxOfDrawn(drawn);

    // Leader lines: dashed, from the exploded part all the way back to where it goes. In the
    // keyart these run the full height of the sheet and they are the only thing tying the layers
    // together, so they are drawn under everything and never shortened.
    const leaders = [];
    for (const d of drawn) {
      if (!d.inst.isInstall || !d.inst.explode) continue;
      const s = d.inst.slot;
      const e = d.inst.explode;
      leaders.push([
        projX(s.position.x + e[0], s.position.y + e[1], s.position.z + e[2], NOMINAL_SCALE),
        projY(s.position.x + e[0], s.position.y + e[1], s.position.z + e[2], NOMINAL_SCALE),
        projX(s.position.x, s.position.y, s.position.z, NOMINAL_SCALE),
        projY(s.position.x, s.position.y, s.position.z, NOMINAL_SCALE),
      ]);
    }

    /*
     * THE LEGIBILITY INVARIANT (GAME_DESIGN §8.4). A part whose silhouette would land under 40 px
     * at the page's fit scale does not get shrunk and it does not get dropped: it is promoted to a
     * magnified detail call-out with a leader back to where it goes.
     *
     * Two passes, and the order matters. v1 always reserved the call-out column before deciding
     * what to promote, so the column shrank the assembly view enough to push borderline parts
     * (every pier on Night One) into the very column they had created. Measure with the whole
     * cell first; only if something genuinely fails does the column exist at all.
     */
    const cellW = PAGE.W - PAGE.margin * 2, cellH = PAGE.H - PAGE.margin * 2 - PAGE.footer;
    const extents = new Map();
    for (const d of drawn) if (d.inst.isInstall) extents.set(d, partExtent(d));

    const measure = (bb, reserve) => {
      const nat = { w: (bb.x1 - bb.x0) + 46, h: (bb.y1 - bb.y0) + 52 };
      return { nat, fit: Math.min((cellW - reserve) / Math.max(1, nat.w), cellH / Math.max(1, nat.h)) };
    };

    /*
     * BJØRN, 1.7 m in the same projection, on the ground at the near-right of the plot — where the
     * keyart puts him. He is the scale reference AND the "you are here" indicator: he always faces
     * the −Z screen axis, so matching your own view of the plot to his is G1. He is dropped from a
     * figure he would cost legibility on, because a 1.7 m man beside a 0.14 m hinge shrinks the
     * hinge rather than explaining it — real manuals do the same.
     */
    let mx = -Infinity, mz = Infinity, my = Infinity;
    for (const inst of instances) {
      for (const s of inst.solids) {
        for (let i = 0; i < s.verts.length / 3; i++) {
          mx = Math.max(mx, s.verts[i * 3]);
          my = Math.min(my, s.verts[i * 3 + 1]);
          mz = Math.min(mz, s.verts[i * 3 + 2]);
        }
      }
    }
    /*
     * He is drawn in PAGE units at the figure's lower-right corner (`_drawFigure`), not inside the
     * figure's own bbox, and he is sized `1.7 m × the figure's draw scale` so he stays a true
     * scale reference. Putting him inside the bbox is what cost Night One its legibility: six
     * 0.52 m piers plus a 1.7 m man in one bounding box drops the fit far enough to push every
     * pier under the 40 px floor and into a call-out column. The invariant is binding; his
     * position is not.
     */
    const mascot = (isFinite(mx) && (bbox.x1 - bbox.x0) / NOMINAL_SCALE >= 1.2)
      ? { metres: 1.7, corner: 'near-right', anchor: [mx, my, mz] }
      : null;
    const b = { ...bbox };
    /*
     * If a "do NOT do this" panel is going to exist, its strip is part of the figure and has to be
     * in the box the fit is computed from — otherwise it is drawn off the bottom of the cell,
     * which is how you ship a red cross-out nobody ever sees.
     */
    if (willCrossOut(install)) b.y1 += MIN_SILHOUETTE * 1.35 + 26;

    // Pass 1 — no column reserved.
    let m = measure(b, 0);
    const failing = [];
    for (const [d, ext] of extents) if (ext * m.fit < MIN_SILHOUETTE) failing.push(d);
    // Pass 2 — only if pass 1 actually failed does the call-out column come into existence.
    const insets = [];
    if (failing.length) {
      m = measure(b, MIN_SILHOUETTE * 2.6);
      for (const [d, ext] of extents) {
        if (ext * m.fit >= MIN_SILHOUETTE) continue;
        const s = d.inst.slot;
        const type = d.inst.part.type;
        if (!insets.some((q) => q.type === type)) {
          insets.push({
            type,
            count: (counts.find((q) => q.type === type)?.total) ?? 1,
            at: [projX(s.position.x, s.position.y, s.position.z, NOMINAL_SCALE),
              projY(s.position.x, s.position.y, s.position.z, NOMINAL_SCALE)],
            articleNo: d.inst.part.articleNo,
          });
        }
        d.inset = true;
      }
    }
    const natural = m.nat;
    let minSil = Infinity;
    for (const [d, ext] of extents) if (!d.inset) minSil = Math.min(minSil, ext);
    if (!isFinite(minSil)) {
      // Every part in this stage is small hardware: the figure IS the detail. Scale to the floor.
      minSil = MIN_SILHOUETTE / Math.max(m.fit, 1e-3);
      natural.w = Math.min(cellW, natural.w);
      natural.h = Math.min(cellH, natural.h);
    }
    // §8.1's `silhouettePx`: what this part will actually measure on a 1080p page. Not a promise,
    // a measurement — `checkLegibility()` asserts against these.
    for (const p of parts) {
      const d = drawn.find((q) => q.inst.isInstall && q.inst.partId === p.partId);
      p.silhouettePx = d ? Math.round((extents.get(d) ?? 0) * m.fit * 10) / 10 : 0;
      p.inset = !!d?.inset;
    }

    const arrows = this._buildArrows(def, { install, parts, drawn, leaders, counts, bbox: b, mirrored: isMirror });

    return {
      // ── GAME_DESIGN §8.1's Figure ──
      id: o.id, kind: 'exploded', stage: stageIndex,
      projection: {
        kind: 'dimetric', angles: [7, 42],
        axisX: [PROJ.ax[0], PROJ.ax[1]], axisY: [PROJ.ay[0], PROJ.ay[1]], axisZ: [PROJ.az[0], PROJ.az[1]],
        view: [PROJ.view[0], PROJ.view[1], PROJ.view[2]],
        scale: NOMINAL_SCALE, fit: m.fit, hlr: 'bsp',
      },
      parts, arrows,
      stepNumber: o.stepNumber ?? null, dashed: !!o.dashed,
      glyphs: o.glyphs ?? [], authorship: o.authorship ?? 'marit',
      // ── the rasterisation payload ──
      drawn, leaders, mascot, bbox: b, minSil, insets, counts, mirrored: isMirror,
      hiddenCount: install.filter((s) => s.hidden).length,
      natural, seed: o.seed ?? 1,
    };
  }

  /**
   * THE ARROW VOCABULARY (ART_DIRECTION §8.5 / GAME_DESIGN §8.4) — the complete closed set, and
   * the manual's entire imperative mood. There are no verbs in this book; these are the verbs.
   *
   *   straight     insert / place    one per exploded part, along its leader
   *   curved       rotate            where the yaw actually matters (candidates > symmetry)
   *   double       align             across a run of identical members
   *   circular     tighten           where the slot takes fasteners
   *   crossed-out  do NOT do this    in the accent red, and only ever in the accent red
   *
   * Coordinates are page units in FIGURE space (the same space as `drawn` and `bbox`), so the
   * renderer draws them under one transform and BlueprintUI can re-project them if it wants to.
   */
  _buildArrows(def, ctxF) {
    const { install, drawn, leaders, counts, bbox } = ctxF;
    const arrows = [];
    // 1. STRAIGHT — insert. The last leg of every leader.
    for (let i = 0; i < leaders.length; i++) {
      const L = leaders[i];
      const dx = L[2] - L[0], dy = L[3] - L[1];
      const l = Math.hypot(dx, dy) || 1;
      arrows.push({
        kind: 'straight', meaning: 'insert', partId: install[i]?.partId ?? null,
        from: [L[2] - dx / l * 34, L[3] - dy / l * 34],
        to: [L[2] - dx / l * 9, L[3] - dy / l * 9],
      });
    }
    // 2. CURVED — rotate. Only where the part can genuinely go in the wrong way round: a slot
    //    whose candidate ring is larger than the part's own symmetry. A pier is a squared boulder
    //    (k = sym = 4) and never gets one; a sill (k = 2, sym = 1) always does.
    for (const d of drawn) {
      if (!d.inst.isInstall) continue;
      const s = d.inst.slot;
      if ((s.yawCandidates ?? 4) <= (s.symmetryOrder ?? 4)) continue;
      const e = partCentre(d);
      if (!e) continue;
      const r = Math.max(16, partExtent(d) * 0.42);
      arrows.push({
        kind: 'curved', meaning: 'rotate', partId: d.inst.partId,
        at: [e[0], e[1] - r * 1.15], r, a0: -Math.PI * 0.92, a1: -Math.PI * 0.18,
      });
      break;      // one per figure. The manual says a thing once.
    }
    // 3. DOUBLE-HEADED — align. Across the longest run of identical members in the stage.
    const run = counts.slice().sort((a, b) => b.total - a.total)[0];
    if (run && run.total >= 2) {
      const of = drawn.filter((d) => d.inst.isInstall && d.inst.part.type === run.type);
      if (of.length >= 2) {
        /*
         * A dimension line is a BASELINE, not a diagonal between two part centres — running it
         * corner-to-corner across the assembly is the one thing a draughtsman would never do.
         * Take the run's screen extent along the dominant axis and set the line clear of it, with
         * unit divisions instead of a numeral (there are no numerals in this book except article
         * numbers).
         */
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const d of of) {
          const bb = partBox(d);
          if (!bb) continue;
          if (bb.x0 < x0) x0 = bb.x0; if (bb.x1 > x1) x1 = bb.x1;
          if (bb.y0 < y0) y0 = bb.y0; if (bb.y1 > y1) y1 = bb.y1;
        }
        if (isFinite(x0)) {
          const horizontal = (x1 - x0) >= (y1 - y0);
          // Clear of everything, including the seat ghosts — a dimension line crossing the
          // subject is a dimension line nobody can read.
          const base = Math.max(y1, bbox.y1) + 26;
          const side = Math.min(x0, bbox.x0) - 26;
          arrows.push({
            kind: 'double', meaning: 'align', type: run.type,
            from: horizontal ? [x0, base] : [side, y0],
            to: horizontal ? [x1, base] : [side, y1],
            witness: 16,
            divisions: run.total > 2 ? run.total - 1 : 0,
          });
        }
      }
    }
    // 4. CIRCULAR — tighten. At the first join in the stage that takes fasteners.
    const tight = drawn.find((d) => d.inst.isInstall && (d.inst.slot.fasteners | 0) > 0);
    if (tight) {
      const s = tight.inst.slot;
      arrows.push({
        kind: 'circular', meaning: 'tighten', slotId: s.id, fasteners: s.fasteners | 0,
        at: [projX(s.position.x, s.position.y, s.position.z, NOMINAL_SCALE),
          projY(s.position.x, s.position.y, s.position.z, NOMINAL_SCALE)],
        r: 22, turns: 0.85,
      });
    }
    /*
     * 5. CROSSED-OUT — do NOT do this. A second, small drawing of one part in the orientation
     *    that will not seat, boxed and struck through in the accent red. This is the only red on
     *    an ordinary page and the only thing in the manual that is ever negative.
     */
    const wrongable = crossOutSlot(install);
    if (wrongable) {
      const w = MIN_SILHOUETTE * 1.9, h = MIN_SILHOUETTE * 1.35;
      arrows.push({
        kind: 'crossed', meaning: 'do-not', slotId: wrongable.id, partId: wrongable.partId,
        // Bottom-left of the figure, in the strip `_makeFigure` reserved for it.
        rect: { x: bbox.x0, y: bbox.y1 - h - 2, w, h },
        wrongYaw: (wrongable.yaw ?? 0) + Math.PI, mirror: !!wrongable.errata,
      });
    }
    void def;
    return arrows;
  }

  /* ── Navigation ────────────────────────────────────────────────────────────────────── */

  get panelCount() { return this.def?.panels?.length ?? 0; }
  get currentPanel() { return this.def?.panels?.[this.panelIndex] ?? null; }
  get currentPanelIndex() { return this.panelIndex; }

  nextPanel() {
    if (!this.def) return null;
    this.panelIndex = Math.min(this.def.panels.length - 1, this.panelIndex + 1);
    return this.currentPanel;
  }

  prevPanel() {
    if (!this.def) return null;
    this.panelIndex = Math.max(0, this.panelIndex - 1);
    return this.currentPanel;
  }

  setPanel(i) {
    if (!this.def) return null;
    const idx = this._resolveIndex(i);
    this.panelIndex = Math.max(0, Math.min(this.def.panels.length - 1, idx));
    return this.currentPanel;
  }

  _resolveIndex(i) {
    if (typeof i === 'number' && isFinite(i)) return Math.round(i);
    if (typeof i === 'string') {
      const k = this.def?.panels?.findIndex((p) => p.id === i);
      return k >= 0 ? k : 0;
    }
    if (i && typeof i === 'object' && typeof i.index === 'number') return i.index;
    return this.panelIndex;
  }

  /* ── Services other systems read ───────────────────────────────────────────────────── */

  /** BuildSystem / NightManager: where to place tonight's absent item, and how to hint it. */
  shortfallsFor(n) {
    const d = (this.def && this.def.night === n) ? this.def : this.forNight(n);
    return d.shortfalls;
  }

  /** G6: the printed step that is wrong, and the slip that corrects it. */
  errataFor(n) {
    const d = (this.def && this.def.night === n) ? this.def : this.forNight(n);
    return d.errataFull;
  }

  /** GAME_DESIGN §4.4 — Night Seven, once. The wipe stops working and it marks the page. */
  applySmudge(smudge) {
    if (!smudge || typeof smudge.uv?.x !== 'number') return false;
    this.smudges.push({
      panel: this._resolveIndex(smudge.panel ?? this.panelIndex),
      u: smudge.uv.x, v: smudge.uv.y, strength: Math.max(0, Math.min(1, smudge.strength ?? 0.6)),
    });
    return true;
  }

  /** GAME_DESIGN §8.4's legibility invariant, checked programmatically, not by eye. */
  checkLegibility(n) {
    const d = (this.def && this.def.night === n) ? this.def : this.forNight(n ?? this.def?.night ?? 1);
    const fails = [];
    const cellW = PAGE.W - PAGE.margin * 2, cellH = PAGE.H - PAGE.margin * 2 - PAGE.footer;
    /*
     * The same arithmetic `_makeFigure` used, or this asserts against a page nobody draws. Two
     * things v1 got wrong here: it capped the fit at 1x (a figure is allowed to be MAGNIFIED to
     * clear the floor — that is the entire point of a flat-pack detail), and it measured parts
     * that had already been promoted into the call-out column, where they are drawn at 58 px by
     * construction and cannot fail.
     */
    const check = (owner, figures) => {
      for (const f of figures) {
        if (!f?.natural) continue;
        const col = f.insets && f.insets.length ? MIN_SILHOUETTE * 2.6 : 0;
        const scale = Math.min((cellW - col) / Math.max(1, f.natural.w), cellH / Math.max(1, f.natural.h));
        const px = f.minSil * scale;
        if (px < MIN_SILHOUETTE - 0.5) fails.push({ owner, figure: f.id, px: Math.round(px) });
      }
    };
    for (const p of d.panels) check(p.id, p.figures);
    for (const s of d.stages) check(`stage ${s.index}`, s.figures);
    this.stats.legibilityFails = fails.length;
    return fails;
  }

  /* ── Rendering ─────────────────────────────────────────────────────────────────────── */

  /**
   * Draw one page of the manual.
   * @param {number|string|object} which panel index, panel id, or the panel object
   * @param {CanvasRenderingContext2D} c
   */
  renderPanel(which, c, width, height) {
    if (!c || !(width > 0) || !(height > 0)) return false;
    try {
      if (!this.def) this.forNight(this.state?.night ?? 1);
      const idx = this._resolveIndex(which);
      const panel = this.def?.panels?.[idx];
      if (!panel) return false;
      const m = this._pageMetrics(panel, width, height);
      const hand = this._handFor(panel);

      c.save();
      this._drawPaper(c, panel, m, width, height);
      c.translate(m.ox, m.oy);
      c.scale(m.s, m.s);
      c.lineJoin = 'round';
      c.lineCap = 'round';

      const box = {
        x: PAGE.margin, y: PAGE.margin,
        w: m.pw - PAGE.margin * 2, h: PAGE.H - PAGE.margin * 2 - PAGE.footer,
      };
      const env = { hand, box, m, panel, seed: panel.seed, night: this.def.night, def: this.def };

      const fn = this._renderers[panel.kind] ?? this._renderers.exploded;
      fn.call(this, c, env);
      if (panel.grabWarning) this._drawGrabWarning(c, env);
      this._drawFurniture(c, env);
      this._drawSmudges(c, idx, m);
      c.restore();
      return true;
    } catch (e) {
      Log.once('bp:render', 'Blueprint.renderPanel failed', e);
      try { c.restore(); } catch { /* the context may already be balanced */ }
      return false;
    }
  }

  _pageMetrics(panel, width, height) {
    const foldout = panel.kind === 'last-page' || panel.kind === 'blank' || panel.kind === 'ending-a'
      ? false : (panel.id === '7.1' || (this.def?.night === 6 && panel.kind === 'exploded' && width / height > 1.25));
    const spread = foldout || width / height > 1.18;
    const pw = spread ? PAGE.W * 2 + PAGE.gutter : PAGE.W;
    const s = Math.min(width / pw, height / PAGE.H);
    return { s, pw, ph: PAGE.H, spread, foldout, ox: (width - pw * s) / 2, oy: (height - PAGE.H * s) / 2 };
  }

  /** The hand that drew this page, tempered by the night's linework parameters. */
  _handFor(panel) {
    const base = HANDS[panel.authorship] ?? HANDS.marit;
    const v = this.def?.voice;
    if (!v || panel.authorship !== 'ansel') return base;
    // Ansel's hand is steadier the first night he draws and worse by Night Six.
    const k = 0.55 + 1.6 * (v.jitter ?? 0.02) * 10;
    return {
      ...base,
      wobbleAmp: base.wobbleAmp * Math.min(1.35, k),
      strokeRepeat: 1 + (base.strokeRepeat - 1) * Math.min(1.4, 0.6 + (v.doubleStroke ?? 0.1) * 3),
      ghostAlpha: Math.min(0.22, (v.eraserGhosts ?? 0.1) * 0.42 + 0.02),
      figure: base.figure,
    };
  }

  _accent() {
    const cb = this.settings?.get?.('colorblind') ?? 'none';
    return ACCENT_CB[cb] ?? PALETTE.red;
  }

  /** Paper. Warm off-white, fibre, a fold crease, and the night's accumulated damp. */
  _drawPaper(c, panel, m, width, height) {
    c.save();
    c.fillStyle = PALETTE.paper;
    c.fillRect(0, 0, width, height);
    const wear = TONE[this.def?.night ?? 1]?.wear ?? 0;
    const r = new Rand(hashInt(0x9a51 ^ (panel.seed | 0)));
    // Fibre.
    c.globalAlpha = 0.05;
    c.fillStyle = PALETTE.ink;
    for (let i = 0; i < 420; i++) {
      c.fillRect(r.next() * width, r.next() * height, 1, 1);
    }
    // Damp blooms. The manual lives against his chest and it rains for six of seven nights.
    if (wear > 0.05) {
      c.globalAlpha = 0.055 * wear;
      c.fillStyle = PALETTE.foxing;
      const blooms = Math.round(2 + wear * 9);
      for (let i = 0; i < blooms; i++) {
        const bx = r.next() * width, by = r.next() * height, br = (24 + r.next() * 90) * m.s;
        c.beginPath(); c.arc(bx, by, br, 0, Math.PI * 2); c.fill();
      }
    }
    // The fold. A spread has a valley down the middle; a single page has the crease at its edge.
    c.globalAlpha = 1;
    const fx = m.ox + (m.spread ? (m.pw * m.s) / 2 : m.pw * m.s);
    const g = c.createLinearGradient(fx - 26 * m.s, 0, fx + 26 * m.s, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, `rgba(30,28,22,${0.10 + wear * 0.08})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(fx - 26 * m.s, m.oy, 52 * m.s, PAGE.H * m.s);
    c.restore();
  }

  /** The panel number in the corner, and VIK & SØN. The maker's mark is the whole fiction. */
  _drawFurniture(c, env) {
    const { panel, hand, m } = env;
    if (panel.kind === 'blank') return;
    const y = PAGE.H - PAGE.margin - 6;
    const seed = panel.seed + 3001;
    if (panel.kind !== 'cover') {
      drawText(c, panel.displayId, PAGE.margin, y - 13, 15,
        { hand, weight: WEIGHTS.thin, seed, color: PALETTE.inkSoft });
    }
    // VIK & SØN, corner, every page. On Night Six it is traced and the Ø leans the wrong way.
    const mark = 'VIK & SØN';
    drawText(c, mark, m.pw - PAGE.margin, y - 11, 13, {
      align: 'right', hand, weight: WEIGHTS.hairline, seed: seed + 7,
      color: PALETTE.inkSoft, tracedO: this.def?.cover?.traced,
    });
    if (panel.articleNo) {
      drawText(c, panel.articleNo, m.pw / 2, y - 11, 12,
        { align: 'center', hand, weight: WEIGHTS.hairline, seed: seed + 9, color: PALETTE.inkSoft });
    }
    if (panel.step) {
      stepCircle(c, m.pw - PAGE.margin - 20, PAGE.margin + 20, panel.step,
        { hand, seed: seed + 11, dashed: panel.dashedStep, r: 16 });
    }
  }

  /**
   * The safety warning that appears after the player's first grab: BJØRN, standing, with a red
   * slash-circle over a second small figure. It is never acknowledged.
   */
  _drawGrabWarning(c, env) {
    const { hand, m, panel } = env;
    const x = PAGE.margin + 26, y = PAGE.H - PAGE.margin - 24;
    drawMascot(c, x - 18, y, 46, { hand, pose: 'standing-neutral', seed: panel.seed + 41, weight: WEIGHTS.medium });
    drawMascot(c, x + 26, y, 46, { hand, pose: 'arms-at-sides', seed: panel.seed + 43, weight: WEIGHTS.medium });
    slashCircle(c, x + 26, y - 23, 26, { color: this._accent(), seed: panel.seed + 45, hand });
  }

  _drawSmudges(c, idx, m) {
    for (const s of this.smudges) {
      if (s.panel !== idx) continue;
      c.save();
      c.globalAlpha = 0.30 * s.strength;
      c.fillStyle = '#3a2b22';
      const x = s.u * m.pw, y = s.v * PAGE.H;
      for (let i = 0; i < 5; i++) {
        c.beginPath();
        c.ellipse(x + i * 3.5 - 7, y + i * 1.6 - 3, 26 - i * 3, 9 - i, 0.5 + i * 0.1, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
    }
  }

  /** Draw a built exploded figure into a rect. Uniform scale, never below the legibility floor. */
  _drawFigure(c, fig, rect, env) {
    const { hand, panel } = env;
    // Reserve a column for magnified detail call-outs, so the assembly view never shrinks to
    // make room for them (GAME_DESIGN §8.4).
    const nIns = fig.insets ? Math.min(3, fig.insets.length) : 0;
    const col = nIns ? Math.min(rect.w * 0.34, MIN_SILHOUETTE * 2.6) : 0;
    // BJØRN stands in the bottom-right corner. Reserve his strip so a wide figure does not get
    // drawn straight through him — a scale reference you cannot separate from the part is not one.
    const mReserve = fig.mascot ? Math.min(rect.h * 0.17, 96) : 0;
    const inner = {
      x: rect.x, y: rect.y,
      w: Math.max(60, rect.w - col), h: Math.max(80, rect.h - mReserve),
    };
    const s = Math.max(0.18, Math.min(inner.w / fig.natural.w, inner.h / fig.natural.h));
    const fcx = (fig.bbox.x0 + fig.bbox.x1) / 2, fcy = (fig.bbox.y0 + fig.bbox.y1) / 2;
    const toPage = (fx, fy) => [inner.x + inner.w / 2 + (fx - fcx) * s, inner.y + inner.h / 2 + (fy - fcy) * s];
    c.save();
    c.translate(inner.x + inner.w / 2, inner.y + inner.h / 2);
    c.scale(s, s);
    c.translate(-fcx, -fcy);
    const ws = 1 / s;   // keep line weights constant on the page regardless of figure scale

    // Leader lines first, under everything.
    for (let i = 0; i < fig.leaders.length; i++) {
      const L = fig.leaders[i];
      strokePath(c, L, {
        hand, weight: WEIGHTS.thin * ws, color: PALETTE.inkSoft, dash: [7 * ws, 6 * ws],
        seed: panel.seed + 200 + i, step: 9,
      });
    }

    for (const d of fig.drawn) {
      const isInstall = !!d.inst.isInstall;
      const isSeat = !!d.inst.isSeat;
      // Seat outlines are the faintest thing on the page: present, but obviously not the subject.
      const w = (isInstall ? WEIGHTS.heavy : (isSeat ? WEIGHTS.thin : WEIGHTS.medium)) * ws;
      const col = d.inst.red ? this._accent() : (isSeat ? PALETTE.inkSoft : PALETTE.ink);
      const alpha = isInstall ? 1 : (isSeat ? 0.42 : 0.78);
      for (let i = 0; i < d.polys.length; i++) {
        strokePath(c, d.polys[i], {
          hand, weight: w, color: col, alpha,
          dash: d.inst.dotted ? (isSeat ? [5 * ws, 5 * ws] : [3.5 * ws, 4.5 * ws]) : null,
          seed: panel.seed + 400 + i * 7, step: 7 * ws,
        });
      }
      if (isSeat) continue;      // no bolt-hole detail on a ghost
      for (let i = 0; i < d.detailPolys.length; i++) {
        strokePath(c, d.detailPolys[i], {
          hand, weight: WEIGHTS.hairline * ws, color: PALETTE.inkSoft, alpha: alpha * 0.9,
          seed: panel.seed + 600 + i * 5, step: 6 * ws,
        });
      }
    }

    /*
     * THE ARROW VOCABULARY, drawn. `fig.arrows` is the closed set from `_buildArrows`; this is
     * the only place any of it reaches ink, and there is no sixth form.
     */
    const accent = this._accent();
    for (let i = 0; i < (fig.arrows?.length ?? 0); i++) {
      const a = fig.arrows[i];
      const sd = panel.seed + 700 + i * 5;
      if (a.kind === 'straight') {
        arrowStraight(c, a.from[0], a.from[1], a.to[0], a.to[1],
          { hand, weight: WEIGHTS.medium * ws, size: 12 * ws, seed: sd });
      } else if (a.kind === 'curved') {
        arrowCurved(c, a.at[0], a.at[1], a.r, a.a0, a.a1,
          { hand, weight: WEIGHTS.medium * ws, size: 10 * ws, seed: sd });
      } else if (a.kind === 'double') {
        arrowDouble(c, a.from[0], a.from[1], a.to[0], a.to[1], {
          hand, weight: WEIGHTS.thin * ws, size: 9 * ws, seed: sd,
          witness: a.witness * ws, divisions: a.divisions,
        });
      } else if (a.kind === 'circular') {
        arrowCircular(c, a.at[0], a.at[1], a.r * ws,
          { hand, weight: WEIGHTS.medium * ws, seed: sd, turns: a.turns });
      } else if (a.kind === 'crossed') {
        /*
         * DO NOT DO THIS. The part again, in the orientation that will not seat, boxed and struck
         * through in the accent red. It is the only red on an ordinary page.
         */
        const r = a.rect;
        strokePoly(c, [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h], [r.x, r.y]],
          { hand, weight: WEIGHTS.thin * ws, color: PALETTE.inkSoft, seed: sd, closed: true });
        const part = this.def?.parts?.find((p) => p.id === a.partId);
        if (part) {
          this._part(c, part.type, r.x + r.w / 2, r.y + r.h / 2, r.w * 0.78, {
            hand, seed: sd + 3, fitH: r.h * 0.70, weight: WEIGHTS.medium * ws,
            yaw: a.wrongYaw, mirror: !!a.mirror,
          });
        }
        crossOutBox(c, r.x, r.y, r.w, r.h,
          { hand, weight: WEIGHTS.heavy * ws, color: accent, seed: sd + 5 });
      }
    }

    /*
     * The figure shows two or three of a run of identical parts; the call-out says how many
     * there actually are. On Night Three the manual gives up on drawing them at all and this
     * becomes the whole step: one arrow and ×6.
     */
    if (fig.counts) {
      let k = 0;
      for (const g of fig.counts) {
        if (g.total <= g.shown || fig.insets.some((q) => q.type === g.type)) continue;
        hardwareCallout(c, fig.bbox.x1 - 18 * ws, fig.bbox.y0 + (20 + k * 46) * ws, g.total,
          { hand, seed: panel.seed + 840 + k, r: 18 * ws, weight: WEIGHTS.medium * ws });
        k++;
      }
    }

    if (fig.mirrored) {
      // G2: the axis is dashed and the right half is simply not drawn.
      const ax = fig.bbox.x1 - 6, ay0 = fig.bbox.y0 - 8, ay1 = fig.bbox.y1 + 8;
      strokePath(c, [ax, ay0, ax, ay1], { hand, weight: WEIGHTS.thin * ws, color: PALETTE.inkSoft, dash: [10 * ws, 7 * ws], seed: panel.seed + 901 });
      mirrorGlyph(c, ax, (ay0 + ay1) / 2, 13 * ws, { hand, weight: WEIGHTS.medium * ws, seed: panel.seed + 902 });
    }
    if (fig.hiddenCount > 0) {
      // G3: the bag says eight, the drawing shows six. The manual assumes you can see that.
      bagIcon(c, fig.bbox.x0 + 22, fig.bbox.y0 + 6, 40 * ws, 8, { hand, seed: panel.seed + 903 });
    }
    c.restore();

    /*
     * BJØRN. 1.7 m in the same projection and at the same scale as the assembly — so he is a true
     * scale reference — but positioned in PAGE units at the figure's lower-right, where the keyart
     * puts him, and therefore costing the assembly nothing. He always faces the −Z screen axis:
     * match your own view of the plot to his and you are standing where the drawing is standing.
     * That is G1, and it is the only navigation aid the manual will ever give you.
     */
    if (fig.mascot) {
      const mh = Math.max(34, Math.min(rect.h * 0.34, fig.mascot.metres * NOMINAL_SCALE * s));
      drawMascot(c, rect.x + rect.w - mh * 0.42 - col, rect.y + rect.h - 4, mh, {
        hand, pose: env.night >= 6 ? 'arms-at-sides' : (env.night >= 3 ? 'standing-neutral' : 'hammer'),
        seed: panel.seed + 800, weight: WEIGHTS.figure,
      });
    }

    /*
     * Magnified detail call-outs, drawn in page units in their reserved column: a circle, the
     * part at a size that clears the legibility floor, a dashed leader back to the join it
     * belongs to, and a ×N count. No words. A real flat-pack sheet does exactly this with a
     * hinge, and it is the only answer that keeps both the invariant and the assembly view.
     */
    for (let i = 0; i < nIns; i++) {
      const ins = fig.insets[i];
      const R = MIN_SILHOUETTE * 0.72;
      const cx = rect.x + rect.w - col / 2;
      const cy = rect.y + R * 1.3 + i * R * 2.6;
      const a = toPage(ins.at[0], ins.at[1]);
      strokePath(c, [cx - R * 0.72, cy + R * 0.72, a[0], a[1]], {
        hand, weight: WEIGHTS.hairline, color: PALETTE.inkSoft, dash: [6, 5],
        seed: panel.seed + 960 + i, step: 9,
      });
      strokePath(c, circlePts(cx, cy, R, 28), { hand, weight: WEIGHTS.medium, seed: panel.seed + 950 + i, step: 6 });
      this._part(c, ins.type, cx, cy, R * 1.42, { hand, seed: panel.seed + 970 + i, fitH: R * 1.42 });
      hardwareCallout(c, cx + R * 0.86, cy + R * 0.86, ins.count, { hand, seed: panel.seed + 980 + i, r: 13 });
    }
    return s;
  }

  /** The one-figure page used by every generated assembly panel. */
  _pageExploded(c, env) {
    const { panel, box } = env;
    const fig = panel.figures[0];
    if (!fig) { this._pagePartsRow(c, env); return; }
    packPage(panel.figures, box);
    for (const f of panel.figures) this._drawFigure(c, f, f.rect ?? box, env);
    const stageSlots = this.def.slots.filter((s) => s.stage === panel.stage);
    const fast = stageSlots.reduce((a, s) => a + (s.fasteners ?? 0), 0);
    if (fast > 0) {
      hardwareCallout(c, box.x + box.w - 46, box.y + box.h - 40, fast, { hand: env.hand, seed: panel.seed + 21 });
    }
    // The manual is the inventory display: filled circles are the fasteners in your pocket.
    const held = Math.min(fast, this.state?.inventory?.length ? 12 : 12);
    fastenerRing(c, box.x + 52, box.y + box.h - 44, 26, Math.min(fast, 10), Math.min(fast, held),
      { hand: env.hand, seed: panel.seed + 31 });
  }

  /** A fallback row of parts when a figure could not be built. Still legible, still wordless. */
  _pagePartsRow(c, env) {
    const { box, hand, panel } = env;
    const parts = this.def.parts.slice(0, 4);
    const cw = box.w / Math.max(1, parts.length);
    parts.forEach((p, i) => {
      const slot = { position: { x: 0, y: 0, z: 0 }, yaw: 0 };
      const inst = makeInstance(p, slot, null, {});
      const drawn = projectInstances([inst], NOMINAL_SCALE);
      const bb = bboxOfDrawn(drawn);
      const s = Math.min((cw - 30) / Math.max(1, bb.x1 - bb.x0), (box.h * 0.5) / Math.max(1, bb.y1 - bb.y0), 1.6);
      c.save();
      c.translate(box.x + cw * (i + 0.5), box.y + box.h * 0.4);
      c.scale(s, s);
      c.translate(-(bb.x0 + bb.x1) / 2, -(bb.y0 + bb.y1) / 2);
      for (const d of drawn) {
        for (let k = 0; k < d.polys.length; k++) {
          strokePath(c, d.polys[k], { hand, weight: WEIGHTS.heavy / s, color: PALETTE.ink, seed: panel.seed + i * 40 + k, step: 7 / s });
        }
      }
      c.restore();
      if (p.articleNo) {
        drawText(c, p.articleNo, box.x + cw * (i + 0.5), box.y + box.h * 0.62, 12,
          { align: 'center', hand, weight: WEIGHTS.hairline, seed: panel.seed + 500 + i, color: PALETTE.inkSoft });
      }
    });
  }

  update(_dt, _elapsed) { /* nothing per frame. Pages are baked by BlueprintUI. */ }

  resize(_w, _h) { /* the diagram is resolution independent; BlueprintUI re-bakes. */ }

  dispose() {
    for (const u of this._unsubs) { try { u?.(); } catch { /* already gone */ } }
    this._unsubs.length = 0;
    this._cache.clear();
    this.def = null;
    this.smudges.length = 0;
    this._disposed = true;
  }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 12. THE PAGES.
 *
 * One function per kind of drawing. Everything here is line art; nothing here is text except
 * article numbers, HJEM and the maker's mark. `Script.panels[].caption` describes these drawings
 * for developers and is never, under any circumstance, printed.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/** Draw one part, projected, centred at (x,y) and scaled to fit `fit` page units. */
Blueprint.prototype._part = function _part(c, type, x, y, fit, opt = {}) {
  const p = { id: 'X', type, articleNo: null };
  const inst = makeInstance(p, { position: { x: 0, y: 0, z: 0 }, yaw: opt.yaw ?? 0 }, null,
    { mirror: !!opt.mirror, scale: opt.scale ?? 1 });
  const drawn = projectInstances([inst], NOMINAL_SCALE);
  const bb = bboxOfDrawn(drawn);
  const w = Math.max(1, bb.x1 - bb.x0), h = Math.max(1, bb.y1 - bb.y0);
  const s = opt.exactScale ?? Math.min(fit / w, (opt.fitH ?? fit) / h);
  c.save();
  c.translate(x, y);
  c.scale(s, s);
  c.translate(-(bb.x0 + bb.x1) / 2, -(bb.y0 + bb.y1) / 2);
  const col = opt.color ?? PALETTE.ink;
  for (const d of drawn) {
    for (let k = 0; k < d.polys.length; k++) {
      strokePath(c, d.polys[k], {
        hand: opt.hand, weight: (opt.weight ?? WEIGHTS.heavy) / s, color: col,
        dash: opt.dotted ? [3.5 / s, 4.5 / s] : null, alpha: opt.alpha ?? 1,
        seed: (opt.seed ?? 11) + k * 3, step: 7 / s,
      });
    }
    for (let k = 0; k < d.detailPolys.length; k++) {
      strokePath(c, d.detailPolys[k], {
        hand: opt.hand, weight: WEIGHTS.hairline / s, color: PALETTE.inkSoft,
        alpha: (opt.alpha ?? 1) * 0.9, seed: (opt.seed ?? 11) + 300 + k, step: 6 / s,
      });
    }
  }
  c.restore();
  return { s, w: w * s, h: h * s };
};

const RENDERERS = {
  /* ── The cover ───────────────────────────────────────────────────────────────────── */
  cover(c, env) {
    const { hand, box, panel, m } = env;
    const cx = m.pw / 2;
    // The house, three-quarter elevation, in the same projection as everything else.
    const P = (x, y, z) => [projX(x, y, z, 56), projY(x, y, z, 56)];
    const { hx, hz, plate, ridge } = FOOT;
    const corners = [[-hx, hz], [hx, hz], [hx, -hz], [-hx, -hz]];
    const base = corners.map(([x, z]) => P(x, 0, z));
    const top = corners.map(([x, z]) => P(x, plate, z));
    const rid = [P(-hx, ridge, 0), P(hx, ridge, 0)];
    const off = [cx, box.y + 400];
    const T = (p) => [p[0] + off[0], p[1] + off[1]];
    const so = { hand, weight: WEIGHTS.heavy, seed: panel.seed, step: 7 };
    strokePoly(c, base.map(T).concat([T(base[0])]), { ...so });
    strokePoly(c, top.map(T).concat([T(top[0])]), { ...so, seed: panel.seed + 1 });
    for (let i = 0; i < 4; i++) strokePoly(c, [T(base[i]), T(top[i])], { ...so, seed: panel.seed + 2 + i });
    strokePoly(c, [T(rid[0]), T(rid[1])], { ...so, seed: panel.seed + 9 });
    for (let i = 0; i < 4; i++) {
      strokePoly(c, [T(top[i]), T(rid[i === 1 || i === 2 ? 1 : 0])], { ...so, seed: panel.seed + 12 + i });
    }
    // A door and a window. The first domestic shapes in the game.
    // 0.90 x 2.05 at deck level, 1.10 x 0.86 window: CabinSite's DOOR_W/DOOR_H/WIN_W/WIN_H.
    const dq = [P(-0.45, FOOT.deck, hz), P(0.45, FOOT.deck, hz),
      P(0.45, FOOT.deck + 2.05, hz), P(-0.45, FOOT.deck + 2.05, hz)];
    strokePoly(c, dq.map(T).concat([T(dq[0])]), { hand, weight: WEIGHTS.medium, seed: panel.seed + 20, step: 6 });
    const wq = [P(1.30, 1.70, hz), P(2.40, 1.70, hz), P(2.40, 2.56, hz), P(1.30, 2.56, hz)];
    strokePoly(c, wq.map(T).concat([T(wq[0])]), { hand, weight: WEIGHTS.medium, seed: panel.seed + 24, step: 6 });

    // HJEM. One word. The player parses it as a product name, the way you parse KALLAX.
    drawText(c, 'HJEM', cx, box.y + 30, 74, { align: 'center', hand, weight: WEIGHTS.heavy, seed: panel.seed + 40 });
    drawText(c, this.def.assemblyName ?? '', cx, box.y + 126, 22,
      { align: 'center', hand, weight: WEIGHTS.thin, seed: panel.seed + 44, color: PALETTE.inkSoft });
    if (panel.articleNo) {
      drawText(c, panel.articleNo, cx, box.y + box.h - 44, 15,
        { align: 'center', hand, weight: WEIGHTS.hairline, seed: panel.seed + 48, color: PALETTE.inkSoft });
    }
    drawText(c, 'VIK & SØN', cx, box.y + box.h - 14, 17, {
      align: 'center', hand, weight: WEIGHTS.thin, seed: panel.seed + 52, tracedO: this.def.cover.traced,
    });
  },

  /* ── The manifest: the parts bracket, the bag, and tonight's indignity in red ─────── */
  manifest(c, env) {
    const { hand, box, panel } = env;
    const parts = [];
    const seen = new Set();
    for (const p of this.def.parts) {
      if (seen.has(p.type)) continue;
      seen.add(p.type);
      parts.push({ type: p.type, count: this.def.parts.filter((q) => q.type === p.type).length, articleNo: p.articleNo });
      if (parts.length >= 6) break;
    }
    const cols = Math.max(1, Math.min(3, parts.length));
    const rows = Math.max(1, Math.ceil(parts.length / cols));
    const cw = box.w / cols, ch = Math.min(150, (box.h - 130) / rows);

    /*
     * WHICH SHORTFALL THIS PAGE IS ABOUT, and which contents row wears the red.
     *
     * `partType` is an exact match against the row's `PART_TYPES` key; the `p.count === s.count`
     * arm is the old coincidence-match, kept so a row without a `partType` behaves as before.
     *
     * Two things were wrong here. (1) Night 1's rows carried no `count`, so `isShort` was never
     * true and the manual never went red on the night whose entire lesson is the red outline.
     * (2) `find(s => !s.found)` picked whichever unfound shortfall came first — on Night 1 the
     * mallet, which has no contents row at all — and once every shortfall was found it returned
     * `undefined` and the inset VANISHED, when §6.9's reward is that it redraws in black with a
     * tick. So: prefer an unfound shortfall the contents list actually draws, then any unfound
     * one (for the inset alone), then the first — which is the found state, and stays on the page.
     */
    const drawnAs = (s, p) => !!s && (s.partType ? s.partType === p.type : (!!s.count && p.count === s.count));
    const shorts = this.def.shortfalls.filter((s) => s && !s.phantom);
    const short = shorts.find((s) => !s.found && parts.some((p) => drawnAs(s, p)))
      ?? shorts.find((s) => !s.found)
      ?? shorts[0]
      ?? null;

    // The parts bracket — a square bracket around the whole contents list.
    strokePoly(c, [[box.x + 6, box.y + 4], [box.x - 2, box.y + 4], [box.x - 2, box.y + ch * rows + 26], [box.x + 6, box.y + ch * rows + 26]],
      { hand, weight: WEIGHTS.medium, seed: panel.seed + 2 });
    strokePoly(c, [[box.x + box.w - 6, box.y + 4], [box.x + box.w + 2, box.y + 4], [box.x + box.w + 2, box.y + ch * rows + 26], [box.x + box.w - 6, box.y + ch * rows + 26]],
      { hand, weight: WEIGHTS.medium, seed: panel.seed + 3 });

    parts.forEach((p, i) => {
      const x = box.x + cw * (i % cols) + cw / 2;
      const y = box.y + 34 + ch * Math.floor(i / cols) + ch / 2;
      const isShort = !!short && !short.found && drawnAs(short, p);
      this._part(c, p.type, x, y, cw * 0.54, {
        hand, seed: panel.seed + 100 + i * 9, fitH: ch * 0.50,
        color: isShort ? this._accent() : PALETTE.ink,
      });
      hardwareCallout(c, x + cw * 0.30, y + ch * 0.26, p.count, { hand, seed: panel.seed + 140 + i, r: 16 });
      drawText(c, p.articleNo ?? '', x, y + ch * 0.34, 12,
        { align: 'center', hand, weight: WEIGHTS.hairline, seed: panel.seed + 160 + i, color: PALETTE.inkSoft });
    });

    // The bag of fasteners for the night.
    bagIcon(c, box.x + 46, box.y + box.h - 66, 56, this.def.hardware.fasteners, { hand, seed: panel.seed + 200 });

    /*
     * The shortfall. A red outline and a 40 × 40 m contour inset: the region, never the object.
     * The manual has always known. It is not lying and it is not sorry.
     */
    if (short && short.at) {
      const ix = box.x + box.w - 190, iy = box.y + box.h - 176;
      strokePoly(c, [[ix, iy], [ix + 170, iy], [ix + 170, iy + 150], [ix, iy + 150], [ix, iy]],
        { hand, weight: WEIGHTS.medium, color: short.found ? PALETTE.ink : this._accent(), seed: panel.seed + 210, closed: true });
      for (let k = 0; k < 5; k++) {
        const pts = [];
        const rr = 22 + k * 13;
        for (let a = 0; a <= 26; a++) {
          const t = (a / 26) * Math.PI * 2;
          const w = rr * (0.72 + 0.34 * valueNoise2(Math.cos(t) * 1.7 + k * 3.1, Math.sin(t) * 1.7 + k * 3.1));
          pts.push(ix + 85 + Math.cos(t) * w, iy + 75 + Math.sin(t) * w * 0.82);
        }
        strokePath(c, pts, { hand, weight: WEIGHTS.hairline, color: PALETTE.inkSoft, seed: panel.seed + 220 + k, step: 7, alpha: 0.85 });
      }
      if (short.found) tickMark(c, ix + 148, iy + 24, 15, { hand, seed: panel.seed + 240 });
      else fillDot(c, ix + 85, iy + 75, 3.2, this._accent());
    }
  },

  exploded(c, env) { this._pageExploded(c, env); },

  /* ── Night One. HELPFUL. Delighted with you. ─────────────────────────────────────── */
  wave(c, env) {
    const { hand, box, panel } = env;
    drawMascot(c, box.x + box.w * 0.22, box.y + box.h * 0.62, box.h * 0.42,
      { hand, pose: 'waving', seed: panel.seed });
    this._part(c, 'pier', box.x + box.w * 0.68, box.y + box.h * 0.48, box.w * 0.30, { hand, seed: panel.seed + 20 });
    arrowStraight(c, box.x + box.w * 0.68, box.y + box.h * 0.16, box.x + box.w * 0.68, box.y + box.h * 0.34,
      { hand, seed: panel.seed + 30 });
  },

  'bolt-magnifier'(c, env) {
    // A bolt going into a hole. Then the same bolt, larger. Then again, with a magnifier over it.
    const { hand, box, panel } = env;
    const y = box.y + box.h * 0.42;
    const xs = [box.x + box.w * 0.18, box.x + box.w * 0.48, box.x + box.w * 0.80];
    const scales = [0.10, 0.16, 0.24];
    xs.forEach((x, i) => {
      this._part(c, 'fastener', x, y, box.w * scales[i], { hand, seed: panel.seed + i * 17, fitH: box.h * 0.42 });
      strokePoly(c, [[x - box.w * scales[i] * 0.8, y + box.h * 0.16], [x + box.w * scales[i] * 0.8, y + box.h * 0.16]],
        { hand, weight: WEIGHTS.heavy, seed: panel.seed + 40 + i });
      strokePath(c, circlePts(x, y + box.h * 0.16, box.w * scales[i] * 0.16, 14),
        { hand, weight: WEIGHTS.medium, seed: panel.seed + 50 + i });
      arrowStraight(c, x, y - box.h * 0.24, x, y - box.h * 0.06, { hand, seed: panel.seed + 60 + i, size: 11 + i * 3 });
    });
    magnifier(c, xs[2], y + box.h * 0.02, box.w * 0.15, { hand, seed: panel.seed + 80 });
    if (TONE[env.night].sparkle) sparkle(c, box.x + box.w * 0.90, box.y + box.h * 0.14, 11, { hand, seed: panel.seed + 90 });
  },

  'scale-ref'(c, env) {
    // The mascot beside a pier. No dimension is printed. He is 1.7 m — your own eye height.
    const { hand, box, panel } = env;
    const feet = box.y + box.h * 0.78;
    const H = box.h * 0.46;
    drawMascot(c, box.x + box.w * 0.34, feet, H, { hand, pose: 'standing-neutral', seed: panel.seed });
    this._part(c, 'pier', box.x + box.w * 0.66, feet - H * 0.12, box.w * 0.24, { hand, seed: panel.seed + 20 });
    arrowDouble(c, box.x + box.w * 0.16, feet, box.x + box.w * 0.16, feet - H,
      { hand, seed: panel.seed + 30, witness: 22 });
  },

  'shim-fix'(c, env) {
    // A rectangle, and an arrow pointing it under the low pier. It does not care what the
    // rectangle is. It has always been a folded 1961 licence plate.
    const { hand, box, panel } = env;
    const cx = box.x + box.w * 0.56, cy = box.y + box.h * 0.44;
    this._part(c, 'pier', cx, cy, box.w * 0.26, { hand, seed: panel.seed });
    const gap = cy + box.h * 0.16;
    strokePoly(c, [[cx - 60, gap], [cx + 60, gap]], { hand, weight: WEIGHTS.heavy, seed: panel.seed + 10 });
    strokePoly(c, [[cx - 46, gap - 9], [cx + 30, gap - 9], [cx + 30, gap - 2], [cx - 46, gap - 2], [cx - 46, gap - 9]],
      { hand, weight: WEIGHTS.medium, seed: panel.seed + 12, closed: true });
    arrowStraight(c, box.x + box.w * 0.16, gap - 5, cx - 52, gap - 5, { hand, seed: panel.seed + 14 });
    arrowDouble(c, cx + 70, gap - 9, cx + 70, gap - 2, { hand, seed: panel.seed + 16, size: 7, witness: 14 });
  },

  'closing-arms-up'(c, env) {
    // Standing on the finished foundation, both arms up. One drawn sparkle.
    const { hand, box, panel } = env;
    const feet = box.y + box.h * 0.62;
    const y = feet + 6;
    strokePoly(c, [[box.x + box.w * 0.22, y], [box.x + box.w * 0.78, y]],
      { hand, weight: WEIGHTS.heavy, seed: panel.seed + 1 });
    for (let i = 0; i < 3; i++) {
      this._part(c, 'pier', box.x + box.w * (0.30 + i * 0.20), y + 26, box.w * 0.11, { hand, seed: panel.seed + 10 + i });
    }
    drawMascot(c, box.x + box.w * 0.50, feet, box.h * 0.38, { hand, pose: 'arms-up', seed: panel.seed + 20 });
    if (TONE[env.night].sparkle) sparkle(c, box.x + box.w * 0.62, feet - box.h * 0.40, 13, { hand, seed: panel.seed + 30 });
    tickMark(c, box.x + box.w * 0.84, feet - 10, 18, { hand, seed: panel.seed + 40 });
  },

  /* ── Night Two. PEDANTIC. It has decided you are competent and now it is fussy. ──── */
  'angle-pedantry'(c, env) {
    const { hand, box, panel } = env;
    const y = box.y + box.h * 0.40;
    const xs = [0.18, 0.50, 0.82].map((t) => box.x + box.w * t);
    const angles = ['90°', '88°', '89.5°'];
    xs.forEach((x, i) => {
      this._part(c, 'bracket', x, y, box.w * 0.20, { hand, seed: panel.seed + i * 13, yaw: i === 0 ? 0 : (i === 1 ? 0.035 : 0.009) });
      arrowCurved(c, x, y, box.w * 0.135, -Math.PI * 0.9, -Math.PI * 0.35, { hand, seed: panel.seed + 40 + i, size: 9 });
      drawText(c, angles[i], x, y + box.h * 0.17, 15,
        { align: 'center', hand, weight: WEIGHTS.thin, seed: panel.seed + 60 + i, color: i === 0 ? PALETTE.ink : this._accent() });
      if (i === 0) tickMark(c, x, y + box.h * 0.24, 17, { hand, seed: panel.seed + 70 });
      else slashCircle(c, x, y, box.w * 0.155, { hand, seed: panel.seed + 80 + i, color: this._accent() });
    });
  },

  mirror(c, env) {
    // G2. The left bay only. The right is its reflection and the bracket handedness flips.
    const { hand, box, panel } = env;
    const axis = box.x + box.w * 0.62;
    const fig = panel.figures[0];
    if (fig) {
      this._drawFigure(c, fig, { x: box.x, y: box.y, w: box.w * 0.60, h: box.h * 0.82 }, env);
    } else {
      this._part(c, 'joist', box.x + box.w * 0.30, box.y + box.h * 0.42, box.w * 0.44, { hand, seed: panel.seed });
      this._part(c, 'bracket', box.x + box.w * 0.30, box.y + box.h * 0.62, box.w * 0.11, { hand, seed: panel.seed + 6 });
    }
    strokePoly(c, [[axis, box.y + 10], [axis, box.y + box.h - 20]],
      { hand, weight: WEIGHTS.thin, color: PALETTE.inkSoft, dash: [11, 7], seed: panel.seed + 20 });
    mirrorGlyph(c, axis, box.y + box.h * 0.5, 16, { hand, weight: WEIGHTS.medium, seed: panel.seed + 22 });
    // The mirrored half: a handed bracket, drawn once, the other way round.
    this._part(c, 'bracket', axis + box.w * 0.20, box.y + box.h * 0.42, box.w * 0.13,
      { hand, seed: panel.seed + 30, mirror: true, alpha: 0.9 });
    arrowDouble(c, axis - 34, box.y + box.h * 0.24, axis + 34, box.y + box.h * 0.24, { hand, seed: panel.seed + 32 });
  },

  'torque-mouth'(c, env) {
    // A hand tightening a bolt, then the same hand over-tightened, and the mascot with a mouth.
    const { hand, box, panel } = env;
    const y = box.y + box.h * 0.38;
    this._part(c, 'fastener', box.x + box.w * 0.24, y, box.w * 0.13, { hand, seed: panel.seed, fitH: box.h * 0.30 });
    arrowCircular(c, box.x + box.w * 0.24, y, box.w * 0.11, { hand, seed: panel.seed + 10, turns: 0.85 });
    this._part(c, 'fastener', box.x + box.w * 0.60, y, box.w * 0.13, { hand, seed: panel.seed + 20, fitH: box.h * 0.30, color: this._accent() });
    arrowCircular(c, box.x + box.w * 0.60, y, box.w * 0.13, { hand, seed: panel.seed + 30, turns: 1.5, color: this._accent() });
    warnTriangle(c, box.x + box.w * 0.84, y, 30, { hand, seed: panel.seed + 40, color: this._accent() });
    // The mouth. One flat line. He does not have one again for three nights.
    drawMascot(c, box.x + box.w * 0.60, box.y + box.h * 0.92, box.h * 0.40,
      { hand, pose: 'standing-neutral', seed: panel.seed + 50, mouth: true });
  },

  'brace-sequence'(c, env) {
    // Brace before you release: a circled 3, then a circled 4, drawn in that order and not in
    // that position.
    const { hand, box, panel } = env;
    const fig = panel.figures[0];
    if (fig) this._drawFigure(c, fig, { x: box.x, y: box.y, w: box.w, h: box.h * 0.78 }, env);
    stepCircle(c, box.x + box.w * 0.74, box.y + box.h * 0.22, 3, { hand, seed: panel.seed + 4, r: 17 });
    stepCircle(c, box.x + box.w * 0.26, box.y + box.h * 0.70, 4, { hand, seed: panel.seed + 6, r: 17 });
    arrowStraight(c, box.x + box.w * 0.70, box.y + box.h * 0.30, box.x + box.w * 0.34, box.y + box.h * 0.62,
      { hand, seed: panel.seed + 8 });
  },

  /* ── Night Three. IMPATIENT. Steps get combined. It skips things. ────────────────── */
  collapsed(c, env) {
    // Eleven sub-assemblies collapsed into one drawing with fourteen arrows. Good luck.
    const { hand, box, panel } = env;
    const fig = panel.figures[0];
    if (fig) this._drawFigure(c, fig, box, env);
    const grid = makeRouteGrid(box.w, box.h, [{ x: box.w * 0.28, y: box.h * 0.28, w: box.w * 0.44, h: box.h * 0.44 }]);
    const r = new Rand(hashInt(panel.seed));
    c.save(); c.translate(box.x, box.y);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const x0 = box.w / 2 + Math.cos(a) * box.w * 0.44, y0 = box.h / 2 + Math.sin(a) * box.h * 0.42;
      const x1 = box.w / 2 + Math.cos(a) * box.w * 0.20, y1 = box.h / 2 + Math.sin(a) * box.h * 0.18;
      drawRoutedArrow(c, grid, x0, y0, x1, y1, { hand, seed: panel.seed + i * 3, size: 10, weight: WEIGHTS.thin });
      if (r.chance(0.45)) stepCircle(c, x0, y0, i + 1, { hand, seed: panel.seed + 200 + i, r: 12, dashed: true });
    }
    c.restore();
  },

  'cut-line'(c, env) {
    // The ridge beam with one cut line across it and no dimension printed. The saw is drawn
    // once, small, in the corner, held by nobody.
    const { hand, box, panel } = env;
    const y = box.y + box.h * 0.40;
    const r = this._part(c, 'ridge', box.x + box.w / 2, y, box.w * 0.86, { hand, seed: panel.seed, fitH: box.h * 0.30 });
    const cutX = box.x + box.w / 2 + r.w * 0.38;
    strokePoly(c, [[cutX, y - 40], [cutX, y + 40]],
      { hand, weight: WEIGHTS.medium, color: this._accent(), dash: [8, 6], seed: panel.seed + 10 });
    arrowStraight(c, cutX, y - 74, cutX, y - 46, { hand, seed: panel.seed + 12, color: this._accent() });
    // The saw. Small. In the corner. Held by nobody.
    const sx = box.x + box.w * 0.80, sy = box.y + box.h * 0.80;
    strokePoly(c, [[sx - 52, sy], [sx + 40, sy - 14], [sx + 44, sy - 4], [sx - 48, sy + 10], [sx - 52, sy]],
      { hand, weight: WEIGHTS.medium, seed: panel.seed + 20, closed: true });
    const teeth = [];
    for (let i = 0; i <= 16; i++) teeth.push([sx - 48 + i * 5.6, sy + 10 - i * 0.9 + (i % 2 ? 0 : 4)]);
    strokePoly(c, teeth, { hand, weight: WEIGHTS.hairline, seed: panel.seed + 22 });
    strokePoly(c, [[sx - 52, sy], [sx - 70, sy - 6], [sx - 74, sy + 8], [sx - 56, sy + 12]],
      { hand, weight: WEIGHTS.medium, seed: panel.seed + 24, closed: true });
  },

  'one-arrow'(c, env) {
    // An entire step rendered as one downward arrow and ×6.
    const { hand, box, panel } = env;
    arrowStraight(c, box.x + box.w * 0.42, box.y + box.h * 0.18, box.x + box.w * 0.42, box.y + box.h * 0.68,
      { hand, seed: panel.seed, size: 24, weight: WEIGHTS.heavy });
    hardwareCallout(c, box.x + box.w * 0.60, box.y + box.h * 0.44, 6, { hand, seed: panel.seed + 4, r: 26 });
  },

  'hidden-gussets'(c, env) {
    // G3. The bag says eight. The drawing shows six. Two are behind the visible geometry and
    // the manual assumes you can see that.
    const { hand, box, panel } = env;
    const y = box.y + box.h * 0.44;
    for (let i = 0; i < 6; i++) {
      const x = box.x + box.w * (0.13 + (i % 3) * 0.27);
      const yy = y + (i < 3 ? -box.h * 0.14 : box.h * 0.14);
      this._part(c, 'gusset', x, yy, box.w * 0.18, { hand, seed: panel.seed + i * 7, fitH: box.h * 0.18 });
    }
    // The two that are not drawn — dotted, through the occluder.
    for (let i = 0; i < 2; i++) {
      this._part(c, 'gusset', box.x + box.w * (0.72 + i * 0.14), y + (i ? box.h * 0.14 : -box.h * 0.14),
        box.w * 0.18, { hand, seed: panel.seed + 40 + i, fitH: box.h * 0.18, dotted: true, alpha: 0.85 });
    }
    bagIcon(c, box.x + box.w * 0.10, box.y + box.h * 0.88, 58, 8, { hand, seed: panel.seed + 60 });
  },

  tapping(c, env) {
    // The mascot, arms folded, tapping one foot. It is waiting for you.
    const { hand, box, panel } = env;
    drawMascot(c, box.x + box.w * 0.5, box.y + box.h * 0.80, box.h * 0.54,
      { hand, pose: 'tapping', seed: panel.seed });
  },

  /* ── Night Four. KNOWING. It draws things it should not know about. ──────────────── */
  'hinge-in-situ'(c, env) {
    const { hand, box, panel } = env;
    // The hinge, in isolation.
    this._part(c, 'hinge', box.x + box.w * 0.20, box.y + box.h * 0.24, box.w * 0.22, { hand, seed: panel.seed, fitH: box.h * 0.22 });
    hardwareCallout(c, box.x + box.w * 0.34, box.y + box.h * 0.30, 3, { hand, seed: panel.seed + 4, r: 17 });
    // Then in situ. Screwed to a door that belongs to somebody else, with the oar against it.
    const dx = box.x + box.w * 0.64, dy = box.y + box.h * 0.58;
    const dw = box.w * 0.28, dh = box.h * 0.60;
    strokePoly(c, [[dx - dw / 2, dy - dh / 2], [dx + dw / 2, dy - dh / 2], [dx + dw / 2, dy + dh / 2],
      [dx - dw / 2, dy + dh / 2], [dx - dw / 2, dy - dh / 2]],
    { hand, weight: WEIGHTS.heavy, seed: panel.seed + 10, closed: true });
    for (let i = 0; i < 3; i++) {
      this._part(c, 'hinge', dx - dw / 2, dy - dh * 0.3 + i * dh * 0.3, box.w * 0.10, { hand, seed: panel.seed + 20 + i, fitH: 34 });
    }
    strokePoly(c, [[dx + dw * 0.3, dy + dh / 2 + 14], [dx + dw * 0.9, dy - dh * 0.34]],
      { hand, weight: WEIGHTS.medium, seed: panel.seed + 30 });
    strokePoly(c, [[dx + dw * 0.86, dy - dh * 0.30], [dx + dw * 0.98, dy - dh * 0.42], [dx + dw * 1.02, dy - dh * 0.30], [dx + dw * 0.90, dy - dh * 0.22]],
      { hand, weight: WEIGHTS.medium, seed: panel.seed + 32, closed: true });
    arrowStraight(c, box.x + box.w * 0.38, box.y + box.h * 0.30, dx - dw * 0.68, dy - dh * 0.30, { hand, seed: panel.seed + 40 });
  },

  'scale-ambiguity'(c, env) {
    /*
     * G4. Two beams that differ only in length. No dimensions are printed. The dimension arrow
     * carries unit divisions instead of a numeral: count 16 against 13 and you have your ratio.
     * The mascot between them is the only absolute scale reference, and he is 1.7 m, which is
     * the player's own eye height.
     */
    const { hand, box, panel } = env;
    const yA = box.y + box.h * 0.24, yB = box.y + box.h * 0.66;
    const a = this._part(c, 'beam', box.x + box.w * 0.52, yA, box.w * 0.80, { hand, seed: panel.seed, fitH: box.h * 0.18 });
    const b = this._part(c, 'beamShort', box.x + box.w * 0.46, yB, box.w * 0.80, { hand, seed: panel.seed + 9, fitH: box.h * 0.18, exactScale: a.s });
    arrowDouble(c, box.x + box.w * 0.52 - a.w / 2, yA + 42, box.x + box.w * 0.52 + a.w / 2, yA + 42,
      { hand, seed: panel.seed + 20, witness: 18, divisions: 16 });
    arrowDouble(c, box.x + box.w * 0.46 - b.w / 2, yB + 42, box.x + box.w * 0.46 + b.w / 2, yB + 42,
      { hand, seed: panel.seed + 30, witness: 18, divisions: 13 });
    drawMascot(c, box.x + box.w * 0.07, yB - 6, box.h * 0.34, { hand, pose: 'standing-neutral', seed: panel.seed + 40 });
  },

  'light-cone'(c, env) {
    // A cone of light on the ground. The mascot outside the cone. A dotted path.
    // The first panel that is about them and not about the house.
    const { hand, box, panel } = env;
    const ax = box.x + box.w * 0.72, ay = box.y + box.h * 0.20;
    strokePoly(c, [[ax, ay], [ax - box.w * 0.30, box.y + box.h * 0.80], [ax + box.w * 0.18, box.y + box.h * 0.86], [ax, ay]],
      { hand, weight: WEIGHTS.medium, seed: panel.seed, closed: true });
    for (let i = 0; i < 5; i++) {
      strokePoly(c, [[ax - box.w * (0.05 + i * 0.05), ay + box.h * (0.18 + i * 0.12)],
        [ax - box.w * (0.02 + i * 0.05), ay + box.h * (0.26 + i * 0.12)]],
      { hand, weight: WEIGHTS.hairline, color: PALETTE.inkSoft, seed: panel.seed + 10 + i });
    }
    drawMascot(c, box.x + box.w * 0.18, box.y + box.h * 0.78, box.h * 0.38, { hand, pose: 'watching', seed: panel.seed + 20 });
    const path = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      path.push(box.x + box.w * (0.18 + t * 0.52), box.y + box.h * (0.86 - Math.sin(t * Math.PI) * 0.18));
    }
    strokePath(c, path, { hand, weight: WEIGHTS.thin, color: PALETTE.inkSoft, dash: [5, 6], seed: panel.seed + 30, step: 8 });
  },

  'horizontal-shape'(c, env) {
    /*
     * Panel 4.9. The mascot standing over a horizontal shape. The shape is not a joist. It has
     * shoes, and a double-headed dimension arrow reading 1.78 m. The manual measured him.
     * Lay it out as an ordinary panel. No zoom, no hold, no emphasis of any kind.
     */
    const { hand, box, panel } = env;
    const y = box.y + box.h * 0.62;
    const len = box.w * 0.62;
    drawHorizontalShape(c, box.x + box.w * 0.52, y, len, { hand, seed: panel.seed });
    drawMascot(c, box.x + box.w * 0.24, y - 4, box.h * 0.44, { hand, pose: 'standing-over', seed: panel.seed + 10 });
    arrowDouble(c, box.x + box.w * 0.52 - len / 2, y + 44, box.x + box.w * 0.52 + len / 2, y + 44,
      { hand, seed: panel.seed + 20, witness: 18 });
    drawText(c, '1.78', box.x + box.w * 0.52, y + 56, 15,
      { align: 'center', hand, weight: WEIGHTS.hairline, seed: panel.seed + 24, color: PALETTE.inkSoft });
  },

  /* ── Night Five. COMPLICIT. It stops pretending this is only carpentry. ──────────── */
  'two-persons'(c, env) {
    // THIS STEP REQUIRES TWO PERSONS. Two mascots, one at each end of a wall panel. Both in
    // Marit's hand. Both drawn twenty-two years ago.
    const { hand, box, panel } = env;
    const y = box.y + box.h * 0.50;
    const marit = HANDS.marit;
    this._part(c, 'wallNorth', box.x + box.w / 2, y - box.h * 0.10, box.w * 0.70, { hand: marit, seed: panel.seed, fitH: box.h * 0.34 });
    drawMascot(c, box.x + box.w * 0.16, y + box.h * 0.30, box.h * 0.40, { hand: marit, pose: 'hand-raised', seed: panel.seed + 10 });
    drawMascot(c, box.x + box.w * 0.84, y + box.h * 0.30, box.h * 0.40, { hand: marit, pose: 'hand-raised', seed: panel.seed + 12 });
    warnTriangle(c, box.x + box.w * 0.50, box.y + box.h * 0.86, 30, { hand, seed: panel.seed + 20, color: this._accent() });
    hardwareCallout(c, box.x + box.w * 0.50, box.y + box.h * 0.14, 2, { hand, seed: panel.seed + 24, r: 19 });
  },

  sequence(c, env) {
    // G5. Step 7 top-left, step 2 bottom-right. A panel installed early blocks arm access to
    // the bracket behind it, and the diagram only hints at that.
    const { hand, box, panel } = env;
    const fig = panel.figures[0];
    if (fig) this._drawFigure(c, fig, { x: box.x, y: box.y + box.h * 0.10, w: box.w, h: box.h * 0.58 }, env);
    stepCircle(c, box.x + box.w * 0.14, box.y + box.h * 0.10, 7, { hand, seed: panel.seed, r: 17 });
    stepCircle(c, box.x + box.w * 0.86, box.y + box.h * 0.72, 2, { hand, seed: panel.seed + 2, r: 17, dashed: true });
    // The inset: a hand, a bolt behind a panel, and a red slash-circle. You cannot reach it later.
    const ix = box.x + box.w * 0.62, iy = box.y + box.h * 0.82;
    strokePoly(c, [[ix - 70, iy - 46], [ix + 70, iy - 46], [ix + 70, iy + 34], [ix - 70, iy + 34], [ix - 70, iy - 46]],
      { hand, weight: WEIGHTS.thin, color: PALETTE.inkSoft, seed: panel.seed + 10, closed: true });
    strokePoly(c, [[ix - 40, iy - 34], [ix - 40, iy + 24]], { hand, weight: WEIGHTS.heavy, seed: panel.seed + 12 });
    strokePath(c, circlePts(ix + 22, iy - 6, 9, 12), { hand, weight: WEIGHTS.medium, seed: panel.seed + 14 });
    arrowStraight(c, ix - 20, iy - 6, ix + 10, iy - 6, { hand, seed: panel.seed + 16, size: 10 });
    slashCircle(c, ix + 4, iy - 6, 30, { hand, seed: panel.seed + 18, color: this._accent() });
  },

  'erased-second'(c, env) {
    /*
     * Panel 5.4. The second figure: erased, redrawn, erased, redrawn smaller. Three ghosts under
     * the final line. No arrows, no numbers, no article number and no instruction.
     * It should not be in a manual at all. Do not score it, do not lock input, do not slow time.
     */
    const { hand, box, panel } = env;
    const feet = box.y + box.h * 0.72;
    const marit = HANDS.marit;
    drawMascot(c, box.x + box.w * 0.34, feet, box.h * 0.46, { hand: marit, pose: 'standing-neutral', seed: panel.seed });
    const ghosts = [
      { x: 0.66, h: 0.46, a: 0.16 },
      { x: 0.63, h: 0.38, a: 0.13 },
      { x: 0.615, h: 0.31, a: 0.11 },
    ];
    for (let i = 0; i < ghosts.length; i++) {
      const g = ghosts[i];
      c.save();
      c.globalAlpha = g.a;
      drawMascot(c, box.x + box.w * g.x, feet, box.h * g.h,
        { hand, pose: 'standing-neutral', seed: panel.seed + 20 + i, weight: WEIGHTS.medium });
      c.restore();
    }
    // The final line: smaller. 0.62× scale. It is not an adult. Nobody remarks on it.
    drawMascot(c, box.x + box.w * 0.60, feet, box.h * 0.46 * 0.62,
      { hand, pose: 'standing-neutral', seed: panel.seed + 40 });
  },

  counterweight(c, env) {
    // The counterweight, drawn as a dotted standing human outline, with the "approximate" tilde
    // and no number at all.
    const { hand, box, panel } = env;
    const y = box.y + box.h * 0.34;
    this._part(c, 'wallNorth', box.x + box.w * 0.40, y, box.w * 0.52, { hand, seed: panel.seed, fitH: box.h * 0.26 });
    arrowCurved(c, box.x + box.w * 0.16, y + box.h * 0.16, box.w * 0.20, -Math.PI * 0.86, -Math.PI * 0.2,
      { hand, seed: panel.seed + 10 });
    const cx = box.x + box.w * 0.78, cy = box.y + box.h * 0.74;
    drawMascot(c, cx, cy, box.h * 0.40, { hand, pose: 'arms-at-sides', seed: panel.seed + 20, dotted: true, weight: WEIGHTS.medium });
    drawText(c, '~', cx - 46, cy - box.h * 0.22, 22, { hand, weight: WEIGHTS.thin, seed: panel.seed + 30, color: PALETTE.inkSoft });
    strokePoly(c, [[cx - 74, cy + 8], [cx + 74, cy + 8]], { hand, weight: WEIGHTS.thin, color: PALETTE.inkSoft, dash: [6, 5], seed: panel.seed + 32 });
  },

  /* ── Night Six. WRONG. Not sinister-wrong. Broken-wrong, which is worse. ─────────── */
  'out-of-order'(c, env) {
    // Step 14 before step 9. Step 9 does not appear.
    const { hand, box, panel } = env;
    const fig = panel.figures[0];
    if (fig) this._drawFigure(c, fig, { x: box.x, y: box.y + box.h * 0.18, w: box.w, h: box.h * 0.70 }, env);
    stepCircle(c, box.x + box.w * 0.20, box.y + box.h * 0.08, 14, { hand, seed: panel.seed, r: 17 });
    stepCircle(c, box.x + box.w * 0.52, box.y + box.h * 0.10, 15, { hand, seed: panel.seed + 2, r: 17 });
    stepCircle(c, box.x + box.w * 0.82, box.y + box.h * 0.08, 16, { hand, seed: panel.seed + 4, r: 17 });
    arrowStraight(c, box.x + box.w * 0.26, box.y + box.h * 0.08, box.x + box.w * 0.46, box.y + box.h * 0.10, { hand, seed: panel.seed + 6 });
    arrowStraight(c, box.x + box.w * 0.58, box.y + box.h * 0.10, box.x + box.w * 0.76, box.y + box.h * 0.08, { hand, seed: panel.seed + 8 });
  },

  'phantom-article'(c, env) {
    /*
     * Panel 6.5. A confident arrow, an empty slot, and article 0000-000: the only number in the
     * manual with no year in it. It is not in the world. It has never been in the world.
     * Never hint it. Never acknowledge the search.
     */
    const { hand, box, panel } = env;
    const sx = box.x + box.w * 0.60, sy = box.y + box.h * 0.46;
    strokePoly(c, [[sx - 58, sy - 34], [sx + 58, sy - 34], [sx + 58, sy + 34], [sx - 58, sy + 34], [sx - 58, sy - 34]],
      { hand, weight: WEIGHTS.medium, dash: [7, 6], seed: panel.seed, closed: true });
    arrowStraight(c, box.x + box.w * 0.16, sy, sx - 74, sy, { hand, seed: panel.seed + 4, size: 16, weight: WEIGHTS.heavy });
    drawText(c, '0000-000', sx, sy + 62, 19, { align: 'center', hand, weight: WEIGHTS.thin, seed: panel.seed + 8 });
    // The parts bracket. Inside it, nothing.
    strokePoly(c, [[sx - 92, sy - 54], [sx - 100, sy - 54], [sx - 100, sy + 54], [sx - 92, sy + 54]],
      { hand, weight: WEIGHTS.medium, seed: panel.seed + 12 });
    strokePoly(c, [[sx + 92, sy - 54], [sx + 100, sy - 54], [sx + 100, sy + 54], [sx + 92, sy + 54]],
      { hand, weight: WEIGHTS.medium, seed: panel.seed + 14 });
  },

  errata(c, env) {
    /*
     * G6. The step the errata slip corrects. Without the slip the manual is confidently, serenely
     * incorrect and the join caps at w = 0.35. With it, a red correction stamps over the figure.
     */
    const { hand, box, panel } = env;
    const er = this.def.errataFull;
    const found = !!this.state?.toolsFound?.includes?.(er?.slipId) || !!this.state?.storyFlags?.foundErrataSlip;
    const part = this.def.parts.find((p) => p.id === er?.partId) ?? this.def.parts[0];
    const y = box.y + box.h * 0.42;
    if (!part) return;
    // As printed — wrong, and drawn with total confidence.
    this._part(c, part.type, box.x + box.w * 0.34, y, box.w * 0.34, {
      hand, seed: panel.seed, fitH: box.h * 0.42,
      yaw: er?.printedTransform?.yaw ?? Math.PI, mirror: !!er?.printedTransform?.mirror,
    });
    stepCircle(c, box.x + box.w * 0.34, box.y + box.h * 0.12, panel.step ?? 6, { hand, seed: panel.seed + 2, r: 17 });
    arrowStraight(c, box.x + box.w * 0.34, box.y + box.h * 0.19, box.x + box.w * 0.34, box.y + box.h * 0.28,
      { hand, seed: panel.seed + 4 });
    if (found) {
      slashCircle(c, box.x + box.w * 0.34, y, box.w * 0.21, { hand, seed: panel.seed + 10, color: this._accent() });
      this._part(c, part.type, box.x + box.w * 0.74, y, box.w * 0.34, {
        hand, seed: panel.seed + 20, fitH: box.h * 0.42, color: this._accent(),
        yaw: er?.correctTransform?.yaw ?? 0, mirror: false,
      });
      arrowStraight(c, box.x + box.w * 0.52, y, box.x + box.w * 0.60, y, { hand, seed: panel.seed + 22, color: this._accent() });
      tickMark(c, box.x + box.w * 0.90, y - box.h * 0.20, 18, { hand, seed: panel.seed + 24, color: this._accent() });
    }
  },

  'kitchen-elevation'(c, env) {
    /*
     * Panel 6.8. A wall elevation in perfect Marit line — a window over a sink, four pencil marks
     * on a doorframe at ascending heights — with a bunk bed drawn over the top of it in a
     * scratched hand, and erased. The ghost stays.
     * He is trying to make his mother's house fit a camp. It doesn't.
     */
    const { box, panel } = env;
    const marit = HANDS.marit;
    const ansel = HANDS.ansel;
    const x0 = box.x + box.w * 0.10, x1 = box.x + box.w * 0.90;
    const yTop = box.y + box.h * 0.14, yBot = box.y + box.h * 0.82;
    strokePoly(c, [[x0, yTop], [x1, yTop], [x1, yBot], [x0, yBot], [x0, yTop]],
      { hand: marit, weight: WEIGHTS.heavy, seed: panel.seed, closed: true });
    const wx = x0 + (x1 - x0) * 0.30, wy = yTop + (yBot - yTop) * 0.26;
    const ww = (x1 - x0) * 0.26, wh = (yBot - yTop) * 0.26;
    strokePoly(c, [[wx - ww / 2, wy - wh / 2], [wx + ww / 2, wy - wh / 2], [wx + ww / 2, wy + wh / 2], [wx - ww / 2, wy + wh / 2], [wx - ww / 2, wy - wh / 2]],
      { hand: marit, weight: WEIGHTS.medium, seed: panel.seed + 4, closed: true });
    strokePoly(c, [[wx, wy - wh / 2], [wx, wy + wh / 2]], { hand: marit, weight: WEIGHTS.thin, seed: panel.seed + 6 });
    strokePoly(c, [[wx - ww / 2, wy], [wx + ww / 2, wy]], { hand: marit, weight: WEIGHTS.thin, seed: panel.seed + 8 });
    // The sink under it. The rectangle missing from its splash-back is on his face.
    this._part(c, 'sink', wx, wy + wh * 0.98, ww * 1.1, { hand: marit, seed: panel.seed + 10, fitH: wh * 0.9 });
    // The doorframe, with its four pencil marks. Nothing is dimensioned. Nothing is explained.
    const dxx = x0 + (x1 - x0) * 0.76;
    this._part(c, 'doorframe', dxx, (yTop + yBot) / 2 + 10, (x1 - x0) * 0.22,
      { hand: marit, seed: panel.seed + 20, fitH: (yBot - yTop) * 0.84 });
    // The bunk bed, in his hand, over the top of hers. Erased. The ghost stays.
    c.save();
    c.globalAlpha = HANDS.ansel.ghostAlpha;
    const bx = x0 + (x1 - x0) * 0.34, by = yTop + (yBot - yTop) * 0.62;
    const bw = (x1 - x0) * 0.44, bh = (yBot - yTop) * 0.44;
    strokePoly(c, [[bx - bw / 2, by + bh / 2], [bx + bw / 2, by + bh / 2]], { hand: ansel, weight: WEIGHTS.heavy, seed: panel.seed + 30 });
    strokePoly(c, [[bx - bw / 2, by - bh / 2], [bx + bw / 2, by - bh / 2]], { hand: ansel, weight: WEIGHTS.heavy, seed: panel.seed + 32 });
    for (const s of [-1, 1]) {
      strokePoly(c, [[bx + s * bw / 2, by - bh / 2 - 26], [bx + s * bw / 2, by + bh / 2 + 20]],
        { hand: ansel, weight: WEIGHTS.medium, seed: panel.seed + 34 + s });
    }
    strokePoly(c, [[bx - bw / 2, by], [bx + bw / 2, by]], { hand: ansel, weight: WEIGHTS.thin, seed: panel.seed + 38 });
    c.restore();
  },

  alone(c, env) {
    // Panel 6.9. The figure, alone, centre of an otherwise empty page. Not doing anything.
    const { hand, box, panel } = env;
    drawMascot(c, box.x + box.w * 0.5, box.y + box.h * 0.72, box.h * 0.44,
      { hand, pose: 'arms-at-sides', seed: panel.seed });
  },

  /* ── Night Seven. GONE. ──────────────────────────────────────────────────────────── */
  blank(_c, _env) {
    // A blank spread. Both pages. No rule, no number, no mascot. It is paper and it is blank.
    // Do not add an empty state. Do not fade anything in. The wipe already played and it failed.
  },

  'last-page'(c, env) {
    /*
     * The last page. A dotted outline of a small seated figure, in a chair, at a table.
     * Child-sized. Marit's hand, 1962, on the last page she finished. Dotted, in this manual's
     * own grammar (G3), means: present, but occluded in this view.
     * Above it, the parts bracket, and inside the bracket, nothing.
     */
    const { box, panel } = env;
    const marit = HANDS.marit;
    const cx = box.x + box.w * 0.5, cy = box.y + box.h * 0.62;
    strokePoly(c, [[cx - 120, cy - 30], [cx + 120, cy - 30]], { hand: marit, weight: WEIGHTS.medium, seed: panel.seed });
    strokePoly(c, [[cx - 104, cy - 30], [cx - 104, cy + 78]], { hand: marit, weight: WEIGHTS.medium, seed: panel.seed + 2 });
    strokePoly(c, [[cx + 104, cy - 30], [cx + 104, cy + 78]], { hand: marit, weight: WEIGHTS.medium, seed: panel.seed + 4 });
    this._part(c, 'chair', cx - 46, cy + 26, 96, { hand: marit, seed: panel.seed + 10, fitH: 118, dotted: true, weight: WEIGHTS.medium });
    drawMascot(c, cx - 46, cy + 60, 116, {
      hand: marit, pose: 'seated', seed: panel.seed + 20, dotted: true, weight: WEIGHTS.medium, ignoreHandScale: true,
    });
    const by = box.y + box.h * 0.24;
    strokePoly(c, [[cx - 60, by - 26], [cx - 70, by - 26], [cx - 70, by + 26], [cx - 60, by + 26]],
      { hand: marit, weight: WEIGHTS.medium, seed: panel.seed + 30 });
    strokePoly(c, [[cx + 60, by - 26], [cx + 70, by - 26], [cx + 70, by + 26], [cx + 60, by + 26]],
      { hand: marit, weight: WEIGHTS.medium, seed: panel.seed + 32 });
    // The telephone inset — the parody "contact customer service" — and the payphone in situ,
    // 160 m away, with a dotted path from the front door to it. The one mark in his hand.
    const ansel = HANDS.ansel;
    telephoneGlyph(c, box.x + box.w * 0.86, box.y + box.h * 0.12, 26, { hand: ansel, seed: panel.seed + 40 });
    const path = [];
    for (let i = 0; i <= 18; i++) {
      const t = i / 18;
      path.push(cx + 40 + (box.w * 0.34) * t, by + 120 - (box.h * 0.30) * t + Math.sin(t * 3.1) * 12);
    }
    strokePath(c, path, { hand: ansel, weight: WEIGHTS.thin, color: PALETTE.inkSoft, dash: [5, 6], seed: panel.seed + 42, step: 8 });
  },

  'ending-a'(c, env) {
    // ENDING A only. The only red mark the manual has ever aimed at the player, and the only
    // judgement it has ever passed.
    const { box, panel } = env;
    const ansel = HANDS.ansel;
    drawMascot(c, box.x + box.w * 0.5, box.y + box.h * 0.74, box.h * 0.46,
      { hand: ansel, pose: 'arms-at-sides', seed: panel.seed, mouth: true });
    strokePoly(c, [[box.x + box.w * 0.14, box.y + box.h * 0.18], [box.x + box.w * 0.86, box.y + box.h * 0.86]],
      { hand: ansel, weight: WEIGHTS.heavy * 1.4, color: this._accent(), seed: panel.seed + 10 });
  },

  'end-card'(c, env) {
    // Over black: the finished house, exactly as the player built it, with a tick beside it.
    const { hand, box, panel } = env;
    RENDERERS.cover.call(this, c, env);
    tickMark(c, box.x + box.w * 0.86, box.y + box.h * 0.46, 26, { hand, seed: panel.seed + 60 });
  },

  'grab-warning'(c, env) { this._drawGrabWarning(c, env); },
};

Blueprint.prototype._renderers = RENDERERS;

export default Blueprint;
