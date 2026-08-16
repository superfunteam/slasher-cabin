/**
 * AudioEngine.js — the WebAudio graph: buses, HRTF 3D panning, distance/occlusion
 * filtering, procedural reverb spaces, the mask, the ambience bed, and the SFX dispatcher.
 *
 * OWNER: Audio agent. Implements AUDIO_DIRECTION.md §2, §3, §5, §8, §9.
 *
 * THE ONE CORRECTNESS RULE THAT MATTERS (§1.3): a `noise:emit` is a gameplay event *and* a
 * sound. When we render one audibly we ask `NoiseSystem.audibilityAt()` for the exact number
 * the AI is using and mix to it. If what the player hears disagrees with what the campers
 * hear, the stealth game is unfair. Everything else in this file is atmosphere; that is
 * mechanics.
 *
 * Everything here degrades: no AudioContext, no NoiseSystem, no Player, no Weather, no
 * Music — the class still constructs, inits, updates and disposes without throwing.
 */
import * as THREE from 'three';
import { Log } from '../core/Log.js';
import { Rand } from '../core/Rand.js';
import {
  SFXBank, renderImpulseResponse, recipeInfo, resolveId, creakTier, dbToGain, SPACES,
} from './ProceduralSFX.js';

// ---------------------------------------------------------------- module scratch
// No allocation in update() (ARCHITECTURE.md §12).
const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _lis = new THREE.Vector3();
const _tmp = new THREE.Vector3();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const copyOcc = (src, dst) => { dst.gain = src.gain; dst.fc = src.fc; dst.bleed = src.bleed; return dst; };
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const MIN_G = 1e-4;

/** Bus name aliases — the doc's names and the shorter gameplay-facing ones both work. */
const BUS_ALIAS = {
  sfx: 'sfxWorld', world: 'sfxWorld', ui: 'sfxUI', amb: 'ambience',
  voice: 'vo', dialogue: 'vo', player: 'body', master: 'master',
};

const BUS_NAMES = ['sfxWorld', 'sfxUI', 'ambience', 'music', 'vo', 'body'];

/** §3.1 rolloff by class. */
const ROLLOFF = { world: 1.15, vo: 0.85, landmark: 0.6, flat: 0 };
const REF_DISTANCE = 1.4;
const MAX_DISTANCE = 140;

/**
 * §1.3 — the `noise:emit` ↔ audible loudness contract, as a monotonic piecewise curve over
 * `intensity`. Anything that emits noise is heard at exactly this level at 1 m.
 */
const NOISE_DB_CURVE = [
  [0.00, -40], [0.05, -34], [0.18, -24], [0.30, -20], [0.35, -18],
  [0.42, -16], [0.55, -13], [0.72, -9], [0.80, -7], [0.90, -5], [1.00, -4],
];

function noiseDbFor(intensity) {
  const x = clamp01(Number(intensity) || 0);
  for (let i = 1; i < NOISE_DB_CURVE.length; i++) {
    const [x1, d1] = NOISE_DB_CURVE[i];
    if (x <= x1) {
      const [x0, d0] = NOISE_DB_CURVE[i - 1];
      const u = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      return d0 + (d1 - d0) * u;
    }
  }
  return -4;
}

/**
 * kind → the sfx id that must accompany it (§1.3). Covers both the kinds NoiseSystem ships
 * (`footstep, brush, drag, drop, impact, hammer, wrench, saw, creak, whistle, voice,
 * thunder`) and the finer-grained names from the loudness table.
 *
 * `null` means "audible elsewhere or deliberately silent" — never a missing sound.
 */
const NOISE_SFX = {
  footstep: 'step', 'footstep-crouch': 'step', 'footstep-walk': 'step', 'footstep-run': 'step',
  brush: 'step.grass',
  drag: 'lumber.drag',
  drop: 'lumber.drop', 'drop-light': 'bracket.drop.rock', 'drop-heavy': 'lumber.drop',
  impact: 'impact.earth',
  hammer: 'hammer.wood', 'hammer-wood': 'hammer.wood', 'hammer-steel': 'hammer.steel',
  wrench: 'screw.torque',
  saw: 'tool.saw',
  split: 'wood.split', twig: 'twig.snap', branch: 'branch.snap',
  zipper: 'zipper', click: 'click.flashlight.on', knock: 'lumber.knock',
  whistle: 'whistle',
  // creak carries its tier on build:creak; thunder is scheduled by Weather's own audio:sfx;
  // voice belongs to VoiceBank; an animal is a false positive we only ever *hear* as leaves.
  creak: null, thunder: null, voice: null, animal: null, generic: null,
};

/** Kinds that are emitted continuously while an action lasts — do not stack them. */
const SUSTAINED_KINDS = { drag: 1.1, wrench: 1.4, saw: 1.5 };

const SURFACE_SFX = {
  pine: 'step.pine', needles: 'step.pine', forest: 'step.pine', duff: 'step.pine',
  mud: 'step.mud', dirt: 'step.mud', soil: 'step.mud', earth: 'step.mud',
  grass: 'step.grass', wetgrass: 'step.grass', 'wet-grass': 'step.grass', moss: 'step.grass',
  gravel: 'step.gravel', stone: 'step.gravel', rock: 'step.gravel', road: 'step.gravel',
  wood: 'step.wood', plank: 'step.wood', deck: 'step.wood', sawn: 'step.wood',
  hollow: 'step.wood.hollow', crawlspace: 'step.wood.hollow',
  tin: 'step.tin', metal: 'step.tin', roof: 'step.tin', shed: 'step.tin',
};

// ---------------------------------------------------------------- voice

let _voiceSerial = 0;

/**
 * A persistent voice slot (§9.1). The whole subgraph is built once and reused forever;
 * only the AudioBufferSourceNode is recreated per play. Idle slots are disconnected from
 * their bus so they cost nothing.
 */
class Voice {
  constructor(engine, index) {
    const c = engine.context;
    this.engine = engine;
    this.index = index;
    this.free = true;
    this.gen = 0;
    this.serial = 0;
    this.occT = 0;
    this.pg = null;
    this.id = null;
    this.family = null;
    this.priority = 1;
    this.startedAt = 0;
    this.endsAt = 0;
    this.baseGain = 1;
    this.distance = 0;
    this.loop = false;
    this.sustained = false;      // participates in the round-robin occlusion refresh
    this.position = new THREE.Vector3();
    this.hasPosition = false;
    this.src = null;
    this.bus = null;

    this.gain = c.createGain();
    this.directLP = c.createBiquadFilter();
    this.directLP.type = 'lowpass';
    this.directLP.frequency.value = 18000;
    this.directLP.Q.value = 0.7;
    this.directGain = c.createGain();
    // The bleed path models diffraction around the occluder: a sound behind a wall never
    // fully vanishes, it becomes a dull thud with no location. That "I heard something but
    // I don't know where" quality is the entire feel of the game (§3.2).
    this.bleedLP = c.createBiquadFilter();
    this.bleedLP.type = 'lowpass';
    this.bleedLP.frequency.value = 400;
    this.bleedLP.Q.value = 0.7;
    this.bleedGain = c.createGain();
    this.bleedGain.gain.value = 0;
    this.tone = c.createBiquadFilter();
    this.tone.type = 'highshelf';
    this.tone.frequency.value = 7000;
    this.tone.gain.value = 0;
    this.panner = c.createPanner();
    this.panner.panningModel = 'equalpower';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = REF_DISTANCE;
    this.panner.maxDistance = MAX_DISTANCE;
    this.panner.rolloffFactor = ROLLOFF.world;
    this.out = c.createGain();
    this.send = c.createGain();
    this.send.gain.value = 0;

    this.gain.connect(this.directLP);
    this.directLP.connect(this.directGain);
    this.directGain.connect(this.tone);
    this.gain.connect(this.bleedLP);
    this.bleedLP.connect(this.bleedGain);
    this.bleedGain.connect(this.tone);
    this.panner.connect(this.out);

    this._onEnded = () => { if (!this.free) this.engine._releaseVoice(this, true); };
  }

  dispose() {
    try { this.src?.stop(); } catch { /* already stopped */ }
    for (const n of [this.gain, this.directLP, this.directGain, this.bleedLP, this.bleedGain,
      this.tone, this.panner, this.out, this.send, this.src]) {
      try { n?.disconnect(); } catch { /* not connected */ }
    }
    this.src = null;
  }
}

// ---------------------------------------------------------------- the engine

export class AudioEngine {
  constructor(ctx) {
    this.ctx = ctx;
    // The EventBus lives on `events`; `bus(name)` is the audio-bus accessor from
    // AUDIO_DIRECTION.md §9.5.
    this.events = ctx?.bus ?? null;
    this.settings = ctx?.settings ?? null;
    this.state = ctx?.state ?? null;
    this.rand = new Rand('audio');

    this.context = null;
    this.buses = null;
    this.sfx = null;
    this.enabled = false;
    this.started = false;          // has a user gesture resumed the context?
    // Sibling audio modules (Music, VoiceBank) share our context and must not fight us for
    // the listener. Advertise that we own it.
    this.drivesListener = true;

    this._unsubs = [];
    this._timers = new Set();
    this._voices = [];
    this._famCount = Object.create(null);
    this._famCaps = { creak: 3, hammer: 2, thunder: 1, vo: 4, footstep: 6, rain: 12, cricket: 14 };
    this._maxVoices = 48;
    this._maxHrtf = 24;
    this._rr = 0;                  // round-robin cursor for sustained-voice refresh

    // recent-play ring, for noise:emit ↔ audio:sfx de-duplication (no allocation in use)
    this._recentIds = new Array(16).fill(null);
    this._recentX = new Float32Array(16);
    this._recentZ = new Float32Array(16);
    this._recentT = new Float32Array(16);
    this._recentI = 0;

    // mix state
    this._space = 'OPEN_FOREST';
    this._spaceTarget = 'OPEN_FOREST';
    this._convA = null; this._convB = null;
    this._retA = null; this._retB = null;
    this._activeConv = 'A';
    this._irs = new Map();
    this._probeT = 0;

    this._maskOn = false;
    this._silenceUntil = 0;
    this._silenceRule = null;
    this._held = false;
    this._heldUntil = 0;

    // gameplay-derived scalars
    this.fear = 0;
    this.exertion = 0;
    this.dread = 0;
    this._nearestCamper = 999;
    this._camperT = 0;
    this._speed = 0;
    this._crouched = false;
    this._rain = 0;
    this._wind = 0.35;
    this._gust = 0;
    this._lanternOn = true;
    this._nailStrike = 0;

    // schedulers
    this._breath = { state: 'calm', next: 0, phase: 0, gainNode: null, cycle: 0 };
    this._heart = { next: 0, bpm: 58, gainNode: null, lp: null };
    this._amb = null;
    this._crickets = null;
    this._cricketCut = 0;          // 0 = full chorus, 1 = silent
    this._cricketClearAt = 0;
    this._cricketReturnT = 0;
    this._acc = 0;
  }

  // =============================================================== lifecycle

  async init() {
    if (!this._createContext()) return;
    try {
      this._buildGraph();
      this._buildVoices();
      this._bindEvents();
      this._installGestureResume();

      this.sfx = new SFXBank(this.context, {
        rand: this.rand.fork('bank'),
        settings: this.settings,
      });
      // Phase 0: one variant of everything the player can trigger in the first second.
      // This is the only audio work the boot waits on.
      // A generous budget here: during boot every yield is pure wall-clock latency, and
      // there is no frame to protect yet.
      await this.sfx.renderPhase(0, { budgetMs: 50, variants: 1 });
      // Everything else renders in the background across frames — boot never stalls.
      this.sfx.renderPhase(1, { budgetMs: 5 }).then(() => {
        Log.debug(`Audio: SFX bank complete (${this.sfx.stats.buffers} buffers, ` +
          `${this.sfx.stats.ms.toFixed(0)} ms).`);
      }).catch((e) => {
        Log.warn('Audio: background SFX render failed:', e?.message ?? e);
      }).finally(() => {
        // The bed comes up with whatever rendered. A missing layer is a missing layer,
        // never a missing forest.
        try { this._startAmbience(); } catch (e) { Log.warn('Audio: ambience failed:', e?.message ?? e); }
      });

      this._loadImpulseResponses()
        .catch((e) => Log.warn('Audio: impulse responses failed:', e?.message ?? e));
      this._buildBody();
      this.enabled = true;
      Log.debug(`Audio: context @${this.context.sampleRate} Hz, ${this._maxVoices} voices.`);
    } catch (e) {
      Log.error('AudioEngine.init failed — running silent.', e);
      this.enabled = false;
    }
  }

  _createContext() {
    const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext ?? null;
    if (!Ctor) {
      Log.warn('No AudioContext in this environment — the game runs silent.');
      return false;
    }
    try {
      this.context = new Ctor({ latencyHint: 'interactive' });
    } catch (e) {
      Log.warn('AudioContext creation failed — the game runs silent.', e?.message ?? e);
      return false;
    }
    const t = this.settings;
    this._maxVoices = t ? t.tier(24, 40, 64, 96) : 48;
    this._maxHrtf = t ? t.tier(0, 0, 40, 56) : 24;
    return true;
  }

  /** §9.4 — the context starts suspended; the title screen is silent and says so by being silent. */
  _installGestureResume() {
    const resume = () => {
      if (!this.context) return;
      if (this.context.state === 'running') { this.started = true; return; }
      this.context.resume().then(() => {
        this.started = true;
        Log.debug('Audio: context resumed on user gesture.');
      }).catch(() => { /* still suspended; try again on the next gesture */ });
    };
    this._resumeHandler = resume;
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
      globalThis.addEventListener?.(ev, resume, { passive: true });
    }
    this._onVisible = () => {
      if (this.context && this.context.state === 'interrupted') resume();
    };
    globalThis.document?.addEventListener?.('visibilitychange', this._onVisible);
    resume();
  }

  // --------------------------------------------------------------- the graph

  _buildGraph() {
    const c = this.context;
    const s = this.settings;

    // Safety net, not a sound. If it is pumping audibly, a source is too loud (§2.2).
    const limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 2;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.18;
    limiter.connect(c.destination);
    this._limiter = limiter;

    const masterGain = c.createGain();
    masterGain.gain.value = s?.get('masterVolume') ?? 0.9;
    masterGain.connect(limiter);

    const mixDuck = c.createGain();
    mixDuck.connect(masterGain);

    // ---- the mask (§2.5). Understated but always present: the player is a very large man
    // hearing the world through a shell. It deepens on the `mask-on` beat.
    const maskIn = c.createGain();
    const maskDry = c.createGain();
    const maskWet = c.createGain();
    const mLP = c.createBiquadFilter(); mLP.type = 'lowpass'; mLP.frequency.value = 3400; mLP.Q.value = 0.6;
    const mPeak = c.createBiquadFilter(); mPeak.type = 'peaking'; mPeak.frequency.value = 680; mPeak.Q.value = 1.1; mPeak.gain.value = 3.5;
    const mNotch = c.createBiquadFilter(); mNotch.type = 'peaking'; mNotch.frequency.value = 1900; mNotch.Q.value = 2.2; mNotch.gain.value = -4;
    const mShelf = c.createBiquadFilter(); mShelf.type = 'highshelf'; mShelf.frequency.value = 9000; mShelf.gain.value = -6;
    maskIn.connect(maskDry); maskDry.connect(mixDuck);
    maskIn.connect(mLP); mLP.connect(mPeak); mPeak.connect(mNotch); mNotch.connect(mShelf);
    mShelf.connect(maskWet); maskWet.connect(mixDuck);
    // The comb is what sells it — a 0.42 ms delay nulling near 1.2 k / 3.6 k.
    let comb = null;
    if ((s?.tierIndex ?? 3) >= 2) {
      comb = c.createDelay(0.01);
      comb.delayTime.value = 0.00042;
      const combG = c.createGain();
      combG.gain.value = 0.32;
      mShelf.connect(comb); comb.connect(combG); combG.connect(maskWet);
      this._combGain = combG;
    }
    this._mask = { in: maskIn, dry: maskDry, wet: maskWet, lp: mLP, peak: mPeak, notch: mNotch, shelf: mShelf, comb };
    // Baseline: a subtle version of the shell, always on.
    this._maskBlend(0.34, 0);

    // S11 — pre-dawn ramps everything below 300 Hz out of the world.
    const dawnHP = c.createBiquadFilter();
    dawnHP.type = 'highpass';
    dawnHP.frequency.value = 20;
    dawnHP.Q.value = 0.7;
    dawnHP.connect(maskIn);
    this._dawnHP = dawnHP;

    // S9 — the pause filter. The forest is still there, behind glass, waiting.
    const pauseLP = c.createBiquadFilter();
    pauseLP.type = 'lowpass';
    pauseLP.frequency.value = 20000;
    pauseLP.Q.value = 0.7;
    pauseLP.connect(dawnHP);
    this._pauseLP = pauseLP;

    const mixBus = c.createGain();
    mixBus.connect(pauseLP);
    this._mixBus = mixBus;
    this._mixDuck = mixDuck;

    // ---- reverb returns (§3.3). Only ever two convolvers.
    const verbIn = c.createGain();
    const verbSum = c.createGain();
    verbSum.gain.value = 1;
    verbSum.connect(mixBus);
    const retA = c.createGain(); retA.gain.value = 1; retA.connect(verbSum);
    const retB = c.createGain(); retB.gain.value = 0; retB.connect(verbSum);
    const convA = c.createConvolver(); convA.normalize = false; convA.connect(retA);
    const convB = c.createConvolver(); convB.normalize = false; convB.connect(retB);
    verbIn.connect(convA);
    if ((s?.tierIndex ?? 3) >= 1) verbIn.connect(convB);
    this._verbIn = verbIn; this._convA = convA; this._convB = convB;
    this._retA = retA; this._retB = retB;

    // ---- buses
    const make = (name, dest, volume) => {
      const g = c.createGain();
      const duck = c.createGain();
      g.connect(duck);
      duck.connect(dest);
      g.gain.value = volume;
      return { name, gain: g, duck, input: g, send: null };
    };

    const sfxVol = s?.get('sfxVolume') ?? 1;
    const musicVol = s?.get('musicVolume') ?? 0.7;
    const voVol = s?.get('voiceVolume') ?? 0.85;

    // Glue compressor on world SFX only. Music and ambience are not compressed — their
    // dynamics are the point (§2.2).
    const sfxComp = c.createDynamicsCompressor();
    sfxComp.threshold.value = -18;
    sfxComp.knee.value = 12;
    sfxComp.ratio.value = 2.4;
    sfxComp.attack.value = 0.010;
    sfxComp.release.value = 0.25;
    sfxComp.connect(mixBus);
    this._sfxComp = sfxComp;

    const sfxWorld = make('sfxWorld', sfxComp, sfxVol);
    // The manual sounds like it is playing in a different, cleaner universe: dry, mono,
    // centred, no reverb, no distance, and never touched by the mask.
    const sfxUI = make('sfxUI', masterGain, sfxVol);
    const ambience = make('ambience', mixBus, sfxVol * 0.9);
    const music = make('music', mixBus, musicVol);
    const vo = make('vo', mixBus, voVol);
    const body = make('body', mixBus, sfxVol);

    // The ambience bed carries a permanent −4 dB notch at 3.1 kHz so every gameplay-critical
    // transient cuts through the forest without needing to be louder (§1.2).
    const ambNotch = c.createBiquadFilter();
    ambNotch.type = 'peaking';
    ambNotch.frequency.value = 3100;
    ambNotch.Q.value = 0.9;
    ambNotch.gain.value = -4;
    const ambLP = c.createBiquadFilter();
    ambLP.type = 'lowpass';
    ambLP.frequency.value = 20000;
    ambLP.Q.value = 0.7;
    ambience.gain.disconnect();
    ambience.gain.connect(ambNotch);
    ambNotch.connect(ambLP);
    ambLP.connect(ambience.duck);
    this._ambNotch = ambNotch;
    this._ambLP = ambLP;

    // Bus-level reverb sends (§3.3). sfxWorld sends per-voice instead, so it can override.
    const busSend = (b, level) => {
      const g = c.createGain();
      g.gain.value = level;
      b.duck.connect(g);
      g.connect(verbIn);
      b.send = g;
    };
    busSend(ambience, 0.10);
    busSend(music, 0.35);
    busSend(vo, 0.18);

    this.buses = {
      master: { name: 'master', gain: masterGain, duck: mixDuck, input: mixBus },
      sfxWorld, sfxUI, ambience, music, vo, body,
      // gameplay-facing aliases onto the same nodes
      sfx: sfxWorld, ui: sfxUI, amb: ambience, voice: vo,
    };
  }

  _buildVoices() {
    const n = this._maxVoices;
    for (let i = 0; i < n; i++) this._voices.push(new Voice(this, i));
    Log.debug(`Audio: ${n} voice slots, ${this._maxHrtf} HRTF.`);
  }

  async _loadImpulseResponses() {
    const s = this.settings;
    const tierIndex = s?.tierIndex ?? 3;
    // On `low` there is one convolver and one IR: a blend of the two forest spaces.
    const wanted = tierIndex <= 0 ? ['OPEN_FOREST'] : SPACES;
    for (const space of wanted) {
      if (!this.context) return;
      try {
        const ir = await renderImpulseResponse(space, this.context.sampleRate, { tierIndex });
        if (!ir || !this._convA) continue;
        this._irs.set(space, ir);
        if (space === 'OPEN_FOREST') {
          this._convA.buffer = ir;
          if (this._convB && !this._convB.buffer) this._convB.buffer = ir;
        }
      } catch (e) {
        Log.warn(`Audio: IR '${space}' unavailable:`, e?.message ?? e);
      }
    }
  }

  // =============================================================== public API

  /** The AudioContext's listener, driven from ctx.camera every frame. */
  get listener() { return this.context?.listener ?? null; }

  /**
   * §9.5 — `audio.bus('sfxWorld')`. Returns the input node of a bus so another audio
   * module (Music, VoiceBank) can connect its own graph into the mix.
   * @returns {GainNode|null}
   */
  bus(name) {
    const key = BUS_ALIAS[name] ?? name;
    const b = this.buses?.[key];
    return b ? b.input ?? b.gain : null;
  }

  busNode(name) { return this.bus(name); }

  /**
   * The input of the reverb network, for modules that build their own sources (VoiceBank's
   * VO chain, Music's pad) and want the current space's tail.
   * @returns {GainNode|null}
   */
  reverbSend() { return this._verbIn ?? null; }

  now() { return this.context?.currentTime ?? 0; }

  /**
   * Set a bus's user volume. Accepts 'master'|'sfx'|'music'|'vo'|'ambience' as well as the
   * long names from AUDIO_DIRECTION.md §2.1.
   */
  setBusVolume(name, v) {
    const key = BUS_ALIAS[name] ?? name;
    const b = this.buses?.[key];
    if (!b || !this.context) return;
    const value = clamp(Number(v) || 0, 0, 4);
    // Never assign .value on a live node (§9.2.1).
    b.gain.gain.setTargetAtTime(value, this.now(), 0.02);
  }

  getBusVolume(name) {
    const key = BUS_ALIAS[name] ?? name;
    return this.buses?.[key]?.gain.gain.value ?? 0;
  }

  /**
   * Play a sound.
   * @param {string} id
   * @param {{ position?: THREE.Vector3, volume?: number, rate?: number, detune?: number,
   *   priority?: number, bus?: string, loop?: boolean, reverb?: number, variant?: number,
   *   occlusion?: number, elevation?: number, rolloff?: number, refDistance?: number,
   *   noise?: object, fadeInMs?: number, when?: number }} [opts]
   * @returns {Voice|null} a handle, valid only while the sound is playing.
   */
  play(id, opts = {}) {
    if (!this.enabled || !this.sfx) return null;
    const resolved = resolveId(id);
    if (!resolved) {
      Log.once(`audio:id:${id}`, `audio: unknown sfx id '${id}'.`);
      return null;
    }
    const buf = opts.variant != null
      ? this.sfx.variant(resolved, opts.variant)
      : this.sfx.get(resolved, this.rand);
    if (!buf) return null;                       // still rendering — drop it, never stall
    const info = recipeInfo(resolved);
    const busName = opts.bus ?? (info?.family === 'ui' ? 'sfxUI' : 'sfxWorld');
    const spatial = !!opts.position && busName !== 'sfxUI' && busName !== 'body';

    const gainValue = opts.volume ?? 1;
    let distance = 0;
    if (spatial) {
      this._listenerPosition(_lis);
      distance = _tmp.copy(opts.position).distanceTo(_lis);
    }
    // `occ:false` opts out (ambience beds and the player's own body are never occluded).
    const occ = opts.occ === false || !spatial ? null
      : (opts.occ ?? (opts.occlusion != null ? this._occFromThickness(opts.occlusion) : this._occlusion(opts.position, distance)));

    return this._playBuffer(buf, {
      id: resolved,
      family: opts.family ?? info?.family ?? 'sfx',
      priority: opts.priority ?? info?.priority ?? 2,
      bus: busName,
      position: spatial ? opts.position : null,
      gain: gainValue,
      rate: opts.rate ?? 1,
      detune: opts.detune ?? 0,
      loop: !!opts.loop,
      reverb: opts.reverb,
      occ,
      distance,
      rolloff: opts.rolloff,
      refDistance: opts.refDistance,
      elevation: opts.elevation,
      when: opts.when,
      fadeInMs: opts.fadeInMs ?? 0,
    });
  }

  /** Positional convenience form. */
  playAt(id, position, opts = {}) {
    return this.play(id, { ...opts, position });
  }

  /** Stop a handle returned by play(). Always a fade — never a hard stop (§9.2). */
  stop(handle, fadeMs = 60) {
    if (!handle || handle.free) return;
    this._releaseVoice(handle, false, fadeMs);
  }

  stopAll(fadeMs = 80) {
    for (let i = 0; i < this._voices.length; i++) {
      const v = this._voices[i];
      if (!v.free) this._releaseVoice(v, false, fadeMs);
    }
  }

  /** §2.3 — duck a bus by dB with an attack / hold / release envelope. */
  duck(busName, dB, attackMs = 40, holdMs = 200, releaseMs = 800) {
    const b = this.buses?.[BUS_ALIAS[busName] ?? busName];
    if (!b || !this.context) return;
    const p = b.duck.gain;
    const now = this.now();
    const target = Math.max(MIN_G, dbToGain(-Math.abs(dB)));
    this._hold(p, now);
    p.setTargetAtTime(target, now, Math.max(0.005, attackMs / 3000));
    const back = now + (attackMs + holdMs) / 1000;
    p.setTargetAtTime(1, back, Math.max(0.02, releaseMs / 3000));
  }

  /**
   * Crossfade to a named reverb space and pin it there. Call with no argument to hand
   * control back to the probe.
   */
  reverbZone(name, fadeMs = null) {
    if (!this.context) return;
    if (name == null) { this._spaceLocked = false; return; }
    if (!SPACES.includes(name)) return;
    this._spaceLocked = true;
    this._setSpace(name, fadeMs);
  }

  _setSpace(name, fadeMs = null) {
    if (name === this._spaceTarget) return;
    const ir = this._irs.get(name);
    // Not rendered yet — leave the target alone so the probe retries in 250 ms.
    if (!ir) return;

    // Architectural transitions are abrupt, environmental ones are gradual (§3.3).
    const arch = name === 'CABIN_SHELL' || name === 'TIN_ROOF'
      || this._spaceTarget === 'CABIN_SHELL' || this._spaceTarget === 'TIN_ROOF';
    const fade = Math.max(0.05, (fadeMs ?? (arch ? 250 : 900)) / 1000);

    const toB = this._activeConv === 'A';
    const conv = toB ? this._convB : this._convA;
    const rise = toB ? this._retB : this._retA;
    const fall = toB ? this._retA : this._retB;
    if (!conv || !rise || !fall) return;
    if (this.settings?.tierIndex === 0) {
      // One convolver on `low`: swap the buffer, no crossfade — just a send-level dip.
      this._convA.buffer = ir;
      this._spaceTarget = name; this._space = name;
      return;
    }
    try { conv.buffer = ir; } catch { return; }
    const now = this.now();
    this._crossfade(rise.gain, fall.gain, now, fade);
    this._activeConv = toB ? 'B' : 'A';
    this._spaceTarget = name;
    this._space = name;
  }

  /** Doc alias (§9.5). `weight` is accepted and ignored — spaces do not blend, they cross. */
  setSpace(spaceId, weight = 1) {
    void weight;
    this.reverbZone(spaceId);
  }

  /** §2.5 / S10 — the shell. `enabled=false` returns to the always-present baseline. */
  setMask(enabled, fadeMs = 1400) {
    this._maskOn = !!enabled;
    this._maskBlend(this._maskOn ? 0.82 : 0.34, fadeMs);
  }

  // =============================================================== playback core

  _playBuffer(buf, o) {
    const c = this.context;
    if (!c || !buf) return null;
    // Kill anything under −60 dB before we build it. At 60 m in the rain, a cricket does
    // not need to exist (§9.3).
    if (o.gain < 1e-3) return null;

    const v = this._acquire(o.family, o.priority, o.gain, o.distance ?? 0);
    if (!v) return null;

    const now = c.currentTime;
    const when = Math.max(now + 0.02, o.when ?? 0);
    const busKey = BUS_ALIAS[o.bus] ?? o.bus ?? 'sfxWorld';
    const busObj = this.buses[busKey] ?? this.buses.sfxWorld;
    const spatial = !!o.position;

    // ---- the two-path occlusion split (§3.2). The direct path is occluded; the bleed path
    // models diffraction around the occluder, so a sound behind a wall becomes a dull thud
    // with no location rather than vanishing.
    const occ = o.occ ?? (o.occlusion ? this._occFromThickness(o.occlusion) : NO_OCC);
    this._set(v.directLP.frequency, occ.fc, now);
    this._set(v.directGain.gain, occ.gain, now);
    this._set(v.bleedGain.gain, occ.bleed > 0.02 ? dbToGain(clamp(-14 - 20 * occ.bleed, -40, -14)) : 0, now);

    // ---- elevation cue: HRTF elevation is weak, so we fake it with a shelf (§3.1)
    let shelf = 0;
    if (spatial) {
      this._listenerPosition(_lis);
      const dy = o.position.y - _lis.y;
      shelf = o.elevation ?? (dy > 2 ? 3 : dy < -2 ? -4 : 0);
    }
    this._set(v.tone.gain, shelf, now);

    // ---- panner
    if (spatial) {
      const p = v.panner;
      const far = (o.distance ?? 0) > 45;
      // Beyond 45 m HRTF cues are meaningless and rolloff dominates (§9.3).
      p.panningModel = (!far && v.index < this._maxHrtf) ? 'HRTF' : 'equalpower';
      p.refDistance = o.refDistance ?? REF_DISTANCE;
      p.rolloffFactor = o.rolloff ?? ROLLOFF.world;
      p.maxDistance = MAX_DISTANCE;
      this._setPannerPosition(p, o.position, now, 0);
      v.position.copy(o.position);
      v.hasPosition = true;
      v.tone.connect(p);
      v.panner.connect(v.out);
    } else {
      v.hasPosition = false;
      v.tone.connect(v.out);
    }

    // ---- routing
    v.out.gain.value = 1;
    v.out.connect(busObj.input ?? busObj.gain);
    const sendLevel = o.reverb ?? (busKey === 'sfxWorld' ? 0.22 : 0);
    if (sendLevel > 0.001 && this._verbIn) {
      v.send.gain.value = sendLevel;
      v.out.connect(v.send);
      v.send.connect(this._verbIn);
    }

    // ---- the source (the only node recreated per play)
    const pg = c.createGain();
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = !!o.loop;
    if (o.loop) { src.loopStart = 0; src.loopEnd = buf.duration; }
    src.playbackRate.value = clamp(o.rate ?? 1, 0.06, 6);
    if (o.detune) { try { src.detune.value = o.detune; } catch { /* no detune param */ } }
    src.connect(pg);
    pg.connect(v.gain);

    // The level is set *before* the source starts, so a hard transient stays hard without
    // a 0 ms envelope on a live node (§9.2.2).
    const g = Math.max(MIN_G, o.gain);
    if (o.fadeInMs > 0) {
      pg.gain.setValueAtTime(MIN_G, when);
      pg.gain.linearRampToValueAtTime(g, when + Math.max(0.005, o.fadeInMs / 1000));
    } else {
      pg.gain.setValueAtTime(g, Math.max(now, when - 0.005));
    }

    v.src = src;
    v.pg = pg;
    v.bus = busObj;
    v.id = o.id;
    v.loop = !!o.loop;
    v.sustained = !!o.loop;
    v.baseGain = g;
    v.distance = o.distance ?? 0;
    v.startedAt = when;
    v.endsAt = o.loop ? Infinity : when + buf.duration / (o.rate ?? 1) + 0.05;
    v.serial = ++_voiceSerial;

    if (!o.loop) src.onended = v._onEnded;
    try { src.start(when); } catch (e) { Log.once('audio:start', 'source.start failed', e); }

    this._remember(o.id, o.position);
    return v;
  }

  _acquire(family, priority, gainValue, distance) {
    // Per-family caps (§9.1).
    const cap = this._famCaps[family];
    if (cap != null && (this._famCount[family] ?? 0) >= cap) {
      const victim = this._weakest(family);
      if (!victim || victim.priority > priority) return null;
      this._releaseVoice(victim, false, 8);
    }

    let v = null;
    for (let i = 0; i < this._voices.length; i++) {
      if (this._voices[i].free) { v = this._voices[i]; break; }
    }
    if (!v) {
      const victim = this._weakest(null);
      if (!victim) return null;
      const mine = this._score(priority, gainValue, distance, 0);
      if (this._scoreOf(victim) >= mine) return null;
      this._releaseVoice(victim, false, 8);
      v = victim;
    }

    v.free = false;
    v.family = family;
    v.priority = priority;
    this._famCount[family] = (this._famCount[family] ?? 0) + 1;
    return v;
  }

  _score(priority, gainValue, distance, ageMs) {
    return priority * 1000 + 20 * Math.log10(Math.max(1e-5, gainValue))
      - 0.4 * distance - 0.001 * ageMs;
  }

  _scoreOf(v) {
    const age = (this.now() - v.startedAt) * 1000;
    return this._score(v.priority, v.baseGain, v.distance, age);
  }

  _weakest(family) {
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < this._voices.length; i++) {
      const v = this._voices[i];
      if (v.free) continue;
      if (family && v.family !== family) continue;
      if (v.priority >= 3) continue;                 // never stolen (§9.1)
      const s = this._scoreOf(v);
      if (s < bestScore) { bestScore = s; best = v; }
    }
    return best;
  }

  /**
   * Release a slot. A stolen or stopped voice is detached from the slot and allowed to fade
   * out dry into its own bus, so the slot's filters are free immediately and nothing ever
   * clicks (§9.1: release with a fade, never a stop).
   */
  _releaseVoice(v, fromEnded = false, fadeMs = 0) {
    if (v.free) return;
    v.free = true;
    v.gen++;
    if (v.family) this._famCount[v.family] = Math.max(0, (this._famCount[v.family] ?? 1) - 1);

    const now = this.now();
    const src = v.src;
    const pg = v.pg;
    const busNode = v.bus?.input ?? v.bus?.gain ?? null;
    v.src = null;
    v.pg = null;
    v.bus = null;
    v.sustained = false;
    v.hasPosition = false;

    if (src && pg && !fromEnded) {
      const fade = Math.max(0.008, fadeMs / 1000);
      try {
        pg.disconnect();
        if (busNode) pg.connect(busNode);
        this._hold(pg.gain, now);
        pg.gain.setTargetAtTime(MIN_G, now, fade / 3);
      } catch { /* graph already torn down */ }
      const stopAt = now + fade + 0.02;
      try { src.stop(stopAt); } catch { /* already stopped */ }
      src.onended = () => { try { src.disconnect(); pg.disconnect(); } catch { /* gone */ } };
    } else {
      try { src?.disconnect(); } catch { /* gone */ }
      try { pg?.disconnect(); } catch { /* gone */ }
      if (src) src.onended = null;
    }

    // Idle slots are disconnected from the bus so they cost nothing.
    try { v.tone.disconnect(); } catch { /* not connected */ }
    try { v.panner.disconnect(); } catch { /* not connected */ }
    try { v.out.disconnect(); } catch { /* not connected */ }
    try { v.send.disconnect(); } catch { /* not connected */ }
  }

  // --------------------------------------------------------------- param helpers

  _hold(param, now) {
    try { param.cancelAndHoldAtTime(now); }
    catch { try { param.cancelScheduledValues(now); } catch { /* unsupported */ } }
  }

  /** Filter/gain moves are always ramped — biquad coefficient jumps click too (§9.2.6). */
  _set(param, value, now, tau = 0.008) {
    if (!param) return;
    const v = Number.isFinite(value) ? value : 0;
    if (Math.abs(param.value - v) < 1e-5) return;
    try { param.setTargetAtTime(v, now, tau); }
    catch { try { param.value = v; } catch { /* frozen param */ } }
  }

  _setPannerPosition(p, pos, now, tau = 0.02) {
    if (!p || !pos) return;
    if (p.positionX) {
      if (tau <= 0) {
        try {
          p.positionX.setValueAtTime(pos.x, now);
          p.positionY.setValueAtTime(pos.y, now);
          p.positionZ.setValueAtTime(pos.z, now);
          return;
        } catch { /* fall through */ }
      }
      p.positionX.setTargetAtTime(pos.x, now, tau);
      p.positionY.setTargetAtTime(pos.y, now, tau);
      p.positionZ.setTargetAtTime(pos.z, now, tau);
    } else if (p.setPosition) {
      p.setPosition(pos.x, pos.y, pos.z);
    }
  }

  _maskBlend(wet, fadeMs) {
    if (!this._mask || !this.context) return;
    const now = this.now();
    const w = clamp01(wet);
    const tau = Math.max(0.01, fadeMs / 3000);
    this._set(this._mask.wet.gain, w, now, tau);
    this._set(this._mask.dry.gain, 1 - w * 0.85, now, tau);
  }

  _crossfade(rise, fall, now, dur) {
    try {
      rise.cancelScheduledValues(now);
      fall.cancelScheduledValues(now);
      rise.setValueCurveAtTime(XF_UP, now, dur);
      fall.setValueCurveAtTime(XF_DOWN, now, dur);
    } catch {
      this._set(rise, 1, now, dur / 3);
      this._set(fall, 0, now, dur / 3);
    }
  }

  _listenerPosition(out) {
    const cam = this.ctx?.camera;
    if (cam) out.setFromMatrixPosition(cam.matrixWorld);
    else out.set(0, 1.7, 0);
    return out;
  }

  /** Ring of recent plays, for de-duplicating a noise:emit against its own audio:sfx. */
  _remember(id, position) {
    const i = this._recentI;
    this._recentIds[i] = id;
    this._recentX[i] = position?.x ?? 0;
    this._recentZ[i] = position?.z ?? 0;
    this._recentT[i] = this.now();
    this._recentI = (i + 1) % this._recentIds.length;
  }

  _playedRecently(id, position, windowSec = 0.12, radius = 2) {
    const now = this.now();
    for (let i = 0; i < this._recentIds.length; i++) {
      if (this._recentIds[i] !== id) continue;
      if (now - this._recentT[i] > windowSec) continue;
      if (!position) return true;
      const dx = this._recentX[i] - position.x;
      const dz = this._recentZ[i] - position.z;
      if (dx * dx + dz * dz <= radius * radius) return true;
    }
    return false;
  }

  // =============================================================== events

  _bindEvents() {
    const b = this.events;
    if (!b) return;
    const on = (name, fn) => this._unsubs.push(b.on(name, Log.guard(`audio:${name}`, fn)));

    on('audio:sfx', (e) => this._onSfx(e));
    on('noise:emit', (e) => this._onNoise(e));
    on('player:footstep', (e) => this._onFootstep(e));
    on('player:move', (e) => {
      this._speed = Number(e?.speed) || 0;
      this._crouched = !!e?.crouched;
      this._lanternSqueak(e);
    });
    on('player:spotted', (e) => this._onSpotted(e));
    on('player:hidden', () => this._onHidden());

    on('build:creak', (e) => this._onCreak(e));
    on('build:place', (e) => this._onPlace(e));
    on('build:pickup', () => { this._playNear('lumber.hoist', 1.0); this._setBreath('heavy', 4); });
    on('build:drop', (e) => this._onDrop(e));
    on('build:remove', () => {
      // Undoing a mistake should feel like *relief*: dry, close, no reverb send.
      this._playNear('nail.pull', 1.0, { reverb: 0 });
    });
    on('build:stage-complete', () => this._clinicalPause());
    on('tool:missing', () => this.play('ui.deny', { bus: 'sfxUI' }));
    on('tool:found', () => this.play('ui.stamp', { bus: 'sfxUI' }));

    on('night:begin', () => this._firstBreathOfTheNight());
    on('night:complete', () => { this._restoreMix(2200); this._setBreath('calm'); });
    on('night:failed', () => this._theEnd());
    on('game:pause', () => this._pauseMix(true));
    on('game:resume', () => this._pauseMix(false));

    on('weather:change', (e) => this._onWeather(e));
    on('story:beat', (e) => { if (e?.id === 'mask-on') this._maskOnBeat(); });
    on('ui:blueprint-open', () => {
      this.duck('ambience', 9, 180, 100000, 400);
      this.duck('music', 14, 180, 100000, 400);
      this.duck('sfxWorld', 6, 180, 100000, 400);
      this.play('ui.page', { bus: 'sfxUI' });
    });
    on('ui:blueprint-close', () => {
      for (const n of ['ambience', 'music', 'sfxWorld']) this.duck(n, 0, 10, 0, 400);
      this.play('ui.page', { bus: 'sfxUI', rate: 1.08 });
    });
    on('ui:toast', () => this.play('ui.click', { bus: 'sfxUI' }));
    on('settings:changed', ({ key } = {}) => this._applyVolumes(key));

    // Lightning is not a canonical event; Weather/Sky may or may not emit one. We listen
    // defensively and never emit it ourselves.
    const onLightning = (e) => this._onLightning(e);
    for (const name of ['weather:lightning', 'sky:lightning', 'weather:flash']) on(name, onLightning);
  }

  _applyVolumes(key) {
    const s = this.settings;
    if (!s || !this.buses) return;
    if (!key || key === '*' || key === 'masterVolume') this.setBusVolume('master', s.get('masterVolume'));
    if (!key || key === '*' || key === 'sfxVolume') {
      const v = s.get('sfxVolume');
      this.setBusVolume('sfxWorld', v);
      this.setBusVolume('sfxUI', v);
      this.setBusVolume('body', v);
      this.setBusVolume('ambience', v * 0.9);
    }
    if (!key || key === '*' || key === 'musicVolume') this.setBusVolume('music', s.get('musicVolume'));
    if (!key || key === '*' || key === 'voiceVolume') this.setBusVolume('vo', s.get('voiceVolume'));
  }

  // --------------------------------------------------------------- sfx / noise

  _onSfx(e) {
    if (!e?.id) return;
    this.play(e.id, {
      position: e.position ?? null,
      volume: e.volume ?? 1,
      rate: e.rate ?? 1,
    });
  }

  /**
   * §1.3 — the contract. A noise:emit is a gameplay event AND a sound, and the two must
   * agree. We ask NoiseSystem for the exact audibility it gave the AI and mix to it,
   * deriving the occlusion filter from the same number so a sound behind a ridge is
   * muffled, not merely quieter.
   */
  _onNoise(e) {
    if (!this.enabled || !e || !e.position) return;
    const kind = e.kind ?? 'generic';
    if (kind === 'creak') return;                    // arrives via build:creak with its tier

    let id = NOISE_SFX[kind];
    if (id === null) return;                         // deliberately silent gameplay noise
    if (id === undefined) id = kind;                 // caller used an sfx id as the kind
    if (id === 'step') id = this._stepId(e.surface);
    const resolved = resolveId(id);
    if (!resolved) return;

    this._listenerPosition(_lis);
    _tmp.copy(e.position);
    const dist = _tmp.distanceTo(_lis);

    // The player's own footfall already sounded through player:footstep, and a sustained
    // action re-emits every frame — neither may double-trigger.
    const window = SUSTAINED_KINDS[kind] ?? 0.14;
    if (this._playedRecently(resolved, e.position, window, window > 0.5 ? 6 : 2.5)) return;
    if (dist < 1.6 && resolved.startsWith('step.')) return;

    const mix = this._noiseMix(e, dist);
    if (mix.rel < 1e-3) return;

    const info = recipeInfo(resolved);
    // Correct the asset's calibrated level to this event's exact intensity, so perceived
    // loudness is monotonic in `intensity` for every kind.
    const raw = Number(e.intensity);
    const intensity = Number.isFinite(raw) ? raw : 0.4;
    const adj = info?.peakDb != null
      ? dbToGain(clamp(noiseDbFor(intensity) - info.peakDb, -18, 12))
      : 1;

    this._playBuffer(this._pick(resolved), {
      id: resolved,
      family: info?.family ?? 'sfx',
      priority: info?.priority ?? 2,
      bus: 'sfxWorld',
      position: e.position,
      gain: mix.rel * adj,
      rate: kind === 'footstep-crouch' ? 0.85 : kind === 'footstep-run' ? 1.12 : 1,
      detune: this.rand.range(-140, 140),
      occ: mix.occ,
      distance: dist,
      // We have taken over the distance law; the panner is direction only.
      rolloff: ROLLOFF.flat,
      reverb: 0.22,
    });
  }

  _pick(id) {
    return this.sfx ? this.sfx.get(id, this.rand) : null;
  }

  /**
   * THE HANDSHAKE. Distance, occlusion and rain-masking for one noise event, expressed as
   * attenuation relative to the source's own 1 m level.
   *
   * `NoiseSystem.acousticsAt()` exists precisely for this: it returns the AI's own
   * `attenuation` together with the lowpass cutoff derived from the *same* occlusion walk.
   * Taking both means the sound the player hears and the number a camper acts on are the
   * same physics, not two models that happen to agree today.
   *
   * `audibilityAt()` is the fallback (older shape), then our own §3.2 model. Every path
   * returns { rel, occ } in the same units.
   */
  _noiseMix(e, dist) {
    this._listenerPosition(_lis);      // never trust a caller to have primed the scratch
    const distGain = REF_DISTANCE / (REF_DISTANCE + ROLLOFF.world * Math.max(0, dist - REF_DISTANCE));
    const intensity = clamp(Number(e.intensity) || 1, 1e-3, 1);
    const ns = this.ctx?.systems?.get?.('NoiseSystem');

    if (ns && typeof ns.acousticsAt === 'function') {
      let a = null;
      try { a = ns.acousticsAt(_lis, e); } catch { a = null; }
      const heard = Number(a?.attenuation ?? a?.heard);
      if (Number.isFinite(heard)) {
        // `heard = intensity · falloff · occlusion · (1 − mask)`, so dividing out the
        // event's own intensity leaves exactly the path's attenuation.
        _mix.rel = clamp01(heard / intensity);
        const clarity = Number.isFinite(a?.occlusion) ? clamp01(a.occlusion) : 1;
        copyOcc(this._occFromClarity(clarity, dist, ns), _mix.occ);
        if (Number.isFinite(a?.lowpassHz)) _mix.occ.fc = clamp(a.lowpassHz, 180, 18000);
        return _mix;
      }
    }

    if (ns && typeof ns.audibilityAt === 'function') {
      let a = null;
      try { a = ns.audibilityAt(_lis, e); } catch { a = null; }
      if (a && typeof a === 'object') a = a.audibility ?? a.gain ?? a.value ?? a.level ?? null;
      if (Number.isFinite(a) && a >= 0) {
        // The older shape may or may not fold `intensity` in; normalize either way.
        const rel = clamp01(a <= intensity * 1.02 ? a / intensity : Math.min(1, a));
        _mix.rel = rel;
        // Whatever attenuation is not explained by distance is occlusion — and occlusion
        // must be heard as *muffling*, not merely as quiet.
        const ratio = clamp(rel / Math.max(distGain, 1e-5), 1e-4, 1);
        copyOcc(this._occFromThickness(clamp(-20 * Math.log10(ratio) / 3.2, 0, 12)), _mix.occ);
        return _mix;
      }
    }

    // No NoiseSystem: our own model, so the mix still behaves the way the AI would.
    const occ = this._occlusion(e.position, dist);
    _mix.rel = clamp01(distGain * occ.gain);
    copyOcc(occ, _mix.occ);
    return _mix;
  }

  /**
   * The two-path occlusion filter for one source→listener path, as {gain, fc, bleed}.
   *
   * Prefers NoiseSystem's own occlusion walk — it is the same walk the campers hear through,
   * so the mix and the AI physically cannot disagree. Falls back to the §3.2 analytic model
   * from the forest density grid. We never spend a raycast of our own.
   */
  _occlusion(position, dist = -1) {
    _occ.gain = 1; _occ.fc = 18000; _occ.bleed = 0;
    if (!position) return _occ;
    this._listenerPosition(_lis);
    const d = dist >= 0 ? dist : _tmp.copy(position).distanceTo(_lis);
    const ns = this.ctx?.systems?.get?.('NoiseSystem');

    if (ns && typeof ns.occlusionBetween === 'function') {
      let occ = null;
      try { occ = ns.occlusionBetween(_lis, position); } catch { occ = null; }
      if (occ && typeof occ === 'object') occ = occ.occlusion ?? occ.value ?? null;
      if (Number.isFinite(occ)) return this._occFromClarity(clamp01(occ), d, ns);
    }

    // Analytic: canopy contributes ~0.10 of effective thickness per metre of path inside it.
    const forest = this.ctx?.systems?.get?.('Forest');
    const dens = forest && typeof forest.densityAt === 'function'
      ? Number(forest.densityAt(position.x, position.z)) : NaN;
    const T = Number.isFinite(dens)
      ? clamp(dens * Math.min(d, 60) * 0.02, 0, 6)
      : clamp(Math.min(d, 60) * 0.006, 0, 1.2);
    return this._occFromThickness(T);
  }

  /** NoiseSystem's clarity scalar (1 = clear line, 0 = solid) → our filter triple. */
  _occFromClarity(occ, d, ns) {
    const clarity = clamp(occ, 0.01, 1);
    _occ.gain = clarity;
    _occ.bleed = 1 - clarity;
    let fc = null;
    if (typeof ns?.lowpassFor === 'function') {
      try { fc = ns.lowpassFor(clarity, d); } catch { fc = null; }
    }
    _occ.fc = Number.isFinite(fc) ? clamp(fc, 180, 18000) : clamp(18000 * Math.pow(clarity, 2.2), 180, 18000);
    return _occ;
  }

  /** §3.2's model, for when nobody can tell us what is in the way. */
  _occFromThickness(T) {
    const t = clamp(T, 0, 14);
    _occ.gain = dbToGain(clamp(-3.2 * t, -34, 0));
    _occ.fc = clamp(18000 * Math.exp(-0.55 * t), 180, 18000);
    _occ.bleed = t > 0.02 ? 1 - Math.exp(-0.55 * t) : 0;
    return _occ;
  }

  _stepId(surface) {
    const key = String(surface ?? 'pine').toLowerCase();
    return SURFACE_SFX[key] ?? 'step.pine';
  }

  _onFootstep(e) {
    if (!this.enabled) return;
    const id = this._stepId(e?.surface);
    const raw = Number(e?.loud);
    const loud = clamp01(Number.isFinite(raw) ? raw : 0.5);
    // −10 dB crouching through +8 dB running, around the walk-calibrated asset.
    const gainDb = -10 + 18 * loud;
    this._foot = 1 - (this._foot ?? 0);
    const v = this.play(id, {
      volume: dbToGain(gainDb),
      rate: 0.85 + 0.3 * loud,
      // Left/right alternate ±1.5 semitones so the gait is organic without limping.
      detune: (this._foot ? 150 : -150) + this.rand.range(-70, 70),
      position: e?.position ?? null,
      rolloff: ROLLOFF.flat,
      refDistance: 1.0,
      reverb: 0.16,
      priority: 3,
      occ: false,          // his own boots are not behind a tree from him
    });
    this._remember(resolveId(id), e?.position);

    // The lantern is the player's light and their liability.
    if (loud > 0.22 && this.sfx?.has('glass.ping')) {
      const n = Math.round(2 + 3 * loud) + (id === 'step.tin' || id === 'step.gravel' ? 1 : 0);
      const base = this.now() + 0.02;
      for (let i = 0; i < n; i++) {
        this.play('glass.ping', {
          volume: dbToGain(-30 + 10 * loud + (id === 'step.tin' ? 4 : 0)),
          when: base + this.rand.range(0, 0.035),
          rate: this.rand.range(0.94, 1.07),
          bus: 'body',
          priority: 0,
          family: 'lantern',
        });
      }
    }
    return v;
  }

  /**
   * §4.2 — the lantern's bail. The faster you move, the more you squeak; crouch-walking
   * never does. This is the game's stamina-vs-stealth dial and it is entirely audible.
   */
  _lanternSqueak(e) {
    if (!this.enabled || this._crouched || !this._lanternOn) return;
    const speed = this._speed;
    if (speed < 1.9) return;
    const now = this.now();
    if (now < (this._nextSqueak ?? 0)) return;
    this._nextSqueak = now + clamp(1.25 - 0.2 * speed, 0.3, 1.2) * this.rand.range(0.8, 1.3);
    this.play('lantern.squeak', {
      volume: dbToGain(clamp(-4 + 2 * speed, -6, 2)),
      rate: 1 + 0.14 * speed,
      priority: 1,
      family: 'lantern',
      reverb: 0.14,
    });
    void e;
  }

  _playNear(id, volume = 1, opts = {}) {
    this._listenerPosition(_lis);
    _v.copy(_lis);
    const cam = this.ctx?.camera;
    if (cam) { cam.getWorldDirection(_fwd); _v.addScaledVector(_fwd, 1.1).setY(_lis.y - 0.3); }
    return this.play(id, {
      position: _v, rolloff: ROLLOFF.flat, refDistance: 1.0, volume, occ: false, ...opts,
    });
  }

  // --------------------------------------------------------------- build

  _onCreak(e) {
    if (!this.enabled || !this.sfx) return;
    const severity = clamp01(Number(e?.severity) || 0);
    const tier = creakTier(severity);
    const size = Number(e?.size) || (2.4 + (tier - 1) * 0.6);
    const buf = this.sfx.creak(severity, size, this.rand);
    if (!buf) return;

    const pos = e?.position ?? null;
    let dist = 0;
    let occ = null;
    if (pos) {
      this._listenerPosition(_lis);
      dist = _tmp.copy(pos).distanceTo(_lis);
      occ = this._occlusion(pos, dist);
    }

    // §2.3 — a serious creak takes the room with it.
    if (tier >= 3) {
      this.duck('music', 12, 40, 300, 1200);
      this.duck('ambience', 8, 40, 300, 1200);
      this._cutCrickets(4 + tier);
    } else if (tier === 2) {
      this._dipCrickets(0.4, 2.5);
    }

    this._playBuffer(buf, {
      id: `creak.t${tier}`,
      family: 'creak',
      priority: tier >= 2 ? 3 : 2,
      bus: 'sfxWorld',
      position: pos,
      gain: 1,
      rate: 1,
      detune: this.rand.range(-60, 60),
      occ,
      distance: dist,
      reverb: tier >= 3 ? 0.34 : 0.22,
    });

    if (tier === 4) this._setBreath('fear', 8);
  }

  /** S3 — the naked creak. The mistake must be the only thing in the world for 180 ms. */
  _onPlace(e) {
    if (!this.enabled) return;
    if (e?.correct === false) {
      for (const n of ['ambience', 'music', 'sfxWorld', 'vo', 'body']) this.duck(n, 18, 20, 180, 900);
      this._holdVoice(1100, 'S3 naked creak');
      return;
    }
    // The seat. The most satisfying sound in the game, mixed a couple of dB louder than it
    // strictly needs to be. (Music's reward note is Music's own business — it listens to
    // build:place itself; audio never reaches into another module's scheduler.)
    this._playNear('screw.seat', 1.0, { reverb: 0.08, priority: 3 });
  }

  _onDrop(e) {
    const pos = e?.part?.position ?? e?.position ?? null;
    if (pos) {
      this.play('lumber.drop', { position: pos, priority: 2 });
    } else {
      this._playNear('lumber.drop', 1.0);
    }
    this._setBreath('walk');
  }

  // --------------------------------------------------------------- silence rules (§8)

  /** S1 — the first breath of the night: 2.2 s of absolute silence, then the bed arrives. */
  _firstBreathOfTheNight() {
    if (!this.context) return;
    const now = this.now();
    this._hardMute(true, 0.05);
    this._ambTargets(0, 0, 0, 0.05);
    this._holdVoice(8200, 'S1 first breath');
    this._cricketCut = 1;
    this._cricketClearAt = now + 6.4;
    this._after(2.2, () => {
      this._hardMute(false, 0.35);
      // Wind first, then the distance layer, then the crickets last (staggered, §5.4).
      this._ambTargets(1, 0, 0, 2.4);
      this._after(2.0, () => this._ambTargets(1, 1, 0, 2.4));
    });
    this._setBreath('calm');
  }

  /**
   * S6 — the clinical pause. 1.4 s of complete silence, then the manual's chime alone and
   * dry in a room that does not exist, then the wet dark night resumes as if nothing
   * happened. Do not add a sting. Do not sell it. The deadpan is the joke.
   */
  _clinicalPause() {
    if (!this.context) return;
    this._hardMute(true, 0.05, false);
    this._holdVoice(3600, 'S6 clinical pause');
    this._after(1.4, () => {
      this.play('ui.chime', { bus: 'sfxUI', priority: 3, volume: 1 });
      this._after(0.34, () => this._restoreMix(1800));
    });
  }

  /** S7 — the end. 900 ms of true digital silence, and then nothing until the menu. */
  _theEnd() {
    if (!this.context) return;
    this.stopAll(30);
    this._hardMute(true, 0.03, true);
    this._ambTargets(0, 0, 0, 0.03);
    this._silenceRule = 'S7';
    this._holdVoice(600000, 'S7 the end');
    this._cricketClearAt = this.now() + 3600;
    this._setBreath('calm');
    this._after(0.9, () => {
      // Then one note, from Music, ringing into OPEN_FOREST for eleven seconds. We only
      // unmute the bus so it can be heard; we never fill the hole ourselves.
      this._hardMute(false, 0.2, true);
      this._ambTargets(0, 0, 0, 0.1);
    });
  }

  /** S9 — the pause. Do not silence: the forest is still there, behind glass, waiting. */
  _pauseMix(paused) {
    if (!this.context) return;
    const now = this.now();
    this._set(this._pauseLP.frequency, paused ? 900 : 20000, now, paused ? 0.13 : 0.2);
    const p = this._mixDuck.gain;
    this._hold(p, now);
    p.setTargetAtTime(paused ? dbToGain(-20) : 1, now, 0.13);
  }

  /** S10 — the mask. The world goes away, you hear yourself, the world comes back wrong. */
  _maskOnBeat() {
    if (this._maskOn || !this.context) return;
    this._hardMute(true, 0.12, false);
    this._holdVoice(2000, 'S10 the mask');
    this.duck('body', -6, 200, 1600, 900);
    this._after(0.4, () => {
      this._restoreMix(1400);
      this.setMask(true, 1400);
    });
  }

  /** §2.4 — The Held Breath. The signature mix move of the game. */
  _onSpotted(e) {
    const level = Number(e?.level);
    if (Number.isFinite(level) && level <= 0.35) return;
    if (this._held) { this._heldUntil = this.now() + 6; return; }
    this._held = true;
    this._heldUntil = this.now() + 6;
    const now = this.now();

    this.duck('ambience', 14, 200, 100000, 2600);
    this._set(this._ambLP.frequency, 2200, now, 0.23);
    this._set(this._limiter.threshold, -12, now, 0.2);
    this._set(this._sfxComp.threshold, -26, now, 0.2);
    this._setBreath('held');
    this._heart.open = true;
    this._cutCrickets(8);
    this._holdVoice(4000, 'held-breath');

    // The one place we override the score: being seen is not a gradient.
    const music = this.ctx?.systems?.get?.('Music');
    if (typeof music?.setDread === 'function') { try { music.setDread(1); } catch { /* optional */ } }
  }

  _onHidden() {
    if (!this._held) return;
    this._held = false;
    const now = this.now();
    // The player's body recovers before the world does.
    this.duck('ambience', 0, 10, 0, 2600);
    this._set(this._ambLP.frequency, 20000, now, 0.9);
    this._set(this._limiter.threshold, -6, now, 0.6);
    this._set(this._sfxComp.threshold, -18, now, 0.6);
    this._heart.open = false;
    this._setBreath(this._speed > 2.4 ? 'heavy' : 'walk');
    // Hand the score back its own judgement.
    const music = this.ctx?.systems?.get?.('Music');
    if (typeof music?.setDread === 'function') { try { music.setDread(null); } catch { /* optional */ } }
  }

  /** §8 — VO stops entirely during any silence rule except S9. VoiceBank exposes the gate. */
  _holdVoice(ms, reason) {
    const vb = this.ctx?.systems?.get?.('VoiceBank');
    if (typeof vb?.holdVoice === 'function') {
      try { vb.holdVoice(ms, reason); } catch { /* optional system */ }
    }
  }

  // --------------------------------------------------------------- weather

  _onWeather(e) {
    this._rain = clamp01(Number(e?.rain) || 0);
    const w = Number(e?.wind);
    if (Number.isFinite(w)) this._wind = clamp01(w);
  }

  /** S4 — the gap before the thunder. The flash whites out the screen and the world stops. */
  _onLightning(e) {
    if (!this.enabled) return;
    const distance = clamp(Number(e?.distance) || this.rand.range(600, 3400), 60, 9000);
    const delay = distance / 343;
    for (const n of ['ambience', 'music', 'sfxWorld', 'vo']) {
      this.duck(n, 14, 110, delay * 1000, 260);
    }
    this._cutCrickets(delay + 2);
    const id = distance < 400 ? 'thunder.near' : distance < 2000 ? 'thunder.mid' : 'thunder.far';
    const when = this.now() + delay;
    this._after(Math.max(0, delay - 0.1), () => {
      // Thunder is not panned by distance — a 4 km source has no parallax (§3.1).
      this.play(id, {
        bus: 'sfxWorld',
        volume: 1,
        when,
        priority: 3,
        family: 'thunder',
        reverb: distance > 2000 ? 0.7 : 0.3,
      });
      this.duck('ambience', 5, 5, 200, 1400);
      // Every thunder also modulates the wind: a gust arriving 1.5 s later.
      this._after(1.5, () => { this._gust = Math.min(1, this._gust + 0.4); });
    });
  }

  // --------------------------------------------------------------- mix helpers

  _hardMute(on, fadeSec = 0.05, includeUI = false) {
    if (!this.context) return;
    const now = this.now();
    const p = this._mixDuck.gain;
    this._hold(p, now);
    p.setTargetAtTime(on ? MIN_G : 1, now, Math.max(0.008, fadeSec / 3));
    if (includeUI && this.buses?.sfxUI) {
      const u = this.buses.sfxUI.duck.gain;
      this._hold(u, now);
      u.setTargetAtTime(on ? MIN_G : 1, now, Math.max(0.008, fadeSec / 3));
    }
  }

  _restoreMix(ms = 1800) {
    if (!this.context) return;
    const now = this.now();
    for (const name of BUS_NAMES) {
      const p = this.buses[name]?.duck.gain;
      if (!p) continue;
      this._hold(p, now);
      p.setTargetAtTime(1, now, Math.max(0.02, ms / 3000));
    }
    const p = this._mixDuck.gain;
    this._hold(p, now);
    p.setTargetAtTime(1, now, Math.max(0.02, ms / 3000));
    this._silenceRule = null;
  }

  /** A cancellable one-shot timer that dispose() will clear. */
  _after(sec, fn) {
    const t = setTimeout(() => {
      this._timers.delete(t);
      try { fn(); } catch (e) { Log.once('audio:timer', 'audio timer threw:', e); }
    }, Math.max(0, sec * 1000));
    this._timers.add(t);
    return t;
  }

  // =============================================================== §5 the bed
  //
  // We build the bed in order to be able to take it away.

  _startAmbience() {
    if (this._amb || !this.enabled || !this.context) return;
    const c = this.context;
    const dest = this.buses.ambience.input;
    const pink = this.sfx.noise('pink', 4);
    const brown = this.sfx.noise('brown', 4);
    if (!pink || !brown) return;

    const loopSrc = (buf, rate = 1) => {
      const s = c.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.playbackRate.value = rate;
      try { s.start(c.currentTime + 0.05, this.rand.range(0, Math.max(0.1, buf.duration - 0.5))); }
      catch { /* already started */ }
      return s;
    };

    const amb = {
      srcs: [], nodes: [], bands: [], rain: {}, walkT: 0,
    };

    // ---- wind through pines (§4.13): three bands plus a sizzle, each with an INDEPENDENT
    // random walk. The independence is the whole trick — one correlated envelope is a fan.
    const gustLP = c.createBiquadFilter();
    gustLP.type = 'lowpass';
    gustLP.frequency.value = 3000;
    gustLP.Q.value = 0.6;
    const windGain = c.createGain();
    windGain.gain.value = 0;
    gustLP.connect(windGain);
    windGain.connect(dest);
    amb.gustLP = gustLP;
    amb.windGain = windGain;

    const bandSpec = [
      { f: 380, Q: 0.75, base: 1.00, rate: 1.000 },
      { f: 1150, Q: 1.10, base: 0.62, rate: 1.017 },
      { f: 2700, Q: 1.40, base: 0.40, rate: 0.987 },
    ];
    for (let i = 0; i < bandSpec.length; i++) {
      const sp = bandSpec[i];
      const src = loopSrc(pink, sp.rate);
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = sp.f;
      bp.Q.value = sp.Q;
      const g = c.createGain();
      g.gain.value = sp.base * 0.5;
      src.connect(bp); bp.connect(g);
      // The high band is the most directional in reality; drifting it moves the wind
      // across the map.
      if (i === 2 && c.createStereoPanner) {
        const pan = c.createStereoPanner();
        g.connect(pan); pan.connect(gustLP);
        amb.windPan = pan;
      } else {
        g.connect(gustLP);
      }
      amb.srcs.push(src);
      amb.bands.push({ gain: g, base: sp.base, filter: bp, f: sp.f });
    }
    {
      const src = loopSrc(pink, 1.031);
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5200;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 7400; bp.Q.value = 0.6;
      const g = c.createGain(); g.gain.value = 0.16 * 0.5;
      src.connect(hp); hp.connect(bp); bp.connect(g); g.connect(gustLP);
      amb.srcs.push(src);
      amb.bands.push({ gain: g, base: 0.16, filter: bp, f: 7400, sizzle: true });
    }

    // ---- room tone. Inaudible in isolation; its absence is audible.
    {
      const src = loopSrc(brown, 0.997);
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 180; lp.Q.value = 0.6;
      const g = c.createGain(); g.gain.value = dbToGain(-44);
      src.connect(lp); lp.connect(g); g.connect(dest);
      amb.srcs.push(src);
      amb.roomTone = g;
    }

    // ---- the distance layer: the sound of a very large amount of air. This is what makes
    // the forest feel like it extends past the draw distance.
    {
      const src = loopSrc(pink, 0.941);
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 620; bp.Q.value = 0.4;
      const g = c.createGain(); g.gain.value = 0;
      src.connect(bp); bp.connect(g); g.connect(dest);
      if (this._verbIn) {
        const send = c.createGain();
        send.gain.value = 0.55;
        g.connect(send); send.connect(this._verbIn);
        amb.distanceSend = send;
      }
      amb.srcs.push(src);
      amb.distance = g;
    }

    // ---- rain (§4.12): three surface models, blended by what is overhead.
    for (const [key, id] of [['leaves', 'rain.leaves'], ['tin', 'rain.tin'], ['water', 'rain.water']]) {
      const buf = this.sfx.get(id, this.rand);
      if (!buf) continue;
      const g = c.createGain();
      g.gain.value = 0;
      g.connect(dest);
      const a = loopSrc(buf, 1.0);
      const b = loopSrc(buf, 1.041);          // two decorrelated passes: no audible loop
      a.connect(g); b.connect(g);
      amb.srcs.push(a, b);
      amb.rain[key] = g;
      if (key === 'tin' && this._verbIn) {
        const send = c.createGain(); send.gain.value = 0.45;
        g.connect(send); send.connect(this._verbIn);
        amb.tinSend = send;
      }
    }

    // ---- the lantern's gas hiss. Always on, and the player will stop hearing it in 90
    // seconds. When it goes out, its absence is deafening (S8).
    {
      const buf = this.sfx.get('lantern.hiss', this.rand);
      if (buf) {
        const src = loopSrc(buf, 1);
        const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2350; bp.Q.value = 0.85;
        const g = c.createGain(); g.gain.value = dbToGain(-38);
        src.connect(bp); bp.connect(g); g.connect(dest);
        amb.srcs.push(src);
        amb.lantern = g;
        amb.lanternBP = bp;
      }
    }

    // ---- crickets: the proximity sensor, and the thing we take away.
    const cricketGain = c.createGain();
    cricketGain.gain.value = 1;
    cricketGain.connect(dest);
    this.buses.cricket = { name: 'cricket', gain: cricketGain, duck: cricketGain, input: cricketGain };
    const n = this.settings ? this.settings.tier(3, 5, 8, 10) : 8;
    const instances = [];
    for (let i = 0; i < n; i++) {
      instances.push({
        angle: this.rand.range(0, Math.PI * 2),
        radius: this.rand.range(6, 24),
        drift: this.rand.range(-0.05, 0.05),
        next: 0,
        returnAt: 0,
        pos: new THREE.Vector3(),
      });
    }
    // Instances beyond 25 m share a single distant wash, to save voices.
    let wash = null;
    const washBuf = this.sfx.get('cricket.wash', this.rand);
    if (washBuf) {
      const g = c.createGain();
      g.gain.value = dbToGain(-46);
      g.connect(cricketGain);
      const src = loopSrc(washBuf, 1);
      src.connect(g);
      amb.srcs.push(src);
      wash = g;
    }
    this._crickets = { gain: cricketGain, instances, wash, cut: 0 };

    this._amb = amb;
    this._ambTargets(1, 1, 1, 3.0);
    Log.debug('Audio: ambience bed online.');
  }

  /** Stage the bed's three always-on layers. Used by S1 and S7. */
  _ambTargets(wind, distance, crickets, tau = 1.0) {
    const a = this._amb;
    if (!a || !this.context) return;
    const now = this.now();
    this._ambWindTarget = wind;
    this._set(a.windGain.gain, wind * dbToGain(-40 + 26 * this._wind), now, tau / 3);
    this._set(a.distance.gain, distance * dbToGain(-42), now, tau / 3);
    if (a.roomTone) this._set(a.roomTone.gain, Math.max(wind, distance) > 0 ? dbToGain(-44) : MIN_G, now, tau / 3);
    if (this._crickets) {
      this._cricketCut = 1 - clamp01(crickets);
      this._set(this._crickets.gain.gain, clamp01(crickets), now, tau / 3);
    }
  }

  /** §5.4 — full stop. They do not come back for 6 s after the last condition clears. */
  _cutCrickets(seconds = 4) {
    this._cricketClearAt = Math.max(this._cricketClearAt, this.now() + seconds);
    if (!this._crickets) return;
    this._cricketCut = 1;
    this._set(this._crickets.gain.gain, MIN_G, this.now(), 0.11);
  }

  _dipCrickets(depth = 0.4, seconds = 2.5) {
    if (!this._crickets) return;
    this._cricketClearAt = Math.max(this._cricketClearAt, this.now() + seconds);
    this._cricketCut = clamp01(depth);
    this._set(this._crickets.gain.gain, 1 - clamp01(depth), this.now(), 0.11);
  }

  _updateAmbience(dt, now) {
    const a = this._amb;
    if (!a) return;
    // S7: after `night:failed` nothing ever comes back. Not the rain, not the room tone.
    const dead = this._silenceRule === 'S7';

    // Independent random walks on the wind bands (every 400–900 ms per band).
    a.walkT -= dt;
    if (a.walkT <= 0) {
      a.walkT = this.rand.range(0.4, 0.9);
      const windLevel = this._ambWindTarget ?? 1;
      for (let i = 0; i < a.bands.length; i++) {
        const b = a.bands[i];
        // A hard wind is a hiss; a soft wind is a sigh — the top bands rise faster.
        const tilt = b.sizzle || b.f > 2000 ? Math.pow(clamp01(this._wind), 0.7) / Math.max(0.05, this._wind) : 1;
        const target = b.base * (0.55 + 0.9 * this.rand.next()) * 0.5 * tilt * windLevel;
        this._set(b.gain.gain, target, now, 0.35);
        if (!b.sizzle) this._set(b.filter.frequency, b.f * this.rand.range(0.9, 1.12), now, 0.5);
      }
      if (a.windPan) this._set(a.windPan.pan, this.rand.range(-0.35, 0.35), now, 1.2);
      // Above wind 0.75 a trunk resonates. The first time a player hears it they will think
      // it is a voice.
      if (!dead && this._wind > 0.75 && this.rand.chance(0.10)) {
        this._listenerPosition(_lis);
        _v.set(_lis.x + this.rand.range(-14, 14), _lis.y + 6, _lis.z + this.rand.range(-14, 14));
        this.play('wind.whistle', {
          position: _v, volume: dbToGain(-10), bus: 'ambience', priority: 1, reverb: 0.4, occ: false,
        });
      }
    }

    this._gust = clamp01(this._gust * 0.985 + (this.rand.next() < 0.02 ? this.rand.range(0, 0.5) : 0));
    // Gusts open the top end — that is what makes a gust *arrive*.
    this._set(a.gustLP.frequency, 900 + 6500 * this._gust * clamp01(this._wind + 0.2), now, 0.3);
    this._set(a.windGain.gain, (this._ambWindTarget ?? 1) * dbToGain(-40 + 26 * this._wind), now, 0.5);

    // Rain, blended by what is overhead.
    const r = dead ? 0 : this._rain;
    const underRoof = this._space === 'TIN_ROOF';
    const nearWater = this._space === 'LAKE_EDGE';
    if (a.rain.leaves) this._set(a.rain.leaves.gain, r > 0.01 ? dbToGain(-34 + 22 * r) * (underRoof ? 0.35 : 1) : MIN_G, now, 0.6);
    if (a.rain.tin) this._set(a.rain.tin.gain, r > 0.01 && underRoof ? dbToGain(-30 + 24 * r) : MIN_G, now, 0.5);
    if (a.rain.water) this._set(a.rain.water.gain, r > 0.01 && nearWater ? dbToGain(-36 + 18 * r) : MIN_G, now, 0.8);

    // S8 — the world gets quieter when you cannot see it.
    if (a.lantern) {
      this._set(a.lantern.gain, this._lanternOn ? dbToGain(-38) : MIN_G, now, this._lanternOn ? 0.1 : 0.23);
      this._set(a.lanternBP.frequency, this._lanternOn ? 2350 : 500, now, 0.23);
    }
    this._set(this._ambLP.frequency, this._held ? 2200 : (this._lanternOn ? 20000 : 3200), now, 0.3);
  }

  _updateCrickets(now) {
    const cr = this._crickets;
    if (!cr || this._silenceRule === 'S7') return;
    const state = this.ctx?.state;

    // Causally honest: only real proximity, real suspicion, or a real event cuts them.
    const near = this._nearestCamper < 14;
    const suspicious = (state?.suspicion ?? 0) > 0.7;
    const chasing = state?.phase === 'chase';
    const active = near || suspicious || chasing || now < this._cricketClearAt;

    if (active) {
      if (this._cricketCut < 1) {
        this._cricketCut = 1;
        this._set(cr.gain.gain, MIN_G, now, 0.11);
        // A forest does not switch back on: schedule the staggered return, nearest last.
        const n = cr.instances.length;
        for (let i = 0; i < n; i++) cr.instances[i].returnAt = 0;
      }
      this._cricketReturnT = now + 6.0;
      return;
    }
    if (this._cricketCut > 0 && now >= this._cricketReturnT) {
      this._cricketCut = 0;
      this._set(cr.gain.gain, 1, now, 0.4);
      const n = cr.instances.length;
      for (let i = 0; i < n; i++) {
        // Staggered over 4 s, nearest last — the exhale of the whole game.
        const inst = cr.instances[i];
        const order = 1 - clamp01(inst.radius / 40);
        inst.returnAt = now + order * 4.0;
      }
    }
    if (this._cricketCut > 0) return;

    // Dolbear's Law. The night cools, so the forest gets slower and lonelier as the week
    // goes on, and nobody will consciously notice why.
    const night = clamp(state?.night ?? 1, 1, 7);
    const t = clamp01(state?.timeOfNight ?? 0);
    const warm = 68 - (night - 1) * (10 / 6);
    const fall = 13 + (night - 1) * (2 / 6);
    const tempF = warm - fall * t - (this._rain > 0.3 ? 4 : 0);
    const perMin = clamp(4 * (tempF - 50) + 40, 24, 160);
    const period = 60 / perMin;

    this._listenerPosition(_lis);
    for (let i = 0; i < cr.instances.length; i++) {
      const inst = cr.instances[i];
      if (now < inst.returnAt) continue;
      if (inst.next === 0) { inst.next = now + this.rand.range(0, period); continue; }
      if (now < inst.next) continue;
      inst.next = now + period * this.rand.range(0.75, 1.35);
      inst.angle += inst.drift;
      inst.pos.set(
        _lis.x + Math.cos(inst.angle) * inst.radius,
        _lis.y - 1.2,
        _lis.z + Math.sin(inst.angle) * inst.radius,
      );
      this.play('cricket.chirp', {
        position: inst.pos,
        bus: 'cricket',
        occ: false,
        volume: dbToGain(-38 + 12),
        rate: this.rand.range(0.94, 1.07),
        priority: 0,
        family: 'cricket',
        rolloff: 0.9,
        refDistance: 4,
        reverb: 0.12,
      });
    }

    // Wildlife punctuation. Rationed hard: the loon reads as a scream.
    if (this.rand.next() < 0.0015) {
      _v.set(_lis.x + this.rand.range(-90, 90), _lis.y + 1, _lis.z - 110);
      this.play(this.rand.chance(0.2) ? 'loon.tremolo' : 'loon.wail', {
        position: _v, bus: 'ambience', volume: dbToGain(-16), priority: 1, reverb: 0.85,
        rolloff: ROLLOFF.landmark, family: 'wildlife', occ: false,
      });
    } else if (this.rand.next() < 0.0009) {
      _v.set(_lis.x + this.rand.range(-20, 20), _lis.y + 9, _lis.z + this.rand.range(-20, 20));
      this.play('owl.hoot', {
        position: _v, bus: 'ambience', volume: dbToGain(-18), priority: 1, reverb: 0.5,
        family: 'wildlife', occ: false,
      });
    }
  }

  // =============================================================== §4.19–4.20 the body

  _buildBody() {
    const c = this.context;
    if (!c || !this.buses) return;
    const dest = this.buses.body.input;

    // Breath chain. Under the mask this is the thing that most obviously changes: wearing
    // it should make the player sound, to himself, like he is inside a bucket.
    const bGain = c.createGain();
    const bPeak = c.createBiquadFilter();
    bPeak.type = 'peaking'; bPeak.frequency.value = 680; bPeak.Q.value = 1.2; bPeak.gain.value = 0;
    const bShelf = c.createBiquadFilter();
    bShelf.type = 'highshelf'; bShelf.frequency.value = 4000; bShelf.gain.value = 0;
    bGain.connect(bPeak); bPeak.connect(bShelf); bShelf.connect(dest);
    this._breath.gainNode = bGain;
    this._breath.peak = bPeak;
    this._breath.shelf = bShelf;
    this.buses.breath = { name: 'breath', gain: bGain, duck: bGain, input: bGain };

    // Heart. The cutoff is the fear dial: you feel it long before you hear it.
    const hGain = c.createGain();
    const hLP = c.createBiquadFilter();
    hLP.type = 'lowpass'; hLP.frequency.value = 200; hLP.Q.value = 1.0;
    hGain.connect(hLP); hLP.connect(dest);
    this._heart.gainNode = hGain;
    this._heart.lp = hLP;
    this.buses.heart = { name: 'heart', gain: hGain, duck: hGain, input: hGain };
  }

  _setBreath(state, holdSec = 0) {
    if (!this._breath) return;
    if (state === this._breath.state) {
      if (holdSec) this._breath.hold = this.now() + holdSec;
      return;
    }
    this._breath.state = state;
    this._breath.hold = holdSec ? this.now() + holdSec : 0;
    if (state === 'held') {
      // No breath sound at all for 2.5 + rand(0,3.5) seconds.
      this._breath.next = this.now() + 2.5 + this.rand.range(0, 3.5);
      this._breath.phase = 2;     // the controlled exhale that ends the hold
    }
  }

  _updateBody(now, dt) {
    const st = this.ctx?.state;
    const susp = clamp01(st?.suspicion ?? 0);
    const prox = clamp01(1 - this._nearestCamper / 30);
    const fearTarget = clamp01(0.55 * susp + 0.55 * prox + (st?.spotted ? 0.35 : 0) + (this._held ? 0.4 : 0));
    // The heart lags the situation, which is exactly right emotionally: it keeps hammering
    // for several seconds after you are safe.
    const k = 1 - Math.exp(-dt / 1.2);
    this.fear += (fearTarget - this.fear) * k;
    this.exertion += (clamp01(this._speed / 5) - this.exertion) * (1 - Math.exp(-dt / 0.6));

    // ---- breath
    const br = this._breath;
    if (br.gainNode) {
      if (br.state !== 'held' && (!br.hold || now > br.hold)) {
        const s = this.fear > 0.45 ? 'fear'
          : this.exertion > 0.5 ? 'heavy'
            : this._speed > 0.6 ? 'walk' : 'calm';
        if (s !== br.state) { br.state = s; }
      }
      if (now >= br.next) {
        const s = br.state;
        if (s === 'held') {
          // One controlled, tight, high-passed exhale, then back to fear breathing.
          this.play('breath.fear.out', {
            bus: 'breath', volume: dbToGain(-18), rate: 1.15, priority: 3, family: 'breath',
          });
          br.state = 'fear';
          br.next = now + 1.2;
        } else {
          const spec = BREATH_TIMING[s] ?? BREATH_TIMING.calm;
          const jitter = s === 'fear' ? this.rand.range(0.7, 1.3) : this.rand.range(0.94, 1.06);
          const vol = dbToGain(spec.db + 12);
          if (br.phase === 0) {
            this.play(`breath.${s}.in`, { bus: 'breath', volume: vol, priority: 3, family: 'breath' });
            // 1 in 5 fear cycles the inhale is doubled — a short catch, then the rest.
            if (s === 'fear' && this.rand.chance(0.2)) {
              this.play(`breath.${s}.in`, {
                bus: 'breath', volume: vol * 0.8, when: now + spec.inhale * 0.5 + 0.12,
                rate: 1.1, priority: 3, family: 'breath',
              });
            }
            br.phase = 1;
            br.next = now + spec.inhale * jitter;
          } else {
            this.play(`breath.${s}.out`, { bus: 'breath', volume: vol * 0.8, priority: 3, family: 'breath' });
            br.phase = 0;
            br.next = now + (spec.period - spec.inhale) * jitter;
          }
        }
      }
    }

    // ---- heartbeat
    const h = this._heart;
    if (h.gainNode) {
      const audible = this.fear >= 0.12;
      const db = -40 + 22 * this.fear;
      this._set(h.gainNode.gain, audible ? dbToGain(db + 6) : MIN_G, now, 0.4);
      const cutoff = this.ctx?.state?.phase === 'chase' ? 620 : (this._held || h.open) ? 420 : 200;
      this._set(h.lp.frequency, cutoff, now, 0.3);
      if (audible) {
        h.bpm = clamp(52 + 46 * this.fear + 22 * this.exertion, 52, 148);
        const period = 60 / h.bpm;
        if (now >= h.next) {
          this.play('heart.thump', { bus: 'heart', volume: 1, priority: 3, family: 'body' });
          this.play('heart.thump', {
            bus: 'heart', volume: dbToGain(-5), when: now + period * 0.30,
            rate: 0.96, priority: 3, family: 'body',
          });
          h.next = now + period;
        }
      } else {
        h.next = now + 0.4;
      }
    }
  }

  // =============================================================== frame

  update(dt, elapsed) {
    if (!this.enabled || !this.context) return;
    const now = this.context.currentTime;
    this._updateListener(now);
    this._updateVoices(now);

    this._acc += dt;
    if (this._acc >= 0.05) {
      const slow = this._acc;
      this._acc = 0;
      this._updateAmbience(slow, now);
      this._updateCrickets(now);
      this._updateBody(now, slow);
      this._updateWorldQueries(now, slow);
    }
    void elapsed;
  }

  _updateListener(now) {
    const l = this.context.listener;
    const cam = this.ctx?.camera;
    if (!l || !cam) return;
    _lis.setFromMatrixPosition(cam.matrixWorld);
    cam.getWorldDirection(_fwd);
    _up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    // Never setPosition(), never instantaneous jumps — both zipper the HRTF convolution.
    if (l.positionX) {
      const tau = 0.02;
      l.positionX.setTargetAtTime(_lis.x, now, tau);
      l.positionY.setTargetAtTime(_lis.y, now, tau);
      l.positionZ.setTargetAtTime(_lis.z, now, tau);
      l.forwardX.setTargetAtTime(_fwd.x, now, tau);
      l.forwardY.setTargetAtTime(_fwd.y, now, tau);
      l.forwardZ.setTargetAtTime(_fwd.z, now, tau);
      l.upX.setTargetAtTime(_up.x, now, tau);
      l.upY.setTargetAtTime(_up.y, now, tau);
      l.upZ.setTargetAtTime(_up.z, now, tau);
    } else {
      l.setPosition?.(_lis.x, _lis.y, _lis.z);
      l.setOrientation?.(_fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z);
    }
  }

  _updateVoices(now) {
    const list = this._voices;
    // Safety net: onended is not guaranteed to fire on every engine.
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v.free && !v.loop && now > v.endsAt + 0.25) this._releaseVoice(v, true);
    }
    // Sustained sources refresh their distance/occlusion round-robin, ≤ 8 per frame with
    // a 120 ms cache (§3.2, §9.3).
    let budget = 8;
    for (let n = 0; n < list.length && budget > 0; n++) {
      this._rr = (this._rr + 1) % list.length;
      const v = list[this._rr];
      if (v.free || !v.sustained || !v.hasPosition) continue;
      budget--;
      if (now - (v.occT ?? 0) < 0.12) continue;
      v.occT = now;
      // Smoothed so a camper walking behind a tree sweeps rather than steps (§3.2).
      const occ = this._occlusion(v.position);
      this._set(v.directLP.frequency, occ.fc, now, 0.08);
      this._set(v.directGain.gain, occ.gain, now, 0.08);
      this._set(v.bleedGain.gain, occ.bleed > 0.02 ? dbToGain(clamp(-14 - 20 * occ.bleed, -40, -14)) : 0, now, 0.08);
      this._setPannerPosition(v.panner, v.position, now, 0.05);
    }
  }

  /** Everything that asks another system a question. Rate-limited, all null-checked. */
  _updateWorldQueries(now, dt) {
    const sys = this.ctx?.systems;
    const state = this.ctx?.state;

    // nearest camper, 4 Hz
    if (now - this._camperT > 0.25) {
      this._camperT = now;
      this._nearestCamper = this._queryNearestCamper();
      // The lantern is a stealth dial, so we track it rather than guess.
      const fl = sys?.get?.('Flashlight');
      const on = fl?.on ?? fl?.enabled ?? fl?.isOn;
      if (typeof on === 'boolean') this._lanternOn = on;
    }

    // reverb probe, 4 Hz
    if (!this._spaceLocked && now - this._probeT > 0.25) {
      this._probeT = now;
      const space = this._probeSpace();
      if (space) this._setSpace(space);
    }

    // S11 — pre-dawn: over 40 s, ramp everything below 300 Hz out of the world.
    const t = clamp01(state?.timeOfNight ?? 0);
    this._set(this._dawnHP.frequency, t > 0.92 ? 20 + 280 * clamp01((t - 0.92) / 0.06) : 20, now, 4.0);

    // §6.3 — the dread scalar. We keep our own copy because the mix reads it, but we do not
    // push it at Music every tick: Music computes the same formula and treats setDread() as
    // an external floor, so streaming it in would take the score's own judgement away. We
    // only override on a real event (the Held Breath).
    const buildProgress = clamp01(this._buildProgress());
    const target = clamp01(
      0.40 * clamp01(state?.suspicion ?? 0)
      + 0.30 * clamp01(1 - this._nearestCamper / 30)
      + 0.15 * (state?.spotted ? 1 : 0)
      + 0.10 * clamp01((state?.creaks ?? 0) / 6)
      + 0.05 * (1 - buildProgress),
    );
    // Dread arrives instantly and leaves slowly. Never the reverse.
    const tau = target > this.dread ? 0.35 : 4.5;
    this.dread += (target - this.dread) * (1 - Math.exp(-dt / tau));
  }

  _queryNearestCamper() {
    const campers = this.ctx?.systems?.get?.('Campers');
    if (!campers) return 999;
    this._listenerPosition(_lis);
    try {
      if (typeof campers.nearestDistance === 'function') {
        const d = campers.nearestDistance(_lis);
        if (Number.isFinite(d)) return d;
      }
      if (typeof campers.nearest === 'function') {
        const c = campers.nearest(_lis);
        const p = c?.position ?? c?.mesh?.position;
        if (p) return _tmp.copy(p).distanceTo(_lis);
      }
      const list = campers.agents ?? campers.list ?? campers.campers;
      if (Array.isArray(list)) {
        let best = 999;
        for (let i = 0; i < list.length; i++) {
          const p = list[i]?.position ?? list[i]?.mesh?.position;
          if (!p) continue;
          const d = _tmp.copy(p).distanceTo(_lis);
          if (d < best) best = d;
        }
        return best;
      }
    } catch { /* AI system still being authored */ }
    return 999;
  }

  _buildProgress() {
    const bs = this.ctx?.systems?.get?.('BuildSystem');
    const p = bs?.progress ?? (typeof bs?.getProgress === 'function' ? bs.getProgress() : null);
    return Number.isFinite(p) ? clamp01(p) : 0.5;
  }

  /** The reverb probe. Architecture wins over environment; water wins over trees. */
  _probeSpace() {
    const sys = this.ctx?.systems;
    if (!sys) return 'OPEN_FOREST';
    this._listenerPosition(_lis);
    try {
      const cabin = sys.get?.('CabinSite');
      const inside = cabin?.containsPoint?.(_lis) ?? cabin?.isInside?.(_lis);
      if (inside) {
        const roofed = cabin?.hasRoof ?? cabin?.roofBuilt ?? false;
        return roofed ? 'TIN_ROOF' : 'CABIN_SHELL';
      }
      const terrain = sys.get?.('Terrain');
      const water = terrain?.waterLevel ?? terrain?.seaLevel;
      if (Number.isFinite(water)) {
        const h = typeof terrain?.heightAt === 'function' ? terrain.heightAt(_lis.x, _lis.z) : null;
        if (Number.isFinite(h) && h - water < 1.2) return 'LAKE_EDGE';
      }
      const forest = sys.get?.('Forest');
      const dens = typeof forest?.densityAt === 'function' ? forest.densityAt(_lis.x, _lis.z) : NaN;
      if (Number.isFinite(dens) && dens > 0.55) return 'DENSE_TREES';
    } catch { /* systems still being authored */ }
    return 'OPEN_FOREST';
  }

  resize(_w, _h) { /* nothing resolution-dependent in the audio graph */ }

  // =============================================================== teardown

  dispose() {
    for (const off of this._unsubs) { try { off(); } catch { /* already gone */ } }
    this._unsubs.length = 0;
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();

    for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
      try { globalThis.removeEventListener?.(ev, this._resumeHandler); } catch { /* n/a */ }
    }
    try { globalThis.document?.removeEventListener?.('visibilitychange', this._onVisible); } catch { /* n/a */ }

    this.enabled = false;

    for (const v of this._voices) { try { v.dispose(); } catch { /* already torn down */ } }
    this._voices.length = 0;

    const a = this._amb;
    if (a) {
      for (const s of a.srcs) { try { s.stop(); } catch { /* already stopped */ } try { s.disconnect(); } catch { /* n/a */ } }
      a.srcs.length = 0;
    }
    this._amb = null;
    this._crickets = null;

    for (const n of [this._verbIn, this._convA, this._convB, this._retA, this._retB,
      this._sfxComp, this._limiter, this._mixBus, this._mixDuck, this._pauseLP, this._dawnHP,
      this._ambNotch, this._ambLP, this._combGain,
      this._mask?.in, this._mask?.dry, this._mask?.wet, this._mask?.lp, this._mask?.peak,
      this._mask?.notch, this._mask?.shelf, this._mask?.comb,
      this._breath?.gainNode, this._breath?.peak, this._breath?.shelf,
      this._heart?.gainNode, this._heart?.lp]) {
      try { n?.disconnect(); } catch { /* not connected */ }
    }
    if (this.buses) {
      for (const key of Object.keys(this.buses)) {
        const b = this.buses[key];
        try { b?.gain?.disconnect(); b?.duck?.disconnect(); b?.send?.disconnect(); } catch { /* n/a */ }
      }
    }
    this.buses = null;
    this._irs.clear();
    this.sfx?.dispose();
    this.sfx = null;

    const c = this.context;
    this.context = null;
    if (c && typeof c.close === 'function' && c.state !== 'closed') {
      c.close().catch(() => { /* already closing */ });
    }
  }
}

/** Scratch for the occlusion triple: `gain` linear, `fc` Hz, `bleed` 0..1 diffraction. */
const _occ = { gain: 1, fc: 18000, bleed: 0 };
const NO_OCC = Object.freeze({ gain: 1, fc: 18000, bleed: 0 });
/** Scratch for one noise event's mix. `occ` is a private copy — `_occ` is reused. */
const _mix = { rel: 0, occ: { gain: 1, fc: 18000, bleed: 0 } };

/** §4.19 — the breathing cycle table. */
const BREATH_TIMING = {
  calm: { period: 4.4, inhale: 1.1, db: -34 },
  walk: { period: 3.2, inhale: 0.9, db: -29 },
  heavy: { period: 1.9, inhale: 0.6, db: -22 },
  fear: { period: 2.4, inhale: 0.5, db: -24 },
};

// Equal-power crossfade curves for the two reverb returns (§3.3).
const XF_UP = new Float32Array(33);
const XF_DOWN = new Float32Array(33);
for (let i = 0; i <= 32; i++) {
  const u = (i / 32) * Math.PI * 0.5;
  XF_UP[i] = Math.sin(u);
  XF_DOWN[i] = Math.cos(u);
}

export default AudioEngine;
