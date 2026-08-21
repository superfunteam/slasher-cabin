/**
 * Persisted user settings + quality tiers.
 * Owned by: Engine agent. See ARCHITECTURE.md §7.
 */
import { Log } from './Log.js';
import { DEFAULT_SEED } from './Rand.js';

const STORAGE_KEY = 'slashercabin.settings';

export const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra'];

export const DEFAULTS = {
  seed: DEFAULT_SEED,
  // Only a fallback: the constructor replaces this with Settings.detectQuality() on a first
  // visit. It was 'ultra', which allocated ~724 MB before the first frame and crashed a
  // reporter's browser during load. 'high' is the safe floor if detection cannot run.
  quality: 'high',
  dprCap: 2.0,

  fov: 72,
  mouseSensitivity: 1.0,
  invertY: false,

  masterVolume: 0.9,
  sfxVolume: 1.0,
  musicVolume: 0.7,
  voiceVolume: 0.85,

  subtitles: true,
  motionBlur: true,
  filmGrain: true,
  chromaticAberration: true,
  vignette: true,
  headBob: true,

  difficulty: 'standard',   // 'story' | 'standard' | 'nightmare'
  puzzleHints: false,
  colorblind: 'none',       // 'none' | 'protan' | 'deutan' | 'tritan'
  reducedMotion: false,
};

export class Settings {
  /** @param {import('./EventBus.js').EventBus} bus */
  constructor(bus) {
    this.bus = bus;
    this._values = { ...DEFAULTS };
    // A returning player's own choice always wins. Only guess for a machine we have never seen —
    // see detectQuality() for why guessing at all is necessary. URL overrides run last, so
    // `?quality=ultra` still pins the tier for the screenshot harness and every visual baseline.
    const hadQuality = this.load();
    if (!hadQuality) this._values.quality = Settings.detectQuality();
    this._applyUrlOverrides();
  }

  get(key) { return this._values[key]; }

  set(key, value) {
    if (this._values[key] === value) return value;
    const prev = this._values[key];
    this._values[key] = value;
    this.save();
    this.bus?.emit('settings:changed', { key, value, prev });
    return value;
  }

  /** Bulk update without N events. */
  patch(obj) {
    let changed = false;
    for (const [k, v] of Object.entries(obj)) {
      if (this._values[k] !== v) { this._values[k] = v; changed = true; }
    }
    if (changed) { this.save(); this.bus?.emit('settings:changed', { key: '*', value: null }); }
  }

  get all() { return { ...this._values }; }

  /**
   * Return the value matching the current quality tier.
   * `settings.tier(512, 1024, 2048, 4096)` → 4096 on ultra.
   */
  tier(low, medium, high, ultra) {
    switch (this._values.quality) {
      case 'low': return low;
      case 'medium': return medium;
      case 'high': return high;
      default: return ultra;
    }
  }

  /** Numeric index of the current tier — handy for `>= 2` style checks. */
  get tierIndex() {
    const i = QUALITY_ORDER.indexOf(this._values.quality);
    return i < 0 ? 3 : i;
  }

  /** Effective device pixel ratio, capped by settings and tier. */
  get effectiveDpr() {
    const cap = Math.min(this._values.dprCap, this.tier(1.0, 1.25, 1.5, 2.0));
    return Math.min(globalThis.devicePixelRatio || 1, cap);
  }

  load() {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      const hadQuality = 'quality' in parsed && QUALITY_ORDER.includes(parsed.quality);
      // Only accept keys we know about — guards against stale/hostile storage.
      for (const k of Object.keys(DEFAULTS)) {
        if (k in parsed && typeof parsed[k] === typeof DEFAULTS[k]) {
          this._values[k] = parsed[k];
        }
      }
      return hadQuality;
    } catch (e) {
      Log.warn('Settings.load failed, using defaults:', e);
      return false;
    }
  }

  /**
   * Pick a starting quality tier for a machine we have never seen.
   *
   * WHY THIS EXISTS. `DEFAULTS.quality` was 'ultra', so every first-time visitor booted at the
   * most expensive tier in the game. Measured, that is:
   *
   *     procedural texture bake   455 MB   (23 materials x 3 MRT attachments, hero at 2048^2)
   *     framebuffer chain         269 MB   (3840x2160 because dprCap 2.0 on a 4K monitor)
   *     ------------------------------------------------------------------
   *     ~724 MB of GPU memory allocated BEFORE THE FIRST FRAME IS DRAWN
   *
   * A reporter's browser died during load on a fast gaming PC and merely crawled on a Mac — the
   * gaming PC was WORSE precisely because its monitor is bigger, so the framebuffers were bigger.
   * The download is 22 MB and was never the problem.
   *
   * The same table one tier down (`high`) is 114 MB + 151 MB, i.e. 2.7x less, and two tiers down
   * (`medium`) is 28 MB. So the cost of guessing low is a softer image; the cost of guessing high
   * is a tab that never opens. This guesses low on purpose, and NEVER auto-selects ultra — ultra
   * remains reachable from the settings menu and from `?quality=ultra`, which is what the
   * screenshot harness and every visual baseline use.
   *
   * The signals are weak and deliberately treated as such: `deviceMemory` is Chromium-only and
   * bucketed, `hardwareConcurrency` says nothing about the GPU, and neither is available in
   * Safari. When we know nothing we choose 'high', not 'ultra'.
   */
  static detectQuality() {
    const nav = globalThis.navigator ?? {};
    const step = (q, by) => QUALITY_ORDER[Math.max(0, Math.min(QUALITY_ORDER.length - 1,
      QUALITY_ORDER.indexOf(q) + by))];

    let q = 'high';
    const reasons = [];

    // Bucketed to 0.25/0.5/1/2/4/8 and capped at 8 by the spec, so treat it as a floor, not a
    // measurement. Absent entirely in Safari and Firefox.
    const mem = Number(nav.deviceMemory);
    if (Number.isFinite(mem) && mem > 0) {
      if (mem <= 2) { q = 'low'; reasons.push(`deviceMemory ${mem}GB`); }
      else if (mem <= 4) { q = 'medium'; reasons.push(`deviceMemory ${mem}GB`); }
    }

    // A weak proxy for "this is a phone or a very old laptop". Says nothing about the GPU.
    const cores = Number(nav.hardwareConcurrency);
    if (Number.isFinite(cores) && cores > 0 && cores <= 4) {
      q = step(q, -1); reasons.push(`${cores} cores`);
    }

    // The one signal that actually predicts our cost, because every post target is sized from it.
    // A 4K panel at dpr 2 is 8.3 Mpx, which is 4x the framebuffer of a 1080p panel at dpr 1.
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const w = globalThis.innerWidth || 1280;
    const h = globalThis.innerHeight || 720;
    const mpx = (w * dpr * h * dpr) / 1e6;
    if (mpx > 5) { q = step(q, -1); reasons.push(`${mpx.toFixed(1)} Mpx framebuffer`); }

    Log.info(`Settings: auto quality '${q}'`
      + (reasons.length ? ` (${reasons.join(', ')})` : ' (no device hints available)')
      + '. Change it in Settings, or force one with ?quality=<low|medium|high|ultra>.');
    return q;
  }

  save() {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this._values));
    } catch { /* private browsing / quota — non-fatal */ }
  }

  reset() {
    this._values = { ...DEFAULTS };
    this.save();
    this.bus?.emit('settings:changed', { key: '*', value: null });
  }

  /**
   * `?quality=low&seed=123&dpr=1` — used by the screenshot harness so the visual
   * critic can pin an exact frame.
   */
  _applyUrlOverrides() {
    try {
      const p = new URLSearchParams(globalThis.location?.search ?? '');
      if (p.has('quality') && QUALITY_ORDER.includes(p.get('quality'))) {
        this._values.quality = p.get('quality');
      }
      if (p.has('seed')) {
        const s = parseInt(p.get('seed'), 10);
        if (Number.isFinite(s)) this._values.seed = s;
      }
      if (p.has('dpr')) {
        const d = parseFloat(p.get('dpr'));
        if (Number.isFinite(d) && d > 0) this._values.dprCap = d;
      }
      if (p.has('fov')) {
        const f = parseFloat(p.get('fov'));
        if (Number.isFinite(f)) this._values.fov = Math.max(50, Math.min(110, f));
      }
      if (p.has('mute')) this.patch({ masterVolume: 0 });
    } catch { /* non-browser */ }
  }
}

export default Settings;
