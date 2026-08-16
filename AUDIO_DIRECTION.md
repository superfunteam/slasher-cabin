# Slasher Cabin: Some Assembly Required — Audio Direction Bible

**Version 2.0.** Rewritten after review. Version 1.0 was authored without reading `GAME_DESIGN.md`
or `STORY.md` and contradicted both. Every contradiction found is listed in §0.6 with its fix.

**Owner:** Audio agent (`src/audio/AudioEngine.js`, `src/audio/ProceduralSFX.js`,
`src/audio/Music.js`, `src/audio/VoiceBank.js`, `tools/generate-voices.mjs`)
**Binding on:** anyone emitting `audio:sfx`, `audio:vo`, `noise:emit`, `build:creak`,
`player:footstep`, `ui:subtitle`.
**Companion docs, in precedence order:** `ARCHITECTURE.md` → `GAME_DESIGN.md` → `STORY.md` →
this document → `ART_DIRECTION.md`.

Everything in this document is synthesized in WebAudio at runtime. There are **no sample files**.
The only fetched audio in the entire game is ElevenLabs VO in `public/audio/vo/`, and the game
must be fully playable, fully atmospheric, and fully sad with that directory empty.

Frequencies are Hz, times ms unless stated, gains in dB. **Two different dB scales appear in this
document and they are never interchangeable:**

- **dBFS@1m** — peak sample value the recipe produces when the source is 1 m from the listener,
  before bus gain, before distance attenuation. Used in §1.3 and every §4 recipe.
- **LUFS(M)** — momentary loudness, BS.1770-4, 400 ms window, of the *whole master bus*. Used in
  §2.2 only.

Version 1.0 conflated them and produced an integrated loudness target that was arithmetically
unreachable (§0.6, defect 23). Never write a bare "dB" in this document again.

Assume `ctx.sampleRate` of 48000 but never hard-code it. All values are specified in Hz and
seconds so the graph is sample-rate independent. The one exception — the BS.1770 filter
coefficients in §11.1 — is flagged as rate-specific at the point of use.

---

## 0. Source of truth, precedence, and the open conflicts

### 0.1 The precedence ladder

This section exists because version 1.0's single largest failure was writing in isolation. It is
now a rule with a mechanism.

| Rank | Document | Owns |
|---|---|---|
| 1 | `ARCHITECTURE.md` | event names, payload shapes, `ctx`, `settings`, `state`, file ownership, perf guardrails |
| 2 | `GAME_DESIGN.md` | every number that affects an outcome: noise kinds, radii, intensities, the seating curve, the creak formula, thunder timing, camper senses, accessibility requirements |
| 3 | `STORY.md` | cast, VO line ids and per-line generation parameters, beat ids, story flags, who Ansel is and what he sounds like |
| 4 | **this document** | the *chain*: synthesis recipes, mix, spatialization, scheduling, silence, and the mapping from ranks 1–3 into WebAudio |
| 5 | `ART_DIRECTION.md` | mood adjectives; may not override a number |

**The rule, stated so it cannot be misread:** this document never authors content that a higher
rank owns. It authors *sound*. If a number here disagrees with `GAME_DESIGN.md`, `GAME_DESIGN.md`
is correct and the table here is regenerated. If a speaker, line id, beat id, flag, or event name
here disagrees with `STORY.md` or `ARCHITECTURE.md`, they are correct and this document is wrong.

### 0.2 Derived tables

Four tables in this document are **DERIVED**. They are transcriptions of a higher-rank source,
present only so an implementer does not have to hold two documents open. Each is marked. If you
change one without changing its source, you have introduced a bug.

| Table | Derived from |
|---|---|
| §1.3 the `noise:emit` contract | `GAME_DESIGN.md` §4.2 |
| §4.7 the seating tap ladder | `GAME_DESIGN.md` §2.3 |
| §4.12 creak tiers, radii, intensities | `GAME_DESIGN.md` §3.1 |
| §7.4 VO generation parameters | `STORY.md` §6 |

`tools/audio-registry-check.mjs` (§11.2) re-derives §1.3 and §4.12 from `GAME_DESIGN.md` at build
time and fails the build on drift. The other two are checked by eye at review; automate them when
`Script.js` and `Blueprint.js` stop being stubs.

### 0.3 Ownership of `tools/generate-voices.mjs`

The audio agent owns the *script*. `STORY.md` owns the *content*. Concretely:

- Speaker list, line ids, line text, per-line `S / Sim / St`, and category → **`STORY.md` §6**.
- Model id, output format, `speaker_boost`, seed policy, filenames, manifest schema, retry and
  rate-limit behaviour, and the offline post-processing chain → **this document, §7.4**.

If a line is needed that does not exist in `STORY.md`, it is requested by id with a
`TODO(story):` comment and the generator skips it. **The generator never invents a line.**
Version 1.0 defined six characters who do not exist and would have produced roughly 200 MP3s that
`Script.js` will never reference. Deleted.

### 0.4 Requested APIs (`TODO(api):` register)

Every one of these has a graceful null path specified at the point of use. None is a hard
dependency. All are `typeof x?.fn === 'function'` guarded per `ARCHITECTURE.md` §2.

| API | Owner | Used by | Fallback if absent |
|---|---|---|---|
| `Campers.willObserve(dtMs) -> { camper, tMs } \| null` | AI | §6.4 the tell | tell never fires; no other behaviour changes |
| `CabinSite.enclosure(v3) -> 0..1` | Build | §3.3 `CABIN_SHELL` | `installedPanelCount / totalPanelSlots` from `state.installed` |
| `CabinSite.tinRoofArea() -> { center, halfExtents } \| null` | Build | §3.3 tin comb, §4.15 tin rain | tin rain plays only within 6 m of the plot centre once stage ≥ roof |
| `Blueprint.stageAuthorship(night, stage) -> 'marit' \| 'ansel'` | Build | §4.25 the chime's rot | night table in §4.25.3 |
| `Forest.densityAt(x, z) -> 0..1` | World | §3.2 analytic occlusion | flat 0.35 inside the plot's 190 m ring, 0.55 outside |
| `Weather.maskLevel()` | Director | §4.17, §8 S4 | 0; thunder still sounds, masking window is never advertised |
| `Weather.nextStrikeIn()` | Director | §7.5 thunder countdown caption | caption suppressed |
| `Player.illumination` | Player | §4.2 lantern state | lantern assumed lit |

### 0.5 Requested `Settings` keys

`GAME_DESIGN.md` §10 already requests `subtitles`, `subtitleSize`, `subtitleBackdrop`,
`directionalAudioIndicator`, `photosensitive`. Audio requests two more from the Engine agent:

```js
audioOutput: 'auto',        // 'auto' | 'headphones' | 'speakers'  — see §9.6
audioVerbosity: 'standard', // 'standard' | 'reduced'  — see §7.5; caption density, not volume
```

`audioOutput` is not cosmetic. HRTF panning is authored for headphones; on speakers it produces
crosstalk that measurably degrades the azimuth accuracy §1.1 promises. `'auto'` defaults to
`'headphones'` because that is the majority case for a browser horror game, and the option exists
so the minority is not lied to.

### 0.6 The defect ledger

Every fix in this revision, keyed so the reasoning cannot be re-lost. Where the review was
wrong or incomplete, that is stated and the alternative is argued.

| # | Defect in v1.0 | Fix | § |
|---|---|---|---|
| 1 | Six invented voice profiles (DENISE, RANDY, TAMMY, KEVIN, MARCIA, BUD) | Deleted. Cast is Robin, Dale, Marg, Coop, Teddy, Bev, derived from `STORY.md` §5–6 | 7.4 |
| 2 | `footstep-crouch`, `drop-light`, `hammer-wood`, `split` etc. — invented `noise:emit` kinds; five canonical kinds had no sound at all | §1.3 rebuilt from the canonical 12; `brush`, `wrench`, `throw`, `whistle`, `voice` all now have recipes | 1.3, 4.21, 4.10, 4.22, 4.28 |
| 3 | S3 fired on `build:place correct:false`, converting a 9-second deniable trap into an instant fail buzzer | S3 fires on `build:creak`, tier ≥ 3 only. §1.1's claim 3 restated | 1.1, 8 S3 |
| 4 | §4.7 specified screw torque; there are no screws | Rewritten as the six-tap seating ladder, derived from `p=(t/2.2)^1.35` | 4.7 |
| 5 | No grab, no body, no drag, no water, no discovery | New §4.26. The victim's aborted inhale is **synthesized, not VO** — see below | 4.26 |
| 6 | Thunder: unreachable "Near" class, wrong duration formula, no `maskLevel` contract, far thunder too quiet to mask | Near deleted, formula taken verbatim from `Weather`, explicit window contract, spectral-coverage invariant | 4.17 |
| 7 | §2.4 lowered compressor thresholds to make sounds *louder* — backwards, and `DynamicsCompressorNode` has no makeup gain | Thresholds held; `sfxWorld` +5 dB and its reverb send −6 dB over 700 ms | 2.4 |
| 8 | A `FEAR` breath state and a 148 bpm heart, on a man `STORY.md` says never makes a sound | `FEAR` deleted. Three states. The heart appears **twice in the entire game** | 4.27 |
| 9 | Grain recipes allocate thousands of nodes/second, violating §9.1's own rule | LIVE/BAKED classification, ≤ 120 node constructions/s at `ultra`, churn + dropout counters | 4.0, 9.3 |
| 10 | 48 cricket panners out of a 56-panner budget; sensor duty cycle never computed | 4 quadrant panners + a mono bed; the **bed** is the sensor; ≥ 70% duty invariant | 5.2, 5.4 |
| 11 | "Only two ConvolverNodes" while naming five simultaneous per-source spaces; 8 m probe grid larger than the cabin | 4 persistent convolvers, never reassigned; `TIN_ROOF` is a comb, not a convolution; enclosure is geometric | 3.3 |
| 12 | The bleed path routed into the panner it exists to escape; gain specified twice, incompatibly | Bleed bypasses to a `StereoPannerNode` hemisphere; one formula; analytic occlusion is primary | 3.2 |
| 13 | "This is the only place subtitles come from" — makes thunder masking unusable for deaf players | New §7.5, non-verbal captioning, per `GAME_DESIGN.md` §10.3 | 7.5 |
| 14 | The stinger argued with Harry Manfredini for five bullets — the doc winking at the camera — and needed an API nobody declared | The tell is now the manual: one dry `sfxUI` hardware tick from the clean universe | 6.4 |
| 15 | Three incompatible sfx id namespaces, no registry | Appendix A, complete registry + startup assertion | 10 |
| 16 | The completion chime "always identical" for seven nights; `STORY.md` requires it to rot | Marit's chime N1–3; Ansel re-strikes it from his first authored panel; exact Hz per stage | 4.25 |
| 17 | `story:beat 'mask-on'` does not exist; the mask was modelled as a moulded hockey shell | The mask is **on from Night 1** — he has worn it 22 years, there is no donning moment. Porcelain plate modelled properly, Helmholtz ports derived | 2.5 |
| 18 | Loon and pine whistle were uncaused timer startles, in a doc that forbids uncaused startles | Loon *scream* variant is causal; pine whistle is a fixed findable trunk | 5.3, 4.16 |
| 19 | §4.6 called a bracket's tail "the joke" — the world performing | Recipe kept, direction inverted: model it accurately, mix it flat | 4.6 |
| 20 | `0.15·tier²` = 2.4 on a 0..1 field; 120 m radius vs a 60 m cap; quantization assigned to a system that doesn't own it | Tiers rebased on the *reachable* severity range, aligned to design's own 0.7 split, quantization in `AudioEngine`, cascade handler, tier-4 cooldown | 4.12 |
| 21 | `maxDistance: 140` made half the doc's own claims inaudible | World extents table; `maxDistance` = world diagonal 825 m; rolloff and the −60 dBFS kill do the work | 3.0, 3.1 |
| 22 | A 7 dB shelf snapping at exactly the height of the Night-5 ladder | Continuous `3.5·tanh(dy/2)`, τ = 0.15 s | 3.1 |
| 23 | −16 LUFS integrated, ~6 LU above what the doc's own dynamic profile can produce, and unverifiable | −22 LUFS ±1.5, −1.5 dBTP, BS.1770-4 harness in CI | 2.2, 11.1 |
| 24 | Missing: saw, pry bar, wrench, ladder, hoist, shim, felt, digging, throw, `tool:*`, paper, night-end, menus, all three endings, `ui:toast`, the rotated-join grind, the hand-wipe, the tool roll's silence, the Night 7 breath catch | All specced | 4.9–4.28 |
| 25 | No `oversample`, a downsampling hand-wave that made `voLP` a no-op, no memory budget, no latency budget, no browser matrix, and `equalpower` providing zero front/back on half the tiers | All specced; front/back is now an **explicit tier-independent cue**, not an HRTF side effect | 3.1, 9.4–9.6 |

**Three places the review was wrong or incomplete, and what this document does instead:**

- **On the grab's VO (defect 5).** The review asked for a `GRAB` VO category available from
  Night 3. `STORY.md` fixes the bank at 90 lines and the audio agent does not own `Script.js`;
  more importantly, both `STORY.md` and `ARCHITECTURE.md` require the game to work with
  `public/audio/vo/` deleted, and a kill that is silent without VO is a broken kill. The victim's
  aborted inhale is therefore **synthesized on `sfxWorld`** (§4.26.2), not fetched. It costs
  nothing, it ships in the default build, and it uses the same closure model as Ansel's Night 7
  breath catch, transposed — which is a connection VO could never have made.
- **On the crickets' Night 7 floor (defect 10).** The review proposed flooring the chirp rate at
  55/min inside 20 m. That fights `STORY.md`'s and §5.2's cold arc, which is doing real work. The
  actual problem is that the *sensor* was bound to a sparse discrete event. So the sensor moves
  onto the **continuous distant-chorus bed**, which is always perceptible no matter how slow the
  individual chirps get, and the chirp floor is set to a gentler 40/min (§5.2.3). The cold still
  arrives; the sensor still works.
- **On the mask trigger (defect 17).** The review proposed triggering off an existing beat.
  `STORY.md` §2 says the mask was cut from the salvaged splash-back in 1962 and is a portrait, not
  a disguise. There is no donning moment in the story and inventing one is a beat this document
  does not own. **The mask is on from the first frame of Night 1.** Its one and only transition is
  its *removal*, in Ending C, at the table (§8 S13, §4.28.4). The player spends seven nights not
  knowing they are listening through something, and then finds out by having it taken away. S10 is
  deleted entirely.

**Two defects the review missed, found while rewriting:**

- **Creak tier 1 was unreachable.** `GAME_DESIGN.md` §3.1 gives
  `severity = clamp01(0.25 + 0.55w + 0.30s + 0.20·min(L,1.5))` and `lambda = 0` whenever
  `w = 0` and `s = 0`. So any join that creaks at all has `w > 0` or `s > 0`, and the lowest
  severity actually observable is ≈ 0.41, not 0.00. v1.0's tier-1 band of `severity ≤ 0.25` could
  never fire. Tiers are rebased on the reachable range in §4.12.2, with the tier-2/3 boundary
  placed at exactly **0.70** so it coincides with design's own `creak_tick` / `creak_groan` split.
- **VO filenames violated `STORY.md`'s contract.** `STORY.md` §Contract: "All VO ids here resolve
  to `public/audio/vo/<ID>.mp3`." v1.0 specified `vo_<speaker>_<category>_<index>.mp3`. Every
  fetch would have 404'd. Fixed in §7.4.

### 0.7 Open cross-document conflicts — **not** for the audio agent to resolve

These are real contradictions between rank-2 and rank-3 documents. This document must not pick a
winner. Each is flagged, each has an interim behaviour that is safe under either resolution, and
each names the agent who should resolve it.

**C1 — `kind:'saw'` is not in the canonical vocabulary.**
`STORY.md` §4 Night Three specifies "a continuous `noise:emit` with `kind:'saw'`, radius 90 m."
`GAME_DESIGN.md` §4.2 declares its 12-kind list "the complete vocabulary." A 13th kind cannot be
invented by Audio (`GAME_DESIGN.md` preamble: "No system in this document invents a new event").
*Interim:* the handsaw (§4.13) emits `kind:'hammer', radius: 34, intensity: 0.55` once per push
stroke. *Consequence, stated plainly:* at radius 34 instead of 90, campers under-react to sawing
by a factor of roughly seven in area. The saw is `STORY.md`'s loudest sustained mechanic and this
interim materially weakens it. **Owner: Director agent + AI agent.** Add `saw` to
`GAME_DESIGN.md` §4.2 at `radius 90, intensity 0.70` and this document regenerates §1.3.

**C2 — `STORY.md` §2 and §4 disagree about when the handsaw exists.**
§2: "No blade at all until Night Four, and then only a handsaw." §4 Night Three: "The handsaw is
in the tool roll and has been the whole time." *Interim:* the saw recipe and its baked grain
family are built at init and available from Night 3, because a sound that exists early and is
never triggered costs 138 KB, whereas a sound that does not exist when the game asks for it is a
crash. **Owner: Story agent.**

**C3 — `GAME_DESIGN.md` §7 and `STORY.md` §4 disagree about what is built on which night.**

| Night | `GAME_DESIGN.md` §7 | `STORY.md` §4 | Agree? |
|---|---|---|---|
| 1 | 6 piers + sill beams | six stone piers, six sill beams | yes |
| 2 | 9 floor joists | four wall frames, corner brackets, bracing | **no** |
| 3 | 14 wall studs + corner posts | roof trusses, cut the ridge beam | **no** |
| 4 | 18 sheathing panels | subfloor, then the door | **no** |
| 5 | 22 roof trusses + purlins | the 4.8 m / 71 kg north wall panel | **no** |
| 6 | 20 glazing units, door, hinges | roof battens, shingles, interior | partial |
| 7 | chimney, porch, roof cap, the Chair | nothing structural remains | yes |

This matters to audio more than to any other discipline, because *which material is being struck
on which night* is the entire per-night palette: whether `TIN_ROOF` exists yet, whether glass
pings are in the mix, whether the saw fires, whether the door foley is authored. **Owner:
Director agent.** *Interim:* §5.5's per-night palette table is keyed off **observed events and
`state.installed`, never off `state.night`.** The tin comb activates when
`CabinSite.tinRoofArea()` returns non-null; glass pings register when a `window` part is first
picked up; the saw's family is resident from Night 3. Nothing in this document breaks under either
resolution. When C3 is resolved, §5.5 is regenerated and nothing else changes.

**C4 — the player's own breathing has no canonical `noise:emit` kind.**
`GAME_DESIGN.md` §5.2: "above 60% stamina drain, `AudioEngine` layers a low breath loop at
`radius 5, intensity 0.10` — your own breathing is an emitted noise. Campers at < 5 m can hear
it." No `breath` kind exists in §4.2, and the nearest kind by function, `voice`, is explicitly
ignored by campers. *Interim:* `HEAVY` breathing emits `kind:'brush', radius: 6, intensity: 0.12`
(§4.27.1) — the closest canonical kind that campers *do* respond to, and within 20% of the
requested numbers on both axes. **Owner: Director agent.** Add `breath` at `radius 5,
intensity 0.10`.

**C5 — `directionalAudioIndicator`'s range exceeds the `voice` kind's radius.**
`GAME_DESIGN.md` §10.3 asks the arc to draw for "any camper `voice` within 40 m." §4.2 gives
`voice` a radius of 26 m. Camper voices between 26 and 40 m therefore emit nothing and can draw
nothing. *Interim:* Audio emits `voice` at the canonical 26 m (§4.28.3) and the arc is simply
absent between 26 and 40 m. **Owner: AI agent** (raise `voice` to 40 m) **or UI agent** (clamp
the arc to 26 m). Either is fine; silently disagreeing is not.

**C6 — `hardware_tick` and `hardware_chime` are near-homographs with opposite properties.**
`GAME_DESIGN.md` §2.5 makes `hardware_tick` diegetic, positioned, occluded ("wind moving metal")
and `hardware_chime` "the *only* non-diegetic sound in the game." One character apart, opposite
buses. *Interim:* both ids are honoured verbatim (renaming them is not Audio's call) and the
registry (§10) carries a **collision warning** on both rows. **Owner: Director agent**, if a
rename is wanted.

**C7 — "the only non-diegetic sound in the game" is not one sound.**
`GAME_DESIGN.md` §2.5 says `hardware_chime` is the only non-diegetic sound. This document also
needs a stage-completion chime (S6), a pre-observation tell (§6.4), a menu tick, a night-end card
tick, and an ending stinger — all of which must live outside the wet world or they stop working.
*Resolution, and this one Audio can make because it is a question about timbre, not content:*
**there is exactly one non-diegetic timbre family, "the clean universe," and it has exactly three
words.** `hardware_chime`, `stage_chime`, `manual_tick` (§4.25). All struck sine-plus-triangle,
all dry, mono, centred, on `sfxUI`, all in the same tuning system. Read at the level of *voice
rather than instance*, `GAME_DESIGN.md`'s claim is true and stays true: the manual speaks, and it
is the only thing that does.

---

## 1. The Thesis

### 1.1 Sound is the UI — and what it is *not* allowed to tell you

This is a stealth game with almost no HUD. The HUD we do have is a flat-pack instruction manual,
which is a joke, not an interface. Therefore **every gameplay-relevant state change that the
design intends the player to know must be legible by ear alone, with the eyes closed, in under
250 ms** — a budget verified against real WebAudio latency in §9.5, not assumed.

Version 1.0 wrote: "If a player cannot tell the difference between 'that bracket seated correctly'
and 'that bracket did not seat correctly' without looking, the game is broken." **That is the
opposite of the game's design.** `GAME_DESIGN.md` §2.3 gives Wrong-slot placement "no negative
feedback at all," and §11's minute-by-minute is explicit: "If the player rotates it wrong, **it
seats, and it creaks 9 seconds later.**" The delay and the deniability *are* the trap. An
instant fail buzzer would destroy the single best sequence in the game.

**Five things must be readable purely by ear. One thing must deliberately not be.**

1. **Where a camper is.** Azimuth to within ±15° in the frontal hemisphere and ±30° behind;
   distance to within ±30%. **Front/back is never ambiguous, on any quality tier** — this is
   guaranteed by an explicit cue (§3.1.3), not by HRTF, because `equalpower` provides literally
   zero front/back discrimination and half our players will run it.
2. **Whether a camper heard you.** The chorus cut (§5.4) and the VO turn (§7.3).
3. **What happened at the moment of placement** — but *only* what the design says is audible:
   a clean seat, a 0.4 s grind, a split, or **nothing at all**. §4.9 is the complete truth table.
   The fourth row, silence, is the most important sound in this document.
4. **Whether a join has begun to fail** — never whether it *was* correct. The creak is the
   symptom, arriving seconds and metres away from the cause, and the player's job is diagnosis.
5. **Whether the masking window is open** (§4.17.4). `GAME_DESIGN.md` calls thunder masking "the
   skill ceiling"; a skill ceiling the player cannot hear is a lottery.

**And the thing that must stay unreadable:** whether the part went in the *right slot*. Wrong-slot
is 0.60 wrongness, seats normally, sounds identical to a perfect join, and is discovered a stage
later when the game is short a part. Audio's job there is to be a convincing liar. Any engineer
who "improves" §4.9 by adding a tell to the wrong-slot row has broken the game.

### 1.2 Spectral zoning — carve the bed for gameplay

Legibility is a mixing problem before it is a synthesis problem. We reserve bands. Every band's
owner list is now complete and every entry resolves to a §4 recipe.

| Band | Hz | Owner | Rule |
|---|---|---|---|
| Sub | 20–80 | thunder, dropped beams, class-D settles, the heartbeat's two appearances, the score's low D | **Only one sub source may exceed −18 dBFS at a time.** Enforced by a sidechain on the `sub` group: whichever source has the highest instantaneous priority holds the band, others duck −9 dB with τ = 0.06. |
| Low-mid | 80–350 | footsteps, wood body, hoists, tent whump, body drag, the saw's kerf | The "body" band. Ambience may live here but stays under −30 dBFS@1m. |
| Voice | 350–1500 | camper VO, Ansel's breath, the mask's 620 Hz port peak | Nothing else lives here loud. Music pads notch −5 dB (`f=760, Q=0.7`) whenever any VO is active. |
| **Danger** | **1500–5000** | **creaks, twig snaps, metal, glass, bracket drops, the nail mode, the saw's tooth train** | **Reserved.** The ambience bed carries a permanent peaking filter, `f = 3100, Q = 0.9, gain = −4 dB`, so every gameplay-critical transient cuts through the forest without needing to be louder. This is the single highest-leverage decision in the mix. |
| Air | 5000–16000 | rain hiss, wind sizzle, cricket top, lantern glass, the steel bank's upper partials | Freely shared. Duck it first when headroom is needed. |

The Danger notch is why a tier-2 creak at −20 dBFS@1m from 26 m away is unmistakable over a
storm: it is not louder than the storm, it is in a hole cut in the storm.

### 1.3 The `noise:emit` ↔ audible loudness contract — **DERIVED from `GAME_DESIGN.md` §4.2**

Anything that emits `noise:emit` must also produce sound. This is the contract that lets a player
calibrate risk by listening: **AI-audible noise and player-audible noise are the same number.**

Version 1.0 invented eight kinds that do not exist, disagreed with the canonical numbers on
another six, and left five canonical kinds — including the loudest event in the game — with no
sound at all. This table is now the canonical twelve, in the design document's exact strings, with
the design document's exact numbers.

**Perceived level is not hand-authored.** It is a function of intensity:

```
peak_dBFS_at_1m = -34 + 32 * intensity^0.6
```

The 0.6 exponent is a Stevens-style loudness compression: it spreads the quiet end (where the
player's discrimination matters most — is that a crouch step or a walk step?) and compresses the
loud end (where everything is already a disaster). The 23 dB span from crouch to whistle is wide
enough to be obvious and narrow enough to survive a laptop speaker.

| `kind` | radius (m) | `intensity` | peak dBFS@1m | sfx id | recipe |
|---|---|---|---|---|---|
| `footstep` (crouch) | 4 | 0.08 | −27.0 | `step_<surface>` | §4.1 |
| `footstep` (walk) | 9 | 0.18 | −22.6 | `step_<surface>` | §4.1 |
| `footstep` (sprint) | 20 | 0.45 | −14.2 | `step_<surface>` | §4.1 |
| `footstep` (carry D) | 14 | 0.30 | −18.5 | `step_<surface>` | §4.1 |
| `brush` | 6 | 0.12 | −25.0 | `brush_foliage` | §4.21.2 |
| `drag` | 22 | 0.38 | −16.1 | `drag_lumber` / `drag_body` | §4.3, §4.26.3 |
| `drop` (class B) | 16 | 0.35 | −17.0 | `drop_hardware` | §4.6 |
| `drop` (class C) | 26 | 0.55 | −11.6 | `drop_lumber` | §4.3 |
| `drop` (class D) | 40 | 0.80 | −6.0 | `drop_lumber` | §4.3 |
| `impact` | 30 | 0.60 | −10.4 | `join_split` / `carry_bump` | §4.8, §4.3 |
| `hammer` | 34 | 0.30–0.55 | −18.5 … −11.6 | `hammer_tap` | §4.4, §4.7 |
| `wrench` | 24 | 0.45 | −14.2 | `join_remove` | §4.10 |
| `creak` | 14 + 46·sev | = severity | −34 + 32·sev^0.6 | `creak_tick` / `creak_groan` | §4.12 |
| `throw` | 18 | 0.40 | −15.5 | `throw_impact` | §4.22 |
| `whistle` | 90 | 0.90 | −4.0 | `camper_whistle` | §4.28.2 |
| `thunder` | 400 | 1.00 | (2D, §4.17) | `thunder_<class>` | §4.17 |
| `voice` | 26 | 0.30 | −18.5 | (VO bus, §7.2) | §4.28.3 |

**Rules attached to this table:**

- `thunder` is exempt from the level formula. It is never a 1 m source; it is a 2D stereo bed with
  its own absolute level schedule (§4.17.2), and its `intensity: 1.00` exists so `NoiseSystem`
  can mask, not so anything can be heard at 1 m.
- `creak`'s intensity **is** severity, verbatim per `GAME_DESIGN.md` §3.1. v1.0's `0.15 · tier²`
  produced 2.4 at tier 4 on a field `ARCHITECTURE.md` §5 defines as 0..1. Deleted.
- `whistle` gets one documented exception to the occlusion model (§3.2.4): its bleed floor is
  **−24 dB** rather than the formula's, because a whistle through a wall is still recognisably a
  whistle, and at radius 90 m it is the loudest camper event in the game and must never become a
  mystery.
- If this table and `GAME_DESIGN.md` §4.2 ever disagree, **`GAME_DESIGN.md` wins** and
  `tools/audio-registry-check.mjs` fails the build until this table is regenerated.

### 1.4 The horror is the negative space

The scariest thing in this game is not a sound. It is the **removal** of a sound the player had
stopped noticing. Our forest bed is deliberately dense, warm, and busy so that its absence is a
physical event.

The design target, now stated as a measurable: within the first **three minutes** of Night 1 the
player should have fully habituated to the chorus, and the first cut should be perceived as an
event before it is identified as a cause. The verification is behavioural and belongs to
playtest, not to CI: at 3:20 of the Night 1 script (`GAME_DESIGN.md` §11), when the counselor's
patrol crosses the return path at 45 m and closes, **most players crouch without being told.**
If they do not, the bed is not dense enough or the cut is not clean enough.

**We build the bed in order to be able to take it away.** §8 (Silence Rules) is the most important
section in this document and everything else exists to serve it.

### 1.5 The world never does a bit

`GAME_DESIGN.md` §0, pillar 1: "The manual is the comedian. The world is not. Nothing in the 3D
scene ever jokes." `STORY.md`: "The manual is the only comedian and it stops being funny on
Night Four."

This binds audio harder than it binds any other discipline, because sound design's default failure
mode is *sweetening* — adding a button, shortening a tail, brightening a settle, giving an object
a personality. v1.0 did it twice: it called a bracket's flutter "the joke" (§4.6) and it mixed the
bracket to be "inconveniently charming."

**The rule, operational rather than aspirational:**

1. Every diegetic recipe is a physical model. If you cannot name the physical mechanism producing
   a partial, delete the partial.
2. No diegetic sound may be shortened, brightened, or given a terminal accent for comic effect.
   If a tumbling bracket takes 380 ms to stop, it takes 380 ms. **The length is the punishment.**
3. Comedy arrives only through *consequence* — a camper's line, the manual's next panel, the
   night-end card — never through the object.
4. The three sounds of the clean universe (§4.25) are the sole exception, and they are not funny
   either. They are *tidy*, in a wet dark forest, which is a different and better thing.

The deadpan is not a tone we apply. It is the absence of the thing everyone else applies.

---

## 2. The Mix

### 2.1 Bus architecture

```
                                          ┌──────────────┐
  sfxWorld ─┬─▶[sfxComp]─┬────────────────┤              │
            │            └─▶ sendA..D ─┐  │              │
  sfxUI ────┴──(dry, mono, no verb)────┼──┤              │
  ambience ───▶[ambDuck]──┬────────────┼──┤   master     │─▶[maskChain]─▶[masterLimiter]─▶dest
                          └─▶ sendA ───┼──┤   (gain)     │
  music ──────▶[musicDuck]─┬───────────┼──┤              │
                           └─▶ sendA ──┼──┤              │
  vo ─────────▶[voChain]───┬───────────┼──┤              │
                           └─▶ sendA/D─┼──┤              │
  body ───────▶(breath/heart/wipe)─────┼──┤              │
                                       │  └──────────────┘
                    ┌──────────────────┘
                    ▼
   sendA ─▶[convOPEN_FOREST]─┐
   sendB ─▶[convDENSE_TREES]─┤
   sendC ─▶[convCABIN_SHELL]─┼─▶[verbReturn]─▶ master
   sendD ─▶[convLAKE_EDGE]───┤
   sendT ─▶[tinComb (§3.3.4)]┘
```

| Bus | Contents | Spatialized? | Reverb send | Masked by the mask chain? |
|---|---|---|---|---|
| `sfxWorld` | everything diegetic and 3D | yes | 0.22 base, per-source override | yes |
| `sfxUI` | the manual's three words, menu, night-end card | **no** — dry, mono, centred, distance-invariant | 0.00 | **no** |
| `ambience` | bed, weather, chorus, distant camp | partly (§5) | 0.10 | yes |
| `music` | the generative score (§6) | no | 0.35 | yes |
| `vo` | ElevenLabs lines | yes | 0.12 → 0.85 by distance (§7.2) | yes |
| `body` | Ansel's breath, the two heartbeats, the hand-wipe, the tool roll | **no** — inside his skull | 0.00 | yes |

`sfxUI` is a tonal weapon: the manual sounds like it is playing in a different, cleaner universe
that has no weather and no distance and no mask. It is the only thing in the game that is not
*inside* the night.

**`sfxUI` and the limiter.** v1.0 claimed `sfxUI` is "always the exact same level." Strictly, that
is not achievable — `masterLimiter` is downstream of every bus and cannot be bypassed without
losing true-peak safety. The honest invariant, and the reason it holds in practice:

- `sfxUI` is invariant **pre-limiter**, always.
- `masterLimiter.threshold = −6 dBFS`. The chime peaks at −16 dBFS. Alone, it never triggers
  gain reduction.
- The chime is only ever played into **S6's mandated 1.4 s of silence** (§8), so it is always
  alone. *The silence rule is what makes the invariant true.* That is not a coincidence; it is
  why S6 is written the way it is.
- For the incidental `sfxUI` sounds (page turn, menu tick, night-end card ticks), accept up to
  **1.5 dB** of limiter-induced variation and do not chase it.

Gain nodes for every bus are exposed as `AudioEngine.bus(name)`. Volume mapping:

```
master   = settings.masterVolume
sfxWorld = settings.sfxVolume
sfxUI    = settings.sfxVolume
body     = settings.sfxVolume
ambience = settings.sfxVolume * 0.9
music    = settings.musicVolume
vo       = settings.voiceVolume
```

### 2.2 Loudness and dynamic range

- **Integrated target: −22 LUFS** over a full night, tolerance **±1.5 LU**.
- **True peak ceiling: −1.5 dBTP.**
- Both are **verified in CI** by `tools/loudness-check.mjs` (§11.1). A loudness target with no
  meter is a wish; v1.0's −16 LUFS was both wrong and unmeasured.

**Why −22 and not −16.** Integrated loudness is (approximately) the gated mean of the momentary
distribution below. That distribution sits at −24 to −20 LUFS(M) for the overwhelming majority of
a 9–22 minute night; the loud events are seconds long and gated blocks are 400 ms. Integrating
that distribution lands near −22, and no amount of intent moves it to −16 without either
compressing the range to nothing or making the quiet 90% of the game loud. −16 was off by
roughly 6 LU and would have been discovered on the first measurement.

| Phase / state | LUFS(M) target |
|---|---|
| Title screen, pre-`resume()` | silence |
| `phase:'briefing'` (blueprint open) | −26 |
| Quiet build, no threat | −24 to −20 |
| Camper audible in distance | −20 |
| Held breath (§2.4) | **−34** |
| Creak tier 3 | −14 |
| Creak tier 4 | −11, ≤ 2.6 s |
| Cascade (§4.12.5) | −12, ≤ 1.9 s |
| `phase:'chase'` | −14 |
| Thunder crack, mid class | −11, ≤ 900 ms |
| Night-end card | −24 |
| S7 (`night:failed`) | true digital silence, then −28 |

That is a 23 LU working range and it is aggressive on purpose.

`masterLimiter` is a `DynamicsCompressorNode`: `threshold −6, knee 2, ratio 12, attack 0.003,
release 0.18`. **It is a safety net, not a sound.** If it is pumping audibly, a source is too
loud — fix the source. Its `threshold` is set once at init and **never modulated**; moving a
limiter threshold mid-scene is a pumping generator (see §2.4).

`sfxComp` is a gentle glue compressor on world SFX only: `threshold −18, knee 12, ratio 2.4,
attack 0.010, release 0.25`. **Music and ambience are not compressed** — their dynamics are the
entire point of §1.4.

### 2.3 Ducking rules

`AudioEngine.duck(busName, dB, attackMs, holdMs, releaseMs)`, implemented with `setTargetAtTime`
at `timeConstant = attackMs / 3000` (three time constants reach 95%).

| Trigger | Target | Amount | A / H / R (ms) |
|---|---|---|---|
| `build:creak` tier ≥ 3 | `music`, `ambience` | −12, −8 | 40 / 300 / 1200 |
| Creak **cascade** (§4.12.5) | `music`, `ambience` | −12, −8 | 40 / 1500 / 1400 — **one duck for the whole cascade** |
| Thunder crack | `ambience` | −5 | 5 / 200 / 1400 |
| Lightning flash (pre-thunder) | everything but rain | −14 | 10 / 110 / 260 |
| `ui:blueprint-open` | `ambience`, `music`, `sfxWorld` | −9, −14, −6 | 180 / — / 400 |
| `player:spotted` | see §2.4 | | |
| `tool:found` | `ambience`, `music` | −6, −10 | 60 / 700 / 900 |
| `build:stage-complete` | see §8 S6 | | |

**Deleted from v1.0:** the row `build:place correct:false → duck ALL except the creak, −18 dB`.
That row and S3 were the same defect written twice. There is no creak at `build:place` time; the
creak arrives seconds later from `BuildSystem`'s own tick (`GAME_DESIGN.md` §3.1), and ducking at
placement announces a mistake the design wants deniable.

**Hard rule: VO never ducks anything.** Camper voice is atmosphere. The moment music dips for a
line, the line becomes a narrator, and both the creator's brief and `STORY.md` forbid narration.
The only concession: while any VO is active, the music pad's 350–1500 Hz band is notched −5 dB by
a peaking filter (`f = 760, Q = 0.7`), so voices sit in a pocket without the mix visibly moving.

**Duck stacking.** Ducks on the same bus do not sum. The deepest active duck wins; a shallower one
arriving during a deeper one extends the hold but does not change the depth. Without this rule a
cascade during a storm drives `ambience` to −25 dB and the bed audibly disappears for the wrong
reason.

### 2.4 The Held Breath

Fired on `player:spotted` with `level > 0.35`, or when `state.suspicion > 0.6` and any camper's
search target is within 12 m of the player. This is the signature mix move of the game.

Over 700 ms, in parallel:

1. `ambience` → −14 dB, and a lowpass on the ambience bus sweeps `6500 → 2200 Hz`
   (`setTargetAtTime`, τ = 0.23).
2. `music` mutes every layer except one sustained bowed-metal partial (§6.2) held at −22 dB.
3. Breathing (§4.27.1) switches to `HELD`: the breath cycle **stops entirely** for
   `2.5 + rand(0, 3.5)` seconds. No breath sound at all. Then one controlled, tight, high-passed
   exhale.
4. **`sfxWorld` ramps +5 dB and `sfxWorld`'s reverb send ramps −6 dB, both over 700 ms,
   τ = 0.24.**

Point 4 replaces v1.0's headline move, which was backwards and, as written, impossible.
v1.0 said: "`masterLimiter.threshold` drops to −12 and `sfxComp.threshold` to −26 — meaning any
real world sound sounds twice as loud as it is." Lowering a compressor threshold makes loud
material **quieter**, not louder. A twig at −30 dBFS is *below* a −26 threshold and completely
unaffected; anything above it is reduced. And `DynamicsCompressorNode` has no makeup gain, so
nothing restores the level. The move would have made the held breath *duller*.

Louder and **drier** is what "close and real in an empty room" actually is. A twig snap during the
held breath is +5 dB and −6 dB of reverb: it stops being a thing in a forest and becomes a thing
next to your head. That is the effect v1.0 was reaching for, achieved by the mechanism that
produces it.

**Deleted from v1.0:** point 4 of the old list, "Heartbeat rises +9 dB and its lowpass opens
200 → 420 Hz." There is no heartbeat here. See §4.27.2 and defect 8: Ansel is a 280 lb
thirty-five-year-old man and the seventeen-year-old with the torch is not a threat to him. A
pounding heart inverts the premise, and muffled-world-plus-pounding-heart is the most generic
move available in horror audio. **The tension is carried by the world going quiet around a man who
does not react.** That is scarier, it is specific to this game, and it costs two fewer nodes.

**Release** on `player:hidden`, or 6 s after last detection. Restore over 2600 ms, with the
ambience returning noticeably slower (τ = 0.9) than the breath (τ = 0.3), so the player's body
recovers before the world does.

### 2.5 The mask — a porcelain plate, on from the first frame

The mask is **not** a moulded shell and there is **no** `story:beat 'mask-on'`. `STORY.md` §2: it
is "the porcelain splash-back panel from behind the kitchen sink," cut with a tile nipper, two
eyes drilled with a hand brace, set too far apart for a human skull, glazed, hairline-cracked. He
has worn it since 1962. **The mask chain is active from the first audio frame of Night 1 and its
one and only transition is its removal in Ending C** (§8 S13).

v1.0's `mask-on` beat is not in `STORY.md`'s canonical set (`n1_thumbs_up, n2_robin_hears,
n3_not_believed, n4_dale, n5_two_persons, n6_robin_inside, n6_bev_remembers, n7_final`) and S10
is deleted with it.

The mask chain sits on `master`, before the limiter, and applies to **everything except `sfxUI`
and the pause menu**.

#### 2.5.1 The static chain — every filter derived, none chosen for taste

```
peaking   f=620,  Q=1.4,  gain=+3.5 dB     // the two eyeholes as Helmholtz ports  (derived below)
lowpass   f=3400, Q=0.6                    // 6 mm glazed ceramic is a stiff, lossy panel
notch     f=1900, Q=2.2,  gain=-4.0 dB     // the plate's stiffness-controlled dip
highshelf f=9000, gain=-6 dB               // nothing gets past the glaze up here
+ the plate's modal bank (§2.5.2), summed post-lowpass, excited by impacts only
+ the rim shelf (§2.5.3), a directional cue, not a colour
```

**Deriving 620 Hz.** Two circular ports, ⌀30 mm, in a 6 mm plate, over a face cavity of ≈ 0.35 L.

```
A       = π·(0.015)²            = 7.07e-4 m²      (one port)
L_eff   = t + 1.7r = 0.006 + 0.0255 = 0.0315 m    (end correction, flanged one side)
f_1port = (c/2π)·√(A / (V·L_eff)) = 54.6·√(7.07e-4 / (3.5e-4 · 0.0315)) = 54.6·8.01 = 437 Hz
f_2port = f_1port·√2            = 618 Hz  ≈ 620
```

Q ≈ 1.4 because a mask cavity that leaks around the entire rim is heavily damped. v1.0 had a
+3.5 dB peak at 680 Hz described as "the boxy chest resonance inside the shell." The number was
nearly right and the reason was entirely wrong — there is no shell and no chest cavity. It is now
620 Hz because two 30 mm holes in a 6 mm plate over 0.35 L resonate there.

**Deleted: the 0.42 ms comb.** v1.0 blended a `delay 0.42 ms → gain 0.32` comb, nulling near
1.2 kHz and 3.6 kHz, and called it "what sells it." 0.42 ms of round trip is 144 mm of path —
that is a *deep moulded shell*, 72 mm off the face. A flat plate sits ≈ 22 mm off the face at its
deepest, giving a 44 mm round trip, τ = 0.128 ms, first null at 3.9 kHz — **above the 3400 Hz
lowpass, i.e. inaudible.** A flat plate does not comb. It *rings*. So the comb is gone and the
modal bank below replaces it, which is both correct and much more useful, because a modal bank can
be excited by things that happen in the world.

#### 2.5.2 The plate's modal bank — the mask is an instrument the weather plays

The plate is a resonator strapped to the player's face. **Anything that strikes it, rings it.**
This is free horror and free comedy, available every night it rains, and v1.0 did not have it.

```js
PLATE_MODES = [
  { f: 1834, Q: 60, gain: 0.50, decayMs: 380 },   // fundamental, LOWER half of the split pair
  { f: 1845, Q: 60, gain: 0.50, decayMs: 380 },   // UPPER half — see "the crack" below
  { f: 2760, Q: 54, gain: 0.62, decayMs: 300 },
  { f: 3150, Q: 48, gain: 0.48, decayMs: 240 },
  { f: 4980, Q: 40, gain: 0.22, decayMs: 150 },
];
```

**The crack.** `STORY.md` says the plate is hairline-cracked. A crack breaks the symmetry of a
plate mode and splits it into a close pair. 1834 and 1845 Hz beat at **11 Hz** — audible, slow,
and present on *every single excitation for the entire game*. The player will never identify it
and will never hear the mask sit still.

That 11 Hz is deliberately adjacent to the lantern's 11.5 Hz flicker LFO (§4.2) and the loon's
11.5 Hz tremolo (§5.3). The three are close enough to interfere and far enough never to lock.
Nothing in this game ever holds a steady rate.

**Exciters,** in order of how often the player will meet them:

| Exciter | Excitation | Gain into the bank | Notes |
|---|---|---|---|
| Rain | `grainTrain(rate = 3 + 26·rain, jitter=1.0)`, 0.6 ms noise grains highpassed at 2 kHz | −26 dBFS@1m | **The player hears the storm drumming on their own face.** Available every rainy night from Night 1. |
| A branch (`brush` while moving > 1.2 m/s) | one 1.2 ms burst, highpass 1800 | −18 dBFS@1m | 30% chance per `brush` |
| A camper's shoulder / a wall | one 2.4 ms burst, highpass 900, +2 semitone stretch on decays | −12 dBFS@1m | rare; the loudest the mask ever gets |
| The player setting the mask down | Ending C only (§4.28.4) | −20 dBFS@1m | the last time it makes a sound |

All of these are on `body`, **not** `sfxWorld`, because the plate is on his face — it is not a
world object and it must not be spatialized, occluded, or heard by campers. No `noise:emit`.

#### 2.5.3 The rim shelf — the mask's one gameplay consequence

The eyeholes are the only direct path to the ears; sound arriving from behind must diffract around
the plate rim. So the mask makes forward-facing sound brighter than rearward sound:

```
rimShelfDb = -3.0 * max(0, -cos(azimuth))     // 0 dB ahead, −3.0 dB directly behind
highshelf f = 5200, gain = rimShelfDb, setTargetAtTime(τ = 0.10)
```

This is deliberately *the same sign* as the front/back cue in §3.1.3 and reinforces it. It also
means the mask subtly rewards the player for turning to face what they want to hear, which is a
real behaviour a real mask would produce, and which no player will ever consciously notice.

#### 2.5.4 Tiering and the one transition

| `settings.quality` | Chain |
|---|---|
| `low` | peaking 620 + lowpass 3400 + highshelf 9000. No modal bank, no rim shelf. |
| `medium` | + notch 1900, + rim shelf. Modal bank reduced to the split pair only. |
| `high` / `ultra` | Full chain, full 5-mode bank, all four exciters. |

Blend depth is **82% wet** on `high`/`ultra`, 100% on `low`/`medium` (there is less to blend).

**The transition.** There is exactly one, ever: Ending C, §8 S13. The chain crossfades **out**
over 2800 ms. Everything the player has heard for seven nights becomes 3.4 kHz brighter, the
620 Hz peak vanishes, and the plate stops ringing. The world does not get louder — it gets
*clear*. It is unbearable precisely because the player never knew they were listening through
something.

---
## 3. 3D Audio

### 3.0 The world's actual extents

v1.0 set `maxDistance: 140` and then made a series of claims that this clamp rendered literally
inaudible: a hammer on steel "heard across the entire lake," a loon "at the far shore," a
`thunder` radius of 400 m, a `whistle` radius of 90 m, and `GAME_DESIGN.md` §11's Night-1 camper
laugh at exactly 140 m NE — sitting precisely on the clamp, where the inverse model's gain is
already at its floor.

Every number below is sourced. Audibility is controlled by `rolloffFactor` and the −60 dBFS voice
kill (§9.3), **never** by a hard distance clamp.

| Quantity | Value | Source |
|---|---|---|
| Playable bounds | 640 m (E–W) × 520 m (N–S) | derived from the rows below |
| **World diagonal → `maxDistance`** | **825 m** | √(640² + 520²) = 824.6 |
| Build plot ↔ camp centre | 140 m, bearing 042° (NE) | `GAME_DESIGN.md` §11 t=0:00 |
| Tier-1 spawn ring | 20–45 m | `GAME_DESIGN.md` §2.5 |
| Tier-2 spawn ring | 60–110 m | `GAME_DESIGN.md` §2.5 |
| Tier-3 spawn ring | 120–190 m | `GAME_DESIGN.md` §2.5 |
| Boathouse (inside the lit perimeter) | 90 m | `STORY.md` §4 Night Four |
| **Cove width** (dock ↔ opposite bank) | **41 m** | the `LAKE_EDGE` 240 ms slap, §3.3: 0.240·343/2 = 41.2 m |
| **Far shore** (the loon's fixed bearing) | **380 m, bearing 118°** | its own slap at 2.22 s, inside `LAKE_EDGE`'s 2.40 s RT60 |
| Grave (Marit's) | 40 m uphill | `STORY.md` §7.17 |
| Porcelain sink prop | 60 m | `STORY.md` §7.3 |
| Dale's Night-1 station | 400 m, bearing 190° (S) | `STORY.md` §4 Night One: "four hundred metres off" |
| `whistle` audible radius | 90 m | `GAME_DESIGN.md` §4.2 |
| `thunder` noise radius | 400 m | `GAME_DESIGN.md` §4.2 |
| Lightning strike distance | 0.4–4.2 km | `GAME_DESIGN.md` §3.3 |
| State campground | 6 km | `STORY.md` §4 Night Three — **narrative only, never audible.** This is Bev's wrong explanation, and it has to stay wrong. |

**The cove slap is now physically exact.** v1.0 asserted a "discrete slap at 240 ms" from the far
shore and separately implied the far shore was distant. Both cannot be true: 240 ms of round trip
is 41 m of water. So the 240 ms slap is the **cove**, which is genuinely 41 m across, and the far
shore at 380 m produces its own slap at 2.22 s — which is why `LAKE_EDGE`'s RT60 is 2.40 s and not
some rounder number. The reverb, the geography, and the loon's placement are now one consistent
object.

**Derived audible horizons** (inverse model, `refDistance 1.4`, source at its §1.3 level, killed
at −60 dBFS):

| Source | Rolloff | −60 dBFS at | Sanity check |
|---|---|---|---|
| Hammer on steel (−7 dBFS@1m) | 1.15 | **≈ 560 m** | covers the 380 m far shore and Dale's 400 m station. "A hammer on steel at night will be heard across the entire lake" is now a computed fact, not a boast. |
| Hammer on wood (−13 dBFS@1m) | 1.15 | ≈ 280 m | reaches camp at 140 m comfortably — which is what makes `GAME_DESIGN.md` §11's t=1:12 beat work |
| Tier-4 creak (−2 dBFS@1m) | 1.15 | ≈ 990 m (clipped to the world) | audible everywhere. Correct. |
| Crouch footstep (−27 dBFS@1m) | 1.15 | ≈ 45 m | you can be heard further than you can be seen. Correct and important. |
| Camper VO, ordinary take (−12 dBFS@1m) | 0.85 | ≈ 500 m | |
| Dale singing, Night 1 (−6 dBFS@1m) | 0.85 | ≈ 980 m → arrives at 400 m at **−53.7 dBFS** | at the very edge of hearing: "drunk, singing half a song and giving up on it twice," exactly as `STORY.md` describes |

### 3.1 Panner setup

`AudioContext.listener` is driven from `ctx.camera` every frame using the modern
`positionX/Y/Z`, `forwardX/Y/Z`, `upX/Y/Z` `AudioParam`s with `setTargetAtTime(v, now, 0.02)`.
**Never `setPosition()`** (deprecated, and it jumps), and never an instantaneous value assignment,
which causes zipper noise on HRTF convolution.

```js
panner.panningModel   = settings.tier('equalpower','equalpower','HRTF','HRTF');
panner.distanceModel  = 'inverse';
panner.refDistance    = 1.4;      // metres
panner.maxDistance    = 825;      // §3.0 — the world diagonal, not a gameplay clamp
panner.rolloffFactor  = 1.15;     // world SFX; see the class table below
```

| Class | `rolloffFactor` | Rationale |
|---|---|---|
| World SFX | 1.15 | the default |
| Camper VO | 0.85 | carries further — you hear them before you understand them (§7.1) |
| Campfire, lake, distant camp | 0.60 | landmarks must stay landmarks |
| The chorus bed (§5.2) | 0.40 | it is the room, not an object in it |
| Thunder | — | **not distance-panned at all.** A 2 km source has no parallax; it is a 2D stereo bed with a manual pan (§4.17) |

**Cones** for directional emitters (a camper's mouth, the tin roof under rain):
`coneInnerAngle 90, coneOuterAngle 240, coneOuterGain 0.35`. A camper facing away is quieter and
darker, and that is a gameplay tell the player will learn without being told.

#### 3.1.1 Elevation — continuous, because Night 5 lives on the boundary

v1.0: "sources more than 2 m above the listener get `highshelf f=7000, gain=+3`; below, `−4`.
Cheap and it works." It does not work. `GAME_DESIGN.md` §7 Night 5 is roof trusses, a ladder, and
skyline exposure — the player spends that entire night crossing the 2 m boundary, and every
camper, every cricket, and every raindrop would snap through a **7 dB** shelf on each crossing.

```js
// dy = source.y - listener.y, metres
elevShelfDb = clamp(3.5 * Math.tanh(dy / 2.0), -4, +3);
elevShelf.gain.setTargetAtTime(elevShelfDb, now, 0.15);
```

`tanh` rather than a clamped linear ramp so there is no derivative discontinuity at the clamp
either: dy = 2 m → +2.67 dB, dy = 4 m → +3.00 dB (saturated), dy = −2 m → −2.67 dB. Smoothed at
τ = 0.15 s, a ladder climb is a slow opening, not a switch.

#### 3.1.2 Rolloff, occlusion, and the −60 dBFS kill are the only audibility controls

Stated as a rule because it was violated once already: **no gameplay-relevant sound may be made
inaudible by a distance clamp, a `maxDistance`, or a hard cutoff radius.** If something should not
be heard at range, give it rolloff. The kill at −60 dBFS (§9.3) exists to save CPU on sounds that
are already inaudible, not to enforce design intent.

#### 3.1.3 Front/back — an explicit cue, on every tier

This is the fix for the most consequential item in defect 25. §1.1 promises azimuth legibility.
`panningModel: 'equalpower'` is a pure intensity pan: it provides **exactly zero** front/back
discrimination. On `low` and `medium` — which is what a large fraction of players will run in a
browser — a camper directly ahead and a camper directly behind are bit-identical. The game's
stated core legibility requirement was not met on half the quality tiers, and no amount of HRTF
on the other half fixes that.

So front/back is carried by an explicit, cheap, tier-independent pair of cues, applied to **every
3D source on every tier**:

```js
// az: 0 = directly ahead, π = directly behind
const back = Math.max(0, -Math.cos(az));        // 0 ahead, 1 behind

rearShelf.frequency.value = 4500;                        // pinna-shadow analogue
rearShelf.gain.setTargetAtTime(-5.5 * back, now, 0.08);  // 0 dB ahead, −5.5 dB behind
verbSend.gain.setTargetAtTime(baseSend + 0.08 * back, now, 0.12);  // rear sources are wetter
```

Two nodes per source: one `BiquadFilterNode` (persistent, in the voice slot, never constructed in
`play()`) and one gain ramp on a send that already exists. Free.

**Why this is the right mechanism and not a hack:** real human front/back discrimination is
dominated by pinna filtering — a spectral notch and high-frequency shadow that varies with
elevation and azimuth — plus the fact that rear sources reach the ear with a slightly higher
direct-to-reverberant ratio penalty in enclosed spaces. A −5.5 dB shelf at 4.5 kHz plus +0.08 wet
is a crude but *correct-signed* model of both. On HRTF tiers it reinforces the convolution rather
than fighting it (the HRTF already darkens rear sources; this deepens it consistently). On
`equalpower` it is the *only* front/back information in the graph, and it is enough.

**Restated honestly, so §1.1 is a promise we keep:** azimuth to ±15° in the frontal hemisphere on
`high`/`ultra`, ±25° on `low`/`medium`; ±30° behind on all tiers; **front/back unambiguous on all
tiers.** That is what ships.

### 3.2 Occlusion

Owned by `AudioEngine`, informed by `NoiseSystem` where available (null-check
`ctx.systems.get('NoiseSystem')`). Each 3D source has a two-path structure.

#### 3.2.1 The graph — the bleed path must not be localized

```
                ┌─▶[directLPF]─▶[directGain]─▶[rearShelf]─▶[elevShelf]─▶[panner]────┐
source(voice) ──┤                                                                   ├─▶ sfxWorld
                └─▶[bleedLPF 400Hz]─▶[bleedGain]─▶[bleedPan (StereoPannerNode)]─────┘
                                                          │
                                                          └─▶ pan = 0.35 * sign(azimuth)
```

The **direct path** is occluded. The **bleed path** models diffraction around the occluder.

v1.0 routed bleed into **the same `PannerNode` as the direct path** while claiming the result was
"a dull thud with no location" and that "'I heard something but I don't know where' is the entire
feel of the game." Routed through the panner, the bleed is fully localized and the stated quality
is not produced by that graph. It is now a `StereoPannerNode` at `pan = 0.35 · sign(azimuth)` —
a *hemisphere*, not a point. The player learns "something is over there, to the left, behind
something," which is exactly the intended ambiguity and is a genuinely different perceptual object
from a located source.

`bleedPan` is deliberately **not** given the rear shelf or the elevation shelf. Diffracted energy
has lost that information in the world, and it should lose it here.

#### 3.2.2 Occluder thickness

Effective thickness `T` accumulates along the listener→source path, in metres of *effective*
material:

| Occluder | Contribution to `T` |
|---|---|
| Pine trunk | 0.35 per trunk |
| Canopy / undergrowth | 0.10 per metre of path inside the volume |
| Terrain ridge | 4.0 (hard block) |
| Cabin wall, single board layer | 0.55 |
| Cabin wall, sheathed | 1.20 |
| Tent canvas | 0.18 |
| Boathouse / mess hall wall | 1.60 |
| Water surface | 0.00 — water *helps*; see §3.3 `LAKE_EDGE` |

These are audio's own numbers and are deliberately *ordered the same way* as `GAME_DESIGN.md`
§4.2's blocker factors (trunk 0.88 > canvas 0.90 ... boathouse 0.45), so that a player's ear and
a camper's ear agree about what is hard to hear through. They are not the same scale and they are
not meant to be; what must match is the ranking.

#### 3.2.3 The transfer functions — one formula, no prose

```
fc      = clamp(18000 * Math.exp(-0.55 * T), 180, 18000)   // Hz, directLPF
gainDb  = clamp(-3.2 * T, -34, 0)                          // directGain
bleedDb = clamp(-14 - 1.1 * T, -40, -14)                   // bleedGain
```

v1.0 specified the bleed gain **twice and incompatibly**: "always present at `−12 dB ·
directGain⁻¹`-ish" in prose and `bleedDb = -14 - 1.1*T` in the formula block. The prose is
deleted. "-ish" was doing load-bearing work in the game's most important system.

Worked values:

| Situation | `T` | `fc` | direct | bleed |
|---|---|---|---|---|
| One tree | 0.35 | 14.9 kHz | −1.1 dB | −14.4 dB |
| Three trees | 1.05 | 10.1 kHz | −3.4 dB | −15.2 dB |
| Cabin wall, sheathed | 1.20 | 9.3 kHz | −3.8 dB | −15.3 dB |
| Terrain ridge | 4.00 | 2.0 kHz | −12.8 dB | −18.4 dB |
| Three walls of the finished cabin | 3.60 | 2.5 kHz | −11.5 dB | −18.0 dB |
| Boathouse wall + a ridge | 5.60 | 0.83 kHz | −17.9 dB | −20.2 dB |

Smooth all three with `setTargetAtTime(τ = 0.08)` so a camper walking behind a tree **sweeps**
rather than steps.

#### 3.2.4 The whistle exception

`camper_whistle` (§4.28.2) uses `gainDb` normally but floors `bleedDb` at **−24 dB** regardless of
`T`. At radius 90 m it is the loudest camper event in the game and the mechanical signal that the
head counselor has raised the alarm. A whistle through a wall is still a whistle. This is the only
documented exception to §3.2.3 and it exists because ambiguity here is a bug, not a feature.

#### 3.2.5 The raycast budget — the analytic estimate is **primary**

`ARCHITECTURE.md` §12 caps the whole game at 12 raycasts/frame. `AudioEngine` may use **at most
3**, via `Physics.raycast()`.

v1.0 specified that "occluder thickness accumulates along the listener→source ray" with
per-trunk contributions, at 3 rays/frame. Accumulating *all* trunk hits along a ray through an
`InstancedMesh` forest requires enumerating every intersection, which needs a BVH this
architecture does not list, and `Physics.raycast()` is documented as a pooled first-hit query.
The v1.0 method could not be implemented as written.

**The analytic estimate is therefore the primary method at all ranges:**

```js
// Sampled at 8 points along the listener→source segment, from a density grid baked at init.
T_forest = pathLength * 0.10 * meanDensity        // canopy/undergrowth term
         + trunkRate(meanDensity) * pathLength    // trunkRate ≈ 0.22 trunks/m at density 1.0
T_ridge  = Terrain.segmentBelowHeightfield(a, b) ? 4.0 : 0.0;
T        = T_forest + T_ridge + T_structures;
```

The density grid is 8 m cells, baked once in `AudioEngine.init()` by querying
`Forest.densityAt(x, z)` (§0.4; fallback: 0.35 inside the 190 m ring, 0.55 outside). It costs
one `Uint8Array` of 80 × 65 = 5200 bytes for the whole world.

The **3 rays/frame** are reserved for exactly two cases, where the analytic estimate is known to
be wrong and the error is audible:

1. The **two nearest active sources** (nearest first), because at < 12 m a single trunk is the
   difference between hearing a camper and not.
2. **Cabin walls**, because `T_structures` needs a real geometric query and the cabin is the
   thing the player hides behind (`GAME_DESIGN.md` §4.4: "the thing you are building is your best
   cover").

Results are cached per source for **120 ms** and sources are refreshed round-robin by priority
(nearest and loudest first). Above 45 m, analytic only, always.

### 3.3 Reverb — four persistent convolvers and one comb

v1.0 contradicted itself inside a single section: "Only two `ConvolverNode`s exist at any time,"
followed by per-source instructions routing the loon 0.85 wet to `LAKE_EDGE`, tin rain 0.45 to
`TIN_ROOF`, far thunder 0.70 to `LAKE_EDGE` "even if the player is in the woods," and the distance
layer 0.55 to `OPEN_FOREST`. A player under the tin roof at the lake edge hearing a loon needs
three spaces resident simultaneously; two convolvers hold whatever the probe cell says.

Two further problems: reassigning `.buffer` on a live `ConvolverNode` re-partitions the impulse
response synchronously on the main thread **and** instantly truncates the outgoing tail — a click,
in direct violation of §9.2. And the probe grid was 8 m cells, which is larger than the cabin
footprint (the Night-5 north wall is 4.8 m per `STORY.md`), so `CABIN_SHELL` — "the cabin's reverb
is a progress meter" — could never resolve.

#### 3.3.1 The architecture

**Four `ConvolverNode`s, created once in `init()`, buffers assigned once, never reassigned for the
lifetime of the context.** Space selection is by **send gain only**. There is no crossfade of
buffers because there is no reassignment of buffers.

| Convolver | Space | RT60 (low / mid / high) | Early taps |
|---|---|---|---|
| A | `OPEN_FOREST` | 0.90 / 0.55 / 0.22 s | 6 taps, 11–48 ms, −9 dB |
| B | `DENSE_TREES` | 1.35 / 0.95 / 0.30 s | 22 taps, 6–70 ms, −5 dB, randomized pan |
| C | `CABIN_SHELL` | 0.55 / 0.62 / 0.40 s | 9 taps, 3–26 ms, −2 dB |
| D | `LAKE_EDGE` | 2.40 / 2.10 / 1.10 s | 3 taps + the **41 m cove slap at 240 ms, −11 dB**, hard-panned; + the far-shore slap at 2.22 s, −19 dB |

`TIN_ROOF` is **not** a convolver. Its character in v1.0 was "inverted spectrum, high band rings
longer, plus a comb at 3.1 ms, feedback 0.5" — which is a feedback comb and two shelves, not a
convolution. Building it as a persistent network (§3.3.4) costs ~7 nodes instead of a fifth
convolution and frees the slot that made the architecture contradictory.

At `settings.quality === 'low'`: **one** convolver, holding a 50/50 blend of `OPEN_FOREST` and
`DENSE_TREES`, plus the tin comb. No space selection at all — only a global send level that
tracks the listener's density sample.

#### 3.3.2 IR generation

Procedurally generated in an `OfflineAudioContext` during `AudioEngine.init()`. Budget: **< 140 ms
total** for all four (measured; they render far faster than realtime). Generate at 24 kHz on
`low`/`medium` and let the `ConvolverNode` resample; 48 kHz on `high`/`ultra`.

Recipe per space: noise → per-band exponential decay envelopes (4 bands crossed at 250 / 1200 /
5000 Hz, each with its own RT60) → a sparse set of early-reflection taps prepended → normalize to
unity RMS → `normalize = false` on the `ConvolverNode` so our normalization is the one that
counts.

`CABIN_SHELL` additionally bakes two resonant modes at **118 Hz and 187 Hz, Q 9** — the half-built
frame *rings*. See §3.3.3.

#### 3.3.3 `CABIN_SHELL` occupancy is geometric, and the progress meter is continuous

Not from the probe grid. Two inputs:

```js
// 1. Are we inside? Geometric, from the Build agent.
const enc = CabinSite.enclosure?.(listenerPos);   // 0..1, TODO(api) §0.4
// Fallback if absent — and this fallback is good enough to ship:
const enc = clamp01(countInstalled('panel') / totalSlots('panel'));

// 2. How built is it? This is the meter.
sendC.gain.setTargetAtTime(0.55 * enc, now, 2.0);
```

The **continuous** `enc` is the entire point. `GAME_DESIGN.md` §4.4 makes installed panels both
occlusion blockers and LOS blockers — "Panels installed = safety earned." The reverb says the same
thing, continuously, with no UI: as the player seals the shell, their own footsteps acquire a
room. On Night 2 there is no room. On Night 6 they are indoors and they built it. **Nothing
announces this and nobody comments.**

As `enc` rises past 0.6, additionally crossfade `CABIN_SHELL`'s send into a second, longer variant
(RT60 +0.25 s, modes +6 dB) baked at init as a fifth buffer held in memory but assigned to no
convolver — swapped by a **gain crossfade between two send paths into the same convolver**, never
by reassigning `.buffer`. Two sends, one convolver, no click.

The probe grid is retained **only** for the two outdoor spaces (`OPEN_FOREST` / `DENSE_TREES`) and
is reduced to **4 m cells** (one byte per cell; 160 × 130 = 20,800 bytes for the world). Sampled
every 250 ms.

#### 3.3.4 The tin comb

Persistent, built once, always in the graph, gated by `sendT`:

```
sendT ─▶[delay 3.1 ms]─┬─▶[highshelf f=4200, gain=+5]─▶[gain 0.50]─┐
          ▲            └──────────────────────────────────────────▶├─▶[lowcut hp f=380]─▶ verbReturn
          └──────────────────────────────────────────────────────  ┘   (feedback loop, 0.50)
```

Feedback 0.50 at 3.1 ms → a comb with peaks every 323 Hz and an RT60 of ≈ 0.031 s in the comb
alone; the `+5 dB` shelf inside the loop is what makes the high band ring *longer* than the low
band, which is the inverted-spectrum character that makes tin unmistakable. The 380 Hz high-pass
in the return keeps the comb from muddying the body band (§1.2).

`sendT` is opened only when `CabinSite.tinRoofArea()` reports the listener inside the roofed
volume (fallback: within 6 m of the plot centre once a roof stage is complete). Ramp τ = 0.35.

#### 3.3.5 Space dwell and send levels

**Minimum dwell: 6 seconds.** Once the dominant outdoor space changes, it may not change again for
6 s. Without this, a player walking a treeline oscillates between `OPEN_FOREST` and `DENSE_TREES`
several times a second and the reverb *breathes* audibly. Architectural transitions (`CABIN_SHELL`,
tin) are exempt — they are driven by continuous geometry, not by a discrete probe, and are
naturally smooth.

Per-bus base send levels:

| Bus | Send |
|---|---|
| `sfxWorld` | 0.22 (per-source overrides in §4) |
| `vo` | 0.12 at 0 m → 0.85 at 40 m (§7.2) |
| `ambience` | 0.10 |
| `music` | 0.35 — the score lives in the same forest as the player |
| `sfxUI` | **0.00**, always, no exceptions |
| `body` | **0.00**, always, no exceptions |

Per-source overrides that need more than one space (the loon, far thunder) simply open **two**
sends. That is now legal, because all four convolvers are always resident. It is what made the
v1.0 architecture impossible and it is what four persistent convolvers buys.

---

## 4. The SFX Cookbook

### 4.0 Primitives, and the LIVE/BAKED law

#### 4.0.1 Shared primitives (build these first, in `ProceduralSFX.js`)

**`NOISE`** — three 4.0 s stereo `AudioBuffer`s generated once at init: white; pink
(Voss-McCartney, 16 octaves); brown (leaky integrator `y[n] = 0.996·y[n−1] + 0.03·w[n]`,
DC-blocked). Every noise source is an `AudioBufferSourceNode` on one of these three with
`loop = true`, a random `loopStart` offset, and `detune` in ±120 cents. **Never allocate a new
noise buffer at runtime.**

**`impulse(durMs)`** — a 2 ms noise burst with a linear ramp-down. Used to excite modal banks. Not
a 1-sample spike: a spike is a `param.value` assignment in disguise and it clicks (§9.2).

**`modal(exciter, modes[], dest)`** — the workhorse. `modes[]` is a list of
`{ f, Q, gain, decayMs }`. Each mode is a persistent `BiquadFilterNode` (`type='bandpass'`,
`frequency=f`, `Q=Q`) fed in parallel from the exciter, each into its own `GainNode` set to `gain`
and then `exponentialRampToValueAtTime(1e-4, now + decayMs/1000)`. Sum to `dest`. **This one
function produces every impact, ping, knock, clack, and body resonance in the game.** The filters
live in the voice slot and are reused; only the exciter is recreated.

**`grainTrain(rate, jitter, durMs, grainFn)`** — schedules `grainFn` at `1/rate` intervals with
±`jitter` uniform timing noise, from a pre-allocated ring buffer of event descriptors (§9.3, zero
garbage). Used for gravel, rain, crackle, saw teeth, zippers, the pen stroke.

**`frictionOsc(params)`** — the stick-slip model behind every creak, squeak, drag, and pry. §4.12.

**Envelope minimums.** Never `gain.value = 0`. Never a hard start. Every voice opens with a
`linearRampToValueAtTime` of **≥ 4 ms** and closes with **≥ 8 ms** (exponential to 1e-4, then
`setValueAtTime(0)` one quantum later). Not optional. It is the difference between a game and a
clickfest.

#### 4.0.2 LIVE vs BAKED — the node-churn law

v1.0's §9.1 said "**Never build a `BiquadFilterNode` inside a `play()` call**," and then every
grain recipe in §4 did exactly that. The arithmetic:

| Recipe | v1.0 cost | Per second at `ultra` |
|---|---|---|
| Gravel footstep | 9–16 grains × (1 src + 2 biquad + 3 gain) ≈ 96 nodes | ≈ 180 at a sprint |
| Rain on tin | 450 grains/s × ~6 nodes | **2,700** |
| Rain on leaves | 450 grains/s × ~5 nodes | **2,250** |
| Cricket chorus | ~90 chirps/s × 4 nodes | 360 |
| Campfire crackle | 9 grains/s × 5 nodes | 45 |

Roughly **5,500 node constructions per second** at `ultra`, each a main-thread allocation plus a
graph-mutation message to the audio thread, competing with a 60 fps Three.js frame that also runs
volumetrics and post. v1.0 budgeted only a *voice count*, which is the wrong unit entirely.

**Every §4 recipe is now classified.**

**`LIVE`** — synthesized in the live graph, per instance. Reserved for hero one-shots whose exact
parameters carry gameplay information and therefore cannot be pre-rendered:

> creaks (all tiers), the seating tap ladder, `join_seat` / the grind / `join_split`, the pry bar,
> the saw's plate ring, wood splitting, hammer on wood, hammer on steel, thunder, the whistle,
> the clean universe's three words, the grab, the Night 7 breath catch, all music voices, all
> footstep IMPACT layers, all `frictionOsc` instances.

**`BAKED`** — rendered into `AudioBuffer`s at init in an `OfflineAudioContext`, played as pooled
`AudioBufferSourceNode`s with `detune` ±140 ¢ and `playbackRate` jitter ±6%. Everything grain-like:

| Family | Variants | Length | Bytes (48 k mono f32) |
|---|---|---|---|
| `step_needles.material` | 12 | 60 ms | 138 KB |
| `step_grass.material` | 12 | 75 ms | 173 KB |
| `step_gravel.material` | 12 | 190 ms | 438 KB |
| `step_mud.material` | 12 | 140 ms | 323 KB |
| `step_wood.material` | 8 | 50 ms | 77 KB |
| `step_tin.material` | 8 | 50 ms | 77 KB |
| `rain_leaves.grain` | 16 | 20 ms | 61 KB |
| `rain_tin.grain` | 16 | 45 ms | 138 KB |
| `rain_water.plink` | 12 | 60 ms | 138 KB |
| `fire.crackle` | 16 | 26 ms | 80 KB |
| `fire.pop` | 8 | 80 ms | 123 KB |
| `cricket.chirp` | 10 | 80 ms | 154 KB |
| `glass.ping` | 12 | 230 ms | 530 KB |
| `gravel.tick` | 12 | 40 ms | 92 KB |
| `wood.tick` | 12 | 60 ms | 138 KB |
| `zipper.grain` | 8 | 10 ms | 15 KB |
| `saw.tooth` | 12 | 8 ms | 18 KB |
| **Total** | | ≈ 14 s of audio | **≈ 2.7 MB** |

Budget: **≤ 8 MB** and **≤ 400 ms** of offline render, executed asynchronously in `init()` off the
first frame. Measured expectation ≈ 2.7 MB and ≈ 60–140 ms.

**The hybrid rule, which is better than baking everything.** Footsteps are `[IMPACT] + [MATERIAL]
+ [TAIL]`. The **IMPACT layer stays LIVE** (3 nodes, and it is the transient the ear locks onto
for surface identity and `loud`); the **MATERIAL grain layer is BAKED**. Twelve baked variants ×
detune ±140 ¢ × rate jitter × a live impact whose filter tracks `loud` continuously gives more
perceptual variety than v1.0's fully-live version, at 8% of the node cost. §4.1's rule "never play
the same step twice" survives intact.

#### 4.0.3 The budget, and how it is enforced

| `settings.quality` | Node constructions/s | Per-frame hard cap |
|---|---|---|
| `low` | ≤ 24 | 2 |
| `medium` | ≤ 40 | 3 |
| `high` | ≤ 70 | 4 |
| `ultra` | **≤ 120** | 6 |

Enforcement:

- `AudioEngine.stats.nodeChurn` — a rolling 1 s counter, incremented in the one factory function
  through which all node construction is funnelled. Nothing constructs a node outside it.
- Over the per-frame cap, construction requests are **deferred one frame**, up to **2 frames**,
  then dropped. Dropped requests increment `AudioEngine.stats.dropped` and are chosen by the
  §9.1 stealing score (lowest first), so what gets dropped is always a rain grain, never a creak.
- `AudioEngine.stats.underruns` — read from `ctx.baseLatency` drift and from
  `AudioContext.outputLatency` jumps; logged once per session via `Log.debug()` if non-zero.
- `tools/node-churn-check.mjs` (§11.3) runs a headless 60 s worst-case scene (storm + cascade +
  five campers + sprint on gravel) and fails the build if the budget is exceeded.

---

### 4.1 Footsteps — `LIVE` impact, `BAKED` material

Structure for all surfaces: `[IMPACT] + [MATERIAL] + [TAIL]`, total 60–260 ms, triggered by
`player:footstep { position, surface, loud }`.

`loud` scales gain and, critically, **which baked material variant is selected and at what
playback rate** — a heavy step displaces more material, so `loud > 0.5` selects from the upper six
variants (rendered with 1.6× grain count) and `loud ≤ 0.5` from the lower six. Randomize `detune`
±140 ¢ per step. Left/right alternate with a −1.5 / +1.5 semitone bias so the gait is organic
without limping.

Every step emits `noise:emit { kind:'footstep' }` at the §1.3 row matching the player's movement
state and carry class. **The surface multiplies the emitted intensity** — this is a level-design
tool and the player must be taught it:

| Surface | Intensity × | Why |
|---|---|---|
| Mud | **0.60** | dead surface, no tail — the safest floor in the game |
| Pine needles | 1.00 | the baseline |
| Wet grass | 1.10 | |
| Sawn wood | 1.25 | |
| Gravel | **1.70** | loudest natural surface |
| Tin | **2.40** | a suicide surface, and a comedy surface |

**Pine needles** (the default forest floor)
- IMPACT `LIVE`: brown noise, 18 ms, lowpass `f = 180 + 90·loud, Q = 0.7`, env `A 2 / D 16` exp,
  −18 dBFS@1m.
- MATERIAL `BAKED` (`step_needles.material`): each variant is `grainTrain(rate=180, jitter=0.6,
  dur=55ms)`, 6–11 grains, each 4 ms white noise through bandpass
  `f = 2400·(1 + rand(−0.35, 0.6)), Q = 3.5`, exp decay 9 ms.
- TAIL `BAKED` (folded into the variant): pink noise 90 ms, highpass 1800, bandpass
  `f = 3600, Q = 0.8`, env `A 4 / D 86`, −24 dBFS@1m. **This dry rustle is what makes needles read
  as needles**, and it is the reason the default surface is not the quiet one.

**Mud**
- IMPACT `LIVE`: brown noise 30 ms, lowpass sweeping `900 → 260` over 40 ms, `Q = 1.4`,
  −10 dBFS@1m.
- MATERIAL `BAKED`: **the suck.** A bandpass sweeping **upward** `180 → 620 Hz` over 130 ms at
  `Q = 7`, fed by pink noise at −16 dBFS@1m, env `A 30 / D 100`, offset 40 ms after the impact.
  The rising resonance *on the lift* is the entire signature of mud, and it is why mud reads as
  slow: the sound tells you your foot is still coming out.
- TAIL: none.

**Wet grass**
- IMPACT `LIVE`: as needles but lowpass 180, −20 dBFS@1m.
- MATERIAL `BAKED`: `grainTrain(rate=260, jitter=0.8, dur=70ms)`, grains 3 ms noise through
  bandpass `f = 5200·rand(0.7, 1.4), Q = 2.2`, decay 14 ms.
- TAIL `BAKED`: 120 ms noise wash, bandpass `f = 900, Q = 0.6`, −26 dBFS@1m. The blade-slap.

**Gravel**
- IMPACT `LIVE`: brown noise 22 ms, lowpass 300, −12 dBFS@1m.
- MATERIAL `BAKED`: `grainTrain(rate=95, jitter=1.0, dur=180ms)` — 9–16 grains, deliberately
  sparse and irregular. Each grain is
  `modal(impulse(1ms), [{f:1200·r, Q:14, g:1, d:35}, {f:2900·r, Q:9, g:0.5, d:22}])`,
  `r = rand(0.75, 1.45)`. **Stones are little resonators, not noise.**
- Grains keep arriving for 180 ms, so a running player on gravel emits an unbroken stream at
  1.70× intensity. That is the design.

**Sawn wood** (the cabin deck, planks, the truck bed)
- IMPACT `LIVE`: `modal(impulse(2ms), [{f:186,Q:26,g:1.00,d:120}, {f:432,Q:34,g:0.55,d:95},
  {f:971,Q:28,g:0.30,d:62}, {f:1830,Q:20,g:0.14,d:40}])` — the plank's flexural modes.
- BODY `LIVE`: lowpassed noise thud, `f = 140`, 40 ms, −14 dBFS@1m — the boot itself.
- HOLLOW `LIVE`, conditional: over the cabin's crawl space, add `{f:88, Q:7, g:0.40, d:340}`.
  **The cabin booms underfoot as it gets built.** Free progression cue, and it pairs with the
  `CABIN_SHELL` meter (§3.3.3) so the floor and the room agree.

**Tin** (roof sheets, shed, water tank)
- IMPACT `LIVE`: 6 inharmonic modes, `f = [412, 703, 1147, 1892, 2611, 4380]`,
  `Q = [90, 120, 140, 160, 150, 110]`, gains `[1, .72, .55, .48, .30, .18]`,
  decays `[900, 780, 640, 520, 380, 240] ms`.
- MEMBRANE `LIVE`: sine 74 Hz, `exponentialRamp` to 58 over 180 ms, env `A 3 / D 200`,
  −8 dBFS@1m.
- OIL-CANNING `LIVE`: after 120 ms, 20% chance of a second `modal` hit at 0.94× the frequencies —
  the sheet popping back. Model it accurately; do not shorten it; it is not a gag (§1.5).

### 4.2 The lantern

Carried at all times; the player's light and their liability. Three layers under a single
`PannerNode` parented ~0.9 m ahead and 0.4 m below the eye. Gated on `Player.illumination` and the
lantern's own lit state.

**Gas hiss** `LIVE`, continuous — pink noise → bandpass `f = 2350, Q = 0.85` → highshelf
`f = 6000, gain = −8` → gain **−38 dBFS@1m**. Amplitude-modulated by the flame flicker: a random
walk (`setTargetAtTime` every 60 ms to `0.85 + rand(0, 0.3)`, τ = 0.04) plus a **11.5 Hz** sine at
±0.06. Continuous, always on, and the player will stop hearing it in 90 seconds — which is the
whole point of §8 S8.

At fuel < 15 units (`GAME_DESIGN.md` §6.2, where the flame gutters at 3 Hz and the flicker itself
becomes a detection spike), the random walk's period drops to 20 ms and its range widens to
`0.45 + rand(0, 0.7)`. **The lantern audibly panics before the light does**, giving the player
about four seconds of warning that their illumination is about to start spiking their own
detection.

**Handle squeak** `LIVE` — `frictionOsc` tier 1 (§4.12), gated to the bail's swing. The bail
pivots twice per step cycle; fire at each velocity extremum **only if `|angularVel| > 0.9 rad/s`**.
`f_center = 1750·(1 + 0.4·|angVel|)`, duration 90–180 ms, −26 dBFS@1m.

**The faster you move, the more you squeak. Crouch-walk never squeaks.** This is the game's
stamina-versus-stealth dial and it is entirely audible with no UI. It emits no `noise:emit` of its
own — it rides the footstep that caused it — because a second emitter on the same event would
double-count the player's noise in `Campers`.

**Glass rattle** `BAKED` (`glass.ping`) — on any footfall with `loud > 0.22`, fire 2–5 pings:
`modal(impulse(0.5ms), [{f:2830·r,Q:95,g:1,d:210}, {f:4410·r,Q:110,g:0.6,d:170},
{f:6920·r,Q:80,g:0.25,d:120}])`, `r = rand(0.97, 1.03)`, staggered 0–35 ms, −30 dBFS@1m. Scale
count and gain linearly with `loud`. On tin or gravel, one extra ping and +4 dB.

### 4.3 Lumber

**Hoisting** (`build:pickup`, class C/D) — three layers over 900 ms:
1. Cloth/effort `LIVE`: pink noise, bandpass `f = 1100, Q = 0.8` sweeping `800 → 1400` as the beam
   comes up, env `A 120 / S 300 / R 400`, −30 dBFS@1m.
2. Wood groan `LIVE`: `frictionOsc` tier 2 at `f_center = 240`, only if mass > 60 kg (i.e. beams
   and trusses, per `GAME_DESIGN.md` §2.1).
3. Shoulder seat `LIVE`: sine 62 → 48 Hz over 120 ms, −16 dBFS@1m, at the moment the load lands.

Plus the breath (§4.27.1) switches to `HEAVY` for 4 s. **No grunt. Ever.** `STORY.md` §2: "Not a
grunt of exertion, not a roar."

**Dragging (lumber)** — a sustained loop, `noise:emit { kind:'drag', radius:22, intensity:0.38 }`
every 0.5 s:

```
bed:    brown noise → modal(sawn-wood 4 modes, Q reduced to 8, excited continuously)
                    → gain ∝ dragSpeed
grain:  grainTrain(rate = 40 + 90·speed, jitter=0.9) of 6 ms bandpass-2200 grains  [BAKED: wood.tick]
global: lowpass fc = 600 + 2400·speed, Q 0.7
```

Broad `Q` because a beam sliding on duff is excited continuously and everything damps everything.

**Dropping** (`build:drop`) — the loudest routine build sound. `noise:emit { kind:'drop' }` at the
§1.3 row for the carry class.
1. Sub `LIVE`: sine 58 Hz → 41 over 90 ms, env `A 2 / D 300`, −6 dBFS@1m.
2. Body `LIVE`: sawn-wood modal bank at `Q × 1.4`, decays × 1.6, −4 dBFS@1m.
3. Surface `BAKED`: the surface's material variant at the 1.6× grain-count tier.
4. Bounce `LIVE`: 55% chance of a second impact at `t = 140 + rand(0, 60) ms`, and a third if the
   second fired. Restitution: `t_{n+1} = t_n · 0.72`, `gain_{n+1} = gain_n · 0.45`.

**Two beams knocking** — the sound of the player fumbling. Pure `modal`, `LIVE`:
`[{f:214,Q:40,g:1,d:180}, {f:496,Q:52,g:0.7,d:150}, {f:1130,Q:44,g:0.4,d:95}]`, excited by a
1.5 ms burst highpassed at 900. Dry, woody, almost musical. **Pitch-shift the bank by beam
length:** `f × (2.4 / lengthMetres)`. A 3.2 m beam and a 2.6 m beam therefore knock at different
pitches — which is the audio half of grammar **G4** (`GAME_DESIGN.md` §2.4: "Two beams differ only
in length. No dimensions are printed"). A player who learns this can identify which beam is in
their hands in total darkness. That is the single most valuable thing this cookbook gives a
skilled player and it costs three filters.

**Carry bump** (`Physics` reports > 1.2 m/s relative): the knocking bank at
`gain = −18 + 14·speedNorm`, plus `noise:emit { kind:'impact', radius:18,
intensity: 0.25 + 0.4·speedNorm }` per `GAME_DESIGN.md` §5.3.

### 4.4 Hammer on wood — `LIVE`

The single most-repeated gameplay sound in the game. Every element carries information.

- TRANSIENT: 1.2 ms noise burst, highpass 2000, −6 dBFS@1m. Steel face meeting fibre.
- **NAIL:** `modal(sameExciter, [{f: fNail, Q:180, g:0.35, d:110}, {f: 2.16·fNail, Q:140,
  g:0.18, d:70}])`. **`fNail` rises 4% per strike** as the nail seats — shorter free length, higher
  mode. This is the progress readout and §4.7 turns it into the game's central skill check.
- **REFERENCE:** a fixed `{f: 3510, Q: 30, g: 0.12, d: 90}` partial in the WOOD layer — the backing
  board's own mode, physically justified and perceptually load-bearing. See §4.7.2.
- WOOD: sawn-wood modal bank, `Q × 0.8`, decays × 0.7, −8 dBFS@1m.
- BODY: sine 96 → 71 Hz over 70 ms, −14 dBFS@1m.

Total ≈ 340 ms. `noise:emit { kind:'hammer', radius: 34, intensity: 0.30–0.55 }` per strike,
intensity from the §4.7 tap ladder. **Radius is 34 m, from `GAME_DESIGN.md` §4.2** — v1.0 said
42 m, which is 52% more area and a materially different game.

### 4.5 Hammer on steel — `LIVE`

Bracket, spike, the anvil in the shed. Same transient, then:

```js
modal(exciter, [
  { f:  2130, Q:  900, g: 1.00, d: 1800 },
  { f:  3910, Q: 1100, g: 0.75, d: 1600 },
  { f:  5740, Q:  800, g: 0.50, d: 1200 },
  { f:  8320, Q:  600, g: 0.28, d:  800 },
  { f: 11200, Q:  400, g: 0.12, d:  500 },
]);
```

- **Nonlinear pitch glide:** immediately after the strike, detune all modes +35 ¢ and
  `exponentialRamp` back to 0 over 240 ms. Real struck metal goes sharp under high amplitude and
  settles. Without this it is a synth. With it, it is metal.
- **`WaveShaperNode`, soft clip, 3rd-order, drive 1.6, on the first 60 ms only, then bypassed —
  and `oversample: '4x'`.** With the default `'none'`, an 11.2 kHz partial through a 3rd-order
  shaper folds its harmonics back below Nyquist as inharmonic mud, and this bank has the highest
  partials in the game. `'4x'` is mandatory here and on all five shapers (§9.3.4).
- DC blocker after the shaper: `highpass f = 18, Q = 0.7` (§9.2 rule 7).

`noise:emit { kind:'hammer', radius: 34, intensity: 0.55 }` — same canonical row as wood. v1.0
gave steel a private 85 m radius, which does not exist. Its **audible** horizon is ≈ 560 m
(§3.0), and that is where "heard across the entire lake" actually lives: the player hears it
carry, the campers respond at 34 m. The gap between those two numbers is the most useful lie in
the game and it is now deliberate rather than accidental.

### 4.6 Bracket dropped on rock — `LIVE` bank, `BAKED` ticks

- Bounce sequence: 3–5 impacts, `t_1 = 0, t_2 = 165 ms`, `t_{n+1} = t_n · 0.68`, gains
  `−0 / −7 / −13 / −19 / −25` dB relative to −17.0 dBFS@1m (the `drop` class-B row).
- Each impact: the steel bank (§4.5) with decays scaled to `[220, 180, 150, 120, 90] ms` and a
  **different random detune per bounce (±90 ¢)** — the bracket is tumbling and presenting
  different faces.
- Each impact also gets a rock tick `BAKED` (`gravel.tick`):
  `modal(impulse(0.8ms), [{f:1700·r,Q:22,g:0.5,d:26}, {f:4300·r,Q:16,g:0.3,d:16}])`.
- Final settle: `grainTrain(rate = 34 → 90 accelerando, dur = 380 ms)` of quiet (−28 dBFS@1m)
  short metal ticks, like a dropped coin coming to rest.

**Direction — and this replaces v1.0's, which broke pillar 1.** v1.0 wrote: "The comedy sound. It
must be *inconveniently* charming… **This tail is the joke.**" The world does not do bits (§1.5).

> **Model this accurately and mix it flat. Do not shorten it, do not sweeten it, do not add a
> button, do not put a smile on the final tick. It is 380 ms long because a tumbling steel bracket
> settling on rock takes 380 ms, and nobody involved in making this sound thinks it is funny.**

It *is* funny. The player has been perfectly silent for ninety seconds and a small piece of
hardware is now going to spend nearly half a second announcing itself, and then a camper is going
to say `COO_HEAR_01` — "Deer. That's deer. That's a deer thing." **The laugh is in the
consequence.** The bracket is just a bracket.

### 4.7 The seating check — the game's central skill, as a tap ladder

`GAME_DESIGN.md` §2.3 calls this "the single most important interaction in the game." v1.0
specified a *screw torque* readout with a continuous grain train and a seat cue at
`torque > 0.86`. **There are no screws in this game, there is no continuous torque value, and 0.86
is not the target.** The real check is a 2.2 s hold against `p = (t/2.2)^1.35` with a green band
at `p ∈ [0.72, 0.88]`, resolved in **3–6 discrete hammer taps**. A player releasing on v1.0's seat
thump would have had 0.02 of margin before a cosmetic dimple and 0.10 before splitting the wood.

#### 4.7.1 The tap ladder — **DERIVED from `GAME_DESIGN.md` §2.3**

The design gives tap *counts* per outcome band. Those counts uniquely determine the tap positions:

| Release at | Taps | Only possible if taps sit at `p` = |
|---|---|---|
| `p < 0.72` | 3 | 0.18, 0.40, 0.62 |
| `p ∈ [0.72, 0.88]` | 4 | + 0.80 |
| `p ∈ (0.88, 0.96]` | 5 | + 0.92 |
| `p > 0.96` | 6 | + 0.98 |

Inverting the ease-in curve, `t = 2.2 · p^(1/1.35)`:

| Tap | `p` | `t` (ms) | Δt from previous | `noise:emit` intensity | `fNail` (Hz) | \|Δ from 3510\| |
|---|---|---|---|---|---|---|
| 1 | 0.18 | 618 | — | 0.30 | 3120 | 390 |
| 2 | 0.40 | 1116 | 498 | 0.30 | 3245 | 265 |
| 3 | 0.62 | 1544 | 428 | 0.35 | 3375 | **135** |
| **4** | **0.80** | **1865** | **321** | **0.35** | **3510** | **0** |
| 5 | 0.92 | 2068 | 203 | 0.40 | 3650 | **140** |
| 6 | 0.98 | 2167 | 99 | 0.55 | 3796 | 286 |

**The taps accelerate**, from 498 ms apart to 99 ms apart, because the design's own ease-in curve
says so. That accelerating rhythm is a learnable clock, and it is free — nobody had to invent it.

#### 4.7.2 The band cue — critical-band roughness, not a beat rate

Each tap's nail mode is beaten against the fixed 3510 Hz reference partial in the wood layer
(§4.4). The ear's response to two tones separated by Δ inside one critical band is *roughness*,
peaking near a quarter of the ERB. At 3510 Hz, `ERB = 24.7·(0.00437·3510 + 1) = 404 Hz`, so
roughness peaks near **101 Hz** of separation.

| Tap | Δ | Perceptual result |
|---|---|---|
| 1 | 390 Hz | ≈ one ERB: a clean, wide, unremarkable interval |
| 2 | 265 Hz | mildly rough |
| 3 | 135 Hz | **near-maximum roughness** — harsh, buzzing, *wrong-sounding* |
| **4** | **0 Hz** | **perfect fusion. One tone. Clean.** |
| 5 | 140 Hz | **near-maximum roughness again** |
| 6 | 286 Hz | rough, then the split |

**The band tap is the only clean tap in the ladder and it is flanked on both sides by the two
roughest.** A player does not need to count taps or watch a bar. They need to release on the one
that stops buzzing. That is an unmistakable perceptual target that works through rain, through
occlusion, on a laptop speaker, and with the eyes closed — which is §1.1's actual requirement.

The review proposed signalling the band by "the third partial's beat rate against a −20 dB
reference sine dropping below 3 Hz." That does not work at these separations: beating is only
perceived as a *rate* below roughly 20 Hz of separation, and tap 3 is 135 Hz away. The
mechanism had to be roughness, not beating. The *idea* — make the ear do arithmetic the eyes
cannot — was right and is what this section implements.

#### 4.7.3 Asymmetry: which side of the band are you on?

Roughness is symmetric, so taps 3 and 5 sound similar. The disambiguation is not inferred — it is
a **new sound**, exactly where the design puts a new consequence:

- **Tap 5** (`p ∈ (0.88, 0.96]`, "over-torqued, cosmetic dimple"): add the **dimple** —
  a 1.5 ms noise burst lowpassed at 900, `Q = 1.2`, plus a 40 ms fibre-crush tail
  (`grainTrain(rate=90, jitter=1.0, dur=40ms)` of 2 ms bandpass-1300 grains), at −20 dBFS@1m.
  Soft, dull, and slightly sickening. It is the sound of wood giving up a little.
- **Tap 6** (`p > 0.96`): the dimple, then `join_split` (§4.8) at full level, plus the design's
  `noise:emit { kind:'impact', radius:30, intensity:0.60 }`, plus an instant severity-0.7 creak.

So: buzz, buzz, **clean**, dimple, catastrophe. Four distinguishable states, all diegetic, no HUD.

#### 4.7.4 Thunder masking and the first-time exception

`GAME_DESIGN.md` §2.3: "Under thunder masking the player can hold to `p = 0.88` at zero effective
risk. Skilled play is timing your hammering to the storm." §4.17.4 is what makes that timeable.

`GAME_DESIGN.md` §11 t=1:02: the first seating check ever opens automatically, with the band at
2× width and time at 0.6×. At 0.6× time the taps land at 1030, 1860, 2573, 3108, 3447, 3612 ms and
the pitch ladder stretches with them. **Do not compensate the pitches for the time scale** — let
the whole ladder run slow, so the player's first experience of the cue is at half speed, and every
subsequent one is the same shape faster.

### 4.8 Wood splitting — `LIVE`

- **Pre-crackle:** `grainTrain(rate = 12 → 70 accelerando over 400 ms, jitter 1.0)`, grains =
  `modal(impulse(1ms), [{f:1900·r,Q:30,g:1,d:40}, {f:3800·r,Q:24,g:0.4,d:24}])`,
  `r = rand(0.6, 1.6)`. Fibres letting go one at a time. **Rising density is rising dread**, and it
  is the only accelerando in this document that is allowed to build tension, because it is the one
  place where the outcome is not yet decided.
- **THE CRACK:** 3 ms noise burst highpassed at 1200, −2 dBFS@1m; **plus** a downward chirp, sine
  1400 → 180 Hz over 55 ms (the whipcrack of release); **plus** the sawn-wood bank at `Q × 2`,
  `gain +6 dB`, decays × 2.5.
- **Tear tail:** pink noise 700 ms, bandpass sweeping `2600 → 700 Hz`, `Q 1.6`, exp decay,
  −16 dBFS@1m.

Emits `noise:emit { kind:'impact', radius: 30, intensity: 0.60 }` per `GAME_DESIGN.md` §2.3.
v1.0 invented a `split` kind at intensity 0.90 — deleted. The design routes splits through
`impact` and 0.60 is the number.

### 4.9 The four placement outcomes — the truth table

This is the most important table in the cookbook, because three of its four rows are about
*withholding* information. `build:place { part, slot, correct }` carries only a boolean; the
outcome class comes from `state.installed[slotId]` on the next tick, or from `BuildSystem`'s
`audio:sfx` id, whichever arrives first.

| Outcome | `correct` | `w` | Sound, at the moment of placement | Duration | Later |
|---|---|---|---|---|---|
| **Seated** | `true` | 0.00 | `join_seat`: `modal([{f:158,Q:30,g:1,d:150},{f:390,Q:26,g:0.5,d:110}])` + a 4 kHz tick at −24 dBFS@1m. Mixed **+2 dB louder than it strictly needs to be.** | 210 ms | silence forever |
| **Rotated** | `false` | 0.35 | `join_seat`, then **the grind** (§4.9.1) | 210 + 400 ms | creaks |
| **Wrong slot** | `false` | 0.60 | **`join_seat`. Identical. Nothing else. No tell of any kind.** | 210 ms | creaks; the part it belonged in can never be seated |
| **Wrong part** | `false` | 1.00 | the pry-bar sequence (§4.11) then `join_split` (§4.8) | 1400 + 900 ms | permanent 1.0 wrongness |

`join_seat` is the most satisfying sound in the game and it should be mixed slightly louder than
strictly necessary. It is the entire positive-feedback economy of a game with no score, no XP, and
no HUD.

**Row 3 is a contract.** Wrong-slot must be *acoustically indistinguishable* from Seated. Not
subtle — **identical**: same recipe, same level, same reverb send, same random seed policy. Any
future engineer who adds "just a tiny difference" to help players has removed grammar G4 and G5
from the game (`GAME_DESIGN.md` §2.4) and turned a diagnostic puzzle into a compliance test. This
row is annotated in the registry (§10) with `MUST_BE_IDENTICAL_TO: join_seat`.

#### 4.9.1 The grind — the discrimination the player must *almost* miss

`GAME_DESIGN.md` §2.3, Rotated: "seats, but with 6 mm visible offset and a **0.4 s grinding
tail**." This is the finest discrimination in the game. It has to be genuinely detectable and
genuinely missable, and v1.0 did not specify it at all.

```
frictionOsc:  slipRate 46, N = 11, duration 400 ms
              f_center 1180 → 1040 Hz, Q = 34, pitchDrop 220 ¢
              gain −27 dBFS@1m  (i.e. 10 dB below the join_seat thump that precedes it)
bed:          brown noise → lowpass f_center/3 → −34 dBFS@1m
onset:        begins 180 ms after the seat thump — i.e. *inside* the thump's own 210 ms decay
```

The onset offset is the whole design. The grind begins while the seat thump is still ringing, at
10 dB down, in the same frequency neighbourhood the thump's second mode (390 Hz) has already
vacated. A player who is listening hears it. A player who is watching a camper's torch does not.
**Both are correct outcomes**, and the second one is why the creak system exists.

`Q = 34` is deliberately low for a `frictionOsc` — the two surfaces are in full contact under load
and heavily damped, so it grinds rather than squeals. A high-Q grind would sound like a small
creak and the player would learn the wrong lesson.

No `noise:emit`. The grind is quiet, close, and for the player alone. Campers do not hear you make
a mistake; they hear the mistake nine seconds later, which is the game.

---
<!--CONTINUE-->

