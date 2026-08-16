/**
 * Procedural IKEA-diagram generation. Turns a build definition into an exploded axonometric
 * wordless diagram (drawn to canvas as vector line art) plus the puzzle grammar for the night.
 * Must expose: forNight(n) -> Blueprint { steps, parts, slots, panels, missingTool }.
 *
 * OWNER: Build agent.
 * STATUS: STUB — not yet implemented. See ARCHITECTURE.md before writing this file.
 *
 * Contract: default-export and named-export a class `Blueprint` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 * Every method is optional except that the class must construct without throwing.
 */

export class Blueprint {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
  }

  async init() {}

  update(_dt, _elapsed) {}

  resize(_w, _h) {}

  dispose() {}
}

export default Blueprint;
