/**
 * VoiceBank — ElevenLabs camper VO, placed in world space.
 *
 * OWNER: Audio agent.  See AUDIO_DIRECTION.md §7, ARCHITECTURE.md §5/§9.
 *
 * ---------------------------------------------------------------------------
 * THE CREATOR'S RULE, WHICH GOVERNS EVERY LINE OF THIS FILE:
 *   "Voice should be an atmosphere addition, in 3d space, not a key star of the game."
 * ---------------------------------------------------------------------------
 *
 * So this is not a dialogue system. It is weather made of people. Lines are placed at the
 * speaking camper's actual world position and are usually heard at the EDGE OF
 * INTELLIGIBILITY. The frightening part is not catching the words — it is *almost* catching
 * them. A fully intelligible line is a scripted event, and there should be at most three of
 * them in a night (AUDIO_DIRECTION §7.1: target ratio 4:1 half-heard to clear).
 *
 * Everything here degrades to silence. `public/audio/vo/` is empty in a fresh clone; that is
 * the DEFAULT state, not an error state. With the whole folder deleted this class sets
 * `available = false`, logs once at debug level, and every public method becomes a silent
 * no-op. The stealth game loses nothing.
 *
 * It also runs standalone: if AudioEngine is missing, still a stub, or failed to init, we
 * build our own suspended AudioContext and our own output gain. Nothing here requires any
 * other system to exist.
 */

import { Log } from '../core/Log.js';
import { Rand } from '../core/Rand.js';

const EMPTY_OPTS = Object.freeze({});

// ---------------------------------------------------------------------------------------
// THE INTELLIGIBILITY CURVE — the core of this file. These numbers ARE the feature.
// ---------------------------------------------------------------------------------------
//
// Every VO source runs through:
//
//   bufferSource → [pre] → [voHP] → [voLP] → [voPresence] → [elev] → [occ] → [smear] → [panner]
//                                                                      └──▶ [verbSend] ──▶ reverb
//
// voLP (lowpass, Q 0.7):          fc = 16000 / (1 + d/3.2)^1.35     (AUDIO_DIRECTION §7.2)
// voHP (highpass, Q 0.7):         fc = 40 + 6.2·d, clamped to 340 Hz
// voPresence (peak 2.6k, Q 1.4):  gain = +4 − 0.22·d dB, floored at −6 dB
//
// Distance is the only parameter a listener consciously reads, so the curve is authored
// against four named bands. Values below are computed from the formulas above, not guessed:
//
//   d(m)   voLP     voHP    presence    I     what the player actually gets
//   ----   ------   -----   --------   ----   ---------------------------------------------
//    0     16.0 k    40 Hz   +4.0 dB   1.00   in the room with them. Never happens in play.
//    4      5.4 k    65 Hz   +3.1 dB   0.85   CLEAR. Every word. Subtitle permitted.
//    8      3.0 k    90 Hz   +2.2 dB   0.69   CLEAR but boxy — a voice through a doorway.
//   12      1.9 k   114 Hz   +1.4 dB   0.54   MOSTLY INTELLIGIBLE. Sense survives; detail doesn't.
//   20      1.1 k   164 Hz   −0.4 dB   0.23   the band tips over. Gist, not words.
//   30      680 Hz  226 Hz   −2.6 dB   0.00   CADENCE. Who it is, what mood, maybe one noun.
//   45      411 Hz  319 Hz   −6.0 dB   0.00   a ~90 Hz window around the first formant:
//                                             a human sound in the trees. Nothing more.
//   60+     290 Hz  340 Hz   −6.0 dB   0.00   lowpass is now BELOW the highpass. Gone.
//
// Note the deliberate asymmetry at range: the lowpass falls fast (chest and body go first)
// while the highpass simultaneously CLIMBS (proximity and warmth are stripped), so a distant
// voice is a thin mid-band artefact, not a muffled close voice. Distant speech loses body
// before it loses sibilance. That is why a shout at 40 m reads as "someone is out there" and
// never as "someone is out there saying words I could get if I concentrated harder".
//
// Occlusion folds into the same lowpass (§3.2: fc = 18000·e^(−0.55·T), gain = −3.2·T dB),
// because AudioEngine cannot occlude a source it does not own.
//
// The intelligibility scalar (§7.2) drives SCHEDULING and SUBTITLES — never gain:
//
//   I = clamp01(1 − d/26) · (1 − 0.55·occN) · (1 − 0.45·wind) · facing
//
//   I  > 0.62            → "clear."       Subtitle permitted, and only here.
//   0.30 < I ≤ 0.62      → half-heard.    NO SUBTITLE. This is the target band.
//   I ≤ 0.30             → presence only. Don't burn scripted content — play bed chatter.
//
const VO_LP_F0 = 16000;      // Hz at d = 0
const VO_LP_D0 = 3.2;        // metres — the knee
const VO_LP_EXP = 1.35;      // steepness
const VO_HP_BASE = 40;       // Hz at d = 0
const VO_HP_PER_M = 6.2;     // Hz per metre
const VO_HP_MAX = 340;       // Hz — never strip past the first formant
const VO_PRESENCE_HZ = 2600;
const VO_PRESENCE_Q = 1.4;
const VO_PRESENCE_DB0 = 4.0;
const VO_PRESENCE_PER_M = 0.22;
const VO_PRESENCE_MIN = -6.0;

const I_CLEAR = 0.62;        // above this a line is "clear" — subtitles allowed
const I_HALF = 0.30;         // below this it is presence only — don't spend scripted lines
const I_RANGE = 26;          // metres at which the distance term of I reaches zero

// Panner (AUDIO_DIRECTION §3.1). VO rolls off SLOWER than world SFX (0.85 vs 1.15) on
// purpose: you should hear campers long before you can understand them.
const VO_REF_DISTANCE = 1.4;
const VO_MAX_DISTANCE = 140;
const VO_ROLLOFF = 0.85;
const VO_CONE_INNER = 90;
const VO_CONE_OUTER = 240;
const VO_CONE_OUTER_GAIN = 0.35;
const HRTF_CUTOFF_M = 45;    // past this, HRTF cues carry no information and cost 4× (§9.3)

// Reverb send rises with distance: a far voice is mostly the room it is standing in. §7.2
const VERB_MIN = 0.12;
const VERB_PER_M = 0.020;
const VERB_MAX = 0.85;

// Per-line pitch/rate jitter, ±2%: a repeated line must never be the same sound twice.
const RATE_JITTER = 0.02;

// THE WIND GATE ("smear"). Active when d > 18 m or wind > 0.4. Every 1/(3 + 5·wind) seconds
// the gain jumps to a new random value in [0.35, 1.0] over a 50 ms glide. This is what makes
// a distant conversation come and go — words drop out, sentences arrive in fragments — and
// AUDIO_DIRECTION calls it the single most important VO processing decision in the game.
// Driven by Materials.globalUniforms.uWind so voices tear on the same gusts that bend the
// trees you can see.
const SMEAR_MIN_DIST = 18;
const SMEAR_MIN_WIND = 0.4;
const SMEAR_FLOOR = 0.35;
const SMEAR_GLIDE = 0.05;

// Occlusion analytic fallback for when nothing can query the world for us: expect to cross
// roughly one pine trunk per 9 m of forest path, and a trunk is 0.35 "effective metres"
// (§3.2 table). We never raycast — the whole game gets 12 rays a frame and VO is not
// entitled to any of them.
const TRUNK_EFFECTIVE_M = 0.35;
const METRES_PER_TRUNK = 9;
const DEFAULT_FOREST_DENSITY = 0.6;
const OCC_MAX_T = 5.0;       // clamp; three walls of the finished cabin is about 3.6

// ---------------------------------------------------------------------------------------
// SCHEDULING — long silences are correct.
// ---------------------------------------------------------------------------------------
//
// A token bucket governs autonomous chatter. One CONVERSATION (1–4 turns) costs one token.
// Capacity 2, refilling one per 30 s ⇒ a long-run ceiling of ~2 conversations per minute
// across the ENTIRE camp, with room for one short burst followed by real silence. That is
// the whole budget. It is meant to feel sparse. If the camp ever sounds chatty, this number
// is wrong, not the mix.
const CONV_BUCKET_CAP = 2;
const CONV_REFILL_S = 30;
const CONV_MIN_GAP_S = 18;        // floor between conversation starts regardless of tokens
const CAMPER_COOLDOWN_S = 16;     // a camper who just spoke shuts up for this long
const GLOBAL_LINE_GAP_S = 1.2;    // floor between ANY two line starts outside a conversation
const TURN_GAP_MIN_MS = 180;      // §7.3 turn-taking
const TURN_GAP_JIT_MS = 240;
const OVERLAP_CHANCE = 0.12;      // §7.3 — natural latching, not talking over each other
const OVERLAP_MS = 250;
const ARGUE_OVERLAP_CHANCE = 0.45;// arguments are the ONLY time campers genuinely collide
const ARGUE_OVERLAP_MAX_MS = 700;
const AZIMUTH_MIN_DEG = 20;       // §7.3 — never two active speakers this close in azimuth
const LISTEN_HUSH_MIN_S = 2.5;    // after a priority-3 line, the camp stops and listens
const LISTEN_HUSH_MAX_S = 4.0;
const GROUP_RADIUS_M = 14;        // campers this close to each other can form a conversation
const MAX_CONVERSATIONS = 2;      // §7.3 hard cap
const MAX_TURNS = 4;
const SPEAKERS_PER_CONV = 4;

// Priority 0..3. Three is never denied a slot and never queued: it is the game telling the
// player something important through the world, and it outranks every atmosphere concern.
const CATEGORY_PRIORITY = {
  idle: 1, call: 2, campfire: 1, argue: 1, heard: 3, search: 2,
  falsealarm: 2, evidence: 2, fear: 3, late: 2, murmur: 0,
};

// STORY.md §6 uses one vocabulary, tools/generate-voices.mjs another, AUDIO_DIRECTION §7.4 a
// third. Normalise all of them, and fall back to parsing the id (`ROB_HEAR_01` → heard).
const CATEGORY_ALIASES = {
  idle: 'idle', chatter: 'idle', ambient: 'idle', bed: 'idle', murmur: 'murmur',
  call: 'call', call_name: 'call', callname: 'call', shout: 'call',
  campfire: 'campfire', fire: 'campfire', fireside: 'campfire',
  argue: 'argue', arg: 'argue', argument: 'argue',
  heard: 'heard', hear: 'heard', notice: 'heard', notice_low: 'heard',
  notice_high: 'heard', construction: 'heard',
  search: 'search', srch: 'search', searching: 'search',
  falsealarm: 'falsealarm', false: 'falsealarm', dismiss: 'falsealarm', falarm: 'falsealarm',
  evidence: 'evidence', evid: 'evidence',
  fear: 'fear', scared: 'fear', panic: 'fear',
  late: 'late', endgame: 'late',
};

// Categories cheap enough to spend at I ≤ 0.30, where nothing scripted would survive anyway.
const BED_CATEGORIES = ['murmur', 'idle', 'campfire', 'argue'];

// Topic weighting by camp-wide suspicion. Preallocated — the scheduler must not allocate.
const TOPICS_CALM = ['idle', 'campfire', 'call', 'argue'];
const WEIGHTS_CALM = [6, 3, 2, 1];
const TOPICS_UNEASY = ['idle', 'heard', 'falsealarm', 'call', 'argue'];
const WEIGHTS_UNEASY = [3, 3, 2, 2, 1];
const TOPICS_ALERT = ['search', 'heard', 'call', 'evidence', 'falsealarm'];
const WEIGHTS_ALERT = [4, 3, 2, 1, 1];
const TOPICS_LATE = ['fear', 'late', 'search', 'evidence'];
const WEIGHTS_LATE = [3, 3, 2, 1];

// The manifest is mp3_44100_128 ⇒ a constant 16000 bytes per second of audio. Used to plan
// turn timing before a buffer has finished decoding.
const BYTES_PER_SECOND = 16000;

// ---------------------------------------------------------------------------------------
// Module-scope scratch. ARCHITECTURE.md §12: no allocation in update().
// ---------------------------------------------------------------------------------------
const _lisPos = { x: 0, y: 1.7, z: 0 };
const _lisFwd = { x: 0, y: 0, z: -1 };
const _lisUp = { x: 0, y: 1, z: 0 };
const _tmpVec = { x: 0, y: 0, z: 0 };
const _tmpVec2 = { x: 0, y: 0, z: 0 };

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

/** Read {x,y,z} from a THREE.Vector3, a plain object, or an Object3D. Never allocates. */
function readVec(src, out) {
  if (!src || typeof src !== 'object') return false;
  if (typeof src.x === 'number' && typeof src.z === 'number') {
    out.x = src.x; out.y = typeof src.y === 'number' ? src.y : 0; out.z = src.z;
    return true;
  }
  const p = src.position;
  if (p && typeof p.x === 'number' && typeof p.z === 'number') {
    out.x = p.x; out.y = typeof p.y === 'number' ? p.y : 0; out.z = p.z;
    return true;
  }
  return false;
}

function dist(ax, ay, az, bx, by, bz) {
  const dx = ax - bx, dy = ay - by, dz = az - bz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Base URL for VO assets. Honours Vite's `base` so a subpath deploy still finds the files. */
function voUrl(rel) {
  let base = '/';
  try { base = import.meta.env?.BASE_URL ?? '/'; } catch { /* non-Vite host */ }
  if (!base.endsWith('/')) base += '/';
  const href = globalThis.location?.href ?? 'http://localhost/';
  try { return new URL(`${base}audio/vo/${rel}`, href).href; }
  catch { return `${base}audio/vo/${rel}`; }
}

function normCategory(raw, id) {
  if (raw) {
    const k = String(raw).toLowerCase().replace(/[^a-z_]/g, '');
    if (CATEGORY_ALIASES[k]) return CATEGORY_ALIASES[k];
  }
  // `ROB_HEAR_01` → HEAR → heard.
  const m = /^[A-Za-z]+_([A-Za-z]+)/.exec(String(id ?? ''));
  if (m) {
    const k = m[1].toLowerCase();
    if (CATEGORY_ALIASES[k]) return CATEGORY_ALIASES[k];
  }
  return 'idle';
}

function normSpeaker(raw, id) {
  if (raw) return String(raw).toLowerCase().trim();
  const m = /^([A-Za-z]+)_/.exec(String(id ?? ''));
  return m ? m[1].toLowerCase() : 'unknown';
}

// ---------------------------------------------------------------------------------------

export class VoiceBank {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx?.bus ?? null;

    /** False until a manifest with at least one playable line is loaded. Public contract. */
    this.available = false;

    this.actx = null;
    this._ownsContext = false;
    this._busOwned = true;
    this._disposed = false;

    // Line table, built from the manifest and enriched from Script.js when it exists.
    this._lines = new Map();          // id -> entry
    this._byCategory = new Map();     // category -> [id]
    this._bySpeakerCat = new Map();   // `${speaker}|${category}` -> [id]
    this._speakers = [];

    // Decoded-buffer LRU + in-flight dedupe. We NEVER preload the bank.
    this._buffers = new Map();
    this._loading = new Map();
    this._failed = new Set();
    this._cacheMax = 12;

    // Voice slots: persistent subgraphs; only the source node is recreated per play (§9.1).
    this._slots = [];
    this._serial = 0;
    this._timers = new Set();

    this._voOut = null;
    this._verbSend = null;

    // Scheduling.
    this._rand = new Rand(0x561ce);
    this._convs = [];
    this._camperNextAt = new Map();
    this._usedThisNight = new Set();
    this._heardClear = new Set();     // ids ever heard at I > 0.62 — never clear again (§7.3)
    this._tokens = CONV_BUCKET_CAP;
    this._tokenAcc = 0;
    this._nextConvAt = 0;
    this._globalNextAt = 0;
    this._silenceUntil = 0;           // §8 silence rules — outranks everything
    this._chatterUntil = 0;           // the camp is listening — blocks priority < 3 only
    this._warmNextAt = 0;
    this._hardStopped = false;

    // World sampling.
    this._campers = [];
    this._camperCount = 0;
    this._camperPollAcc = 0;
    this._wind = 0;
    this._globalUniforms = null;
    this._driveListener = true;
    this._occFn = null;
    this._occOwner = null;
    this._occProbedAt = -1e9;

    this._schedAcc = 0;
    this._pausedAt = 0;

    this._unsubs = [];
    this._resumeHandler = null;
    this._Script = null;

    this.stats = { played: 0, clear: 0, halfHeard: 0, denied: 0, subtitles: 0 };
  }

  // ------------------------------------------------------------------- lifecycle

  async init() {
    if (this._disposed) return;

    // 1. The manifest. Missing or empty is the DEFAULT state of a fresh clone, not an error.
    //    Debug level only: this must never look like something went wrong, because nothing did.
    const manifest = await this._fetchManifest();
    if (!manifest) {
      Log.debug('VoiceBank: no VO manifest — voice disabled, game unaffected.');
      return;
    }

    // 2. Story data is optional and may still be a stub. Guarded dynamic import so a broken
    //    or half-written Script.js can never take audio down.
    this._Script = await this._loadScript();

    this._buildIndex(manifest);
    if (this._lines.size === 0) {
      Log.debug('VoiceBank: VO manifest lists no lines — voice disabled.');
      return;
    }

    // 3. An AudioContext — AudioEngine's if it has one, otherwise ours.
    this.actx = this._acquireContext();
    if (!this.actx) {
      Log.debug('VoiceBank: no WebAudio context available — voice disabled.');
      return;
    }

    this._buildOutput();
    this._buildSlots();
    this._buildConversations();
    this._bindEvents();
    this._pickUniforms();

    this._rand.seed((this.ctx?.settings?.get?.('seed') ?? 0x51a5cab) ^ 0x561ce);
    this._nextConvAt = this.actx.currentTime + 6;
    this.available = true;

    Log.debug(`VoiceBank: ${this._lines.size} lines / ${this._speakers.length} speakers / ` +
      `${this._slots.length} slots / ${this._ownsContext ? 'own' : 'shared'} context.`);
  }

  update(dt) {
    if (!this.available || this._disposed) return;
    const a = this.actx;
    if (!a) return;
    const now = a.currentTime;

    this._readListener();
    if (this._driveListener) this._applyListener(now);
    this._pollWind();

    // Per-slot tracking. At most 4 slots ever exist, so this is bounded, tiny work.
    for (let i = 0; i < this._slots.length; i++) {
      const s = this._slots[i];
      if (s.busy) this._updateSlot(s, now, dt);
    }

    // Scheduler at 10 Hz. Conversation timing does not need frame resolution.
    this._schedAcc += dt;
    if (this._schedAcc >= 0.1) {
      const acc = this._schedAcc;
      this._schedAcc = 0;
      this._tick(now, acc);
    }
  }

  resize(_w, _h) { /* no DOM, no render targets */ }

  dispose() {
    this._disposed = true;
    this.available = false;

    for (let i = 0; i < this._unsubs.length; i++) {
      try { this._unsubs[i](); } catch { /* already unsubscribed */ }
    }
    this._unsubs.length = 0;

    if (this._resumeHandler) {
      try {
        globalThis.removeEventListener?.('pointerdown', this._resumeHandler);
        globalThis.removeEventListener?.('keydown', this._resumeHandler);
        globalThis.removeEventListener?.('touchstart', this._resumeHandler);
      } catch { /* non-browser */ }
      this._resumeHandler = null;
    }

    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();

    for (let i = 0; i < this._slots.length; i++) this._teardownSlot(this._slots[i]);
    this._slots.length = 0;

    try { this._voOut?.disconnect(); } catch { /* already disconnected */ }
    this._voOut = null;
    this._verbSend = null;

    this._buffers.clear();
    this._loading.clear();
    this._failed.clear();
    this._lines.clear();
    this._byCategory.clear();
    this._bySpeakerCat.clear();
    this._camperNextAt.clear();
    this._usedThisNight.clear();
    this._heardClear.clear();
    this._convs.length = 0;
    this._campers.length = 0;
    this._speakers.length = 0;
    this._globalUniforms = null;
    this._occFn = null;
    this._occOwner = null;
    this._Script = null;

    if (this._ownsContext && this.actx) {
      const a = this.actx;
      this.actx = null;
      try { a.close?.(); } catch { /* already closed */ }
    } else {
      this.actx = null;
    }
  }

  // ------------------------------------------------------------------- public API

  /**
   * Play one specific line at a world position.
   *
   *   say('ROB_HEAR_01', camper.position)
   *   say('ROB_HEAR_01', { position, speaker, priority, volume, facing, force })
   *
   * The second form matches AUDIO_DIRECTION §9.5 (`say(lineId, { position, speaker })`), the
   * first matches this module's own contract. Both are accepted so no caller has to know
   * about the other.
   *
   * @returns {object|null} an opaque handle, or null if nothing was scheduled.
   */
  say(lineId, position, opts) {
    if (!this.available || this._disposed || this._hardStopped) return null;

    // Disambiguate: a real position has a numeric .x; anything else object-shaped is opts
    // (and an Object3D passed as `position` still resolves through its own `.position`).
    let pos = null;
    let o = EMPTY_OPTS;
    if (position && typeof position.x === 'number') {
      pos = position;
      o = (opts && typeof opts === 'object') ? opts : EMPTY_OPTS;
    } else if (position && typeof position === 'object') {
      o = position;
      pos = position.position ?? position.pos ?? null;
    } else if (opts && typeof opts === 'object') {
      o = opts;
      pos = opts.position ?? null;
    }

    const entry = this._lines.get(lineId);
    if (!entry) { this.stats.denied++; return null; }

    this._readListener();
    return this._request(entry, pos, o);
  }

  /**
   * Pick a line in `category` (optionally for a specific camper) and place it at `position`.
   * This is what gameplay should call. It never repeats a line within a night, and it will
   * silently decline if the camp has already said enough — declining is a valid answer and
   * happens often by design.
   */
  sayCategory(category, position, camperId, opts) {
    if (!this.available || this._disposed || this._hardStopped) return null;

    this._readListener();
    const o = (opts && typeof opts === 'object') ? opts : EMPTY_OPTS;
    const cat = normCategory(category, null);
    const speaker = camperId ? String(camperId).toLowerCase() : null;

    // Intelligibility is evaluated BEFORE choosing. At I ≤ 0.30 nothing scripted survives the
    // filters, so spending a story line there would burn it for nothing (§7.3). Drop to the
    // bed pool instead — that is what the generic murmur takes are for.
    const I = this._estimateI(position, o.facing);
    const wantBed = I <= I_HALF && BED_CATEGORIES.indexOf(cat) < 0;

    const entry = wantBed
      ? (this._pickLine(this._bedCategoryFor(speaker), speaker, true)
        ?? this._pickLine(cat, speaker, true))
      : this._pickLine(cat, speaker, true);

    if (!entry) { this.stats.denied++; return null; }
    return this._request(entry, position, o);
  }

  /** True while `camperId` has a line actually sounding. */
  isSpeaking(camperId) {
    if (!this.available || !camperId) return false;
    const key = String(camperId).toLowerCase();
    for (let i = 0; i < this._slots.length; i++) {
      const s = this._slots[i];
      if (s.busy && s.speaker === key) return true;
    }
    return false;
  }

  /**
   * Start a conversation between named campers. AUDIO_DIRECTION §9.5.
   * `speakers` is an array of camper ids (1–4); `position` is the group centre, used only for
   * campers the Campers system cannot locate for us.
   */
  conversation(topicId, speakers, position) {
    if (!this.available || this._disposed || this._hardStopped) return null;
    if (!Array.isArray(speakers) || speakers.length === 0) return null;

    const conv = this._freeConversation();
    if (!conv) return null;

    this._collectCampers(true);
    conv.count = 0;
    for (let i = 0; i < speakers.length && conv.count < SPEAKERS_PER_CONV; i++) {
      const id = String(speakers[i]).toLowerCase();
      const c = this._findCamper(id);
      const p = conv.pos[conv.count];
      if (c) { p.x = c.x; p.y = c.y; p.z = c.z; }
      else if (!readVec(position, p)) { p.x = _lisPos.x; p.y = 1.6; p.z = _lisPos.z; }
      conv.ids[conv.count] = id;
      conv.count++;
    }
    if (conv.count === 0) return null;

    this._openConversation(conv, normCategory(topicId, null), this.actx.currentTime);
    return conv;
  }

  /**
   * Gate VO for `ms` milliseconds. AUDIO_DIRECTION §8: VO stops entirely during any silence
   * rule except S9 (the pause). AudioEngine owns the silence stack and should call this;
   * VoiceBank also arms it from the canonical events it can observe on its own.
   */
  holdVoice(ms, reason) {
    if (!this.actx) return;
    const until = this.actx.currentTime + Math.max(0, ms) / 1000;
    if (until > this._silenceUntil) this._silenceUntil = until;
    if (reason) Log.debug(`VoiceBank: silence ${ms | 0}ms (${reason})`);
  }

  /** Fade out everything currently sounding and abandon every planned turn. */
  stopAll(fadeMs = 120) {
    for (let i = 0; i < this._slots.length; i++) {
      if (this._slots[i].busy) this._stopSlot(this._slots[i], fadeMs);
    }
    for (let i = 0; i < this._convs.length; i++) this._closeConversation(this._convs[i]);
  }

  /**
   * The camp stops talking and listens. Called automatically whenever a priority-3 line
   * fires, because after somebody says "did you hear that?" the correct next sound is
   * nothing at all.
   */
  interrupt(reason) {
    if (!this.available || !this.actx) return;
    for (let i = 0; i < this._convs.length; i++) this._closeConversation(this._convs[i]);
    const now = this.actx.currentTime;
    if (this._nextConvAt < now + CONV_MIN_GAP_S) this._nextConvAt = now + CONV_MIN_GAP_S;
    if (reason) Log.debug(`VoiceBank: interrupted (${reason})`);
  }

  // ------------------------------------------------------------------- loading

  async _fetchManifest() {
    let res;
    try {
      res = await fetch(voUrl('manifest.json'), { cache: 'force-cache' });
    } catch {
      return null;                     // offline, file://, CSP — silent and expected
    }
    if (!res || !res.ok) return null;

    // Vite's dev server answers unknown paths with index.html. Refuse to parse HTML as JSON.
    const type = res.headers?.get?.('content-type') ?? '';
    if (type && type.indexOf('json') < 0) return null;

    let json;
    try { json = await res.json(); } catch { return null; }

    const lines = Array.isArray(json) ? json : (Array.isArray(json?.lines) ? json.lines : null);
    if (!lines || lines.length === 0) return null;
    return lines;
  }

  async _loadScript() {
    try {
      const mod = await import('../story/Script.js');
      return mod?.Script ?? mod?.default ?? null;
    } catch {
      return null;                     // the Story agent has not written it yet
    }
  }

  _buildIndex(manifestLines) {
    // Script.voiceLines supplies `text` (which the manifest may omit) and optionally
    // `priority` / `clearOK` / `night`.
    const scriptById = new Map();
    const sv = this._Script?.voiceLines;
    if (Array.isArray(sv)) {
      for (let i = 0; i < sv.length; i++) {
        const l = sv[i];
        if (l && l.id) scriptById.set(l.id, l);
      }
    }

    for (let i = 0; i < manifestLines.length; i++) {
      const m = manifestLines[i];
      if (!m || !m.id) continue;
      const s = scriptById.get(m.id) ?? null;

      const category = normCategory(m.category ?? s?.category, m.id);
      const speaker = normSpeaker(m.speaker ?? s?.speaker, m.id);
      const bytes = Number.isFinite(m.bytes) ? m.bytes : 0;

      const entry = {
        id: m.id,
        speaker,
        category,
        text: (s?.text ?? m.text ?? '') || '',
        // Duration before decode: the manifest is the only source we have, and at a constant
        // 128 kbps bytes/16000 is accurate to a frame or two — all the turn scheduler needs.
        estDur: Number.isFinite(m.duration) ? m.duration
          : (bytes > 0 ? bytes / BYTES_PER_SECOND : 2.0),
        dur: 0,
        priority: Number.isFinite(s?.priority) ? s.priority
          : (Number.isFinite(m.priority) ? m.priority : (CATEGORY_PRIORITY[category] ?? 1)),
        // `clearOK: false` marks a line that must never play fully intelligible.
        clearOK: (s?.clearOK ?? m.clearOK) !== false,
      };

      this._lines.set(entry.id, entry);

      let byCat = this._byCategory.get(category);
      if (!byCat) { byCat = []; this._byCategory.set(category, byCat); }
      byCat.push(entry.id);

      const key = `${speaker}|${category}`;
      let bySc = this._bySpeakerCat.get(key);
      if (!bySc) { bySc = []; this._bySpeakerCat.set(key, bySc); }
      bySc.push(entry.id);

      if (this._speakers.indexOf(speaker) < 0) this._speakers.push(speaker);
    }

    this._cacheMax = this.ctx?.settings?.tier?.(6, 10, 14, 18) ?? 12;
  }

  /** Lazy fetch + decode behind a small LRU. */
  _ensureBuffer(id) {
    const hit = this._buffers.get(id);
    if (hit) {
      this._buffers.delete(id);        // refresh LRU position
      this._buffers.set(id, hit);
      return Promise.resolve(hit);
    }
    if (this._failed.has(id)) return Promise.resolve(null);
    const inFlight = this._loading.get(id);
    if (inFlight) return inFlight;

    const p = (async () => {
      try {
        const res = await fetch(voUrl(`${id}.mp3`), { cache: 'force-cache' });
        if (!res.ok) throw new Error(String(res.status));
        const raw = await res.arrayBuffer();
        if (this._disposed || !this.actx) return null;
        const decoded = await this.actx.decodeAudioData(raw);
        const buf = await this._toMono24k(decoded);
        if (this._disposed) return null;

        this._buffers.set(id, buf);
        while (this._buffers.size > this._cacheMax) {
          const oldest = this._buffers.keys().next().value;
          if (oldest === undefined || oldest === id) break;
          this._buffers.delete(oldest);
        }
        const entry = this._lines.get(id);
        if (entry) entry.dur = buf.duration;
        return buf;
      } catch (e) {
        // One failure is enough. Never retry in a loop; a missing file is a valid state.
        this._failed.add(id);
        Log.debug(`VoiceBank: line '${id}' unavailable (${e?.message ?? e})`);
        return null;
      } finally {
        this._loading.delete(id);
      }
    })();

    this._loading.set(id, p);
    return p;
  }

  /**
   * Downsample to 24 kHz mono. Nothing survives the distance chain above ~5 kHz, so this is
   * free in perceptual terms and quarters the memory of the whole bank (§7.4).
   */
  async _toMono24k(buf) {
    const OAC = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
    if (!OAC) return buf;
    if (buf.sampleRate <= 24000 && buf.numberOfChannels === 1) return buf;
    try {
      const frames = Math.max(1, Math.ceil(buf.duration * 24000));
      const oac = new OAC(1, frames, 24000);
      const src = oac.createBufferSource();
      src.buffer = buf;
      src.connect(oac.destination);
      src.start(0);
      return await oac.startRendering();
    } catch {
      return buf;                      // some engines refuse odd rates — not worth failing over
    }
  }

  // ------------------------------------------------------------------- audio graph

  _acquireContext() {
    const audio = this.ctx?.systems?.get?.('Audio');
    // AudioEngine does not publish a context accessor in ARCHITECTURE.md, so probe the
    // plausible names. TODO(api): AudioEngine should expose `audioCtx`.
    const shared = audio?.audioCtx ?? audio?.actx ?? audio?.context ?? audio?.audioContext ?? null;
    if (shared && typeof shared.createGain === 'function') {
      this._ownsContext = false;
      // If AudioEngine drives the listener we must not fight it. If it does not (it may still
      // be a stub), we drive it — a panner against a listener stuck at the origin is not 3D
      // audio at all, and this file's entire job is 3D placement.
      this._driveListener = audio?.drivesListener !== true;
      return shared;
    }

    const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AC) return null;
    let a;
    try { a = new AC({ latencyHint: 'interactive' }); } catch { return null; }
    this._ownsContext = true;
    this._driveListener = true;

    // Autoplay policy (§9.4): contexts start suspended. Resume on the first gesture, once.
    if (a.state === 'suspended') {
      this._resumeHandler = () => {
        try { a.resume?.()?.catch?.(() => {}); } catch { /* already running */ }
        const h = this._resumeHandler;
        if (!h) return;
        this._resumeHandler = null;
        globalThis.removeEventListener?.('pointerdown', h);
        globalThis.removeEventListener?.('keydown', h);
        globalThis.removeEventListener?.('touchstart', h);
      };
      try {
        globalThis.addEventListener?.('pointerdown', this._resumeHandler, { passive: true });
        globalThis.addEventListener?.('keydown', this._resumeHandler, { passive: true });
        globalThis.addEventListener?.('touchstart', this._resumeHandler, { passive: true });
      } catch { /* non-browser */ }
    }
    return a;
  }

  _buildOutput() {
    const a = this.actx;
    this._voOut = a.createGain();

    const audio = this.ctx?.systems?.get?.('Audio');
    let dest = null;
    try { dest = (typeof audio?.bus === 'function') ? audio.bus('vo') : null; } catch { dest = null; }

    if (dest && typeof dest.connect === 'function') {
      // AudioEngine's `vo` bus already applies settings.voiceVolume — do not double-apply.
      this._busOwned = false;
      this._voOut.gain.value = 1;
      this._voOut.connect(dest);
    } else {
      this._busOwned = true;
      this._voOut.gain.value = this._voGain();
      this._voOut.connect(a.destination);
    }

    // Reverb send. AudioEngine owns the convolvers; probe for an input we may feed.
    // TODO(api): a documented `AudioEngine.reverbSend()` would remove this guesswork. With
    // no send available we simply run dry — drier than ideal, never broken.
    this._verbSend = this._probeNode(audio, ['voiceReverbSend', 'reverbSend', 'reverbInput', 'verbIn'])
      ?? this._probeBus(audio, ['verbSend', 'reverb', 'sendA']);
  }

  _probeNode(obj, names) {
    if (!obj) return null;
    for (let i = 0; i < names.length; i++) {
      try {
        const v = obj[names[i]];
        const n = typeof v === 'function' ? v.call(obj) : v;
        if (n && typeof n.connect === 'function') return n;
      } catch { /* keep probing */ }
    }
    return null;
  }

  _probeBus(obj, names) {
    if (!obj || typeof obj.bus !== 'function') return null;
    for (let i = 0; i < names.length; i++) {
      try {
        const n = obj.bus(names[i]);
        if (n && typeof n.connect === 'function') return n;
      } catch { /* keep probing */ }
    }
    return null;
  }

  _voGain() {
    const s = this.ctx?.settings;
    const master = s?.get?.('masterVolume') ?? 0.9;
    const voice = s?.get?.('voiceVolume') ?? 0.85;
    return clamp(master * voice, 0, 2);
  }

  _buildSlots() {
    const a = this.actx;
    const s = this.ctx?.settings;
    // §7.3: max 4 concurrent VO voices, hard cap. Fewer on low tiers — HRTF panners are the
    // second most expensive thing in the graph after the convolvers (§9.3).
    const count = clamp(s?.tier?.(2, 3, 4, 4) ?? 4, 1, 4);
    const hrtf = (s?.tierIndex ?? 3) >= 2;

    for (let i = 0; i < count; i++) {
      const pre = a.createGain();
      pre.gain.value = 0.0001;

      const hp = a.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = VO_HP_BASE; hp.Q.value = 0.7;

      const lp = a.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = VO_LP_F0; lp.Q.value = 0.7;

      const pres = a.createBiquadFilter();
      pres.type = 'peaking';
      pres.frequency.value = VO_PRESENCE_HZ;
      pres.Q.value = VO_PRESENCE_Q;
      pres.gain.value = VO_PRESENCE_DB0;

      // Fake elevation: WebAudio's HRTF has almost no elevation cue, a shelf reads better (§3.1).
      const elev = a.createBiquadFilter();
      elev.type = 'highshelf'; elev.frequency.value = 7000; elev.gain.value = 0;

      // Occlusion attenuation lives on its own node so the wind gate can modulate freely
      // without stomping it, and so the reverb send is taken POST-occlusion, PRE-gate: the
      // direct sound punches in and out on the gusts while the room tail stays put.
      const occ = a.createGain();
      occ.gain.value = 1;

      const smear = a.createGain();
      smear.gain.value = 1;

      const panner = a.createPanner();
      panner.panningModel = hrtf ? 'HRTF' : 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = VO_REF_DISTANCE;
      panner.maxDistance = VO_MAX_DISTANCE;
      panner.rolloffFactor = VO_ROLLOFF;
      panner.coneInnerAngle = 360;         // disabled until a facing vector is known
      panner.coneOuterAngle = 360;
      panner.coneOuterGain = 1;

      const send = a.createGain();
      send.gain.value = VERB_MIN;

      pre.connect(hp); hp.connect(lp); lp.connect(pres); pres.connect(elev);
      elev.connect(occ); occ.connect(smear); smear.connect(panner);
      panner.connect(this._voOut);
      if (this._verbSend) { occ.connect(send); send.connect(this._verbSend); }

      this._slots.push({
        pre, hp, lp, pres, elev, occ, smear, panner, send,
        src: null, serial: 0, busy: false,
        id: null, speaker: null, entry: null,
        x: 0, y: 1.6, z: 0,
        fx: 0, fy: 0, fz: -1, hasFacing: false,
        gain: 1, priority: 1, startedAt: 0, endsAt: 0,
        paramAcc: 0, gated: false, smearNext: 0,
        hrtfNow: hrtf, hrtfPreferred: hrtf,
      });
    }
  }

  _buildConversations() {
    for (let i = 0; i < MAX_CONVERSATIONS; i++) {
      const conv = {
        active: false, arguing: false, category: 'idle',
        ids: new Array(SPEAKERS_PER_CONV).fill(null),
        pos: [],
        turn: 0, turns: 0, count: 0, nextAt: 0, retries: 0,
      };
      for (let k = 0; k < SPEAKERS_PER_CONV; k++) conv.pos.push({ x: 0, y: 1.6, z: 0 });
      this._convs.push(conv);
    }
  }

  _teardownSlot(s) {
    if (!s) return;
    if (s.src) {
      try { s.src.onended = null; s.src.stop(); } catch { /* already stopped */ }
      try { s.src.disconnect(); } catch { /* already disconnected */ }
      s.src = null;
    }
    const nodes = [s.pre, s.hp, s.lp, s.pres, s.elev, s.occ, s.smear, s.panner, s.send];
    for (let i = 0; i < nodes.length; i++) {
      try { nodes[i]?.disconnect(); } catch { /* already disconnected */ }
    }
    s.busy = false;
    s.entry = null;
  }

  // ------------------------------------------------------------------- events

  _bindEvents() {
    const on = (evt, fn) => { const u = this.bus?.on?.(evt, fn); if (u) this._unsubs.push(u); };

    // Canonical: anyone may ask for a line. ARCHITECTURE.md §5.
    on('audio:vo', (p) => {
      if (!p) return;
      if (p.id) this.say(p.id, p.position, p);
      else if (p.category) this.sayCategory(p.category, p.position, p.speaker ?? p.camperId, p);
    });

    on('game:start', () => { this._hardStopped = false; this._resetNight(); });

    on('night:begin', () => {
      this._hardStopped = false;
      this._resetNight();
      // S1: the night opens on 2.2 s of absolute silence, then a 6 s staggered bed fade-in.
      // A camper talking into that hole would destroy it, so VO waits out the whole arrival.
      this.stopAll(60);
      this.holdVoice(9000, 'S1 the first breath of the night');
    });

    on('night:complete', () => { this.stopAll(400); this.holdVoice(8000, 'night complete'); });

    on('night:failed', () => {
      // S7: hard mute on the frame it fires. Nothing speaks again until a night begins.
      this._hardStopped = true;
      this.stopAll(0);
      this.holdVoice(60000, 'S7 the end');
    });

    on('build:stage-complete', () => {
      // S6: 1.4 s of complete silence, then the manual's chime alone in a room that does not
      // exist, then 1.8 s back. The joke is that nothing in the world reacts to it — least of
      // all a person. Do not let a camper speak across the funniest silence in the game.
      this.stopAll(80);
      this.holdVoice(3400, 'S6 the clinical pause');
    });

    on('build:place', (p) => {
      // S3: the naked creak has to arrive into a vacuum.
      if (p && p.correct === false) { this.stopAll(90); this.holdVoice(1200, 'S3 naked creak'); }
    });

    on('build:creak', (p) => {
      // A tier-3 creak stops the camp mid-sentence. They are listening now, and their silence
      // says more about what the player just did than any line could.
      const sev = p?.severity ?? 0;
      if (sev >= 0.5) { this.stopAll(120); this.holdVoice(1500 + 2000 * sev, 'creak'); }
    });

    on('weather:change', (p) => {
      if (p && Number.isFinite(p.wind)) this._wind = clamp01(p.wind);
    });

    on('game:pause', () => { this._pausedAt = this.actx?.currentTime ?? 0; });

    on('game:resume', () => {
      // Engine does not call update() while paused, but the audio clock keeps running. Without
      // this, every pending turn would be overdue on resume and the camp would erupt at once.
      const a = this.actx;
      if (!a || !this._pausedAt) return;
      const delta = a.currentTime - this._pausedAt;
      this._pausedAt = 0;
      if (delta <= 0) return;
      this._nextConvAt += delta;
      this._globalNextAt += delta;
      this._silenceUntil += delta;
      this._chatterUntil += delta;
      for (const [k, v] of this._camperNextAt) this._camperNextAt.set(k, v + delta);
      for (let i = 0; i < this._convs.length; i++) {
        if (this._convs[i].active) this._convs[i].nextAt += delta;
      }
    });

    on('settings:changed', (p) => {
      if (!this._busOwned || !this._voOut || !this.actx) return;
      if (p && p.key !== 'masterVolume' && p.key !== 'voiceVolume' && p.key !== '*') return;
      const g = this._voOut.gain;
      const now = this.actx.currentTime;
      try {
        if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(now);
        g.setTargetAtTime(this._voGain(), now, 0.05);
      } catch { /* param in a terminal state */ }
    });
  }

  _resetNight() {
    this._usedThisNight.clear();
    this._camperNextAt.clear();
    this._tokens = CONV_BUCKET_CAP;
    this._tokenAcc = 0;
    const now = this.actx?.currentTime ?? 0;
    this._nextConvAt = now + CONV_MIN_GAP_S;
    this._globalNextAt = now;
    this._chatterUntil = 0;
    for (let i = 0; i < this._convs.length; i++) this._closeConversation(this._convs[i]);
  }

  // ------------------------------------------------------------------- world sampling

  _pickUniforms() {
    const mats = this.ctx?.systems?.get?.('Materials');
    const gu = mats?.globalUniforms;
    if (gu && typeof gu === 'object') { this._globalUniforms = gu; return; }
    // Materials also publishes globalUniforms as a module/static export; guarded so a stub
    // or a throwing module cannot break audio.
    import('../render/Materials.js')
      .then((m) => {
        if (this._disposed) return;
        const g = m?.Materials?.globalUniforms ?? m?.globalUniforms ?? null;
        if (g && typeof g === 'object') this._globalUniforms = g;
      })
      .catch(() => { /* the Materials agent has not written it yet */ });
  }

  /**
   * Wind 0..1. Prefer Materials.globalUniforms.uWind — that is what the trees are actually
   * bending to, so voices are carried and torn away on the same gusts the player can see —
   * and fall back to the last weather:change payload.
   */
  _pollWind() {
    const u = this._globalUniforms?.uWind;
    if (u === undefined || u === null) return;
    const v = (u && typeof u === 'object' && 'value' in u) ? u.value : u;
    if (typeof v === 'number') {
      if (Number.isFinite(v)) this._wind = clamp01(Math.abs(v));
    } else if (v && typeof v.x === 'number') {
      const y = typeof v.y === 'number' ? v.y : 0;
      const z = typeof v.z === 'number' ? v.z : 0;
      this._wind = clamp01(Math.sqrt(v.x * v.x + y * y + z * z));
    }
  }

  _readListener() {
    const cam = this.ctx?.camera;
    if (!cam) return;
    const e = cam.matrixWorld?.elements;
    if (e && e.length >= 16) {
      _lisPos.x = e[12]; _lisPos.y = e[13]; _lisPos.z = e[14];
      _lisUp.x = e[4]; _lisUp.y = e[5]; _lisUp.z = e[6];
      _lisFwd.x = -e[8]; _lisFwd.y = -e[9]; _lisFwd.z = -e[10];
    } else {
      readVec(cam, _lisPos);
    }
  }

  _applyListener(now) {
    const l = this.actx?.listener;
    if (!l) return;
    if (l.positionX) {
      // setTargetAtTime, never setPosition and never an instantaneous jump — HRTF convolution
      // zippers audibly on a discontinuous listener (§3.1).
      l.positionX.setTargetAtTime(_lisPos.x, now, 0.02);
      l.positionY.setTargetAtTime(_lisPos.y, now, 0.02);
      l.positionZ.setTargetAtTime(_lisPos.z, now, 0.02);
      l.forwardX.setTargetAtTime(_lisFwd.x, now, 0.02);
      l.forwardY.setTargetAtTime(_lisFwd.y, now, 0.02);
      l.forwardZ.setTargetAtTime(_lisFwd.z, now, 0.02);
      l.upX.setTargetAtTime(_lisUp.x, now, 0.02);
      l.upY.setTargetAtTime(_lisUp.y, now, 0.02);
      l.upZ.setTargetAtTime(_lisUp.z, now, 0.02);
    } else if (typeof l.setPosition === 'function') {
      l.setPosition(_lisPos.x, _lisPos.y, _lisPos.z);
      l.setOrientation(_lisFwd.x, _lisFwd.y, _lisFwd.z, _lisUp.x, _lisUp.y, _lisUp.z);
    }
  }

  /**
   * Occluder thickness in "effective metres" between the listener and a point (§3.2 table).
   * Prefers a real query from NoiseSystem or AudioEngine; otherwise a cheap analytic estimate
   * from forest density. The provider lookup is cached for 4 s so this never allocates in the
   * hot path.
   */
  _occlusionT(x, y, z, d, now) {
    if (now - this._occProbedAt > 4) {
      this._occProbedAt = now;
      this._occFn = null;
      this._occOwner = null;
      const sys = this.ctx?.systems;
      const noise = sys?.get?.('NoiseSystem');
      const audio = sys?.get?.('Audio');
      // TODO(api): agreed shape is occlusionMetres(fromVec3, toVec3) -> effective metres.
      const owners = [noise, noise, audio, audio];
      const names = ['occlusionMetres', 'occlusionBetween', 'occlusionMetres', 'occlusionBetween'];
      for (let i = 0; i < owners.length; i++) {
        const o = owners[i];
        if (o && typeof o[names[i]] === 'function') {
          this._occOwner = o; this._occFn = o[names[i]];
          break;
        }
      }
    }

    if (this._occFn) {
      _tmpVec2.x = x; _tmpVec2.y = y; _tmpVec2.z = z;
      try {
        const t = this._occFn.call(this._occOwner, _lisPos, _tmpVec2);
        if (Number.isFinite(t)) return clamp(t, 0, OCC_MAX_T);
      } catch { /* fall through to the estimate */ }
    }

    // Analytic: one pine trunk per ~9 m of path, scaled by local forest density.
    let density = DEFAULT_FOREST_DENSITY;
    const forest = this.ctx?.systems?.get?.('Forest');
    if (typeof forest?.densityAt === 'function') {
      try {
        const v = forest.densityAt((x + _lisPos.x) * 0.5, (z + _lisPos.z) * 0.5);
        if (Number.isFinite(v)) density = clamp01(v);
      } catch { /* keep the default */ }
    }
    return clamp((d / METRES_PER_TRUNK) * TRUNK_EFFECTIVE_M * density, 0, OCC_MAX_T);
  }

  /** Refresh the pooled camper list. Allocation-free once the pool has grown. */
  _collectCampers(force) {
    const sys = this.ctx?.systems?.get?.('Campers');
    let list = null;
    if (sys) {
      // TODO(api): Campers has no documented accessor. Probe the plausible shapes and accept
      // that autonomous chatter simply does not happen until one of them exists.
      list = Array.isArray(sys.campers) ? sys.campers
        : Array.isArray(sys.agents) ? sys.agents
          : Array.isArray(sys.list) ? sys.list
            : Array.isArray(sys.all) ? sys.all
              : (typeof sys.getAll === 'function' ? this._safeList(sys, 'getAll') : null);
    }
    if (!Array.isArray(list)) { if (force) this._camperCount = 0; return; }

    const n = Math.min(list.length, 12);
    let kept = 0;
    for (let i = 0; i < n; i++) {
      const c = list[i];
      if (!c) continue;
      let slot = this._campers[kept];
      if (!slot) {
        slot = { id: '', x: 0, y: 1.6, z: 0, fx: 0, fy: 0, fz: -1, hasFacing: false };
        this._campers[kept] = slot;
      }
      slot.id = String(c.id ?? c.name ?? `camper${i}`).toLowerCase();
      if (!readVec(c.position ?? c.object3D ?? c.mesh ?? c, slot)) { slot.x = 0; slot.z = 0; }
      // Mouth height, not foot height — a voice comes out of a head.
      if (!Number.isFinite(slot.y) || slot.y < 0.9) slot.y = 1.6;
      slot.hasFacing = readVec(c.forward ?? c.facing ?? c.dir ?? null, _tmpVec);
      if (slot.hasFacing) { slot.fx = _tmpVec.x; slot.fy = _tmpVec.y; slot.fz = _tmpVec.z; }
      kept++;
    }
    this._camperCount = kept;
  }

  _safeList(obj, name) {
    try { const v = obj[name](); return Array.isArray(v) ? v : null; } catch { return null; }
  }

  _findCamper(id) {
    for (let i = 0; i < this._camperCount; i++) {
      if (this._campers[i].id === id) return this._campers[i];
    }
    return null;
  }

  // ------------------------------------------------------------------- intelligibility

  /**
   * I = clamp01(1 − d/26) · (1 − 0.55·occN) · (1 − 0.45·wind) · facing        (§7.2)
   *
   * `facing` is 1.0 when the speaker faces the player and 0.4 when they face away — a camper
   * with their back to you is genuinely harder to understand, and that is a gameplay tell.
   * When no facing is known we assume 1.0 rather than inventing a penalty.
   */
  _intelligibility(d, occT, facing) {
    const distTerm = clamp01(1 - d / I_RANGE);
    const occN = clamp01(occT / 3);
    return clamp01(distTerm * (1 - 0.55 * occN) * (1 - 0.45 * this._wind) * facing);
  }

  _facingTerm(fx, fy, fz, x, y, z, d) {
    if (d < 0.001) return 1;
    const dx = (_lisPos.x - x) / d, dy = (_lisPos.y - y) / d, dz = (_lisPos.z - z) / d;
    const dot = fx * dx + fy * dy + fz * dz;      // 1 = facing the player, −1 = facing away
    return clamp(0.4 + 0.6 * (dot * 0.5 + 0.5), 0.4, 1.0);
  }

  /** Cheap pre-flight estimate, used to decide whether a scripted line is worth spending. */
  _estimateI(position, facing) {
    if (!readVec(position, _tmpVec)) return 1;
    const now = this.actx?.currentTime ?? 0;
    const d = dist(_tmpVec.x, _tmpVec.y, _tmpVec.z, _lisPos.x, _lisPos.y, _lisPos.z);
    const occT = this._occlusionT(_tmpVec.x, _tmpVec.y, _tmpVec.z, d, now);
    let f = 1;
    if (facing && typeof facing.x === 'number') {
      f = this._facingTerm(facing.x, facing.y ?? 0, facing.z ?? 0,
        _tmpVec.x, _tmpVec.y, _tmpVec.z, d);
    }
    return this._intelligibility(d, occT, f);
  }

  // ------------------------------------------------------------------- line selection

  _bedCategoryFor(speaker) {
    for (let i = 0; i < BED_CATEGORIES.length; i++) {
      const c = BED_CATEGORIES[i];
      const pool = speaker ? this._bySpeakerCat.get(`${speaker}|${c}`) : this._byCategory.get(c);
      if (pool && pool.length) return c;
    }
    return 'idle';
  }

  /**
   * Pick a line in a category, honouring the two cooldowns from §7.3:
   *   - the same line id never plays twice in one night, and
   *   - a line once heard CLEARLY is never heard clearly again in the whole game. It may
   *     still come back as a half-heard fragment, which is exactly the point: the second
   *     time you hear "that's a mallet", you should not be sure that is what she said.
   */
  _pickLine(category, speaker, allowRelax) {
    // 1. Ask Script first — it is the Story agent's picker and it knows about nights/beats.
    const linesFor = this._Script?.linesFor;
    if (typeof linesFor === 'function') {
      try {
        const night = this.ctx?.state?.night ?? 1;
        const res = linesFor.call(this._Script, category, { speaker, night, category });
        const picked = this._firstUsable(res);
        if (picked) return picked;
      } catch { /* Script is optional — fall through to the manifest index */ }
    }

    // 2. The manifest index — the only source guaranteed to match what is actually on disk.
    let pool = speaker ? this._bySpeakerCat.get(`${speaker}|${category}`) : null;
    if (!pool || pool.length === 0) pool = this._byCategory.get(category) ?? null;
    if ((!pool || pool.length === 0) && allowRelax) pool = this._byCategory.get('idle') ?? null;
    if (!pool || pool.length === 0) return null;

    // Weighted by priority, so a "did you hear that?" beats a tarp joke when both would fit.
    let best = null;
    let bestScore = -1;
    for (let i = 0; i < pool.length; i++) {
      const id = pool[i];
      if (this._usedThisNight.has(id) || this._failed.has(id)) continue;
      const e = this._lines.get(id);
      if (!e) continue;
      const score = (e.priority + 1) * (0.35 + this._rand.next());
      if (score > bestScore) { bestScore = score; best = e; }
    }
    // If everything in this category is spent tonight, silence is the correct answer.
    return best;
  }

  _firstUsable(res) {
    if (!res) return null;
    if (typeof res === 'string') return this._usableEntry(res);
    if (Array.isArray(res)) {
      const n = res.length;
      if (n === 0) return null;
      // Deterministic rotate-then-scan: no allocation, no shuffle, seeded.
      const off = Math.floor(this._rand.next() * n);
      for (let i = 0; i < n; i++) {
        const item = res[(i + off) % n];
        const e = this._usableEntry(typeof item === 'string' ? item : item?.id);
        if (e) return e;
      }
      return null;
    }
    return this._usableEntry(res.id);
  }

  _usableEntry(id) {
    if (!id) return null;
    const e = this._lines.get(id);
    if (!e) return null;
    if (this._usedThisNight.has(id) || this._failed.has(id)) return null;
    return e;
  }

  // ------------------------------------------------------------------- playback

  /** The gatekeeper. Everything that sounds goes through here. */
  _request(entry, position, opts) {
    const a = this.actx;
    if (!a) return null;
    const now = a.currentTime;

    const priority = Number.isFinite(opts.priority) ? opts.priority : entry.priority;
    // Priority 3 is the game speaking through the world — a camper reacting to something the
    // player actually did, aimed at where the player actually is. It always wins a slot.
    const force = opts.force === true || priority >= 3;
    const isTurn = opts.turn === true;

    // §8 silence rules outrank everything, including priority 3.
    if (now < this._silenceUntil) { this.stats.denied++; return null; }

    if (!force) {
      if (now < this._chatterUntil) { this.stats.denied++; return null; }
      if (!isTurn) {
        if (now < this._globalNextAt) { this.stats.denied++; return null; }
        const until = this._camperNextAt.get(entry.speaker) ?? 0;
        if (now < until) { this.stats.denied++; return null; }
      }
    }

    // Resolve the position: explicit argument, then the Campers system, then the listener's
    // own position — which at least keeps a mis-wired caller audible rather than silent.
    let px = _lisPos.x, py = _lisPos.y, pz = _lisPos.z;
    if (readVec(position, _tmpVec)) { px = _tmpVec.x; py = _tmpVec.y; pz = _tmpVec.z; }
    else {
      const c = this._findCamper(entry.speaker);
      if (c) { px = c.x; py = c.y; pz = c.z; }
    }

    // §7.3 spatial rule: two speakers within 20° of each other in the player's azimuth merge
    // into one indistinct blob. Refuse rather than mush. Checked BEFORE acquiring a slot so a
    // refusal never costs a voice that was already sounding.
    if (!force && this._azimuthConflict(px, py, pz)) { this.stats.denied++; return null; }

    const slot = this._acquireSlot(priority, now);
    if (!slot) { this.stats.denied++; return null; }

    // Facing, if anyone can tell us.
    let fx = 0, fy = 0, fz = -1, hasFacing = false;
    if (readVec(opts.facing, _tmpVec)) {
      fx = _tmpVec.x; fy = _tmpVec.y; fz = _tmpVec.z; hasFacing = true;
    } else {
      const c = this._findCamper(entry.speaker);
      if (c?.hasFacing) { fx = c.fx; fy = c.fy; fz = c.fz; hasFacing = true; }
    }

    slot.entry = entry;
    slot.id = entry.id;
    slot.speaker = entry.speaker;
    slot.x = px; slot.y = py; slot.z = pz;
    slot.fx = fx; slot.fy = fy; slot.fz = fz; slot.hasFacing = hasFacing;
    slot.gain = clamp(Number.isFinite(opts.volume) ? opts.volume : 1, 0, 2);
    slot.priority = priority;
    slot.busy = true;
    slot.startedAt = now;
    slot.endsAt = now + (entry.dur || entry.estDur);
    slot.serial = ++this._serial;
    slot.paramAcc = 999;               // force a full parameter solve on the first update
    slot.gated = false;
    slot.smearNext = 0;
    try { slot.smear.gain.setTargetAtTime(1, now, 0.02); } catch { /* ignore */ }

    // Bookkeeping happens at REQUEST time, not at start time, so a slow decode can never let
    // the same line be requested twice.
    this._usedThisNight.add(entry.id);
    this._camperNextAt.set(entry.speaker, now + CAMPER_COOLDOWN_S);
    if (!isTurn) this._globalNextAt = now + GLOBAL_LINE_GAP_S;

    this._applySlotParams(slot, now, true);
    this._startWhenLoaded(slot, entry, opts);

    if (priority >= 3) {
      // The camp stops and listens. That silence is the payload; the line is only the cue.
      this.interrupt('priority line');
      const hush = slot.endsAt + this._rand.range(LISTEN_HUSH_MIN_S, LISTEN_HUSH_MAX_S);
      if (hush > this._chatterUntil) this._chatterUntil = hush;
    }

    this.stats.played++;
    return slot;
  }

  _startWhenLoaded(slot, entry, opts) {
    const serial = slot.serial;
    this._ensureBuffer(entry.id).then((buf) => {
      if (this._disposed || !this.actx) return;
      if (slot.serial !== serial || !slot.busy) return;       // superseded or stopped
      if (!buf) { this._releaseSlot(slot, serial); return; }

      const a = this.actx;
      const now = a.currentTime;
      // A line that arrives long after the moment that asked for it is worse than no line at
      // all — a camper reacting to a noise four seconds late reads as a bug, not a person. So
      // a slow cold-cache decode is dropped. The window scales with priority, and the idle
      // warmer (`_warmNext`) keeps the LRU stocked so this almost never fires in practice.
      const stale = slot.priority >= 2 ? 2.5 : 1.2;
      if (now - slot.startedAt > stale) {
        this._releaseSlot(slot, serial);
        return;
      }

      // ±2% pitch/rate jitter so a repeated line is never the same sound twice.
      const rate = 1 + this._rand.range(-RATE_JITTER, RATE_JITTER);

      let src;
      try {
        src = a.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = rate;
        src.connect(slot.pre);
      } catch {
        this._releaseSlot(slot, serial);
        return;
      }

      // §9.2: schedule in the future, never at currentTime. ≥4 ms attack, ≥8 ms release, and
      // exponential ramps target 1e-4, never 0.
      const t0 = now + 0.02;
      const dur = buf.duration / rate;
      const peak = Math.max(0.0002, slot.gain);
      const atk = 0.012;
      const rel = 0.020;
      const end = t0 + Math.max(atk + rel + 0.01, dur);
      const g = slot.pre.gain;
      try {
        if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(now);
        g.setValueAtTime(0.0001, t0);
        g.linearRampToValueAtTime(peak, t0 + atk);
        g.setValueAtTime(peak, end - rel);
        g.exponentialRampToValueAtTime(0.0001, end);
      } catch { /* a hostile param state is not worth failing a line over */ }

      src.onended = () => this._releaseSlot(slot, serial);
      try { src.start(t0); } catch { this._releaseSlot(slot, serial); return; }

      slot.src = src;
      slot.endsAt = end;
      entry.dur = buf.duration;

      this._maybeSubtitle(slot, entry, dur, opts);
    }).catch(() => this._releaseSlot(slot, serial));
  }

  /**
   * SUBTITLES — and the reasoning, because this is the easiest thing in the file to get wrong.
   *
   * We subtitle ONLY a line the player could actually make out: I > 0.62, which in still air
   * with clear line of sight means roughly inside 10 m. Subtitling a half-heard or
   * unintelligible line would hand back, in clean flat type, precisely the information the
   * entire distance chain above exists to destroy. The player would stop listening to the
   * woods and start reading them; every distant murmur would resolve into a legible sentence;
   * and the core effect of this whole system — "I almost caught that" — would be gone. So a
   * muffled line stays muffled. No text. Not an ellipsis, not "[distant voices]", nothing.
   *
   * A line is also never subtitled twice at full clarity in one playthrough (§7.3), and
   * `clearOK: false` in the manifest vetoes it outright.
   */
  _maybeSubtitle(slot, entry, dur, opts) {
    if (!this.bus) return;
    const s = this.ctx?.settings;
    const on = s?.get?.('subtitles') ?? s?.subtitles ?? false;
    if (!on) return;

    const now = this.actx?.currentTime ?? 0;
    const d = dist(slot.x, slot.y, slot.z, _lisPos.x, _lisPos.y, _lisPos.z);
    const occT = this._occlusionT(slot.x, slot.y, slot.z, d, now);
    const facing = slot.hasFacing
      ? this._facingTerm(slot.fx, slot.fy, slot.fz, slot.x, slot.y, slot.z, d)
      : 1;
    const I = this._intelligibility(d, occT, facing);

    if (I <= I_CLEAR || !entry.clearOK || this._heardClear.has(entry.id)) {
      this.stats.halfHeard++;
      return;
    }
    if (!entry.text) return;

    this._heardClear.add(entry.id);
    this.stats.clear++;
    this.stats.subtitles++;

    this.bus.emit('ui:subtitle', {
      text: entry.text,
      speaker: opts?.speakerName ?? entry.speaker,
      ms: Math.round(clamp(dur * 1000 + 400, 1200, 6000)),
    });
  }

  _acquireSlot(priority, now) {
    for (let i = 0; i < this._slots.length; i++) {
      if (!this._slots[i].busy) return this._slots[i];
    }
    // Full. Steal the lowest-scoring voice, and only for a strictly higher priority.
    // score = priority·1000 − 0.4·distance − age  (§9.1, simplified: VO gain is uniform).
    let victim = null;
    let worst = Infinity;
    for (let i = 0; i < this._slots.length; i++) {
      const s = this._slots[i];
      if (s.priority >= priority) continue;
      const d = dist(s.x, s.y, s.z, _lisPos.x, _lisPos.y, _lisPos.z);
      const score = s.priority * 1000 - 0.4 * d - (now - s.startedAt);
      if (score < worst) { worst = score; victim = s; }
    }
    if (!victim) return null;
    this._stopSlot(victim, 8);          // 8 ms fade, never a bare stop (§9.1)
    return victim;
  }

  _stopSlot(slot, fadeMs) {
    const a = this.actx;
    if (!a || !slot) return;
    const now = a.currentTime;
    const t = Math.max(0.008, (fadeMs || 8) / 1000);
    const g = slot.pre.gain;
    try {
      if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(now);
      else g.setValueAtTime(Math.max(0.0001, g.value), now);
      g.exponentialRampToValueAtTime(0.0001, now + t);
      g.setValueAtTime(0, now + t + 0.001);
    } catch { /* param already in a terminal state */ }

    const src = slot.src;
    if (src) {
      try { src.onended = null; src.stop(now + t + 0.002); } catch { /* already stopped */ }
      slot.src = null;
      // Disconnect after the fade so the ramp is actually heard.
      const timer = setTimeout(() => {
        this._timers.delete(timer);
        try { src.disconnect(); } catch { /* gone */ }
      }, Math.ceil((t + 0.05) * 1000));
      this._timers.add(timer);
    }
    slot.busy = false;
    slot.entry = null;
    slot.id = null;
    slot.speaker = null;
    slot.serial = ++this._serial;       // invalidate any pending _startWhenLoaded
  }

  _releaseSlot(slot, serial) {
    if (!slot || (serial !== undefined && slot.serial !== serial)) return;
    if (slot.src) {
      try { slot.src.onended = null; slot.src.disconnect(); } catch { /* gone */ }
      slot.src = null;
    }
    slot.busy = false;
    slot.entry = null;
    slot.id = null;
    slot.speaker = null;
  }

  // ------------------------------------------------------------------- per-slot params

  _updateSlot(slot, now, dt) {
    // Position tracks every frame (campers walk while they talk); the filter solve runs at
    // 12 Hz, which is far faster than a person can walk between filter-relevant distances.
    this._setPannerPosition(slot, now);

    slot.paramAcc += dt;
    if (slot.paramAcc >= 1 / 12) {
      slot.paramAcc = 0;
      this._applySlotParams(slot, now, false);
    }

    // The wind gate. An independent random walk per voice, so two speakers caught in the same
    // gust do not duck together — correlated dropouts read as a mix bug, uncorrelated ones
    // read as wind moving through the space between you and them.
    if (slot.gated && now >= slot.smearNext) {
      const target = this._rand.range(SMEAR_FLOOR, 1.0);
      try { slot.smear.gain.setTargetAtTime(target, now, SMEAR_GLIDE); } catch { /* ignore */ }
      slot.smearNext = now + 1 / (3 + 5 * this._wind);
    }

    if (slot.endsAt > 0 && now > slot.endsAt + 0.25) this._releaseSlot(slot, slot.serial);
  }

  _setPannerPosition(slot, now) {
    const p = slot.panner;
    if (p.positionX) {
      p.positionX.setTargetAtTime(slot.x, now, 0.02);
      p.positionY.setTargetAtTime(slot.y, now, 0.02);
      p.positionZ.setTargetAtTime(slot.z, now, 0.02);
    } else if (typeof p.setPosition === 'function') {
      p.setPosition(slot.x, slot.y, slot.z);
    }
  }

  _applySlotParams(slot, now, immediate) {
    const d = dist(slot.x, slot.y, slot.z, _lisPos.x, _lisPos.y, _lisPos.z);
    const occT = this._occlusionT(slot.x, slot.y, slot.z, d, now);
    const tau = immediate ? 0.008 : 0.05;

    // --- THE CURVE -------------------------------------------------------------------
    // Distance lowpass, then occlusion folded into the same filter (§3.2). Filter frequency
    // jumps click on some engines, so always ramp with setTargetAtTime (§9.2 rule 6).
    const distFc = VO_LP_F0 / Math.pow(1 + d / VO_LP_D0, VO_LP_EXP);
    const occFc = 18000 * Math.exp(-0.55 * occT);
    const lpFc = clamp(Math.min(distFc, occFc), 180, 16000);

    // The highpass CLIMBS with distance: body and proximity go before sibilance does.
    const hpFc = clamp(VO_HP_BASE + VO_HP_PER_M * d, VO_HP_BASE, VO_HP_MAX);

    // Consonants are the first casualty of distance. This is the band that carries them.
    const presDb = Math.max(VO_PRESENCE_MIN, VO_PRESENCE_DB0 - VO_PRESENCE_PER_M * d);

    // Occlusion attenuation, −3.2 dB per effective metre, clamped at −34 dB (§3.2).
    const occLin = Math.pow(10, Math.max(-34, -3.2 * occT) / 20);

    // Fake elevation: a shelf, because WebAudio HRTF barely encodes it (§3.1).
    const dy = slot.y - _lisPos.y;
    const elevDb = dy > 2 ? 3 : (dy < -2 ? -4 : 0);

    // A far voice is mostly the room it is standing in.
    const wet = clamp(VERB_MIN + VERB_PER_M * d, VERB_MIN, VERB_MAX);

    try {
      slot.lp.frequency.setTargetAtTime(lpFc, now, Math.max(0.008, tau));
      slot.hp.frequency.setTargetAtTime(hpFc, now, Math.max(0.008, tau));
      slot.pres.gain.setTargetAtTime(presDb, now, tau);
      slot.elev.gain.setTargetAtTime(elevDb, now, tau);
      slot.occ.gain.setTargetAtTime(occLin, now, tau);
      if (this._verbSend) slot.send.gain.setTargetAtTime(wet, now, tau);
    } catch { /* ignore hostile param states */ }

    // Arm or disarm the wind gate.
    const gated = d > SMEAR_MIN_DIST || this._wind > SMEAR_MIN_WIND;
    if (gated !== slot.gated) {
      slot.gated = gated;
      if (gated) {
        slot.smearNext = now + this._rand.range(0.05, 0.35);
      } else {
        slot.smearNext = 0;
        try { slot.smear.gain.setTargetAtTime(1, now, 0.08); } catch { /* ignore */ }
      }
    }

    // Cone: only meaningful when we actually know which way the speaker is turned. A camper
    // facing away is quieter and darker, and that is a gameplay tell (§3.1).
    if (slot.hasFacing) {
      const o = slot.panner;
      o.coneInnerAngle = VO_CONE_INNER;
      o.coneOuterAngle = VO_CONE_OUTER;
      o.coneOuterGain = VO_CONE_OUTER_GAIN;
      if (o.orientationX) {
        o.orientationX.setTargetAtTime(slot.fx, now, 0.05);
        o.orientationY.setTargetAtTime(slot.fy, now, 0.05);
        o.orientationZ.setTargetAtTime(slot.fz, now, 0.05);
      } else if (typeof o.setOrientation === 'function') {
        o.setOrientation(slot.fx, slot.fy, slot.fz);
      }
    }

    // Past 45 m HRTF cues carry no information and cost 4× — downgrade in place (§9.3).
    const wantHrtf = slot.hrtfPreferred && d < HRTF_CUTOFF_M;
    if (wantHrtf !== slot.hrtfNow) {
      slot.hrtfNow = wantHrtf;
      try { slot.panner.panningModel = wantHrtf ? 'HRTF' : 'equalpower'; } catch { /* ignore */ }
    }
  }

  /** True if a currently-sounding voice sits within AZIMUTH_MIN_DEG of this position. */
  _azimuthConflict(x, y, z) {
    const a = this._azimuth(x, z);
    for (let i = 0; i < this._slots.length; i++) {
      const s = this._slots[i];
      if (!s.busy) continue;
      let diff = Math.abs(a - this._azimuth(s.x, s.z));
      if (diff > 180) diff = 360 - diff;
      if (diff < AZIMUTH_MIN_DEG) return true;
    }
    return false;
  }

  /** Signed bearing in degrees, −180..180, relative to where the player is looking. */
  _azimuth(x, z) {
    const f = Math.atan2(_lisFwd.x, _lisFwd.z);
    const t = Math.atan2(x - _lisPos.x, z - _lisPos.z);
    return ((t - f) * 180 / Math.PI + 540) % 360 - 180;
  }

  // ------------------------------------------------------------------- conversations

  _freeConversation() {
    for (let i = 0; i < this._convs.length; i++) {
      if (!this._convs[i].active) return this._convs[i];
    }
    return null;
  }

  _openConversation(conv, category, now) {
    conv.active = true;
    conv.category = category;
    conv.arguing = category === 'argue';
    conv.turn = 0;
    conv.retries = 0;
    // 1–4 turns. Two is the most common and the most convincing: an exchange, then nothing.
    conv.turns = conv.count === 1 ? 1 : this._rand.int(2, MAX_TURNS);
    conv.nextAt = now + this._rand.range(0, 0.6);
  }

  _closeConversation(conv) {
    if (!conv) return;
    conv.active = false;
    conv.turn = 0;
    conv.turns = 0;
    conv.retries = 0;
  }

  // ------------------------------------------------------------------- the scheduler

  _tick(now, dt) {
    if (this._hardStopped) return;

    // Token bucket refill.
    this._tokenAcc += dt;
    while (this._tokenAcc >= CONV_REFILL_S) {
      this._tokenAcc -= CONV_REFILL_S;
      if (this._tokens < CONV_BUCKET_CAP) this._tokens++;
    }

    this._camperPollAcc += dt;
    if (this._camperPollAcc >= 0.5) { this._camperPollAcc = 0; this._collectCampers(false); }

    if (now < this._silenceUntil) return;

    // Advance live conversations.
    for (let i = 0; i < this._convs.length; i++) {
      const c = this._convs[i];
      if (c.active) this._advanceConversation(c, now);
    }

    const phase = this.ctx?.state?.phase;
    if (phase === 'menu' || phase === 'gameover' || phase === 'briefing' || phase === 'night-end') {
      return;
    }

    // Silence is when we do the loading. Warming one likely line every few seconds keeps the
    // LRU stocked without ever preloading the bank, so the next reaction is already resident.
    this._warmNext(now);

    // Start a new conversation?
    if (now < this._nextConvAt || now < this._chatterUntil) return;
    if (this._tokens <= 0) return;
    if (this._camperCount < 1) return;

    const conv = this._freeConversation();
    if (!conv) return;

    if (!this._formGroup(conv)) {
      // Nobody is grouped up right now. Try again shortly, and do not burn a token for it.
      this._nextConvAt = now + 4;
      return;
    }

    this._tokens--;
    this._nextConvAt = now + CONV_MIN_GAP_S + this._rand.range(0, 14);
    this._openConversation(conv, this._pickTopic(), now);
  }

  /**
   * Warm one buffer the current situation is likely to want next. Bounded to a single
   * in-flight decode and stops as soon as the LRU is full — this is opportunistic
   * pre-caching, never a preload of the bank.
   */
  _warmNext(now) {
    if (now < this._warmNextAt) return;
    this._warmNextAt = now + 3;
    if (this._loading.size > 0) return;
    if (this._buffers.size >= this._cacheMax) return;

    const pool = this._byCategory.get(this._pickTopic());
    if (!pool || pool.length === 0) return;
    const off = Math.floor(this._rand.next() * pool.length);
    for (let i = 0; i < pool.length; i++) {
      const id = pool[(i + off) % pool.length];
      if (this._buffers.has(id) || this._failed.has(id) || this._usedThisNight.has(id)) continue;
      this._ensureBuffer(id);
      return;
    }
  }

  /** Gather up to three campers standing near each other into a conversation. */
  _formGroup(conv) {
    if (this._camperCount === 0) return false;
    const anchorIdx = this._rand.int(0, this._camperCount - 1);
    const anchor = this._campers[anchorIdx];
    if (!anchor) return false;
    if (this.isSpeaking(anchor.id)) return false;

    conv.count = 0;
    this._pushSpeaker(conv, anchor);

    for (let i = 0; i < this._camperCount && conv.count < 3; i++) {
      if (i === anchorIdx) continue;
      const c = this._campers[i];
      if (this.isSpeaking(c.id)) continue;
      if (dist(c.x, c.y, c.z, anchor.x, anchor.y, anchor.z) > GROUP_RADIUS_M) continue;
      this._pushSpeaker(conv, c);
    }
    return conv.count > 0;
  }

  _pushSpeaker(conv, c) {
    const i = conv.count;
    if (i >= SPEAKERS_PER_CONV) return;
    conv.ids[i] = c.id;
    conv.pos[i].x = c.x; conv.pos[i].y = c.y; conv.pos[i].z = c.z;
    conv.count++;
  }

  _pickTopic() {
    const st = this.ctx?.state;
    const susp = clamp01(st?.suspicion ?? 0);
    const night = st?.night ?? 1;

    if (night >= 6 && susp > 0.4) return this._rand.weighted(TOPICS_LATE, WEIGHTS_LATE);
    if (susp > 0.5) return this._rand.weighted(TOPICS_ALERT, WEIGHTS_ALERT);
    if (susp > 0.2) return this._rand.weighted(TOPICS_UNEASY, WEIGHTS_UNEASY);
    return this._rand.weighted(TOPICS_CALM, WEIGHTS_CALM);
  }

  _advanceConversation(conv, now) {
    if (now < conv.nextAt) return;
    if (conv.turn >= conv.turns) { this._closeConversation(conv); return; }

    const idx = conv.turn % conv.count;
    const speaker = conv.ids[idx];
    const p = conv.pos[idx];

    // Refresh the position — they may have walked since the conversation was planned.
    const live = this._findCamper(speaker);
    if (live) { p.x = live.x; p.y = live.y; p.z = live.z; }

    const entry = this._pickLine(conv.category, speaker, true)
      ?? this._pickLine(conv.category, null, true);
    if (!entry) { this._closeConversation(conv); return; }

    _convOpts.turn = true;
    _convOpts.priority = entry.priority;
    _convOpts.facing = live?.hasFacing ? _convFacing : null;
    if (live?.hasFacing) { _convFacing.x = live.fx; _convFacing.y = live.fy; _convFacing.z = live.fz; }

    const handle = this._request(entry, p, _convOpts);
    if (!handle) {
      // Denied — usually the azimuth rule or a busy slot. Wait a beat and try once more, then
      // give up. A conversation that cannot be placed cleanly should not happen at all.
      conv.retries++;
      if (conv.retries > 2) { this._closeConversation(conv); return; }
      conv.nextAt = now + this._rand.range(0.25, 0.5);
      return;
    }
    conv.retries = 0;

    const dur = entry.dur || entry.estDur;
    const gap = (TURN_GAP_MIN_MS + this._rand.next() * TURN_GAP_JIT_MS) / 1000;

    // OVERLAP. Ordinary conversation LATCHES: the next speaker starts ~250 ms before the
    // current one finishes, on 12% of turns. That is not talking over someone, it is how
    // people actually take turns, and perfectly alternating VO sounds like a radio play.
    // Genuine collision — two voices properly on top of each other — is reserved for
    // arguments, which is the only time campers do it and the only time it reads as real.
    const chance = conv.arguing ? ARGUE_OVERLAP_CHANCE : OVERLAP_CHANCE;
    const overlapMs = conv.arguing ? this._rand.range(250, ARGUE_OVERLAP_MAX_MS) : OVERLAP_MS;
    const overlap = this._rand.next() < chance ? overlapMs / 1000 : 0;

    conv.turn++;
    conv.nextAt = now + Math.max(0.35, dur - overlap) + gap;

    // Prefetch the next turn so the gap we asked for is the gap we get.
    if (conv.turn < conv.turns) {
      const nextSpeaker = conv.ids[conv.turn % conv.count];
      const nextEntry = this._pickLine(conv.category, nextSpeaker, false);
      if (nextEntry) this._ensureBuffer(nextEntry.id);
    }
  }
}

// Reused option bags for the scheduler — the 10 Hz tick must not allocate.
const _convFacing = { x: 0, y: 0, z: -1 };
const _convOpts = { turn: true, priority: 1, facing: null };

export default VoiceBank;
