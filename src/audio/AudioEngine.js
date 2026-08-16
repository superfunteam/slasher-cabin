/**
 * WebAudio graph: buses, HRTF 3D panning, distance/occlusion filtering, reverb zones,
 * and the SFX dispatcher. Listens to audio:sfx and noise:emit.
 *
 * OWNER: Audio agent.
 * STATUS: STUB — not yet implemented. See ARCHITECTURE.md before writing this file.
 *
 * Contract: default-export and named-export a class `AudioEngine` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 * Every method is optional except that the class must construct without throwing.
 */

export class AudioEngine {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
  }

  async init() {}

  update(_dt, _elapsed) {}

  resize(_w, _h) {}

  dispose() {}
}

export default AudioEngine;
