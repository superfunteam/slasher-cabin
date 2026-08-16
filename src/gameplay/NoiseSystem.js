/**
 * Noise propagation. Listens to noise:emit, applies distance falloff and occlusion
 * (terrain + trees + the cabin), and reports audibility per camper.
 * Must expose: audibilityAt(position, noiseEvent) -> 0..1.
 *
 * OWNER: AI agent.
 * STATUS: STUB — not yet implemented. See ARCHITECTURE.md before writing this file.
 *
 * Contract: default-export and named-export a class `NoiseSystem` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 * Every method is optional except that the class must construct without throwing.
 */

export class NoiseSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
  }

  async init() {}

  update(_dt, _elapsed) {}

  resize(_w, _h) {}

  dispose() {}
}

export default NoiseSystem;
