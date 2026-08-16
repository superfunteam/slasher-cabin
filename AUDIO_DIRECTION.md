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
<!--CONTINUE-->
