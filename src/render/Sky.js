/**
 * Night sky: physically-plausible moonlit scattering, star field with correct magnitudes,
 * moon disc with phase, drifting cloud layer, aurora on late nights, and lightning flash.
 *
 * OWNER: Render agent.
 * STATUS: STUB — not yet implemented. See ARCHITECTURE.md before writing this file.
 *
 * Contract: default-export and named-export a class `Sky` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 * Every method is optional except that the class must construct without throwing.
 */

export class Sky {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
  }

  async init() {}

  update(_dt, _elapsed) {}

  resize(_w, _h) {}

  dispose() {}
}

export default Sky;
