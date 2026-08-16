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

/** kind → the sfx id that must accompany it (§1.3). */
const NOISE_SFX = {
  'footstep-crouch': 'step', 'footstep-walk': 'step', 'footstep-run': 'step', footstep: 'step',
  drag: 'lumber.drag', 'drop-light': 'bracket.drop.rock', 'drop-heavy': 'lumber.drop',
  'hammer-wood': 'hammer.wood', 'hammer-steel': 'hammer.steel',
  split: 'wood.split', twig: 'twig.snap', branch: 'branch.snap',
  zipper: 'zipper', click: 'click.flashlight.on', knock: 'lumber.knock',
  // creak is dispatched through build:creak so it carries its severity tier
  creak: null, animal: null, voice: null, generic: null,
};

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
    this.bus = ctx?.bus ?? null;
    this.settings = ctx?.settings ?? null;
    this.state = ctx?.state ?? null;
    this.rand = new Rand('audio');

    this.context = null;
    this.buses = null;
    this.sfx = null;
    this.enabled = false;
    this.started = false;          // has a user gesture resumed the context?

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
      // Phase 0 is everything the player can trigger in the first second. Awaited.
      await this.sfx.renderPhase(0, { budgetMs: 6 });
      // Everything else renders in the background across frames — boot never stalls.
      this.sfx.renderPhase(1, { budgetMs: 5 }).then(() => {
        this._startAmbience();
        Log.debug(`Audio: SFX bank complete (${this.sfx.stats.buffers} buffers, ` +
          `${this.sfx.stats.ms.toFixed(0)} ms).`);
      }).catch((e) => Log.warn('Audio: background SFX render failed:', e?.message ?? e));

      this._loadImpulseResponses();
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
    const c = this.context;
    const n = this._maxVoices;
    for (let i = 0; i < n; i++) this._voices.push(new Voice(this, i));
    Log.debug(`Audio: ${n} voice slots, ${this._maxHrtf} HRTF.`);
    void c;
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

  /** @returns {GainNode|null} the input node of a bus. */
  busNode(name) {
    const key = BUS_ALIAS[name] ?? name;
    const b = this.buses?.[key];
    return b ? b.input ?? b.gain : null;
  }

  /** Doc-facing alias (§9.5): `audio.bus('sfxWorld')`. */
  bus_(name) { return this.busNode(name); }

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

    let gainValue = (opts.volume ?? 1);
    let distance = 0;
    let occT = opts.occlusion ?? 0;

    if (spatial) {
      this._listenerPosition(_lis);
      _tmp.copy(opts.position);
      distance = _tmp.distanceTo(_lis);
      if (opts.rolloff !== 0) {
        // The panner applies its own inverse-distance law; only pre-scale when we have
        // taken that job over (the noise:emit path).
        gainValue *= 1;
      }
    }

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
      occlusion: occT,
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

  /** Manual reverb override. Omit to let the probe grid decide again. */
  reverbZone(name, fadeMs = null) {
    if (!this.context) return;
    if (name == null) { this._spaceLocked = false; return; }
    if (!SPACES.includes(name)) return;
    this._spaceLocked = fadeMs !== -1;
    if (name === this._spaceTarget) return;
    const ir = this._irs.get(name);
    if (!ir) { this._spaceTarget = name; return; }   // not rendered yet; take it next probe

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

    // ---- occlusion split (§3.2)
    const T = clamp(o.occlusion ?? 0, 0, 14);
    const fc = clamp(18000 * Math.exp(-0.55 * T), 180, 18000);
    const directDb = clamp(-3.2 * T, -34, 0);
    const bleedDb = T > 0.02 ? clamp(-14 - 1.1 * T, -40, -14) : -60;
    this._set(v.directLP.frequency, fc, now);
    this._set(v.directGain.gain, dbToGain(directDb), now);
    this._set(v.bleedGain.gain, T > 0.02 ? dbToGain(bleedDb) : 0, now);

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
    v.panner.connect(v.out);
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
}

// Equal-power crossfade curves for the two reverb returns (§3.3).
const XF_UP = new Float32Array(33);
const XF_DOWN = new Float32Array(33);
for (let i = 0; i <= 32; i++) {
  const u = (i / 32) * Math.PI * 0.5;
  XF_UP[i] = Math.sin(u);
  XF_DOWN[i] = Math.cos(u);
}

export default AudioEngine;
