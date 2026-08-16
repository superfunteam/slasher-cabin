/**
 * First-person controller: heavy, deliberate movement, stamina, crouch, head-bob and the
 * handheld camera model. Owns the camera transform. Emits player:move and player:footstep.
 * Must expose: position (Vector3), velocity (Vector3), isCrouched, carryMass.
 *
 * OWNER: Player agent.
 * STATUS: STUB — not yet implemented. See ARCHITECTURE.md before writing this file.
 *
 * Contract: default-export and named-export a class `Player` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 * Every method is optional except that the class must construct without throwing.
 */

export class Player {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
  }

  async init() {}

  update(_dt, _elapsed) {}

  resize(_w, _h) {}

  dispose() {}
}

export default Player;
