/**
 * The core puzzle: parts, carrying, slots, snapping, correctness evaluation, torque, and the
 * creak consequence engine. Emits build:* events. This is the heart of the game.
 *
 * OWNER: Build agent.
 * STATUS: STUB — not yet implemented. See ARCHITECTURE.md before writing this file.
 *
 * Contract: default-export and named-export a class `BuildSystem` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 * Every method is optional except that the class must construct without throwing.
 */

export class BuildSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
  }

  async init() {}

  update(_dt, _elapsed) {}

  resize(_w, _h) {}

  dispose() {}
}

export default BuildSystem;
