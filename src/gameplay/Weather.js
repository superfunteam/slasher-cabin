/**
 * Rain, wind, storm fronts, and the lightning schedule. Drives Materials.globalUniforms.uRain
 * and uLightning, and provides thunder-masking windows to BuildSystem.
 *
 * OWNER: Director agent.
 * STATUS: STUB — not yet implemented. See ARCHITECTURE.md before writing this file.
 *
 * Contract: default-export and named-export a class `Weather` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 * Every method is optional except that the class must construct without throwing.
 */

export class Weather {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
  }

  async init() {}

  update(_dt, _elapsed) {}

  resize(_w, _h) {}

  dispose() {}
}

export default Weather;
