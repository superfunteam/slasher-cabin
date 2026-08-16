/**
 * ElevenLabs VO loading and 3D placement. Voice is ATMOSPHERE ONLY: placed in world space,
 * distance-filtered so it is usually half-heard. Must degrade to silence if files are absent.
 *
 * OWNER: Audio agent.
 * STATUS: STUB — not yet implemented. See ARCHITECTURE.md before writing this file.
 *
 * Contract: default-export and named-export a class `VoiceBank` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 * Every method is optional except that the class must construct without throwing.
 */

export class VoiceBank {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
  }

  async init() {}

  update(_dt, _elapsed) {}

  resize(_w, _h) {}

  dispose() {}
}

export default VoiceBank;
