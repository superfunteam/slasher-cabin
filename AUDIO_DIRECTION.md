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
### 4.10 Nail pulled, and the wrench removal — `LIVE`

`build:remove` costs 8 s and emits `noise:emit { kind:'wrench', radius: 24, intensity: 0.45 }`
(`GAME_DESIGN.md` §2.2). **Undoing is loud**, and that is the core tension of the errata grammar
(G6): the manual is wrong, you now know it is wrong, and fixing it announces you.

The 8 seconds are structured, not a loop:

1. **0–900 ms — the bar setting.** A steel-on-wood scrape: `frictionOsc`, `slipRate 62, N = 7,
   f_center 900 → 720, Q = 40`, −26 dBFS@1m.
2. **0.9–6.2 s — the pull, ×3.** Three cycles of `nail_pull`, 1.7 s apart:
   - `frictionOsc` tier 2–3 with an **upward** `f_center` sweep `620 → 1450 Hz` over 500 ms. The
     free shank shortens as it comes out, so the resonance rises — the exact inverse of §4.4's
     seating rise, and a player who has driven two hundred nails will feel that inversion before
     they can name it.
   - Terminal pop: `modal([{f:940,Q:60,g:1,d:90}, {f:2200,Q:40,g:0.6,d:60}])` plus a 25 ms noise
     chuff lowpassed at 700.
3. **6.2–8.0 s — the part coming free.** One `drop_lumber` body layer at 0.5× gain, plus the
   surface material layer.

`noise:emit` fires **once, at t = 900 ms**, not per pull — one canonical emission per
`build:remove`, per the design's single-row entry.

**Mix it as relief.** Dry, close, −14 dBFS@1m, reverb send **0.06** instead of the 0.22 base.
Removing a wrong part is the sound of undoing a mistake and it should feel physically closer to
the player than the mistake did. That is the one emotional colour audio is allowed to add here,
and it is achieved with a send level, not with a sweetener.

### 4.11 The pry bar — the 1.4 s that decides the run

`GAME_DESIGN.md` §2.3: "Wrong part cannot be placed by accident. The ghost refuses; the player must
hold the place input for **1.4 s** to force it. This is a deliberate, punished choice — usually
made at 04:40 when the player is short a bracket and out of time. **That decision is the game.**"

v1.0 had no sound for it at all. It gets three movements and a silence.

| t | Movement | Recipe |
|---|---|---|
| 0–500 ms | **The bar sets.** | `frictionOsc`, `slipRate 30, N = 5, f_center 380 → 240, Q = 90, pitchDrop 380 ¢`, −22 dBFS@1m. Steel finding purchase in a gap that does not want it. |
| 500–1200 ms | **The load.** | `frictionOsc` at tier-3 amplitude but with **`slipRate` 4 and `N = 2`** — i.e. *no slip individuation at all*. `f_center 700 → 380`, `Q` climbing 90 → 200, gain −22 → −8 dBFS@1m. Under it, a sine 58 Hz rising −40 → −18 dBFS@1m. |
| **1200–1400 ms** | **Nothing.** | **200 ms of complete silence on `sfxWorld`.** The bed continues. The player is still holding the button. |
| 1400 ms | **The split.** | `join_split` (§4.8) at full level + `noise:emit { kind:'impact', radius:30, intensity:0.60 }`. |

**Movement 2 is the inverse of a creak and that is deliberate.** A creak is a sequence of discrete
slips — the player learns to count the pops (§4.12.4). The pry bar is *one continuous slip*, smooth
and rising, with nothing to count. It is the only sustained wood sound in the game that does not
individuate, and it therefore sounds *unlike anything else the wood has ever done*, which is
correct: nothing in the manual asked for this.

**Movement 3 is the only place in this game where silence is a warning rather than a consequence.**
Every other silence in §8 arrives after something. This one arrives before. The player is 200 ms
from a permanent 1.0-wrongness join that can never be shimmed below 0.55, and the game has just
gone quiet and left the button under their thumb. If they release, nothing happens and nothing is
said about it.

Do not add a UI prompt to movement 3. Do not add a heartbeat. Do not duck the bed. The silence is
the entire mechanism.

### 4.12 THE CREAK — the signature sound

A **stick-slip friction** phenomenon, not a filtered noise sweep. Modelling it properly is why our
creak will be better than everyone else's, and `GAME_DESIGN.md` §11 stakes the whole tutorial on
it: "at 4:39, if the player does not physically flinch… the game has failed."

#### 4.12.1 `frictionOsc(params)` — the core model

```
1. SLIP CLOCK: a scheduled sequence of gain ramps — N events at times t_i, where
   dt_i = dt_0 · (1 + 0.5·rand(-1,1)) and dt_0 = 1/slipRate.
   NOT a per-slip AudioBufferSource. One persistent noise source, N scheduled ramps.
   This is why a 17-slip tier-3 creak costs ~8 nodes and not ~90 (§4.0.3).
2. Each slip event: the shared noise source gated open for 1.5 ms → gain g_i.
3. RESONATOR: all excitations feed a bandpass at f_center, Q = Qc (40–260).
   f_center ramps DOWN by `pitchDrop` cents across the whole event — the joint settling
   under load. Down, always. A creak that rises is a creak that is being relieved of load,
   which happens exactly twice in this game (§4.10 nail pull, §4.16 pine whistle).
4. A parallel second resonator at f_center · 1.47, at −8 dB — the "two surfaces" quality.
   1.47 is deliberately not a small-integer ratio; a harmonic partner reads as a note.
5. A brown-noise bed through a lowpass at f_center/3, at −26 dBFS@1m, glues it.
6. A gentle WaveShaper (drive 1.3, **oversample '4x'**) — friction is nonlinear.
   DC blocker after: highpass f=18, Q=0.7.
```

The parameter that makes it a creak rather than a buzz is `slipRate` in the **8–90 Hz** range with
**heavy irregularity**. Regular is a synth tone. Irregular is wood.

#### 4.12.2 Tiers — **DERIVED from `GAME_DESIGN.md` §3.1**, and rebased

`build:creak` carries `{ position, severity }`. **Quantization into tiers happens in
`AudioEngine`**, not in `BuildSystem`. v1.0 instructed a system it does not own ("`BuildSystem`
should quantize to tiers") when the payload is fixed and the tiering is a presentation decision.

v1.0's thresholds also could not fire. `severity = clamp01(0.25 + 0.55w + 0.30s + 0.20·min(L,1.5))`
and `lambda = 6.0·(w + 0.30s)·(...)`, so `lambda = 0` whenever `w = 0` and `s = 0`. Any join that
creaks at all has `w > 0` or `s > 0`, and the lowest severity actually reachable is **≈ 0.41** (a
correctly-placed join released at `p ≈ 0.5`, `torque 0.45`, `s = 0.55`, low load). **v1.0's tier 1
band of `severity ≤ 0.25` was dead code.** Nobody would ever have heard it.

Rebased on the reachable range, with the **tier-2/3 boundary at exactly 0.70** so that it
coincides with `GAME_DESIGN.md` §3.1's own `severity > 0.7 ? 'creak_groan' : 'creak_tick'` split:

| Tier | Severity band | design `audio:sfx` id | Reachable via |
|---|---|---|---|
| **1** — the tick | ≤ 0.50 | `creak_tick` | Seated but under-torqued, light load |
| **2** — the complaint | 0.50 < s ≤ 0.70 | `creak_tick` | Rotated at low load, or badly under-torqued |
| **3** — the groan | 0.70 < s ≤ 0.85 | `creak_groan` | Rotated under load, Wrong-slot |
| **4** — the failure | > 0.85 | `creak_groan` | Wrong-part, or Wrong-slot at high load with a seating deficit |

`radius = 14 + 46·severity`, clamped to **[14, 60] m**, verbatim from the design.
`intensity = severity`, verbatim. **v1.0's 120 m tier-4 radius does not exist**; the formula caps
at 60.

#### 4.12.3 Tier recipes

**Tier 1 — "the tick."**
`slipRate 34, N = 3, duration 90 ms, f_center 2400 → 2280, Q = 70, pitchDrop 90 ¢,`
`gain −16 dBFS@1m` (from §1.3 at severity ≈ 0.45). Barely a sound. A single dry tick, like a house
at night. No mix duck. **The player is allowed to ignore this one**, and that permission is what
makes tiers 3 and 4 terrifying.

**Tier 2 — "the complaint."**
`slipRate 22, N = 9, duration 420 ms, f_center 1650 → 1410, Q = 110, pitchDrop 260 ¢,`
`gain −11 dBFS@1m`. A short, high, unmistakable *eeuk*. Inharmonic partner at −8 dB. No duck; dips
the chorus to 40% (§5.4).

**Tier 3 — "the groan."**
`slipRate 13, N = 17, duration 1.15 s, f_center 880 → 620, Q = 160, pitchDrop 520 ¢,`
`gain −7 dBFS@1m`. Long enough to be a *sentence*. Add a sub layer: sine 74 → 58 Hz across the
full duration at −22 dBFS@1m. **The slip events audibly individuate — the player can count the
pops.** Full duck (§2.3). Chorus stops for 4 s. Triggers S3.

**Tier 4 — "the failure."** 2.6 s, three movements, and the building must sound like it is *dying*.

1. **0–900 ms, the load.** `frictionOsc: slipRate 9, N = 8, f_center 640 → 430, Q = 220,
   pitchDrop 700 ¢, gain −4 dBFS@1m`. The slips are so slow they are individually audible as
   *knocks*. Under it, a sine at 52 Hz rising −40 → −16 dBFS@1m.
2. **900–1600 ms, the descent.** `f_center` continues to **190 Hz** while `Q` climbs to 260.
   Simultaneously a **subharmonic** appears at `f_center / 2` (≈ 95 Hz), amplitude-modulated by the
   slip clock, at −14 dBFS@1m. This is the psychoacoustic nastiness: something too big making a
   sound too low for its size. Add a 5.5 Hz tremolo, ±4 dB, so it wobbles.
3. **1600–2600 ms, the tear.** Trigger `join_split` (§4.8) at 1600 ms at full level, then a
   **decelerating** crackle: `grainTrain(rate = 60 → 6 decelerando, dur 900 ms)` of wood modal
   ticks, random detune ±700 ¢. **The deceleration is critical.** An accelerating crackle reads as
   building tension; a decelerating one reads as aftermath, as debris settling, as *it is over and
   you cannot undo it*. This is the only decelerando in the document and it is load-bearing.
4. Optional 4th movement, **5% chance, Nights 6–7 only**: 400 ms of nothing, then one very quiet
   tick at −34 dBFS@1m. The building has one more thing to say.

If `state.suspicion > 0.5` when a tier 4 fires, `NightManager` will likely consider the night lost.
**The audio has already told the player that, 2.6 seconds before the UI does.**

#### 4.12.4 The tier-4 cooldown — mandatory, with the arithmetic

A Wrong-part join has `w = 1.00`. At `L = 1.0`, `Mw = Mt = Md = 1`:
`lambda = 6.0 · 1.00 · (0.40 + 0.90) = 7.8` creaks/minute. Its severity is
`0.25 + 0.55 + 0.30s + 0.20 = ≈ 1.0`. **Unmitigated, that is a tier-4 failure every 7.7 seconds
for the rest of the game.** The scariest sound in the game would become wallpaper inside two
minutes, and `creakDebt` carries 40% into the next night.

Therefore, in `AudioEngine`:

- **At most one tier 4 per join, ever** — for the whole run, across all seven nights.
- **At most one tier 4 per night**, globally.
- Every subsequent creak that quantizes to tier 4 resolves as **tier 3 plus the "already dead"
  knock**: a 400 ms dry, close, unreverbed double knock,
  `modal([{f:132,Q:14,g:1,d:190},{f:298,Q:11,g:0.5,d:150}])` at t = 0 and t = 155 ms,
  −20 dBFS@1m, reverb send 0.04. It is flat, wooden, and completely without drama. **The building
  has stopped complaining and started confirming.**
- The `noise:emit` still goes out at the **true** severity. The cooldown is a presentation
  decision; it must never make the player safer than `Campers` thinks they are (§1.3's contract
  cuts both ways).

#### 4.12.5 The cascade

`GAME_DESIGN.md` §3.2: at `creakDebt > 1.2`, "3–5 joins creak within 1.5 s… The cascade is the
game's scariest moment and it is entirely the player's fault."

v1.0 would have broken it. Its per-family cap was "max 3 simultaneous creaks" and its duck release
was 1200 ms, so a five-creak cascade would have dropped two creaks and left the mix pinned flat
under a single duck for the whole event.

`AudioEngine` detects a cascade as **≥ 3 `build:creak` events within 1.5 s** and switches to a
`CASCADE` handler:

- **Family cap raised to 5**, for this case only, released when 1.5 s elapse with no new creak.
- **One duck for the entire cascade** — `music −12`, `ambience −8`, `A 40 / H 1500 / R 1400` —
  retriggered (hold extended) but never re-attacked by subsequent creaks in the same cascade.
- Creaks are **voice-stacked with a 90 ms stagger** even if they arrive simultaneously, and
  **pitch-spread ±300 ¢** around each one's own `f_center`. Simultaneous identical-band creaks
  mask each other into a single wash; 90 ms and ±300 ¢ keeps five events sounding like *five
  things*, which is the horror.
- Tiers are computed per creak as normal, and the tier-4 cooldown applies within the cascade — a
  cascade is at most one tier 4 and up to four tier 3s. That is more frightening than five tier
  4s, because it is legible.
- `Weather` is asked for a gust to cover it (design's own behaviour); the gust's wind rise is
  audible in `gustLPF` (§4.16) about 400 ms after the cascade begins. The cabin screams and the
  weather arrives to help. Nobody comments.

### 4.13 The handsaw — `LIVE` plate, `BAKED` teeth

`STORY.md` §2: "No blade at all until Night Four, and then only a handsaw, **and he hates using it
because it is loud and it dulls.**" §4 Night Three: "cutting is the loudest sustained noise in the
game… you must break it into passes between patrols. **The comedy: you cannot rush a saw. The
monster is hostage to the physics of a saw.**"

v1.0 had no saw. See conflicts **C1** (the `saw` kind) and **C2** (which night) — both flagged,
neither resolved here, and the recipe works under either resolution.

**Tooth rate, derived.** A 7 TPI handsaw at a cutting speed of 0.45 m/s:
`0.45 / (0.0254/7) = 0.45 / 0.003629 = 124 teeth/second`.

```
strokes:   1.1 push strokes/second, each 620 ms; the return stroke is 380 ms
teeth:     grainTrain(rate = 124 · strokeVel, jitter = 0.28)   [BAKED: saw.tooth]
           each tooth: 1.2 ms noise → bandpass f = 1900·rand(0.8,1.3), Q = 4 → decay 6 ms
plate:     modal([{f:340,Q:110,g:1.00,d:900},{f:620,Q:130,g:0.62,d:760},
                  {f:1180,Q:140,g:0.40,d:600},{f:2260,Q:90,g:0.22,d:420}])   [LIVE]
           excited continuously by the tooth train at −14 dB, and left RINGING between strokes
kerf:      brown noise → lowpass fc = 260 + 180·cutDepth, Q 0.8 → gain −30 + 9·cutDepth
```

- **The push stroke cuts.** The return stroke does not: −9 dB, same tooth rate, bandpass dropped an
  octave to 950 Hz. The asymmetry is the entire rhythm of sawing and it is why a saw sounds like
  *work* and not like a machine.
- **The plate rings between strokes.** That singing steel is the signature, and it is the only
  sustained tonal element the player produces. Its decays are long enough (420–900 ms) that a
  1.1 Hz stroke rate never lets it fully die, so the saw builds a continuous ringing pedal under
  the noise. Once the player stops, it takes 900 ms to go away — and those 900 ms are audible to
  every camper in range.
- **The bind.** 12% of strokes: the tooth train **stops dead for 90 ms** and the plate mode rings
  alone. That is the blade fighting you. Model it flatly (§1.5). It is funny because it is
  physically accurate and because it costs the player time they do not have.
- **Dulling.** `STORY.md` says it dulls. Over the course of a night's cutting, ramp the tooth
  bandpass centre `1900 → 1400 Hz` and the tooth decay `6 → 11 ms`, and raise the kerf bed +4 dB.
  A dull saw is duller *and louder*, which is a small tragedy delivered entirely through a filter
  sweep across twenty minutes.

**Noise emission.** Per **C1**, interim: `noise:emit { kind:'hammer', radius: 34, intensity: 0.55 }`
once per push stroke — 1.1 emissions/second, sustained. This is the closest canonical kind and it
under-serves the mechanic by a factor of ~7 in area. When `saw` is added at radius 90, change one
row in §1.3 and one line in the emitter.

### 4.14 Canvas tent flapping — `LIVE`

Scheduled by `Weather`'s gust envelope: when `d(gust)/dt > 0.4`, fire 1–4 flaps 60–220 ms apart.

- WHUMP: white noise, 140 ms, lowpass sweeping `3200 → 380 Hz` over 120 ms, `Q = 1.8`,
  env `A 6 / D 130`, −22 dBFS@1m.
- BODY: sine 68 Hz, 60 ms, −20 dBFS@1m — the pole taking the load.
- SNAP (25%, high gust only): 2 ms noise burst highpassed at 3000, −12 dBFS@1m.
- **Guy-line hum** (rare, gust > 0.8): `modal({f: 190·rand(0.9,1.1), Q: 280, decay 1400 ms})` at
  −30 dBFS@1m. A tensioned line singing. Model it accurately and do not feature it; it is beautiful
  and it is not a moment.

### 4.15 Rain — `BAKED` grains, `LIVE` beds

Three surface models blended by listener position and what is overhead, driven by
`weather:change { rain }` in 0..1.

**Rain on leaves** — the default.
- BED `LIVE`: pink noise → bandpass `f = 1900, Q = 0.55` → highshelf `f = 7000, gain = −4` →
  gain `−34 + 22·rain` dBFS@1m.
- GRAIN `BAKED` (`rain_leaves.grain`): `grainTrain(rate = 30 + 420·rain, jitter = 1.0)`, each
  grain 4 ms noise → bandpass `f = 2600·rand(0.5, 1.8), Q = 2.4` → decay 12 ms, −20 dBFS@1m.
  Rate capped by `settings.tier(60, 140, 300, 450)` with the bed compensated so `low` still sounds
  like rain rather than like a smaller amount of rain.
- CANOPY `LIVE`: a very slow (0.08 Hz) random walk on the bed's bandpass between 1500 and 2400 Hz
  — rain moving through the trees in sheets. Free, and it is 80% of the realism.

**Rain on tin** (under the roof stage, near the shed)
- BED `LIVE`: pink noise → highpass `f = 1400` → bandpass `f = 4200, Q = 0.7` → `−30 + 24·rain`.
- GRAIN `BAKED` (`rain_tin.grain`): `grainTrain(rate = 50 + 700·rain)`, each grain
  `modal(impulse(0.4ms), [{f:3900·r,Q:130,g:1,d:35}, {f:6800·r,Q:100,g:0.5,d:22}])`,
  `r = rand(0.85, 1.2)`. **Pitched pings, not noise.** This is why tin rain is unmistakable.
- SHEET: routed through the tin comb (§3.3.4) at `sendT = 0.45`.
- **This is a gameplay gift.** `GAME_DESIGN.md` §3.3 gives rain a constant masking floor of
  `0.30 · rain`. The mix must make that legible by getting genuinely loud — the player should
  *feel* covered before they reason about it.

**Rain on water** (the lake, within 25 m of shore)
- BED `LIVE`: pink noise → lowpass `f = 900, Q = 0.7` → `−36 + 18·rain`. Dull, no top.
- PLINKS `BAKED` (`rain_water.plink`): `grainTrain(rate = 4 + 26·rain, jitter = 1.0)`. Each plink
  is the classic droplet model: a sine whose frequency **rises** `f0 → f0·1.18` over 9 ms then
  holds, env `A 1 / D 45` exp, `f0 = 900·rand(0.6, 2.2)`, −22 dBFS@1m. **The rising pitch is what
  makes it read as water and not as a bell.** Send 0.6 to `LAKE_EDGE`.

**And rain plays the mask** (§2.5.2) at `rate = 3 + 26·rain`, on `body`. On a heavy night the
player is inside a resonating porcelain plate being struck three dozen times a second. Nobody has
to be told what that means.

### 4.16 Wind through pines, and the whistle that stays put

The forest bed's spine. Three parallel bands plus a sizzle, all `LIVE` (four persistent noise
sources, four persistent filter chains — 14 nodes total, constructed once, never again):

```
src = PINK NOISE (shared buffer, 4 independent sources, random offsets)

band A: bandpass f=380,  Q=0.75  → gainA
band B: bandpass f=1150, Q=1.10  → gainB
band C: bandpass f=2700, Q=1.40  → gainC
sizzle: highpass f=5200 → bandpass f=7400, Q=0.6 → gainS
                                   ↓
                    sum → [gustLPF] → [windGain] → ambience
```

- `gainA/B/C/S` are each driven by an **independent** random walk: every 400–900 ms,
  `setTargetAtTime(base·(0.55 + 0.9·rand()), now, 0.35)`. **The independence is the whole trick.**
  Bands drifting against each other produce the endless, never-repeating breathing of a real
  treeline. One correlated envelope sounds like a fan and always will.
- `gustLPF`: lowpass tracking `Weather`'s gust envelope, `fc = 900 + 6500·gust`, `Q = 0.6`. Gusts
  open the top end — that is what makes a gust *arrive* rather than merely get louder.
- `windGain = −40 + 26·wind` dBFS@1m.
- Base weights at `wind = 0.5`: A `1.00`, B `0.62`, C `0.40`, S `0.16`. As `wind` rises, C and S
  rise faster (`^0.7` exponent) than A — **a hard wind is a hiss, a soft wind is a sigh.**
- **Directionality:** modulate the stereo balance of **band C only**, 0.05 Hz LFO, ±0.35. The high
  band is the most directional in reality, and this alone makes the wind move across the map.

#### 4.16.1 The pine whistle — a landmark, not a startle

v1.0: "Above `wind > 0.75`, add the pine whistle… retriggering every 4–9 s. **the first time a
player hears it they will think it is a voice.**"

That is a slot-machine scare, and §5.4 of this same document forbids it: "the cricket cut must be
causally honest… the moment they stop trusting it, it stops being scary." A trunk that sounds like
a voice on a timer teaches the player that the game lies.

**The whistle is one specific tree, at one fixed world position, every night.**

```
position:  a single dead pine at a seeded, fixed location on the ridge, published by Forest at
           world-gen and cached by AudioEngine at init. Same seed → same tree → same place, all
           seven nights.
recipe:    modal({f: 2410, Q: 340, decay 2.5 s}) excited by the local wind noise at −34 dBFS@1m
gate:      wind > 0.62 at that position; retrigger every 4–9 s while gated
```

Note the **rising** resonance exception: as a gust builds, `f_center` climbs `2380 → 2440` and
falls back. This is one of only two rising wood sounds in the game (§4.12.1) and it is the reason
it reads as *breath* rather than as strain.

**Why this is better.** The player will hear it on Night 1 from 90 m and it will frighten them.
They will hear it again on Night 2 from a different angle. Somewhere around Night 3 they will walk
to it, in the dark, and find a dead pine, and stop being afraid of it. From then on it is a
**landmark** — a fixed audible bearing in a forest with no map — and the horror becomes what the
player chooses to do with a landmark they now trust. That is a mechanic. A timer is not.

### 4.17 Thunder — the skill ceiling, made timeable

Three separate failures in v1.0, all fixed here.

#### 4.17.1 Distance and delay — from `Weather`, verbatim

`GAME_DESIGN.md` §3.3: `distance` is drawn from `rand.range(0.4, 4.2)` km and
`thunderDelay = distance_km · 2.9 s`.

**v1.0's "Near (< 400 m) — the crack" class was unreachable dead code.** `rand.range(0.4, 4.2)`
never returns less than 0.4. The most dramatic thunder class in the document could not fire.
**Deleted.** If a near strike is wanted, the request goes to the Director agent to widen
`Weather`'s range to `rand.range(0.05, 4.2)`; until then there is no near class and no code
pretending there is one.

**Delay uses `2.9 s/km`, not `d/343`.** v1.0 scheduled at `distanceMetres / 343`, which is 343 m/s
and disagrees with `Weather` by 60 ms at 4.2 km. Audio must be sample-accurate against the
mechanic, not against physics. Take the design's constant.

`AudioEngine` schedules thunder at `t_flash + 2.9 · distance_km` seconds. **Never fake this.** A
3 km strike is 8.7 s of silence (§8 S4) and that silence is free horror the player counts.

#### 4.17.2 The two classes

**Mid (0.4–2.0 km).** No crack — the crack belongs to strikes under ~0.4 km and there are none.
- Brown noise → lowpass `fc = 900·(400/d_m)^0.5` clamped [140, 700], `Q = 0.8`.
- **Duration: `2.5 + 3.5·(1 − distance_km/4.2)` seconds, verbatim from `GAME_DESIGN.md` §3.3.**
  v1.0 used `2.5 + d/500` with `d` in metres, giving 6.5 s at 2 km against the design's 4.33 s.
  A player timing hammer strikes to a 6.5 s sound inside a 4.33 s `maskLevel()` window gets caught
  on the last two taps of the ladder, every time, and it reads as the game cheating.
- Amplitude is a **multi-tap sequence**, not one envelope: 4–8 gain lumps at irregular intervals
  (0.2–1.4 s apart), each a `setTargetAtTime` up then down, overall decay `e^(−t/τ)`,
  `τ = duration/2.5`. Thunder rolls because different parts of the channel are at different
  distances. Model that literally and it sounds right.
- Peak **−11 LUFS(M)**, ≤ 900 ms above −14.

**Far (2.0–4.2 km).**
- Lowpass at **340 Hz** — *not* v1.0's 110 Hz. See §4.17.3.
- Plus a **sky-hiss layer**: pink noise → bandpass `f = 1100, Q = 0.5` → gain, with a 4.0 s attack
  and a 3.0 s release, peaking at −30 dBFS@1m. This is the band that actually does the masking.
- Duration by the same formula (6.0 s at 2 km falling to 2.5 s at 4.2 km); entirely lumps, no
  transient.
- Peak **−18 dBFS@1m**, not v1.0's −26.
- Routed **0.7 wet into `LAKE_EDGE`** in addition to its dry path — legal now that all four
  convolvers are resident (§3.3.1). Distant thunder is mostly reverb.

Both classes are 2D stereo with a manual pan matching the flash's bearing, `rolloffFactor` not
applicable (§3.1). Both use a `WaveShaper` on the leading lump with **`oversample: '4x'`**.

Every thunder also asks `Weather` for a **+40% gust arriving 1.5 s after the sound** — the
pressure wave. Audible through `gustLPF` (§4.16).

#### 4.17.3 The masking invariant — why far thunder got louder

`GAME_DESIGN.md` §3.3 ramps `maskLevel()` to **0.85 regardless of strike distance**. A 4 km strike
suppresses `NoiseSystem` exactly as hard as a 0.5 km strike. But v1.0 mixed far thunder at
**−26 dB through a 110 Hz lowpass** — a rumble with no energy above 110 Hz.

The thing being masked is a hammer tap (§4.4), whose energy sits at 186–1830 Hz (wood modes) and
3.1–3.8 kHz (nail modes). **A 110 Hz rumble masks none of it.** The AI would grant the player 85%
suppression while the player's ear told them, correctly, that they were completely exposed. That
is the exact shape of a mechanic players call cheating.

**The invariant, stated as a testable contract:**

> For the entire interval during which `Weather.maskLevel() > 0.5`, the thunder bed's loudness in
> the **500 Hz – 4 kHz** band must be at least equal to the loudness of a single `hammer` tap
> heard from **12 m**, measured in the same band.

`tools/loudness-check.mjs` (§11.1) asserts this on a scripted storm scene with a third-octave
analysis. The 340 Hz lowpass, the sky-hiss layer, and the −18 dBFS peak are the values that
satisfy it; if the band content changes, re-derive them rather than adjusting by ear.

#### 4.17.4 The window contract — the player must hear it open and close

`GAME_DESIGN.md` calls thunder masking "the skill ceiling." A skill ceiling you cannot perceive is
a lottery. v1.0 never mentioned `maskLevel()` at all.

`Weather`'s window: `maskLevel` ramps 0 → 0.85 over **0.4 s**, holds, then decays over **1.2 s**,
across a total envelope of `2.5 + 3.5·(1 − d/4.2)` seconds.

Audio's obligations, in both directions:

| Window event | Audible signal | Timing |
|---|---|---|
| **Open** | the **first lump's attack**, ramped over exactly **0.4 s** to match `maskLevel`'s ramp | at `t_flash + 2.9·d_km` |
| **Full** | the bed is at peak and stable | 0.4 s after open |
| **Close warning** | the **last lump's attack is placed exactly at `duration − 1.2 s`** — a final, distinctly louder swell whose only job is to say *this is the last one* | `duration − 1.2 s` |
| **Closed** | the last lump's decay crosses −30 dBFS | `duration` |

The last lump is not decorative. It is scheduled, deterministic, and always the loudest of the
trailing lumps, so the player learns within two storms that when thunder swells *one more time*,
they have 1.2 seconds of cover left. That is enough for one hammer tap at the ladder's tight end
(taps 5 and 6 are 203 and 99 ms apart) and not enough for two. **That is the skill ceiling,
expressed in audio.**

Deaf players get the same information through the caption ladder in §7.5.

#### 4.17.5 Photosensitivity

`settings.photosensitive` caps lightning to 1 flash per 12 s and "**compensates** by lengthening
thunder windows 1.4× so the masking mechanic is unharmed" (`GAME_DESIGN.md` §10.2). Audio must
scale the envelope, the lump spacing, and the close-warning position by the same 1.4×, from
`Weather`'s reported duration rather than recomputing it. **Never hard-code the 1.4.**

### 4.18 Campfire — `LIVE` bed, `BAKED` grains

The camp's audio landmark. Positioned, `refDistance 2.5`, `rolloffFactor 0.6`.

- BED `LIVE`: brown noise → lowpass `f = 520, Q = 0.7` → −30 dBFS@1m, random-walked ±3 dB every
  250 ms. The roar of combustion.
- CRACKLE `BAKED` (`fire.crackle`): Poisson `grainTrain(rate = 9, jitter = 1.0)`, grains
  `modal(impulse(0.6ms), [{f:2400·r,Q:26,g:1,d:14}, {f:5100·r,Q:18,g:0.4,d:8}])`,
  `r = rand(0.5, 2.2)`, −18 dBFS@1m.
- POP `BAKED` (`fire.pop`): 1 in 14 grains, adds `{f: 640·r, Q: 12, g: 1.2, d: 60}` and +7 dB; and
  within 8 m, a 90 ms ember hiss bandpassed at 3800 with a downward sweep, −26 dBFS@1m.
- RAIN HISS `LIVE`: at `rain > 0.3`, a continuous `f = 4600, Q = 0.6` bandpassed noise at
  `−34 + 10·rain` and the bed drops −4 dB. A fire in the rain is a different, sadder sound.
- **The clock.** `GAME_DESIGN.md` §6.3: "the camp's fires dying at 0.55." From `timeOfNight 0.50`
  ramp the bed −9 dB and the crackle rate `9 → 2` over 120 s. The camp's fires going out is one of
  the three diegetic clocks in the game and the player will read it before they can articulate it.

### 4.19 Zipper — the gameplay siren — `BAKED` grains

Tent doors: the sound that means someone is coming out.

`grainTrain(rate = 110 → 170 → 90 across the duration, jitter 0.15)` — the rate curve *is* the
hand speed. Each grain 1.5 ms noise → bandpass `f = 3400·rand(0.92, 1.08), Q = 6` → decay 7 ms.
Sum → bandpass `f = 2900, Q = 1.2` → a `modal` slider body at `{f: 1250, Q: 16, decay 40 ms}`
excited by the same train at −10 dB. Duration 400–900 ms. Ends with a hard stop and a single click
(§4.20's transient).

**This must be audible at 40 m through moderate rain.** `rolloffFactor 0.75`, +3 dB presence peak
at 3.2 kHz, priority 2, and it is exempt from grain-rate tiering — the `low` tier gets the full
rate, because this is information, not texture.

### 4.20 Flashlight click — `LIVE`

Two-part, 55 ms total, and it must be *crisp*: a camper's thumb on a switch is the most important
55 ms in the game.

- SWITCH TRANSIENT: 0.8 ms noise → bandpass `f = 3600, Q = 5.5` → decay 6 ms, −8 dBFS@1m.
- PLASTIC BODY: `modal([{f:1880,Q:34,g:1,d:38}, {f:3720,Q:28,g:0.5,d:26},
  {f:7100,Q:20,g:0.2,d:14}])`.
- SPRING: 12% chance of a `{f: 5400, Q: 180, decay 220 ms, gain 0.15}` ring.

Off-click is the same recipe at 0.94× frequency and −2 dB. **The player must be able to tell on
from off by ear**, because in fog the beam appearing is sometimes not visible and the click always
is. This 6% frequency difference is the smallest deliberate discrimination in the game; verify it
in playtest at 25 m through rain, not at 1 m in a quiet room.

The player's own lantern douse (`GAME_DESIGN.md` §4.4: "loud-ish click, `radius 5`") uses the
same recipe at 0.88× and emits `noise:emit { kind:'brush', radius: 5, intensity: 0.10 }` — the
nearest canonical kind to a small mechanical click at 5 m (see conflict **C4**; the same interim
applies).

---
### 4.21 Twig snap and `brush` — `LIVE`

#### 4.21.1 Twig snap

The player's most common mistake and therefore the sound they will most learn to fear. Fired by
`Physics` on a footfall over deadfall.

- 2 ms noise burst → highpass 2200 → −4 dBFS@1m.
- `modal([{f:920·r,Q:44,g:1,d:60}, {f:2140·r,Q:36,g:0.6,d:38}, {f:4900·r,Q:24,g:0.25,d:20}])`,
  `r = rand(0.7, 1.5)` — thickness variation.
- FIBRE TAIL: pink noise 130 ms, bandpass sweeping `3000 → 1100`, `Q = 2`, exp decay,
  −18 dBFS@1m.
- Small twig (`r > 1.2`): everything × 0.6, −6 dB. Big branch (`r < 0.85`): × 1.7, +4 dB, plus a
  74 Hz sine thump.

Emits `noise:emit { kind:'brush', radius: 6, intensity: 0.12 }` — the canonical row. v1.0 gave
twigs private radii of 22 m and 55 m at intensities of 0.20 and 0.48, none of which exist. A twig
snap is loud *to the player* and quiet *to the world*, and the 6 m radius is what makes the
game survivable.

#### 4.21.2 `brush` — the sound of being too big for this forest

`GAME_DESIGN.md` §5.1: "Capsule radius 0.42 m vs a typical 0.3 — you clip undergrowth constantly,
which emits `brush` noise. **You are too big for this forest.**" This is one of the six numbers the
design uses to communicate weight, and v1.0 gave it no sound at all.

```
LIVE, gated to capsule-vs-foliage contact, minimum 400 ms between emissions:
  grainTrain(rate = 30 + 120·speed, jitter = 1.0, dur = 260 + 600·speed ms)
  each grain: 3 ms pink noise → bandpass f = 3100·rand(0.6, 1.5), Q = 3.0 → decay 16 ms
  bed:  pink noise → bandpass f = 1400, Q = 0.8 → env A 30 / D (dur−30) → −30 dBFS@1m
  peak: −25.0 dBFS@1m  (§1.3, intensity 0.12)
```

Duration scales with speed because a body pushing through wet undergrowth keeps making noise for
as long as the branches are returning. At a sprint that is nearly a full second of rustle
*trailing behind the player*, which is exactly the tell `GAME_DESIGN.md` §11 t=0:34 relies on: the
branch rustles for 1.1 s and the distant counselor's torch stops moving for 2 s.

30% of `brush` events also strike the mask (§2.5.2).

### 4.22 The throw decoy

`GAME_DESIGN.md` §4.4: "**Throw a bracket** — costs 1 hardware item; arcs to a point;
`noise:emit { kind:'throw', radius:18, intensity:0.40 }` at impact. **The comedy: you are throwing
away the hardware you are already short of.**"

Three parts, and the ordering matters:

1. **Release** — on `body`, non-spatialized, −38 dBFS@1m: a 180 ms cloth swish, pink noise →
   bandpass `f = 1600, Q = 0.9` sweeping `1200 → 2200`, env `A 20 / D 160`. **No `noise:emit`.**
   The player needs to know the throw happened even in total darkness, and this is the only
   confirmation they get.
2. **Flight** — silence. A 1.2 kg bracket does not whistle. Do not add a whoosh.
3. **Impact** — the §4.6 bracket recipe against whatever surface it lands on, at the impact point,
   plus `noise:emit { kind:'throw', radius: 18, intensity: 0.40 }` **at the impact point, not at
   the player** (the design is explicit and it is the entire mechanic).

The gap between (1) and (3) is the arc time, typically 0.6–1.4 s, and it is dead silent. That gap
is the player listening for their own decoy to land, and it is the single most tense second of
voluntary silence the game offers.

### 4.23 Ladder, hoist, rigging — Night 5's improvisation

`STORY.md` §4 Night Five: the 4.8 m / 71 kg panel "physically cannot be seated by one man"; the
player improvises a counterweight and a lever from Dale's canoe, a rope, a stump, a ladder. "The
solution is ugly. **It is the first thing Ansel builds that his mother did not draw.**"

Every sound in this section must be *unrehearsed* — none of them belongs to the manual's clean
vocabulary, and that is the point.

**Ladder rung** (class B contact, per rung): `modal([{f:412,Q:22,g:1,d:110},
{f:1180,Q:18,g:0.5,d:70}, {f:2430,Q:14,g:0.22,d:40}])`, −20 dBFS@1m, plus a 12 ms boot scuff from
the wood material family. **Rails flex:** every 3rd rung, add `{f: 96, Q: 5, g: 0.4, d: 420}` — a
long, low, slightly sickening bend. `noise:emit { kind:'footstep', radius: 9, intensity: 0.18 }`
per rung.

Climbing at height on Night 5 also puts the player's own footsteps above every camper, so §3.1.1's
elevation shelf is at its maximum: the world below gets 2.7 dB darker while the player's own body
sounds unchanged. Nobody will name it. Everyone will feel exposed.

**Hoist rope over a limb**: `frictionOsc, slipRate 9 + 40·speed, N ∝ duration,
f_center 340·(1 + 0.6·load), Q = 22, pitchDrop 120 ¢`, plus a fibre bed (pink noise → bandpass
`f = 2100, Q = 1.1`, −30 dBFS@1m). Low `Q` — rope on bark does not ring. **The rope's pitch tracks
load**, so a player hauling the panel hears the tension rise and hears the moment it takes the
weight.

**Rope creak under static load**: `frictionOsc, slipRate 2.5, N = 4, f_center 280 → 250, Q = 60`,
every 3–7 s while loaded, −28 dBFS@1m. Four slow pops from something holding 71 kg. It is not a
`build:creak` and it must not be quantized as one; it emits nothing and means nothing mechanically.
It is just the sound of a bad idea working.

**Canoe as counterweight** (`STORY.md` §7.13 — "one gunwale crushed under a wall panel"): a hull
groan, `modal([{f:74,Q:9,g:1,d:900},{f:168,Q:12,g:0.6,d:700},{f:390,Q:8,g:0.3,d:500}])` excited by
a slow friction bed. Fibreglass and cedar are stiff and low-loss, so the decays are long. Under
final load, one 240 ms splintering `grainTrain(rate=40, jitter=1.0)` of wood ticks — **not** a
split (§4.8), because the canoe does not fail; it just stops being a canoe.

**The seat.** When the panel finally seats with `correct: true` for a join the manual never
specified (`STORY.md`: "the only time in the game"), play `join_seat` — the standard, perfect,
unmodified `join_seat` from §4.9. Same recipe, same +2 dB, same everything. **The game's reward
sound, given to something the manual did not ask for.** Do not annotate it. Do not add a variant.
The fact that it is identical is the entire meaning.

### 4.24 Shim, felt, tallow, digging

The quiet mitigations. `GAME_DESIGN.md` §3.3 marks the shim and the tallow "silent" — which means
*silent to campers*, not silent to the player. A mitigation with no sound is a mitigation the
player cannot confirm.

| Action | Sound | `noise:emit` |
|---|---|---|
| **Shim wedge** (2.5 s) | Three taps of a wooden wedge, `modal([{f:640,Q:18,g:1,d:60},{f:1490,Q:14,g:0.5,d:40}])` at t = 0, 380, 690 ms, −26 dBFS@1m, **each 3% higher in pitch than the last** (the wedge biting). Then a 90 ms `frictionOsc` settle. | **none** |
| **Tallow tin** (3.0 s) | Lid: a 40 ms steel scrape + a 120 ms `{f:1830,Q:70,d:300}` ring. Application: a 1.8 s `frictionOsc` at `slipRate 70, f_center 900 → 620, Q = 12` — **low Q, high slip rate**, which is a creak with the creak taken out of it. That is literally what grease does and it is legible as such. | **none** |
| **Felt pad** (4.0 s, N5+) | Compression: 400 ms of brown noise through a lowpass sweeping `800 → 220`, `Q = 0.8`, env `A 120 / D 280`, −30 dBFS@1m. Dull, soft, absorbing. Then **nothing** — the pad's whole job is that this join stops speaking. | **none** |
| **Digging** (pier footings, N1) | Per spade stroke, 1.4 s apart: bite (`brush` grain family at 1.5× rate, 180 ms), lift (a 90 ms low noise thud), throw (a 260 ms soil-scatter `grainTrain(rate=70, jitter=1.0)` of 4 ms bandpass-900 grains). | `{ kind:'brush', radius: 6, intensity: 0.12 }` per stroke |

**The tallow is a mix event as well as a sound.** For its 150 s of effect on joins within 3 m
(`GAME_DESIGN.md` §3.3, `lambda × 0.45`), those joins' creaks — when they do fire — are additionally
lowpassed at 1400 Hz and dropped 3 dB. The player hears the cabin talking *through a mouthful*,
and hears it come back when the tallow wears off, with no timer and no UI.

### 4.25 The clean universe — the manual's three words

Per conflict **C7**: there is exactly one non-diegetic timbre family and it has three members. All
three are on `sfxUI`: dry, mono, centred, distance-invariant, reverb send 0.00, never touched by
the mask chain, never occluded, never ducked by anything.

**Shared timbre.** A struck sine plus a triangle at the same frequency, mixed 1.0 : 0.22, env
`A 6 / D (dur − 6)` exponential, no noise component, no detune, no vibrato. It is the sound of a
tuning fork drawn by an architect. Nothing else in the game sounds like it because nothing else in
the game is *tidy*.

#### 4.25.1 `manual_tick` — the smallest word

One tone, `f = 2100 Hz`, 40 ms, **−22 dBFS@1m**. Used for:

- The pre-observation tell (§6.4), 1.2 s early.
- Menu navigation, at −30 dBFS@1m.
- Each line of the night-end card as it prints (§4.28.5), at −28 dBFS@1m.

#### 4.25.2 `hardware_chime` — "you found it"

`GAME_DESIGN.md` §2.5: "a single clean bell — a struck 2.1 kHz sine with 1.4 s decay." Verbatim:
one tone, `f = 2100 Hz`, decay **1400 ms**, −16 dBFS@1m, on `tool:found`.

This is the same pitch as `manual_tick` and thirty-five times its length. The tick is the manual
noticing; the chime is the manual *satisfied*. One family, two lengths.

**`hardware_tick` is a different sound entirely** (conflict **C6**) — see §4.28.1. It is diegetic,
positioned, occluded, and one character away in its id. The registry flags both.

#### 4.25.3 `stage_chime` — the one that rots

`build:stage-complete`, played alone into S6's mandated 1.4 s of silence.

Two tones, 140 ms each, the first always at **880.0 Hz**. v1.0 specified "always exactly −16 dB,
**always identical**" for seven nights. `STORY.md` requires the opposite: the manual is the audio's
only comedian and "**it stops being funny on Night Four**," and `Blueprint.js` exposes per-panel
`authorship: 'marit' | 'ansel'` precisely so the pages can stop being his mother's confident single
stroke and become his own doubled, over-corrected hand.

**The chime is the manual's voice. It is the one element that must carry that arc.**

`stage = clamp(floor(4 · anselPanelFraction), 0, 4)` from `Blueprint.stageAuthorship()` (§0.4).
Fallback night table, from `STORY.md` §3 ("By Night Five roughly a third of the panels are his. By
Night Six, most"): N1–3 → 0, N4 → 1, N5 → 2, N6 → 3, N7 → 4.

| Stage | Hand | Interval | `f2` (Hz) | Gap (ms) | Per-strike jitter on `f2` | Extra |
|---|---|---|---|---|---|---|
| **0** | Marit | 498 ¢ (4:3) | **1173.3** | 60 | **0 ¢ — identical every time** | — |
| 1 | Ansel | 520 ¢ | 1188.3 | 78 | ±40 ¢ | — |
| 2 | Ansel | 548 ¢ | 1207.7 | 86 | ±55 ¢ | — |
| 3 | Ansel | 578 ¢ | 1228.8 | 94 | ±70 ¢ | — |
| **4** | Ansel | **600 ¢ (tritone)** | **1244.5** | 104 | ±85 ¢ | second tone doubled by a **2 ms noise transient at −14 dB** |

Two axes, and they are different things. The **interval widens** because he is drawing the chime
himself now and he is drawing it wrong — a perfect fourth becoming a tritone across four stages.
The **jitter grows** because his hand is not steady, so the same panel does not produce the same
tone twice. By stage 4 the second tone is the reserved tritone (§6.1 — the interval that appears
nowhere else in the game until a camper has seen the player), it is unstable by nearly a
semitone, and it has a scratch on the front of it.

`stage_chime` is always **−16 dBFS@1m**. The level never changes. Only the tuning rots.

> **Nothing announces this. Nobody comments. No music. Do not add a variation cue, a filter sweep,
> or a "darker" reverb. If a playtester says "the chime sounds off tonight," that is the entire
> success condition, and if they cannot say why, it is a total success.**

### 4.26 The grab, the body, the water

`GAME_DESIGN.md` §8.3, from Night 3: "4.5 s of contact from behind an unaware camper, silent. It
solves the immediate problem and creates three new ones." v1.0 contained **zero** specification for
any of it — no contact, no drag, no water, no discovery. There is no kill in the slasher game.

**"Silent" means silent to campers.** It is not silent to the player, and the four movements below
are the closest this game comes to a set piece. There is no music in any of them.

#### 4.26.1 Movement 1 — contact, 0–180 ms

- Canvas on canvas (his coveralls against their jacket): brown noise → bandpass `f = 900, Q = 1.3`,
  env `A 8 / D 160`, −24 dBFS@1m.
- One hand: `modal([{f: 210, Q: 8, g: 1, d: 90}])`, 40 ms, dull.
- **No transient above 2 kHz.** A hand on a torso has no crack in it. Every instinct in sound
  design says to add a snap here. Do not.

#### 4.26.2 Movement 2 — the held silence, 180 ms – 3.6 s

**Ansel's breath does not change.** Whatever state it was in (§4.27.1) continues, on schedule, at
level, uninterrupted, for the entire 4.5 seconds. This is the rule and it is the whole scene.
`STORY.md` §2: "He never speaks. Not a grunt of exertion, not a roar."

The victim:

- **One aborted inhale at 260 ms.** A 180 ms pink-noise inhale, bandpass sweeping `700 → 1350 Hz`
  upward, that **stops at 180 ms** with an 11 ms glottal closure — the bandpass `Q` jumps
  `1.4 → 9` and the gain drops 22 dB in 11 ms, *not to zero*. −22 dBFS@1m.

  This is **synthesized on `sfxWorld`, not VO.** The review asked for a `GRAB` VO category from
  Night 3; that would have required lines this document does not own, and both `STORY.md` and
  `ARCHITECTURE.md` require the game to work with `public/audio/vo/` deleted. A kill that is silent
  in the default build is a broken kill.

  It is **the same closure model as Ansel's Night 7 breath catch** (§4.27.3), transposed up 7
  semitones and 14 dB quieter. Nobody will consciously notice. It is the only formal connection
  the game draws between what he does to them and what happens to him, and no VO line could have
  made it.
- **Boot scuffs, 400 ms – 3.4 s:** `grainTrain(rate = 6, jitter = 1.0, dur = 2900 ms)`,
  **decelerating**, of the surface's baked material layer at 0.4× gain.
  `noise:emit { kind:'brush', radius: 6, intensity: 0.12 }` every 0.5 s.

#### 4.26.3 Movements 3 and 4 — the give, and the settle

**3.6–4.1 s, the give.** The scuffs stop. One 90 ms cloth settle at −28 dBFS@1m. Nothing else.
**Do not duck. Do not impose silence.** The scene runs out of things to make and the bed is still
there. That is different from a silence rule and it must feel different.

**4.1–4.5 s, the settle.** The body reaching the ground:
- The surface's footstep IMPACT layer at 2.2× gain and **0.7× frequency** — a body is heavier and
  slower than a boot, and the frequency scaling is what encodes mass.
- A class-D `drop_lumber` sub layer at 0.6× gain.
- **No bounce.** §4.3's restitution model is deleted for this one case. Bodies do not bounce, and
  a designer who leaves the bounce in has made the worst possible sound in this game.
- `noise:emit { kind:'drop', radius: 26, intensity: 0.55 }` — the **class-C** row, not class-D,
  because a person settling onto duff from a held position is genuinely quieter than a 62 kg beam
  dropped on rock. The design's class-E carry rules govern the *drag*; the settle is its own event.

**And the heartbeat's first of its two appearances in the entire game** (§4.27.2): six beats,
starting 900 ms after the settle, 78 bpm, −24 dBFS@1m, `hbCutoff 200 Hz`. Then gone. Six beats,
not a loop, no fade. He is not frightened. He has just done something with his body.

#### 4.26.4 The body drag — a second friction layer, no wood

Class E, 2.6× noise, 0.34× speed (`GAME_DESIGN.md` §2.1). **`drag_lumber` (§4.3) is completely
wrong here** — it models wood on duff and its whole character is the sawn-wood modal bank. A body
has no modal bank.

```
bed:   brown noise → lowpass fc = 340 + 620·speed, Q 0.8 → −22 dBFS@1m
slip:  frictionOsc, slipRate = 5 + 22·speed, f_center = 520·(1 + 0.5·speed),
       Q = 26, pitchDrop 40 ¢          ← low Q on purpose: wet cloth on wet needles does not ring
grain: grainTrain(rate = 22 + 70·speed, jitter 1.0) of 5 ms bandpass-1400, Q 2 grains, −26 dBFS@1m
limb:  every 1.4–2.6 s, a heel or a hand catching — a 60 ms surface IMPACT at 0.5× gain, and the
       whole bed ducks −6 dB for 90 ms and returns
```

`noise:emit { kind:'drag', radius: 22, intensity: 0.38 }` every 0.5 s — the canonical row. The
design's "2.6× noise" for class E is already expressed in that row's numbers; do not multiply
again.

**The limb catch is the sound that makes it a person.** Everything else in the recipe could be a
tarp full of sand. A wet, irregular, unpredictable interruption every couple of seconds is what
the ear uses to decide otherwise, and it costs one scheduled envelope.

#### 4.26.5 The water

`GAME_DESIGN.md` §8.3 allows hiding a body "under the boathouse / in the lake / under the build."

**Entry, 0–400 ms:** a displacement — brown noise 260 ms through a lowpass at 420 Hz, plus the
`rain_water.plink` family at **6× count and 0.5× f0** (big, low plinks read as a large object),
plus a 0.8 send into `LAKE_EDGE`.
**Closing, 400 ms – 2.4 s:** a bandpass rising `300 → 900 Hz` over 900 ms on a pink bed at
−28 dBFS@1m, then a 1.5 s decay of individual laps against the shore.

**And the loon answers it.** 3.2 ± 0.9 s after entry, the tremolo variant (§5.3), from the far
shore at 380 m. **This is the only time in the game the loon's scream is caused by the player.**

A player who has learned the loon — and §5.3 makes it learnable by making it causal — will
understand instantly that something across the lake noticed the water. That is the entire argument
for defect 18's fix, delivered: a startle on a timer could never have meant anything, and this
means something specific and terrible.

**Under the boathouse / under the build:** the drag's reverb send switches to `CABIN_SHELL` at
0.55 for 900 ms and back. The space tells the player the body is inside something. No other cue.

#### 4.26.6 Body found — the crickets do not come back

`GAME_DESIGN.md` §8.1, rung 4: "+0.35, head counselor spawns with whistle, kids are recalled to
cabins (**fewer wanderers — the forest gets emptier and worse**)."

At the moment of discovery: **nothing from audio.** No sting, no duck, no music. The campers' own
VO carries it (`TED_EVID_01`, `MRG_EVID_02`) and if the VO folder is empty, the discovery is
completely silent, which is worse and is correct.

The consequence is §5.4's **condition 7**: from that moment, **the chorus does not return for the
rest of the night.**

This is a permanent violation of §5.4's duty-cycle invariant, and it is the one permitted
exception, stated explicitly so nobody "fixes" it: the invariant governs the chorus *as a sensor*.
Once it is permanently off, it has stopped being a sensor and become the state.

The player must be told, and told once, in the only honest way available: **the chorus attempts to
return.** Six seconds after the last camper leaves the discovery site, the staggered return begins
normally — three crickets come back over 1.4 s — and then they stop, and go out again over 2.0 s,
and that is the last cricket in the night. One failed return. Nothing else. That is the sound of
the forest being emptied and it costs one scheduling branch.

### 4.27 ANSEL — the three sounds that are him

`STORY.md` §2 is unambiguous: "He never speaks. Not a grunt of exertion, not a roar. **The loudest
sound he makes all game is the moment on Night Seven when his breath catches.** `AudioEngine`
should treat his breathing as a tracked emitter at all times so the absence of a voice is
*audible*."

Everything on the `body` bus: never spatialized, never reverbed, never occluded, inside his skull.

#### 4.27.1 Breathing — three states, and `HELD`

**Model.** One inhale plus one exhale per cycle.
- INHALE: pink noise → bandpass at `f_in`, `Q_in`, gain env `A 35% / D 65%` of the inhale
  duration, bandpass sweeping **upward** (air accelerating through the throat).
- EXHALE: pink noise → bandpass at `f_ex`, `Q_ex`, sweeping **downward**, fast attack and a long
  tail. Always ≈ 1.4× the inhale's duration and ≈ 2 dB quieter.
- `highshelf f = 6000, gain = −9` on both. Breath has no air on top; it has body.

| State | Period | Inhale | `f_in` sweep | `f_ex` sweep | `Q` | Gain (dBFS@1m) |
|---|---|---|---|---|---|---|
| `CALM` | 4.4 s | 1.1 s | 420 → 680 | 640 → 380 | 1.1 | −34 |
| `WALK` | 3.2 s | 0.9 s | 480 → 820 | 780 → 420 | 1.3 | −29 |
| `HEAVY` | 1.9 s | 0.6 s | 560 → 1150 | 1080 → 480 | 1.8 | −22 |
| `HELD` | — | — | — | — | — | silence (§2.4) |

**`FEAR` is deleted.** v1.0 had a fifth state — "2.4 s, irregular, triggered by
`state.suspicion > 0.45` or a camper within 10 m" — plus a heart running to 148 bpm. That makes a
6'6", 280 lb, thirty-five-year-old man frightened of a seventeen-year-old with a torch. It inverts
the premise of the entire game, and *muffled world plus pounding heart* is the single most generic
move available in horror audio.

**The tension is carried by the world going quiet around a man who does not react.** That is what
§2.4 does now, it is scarier, and it is specific to this game and no other.

Rules:
- **`HEAVY` adds a voiced component** and only this: a 108 Hz sawtooth through a lowpass at 700 Hz,
  −34 dBFS@1m, **on the exhale only**. He is a big man and you hear the weight in his chest.
  **Never make it a grunt.** He does not perform effort; he is simply heavy. The difference between
  those two is the difference between this game and every other slasher game.
- **`HEAVY` emits.** `GAME_DESIGN.md` §5.2: "above 60% stamina drain… your own breathing is an
  emitted noise. Campers at < 5 m can hear it." Interim per conflict **C4**:
  `noise:emit { kind:'brush', radius: 6, intensity: 0.12 }` once per exhale while `HEAVY`.
- Transitions crossfade over one full cycle. **Never cut mid-breath.**
- Under the mask (always — §2.5), the breath additionally gets +6 dB at **620 Hz** (the eyehole
  ports, not v1.0's invented 680 Hz shell resonance) and −8 dB above 4 kHz. Wearing the mask makes
  the player sound, to himself, like he is inside a plate. He always has been.

#### 4.27.2 The heartbeat — twice, in the whole game

On `body`. Two thumps per beat: `lub` at t = 0, `dub` at `t = 0.30·period`, dub at −5 dB.
Each thump: a sine from 56 → 38 Hz over 90 ms (`exponentialRampToValueAtTime`), env `A 6 / D 110`;
plus 45 ms of brown noise through a lowpass at `hbCutoff = 200 Hz`, at −10 dB relative to the sub.

**It exists exactly twice:**

1. **The first grab** (§4.26.3) — six beats, 78 bpm, −24 dBFS@1m. The *first* one only; subsequent
   grabs have no heartbeat at all, for the rest of the run.
2. **The Night 7 breath catch** (§4.27.3) — four beats, 64 bpm, −26 dBFS@1m.

Ten beats in a seven-night game. That is the entire budget and it is not negotiable. A heartbeat
that appears whenever tension rises is wallpaper by Night 2 and means nothing by Night 4. A
heartbeat that appears twice is an event both times, and the second one lands because of the
first.

Do not add a heartbeat to: the chase phase, the held breath, tier-4 creaks, the cascade, the
Ranger's headlights, or any ending. `Music.js` provides the "critical detection" cue that
`GAME_DESIGN.md` §4.1 asks for — "a single low heartbeat-rate string tone from `Music.js`" — and
that is a *string tone at heartbeat rate*, not a heartbeat. Do not conflate them; do not let them
play together.

#### 4.27.3 The Night 7 breath catch — the loudest sound he makes

On `story:beat { id: 'n7_final' }`, at the moment the player first opens the manual to the blank
spread (`STORY.md` §8: "The player opens the manual. The wipe animation plays. The pages are
blank.").

```
An inhale that begins as CALM: 1100 ms, bandpass 420 → 680 Hz, Q 1.1

at t = 240 ms:  IT STOPS.
                Q ramps 1.1 → 9.0 over 40 ms
                gain drops 22 dB over 18 ms — to −22 dB relative, NOT to zero
                hold 380 ms.  The bandpass does not move. Nothing else plays.

at t = 660 ms:  the inhale resumes at 0.55× its original rate and completes at t = 1520 ms
                peak −18 dBFS@1m — 16 dB above CALM, the loudest body-bus event in the game
```

Then the heartbeat's second and last appearance: four beats, 64 bpm, starting 300 ms after the
catch. Then nothing.

**The next breath is `CALM` and exactly on schedule.** No music. No duck of anything, because
nothing else is playing. No `noise:emit`. No caption beyond §7.5's, which reads simply
`[breath]` — the only caption in the game with no direction and no distance, because it is not in
the world.

This is the same closure model as the victim's aborted inhale (§4.26.2), 7 semitones lower and
14 dB louder. It took seven nights to arrive.

#### 4.27.4 The hand-wipe — two strokes, and the timing never changes

`STORY.md` §2: "**Before he touches the manual, he wipes his hands on his thighs.** Every single
time. Two strokes, palms flat, unhurried — the way you'd dry your hands before picking up a baby…
On Night Four he does it when they are covered in Dale Pruitt, **and the animation does not
change, and the timing does not change, and that is the most frightening second in the game,
because the priority is not the blood, the priority is *the paper*.**"

A mandatory 0.9 s lockout on `ui:blueprint-open` from Night One, never skippable. The player pays
it roughly ninety times so that one instance can pay off. It is pure foley and v1.0 did not have
it.

**Dry canvas** (the baseline, all nights):
```
Two strokes, at t = 0 and t = 430 ms. Each stroke 260 ms.
  brown noise → bandpass f sweeping 1250 → 900 Hz across the stroke, Q = 1.1
  env A 40 / D 220
  −30 dBFS@1m
```
The bandpass falling across each stroke is the palm decelerating. Two strokes, not three, not one.

**Wet canvas** (`rain > 0.25`, or within 40 s of wading):
```
Same timing. Same two strokes. Same 260 ms.
  + a second layer: pink noise → bandpass f = 2400, Q = 1.6, −26 dBFS@1m
    with grainTrain(rate = 55, jitter 0.7) of 2 ms bandpass-3200 grains at −32 dBFS@1m
    (water in the weave)
```

**Night Four onward, if `state.storyFlags.firstBlood` — tacky:**
```
Same timing.  Same two strokes.  Same 260 ms.  Same envelope.  Same peak level.
  + 3–5 discrete micro-releases per stroke:
    grainTrain(rate = 14, jitter = 0.8, dur = 240 ms) of 3 ms bandpass-1600, Q = 2.4 grains
    at −24 dBFS@1m
```

> **The envelope does not change. The count does not change. The duration does not change. The
> level does not change. The interval between strokes does not change. Do not duck the bed. Do
> not add music. Do not slow it down. Do not add a swallow, a hesitation, or a breath.**
>
> **Three to five very small sounds of something slightly adhesive letting go of canvas are added,
> and nothing else in the entire mix acknowledges them.**

That is the whole design. Every instinct will be to sell it. Selling it destroys it, because the
horror is precisely that *he did not treat it as different*.

The wipe emits **nothing**. It is on `body`, it is 0.9 s, it is quiet, and making it a stealth
liability would turn `STORY.md`'s best moment into a tax.

#### 4.27.5 The tool roll — characterization by absence

`STORY.md` §2: "A leather tool roll on the right hip, rolled and tied — **never loose, never
rattling.**"

**The direction is that the tool roll has no sound**, and that this is deliberate rather than
missing. Every game in this genre rattles the protagonist's kit on every sprint, every landing,
every crouch. Ours does not, because he tied it, because he ties it every night, because that is
who he is.

Total silence would read as an unfinished feature to anyone auditing the mix. So the roll makes
exactly one sound, and it is below conscious threshold:

- **Every 4th footstep while sprinting only:** a single 0.7 ms leather compression tick,
  `modal([{f: 640, Q: 6, g: 1, d: 22}])`, at **−52 dBFS@1m**, on `body`. Present in a
  spectrogram, absent in the room. No `noise:emit`.

**And it speaks exactly once.** When the handsaw first comes out (§4.13), the roll is *opened*:

```
0–180 ms:    the tie — a 160 ms waxed-cotton friction pull, frictionOsc slipRate 40, N = 6,
             f_center 1900 → 1500, Q = 18, −28 dBFS@1m
180–760 ms:  the unroll — grainTrain(rate = 22, jitter 0.9, dur 580 ms) of 8 ms leather-creak
             grains (bandpass f = 520·rand(0.8,1.3), Q = 5), −26 dBFS@1m
760–1100 ms: the flap falling open, and the tools settling into their stitched pockets —
             four small steel contacts at 790, 860, 940, 1010 ms, modal([{f:2100·r,Q:60,g:1,d:80}]),
             r = rand(0.9, 1.15), −30 dBFS@1m
```

Four contacts, because `STORY.md` §7.5 says the tools are "laid in descending size, each in its
own stitched pocket, a gap where the handsaw goes." **There is no rattle even here.** Four
separate, deliberate, individually audible placements. The roll is opened once in the game and it
sounds like a man who knows where everything is.

### 4.28 Remaining world sounds

#### 4.28.1 `hardware_tick` — the missing part, calling

`GAME_DESIGN.md` §2.5, hint layer 2: "t = 90 s after `tool:missing`. `AudioEngine` begins a
**1.8 s periodic metallic tick** at the item's position, attenuated normally by distance and
occlusion — audible from ~35 m. **Diegetically it is wind moving metal.**"

```
Every 1.8 s ± 0.25 s jitter, at the item's world position, on sfxWorld, fully spatialized,
fully occluded (§3.2), reverb send 0.22:
  modal(impulse(0.6ms), [{f: 3180·r, Q: 190, g: 1.00, d: 210},
                         {f: 5420·r, Q: 150, g: 0.42, d: 140}]),  r = rand(0.97, 1.03)
  gain: −34 dBFS@1m  → audible to ≈ 36 m at rolloff 1.15. Matches the design's "~35 m".
  gate: amplitude × (0.35 + 0.9·wind) — it is wind moving metal, so in dead calm it nearly stops
```

The wind gate is the honesty clause. On Night 6 (`wind 0.2`, `GAME_DESIGN.md` §7 — "clearing:
low masking, high visibility. **The scariest night**") the hint is nearly inaudible, and that is
correct: the night that takes away your masking also takes away your hint, and it does so through
a mechanism the player can reason about.

**Not to be confused with `hardware_chime` (§4.25.2)** — see conflict **C6**. Different bus,
different bank, opposite diegesis, one character apart in the id. Registry flags both rows.

#### 4.28.2 `camper_whistle` — the loudest camper event

`noise:emit { kind:'whistle', radius: 90, intensity: 0.90 }`, peak **−4.0 dBFS@1m**.
A 1984 pea whistle, not a pealess Fox 40:

```
two chambers:  sine + a small square component at f = 3150 and f = 4180 Hz, mixed 1.0 : 0.72
the pea:       a 22–34 Hz random-rate AM on BOTH tones, depth 0.70, rate re-randomized every 80 ms
               ← this is what makes a whistle a whistle and not a sine
breath bed:    pink noise → bandpass f = 3600, Q = 1.1 → −16 dB relative
env:           A 12 ms / S 500–1100 ms / R 90 ms
rolloff:       0.85 (VO class — it must carry)
bleed floor:   −24 dB, the §3.2.4 exception
```

Fired by the head counselor (Night 5+) on Alerted, and by any camper in Panic every 3 s
(`GAME_DESIGN.md` §4.3). It is the sound of the night ending and it must never be ambiguous.

#### 4.28.3 The `voice` emission

`GAME_DESIGN.md` §4.2 lists `voice` at `radius 26, intensity 0.30`, "used for player awareness,
campers ignore." v1.0 never emitted it, which meant camper conversation was invisible to
`directionalAudioIndicator` and to any future system reading the noise bus.

**`VoiceBank` emits `noise:emit { kind:'voice', radius: 26, intensity: 0.30 }` at the speaker's
position at the start of every line**, including `CHATTER_BED` takes, and including when
`VoiceBank.available === false` (the non-verbal fallback in §9.7 still emits it). See conflict
**C5** for the 26 m / 40 m disagreement with the accessibility spec.

#### 4.28.4 The endings

**`ending_a` — "RETURN TO STORE."** `STORY.md` §8: the manual draws a red diagonal across the
panel. "The only red mark ever aimed at the player. The only judgement the manual has ever
passed."

This is the only time the clean universe makes a sound that is not a tick or a chime:

```
One 2400 ms stroke, on sfxUI, dry, mono, centred:
  grainTrain(rate = 340, jitter = 0.50, dur = 2400 ms) of 0.8 ms noise grains
  → bandpass f = 4200, Q = 3.0 → decay 5 ms
  −30 dBFS@1m
  THE RATE IS STEADY. No accelerando, no decelerando, no pressure curve.
```

A confident, even, unhurried stroke, drawn by a hand that has already decided. Then **every bus
hard-mutes for 6.0 s.** Nothing else. `ending_a` is the only ending with no music of any kind.

**`ending_b` — "DO NOT FORCE."** The camera holds on the house from the treeline for ninety
seconds while the sky greys. Full ambience. No music.

**The `body` bus is muted for the entire ninety seconds** — the first and only time in the game.
No breath. He has walked away, and the player is no longer inside him. That absence is the whole
ending and it is achieved with one gain node.

S11's pre-dawn ramp (§8) runs across the full 90 s. One white-throated sparrow. Then silence,
then the card.

**`ending_c` — "SOME ASSEMBLY REQUIRED."** The ending. Four events, in order:

1. **The mask comes off.** The mask chain (§2.5) crossfades **out** over 2800 ms — its only
   transition in the entire game. The 620 Hz port peak vanishes; the 3400 Hz lowpass opens; the
   plate stops ringing. **The world does not get louder. It gets clear.** The player has been
   listening through a piece of a kitchen sink for seven nights and finds out by having it taken
   away. Immediately after, one last excitation of the plate modes at −20 dBFS@1m as it is set on
   the table — heard *unmasked*, the only time the plate is ever heard from the outside.
2. **The house is silent.** `STORY.md` §8: "The floor does not creak anywhere — the player has
   spent seven nights learning what a creak means, and **its total absence is more frightening
   than any sound the game has made.**" Enforced: `lambda = 0` on every join, and `AudioEngine`
   additionally hard-gates all `creak_*` factories for the remainder of the scene, so that a
   floating-point accident cannot ruin the ending.
3. **The bus at 6:15, through the north wall.** Heard through the §3.2 chain at exactly **one
   sheathed-wall thickness (T = 1.20 → fc 9.3 kHz, direct −3.8 dB, bleed −15.3 dB)** — that is,
   barely occluded at all, because he built the wall correctly, and `STORY.md` says so in as many
   words: "You can hear it through the wall, because he built the wall correctly, and a correctly
   built wall carries sound from a road exactly this way." A diesel idle (`modal` at
   `[{f:31,Q:6},{f:62,Q:8},{f:124,Q:7},{f:248,Q:5}]`, brown-noise excited, 2.4 Hz AM), an air
   brake, a door. Then children. A lot of them. Screaming the good way — `CHATTER_BED` takes
   layered at 8 voices, `rolloffFactor 0.6`, from 190 m, bright and completely happy.
4. **The last panel.** Over black: **one `stage_chime` in Marit's tuning** — 880.0 and 1173.3 Hz,
   60 ms gap, zero jitter, exact. It is the first time it has been in tune since Night Three.

Nothing else. Fade. Achievement: **"NO PARTS REMAINING."**

#### 4.28.5 Menus, cards, pages, toasts, and `crate_settle`

**`crate_settle`** — `GAME_DESIGN.md` §11, t = 0:00 of Night 1, over black, the first sound in the
game before any bed exists: `modal([{f:118,Q:16,g:1,d:340},{f:274,Q:22,g:0.55,d:260},
{f:610,Q:18,g:0.28,d:180}])` excited by a 3 ms burst lowpassed at 1400, plus a 40 ms needle-material
grain layer, −18 dBFS@1m, on `sfxWorld`, reverb send 0.30 into `OPEN_FOREST`. A wooden crate
settling under its own weight in a forest that is not yet audible. Then S1's 2.2 s of silence.

**The page turn.** `GAME_DESIGN.md` §11, t = 3:50: "The manual turns its own page **with a paper
sound.**" v1.0 specified exactly one UI sound in 1,310 lines, in a document whose thesis is that
the manual is the comedian.

```
On sfxUI, dry, mono, centred, −26 dBFS@1m, 420 ms:
  0–90 ms    the lift: grainTrain(rate = 90, jitter 0.6, dur 90 ms) of 1.5 ms
             bandpass-2600, Q = 2 grains, rising in rate
  90–300 ms  the arc: pink noise → bandpass f sweeping 3400 → 1900 Hz, Q = 1.4,
             env A 20 / D 190 — the sheet passing through air
  300–420 ms the fall and set: a 2 ms 3800 Hz tick, then a 110 ms brown-noise bed
             lowpassed at 700 (the page meeting the page below it)
```

Oilcloth-wallet variant (the manual coming out of his coveralls, `STORY.md` §2): the same recipe
lowpassed at 2200 with a 90 ms waxed-cloth `frictionOsc` prepended.

**`ui:toast` has no sound. Ever.** `GAME_DESIGN.md` §2.5's reward — "an empty checkbox filling in,
with no words" — is already accompanied by `hardware_chime` on the same event; adding a toast
sound would double it. §11's `ui:toast { icon:'hand' }` at t = 0:41 is silent and must stay
silent, because the whole design of the first five minutes is that nothing tells you anything.

**The rule:** the UI makes sound on exactly three verbs — `tool:found` (§4.25.2),
`build:stage-complete` (§4.25.3), and menu navigation (§4.25.1). Nothing else on `sfxUI` makes a
sound, including toasts, subtitles, hints, objective changes, and inventory.

**The night-end card** (`night:complete`, rendered by `Menu.js`): all buses ramp to −34 dB over
260 ms. **Not silence** — the world is still out there, it is just behind a piece of paper. Then
each line of the card prints with one `manual_tick` at −28 dBFS@1m, 90 ms apart, in order. The
`CUSTOMER SATISFACTION` line gets the night's `stage_chime` (§4.25.3, at whatever stage of rot the
manual has reached).

Three exceptions, all of them jokes told with a straight face:

- At `satisfaction ≤ 20` (`PLEASE RETAIN THIS DOCUMENT FOR YOUR RECORDS.`): **the chime does not
  play.** The satisfaction line prints with an ordinary tick like every other line and nothing
  acknowledges it.
- At `satisfaction ≥ 95` (`PERFECT. WE HAVE NOTHING TO ADD.`): the chime plays, and then a second
  `manual_tick` 300 ms later, alone. The manual has nothing to add and adds it anyway.
- At kill count > 0, the final red line — `PLEASE ASSEMBLE ALONE.` — prints **with no tick at
  all**, in total silence, 1.4 s after the previous line. **It is the only line the clean universe
  refuses to speak.**

**Title screen and menus.** The context is created `suspended` (§9.7), so the title screen is
silent and says so by being silent. After `resume()`: one `crate_settle`, then `THE STRING` at D1
(§6.2) once every 40–90 s and nothing else. No pad, no bed, no wind. Navigation is
`manual_tick` at −30 dBFS@1m; there is no confirm sound, no back sound, and no hover sound.

---

## 5. Ambience

`AudioEngine` maintains an `AmbienceDirector` that owns the bed. All of it on the `ambience` bus,
all of it carrying the −4 dB peaking notch at 3.1 kHz (§1.2), all of it obeying §8.

### 5.1 The bed

Three always-on layers:

1. **Wind through pines** (§4.16) — the spine.
2. **Room tone** — brown noise → lowpass `f = 180, Q = 0.6` → −44 dBFS@1m. Inaudible in isolation;
   its absence is audible. Present in *every* state except S7 (`night:failed`) and `ending_a`.
3. **Distance layer** — pink noise → bandpass `f = 620, Q = 0.4` → 0.55 wet into `OPEN_FOREST` →
   −42 dBFS@1m. The sound of a very large amount of air. This is what makes the forest feel like it
   extends past the draw distance, and at 640 × 520 m (§3.0) it needs to.

### 5.2 Crickets — four panners, one bed, and the arithmetic that was missing

The most important ambient element in the game, because it is the one we take away.

#### 5.2.1 The chirp — `BAKED` (`cricket.chirp`)

```
A chirp = 4–5 pulses.
Pulse: two detuned sines at f0 and f0·1.004, f0 = 4600·rand(0.92, 1.12)
       + a third partial at 2·f0 at −11 dB   (crickets are not pure)
       env: A 2 ms / hold (pulseDur − 5) / D 3 ms  — near-square; this is a stridulation
       pulseDur = 14 ms · rand(0.85, 1.2)
       gap = 15 ms · rand(0.9, 1.15)
Whole chirp → bandpass f = f0, Q = 6  (the wing's own resonance)
Chirp gain: −38 dBFS@1m
```

#### 5.2.2 The voice budget — v1.0 was arithmetically impossible

v1.0 asked for `settings.tier(8, 18, 34, 48)` **cricket instances**, each on its own panner,
against a §9.1 budget of **56 3D panners at `ultra`**. Crickets took 48 of 56, leaving **8** for
every camper, all VO (4 alone), all footsteps (6 alone), every build SFX, the campfire, the loon,
the owl, the rain, the zipper, the flashlight, and the lantern. Flat contradiction, in the same
document, two sections apart.

**The new structure:**

| Element | Panners | Detail |
|---|---|---|
| Near chorus | **4 total** | one shared `PannerNode` per 90° quadrant, at 18 m on the quadrant bisector, `rolloffFactor 0.40`. Individual chirps are scheduled into whichever quadrant panner matches their notional bearing. |
| **The distant bed** | **0** (stereo, unpanned) | bandpassed noise at 4.6 kHz, `Q = 1.1`, with a 12 Hz AM at depth 0.35, −40 dBFS@1m, plus a 0.06 Hz random walk on the AM depth |
| Total | **4** | down from 48 |

Chirp *instances* (scheduling slots, not panners) remain `settings.tier(8, 18, 34, 48)`; they cost
one pooled `AudioBufferSourceNode` each and share four panners. The perceptual loss from four
quadrant panners versus forty-eight point sources is close to nil: a cricket chorus is a diffuse
field, and the ear localizes it by quadrant at best.

#### 5.2.3 Temperature — Dolbear, and the floor

Dolbear's Law: `chirpsPerMinute = 4·(T_F − 50) + 40`.
`T_F = 68 − 13·timeOfNight` (Night 1) falling to `T_F = 58 − 15·timeOfNight` by Night 7.

So Night 1 opens at ≈ 112 chirps/min and reaches ≈ 60 by dawn; Night 7 opens at 72 and reaches
**12/min** — one chirp every five seconds.

This single formula does more atmospheric work than any number of extra layers: the forest gets
slower and lonelier as the week goes on and nobody will consciously notice why. Rain drops `T_F`
by 4 and cuts the chorus size 40%.

**But at 12/min the chorus cannot function as a sensor** — you cannot perceive the removal of a
sound that only happens every five seconds. The review proposed flooring Night 7 at 55/min inside
20 m, which would flatten the cold arc that is doing all this work.

**The actual fix is architectural: the sensor is the distant bed, not the chirps.** The bed
(§5.2.2) is continuous. Its removal is perceptible at any chirp rate, on any night, in any
weather. Dolbear is then free to take the discrete chirps all the way down to 12/min without
touching the mechanic.

A gentler floor is still applied for texture: **40 chirps/min minimum within 20 m**, regardless of
Dolbear. Night 7 is cold and lonely; it is not a vacuum.

### 5.3 Loon, owl, camp radio

#### 5.3.1 The loon — ambient wail, causal scream

`STORY.md` §4 Night One: "a wrong join groans like a bad chair **and a loon answers it from across
the water.**" The loon is written into the story as a *responder*. v1.0 fired it "every 40–120 s"
and noted of its scream variant that "players will jump" — which is the design goal of a haunted
house, not of this game, and it directly violates §5.4's own doctrine.

**Split by variant, because they are two different objects:**

| Variant | Trigger | Why |
|---|---|---|
| **The wail** | ambient, every 40–120 s, from the far shore (380 m, bearing 118°, §3.0) | It never reads as a scream. It is a landmark and a bearing and a beautiful lonely sound, and removing it would cost the lake its identity. |
| **The tremolo** | **causal only** | It reads as a scream. It must be earned. |

**The wail:**
- Fundamental glide: sine `460 → 880 → 810 Hz` over 1.6 s (up fast, down slow).
- Harmonics 2, 3, 4 at −7, −13, −20 dB, all tracking.
- Formant: bandpass `f = 1250, Q = 2.2` on the sum, +4 dB.
- Env `A 180 / S 1200 / R 400`, exponential. 0.85 wet into `LAKE_EDGE`.

**The tremolo** — the same glide split into three rising steps, plus AM at **11.5 Hz**, depth
0.45. Fires **only** on:

1. A `build:creak` of tier ≥ 3 **on Night 1 only** (the scripted `STORY.md` beat: the bad chair
   and the answer).
2. A canoe disturbed at the dock.
3. The player wading into the lake.
4. **A body entering the water** (§4.26.5), 3.2 ± 0.9 s after entry.

Cap: **twice per night.** Never on a timer. A player who learns the loon learns a fact about the
world — *something is watching the water* — and by Night 5 they can deliberately cause it. That is
a mechanic. A slot machine is not.

#### 5.3.2 The owl

A barred owl in the trees behind the build site, every 90–240 s. Four hoots at
`[0, 340, 900, 1450] ms`, each 220 ms: sine at `f = 340 Hz` with harmonics 2 (−9 dB) and 3
(−17 dB), 6 Hz vibrato at ±14 ¢, through bandpass `f = 700, Q = 1.4`, env `A 40 / S 120 / R 60`.
The final hoot glides `340 → 260 Hz`. −30 dBFS@1m, 0.5 wet into `DENSE_TREES`.

**The owl stops when the chorus stops, and it does not return for the rest of the night.** It is a
second, slower, less reliable confirmation of the same fact, and its non-return is the difference
between "something walked past" and "something is still here."

#### 5.3.3 The camp radio — the clock

A transistor radio at the mess hall, 1984. `Music.js` generates a short, cheap, cheerful AM-pop
loop (four chords, I–V–vi–IV in F, a drum machine, a saccharine synth-brass lead), then the
transmission chain destroys it:

```
signal → bandpass f=1400, Q=0.9              (a 4-inch paper cone in a plastic box)
       → highpass f=520                      (no bass exists)
       → WaveShaper (soft clip, drive 2.4, oversample '4x')   (the amp is always overdriven)
       → peaking f=2900, Q=2.5, +6 dB         (the honk)
       → lowpass f=4800
       → highpass f=18, Q=0.7                 (DC blocker, §9.2 rule 7)
       → + AM hiss: pink → bandpass 1600, Q 0.7 → −32 dB
       → + drift: a 0.07 Hz random walk on output gain, ±5 dB
       → mono → panner at the mess hall (140 m, bearing 042°, §3.0)
```

Every 30–90 s the drift dips hard (−14 dB for 2 s) and comes back. Once a night it drops out
entirely for 8 s.

**The radio is a clock.** It goes off at `timeOfNight 0.55` — lights out, and the same moment the
camp's fires start dying (§4.18) — with a single loud click. The silence after it is one of the
three best moments in this design.

**It is also tuned wrong on purpose.** The radio is at A = 440; the score (§6.1) is at A = 436.
When both are audible they beat at roughly 1.6 Hz in the upper register. That is intentional and
it is horrible, and it is why the mess hall is a place the player does not want to linger.

### 5.4 When the chorus stops

**The rule:** the chorus is a proximity sensor with a radius that the player learns, and it is the
entire stealth UI, and it is diegetic.

Fade the **distant bed and all four quadrant chorus panners** to silence over **350 ms**
(`setTargetAtTime`, τ = 0.11) whenever any of these is true:

| # | Condition | Depth | Notes |
|---|---|---|---|
| 1 | Any camper within **14 m** of the player, regardless of awareness | full | **hysteresis: returns at 19 m**, never at 14 |
| 2 | Any camper within 6 m of the player's last noise **and actively searching** | full | |
| 3 | A `build:creak` of tier ≥ 2 in the last 4 s | 40% for tier 2, full for tiers 3–4 | **subject to suppression, below** |
| 4 | `state.suspicion > 0.7` | full | |
| 5 | Lightning flash | full, until 2 s after the thunder | |
| 6 | `phase === 'chase'` | full | |
| 7 | **A body has been found this night** (§4.26.6) | full, **permanent** | the one permitted exception to the invariant |

**Return: 6.0 s** after the last condition clears, **staggered** — crickets come back one at a
time over 4 s, nearest last. A forest does not switch back on. That staggered return is the exhale
of the whole game and it must never be a single fade-up.

#### 5.4.1 The camp exclusion volume

A permanent cylinder of radius 55 m around the camp centre in which condition 1 does not apply.
Without it, a player working near the mess hall on a Tier-3 run has the sensor pinned off by
campers who live there, and the mechanic silently stops existing in exactly the place it is most
needed. Inside the volume the chorus is simply thinner (chorus size × 0.45) and conditions 2–7
still apply normally.

#### 5.4.2 The duty-cycle invariant

v1.0 never computed how often the sensor would actually be off. The arithmetic is alarming.

Night 5: five campers plus a head counselor, a storm with six strikes (a flash every 25–60 s,
each holding the chorus off for its full 2.5–12.2 s thunder delay plus 2 s), `lambda` reaching
~6 creaks/minute across a badly-built cabin, and a `creakDebt > 1.2` cascade firing 3–5 creaks in
1.5 s. Creaks alone at 6/min × 4 s = **40% of every minute**. Lightning on Night 6 adds
20–40% more. **By Night 5 the chorus is off more than on, and §1.4's entire habituation thesis
collapses.**

**The invariant, enforced in `AmbienceDirector`:**

> **The chorus must be audible for ≥ 70% of any rolling 60-second window.**

`AmbienceDirector` tracks the predicted duty cycle over a 60 s ring buffer. When the projection
falls below 70%, **condition 3 (creaks) is suppressed** — creak-triggered cuts are skipped
entirely, in priority order: tier-2 dips first, then tier-3/4 cuts. Conditions 1, 2, 4, 5, 6 and 7
are **never** suppressed, because those are the ones that carry information the player cannot get
any other way.

Creaks are the right thing to sacrifice: a creak is already loud, already positioned, already
captioned (§7.5), and already ducks the mix (§2.3). It does not need the chorus to be legible.
A camper at 14 m has nothing else.

If the invariant still cannot be met — which should only happen during a Night-6 storm with a
catastrophic cabin — log once via `Log.debug()` and let it fail loudly in testing rather than
silently in the mix.

#### 5.4.3 Causal honesty

**Do not cheat this.** The cut must be causally honest. If it ever fires without a real cause,
players stop trusting it, and the moment they stop trusting it, it stops being scary.

**One false positive is permitted per night**, from a deer (`Props` emits
`noise:emit { kind:'brush' }`), and the payoff is that the player, having frozen for ten seconds
for nothing, must now decide whether to trust it the next time. One. Per night. Not two.

This doctrine is why §5.3's loon and §4.16's whistle were rewritten. A document cannot demand
causal honesty in §5.4 and then fire a scream on a 40-second timer in §5.3.

### 5.5 The per-night palette — **DERIVED, and blocked on conflict C3**

`GAME_DESIGN.md` §7 and `STORY.md` §4 disagree about what is built on which night (§0.7, **C3**).
The table below is therefore keyed to **observed events and `state.installed`, never to
`state.night`**, so that it is correct under either resolution.

| Palette element | Activation condition (event-driven) | Source |
|---|---|---|
| `TIN_ROOF` comb (§3.3.4), tin rain (§4.15), tin footsteps (§4.1) | `CabinSite.tinRoofArea()` non-null | either doc's roof night |
| Glass pings in the mix (§4.2, `glass.ping` reuse) | first `build:pickup` of a `window` part | GD N6 / STORY N6 |
| The handsaw (§4.13) | first `tool:found` of `handsaw`, or `night >= 3` | **C1**, **C2** |
| Hinge foley, door swing | first `build:place` into a `hinge` slot | GD N6 / STORY N4 |
| The grab (§4.26) | `night >= 3` | `GAME_DESIGN.md` §8.3 — unambiguous |
| Rigging, ladder, canoe (§4.23) | first class-E or unsnapped placement | STORY N5 |
| Rain on water plinks (§4.15) | within 25 m of shoreline | geometric |
| `CABIN_SHELL` audible (§3.3.3) | `enclosure > 0.15` | continuous |
| Chorus Dolbear curve (§5.2.3) | `state.night` | safe — both docs agree the week is seven nights and gets colder |
| Radio (§5.3.3) | `timeOfNight < 0.55` | safe |
| `FIRESIDE` VO (§7.4) | `night <= 3` | `STORY.md` §6.3 — explicit |
| `SCARED`/`FEAR_VO` (§7.4) | `state.storyFlags.firstBlood` | `STORY.md` §6.9 content |
| `LATE` VO (§7.4) | `night >= 6` | `STORY.md` §6.10 — explicit |

**When C3 is resolved, regenerate this table and change nothing else in this document.** That is
the test of whether the event-keying worked.

---
## 6. Adaptive Music

`src/audio/Music.js`. **There are no linear tracks and no loops.** Everything is scheduled note by
note against `AudioContext.currentTime` with a 200 ms lookahead scheduler ticking on a 50 ms
`setTimeout` — not `requestAnimationFrame`, because the scheduler must survive tab throttling
gracefully and must not be coupled to the render loop.

### 6.1 Harmonic language

- **Reference pitch A = 436 Hz** (14 ¢ flat). Everything in the score is slightly, unplaceably flat
  against nothing. The camp radio (§5.3.3) is at A = 440; when both are audible they beat at
  ≈ 1.6 Hz in the upper register. That is intentional and it is horrible.
- **Pitch centre: D1 = 36.4 Hz / D2 = 72.8 Hz.** It never modulates. Seven nights, one key.
- **Mode: D Phrygian** (D E♭ F G A B♭ C) at low dread, drifting to **D Locrian** (A♭ replaces A)
  above dread 0.75.
- **The tritone D–A♭ is reserved.** It appears nowhere in the game until a camper has actually seen
  the player — **and in exactly one other place: `stage_chime` at rot stage 4** (§4.25.3). By Night
  6 the manual is signing off on your work with the interval the score uses for being seen. Nobody
  will connect them consciously. They are the same interval and it is not a coincidence.
- **No triads, ever.** Harmony is stacked fourths (D–G–C), minor seconds (D–E♭) used as beating
  intervals, and open fifths. When two voices land a minor second, detune one by 11 ¢ so it beats
  at ≈ 1.5 Hz.

### 6.2 Instrumentation (all synthesized)

**PAD — detuned analog.** Per voice: 3 `OscillatorNode`s (`sawtooth`, `sawtooth`, `triangle`)
detuned `[−7, +6, +13]` ¢, plus a sub `sine` an octave down at −9 dB. Into a lowpass
(`f = 240 + 900·dread`, `Q = 3.5`) with a 0.07 Hz sine LFO on cutoff, ±180 Hz. Amp env
`A 4500 / S 1.0 / R 6000 ms`. Chorus: two `DelayNode`s at 14 and 21 ms, each modulated ±3 ms by
0.11 / 0.17 Hz LFOs, mixed 0.3. **Voice cap: 4.**

**PREPARED PIANO.** Modal, 7 partials with string inharmonicity: `f_n = n·f0·√(1 + B·n²)`,
`B = 0.0042`. `Q_n = 900/n`, decay `= 3200/n^0.8` ms. Excited by a 1.5 ms noise burst through a
lowpass at `4·f0`. **The preparation:** partials 3, 4, 5 are amplitude-modulated by a 64 Hz sine at
depth 0.55 — a screw resting on the string, buzzing. Damper thunk on note-off:
`modal([{f:92, Q:9, g:0.3, d:60}])`. **Single notes only, never chords, never more than one note
every 4 seconds.**

**BOWED METAL.** Continuous pink noise → gain (`bowPressure`) → 5 very high-Q bandpasses at
`[196, 293, 441, 587, 881] Hz` (a stack of fourths and fifths on D), `Q = 180 + 600·bowPressure` →
a soft `WaveShaper` (**`oversample: '4x'`**, DC blocker after) → out. `bowPressure` ramps over
3–8 s. A slow, hollow, unstable drone that swells and dies like a bowed cymbal edge. **This is the
game's dread meter.**

**THE STRING — one detuned low string.** Karplus-Strong: a `DelayNode` (delay = 1/f) in a feedback
loop with `[lowpass f = 2600] → [gain 0.994]`, excited by a 12 ms noise burst.

> **Implementation warning.** A `DelayNode` feedback loop in WebAudio has a minimum delay of one
> render quantum (128 samples ≈ 2.67 ms at 48 kHz), which floors the pitch at ≈ 375 Hz — far too
> high for our low D at 36.4 Hz.

Therefore: on `settings.tier('modal','modal','worklet','worklet')`, use an
`AudioWorkletProcessor` (`ks-processor`) for true low KS. On `low`/`medium`, fall back to a modal
bank of 9 harmonics of 72.8 Hz with `B = 0.0008` and 8 s decays — 90% as good at a tenth the cost.
Detect once at init; never branch per note. Struck, not plucked, with a felt exciter: 25 ms of
lowpassed noise.

### 6.3 The Dread scalar and the layers

```js
dread = clamp01(
    0.40 * state.suspicion
  + 0.30 * proximity                          // 1 - clamp01(nearestCamperDist / 30)
  + 0.15 * lineOfSightTerm                    // 1 if a camper's cone contains the player
  + 0.10 * clamp01(state.creaks / 6)          // clamped — see below
  + 0.05 * (1 - buildProgress)
);
```

**The creak term must be clamped.** `GAME_DESIGN.md` §3.1 permits `lambda` up to ~7.8 creaks per
minute on a Wrong-part join; `state.creaks` reaches 6 within a minute of a bad Night-4 placement
and would then pin that term forever, including across the 45-minute tail of Night 7. `clamp01`
is not cosmetic.

Smoothed **asymmetrically: rise τ = 0.35 s, fall τ = 4.5 s.** Dread arrives instantly and leaves
slowly. Never the reverse.

| Layer | Instrument | Enters at | Behaviour |
|---|---|---|---|
| **L0 — Ground** | THE STRING, D1, struck once | always | One note every 22–40 s, −30 dBFS@1m. The game's pulse, present even at dread 0 and on the title screen. |
| **L1 — Air** | PAD, one voice, D2 + A2 open fifth | dread > 0.12 | Filter cutoff tracks dread. |
| **L2 — Report** | PREPARED PIANO | build progress, **not** dread | On `build:place { correct: true }`: one note from a slowly ascending sequence indexed by stage (D, F, G, B♭, C, D, E♭…). **The only reward music in the game.** Dry, close, −20 dBFS@1m. |
| **L3 — Attention** | BOWED METAL, `bowPressure 0.3` | dread > 0.35 | Swells over 6 s. |
| **L4 — Pressure** | PAD second voice a minor second above (E♭), BOWED METAL → 0.7 | dread > 0.60 | The beating starts. |
| **L5 — Seen** | Adds A♭ (the reserved tritone); THE STRING switches to a 3-note irregular ostinato at ≈ 104 bpm | dread > 0.85 **or** `player:spotted` | Never plays otherwise. |

**Critical-detection cue.** `GAME_DESIGN.md` §4.1 asks for "a single low heartbeat-rate string tone
from `Music.js`" at detection 0.75–0.99. That is THE STRING at D1, struck once, at a rate of
64 bpm for three strikes, −26 dBFS@1m. **It is a string tone at heartbeat rate. It is not a
heartbeat** (§4.27.2), it must never play simultaneously with one, and the two must not be
conflated by anyone reading either document.

**Transition rules.** Layers enter on the next 2 s grid boundary and leave on the next 4 s
boundary, always with ≥ 1.5 s ramps. **Never cut a layer.** Above dread 0.85 falling below 0.40
(the player escaped), the score **collapses**: every layer ramps out over 3.5 s except L0, and L0
plays one note. Then 20–40 s of no music at all (§8 S5).

### 6.4 The tell — the manual knows what happens next

v1.0 built the game's signature cue as "THE STAPLE," three struck-steel hits and a clang, and then
spent five numbered bullets explaining, in the document, how it differs from `ki-ki-ki, ma-ma-ma`.

That is the document winking at the camera — the exact failure §1.5 and `GAME_DESIGN.md` §0 forbid
— and a cue defined by what it is *not* has no identity of its own. Three struck-steel hits and a
clang could be in any horror game; nothing about it is flat-pack. And it depended on an API nobody
had declared.

**The tell is the manual, because the manual is the only thing in this world that knows what
happens next.**

```
One manual_tick (§4.25.1): sine + triangle at 2100 Hz, 40 ms, −22 dBFS@1m
on sfxUI: dry, mono, dead centre, no reverb, no distance, no mask
arriving exactly 1.2 s before a camper turns toward the player
```

That is the entire cue. **The clean universe intruding on the wet one is the game.** For 40
milliseconds the flat, bright, Helvetica-alike world of the instruction manual reaches into a
soaking forest and points at something, and then it is gone, and the player has 1.2 seconds.

**Constraints:**

- At most **twice per night**, so it never becomes wallpaper.
- Never when the player is already spotted.
- Never within 8 s of another `sfxUI` sound, so it cannot be confused with `hardware_chime`
  (1400 ms decay — thirty-five times longer) or `stage_chime` (two tones).
- It fires whether or not the player can see the camper. It is not a threat indicator; it is the
  manual noticing.

**The required API, declared** (v1.0 needed this and never said so):

```js
// TODO(api): Campers.willObserve(dtMs) -> { camper, tMs } | null
//   Returns the soonest scheduled scan/turn that will bring the player into a camper's cone
//   within dtMs, or null. Called by Music once per 250 ms with dtMs = 1400.
//   Graceful null path: the tell never fires; nothing else changes.
```

**This is not clairvoyance, and that matters for whether the AI agent can implement it.**
`GAME_DESIGN.md` §4.3 puts Idle campers on a scan timer: "Scans ±40° every 4 s." That timer is
scheduled state the FSM already keeps. `willObserve` reads a clock, projects the camper's known
heading and the scan arc forward, and reports. It does not need lookahead in the decision system
and it does not need the FSM to become predictive.

### 6.5 What the music never does

- **It never stings a kill.** `STORY.md` §4 Night Four: the first kill is "a single hard cut to
  black with **no music sting and no scream** — only the sound of a hammer set down carefully on
  wood." That hammer is `join_seat`'s modal bank at 0.5× gain with the tick removed, on
  `sfxWorld`, at −24 dBFS@1m, and there is nothing else.
- **It never scores the manual.** S6 is silent (§8). The night-end card has no music.
- **It never plays during any silence rule** except S9 (pause).
- **It never resolves.** There is no cadence anywhere in this score. The one moment that sounds
  like resolution is `stage_chime` at rot stage 0, and it is not in the score, it is in the manual,
  and by Night 6 it is a tritone.

---

## 7. Voice — Atmosphere Only

**The creator's hard rule: voice is atmosphere in 3D space. Never a narrator, never the star.**
`STORY.md` §Contract: "**The game must be fully playable, and fully sad, with the VO folder
deleted. Voice is weather.**"

`VoiceBank.js` loads ElevenLabs MP3s from `public/audio/vo/` generated by
`tools/generate-voices.mjs`. If the directory is empty, `VoiceBank.available = false`, every
`audio:vo` becomes a no-op, and the game must still work. **Test that build weekly.** It is the
default assumption, not the fallback.

### 7.1 The half-heard principle

The frightening thing about a voice in the woods is not what it says. It is that you *almost*
caught it. Target ratio: **4:1 half-heard to clear.** A fully intelligible line is a scripted
event and there should be at most three per night.

`STORY.md` §6 supports this directly: "Heard at distance, in 3D, through trees, through rain,
usually half-caught… Most under twelve words. **Write for the words that survive the filter.**"
The lines were written for this chain. Do not weaken the chain to make them intelligible.

### 7.2 The distance / intelligibility chain

```
buffer → [preGain] → [voHP] → [voLP] → [voPresence] → [smearGain] → [rearShelf] → [panner]
                                                    ├──▶ [verbSend] ──▶ convolver A or B
```

- **`voLP`** (lowpass, `Q = 0.7`): `fc = 15000 / (1 + d/3.2)^1.35`
  → 0 m: 15.0 k · 6 m: 4.7 k · 15 m: 1.5 k · 30 m: 730 · 45 m: 450 Hz.
  **15 kHz, not v1.0's 16 kHz** — see §9.4 on why the assets stay at full rate and why 16 kHz was
  a no-op under v1.0's own downsampling claim.
- **`voHP`** (highpass): `fc = 40 + 6.2·d`, clamped to 340 Hz. Removes chest and proximity as
  distance grows; a far voice is all midrange.
- **`voPresence`** (peaking, `f = 2600, Q = 1.4`): `gain = +4 − 0.22·d` dB, clamped to −6. Close
  voices have consonants; far ones do not.
- **`verbSend`**: `wet = clamp(0.12 + 0.020·d, 0.12, 0.85)`.
- **`smearGain` — the wind gate.** Active when `d > 18` or `weather.wind > 0.4`. A random-walk gain
  that punches holes: every `1/(3 + 5·wind)` seconds, `setTargetAtTime(rand(0.35, 1.0), now, 0.05)`.
  **This is what makes a distant conversation come and go in the wind, and it is the single most
  important VO processing decision in the game. Words drop out. Sentences arrive in fragments.**
- **`rearShelf`**: §3.1.3, same as every other 3D source.
- Occlusion (§3.2) applies on top of all of it.

**The intelligibility scalar:**

```js
I = clamp01(1 - d/26) * (1 - 0.55*occlusionT) * (1 - 0.45*wind) * facingTerm;
// facingTerm: 1.0 facing the player, 0.4 facing away (via the panner cone, §3.1)
```

| `I` | Band | Behaviour |
|---|---|---|
| `> 0.62` | **clear** | Emit `ui:subtitle` (§7.5). At most 3 per night. |
| `0.30 – 0.62` | **half-heard** | **No subtitle.** The player hears cadence, gender, emotion, maybe one word. **This is the target band.** |
| `≤ 0.30` | **presence** | Do not schedule scripted lines here. Play `CHATTER_BED` takes so we do not burn authored content on inaudibility. |

### 7.3 Scheduling conversations

`VoiceBank` runs a `ConversationDirector`:

- A conversation is 2–4 campers with a topic id from `src/story/Script.js`.
- **Max 2 active conversations. Max 4 concurrent VO voices. Hard cap** (§9.1).
- Turn-taking gap: `180 + rand(0, 240)` ms. **12% of turns overlap** — the next speaker begins
  250 ms before the current ends. Real conversation overlaps; perfectly alternating VO sounds like
  a radio play.
- Laughter is scheduled as a reaction, 300–600 ms after a punchline, from 1–2 non-speakers.
- **Never place two active speakers within 20° of each other in the player's azimuth.** If the
  geometry demands it, delay the second speaker.
- **Cooldown: the same line id never plays twice in a night, and never at `I > 0.62` twice in the
  whole game.** A line the player once heard clearly must, on any repeat, be half-heard. With a
  90-line bank (`STORY.md` §6: "Total: 90 lines"), this constraint is what makes the bank feel
  three times its size.
- `STORY.md` §6 also requires: "`VoiceBank` should aggressively vary distance, occlusion, pitch
  (±3%) and delay so no line is ever heard 'the same way twice.'" The ±3% is `playbackRate`, not
  `detune`, and it must be applied *before* the chain so `voPresence` tracks the shifted formants.
- **`CHATTER_BED`:** for each of the six speakers, 6 takes of 4–9 s of non-lexical conversational
  murmur — delivered as real sentences, then processed until unrecoverable. These play at
  `I ≤ 0.30`. **They are the workhorses; scripted lines are the spice.**
- **VO stops entirely during any silence rule (§8) except S9.**
- Every line start also emits `noise:emit { kind:'voice', radius: 26, intensity: 0.30 }` (§4.28.3).

**Category → FSM state routing** (this is the mapping `GAME_DESIGN.md` §4.3's `vo_curious_*` and
`vo_hm_*` globs resolve through — see §7.4.3):

| Camper state | `STORY.md` section drawn from |
|---|---|
| Idle, at the fire | §6.1 idle chatter, §6.3 campfire (nights ≤ 3), §6.4 arguments |
| Idle, working | §6.1, §6.2 calling out |
| **Curious** | §6.5 "I heard something" — the low-arousal subset |
| Curious → escalating | §6.5 — the high-arousal subset |
| Searching | §6.6 searching |
| Curious → Idle (gave up) | §6.7 false alarms |
| Found something | §6.8 finding evidence |
| Alerted / Panic | §6.9 genuine fear |
| Nights 6–7 | §6.10 very late game |

### 7.4 Generation — **DERIVED from `STORY.md` §5 and §6**

v1.0 defined six voice profiles — DENISE, RANDY, TAMMY, KEVIN "SPUD", MARCIA, BUD DIETZ — none of
whom exist. `STORY.md` §5 defines the cast as **Robin, Dale, Marg, Coop, Teddy, Bev**, and §6
gives every line an id and per-line `S / Sim / St` values that are already authored. Following
v1.0 would have generated roughly 200 MP3s for characters `Script.js` will never reference, with
filenames that violate `STORY.md`'s path contract, and the entire VO pipeline would have been dead
on arrival with no error message.

**`STORY.md` is the single source of truth for speaker ids, line ids, line text, categories, and
per-line generation parameters. This document owns the chain and nothing else.**

Two v1.0 profiles were not merely invented but *duplicative*: Bud Dietz — "the only one who knows
what a joist is" — is Dale Pruitt's function (`STORY.md` §5: sixth summer, Maintenance, fixes
everything). Marcia, who "sings to herself constantly," duplicates the Night-1 Dale beat (drunk,
singing half a song, giving up on it twice).

#### 7.4.1 The cast — **DERIVED**

| Speaker id | Name | Age / role | Voice direction (ElevenLabs description) | `speaker_boost` |
|---|---|---|---|---|
| `ROB` | Robin Osei-Hall | 19, Arts & Crafts | Young, warm, quick; restarts her own sentences and never finishes the first attempt. Technically literate — she grew up in a boatyard and knows a mallet from a woodpecker. **She is right and nobody believes her.** | true |
| `DAL` | Dale Pruitt | 27, Maintenance | Tired, kind, unhurried; trails off with "…anyway." Drinks a little more than he'd like you to know. Calls everyone *chief* or *champ*. | true |
| `MRG` | Marguerite "Marg" Toth | 21, Waterfront | Competent, warm, slightly bossy; **counts out loud** and narrates her own logistics because it is how she thinks. | true |
| `COO` | Cooper "Coop" Vance | 20, Sports & Rec | Loud, turns everything into a bit, then apologises for the bit thirty seconds later. **Write him kind — his bits are how he checks whether people are okay.** | true |
| `TED` | Teddy Nakagawa | 16, CIT | Says *sorry* as punctuation; asks permission for things he has already been told to do. First summer away from home. | true |
| `BEV` | Beverly "Bev" Ranczak | 58, Camp Director | Fragments with the articles removed — "Get the tarps. Both of 'em. Now." Fifty-eight, chain-smokes Winstons, loves this place and would never say so. | **false** |

Bev is the only `speaker_boost: false`, and it is a chain decision, not a character one: her
register is the lowest in the cast, she is heard mostly at distance where boost artifacts become
obvious in the 340–1500 Hz band after `voHP`, and we want her low end intact and un-enhanced.

`STORY.md` §5's casting note is binding: "six distinct ElevenLabs voices, all pitched **young and
tired** except Bev. No 'horror movie' delivery, ever. **If a line sounds like a line, cut it and
re-record it flatter.**"

#### 7.4.2 Global direction

They are ordinary people at a summer job who arrived a week early to open a camp, which is a
genuinely nice thing to volunteer for. **They are not in a horror movie and must never sound like
they are.** None of them is stupid. None of them is cruel. `STORY.md` §5: "The player should be
actively annoyed when the game requires them to be hurt."

**The horror is that they are relaxed**, and then, from Night Four, that they are frightened in an
ordinary, unperformed, embarrassing way.

#### 7.4.3 Per-category chain deltas

`S / Sim / St` come from `STORY.md` §6, **per line**, and are used verbatim. The deltas below are
*chain* adjustments the generator applies on top, and they are this document's to own:

| Category | `STORY.md` § | Availability | Direction note passed at generation | Δ style | Δ stability |
|---|---|---|---|---|---|
| `CHATTER` | 6.1 | all nights | Mid-sentence, no setup, no punchline for the player's benefit. Trail off. | −0.05 | +0.05 |
| `CALL_NAME` | 6.2 | all nights | Shouted across distance, but casually — calling a friend to dinner, not a search party. Long vowels. | +0.10 | 0 |
| `FIRESIDE` | 6.3 | **nights ≤ 3** | Slow, warm, overlapping, laughing. Long takes used as a bed near the camp. | 0 | +0.05 |
| `ARGUMENT` | 6.4 | all nights | Small, domestic, real. Tired, not angry. Nobody raises their voice. | 0 | 0 |
| `NOTICE_LOW` → `vo_hm_*` | 6.5 subset | all nights | "…huh." Barely a reaction. Half a beat of listening. **Under-play this brutally.** | −0.15 | +0.10 |
| `NOTICE_HIGH` → `vo_curious_*` | 6.5 subset | all nights | Genuine puzzlement, not fear. | +0.05 | 0 |
| `SEARCH` | 6.6 | all nights | Talking to themselves at low volume while moving. Breath between words. | 0 | −0.05 |
| `DISMISS` | 6.7 | all nights | Relieved, slightly embarrassed. **This is the sound the player wants to hear.** | +0.05 | 0 |
| `EVIDENCE` | 6.8 | `firstBlood` | Analytical before it is frightened. Crouched, close, thinking. | 0 | 0 |
| `FEAR_VO` | 6.9 | `firstBlood` | Real, ugly, unperformed fear. Short. **No screaming as performance.** | +0.15 | −0.10 |
| `LATE` | 6.10 | nights ≥ 6 | Quiet, dawning, exhausted. Bev remembering is the closest the game comes to explaining anything. | +0.05 | 0 |

**Glob resolution**, for conflict **C6**'s neighbours: `GAME_DESIGN.md` §4.3 emits
`audio:vo { id:'vo_curious_*' }` and `{ id:'vo_hm_*' }`. These are **categories, not line ids**.
`VoiceBank` resolves them against the manifest:

- `vo_hm_*` → `NOTICE_LOW`: `DAL_HEAR_01` ("Huh."), `MRG_HEAR_01`, `COO_HEAR_01`.
- `vo_curious_*` → `NOTICE_HIGH`: `ROB_HEAR_01`, `ROB_HEAR_03`, `MRG_HEAR_02`, `TED_HEAR_01`,
  `COO_HEAR_02`, `BEV_HEAR_01`.

Both globs, and any future glob, resolve through one function so the failure is a logged warning
and not a silent no-op (§10.2).

#### 7.4.4 A construction-reaction gap, and how it is handled

`GAME_DESIGN.md` §11 t=1:12 requires a camper to react to hammering, and §2.5's comedy engine
depends on campers blaming each other for construction noise. `STORY.md` has partial coverage —
`ROB_HEAR_02` ("That's a mallet. That's somebody driving a stake."), `ROB_HEAR_03` ("Four hits.
Even. Nothing hits four times even."), `COO_EVID_01` ("Somebody took the hinges. Who takes
hinges.") — but no line where a camper attributes the noise to *another camper*, which is the joke.

**This document does not write those lines.** The slots are requested by id, with speaker,
category, and the direction note, and the generator skips them until they exist:

```
TODO(story): four CONSTRUCTION lines requested for tools/generate-voices.mjs.
  DAL_CONS_01  Dale   — being blamed, mildly, for work he is not doing
  MRG_CONS_01  Marg   — asking whether Dale is working now, at this hour
  COO_CONS_01  Coop   — a bit about the noise that nobody laughs at
  TED_CONS_01  Teddy  — apologising for a noise that is not his
  Direction: completely straight. Nobody ever suggests a monster is building a house.
  Nobody is frightened. This is the comedy engine and it works because it is mundane.
  Until these exist, VoiceBank routes construction reactions to NOTICE_LOW.
```

#### 7.4.5 Generation hygiene

- Model `eleven_multilingual_v2`, output `mp3_44100_128`.
- **Filenames: `public/audio/vo/<LINE_ID>.mp3`**, exactly — e.g. `public/audio/vo/MRG_IDLE_01.mp3`.
  This is `STORY.md`'s contract verbatim. v1.0 specified
  `vo_<speaker>_<category>_<index>.mp3`, under which **every fetch in the game would have 404'd.**
- Fixed `seed` per line id (`hash2` of the id) wherever the API accepts one, so regeneration is
  reproducible.
- **No downsampling on load** — see §9.4. `mp3_44100_128` decodes at the context rate and stays
  there.
- `public/audio/vo/manifest.json`:

```json
{
  "version": 1,
  "lines": [
    { "id": "MRG_IDLE_01", "speaker": "MRG", "category": "CHATTER",
      "durationMs": 2840, "clearOK": true, "night": null, "flag": null }
  ]
}
```

`clearOK` marks lines permitted to play at `I > 0.62`. `night` and `flag` carry the availability
gates from §7.4.3. `VoiceBank` treats a missing manifest exactly like a missing directory:
`available = false`, and the game is unaffected.

- **Rate limiting and idempotence:** the generator skips any line whose MP3 already exists with a
  matching manifest entry, retries 429s with exponential backoff starting at 2 s, and writes the
  manifest last so an interrupted run is resumable.

### 7.5 Captioning the non-verbal — **required by `GAME_DESIGN.md` §10.3**

v1.0 §7.2 wrote of clear VO lines: "**This is the only place subtitles come from.**"

`GAME_DESIGN.md` §10.3 requires the opposite: "Non-verbal but mechanically relevant sounds are
captioned too: `[creak — north, near]`, `[thunder — 3 seconds]` (**the last one is essential for
deaf players to use thunder masking**)."

`AudioEngine` is the only system that knows creak tier, thunder ETA, emitted intensity, and the
mask window. **It is therefore the only place those captions can originate, and v1.0 explicitly
forbade itself from emitting them** — which made the game's skill ceiling (§4.17.4) unusable
without hearing.

`AudioEngine` emits `ui:subtitle { text, speaker, ms }` for the following. `speaker` is `''` for
all non-verbal captions; `HUD.js` renders `''` in the bracketed style per `GAME_DESIGN.md` §10.3.

| Event | Caption | Gate |
|---|---|---|
| Creak, tier ≥ 2 | `[creak — <dir>, <dist>]` | `settings.subtitles` |
| Creak cascade | `[the structure settles — <dir>]`, once for the whole cascade | `settings.subtitles` |
| Own `noise:emit` ≥ 0.3 intensity | `[<kind> — you]` e.g. `[hammer — you]` | `settings.subtitles` |
| Lightning flash | `[thunder — <n> seconds]`, `n = round(Weather.nextStrikeIn()... )` from the flash | `settings.subtitles` |
| Thunder arrival | `[thunder — cover]` | `settings.subtitles` |
| **Thunder close warning** (§4.17.4) | `[thunder — fading]` | `settings.subtitles` — **this is the caption that makes the skill ceiling reachable** |
| Chorus cut | `[the crickets stop]` | `settings.subtitles` |
| Chorus staggered return | `[crickets]` | `settings.subtitles` and `audioVerbosity === 'standard'` |
| Seat vs grind (§4.9) | `[seated]` / `[seated — grinding]` | `settings.subtitles` |
| Dimple / split (§4.7.3) | `[over-tightened]` / `[the wood splits]` | `settings.subtitles` |
| Whistle | `[whistle — <dir>, <dist>]` | always, even at `audioVerbosity: 'reduced'` |
| Night 7 breath catch | `[breath]` | `settings.subtitles` |

`<dir>` is one of eight compass points relative to the player's facing; `<dist>` is `near`
(< 15 m), `mid` (15–40 m), or `distant` (> 40 m). Both come from the same values that drive the
panner, so the caption and the sound can never disagree.

**What is deliberately *not* captioned**, because captioning it would give deaf players
information hearing players do not have and break §1.1's contract:

- **Wrong-slot placement** (§4.9 row 3). It captions as `[seated]`, identically to a correct join.
- The pry bar's 200 ms silence (§4.11). Silence has no caption.
- The chorus's *failed* return after a body is found (§4.26.6) — it captions as `[crickets]` and
  then nothing, exactly as hearing players experience it.
- Ansel's ordinary breathing, the hand-wipe, and the tool roll.

**`directionalAudioIndicator`.** `GAME_DESIGN.md` §10.3 asks for "a thin arc at the screen edge
for any `noise:emit` the player produced above intensity 0.3 and any camper `voice` within 40 m."
There is no `ui:arc` event and this document may not invent one. **`HUD.js` draws the arc by
listening to `noise:emit` directly** — a public canonical event it is entitled to read — while
`AudioEngine` owns the caption. Two systems, one event, no new channel. See conflict **C5** for the
26 m / 40 m radius disagreement.

---

## 8. The Silence Rules

**This is the most important section in this document.** Every rule is implemented as a
priority-ordered stack in `AudioEngine`; **the highest-priority active rule wins and rules do not
blend.** Priority is the numeric order below, S1 highest.

**S1 — The first breath of the night.** On `night:begin`: **2.2 seconds of absolute silence.** Not
room tone. Nothing. Then the bed fades in over 6 s — wind first, then the distance layer, then the
chorus last (staggered, §5.4). *Why:* it resets the ear, it makes the bed feel like it **arrived**,
and it establishes on Night 1 that this game is willing to give you nothing.

On Night 1 specifically, `crate_settle` (§4.28.5) plays *before* the 2.2 s, over black, per
`GAME_DESIGN.md` §11 t=0:00 — one wooden sound in a world that does not exist yet.

**S2 — The chorus cut.** §5.4 in full, including the duty-cycle invariant and the causal-honesty
doctrine. *Why:* it is the entire stealth UI and it is diegetic.

**S3 — The naked creak.** On **`build:creak` with tier ≥ 3** (§4.12.2): everything except the
creak ducks −18 dB over 180 ms *before* the creak sounds, then returns over 900 ms. The creak
arrives into a vacuum, unaccompanied, at full level.

v1.0 fired this on **`build:place` with `correct: false`** — at the moment of placement. That
converted the game's central trap into an instant fail buzzer and contradicted
`GAME_DESIGN.md` §11's "it seats, and it creaks 9 seconds later" and §2.3's "no negative feedback
at all" for Wrong-slot.

*Why the fixed version works:* the 180 ms pre-duck is **the only warning the player gets before a
creak whose cause is now nine seconds and twelve metres behind them.** It is the audio equivalent
of a hard cut to a close-up of something that already happened.

Not fired for tiers 1–2. Tier 1 is explicitly ignorable (§4.12.3) and tier 2 must not be
dignified with the mix stopping.

**S4 — The gap before the thunder.** From the lightning flash until the thunder arrives
(`2.9 · distance_km` seconds, up to 12.2 s), duck everything but rain by −14 dB over 110 ms and
hold. The flash whites out the screen, the world goes quiet, and then, seconds later, the sound
arrives. *Why:* real, free, and it makes the player count — which is exactly the skill
`GAME_DESIGN.md` §3.3 wants them to develop. Every distant strike buys a silence we did not have
to justify.

Captioned as `[thunder — <n> seconds]` (§7.5) so deaf players count the same beats.

**S5 — The escape.** When dread falls from > 0.85 to < 0.40, the score collapses (§6.3) and then
there is **no music at all for 20–40 s.** The bed returns to normal; the score does not. *Why:*
relief is a musical event, and the only way to score relief is to stop scoring.

**S6 — The clinical pause.** On `build:stage-complete`: **1.4 s of complete silence across every
bus**, and then, alone and dry on `sfxUI`, `stage_chime` (§4.25.3) — two tones, 140 ms each, at
whatever stage of rot the manual has reached. Then the world fades back over 1.8 s.

*Why:* this is the funniest moment in the game and it is funny because it is silent. The forest
stops, the furniture-commercial universe intrudes for roughly 340 ms, and then the wet dark night
resumes as if nothing happened.

> **Do not add a musical sting. Do not "sell" it. Do not reverb it. The deadpan is the joke.**

The 1.4 s of silence is also what makes §2.1's `sfxUI` level invariant true: the chime is always
alone, so the limiter never touches it.

**S7 — The end.** On `night:failed`: hard-mute every bus on the frame it fires — including room
tone, including the mask chain, including everything. **900 ms of true digital silence.** Then one
note: THE STRING at D1, −24 dBFS@1m, allowed to ring for 11 s into `OPEN_FOREST`. Nothing else,
ever, until the menu.

*Why:* the only time this game gives you actual nothing is when you have lost, and it should be
the loudest silence in the medium.

**S8 — Lantern out.** When the player extinguishes the lantern (a deliberate stealth action per
`GAME_DESIGN.md` §4.4), the gas hiss ramps out over 700 ms with its bandpass sweeping down to
500 Hz, **and the ambience bed drops −8 dB with a lowpass to 3.2 kHz for as long as the light is
off.**

*Why:* this is psychoacoustically dishonest and it is the correct choice. It makes darkness feel
like holding your breath, and it rewards a risky action with an audible change of state. It is the
one place in this document where physical accuracy is deliberately traded for legibility, and it
is flagged as such so nobody "corrects" it later.

**S9 — The pause.** On `game:pause`: do **not** silence. Ramp all buses to −20 dB over 400 ms and
insert a lowpass at 900 Hz. The forest is still there, behind glass, waiting. `sfxUI` is unaffected
so menu interaction stays crisp; music continues, quietly, because §6's score is generative and
stopping its scheduler mid-phrase is audible on resume.

*Why:* a hard mute on pause tells the player the world is a program. Keeping it breathing at the
edge of hearing tells them it is a place.

**S10 — deleted.** v1.0's S10 was the mask-donning event, triggered by `story:beat 'mask-on'`,
which does not exist. The mask has been on since 1962 (§2.5). There is no donning moment and there
must not be one.

**S11 — Pre-dawn.** Above `state.timeOfNight > 0.92`, over 40 s: ramp everything below 300 Hz out
(a `highpass` on `master` sweeping 20 → 300 Hz), reduce the wind to band C and sizzle only, cut the
chorus to 3 instances, and let one distant bird exist — a white-throated sparrow: five pure sine
tones at `f = 4200 Hz`, first long then four short, 700 ms total, every 25–60 s. Music silent.

*Why:* dawn is the reward and it must sound thin, cold, and survived. It is also the third
diegetic clock, alongside the camp's fires dying at 0.55 and the moon's altitude.

**S12 — Never break a silence with a fade-in.** Whatever ends a silence must **arrive** — a
transient, an event, a footstep. If nothing arrives, the silence continues until something does.
**Fading the bed back up under a silence is the one unforgivable sin in this document.**

The single exception, and it is not really one: S1's 6 s bed fade-in is not breaking a silence, it
is *starting a night*, and it is preceded by nothing rather than followed by nothing.

**S13 — The unmasking.** `ending_c` only, once per playthrough (§4.28.4). The mask chain
crossfades **out** over 2800 ms. It is not a silence; it is the removal of a filter the player did
not know was there, and it belongs in this section because it is the same kind of move: taking
away something the player had stopped noticing.

*Why:* §1.4 says the horror is the removal of a sound the player had habituated to. Seven nights
of habituation to a *timbre* is the largest instance of that idea the game can contain, and it is
saved for the last ninety seconds.

---
## 9. Implementation Notes (WebAudio)

### 9.1 Voice pooling and stealing

`AudioEngine` maintains a pool of pre-built voice slots per SFX family, each a persistent subgraph
(panner + rear shelf + elevation shelf + occlusion filters + gains) whose **source node is the only
thing recreated per play**. `AudioBufferSourceNode` and `OscillatorNode` are one-shot and must be
recreated; everything else is reused forever. **Never build a `BiquadFilterNode` inside a `play()`
call** — and unlike v1.0, every §4 recipe now actually obeys this (§4.0.2).

| Tier | Concurrent voices | 3D panners | Convolvers | Chorus panners | Chirp slots | Rain grains/s | Node churn/s |
|---|---|---|---|---|---|---|---|
| `low` | 24 | 12 (equalpower) | 1 | 4 | 8 | 60 | 24 |
| `medium` | 40 | 24 (equalpower) | 1 | 4 | 18 | 140 | 40 |
| `high` | 64 | 40 (HRTF) | 4 | 4 | 34 | 300 | 70 |
| `ultra` | 96 | 56 (HRTF) | 4 | 4 | 48 | 450 | 120 |

**The panner budget now balances.** v1.0 spent 48 of 56 panners at `ultra` on crickets alone,
leaving 8 for everything else in the game. At 4 chorus panners (§5.2.2) the `ultra` allocation is:

| Consumer | Panners |
|---|---|
| Chorus quadrants | 4 |
| Camper VO | 4 |
| Camper footsteps + foley (5 campers × 2) | 10 |
| Player footsteps + brush | 6 |
| Build SFX (creaks 5, hammer 2, misc 4) | 11 |
| Lantern | 1 |
| Campfire, loon, owl, radio | 4 |
| Rain grain groups (3 surfaces × 2) | 6 |
| Hardware tick, whistle, zipper, flashlight | 4 |
| Reserve | 6 |
| **Total** | **56** |

Use `settings.tier(...)` for all of these. **Never branch on the quality string.**

**Stealing.** Every voice has `priority` (0–3) and
`score = priority·1000 + 20·log10(gain) − 0.4·distance − 0.001·ageMs`. When the pool is full,
steal the lowest score and release it with an **8 ms fade, never a `stop()`**.

| Priority | Members |
|---|---|
| **3 — never stolen cross-family** | creaks tier ≥ 2, the seating tap ladder, `join_seat`, `join_split`, the grind, the pry bar, `player:footstep`, breath, the two heartbeats, all `sfxUI`, thunder, `camper_whistle`, the grab |
| **2** | all other build SFX, VO, camper footsteps, zipper, flashlight click, the saw, the drag |
| **1** | music voices, campfire, loon, owl, radio, `hardware_tick` |
| **0** | chorus, rain grains, wind bands, glass rattle, `brush` |

**Per-family caps:** 3 simultaneous creaks (**raised to 5 during a CASCADE**, §4.12.5), 2 hammers,
1 thunder, 4 VO, 6 footsteps across all agents, 12 rain grains in flight, 1 saw, 1 grab.

> **The deadlock v1.0 would have shipped:** priority 3 is "never stolen," and `player:footstep` is
> priority 3 with a family cap of 6. Six in-flight footsteps would have made a seventh footstep
> unplayable — it cannot steal (everything is priority 3) and it cannot allocate (the family is
> capped). The player's own footsteps would silently stop during a sprint.
>
> **The rule that fixes it:** *"never stolen" applies to **cross-family** stealing only. Within a
> family, the oldest voice is always stealable regardless of priority.* A seventh footstep steals
> the first footstep, which is 400 ms old and inaudible, and nothing is lost.

### 9.2 Avoiding clicks — the non-negotiables

1. **Never assign `param.value` on a live node.** Always `setTargetAtTime` /
   `linearRampToValueAtTime` / `setValueAtTime` in the future.
2. **Minimum 4 ms attack, 8 ms release, on every gain, no exceptions.** A "hard" transient is
   achieved with a 1–2 ms *noise-burst source*, never a 0 ms envelope.
3. **`exponentialRampToValueAtTime` cannot target 0.** Ramp to `1e-4`, then `setValueAtTime(0)` one
   render quantum later.
4. **Cancel correctly.** `cancelAndHoldAtTime(now)` then ramp. A bare `cancelScheduledValues()`
   jumps the param to its last *set* value and clicks. **Feature-detect it:** `cancelAndHoldAtTime`
   has historically been missing in some engines; if absent, emulate with
   `setValueAtTime(param.value, now); cancelScheduledValues(now + 1e-6);`.
5. **Schedule in the future.** All `start()` calls at `ctx.currentTime + 0.020` minimum — reduced
   to `+0.008` when `ctx.outputLatency > 0.09` (§9.5). Never `start()` at `currentTime`; you are
   racing the audio thread.
6. **Filter frequency jumps click too.** Biquad coefficients are not interpolated per-sample in all
   engines; ramp `frequency` with `setTargetAtTime(τ ≥ 0.008)`.
7. **DC.** Anything through a `WaveShaperNode` gets a `highpass f = 18, Q = 0.7` after it.
8. **Never reassign `ConvolverNode.buffer` on a live node.** It re-partitions the IR synchronously
   on the main thread and instantly truncates the outgoing tail. §3.3 exists so this never happens.

### 9.3 CPU and node budgets

`AudioEngine.update(dt)` must cost **< 0.35 ms/frame** (inside `ARCHITECTURE.md` §12's
1.5 ms/system guardrail). The audio *thread* is separate but not free — target **< 25% of one
core** at `ultra`.

#### 9.3.1 The four costs, in order

1. **`ConvolverNode`.** Four convolvers with 0.55–2.40 s IRs at 48 kHz is the single largest line
   item, and it is the price of the architecture being coherent (§3.3). Mitigations: generate IRs
   at **24 kHz** on `low`/`medium`; truncate `LAKE_EDGE` to **1.6 s** below `high`; **one**
   convolver total on `low`/`medium`.
2. **HRTF panners** (≈ 4× `equalpower`). Hence the tier table. **Sources beyond 45 m are
   downgraded to `equalpower` automatically regardless of tier** — HRTF cues are meaningless at
   that distance and rolloff dominates. The §3.1.3 front/back cue still applies, which is why the
   downgrade costs nothing perceptually.
3. **Node construction churn.** §4.0.3. This was completely unbudgeted in v1.0 and was the largest
   real risk in the document.
4. **The main-thread `update()`.** Amortized per §9.3.2.

#### 9.3.2 Amortization

- Listener transform: every frame.
- Per-source distance / occlusion: round-robin at **≤ 8 sources/frame** with a 120 ms cache.
- Reverb space probe: every **250 ms**; space changes obey the 6 s dwell (§3.3.5).
- Music scheduler: its own 50 ms timer, 200 ms lookahead.
- Chorus duty-cycle projection (§5.4.2): every **500 ms**.
- **No allocations in `update()`.** Scratch `THREE.Vector3`s at module scope per
  `ARCHITECTURE.md` §12. Object-pool the voice descriptors.
- **Zero garbage from grain trains.** Pre-allocate the scheduler's event ring buffer at init.
- **Kill any voice whose computed gain is below −60 dBFS before building it.** At 60 m in the rain,
  a cricket does not need to exist.

#### 9.3.3 The bake

§4.0.2's baked families are rendered in an `OfflineAudioContext` during `init()`, asynchronously,
off the first frame. Budget **≤ 400 ms** and **≤ 8 MB**; measured expectation ≈ 60–140 ms and
≈ 2.7 MB. If the bake has not completed when a family is first requested, that family falls back
to its LIVE recipe for the first few instances and logs once — the game never waits on audio.

#### 9.3.4 `WaveShaperNode` oversampling — all five, mandatory

v1.0 used a `WaveShaperNode` five times and never set `oversample`. The default is `'none'`, which
means a 3rd-order transfer function on an 11.2 kHz partial folds its harmonics back below Nyquist
as inharmonic mud — in the steel bank (§4.5), which has the highest partials in the game and is
also the sound the player hears most often outside the forest.

| Use | § | `oversample` | Cost note |
|---|---|---|---|
| Steel modal bank contact | 4.5 | `'4x'` | mandatory — 11.2 kHz partials |
| `frictionOsc` nonlinearity | 4.12.1 | `'4x'` | up to 5 concurrent |
| Thunder leading lump | 4.17.2 | `'4x'` | 1 concurrent |
| Camp radio drive | 5.3.3 | `'4x'` | 1 concurrent, always on |
| BOWED METAL | 6.2 | `'4x'` | 1 concurrent |

`'4x'` costs roughly 4× the shaper's own work plus two polyphase filter passes. At 48 kHz across at
most nine concurrent instances this is well under 0.5% of one core — measured, not assumed — and
it is not optional.

### 9.4 Memory and the decode policy

v1.0 wrote, of VO: "we downsample to 24 kHz mono on load — nothing survives the distance chain
above 5 kHz anyway, and it quarters our memory." Three problems:

1. **`decodeAudioData` decodes at the context sample rate.** There is no "downsample on load." It
   requires an explicit `OfflineAudioContext(1, len·24000/rate, 24000)` re-render **per line**,
   which is real main-thread-adjacent work with a real cost, and v1.0 stated none of it.
2. **It would have made `voLP` a no-op at close range.** Nyquist for a 24 kHz asset is 12 kHz, and
   v1.0's own `voLP` specified 16 kHz at 0 m — above Nyquist, filtering nothing.
3. **There was no memory budget at all**, and no decode-on-demand policy.

**The decision: no downsampling.** The memory problem is real but is better solved by eviction than
by re-rendering, and re-rendering costs latency at exactly the moment a line is needed.

**The arithmetic.** `STORY.md` §6: 90 scripted lines, averaging ≈ 3.5 s. Plus `CHATTER_BED`: 6
speakers × 6 takes × ≈ 6.5 s = 234 s.

```
scripted:    90 × 3.5 s               = 315 s
chatter:     36 × 6.5 s               = 234 s
total:       549 s × 44100 × 4 bytes  ≈ 96.8 MB decoded, mono float32
```

**Too much to hold.** Per-night working set is far smaller:

```
a night uses ≈ 28 scripted lines + 12 chatter takes
  = 98 s + 78 s = 176 s × 44100 × 4  ≈ 31 MB
```

**The policy:**

| Rule | Value |
|---|---|
| Decoded-audio LRU cap | **40 MB** |
| Prefetch | on `night:begin`, decode the night's line set (gated by §7.4.3's `night` / `flag` columns), sequentially, off the critical path |
| Evict | on `night:complete` / `night:failed`, drop everything not in the next night's set |
| Decode failure | that line's id is marked unavailable; `VoiceBank.available` stays `true`; the `ConversationDirector` skips it silently |
| Compressed source | ≈ 8.6 MB of MP3 for the whole bank at 128 kbps — kept in memory, cheap, never evicted |

**Baked SFX buffers:** ≈ 2.7 MB (§4.0.2), permanent.
**IR buffers:** four IRs, ≈ 0.55–2.40 s at 48 kHz stereo ≈ 2.3 MB total, permanent.
**Noise buffers:** three × 4.0 s stereo ≈ 3.9 MB, permanent.
**Total permanent audio memory: ≈ 8.9 MB.** Peak with a full VO working set: **≈ 49 MB.**

**The `low`-memory path**, offered and costed rather than hand-waved: if a target platform cannot
hold 40 MB, re-render each line to 24 kHz mono in an `OfflineAudioContext` at prefetch time
(≈ 4–9 ms per line, 40 lines ≈ 0.2–0.4 s spread across `night:begin`'s briefing phase, which does
not run the clock per `GAME_DESIGN.md` §1.1). Memory falls to ≈ 17 MB. **In this path `voLP` must
be capped at 11 kHz**, because 12 kHz is Nyquist and a 15 kHz filter would be a no-op. That cap is
the reason the default path does not downsample.

### 9.5 The latency budget

§1.1 promises legibility "in under 250 ms." That is a claim about the whole chain, and v1.0 never
enumerated it.

| Term | Typical | Worst realistic |
|---|---|---|
| Game logic → `bus.emit` (same frame) | 0 ms | 2 ms |
| One frame at 60 fps | 17 ms | 17 ms |
| Mandated scheduling offset (§9.2 rule 5) | 20 ms | 20 ms |
| `ctx.baseLatency` | 5 ms | 12 ms |
| `ctx.outputLatency` | 20 ms | **120 ms** (Bluetooth) |
| **Total** | **62 ms** | **171 ms** |

Both inside 250 ms, but the Bluetooth case has only 79 ms of margin.

**Mitigations, specified:**

- `new AudioContext({ latencyHint: 'interactive' })` at construction. Never `'playback'`.
- If `ctx.outputLatency > 0.09`, drop the scheduling offset from 20 ms to **8 ms** and
  `Log.debug()` once. Worst case falls to 159 ms.
- `ctx.outputLatency` is not implemented everywhere (§9.6). When absent, estimate as
  `baseLatency · 2 + 0.030` and do not apply the mitigation — an unknown latency is assumed
  typical rather than assumed bad.
- **The tell** (§6.4) is the one cue whose lead time is specified in absolute terms (1.2 s). It
  must be scheduled against `ctx.currentTime + totalLatency`, not against a frame counter, or its
  1.2 s becomes 1.03 s on a Bluetooth headset and the player is seen while still reacting.

### 9.6 Browser support and output policy

Feature-detected at init, never version-sniffed. Every row has a specified fallback.

| Feature | If missing |
|---|---|
| `AudioContext` at all | every `AudioEngine` method becomes a no-op stub; the game runs; nothing throws; `Log.debug()` once |
| `AudioWorklet` | THE STRING falls back to the modal bank (§6.2); detect once, never branch per note |
| `cancelAndHoldAtTime` | emulate per §9.2 rule 4 |
| `ctx.outputLatency` | estimate `baseLatency·2 + 0.030` (§9.5) |
| `StereoPannerNode` | the bleed path (§3.2.1) falls back to a `PannerNode` in `equalpower` at a fixed ±0.35 x-offset — worse, but not localized to the source |
| `PannerNode.panningModel = 'HRTF'` | force `equalpower` on all tiers; §3.1.3's front/back cue is unaffected, which is exactly why it exists |
| `OfflineAudioContext` | skip the bake; all BAKED families run LIVE; force `settings.quality` no higher than `medium` and log once |
| `decodeAudioData` promise form | use the callback form |

**Autoplay.** The context is created `suspended`. **The title screen is silent and says so by being
silent** (§4.28.5). `resume()` on the first `pointerdown` anywhere. If `ctx.state === 'interrupted'`
(iOS), poll and resume on `visibilitychange`.

**Headphones vs speakers** (`settings.audioOutput`, §0.5):

| Setting | Behaviour |
|---|---|
| `'headphones'` (default under `'auto'`) | HRTF on `high`/`ultra`, full §3.1.3 cue, stereo width 1.0 |
| `'speakers'` | force `equalpower` on **all** tiers; stereo width × 0.72 on `sfxWorld` (crosstalk already widens the perceived image); §3.1.3's rear shelf deepened from −5.5 to **−7.0 dB** to compensate for the loss of any residual HRTF front/back information; the `body` bus unchanged |

Stated plainly so §1.1 is honest: on speakers, azimuth accuracy degrades to roughly ±30° in the
frontal hemisphere. **Front/back remains unambiguous, because the cue that provides it is a filter,
not a spatializer.** That is the design's whole insurance policy against playback conditions we do
not control.

### 9.7 Graceful degradation and failure modes

- **VO missing** (`public/audio/vo/` empty, or fetch fails, or manifest absent):
  `VoiceBank.available = false`; all `audio:vo` become no-ops; **`ui:subtitle` for speech is never
  emitted, but every non-verbal caption in §7.5 still is** — a deaf player and a VO-less build must
  both remain playable, and those are independent axes.

  The `ConversationDirector` instead schedules **non-verbal camper presence**: footsteps, a zipper
  (§4.19), a flashlight click (§4.20), a cough (a 180 ms filtered-noise burst pair), and a laugh
  (a 4–7 element `grainTrain` of bandpassed noise bursts at a falling rate). It still emits
  `noise:emit { kind:'voice' }` (§4.28.3). **The stealth game loses nothing.** Ship this path as
  the default assumption and play it weekly.
- **`dispose()`** must `disconnect()` every node, `stop()` every source, clear every scheduled
  timer and `setTimeout`, null every `AudioBuffer` (baked, IR, noise, and decoded VO), and
  `close()` the context. Verify with `renderer.info.memory` unchanged and no lingering
  `AudioContext` in devtools.
- **Every consumer null-checks:** `ctx.systems.get('Audio')?.play?.(...)`. Audio registers late
  (after `Weather` and `Forest`, per `ARCHITECTURE.md` §3), so anything running in `init()` must
  assume it is not there yet.
- **No `console.log`.** `Log.debug()` only, and each degradation path logs **once per session**,
  not per occurrence.

### 9.8 Public API

```js
// src/audio/AudioEngine.js
audio.play(id, { position?, volume?, rate?, priority?, bus? }) -> handle | null
audio.stop(handle, fadeMs = 60)
audio.bus(name)                  // 'master'|'sfxWorld'|'sfxUI'|'ambience'|'music'|'vo'|'body'
audio.duck(busName, dB, attackMs, holdMs, releaseMs)
audio.setSpace(spaceId, weight)  // manual reverb override; omit to use the probe grid
audio.now()                      // AudioContext.currentTime, for schedulers
audio.stats                      // { nodeChurn, dropped, underruns, voicesActive, decodedMB }

// src/audio/ProceduralSFX.js
sfx.register(id, factoryFn)      // factoryFn(destNode, params) -> { stop(fadeMs) }
sfx.has(id) -> bool              // used by the startup assertion, §10.2
sfx.modal(exciter, modes, dest)
sfx.noise(type)                  // 'white'|'pink'|'brown' -> pooled AudioBufferSourceNode
sfx.grainTrain(opts)
sfx.frictionOsc(params)

// src/audio/Music.js
music.setDread(x)                // 0..1; asymmetric smoothing is internal
music.tell({ leadMs = 1200 })    // §6.4 — replaces v1.0's music.stinger('staple', …)
music.collapse()

// src/audio/VoiceBank.js
voice.available                  // bool
voice.say(lineId, { position, speaker }) -> handle | null
voice.conversation(topicId, speakers[], position)
voice.resolveGlob(pattern)       // 'vo_hm_*' -> a concrete STORY.md line id, or null
```

**`audio.setMask()` is removed.** v1.0 exposed it for the `mask-on` beat. The mask is not
toggleable (§2.5); its single transition is internal to `ending_c`.

Everything else in the game talks to audio through the bus (`audio:sfx`, `audio:vo`, `build:creak`,
`player:footstep`, `noise:emit`, `weather:change`, `story:beat`, `night:*`, `tool:*`).
**Do not import `AudioEngine` into gameplay code. Emit an event.**

---

## 10. Appendix A — The SFX id registry

v1.0 used four incompatible namespaces across three documents and enumerated none of them:

- **v1.0's own §4:** `creak.t1..t4`, `wood.split`, `hammer.wood`, `step.<surface>`
- **`GAME_DESIGN.md`:** `creak_tick`, `creak_groan`, `join_seat`, `join_split`, `hardware_tick`,
  `hardware_chime`, `crate_settle`, `vo_curious_*`, `vo_hm_*`
- **`STORY.md`:** `MRG_IDLE_01`, `BEV_LATE_04`, …
- **v1.0 §9.5:** `audio.play(id, …)` with no enumerated ids anywhere in 1,310 lines.

Every mismatched id is a **silent no-op at runtime** and none of them surfaces in testing. This
appendix is the complete registry.

### 10.1 The registry

**Ids marked ⚑ come from `GAME_DESIGN.md` and must not be renamed by the audio agent.**

| id | Emitted by | Recipe | LIVE/BAKED | Bus | Prio | Family cap | Accompanying `noise:emit` |
|---|---|---|---|---|---|---|---|
| `crate_settle` ⚑ | NightManager (N1 t=0) | §4.28.5 | LIVE | sfxWorld | 3 | 1 | — |
| `step_needles` | Player | §4.1 | hybrid | sfxWorld | 3 | 6 | `footstep` |
| `step_mud` | Player | §4.1 | hybrid | sfxWorld | 3 | 6 | `footstep` (×0.60) |
| `step_grass` | Player | §4.1 | hybrid | sfxWorld | 3 | 6 | `footstep` (×1.10) |
| `step_gravel` | Player | §4.1 | hybrid | sfxWorld | 3 | 6 | `footstep` (×1.70) |
| `step_wood` | Player | §4.1 | hybrid | sfxWorld | 3 | 6 | `footstep` (×1.25) |
| `step_tin` | Player | §4.1 | hybrid | sfxWorld | 3 | 6 | `footstep` (×2.40) |
| `brush_foliage` | Physics | §4.21.2 | LIVE | sfxWorld | 0 | 3 | `brush` |
| `twig_snap` | Physics | §4.21.1 | LIVE | sfxWorld | 2 | 3 | `brush` |
| `lantern_hiss` | Flashlight | §4.2 | LIVE (loop) | sfxWorld | 1 | 1 | — |
| `lantern_squeak` | Flashlight | §4.2 | LIVE | sfxWorld | 1 | 2 | — (rides the footstep) |
| `lantern_rattle` | Flashlight | §4.2 | BAKED | sfxWorld | 0 | 5 | — |
| `lantern_click` | Flashlight | §4.20 | LIVE | sfxWorld | 2 | 1 | `brush` r=5 (C4) |
| `lumber_hoist` | BuildSystem | §4.3 | LIVE | sfxWorld | 2 | 1 | — |
| `drag_lumber` | BuildSystem | §4.3 | LIVE (loop) | sfxWorld | 2 | 1 | `drag` |
| `drop_lumber` | BuildSystem | §4.3 | LIVE | sfxWorld | 2 | 2 | `drop` B/C/D |
| `drop_hardware` | BuildSystem | §4.6 | LIVE+BAKED | sfxWorld | 2 | 3 | `drop` B |
| `beam_knock` | Physics | §4.3 | LIVE | sfxWorld | 2 | 2 | — |
| `carry_bump` | Physics | §4.3 | LIVE | sfxWorld | 2 | 2 | `impact` |
| `hammer_tap` | BuildSystem | §4.4, §4.7 | LIVE | sfxWorld | 3 | 2 | `hammer` |
| `hammer_steel` | BuildSystem | §4.5 | LIVE | sfxWorld | 3 | 2 | `hammer` |
| `join_seat` ⚑ | BuildSystem | §4.9 | LIVE | sfxWorld | 3 | 2 | — |
| `join_grind` | AudioEngine | §4.9.1 | LIVE | sfxWorld | 3 | 2 | — |
| `join_dimple` | BuildSystem | §4.7.3 | LIVE | sfxWorld | 3 | 1 | — |
| `join_split` ⚑ | BuildSystem | §4.8 | LIVE | sfxWorld | 3 | 1 | `impact` |
| `join_remove` | BuildSystem | §4.10 | LIVE | sfxWorld | 2 | 1 | `wrench` |
| `pry_force` | BuildSystem | §4.11 | LIVE | sfxWorld | 3 | 1 | `impact` (at 1400 ms) |
| `creak_tick` ⚑ | BuildSystem | §4.12.3 (tiers 1–2) | LIVE | sfxWorld | 3 | 3 / **5 cascade** | `creak` |
| `creak_groan` ⚑ | BuildSystem | §4.12.3 (tiers 3–4) | LIVE | sfxWorld | 3 | 3 / **5 cascade** | `creak` |
| `creak_dead_knock` | AudioEngine | §4.12.4 | LIVE | sfxWorld | 3 | 1 | — |
| `saw_stroke` | BuildSystem | §4.13 | LIVE+BAKED | sfxWorld | 2 | 1 | `hammer` (interim, **C1**) |
| `shim_set` | BuildSystem | §4.24 | LIVE | sfxWorld | 2 | 1 | — |
| `tallow_apply` | BuildSystem | §4.24 | LIVE | sfxWorld | 2 | 1 | — |
| `felt_press` | BuildSystem | §4.24 | LIVE | sfxWorld | 2 | 1 | — |
| `dig_stroke` | BuildSystem | §4.24 | LIVE+BAKED | sfxWorld | 2 | 1 | `brush` |
| `throw_release` | Player | §4.22 | LIVE | **body** | 2 | 1 | — |
| `throw_impact` | Player | §4.22 | LIVE+BAKED | sfxWorld | 2 | 2 | `throw` (at impact pt) |
| `ladder_rung` | Player | §4.23 | LIVE | sfxWorld | 2 | 3 | `footstep` |
| `rope_haul` | BuildSystem | §4.23 | LIVE | sfxWorld | 2 | 1 | — |
| `rope_creak` | BuildSystem | §4.23 | LIVE | sfxWorld | 1 | 1 | — |
| `canoe_groan` | BuildSystem | §4.23 | LIVE | sfxWorld | 1 | 1 | — |
| `hardware_tick` ⚑ | AudioEngine (t+90 s) | §4.28.1 | LIVE | sfxWorld | 1 | 1 | — |
| `hardware_chime` ⚑ | BuildSystem (`tool:found`) | §4.25.2 | LIVE | **sfxUI** | 3 | 1 | — |
| `stage_chime` | AudioEngine (S6) | §4.25.3 | LIVE | **sfxUI** | 3 | 1 | — |
| `manual_tick` | Music / Menu / AudioEngine | §4.25.1 | LIVE | **sfxUI** | 3 | 1 | — |
| `manual_page` | BlueprintUI | §4.28.5 | LIVE | **sfxUI** | 3 | 1 | — |
| `manual_stroke` | NightManager (`ending_a`) | §4.28.4 | LIVE | **sfxUI** | 3 | 1 | — |
| `grab_sequence` | Campers | §4.26.1–3 | LIVE | sfxWorld | 3 | 1 | `brush` ×n, `drop` C |
| `drag_body` | Player | §4.26.4 | LIVE (loop) | sfxWorld | 2 | 1 | `drag` |
| `body_water` | Player | §4.26.5 | LIVE+BAKED | sfxWorld | 2 | 1 | `drop` C |
| `camper_whistle` | Campers | §4.28.2 | LIVE | sfxWorld | 3 | 2 | `whistle` |
| `camper_zipper` | Campers | §4.19 | BAKED | sfxWorld | 2 | 2 | `brush` |
| `camper_torch_click` | Campers | §4.20 | LIVE | sfxWorld | 2 | 3 | — |
| `thunder_mid` | Weather | §4.17.2 | LIVE | ambience | 3 | 1 | `thunder` |
| `thunder_far` | Weather | §4.17.2 | LIVE | ambience | 3 | 1 | `thunder` |
| `tent_flap` | Weather | §4.14 | LIVE | ambience | 1 | 3 | — |
| `bed_wind` | AmbienceDirector | §4.16 | LIVE (persistent) | ambience | 0 | 1 | — |
| `bed_room_tone` | AmbienceDirector | §5.1 | LIVE (persistent) | ambience | 0 | 1 | — |
| `bed_distance` | AmbienceDirector | §5.1 | LIVE (persistent) | ambience | 0 | 1 | — |
| `pine_whistle` | AmbienceDirector | §4.16.1 | LIVE | ambience | 1 | 1 | — |
| `rain_leaves` / `_tin` / `_water` | Weather | §4.15 | LIVE bed + BAKED grains | ambience | 0 | 1 each | — |
| `cricket_chorus` | AmbienceDirector | §5.2 | BAKED | ambience | 0 | 4 panners | — |
| `cricket_bed` | AmbienceDirector | §5.2.2 | LIVE (persistent) | ambience | 0 | 1 | — |
| `loon_wail` / `loon_tremolo` | AmbienceDirector | §5.3.1 | LIVE | ambience | 1 | 1 | — |
| `owl_hoots` | AmbienceDirector | §5.3.2 | LIVE | ambience | 1 | 1 | — |
| `campfire` | AmbienceDirector | §4.18 | LIVE bed + BAKED grains | ambience | 1 | 1 | — |
| `camp_radio` | Music | §5.3.3 | LIVE | ambience | 1 | 1 | — |
| `dawn_sparrow` | AmbienceDirector | §8 S11 | LIVE | ambience | 1 | 1 | — |
| `mask_plate` | AudioEngine | §2.5.2 | LIVE | **body** | 2 | 2 | — |
| `breath` | AudioEngine | §4.27.1 | LIVE (persistent) | **body** | 3 | 1 | `brush` when HEAVY (**C4**) |
| `breath_catch` | AudioEngine (`n7_final`) | §4.27.3 | LIVE | **body** | 3 | 1 | — |
| `heartbeat` | AudioEngine | §4.27.2 | LIVE | **body** | 3 | 1 | — |
| `hand_wipe` | BlueprintUI | §4.27.4 | LIVE | **body** | 3 | 1 | — |
| `tool_roll_tick` | Player | §4.27.5 | LIVE | **body** | 0 | 1 | — |
| `tool_roll_open` | BuildSystem | §4.27.5 | LIVE | **body** | 3 | 1 | — |
| `ending_bus` | NightManager (`ending_c`) | §4.28.4 | LIVE | sfxWorld | 3 | 1 | — |

**Two annotations that are part of the contract, not commentary:**

- `join_grind` — `PAIRS_WITH: join_seat`. It never plays alone.
- **Wrong-slot placement plays `join_seat` and nothing else.** `MUST_BE_IDENTICAL_TO: join_seat` —
  same recipe, same level, same send, no variant, no seed change. See §4.9. Any engineer who adds
  a differentiating detail here removes grammars G4 and G5 from the game.

### 10.2 The startup assertion

```js
// AudioEngine.init(), after all factories are registered:
const emitted = REGISTRY_IDS;                 // this appendix, as a frozen array
const missing = emitted.filter(id => !sfx.has(id));
if (missing.length) Log.debug(`[audio] unregistered ids: ${missing.join(', ')}`);

// And at runtime, on the bus, once per unknown id per session:
bus.on('audio:sfx', ({ id }) => {
  if (!sfx.has(id) && !warned.has(id)) { warned.add(id); Log.debug(`[audio] unknown sfx id: ${id}`); }
});
```

Same pattern for `audio:vo`: any id that is neither a `STORY.md` line id nor a resolvable glob
(§7.4.3) logs once. **The failure mode this replaces is total silence with no error**, which is
undetectable in playtest and is exactly what v1.0 would have shipped.

---

## 11. Appendix B — The verification harness

Three tools in `tools/`, all run in CI, all failing the build rather than warning.

### 11.1 `tools/loudness-check.mjs` — BS.1770-4

**What it does.** Renders a scripted 10-minute night headlessly through `AudioEngine` into an
`OfflineAudioContext`, then measures.

**The K-weighting pre-filter**, two cascaded biquads. **These coefficients are for 48 kHz only**
and must be re-derived from the standard's analogue prototypes at any other rate — a rate-specific
constant in a document that is otherwise rate-independent, flagged here because getting it wrong
produces a plausible-looking number that is quietly wrong:

```js
// Stage 1 — high-shelf, +4 dB @ ~1681 Hz, fs = 48000
{ b: [ 1.53512485958697, -2.69169618940638,  1.19839281085285],
  a: [ 1.0,              -1.69065929318241,  0.73248077421585] }
// Stage 2 — RLB high-pass, fs = 48000
{ b: [ 1.0,              -2.0,               1.0             ],
  a: [ 1.0,              -1.99004745483398,  0.99007225036621] }
```

**The measurement.** 400 ms blocks, 75% overlap (100 ms hop). Per block,
`z_i = mean(y²)` per channel; `L = -0.691 + 10·log10(Σ G_i·z_i)` with `G_L = G_R = 1.0` for stereo.
Absolute gate at **−70 LUFS**; relative gate at **−10 LU** below the absolute-gated mean; integrated
loudness is the mean of the surviving blocks.

**True peak** via 4× oversampling (a 4-phase polyphase FIR) and taking the maximum absolute sample.

| Assertion | Threshold |
|---|---|
| Integrated loudness | **−22 LUFS ± 1.5 LU** |
| True peak | **≤ −1.5 dBTP** |
| Momentary max, non-thunder | ≤ −9 LUFS(M) |
| §4.17.3 masking invariant | thunder's 500 Hz–4 kHz band loudness ≥ that of a `hammer` tap at 12 m, for the whole interval where `maskLevel() > 0.5` |
| Silence rules | S1 = 2.2 s ± 30 ms below −70 dBFS; S6 = 1.4 s ± 30 ms; S7 = 900 ms of **true digital zero** |

**Scenes** (all seeded, all deterministic per `ARCHITECTURE.md` §6):
`quiet_build`, `storm_night5`, `cascade`, `chase`, `night1_script` (the `GAME_DESIGN.md` §11
minute-by-minute, which doubles as a regression test for the tutorial's audio beats),
`ending_c`.

### 11.2 `tools/audio-registry-check.mjs`

1. Greps `src/` for every `audio:sfx` id literal and every `audio.play(...)` call site; asserts each
   resolves to a §10.1 row. **Fails on any unknown id.**
2. Greps for every `audio:vo` id; asserts each is a `STORY.md` §6 line id or a registered glob.
3. **Re-derives §1.3 and §4.12.2 from `GAME_DESIGN.md`** by parsing its §4.2 and §3.1 tables, and
   fails on any drift in `kind`, `radius`, or `intensity`. This is the mechanism that makes §0.1's
   precedence ladder real rather than aspirational, and it is the single check that would have
   caught the largest class of v1.0's defects.
4. Asserts every §10.1 row's `noise:emit` column names only canonical kinds — **except** rows
   annotated with an open conflict id (`C1`, `C4`), which are allowed and reported as a reminder.

### 11.3 `tools/node-churn-check.mjs`

Headless 60 s worst-case scene: `quality: 'ultra'`, storm with six strikes, a five-creak cascade,
five campers with active VO, the player sprinting on gravel while carrying class D. Asserts:

| Metric | Budget |
|---|---|
| `stats.nodeChurn` peak (1 s window) | ≤ 120 |
| `stats.dropped` | 0 for any voice of priority ≥ 2 |
| `stats.underruns` | 0 |
| Peak concurrent voices | ≤ 96 |
| Peak 3D panners | ≤ 56 |
| `AudioEngine.update()` mean / p99 | ≤ 0.35 ms / ≤ 0.9 ms |
| Chorus duty cycle (§5.4.2) | ≥ 70% of any rolling 60 s window |

### 11.4 What is verified by ear, and by whom

Not everything is a number. These belong to playtest and are listed so they are not assumed:

- **Habituation** (§1.4): at 3:20 of the Night-1 script, do most players crouch without being told?
- **The flinch** (`GAME_DESIGN.md` §11 t=4:39): at the first creak, does the player physically
  react and immediately understand that a badly-built cabin tells on them? The design document
  says the sequence must be retuned until they do.
- **The band tap** (§4.7.2): can a player who has never seen the bar find the clean tap by ear, at
  25 m, in rain, on laptop speakers?
- **On vs off** (§4.20): is the 6% flashlight-click difference legible at 25 m through rain?
- **The wipe** (§4.27.4): on Night Four, does anyone notice? Does anyone say *why*?
- **The chime** (§4.25.3): by Night Six, does a playtester say "the chime sounds off tonight"?
  Can they say why? The second answer should be no.

---

## 12. The One-Paragraph Version

The forest is warm, dense, and endlessly detailed, and it is built entirely so that we can switch
it off. The player is a very large man breathing inside a cracked porcelain plate he cut from his
mother's kitchen twenty-two years ago, and the rain drums on it, and he never says a word. He
carries a hissing lantern that squeaks when he hurries and rattles when he steps hard, and a tool
roll that has been tied so carefully it makes no sound at all. Wood tells him whether he did it
right — a seated join thumps, a rotated one grinds for four-tenths of a second under the thump and
most players will miss it, a wrong-slot join sounds exactly like a perfect one and will not be
discovered for another twenty minutes, and a badly wrong one takes two and a half seconds to die in
front of him. He hammers six times per join and the fourth strike is the only one that does not
buzz. Somewhere across the lake a loon screams, but only when something has disturbed the water,
and a radio plays something cheerful four cents sharp of everything else in the game. The crickets
are a proximity sensor and everybody learns it within ten minutes without being told, and once a
body is found they try to come back, once, and fail. Three times a night the world stops
completely: when the night begins, when he finishes a stage and a clean little furniture-commercial
chime plays in a room that does not exist — and by Night Six that chime is a tritone, forty cents
flat, drawn by a man who is not as good at it as his mother was — and when someone sees him. He
wipes his hands on his thighs before he touches the paper, two strokes, unhurried, and on Night
Four the timing does not change. Nothing in this game ever winks. The manual is the comedian; the
woods are dead serious; and the silence does most of the work.





