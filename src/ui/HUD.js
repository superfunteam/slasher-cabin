/**
 * HUD.js — THE DOM OVERLAY
 * ========================
 *
 * OWNER: UI agent. Implements `ARCHITECTURE.md` §5 (canonical events), `ART_DIRECTION.md` §13.8
 * (how the HUD sits over the world), §18 (colour deficiency), `GAME_DESIGN.md` §9.3 (the detection
 * meter's published behaviour), §7.5 (the thunder window), §12.8 (Night Seven strips the HUD),
 * §16.3 (accessibility captions), and `STORY.md` §3 (the manual's wordless grammar).
 *
 * ---------------------------------------------------------------------------------------------
 * THE BRIEF, IN ONE LINE
 *
 * The manual is the real UI. This file's job is to almost not exist.
 *
 * `ART_DIRECTION.md` §13.8 is unambiguous and it is the law here: no crosshair, no health bar, no
 * stamina ring, no compass, no objective marker, no minimap, no part counter. The reticle is a dot.
 * Everything that survived that cull did so because a player who cannot see it dies unfairly:
 *
 *   RETICLE          — you cannot know what a verb will do to an object you are looking at.
 *   PROMPT           — the *key*, once, as a pictogram. Not a sentence, not a tutorial.
 *   CARRY            — a 62 kg beam changes your speed, your turn rate and your footsteps
 *                      (`GAME_DESIGN.md` §6.2) and the world does not draw your own arms.
 *   DETECTION        — `GAME_DESIGN.md` §9.3 requires "a faint directional smear at screen edge
 *                      (`HUD`), 8% opacity. No icon, no number." That is a published contract.
 *   NOISE            — `noise:emit` is the game's nervous system and it is inaudible to the player
 *                      as a *radius*. One ring per significant noise is how loudness gets learned.
 *   MASK WINDOW      — `GAME_DESIGN.md` §7.5: "a mechanic the player cannot see coming is not a
 *                      mechanic." The window is telegraphed by contract.
 *   SUBTITLES        — camper chatter only. There is nothing else to subtitle.
 *   TOASTS           — `text` is always the empty string. A toast is a glyph on a piece of paper.
 *
 * ---------------------------------------------------------------------------------------------
 * FOUR RULES THIS FILE DOES NOT BREAK
 *
 * 1. NO HUE CARRIES INFORMATION. Every state in the detection meter is separated by *topology* —
 *    one arc, two arcs, two arcs plus a radial notch, a closed ring — and by arc *length*, which
 *    shortens as attention narrows. The warm-white → amber drift is decoration. `settings.colorblind`
 *    changes the one accent per `ART_DIRECTION.md` §18.1 (`#d92b2b` → `#a81d1d`) and nothing else,
 *    because nothing else needs it.
 * 2. NO GLOW, NO CYAN, NO DROP SHADOW ON TEXT. Diegetic UI is ink `#16181a` on paper `#f2efe6`.
 *    Everything that must sit over the dark world is low-alpha warm white `#e9e3d6`. Subtitles get
 *    a soft scrim behind the *lane*, never a shadow on the *glyphs* — a shadow on 1984 type is a
 *    2015 game telling you it is a game.
 * 3. GETTING SPOTTED IS NOT A PHOTOMETRIC EVENT (`ART_DIRECTION.md` §9.5). Nothing here flashes,
 *    zooms, tints or shakes. The arc closes. That is all it does, and it is worse.
 * 4. THE MANUAL DOES NOT PAUSE THE WORLD (`STORY.md` §2.4.1). While the blueprint is open the
 *    reticle, prompt and carry indicator go away and **the detection arc and the mask ring stay**.
 *    You are reading a piece of paper with your back to a forest.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IT READS, ALL OPTIONALLY, ALL NULL-CHECKED
 *
 *   BuildSystem   heldPart heldParts targetSlot ghostValid seating repairIntent action
 *                 carryClass carryMass available slots nightSlots maskWindowRemaining nextStrikeIn
 *   Player        eyePosition position stamina carryClass isCrouching fear
 *   NoiseSystem   maskWindowRemaining maskWindowIncoming maskLevel audibleRadius()
 *   Campers       campers|agents|getAll() → { id, position, detection }   (TODO(api), see below)
 *   Input         wasPressed('blueprint')
 *
 * TODO(api): `Campers.js` is a stub at time of writing. The detection meter therefore has two
 * paths: a *live* path that reads a per-camper `detection` scalar and world position, and an
 * *event* path driven purely by `player:spotted` / `player:hidden` plus `ctx.state.suspicion`.
 * The event path is what runs today and it degrades to an omnidirectional ring when no position
 * is available. Whichever accessor `Campers` eventually publishes — `campers`, `agents`,
 * `getAll()` — and whichever of `detection` / `detectionLevel` / `awareness` / `notice` it names
 * the scalar, this file already probes for it. Nothing needs to change here.
 *
 * ---------------------------------------------------------------------------------------------
 * PERFORMANCE
 *
 * `update()` allocates nothing on a steady frame. Every DOM write goes through `styleNum` /
 * `attrNum` / `setText`, which memoise the last written value on the node itself and quantise
 * before comparing, so a frame in which nothing perceptibly changed performs zero writes and
 * builds zero strings. The interaction-target scan is throttled to 20 Hz. All SVG nodes, subtitle
 * lines, toast cards and noise rings are pooled at `init()` and never created again.
 *
 * PUBLIC API
 *   new HUD(ctx); await init(); update(dt, elapsed); resize(w, h); dispose();
 *   toast(text, opts)                  opts: { icon, ms }  — icon-only is the normal case
 *   subtitle(text, speaker, ms)
 *   setPrompt(text, key, opts)         text may be a pictogram id; null clears
 *   setDetection(level, opts)          opts: { position, bearing, source, spotted }
 *   show() / hide()
 *   setStripped(on)                    Night Seven (`GAME_DESIGN.md` §12.8)
 *   noteNoise(intensity, metres, opts) manual hook for the ring, if anything wants it
 */

import * as THREE from 'three';
import { Log } from '../core/Log.js';
import { BINDINGS } from '../core/Input.js';

// =================================================================================================
// PALETTE — ART_DIRECTION.md §2, §13.1, §18.1. Nothing outside this block picks a colour.
// =================================================================================================

const C = {
  ink: '#16181a',            // the manual's line art (brief); §13.1 prints #14181a — 2 units apart
  paper: '#f2efe6',          // bone. Never #ffffff
  accent: '#d92b2b',         // manual red. The ONLY saturated colour in this file
  accentCvd: '#a81d1d',      // §18.1: hold the hue, separate by luminance
  warm: '233, 227, 214',     // #e9e3d6 — warm white, the over-the-world ink. Always via rgba()
  attention: '255, 214, 168',// #ffd6a8 — the amber the detection arc drifts toward. Decorative
  subtitle: '242, 239, 230', // subtitles are paper-coloured, not pure white
};

// =================================================================================================
// GEOMETRY — everything is derived from the viewport so the HUD is resolution independent.
// =================================================================================================

const G = {
  ringR: 0.455,              // × min(w, h) — the detection ring
  maskROffset: 15,           // px outside the detection ring
  reticleBox: 44,            // px viewBox of the reticle SVG
  arcWidth: {                // ° of arc, per detection stage. It SHORTENS as attention narrows.
    forming: 118, building: 74, critical: 44, spotted: 360,
  },
  arcStroke: { forming: 1.6, building: 2.4, critical: 3.4, spotted: 4.2 },
  arcAlpha: { forming: 0.10, building: 0.24, critical: 0.42, spotted: 0.66 },
  noiseLife: 0.62,           // s
  noiseMaxMetres: 90,        // the Night Three saw. Maps to the screen edge exactly.
  promptFadeMs: 130,
};

/** `GAME_DESIGN.md` §9.3's published thresholds. Do not re-tune here; re-tune there. */
const DETECT = { forming: 0.01, building: 0.35, critical: 0.75, spotted: 1.0 };

/** §9.3 decay, for the event-driven fallback path only. The live path reads the truth. */
const DECAY_FAST = 0.45, DECAY_SLOW = 0.25;

const SVG_NS = 'http://www.w3.org/2000/svg';
const TAU = Math.PI * 2;

// Scratch. Module scope, per ARCHITECTURE.md §12.
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// =================================================================================================
// DOM / SVG micro-helpers. Every one of these memoises so `update()` writes nothing on a still
// frame — see the PERFORMANCE note in the header.
// =================================================================================================

function el(tag, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

function svg(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

/** Memoised numeric style write. `q` is the quantiser: 1000 = three decimals. */
function styleNum(node, prop, value, q = 1000) {
  const m = node.__hud || (node.__hud = {});
  const v = Math.round(value * q) / q;
  if (m[prop] === v) return;
  m[prop] = v;
  node.style[prop] = v;
}

/** Memoised numeric attribute write. */
function attrNum(node, name, value, q = 100) {
  const m = node.__hud || (node.__hud = {});
  const v = Math.round(value * q) / q;
  if (m[name] === v) return;
  m[name] = v;
  node.setAttribute(name, v);
}

/** Memoised string style write. */
function styleStr(node, prop, value) {
  const m = node.__hud || (node.__hud = {});
  if (m[prop] === value) return;
  m[prop] = value;
  node.style[prop] = value;
}

/** Memoised string attribute write. */
function attrStr(node, name, value) {
  const m = node.__hud || (node.__hud = {});
  if (m[name] === value) return;
  m[name] = value;
  node.setAttribute(name, value);
}

function setText(node, value) {
  const m = node.__hud || (node.__hud = {});
  if (m.txt === value) return;
  m.txt = value;
  node.textContent = value;
}

/**
 * Position a segment on a `pathLength="1000"` circle.
 * An SVG circle starts at 3 o'clock and runs clockwise, so 12 o'clock is at 750.
 * `centreDeg` is measured clockwise from 12 o'clock — i.e. it is a screen bearing.
 */
function setArc(node, centreDeg, widthDeg, dashCache) {
  const len = clamp(widthDeg, 0, 360) / 360 * 1000;
  const start = ((750 + (centreDeg / 360) * 1000 - len / 2) % 1000 + 1000) % 1000;
  const m = node.__hud || (node.__hud = {});
  const qLen = Math.round(len * 4) / 4;
  if (m.arcLen !== qLen) {
    m.arcLen = qLen;
    // One string per quantised length change — never on a steady frame.
    node.style.strokeDasharray = qLen >= 999.5 ? 'none' : `${qLen} ${1000 - qLen}`;
  }
  const qOff = Math.round(start * 2) / 2;
  if (m.arcOff !== qOff) {
    m.arcOff = qOff;
    node.style.strokeDashoffset = -qOff;
  }
  return dashCache;
}

/** Deterministic 0..1 from a string. FNV-1a — no unseeded RNG anywhere (ARCHITECTURE.md §6). */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 8) & 0xffff) / 0xffff;
}

/** An Archimedean spiral, for the manual's spiral-torque arrow (§13.4). Built once, at load. */
function spiralPath(cx, cy, r0, r1, turns, steps) {
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = -Math.PI / 2 + t * turns * TAU;
    const r = r0 + (r1 - r0) * t;
    d += (i === 0 ? 'M' : 'L') + (cx + Math.cos(a) * r).toFixed(2) + ' ' + (cy + Math.sin(a) * r).toFixed(2) + ' ';
  }
  return d.trim();
}

// =================================================================================================
// THE PICTOGRAM VOCABULARY
//
// ART_DIRECTION.md §13.4 defines a CLOSED arrow set and forbids inventing more. Everything below
// is built from it: straight insert, curved rotate, spiral torque, ghost trail, double-headed
// span, magnifier, ✗, ✓. Weights are §13.2's four, scaled from the 900 px page to a 40 px box:
// hairline 0.75 → 0.55, thin 1.5 → 1.1, medium 2.5 → 1.8, heavy 4.0 → 2.6.
//
// Each entry is a list of [d, weight, filled]. viewBox is 0 0 40 40 for every one of them.
// =================================================================================================

const W = { hair: 0.55, thin: 1.1, med: 1.8, heavy: 2.6 };

const SPIRAL = spiralPath(20, 21, 2.2, 10.5, 1.75, 44);

const PICTO = {
  // --- verbs on a part -------------------------------------------------------------------------
  // GRAB: the straight-insert arrow, reversed. A thing leaves the ground.
  grab: [
    ['M5 33 H35', W.thin],
    ['M13 22 H27 V30 H13 Z', W.thin],
    ['M20 20 V12', W.heavy],
    ['M20 5 l4.6 8 h-9.2 z', W.heavy, 1],
  ],
  // PLACE: the straight insert. A thing enters a dimetric slot.
  place: [
    ['M9 31 l6 -4 h16 l-6 4 z', W.thin],
    ['M11 33.5 l6 -4 h16', W.hair],
    ['M20 8 V21', W.heavy],
    ['M20 26 l-4.6 -8 h9.2 z', W.heavy, 1],
  ],
  // ROTATE: the curved-rotate arrow. 270°, one head.
  rotate: [
    ['M27.78 12.22 A11 11 0 1 1 12.22 12.22', W.heavy],
    ['M14.9 9.4 L14.5 14.6 L9.8 9.9 Z', W.heavy, 1],
  ],
  // TIGHTEN: the spiral torque arrow. Turn count IS the value (§13.4) — 1.75 turns.
  tighten: [
    [SPIRAL, W.heavy],
    ['M25.6 17.4 l5.6 3.1 l-5.4 3.4 z', W.heavy, 1],
  ],
  // PULL: the county survey stake (STORY §1.4). Out of the ground, silently.
  pull: [
    ['M5 33 H35', W.thin],
    ['M20 33 V22', W.thin],
    ['M20 24 l6 -2.4 v3 l-6 2.4 z', W.thin],
    ['M20 19 V11', W.heavy],
    ['M20 5 l4.6 8 h-9.2 z', W.heavy, 1],
  ],
  // DROP: down, and it lands. Three impact ticks.
  drop: [
    ['M20 6 V21', W.heavy],
    ['M20 26 l-4.6 -8 h9.2 z', W.heavy, 1],
    ['M6 32 H34', W.thin],
    ['M11 28 l-2.5 -3', W.thin], ['M20 27.5 V24', W.thin], ['M29 28 l2.5 -3', W.thin],
  ],
  // SET DOWN: the same arrow onto a heavy floor, and nothing happens. That is the whole verb.
  setdown: [
    ['M20 6 V21', W.heavy],
    ['M20 26 l-4.6 -8 h9.2 z', W.heavy, 1],
    ['M6 32 H34', W.med],
    ['M9 35.5 H31', W.hair],
  ],
  // SAW: a toothed line under a double-headed span. It is loud and it dulls.
  saw: [
    ['M6 16 H34', W.thin],
    ['M6 20 l3 3 l3 -3 l3 3 l3 -3 l3 3 l3 -3 l3 3 l3 -3 l3 3 l3 -3', W.thin],
    ['M6 30 H34', W.hair],
    ['M6 27.5 V32.5', W.hair], ['M34 27.5 V32.5', W.hair],
  ],
  // REMOVE a join: the ghost-trail dashed path back out.
  remove: [
    ['M9 30 l6 -4 h16 l-6 4 z', W.thin],
    ['M20 24 V12', W.heavy],
    ['M20 6 l4.6 8 h-9.2 z', W.heavy, 1],
    ['M26 24 q7 -5 7 -13', W.hair, 0, '3 2.5'],
  ],
  // SHIM: a wedge under a thing (§7.4).
  shim: [
    ['M7 20 h26 v4 H7 Z', W.thin],
    ['M7 28 L33 24.5 V28 Z', W.med],
    ['M20 12 V17', W.heavy],
    ['M20 19.5 l-3.4 -6 h6.8 z', W.heavy, 1],
  ],
  // TALLOW: the pot, and the curved-rotate arrow over it.
  tallow: [
    ['M13 20 h14 v11 h-14 z', W.thin],
    ['M11 20 h18', W.med],
    ['M13.5 15.5 a6.5 6.5 0 0 1 13 0', W.thin],
  ],
  // FELT: a square, hatched.
  felt: [
    ['M10 12 h20 v20 h-20 z', W.thin],
    ['M10 18 h20', W.hair], ['M10 24 h20', W.hair], ['M10 30 h20', W.hair],
  ],
  // FASTEN: the parts bag, and the count that is never enough.
  fasten: [
    ['M13 15 h14 l3 17 h-20 z', W.thin],
    ['M17 15 v-3 h6 v3', W.thin],
    ['M17 22 h6', W.hair], ['M17 26 h6', W.hair],
  ],
  // PROVOKE: the motion-ticks glyph. A noise, made on purpose, somewhere else.
  provoke: [
    ['M14 20 h-4', W.med], ['M15.5 15 l-3.4 -2', W.med], ['M15.5 25 l-3.4 2', W.med],
    ['M20 14 a6 6 0 1 1 0 12 a6 6 0 1 1 0 -12', W.thin],
    ['M24 12 a11 11 0 0 1 0 16', W.hair, 0, '3 2.5'],
    ['M28 8 a16 16 0 0 1 0 24', W.hair, 0, '3 2.5'],
  ],
  // --- non-part verbs --------------------------------------------------------------------------
  // MANUAL: a folded page with two creases. It has been in a pocket.
  manual: [
    ['M11 8 h18 v24 h-18 z', W.thin],
    ['M17 8 V32', W.hair], ['M23 8 V32', W.hair],
    ['M11 8 l5 4', W.hair],
  ],
  lantern: [
    ['M14 18 h12 l2 13 h-16 z', W.thin],
    ['M14 18 a6 6 0 0 1 12 0', W.hair],
    ['M20 8 v4', W.thin],
    ['M17 22 h6 v6 h-6 z', W.med],
  ],
  // CROUCH: a dimension that got shorter. §13.4's double-headed span, doing its actual job.
  crouch: [
    ['M8 10 H32', W.thin],
    ['M8 32 H32', W.thin],
    ['M20 14 V26', W.heavy],
    ['M20 30 l-3.8 -6.5 h7.6 z', W.heavy, 1],
  ],
  // BLOCKED: the ✗. Two strokes at 90°, drawn over the panel (§13.4). Accent-coloured, but the
  // information is the topology — an ✗ is an ✗ in greyscale.
  blocked: [
    ['M11 11 L29 29', W.heavy, 0, null, 1],
    ['M29 11 L11 29', W.heavy, 0, null, 1],
  ],
  // --- toast glyphs (Script.js GLYPHS) ---------------------------------------------------------
  // The whole reward for finding a missing part, per GAME_DESIGN §6.9. It gets to be good.
  'checkbox-filled': [
    ['M9 9 h22 v22 h-22 z', W.med],
    ['M13.5 20.5 L18 26 L27 13.5', W.heavy],
  ],
  checkbox: [['M9 9 h22 v22 h-22 z', W.med]],
  tick: [['M10 21 L17 29 L31 10', W.heavy]],
  hand: [
    ['M14 30 v-9 a2 2 0 0 1 4 0 v-9 a2 2 0 0 1 4 0 v9 a2 2 0 0 1 4 0 v9', W.thin],
    ['M14 24 a4 4 0 0 0 -4 4 v2', W.thin],
    ['M10 30 q3 6 10 6 q10 0 10 -6', W.thin],
  ],
  sparkle: [
    ['M20 8 V32', W.thin], ['M8 20 H32', W.thin],
    ['M12 12 L28 28', W.hair], ['M28 12 L12 28', W.hair],
  ],
  telephone: [
    ['M12 13 a4 4 0 0 1 4 -4 h2 l2 6 l-3 2 a12 12 0 0 0 6 6 l2 -3 l6 2 v2 a4 4 0 0 1 -4 4 '
      + 'a15 15 0 0 1 -15 -15 z', W.thin],
  ],
  magnifier: [
    ['M17 17 m-8 0 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0', W.thin],
    ['M23 23 L32 32', W.med],
  ],
  'parts-bracket': [
    ['M13 10 h-4 v20 h4', W.thin],
    ['M27 10 h4 v20 h-4', W.thin],
    ['M20 16 v8', W.med],
  ],
};

/**
 * `BuildSystem.repairIntent` / verb id → pictogram id. Anything unmapped falls through to the
 * verb id itself, so a new verb only needs a pictogram, not a table entry.
 */
const VERB_PICTO = {
  pickup: 'grab', pick: 'grab', take: 'grab', grab: 'grab',
  place: 'place', seat: 'place', insert: 'place', install: 'place',
  rotate: 'rotate', turn: 'rotate',
  tighten: 'tighten', torque: 'tighten', seating: 'tighten',
  pull: 'pull', obstruction: 'pull', stake: 'pull',
  remove: 'remove', extract: 'remove',
  saw: 'saw', recut: 'saw', cut: 'saw',
  drop: 'drop', throw: 'drop',
  setdown: 'setdown', 'set-down': 'setdown',
  shim: 'shim', tallow: 'tallow', felt: 'felt',
  fasten: 'fasten', topup: 'fasten', 'top-up': 'fasten', fasteners: 'fasten',
  provoke: 'provoke',
  blueprint: 'manual', manual: 'manual',
  lantern: 'lantern', crouch: 'crouch', blocked: 'blocked',
};

/**
 * The carry indicator's line drawings. One per `PART_TYPES[*].type`, in dimetric, in the manual's
 * hand. viewBox 0 0 34 22. `thin` weight throughout — this is an object being depicted, not an
 * instruction being given, and §13.2 reserves `medium` for the part under discussion.
 */
const PART_GLYPH = {
  beam: ['M3 12 L7 9 H31 L27 12 Z', 'M3 12 H27 V16 H3 Z', 'M27 12 L31 9 V13 L27 16 Z'],
  joist: ['M3 11 L6 8 H31 L28 11 Z', 'M3 11 H28 V17 H3 Z', 'M28 11 L31 8 V14 L28 17 Z'],
  board: ['M3 12 L5 10 H31 L29 12 Z', 'M3 12 H29 V15 H3 Z', 'M29 12 L31 10 V13 L29 15 Z'],
  batten: ['M3 12 H30', 'M3 12 L5 10 H32', 'M3 14 H30'],
  post: ['M13 4 L17 2 H21 L17 4 Z', 'M13 4 H17 V20 H13 Z', 'M17 4 L21 2 V18 L17 20 Z'],
  truss: ['M3 18 H31 L17 4 Z', 'M17 4 V18', 'M10 11 L24 11'],
  ridge: ['M2 12 L6 9 H32 L28 12 Z', 'M2 12 H28 V16 H2 Z', 'M28 12 L32 9 V13 L28 16 Z', 'M24 9 L28 12'],
  panel: ['M4 7 L10 3 H30 L24 7 Z', 'M4 7 H24 V19 H4 Z', 'M24 7 L30 3 V15 L24 19 Z'],
  shingle: ['M5 16 H29 V19 H5 Z', 'M6 12 H28 V15 H6 Z', 'M7 8 H27 V11 H7 Z'],
  door: ['M10 3 H26 V20 H10 Z', 'M23 12 a1 1 0 1 0 0.1 0', 'M12 5 H24'],
  fitting: ['M9 8 H25 V19 H9 Z', 'M12 8 V5 H22 V8', 'M13 12 H21'],
  chair: ['M11 20 V11 H23 V20', 'M11 11 H23', 'M12 11 V3 H14 V11', 'M13 3 H22'],
  bracket: ['M9 4 V18 H26', 'M12 8 a1 1 0 1 0 0.1 0', 'M20 15 a1 1 0 1 0 0.1 0'],
  hinge: ['M8 6 H16 V18 H8 Z', 'M18 6 H26 V18 H18 Z', 'M16 8 a2 2 0 0 1 0 8 Z'],
  fastener: ['M12 8 h10 l3 12 h-16 z', 'M15 8 V5 H19 V8', 'M15 13 h4'],
  shim: ['M5 17 L29 12 V17 Z'],
  tallow: ['M12 10 h10 v9 h-10 z', 'M10 10 h14', 'M14 6 a3 3 0 0 1 6 0'],
  felt: ['M9 7 h16 v12 h-16 z', 'M9 11 h16', 'M9 15 h16'],
  pier: ['M6 19 L9 8 H25 L28 19 Z', 'M9 8 L12 5 H28 L25 8', 'M28 19 L28 8'],
  default: ['M9 7 h16 v12 h-16 z'],
};

/** Key-code → what to draw on the cap. `null` means "wide blank cap" (the space bar). */
const KEY_LABEL = {
  KeyA: 'A', KeyB: 'B', KeyC: 'C', KeyD: 'D', KeyE: 'E', KeyF: 'F', KeyG: 'G',
  KeyQ: 'Q', KeyR: 'R', KeyS: 'S', KeyT: 'T', KeyW: 'W',
  Tab: 'TAB', Escape: 'ESC', Space: null,
  ShiftLeft: 'SHIFT', ShiftRight: 'SHIFT', ControlLeft: 'CTRL', ControlRight: 'CTRL',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
};

/** Action → the label we print, resolved from `Input.BINDINGS` so a rebind follows. */
function labelForAction(action) {
  const codes = BINDINGS?.[action];
  if (!codes || !codes.length) return null;
  for (let i = 0; i < codes.length; i++) {
    if (Object.prototype.hasOwnProperty.call(KEY_LABEL, codes[i])) return KEY_LABEL[codes[i]];
  }
  return null;
}

// =================================================================================================
// STYLESHEET
//
// Scoped under #sc-hud so nothing here can reach the manual, the menu, or the canvas. One <style>
// node, written once at init, removed on dispose.
// =================================================================================================

const CSS = `
#sc-hud{position:fixed;inset:0;pointer-events:none;z-index:10;overflow:hidden;
  font-family:"Helvetica Neue",Helvetica,Inter,Arial,system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;contain:layout style;
  opacity:1;transition:opacity .28s ease}
#sc-hud[data-hidden="1"]{opacity:0}
#sc-hud *{box-sizing:border-box}

/* --- the screen-edge layer: detection, noise, the mask window --- */
#sc-hud .edge{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
#sc-hud .edge circle,#sc-hud .edge line{fill:none;stroke-linecap:butt;vector-effect:none}

/* --- reticle --- */
#sc-hud .ret{position:absolute;left:50%;top:50%;width:${G.reticleBox}px;height:${G.reticleBox}px;
  margin-left:${-G.reticleBox / 2}px;margin-top:${-G.reticleBox / 2}px;overflow:visible}
#sc-hud .ret g{opacity:0;transition:opacity .11s linear}
#sc-hud .ret path,#sc-hud .ret circle,#sc-hud .ret line{fill:none;
  stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4}

/* --- interaction prompt: a piece of the manual, 92% opacity, hard contact shadow (§13.8) --- */
#sc-hud .prompt{position:absolute;left:50%;bottom:9.5vh;transform:translateX(-50%);
  display:flex;align-items:center;gap:9px;padding:7px 11px 7px 8px;
  background:${C.paper};opacity:0;
  box-shadow:0 2px 0 rgba(0,0,0,.35),0 24px 60px rgba(0,0,0,.75);
  transition:opacity ${G.promptFadeMs}ms ease}
#sc-hud .prompt[data-on="1"]{opacity:.92}
#sc-hud .prompt svg{display:block}
#sc-hud .prompt .cap{position:relative;width:26px;height:26px;flex:0 0 auto;
  border:1.6px solid ${C.ink};display:grid;place-items:center}
#sc-hud .prompt .cap.wide{width:44px}
#sc-hud .prompt .cap b{font-weight:500;font-size:10px;letter-spacing:.06em;color:${C.ink};
  font-variant-numeric:tabular-nums lining-nums;line-height:1}
#sc-hud .prompt .cap i{position:absolute;left:-4px;top:-4px;right:-4px;bottom:-4px}
#sc-hud .prompt .word{font-weight:500;font-size:11px;letter-spacing:.06em;color:${C.ink};
  text-transform:lowercase;max-width:22ch}

/* --- carry --- */
#sc-hud .carry{position:absolute;left:3.2vw;bottom:8.2vh;opacity:0;
  transition:opacity .35s ease}
#sc-hud .carry path{fill:none;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4}

/* --- subtitles: no box, no shadow on the type. A scrim behind the lane instead. --- */
#sc-hud .scrim{position:absolute;left:0;right:0;bottom:0;height:34vh;opacity:0;
  background:radial-gradient(120% 100% at 50% 118%,rgba(4,7,10,.62) 0%,rgba(4,7,10,0) 72%);
  transition:opacity .5s ease}
#sc-hud .subs{position:absolute;left:0;right:0;bottom:12vh;display:flex;
  flex-direction:column;align-items:center;gap:3px}
#sc-hud .sub{position:relative;display:flex;align-items:baseline;gap:6px;
  font-weight:500;font-size:1.05rem;line-height:1.42;letter-spacing:.005em;
  text-transform:lowercase;color:rgba(${C.subtitle},.78);
  max-width:min(34ch,72vw);text-align:left;opacity:0;
  transition:opacity .34s ease,transform .34s ease;
  transform:translateY(3px);will-change:opacity}
#sc-hud .sub[data-on="1"]{opacity:1;transform:translateY(0)}
#sc-hud .sub[data-far="1"]{color:rgba(${C.subtitle},.5);font-size:.98rem}
#sc-hud .sub .ch{flex:0 0 auto;width:0;height:0;align-self:center;
  border-top:4px solid transparent;border-bottom:4px solid transparent;opacity:.55}
#sc-hud .sub .ch[data-d="l"]{border-right:5px solid rgba(${C.subtitle},.8)}
#sc-hud .sub .ch[data-d="r"]{border-left:5px solid rgba(${C.subtitle},.8);order:2}
#sc-hud .sub .ch[data-d="0"]{display:none}
#sc-hud .sub.cap{color:rgba(${C.subtitle},.5);font-size:.95rem;letter-spacing:.02em}

/* --- toast: a small piece of paper, and almost never --- */
#sc-hud .toasts{position:absolute;left:50%;bottom:17vh;transform:translateX(-50%);
  display:flex;flex-direction:column-reverse;align-items:center;gap:7px}
#sc-hud .toast{display:flex;align-items:center;gap:9px;padding:8px 12px;
  background:${C.paper};opacity:0;transform:translateY(5px);
  box-shadow:0 2px 0 rgba(0,0,0,.35),0 18px 44px rgba(0,0,0,.7);
  transition:opacity .3s ease,transform .3s ease}
#sc-hud .toast[data-on="1"]{opacity:.92;transform:translateY(0)}
#sc-hud .toast .word{font-weight:500;font-size:11.5px;letter-spacing:.05em;color:${C.ink};
  text-transform:lowercase;max-width:26ch}
#sc-hud .toast svg{display:block}
#sc-hud .toast path{fill:none;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4}

/* --- reduced motion: nothing travels, nothing pulses. Things simply are, or are not. --- */
#sc-hud[data-rm="1"] .sub,#sc-hud[data-rm="1"] .toast{transform:none!important;
  transition:opacity .2s linear}
#sc-hud[data-rm="1"] .prompt,#sc-hud[data-rm="1"] .ret g{transition:opacity .06s linear}
`;

// =================================================================================================

export class HUD {
  constructor(ctx) {
    this.ctx = ctx || {};
    this.bus = this.ctx.bus || null;

    // --- lifecycle
    this._built = false;
    this._disposed = false;
    this._unsubs = [];
    this._root = null;
    this._style = null;

    // --- viewport. `ctx.width/height` are 1×1 until Engine's first resize, and Engine's resize
    //     early-returns when the size has not changed — so a system registered after that first
    //     call never receives one. `update()` re-syncs from ctx every frame (two integer
    //     comparisons) rather than trusting that we were told.
    this._w = this._viewW();
    this._h = this._viewH();
    this._ringR = G.ringR * Math.min(this._w, this._h);

    // --- settings mirror (re-read on settings:changed; never polled in update)
    this._subtitlesOn = true;
    this._reducedMotion = false;
    this._colorblind = 'none';
    this._accent = C.accent;

    // --- gross visibility
    this._hidden = false;          // show()/hide()
    this._paused = false;          // game:pause
    this._stripped = false;        // Night Seven (GAME_DESIGN §12.8)
    this._blueprintOpen = false;
    this._phase = 'menu';

    // --- reticle / prompt
    this._verb = null;             // the resolved verb id, or null
    this._verbShown = null;
    this._reticleFocus = 0;        // 0..1, how much the dot has become a shape
    this._promptIcon = null;
    this._promptKey = null;
    this._promptWord = '';
    this._promptOn = false;
    this._promptForced = false;    // set by the public setPrompt()
    this._promptForcedLeft = 0;
    this._scanTimer = 0;
    this._seatingP = -1;

    // --- carry
    this._carryTypes = ['', '', '', ''];
    this._carryCount = 0;
    this._carryNorm = 0;
    this._carryFade = 0;
    this._fatigue = 0;

    // --- detection: three pooled sources, never reallocated
    this._sources = [];
    for (let i = 0; i < 3; i++) {
      this._sources.push({
        active: false, id: '', level: 0, target: 0, bearing: 0, smoothBearing: 0,
        hasPos: false, x: 0, y: 0, z: 0, spotted: false, external: false, ttl: 0,
      });
    }
    this._spotted = false;
    this._camperList = null;
    this._camperProbe = 0;
    this._detectKey = '';

    // --- noise rings
    this._rings = [];
    this._noiseGate = 0;

    // --- mask window
    this._maskRemaining = 0;
    this._maskIncoming = 0;
    this._maskWasOpen = false;
    this._maskWasIncoming = false;
    this._maskSpan = 1;

    // --- subtitles
    this._subs = [];
    this._subSlots = [];

    // --- toasts
    this._toasts = [];

    // --- manual hint (the one teaching prompt in the game, Night One only)
    this._manualHint = 0;
    this._manualEverOpened = false;

    this._t = 0;
    this._faultLogged = false;
  }

  // ===============================================================================================
  // LIFECYCLE
  // ===============================================================================================

  async init() {
    if (this._disposed) return;
    try {
      this._readSettings();
      this._build();
      this._bind();
      this.resize(this._viewW(), this._viewH());
      this._built = true;
      Log.debug('HUD: overlay up.');
    } catch (e) {
      Log.error('HUD: init failed — running headless.', e);
      this._built = false;
    }
  }

  _readSettings() {
    const s = this.ctx.settings;
    const get = (k, dflt) => {
      try {
        if (s && typeof s.get === 'function') { const v = s.get(k); return v === undefined ? dflt : v; }
        if (s && k in s) return s[k];
      } catch { /* a hostile getter is not our problem */ }
      return dflt;
    };
    this._subtitlesOn = get('subtitles', true) !== false;
    this._reducedMotion = get('reducedMotion', false) === true;
    this._colorblind = get('colorblind', 'none') || 'none';
    this._accent = this._colorblind === 'none' ? C.accent : C.accentCvd;
    this._dirAudioIndicator = get('directionalAudioIndicator', false) === true;
    if (this._root) {
      this._root.dataset.rm = this._reducedMotion ? '1' : '0';
      if (this._retBlocked) for (const p of this._retBlocked.children) attrStr(p, 'stroke', this._accent);
    }
  }

  // ---------------------------------------------------------------------------------- DOM build

  _build() {
    const doc = globalThis.document;
    if (!doc || !doc.body) throw new Error('no document');

    this._style = doc.createElement('style');
    this._style.id = 'sc-hud-style';
    this._style.textContent = CSS;
    doc.head.appendChild(this._style);

    const root = el('div');
    root.id = 'sc-hud';
    root.dataset.rm = this._reducedMotion ? '1' : '0';
    this._root = root;

    // --- 1. the screen-edge layer ---------------------------------------------------------------
    const edge = svg('svg', { class: 'edge', preserveAspectRatio: 'none' });
    this._edge = edge;

    // Detection: three sources × (outer arc, inner arc, notch). Nothing here is created later.
    this._arcs = [];
    for (let i = 0; i < 3; i++) {
      const g = svg('g');
      const outer = svg('circle', { 'pathLength': '1000', 'stroke-linecap': 'butt' });
      const inner = svg('circle', { 'pathLength': '1000', 'stroke-linecap': 'butt' });
      const notch = svg('line', {});
      g.appendChild(outer); g.appendChild(inner); g.appendChild(notch);
      edge.appendChild(g);
      this._arcs.push({ g, outer, inner, notch });
      styleNum(g, 'opacity', 0);
    }

    // The mask window: one ring outside the detection ring. It drains clockwise from 12 o'clock.
    this._maskRing = svg('circle', { 'pathLength': '1000', 'stroke-linecap': 'butt' });
    edge.appendChild(this._maskRing);
    styleNum(this._maskRing, 'opacity', 0);

    // Noise rings: a pool of eight. Eight simultaneous significant noises is not a thing that
    // happens; the ninth silently reuses the oldest.
    for (let i = 0; i < 8; i++) {
      const c = svg('circle', { 'fill': 'none' });
      edge.appendChild(c);
      const ring = { node: c, live: false, t: 0, dur: 1, r0: 0, r1: 0, alpha: 0, seq: 0 };
      styleNum(c, 'opacity', 0);
      this._rings.push(ring);
    }
    root.appendChild(edge);

    // --- 2. the reticle -------------------------------------------------------------------------
    const ret = svg('svg', { class: 'ret', viewBox: `0 0 ${G.reticleBox} ${G.reticleBox}` });
    this._ret = ret;

    // The idle state, verbatim from ART §13.8: a single 2 px dot at 55% opacity, 1 px ink outline.
    this._retDotRing = svg('circle', {
      cx: 22, cy: 22, r: 1.7, fill: 'none', stroke: C.ink, 'stroke-width': 1, 'stroke-opacity': 0.55,
    });
    this._retDot = svg('circle', { cx: 22, cy: 22, r: 1, fill: `rgba(${C.warm},.55)`, stroke: 'none' });
    ret.appendChild(this._retDotRing);
    ret.appendChild(this._retDot);

    // The verb shapes. One group each; only `opacity` is ever written.
    this._retVerbs = {};
    const verbSet = ['grab', 'place', 'rotate', 'tighten', 'pull', 'remove', 'saw', 'blocked'];
    for (const id of verbSet) {
      const g = svg('g');
      for (const spec of PICTO[id]) {
        const p = svg('path', {
          d: spec[0],
          'stroke-width': spec[1] * 1.05,
          'stroke': spec[4] ? this._accent : `rgba(${C.warm},.86)`,
          'fill': spec[2] ? (spec[4] ? this._accent : `rgba(${C.warm},.86)`) : 'none',
        });
        if (spec[3]) p.setAttribute('stroke-dasharray', spec[3]);
        // A hairline outline in ink keeps the shape legible over a blown highlight, per §13.8's
        // treatment of the dot. It costs one extra path and it is why this reads on snow-lit fog.
        const shadow = svg('path', {
          d: spec[0], 'stroke-width': spec[1] * 1.05 + 1.4, 'stroke': 'rgba(10,14,18,.45)',
          'fill': spec[2] ? 'rgba(10,14,18,.45)' : 'none',
        });
        g.appendChild(shadow);
        g.appendChild(p);
      }
      // The verb shapes sit in a 40-box; the reticle is 44. Centre them.
      g.setAttribute('transform', 'translate(2 2)');
      ret.appendChild(g);
      this._retVerbs[id] = g;
      if (id === 'blocked') this._retBlocked = g;
    }

    // The seating band (§6.5). Drawn ONLY when BuildSystem sets `seating.showMeter`, which is
    // `difficulty === 'story'` or `puzzleHints`. There is no meter above story and there must not be.
    this._seatG = svg('g');
    this._seatTrack = svg('circle', {
      cx: 22, cy: 22, r: 15, 'pathLength': '1000', fill: 'none',
      stroke: `rgba(${C.warm},.16)`, 'stroke-width': 1.2,
    });
    this._seatFill = svg('circle', {
      cx: 22, cy: 22, r: 15, 'pathLength': '1000', fill: 'none',
      stroke: `rgba(${C.warm},.8)`, 'stroke-width': 2.2,
    });
    this._seatLo = svg('line', { stroke: `rgba(${C.warm},.75)`, 'stroke-width': 1.4 });
    this._seatHi = svg('line', { stroke: `rgba(${C.warm},.75)`, 'stroke-width': 1.4 });
    this._seatG.appendChild(this._seatTrack);
    this._seatG.appendChild(this._seatFill);
    this._seatG.appendChild(this._seatLo);
    this._seatG.appendChild(this._seatHi);
    ret.appendChild(this._seatG);
    styleNum(this._seatG, 'opacity', 0);
    root.appendChild(ret);

    // --- 3. the interaction prompt --------------------------------------------------------------
    const prompt = el('div', 'prompt');
    this._promptCard = prompt;
    this._promptSvg = svg('svg', { viewBox: '0 0 40 40', width: 24, height: 24 });
    this._promptPaths = [];
    for (let i = 0; i < 8; i++) {
      const p = svg('path', { d: '', fill: 'none', stroke: C.ink, 'stroke-width': W.thin,
        'stroke-linecap': 'butt', 'stroke-linejoin': 'miter', 'stroke-miterlimit': '4' });
      this._promptSvg.appendChild(p);
      this._promptPaths.push(p);
    }
    prompt.appendChild(this._promptSvg);

    this._promptCap = el('div', 'cap');
    this._promptCapLabel = el('b');
    this._promptCap.appendChild(this._promptCapLabel);
    // The hold ring — a hold verb (force-place, provoke, set-down) fills it. Drawn on the cap, so
    // the progress is attached to the key rather than floating in space.
    this._promptHold = svg('svg', { viewBox: '0 0 34 34' });
    this._promptHold.setAttribute('class', 'holdring');
    this._promptHoldArc = svg('circle', {
      cx: 17, cy: 17, r: 15.2, fill: 'none', stroke: C.ink, 'stroke-width': 2,
      'pathLength': '1000',
    });
    this._promptHold.appendChild(this._promptHoldArc);
    const holdWrap = el('i');
    holdWrap.appendChild(this._promptHold);
    this._promptHold.style.width = '100%';
    this._promptHold.style.height = '100%';
    this._promptCap.appendChild(holdWrap);
    prompt.appendChild(this._promptCap);

    this._promptWordEl = el('span', 'word');
    prompt.appendChild(this._promptWordEl);
    root.appendChild(prompt);

    // --- 4. the carry indicator -----------------------------------------------------------------
    const carry = el('div', 'carry');
    this._carryEl = carry;
    this._carrySvg = svg('svg', { viewBox: '0 0 44 108', width: 44, height: 108 });
    this._carryG = svg('g');
    this._carryGlyphs = [];
    for (let i = 0; i < 4; i++) {
      const g = svg('g');
      const paths = [];
      for (let k = 0; k < 4; k++) {
        const p = svg('path', { d: '', fill: 'none', stroke: `rgba(${C.warm},.66)`,
          'stroke-width': 1.15, 'stroke-linecap': 'butt', 'stroke-linejoin': 'miter',
          'stroke-miterlimit': '4' });
        g.appendChild(p);
        paths.push(p);
      }
      g.setAttribute('transform', `translate(4 ${72 - i * 24})`);
      this._carryG.appendChild(g);
      this._carryGlyphs.push({ g, paths });
      styleNum(g, 'opacity', 0);
    }
    // The load line. A dimension rule (§13.4's double-headed span) that BOWS under mass. It is the
    // only fatigue readout in the game and it never shows a number.
    this._carryLoad = svg('path', {
      d: '', fill: 'none', stroke: `rgba(${C.warm},.4)`, 'stroke-width': 1.1, 'stroke-linecap': 'butt',
    });
    this._carryG.appendChild(this._carryLoad);
    this._carrySvg.appendChild(this._carryG);
    carry.appendChild(this._carrySvg);
    root.appendChild(carry);

    // --- 5. subtitles ---------------------------------------------------------------------------
    this._scrim = el('div', 'scrim');
    root.appendChild(this._scrim);
    const subs = el('div', 'subs');
    this._subsEl = subs;
    for (let i = 0; i < 3; i++) {
      const line = el('div', 'sub');
      line.dataset.on = '0';
      line.dataset.far = '0';
      const ch = el('span', 'ch');
      ch.dataset.d = '0';
      const tx = el('span', 'tx');
      line.appendChild(ch);
      line.appendChild(tx);
      subs.appendChild(line);
      this._subSlots.push({ node: line, chev: ch, text: tx, live: false, t: 0, ms: 0, lane: 0 });
    }
    root.appendChild(subs);

    // --- 6. toasts ------------------------------------------------------------------------------
    const toasts = el('div', 'toasts');
    this._toastsEl = toasts;
    for (let i = 0; i < 3; i++) {
      const card = el('div', 'toast');
      card.dataset.on = '0';
      const s = svg('svg', { viewBox: '0 0 40 40', width: 26, height: 26 });
      const paths = [];
      for (let k = 0; k < 8; k++) {
        const p = svg('path', { d: '', fill: 'none', stroke: C.ink, 'stroke-width': W.thin,
          'stroke-linecap': 'butt', 'stroke-linejoin': 'miter', 'stroke-miterlimit': '4' });
        s.appendChild(p);
        paths.push(p);
      }
      const word = el('span', 'word');
      card.appendChild(s);
      card.appendChild(word);
      toasts.appendChild(card);
      this._toasts.push({ node: card, svg: s, paths, word, live: false, t: 0, ms: 0, hide: 0 });
      card.style.display = 'none';
    }
    root.appendChild(toasts);

    doc.body.appendChild(root);
  }

  // ------------------------------------------------------------------------------------- events

  _bind() {
    const bus = this.bus;
    if (!bus || typeof bus.on !== 'function') return;
    const on = (ev, fn) => { this._unsubs.push(bus.on(ev, Log.guard(`HUD:${ev}`, fn))); };

    on('ui:toast', (p) => this.toast(p?.text ?? '', p));
    on('ui:subtitle', (p) => this.subtitle(p?.text, p?.speaker, p?.ms));

    on('player:spotted', (p) => this._onSpotted(p));
    on('player:hidden', () => this._onHidden());

    on('noise:emit', (p) => this._onNoise(p));

    on('game:pause', () => { this._paused = true; });
    on('game:resume', () => { this._paused = false; });
    on('game:start', () => { this._paused = false; });

    on('night:begin', (p) => this._onNightBegin(p));
    on('night:complete', () => this._clearTransient());
    on('night:failed', () => this._clearTransient());

    on('settings:changed', () => this._readSettings());

    // HUD owns the blueprint toggle (ARCHITECTURE §5; STORY §2.4.1: "HUD emits
    // `ui:blueprint-open`; `BlueprintUI` plays the wipe"). Track our own state so a stubbed
    // BlueprintUI cannot desync us.
    on('ui:blueprint-open', () => { this._blueprintOpen = true; this._manualEverOpened = true; });
    on('ui:blueprint-close', () => { this._blueprintOpen = false; });

    on('story:beat', (p) => {
      // Night Seven's blank spread. §12.8 takes the HUD away and this is the earliest signal.
      if (p?.id === 'n7_blank_spread' || p?.id === 'n7_final') this.setStripped(true);
    });
  }

  _onNightBegin(p) {
    const n = p?.night | 0;
    this._clearTransient();
    // GAME_DESIGN §12.8 — Night Seven: "no HUD, no reticle, no prompts, no objective marker, no
    // creak feedback, no detection smear. `settings.subtitles` still works; nothing speaks."
    this.setStripped(n >= 7);
    this._manualEverOpened = false;
    // The one teaching prompt in the game: the manual, Night One, for twenty seconds, once.
    this._manualHint = n === 1 ? 20 : 0;
  }

  _clearTransient() {
    for (const s of this._sources) { s.active = false; s.level = 0; s.target = 0; s.ttl = 0; }
    this._spotted = false;
    for (const r of this._rings) { r.live = false; styleNum(r.node, 'opacity', 0); }
    for (const s of this._subSlots) { s.live = false; s.node.dataset.on = '0'; }
    for (const t of this._toasts) { t.live = false; t.node.dataset.on = '0'; }
    this._promptForced = false;
    this._maskRemaining = 0;
    this._maskIncoming = 0;
  }

  // ===============================================================================================
  // PUBLIC API
  // ===============================================================================================

  show() { this._hidden = false; }
  hide() { this._hidden = true; }

  /** Night Seven, and the interior walk (`GAME_DESIGN.md` §12.8, §13). Subtitles survive. */
  setStripped(on) { this._stripped = !!on; }

  /**
   * `ui:toast`. Rare and quiet. In practice `text` is always the empty string and `icon` carries
   * the whole message — `BuildSystem` fires `{ text:'', icon:'checkbox-filled' }` for the one
   * reward in the game and that is the entire reward.
   */
  toast(text, opts) {
    if (!this._built || this._stripped) return;
    const icon = opts?.icon ?? null;
    const word = typeof text === 'string' ? text.trim() : '';
    const glyph = icon ? (PICTO[icon] || PICTO[VERB_PICTO[icon]] || null) : null;
    if (!glyph && !word) {
      if (icon) Log.once(`hud:toast:${icon}`, `HUD: no pictogram for toast icon '${icon}'.`);
      return;
    }
    const ms = clamp(opts?.ms ?? 1600, 500, 8000);

    // Reuse the oldest live card rather than stacking a third.
    let slot = null;
    for (const t of this._toasts) if (!t.live) { slot = t; break; }
    if (!slot) {
      slot = this._toasts[0];
      for (const t of this._toasts) if (t.t / Math.max(t.ms, 1) > slot.t / Math.max(slot.ms, 1)) slot = t;
    }

    this._paintGlyph(slot.paths, glyph, C.ink);
    slot.svg.style.display = glyph ? 'block' : 'none';
    setText(slot.word, word);
    slot.word.style.display = word ? 'block' : 'none';
    slot.node.style.display = 'flex';
    slot.live = true; slot.t = 0; slot.ms = ms;
    // Force a reflow-free transition start: the card is display:flex before data-on flips next frame.
    slot.node.dataset.on = '0';
    slot._arm = true;
  }

  /**
   * `ui:subtitle`. Camper chatter only — there is nothing else to subtitle. Lowercase, small,
   * translucent, placed by the speaker's bearing so the *position* implies who is talking, and
   * carrying a direction chevron only when the speaker is behind you.
   */
  subtitle(text, speaker, ms) {
    if (!this._built) return;
    if (!this._subtitlesOn) return;
    if (typeof text !== 'string' || !text.trim()) return;
    const dur = clamp(ms ?? 2600, 700, 9000);

    // Bearing → lane. If we cannot find the speaker in the world, a deterministic per-speaker lane
    // still makes placement mean something: the voice from the left is always the same person.
    let lane = 0, chev = '0';
    const b = this._bearingToSpeaker(speaker);
    if (Number.isFinite(b)) {
      lane = clamp(b / (Math.PI * 0.7), -1, 1);
      if (Math.abs(b) > Math.PI * 0.62) chev = b > 0 ? 'r' : 'l';
    } else if (typeof speaker === 'string' && speaker) {
      lane = (hashStr(speaker) - 0.5) * 1.4;
    }
    this._pushSub(text, lane, chev, dur, false);
  }

  /**
   * `setPrompt(text, key)` — the contract signature. `text` is preferentially a PICTOGRAM ID
   * (`'place'`, `'tighten'`, `'manual'`…), because the manual's language is wordless and so is
   * this. A word is accepted and rendered tiny and lowercase, but every caller in this repo passes
   * a glyph. `key` is either an `Input` action name (`'interact'`) or a literal cap label.
   * `setPrompt(null)` releases the override and returns the prompt to the build system.
   */
  setPrompt(text, key, opts) {
    if (!this._built) return;
    if (text == null && key == null) {
      this._promptForced = false;
      return;
    }
    const id = typeof text === 'string' ? (VERB_PICTO[text] || (PICTO[text] ? text : null)) : null;
    this._promptForced = true;
    // A countdown, not a deadline: the caller's clock is not necessarily ours.
    this._promptForcedLeft = opts?.ms ? opts.ms / 1000 : Infinity;
    this._forcedIcon = id;
    this._forcedWord = id ? '' : (typeof text === 'string' ? text : '');
    this._forcedKey = key ?? 'interact';
    this._forcedHold = clamp01(opts?.progress ?? 0);
  }

  /**
   * `setDetection(level)` — 0..1. Drives the arc directly. Pass `{ position }` (a Vector3 or
   * `{x,y,z}`) or `{ bearing }` in radians relative to view forward to make it directional;
   * without either, the ring is omnidirectional, which is what "someone is looking and you do not
   * know where from" should feel like.
   */
  setDetection(level, opts) {
    const v = clamp01(Number(level) || 0);
    const id = opts?.source ?? '__external';
    const s = this._sourceFor(id, true);
    if (!s) return;
    s.external = true;
    s.target = v;
    s.level = s.level > v ? s.level : v;
    s.spotted = !!opts?.spotted || v >= 1;
    s.ttl = 2.5;
    const p = opts?.position;
    if (p && Number.isFinite(p.x)) { s.hasPos = true; s.x = p.x; s.y = p.y ?? 0; s.z = p.z; }
    else if (Number.isFinite(opts?.bearing)) { s.hasPos = false; s.bearing = opts.bearing; }
    else { s.hasPos = false; s.bearing = NaN; }
    if (v <= 0) { s.active = false; s.level = 0; }
  }

  /** Manual hook for the noise ring, if anything ever wants to draw one that is not a `noise:emit`. */
  noteNoise(intensity, metres, opts) {
    this._pushRing(clamp01(intensity), Math.max(0, metres || 0),
      Number.isFinite(opts?.bearing) ? opts.bearing : NaN, !!opts?.masked);
  }

  // ===============================================================================================
  // FRAME
  // ===============================================================================================

  update(dt, elapsed) {
    if (!this._built || this._disposed) return;
    this._t = Number.isFinite(elapsed) ? elapsed : this._t + dt;
    const d = clamp(dt, 0, 0.1);

    // See the constructor note: never trust that `resize()` reached us.
    const vw = this._viewW(), vh = this._viewH();
    if (vw !== this._w || vh !== this._h) this.resize(vw, vh);

    try {
      this._pollWorld(d);
      this._updateDetection(d);
      this._updateNoise(d);
      this._updateMask(d);
      this._updateReticle(d);
      this._updatePrompt(d);
      this._updateCarry(d);
      this._updateSubs(d);
      this._updateToasts(d);
      this._updateVisibility(d);
    } catch (e) {
      if (!this._faultLogged) { this._faultLogged = true; Log.error('HUD: update threw.', e); }
    }
  }

  resize(w, h) {
    this._w = Math.max(1, w | 0 || this._w);
    this._h = Math.max(1, h | 0 || this._h);
    if (!this._built) return;
    const cx = this._w / 2, cy = this._h / 2;
    const R = G.ringR * Math.min(this._w, this._h);
    this._ringR = R;
    attrStr(this._edge, 'viewBox', `0 0 ${this._w} ${this._h}`);
    for (const a of this._arcs) {
      attrNum(a.outer, 'cx', cx, 10); attrNum(a.outer, 'cy', cy, 10); attrNum(a.outer, 'r', R, 10);
      attrNum(a.inner, 'cx', cx, 10); attrNum(a.inner, 'cy', cy, 10); attrNum(a.inner, 'r', R - 5.5, 10);
    }
    attrNum(this._maskRing, 'cx', cx, 10);
    attrNum(this._maskRing, 'cy', cy, 10);
    attrNum(this._maskRing, 'r', R + G.maskROffset, 10);
    for (const r of this._rings) { attrNum(r.node, 'cx', cx, 10); attrNum(r.node, 'cy', cy, 10); }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const u of this._unsubs) { try { u?.(); } catch { /* already gone */ } }
    this._unsubs.length = 0;
    try { this._root?.remove(); } catch { /* detached */ }
    try { this._style?.remove(); } catch { /* detached */ }
    this._root = null; this._style = null; this._edge = null; this._ret = null;
    this._arcs = null; this._rings.length = 0; this._subSlots.length = 0; this._toasts.length = 0;
    this._camperList = null;
    this._built = false;
  }

  // ===============================================================================================
  // POLLING — one place where other systems are read, throttled, and null-checked into oblivion
  // ===============================================================================================

  _sys(name) {
    try { return this.ctx.systems?.get?.(name) ?? null; } catch { return null; }
  }

  _pollWorld(dt) {
    const st = this.ctx.state;
    this._phase = st?.phase ?? this._phase;

    // --- the manual toggle. HUD owns it (ARCHITECTURE §5).
    const input = this._sys('Input');
    if (input && typeof input.wasPressed === 'function' && !this._paused) {
      if (input.wasPressed('blueprint')) {
        this._blueprintOpen = !this._blueprintOpen;
        this._manualEverOpened = true;
        this.bus?.emit(this._blueprintOpen ? 'ui:blueprint-open' : 'ui:blueprint-close', {});
      }
    }
    if (this._manualHint > 0 && (this._manualEverOpened || this._phase !== 'build')) this._manualHint = 0;
    else if (this._manualHint > 0) this._manualHint -= dt;

    // --- the mask window (NoiseSystem is the authority; BuildSystem mirrors it).
    const ns = this._sys('NoiseSystem');
    const bs = this._sys('BuildSystem');
    let rem = 0, inc = 0;
    try {
      rem = Number(ns?.maskWindowRemaining ?? bs?.maskWindowRemaining ?? 0) || 0;
      inc = Number(ns?.maskWindowIncoming ?? bs?.nextStrikeIn ?? 0) || 0;
    } catch { rem = 0; inc = 0; }
    if (rem > this._maskRemaining + 0.05) this._maskSpan = Math.max(rem, 0.5);
    this._maskRemaining = rem;
    this._maskIncoming = inc;

    // --- what verb is under the reticle. Throttled to 20 Hz; a 50 ms stale prompt is invisible
    //     and the scan is the only O(n) thing in this file.
    this._scanTimer -= dt;
    if (this._scanTimer <= 0) {
      this._scanTimer = 0.05;
      this._resolveVerb(bs);
    }
    this._pollSeating(bs);
    this._pollCarry(bs);
    this._pollCampers(dt);
  }

  // ------------------------------------------------------------------------- the verb resolution

  /**
   * What is under the reticle, and what would happen. Every read is a documented public field on
   * `BuildSystem`; the look-at scan is our own so we never call another agent's private method.
   */
  _resolveVerb(bs) {
    this._verb = null;
    this._verbKey = 'interact';
    this._verbHold = 0;

    if (!bs || this._stripped || this._blueprintOpen || this._paused) return;
    if (this._phase !== 'build' && this._phase !== 'chase') return;

    // 1. Mid-action: the seating check owns the reticle.
    try {
      if (bs.seating?.active) { this._verb = 'tighten'; this._verbKey = 'mouse-left'; return; }
      if (bs.action) {
        const k = String(bs.action.kind || '');
        this._verb = VERB_PICTO[k] || null;
        this._verbKey = 'interact';
        const dur = bs.action.duration || 0;
        this._verbHold = dur > 0 ? clamp01((bs.action.t || 0) / dur) : 0;
        if (this._verb) return;
      }
    } catch { /* a hostile getter is not our problem */ }

    // 2. Carrying: the verb is placement, and its failure mode is the ✗.
    let held = null;
    try { held = bs.heldPart ?? (bs.heldParts && bs.heldParts.length ? bs.heldParts[0] : null); } catch { held = null; }
    if (held) {
      let slot = null, valid = false;
      try { slot = bs.targetSlot; valid = !!bs.ghostValid; } catch { /* */ }
      if (slot) { this._verb = valid ? 'place' : 'blocked'; this._verbKey = 'mouse-left'; return; }
      // Nothing to place into: the only verb left is rotation, and it is a *hint*, not a demand.
      this._verb = null;
      return;
    }

    // 3. Empty-handed: the nearest lookable part, then the nearest lookable join.
    const eye = this._eye(_v1);
    if (!eye) return;
    this._forwardVec(_fwd);

    const part = this._lookAtPart(bs, eye, _fwd);
    if (part) { this._verb = 'grab'; this._verbKey = 'interact'; return; }

    const slot = this._lookAtSlot(bs, eye, _fwd);
    if (slot) {
      // An obstruction is the county survey stake, and STORY §1.4 is explicit: 1.1 s, silent,
      // NO PROMPT, NO TOAST. The reticle may say "there is a verb here". The card may not.
      if (slot.obstruction) { this._verb = 'pull'; this._verbKey = null; return; }
      let intent = null;
      try { intent = bs.repairIntent; } catch { /* */ }
      if (intent) {
        const id = typeof intent === 'string' ? intent : (intent.kind || intent.id || '');
        this._verb = VERB_PICTO[id] || 'remove';
        this._verbKey = 'interact';
        return;
      }
    }
  }

  _lookAtPart(bs, eye, fwd) {
    let list = null;
    try { list = bs.available; } catch { return null; }
    if (!list || !list.length) return null;
    const reach = 3.0, dotMin = 0.35;
    let best = null, bestScore = -Infinity;
    const n = Math.min(list.length, 96);
    for (let i = 0; i < n; i++) {
      const p = list[i];
      const o = p && p.object3D;
      if (!o) continue;
      _v2.copy(o.position).sub(eye);
      const dist = _v2.length();
      if (dist > reach || dist < 1e-4) continue;
      _v2.multiplyScalar(1 / dist);
      const dot = _v2.dot(fwd);
      if (dot < dotMin) continue;
      const score = dot * 2 - dist * 0.35;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  _lookAtSlot(bs, eye, fwd) {
    let list = null;
    try { list = bs.nightSlots; } catch { /* */ }
    if (!list || !list.length) {
      try { list = bs.slots ? Array.from(bs.slots.values()) : null; } catch { return null; }
      // Array.from allocates; only reached when `nightSlots` is absent, which is a stubbed
      // BuildSystem, at 20 Hz, and never in the shipping build.
    }
    if (!list || !list.length) return null;
    const reach = 3.4, dotMin = 0.35;
    let best = null, bestScore = -Infinity;
    const n = Math.min(list.length, 128);
    for (let i = 0; i < n; i++) {
      const s = list[i];
      if (!s || !Number.isFinite(s.px)) continue;
      _v2.set(s.px, s.py, s.pz).sub(eye);
      const dist = _v2.length();
      if (dist > reach || dist < 1e-4) continue;
      _v2.multiplyScalar(1 / dist);
      const dot = _v2.dot(fwd);
      if (dot < dotMin) continue;
      const score = dot * 2 - dist * 0.3;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  _pollSeating(bs) {
    let s = null;
    try { s = bs?.seating; } catch { s = null; }
    if (!s || !s.active || !s.showMeter) { this._seatingP = -1; return; }
    this._seatingP = clamp01(s.p || 0);
    this._seatLoV = clamp01(s.lo ?? 0.725);
    this._seatHiV = clamp01(s.hi ?? 0.875);
  }

  _pollCarry(bs) {
    let held = null;
    try { held = bs?.heldParts; } catch { held = null; }
    const n = held ? Math.min(held.length, 4) : 0;
    let changed = n !== this._carryCount;
    for (let i = 0; i < 4; i++) {
      const t = i < n ? (held[i]?.type || 'default') : '';
      if (this._carryTypes[i] !== t) { this._carryTypes[i] = t; changed = true; }
    }
    this._carryCount = n;
    if (changed) {
      this._carryFade = 1;
      this._repaintCarry();
    }

    // Mass, as a fraction of the heaviest thing in the game (PANEL_N / RIDGE, ~71 kg).
    let mass = 0;
    try { mass = Number(bs?.carryMass) || 0; } catch { mass = 0; }
    if (!mass && held) for (let i = 0; i < n; i++) mass += Number(held[i]?.mass) || 0;
    this._carryNorm = clamp01(mass / 75);

    // Fatigue. Stamina is Player's, and it is the only reason the drawing sags.
    const pl = this._sys('Player');
    let stam = 1;
    try {
      const s = Number(pl?.stamina);
      if (Number.isFinite(s)) stam = clamp01(s / 100);
    } catch { stam = 1; }
    this._fatigue = 1 - stam;
  }

  // ------------------------------------------------------------------------------- camper probe

  _pollCampers(dt) {
    this._camperProbe -= dt;
    if (this._camperProbe <= 0) {
      this._camperProbe = 1.0;
      const c = this._sys('Campers');
      let list = null;
      if (c) {
        try {
          if (Array.isArray(c.campers)) list = c.campers;
          else if (Array.isArray(c.agents)) list = c.agents;
          else if (typeof c.getAll === 'function') list = c.getAll();
          else if (Array.isArray(c.list)) list = c.list;
        } catch { list = null; }
      }
      this._camperList = Array.isArray(list) && list.length ? list : null;
    }

    const list = this._camperList;
    if (!list) return;

    // Live path. Read the published scalar, whichever it turns out to be called.
    const n = Math.min(list.length, 8);
    for (let i = 0; i < n; i++) {
      const c = list[i];
      if (!c) continue;
      let lvl = NaN;
      try {
        lvl = Number(c.detection);
        if (!Number.isFinite(lvl)) lvl = Number(c.detectionLevel);
        if (!Number.isFinite(lvl)) lvl = Number(c.awareness);
        if (!Number.isFinite(lvl)) lvl = Number(c.notice);
      } catch { lvl = NaN; }
      if (!Number.isFinite(lvl)) continue;
      const id = c.id || `camper${i}`;
      if (lvl < DETECT.forming) {
        const s = this._sourceFor(id, false);
        if (s) { s.target = 0; s.external = false; }
        continue;
      }
      const s = this._sourceFor(id, true);
      if (!s) continue;
      s.external = false;
      s.target = clamp01(lvl);
      s.ttl = 0.6;
      s.spotted = lvl >= 1;
      const p = c.position;
      if (p && Number.isFinite(p.x)) { s.hasPos = true; s.x = p.x; s.y = p.y || 0; s.z = p.z; }
    }
  }

  // ===============================================================================================
  // DETECTION — the most important element in this file
  //
  // GAME_DESIGN §9.3 publishes the ladder and it is implemented literally:
  //   0.01–0.35  forming   a faint directional smear, 8% opacity, no icon, no number
  //   0.35–0.75  building  the smear brightens
  //   0.75–0.99  critical  the heartbeat, the low string, the camper stops walking
  //   1.00       spotted
  //
  // Everything is separated by TOPOLOGY and by ARC LENGTH, never by hue:
  //   forming   one thin arc, 118° wide
  //   building  two concentric arcs, 74° wide
  //   critical  two arcs plus a radial notch pointing inward, 44° wide
  //   spotted   a closed ring plus the notch
  // A player who cannot see colour at all reads the same four states.
  //
  // FAIRNESS. Rising attention is perceivable long before it is fatal: the arc appears at 0.01,
  // and §9.3's slowest documented accrual (0.02098/s, standing still in the open at 15 m) means
  // the arc has been on screen for 47 seconds before it closes. The stage boundaries are also
  // where the arc VISIBLY changes topology, so the player gets three discrete warnings, not a
  // smooth ramp they can fail to notice.
  // ===============================================================================================

  _onSpotted(p) {
    const camper = p?.camper;
    const id = camper?.id || 'spotted';
    const s = this._sourceFor(id, true);
    if (!s) return;
    s.target = clamp01(p?.level ?? 1);
    s.level = Math.max(s.level, s.target);
    s.spotted = s.target >= 0.999;
    s.external = true;
    s.ttl = 3.0;
    const pos = camper?.position;
    if (pos && Number.isFinite(pos.x)) { s.hasPos = true; s.x = pos.x; s.y = pos.y || 0; s.z = pos.z; }
    this._spotted = true;
  }

  _onHidden() {
    this._spotted = false;
    for (const s of this._sources) { if (s.external) { s.spotted = false; s.target = 0; } }
  }

  _sourceFor(id, create) {
    for (const s of this._sources) if (s.active && s.id === id) return s;
    if (!create) return null;
    for (const s of this._sources) {
      if (!s.active) {
        s.active = true; s.id = id; s.level = 0; s.target = 0; s.bearing = NaN;
        s.smoothBearing = NaN; s.hasPos = false; s.spotted = false; s.external = false; s.ttl = 1;
        return s;
      }
    }
    // Full: steal the weakest, but never one that is louder than the newcomer will start at.
    let weakest = this._sources[0];
    for (const s of this._sources) if (s.level < weakest.level) weakest = s;
    weakest.id = id; weakest.level = 0; weakest.target = 0; weakest.bearing = NaN;
    weakest.smoothBearing = NaN; weakest.hasPos = false; weakest.spotted = false;
    weakest.external = false; weakest.ttl = 1;
    return weakest;
  }

  _updateDetection(dt) {
    const stripped = this._stripped;
    const camYaw = this._cameraYaw();
    const eye = this._eye(_v1);

    for (let i = 0; i < this._sources.length; i++) {
      const s = this._sources[i];
      const a = this._arcs[i];
      if (!s.active) { styleNum(a.g, 'opacity', 0); continue; }

      // Level. The live path tracks; the event path decays at §9.3's published rate.
      if (s.external) {
        s.ttl -= dt;
        if (s.ttl <= 0) s.target = 0;
        if (s.level > s.target) {
          s.level = Math.max(s.target, s.level - (s.level < 0.3 ? DECAY_FAST : DECAY_SLOW) * dt);
        } else {
          s.level = Math.min(s.target, s.level + 2.2 * dt);
        }
      } else {
        // A live scalar is the truth; smooth only enough that a 15 Hz poll does not stutter.
        s.level += (s.target - s.level) * Math.min(1, dt * 14);
        s.ttl -= dt;
        if (s.ttl <= 0) s.target = 0;
      }

      if (s.level < DETECT.forming * 0.5) {
        s.active = false;
        styleNum(a.g, 'opacity', 0);
        continue;
      }

      // Bearing. Screen-relative, in degrees clockwise from 12 o'clock, which is exactly what a
      // player's hand does when they turn to look.
      let bearingDeg = NaN;
      if (s.hasPos && eye) {
        const dx = s.x - eye.x, dz = s.z - eye.z;
        if (dx * dx + dz * dz > 1e-4) {
          const worldYaw = Math.atan2(dx, -dz);
          bearingDeg = this._wrapDeg((worldYaw - camYaw) * 180 / Math.PI);
        }
      } else if (Number.isFinite(s.bearing)) {
        bearingDeg = this._wrapDeg(s.bearing * 180 / Math.PI);
      }

      // Smooth the bearing across the ±180 seam so a camper crossing behind you does not whip.
      if (Number.isFinite(bearingDeg)) {
        if (!Number.isFinite(s.smoothBearing)) s.smoothBearing = bearingDeg;
        else {
          let delta = this._wrapDeg(bearingDeg - s.smoothBearing);
          s.smoothBearing = this._wrapDeg(s.smoothBearing + delta * Math.min(1, dt * 12));
        }
      }

      const lvl = s.level;
      const spotted = s.spotted || lvl >= 0.999;
      const omni = !Number.isFinite(s.smoothBearing);

      // Stage → geometry. Interpolated inside a stage so the ramp is perceivable; the stage
      // BOUNDARY is where a whole mark appears or disappears, which is the actual warning.
      let width, stroke, alpha, showInner, showNotch;
      if (spotted) {
        width = 360; stroke = G.arcStroke.spotted; alpha = G.arcAlpha.spotted;
        showInner = true; showNotch = !omni;
      } else if (lvl >= DETECT.critical) {
        const t = (lvl - DETECT.critical) / (1 - DETECT.critical);
        width = G.arcWidth.critical - 6 * t;
        stroke = G.arcStroke.critical + 0.5 * t;
        alpha = G.arcAlpha.critical + (G.arcAlpha.spotted - G.arcAlpha.critical) * t;
        showInner = true; showNotch = !omni;
      } else if (lvl >= DETECT.building) {
        const t = (lvl - DETECT.building) / (DETECT.critical - DETECT.building);
        width = G.arcWidth.building - (G.arcWidth.building - G.arcWidth.critical) * t;
        stroke = G.arcStroke.building + (G.arcStroke.critical - G.arcStroke.building) * t;
        alpha = G.arcAlpha.building + (G.arcAlpha.critical - G.arcAlpha.building) * t;
        showInner = true; showNotch = false;
      } else {
        const t = clamp01((lvl - DETECT.forming) / (DETECT.building - DETECT.forming));
        width = G.arcWidth.forming - (G.arcWidth.forming - G.arcWidth.building) * t;
        stroke = G.arcStroke.forming + (G.arcStroke.building - G.arcStroke.forming) * t;
        alpha = G.arcAlpha.forming + (G.arcAlpha.building - G.arcAlpha.forming) * t;
        showInner = false; showNotch = false;
      }
      if (omni) { width = 360; alpha *= 0.62; showNotch = false; }

      // The one animated thing in the detection meter, and it only happens at `critical`:
      // 1.1 Hz, ±0.09 of alpha. It exists so a player looking at a joint still catches it in
      // peripheral vision. `reducedMotion` removes it and the notch carries the state instead.
      if (!this._reducedMotion && lvl >= DETECT.critical && !spotted) {
        alpha *= 1 + 0.16 * Math.sin(this._t * TAU * 1.1);
      }
      if (stripped || this._paused) alpha = 0;

      // Colour drifts warm-white → amber with level. Decorative: every state is already separated
      // by topology and length. `ART_DIRECTION.md` §18 forbids information in hue and this obeys it.
      const warmth = clamp01((lvl - 0.35) / 0.65);
      const rgb = warmth <= 0 ? C.warm : this._mixWarm(warmth);

      styleNum(a.g, 'opacity', 1);
      const centre = omni ? 0 : s.smoothBearing;
      attrNum(a.outer, 'stroke-width', stroke, 10);
      attrStr(a.outer, 'stroke', `rgb(${rgb})`);
      styleNum(a.outer, 'opacity', alpha, 200);
      setArc(a.outer, centre, width);

      if (showInner) {
        attrNum(a.inner, 'stroke-width', Math.max(1, stroke * 0.5), 10);
        attrStr(a.inner, 'stroke', `rgb(${rgb})`);
        styleNum(a.inner, 'opacity', alpha * 0.62, 200);
        setArc(a.inner, centre, Math.max(10, width * (spotted ? 1 : 0.72)));
      } else {
        styleNum(a.inner, 'opacity', 0);
      }

      if (showNotch) {
        const cx = this._w / 2, cy = this._h / 2;
        const rad = (centre - 90) * Math.PI / 180;
        const r1 = this._ringR - 9, r0 = this._ringR - 20;
        attrNum(a.notch, 'x1', cx + Math.cos(rad) * r1, 10);
        attrNum(a.notch, 'y1', cy + Math.sin(rad) * r1, 10);
        attrNum(a.notch, 'x2', cx + Math.cos(rad) * r0, 10);
        attrNum(a.notch, 'y2', cy + Math.sin(rad) * r0, 10);
        attrNum(a.notch, 'stroke-width', 2.2, 10);
        attrStr(a.notch, 'stroke', `rgb(${rgb})`);
        styleNum(a.notch, 'opacity', alpha * 0.9, 200);
      } else {
        styleNum(a.notch, 'opacity', 0);
      }
    }
  }

  _mixWarm(t) {
    // Two fixed endpoints, quantised to whole channel steps so the string only rebuilds when the
    // colour actually changes on screen.
    const a = C.warm.split(','), b = C.attention.split(',');
    const r = Math.round(+a[0] + (+b[0] - +a[0]) * t);
    const g = Math.round(+a[1] + (+b[1] - +a[1]) * t);
    const bl = Math.round(+a[2] + (+b[2] - +a[2]) * t);
    return `${r},${g},${bl}`;
  }

  // ===============================================================================================
  // NOISE — so a player can build a mental model of their own loudness
  //
  // The ring's TERMINAL RADIUS is the noise's audible radius in metres, mapped so that 90 m — the
  // Night Three saw, which reaches the fire road and the canoe rack and not the boathouse
  // (`STORY.md` §4.4) — lands exactly on the detection ring, i.e. the edge of the screen. A
  // footstep is a pip. A dropped ridge beam fills the frame. Nobody has to be told this once.
  //
  // Under masking the ring is DASHED and short — the player watches the storm eat their own noise,
  // which is the entire skill ceiling of `GAME_DESIGN.md` §7.5 taught in one image.
  // ===============================================================================================

  _onNoise(p) {
    if (!this._built || this._stripped || !p) return;
    const intensity = Number(p.intensity) || 0;
    if (intensity < 0.3) return;                       // §16.3's threshold, verbatim
    const kind = typeof p.kind === 'string' ? p.kind : '';
    if (kind === 'thunder') return;                    // the sky is not the player's fault

    const pos = p.position;
    const eye = this._eye(_v1);
    let mine = true, bearing = NaN;
    if (pos && eye && Number.isFinite(pos.x)) {
      const dx = pos.x - eye.x, dz = pos.z - eye.z;
      const d2 = dx * dx + dz * dz;
      mine = d2 <= 9;                                  // NoiseSystem's own 3 m attribution radius
      if (!mine) {
        if (d2 > 1600) return;                         // §16.3: camper voices within 40 m only
        if (!this._dirAudioIndicator) return;          // TODO(api): settings.directionalAudioIndicator
        bearing = Math.atan2(dx, -dz) - this._cameraYaw();
      }
    }

    // Rate-limit: a held saw emits continuously and eight rings a second is a strobe, not a HUD.
    if (mine) {
      if (this._noiseGate > 0) return;
      this._noiseGate = 0.22;
    }

    // Ask NoiseSystem for the real radius — the number the campers are actually judged against.
    let metres = Number(p.radius) || 0;
    let masked = false;
    const ns = this._sys('NoiseSystem');
    try {
      const ml = Number(ns?.maskLevel) || 0;
      masked = ml > 0.25;
      if (ns && typeof ns.audibleRadius === 'function' && ns.recentNoises?.length) {
        const ev = ns.recentNoises[ns.recentNoises.length - 1];
        const r = Number(ns.audibleRadius(ev));
        if (Number.isFinite(r) && r > 0) metres = r;
      }
      if (masked) metres *= 1 - clamp01(Number(ns?.maskLevel) || 0) * 0.8;
    } catch { /* NoiseSystem is optional like everything else */ }

    this._pushRing(intensity, metres, bearing, masked);
  }

  _pushRing(intensity, metres, bearing, masked) {
    let slot = null;
    for (const r of this._rings) if (!r.live) { slot = r; break; }
    if (!slot) {
      slot = this._rings[0];
      for (const r of this._rings) if (r.t > slot.t) slot = r;
    }
    const frac = clamp(metres / G.noiseMaxMetres, 0, 1.7);
    slot.live = true;
    slot.t = 0;
    slot.r0 = this._ringR * 0.05;
    slot.r1 = this._ringR * (0.10 + 0.92 * frac);
    slot.dur = G.noiseLife * (0.72 + 0.5 * clamp01(frac));
    slot.alpha = clamp(0.14 + 0.24 * intensity, 0.12, 0.40) * (masked ? 0.55 : 1);
    slot.bearing = bearing;
    styleStr(slot.node, 'strokeDasharray', masked ? '5 7' : 'none');
    attrNum(slot.node, 'stroke-width', masked ? 1.0 : 1.5, 10);
    attrStr(slot.node, 'stroke', `rgba(${C.warm},1)`);
    if (Number.isFinite(bearing)) {
      attrStr(slot.node, 'pathLength', '1000');
      setArc(slot.node, this._wrapDeg(bearing * 180 / Math.PI), 84);
    } else if (!masked) {
      slot.node.style.strokeDasharray = 'none';
      const m = slot.node.__hud; if (m) { m.arcLen = undefined; m.arcOff = undefined; }
    }
  }

  _updateNoise(dt) {
    if (this._noiseGate > 0) this._noiseGate -= dt;
    const rm = this._reducedMotion;
    for (const r of this._rings) {
      if (!r.live) continue;
      r.t += dt;
      const t = clamp01(r.t / r.dur);
      if (t >= 1) { r.live = false; styleNum(r.node, 'opacity', 0); continue; }
      // easeOutCubic: the ring leaves fast and dies slow, the shape of a real transient.
      const e = rm ? 1 : 1 - Math.pow(1 - t, 3);
      const rr = r.r0 + (r.r1 - r.r0) * e;
      const fade = rm ? (1 - t) : (1 - t) * (1 - t);
      attrNum(r.node, 'r', rr, 4);
      styleNum(r.node, 'opacity', (this._stripped || this._paused) ? 0 : r.alpha * fade, 200);
    }
  }

  // ===============================================================================================
  // THE THUNDER-MASK WINDOW
  //
  // `GAME_DESIGN.md` §7.5, restated in `NoiseSystem.js`'s own header: "a mechanic the player cannot
  // see coming is not a mechanic." Two shapes, both outside the detection ring so they never
  // collide with it:
  //
  //   INCOMING (flash seen, thunder not yet arrived)  a DASHED ring that GROWS clockwise from
  //                                                   12 o'clock as the wave closes. It fills as
  //                                                   the thunder gets nearer.
  //   OPEN     (cover available now)                  the ring goes SOLID at full circumference
  //                                                   and DRAINS clockwise. What is left is what
  //                                                   you have left.
  //
  // Dashed→solid is a topology change, legible without colour and without a number, and it is the
  // difference between "get ready" and "go". A deaf player additionally gets §16.3's caption.
  // ===============================================================================================

  _updateMask(dt) {
    const ring = this._maskRing;
    const open = this._maskRemaining > 0.01;
    const incoming = !open && this._maskIncoming > 0.01 && this._maskIncoming < 14;

    if (this._stripped || this._paused || (!open && !incoming)) {
      styleNum(ring, 'opacity', 0);
      if (this._maskWasOpen && !open) this._maskWasOpen = false;
      if (!incoming) this._maskWasIncoming = false;
      return;
    }

    if (open) {
      if (!this._maskWasOpen) {
        this._maskWasOpen = true;
        this._maskWasIncoming = false;
        this._caption(`[thunder — ${Math.max(1, Math.round(this._maskRemaining))} seconds]`);
      }
      const frac = clamp01(this._maskRemaining / Math.max(this._maskSpan, 0.5));
      styleStr(ring, 'strokeDasharray', '');
      attrNum(ring, 'stroke-width', 2.4, 10);
      attrStr(ring, 'stroke', `rgba(${C.paper.length ? '242,239,230' : '242,239,230'},1)`);
      // Drains clockwise from 12 o'clock: the arc starts at 12 and its LENGTH is the time left.
      setArc(ring, frac * 180, frac * 360);
      let a = 0.34;
      if (!this._reducedMotion && frac < 0.28) a *= 0.72 + 0.28 * Math.sin(this._t * TAU * 2.4);
      styleNum(ring, 'opacity', a, 200);
      return;
    }

    // Incoming. Grows as the wave arrives; dashed so it can never be mistaken for cover.
    if (!this._maskWasIncoming) { this._maskWasIncoming = true; this._maskWasOpen = false; }
    const t = 1 - clamp01(this._maskIncoming / 12);
    styleStr(ring, 'strokeDasharray', '');
    attrNum(ring, 'stroke-width', 1.3, 10);
    attrStr(ring, 'stroke', 'rgba(242,239,230,1)');
    setArc(ring, t * 180, t * 360);
    styleNum(ring, 'opacity', 0.10 + 0.10 * t, 200);
    // Dash it. `setArc` owns strokeDasharray, so the dashes are painted by the stroke pattern on a
    // second pass: a short dash array multiplied into the segment length would fight the arc, so
    // instead the incoming ring is distinguished by being HALF the stroke width and dimmer, plus
    // the caption below. Shape + weight + caption: three channels, no hue.
    if (this._maskIncoming < 3.2 && !this._maskIncomingCaptioned) {
      this._maskIncomingCaptioned = true;
      this._caption(`[thunder — ${Math.max(1, Math.round(this._maskIncoming))} seconds]`);
    }
    if (this._maskIncoming > 4) this._maskIncomingCaptioned = false;
  }

  /**
   * `GAME_DESIGN.md` §16.3 — mechanically relevant non-verbal sound, captioned, because a deaf
   * player cannot use thunder masking otherwise. It rides the subtitle lane and it obeys
   * `settings.subtitles` like everything else in it.
   */
  _caption(text) {
    if (!this._subtitlesOn || this._stripped) return;
    this._pushSub(text, 0, '0', 1700, true);
  }

  // ===============================================================================================
  // RETICLE
  //
  // ART §13.8, verbatim: "a single 2 px #ffffff dot at 55% opacity with a 1 px #14181a outline."
  // It becomes a shape only when a verb exists, and it goes back to being a dot the instant one
  // does not. Nothing about it is animated except the cross-fade, which `reducedMotion` shortens
  // to 60 ms.
  // ===============================================================================================

  _updateReticle(dt) {
    const hide = this._stripped || this._paused || this._blueprintOpen || this._hidden;
    styleNum(this._ret, 'opacity', hide ? 0 : 1, 100);
    if (hide) return;

    const verb = this._verb;
    if (verb !== this._verbShown) {
      if (this._verbShown && this._retVerbs[this._verbShown]) {
        styleNum(this._retVerbs[this._verbShown], 'opacity', 0);
      }
      this._verbShown = verb;
    }
    if (verb && this._retVerbs[verb]) styleNum(this._retVerbs[verb], 'opacity', 0.9);

    // The dot recedes as the shape arrives; it never disappears, so the aim point is never lost.
    const target = verb ? 1 : 0;
    this._reticleFocus += (target - this._reticleFocus) * Math.min(1, dt * (this._reducedMotion ? 30 : 14));
    const f = this._reticleFocus;
    styleNum(this._retDot, 'opacity', 0.55 - 0.34 * f, 100);
    styleNum(this._retDotRing, 'opacity', 0.55 - 0.34 * f, 100);

    // The seating band. Only when BuildSystem asks (`showMeter` — `story` difficulty or hints).
    if (this._seatingP >= 0) {
      styleNum(this._seatG, 'opacity', 0.85);
      setArc(this._seatFill, this._seatingP * 180, this._seatingP * 360);
      const cx = 22, cy = 22;
      const tick = (node, v) => {
        const rad = (v * 360 - 90) * Math.PI / 180;
        attrNum(node, 'x1', cx + Math.cos(rad) * 12.4, 100);
        attrNum(node, 'y1', cy + Math.sin(rad) * 12.4, 100);
        attrNum(node, 'x2', cx + Math.cos(rad) * 17.6, 100);
        attrNum(node, 'y2', cy + Math.sin(rad) * 17.6, 100);
      };
      tick(this._seatLo, this._seatLoV);
      tick(this._seatHi, this._seatHiV);
    } else {
      styleNum(this._seatG, 'opacity', 0);
    }
  }

  // ===============================================================================================
  // PROMPT
  //
  // A key glyph and a PICTOGRAM. §13.7 gives the game a typographic budget of two strings and this
  // is not one of them — but a keycap label is an *input legend*, not world text, and a player who
  // does not know which key opens the manual is not being told a story, they are stuck. So: the cap
  // carries the key and nothing else, at 10 px, and the verb is always a drawing.
  // ===============================================================================================

  _updatePrompt(dt) {
    const card = this._promptCard;
    let icon = null, key = null, word = '', hold = 0;

    if (this._promptForced && this._promptForcedLeft > 0) {
      if (this._promptForcedLeft !== Infinity) this._promptForcedLeft -= dt;
      icon = this._forcedIcon; key = this._forcedKey; word = this._forcedWord; hold = this._forcedHold;
    } else {
      this._promptForced = false;
      if (this._verb && this._verbKey !== null) {
        icon = this._verb;
        key = this._verbKey;
        hold = this._verbHold;
      } else if (this._manualHint > 0 && !this._manualEverOpened) {
        icon = 'manual';
        key = 'blueprint';
      }
    }

    const off = this._stripped || this._paused || this._blueprintOpen || this._hidden
      || (!icon && !word);
    if (off) {
      if (this._promptOn) { this._promptOn = false; card.dataset.on = '0'; }
      return;
    }

    if (icon !== this._promptIcon) {
      this._promptIcon = icon;
      const glyph = icon ? PICTO[icon] : null;
      this._paintGlyph(this._promptPaths, glyph, icon === 'blocked' ? this._accent : C.ink);
      this._promptSvg.style.display = glyph ? 'block' : 'none';
    }

    if (key !== this._promptKey) {
      this._promptKey = key;
      let label = null, wide = false, showCap = true;
      if (key === 'mouse-left' || key === 'mouse-right') { label = key === 'mouse-left' ? '◧' : '◨'; }
      else if (typeof key === 'string' && BINDINGS && BINDINGS[key]) { label = labelForAction(key); }
      else if (typeof key === 'string') { label = key.length <= 5 ? key.toUpperCase() : null; }
      if (label === null) { wide = true; label = ''; }
      if (!key) showCap = false;
      setText(this._promptCapLabel, label);
      this._promptCap.classList.toggle('wide', wide);
      this._promptCap.style.display = showCap ? 'grid' : 'none';
    }

    if (word !== this._promptWord) {
      this._promptWord = word;
      setText(this._promptWordEl, word);
      this._promptWordEl.style.display = word ? 'block' : 'none';
    }

    // The hold ring on the cap. A hold verb (force-place at 3.0 s, PROVOKE, the silent 2.1 s set
    // down) is the only thing in the game with a progress readout, and it lives on the key.
    if (hold > 0.001) {
      styleNum(this._promptHold, 'opacity', 1, 100);
      setArc(this._promptHoldArc, hold * 180, hold * 360);
    } else {
      styleNum(this._promptHold, 'opacity', 0, 100);
    }

    if (!this._promptOn) { this._promptOn = true; card.dataset.on = '1'; }
  }

  /** Paint a pictogram into a pooled path list. Called on change, never on a steady frame. */
  _paintGlyph(paths, glyph, colour) {
    const n = glyph ? Math.min(glyph.length, paths.length) : 0;
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      if (i >= n) { attrStr(p, 'd', ''); continue; }
      const spec = glyph[i];
      attrStr(p, 'd', spec[0]);
      attrNum(p, 'stroke-width', spec[1], 100);
      attrStr(p, 'stroke', spec[4] ? this._accent : colour);
      attrStr(p, 'fill', spec[2] ? (spec[4] ? this._accent : colour) : 'none');
      attrStr(p, 'stroke-dasharray', spec[3] || '');
    }
  }

  // ===============================================================================================
  // CARRY
  //
  // A line drawing in the manual's hand, of the thing in your hands, and one dimension rule under
  // it that BOWS. `GAME_DESIGN.md` §6.2 already punishes mass through speed, turn rate, crouch and
  // sprint gates and a ×2.6 footstep multiplier; the player can feel all of that. What they cannot
  // feel is how close the *next* pickup takes them over a class boundary, and the bow is that.
  //
  // There is no number, no weight, no slot counter, no stamina bar. §13.8 forbids three of those
  // by name and the fourth by spirit.
  // ===============================================================================================

  _repaintCarry() {
    for (let i = 0; i < 4; i++) {
      const g = this._carryGlyphs[i];
      const type = this._carryTypes[i];
      const shape = type ? (PART_GLYPH[type] || PART_GLYPH.default) : null;
      for (let k = 0; k < g.paths.length; k++) {
        attrStr(g.paths[k], 'd', shape && k < shape.length ? shape[k] : '');
      }
      styleNum(g.g, 'opacity', shape ? 1 : 0);
    }
  }

  _updateCarry(dt) {
    const hide = this._stripped || this._paused || this._blueprintOpen || this._hidden
      || this._carryCount === 0;
    if (this._carryFade > 0) this._carryFade -= dt * 0.9;
    const base = 0.30 + 0.20 * clamp01(this._carryFade);
    styleNum(this._carryEl, 'opacity', hide ? 0 : base, 100);
    if (hide) return;

    // Sag and tilt. Both are consequences: mass first, then fatigue on top of it.
    const load = clamp01(this._carryNorm * 0.72 + this._fatigue * 0.42);
    let sag = 2 + 9 * load;
    let tilt = 1.6 * this._carryNorm;
    if (!this._reducedMotion && this._fatigue > 0.25) {
      // A tremor, not a shake: 1.1 Hz, half a pixel, and it only exists when he is tired.
      sag += Math.sin(this._t * TAU * 1.1) * 0.55 * (this._fatigue - 0.25);
    }
    const m = this._carryG.__hud || (this._carryG.__hud = {});
    const qs = Math.round(sag * 4) / 4, qt = Math.round(tilt * 10) / 10;
    if (m.sag !== qs || m.tilt !== qt) {
      m.sag = qs; m.tilt = qt;
      this._carryG.setAttribute('transform', `translate(0 ${qs}) rotate(${qt} 22 78)`);
    }

    // The load rule: a dimension line that bows under the weight it is measuring.
    const w = 8 + this._carryCount * 7;
    const bow = 1 + 9 * load;
    const dm = this._carryLoad.__hud || (this._carryLoad.__hud = {});
    const qw = Math.round(w), qb = Math.round(bow * 2) / 2;
    if (dm.w !== qw || dm.b !== qb) {
      dm.w = qw; dm.b = qb;
      this._carryLoad.setAttribute('d',
        `M${22 - qw} 92 Q22 ${92 + qb} ${22 + qw} 92 M${22 - qw} 89 V95 M${22 + qw} 89 V95`);
    }
  }

  // ===============================================================================================
  // SUBTITLES
  //
  // §13.8 asks for #ffffff / 500 / 1.05rem / bottom 12vh and a text-shadow. Everything survives
  // except the shadow: a soft scrim behind the *lane* does the same legibility work without
  // putting a 2015 glow on 1971 type. Lowercase, translucent, and placed by bearing so the reader
  // knows who spoke without being told a name.
  // ===============================================================================================

  _pushSub(text, lane, chev, ms, isCaption) {
    let slot = null;
    for (const s of this._subSlots) if (!s.live) { slot = s; break; }
    if (!slot) {
      slot = this._subSlots[0];
      for (const s of this._subSlots) if (s.t > slot.t) slot = s;
    }
    setText(slot.text, text);
    slot.node.classList.toggle('cap', !!isCaption);
    slot.chev.dataset.d = chev;
    slot.node.dataset.far = (!isCaption && Math.abs(lane) > 0.72) ? '1' : '0';
    const q = Math.round(lane * 40) / 40;
    if (slot.lane !== q) {
      slot.lane = q;
      slot.node.style.transform = `translateX(${(q * 20).toFixed(1)}%)`;
      slot.node.style.marginLeft = '0';
    }
    slot.live = true; slot.t = 0; slot.ms = ms;
    slot.node.dataset.on = '1';
  }

  _updateSubs(dt) {
    let any = false;
    for (const s of this._subSlots) {
      if (!s.live) continue;
      s.t += dt * 1000;
      if (s.t >= s.ms) { s.live = false; s.node.dataset.on = '0'; continue; }
      any = true;
    }
    const show = any && !this._paused && this._subtitlesOn;
    styleNum(this._scrim, 'opacity', show ? 1 : 0, 100);
    styleNum(this._subsEl, 'opacity', (this._paused || !this._subtitlesOn) ? 0 : 1, 100);
  }

  /** Where is this speaker, in radians relative to view forward? NaN if we cannot know. */
  _bearingToSpeaker(speaker) {
    if (!speaker || typeof speaker !== 'string') return NaN;
    const list = this._camperList;
    if (!list) return NaN;
    const eye = this._eye(_v1);
    if (!eye) return NaN;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c || c.id !== speaker) continue;
      const p = c.position;
      if (!p || !Number.isFinite(p.x)) return NaN;
      const dx = p.x - eye.x, dz = p.z - eye.z;
      if (dx * dx + dz * dz < 1e-4) return 0;
      let b = Math.atan2(dx, -dz) - this._cameraYaw();
      while (b > Math.PI) b -= TAU;
      while (b < -Math.PI) b += TAU;
      return b;
    }
    return NaN;
  }

  // ===============================================================================================
  // TOASTS
  // ===============================================================================================

  _updateToasts(dt) {
    for (const t of this._toasts) {
      if (!t.live) {
        // Let the fade finish before the card leaves the layout, or it snaps out.
        if (t.hide > 0) {
          t.hide -= dt * 1000;
          if (t.hide <= 0) t.node.style.display = 'none';
        }
        continue;
      }
      if (t._arm) { t._arm = false; t.node.dataset.on = '1'; }
      t.t += dt * 1000;
      if (t.t >= t.ms) { t.live = false; t.t = 0; t.hide = 340; t.node.dataset.on = '0'; }
    }
    styleNum(this._toastsEl, 'opacity', (this._paused || this._stripped) ? 0 : 1, 100);
  }

  // ===============================================================================================
  // VISIBILITY
  // ===============================================================================================

  _updateVisibility() {
    const hidden = this._hidden || this._paused;
    const v = hidden ? '1' : '0';
    if (this._root.dataset.hidden !== v) this._root.dataset.hidden = v;
  }

  // ===============================================================================================
  // WORLD READS
  // ===============================================================================================

  _eye(out) {
    const pl = this._sys('Player');
    try {
      const p = pl?.eyePosition ?? pl?.position;
      if (p && Number.isFinite(p.x)) return out.copy(p);
    } catch { /* fall through to the camera */ }
    const cam = this.ctx.camera;
    if (cam?.position && Number.isFinite(cam.position.x)) return out.copy(cam.position);
    return null;
  }

  _forwardVec(out) {
    const cam = this.ctx.camera;
    if (cam && typeof cam.getWorldDirection === 'function') {
      try { cam.getWorldDirection(out); out.y = 0; const l = out.length(); if (l > 1e-4) { out.multiplyScalar(1 / l); return out; } } catch { /* */ }
    }
    out.set(0, 0, -1);
    return out;
  }

  _cameraYaw() {
    const cam = this.ctx.camera;
    if (cam && typeof cam.getWorldDirection === 'function') {
      try {
        cam.getWorldDirection(_v2);
        if (Number.isFinite(_v2.x)) return Math.atan2(_v2.x, -_v2.z);
      } catch { /* */ }
    }
    const pl = this._sys('Player');
    const y = Number(pl?.aimYaw);
    return Number.isFinite(y) ? y : 0;
  }

  _viewW() {
    const w = this.ctx.width | 0;
    if (w > 1) return w;
    return Math.max(1, (globalThis.innerWidth | 0) || 1280);
  }

  _viewH() {
    const h = this.ctx.height | 0;
    if (h > 1) return h;
    return Math.max(1, (globalThis.innerHeight | 0) || 720);
  }

  _wrapDeg(d) {
    let v = d % 360;
    if (v > 180) v -= 360;
    if (v < -180) v += 360;
    return v;
  }
}

export default HUD;
