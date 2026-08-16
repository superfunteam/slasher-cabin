/**
 * Camper agents: FSM (Idle/Curious/Searching/Alerted/Panic/Flee), vision cones with light
 * dependence, hearing via NoiseSystem, flashlights, animation, and camp-wide suspicion.
 * Emits player:spotted and player:hidden.
 *
 * OWNER: AI agent.
 * STATUS: STUB — not yet implemented. See ARCHITECTURE.md before writing this file.
 *
 * Contract: default-export and named-export a class `Campers` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 * Every method is optional except that the class must construct without throwing.
 */

export class Campers {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
  }

  async init() {}

  update(_dt, _elapsed) {}

  resize(_w, _h) {}

  dispose() {}
}

export default Campers;
