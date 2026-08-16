/**
 * BlueprintUI.js — THE FOLD-OUT INSTRUCTION MANUAL.
 *
 * OWNER: UI agent. Registered in main.js as the system 'BlueprintUI'.
 *
 * This is the narrator. Everything the game has to say, it says through this object, and it says
 * it without a single word. Numbers are dots. Quantities are arrangements. Torque is a number of
 * turns of a spiral. The only Latin characters that may ever appear on this page are the cover
 * word and the maker's mark, and they are drawn as strokes, not typeset.
 *
 * WHAT THIS FILE OWNS (Blueprint.js's header states the split, verbatim):
 *   "Blueprint owns geometry + layout + rasterisation of the diagram itself. BlueprintUI.js owns
 *    the paper furniture around it (fold shadow, page-turn animation, the hand-wipe lockout) and
 *    bakes renderPanel() into an OffscreenCanvas per STORY §3.4."
 *
 * So: the sheet, the three-leaf fold-out, the creases and how they catch light, the photocopy
 * degradation, the damp, the blood, the annotation layer, the fastener ring, the progress bar,
 * the fuse gauge, the light it throws on the player's face — and a complete wordless diagram
 * generator of its own for when `Blueprint` is not in the build at all.
 *
 * CONTRACTS HONOURED
 *   ARCHITECTURE §3   system shape; §5 emits ONLY `ui:blueprint-open/close` and `audio:sfx`;
 *                     §6 seeded Rand only; §12 no allocation in update().
 *   ART_DIRECTION §13 page spec, four stroke weights, the grid, the closed arrow vocabulary,
 *                     the comedy pipeline, true wordlessness, how the page sits over the world.
 *   STORY §3          the manual as narrator: two hands, the seven-stage evolution, BJØRN.
 *   GAME_DESIGN §4.4  the 0.9 s hand-wipe lockout, never skippable.
 *                §6.6 the manual IS the fastener inventory display.
 *                §9.6 the page edge is the PROVOKE fuse gauge — the only timing UI in the game.
 *                §16.1 on `nightmare` the manual does not stay open while walking.
 *                §16.2 `manualContrast`, and the colourblind accent.
 *
 * THE TONAL KNIFE-TWIST. The page is flat, bright and clinical over a wet, dark, volumetric
 * world, and while it is open it is a REAL LIGHT SOURCE: a shadowless SpotLight on the camera
 * (ART §13.8) plus `illumination` / `lumBonus`, which Campers reads exactly the way it reads
 * `Flashlight.illumination`. Reading the instructions makes you easier to see. That is the joke
 * and the stealth mechanic in one number.
 *
 * PUBLIC API
 *   new BlueprintUI(ctx); await init(); update(dt, elapsed); resize(w, h); dispose();
 *   open() close() toggle()            isOpen  isAnimating  isWiping
 *   nextPanel() prevPanel() setPanel(i)
 *   currentPanel -> panel object (same shape as Blueprint.currentPanel) | null
 *   currentPanelIndex -> int           panelCount -> int
 *   illumination  lightLevel  lumBonus  handsOccupied  speedMultiplier
 *   annotate(slotId, kind?)  clearAnnotations()  annotationCount
 *
 * NOTHING HERE PRINTS A SENTENCE. If you ever find yourself reaching for `fillText`, you have
 * shipped the worst bug in the project.
 */

import * as THREE from 'three';
import { Rand, hashInt, hashStr } from '../core/Rand.js';
import { Log } from '../core/Log.js';

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 0. CONSTANTS
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/** ART §13.1 / the brief. These match Blueprint.js's PALETTE exactly so composites are seamless. */
const PAL = Object.freeze({
  paper: '#f4f1e8',
  paperShade: '#ebe6d9',
  paperLit: '#fbf8f0',
  ink: '#16181a',
  inkSoft: '#3a3f44',
  red: '#d92b2b',
  foxing: '#c9b58f',
  blood: '#8d2119',
});

/** Colourblind accent substitutions. Both spellings — Settings uses the short ones. */
const ACCENT_CB = Object.freeze({
  deutan: '#0b57d0', deuteranopia: '#0b57d0',
  protan: '#0b57d0', protanopia: '#0b57d0',
  tritan: '#c2185b', tritanopia: '#c2185b',
});

/** ART §13.2 — exactly four stroke widths, in page units. Blueprint.WEIGHTS, matched. */
const W = Object.freeze({ hairline: 1.0, thin: 1.5, medium: 2.0, heavy: 3.0, figure: 3.0 });

/** ART §13.1/§13.3 — A4 at 1:1.414, page height 900 units. Blueprint.PAGE, matched. */
const PAGE = Object.freeze({ W: 636, H: 900, margin: 44, gutter: 30, footer: 34 });

/** ART §13.3 — the base grid unit. */
const U = PAGE.W / 48;

/** STORY §3.2 — the two hands, shipping values, verbatim. */
const HANDS = Object.freeze({
  marit: Object.freeze({
    wobbleAmp: 0.22, cornerOvershoot: 0.00, strokeRepeat: 1.00, ghostAlpha: 0.00,
    wobbleFreq: 0.9, pressureVar: 0.06, closureError: 0.0,
  }),
  ansel: Object.freeze({
    wobbleAmp: 0.95, cornerOvershoot: 1.80, strokeRepeat: 1.70, ghostAlpha: 0.14,
    wobbleFreq: 3.4, pressureVar: 0.28, closureError: 0.9,
  }),
});

/**
 * ART §13.5 + §13.1's degradation dials, per night. This table is the manual's personality
 * expressed as paper rather than as content: it gets damper, dirtier, and one more generation of
 * photocopy every night, and on Night Seven it is the tiredest object in the game.
 */
const NIGHT_PAPER = Object.freeze([
  null,
  { wear: 0.00, edge: 0.000, jitter: 0.000, creaseWear: 0.00, blood: 0, hand: 'marit', ansel: 0.00 },
  { wear: 0.08, edge: 0.006, jitter: 0.000, creaseWear: 0.14, blood: 0, hand: 'marit', ansel: 0.04 },
  { wear: 0.20, edge: 0.012, jitter: 0.010, creaseWear: 0.30, blood: 0, hand: 'marit', ansel: 0.14 },
  { wear: 0.36, edge: 0.018, jitter: 0.021, creaseWear: 0.48, blood: 1, hand: 'marit', ansel: 0.31 },
  { wear: 0.52, edge: 0.024, jitter: 0.028, creaseWear: 0.64, blood: 2, hand: 'ansel', ansel: 0.52 },
  { wear: 0.74, edge: 0.030, jitter: 0.036, creaseWear: 0.82, blood: 2, hand: 'ansel', ansel: 0.72 },
  { wear: 0.92, edge: 0.036, jitter: 0.040, creaseWear: 1.00, blood: 1, hand: 'marit', ansel: 0.00 },
]);

/** GAME_DESIGN §4.4 / Script.PANEL_RULES.wipeLockoutMs. Never skippable. Never varied. */
const WIPE_MS = 900;
/** ART §13.8 — the unfold, the settle, and a close that is deliberately faster than the open. */
const UNFOLD_MS = 180;
const CLOSE_MS = 300;
/** ART §13.8 — the bounce light dies over 0.12 s. */
const LIGHT_OUT_MS = 120;

/**
 * The page's contribution to GAME_DESIGN §9.2's `lum` term.
 *
 * Derivation, so a balance pass can argue with it: the lantern open is `lum += 0.55` (§11.2). The
 * page is a bone sheet held 40 cm from the face, and it is bright only because the lantern is
 * lighting it — it is a second bounce, not a second source. 0.26 puts a lit, reading player at
 * `lum = 0.81`, so `lightF` goes 1.334 → 1.846 and §9.3's T3 target (3.5 s to be seen, lit and
 * walking at 15 m) becomes 2.5 s. Reading the instructions costs you a third of your warning.
 */
const LUM_BONUS = 0.26;

/** While reading, both hands are on the paper. §10.1's walk is 1.4 m/s; this makes it 0.77. */
const READ_SPEED_MUL = 0.55;

/** ART §13.8 — the page bounce: a shadowless SpotLight, 2.2 m, `#f2efe6`, aimed forward-down 22°. */
const PAGE_LIGHT = Object.freeze({
  intensity: 3.0, angle: 1.2, penumbra: 1.0, distance: 2.2, decay: 2.0,
  colour: 0xf2efe6, forward: 0.40, pitchDeg: 22,
});

/** ART §13.5's first-page panel counts, used by the fallback generator. */
const FALLBACK_PANELS = Object.freeze([0, 3, 4, 4, 4, 3, 4, 2]);
/** Pages per night including the cover (ART §13.5's Pages column + 1). */
const FALLBACK_PAGES = Object.freeze([0, 2, 3, 3, 4, 4, 5, 3]);

const DEG = Math.PI / 180;

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 1. SMALL MATH — module scope, no allocation, deterministic
 * ════════════════════════════════════════════════════════════════════════════════════════ */

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
/** Smooth, symmetric, and cheap. Used for every ramp in this file. */
const smooth = (t) => { const x = clamp01(t); return x * x * (3 - 2 * x); };
/** A fast out-quint, for the unfold. Paper stops moving suddenly; it does not ease out for long. */
const outQuint = (t) => { const x = 1 - clamp01(t); return 1 - x * x * x * x * x; };

/** Deterministic 1-D value noise in [-1,1]. The wobble along a hand-drawn stroke. */
function noise1(x, seed) {
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f);
  const a = hashInt((i * 0x9e3779b1) ^ seed) / 4294967296;
  const b = hashInt(((i + 1) * 0x9e3779b1) ^ seed) / 4294967296;
  return (a + (b - a) * s) * 2 - 1;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 2. THE INK ENGINE
 *
 * Every mark this file makes goes through `ink()`. It is a polyline rasteriser with a hand in it:
 * a perpendicular value-noise wobble, corner overshoot, stroke doubling, and eraser ghosts, driven
 * by STORY §3.2's four-parameter `authorship` struct. Butt caps and miter joins, always — ART
 * §13.2 is explicit that rounded caps are what make a thing look like 2019 instead of 1971.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/** Scratch, module scope, reused by every stroke. Never grows past the largest path drawn. */
const _pts = [];

/**
 * @param {CanvasRenderingContext2D} c
 * @param {number[]} pts flat [x0,y0,x1,y1,...] in page units
 * @param {object} o { weight, color, alpha, dash, closed, hand, seed, step, ghost }
 */
function ink(c, pts, o) {
  if (!pts || pts.length < 4) return;
  const hand = o.hand ?? HANDS.marit;
  const weight = o.weight ?? W.medium;
  const seed = (o.seed ?? 1) | 0;
  const step = o.step ?? 7;
  const closed = !!o.closed;
  const passes = hand.strokeRepeat > 1.0 ? 2 : 1;

  c.save();
  c.lineCap = 'butt';
  c.lineJoin = 'miter';
  c.miterLimit = 4;
  c.strokeStyle = o.color ?? PAL.ink;
  if (o.dash) c.setLineDash(o.dash); else c.setLineDash([]);

  // The eraser ghost is a discarded variant left under the final line. It goes down first.
  if (hand.ghostAlpha > 0.002 && o.ghost !== false) {
    _emit(c, pts, hand, seed + 977, step, closed, weight - 0.6,
      (o.alpha ?? 1) * hand.ghostAlpha, 2.2);
  }

  for (let p = 0; p < passes; p++) {
    const a = (o.alpha ?? 1) * (p === 0 ? 1 : 0.72);
    // Only `strokeRepeat − 1` of the second passes actually land; the rest of the doubling
    // budget is spent as a partial pass so the tell is irregular, not a rubber stamp.
    if (p === 1 && (hashInt(seed + 4231) / 4294967296) > (hand.strokeRepeat - 1)) break;
    _emit(c, pts, hand, seed + p * 131, step, closed, weight, a, p === 0 ? 0 : 1.0);
  }
  c.restore();
}

/** One pass of one stroke. `off` is the doubling offset in page units. */
function _emit(c, pts, hand, seed, step, closed, weight, alpha, off) {
  const n = pts.length >> 1;
  _pts.length = 0;

  // Resample and wobble.
  let arc = 0;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], y = pts[i * 2 + 1];
    if (i > 0) {
      const px = pts[i * 2 - 2], py = pts[i * 2 - 1];
      const dx = x - px, dy = y - py;
      const len = Math.hypot(dx, dy);
      const segs = Math.max(1, Math.round(len / step));
      const nx = -dy / (len || 1), ny = dx / (len || 1);
      for (let s = 1; s <= segs; s++) {
        const t = s / segs;
        const a = arc + len * t;
        const wob = noise1(a * hand.wobbleFreq * 0.01, seed) * hand.wobbleAmp;
        const dOff = off ? (noise1(a * 0.004 + 31.7, seed + 5) * off) : 0;
        _pts.push(px + dx * t + nx * (wob + dOff), py + dy * t + ny * (wob + dOff));
      }
      // Corner overshoot: the incoming segment runs past the vertex before the turn starts. The
      // single most legible "drawn by someone trying hard" tell in STORY §3.2.
      if (hand.cornerOvershoot > 0.01 && i < n - 1) {
        const ox = dx / (len || 1) * hand.cornerOvershoot;
        const oy = dy / (len || 1) * hand.cornerOvershoot;
        _pts.push(x + ox, y + oy);
        _pts.push(x, y);
      }
      arc += len;
    } else {
      const wob = noise1(0, seed) * hand.wobbleAmp;
      _pts.push(x + wob, y + wob);
    }
  }
  if (closed && hand.closureError > 0.01) {
    // He does not quite close his corners. 0.9 px of daylight, every time.
    _pts[_pts.length - 2] += hand.closureError;
  }

  // Pressure variation: the weight breathes along the stroke. Drawn as two overlaid passes at
  // slightly different widths rather than as a per-segment stroke, which would cost 40× the calls.
  c.globalAlpha = alpha;
  c.lineWidth = Math.max(0.35, weight * (1 - hand.pressureVar * 0.35));
  _strokePts(c, closed);
  if (hand.pressureVar > 0.1) {
    c.globalAlpha = alpha * 0.55;
    c.lineWidth = Math.max(0.35, weight * (1 + hand.pressureVar * 0.5));
    _strokePts(c, closed);
  }
  c.globalAlpha = 1;
}

function _strokePts(c, closed) {
  c.beginPath();
  c.moveTo(_pts[0], _pts[1]);
  for (let i = 2; i < _pts.length; i += 2) c.lineTo(_pts[i], _pts[i + 1]);
  if (closed) c.closePath();
  c.stroke();
}

/** Points of a circle as a flat array, closed. */
function circlePts(cx, cy, r, segs = 26, out = []) {
  out.length = 0;
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return out;
}

/** Points of an arc as a flat array. */
function arcPts(cx, cy, r, a0, a1, segs = 20, out = []) {
  out.length = 0;
  for (let i = 0; i <= segs; i++) {
    const a = a0 + (a1 - a0) * (i / segs);
    out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return out;
}

function fillDot(c, x, y, r, colour) {
  c.save();
  c.fillStyle = colour ?? PAL.ink;
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

/* ── ART §13.4's closed arrow vocabulary. Do not invent a tenth. ───────────────────────── */

/** A solid triangular head, `1.2U` long, 28° included angle. */
function head(c, x, y, dx, dy, size, o) {
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l, uy = dy / l;
  const px = -uy, py = ux;
  const w = size * Math.tan(14 * DEG) * 2;
  c.save();
  c.fillStyle = o?.color ?? PAL.ink;
  c.globalAlpha = o?.alpha ?? 1;
  c.beginPath();
  c.moveTo(x, y);
  c.lineTo(x - ux * size + px * w, y - uy * size + py * w);
  c.lineTo(x - ux * size - px * w, y - uy * size - py * w);
  c.closePath();
  c.fill();
  c.restore();
}

/** Straight insert: push part A into slot B. */
function arrowStraight(c, x0, y0, x1, y1, o = {}) {
  const dx = x1 - x0, dy = y1 - y0;
  const l = Math.hypot(dx, dy) || 1;
  const size = o.size ?? U * 1.2;
  ink(c, [x0, y0, x1 - dx / l * size * 0.72, y1 - dy / l * size * 0.72],
    { weight: W.heavy, ...o });
  head(c, x1, y1, dx, dy, size, o);
}

/** Curved rotate: 90° or 180°, one head. */
function arrowCurved(c, cx, cy, r, a0, a1, o = {}) {
  const p = arcPts(cx, cy, r, a0, a1, 22);
  ink(c, p, { weight: W.heavy, ...o });
  const dir = a1 > a0 ? 1 : -1;
  head(c, cx + Math.cos(a1) * r, cy + Math.sin(a1) * r,
    -Math.sin(a1) * dir, Math.cos(a1) * dir, o.size ?? U, o);
}

/**
 * Spiral torque. ART §13.4: the TURN COUNT IS THE VALUE — 1.75 turns of the spiral is 1.75 turns
 * of the wrench. This is the mechanism that replaces printing a torque number, and printing the
 * number beside it would be the manual not trusting its own language.
 */
function arrowSpiral(c, cx, cy, r, turns, o = {}) {
  const segs = Math.max(12, Math.round(turns * 26));
  const p = [];
  const a0 = o.startAngle ?? -Math.PI / 2;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const a = a0 + t * turns * Math.PI * 2;
    const rr = r * (0.34 + 0.66 * t);
    p.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ink(c, p, { weight: W.heavy, ...o, step: 5 });
  const aEnd = a0 + turns * Math.PI * 2;
  head(c, p[p.length - 2], p[p.length - 1], -Math.sin(aEnd), Math.cos(aEnd), o.size ?? U * 0.9, o);
}

/** Double-headed span. Its LENGTH carries the number (§13.7). Never a printed dimension. */
function arrowSpan(c, x0, y0, x1, y1, o = {}) {
  const dx = x1 - x0, dy = y1 - y0;
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l, uy = dy / l;
  const size = o.size ?? U * 0.8;
  ink(c, [x0 + ux * size * 0.6, y0 + uy * size * 0.6, x1 - ux * size * 0.6, y1 - uy * size * 0.6],
    { weight: W.thin, ...o });
  head(c, x1, y1, ux, uy, size, o);
  head(c, x0, y0, -ux, -uy, size, o);
  if (o.witness) {
    const px = -uy * o.witness, py = ux * o.witness;
    ink(c, [x0 - px * 0.3, y0 - py * 0.3, x0 + px, y0 + py],
      { weight: W.hairline, color: PAL.inkSoft, ...o });
    ink(c, [x1 - px * 0.3, y1 - py * 0.3, x1 + px, y1 + py],
      { weight: W.hairline, color: PAL.inkSoft, ...o });
  }
}

/** Ghost trail: 0.75 px dashed along the motion path. Where the part came from. It always falls. */
function ghostTrail(c, pts, o = {}) {
  ink(c, pts, { weight: W.hairline, color: PAL.inkSoft, dash: [4, 3], step: 9, ...o });
}

/** ✗ — 4.0 px, red, two strokes at 90°, drawn OVER a panel. Do not do this. */
function crossX(c, cx, cy, s, o = {}) {
  const col = o.color ?? PAL.red;
  ink(c, [cx - s, cy - s, cx + s, cy + s], { weight: W.heavy, color: col, ...o });
  ink(c, [cx + s, cy - s, cx - s, cy + s], { weight: W.heavy, color: col, ...o, seed: (o.seed ?? 3) + 1 });
  // §16.2: every red mark is redundantly encoded. A corner tick, so hue is never the only channel.
  ink(c, [cx - s * 1.25, cy - s * 1.25, cx - s * 1.25, cy - s * 0.85], { weight: W.thin, color: col, ...o, seed: (o.seed ?? 3) + 2 });
  ink(c, [cx - s * 1.25, cy - s * 1.25, cx - s * 0.85, cy - s * 1.25], { weight: W.thin, color: col, ...o, seed: (o.seed ?? 3) + 3 });
}

/** ✓ — 4.0 px, ink, beside a panel. Do this. */
function tickMark(c, x, y, s, o = {}) {
  ink(c, [x - s * 0.52, y, x - s * 0.12, y + s * 0.44, x + s * 0.62, y - s * 0.58],
    { weight: W.heavy, color: o.color ?? PAL.ink, ...o });
}

/** Red slash-circle: the forbidden variant, which is usually the one that looks correct. */
function slashCircle(c, cx, cy, r, o = {}) {
  const col = o.color ?? PAL.red;
  ink(c, circlePts(cx, cy, r, 30), { weight: W.heavy, color: col, closed: true, ...o });
  const d = r * 0.707;
  ink(c, [cx - d, cy + d, cx + d, cy - d], { weight: W.heavy, color: col, ...o, seed: (o.seed ?? 4) + 1 });
  // Redundant encoding: a dashed outer ring, so this reads at any colour vision.
  ink(c, circlePts(cx, cy, r + U * 0.34, 30), { weight: W.hairline, color: col, dash: [3, 4], closed: true, ...o, seed: (o.seed ?? 4) + 2 });
}

/** Exclamation lozenge: rounded-rect outline, red fill, bone `!`. Max one per page. */
function lozenge(c, cx, cy, s, o = {}) {
  const col = o.color ?? PAL.red;
  const w = s * 0.72, h = s;
  ink(c, [cx - w, cy - h * 0.72, cx + w, cy - h * 0.72, cx + w, cy + h * 0.72,
    cx - w, cy + h * 0.72, cx - w, cy - h * 0.72],
  { weight: W.medium, color: col, closed: true, ...o });
  c.save();
  c.fillStyle = col;
  c.fillRect(cx - w * 0.86, cy - h * 0.6, w * 1.72, h * 1.2);
  c.fillStyle = PAL.paper;
  // The `!` is a MARK, not a letter: a tapered bar and a dot.
  c.beginPath();
  c.moveTo(cx - s * 0.11, cy - h * 0.42);
  c.lineTo(cx + s * 0.11, cy - h * 0.42);
  c.lineTo(cx + s * 0.06, cy + h * 0.10);
  c.lineTo(cx - s * 0.06, cy + h * 0.10);
  c.closePath();
  c.fill();
  c.beginPath();
  c.arc(cx, cy + h * 0.36, s * 0.10, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

/** Magnifier callout: 1.5 px circle + 2.5 px handle, contents at 2.2×. Also the nav system. */
function magnifier(c, cx, cy, r, o = {}, contents) {
  ink(c, circlePts(cx, cy, r, 30), { weight: W.thin, closed: true, ...o });
  ink(c, [cx + r * 0.71, cy + r * 0.71, cx + r * 1.55, cy + r * 1.55],
    { weight: W.medium, ...o, seed: (o.seed ?? 6) + 1 });
  if (typeof contents === 'function') {
    c.save();
    c.beginPath();
    c.arc(cx, cy, r - 1.5, 0, Math.PI * 2);
    c.clip();
    contents(c, cx, cy, r);
    c.restore();
  }
}

/** The mirror glyph over a dashed axis — grammar G2 is in effect for this figure. */
function mirrorGlyph(c, cx, cy, s, o = {}) {
  ink(c, [cx, cy - s * 1.15, cx, cy + s * 1.15], { weight: W.hairline, dash: [5, 4], ...o });
  ink(c, [cx - s * 0.85, cy - s * 0.5, cx - s * 0.25, cy - s * 0.5, cx - s * 0.25, cy + s * 0.5,
    cx - s * 0.85, cy + s * 0.5, cx - s * 0.85, cy - s * 0.5],
  { weight: W.medium, closed: true, ...o, seed: (o.seed ?? 7) + 1 });
  ink(c, [cx + s * 0.85, cy - s * 0.5, cx + s * 0.25, cy - s * 0.5, cx + s * 0.25, cy + s * 0.5,
    cx + s * 0.85, cy + s * 0.5, cx + s * 0.85, cy - s * 0.5],
  { weight: W.medium, closed: true, dash: [4, 3], ...o, seed: (o.seed ?? 7) + 2 });
}

/** The telephone. Night 6 teaches it; Night 7 is the only page it is ever kind on. */
function telephone(c, cx, cy, s, o = {}) {
  ink(c, [cx - s, cy + s * 0.18, cx - s * 0.62, cy - s * 0.42], { weight: W.medium, ...o });
  ink(c, [cx + s, cy + s * 0.18, cx + s * 0.62, cy - s * 0.42],
    { weight: W.medium, ...o, seed: (o.seed ?? 8) + 1 });
  ink(c, arcPts(cx, cy - s * 0.34, s * 0.82, Math.PI, Math.PI * 2, 18),
    { weight: W.medium, ...o, seed: (o.seed ?? 8) + 2 });
  ink(c, [cx - s * 1.08, cy + s * 0.1, cx - s * 0.5, cy + s * 0.66],
    { weight: W.thin, ...o, seed: (o.seed ?? 8) + 3 });
}

/** Motion ticks — three short strokes. The manual is tapping its foot. It is waiting for you. */
function motionTicks(c, x, y, s, o = {}) {
  for (let i = 0; i < 3; i++) {
    ink(c, [x + i * s * 0.42, y - i * s * 0.16, x + s * 0.34 + i * s * 0.42, y - s * 0.34 - i * s * 0.16],
      { weight: W.thin, ...o, seed: (o.seed ?? 9) + i });
  }
}

/** One drawn sparkle. Night One only, and never again. */
function sparkle(c, x, y, s, o = {}) {
  ink(c, [x, y - s, x, y + s], { weight: W.thin, ...o });
  ink(c, [x - s, y, x + s, y], { weight: W.thin, ...o, seed: (o.seed ?? 10) + 1 });
  ink(c, [x - s * 0.58, y - s * 0.58, x + s * 0.58, y + s * 0.58], { weight: W.hairline, ...o, seed: (o.seed ?? 10) + 2 });
  ink(c, [x + s * 0.58, y - s * 0.58, x - s * 0.58, y + s * 0.58], { weight: W.hairline, ...o, seed: (o.seed ?? 10) + 3 });
}

/**
 * ART §13.7 — quantities are ARRANGEMENTS, never digits: 1–3 in a row, 4 as a square, 5 as a
 * quincunx, 6 as a 2×3. Counts above three are remembered as shapes. This is subitizing and it is
 * more reliable than a numeral at 200 ms, which is all the time a man in the rain is going to give
 * this page.
 */
const COUNT_LAYOUT = Object.freeze([
  [], [[0, 0]],
  [[-0.5, 0], [0.5, 0]],
  [[-1, 0], [0, 0], [1, 0]],
  [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]],
  [[-0.6, -0.6], [0.6, -0.6], [0, 0], [-0.6, 0.6], [0.6, 0.6]],
  [[-0.5, -0.7], [0.5, -0.7], [-0.5, 0], [0.5, 0], [-0.5, 0.7], [0.5, 0.7]],
]);

/**
 * Draw `n` of something as an arrangement. Above six the manual stops counting and draws a 2×N
 * block, which is the honest thing a 1971 maintenance department would have done.
 * @param {number} filled how many are filled — the fastener ring's held-vs-required (§6.6)
 */
function countGlyphs(c, cx, cy, n, s, o = {}, filled = -1) {
  const count = Math.max(0, Math.round(n));
  const col = o.color ?? PAL.ink;
  if (count === 0) return;
  if (count <= 6) {
    const L = COUNT_LAYOUT[count];
    for (let i = 0; i < L.length; i++) {
      const x = cx + L[i][0] * s, y = cy + L[i][1] * s;
      if (filled < 0 || i < filled) fillDot(c, x, y, s * 0.30, col);
      else ink(c, circlePts(x, y, s * 0.30, 14), { weight: W.thin, color: col, closed: true, ...o, seed: (o.seed ?? 11) + i });
    }
    return;
  }
  const cols = Math.ceil(count / 2);
  for (let i = 0; i < count; i++) {
    const x = cx + ((i % cols) - (cols - 1) / 2) * s * 0.9;
    const y = cy + (i < cols ? -0.5 : 0.5) * s;
    if (filled < 0 || i < filled) fillDot(c, x, y, s * 0.26, col);
    else ink(c, circlePts(x, y, s * 0.26, 12), { weight: W.thin, color: col, closed: true, ...o, seed: (o.seed ?? 11) + i });
  }
}

/** The step badge: a 2U filled ink circle with a bone COUNT ARRANGEMENT inside it. Not a numeral. */
function stepBadge(c, cx, cy, n, o = {}) {
  const r = o.r ?? U;
  c.save();
  if (o.dashed) {
    ink(c, circlePts(cx, cy, r, 26), { weight: W.medium, closed: true, dash: [5, 4], ...o });
  } else {
    c.fillStyle = o.color ?? PAL.ink;
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();
  countGlyphs(c, cx, cy, n, r * 0.52, { ...o, color: o.dashed ? PAL.ink : PAL.paper, seed: (o.seed ?? 12) + 40 });
}

/**
 * The parts bracket: a wide square bracket enclosing the stage's manifest. ART §13.7 replaces the
 * page number with a filled-segment progress bar; this replaces the parts LIST with a shape.
 */
function partsBracket(c, x, y, w, h, o = {}) {
  const t = U * 0.5;
  ink(c, [x + t, y, x, y, x, y + h, x + t, y + h], { weight: W.medium, ...o });
  ink(c, [x + w - t, y, x + w, y, x + w, y + h, x + w - t, y + h],
    { weight: W.medium, ...o, seed: (o.seed ?? 13) + 1 });
}

/** The hardware bag. A wordless sack with a tie, and a count arrangement beside it. */
function bagCount(c, x, y, s, n, o = {}) {
  ink(c, [x - s * 0.42, y - s * 0.52, x - s * 0.30, y - s * 0.80, x + s * 0.30, y - s * 0.80,
    x + s * 0.42, y - s * 0.52, x + s * 0.50, y + s * 0.55, x - s * 0.50, y + s * 0.55,
    x - s * 0.42, y - s * 0.52],
  { weight: W.medium, closed: true, ...o });
  ink(c, [x - s * 0.18, y - s * 0.80, x - s * 0.18, y - s * 1.00, x + s * 0.18, y - s * 1.00,
    x + s * 0.18, y - s * 0.80],
  { weight: W.thin, ...o, seed: (o.seed ?? 14) + 1 });
  countGlyphs(c, x + s * 1.35, y, n, s * 0.42, { ...o, seed: (o.seed ?? 14) + 2 });
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 3. BJØRN — STORY §3.3
 *
 * Head a perfect 3U circle. TWO FILLED DOTS for a face at 1.42× anatomical spacing and nothing
 * else — STORY §3.3 corrects ART's hockey mask by name and calls the correction blocking: if the
 * drawing already looks like a hockey mask, the mask is a reference to a film instead of a copy of
 * a drawing, and Night Six reveals nothing.
 *
 * He is never in danger. He never reacts to anything frightening. A camper's silhouette may appear
 * in a panel and he carries on. The horror is in the diagram and the diagram does not care.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/** Closed pose set: STORY §3.3 = ART's nine plus `arms-at-sides`. Nothing else exists. */
const POSES = Object.freeze({
  'standing-neutral': { la: [[-0.30, 0.30], [-0.34, 0.02]], ra: [[0.30, 0.30], [0.34, 0.02]], legs: 'stand' },
  pointing: { la: [[-0.30, 0.32], [-0.34, 0.06]], ra: [[0.42, 0.46], [0.78, 0.52]], legs: 'stand' },
  'shrugging-at-missing-hardware': { la: [[-0.46, 0.52], [-0.66, 0.34]], ra: [[0.46, 0.52], [0.66, 0.34]], legs: 'stand' },
  hammering: { la: [[-0.30, 0.34], [-0.20, 0.14]], ra: [[0.34, 0.56], [0.30, 0.86]], legs: 'stride', hammer: true },
  'head-tilt-confused': { la: [[-0.30, 0.30], [-0.34, 0.02]], ra: [[0.30, 0.30], [0.34, 0.02]], legs: 'stand', tilt: 9 },
  'seated-on-floor': { la: [[-0.34, 0.26], [-0.44, 0.06]], ra: [[0.34, 0.26], [0.44, 0.06]], legs: 'seated' },
  'holding-part-two-hands': { la: [[-0.34, 0.44], [-0.20, 0.52]], ra: [[0.34, 0.44], [0.20, 0.52]], legs: 'stand', part: true },
  'wagging-finger-no': { la: [[-0.30, 0.30], [-0.34, 0.02]], ra: [[0.32, 0.52], [0.30, 0.86]], legs: 'stand', wag: true },
  'thumbs-up': { la: [[-0.30, 0.30], [-0.34, 0.02]], ra: [[0.34, 0.48], [0.40, 0.78]], legs: 'stand', thumb: true },
  'arms-at-sides': { la: [[-0.26, 0.28], [-0.28, 0.00]], ra: [[0.26, 0.28], [0.28, 0.00]], legs: 'stand' },
  waving: { la: [[-0.44, 0.56], [-0.62, 0.88]], ra: [[0.44, 0.56], [0.62, 0.88]], legs: 'stand' },
});

/**
 * @param {number} h figure height in page units (1.7 m of man)
 * @param {object} o { hand, pose, seed, weight, mouth, dotted, alpha, color }
 */
function drawMascot(c, x, y, h, o = {}) {
  const pose = POSES[o.pose] ?? POSES['standing-neutral'];
  const hand = o.hand ?? HANDS.marit;
  const seed = (o.seed ?? 100) | 0;
  const weight = o.weight ?? W.figure;
  const col = o.color ?? PAL.ink;
  const dash = o.dotted ? [4, 4] : null;
  const so = { hand, weight, seed, color: col, dash, alpha: o.alpha ?? 1 };

  // 4.5 heads tall. The head is a 3U circle at the top; everything is a fraction of `h`.
  const headR = h / 4.5 / 2;
  const P = (fx, fy) => [x + fx * h * 0.30, y - fy * h];
  const seg = (a, b, extra) => {
    const A = P(a[0], a[1]), B = P(b[0], b[1]);
    ink(c, [A[0], A[1], B[0], B[1]], { ...so, weight: weight * 0.83, ...extra });
  };

  const hcx = x + (pose.tilt ? Math.sin(pose.tilt * DEG) * headR * 0.6 : 0);
  const hcy = y - h + headR;
  ink(c, circlePts(hcx, hcy, headR, 24), { ...so, closed: true, seed: seed + 1 });

  // The face. Two dots. Ever.
  const eyeDx = headR * 0.355;   // 1.42× anatomical
  if (!o.dotted) {
    fillDot(c, hcx - eyeDx, hcy - headR * 0.06, Math.max(0.9, headR * 0.13), col);
    fillDot(c, hcx + eyeDx, hcy - headR * 0.06, Math.max(0.9, headR * 0.13), col);
  }
  // One flat line for a mouth. Panel 2.6, and Ending A. That is the entire list.
  if (o.mouth) {
    ink(c, [hcx - headR * 0.34, hcy + headR * 0.46, hcx + headR * 0.34, hcy + headR * 0.46],
      { ...so, weight: W.thin, seed: seed + 2 });
  }

  const shoulderY = 0.735, hipY = 0.40;
  const sw = 0.32, hw = 0.24;
  ink(c, [
    ...P(-sw, shoulderY), ...P(sw, shoulderY), ...P(hw, hipY), ...P(-hw, hipY), ...P(-sw, shoulderY),
  ], { ...so, closed: true, seed: seed + 3 });
  seg([0, 1 - headR / h * 2], [0, shoulderY + 0.02], { seed: seed + 4 });

  const shL = [-sw * 0.92, shoulderY - 0.02], shR = [sw * 0.92, shoulderY - 0.02];
  seg(shL, pose.la[0], { seed: seed + 5 });
  seg(pose.la[0], pose.la[1], { seed: seed + 6 });
  seg(shR, pose.ra[0], { seed: seed + 7 });
  seg(pose.ra[0], pose.ra[1], { seed: seed + 8 });

  if (pose.legs === 'seated') {
    seg([-0.10, hipY], [-0.10, 0.20], { seed: seed + 9 });
    seg([-0.10, 0.20], [-0.44, 0.20], { seed: seed + 10 });
    seg([0.10, hipY], [0.10, 0.20], { seed: seed + 11 });
    seg([0.10, 0.20], [-0.44, 0.20], { seed: seed + 12 });
    seg([-0.44, 0.20], [-0.44, 0.02], { seed: seed + 13 });
  } else if (pose.legs === 'stride') {
    seg([-0.10, hipY], [-0.22, 0.02], { seed: seed + 9 });
    seg([0.10, hipY], [0.20, 0.02], { seed: seed + 10 });
    seg([-0.22, 0.02], [-0.34, 0.00], { seed: seed + 11 });
    seg([0.20, 0.02], [0.32, 0.00], { seed: seed + 12 });
  } else {
    seg([-0.10, hipY], [-0.11, 0.02], { seed: seed + 9 });
    seg([0.10, hipY], [0.11, 0.02], { seed: seed + 10 });
    seg([-0.11, 0.02], [-0.22, 0.00], { seed: seed + 11 });
    seg([0.11, 0.02], [0.22, 0.00], { seed: seed + 12 });
  }

  // The hammer. Its grip is the only part of him that is ever red.
  if (pose.hammer) {
    const g = P(pose.ra[1][0], pose.ra[1][1]);
    const hd = P(pose.ra[1][0] + 0.10, pose.ra[1][1] + 0.20);
    ink(c, [g[0], g[1], hd[0], hd[1]], { ...so, color: o.accent ?? PAL.red, weight: weight * 0.8, seed: seed + 14 });
    ink(c, [hd[0] - h * 0.05, hd[1] - h * 0.012, hd[0] + h * 0.05, hd[1] - h * 0.012,
      hd[0] + h * 0.05, hd[1] + h * 0.018, hd[0] - h * 0.05, hd[1] + h * 0.018,
      hd[0] - h * 0.05, hd[1] - h * 0.012],
    { ...so, closed: true, seed: seed + 15 });
  }
  if (pose.thumb) {
    const f = P(pose.ra[1][0], pose.ra[1][1]);
    ink(c, [f[0], f[1], f[0] + h * 0.018, f[1] - h * 0.055], { ...so, weight: W.thin, seed: seed + 16 });
  }
  if (pose.wag) {
    const f = P(pose.ra[1][0], pose.ra[1][1]);
    ink(c, [f[0], f[1], f[0] + h * 0.012, f[1] - h * 0.06], { ...so, weight: W.thin, seed: seed + 17 });
    motionTicks(c, f[0] + h * 0.05, f[1] - h * 0.04, h * 0.05, { ...so, seed: seed + 18 });
  }
  if (pose.part) {
    const a = P(pose.la[1][0], pose.la[1][1]), b = P(pose.ra[1][0], pose.ra[1][1]);
    ink(c, [a[0], a[1] - h * 0.04, b[0], b[1] - h * 0.04, b[0], b[1] + h * 0.02, a[0], a[1] + h * 0.02, a[0], a[1] - h * 0.04],
      { ...so, closed: true, seed: seed + 19 });
  }
  if (o.pose === 'shrugging-at-missing-hardware') {
    // The arms are out, the head is blank, and nothing else on the page acknowledges it.
    ink(c, [hcx - headR * 1.5, hcy - headR * 1.25, hcx - headR * 1.15, hcy - headR * 1.6],
      { ...so, weight: W.thin, seed: seed + 20 });
    ink(c, [hcx + headR * 1.5, hcy - headR * 1.25, hcx + headR * 1.15, hcy - headR * 1.6],
      { ...so, weight: W.thin, seed: seed + 21 });
  }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 4. DIMETRIC PARTS — ART §13.3's true 7°/42° projection, matched to Blueprint.js
 *
 * Everything is drawn as if measured, because he measured it. No perspective, no foreshortening
 * variance, verticals stay vertical.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

const AX = [Math.cos(7 * DEG), -Math.sin(7 * DEG)];
const AY = [0, -1];
const AZ = [-Math.cos(42 * DEG), -Math.sin(42 * DEG)];
const px3 = (x, y, z, s) => (x * AX[0] + y * AY[0] + z * AZ[0]) * s;
const py3 = (x, y, z, s) => (x * AX[1] + y * AY[1] + z * AZ[1]) * s;

/**
 * A rectangular member in dimetric, with hidden-line removal done the honest way for a box: draw
 * the three visible faces and leave the three hidden edges out, except one, which is `hairline`.
 * The ANCHOR ASYMMETRY (§13.6) is not optional — every part carries exactly one deliberate,
 * functionless asymmetry, and it is the thing the player actually remembers.
 */
function dimetricBox(c, cx, cy, dx, dy, dz, s, o = {}) {
  const V = (x, y, z) => [cx + px3(x, y, z, s), cy + py3(x, y, z, s)];
  const hx = dx / 2, hy = dy / 2, hz = dz / 2;
  const a = V(-hx, -hy, hz), b = V(hx, -hy, hz), cc = V(hx, hy, hz), d = V(-hx, hy, hz);
  const e = V(-hx, -hy, -hz), f = V(hx, -hy, -hz), g = V(hx, hy, -hz), h = V(-hx, hy, -hz);
  const wt = o.weight ?? W.heavy;
  const so = { hand: o.hand, seed: o.seed ?? 200, color: o.color ?? PAL.ink, alpha: o.alpha, dash: o.dash };
  ink(c, [a[0], a[1], b[0], b[1], cc[0], cc[1], d[0], d[1], a[0], a[1]], { ...so, weight: wt, closed: true });
  ink(c, [b[0], b[1], f[0], f[1], g[0], g[1], cc[0], cc[1]], { ...so, weight: wt, seed: so.seed + 1 });
  ink(c, [d[0], d[1], h[0], h[1], g[0], g[1]], { ...so, weight: wt, seed: so.seed + 2 });
  ink(c, [a[0], a[1], e[0], e[1], h[0], h[1]], { ...so, weight: W.hairline, dash: [4, 4], seed: so.seed + 3 });
  ink(c, [e[0], e[1], f[0], f[1]], { ...so, weight: W.hairline, dash: [4, 4], seed: so.seed + 4 });

  // The anchor asymmetry: one bolt hole, offset 1U, on one end only.
  if (o.anchor !== false) {
    const t = o.anchorAt ?? 0.32;
    const p = V(-hx + dx * t, -hy, hz * 0.999);
    ink(c, circlePts(p[0], p[1], Math.max(1.6, s * dz * 0.10), 14),
      { ...so, weight: W.thin, closed: true, seed: so.seed + 5 });
  }
  if (o.notch) {
    // One notch, on the left only. Two mirror-image brackets are otherwise the same object and
    // the memory mechanic collapses (§13.6).
    const n1 = V(-hx, -hy + dy * 0.22, hz), n2 = V(-hx + dx * 0.16, -hy + dy * 0.22, hz);
    const n3 = V(-hx + dx * 0.16, -hy + dy * 0.62, hz), n4 = V(-hx, -hy + dy * 0.62, hz);
    ink(c, [n1[0], n1[1], n2[0], n2[1], n3[0], n3[1], n4[0], n4[1]],
      { ...so, weight: W.medium, seed: so.seed + 6 });
  }
  return { a, b, c: cc, d, e, f, g, h };
}

/** A stone pier — a truncated pyramid. Night One's whole vocabulary. */
function dimetricPier(c, cx, cy, s, o = {}) {
  const V = (x, y, z) => [cx + px3(x, y, z, s), cy + py3(x, y, z, s)];
  const tt = 0.34, bb = 0.46, hh = 0.30;
  const t = [V(-tt, hh, tt), V(tt, hh, tt), V(tt, hh, -tt), V(-tt, hh, -tt)];
  const b = [V(-bb, -hh, bb), V(bb, -hh, bb), V(bb, -hh, -bb), V(-bb, -hh, -bb)];
  const so = { hand: o.hand, seed: o.seed ?? 300, color: o.color ?? PAL.ink, weight: o.weight ?? W.heavy, dash: o.dash };
  ink(c, [t[0][0], t[0][1], t[1][0], t[1][1], t[2][0], t[2][1], t[3][0], t[3][1], t[0][0], t[0][1]],
    { ...so, closed: true });
  ink(c, [t[0][0], t[0][1], b[0][0], b[0][1]], { ...so, seed: so.seed + 1 });
  ink(c, [t[1][0], t[1][1], b[1][0], b[1][1]], { ...so, seed: so.seed + 2 });
  ink(c, [t[2][0], t[2][1], b[2][0], b[2][1]], { ...so, seed: so.seed + 3 });
  ink(c, [b[0][0], b[0][1], b[1][0], b[1][1], b[2][0], b[2][1]], { ...so, seed: so.seed + 4 });
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 5. THE PAPER — ART §13.1
 *
 * Bone stock, three-octave fibre at ±1.8% luminance, two vertical creases at 33.3% and 66.6%, a
 * photocopy generation per night, damp bloom, and — from Night Four — his hands on the page edge.
 * None of this is content. All of it is the manual's biography.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/** Bake a 128² fibre tile once. Reused as a pattern for every page, at 5% alpha. */
function bakeFibreTile(rand) {
  const n = 128;
  const cv = makeCanvas(n, n);
  const c = cv.getContext('2d', { willReadFrequently: false });
  if (!c) return cv;
  const img = c.createImageData(n, n);
  const d = img.data;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      // Three octaves of hash noise, plus a 0.4% vertical grain — paper has a machine direction.
      let v = 0;
      v += (hashInt(x * 374761393 + y * 668265263) / 4294967296 - 0.5) * 0.55;
      v += (hashInt((x >> 1) * 2246822519 + (y >> 1) * 3266489917) / 4294967296 - 0.5) * 0.30;
      v += (hashInt((x >> 2) * 1274126177 + (y >> 2) * 2654435761) / 4294967296 - 0.5) * 0.15;
      v += (hashInt(x * 40503) / 4294967296 - 0.5) * 0.22;
      const i = (y * n + x) * 4;
      const a = clamp01(Math.abs(v) * 1.9) * 255;
      d[i] = 22; d[i + 1] = 24; d[i + 2] = 26;
      d[i + 3] = v < 0 ? a * 0.85 : a * 0.35;
    }
  }
  c.putImageData(img, 0, 0);
  void rand;
  return cv;
}

/** Cross-environment canvas factory. `OffscreenCanvas` when we have it, per STORY §3.4. */
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') {
    try { return new OffscreenCanvas(Math.max(1, w | 0), Math.max(1, h | 0)); } catch { /* fall through */ }
  }
  const cv = globalThis.document?.createElement?.('canvas');
  if (!cv) return null;
  cv.width = Math.max(1, w | 0);
  cv.height = Math.max(1, h | 0);
  return cv;
}

/**
 * The irregular page edge. A real sheet that has been folded into a pocket for six nights does not
 * have four straight edges. `sides` says which edges are real edges of the sheet rather than
 * creases (a crease must stay dead straight or the leaves show daylight between them).
 */
function paperPath(c, w, h, sides, seed, wear) {
  const amp = (0.9 + wear * 2.4);
  const jit = (i, axis) => (hashInt(seed + i * 7919 + axis * 104729) / 4294967296) * amp;
  const N = 9;
  // Jitter is always INWARD, so the sheet never spills past its own rect and the leaf slices stay
  // seamless at the creases.
  c.beginPath();
  c.moveTo(0, 0);
  for (let i = 1; i <= N; i++) {
    const x = (w * i) / N;
    c.lineTo(x, sides.top ? jit(i, 0) : 0);
  }
  for (let i = 1; i <= N; i++) {
    const y = (h * i) / N;
    c.lineTo(w - (sides.right ? jit(i, 1) : 0), y);
  }
  for (let i = N - 1; i >= 0; i--) {
    const x = (w * i) / N;
    c.lineTo(x, h - (sides.bottom ? jit(i, 2) : 0));
  }
  for (let i = N - 1; i >= 0; i--) {
    const y = (h * i) / N;
    c.lineTo(sides.left ? jit(i, 3) : 0, y);
  }
  c.closePath();
}

/**
 * ART §13.1's fold creases, and the thing the brief asks for by name: they must CATCH LIGHT.
 * A crease is a valley and a ridge — a −4% band and a +2% band, 3 px wide, and the ridge is on the
 * side the light is coming from. Wear widens and darkens it every night.
 */
function drawCrease(c, x, h, scale, wear, lit) {
  const wv = 26 * scale * (1 + wear * 0.5);
  const g = c.createLinearGradient(x - wv, 0, x + wv, 0);
  g.addColorStop(0.00, 'rgba(0,0,0,0)');
  g.addColorStop(0.42, `rgba(30,28,22,${0.030 + wear * 0.070})`);
  g.addColorStop(0.50, `rgba(30,28,22,${0.075 + wear * 0.115})`);
  g.addColorStop(0.58, `rgba(255,252,244,${(0.10 + wear * 0.10) * lit})`);
  g.addColorStop(1.00, 'rgba(0,0,0,0)');
  c.save();
  c.fillStyle = g;
  c.fillRect(x - wv, 0, wv * 2, h);
  // The fibres along a fold break. From Night Three there are small bright nicks in the valley.
  if (wear > 0.25) {
    c.globalAlpha = (wear - 0.25) * 0.5;
    c.fillStyle = '#fdfaf2';
    const n = Math.round(6 + wear * 22);
    for (let i = 0; i < n; i++) {
      const y = (hashInt(i * 2654435761 + (x | 0)) / 4294967296) * h;
      const l = 2 + (hashInt(i * 40503 + 7) / 4294967296) * 9 * scale;
      c.fillRect(x - 0.8 * scale, y, 1.6 * scale, l);
    }
  }
  c.restore();
}

/**
 * Photocopy degradation, ART §13.1. Each night is one more generation of copy: the border darkens
 * by 0.6% a night on a 14 mm margin, and from Night Three the drum jitters 0.3 px on 4% of
 * scanlines. By Night Seven the paper is measurably tireder than the man.
 */
function drawEdgeDarkening(c, w, h, scale, amount) {
  if (amount <= 0.0005) return;
  const band = 14 * scale * (PAGE.H / 297); // 14 mm on an A4 page, in device px
  const g1 = c.createLinearGradient(0, 0, band, 0);
  const stops = (g) => {
    g.addColorStop(0, `rgba(24,22,18,${amount * 4.2})`);
    g.addColorStop(1, 'rgba(24,22,18,0)');
  };
  c.save();
  stops(g1); c.fillStyle = g1; c.fillRect(0, 0, band, h);
  const g2 = c.createLinearGradient(w, 0, w - band, 0); stops(g2); c.fillStyle = g2; c.fillRect(w - band, 0, band, h);
  const g3 = c.createLinearGradient(0, 0, 0, band); stops(g3); c.fillStyle = g3; c.fillRect(0, 0, w, band);
  const g4 = c.createLinearGradient(0, h, 0, h - band); stops(g4); c.fillStyle = g4; c.fillRect(0, h - band, w, band);
  c.restore();
}

/**
 * Night Four onward: `blood.fresh` on the page edge, where he has held it, and never mentioned.
 * ART §13.9 adds exactly one small splatter per page in a corner from Night Five, drawn flat, as
 * if printed. Nothing on the page acknowledges either.
 */
function drawBlood(c, w, h, scale, night, seed) {
  const p = NIGHT_PAPER[clamp(night, 1, 7)];
  if (!p || p.blood <= 0) return;
  const r = new Rand(hashInt(seed ^ 0x5100d));
  c.save();
  // The thumb, on the page edge, at the height a big man's hand falls. Not a splatter — a print.
  c.globalAlpha = 0.30 + (night - 4) * 0.06;
  c.fillStyle = PAL.blood;
  const ty = h * (0.46 + r.next() * 0.10);
  const tw = 13 * scale, th = 26 * scale;
  c.beginPath();
  c.ellipse(w - tw * 0.35, ty, tw, th, 0.08, 0, Math.PI * 2);
  c.fill();
  c.globalAlpha *= 0.55;
  for (let i = 0; i < 5; i++) {
    c.beginPath();
    c.ellipse(w - tw * (0.9 + r.next() * 1.5), ty + (r.next() - 0.5) * th * 1.6,
      tw * (0.10 + r.next() * 0.16), th * (0.05 + r.next() * 0.10), r.next(), 0, Math.PI * 2);
    c.fill();
  }
  // The printed splatter. One. In a corner. Flat, in the same ink discipline as everything else.
  if (p.blood >= 2) {
    c.globalAlpha = 0.62;
    c.fillStyle = PAL.blood;
    const bx = w * 0.088, by = h * 0.928;
    c.beginPath();
    c.ellipse(bx, by, 7 * scale, 5.2 * scale, 0.4, 0, Math.PI * 2);
    c.fill();
    for (let i = 0; i < 7; i++) {
      const a = r.next() * Math.PI * 2, d = (6 + r.next() * 22) * scale;
      c.beginPath();
      c.arc(bx + Math.cos(a) * d, by + Math.sin(a) * d, (0.7 + r.next() * 1.7) * scale, 0, Math.PI * 2);
      c.fill();
    }
  }
  c.restore();
}

/**
 * ART §13.7 — the page number is replaced by a filled-segment progress bar in the bottom margin,
 * `n` filled cells of `total`, 1U each. It also tells you how much of tonight is left, which a
 * page number does not. Wordless, and it does two jobs.
 */
function drawProgressBar(c, pw, index, total, o) {
  const n = Math.max(1, total);
  const cell = U * 0.86, gap = U * 0.30;
  const wTot = n * cell + (n - 1) * gap;
  const x0 = (pw - wTot) / 2;
  const y = PAGE.H - PAGE.margin + U * 0.10;
  for (let i = 0; i < n; i++) {
    const x = x0 + i * (cell + gap);
    if (i <= index) {
      c.save();
      c.fillStyle = PAL.ink;
      c.fillRect(x, y, cell, U * 0.5);
      c.restore();
    } else {
      ink(c, [x, y, x + cell, y, x + cell, y + U * 0.5, x, y + U * 0.5, x, y],
        { weight: W.hairline, color: PAL.inkSoft, closed: true, hand: o.hand, seed: o.seed + i });
    }
  }
}

/**
 * GAME_DESIGN §6.6 — THE MANUAL IS THE FASTENER INVENTORY DISPLAY. One small circle per fastener
 * the stage requires: filled for each one in the pocket, open for each one missing. No HUD number,
 * no counter, no text. Opening the manual is already a reflex, so this costs nothing new.
 */
function drawFastenerRing(c, pw, held, required, o) {
  const n = clamp(Math.round(required), 0, 12);
  if (n <= 0) return;
  const y = PAGE.H - PAGE.margin - U * 0.4;
  const x = PAGE.margin + U * 1.2;
  bagCount(c, x, y - U * 0.6, U * 0.9, 0, { hand: o.hand, seed: o.seed + 61 });
  const r = U * 0.30, gap = U * 0.86;
  for (let i = 0; i < n; i++) {
    const cx = x + U * 1.9 + i * gap;
    if (i < held) fillDot(c, cx, y, r, PAL.ink);
    else ink(c, circlePts(cx, y, r, 14), { weight: W.thin, closed: true, hand: o.hand, seed: o.seed + 70 + i });
  }
}

/** The maker's mark. On Night Six it is traced and the slash through the Ø leans the wrong way. */
function drawMakersMark(c, pw, o) {
  // VIK & SØN as STROKES, not type: STORY §3.5's guard says nothing large in this manual is text,
  // so a total font failure cannot break the joke.
  const y = PAGE.H - PAGE.margin - U * 1.5;
  let x = pw - PAGE.margin - U * 7.4;
  const s = U * 0.52;
  const so = { weight: W.hairline, color: PAL.inkSoft, hand: o.hand, seed: o.seed + 90 };
  const L = (...p) => { ink(c, p, so); so.seed++; };
  const adv = (d) => { x += d; };
  // V
  L(x, y - s * 2, x + s * 0.62, y, x + s * 1.24, y - s * 2); adv(s * 1.7);
  // I
  L(x, y - s * 2, x, y); adv(s * 0.7);
  // K
  L(x, y - s * 2, x, y); L(x + s * 1.0, y - s * 2, x, y - s * 0.95); L(x, y - s * 0.95, x + s * 1.05, y);
  adv(s * 1.6);
  // &  (one continuous mark)
  L(x + s * 1.1, y - s * 1.35, x + s * 0.15, y - s * 0.2, x + s * 0.65, y, x + s * 1.15, y - s * 0.7,
    x + s * 0.2, y - s * 1.5, x + s * 0.62, y - s * 2, x + s * 1.0, y - s * 1.6);
  adv(s * 1.9);
  // S
  L(x + s * 0.95, y - s * 1.72, x + s * 0.15, y - s * 1.9, x + s * 0.1, y - s * 1.2,
    x + s * 0.9, y - s * 0.85, x + s * 0.85, y - s * 0.1, x + s * 0.05, y - s * 0.3);
  adv(s * 1.4);
  // Ø — the O and the slash. On a traced page the slash goes the other way.
  ink(c, circlePts(x + s * 0.6, y - s, s * 0.62, 20), { ...so, closed: true }); so.seed++;
  if (o.traced) L(x + s * 0.05, y - s * 0.4, x + s * 1.15, y - s * 1.6);
  else L(x + s * 0.05, y - s * 1.6, x + s * 1.15, y - s * 0.4);
  adv(s * 1.6);
  // N
  L(x, y, x, y - s * 2, x + s * 1.0, y, x + s * 1.0, y - s * 2);
}

/**
 * The cover word, as strokes. STORY §0.6 / §3: the player parses it as a flat-pack product name
 * the way you parse KALLAX. It is not a product name. If `Blueprint` is present it has its own
 * cover; this is the fallback's.
 */
function drawCoverWord(c, cx, cy, s, o) {
  const so = { weight: W.medium, color: PAL.ink, hand: o.hand, seed: o.seed + 120 };
  const L = (...p) => { ink(c, p, so); so.seed++; };
  let x = cx - s * 4.2;
  const y = cy;
  // H
  L(x, y - s * 2, x, y); L(x + s, y - s * 2, x + s, y); L(x, y - s, x + s, y - s); x += s * 1.7;
  // J
  L(x + s * 0.9, y - s * 2, x + s * 0.9, y - s * 0.5, x + s * 0.3, y, x - s * 0.05, y - s * 0.55); x += s * 1.7;
  // E
  L(x + s, y - s * 2, x, y - s * 2, x, y, x + s, y); L(x, y - s, x + s * 0.72, y - s); x += s * 1.7;
  // M
  L(x, y, x, y - s * 2, x + s * 0.55, y - s * 0.9, x + s * 1.1, y - s * 2, x + s * 1.1, y);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 6. THE FALLBACK MANUAL
 *
 * `Blueprint.js` may not be in the build. The manual must still be complete and correct, and it
 * must still tell the seven-night story, because the manual IS the story. This generator is
 * smaller than Blueprint's — no hidden-line removal, no real explode solver — but it is honest:
 * it obeys the same grid, the same four weights, the same closed glyph set, the same fact ceiling,
 * and the same night-by-night personality table from ART §13.5.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/** Which panels of a night's first page are in Ansel's hand. STORY §3.1's counts, distributed. */
function fallbackHandFor(night, panelIdx, pageIdx) {
  const share = NIGHT_PAPER[clamp(night, 1, 7)].ansel;
  if (share <= 0) return HANDS.marit;
  const h = hashInt(night * 7919 + pageIdx * 104729 + panelIdx * 15485863) / 4294967296;
  return h < share ? HANDS.ansel : HANDS.marit;
}

/**
 * One panel of the fallback manual. `kind` is chosen by the night's grammar, and every branch here
 * is a line from ART §13.5 or STORY §3.6 made literal.
 */
function fallbackPanel(c, rect, spec) {
  const { night, step, hand, seed, accent } = spec;
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  const o = { hand, seed };
  const S = Math.min(rect.w, rect.h);

  // The step badge, top-left of the panel, always at the same offset. On Night Six the numbering
  // is still immaculate and the CONTENT is what has come apart — so the badge is never wrong.
  stepBadge(c, rect.x + U * 1.3, rect.y + U * 1.3, spec.badge ?? step, { ...o, r: U, dashed: spec.dashed });

  switch (spec.kind) {
    case 'parts': {
      // The manifest. Night Two's bracket asks for six and the crate holds five, and the manual
      // admits its own shortfall without comment.
      partsBracket(c, rect.x + U * 0.6, rect.y + U * 3.2, rect.w - U * 1.2, rect.h - U * 5.0, o);
      const n = spec.count ?? 6;
      dimetricBox(c, cx - S * 0.20, cy, 1.6, 0.30, 0.30, S * 0.30, { ...o, seed: seed + 3 });
      countGlyphs(c, cx + S * 0.24, cy, n, U * 1.0, { ...o, seed: seed + 5 });
      bagCount(c, cx + S * 0.24, cy + S * 0.26, U * 1.1, spec.bag ?? 4, { ...o, seed: seed + 7 });
      break;
    }
    case 'insert': {
      // The whole grammar in one picture: a part, a target, and the vector between them.
      const ty = cy + S * 0.22;
      dimetricPier(c, cx, ty, S * 0.34, { ...o, seed: seed + 11 });
      dimetricPier(c, cx, cy - S * 0.26, S * 0.34, { ...o, seed: seed + 13, dash: [4, 4], weight: W.medium });
      ghostTrail(c, [cx, cy - S * 0.10, cx, ty - S * 0.18], { ...o, seed: seed + 15 });
      arrowStraight(c, cx + S * 0.30, cy - S * 0.20, cx + S * 0.30, ty - S * 0.10, { ...o, seed: seed + 17 });
      break;
    }
    case 'bolt': {
      // A bolt going into a hole. Then the same bolt, larger. Then the same bolt again with a
      // magnifier over it, in case you missed the bolt.
      dimetricBox(c, cx - S * 0.30, cy, 0.9, 0.22, 0.22, S * 0.26, { ...o, seed: seed + 21, anchor: false });
      dimetricBox(c, cx + S * 0.02, cy, 1.5, 0.34, 0.34, S * 0.26, { ...o, seed: seed + 23, anchor: false });
      magnifier(c, cx + S * 0.32, cy - S * 0.04, S * 0.16, { ...o, seed: seed + 25 }, (cc, mx, my, r) => {
        dimetricBox(cc, mx, my, 1.5, 0.34, 0.34, r * 0.62, { ...o, seed: seed + 27, anchor: false });
      });
      arrowStraight(c, cx - S * 0.42, cy + S * 0.30, cx - S * 0.30, cy + S * 0.14, { ...o, seed: seed + 29, size: U });
      break;
    }
    case 'torque': {
      // The spiral's turn count IS the value. Never a printed number beside it.
      dimetricBox(c, cx, cy + S * 0.10, 1.2, 0.26, 0.26, S * 0.28, { ...o, seed: seed + 31 });
      arrowSpiral(c, cx, cy - S * 0.18, S * 0.20, spec.turns ?? 1.75, { ...o, seed: seed + 33 });
      if (spec.overTorque) {
        lozenge(c, rect.x + rect.w - U * 2.0, rect.y + U * 2.0, U * 1.1, { ...o, color: accent, seed: seed + 35 });
      }
      break;
    }
    case 'forbidden': {
      // A bracket at 90°, ticked. The same bracket at 88°, ✗. The same at 89.5°, also ✗. The
      // forbidden variant is the one that looks correct.
      const yy = cy - S * 0.02;
      const drawBracket = (x, rot, ok, sd) => {
        c.save();
        c.translate(x, yy);
        c.rotate(rot * DEG);
        dimetricBox(c, 0, 0, 0.8, 0.8, 0.22, S * 0.16, { ...o, seed: sd, notch: true });
        c.restore();
        if (ok) tickMark(c, x, yy + S * 0.24, U * 0.9, { ...o, seed: sd + 1 });
        else slashCircle(c, x, yy, S * 0.16, { ...o, color: accent, seed: sd + 1 });
      };
      drawBracket(cx - S * 0.30, 0, true, seed + 41);
      drawBracket(cx, 2.0, false, seed + 45);
      drawBracket(cx + S * 0.30, 0.5, false, seed + 49);
      break;
    }
    case 'mirror': {
      mirrorGlyph(c, cx, cy - S * 0.02, S * 0.22, { ...o, seed: seed + 51 });
      dimetricBox(c, cx - S * 0.30, cy + S * 0.24, 0.9, 0.30, 0.24, S * 0.16, { ...o, seed: seed + 53, notch: true });
      dimetricBox(c, cx + S * 0.30, cy + S * 0.24, 0.9, 0.30, 0.24, S * 0.16, { ...o, seed: seed + 55, dash: [4, 4], weight: W.medium });
      break;
    }
    case 'span': {
      // A dimension whose LENGTH carries the number. Night Three prints eleven studs against a
      // span that says twelve spacings, both with total confidence.
      const n = spec.studs ?? 11;
      const x0 = rect.x + U * 2.0, x1 = rect.x + rect.w - U * 2.0;
      for (let i = 0; i < n; i++) {
        const x = lerp(x0, x1, n === 1 ? 0.5 : i / (n - 1));
        ink(c, [x, cy - S * 0.24, x, cy + S * 0.18], { ...o, weight: W.medium, seed: seed + 60 + i });
      }
      ink(c, [x0 - U * 0.4, cy + S * 0.18, x1 + U * 0.4, cy + S * 0.18], { ...o, weight: W.heavy, seed: seed + 80 });
      arrowSpan(c, x0, cy - S * 0.34, x1, cy - S * 0.34, { ...o, witness: -U * 0.9, seed: seed + 82 });
      countGlyphs(c, cx, cy + S * 0.34, spec.spacings ?? 6, U * 0.8, { ...o, seed: seed + 84 });
      break;
    }
    case 'collapsed': {
      // Night Three combines eleven sub-assemblies into one drawing with fourteen arrows and no
      // intermediate states. Good luck.
      const r = new Rand(hashInt(seed + 909));
      for (let i = 0; i < 7; i++) {
        const x = rect.x + U * 2 + r.next() * (rect.w - U * 4);
        const y = rect.y + U * 3 + r.next() * (rect.h - U * 6);
        dimetricBox(c, x, y, 0.6 + r.next() * 0.8, 0.2, 0.2, S * 0.13, { ...o, seed: seed + 100 + i * 3 });
      }
      for (let i = 0; i < 14; i++) {
        const a = r.next() * Math.PI * 2;
        const x = cx + Math.cos(a) * S * (0.16 + r.next() * 0.24);
        const y = cy + Math.sin(a) * S * (0.14 + r.next() * 0.22);
        arrowStraight(c, x, y, x + Math.cos(a) * S * 0.10, y + Math.sin(a) * S * 0.10,
          { ...o, size: U * 0.7, seed: seed + 140 + i });
      }
      break;
    }
    case 'one-arrow': {
      // An entire step rendered as one downward arrow and a count. It has stopped explaining.
      arrowStraight(c, cx - S * 0.10, cy - S * 0.28, cx - S * 0.10, cy + S * 0.22, { ...o, size: U * 1.6, seed: seed + 161 });
      countGlyphs(c, cx + S * 0.22, cy, 6, U * 1.1, { ...o, seed: seed + 163 });
      break;
    }
    case 'lightcone': {
      // Night Four. A cone of light on the ground, the figure outside it, a dotted path. The first
      // panel that is about THEM and not about the house.
      ink(c, [cx + S * 0.10, cy - S * 0.34, cx - S * 0.16, cy + S * 0.26, cx + S * 0.38, cy + S * 0.26, cx + S * 0.10, cy - S * 0.34],
        { ...o, weight: W.thin, closed: true, seed: seed + 171 });
      ink(c, arcPts(cx + S * 0.11, cy + S * 0.26, S * 0.27, 0, Math.PI, 16), { ...o, weight: W.hairline, dash: [5, 4], seed: seed + 173 });
      drawMascot(c, rect.x + U * 3.2, cy + S * 0.28, S * 0.44, { ...o, pose: 'standing-neutral', seed: seed + 175 });
      ghostTrail(c, [rect.x + U * 3.2, cy + S * 0.32, cx - S * 0.30, cy + S * 0.36, cx - S * 0.16, cy + S * 0.30],
        { ...o, seed: seed + 177 });
      break;
    }
    case 'measured': {
      // Hero 4.9. The figure standing over a horizontal shape. The shape is not a joist. It has
      // shoes. The manual measured him. Nothing else on the page comments.
      const y0 = cy + S * 0.22;
      ink(c, [cx - S * 0.36, y0, cx + S * 0.30, y0, cx + S * 0.30, y0 + S * 0.07, cx - S * 0.36, y0 + S * 0.07, cx - S * 0.36, y0],
        { ...o, weight: W.heavy, closed: true, seed: seed + 181 });
      ink(c, [cx + S * 0.30, y0 + S * 0.01, cx + S * 0.37, y0 - S * 0.03, cx + S * 0.38, y0 + S * 0.05, cx + S * 0.30, y0 + S * 0.06],
        { ...o, weight: W.medium, closed: true, seed: seed + 183 });
      ink(c, [cx + S * 0.30, y0 + S * 0.02, cx + S * 0.38, y0 + S * 0.09, cx + S * 0.36, y0 + S * 0.12, cx + S * 0.30, y0 + S * 0.07],
        { ...o, weight: W.medium, closed: true, seed: seed + 185 });
      arrowSpan(c, cx - S * 0.36, y0 + S * 0.20, cx + S * 0.38, y0 + S * 0.20, { ...o, witness: -U * 1.1, seed: seed + 187 });
      drawMascot(c, cx - S * 0.10, y0 - S * 0.04, S * 0.52, { ...o, pose: 'standing-neutral', seed: seed + 189 });
      break;
    }
    case 'two-persons': {
      // THIS STEP REQUIRES TWO PERSONS. Standard flat-pack iconography, used honestly, which is
      // worse. Both figures in Marit's hand. Both drawn twenty-two years ago.
      const beam = cy - S * 0.06;
      ink(c, [cx - S * 0.40, beam, cx + S * 0.40, beam, cx + S * 0.40, beam + S * 0.06, cx - S * 0.40, beam + S * 0.06, cx - S * 0.40, beam],
        { hand: HANDS.marit, weight: W.heavy, closed: true, seed: seed + 191 });
      drawMascot(c, cx - S * 0.38, beam + S * 0.42, S * 0.44, { hand: HANDS.marit, pose: 'holding-part-two-hands', seed: seed + 193 });
      drawMascot(c, cx + S * 0.38, beam + S * 0.42, S * 0.44, { hand: HANDS.marit, pose: 'holding-part-two-hands', seed: seed + 195 });
      lozenge(c, cx, rect.y + U * 2.2, U * 1.1, { ...o, color: accent, seed: seed + 197 });
      break;
    }
    case 'erased': {
      // Hero 5.4. The second figure: erased, redrawn, erased, redrawn smaller. Three ghosts under
      // the final line. No arrows, no numbers, no instruction. It should not be in a manual.
      const gh = { ...HANDS.marit, ghostAlpha: 0.16 };
      drawMascot(c, cx + S * 0.30, cy + S * 0.30, S * 0.60, { hand: gh, pose: 'arms-at-sides', seed: seed + 201, alpha: 0.16 });
      drawMascot(c, cx + S * 0.26, cy + S * 0.30, S * 0.52, { hand: gh, pose: 'arms-at-sides', seed: seed + 203, alpha: 0.14 });
      drawMascot(c, cx + S * 0.24, cy + S * 0.30, S * 0.46, { hand: gh, pose: 'arms-at-sides', seed: seed + 205, alpha: 0.12 });
      drawMascot(c, cx - S * 0.22, cy + S * 0.30, S * 0.58, { hand: HANDS.marit, pose: 'standing-neutral', seed: seed + 207 });
      drawMascot(c, cx + S * 0.22, cy + S * 0.30, S * 0.40, { hand: HANDS.ansel, pose: 'arms-at-sides', seed: seed + 209 });
      break;
    }
    case 'counterweight': {
      // Hero 5.7. The counterweight is a dotted outline of a standing person, with the
      // "approximate" tilde and no number at all.
      ink(c, [cx - S * 0.34, cy - S * 0.18, cx + S * 0.34, cy - S * 0.18], { ...o, weight: W.heavy, seed: seed + 211 });
      ink(c, [cx + S * 0.20, cy - S * 0.18, cx + S * 0.20, cy + S * 0.10], { ...o, weight: W.thin, seed: seed + 213 });
      drawMascot(c, cx + S * 0.20, cy + S * 0.34, S * 0.42, { ...o, pose: 'arms-at-sides', dotted: true, seed: seed + 215 });
      // The tilde. It is a mark, not a letter: "approximately".
      ink(c, [cx - S * 0.06, cy + S * 0.22, cx - S * 0.02, cy + S * 0.18, cx + S * 0.02, cy + S * 0.26, cx + S * 0.06, cy + S * 0.22],
        { ...o, weight: W.medium, seed: seed + 217 });
      break;
    }
    case 'empty-slot': {
      // Hero 6.5. A confident arrow, and an empty slot. It is not in the world. It has never been
      // in the world. The slot it points at is beside the kitchen table.
      ink(c, [cx - S * 0.06, cy - S * 0.04, cx + S * 0.20, cy - S * 0.04, cx + S * 0.20, cy + S * 0.22, cx - S * 0.06, cy + S * 0.22, cx - S * 0.06, cy - S * 0.04],
        { ...o, weight: W.medium, dash: [5, 5], closed: true, seed: seed + 221 });
      arrowStraight(c, cx - S * 0.34, cy - S * 0.26, cx - S * 0.02, cy - S * 0.02, { ...o, seed: seed + 223 });
      break;
    }
    case 'kitchen': {
      // Hero 6.8. A kitchen wall elevation in perfect Marit line — a window over a sink, four
      // pencil marks on a doorframe at ascending heights — with a bunk bed drawn over it in
      // Ansel's hand and erased. The ghost stays.
      const m = HANDS.marit;
      const wl = { hand: m, seed: seed + 231 };
      ink(c, [cx - S * 0.40, cy - S * 0.34, cx + S * 0.40, cy - S * 0.34, cx + S * 0.40, cy + S * 0.36, cx - S * 0.40, cy + S * 0.36, cx - S * 0.40, cy - S * 0.34],
        { ...wl, weight: W.medium, closed: true });
      ink(c, [cx - S * 0.28, cy - S * 0.22, cx + S * 0.04, cy - S * 0.22, cx + S * 0.04, cy + S * 0.02, cx - S * 0.28, cy + S * 0.02, cx - S * 0.28, cy - S * 0.22],
        { ...wl, weight: W.thin, closed: true, seed: seed + 233 });
      ink(c, [cx - S * 0.30, cy + S * 0.10, cx + S * 0.06, cy + S * 0.10, cx + S * 0.06, cy + S * 0.24, cx - S * 0.30, cy + S * 0.24, cx - S * 0.30, cy + S * 0.10],
        { ...wl, weight: W.medium, closed: true, seed: seed + 235 });
      // The doorframe, and the four marks. 91, 108, 124, 141 cm. Nobody is ever told.
      ink(c, [cx + S * 0.24, cy - S * 0.34, cx + S * 0.24, cy + S * 0.36], { ...wl, weight: W.medium, seed: seed + 237 });
      const hs = [0.22, 0.09, -0.04, -0.16];
      for (let i = 0; i < 4; i++) {
        ink(c, [cx + S * 0.24, cy + S * hs[i], cx + S * 0.33, cy + S * hs[i]],
          { ...wl, weight: W.thin, seed: seed + 239 + i });
      }
      // The bunk. Drawn over his mother's house because he is trying to make it fit a camp. It
      // doesn't. He erases it. The ghost stays at 0.14.
      const gh = { ...HANDS.ansel, ghostAlpha: 0.14 };
      ink(c, [cx - S * 0.34, cy - S * 0.10, cx + S * 0.10, cy - S * 0.10], { hand: gh, weight: W.medium, alpha: 0.15, seed: seed + 245 });
      ink(c, [cx - S * 0.34, cy + S * 0.16, cx + S * 0.10, cy + S * 0.16], { hand: gh, weight: W.medium, alpha: 0.15, seed: seed + 247 });
      ink(c, [cx - S * 0.34, cy - S * 0.16, cx - S * 0.34, cy + S * 0.24], { hand: gh, weight: W.medium, alpha: 0.15, seed: seed + 249 });
      ink(c, [cx + S * 0.10, cy - S * 0.16, cx + S * 0.10, cy + S * 0.24], { hand: gh, weight: W.medium, alpha: 0.15, seed: seed + 251 });
      break;
    }
    case 'alone': {
      // Hero 6.9. The figure, alone, in the centre of an otherwise empty page. Not doing anything.
      drawMascot(c, cx, cy + S * 0.30, S * 0.62, { ...o, pose: 'arms-at-sides', seed: seed + 261 });
      break;
    }
    case 'section': {
      // Night Seven. A dimetric section of the finished cabin with four bunks and eight small
      // figures in them, drawn in the same 1.5 px thin weight as everything else.
      const w2 = S * 0.42, h2 = S * 0.26;
      ink(c, [cx - w2, cy + h2, cx - w2, cy - h2 * 0.4, cx, cy - h2 * 1.15, cx + w2, cy - h2 * 0.4, cx + w2, cy + h2, cx - w2, cy + h2],
        { ...o, weight: W.medium, closed: true, seed: seed + 271 });
      for (let i = 0; i < 4; i++) {
        const bx = cx - w2 * 0.72 + (i % 2) * w2 * 1.44;
        const by = cy + h2 * (i < 2 ? -0.18 : 0.52);
        ink(c, [bx - w2 * 0.34, by, bx + w2 * 0.34, by], { ...o, weight: W.thin, seed: seed + 273 + i });
        for (let k = 0; k < 2; k++) {
          const fx = bx - w2 * 0.16 + k * w2 * 0.32;
          ink(c, circlePts(fx, by - S * 0.028, S * 0.020, 12), { ...o, weight: W.thin, closed: true, seed: seed + 281 + i * 2 + k });
          ink(c, [fx - S * 0.030, by - S * 0.006, fx + S * 0.030, by - S * 0.006],
            { ...o, weight: W.thin, seed: seed + 291 + i * 2 + k });
        }
      }
      tickMark(c, rect.x + rect.w - U * 2.2, cy, U * 1.4, { ...o, weight: W.heavy, seed: seed + 299 });
      break;
    }
    case 'last-page': {
      // A dotted outline of a small seated figure, in a chair, at a table. Child-sized. Marit's
      // hand, 1962, the last page she finished. Dotted means: present, but occluded in this view.
      // Above it, the parts bracket, and inside the bracket, nothing.
      const m = HANDS.marit;
      partsBracket(c, cx - S * 0.20, cy - S * 0.44, S * 0.40, S * 0.20, { hand: m, seed: seed + 301 });
      ink(c, [cx - S * 0.40, cy + S * 0.06, cx + S * 0.10, cy + S * 0.06], { hand: m, weight: W.thin, seed: seed + 303 });
      ink(c, [cx - S * 0.34, cy + S * 0.06, cx - S * 0.34, cy + S * 0.34], { hand: m, weight: W.thin, seed: seed + 305 });
      ink(c, [cx + S * 0.04, cy + S * 0.06, cx + S * 0.04, cy + S * 0.34], { hand: m, weight: W.thin, seed: seed + 307 });
      ink(c, [cx + S * 0.22, cy + S * 0.34, cx + S * 0.22, cy - S * 0.08, cx + S * 0.38, cy - S * 0.08],
        { hand: m, weight: W.thin, seed: seed + 309 });
      drawMascot(c, cx + S * 0.24, cy + S * 0.30, S * 0.30, { hand: m, pose: 'seated-on-floor', dotted: true, seed: seed + 311 });
      break;
    }
    case 'blank':
    default:
      break;
  }

  if (spec.crossed) {
    // A ✗ over a panel showing a CORRECT action. No explanation. The player must decide whether to
    // trust the picture or the mark.
    crossX(c, cx, cy, S * 0.30, { ...o, color: accent, seed: seed + 401 });
  }
  if (spec.mascot) {
    drawMascot(c, rect.x + rect.w - U * 3.0, rect.y + rect.h - U * 1.0, S * 0.36,
      { ...o, pose: spec.mascot, seed: seed + 411, mouth: spec.mouth, accent });
    if (spec.sparkle) sparkle(c, rect.x + rect.w - U * 4.6, rect.y + rect.h - U * 4.4, U * 0.8, { ...o, seed: seed + 413 });
    if (spec.tapping) motionTicks(c, rect.x + rect.w - U * 1.6, rect.y + rect.h - U * 0.6, U * 0.6, { ...o, seed: seed + 415 });
  }
}

/**
 * The night's page plan. This table is ART §13.5's comedy pipeline and STORY §3.6's seven-stage
 * evolution, in the only form that can actually ship: a list of panels per page per night.
 *
 * Read the shape of it. The manual gets busier and more anxious until Night Six and then goes
 * quiet. Night Seven's page is emptier than Night One's. He has stopped needing to explain it to
 * himself.
 */
function fallbackPlan(night) {
  switch (clamp(night, 1, 7)) {
    case 1: return [
      [{ kind: 'parts', count: 6, bag: 4 }, { kind: 'insert' }, { kind: 'bolt' }],
      [{ kind: 'insert' }, { kind: 'torque', turns: 1.75 }, { kind: 'insert', mascot: 'thumbs-up', sparkle: true }],
    ];
    case 2: return [
      // The parts row asks for six and the crate holds five. No comment is made.
      [{ kind: 'parts', count: 6, bag: 5 }, { kind: 'forbidden' }, { kind: 'mirror' }, { kind: 'torque', turns: 1.5, overTorque: true, mascot: 'shrugging-at-missing-hardware' }],
      [{ kind: 'insert' }, { kind: 'torque', turns: 2.25, overTorque: true, mascot: 'head-tilt-confused', mouth: true }, { kind: 'insert' }],
    ];
    case 3: return [
      // Eleven studs; a span that says twelve. Both printed with total confidence.
      [{ kind: 'collapsed' }, { kind: 'span', studs: 11, spacings: 6 }, { kind: 'one-arrow' }, { kind: 'insert', crossed: true }],
      [{ kind: 'torque', turns: 1.0 }, { kind: 'mirror' }, { kind: 'insert', mascot: 'standing-neutral', tapping: true }, { kind: 'bolt' }],
    ];
    case 4: return [
      [{ kind: 'parts', count: 4, bag: 3 }, { kind: 'insert' }, { kind: 'lightcone' }, { kind: 'insert', flipped: true }],
      // The exclamation lozenge, placed next to an empty area of the page, warning about nothing.
      [{ kind: 'collapsed' }, { kind: 'blank', lozengeAtNothing: true }, { kind: 'torque', turns: 2.0 }, { kind: 'span', studs: 8, spacings: 8 }],
      [{ kind: 'measured' }, { kind: 'insert' }],
    ];
    case 5: return [
      [{ kind: 'two-persons' }, { kind: 'insert' }, { kind: 'torque', turns: 1.75 }],
      [{ kind: 'erased' }, { kind: 'blank' }, { kind: 'counterweight' }],
      [{ kind: 'insert' }, { kind: 'span', studs: 6, spacings: 6 }, { kind: 'insert', mascot: 'wagging-finger-no' }],
    ];
    case 6: return [
      // Step 14 before step 9. Step 9 does not appear. The numbering is still immaculate.
      [{ kind: 'insert', badge: 14 }, { kind: 'empty-slot', badge: 6 }, { kind: 'collapsed', badge: 3 }, { kind: 'mirror', badge: 11 }],
      [{ kind: 'kitchen', badge: 2 }, { kind: 'span', studs: 5, spacings: 4, badge: 5 }, { kind: 'torque', turns: 3.0, badge: 1 }, { kind: 'insert', badge: 12 }],
      [{ kind: 'alone', badge: 4 }, { kind: 'bolt', badge: 8 }, { kind: 'insert', badge: 13 }, { kind: 'forbidden', badge: 7 }],
      [{ kind: 'insert', badge: 10 }, { kind: 'one-arrow', badge: 15 }, { kind: 'insert', badge: 16 }, { kind: 'blank' }],
    ];
    default: return [
      // The joke stops. It is perfect again, exactly like Night One.
      [{ kind: 'section' }, { kind: 'insert' }],
      [{ kind: 'last-page' }],
    ];
  }
}

/**
 * Draw a complete fallback page. Same grid, same margins, same footer as `Blueprint`, so the
 * annotation layer lands identically whichever generator drew the art underneath it.
 */
function fallbackPage(c, pw, ph, night, pageIdx, opts) {
  const n = clamp(night, 1, 7);
  const paper = NIGHT_PAPER[n];
  const accent = opts.accent ?? PAL.red;
  const seed0 = hashInt(opts.seed ^ Math.imul(n, 0x9e3779b1) ^ (pageIdx * 7919));

  c.save();
  c.fillStyle = opts.paper ?? PAL.paper;
  c.fillRect(0, 0, pw, ph);
  c.restore();

  // Damp bloom. The manual lives against his chest and it rains for six of the seven nights.
  if (paper.wear > 0.05) {
    const r = new Rand(seed0 ^ 0xda37);
    c.save();
    c.globalAlpha = 0.05 * paper.wear;
    c.fillStyle = PAL.foxing;
    const blooms = Math.round(2 + paper.wear * 9);
    for (let i = 0; i < blooms; i++) {
      c.beginPath();
      c.arc(r.next() * pw, r.next() * ph, 24 + r.next() * 90, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  const pages = fallbackPlan(n);
  const page = pages[clamp(pageIdx, 0, pages.length - 1)] ?? [];
  const hand0 = fallbackHandFor(n, 0, pageIdx);

  // Page 0 of every night is the cover: the word, the elevation, and the maker's mark.
  if (pageIdx === 0 && opts.cover !== false) {
    drawCoverWord(c, pw / 2, PAGE.margin + U * 6.0, U * 2.2, { hand: HANDS.marit, seed: seed0 });
    // The house in three-quarter elevation. Drawn by a woman who was good at this.
    const cx = pw / 2, cy = ph * 0.52, s = Math.min(pw, ph) * 0.30;
    dimetricBox(c, cx, cy + s * 0.24, 3.4, 1.5, 2.4, s * 0.30, { hand: HANDS.marit, seed: seed0 + 11, anchor: false });
    ink(c, [cx - s * 0.62, cy - s * 0.20, cx, cy - s * 0.62, cx + s * 0.62, cy - s * 0.20],
      { hand: HANDS.marit, weight: W.heavy, seed: seed0 + 13 });
    drawMascot(c, cx + s * 0.92, cy + s * 0.66, s * 0.52,
      { hand: HANDS.marit, pose: n === 1 ? 'waving' : n === 7 ? 'arms-at-sides' : 'standing-neutral', seed: seed0 + 15 });
    // Night 7's cover carries the telephone, in his hand, and nothing else new.
    if (n === 7) telephone(c, pw - PAGE.margin - U * 3.0, ph * 0.80, U * 1.4, { hand: HANDS.ansel, seed: seed0 + 17 });
    drawMakersMark(c, pw, { hand: hand0, seed: seed0 + 19, traced: n === 6 });
    c.save();
    c.restore();
    return { panels: 0, hand: HANDS.marit };
  }

  // The 2×2 grid. Margins 3U/3U left-right, 4U top, 5U bottom, per ART §13.3.
  const gx = PAGE.margin, gy = PAGE.margin;
  const gw = pw - PAGE.margin * 2, gh = ph - PAGE.margin * 2 - PAGE.footer;
  const cols = page.length > 2 ? 2 : 1;
  const rows = Math.ceil(page.length / cols);
  const gutter = U * 3;
  const cw = (gw - gutter * (cols - 1)) / cols;
  const ch = (gh - gutter * (rows - 1)) / rows;

  for (let i = 0; i < page.length; i++) {
    const spec = page[i];
    const col = i % cols, row = (i / cols) | 0;
    const rect = { x: gx + col * (cw + gutter), y: gy + row * (ch + gutter), w: cw, h: ch };
    const hand = fallbackHandFor(n, i, pageIdx);
    const seed = seed0 + i * 1013;

    // Night Four: one panel is printed upside down. A physical mis-collation. The ghost-trail
    // arrow now points the wrong way in world space, and nothing says so.
    const flipped = !!spec.flipped;
    c.save();
    if (flipped) {
      c.translate(rect.x + rect.w / 2, rect.y + rect.h / 2);
      c.rotate(Math.PI);
      c.translate(-(rect.x + rect.w / 2), -(rect.y + rect.h / 2));
    }
    fallbackPanel(c, rect, { night: n, step: i + 1, hand, seed, accent, ...spec });
    c.restore();

    if (spec.lozengeAtNothing) {
      lozenge(c, rect.x + rect.w * 0.62, rect.y + rect.h * 0.42, U * 1.2, { hand, color: accent, seed: seed + 501 });
    }
  }

  drawMakersMark(c, pw, { hand: hand0, seed: seed0 + 601, traced: n === 6 });
  return { panels: page.length, hand: hand0 };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 7. THE ANNOTATION LAYER
 *
 * The manual acquires marks. Not comments — MARKS: a circled join, a red ✗, a corrected dimension,
 * a ring of fasteners with the missing ones left open. `BuildSystem.inspect(slotId)` returns a
 * diagnosis object of numbers and glyph ids precisely so that this layer never has to write a
 * sentence, and it never does.
 *
 * They live in the margins, which is where a person actually annotates a drawing, and each one
 * throws a leader line into the diagram so you know which join it is about. They persist for the
 * night: GAME_DESIGN §6.8, "build errors persist — the record of your reading comprehension."
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Ten anchors around the page's generous margins. Deterministic per slot id, first-come, so the
 * same mistake lands in the same place every time you open the page — which is what makes the
 * marks feel like a record rather than a decoration.
 */
const ANCHORS = Object.freeze([
  [0.075, 0.20], [0.925, 0.20], [0.075, 0.40], [0.925, 0.40],
  [0.075, 0.60], [0.925, 0.60], [0.075, 0.80], [0.925, 0.80],
  [0.30, 0.945], [0.70, 0.945],
]);

/** Where in the drawing the leader points. Also deterministic — the joint the mark is about. */
function leaderTarget(slotId) {
  const h = hashStr(String(slotId));
  return [0.30 + ((h >>> 8) & 255) / 255 * 0.40, 0.26 + ((h >>> 16) & 255) / 255 * 0.44];
}

/**
 * Turn a `BuildSystem` diagnosis into a mark. Nothing here reads prose out of the diagnosis, and
 * nothing here writes prose into the page: `diag.glyph` is already a member of `Script.glyphs`,
 * which is the closed set `Blueprint` draws from, and this is the same set.
 */
function markFromDiagnosis(d) {
  if (!d) return null;
  const m = {
    slotId: d.slotId,
    glyph: d.glyph ?? 'red-slash-circle',
    fastenersHeld: d.fastenersHeld ?? 0,
    fastenersRequired: d.fastenersRequired ?? 0,
    offsetMm: d.offsetMm ?? 0,
    torque: typeof d.torque === 'number' ? d.torque : null,
    severity: d.severityIfItSpeaks ?? 0,
    correct: !!d.correct,
    creaks: 0,
  };
  // A corrected dimension: the printed span struck through, the real one drawn under it. The
  // manual is not sorry, it just quietly redraws the number it got wrong.
  if (m.offsetMm > 0) m.dimension = m.offsetMm;
  // A seating that is short is a spiral with fewer turns than the one printed on the page.
  if (m.torque !== null && m.torque < 0.8 && !m.correct) m.turns = clamp(0.6 + m.torque * 1.6, 0.5, 2.6);
  return m;
}

/** Draw one mark, in page units, on a page `pw` wide. */
function drawMark(c, mark, pw, ph, o) {
  const accent = o.accent ?? PAL.red;
  const hand = o.hand ?? HANDS.ansel;   // the annotations are HIS. He is the one making mistakes.
  const seed = hashStr(String(mark.slotId)) | 0;
  const ax = mark.ax * pw, ay = mark.ay * ph;
  const [tu, tv] = leaderTarget(mark.slotId);
  const tx = tu * pw, ty = tv * ph;
  const so = { hand, seed };
  const s = U * 1.25;

  // The leader: hairline, dashed, from the mark to the joint it is about, with a small head. Under
  // everything, so it never fights the mark for attention.
  ghostTrail(c, [ax + (tx > ax ? s * 1.4 : -s * 1.4), ay, lerp(ax, tx, 0.55), lerp(ay, ty, 0.35), tx, ty],
    { ...so, seed: seed + 1 });
  head(c, tx, ty, tx - lerp(ax, tx, 0.55), ty - lerp(ay, ty, 0.35), U * 0.62, { color: PAL.inkSoft });

  switch (mark.glyph) {
    case 'tick':
      // Repaired. Black, beside the mark, and the manual says nothing else about it.
      tickMark(c, ax, ay, s, { ...so, color: PAL.ink });
      break;

    case 'mirror':
      // Rotated. The join circled, and the part drawn both ways with a curved arrow between them.
      ink(c, circlePts(ax, ay, s * 1.15, 26), { ...so, weight: W.heavy, color: accent, closed: true });
      mirrorGlyph(c, ax, ay, s * 0.62, { ...so, seed: seed + 3 });
      arrowCurved(c, ax, ay + s * 1.9, s * 0.9, Math.PI, Math.PI * 1.85, { ...so, color: accent, seed: seed + 5, size: U * 0.7 });
      break;

    case 'red-slash-circle':
      slashCircle(c, ax, ay, s * 1.1, { ...so, color: accent });
      break;

    case 'red-exclamation-triangle': {
      const col = accent;
      ink(c, [ax, ay - s * 1.1, ax + s * 1.05, ay + s * 0.75, ax - s * 1.05, ay + s * 0.75, ax, ay - s * 1.1],
        { ...so, weight: W.heavy, color: col, closed: true });
      ink(c, [ax, ay - s * 0.5, ax, ay + s * 0.16], { ...so, weight: W.heavy, color: col, seed: seed + 3 });
      fillDot(c, ax, ay + s * 0.44, s * 0.13, col);
      // Redundant encoding: a dashed shadow triangle, so this is legible without hue.
      ink(c, [ax, ay - s * 1.36, ax + s * 1.3, ay + s * 0.95, ax - s * 1.3, ay + s * 0.95, ax, ay - s * 1.36],
        { ...so, weight: W.hairline, color: col, dash: [3, 4], closed: true, seed: seed + 5 });
      break;
    }

    case 'bag-count':
      // Under-fastened. The ring: filled for held, open for missing. It is the whole diagnosis and
      // it is four circles.
      bagCount(c, ax - s * 1.3, ay, s * 0.9, 0, { ...so });
      countGlyphs(c, ax + s * 0.9, ay, mark.fastenersRequired || 4, s * 0.72,
        { ...so, seed: seed + 7 }, mark.fastenersHeld);
      break;

    case 'arrow-curved':
      // Under-torqued. A spiral with the number of turns it actually needed.
      arrowSpiral(c, ax, ay, s * 1.15, mark.turns ?? 1.25, { ...so, color: accent, size: U * 0.8 });
      break;

    case 'dotted-outline':
      ink(c, circlePts(ax, ay, s, 22), { ...so, weight: W.medium, dash: [4, 4], closed: true });
      break;

    case 'mascot-hand-raised':
      // Night Seven's diagnosis. Everything is correct and the manifest is short one article, and
      // the article is a person. Two persons required. There is one of you.
      drawMascot(c, ax - s * 0.7, ay + s * 1.4, s * 2.6, { ...so, pose: 'holding-part-two-hands' });
      drawMascot(c, ax + s * 0.7, ay + s * 1.4, s * 2.6, { ...so, pose: 'holding-part-two-hands', dotted: true, seed: seed + 9 });
      break;

    case 'magnifier':
      // A shortfall. The callout shows a silhouette from the site where the thing is, so the player
      // navigates by remembered shape rather than by searching (ART §13.4).
      magnifier(c, ax, ay, s * 1.2, { ...so }, (cc, mx, my, r) => {
        const sil = mark.silhouette ?? 0;
        if (sil % 3 === 0) {
          // a canoe's chine
          ink(cc, [mx - r * 0.8, my + r * 0.1, mx - r * 0.2, my - r * 0.35, mx + r * 0.5, my - r * 0.3, mx + r * 0.8, my + r * 0.2],
            { ...so, weight: W.medium, seed: seed + 11 });
        } else if (sil % 3 === 1) {
          // a porch baluster
          ink(cc, [mx - r * 0.22, my - r * 0.8, mx - r * 0.22, my - r * 0.2, mx - r * 0.5, my, mx - r * 0.22, my + r * 0.3, mx - r * 0.22, my + r * 0.8],
            { ...so, weight: W.medium, seed: seed + 13 });
          ink(cc, [mx + r * 0.22, my - r * 0.8, mx + r * 0.22, my - r * 0.2, mx + r * 0.5, my, mx + r * 0.22, my + r * 0.3, mx + r * 0.22, my + r * 0.8],
            { ...so, weight: W.medium, seed: seed + 15 });
        } else {
          // an oar against a door
          ink(cc, [mx - r * 0.6, my + r * 0.8, mx + r * 0.3, my - r * 0.7], { ...so, weight: W.medium, seed: seed + 17 });
          ink(cc, circlePts(mx + r * 0.36, my - r * 0.55, r * 0.22, 14), { ...so, weight: W.medium, closed: true, seed: seed + 19 });
        }
      });
      break;

    case 'telephone':
      telephone(c, ax, ay, s * 1.1, { ...so });
      break;

    case 'arrow-straight':
    case 'circle-number':
    default:
      ink(c, circlePts(ax, ay, s, 24), { ...so, weight: W.medium, color: accent, closed: true });
      arrowStraight(c, ax - s * 1.9, ay - s * 1.5, ax - s * 0.75, ay - s * 0.6, { ...so, color: accent, size: U * 0.8 });
      break;
  }

  // A creak is drawn where a sound would be if a sound could be drawn: concentric arcs off the
  // joint, one per severity band. It is the only annotation that is about the world and not the
  // page, and it is how the player learns which join is the one that is talking.
  if (mark.creaks > 0) {
    const rings = clamp(Math.round(1 + mark.severity * 3), 1, 4);
    for (let i = 0; i < rings; i++) {
      ink(c, arcPts(tx, ty, U * (1.1 + i * 0.85), -0.9, 0.9, 14),
        { hand, weight: W.thin, color: accent, alpha: 1 - i * 0.18, seed: seed + 31 + i });
    }
  }

  // The corrected dimension. The printed span, struck through; the real one drawn beneath it.
  if (mark.dimension > 0) {
    const y = ay + s * 2.1;
    const half = clamp(s * 2.4, U * 2, U * 5);
    arrowSpan(c, ax - half, y, ax + half, y, { ...so, seed: seed + 41, witness: -U * 0.5 });
    ink(c, [ax - half * 1.05, y - U * 0.35, ax + half * 1.05, y + U * 0.35],
      { ...so, weight: W.medium, color: accent, seed: seed + 43 });
    const corrected = half * clamp(1 - mark.dimension / 60, 0.35, 0.95);
    arrowSpan(c, ax - corrected, y + U * 1.3, ax + corrected, y + U * 1.3, { ...so, seed: seed + 45, witness: -U * 0.5 });
  }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 8. THE SHEET — DOM, CSS, and the fold
 *
 * Three leaves on two hinge axes: a sheet folded in thirds and then in half, the way a leaflet
 * that has lived in a pocket for six nights is folded. The open and close are CSS transitions, not
 * per-frame JavaScript, which is what makes ARCHITECTURE §12's "no allocation in update()" true
 * for free — the whole animation costs zero main-thread work once it is armed.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

const CSS = `
.scb-root{position:fixed;inset:0;pointer-events:none;z-index:60;overflow:hidden;
  perspective:1500px;perspective-origin:50% 46%;opacity:0;
  transition:opacity 140ms linear;contain:strict}
.scb-root[data-vis="1"]{opacity:1}
.scb-fold{position:absolute;left:50%;top:46%;transform-style:preserve-3d;
  will-change:transform;transform-origin:50% 100%}
.scb-sheet{position:absolute;left:0;top:0;transform:translate(-50%,-50%);
  transform-style:preserve-3d}
.scb-shadow{position:absolute;left:0;top:0;transform:translate(-50%,-50%) translateZ(-1px);
  border-radius:1px;opacity:0;transition:opacity 180ms linear;
  box-shadow:0 2px 0 rgba(0,0,0,0.35),0 24px 60px rgba(0,0,0,0.75)}
.scb-root[data-cheap="1"] .scb-shadow{box-shadow:0 2px 0 rgba(0,0,0,0.35),0 10px 22px rgba(0,0,0,0.6)}
.scb-leaf{position:absolute;top:0;height:100%;transform-style:preserve-3d;
  will-change:transform}
.scb-face{position:absolute;left:0;top:0;width:100%;height:100%;display:block;
  backface-visibility:hidden}
.scb-back{position:absolute;left:0;top:0;width:100%;height:100%;
  transform:rotateY(180deg);backface-visibility:hidden;background:#e9e4d6;
  background-image:linear-gradient(90deg,rgba(0,0,0,0.10),rgba(0,0,0,0) 18%,
    rgba(255,255,255,0.06) 50%,rgba(0,0,0,0) 82%,rgba(0,0,0,0.10))}
.scb-shade{position:absolute;left:0;top:0;width:100%;height:100%;opacity:0;
  transition:opacity 180ms linear;mix-blend-mode:multiply;pointer-events:none}
.scb-leaf--l .scb-shade{background:linear-gradient(90deg,rgba(96,92,78,0) 0%,
  rgba(96,92,78,0.14) 46%,rgba(72,68,56,0.46) 100%)}
.scb-leaf--r .scb-shade{background:linear-gradient(270deg,rgba(96,92,78,0) 0%,
  rgba(96,92,78,0.14) 46%,rgba(72,68,56,0.46) 100%)}
.scb-leaf--c .scb-shade{background:linear-gradient(90deg,rgba(72,68,56,0.28) 0%,
  rgba(96,92,78,0) 22%,rgba(96,92,78,0) 78%,rgba(72,68,56,0.28) 100%)}
.scb-fuse{position:absolute;right:0;bottom:0;width:0.9%;height:0%;
  background:#d92b2b;opacity:0;transition:opacity 120ms linear}
.scb-fuse::after{content:"";position:absolute;left:0;right:0;top:-2px;height:2px;background:#16181a}
`;

/**
 * THE FOLD-OUT INSTRUCTION MANUAL.
 *
 * @see the module header for the full contract.
 */
export class BlueprintUI {
  constructor(ctx) {
    this.ctx = ctx ?? null;
    this.bus = ctx?.bus ?? null;
    this.settings = ctx?.settings ?? null;
    this.state = ctx?.state ?? null;

    /** 'closed' | 'wipe' | 'unfold' | 'open' | 'closing' */
    this._phase = 'closed';
    this._t = 0;                 // ms into the current phase
    this._pageIndex = 0;
    this._pendingIndex = 0;
    this._disposed = false;
    this._enabled = true;

    // --- the light. Public, and Campers reads it exactly like Flashlight.illumination.
    this.illumination = 0;
    this._lightTarget = 0;
    this.light = null;           // THREE.SpotLight | null
    this.lights = [];            // TODO(api): VolumetricFog gathers locals from Props/CabinSite/
                                 // Campers only. When it learns to read BlueprintUI.lights, the
                                 // page will light the mist within 1.5 m per ART §13.8.
    this._lightTarget3 = null;

    // --- annotations
    /** @type {Map<string, object>} slotId -> mark */
    this._marks = new Map();
    this._marksDirty = false;
    this._anchorsUsed = 0;

    // --- DOM
    this.root = null;
    this._style = null;
    this._leaves = [];           // [{ el, canvas, ctx, shade, back, x0, x1 }]
    this._shadow = null;
    this._fuse = null;
    this._fold = null;
    this._sheet = null;

    // --- canvases
    this._art = null;            // Blueprint's (or the fallback's) page, opaque
    this._composite = null;      // the page + paper furniture, transparent outside the sheet
    this._master = null;         // composite + annotations, sliced to the leaves
    this._artCache = new Map();  // index -> canvas. STORY §3.4 caps this at 3.
    this._fibre = null;

    // --- geometry
    this._sheetW = 0;
    this._sheetH = 0;
    this._pxScale = 1;
    this._pageScale = 1;         // device px per page unit
    this._bakedFor = -1;
    this._bakedW = 0;

    // --- integration
    this._unsubs = [];
    this._timers = [];
    this._raf = 0;
    this._externalSync = false;
    this._playerSpeedApplied = 0;
    this._playerSpeedBase = 1;
    this._playerHook = null;
    this._fuseFrac = 0;
    this._fuseShown = -1;
    this._pollT = 0;
    this._endingDiagonal = 0;    // 0..1, Ending A's one red mark
    this._endingActive = false;

    this._seed = 0x51a5cab;
    try { this._seed = (this.settings?.get?.('seed') ?? ctx?.rand?.seed ?? 0x51a5cab) | 0; } catch { /* default */ }
    this._rand = new Rand(hashInt(this._seed ^ 0xb1ce));
  }

  /* ── lifecycle ─────────────────────────────────────────────────────────────────────── */

  async init() {
    if (this._disposed) return;
    try {
      this._injectCss();
      this._buildDom();
      this._layout();
      this._buildLight();
      this._bindEvents();
      this._fibre = bakeFibreTile(this._rand);
      Log.debug('BlueprintUI ready.');
    } catch (e) {
      // A manual that cannot draw must still not take the game down.
      Log.once('bpui:init', 'BlueprintUI: init failed — the manual will be inert.', e);
    }
  }

  _injectCss() {
    const doc = globalThis.document;
    if (!doc?.head) return;
    const s = doc.createElement('style');
    s.dataset.owner = 'BlueprintUI';
    s.textContent = CSS;
    doc.head.appendChild(s);
    this._style = s;
  }

  _buildDom() {
    const doc = globalThis.document;
    if (!doc?.body) return;
    const mount = this.ctx?.canvas?.parentElement ?? doc.body;

    const root = doc.createElement('div');
    root.className = 'scb-root';
    root.dataset.vis = '0';
    if ((this.settings?.get?.('quality') ?? 'ultra') === 'low') root.dataset.cheap = '1';

    const fold = doc.createElement('div');
    fold.className = 'scb-fold';

    const shadow = doc.createElement('div');
    shadow.className = 'scb-shadow';

    const sheet = doc.createElement('div');
    sheet.className = 'scb-sheet';

    const names = ['l', 'c', 'r'];
    for (let i = 0; i < 3; i++) {
      const leaf = doc.createElement('div');
      leaf.className = `scb-leaf scb-leaf--${names[i]}`;
      const canvas = doc.createElement('canvas');
      canvas.className = 'scb-face';
      leaf.appendChild(canvas);
      if (i !== 1) {
        const back = doc.createElement('div');
        back.className = 'scb-back';
        leaf.appendChild(back);
      }
      const shade = doc.createElement('div');
      shade.className = 'scb-shade';
      leaf.appendChild(shade);
      sheet.appendChild(leaf);
      this._leaves.push({
        el: leaf, canvas, shade,
        ctx: canvas.getContext('2d', { alpha: true, desynchronized: true }),
        x0: 0, x1: 0,
      });
    }

    const fuse = doc.createElement('div');
    fuse.className = 'scb-fuse';
    this._leaves[2].el.appendChild(fuse);

    fold.appendChild(shadow);
    fold.appendChild(sheet);
    root.appendChild(fold);
    mount.appendChild(root);

    this.root = root;
    this._fold = fold;
    this._sheet = sheet;
    this._shadow = shadow;
    this._fuse = fuse;
  }

  /**
   * ART §13.8 — the page bounce. A shadowless SpotLight parented to the camera, 0.40 m in front
   * and aimed forward-and-down 22°, range 2.2 m.
   *
   * It is added ONCE, at init, and never made invisible: Three recompiles every material's program
   * when the scene's light count changes, so toggling `visible` here would hitch the frame every
   * single time the player opened the manual. Instead the intensity rides from 0, which is free.
   */
  _buildLight() {
    const scene = this.ctx?.scene;
    const cam = this.ctx?.camera;
    if (!scene || !cam) return;
    // At `low` the page still lights the player as a NUMBER (Campers reads `illumination`); it
    // just does not cost a fourth forward light on every fragment.
    if ((this.settings?.get?.('quality') ?? 'ultra') === 'low') return;

    const l = new THREE.SpotLight(PAGE_LIGHT.colour, 0, PAGE_LIGHT.distance,
      PAGE_LIGHT.angle, PAGE_LIGHT.penumbra, PAGE_LIGHT.decay);
    l.name = 'blueprint-page-bounce';
    l.castShadow = false;
    l.position.set(0, 0, -PAGE_LIGHT.forward);
    const target = new THREE.Object3D();
    // Forward and down 22°, in camera space. -Z is forward.
    target.position.set(0, -Math.tan(PAGE_LIGHT.pitchDeg * DEG) * 2, -2 - PAGE_LIGHT.forward);
    l.target = target;
    cam.add(l);
    cam.add(target);
    this.light = l;
    this._lightTarget3 = target;
    this.lights.length = 0;
    this.lights.push(l);
  }

  _bindEvents() {
    const b = this.bus;
    if (!b?.on) return;
    const keep = (fn) => { if (typeof fn === 'function') this._unsubs.push(fn); };

    // Somebody else (HUD, a menu, a story beat) may drive the manual. Follow without re-emitting.
    keep(b.on('ui:blueprint-open', () => {
      if (this._phase === 'closed' || this._phase === 'closing') {
        this._externalSync = true;
        this.open();
        this._externalSync = false;
      }
    }));
    keep(b.on('ui:blueprint-close', () => {
      if (this._phase !== 'closed' && this._phase !== 'closing') {
        this._externalSync = true;
        this.close();
        this._externalSync = false;
      }
    }));

    keep(b.on('night:begin', (p) => this._onNightBegin(p)));
    keep(b.on('night:complete', () => this._onNightEnd()));
    keep(b.on('night:failed', () => this._onNightEnd()));
    keep(b.on('game:pause', () => { this._enabled = false; if (this._phase !== 'closed') this.close(); }));
    keep(b.on('game:resume', () => { this._enabled = true; }));

    // The annotation layer. Every one of these is a mistake becoming a mark.
    keep(b.on('build:place', (p) => {
      if (p && p.correct === false) this.annotate(p.slot?.id ?? p.slot);
      else if (p?.slot) this.annotate(p.slot?.id ?? p.slot);   // a correct place clears to a ✓
    }));
    keep(b.on('build:remove', (p) => this._dropMark(p?.slot?.id ?? p?.slot)));
    keep(b.on('build:creak', (p) => this._onCreak(p)));
    keep(b.on('tool:missing', (p) => this._onToolMissing(p)));
    keep(b.on('tool:found', (p) => this._onToolFound(p)));
    keep(b.on('build:stage-complete', () => { this._marksDirty = true; }));

    keep(b.on('story:beat', (p) => this._onBeat(p)));
    keep(b.on('settings:changed', (p) => this._onSettings(p)));

    // Page turns on keys Input does not name as actions. `input:key` is canonical and public, so
    // this never reaches into Input's private sets.
    keep(b.on('input:key', (p) => {
      if (!p?.down || this._phase === 'closed' || this._phase === 'closing') return;
      if (p.code === 'ArrowRight' || p.code === 'BracketRight') this.nextPanel();
      else if (p.code === 'ArrowLeft' || p.code === 'BracketLeft') this.prevPanel();
      else if (p.code === 'Escape') this.close();
    }));
  }

  /* ── the public verbs ──────────────────────────────────────────────────────────────── */

  get isOpen() { return this._phase !== 'closed' && this._phase !== 'closing'; }
  get isAnimating() { return this._phase === 'unfold' || this._phase === 'closing'; }
  /** True during GAME_DESIGN §4.4's mandatory lockout. The page is not drawing yet. */
  get isWiping() { return this._phase === 'wipe'; }
  /** 0..1 — the bounce light on his face. Campers reads this like `Flashlight.illumination`. */
  get lightLevel() { return this.illumination; }
  /** The page's addition to GAME_DESIGN §9.2's `lum`. See LUM_BONUS for the derivation. */
  get lumBonus() { return this.illumination * LUM_BONUS; }
  /** Both hands are on the paper. Nothing can be carried, placed, or swung while this is true. */
  get handsOccupied() { return this._phase !== 'closed'; }
  /** Multiply the player's walk speed by this. 1.0 when closed. */
  get speedMultiplier() { return this._phase === 'closed' ? 1 : READ_SPEED_MUL; }
  get annotationCount() { return this._marks.size; }

  /**
   * Open the manual. Emits `ui:blueprint-open` immediately — Player starts the hand-wipe,
   * Postprocessing drops exposure, Music and the ambience duck — and then does nothing at all for
   * 900 ms, because GAME_DESIGN §4.4 says the wipe is never skippable, not by setting, not by
   * difficulty, not on Night Seven. The bake happens inside that window, which is the one piece of
   * engineering luck in this whole file.
   */
  open() {
    if (this._disposed || !this._enabled) return false;
    if (this._phase !== 'closed' && this._phase !== 'closing') return false;
    this._phase = 'wipe';
    this._t = 0;
    this._pendingIndex = this._pageIndex;
    if (!this._externalSync) this.bus?.emit('ui:blueprint-open', {});
    // The bake, hidden entirely inside the wipe.
    try { this._bake(this._pageIndex); } catch (e) { Log.once('bpui:bake', 'BlueprintUI: bake failed.', e); }
    this._setPose('closed', 0);
    if (this.root) this.root.dataset.vis = '0';
    return true;
  }

  /** Fold it away. Faster than it opened — ART §13.8 is specific about the asymmetry. */
  close() {
    if (this._disposed) return false;
    if (this._phase === 'closed') return false;
    const wasVisible = this._phase === 'unfold' || this._phase === 'open';
    this._phase = 'closing';
    this._t = 0;
    this._lightTarget = 0;
    if (!this._externalSync) this.bus?.emit('ui:blueprint-close', {});
    if (wasVisible) {
      this._setPose('closed', this._reducedMotion() ? 200 : CLOSE_MS);
      this.bus?.emit('audio:sfx', { id: 'ui.page', volume: 0.85, rate: 1.12 });
    } else {
      // Cancelled during the wipe. Nothing was ever drawn; nothing needs to fold.
      this._phase = 'closed';
      if (this.root) this.root.dataset.vis = '0';
    }
    return true;
  }

  toggle() { return this.isOpen ? this.close() : this.open(); }

  get panelCount() {
    const bp = this._blueprint();
    if (bp && bp.panelCount > 0) return bp.panelCount;
    return FALLBACK_PAGES[clamp(this._night(), 1, 7)] ?? 3;
  }

  get currentPanelIndex() { return this._pageIndex; }

  /**
   * The panel object, with the same shape and meaning as `Blueprint.currentPanel`, so a consumer
   * can read either system without branching. Null when `Blueprint` is not in the build.
   */
  get currentPanel() {
    const bp = this._blueprint();
    if (!bp) return null;
    try { return bp.def?.panels?.[this._pageIndex] ?? bp.currentPanel ?? null; } catch { return null; }
  }

  nextPanel() { return this.setPanel(this._pageIndex + 1); }
  prevPanel() { return this.setPanel(this._pageIndex - 1); }

  /** @param {number|string} i index, or a panel id when Blueprint is present. */
  setPanel(i) {
    const n = this.panelCount;
    let idx = i;
    if (typeof i === 'string') {
      const bp = this._blueprint();
      const k = bp?.def?.panels?.findIndex?.((p) => p.id === i) ?? -1;
      idx = k >= 0 ? k : this._pageIndex;
    }
    idx = clamp(Math.round(Number(idx) || 0), 0, Math.max(0, n - 1));
    if (idx === this._pageIndex) {
      // The page refuses to turn past the end, and says so with the one refusal sound the UI owns.
      if (this.isOpen && n > 0) this.bus?.emit('audio:sfx', { id: 'ui.deny', volume: 0.6 });
      return this._pageIndex;
    }
    this._pageIndex = idx;
    // Keep Blueprint's own cursor in step — other systems read `Blueprint.currentPanel`.
    try { this._blueprint()?.setPanel?.(idx); } catch { /* degrade */ }
    if (this.isOpen) {
      try { this._bake(idx); } catch (e) { Log.once('bpui:rebake', 'BlueprintUI: page turn bake failed.', e); }
      // GAME_DESIGN §11 t=3:50 — the manual turns its own page, with a paper sound.
      this.bus?.emit('audio:sfx', { id: 'ui.page', volume: 1, rate: 0.96 + this._rand.next() * 0.08 });
    }
    return this._pageIndex;
  }

  /* ── the annotation layer ──────────────────────────────────────────────────────────── */

  /**
   * Ask `BuildSystem` what is wrong with a join and put a mark on the page about it. Numbers and
   * glyphs only. If BuildSystem is absent, or the slot is unknown, this is a silent no-op — the
   * manual simply has nothing to say, which is in character.
   *
   * @param {string} slotId
   * @param {string} [glyph] force a specific glyph from the closed set
   */
  annotate(slotId, glyph) {
    if (!slotId || this._disposed) return null;
    const bs = this.ctx?.systems?.get?.('BuildSystem');
    let d = null;
    try { d = bs?.inspect?.(slotId) ?? null; } catch (e) { Log.once('bpui:inspect', 'BlueprintUI: BuildSystem.inspect threw.', e); }
    const mark = markFromDiagnosis(d) ?? { slotId, glyph: glyph ?? 'red-slash-circle', creaks: 0, severity: 0 };
    if (glyph) mark.glyph = glyph;

    const prev = this._marks.get(slotId);
    if (prev) {
      mark.ax = prev.ax; mark.ay = prev.ay;
      mark.creaks = prev.creaks;
      mark.silhouette = prev.silhouette;
    } else {
      // A join that is simply correct never earns a mark in the first place. The manual does not
      // congratulate you; it only ever notices what went wrong.
      if (mark.correct && mark.glyph === 'tick') return null;
      const a = ANCHORS[this._anchorsUsed % ANCHORS.length];
      this._anchorsUsed++;
      mark.ax = a[0]; mark.ay = a[1];
      mark.silhouette = hashStr(String(slotId)) & 3;
    }
    this._marks.set(slotId, mark);
    this._marksDirty = true;
    if (this._phase === 'open') this._stamp();
    return mark;
  }

  clearAnnotations() {
    this._marks.clear();
    this._anchorsUsed = 0;
    this._marksDirty = true;
    if (this.isOpen) this._composeAnnotations();
  }

  _dropMark(slotId) {
    if (!slotId) return;
    if (this._marks.delete(slotId)) {
      this._marksDirty = true;
      if (this.isOpen) this._composeAnnotations();
    }
  }

  /** A creak is a join talking. The page draws the sound as arcs off the joint. */
  _onCreak(p) {
    // `build:creak` carries a position and a severity, not a slot id, so the mark goes on whichever
    // join is currently the worst one the manual already knows about — which is almost always the
    // one that spoke. If it knows about none, it stays quiet.
    let worst = null;
    for (const m of this._marks.values()) {
      if (!worst || (m.severity ?? 0) < (p?.severity ?? 0)) { worst = m; break; }
    }
    if (!worst) return;
    worst.creaks = (worst.creaks | 0) + 1;
    worst.severity = Math.max(worst.severity ?? 0, clamp01(p?.severity ?? 0.4));
    this._marksDirty = true;
    if (this._phase === 'open') this._composeAnnotations();
  }

  /** A shortfall. The callout shows a silhouette from the site where the thing actually is. */
  _onToolMissing(p) {
    const id = p?.toolId;
    if (!id) return;
    const key = `tool:${id}`;
    if (this._marks.has(key)) return;
    const a = ANCHORS[this._anchorsUsed % ANCHORS.length];
    this._anchorsUsed++;
    this._marks.set(key, {
      slotId: key, glyph: 'magnifier', ax: a[0], ay: a[1],
      silhouette: hashStr(String(id)) & 3, creaks: 0, severity: 0,
    });
    this._marksDirty = true;
    if (this._phase === 'open') this._stamp();
  }

  /** Found. The red outline is redrawn in black with a tick, and nothing else is said. */
  _onToolFound(p) {
    const m = this._marks.get(`tool:${p?.toolId}`);
    if (!m) return;
    m.glyph = 'tick';
    this._marksDirty = true;
    if (this._phase === 'open') this._composeAnnotations();
  }

  _stamp() {
    this._composeAnnotations();
    this.bus?.emit('audio:sfx', { id: 'ui.stamp', volume: 0.7 });
  }

  /* ── story beats ───────────────────────────────────────────────────────────────────── */

  _onBeat(p) {
    const id = p?.id;
    if (!id) return;
    if (id === 'ending_a') {
      // STORY §3.4: both states are baked; the redraw is a crossfade and a reveal along the
      // diagonal's own stroke path. The only red mark ever aimed at the player, and the only
      // judgement the manual has ever passed.
      this._endingActive = true;
      this._endingDiagonal = 0;
      this._marksDirty = true;
    } else if (id === 'errata_found' || id === 'n6_errata') {
      this._marksDirty = true;
    }
  }

  _onSettings(p) {
    const k = p?.key;
    if (k === '*' || k === 'colorblind' || k === 'manualContrast' || k === 'quality' || k === 'reducedMotion') {
      this._artCache.clear();
      this._bakedFor = -1;
      if (this.isOpen) { try { this._bake(this._pageIndex); } catch { /* degrade */ } }
    }
  }

  _onNightBegin(p) {
    this._pageIndex = 0;
    this._pendingIndex = 0;
    this._marks.clear();
    this._anchorsUsed = 0;
    this._marksDirty = true;
    this._endingActive = false;
    this._endingDiagonal = 0;
    this._artCache.clear();
    this._bakedFor = -1;
    void p;
  }

  _onNightEnd() {
    if (this.isOpen) this.close();
    this._artCache.clear();
    this._bakedFor = -1;
  }

}

export default BlueprintUI;
