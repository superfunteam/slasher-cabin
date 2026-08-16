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

---

## 4. CONTROLS AND THE PLAYER'S BODY

v1.0 specified creak centre frequencies to the Hz and never said which button places a part.
This section closes that.

### 4.1 Input map

Owned by `Input.js` (`ARCHITECTURE.md §9`, Engine agent). **Every binding is remappable**,
including modifiers; the remap UI lists actions by icon and name and accepts any key, mouse
button, or pad input. Chorded bindings are permitted but never required by default.

| Action | KBM | Gamepad | Type | Notes |
|---|---|---|---|---|
| Move | `WASD` | Left stick | analog | |
| Look | Mouse | Right stick | analog | rate-limited, §10.1 |
| Sprint | `LShift` | `L3` | hold (toggle option) | 1.9 s spin-up |
| Crouch | `LCtrl` | `B` / Circle | hold **or** toggle (`settings.holdToCrouch`) | |
| Interact / pick up | `E` | `X` / Square | tap | |
| **Place** | `LMB` | `RT` | tap | opens the seating check on a valid snap |
| **Seating check** | hold `LMB` | hold `RT` | **hold, 0–3.0 s** | release inside the band, §6.5 |
| **Force-place** | hold `LMB` **3.0 s** past refusal | hold `RT` 3.0 s | hold | the Wrong-part verb, §6.4. Raised from v1.0's 1.4 s. |
| Drop (instant, loud) | `G` | `LB` tap | tap | |
| Set down (2.1 s, silent) | hold `G` | hold `LB` | hold | |
| **Open manual** | `Tab` | `Y` / Triangle | tap | preceded by the mandatory 0.9 s hand-wipe, §4.4 |
| Turn manual page | `Q` / `R`, or wheel | `LB` / `RB` | tap | manual must be open |
| Lantern on/off | `F` | `D-pad ←` | tap | 0.9 s ignite, 0.25 s douse |
| Lantern hood | hold `F` | hold `D-pad ←` | hold | §11.2 |
| **Provoke a join** (decoy) | hold `E` on a seated join, 1.6 s+ | hold `X`, 1.6 s+ | hold | §9.6 — the only distraction verb |
| **Recut** (repair) | hold `E` on a wrong join, 1.2 s | hold `X`, 1.2 s | hold | §7.4, requires a sistering board |
| **Saw pass** | hold `LMB` on a cut line | hold `RT` | hold, 5.2 s | §7.6 |
| **Grab** (Night 4+) | `E` within 1.1 m, behind, unaware | `X` | tap | §13.4 |
| Pause | `Esc` | `Start` | tap | §14 |

**Dead zones and curves:** stick dead zone 0.14 radial, response curve `x^1.7` on look (so the
1400°/s² turn accel in §10.1 is felt, not fought). Mouse input is raw, unaccelerated, and passes
through the same rate limiter — the limiter is a **game** rule, not an input-quality artefact,
and the settings menu says so in one sentence so nobody files it as a bug.

**Latency budget:** total input-to-effect for `Place` and the seating-check release is **≤ 120 ms**
at 60 fps, measured pointer-event timestamp → `BuildSystem` sample. See §6.5 for why the seating
check reads `Input.lastEventTimestamp` rather than frame time: a dropped frame must not cost the
player a join.

### 4.2 Accessibility of input

- Every hold has a `settings.holdToToggle` counterpart. No action in the game requires holding a
  button for longer than 0.4 s if that setting is on; the hold's *duration* becomes a progress
  bar that fills without input and is cancelled by a second tap.
- No action requires simultaneous analog inputs on both sticks.
- No quick-time event exists anywhere in this game. The seating check is a hold-and-release with
  a 450 ms window (§6.5), not a reflex test, and `story` difficulty widens it to 900 ms.
- The 4.5 s grab (§13.4) is a single tap followed by a non-interactive sequence. It is never a
  button-mash.

### 4.3 The first-person body

Pillar 4 requires this be specified rather than asserted. `Player.js` owns the rig;
`ART_DIRECTION.md §6` owns how it is lit and framed.

**Standing pose.** Eye height 1.7 m. The camera sits 0.14 m forward of the neck pivot, so a head
turn arcs — the world shifts laterally before it rotates. Shoulders are visible in the lower
frame at rest: 2° of the lower-left and lower-right frame edges are occupied by canvas, always.
You are never looking out of a floating box.

**Hands.** Both hands are on screen whenever they are empty. They are large — the target read is
that a hand spans 19% of frame width at rest, against a typical FPS 11–13%. Fingers are thick and
slightly splayed; the left index finger is permanently crooked (an old break, never mentioned).
The hands enter frame from below at a shallow angle, not from the corners.

**Idle.** At full stop the hands drift on a 0.21 Hz noise, amplitude 0.012 m. After 8 s of
stillness the right thumb passes across the fingertips once, 0.6 s. That is the only idle flourish
in the game and it exists so that "still" does not read as "paused."

| Pose | Trigger | Hands | Camera | Duration |
|---|---|---|---|---|
| **Empty** | default | both, low, open | 1.7 m, 0.055 m bob @ 1.9 Hz | — |
| **Tool held** | class B in hand | right hand grips head-down; left free | +0.4° pitch | — |
| **Carry C** | 8–35 kg | both hands under the part at hip height | −2.0° pitch, bob → 0.071 m @ 1.55 Hz | — |
| **Carry D** | 35–70 kg | right shoulder loaded, right hand up steadying, left hand out for balance | −4.5° pitch, **28° of lower frame occluded**, bob 0.092 m @ 1.20 Hz, +1.4° roll oscillation | — |
| **Carry E / drag** | > 70 kg | both hands back and low, body pitched forward | −7° pitch, 0.9 Hz lurch synced to the drag scrape | — |
| **Hammer swing** | seating check tap | right arm full arc, 0.38 s per tap; the head **does not** track the swing | 1.1° kick on impact, decays 0.18 s | 0.38 s/tap |
| **Saw pass** | §7.6 | both hands on the saw, 4 strokes per pass | ±0.8° yaw sway at 0.77 Hz | 5.2 s |
| **Hand-wipe** | §4.4 | both palms flat, two strokes down the thighs | camera drops 0.06 m and returns | **0.9 s** |
| **Grab** | §13.4 | left forearm across the chest from behind; right hand out of frame | see §13.4 | 4.5 s |

**Animation authoring note.** Everything above is procedural — additive noise layers, IK targets
and spring chains on a code-authored skeleton, per `ARCHITECTURE.md §1` (zero binary assets).
There is no animation file in this project. The hand rig is 22 bones; the arm chain solves
two-bone IK to a spring-damped target (k = 90, ζ = 0.72 unloaded; k = 34, ζ = 0.55 at class D, so
heavy poses lag and settle).

### 4.4 The hand-wipe

**The most important animation in the game** (`STORY.md §2`). Before the manual opens, Ansel
wipes his hands on his thighs. Two strokes, palms flat, unhurried.

| Property | Value |
|---|---|
| Trigger | every `ui:blueprint-open`, from Night 1, without exception |
| Duration | **0.9 s**, and `BlueprintUI` does not begin drawing until it completes |
| Skippable | **never** — not by setting, not by difficulty, not by `holdToToggle`, not on Night 7 |
| Clock | the night clock **runs** during it (it is build time, §5.2) |
| Timing variance | none. Identical every time. That is the entire device. |
| Cost to the player | ~90 instances × 0.9 s = **81 seconds** across a full playthrough |

That 81 seconds is the price of one moment: on Night 4, after Dale, the hands are red and the
animation does not change and the timing does not change. `Player.js` must not special-case that
instance in any way — no added frames, no camera move, no audio cue. The only difference is the
material on the hands, which `Materials.js` already supports via the wetness model
(`ART_DIRECTION.md §5.1`). **If an implementer adds a single frame of emphasis there, the beat is
destroyed.**

By Night 7 the hands are split (a procedural crack mask, `crackAmount` 0 → 1 across nights 5–7).
On Night 7 only, once, the wipe leaves a mark on the page: `Blueprint` receives
`smudge: { panel, uv, strength }` and draws it. Ansel looks at it for **1.0 s and 40 frames**
(`STORY.md §2` — 1.67 s total at 60 fps) with input locked, then turns the page. This is the only
input lock in the game outside the ending.

### 4.5 What the camera does during the grab

`STORY.md §4` requires the first kill to be off-camera: a hard cut to black, no sting, no scream,
only a hammer set down on wood. That is the **scripted** Night 4 kill. Player-initiated grabs
after it need their own spec, because "4.5 s, silent" is not a visual description.

| t | Camera | Audio |
|---|---|---|
| 0.00–0.35 | Left forearm enters frame and closes across the camper's chest from behind. Camera pitches down 6° and moves 0.22 m forward — you are stepping into them. | cloth, one breath in |
| 0.35–2.70 | Held. The camper's hands come up onto the forearm. Camera holds; ±0.9° struggle noise on the view matrix. **The right hand never enters frame.** | struggle, muffled; per `AUDIO_DIRECTION.md §2.3` everything else ducks −9 dB |
| 2.70–4.50 | Camera pitches down a further 34° over 1.1 s to the ground and holds there. The act finishes out of frame. | the audio does not duck away, and this is the point |
| 4.50 | Camera returns to neutral over 0.6 s. Hands are marked. | one exhale. Then the bed returns, per `AUDIO_DIRECTION.md §8` |

**No blood geometry, no dismemberment, no gore decals on the body.** The hands are marked and the
ground is marked and that is the extent of it. The horror budget is spent on the hand-wipe that
follows, not on the four seconds before it. `settings.reducedGore` (§16.1) cuts to black at 2.70 s
and returns at 4.50 s with the audio intact.

---

## 5. THE CORE LOOP

The loop runs **once per build stage**, not once per night. `GameState.phase` only takes the
values allowed by `ARCHITECTURE.md §8`.

```
                        ┌──────────────────────────────────────────────┐
                        │                                              │
   night:begin          ▼                                              │
  ┌──────────┐   ┌─────────────┐   ┌──────────┐   ┌──────────┐   ┌──────────────┐
  │ BRIEFING │──▶│  SCAVENGE   │──▶│   HAUL   │──▶│ ASSEMBLE │──▶│ CREAK /      │
  │ study    │   │ find parts  │   │ slow +   │   │ the      │   │ CONSEQUENCE  │
  │ manual   │   │ + the tool  │   │ loud     │   │ puzzle   │   │ noise:emit   │
  └──────────┘   └─────────────┘   └──────────┘   └──────────┘   └──────┬───────┘
  phase=briefing      phase=build      phase=build   phase=build        │
        ▲                  ▲                                            │
        │                  │                                            ▼
        │            ┌─────┴───────┐                             ┌─────────────┐
        │            │ tool:missing│◀─────────────────────────── │   EVADE     │
        │            │ detour      │      (patrol converges)     │ phase=chase │
        │            └─────────────┘                             └──────┬──────┘
        │                                                                │
        │                        build:stage-complete                    │
        └────────────────────────────────────────────────────────────────┘
                                        │
                          timeOfNight >= 1.0 or all stages done
                                        ▼
                                ┌───────────────┐
                                │     DAWN      │  night:complete → night-end card
                                │ phase=night-  │  night:failed   → escalation ladder §13
                                │      end      │
                                └───────────────┘
```

### 5.1 Phase timings — measured, not targeted

v1.0 published a "Target (min)" column whose values summed to 2.6× the night lengths in its own
next table. **The Target column is deleted.** Phases do not have durations; they have *rates*,
and the durations fall out of the map (§3) and the manifest (§12). What follows is the rate table
that §5.3 integrates.

| Phase | Clock runs? | Rate / cost | Source |
|---|---|---|---|
| Briefing | **No** | free, unlimited | the player may study before starting the night |
| Hand-wipe | **Yes** | 0.9 s per manual open | §4.4 |
| Scavenge | Yes | travel at §10.1 speeds over §3.3 distances | derived |
| Haul | Yes | `d/v_carry + d/v_walk` per round trip | derived |
| Assemble | Yes | **4.2 s per slot** (approach 1.1 + align 0.9 + hold ≤ 3.0 s − mean release 1.9 + settle 0.3) | derived |
| Creak / consequence | Yes | not a phase in the clock sense; creaks fire on their own 2.0 s tick during `build` | §7 |
| Evade | Yes | 30 s per Searching camper that must give up | §9.7 |
| Dawn | No | 0:50 card | §15 |

**Briefing is free and reopening the manual is not.** The clock runs during `phase === 'build'`
and `'chase'` only. Opening the manual mid-build costs the 0.9 s wipe plus however long you read.
This is the only thing in the game that punishes hesitation, and it punishes it gently.

### 5.2 The derivation formula (binding)

```
T_haul      = Σ over parts:  ceil(count / partsPerTrip) × (d/v_carry + d/v_walk)
T_assemble  = slots × 4.2
T_special   = night-specific mechanic cost (saw, rigging, ruin anchors) — §12
T_shortfall = Σ over shortfalls: (2 × d/v_walk) + searchAllowance
T_beat      = scripted story-beat time in which the player cannot build

T_content   = T_haul + T_assemble + T_special + T_shortfall + T_beat

nightDurationSeconds = roundTo25( T_content / (1 - SLACK) ),  SLACK = 0.30
```

**`SLACK = 0.30` is the whole safety margin** and it covers: hiding from patrols, re-reading the
manual, mis-seats and re-seats, mistaken pathing, and the hand-wipe. It is a *floor*, not a
target — see the acceptance test in §19 row A3.

**The invariant this produces:** a player who makes zero mistakes, never hides and never re-reads
finishes the night at `timeOfNight ≈ 0.70`. A player who makes an average number of mistakes
finishes at 0.88–0.95. **If playtest medians land outside `[0.82, 0.97]`, change `SLACK`, not the
night length.** The night length is derived; it is not a knob.

### 5.3 The derivation, run

Speeds from §10.1: `v_walk = 1.60`, `v_C = 1.312`, `v_D = 1.008`, `v_E = 0.544`,
`v_endLift = 0.832`. Distances from §3.3.

| Night | T_haul | T_assemble | T_special | T_shortfall | T_beat | T_content | ÷0.70 | **Published** |
|---|---|---|---|---|---|---|---|---|
| **1** | 50 + 175 = **225** | 12 × 4.2 = **50** | 0 | shim @ 30 m + 112 s search = **150** | tutorial pacing **130** | 555 | 793 | **800** |
| **2** | 181 + 117 + 78 = **376** | 14 × 4.2 = **59** | 0 | bracket H, Tier-2 @ 78 m + 60 s = **158** | Robin hears + torch crawl **90** | 683 | 976 | **975** |
| **3** | 253 + 42 = **295** | 13 × 4.2 = 55, + prop-hold 6 × 6 = **91** | saw: 14 passes × 5.2 s + waiting = **200** | none (`STORY.md §4`) = **0** | Robin/Bev, Bev's cigarette **90** | 676 | 966 | **950** |
| **4** | 250 + 48 = **298** | 16 × 4.2 = **67** | 0 | hinges, Tier-3 @ 96 m, lit = **260** | Dale, the kill, the torch **120** | 745 | 1064 | **1050** |
| **5** | panel end-lift **54** | 10 × 4.2 = **42** | rigging: gather **300** + rig/fail/re-rig **240** + fog nav tax **100** = **640** | none = **0** | panel 5.4, the hand on the wall **110** | 846 | 1209 | **1175** |
| **6** | 178 + 133 + 163 = **474** | 17 × 4.2 = **71** | ruin anchors **190** + the 0000-000 allowance **90** = **280** | none (the shortfall *is* 0000-000) = **0** | Robin inside **90** + Bev at the road **60** = **150** | 975 | 1393 | **1400** |
| **7** | 0 (parts are on site) | 8 × 4.2 = **34** | interior walk-through **180** | 0 | ending branch **90–260** | ~500 | — | **unclocked** |

Two published values are rounded *down* from the derivation (Night 3: 966 → 950; Night 5:
1209 → 1175). That is deliberate: both nights have a large `T_special` whose cost is partly
under player control (you choose when to saw; you choose how elaborate a rig to build), so the
slack is already generous inside those terms. Nights 1, 2, 4 and 6 round to the nearest 25 up.

### 5.4 Pacing (the rubber band)

`NightManager` compares actual progress to `stagesDone / stagesTotal` against `timeOfNight`:

| Condition | Response | Why it is invisible |
|---|---|---|
| Ahead by > 0.12 | `Weather.requestWind(+0.15)` for 90 s, and `Campers.patrolDensity += 1` | The player reads it as the night turning against them |
| Behind by > 0.18 | one un-found Tier-3 item is quietly relocated to its Tier-1 fallback position; the relocation only happens **while the player has no line of sight to either position** | The player reads it as having missed it the first time |
| Behind by > 0.35 | `Weather.requestWind(−0.20)`, and the next creak tick is skipped on every join | The player reads it as a lull |

The band never touches detection constants, seating windows, or slot counts. It touches weather,
patrol count, and one item position. **Gameplay constants are never rubber-banded** — that is the
difference between hiding your assistance and lying about your rules.

---

## 6. THE BUILD PUZZLE

### 6.1 Part taxonomy

Owned by `BuildSystem.js`. Every part is a procedural mesh from a parameterised generator, so
"silhouette" below is the generator's read at 25 m in moonlight — the *only* way the player
identifies a part in the dark.

| Class | Part type | `acceptsType` | Length (m) | Mass (kg) | Carry class | **Slots** | Silhouette | Reads in dark as | Drop noise |
|---|---|---|---|---|---|---|---|---|---|
| Structural | **Beam** | `beam` | 3.2 | 62 | D | 4 | long straight bar, square section | a line that occludes stars | 0.80 |
| Structural | **Beam-short** | `beam` | **2.6** | 48 | D | 4 | *identical generator, 81% length* | the same line, slightly shorter | 0.78 |
| Structural | **Post** | `post` | 2.4 | 41 | D | 4 | shorter bar, chamfered top | a fencepost | 0.72 |
| Structural | **Joist** | `joist` | 2.6 | 24 | C | **2** | thin deep rectangle | a plank on edge | 0.55 |
| Structural | **Truss** | `truss` | 4.0 span | 55 | D | 4 | triangle with webbing | a shape with a *hole* in it | 0.85 |
| Structural | **Ridge beam** | `ridge` | 5.14 (**over-long, N3**) | 71 | D | 4 | the longest line in the game | too long, and you can see it | 0.88 |
| Surface | **Panel** | `panel` | 1.2 × 2.4 | 33 | D | 4 | flat rectangle, catches moonlight | a bright grey slab | 0.75 |
| Surface | **North wall panel** | `panel` | **4.8 × 2.4** | **71** | **end-lift** | 4 | the biggest object a person holds | a wall, walking | 0.95 |
| Surface | **Sheathing board** | `board` | 0.2 × 2.4 | 9 | C | **2** | thin, whippy | a stick | 0.40 |
| Surface | **Batten** | `batten` | 2.8 | 11 | C | **2** | very thin, very long | a wire | 0.38 |
| Surface | **Shingle bundle** | `shingle` | — | 27 | C | **2** | soft-edged brick | a sandbag | 0.45 |
| Surface | **Sistering board** | `board` | 1.2 | 7 | C | **2** | short plank | a stick | 0.36 |
| Fitting | **Door** | `door` | 0.9 × 2.05 | 38 | D | 4 | a rectangle with a *handle* | the first domestic shape | 0.70 |
| Fitting | **Sink** | `fitting` | — | 29 | C | **2** | curved white mass | the only white thing | 0.82 (porcelain) |
| Fitting | **Stove flue** | `fitting` | 2.2 | 16 | C | **2** | narrow cylinder | a pipe | 0.60 |
| Fitting | **Doorframe** | `fitting` | 2.1 | 19 | C | **2** | a tall thin U | a doorway with nothing in it | 0.52 |
| Fitting | **Chair part** (N7) | `chair` | — | 3–6 | B | 1 | turned wood | held-item glint | 0.28 |
| Hardware | **Bracket** (L/T/gusset) | `bracket` | — | 1.2 | B | 1 | small angular | a black nothing until lantern-lit | 0.30 |
| Hardware | **Hinge / latch set** | `hinge` | — | 2.1 | B | 1 | small, two-plate | glints faintly | 0.32 |
| Hardware | **Lag bolt / pin** | `fastener` | — | 0.1 | A | 0 (pocket) | — | invisible; audible rattle | 0.15 |
| Hardware | **Fastener bag** (holds 12) | `fastener` | — | 0.6 | A | 0 (pocket) | pouch | invisible; audible rattle | 0.15 |
| Consumable | **Shim wedge** | — | — | 0.3 | A | 0 | wedge | invisible | 0.10 |
| Consumable | **Tallow tin** | — | — | 1.0 | A | 0 | cylinder | invisible | 0.12 |
| Consumable | **Felt pad** (N6+) | — | — | 0.4 | A | 0 | disc | invisible | 0.08 |
| **Tool** | Mallet, wrench, brace, plumb bob, drawknife, **handsaw** | — | — | 2–5 | **T** | **tool belt** | held, distinctive | held-item glint | 0.25 |
| Body | **A camper** | — | — | 54–88 | E | 4 | — | — | continuous scrape |
| Body | **Hearth stone** (cut, N6) | `fitting` | — | 140 | E | 4 | a boulder that is too square | a wrong rock | 1.00 |

### 6.2 Carry slots — the arithmetic, fixed

v1.0 said "4 carry slots (two hands, one shoulder = 2 slots, one belt loop)", which does not sum
to 4 under any parse; then said two class-C parts fit in 4 slots while listing class C as 3 slots
each; then gave class D all 4 slots, which meant a beam and a mallet could not coexist and every
structural haul silently became two round trips. All three are fixed:

**The player has 4 part slots and a separate 3-capacity tool belt.**

| Carry class | Mass band | **Part slots** | Speed × | Turn rate × | Crouch? | Sprint? | Footstep noise × |
|---|---|---|---|---|---|---|---|
| A (pocket) | < 1.5 kg | **0** (pocket cap 12) | 1.00 | 1.00 | yes | yes | 1.00 |
| B (one-hand) | 1.5–8 | **1** | 0.96 | 0.95 | yes | yes | 1.05 |
| C (two-hand) | 8–35 | **2** | 0.82 | 0.72 | yes (0.72×) | no | 1.35 |
| D (shoulder) | 35–70 | **4** | 0.63 | 0.48 | **no** | no | 1.90 |
| end-lift (N5 panel) | 71, pivoting | **4** | **0.52** | 0.30 | no | no | 2.20 + continuous scrape from the trailing end |
| E (drag) | > 70 | **4** | 0.34 | 0.30 | no | no | 2.60 + continuous scrape |

- **The tool roll is not a carry slot.** Mallet, wrench, brace, plumb bob, drawknife and handsaw
  live on a dedicated belt of capacity 3 and are always available. You are never forced to choose
  between the beam and the hammer, because that choice produced two round trips per structural
  part and doubled every haul in a night budget that could not absorb it.
- **Two class-C parts fit** (2 + 2 = 4) and stack multiplicatively: `0.82 × 0.82 = 0.672`. This is
  what makes `partsPerTrip = 2` in §5.2 true for class C.
- Class D and end-lift fill all four slots. One structural part per trip. That is correct and
  intended; it is the reason the map puts pallets at 12–26 m.
- Class E (a body, the hearth stone) fills all four slots *and* locks the tool belt — you cannot
  hold a hammer while dragging a person. That is the only place the belt is taken away.

### 6.3 Slots: the build graph

`CabinSite.js` owns the plot and publishes the slot layout; `BuildSystem.js` owns correctness.
A blueprint is a directed acyclic graph of `fixed` slots, plus — new in v2.0 — an escape hatch
for Night 5.

```js
Slot = {
  id: 'J-04',
  kind: 'fixed',            // 'fixed' | 'freeform'   ← new in v2.0, see §6.7
  stage: 2,
  acceptsType: 'joist',     // coarse gate; LENGTH-AGNOSTIC (see G4, §6.8)
  partId: 'JST-04',         // ← new in v2.0. The exact part this slot wants.
  transform: { position: Vector3, quaternion: Quaternion },
  axis: 'x' | 'y' | 'z',
  yawCandidates: 4,         // ← new in v2.0. Discrete snap orientations, k ∈ {2, 4}
  symmetryOrder: 2,         // how many of the k candidates are CORRECT
  requires: ['P-01','P-02'],// slot ids that must be filled AND torque >= 0.5
  fasteners: 3,             // how many pocket fasteners this join consumes
  ratedMass: 180,
  mirrorOf: 'J-03' | null,
  hidden: false,            // not drawn in the diagram (grammar G3)
  errata: false,            // the printed diagram for this slot is wrong (G6)
  anchorRuin: 'RS-07' | null// ← new in v2.0. Night 6 validates against this, §12.6
}
```

**Rules:**

- A slot becomes **snappable** only when every id in `requires` is filled with `torque >= 0.5`.
  Un-met dependencies render the ghost in `#d92b2b` at 15% opacity and refuse the place.
- **Snap radius 0.65 m.** Inside it, the carried part ghosts into the slot transform. Outside, the
  part is a free physics body (§10.3).
- **Orientation snaps to discrete candidates, not to a continuous tolerance.** See §6.4 — this is
  the single most important schema change in v2.0 and it is what makes "Rotated" reachable at all.
- Removal (`build:remove`) is always allowed, costs **8 s**, and emits
  `noise:emit { kind:'wrench', radius: 24, intensity: 0.45 }`. Undoing is loud.
- `partId` binds the manifest to the graph. Without it, "wrong slot" was undefined: if a slot
  accepts joists and you put a joist in it, it was correct by construction. Now `acceptsType`
  gates what will *physically* seat, and `partId` decides whether it belongs there.

### 6.4 The correctness model — five outcomes

Every `build:place` resolves to exactly one of **five** outcomes (v1.0 said four and had no
outcome for running out of fasteners mid-join). `correct` in the event payload is `true` only for
**Seated**.

| Outcome | Test | `correct` | Base wrongness `w` | Immediate feedback | Ongoing consequence |
|---|---|---|---|---|---|
| **Seated** | right `acceptsType`, right `partId`, yaw is one of the `symmetryOrder` correct candidates, fasteners sufficient | `true` | 0.00 | soft *thunk*, `audio:sfx { id:'join_seat' }` | none. **A correct cabin is silent forever.** |
| **Under-fastened** | as Seated, but `held < slot.fasteners` | `false` | `0.20 × (1 − held/required)` | seats with a *hollow* thunk — same sample, `rate: 1.18`, −4 dB, 40 ms shorter tail | `torque` capped at `0.5 + 0.5 × (held/required)`. Fully repairable by returning with fasteners: `build:place` on a filled slot with fasteners in pocket tops it up in 3.0 s, silently. |
| **Rotated** | right part, right slot, yaw is one of the `k − symmetryOrder` **incorrect** candidates | `false` | 0.35 | seats, with a 6 mm visible offset and a 0.4 s grinding tail | creaks; offsets the *next* dependent slot's ghost by 6 mm so the error compounds visibly down the graph |
| **Wrong slot** | right `acceptsType`, **wrong `partId`**, dependencies met | `false` | **0.45** | seats normally; no audible difference for **90 s** | the part it belonged in can never be seated; a later stage is short one part. See §6.4.1 for the grace window that makes this diagnosable. |
| **Wrong part** | wrong `acceptsType`, forced (§4.1, 3.0 s hold) | `false` | 1.00 | wood splits: `audio:sfx { id:'join_split' }` + `noise:emit { kind:'impact', radius: 30, intensity: 0.60 }` | 1.0 wrongness. **Repairable via Recut (§7.4)** — v1.0 made this permanent and unfixable, which is what turned one forced part into an unplayable run. |

**Wrong part cannot be placed by accident.** The ghost refuses; the player must hold place for
**3.0 s** (raised from v1.0's 1.4 s, which was inside the range of an impatient press). The hold
has a visible mechanical tell — the part grinding against the slot, the hands shaking — and
releasing at any point aborts with no cost.

#### 6.4.1 Why "Wrong slot" needed fixing, and how

v1.0 promised Wrong slot gave "**no negative feedback at all**" and produced a diagnostic puzzle
you solved two stages later. Its own creak formula falsified that 2.0 seconds later: `w = 0.60`
yielded `severity ≈ 0.78` and a **50 m radius creak** — the loudest sound in the game, immediately.
Both cannot be true. The fantasy is the better half, so the formula yields:

| Window after placement | Creak behaviour |
|---|---|
| 0 – 90 s | **silent.** `lambda = 0` for this join, unconditionally. |
| 90 – 240 s | creaks, but `severity` clamped to **0.45** and `radius` clamped to **30 m** — a symptom, not an alarm |
| 240 s + | normal model (§7.1); at `w = 0.45` this is `severity ≈ 0.70`, `radius ≈ 46 m` |

`w` also drops from 0.60 to **0.45**, because Wrong slot is a *reading* error, not a *forcing*
error, and the game should never punish reading errors harder than deliberate vandalism. The
90-second silence is the diagnostic window the design always claimed to have and never budgeted.

#### 6.4.2 Discrete yaw candidates — how "Rotated" becomes reachable

v1.0 specified "snap angle 28°" and defined Rotated as a yaw error at "a non-symmetric multiple."
A 180° error is 152° outside a 28° tolerance, so no ghost appears, so the part cannot be placed,
so **Rotated could never occur** — and then §11 of v1.0 said, in adjacent sentences, that placing
a part 180° off "is *possible*." The mechanic did not exist.

The fix removes the continuous test entirely:

```js
// BuildSystem, on entering snap radius:
const k        = slot.yawCandidates;              // 2 or 4
const step     = (Math.PI * 2) / k;
const nearest  = Math.round(carriedYawRelative / step) % k;   // 0..k-1
const isCorrect = nearest < slot.symmetryOrder;   // candidates [0, symmetryOrder) are correct
// The ghost renders IDENTICALLY for every value of `nearest`.
```

- The part snaps to the **nearest of `k` orientations**. There is no orientation at which the
  ghost refuses to appear.
- `symmetryOrder` of those `k` are correct. `symmetryOrder = k` means the part is genuinely
  symmetric and cannot be rotated wrong (used for all of Night 1's piers).
- **The ghost gives no orientation cue whatsoever** — same white outline, same opacity, same
  position, for a correct and an incorrect candidate.
- The *only* way to tell is the part itself: a chamfer, a bolt-hole pattern, a pencil mark, a
  grain direction. These read at **≤ 2.2 m under the lantern** and not at all beyond it. Checking
  a yaw costs you a lantern-on moment at the slot, which costs you §9.4.

That is the mechanic. It is a real decision (light up and check, or place and hope), it is
diagnosable, and it is the reason the manual's mirror glyph (G2) matters.

### 6.5 The seating check

On a successful snap, `BuildSystem` opens the seating check: hold the interact input; a value `p`
ramps **linearly** 0 → 1.0 over **`T_ramp = 3.0 s`**. A green band is centred at `p = 0.80`.

```
p = clamp01(t / 3.0)                    // LINEAR. v1.0's (t/2.2)^1.35 ease-in existed
                                        // for no stated reason and compressed the window.
band = [0.80 − h, 0.80 + h]
h    = { story: 0.150, standard: 0.075, gristle: 0.055 }[settings.difficulty]
```

**The window, in milliseconds** — the number v1.0 never published, and whose true value was
**277 ms** (a figure nobody had inverted):

| Difficulty | `h` | Band | **Window** | Frames @ 60 fps |
|---|---|---|---|---|
| `story` | 0.150 | [0.650, 0.950] | **900 ms** | 54 |
| `standard` | 0.075 | [0.725, 0.875] | **450 ms** | 27 |
| `gristle` | 0.055 | [0.745, 0.855] | **330 ms** | 20 |

**Input latency is budgeted, not ignored.** `BuildSystem` computes `p` from
`Input.lastEventTimestamp` — the timestamp on the pointer/gamepad release event — **not** from the
frame in which it was processed. A dropped frame costs you nothing. Total allowance: 120 ms
(§4.1). At `standard`, 450 ms window − 120 ms allowance = **330 ms of real player margin**, which
is a rhythm action, not a reflex test.

| Release at | `torque` stored | Result | Noise per turn |
|---|---|---|---|
| `p < band.lo` | `p × 0.9` | under-seated; contributes seating deficit `s` | 3 taps @ 0.30 |
| `p ∈ band` | `1.00` | **perfect join**; `stats.perfectJoins++` | 4 taps @ 0.35 |
| `p ∈ (band.hi, 0.96]` | `0.80` | over-torqued, cosmetic dimple | 5 taps @ 0.40 |
| `p > 0.96` | `0.50` + split flag | wood splits, instant severity-0.7 creak | 6 taps @ 0.55 + `impact` |

Every tap is a discrete `noise:emit { kind:'hammer', radius: 34, intensity: 0.30–0.55 }`.

**On thunder masking and the seating check.** v1.0 said: "Under thunder masking the player can
hold to `p = 0.88` at zero effective risk. Skilled play is timing your hammering to the storm."
The second sentence is right and the first describes a causal link that does not exist — masking
suppresses *audibility*, and has no relationship to where you release. `0.88` is the top of the
band with or without thunder. What was presumably meant, and what is now binding:

> **Under masking (§7.5), you may hammer at all. Without it, every tap is a 34 m broadcast.**
> The skill is not *where* you release, it is *when you start the hold* — because a 3.0 s ramp
> plus 4 taps must fit inside a thunder envelope, and on Night 6 that envelope has a floor of
> 6.0 s. Starting a seating check with 2 seconds of thunder left is the mistake.

### 6.6 Fasteners: legibility and the fifth outcome

Night 7's shortfall in v1.0 was "a fastener bag that is *short by 3*" in a game that never
displayed how many fasteners the player held. Fixed:

- **The manual is the inventory display.** The manifest panel draws one small circle per fastener
  the stage requires: **filled** for each one in the pocket, **open** for each one missing. No HUD
  number, no counter, no text. Opening the manual is already a reflex, so this costs nothing new.
- A pocket holds **12 fasteners** (`carry class A`, cap 12). A `fastener bag` is 12 loose ones.
- `Slot.fasteners` (1–4) is consumed on a successful seat.
- Placing with `held < slot.fasteners` produces **Under-fastened** (§6.4), not a refusal. The game
  never blocks you for want of hardware — that would make the shortfall comedy into a wall.
- Returning to an under-fastened join with fasteners in pocket tops it up: 3.0 s, silent, and `w`
  goes to 0. It is the only fully forgiving repair in the game.

### 6.7 `freeform` slots — the Night 5 escape hatch

`STORY.md §4` Night 5 requires a placement with "**no snap points and no correct answer, only a
working one**", and fires `build:place { correct: true }` for a join the manual never specified.
The v1.0 DAG forbade this outright. A second slot kind makes it legal without touching any event:

```js
FreeformSlot = {
  id: 'RIG-N5',
  kind: 'freeform',
  acceptsType: null,               // accepts ANY carriable world object
  bounds: Box3,                    // the volume in which the arrangement is evaluated
  goal: {
    type: 'support',
    target: 'W-NORTH',             // the north wall panel's fixed slot
    minUpwardForce: 340,           // newtons the arrangement must supply
    minHeight: 2.05,               // metres the free end must be held above
    minDurationSeconds: 8.0        // continuously, hands-free
  }
}
```

- Correctness is a **physical predicate evaluated by `Physics.js`**, not a transform comparison.
  Any arrangement of world objects that holds the panel's free end above 2.05 m for 8 continuous
  seconds with the player's hands empty passes.
- When the predicate holds and the player pins the panel, `BuildSystem` emits
  `build:place { part: <panel>, slot: <W-NORTH>, correct: true }`. The event contract is unchanged.
- **There is no ghost, no highlight, and no hint** on a freeform slot. `puzzleHints: 'generous'`
  (§16.3) adds exactly one thing: the manual draws the counterweight rectangle from
  `STORY.md §3` panel 5.7 with its 71 kg number, which is a *clue*, not a solution.
- Objects that can bear load: the canoe (Dale's, from the rack at 84 m), rope (tool shed, 131 m),
  the ladder (boathouse, 96 m), any stump, any placed cabin part, the hearth stone.
- The first single-handed attempt is a **scripted, unpunished failure**: the panel seats one end,
  the other falls, `build:remove` is free and silent, and no `w` is recorded. The manual told you
  it needs two persons. The game is allowed to let you find that out.

### 6.8 The seven grammars

`Blueprint.js` generates a wordless exploded axonometric per stage (spec: §8). The player reads it
in `BlueprintUI.js` — flat, bright, Helvetica-alike, thin black line art, one red accent
(`ART_DIRECTION.md §8`), over the wet dark world. **Opening the manual does not pause the game**,
and costs the 0.9 s hand-wipe.

**Symbol vocabulary** (the complete set — `Blueprint.js` draws nothing else; arrow forms are
constrained by `ART_DIRECTION.md §8.5`):

| Glyph | Meaning |
|---|---|
| Thin arrow, straight | insert along this vector |
| Thin arrow, curved | rotate this many degrees (arc length encodes angle) |
| The little masked man | scale reference (1.7 m) AND the "you are here" viewpoint indicator |
| Masked man with hand raised | "two persons required" — you are alone; means *heavy* |
| Circle with number | step order |
| Circle with number, dashed | step order is **not** enforced |
| Mirror glyph (⧗ over dashed axis) | grammar G2 in effect for this figure |
| Dotted outline | a part that exists but is occluded in this view (G3) |
| Bag icon with count | hardware manifest for the stage |
| **Ring of small circles, filled/open** | fasteners held vs required (§6.6) |
| Red exclamation triangle | over-torque warning at a specific join |
| Red slash-circle | the forbidden variant (usually the one that looks correct) |
| Small telephone icon | the payphone at (84, 154). Learning this is a Night 6 beat. |
| **Article number** (`0000-000`) | the only text besides `HJEM`. Not random — see `STORY.md §3`. |

| # | Grammar | What the player must do | Intro | Failure mode it creates |
|---|---|---|---|---|
| **G1** | **Direct axonometric** | Read a 1:1 exploded view; map diagram-space to world-space by matching the masked man's viewpoint to your own. | N1 | Placing from the wrong side of the plot → Rotated |
| **G2** | **Mirroring** | The figure shows the *left* assembly only, with a mirror glyph. The right is its reflection; bracket handedness flips. | N2 | L-brackets handed wrong → Rotated on every join of the mirrored half |
| **G3** | **Implied hidden parts** | The bag icon says 8 gussets; the drawing shows 6. Two are behind visible geometry. | N3 | Two unplaced gussets → understrength join → high `L` → chronic creaking |
| **G4** | **Ambiguous scale** | **Beam (3.2 m) and Beam-short (2.6 m) share `acceptsType: 'beam'`** and differ only in length. No dimensions printed. The only scale reference is the masked man at 1.7 m — the player's own eye height. | N4 | Wrong slot: the 2.6 seats in a 3.2 slot and the far end floats. Diagnosed a stage later, via §6.4.1's 90 s window. |
| **G5** | **Sequence dependency** | Numbered steps are *out of drawing order*. Some slots become unreachable if you fill a neighbour first (a panel blocks arm access to a bracket behind it). | N5 | A blocked slot forces an 8 s loud `build:remove` |
| **G6** | **Deliberate errata** | One printed step is wrong. An **errata slip** exists as a findable world object. Without it, building as printed caps that join at `w = 0.35`. With it, `BlueprintUI` stamps a red correction. | N6 | Trusting the manual. The manual is confidently, serenely incorrect. |
| **G7** | **Cross-reference / continuation** | A figure ends in "see fig. 4b" — on *tomorrow's* sheet. A slot is deliberately left open across a night boundary; leaving it open is correct. | N6 | Filling the deferred slot → Wrong part → 1.0 wrongness on the ridge |

**G4 was impossible in v1.0** and this is why it is called out above: v1.0's §2.4 required "two
beams differing only in length (3.2 m vs 2.6 m)" while its own part table listed exactly one beam,
with the 2.6 m part being a **Joist** — a different `acceptsType`, which the slot would reject, so
the grammar could never fire. `Beam-short` now exists, shares `acceptsType: 'beam'`, and
`acceptsType` checks are **length-agnostic** by contract. Length is a `length` field, checked only
by `partId`.

**Night 6 uses all seven simultaneously** on one fold-out sheet, because Night 6 is where the
manual breaks. Night 7 has no grammar; it has one dotted outline (`STORY.md §3`).

### 6.9 The missing-hardware comedy engine

Every stage generates a **manifest**: the exact parts and fasteners it consumes. Then
`Blueprint.js` removes some.

| Night | Shortfalls | Constraint | The actual item (`STORY.md §4`) |
|---|---|---|---|
| 1 | 1 | Tier 1. Teaches the loop. | **one shim** — the folded 1961 licence plate under the stump at 30 m |
| 2 | 1 | Tier 2, from a step at ≥ 40% stage progress | **bracket H** — four needed, three in the pile |
| 3 | **0** | `STORY.md §4`: "nothing is missing" | — the ridge beam is 340 mm too long instead (§7.6) |
| 4 | 1 | Tier 3, inside the lit perimeter | **three brass hinges** off the boathouse door at 96 m |
| 5 | 1 | **not an object** | **a second person.** Unobtainable by design. Resolved by rigging (§6.7). |
| 6 | 2 | one is an errata slip; one **does not exist** | **article 0000-000** (never in the world) + the errata slip |
| 7 | 1 | not an object | **the person in the chair.** See §12.7. |

**Never:** the shortfall may not be the first part of a stage, and may not be a part the player has
already correctly installed elsewhere.

**How the game hints.** Three layers, escalating, all diegetic:

1. **t = 0.** The manual's manifest shows the item with a red outline and a small **map inset** —
   a 40 × 40 m thumbnail of terrain contour only, no labels. It shows the *region*, never the
   object.
2. **t = 90 s after `tool:missing`.** `AudioEngine` begins a **1.8 s periodic** cue at the item's
   position, attenuated normally by distance and occlusion — audible from ~35 m. The cue is
   **material-appropriate**, which v1.0 got wrong by playing a metallic tick on an errata slip
   (paper) and a fastener bag (cloth):

   | Item material | Cue | `audio:sfx { id }` | Diegetic reading |
   |---|---|---|---|
   | metal (bracket, hinge, tool) | 1.8 s metallic tick | `hardware_tick_steel` | wind moving metal |
   | paper (errata slip) | 1.8 s flutter, 3 leaves | `hardware_tick_paper` | wind moving a weighted page |
   | cloth (fastener bag) | 1.8 s dry rattle | `hardware_tick_cloth` | wind rocking a bag of bolts |
   | stone (the shim, the hearth) | **no cue** | — | stone does not move in wind. Night 1's shim is found by reading the contour inset, which is the lesson. |

3. **t = 240 s, and only if `settings.puzzleHints !== 'off'`.** A 0.4-intensity rim highlight,
   visible through one layer of foliage, within 20 m.

**Items that cannot be hinted:** Night 5's second person and Night 6's article `0000-000` never
enter this ladder at any layer. §12.6 specifies how the game releases a player who is searching
for something that is not there.

**How finding it feels.** On pickup: `tool:found`; a single clean bell (`hardware_chime`, a struck
2.1 kHz sine, 1.4 s decay); the manual's red outline redraws in black with a tick;
`ui:toast { text:'', icon:'checkbox-filled' }` — an empty checkbox filling in, with no words.
That is the whole reward. (v1.0 called this bell "the only non-diegetic sound in the game." It is
not; see §11.4 for the complete list of three.)

---

## 7. THE CREAK SYSTEM

The consequence engine. Owned by `BuildSystem.js`, evaluated per **join** (a filled slot).
Synthesis is specified in `AUDIO_DIRECTION.md §4.11`; this section owns *when* and *how loud*.

### 7.1 The formula

Per join, per **creak tick** (every 2.0 s, staggered so no more than 6 joins evaluate per frame):

```
w  = wrongness   // 0.00 Seated | ≤0.20 Under-fastened | 0.35 Rotated | 0.45 Wrong-slot | 1.00 Wrong-part
s  = 1 - torque                                     // seating deficit, 0..1
L  = supportedMass / ratedMass                      // load factor, clamped [0, 2.5]
Mw = 1 + 0.60*wind + 0.20*rain                      // weather stress (from weather:change)
Mt = 1 + 0.50*timeOfNight                           // cold contraction as the night deepens
Md = 1 + 0.25*creakDebt                             // §7.2

lambdaRaw = 6.0 * (w + 0.30*s) * (0.40 + 0.90*L) * Mw * Mt * Md   // creaks per minute
lambda    = min(lambdaRaw, PER_JOIN_CAP)                          // ← new in v2.0
P(tick)   = 1 - exp(-lambda * 2.0 / 60)
```

A perfectly Seated, perfectly torqued join has `w = 0`, `s = 0` → `lambda = 0`. **A correct cabin
is silent forever.** This must be true; it is the reward for reading the manual, and it is what
makes the total silence of the finished house on Night 7 (`STORY.md §8`) land.

### 7.2 The caps — why v1.0 was a death spiral

v1.0 called forcing a Wrong part "a deliberate, punished choice… **That decision is the game.**"
Run its numbers at Night 4 weather (wind 0.60, rain 0.75 per `ART_DIRECTION.md §4.5`),
`timeOfNight` 0.5, `L = 1.0`, `w = 1.0`, `s = 0.5`:

```
Mw = 1 + 0.60(0.60) + 0.20(0.75) = 1.51
Mt = 1.25 ,  Md = 1.25 (at creakDebt 1.0)
lambdaRaw = 6.0 × 1.15 × 1.30 × 1.51 × 1.25 × 1.25 = 21.2 creaks/min
```

One creak every **2.8 seconds**, `severity` clamped to 1.0, `radius = 60 m`, **for the rest of the
game** — because v1.0 made Wrong-part permanent, unshimmable below 0.55, and carried wrong joins
forward to Night 7. One forced part on Night 2 made Nights 3–7 unplayable. Three caps and a repair
verb fix it:

| Cap | Value | Effect |
|---|---|---|
| **`PER_JOIN_CAP`** | **1.5 creaks/min** | The worst possible join speaks once every 40 s. Tense; not a siren. |
| **`CABIN_CAP`** | **4.0 creaks/min** total across all joins | When `Σ lambda > 4.0`, every join's `lambda` is scaled by `4.0 / Σ lambda`. A bad cabin is a *worse* cabin, not a continuous alarm. |
| **`creakDebt` decay** | **0.15/min** (v1.0: 0.02/min) | See §7.3 — this is what stops one error from saturating the cascade counter. |
| **Recut** | §7.4 | A Night-1-available repair that clears `w = 1.0`. |

The 21.2 → 1.5 clamp is not a nerf of the *idea*; forcing a Wrong part still means a 60 m groan
every 40 seconds until you fix it, on a night where the nearest counselor's hearing threshold is
0.11. It is still the worst thing you can do. It is simply survivable, which is the difference
between a punishing mechanic and a broken one.

**On a hit:**

```
severity  = clamp01(0.25 + 0.55*w + 0.30*s + 0.20*min(L, 1.5))
radius    = 14 + 46*severity              // metres, 14 .. 60
intensity = severity
```

Wrong-slot joins additionally obey the §6.4.1 grace clamps for their first 240 s.

Emits, in this order:

```js
bus.emit('build:creak', { position, severity });
bus.emit('noise:emit', { position, radius, intensity, kind: 'creak' });
bus.emit('audio:sfx',  { id: severity > 0.7 ? 'creak_groan' : 'creak_tick', position,
                         rate: 0.8 + 0.5*(1 - severity) });
```

`ProceduralSFX` synthesizes creaks as a filtered-noise stick-slip model per
`AUDIO_DIRECTION.md §4.11`; severity maps to lower centre frequency (1600 → 240 Hz) and longer
envelope (0.12 → 1.9 s). Per-family voice cap: **3 simultaneous creaks**
(`AUDIO_DIRECTION.md §9.1`) — which the `CABIN_CAP` above now guarantees is never exceeded even
during a cascade.

### 7.3 Compounding — "creak debt"

`creakDebt` is a per-night scalar on the *cabin*, not per join.

| Rule | v1.0 | **v2.0** | Why |
|---|---|---|---|
| Accrual | `+= 0.06 × severity` | **`+= 0.10 × severity`** | raised, so a genuinely bad cabin still cascades |
| Decay | `−0.02 /min` | **`−0.15 /min`** | v1.0's decay was 7.5× too slow to matter |
| Clamp | [0, 3.0] | [0, 3.0] | unchanged |
| Cascade threshold | 1.2 | 1.2, **+ 180 s cooldown** | so it cannot machine-gun |
| Carryover | 40% | 40% | unchanged |

**Run the numbers that matter** (this is the check v1.0 never did):

| Cabin state | Σ lambda (capped) | Accrual/min | Net vs 0.15 decay | Cascade? |
|---|---|---|---|---|
| One Rotated joist, Night 2 | 1.5 | `1.5 × 0.10 × 0.64` = **0.096** | **−0.054** | **never.** One mistake is not a spiral. |
| Two Rotated + one Wrong-part, Night 4 | 4.0 (capped from 4.5) | `4.0 × 0.10 × 0.75` = **0.300** | **+0.150** | at 1.2 → **8 minutes**. Reachable on a bad night. |
| Five bad joins, Night 6 storm | 4.0 (capped from ~19) | ~**0.340** | **+0.190** | ~6.3 min. This is the intended climax. |

So: **one error never cascades; three errors on a wet night do.** In v1.0, a single Rotated joist
accrued 0.177/min against 0.02/min decay and saturated the 3.0 clamp inside one night,
*guaranteed* — which meant "the settle cascade" fired routinely from one mistake instead of being
a climax.

**The cascade:** at `creakDebt > 1.2`, `BuildSystem` fires 3–5 joins within 1.5 s (radii summed,
capped at 60 m), and asks `Weather` for a gust to cover it. Then a **180 s cooldown**. See §19 row
A6 for its acceptance test.

`creakDebt` carries **40%** into the next night via `stats.creakDebtCarry`.

### 7.4 Mitigation — including the repair verb v1.0 did not have

| Mitigation | Cost | Effect | Notes |
|---|---|---|---|
| **Top up fasteners** | 3.0 s, silent, needs fasteners | Under-fastened → `w = 0` | the only free repair |
| **Re-seat** (`build:remove` + re-place) | 8 s + 3.0 s, `wrench` 0.45 | resets `torque`; does not fix `w` | the honest fix for a seating deficit |
| **Shim wedge** (class A) | 1 shim, 2.5 s, silent | `s −= 0.35` (floor 0); `w −= 0.15` for Rotated / Wrong-slot | the cheat everyone loves; shims are scarce (§11.1) |
| **Tallow tin** (class A) | 1 tin, 3.0 s, silent | `lambda × 0.45` for **150 s** on all joins within 3 m | strictly temporary; buys you one haul |
| **Felt pad** (N6+) | 1 pad, 4.0 s | `radius × 0.55` on that join, permanently | reduces the *noise*, not the creak |
| **RECUT** ← new in v2.0 | see below | **`w → 0.10`** on any join, including Wrong-part | the honest fix for a catastrophe |
| **Thunder masking** | free, requires timing | §7.5 | the skill ceiling |

#### RECUT — available from Night 1

The handsaw has been in the tool roll since Night One (§0.2, conflict C4). Recut is what it is for,
and Night 3's ridge-beam cut is a variation on a verb the player already owns.

| Property | Value |
|---|---|
| Availability | **Night 1**, every night, every join |
| Requires | the handsaw (tool belt) **and 1 sistering board** (class C, from the woodpile at 46 m) |
| Duration | **62 s** = 8 passes × 5.2 s, with a 2.5 s minimum gap between passes |
| Interruptible | **yes.** `sawProgress` persists on the join; walk away and come back. |
| Noise | `noise:emit { kind:'saw', radius: 90, intensity: 0.62 }`, continuous **only while a pass is active** |
| Result | `w → 0.10`, `torque → 0` (you must then re-seat: +3.0 s) |
| Refused when | any slot in this slot's dependents is filled — remove them first |

`w = 0.10` rather than 0.00 because you cannot unmake a split: you cut back to sound timber and
sister the join, and it will always be very slightly the worse for it. At `w = 0.10`, `s = 0`,
`L = 1.0`, Night 6 storm weather, `lambda = 6.0 × 0.10 × 1.30 × 1.71 × 1.4 × 1.0 = 1.87` → capped
to 1.5. **A recut join still creaks.** It is a scar, and the cabin is a record of your reading
comprehension (§12.8) — it is simply no longer a run-ending one.

### 7.5 Thunder masking — and why it is Night 6

**`ART_DIRECTION.md §4.5` is canon on weather (§0.2, conflict C2). Night 6 is the storm; Night 5
is the whiteout-fog night.** v1.0 put the storm on Night 5, made masking "mandatory" there, and
gave it **6 strikes in 1020 s**. Run those numbers:

```
envelope   = 2.5 + 3.5 × (1 − distance/4.2),  distance ∈ [0.4, 4.2] km  →  2.5–5.67 s, mean 4.1 s
total masking available all night = 6 × 4.1 = 25 seconds
truss joins needing hammering     = 22 × ~2.2 s of hold = 48.4 s
mean gap between strikes          = 1020 / 6 = 170 s
```

25 seconds of cover for 48 seconds of work, with a 170 s average wait that v1.0's own time-cost
table listed as "20–90 s" — understating it by 2–8×. The mechanic was unavailable in the night
that declared it mandatory. `ART_DIRECTION.md` had already solved this by putting the storm on
Night 6 with "lightning every 25–60 s"; this document simply now agrees.

**Night 6 storm schedule**, owned by `Weather.js`, seeded from `ctx.rand`:

| Property | Value |
|---|---|
| Night length | 1400 s |
| Strike interval | `rand.range(25, 60)` s → **~33 strikes** |
| Clustering | three storm cells at `timeOfNight` ≈ 0.15, 0.45, 0.78; interval is `×0.7` inside a cell, `×1.6` between |
| Envelope floor | **6.0 s** (raised from a 2.5 s floor — a 3.0 s ramp plus 4 taps must fit) |
| Envelope | `6.0 + 4.0 × (1 − distance/4.2)` → **6.0–9.8 s** |
| Total masking available | ~33 × 7.6 s ≈ **250 s** |
| Guarantee | `Weather.nextStrikeIn()` returns **≤ 45 s** whenever the player is holding a seating check on an un-torqued join. Enforced, not emergent. |

Night 6 has 17 slots. 17 × ~5.5 s of hold-plus-taps = 94 s of exposed work against 250 s of
available cover, in windows guaranteed to arrive within 45 s. That is a mechanic you can plan
around, which is the definition of a skill.

**Sequence per strike:**

1. **Flash.** `Sky.js` fires it; `Materials.globalUniforms.uLightning` spikes. See §9.4 for what
   the flash does to you — it is not what v1.0 said.
2. **Delay.** `thunderDelay = distance_km × 2.9 s`, distance from `rand.range(0.4, 4.2)` →
   **1.16 to 12.18 s**. The player learns to count. This is a genuine skill: the flash tells you
   how long you have before the cover arrives.
3. **Thunder envelope.** `maskLevel()` ramps 0 → 0.85 over 0.4 s, holds for the envelope duration,
   decays over 1.2 s.
4. `NoiseSystem.js` multiplies every noise's effective intensity by `(1 − maskLevel())` before
   propagation. It does **not** shrink the radius — the noise exists, campers just don't resolve it.

```js
Weather.nextStrikeIn()   // seconds until the next flash, or Infinity
Weather.maskLevel()      // 0..1, current global audibility suppression
```

**The constant floor** — this is what makes every other night workable:

```
maskFloor = 0.30 * rain + 0.22 * wind
maskLevel = max(maskFloor, thunderEnvelope)
```

| Night | rain | wind | **maskFloor** | Character |
|---|---|---|---|---|
| 1 | 0.15 | 0.20 | **0.089** | almost nothing. Every sound you make is yours. |
| 2 | 0.40 | 0.35 | **0.197** | drizzle helps a little |
| 3 | 0.10 | 0.55 | **0.151** | **wind, not rain** — and the saw needs it (§7.6) |
| 4 | 0.75 | 0.60 | **0.357** | real rain; the loudest night is the safest to be loud in |
| 5 | 0.25 | 0.30 | **0.141** | fog hides you visually and not at all audibly |
| 6 | 0.90 | 0.85 | **0.457** + thunder | the storm |
| 7 | 0.05 | 0.10 | **0.037** | dead still. Nothing covers you. Nothing needs to. |

Rain also raises creak probability via `Mw` — **the weather that hides you is the weather that
makes the cabin talk.** That trade is the whole weather design, and the mask floor table above is
what makes it a real trade rather than a slogan.

### 7.6 The saw — Night 3's sustained-noise budget

`STORY.md §4` Night Three: nothing is missing, but the **ridge beam is 340 mm too long** and must
be cut. "You cannot rush a saw. The monster is hostage to the physics of a saw."

| Property | Value |
|---|---|
| `noise:emit` | `{ kind: 'saw', radius: 90, intensity: 0.62 }`, continuous while a pass is active |
| Pass | **5.2 s** of held input; 4 strokes; `sawProgress += 1/14` |
| Passes required | **14** (ridge beam, 71 kg, 5.14 m → 4.80 m) |
| Minimum gap | 2.5 s between passes (the saw binds if you rush; a rushed pass gives 0.5 progress and a `bind` transient) |
| Persistence | `sawProgress` is stored on the part and survives leaving, hiding, and the night boundary |
| Total sawing | 14 × 5.2 = **73 s of noise**, budgeted at 200 s wall-clock in §5.3 to cover the waiting |

**Effective reach against a counselor.** This is the number that makes the mechanic playable, and
it is derived, not chosen. Counselor hearing threshold 0.11 (§9.2); Night 3 `maskFloor = 0.151`;
assume one tree trunk between (`occlusion = 0.88`):

```
heard(d) = 0.62 × (1 − d/90)^1.5 × 0.88 × (1 − 0.151)

d = 40 m → 0.62 × 0.5443^1.5 × 0.88 × 0.849 = 0.186   HEARD
d = 50 m → 0.62 × 0.4444^1.5 × 0.88 × 0.849 = 0.137   HEARD
d = 55 m → 0.62 × 0.3889^1.5 × 0.88 × 0.849 = 0.112   HEARD (just)
d = 60 m → 0.62 × 0.3333^1.5 × 0.88 × 0.849 = 0.089   not heard
```

**You may saw when no counselor is within ~57 m.** That is the budget. `Campers` patrol loops on
Night 3 bring someone inside 57 m of the plot roughly every 70 s for about 25 s, which gives the
player windows of ~45 s — enough for 5–6 passes if they read the torches, 2 if they panic. Three
clean windows finishes the cut.

**The ridge at (−58, 4) is 58 m from the plot** and 11 m up (§3.4). Sawing while a counselor
stands on the ridge is audible. Sawing while one walks the fire road at 62 m is not. The map is
the mechanic.

---

## 8. `Blueprint.js` — PROCEDURAL TECHNICAL ILLUSTRATION

v1.0 gave this one sentence: "`Blueprint.js` generates a wordless exploded axonometric per stage."
It is 100% of the game's identity and it had less specification than the shim wedge. It is also
the single hardest technical problem in the project: procedural technical illustration with
hidden-line removal, arrow routing, page packing, and a per-panel authorship style — for 90 slots
across seven grammars.

**This section is the minimum contract. It needs its own document (`BLUEPRINT.md`, Build agent),
and this is the spec that document must satisfy.**

### 8.1 API

```js
Blueprint.forNight(n, rand) → {
  stages: [ Stage ],
  manifest: { partId → { count, tier, position } },
  grammars: ['G1','G2', ...],
  shortfalls: [ { partId, tier, hintable: bool } ],
  errata:  [ { slotId, printedTransform, correctTransform } ] | null,
  authorship: { panelId → 'marit' | 'ansel' },   // ← required by STORY.md §3; absent in v1.0
  cover: { word: 'HJEM', makersMark: 'VIK & SØN' }
}

Stage = {
  index, slots: [slotId], figures: [ Figure ], page: PageLayout
}

Figure = {
  id, projection, parts: [ { partId, explodeVector, silhouettePx } ],
  arrows: [ Arrow ], stepNumber, dashed: bool, glyphs: [ ... ],
  authorship: 'marit' | 'ansel'
}
```

`Blueprint` **draws nothing**. It emits geometry and layout; `BlueprintUI.js` rasterises to
canvas. That split is what lets the illustration be regression-tested headlessly (§8.6).

### 8.2 Projection

**Dimetric, 7° / 42°.** Chosen because it is the flat-pack convention (both IKEA and the
mid-century Scandinavian assembly diagrams `STORY.md` is drawing from), it keeps verticals
vertical, and it makes the two horizontal axes visually distinguishable — which G1 depends on,
since the player must match the masked man's viewpoint to their own.

```
axisX_screen = ( cos(7°),  −sin(7°))  ×  scale
axisZ_screen = (−cos(42°), −sin(42°)) ×  scale
axisY_screen = ( 0,        −1.0     ) ×  scale
```

The masked man is drawn at the figure's origin, 1.7 m tall in the same projection, always facing
the −Z screen axis. **His facing is the "you are here" indicator**: the player must stand so their
own view of the plot matches his.

### 8.3 Hidden-line removal

Required, non-negotiable — an exploded axonometric with no HLR reads as wireframe soup and
destroys G3 (implied hidden parts), which depends on the player reasoning about occlusion.

- Build a **BSP tree** of the stage's assembled hull (the parts already placed plus the parts this
  figure explodes), in figure space, once per stage.
- Each part's silhouette edges are clipped against the BSP. Fully-occluded segments are dropped;
  partially-occluded segments are split.
- **G3 exception:** parts marked `hidden: true` are drawn with a *dotted* outline through the
  occluder rather than dropped, at line weight `w1` (`ART_DIRECTION.md §8.2`). That dotted outline
  is the grammar's only signal.
- Budget: the BSP is built at stage transition, off the critical path, in ≤ 8 ms.

### 8.4 Explode vectors, arrows, and page layout

**Explode vector** per part: `slotNormal × (1.4 + 0.3 × graphDepth)` metres in figure space, where
`graphDepth` is the part's depth in the `requires` DAG. Deeper parts fly further, so the assembly
order reads outward-in without any numbering. Collisions between exploded parts are resolved by
pushing along the secondary slot axis in 0.15 m steps, max 6 iterations.

**Arrow routing** is A* on a page grid:

| Property | Value |
|---|---|
| Grid | 4 px cells over the page bitmap |
| Obstacles | every drawn silhouette, dilated by **6 px clearance** |
| Cost | `1.0` per cell, `+2.4` per direction change, `+8.0` per crossing of another routed arrow |
| Arrow forms | straight and single-arc only (`ART_DIRECTION.md §8.5` closed set) |
| Failure | if A* fails, the figure is re-laid-out at 0.9× scale and retried, up to 3 times; then the figure splits into two figures |

**Page layout** is a **guillotine packer** (shelf-first, then best-fit-decreasing) over 3–8 figures
per spread. Night 6 is the exception: one fold-out spread carrying all seven grammars, packed at
2 × page width, scrollable horizontally in `BlueprintUI`.

**The legibility invariant (binding):**

> **Every part's silhouette occupies ≥ 40 px of its longest dimension at 1080p, at
> `manualContrast` default, on every figure it appears in.**

If the packer cannot satisfy it, the stage's figures split across two spreads rather than shrink.
A manual you cannot read is not a difficulty setting, it is a bug. §19 row A9 is its test.

### 8.5 Authorship — the linework tell

`STORY.md §3` makes this the actual narrative arc, and v1.0's `Blueprint.forNight()` signature
did not return it. It is now a required field.

| | **Marit's hand** | **Ansel's hand** |
|---|---|---|
| Stroke | single confident pass | doubled-back, 2–3 passes |
| Jitter | 0.4 px RMS, low-frequency | **1.9 px RMS**, high-frequency |
| Corners | closed, clean | overshot 2–5 px, then over-corrected |
| Eraser ghosts | none | **yes** — 18% opacity residue of a prior stroke, offset 3–7 px |
| Mascot | rounded shoulders, slight forward lean | **taller**, shoulders square, no lean |
| Line weight | even | varies ±30% along a stroke |

**Distribution by night** (`STORY.md §3`: "By Night Five roughly a third of the panels are his. By
Night Six, most."):

| Night | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| Ansel-authored panels | 0% | 0% | 4% | 12% | **33%** | **71%** | n/a (blank) |

The player is never told. `settings.puzzleHints` does not reveal it. There is no codex entry. The
one panel that must be Ansel's regardless of the percentage roll is `4.9` (`STORY.md §3`: the
mascot standing over a horizontal shape that has shoes) and `5.4` (the erased second figure).
Those two are hard-coded into the stage definitions; everything else is distribution.

### 8.6 Testing

- **Golden-image regression per night per seed.** `tools/blueprint-golden.mjs` renders every
  figure for nights 1–7 at seeds `0x51A5CAB`, `0x1`, `0xBEEF` and diffs against committed PNGs at
  a 0.2% pixel tolerance. Any layout change is a deliberate, reviewed golden update.
- **Legibility assertion** (§8.4) is checked programmatically on every golden render, not by eye.
- **Arrow-crossing assertion:** zero arrow-arrow crossings on nights 1–5; ≤ 4 on night 6's
  fold-out (it is *supposed* to be a mess; four is the budget for "cluttered but parseable").

---

## 9. STEALTH

Owned by `Campers.js` (agents, senses, FSM), `Navmesh.js` (patrol graph), `NoiseSystem.js`
(propagation). Everything below is per-camper.

### 9.1 The roster — people, not archetypes

v1.0's roster was "Camper (kid) / Counselor / Head counselor / The Ranger" — interchangeable
guards with a range stat, in a game whose story requires Dale to die on Night 4, Robin to walk
*inside the house* on Night 6, and Bev to be alive at the road to almost say the name. Campers now
have identity.

```js
Camper = {
  id: 'robin',                    // ← new. Stable across nights.
  displayName: 'Robin Osei-Hall', // never shown; used by VoiceBank and Log only
  archetype: 'counselor',         // drives senses only
  essentialUntilNight: 7,         // ← new. §13.4
  scriptedFate: null | { night: 4, beatId: 'n4_dale' },   // ← new
  familiarity: {},                // slotId/featureId → 0..1  ← new, §9.5
  voiceProfile: 'DAL',            // AUDIO_DIRECTION.md §7.4
  state: 'Idle',
}
```

| `id` | Role (`STORY.md §5`) | Archetype | Base range R | FOV | Torch | Hearing thr. | Present nights | `essentialUntilNight` |
|---|---|---|---|---|---|---|---|---|
| `dale` | Maintenance, 27 | counselor | 24 | 110° | yes | 0.11 | 1–4 | **4** (`scriptedFate` N4) |
| `robin` | Arts & Crafts, 19 | counselor | 24 | 110° | yes | **0.08** ¹ | 1–7 | **7** |
| `marg` | Waterfront Director, 21 | counselor | 24 | 110° | yes | 0.11 | 2–6 | **4** |
| `coop` | Sports & Rec, 20 | counselor | 22 | 105° | yes | 0.13 | 2–6 | **4** |
| `teddy` | CIT, 16 | kid | 16 | 100° | no | 0.18 | 2–6 | **4** |
| `bev` | Camp Director, 58 | head counselor | 28 | 115° | yes, wide | 0.09 | 3–6 | **6** |
| `ranger` | County, conditional | ranger | 34 | 120° | vehicle lights | 0.08 | 6–7 ² | n/a |

¹ **Robin hears better than anyone.** `STORY.md §5`: "she has heard ten thousand hours of tools and
she knows the difference between a woodpecker and a mallet." Her threshold is 0.08, below a head
counselor's. That is her characterisation expressed as a stat, and it is why she is the one who
notices on Night 2.
² **The Ranger arrives when `night >= 6` AND `stats.reportsTotal >= 2`.** One rule (§0.2, C6).

### 9.2 Vision

```
Cone:       horizontal FOV per table above, vertical 70°
Foveal:     0–35° off-axis   → fovSens 1.00
Peripheral: 35–55° off-axis  → fovSens falls 1.00 → 0.20 on smoothstep
Beyond 55°: 0  (one exception: motion within 3 m always registers at fovSens 0.35)
```

Detection accrual per second while the player is inside the cone:

```
rangeF   = clamp01(1 - (d/R)^1.6)
lightF   = 0.25 + 1.97 * lum                    // lum = illumination AT the player, 0..1
motionF  = { still: 0.30, crouchWalk: 0.65, walk: 1.00, sprint: 2.90 }
carryF   = 1 + 0.10 * carrySlotsUsed            // 1.00 .. 1.40
exposeF  = 1 + 0.50 * skylineFraction
occlF    = visibleFraction                      // 0..1, §18.2 for how it is sampled

rate = 0.36 * fovSens * rangeF * lightF * motionF * carryF * exposeF * occlF * diffMul

if (rate < 0.02) rate = 0;      // ← THE NOISE FLOOR. See below.
dDetect/dt = rate
```

### 9.3 The four detection targets (and the constants solved backwards from them)

v1.0 specified eight multipliers and never once specified the output — how long a counselor takes
to see you. Its constants produced a **85× spread** with no stated intent: 9.2 s crouching in
total darkness, 0.108 s sprinting and lit. Design targets come first now; constants are solved to
hit them.

**The targets** (counselor, `R = 24`, `diffMul = 1.0`, `d = 15 m` unless noted, unlit `lum = 0.06`
moonlight, lit `lum = 0.61` with own lantern):

| # | Situation | **Target** |
|---|---|---|
| T1 | unlit, still, in cover (`occlF ≤ 0.25`), inside the cone at 15 m | **never detected** |
| T2 | unlit, crouch-walking, fully visible, 15 m | **22 s** |
| T3 | lit and walking, fully visible, 15 m | **3.5 s** |
| T4 | lit and sprinting, fully visible, 8 m | **0.8 s** |

**The solve:**

```
rangeF(15) = 1 − (15/24)^1.6 = 1 − 0.4715 = 0.5285
rangeF(8)  = 1 − (8/24)^1.6  = 1 − 0.1724 = 0.8276

T3 fixes the light slope:  need rate = 1/3.5 = 0.2857
   0.2857 = K × 0.5285 × lightF(0.61) × 1.00
T2 fixes K:                need rate = 1/22 = 0.04545
   0.04545 = K × 0.5285 × lightF(0.06) × 0.65

Solving the pair with lightF = a + b·lum, a = 0.25:
   b = 1.97   →  lightF(0.06) = 0.368 ,  lightF(0.61) = 1.451
   K = 0.04545 / (0.5285 × 0.368 × 0.65) = 0.3595  →  K = 0.36

Check T3: 0.36 × 0.5285 × 1.451 × 1.00 = 0.2761  →  3.62 s   (target 3.5 s, +3.4%) ✓
Check T4: 0.36 × 0.8276 × 1.451 × motionF_sprint = 1.25  →  motionF_sprint = 2.89  →  2.90
   0.36 × 0.8276 × 1.451 × 2.90 = 1.2534  →  0.798 s        (target 0.8 s) ✓
Check T1: 0.36 × 0.5285 × 0.368 × 0.30 × 0.25 = 0.00525 /s  →  190 s.  NOT "never".
```

T1 fails on multipliers alone, so it is enforced by a rule rather than fudged:

> **The noise floor: if `rate < 0.02 /s`, `rate = 0`.**

This is not a hack; it is the model saying that below a threshold a human eye does not integrate
evidence, it just fails to notice. It makes T1 exact, and it makes two more situations genuinely
safe, which is the Freeze fantasy finally being true:

| Situation | `rate` | Result |
|---|---|---|
| unlit, still, in cover, 15 m | 0.00525 | **0 — never detected** ✓ T1 |
| unlit, crouch-walking, in cover (`occlF` 0.25), 15 m | 0.01136 | **0 — never detected** |
| unlit, walking, fully visible, 20 m | 0.03349 | 29.9 s |
| unlit, crouch-walking, fully visible, 15 m | 0.04545 | **22.0 s** ✓ T2 |
| unlit, still, fully visible, 15 m | 0.02098 | 47.7 s — just above the floor, deliberately |

That last row is the tuning knife-edge and it is placed there on purpose: standing perfectly still
*in the open* is 48 seconds of survival, which is enough to make Freeze a real option and not
enough to make it a solution. **Freeze is the single strongest defence** — but only from cover.

`motionF.sprint = 2.90` (v1.0: 1.65) is the biggest single change and it is what makes sprinting a
last resort rather than a movement option. Combined with the 1.9 s spin-up (§10.1), sprinting is a
decision you make two seconds before you need it and pay for over the following twelve.

**Detection meter behaviour:**

| Detection | State | Feedback |
|---|---|---|
| 0.00 | clear | nothing |
| 0.01–0.35 | forming | faint directional smear at screen edge (`HUD`), 8% opacity. No icon, no number. |
| 0.35–0.75 | building | smear brightens; camper plays `audio:vo { id:'vo_hm_*' }` (`STORY.md §6.5`) |
| 0.75–0.99 | critical | the heartbeat (`AUDIO_DIRECTION.md §4.20`) and one low string tone from `Music.js` (§11.4); camper stops walking |
| 1.00 | **spotted** | `player:spotted { camper, level: 1.0 }`; camper → Alerted |

**Decay:** after **1.2 s** with `occlF === 0` or outside the cone, detection decays at **0.25/s**,
accelerating to 0.45/s below 0.3. Detection never resets instantly. Partial memory: the peak
reached is stored and the decay floor is `0.15 × peak` for 20 s.

### 9.4 Light — the flame is the risk, not the illumination

v1.0 sampled `lum` as light *falling on the player* and added `+0.55` for your own lantern. Under
that model, hooding the lantern and pointing it away made you nearly safe at 80 m. That is wrong
by an order of magnitude: the actual risk of holding an open flame in a black forest is that **the
flame is directly visible**, regardless of where it is aimed or how much of you it lights.

So the flame is a **separate percept**, evaluated independently of the body:

```
flameVisibility = unoccluded(flamePos → camperEye) ? hoodFactor : 0
hoodFactor      = lanternHooded ? 0.18 : 1.00
flameRangeF     = clamp01(1 - (d / 180)^1.1)          // R_flame = 180 m, not R = 24 m
flameRate       = 0.36 * 0.55 * flameRangeF * flameVisibility * fovSens * diffMul

dDetect/dt = max(bodyRate, flameRate)                  // the flame does not stack; it dominates
```

One ray, flame → camper eye, ignoring aim. Budgeted in §18.2.

| Distance | Naked flame | Hooded flame |
|---|---|---|
| 30 m | 0.174/s → **5.7 s** | 0.031/s → 32 s |
| 80 m | 0.117/s → **8.6 s** | 0.021/s → 47 s |
| 130 m | 0.062/s → 16 s | 0.011/s → **0 (below floor)** |
| 150 m | 0.036/s → 28 s | 0 |
| 180 m+ | 0 | 0 |

**The lantern is visible from 180 m and it is lethal.** That is the whole point of §11.2 and it is
what makes Tier-3 (120–176 m, inside the camp) the place where you either work blind or get
caught. Hooding is a real mitigation — it buys you a factor of 5.5 — and it is not a solution.

**What the lightning flash actually does.** v1.0 said "a lightning flash forces `exposeF = 2.0`
for 0.25 s — do not be standing in the open when you called down the thunder you wanted," and
called lightning "a double-edged tool." The two edges never touched: `thunderDelay` is
**1.16–12.18 s**, so the 0.25 s exposure ends between 0.9 and 11.9 seconds *before* the masking
window opens. There was no decision.

The exposure now **persists into the window**, which is the only way it is a trade:

> **On a flash, every camper with an unoccluded line to the player inside their cone is
> `flashMark`ed:** `lastNoisePos = player.position` (error radius **3 m**, tight — they *saw* you,
> they did not hear you), and the camper enters `Curious`. `exposeF = 2.0` for 0.25 s still
> applies for detection accrual.

So: the flash you were waiting for shows you to someone, and that someone walks toward the exact
place where you are about to spend nine seconds hammering under cover of the thunder. You get your
masking window and you get company in it. **That** is a double-edged tool.

### 9.5 The AI's concept of the house

v1.0's five FSM states reacted to `noise:emit` and to the player, and to nothing else. A building
appeared in the woods over seven nights and no camper could see it. That made three of
`STORY.md`'s most important beats impossible to implement: Night 2's closing image (Robin's torch
crawling over the frame), Night 4 (Dale knocking on it), and Night 6 (Robin standing inside it).

**The cabin is a first-class AI percept.**

```js
// GameState addition, requested in §20.2
state.structureKnowledge = {
  seenBy:     [],        // camper ids that have accrued full notice on any feature
  enteredBy:  [],        // camper ids that have been inside the footprint
  reportedAs: null,      // null | 'noise' | 'structure' | 'body'
  featuresKnown: {}      // featureId → [camperIds]
}
```

**Silhouette features.** `CabinSite.js` publishes the cabin as a small set of named features with
bounds, not as 90 slots. A camper notices *a wall*, not *stud 6*.

| `featureId` | Exists from | Bounds height | Notes |
|---|---|---|---|
| `piers` | N1 | 0.4 m | barely a thing. Deliberately hard to notice. |
| `frame` | N2 | 2.4 m | **the Night 2 beat.** The first silhouette that reads as architecture. |
| `roof-skeleton` | N3 | 4.1 m | trusses. Visible from the ridge and the fire road. |
| `floor-door` | N4 | 2.4 m | the door is the first *domestic* read |
| `wall-north` | N5 | 2.4 m | 4.8 m wide. Visible in 24 m fog at 22 m. |
| `roof` | N6 | 4.4 m | shingled. From the lake it is a house. |
| `interior-light` | N6 | — | if the lantern is lit inside, it leaks. Notice range ×1.8. |

**The `Noticing` accrual** — a second, separate detection curve:

```
noticeRange = R * 3.2                                  // structures read much further than people
dNotice/dt  = 0.42 * fovSens * clamp01(1 - d/noticeRange) * lightF_structure
                   * (1 - familiarity[featureId]) * occlF_structure
```

- `lightF_structure` uses illumination at the *feature*, not the player. Moonlight on a pale new
  panel is what gives it away — see `ART_DIRECTION.md §2.2` (fresh-milled lumber is the brightest
  thing in the night palette, which is a lighting decision that is now also a gameplay one).
- At `notice >= 1.0`: `familiarity[featureId] = 1.0` permanently for that camper, the camper enters
  the **`Noticing`** state for 4.0 s (stops, torch holds on the feature, `audio:vo` from
  `STORY.md §6.8` "finding evidence"), then pushes to `structureKnowledge.seenBy`.
- `familiarity` **persists across nights**. A camper who has seen the frame does not re-notice the
  frame. They notice the *roof*, next night, as a new feature. Escalation is automatic and
  diegetic.

**The Night 2 beat falls straight out of the numbers.** Robin is a counselor: `R = 24`,
`noticeRange = 24 × 3.2 = 76.8 m`. The canoe rack is at **84 m** (§3.3). She is *just* outside
notice range at the rack; she has to step 8 metres toward the water to accrue, which is exactly
the "she stops moving" beat in `STORY.md §4`. Her torch holds on the frame for 1.5 s and moves on
because `frame` accrues to ~0.6 in the time her patrol gives her, not to 1.0. **She does not
understand what she is looking at, because it is a house, and there is not supposed to be a
house** — and the reason she does not understand it is a number, not a script line.

**Structure escalation is independent of player escalation.** A camper who has fully noticed a
feature and then reaches a rally point delivers a **structure report**, which is a different thing
from a player report:

| Report type | Suspicion | Patrols | Other effect |
|---|---|---|---|
| Noise report | +0.25 | +1 | torches sweep wider |
| **Structure report** | **+0.15** | +0 | **`Navmesh` adds a patrol edge that routes past the plot every ~110 s.** This is worse than the suspicion. |
| Body report | +0.35 | +1 | rung 4, §13.1 |

### 9.6 The player's verbs

Every verb below that *can* be a construction verb, is. See §20.5 for the argument about the four
that are not and why they stay.

| Action | Input | Cost | Effect |
|---|---|---|---|
| **Crouch** | §4.1 | speed 0.90 m/s | `motionF` 0.65, footstep noise ×0.08, eye height 1.15 m — breaks LOS behind a foundation wall or a stacked pallet |
| **Freeze** | release all input | — | `motionF` 0.30 after 0.4 s of stillness. From cover, the noise floor makes it absolute (§9.3). |
| **Break LOS** | movement | — | starts the 1.2 s grace, then 0.25/s decay |
| **Douse lantern** | tap `F` | 0.9 s to relight; the click is `radius 5` | `lum −= 0.55` **and** `flameVisibility → 0`. Given §9.4, this is the strongest defensive action in the game and the player will learn it in about 90 seconds. |
| **Hood lantern** | hold `F` | — | `hoodFactor 0.18`, cone 35%, intensity 40%, burn 0.22/s |
| **Hide behind the build** | positioning | — | placed panels are `occlusion 0.65` sound blockers **and** hard LOS blockers. **Panels installed = safety earned.** |
| **PROVOKE a join** | hold `E` on a seated join, ≥ 1.6 s | see below | **the only distraction verb in the game** |
| **Recut** | §7.4 | 62 s + a board | repair |
| **Saw pass** | §7.6 | 5.2 s, 90 m | Night 3's cut |
| **Grab** (N4+) | §13.4 | 4.5 s | the kill |

#### PROVOKE — the decoy, rebuilt as a construction verb

v1.0's distraction was "throw a bracket," which is the noisemaker-arrow from every stealth game
since 1998 with a caption pasted on ("the comedy: you are throwing away the hardware you are
already short of"). It is deleted. **You do not throw things. You are a carpenter.**

> **You loosen a join you built, on purpose, to pull a patrol to a location you chose.**

| Property | Value |
|---|---|
| Input | hold `E` on any seated join. 1.6 s arms it. |
| **Delay selection** | holding *past* 1.6 s sets the fuse: `delay = 2.0 + (holdTime − 1.6) × 6.0` s, clamped to **[2.0, 20.0] s**. The manual's page edge fills as a fuse gauge — the only timing UI in the game, and it is drawn on paper. |
| Effect | that join fires **one** creak at `severity = 0.30 + 0.45 × (1 − torque)`, at the chosen delay. Radius by the normal curve: **28–48 m**. |
| **Cost** | `torque −= 0.25`, **permanently**, on that join. |
| Cooldown | per join: none. But the cost compounds — provoking the same join four times drives `torque` to 0 and it starts creaking on its own, forever, for real. |
| Refused on | joins with `w >= 0.45` (they are already talking), and on Night 7 (nothing to provoke; the house is finished and silent). |

This is the verb the whole game was pointing at and v1.0 gave one table row to. It is native to the
premise, it is a genuine risk/reward (you are damaging the thing you are being graded on), it uses
the systems that already exist, and it makes the cabin a tool as well as an objective and a
liability. **A player on Night 6 loosening a Night-2 joist to pull Robin away from the door she is
about to walk through is the game working exactly as designed.**

#### The cabin rewrites the world

Two systems must update on every `build:place` and `build:remove` — this is what makes "the thing
you are building is your best cover" a system rather than a sentence:

1. **`Navmesh`**: placed parts with height ≥ 1.2 m cut patrol edges that pass through their
   footprint, and add detour edges around them. Patrols visibly bend around your cabin as it
   grows. Rebuild cost is bounded: only edges within the part's AABB + 3 m are re-evaluated,
   ≤ 0.8 ms, off the critical path.
2. **`NoiseSystem`'s occlusion grid**: a 2 m-cell byte grid over the plot and 60 m around it.
   Placing a panel writes `0.65` into the cells it spans; a full wall writes a contiguous barrier.
   **`NoiseSystem` uses this grid instead of raycasts** (§18.2) — which is both the correct
   engineering fix for the raycast budget and the thing that makes the cabin acoustically real.

### 9.7 The suspicion state machine

Per camper. Camp-wide `state.suspicion` is separate (§13.1).

| State | Enter condition | Behaviour | Exit → | Timer |
|---|---|---|---|---|
| **Idle** | default | Follows the `Navmesh` patrol loop at 1.2 m/s, or sits at a fire. Scans ±40° every 4 s. | Curious, Noticing | — |
| **Noticing** ← new | `notice` reaches 1.0 on a feature (§9.5) | Stops. Torch holds on the structure. Speed 0. One `STORY.md §6.8` line. | → Idle after 4.0 s; → Searching if a noise hit lands during it | 4.0 s |
| **Curious** | one noise hit `heard ∈ (thr, 0.35]`, **or** detection ∈ [0.35, 0.75), **or** `flashMark` (§9.4) | Stops. Turns toward `lastNoisePos`. Raises torch. Speed 0. | → Searching on a 2nd hit or detection ≥ 0.75; → Idle after **6 s** quiet | 6 s |
| **Searching** | `heard > 0.35`, or 2 hits in 8 s, or Curious escalation | Walks to `lastNoisePos` at 1.8 m/s, sweeps torch in a 90° arc, checks 2–3 cover points chosen by `Navmesh`. | → Alerted on `player:spotted`; → Curious after **18 s**; → Idle after **30 s** total | 30 s |
| **Alerted** | detection 1.00, or physical contact | Runs from the player at 3.4 m/s toward the nearest rally. Shouts. Camp suspicion +0.25. | → Panic if the player closes to < 6 m; → Report on reaching rally | — |
| **Panic** | player within 6 m while Alerted | **2.90 m/s** (v1.0: 4.10), erratic pathing, drops what it carries, screams. **Stumbles on `deadfall` ground: 50% chance per 4 s, costing 3.0 s prone.** Cannot be calmed. | → Report, or removed by the player | — |
| **Scripted** ← new | `NightManager` drives it | Follows a beat path with a fixed schedule; senses are *read* but do not change state. `Campers` yields full control. | → the beat's exit state | per beat |

**`Scripted` is what makes the story implementable.** `NightManager` can put Dale on the fire road
at Night 4, walk Robin into the house on Night 6, and hold Bev at the road — with senses still
running (so she still reacts to a creak) but state transitions suppressed. Without it, none of
`STORY.md §4` can be built.

#### Reports — and why v1.0's signature chase was impossible

v1.0: "The 12 s window across 90 m of dark forest, while carrying a 62 kg beam, is the game's best
sequence." Run it. Class D speed is `1.60 × 0.63 = 1.008 m/s`, so 90 m takes **89.3 s**. Drop the
beam and sprint: 1.9 s spin-up (~5.5 m), then 6.25 s of stamina at 4.2 m/s (26.3 m), then walking
— **35 m in 12 s**. Short by 2.6×. And v1.0's Panic ran at 4.1 m/s, within 0.1 m/s of the player's
*sprint* and above their sustainable speed, so closing to grab someone put them into the state that
made them uncatchable. It failed in both directions.

**Two kinds of report, with different rules:**

| | **Short report** | **Long report** |
|---|---|---|
| Trigger | Alerted camper reaches another camper | Alerted camper reaches the payphone (176 m) or the truck radio (149 m) |
| Duration | **26 s** (v1.0: 12 s) | **40 s** + the travel to get there |
| Distance | `Campers` **guarantees** a rally-eligible camper within **45 m** of the player whenever a report begins | 149–176 m |
| Interceptable | **yes, by design** | **no, by design** |
| Effect | suspicion +0.25, patrols +1 | rung 6 — the night ends (§13.2) |

**The intercept arithmetic, stated as a design target and verified:**

> **An unencumbered player who reacts within 2 s intercepts ~70% of short reports.
> An encumbered player intercepts 0%.**

```
Budget: 26 s report − 2 s reaction = 24 s to cover 45 m.

Unencumbered:  1.9 s spin-up covering (1.60+4.20)/2 × 1.9 = 5.5 m
               + 6.25 s sprint at 4.20 = 26.3 m   → 31.8 m in 8.15 s
               + remaining 13.2 m walking at 1.60 = 8.25 s
               TOTAL 16.4 s  <  24 s          ✓ intercepts, with margin for terrain
Encumbered (class D, 1.008 m/s):
               45 / 1.008 = 44.6 s  >  24 s   ✗ cannot, ever
At 90 m unencumbered:
               31.8 m sprint + 58.2 m walk = 8.15 + 36.4 = 44.5 s  >  24 s   ✗
```

So: **45 m is the cap that makes the sequence work, and 90 m is why v1.0's did not.** And the real
decision the sequence poses is now the right one — *drop the 62 kg beam in the mud and run, or keep
it and lose the night.* That is a better beat than a foot race, and it is the beat the numbers
actually produce.

**Panic at 2.90 m/s** vs sprint 4.20 gives a closing rate of 1.30 m/s: from 6 m behind, 4.6 s of
sprint catches them, and the player has 6.25 s of stamina. It works — barely, and only if you
committed to the sprint early. The `deadfall` stumble (§3.6) makes it reliable on 8% of the map.

**On whether the player should win chases:** mostly, no. Ansel is not fast; a running person gets
away and the design is comfortable with that. Panic speed is set at 2.90 so that a player who
*anticipated* can close, not so that a player who reacted can. If playtests show intercept rates
above 85%, raise Panic to 3.10 before touching anything else.

### 9.8 Hearing (`NoiseSystem.js`)

`noise:emit { position, radius, intensity, kind }` → for each camper within `radius`:

```
falloff   = clamp01(1 - d/radius)^1.5
occlusion = product of blocker factors along the ray, from the 2 m OCCLUSION GRID (§9.6), not raycasts
mask      = 1 - Weather.maskLevel()
heard     = intensity * falloff * occlusion * mask
```

| Blocker | Factor |
|---|---|
| Tree trunk | 0.88 |
| Dense undergrowth (per 2 m) | 0.92 |
| Terrain ridge (grid cell below heightfield) | 0.50 |
| **Cabin wall / panel** | **0.65** |
| Tent canvas | 0.90 |
| Boathouse / mess hall wall | 0.45 |

If `heard > camper.hearingThreshold` the camper takes a **noise hit**: it stores `lastNoisePos`
with an error radius of `4 + 14 × (1 − heard)` metres — **campers investigate an approximate
point, not your exact position** — and advances the FSM. (Exception: `flashMark`, §9.4, error
radius 3 m, because they saw you.)

**Canonical `noise:emit` kinds** — the complete vocabulary; all agents use these strings, and
`AUDIO_DIRECTION.md §1.3` binds each to an audible loudness so what the AI hears and what the
player hears are the same number:

| kind | radius (m) | intensity | Emitter |
|---|---|---|---|
| `footstep` (crouch) | 4 | 0.08 | Player |
| `footstep` (walk) | 9 | 0.18 | Player |
| `footstep` (sprint) | 20 | 0.45 | Player |
| `footstep` (carry D) | 14 | 0.30 | Player |
| `brush` | 6 | 0.12 | Player vs foliage |
| `drag` | 22 | 0.38 | Player, class E / end-lift trailing end |
| `drop` | 16 / 26 / 40 | 0.35 / 0.55 / 0.80 | BuildSystem, by carry class B/C/D |
| `impact` | 30 | 0.60 | split wood, a dropped part landing hard |
| `hammer` | 34 | 0.30–0.55 | BuildSystem seating check |
| `wrench` | 24 | 0.45 | BuildSystem removal |
| **`saw`** ← new | **90** | **0.62** | BuildSystem: Recut (§7.4), the N3 ridge cut (§7.6) |
| `creak` | 14–60 | = severity | BuildSystem |
| `whistle` | 90 | 0.90 | Campers (head counselor) |
| `thunder` | 400 | 1.00 | Weather (masking only; campers ignore) |
| `voice` | 26 | 0.30 | Campers talking (player awareness; campers ignore) |

`throw` is **removed** along with the verb (§9.6).

---

## 10. THE PLAYER

Owned by `Player.js` + `Physics.js`. Eye height 1.7 m, capsule radius 0.42 m (wide — you bump
things), gravity −22 (`ARCHITECTURE.md §2`).

### 10.1 Movement

| Parameter | Value | Notes |
|---|---|---|
| Walk speed | **1.60 m/s** | default |
| Crouch speed | **0.90 m/s** | |
| Sprint speed | **4.20 m/s** | |
| Accel (ground) | **7.0 m/s²** | ~0.23 s to reach walk speed |
| Decel (ground) | **9.0 m/s²** | ~0.18 s to stop from walk |
| Sprint spin-up | **1.9 s** from walk to sprint | you cannot dart |
| Air control | 0.18 × ground | |
| Step height | 0.45 m | |
| Turn rate cap | **220°/s** | mouse input is rate-limited; you cannot whip around |
| Turn accel | **1400°/s²** | the first 0.16 s of any turn is slow |
| Crouch transition | 0.42 s down, **0.55 s up** | |
| Head bob | 0.055 m vertical @ 1.9 Hz walking | `settings.headBob`; per carry class in §4.3 |
| View noise | ±0.35° perlin, always on | `ART_DIRECTION.md §6.2` |

**Derived carry speeds** (used throughout §5.3):

| Class | Multiplier | Speed | 100 m takes |
|---|---|---|---|
| A / empty | 1.00 | 1.600 m/s | 62.5 s |
| B | 0.96 | 1.536 m/s | 65.1 s |
| C | 0.82 | 1.312 m/s | 76.2 s |
| C × 2 | 0.672 | 1.075 m/s | 93.0 s |
| D | 0.63 | 1.008 m/s | 99.2 s |
| end-lift | 0.52 | 0.832 m/s | 120.2 s |
| E (drag) | 0.34 | 0.544 m/s | 183.8 s |

**Why this feels heavy, in numbers *and* in animation** (Pillar 4):

1. **Turn acceleration 1400°/s²** — a 180° turn takes 0.71 s minimum. This single number does
   about 60% of the work.
2. **Decel > accel, and both are low.** You commit to a direction. There is no strafe-dance.
3. **Sprint spin-up 1.9 s.** Sprinting is a decision made two seconds ago, not a panic button —
   and at `motionF 2.90` (§9.3) it is a decision you pay for.
4. **Crouch-up 0.55 s** > crouch-down 0.42 s. Getting small is easy; getting mobile is not.
5. **Capsule radius 0.42 m** vs a typical 0.30 — you clip undergrowth constantly, emitting `brush`
   noise. You are too big for this forest.
6. **The body** (§4.3): shoulders permanently in frame, 28° of lower screen gone under a beam,
   the hammer arc the head does not track. v1.0 claimed weight needed no animation. It does.

### 10.2 Stamina

```
staminaMax   = 100
sprintDrain  = 16.0 /s   × (1 + 0.6 × carryMassNormalized)
regenDelay   = 2.2 s after sprint ends
regenRate    = 11.0 /s   (crouched: 15.0 /s — the slasher recovers by being still)
exhausted    = stamina hits 0 → sprint locked until stamina >= 35
```

Sprinting unencumbered: **6.25 s = 26.3 m.** You cannot outrun a fleeing camper (3.4 m/s) for
long, and you should not try — you catch them by cutting them off, using the map (§3). Class C, D
and E cannot sprint at all.

**Breathing is an emitted noise.** Above 60% stamina drain, `AudioEngine` layers a low breath loop
at `radius 5, intensity 0.10`. Campers within 5 m hear it. `AUDIO_DIRECTION.md §2.4` ("The Held
Breath") and §4.19 own the synthesis; `STORY.md §2` requires the breath to be a tracked emitter at
all times, so that the *absence* of a voice is audible.

### 10.3 Carrying — the physics subsystem, named

v1.0 asserted "`Physics.js` simulates carried parts as constrained rigid bodies… A carried class
C/D part **sways** with a spring (k = 28, damping 0.55). It occupies world space. **It clips
trees.**" `package.json` has exactly one dependency, `three`, and Three.js has no physics engine.
Worse, `InstancedMesh` has no per-instance colliders, so "clips trees" required a spatial structure
that existed nowhere. This is not a tuning gap; it was a missing subsystem. Here it is.

**Approach: swept capsule chain vs. a uniform grid of trunk cylinders. No physics library.**

| Component | Spec |
|---|---|
| **Carried part collider** | a chain of **3 spheres** along the part's long axis (radius = half the part's minor dimension, clamped ≥ 0.12 m), swept between the previous and current frame positions |
| **Forest collider** | a **4 m-cell uniform grid** of trunk cylinders (`{x, z, radius, height}`), rebuilt per `Forest` chunk on chunk load, ~9 KB per 128 m chunk. Undergrowth is **not** collided — it triggers `brush` noise on overlap only. |
| **Static world** | cabin parts, props, rocks: the same grid, one extra entry type (AABB) |
| **Query** | a swept sphere touches at most 9 cells; typical occupancy 2–4 cylinders per cell → **≤ 36 cylinder tests per sphere per frame**, all scalar, no allocation |
| **Resolution** | **positional impulse only** — push the sphere out along the contact normal, then apply a torque to the part's spring target proportional to `cross(contactArm, penetration)`. No velocity solver, no restitution, no stacking. |
| **Sway** | spring on the part's transform target: `k = 28, ζ = 0.55` (class C/D), `k = 14, ζ = 0.42` (end-lift). The spring is the *only* dynamic state; the collider is kinematic. |
| **Budget** | **0.40 ms/frame** at class D with 4 contacts. Measured on the §18 target machine. |
| **Fallback** | if a frame's collision work exceeds 0.40 ms, the remaining spheres resolve against the **player capsule's** swept volume only (i.e. the part stops clipping the world but never tunnels). Degrades to "rigidly attached" in the worst case, which is the honest floor. |

Consequences that are now real rather than asserted:

- **Bumping** a carried part into geometry above 1.2 m/s relative speed →
  `noise:emit { kind:'impact', radius: 18, intensity: 0.25 + 0.4 × speedNorm }`. Carrying a 3.2 m
  beam through close pines is audibly expensive, which is why the map puts the pallets in the
  clearing and the Tier-2 spawns in the trees.
- **Class D parts occlude 28° of the lower screen** (§4.3). You cannot see your feet while hauling
  a beam. This is the design.
- **Drop** is instant and loud (§9.8). **Set down** takes 2.1 s and is silent. Under pressure,
  everyone drops — and §9.7 makes dropping the correct answer during a report chase.
- Two class-C parts stack the speed penalty multiplicatively (§6.2).

---

## 11. RESOURCES & ECONOMY

### 11.1 Scavengeable inventory

| Resource | Per-night spawn | Where (§3.3) | Respawn |
|---|---|---|---|
| Structural parts (this stage's manifest) | exactly N required | pallets A/B, staging apron (Tier 1) | none — they are the puzzle |
| Spare fasteners | `rand.int(4, 9)` bags of 12 | scattered Tier 1–2 | +2 bags at each `build:stage-complete` |
| Sistering boards (for Recut) | `rand.int(2, 3)` | the woodpile (46 m) | +1 at each stage complete |
| Shim wedges | `rand.int(2, 4)` | woodpile, sawdust piles | none within a night |
| Tallow tins | `rand.int(1, 2)` | mess hall (Tier 3), boathouse (Tier 2) | none |
| Felt pads (N6+) | 2 | counselor's truck (149 m) | none |
| Lantern fuel can | 2 | one Tier-1, one Tier-2 | one Tier-1 respawn at `timeOfNight > 0.6` |
| Rope (N5) | 1 | tool shed (131 m) | none |
| Errata slip (N6) | 1 | Tier 2 or 3, seeded | none |

All positions from `new Rand(hash2(night, spawnIndex) * 1e9 | 0)` so the world is reproducible for
screenshot regression (`ARCHITECTURE.md §6`).

**Recut is deliberately gated by boards, not by cooldown.** Two or three per night means you can
fix one catastrophe comfortably, two at a real cost, and three not at all. That is the correct
shape for a repair verb: it removes the death spiral without removing the consequence.

### 11.2 The lantern (`Flashlight.js`)

Amber `#ffb865`, a `SpotLight` at intensity ~40, `decay: 2`, volumetric cone
(`ART_DIRECTION.md §3.2`).

| Parameter | Value |
|---|---|
| Fuel capacity | 100 units |
| Burn rate (full beam) | 0.55 units/s → **3:02 of continuous light** |
| Burn rate (hooded) | 0.22 units/s → **7:35** |
| Fuel can restores | 45 units |
| Ignite / douse | 0.9 s / 0.25 s |
| Detection: illumination | `lum += 0.55` full, `+0.22` hooded |
| **Detection: the flame itself** | **§9.4 — visible to 180 m, `hoodFactor` 0.18 hooded. This is the real cost.** |
| Below 15 units | flame gutters; intensity flickers 0.6–1.0 at 3 Hz. **The flicker is a detection spike** — `lightF` and `flameVisibility` both sample the instantaneous value. |
| At 0 | you build in moonlight. `Blueprint` figures become nearly unreadable — this is the real punishment. |

**The lantern's deepest cost is that you cannot read the manual without it**, and its second-
deepest is that a naked flame is a 180 m advertisement. Those two facts pull in opposite
directions, every night, and that tension is the lantern's entire design.

**Shadow cost** (v1.0 never mentioned this while asserting a CoD-comparable image at 60 fps in a
browser): see §18.3. The lantern is the most expensive object in the game.

### 11.3 The only currency: time until dawn

`state.timeOfNight` 0 → 1. Everything else is a means to spend it.

| Action | Time cost | Source |
|---|---|---|
| Walk 100 m unloaded | 62.5 s | §10.1 |
| Walk 100 m class C | 76.2 s | §10.1 |
| Walk 100 m class D | 99.2 s | §10.1 |
| Drag 100 m (body, hearth) | 183.8 s | §10.1 |
| Open the manual | **0.9 s** (the wipe) + reading | §4.4 |
| One seating check | 4.2 s incl. approach | §5.1 |
| One removal + re-place | 8 s + 3.0 s | §6.3 |
| **One Recut** | **62 s** + a 92 s board round trip | §7.4 |
| The N3 ridge cut | 73 s of sawing across ~200 s of windows | §7.6 |
| Tier-2 hardware run | 95–160 s | §3.5 |
| Tier-3 hardware run | **200–330 s** | §3.5 |
| Waiting for a Searching camper to give up | 30 s | §9.7 |
| Waiting for thunder (Night 6 only) | **≤ 45 s, guaranteed** | §7.5 |

`NightManager` displays **no clock.** The only time indicators are diegetic:

| Tell | At `timeOfNight` | Owner |
|---|---|---|
| The camp's fires die down | 0.55 | Props |
| Fog thickens by 30% | 0.70 | VolumetricFog |
| The moon crosses the ridge line | 0.78 | Sky |
| **The sky's horizon shifts 6% toward `#2a3340`** | **0.85** | Sky |
| Crickets stop | 0.92 | Audio (`AUDIO_DIRECTION.md §5.4`) |

v1.0 asserted players "learn this tell in about three nights and it is terrifying." That is a
target, not a fact; it is now §19 row A7 with an instrument.

### 11.4 The three non-diegetic sounds — the complete list

v1.0 claimed the hardware chime was "the *only* non-diegetic sound in the game," and was
contradicted twice inside its own text and once by `ARCHITECTURE.md §9` (`Music.js`, "adaptive
score") and all of `AUDIO_DIRECTION.md §6`. The claim is deleted. The list:

| # | Sound | Owner | When |
|---|---|---|---|
| 1 | **The adaptive score** | `Music.js` | driven by the Dread scalar, `AUDIO_DIRECTION.md §6.3`. Layers in above `suspicion` 0.3 and during cascades. |
| 2 | **The heartbeat** | `ProceduralSFX` §4.20 | detection ∈ [0.75, 1.0) only |
| 3 | **The hardware chime** | `ProceduralSFX` | `tool:found` only. Struck 2.1 kHz sine, 1.4 s decay. |

**Nothing else.** No UI clicks, no menu whooshes, no pickup blips, no stingers on kills.
`AUDIO_DIRECTION.md §6.4`'s "THE STAPLE" stinger is a *music* cue and belongs to #1. The game is
otherwise entirely diegetic, and the discipline is what makes the three exceptions legible.

---

## 12. THE SEVEN NIGHTS

**Canonical.** Every cell traces to `STORY.md §4` (content), `ART_DIRECTION.md §4.5` (weather) and
§2 above (slots, seconds). v1.0's night table mismatched `STORY.md` on all seven nights and is
deleted in full. One new idea per night; everything recombines on Night 6, and Night 7 takes it
all away.

### 12.1 Master table

| Night | Slots | Sec | Stages | New mechanic | New grammar | Campers present | rain/wind/fog | maskFloor | Shortfall |
|---|---|---|---|---|---|---|---|---|---|
| **1** FOUNDATION (A) | 12 | 800 | 2 | carry, place, seating check, the creak as comedy, **Recut** | G1 | `dale` (400 m, drunk) | 0.15 / 0.20 / 0.35 | 0.089 | one shim |
| **2** UPRIGHTS (B ×4) | 14 | 975 | 3 | noise + light, cones, crouch, LOS break, **`Noticing`** | G2 | `dale` `marg` `coop` + `robin` | 0.40 / 0.35 / 0.50 | 0.197 | bracket H |
| **3** DO NOT OVERTIGHTEN | 13 | 950 | 3 | **the saw**; sustained-noise budgeting; persistent `suspicion` | G3 | + `bev` (4 total) | 0.10 / 0.55 / 0.65 | 0.151 | **none** |
| **4** IF PARTS ARE MISSING | 16 | 1050 | 3 | **infiltration** into a lit space; theft with consequences; **the grab** | G4 | 5, concentrated | 0.75 / 0.60 / 0.55 | 0.357 | the hinges |
| **5** THIS STEP REQUIRES TWO PERSONS | 10 | 1175 | 2 | **rigging** (`freeform` slots); end-lift carry; 24 m fog | G5 | 5, searching in pairs | 0.25 / 0.30 / **0.85** | 0.141 | **a second person** |
| **6** SOLD SEPARATELY | 17 | 1400 | 4 | **blueprint unreliability**; ruin-anchor validation; **thunder masking** | G6, G7 | **2** | 0.90 / 0.85 / 0.60 | **0.457** + thunder | `0000-000` + errata slip |
| **7** SOME ASSEMBLY REQUIRED | 8 | ∞ | 1 | **everything is taken away** | none | 1 → 0 | 0.05 / 0.10 / 0.25 | 0.037 | **a person** |

### 12.2 NIGHT ONE — FOUNDATION (A)
*Beat:* `n1_thumbs_up` · *Flag:* `sawIntroPanel`, `foundShim`

- **Build (12 slots):** 6 stone piers (class C, `symmetryOrder = yawCandidates = 4` — they cannot
  be rotated wrong), 6 sill beams (class D, `yawCandidates 2`, `symmetryOrder 2` for beams 1, 3–6;
  **beam 2 has `symmetryOrder 1`** and is the game's first teachable mistake, §17).
- **Missing:** one shim. Pier D sits 11 mm low. It is the folded 1961 Minnesota licence plate
  under the stump at (29, −5), 30 m east (`STORY.md §7` object 1). Stone: **no audio hint ladder**
  (§6.9) — it must be found by reading the contour inset. That is the lesson.
- **What goes wrong:** nothing. He gets it right. The one creak in the night is scripted (§17,
  t = 4:39) and a loon answers it from across the water.
- **`Recut` is introduced here**, not on Night 3 — the handsaw has been in the tool roll since the
  start (§0.2, C4). The player will almost certainly not need it on Night 1. It is introduced so
  that when they need it on Night 4 they already own it.
- **Campers:** `dale` alone, 400 m off, on a loop that **cannot** reach the plot. This is theatre
  and it is safe, and the player does not know that.
- **Closing image:** rain on six level piers, a spirit level's bubble dead centre, the manual's
  last panel — the little masked man on the foundation with both arms up.

### 12.3 NIGHT TWO — UPRIGHTS (B ×4), SUPPORT WHILE FIXING
*Beat:* `n2_robin_hears` · *Flag:* `robinSuspicious`

- **Build (14 slots):** 4 corner posts (D), 6 wall studs (C), 4 diagonal braces (C). **Order
  matters — brace before you release.** `Slot.requires` enforces it; releasing a post without its
  brace sets `torque = 0.35` and the third wall goes 2° out of plumb, which stands, and creaks in
  wind, exactly as `STORY.md §4` requires.
- **Missing:** bracket **H**. Four needed, three in the pile — and the manual's parts-list panel
  shows four. The player will count them three times. Tier 2, boathouse eave (96 m).
- **New:** `NoiseSystem` propagation, flashlight cones, crouch, LOS break, first `player:spotted`
  risk. **And `Noticing` (§9.5)** — this is the night the AI learns to see the house.
- **Story beat:** Robin, alone at the canoe rack at 84 m, hears four even mallet strikes.
  `ROB_HEAR_01`, `ROB_HEAR_03`. Her threshold is 0.08 (§9.1) — the lowest in the game — so a
  4-tap seating check at 84 m through two trunks reaches her and reaches nobody else.
- **Closing image:** her torch crawls over the frame, holds 1.5 s, moves on. `familiarity['frame']`
  ends the night at ~0.6, so she has not fully noticed and will notice next time. **This is the
  `Noticing` curve running, not a cutscene** (§3.4, item 2).

### 12.4 NIGHT THREE — DO NOT OVERTIGHTEN
*Beat:* `n3_not_believed` · *Flag:* `robinDismissed`

- **Build (13 slots):** 6 truss assemblies (D, each needing a **6 s prop-and-hold** before the
  ridge is pinned — the hands are occupied, you cannot douse the lantern, you cannot crouch), the
  ridge beam (1), and 6 ridge pins.
- **Missing: nothing.** The **ridge beam is 340 mm too long** (5.14 m for a 4.80 m span). §7.6 is
  the mechanic. This is the night the shortfall gag is withheld, and its absence is felt.
- **Weather is the mechanic's partner:** wind 0.55, rain 0.10 → `maskFloor 0.151`, giving the saw
  an effective reach of ~57 m (§7.6). Wind also raises `Mw` to `1 + 0.60(0.55) + 0.20(0.10) = 1.35`
  — the weather that hides the saw makes the trusses talk.
- **New:** sustained-noise budgeting. `suspicion` becomes persistent and carries into Night 4.
- **Story beat:** Robin tells Bev about the mallet; Bev gives her `BEV_ARG_02` — "Sound carries
  over the water. Happens every year." Bev is not dismissive; **she is correct about a thing that
  is usually true.** The first cruelty in the script is committed by the campers, gently, to each
  other.
- **Closing image:** the ember of Bev's cigarette at the treeline, held unmoving for **11 seconds**
  — a person deciding whether to walk out and look. She doesn't.

### 12.5 NIGHT FOUR — IF PARTS ARE MISSING, DO NOT RETURN TO STORE
*Beat:* `n4_dale` · *Flag:* `firstBlood`, `stoleHinges`

- **Build (16 slots):** 12 subfloor boards (C), the **door** (D, 38 kg — the first piece that is
  obviously *domestic*), 3 hinges (B).
- **Missing:** the hinges. There are none in the woods. There are three good brass hinges on the
  camp boathouse door at (74, −61) — **96 m**, inside the lit perimeter, with a static camper.
  Round trip 122.5 s of travel plus ~137 s of patrol waiting (§3.4, item 1).
- **Consequence that persists:** the boathouse door hangs open, propped with an oar, for the rest
  of the game (`STORY.md §7` object 11). `Props.js` owns the state; it is written to
  `storyFlags.stoleHinges` and never repaired. Marg finds it: `MRG_EVID_01`.
- **New: the grab** (§13.4) — from **Night 4**, not Night 3. v1.0 handed the player a silent 4.5 s
  kill from Night 3 with no essential-NPC concept, which let a player kill all six named characters
  before the story started. `STORY.md §2` says no blade until Night Four; this is that.
- **Story beat (`Scripted`):** Dale walks up the fire road (62 m south) to piss and finds a house
  that was not there in June. He is not scared, he is *confused*: "…the hell is this, chief," and
  he knocks on it, twice, politely, to see if it's real. `structureKnowledge.enteredBy` gets its
  first entry. Then the first kill — **off-camera, a hard cut to black, no music sting, no scream,
  only a hammer set down carefully on wood.**
- **Tone:** the comedy dies here and does not fully return. From this night the manual stops being
  funny (`STORY.md` non-negotiables), and the night-end card begins losing lines (§15.2).
- **Closing image:** Dale's torch on the ground, still lit, rolling in a slow quarter-arc, its beam
  sweeping a wall that is *plumb, square and true.*

### 12.6 NIGHT FIVE — THIS STEP REQUIRES TWO PERSONS
*Beat:* `n5_two_persons` · *Flag:* `sawSecondFigure`, `riggedCounterweight`

- **Build (10 slots):** the **north wall panel** — 4.8 m, **71 kg**, `carryMode: 'end-lift'`
  (§6.1–6.2) — plus 3 `freeform` rig anchors (§6.7) and 6 pins.
- **Missing: a second person.** `Physics` refuses the one-man placement; the wall slides. The
  manual's warning icon shows two mascots (`STORY.md §3` panel 5.1) — both drawn in Marit's hand,
  both drawn twenty-two years ago.
- **The mechanic:** rigging (§6.7). Dale's canoe from the rack (84 m), rope from the tool shed
  (131 m), a stump, the ladder from the boathouse (96 m). **The solution is ugly. It is the first
  thing Ansel builds that his mother did not draw.** `build:place` fires `correct: true` for a join
  the manual never specified — the only time in the game.
- **Weather:** `ART_DIRECTION.md §4.5` — fog **0.85**, visibility **24 m**. §5.3 charges a 1.25×
  navigation tax on all travel for it. You cannot see the far end of the wall you are lifting.
- **Story beat:** panel 5.4 — the second mascot, erased, redrawn, erased, redrawn smaller, three
  eraser ghosts visible under the final line. No arrows, no numbers, no instruction. The player
  opens the manual to check a measurement, lands on it, and **there is no measurement on the page.**
  `Blueprint.authorship['5.4'] = 'ansel'`, hard-coded (§8.5).
- **Closing image:** the wall stands. Ansel puts one hand flat against it and leaves it there
  longer than the animation needs (**+1.4 s past the IK settle** — the one place `Player.js` holds
  a pose without input). Rain. The other end of the wall is held up by a canoe.

### 12.7 NIGHT SIX — SOLD SEPARATELY
*Beat:* `n6_robin_inside`, `n6_bev_remembers` · *Flag:* `robinSaw`, `bevRemembered`, `foundRuinAnchors`

The hardest night, the most slots, the fewest people, and the storm.

- **Build (17 slots):** 8 roof battens (C), 6 shingle bundles (C), and the interior — the **sink**
  (the cracked porcelain one from (−48, −35), `STORY.md §7` object 3 — *the rectangle missing from
  its splash-back is on his face*), the **stove flue**, the **doorframe**.
- **Missing:** article **`0000-000`**. It is not in the world. It has never been in the world.
- **The manual is broken** (G6 + G7): step 14 before step 9; step 9 absent; a wall elevation that
  contradicts the floor plan; a confident arrow pointing at an empty slot. 71% of panels are in
  Ansel's hand (§8.5).
- **The mechanic — ruin-anchor validation.** `Slot.anchorRuin` points at a foundation stone of the
  1962 Vik house, still in the ground. Correctness is validated against `CabinSite` ruin anchors
  instead of the printed transform. **The stones are only visible when the lantern rakes across at
  a low angle** (`STORY.md §7` object 2) — grazing incidence below 14°, which means crouching and
  hooding. To finish the night the player must stop reading and start *remembering*. That is a
  mechanic and it is also the thesis.
- **How the game releases a player hunting for `0000-000`:** it does not hint, ever (§6.9). At
  `timeOfNight 0.55`, `Blueprint` redraws the panel **once**, in Ansel's hand, with the article
  number struck through and the arrow redrawn pointing at a ruin anchor. No sound, no toast. The
  manual gives up on the part before the player does, and that is the beat. Budget: 90 s (§5.3).
- **Thunder masking is available and effectively mandatory here** — 17 slots of hammering under
  ~33 strikes (§7.5). This is where the mechanic v1.0 stranded on Night 5 actually lives.
- **Campers: two.** The camp has called the county; most of them are at the road waiting on
  headlights four hours out. **The woods are the emptiest they have ever been and it is the worst
  night of the game.** Patrol density is *floored* at 2 — the pacing band (§5.4) may not raise it.
- **Story beat one (`Scripted`, ~90 s):** Robin finds the site and goes inside. She is not
  attacked, because Ansel is on the roof and she is standing in his mother's kitchen and he does
  not know what to do about that. She sees the sink with a rectangle of missing porcelain. She sees
  the doorframe: four pencil marks, ascending, dated 1953–1957 in a woman's handwriting. She puts
  her hand flat on the top one. **It is above her head.** `ROB_LATE_01`, `ROB_LATE_02`.
  During this beat the grab is refused (§13.4) and the player has no verb but to watch.
- **Story beat two (`Scripted`, ~60 s):** Bev, at the road in her own headlights, gets to
  `BEV_LATE_04` — "His name was Ansel V—" — and stops.
- **Closing image:** Robin's hand on the doorframe at the height of a boy's head in 1957, and a
  shadow across the window that does not move.

### 12.8 NIGHT SEVEN — SOME ASSEMBLY REQUIRED
*Beat:* `n7_final` · *Flag:* `manualBlank`, `ending_<a|b|c>`

- **Build: nothing structural remains.** The house is finished. It is, by every standard the game
  has taught, **perfect work.** v1.0 gave Night 7 twenty-eight slots including a chimney, a porch
  and a roof cap; `STORY.md §4` says the house is already done. `STORY.md` wins.
- **The 8 slots are two chairs.** Hand-made, identical, 4 slots each. **One is adult-sized. One is
  not** (`STORY.md §7` object 20). See §12.9.
- **Everything is taken away:** no HUD, no reticle, no prompts, no objective marker, no creak
  feedback, no detection smear. `settings.subtitles` still works; nothing speaks.
- **No clock.** `nightDurationSeconds = Infinity` (§2).
- **The floor does not creak anywhere.** The player has spent seven nights learning what a creak
  means, and its total absence is more frightening than any sound the game has made. `BuildSystem`
  asserts `Σ lambda === 0` at Night 7 start; if a wrong join survived from an earlier night, **it
  has been silently recut between nights** — the one place the game repairs itself, because the
  silence matters more than the bookkeeping.
- **Campers:** one, then none.
- **Endings:** §13.6.

### 12.9 The two chairs

v1.0 wrote: "**The Chair** (night 7, final slot): a single wooden chair, 4 slots, faces the door.
The manual's last figure is the masked man sitting in it. There is no explanation. **This is the
only joke the world tells, and it tells it with a straight face.**"

That sentence is deleted, and so is the single chair. It is the worst error in v1.0, because it is
the one that damages the game rather than merely mis-specifying it. `STORY.md §7` object 20 and
`STORY.md §8` give **two** chairs — "One is adult-sized. One is not" — and the ending is Ansel
sitting in the small one, taking the mask off, and not getting up. The systems author read that,
parsed it as a bit, cut the child's chair, and turned the last image of the game into a slasher
smirking at the audience. **That is precisely what Pillar 1 exists to prevent.** It is not a joke.
It is the only grief the game shows you.

| Property | Value |
|---|---|
| Chairs | **two**, identical in construction, 4 slots each |
| Sizes | seat heights **0.46 m** and **0.31 m**. The small one is sized for a boy of about eight. |
| Placement | at the table, facing each other, not facing the door |
| The manual's last page | one **dotted outline** of a small seated figure, at a table, child-sized, drawn in Marit's hand in 1962. Above it, the parts-list bracket, and **inside the bracket, nothing.** |
| **Final interaction** | `place`, **with the player as the part** (§13.6, Ending C) |
| The manual's comment | none. The manual does not editorialise here or anywhere (§15.3). |

---

## 13. FAIL STATES

**Being seen is never a game over.** It is the start of a sequence.

### 13.1 The escalation ladder

| Rung | Trigger | Camp effect | Patrols | Player feels |
|---|---|---|---|---|
| 0 | — | `suspicion 0.00–0.15` | base | quiet |
| 1 | 3 noise investigations in one night | +0.10, campers pair up | +0 | torches sweeping wider |
| **1b** | **a structure report (§9.5)** | **+0.15** | **+0** | **`Navmesh` routes a patrol past the plot every ~110 s. Worse than the suspicion.** |
| 2 | `player:spotted` once | +0.25 | +1 | a voice calling a name that isn't a name |
| 3 | a short report delivered | +0.25, **camp lights come on** (2 point lights, `lum` floor +0.15 in camp) | +2 | the mess hall is lit; Tier-3 is now suicide |
| 4 | **a body found (§13.5)**, or 2 reports | +0.35, `bev` spawns with the whistle, kids recalled to cabins (**fewer wanderers — the forest gets emptier and worse**) | +1 counselor, −2 kids | the woods go silent |
| 5 | `night >= 6` **AND** `stats.reportsTotal >= 2` | **The Ranger's truck arrives** at `timeOfNight + 0.15`. Headlights sweep the treeline on a 40 s cycle: a moving 26 m cone at `lightF` 0.9. | +Ranger | a machine is looking for you |
| 6 | **a long report completes** (payphone at 176 m, or the truck radio at 149 m) | **Night ends immediately.** `night:failed { reason: 'reported' }` | — | the run is wounded |

`suspicion` is clamped [0, 1] and drives `Campers.patrolDensity = 2 + floor(suspicion × 6)`, capped
at the night's maximum — **and floored at the night's minimum**, which is what protects Night 6's
density of 2 from the escalation ladder (§12.7).

Rung 5's single condition replaces v1.0's two contradictory ones (§0.2, C6).

### 13.2 What actually ends a run

| `reason` | Condition | Consequence |
|---|---|---|
| `'reported'` | rung 6 | Night ends. Next night starts at `suspicion` 0.45 floor and one fewer stage of buildable slots (the camp posts a watch on the ridge). **Not a game over.** |
| `'dawn'` | `timeOfNight >= 1.0` with the stage incomplete | Night ends. Unbuilt slots roll into the next night's budget. **Not a game over.** |
| `'exposed'` | fully lit within 8 m of 3+ Alerted campers | Forced retreat: a **45 s** escape window with the whole camp Searching. Survive it and the night continues. |
| `'evacuated'` | **Game over.** Three `'reported'` nights, OR any `'reported'` on Night 6 or 7. | The camp buses out at dawn. The cabin is finished and empty. Credits over an unused cabin. Quiet, sad, correct. |
| `'incomplete'` | **Game over.** Night 6 ends with the roof or the doorframe unbuilt. | Campers arrive to an unfinished structure. Different credits. |

`state.phase = 'gameover'` only on `'evacuated'` and `'incomplete'`. **Both offer "Replay Night N",
not "Restart Game"** (§14).

**A long report cannot be intercepted, and that is deliberate** (§9.7). The payphone is 176 m from
the plot; a player cannot cover that. Rung 6 is a consequence of letting someone reach Alerted with
no witness within 45 m — not a coin flip at the end of a foot race. The game is honest about this:
if a camper breaks for the camp rather than for a person, they are gone, and the correct play was
three decisions ago.

### 13.3 Essential characters

`STORY.md` requires Dale to die on Night 4, Robin to survive to Night 6 and walk inside the house,
and Bev to be alive at the road on Night 6. v1.0 handed the player a silent kill from Night 3 with
no concept of an essential NPC, so a player could kill all six named characters before the story
started.

**The enforcement is behavioural, not a UI block** — because a refusal prompt would be the game
winking at the player, which Pillar 1 forbids:

> **The grab requires the target to be (a) unaware, (b) alone within 20 m of any other camper, and
> (c) moving at < 0.6 m/s. Before their release night, essential characters are never all three at
> once.** The `Scripted` state (§9.7) keeps them paired, moving, or facing you. They are not
> protected; they are *busy*.

`essentialUntilNight` (§9.1): `dale` 4, `robin` 7, `bev` 6, `marg`/`coop`/`teddy` 4.

**The backstop.** If a player contrives the state anyway — through a rig, a physics edge case, a
bug — the grab input is ignored with **zero feedback**. No prompt, no sound, no animation, no
message. The hands simply do not come up. A player who notices will read it as having mistimed the
approach, which is the only reading that does not break the fiction.

### 13.4 The grab

From **Night 4** (§12.5). 4.5 s of contact from behind an unaware camper, silent. Camera and audio
spec: §4.5. It solves the immediate problem and creates three new ones:

1. **A body** — class E, must be dragged (0.34× speed, 2.6× noise, tool belt locked) to a
   concealment volume (§13.5).
2. **Discovery** → escalation rung 4, immediately and permanently.
3. **The manual notices.** From the next stage onward, `Blueprint` includes a small extra figure in
   the corner: the masked man, standing, with a red slash-circle over a second small figure. **It
   is a safety warning. It is not commented on.** Drawn in Ansel's hand (§8.5).

`stats.kills` is tracked. It changes exactly two things: the safety panel above, and the ending
stinger. **It does not appear on the night-end card** (§15.3) and no system ever remarks on it.
The game never says killing is wrong. It just quietly adds a page to the manual.

### 13.5 Body discovery — the check v1.0 never wrote

v1.0 said to hide a body "at least 40 m from any patrol node or hidden under the boathouse / in the
lake / under the build," and that "**Body found** → escalation rung 4" — by what test? There were
no volume definitions and no discovery formula, in a document that gave creaks a five-term
probability model. Here is the test.

**A body is an `Object3D` with `concealment ∈ {'open', 'concealed', 'submerged'}`.**

```
// evaluated at 4 Hz per body, against campers in Idle | Curious | Searching | Noticing
inRange   = d < discoveryRadius[concealment]
lit       = illuminationAt(body) > lumThreshold[concealment]
hasLOS    = one grid-occlusion test (§9.6), NOT a raycast
discovered = inRange && lit && hasLOS && inCone
```

| `concealment` | `discoveryRadius` | `lumThreshold` | Where |
|---|---|---|---|
| `open` | **14 m** | 0.10 | anywhere not listed below. Moonlight alone exceeds 0.10. |
| `concealed` | **1.5 m** | **0.45** | requires a torch aimed at it. See the volumes below. |
| `submerged` | **0** | — | **never discovered.** The lake, past 1.4 m depth. |

**The concealment volumes** are explicit named boxes, owned by `Props.js` and `CabinSite.js`, and
this is the complete list:

| Volume | Location | Capacity | Notes |
|---|---|---|---|
| Under the boathouse | (74, −61), the pile deck | 2 | 96 m from the plot; a long drag |
| Under the build | (0, 0), between the piers | 3 | **available from Night 1** — 0 m of dragging, and it is under the thing you are being graded on |
| The woodpile | (33, 32) | 1 | 46 m |
| The deadfall belt | `x > 220` | 4 | 220+ m. Absurdly far. Listed because a player will try it. |
| The lake | `z < −140`, depth > 1.4 m | ∞ | `submerged`. Requires wading to the depth limit (§3.2) while dragging at 0.34×. |

**The patrol-node rule from v1.0 is deleted** and replaced by the radius test above, because "40 m
from any patrol node" is unverifiable in a world with a published navmesh whose nodes move with
`patrolDensity`. A radius, a light threshold and an occlusion test are checkable.

**Bodies persist across nights.** A body concealed under the build on Night 4 is still there on
Night 7, and if the player ever removes the parts above it, `concealment` flips to `open`.

### 13.6 The endings

`STORY.md §8` is canon. The house is finished at 03:40. The rain has stopped. It is the first time
in the game the world is quiet. The player walks the interior with no HUD, opens the manual, the
wipe plays, **the pages are blank**, and on the last page is the dotted outline of a small seated
figure and an empty parts-list bracket.

**The game gives the player exactly one verb: `place`.**

| Ending | Flag | Trigger | What happens |
|---|---|---|---|
| **A — "RETURN TO STORE"** | `ending_a` | The player fetches Robin from the treeline (she has come back every night) and takes her inside. | No chase, no struggle scene, no cut away. `ROB_LATE_03`, unfinished. Then the player opens the manual to confirm the step and **the panel updates in real time in Ansel's hand — and the manual draws a red diagonal across it.** The only red mark ever aimed at the player. The only judgement the manual has ever passed. The mascot's arms are at its sides. Marit never told him to do this. Then the pages go blank. All of them. Including the ones he drew. |
| **B — "DO NOT FORCE"** | `ending_b` | The player walks out and does not come back. | The camera holds on the house from the treeline for **90 s** while the sky greys. Nothing happens. Nothing has ever happened here. Buses at nine. Bleak, honest — and not the true one. |
| **C — "SOME ASSEMBLY REQUIRED"** | `ending_c` | **The player sits in the small chair.** | Available from the moment the house is done. No prompt. Most players find it because seven nights have taught them to look for the slot that fits. |

**Ending C, specified:**

- The interaction is a `place` on the child-sized chair with **the player as the part**. `Player.js`
  hands control to `NightManager`; `build:place { part: 'ANSEL', slot: 'CHAIR-SMALL', correct: true }`
  fires. It is the last event the gameplay layer emits.
- The mask comes off. **The camera does not show his face** — the mask simply enters frame and is
  set down on the table: glazed, cracked, two holes too far apart. His hands are on the table and
  they are ruined (`crackAmount = 1.0`, §4.4).
- The manual is open beside it, blank, and it stays blank, because she died in 1962 and she never
  drew what comes after the house is finished.
- At **06:15**, the first bus turns off the county road, 240 m south (§3.3). You hear it *through
  the wall*, because he built the wall correctly, and a correctly built wall carries sound from a
  road exactly this way. `NoiseSystem`'s occlusion grid is what makes that literally true.
- Kids. A lot of them. Screaming the good way.
- **He does not get up.**
- **Last panel**, over black: one final diagram in Marit's confident single-stroke hand — the
  finished house in three-quarter elevation, **exactly as the player built it**, with a tick beside
  it. `Blueprint` renders it from `state.installed`, so a player who left a joist rotated on Night 2
  sees it rotated here, ticked anyway. And in the corner, where the maker's mark goes on every page:
  **VIK & SØN**.
- Achievement, in the flat-pack voice: **"NO PARTS REMAINING."**

---

## 14. SAVE, RETRY, AND REPLAY

`ARCHITECTURE.md §8` calls `GameState` "the save file." Nights run 13–23 minutes in a browser tab,
and §13.2 makes three bad nights a permanent game over. v1.0 said nothing at all about saving,
which for a 2-hour browser game is the defect most likely to end a playtest early.

### 14.1 Autosave

| Trigger | What is written |
|---|---|
| `night:begin` | full `GameState` snapshot → slot `night-<n>-start` |
| `build:stage-complete` | full snapshot → slot `checkpoint` (rolling, single) |
| `night:complete` / `night:failed` | full snapshot → slot `night-<n>-end` |
| every 60 s during `phase === 'build'` | `checkpoint` refresh |
| tab `visibilitychange` → hidden | `checkpoint` refresh, synchronously |

Storage: `localStorage` under `slashercabin.save`. A full `GameState` with 90 slots, 7 campers and
the flag set is **< 24 KB** serialized, well inside quota. `Blueprint` output is **not** saved — it
is regenerated from `(night, seed)`, which is what determinism (`ARCHITECTURE.md §6`) is for.

### 14.2 What restoring does

| Restored exactly | Reset on restore |
|---|---|
| `installed` (every slot, `torque`, `w`, `sawProgress`) | every camper → `Idle` at its nearest patrol node |
| `inventory`, `toolsFound`, pocket fasteners | all detection meters → 0 |
| `timeOfNight`, `suspicion`, `creaks`, `creakDebt` | `lastNoisePos` cleared |
| `storyFlags`, `stats`, `structureKnowledge`, per-camper `familiarity` | weather re-derived from `(night, timeOfNight)` — deterministic, so the storm schedule is identical |
| body positions and `concealment` | — |

Campers reset to `Idle` because restoring a mid-chase FSM produces unfair, unreadable states. The
cost is that a checkpoint reload can be used to shed a Searching camper. **That is an acceptable
exploit** and we are not going to fight the player over it — the thing being protected is a
two-hour playthrough in a tab that can be closed by a stray gesture.

### 14.3 The player-facing options

| Option | Where | Effect |
|---|---|---|
| **Resume** | title screen | loads `checkpoint` |
| **Restart night** | pause menu, one keypress, **no confirmation shaming copy** | loads `night-<n>-start`. Prior nights' cabin is intact. |
| **Replay any completed night** | night-end card, and a chapter list on the title screen | loads that night's `night-<n>-start`. Later nights' progress is preserved in a separate branch slot and restored if the player returns. |
| **Continue after `'evacuated'` / `'incomplete'`** | game-over screen | offers **"Replay Night N"** as the default action. "New game" is the second option, not the first. |

**Yes, you can replay Night 3.** That question had no answer in v1.0 and it needed one, because
§13.2's game-over condition is otherwise a two-hour punishment for a bad twenty minutes.

There is no permadeath mode, no ironman toggle, and no achievement gated on not reloading. The
persistence that matters — the cabin remembering every mistake (§12.8) — is a fiction we impose on
the *house*, not on the person holding the mouse (Pillar 5).

---

## 15. SCORING & THE NIGHT-END CARD

Rendered by `Menu.js` on `night:complete { night, score }`. Flat, bright, clinical — white paper,
thin black lines, one `#d92b2b` accent, Helvetica-alike (`ART_DIRECTION.md §8`). It should feel
like a receipt printed by something that does not know what it is a receipt for.

### 15.1 The score object

```js
Score = {
  partsInstalled, partsTotal,
  joinsCorrect, joinsUnderFastened, joinsRotated, joinsWrongSlot, joinsWrongPart,
  perfectJoins, creaks, peakCreakDebt,
  fastenersSupplied, fastenersRequired,
  metresWalked, metresHauled,
  campersEvaded, shortReports, longReports,
  timeUsed, timeRemaining,
  hardwareShortfalls, hardwareRecovered,
  recuts, sawSeconds,
  assemblyQuality   // 0..100
}
```

```
assemblyQuality = clamp(
    100
  -  5.0 * joinsUnderFastened
  -  8.0 * joinsRotated
  - 12.0 * joinsWrongSlot
  - 24.0 * joinsWrongPart
  -  0.8 * creaks
  - 15.0 * shortReports
  - 25.0 * longReports
  +  2.5 * perfectJoins
  +  8.0 * (timeRemaining > 0.12 ? 1 : 0),
  0, 100)
```

`stats.kills` appears nowhere in `Score` and nowhere on the card. See §15.3.

### 15.2 The card, and how it dies

Twelve lines on Nights 1–3. From Night 4 the card **loses lines**, one group per night, until
Night 7's card is one line. **Nothing announces the drop.** This is the same trick `STORY.md §9`
pulls with the missing sub-lines on the Night Five and Night Seven title cards, which is the best
joke in either document — and v1.0 never noticed it was there.

| # | Line | Example | Dropped after |
|---|---|---|---|
| 1 | `ASSEMBLY REPORT — STEP n OF 7` | | N6 |
| 2 | `PARTS INSTALLED` | `14 / 14` | N6 |
| 3 | `JOINS, CORRECT` | `11` | N6 |
| 4 | `JOINS, NOT AS ILLUSTRATED` | `2` | N6 |
| 5 | `JOINS, REQUIRING REPLACEMENT` | `1` | N6 |
| 6 | `FASTENERS, SUPPLIED` | `36` | **N4** |
| 7 | `FASTENERS, REQUIRED` | `39` | **N4** |
| 8 | `AUDIBLE FROM STRUCTURE` | `9` | **N5** |
| 9 | `DISTANCE CARRIED` | `1,204 m` | **N5** |
| 10 | `TIME REMAINING` | `00:41` | **N5** |
| 11 | `ASSEMBLY QUALITY` | `62 / 100` | N6 |
| 12 | `THANK YOU FOR CHOOSING SELF-ASSEMBLY.` | (always) | **N3** |

**Lines per night: 12, 12, 12, 11, 9, 6, 1.**

- **Night 4** drops line 12. The manual stops thanking you the night the comedy dies.
- **Night 5** drops 6 and 7. It stops counting hardware — the night the missing part is a person.
- **Night 6** drops 8, 9 and 10. It stops counting noise, distance and time.
- **Night 7** is one line, centred, alone on the page:

```
ASSEMBLY COMPLETE.
```

At `assemblyQuality >= 95`, one extra line, Nights 1–6 only: `NO FURTHER ACTION REQUIRED.`
At `assemblyQuality <= 20`, Nights 1–6 only: `RETAIN THIS DOCUMENT.`

### 15.3 The register test, and what v1.0 got wrong

v1.0's card was headed "**all of it deadpan, none of it acknowledging the murder**" and then read:

```
PERSONS WHO EXPRESSED CONCERN            3
PERSONS WHO EXPRESSED CONCERN TO OTHERS  1
JOINS, ORIENTED CREATIVELY               2
JOINS, WHICH WE WILL NOT DISCUSS         1
...and in red, at any kill count > 0:    PLEASE ASSEMBLE ALONE.
```

That last line is **a pun about killing people, aimed directly at the player, in red.** It is the
camera-wink Pillar 1 forbids; it merely moved from the 3D scene to the UI layer, where nobody was
checking. It also breaks `STORY.md`'s non-negotiable that the manual "stops being funny on Night
Four" — v1.0 had it getting *funnier* the more people you killed. And `JOINS, ORIENTED CREATIVELY`
and `JOINS, WHICH WE WILL NOT DISCUSS` are the same register: the manual being **arch**, not the
manual being **serene**. All of it is deleted.

**The register test, binding on every line of copy in this game:**

> Read the line aloud in the voice of a document that does not know a person is reading it.
> If it lands as a joke, it must land because the *situation* is absurd — never because the
> document has noticed the situation is absurd. **The manual has no sense of humour. It has a
> job.** `JOINS, NOT AS ILLUSTRATED` is a phrase a real assembly document would print. `JOINS,
> ORIENTED CREATIVELY` is a comedian's phrase wearing a document's clothes.

**Corollary: the card never mentions people.** No kill count, no "persons," no euphemism for a
person. Not because the game is squeamish, but because a flat-pack assembly report has no field
for it, and the moment it invents one, it has noticed — and the whole device is that it never
notices. The player's kills are recorded in exactly one place in the entire game: a small safety
panel in the corner of the manual (§13.4), drawn without comment.

---

## 16. ACCESSIBILITY & OPTIONS

**Requested additions to `Settings`** (`ARCHITECTURE.md §7`) — Engine agent to add these exact
keys; every other system reads them via `settings.get()`:

```js
difficulty: 'standard',            // 'story' | 'standard' | 'gristle'
puzzleHints: 'standard',           // 'off' | 'standard' | 'generous'
creakAssist: false,                // wrong joins get a persistent diegetic marker
holdToCarry: true,                 // false = toggle instead of hold
holdToCrouch: false,               // true = hold, false = toggle
holdToToggle: false,               // ALL holds become tap-to-start progress bars (§4.2)
photosensitive: false,             // §16.2
lightningFlashes: 'full',          // 'full' | 'reduced' | 'off'   ← new in v2.0
reducedGore: false,                // §4.5
subtitleSize: 'medium',
subtitleBackdrop: true,
directionalAudioIndicator: false,
reduceViewNoise: false,
manualContrast: 1.0,               // 0.8 .. 1.6
devTelemetry: false,               // §19 instrumentation, dev builds only
```

### 16.1 Difficulty modes

| | `story` | `standard` | `gristle` |
|---|---|---|---|
| `diffMul` (detection accrual) | 0.62 | 1.00 | 1.35 |
| Night duration × | 1.30 | 1.00 | 0.85 |
| Creak `lambda` × | 0.60 | 1.00 | 1.25 |
| **Seating band half-width `h`** | **0.150 (900 ms)** | **0.075 (450 ms)** | **0.055 (330 ms)** |
| Shortfalls per night | −1 (min 1) | as §6.9 | +1 |
| `'reported'` nights to `'evacuated'` | 5 | 3 | 2 |
| G6 errata slip | always Tier 1 | as designed | may not exist |
| Manual stays open while walking | yes | yes | **no** — you must stop to read |
| Recut board cost | 0 | 1 | 2 |

`gristle` is unlocked from the start. **Difficulty is changeable mid-run, no penalty, no shaming
copy, and the night-end card does not mention it.**

**On `gristle`'s 330 ms seating window:** with the 120 ms input-latency allowance (§4.1, §6.5) that
is 210 ms of real margin — genuinely hard, deliberately so, and stated in milliseconds here so that
nobody has to invert an exponent to discover it, which is what v1.0 required.

### 16.2 Vision, motion, and the photosensitivity fix

- **Colorblind** (`settings.colorblind`): the only load-bearing colour is the manual's `#d92b2b`.
  In deuteranopia/protanopia it becomes `#0b57d0`; in tritanopia, `#c2185b`. **Every red mark is
  redundantly encoded** with a 1.5 pt dashed stroke and a corner tick — colour is never the only
  channel.
- **`manualContrast`** raises the blueprint overlay's paper luminance and stroke weight
  independently of the 3D scene's exposure. The §8.4 legibility invariant is asserted at the
  *default* value, so raising it can only help.
- `motionBlur`, `filmGrain`, `chromaticAberration`, `vignette`, `headBob` all disableable
  (`ARCHITECTURE.md §7`). `reduceViewNoise` damps the handheld noise from ±0.35° to ±0.08° without
  removing it (removing it entirely breaks the "big heavy man" read; the game asks first).

**Photosensitivity — v1.0's accommodation was a no-op that also made the game easier.** It
"capped lightning to 1 flash per 12 s" against a schedule of 6 strikes in 1020 s — one per 170 s,
so the cap never engaged — while "compensating by lengthening thunder windows 1.4×," which made
the mode strictly easier than `standard`. Both halves are replaced. With the real Night 6 schedule
(~33 strikes, one per 25–60 s), this matters:

| Setting | Flash | Timing information preserved? | Difficulty delta |
|---|---|---|---|
| `lightningFlashes: 'full'` | 40 ms spike, full luminance delta | yes | baseline |
| `'reduced'` (auto-set by `photosensitive: true`) | **180 ms soft ramp**, luminance delta **≤ 25%**, no white frame | **yes** — the ramp peaks at a defined instant and the flash-to-thunder count is unchanged | **none** |
| `'off'` | replaced by a **1.2 s sky-glow** with no transient — the horizon brightens and fades | **yes** — the glow's onset is the timing cue | **none** |

**The strike schedule, the thunder delay and the envelope lengths are identical in all three
modes.** The accommodation is perceptual, not mechanical. A photosensitive player counts the same
seconds, gets the same windows, and plays the same game. Making the mode easier would have been a
worse insult than the flash.

### 16.3 Audio & puzzle

- **Subtitles** cover all `ui:subtitle` events. Distant camper VO is subtitled with a **direction
  and distance prefix**: `[NE, distant] "…did you hear that?"`. Mechanically relevant non-verbal
  sounds are captioned too:
  - `[creak — north, near]`
  - `[thunder — 3 seconds]` ← **essential** for deaf players to use thunder masking (§7.5)
  - `[saw — you, 90 m]` ← so a deaf player can budget the Night 3 cut
  - `[breathing — you]` ← so a deaf player knows their stamina is emitting (§10.2)
- `directionalAudioIndicator` draws a thin arc at the screen edge for any `noise:emit` **the player
  produced** above intensity 0.3, and any camper `voice` within 40 m.
- `puzzleHints`:
  - `off` — no map inset, no audio cue, no rim light. The manual and nothing else.
  - `standard` — the three-layer ladder in §6.9.
  - `generous` — adds a persistent diegetic marker: the missing item is chalk-marked with an ✕ on
    the manual's map inset, and a wrong join shows a small red thread tied to it in world space.
    On Night 5, adds the counterweight panel (§6.7). **Nothing is highlighted through walls;
    nothing pauses time.**
- `creakAssist` — wrong joins get a permanent thin red chalk line on the timber at the join.
  **Recommended for players who find the diagnostic layer frustrating.** It removes the *detective*
  game, not the *stealth* game.

**The design rule for accessibility here:** the horror lives in darkness, weight, and time
pressure — none of which we relax. The frustration lives in *not knowing what you did wrong*,
which we relax completely.

---

## 17. THE FIRST FIVE MINUTES

Zero text tutorial. Zero prompts beyond the icon-only `ui:toast`. Everything is taught by the
manual and by level design. Night 1: `nightDurationSeconds = 800`, rain 0.15, wind 0.20, fog 0.35,
best moon of the game, `dale` on a loop that will not reach the plot.

The title card (`STORY.md §9`) plays first: **NIGHT ONE / FOUNDATION (A)** with the sub-line
*Check contents before beginning.* — thin black on flat white, 2.4 s, no music.

| t | Beat | Systems | What it teaches |
|---|---|---|---|
| **0:00** | Black. One `audio:sfx { id:'crate_settle' }`. Then wind in pines, and one distant laugh from 140 m NE (`DAL_IDLE_01`, 3D, occluded). | Audio, Sky | The world before the interface. |
| **0:04** | Fade in over 3 s. You are looking down at your own hands, which are enormous. `settings.fov 72`. | Player, HUD | Pillar 4, in one image. |
| **0:07** | **The hand-wipe plays.** 0.9 s, two strokes, palms flat. *Then* the manual opens at 40% of screen. | Player, BlueprintUI | The most important 0.9 s in the game, and the player has no idea yet (§4.4). |
| **0:09** | The manual's first figure: the masked man, a single pier block, a straight arrow pointing down into a square outline. Below it: `1/6`. Marit's hand. | Blueprint (G1) | The whole grammar, in one picture. |
| **0:14** | Player looks up. Manual auto-lowers to hip. Ahead: six squares chalked on cleared ground, glowing faintly, and pallet A **12 m** away with six pier blocks on it. | CabinSite | Diagram-space → world-space. **The chalk squares literally match the drawing.** |
| **0:22** | First step. Head bob, breath, the 0.23 s accel ramp. A `footstep` emits; nothing hears it. | Player, NoiseSystem | Weight. Slowness. |
| **0:34** | The player walks into a low branch (deliberately placed at 1.9 m — you are 1.7 m and you still hit it). `brush` noise. Rustle for 1.1 s. Far off, Dale's torch **stops for 2 s**, then resumes. | Campers (Curious→Idle) | *Noise reaches people. People react. You survived it.* Taught at zero risk. |
| **0:41** | At the pallet: `ui:toast { icon:'hand' }`, 900 ms, no words. Pick up a pier (class C, 24 kg, **2 slots**). Speed → 1.312 m/s. Screen tilts 2°. | BuildSystem, Physics | Carrying costs. |
| **0:48** | The player picks up a **second** pier (2 + 2 = 4 slots). Speed → 1.075 m/s. **Two trips become one.** | BuildSystem | The carry economy, discovered rather than explained (§6.2). |
| **0:55** | Approach a chalk square. A white ghost of the pier appears at 0.65 m. | BuildSystem | Snapping. |
| **1:02** | Place. `build:place { correct:true }`. Soft thunk. The seating check opens automatically **the first time only**, with the band drawn at 2× width and time at 0.6× for this one instance. | BuildSystem | The torque check, in a safe room. |
| **1:07** | Perfect join. `stats.perfectJoins = 1`. The manual, still at hip, redraws `1/6` as `1` with a tick. **No sound, no toast.** | BlueprintUI | Progress is legible on the paper, not the HUD. |
| **1:12–2:05** | Piers 2–5. The player finds the rhythm: pallet → slot → seat. Around pier 3 they start hammering casually. **On pier 4, a distant voice reacts to the hammering** — `[NE, distant] "Huh."` (`DAL_HEAR_01`) — and the torch stops for 4 s. Nothing else happens. | Campers, VoiceBank | The hammering is heard. Bank it. |
| **2:05** | Pier 6. The pallet is **empty.** Six squares, five blocks supplied. `tool:missing { toolId:'pier_06' }`. The manifest shows the sixth outlined in red with a 40 m contour inset. | Blueprint, BuildSystem | **The core comedy, in the first three minutes.** |
| **2:12** | Nothing is highlighted. The item is **stone**, so there is no audio cue at any point (§6.9). The inset shows a slope and a fallen log. | BlueprintUI, Terrain | Spatial reading is the skill, and the game will not do it for you. |
| **2:40** | 30 m east, down a slope, behind a fallen log: the sixth pier, half-buried — and beside it a **folded licence plate** (the shim, `STORY.md §7` object 1) **and the mallet**, which the player did not know they were missing, because they had been using their hands. | CabinSite, Props | The joke lands twice, and one of the two things is a piece of the ending. |
| **2:48** | `tool:found` ×2. The bell. Two red outlines redraw in black. The mallet goes to the **tool belt**, not a carry slot. | BuildSystem, Audio | The reward feeling, established. The tool belt, established. |
| **2:55** | Carrying the pier back **uphill** — class C on a 14° grade (×0.88) — Dale's loop crosses the return path at 45 m. The player sees the torch. | Campers, Navmesh | The first real stealth read. He **cannot** reach the plot. This is theatre and it is safe, and the player does not know that. |
| **3:20** | Most players crouch here without being told. If they do: `motionF 0.65`, footsteps ×0.08, and the torch passes. If they don't: detection reaches ~0.30 and decays (§9.3 — unlit, walking, 20 m is 29.9 s to detect and he is there for 8). Either way they survive. | Campers, Player | Crouching is discovered, not instructed. |
| **3:50** | Pier 6 placed. Shim goes under pier D: 2.5 s, silent. `build:stage-complete { stage:1 }`. The manual turns its own page with a paper sound. Figure 2: sill beams, class D, 62 kg. | BuildSystem, BlueprintUI | Escalation of mass. |
| **4:05** | First class-D lift. Speed → 1.008 m/s. **The beam blocks the lower 28° of the screen.** The player cannot see their feet. They walk 18 m like this. | Physics | The hauling terror, at zero risk, on flat ground. |
| **4:30** | Beam 1: `yawCandidates 2`, `symmetryOrder 2` — **both** orientations are correct, and it seats either way. **Beam 2 has `symmetryOrder 1`.** The ghost renders identically for both candidates (§6.4.2). If the player places it the wrong way round, it seats, and nothing at all happens. | BuildSystem | Rotated is a real, reachable outcome — which in v1.0 it was not. |
| **4:39** | **The first creak.** Severity ~0.45, radius 35 m. A long, wet groan. `build:creak`. Then `DAL_HEAR_01` again — and this time **the torch turns toward the plot and starts walking.** | BuildSystem, Campers | The thesis of the game, delivered in one sound. |
| **4:52** | The player must now re-seat (8 s + 3.0 s, loud), or hide, or freeze. **All three work.** Dale Searches for 30 s at a point 12 m off (error radius, §9.8), then returns to Idle. | Campers | Every verb in §9.6 is now motivated. |
| **5:00** | The player understands the game. | | |

**On what has and has not been written on screen.** v1.0's card at 5:00 read "No word has been
written on screen," which was false — `STORY.md §9` puts a text title card up before 0:00, and the
night-end card is fourteen lines of English. The accurate claim, and the one that matters:

> **Since the title card, the game has not addressed the player once.** Every word the player has
> seen is the manual's — a document that does not know they exist. No tutorial prompt, no button
> glyph, no objective text, no tooltip. The title card and the night-end card are the manual
> talking to itself; the 3D world has said nothing at all.

**The acceptance test for this sequence** is §19 row **A1**. v1.0 asserted that if the player does
not flinch at 4:39 "the game has failed and the sequence must be retuned until it does" — without
saying retuned how, against what measurement. It now has both.

---

## 18. PERFORMANCE

`ARCHITECTURE.md §12` is binding: **16.6 ms at 1920×1080 on an M-series Mac**, no system over
1.5 ms, **max 12 raycasts per frame across the whole game**, draw calls < 220.

### 18.1 The per-system millisecond budget

| System | Budget (ms) | Notes |
|---|---|---|
| `Player` + `Physics` (capsule, ground) | 0.55 | |
| `Physics` carried-part collision | **0.40** | §10.3, hard cap with a stated fallback |
| `Campers` (senses + FSM + navmesh follow) | **1.20** | §18.2 |
| `NoiseSystem` | 0.18 | grid lookups only, zero raycasts |
| `BuildSystem` (creak ticks, slot queries) | 0.25 | 6 joins/frame max |
| `NightManager` + `Weather` | 0.10 | |
| `Forest` (wind uniforms, chunk streaming) | 0.60 | |
| `Audio` | 0.35 | `AUDIO_DIRECTION.md §9.3` |
| `Sky` + `VolumetricFog` | 1.40 | |
| `Postprocessing` | 3.80 | |
| **Shadow passes** | **4.20** | §18.3 — the largest single cost in the game |
| Draw submission + misc | 2.10 | |
| **Total** | **15.13** | 1.47 ms headroom at 60 fps |

### 18.2 The raycast budget — reconciled

v1.0 specified `occlF` from "**5 sample raycasts** per camper, per frame," which on Night 7 with
9 agents was **45 rays/frame** against a hard cap of 12 — before `NoiseSystem`'s "max 4 blockers
sampled" per camper per noise event, before `skylineFraction`'s 5 more, and before 6 creak
evaluations fanning out to 9 campers. It was over budget by 3.75× at minimum, and v1.0 forbade the
obvious escape hatch itself ("gameplay constants must never be routed through `settings.tier()`").

**The allocation, summing to 10 of 12:**

| Consumer | Rays/frame | Scheme |
|---|---|---|
| **`Campers` — the hot camper** | **5** | The single camper with the highest `detection`, or if all are 0, the nearest with the player in cone. Full 5-ray solve (head, shoulders ×2, hips ×2) **every frame**. |
| **`Campers` — everyone else** | **2** | 1 ray each (chest only), round-robin, 2 campers per frame. With 9 agents that is a **6.7 Hz** refresh. |
| **`Campers` — the flame percept** | **1** | §9.4. One ray, flame → hot camper's eye. Round-robins with the others when the hot camper has the lantern out of view. |
| `Physics` — `skylineFraction` | **1** | Cached hemisphere probe, 8 directions, 1 ray/frame → full refresh at **7.5 Hz** |
| `Player` — ground + step | **2** | |
| **Total** | **10 / 12** | 2 spare for `Physics.raycast()` callers |

**Rejection before any ray is cast** (this is what makes the budget work at all):

1. Distance: `d > R` → skip entirely, `occlF` irrelevant.
2. Cone: player outside the 55° half-angle → skip.
3. Grid: the §9.6 occlusion grid gives a **free conservative answer** — if every 2 m cell along
   the segment is opaque, `occlF = 0` with no ray at all. This resolves most cases in forest.
4. Only what survives all three gets a ray.

**Staleness clamp.** A cached `occlF` older than **1.0 s** is forced to **1.0** (assume visible),
not to its last value. Assuming *visible* is punishing but safe; assuming *hidden* would be an
exploit — a player could hide 9 campers' worth of rays behind a round-robin and walk past all of
them. The conservative direction is the correct one.

**`NoiseSystem` casts zero rays.** Occlusion comes from the 2 m byte grid (§9.6), which is also
what makes placed cabin walls acoustically real. `skylineFraction` comes from a cached probe, not
from a per-frame fan.

**On the critic's suggestion of a uniform 12 Hz round-robin:** rejected in favour of the split
above. A camper actively looking at you needs frame-accurate occlusion — the player dodging behind
a trunk must register *now*, and at 12 Hz it registers up to 83 ms late, which is exactly the
moment the player is judging the game's fairness. A camper 60 m away facing the lake needs nothing.
Uniform budgets spend the same on both. This one spends 5 rays on the camper that matters and
1/4.5th of a ray on the ones that do not.

### 18.3 The shadow cost — the thing v1.0 never mentioned

A moving `SpotLight` with `PCFSoftShadowMap`, re-rendering an instanced forest every frame from the
player's hand, is the most expensive object in this game, and v1.0 asserted a CoD-comparable image
at 60 fps in a browser without once costing it.

| Caster | Map size | Update rate | Far plane | Layer contents |
|---|---|---|---|---|
| **Moon** (`DirectionalLight`) | `tier(1024, 2048, 2048, 4096)` | **cascade 0** every frame; **cascades 1–2** every 3rd frame, reprojected | 180 m | trees < 40 m, cabin, campers, rocks, tents (`ART_DIRECTION.md §3.3`) |
| **The lantern** (`SpotLight`) | `tier(512, 1024, **2048**, **2048**)` | **every 2nd frame**, reprojected against the player's velocity | **22 m** | **only** objects tagged `castLanternShadow`: cabin parts, loose parts, campers, and trunks within 22 m |
| Campfires (≤ 3) | 512 | every 4th frame | 14 m | tents, campers, props |

**The lantern is capped at 2048 even on `ultra`.** 4096 for a per-frame moving spot through an
instanced forest is not affordable in WebGL2 in a browser, and the visual difference at a 22 m far
plane is not detectable — the shadow is soft, close, and constantly moving. This is a quality-tier
decision (pixels, not outcomes) and therefore legal under §20.4.

**Instanced forest shadow submission:** trunks render to the lantern map via a single
`InstancedMesh` with a per-frame frustum-culled instance range, rebuilt only when the player moves
more than 4 m. Foliage does **not** cast into the lantern map at any tier — it casts into the moon
map only. Budget: **4.20 ms total** across all three casters (§18.1).

**SSCS** (`ART_DIRECTION.md §3.3`) is charged to `Postprocessing`, not here.

### 18.4 Audio budget

Owned by `AUDIO_DIRECTION.md §9.1` and §9.3; the numbers this document is responsible for
respecting:

- **Per-family voice caps:** max 3 simultaneous creaks, 2 hammers, 1 thunder, 4 VO, 6 footsteps
  across all agents. The `CABIN_CAP` of 4.0 creaks/min (§7.2) **guarantees** the 3-creak cap is
  never exceeded, including during a settle cascade — which in v1.0 fired 3–5 simultaneous creaks
  into a storm with no stated cap and would have hitched.
- **The cascade's audio contract:** 3–5 joins fire within 1.5 s but `AudioEngine` renders at most
  3; the remaining 1–2 are **dropped, not queued** (a late creak is a lie about where the sound
  came from). Their `noise:emit` still fires — the AI hears what the player does not, which is the
  correct asymmetry for a horror game.
- `AudioEngine.update()` < 0.35 ms/frame; audio thread < 25% of one core on `ultra`.

### 18.5 Determinism

Every spawn, every storm schedule, every blueprint layout derives from `ctx.settings.seed`
(default `0x51A5CAB`) via `new Rand(hash2(a, b) * 1e9 | 0)`. Consequences this document relies on:

- Weather can be re-derived from `(night, timeOfNight)` on save restore (§14.2) — the storm
  schedule is bit-identical, so a reloaded Night 6 has the same 33 strikes at the same times.
- `Blueprint` output is not serialized (§14.1); it is regenerated.
- Golden-image regression for the manual (§8.6) is possible at all.

---

## 19. ACCEPTANCE TESTS

v1.0 contained roughly a dozen sentences doing the work that specification should do — "the
cascade is **the game's scariest moment**", "**it is terrifying**", "the game's **best sequence**",
"the player **will feel it in their stomach**", "**the thesis statement of the entire game**", and
worst, as the acceptance test for the tutorial: "if the player does not physically flinch… **the
game has failed** and the sequence must be retuned until it does" — retuned *how*, against *what
measurement*?

None of those is falsifiable and none tells an implementer what to build. Every one is now a row
below, with an instrument and a remedy. **A target without an instrument is not a target.**

**Instrumentation.** `settings.devTelemetry: true` (dev builds only) writes a ring buffer of input
events, `player:move`, detection values, and all `build:*` / `noise:emit` traffic at 30 Hz to a
downloadable JSON. Playtests are additionally screen- and input-captured. Startle is measured as
**mouse/stick angular velocity > 400 px-equivalent within a 200 ms window, or a stop-and-crouch
within 1.5 s** — either counts.

| # | Claim being tested | Instrument | Threshold | Remedy if it fails |
|---|---|---|---|---|
| **A1** | The 4:39 first creak teaches that a badly-built cabin tells on you | first-time playtesters, n ≥ 20, telemetry + screen capture at 4:39 ± 3 s | **≥ 70% exhibit a measurable startle**, and ≥ 85% take a defensive action (re-seat / hide / freeze) within 6 s | raise creak `severity` in **0.05** steps (from 0.45) and shorten the delay from placement in **1 s** steps (from 9 s). Re-test after each step. Do not exceed severity 0.65 — past that the tutorial creak is louder than a Night-4 creak and the curve inverts. |
| **A2** | Nights are the right length | telemetry `timeOfNight` at `night:complete`, n ≥ 20 per night | **median ∈ [0.82, 0.97]** per night | adjust `SLACK` (§5.2), **not** `nightDurationSeconds`. The night length is derived. |
| **A3** | The 30% slack is enough for real play | same run set | **≤ 10% of runs hit `reason: 'dawn'`** on nights 1–5; ≤ 25% on nights 6 | raise `SLACK` by 0.05 and re-derive all seven lengths from §5.2 |
| **A4** | The report chase is winnable when unencumbered and lost when encumbered | telemetry: short reports begun vs interrupted, split by `carrySlotsUsed` at report start | **unencumbered intercept 60–80%**; **encumbered intercept ≤ 5%** | if intercept > 85%, raise Panic speed to 3.10 m/s (§9.7) before touching anything else. If < 50%, extend the short report from 26 s to 30 s. |
| **A5** | The four detection targets (§9.3) hold in the built game | automated scene test, not playtest: a scripted player at fixed poses/distances, 100 trials each | T1 **never** detected in 300 s; T2 **22 s ± 1.5**; T3 **3.6 s ± 0.4**; T4 **0.80 s ± 0.08** | the constants are solved, so a failure here is an implementation bug, not a tuning gap. Fix the code. |
| **A6** | The settle cascade is a climax, not routine | telemetry: cascades per night per run | **≤ 1 cascade per run on nights 1–3**; **1–3 on nights 4–6**; **0 on night 7** (asserted, §12.8) | if > 1 on early nights, lower accrual from 0.10 toward 0.08. If 0 on nights 4–6, raise decay from 0.15 toward 0.12. Never change `CABIN_CAP`. |
| **A7** | Players learn the 0.85 horizon tell in about three nights | post-session structured interview + telemetry (rate of "hurried" behaviour — sprint use, set-down→drop ratio — in the last 15% of the night) | **≥ 60% of players show a behaviour change after `timeOfNight` 0.85 by Night 3**, without ever having been told | if < 60%, raise the shift from 6% to 9% toward `#2a3340`. Do **not** add a clock. |
| **A8** | Finding a missing part feels good with no words and no fanfare | post-session: unprompted mention of the checkbox/bell; telemetry: time-to-resume-building after `tool:found` | **≥ 50% mention it unprompted**; median resume < 8 s | if the reward reads as flat, lengthen the chime decay 1.4 → 1.8 s. Do **not** add text. |
| **A9** | The manual is readable | automated, every golden render (§8.6) | **every part silhouette ≥ 40 px** at 1080p, default `manualContrast`; **0 arrow-arrow crossings** nights 1–5, ≤ 4 on night 6 | split the stage across two spreads. Never shrink below the invariant. |
| **A10** | The manual's safety panel (§13.4) lands without commentary | post-session: unprompted mention; **and** a negative check — no participant should describe the game as "making fun of" the killings | **≥ 40% mention the panel**; **0% report the game as joking about the deaths** | the second threshold is a hard gate. If any participant reads the panel as a gag, redraw it flatter — fewer strokes, no expression on the mascot. |
| **A11** | Night 6 is the worst night, and Night 5 is the scariest image | post-session ranking of the seven nights on "most frightened" and "most memorable image" | **Night 6 ranks top-2 on frightened for ≥ 60%**; **Night 5 top-2 on image for ≥ 50%** | if Night 6 under-ranks, lower its camper count floor from 2 to 1 before adding anything. Emptiness is the mechanism. |
| **A12** | The game runs | automated capture, 1080p, `quality: 'ultra'`, M-series Mac, Night 6 storm with 5 campers and a cascade | **p99 frame ≤ 16.6 ms**; **0 frames > 33 ms**; raycasts/frame ≤ 12 (asserted in code); draw calls < 220 | §18.1 budgets are per-system; the offender is identifiable. Fix the offender. |
| **A13** | Ending C is findable without a prompt | telemetry on Night 7: which ending fires, and time from house-complete to ending | **≥ 45% reach `ending_c` on a first playthrough**, median < 6 min | if < 25%, have `Blueprint`'s final page render the dotted chair outline at 1.15× scale. Never add a prompt, a marker, or an interact glyph. |
| **A14** | The comedy dies on Night 4 | post-session: per-night humour rating, 1–5 | **mean rating drops ≥ 1.5 points between Night 3 and Night 5** | if it does not, the card is still editorialising (§15.3) or the VO bank is still funny past Night 4. Audit both against `STORY.md`'s non-negotiables. |

---

## 20. IMPLEMENTATION NOTES FOR MODULE OWNERS

### 20.1 Ownership recap

- **`BuildSystem.js`** owns `state.installed`, `state.inventory`, `state.creaks`,
  `stats.perfectJoins`, `sawProgress`, and every `w` / `torque` value. It is the only writer of
  `build:*` and `tool:*`.
- **`Blueprint.js`** exposes `Blueprint.forNight(n, rand)` per §8.1 — **now including
  `authorship`**, which v1.0's signature omitted despite `STORY.md §3` requiring it. It draws
  nothing; `BlueprintUI.js` rasterises.
- **`Campers.js`** is the only listener of `noise:emit` that changes behaviour. It owns
  `state.suspicion`, `state.spotted`, `state.structureKnowledge`, and per-camper `familiarity`. It
  is the only emitter of `player:spotted` / `player:hidden`.
- **`Weather.js`** owns `weather:change` and must expose `nextStrikeIn()` and `maskLevel()` as
  plain synchronous methods; `NoiseSystem` calls `maskLevel()` once per frame and caches it.
  `Weather` must honour the **≤ 45 s strike guarantee** (§7.5).
- **`NightManager.js`** owns `state.night`, `state.phase`, `state.timeOfNight`, and is the only
  emitter of `night:*` and `story:beat`. It drives the `Scripted` camper state (§9.7).
- **`Player.js`** must expose `Player.illumination` (0..1), `Player.carrySlotsUsed` (0..4),
  `Player.flamePosition` (Vector3 | null) and `Player.lanternHooded` (bool) as read-only
  properties; `Campers` null-checks all four.
- **`CabinSite.js`** owns slot layout, silhouette features (§9.5), ruin anchors, and the
  concealment volumes (§13.5).
- Every tunable in this document belongs in a single exported `TUNING` object per module, so a
  balance pass never requires editing logic.

### 20.2 Requested `GameState` additions

`ARCHITECTURE.md §8` is owned by the Engine agent. These fields are **requested**, not assumed;
until they exist, every reader must null-check. All are plain serializable data (no Three.js
objects), per the contract.

```js
state.structureKnowledge = { seenBy: [], enteredBy: [], reportedAs: null, featuresKnown: {} };
state.campers            = { /* camperId → { familiarity:{}, alive:bool, state:string } */ };
state.bodies             = [ /* { camperId, position:[x,y,z], concealment:string } */ ];
state.sawProgress        = { /* partId → 0..1 */ };
state.stats.reportsTotal      = 0;   // short + long, all nights — drives rung 5
state.stats.shortReports      = 0;
state.stats.longReports       = 0;
state.stats.kills             = 0;
state.stats.recuts            = 0;
state.stats.creakDebtCarry    = 0;
state.stats.metresHauled      = 0;
```

### 20.3 Requested `Settings` additions

The full list is in §16. New in v2.0 beyond v1.0's request: `holdToCrouch`, `holdToToggle`,
`lightningFlashes`, `reducedGore`, `manualContrast`, `devTelemetry`.

### 20.4 The tier rule, restated without argument

> **Gameplay constants must never be routed through `settings.tier()`.** Quality tiers change
> pixels, never numbers that affect outcomes.

Difficulty is `settings.difficulty` and only ever `settings.difficulty`. §6.5's seating band is:

```js
const h = { story: 0.150, standard: 0.075, gristle: 0.055 }[settings.get('difficulty')];
```

v1.0 wrote `bandWidth = settings.tier(0.28, 0.20, 0.16, 0.16)` and then argued with itself in the
next clause — "no, use the **difficulty** setting, not the quality tier" — leaving a half-finished
edit in a document whose first line reads "This is the document gameplay agents implement." An
agent implementing literally would have shipped the wrong line. **A binding spec never
deliberates.** If a decision is unresolved, it does not go in the document.

The one place a quality tier touches something that *looks* like gameplay is §18.3's lantern shadow
map, capped at 2048 on `ultra`. That is a pixel decision (shadow softness at a 22 m far plane) with
no effect on `lum`, `flameVisibility`, detection, or noise. It is legal.

### 20.5 Where this document declines the critique, and why

The v1.0 review was right about most things and this document adopts most of it. Six places where
it is partially or fully declined, stated here so the reasoning cannot be lost or re-litigated by
someone reading only the diff.

**1. "Every stealth verb must be a construction verb." — Partially adopted.**
The *distraction* verb and the *cover* system are now construction verbs (§9.6: Provoke, and the
cabin rewriting `Navmesh` and the occlusion grid), and the thrown bracket is deleted. But crouch,
freeze, break-LOS and douse-the-lantern stay exactly as they are. They are the grammar of the form,
like WASD; a player arriving from any stealth game must be able to *do* something on Night 1
without being taught a bespoke vocabulary first. Replacing them with premise-native equivalents
would make the game more original and worse. The correct target was the verb that was *lazy* (the
noisemaker arrow with a caption pasted on), not the verbs that were *conventional*.

**2. Uniform 12 Hz occlusion round-robin. — Declined in favour of a hot/cold split (§18.2).**
A camper looking directly at you needs frame-accurate occlusion; at 12 Hz, ducking behind a trunk
registers up to 83 ms late, at exactly the moment the player is judging whether the game is fair.
A camper 60 m away facing the lake needs nothing. Uniform budgets spend equally on both. The split
spends 5 rays/frame on the camper that matters and ~0.22 rays/frame on each that does not, for the
same total.

**3. "The chase fantasy is structurally impossible in both directions." — Half adopted.**
The 90 m / 12 s arithmetic was indefensible and is fixed (§9.7: 26 s, 45 m cap, Panic 2.90 m/s +
stumble). But the implied fix — that the player should generally win chases — is declined. **Ansel
is not fast, and a running person should usually get away.** Panic speed is set so that a player
who *anticipated* can close, not so that a player who *reacted* can. The real decision the sequence
poses is "drop the 62 kg beam in the mud, or lose the night," and that is a better beat than a foot
race. Target A4 encodes it: 60–80% intercept unencumbered, ≤ 5% encumbered — deliberately not 95%.

**4. Wrong-part repair "at a brutal but survivable cost." — Adopted, with a scar.**
Recut (§7.4) exists from Night 1 and clears `w = 1.0`. But it clears it to **0.10, not 0.00**,
because you cannot unmake a split — you cut back to sound timber and sister the join, and it will
always be slightly the worse for it. A recut join still creaks, faintly, forever. The death spiral
is gone; the consequence is not. "The cabin is a record of your reading comprehension" (§12.8) has
to remain true or the whole creak system is decorative.

**5. "Felt pad → still 33 m, therefore the radius curve is broken." — Declined; the rate was
broken, not the radius.** A 60 m groan is *supposed* to be terrifying. What made v1.0 unplayable
was one such groan every **3.9 seconds, permanently**. With `PER_JOIN_CAP` at 1.5/min it is one
every 40 s, and the felt pad's 33 m is then a meaningful mitigation rather than a rounding error on
a siren. Capping the rate preserves the sound design (`AUDIO_DIRECTION.md §4.11` maps severity to a
240 Hz centre frequency and a 1.9 s envelope — that sound *should* carry 60 m); capping the radius
would have quietly deleted it.

**6. "A map — any one of these would stop a AAA team on day one." — Adopted, and scoped.**
§3 publishes the coordinate frame, the playable bounds, 21 named locations with exact distances,
and the four ground types, because every stealth and time number in this document is computed
against them and was unverifiable without them. It does **not** publish the full site geometry,
tree placement, or building interiors — those belong to `Terrain.js`, `Forest.js` and `Props.js`,
and putting them here would create a fifth document for those agents to diverge from. This section
owns the **distances**. They own the world.

### 20.6 First things to build, in order

For an agent starting from zero, the dependency order that unblocks the most work fastest:

1. `CabinSite` slot schema (§6.3) with `partId` and `yawCandidates` — everything downstream reads it
2. `BuildSystem` place/correctness (§6.4) and the seating check (§6.5)
3. `NoiseSystem`'s 2 m occlusion grid (§9.6) — `Campers` and `Physics` both depend on it existing
4. `Blueprint` projection + HLR (§8.2–8.3) — the long pole; start it in parallel on day one
5. `Campers` senses with the §9.3 constants and the §18.2 ray budget
6. The creak model with its three caps (§7.1–7.3)
7. Night 1 end-to-end against §17, then §19 row A1

---

## APPENDIX A — v1.0 DEFECT LEDGER

Every defect raised against v1.0, its disposition, and where the fix lives. Kept in the document so
that a future reader can see what was decided and why, rather than re-deriving it from a diff.
**"Declined" always carries a reason and a section reference.**

| # | v1.0 defect | Disposition | Where |
|---|---|---|---|
| 1 | This doc and `STORY.md` describe two different games, night for night | **Fixed.** `STORY.md` declared canon on night content; §12 rewritten from it; `freeform` slot class and `saw` noise kind added to carry its mechanics | §0.1, §6.7, §7.6, §12 |
| 2 | No story here, and the AI spec makes the story impossible | **Fixed.** Campers have `id`, `essentialUntilNight`, `scriptedFate`, `familiarity`; FSM gains `Scripted`; the grab moves to Night 4 | §9.1, §9.7, §13.3 |
| 3 | Night clock arithmetically impossible (Night 1: 1410 s of content in 540 s) | **Fixed.** "Target" column deleted; one derivation formula published and run for all seven nights | §5.1, §5.2, §5.3 |
| 4 | The named "best sequence" is impossible by the doc's own numbers | **Fixed**, and partially declined. 26 s report, 45 m cap, Panic 2.90 + stumble, targets published. Declined: the player should *not* generally win chases | §9.7, §20.5 (3) |
| 5 | Creak formula is a one-mistake death spiral with no repair | **Fixed.** Three caps + Recut from Night 1. Arithmetic re-run in the document | §7.2, §7.3, §7.4 |
| 6 | "Rotated" unreachable, and the doc contradicts itself about it | **Fixed.** Continuous snap angle replaced with discrete yaw candidates; the ghost is identical for all | §6.4.2 |
| 7 | "Wrong slot" unimplementable against the `Slot` schema | **Fixed.** `partId` added; `w` 0.60 → 0.45; 90 s silence + 240 s clamped window | §6.3, §6.4.1 |
| 8 | G4 impossible — the 2.6 m part was a different `acceptsType` | **Fixed.** `Beam-short` added, same `acceptsType`, `acceptsType` is length-agnostic by contract | §6.1, §6.8 |
| 9 | Camper senses exceed the raycast contract by 3.75× | **Fixed**, with a different scheme than suggested. Hot/cold split, cone+distance+grid rejection, `NoiseSystem` casts zero rays, 10/12 budget published | §18.2, §20.5 (2) |
| 10 | Night 5's "mandatory" thunder masking is mathematically unavailable | **Fixed by conflict resolution.** `ART_DIRECTION.md` puts the storm on Night 6; ~33 strikes, 6.0 s envelope floor, ≤ 45 s guarantee | §0.2 C2, §7.5, §12.7 |
| 11 | Lightning's "double-edged" tension does not exist | **Fixed.** The flash now `flashMark`s campers with LOS — they walk toward you during the masked window | §9.4 |
| 12 | The night-end card winks, breaking Pillar 1 | **Fixed.** All editorial copy deleted, register test published, card loses lines 12/12/12/11/9/6/1 to `ASSEMBLY COMPLETE.` | §15.2, §15.3 |
| 13 | The doc mistook the ending for a gag and deleted the child's chair | **Fixed.** Two chairs; final interaction is `place` with the player as the part; the offending sentence deleted and named as v1.0's worst error | §12.9, §13.6 |
| 14 | §4 Stealth is generic; nothing native to a building game | **Mostly fixed.** Provoke replaces the thrown bracket; cabin rewrites `Navmesh` and the occlusion grid; `Noticing` + `familiarity`. Declined: replacing crouch/freeze/LOS/douse | §9.5, §9.6, §20.5 (1) |
| 15 | The AI has no concept of the house | **Fixed.** `structureKnowledge`, silhouette features, a separate notice curve, structure reports. Robin's 84 m beat falls out of the numbers | §9.5 |
| 16 | Carry-slot arithmetic broken in three places | **Fixed.** 4 part slots + a separate 3-capacity tool belt; class C = 2 across the board | §6.2 |
| 17 | Detection model specifies every input and never the output | **Fixed.** Four targets stated first, constants solved backwards, noise floor added, full derivation shown | §9.3 |
| 18 | Lighting model gets the interesting case backwards | **Fixed.** The flame is a separate percept to 180 m, one ray, aim-independent, `hoodFactor` 0.18 | §9.4 |
| 19 | Slot budgets contradict build targets; the curve inverts by accident | **Fixed.** One derived table; the Night 5 slot dip and Night 6 density dip are now deliberate and labelled | §2, §2.1, §12.1 |
| 20 | "The only non-diegetic sound" contradicted twice | **Fixed.** Claim deleted; the complete list of three published; material-appropriate hint cues replace the metallic tick on paper and cloth | §6.9, §11.4 |
| 21 | A 277 ms window described by a sentence that is not true | **Fixed.** Linear ramp, half-widths, windows published in ms (900/450/330), 120 ms latency allowance, `Input.lastEventTimestamp` sampling, thunder sentence rewritten | §6.5, §4.1 |
| 22 | The doc argues with itself inside a binding spec | **Fixed.** Single expression; the rule restated without deliberation; whole document re-read for other survivors | §20.4 |
| 23 | The hardest technical problem gets one sentence | **Fixed.** Projection, HLR, explode vectors, arrow routing, page packing, legibility invariant, `authorship`, golden-image regression. Own document requested | §8 |
| 24 | Physics claims have no engine and no collision spec | **Fixed.** Swept 3-sphere chain vs a 4 m uniform grid of trunk cylinders, positional impulse only, 0.40 ms budget, stated fallback | §10.3 |
| 25 | Assertion doing the work of specification, ~12 times | **Fixed.** All converted to §19 rows with instruments, thresholds and remedies | §19 |
| 26a | **No map** | **Fixed**, scoped to distances | §3, §20.5 (6) |
| 26b | **No controls** | **Fixed.** Full input map, gamepad, remapping, dead zones, latency budget | §4.1, §4.2 |
| 26c | **No player body; the 4.5 s grab has no visual description** | **Fixed.** Pose table, IK/spring spec, and a second-by-second grab camera spec | §4.3, §4.5 |
| 26d | **The hand-wipe appears nowhere** | **Fixed.** Its own section, in the timings table, and in the tutorial at t=0:07 | §4.4, §5.1, §17 |
| 26e | **No save or retry** | **Fixed.** Autosave triggers, restore semantics, restart/replay options, game-over offers "Replay Night N" | §14 |
| 26f | **No inventory legibility; no outcome for insufficient fasteners** | **Fixed.** The manual *is* the inventory display; **Under-fastened** added as a fifth outcome | §6.6, §6.4 |
| 26g | **Body discovery has no test** | **Fixed.** Radius + light threshold + grid occlusion, three concealment classes, five named volumes | §13.5 |
| 26h | **No audio mix budget** | **Fixed by reference + the deltas this doc owns.** `AUDIO_DIRECTION.md §2, §9` already specify the bus graph, ducking, voice pooling and CPU; §18.4 adds the cascade contract and confirms `CABIN_CAP` guarantees the 3-creak cap | §18.4 |
| 26i | **The shadow cost is never mentioned** | **Fixed.** Full ledger; the lantern capped at 2048 even on `ultra`, 22 m far plane, every-2nd-frame reprojection, 4.20 ms budget | §18.3 |
| 26j | **Total playtime never stated** | **Fixed.** 6,950 s = 1 h 55 m clean; 2 h 20 m – 2 h 45 m realistic | §2 |
| B1 | `photosensitive` is a no-op *and* makes the game easier | **Fixed.** Perceptual-only accommodation; three flash modes; schedule, delay and envelopes identical in all three | §16.2 |
| B2 | Ranger condition contradicts itself | **Fixed.** One rule, cited from both places | §0.2 C6, §13.1 |
| B3 | "No word has been written on screen" is false | **Fixed.** Restated accurately | §17 |

### A.1 Defects found during this rewrite that the review did not catch

| # | Defect | Disposition |
|---|---|---|
| N1 | **`ART_DIRECTION.md §4.5` publishes a binding weather schedule that contradicts v1.0 §7 on all seven nights** — a third canon conflict, and the one that made defect 10 unfixable in place | Resolved: art is canon on weather, the storm moves to Night 6, and thunder masking becomes arithmetically available for the first time (§0.2 C2, §7.5) |
| N2 | **`STORY.md` contradicts itself about the handsaw** — §2 says no blade until Night Four, §4 says the saw has been in the tool roll the whole time and is used on Night Three | Resolved: §2 refers to weapons; the saw is a tool and is available from Night 1, which is what lets Recut exist as a Night-1 repair verb (§0.2 C4, §7.4) |
| N3 | v1.0's hint ladder played a **metallic tick on an errata slip (paper) and a fastener bag (cloth)** | Fixed: material-appropriate cues, and stone gets no cue at all — which is Night 1's actual lesson (§6.9) |
| N4 | v1.0 had **no floor on patrol density**, so the escalation ladder could raise Night 6 above 2 campers and destroy the emptiness that makes it the worst night | Fixed: `patrolDensity` is floored as well as capped per night, and §5.4's pacing band may not touch it (§13.1, §12.7) |
| N5 | v1.0's cascade fired **3–5 simultaneous creaks** against `AUDIO_DIRECTION.md §9.1`'s per-family cap of **3** | Fixed: `CABIN_CAP` guarantees the cap, and surplus creaks are dropped rather than queued — the AI hears what the player does not (§18.4) |
| N6 | Night 7 would still have creaked from wrong joins carried forward, destroying `STORY.md §8`'s central image (a house that is silent everywhere) | Fixed: `BuildSystem` asserts `Σ lambda === 0` at Night 7 start; surviving wrong joins are silently recut between nights (§12.8) |

---

**Version 2.0.** Canon order §0.1. Conflicts closed §0.2. Night table §2. Everything else derives
from those three.

