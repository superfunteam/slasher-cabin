/**
 * Procedural PBR texture bakery. Generates albedo/normal/roughness/AO/height maps on the GPU
 * (render-to-target with fullscreen shaders) or on an OffscreenCanvas, cached by key.
 * Exposes: get(name, opts) -> { map, normalMap, roughnessMap, aoMap } and dispose().
 *
 * OWNER: Materials agent.
 * STATUS: STUB — not yet implemented. See ARCHITECTURE.md before writing this file.
 *
 * Contract: default-export and named-export a class `Textures` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 * Every method is optional except that the class must construct without throwing.
 */

export class Textures {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
  }

  async init() {}

  update(_dt, _elapsed) {}

  resize(_w, _h) {}

  dispose() {}
}

export default Textures;
