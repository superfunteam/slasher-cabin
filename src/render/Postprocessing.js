/**
 * The full post stack. Owns render(). Order: GTAO -> volumetrics composite -> SSR -> bloom ->
 * motion blur -> DOF -> tone map -> grade -> grain/CA/vignette -> TAA/SMAA.
 * MUST expose render() — Engine calls it instead of renderer.render().
 *
 * OWNER: Render agent.
 * STATUS: STUB — not yet implemented. See ARCHITECTURE.md before writing this file.
 *
 * Contract: default-export and named-export a class `Postprocessing` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 * Every method is optional except that the class must construct without throwing.
 */

export class Postprocessing {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
  }

  async init() {}

  update(_dt, _elapsed) {}

  resize(_w, _h) {}

  dispose() {}
}

export default Postprocessing;
