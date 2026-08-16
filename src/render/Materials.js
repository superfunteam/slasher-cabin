/**
 * Shared material library + globalUniforms. Every material in the game is created here once,
 * during init(), and reused. Owns `Materials.globalUniforms` ({ uTime, uWind, uPlayerPos,
 * uRain, uLightning, uWetness }) which is updated once per frame and injected into patched
 * shaders via onBeforeCompile.
 *
 * OWNER: Materials agent.
 * STATUS: STUB — not yet implemented. See ARCHITECTURE.md before writing this file.
 *
 * Contract: default-export and named-export a class `Materials` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 * Every method is optional except that the class must construct without throwing.
 */

export class Materials {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
  }

  async init() {}

  update(_dt, _elapsed) {}

  resize(_w, _h) {}

  dispose() {}
}

export default Materials;
