/**
 * ProceduralSFX.js — the synthesized SFX cookbook. There are no sample files.
 *
 * OWNER: Audio agent. This is a LIBRARY, not a registered system: it is imported by
 * AudioEngine.js and never appears in src/main.js.
 *
 * Implements AUDIO_DIRECTION.md §4 (the cookbook) and §3.3 (procedural impulse responses).
 * Every sound is rendered once into an AudioBuffer inside an OfflineAudioContext and cached,
 * with several randomized variants per id so repetition never becomes audible.
 *
 * Public surface (see the bottom of the file):
 *   new SFXBank(audioContext, { rand, settings })   → the cache + renderer
 *   bank.get(id) / bank.variant(id, i) / bank.creak(severity, size) / bank.noise(type)
 *   await renderAll(audioContext, opts)             → a fully primed SFXBank
 *   renderImpulseResponse(space, sampleRate, opts)  → AudioBuffer for a reverb space
 *   plus the DSP primitives (modal, grainTrain, frictionOsc, burst, noiseBuffer, …)
 *
 * Determinism: every buffer is rendered from a Rand seeded by `${id}:${variant}`.
 * Never Math.random().
 */
import { Rand } from '../core/Rand.js';
import { Log } from '../core/Log.js';

const OfflineCtor = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext ?? null;

// ---------------------------------------------------------------- math helpers

export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(1e-6, g));
export const centsRatio = (c) => Math.pow(2, c / 1200);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const MIN_GAIN = 1e-4;

// ---------------------------------------------------------------- buffers

const _scratchCtx = new Map();
const _noiseCache = new Map();

function scratchFor(sr) {
  let s = _scratchCtx.get(sr);
  if (!s && OfflineCtor) {
    try { s = new OfflineCtor(1, 128, sr); _scratchCtx.set(sr, s); } catch { s = null; }
  }
  return s;
}

/** Allocate a raw AudioBuffer without needing a live context. */
export function allocBuffer(channels, length, sampleRate) {
  const len = Math.max(1, Math.ceil(length));
  try {
    return new AudioBuffer({ numberOfChannels: channels, length: len, sampleRate });
  } catch { /* older engines have no AudioBuffer constructor */ }
  const s = scratchFor(sampleRate);
  return s ? s.createBuffer(channels, len, sampleRate) : null;
}

function fillWhite(out, rand) {
  for (let i = 0; i < out.length; i++) out[i] = rand.next() * 2 - 1;
}

/** Voss-McCartney, 16 octaves (§4.0). */
function fillPink(out, rand) {
  const ROWS = 16;
  const rows = new Float64Array(ROWS);
  let running = 0;
  let counter = 0;
  for (let i = 0; i < ROWS; i++) { rows[i] = rand.next() * 2 - 1; running += rows[i]; }
  for (let i = 0; i < out.length; i++) {
    counter++;
    const lowest = counter & -counter;
    let idx = 0;
    let n = lowest;
    while (n > 1) { n >>>= 1; idx++; }
    if (idx < ROWS) {
      running -= rows[idx];
      rows[idx] = rand.next() * 2 - 1;
      running += rows[idx];
    }
    const white = rand.next() * 2 - 1;
    out[i] = (running + white) / (ROWS + 1);
  }
}

/** Leaky integrator + DC block (§4.0). */
function fillBrown(out, rand) {
  let y = 0;
  let prev = 0;
  let hp = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rand.next() * 2 - 1;
    y = 0.996 * y + 0.03 * w;
    hp = 0.999 * (hp + y - prev);
    prev = y;
    out[i] = hp;
  }
}

function normalizeChannel(data, target) {
  let peak = 0;
  for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
  if (peak < 1e-9) return;
  const k = target / peak;
  for (let i = 0; i < data.length; i++) data[i] *= k;
}

/**
 * The three shared noise beds (§4.0). Cached per (type, sampleRate, seconds); every noise
 * source in the game is a looping AudioBufferSourceNode on one of these. Never allocate a
 * new noise buffer at runtime.
 */
export function noiseBuffer(type, sampleRate, seconds = 4) {
  const key = `${type}|${sampleRate}|${seconds}`;
  const hit = _noiseCache.get(key);
  if (hit) return hit;
  const buf = allocBuffer(2, seconds * sampleRate, sampleRate);
  if (!buf) return null;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const rand = new Rand(`noise:${type}:${ch}:${sampleRate}`);
    const data = buf.getChannelData(ch);
    if (type === 'pink') fillPink(data, rand);
    else if (type === 'brown') fillBrown(data, rand);
    else fillWhite(data, rand);
    normalizeChannel(data, 0.92);
  }
  _noiseCache.set(key, buf);
  return buf;
}

export function bufferPeak(buf) {
  let peak = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  }
  return peak;
}

function bufferRms(buf) {
  let sum = 0;
  let n = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
    n += d.length;
  }
  return Math.sqrt(sum / Math.max(1, n));
}

function scaleBuffer(buf, k) {
  if (!Number.isFinite(k) || k === 1) return buf;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
  return buf;
}

/**
 * Calibrate a rendered buffer so its peak sits at an exact dBFS value. This is what makes the
 * §1.3 `noise:emit` ↔ loudness contract literally true: the table's dB figure is baked into
 * the asset, so AI-audible intensity and player-audible loudness cannot drift apart.
 */
function normalizeBufferTo(buf, targetPeak) {
  const peak = bufferPeak(buf);
  if (peak < 1e-9) return buf;
  return scaleBuffer(buf, targetPeak / peak);
}

/** Equal-power wrap of the tail over the head so a bed loops without a seam click. */
function makeSeamless(buf, xfadeSec) {
  const sr = buf.sampleRate;
  const x = Math.min(Math.floor(xfadeSec * sr), Math.floor(buf.length / 3));
  if (x < 32) return buf;
  const outLen = buf.length - x;
  const out = allocBuffer(buf.numberOfChannels, outLen, sr);
  if (!out) return buf;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < outLen; i++) dst[i] = src[i];
    for (let i = 0; i < x; i++) {
      const u = i / x;
      const fi = Math.sin(u * Math.PI * 0.5);
      const fo = Math.cos(u * Math.PI * 0.5);
      dst[i] = src[i] * fi + src[outLen + i] * fo;
    }
  }
  return out;
}

// ---------------------------------------------------------------- graph primitives
//
// Every builder receives a render scope R = { ctx, rand, sr, tier }. `ctx` is an
// OfflineAudioContext; nothing here ever touches the live context.

function nyq(R) { return R.sr * 0.47; }
const fclamp = (R, f) => clamp(f, 12, nyq(R));

export function gain(R, value = 1) {
  const g = R.ctx.createGain();
  g.gain.value = value;
  return g;
}

export function biquad(R, type, f, Q = 0.7, dbGain = 0) {
  const b = R.ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = fclamp(R, f);
  b.Q.value = Math.max(0.0001, Q);
  if (dbGain) b.gain.value = dbGain;
  return b;
}

/** Soft-clip waveshaper + the mandatory DC-blocking highpass (§9.2.7). */
export function saturator(R, drive = 1.3) {
  const ws = R.ctx.createWaveShaper();
  const n = 1024;
  const curve = new Float32Array(n);
  const k = Math.max(0.05, drive) * 2.2;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  ws.curve = curve;
  ws.oversample = '2x';
  const hp = biquad(R, 'highpass', 18, 0.7);
  ws.connect(hp);
  return { input: ws, output: hp };
}

/** A looping source on one of the three shared noise beds, with a random loop offset. */
export function noiseSrc(R, type, t0, dur, { rate = 1, detuneCents = 0 } = {}) {
  const buf = noiseBuffer(type, R.sr, 4);
  const s = R.ctx.createBufferSource();
  s.buffer = buf;
  s.loop = true;
  s.playbackRate.value = rate;
  if (detuneCents) { try { s.detune.value = detuneCents; } catch { /* no detune param */ } }
  const off = buf ? R.rand.next() * Math.max(0.01, buf.duration - 0.6) : 0;
  s.start(t0, off);
  s.stop(t0 + dur + 0.02);
  return s;
}

/**
 * One long-running noise source per (render, type), gated per grain. A dense grain train
 * would otherwise allocate a BufferSource per grain, which is what makes an offline render
 * slow. Grains still land on different parts of the bed, so they stay decorrelated.
 */
function sharedNoise(R, type) {
  if (!R._shared) R._shared = {};
  let s = R._shared[type];
  if (!s) {
    s = noiseSrc(R, type, 0, R.ctx.length / R.sr + 0.05, {});
    R._shared[type] = s;
  }
  return s;
}

/**
 * A shaped noise burst. Transients are made by a 1–2 ms *source*, never by a 0 ms envelope
 * (§9.2.2) — the ramp here is only steep enough to avoid a DC step.
 */
export function burst(R, t0, durSec, peak = 1, type = 'white') {
  const g = R.ctx.createGain();
  sharedNoise(R, type).connect(g);
  const p = g.gain;
  const atk = Math.min(0.0006, durSec * 0.3);
  p.setValueAtTime(0, t0);
  p.linearRampToValueAtTime(peak, t0 + atk);
  p.linearRampToValueAtTime(0, t0 + durSec);
  return g;
}

/** An oscillator with an exponential pitch move and an A/D envelope. */
export function tone(R, dest, t0, dur, f0, f1, peak, { type = 'sine', attack = 0.004, hold = 0 } = {}) {
  const o = R.ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(fclamp(R, f0), t0);
  if (f1 && Math.abs(f1 - f0) > 0.5) o.frequency.exponentialRampToValueAtTime(fclamp(R, f1), t0 + dur);
  const g = R.ctx.createGain();
  const p = g.gain;
  const a = Math.min(attack, dur * 0.5);
  p.setValueAtTime(0, t0);
  p.linearRampToValueAtTime(peak, t0 + a);
  if (hold > 0) p.setValueAtTime(peak, t0 + a + hold);
  p.exponentialRampToValueAtTime(MIN_GAIN, t0 + dur);
  p.setValueAtTime(0, t0 + dur + 0.001);
  o.connect(g);
  g.connect(dest);
  o.start(t0);
  o.stop(t0 + dur + 0.03);
  return g;
}

/**
 * The workhorse (§4.0). `modes` is a list of { f, Q, gain|g, decayMs|d }; each becomes a
 * parallel high-Q bandpass with its own exponential decay. Every impact, ping, knock, clack
 * and body resonance in the game comes out of this function.
 */
export function modal(R, exciter, modes, dest, t0, opts = {}) {
  const {
    fScale = 1, detuneCents = 0, qScale = 1, decayScale = 1, gainScale = 1, detuneRamp = 0,
  } = opts;
  const ratio = centsRatio(detuneCents);
  for (let i = 0; i < modes.length; i++) {
    const m = modes[i];
    const f = fclamp(R, (m.f ?? 440) * fScale * ratio);
    const bp = R.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(f, t0);
    bp.Q.value = Math.max(0.05, (m.Q ?? m.q ?? 12) * qScale);
    // Struck metal goes sharp under high amplitude and settles back (§4.5).
    if (detuneRamp) {
      bp.frequency.setValueAtTime(fclamp(R, f * centsRatio(detuneRamp)), t0);
      bp.frequency.exponentialRampToValueAtTime(f, t0 + 0.24);
    }
    const dec = Math.max(0.006, ((m.decayMs ?? m.d ?? 60) / 1000) * decayScale);
    const g = R.ctx.createGain();
    const peak = Math.max(MIN_GAIN, (m.gain ?? m.g ?? 1) * gainScale);
    g.gain.setValueAtTime(peak, t0);
    g.gain.exponentialRampToValueAtTime(MIN_GAIN, t0 + dec);
    g.gain.setValueAtTime(0, t0 + dec + 0.001);
    exciter.connect(bp);
    bp.connect(g);
    g.connect(dest);
  }
}

/**
 * Schedule `spawn(t, i, u)` at 1/rate intervals with ±jitter uniform timing noise, optionally
 * gliding from `rate` to `rateEnd` across the train (accelerando / decelerando).
 */
export function grainTrain(R, { t0, dur, rate, rateEnd = null, jitter = 0.5, max = 512, spawn }) {
  const end = t0 + dur;
  const r1 = rateEnd === null ? rate : rateEnd;
  let t = t0;
  let i = 0;
  while (t < end && i < max) {
    const u = dur > 0 ? clamp((t - t0) / dur, 0, 1) : 0;
    spawn(t, i, u);
    const r = Math.max(0.4, rate + (r1 - rate) * u);
    const dt = (1 / r) * (1 + jitter * (R.rand.next() * 2 - 1));
    t += Math.max(0.0012, dt);
    i++;
  }
  return i;
}

/** One bandpassed noise grain — gravel ticks, rain drops, zipper teeth, ratchet bites. */
export function pingGrain(R, dest, t, { f, Q = 4, dur = 0.004, decay = 0.012, level = 1, type = 'white' }) {
  const b = burst(R, t, dur, 1, type);
  const bp = biquad(R, 'bandpass', f, Q);
  const g = R.ctx.createGain();
  g.gain.setValueAtTime(Math.max(MIN_GAIN, level), t);
  g.gain.exponentialRampToValueAtTime(MIN_GAIN, t + decay);
  g.gain.setValueAtTime(0, t + decay + 0.001);
  b.connect(bp);
  bp.connect(g);
  g.connect(dest);
}

/**
 * frictionOsc — the stick-slip model behind every creak, squeak and drag (§4.11).
 *
 * This is not a filtered noise sweep. A sequence of irregular slip events excites a very
 * high-Q resonator whose centre frequency falls under load, and the slip clock *also*
 * amplitude-modulates the ringing. That modulation is what makes wood sound like wood
 * instead of like a cartoon door.
 */
export function frictionOsc(R, dest, {
  t0 = 0,
  dur = 0.4,
  slipRate = 20,
  slips = 0,
  fStart = 1600,
  fEnd = null,
  pitchDropCents = 260,
  qStart = 110,
  qEnd = null,
  level = 0.1,
  partnerDb = -8,
  bedDb = -26,
  bodyF = 0,
  bodyDb = -16,
  drive = 1.3,
  irregular = 0.55,
  subF = 0,
  subDb = -22,
  subharmDb = null,
  tremoloHz = 0,
  tremoloDepth = 0,
  slipShape = 1,
} = {}) {
  const ctx = R.ctx;
  const f1 = fEnd ?? fStart * centsRatio(-pitchDropCents);
  const q1 = qEnd ?? qStart;

  const sat = saturator(R, drive);
  const out = gain(R, level);
  sat.output.connect(out);
  out.connect(dest);

  // The slip clock modulates the ringing — the "grab, release, grab" of two loaded surfaces.
  const slipAM = gain(R, 0.0001);
  slipAM.connect(sat.input);

  const exciter = gain(R, 1);

  // Primary resonator + its inharmonic partner (the "two surfaces" quality).
  const res = biquad(R, 'bandpass', fStart, qStart);
  res.frequency.setValueAtTime(fclamp(R, fStart), t0);
  res.frequency.exponentialRampToValueAtTime(fclamp(R, f1), t0 + dur);
  if (q1 !== qStart) {
    res.Q.setValueAtTime(qStart, t0);
    res.Q.linearRampToValueAtTime(q1, t0 + dur);
  }
  exciter.connect(res);
  res.connect(slipAM);

  if (partnerDb > -60) {
    const p = biquad(R, 'bandpass', fStart * 1.47, qStart * 0.8);
    p.frequency.setValueAtTime(fclamp(R, fStart * 1.47), t0);
    p.frequency.exponentialRampToValueAtTime(fclamp(R, f1 * 1.47), t0 + dur);
    const pg = gain(R, dbToGain(partnerDb));
    exciter.connect(p);
    p.connect(pg);
    pg.connect(slipAM);
  }

  // The body of the member itself — tracks its size, so a joist groans lower than a batten.
  if (bodyF > 0) {
    modal(R, exciter, [
      { f: bodyF, Q: 26, g: 1.0, d: 320 },
      { f: bodyF * 2.41, Q: 20, g: 0.42, d: 220 },
      { f: bodyF * 3.94, Q: 16, g: 0.18, d: 150 },
    ], sat.input, t0, { gainScale: dbToGain(bodyDb) });
  }

  // Glue bed: brown noise under the resonance.
  if (bedDb > -60) {
    const bed = noiseSrc(R, 'brown', t0, dur);
    const lp = biquad(R, 'lowpass', Math.max(60, fStart / 3), 1.0);
    const bg = gain(R, 0);
    bed.connect(lp); lp.connect(bg); bg.connect(sat.input);
    const bp = bg.gain;
    bp.setValueAtTime(0, t0);
    bp.linearRampToValueAtTime(dbToGain(bedDb), t0 + Math.min(0.05, dur * 0.2));
    bp.setValueAtTime(dbToGain(bedDb), t0 + dur * 0.75);
    bp.exponentialRampToValueAtTime(MIN_GAIN, t0 + dur);
    bp.setValueAtTime(0, t0 + dur + 0.001);
  }

  // Sub layer (tier 3+): the weight of the thing.
  if (subF > 0) tone(R, sat.input, t0, dur, subF, subF * 0.78, dbToGain(subDb), { attack: dur * 0.25 });

  // The slip events themselves.
  const n = slips > 0 ? slips : Math.max(2, Math.round(dur * slipRate));
  const dt0 = dur / n;
  const times = [];
  let t = t0 + dt0 * 0.35;
  for (let i = 0; i < n && t < t0 + dur; i++) {
    times.push(t);
    t += dt0 * (1 + irregular * (R.rand.next() * 2 - 1));
  }
  if (!times.length) times.push(t0 + dur * 0.25);

  const amp = slipAM.gain;
  amp.setValueAtTime(0.02, t0);
  for (let i = 0; i < times.length; i++) {
    const ti = times[i];
    const u = clamp((ti - t0) / dur, 0, 1);
    // Hump across the event: the joint takes load, complains, settles.
    const hump = Math.pow(Math.sin(Math.PI * clamp(u * 0.85 + 0.1, 0, 1)), slipShape);
    const g = (0.5 + 0.5 * R.rand.next()) * hump;
    const nextT = i + 1 < times.length ? times[i + 1] : t0 + dur;
    const span = Math.max(0.008, nextT - ti);
    // 1.5 ms of white noise per slip.
    const b = burst(R, ti, 0.0015, g, 'white');
    b.connect(exciter);
    amp.setTargetAtTime(clamp(g, 0.02, 1), ti, 0.0025);
    amp.setTargetAtTime(0.12 * g + 0.02, ti + span * 0.35, span * 0.35);
  }
  amp.setTargetAtTime(0.0001, t0 + dur, 0.03);

  // The subharmonic — something too big making a sound too low for its size.
  if (subharmDb !== null) {
    const sh = ctx.createOscillator();
    sh.type = 'sine';
    sh.frequency.setValueAtTime(fclamp(R, fStart / 2), t0);
    sh.frequency.exponentialRampToValueAtTime(fclamp(R, f1 / 2), t0 + dur);
    const shg = gain(R, 0);
    sh.connect(shg);
    // Amplitude-modulated by the same slip clock.
    const shAM = gain(R, 0);
    shg.connect(shAM);
    shAM.connect(sat.input);
    shg.gain.setValueAtTime(dbToGain(subharmDb), t0);
    const sp = shAM.gain;
    sp.setValueAtTime(0.05, t0);
    for (let i = 0; i < times.length; i++) {
      sp.setTargetAtTime(0.9, times[i], 0.01);
      sp.setTargetAtTime(0.25, times[i] + 0.05, 0.06);
    }
    sp.setTargetAtTime(0.0001, t0 + dur, 0.05);
    sh.start(t0);
    sh.stop(t0 + dur + 0.03);
  }

  // Slow tremolo so the low end wobbles rather than sits.
  if (tremoloHz > 0 && tremoloDepth > 0) {
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = tremoloHz;
    const depth = gain(R, tremoloDepth);
    lfo.connect(depth);
    depth.connect(out.gain);
    lfo.start(t0);
    lfo.stop(t0 + dur + 0.03);
  }

  return out;
}

// ---------------------------------------------------------------- mode tables

// The plank's flexural modes (§4.1 sawn wood).
const SAWN_WOOD = [
  { f: 186, Q: 26, g: 1.0, d: 120 },
  { f: 432, Q: 34, g: 0.55, d: 95 },
  { f: 971, Q: 28, g: 0.30, d: 62 },
  { f: 1830, Q: 20, g: 0.14, d: 40 },
];

// §4.5 — struck steel.
const STEEL = [
  { f: 2130, Q: 900, g: 1.0, d: 1800 },
  { f: 3910, Q: 1100, g: 0.75, d: 1600 },
  { f: 5740, Q: 800, g: 0.50, d: 1200 },
  { f: 8320, Q: 600, g: 0.28, d: 800 },
  { f: 11200, Q: 400, g: 0.12, d: 500 },
];

// §4.1 — tin sheet, six inharmonic modes.
const TIN = [
  { f: 412, Q: 90, g: 1.0, d: 900 },
  { f: 703, Q: 120, g: 0.72, d: 780 },
  { f: 1147, Q: 140, g: 0.55, d: 640 },
  { f: 1892, Q: 160, g: 0.48, d: 520 },
  { f: 2611, Q: 150, g: 0.30, d: 380 },
  { f: 4380, Q: 110, g: 0.18, d: 240 },
];

// §4.3 — two beams knocking. Pitch scales with beam length: f × (2.4 / lengthMetres).
const BEAM_KNOCK = [
  { f: 214, Q: 40, g: 1.0, d: 180 },
  { f: 496, Q: 52, g: 0.70, d: 150 },
  { f: 1130, Q: 44, g: 0.40, d: 95 },
];

const ROCK_TICK = [
  { f: 1700, Q: 22, g: 0.5, d: 26 },
  { f: 4300, Q: 16, g: 0.3, d: 16 },
];

export const MODE_TABLES = { SAWN_WOOD, STEEL, TIN, BEAM_KNOCK, ROCK_TICK };

// ================================================================ §4.1 FOOTSTEPS
//
// Common structure: [IMPACT] + [MATERIAL] + [TAIL]. `loud` is applied by AudioEngine as a
// gain; the *variants* carry the timbral variation so no two steps are the same sound.

const T0 = 0.006;   // lead-in so nothing starts on sample 0

function buildStepPine(R, dest) {
  const imp = biquad(R, 'lowpass', 220, 0.7);
  const ig = gain(R, dbToGain(-18));
  burst(R, T0, 0.018, 1, 'brown').connect(imp);
  imp.connect(ig); ig.connect(dest);

  const mat = gain(R, 1); mat.connect(dest);
  grainTrain(R, {
    t0: T0 + 0.004, dur: 0.055, rate: 180, jitter: 0.6, max: 14,
    spawn: (t) => pingGrain(R, mat, t, {
      f: 2400 * (1 + R.rand.range(-0.35, 0.6)), Q: 3.5, dur: 0.004, decay: 0.009, level: 0.55,
    }),
  });

  // The dry rustle — this is what makes needles read as needles.
  const hp = biquad(R, 'highpass', 1800, 0.7);
  const bp = biquad(R, 'bandpass', 3600, 0.8);
  const tg = gain(R, 0);
  const tail = noiseSrc(R, 'pink', T0, 0.1);
  tail.connect(hp); hp.connect(bp); bp.connect(tg); tg.connect(dest);
  tg.gain.setValueAtTime(0, T0);
  tg.gain.linearRampToValueAtTime(dbToGain(-24), T0 + 0.004);
  tg.gain.exponentialRampToValueAtTime(MIN_GAIN, T0 + 0.09);
  tg.gain.setValueAtTime(0, T0 + 0.092);
}

function buildStepMud(R, dest) {
  const lp = biquad(R, 'lowpass', 900, 1.4);
  lp.frequency.setValueAtTime(900, T0);
  lp.frequency.exponentialRampToValueAtTime(260, T0 + 0.04);
  const ig = gain(R, dbToGain(-10));
  burst(R, T0, 0.03, 1, 'brown').connect(lp);
  lp.connect(ig); ig.connect(dest);

  // THE SUCK — a bandpass sweeping *upward* on the lift. The entire signature of mud.
  const st = T0 + 0.04;
  const suck = biquad(R, 'bandpass', 180, 7);
  suck.frequency.setValueAtTime(180, st);
  suck.frequency.exponentialRampToValueAtTime(620, st + 0.13);
  const sg = gain(R, 0);
  noiseSrc(R, 'pink', st, 0.14).connect(suck);
  suck.connect(sg); sg.connect(dest);
  sg.gain.setValueAtTime(0, st);
  sg.gain.linearRampToValueAtTime(dbToGain(-16), st + 0.03);
  sg.gain.exponentialRampToValueAtTime(MIN_GAIN, st + 0.13);
  sg.gain.setValueAtTime(0, st + 0.132);
  // No tail. Mud is a dead surface — that is why it is the safest floor in the game.
}

function buildStepGrass(R, dest) {
  const imp = biquad(R, 'lowpass', 180, 0.7);
  const ig = gain(R, dbToGain(-20));
  burst(R, T0, 0.018, 1, 'brown').connect(imp);
  imp.connect(ig); ig.connect(dest);

  const mat = gain(R, 1); mat.connect(dest);
  grainTrain(R, {
    t0: T0 + 0.003, dur: 0.07, rate: 260, jitter: 0.8, max: 24,
    spawn: (t) => pingGrain(R, mat, t, {
      f: 5200 * R.rand.range(0.7, 1.4), Q: 2.2, dur: 0.003, decay: 0.014, level: 0.5,
    }),
  });

  const bp = biquad(R, 'bandpass', 900, 0.6);
  const tg = gain(R, 0);
  noiseSrc(R, 'pink', T0, 0.13).connect(bp);
  bp.connect(tg); tg.connect(dest);
  tg.gain.setValueAtTime(0, T0);
  tg.gain.linearRampToValueAtTime(dbToGain(-26), T0 + 0.006);
  tg.gain.exponentialRampToValueAtTime(MIN_GAIN, T0 + 0.12);
  tg.gain.setValueAtTime(0, T0 + 0.122);
}

function buildStepGravel(R, dest) {
  const imp = biquad(R, 'lowpass', 300, 0.7);
  const ig = gain(R, dbToGain(-12));
  burst(R, T0, 0.022, 1, 'brown').connect(imp);
  imp.connect(ig); ig.connect(dest);

  // Stones are little resonators, not noise. Sparse, irregular, and they keep arriving.
  const mat = gain(R, 0.8); mat.connect(dest);
  grainTrain(R, {
    t0: T0 + 0.004, dur: 0.18, rate: 95, jitter: 1.0, max: 18,
    spawn: (t) => {
      const r = R.rand.range(0.75, 1.45);
      modal(R, burst(R, t, 0.001, 1, 'white'), [
        { f: 1200 * r, Q: 14, g: 1, d: 35 },
        { f: 2900 * r, Q: 9, g: 0.5, d: 22 },
      ], mat, t);
    },
  });
}

function buildStepWood(R, dest, p = {}) {
  const ex = burst(R, T0, 0.002, 1, 'white');
  modal(R, ex, SAWN_WOOD, dest, T0, { gainScale: 0.9, fScale: R.rand.range(0.94, 1.07) });

  const lp = biquad(R, 'lowpass', 140, 0.9);
  const bg = gain(R, dbToGain(-14));
  burst(R, T0, 0.04, 1, 'brown').connect(lp);
  lp.connect(bg); bg.connect(dest);

  // The cabin booms underfoot as it gets built — a free progression cue.
  if (p.hollow) modal(R, ex, [{ f: 88, Q: 7, g: 0.4, d: 340 }], dest, T0);
}

function buildStepTin(R, dest) {
  const ex = burst(R, T0, 0.0015, 1, 'white');
  const det = R.rand.range(-60, 60);
  modal(R, ex, TIN, dest, T0, { detuneCents: det });
  // Membrane boom.
  tone(R, dest, T0, 0.2, 74, 58, dbToGain(-8), { attack: 0.003 });
  // Oil-canning: the sheet pops back.
  if (R.rand.chance(0.2)) {
    const t2 = T0 + 0.12;
    modal(R, burst(R, t2, 0.0012, 0.7, 'white'), TIN, dest, t2, {
      fScale: 0.94, detuneCents: det, decayScale: 0.7, gainScale: 0.55,
    });
  }
}

// ================================================================ §4.3 LUMBER

function buildLumberHoist(R, dest) {
  // 1. Cloth / effort.
  const bp = biquad(R, 'bandpass', 800, 0.8);
  bp.frequency.setValueAtTime(800, T0);
  bp.frequency.exponentialRampToValueAtTime(1400, T0 + 0.7);
  const cg = gain(R, 0);
  noiseSrc(R, 'pink', T0, 0.9).connect(bp);
  bp.connect(cg); cg.connect(dest);
  cg.gain.setValueAtTime(0, T0);
  cg.gain.linearRampToValueAtTime(dbToGain(-30), T0 + 0.12);
  cg.gain.setValueAtTime(dbToGain(-30), T0 + 0.42);
  cg.gain.exponentialRampToValueAtTime(MIN_GAIN, T0 + 0.82);
  cg.gain.setValueAtTime(0, T0 + 0.83);

  // 2. Wood groan — the beam taking its own weight.
  frictionOsc(R, dest, {
    t0: T0 + 0.1, dur: 0.55, slipRate: 16, fStart: 240, pitchDropCents: 180,
    qStart: 90, level: dbToGain(-14), bodyF: 118, bodyDb: -18, bedDb: -30, irregular: 0.6,
  });

  // 3. The beam seating on the shoulder.
  tone(R, dest, T0 + 0.62, 0.12, 62, 48, dbToGain(-16), { attack: 0.004 });
}

function buildLumberDrag(R, dest) {
  // A loopable scrape at a nominal speed; AudioEngine rides gain + a speed-tracking LPF.
  const dur = R.ctx.length / R.sr;
  const lp = biquad(R, 'lowpass', 1400, 0.8);
  const out = gain(R, dbToGain(-8));
  lp.connect(out); out.connect(dest);

  const ex = noiseSrc(R, 'brown', 0, dur);
  const exg = gain(R, 0.9);
  ex.connect(exg);
  // The wood's own modes, broadened (Q 8) because they are excited continuously.
  modal(R, exg, SAWN_WOOD.map((m) => ({ ...m, Q: 8, d: 900 })), lp, 0.002, { gainScale: 0.5 });

  const scrape = gain(R, dbToGain(-10));
  scrape.connect(lp);
  grainTrain(R, {
    t0: 0.01, dur: dur - 0.02, rate: 85, jitter: 0.9, max: 200,
    spawn: (t) => pingGrain(R, scrape, t, {
      f: 2200 * R.rand.range(0.7, 1.5), Q: 5, dur: 0.006, decay: 0.02, level: R.rand.range(0.3, 1),
    }),
  });
}

function buildLumberDrop(R, dest) {
  const hit = (t, g, det) => {
    // Sub.
    tone(R, dest, t, 0.3, 58, 41, dbToGain(-6) * g, { attack: 0.002 });
    // Body: the plank's modes, wider and longer than a footstep.
    const ex = burst(R, t, 0.002, g, 'white');
    modal(R, ex, SAWN_WOOD, dest, t, {
      qScale: 1.4, decayScale: 1.6, gainScale: dbToGain(-4) * g, detuneCents: det,
    });
    // Surface displacement.
    const mat = gain(R, 0.7 * g); mat.connect(dest);
    grainTrain(R, {
      t0: t + 0.002, dur: 0.09, rate: 220, jitter: 0.8, max: 26,
      spawn: (tt) => pingGrain(R, mat, tt, {
        f: 2400 * R.rand.range(0.6, 1.6), Q: 3.5, dur: 0.004, decay: 0.012, level: 0.5,
      }),
    });
  };

  hit(T0, 1, R.rand.range(-40, 40));
  // Restitution: t_{n+1} = t_n · 0.72, gain_{n+1} = gain_n · 0.45.
  if (R.rand.chance(0.55)) {
    const t2 = T0 + 0.14 + R.rand.range(0, 0.06);
    hit(t2, 0.45, R.rand.range(-90, 90));
    hit(t2 + (t2 - T0) * 0.72, 0.2, R.rand.range(-140, 140));
  }
}

function buildLumberKnock(R, dest, p = {}) {
  // Pitch-shift by beam length — a practiced player learns which beam is in their hands.
  const len = p.length ?? R.rand.range(1.8, 3.4);
  const ex = burst(R, T0, 0.0015, 1, 'white');
  const hp = biquad(R, 'highpass', 900, 0.7);
  ex.connect(hp);
  modal(R, hp, BEAM_KNOCK, dest, T0, { fScale: 2.4 / len, detuneCents: R.rand.range(-25, 25) });
}

// ================================================================ §4.4–4.9 BUILD SFX

function buildHammerWood(R, dest, p = {}) {
  // Its pitch rises 4% per successful strike as the nail seats — the pitch rise is the
  // progress bar. AudioEngine selects the variant by strike index.
  const strike = p.strike ?? 0;
  const nailScale = Math.pow(1.04, strike);

  const ex = burst(R, T0, 0.0012, 1, 'white');
  const hp = biquad(R, 'highpass', 2000, 0.7);
  const tg = gain(R, dbToGain(-6));
  ex.connect(hp); hp.connect(tg); tg.connect(dest);

  modal(R, hp, [
    { f: 3120 * nailScale, Q: 180, g: 0.35, d: 110 },
    { f: 6740 * nailScale, Q: 140, g: 0.18, d: 70 },
  ], dest, T0);

  modal(R, ex, SAWN_WOOD, dest, T0, { qScale: 0.8, decayScale: 0.7, gainScale: dbToGain(-8) });
  tone(R, dest, T0, 0.07, 96, 71, dbToGain(-14), { attack: 0.002 });
}

function buildHammerSteel(R, dest) {
  const ex = burst(R, T0, 0.0012, 1, 'white');
  const hp = biquad(R, 'highpass', 2000, 0.7);
  ex.connect(hp);

  // The initial contact is nonlinear; the modes go sharp and settle (detuneRamp).
  const sat = saturator(R, 1.6);
  const satGate = gain(R, 1);
  hp.connect(satGate); satGate.connect(sat.input);
  satGate.gain.setValueAtTime(1, T0);
  satGate.gain.setTargetAtTime(0, T0 + 0.06, 0.01);
  const clean = gain(R, dbToGain(-6));
  hp.connect(clean); clean.connect(dest);
  sat.output.connect(dest);

  modal(R, hp, STEEL, dest, T0, { detuneRamp: 35, detuneCents: R.rand.range(-25, 25) });
}

function buildBracketDropRock(R, dest) {
  // The comedy sound. It must be inconveniently charming.
  const gains = [0, -7, -13, -19, -25];
  const decays = [220, 180, 150, 120, 90];
  const count = R.rand.int(3, 5);
  let t = T0;
  let step = 0.165;
  for (let i = 0; i < count; i++) {
    const ex = burst(R, t, 0.001, 1, 'white');
    const hp = biquad(R, 'highpass', 1600, 0.7);
    ex.connect(hp);
    modal(R, hp, STEEL, dest, t, {
      decayScale: decays[i] / 1800, gainScale: dbToGain(gains[i]),
      detuneCents: R.rand.range(-90, 90),   // it is tumbling, presenting different faces
    });
    modal(R, ex, ROCK_TICK, dest, t, {
      fScale: R.rand.range(0.8, 1.3), gainScale: dbToGain(gains[i] - 2),
    });
    t += step;
    step *= 0.68;
  }
  // The settle. This tail is the joke: half a second of small hardware announcing itself.
  const flut = gain(R, dbToGain(-28));
  flut.connect(dest);
  grainTrain(R, {
    t0: t, dur: 0.38, rate: 34, rateEnd: 90, jitter: 0.5, max: 34,
    spawn: (tt) => {
      const r = R.rand.range(0.85, 1.2);
      modal(R, burst(R, tt, 0.0008, 1, 'white'), [
        { f: 2130 * r, Q: 240, g: 1, d: 60 },
        { f: 3910 * r, Q: 200, g: 0.4, d: 40 },
      ], flut, tt);
    },
  });
}

function buildScrewTorque(R, dest) {
  // A continuous readout of torque: rate rises, jitter falls, centre frequency sweeps up
  // almost an octave and a half, and then the seat thump says *correct*.
  const dur = R.rand.range(1.1, 1.8);
  const bed = gain(R, dbToGain(-24));
  const bedLp = biquad(R, 'lowpass', 300, 1.2);
  bedLp.frequency.setValueAtTime(300, T0);
  bedLp.frequency.exponentialRampToValueAtTime(1000, T0 + dur);
  noiseSrc(R, 'brown', T0, dur).connect(bedLp);
  bedLp.connect(bed); bed.connect(dest);

  const out = gain(R, 1); out.connect(dest);
  const steps = 46;
  let t = T0;
  for (let i = 0; i < steps && t < T0 + dur; i++) {
    const torque = clamp((t - T0) / dur, 0, 1);
    pingGrain(R, out, t, {
      f: 480 + 1900 * torque, Q: 5 + 9 * torque, dur: 0.003, decay: 0.022,
      level: 0.4 + 0.6 * torque,
    });
    const rate = 26 + 34 * torque;
    const jit = 0.35 - 0.2 * torque;
    t += (1 / rate) * (1 + jit * (R.rand.next() * 2 - 1));
  }
  // SEAT: the grain train stops dead. Mixed +2 dB louder than it strictly needs to be.
  const st = T0 + dur + 0.02;
  const ex = burst(R, st, 0.0015, 1, 'white');
  modal(R, ex, [
    { f: 158, Q: 30, g: 1, d: 150 },
    { f: 390, Q: 26, g: 0.5, d: 110 },
  ], dest, st, { gainScale: dbToGain(2) });
  modal(R, ex, [{ f: 4000, Q: 40, g: 0.12, d: 18 }], dest, st);
}

function buildScrewSeat(R, dest) {
  const ex = burst(R, T0, 0.0015, 1, 'white');
  modal(R, ex, [
    { f: 158, Q: 30, g: 1, d: 150 },
    { f: 390, Q: 26, g: 0.5, d: 110 },
  ], dest, T0, { gainScale: dbToGain(2), detuneCents: R.rand.range(-30, 30) });
  modal(R, ex, [{ f: 4000, Q: 40, g: 0.12, d: 18 }], dest, T0);
}

function buildScrewStrip(R, dest) {
  // Ruined. The bite collapses to a slow, dull, wide wash. It will creak.
  const out = gain(R, 1); out.connect(dest);
  grainTrain(R, {
    t0: T0, dur: 0.5, rate: 8, jitter: 0.4, max: 10,
    spawn: (t) => pingGrain(R, out, t, { f: 400, Q: 1, dur: 0.006, decay: 0.05, level: 0.7 }),
  });
  const bp = biquad(R, 'bandpass', 420, 1.0);
  const wg = gain(R, 0);
  noiseSrc(R, 'pink', T0, 0.28).connect(bp);
  bp.connect(wg); wg.connect(dest);
  wg.gain.setValueAtTime(0, T0);
  wg.gain.linearRampToValueAtTime(dbToGain(-12), T0 + 0.02);
  wg.gain.exponentialRampToValueAtTime(MIN_GAIN, T0 + 0.26);
  wg.gain.setValueAtTime(0, T0 + 0.27);
}

function buildWoodSplit(R, dest) {
  // Fibres letting go one at a time. Rising density = rising dread.
  const pre = gain(R, 0.5); pre.connect(dest);
  grainTrain(R, {
    t0: T0, dur: 0.4, rate: 12, rateEnd: 70, jitter: 1.0, max: 40,
    spawn: (t) => {
      const r = R.rand.range(0.6, 1.6);
      modal(R, burst(R, t, 0.001, 1, 'white'), [
        { f: 1900 * r, Q: 30, g: 1, d: 40 },
        { f: 3800 * r, Q: 24, g: 0.4, d: 24 },
      ], pre, t);
    },
  });

  // THE CRACK.
  const ct = T0 + 0.4;
  const ex = burst(R, ct, 0.003, 1, 'white');
  const hp = biquad(R, 'highpass', 1200, 0.7);
  const cg = gain(R, dbToGain(-2));
  ex.connect(hp); hp.connect(cg); cg.connect(dest);
  tone(R, dest, ct, 0.055, 1400, 180, 0.5, { attack: 0.001 });   // the whipcrack of release
  modal(R, ex, SAWN_WOOD, dest, ct, { qScale: 2, gainScale: dbToGain(6), decayScale: 2.5 });

  // Tear tail.
  const tb = biquad(R, 'bandpass', 2600, 1.6);
  tb.frequency.setValueAtTime(2600, ct);
  tb.frequency.exponentialRampToValueAtTime(700, ct + 0.7);
  const tg = gain(R, 0);
  noiseSrc(R, 'pink', ct, 0.72).connect(tb);
  tb.connect(tg); tg.connect(dest);
  tg.gain.setValueAtTime(0, ct);
  tg.gain.linearRampToValueAtTime(dbToGain(-16), ct + 0.01);
  tg.gain.exponentialRampToValueAtTime(MIN_GAIN, ct + 0.7);
  tg.gain.setValueAtTime(0, ct + 0.71);
}

function buildNailPull(R, dest) {
  // An *upward* sweep — the free shank shortens as it comes out — then the release.
  frictionOsc(R, dest, {
    t0: T0, dur: 0.5, slipRate: 26, fStart: 620, fEnd: 1450, qStart: 130,
    level: dbToGain(-14), partnerDb: -12, bedDb: -30, irregular: 0.5, bodyF: 214, bodyDb: -22,
  });
  const pt = T0 + 0.5;
  const ex = burst(R, pt, 0.0015, 1, 'white');
  modal(R, ex, [
    { f: 940, Q: 60, g: 1, d: 90 },
    { f: 2200, Q: 40, g: 0.6, d: 60 },
  ], dest, pt);
  const lp = biquad(R, 'lowpass', 700, 0.8);
  const cg = gain(R, dbToGain(-14));
  burst(R, pt, 0.025, 1, 'pink').connect(lp);
  lp.connect(cg); cg.connect(dest);
}

function buildCanvasFlap(R, dest) {
  const lp = biquad(R, 'lowpass', 3200, 1.8);
  lp.frequency.setValueAtTime(3200, T0);
  lp.frequency.exponentialRampToValueAtTime(380, T0 + 0.12);
  const wg = gain(R, 0);
  noiseSrc(R, 'white', T0, 0.15).connect(lp);
  lp.connect(wg); wg.connect(dest);
  wg.gain.setValueAtTime(0, T0);
  wg.gain.linearRampToValueAtTime(0.8, T0 + 0.006);
  wg.gain.exponentialRampToValueAtTime(MIN_GAIN, T0 + 0.136);
  wg.gain.setValueAtTime(0, T0 + 0.138);

  tone(R, dest, T0, 0.06, 68, 60, dbToGain(-20), { attack: 0.005 });   // the pole taking load

  if (R.rand.chance(0.25)) {
    const st = T0 + R.rand.range(0.04, 0.1);
    const hp = biquad(R, 'highpass', 3000, 0.7);
    const sg = gain(R, dbToGain(-12));
    burst(R, st, 0.002, 1, 'white').connect(hp);
    hp.connect(sg); sg.connect(dest);
  }
  // A tensioned guy-line singing. One of the loveliest sounds in the game.
  if (R.rand.chance(0.18)) {
    const gt = T0 + 0.05;
    modal(R, burst(R, gt, 0.002, 0.4, 'white'),
      [{ f: 190 * R.rand.range(0.9, 1.1), Q: 280, g: 1, d: 1400 }],
      dest, gt, { gainScale: dbToGain(-30) });
  }
}

function buildTwigSnap(R, dest, p = {}) {
  const r = p.r ?? R.rand.range(0.7, 1.5);
  const big = r < 0.85;
  const small = r > 1.2;
  const scale = big ? 1.7 : small ? 0.6 : 1;
  const lvl = big ? dbToGain(4) : small ? dbToGain(-6) : 1;

  const ex = burst(R, T0, 0.002, 1, 'white');
  const hp = biquad(R, 'highpass', 2200, 0.7);
  const tg = gain(R, dbToGain(-4) * lvl);
  ex.connect(hp); hp.connect(tg); tg.connect(dest);

  modal(R, ex, [
    { f: 920 * r, Q: 44, g: 1, d: 60 * scale },
    { f: 2140 * r, Q: 36, g: 0.6, d: 38 * scale },
    { f: 4900 * r, Q: 24, g: 0.25, d: 20 * scale },
  ], dest, T0, { gainScale: lvl });

  const fb = biquad(R, 'bandpass', 3000, 2);
  const fdur = 0.13 * scale;
  fb.frequency.setValueAtTime(3000, T0);
  fb.frequency.exponentialRampToValueAtTime(1100, T0 + fdur);
  const fg = gain(R, 0);
  noiseSrc(R, 'pink', T0, fdur + 0.02).connect(fb);
  fb.connect(fg); fg.connect(dest);
  fg.gain.setValueAtTime(0, T0);
  fg.gain.linearRampToValueAtTime(dbToGain(-18) * lvl, T0 + 0.005);
  fg.gain.exponentialRampToValueAtTime(MIN_GAIN, T0 + fdur);
  fg.gain.setValueAtTime(0, T0 + fdur + 0.001);

  if (big) tone(R, dest, T0, 0.12, 74, 58, dbToGain(-12), { attack: 0.003 });
}

// ================================================================ §4.11 THE CREAK
//
// The signature sound of the whole game. Four categorical tiers so the player can *name*
// what they just heard, and a body resonance that tracks the size of the member: a batten
// ticks, a ridge beam dies.

/** Size buckets in metres. `size` is the length of the member that is complaining. */
export const CREAK_SIZES = [1.2, 2.4, 4.6];
export const CREAK_DURATIONS = [0.16, 0.5, 1.28, 2.75];

export function creakTier(severity) {
  const s = clamp(Number(severity) || 0, 0, 1);
  if (s <= 0.25) return 1;
  if (s <= 0.5) return 2;
  if (s <= 0.8) return 3;
  return 4;
}

export function creakSizeIndex(size) {
  const s = Number(size);
  if (!Number.isFinite(s)) return 1;
  if (s <= 1.7) return 0;
  if (s <= 3.4) return 1;
  return 2;
}

/** `creak.t<tier>.s<sizeIndex>` — the id under which a creak variant is cached. */
export function creakId(severity, size) {
  return `creak.t${creakTier(severity)}.s${creakSizeIndex(size)}`;
}

function bodyFreqFor(size) {
  // The beam-knock fundamental scales as f × (2.4 / lengthMetres) (§4.3).
  return clamp(214 * (2.4 / Math.max(0.4, size)), 46, 620);
}

function buildCreak(R, dest, p = {}) {
  const tier = p.tier ?? 1;
  const size = p.size ?? 2.4;
  const bodyF = bodyFreqFor(size);
  // Bigger members drop further and ring lower.
  const sizeF = clamp(2.4 / Math.max(0.5, size), 0.62, 1.5);

  if (tier === 1) {
    // "The tick." A house at night. The player is *allowed* to ignore this one, and that
    // permission is what makes tiers 3 and 4 terrifying.
    frictionOsc(R, dest, {
      t0: T0, dur: 0.09, slipRate: 34, slips: 3, fStart: 2400 * sizeF, pitchDropCents: 90,
      qStart: 70, level: dbToGain(-30) * 8, partnerDb: -60, bedDb: -60,
      bodyF: bodyF * 2, bodyDb: -26, irregular: 0.45, drive: 1.15,
    });
    return;
  }

  if (tier === 2) {
    // "The complaint." A short, high, unmistakable *eeuk*.
    frictionOsc(R, dest, {
      t0: T0, dur: 0.42, slipRate: 22, slips: 9, fStart: 1650 * sizeF, pitchDropCents: 260,
      qStart: 110, level: dbToGain(-20) * 8, partnerDb: -8, bedDb: -30,
      bodyF, bodyDb: -20, irregular: 0.55, drive: 1.25,
    });
    return;
  }

  if (tier === 3) {
    // "The groan." Long enough to be a *sentence*; the slips individuate and can be counted.
    frictionOsc(R, dest, {
      t0: T0, dur: 1.15, slipRate: 13, slips: 17, fStart: 880 * sizeF, pitchDropCents: 520,
      qStart: 160, level: dbToGain(-12) * 8, partnerDb: -8, bedDb: -26,
      bodyF, bodyDb: -16, irregular: 0.6, subF: 74, subDb: -22, drive: 1.3, slipShape: 0.8,
    });
    return;
  }

  // ---- Tier 4: "the failure". 2.6 s in three movements. The building is dying.
  // 1. 0–900 ms, THE LOAD. Slips so slow they are individually audible as knocks.
  frictionOsc(R, dest, {
    t0: T0, dur: 0.9, slipRate: 9, slips: 8, fStart: 640 * sizeF, pitchDropCents: 700,
    qStart: 220, level: dbToGain(-8) * 8, partnerDb: -10, bedDb: -24,
    bodyF, bodyDb: -14, irregular: 0.5, drive: 1.35, slipShape: 0.7,
  });
  const load = R.ctx.createOscillator();
  const loadG = gain(R, 0);
  load.type = 'sine';
  load.frequency.setValueAtTime(52, T0);
  load.connect(loadG); loadG.connect(dest);
  loadG.gain.setValueAtTime(dbToGain(-40), T0);
  loadG.gain.exponentialRampToValueAtTime(dbToGain(-16), T0 + 0.9);
  loadG.gain.exponentialRampToValueAtTime(dbToGain(-28), T0 + 1.6);
  loadG.gain.setValueAtTime(0, T0 + 1.62);
  load.start(T0); load.stop(T0 + 1.64);

  // 2. 900–1600 ms, THE DESCENT. f_center falls to 190 Hz, Q climbs to 260, and a
  //    subharmonic appears — something too big making a sound too low for its size.
  frictionOsc(R, dest, {
    t0: T0 + 0.9, dur: 0.7, slipRate: 7, slips: 6, fStart: 430 * sizeF, fEnd: 190 * sizeF,
    qStart: 220, qEnd: 260, level: dbToGain(-7) * 8, partnerDb: -12, bedDb: -22,
    bodyF: bodyF * 0.75, bodyDb: -12, irregular: 0.55, drive: 1.4,
    subharmDb: -14, tremoloHz: 5.5, tremoloDepth: 0.36, slipShape: 0.6,
  });

  // 3. 1600–2600 ms, THE TEAR. wood.split at full level, then a *decelerating* crackle —
  //    an accelerating crackle reads as tension, a decelerating one reads as aftermath.
  const tt = T0 + 1.6;
  const splitScope = { ...R, rand: R.rand.fork('split') };
  const splitBus = gain(R, 1); splitBus.connect(dest);
  buildWoodSplitAt(splitScope, splitBus, tt - 0.4);

  const deb = gain(R, dbToGain(-14)); deb.connect(dest);
  grainTrain(R, {
    t0: tt + 0.06, dur: 0.9, rate: 60, rateEnd: 6, jitter: 0.9, max: 46,
    spawn: (t) => {
      const det = R.rand.range(-700, 700);
      modal(R, burst(R, t, 0.0012, 1, 'white'), SAWN_WOOD, deb, t, {
        detuneCents: det, decayScale: 0.35, gainScale: R.rand.range(0.25, 0.8),
      });
    },
  });

  // 4. 5% chance: 400 ms of nothing, then one very quiet tick. The building has one more
  //    thing to say.
  if (R.rand.chance(0.05)) {
    const lt = T0 + 2.5;
    modal(R, burst(R, lt, 0.001, 1, 'white'),
      [{ f: 2400 * sizeF, Q: 70, g: 1, d: 45 }], dest, lt, { gainScale: dbToGain(-34) * 8 });
  }
}

/** wood.split, positioned at an arbitrary time (used inside the tier-4 creak). */
function buildWoodSplitAt(R, dest, at) {
  const off = at - T0;
  const shift = (f) => f;   // frequencies unchanged; only the schedule moves
  const pre = gain(R, 0.5); pre.connect(dest);
  grainTrain(R, {
    t0: T0 + off, dur: 0.4, rate: 12, rateEnd: 70, jitter: 1.0, max: 40,
    spawn: (t) => {
      const r = R.rand.range(0.6, 1.6);
      modal(R, burst(R, t, 0.001, 1, 'white'), [
        { f: shift(1900 * r), Q: 30, g: 1, d: 40 },
        { f: shift(3800 * r), Q: 24, g: 0.4, d: 24 },
      ], pre, t);
    },
  });
  const ct = T0 + off + 0.4;
  const ex = burst(R, ct, 0.003, 1, 'white');
  const hp = biquad(R, 'highpass', 1200, 0.7);
  const cg = gain(R, dbToGain(-2));
  ex.connect(hp); hp.connect(cg); cg.connect(dest);
  tone(R, dest, ct, 0.055, 1400, 180, 0.5, { attack: 0.001 });
  modal(R, ex, SAWN_WOOD, dest, ct, { qScale: 2, gainScale: dbToGain(6), decayScale: 2.5 });
  const tb = biquad(R, 'bandpass', 2600, 1.6);
  tb.frequency.setValueAtTime(2600, ct);
  tb.frequency.exponentialRampToValueAtTime(700, ct + 0.7);
  const tg = gain(R, 0);
  noiseSrc(R, 'pink', ct, 0.72).connect(tb);
  tb.connect(tg); tg.connect(dest);
  tg.gain.setValueAtTime(0, ct);
  tg.gain.linearRampToValueAtTime(dbToGain(-16), ct + 0.01);
  tg.gain.exponentialRampToValueAtTime(MIN_GAIN, ct + 0.7);
  tg.gain.setValueAtTime(0, ct + 0.71);
}

// ================================================================ §4.12–4.15 WEATHER

function buildRainLeaves(R, dest) {
  const dur = R.ctx.length / R.sr;
  const bp = biquad(R, 'bandpass', 1900, 0.55);
  const hs = biquad(R, 'highshelf', 7000, 0.7, -4);
  const bg = gain(R, dbToGain(-6));
  noiseSrc(R, 'pink', 0, dur).connect(bp);
  noiseSrc(R, 'pink', 0, dur, { rate: 1.031 }).connect(bp);
  bp.connect(hs); hs.connect(bg); bg.connect(dest);
  // The rain moving through the trees in sheets — a very slow walk on the bed's centre.
  let t = 0;
  while (t < dur) {
    bp.frequency.setTargetAtTime(R.rand.range(1500, 2400), t, 3.0);
    t += R.rand.range(6, 14) * 0.5;
  }
  const gr = gain(R, dbToGain(-14)); gr.connect(dest);
  grainTrain(R, {
    t0: 0.005, dur: dur - 0.01, rate: 240, jitter: 1.0, max: Math.min(R.tierMax ?? 400, 420),
    spawn: (tt) => pingGrain(R, gr, tt, {
      f: 2600 * R.rand.range(0.5, 1.8), Q: 2.4, dur: 0.004, decay: 0.012,
      level: R.rand.range(0.3, 1),
    }),
  });
}

function buildRainTin(R, dest) {
  const dur = R.ctx.length / R.sr;
  const hp = biquad(R, 'highpass', 1400, 0.7);
  const bp = biquad(R, 'bandpass', 4200, 0.7);
  const bg = gain(R, dbToGain(-4));
  noiseSrc(R, 'pink', 0, dur).connect(hp);
  hp.connect(bp); bp.connect(bg); bg.connect(dest);
  // Pitched pings, not noise. This is why tin rain is unmistakable.
  const gr = gain(R, dbToGain(-12)); gr.connect(dest);
  grainTrain(R, {
    t0: 0.005, dur: dur - 0.01, rate: 300, jitter: 1.0, max: Math.min(R.tierMax ?? 400, 460),
    spawn: (tt) => {
      const r = R.rand.range(0.85, 1.2);
      modal(R, burst(R, tt, 0.0004, 1, 'white'), [
        { f: 3900 * r, Q: 130, g: 1, d: 35 },
        { f: 6800 * r, Q: 100, g: 0.5, d: 22 },
      ], gr, tt, { gainScale: R.rand.range(0.35, 1) });
    },
  });
}

function buildRainWater(R, dest) {
  const dur = R.ctx.length / R.sr;
  const lp = biquad(R, 'lowpass', 900, 0.7);
  const bg = gain(R, dbToGain(-8));
  noiseSrc(R, 'pink', 0, dur).connect(lp);
  lp.connect(bg); bg.connect(dest);
  // The classic droplet: a sine whose frequency *rises*. That is what makes it read as
  // water and not as a bell.
  const pl = gain(R, dbToGain(-6)); pl.connect(dest);
  grainTrain(R, {
    t0: 0.02, dur: dur - 0.05, rate: 22, jitter: 1.0, max: 160,
    spawn: (tt) => {
      const f0 = 900 * R.rand.range(0.6, 2.2);
      const o = R.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(fclamp(R, f0), tt);
      o.frequency.exponentialRampToValueAtTime(fclamp(R, f0 * 1.18), tt + 0.009);
      const g = gain(R, 0);
      o.connect(g); g.connect(pl);
      g.gain.setValueAtTime(0, tt);
      g.gain.linearRampToValueAtTime(R.rand.range(0.4, 1), tt + 0.001);
      g.gain.exponentialRampToValueAtTime(MIN_GAIN, tt + 0.045);
      g.gain.setValueAtTime(0, tt + 0.047);
      o.start(tt); o.stop(tt + 0.06);
    },
  });
}

function buildWindPines(R, dest) {
  // A loopable banded bed with independently drifting formants. AudioEngine layers a live
  // band model on top of this; the bed guarantees motion even on `low`.
  const dur = R.ctx.length / R.sr;
  const bands = [
    { f: 380, Q: 0.75, base: 1.0 },
    { f: 1150, Q: 1.10, base: 0.62 },
    { f: 2700, Q: 1.40, base: 0.40 },
  ];
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    const bp = biquad(R, 'bandpass', b.f, b.Q);
    const g = gain(R, b.base * 0.5);
    noiseSrc(R, 'pink', 0, dur, { rate: 1 + i * 0.017 }).connect(bp);
    bp.connect(g); g.connect(dest);
    // Independent random walks — the bands drifting against each other is the whole trick.
    // One correlated envelope sounds like a fan.
    let t = 0;
    while (t < dur) {
      g.gain.setTargetAtTime(b.base * R.rand.range(0.55, 1.45) * 0.5, t, 0.35);
      bp.frequency.setTargetAtTime(b.f * R.rand.range(0.88, 1.14), t, 0.5);
      t += R.rand.range(0.4, 0.9);
    }
  }
  const hp = biquad(R, 'highpass', 5200, 0.7);
  const sz = biquad(R, 'bandpass', 7400, 0.6);
  const sg = gain(R, 0.16);
  noiseSrc(R, 'pink', 0, dur, { rate: 0.983 }).connect(hp);
  hp.connect(sz); sz.connect(sg); sg.connect(dest);
  let t = 0;
  while (t < dur) { sg.gain.setTargetAtTime(0.16 * R.rand.range(0.5, 1.5), t, 0.35); t += R.rand.range(0.4, 0.9); }
}

function buildWindGust(R, dest) {
  const dur = 5.5;
  const lp = biquad(R, 'lowpass', 900, 0.6);
  const out = gain(R, 0);
  lp.connect(out); out.connect(dest);
  for (let i = 0; i < 3; i++) {
    const f = [420, 1250, 2900][i];
    const bp = biquad(R, 'bandpass', f, [0.8, 1.1, 1.4][i]);
    const g = gain(R, [1, 0.7, 0.5][i]);
    noiseSrc(R, 'pink', 0, dur, { rate: 1 + i * 0.021 }).connect(bp);
    bp.connect(g); g.connect(lp);
    bp.frequency.setValueAtTime(f * 0.85, 0);
    bp.frequency.linearRampToValueAtTime(f * 1.25, dur * 0.45);
    bp.frequency.linearRampToValueAtTime(f * 0.8, dur);
  }
  // Gusts open the top end — that is what makes a gust *arrive*.
  lp.frequency.setValueAtTime(900, 0);
  lp.frequency.exponentialRampToValueAtTime(7400, dur * 0.42);
  lp.frequency.exponentialRampToValueAtTime(700, dur);
  out.gain.setValueAtTime(0, 0);
  out.gain.linearRampToValueAtTime(1, dur * 0.4);
  out.gain.exponentialRampToValueAtTime(MIN_GAIN, dur);
  out.gain.setValueAtTime(0, dur - 0.001);
}

function buildWindWhistle(R, dest) {
  // A trunk resonating. Rare, tonal — the first time a player hears it they will think it
  // is a voice.
  const dur = 2.8;
  const ex = gain(R, 0);
  const src = noiseSrc(R, 'pink', 0, dur);
  src.connect(ex);
  ex.gain.setValueAtTime(0, 0);
  ex.gain.linearRampToValueAtTime(0.6, 0.35);
  ex.gain.exponentialRampToValueAtTime(MIN_GAIN, dur);
  ex.gain.setValueAtTime(0, dur - 0.001);
  modal(R, ex, [{ f: 2400 * R.rand.range(0.9, 1.15), Q: 340, g: 1, d: 2500 }], dest, 0.004);
}

function buildThunder(R, dest, p = {}) {
  const cls = p.cls ?? 'mid';
  if (cls === 'near') {
    // The crack: a broadband transient with almost no low end. The low end arrives *after*.
    const ex = burst(R, T0, 0.008, 1, 'white');
    const hp = biquad(R, 'highpass', 300, 0.7);
    const sat = saturator(R, 3.4);
    const cg = gain(R, dbToGain(-3));
    ex.connect(hp); hp.connect(sat.input); sat.output.connect(cg); cg.connect(dest);
    rumble(R, dest, T0 + 0.01, 2.2, 320, 0.75);
    return;
  }
  if (cls === 'mid') {
    const d = p.distance ?? 900;
    const fc = clamp(900 * Math.sqrt(400 / d), 140, 700);
    rumble(R, dest, T0, clamp(2.5 + d / 500, 2.5, 5.4), fc, 0.55);
    return;
  }
  // Far: entirely lumps, no transient. Distant thunder is *all* reverb.
  rumble(R, dest, T0, 7.5, 110, 0.16);
}

/** The multi-tap amplitude sequence that makes thunder *roll* (§4.14). */
function rumble(R, dest, t0, dur, fc, peak) {
  const lp = biquad(R, 'lowpass', fc, 0.8);
  const out = gain(R, 0);
  noiseSrc(R, 'brown', t0, dur + 0.1).connect(lp);
  lp.connect(out); out.connect(dest);
  const g = out.gain;
  g.setValueAtTime(MIN_GAIN, t0);
  const tau = dur / 2.5;
  let t = t0;
  let i = 0;
  while (t < t0 + dur && i < 12) {
    const env = Math.exp(-(t - t0) / tau);
    const amp = Math.max(MIN_GAIN, peak * env * R.rand.range(0.35, 1.0));
    const up = R.rand.range(0.06, 0.3);
    g.setTargetAtTime(amp, t, up);
    g.setTargetAtTime(amp * 0.18, t + up * 2.2, R.rand.range(0.12, 0.5));
    t += R.rand.range(0.2, 1.4);
    i++;
  }
  g.setTargetAtTime(MIN_GAIN, t0 + dur * 0.86, dur * 0.08);
  g.setValueAtTime(0, t0 + dur + 0.05);
}

function buildCampfire(R, dest) {
  const dur = R.ctx.length / R.sr;
  const lp = biquad(R, 'lowpass', 520, 0.7);
  const bg = gain(R, dbToGain(-8));
  noiseSrc(R, 'brown', 0, dur).connect(lp);
  lp.connect(bg); bg.connect(dest);
  let t = 0;
  while (t < dur) { bg.gain.setTargetAtTime(dbToGain(-8 + R.rand.range(-3, 3)), t, 0.12); t += 0.25; }

  const cr = gain(R, dbToGain(-2)); cr.connect(dest);
  grainTrain(R, {
    t0: 0.01, dur: dur - 0.05, rate: 9, jitter: 1.0, max: 90,
    spawn: (tt, i) => {
      const r = R.rand.range(0.5, 2.2);
      const pop = i % 14 === 13;
      const modes = [
        { f: 2400 * r, Q: 26, g: 1, d: 14 },
        { f: 5100 * r, Q: 18, g: 0.4, d: 8 },
      ];
      if (pop) modes.push({ f: 640 * r, Q: 12, g: 1.2, d: 60 });
      modal(R, burst(R, tt, 0.0006, 1, 'white'), modes, cr, tt, {
        gainScale: (pop ? dbToGain(7) : 1) * R.rand.range(0.5, 1),
      });
    },
  });
}

function buildCampfirePop(R, dest) {
  const r = R.rand.range(0.6, 1.8);
  modal(R, burst(R, T0, 0.0008, 1, 'white'), [
    { f: 640 * r, Q: 12, g: 1.2, d: 60 },
    { f: 2400 * r, Q: 26, g: 0.8, d: 14 },
    { f: 5100 * r, Q: 18, g: 0.3, d: 8 },
  ], dest, T0);
  // A tiny ember hiss.
  const bp = biquad(R, 'bandpass', 3800, 1.2);
  bp.frequency.setValueAtTime(3800, T0);
  bp.frequency.exponentialRampToValueAtTime(1400, T0 + 0.09);
  const hg = gain(R, 0);
  noiseSrc(R, 'white', T0, 0.1).connect(bp);
  bp.connect(hg); hg.connect(dest);
  hg.gain.setValueAtTime(0, T0);
  hg.gain.linearRampToValueAtTime(dbToGain(-26), T0 + 0.005);
  hg.gain.exponentialRampToValueAtTime(MIN_GAIN, T0 + 0.09);
  hg.gain.setValueAtTime(0, T0 + 0.092);
}

function buildWaterLap(R, dest) {
  const dur = R.ctx.length / R.sr;
  const lp = biquad(R, 'lowpass', 700, 0.6);
  const bg = gain(R, dbToGain(-16));
  noiseSrc(R, 'brown', 0, dur).connect(lp);
  lp.connect(bg); bg.connect(dest);
  const sl = gain(R, dbToGain(-14)); sl.connect(dest);
  grainTrain(R, {
    t0: 0.05, dur: dur - 0.1, rate: 1.6, jitter: 0.7, max: 18,
    spawn: (tt) => {
      const bp = biquad(R, 'bandpass', R.rand.range(700, 1600), 0.9);
      const g = gain(R, 0);
      noiseSrc(R, 'pink', tt, 0.6).connect(bp);
      bp.connect(g); g.connect(sl);
      g.gain.setValueAtTime(0, tt);
      g.gain.linearRampToValueAtTime(R.rand.range(0.4, 1), tt + 0.12);
      g.gain.exponentialRampToValueAtTime(MIN_GAIN, tt + 0.55);
      g.gain.setValueAtTime(0, tt + 0.56);
    },
  });
}

// ================================================================ §4.16–4.20 + camp life

function buildZipper(R, dest) {
  // The rate curve is the hand speed. This sound is a gameplay siren: it means someone is
  // coming out of a tent.
  const dur = R.rand.range(0.45, 0.85);
  const body = biquad(R, 'bandpass', 2900, 1.2);
  const pres = biquad(R, 'peaking', 3200, 1.4, 3);
  const out = gain(R, 1);
  body.connect(pres); pres.connect(out); out.connect(dest);

  const slider = gain(R, dbToGain(-10));
  slider.connect(out);

  grainTrain(R, {
    t0: T0, dur, rate: 110, rateEnd: 90, jitter: 0.15, max: 160,
    spawn: (t, i, u) => {
      // 110 → 170 → 90 across the pull: the rate curve is the hand speed.
      const boost = u < 0.5 ? 1 + u : 2 - u;
      pingGrain(R, body, t, {
        f: 3400 * R.rand.range(0.92, 1.08) * boost * 0.85, Q: 6, dur: 0.0015, decay: 0.007, level: 0.9,
      });
      if (i % 6 === 0) {
        modal(R, burst(R, t, 0.0012, 0.6, 'white'),
          [{ f: 1250, Q: 16, g: 1, d: 40 }], slider, t);
      }
    },
  });
  // A hard stop and a single click.
  const et = T0 + dur;
  modal(R, burst(R, et, 0.0008, 1, 'white'),
    [{ f: 1880, Q: 34, g: 1, d: 30 }, { f: 3720, Q: 28, g: 0.5, d: 18 }], dest, et,
    { gainScale: dbToGain(-6) });
}

function buildClick(R, dest, p = {}) {
  // A camper's thumb on a switch is the most important 55 ms in the game. The player must
  // be able to tell on from off by ear.
  const off = !!p.off;
  const fs = off ? 0.94 : 1;
  const lvl = off ? dbToGain(-2) : 1;
  const ex = burst(R, T0, 0.0008, 1, 'white');
  const bp = biquad(R, 'bandpass', 3600 * fs, 5.5);
  const tg = gain(R, dbToGain(-8) * lvl);
  ex.connect(bp); bp.connect(tg); tg.connect(dest);
  modal(R, ex, [
    { f: 1880, Q: 34, g: 1, d: 38 },
    { f: 3720, Q: 28, g: 0.5, d: 26 },
    { f: 7100, Q: 20, g: 0.2, d: 14 },
  ], dest, T0, { fScale: fs, gainScale: lvl });
  if (R.rand.chance(0.12)) {
    modal(R, ex, [{ f: 5400, Q: 180, g: 0.15, d: 220 }], dest, T0);
  }
}

function buildShutterClick(R, dest) {
  // A metal shutter: two leaves, a spring, and a stop. Dry and mechanical.
  const ex = burst(R, T0, 0.0009, 1, 'white');
  const hp = biquad(R, 'highpass', 2400, 0.7);
  const tg = gain(R, dbToGain(-6));
  ex.connect(hp); hp.connect(tg); tg.connect(dest);
  modal(R, ex, [
    { f: 2130 * R.rand.range(0.95, 1.05), Q: 220, g: 0.7, d: 90 },
    { f: 4680, Q: 180, g: 0.4, d: 60 },
    { f: 9100, Q: 120, g: 0.15, d: 30 },
  ], dest, T0);
  const t2 = T0 + 0.032;
  modal(R, burst(R, t2, 0.0007, 0.6, 'white'), [
    { f: 1620, Q: 90, g: 1, d: 55 },
    { f: 3300, Q: 70, g: 0.4, d: 35 },
  ], dest, t2, { gainScale: dbToGain(-5) });
}

function buildGlassPing(R, dest) {
  const r = R.rand.range(0.97, 1.03);
  modal(R, burst(R, T0, 0.0005, 1, 'white'), [
    { f: 2830 * r, Q: 95, g: 1, d: 210 },
    { f: 4410 * r, Q: 110, g: 0.6, d: 170 },
    { f: 6920 * r, Q: 80, g: 0.25, d: 120 },
  ], dest, T0);
}

function buildLanternHiss(R, dest) {
  const dur = R.ctx.length / R.sr;
  const bp = biquad(R, 'bandpass', 2350, 0.85);
  const hs = biquad(R, 'highshelf', 6000, 0.7, -8);
  const out = gain(R, 0.7);
  noiseSrc(R, 'pink', 0, dur).connect(bp);
  bp.connect(hs); hs.connect(out); out.connect(dest);
  // Flame flicker: a random walk plus a tiny 11.5 Hz sine.
  let t = 0;
  while (t < dur) { out.gain.setTargetAtTime(0.7 * (0.85 + R.rand.next() * 0.3), t, 0.04); t += 0.06; }
  const lfo = R.ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 11.5;
  const d = gain(R, 0.06);
  lfo.connect(d); d.connect(out.gain);
  lfo.start(0); lfo.stop(dur);
}

function buildBreath(R, dest, p = {}) {
  // One half-cycle. AudioEngine schedules inhale/exhale pairs and crossfades between states.
  const ex = !!p.exhale;
  const dur = p.dur ?? 0.9;
  const f0 = p.f0 ?? 480;
  const f1 = p.f1 ?? 820;
  const Q = p.Q ?? 1.3;
  const bp = biquad(R, 'bandpass', f0, Q);
  bp.frequency.setValueAtTime(fclamp(R, f0), T0);
  bp.frequency.exponentialRampToValueAtTime(fclamp(R, f1), T0 + dur);
  const hs = biquad(R, 'highshelf', 6000, 0.7, -9);   // breath has no air on top, it has body
  const g = gain(R, 0);
  noiseSrc(R, 'pink', T0, dur + 0.05).connect(bp);
  bp.connect(hs); hs.connect(g); g.connect(dest);

  const atk = ex ? Math.max(0.02, dur * 0.12) : dur * 0.35;
  g.gain.setValueAtTime(0, T0);
  g.gain.linearRampToValueAtTime(1, T0 + atk);
  g.gain.exponentialRampToValueAtTime(MIN_GAIN, T0 + dur);
  g.gain.setValueAtTime(0, T0 + dur + 0.002);

  // HEAVY adds a voiced component. The player is a big man and you should hear the weight
  // in his chest — but he never performs effort, he just *is* heavy.
  if (p.voiced && ex) {
    const o = R.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(108, T0);
    o.frequency.linearRampToValueAtTime(96, T0 + dur);
    const lp = biquad(R, 'lowpass', 700, 0.8);
    const vg = gain(R, 0);
    o.connect(lp); lp.connect(vg); vg.connect(dest);
    vg.gain.setValueAtTime(0, T0);
    vg.gain.linearRampToValueAtTime(dbToGain(-12), T0 + dur * 0.25);
    vg.gain.exponentialRampToValueAtTime(MIN_GAIN, T0 + dur);
    vg.gain.setValueAtTime(0, T0 + dur + 0.002);
    o.start(T0); o.stop(T0 + dur + 0.03);
  }
}

function buildHeartThump(R, dest) {
  // SUB + THUD. AudioEngine's live lowpass is the fear dial (200 → 620 Hz).
  tone(R, dest, T0, 0.12, 56, 38, 1, { attack: 0.006 });
  const lp = biquad(R, 'lowpass', 900, 1.0);
  const g = gain(R, 0);
  noiseSrc(R, 'brown', T0, 0.06).connect(lp);
  lp.connect(g); g.connect(dest);
  g.gain.setValueAtTime(0, T0);
  g.gain.linearRampToValueAtTime(dbToGain(-10), T0 + 0.004);
  g.gain.exponentialRampToValueAtTime(MIN_GAIN, T0 + 0.045);
  g.gain.setValueAtTime(0, T0 + 0.047);
}

function buildCricketChirp(R, dest) {
  // 4–5 stridulation pulses through the wing's own resonance.
  const f0 = 4600 * R.rand.range(0.92, 1.12);
  const bp = biquad(R, 'bandpass', f0, 6);
  bp.connect(dest);
  const pulses = R.rand.int(4, 5);
  let t = T0;
  for (let i = 0; i < pulses; i++) {
    const pd = 0.014 * R.rand.range(0.85, 1.2);
    for (const [mul, lvl] of [[1, 1], [1.004, 1], [2, dbToGain(-11)]]) {
      const o = R.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = fclamp(R, f0 * mul);
      const g = gain(R, 0);
      o.connect(g); g.connect(bp);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(lvl * 0.5, t + 0.002);
      g.gain.setValueAtTime(lvl * 0.5, t + pd - 0.003);
      g.gain.linearRampToValueAtTime(0, t + pd);
      o.start(t); o.stop(t + pd + 0.01);
    }
    t += pd + 0.015 * R.rand.range(0.9, 1.15);
  }
}

function buildCricketWash(R, dest) {
  const dur = R.ctx.length / R.sr;
  const bp = biquad(R, 'bandpass', 4600, 3.5);
  const out = gain(R, 0.5);
  noiseSrc(R, 'pink', 0, dur).connect(bp);
  bp.connect(out); out.connect(dest);
  const lfo = R.ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 12;
  const d = gain(R, 0.4);
  lfo.connect(d); d.connect(out.gain);
  lfo.start(0); lfo.stop(dur);
}

function buildLoonWail(R, dest, p = {}) {
  const tremolo = !!p.tremolo;
  const dur = 1.75;
  const out = gain(R, 0);
  const form = biquad(R, 'peaking', 1250, 2.2, 4);
  out.connect(form); form.connect(dest);
  for (let h = 1; h <= 4; h++) {
    const o = R.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(fclamp(R, 460 * h), T0);
    o.frequency.exponentialRampToValueAtTime(fclamp(R, 880 * h), T0 + 0.45);
    o.frequency.exponentialRampToValueAtTime(fclamp(R, 810 * h), T0 + 1.6);
    const g = gain(R, dbToGain([0, -7, -13, -20][h - 1]));
    o.connect(g); g.connect(out);
    o.start(T0); o.stop(T0 + dur);
  }
  out.gain.setValueAtTime(0, T0);
  out.gain.linearRampToValueAtTime(0.5, T0 + 0.18);
  out.gain.setValueAtTime(0.5, T0 + 1.38);
  out.gain.exponentialRampToValueAtTime(MIN_GAIN, T0 + 1.72);
  out.gain.setValueAtTime(0, T0 + 1.73);
  // The "crazy" loon. It reads as a scream and players will jump. Ration it.
  if (tremolo) {
    const lfo = R.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 11.5;
    const d = gain(R, 0.45 * 0.5);
    lfo.connect(d); d.connect(out.gain);
    lfo.start(T0); lfo.stop(T0 + dur);
  }
}

function buildOwlHoot(R, dest) {
  const times = [0, 0.34, 0.9, 1.45];
  const bp = biquad(R, 'bandpass', 700, 1.4);
  bp.connect(dest);
  for (let i = 0; i < times.length; i++) {
    const t = T0 + times[i];
    const last = i === times.length - 1;
    for (let h = 1; h <= 3; h++) {
      const o = R.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(fclamp(R, 340 * h), t);
      if (last) o.frequency.linearRampToValueAtTime(fclamp(R, 260 * h), t + 0.22);
      const vib = R.ctx.createOscillator();
      vib.type = 'sine';
      vib.frequency.value = 6;
      const vd = gain(R, 340 * h * 0.008);
      vib.connect(vd); vd.connect(o.frequency);
      vib.start(t); vib.stop(t + 0.26);
      const g = gain(R, 0);
      o.connect(g); g.connect(bp);
      const lvl = dbToGain([0, -9, -17][h - 1]) * 0.5;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(lvl, t + 0.04);
      g.gain.setValueAtTime(lvl, t + 0.16);
      g.gain.exponentialRampToValueAtTime(MIN_GAIN, t + 0.22);
      g.gain.setValueAtTime(0, t + 0.222);
      o.start(t); o.stop(t + 0.25);
    }
  }
}

function buildDawnBird(R, dest) {
  // A white-throated sparrow: one long tone, then four short. Thin, cold, survived.
  const f = 4200;
  const notes = [[0, 0.24], [0.3, 0.09], [0.42, 0.09], [0.54, 0.09], [0.66, 0.09]];
  for (const [dt, d] of notes) {
    tone(R, dest, T0 + dt, d, f * R.rand.range(0.99, 1.01), f * 0.99, 0.5, { attack: 0.01 });
  }
}

// ================================================================ THE MANUAL (sfxUI)
//
// The flat-pack universe. Dry, mono, centred, always the exact same level, no reverb, no
// mask. It sounds like it is playing in a different, cleaner universe. That is the joke.

function buildUiChime(R, dest) {
  // S6: two clean tones, a perfect fourth, 140 ms each, 60 ms apart. Always identical.
  const freqs = [880, 1174];
  for (let i = 0; i < 2; i++) {
    const t = T0 + i * 0.2;
    tone(R, dest, t, 0.14, freqs[i], freqs[i], 0.5, { type: 'sine', attack: 0.006 });
    tone(R, dest, t, 0.14, freqs[i], freqs[i], 0.14, { type: 'triangle', attack: 0.006 });
  }
}

function buildUiClick(R, dest) {
  modal(R, burst(R, T0, 0.0008, 1, 'white'), [
    { f: 2200, Q: 30, g: 1, d: 18 },
    { f: 5200, Q: 20, g: 0.3, d: 10 },
  ], dest, T0);
}

function buildUiPage(R, dest) {
  // Paper. Nothing more.
  const bp = biquad(R, 'bandpass', 3200, 0.8);
  bp.frequency.setValueAtTime(2200, T0);
  bp.frequency.linearRampToValueAtTime(4600, T0 + 0.16);
  const g = gain(R, 0);
  noiseSrc(R, 'pink', T0, 0.24).connect(bp);
  bp.connect(g); g.connect(dest);
  g.gain.setValueAtTime(0, T0);
  g.gain.linearRampToValueAtTime(0.5, T0 + 0.03);
  g.gain.exponentialRampToValueAtTime(MIN_GAIN, T0 + 0.2);
  g.gain.setValueAtTime(0, T0 + 0.21);
  grainTrain(R, {
    t0: T0, dur: 0.18, rate: 40, jitter: 0.9, max: 12,
    spawn: (t) => pingGrain(R, dest, t, { f: R.rand.range(3000, 7000), Q: 4, dur: 0.002, decay: 0.01, level: 0.12 }),
  });
}

function buildUiStamp(R, dest) {
  // A rubber stamp on a form. Bureaucratic, final, and not funny at all if you sell it.
  tone(R, dest, T0, 0.06, 180, 120, 0.35, { attack: 0.003 });
  modal(R, burst(R, T0, 0.0015, 1, 'white'), [
    { f: 420, Q: 12, g: 1, d: 55 },
    { f: 1100, Q: 9, g: 0.4, d: 30 },
  ], dest, T0, { gainScale: 0.5 });
}

function buildUiDeny(R, dest) {
  // `tool:missing`. A single dry wood-block tick. The manual does not editorialise.
  modal(R, burst(R, T0, 0.001, 1, 'white'), [
    { f: 940, Q: 26, g: 1, d: 55 },
    { f: 1880, Q: 20, g: 0.35, d: 30 },
  ], dest, T0);
}

// ================================================================ THE RECIPE REGISTRY
//
// phase 0 = rendered during init() and awaited (the sounds a player can trigger in the
// first two seconds). phase 1 = rendered in the background across frames, and lazily on
// first use if something asks early.
//
// peakDb is a *calibration* target, not a mix decision: the rendered buffer's peak is
// normalized to it so that the §1.3 loudness table is literally true of the asset.

const BREATH_STATES = {
  calm: { inDur: 1.10, fIn: [420, 680], fEx: [640, 380], Q: 1.1 },
  walk: { inDur: 0.90, fIn: [480, 820], fEx: [780, 420], Q: 1.3 },
  heavy: { inDur: 0.60, fIn: [560, 1150], fEx: [1080, 480], Q: 1.8, voiced: true },
  fear: { inDur: 0.50, fIn: [700, 1350], fEx: [1200, 560], Q: 2.4 },
};

function breathRecipes(out) {
  for (const [state, s] of Object.entries(BREATH_STATES)) {
    const core = state === 'calm';
    out[`breath.${state}.in`] = {
      dur: s.inDur + 0.15, v: 3, family: 'breath', priority: 3, peakDb: -12, half: true,
      phase: core ? 0 : 1,
      build: (R, d) => buildBreath(R, d, { dur: s.inDur, f0: s.fIn[0], f1: s.fIn[1], Q: s.Q }),
    };
    const exDur = s.inDur * 1.4;
    out[`breath.${state}.out`] = {
      dur: exDur + 0.15, v: 3, family: 'breath', priority: 3, peakDb: -14, half: true,
      phase: core ? 0 : 1,
      build: (R, d) => buildBreath(R, d, {
        dur: exDur, f0: s.fEx[0], f1: s.fEx[1], Q: s.Q, exhale: true, voiced: s.voiced,
      }),
    };
  }
  return out;
}

function creakRecipes(out) {
  for (let tier = 1; tier <= 4; tier++) {
    for (let si = 0; si < CREAK_SIZES.length; si++) {
      out[`creak.t${tier}.s${si}`] = {
        dur: CREAK_DURATIONS[tier - 1] + 0.25,
        v: tier === 4 ? 2 : 3,
        family: 'creak',
        priority: tier >= 2 ? 3 : 2,
        peakDb: [-30, -20, -12, -8][tier - 1],
        // The medium member is the one the player hears most, so it is the one we pre-warm.
        phase: si === 1 && tier >= 2 && tier <= 3 ? 0 : 1,
        build: (R, d) => buildCreak(R, d, { tier, size: CREAK_SIZES[si] }),
      };
    }
  }
  return out;
}

/** @type {Record<string, object>} */
export const RECIPES = creakRecipes(breathRecipes({
  // ---- footsteps. The surface intensity multipliers from §4.1 are baked into peakDb so
  // that gravel really is the loudest floor in the game and mud really is the safest.
  'step.pine': { dur: 0.32, v: 6, family: 'footstep', priority: 3, peakDb: -24, phase: 0, build: buildStepPine },
  'step.mud': { dur: 0.32, v: 5, family: 'footstep', priority: 3, peakDb: -28.4, phase: 0, build: buildStepMud },
  'step.grass': { dur: 0.32, v: 5, family: 'footstep', priority: 3, peakDb: -24, phase: 0, build: buildStepGrass },
  'step.gravel': { dur: 0.36, v: 6, family: 'footstep', priority: 3, peakDb: -19.4, phase: 0, build: buildStepGravel },
  'step.wood': { dur: 0.42, v: 5, family: 'footstep', priority: 3, peakDb: -22, phase: 0, build: buildStepWood },
  'step.wood.hollow': {
    dur: 0.6, v: 4, family: 'footstep', priority: 3, peakDb: -21, phase: 1,
    build: (R, d) => buildStepWood(R, d, { hollow: true }),
  },
  'step.tin': { dur: 1.2, v: 5, family: 'footstep', priority: 3, peakDb: -16.4, phase: 1, build: buildStepTin },

  // ---- lumber
  'lumber.hoist': { dur: 1.1, v: 3, family: 'build', priority: 2, peakDb: -20, phase: 1, build: buildLumberHoist },
  'lumber.drag': {
    dur: 3.2, v: 2, family: 'build', priority: 2, peakDb: -20, phase: 1, loop: true, xfade: 0.4,
    build: buildLumberDrag,
  },
  'lumber.drop': { dur: 0.85, v: 4, family: 'build', priority: 2, peakDb: -9, phase: 1, build: buildLumberDrop },
  'lumber.knock': { dur: 0.4, v: 5, family: 'build', priority: 2, peakDb: -16, phase: 1, build: buildLumberKnock },

  // ---- tools
  'hammer.wood': {
    dur: 0.42, v: 4, family: 'hammer', priority: 2, peakDb: -13, phase: 1,
    // Variant index doubles as the strike index: the nail's pitch rises 4% per strike.
    build: (R, d, p) => buildHammerWood(R, d, p), params: (i) => ({ strike: i }),
  },
  'hammer.steel': { dur: 2.1, v: 3, family: 'hammer', priority: 2, peakDb: -7, phase: 1, build: buildHammerSteel },
  'bracket.drop.rock': { dur: 1.3, v: 3, family: 'build', priority: 2, peakDb: -18, phase: 1, build: buildBracketDropRock },
  'screw.torque': { dur: 2.4, v: 3, family: 'build', priority: 2, peakDb: -20, phase: 1, build: buildScrewTorque },
  'screw.seat': { dur: 0.3, v: 3, family: 'build', priority: 3, peakDb: -16, phase: 1, build: buildScrewSeat },
  'screw.strip': { dur: 0.6, v: 2, family: 'build', priority: 2, peakDb: -18, phase: 1, build: buildScrewStrip },
  'wood.split': { dur: 1.3, v: 3, family: 'build', priority: 3, peakDb: -5, phase: 1, build: buildWoodSplit },
  'nail.pull': { dur: 0.75, v: 3, family: 'build', priority: 2, peakDb: -14, phase: 1, build: buildNailPull },
  'canvas.flap': { dur: 1.6, v: 4, family: 'world', priority: 1, peakDb: -22, phase: 1, build: buildCanvasFlap },
  'twig.snap': { dur: 0.3, v: 6, family: 'world', priority: 2, peakDb: -22, phase: 0, build: buildTwigSnap },
  'branch.snap': {
    dur: 0.45, v: 4, family: 'world', priority: 2, peakDb: -14, phase: 1,
    build: (R, d) => buildTwigSnap(R, d, { r: R.rand.range(0.62, 0.84) }),
  },

  // ---- weather (loops are seam-crossfaded; AudioEngine rides their gain from weather:change)
  'rain.leaves': { dur: 4.6, ch: 2, half: true, v: 1, family: 'ambience', priority: 0, peakDb: -6, phase: 1, loop: true, build: buildRainLeaves },
  'rain.tin': { dur: 4.6, ch: 2, half: true, v: 1, family: 'ambience', priority: 0, peakDb: -6, phase: 1, loop: true, build: buildRainTin },
  'rain.water': { dur: 5.2, ch: 2, half: true, v: 1, family: 'ambience', priority: 0, peakDb: -8, phase: 1, loop: true, build: buildRainWater },
  'wind.pines': { dur: 8.4, ch: 2, half: true, v: 2, family: 'ambience', priority: 0, peakDb: -6, phase: 1, loop: true, xfade: 0.6, build: buildWindPines },
  'wind.gust': { dur: 5.5, ch: 2, half: true, v: 2, family: 'ambience', priority: 1, peakDb: -10, phase: 1, build: buildWindGust },
  'wind.whistle': { dur: 3.0, v: 2, family: 'ambience', priority: 1, peakDb: -18, phase: 1, build: buildWindWhistle },
  'thunder.near': { dur: 3.0, half: true, v: 2, family: 'thunder', priority: 3, peakDb: -8, phase: 1, build: (R, d) => buildThunder(R, d, { cls: 'near' }) },
  'thunder.mid': { dur: 5.6, half: true, v: 3, family: 'thunder', priority: 3, peakDb: -14, phase: 1, build: (R, d) => buildThunder(R, d, { cls: 'mid', distance: R.rand.range(500, 1900) }) },
  'thunder.far': { dur: 8.0, half: true, v: 2, family: 'thunder', priority: 3, peakDb: -26, phase: 1, build: (R, d) => buildThunder(R, d, { cls: 'far' }) },

  // ---- camp life
  'campfire': { dur: 6.2, ch: 2, half: true, v: 2, family: 'ambience', priority: 1, peakDb: -10, phase: 1, loop: true, build: buildCampfire },
  'campfire.pop': { dur: 0.4, v: 4, family: 'ambience', priority: 1, peakDb: -18, phase: 1, build: buildCampfirePop },
  'water.lap': { dur: 5.6, ch: 2, half: true, v: 1, family: 'ambience', priority: 0, peakDb: -12, phase: 1, loop: true, build: buildWaterLap },
  'zipper': { dur: 1.1, v: 3, family: 'camper', priority: 2, peakDb: -16, phase: 1, build: buildZipper },
  'click.flashlight.on': { dur: 0.3, v: 3, family: 'camper', priority: 2, peakDb: -14, phase: 1, build: (R, d) => buildClick(R, d, {}) },
  'click.flashlight.off': { dur: 0.3, v: 3, family: 'camper', priority: 2, peakDb: -16, phase: 1, build: (R, d) => buildClick(R, d, { off: true }) },
  'click.shutter': { dur: 0.25, v: 3, family: 'camper', priority: 2, peakDb: -14, phase: 1, build: buildShutterClick },
  'glass.ping': { dur: 0.32, v: 4, family: 'lantern', priority: 0, peakDb: -24, phase: 1, build: buildGlassPing },
  'lantern.squeak': {
    dur: 0.28, v: 4, family: 'lantern', priority: 1, peakDb: -26, phase: 1,
    build: (R, d) => frictionOsc(R, d, {
      t0: T0, dur: R.rand.range(0.09, 0.18), slipRate: 30, fStart: 1750 * R.rand.range(0.9, 1.15),
      pitchDropCents: 140, qStart: 90, level: 0.5, partnerDb: -14, bedDb: -60,
      bodyF: 0, irregular: 0.5, drive: 1.2,
    }),
  },
  'lantern.hiss': { dur: 4.2, v: 1, family: 'lantern', priority: 1, peakDb: -6, phase: 1, loop: true, build: buildLanternHiss },
  'cricket.chirp': { dur: 0.22, v: 6, family: 'cricket', priority: 0, peakDb: -12, phase: 1, build: buildCricketChirp },
  'cricket.wash': { dur: 4.2, ch: 2, half: true, v: 1, family: 'cricket', priority: 0, peakDb: -14, phase: 1, loop: true, build: buildCricketWash },
  'loon.wail': { dur: 2.0, v: 2, family: 'wildlife', priority: 1, peakDb: -10, phase: 1, build: buildLoonWail },
  'loon.tremolo': { dur: 2.0, v: 1, family: 'wildlife', priority: 1, peakDb: -8, phase: 1, build: (R, d) => buildLoonWail(R, d, { tremolo: true }) },
  'owl.hoot': { dur: 1.9, v: 2, family: 'wildlife', priority: 1, peakDb: -12, phase: 1, build: buildOwlHoot },
  'dawn.bird': { dur: 0.9, v: 2, family: 'wildlife', priority: 1, peakDb: -14, phase: 1, build: buildDawnBird },

  // ---- the body
  'heart.thump': { dur: 0.2, v: 2, family: 'body', priority: 3, peakDb: -6, half: true, phase: 0, build: buildHeartThump },

  // ---- the manual. Never varied, never reverbed, never masked.
  'ui.chime': { dur: 0.6, v: 1, family: 'ui', priority: 3, peakDb: -16, phase: 0, build: buildUiChime },
  'ui.click': { dur: 0.12, v: 2, family: 'ui', priority: 3, peakDb: -20, phase: 0, build: buildUiClick },
  'ui.page': { dur: 0.35, v: 3, family: 'ui', priority: 3, peakDb: -20, phase: 1, build: buildUiPage },
  'ui.stamp': { dur: 0.3, v: 2, family: 'ui', priority: 3, peakDb: -18, phase: 1, build: buildUiStamp },
  'ui.deny': { dur: 0.2, v: 2, family: 'ui', priority: 3, peakDb: -20, phase: 1, build: buildUiDeny },
}));

/** Aliases so a caller using a reasonable-but-different id still gets a sound. */
export const ALIASES = {
  'step.needles': 'step.pine', 'step.dirt': 'step.mud', 'step.wet': 'step.grass',
  'step.stone': 'step.gravel', 'step.plank': 'step.wood', 'step.deck': 'step.wood',
  'step.metal': 'step.tin', 'step.default': 'step.pine',
  'footstep.pine': 'step.pine',
  'hammer': 'hammer.wood', 'hammer.nail': 'hammer.wood',
  'bracket.drop': 'bracket.drop.rock', 'metal.drop': 'bracket.drop.rock',
  'screw': 'screw.torque', 'seat': 'screw.seat',
  'flashlight.on': 'click.flashlight.on', 'flashlight.off': 'click.flashlight.off',
  'lantern.on': 'click.flashlight.on', 'lantern.off': 'click.flashlight.off',
  'thunder': 'thunder.mid', 'rain': 'rain.leaves', 'wind': 'wind.pines',
  'twig': 'twig.snap', 'branch': 'branch.snap',
  'ui.confirm': 'ui.chime', 'ui.error': 'ui.deny', 'ui.turn': 'ui.page',
  'build.complete': 'ui.chime', 'tool.missing': 'ui.deny',
};

export function resolveId(id) {
  if (RECIPES[id]) return id;
  const a = ALIASES[id];
  return a && RECIPES[a] ? a : null;
}

/** Family → the mix/priority hints AudioEngine uses for pooling and stealing (§9.1). */
export function recipeInfo(id) {
  const r = resolveId(id);
  return r ? RECIPES[r] : null;
}

// ================================================================ §3.3 REVERB SPACES

const SPACE_SPECS = {
  OPEN_FOREST: { rt: [0.90, 0.55, 0.22], taps: 6, tapMs: [11, 48], tapDb: -9, len: 1.5 },
  DENSE_TREES: { rt: [1.35, 0.95, 0.30], taps: 22, tapMs: [6, 70], tapDb: -5, len: 1.9, scatter: true },
  CABIN_SHELL: { rt: [0.55, 0.62, 0.40], taps: 9, tapMs: [3, 26], tapDb: -2, len: 1.2, modes: [118, 187] },
  LAKE_EDGE: { rt: [2.40, 2.10, 1.10], taps: 3, tapMs: [9, 40], tapDb: -8, len: 2.9, slap: { ms: 240, db: -11 } },
  TIN_ROOF: { rt: [0.40, 0.55, 0.75], taps: 14, tapMs: [1, 18], tapDb: -4, len: 1.2, comb: { ms: 3.1, fb: 0.5 } },
};

export const SPACES = Object.keys(SPACE_SPECS);

/**
 * Generate a reverb impulse response procedurally: noise → four band-limited exponential
 * decays with independent RT60s → early reflection taps → space-specific colour.
 * Budget: all five under ~120 ms total. Generated at 24 kHz below `high`.
 */
export async function renderImpulseResponse(space, sampleRate, { tierIndex = 3 } = {}) {
  const spec = SPACE_SPECS[space] ?? SPACE_SPECS.OPEN_FOREST;
  if (!OfflineCtor) return null;
  const sr = tierIndex >= 2 ? sampleRate : Math.max(12000, Math.round(sampleRate / 2));
  let len = spec.len;
  if (space === 'LAKE_EDGE' && tierIndex < 2) len = 1.6;

  const ctx = new OfflineCtor(2, Math.ceil(len * sr), sr);
  const R = { ctx, rand: new Rand(`ir:${space}`), sr, tier: tierIndex };
  const dest = ctx.destination;

  // Four bands crossed at 250 / 1200 / 5000 Hz, each with its own RT60.
  const rt = [spec.rt[0], spec.rt[1], (spec.rt[1] + spec.rt[2]) * 0.5, spec.rt[2]];
  const bands = [
    { make: () => biquad(R, 'lowpass', 250, 0.7) },
    { make: () => { const a = biquad(R, 'highpass', 250, 0.7); const b = biquad(R, 'lowpass', 1200, 0.7); a.connect(b); return { i: a, o: b }; } },
    { make: () => { const a = biquad(R, 'highpass', 1200, 0.7); const b = biquad(R, 'lowpass', 5000, 0.7); a.connect(b); return { i: a, o: b }; } },
    { make: () => biquad(R, 'highpass', 5000, 0.7) },
  ];
  for (let i = 0; i < 4; i++) {
    const made = bands[i].make();
    const input = made.i ?? made;
    const output = made.o ?? made;
    const g = gain(R, 0);
    const src = noiseSrc(R, 'white', 0, len, { rate: 1 + i * 0.013 });
    src.connect(input);
    output.connect(g);
    g.connect(dest);
    const d = Math.min(len, Math.max(0.05, rt[i]));
    g.gain.setValueAtTime(1, 0);
    g.gain.exponentialRampToValueAtTime(1e-3, d);
    g.gain.exponentialRampToValueAtTime(MIN_GAIN, Math.min(len, d * 1.3));
  }

  // Early reflections.
  for (let i = 0; i < spec.taps; i++) {
    const t = (spec.tapMs[0] + (spec.tapMs[1] - spec.tapMs[0]) * R.rand.next()) / 1000;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const g = gain(R, dbToGain(spec.tapDb) * R.rand.range(0.4, 1));
    const b = burst(R, t, 0.0015, 1, 'white');
    b.connect(g);
    if (pan) { pan.pan.value = spec.scatter ? R.rand.range(-1, 1) : R.rand.range(-0.6, 0.6); g.connect(pan); pan.connect(dest); }
    else g.connect(dest);
  }

  // The half-built frame *rings*: two resonant modes baked into the cabin's IR.
  if (spec.modes) {
    for (const f of spec.modes) {
      modal(R, burst(R, 0.002, 0.003, 1, 'white'), [{ f, Q: 9, g: 0.5, d: 700 }], dest, 0.002);
    }
  }

  // Water reflects specularly — this discrete slap is why you can hear the camp from
  // across the lake.
  if (spec.slap) {
    const t = spec.slap.ms / 1000;
    const g = gain(R, dbToGain(spec.slap.db));
    const b = burst(R, t, 0.006, 1, 'white');
    const lp = biquad(R, 'lowpass', 4200, 0.7);
    b.connect(lp); lp.connect(g);
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = -0.9; g.connect(p); p.connect(dest); }
    else g.connect(dest);
  }

  // Tin rings *longer* at the top, and combs.
  if (spec.comb) {
    const d = ctx.createDelay(0.05);
    d.delayTime.value = spec.comb.ms / 1000;
    const fb = gain(R, spec.comb.fb);
    const hp = biquad(R, 'highpass', 900, 0.7);
    d.connect(fb); fb.connect(hp); hp.connect(d);
    const tapIn = burst(R, 0.001, 0.004, 0.6, 'white');
    tapIn.connect(d);
    d.connect(dest);
  }

  let buf;
  try { buf = await ctx.startRendering(); }
  catch (e) { Log.warn(`IR '${space}' failed to render:`, e?.message ?? e); return null; }

  // Fade the head in a hair and normalize to a sane RMS so swapping spaces never jumps.
  const fade = Math.floor(0.002 * sr);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < fade && i < d.length; i++) d[i] *= i / fade;
  }
  const rms = bufferRms(buf);
  if (rms > 1e-6) scaleBuffer(buf, clamp(0.055 / rms, 0.05, 40));
  const peak = bufferPeak(buf);
  if (peak > 0.98) scaleBuffer(buf, 0.98 / peak);
  return buf;
}

// ================================================================ THE BANK

/**
 * Yield to the frame between renders. Raced against a timer on purpose: rAF never fires in
 * a background tab, and a bank that stops rendering because the player alt-tabbed is a bank
 * that is missing sounds when they come back.
 */
const yieldToFrame = () => new Promise((resolve) => {
  let done = false;
  const fire = () => { if (!done) { done = true; resolve(); } };
  setTimeout(fire, 24);
  if (typeof globalThis.requestIdleCallback === 'function') globalThis.requestIdleCallback(fire, { timeout: 60 });
  else if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(fire);
});

function variantCount(rec, tierIndex) {
  const n = rec.v ?? 3;
  if (n <= 1) return 1;
  const scale = tierIndex <= 0 ? 0.5 : tierIndex === 1 ? 0.7 : 1;
  return Math.max(1, Math.min(n, Math.round(n * scale)));
}

/**
 * The cached SFX bank. Owns every rendered AudioBuffer in the game.
 *
 *   const bank = new SFXBank(audioCtx, { settings });
 *   await bank.renderPhase(0);      // the sounds needed in the first second — awaited
 *   bank.renderPhase(1);            // everything else, chunked across frames
 *   bank.get('step.pine');          // → a random variant, or null if not rendered yet
 */
export class SFXBank {
  /**
   * @param {BaseAudioContext|null} audioContext
   * @param {{ rand?: any, settings?: any, sampleRate?: number, tierIndex?: number }} [opts]
   */
  constructor(audioContext, { rand = null, settings = null, sampleRate = null, tierIndex = null } = {}) {
    this.available = !!OfflineCtor;
    this.sampleRate = sampleRate ?? audioContext?.sampleRate ?? 48000;
    this.tierIndex = tierIndex ?? settings?.tierIndex ?? 3;
    this.rand = rand ?? new Rand('sfxbank');
    /** @type {Map<string, AudioBuffer[]>} */
    this._buffers = new Map();
    /** @type {Map<string, Promise<AudioBuffer[]>>} */
    this._pending = new Map();
    this._missing = new Set();
    this._failed = new Set();
    this._disposed = false;
    this._grainMax = [200, 350, 550, 800][clamp(this.tierIndex, 0, 3)];
    this.stats = { rendered: 0, buffers: 0, ms: 0 };
  }

  /** True once a given id has at least one variant available. */
  has(id) {
    const r = resolveId(id);
    return !!(r && this._buffers.has(r));
  }

  /** A random variant of `id`, or null if it has not been rendered yet (kicks off a render). */
  get(id, rand = null) {
    const r = resolveId(id);
    if (!r) {
      if (!this._missing.has(id)) { this._missing.add(id); Log.once(`sfx:${id}`, `Unknown sfx id '${id}' — ignored.`); }
      return null;
    }
    const list = this._buffers.get(r);
    if (!list || !list.length) { this.ensure(r); return null; }
    const n = list.length;
    if (n === 1) return list[0];
    const u = (rand ?? this.rand).next();
    return list[Math.min(n - 1, Math.floor(u * n))];
  }

  /** A specific variant (wraps). Used for the hammer's rising nail pitch. */
  variant(id, index) {
    const r = resolveId(id);
    if (!r) return null;
    const list = this._buffers.get(r);
    if (!list || !list.length) { this.ensure(r); return null; }
    return list[((index | 0) % list.length + list.length) % list.length];
  }

  /** How many variants exist for an id (0 if not rendered). */
  count(id) {
    const r = resolveId(id);
    return r ? (this._buffers.get(r)?.length ?? 0) : 0;
  }

  /**
   * THE CREAK. `severity` 0..1 (quantized to four categorical tiers by BuildSystem),
   * `size` = the length in metres of the member that is complaining, which sets the body
   * resonance. Falls back to the medium-size variant while a size bucket is still rendering.
   */
  creak(severity, size = 2.4, rand = null) {
    const id = creakId(severity, size);
    const buf = this.get(id, rand);
    if (buf) return buf;
    const fallback = `creak.t${creakTier(severity)}.s1`;
    return fallback === id ? null : this.get(fallback, rand);
  }

  /** A shared noise bed at the live context's rate — for AudioEngine's realtime layers. */
  noise(type = 'pink', seconds = 4) {
    return noiseBuffer(type, this.sampleRate, seconds);
  }

  /**
   * Render one id now (idempotent). `want` caps how many variants are needed right now —
   * boot asks for one of everything it might need immediately and the background pass tops
   * each id up to its full variant count.
   */
  ensure(id, want = 0) {
    const r = resolveId(id);
    if (!r || this._disposed || !this.available) return Promise.resolve([]);
    const have = this._buffers.get(r) ?? null;
    if (this._failed.has(r)) return Promise.resolve(have ?? []);
    const full = variantCount(RECIPES[r], this.tierIndex);
    const target = want > 0 ? Math.min(want, full) : full;
    if (have && have.length >= target) return Promise.resolve(have);
    const pend = this._pending.get(r);
    // A render is already in flight for fewer variants than we now need: queue behind it.
    if (pend) return pend.then(() => this.ensure(r, want));
    const p = this._renderId(r, target).finally(() => this._pending.delete(r));
    this._pending.set(r, p);
    return p;
  }

  async _renderId(id, target) {
    const rec = RECIPES[id];
    if (!rec) return [];
    const out = this._buffers.get(id) ?? [];
    const from = out.length;
    for (let i = from; i < target; i++) {
      if (this._disposed) break;
      const buf = await this._renderVariant(id, rec, i);
      if (!buf) break;
      out.push(buf);
      this.stats.buffers++;
    }
    if (out.length > from && !this._disposed) this._buffers.set(id, out);
    else if (out.length === 0) this._failed.add(id);
    return out;
  }

  async _renderVariant(id, rec, index) {
    const t0 = performance.now();
    const baseSr = this.sampleRate;
    const sr = rec.half ? Math.max(11025, Math.round(baseSr / 2)) : baseSr;
    const channels = rec.ch ?? 1;
    const frames = Math.max(64, Math.ceil((rec.dur + 0.05) * sr));
    let ctx;
    try {
      ctx = new OfflineCtor(channels, frames, sr);
    } catch (e) {
      Log.once('sfx:offline', 'OfflineAudioContext unavailable — SFX bank disabled.', e?.message ?? e);
      this.available = false;
      return null;
    }
    const R = {
      ctx,
      rand: new Rand(`${id}:${index}`),
      sr,
      tier: this.tierIndex,
      tierMax: this._grainMax,
    };
    try {
      rec.build(R, ctx.destination, rec.params ? rec.params(index, R) : {});
    } catch (e) {
      Log.warn(`SFX '${id}' variant ${index} failed to build:`, e?.message ?? e);
      return null;
    }
    let buf;
    try {
      buf = await ctx.startRendering();
    } catch (e) {
      Log.warn(`SFX '${id}' variant ${index} failed to render:`, e?.message ?? e);
      return null;
    }
    if (rec.loop) buf = makeSeamless(buf, rec.xfade ?? 0.35);
    if (rec.norm !== 'none') {
      const jr = new Rand(`${id}:${index}:lvl`);
      // A whisper of level variation between variants so a repeated sound never lands
      // twice at exactly the same loudness.
      const jitter = rec.v > 1 ? jr.range(-1.5, 0.4) : 0;
      normalizeBufferTo(buf, dbToGain((rec.peakDb ?? -12) + jitter));
    }
    this.stats.rendered++;
    this.stats.ms += performance.now() - t0;
    return buf;
  }

  /**
   * Render every recipe in a phase, yielding to the frame whenever the wall-clock budget is
   * exceeded so boot never stalls. phase 0 is awaited by AudioEngine.init(); phase 1 runs
   * in the background.
   */
  async renderPhase(phase = 0, { budgetMs = 6, onProgress = null, variants = 0 } = {}) {
    if (!this.available || this._disposed) return this;
    // Phase 0 only needs *one* of each urgent sound to exist; phase 1 sweeps every id and
    // tops it up to its full variant count, so repetition stops being audible a few
    // seconds in rather than delaying the first frame.
    const ids = phase === 0
      ? Object.keys(RECIPES).filter((id) => (RECIPES[id].phase ?? 1) === 0)
      : Object.keys(RECIPES);
    let chunkStart = performance.now();
    for (let i = 0; i < ids.length; i++) {
      if (this._disposed) break;
      await this.ensure(ids[i], variants);
      onProgress?.((i + 1) / ids.length, ids[i]);
      // A hidden tab has no frame to protect and throttles timers hard, so run straight
      // through: the bank should be complete by the time the player comes back.
      if (performance.now() - chunkStart > budgetMs && globalThis.document?.hidden !== true) {
        await yieldToFrame();
        chunkStart = performance.now();
      }
    }
    return this;
  }

  /** Everything, in phase order. */
  async renderAll(opts = {}) {
    await this.renderPhase(0, { ...opts, variants: 1 });
    await this.renderPhase(1, opts);
    Log.debug(`SFX bank: ${this.stats.buffers} buffers in ${this.stats.ms.toFixed(0)} ms`);
    return this;
  }

  dispose() {
    this._disposed = true;
    this._buffers.clear();
    this._pending.clear();
    this._missing.clear();
    this._failed.clear();
  }
}

/**
 * Convenience: build and fully prime a bank. `AudioEngine` uses the two-phase form instead
 * so that boot is not blocked on the long ambience loops.
 * @param {BaseAudioContext} audioContext
 */
export async function renderAll(audioContext, opts = {}) {
  const bank = new SFXBank(audioContext, opts);
  await bank.renderAll(opts);
  return bank;
}

/**
 * One-off creak render outside the bank (for tools, tests, or a bespoke member size).
 * Resolves to an AudioBuffer.
 */
export async function creak(severity, size = 2.4, { sampleRate = 48000, seed = 'creak' } = {}) {
  if (!OfflineCtor) return null;
  const tier = creakTier(severity);
  const dur = CREAK_DURATIONS[tier - 1] + 0.25;
  const ctx = new OfflineCtor(1, Math.ceil(dur * sampleRate), sampleRate);
  const R = { ctx, rand: new Rand(`${seed}:${tier}:${size}`), sr: sampleRate, tier: 3 };
  buildCreak(R, ctx.destination, { tier, size });
  const buf = await ctx.startRendering();
  return normalizeBufferTo(buf, dbToGain([-30, -20, -12, -8][tier - 1]));
}

export default SFXBank;
