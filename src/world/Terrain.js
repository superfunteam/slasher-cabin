/**
 * Heightfield terrain: generation, chunked mesh, blended ground materials (needles/mud/moss/
 * granite), and the collision query API used by Physics.
 * Must expose: heightAt(x, z) -> number, normalAt(x, z, out) -> Vector3, surfaceAt(x,z) -> string.
 *
 * OWNER: World agent.
 * STATUS: STUB — not yet implemented. See ARCHITECTURE.md before writing this file.
 *
 * Contract: default-export and named-export a class `Terrain` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 * Every method is optional except that the class must construct without throwing.
 */

export class Terrain {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
  }

  async init() {}

  update(_dt, _elapsed) {}

  resize(_w, _h) {}

  dispose() {}
}

export default Terrain;
