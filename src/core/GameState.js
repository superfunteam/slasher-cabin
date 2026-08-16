/**
 * The save file. Plain serializable data only — no Three.js objects.
 * Owned by: Engine agent. See ARCHITECTURE.md §8.
 */
import { Log } from './Log.js';

const SAVE_KEY = 'slashercabin.save';
const SAVE_VERSION = 1;

export const PHASES = ['menu', 'briefing', 'build', 'chase', 'night-end', 'gameover'];

export function createInitialState() {
  return {
    version: SAVE_VERSION,
    night: 1,
    phase: 'menu',
    timeOfNight: 0,

    inventory: [],
    installed: {},
    toolsFound: [],

    suspicion: 0,
    spotted: false,
    creaks: 0,

    stats: {
      partsCarried: 0,
      metresWalked: 0,
      campersEvaded: 0,
      perfectJoins: 0,
      creaksTotal: 0,
      nightsPerfect: 0,
    },

    storyFlags: {},
    nightResults: [],   // one Score per completed night
  };
}

export class GameState {
  constructor(bus) {
    this.bus = bus;
    Object.assign(this, createInitialState());
  }

  setPhase(phase) {
    if (!PHASES.includes(phase)) {
      Log.warn(`Unknown phase '${phase}'`);
      return;
    }
    if (this.phase === phase) return;
    const prev = this.phase;
    this.phase = phase;
    this.bus?.emit('state:phase', { phase, prev });
  }

  flag(id, value = true) {
    if (this.storyFlags[id] === value) return;
    this.storyFlags[id] = value;
    this.bus?.emit('story:beat', { id });
  }

  hasFlag(id) { return !!this.storyFlags[id]; }

  /** Clamp helper used by several systems writing to suspicion. */
  addSuspicion(delta) {
    const prev = this.suspicion;
    this.suspicion = Math.max(0, Math.min(1, this.suspicion + delta));
    if (Math.abs(this.suspicion - prev) > 1e-4) {
      this.bus?.emit('state:suspicion', { value: this.suspicion, prev, delta });
    }
    return this.suspicion;
  }

  resetNight() {
    this.timeOfNight = 0;
    this.inventory = [];
    this.installed = {};
    this.toolsFound = [];
    this.suspicion = 0;
    this.spotted = false;
    this.creaks = 0;
  }

  /** Serializable snapshot. */
  toJSON() {
    return {
      version: SAVE_VERSION,
      night: this.night,
      phase: this.phase,
      timeOfNight: this.timeOfNight,
      inventory: this.inventory,
      installed: this.installed,
      toolsFound: this.toolsFound,
      suspicion: this.suspicion,
      creaks: this.creaks,
      stats: this.stats,
      storyFlags: this.storyFlags,
      nightResults: this.nightResults,
    };
  }

  save() {
    try {
      globalThis.localStorage?.setItem(SAVE_KEY, JSON.stringify(this.toJSON()));
      return true;
    } catch (e) {
      Log.warn('Save failed:', e);
      return false;
    }
  }

  load() {
    try {
      const raw = globalThis.localStorage?.getItem(SAVE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (data.version !== SAVE_VERSION) {
        Log.info(`Discarding save v${data.version} (expected v${SAVE_VERSION})`);
        return false;
      }
      Object.assign(this, createInitialState(), data);
      return true;
    } catch (e) {
      Log.warn('Load failed:', e);
      return false;
    }
  }

  static hasSave() {
    try { return !!globalThis.localStorage?.getItem(SAVE_KEY); } catch { return false; }
  }

  clearSave() {
    try { globalThis.localStorage?.removeItem(SAVE_KEY); } catch { /* noop */ }
  }

  reset() {
    Object.assign(this, createInitialState());
    this.bus?.emit('state:reset', {});
  }
}

export default GameState;
