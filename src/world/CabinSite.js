/**
 * The build plot: cleared ground, the foundation, the slot layout in world space, and the
 * visual assembly of the cabin as it grows. Renders ghost previews for BuildSystem.
 * Must expose: slots (array of Slot), slotWorldTransform(slotId), setInstalled(slotId, part).
 *
 * OWNER: Build agent.
 * STATUS: STUB — not yet implemented. See ARCHITECTURE.md before writing this file.
 *
 * Contract: default-export and named-export a class `CabinSite` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 * Every method is optional except that the class must construct without throwing.
 */

export class CabinSite {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
  }

  async init() {}

  update(_dt, _elapsed) {}

  resize(_w, _h) {}

  dispose() {}
}

export default CabinSite;
