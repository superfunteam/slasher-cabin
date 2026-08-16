/**
 * ADAPTIVE GENERATIVE SCORE — Camp Wanaka Pines, summer 1984.
 *
 * OWNER: Audio agent. Binding spec: AUDIO_DIRECTION.md §6 (music), §8 (silence rules).
 *
 * Every note in this file is synthesized in WebAudio and scheduled note-by-note against
 * `AudioContext.currentTime` by a ~120 ms lookahead scheduler driven from `update(dt)`.
 *
 * ---------------------------------------------------------------------------------------
 * THE GENERATED BED LAYER (added after `public/audio/` existed — see §"generated beds")
 * ---------------------------------------------------------------------------------------
 * `public/audio/manifest.json` may offer six pre-rendered score beds (music-title, -work,
 * -tension, -hunt, -dawn, -night7). When it does, ONE of them plays underneath everything
 * above as a HARMONIC FLOOR: highpassed out of the sub band, crossfaded equal-power on bar
 * boundaries, and seam-crossfaded against itself so a 50–90 s bed never ticks at its loop.
 *
 * The synthesis is NOT replaced and NOT reduced. A fixed bed cannot react to
 * `state.suspicion`, `Campers.nearestDistance` or build progress at the resolution this game
 * needs; the pad, the prepared piano, the bowed metal and the string still do that on top,
 * frame by frame. The bed is the floor. The synth is the room.
 *
 * DELETE `public/audio/` AND NOTHING CHANGES. The manifest fetch failing (404, offline,
 * file://, CSP, a fresh clone) is a NORMAL state: it logs at debug level, sets
 * `generatedAvailable = false`, and the score runs exactly as it did before this layer
 * existed. Nothing in the boot path ever awaits it.
 *
 * The bed lives INSIDE `_sum`, i.e. behind `_gate`, so every §8 silence rule silences it
 * too — and a total silence additionally closes the bed's own gate and stops its sources,
 * because §8 is about the score STOPPING, and a bed ducked under a silence would be exactly
 * the "fading the bed back up under a silence" that §8 S12 calls the one unforgivable sin.
 *
 * ---------------------------------------------------------------------------------------
 * HARMONIC LANGUAGE (stated once, obeyed everywhere) — AUDIO_DIRECTION.md §6.1
 * ---------------------------------------------------------------------------------------
 *   Reference pitch:  A4 = 436 Hz.  Fourteen cents flat against nothing. The camp radio
 *                     (§5.3, `startRadio()` below) is at A = 440, so when both are audible
 *                     they beat. That is intentional and it is horrible.
 *   Pitch centre:     D1 = 36.4 Hz / D2 = 72.8 Hz. It NEVER modulates. Seven nights, one key.
 *   Mode:             D PHRYGIAN — D Eb F G A Bb C. Minor with a flat second: the Eb is the
 *                     dread. Above dread 0.85 the A is replaced by Ab and the mode becomes
 *                     D LOCRIAN. The tritone D–Ab is RESERVED: it appears nowhere in the game
 *                     until a camper has actually seen the player.
 *   Harmony:          No triads. Ever. Stacked fourths (D–G–C), open fifths (D–A) and minor
 *                     seconds (D–Eb) used as beating intervals.
 *
 *   THE BUILD MUSIC AND THE HUNT MUSIC ARE THE SAME MUSIC. Both are a D pad in the same
 *   register with the same filter. The work theme is D + G (a stacked fourth: open, patient,
 *   faintly domestic). The hunt is the identical pad with that one voice moved up a whole
 *   tone to A (open fifth) and a second voice added a semitone above the tonic (Eb). The
 *   horror is that the difference between "a man peacefully building a house" and "a hunt"
 *   is one voice moving one step. Nothing is re-orchestrated. Nothing new arrives. It sours.
 *
 * ---------------------------------------------------------------------------------------
 * INSTRUMENTATION (all synthesized, all period-appropriate — a Prophet-5 and a piano with
 * screws in it, not an orchestral library)
 * ---------------------------------------------------------------------------------------
 *   PAD            4 voices; each 2 detuned sawtooths + a triangle + a sub sine, through one
 *                  shared 2-pole lowpass with a 0.07 Hz sweep, then a 2-tap modulated chorus.
 *   PREPARED PIANO A persistent 7-partial modal bank with string inharmonicity
 *                  (f_n = n·f0·sqrt(1+B·n²)), struck by a 1.5 ms filtered noise burst, with
 *                  partials 3/4/5 amplitude-modulated by a 64 Hz sine — a screw resting on
 *                  the string. Plus a damper thunk at 92 Hz.
 *   BOWED METAL    One pink-noise source through six very high-Q bandpasses on a stack of
 *                  fourths/fifths, each frequency drifting under its own sub-audio LFO so
 *                  the partials beat against each other, into a soft waveshaper.
 *   THE STRING     True Karplus–Strong, rendered OFFLINE into AudioBuffers at init (a
 *                  DelayNode feedback loop in WebAudio floors out at ~375 Hz because of the
 *                  128-sample render quantum — far too high for a 36 Hz D1 — so we compute
 *                  the string in JS once and play it back for free).
 *   SUB            Two sine oscillators, D1 and A1, swelled with long time constants.
 *
 * ---------------------------------------------------------------------------------------
 * CPU
 * ---------------------------------------------------------------------------------------
 *   ~80 persistent nodes total (16 pad oscillators, one looping noise source, 13 biquads,
 *   a handful of LFOs). One-shot nodes are created only for struck events — at most a few
 *   per second. `update()` allocates nothing; the parameter pass runs at 10 Hz and the
 *   scheduler at ~8 Hz, both amortized.
 *
 * PUBLIC API — see the bottom of the class and the report in ARCHITECTURE terms:
 *   music.setIntensity(x)          0..1 external dread floor; null to clear
 *   music.setDread(x)              alias, AUDIO_DIRECTION §9.5
 *   music.setLayer(name, on)       force a layer on/off; null/undefined restores automatic
 *   music.stinger('staple', opts)  THE STAPLE (§6.4) — a tell, not a sting
 *   music.collapse()               the escape collapse (§6.3 / §8 S5)
 *   music.currentMood              read-only string, safe to poll from anywhere
 *   music.update(dt, elapsed)      system lifecycle
 *   music.generatedAvailable       false on a clone with no public/audio/ — informational
 *   music.bedMood                  read-only string, which generated bed is wanted
 *   music.setBeds(on)              force the generated bed layer off (synthesis is untouched)
 */

import { Log } from '../core/Log.js';
import { Rand, hashStr } from '../core/Rand.js';

// ---------------------------------------------------------------------------- constants

/** §6.1 — the whole score is 14 cents flat. */
const A4_HZ = 436;
/** §5.3 — the transistor radio is not. */
const RADIO_A4_HZ = 440;

const mtof = (m, a4 = A4_HZ) => a4 * Math.pow(2, (m - 69) / 12);
const db = (x) => Math.pow(10, x / 20);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * MIDI numbers around the fixed centre. D1 = 26 → 36.39 Hz at A = 436.
 * Only notes of D Phrygian (+ the reserved Ab) ever appear.
 */
const N = {
  D1: 26, Eb1: 27, F1: 29, G1: 31, Ab1: 32, A1: 33, Bb1: 34, C2: 36,
  D2: 38, Eb2: 39, F2: 41, G2: 43, Ab2: 44, A2: 45, Bb2: 46, C3: 48,
  D3: 50, Eb3: 51, F3: 53, G3: 55, Ab3: 56, A3: 57, Bb3: 58, C4: 60,
  D4: 62, Eb4: 63,
};

/**
 * L2 "REPORT" — the only reward music in the game (§6.3). A slowly ascending sequence
 * indexed by build stage. D F G Bb C D Eb — the mode walking upward, one rung per stage,
 * and the last rung is the flat second. The manual congratulates you in a minor key.
 */
const REPORT_SEQUENCE = [N.D3, N.F3, N.G3, N.Bb3, N.C4, N.D4, N.Eb4];

/**
 * THE WORK THEME. One note per bar (4 s), four bars, then it repeats forever with no
 * development whatsoever. That is the joke and it is also the emotional core: a patient,
 * repetitive, faintly domestic figure for a man doing a job properly. D–G–A–F: the tonic,
 * the fourth, the fifth, the flat seventh's neighbour. No Eb. Nothing sad in it at all.
 */
const WORK_FIGURE = [N.D3, N.G3, N.A3, N.F3];

/** §6.3 L5 — the 3-note irregular ostinato, offsets in seconds. ~104 bpm, deliberately uneven. */
const OSTINATO_OFFSETS = [0, 0.346, 0.808];
const OSTINATO_PITCHES = [N.D1, N.Eb1, N.D1];

/** Bowed-metal partials: a stack of fourths and fifths on D (§6.2), plus a cold sixth for dawn. */
const BOW_PARTIALS = [196, 293, 441, 587, 881, 1174];

/** Prepared-piano inharmonicity coefficient (§6.2). */
const PIANO_B = 0.0042;
const PIANO_PARTIALS = 7;

/** Musical grid. 60 bpm → beat 1 s, bar 4 s, half-bar 2 s, which is exactly the §6.3 rule:
 *  layers ENTER on the next 2 s boundary and LEAVE on the next 4 s boundary. */
const TEMPO_BPM = 60;
const BEAT = 60 / TEMPO_BPM;
const LOOKAHEAD = 0.12;          // seconds of scheduling runway (~100 ms, per the brief)
const SCHED_INTERVAL = 0.05;     // don't re-run the scheduler more often than this

/** Soft-clip curves, computed once at module scope (deterministic maths, no RNG). */
function makeTanhCurve(drive) {
  const n = 1024;
  const c = new Float32Array(n);
  const k = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * drive) / k;
  }
  return c;
}
const CURVE_SOFT = makeTanhCurve(1.6);
const CURVE_RADIO = makeTanhCurve(2.4);

// ------------------------------------------------------------------- generated bed layer

/**
 * Mood → manifest id. These six are the only music ids this file will ever ask for; an id
 * the manifest does not list simply never plays and the synthesis covers that mood alone.
 *
 *   title    the title screen
 *   work     the player building undisturbed — STORY.md's emotional core: almost pleasant,
 *            patient, faintly domestic. The bed under the work theme, not instead of it.
 *   tension  rising dread
 *   hunt     chase
 *   dawn     exhausted resolution at first light (and it STOPS at §8 S11, see below)
 *   night7   Night 7 only — all the comedy drained out; replaces work and tension entirely
 */
const MUSIC_BEDS = {
  title: 'music-title',
  work: 'music-work',
  tension: 'music-tension',
  hunt: 'music-hunt',
  dawn: 'music-dawn',
  night7: 'music-night7',
};

/**
 * Per-mood bed trim, dB, inside the score's own mix (the `music` bus applies §2.1 on top).
 * The bed is a FLOOR: it sits under the pad (−16) and well under the string's struck notes,
 * so at no point is the synthesized layer competing with a recording for the same job.
 */
const BED_TRIM_DB = {
  title: -16, work: -22, tension: -20, hunt: -17, dawn: -21, night7: -19,
};

/** Mood crossfade length, seconds. §6.3's transition window is 2–4 s; a hunt arrives sooner. */
const BED_XFADE_S = 3.0;
const BED_XFADE_FAST_S = 2.0;
/** Minimum seconds between mood switches, so a crossfade always completes before the next. */
const BED_DWELL_S = 8.0;
/** Equal-power fades are drawn as this many linear segments (a curve without setValueCurve). */
const XF_STEPS = 16;
const HALF_PI = Math.PI / 2;
/** How long a total §8 silence must hold before the bed's sources are stopped outright. */
const BED_STOP_AFTER_S = 2.0;

/** Honours Vite's `base`, so a subpath deploy still finds `public/audio/`. */
function siteUrl(rel) {
  let base = '/';
  try { base = import.meta.env?.BASE_URL ?? '/'; } catch { /* non-Vite host */ }
  if (!base.endsWith('/')) base += '/';
  const path = String(rel ?? '').replace(/^\/+/, '');
  const href = globalThis.location?.href ?? 'http://localhost/';
  try { return new URL(`${base}${path}`, href).href; }
  catch { return `${base}${path}`; }
}

/** Silence-rule priorities. Highest active rule wins; rules do not blend (§8). */
const P = {
  FAILED: 100,      // S7
  NIGHT_BEGIN: 92,  // S1
  STAGE: 84,        // S6
  MASK: 78,         // S10
  NAKED_CREAK: 72,  // S3
  TIER4: 68,        // the instant before a tier-4 creak resolves
  SEEN: 62,         // a camper crosses into line of sight
  NIGHT_END: 55,
  ESCAPE: 50,       // S5
  DAWN: 42,         // S11
  PAUSE: 30,        // S9  (a duck, not a silence — deliberately)
  BLUEPRINT: 22,    // §2.3 (a duck)
  CREAK3: 14,       // §2.3 (a duck)
};

// ------------------------------------------------------------- offline buffer rendering

/** Pink noise (Paul Kellet's economy filter), seeded so the bed is reproducible. */
function renderPink(ac, seconds, rand) {
  const sr = ac.sampleRate;
  const len = Math.max(1, Math.floor(seconds * sr));
  const buf = ac.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let peak = 1e-6;
  for (let i = 0; i < len; i++) {
    const w = rand.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    const v = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
    out[i] = v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  const g = 0.9 / peak;
  for (let i = 0; i < len; i++) out[i] *= g;
  // Taper the seam so the loop point does not tick.
  const fade = Math.min(1024, len >> 2);
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    out[i] *= k;
    out[len - 1 - i] *= k;
  }
  return buf;
}

/** White noise, used as an exciter for the modal banks. */
function renderWhite(ac, seconds, rand) {
  const sr = ac.sampleRate;
  const len = Math.max(1, Math.floor(seconds * sr));
  const buf = ac.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  for (let i = 0; i < len; i++) out[i] = rand.next() * 2 - 1;
  return buf;
}

/**
 * THE STRING, rendered offline. True Karplus–Strong at 36 Hz, which WebAudio cannot do in
 * a DelayNode feedback loop (minimum delay = one 128-sample render quantum ≈ 2.67 ms,
 * flooring the pitch at ~375 Hz). Computing it here costs ~5 ms once and nothing ever after.
 *
 * Struck, not plucked: the delay line is seeded with LOWPASSED noise (a felt mallet), and
 * the loop filter is a one-pole so the high partials die within a second and what is left
 * is a long, dark, slightly inharmonic hum.
 */
function renderKarplus(ac, seconds, freq, rand, { damp = 0.5, exciteDamp = 0.22 } = {}) {
  const sr = ac.sampleRate;
  const len = Math.max(1, Math.floor(seconds * sr));
  const buf = ac.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);

  const nDelay = Math.max(4, Math.round(sr / freq));
  const line = new Float32Array(nDelay);

  // Felt exciter: 25 ms of lowpassed noise wrapped into the delay line.
  let lp = 0, mean = 0;
  for (let i = 0; i < nDelay; i++) {
    lp += (rand.next() * 2 - 1 - lp) * exciteDamp;
    line[i] = lp;
    mean += lp;
  }
  mean /= nDelay;
  for (let i = 0; i < nDelay; i++) line[i] -= mean;   // DC block — a string does not thump

  // -60 dB over the buffer length.
  const decay = Math.exp(Math.log(0.001) / (sr * seconds));
  let idx = 0, y = 0, peak = 1e-6;
  for (let i = 0; i < len; i++) {
    const cur = line[idx];
    const nxt = line[(idx + 1) % nDelay];
    y += ((cur + nxt) * 0.5 - y) * damp;
    line[idx] = y * decay;
    out[i] = cur;
    const a = cur < 0 ? -cur : cur;
    if (a > peak) peak = a;
    idx = (idx + 1) % nDelay;
  }

  const g = 0.95 / peak;
  const tail = Math.min(len, Math.floor(0.25 * sr));
  for (let i = 0; i < len; i++) {
    let v = out[i] * g;
    const k = len - i;
    if (k < tail) v *= 0.5 - 0.5 * Math.cos((Math.PI * k) / tail);
    out[i] = v;
  }
  return buf;
}

/**
 * A struck-steel hit, rendered offline as a sum of exponentially decaying inharmonic modes
 * with the nonlinear pitch glide from §4.5 (real metal goes sharp under high amplitude and
 * settles back over ~240 ms). Used forwards for the stinger's hits and BACKWARDS for its
 * pre-swell — see `stinger()`.
 */
function renderMetalHit(ac, seconds, rand) {
  const sr = ac.sampleRate;
  const len = Math.max(1, Math.floor(seconds * sr));
  const buf = ac.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);

  const modes = [
    { f: 2130, g: 1.00, tau: 0.180 },
    { f: 3910, g: 0.75, tau: 0.160 },
    { f: 5740, g: 0.50, tau: 0.130 },
    { f: 8320, g: 0.28, tau: 0.100 },
    { f: 11200, g: 0.12, tau: 0.070 },
  ].filter((m) => m.f < sr * 0.45);

  const phase = new Float64Array(modes.length);
  const twoPi = Math.PI * 2;
  let peak = 1e-6;

  for (let i = 0; i < len; i++) {
    const t = i / sr;
    // +35 cents at the moment of contact, settling with τ = 80 ms.
    const bend = Math.pow(2, (35 * Math.exp(-t / 0.08)) / 1200);
    let v = 0;
    for (let m = 0; m < modes.length; m++) {
      const mo = modes[m];
      phase[m] += (twoPi * mo.f * bend) / sr;
      v += mo.g * Math.exp(-t / mo.tau) * Math.sin(phase[m]);
    }
    // 1.5 ms contact transient — the face meeting the steel.
    if (t < 0.0015) v += (rand.next() * 2 - 1) * 2.2 * (1 - t / 0.0015);
    // The first 60 ms of a real strike is nonlinear.
    if (t < 0.06) v = Math.tanh(v * 1.8) * 0.9;
    out[i] = v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  const g = 0.95 / peak;
  for (let i = 0; i < len; i++) out[i] *= g;
  // 6 ms head fade so the buffer start never clicks.
  const head = Math.min(len, Math.floor(0.006 * sr));
  for (let i = 0; i < head; i++) out[i] *= i / head;
  return buf;
}

/** Reverse a mono buffer into a new one. */
function reverseBuffer(ac, src) {
  const len = src.length;
  const dst = ac.createBuffer(1, len, src.sampleRate);
  const a = src.getChannelData(0);
  const b = dst.getChannelData(0);
  for (let i = 0; i < len; i++) b[i] = a[len - 1 - i];
  // A reversed decay ends on a cliff; soften the last 8 ms.
  const tail = Math.min(len, Math.floor(0.008 * src.sampleRate));
  for (let i = 0; i < tail; i++) b[len - 1 - i] *= i / tail;
  return dst;
}

// --------------------------------------------------------------------------------- class

export class Music {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx?.bus ?? null;

    // ---- public, safe to read from anywhere at any time
    /** @type {'off'|'silent'|'dead'|'dawn'|'work'|'ground'|'air'|'attention'|'pressure'|'seen'|'collapse'} */
    this.currentMood = 'off';
    this.enabled = false;
    this.dread = 0;
    /**
     * True only once `public/audio/manifest.json` has been fetched, parsed, and found to
     * list at least one music bed. FALSE IS A NORMAL STATE — it is what a fresh clone with
     * no `public/audio/` looks like, and the score is complete without it.
     */
    this.generatedAvailable = false;

    // ---- audio graph (all null until init())
    this.ac = null;
    this._ownsContext = false;
    this._ownsOutput = false;
    this._nodes = [];          // everything we must disconnect in dispose()
    this._sources = [];        // long-lived sources we must stop()

    // ---- scheduling
    this._beat = 0;
    this._nextBeatTime = 0;
    this._barZero = 0;
    this._schedAccum = 0;
    this._paramAccum = 0;
    this._watchdog = 0;
    this._lastUpdateAt = 0;

    // ---- musical state
    this._autoDread = 0;
    this._smoothed = 0;
    this._external = null;      // setIntensity() floor, or null for pure auto
    this._workMode = false;
    this._lastDisturbance = -1e9;
    this._elapsed = 0;
    this._reportIndex = 0;
    this._reportQueue = 0;      // how many report notes are owed
    this._reportFlat = false;   // next report note is a semitone flat (tool:missing)
    this._pianoFreeAt = 0;
    this._nextStringAt = 0;
    this._nextSubAt = 0;
    this._nextOstinatoBeat = 0;
    this._stingersThisNight = 0;
    this._spotted = false;
    this._wind = 0;
    this._rain = 0;
    this._peakDread = 0;
    this._radioOn = false;
    this._radioNextTime = 0;
    this._radioBeat = 0;
    this._radioNodes = [];
    this._radioKillTimer = 0;
    this._masked = false;
    this._bowDawn = 0;
    this._bowQ = 180;

    // ---- silence stack (pooled; nothing is allocated once init() has run)
    this._holds = [];
    for (let i = 0; i < 12; i++) {
      this._holds.push({ active: false, id: '', pri: 0, level: 1, until: 0, attack: 0.02, release: 0.5 });
    }
    this._holdWinner = -1;
    this._awaitArrival = false;
    this._gateLevel = 1;

    // ---- generated bed layer (all inert until the manifest resolves; see _bedTick)
    this._disposed = false;
    this._bedFiles = new Map();      // id → { url, seconds }
    this._bedBuffers = new Map();    // id → AudioBuffer, insertion-ordered = LRU
    this._bedLoading = new Map();    // id → Promise, so we never fetch the same bed twice
    this._bedDead = new Set();       // ids that 404'd or failed to decode — never retried
    this._bedVoices = [];
    this._bedCurrent = null;
    this._bedWant = 'work';
    this._bedOff = false;            // setBeds(false) — synthesis is unaffected either way
    this._bedGateTarget = 0;
    this._bedStopAt = Infinity;
    this._bedSwitchOk = 0;
    this._bedCacheMax = 3;
    this._loopXfade = 2.0;           // overwritten by the manifest's loopCrossfadeSeconds
    this._lastBedCut = -1;

    this._unsubs = [];
    this._resumeHandler = null;

    const seed = ctx?.settings?.get?.('seed') ?? 0x51a5cab;
    this._rand = new Rand((seed ^ Math.floor(hashStr('music.hjem') * 0xffffffff)) | 0);
  }

  // ------------------------------------------------------------------------------- init

  async init() {
    try {
      this._resolveContext();
      if (!this.ac) {
        Log.debug('[Music] no AudioContext available — score disabled, game unaffected.');
        return;
      }
      this._buildBuffers();
      this._buildGraph();
      this._bindEvents();

      this._barZero = this.ac.currentTime + 0.25;
      this._nextBeatTime = this._barZero;
      this._beat = 0;
      this._nextStringAt = this._barZero + 4;
      this._nextSubAt = this._barZero + 8;
      this._pianoFreeAt = this._barZero;

      this.enabled = true;
      this.currentMood = 'ground';
      Log.debug(`[Music] score online — D Phrygian, A=${A4_HZ} Hz, ${this._padVoices.length} pad voices.`);

      // The generated beds are strictly additive and strictly optional. Fetch the manifest
      // WITHOUT awaiting it: boot must reach the title screen at the same speed whether or
      // not `public/audio/` exists, and the score is already playing by this line.
      this._initGeneratedBeds();
    } catch (e) {
      this.enabled = false;
      Log.warn('[Music] init failed — continuing silently.', e);
      try { this._teardownGraph(); } catch { /* noop */ }
    }
  }

  /**
   * Prefer the AudioEngine's `music` bus so the score sits inside the game's mix (reverb
   * send, ducking, mask filter). If AudioEngine is missing or still a stub, own a context
   * so the score works standalone.
   */
  _resolveContext() {
    const audio = this.ctx?.systems?.get?.('Audio') ?? null;

    // AudioEngine's own `.bus` property is the EventBus, so the music-bus accessor is named
    // `busNode()` there (with `bus_()` as the §9.5 doc alias). Probe every documented shape
    // rather than assuming one — this file must work whatever the Audio agent settled on.
    let musicBus = null;
    for (const getter of ['busNode', 'bus_', 'bus', 'getBus']) {
      try {
        const fn = audio?.[getter];
        if (typeof fn !== 'function') continue;
        const n = fn.call(audio, 'music');
        if (n && n.context && typeof n.connect === 'function') { musicBus = n; break; }
      } catch { /* wrong shape — keep probing */ }
    }

    if (musicBus) {
      this.ac = musicBus.context;
      this._dest = musicBus;
      // The bus already applies settings.musicVolume; applying it again would square it.
      this._ownsOutput = false;
      return;
    }

    // No music bus, but the engine may still own a context — share it rather than opening
    // a second one (two AudioContexts means two output devices' worth of latency).
    const foreign = audio?.context ?? audio?.audioContext ?? audio?.actx ?? audio?.ac ?? null;
    if (foreign && typeof foreign.createGain === 'function') {
      this.ac = foreign;
      this._dest = foreign.destination;
      this._ownsOutput = true;
      return;
    }

    const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext ?? null;
    if (!AC) return;
    try {
      this.ac = new AC({ latencyHint: 'interactive' });
      this._ownsContext = true;
      this._ownsOutput = true;
      this._dest = this.ac.destination;
      this._installResumeHandler();
    } catch (e) {
      Log.warn('[Music] could not create an AudioContext.', e);
      this.ac = null;
    }
  }

  /** Autoplay policy: the title screen is silent and says so by being silent (§9.4). */
  _installResumeHandler() {
    if (!this.ac || this._resumeHandler) return;
    const tryResume = () => {
      if (!this.ac) return;
      if (this.ac.state !== 'running') this.ac.resume?.().catch(() => {});
      if (this.ac.state === 'running') this._removeResumeHandler();
    };
    this._resumeHandler = tryResume;
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
      globalThis.addEventListener?.(ev, tryResume, { passive: true });
    }
    globalThis.document?.addEventListener?.('visibilitychange', tryResume);
  }

  _removeResumeHandler() {
    if (!this._resumeHandler) return;
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
      globalThis.removeEventListener?.(ev, this._resumeHandler);
    }
    globalThis.document?.removeEventListener?.('visibilitychange', this._resumeHandler);
    this._resumeHandler = null;
  }

  // ---------------------------------------------------------------------------- buffers

  _buildBuffers() {
    const ac = this.ac;
    const s = this.ctx?.settings ?? null;
    const tier = (a, b, c, d) => (s?.tier ? s.tier(a, b, c, d) : d);
    const r = this._rand;

    this._bufPink = renderPink(ac, tier(2.0, 3.0, 4.0, 4.0), r);
    this._bufWhite = renderWhite(ac, 0.25, r);

    // THE STRING: a long ringing D1 for L0, and a short damped one for the L5 ostinato so
    // three notes a second never stack into mud.
    const longS = tier(5.0, 6.5, 8.0, 9.0);
    this._bufString = renderKarplus(ac, longS, mtof(N.D1), r, { damp: 0.46 });
    this._bufStringShort = renderKarplus(ac, 1.35, mtof(N.D1), r, { damp: 0.62, exciteDamp: 0.3 });

    this._bufMetal = renderMetalHit(ac, 0.62, r);
    this._bufMetalRev = reverseBuffer(ac, this._bufMetal);
  }

  // ------------------------------------------------------------------------------ graph

  _n(node) { this._nodes.push(node); return node; }

  _gain(v) {
    const g = this.ac.createGain();
    g.gain.setValueAtTime(v, this.ac.currentTime);
    return this._n(g);
  }

  _filter(type, f, q = 1, gainDb = 0) {
    const b = this.ac.createBiquadFilter();
    b.type = type;
    b.frequency.setValueAtTime(f, this.ac.currentTime);
    b.Q.setValueAtTime(q, this.ac.currentTime);
    if (gainDb) b.gain.setValueAtTime(gainDb, this.ac.currentTime);
    return this._n(b);
  }

  /** A persistent LFO: oscillator → depth gain. Returns the depth gain (connect it to a param). */
  _lfo(hz, depth, type = 'sine', phaseOffsetS = 0) {
    const o = this.ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(hz, this.ac.currentTime);
    const g = this._gain(depth);
    o.connect(g);
    o.start(this.ac.currentTime + 0.02 + phaseOffsetS);
    this._sources.push(o);
    this._n(o);
    return g;
  }

  _buildGraph() {
    const ac = this.ac;
    const s = this.ctx?.settings ?? null;
    const tier = (a, b, c, d) => (s?.tier ? s.tier(a, b, c, d) : d);
    const now = ac.currentTime;

    // ---------------------------------------------------------------- output / the gate
    // Everything the score makes passes through `_gate`. The silence rules (§8) act here,
    // and nowhere else, so a silence is always total and always instantaneous.
    this._out = this._gain(1);
    this._gate = this._gain(1);
    this._glass = this._filter('lowpass', 20000, 0.7);   // S9: the pause "behind glass" filter
    this._sum = this._gain(1);

    this._sum.connect(this._gate);
    this._gate.connect(this._glass);
    this._glass.connect(this._out);
    this._out.connect(this._dest);

    if (this._ownsOutput) this._applyVolumeSettings();

    // ------------------------------------------------------------------------- the pad
    // 3 detuned oscillators + a sub sine per voice, one shared filter, one chorus.
    const padVoices = tier(2, 3, 4, 4);
    this._padSum = this._gain(1);
    this._padFilter = this._filter('lowpass', 260, 3.5);
    this._padCutLfo = this._lfo(0.07, 180);
    this._padCutLfo.connect(this._padFilter.frequency);

    this._padOut = this._gain(0.0001); // layer gain for the pad as a whole
    this._padRock = this._gain(1);     // the work theme's slow domestic rocking motion
    this._padSum.connect(this._padFilter);
    this._padFilter.connect(this._padRock);

    if (tier(0, 1, 1, 1)) {
      // Chorus: two modulated delays. This is 80% of what makes it sound like 1984.
      const dry = this._gain(1);
      this._padRock.connect(dry);
      dry.connect(this._padOut);
      for (const [ms, hz, dep] of [[0.014, 0.11, 0.003], [0.021, 0.17, 0.003]]) {
        const d = this._n(ac.createDelay(0.1));
        d.delayTime.setValueAtTime(ms, now);
        const lfo = this._lfo(hz, dep);
        lfo.connect(d.delayTime);
        const wet = this._gain(0.3);
        this._padRock.connect(d);
        d.connect(wet);
        wet.connect(this._padOut);
      }
    } else {
      this._padRock.connect(this._padOut);
    }
    this._padOut.connect(this._sum);

    // Pitches: v0 tonic D2 (always), v1 the WORK fourth G2, v2 the HUNT fifth A2,
    // v3 the flat second Eb2 which retunes to the reserved tritone Ab2 when seen.
    const voicePitch = [N.D2, N.G2, N.A2, N.Eb2];
    this._padVoices = [];
    for (let i = 0; i < padVoices; i++) {
      const vg = this._gain(0.0001);
      vg.connect(this._padSum);
      const oscs = [];
      const specs = [
        { type: 'sawtooth', detune: -7, gain: 0.34, oct: 0 },
        { type: 'sawtooth', detune: 6, gain: 0.34, oct: 0 },
        { type: 'triangle', detune: 13, gain: 0.26, oct: 0 },
        { type: 'sine', detune: 0, gain: 0.12, oct: -1 },     // the sub, −9 dB
      ];
      for (const sp of specs) {
        const o = ac.createOscillator();
        o.type = sp.type;
        o.frequency.setValueAtTime(mtof(voicePitch[i] + sp.oct * 12), now);
        o.detune.setValueAtTime(sp.detune, now);
        const g = this._gain(sp.gain);
        o.connect(g);
        g.connect(vg);
        o.start(now + 0.03);
        this._sources.push(o);
        this._n(o);
        oscs.push({ osc: o, oct: sp.oct });
      }
      this._padVoices.push({ gain: vg, oscs, midi: voicePitch[i], on: false, target: 0 });
    }

    // --------------------------------------------------------------------- bowed metal
    // One noise source, six very high-Q bandpasses, each drifting under its own slow LFO so
    // the partials beat against one another. This is the game's dread meter (§6.2).
    const bowCount = tier(3, 4, 6, 6);
    this._bowNoise = ac.createBufferSource();
    this._bowNoise.buffer = this._bufPink;
    this._bowNoise.loop = true;
    this._bowNoise.loopStart = 0.05;
    this._bowNoise.loopEnd = Math.max(0.2, this._bufPink.duration - 0.05);
    this._bowNoise.detune.setValueAtTime(this._rand.range(-120, 120), now);
    this._bowPressure = this._gain(0.0001);
    this._bowNoise.connect(this._bowPressure);
    this._bowNoise.start(now + 0.03, this._rand.range(0.05, 1.0));
    this._sources.push(this._bowNoise);
    this._n(this._bowNoise);

    this._bowShaper = this._n(ac.createWaveShaper());
    this._bowShaper.curve = CURVE_SOFT;
    this._bowShaper.oversample = tier('none', 'none', '2x', '2x');
    this._bowDC = this._filter('highpass', 18, 0.7);      // §9.2.7 — always DC-block a shaper
    this._bowOut = this._gain(0.0001);

    this._bowFilters = [];
    this._bowPartGains = [];
    for (let i = 0; i < bowCount; i++) {
      const f = this._filter('bandpass', BOW_PARTIALS[i], 180);
      const g = this._gain(0.0001);
      this._bowPressure.connect(f);
      f.connect(g);
      g.connect(this._bowShaper);
      // Slow inharmonic drift: ±0.35% at 0.031–0.083 Hz. The beating is the whole point.
      const lfo = this._lfo(0.031 + i * 0.0104, BOW_PARTIALS[i] * 0.0035);
      lfo.connect(f.frequency);
      this._bowFilters.push(f);
      this._bowPartGains.push(g);
    }
    this._setBowQ(180, now);
    this._bowShaper.connect(this._bowDC);
    this._bowDC.connect(this._bowOut);
    this._bowOut.connect(this._sum);

    // ------------------------------------------------------------------ prepared piano
    // Persistent 7-partial modal bank. Only the exciter is recreated per note.
    this._pnoOut = this._gain(db(-12));
    this._pnoOut.connect(this._sum);
    this._pnoExcGain = this._gain(0.0001);
    this._pnoExcLP = this._filter('lowpass', 600, 0.7);
    this._pnoExcGain.connect(this._pnoExcLP);

    this._pnoPart = [];
    this._buzzOsc = ac.createOscillator();          // the screw resting on the string
    this._buzzOsc.type = 'sine';
    this._buzzOsc.frequency.setValueAtTime(64, now);
    this._buzzDepth = this._gain(0.55);
    this._buzzOsc.connect(this._buzzDepth);
    this._buzzOsc.start(now + 0.03);
    this._sources.push(this._buzzOsc);
    this._n(this._buzzOsc);

    for (let n = 1; n <= PIANO_PARTIALS; n++) {
      const bp = this._filter('bandpass', 300 * n, 900 / n);
      const env = this._gain(0.0001);
      this._pnoExcLP.connect(bp);
      bp.connect(env);
      let tail = env;
      if (n >= 3 && n <= 5) {
        // Partials 3–5 are amplitude-modulated at 64 Hz: the preparation.
        const am = this._gain(0.45);
        env.connect(am);
        this._buzzDepth.connect(am.gain);
        tail = am;
      }
      tail.connect(this._pnoOut);
      this._pnoPart.push({ bp, env });
    }

    // Damper thunk (note-off), a single low mode.
    this._damperBp = this._filter('bandpass', 92, 9);
    this._damperEnv = this._gain(0.0001);
    this._pnoExcLP.connect(this._damperBp);
    this._damperBp.connect(this._damperEnv);
    this._damperEnv.connect(this._pnoOut);

    // ---------------------------------------------------------------------- the string
    this._strOut = this._gain(db(-30));
    this._strLP = this._filter('lowpass', 2600, 0.7);
    this._strLP.connect(this._strOut);
    this._strOut.connect(this._sum);
    // A second, louder, unfiltered path for the three places the string is STRUCK rather
    // than sounded: the stinger's answering clang, and nothing else by default.
    this._strDry = this._gain(db(-9));
    this._strDry.connect(this._sum);

    // ----------------------------------------------------------------------- sub swell
    // D1 + A1: an open fifth so low it reads as one note. §1.2 keeps this the only sub.
    this._subOut = this._gain(0.0001);
    this._subOut.connect(this._sum);
    this._subOscs = [];
    for (const m of [N.D1, N.A1]) {
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(mtof(m), now);
      const g = this._gain(m === N.D1 ? 0.85 : 0.35);
      o.connect(g);
      g.connect(this._subOut);
      o.start(now + 0.03);
      this._sources.push(o);
      this._n(o);
      this._subOscs.push(o);
    }

    // ------------------------------------------------------------------- stinger chain
    // Dry, slightly off-centre, with ONE bright slap (§6.4). Persistent.
    this._stgPan = this._n(ac.createStereoPanner ? ac.createStereoPanner() : ac.createGain());
    if (this._stgPan.pan) this._stgPan.pan.setValueAtTime(-0.15, now);
    this._stgIn = this._gain(0.32);
    this._stgIn.connect(this._stgPan);
    this._stgPan.connect(this._sum);

    this._slap = this._n(ac.createDelay(0.5));
    this._slap.delayTime.setValueAtTime(0.092, now);
    this._slapFb = this._gain(0.42);
    this._slapHP = this._filter('highpass', 900, 0.7);
    this._stgIn.connect(this._slap);
    this._slap.connect(this._slapHP);
    this._slapHP.connect(this._slapFb);
    this._slapFb.connect(this._slap);
    this._slapHP.connect(this._stgPan);

    // --------------------------------------------------------------------- layer table
    // `wantOn` is computed from dread; `on` only changes on a musical boundary.
    this._layers = [
      { id: 'ground', gain: this._strOut, base: db(-30), on: true, wantOn: true, at: 0, force: null, enter: 2, leave: 4 },
      { id: 'air', gain: this._padOut, base: db(-16), on: false, wantOn: false, at: 0, force: null, enter: 2, leave: 4 },
      { id: 'work', gain: null, base: 1, on: false, wantOn: false, at: 0, force: null, enter: 2, leave: 4 },
      { id: 'report', gain: this._pnoOut, base: db(-12), on: true, wantOn: true, at: 0, force: null, enter: 2, leave: 4 },
      { id: 'attention', gain: this._bowOut, base: db(-12), on: false, wantOn: false, at: 0, force: null, enter: 2, leave: 4 },
      { id: 'pressure', gain: null, base: 1, on: false, wantOn: false, at: 0, force: null, enter: 2, leave: 4 },
      { id: 'seen', gain: null, base: 1, on: false, wantOn: false, at: 0, force: null, enter: 2, leave: 4 },
      // The sub has no sustained gain of its own — it exists only as scheduled swells,
      // so the layer flag simply permits them (see _onBeat).
      { id: 'sub', gain: null, base: 1, on: false, wantOn: false, at: 0, force: null, enter: 2, leave: 4 },
    ];
    this._layerById = new Map(this._layers.map((l) => [l.id, l]));

    // The pad's slow domestic rock — one cycle per two bars. Only audible in work mode.
    this._rockLfo = this._lfo(1 / (BEAT * 8), 0);
    this._rockLfo.connect(this._padRock.gain);

    this._strOut.gain.setValueAtTime(db(-30), now);

    this._buildBedGraph();
  }

  /**
   * The generated bed's chain. Built unconditionally (it costs four gains and two biquads at
   * silence) so the manifest resolving later never has to touch the graph on the audio
   * thread, and so `dispose()` has exactly one list of nodes to disconnect either way.
   *
   *   [voice.gain → voice.trim] ×4 → _bedMix → _bedHP → _bedLP → _bedGate → _sum → _gate → …
   *
   * _bedHP  §1.2 keeps the 20–80 Hz band for the score's own sub swell. A recorded bed with
   *         energy down there would smear the one sub the score owns, so it is cut.
   * _bedLP  the bed's only continuous reaction: it opens with dread, and the mask drops its
   *         ceiling like everything else. It does NOT replace the synth's reactions.
   * _bedGate  the §8 total-silence gate for the bed alone (see _updateBedGate).
   */
  _buildBedGraph() {
    this._bedMix = this._gain(1);
    this._bedHP = this._filter('highpass', 78, 0.7);
    this._bedLP = this._filter('lowpass', 4200, 0.7);
    this._bedGate = this._gain(0.0001);

    this._bedMix.connect(this._bedHP);
    this._bedHP.connect(this._bedLP);
    this._bedLP.connect(this._bedGate);
    this._bedGate.connect(this._sum);

    // Four persistent voice slots: at most one playing bed, one incoming bed, one loop-seam
    // successor, and one spare. Gains are created once here so playback allocates only a
    // BufferSource — roughly one node per minute, against the score's several per second.
    this._bedVoices = [];
    for (let i = 0; i < 4; i++) {
      const gain = this._gain(0);
      const trim = this._gain(1);
      gain.connect(trim);
      trim.connect(this._bedMix);
      this._bedVoices.push({
        gain, trim, src: null, id: '', trimDb: -20,
        level: 0, f: null, endAt: 0, seamAt: 0, seamDone: true, stopped: true,
      });
    }
  }

  /**
   * Set the bowed-metal bank's Q and re-level it.
   *
   * A 2nd-order bandpass has unity gain at its centre but an equivalent noise bandwidth of
   * only (π/2)·f/Q, so a Q=780 partial fed from a noise source arrives ~45 dB down and the
   * level moves every time the bow pressure changes Q. We compensate analytically, which
   * keeps the drone's loudness stable while its *character* (the ring time, the beating)
   * tracks bowPressure — which is the part you are supposed to hear.
   */
  _setBowQ(q, now) {
    if (!this._bowFilters?.length) return;
    const sr = this.ac.sampleRate;
    this._bowQ = q;
    for (let i = 0; i < this._bowFilters.length; i++) {
      this._bowFilters[i].Q.setTargetAtTime(q, now, 2.0);
      const enb = Math.max(0.05, (Math.PI / 2) * BOW_PARTIALS[i] / q);
      const comp = Math.sqrt((sr / 2) / enb);
      const weight = (0.9 / (1 + 0.3 * i)) * (i === 5 ? this._bowDawn : 1);
      this._bowPartGains[i].gain.setTargetAtTime(Math.max(0.0001, weight * comp), now, 1.2);
    }
  }

  _applyVolumeSettings() {
    if (!this._out || !this.ac) return;
    const s = this.ctx?.settings;
    const v = (s?.get?.('masterVolume') ?? 0.9) * (s?.get?.('musicVolume') ?? 0.7);
    this._out.gain.setTargetAtTime(clamp(v, 0, 1.5), this.ac.currentTime, 0.05);
  }

  // ----------------------------------------------------------------------------- events

  _on(name, fn) {
    if (!this.bus) return;
    this._unsubs.push(this.bus.on(name, Log.guard(`Music:${name}`, fn)));
  }

  _bindEvents() {
    // ---- night lifecycle -----------------------------------------------------------
    this._on('night:begin', () => {
      this._stingersThisNight = 0;
      this._reportIndex = 0;
      this._reportQueue = 0;
      this._spotted = false;
      this._peakDread = 0;
      this._smoothed = 0;
      this._releaseHold('failed');
      this._releaseHold('night-end');
      this._releaseHold('dawn');
      // SILENCE CUE 1 — §8 S1 "The first breath of the night."
      // Absolute silence for 2.2 s. Then the score stays away for another 4 s while the
      // ambience bed arrives; the first thing the player hears from us is a struck string,
      // never a fade-in (§8 S12).
      this._hold('night-begin', P.NIGHT_BEGIN, 0, 6.2, 12, 20);
      this._nextStringAt = 0;   // recomputed at the arrival
    });

    this._on('game:start', () => { this._releaseHold('failed'); this._releaseHold('night-end'); });

    this._on('night:complete', () => {
      // SILENCE CUE 2 — the night is over. The score has no opinion about your score card.
      this._hold('night-end', P.NIGHT_END, 0, 30, 400, 40);
    });

    this._on('night:failed', () => {
      // SILENCE CUE 3 — §8 S7 "The end." Hard-mute on the frame it fires. 900 ms of true
      // digital silence, then ONE string note at D1 allowed to ring, and then nothing.
      this._hold('failed', P.FAILED, 0, 1e6, 4, 30);
      // Mute on THIS frame, not on the next parameter tick — then schedule the one note.
      // (Order matters: _evalHolds cancels pending gate events, so it must run first.)
      this._evalHolds(this.ac.currentTime);
      this.currentMood = 'dead';
      const t = this.ac.currentTime + 0.9;
      this._gate.gain.setTargetAtTime(1, t - 0.03, 0.006);
      this._strOut.gain.setTargetAtTime(db(-24), t - 0.05, 0.01);
      this._playString(t, 1.0, 0, false);
      // ...and then the gate closes again behind it and stays closed until the next night.
      this._gate.gain.setTargetAtTime(0.0001, t + 11.5, 0.35);
    });

    // ---- being seen ----------------------------------------------------------------
    this._on('player:spotted', (p) => {
      const level = p?.level ?? 1;
      this._lastDisturbance = this._elapsed;
      if (this._spotted) return;
      this._spotted = true;
      // SILENCE CUE 4 — a camper crosses into line of sight. The score stops dead: no
      // sting, no swell, nothing. 0.75 s of hole, then the arrival is a single struck
      // string under one bowed-metal partial (§2.4 keeps exactly one voice alive).
      if (level > 0.2) this._hold('seen', P.SEEN, 0, 0.75, 25, 25);
    });

    this._on('player:hidden', () => { this._spotted = false; });

    // ---- building ------------------------------------------------------------------
    this._on('build:place', (p) => {
      if (p?.correct) {
        this._reportQueue = Math.min(3, this._reportQueue + 1);
      } else {
        this._lastDisturbance = this._elapsed;
        // SILENCE CUE 5 — §8 S3 "The naked creak." Everything but the creak leaves for
        // 180 ms BEFORE the creak sounds, so the mistake arrives into a vacuum and is the
        // only thing in the world for a quarter of a second. The score returns over 900 ms.
        this._hold('naked-creak', P.NAKED_CREAK, 0, 1.08, 18, 900);
      }
    });

    this._on('build:creak', (p) => {
      const sev = clamp01(p?.severity ?? 0);
      this._lastDisturbance = this._elapsed;
      if (sev > 0.8) {
        // SILENCE CUE 6 — the instant before a tier-4 creak RESOLVES. The failure runs
        // 2.6 s in three movements (§4.11); the tear lands at 1600 ms. We vanish at
        // 1450 ms and stay gone for four seconds after it, so the building dies alone and
        // the aftermath crackle decelerates into nothing at all.
        this._holdAt('creak4', P.TIER4, 0, this.ac.currentTime + 1.45, 5.6, 30, 1400);
        this._lastDisturbance = this._elapsed + 4;
      } else if (sev > 0.5) {
        // Tier 3 "the groan" — a duck, not a silence (§2.3): −12 dB for 1.5 s.
        this._hold('creak3', P.CREAK3, db(-12), 1.5, 40, 1200);
      }
    });

    this._on('build:stage-complete', (p) => {
      this._reportIndex = Math.max(this._reportIndex, (p?.stage ?? 0) + 1);
      // SILENCE CUE 7 — §8 S6 "The clinical pause." 1.4 s of complete silence, then the
      // manual's completion chime plays alone and dry on sfxUI in a room that does not
      // exist. We stay out for 3.6 s total. DO NOT add a musical sting here. The deadpan
      // is the joke and a sting would explain it.
      this._hold('stage', P.STAGE, 0, 3.6, 25, 1800);
    });

    this._on('tool:missing', () => {
      // The manual is the comedian, not the score. The score's only contribution to the
      // running gag is that the next reward note arrives one hundred cents flat, and
      // nothing acknowledges it.
      this._reportFlat = true;
    });

    // ---- story / UI ----------------------------------------------------------------
    this._on('story:beat', (p) => {
      if (p?.id !== 'mask-on') return;
      // SILENCE CUE 8 — §8 S10 "The mask." Everything but the player's own breath is muted
      // for 400 ms; the score stays away 1.8 s and comes back darker (the pad's filter
      // ceiling drops permanently) — the world returns wrong.
      this._hold('mask', P.MASK, 0, 1.8, 20, 1400);
      this._masked = true;
    });

    this._on('ui:blueprint-open', () => {
      // Not a silence — a −14 dB duck (§2.3). The manual is louder than the woods.
      this._hold('blueprint', P.BLUEPRINT, db(-14), 1e6, 180, 400);
    });
    this._on('ui:blueprint-close', () => this._releaseHold('blueprint'));

    // ---- engine --------------------------------------------------------------------
    this._on('game:pause', () => {
      // SILENCE CUE 9 (deliberately NOT silence) — §8 S9. A hard mute on pause tells the
      // player the world is a program. −20 dB behind a 900 Hz lowpass tells them it is a
      // place, still there, waiting.
      this._hold('pause', P.PAUSE, db(-20), 1e6, 400, 400);
      this._glass?.frequency.setTargetAtTime(900, this.ac.currentTime, 0.13);
    });
    this._on('game:resume', () => {
      this._releaseHold('pause');
      this._glass?.frequency.setTargetAtTime(20000, this.ac.currentTime, 0.13);
    });

    this._on('weather:change', (p) => {
      this._wind = clamp01(p?.wind ?? this._wind);
      this._rain = clamp01(p?.rain ?? this._rain);
    });

    this._on('settings:changed', () => { if (this._ownsOutput) this._applyVolumeSettings(); });

    // Any loud thing counts as a disturbance and pushes the work theme away.
    this._on('noise:emit', (p) => {
      if ((p?.intensity ?? 0) > 0.4) this._lastDisturbance = this._elapsed;
    });
  }

  // ------------------------------------------------------------------- the silence stack

  _hold(id, pri, level, durS, attackMs, releaseMs) {
    this._holdAt(id, pri, level, this.ac.currentTime, durS, attackMs, releaseMs);
  }

  _holdAt(id, pri, level, startT, durS, attackMs, releaseMs) {
    let slot = null;
    for (const h of this._holds) if (h.active && h.id === id) { slot = h; break; }
    if (!slot) for (const h of this._holds) if (!h.active) { slot = h; break; }
    if (!slot) return;                       // 12 concurrent rules is already absurd
    slot.active = true;
    slot.id = id;
    slot.pri = pri;
    slot.level = level;
    slot.from = startT;
    slot.until = startT + durS;
    slot.attack = Math.max(0.004, attackMs / 1000) / 3;
    slot.release = Math.max(0.008, releaseMs / 1000) / 3;
    // Event-driven silences must land on the frame they fire, not on the next 10 Hz
    // parameter tick — S3 in particular is only 180 ms wide.
    if (this._gate && startT <= this.ac.currentTime + 1e-6) this._evalHolds(this.ac.currentTime);
  }

  _releaseHold(id) {
    let hit = false;
    for (const h of this._holds) if (h.active && h.id === id) { h.active = false; hit = true; }
    if (hit && this._gate) this._evalHolds(this.ac.currentTime);
  }

  /** Highest-priority active rule wins and rules do not blend (§8). No allocation. */
  _evalHolds(now) {
    let best = -1, bestPri = -1;
    for (let i = 0; i < this._holds.length; i++) {
      const h = this._holds[i];
      if (!h.active) continue;
      if (now >= h.until) { h.active = false; continue; }
      if (now < h.from) continue;
      if (h.pri > bestPri) { bestPri = h.pri; best = i; }
    }
    if (best === this._holdWinner) return;

    const prev = this._holdWinner >= 0 ? this._holds[this._holdWinner] : null;
    this._holdWinner = best;
    const win = best >= 0 ? this._holds[best] : null;
    const target = win ? win.level : 1;

    // §8 S12 — "Never break silence with a fade-in." Coming out of a TOTAL silence we do
    // not open the gate on a timer; we arm `_awaitArrival` and the gate opens 30 ms before
    // a struck note lands. Whatever ends a silence must arrive.
    if (!win && this._gateLevel < 0.02) {
      this._awaitArrival = true;
      this._gateLevel = target;
      this._updateBedGate(now, win?.attack ?? 0.01);
      return;
    }

    this._gateLevel = target;
    const tau = (target < (prev?.level ?? 1) ? (win?.attack ?? 0.01) : (prev?.release ?? 0.15)) || 0.05;
    this._gate.gain.cancelAndHoldAtTime?.(now);
    this._gate.gain.setTargetAtTime(Math.max(0.0001, target), now, tau);

    // The bed obeys the same rule on the same frame. A duck (pause, blueprint, the tier-3
    // groan) reaches it through `_gate` like everything else; a TOTAL silence closes its own
    // gate as well, so nothing can reopen `_gate` behind a silence rule and drag the bed back
    // in with it — which is exactly what `night:failed` does for its one ringing string.
    this._updateBedGate(now, win?.attack ?? 0.01);
  }

  /**
   * §8, applied to the generated bed. Zero whenever the score is in a TOTAL silence (or
   * waiting for the arrival that ends one), one otherwise; the bed's musical level lives in
   * the per-voice trims, never here.
   *
   * Ramped, always — 6 ms at the sharpest, which is the whole of §8's "hard mute on the frame
   * it fires" without the click. Allocation-free; safe to call from an event handler.
   */
  _updateBedGate(now, attackTau = 0.01) {
    if (!this._bedGate) return;
    const silent = this._gateLevel < 0.02 || this._awaitArrival;
    const want = (silent || this._bedOff || !this.enabled) ? 0 : 1;
    if (want === this._bedGateTarget) return;
    this._bedGateTarget = want;
    // Down: as fast as the winning rule's own attack (floored at 2.2 ms ⇒ ~6.6 ms of ramp).
    // Up: 0.35 s, and only ever *behind* something that has already arrived (§8 S12).
    const tau = want ? 0.35 : Math.max(0.0022, attackTau);
    this._bedGate.gain.cancelAndHoldAtTime?.(now);
    this._bedGate.gain.setTargetAtTime(want ? 1 : 0.0001, now, tau);
    this._bedStopAt = want ? Infinity : now + BED_STOP_AFTER_S;
  }

  _suppressed() {
    return this._gateLevel < 0.02 || this._awaitArrival;
  }

  // ---------------------------------------------------------------------------- update

  update(dt, elapsed) {
    if (!this.enabled || !this.ac) return;
    this._elapsed = elapsed ?? (this._elapsed + dt);
    this._lastUpdateAt = this.ac.currentTime;

    this._paramAccum += dt;
    if (this._paramAccum >= 0.1) {
      this._paramTick(this._paramAccum);
      this._paramAccum = 0;
    }

    this._schedAccum += dt;
    if (this._schedAccum >= SCHED_INTERVAL) {
      this._schedAccum = 0;
      this._scheduleAhead();
    }

    // The engine does not call update() while paused, and browsers throttle hidden tabs.
    // The scheduler must survive both, so a single self-rescheduling watchdog (NOT a
    // setInterval clock — update() is still the primary driver) tops it up when starved.
    this._armWatchdog();
  }

  _armWatchdog() {
    if (this._watchdog) return;
    this._watchdog = globalThis.setTimeout?.(() => {
      this._watchdog = 0;
      if (!this.enabled || !this.ac) return;
      // Only act if update() has genuinely stopped feeding us.
      if (this.ac.currentTime - this._lastUpdateAt > 0.2) {
        try { this._evalHolds(this.ac.currentTime); this._scheduleAhead(); } catch { /* noop */ }
        this._armWatchdog();
      }
    }, 90);
  }

  // ------------------------------------------------------------------------ parameters

  _paramTick(dt) {
    const ac = this.ac;
    const now = ac.currentTime;
    const state = this.ctx?.state ?? null;

    this._evalHolds(now);

    // ---------------------------------------------------------------- the dread scalar
    const auto = this._computeDread(state);
    this._autoDread = auto;
    const target = this._external == null ? auto : Math.max(auto, this._external);

    // §6.3 — rise τ 0.35 s, fall τ 4.5 s. Dread arrives instantly and leaves slowly.
    const tau = target > this._smoothed ? 0.35 : 4.5;
    this._smoothed += (target - this._smoothed) * (1 - Math.exp(-dt / tau));
    const d = this.dread = clamp01(this._smoothed);

    // §6.3 — THE COLLAPSE. Above 0.85 then back below 0.40 means the player got away, and
    // relief is a musical event that can only be scored by stopping.
    if (d > 0.85) this._peakDread = 1;
    else if (this._peakDread > 0 && d < 0.40) { this._peakDread = 0; this.collapse(); }

    // ------------------------------------------------------------------- time to dawn
    const tod = clamp01(state?.timeOfNight ?? 0);
    // SILENCE CUE 10 — §8 S11 "Pre-dawn." Above timeOfNight 0.92 the score is silent for
    // the rest of the night. Dawn is the reward and it must sound thin, cold, and survived;
    // anything we play over it would be taking credit.
    if (tod > 0.92) {
      if (this._holdWinner < 0 || this._holds[this._holdWinner].id !== 'dawn') {
        this._hold('dawn', P.DAWN, 0, 1e6, 6000, 40);
      }
      this.currentMood = 'dawn';
    } else if (tod < 0.9) {
      this._releaseHold('dawn');
    }
    // The cold sixth partial of the bowed drone rises through the last quarter of the night:
    // the drone gets thinner and higher as morning comes. Nobody will notice why.
    this._bowDawn = clamp01((tod - 0.55) / 0.37) * 0.5;

    // ------------------------------------------------------------------- the work theme
    // Almost pleasant. Patient, repetitive, faintly domestic — and it is the emotional
    // core of the whole score, because the horror is how easily it turns.
    const phase = state?.phase ?? 'build';
    const undisturbed = this._elapsed - this._lastDisturbance;
    const canWork = (phase === 'build' || phase === 'briefing') && tod < 0.9;
    if (this._workMode) {
      if (!canWork || d > 0.30 || undisturbed < 2) this._workMode = false;
    } else if (canWork && d < 0.20 && undisturbed > 12) {
      this._workMode = true;
    }

    // ------------------------------------------------------------------ layer wants
    const seenWant = this._spotted || d > 0.85;
    this._want('ground', true);
    this._want('air', d > 0.12 || this._workMode);
    this._want('work', this._workMode);
    this._want('report', true);
    this._want('attention', d > 0.35);
    this._want('pressure', d > 0.60);
    this._want('seen', seenWant);
    this._want('sub', this._workMode || d > 0.45);

    this._applyLayerBoundaries(now);

    // ----------------------------------------------------------------- continuous params
    // Pad filter tracks dread (§6.2). Under the mask the ceiling drops — the world came
    // back wrong and it never comes right again.
    const padCeil = this._masked ? 0.72 : 1;
    const cut = (240 + 900 * d) * padCeil;
    if (Math.abs(cut - (this._lastPadCut ?? -1)) > 4) {
      this._lastPadCut = cut;
      this._padFilter.frequency.setTargetAtTime(cut, now, 0.25);
      this._padFilter.Q.setTargetAtTime(3.5 + 1.5 * d, now, 0.4);
    }

    // The work theme's rocking motion — a chair, not a groove. Off the instant dread rises.
    this._rockLfo.gain.setTargetAtTime(this._workMode ? 0.09 : 0, now, 0.8);

    // The preparation only bites when things go wrong: the screws buzz at 0.18 while he is
    // working and at 0.55 once he is being hunted. Same instrument, different night.
    const buzz = this._workMode ? 0.18 : 0.30 + 0.25 * d;
    this._buzzDepth.gain.setTargetAtTime(buzz, now, 0.9);

    // Bowed metal: bowPressure 0.3 at L3, 0.7 at L4, and its Q with it (§6.2).
    let bowP = 0;
    if (this._isOn('attention')) bowP = 0.3;
    if (this._isOn('pressure')) bowP = 0.7;
    if (this._isOn('seen')) bowP = 0.92;
    // §2.4: during the held breath ONE bowed partial survives at −22 dB. That is this.
    this._bowPressure.gain.setTargetAtTime(Math.max(0.0001, bowP * 0.5), now, 3.0);
    const q = 180 + 600 * bowP;
    // Only re-level the bank when the bow actually moves — 12 automation events at 10 Hz
    // for a value that has not changed is pure waste on the audio thread.
    if (Math.abs(q - this._bowQ) > 1.5 || Math.abs(this._bowDawn - (this._bowDawnApplied ?? -1)) > 0.02) {
      this._bowDawnApplied = this._bowDawn;
      this._setBowQ(q, now);
    }

    // The pad's second/third/fourth voices. v3 is the only voice that ever retunes:
    // Eb (the flat second) becomes Ab (the reserved tritone) the moment the player is seen.
    this._setVoice(0, this._isOn('air') ? 0.55 : 0, now);
    this._setVoice(1, this._isOn('work') ? 0.34 : 0, now);
    this._setVoice(2, this._isOn('attention') || d > 0.35 ? 0.30 : 0, now);
    if (this._padVoices[3]) {
      const wantAb = this._isOn('seen');
      const v3 = this._padVoices[3];
      if (wantAb && v3.midi !== N.Ab2) this._retuneVoice(3, N.Ab2, now);
      else if (!wantAb && v3.midi !== N.Eb2 && !this._isOn('pressure')) this._retuneVoice(3, N.Eb2, now);
      this._setVoice(3, this._isOn('pressure') || wantAb ? 0.24 : 0, now);
    }

    // --------------------------------------------------------------------------- mood
    const winId = this._holdWinner >= 0 ? this._holds[this._holdWinner].id : '';
    if (winId === 'failed') this.currentMood = 'dead';
    else if (tod > 0.92) this.currentMood = 'dawn';
    else if (this._gateLevel < 0.02) this.currentMood = 'silent';
    else if (this._isOn('seen')) this.currentMood = 'seen';
    else if (this._isOn('pressure')) this.currentMood = 'pressure';
    else if (this._isOn('attention')) this.currentMood = 'attention';
    else if (this._workMode) this.currentMood = 'work';
    else if (this._isOn('air')) this.currentMood = 'air';
    else this.currentMood = 'ground';

    // ------------------------------------------------------------------ generated bed
    // Which bed the moment wants. The scheduler acts on it at the next bar (`_bedTick`),
    // never here, so a mood change can never cut.
    this._bedWant = this._chooseBed(state, tod, d);
    this._updateBedGate(now);

    // The bed's one continuous parameter. It opens with dread and loses its ceiling under
    // the mask, exactly like the pad — so the floor moves with the room even though it is a
    // fixed recording. Everything that must move FASTER than this is still synthesized.
    const bedCut = (2600 + 5200 * d) * padCeil;
    if (Math.abs(bedCut - this._lastBedCut) > 60) {
      this._lastBedCut = bedCut;
      this._bedLP?.frequency.setTargetAtTime(bedCut, now, 0.6);
    }
  }

  /**
   * Mood → bed id, with hysteresis on the dread thresholds so a bed can never flap around a
   * boundary (a crossfade costs 2–4 s; flapping would be audible mush).
   *
   * Night 7 replaces `work` and `tension` outright — per STORY.md the comedy is gone by then
   * and the patient domestic bed would be a lie. `hunt` is still `hunt`: a chase is a chase.
   */
  _chooseBed(state, tod, d) {
    const phase = state?.phase ?? 'build';
    if (phase === 'menu') return 'title';

    const prev = this._bedWant;
    const hi = prev === 'hunt' ? 0.66 : 0.78;         // fall out of the hunt later than in
    const mid = (prev === 'tension' || prev === 'hunt') ? 0.26 : 0.34;

    let want;
    if (this._spotted || phase === 'chase' || d > hi) want = 'hunt';
    else if (tod > 0.80) want = 'dawn';               // §8 S11 silences it entirely at 0.92
    else if (d > mid) want = 'tension';
    else want = 'work';

    const night = Number(state?.night) || 1;
    if (night >= 7 && (want === 'work' || want === 'tension')) want = 'night7';
    return want;
  }

  /** §6.3 — the dread scalar. Everything null-checked; a missing system contributes 0. */
  _computeDread(state) {
    const suspicion = clamp01(state?.suspicion ?? 0);

    // Another agent owns Campers; treat every property access as untrusted.
    let dist = Infinity;
    let los = this._spotted ? 1 : 0;
    try {
      const campers = this.ctx?.systems?.get?.('Campers') ?? null;
      if (campers) {
        const nd = campers.nearestDistance;
        if (typeof nd === 'number' && Number.isFinite(nd)) dist = nd;
        else if (typeof campers.nearest?.distance === 'number') dist = campers.nearest.distance;

        if (!los) {
          if (campers.playerInCone === true || campers.hasLineOfSight === true) los = 1;
          else if (typeof campers.visibility === 'number') los = clamp01(campers.visibility);
        }
      }
    } catch { /* a system mid-authoring must never break the score */ }
    const proximity = Number.isFinite(dist) ? 1 - clamp01(dist / 30) : 0;

    const creaks = clamp01((state?.creaks ?? 0) / 6);
    const progress = this._buildProgress();

    return clamp01(
      0.40 * suspicion +
      0.30 * proximity +
      0.15 * los +
      0.10 * creaks +
      0.05 * (1 - progress),
    );
  }

  /** BuildSystem may expose progress in several shapes, or not exist at all. */
  _buildProgress() {
    const bs = this.ctx?.systems?.get?.('BuildSystem') ?? null;
    if (bs) {
      if (typeof bs.progress === 'number') return clamp01(bs.progress);
      if (typeof bs.buildProgress === 'number') return clamp01(bs.buildProgress);
      if (typeof bs.getProgress === 'function') {
        const v = bs.getProgress();
        if (typeof v === 'number') return clamp01(v);
      }
      if (typeof bs.slotCount === 'number' && bs.slotCount > 0) {
        const inst = this.ctx?.state?.installed;
        return clamp01((inst ? Object.keys(inst).length : 0) / bs.slotCount);
      }
    }
    const inst = this.ctx?.state?.installed;
    if (inst) return clamp01(Object.keys(inst).length / 24);
    return 0;
  }

  // ----------------------------------------------------------------------- layer logic

  _want(id, on) {
    const l = this._layerById.get(id);
    if (!l) return;
    l.wantOn = l.force == null ? !!on : l.force;
  }

  _isOn(id) { return this._layerById.get(id)?.on === true; }

  /**
   * §6.3 transition rules: layers ENTER on the next 2 s boundary and LEAVE on the next 4 s
   * boundary, always with ≥ 1.5 s ramps. Never cut a layer. (The silence rules are the
   * only hard cuts in the score, and they act on the gate, not on layers.)
   */
  _applyLayerBoundaries(now) {
    for (const l of this._layers) {
      if (l.wantOn === l.on) { l.at = 0; continue; }
      if (l.at === 0) {
        const grid = (l.wantOn ? l.enter : l.leave) * BEAT;
        l.at = this._barZero + Math.ceil((now - this._barZero) / grid + 0.0001) * grid;
      }
      if (now >= l.at) {
        l.on = l.wantOn;
        l.at = 0;
        if (l.gain) {
          // τ = 0.5 → ~95% of the way in 1.5 s. Musical, never a cut.
          l.gain.gain.setTargetAtTime(l.on ? l.base : 0.0001, now, 0.5);
        }
      }
    }
  }

  _setVoice(i, amp, now) {
    const v = this._padVoices[i];
    if (!v || v.retuning) return;
    if (Math.abs(v.target - amp) < 1e-3) return;
    v.target = amp;
    v.gain.gain.setTargetAtTime(Math.max(0.0001, amp), now, 0.6);
  }

  /** Cross-fade a pad voice to a new pitch: out over 0.8 s, retune in the trough, in over 1.6 s. */
  _retuneVoice(i, midi, now) {
    const v = this._padVoices[i];
    if (!v || v.midi === midi || v.retuning) return;
    v.retuning = true;
    const hold = v.target;
    v.gain.gain.cancelAndHoldAtTime?.(now);
    v.gain.gain.setTargetAtTime(0.0001, now, 0.26);
    const at = now + 0.9;
    for (const o of v.oscs) o.osc.frequency.setValueAtTime(mtof(midi + o.oct * 12), at);
    v.midi = midi;
    v.gain.gain.setTargetAtTime(Math.max(0.0001, hold), at + 0.02, 0.5);
    // Cleared by the scheduler rather than a timer, so dispose() has nothing to chase.
    v.retuneUntil = at + 1.6;
  }

  // -------------------------------------------------------------------------- scheduler

  _scheduleAhead() {
    const ac = this.ac;
    const now = ac.currentTime;
    if (ac.state !== 'running') return;

    // Resync after a suspension rather than spinning through a thousand stale beats.
    if (this._nextBeatTime < now - 1) {
      const bars = Math.ceil((now + 0.1 - this._barZero) / (BEAT * 4));
      this._nextBeatTime = this._barZero + bars * BEAT * 4;
      this._beat = bars * 4;
    }

    for (const v of this._padVoices) {
      if (v.retuning && now > (v.retuneUntil ?? 0)) v.retuning = false;
    }

    let guard = 0;
    while (this._nextBeatTime < now + LOOKAHEAD && guard++ < 64) {
      this._onBeat(this._beat, this._nextBeatTime);
      this._beat++;
      this._nextBeatTime += BEAT;
    }

    // The bed is scheduled from here rather than from `_paramTick` because the watchdog
    // drives this method too: a hidden tab or a paused frame loop must not be able to make a
    // 50–90 s bed run off the end of its buffer with nobody scheduling the loop seam.
    if (this.generatedAvailable) this._bedTick(now);

    if (this._radioOn) this._scheduleRadio(now);
  }

  _onBeat(beat, t) {
    const barPos = beat % 4;
    const suppressed = this._suppressed();

    // §8 S12 — a silence ends when something ARRIVES. If we are waiting for an arrival,
    // the next downbeat gets a struck string and the gate opens 30 ms ahead of it.
    if (this._awaitArrival) {
      // A new rule took over while we were waiting — stay armed and stay gone.
      if (this._gateLevel < 0.02) return;
      if (barPos !== 0) return;
      this._awaitArrival = false;
      this._gate.gain.cancelAndHoldAtTime?.(this.ac.currentTime);
      this._gate.gain.setTargetAtTime(Math.max(0.0001, this._gateLevel), t - 0.03, 0.008);
      // The bed comes back UNDER the arrival, not before it — the struck string is what ends
      // the silence, and the floor swells in behind it over ~1 s.
      this._updateBedGate(t - 0.03);
      this._playString(t, 0.85, 0);
      this._nextStringAt = t + this._rand.range(22, 40);
      return;
    }
    if (suppressed) return;

    // ---- L0 GROUND — the game's pulse. One struck D1 every 22–40 s, present even at
    // dread 0. Closer to dawn it comes a little more often: he is running out of night.
    if (this._isOn('ground') && !this._isOn('seen') && t >= this._nextStringAt) {
      const tod = clamp01(this.ctx?.state?.timeOfNight ?? 0);
      this._playString(t, 0.7 + 0.2 * this.dread, this._rand.range(-9, 9));
      this._nextStringAt = t + this._rand.range(22 - 4 * tod, 40 - 10 * tod);
    }

    // ---- L5 SEEN — the string abandons its pulse for a 3-note irregular ostinato at
    // ~104 bpm. Same instrument, same note, no longer patient.
    if (this._isOn('seen') && beat >= this._nextOstinatoBeat) {
      for (let i = 0; i < OSTINATO_OFFSETS.length; i++) {
        this._playString(t + OSTINATO_OFFSETS[i], i === 2 ? 0.9 : 0.6, 0, false, OSTINATO_PITCHES[i], true);
      }
      this._nextOstinatoBeat = beat + 2;
    }

    // ---- THE WORK THEME — one note per bar, four bars, forever, no development.
    if (this._isOn('work') && barPos === 0 && t >= this._pianoFreeAt) {
      const bar = Math.floor(beat / 4) % 4;
      const note = WORK_FIGURE[bar];
      this._playPiano(t, note, 0.5 + 0.06 * ((bar % 2) ? 1 : -1));
      this._pianoFreeAt = t + 3.9;
      // He sets the tool down at the end of every phrase.
      if (bar === 3) this._damper(t + 2.6);
    }

    // ---- L2 REPORT — the only reward music in the game. One note per correct join, from
    // a slowly ascending sequence, never more often than every four seconds.
    if (this._reportQueue > 0 && this._isOn('report') && t >= this._pianoFreeAt) {
      this._reportQueue--;
      let m = REPORT_SEQUENCE[Math.min(this._reportIndex, REPORT_SEQUENCE.length - 1)];
      this._reportIndex = Math.min(this._reportIndex + 1, REPORT_SEQUENCE.length - 1);
      if (this._reportFlat) { m -= 1; this._reportFlat = false; }   // the missing part, deadpan
      this._playPiano(t, m, 0.62);
      this._pianoFreeAt = t + 4.0;
    }

    // ---- SUB — a slow swell every two bars. Under the work theme it is a breath; under
    // dread it is a floor tilting.
    if (this._isOn('sub') && t >= this._nextSubAt) {
      // §1.2 keeps the 20–80 Hz band nearly empty; this is the only sub the score owns.
      const peak = this._workMode ? db(-34) : db(-24) * (0.5 + 0.5 * this.dread);
      const rise = this._workMode ? 5.5 : 3.0;
      this._subOut.gain.cancelAndHoldAtTime?.(t);
      this._subOut.gain.setTargetAtTime(peak, t, rise / 3);
      this._subOut.gain.setTargetAtTime(0.0001, t + rise + 1.5, 2.2);
      this._nextSubAt = t + BEAT * 8;
    }
  }

  // ------------------------------------------------------------------------ instruments

  /**
   * THE STRING. A pre-rendered Karplus–Strong buffer; one source node, nothing else.
   * `strong` routes to the dry, louder path — the string being *struck* rather than sounded.
   */
  _playString(t, vel = 0.8, cents = 0, strong = false, midi = N.D1, short = false) {
    if (!this.ac || !this._bufString) return;
    const ac = this.ac;
    const when = Math.max(t, ac.currentTime + 0.02);
    const buf = short ? this._bufStringShort : this._bufString;
    const dest = strong ? this._strDry : this._strLP;
    const src = ac.createBufferSource();
    src.buffer = buf;
    // Pitch by playbackRate — the buffer is D1, everything else is a small shift.
    const semis = midi - N.D1;
    src.playbackRate.setValueAtTime(Math.pow(2, semis / 12), when);
    src.detune?.setValueAtTime?.(cents, when);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(clamp(vel, 0.0002, 1) * 0.9, when + 0.006);
    src.connect(g);
    g.connect(dest);
    src.start(when);
    src.onended = () => { try { src.disconnect(); g.disconnect(); } catch { /* noop */ } };

    // "A single detuned string": a second voice 11 cents sharp at −9 dB, so the note beats
    // against itself. One string, two surfaces, exactly like everything else in this game.
    if (!short) {
      const src2 = ac.createBufferSource();
      src2.buffer = buf;
      src2.playbackRate.setValueAtTime(Math.pow(2, semis / 12), when);
      src2.detune?.setValueAtTime?.(cents + 11, when);
      const g2 = ac.createGain();
      g2.gain.setValueAtTime(0.0001, when);
      g2.gain.linearRampToValueAtTime(clamp(vel, 0.0002, 1) * 0.35, when + 0.008);
      src2.connect(g2);
      g2.connect(dest);
      src2.start(when + 0.004);
      src2.onended = () => { try { src2.disconnect(); g2.disconnect(); } catch { /* noop */ } };
    }
  }

  /**
   * PREPARED PIANO. Persistent modal bank; only the exciter is new. Inharmonic partials
   * (f_n = n·f0·sqrt(1+B·n²)), Q = 900/n, decay = 3200/n^0.8 ms, and a 64 Hz buzz on
   * partials 3–5 — a screw laid across the string.
   */
  _playPiano(t, midi, vel = 0.6) {
    if (!this.ac || !this._pnoPart) return;
    const ac = this.ac;
    const when = Math.max(t, ac.currentTime + 0.03);
    const f0 = mtof(midi);
    const nyq = ac.sampleRate * 0.45;

    // Retune the (silent) bank just before the strike.
    for (let i = 0; i < this._pnoPart.length; i++) {
      const n = i + 1;
      const f = Math.min(nyq, n * f0 * Math.sqrt(1 + PIANO_B * n * n));
      this._pnoPart[i].bp.frequency.setValueAtTime(f, when - 0.02);
      this._pnoPart[i].bp.Q.setValueAtTime(Math.max(2, 900 / n), when - 0.02);
    }
    this._pnoExcLP.frequency.setValueAtTime(Math.min(nyq, 4 * f0), when - 0.02);

    // The strike: a 1.5 ms noise burst. §9.2 permits this to be short — the transient comes
    // from the SOURCE, never from a 0 ms gain envelope.
    const src = ac.createBufferSource();
    src.buffer = this._bufWhite;
    src.loop = false;
    const eg = this._pnoExcGain.gain;
    eg.cancelAndHoldAtTime?.(when - 0.005);
    eg.setValueAtTime(0.0001, when);
    eg.linearRampToValueAtTime(24 * clamp(vel, 0, 1), when + 0.001);
    eg.exponentialRampToValueAtTime(0.0001, when + 0.0025);
    src.connect(this._pnoExcGain);
    src.start(when, this._rand.range(0, 0.15), 0.01);
    src.onended = () => { try { src.disconnect(); } catch { /* noop */ } };

    for (let i = 0; i < this._pnoPart.length; i++) {
      const n = i + 1;
      const f = Math.min(nyq, n * f0 * Math.sqrt(1 + PIANO_B * n * n));
      // Modal normalization: a bandpass at Q=900/n transfers almost none of a 1.5 ms
      // burst's energy (its impulse response peaks at ≈ sin(ω₀)/2Q), so each partial is
      // scaled by the inverse of that. Without this the whole instrument is 60 dB down.
      const w0 = (2 * Math.PI * f) / ac.sampleRate;
      const alpha = Math.max(1e-7, Math.sin(w0) / (2 * Math.max(2, 900 / n)));
      const gain = (0.9 / Math.pow(n, 1.1)) * (0.005 / alpha);
      const decay = (3200 / Math.pow(n, 0.8)) / 1000;
      const p = this._pnoPart[i].env.gain;
      p.cancelAndHoldAtTime?.(when - 0.004);
      p.setValueAtTime(0.0001, when);
      p.linearRampToValueAtTime(gain, when + 0.004);
      p.exponentialRampToValueAtTime(0.0001, when + 0.004 + decay);
    }
  }

  /** The damper thunk on note-off (§6.2). A small wooden nothing. */
  _damper(t) {
    if (!this.ac) return;
    const ac = this.ac;
    const when = Math.max(t, ac.currentTime + 0.02);
    const src = ac.createBufferSource();
    src.buffer = this._bufWhite;
    const eg = this._pnoExcGain.gain;
    eg.cancelAndHoldAtTime?.(when - 0.004);
    eg.setValueAtTime(0.0001, when);
    eg.linearRampToValueAtTime(12, when + 0.001);
    eg.exponentialRampToValueAtTime(0.0001, when + 0.003);
    src.connect(this._pnoExcGain);
    src.start(when, this._rand.range(0, 0.15), 0.008);
    src.onended = () => { try { src.disconnect(); } catch { /* noop */ } };
    const p = this._damperEnv.gain;
    p.cancelAndHoldAtTime?.(when - 0.004);
    p.setValueAtTime(0.0001, when);
    p.linearRampToValueAtTime(2.2, when + 0.005);   // modal normalization, as in _playPiano
    p.exponentialRampToValueAtTime(0.0001, when + 0.065);
  }

  // --------------------------------------------------------------------- generated beds

  /**
   * Start the optional generated-score layer. Nothing here is awaited by `init()` and
   * nothing here can throw into the caller: the failure path IS the shipping path for any
   * clone without `public/audio/`.
   */
  _initGeneratedBeds() {
    const s = this.ctx?.settings ?? null;
    // Decoded PCM is expensive (a 90 s stereo bed is ~35 MB at 48 kHz), so only a couple of
    // beds are ever resident. Eviction never touches a bed that is sounding.
    this._bedCacheMax = s?.tier ? s.tier(2, 2, 3, 3) : 3;

    this._loadMusicManifest()
      .then((ok) => {
        if (this._disposed || !this.enabled) return;
        this.generatedAvailable = !!ok;
        if (!ok) {
          Log.debug('[Music] no generated score manifest — pure synthesis. This is a valid state.');
          return;
        }
        Log.debug(`[Music] generated score beds: ${this._bedFiles.size}, loop crossfade ${this._loopXfade}s.`);
        // Warm the bed the current moment already wants so the first entry is not a wait.
        this._ensureBedBuffer(MUSIC_BEDS[this._bedWant] ?? MUSIC_BEDS.work);
      })
      .catch(() => { this.generatedAvailable = false; });
  }

  /**
   * Read `public/audio/manifest.json`. Returns false — quietly, at debug level — for a 404,
   * a dev server answering with the SPA's index.html, an offline load, a `file://` origin, a
   * CSP block, or a manifest with no `music` array.
   */
  async _loadMusicManifest() {
    let res;
    try {
      // `no-cache` (revalidate), not `force-cache`: a dev server answers a not-yet-existing
      // path with index.html, and a forced cache would pin that HTML for the session.
      res = await fetch(siteUrl('audio/manifest.json'), { cache: 'no-cache' });
    } catch {
      return false;
    }
    if (!res || !res.ok) return false;
    const type = res.headers?.get?.('content-type') ?? '';
    if (type && type.indexOf('json') < 0) return false;   // the SPA fallback, not a manifest

    let json;
    try { json = await res.json(); } catch { return false; }
    const list = Array.isArray(json?.music) ? json.music : null;
    if (!list || list.length === 0) return false;

    const xf = Number(json?.loopCrossfadeSeconds);
    if (Number.isFinite(xf) && xf > 0) this._loopXfade = clamp(xf, 0.5, 4);

    for (const e of list) {
      const id = String(e?.id ?? '');
      const file = String(e?.file ?? '');
      if (!id || !file) continue;
      this._bedFiles.set(id, { url: siteUrl(file), seconds: Number(e?.seconds) || 0 });
    }
    return this._bedFiles.size > 0;
  }

  /**
   * The decoded buffer for `id`, or null. A miss starts exactly one background load and
   * returns null immediately — the caller keeps synthesizing and asks again next tick.
   */
  _ensureBedBuffer(id) {
    if (!id || !this.ac || this._disposed) return null;
    const hit = this._bedBuffers.get(id);
    if (hit) {
      this._bedBuffers.delete(id);       // refresh LRU position
      this._bedBuffers.set(id, hit);
      return hit;
    }
    if (this._bedDead.has(id) || this._bedLoading.has(id)) return null;
    const entry = this._bedFiles.get(id);
    if (!entry) return null;

    const p = (async () => {
      try {
        const res = await fetch(entry.url, { cache: 'default' });
        if (!res.ok) throw new Error(String(res.status));
        const ctype = res.headers?.get?.('content-type') ?? '';
        if (ctype.indexOf('html') >= 0) throw new Error('got html, not audio');
        const raw = await res.arrayBuffer();
        if (this._disposed || !this.ac) return;
        const buf = await this.ac.decodeAudioData(raw);
        if (this._disposed || !this.ac) return;
        this._bedBuffers.set(id, buf);
        this._evictBeds(id);
      } catch (e) {
        // A missing or unplayable bed is not an error condition. Write it off for the
        // session; that mood simply plays on synthesis alone, which is a complete sound.
        this._bedDead.add(id);
        Log.debug(`[Music] bed '${id}' unavailable (${e?.message ?? e}) — synthesis covers it.`);
      } finally {
        this._bedLoading.delete(id);
      }
    })();
    this._bedLoading.set(id, p);
    return null;
  }

  /** True while any voice slot is still sounding this bed. */
  _bedInUse(id) {
    for (const v of this._bedVoices) if (v.src && v.id === id) return true;
    return false;
  }

  /** Drop the least recently used decoded bed until we are back under the cap. */
  _evictBeds(keep) {
    while (this._bedBuffers.size > this._bedCacheMax) {
      let victim;
      for (const k of this._bedBuffers.keys()) {
        if (k === keep || this._bedInUse(k)) continue;
        victim = k;
        break;
      }
      if (victim === undefined) return;
      this._bedBuffers.delete(victim);
    }
  }

  /** The next 4 s bar boundary at or after `t`, on the same grid the layers use (§6.3). */
  _nextBar(t) {
    const bar = BEAT * 4;
    return this._barZero + Math.ceil((t - this._barZero) / bar - 1e-6) * bar;
  }

  /**
   * The bed scheduler. Runs at the scheduler's rate, allocates nothing in the steady state,
   * and does exactly three things: stop when the score is silent, keep the loop seam fed,
   * and cross into the wanted bed on a bar line.
   */
  _bedTick(now) {
    if (this._bedOff || !this._bedGate || this._bedVoices.length === 0) return;

    // 1. §8. A total silence is not a duck. Once it has held for a couple of seconds the
    //    sources stop outright — nothing is left running under the hole, and whatever ends
    //    the silence gets a genuine entry rather than a bed already mid-phrase.
    if (this._bedGateTarget === 0) {
      if (this._bedCurrent && now > this._bedStopAt) this._stopBedVoices(now);
      return;
    }

    // A voice that reached the end of its buffer clears itself; forget it and re-enter.
    if (this._bedCurrent && !this._bedCurrent.src) {
      this._bedCurrent = null;
      if (this._bedSwitchOk > now) this._bedSwitchOk = now;
    }

    // 2. THE LOOP SEAM. These beds are 50–90 s and `loop: true` on a BufferSource would tick
    //    audibly at the join, so the bed is crossfaded against a second copy of itself over
    //    the manifest's own `loopCrossfadeSeconds`. Scheduled a second early; the successor
    //    inherits the trim, so the level does not move across the seam.
    const cur = this._bedCurrent;
    if (cur && cur.src && !cur.seamDone && now >= cur.seamAt - 1.0) {
      const buf = this._bedBuffers.get(cur.id);
      if (buf) {
        cur.seamDone = true;
        const nv = this._startBedVoice(cur.id, buf, cur.seamAt, this._loopXfade, cur.trimDb);
        if (nv) {
          this._fadeVoice(cur, 0, cur.seamAt, this._loopXfade);
          this._endVoiceAfter(cur, cur.seamAt + this._loopXfade);
          this._bedCurrent = nv;
        }
      } else {
        // Evicted mid-flight (it cannot be — `_bedInUse` protects it — but the cache is not
        // the only way a buffer can go). Re-request and try again next tick.
        this._ensureBedBuffer(cur.id);
      }
    }

    // 3. THE MOOD CROSSFADE. Equal power, on a bar line, 2–4 s, never a cut.
    const id = MUSIC_BEDS[this._bedWant];
    if (!id) return;
    if (this._bedCurrent && this._bedCurrent.id === id) return;
    if (now < this._bedSwitchOk) return;
    const buf = this._ensureBedBuffer(id);
    if (!buf) return;                        // still loading, or absent — synthesis carries it

    const dur = this._bedWant === 'hunt' ? BED_XFADE_FAST_S : BED_XFADE_S;
    const at = this._nextBar(now + 0.2);
    const nv = this._startBedVoice(id, buf, at, dur, BED_TRIM_DB[this._bedWant] ?? -20);
    if (!nv) return;
    const old = this._bedCurrent;
    if (old && old.src) {
      this._fadeVoice(old, 0, at, dur);
      this._endVoiceAfter(old, at + dur);
      old.seamDone = true;                   // its seam belongs to a bed we are leaving
    }
    this._bedCurrent = nv;
    this._bedSwitchOk = at + dur + BED_DWELL_S;
  }

  /** A slot with nothing playing, or the quietest one if we somehow ran out. */
  _freeBedVoice(t) {
    for (const v of this._bedVoices) if (!v.src) return v;
    let best = null, bestLevel = Infinity;
    for (const v of this._bedVoices) {
      const l = this._voiceLevelAt(v, t);
      if (l < bestLevel) { bestLevel = l; best = v; }
    }
    if (best && best.src) {
      // Should not happen (two beds and a seam is three of four slots), but a slot is never
      // reclaimed on a live gain: ramp it out first, then stop it.
      this._fadeVoice(best, 0, t - 0.06, 0.05);
      try { best.src.stop(Math.max(t, this.ac.currentTime + 0.01)); } catch { /* already stopped */ }
      best.stopped = true;
    }
    return best;
  }

  /**
   * Start `buf` on a free slot at `startT`, fading in equal-power over `fadeS`.
   * One BufferSource is created here and nowhere else in this layer.
   */
  _startBedVoice(id, buf, startT, fadeS, trimDb) {
    if (!this.ac || !buf) return null;
    const ac = this.ac;
    const when = Math.max(startT, ac.currentTime + 0.02);
    const v = this._freeBedVoice(when);
    if (!v) return null;

    const src = ac.createBufferSource();
    src.buffer = buf;
    src.loop = false;                        // the seam is ours, not the BufferSource's
    src.connect(v.gain);

    v.gain.gain.cancelScheduledValues?.(when);
    v.gain.gain.setValueAtTime(0, when);
    v.trim.gain.setValueAtTime(db(trimDb), when);   // set while the voice is silent: no click

    v.src = src;
    v.id = id;
    v.trimDb = trimDb;
    v.level = 0;
    v.f = null;
    v.stopped = false;
    v.endAt = when + buf.duration;
    v.seamAt = clamp(v.endAt - this._loopXfade, when + fadeS + 1, v.endAt - 0.25);
    v.seamDone = false;

    src.start(when);
    src.onended = () => {
      try { src.disconnect(); } catch { /* noop */ }
      if (v.src !== src) return;
      v.src = null; v.id = ''; v.f = null; v.level = 0; v.stopped = true;
      try { v.gain.gain.cancelScheduledValues?.(0); v.gain.gain.setValueAtTime(0, this.ac ? this.ac.currentTime : 0); } catch { /* graph gone */ }
    };

    this._fadeVoice(v, 1, when, fadeS);
    return v;
  }

  /** The value a voice's fade will have at `t` — tracked in JS so nothing reads the graph. */
  _voiceLevelAt(v, t) {
    const f = v.f;
    if (!f) return v.level;
    if (t <= f.t0) return f.from;
    if (t >= f.t0 + f.dur) return f.to;
    const x = (t - f.t0) / f.dur;
    return f.to > f.from
      ? f.from + (f.to - f.from) * Math.sin(x * HALF_PI)
      : f.to + (f.from - f.to) * Math.cos(x * HALF_PI);
  }

  /**
   * Equal-power fade, drawn as XF_STEPS linear ramps rather than `setValueCurveAtTime` — a
   * value curve cannot be pre-empted (any event landing inside one throws), and a crossfade
   * that can never be interrupted is a crossfade that will one day be interrupted.
   *
   * sin/cos quarter-cycles: the two sides of a crossfade sum to constant POWER, so a bed
   * handing over to another bed never dips in the middle the way a linear pair does.
   */
  _fadeVoice(v, to, startT, dur) {
    const p = v.gain.gain;
    const t0 = Math.max(startT, this.ac.currentTime);
    const d = Math.max(0.02, dur);
    const from = this._voiceLevelAt(v, t0);
    if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(t0);
    else p.cancelScheduledValues(t0);
    p.setValueAtTime(from, t0);
    const up = to > from;
    for (let i = 1; i <= XF_STEPS; i++) {
      const x = i / XF_STEPS;
      const k = up
        ? from + (to - from) * Math.sin(x * HALF_PI)
        : to + (from - to) * Math.cos(x * HALF_PI);
      p.linearRampToValueAtTime(k, t0 + d * x);
    }
    v.f = { from, to, t0, dur: d };
    v.level = to;
  }

  /** Stop a voice once its fade has finished. Never mid-fade — that is the click. */
  _endVoiceAfter(v, t) {
    if (!v.src || v.stopped) return;
    try { v.src.stop(t + 0.06); v.stopped = true; } catch { /* already scheduled */ }
  }

  /** Take the bed out entirely: a 60 ms ramp (under a closed gate anyway), then stop. */
  _stopBedVoices(now) {
    for (const v of this._bedVoices) {
      if (!v.src) continue;
      this._fadeVoice(v, 0, now, 0.06);
      this._endVoiceAfter(v, now + 0.06);
      v.seamDone = true;
    }
    this._bedCurrent = null;
    this._bedStopAt = Infinity;
    this._bedSwitchOk = 0;
  }

  // ---------------------------------------------------------------------------- stinger

  /**
   * "THE STAPLE" — AUDIO_DIRECTION.md §6.4.
   *
   * STRUCTURE: a reversed struck-steel tail swelling INTO three struck-steel hits at
   * t = 0 / 118 / 214 ms (accelerando, irregular), the third detuned down 100 cents, then
   * an answering low clang at 470 ms — the string struck hard plus a 44 Hz sine drop —
   * with a single bright slap echo (92 ms, feedback 0.42, feedback path highpassed at
   * 900 Hz so it "tings" away rather than "shushing").
   *
   * HOW THIS DIFFERS FROM THE FRIDAY THE 13TH "ki-ki-ki, ma-ma-ma" FIGURE — deliberately,
   * specifically, and structurally:
   *   1. IT IS NOT VOCAL. Manfredini's figure is a processed human voice: formants, breath,
   *      consonant articulation. Ours has no vocal content of any kind. It is struck metal,
   *      because this is a game about hardware.
   *   2. THE RHYTHM IS IRREGULAR AND ACCELERATING (0 / 118 / 214 ms), not an even repeated
   *      subdivision. It sounds like something being HIT, not something being COUNTED.
   *   3. IT ARRIVES BEFORE IT ARRIVES. The figure is preceded by its own tail played
   *      BACKWARDS — a reversed metal swell that crescendos into the first hit. The
   *      original has no pre-echo at all; ours announces itself with a sound that is
   *      physically impossible, which is the only supernatural thing in the game.
   *   4. THE ECHO IS ONE CRISP BRIGHT SLAP, not a long tape-delay smear, and it gets
   *      brighter as it decays rather than darker.
   *   5. THE ANSWER IS ONE CLANG, not a two-note vocal response. Call-and-response is
   *      preserved; none of the material is.
   *   6. ITS FUNCTION IS INVERTED. It does not play when the monster appears — the player
   *      IS the monster. It plays ~1.2 s BEFORE a camper turns to look in the player's
   *      direction. It is a tell, not a sting: it means "you are about to be seen," and it
   *      is the closest thing this game has to a HUD.
   *
   * Fire it at most twice per night, and never when the player is already spotted.
   *
   * @param {string} name  'staple' (the only figure; anything else falls back to it)
   * @param {{leadMs?:number}} opts  fire this many ms before the camper turns (default 1200)
   * @returns {boolean} whether it actually played
   */
  stinger(name = 'staple', opts) {
    if (!this.enabled || !this.ac) return false;
    if (this._spotted) return false;                       // a tell you no longer need
    if (this._stingersThisNight >= 2) return false;        // never wallpaper
    if (this._gateLevel < 0.02) return false;              // never over a §8 silence
    if (name && name !== 'staple') Log.debug(`[Music] unknown stinger '${name}' — playing THE STAPLE.`);

    const ac = this.ac;
    const leadMs = clamp(opts?.leadMs ?? 1200, 300, 4000);
    const pre = clamp(leadMs * 0.0005, 0.25, 0.9);         // the reversed swell's length
    const t0 = ac.currentTime + 0.03 + pre;                // the first hit lands here

    this._stingersThisNight++;

    // The reversed tail, swelling into hit 1.
    this._metalHit(t0 - pre, 0.55, 0, true, pre);

    // Three hits: accelerando, irregular, the third a minor second below the first two.
    this._metalHit(t0, 1.0, 0);
    this._metalHit(t0 + 0.118, 0.86, 12);
    this._metalHit(t0 + 0.214, 0.94, -100);

    // The answer at 470 ms: the string struck hard, plus a 44 Hz sine drop.
    this._playString(t0 + 0.470, 1.0, -6, true);
    const o = ac.createOscillator();
    o.type = 'sine';
    const at = t0 + 0.470;
    o.frequency.setValueAtTime(44, at);
    o.frequency.exponentialRampToValueAtTime(29, at + 0.55);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(db(-12), at + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.62);
    o.connect(g);
    g.connect(this._sum);
    o.start(at);
    o.stop(at + 0.66);
    o.onended = () => { try { o.disconnect(); g.disconnect(); } catch { /* noop */ } };
    return true;
  }

  _metalHit(t, vel, cents, reversed = false, stretch = 0) {
    const ac = this.ac;
    const when = Math.max(t, ac.currentTime + 0.02);
    const buf = reversed ? this._bufMetalRev : this._bufMetal;
    if (!buf) return;
    const src = ac.createBufferSource();
    src.buffer = buf;
    if (reversed && stretch > 0) src.playbackRate.setValueAtTime(clamp(buf.duration / stretch, 0.25, 4), when);
    src.detune?.setValueAtTime?.(cents, when);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(clamp(vel, 0, 1), when + (reversed ? 0.02 : 0.004));
    src.connect(g);
    g.connect(this._stgIn);
    src.start(when);
    src.onended = () => { try { src.disconnect(); g.disconnect(); } catch { /* noop */ } };
  }

  // ------------------------------------------------------------------------- public API

  /**
   * External intensity floor, 0..1. The score plays at `max(auto, external)` so a caller
   * can raise the temperature but never accidentally silence a real threat.
   * Pass `null` to hand control back to the automatic dread scalar.
   */
  setIntensity(x) {
    if (x == null) { this._external = null; return; }
    const v = Number(x);
    this._external = Number.isFinite(v) ? clamp01(v) : null;
  }

  /** AUDIO_DIRECTION.md §9.5 spelling. */
  setDread(x) { this.setIntensity(x); }

  /** Read-only view of the smoothed dread scalar (§6.3). */
  getIntensity() { return this.dread; }

  /**
   * Force a layer on or off. `on === null|undefined` restores automatic control.
   * Layers: 'ground' | 'air' | 'work' | 'report' | 'attention' | 'pressure' | 'seen' | 'sub'.
   * Forced changes still respect the boundary/cross-fade rules — nothing ever hard-cuts.
   */
  setLayer(name, on) {
    const l = this._layerById?.get?.(String(name ?? '').toLowerCase());
    if (!l) return false;
    l.force = on == null ? null : !!on;
    if (l.force != null) l.wantOn = l.force;
    return true;
  }

  isLayerOn(name) { return this._isOn(String(name ?? '').toLowerCase()); }

  /** Which generated bed the current moment wants: title|work|tension|hunt|dawn|night7. */
  get bedMood() { return this._bedWant; }

  /**
   * Turn the generated bed layer off (or back on) at runtime — for A/B'ing the mix, or for a
   * player-facing "synthesized score" option. The synthesis is completely unaffected either
   * way: with the bed off this file behaves exactly as it does on a clone with no assets.
   */
  setBeds(on) {
    const off = !on;
    if (off === this._bedOff) return this.generatedAvailable;
    this._bedOff = off;
    if (!this.ac) return this.generatedAvailable;
    const now = this.ac.currentTime;
    if (off) {
      this._updateBedGate(now, 0.08);      // 240 ms out — this is a mix change, not a cue
      this._stopBedVoices(now + 0.3);
    } else {
      this._updateBedGate(now);
    }
    return this.generatedAvailable;
  }

  /**
   * §6.3 / §8 S5 — THE COLLAPSE. Everything ramps out over 3.5 s except L0, L0 plays one
   * note, and then there is no music at all for 20–40 s. Relief is a musical event and the
   * only way to score it is to stop scoring.
   */
  collapse() {
    if (!this.enabled || !this.ac) return;
    const now = this.ac.currentTime;
    this.currentMood = 'collapse';
    for (const l of this._layers) {
      if (l.id === 'ground') continue;
      l.force = null;
      l.wantOn = false;
      l.on = false;
      l.at = 0;
      if (l.gain) l.gain.gain.setTargetAtTime(0.0001, now, 1.15);
    }
    this._spotted = false;
    this._peakDread = 0;
    this._smoothed = Math.min(this._smoothed, 0.35);
    this._playString(now + 3.4, 0.75, -4, false);
    // SILENCE CUE 11 — the escape. 20–40 s of nothing after the last note has rung.
    this._holdAt('escape', P.ESCAPE, 0, now + 5.2, this._rand.range(20, 40), 900, 40);
  }

  /** Manual silence, for anything that needs the score out of the way. */
  silence(ms = 1000, id = 'manual', priority = 60) {
    if (!this.enabled || !this.ac) return;
    this._hold(id, priority, 0, Math.max(0.05, ms / 1000), 25, 400);
  }

  // ------------------------------------------------------------------------- camp radio

  /**
   * §5.3 — the transistor radio at the mess hall, 1984. Assigned to Music.js because it is
   * generative: a cheap, cheerful I–V–vi–IV in F with a drum machine and a saccharine
   * synth-brass lead, then destroyed by the transmission chain (a 4-inch paper cone in a
   * plastic box, an amp that is always overdriven, and a signal that drifts).
   *
   * It is tuned to A = 440 while the score is at A = 436, so when both are audible they
   * beat against each other. That is intentional and it is horrible.
   *
   * The radio is a CLOCK: it goes off at timeOfNight 0.55 (lights out) with a single loud
   * click, and the silence after it is the second-best moment in the audio design.
   *
   * @param {AudioNode} [dest] where to route it — normally a PannerNode at the mess hall.
   *                           Defaults to our own output, which is fine but not positioned.
   */
  startRadio(dest) {
    if (!this.enabled || !this.ac || this._radioOn) return null;
    const ac = this.ac;
    const now = ac.currentTime;

    const mk = (n) => { this._radioNodes.push(n); return n; };
    const bp = mk(ac.createBiquadFilter()); bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 0.9;
    const hp = mk(ac.createBiquadFilter()); hp.type = 'highpass'; hp.frequency.value = 520;
    const ws = mk(ac.createWaveShaper()); ws.curve = CURVE_RADIO;
    const honk = mk(ac.createBiquadFilter()); honk.type = 'peaking'; honk.frequency.value = 2900; honk.Q.value = 2.5; honk.gain.value = 6;
    const lp = mk(ac.createBiquadFilter()); lp.type = 'lowpass'; lp.frequency.value = 4800;
    const dc = mk(ac.createBiquadFilter()); dc.type = 'highpass'; dc.frequency.value = 18;
    const drift = mk(ac.createGain()); drift.gain.setValueAtTime(db(-14), now);

    this._radioIn = mk(ac.createGain());
    this._radioIn.gain.setValueAtTime(0.5, now);
    this._radioIn.connect(bp); bp.connect(hp); hp.connect(ws); ws.connect(honk);
    honk.connect(lp); lp.connect(dc); dc.connect(drift);
    drift.connect(dest && typeof dest.connect === 'function' ? dest : this._out);
    this._radioDrift = drift;
    this._radioDest = dest && typeof dest.connect === 'function' ? dest : this._out;

    // AM hiss.
    const hiss = mk(ac.createBufferSource());
    hiss.buffer = this._bufPink;
    hiss.loop = true;
    const hbp = mk(ac.createBiquadFilter()); hbp.type = 'bandpass'; hbp.frequency.value = 1600; hbp.Q.value = 0.7;
    const hg = mk(ac.createGain()); hg.gain.setValueAtTime(db(-32), now);
    hiss.connect(hbp); hbp.connect(hg); hg.connect(drift);
    hiss.start(now + 0.02, this._rand.range(0, 1));
    this._radioHiss = hiss;

    this._radioOn = true;
    this._radioBeat = 0;
    this._radioNextTime = now + 0.2;
    this._radioNextDrift = now + this._rand.range(30, 90);
    return { stop: (ms) => this.stopRadio(ms) };
  }

  /** Kill the radio. With `click` the set is switched off — one loud click, then nothing. */
  stopRadio(fadeMs = 60, click = true) {
    if (!this._radioOn || !this.ac) return;
    const ac = this.ac;
    const now = ac.currentTime;
    this._radioOn = false;
    if (click && this._radioDest) {
      const src = ac.createBufferSource();
      src.buffer = this._bufWhite;
      const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 3200; f.Q.value = 4;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(0.7, now + 0.001);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);
      src.connect(f); f.connect(g); g.connect(this._radioDest);
      src.start(now + 0.005, 0, 0.02);
      src.onended = () => { try { src.disconnect(); f.disconnect(); g.disconnect(); } catch { /* noop */ } };
    }
    this._radioDrift?.gain.setTargetAtTime(0.0001, now, Math.max(0.004, fadeMs / 3000));
    const kill = now + Math.max(0.1, fadeMs / 1000) + 0.2;
    try { this._radioHiss?.stop(kill); } catch { /* noop */ }

    // Let the fade actually happen before tearing the chain down, or the "off" is a click
    // instead of a decay. The timer is tracked so dispose() can cancel it.
    this._flushRadioNodes();
    this._radioDoomed = this._radioNodes;
    this._radioNodes = [];
    this._radioHiss = null;
    this._radioIn = null;
    this._radioDrift = null;
    this._radioKillTimer = globalThis.setTimeout?.(() => {
      this._radioKillTimer = 0;
      this._flushRadioNodes();
    }, Math.max(120, fadeMs + 260));
  }

  /** Disconnect any radio chain still waiting out its fade. Safe to call repeatedly. */
  _flushRadioNodes() {
    if (this._radioKillTimer) { globalThis.clearTimeout?.(this._radioKillTimer); this._radioKillTimer = 0; }
    if (!this._radioDoomed) return;
    for (const n of this._radioDoomed) { try { n.disconnect?.(); } catch { /* noop */ } }
    this._radioDoomed = null;
  }

  _scheduleRadio(now) {
    const ac = this.ac;
    const bpm = 112, beat = 60 / bpm;

    // The radio is a clock: lights out at timeOfNight 0.55.
    if ((this.ctx?.state?.timeOfNight ?? 0) >= 0.55) { this.stopRadio(30, true); return; }

    // Signal drift: every 30–90 s it dips hard and comes back.
    if (now > this._radioNextDrift && this._radioDrift) {
      this._radioDrift.gain.setTargetAtTime(db(-28), now, 0.25);
      this._radioDrift.gain.setTargetAtTime(db(-14), now + 2.0, 0.5);
      this._radioNextDrift = now + this._rand.range(30, 90);
    }

    if (this._radioNextTime < now - 1) { this._radioNextTime = now + 0.1; this._radioBeat = 0; }

    // I–V–vi–IV in F. Triads, consonance, and a major key — everything the score refuses.
    const CHORDS = [
      { bass: 41, notes: [57, 60] },   // F
      { bass: 36, notes: [55, 64] },   // C
      { bass: 38, notes: [57, 62] },   // Dm
      { bass: 34, notes: [58, 62] },   // Bb
    ];
    const LEAD = [72, 74, 76, 72, 77, 76, 74, 72];

    let guard = 0;
    while (this._radioNextTime < now + LOOKAHEAD && guard++ < 32) {
      const t = this._radioNextTime;
      const b = this._radioBeat;
      const bar = Math.floor(b / 4) % 4;
      const ch = CHORDS[bar];

      if (b % 4 === 0) {
        this._radioTone(t, ch.bass, 'triangle', 0.45, beat * 3.4);
        for (const m of ch.notes) this._radioTone(t, m, 'square', 0.16, beat * 3.2);
      }
      if (b % 2 === 0) this._radioDrum(t, 'kick');
      if (b % 4 === 1 || b % 4 === 3) this._radioDrum(t, 'snare');
      this._radioDrum(t, 'hat');
      this._radioDrum(t + beat * 0.5, 'hat');
      this._radioTone(t, LEAD[b % LEAD.length], 'sawtooth', 0.13, beat * 0.85);

      this._radioBeat++;
      this._radioNextTime += beat;
    }
  }

  _radioTone(t, midi, type, amp, dur) {
    const ac = this.ac;
    if (!this._radioIn) return;
    const when = Math.max(t, ac.currentTime + 0.02);
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(mtof(midi, RADIO_A4_HZ), when);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(amp, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g); g.connect(this._radioIn);
    o.start(when); o.stop(when + dur + 0.05);
    o.onended = () => { try { o.disconnect(); g.disconnect(); } catch { /* noop */ } };
  }

  _radioDrum(t, kind) {
    const ac = this.ac;
    if (!this._radioIn) return;
    const when = Math.max(t, ac.currentTime + 0.02);
    if (kind === 'kick') {
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(120, when);
      o.frequency.exponentialRampToValueAtTime(48, when + 0.08);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(0.6, when + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.18);
      o.connect(g); g.connect(this._radioIn);
      o.start(when); o.stop(when + 0.22);
      o.onended = () => { try { o.disconnect(); g.disconnect(); } catch { /* noop */ } };
      return;
    }
    const src = ac.createBufferSource();
    src.buffer = this._bufWhite;
    const f = ac.createBiquadFilter();
    f.type = kind === 'hat' ? 'highpass' : 'bandpass';
    f.frequency.value = kind === 'hat' ? 7000 : 1900;
    f.Q.value = kind === 'hat' ? 0.7 : 1.2;
    const g = ac.createGain();
    const dur = kind === 'hat' ? 0.035 : 0.12;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(kind === 'hat' ? 0.12 : 0.34, when + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(f); f.connect(g); g.connect(this._radioIn);
    src.start(when, this._rand.range(0, 0.15), dur + 0.02);
    src.onended = () => { try { src.disconnect(); f.disconnect(); g.disconnect(); } catch { /* noop */ } };
  }

  // ------------------------------------------------------------------------- lifecycle

  resize(_w, _h) { /* the score does not care how big the window is */ }

  dispose() {
    this.enabled = false;
    this._disposed = true;              // in-flight fetches/decodes now resolve into nothing
    this.currentMood = 'off';

    if (this._watchdog) { globalThis.clearTimeout?.(this._watchdog); this._watchdog = 0; }
    for (const u of this._unsubs) { try { u?.(); } catch { /* noop */ } }
    this._unsubs.length = 0;
    this._removeResumeHandler();

    try { this.stopRadio(10, false); } catch { /* noop */ }
    this._flushRadioNodes();          // no timer survives dispose()
    this._teardownGraph();

    if (this._ownsContext && this.ac) {
      try { this.ac.close(); } catch { /* noop */ }
    }
    this.ac = null;
    this._dest = null;
    this._bufPink = this._bufWhite = this._bufString = this._bufStringShort = null;
    this._bufMetal = this._bufMetalRev = null;
    this._bedBuffers.clear();
    this._bedFiles.clear();
    this._bedLoading.clear();
    this._bedGate = this._bedMix = this._bedHP = this._bedLP = null;
  }

  _teardownGraph() {
    const t = this.ac ? this.ac.currentTime + 0.01 : 0;

    // Bed voices first: their sources are created outside `_sources` (one per loop, not one
    // per graph) and their gains ARE in `_nodes`, so they must be stopped before the sweep.
    for (const v of this._bedVoices) {
      if (v.src) {
        try { v.src.stop(t); } catch { /* already stopped */ }
        try { v.src.disconnect(); } catch { /* noop */ }
      }
      v.src = null; v.id = ''; v.f = null; v.level = 0; v.stopped = true;
    }
    this._bedVoices.length = 0;
    this._bedCurrent = null;

    for (const s of this._sources) {
      try { s.stop?.(t); } catch { /* already stopped */ }
    }
    this._sources.length = 0;
    for (const n of this._nodes) {
      try { n.disconnect(); } catch { /* noop */ }
    }
    this._nodes.length = 0;
    this._padVoices = [];
    this._bowFilters = [];
    this._bowPartGains = [];
    this._pnoPart = [];
    this._layers = [];
    this._layerById = new Map();
  }
}

export default Music;
