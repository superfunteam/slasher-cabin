/**
 * All narrative content as data: night definitions, story beats, VO line table, environmental
 * storytelling placements, and the manual panel captions. No logic — data only.
 *
 * OWNER: Story agent.
 * STATUS: STUB — not yet implemented. See ARCHITECTURE.md before writing this file.
 *
 * Contract: default-export and named-export a class `Script` implementing the system
 * lifecycle (constructor(ctx), async init(), update(dt, elapsed), resize(w,h), dispose()).
 * Every method is optional except that the class must construct without throwing.
 */

export const Script = {
  nights: [],
  beats: {},
  voiceLines: [],
  panels: {},
};

export default Script;
