/**
 * The player's amber kerosene lantern: SpotLight, flicker model, fuel, and the volumetric cone.
 * Must expose: on (bool), toggle(), intensity, and the light object for VolumetricFog to read.
 *
 * OWNER: Player agent.
 * STATUS: STUB — not yet implemented. See ARCHITECTURE.md before writing this file.
 *
 * Contract: default-export and named-export a class `Flashlight` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 * Every method is optional except that the class must construct without throwing.
 */

export class Flashlight {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
  }

  async init() {}

  update(_dt, _elapsed) {}

  resize(_w, _h) {}

  dispose() {}
}

export default Flashlight;
