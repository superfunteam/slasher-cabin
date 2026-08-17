/**
 * Title screen, pause, settings, and the night-end assembly report.
 *
 * OWNER: UI agent. Owns nothing outside this file.
 *
 * ---------------------------------------------------------------------------------------------
 * THE THESIS (ART_DIRECTION §13.10)
 *
 * Flat, bright, clinical paper over dark volumetric horror. The sheet never receives a
 * post-process pass, never a perspective trick beyond the physical unfold, and never a colour
 * that is not `paper` / `ink` / one `red`. The 3D world stays alive behind it. The player's
 * pupils have to adjust between the two, and every time they do, the game re-tells its own joke.
 *
 * THE REGISTER TEST (GAME_DESIGN §15.3) — binding on every string in this file:
 *
 *   Read the line aloud in the voice of a document that does not know a person is reading it.
 *   If it lands as a joke, it must land because the SITUATION is absurd — never because the
 *   document has noticed. The manual has no sense of humour. It has a job.
 *
 * So: no puns, no winks, no euphemism for a person, no kill count, nothing arch. `JOINS, NOT AS
 * ILLUSTRATED` is a phrase a real assembly document prints. `JOINS, ORIENTED CREATIVELY` is a
 * comedian's phrase wearing a document's clothes, and `Script.assemblyReport` still carries the
 * v1.0 copy that GAME_DESIGN §15.3 deletes with prejudice. We render the reconciled set.
 *
 * ---------------------------------------------------------------------------------------------
 * DOCUMENT RECONCILIATION — where the bibles disagree, and what shipped
 *
 * 1. Card copy. `Script.assemblyReport.rows` is v1.0 (`JOINS, ORIENTED CREATIVELY`, `PERSONS WHO
 *    EXPRESSED CONCERN`, the red `PLEASE ASSEMBLE ALONE.`). GAME_DESIGN §15.3 quotes that exact
 *    set and deletes it, and §15.2 supplies the replacement line table. §15.2 wins. Script is
 *    still the source for night titles, sub-lines and slot counts.
 * 2. Line 11's label. §15.2 calls it `ASSEMBLY QUALITY`; STORY §12.3 and `Script` call it
 *    `CUSTOMER SATISFACTION`. Both pass the register test (a real product card asks you to rate
 *    your satisfaction, in circles). We print `CUSTOMER SATISFACTION` and compute it with §15.1's
 *    `assemblyQuality` formula, unmodified.
 * 3. The Night Seven card. §15.2 says one line, `ASSEMBLY COMPLETE.` STORY §12.3 says one page:
 *    `HJEM` over `VIK & SØN`, no red, no figure, no metrics. Tone is law — STORY wins.
 * 4. §13.7's "no Latin characters anywhere" is scoped to the diegetic manual pages and the 3D
 *    world. STORY §12.2/§12.3 and GAME_DESIGN §15.2 both print type on these cards, so the
 *    meta-UI (title / pause / settings / report) carries type. The manual itself does not.
 *
 * ---------------------------------------------------------------------------------------------
 * CAMERA AND POINTER LOCK
 *
 * The title's slow forest drift is written to `ctx.camera` in `update()`. Menu is registered
 * after Player and before Shots (see `src/main.js`), so Menu's pose wins over Player's for the
 * frame and the screenshot harness still wins over Menu. Player writes absolute values every
 * frame, so control hands back with no residue the moment we stop writing.
 *
 * Pointer lock is owned here: released whenever a menu opens, requested on start and resume.
 * Browsers throttle `requestPointerLock` for ~1.25 s after a user-initiated Escape, so a failed
 * request is retried on a timer and, failing that, on the next pointer-down over the canvas.
 */
import { Log } from '../core/Log.js';
import { Rand } from '../core/Rand.js';
import { Script } from '../story/Script.js';

/* ============================================================================================
 * 0. CONSTANTS
 * ========================================================================================== */

const ROOT_ID = 'slasher-menu';
const STYLE_ID = 'slasher-menu-style';

/** ART_DIRECTION §2.2. */
const PAPER = '#f2efe6';
const INK = '#14181a';
const RED = '#d92b2b';

/** GAME_DESIGN §16.2 — the only load-bearing colour, redundantly encoded everywhere anyway. */
const RED_BY_VISION = {
  none: RED,
  protan: '#0b57d0',
  deutan: '#0b57d0',
  tritan: '#c2185b',
};

/** STORY §12.1. Real Norwegian building terms; the joke is better for being true. */
const ASSEMBLY_NAMES = {
  1: 'GRUNNMUR',
  2: 'BJELKELAG',
  3: 'REISVERK',
  4: 'KLEDNING',
  5: 'TAKSTOL',
  6: 'VINDU & DØR',
  7: 'HJEM',
};

/** ART_DIRECTION §13.7 — the camp's property stamp, and the whole typographic budget. */
const PROPERTY_STAMP = 'WANAKA 7';

/**
 * `Script.articleScheme` — format `YYYY-NNN`, and the numbers are not random.
 * 1962 is the fire and the survey marker. 141 is the fourth pencil mark on the doorframe,
 * in centimetres. Nobody is ever told this.
 */
const ARTICLE_NO = '1962-141';
const MAKERS_MARK = 'VIK & SØN';

/** STORY §12.2 — hold in seconds. Nights Five and Seven have no sub-line and 29% longer. */
const TITLE_CARD_HOLD_MS = 2400;
const TITLE_CARD_HOLD_LONG_MS = 3100;

/** Phases in which Escape should raise the pause sheet and gameplay owns the pointer. */
const PLAYABLE_PHASES = new Set(['briefing', 'build', 'chase']);

/** ART_DIRECTION §13.2 — exactly four stroke widths, at page height 900. Never anything else. */
const WEIGHTS = { hairline: 0.75, thin: 1.5, medium: 2.5, heavy: 4.0 };

/* ============================================================================================
 * 0b. THE FIRST-SCREEN PRELOAD
 *
 * MEASURED, production build, cold cache, 1.5 MB/s shared link (the harness in
 * ARCHITECTURE §11d's spirit: same instrument on both sides of the change):
 *
 *   boot plate visible        1,666 ms
 *   TITLE SCREEN SHOWN        6,805 ms
 *   splash-title.png finished 11,527 ms   <- its own background, 4.7 s LATER
 *
 * The title booklet was composited against a black rectangle for four and a half seconds and the
 * forest photograph then cut in behind it. For a game whose whole visual thesis is flat bright
 * paper against wet darkness, that is the thesis arriving after the punchline.
 *
 * Two causes, both here in this file, both fixed below.
 *
 * 1. NOTHING WAITED. `_probeImages()` was fire-and-forget and `init()` showed the title the
 *    instant the engine was up, whatever had or had not arrived. Now `_maybeReveal()` is the
 *    only path to the title screen and it will not run until every unit below reports done.
 *
 * 2. THE PIPE WAS FULL OF THINGS THE FIRST SCREEN DOES NOT USE. Measured on that same load,
 *    boot spent its first seconds fetching, concurrently with the splash:
 *
 *      nightcard-texture.png  1,835 KB   the flat card shown at `night:begin` — minutes away
 *      manual-cover.png       1,559 KB   the PAUSE sheet's cover — not reachable from the title
 *      loading-plate.png        833 KB   the boot plate's own photo, which finished at 8,092 ms,
 *                                        i.e. 1.3 s AFTER the boot plate it decorates was gone
 *
 *    4.2 MB of contention in front of the one image the player is actually looking at. The
 *    first-screen set is now exactly two files; the other two are deferred until the title is
 *    up (§'DEFERRED', below) and `loading-plate.png` is not requested at all — the boot plate
 *    draws itself in `svgContentsPlate()`, which costs no bytes, is on screen in the first
 *    frame, and cannot pop halfway through the load the way a photograph swapping in did.
 *
 * WEIGHTS: how much of the bar each unit is worth, not how long it will take. Nothing here is a
 * clock. Units 2 and 4 advance by BYTES READ off the response stream, so the bar has genuine
 * sub-unit resolution; the rest step on their own completion. The bar reaches 1.0 when, and only
 * when, all six have reported — it is arithmetically incapable of finishing before the assets do.
 * ========================================================================================== */

const SPLASH_SRC = '/img/splash-title.png';
const TITLE_ART_SRC = '/img/title-treatment.png';
const COVER_SRC = '/img/manual-cover.png';
const CARD_SRC = '/img/nightcard-texture.png';

/** Six units, six roundels on the plate. Every one is an event, never a timer. */
const PRELOAD_UNITS = [
  { id: 'fonts', weight: 0.03 },        // document.fonts.ready
  { id: 'splashBytes', weight: 0.42 },  // splash-title.png, streamed against content-length
  { id: 'splashDecode', weight: 0.05 }, // ...and decoded to a bitmap, which is the visible hitch
  { id: 'artBytes', weight: 0.28 },     // title-treatment.png, fetched and decoded
  { id: 'systems', weight: 0.12 },      // every heavy system has init()ed (Menu is registered last)
  { id: 'frame', weight: 0.10 },        // engine:booted, and a real frame has been presented
];

/** The plate may not vanish faster than this, or a warm cache turns it into a flash. */
const MIN_PLATE_MS = 640;
/** After the last unit lands, hold long enough for the measure to be seen arriving. */
const PLATE_SETTLE_MS = 300;
/** The title sheet's own entrance runs BEHIND the plate, so the reveal is one fade of one
 *  finished screen rather than two things moving at once. Must exceed `--sc-in` (220 ms). */
const SHEET_SETTLE_MS = 240;
const PLATE_FADE_MS = 460;
/**
 * A ceiling on the asset wait alone. A player on a bad link must never be held at a loading
 * screen by an optional decoration: past this the title opens on its drawn fallbacks, which are
 * finished screens, and a late splash is faded in rather than cut in.
 */
const ASSET_CEILING_MS = 12000;
/** Absolute last resort: a boot plate that outlives the boot is the one failure that looks
 *  like a crash. */
const PLATE_FAILSAFE_MS = 45000;

/* ============================================================================================
 * 1. SETTINGS TABLE
 *
 * Grouped like a specification table, not like a game menu: sections are numbered, every row is
 * label / control / value on a hairline rule, and continuous values are drawn as the manual's
 * own dimension line (ART_DIRECTION §13.4, "double-headed span").
 *
 * Every `key` here exists in `Settings.DEFAULTS`, so every one of them round-trips through
 * localStorage. GAME_DESIGN §16 requests a further dozen keys (creakAssist, holdToCarry,
 * lightningFlashes, subtitleSize, manualContrast …); `Settings.load()` drops keys it does not
 * know, so surfacing them here would produce controls that silently forget themselves.
 * TODO(api): when Settings.DEFAULTS grows those keys, add rows here — the table is data.
 * ========================================================================================== */

const SETTINGS_SECTIONS = [
  {
    n: '01', name: 'DISPLAY',
    rows: [
      { key: 'quality', label: 'DETAIL LEVEL', type: 'seg',
        options: [['low', 'LOW'], ['medium', 'MED'], ['high', 'HIGH'], ['ultra', 'ULTRA']] },
      { key: 'dprCap', label: 'RENDER SCALE', type: 'range', min: 0.5, max: 2, step: 0.25, unit: '×', dp: 2 },
      { key: 'fov', label: 'FIELD OF VIEW', type: 'range', min: 55, max: 105, step: 1, unit: '°', dp: 0 },
    ],
  },
  {
    n: '02', name: 'CONTROL',
    rows: [
      { key: 'mouseSensitivity', label: 'LOOK SENSITIVITY', type: 'range', min: 0.2, max: 3, step: 0.05, unit: '×', dp: 2 },
      { key: 'invertY', label: 'INVERT VERTICAL LOOK', type: 'bool' },
    ],
  },
  {
    n: '03', name: 'SOUND',
    rows: [
      { key: 'masterVolume', label: 'MASTER', type: 'range', min: 0, max: 1, step: 0.01, unit: '%', pct: true },
      { key: 'sfxVolume', label: 'EFFECTS', type: 'range', min: 0, max: 1, step: 0.01, unit: '%', pct: true },
      { key: 'musicVolume', label: 'SCORE', type: 'range', min: 0, max: 1, step: 0.01, unit: '%', pct: true },
      { key: 'voiceVolume', label: 'VOICE', type: 'range', min: 0, max: 1, step: 0.01, unit: '%', pct: true },
      { key: 'subtitles', label: 'SUBTITLES', type: 'bool' },
    ],
  },
  {
    n: '04', name: 'IMAGE',
    rows: [
      { key: 'motionBlur', label: 'MOTION BLUR', type: 'bool' },
      { key: 'filmGrain', label: 'FILM GRAIN', type: 'bool' },
      { key: 'chromaticAberration', label: 'CHROMATIC ABERRATION', type: 'bool' },
      { key: 'vignette', label: 'VIGNETTE', type: 'bool' },
      { key: 'headBob', label: 'HEAD MOVEMENT', type: 'bool' },
    ],
  },
  {
    n: '05', name: 'ASSEMBLY',
    rows: [
      { key: 'difficulty', label: 'DIFFICULTY', type: 'seg',
        options: [['story', 'STORY'], ['standard', 'STANDARD'], ['nightmare', 'HARD']] },
      { key: 'puzzleHints', label: 'ASSEMBLY HINTS', type: 'auto',
        options: [['off', 'OFF'], ['standard', 'STANDARD'], ['generous', 'GENEROUS']] },
    ],
  },
  {
    n: '06', name: 'ACCESSIBILITY',
    rows: [
      { key: 'colorblind', label: 'COLOUR VISION', type: 'seg',
        options: [['none', 'STD'], ['protan', 'PROTAN'], ['deutan', 'DEUTAN'], ['tritan', 'TRITAN']] },
      { key: 'reducedMotion', label: 'REDUCED MOTION', type: 'bool' },
    ],
  },
];

/* ============================================================================================
 * 2. THE REPORT'S LINE TABLE — GAME_DESIGN §15.2
 *
 * Twelve lines on Nights 1–3. From Night 4 the card LOSES lines, one group per night, until
 * Night 7's card has none. Nothing announces the drop. Lines per night: 12, 12, 12, 11, 9, 6, 1.
 * `untilNight` is the last night on which the line is printed.
 * ========================================================================================== */

const REPORT_LINES = [
  { id: 'partsInstalled', label: 'PARTS INSTALLED', untilNight: 6 },
  { id: 'joinsCorrect', label: 'JOINS, CORRECT', untilNight: 6 },
  { id: 'joinsNotAsIllustrated', label: 'JOINS, NOT AS ILLUSTRATED', untilNight: 6 },
  { id: 'joinsRequiringReplacement', label: 'JOINS, REQUIRING REPLACEMENT', untilNight: 6 },
  { id: 'fastenersSupplied', label: 'FASTENERS, SUPPLIED', untilNight: 4 },
  { id: 'fastenersRequired', label: 'FASTENERS, REQUIRED', untilNight: 4 },
  { id: 'creaks', label: 'AUDIBLE FROM STRUCTURE', untilNight: 5 },
  { id: 'metresHauled', label: 'DISTANCE CARRIED', untilNight: 5 },
  { id: 'timeRemaining', label: 'TIME REMAINING', untilNight: 5 },
  { id: 'satisfaction', label: 'CUSTOMER SATISFACTION', untilNight: 6 },
];

/** STORY §12.3 — the grade is BJØRN's posture. No number is ever the headline. */
function postureFor(quality, night) {
  if (night === 6) return 'head-tilt-confused';
  if (quality >= 95) return 'thumbs-up';
  if (quality >= 60) return 'standing-neutral';
  if (quality >= 30) return 'shrugging-at-missing-hardware';
  return 'wagging-finger-no';
}

/**
 * The stamped verdict. Every one of these is a phrase a real inspection stamp carries.
 * `ACCEPTED WITH DEVIATION` is a genuine manufacturing-QC disposition. It is not a joke.
 */
function verdictFor(quality, failed) {
  if (failed) return 'WITHHELD';
  if (quality >= 95) return 'PASSED';
  if (quality >= 60) return 'ACCEPTED';
  if (quality >= 30) return 'ACCEPTED WITH DEVIATION';
  return 'REFERRED';
}

/* ============================================================================================
 * 3. SMALL PURE HELPERS
 * ========================================================================================== */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Manual thousands grouping — no locale variance, so screenshots are reproducible. */
function group(n) {
  const i = Math.round(Number(n) || 0);
  const s = Math.abs(i).toString();
  let out = '';
  for (let k = 0; k < s.length; k++) {
    if (k > 0 && (s.length - k) % 3 === 0) out += ',';
    out += s[k];
  }
  return (i < 0 ? '-' : '') + out;
}

function mmss(seconds) {
  const t = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}

function hhmmss(seconds) {
  const t = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(t / 3600);
  return `${h < 10 ? '0' : ''}${h}:${mmss(t % 3600)}`;
}

/** `NIGHT THREE — DO NOT OVERTIGHTEN` -> `DO NOT OVERTIGHTEN`. */
function stepInstruction(night) {
  const def = Script?.nightDef?.(night) ?? null;
  const title = def?.title ?? '';
  const dash = title.indexOf('—');
  return dash >= 0 ? title.slice(dash + 1).trim() : title.trim();
}

/* ============================================================================================
 * 4. DRAWN MARKS
 *
 * Everything here is stroke data, so a font failure or a missing PNG cannot touch it, and so the
 * fallback screen is a finished screen rather than a degraded one.
 * ========================================================================================== */

const ISO_R = [0.8660254, 0.5];      // dimetric 30°, to the right
const ISO_L = [-0.8660254, 0.5];     // dimetric 30°, to the left

/** Project a dimetric lattice point (right, left, up) into 2D. */
function iso(r, l, u) {
  return [r * ISO_R[0] + l * ISO_L[0], r * ISO_R[1] + l * ISO_L[1] - u];
}

function poly(points, w, opts = {}) {
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ')
    + (opts.closed ? ' Z' : '');
  const dash = opts.dash ? ` stroke-dasharray="${opts.dash}"` : '';
  const fill = opts.fill ?? 'none';
  return `  <path d="${d}" fill="${fill}" stroke="${opts.stroke ?? 'currentColor'}" `
    + `stroke-width="${w}"${dash}/>`;
}

/**
 * The fallback title illustration: a dimetric gable cabin, drawn as if measured, because he
 * measured it. Used when `public/img/title-treatment.png` is absent.
 */
function svgCabin() {
  const W = 3.1, D = 2.5, H = 2.35, RIDGE = 1.15, OVER = 0.22;
  const S = 46;
  const P = (r, l, u) => { const p = iso(r, l, u); return [p[0] * S + 200, p[1] * S + 150]; };

  const a = P(0, 0, 0), b = P(W, 0, 0), c = P(0, D, 0), dd = P(W, D, 0);
  const A = P(0, 0, H), B = P(W, 0, H), C = P(0, D, H), Dp = P(W, D, H);
  const p1 = P(0, D / 2, H + RIDGE), p2 = P(W, D / 2, H + RIDGE);
  const e1 = P(-OVER, -OVER, H - 0.06), e2 = P(W + OVER, -OVER, H - 0.06);
  const e3 = P(-OVER, D + OVER, H - 0.06), e4 = P(W + OVER, D + OVER, H - 0.06);
  const r1 = P(-OVER, D / 2, H + RIDGE + 0.04), r2 = P(W + OVER, D / 2, H + RIDGE + 0.04);

  const out = [];
  // Hidden geometry first, in hairline — the manual always shows you what is behind.
  out.push(poly([c, dd], WEIGHTS.hairline, { dash: '4,3' }));
  out.push(poly([dd, b], WEIGHTS.hairline, { dash: '4,3' }));
  out.push(poly([dd, Dp], WEIGHTS.hairline, { dash: '4,3' }));

  // Walls.
  out.push(poly([a, b, B, A], WEIGHTS.thin, { closed: true }));
  out.push(poly([a, c, C, A], WEIGHTS.thin, { closed: true }));
  out.push(poly([C, Dp], WEIGHTS.hairline, { dash: '4,3' }));

  // Roof planes.
  out.push(poly([e1, r1, r2, e2], WEIGHTS.thin, { closed: true }));
  out.push(poly([r1, e3, e4, r2], WEIGHTS.thin, { closed: true }));
  out.push(poly([A, p1, C], WEIGHTS.thin));
  out.push(poly([B, p2, Dp], WEIGHTS.hairline, { dash: '4,3' }));
  out.push(poly([p1, p2], WEIGHTS.medium));

  // Corrugation on the near roof plane — 11 ribs, evenly divided along the ridge.
  for (let i = 1; i < 11; i++) {
    const t = i / 11;
    const top = P(-OVER + (W + 2 * OVER) * t, D / 2, H + RIDGE + 0.04);
    const eave = P(-OVER + (W + 2 * OVER) * t, -OVER, H - 0.06);
    out.push(poly([top, eave], WEIGHTS.hairline));
  }
  // Board lines on the two visible walls.
  for (let i = 1; i < 7; i++) {
    const t = i / 7;
    out.push(poly([P(W * t, 0, 0), P(W * t, 0, H)], WEIGHTS.hairline));
  }
  for (let i = 1; i < 6; i++) {
    const t = i / 6;
    out.push(poly([P(0, D * t, 0), P(0, D * t, H)], WEIGHTS.hairline));
  }
  // The door, on the left face, with a handle. The anchor asymmetry (§13.6): it is off-centre.
  const d0 = 0.75, d1 = 1.65, dh = 1.62;
  out.push(poly([P(0, d0, 0), P(0, d1, 0), P(0, d1, dh), P(0, d0, dh)], WEIGHTS.medium, { closed: true }));
  out.push(poly([P(0, d1 - 0.16, 0.78), P(0, d1 - 0.16, 0.95)], WEIGHTS.thin));
  // Six piers.
  for (const [rr, ll] of [[0.1, 0.1], [W - 0.1, 0.1], [0.1, D - 0.1], [W / 2, 0.1], [W - 0.1, D - 0.1], [W / 2, D - 0.1]]) {
    const t0 = P(rr, ll, 0), t1 = P(rr, ll, -0.24);
    out.push(poly([t0, t1], WEIGHTS.thin));
  }
  return `<svg viewBox="0 0 400 300" role="img" aria-label="Assembled cabin, dimetric">\n`
    + out.join('\n') + `\n</svg>`;
}

/** Six hardware roundels — the contents inset, catalogue-style. Inner markup only, on a 400x68
 * grid, so it can be placed inside a larger plate as well as stand alone. */
function hardwareCells() {
  const glyphs = [
    // carriage bolt
    `  <path d="M-9 -13 a9 9 0 0 1 18 0 l0 3 -18 0 z" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <path d="M-3.2 -10 l0 22 M3.2 -10 l0 22" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <path d="M-3.2 -1 l6.4 2 M-3.2 3 l6.4 2 M-3.2 7 l6.4 2" fill="none" stroke="currentColor" stroke-width="0.75"/>`,
    // L-bracket
    `  <path d="M-11 -12 l7 0 0 19 12 0 0 6 -19 0 z" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <circle cx="-7.5" cy="-7" r="1.8" fill="none" stroke="currentColor" stroke-width="0.75"/>
  <circle cx="-7.5" cy="1" r="1.8" fill="none" stroke="currentColor" stroke-width="0.75"/>
  <circle cx="3" cy="10" r="1.8" fill="none" stroke="currentColor" stroke-width="0.75"/>`,
    // wood screw
    `  <path d="M-7 -13 l14 0 -3.5 4 -7 0 z" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <path d="M-3.5 -9 l0 15 3.5 7 3.5 -7 0 -15" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <path d="M-3.5 -6 l7 2 M-3.5 -2 l7 2 M-3.5 2 l7 2" fill="none" stroke="currentColor" stroke-width="0.75"/>`,
    // washer
    `  <circle cx="0" cy="0" r="12" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <circle cx="0" cy="0" r="4.6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <circle cx="0" cy="0" r="8.2" fill="none" stroke="currentColor" stroke-width="0.75"/>`,
    // hex key
    `  <path d="M-8 -13 l0 20 15 0" fill="none" stroke="currentColor" stroke-width="2.5"/>
  <path d="M-8 -13 l-2.6 1.5 0 3 2.6 1.5 2.6 -1.5 0 -3 z" fill="none" stroke="currentColor" stroke-width="0.75"/>`,
    // claw hammer — the grip is the only red mark on the page's hardware row
    `  <path d="M-10 -12 l9 0 0 5 -9 0 z" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <path d="M-10 -12 c-5 1 -6 5 -3.5 8 l2 -1.6 c-1.2 -1.8 -0.6 -3.6 1.5 -4.2 z" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <path d="M-2.5 -11.4 l0 3.8" fill="none" stroke="currentColor" stroke-width="0.75"/>
  <path d="M-5.6 -7 l0 20" fill="none" stroke="currentColor" stroke-width="2.5"/>
  <path d="M-5.6 5 l0 8" fill="none" stroke="var(--sc-red)" stroke-width="2.5"/>`,
  ];
  return glyphs.map((g, i) => `  <g transform="translate(${34 + i * 62} 34)">
  <circle cx="0" cy="0" r="27" fill="none" stroke="currentColor" stroke-width="1.5"/>
${g}
  </g>`).join('\n');
}

/** The roundel row as a standalone plate, 400 x 68. */
function svgHardware() {
  return `<svg viewBox="0 0 400 68" role="img" aria-label="Hardware supplied">\n`
    + hardwareCells() + `\n</svg>`;
}

/**
 * BJØRN. ART_DIRECTION §13.9 construction, with STORY §3.3's two blocking corrections applied:
 * the face is TWO FILLED DOTS at 1.42× anatomical spacing and nothing else — never a hockey
 * mask, because a mask makes him a reference to a movie instead of a copy of a drawing, and then
 * Night Six reveals nothing — and `arms-at-sides` is a tenth legal pose.
 *
 * He is never in danger and never reacts to anything frightening. That is the entire joke.
 */
const BJORN_POSES = {
  'standing-neutral': { arms: [[[48, 44], [40, 62], [36, 82]], [[72, 44], [80, 62], [84, 82]]], tilt: 0 },
  'arms-at-sides': { arms: [[[48, 44], [45, 61], [45, 81]], [[72, 44], [75, 61], [75, 81]]], tilt: 0 },
  'pointing': { arms: [[[48, 44], [40, 62], [36, 82]], [[72, 44], [86, 50], [102, 44]]], tilt: 0 },
  'thumbs-up': { arms: [[[48, 44], [45, 61], [45, 81]], [[72, 44], [84, 57], [80, 36]]], tilt: 0, thumb: 1 },
  'shrugging-at-missing-hardware': {
    arms: [[[48, 44], [33, 51], [27, 36]], [[72, 44], [87, 51], [93, 36]]], tilt: 0, palms: true,
  },
  'wagging-finger-no': { arms: [[[48, 44], [45, 61], [45, 81]], [[72, 44], [85, 55], [83, 31]]], tilt: 0, finger: 1 },
  'head-tilt-confused': { arms: [[[48, 44], [45, 61], [45, 81]], [[72, 44], [75, 61], [75, 81]]], tilt: -13 },
  'hammering': { arms: [[[48, 44], [42, 61], [40, 80]], [[72, 44], [86, 54], [80, 32]]], tilt: 0 },
};

function svgBjorn(pose) {
  const p = BJORN_POSES[pose] ?? BJORN_POSES['standing-neutral'];
  const out = [];
  const H = WEIGHTS.heavy, M = WEIGHTS.medium, T = WEIGHTS.thin;

  // Legs first so the body's fill sits over the hip joints.
  out.push(poly([[54, 71], [52, 106], [50, 138]], M));
  out.push(poly([[66, 71], [68, 106], [70, 138]], M));
  out.push(poly([[44, 139], [54, 139]], M));
  out.push(poly([[66, 139], [76, 139]], M));
  for (const j of [[52, 106], [68, 106]]) {
    out.push(`  <circle cx="${j[0]}" cy="${j[1]}" r="2.1" fill="${PAPER}" stroke="currentColor" stroke-width="${T}"/>`);
  }

  // Body: rounded rect 2.4U × 3.6U, radius 0.4U, U = head diameter / 3 = 10.
  out.push(`  <rect x="48" y="37" width="24" height="36" rx="4" ry="4" fill="${PAPER}" stroke="currentColor" stroke-width="${H}"/>`);

  // Arms, each a single stroke with a small circle joint at the elbow.
  for (const arm of p.arms) {
    out.push(poly(arm, M));
    out.push(`  <circle cx="${arm[1][0]}" cy="${arm[1][1]}" r="2.1" fill="${PAPER}" stroke="currentColor" stroke-width="${T}"/>`);
    if (p.palms) {
      out.push(`  <circle cx="${arm[2][0]}" cy="${arm[2][1]}" r="3.4" fill="${PAPER}" stroke="currentColor" stroke-width="${T}"/>`);
    }
  }
  if (p.thumb) {
    const h = p.arms[1][2];
    out.push(`  <circle cx="${h[0]}" cy="${h[1]}" r="4.2" fill="${PAPER}" stroke="currentColor" stroke-width="${M}"/>`);
    out.push(poly([[h[0] + 1.5, h[1] - 4], [h[0] + 1.5, h[1] - 11]], M));
  }
  if (p.finger) {
    const h = p.arms[1][2];
    out.push(poly([[h[0], h[1]], [h[0] - 1, h[1] - 9]], M));
  }

  // Head. A perfect circle, 3U across. Two filled dots. Nothing else, ever.
  const tilt = p.tilt ? ` transform="rotate(${p.tilt} 60 37)"` : '';
  out.push(`  <g${tilt}>
  <circle cx="60" cy="22" r="15" fill="${PAPER}" stroke="currentColor" stroke-width="${H}"/>
  <circle cx="50.6" cy="21" r="1.9" fill="currentColor"/>
  <circle cx="69.4" cy="21" r="1.9" fill="currentColor"/>
  </g>`);

  return `<svg viewBox="0 0 120 152" role="img" aria-label="Assembly figure">\n${out.join('\n')}\n</svg>`;
}

/**
 * THE BOOT PLATE, and the only progress readout in the game.
 *
 * It is drawn, not photographed. `public/img/loading-plate.png` is a 1024² PNG of a claw hammer
 * lying on two boards — 833 KB to deliver about 4 KB of line art, and measured arriving 1.3 s
 * AFTER the boot it decorates had finished. A loading screen that is itself still loading, and
 * that swaps a drawing for a photograph halfway through, is the exact defect this file is here
 * to remove. The file stays in the repo (nothing is stripped that someone might wire up), but
 * the critical path does not touch it.
 *
 * The composition is the one that was already working — six hardware roundels over a ruled
 * parts line, under 'CHECK CONTENTS BEFORE BEGINNING.' — with two marks added, and both of them
 * are readouts of real completions:
 *
 *   THE SIX BOXES (identity).  One under each roundel. It inks solid when that unit is
 *     accounted for. The page says check the contents before beginning; the contents get
 *     checked, one at a time, and then the game begins. No numeral, no word, no spinner.
 *
 *   THE DIMENSION LINE (magnitude).  ART_DIRECTION §13.4's double-headed span, unmodified:
 *     1.5 px shaft, 0.75 px extension lines, two open heads. §13.7 — 'its length carries the
 *     number' — so the measure grows from the left extension line toward the right one and the
 *     heads touch the ticks when the job is done. This is the manual's own way of stating a
 *     quantity without printing one, which is why it replaced the red bar that used to sweep
 *     back and forth here on a 2.6 s loop, reporting nothing.
 *
 * Everything is drawn once; `_setProgress()` moves two attributes and six fills.
 */
const PLATE_SPAN_X0 = 18;
const PLATE_SPAN_X1 = 382;
const PLATE_SPAN_Y = 168;

function svgContentsPlate() {
  const T = WEIGHTS.thin, H = WEIGHTS.hairline;
  const out = [];

  // Six roundels, the same inset the title sheet carries, on the same 400 x 68 grid.
  out.push(`  <g transform="translate(0 4)">\n${hardwareCells()}\n  </g>`);

  // Under them, a ruled parts line per roundel: the manual counting its own bag of fixings,
  // and under that the box that gets inked when the line is verified.
  const counts = [24, 12, 40, 40, 1, 1];
  for (let i = 0; i < 6; i++) {
    const cx = 34 + i * 62;   // must track hardwareCells()'s own 34 + i * 62 spacing
    out.push(poly([[cx - 22, 100], [cx + 22, 100]], H));
    out.push(`  <text x="${cx}" y="117" text-anchor="middle" font-size="13"
      font-family="Helvetica Neue, Helvetica, Arial, sans-serif" letter-spacing="1.2"
      fill="currentColor">${counts[i]}×</text>`);
    out.push(`  <rect class="sc-ld-box" data-i="${i}" x="${cx - 5.5}" y="126" width="11"`
      + ` height="11" fill="none" stroke="currentColor" stroke-width="${T}"/>`);
  }
  // No closing rule under the contents block. There was one, and on screen it read as a second
  // dimension line stacked on the real one — two full-width horizontals 22 units apart, the
  // upper one meaning nothing. The measure closes the block now, which is what a measure is for.

  // The measure. Extension lines mark the whole distance; the span reports how much of it is
  // accounted for. `stroke-dashoffset` reveals the shaft without scaling its stroke, and the
  // travelling head is a pure translate, so §13.2's four widths survive at every value.
  const span = PLATE_SPAN_X1 - PLATE_SPAN_X0;
  const y = PLATE_SPAN_Y;
  out.push(poly([[PLATE_SPAN_X0, y - 9], [PLATE_SPAN_X0, y + 9]], H));
  out.push(poly([[PLATE_SPAN_X1, y - 9], [PLATE_SPAN_X1, y + 9]], H));
  out.push(`  <line class="sc-ld-span" x1="${PLATE_SPAN_X0}" y1="${y}" x2="${PLATE_SPAN_X1}"`
    + ` y2="${y}" stroke="currentColor" stroke-width="${T}" stroke-linecap="butt"`
    + ` stroke-dasharray="${span}" stroke-dashoffset="${span}"/>`);
  out.push(`  <path d="M ${PLATE_SPAN_X0 + 8} ${y - 5.5} L ${PLATE_SPAN_X0} ${y}`
    + ` L ${PLATE_SPAN_X0 + 8} ${y + 5.5}" fill="none" stroke="currentColor"`
    + ` stroke-width="${T}" stroke-linecap="butt" stroke-linejoin="miter"/>`);
  out.push(`  <path class="sc-ld-head" d="M -8 -5.5 L 0 0 L -8 5.5" fill="none"`
    + ` stroke="currentColor" stroke-width="${T}" stroke-linecap="butt" stroke-linejoin="miter"`
    + ` transform="translate(${PLATE_SPAN_X0} ${y})"/>`);

  return `<svg viewBox="0 0 400 182" role="img" aria-label="Contents supplied">\n`
    + out.join('\n') + `\n</svg>`;
}

/** ART_DIRECTION §13.4 — the ✓, at heavy weight, butt caps, ink. */
function svgTick() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M4 12.5 L10 19 L20 5" fill="none" stroke="currentColor" stroke-width="4"
        stroke-linecap="butt" stroke-linejoin="miter"/>
  </svg>`;
}

/** Ten circles. Filled is filled. Redundantly encoded by the number printed beside it. */
function svgSatisfaction(quality) {
  const filled = clamp(Math.round(quality / 10), 0, 10);
  let s = '';
  for (let i = 0; i < 10; i++) {
    const on = i < filled;
    s += `  <circle cx="${9 + i * 19}" cy="10" r="6.4" stroke="currentColor" stroke-width="1.5" `
      + `fill="${on ? 'currentColor' : 'none'}"/>\n`;
  }
  return `<svg viewBox="0 0 190 20" role="img" aria-label="${filled} of 10">\n${s}</svg>`;
}

/** The §13.7 filled-segment progress bar: n filled cells of total, 1U each. */
function svgSegments(done, total) {
  const cells = [];
  const w = 15, g = 4;
  for (let i = 0; i < total; i++) {
    const on = i < done;
    cells.push(`  <rect x="${i * (w + g)}" y="0" width="${w}" height="9" `
      + `fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5"/>`);
  }
  return `<svg viewBox="0 0 ${total * (w + g) - g} 9" role="img" aria-label="${done} of ${total}">\n`
    + cells.join('\n') + `\n</svg>`;
}

/* ============================================================================================
 * 5. STYLE
 * ========================================================================================== */

const MENU_CSS = `
#${ROOT_ID} {
  position: fixed; inset: 0; z-index: 60; pointer-events: none;
  --sc-paper: ${PAPER};
  --sc-ink: ${INK};
  --sc-red: ${RED};
  --sc-hair: 0.75px; --sc-thin: 1.5px; --sc-med: 2.5px; --sc-heavy: 4px;
  --sc-in: 220ms; --sc-out: 140ms;
  font-family: "Helvetica Neue", Helvetica, "Inter", Arial, system-ui, sans-serif;
  font-weight: 500; font-variant-numeric: tabular-nums lining-nums;
  color: var(--sc-ink);
  -webkit-font-smoothing: antialiased;
}
#${ROOT_ID}[data-open="1"] { pointer-events: auto; }
#${ROOT_ID}[data-reduced="1"] * { transition-duration: 1ms !important; animation-duration: 1ms !important; }

.sc-scrim {
  position: absolute; inset: 0; opacity: 0;
  background: rgba(4, 7, 10, var(--sc-scrim, .34));
  backdrop-filter: blur(var(--sc-blur, 0px)) saturate(var(--sc-sat, 1)) brightness(var(--sc-bri, 1));
  -webkit-backdrop-filter: blur(var(--sc-blur, 0px)) saturate(var(--sc-sat, 1)) brightness(var(--sc-bri, 1));
  transition: opacity 260ms ease;
}
#${ROOT_ID}[data-open="1"] .sc-scrim { opacity: 1; }

/*
 * The photographic night plate ('/img/splash-title.png'), title screen only.
 *
 * The live 3D world keeps rendering and keeps drifting underneath — the plate sits at .93, so
 * the lantern, the lightning and the moon still bleed through, and the frame is never a still.
 * With the file absent the layer stays at opacity 0 and the title screen is the live forest,
 * which is what it was before. Nothing about the sheet in front of it changes either way.
 *
 * The photograph is an <img> the preloader already fetched and DECODED, adopted into this
 * element — not a 'background-image: url(...)'. A CSS background is a second reference to the
 * same URL: it re-enters the fetch/decode path, and whether that costs a raster hitch, a
 * memory-cache hit or a whole second download is a cache-policy question we do not get to
 * answer. Measured on a 'no-store' origin, exactly that reference re-downloaded
 * title-treatment.png in full — 1,205 KB, twice, on one load. Adopting the decoded element is
 * the only version that cannot pop, on any origin, under any cache policy.
 */
.sc-splash {
  position: absolute; inset: 0; opacity: 0; pointer-events: none;
  transform: scale(1.06); overflow: hidden;
}
.sc-splash img {
  display: block; position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; object-position: 50% 44%;
}
/*
 * No transition on this opacity, deliberately. A backdropped or occluded tab freezes the CSS
 * timeline, and a transition that never advances leaves the plate at its FROM value — which is
 * how this layer spent its first hour: correct in the cascade, invisible on screen. The drift
 * below is decorative and may freeze without costing anything; the plate itself may not.
 */
#${ROOT_ID}[data-splash="1"][data-screen="title"][data-open="1"] .sc-splash {
  opacity: .93;
  animation: sc-drift 74s ease-in-out infinite alternate;
}
#${ROOT_ID}[data-reduced="1"] .sc-splash { animation: none !important; }
@keyframes sc-drift {
  from { transform: scale(1.055) translate3d(-0.6%, 0.35%, 0); }
  to   { transform: scale(1.105) translate3d(0.7%, -0.5%, 0); }
}
/* The plate is a night photograph; the sheet needs a little more separation from it. */
#${ROOT_ID}[data-splash="1"][data-screen="title"] .sc-sheet--title {
  box-shadow: 0 2px 0 rgba(0,0,0,.5), 0 34px 90px rgba(0,0,0,.85);
}

.sc-stage {
  position: absolute; inset: 0; display: grid; place-items: center;
  padding: clamp(12px, 3.2vmin, 40px); box-sizing: border-box;
}

.sc-sheet {
  position: relative; box-sizing: border-box;
  background: var(--sc-paper); color: var(--sc-ink);
  width: min(96vw, var(--sc-sheet-w, 60rem));
  max-height: 100%;
  padding: clamp(18px, 3.1vmin, 40px) clamp(20px, 3.4vmin, 46px);
  display: flex; flex-direction: column;
  box-shadow: 0 2px 0 rgba(0,0,0,.35), 0 24px 60px rgba(0,0,0,.75);
  transform-origin: 50% 8%;
  opacity: 0;
  transform: perspective(2400px) rotateX(-7deg) translateY(-8px) scale(.986);
  transition: opacity var(--sc-in) ease, transform var(--sc-in) cubic-bezier(.16,.84,.28,1);
  overflow: hidden;
}
#${ROOT_ID}[data-open="1"] .sc-sheet { opacity: 1; transform: none; }
#${ROOT_ID}[data-closing="1"] .sc-sheet {
  opacity: 0; transform: perspective(2400px) rotateX(4deg) scale(.99);
  transition-duration: var(--sc-out);
}

/*
 * Paper: fibre noise, two fold creases, and the edge darkening of one more generation of copy.
 * These sit ABOVE the marks (z-index 4/5, over an unpositioned .sc-body), because the ink is
 * printed on the sheet, not floated over it — the fibre has to run through the drawing too.
 */
.sc-sheet::before {
  content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 4;
  background-image: var(--sc-fibre); background-size: 128px 128px;
  mix-blend-mode: multiply; opacity: .55;
}
.sc-sheet::after {
  content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 5;
  box-shadow: inset 0 0 26px rgba(20,24,26,.085), inset 0 0 0 1px rgba(20,24,26,.06);
  background-image:
    linear-gradient(90deg, transparent calc(33.333% - 3px), rgba(20,24,26,.055) 33.333%,
      rgba(255,255,255,.42) calc(33.333% + 1px), transparent calc(33.333% + 4px)),
    linear-gradient(90deg, transparent calc(66.666% - 3px), rgba(20,24,26,.055) 66.666%,
      rgba(255,255,255,.42) calc(66.666% + 1px), transparent calc(66.666% + 4px));
}
.sc-body {
  display: flex; flex-direction: column;
  flex: 1 1 auto; min-height: 0; overflow: hidden;
}

/* --- the two hairline strips every sheet carries ------------------------------------------ */
.sc-head, .sc-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 1.5em;
  font-size: clamp(.58rem, 1.05vmin, .72rem); letter-spacing: .17em;
  flex: 0 0 auto;
}
.sc-head { padding-bottom: .7em; border-bottom: var(--sc-hair) solid rgba(20,24,26,.55); }
.sc-foot { padding-top: .8em; margin-top: auto; border-top: var(--sc-hair) solid rgba(20,24,26,.55); }
.sc-foot > *, .sc-head > * { white-space: nowrap; }
.sc-prop {
  border: var(--sc-hair) solid var(--sc-ink); padding: .28em .55em .24em;
  letter-spacing: .24em;
}
.sc-dim-text { opacity: .55; }
.sc-specs { display: flex; gap: 1.4em; }
.sc-specs b { font-weight: 500; }

/* --- display type -------------------------------------------------------------------------- */
.sc-title {
  font-size: clamp(2.2rem, 7.4vmin, 5.1rem); font-weight: 700; letter-spacing: -.032em;
  line-height: .88; margin: 0; text-transform: uppercase;
}
.sc-subtitle {
  font-size: clamp(.66rem, 1.55vmin, 1.02rem); letter-spacing: .3em; font-weight: 500;
  margin: .62em 0 0; text-transform: uppercase;
}
.sc-rule-red {
  position: relative; height: 0; margin: 1.05em 0 .85em;
  border-top: var(--sc-thin) solid var(--sc-red);
}
/* GAME_DESIGN §16.2: every red mark is redundantly encoded. Corner tick + dashed cap, in ink. */
.sc-rule-red::before {
  content: ''; position: absolute; left: 0; top: -5px; width: var(--sc-thin); height: 11px;
  background: var(--sc-ink);
}
.sc-rule-red::after {
  content: ''; position: absolute; right: 0; top: calc(var(--sc-thin) * -1); width: 2.2em;
  border-top: var(--sc-thin) dashed var(--sc-ink);
}
.sc-tagline {
  font-size: clamp(.78rem, 1.5vmin, .98rem); letter-spacing: .015em; margin: 0;
  color: rgba(20,24,26,.82);
}
/* The line a real flat-pack box carries under the name, printed with the same flat sincerity. */
.sc-tagline--note {
  font-size: clamp(.54rem, 1vmin, .68rem); letter-spacing: .21em; margin-top: .75em;
  color: rgba(20,24,26,.5);
}

/* --- numbered steps ------------------------------------------------------------------------ */
.sc-steps { list-style: none; margin: 1.6em 0 0; padding: 0; display: flex; flex-direction: column; gap: .18em; }
.sc-step {
  position: relative; display: grid; align-items: center; gap: .95em;
  grid-template-columns: 2.05em 1fr auto;
  background: none; border: 0; padding: .34em 0; margin: 0; width: 100%;
  font: inherit; color: inherit; text-align: left; cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.sc-step:focus { outline: none; }
.sc-step__badge {
  width: 2.05em; height: 2.05em; border-radius: 50%;
  background: var(--sc-ink); color: var(--sc-paper);
  display: grid; place-items: center;
  font-size: .74em; letter-spacing: 0; font-weight: 600; line-height: 1;
  box-sizing: border-box;
}
.sc-step[aria-disabled="true"] .sc-step__badge {
  background: transparent; color: var(--sc-ink);
  border: var(--sc-thin) dashed var(--sc-ink); opacity: .45;
}
.sc-step[aria-disabled="true"] { cursor: default; }
.sc-step[aria-disabled="true"] .sc-step__label,
.sc-step[aria-disabled="true"] .sc-step__spec { opacity: .34; }
.sc-step__label {
  font-size: clamp(.95rem, 1.85vmin, 1.28rem); letter-spacing: .17em; font-weight: 500;
  transition: transform var(--sc-in) cubic-bezier(.16,.84,.28,1);
}
.sc-step__spec {
  font-size: clamp(.54rem, 1vmin, .68rem); letter-spacing: .16em; opacity: .48;
}
/* The straight-insert arrowhead: 28° included angle, solid, ink. §13.4. */
.sc-step__mark {
  position: absolute; left: -1.5em; top: 50%; width: 0; height: 0; opacity: 0;
  border-left: .62em solid var(--sc-ink);
  border-top: .155em solid transparent; border-bottom: .155em solid transparent;
  transform: translateY(-50%) translateX(-3px);
  transition: opacity var(--sc-in) ease, transform var(--sc-in) cubic-bezier(.16,.84,.28,1);
}
.sc-step.is-sel .sc-step__mark { opacity: 1; transform: translateY(-50%) translateX(0); }
.sc-step.is-sel .sc-step__label { transform: translateX(3px); }

/* --- title screen layout -------------------------------------------------------------------
 *
 * The booklet stands at the left of the frame, not in the middle of it: the night plate behind
 * carries its lantern low and right, and a centred sheet sits straight on top of the one lit
 * thing in the picture. Anchoring left is what makes the two layers read as one composition
 * instead of a dialog over a wallpaper.
 */
#${ROOT_ID}[data-screen="title"] .sc-stage {
  place-items: center start;
  padding-left: clamp(14px, 5.5vw, 110px);
}
@media (max-width: 900px) {
  #${ROOT_ID}[data-screen="title"] .sc-stage { place-items: center; padding-left: clamp(12px, 3.2vmin, 40px); }
}
.sc-title-grid {
  display: flex; flex-direction: column;
  padding: clamp(10px, 2vmin, 22px) 0 0; min-height: 0; flex: 0 1 auto;
}
/*
 * The plate is a column: drawing on top, then the rule and the hardware row. The drawing is the
 * only part allowed to shrink. Before this, the whole plate was one shrinkable, clipped box, and
 * on a 900 px-tall frame the drawn fallback's hardware roundels were silently cut off the bottom
 * of the sheet — the fallback screen was a DIFFERENT screen from the one with art, which is
 * exactly what the fallback exists to prevent.
 */
.sc-plate { min-width: 0; flex: 0 1 auto; min-height: 0; display: flex; flex-direction: column; }
.sc-plate__draw {
  flex: 0 1 auto; min-height: 0; width: 100%;
  aspect-ratio: 4 / 3; max-height: min(23vh, 12.5rem);
}
.sc-plate__draw svg { display: block; width: 100%; height: 100%; color: var(--sc-ink); }
.sc-plate img {
  display: block; width: 100%; height: auto; max-width: 100%; color: var(--sc-ink);
}
/*
 * The supplied plate is 3:2 and already carries the red rule and the hardware roundels, so it
 * replaces the drawn cabin AND the drawn hardware row. Capping its height keeps the booklet
 * inside a 900 px frame; 'contain' letterboxes against stock of the same colour, so the
 * letterboxing is invisible and the drawing never distorts.
 */
.sc-plate img {
  max-height: min(27vh, 15rem); object-fit: contain;
  /*
   * The plate's own stock is a shade lighter than ours, so it lands as a pasted rectangle.
   * DARKEN takes the per-channel minimum: its paper (247,244,236) loses to ours (242,239,230)
   * and disappears, while every ink stroke and the red rule are already darker and survive
   * untouched. Multiply would have darkened the whole plate; darken changes nothing but the void.
   */
  mix-blend-mode: darken;
}
.sc-lock { padding-top: clamp(10px, 2.2vmin, 26px); }
/*
 * The optional PNG is composited as a BACKGROUND layer multiplied against the stock, not as an
 * <img> with mix-blend-mode: background-blend-mode blends inside the element, so it cannot be
 * defeated by a stacking context somewhere up the tree. The plate stops being a pasted rectangle
 * and becomes ink on the same sheet.
 */
.sc-plate__img {
  width: 100%; background-color: var(--sc-paper);
  background-image: var(--sc-plate-src); background-repeat: no-repeat;
  background-position: center; background-size: contain;
  background-blend-mode: multiply;
}
.sc-plate__rule {
  flex: 0 0 auto; height: 0; border-top: var(--sc-thin) solid var(--sc-red); margin: .9em 0 .8em;
}
.sc-plate__hw { flex: 0 0 auto; display: block; }
.sc-plate__hw svg { display: block; width: 100%; height: auto; color: var(--sc-ink); }
.sc-lock { min-width: 0; }

@media (max-height: 620px) {
  .sc-plate { display: none; }
}

/* --- specification table (settings) --------------------------------------------------------- */
.sc-scroll {
  overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain;
  scrollbar-gutter: stable;
  flex: 1 1 auto; min-height: 0; padding-right: .9em;
}
/*
 * The settings table is always taller than its box, so a row cut in half by the bottom edge
 * reads as a rendering fault; fade it instead. Scoped to settings on purpose — the report's
 * scroller usually does NOT overflow, and an unconditional mask faded the last printed note
 * ('RETAIN THIS DOCUMENT.') to nothing on the one card that most needs to carry it.
 */
#${ROOT_ID}[data-screen="settings"] .sc-scroll {
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 26px), transparent 100%);
  mask-image: linear-gradient(to bottom, #000 calc(100% - 26px), transparent 100%);
}
.sc-scroll::-webkit-scrollbar { width: 6px; }
.sc-scroll::-webkit-scrollbar-track { background: transparent; }
.sc-scroll::-webkit-scrollbar-thumb { background: rgba(20,24,26,.35); }
.sc-sect {
  display: flex; align-items: baseline; gap: .85em; margin: 1.5em 0 .2em;
  padding-bottom: .3em; border-bottom: var(--sc-thin) solid var(--sc-ink);
}
.sc-sect:first-child { margin-top: .4em; }
.sc-sect__n { font-size: .68rem; letter-spacing: .1em; opacity: .5; }
.sc-sect__name { font-size: .78rem; letter-spacing: .3em; }
/*
 * A specification table, so the control column is a fixed measure and the label column takes
 * the slack — the controls line up down the page like a column of figures, which is the only
 * reason a table is a table. A percentage control column would let the sliders wander.
 */
.sc-row {
  display: grid; grid-template-columns: minmax(0, 1fr) clamp(11rem, 26vmin, 19rem) 4.2rem;
  align-items: center; gap: 1.4em; padding: .46em 0;
  border-bottom: var(--sc-hair) solid rgba(20,24,26,.2);
}
.sc-row__label { font-size: clamp(.64rem, 1.2vmin, .8rem); letter-spacing: .15em; }
.sc-row__value { font-size: clamp(.64rem, 1.2vmin, .8rem); letter-spacing: .04em; text-align: right; opacity: .78; }
.sc-row.is-sel { background: rgba(20,24,26,.055); }
.sc-row.is-sel .sc-row__label { font-weight: 600; }

.sc-seg { display: flex; border: var(--sc-thin) solid var(--sc-ink); }
.sc-seg button {
  flex: 1 1 0; min-width: 0; font: inherit; font-size: clamp(.5rem, .95vmin, .62rem);
  letter-spacing: .1em; padding: .42em .12em .38em; background: transparent; color: var(--sc-ink);
  border: 0; border-left: var(--sc-hair) solid var(--sc-ink); cursor: pointer; line-height: 1;
}
.sc-seg button:first-child { border-left: 0; }
.sc-seg button[aria-checked="true"] { background: var(--sc-ink); color: var(--sc-paper); }
.sc-seg button:focus { outline: none; }

/* The slider is a dimension line: 1.5px shaft, 0.75px extension lines, a 2.5px tick. §13.4. */
.sc-dim { position: relative; height: 1.7em; display: flex; align-items: center; }
.sc-dim::before, .sc-dim::after {
  content: ''; position: absolute; top: .22em; bottom: .22em; width: var(--sc-hair);
  background: var(--sc-ink); opacity: .9;
}
.sc-dim::before { left: 0; }
.sc-dim::after { right: 0; }
.sc-dim input[type="range"] {
  -webkit-appearance: none; appearance: none; width: 100%; height: 1.7em;
  background: transparent; margin: 0; cursor: ew-resize; display: block;
}
.sc-dim input[type="range"]:focus { outline: none; }
.sc-dim input[type="range"]::-webkit-slider-runnable-track { height: var(--sc-thin); background: var(--sc-ink); }
.sc-dim input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; width: var(--sc-med); height: 1.05em;
  background: var(--sc-ink); border: 0; border-radius: 0;
  margin-top: calc(-.525em + var(--sc-thin) / 2);
}
.sc-dim input[type="range"]::-moz-range-track { height: var(--sc-thin); background: var(--sc-ink); }
.sc-dim input[type="range"]::-moz-range-thumb {
  width: var(--sc-med); height: 1.05em; background: var(--sc-ink); border: 0; border-radius: 0;
}

.sc-check {
  width: 1.25em; height: 1.25em; padding: 0; box-sizing: border-box;
  border: var(--sc-thin) solid var(--sc-ink); background: transparent;
  display: grid; place-items: center; cursor: pointer; color: var(--sc-ink);
}
.sc-check:focus { outline: none; }
.sc-check svg { width: .98em; height: .98em; opacity: 0; }
.sc-check[aria-checked="true"] svg { opacity: 1; }

/* --- the assembly report -------------------------------------------------------------------- */
/*
 * Two columns: the count on the left, the disposition on the right. The right column is the
 * inspector's block on a real QC form — a figure, a rule, a stamp — and it is ruled off from
 * the counts so it reads as a separate signature rather than a decoration hanging off the page.
 */
.sc-report {
  display: grid; grid-template-columns: minmax(0, 1fr) clamp(10rem, 22vmin, 15rem);
  gap: clamp(16px, 3.4vmin, 50px); align-items: stretch;
}
.sc-report__aside {
  display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
  gap: .3em; padding-left: clamp(12px, 2.4vmin, 34px);
  border-left: var(--sc-hair) solid rgba(20,24,26,.35);
}
.sc-report__inspector {
  font-size: clamp(.5rem, .98vmin, .62rem); letter-spacing: .22em; opacity: .55;
  margin-bottom: .3em; align-self: stretch; text-align: center;
}
.sc-report__figure { width: clamp(78px, 13vmin, 128px); }
.sc-report__figure svg { display: block; width: 100%; height: auto; color: var(--sc-ink); }
@media (max-width: 760px) {
  .sc-report { grid-template-columns: 1fr; }
  .sc-report__aside { border-left: 0; padding-left: 0; }
  .sc-report__figure { display: none; }
}

.sc-rhead { padding: .1em 0 0; }
.sc-rhead__kicker { font-size: clamp(.56rem, 1.06vmin, .7rem); letter-spacing: .24em; opacity: .62; }
.sc-rhead__name {
  font-size: clamp(1.6rem, 4.4vmin, 2.9rem); font-weight: 700; letter-spacing: -.012em;
  line-height: 1; margin: .28em 0 0;
}
.sc-rhead__instr { font-size: clamp(.72rem, 1.5vmin, .95rem); letter-spacing: .18em; margin: .58em 0 0; }
.sc-rhead__sub {
  font-size: clamp(.62rem, 1.2vmin, .8rem); letter-spacing: .02em; margin: .34em 0 0;
  color: rgba(20,24,26,.7); min-height: 1.15em;
}
/* STORY §12.2: the rule under the sub-line is ALWAYS drawn. An empty ruled line reads as absence. */
.sc-rhead__subrule { width: 18ch; height: 0; border-top: var(--sc-hair) solid var(--sc-ink); margin-top: .5em; opacity: .8; }

.sc-rrows { list-style: none; margin: 1.15em 0 0; padding: 0; }
.sc-rrow {
  display: grid; grid-template-columns: auto minmax(1.5em, 1fr) auto; align-items: baseline;
  gap: .55em; padding: .32em 0;
}
.sc-rrow__label { font-size: clamp(.6rem, 1.16vmin, .78rem); letter-spacing: .14em; }
.sc-rrow__lead { border-bottom: var(--sc-hair) dotted rgba(20,24,26,.5); transform: translateY(-.28em); }
.sc-rrow__value { font-size: clamp(.66rem, 1.24vmin, .84rem); letter-spacing: .04em; }
.sc-rrow--meter { grid-template-columns: auto minmax(0, 1fr) auto; gap: .9em; align-items: center; padding-top: .8em; }
.sc-rrow--meter .sc-rrow__label { align-self: center; }
.sc-meter { display: block; width: 100%; max-width: 190px; margin-left: auto; color: var(--sc-ink); }

.sc-rnote { font-size: clamp(.6rem, 1.16vmin, .78rem); letter-spacing: .14em; margin: 1.5em 0 0; }
.sc-rnote + .sc-rnote { margin-top: .35em; }
.sc-rstamp { margin: 1.1em 0 0; display: flex; justify-content: center; }
.sc-stampbox {
  position: relative; display: inline-block; transform: rotate(-4.2deg);
  border: var(--sc-med) solid var(--sc-ink); padding: .6em 1.15em .55em;
  opacity: .87; text-align: center;
}
.sc-stampbox::before {
  content: ''; position: absolute; inset: 3px; border: var(--sc-hair) solid var(--sc-ink);
}
.sc-stampbox__word { font-size: clamp(.72rem, 1.5vmin, .98rem); letter-spacing: .2em; font-weight: 600; }
.sc-stampbox__meta {
  font-size: clamp(.48rem, .95vmin, .6rem); letter-spacing: .16em; margin-top: .42em;
  padding-top: .34em; border-top: var(--sc-hair) solid var(--sc-ink); opacity: .8;
}
/*
 * The stamp lands, but its RESTING state is the visible one and the animation only moves it.
 * The first version faded in from opacity 0 with animation-fill-mode: backwards, and any
 * condition that stalls the CSS timeline — a backgrounded tab, a static rasterisation, reduced
 * motion handled badly — left the verdict, which is the punchline of the whole form, invisible
 * on a form that otherwise looked finished. Nothing load-bearing may depend on a clock.
 */
#${ROOT_ID}[data-open="1"] .sc-stampbox {
  animation: sc-stamp 300ms cubic-bezier(.2,1.5,.4,1);
}
@keyframes sc-stamp {
  from { transform: rotate(-9.5deg) scale(1.18); }
  to { transform: rotate(-4.2deg) scale(1); }
}

/* --- the closed manual (pause) --------------------------------------------------------------- */
.sc-sheet--closed { width: min(94vw, var(--sc-sheet-w, 27rem)); }
/* The manual, folded shut: the cover is there, and you cannot read it from here. */
.sc-cover { position: relative; margin: 1.3em 0 .2em; max-height: 34vh; overflow: hidden; }
.sc-cover svg, .sc-cover img {
  display: block; width: 100%; height: auto; max-width: 100%; color: var(--sc-ink); opacity: .3;
}
.sc-cover img { aspect-ratio: 1 / .78; object-fit: cover; object-position: 50% 30%; mix-blend-mode: darken; }
.sc-progress { margin: 1.15em 0 .2em; }
.sc-progress svg { display: block; width: 100%; height: auto; max-width: 15rem; color: var(--sc-ink); }
/* Exclamation lozenge — §13.4, max one per page, and it lives on the abandon confirmation. */
.sc-lozenge {
  display: inline-grid; place-items: center; width: 1.85em; height: 1.3em; border-radius: .28em;
  background: var(--sc-red); color: var(--sc-paper); font-weight: 700; font-size: .8em;
  border: var(--sc-med) solid var(--sc-red); box-sizing: border-box; line-height: 1;
}
.sc-warn { display: flex; align-items: center; gap: .8em; margin: 1.4em 0 0; }
.sc-warn p { margin: 0; font-size: clamp(.62rem, 1.2vmin, .8rem); letter-spacing: .12em; }

/* --- the title card (STORY §12.2) -------------------------------------------------------------- */
.sc-card {
  position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none;
  background-color: var(--sc-paper); opacity: 0; transition: opacity 320ms ease;
  z-index: 2;
}
/*
 * '/img/nightcard-texture.png' is blank aged manual stock. It is MULTIPLIED over the paper
 * colour rather than drawn as a layer, so the type on top stays true ink and the card is the
 * same card with or without the file — with it, the sheet has age; without it, it is clean.
 */
.sc-card[data-tex="1"] {
  background-image: var(--sc-card-src);
  background-size: cover; background-position: center;
  background-blend-mode: multiply;
}
.sc-card::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background-image: var(--sc-fibre); background-size: 128px 128px;
  mix-blend-mode: multiply; opacity: .5;
}
.sc-card[data-on="1"] { opacity: 1; }
/*
 * Left-anchored to a page margin, not centred. A left-set block centred in the viewport reads
 * as a mistake; set against a margin it reads as a page, which is the whole conceit.
 */
.sc-card { place-items: center start; }
.sc-card__in {
  text-align: left; max-width: 46rem;
  padding: 6vmin clamp(24px, 6vw, 130px);
}
@media (max-width: 760px) { .sc-card { place-items: center; } }
.sc-card__n { font-size: clamp(.66rem, 1.3vmin, .86rem); letter-spacing: .34em; }
.sc-card__t {
  font-size: clamp(1.4rem, 4.6vmin, 3.1rem); font-weight: 700; letter-spacing: -.018em;
  line-height: 1.02; margin: .5em 0 0; text-transform: uppercase;
}
.sc-card__accent { width: 6.5em; height: 0; border-top: var(--sc-thin) solid var(--sc-red); margin: .85em 0; }
.sc-card__s { font-size: clamp(.68rem, 1.3vmin, .88rem); letter-spacing: .03em; min-height: 1.3em; margin: 0; }
.sc-card__rule { width: 18ch; height: 0; border-top: var(--sc-hair) solid var(--sc-ink); margin-top: 1.5em; }

/* --- the boot plate ---------------------------------------------------------------------------
 * Up from the Menu constructor until the FIRST SCREEN IS FINISHED — every heavy system init()ed,
 * a frame presented, and splash-title.png fetched and decoded — not merely until the engine says
 * booted. index.html paints #05070a and nothing else, so without this the first eight seconds of
 * the game are a black rectangle; without the gate, the eight seconds after that were a booklet
 * standing on one.
 *
 * It is opaque, and it covers the stage. So the title screen is built, opened and allowed to
 * settle UNDERNEATH it, and this one fade is the entire transition: what appears is a finished
 * composition, arriving all at once, the way a page is turned.
 */
.sc-loading {
  position: absolute; inset: 0; z-index: 3; pointer-events: none;
  display: grid; place-items: center; background: #05070a;
  transition: opacity ${PLATE_FADE_MS}ms cubic-bezier(.33,0,.2,1);
}
.sc-loading[data-off="1"] { opacity: 0; }
.sc-load__sheet {
  position: relative; box-sizing: border-box; background: var(--sc-paper); color: var(--sc-ink);
  width: min(88vw, 30rem); padding: clamp(18px, 3vmin, 34px) clamp(20px, 3.2vmin, 38px);
  box-shadow: 0 2px 0 rgba(0,0,0,.35), 0 24px 60px rgba(0,0,0,.75);
  overflow: hidden;
}
.sc-load__sheet::before {
  content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 4;
  background-image: var(--sc-fibre); background-size: 128px 128px;
  mix-blend-mode: multiply; opacity: .55;
}
.sc-load__plate { margin: 1.1em 0 .85em; overflow: hidden; }
.sc-load__plate svg {
  display: block; width: 100%; height: auto; max-width: 100%; color: var(--sc-ink);
}
/*
 * The two marks that move. Both transition, and both are driven only by '_setProgress()' from a
 * real completion — the easing is the readout settling on a value it has already been given, not
 * a clock filling a bar. There is no animation anywhere on this sheet that runs by itself.
 */
.sc-ld-box { transition: fill 260ms cubic-bezier(.16,.84,.28,1); }
.sc-ld-box[data-on="1"] { fill: currentColor; }
.sc-ld-span { transition: stroke-dashoffset 300ms cubic-bezier(.16,.84,.28,1); }
.sc-ld-head { transition: transform 300ms cubic-bezier(.16,.84,.28,1); }
.sc-load__word { font-size: clamp(.66rem, 1.3vmin, .84rem); letter-spacing: .3em; }

/* --- the blank page --------------------------------------------------------------------------- */
.sc-blank { display: grid; place-items: center; min-height: 42vh; }
.sc-blank span { font-size: clamp(.66rem, 1.3vmin, .86rem); letter-spacing: .32em; opacity: .75; }
/* One centred step, sized to its own label rather than stretched across the sheet. */
.sc-steps--centre { align-items: center; margin-top: 2.2em; }
.sc-steps--centre .sc-step { width: auto; grid-template-columns: 2.05em auto; }
.sc-steps--centre .sc-step__spec { display: none; }

.sc-hjem {
  display: grid; place-items: center; gap: 3.2em; padding: 10vmin 0 8vmin;
}
.sc-hjem b { font-size: clamp(2.4rem, 8vmin, 5.4rem); font-weight: 700; letter-spacing: .02em; }
.sc-hjem span { font-size: clamp(.7rem, 1.4vmin, .92rem); letter-spacing: .34em; }
`;

/* ============================================================================================
 * 6. THE CLASS
 * ========================================================================================== */

export class Menu {
  constructor(ctx) {
    this.ctx = ctx ?? {};
    this.bus = this.ctx.bus ?? null;

    /** 'title' | 'pause' | 'settings' | 'report' | 'confirm' | 'blank' | null */
    this.screen = null;

    this._root = null;
    this._style = null;
    this._stage = null;
    this._card = null;
    this._sheetEl = null;

    this._items = [];
    this._index = 0;
    this._rows = [];          // settings rows, for keyboard traversal
    this._rowIndex = 0;

    this._unsubs = [];
    this._timers = new Set();
    this._settingsReturn = 'title';
    this._selfPausing = false;
    this._enginePaused = false;
    this._padPoll = 0;
    this._padPrev = false;
    this._closing = false;
    this._disposed = false;
    this._bootHidden = false;   // suppressed by ?shot / ?nomenu
    this._lockAskedAt = -1e9;   // de-dupes pointer-lock attempts, see _requestLock()

    this._lastScore = null;
    this._lastNight = 1;
    this._nightStartedAt = 0;
    this._nightElapsed = 0;

    // Title-camera state. Plain numbers only — update() never allocates.
    this._camT = 0;
    this._camCx = 0; this._camCy = 0; this._camCz = 0;
    this._camReady = false;

    this._imgCover = null;      // pause sheet, deferred — a plain URL is enough behind a scrim
    this._imgCard = null;       // night card, deferred — likewise

    // The two first-screen images are held as DECODED ELEMENTS, not URLs. See `.sc-splash`.
    this._elSplash = null;
    this._elTitleArt = null;
    this._blobUrls = [];

    this._loadingEl = null;
    this._splashEl = null;
    this._plateSvg = null;
    this._plateBoxes = null;
    this._plateSpan = null;
    this._plateHead = null;

    this._preloadStarted = false;
    this._preP = PRELOAD_UNITS.map(() => 0);
    this._preDone = false;
    this._preDoneAt = 0;
    this._plateAt = 0;
    this._systemsReady = false;
    this._reviewMode = false;
    this._revealed = false;
    this._revealTimer = 0;
    this._fadeRaf = 0;
    this._booted = false;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onCanvasDown = this._onCanvasDown.bind(this);
    this._onLockError = this._onLockError.bind(this);

    /*
     * NightManager.init() arms a 1.2 s auto-start unless `settings.autoStart` is exactly false
     * ("when no UI does" — NightManager.js). We are that UI. Every system's constructor runs
     * before any system's init(), so writing it here is the only moment it is still early enough.
     * Without this the title screen is built, shown, and destroyed 1.2 s later by `night:begin`,
     * which is precisely how it went unseen. `Settings.load()` filters unknown keys, so this
     * never persists into a later session — it is a per-session hand-off, not a stored setting.
     */
    try {
      const p = this._params();
      if (!p.has('shot') && !p.has('shots') && !p.has('nomenu')) {
        this.ctx.settings?.set?.('autoStart', false);
      }
    } catch (e) {
      Log.warn('Menu: could not disarm NightManager auto-start.', e);
    }

    // The boot screen AND the preload. Both belong in the constructor: init() does not run until
    // after every heavy system has finished (texture bake + terrain ≈ 8 s), and those 8 s are
    // both the first thing anyone sees and — measured — dead time on the network. Starting the
    // fetches here overlaps the whole 2 MB splash download with the bake, which is most of why
    // the title no longer waits for it. Errors here are reported, never swallowed: a missing
    // boot screen must not also cost us the menu.
    try {
      this._buildDom();
      if (!this._bootSuppressed()) {
        this._showLoading();
        this._preload();
      }
    } catch (e) {
      Log.error('Menu: boot screen construction failed.', e, e?.stack);
    }
  }

  /* ------------------------------------------------------------------ lifecycle */

  async init() {
    if (this._disposed) return;
    if (typeof document === 'undefined') return;

    // The constructor normally builds the DOM (so the boot screen exists during init). If it
    // threw, this is the second and last chance — and a failure here is fatal to the menu, so
    // it is logged with its stack rather than swallowed.
    if (!this._root) {
      try {
        this._buildDom();
      } catch (e) {
        Log.error('Menu: DOM construction failed — no menu this session.', e, e?.stack);
        return;
      }
    }
    try {
      this._bindEvents();
      this._applyVisionMode();
      this.resize(this.ctx.width ?? 0, this.ctx.height ?? 0);
    } catch (e) {
      Log.error('Menu: event binding failed — menu will not respond to input.', e, e?.stack);
    }

    const params = this._params();
    this._bootHidden = params.has('shot') || params.has('shots') || params.has('nomenu');

    /*
     * Unit 5. Menu is registered LAST in `src/main.js`, and `Engine.initSystems()` awaits each
     * system's init() in registration order — so reaching this line means Textures, Terrain,
     * Forest and every other bake has already returned. It is the honest milestone for "the
     * engine is nearly up", and it is the closest thing to sub-progress the engine offers.
     *
     * TODO(api): Engine emits `engine:booted` and nothing before it. A `system:init { name, i,
     * n }` on ctx.bus, emitted from `Engine.initSystems()` as each init() resolves, would let
     * this plate report the real long pole — which, measured, is the engine and not the network.
     */
    this._systemsReady = true;
    this._mark('systems-ready');
    this._unit('systems', 1);

    const phase = this.ctx.state?.phase ?? 'menu';
    if (this._bootHidden) {
      this._hideLoading();
    } else if (params.has('menu')) {
      // Review hook: `?menu=title|pause|settings|report|report7|card|confirm|loading` opens one
      // screen straight out of boot, so a screenshot pass never has to race the game loop.
      // `_reviewMode` stops `_maybeReveal()` from later replacing the requested screen with the
      // title — which `?menu=loading` in particular would hit, since it leaves `screen` null.
      this._reviewMode = true;
      this._preload();
      this._hideLoading();
      this._showForReview(params.get('menu'));
    } else if (phase === 'menu') {
      // The title is NOT opened here. `_maybeReveal()` is the only path to it, and it does not
      // run until the first screen is complete — see §0b.
      this._maybeReveal();
    } else {
      this._hideLoading();
    }
    Log.debug(`Menu ready (phase '${phase}'${this._bootHidden ? ', suppressed by URL' : ''}).`);
  }

  /** `?menu=<screen>` — open one screen for review. Never reached in a normal session. */
  _showForReview(which) {
    switch (String(which || 'title')) {
      case 'pause': this.showPause(); break;
      case 'settings': this.showSettings('title'); break;
      case 'report': this.showNightEnd(null, { night: 2 }); break;
      case 'report7': this.showNightEnd(null, { night: 7 }); break;
      case 'reportfail': this.showNightEnd(null, { night: 3, failed: true }); break;
      case 'confirm': this._open('confirm', this._renderConfirm('abandon'), { scrim: 0.55, blur: 13, sat: 0.55, bri: 0.44, pause: false, closed: true }); break;
      case 'card': this.showTitle(); this.showTitleCard(1); break;
      case 'card5': this.showTitle(); this.showTitleCard(5); break;
      case 'loading': this._showLoading(); break;
      default: this.showTitle(); break;
    }
  }

  /**
   * Drives the title screen's slow drift through the forest. Runs after Player (registration
   * order) so this pose wins, and before Shots so the harness still wins over us.
   * No allocation: everything below is scalar arithmetic on preallocated fields.
   */
  update(dt, _elapsed) {
    if (this._disposed || this.screen !== 'title') return;
    const cam = this.ctx.camera;
    if (!cam) return;

    const shots = this.ctx.systems?.get?.('Shots');
    if (shots && shots.active) return;

    if (!this._camReady) this._resolveDriftCentre();

    const step = dt > 0.1 ? 0.1 : dt;
    this._camT += step;
    const t = this._camT;

    // A 4½-minute orbit at 27 m, breathing in and out by 2.4 m, with the eye rising and falling.
    const a = t * 0.0232;
    const radius = 27 + Math.sin(t * 0.071) * 2.4;
    const px = this._camCx + Math.cos(a) * radius;
    const pz = this._camCz + Math.sin(a) * radius;

    let ground = this._camCy;
    const terrain = this.ctx.systems?.get?.('Terrain');
    if (terrain && typeof terrain.heightAt === 'function') {
      const h = terrain.heightAt(px, pz);
      if (Number.isFinite(h)) ground = h;
    }
    const py = ground + 2.05 + Math.sin(t * 0.117) * 0.09;

    // Handheld noise: the player is a big, heavy man. ART §11 — never let the frame be still.
    const nx = Math.sin(t * 1.31) * 0.0026 + Math.sin(t * 0.53) * 0.0041;
    const ny = Math.sin(t * 1.07 + 1.7) * 0.0022 + Math.sin(t * 0.41 + 0.6) * 0.0035;

    const dx = this._camCx - px;
    const dz = this._camCz - pz;
    const dy = (this._camCy + 1.45) - py;
    const flat = Math.hypot(dx, dz) || 1e-4;

    cam.position.set(px, py, pz);
    cam.rotation.set(
      Math.atan2(dy, flat) + ny,
      Math.atan2(-dx, -dz) + nx,
      Math.sin(t * 0.29) * 0.0035,
    );
  }

  resize(_w, _h) {
    if (!this._root) return;
    // ART §13.2: stroke widths scale by pageHeight / 900, snapped to 0.25 px.
    const h = this._sheetEl?.clientHeight || this.ctx.height || globalThis.innerHeight || 900;
    const s = clamp(h / 900, 0.55, 1.8);
    const snap = (v) => (Math.round((v * s) * 4) / 4).toFixed(2) + 'px';
    const st = this._root.style;
    st.setProperty('--sc-hair', snap(WEIGHTS.hairline));
    st.setProperty('--sc-thin', snap(WEIGHTS.thin));
    st.setProperty('--sc-med', snap(WEIGHTS.medium));
    st.setProperty('--sc-heavy', snap(WEIGHTS.heavy));
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    for (const off of this._unsubs) { try { off(); } catch { /* noop */ } }
    this._unsubs.length = 0;

    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    if (this._padPoll) { cancelAnimationFrame(this._padPoll); this._padPoll = 0; }
    if (this._fadeRaf) { cancelAnimationFrame(this._fadeRaf); this._fadeRaf = 0; }

    try { globalThis.document?.removeEventListener('keydown', this._onKeyDown, true); } catch { /* noop */ }
    try { this.ctx.canvas?.removeEventListener('pointerdown', this._onCanvasDown); } catch { /* noop */ }
    try { globalThis.document?.removeEventListener('pointerlockerror', this._onLockError); } catch { /* noop */ }

    this._loadingEl?.remove();
    this._loadingEl = null;
    this._root?.remove();
    this._style?.remove();
    this._root = this._style = this._stage = this._card = this._sheetEl = null;
    this._splashEl = null;
    this._plateSvg = this._plateBoxes = this._plateSpan = this._plateHead = null;
    this._items.length = 0;
    this._rows.length = 0;
    this._imgCover = this._imgCard = null;
    this._elSplash = this._elTitleArt = null;
    // The decoded bitmaps are held alive by their object URLs; released only here, never while
    // an <img> that uses one is still in the tree.
    for (const url of this._blobUrls) { try { URL.revokeObjectURL(url); } catch { /* noop */ } }
    this._blobUrls.length = 0;
  }

  /* ------------------------------------------------------------------ public API */

  /**
   * A disposed Menu is never open.
   *
   * Other systems gate on this (Input, Campers, Shots), so `isOpen` staying true after teardown
   * means the world believes a sheet is up forever and quietly stops responding. Measured: a
   * `showNightEnd()` arriving after dispose — a `night:complete` in flight, say — used to leave
   * `screen === 'report'` and `isOpen === true` on a Menu with no DOM at all.
   */
  get isOpen() {
    return !this._disposed && this.screen !== null;
  }

  /** The front of the booklet, over a living forest. */
  showTitle() {
    if (this._disposed) return;
    this._camT = 0;
    this._camReady = false;
    this._open('title', this._renderTitle(), {
      scrim: 0.22, blur: 0, sat: 1, bri: 1, pause: false, width: '30.5rem',
    });
  }

  /** The manual folded shut. */
  showPause() {
    if (this._disposed || this.screen === 'pause') return;
    this._open('pause', this._renderPause(), { scrim: 0.52, blur: 13, sat: 0.55, bri: 0.46, pause: true, closed: true });
  }

  /**
   * The specification table.
   * @param {'title'|'pause'} [returnTo] where Escape and RETURN go back to.
   */
  showSettings(returnTo) {
    if (this._disposed) return;
    if (returnTo === 'title' || returnTo === 'pause') this._settingsReturn = returnTo;
    else if (this.screen === 'title' || this.screen === 'pause') this._settingsReturn = this.screen;
    const fromPause = this._settingsReturn === 'pause';
    this._open('settings', this._renderSettings(), {
      scrim: fromPause ? 0.52 : 0.38, blur: fromPause ? 13 : 4, sat: fromPause ? 0.55 : 0.85,
      bri: fromPause ? 0.46 : 0.8, pause: fromPause, width: '50rem',
    });
  }

  /**
   * The printed QC inspection form.
   * @param {object} [score] the Score from NightManager (GAME_DESIGN §15.1). Any missing field
   *                         is derived from GameState so the card is always complete and honest.
   * @param {object} [opts]  `{ night, failed, reason }`
   */
  showNightEnd(score, opts = {}) {
    if (this._disposed) return;
    const night = clamp(Math.round(opts.night ?? score?.night ?? this.ctx.state?.night ?? 1), 1, 7);
    this._lastNight = night;
    const normalized = this._normalizeScore(score, night, !!opts.failed);
    this._lastScore = normalized;
    this._open('report', this._renderReport(normalized, night, !!opts.failed), {
      scrim: 0.46, blur: 6, sat: 0.7, bri: 0.62, pause: false,
      // Night Seven is one word on a page (STORY §12.3); a 64rem form width makes it a banner.
      width: night >= 7 ? '34rem' : '64rem',
    });
    this._sfx('ui.stamp', 0.9, 460);
  }

  /** Close whatever is up and give the world back its pointer. */
  hide() {
    if (this._disposed) { this.screen = null; return; }
    if (!this._root || this.screen === null) { this.screen = null; return; }
    const wasPaused = this._enginePaused;
    this.screen = null;
    this._items.length = 0;
    this._rows.length = 0;
    this._closing = true;
    this._root.dataset.closing = '1';
    this._root.dataset.open = '0';

    this._after(200, () => {
      if (this._disposed || this.screen !== null) return;
      if (this._stage) this._stage.innerHTML = '';
      this._closing = false;
      if (this._root) { this._root.dataset.closing = '0'; this._root.dataset.screen = 'none'; }
    });

    if (wasPaused) this._setEnginePaused(false);
    this._stopPadPoll();
    this._sfx('ui.page', 0.7);

    if (PLAYABLE_PHASES.has(this.ctx.state?.phase ?? 'menu')) this._requestLock();
  }

  /**
   * STORY §12.2 — the flat card at `night:begin`. Non-interactive, holds 2.4 s (3.1 s on the
   * two nights with no sub-line), no music, and the rule under the sub-line is always drawn.
   * Does not count as an open menu: gameplay and the pointer keep running behind it.
   */
  showTitleCard(night) {
    if (this._disposed || !this._card) return;
    const n = clamp(Math.round(night ?? 1), 1, 7);
    const card = Script?.titleCard?.(n) ?? null;
    if (!card) return;
    const hold = card.subline ? TITLE_CARD_HOLD_MS : TITLE_CARD_HOLD_LONG_MS;

    if (this._imgCard) {
      this._card.style.setProperty('--sc-card-src', `url("${this._imgCard}")`);
      this._card.dataset.tex = '1';
    }
    this._card.innerHTML = `
      <div class="sc-card__in">
        <div class="sc-card__n">${esc(card.line1)}</div>
        <h2 class="sc-card__t">${esc(card.line2)}</h2>
        <div class="sc-card__accent"></div>
        <p class="sc-card__s">${card.subline ? esc(card.subline) : ''}</p>
        <div class="sc-card__rule"></div>
      </div>`;
    this._card.dataset.on = '1';
    this._after(hold, () => { if (this._card) this._card.dataset.on = '0'; });
  }

  /* ------------------------------------------------------------------ DOM construction */

  _buildDom() {
    const doc = document;

    if (!doc.getElementById(STYLE_ID)) {
      this._style = doc.createElement('style');
      this._style.id = STYLE_ID;
      this._style.textContent = MENU_CSS;
      doc.head.appendChild(this._style);
    }

    const old = doc.getElementById(ROOT_ID);
    if (old) old.remove();

    this._root = doc.createElement('div');
    this._root.id = ROOT_ID;
    this._root.dataset.open = '0';

    const splash = doc.createElement('div');
    splash.className = 'sc-splash';
    this._splashEl = splash;

    const scrim = doc.createElement('div');
    scrim.className = 'sc-scrim';

    this._stage = doc.createElement('div');
    this._stage.className = 'sc-stage';

    this._card = doc.createElement('div');
    this._card.className = 'sc-card';
    this._card.dataset.on = '0';

    this._root.append(splash, scrim, this._stage, this._card);
    doc.body.appendChild(this._root);

    this._root.style.setProperty('--sc-fibre', `url("${this._fibreTexture()}")`);
    if (this.ctx.settings?.get?.('reducedMotion')) this._root.dataset.reduced = '1';
    if (this._elSplash) this._applySplash();
  }

  /**
   * ART §13.1 — 3-octave fibre noise, ±1.8% luminance. Baked once into a 128 px data URI and
   * multiplied over the stock. Barely there; visible only on a good display, which is the point.
   * Uses its own Rand instance so it cannot perturb `ctx.rand`'s stream (ARCHITECTURE §6).
   */
  _fibreTexture() {
    try {
      const N = 128;
      const c = document.createElement('canvas');
      c.width = c.height = N;
      const g = c.getContext('2d', { willReadFrequently: false });
      if (!g) return '';
      const img = g.createImageData(N, N);
      const rnd = new Rand(0x5A5E17);
      // Three octaves of value noise, plus a faint vertical grain.
      const oct = [];
      for (let o = 0; o < 3; o++) {
        const s = 8 << o;
        const grid = new Float32Array(s * s);
        for (let i = 0; i < grid.length; i++) grid[i] = rnd.next();
        oct.push({ s, grid });
      }
      const sample = (o, x, y) => {
        const s = o.s;
        const fx = (x / N) * s, fy = (y / N) * s;
        const x0 = Math.floor(fx) % s, y0 = Math.floor(fy) % s;
        const x1 = (x0 + 1) % s, y1 = (y0 + 1) % s;
        const tx = fx - Math.floor(fx), ty = fy - Math.floor(fy);
        const ex = tx * tx * (3 - 2 * tx), ey = ty * ty * (3 - 2 * ty);
        const a = o.grid[y0 * s + x0], b = o.grid[y0 * s + x1];
        const cc = o.grid[y1 * s + x0], d = o.grid[y1 * s + x1];
        return (a + (b - a) * ex) + ((cc + (d - cc) * ex) - (a + (b - a) * ex)) * ey;
      };
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          let v = 0, amp = 0.5, sum = 0;
          for (const o of oct) { v += sample(o, x, y) * amp; sum += amp; amp *= 0.5; }
          v /= sum;
          const grain = (rnd.next() - 0.5) * 0.004;
          const lum = 255 * (1 - (v - 0.5) * 0.036 - grain);
          const i = (y * N + x) * 4;
          const b = clamp(Math.round(lum), 0, 255);
          img.data[i] = b; img.data[i + 1] = b; img.data[i + 2] = b; img.data[i + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
      return c.toDataURL('image/png');
    } catch (e) {
      Log.debug('Menu: fibre texture unavailable.', e);
      return '';
    }
  }

  /* ------------------------------------------------------------------ the preload */

  /**
   * Resolve when `promise` settles OR when the document goes hidden — whichever is first.
   *
   * MEASURED, and it stranded this preloader on its first run: in a backgrounded tab Chrome
   * suspends the compositor, and **both** `HTMLImageElement.decode()` and
   * `requestAnimationFrame` simply never fire. A 4,000 ms probe on a hidden tab returned
   * `TIMEOUT` for decode and `rafTIMEOUT` for a single rAF; the plate sat at 5/6 units until the
   * 12 s ceiling released it. That is not a harness artefact — a player who middle-clicks the
   * link and keeps reading their feed is in exactly that state, and would come back to a title
   * screen with no background on it.
   *
   * The rule this encodes: **a preloader may never wait on anything that requires the page to be
   * painting.** Both of those waits exist to get work done before the first paint. If there is
   * no first paint, there is nothing to be early for, and the wait is already satisfied.
   */
  _raceVisible(promise) {
    const doc = globalThis.document;
    if (!doc || doc.visibilityState === 'hidden') return Promise.resolve('hidden');
    return new Promise((resolve) => {
      let settled = false;
      const finish = (why) => {
        if (settled) return;
        settled = true;
        try { doc.removeEventListener('visibilitychange', onVis); } catch { /* noop */ }
        resolve(why);
      };
      const onVis = () => { if (doc.visibilityState === 'hidden') finish('hidden'); };
      doc.addEventListener('visibilitychange', onVis);
      promise.then(() => finish('settled'), () => finish('failed'));
    });
  }

  /**
   * Fetch one image AND decode it, reporting bytes as they arrive.
   *
   * `new Image()` + `onload` is not enough. `onload` fires when the bytes are in and the header
   * is parsed; the actual raster of a 1536×1024 PNG happens later, on the main thread, at the
   * first paint that needs it — which is the frame we are about to reveal. `decode()` moves that
   * work in front of the curtain instead of behind it, and it is the difference between a clean
   * fade and a fade with a hitch in it.
   *
   * The body is read as a stream against `content-length`, so unit progress is literally the
   * fraction of the file that has arrived. If the response is not streamable (no body, no
   * length, an origin that will not say) the unit simply steps 0 → 1 on completion; it never
   * invents a value in between.
   *
   * @returns {Promise<HTMLImageElement|null>} null on any failure — the drawn fallback stands.
   */
  async _fetchDecoded(src, onFraction) {
    let res;
    try {
      res = await fetch(src, { credentials: 'same-origin' });
    } catch (e) {
      Log.debug(`Menu: ${src} unavailable.`, e);
      return null;
    }
    if (!res.ok) { Log.debug(`Menu: ${src} returned ${res.status}.`); return null; }

    const total = Number(res.headers.get('content-length')) || 0;
    let blob = null;
    try {
      const reader = total > 0 ? res.body?.getReader?.() : null;
      if (reader) {
        const chunks = [];
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (this._disposed) { try { await reader.cancel(); } catch { /* noop */ } return null; }
          chunks.push(value);
          got += value.byteLength;
          onFraction(got / total < 1 ? got / total : 1);
        }
        blob = new Blob(chunks, { type: res.headers.get('content-type') || 'image/png' });
      } else {
        blob = await res.blob();
      }
    } catch (e) {
      Log.debug(`Menu: ${src} body read failed.`, e);
      return null;
    }
    if (this._disposed) return null;
    onFraction(1);

    const url = URL.createObjectURL(blob);
    this._blobUrls.push(url);
    const img = new Image();
    img.decoding = 'async';
    img.alt = '';
    img.draggable = false;
    img.src = url;
    const raster = typeof img.decode === 'function'
      ? img.decode()
      : new Promise((ok, no) => { img.onload = ok; img.onerror = no; });
    // Never let the raster be a hostage: see `_raceVisible()`. A rejection is not fatal either —
    // the bytes are already a blob and the element is already sourced from it.
    raster.catch((e) => Log.debug(`Menu: ${src} decode reported ${e?.name ?? e}.`));
    await this._raceVisible(raster);
    return this._disposed ? null : img;
  }

  /**
   * The first-screen preload. Started from the constructor, concurrent with the engine's bake.
   *
   * Only two files are on this path (see §0b). Everything else the menu ever shows is fetched
   * in `_preloadDeferred()`, after the player is looking at the title screen.
   */
  _preload() {
    if (this._preloadStarted || this._disposed) return;
    this._preloadStarted = true;

    // Unit 1. No web font is linked today, so this resolves almost immediately — but it is a
    // real check, and the day a face is added to index.html the type will stop reflowing under
    // the player. If the API is absent the unit is simply already satisfied.
    const fonts = globalThis.document?.fonts;
    if (fonts?.ready?.then) {
      fonts.ready.then(() => this._unit('fonts', 1), () => this._unit('fonts', 1));
    } else {
      this._unit('fonts', 1);
    }

    // Unit 2 + 3. The night photograph: the single biggest thing the first frame needs.
    this._fetchDecoded(SPLASH_SRC, (f) => this._unit('splashBytes', f)).then((img) => {
      this._unit('splashBytes', 1);
      this._unit('splashDecode', 1);
      if (!img || this._disposed) return;
      this._mark('splash-decoded');
      this._elSplash = img;
      this._applySplash();
    });

    // Unit 4. The booklet's own drawn plate. Fetch and decode count as one unit: it is a
    // third of the splash's weight and splitting it would only add a step nobody can read.
    this._fetchDecoded(TITLE_ART_SRC, (f) => this._unit('artBytes', f * 0.9)).then((img) => {
      if (img && !this._disposed) {
        this._mark('art-decoded');
        this._elTitleArt = img;
        img.className = 'sc-plate__art';
        if (this.screen === 'title') this._refresh();
      }
      this._unit('artBytes', 1);
    });

    // Unit 6. `engine:booted` says the loop has started; it does not say a frame has reached the
    // glass. Two rAFs after it, one has. That is what the player is actually waiting for, and on
    // every cold load measured it is the last unit to land — the engine, not the network, is the
    // long pole, and the plate now says so.
    const framePresented = () => {
      if (this._disposed) return;
      this._booted = true;
      const raf = globalThis.requestAnimationFrame;
      const twoFrames = typeof raf === 'function'
        ? new Promise((ok) => { raf(() => raf(() => ok())); })
        : Promise.resolve();
      // Hidden tab: rAF never fires (see `_raceVisible`). There is no frame to wait for.
      this._raceVisible(twoFrames).then(() => {
        this._mark('first-frame');
        this._unit('frame', 1);
      });
    };
    try { this.bus?.once?.('engine:booted', framePresented); } catch (e) {
      Log.warn('Menu: could not subscribe to engine:booted.', e);
      framePresented();
    }

    // The ceiling. Assets are decoration; the game is not. Past this the title opens on what it
    // has. The engine's own units are deliberately NOT released by this — a title screen over an
    // unbooted engine would be a menu over a black canvas, which is the bug, not the fix.
    this._after(ASSET_CEILING_MS, () => {
      if (this._preDone || this._disposed) return;
      const stuck = PRELOAD_UNITS
        .filter((u, i) => this._preP[i] < 1 && u.id !== 'systems' && u.id !== 'frame')
        .map((u) => u.id);
      if (!stuck.length) return;
      Log.warn(`Menu: first-screen assets still incomplete after ${ASSET_CEILING_MS} ms `
        + `(${stuck.join(', ')}) — opening the title on its drawn fallbacks.`);
      for (const id of stuck) this._unit(id, 1);
    });
  }

  /**
   * Everything the first screen does not use. Measured, these two were taking 3.4 MB of the pipe
   * in front of the splash and finishing before it: the pause sheet's cover and the night card's
   * paper stock, neither of which is reachable in the first seconds of a session.
   *
   * These stay plain URLs rather than decoded elements. Both land behind a scrim (the cover
   * renders at opacity .3; the card is multiplied under type), both replace a finished drawn
   * screen, and neither is ever the first thing a player sees — so a raster hitch on them is
   * invisible, and the cheaper mechanism is the right one.
   */
  _preloadDeferred() {
    if (this._deferredStarted || this._disposed || this._bootSuppressed()) return;
    this._deferredStarted = true;
    const load = (src, onOk) => {
      try {
        const im = new Image();
        im.decoding = 'async';
        im.onload = () => {
          if (this._disposed) return;
          onOk(src);
          if (this.screen === 'pause') this._refresh();
        };
        im.onerror = () => { /* the drawn fallback is already on screen */ };
        im.src = src;
      } catch { /* noop */ }
    };
    load(COVER_SRC, (s) => { this._imgCover = s; });
    load(CARD_SRC, (s) => { this._imgCard = s; });
  }

  /** Record a unit's fraction and update the plate. Monotonic: a unit never goes backwards. */
  _unit(id, fraction) {
    const i = PRELOAD_UNITS.findIndex((u) => u.id === id);
    if (i < 0 || this._disposed) return;
    const f = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
    if (f <= this._preP[i]) return;
    this._preP[i] = f;

    let complete = true;
    for (let k = 0; k < PRELOAD_UNITS.length; k++) if (this._preP[k] < 1) complete = false;
    this._setProgress(this._progress());

    if (complete && !this._preDone) {
      this._preDone = true;
      this._preDoneAt = globalThis.performance?.now?.() ?? Date.now();
      this._mark('preload-complete');
      this._maybeReveal();
    }
  }

  /** The weighted sum — the one number the plate reports, and the only one. */
  _progress() {
    let total = 0;
    for (let k = 0; k < PRELOAD_UNITS.length; k++) total += PRELOAD_UNITS[k].weight * this._preP[k];
    return total;
  }

  /** Move the six boxes and the dimension line. Called once per completion, never per frame. */
  _setProgress(t) {
    if (!this._plateSvg) return;
    const boxes = this._plateBoxes;
    if (boxes) {
      for (let i = 0; i < boxes.length; i++) {
        const on = this._preP[i] >= 1 ? '1' : '0';
        if (boxes[i].dataset.on !== on) boxes[i].dataset.on = on;
      }
    }
    const span = PLATE_SPAN_X1 - PLATE_SPAN_X0;
    const x = span * (t < 0 ? 0 : t > 1 ? 1 : t);
    this._plateSpan?.setAttribute('stroke-dashoffset', String(Math.round((span - x) * 100) / 100));
    this._plateHead?.setAttribute(
      'transform', `translate(${Math.round((PLATE_SPAN_X0 + x) * 100) / 100} ${PLATE_SPAN_Y})`,
    );
  }

  /** The photographic night plate behind the title sheet. Absent → the live world alone. */
  _applySplash() {
    if (!this._root || !this._splashEl || !this._elSplash) return;
    if (this._elSplash.parentNode !== this._splashEl) {
      this._splashEl.replaceChildren(this._elSplash);
    }
    this._root.dataset.splash = '1';
    this._mark('splash-applied');
    // Normal path: the plate is still up, nothing is visible yet, and this is free. Degraded
    // path: the ceiling already opened the title, so the photograph must arrive as a fade and
    // not as a cut. Driven by rAF rather than a CSS transition on purpose — a backgrounded tab
    // freezes the CSS timeline and can strand a layer at its FROM value, which is how this
    // element spent its first hour: correct in the cascade, invisible on screen.
    if (this._revealed) this._fadeSplashIn();
  }

  _fadeSplashIn() {
    const el = this._splashEl;
    if (!el || this._fadeRaf) return;
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf !== 'function') return;
    const t0 = globalThis.performance?.now?.() ?? Date.now();
    el.style.opacity = '0';
    const step = () => {
      this._fadeRaf = 0;
      if (this._disposed || !this._splashEl) return;
      const now = globalThis.performance?.now?.() ?? Date.now();
      const k = (now - t0) / 900;
      if (k >= 1) { el.style.opacity = ''; return; }   // hand it back to the stylesheet at .93
      el.style.opacity = String(0.93 * k * k * (3 - 2 * k));
      this._fadeRaf = raf(step);
    };
    this._fadeRaf = raf(step);
  }

  /* ------------------------------------------------------------------ the boot plate */

  /** True when the URL asks for a bare canvas (screenshot harness, embed). */
  _bootSuppressed() {
    const p = this._params();
    return p.has('shot') || p.has('shots') || p.has('nomenu');
  }

  /**
   * Raised by the constructor, before any heavy system has init()ed, and torn down by init()
   * or by `engine:booted` — whichever arrives first. The boot plate is its own element rather
   * than a screen so it cannot collide with `screen`/`isOpen` or with pointer-lock logic.
   */
  _showLoading() {
    if (!this._root || this._loadingEl) return;

    const el = document.createElement('div');
    el.className = 'sc-loading';
    el.dataset.off = '0';
    el.innerHTML = `
      <div class="sc-load__sheet">
        <div class="sc-head">
          <span class="sc-prop">${esc(PROPERTY_STAMP)}</span>
          <span class="sc-dim-text">ART. NO. ${esc(ARTICLE_NO)}</span>
        </div>
        <div class="sc-load__plate">${svgContentsPlate()}</div>
        <div class="sc-foot">
          <span class="sc-load__word">CHECK CONTENTS BEFORE BEGINNING.</span>
          <span class="sc-dim-text">${esc(MAKERS_MARK)}</span>
        </div>
      </div>`;
    this._root.appendChild(el);
    this._loadingEl = el;
    this._plateAt = globalThis.performance?.now?.() ?? Date.now();
    this._mark('plate-visible');

    // Cache the nodes `_setProgress()` mutates, so reporting progress never touches innerHTML
    // and never re-parses the drawing out from under its own transitions.
    this._plateSvg = el.querySelector('.sc-load__plate svg');
    this._plateBoxes = this._plateSvg ? el.querySelectorAll('.sc-ld-box') : null;
    this._plateSpan = el.querySelector('.sc-ld-span');
    this._plateHead = el.querySelector('.sc-ld-head');
    this._setProgress(this._progress());

    // Absolute failsafe. `engine:booted` is NOT a teardown any more — it is unit 6, and the
    // plate's whole job is to outlive it by however long the first screen still needs. But a
    // system that never returns must not strand the player behind a sheet, so this stands.
    this._after(PLATE_FAILSAFE_MS, () => {
      if (this._revealed || this._disposed) return;
      Log.warn(`Menu: boot did not complete within ${PLATE_FAILSAFE_MS} ms — revealing anyway.`);
      this._revealed = true;
      if (this.screen === null && (this.ctx.state?.phase ?? 'menu') === 'menu') this.showTitle();
      this._hideLoading();
    });
  }

  /**
   * The single moment. Called by every unit as it lands, by init(), and by its own timer; it is
   * idempotent and it is the only way the title screen is ever opened on a normal boot.
   *
   * Three gates, all of which must be past:
   *   - the first screen is complete (or the ceiling released it),
   *   - every system has init()ed, so there is a world behind the paper,
   *   - the plate has been up long enough to read as a deliberate object rather than a flash.
   */
  _maybeReveal() {
    if (this._disposed || this._revealed) return;
    if (this._bootHidden || this._bootSuppressed() || this._reviewMode) return;
    if (!this._systemsReady || !this._preDone) return;
    // Something else took the screen while we were loading (a night began, a review hook fired).
    // The plate is not the owner of that transition — get out of its way and stop.
    if (this.screen !== null) { this._revealed = true; this._hideLoading(); return; }

    const now = globalThis.performance?.now?.() ?? Date.now();
    const earliest = Math.max(this._plateAt + MIN_PLATE_MS, this._preDoneAt + PLATE_SETTLE_MS);
    if (now < earliest) {
      if (!this._revealTimer) {
        this._revealTimer = this._after(Math.ceil(earliest - now), () => {
          this._revealTimer = 0;
          this._maybeReveal();
        });
      }
      return;
    }

    this._revealed = true;
    this._mark('title-mounted');
    this.showTitle();

    // Let the sheet's own entrance finish while it is still hidden, then draw the curtain.
    // Two motions at once would read as a web page assembling itself; one fade of a finished
    // page reads as a page being turned, which is the only metaphor this game has.
    this._after(SHEET_SETTLE_MS, () => {
      this._mark('title-revealed');
      this._hideLoading();
      this._preloadDeferred();
    });
  }

  _hideLoading() {
    const el = this._loadingEl;
    if (!el) return;
    this._loadingEl = null;
    this._plateSvg = this._plateBoxes = this._plateSpan = this._plateHead = null;
    el.dataset.off = '1';
    this._after(PLATE_FADE_MS + 40, () => el.remove());
    // Whatever route got us here — reveal, review hook, failsafe — the deferred art is now safe
    // to fetch: the pipe is no longer in front of anything the player is waiting on.
    this._after(PLATE_FADE_MS, () => this._preloadDeferred());
  }

  /* ------------------------------------------------------------------ screen plumbing */

  _open(name, html, opts) {
    if (this._disposed) return;
    // No DOM (headless / construction failed): record the screen so state queries stay coherent,
    // but never claim to have opened anything.
    if (!this._root || !this._stage) { this.screen = name; return; }

    const first = this.screen === null;
    this.screen = name;
    this._closing = false;
    this._root.dataset.closing = '0';
    this._root.dataset.screen = name;

    const st = this._root.style;
    st.setProperty('--sc-scrim', String(opts.scrim ?? 0.4));
    st.setProperty('--sc-blur', `${opts.blur ?? 0}px`);
    st.setProperty('--sc-sat', String(opts.sat ?? 1));
    st.setProperty('--sc-bri', String(opts.bri ?? 1));
    st.setProperty('--sc-sheet-w', opts.width ?? (opts.closed ? '27rem' : (opts.wide ? '64rem' : '68rem')));

    this._stage.innerHTML = html;
    this._sheetEl = this._stage.querySelector('.sc-sheet');
    this._graftArt();
    this._root.dataset.open = '1';

    if (name === 'title') this._mark('title-shown');

    this._collect();
    this._releaseLock();
    this._setEnginePaused(!!opts.pause);
    if (opts.pause) this._startPadPoll(); else this._stopPadPoll();
    this.resize(this.ctx.width ?? 0, this.ctx.height ?? 0);
    if (!first) this._sfx('ui.page', 0.8);
  }

  /**
   * Move the decoded title art into whatever markup was just written. The element is a single
   * live node, so it is moved rather than copied; `.sc-plate img` already carries its sizing and
   * the `mix-blend-mode: darken` that dissolves the plate's slightly lighter stock into ours.
   */
  _graftArt() {
    if (!this._elTitleArt || !this._stage) return;
    const slot = this._stage.querySelector('.sc-plate');
    if (slot && this._elTitleArt.parentNode !== slot) slot.appendChild(this._elTitleArt);
  }

  /** Re-render the current screen in place (art arrived, a setting changed). */
  _refresh() {
    if (!this._stage || this.screen === null) return;
    const keepIndex = this._index;
    const keepRow = this._rowIndex;
    const keepScroll = this._stage.querySelector('.sc-scroll')?.scrollTop ?? 0;

    let html = null;
    if (this.screen === 'title') html = this._renderTitle();
    else if (this.screen === 'pause') html = this._renderPause();
    else if (this.screen === 'settings') html = this._renderSettings();
    if (html === null) return;

    this._stage.innerHTML = html;
    this._sheetEl = this._stage.querySelector('.sc-sheet');
    this._graftArt();
    this._collect();
    this._index = clamp(keepIndex, 0, Math.max(0, this._items.length - 1));
    this._rowIndex = clamp(keepRow, 0, Math.max(0, this._rows.length - 1));
    this._syncSelection(false);
    const sc = this._stage.querySelector('.sc-scroll');
    if (sc) sc.scrollTop = keepScroll;
  }

  /** Index every interactive element and wire it up. */
  _collect() {
    this._items.length = 0;
    this._rows.length = 0;
    if (!this._stage) return;

    for (const el of this._stage.querySelectorAll('.sc-step')) {
      const disabled = el.getAttribute('aria-disabled') === 'true';
      this._items.push({ el, action: el.dataset.action ?? '', disabled });
      el.addEventListener('click', (e) => {
        e.preventDefault();
        if (disabled) { this._sfx('ui.deny', 0.8); return; }
        this._activate(el.dataset.action ?? '');
      });
      el.addEventListener('pointerenter', () => {
        const i = this._items.findIndex((it) => it.el === el);
        if (i >= 0 && !disabled && i !== this._index) { this._index = i; this._syncSelection(true); }
      });
    }

    for (const row of this._stage.querySelectorAll('.sc-row')) this._rows.push(row);
    this._wireControls();

    this._index = this._items.findIndex((it) => !it.disabled);
    if (this._index < 0) this._index = 0;
    this._rowIndex = 0;
    this._syncSelection(false);
  }

  _syncSelection(sound) {
    for (let i = 0; i < this._items.length; i++) {
      this._items[i].el.classList.toggle('is-sel', i === this._index);
    }
    for (let i = 0; i < this._rows.length; i++) {
      this._rows[i].classList.toggle('is-sel', this.screen === 'settings' && i === this._rowIndex);
    }
    if (sound) this._sfx('ui.click', 0.55);
  }

  _move(delta) {
    if (!this._items.length) return;
    let i = this._index;
    for (let n = 0; n < this._items.length; n++) {
      i = (i + delta + this._items.length) % this._items.length;
      if (!this._items[i].disabled) break;
    }
    if (i === this._index) return;
    this._index = i;
    this._syncSelection(true);
  }

  _moveRow(delta) {
    if (!this._rows.length) return;
    this._rowIndex = clamp(this._rowIndex + delta, 0, this._rows.length - 1);
    this._syncSelection(true);
    this._rows[this._rowIndex]?.scrollIntoView?.({ block: 'nearest' });
  }

  /* ------------------------------------------------------------------ actions */

  _activate(action) {
    switch (action) {
      case 'assemble': this._sfx('ui.click', 0.9); this._startGame(true); break;
      case 'continue': this._sfx('ui.click', 0.9); this._startGame(false); break;
      case 'settings': this.showSettings(); break;
      case 'exit': this._open('confirm', this._renderConfirm('exit'), { scrim: 0.5, blur: 8, sat: 0.6, bri: 0.5, pause: false, closed: true }); break;
      case 'exit-confirm': this._exit(); break;
      case 'resume': this.hide(); break;
      case 'abandon': this._open('confirm', this._renderConfirm('abandon'), { scrim: 0.55, blur: 13, sat: 0.55, bri: 0.44, pause: true, closed: true }); break;
      case 'abandon-confirm': this._abandonNight(); break;
      case 'back': this._back(); break;
      case 'settings-return': this._back(); break;
      case 'defaults': this._restoreDefaults(); break;
      case 'report-next': this._afterReport(true); break;
      case 'report-title': this._afterReport(false); break;
      default: break;
    }
  }

  /** Escape / RETURN, from wherever we are. */
  _back() {
    switch (this.screen) {
      case 'settings':
        if (this._settingsReturn === 'pause') this.showPause();
        else this.showTitle();
        break;
      case 'confirm':
        if (this._enginePaused || PLAYABLE_PHASES.has(this.ctx.state?.phase ?? '')) this.showPause();
        else this.showTitle();
        break;
      case 'pause':
        this.hide();
        break;
      case 'report':
        // Escape means "back" everywhere else in this file, so it means "back" here too.
        // Advancing a night is a decision the form asks you to make with a numbered step.
        this._afterReport(false);
        break;
      case 'title':
      default:
        break;
    }
  }

  /**
   * Start or resume a run.
   *
   * `night:begin` and `game:start` belong to NightManager (ARCHITECTURE §5), so we call its API
   * when it exists. TODO(api): NightManager does not yet document a start method — we probe for
   * the obvious four. When it is absent entirely we emit the canonical events ourselves, because
   * a title screen whose ASSEMBLE button does nothing is worse than a documented deviation.
   */
  _startGame(fresh) {
    const state = this.ctx.state;
    if (fresh) {
      try { state?.clearSave?.(); } catch { /* noop */ }
      try { state?.reset?.(); } catch { /* noop */ }
    } else if (state && typeof state.load === 'function') {
      if (!state.load()) Log.debug('Menu: continue requested but no save loaded.');
    }

    const nm = this.ctx.systems?.get?.('NightManager') ?? null;
    const night = clamp(Math.round(state?.night ?? 1), 1, 7);
    const started = this._callFirst(nm, ['startNight', 'beginNight', 'start', 'begin'], night);

    if (!started) {
      if (nm) Log.debug('Menu: NightManager present but exposes no start method — emitting directly.');
      try { state?.setPhase?.('build'); } catch { /* noop */ }
      this.bus?.emit('game:start', {});
      const blueprint = this.ctx.systems?.get?.('Blueprint')?.forNight?.(night) ?? null;
      this.bus?.emit('night:begin', { night, blueprint });
    }

    this._nightStartedAt = (globalThis.performance?.now?.() ?? Date.now()) / 1000;
    // `night:begin` may have closed us already; hide() no-ops then. Ask for the pointer either
    // way — NightManager may set the phase after emitting, and _requestLock re-checks on a timer.
    this.hide();
    this._requestLock();
  }

  _abandonNight() {
    const night = clamp(Math.round(this.ctx.state?.night ?? 1), 1, 7);
    const nm = this.ctx.systems?.get?.('NightManager') ?? null;
    const handled = this._callFirst(nm, ['abandonNight', 'failNight', 'abandon'], 'abandoned');

    this._setEnginePaused(false);
    if (!handled) {
      try { this.ctx.state?.setPhase?.('menu'); } catch { /* noop */ }
      this.bus?.emit('night:failed', { night, reason: 'abandoned' });
    }
    this.showTitle();
  }

  _afterReport(advance) {
    const state = this.ctx.state;
    if (advance && state) {
      const next = clamp(Math.round((state.night ?? 1) + 1), 1, 8);
      if (next <= 7) {
        state.night = next;
        try { state.resetNight?.(); } catch { /* noop */ }
        try { state.save?.(); } catch { /* noop */ }
        this._startGame(false);
        return;
      }
    }
    try { state?.setPhase?.('menu'); } catch { /* noop */ }
    this.showTitle();
  }

  _exit() {
    this._releaseLock();
    this._setEnginePaused(true);
    // A browser tab cannot usually be closed by script. The document simply stops.
    try { globalThis.close?.(); } catch { /* noop */ }
    this._open('blank', this._renderBlank(), { scrim: 0.8, blur: 16, sat: 0.3, bri: 0.35, pause: true, closed: true });
  }

  _restoreDefaults() {
    const s = this.ctx.settings;
    if (!s) return;
    try { s.reset?.(); } catch (e) { Log.warn('Menu: settings reset failed', e); }
    this._applyVisionMode();
    this._refresh();
    this._sfx('ui.click', 0.9);
  }

  /* ------------------------------------------------------------------ renderers */

  _renderTitle() {
    const hasSave = this._hasSave();
    const saveNight = clamp(Math.round(this._savedNight() ?? 1), 1, 7);
    const parts = this._totalParts();
    const steps = this._totalSteps();
    // The supplied plate already carries the red rule and the hardware roundels; the drawn
    // fallback has to print them itself, so the two versions of this sheet say the same things.
    //
    // When the art is present the slot is left EMPTY here and `_graftArt()` moves the decoded
    // element into it after the markup lands. Re-emitting `<img src>` would ask the browser for
    // the picture a second time — a request whose cost is entirely at the mercy of the origin's
    // cache headers, and which measured as a full 1,205 KB re-download on a `no-store` origin,
    // arriving 3.7 s after the sheet it belongs to.
    const plate = this._elTitleArt
      ? ''
      : `<div class="sc-plate__draw">${svgCabin()}</div>
          <div class="sc-plate__rule"></div>
          <div class="sc-plate__hw">${svgHardware()}</div>`;

    return `
      <section class="sc-sheet sc-sheet--title" role="dialog" aria-label="Slasher Cabin">
      <div class="sc-body">
        <div class="sc-head">
          <span class="sc-prop">${esc(PROPERTY_STAMP)}</span>
          <span class="sc-dim-text">ART. NO. ${esc(ARTICLE_NO)}</span>
        </div>

        <div class="sc-title-grid">
          <div class="sc-plate">${plate}</div>

          <div class="sc-lock">
            <h1 class="sc-title">Slasher Cabin</h1>
            <div class="sc-subtitle">Some assembly required</div>
            <div class="sc-rule-red"></div>
            <p class="sc-tagline">Build it and they will die.</p>
            <p class="sc-tagline sc-tagline--note">TWO PERSONS RECOMMENDED.</p>

            <div class="sc-steps" role="menu">
              ${this._step(1, 'ASSEMBLE', 'assemble', 'STEP 1 OF 7')}
              ${this._step(2, 'CONTINUE', 'continue', hasSave ? `STEP ${saveNight} OF 7` : '', !hasSave)}
              ${this._step(3, 'SETTINGS', 'settings', 'SPECIFICATIONS')}
              ${this._step(4, 'EXIT', 'exit', '')}
            </div>
          </div>
        </div>

        <div class="sc-foot">
          <span class="sc-specs">
            <span>PARTS <b>${group(parts)}</b></span>
            <span>STEPS <b>${group(steps)}</b></span>
          </span>
          <span class="sc-dim-text">${esc(MAKERS_MARK)} · 1962</span>
        </div>
      </div>
      </section>`;
  }

  _renderPause() {
    const night = clamp(Math.round(this.ctx.state?.night ?? 1), 1, 7);
    const name = ASSEMBLY_NAMES[night] ?? '';
    const instr = stepInstruction(night);
    const cover = this._imgCover
      ? `<img src="${esc(this._imgCover)}" alt="" draggable="false">`
      : svgCabin();

    return `
      <section class="sc-sheet sc-sheet--closed" role="dialog" aria-label="Paused">
      <div class="sc-body">
        <div class="sc-head">
          <span class="sc-prop">${esc(PROPERTY_STAMP)}</span>
          <span class="sc-dim-text">STEP ${night} OF 7</span>
        </div>

        <h2 class="sc-title" style="font-size:clamp(1.5rem,4.2vmin,2.5rem)">${esc(name)}</h2>
        <div class="sc-subtitle" style="letter-spacing:.2em">${esc(instr)}</div>
        <div class="sc-progress">${svgSegments(night, 7)}</div>
        <div class="sc-cover">${cover}</div>

        <div class="sc-steps" role="menu">
          ${this._step(1, 'RESUME', 'resume', '')}
          ${this._step(2, 'SETTINGS', 'settings', '')}
          ${this._step(3, 'ABANDON STEP', 'abandon', '')}
        </div>

        <div class="sc-foot">
          <span class="sc-dim-text">ART. NO. ${esc(ARTICLE_NO)}</span>
          <span class="sc-dim-text">${esc(MAKERS_MARK)}</span>
        </div>
      </div>
      </section>`;
  }

  _renderConfirm(kind) {
    const abandoning = kind === 'abandon';
    const line = abandoning
      ? 'PROGRESS ON THIS STEP WILL NOT BE RETAINED.'
      : 'THIS SESSION WILL END.';
    return `
      <section class="sc-sheet sc-sheet--closed" role="alertdialog" aria-label="Confirm">
      <div class="sc-body">
        <div class="sc-head">
          <span class="sc-prop">${esc(PROPERTY_STAMP)}</span>
          <span class="sc-dim-text">ART. NO. ${esc(ARTICLE_NO)}</span>
        </div>

        <div class="sc-warn">
          <span class="sc-lozenge" aria-hidden="true">!</span>
          <p>${esc(line)}</p>
        </div>
        <div class="sc-rule-red"></div>

        <div class="sc-steps" role="menu">
          ${this._step(1, 'CONFIRM', abandoning ? 'abandon-confirm' : 'exit-confirm', '')}
          ${this._step(2, 'BACK', 'back', '')}
        </div>

        <div class="sc-foot">
          <span class="sc-dim-text">RETAIN THIS DOCUMENT.</span>
          <span class="sc-dim-text">${esc(MAKERS_MARK)}</span>
        </div>
      </div>
      </section>`;
  }

  _renderBlank() {
    return `
      <section class="sc-sheet sc-sheet--closed" role="document" aria-label="Blank">
      <div class="sc-body">
        <div class="sc-blank"><span>${esc(MAKERS_MARK)}</span></div>
      </div>
      </section>`;
  }

  _renderSettings() {
    const sections = SETTINGS_SECTIONS.map((sec) => {
      const rows = sec.rows.map((row) => this._settingRow(row)).join('\n');
      return `
        <div class="sc-sect">
          <span class="sc-sect__n">${esc(sec.n)}</span>
          <span class="sc-sect__name">${esc(sec.name)}</span>
        </div>
        ${rows}`;
    }).join('\n');

    return `
      <section class="sc-sheet" role="dialog" aria-label="Specifications">
      <div class="sc-body">
        <div class="sc-head">
          <span class="sc-prop">${esc(PROPERTY_STAMP)}</span>
          <span class="sc-dim-text">SPECIFICATIONS · ART. NO. ${esc(ARTICLE_NO)}</span>
        </div>

        <div class="sc-scroll">${sections}</div>

        <div class="sc-steps" role="menu" style="margin-top:1.2em">
          ${this._step(1, 'RETURN', 'settings-return', '')}
          ${this._step(2, 'RESTORE AS SUPPLIED', 'defaults', '')}
        </div>

        <div class="sc-foot">
          <span class="sc-dim-text">SETTINGS ARE RETAINED BETWEEN SESSIONS.</span>
          <span class="sc-dim-text">${esc(MAKERS_MARK)}</span>
        </div>
      </div>
      </section>`;
  }

  /**
   * THE ASSEMBLY REPORT.
   *
   * A form that counts joins and tolerances with total sincerity and is quietly, appallingly
   * indifferent to context. It never mentions a person, never mentions difficulty, and never
   * notices anything. That is the whole device — see the register test at the top of this file.
   */
  _renderReport(score, night, failed) {
    // STORY §12.3 — Night Seven's card ignores every field and renders one page.
    if (night >= 7) {
      return `
        <section class="sc-sheet" role="dialog" aria-label="Assembly complete">
        <div class="sc-body">
          <div class="sc-hjem">
            <b>${esc(ASSEMBLY_NAMES[7])}</b>
            <span>${esc(MAKERS_MARK)}</span>
          </div>
          <div class="sc-steps sc-steps--centre" role="menu">
            ${this._step(1, 'CLOSE', 'report-title', '')}
          </div>
        </div>
        </section>`;
    }

    const name = ASSEMBLY_NAMES[night] ?? '';
    const def = Script?.nightDef?.(night) ?? null;
    const q = score.assemblyQuality;

    const values = {
      partsInstalled: `${group(score.partsInstalled)} / ${group(score.partsTotal)}`,
      joinsCorrect: group(score.joinsCorrect),
      joinsNotAsIllustrated: group(score.joinsNotAsIllustrated),
      joinsRequiringReplacement: group(score.joinsRequiringReplacement),
      fastenersSupplied: group(score.fastenersSupplied),
      fastenersRequired: group(score.fastenersRequired),
      creaks: group(score.creaks),
      metresHauled: `${group(score.metresHauled)} m`,
      timeRemaining: mmss(score.timeRemainingSeconds),
      satisfaction: `${group(q)} / 100`,
    };

    const rows = REPORT_LINES.filter((l) => night <= l.untilNight).map((l) => {
      if (l.id === 'satisfaction') {
        return `
          <li class="sc-rrow sc-rrow--meter">
            <span class="sc-rrow__label">${esc(l.label)}</span>
            <span class="sc-meter">${svgSatisfaction(q)}</span>
            <span class="sc-rrow__value">${esc(values[l.id])}</span>
          </li>`;
      }
      return `
          <li class="sc-rrow">
            <span class="sc-rrow__label">${esc(l.label)}</span>
            <span class="sc-rrow__lead"></span>
            <span class="sc-rrow__value">${esc(values[l.id])}</span>
          </li>`;
    }).join('\n');

    // GAME_DESIGN §15.2: line 12 is dropped after Night Three. The manual stops thanking you
    // the night the comedy dies. Nothing announces it.
    const notes = [];
    if (night <= 3) notes.push('THANK YOU FOR CHOOSING SELF-ASSEMBLY.');
    if (night <= 6 && q >= 95) notes.push('NO FURTHER ACTION REQUIRED.');
    if (night <= 6 && q <= 20) notes.push('RETAIN THIS DOCUMENT.');
    if (failed) notes.push('THIS STEP MUST BE REPEATED.');
    const noteHtml = notes.map((t) => `<p class="sc-rnote">${esc(t)}</p>`).join('\n');

    const verdict = verdictFor(q, failed);
    const posture = postureFor(q, night);
    const elapsed = hhmmss(score.timeUsedSeconds);
    const sub = def?.subtitle ?? '';

    const advance = night < 7 && !failed;
    const steps = advance
      ? `${this._step(1, 'CONTINUE', 'report-next', `STEP ${night + 1} OF 7`)}
             ${this._step(2, 'CLOSE', 'report-title', '')}`
      : `${this._step(1, 'CLOSE', 'report-title', '')}`;

    return `
      <section class="sc-sheet" role="dialog" aria-label="Assembly report">
      <div class="sc-body">
        <div class="sc-head">
          <span class="sc-prop">${esc(PROPERTY_STAMP)}</span>
          <span class="sc-dim-text">SESSION ${esc(elapsed)} · ART. NO. ${esc(ARTICLE_NO)}</span>
        </div>

        <div class="sc-scroll">
        <div class="sc-report">
          <div>
            <div class="sc-rhead">
              <div class="sc-rhead__kicker">ASSEMBLY REPORT — STEP ${night} OF 7</div>
              <div class="sc-rhead__name">${esc(name)}</div>
              <div class="sc-rhead__instr">${esc(stepInstruction(night))}</div>
              <p class="sc-rhead__sub">${esc(sub)}</p>
              <div class="sc-rhead__subrule"></div>
            </div>
            <div class="sc-rule-red"></div>
            <ul class="sc-rrows">${rows}</ul>
            ${noteHtml}
          </div>

          <div class="sc-report__aside">
            <div class="sc-report__inspector">DISPOSITION</div>
            <div class="sc-report__figure">${svgBjorn(posture)}</div>
            <div class="sc-rstamp">
              <div class="sc-stampbox">
                <div class="sc-stampbox__word">${esc(verdict)}</div>
                <div class="sc-stampbox__meta">INSP. 07 · 1984-06-0${night}</div>
              </div>
            </div>
          </div>
        </div>
        </div>

        <div class="sc-steps" role="menu">${steps}</div>

        <div class="sc-foot">
          <span class="sc-dim-text">ILLUSTRATION MAY DIFFER FROM PRODUCT.</span>
          <span class="sc-dim-text">${esc(MAKERS_MARK)}</span>
        </div>
      </div>
      </section>`;
  }

  /** One numbered manual step. `n` is the badge glyph; disabled steps get the dashed circle. */
  _step(n, label, action, spec, disabled = false) {
    return `<button type="button" class="sc-step" role="menuitem" data-action="${esc(action)}"
              aria-disabled="${disabled ? 'true' : 'false'}">
              <span class="sc-step__mark" aria-hidden="true"></span>
              <span class="sc-step__badge" aria-hidden="true">${n}</span>
              <span class="sc-step__label">${esc(label)}</span>
              <span class="sc-step__spec">${esc(spec ?? '')}</span>
            </button>`;
  }

  /* ------------------------------------------------------------------ settings controls */

  _settingRow(row) {
    const s = this.ctx.settings;
    const raw = s?.get?.(row.key);
    const type = row.type === 'auto' ? (typeof raw === 'boolean' ? 'bool' : 'seg') : row.type;

    let control = '';
    let value = '';

    if (type === 'bool') {
      const on = !!raw;
      control = `<button type="button" class="sc-check" data-key="${esc(row.key)}" data-type="bool"
                   role="checkbox" aria-checked="${on}"
                   aria-label="${esc(row.label)}">${svgTick()}</button>`;
      value = on ? 'ON' : 'OFF';
    } else if (type === 'seg') {
      const opts = this._optionsFor(row, raw);
      control = `<div class="sc-seg" role="radiogroup" aria-label="${esc(row.label)}">`
        + opts.map(([v, lab]) => `<button type="button" role="radio" data-key="${esc(row.key)}"
              data-type="seg" data-value="${esc(v)}"
              aria-checked="${String(raw) === String(v)}">${esc(lab)}</button>`).join('')
        + `</div>`;
      const match = opts.find(([v]) => String(raw) === String(v));
      value = match ? match[1] : String(raw ?? '');
    } else {
      const num = Number.isFinite(Number(raw)) ? Number(raw) : row.min;
      control = `<div class="sc-dim">
                   <input type="range" data-key="${esc(row.key)}" data-type="range"
                          min="${row.min}" max="${row.max}" step="${row.step}" value="${num}"
                          aria-label="${esc(row.label)}">
                 </div>`;
      value = this._formatRange(row, num);
    }

    return `
        <div class="sc-row" data-key="${esc(row.key)}">
          <span class="sc-row__label">${esc(row.label)}</span>
          ${control}
          <span class="sc-row__value" data-value-for="${esc(row.key)}">${esc(value)}</span>
        </div>`;
  }

  _formatRange(row, num) {
    if (row.pct) return `${Math.round(num * 100)}%`;
    const dp = row.dp ?? 2;
    return `${num.toFixed(dp)}${row.unit ?? ''}`;
  }

  /**
   * Union the declared options with whatever is actually stored, so a value written by a future
   * Settings revision (GAME_DESIGN §16 asks for `gristle`, and a three-state `puzzleHints`)
   * is displayed and selectable rather than silently clobbered by this menu.
   */
  _optionsFor(row, raw) {
    const opts = (row.options ?? []).slice();
    if (raw !== undefined && raw !== null && !opts.some(([v]) => String(v) === String(raw))) {
      opts.push([String(raw), String(raw).toUpperCase().slice(0, 9)]);
    }
    return opts;
  }

  _wireControls() {
    if (!this._stage) return;
    const s = this.ctx.settings;

    for (const el of this._stage.querySelectorAll('[data-type="bool"]')) {
      el.addEventListener('click', () => {
        const key = el.dataset.key;
        const next = !(s?.get?.(key));
        this._write(key, next);
        el.setAttribute('aria-checked', String(next));
        this._setValueText(key, next ? 'ON' : 'OFF');
        this._sfx('ui.click', 0.7);
      });
    }

    for (const el of this._stage.querySelectorAll('[data-type="seg"]')) {
      el.addEventListener('click', () => {
        const key = el.dataset.key;
        const val = el.dataset.value;
        this._write(key, val);
        const group_ = el.parentElement;
        for (const sib of group_.querySelectorAll('button')) {
          sib.setAttribute('aria-checked', String(sib === el));
        }
        this._setValueText(key, el.textContent.trim());
        this._sfx('ui.click', 0.7);
      });
    }

    for (const el of this._stage.querySelectorAll('[data-type="range"]')) {
      const row = this._rowSpec(el.dataset.key);
      const apply = () => {
        const key = el.dataset.key;
        const num = Number(el.value);
        this._write(key, num);
        if (row) this._setValueText(key, this._formatRange(row, num));
      };
      el.addEventListener('input', apply);
      el.addEventListener('change', apply);
    }
  }

  _rowSpec(key) {
    for (const sec of SETTINGS_SECTIONS) {
      for (const row of sec.rows) if (row.key === key) return row;
    }
    return null;
  }

  _setValueText(key, text) {
    if (!this._stage) return;
    for (const el of this._stage.querySelectorAll('[data-value-for]')) {
      if (el.getAttribute('data-value-for') === key) { el.textContent = text; return; }
    }
  }

  /**
   * The one place a setting is written. `Settings.set()` emits `settings:changed`, which every
   * consumer already listens to: Engine re-applies fov and resizes on quality/dprCap,
   * Postprocessing reads its toggles per frame, AudioEngine re-applies the four bus volumes,
   * Music and VoiceBank re-read theirs. Nothing else is needed to make a control live.
   */
  _write(key, value) {
    const s = this.ctx.settings;
    if (!s || typeof s.set !== 'function') return;
    try {
      s.set(key, value);
    } catch (e) {
      Log.warn(`Menu: could not write setting '${key}'`, e);
      return;
    }
    if (key === 'colorblind') this._applyVisionMode();
    if (key === 'reducedMotion' && this._root) {
      if (value) this._root.dataset.reduced = '1';
      else delete this._root.dataset.reduced;
    }
  }

  /** GAME_DESIGN §16.2 — the manual's red is the only load-bearing colour in the game. */
  _applyVisionMode() {
    if (!this._root) return;
    const mode = this.ctx.settings?.get?.('colorblind') ?? 'none';
    this._root.style.setProperty('--sc-red', RED_BY_VISION[mode] ?? RED);
  }

  /* ------------------------------------------------------------------ scoring */

  /**
   * Fill in every field of GAME_DESIGN §15.1's `Score` from whatever NightManager supplied,
   * falling back to GameState. The card must be complete and it must be honest: a bucket we
   * cannot observe is reported as zero, never invented.
   */
  _normalizeScore(raw, night, failed) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const state = this.ctx.state ?? {};
    const stats = state.stats ?? {};
    const def = Script?.nightDef?.(night) ?? null;

    const installedMap = state.installed && typeof state.installed === 'object' ? state.installed : {};
    const installed = Object.values(installedMap);

    const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

    const partsInstalled = Math.max(0, Math.round(num(src.partsInstalled, installed.length)));
    const partsTotal = Math.max(
      partsInstalled,
      Math.round(num(src.partsTotal, def?.slotCount ?? Math.max(partsInstalled, 1))),
    );

    const joinsCorrect = clamp(
      Math.round(num(src.joinsCorrect, installed.filter((i) => i && i.correct).length)),
      0, partsInstalled,
    );

    const underFastened = Math.max(0, Math.round(num(src.joinsUnderFastened, 0)));
    const rotated = Math.max(0, Math.round(num(src.joinsRotated, 0)));
    const wrongSlot = Math.max(0, Math.round(num(src.joinsWrongSlot, 0)));
    const wrongPart = Math.max(0, Math.round(num(src.joinsWrongPart, 0)));

    // If NightManager gave us no breakdown, everything not correct is reported in the softer
    // bucket rather than distributed across buckets we did not measure.
    const bucketed = underFastened + rotated + wrongSlot + wrongPart;
    const unaccounted = Math.max(0, partsInstalled - joinsCorrect - bucketed);
    const notAsIllustrated = underFastened + rotated + unaccounted;
    const requiringReplacement = wrongSlot + wrongPart;

    const perfectJoins = Math.max(0, Math.round(num(src.perfectJoins, stats.perfectJoins ?? 0)));
    const creaks = Math.max(0, Math.round(num(src.creaks, state.creaks ?? stats.creaksTotal ?? 0)));
    const shortReports = Math.max(0, Math.round(num(src.shortReports, 0)));
    const longReports = Math.max(0, Math.round(num(src.longReports, 0)));

    // Fasteners: derived only when NightManager does not report them. Six per slot supplied,
    // three more per shortfall required. The shortfall is authored in Script, not invented here.
    const shortfalls = Math.max(0, Math.round(num(src.hardwareShortfalls, def?.shortfallCount ?? 0)));
    const fastenersSupplied = Math.max(0, Math.round(num(src.fastenersSupplied, partsTotal * 6)));
    const fastenersRequired = Math.max(
      fastenersSupplied,
      Math.round(num(src.fastenersRequired, fastenersSupplied + shortfalls * 3)),
    );

    const metresHauled = Math.max(0, Math.round(
      num(src.metresHauled, num(src.metresWalked, stats.metresWalked ?? 0)),
    ));

    const duration = Math.max(1, num(def?.durationSeconds, 600));
    // `timeRemaining` is a 0..1 fraction in §15.1's formula but reads as mm:ss on the card.
    // Accept either: anything at or under 1 is treated as the fraction.
    let remainFrac;
    if (Number.isFinite(Number(src.timeRemaining))) {
      const tr = Number(src.timeRemaining);
      remainFrac = tr <= 1 ? clamp(tr, 0, 1) : clamp(tr / duration, 0, 1);
    } else {
      remainFrac = clamp(1 - num(state.timeOfNight, 1), 0, 1);
    }
    const timeRemainingSeconds = remainFrac * duration;
    const timeUsedSeconds = Number.isFinite(Number(src.timeUsed))
      ? (Number(src.timeUsed) <= 1 ? Number(src.timeUsed) * duration : Number(src.timeUsed))
      : Math.max(0, duration - timeRemainingSeconds);

    // GAME_DESIGN §15.1, transcribed exactly.
    const computed = clamp(
      100
      - 5.0 * underFastened
      - 8.0 * rotated
      - 12.0 * wrongSlot
      - 24.0 * wrongPart
      - 0.8 * creaks
      - 15.0 * shortReports
      - 25.0 * longReports
      + 2.5 * perfectJoins
      + 8.0 * (remainFrac > 0.12 ? 1 : 0),
      0, 100,
    );
    // With no breakdown at all, the unaccounted joins still have to cost something.
    const unmeasuredPenalty = bucketed === 0 ? 8.0 * unaccounted : 0;
    let assemblyQuality = Math.round(
      Number.isFinite(Number(src.assemblyQuality))
        ? clamp(Number(src.assemblyQuality), 0, 100)
        : clamp(computed - unmeasuredPenalty, 0, 100),
    );
    if (failed) assemblyQuality = Math.min(assemblyQuality, 29);

    return {
      night,
      partsInstalled, partsTotal,
      joinsCorrect, joinsUnderFastened: underFastened, joinsRotated: rotated,
      joinsWrongSlot: wrongSlot, joinsWrongPart: wrongPart,
      joinsNotAsIllustrated: notAsIllustrated, joinsRequiringReplacement: requiringReplacement,
      perfectJoins, creaks,
      fastenersSupplied, fastenersRequired,
      metresHauled,
      shortReports, longReports,
      timeRemainingSeconds, timeUsedSeconds,
      assemblyQuality,
    };
  }

  /* ------------------------------------------------------------------ events & input */

  _bindEvents() {
    const on = (name, fn) => {
      const off = this.bus?.on?.(name, Log.guard(`Menu:${name}`, fn));
      if (typeof off === 'function') this._unsubs.push(off);
    };

    on('night:begin', ({ night } = {}) => {
      this._nightStartedAt = (globalThis.performance?.now?.() ?? Date.now()) / 1000;
      if (this.isOpen) this.hide();
      this.showTitleCard(night ?? this.ctx.state?.night ?? 1);
    });

    on('night:complete', ({ night, score } = {}) => {
      this._nightElapsed = this._sessionSeconds();
      this.showNightEnd(score, { night });
    });

    on('night:failed', ({ night, reason } = {}) => {
      this._nightElapsed = this._sessionSeconds();
      this.showNightEnd(null, { night, failed: true, reason });
    });

    // The Engine auto-pauses on tab hide; raising the sheet is the right response to that too.
    on('game:pause', () => {
      if (this._selfPausing || this.isOpen) return;
      if (!PLAYABLE_PHASES.has(this.ctx.state?.phase ?? '')) return;
      this.showPause();
    });

    on('settings:changed', ({ key } = {}) => {
      if (key === 'colorblind' || key === '*') this._applyVisionMode();
      if (key === 'reducedMotion' || key === '*') {
        const on_ = !!this.ctx.settings?.get?.('reducedMotion');
        if (this._root) {
          if (on_) this._root.dataset.reduced = '1'; else delete this._root.dataset.reduced;
        }
      }
    });

    const doc = globalThis.document;
    if (doc) {
      doc.addEventListener('keydown', this._onKeyDown, true);
      doc.addEventListener('pointerlockerror', this._onLockError);
    }
    this.ctx.canvas?.addEventListener?.('pointerdown', this._onCanvasDown);
  }

  /**
   * One canonical token per key, from `code` when the event has one and `key` when it does not.
   *
   * `code` is the right primary source — it is layout-independent, so WASD stays under the same
   * three fingers on AZERTY. But not every keydown carries one: events synthesised by remapping
   * utilities, on-screen keyboards, some accessibility software and every automation harness
   * arrive with `code === ''`, and a menu that switches on `code` alone is simply dead to all of
   * them. Measured, not assumed: a real dispatched Escape reached this handler with an empty
   * `code` and the pause sheet did not open.
   *
   * @returns {string} '' when the key is not one we take.
   */
  _keyToken(e) {
    switch (e.code) {
      case 'Escape': return 'ESC';
      case 'ArrowUp': case 'KeyW': return 'UP';
      case 'ArrowDown': case 'KeyS': return 'DOWN';
      case 'ArrowLeft': case 'KeyA': return 'LEFT';
      case 'ArrowRight': case 'KeyD': return 'RIGHT';
      case 'Tab': return 'TAB';
      case 'Enter': case 'NumpadEnter': return 'ENTER';
      case 'Space': return 'SPACE';
      case 'Digit1': case 'Numpad1': return 'D1';
      case 'Digit2': case 'Numpad2': return 'D2';
      case 'Digit3': case 'Numpad3': return 'D3';
      case 'Digit4': case 'Numpad4': return 'D4';
      default: break;
    }
    switch (e.key) {
      case 'Escape': case 'Esc': return 'ESC';
      case 'ArrowUp': case 'Up': case 'w': case 'W': return 'UP';
      case 'ArrowDown': case 'Down': case 's': case 'S': return 'DOWN';
      case 'ArrowLeft': case 'Left': case 'a': case 'A': return 'LEFT';
      case 'ArrowRight': case 'Right': case 'd': case 'D': return 'RIGHT';
      case 'Tab': return 'TAB';
      case 'Enter': return 'ENTER';
      case ' ': case 'Spacebar': return 'SPACE';
      case '1': return 'D1';
      case '2': return 'D2';
      case '3': return 'D3';
      case '4': return 'D4';
      default: return '';
    }
  }

  _onKeyDown(e) {
    if (this._disposed || !this._root) return;
    const token = this._keyToken(e);

    // Escape is the only key we take while gameplay owns the screen.
    if (this.screen === null) {
      if (token !== 'ESC') return;
      const shots = this.ctx.systems?.get?.('Shots');
      if (shots && shots.active) return;
      if (!PLAYABLE_PHASES.has(this.ctx.state?.phase ?? '')) return;
      e.preventDefault();
      e.stopPropagation();
      this.showPause();
      return;
    }

    const settings = this.screen === 'settings';
    let handled = true;

    switch (token) {
      case 'ESC':
        this._back();
        break;
      case 'UP':
        if (settings && !e.shiftKey) this._moveRow(-1); else this._move(-1);
        break;
      case 'DOWN':
        if (settings && !e.shiftKey) this._moveRow(1); else this._move(1);
        break;
      case 'TAB':
        this._move(e.shiftKey ? -1 : 1);
        break;
      case 'LEFT':
        if (settings) this._nudgeRow(-1); else handled = false;
        break;
      case 'RIGHT':
        if (settings) this._nudgeRow(1); else handled = false;
        break;
      case 'ENTER': case 'SPACE':
        if (settings && token === 'SPACE') this._nudgeRow(0);
        else this._activateSelected();
        break;
      case 'D1': this._activateIndex(0); break;
      case 'D2': this._activateIndex(1); break;
      case 'D3': this._activateIndex(2); break;
      case 'D4': this._activateIndex(3); break;
      default: handled = false;
    }

    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  _activateSelected() {
    const item = this._items[this._index];
    if (!item) return;
    if (item.disabled) { this._sfx('ui.deny', 0.8); return; }
    this._activate(item.action);
  }

  _activateIndex(i) {
    const item = this._items[i];
    if (!item) return;
    if (item.disabled) { this._sfx('ui.deny', 0.8); return; }
    this._index = i;
    this._syncSelection(false);
    this._activate(item.action);
  }

  /** Left/right on a settings row. `0` toggles or cycles. */
  _nudgeRow(dir) {
    const row = this._rows[this._rowIndex];
    if (!row) return;

    const range = row.querySelector('input[type="range"]');
    if (range) {
      const step = Number(range.step) || 1;
      const next = clamp(Number(range.value) + step * (dir || 1), Number(range.min), Number(range.max));
      range.value = String(next);
      range.dispatchEvent(new Event('input', { bubbles: false }));
      this._sfx('ui.click', 0.45);
      return;
    }

    const check = row.querySelector('.sc-check');
    if (check) { check.click(); return; }

    const seg = [...row.querySelectorAll('.sc-seg button')];
    if (seg.length) {
      const cur = seg.findIndex((b) => b.getAttribute('aria-checked') === 'true');
      const next = (Math.max(0, cur) + (dir || 1) + seg.length) % seg.length;
      seg[next].click();
    }
  }

  /* ------------------------------------------------------------------ pointer lock */

  /**
   * Ask for the pointer back.
   *
   * Two things measured here, both of which produced console noise before they were handled:
   *
   * 1. `Element.requestPointerLock()` returns a PROMISE in current Chrome, and a refusal REJECTS
   *    it. A refusal is not exceptional in this game — the browser throttles re-locking for
   *    ~1.25 s after a user-initiated Escape, which is the single most common way a player
   *    resumes — so an unhandled rejection is guaranteed on a normal Escape/Escape. It is not
   *    catchable with try/catch, only with .catch(). Observed as 13 uncaught WrongDocumentError
   *    rejections across one Escape round-trip.
   *    TODO(api): Input.requestPointerLock() swallows the call's return value, so the rejection
   *    escapes there too. We call the canvas directly — the identical call Input makes — and
   *    Input's own pointerlockchange listener keeps `input.pointerLocked` correct either way.
   * 2. Three timed attempts from `hide()` and three more from `_startGame()` fire inside 350 ms.
   *    They are individually harmless but each one is another rejection, so attempts closer
   *    together than the de-dupe window are dropped.
   */
  _requestLock() {
    const input = this.ctx.systems?.get?.('Input') ?? null;
    const canvas = this.ctx.canvas ?? null;
    if (!input && !canvas) return;

    const attempt = () => {
      if (this._disposed || this.isOpen) return;
      if (!PLAYABLE_PHASES.has(this.ctx.state?.phase ?? '')) return;
      if (input?.pointerLocked) return;
      const now = (globalThis.performance?.now?.() ?? Date.now());
      if (now - this._lockAskedAt < 250) return;
      this._lockAskedAt = now;

      if (typeof canvas?.requestPointerLock === 'function') {
        let p = null;
        try { p = canvas.requestPointerLock(); } catch (e) { Log.debug('Menu: pointer lock threw.', e); }
        if (p && typeof p.catch === 'function') {
          p.catch((e) => Log.debug('Menu: pointer lock refused — will retry.', e?.name ?? e));
        }
      } else if (typeof input?.requestPointerLock === 'function') {
        input.requestPointerLock();
      }
    };

    attempt();
    // Retry past the browser's post-Escape throttle; the canvas pointer-down handler is the
    // belt-and-braces path if the user never waits.
    this._after(320, attempt);
    this._after(1400, attempt);
  }

  _releaseLock() {
    const input = this.ctx.systems?.get?.('Input');
    if (typeof input?.exitPointerLock === 'function') input.exitPointerLock();
    else { try { globalThis.document?.exitPointerLock?.(); } catch { /* noop */ } }
  }

  _onCanvasDown() {
    if (this._disposed || this.isOpen) return;
    if (!PLAYABLE_PHASES.has(this.ctx.state?.phase ?? '')) return;
    const input = this.ctx.systems?.get?.('Input');
    if (input?.pointerLocked) return;
    this._requestLock();
  }

  _onLockError() {
    Log.debug('Menu: pointer lock refused — will retry, and on the next click.');
  }

  /* ------------------------------------------------------------------ pause plumbing */

  _setEnginePaused(want) {
    const engine = this.ctx.engine ?? globalThis.__ENGINE__ ?? null;
    if (!engine) { this._enginePaused = false; return; }
    if (want === this._enginePaused) return;
    this._selfPausing = true;
    try {
      if (want) engine.pause?.(); else engine.resume?.();
      this._enginePaused = want;
    } catch (e) {
      Log.warn('Menu: engine pause toggle failed', e);
    } finally {
      this._selfPausing = false;
    }
  }

  /**
   * Engine's frame loop stops polling Input while paused, so the gamepad's Start button cannot
   * unpause through the normal path. Poll it ourselves for exactly as long as the sheet is up.
   */
  _startPadPoll() {
    if (this._padPoll || typeof requestAnimationFrame !== 'function') return;
    this._padPrev = true;   // ignore the press that opened the sheet
    const tick = () => {
      if (this._disposed || !this.isOpen) { this._padPoll = 0; return; }
      this._padPoll = requestAnimationFrame(tick);
      let pressed = false;
      try {
        const pads = navigator.getGamepads?.() ?? [];
        for (const p of pads) {
          if (!p) continue;
          if (p.buttons?.[9]?.pressed || p.buttons?.[1]?.pressed) { pressed = true; break; }
        }
      } catch { /* noop */ }
      if (pressed && !this._padPrev) this._back();
      this._padPrev = pressed;
    };
    this._padPoll = requestAnimationFrame(tick);
  }

  _stopPadPoll() {
    if (!this._padPoll) return;
    cancelAnimationFrame(this._padPoll);
    this._padPoll = 0;
  }

  /* ------------------------------------------------------------------ misc helpers */

  _resolveDriftCentre() {
    const terrain = this.ctx.systems?.get?.('Terrain');
    const site = terrain?.buildSiteCenter;
    if (site && Number.isFinite(site.x)) {
      this._camCx = site.x; this._camCy = site.y ?? 0; this._camCz = site.z;
    } else {
      // Matches Shots.js's LANDMARK_FALLBACK so the attract shot frames the plot either way.
      this._camCx = -140; this._camCy = 0; this._camCz = 128;
    }
    if (terrain && typeof terrain.heightAt === 'function') {
      const h = terrain.heightAt(this._camCx, this._camCz);
      if (Number.isFinite(h)) this._camCy = h;
    }
    this._camReady = true;
  }

  _sessionSeconds() {
    if (!this._nightStartedAt) return 0;
    const now = (globalThis.performance?.now?.() ?? Date.now()) / 1000;
    return Math.max(0, now - this._nightStartedAt);
  }

  _hasSave() {
    try {
      const state = this.ctx.state;
      if (state && typeof state.constructor?.hasSave === 'function') return !!state.constructor.hasSave();
      return !!globalThis.localStorage?.getItem('slashercabin.save');
    } catch { return false; }
  }

  _savedNight() {
    try {
      const raw = globalThis.localStorage?.getItem('slashercabin.save');
      if (!raw) return this.ctx.state?.night ?? 1;
      const parsed = JSON.parse(raw);
      return Number.isFinite(parsed?.night) ? parsed.night : 1;
    } catch { return 1; }
  }

  _totalParts() {
    const nights = Script?.nights ?? [];
    let total = 0;
    for (const n of nights) total += Number(n?.slotCount) || 0;
    return total || 117;
  }

  _totalSteps() {
    const nights = Script?.nights ?? [];
    let total = 0;
    for (const n of nights) total += Number(n?.stageCount) || 0;
    return total || 30;
  }

  _params() {
    try { return new URLSearchParams(globalThis.location?.search ?? ''); }
    catch { return new URLSearchParams(''); }
  }

  /** Call the first method a system actually has. Returns true if one ran. */
  _callFirst(system, names, arg) {
    if (!system) return false;
    for (const name of names) {
      if (typeof system[name] === 'function') {
        try { system[name](arg); return true; }
        catch (e) { Log.warn(`Menu: ${name}() threw`, e); return true; }
      }
    }
    return false;
  }

  /** UI sound. `sfxUI` is dry, unmasked and bypasses the mix — a different, cleaner universe. */
  _sfx(id, volume = 1, delayMs = 0) {
    const fire = () => this.bus?.emit?.('audio:sfx', { id, volume });
    if (delayMs > 0) this._after(delayMs, fire); else fire();
  }

  /**
   * The first-load instrument.
   *
   * ARCHITECTURE §11d: a claim about timing needs an instrument that can be checked against a
   * known reference. These marks are written at the exact statement that causes the pixel — the
   * boot plate's appendChild, the title's `data-open`, each asset's own resolution — and they
   * share `performance.now()`'s time base with the Resource Timing API, so `splash-decoded`
   * and `splash-title.png`'s `responseEnd` are directly comparable without any conversion.
   *
   * Readable as `window.__MENU_TIMING__`. Two numbers and no branches; it cannot perturb what
   * it measures.
   */
  _mark(name) {
    try {
      const t = globalThis.performance?.now?.() ?? 0;
      const store = (globalThis.__MENU_TIMING__ ||= {});
      if (store[name] === undefined) store[name] = Math.round(t * 10) / 10;
    } catch { /* noop */ }
  }

  _after(ms, fn) {
    // Never arm a timer on a disposed Menu — dispose() already drained the set, so anything
    // added afterwards is a handle nobody will ever clear.
    if (this._disposed) return 0;
    const id = setTimeout(() => {
      this._timers.delete(id);
      if (this._disposed) return;
      try { fn(); } catch (e) { Log.warn('Menu: deferred task threw', e); }
    }, ms);
    this._timers.add(id);
    return id;
  }
}

export default Menu;
