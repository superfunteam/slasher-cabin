/**
 * Capsule-vs-world collision, pooled raycasting, and carried-object simulation.
 * Must expose: raycast(origin, dir, maxDist, mask) -> hit|null (pooled, no allocation),
 * moveCapsule(pos, vel, radius, height, dt) -> resolved position, and sphereCast().
 *
 * OWNER: Player agent.
 * STATUS: STUB — not yet implemented. See ARCHITECTURE.md before writing this file.
 *
 * Contract: default-export and named-export a class `Physics` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 * Every method is optional except that the class must construct without throwing.
 */

export class Physics {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
  }

  async init() {}

  update(_dt, _elapsed) {}

  resize(_w, _h) {}

  dispose() {}
}

export default Physics;
