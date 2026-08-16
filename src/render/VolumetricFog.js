/**
 * Raymarched height fog + light shafts from the moon, the lantern, and every campfire.
 * Renders at half resolution with temporal reprojection and a Bayer dither.
 *
 * OWNER: Render agent.
 * STATUS: STUB — not yet implemented. See ARCHITECTURE.md before writing this file.
 *
 * Contract: default-export and named-export a class `VolumetricFog` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 * Every method is optional except that the class must construct without throwing.
 */

export class VolumetricFog {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
  }

  async init() {}

  update(_dt, _elapsed) {}

  resize(_w, _h) {}

  dispose() {}
}

export default VolumetricFog;
