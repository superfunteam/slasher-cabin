/**
 * Synchronous event bus. The spine of inter-system communication.
 * Owned by: Engine agent. See ARCHITECTURE.md §5 for the canonical event list.
 */
import { Log } from './Log.js';

export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._map = new Map();
    this._depth = 0;
    // Emissions that happen *during* an emit are queued so handlers can't recurse infinitely.
    this._queue = [];
    this._muted = new Set();
  }

  /** @returns {() => void} unsubscribe */
  on(event, fn) {
    if (typeof fn !== 'function') {
      Log.warn(`bus.on('${event}') called with a non-function`);
      return () => {};
    }
    let set = this._map.get(event);
    if (!set) { set = new Set(); this._map.set(event, set); }
    set.add(fn);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const wrapped = (payload) => { this.off(event, wrapped); fn(payload); };
    return this.on(event, wrapped);
  }

  off(event, fn) {
    const set = this._map.get(event);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) this._map.delete(event);
  }

  /** Temporarily suppress an event (used when replaying a save). */
  mute(event) { this._muted.add(event); }
  unmute(event) { this._muted.delete(event); }

  emit(event, payload) {
    if (this._muted.has(event)) return;

    // Re-entrancy guard: queue instead of recursing.
    if (this._depth > 0) {
      if (this._queue.length > 512) {
        Log.once('bus:flood', `EventBus queue overflow while emitting '${event}' — dropping.`);
        return;
      }
      this._queue.push([event, payload]);
      return;
    }

    this._depth++;
    try {
      this._dispatch(event, payload);
      // Drain anything queued by handlers.
      let guard = 0;
      while (this._queue.length) {
        if (++guard > 1024) {
          Log.once('bus:drain', 'EventBus drain exceeded 1024 iterations — breaking.');
          this._queue.length = 0;
          break;
        }
        const [e, p] = this._queue.shift();
        this._dispatch(e, p);
      }
    } finally {
      this._depth--;
    }
  }

  _dispatch(event, payload) {
    const set = this._map.get(event);
    if (!set || set.size === 0) return;
    // Copy so handlers may unsubscribe during dispatch.
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (e) {
        Log.once(`bus:${event}:${fn.name}`, `Handler for '${event}' threw:`, e);
      }
    }
  }

  listenerCount(event) { return this._map.get(event)?.size ?? 0; }

  clear() { this._map.clear(); this._queue.length = 0; this._muted.clear(); }
}

export default EventBus;
