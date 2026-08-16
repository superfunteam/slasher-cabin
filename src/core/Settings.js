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
  quality: 'ultra',
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
    this.load();
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
      if (!raw) return;
      const parsed = JSON.parse(raw);
      // Only accept keys we know about — guards against stale/hostile storage.
      for (const k of Object.keys(DEFAULTS)) {
        if (k in parsed && typeof parsed[k] === typeof DEFAULTS[k]) {
          this._values[k] = parsed[k];
        }
      }
    } catch (e) {
      Log.warn('Settings.load failed, using defaults:', e);
    }
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
