/**
 * Tiny leveled logger. Silent in production unless ?debug is in the URL.
 * Owned by: Engine agent.
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

let level = LEVELS.warn;
try {
  const p = new URLSearchParams(globalThis.location?.search ?? '');
  if (p.has('debug')) level = LEVELS[p.get('debug') || 'debug'] ?? LEVELS.debug;
} catch { /* non-browser */ }

const stamp = () => `%c[${(performance.now() / 1000).toFixed(2)}s]`;
const CSS = 'color:#6b7a8f';

export const Log = {
  get level() { return level; },
  setLevel(name) { level = LEVELS[name] ?? level; },

  debug(...a) { if (level >= LEVELS.debug) console.log(stamp(), CSS, ...a); },
  info(...a) { if (level >= LEVELS.info) console.info(stamp(), CSS, ...a); },
  warn(...a) { if (level >= LEVELS.warn) console.warn(stamp(), CSS, ...a); },
  error(...a) { if (level >= LEVELS.error) console.error(stamp(), CSS, ...a); },

  /** Log once per unique key — for per-frame code paths. */
  once(key, ...a) {
    if (seen.has(key)) return;
    seen.add(key);
    Log.warn(...a);
  },

  /** Wrap a fn so a throw is logged but does not kill the frame loop. */
  guard(name, fn) {
    return (...args) => {
      try { return fn(...args); }
      catch (e) { Log.once(`guard:${name}`, `[${name}] threw:`, e); }
    };
  },
};

const seen = new Set();

export default Log;
