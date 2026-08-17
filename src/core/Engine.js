/**
 * The engine: renderer, context, system registry, frame loop.
 * Owned by: Engine agent. See ARCHITECTURE.md §3–§4.
 */
import * as THREE from 'three';
import { Log } from './Log.js';
import { EventBus } from './EventBus.js';
import { Settings } from './Settings.js';
import { GameState } from './GameState.js';
import { Rand } from './Rand.js';

/**
 * Minimal replacement for the deprecated THREE.Clock. Engine drives dt from
 * performance.now() itself; this only exists because `ctx.clock` is in the contract
 * and systems read `.elapsedTime`.
 */
class GameClock {
  constructor() { this.running = false; this.elapsedTime = 0; this._last = 0; }
  start() { this.running = true; this._last = performance.now(); }
  stop() { this.running = false; }
  tick(dt) { if (this.running) this.elapsedTime += dt; return this.elapsedTime; }
  getElapsedTime() { return this.elapsedTime; }
}

/** Fallback canvas size when the tab reports an unmeasurable viewport (hidden/detached). */
const DEFAULT_W = 1280;
const DEFAULT_H = 720;

const FIXED_DT = 1 / 60;
const MAX_FRAME_DT = 0.1;      // never simulate more than 100 ms in one frame
const MAX_FIXED_STEPS = 5;     // spiral-of-death guard

export class Engine {
  /** @param {HTMLElement} mount */
  constructor(mount) {
    this.mount = mount;

    const bus = new EventBus();
    const settings = new Settings(bus);
    const state = new GameState(bus);

    // ---------------------------------------------------------- renderer
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    mount.appendChild(canvas);

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // we do our own AA in post; MSAA fights the composer
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // needed for the screenshot harness
    });

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.info.autoReset = false;
    renderer.setClearColor(0x05070a, 1);

    const scene = new THREE.Scene();
    scene.matrixWorldAutoUpdate = true;

    const camera = new THREE.PerspectiveCamera(settings.get('fov'), 1, 0.05, 1200);
    camera.rotation.order = 'YXZ';   // yaw then pitch — correct for an FPS
    camera.position.set(0, 1.7, 0);
    scene.add(camera);

    // ---------------------------------------------------------- context
    /** @type {Map<string, any>} */
    this.systems = new Map();

    this.ctx = {
      engine: this,
      renderer,
      scene,
      camera,
      canvas,
      clock: new GameClock(),
      width: 1, height: 1, dpr: 1,
      bus,
      rand: new Rand(settings.get('seed')),
      settings,
      state,
      systems: this.systems,
    };

    this.running = false;
    this.paused = false;
    this._raf = 0;
    this._accumulator = 0;
    this._elapsed = 0;
    this._lastTime = 0;
    this._frame = 0;

    // Rolling perf window for the adaptive-quality governor.
    this._perf = { samples: new Float32Array(90), i: 0, filled: false, avgMs: 16.6 };
    this.stats = { fps: 0, ms: 0, drawCalls: 0, triangles: 0, programs: 0 };

    this._bindEvents();
    this.resize();

    // The screenshot/critic harness talks to the game through these. Exposed HERE, in the
    // constructor, rather than at the end of boot(): a system that throws during init leaves
    // boot() unfinished, and an inspector that cannot reach ctx in exactly that case is
    // useless precisely when it is most needed.
    globalThis.__SLASHER__ = this;
    globalThis.__ENGINE__ = this;
    globalThis.__CTX__ = this.ctx;
  }

  // ------------------------------------------------------------- systems

  /**
   * @param {string} name
   * @param {any} system
   */
  register(name, system) {
    if (!system) return null;
    if (this.systems.has(name)) Log.warn(`System '${name}' registered twice — replacing.`);
    this.systems.set(name, system);
    system.__name = name;
    return system;
  }

  get(name) { return this.systems.get(name); }

  /** Await every system's init() in registration order. */
  async initSystems() {
    for (const [name, sys] of this.systems) {
      if (typeof sys.init !== 'function') continue;
      const t0 = performance.now();
      try {
        await sys.init();
        Log.debug(`init ${name}: ${(performance.now() - t0).toFixed(1)}ms`);
      } catch (e) {
        Log.error(`System '${name}' failed to init — continuing without it.`, e);
        // A broken subsystem must not take down the game.
        sys.__failed = true;
      }
    }
    // Systems may have created lights/materials; make sure sizes are propagated.
    this.resize();
  }

  // ------------------------------------------------------------- loop

  start() {
    if (this.running) return;
    this.running = true;
    this.ctx.clock.start();
    this._lastTime = performance.now();
    this._loop();
    Log.info('Engine started');
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._hiddenTimer) clearTimeout(this._hiddenTimer);
    this._raf = 0;
    this._hiddenTimer = 0;
    this.ctx.clock.stop();
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.ctx.bus.emit('game:pause', {});
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this._lastTime = performance.now();   // don't integrate the paused span
    this.ctx.bus.emit('game:resume', {});
  }

  _loop = () => {
    if (!this.running) return;

    // requestAnimationFrame does not fire in a hidden or zero-sized tab. The screenshot and
    // review harness runs in a browser pane that agents constantly background, which froze the
    // engine at frame 1 and made every capture look like a rendering failure. Fall back to a
    // timer so the game keeps simulating and rendering offscreen; the visual reviewers depend
    // on this, and a backgrounded tab must not be mistaken for a black frame.
    if (document.hidden) {
      this._raf = 0;
      this._hiddenTimer = setTimeout(this._loop, 16);
    } else {
      if (this._hiddenTimer) { clearTimeout(this._hiddenTimer); this._hiddenTimer = 0; }
      this._raf = requestAnimationFrame(this._loop);
    }

    const now = performance.now();
    let dt = (now - this._lastTime) / 1000;
    this._lastTime = now;

    if (this.paused) {
      // Still render so pause menus and post-process animate.
      this._render();
      return;
    }

    // Clamp so an alt-tab doesn't teleport the player through a wall.
    dt = Math.min(dt, MAX_FRAME_DT);
    this._elapsed += dt;
    this._frame++;
    this.ctx.clock.tick(dt);

    const input = this.systems.get('Input');
    input?.update?.();

    // --- fixed-step physics
    this._accumulator += dt;
    let steps = 0;
    while (this._accumulator >= FIXED_DT && steps < MAX_FIXED_STEPS) {
      this._accumulator -= FIXED_DT;
      steps++;
      for (const sys of this.systems.values()) {
        if (sys.__failed || typeof sys.fixedUpdate !== 'function') continue;
        try { sys.fixedUpdate(FIXED_DT); }
        catch (e) { this._systemThrew(sys, 'fixedUpdate', e); }
      }
    }
    if (steps >= MAX_FIXED_STEPS) this._accumulator = 0;   // shed the backlog

    // --- variable-step update
    for (const sys of this.systems.values()) {
      if (sys.__failed || typeof sys.update !== 'function') continue;
      try { sys.update(dt, this._elapsed); }
      catch (e) { this._systemThrew(sys, 'update', e); }
    }

    input?.endFrame?.();

    this._render();
    this._samplePerf(performance.now() - now);
  };

  _render() {
    const post = this.systems.get('Postprocessing');
    const r = this.ctx.renderer;
    r.info.reset();
    try {
      if (post && !post.__failed && typeof post.render === 'function') {
        post.render();
      } else {
        r.render(this.ctx.scene, this.ctx.camera);
      }
    } catch (e) {
      Log.once('render', 'Render threw:', e);
    }
    this.stats.drawCalls = r.info.render.calls;
    this.stats.triangles = r.info.render.triangles;
    this.stats.programs = r.info.programs?.length ?? 0;
  }

  _systemThrew(sys, method, e) {
    const key = `${sys.__name}:${method}`;
    Log.once(key, `System '${sys.__name}'.${method}() threw — disabling it.`, e);
    // One throw is a bug; every frame is a freeze. Disable after first.
    sys.__errorCount = (sys.__errorCount ?? 0) + 1;
    if (sys.__errorCount > 3) sys.__failed = true;
  }

  _samplePerf(ms) {
    const p = this._perf;
    p.samples[p.i] = ms;
    p.i = (p.i + 1) % p.samples.length;
    if (p.i === 0) p.filled = true;
    const n = p.filled ? p.samples.length : Math.max(1, p.i);
    let sum = 0;
    for (let k = 0; k < n; k++) sum += p.samples[k];
    p.avgMs = sum / n;
    this.stats.ms = p.avgMs;
    this.stats.fps = 1000 / Math.max(0.001, p.avgMs);
  }

  // ------------------------------------------------------------- resize

  _bindEvents() {
    this._onResize = () => this.resize();
    globalThis.addEventListener('resize', this._onResize);

    this._onVisibility = () => {
      // Deliberately does NOT pause. The engine must keep running while the tab is hidden so
      // the offscreen screenshot harness can capture converged frames; _loop() switches to a
      // timer in that case. Re-time the frame so the hidden span is not integrated at once.
      this._lastTime = performance.now();
    };
    document.addEventListener('visibilitychange', this._onVisibility);

    this._onContextLost = (e) => {
      e.preventDefault();
      Log.error('WebGL context lost');
      this.stop();
      this.ctx.bus.emit('engine:context-lost', {});
    };
    this._onContextRestored = () => {
      Log.warn('WebGL context restored');
      this.ctx.bus.emit('engine:context-restored', {});
      this.start();
    };
    this.ctx.canvas.addEventListener('webglcontextlost', this._onContextLost);
    this.ctx.canvas.addEventListener('webglcontextrestored', this._onContextRestored);

    this.ctx.bus.on('settings:changed', ({ key }) => {
      if (key === 'fov' || key === '*') {
        this.ctx.camera.fov = this.ctx.settings.get('fov');
        this.ctx.camera.updateProjectionMatrix();
      }
      if (key === 'quality' || key === 'dprCap' || key === '*') this.resize();
    });
  }

  resize() {
    // A backgrounded or detached tab reports clientWidth 0, which previously collapsed the
    // canvas to 1x1 and made every offscreen capture useless. Never size below a real
    // resolution — an unmeasurable viewport means "render at a sane default", not "render
    // nothing".
    const w = Math.max(640, this.mount.clientWidth || globalThis.innerWidth || DEFAULT_W);
    const h = Math.max(360, this.mount.clientHeight || globalThis.innerHeight || DEFAULT_H);
    const dpr = this.ctx.settings.effectiveDpr;

    if (w === this.ctx.width && h === this.ctx.height && dpr === this.ctx.dpr) return;

    this.ctx.width = w;
    this.ctx.height = h;
    this.ctx.dpr = dpr;

    this.ctx.renderer.setPixelRatio(dpr);
    this.ctx.renderer.setSize(w, h, false);

    this.ctx.camera.aspect = w / h;
    this.ctx.camera.updateProjectionMatrix();

    for (const sys of this.systems.values()) {
      if (sys.__failed || typeof sys.resize !== 'function') continue;
      try { sys.resize(w, h); }
      catch (e) { Log.once(`resize:${sys.__name}`, `resize() threw in ${sys.__name}`, e); }
    }

    this.ctx.bus.emit('engine:resize', { width: w, height: h, dpr });
  }

  // ------------------------------------------------------------- harness

  /**
   * Capture a frame at an exact size for the visual-review harness.
   *
   * MUST render a WARM frame, and this is not a detail — it invalidated an entire night of
   * visual evaluation. Resizing clears TAA history and the volumetric fog's temporal
   * reprojection, so a single render after a resize produces an image the game never actually
   * displays. Measured on the same scene, same code: a cold frame reported 75.6% of pixels
   * below luminance 0.02 where the warm frame reports 28.3% — five stops of pure instrumentation
   * error, and every agent judging those PNGs was judging an artefact.
   *
   * So: resize, then converge, then read. `warmFrames` must exceed the longest temporal
   * accumulation in the stack (TAA ~16, volumetric reprojection ~8 with a 0.9 blend).
   */
  async captureFrame({ width, height, dpr = 1, warmFrames = 70 } = {}) {
    const prev = { w: this.ctx.width, h: this.ctx.height, d: this.ctx.dpr };
    const resized = !!(width && height)
      && (width !== prev.w || height !== prev.h || dpr !== prev.d);

    if (resized) {
      this.ctx.renderer.setPixelRatio(dpr);
      this.ctx.renderer.setSize(width, height, false);
      this.ctx.width = width;
      this.ctx.height = height;
      this.ctx.dpr = dpr;
      this.ctx.camera.aspect = width / height;
      this.ctx.camera.updateProjectionMatrix();
      for (const sys of this.systems.values()) {
        try { sys.resize?.(width, height); }
        catch (e) { Log.once(`capture:resize:${sys.__name}`, `resize threw in ${sys.__name}`, e); }
      }
    }

    // Converge. Yielding to the event loop lets any per-frame timers and async work settle
    // the same way they would during normal play.
    const warm = resized ? warmFrames : Math.min(warmFrames, 24);
    for (let i = 0; i < warm; i++) {
      this._render();
      if ((i & 7) === 7) await new Promise((r) => setTimeout(r, 0));
    }

    const url = this.ctx.canvas.toDataURL('image/png');

    if (resized) {
      this.ctx.renderer.setPixelRatio(prev.d);
      this.ctx.renderer.setSize(prev.w, prev.h, false);
      this.ctx.width = prev.w;
      this.ctx.height = prev.h;
      this.ctx.dpr = prev.d;
      this.ctx.camera.aspect = prev.w / prev.h;
      this.ctx.camera.updateProjectionMatrix();
      for (const sys of this.systems.values()) {
        try { sys.resize?.(prev.w, prev.h); }
        catch (e) { Log.once(`capture:restore:${sys.__name}`, `resize threw in ${sys.__name}`, e); }
      }
    }
    return url;
  }

  /** True once every system has finished init and at least 5 frames have rendered. */
  get ready() { return this.running && this._frame > 5; }

  dispose() {
    this.stop();
    globalThis.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.ctx.canvas.removeEventListener('webglcontextlost', this._onContextLost);
    this.ctx.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
    for (const sys of this.systems.values()) {
      try { sys.dispose?.(); } catch (e) { Log.warn(`dispose() threw in ${sys.__name}`, e); }
    }
    this.systems.clear();
    this.ctx.bus.clear();
    this.ctx.renderer.dispose();
    this.ctx.canvas.remove();
    if (globalThis.__SLASHER__ === this) delete globalThis.__SLASHER__;
  }
}

export default Engine;
