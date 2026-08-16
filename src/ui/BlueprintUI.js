/**
 * The fold-out instruction manual. Flat, bright, clinical IKEA parody rendered over the 3D
 * world. Opening it is a real risk: it lights the player and slows them down.
 *
 * OWNER: UI agent.
 * STATUS: STUB — not yet implemented. See ARCHITECTURE.md before writing this file.
 *
 * Contract: default-export and named-export a class `BlueprintUI` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 * Every method is optional except that the class must construct without throwing.
 */

export class BlueprintUI {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
  }

  async init() {}

  update(_dt, _elapsed) {}

  resize(_w, _h) {}

  dispose() {}
}

export default BlueprintUI;
