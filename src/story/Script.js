/**
 * Script.js — THE STORY DATA MODULE
 * =================================
 *
 * OWNER: Story agent. Canonical transcription of `STORY.md` into structured, queryable data.
 * Numbers that exist in `GAME_DESIGN.md` are taken from `GAME_DESIGN.md` verbatim.
 *
 * PURE DATA. Zero systems, zero state, zero side effects. Nothing here imports Three.js,
 * touches `ctx`, or registers as a system. Import it directly:
 *
 *   import { Script, linesFor, nightDef, beat } from '../story/Script.js';
 *
 * -----------------------------------------------------------------------------------------
 * NON-NEGOTIABLES INHERITED FROM STORY.md (§ APPENDIX). If your module breaks one of these,
 * your module is wrong, not this file:
 *
 *   1. NO NARRATOR. Nothing in this file is spoken by the game. `beat.text` exists only on
 *      beats of kind 'card' | 'report' — the manual's own flat-pack typeface on flat white.
 *      Every other beat carries `direction`, which is a note to YOU and is NEVER RENDERED.
 *   2. NO TEXT IN THE WORLD except article numbers and the word HJEM.
 *   3. THE SLASHER NEVER SPEAKS. There is no `speaker: 'ansel'` anywhere in `voiceLines`.
 *   4. THE CAMPERS ARE NEVER STUPID.
 *   5. THE MANUAL IS THE ONLY COMEDIAN, AND IT STOPS BEING FUNNY ON NIGHT FOUR.
 *   6. `panel.caption` is a DEVELOPER-FACING DESCRIPTION OF LINE ART. `BlueprintUI` must draw
 *      it, never print it. Printing a caption is the single worst bug you can ship here.
 *   7. The game must be fully playable, and fully sad, with `public/audio/vo/` deleted.
 *      Voice is weather.
 *
 * -----------------------------------------------------------------------------------------
 * INTEGRATION MAP — who reads what
 *
 *   NightManager  Script.nights[n-1].beats  → emits `story:beat { id }`
 *                 Script.beats[id].flagsSet → writes `ctx.state.storyFlags`
 *                 Script.nights[n-1].durationSeconds / stageCount / weatherProfile
 *   Campers       Script.campers[] (walkSpeed, curiosity, bravery, archetype, torchTint)
 *                 linesTagged('curious'|'searching'|'alerted'|'halfheard', night)
 *   VoiceBank     Script.voiceLines[] → `public/audio/vo/<id>.mp3`, plus subtitle text
 *   BlueprintUI   Script.panels[n], Script.manualVoice[n], Script.manualRules, Script.glyphs
 *   Blueprint     Script.panels[n][*].authorship → line jitter / stroke doubling / ghosting
 *   Menu / HUD    Script.titleCards[n], Script.assemblyReport, Script.endings
 *   Props/CabinSite  Script.props[] (advisory placements — snap to terrain, see §PROPS)
 *   tools/generate-voices.mjs  Script.voiceLines[] (id, text, speaker, stability, …)
 *
 * Records in `voiceLines` and `campers` are SEALED, not frozen, so the VO tooling may write
 * `elevenVoiceId` / `voiceId` onto them. Everything else is deep-frozen. Treat all of it as
 * read-only; the helpers return cached frozen arrays so they are safe to call in a hot path.
 */

/* =========================================================================================
 * 0. VOCABULARIES — the closed sets. Do not invent members of these at call sites.
 * ======================================================================================= */

/** Camper ids. The only legal values of `voiceLine.speaker`. */
export const SPEAKERS = Object.freeze(['robin', 'dale', 'marg', 'coop', 'teddy', 'bev']);

/** VO categories, one per subsection of STORY.md §6. */
export const CATEGORIES = Object.freeze([
  'idle',       // §6.1 banal, overlapping, funny by accident
  'call',       // §6.2 across distance — the loudest lines in the game
  'campfire',   // §6.3 nights 1–3 only
  'argue',      // §6.4 small, domestic, real
  'heard',      // §6.5 "I heard something"
  'search',     // §6.6 organised searching
  'falsealarm', // §6.7 the comedy that stops being comedy
  'evidence',   // §6.8 finding evidence
  'fear',       // §6.9 genuine fear
  'late',       // §6.10 nights 6 and 7 only
]);

/**
 * Beat kinds. `text` is legal ONLY on 'card' and 'report'.
 *   card       a flat-white title card in the manual's typeface (STORY §9)
 *   panel      the manual changes — BlueprintUI must redraw
 *   discovery  the player finds a thing
 *   sighting   a camper sees or hears something scripted
 *   kill       off-camera, hard cut, no sting
 *   shot       a directed image (opening/closing) — camera + audio, no words
 *   escalation a mechanical consequence with a story face on it
 *   toast      icon-only `ui:toast` (text is always the empty string)
 *   ending     terminal
 */
export const BEAT_KINDS = Object.freeze([
  'card', 'panel', 'discovery', 'sighting', 'kill', 'shot', 'escalation', 'toast', 'report', 'ending',
]);

/**
 * Trigger vocabulary. NightManager owns evaluation; these are declarations, not code.
 *
 *   { kind:'night-begin' }                                fire on `night:begin`
 *   { kind:'night-complete' }                             fire on `night:complete`
 *   { kind:'stage-complete', stage:2 }                    on `build:stage-complete { stage }`
 *   { kind:'time', at:0.42 }                              first frame `timeOfNight >= at`
 *   { kind:'event', event:'tool:found', match:{…} }        first matching canonical event
 *   { kind:'flag', flag:'stoleHinges' }                   when the flag becomes true
 *   { kind:'proximity', anchor:'cabin_site', radius:6, actor:'robin' }
 *   { kind:'manual' }                                     another system fires it explicitly
 */
export const TRIGGER_KINDS = Object.freeze([
  'night-begin', 'night-complete', 'stage-complete', 'time', 'event', 'flag', 'proximity', 'manual',
]);

/** Canonical story flags (STORY.md § APPENDIX). Nothing else may be written to storyFlags. */
export const STORY_FLAGS = Object.freeze([
  'sawIntroPanel', 'foundShim', 'robinSuspicious', 'robinDismissed', 'stoleHinges',
  'firstBlood', 'sawSecondFigure', 'riggedCounterweight', 'foundRuinAnchors',
  'robinSaw', 'bevRemembered', 'manualBlank', 'ending_a', 'ending_b', 'ending_c',
]);

/** The eight canonical beat ids, in order (STORY.md § APPENDIX). Everything else is texture. */
export const CANONICAL_BEAT_ORDER = Object.freeze([
  'n1_thumbs_up', 'n2_robin_hears', 'n3_not_believed', 'n4_dale',
  'n5_two_persons', 'n6_robin_inside', 'n6_bev_remembers', 'n7_final',
]);

/** The complete glyph set (GAME_DESIGN §2.4). `Blueprint` draws nothing else. */
export const GLYPHS = Object.freeze([
  'arrow-straight', 'arrow-curved', 'mascot', 'mascot-hand-raised',
  'circle-number', 'circle-number-dashed', 'mirror', 'dotted-outline',
  'bag-count', 'red-exclamation-triangle', 'red-slash-circle', 'telephone',
  'magnifier',        // N1.4 only — the bolt, again, larger, in case you missed the bolt
  'tick', 'sparkle', 'eraser-ghost', 'motion-ticks', 'parts-bracket', 'makers-mark',
]);

/**
 * ARTICLE NUMBER SCHEME. STORY §3: the article numbers are the only "text" in the manual and
 * they are NOT RANDOM. Format `YYYY-NNN`:
 *   YYYY — a year in the Vik house's history:
 *          1949 Ansel born · 1953–1957 the four pencil marks on the doorframe ·
 *          1961 the licence plate · 1962 the fire and the survey marker · 1971 Bev arrives ·
 *          1984 now · 0000 the part that does not exist.
 *   NNN  — a quantity, or a doorframe height in centimetres (091, 108, 124, 141).
 * The player will never be told this. One player in a thousand will notice 0000-000 is the only
 * number with no year in it.
 */
export const ARTICLE_SCHEME = Object.freeze({
  format: 'YYYY-NNN',
  years: Object.freeze({
    1949: 'Ansel born',
    1953: 'first pencil mark, 91 cm',
    1955: 'second and third pencil marks, 108 and 124 cm',
    1957: 'fourth pencil mark, 141 cm',
    1961: 'the licence plate',
    1962: 'the fire; the Wanaka Pines Land Company survey marker',
    1971: 'Bev Ranczak arrives',
    1984: 'now',
    0: 'the part that does not exist',
  }),
  phantom: '0000-000',
});

/* =========================================================================================
 * 1. THE CAMPERS — STORY.md §5
 *
 * `walkSpeed` overrides the 1.2 m/s Idle patrol default in GAME_DESIGN §4.3 per person;
 * Searching (1.8), Alerted (3.4) and Panic (4.1) speeds are global and stay with Campers.js.
 * `curiosity`  0..1 — how readily Idle escalates to Curious on a marginal noise hit.
 * `bravery`    0..1 — high: investigates alone. low: goes and gets someone else first.
 * `archetype`  selects the sensory row in GAME_DESIGN §4.1 (range/FOV/hearing threshold).
 * `torchTint`  so the player learns whose torch is whose. Palette-legal: no saturated reds.
 * ======================================================================================= */

const CAMPERS = [
  {
    id: 'robin',
    name: 'Robin Osei-Hall',
    age: 19,
    role: 'Arts & Crafts',
    archetype: 'counselor',
    voiceProfile:
      'Young, tired, unperformed. Duluth boatyard kid — ten thousand hours of tools in her ears. '
      + 'Never horror-movie. Reads technical detail like it is obvious, because to her it is.',
    elevenVoiceId: null,
    pitch: 1.04,
    rate: 1.02,
    verbalTic: 'Restarts her own sentences — "Okay so — okay, no, listen." Never finishes the first attempt.',
    relationship: 'Older-sister energy toward Teddy; she checks he has eaten. Reluctant almost-ally of Dale.',
    colorTint: '#f2e3c4',
    torchTint: '#f2e3c4',
    walkSpeed: 1.25,
    curiosity: 0.95,
    bravery: 0.72,
    firstNight: 2,
    lastNight: 7,
    hasTorch: true,
    note: 'She is the one who notices on Night Two and is not believed. She is the only one who '
      + 'gets inside the house and understands what it is.',
  },
  {
    id: 'dale',
    name: 'Dale Pruitt',
    age: 27,
    role: 'Maintenance',
    archetype: 'counselor',
    voiceProfile:
      'Sixth summer. Warm, flat, a half-beat behind. Two drinks in from about nine o\'clock onward. '
      + 'Kindness that costs him something. Trails off rather than finishing.',
    elevenVoiceId: null,
    pitch: 0.93,
    rate: 0.96,
    verbalTic: 'Calls everyone chief or champ. Ends thoughts with "…anyway."',
    relationship: 'Bev\'s oldest friend on site. Could corroborate Robin on Night Three and does not.',
    colorTint: '#ffc98a',
    torchTint: '#ffc98a',
    walkSpeed: 1.10,
    curiosity: 0.35,
    bravery: 0.60,
    firstNight: 1,
    lastNight: 4,
    hasTorch: true,
    note: 'Dies Night Four, politely, mid-sentence, having knocked first. All DAL_* lines carry '
      + 'blockedByFlag:"firstBlood" — after the beat n4_dale, he is silent and stays silent.',
  },
  {
    id: 'marg',
    name: 'Marguerite "Marg" Toth',
    age: 21,
    role: 'Waterfront Director',
    archetype: 'counselor',
    voiceProfile:
      'Third summer. Runs the dock like a small navy. Narrates her own logistics because it is how '
      + 'she thinks. Competent, warm, slightly bossy. Never shrill, even at the end.',
    elevenVoiceId: null,
    pitch: 1.00,
    rate: 1.06,
    verbalTic: 'Counts out loud — "one, two, and — okay."',
    relationship: 'With Coop, three months, hasn\'t told her mother. Organises the Night Five search.',
    colorTint: '#eaf0ff',
    torchTint: '#eaf0ff',
    walkSpeed: 1.35,
    curiosity: 0.60,
    bravery: 0.80,
    firstNight: 2,
    lastNight: 7,
    hasTorch: true,
    note: 'The first to organise a proper search instead of a panic.',
  },
  {
    id: 'coop',
    name: 'Cooper "Coop" Vance',
    age: 20,
    role: 'Sports & Rec',
    archetype: 'counselor',
    voiceProfile:
      'Second summer. Loud, four bad chords, turns everything into a bit and apologises for the bit '
      + 'thirty seconds later. Write him kind. His bits are how he checks whether people are okay.',
    elevenVoiceId: null,
    pitch: 0.98,
    rate: 1.05,
    verbalTic: 'Apologises for his own jokes — "sorry, that was — yeah, sorry."',
    relationship: 'Marg; and he has appointed himself Teddy\'s guy.',
    colorTint: '#ffe9b0',
    torchTint: '#ffe9b0',
    walkSpeed: 1.30,
    curiosity: 0.45,
    bravery: 0.40,
    firstNight: 2,
    lastNight: 7,
    hasTorch: true,
    note: 'On Night Six he stops doing bits and it is genuinely alarming. See COO_FEAR_02.',
  },
  {
    id: 'teddy',
    name: 'Teddy Nakagawa',
    age: 16,
    role: 'Counselor-in-Training',
    archetype: 'kid',
    voiceProfile:
      'First summer away from home. Says sorry as punctuation. Small voice that does not carry. '
      + 'Homesick in the specific sixteen-year-old way where you would rather die than mention it.',
    elevenVoiceId: null,
    pitch: 1.09,
    rate: 0.98,
    verbalTic: 'Says "sorry" as punctuation; asks permission for things he was already told to do.',
    relationship: 'Orbits Coop; is looked after by Robin. Mentions being homesick exactly once, at 2 a.m.',
    colorTint: '#d8e4ea',
    torchTint: '#d8e4ea',
    walkSpeed: 1.15,
    curiosity: 0.70,
    bravery: 0.12,
    firstNight: 2,
    lastNight: 7,
    hasTorch: false,
    note: 'archetype "kid" per GAME_DESIGN §4.1: range 16 m, FOV 100°, no torch, hearing 0.18, '
      + 'flees fast. Lowest bravery in the cast — he always goes to get someone.',
  },
  {
    id: 'bev',
    name: 'Beverly "Bev" Ranczak',
    age: 58,
    role: 'Camp Director',
    archetype: 'head counselor',
    voiceProfile:
      'Here since 1971. Winstons. Fragments with the articles removed. The only voice in the cast '
      + 'that is not young and tired. Absolute authority at zero volume. Never raises it, ever.',
    elevenVoiceId: null,
    pitch: 0.88,
    rate: 0.94,
    verbalTic: 'Drops articles — "Get the tarps. Both of \'em. Now."',
    relationship: 'Everyone\'s boss; Dale\'s oldest friend on site.',
    colorTint: '#ffd08a',
    torchTint: '#ffd08a',
    walkSpeed: 1.05,
    curiosity: 0.50,
    bravery: 0.85,
    firstNight: 3,
    lastNight: 7,
    hasTorch: true,
    note: 'The living link. Carries the whistle from Night Five (GAME_DESIGN §4.1 head counselor: '
      + 'range 28 m, FOV 115°, wide torch, hearing 0.09, can raise camp-wide suspicion alone). '
      + 'On Night Six she remembers the family\'s name and stops one syllable short of it.',
  },
];

/* =========================================================================================
 * 2. VO LINE BANK — STORY.md §6, all 90 lines, transcribed verbatim.
 *
 * `night`     earliest night this line may play (0 = any).
 * `nightMax`  last night it may play (null = no ceiling). Used for: Dale (dies N4), campfire
 *             (N1–3 only), and the jokes that STORY §4 kills on Night Four.
 * `blockedByFlag`  do not schedule once this storyFlag is set.
 * `emphasis`  the word STORY.md italicised. Kept OUT of `text` so the TTS payload is clean;
 *             pass it to the VO tool as direction, and let VoiceBank underline it in subtitles.
 * `tags`      role hooks for Campers.js FSM states — see Script.voRoles.
 * `priority`  scheduling weight 0..1. Higher wins when two lines are eligible at once.
 * ======================================================================================= */

const DEFAULT_PRIORITY = {
  idle: 0.20, call: 0.45, campfire: 0.35, argue: 0.50, heard: 0.70,
  search: 0.75, falsealarm: 0.55, evidence: 0.85, fear: 0.90, late: 1.00,
};

/**
 * Data constructor for a VO row. Mirrors the column order of the tables in STORY.md §6 so the
 * two can be diffed by eye: ID | Speaker | Line | State | Delivery | S / Sim / St.
 */
function line(id, speaker, text, category, emotion, delivery, s, sim, st, night, opts = {}) {
  return {
    id,
    speaker,
    text,
    category,
    emotion,
    delivery,
    night,
    nightMax: opts.nightMax ?? null,
    stability: s,
    similarity: sim,
    style: st,
    priority: opts.priority ?? DEFAULT_PRIORITY[category] ?? 0.5,
    tags: Object.freeze(opts.tags ?? []),
    emphasis: opts.emphasis ?? null,
    blockedByFlag: opts.blockedByFlag ?? null,
    beat: opts.beat ?? null,
    note: opts.note ?? null,
    audio: `audio/vo/${id}.mp3`,
    elevenVoiceId: null,
  };
}

const DALE_ALIVE = { blockedByFlag: 'firstBlood', nightMax: 4 };

const VOICE_LINES = [
  // ---- §6.1 Idle chatter — banal, overlapping, funny by accident --------------------------
  line('MRG_IDLE_01', 'marg', "One, two — and that's the last of the tarps.",
    'idle', 'content', 'to herself, counting', 0.45, 0.80, 0.20, 2, { tags: ['ambient'] }),
  line('MRG_IDLE_02', 'marg', "Whoever loaded this truck hates me personally.",
    'idle', 'wry', 'half-laugh at the end', 0.40, 0.80, 0.30, 2, { nightMax: 4, tags: ['ambient'] }),
  line('COO_IDLE_01', 'coop', "I'm just saying, powdered eggs are a choice.",
    'idle', 'jokey', 'mid-bit, no punchline', 0.35, 0.78, 0.40, 2,
    { nightMax: 4, emphasis: 'choice', tags: ['ambient'] }),
  line('COO_IDLE_02', 'coop', "Sorry, that was — yeah. Sorry.",
    'idle', 'sheepish', 'apologising to nobody', 0.40, 0.78, 0.35, 2, { nightMax: 5, tags: ['ambient'] }),
  line('COO_IDLE_03', 'coop', "Does this look level to you? Don't lie.",
    'idle', 'casual', 'genuinely asking', 0.45, 0.78, 0.30, 2,
    { nightMax: 4, tags: ['ambient'], note: 'The only line in the bank a carpenter would enjoy.' }),
  line('DAL_IDLE_01', 'dale', "Third year that pump's gone out. Anyway.",
    'idle', 'tired', 'trails off, no ending', 0.50, 0.82, 0.20, 1, { ...DALE_ALIVE, tags: ['ambient'] }),
  line('DAL_IDLE_02', 'dale', "You want it done or you want it done right, champ.",
    'idle', 'dry', 'old joke, said flat', 0.50, 0.82, 0.25, 1, { ...DALE_ALIVE, tags: ['ambient'] }),
  line('DAL_IDLE_03', 'dale', "Ah — nope. That's a hornet situation.",
    'idle', 'alarmed-mild', 'retreating, unbothered', 0.40, 0.80, 0.35, 1, { ...DALE_ALIVE, tags: ['ambient'] }),
  line('ROB_IDLE_01', 'robin', "Okay so — okay, no. Start over.",
    'idle', 'focused', 'correcting herself', 0.40, 0.80, 0.30, 2, { tags: ['ambient'] }),
  line('ROB_IDLE_02', 'robin', "Teddy. Teddy. Did you eat? Don't lie to me.",
    'idle', 'warm', 'sisterly, insistent', 0.40, 0.80, 0.35, 2, { nightMax: 5, tags: ['ambient'] }),
  line('TED_IDLE_01', 'teddy', "Sorry — is this the right shed? Sorry.",
    'idle', 'anxious', 'over-polite', 0.35, 0.78, 0.40, 2, { nightMax: 5, tags: ['ambient'] }),
  line('TED_IDLE_02', 'teddy', "My mom packed like nine cans of soup.",
    'idle', 'shy', 'small laugh at himself', 0.35, 0.78, 0.35, 2, { nightMax: 4, tags: ['ambient'] }),
  line('BEV_IDLE_01', 'bev', "Rain by Thursday. Get the canvas up.",
    'idle', 'brisk', 'no articles, no warmth', 0.60, 0.85, 0.15, 3, { tags: ['ambient'] }),
  line('BEV_IDLE_02', 'bev', "Twenty-two summers. Never once on schedule.",
    'idle', 'fond', 'almost affectionate', 0.55, 0.85, 0.20, 3,
    { nightMax: 5, tags: ['ambient'], note: 'Pays off against BEV_FEAR_01, which is the same sentence broken.' }),

  // ---- §6.2 Calling out to each other — the loudest lines in the game ---------------------
  line('MRG_CALL_01', 'marg', "Coop! Other end! Other other end!",
    'call', 'busy', 'shouted, laughing', 0.30, 0.78, 0.45, 2,
    { nightMax: 4, emphasis: 'other', tags: ['ambient'] }),
  line('COO_CALL_01', 'coop', "Yeah — hang on — yeah!",
    'call', 'busy', 'half-shouted, muffled', 0.30, 0.78, 0.40, 2, { nightMax: 5, tags: ['ambient'] }),
  line('ROB_CALL_01', 'robin', "Dale? You up by the shed?",
    'call', 'neutral', 'carrying voice, unworried', 0.40, 0.80, 0.30, 2,
    { ...DALE_ALIVE, tags: ['curious'] }),
  line('DAL_CALL_01', 'dale', "Yeah, chief, I'm here!",
    'call', 'neutral', 'shouted from far off', 0.35, 0.82, 0.35, 1, { ...DALE_ALIVE, tags: ['ambient'] }),
  line('BEV_CALL_01', 'bev', "Everybody. Mess hall. Ten minutes.",
    'call', 'commanding', 'flat, absolute', 0.60, 0.85, 0.15, 3, { tags: ['ambient'] }),
  line('TED_CALL_01', 'teddy', "Coop? Was that you?",
    'call', 'uncertain', 'too quiet to carry', 0.30, 0.78, 0.40, 2, { tags: ['curious', 'halfheard'] }),
  line('MRG_CALL_02', 'marg', "Say again? You're breaking up in the trees!",
    'call', 'neutral', 'cupped hands', 0.35, 0.80, 0.40, 2, { tags: ['ambient'] }),
  line('ROB_CALL_02', 'robin', "Nothing! Never mind!",
    'call', 'resigned', 'giving up on being heard', 0.40, 0.80, 0.35, 2, { tags: ['halfheard'] }),

  // ---- §6.3 Campfire stories — Nights 1–3 only -------------------------------------------
  line('COO_FIRE_01', 'coop', "…and that's why we don't swim past the raft.",
    'campfire', 'performative', 'doing a voice, badly', 0.30, 0.78, 0.55, 2,
    { nightMax: 3, emphasis: "that's" }),
  line('MRG_FIRE_01', 'marg', "That's not true. None of that is true.",
    'campfire', 'amused', 'interrupting', 0.40, 0.80, 0.35, 2, { nightMax: 3 }),
  line('COO_FIRE_02', 'coop', "It's emotionally true, Marguerite.",
    'campfire', 'jokey', 'mock-wounded', 0.30, 0.78, 0.50, 2, { nightMax: 3, emphasis: 'emotionally' }),
  line('DAL_FIRE_01', 'dale', "There was a house out on the point. Before.",
    'campfire', 'flat', 'throwaway, no weight', 0.55, 0.82, 0.15, 1,
    { nightMax: 3, priority: 0.55, blockedByFlag: 'firstBlood',
      note: 'The whole story, dropped and not picked up. He does not care yet. Schedule it once, '
        + 'quietly, at distance, and never repeat it in a run.' }),
  line('MRG_FIRE_02', 'marg', "Before what?",
    'campfire', 'curious', 'genuine, small', 0.45, 0.80, 0.30, 2, { nightMax: 3, priority: 0.55 }),
  line('DAL_FIRE_02', 'dale', "Before the camp. Burned, I think. Anyway.",
    'campfire', 'disinterested', 'he does not care yet', 0.55, 0.82, 0.15, 2,
    { nightMax: 3, priority: 0.55, blockedByFlag: 'firstBlood' }),
  line('TED_FIRE_01', 'teddy', "Is it okay if I sit here? Sorry.",
    'campfire', 'shy', 'barely audible', 0.35, 0.78, 0.40, 2, { nightMax: 3 }),
  line('ROB_FIRE_01', 'robin', "Sit down, Teddy. God.",
    'campfire', 'warm', 'laughing at him kindly', 0.40, 0.80, 0.35, 2, { nightMax: 3 }),

  // ---- §6.4 Arguments — small, domestic, real --------------------------------------------
  line('MRG_ARG_01', 'marg', "I asked you to do it before dark.",
    'argue', 'irritated', 'tired, not angry', 0.40, 0.80, 0.40, 2, { emphasis: 'asked' }),
  line('COO_ARG_01', 'coop', "And I said I would, and I'm doing it.",
    'argue', 'defensive', 'flat, hurt', 0.35, 0.78, 0.40, 2, {}),
  line('BEV_ARG_01', 'bev', "Not tonight. Both of you.",
    'argue', 'final', 'zero volume, total authority', 0.60, 0.85, 0.15, 3, {}),
  line('BEV_ARG_02', 'bev', "Sound carries over the water. Happens every year.",
    'argue', 'dismissive', 'kind, and wrong', 0.55, 0.85, 0.20, 3,
    { priority: 1.0, beat: 'n3_not_believed',
      note: 'Bev is not being dismissive. Bev is being correct about a thing that is usually true.' }),
  line('ROB_ARG_01', 'robin', "It wasn't the water. It was — okay. Fine.",
    'argue', 'frustrated', 'giving up mid-sentence', 0.35, 0.80, 0.45, 3,
    { priority: 0.95, beat: 'n3_not_believed' }),
  line('DAL_ARG_01', 'dale', "If we call it in, it's a report. Anyway.",
    'argue', 'evasive', "won't meet her eye", 0.50, 0.82, 0.25, 3,
    { ...DALE_ALIVE, priority: 0.95, beat: 'n3_not_believed' }),
  line('ROB_ARG_02', 'robin', "So that's a no. That's a no, Dale.",
    'argue', 'quiet-angry', 'very controlled', 0.35, 0.80, 0.45, 3,
    { priority: 0.95, beat: 'n3_not_believed',
      note: 'The first cruelty in the script, committed by the campers, gently, to each other.' }),
  line('TED_ARG_01', 'teddy', "Are you guys — sorry. Never mind.",
    'argue', 'uncomfortable', 'backing out of a room', 0.30, 0.78, 0.40, 2, {}),

  // ---- §6.5 "I heard something" -----------------------------------------------------------
  line('ROB_HEAR_01', 'robin', "Shh — shh. There. That.",
    'heard', 'alert', 'dead still, whispered', 0.30, 0.78, 0.50, 2,
    { priority: 1.0, beat: 'n2_robin_hears', tags: ['curious'] }),
  line('ROB_HEAR_02', 'robin', "That's a mallet. That's somebody driving a stake.",
    'heard', 'certain', 'technical, unsettling', 0.40, 0.80, 0.35, 2,
    { priority: 0.98, beat: 'n2_robin_hears', tags: ['curious'],
      note: 'She is right for a technical reason nobody else can evaluate. That is her tragedy.' }),
  line('MRG_HEAR_01', 'marg', "Okay, I heard that one. I heard that.",
    'heard', 'unnerved', 'conceding, not scared', 0.35, 0.80, 0.40, 3, { tags: ['curious'] }),
  line('COO_HEAR_01', 'coop', "Deer. That's deer. That's a deer thing.",
    'heard', 'reassuring', 'reassuring himself', 0.30, 0.78, 0.45, 2, { tags: ['curious', 'halfheard'] }),
  line('DAL_HEAR_01', 'dale', "Huh.",
    'heard', 'neutral', 'one syllable, thoughtful', 0.55, 0.82, 0.20, 1,
    { ...DALE_ALIVE, tags: ['curious', 'halfheard'],
      note: 'The cheapest and best line in the bank. Use it for a marginal noise hit at distance.' }),
  line('TED_HEAR_01', 'teddy', "Something moved. Over — there. Sorry.",
    'heard', 'frightened', 'pointing, small voice', 0.25, 0.78, 0.55, 2, { tags: ['curious'] }),
  line('BEV_HEAR_01', 'bev', "Quiet. Everybody. Quiet.",
    'heard', 'hard', 'drops to nothing', 0.55, 0.85, 0.25, 3, { tags: ['curious', 'searching'] }),
  line('MRG_HEAR_02', 'marg', "It stopped. Why did it stop.",
    'heard', 'tense', 'not a question', 0.30, 0.80, 0.50, 3,
    { tags: ['searching'], note: 'Schedule this when the player STOPS hammering. It is the reward '
      + 'for good discipline and it should make the player feel watched.' }),
  line('ROB_HEAR_03', 'robin', "Four hits. Even. Nothing hits four times even.",
    'heard', 'insistent', 'building an argument', 0.35, 0.80, 0.45, 2,
    { priority: 0.95, beat: 'n2_robin_hears', tags: ['searching'] }),
  line('COO_HEAR_02', 'coop', "Okay that's — okay, that's not funny now.",
    'heard', 'rattled', 'bit collapsing in real time', 0.30, 0.78, 0.50, 4, { tags: ['searching'] }),

  // ---- §6.6 Searching ---------------------------------------------------------------------
  line('MRG_SRCH_01', 'marg', "Pairs. Nobody goes out alone, I mean it.",
    'search', 'organised', 'commanding, steady', 0.45, 0.80, 0.30, 5, { tags: ['searching'] }),
  line('MRG_SRCH_02', 'marg', "One, two — Robin, that's three, where's Coop?",
    'search', 'counting', 'rising', 0.35, 0.80, 0.40, 5, { tags: ['searching'] }),
  line('COO_SRCH_01', 'coop', "Dale? Buddy? You messing with us?",
    'search', 'hopeful', 'wants to be pranked', 0.30, 0.78, 0.45, 5,
    { tags: ['searching'], priority: 0.85 }),
  line('ROB_SRCH_01', 'robin', "Check the boathouse. The door's open.",
    'search', 'focused', 'flat, professional', 0.40, 0.80, 0.35, 5, { tags: ['searching'] }),
  line('BEV_SRCH_01', 'bev', "Torches low. Watch the roots.",
    'search', 'practical', 'still doing her job', 0.55, 0.85, 0.20, 5, { tags: ['searching'] }),
  line('TED_SRCH_01', 'teddy', "How far do we go? Sorry — how far?",
    'search', 'scared', 'asking permission again', 0.25, 0.78, 0.55, 5, { tags: ['searching'] }),
  line('COO_SRCH_02', 'coop', "Dale! Come on, man!",
    'search', 'strained', 'shouting into trees', 0.25, 0.78, 0.55, 5, { tags: ['searching', 'alerted'] }),
  line('ROB_SRCH_02', 'robin', "Stop. Everybody stop. Listen.",
    'search', 'tight', 'commanding for the first time', 0.30, 0.80, 0.50, 5, { tags: ['searching'] }),
  line('MRG_SRCH_03', 'marg', "We've been past that stump twice.",
    'search', 'worried', 'quiet realisation', 0.35, 0.80, 0.40, 5, { tags: ['searching'] }),
  line('BEV_SRCH_02', 'bev', "Back to the road. Now. Move.",
    'search', 'urgent', 'no fear in it, only speed', 0.55, 0.85, 0.25, 5, { tags: ['alerted'] }),

  // ---- §6.7 False alarms — the comedy that stops being comedy -----------------------------
  line('COO_FALSE_01', 'coop', "AH — okay. Okay. Raccoon. It's a raccoon.",
    'falsealarm', 'startled', 'genuine fright, fast recovery', 0.25, 0.78, 0.60, 2,
    { nightMax: 5, tags: ['curious'] }),
  line('MRG_FALSE_01', 'marg', "You screamed. You actually screamed.",
    'falsealarm', 'teasing', 'relieved laughing', 0.35, 0.80, 0.45, 2, { nightMax: 4 }),
  line('TED_FALSE_01', 'teddy', "Sorry! Sorry, that was me, sorry.",
    'falsealarm', 'embarrassed', 'mortified', 0.30, 0.78, 0.45, 2, { nightMax: 5 }),
  line('ROB_FALSE_01', 'robin', "It's fine. It's fine. Everyone breathe.",
    'falsealarm', 'steadying', "doesn't believe it", 0.40, 0.80, 0.35, 3, {}),
  line('COO_FALSE_02', 'coop', "See? Nothing. Told you. Nothing.",
    'falsealarm', 'hollow', "the bit isn't working", 0.30, 0.78, 0.50, 5,
    { note: 'Same joke as COO_FALSE_01, three nights later, with the laugh taken out.' }),
  line('DAL_FALSE_01', 'dale', "Little guy's got more right to be here than us.",
    'falsealarm', 'fond', 'about the raccoon', 0.50, 0.82, 0.25, 1,
    { ...DALE_ALIVE, note: 'He is correct, and he does not know how correct.' }),

  // ---- §6.8 Finding evidence --------------------------------------------------------------
  line('ROB_EVID_01', 'robin', "These are sawdust. In June. From what?",
    'evidence', 'analytical', 'crouched, close', 0.40, 0.80, 0.35, 4, { tags: ['searching'] }),
  line('MRG_EVID_01', 'marg', "The hinges are gone. Off the door.",
    'evidence', 'baffled', 'not yet scared', 0.35, 0.80, 0.40, 5,
    { emphasis: 'door', tags: ['searching'] }),
  line('COO_EVID_01', 'coop', "Somebody took the hinges. Who takes hinges.",
    'evidence', 'uneasy', 'trying to make it funny', 0.30, 0.78, 0.45, 5, { tags: ['searching'] }),
  line('ROB_EVID_02', 'robin', "There's a path here. Somebody's worn a path.",
    'evidence', 'cold', 'the moment it becomes real', 0.35, 0.80, 0.45, 5, { tags: ['searching'] }),
  line('BEV_EVID_01', 'bev', "That's not camp lumber. That's milled.",
    'evidence', 'grim', 'recognising work', 0.55, 0.85, 0.25, 5, { tags: ['searching'] }),
  line('TED_EVID_01', 'teddy', "It's Dale's. That's Dale's torch. That's his.",
    'evidence', 'breaking', 'voice going thin', 0.20, 0.78, 0.65, 5, { priority: 0.95 }),
  line('MRG_EVID_02', 'marg', "Don't touch it. Don't — Teddy, don't touch it.",
    'evidence', 'urgent', 'protective', 0.25, 0.80, 0.55, 5, { priority: 0.95 }),
  line('ROB_EVID_03', 'robin', "Somebody's building something out there.",
    'evidence', 'horrified', 'saying it out loud at last', 0.30, 0.80, 0.50, 5,
    { emphasis: 'building', priority: 1.0 }),

  // ---- §6.9 Genuine fear ------------------------------------------------------------------
  line('TED_FEAR_01', 'teddy', "I want to go home. I'm sorry. I want to go home.",
    'fear', 'breaking', 'whispered, no performance', 0.20, 0.78, 0.65, 5, { tags: ['alerted'] }),
  line('ROB_FEAR_01', 'robin', "Okay. Okay. Okay okay okay.",
    'fear', 'managing', 'self-soothing, fast', 0.25, 0.80, 0.55, 5, { tags: ['alerted'] }),
  line('COO_FEAR_01', 'coop', "Marg. Marg, look at me. Look at me.",
    'fear', 'frightened', 'trying to hold her together', 0.25, 0.78, 0.55, 5, { tags: ['alerted'] }),
  line('MRG_FEAR_01', 'marg', "I counted five. There were five of us.",
    'fear', 'numb', 'flat, wrong-sounding', 0.35, 0.80, 0.40, 5, {}),
  line('BEV_FEAR_01', 'bev', "Twenty-two years. Never. Not once.",
    'fear', 'shaken', 'first crack in her', 0.45, 0.85, 0.35, 5, {}),
  line('ROB_FEAR_02', 'robin', "He looks at you sideways. Like a bird.",
    'fear', 'disturbed', 'trying to describe it', 0.30, 0.80, 0.50, 5,
    { priority: 1.0,
      note: 'The head-tilt is his tell — the mask has one usable eyehole. Nobody believes her, '
        + 'because that is not a description of a man, it is a description of a bird.' }),
  line('COO_FEAR_02', 'coop', "I'm not — I can't do a joke. I don't have one.",
    'fear', 'lost', 'genuinely undone', 0.25, 0.78, 0.55, 6, { priority: 0.95 }),
  line('TED_FEAR_02', 'teddy', "Is he still there? Is he still — ",
    'fear', 'terrified', 'cut off by his own breath', 0.20, 0.78, 0.70, 5, { tags: ['alerted'] }),
  line('MRG_FEAR_02', 'marg', "Run to the road. Don't stop at the truck.",
    'fear', 'resolute', 'commander to the last', 0.30, 0.80, 0.50, 5, { tags: ['alerted'] }),
  line('ROB_FEAR_03', 'robin', "It's not a shack. It's a house.",
    'fear', 'stunned', 'the realisation, quiet', 0.35, 0.80, 0.45, 5, { emphasis: 'house', priority: 1.0 }),

  // ---- §6.10 Very late game — Nights 6 and 7 only -----------------------------------------
  line('BEV_LATE_01', 'bev', "County's four hours out. Four hours.",
    'late', 'grim', 'reporting a fact', 0.55, 0.85, 0.25, 6, {}),
  line('BEV_LATE_02', 'bev', "There was a family on this shore. Before us.",
    'late', 'quiet', 'dawning', 0.50, 0.85, 0.30, 6, { beat: 'n6_bev_remembers' }),
  line('BEV_LATE_03', 'bev', "Boy was big. Quiet. Fixed the dock for nothing.",
    'late', 'soft', 'remembering a kindness', 0.50, 0.85, 0.30, 6, { beat: 'n6_bev_remembers' }),
  line('BEV_LATE_04', 'bev', "His name was Ansel V—",
    'late', 'stopped', 'stops herself dead', 0.45, 0.85, 0.35, 6,
    { beat: 'n6_bev_remembers', priority: 1.0,
      note: 'She stops because saying it makes it a real person, and she has spent twenty-two '
        + 'years not doing that. Do not add a breath after the cut. Let the file end.' }),
  line('ROB_LATE_01', 'robin', "There's marks on the door. Pencil. Somebody's kid.",
    'late', 'shaken', 'inside the house, whispering', 0.30, 0.80, 0.50, 6, { beat: 'n6_robin_inside' }),
  line('ROB_LATE_02', 'robin', "Fifty-three. Fifty-five. Fifty-seven.",
    'late', 'hollow', 'reading dates aloud', 0.35, 0.80, 0.40, 6, { beat: 'n6_robin_inside' }),
  line('ROB_LATE_03', 'robin', "Oh. Oh, you poor — ",
    'late', 'pitying', 'cut off, and never finished', 0.25, 0.80, 0.60, 6,
    { priority: 1.0, beat: 'n7_ending_a',
      note: 'Ending A only. The screen does not cut away. She does not finish it.' }),
  line('TED_LATE_01', 'teddy', "The buses come at nine. They're gonna come at nine.",
    'late', 'dazed', 'shock, repeating', 0.25, 0.78, 0.55, 6, {}),
];

/**
 * Role hooks. GAME_DESIGN §4.1/§4.3 names VO ids as `vo_curious_*` and `vo_hm_*`; there is no
 * such bank. Resolve those through here instead — `Campers.js` should call
 * `linesTagged('curious', ctx.state.night)` and pick with `ctx.rand`.
 */
const VO_ROLES = Object.freeze({
  'vo_curious_*': 'curious',     // FSM Curious — a noise hit under 0.35
  'vo_hm_*': 'halfheard',        // detection 0.35–0.75, the half-caught reaction
  'vo_searching_*': 'searching', // FSM Searching
  'vo_alerted_*': 'alerted',     // FSM Alerted / Panic
  'vo_ambient_*': 'ambient',     // Idle, no stimulus
});

/* =========================================================================================
 * 3. STORY BEATS — the registry. NightManager emits `story:beat { id }`.
 *
 * `text` appears ONLY on kind 'card' / 'report'. Everything else has `direction`, which is a
 * note to the implementing agent and MUST NOT BE RENDERED. There is no narrator.
 * ======================================================================================= */

function mkBeat(id, night, kind, opts = {}) {
  return {
    id,
    night,
    kind,
    text: opts.text ?? null,
    voId: opts.voId ?? null,
    voIds: Object.freeze(opts.voIds ?? (opts.voId ? [opts.voId] : [])),
    flagsSet: Object.freeze(opts.flagsSet ?? []),
    requiresFlags: Object.freeze(opts.requiresFlags ?? []),
    once: opts.once ?? true,
    canonical: opts.canonical ?? false,
    direction: opts.direction ?? null,
    panelId: opts.panelId ?? null,
    sfx: opts.sfx ?? null,
    note: opts.note ?? null,
  };
}

const BEAT_LIST = [
  // ---- NIGHT ONE -------------------------------------------------------------------------
  mkBeat('n1_open', 1, 'card', {
    text: 'NIGHT ONE — FOUNDATION (A)',
    direction:
      'Black. One `audio:sfx { id:"crate_settle" }` and nothing answers it. Then wind in pines and '
      + 'a single camper laugh 140 m NE. Fade up over 3 s onto your own hands, which are enormous, '
      + 'holding a folded paper. Card holds 2.4 s, flat white, one #d92b2b rule, no music.',
  }),
  mkBeat('n1_first_lift', 1, 'toast', {
    text: '',
    direction:
      'First `build:pickup` of the game. `ui:toast { text:"", icon:"hand", ms:900 }`. No words, '
      + 'ever. Speed drops to 0.82×, the screen tilts 2°, and that is the tutorial.',
  }),
  mkBeat('n1_shim', 1, 'discovery', {
    flagsSet: ['foundShim'],
    direction:
      'The player finds the shim themselves: a 1961 Minnesota licence plate, folded in three, '
      + 'wedged under a stump 30 m east. It fits perfectly. It has always been the shim. It was '
      + 'under the old house too. One clean bell (`hardware_chime`), the manual\'s red outline '
      + 'redraws in black with a tick, and nothing else happens.',
    sfx: 'hardware_chime',
  }),
  mkBeat('n1_first_creak', 1, 'escalation', {
    direction:
      'The first `build:creak` in the run. A long wet groan like a bad chair — and a loon answers '
      + 'it from across the water, 1.2 s later, on the same fundamental. Pure comedy tonight. It '
      + 'is the last time a creak is funny.',
    note: 'GAME_DESIGN §11 t=4:39 is the make-or-break moment of the whole game.',
  }),
  mkBeat('n1_thumbs_up', 1, 'panel', {
    canonical: true,
    flagsSet: ['sawIntroPanel'],
    panelId: '1.7',
    direction:
      'Closing panel of Night One: the little masked man standing on the finished foundation, both '
      + 'arms up, one small drawn sparkle. Marit\'s hand. Delighted with you.',
  }),

  // ---- NIGHT TWO -------------------------------------------------------------------------
  mkBeat('n2_open', 2, 'card', {
    text: 'NIGHT TWO — UPRIGHTS (B ×4) — SUPPORT WHILE FIXING',
    direction: 'Sub-line: "Two persons recommended." It is a joke tonight. It stops being one on Night Five.',
  }),
  mkBeat('n2_bracket_short', 2, 'panel', {
    panelId: '2.1',
    direction:
      'The parts-list panel shows four brackets H. There are three in the pile. The manual is not '
      + 'lying and it is not sorry. The player will count them three times.',
  }),
  mkBeat('n2_robin_hears', 2, 'sighting', {
    canonical: true,
    flagsSet: ['robinSuspicious'],
    voId: 'ROB_HEAR_01',
    voIds: ['ROB_HEAR_01', 'ROB_HEAR_02', 'ROB_HEAR_03'],
    direction:
      'Robin, alone at the canoe rack, hears a mallet. Four strikes, even, spaced. She stops '
      + 'moving — fully stops, mid-step, for 1.4 s before she speaks. Fire this on the fourth '
      + '`hammer` noise she hears in one seating check, at 60–110 m, unoccluded.',
    note: 'The joke gets a witness.',
  }),
  mkBeat('n2_torch_holds', 2, 'shot', {
    direction:
      'Closing image: her torch beam crawls over the frame at eighty metres, holds on it for a '
      + 'second and a half, and moves on. She does not understand what she is looking at, because '
      + 'it is a house, and there is not supposed to be a house.',
  }),

  // ---- NIGHT THREE -----------------------------------------------------------------------
  mkBeat('n3_open', 3, 'card', {
    text: 'NIGHT THREE — DO NOT OVERTIGHTEN',
    direction: 'Sub-line: "Damage caused this way is not covered."',
  }),
  mkBeat('n3_ridge_long', 3, 'discovery', {
    direction:
      'Nothing is missing tonight. The ridge beam is 340 mm too long. The handsaw is in the tool '
      + 'roll and has been the whole time. He hates using it: it is loud and it dulls.',
  }),
  mkBeat('n3_first_cut', 3, 'escalation', {
    direction:
      'First `noise:emit { kind:"saw", radius:90 }`. Continuous. You cannot rush a saw. The monster '
      + 'is hostage to the physics of a saw. Break it into passes between patrols.',
  }),
  mkBeat('n3_not_believed', 3, 'sighting', {
    canonical: true,
    flagsSet: ['robinDismissed'],
    voId: 'BEV_ARG_02',
    voIds: ['ROB_ARG_01', 'BEV_ARG_02', 'DAL_ARG_01', 'ROB_ARG_02'],
    direction:
      'Robin tells Bev about the mallet. Bev tells her sound carries across the water from the '
      + 'state campground, six kilometres, happens every year. Bev is not being dismissive. Bev is '
      + 'being correct about a thing that is usually true. Play at 90–140 m, occluded, so the '
      + 'player catches maybe half of it.',
    note: 'The first cruelty in the script is committed by the campers, gently, to each other.',
  }),
  mkBeat('n3_ember', 3, 'shot', {
    direction:
      'Closing image: the ember of Bev\'s cigarette at the treeline, held, unmoving, for eleven '
      + 'seconds — a person standing in the dark deciding whether to walk out and look. She does '
      + 'not. Eleven seconds is the number. Do not shorten it.',
  }),

  // ---- NIGHT FOUR ------------------------------------------------------------------------
  mkBeat('n4_open', 4, 'card', {
    text: 'NIGHT FOUR — IF PARTS ARE MISSING, DO NOT RETURN TO STORE',
    direction: 'Sub-line: "Obtain locally." It is the last joke on a title card for two nights.',
  }),
  mkBeat('n4_hinges', 4, 'discovery', {
    flagsSet: ['stoleHinges'],
    panelId: '4.1',
    direction:
      'There are no hinges in the woods. There are three good brass hinges on the camp boathouse '
      + 'door, ninety metres inside the lit perimeter. The manual has drawn them in situ, on that '
      + 'door, which means the manual knows where the camp is. The door hangs open with an oar '
      + 'propping it for the rest of the game.',
  }),
  mkBeat('n4_knock', 4, 'sighting', {
    direction:
      'Dale walks up the fire road to piss and finds a house that was not there in June. He is not '
      + 'scared. He is confused. He says "…the hell is this, chief" out loud to nobody, and he '
      + 'reaches out and knocks on it, twice, politely, the way you knock on a thing to see if it '
      + 'is real. The knock is a real `noise:emit { kind:"impact" }` on your own wall.',
    note: 'Record the knock line as DAL_N4_KNOCK if the VO budget allows; the beat works silent.',
  }),
  mkBeat('n4_dale', 4, 'kill', {
    canonical: true,
    flagsSet: ['firstBlood'],
    direction:
      'The first kill. Off-camera. A single hard cut to black, no music sting, no scream — only '
      + 'the sound of a hammer set down carefully on wood. Then back. Then he wipes his hands on '
      + 'his thighs, two strokes, palms flat, unhurried, before he touches the manual, and the '
      + 'animation does not change and the timing does not change.',
    note: 'The comedy dies here and does not fully return. All DAL_* VO is dead from this beat on.',
    sfx: 'hammer_set_down',
  }),
  mkBeat('n4_torch_rolls', 4, 'shot', {
    direction:
      'Closing image: Dale\'s torch on the ground, still lit, still rolling in a slow quarter-arc, '
      + 'its beam sweeping across a wall that is plumb, square and true.',
  }),

  // ---- NIGHT FIVE ------------------------------------------------------------------------
  mkBeat('n5_open', 5, 'card', {
    text: 'NIGHT FIVE — THIS STEP REQUIRES TWO PERSONS',
    direction:
      'NO SUB-LINE. There is a joke at the bottom of the first four cards and then there just is '
      + 'not one. The silence where the joke goes does more work than the joke ever did.',
  }),
  mkBeat('n5_panel_slides', 5, 'escalation', {
    direction:
      'The 4.8 m north wall panel, 71 kg. `Physics` refuses the placement and the wall slides. Not '
      + 'a fail state, not a prompt — it simply will not seat. One man cannot do this step.',
  }),
  mkBeat('n5_two_persons', 5, 'panel', {
    canonical: true,
    flagsSet: ['sawSecondFigure'],
    panelId: '5.4',
    direction:
      'The player opens the manual to check a measurement and lands on panel 5.4: the second '
      + 'mascot, erased, redrawn, erased, redrawn smaller, eraser ghosts visible under the final '
      + 'line. Three attempts. No arrows, no numbers, no instruction, and no measurement on the '
      + 'page. Do not linger the camera. Do not score it. Let them close the manual themselves.',
    note: 'Loneliness, delivered as a UI element. This is the night the game stops being about a monster.',
  }),
  mkBeat('n5_rigging', 5, 'escalation', {
    flagsSet: ['riggedCounterweight'],
    direction:
      'The player improvises a counterweight and a lever from the world — Dale\'s canoe, a rope, a '
      + 'stump, a ladder. The solution is ugly. `build:place` fires with `correct:true` for a join '
      + 'the manual never specified: the only time in the game. It is the first thing he has built '
      + 'that his mother did not draw.',
  }),
  mkBeat('n5_hand_on_wall', 5, 'shot', {
    direction:
      'Closing image: the wall stands. He puts one hand flat against it and leaves it there longer '
      + 'than the animation needs. Rain. The other end of the wall is held up by a canoe.',
  }),

  // ---- NIGHT SIX -------------------------------------------------------------------------
  mkBeat('n6_open', 6, 'card', {
    text: 'NIGHT SIX — SOLD SEPARATELY',
    direction: 'Sub-line: "Illustration may differ from product." The last joke the manual ever makes.',
  }),
  mkBeat('n6_phantom_article', 6, 'panel', {
    panelId: '6.5',
    direction:
      'Article 0000-000, with a confident arrow pointing at an empty slot. It is not in the world. '
      + 'It has never been in the world. The game will let the player look for it for as long as '
      + 'they like and will never acknowledge that they are looking.',
  }),
  mkBeat('n6_ruin_anchors', 6, 'discovery', {
    flagsSet: ['foundRuinAnchors'],
    direction:
      'The manual is broken, so the only reliable reference is the ground: the old foundation '
      + 'stones of the Vik house are still under the site and the new house lines up with them '
      + 'exactly. Every pier landed on an old one. To finish the night the player must stop '
      + 'reading and start remembering. The mechanic is the thesis.',
  }),
  mkBeat('n6_robin_inside', 6, 'sighting', {
    canonical: true,
    flagsSet: ['robinSaw'],
    voId: 'ROB_LATE_01',
    voIds: ['ROB_LATE_01', 'ROB_LATE_02'],
    direction:
      'Robin finds the site and goes inside. She is not attacked, because he is on the roof and she '
      + 'is standing in his mother\'s kitchen and he does not know what to do about that. She sees '
      + 'the sink with a rectangle of missing porcelain behind it. She sees the doorframe: four '
      + 'pencil marks, ascending, dated in a woman\'s handwriting, 1953 to 1957. She puts her hand '
      + 'flat on the top one. It is above her head. Give the player no verb during this.',
  }),
  mkBeat('n6_bev_remembers', 6, 'sighting', {
    canonical: true,
    flagsSet: ['bevRemembered'],
    voId: 'BEV_LATE_04',
    voIds: ['BEV_LATE_01', 'BEV_LATE_02', 'BEV_LATE_03', 'BEV_LATE_04'],
    direction:
      'Bev, at the road, in the headlights of her own truck, says the thing she has been circling '
      + 'for three nights — and stops one syllable short of his name. Played at 190 m through '
      + 'trees; the player should catch three words in four. If they catch all of it, it is too loud.',
    note: 'The audience knows everything. Ansel knows nothing. The gap is the horror.',
  }),
  mkBeat('n6_doorframe', 6, 'shot', {
    direction:
      'Closing image: Robin\'s hand on the doorframe, at the height of a boy\'s head in 1957, and a '
      + 'shadow across the window that does not move.',
  }),

  // ---- NIGHT SEVEN -----------------------------------------------------------------------
  mkBeat('n7_open', 7, 'card', {
    text: 'NIGHT SEVEN — SOME ASSEMBLY REQUIRED',
    direction: 'NO SUB-LINE. Second and last time. The player will notice.',
  }),
  mkBeat('n7_blank_spread', 7, 'panel', {
    flagsSet: ['manualBlank'],
    panelId: '7.blank',
    direction:
      'BlueprintUI opens to a blank spread. The wipe animation still plays — 0.9 s, hands on '
      + 'thighs, two strokes — for nothing. By now his hands are split open from a week of cold '
      + 'work and the wipe stops working. He marks a page. He stops. He looks at the mark for a '
      + 'full second and forty frames. Then he turns it anyway.',
    note: 'The only grief the game shows you, and it is over before you are sure it happened.',
  }),
  mkBeat('n7_silence', 7, 'escalation', {
    direction:
      'The house is finished at 03:40 and the rain stops. It is the first time in the game the '
      + 'world is quiet. The floor does not creak anywhere. Seven nights have taught the player '
      + 'what a creak means; the total absence of one is more frightening than any sound the game '
      + 'has made. No HUD, no reticle, no prompts, no objective marker, no creak feedback.',
  }),
  mkBeat('n7_final', 7, 'panel', {
    canonical: true,
    panelId: '7.last',
    direction:
      'The last page: a dotted outline of a small seated figure, in a chair, at a table. '
      + 'Child-sized. Marit\'s hand, 1962, the last page she finished. Above it the parts-list '
      + 'bracket every player knows on sight, and inside the bracket, nothing. The game gives the '
      + 'player exactly one interaction verb: place.',
    note: 'Sets no flag itself. The ending beat that follows sets ending_a | ending_b | ending_c.',
  }),
  mkBeat('n7_ending_a', 7, 'ending', {
    flagsSet: ['ending_a'],
    voId: 'ROB_LATE_03',
    direction:
      'RETURN TO STORE. The player goes and gets Robin from the treeline, where she has been coming '
      + 'back every night. No chase, no struggle scene, no cutaway. Then he opens the manual to '
      + 'confirm the step and the panel updates in real time in his own scratched, doubled hand — '
      + 'and the manual draws a red diagonal across it. The only red mark ever aimed at the player. '
      + 'The mascot is drawn with its arms at its sides. Then the pages go blank. All of them. '
      + 'Including the ones he drew.',
    note: 'Marit never told him to do this. He has been extrapolating for twenty-two years and the '
      + 'page finally says so.',
  }),
  mkBeat('n7_ending_b', 7, 'ending', {
    flagsSet: ['ending_b'],
    direction:
      'DO NOT FORCE. The player walks out and does not come back. The camera holds on the house '
      + 'from the treeline for ninety seconds while the sky greys. Nothing happens. Nothing has '
      + 'ever happened here. Buses at nine.',
    note: 'Bleak, honest and correct — but it is not the true one.',
  }),
  mkBeat('n7_ending_c', 7, 'ending', {
    flagsSet: ['ending_c'],
    direction:
      'SOME ASSEMBLY REQUIRED. There is one part in the world that fits a child-sized dotted '
      + 'outline. The player sits down. There is no prompt; it is available from the moment the '
      + 'house is done, and most players will find it because seven nights have taught them to look '
      + 'for the slot that fits. When he sits, the mask comes off — the camera does not show his '
      + 'face, the mask simply enters the frame, set down on the table, glazed, cracked, two holes '
      + 'too far apart. His hands are on the table and they are ruined. The manual is open beside '
      + 'it, blank, and it stays blank, because she died in 1962 and she never drew what comes '
      + 'after the house is finished. Outside, at 6:15, the first bus turns off the county road. '
      + 'You hear it through the wall, because he built the wall correctly, and a correctly built '
      + 'wall carries sound from a road exactly this way. Kids. A lot of them. Screaming the good '
      + 'way. He does not get up.',
  }),
  mkBeat('n7_last_panel', 7, 'panel', {
    panelId: '7.end',
    direction:
      'Over black, one final diagram in Marit\'s confident single-stroke hand: the finished house '
      + 'in three-quarter elevation, exactly as the player built it, with a tick beside it. In the '
      + 'corner, where the maker\'s mark goes on every page in the game: VIK & SØN. Fade.',
    note: 'Achievement, in the flat-pack voice: "NO PARTS REMAINING."',
  }),

  // ---- GLOBAL / CONDITIONAL --------------------------------------------------------------
  mkBeat('report_delivered', 0, 'escalation', {
    once: false,
    direction:
      'A camper completed the 12 s report at a rally point or the payphone. Camp suspicion +0.40, '
      + 'patrol density +2, camp lights come on. GAME_DESIGN §4.3 / §8.1 rung 3. No music, no card.',
    note: 'The only beat that may fire more than once, and the only one with night 0 that is '
      + 'purely mechanical.',
  }),
  mkBeat('manual_notices', 0, 'panel', {
    direction:
      'The first time the player uses the grab, `Blueprint` adds a small extra figure to the corner '
      + 'of every subsequent sheet: the masked man, standing, with a red slash-circle over a second '
      + 'small figure. It is a safety warning. It is drawn in Marit\'s hand, which is the problem. '
      + 'Nothing comments on it. The game never says killing is wrong. It just quietly adds a page '
      + 'to the manual.',
    panelId: 'x.grab',
  }),
];

const BEATS = Object.create(null);
for (const b of BEAT_LIST) BEATS[b.id] = b;

/* =========================================================================================
 * 4. THE SEVEN NIGHTS — STORY.md §4 (tone, images, beats) fused with GAME_DESIGN.md §7
 *    (durations, stage/slot counts, mechanics, grammars, weather).
 *
 *  camperCount    people physically in the playable woods (STORY's "camper density").
 *  patrolDensity  of those, how many are on a patrol loop — the CAP for GAME_DESIGN §8.1's
 *                 `Campers.patrolDensity = 2 + floor(suspicion * 6)`.
 *  Where the two docs differ (N3, N4, N6) the reconciliation is: STORY counts bodies,
 *  GAME_DESIGN counts patrols. Both numbers are preserved. See each night's `note`.
 * ======================================================================================= */

const NIGHTS = [
  {
    n: 1,
    title: 'NIGHT ONE — FOUNDATION (A)',
    subtitle: 'Check contents before beginning.',
    stage: 'Six stone piers, six sill beams, twenty-four lag bolts. Two-part join, generous snap '
      + 'tolerance, forgiving torque.',
    missingItem: 'One shim. Pier D sits 11 mm low. The manual\'s fix panel is a rectangle with an '
      + 'arrow. It does not care what the rectangle is.',
    manualTone: 'helpful',
    durationSeconds: 540,
    stageCount: 3,
    slotCount: 6,
    shortfallCount: 1,
    shortfallItems: [
      { id: 'mallet', label: 'Mallet', tier: 1, distance: 32, kind: 'tool',
        note: 'GAME_DESIGN §7. The player did not know they were missing it, because they had been '
          + 'using their hands. The joke lands twice.' },
      { id: 'pier_06', label: 'Pier block (6 of 6)', tier: 1, distance: 32, kind: 'part',
        note: 'GAME_DESIGN §11 t=2:05. Five blocks were supplied for six squares.' },
    ],
    newMechanic: 'Carry, place, torque-hold, and the creak as pure comedy.',
    grammar: 'G1',
    camperCount: 1,
    patrolDensity: 1,
    camperRoster: ['dale'],
    weatherProfile: { rain: 0.00, wind: 0.05, fog: 0.15, strikes: 0, maskFloor: 0.00,
      note: 'GAME_DESIGN §7: clear, still. Full moon. Fog authored low so the piers read.' },
    openingImage:
      'Black. Rain has not started. A crate settles somewhere behind you and nothing answers it. '
      + 'Fade up over three seconds onto your own hands, which are enormous, holding a folded paper.',
    closingImage:
      'Rain on six perfectly level piers, a spirit level\'s bubble dead centre, and the manual\'s '
      + 'last panel — the little masked man on the foundation with both arms up.',
    emotionalTurn: 'Competence as comedy. The player laughs at a monster doing homework.',
    whatGoesWrong: 'Nothing. Genuinely nothing. He gets it right.',
    beats: [
      { id: 'n1_open', trigger: { kind: 'night-begin' } },
      { id: 'n1_first_lift', trigger: { kind: 'event', event: 'build:pickup' } },
      { id: 'n1_shim', trigger: { kind: 'event', event: 'tool:found', match: { toolId: 'shim_plate_1961' } } },
      { id: 'n1_first_creak', trigger: { kind: 'event', event: 'build:creak' } },
      { id: 'n1_thumbs_up', trigger: { kind: 'stage-complete', stage: 3 } },
    ],
    note: 'The counselor is 400 m off, drunk, singing half a song and giving up on it twice. His '
      + 'loop cannot reach the plot. This is theatre and it is safe, and the player does not know that.',
  },

  {
    n: 2,
    title: 'NIGHT TWO — UPRIGHTS (B ×4), SUPPORT WHILE FIXING',
    subtitle: 'Two persons recommended.',
    stage: 'Four wall frames, corner brackets, diagonal bracing. Order matters now — brace before '
      + 'you release. Nine floor joists.',
    missingItem: 'Bracket H. Four needed, three in the pile. The parts-list panel shows four, and '
      + 'the player will count them three times.',
    manualTone: 'pedantic',
    durationSeconds: 660,
    stageCount: 3,
    slotCount: 9,
    shortfallCount: 1,
    shortfallItems: [
      { id: 'bracket_H', label: 'L-bracket H (×4)', tier: 2, distance: 85, kind: 'hardware',
        note: 'GAME_DESIGN §7: "4 L-brackets, Tier 2". STORY: the fourth is the gag.' },
    ],
    newMechanic: 'Noise and light. NoiseSystem propagation, camper flashlight cones, crouch, '
      + 'line-of-sight break, throwing a bracket. First `player:spotted` risk.',
    grammar: 'G2',
    camperCount: 3,
    patrolDensity: 2,
    camperRoster: ['dale', 'marg', 'coop', 'robin'],
    weatherProfile: { rain: 0.00, wind: 0.25, fog: 0.25, strikes: 0, maskFloor: 0.00,
      note: 'GAME_DESIGN §7: light wind 0.25. Gusts now trigger build:creak on any join with '
        + 'correct:false. Fog authored.' },
    openingImage:
      'Six piers, dry-topped, exactly where you left them. The chalk has washed off the ground and '
      + 'it does not matter; you know where the squares were.',
    closingImage:
      'Her torch beam crawls over the frame at eighty metres, holds on it for a second and a half, '
      + 'and moves on. She does not understand what she is looking at, because it is a house, and '
      + 'there is not supposed to be a house.',
    emotionalTurn: 'The joke gets a witness.',
    whatGoesWrong: 'The third wall goes up out of plumb by two degrees. It stands. It creaks in wind.',
    beats: [
      { id: 'n2_open', trigger: { kind: 'night-begin' } },
      { id: 'n2_bracket_short', trigger: { kind: 'event', event: 'tool:missing', match: { toolId: 'bracket_H' } } },
      { id: 'n2_robin_hears', trigger: { kind: 'manual' },
        note: 'Fire on the fourth hammer tap Robin hears in one seating check, unoccluded, 60–110 m.' },
      { id: 'n2_torch_holds', trigger: { kind: 'night-complete' } },
    ],
    note: 'Three bodies (Dale, Marg, Coop) unloading a truck by the road; two of them patrol '
      + '(GAME_DESIGN §7: "2 counselors patrolling; first real cone"). Robin is at the canoe rack, '
      + 'alone, and is the beat.',
  },

  {
    n: 3,
    title: 'NIGHT THREE — DO NOT OVERTIGHTEN',
    subtitle: 'Damage caused this way is not covered.',
    stage: 'Roof trusses. Six identical assemblies, each requiring a prop-and-hold while the ridge '
      + 'is pinned. Fourteen wall studs and corner posts.',
    missingItem: 'Nothing is missing. The ridge beam is 340 mm too long. You must cut it. The '
      + 'handsaw is in the tool roll and has been the whole time.',
    manualTone: 'impatient',
    durationSeconds: 780,
    stageCount: 4,
    slotCount: 14,
    shortfallCount: 1,
    shortfallItems: [
      { id: 'gusset_plate', label: 'Gusset plates (×2, drawn but not shown)', tier: 2, distance: 95,
        kind: 'hardware',
        note: 'GAME_DESIGN §7 + G3: the bag icon says 8, the drawing shows 6. Two are behind the '
          + 'visible geometry.' },
    ],
    newMechanic: 'Sustained-noise budgeting; class D hauling; shims; the grab. `suspicion` becomes '
      + 'a persistent camp-wide value that carries into Night Four.',
    grammar: 'G3',
    camperCount: 4,
    patrolDensity: 3,
    camperRoster: ['dale', 'marg', 'coop', 'robin', 'bev'],
    weatherProfile: { rain: 0.40, wind: 0.30, fog: 0.35, strikes: 1, maskFloor: 0.12,
      note: 'GAME_DESIGN §7: first rain 0.4, mask floor 0.12 (= 0.30 × rain). Wind, fog and the '
        + 'single teaching strike are authored — the doc is silent on them.' },
    openingImage:
      'A ridge beam on two sawhorses, longer than the building. The tool roll open on the oilcloth, '
      + 'and the gap where the handsaw goes, now empty.',
    closingImage:
      'The ember of Bev\'s cigarette at the treeline, held, unmoving, for eleven seconds — a person '
      + 'standing in the dark deciding whether to walk out and look. She doesn\'t.',
    emotionalTurn: 'The first cruelty in the script is committed by the campers, gently, to each other.',
    whatGoesWrong: 'Cutting is the loudest sustained noise in the game. You cannot rush a saw. The '
      + 'monster is hostage to the physics of a saw.',
    beats: [
      { id: 'n3_open', trigger: { kind: 'night-begin' } },
      { id: 'n3_ridge_long', trigger: { kind: 'stage-complete', stage: 1 } },
      { id: 'n3_first_cut', trigger: { kind: 'event', event: 'noise:emit', match: { kind: 'saw' } } },
      { id: 'n3_not_believed', trigger: { kind: 'time', at: 0.55 } },
      { id: 'n3_ember', trigger: { kind: 'night-complete' } },
    ],
    note: 'STORY: "Camper density: four. Bev arrives." GAME_DESIGN §7: "3 (2 counselors + 1 kid '
      + 'wanderer)". Four bodies, three of them mobile.',
  },

  {
    n: 4,
    title: 'NIGHT FOUR — IF PARTS ARE MISSING, DO NOT RETURN TO STORE',
    subtitle: 'Obtain locally.',
    stage: 'Subfloor, eighteen sheathing panels, then the door. The door is the first piece that is '
      + 'obviously domestic.',
    missingItem: 'Hinges. There are no hinges in the woods. There are three good brass hinges on '
      + 'the camp boathouse door, ninety metres inside the lit perimeter.',
    manualTone: 'knowing',
    durationSeconds: 900,
    stageCount: 4,
    slotCount: 18,
    shortfallCount: 2,
    shortfallItems: [
      { id: 'hinge_set_brass', label: 'Hinge set, brass (×3)', tier: 3, distance: 95, kind: 'hardware',
        note: 'On the boathouse door. Taking them is permanent: the door hangs open, propped with '
          + 'an oar, for the rest of the game.' },
      { id: 'brace_tool', label: 'Brace and bit', tier: 3, distance: 165, kind: 'tool',
        note: 'GAME_DESIGN §7: mess hall shelf.' },
      { id: 'panel_sheathing_spare', label: 'Sheathing panel', tier: 2, distance: 78, kind: 'part' },
    ],
    newMechanic: 'Infiltration into a lit, occupied space. Stealing an object the campers will '
      + 'notice is gone. Tallow. Panels become cover. First report chase.',
    grammar: 'G4',
    camperCount: 5,
    patrolDensity: 4,
    camperRoster: ['dale', 'marg', 'coop', 'robin', 'bev', 'teddy'],
    weatherProfile: { rain: 0.60, wind: 0.40, fog: 0.45, strikes: 2, maskFloor: 0.18,
      note: 'GAME_DESIGN §7: rain 0.6, wind 0.4. Two strikes authored to teach masking before it '
        + 'becomes mandatory on Night Five.' },
    openingImage:
      'The door leaf, flat on the subfloor, face-up, with three rectangles of bare wood where '
      + 'hinges have never been.',
    closingImage:
      'Dale\'s torch on the ground, still lit, still rolling in a slow quarter-arc, its beam '
      + 'sweeping across a wall that is plumb, square and true.',
    emotionalTurn: 'The comedy dies here and does not fully return. Nights 1–3 have jokes in the '
      + 'ambient VO; Night 4 onward the campers stop being funny on purpose and start being funny '
      + 'by accident, which is unbearable.',
    whatGoesWrong: 'Dale walks up the fire road to piss and finds a house that was not there in '
      + 'June. He is not scared. He is confused. He knocks on it, twice, politely.',
    beats: [
      { id: 'n4_open', trigger: { kind: 'night-begin' } },
      { id: 'n4_hinges', trigger: { kind: 'event', event: 'tool:found', match: { toolId: 'hinge_set_brass' } } },
      { id: 'n4_knock', trigger: { kind: 'proximity', anchor: 'cabin_site', radius: 4, actor: 'dale' } },
      { id: 'n4_dale', trigger: { kind: 'manual' },
        note: 'Fired by NightManager once the knock beat has resolved and the player is within '
          + 'reach. Never a QTE. Never a prompt.' },
      { id: 'n4_torch_rolls', trigger: { kind: 'night-complete' } },
    ],
    note: 'Five bodies, but concentrated. The forest is emptier than it has ever been.',
  },

  {
    n: 5,
    title: 'NIGHT FIVE — THIS STEP REQUIRES TWO PERSONS',
    subtitle: null,
    stage: 'The long north wall panel, 4.8 m, mass 71 kg. Lift, walk, seat, pin. Twenty-two roof '
      + 'trusses and purlins.',
    missingItem: 'A second person. The panel physically cannot be seated by one man; Physics '
      + 'refuses the placement and the wall slides.',
    manualTone: 'complicit',
    durationSeconds: 1020,
    stageCount: 5,
    slotCount: 22,
    shortfallCount: 2,
    shortfallItems: [
      { id: 'truss_pin', label: 'Truss pins (×3)', tier: 3, distance: 150, kind: 'hardware' },
      { id: 'tallow_tin', label: 'Tallow tin', tier: 3, distance: 158, kind: 'consumable' },
    ],
    newMechanic: 'Rigging. Height, ladder and skyline exposure. Felt pads. Thunder masking becomes '
      + 'mandatory: the truss hammering is 6 taps × 8 joins.',
    grammar: 'G5',
    camperCount: 5,
    patrolDensity: 5,
    camperRoster: ['marg', 'coop', 'robin', 'bev', 'teddy'],
    weatherProfile: { rain: 0.70, wind: 0.75, fog: 0.40, strikes: 6, maskFloor: 0.21,
      note: 'GAME_DESIGN §7: storm — wind 0.75, rain 0.7, 6 strikes. The weather that hides you is '
        + 'the weather that makes the cabin talk.' },
    openingImage:
      'The north wall panel lying in the wet grass, 4.8 m of it, the site lit only by the lantern, '
      + 'and one man looking at each end of it in turn.',
    closingImage:
      'The wall stands. He puts one hand flat against it and leaves it there longer than the '
      + 'animation needs. Rain. The other end of the wall is held up by a canoe.',
    emotionalTurn: 'Loneliness, delivered as a UI element. This is the night the game stops being '
      + 'about a monster.',
    whatGoesWrong: 'The player must improvise a counterweight and a lever from the world. The '
      + 'solution is ugly. It is the first thing he builds that his mother did not draw.',
    beats: [
      { id: 'n5_open', trigger: { kind: 'night-begin' } },
      { id: 'n5_panel_slides', trigger: { kind: 'event', event: 'build:place', match: { correct: false } } },
      { id: 'n5_two_persons', trigger: { kind: 'event', event: 'ui:blueprint-open' },
        note: 'Fire on the first manual open AFTER n5_panel_slides. They came to check a '
          + 'measurement. There is no measurement on the page.' },
      { id: 'n5_rigging', trigger: { kind: 'flag', flag: 'riggedCounterweight' } },
      { id: 'n5_hand_on_wall', trigger: { kind: 'night-complete' } },
    ],
    note: 'Five, actively searching in pairs. Nobody goes anywhere alone after Dale.',
  },

  {
    n: 6,
    title: 'NIGHT SIX — SOLD SEPARATELY',
    subtitle: 'Illustration may differ from product.',
    stage: 'Roof battens, shingles, twenty glazing units, the door and hinges, and the interior — a '
      + 'sink, a stove flue, a doorframe.',
    missingItem: 'Article 0000-000. It is not in the world. It has never been in the world. The '
      + 'game will let you look for it for as long as you like.',
    manualTone: 'wrong',
    durationSeconds: 1140,
    stageCount: 5,
    slotCount: 20,
    shortfallCount: 2,
    shortfallItems: [
      { id: 'errata_slip', label: 'Errata slip', tier: 2, distance: 105, kind: 'document',
        note: 'G6. With it, BlueprintUI stamps a red correction over the figure. On `gristle` it '
          + 'may not exist at all.' },
      { id: 'hinge_set', label: 'Hinge set', tier: 3, distance: 170, kind: 'hardware' },
      { id: 'fastener_bag_short', label: 'Fastener bag (short by 3)', tier: 1, distance: 40,
        kind: 'hardware' },
      { id: 'article_0000_000', label: '0000-000', tier: null, distance: null, kind: 'phantom',
        note: 'DOES NOT EXIST. Never spawn it. Never hint it. Never acknowledge the search.' },
    ],
    newMechanic: 'Blueprint unreliability. Correctness is validated against CabinSite ruin anchors '
      + 'instead of the page. The payphone becomes real. The Ranger arrives if you were reported.',
    grammar: 'G6',
    camperCount: 2,
    patrolDensity: 2,
    camperRoster: ['robin', 'coop'],
    camperRosterOffsite: ['marg', 'bev', 'teddy'],
    weatherProfile: { rain: 0.05, wind: 0.20, fog: 0.80, strikes: 0, maskFloor: 0.015,
      note: 'GAME_DESIGN §7: clearing — fog 0.8, wind 0.2. Low masking, high visibility. The '
        + 'scariest night. Rain authored to near-zero to kill the mask floor.' },
    openingImage:
      'Fog to the knee, no rain, no wind. The camp\'s lights are all pointed at the road. The woods '
      + 'behind you are the emptiest they have been in a week.',
    closingImage:
      'Robin\'s hand on the doorframe, at the height of a boy\'s head in 1957, and a shadow across '
      + 'the window that does not move.',
    emotionalTurn: 'The audience knows everything. Ansel knows nothing. The gap is the horror.',
    whatGoesWrong: 'The manual is broken. Steps out of order, a missing step 9, a wall elevation '
      + 'that contradicts the floor plan. The only reliable reference is the ground.',
    beats: [
      { id: 'n6_open', trigger: { kind: 'night-begin' } },
      { id: 'n6_phantom_article', trigger: { kind: 'event', event: 'tool:missing', match: { toolId: 'article_0000_000' } } },
      { id: 'n6_ruin_anchors', trigger: { kind: 'flag', flag: 'foundRuinAnchors' } },
      { id: 'n6_robin_inside', trigger: { kind: 'proximity', anchor: 'cabin_interior', radius: 3, actor: 'robin' } },
      { id: 'n6_bev_remembers', trigger: { kind: 'time', at: 0.72 } },
      { id: 'n6_doorframe', trigger: { kind: 'night-complete' } },
    ],
    note: 'STORY: "Camper density: two." GAME_DESIGN §7: "5 + Ranger (conditional)". Two in the '
      + 'woods; the other three are at the county road waiting on headlights that take four hours. '
      + 'The Ranger spawns only at escalation rung 5.',
  },

  {
    n: 7,
    title: 'NIGHT SEVEN — SOME ASSEMBLY REQUIRED',
    subtitle: null,
    stage: 'Nothing structural remains. Chimney (class E hearth stone, 140 kg), porch, roof cap, '
      + 'and the Chair. The house is finished. It is, by any standard the game has taught you, '
      + 'perfect work.',
    missingItem: 'A person. For six nights the running gag is that you are always one part short. '
      + 'Tonight the missing part is a person.',
    manualTone: 'gone',
    durationSeconds: 1320,
    stageCount: 6,
    slotCount: 28,
    shortfallCount: 3,
    shortfallItems: [
      { id: 'tier3_final', label: 'Tier-3 item', tier: 3, distance: 185, kind: 'hardware' },
      { id: 'errata_slip_final', label: 'Errata slip', tier: 2, distance: 110, kind: 'document' },
      { id: 'fastener_bag_short_3', label: 'Fastener bag, short by 3', tier: 1, distance: 35,
        kind: 'hardware', note: 'Short by 3 rather than absent. GAME_DESIGN §2.5.' },
    ],
    newMechanic: 'Everything is taken away. No HUD, no reticle, no prompts, no objective marker, no '
      + 'creak feedback. `settings.subtitles` still works; nothing speaks.',
    grammar: 'G1+G2+G3+G4+G5+G6+G7',
    camperCount: 7,
    patrolDensity: 7,
    camperRoster: ['robin', 'marg', 'coop', 'bev', 'teddy'],
    weatherProfile: { rain: 0.65, wind: 0.70, fog: 0.50, strikes: 4, calmAt: 0.80, maskFloor: 0.195,
      note: 'GAME_DESIGN §7: breaking storm → dead calm at timeOfNight 0.8. The last 20% has ZERO '
        + 'masking. All four strikes land before calmAt.' },
    openingImage:
      'The house, finished, from the treeline. No scaffolding. No parts on the ground. The rain '
      + 'stops while you are looking at it.',
    closingImage:
      'He sits down in the small chair, at the table, in the finished house, and the game does not '
      + 'tell him to. The mask enters the frame, set down on the table, glazed, cracked, two holes '
      + 'too far apart. Outside, at 6:15, the first bus turns off the county road. Kids. A lot of '
      + 'them. Screaming the good way. He does not get up.',
    emotionalTurn: 'Grief that has been given a task will do the task forever. Stated once, in the '
      + 'story bible, and never in the game.',
    whatGoesWrong: 'Nothing. That is what is wrong.',
    beats: [
      { id: 'n7_open', trigger: { kind: 'night-begin' } },
      { id: 'n7_blank_spread', trigger: { kind: 'event', event: 'ui:blueprint-open' } },
      { id: 'n7_silence', trigger: { kind: 'time', at: 0.80 } },
      { id: 'n7_final', trigger: { kind: 'stage-complete', stage: 6 } },
      { id: 'n7_ending_a', trigger: { kind: 'manual' }, optional: true },
      { id: 'n7_ending_b', trigger: { kind: 'manual' }, optional: true },
      { id: 'n7_ending_c', trigger: { kind: 'manual' }, optional: true },
      { id: 'n7_last_panel', trigger: { kind: 'manual' } },
    ],
    note: 'GAME_DESIGN §7 rosters 7 + head counselor + Ranger for the build. STORY §4: "Camper '
      + 'density: one. Then none." — once the house is finished and n7_silence has fired, despawn '
      + 'everyone except Robin at the treeline, then her too unless the player goes to get her.',
  },
];

/* =========================================================================================
 * 5. ENVIRONMENTAL STORYTELLING — STORY.md §7, all twenty objects.
 *
 * COORDINATE FRAME (advisory — `Props.js` / `CabinSite.js` own final placement; snap y to the
 * heightfield): origin = the cabin site datum. +X east, −Z north (Three.js: −Z is forward).
 * The lake and the point are north. The camp core (mess hall, office, cabins, archery) is
 * south-east at Tier-3 range. The boathouse is east on the water. The fire road runs east at
 * z ≈ +38 to the county road. The ridge is south-west.
 *
 * STORY §7 IS EXPLICIT: every one of these is INERT. No pickup prompt, no lore entry, no audio
 * sting. If a player never notices one, that is fine. That is the point. `interactText` is
 * therefore null on 17 of the 20. Where it is the empty string, the prompt is ICON ONLY.
 * ======================================================================================= */

function prop(id, name, x, z, night, meaning, opts = {}) {
  return {
    id,
    name,
    position: { x, z },
    night,
    meaning,
    interactText: opts.interactText ?? null,
    interactIcon: opts.interactIcon ?? null,
    replay: opts.replay ?? null,
    positionByNight: opts.positionByNight ?? null,
    inert: opts.interactText == null,
    owner: opts.owner ?? 'Props',
    note: opts.note ?? null,
  };
}

const PROPS = [
  prop('shim_plate_1961', 'The 1961 Minnesota licence plate, folded in three', 30.4, -2.8, 1,
    'Somebody levelled something here before.',
    { replay: 'It was under the original house. He kept it.',
      interactText: '', interactIcon: 'hand', owner: 'CabinSite',
      note: 'The one story-critical pickup in §7. Fires beat n1_shim and flag foundShim. Icon-only '
        + 'toast, no words, per GAME_DESIGN §2.5.' }),
  prop('ruin_stones', 'A ring of foundation stones, black at the edges', 0, 0, 1,
    'A fire.',
    { replay: 'He is building exactly on the footprint. Every pier lands on an old one.',
      owner: 'CabinSite',
      note: 'Visible ONLY when the lantern rakes across at a low angle. Never highlight. On Night '
        + 'Six these become the correctness reference (flag foundRuinAnchors).' }),
  prop('porcelain_sink', 'A cracked porcelain sink propped against a birch', -38.0, -46.0, 1,
    'Salvage. Somebody carried this here and set it down carefully.',
    { replay: 'The rectangular section missing from its splash-back is on his face.' }),
  prop('childs_boot', "A child's boot, size 3, hung on a nail at head height", 46.0, 38.0, 1,
    'Not dropped — hung. Deliberately. Years ago.',
    { replay: 'It is his own.' }),
  prop('tool_roll', 'A tool roll spread flat under an oilcloth, tools in descending size', -3.2, 4.6, 1,
    'Order. Each tool in its own stitched pocket, a gap where the handsaw goes.',
    { replay: 'One pocket is too small for anything he owns. A child\'s hammer used to live there.',
      owner: 'CabinSite' }),
  prop('survey_stakes', 'Fifty-one wooden survey stakes in a perfect grid', 0, 0, 1,
    'Planning. Each numbered in carpenter\'s pencil.',
    { replay: 'He surveyed this before the campers came. The numbering starts at 1953.',
      owner: 'CabinSite', note: 'Grid extent ≈ 18 × 14 m across the plot. Numbers 1953…2003.' }),
  prop('ruined_pages_tin', 'A stack of ruined manual pages in a tin under a rock', -12.5, 9.0, 2,
    'Weighted. Dry. Twelve attempts at the same panel, each worse than the last.',
    { replay: 'He has been trying to draw his mother\'s hand, and failing, since long before Night One.' }),
  prop('carpenters_pencil', 'A carpenter\'s pencil sharpened to 8 mm', -2.6, 3.9, 1,
    'Nothing, on first look.',
    { replay: 'It is replaced every night with an identical one. He has been here for weeks.',
      owner: 'CabinSite' }),
  prop('survey_marker', 'The Wanaka Pines Land Company survey marker, 1962, brass', 58.0, 22.0, 1,
    'A property line, and a company that condemned a house.',
    { replay: 'It is polished bright by something rubbing it. He cleans it. Every night.' }),
  prop('bev_ashtray', "Bev's ashtray on the office porch — a hubcap, forty butts", 138.0, 88.0, 3,
    'A woman who sits in the same chair every night, all crushed the same direction.',
    { replay: 'The chair faces the point where the house used to be.' }),
  prop('boathouse_door', 'The boathouse door, hinges gone, propped with an oar', 70.0, -25.0, 4,
    'The camp is losing.',
    { replay: 'Never fixed. It stays open for the rest of the game.',
      interactText: '', interactIcon: 'hand',
      note: 'Interactive on Night Four only — taking the hinges sets flag stoleHinges. Inert after.' }),
  prop('dales_torch', "Dale's torch, still lit, battery dying, beam browning", 41.0, 29.0, 5,
    'A man put this down and did not pick it up.',
    { replay: 'On Night Seven it is off, and it has been moved eleven metres — toward the house — '
      + 'and set down neatly.',
      positionByNight: { 7: { x: 32.4, z: 24.1 } } }),
  prop('crushed_canoe', 'A canoe, upside down, one gunwale crushed under a wall panel', -4.8, -3.1, 5,
    'Improvisation.',
    { replay: "It is Dale's canoe. He is holding up the wall.", owner: 'CabinSite' }),
  prop('rock_floorplan', 'A hand-drawn floor plan carved into a rock face near the ridge', -74.0, 63.0, 1,
    'Weathered. At least a decade old.',
    { replay: 'He has drawn this house in a dozen places over twenty years and never built it until now.' }),
  prop('swing_seat', 'A rusted swing seat hanging from one chain', 92.0, 58.0, 1,
    "Somebody's yard. The tree is now inside the archery range.",
    { replay: 'His.' }),
  prop('photo_board', 'A camp photo board — twenty-two summers of group photos', 152.0, 96.0, 1,
    'Institutional memory, framed and dusted.',
    { replay: 'In 1971, at the back edge of the frame, out of focus, a very large man at the '
      + 'treeline with his head tilted.',
      note: 'Tier 3, inside the mess hall. The head-tilt is the tell. This is how the player '
        + 'recognises him in a photograph on Night Six.' }),
  prop('grave', 'A grave, unmarked, small, well-kept, with the grass cut by hand', -22.5, 33.0, 1,
    'Somebody buried something and comes back.',
    { replay: 'Marit. He mows it.' }),
  prop('birch_marks', 'Four pencil notches on a birch trunk at 91, 108, 124 and 141 cm', -9.4, -14.2, 1,
    'Somebody measured a child against a tree.',
    { replay: 'Matches the doorframe inside the finished house exactly. 1953, 1955, 1955, 1957.' }),
  prop('blanket_and_cup', 'A folded blanket and a tin cup on a stump, arranged for a second person',
    2.9, 5.4, 1,
    'Dry, brushed off, refreshed nightly.',
    { replay: 'Nobody ever sits there.', owner: 'CabinSite' }),
  prop('two_chairs', 'Two chairs, hand-made, identical, inside the finished house', 0.6, -1.2, 7,
    'One is adult-sized. One is not.',
    { replay: 'The small one is the last slot in the game.',
      interactText: '', interactIcon: 'chair', owner: 'CabinSite',
      note: 'THE ONLY VERB ON NIGHT SEVEN IS "PLACE". There is no prompt on the small chair. Most '
        + 'players will find it because seven nights have taught them to look for the slot that fits.' }),
];

/* =========================================================================================
 * 6. MANUAL PANELS — STORY.md §3, transcribed. Panels marked `authored:true` are not in
 *    STORY.md; they were written here in the doc's voice to fill the sheet.
 *
 *  ⚠ `caption` DESCRIBES LINE ART FOR THE RENDERER. IT IS NEVER PRINTED ON THE PAGE.
 *    The only text on any page is the article number and, on the cover, the word HJEM.
 * ======================================================================================= */

export const PANEL_RULES = Object.freeze({
  renderCaptionsAsText: false,
  onlyTextInManual: ['article numbers', 'HJEM (cover only)', "VIK & SØN (maker's mark, corner)"],
  wipeLockoutMs: 900,
  wipeSkippable: false,
  paper: '#f4f2ed',
  ink: '#111111',
  accent: '#d92b2b',
  accentColorblind: { deuteranopia: '#0b57d0', protanopia: '#0b57d0', tritanopia: '#c2185b' },
  redundantEncoding: 'Every red mark also carries a 1.5 pt dashed stroke and a corner tick. '
    + 'Colour is never the only channel.',
});

function panel(id, night, authorship, caption, opts = {}) {
  return {
    id,
    night,
    authorship,                       // 'marit' | 'ansel'
    caption,                          // developer-facing description of the drawing. NEVER PRINTED.
    annotation: opts.annotation ?? null,
    glyphs: Object.freeze(opts.glyphs ?? []),
    articleNo: opts.articleNo ?? null,
    red: opts.red ?? false,
    step: opts.step ?? null,
    stage: opts.stage ?? null,
    authored: opts.authored ?? false,
    note: opts.note ?? null,
  };
}

const PANELS = {
  1: {
    night: 1,
    tone: 'helpful',
    cover: { word: 'HJEM', articleNo: '1962-001', makersMark: 'VIK & SØN', authorship: 'marit' },
    panels: [
      panel('1.1', 1, 'marit', 'The mascot waving, both hands, from the corner of the page.',
        { glyphs: ['mascot'], step: 1, stage: 1, articleNo: '1949-001',
          annotation: 'Warm. Over-explains. Delighted with you.' }),
      panel('1.2', 1, 'marit', 'The parts-list bracket: six pier blocks, six sill beams, one bag '
        + 'icon reading twenty-four.',
        { glyphs: ['parts-bracket', 'bag-count'], step: 2, stage: 1, articleNo: '1962-006', authored: true }),
      panel('1.3', 1, 'marit', 'A pier block descending into a chalked square on the ground. One '
        + 'straight arrow. The square in the drawing is the square on the ground.',
        { glyphs: ['arrow-straight', 'circle-number'], step: 3, stage: 1, articleNo: '1962-006',
          authored: true, note: 'G1 in one picture. GAME_DESIGN §11 t=0:09.' }),
      panel('1.4', 1, 'marit', 'A bolt going into a hole. Then the same bolt, larger. Then the same '
        + 'bolt again with a magnifying glass over it, in case you missed the bolt.',
        { glyphs: ['arrow-straight', 'magnifier'], step: 4, stage: 2, articleNo: '1957-024' }),
      panel('1.5', 1, 'marit', 'The mascot standing beside a pier for scale. No dimension is printed. '
        + 'The mascot is 1.7 m, which is the player\'s own eye height.',
        { glyphs: ['mascot'], step: 5, stage: 2, articleNo: '1953-006', authored: true }),
      panel('1.6', 1, 'marit', 'The fix panel: a rectangle, and an arrow pointing it under the low '
        + 'pier. It does not care what the rectangle is.',
        { glyphs: ['arrow-straight', 'circle-number-dashed'], step: 6, stage: 2, articleNo: '1961-001',
          authored: true, note: 'Pier D sits 11 mm low. The rectangle is a folded licence plate.' }),
      panel('1.7', 1, 'marit', 'The mascot standing on the finished pier, arms up, one small drawn sparkle.',
        { glyphs: ['mascot', 'sparkle', 'tick'], step: 7, stage: 3, articleNo: '1962-006' }),
    ],
  },

  2: {
    night: 2,
    tone: 'pedantic',
    cover: { word: 'HJEM', articleNo: '1962-002', makersMark: 'VIK & SØN', authorship: 'marit' },
    panels: [
      panel('2.1', 2, 'marit', 'The parts-list bracket showing four brackets H. Four. Drawn evenly, '
        + 'spaced evenly, counted for you.',
        { glyphs: ['parts-bracket', 'bag-count'], step: 1, stage: 1, articleNo: '1955-004',
          authored: true, note: 'There are three in the pile. The manual is not lying and it is not sorry.' }),
      panel('2.3', 2, 'marit', 'A bracket at 90°, ticked. The same bracket at 88°, crossed out in '
        + 'red. The same bracket at 89.5°, also crossed out in red.',
        { glyphs: ['tick', 'red-slash-circle', 'arrow-curved'], red: true, step: 3, stage: 1,
          articleNo: '1955-004' }),
      panel('2.4', 2, 'marit', 'The left wall assembly only, with the mirror glyph over a dashed '
        + 'axis. The right assembly is its reflection and the bracket handedness flips.',
        { glyphs: ['mirror', 'dotted-outline'], step: 4, stage: 2, articleNo: '1955-108',
          authored: true, note: 'G2. Getting this wrong makes every join of the mirrored half Rotated.' }),
      panel('2.6', 2, 'marit', 'A hand tightening a bolt, with an arrow labelled by a small dial. A '
        + 'second panel: the same hand, over-tightened, and the mascot with one flat line for a mouth.',
        { glyphs: ['arrow-curved', 'mascot', 'red-exclamation-triangle'], red: true, step: 6, stage: 2,
          articleNo: '1957-024',
          note: 'The mascot has never had a mouth before. He does not have one again for three nights.' }),
      panel('2.7', 2, 'marit', 'Brace before you release: a diagonal brace, a circled 3, then a '
        + 'circled 4, drawn in that order and not in that position.',
        { glyphs: ['circle-number', 'arrow-straight'], step: 7, stage: 3, articleNo: '1953-091',
          authored: true }),
    ],
  },

  3: {
    night: 3,
    tone: 'impatient',
    cover: { word: 'HJEM', articleNo: '1962-003', makersMark: 'VIK & SØN', authorship: 'marit' },
    panels: [
      panel('3.2', 3, 'marit', 'Eleven sub-assemblies collapsed into one drawing with fourteen '
        + 'arrows and no intermediate states. Good luck.',
        { glyphs: ['arrow-straight', 'circle-number'], step: 2, stage: 1, articleNo: '1955-014' }),
      panel('3.4', 3, 'marit', 'The ridge beam with a single cut line across it and no dimension '
        + 'printed. The saw is drawn once, small, in the corner, held by nobody.',
        { glyphs: ['arrow-straight'], step: 4, stage: 2, articleNo: '1953-340', authored: true,
          note: '340 mm too long. The saw has been in the tool roll the whole time.' }),
      panel('3.5', 3, 'marit', 'An entire step rendered as a single downward arrow and the number ×6.',
        { glyphs: ['arrow-straight', 'circle-number'], step: 5, stage: 2, articleNo: '1955-006' }),
      panel('3.6', 3, 'marit', 'The bag icon says eight gussets. The drawing shows six. Two are '
        + 'behind the visible geometry and the manual assumes you can see that.',
        { glyphs: ['bag-count', 'dotted-outline'], step: 6, stage: 3, articleNo: '1955-008',
          authored: true, note: 'G3.' }),
      panel('3.8', 3, 'ansel', 'The mascot, arms folded, tapping one foot — drawn with motion ticks. '
        + 'It is waiting for you.',
        { glyphs: ['mascot', 'motion-ticks'], step: 8, stage: 4, articleNo: '1957-141',
          note: 'The first time the manual is a presence and not a document. First panel in Ansel\'s '
            + 'hand — doubled lines, over-corrected corners, mascot drawn taller, shoulders square, '
            + 'no lean. The player will not consciously notice.' }),
    ],
  },

  4: {
    night: 4,
    tone: 'knowing',
    cover: { word: 'HJEM', articleNo: '1962-004', makersMark: 'VIK & SØN', authorship: 'marit' },
    panels: [
      panel('4.1', 4, 'marit', 'The hinge you need, drawn in isolation. Then drawn in situ — screwed '
        + 'to the camp boathouse door.',
        { glyphs: ['arrow-straight', 'dotted-outline'], step: 1, stage: 1, articleNo: '1962-003',
          note: 'The manual knows where the camp is.' }),
      panel('4.3', 4, 'marit', 'Two beams that differ only in length, side by side, with no '
        + 'dimensions. The mascot stands between them and is the only scale reference.',
        { glyphs: ['mascot', 'dotted-outline'], step: 3, stage: 2, articleNo: '1953-032',
          authored: true, note: 'G4. 3.2 m vs 2.6 m. The wrong one seats and the far end floats.' }),
      panel('4.6', 4, 'ansel', 'A cone of light on the ground. The mascot outside the cone. A dotted path.',
        { glyphs: ['mascot', 'dotted-outline', 'arrow-curved'], step: 6, stage: 3, articleNo: '1984-110',
          note: 'The first panel that is about them and not about the house.' }),
      panel('4.9', 4, 'ansel', 'The mascot standing over a horizontal shape. The shape is not a '
        + 'joist. It has shoes.',
        { glyphs: ['mascot'], step: 9, stage: 4, articleNo: '1984-001',
          note: 'The player will not consciously notice. Do not linger the layout on it. Do not '
            + 'centre it. It is the fourth panel down on the right-hand page.' }),
    ],
  },

  5: {
    night: 5,
    tone: 'complicit',
    cover: { word: 'HJEM', articleNo: '1962-005', makersMark: 'VIK & SØN', authorship: 'marit' },
    panels: [
      panel('5.1', 5, 'marit', 'The standard flat-pack warning icon — THIS STEP REQUIRES TWO PERSONS '
        + '— two mascots, one at each end of a wall panel.',
        { glyphs: ['mascot', 'mascot-hand-raised', 'red-exclamation-triangle'], red: true, step: 1,
          stage: 1, articleNo: '1962-071',
          note: 'Both drawn in Marit\'s hand. Both drawn twenty-two years ago.' }),
      panel('5.3', 5, 'marit', 'Sequence dependency: step 7 drawn top-left, step 2 bottom-right. A '
        + 'panel installed early blocks arm access to the bracket behind it.',
        { glyphs: ['circle-number', 'arrow-straight'], step: 3, stage: 2, articleNo: '1955-022',
          authored: true, note: 'G5. Recovering costs an 8 s loud build:remove.' }),
      panel('5.4', 5, 'ansel', 'The second mascot: erased, redrawn, erased, redrawn smaller. The '
        + 'eraser ghosts are visible under the final line. Three attempts.',
        { glyphs: ['mascot', 'eraser-ghost'], step: 4, stage: 3, articleNo: null,
          note: 'This panel has no arrows, no numbers, no article number and no instruction. It '
            + 'should not be in a manual at all. The player will open the manual to check a '
            + 'measurement, land on it, and there will be no measurement on the page.' }),
      panel('5.7', 5, 'ansel', 'A counterweight diagram. The counterweight is a rectangle with a '
        + 'number on it. The number is a weight in kilograms. It is 71.',
        { glyphs: ['arrow-curved', 'circle-number'], step: 7, stage: 4, articleNo: '1962-071' }),
    ],
  },

  6: {
    night: 6,
    tone: 'wrong',
    cover: { word: 'HJEM', articleNo: '1962-006', makersMark: 'VIK & SØN', authorship: 'ansel',
      note: 'Traced. The slash through the Ø leans the wrong way.' },
    panels: [
      panel('6.2', 6, 'ansel', 'Step 14 before step 9. Step 9 does not appear.',
        { glyphs: ['circle-number'], step: 14, stage: 1, articleNo: '1955-014' }),
      panel('6.5', 6, 'ansel', 'A confident arrow pointing at an empty slot, and an article number '
        + 'that does not exist and cannot be found.',
        { glyphs: ['arrow-straight', 'parts-bracket'], step: 5, stage: 2, articleNo: '0000-000',
          note: 'The player will search for twenty minutes. It is not out there. Never hint it. '
            + 'Never acknowledge the search.' }),
      panel('6.6', 6, 'ansel', 'The step the errata slip corrects. Without the slip it builds to a '
        + 'join that can never exceed w = 0.35; with it, a red correction stamps over the figure.',
        { glyphs: ['red-slash-circle', 'circle-number'], red: true, step: 6, stage: 3,
          articleNo: '1957-018', authored: true, note: 'G6. The manual is confidently, serenely incorrect.' }),
      panel('6.8', 6, 'ansel', 'A wall elevation in perfect Marit line — a kitchen, a window over a '
        + 'sink, pencil marks on a doorframe at four ascending heights — and drawn over the top of '
        + 'it in a scratched hand, a bunk bed. The bunk is erased. The ghost stays.',
        { glyphs: ['eraser-ghost', 'dotted-outline'], step: 8, stage: 4, articleNo: '1957-141',
          note: 'He is trying to make his mother\'s house fit a camp. It doesn\'t.' }),
      panel('6.9', 6, 'ansel', 'The mascot, alone, in the middle of an otherwise empty page. Not '
        + 'doing anything.',
        { glyphs: ['mascot'], step: 9, stage: 5, articleNo: null }),
      panel('x.grab', 0, 'marit', 'A small extra figure in the corner of every sheet: the masked '
        + 'man, standing, with a red slash-circle over a second small figure. It is a safety warning.',
        { glyphs: ['mascot', 'red-slash-circle'], red: true, authored: true,
          note: 'Added from the stage after the player\'s first grab, on every night thereafter. '
            + 'Nothing comments on it. GAME_DESIGN §8.3.' }),
    ],
  },

  7: {
    night: 7,
    tone: 'gone',
    cover: { word: 'HJEM', articleNo: null, makersMark: 'VIK & SØN', authorship: 'marit',
      note: 'The cover is unchanged. Everything inside it is not.' },
    panels: [
      panel('7.blank', 7, 'marit', 'A blank spread. Both pages. No rule, no number, no mascot. The '
        + 'wipe animation still plays before it.',
        { glyphs: [], articleNo: null, stage: 1 }),
      panel('7.last', 7, 'marit', 'One mark on the final page: a dotted outline of a small seated '
        + 'figure, in a chair, at a table. Child-sized. Above it, the parts-list bracket, and '
        + 'inside the bracket, nothing.',
        { glyphs: ['dotted-outline', 'parts-bracket'], articleNo: null, stage: 6,
          note: 'Drawn in Marit\'s hand, in 1962, on the last page she finished. SOME ASSEMBLY REQUIRED.' }),
      panel('7.errata_a', 7, 'ansel', 'ENDING A ONLY: the step redraws in real time in a scratched, '
        + 'doubled hand, and then a red diagonal is drawn across it. The mascot has its arms at its sides.',
        { glyphs: ['mascot', 'red-slash-circle'], red: true, articleNo: null,
          note: 'The only red mark ever aimed at the player. The only judgement the manual has ever '
            + 'passed. Then every page goes blank, including the ones he drew.' }),
      panel('7.end', 7, 'marit', 'Over black: the finished house in three-quarter elevation, exactly '
        + 'as the player built it, with a tick beside it. In the corner, the maker\'s mark.',
        { glyphs: ['tick', 'makers-mark'], articleNo: '1962-001',
          note: 'VIK & SØN. Confident single stroke. Fade.' }),
    ],
  },
};

/* =========================================================================================
 * 7. THE MANUAL'S VOICE — the evolving personality, per night, for BlueprintUI.
 *
 * `linework.ansel` is the fraction of panels drawn in his hand — the actual arc of the story.
 * STORY §3: "By Night Five roughly a third of the panels are his. By Night Six, most."
 * ======================================================================================= */

const MANUAL_VOICE = {
  1: {
    night: 1, tone: 'helpful',
    mascot: { state: 'waving, both hands, from the corner of the page', mouth: false, lean: 'forward, listening', shoulders: 'rounded', heightScale: 1.00 },
    annotations: 'Over-explains. Draws the same bolt three times, the last time under a magnifying glass.',
    linework: { marit: 1.00, ansel: 0.00, jitter: 0.000, doubleStroke: 0.00, eraserGhosts: 0.00, strokeWeight: 1.00 },
    red: 'None. Nothing is forbidden yet.',
    instruction: 'Draw it warm. Even weight, closed corners, single confident stroke. The page is '
      + 'pleased with the reader. Nothing on this spread is ironic; the irony is that a monster is '
      + 'holding it.',
  },
  2: {
    night: 2, tone: 'pedantic',
    mascot: { state: 'present, correcting; acquires a mouth for exactly one panel', mouth: 'one flat line, panel 2.6 only', lean: 'forward, listening', shoulders: 'rounded', heightScale: 1.00 },
    annotations: 'Crosses out 88°. Also crosses out 89.5°. It has decided you are competent and now it is fussy.',
    linework: { marit: 1.00, ansel: 0.00, jitter: 0.000, doubleStroke: 0.00, eraserGhosts: 0.00, strokeWeight: 1.00 },
    red: 'First red. Used only on forbidden variants — and the forbidden variant is the one that looks correct.',
    instruction: 'Tighten everything. Tick marks get smaller and more numerous. The mouth in 2.6 is '
      + 'a single 1 pt horizontal line, 9 px long, and it is the funniest thing in the game. Do not '
      + 'animate it. Do not draw it again for three nights.',
  },
  3: {
    night: 3, tone: 'impatient',
    mascot: { state: 'arms folded, tapping one foot, drawn with motion ticks', mouth: false, lean: 'none', shoulders: 'square', heightScale: 1.04 },
    annotations: 'Steps get combined. It skips things. An entire step becomes one arrow and ×6.',
    linework: { marit: 0.92, ansel: 0.08, jitter: 0.010, doubleStroke: 0.05, eraserGhosts: 0.01, strokeWeight: 1.02 },
    red: 'Sparing. One over-torque triangle.',
    instruction: 'The first panel in Ansel\'s hand appears tonight (3.8) and the player must not '
      + 'consciously notice. Give it doubled-back lines, over-corrected corners, and a mascot 4% '
      + 'taller with square shoulders and no lean. The manual becomes a presence and not a document.',
  },
  4: {
    night: 4, tone: 'knowing',
    mascot: { state: 'outside a cone of light, on a dotted path; then standing over a horizontal shape', mouth: false, lean: 'none', shoulders: 'square', heightScale: 1.06 },
    annotations: 'It begins illustrating things it should not know about. It draws the camp.',
    linework: { marit: 0.82, ansel: 0.18, jitter: 0.018, doubleStroke: 0.10, eraserGhosts: 0.02, strokeWeight: 1.03 },
    red: 'Unchanged. The manual passes no judgement tonight, which is the point.',
    instruction: 'Nothing about the drawing style should announce the turn. The horror is entirely '
      + 'in subject matter: a hinge in situ on a real door, a light cone with a figure avoiding it, '
      + 'and a horizontal shape with shoes. Lay 4.9 out as an ordinary fourth panel. No zoom, no '
      + 'hold, no sound cue.',
  },
  5: {
    night: 5, tone: 'complicit',
    mascot: { state: 'two of them — one at each end of a wall panel; then one of them erased three times', mouth: false, lean: 'forward, listening (Marit) / none (Ansel)', shoulders: 'rounded (Marit) / square (Ansel)', heightScale: 1.06 },
    annotations: 'It stops pretending this is only carpentry. Panel 5.4 has no instruction on it at all.',
    linework: { marit: 0.67, ansel: 0.33, jitter: 0.024, doubleStroke: 0.16, eraserGhosts: 0.28, strokeWeight: 1.05 },
    red: 'The two-persons warning triangle. Standard flat-pack iconography, used honestly, which is worse.',
    instruction: 'Eraser ghosts are the whole night: render them at 12–18% ink under the final line, '
      + 'three passes on 5.4, each one smaller. Do not fade them in. They were always there. Do not '
      + 'score this panel, do not lock input, do not slow time. Let the player close the manual '
      + 'themselves.',
  },
  6: {
    night: 6, tone: 'wrong',
    mascot: { state: 'alone, in the middle of an otherwise empty page, not doing anything', mouth: false, lean: 'none', shoulders: 'square', heightScale: 1.08 },
    annotations: 'Steps out of order. A missing step 9. An article number that does not exist. A '
      + 'wall elevation that contradicts the floor plan.',
    linework: { marit: 0.28, ansel: 0.72, jitter: 0.034, doubleStroke: 0.26, eraserGhosts: 0.40, strokeWeight: 1.08 },
    red: 'The errata correction, if the player found the slip. Otherwise none.',
    instruction: 'Not sinister-wrong. BROKEN-wrong, which is worse. The page should look like '
      + 'someone competent is failing. Keep the layout immaculate — margins, gutters and numbering '
      + 'all still perfect — and let the content be the thing that has come apart. The maker\'s '
      + 'mark is now traced: the slash through the Ø leans the wrong way.',
  },
  7: {
    night: 7, tone: 'gone',
    mascot: { state: 'absent, except as a dotted child-sized outline in a chair', mouth: false, lean: null, shoulders: null, heightScale: null },
    annotations: 'None. There is exactly one mark on the final page.',
    linework: { marit: 1.00, ansel: 0.00, jitter: 0.000, doubleStroke: 0.00, eraserGhosts: 0.00, strokeWeight: 1.00 },
    red: 'None — unless the player takes Ending A, and then one diagonal, once, aimed at them.',
    instruction: 'BlueprintUI opens to a blank spread and the 0.9 s wipe animation still plays. Do '
      + 'not add a "no content" state, an empty-state icon, or a fade. It is paper and it is blank. '
      + 'The last page carries a dotted outline and an empty parts-list bracket in Marit\'s 1962 '
      + 'line — the last page she finished. His hands are split open by now; if he marks a page, '
      + 'hold on the mark for one second and forty frames, then turn it anyway.',
  },
};

/* =========================================================================================
 * 8. TITLE CARDS — STORY.md §9. Rendered at `night:begin`, 2.4 s, no music.
 *    Thin black Helvetica-alike on flat white, one #d92b2b accent rule.
 * ======================================================================================= */

const TITLE_CARDS = {
  1: { night: 1, line1: 'NIGHT ONE', line2: 'FOUNDATION (A)', subline: 'Check contents before beginning.' },
  2: { night: 2, line1: 'NIGHT TWO', line2: 'UPRIGHTS (B ×4) — SUPPORT WHILE FIXING', subline: 'Two persons recommended.' },
  3: { night: 3, line1: 'NIGHT THREE', line2: 'DO NOT OVERTIGHTEN', subline: 'Damage caused this way is not covered.' },
  4: { night: 4, line1: 'NIGHT FOUR', line2: 'IF PARTS ARE MISSING, DO NOT RETURN TO STORE', subline: 'Obtain locally.' },
  5: { night: 5, line1: 'NIGHT FIVE', line2: 'THIS STEP REQUIRES TWO PERSONS', subline: null },
  6: { night: 6, line1: 'NIGHT SIX', line2: 'SOLD SEPARATELY', subline: 'Illustration may differ from product.' },
  7: { night: 7, line1: 'NIGHT SEVEN', line2: 'SOME ASSEMBLY REQUIRED', subline: null },
};

/**
 * Nights One through Four have a joke at the bottom of the card and then, twice, there just
 * isn't one. Do not centre the card differently to compensate for the missing sub-line. Leave
 * the space. The silence where the joke goes does more work than the joke ever did.
 */
export const TITLE_CARD_RULES = Object.freeze({
  holdSeconds: 2.4,
  music: false,
  reserveSublineSpaceWhenNull: true,
});

/* =========================================================================================
 * 9. THE NIGHT-END CARD — GAME_DESIGN §9. A receipt printed by something that does not know
 *    what it is a receipt for. All of it deadpan, none of it acknowledging the murder.
 * ======================================================================================= */

const ASSEMBLY_REPORT = {
  header: 'ASSEMBLY REPORT — STEP {night} OF 7',
  rows: [
    { key: 'partsInstalled', label: 'PARTS INSTALLED', format: '{partsInstalled} / {partsTotal}' },
    { key: 'joinsCorrect', label: 'JOINS, CORRECT' },
    { key: 'joinsRotated', label: 'JOINS, ORIENTED CREATIVELY' },
    { key: 'joinsWrongPart', label: 'JOINS, WHICH WE WILL NOT DISCUSS' },
    { key: 'creaks', label: 'AUDIBLE COMPLAINTS FROM THE STRUCTURE' },
    { key: 'hardwareSupplied', label: 'HARDWARE SUPPLIED', literal: 'LARGELY' },
    { key: 'hardwareRequired', label: 'HARDWARE ACTUALLY REQUIRED', literal: 'MORE' },
    { key: 'metresHauled', label: 'DISTANCE CARRIED', format: '{metresHauled} m' },
    { key: 'campersEvaded', label: 'PERSONS WHO EXPRESSED CONCERN' },
    { key: 'reportsDelivered', label: 'PERSONS WHO EXPRESSED CONCERN TO OTHERS' },
    { key: 'timeRemaining', label: 'TIME REMAINING BEFORE SUNRISE', format: '{mm}:{ss}' },
    { key: 'satisfaction', label: 'CUSTOMER SATISFACTION', format: '{satisfaction} / 100' },
  ],
  always: 'THANK YOU FOR CHOOSING SELF-ASSEMBLY.',
  conditional: [
    { when: 'satisfaction >= 95', text: 'PERFECT. WE HAVE NOTHING TO ADD.' },
    { when: 'satisfaction <= 20', text: 'PLEASE RETAIN THIS DOCUMENT FOR YOUR RECORDS.' },
    { when: 'kills > 0', text: 'PLEASE ASSEMBLE ALONE.', red: true, last: true },
  ],
  note: 'Nothing on this card ever mentions difficulty, and nothing on it ever mentions a person '
    + 'by name. The last line is the only red ink on the card.',
};

/* =========================================================================================
 * 10. ENDINGS — STORY.md §8.
 * ======================================================================================= */

const ENDINGS = {
  a: {
    id: 'a', flag: 'ending_a', beatId: 'n7_ending_a',
    title: 'RETURN TO STORE',
    kind: 'monstrous',
    voIds: ['ROB_LATE_03'],
    summary:
      'The player goes and gets Robin from the treeline. There is no chase and no struggle scene, '
      + 'and the screen does not cut away. Then the manual draws a red diagonal across the step — '
      + 'the only red mark ever aimed at the player, the only judgement it has ever passed. Then '
      + 'every page goes blank, including the ones he drew.',
    note: 'Marit never told him to do this.',
  },
  b: {
    id: 'b', flag: 'ending_b', beatId: 'n7_ending_b',
    title: 'DO NOT FORCE',
    kind: 'refusal',
    voIds: [],
    summary:
      'The player walks out and does not come back. The camera holds on the house from the treeline '
      + 'for ninety seconds while the sky greys. Nothing happens. Nothing has ever happened here. '
      + 'Buses at nine.',
    note: 'Bleak, honest and correct — but it is not the true one.',
  },
  c: {
    id: 'c', flag: 'ending_c', beatId: 'n7_ending_c',
    title: 'SOME ASSEMBLY REQUIRED',
    kind: 'true',
    voIds: [],
    achievement: 'NO PARTS REMAINING',
    summary:
      'There is one part in the world that fits a child-sized dotted outline. The player sits down. '
      + 'There is no prompt. The mask comes off — the camera does not show his face; the mask simply '
      + 'enters the frame and is set down on the table. The manual is open beside it, blank, and it '
      + 'stays blank, because she died in 1962 and she never drew what comes after the house is '
      + 'finished. At 6:15 the first bus turns off the county road. He does not get up.',
    note: 'Most players will find it because seven nights have taught them to look for the slot that fits.',
  },
  evacuated: {
    id: 'evacuated', flag: null, beatId: null,
    title: 'THE CAMP BUSES OUT AT DAWN',
    kind: 'loss',
    voIds: ['TED_LATE_01'],
    summary: 'Three reported nights, or any report on Night Six or Seven. The cabin is finished and '
      + 'empty. Credits over an unused cabin.',
    note: 'GAME_DESIGN §8.2. Quiet, sad and correct. Do not score it as a failure on the card.',
  },
  incomplete: {
    id: 'incomplete', flag: null, beatId: null,
    title: 'CAMPERS ARRIVE TO AN UNFINISHED STRUCTURE',
    kind: 'loss',
    voIds: [],
    summary: 'Night Seven ends with the roof cap or the door unbuilt. Different credits.',
    note: 'GAME_DESIGN §8.2.',
  },
};

/* =========================================================================================
 * 11. THE SLASHER — reference card. No VO, ever. Included so no agent has to guess.
 * ======================================================================================= */

const SLASHER = Object.freeze({
  name: 'Ansel Vik',
  born: 1949,
  ageInGame: 35,
  namedInGame: false,
  height: '6\'6"',
  massKg: 127,
  speaks: false,
  silhouette:
    'Sloped through the shoulders like a man who has spent his life ducking through doorframes '
    + 'built for someone else. Canvas coveralls gone black with water. A lumber strap across the '
    + 'chest. A leather tool roll on the right hip, rolled and tied — never loose, never rattling.',
  weapon: 'A 28 oz framing hammer with a milled face, carried head-down. No blade at all until '
    + 'Night Four, and then only a handsaw, and he hates using it because it is loud and it dulls.',
  mask:
    'Not a mask in the horror sense — a portrait. The porcelain splash-back from behind his '
    + 'mother\'s kitchen sink, cut to an oval with a tile nipper, two eyes drilled with a hand '
    + 'brace, set where they were on her page: too far apart for a human skull.',
  tell: 'He must tilt his head to bring a single eyehole onto a target. That head-tilt is how the '
    + 'player recognises him in the 1971 photograph, and it is why nobody believes Robin.',
  habit:
    'Before he touches the manual he wipes his hands on his thighs. Every single time. Two strokes, '
    + 'palms flat, unhurried — the way you would dry your hands before picking up a baby. He does it '
    + 'when they are wet. He does it when they are muddy. On Night Four he does it when they are '
    + 'covered in Dale Pruitt, and the animation does not change, and the timing does not change.',
  breathing: 'AudioEngine should treat his breathing as a tracked emitter at all times so the '
    + 'absence of a voice is audible. The loudest sound he makes all game is the moment on Night '
    + 'Seven when his breath catches.',
  makersMark: 'VIK & SØN',
  oneWord: 'HJEM',
});

/* =========================================================================================
 * 12. INDEXES — precomputed at module load so the helpers never allocate at call time.
 * ======================================================================================= */

const EMPTY = Object.freeze([]);

const VO_BY_ID = Object.create(null);
for (const l of VOICE_LINES) VO_BY_ID[l.id] = l;

const CAMPER_BY_ID = Object.create(null);
for (const c of CAMPERS) CAMPER_BY_ID[c.id] = c;

const NIGHT_BY_N = Object.create(null);
for (const n of NIGHTS) NIGHT_BY_N[n.n] = n;

/** True if `l` may be scheduled on `night` (0/undefined = ignore the night window). */
function inNightWindow(l, night) {
  if (!night) return true;
  if (l.night > night) return false;
  if (l.nightMax != null && night > l.nightMax) return false;
  return true;
}

/** Build a `${key}|${night}` → frozen array cache over nights 0..7. */
function buildCache(keyOf) {
  const cache = new Map();
  const keys = new Set();
  for (const l of VOICE_LINES) for (const k of keyOf(l)) keys.add(k);
  for (const k of keys) {
    for (let night = 0; night <= 7; night++) {
      const hits = VOICE_LINES.filter((l) => keyOf(l).includes(k) && inNightWindow(l, night));
      cache.set(`${k}|${night}`, hits.length ? Object.freeze(hits) : EMPTY);
    }
  }
  return cache;
}

const CACHE_CATEGORY = buildCache((l) => [l.category]);
const CACHE_SPEAKER = buildCache((l) => [l.speaker]);
const CACHE_TAG = buildCache((l) => l.tags);

const BEATS_BY_NIGHT = new Map();
for (let n = 0; n <= 7; n++) {
  const hits = BEAT_LIST.filter((b) => b.night === n);
  BEATS_BY_NIGHT.set(n, hits.length ? Object.freeze(hits) : EMPTY);
}

const PROPS_BY_NIGHT = new Map();
for (let n = 0; n <= 7; n++) {
  const hits = PROPS.filter((p) => p.night <= n || n === 0);
  PROPS_BY_NIGHT.set(n, hits.length ? Object.freeze(hits) : EMPTY);
}

/* =========================================================================================
 * 13. HELPERS — pure, allocation-free, safe to call in a hot path.
 *      Every one of them returns a FROZEN array or `null`. Never mutate a result.
 * ======================================================================================= */

/**
 * Every VO line in `category` that may play on `night`.
 * @param {string} category one of CATEGORIES
 * @param {number} [night]  1..7, or 0/omitted for "any night"
 * @returns {ReadonlyArray<object>} frozen, possibly empty. Never null.
 */
export function linesFor(category, night = 0) {
  const n = night >= 0 && night <= 7 ? night | 0 : 0;
  return CACHE_CATEGORY.get(`${category}|${n}`) ?? EMPTY;
}

/** Every VO line by `speaker` playable on `night`. Same contract as linesFor. */
export function linesBySpeaker(speaker, night = 0) {
  const n = night >= 0 && night <= 7 ? night | 0 : 0;
  return CACHE_SPEAKER.get(`${speaker}|${n}`) ?? EMPTY;
}

/**
 * Every VO line carrying `tag`, playable on `night`. This is how `Campers.js` resolves
 * GAME_DESIGN's `vo_curious_*` / `vo_hm_*` ids — see Script.voRoles.
 */
export function linesTagged(tag, night = 0) {
  const n = night >= 0 && night <= 7 ? night | 0 : 0;
  return CACHE_TAG.get(`${tag}|${n}`) ?? EMPTY;
}

/** A single VO line by id, or null. */
export function voiceLine(id) {
  return VO_BY_ID[id] ?? null;
}

/** The night definition for 1..7, or null. */
export function nightDef(n) {
  return NIGHT_BY_N[n] ?? null;
}

/** A beat definition by id, or null. */
export function beat(id) {
  return BEATS[id] ?? null;
}

/** Every beat defined for `night`. Pass 0 for the global/conditional beats. */
export function beatsFor(night) {
  return BEATS_BY_NIGHT.get(night | 0) ?? EMPTY;
}

/** A camper by id, or null. */
export function camper(id) {
  return CAMPER_BY_ID[id] ?? null;
}

/** The manual sheet for a night: `{ night, tone, cover, panels }`, or null. */
export function panelsFor(night) {
  return PANELS[night] ?? null;
}

/** A single panel by id (e.g. '5.4'), searching every night. Null if unknown. */
export function panelById(id) {
  for (const key of Object.keys(PANELS)) {
    const sheet = PANELS[key];
    for (const p of sheet.panels) if (p.id === id) return p;
  }
  return null;
}

/** The manual's personality for a night, or null. */
export function manualVoiceFor(night) {
  return MANUAL_VOICE[night] ?? null;
}

/** Every environmental prop that exists by `night` (cumulative). Pass 0 for all of them. */
export function propsFor(night) {
  return PROPS_BY_NIGHT.get(night | 0) ?? EMPTY;
}

/** The title card for a night, or null. */
export function titleCard(n) {
  return TITLE_CARDS[n] ?? null;
}

/**
 * True if this line may be scheduled right now. Pure — pass the flags in.
 * @param {object} l a voiceLine
 * @param {number} night
 * @param {object} [storyFlags] ctx.state.storyFlags
 */
export function lineAllowed(l, night, storyFlags) {
  if (!l) return false;
  if (!inNightWindow(l, night)) return false;
  if (l.blockedByFlag && storyFlags && storyFlags[l.blockedByFlag]) return false;
  return true;
}

/* =========================================================================================
 * 14. THE EXPORT
 * ======================================================================================= */

export const Script = {
  version: 1,
  source: 'STORY.md (story, tone, VO, props, panels) + GAME_DESIGN.md (all numbers)',

  nights: NIGHTS,
  beats: BEATS,
  voiceLines: VOICE_LINES,
  campers: CAMPERS,
  props: PROPS,
  panels: PANELS,
  manualVoice: MANUAL_VOICE,

  titleCards: TITLE_CARDS,
  titleCardRules: TITLE_CARD_RULES,
  assemblyReport: ASSEMBLY_REPORT,
  endings: ENDINGS,
  slasher: SLASHER,

  // vocabularies
  speakers: SPEAKERS,
  categories: CATEGORIES,
  beatKinds: BEAT_KINDS,
  triggerKinds: TRIGGER_KINDS,
  storyFlags: STORY_FLAGS,
  canonicalBeatOrder: CANONICAL_BEAT_ORDER,
  glyphs: GLYPHS,
  articleScheme: ARTICLE_SCHEME,
  panelRules: PANEL_RULES,
  manualRules: PANEL_RULES,
  voRoles: VO_ROLES,

  // helpers, also hung off the object for agents that import the default only
  linesFor,
  linesBySpeaker,
  linesTagged,
  voiceLine,
  nightDef,
  beat,
  beatsFor,
  camper,
  panelsFor,
  panelById,
  manualVoiceFor,
  propsFor,
  titleCard,
  lineAllowed,
};

/* -----------------------------------------------------------------------------------------
 * Immutability. Everything is deep-frozen EXCEPT the individual `voiceLines` and `campers`
 * records, which are sealed instead so `tools/generate-voices.mjs` can write `elevenVoiceId`
 * onto them without throwing in strict mode. Do not rely on that; treat it all as read-only.
 * --------------------------------------------------------------------------------------- */

const SEALED = new Set([...VOICE_LINES, ...CAMPERS]);

function deepFreeze(o, depth = 0) {
  if (o === null || typeof o !== 'object' || Object.isFrozen(o) || depth > 12) return o;
  if (SEALED.has(o)) { Object.seal(o); return o; }
  for (const k of Object.keys(o)) deepFreeze(o[k], depth + 1);
  return Object.freeze(o);
}

for (const l of VOICE_LINES) Object.seal(l);
for (const c of CAMPERS) Object.seal(c);
deepFreeze(Script);

export default Script;
