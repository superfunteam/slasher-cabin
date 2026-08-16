# Slasher Cabin: Some Assembly Required — Game Design Document

**Version 2.0 — systems spec. This is the document gameplay agents implement.**

Read `ARCHITECTURE.md` first. Everything here is expressed in the module names, event names,
`GameState` fields and `settings.tier()` conventions defined there. **No system in this document
invents a new event.** Where a behaviour needs a channel, it reuses one from the canonical table
in `ARCHITECTURE.md §5`, with `kind` / `id` / `reason` strings enumerated below so all agents
agree on the vocabulary. Where this document needs a new **field** on `GameState` or `Settings`,
it is requested explicitly in §20.2 and §20.3 — never assumed.

---

## 0. HOW TO READ THIS DOCUMENT

### 0.1 Canon order (binding — resolves every cross-document conflict)

v1.0 of this document was written in parallel with `STORY.md` and neither yielded to the other.
The result was two different games sharing a title. That is fixed here by declaring a strict
precedence, and every conflict below is resolved *in writing* rather than left for an implementer
to guess.

| Rank | Document | Owns |
|---|---|---|
| 1 | `ARCHITECTURE.md` | events, `ctx`, `GameState`, file ownership, perf guardrails |
| 2 | `STORY.md` | **what happens each night**, who exists, tone, the ending |
| 3 | `ART_DIRECTION.md` | palette, lighting, fog, weather values, UI look |
| 4 | `AUDIO_DIRECTION.md` | the mix, the bus graph, SFX synthesis, silence rules |
| 5 | **this document** | how all of the above is *played* — numbers, formulas, verbs |

**This document is subordinate to `STORY.md` on night content.** Where v1.0 invented a build
target that contradicted `STORY.md §4`, `STORY.md §4` wins and v1.0's target is deleted. §12 is
the single canonical night table; nothing else in this repository may state a different one.

### 0.2 Conflicts resolved here, by name

These were live contradictions across the repository as of v1.0. Each is closed. Do not re-open
one without editing this table.

| # | Conflict | Resolution |
|---|---|---|
| C1 | Night content: this doc's §7 vs `STORY.md §4` — mismatched on all seven nights | `STORY.md §4` is canon. §12 below is rewritten to serve it. v1.0's "14 wall studs", "22 roof trusses", "20 glazing units", "28 slots" are **deleted**. |
| C2 | Weather: v1.0 §7 vs `ART_DIRECTION.md §4.5` — mismatched on all seven nights | `ART_DIRECTION.md §4.5` is canon. **The storm is Night 6, not Night 5.** Night 5 is the whiteout-fog night. This is load-bearing: it is what makes thunder masking arithmetically possible (§7.5). |
| C3 | `ART_DIRECTION.md §4.5` labels Night 5 "the scariest night"; `STORY.md §4` says Night 6 is "the worst night of the game" | Both are kept, because they mean different things and neither needs to change. Night 5 is the scariest **image** (24 m visibility, a wall held up by a canoe). Night 6 is the worst **night** (two campers, a broken manual, Robin inside the house). Art's label refers to visibility; Story's refers to dread. |
| C4 | `STORY.md §2` "no blade at all until Night Four"; `STORY.md §4` Night Three cuts the ridge beam with a handsaw "in the tool roll… the whole time" | **The handsaw has been in the tool roll since Night One.** §2's line is about *weapons* — he owns no blade he would use on a person until Night Four. §7 object 5's "gap where the handsaw goes" is the gap left when the saw is in his hand. The saw is therefore available on Night 1 as the **Recut** repair verb (§7.4), which is what makes Night 3's ridge cut a variation on a known verb instead of a mechanic arriving from nowhere. |
| C5 | v1.0 §2.5 "the *only* non-diegetic sound in the game" vs `Music.js` (`ARCHITECTURE.md §9`) and `AUDIO_DIRECTION.md §6` (adaptive score, Dread scalar, the stinger) and §4.20 (heartbeat) | The claim was false. **The game has exactly three non-diegetic sound sources** and §11.4 lists them. `Music.js` stays. |
| C6 | v1.0 §4.1 "Ranger: night 6+, only after a completed report" vs v1.0 §8.1 rung 5 "3 reports" | One rule, stated once: **the Ranger arrives when `night >= 6` AND `stats.reportsTotal >= 2`.** §13.1 and §9.2 both cite this line rather than restating it. |
| C7 | v1.0 §11 "No word has been written on screen" at 5:00 vs `STORY.md §9` title cards | The title card is the *manual's* voice, not the game's. The claim is restated correctly in §17. |
| C8 | v1.0 §2.3 argued with itself in the spec text (`settings.tier(...)` — "no, use the difficulty setting") | Resolved to a single expression in §6.5. A binding spec never deliberates. |

### 0.3 What "concrete" means here

Every number in this document is either **measured**, **derived**, or **targeted**.

- **Derived** numbers show their arithmetic inline. If you change an input, re-run the shown
  formula; do not hand-edit the output.
- **Targeted** numbers are design intents with a named instrument and a threshold, listed in §19.
  A target without an instrument is not a target, it is a mood, and v1.0 had eleven of them.
- Anything phrased as "it is terrifying" / "the game's best sequence" / "the player will feel it"
  has been either deleted or converted into a row of §19. The rule going forward: **if a sentence
  asserts an emotional outcome, it must name the measurement that would falsify it.**

---

## 1. Design pillars (binding, in priority order)

1. **The manual is the comedian. The world is not.** Nothing in the 3D scene ever jokes. All
   humour lives in `BlueprintUI.js` line art and the night-end card. If a gag would require the
   slasher to react, cut the gag. **Corollary added in v2.0:** the card may not editorialise
   either. A pun aimed at the player *is* the character winking; it just moved to the UI layer.
   See §15.3 for the register test v1.0's card failed.
2. **The puzzle is spatial, not textual.** The player converts an exploded axonometric diagram
   into a world-space placement. Zero words on the page except article numbers and `HJEM`.
3. **Noise is the currency of risk.** Every mechanic resolves into a single `noise:emit`. One
   nervous system, one tuning knob. `AUDIO_DIRECTION.md §1.3` binds each `kind` to an audible
   loudness so the player can calibrate risk by ear.
4. **Weight is a verb — and also an animation.** v1.0 said "not by animation." That was a dodge
   written by a systems author to avoid specifying animation. Weight is communicated by
   acceleration curves **and** by a specified first-person body (§4.3). Both are required. AAA
   heaviness is mostly animation and pretending otherwise does not make the animation unnecessary,
   it makes it unspecified.
5. **Failure escalates; it does not reload.** Getting seen is a story beat with mechanical
   consequences that persist across nights. But see §14: *the player* may reload whenever they
   like. Persistence is a fiction we impose on the cabin, not a punishment we impose on the human.
6. **Every stealth verb that can be a construction verb, is.** The cabin is a first-class AI
   object: it blocks sight, blocks sound, rewrites patrol routes, and is the player's only
   distraction tool (§9.6). The genre-standard verbs that remain — crouch, freeze, break LOS,
   douse the lantern — remain because they are the grammar of the form and removing them makes
   the game worse rather than more original. See §20.5 for why this is a partial adoption.

---

## 2. THE CANONICAL NIGHT TABLE

Everything downstream reads from this table. It is derived, not asserted; §5.3 shows the
arithmetic that produces the `Seconds` row, and §12 enumerates exactly the parts counted in the
`Slots` row. **No other table in this repository may state a different value for any cell here.**

| Night | Title (`STORY.md §9`) | Build (`STORY.md §4`) | Slots | Stages | Seconds | mm:ss |
|---|---|---|---|---|---|---|
| **1** | FOUNDATION (A) | 6 stone piers, 6 sill beams | **12** | 2 | **800** | 13:20 |
| **2** | UPRIGHTS (B ×4) — SUPPORT WHILE FIXING | 4 corner posts, 6 wall studs, 4 diagonal braces | **14** | 3 | **975** | 16:15 |
| **3** | DO NOT OVERTIGHTEN | 6 truss assemblies, 1 ridge beam (over-long), 6 ridge pins | **13** | 3 | **950** | 15:50 |
| **4** | IF PARTS ARE MISSING, DO NOT RETURN TO STORE | 12 subfloor boards, 1 door, 3 hinges | **16** | 3 | **1050** | 17:30 |
| **5** | THIS STEP REQUIRES TWO PERSONS | 1 north wall panel (71 kg), 3 rig anchors (freeform), 6 pins | **10** | 2 | **1175** | 19:35 |
| **6** | SOLD SEPARATELY | 8 roof battens, 6 shingle bundles, sink, flue, doorframe | **17** | 4 | **1400** | 23:20 |
| **7** | SOME ASSEMBLY REQUIRED | 2 chairs (8 slots). Nothing structural remains. | **8** | 1 | **unclocked** | ~10:00 |

**Total slots across the game: 90.** **Total nominal playtime: 6,950 s = 1 h 55 m** for a clean
first run that makes no mistakes and never hides. With realistic failure, re-seats, hiding, and
one replayed night, target **2 h 20 m – 2 h 45 m**. This is the game's length. v1.0 never stated
one; its own estimates summed to 106 minutes against night lengths that could not contain them.

**Night 7 has no clock.** `nightDurationSeconds = Infinity`; `NightManager` advances
`timeOfNight` on beat completion, not on `dt` (§5.4). There is no dawn to beat because
`STORY.md §4` gives Night 7 nothing structural to build. The ~10:00 figure is a pacing estimate
for the walkthrough and the ending branch, not a limit.

### 2.1 Escalation curves, and the fact that they are out of phase

`STORY.md §4` states that build complexity, camper density and tone escalate on three independent
curves, deliberately out of phase. Here they are as numbers, so an implementer can see the shape:

| Night | Slots | Campers present | Weather severity¹ | Tone² |
|---|---|---|---|---|
| 1 | 12 | 1 | 0.23 | comedy |
| 2 | 14 | 3 | 0.42 | comedy + a witness |
| 3 | 13 | 4 | 0.43 | tension |
| 4 | 16 | 5 | 0.63 | **the comedy dies** |
| 5 | 10 | 5 | 0.47 | loneliness |
| 6 | 17 | **2** | 0.78 | dread |
| 7 | 8 | 1 → 0 | 0.13 | grief |

¹ `0.5·rain + 0.3·wind + 0.2·fog` from `ART_DIRECTION.md §4.5`.
² Not a system. Listed so nobody "fixes" the Night 5 slot dip or the Night 6 density dip by
raising them. **The dips are the design.** Night 5 has the fewest structural slots and the longest
night because the single 71 kg panel is the entire evening. Night 6 has the most slots and the
fewest people because emptiness is the horror.

The one curve that must be monotonic is **cumulative slot count** — the cabin only grows:
12, 26, 39, 55, 65, 82, 90.

---

## 3. THE MAP

v1.0 specified spawn tiers in metres against a world that had never been described, which made
every stealth and time number in it unverifiable. This is the site plan. `Terrain.js` owns the
heightfield, `Props.js` owns the camp, `CabinSite.js` owns the plot; this section owns the
**distances**, because every number in §5, §9 and §11 is computed against them.

### 3.1 Coordinate frame

Origin `(0, 0, 0)` is the centre of the build plot, which is the centre of the Vik house
footprint (`STORY.md §7` object 2). Y is up, **−Z is north** (toward the lake), +X is east.
Ground at origin is `y = 0`. All distances below are horizontal (XZ) from origin unless noted.

### 3.2 Playable bounds

A **460 m (X) × 380 m (Z)** rectangle, `x ∈ [−210, 250]`, `z ∈ [−140, 240]`.

| Edge | Boundary | How the player is stopped |
|---|---|---|
| North (`z = −140`) | Lake Wanaka shoreline | Water. Wading past 0.9 m depth is refused: 280 lb in wet canvas. No swim verb exists. |
| South (`z = 240`) | The county road and its ditch | A wire fence and a 2.4 m cut bank. Climbable nowhere. Bev's truck sits here on Night 6. |
| East (`x = 250`) | Deadfall — a 1998-style blowdown belt | Impassable tangle, 30 m deep, reads as forest. |
| West (`x = −210`) | The ridge crest, then a drop | The crest is walkable; past it the ground falls 24 m and the collision volume refuses. |

Bounds are never signposted. The player discovers them as terrain, per Pillar 2.

### 3.3 Named locations, with distances

| Location | Position (x, z) | Distance from plot | Elev. | Owner | Role |
|---|---|---|---|---|---|
| **The plot** (`CabinSite`) | (0, 0) | 0 | 0 | Build | 14 × 10 m footprint on the point |
| Supply pallet A | (4, 12) | **12 m** | 0 | Build | Night 1 piers. Deliberately close — this is the tutorial. |
| Supply pallet B | (−9, 16) | **18 m** | −0.4 | Build | Sill beams, then each night's Tier-1 stage manifest |
| Staging apron | (11, 24) | **26 m** | +0.3 | Build | Trusses (N3), battens (N6). Big parts land here. |
| The woodpile | (33, 32) | **46 m** | +1.1 | Props | Shims, sawdust piles, sistering boards |
| The stump (licence-plate shim) | (29, −5) | **30 m** | +0.6 | Props | `STORY.md §7` object 1 |
| **The ridge** | (−58, 4) | **58 m** | **+11.0** | Terrain | Skyline exposure (§9.3). Overlooks the plot and the camp. |
| Marit's grave | (−36, −18) | **40 m** | +4.2 | Props | `STORY.md §7` object 17. Grass cut by hand. |
| The fire road | z = 62, runs E–W | **62 m** (perp.) | −0.8 | Terrain | Dale walks up it on Night 4 |
| The porcelain sink | (−48, −35) | **59 m** | +1.4 | Props | `STORY.md §7` object 3. Becomes an installable part on Night 6. |
| Canoe rack | (61, −58) | **84 m** | −1.9 | Props | Robin, Night 2. Source of Dale's canoe (Night 5). |
| **Boathouse** | (74, −61) | **96 m** | −2.4 | Props | The three brass hinges (Night 4). Concealment volume (§13.5). |
| The dock | (86, −66) | **108 m** | −2.9 | Props | Marg's domain |
| Archery range | (48, 110) | **120 m** | +2.0 | Props | The orchard. The swing seat tree (`STORY.md §7` object 15). |
| Tool shed | (−22, 129) | **131 m** | +1.6 | Props | Pegboard. Brace, drawknife, rope. |
| Counselors' cabins | (18, 141) | **142 m** | +2.2 | Props | On the barn footprint. Rally point. |
| Counselor's truck | (37, 145) | **149 m** | +2.1 | Props | Felt pads, rope. Radio (rung 6). |
| Camp office + Bev's porch | (62, 142) | **155 m** | +2.4 | Props | The hubcap ashtray, facing the point |
| **Mess hall** | (79, 148) | **168 m** | +2.5 | Props | On the garden. Photo board (`STORY.md §7` object 16). Tallow. |
| **The payphone alcove** | (84, 154) | **176 m** | +2.5 | Props | The manual's telephone glyph. Rung 6. |
| The county road | z = 240 | **240 m** | +3.0 | Terrain | Headlights, Night 6 |

### 3.4 Why these distances and not others

They are not decorative. Four gameplay facts fall directly out of them:

1. **The hinges are 96 m out** — `STORY.md §4` says "ninety metres inside the lit perimeter."
   At the Night-4 haul speed for a hinge set (class B, 0.96×, 1.536 m/s) the round trip is
   `96/1.536 + 96/1.60 = 62.5 + 60.0 = 122.5 s` of pure travel before any waiting. §5.3 budgets
   260 s for the whole Night-4 shortfall, which is that plus 137 s of patrol waiting.
2. **Robin's torch crawls over the frame at 84 m on Night 2** — `STORY.md §4` says "eighty
   metres." A counselor's structure-notice range is `R × 3.2 = 24 × 3.2 = 76.8 m` (§9.5), so at
   the canoe rack she is *just* inside it. The beat is a system firing, not a cutscene. This is
   the single best consequence of writing the map down.
3. **The payphone is 176 m from the plot** — which is why a report that reaches it cannot be
   intercepted (§13.2). That is deliberate and it is stated as such rather than being a bug.
4. **The ridge is 58 m west and 11 m up** — inside a counselor's hearing for a saw (~50 m
   effective, §7.6) and directly on the skyline (§9.3). Standing there to read the manual is the
   most exposed thing in the game and costs nothing to reach, which is the trap.

### 3.5 Spawn tiers, re-anchored to the map

| Tier | Distance band | Actual locations | Camper exposure | Lantern needed? |
|---|---|---|---|---|
| **1** | 12–46 m | pallets A/B, staging apron, woodpile, the stump, truck ruts | none | no |
| **2** | 58–108 m | boathouse eave, canoe rack, dock lockbox, the porcelain sink, the ridge cairn | 1 patrol passes every ~50 s | yes, briefly |
| **3** | 120–176 m | mess hall shelf, tool shed pegboard, counselor's truck bed, the payphone alcove, archery shed | 2–3 campers, at least one static | yes, and see §9.4 — an unhooded flame here is fatal |

### 3.6 Ground types (drives footstep noise and the Panic stumble)

`Terrain.js` publishes a ground type per sample. Four types, no more.

| Type | Coverage | Footstep noise × | Player speed × | `rough` (Panic stumble, §9.7) |
|---|---|---|---|---|
| `duff` (pine needles, moss) | 61% | 0.72 | 1.00 | no |
| `mud` (after rain ≥ 0.4) | 18% | 1.15 | 0.94 | no |
| `rock` (the point, the ridge) | 13% | 1.40 | 1.00 | no |
| `deadfall` (branch litter, roots) | 8% | 1.85 | 0.88 | **yes** |

<!--SECTION-BREAK-->
