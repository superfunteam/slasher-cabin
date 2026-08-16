/**
 * Patrol graph + pathfinding for campers. Sampled from Terrain, avoids trees and water.
 * Must expose: findPath(from, to) -> Vector3[], nearestNode(pos), randomPatrolTarget(rand).
 *
 * OWNER: AI agent.
 * STATUS: STUB — not yet implemented. See ARCHITECTURE.md before writing this file.
 *
 * Contract: default-export and named-export a class `Navmesh` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 * Every method is optional except that the class must construct without throwing.
 */

export class Navmesh {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
  }

  async init() {}

  update(_dt, _elapsed) {}

  resize(_w, _h) {}

  dispose() {}
}

export default Navmesh;
