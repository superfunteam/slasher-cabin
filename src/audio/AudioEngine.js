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
}

export default AudioEngine;
