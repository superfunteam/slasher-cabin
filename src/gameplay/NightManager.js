/**
 * The director: night loop, objectives, pacing, difficulty curve, story beats, and scoring.
 * Owns phase transitions and emits night:begin / night:complete / night:failed / story:beat.
 *
 * OWNER: Director agent.
 * STATUS: STUB — not yet implemented. See ARCHITECTURE.md before writing this file.
 *
 * Contract: default-export and named-export a class `NightManager` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 * Every method is optional except that the class must construct without throwing.
 */

export class NightManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
  }

  async init() {}

  update(_dt, _elapsed) {}

  resize(_w, _h) {}

  dispose() {}
}

export default NightManager;
