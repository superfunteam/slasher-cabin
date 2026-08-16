# Slasher Cabin: Some Assembly Required — Audio Direction Bible

**Owner:** Audio agent (`src/audio/AudioEngine.js`, `src/audio/ProceduralSFX.js`, `src/audio/Music.js`, `src/audio/VoiceBank.js`, `tools/generate-voices.mjs`)
**Binding on:** anyone emitting `audio:sfx`, `audio:vo`, `noise:emit`, `build:creak`, `player:footstep`.
**Companion docs:** `ARCHITECTURE.md` (contract), `ART_DIRECTION.md` (mood).

Everything in this document is synthesized in WebAudio at runtime. There are **no sample files**.
The only fetched audio in the entire game is ElevenLabs VO in `public/audio/vo/`, and the game
must be fully playable and fully atmospheric with that directory empty.

Every recipe below is written to be implemented directly. Frequencies are in Hz, times in ms
unless stated, gains in dB relative to the source's own peak unless stated. Assume
`ctx.sampleRate` of 48000 but never hard-code it — all values are specified in Hz/seconds so the
graph is sample-rate independent.

---

## 1. The Thesis

### 1.1 Sound is the UI

This is a stealth game with almost no HUD. The HUD we do have is a flat-pack instruction manual,
which is a joke, not an interface. Therefore **every gameplay-relevant state change must be
legible by ear alone, with the eyes closed, in under 250 ms.** If a player cannot tell the
difference between "that bracket seated correctly" and "that bracket did not seat correctly"
without looking at anything, the sound design has failed and the game is broken.

Four things must be readable purely by ear:

1. **Where a camper is** — azimuth to within ~15°, distance to within ~30%.
2. **Whether a camper heard you** — the cricket cut (§5.4) and the VO turn (§7).
3. **Whether a build action was correct** — the seat vs. the creak (§4.9, §4.11).
4. **How loud you just were** — every `noise:emit` has a mandatory audible signature whose
   perceived loudness is monotonic in `intensity` (§1.3).

### 1.2 Spectral zoning — carve the bed for gameplay

Legibility is a mixing problem before it is a synthesis problem. We reserve bands:

| Band | Hz | Owner | Rule |
|---|---|---|---|
| Sub | 20–80 | heartbeat, thunder, dropped beams, the low D of the score | Only one sub source may exceed −18 dBFS at a time. Sidechain the rest. |
| Low-mid | 80–350 | footsteps, wood body, hoists, tent whump | The "body" band. Ambience is allowed here but stays under −30 dB. |
| Voice | 350–1500 | camper VO, the player's breath | Nothing else lives here loud. Music pads are notched here −5 dB whenever any VO is active. |
| **Danger** | **1500–5000** | **creaks, twig snaps, metal, glass, bracket drops** | **Reserved.** The ambience bed carries a permanent peaking filter, `f=3100, Q=0.9, gain=−4 dB`, so every gameplay-critical transient cuts through the forest without needing to be louder. |
| Air | 5000–16000 | rain hiss, wind sizzle, cricket top, lantern glass | Freely shared. Duck it first when headroom is needed. |

### 1.3 The `noise:emit` ↔ audible loudness contract

Anything that emits `noise:emit` **must** also produce sound whose loudness at 1 m matches this
table. This is a contract: AI-audible noise and player-audible noise are the same number, so the
player can always calibrate their own risk by listening.

| `kind` | `intensity` | dB SPL-equivalent at 1 m (our internal scale, 0 dB = full scale peak) | sfx id |
|---|---|---|---|
| `footstep-crouch` | 0.05 | −34 | `step.<surface>` @ rate 0.85 |
| `footstep-walk` | 0.18 | −24 | `step.<surface>` |
| `footstep-run` | 0.42 | −16 | `step.<surface>` @ rate 1.12 |
| `drag` | 0.30 | −20 | `lumber.drag` |
| `drop-light` | 0.35 | −18 | `bracket.drop.rock` |
| `drop-heavy` | 0.72 | −9 | `lumber.drop` |
| `hammer-wood` | 0.55 | −13 | `hammer.wood` |
| `hammer-steel` | 0.80 | −7 | `hammer.steel` |
| `creak` | 0.15 · tier² | see §4.11 | `creak.t1..t4` |
| `split` | 0.90 | −5 | `wood.split` |

### 1.4 The horror is the negative space

The scariest thing in this game is not a sound. It is the **removal** of a sound the player had
stopped noticing. Our forest bed is deliberately dense, warm, and busy so that its absence is a
physical event. The design target: within the first three minutes of Night 1 the player should
have fully habituated to the crickets, and the first time they stop, the player should feel it in
their stomach before they consciously register it.

Every section of this document should be read with that priority: **we build the bed in order to
be able to take it away.** §8 (Silence Rules) is the most important section and the rest of the
document exists to serve it.

---

## 2. The Mix

### 2.1 Bus architecture

```
                                   ┌──────────────┐
  sfxWorld ──┬──▶ [sfxComp] ───────┤              │
  sfxUI ─────┴────(dry, no verb)───┤              │
  ambience ────▶ [ambDuck] ────────┤   master     │──▶ [maskFilter] ──▶ [masterLimiter] ──▶ dest
  music ───────▶ [musicDuck] ──────┤   (gain)     │
  vo ──────────▶ [voFilterChain] ──┤              │
  body ────────▶ (breath/heart) ───┤              │
                                   └──────────────┘
        │                │
        └── sendA ──▶ [convolverA] ─┐
        └── sendB ──▶ [convolverB] ─┴──▶ [verbReturn] ──▶ master
```

- `sfxWorld` — everything 3D. Gets reverb sends.
- `sfxUI` — the blueprint manual, the toast chime, menu. **Dry, mono, centred, no reverb, no
  distance, always the exact same level.** This is a tonal weapon: the manual sounds like it is
  playing in a different, cleaner universe. Never process it with `maskFilter`.
- `ambience` — bed, weather, crickets, distant camp.
- `music` — the generative score (§6).
- `vo` — ElevenLabs lines. Gets its own filter chain (§7.2) and reverb send.
- `body` — breath and heartbeat. **Not spatialized, not reverbed, never masked** except by the
  mask filter. It is inside the player's skull.

Gain nodes for every bus are exposed as `AudioEngine.bus(name)`. Volume settings map:
`master = settings.masterVolume`, `sfxWorld/sfxUI/body = settings.sfxVolume`,
`music = settings.musicVolume`, `vo = settings.voiceVolume`, `ambience = settings.sfxVolume * 0.9`.

### 2.2 Loudness and dynamic range

- **Integrated target: −16 LUFS** over a full night. True peak ceiling **−1.5 dBTP**.
- **We refuse to be loudness-normalized flat.** Momentary loudness targets by phase:

| Phase / state | Momentary LUFS |
|---|---|
| `phase:'briefing'` (blueprint open) | −26 |
| Quiet build, no threat | −24 to −20 |
| Camper audible in distance | −20 |
| Held breath (§2.4) | **−34** |
| Creak tier 4 | −9 momentary peak |
| Chase (`phase:'chase'`) | −12 |
| Thunder crack | −8, ≤ 900 ms |

That is a 26 LU working range. It is aggressive on purpose. The `masterLimiter` is a
`DynamicsCompressorNode`: `threshold −6`, `knee 2`, `ratio 12`, `attack 0.003`, `release 0.18`.
It exists as a safety net, not as a sound. If it is pumping audibly, a source is too loud.

`sfxComp` is a gentle glue compressor on world SFX only: `threshold −18, knee 12, ratio 2.4,
attack 0.010, release 0.25`. Music and ambience are **not** compressed — their dynamics are the
point.

### 2.3 Ducking rules

Implemented as `AudioEngine.duck(busName, dB, attackMs, holdMs, releaseMs)` using
`setTargetAtTime` with `timeConstant = attackMs/3000`.

| Trigger | Target | Amount | A / H / R (ms) |
|---|---|---|---|
| `build:creak` severity ≥ 0.5 | `music`, `ambience` | −12, −8 | 40 / 300 / 1200 |
| `build:place` `correct:false` | ALL except the creak | −18 | 20 / 180 / 900 |
| Thunder crack | `ambience` | −5 | 5 / 200 / 1400 |
| Lightning flash (pre-thunder) | everything but rain | −14 | 10 / 110 / 260 |
| `ui:blueprint-open` | `ambience`, `music`, `sfxWorld` | −9, −14, −6 | 180 / — / 400 |
| `player:spotted` | see §2.4 | | |

**Hard rule: VO never ducks anything.** Camper voice is atmosphere. The moment music dips for a
line, the line becomes a narrator, and the creator has forbidden narration. The only concession:
when `vo` is active, the music pad's 350–1500 Hz band is notched −5 dB by a peaking filter
(`f=760, Q=0.7`) so voices sit in a pocket without the mix visibly moving.

### 2.4 The Held Breath

Fired on `player:spotted` with `level > 0.35`, or when `state.suspicion > 0.6` and any camper's
search target is within 12 m of the player. This is the signature mix move of the game.

Over 700 ms, in parallel:

1. `ambience` → −14 dB, and a `BiquadFilterNode` lowpass on the ambience bus sweeps
   `6500 → 2200 Hz` (`setTargetAtTime`, τ = 0.23).
2. `music` mutes every layer except one sustained bowed-metal partial (§6.2) held at −22 dB.
3. Breathing (§4.19) switches to `HELD`: the breath cycle stops entirely for
   `2.5 + rand(0,3.5)` seconds. **No breath sound at all.** Then one controlled, tight,
   high-passed exhale.
4. Heartbeat (§4.20) rises +9 dB and its lowpass opens `200 → 420 Hz`, so you feel the transient
   edge of the thump rather than just the sub.
5. `masterLimiter.threshold` drops to −12 and `sfxComp.threshold` to −26 — meaning any *real*
   world sound (a twig, a creak, a camper's boot) that happens during the held breath punches
   through into an enormous, empty hole and sounds twice as loud as it is.

Release when `player:hidden` fires, or 6 s after last detection: restore over 2600 ms with a
noticeably slower ambience return (τ = 0.9) than the breath return (τ = 0.3), so the player's body
recovers before the world does.

### 2.5 The mask filter

The player wears a mask from Night 2 (`story:beat` id `mask-on`). From that beat forward,
`maskFilter` is inserted on master (before the limiter) and applies to **everything except
`sfxUI` and the pause menu**:

```
lowpass  f=3400, Q=0.6
peaking  f=680,  Q=1.1, gain=+3.5 dB      // the boxy chest resonance inside the shell
notch    f=1900, Q=2.2, gain=-4 dB        // the "cupped hands" dip
delay 0.42 ms → gain 0.32 → sum           // a subtle comb; nulls near 1.2k/3.6k
highshelf f=9000, gain=-6 dB
```

The comb is what sells it. Blend the whole chain in at 82% wet on `ultra`/`high`; at `medium`
drop the comb delay; at `low` use lowpass + highshelf only (`settings.tier`). Crossfade the mask
in over **1400 ms** on the `mask-on` beat, with 400 ms of near-total silence first (§8.10).

---

## 3. 3D Audio

### 3.1 Panner setup

`AudioContext.listener` is driven from `ctx.camera` every frame using the modern
`positionX/Y/Z`, `forwardX/Y/Z`, `upX/Y/Z` `AudioParam`s with
`setTargetAtTime(v, now, 0.02)` — never `setPosition()`, and never instantaneous jumps, which
cause zipper noise on HRTF convolution.

Per-source `PannerNode`:

```js
panner.panningModel   = settings.tier('equalpower','equalpower','HRTF','HRTF');
panner.distanceModel  = 'inverse';
panner.refDistance    = 1.4;      // metres
panner.maxDistance    = 140;
panner.rolloffFactor  = 1.15;     // world SFX
```

Rolloff by class: world SFX `1.15`; camper VO `0.85` (carries further — you should hear them
before you can understand them); campfire and lake `0.6`; thunder is **not** panned by distance
at all (it is a 2D stereo source with a manual pan, because a 4 km source has no parallax).

Cones for directional emitters (a camper's mouth, the tin roof under rain):
`coneInnerAngle 90, coneOuterAngle 240, coneOuterGain 0.35`. A camper facing away is quieter and
darker — that is a gameplay tell.

Vertical: WebAudio HRTF elevation cues are weak. We fake elevation with a shelf: sources more
than 2 m above the listener get `highshelf f=7000, gain=+3`; below, `−4`. Cheap and it works.

### 3.2 Occlusion

Owned by `AudioEngine`, informed by `NoiseSystem` where available (null-check
`ctx.systems.get('NoiseSystem')`). Each 3D source has a two-path structure:

```
source ──┬──▶ [directLPF] ──▶ [directGain] ──▶ panner ──▶ sfxWorld
         └──▶ [bleedLPF 400Hz] ──▶ [bleedGain] ──▶ panner
```

The **direct path** is occluded. The **bleed path** models diffraction around the occluder: it is
always present at `−12 dB · directGain⁻¹`-ish, lowpassed hard at 400 Hz, so a sound behind a
cabin wall never fully vanishes — it becomes a dull thud with no location. That "I heard
something but I don't know where" quality is the entire feel of the game.

Occluder thickness accumulates along the listener→source ray in metres of *effective* material:

| Occluder | Effective thickness contribution |
|---|---|
| Pine trunk (per trunk hit) | 0.35 |
| Canopy / undergrowth | 0.10 per metre of path inside the volume |
| Terrain ridge | 4.0 (hard block) |
| Cabin wall, single board layer | 0.55 |
| Cabin wall, sheathed | 1.20 |
| Tent canvas | 0.18 |
| Water surface | 0.0 (water *helps* — see §3.3) |

Then:

```
fc      = clamp(18000 * Math.exp(-0.55 * T), 180, 18000)   // Hz, T = effective metres
gainDb  = -3.2 * T                                          // clamp to -34
bleedDb = -14 - 1.1 * T                                     // clamp to -40
```

So one tree = 14.9 kHz / −1.1 dB (barely anything, correctly). A sheathed cabin wall = 9.3 kHz /
−3.8 dB. A ridge = 2.0 kHz / −12.8 dB. Three walls of the finished cabin = 1.2 kHz / −20 dB plus
bleed. Smooth all three values with `setTargetAtTime(τ=0.08)` so a camper walking behind a tree
sweeps rather than steps.

**Raycast budget.** `ARCHITECTURE.md` §12 caps the whole game at 12 raycasts/frame.
`AudioEngine` may use **at most 3**, via `Physics.raycast()`. Occlusion results are cached per
source for 120 ms and sources are updated round-robin by priority (nearest and loudest first).
Sources beyond 45 m use a cheap analytic estimate from the forest density grid instead of a ray.

### 3.3 Reverb: five spaces

Five impulse responses, **procedurally generated in an `OfflineAudioContext` during
`AudioEngine.init()`** (budget: < 120 ms total, generate at 24 kHz and let the ConvolverNode
resample on `low`/`medium`). Generation recipe for each: noise → per-band exponential decay
envelopes (4 bands, crossed at 250/1200/5000 Hz, each with its own RT60) → a sparse set of early
reflection taps prepended → normalize to unity RMS.

| Space | RT60 (low/mid/high) | Early taps | Character notes |
|---|---|---|---|
| `OPEN_FOREST` | 0.90 / 0.55 / 0.22 s | 6 taps, 11–48 ms, −9 dB | Almost no early energy, dark tail. Should read as "outside" not "room". |
| `DENSE_TREES` | 1.35 / 0.95 / 0.30 s | 22 taps, 6–70 ms, −5 dB, randomized pan | Scatter. High band dies fast — foliage is a lowpass. |
| `CABIN_SHELL` | 0.55 / 0.62 / 0.40 s | 9 taps, 3–26 ms, −2 dB | Boxy. Add two resonant modes at 118 Hz and 187 Hz (Q 9) baked into the IR — the half-built frame *rings*. As stages complete, crossfade toward a version with RT60 +0.25 s and modes +6 dB. **The cabin's reverb is a progress meter.** |
| `LAKE_EDGE` | 2.40 / 2.10 / 1.10 s | 3 taps + one **discrete slap at 240 ms, −11 dB**, hard-panned to the far shore | Bright, long, unnatural. Water reflects specularly. This slap is why you can hear the camp from across the lake. |
| `TIN_ROOF` | 0.40 / 0.55 / 0.75 s | 14 taps, 1–18 ms | Inverted spectrum: the high band rings *longer*. Add a comb at 3.1 ms, feedback 0.5. Only active when the roof stage is built and the player is under it. |

**Only two `ConvolverNode`s exist at any time** (`convolverA`, `convolverB`). A spatial probe
grid (8 m cells, precomputed at world gen, stored as a byte per cell = space id) is sampled at
the listener position. When the dominant space changes, load the new IR into whichever convolver
is idle and equal-power crossfade over **900 ms** (`cos/sin` law on the two return gains). If the
change is caused by ducking under the roof or stepping inside the cabin shell, shorten to
**250 ms** — architectural transitions are abrupt, environmental ones are gradual.

Per-bus send levels: `sfxWorld 0.22`, `vo 0.18` at close range rising to `0.85` at 40 m (§7.2),
`ambience 0.10`, `music 0.35` (the score lives in the same forest as the player), `sfxUI 0.0`,
`body 0.0`.

At `settings.quality === 'low'`: one convolver, one IR (a blend of `OPEN_FOREST` and
`DENSE_TREES`), no crossfade — just a send level change.

---

## 4. The SFX Cookbook

### 4.0 Shared primitives (build these first, in `ProceduralSFX.js`)

**`NOISE`** — three 4.0 s stereo `AudioBuffer`s generated once at init: white, pink (Voss-McCartney,
16 octaves), brown (leaky integrator, `y[n] = 0.996·y[n-1] + 0.03·w[n]`, DC-blocked). Every noise
source is a `AudioBufferSourceNode` on one of these three buffers with `loop = true`, a random
`loopStart` offset, and `detune` in ±120 cents. **Never allocate a new noise buffer at runtime.**

**`impulse(dur)`** — a 1-sample-hot buffer, or better, a 2 ms noise burst with a linear ramp-down.
Used to excite modal banks.

**`modal(exciter, modes[])`** — the workhorse. `modes[]` is a list of
`{ f, Q, gain, decayMs }`. Each mode is a `BiquadFilterNode` `type='bandpass'` with `frequency=f`,
`Q=Q`, fed in parallel from the exciter, each into its own `GainNode` whose value is set to
`gain` and then `exponentialRampToValueAtTime(0.0001, now + decayMs/1000)`. Sum to output. This
one function produces every impact, ping, knock, clack, and body resonance in the game.

**`grainTrain(rate, jitter, dur, grainFn)`** — schedules `grainFn` at `1/rate` intervals with
`±jitter` uniform timing noise. Used for gravel, rain, crackle, ratchets, zippers.

**`frictionOsc(params)`** — the stick-slip model behind every creak, squeak, and drag. See §4.11.

**Envelope minimums.** Never `gain.value = 0`. Never a hard start. Every voice opens with a
`linearRampToValueAtTime` of **≥ 4 ms** and closes with **≥ 8 ms** (exponential to 0.0001, then
`setValueAtTime(0)`). This is not optional; it is the difference between a game and a clickfest.

---

### 4.1 Footsteps

Common structure for all surfaces: `[IMPACT] + [MATERIAL] + [TAIL]`, total 60–260 ms, triggered
by `player:footstep` with `{ surface, loud }`. `loud` scales gain and, critically, **the material
layer's grain count** — a heavy step displaces more material. Randomize `detune` ±140 cents and
material grain timing per step; never play the same step twice. Left/right foot alternate with a
−1.5 semitone / +1.5 semitone bias so the gait has a limp-free but organic asymmetry.

**Pine needles** (the default forest floor)
- IMPACT: brown noise, 18 ms, lowpass `f=220 Q=0.7`, env `A 2 / D 16` exp. −18 dB.
- MATERIAL: `grainTrain(rate=180, jitter=0.6, dur=55ms)`, 6–11 grains. Each grain: white noise
  4 ms through bandpass `f = 2400·(1 + rand(-0.35,0.6))`, `Q=3.5`, exp decay 9 ms.
- TAIL: pink noise 90 ms, highpass 1800, bandpass `f=3600 Q=0.8`, env `A 4 / D 86`, −24 dB.
  This is the *dry rustle* — it is what makes needles read as needles.

**Mud**
- IMPACT: brown noise 30 ms, lowpass sweeping `900 → 260` over 40 ms, `Q=1.4`. −10 dB.
- MATERIAL: **the suck.** A bandpass `f` sweeping **upward** `180 → 620 Hz` over 130 ms with
  `Q = 7`, fed by pink noise at −16 dB with an env `A 30 / D 100`. The rising resonance on the
  *lift* is the entire signature of mud. Trigger the suck 40 ms after the impact.
- TAIL: none. Mud is a dead surface — that is why it is the safest floor in the game. Total
  `noise:emit` intensity for mud is **0.6× the pine value**. Teach the player this.

**Wet grass**
- IMPACT: as needles but lowpass 180, −20 dB.
- MATERIAL: `grainTrain(rate=260, jitter=0.8, dur=70ms)`, grains are 3 ms noise through bandpass
  `f = 5200·rand(0.7,1.4), Q=2.2`, decay 14 ms. Higher, wetter, sharper than needles.
- TAIL: a 120 ms noise wash, bandpass `f=900 Q=0.6`, −26 dB. The blade-slap.

**Gravel**
- IMPACT: brown noise 22 ms, lowpass 300. −12 dB.
- MATERIAL: `grainTrain(rate=95, jitter=1.0, dur=180ms)` — 9–16 grains, deliberately sparse and
  irregular. Each grain is `modal(impulse(1ms), [{f: 1200·r, Q:14, gain:1, decayMs:35},
  {f: 2900·r, Q:9, gain:0.5, decayMs:22}])` with `r = rand(0.75,1.45)`. Stones are little
  resonators, not noise. **Gravel is the loudest surface in the game** (`intensity ×1.7`) and its
  grains keep arriving for 180 ms, which means a running player on gravel emits an unbroken
  stream. This is a level-design tool.

**Sawn wood** (the cabin deck, planks, the truck bed)
- IMPACT: `modal(impulse(2ms), [{f:186,Q:26,g:1.0,d:120},{f:432,Q:34,g:0.55,d:95},
  {f:971,Q:28,g:0.30,d:62},{f:1830,Q:20,g:0.14,d:40}])`. These are the plank's flexural modes.
- BODY: a lowpassed noise thud, `f=140`, 40 ms, −14 dB — the boot itself.
- HOLLOW: if the plank is over the cabin's crawl space, add `modal` mode at `f=88, Q=7,
  decayMs=340, gain=0.4`. The cabin *booms* underfoot as it gets built. Free progression cue.

**Tin** (the roof sheets, the shed, the water tank)
- IMPACT: 6 inharmonic modes, `f = [412, 703, 1147, 1892, 2611, 4380]`, `Q = [90,120,140,160,
  150,110]`, gains `[1, .72, .55, .48, .30, .18]`, decays `[900, 780, 640, 520, 380, 240] ms`.
- PLUS a membrane boom: sine at 74 Hz, `exponentialRamp` pitch down to 58 over 180 ms, env
  `A 3 / D 200`, −8 dB.
- PLUS oil-canning: after 120 ms, 20% chance of a second `modal` hit at 0.94× the frequencies
  (the sheet pops back). Tin is a comedy surface and a suicide surface: `intensity ×2.4`.

### 4.2 The lantern

Carried at all times; it is the player's light and their liability. Three simultaneous layers,
all children of a single `PannerNode` parented to the lantern bone at ~0.9 m in front and 0.4 m
below the eye.

**Gas hiss** — pink noise → bandpass `f=2350, Q=0.85` → highshelf `f=6000, gain=−8` → gain
−38 dB. Amplitude modulated by the flame flicker: a random walk LFO (a `GainNode` driven by
`setTargetAtTime` every 60 ms to `0.85 + rand(0,0.3)`, τ=0.04) plus a tiny 11.5 Hz sine at
±0.06. Continuous, always on, and the player will stop hearing it in 90 seconds. When the lantern
is extinguished (§8.7) the hiss ramps out over 700 ms with the bandpass sweeping down to 500 —
and its absence is deafening.

**Handle squeak** — `frictionOsc` tier 1 (§4.11), gated to the swing. The lantern's bail pivots
twice per step cycle; fire a squeak at each velocity extremum **only if** `|angularVel| > 0.9
rad/s` (i.e. only when walking fast or turning hard). `f_center = 1750 · (1 + 0.4·|angVel|)`,
duration 90–180 ms, −26 dB. **The faster you move, the more you squeak.** Crouch-walk never
squeaks. This is the game's stamina-vs-stealth dial and it is entirely audible.

**Glass rattle** — on any footfall with `loud > 0.22`, fire 2–5 tiny glass pings:
`modal(impulse(0.5ms), [{f:2830·r,Q:95,g:1,d:210},{f:4410·r,Q:110,g:0.6,d:170},
{f:6920·r,Q:80,g:0.25,d:120}])` with `r = rand(0.97,1.03)`, staggered 0–35 ms apart, −30 dB.
Scale count and gain linearly with `loud`. On tin or gravel, add one more ping and +4 dB.

### 4.3 Lumber

**Hoisting** (`build:pickup` on a beam) — three layers over 900 ms:
1. Cloth/effort: pink noise, bandpass `f=1100 Q=0.8`, env `A 120 / S 300 / R 400`, −30 dB, with
   the bandpass sweeping `800 → 1400` as the beam comes up.
2. Wood groan: `frictionOsc` tier 2 at `f_center = 240`, only if the beam is > 60 kg.
3. A single low body thump at the shoulder: sine 62 Hz → 48 Hz over 120 ms, −16 dB, at the
   moment the beam seats.
Plus the player's exertion breath (§4.19) switches to `HEAVY` for 4 s.

**Dragging** — a sustained loop: brown noise → `modal` bank of the wood's 4 modes (§4.1 sawn
wood) with `Q` reduced to 8 (broad, excited continuously) → gain proportional to drag speed.
Superimpose `grainTrain(rate = 40 + 90·speed, jitter=0.9)` of 6 ms bandpass-2200 grains — the
scrape catching on stones. Cutoff of a lowpass on the whole thing tracks speed: `fc = 600 +
2400·speed`. Emits `noise:emit` continuously at `intensity = 0.12 + 0.30·speed`.

**Dropping** (`build:drop`) — the loudest routine build sound.
1. Sub: sine 58 Hz, pitch `exponentialRamp` to 41 over 90 ms, env `A 2 / D 300`, −6 dB.
2. Body: sawn-wood `modal` bank at `Q×1.4`, decays ×1.6, −4 dB.
3. Surface: fire the appropriate footstep MATERIAL layer at 2.5× grain count.
4. Bounce: 55% chance of a second, −11 dB, 0.72× amplitude hit at `t = 140 + rand(0,60) ms`, and
   a third at `t = 140·1.72` if the second fired. Restitution model: `t_{n+1} = t_n · 0.72`,
   `gain_{n+1} = gain_n · 0.45`.

**Two beams knocking** — the sound of the player fumbling. Pure `modal`:
`[{f:214,Q:40,g:1,d:180},{f:496,Q:52,g:0.7,d:150},{f:1130,Q:44,g:0.4,d:95}]` excited by a 1.5 ms
noise burst highpassed at 900. Dry, woody, almost musical. Pitch-shift the whole bank by beam
length: `f × (2.4 / lengthMetres)`. Two different beams produce two different pitches, and a
practiced player will learn which beam is in their hands by ear.

### 4.4 Hammer on wood

- TRANSIENT: 1.2 ms noise burst, highpass 2000, −6 dB. The steel face meeting the fibre.
- NAIL: `modal(same exciter, [{f:3120,Q:180,g:0.35,d:110},{f:6740,Q:140,g:0.18,d:70}])` — the
  nail shank ringing. **Its pitch rises 4% per successful strike** as the nail seats (shorter free
  length = higher mode). Three strikes to sink a nail; the pitch rise is the progress bar.
- WOOD: sawn-wood `modal` bank, `Q×0.8`, decays ×0.7, −8 dB.
- BODY: sine 96 → 71 Hz over 70 ms, −14 dB.
Total ~340 ms. `noise:emit` intensity 0.55, radius 42 m.

### 4.5 Hammer on steel (bracket, spike, the anvil in the shed)

Same transient, then:
- `modal(exciter, [{f:2130,Q:900,g:1,d:1800},{f:3910,Q:1100,g:0.75,d:1600},
  {f:5740,Q:800,g:0.5,d:1200},{f:8320,Q:600,g:0.28,d:800},{f:11200,Q:400,g:0.12,d:500}])`
- **Nonlinear pitch glide:** immediately after the strike, detune all modes by +35 cents and
  `exponentialRamp` back to 0 over 240 ms. Real struck metal goes sharp under high amplitude and
  settles. Without this, metal sounds like a synth. With it, it sounds like metal.
- Add a `WaveShaperNode` (soft clip, 3rd-order, drive 1.6) on the first 60 ms only, then bypass —
  the initial contact is nonlinear.
`noise:emit` intensity 0.80, radius 85 m. **A hammer on steel at night will be heard across the
entire lake.** The game should establish this on Night 1 and the player should never forget it.

### 4.6 Bracket dropped on rock

The comedy sound. It must be *inconveniently* charming.
- Bounce sequence: 3–5 impacts, `t_{n+1} = t_n · 0.68`, starting at `t_1 = 0`, `t_2 = 165 ms`,
  gains −0 / −7 / −13 / −19 / −25 dB.
- Each impact: steel `modal` bank (§4.5) with `d` scaled to `[220,180,150,120,90] ms` and a
  **different random detune per bounce** (±90 cents) — the bracket is tumbling, presenting
  different faces.
- Each impact also gets a rock tick: `modal(impulse(0.8ms), [{f:1700·r,Q:22,g:0.5,d:26},
  {f:4300·r,Q:16,g:0.3,d:16}])`.
- Final settle: a fast flutter — `grainTrain(rate=34→90 accelerando, dur=380ms)` of very quiet
  (−28 dB) short metal ticks, like a dropped coin coming to rest. **This tail is the joke.** The
  player has been perfectly silent for ninety seconds and now a small piece of hardware is going
  to spend nearly half a second announcing itself.

### 4.7 Screw torqued into pine

The clearest example of "sound is the UI" in the game. Duration is variable (0.9–2.2 s) and it is
a **continuous readout of torque**.

```
exciter: white noise → gain (0.4 + 0.6·torque)
       → grainTrain(rate = 26 + 34·torque, jitter = 0.35 - 0.2·torque)
grain:   3 ms noise → bandpass f = 480 + 1900·torque, Q = 5 + 9·torque → decay 22 ms
bed:     brown noise → lowpass fc = 300 + 700·torque, Q 1.2 → gain −24 dB
```

As torque climbs, the grain rate rises, the jitter falls (the bite becomes regular), and the
centre frequency sweeps up almost an octave and a half. At `torque > 0.86`:
- **Seat:** the grain train stops dead, and one `modal` thump fires:
  `[{f:158,Q:30,g:1,d:150},{f:390,Q:26,g:0.5,d:110}]` plus a tiny 4 kHz tick. That thump means
  *correct*. It is the most satisfying sound in the game and it should be mixed +2 dB louder than
  it strictly needs to be.
- **Strip** (if the player overtorques): the grain rate collapses to 8 Hz, the bandpass drops to
  400 Hz with `Q=1`, and a 260 ms noise wash plays. That means *ruined*, and it will creak.

### 4.8 Wood splitting

- Pre-crackle: `grainTrain(rate = 12 → 70 accelerando over 400 ms, jitter 1.0)`, grains =
  `modal(impulse(1ms), [{f:1900·r,Q:30,g:1,d:40},{f:3800·r,Q:24,g:0.4,d:24}])`, r=rand(0.6,1.6).
  Fibres letting go one at a time. Rising density = rising dread.
- THE CRACK: a 3 ms noise burst highpassed at 1200, −2 dB, **plus** a downward chirp: sine
  1400 → 180 Hz over 55 ms (this is the "whipcrack" of the release), **plus** the sawn-wood modal
  bank at `Q×2, gain +6 dB, decays ×2.5`.
- Tear tail: pink noise 700 ms, bandpass sweeping `2600 → 700 Hz`, `Q 1.6`, exp decay, −16 dB.
`noise:emit` intensity 0.90. This is a night-ending sound.

### 4.9 Nail pulled

`frictionOsc` tier 2–3 with an **upward** `f_center` sweep `620 → 1450 Hz` over 500 ms (the
free shank shortens as it comes out), then a terminal pop: `modal([{f:940,Q:60,g:1,d:90},
{f:2200,Q:40,g:0.6,d:60}])` plus a 25 ms noise chuff lowpassed at 700. The pop is the release.
If the player is removing a wrong part (`build:remove`), this is the sound of undoing a mistake
and it should feel like *relief* — mix it dry and close, −14 dB, with no reverb send.

### 4.10 Canvas tent flapping

Scheduled by `Weather`'s gust envelope: when `d(gust)/dt > 0.4`, fire 1–4 flaps 60–220 ms apart.
- WHUMP: white noise, 140 ms, lowpass sweeping `3200 → 380 Hz` over 120 ms with `Q=1.8`, env
  `A 6 / D 130`.
- BODY: sine 68 Hz, 60 ms, −20 dB — the pole taking the load.
- SNAP (25% chance, high gust only): 2 ms noise burst highpassed at 3000, −12 dB.
- Guy-line hum (rare, gust > 0.8): a `modal` at `f = 190·rand(0.9,1.1), Q=280, decay 1400 ms`,
  −30 dB. A tensioned line singing. One of the loveliest sounds in the game.

### 4.11 THE CREAK — the signature sound

The creak is a **stick-slip friction** phenomenon, not a filtered noise sweep, and modelling it
properly is why our creak will be better than everyone else's.

**`frictionOsc(params)` — the core model:**

```
1. SLIP CLOCK: a sub-audio sawtooth-ish random process. Implement as an AudioBufferSource on a
   procedurally generated 2 s "slip envelope" buffer, or (cheaper, preferred) as a scheduled
   sequence of gain ramps: a series of N events at times t_i, where the interval
   dt_i = dt_0 · (1 + 0.5·rand(-1,1)) and dt_0 = 1 / slipRate.
2. Each slip event: a short excitation — 1.5 ms of white noise → gain g_i.
3. RESONATOR: all excitations feed a bandpass at f_center with Q = Qc (very high, 40–260).
   f_center is modulated by the slip clock too: it ramps DOWN by `pitchDrop` cents across the
   whole event (the joint is settling under load).
4. A parallel second resonator at f_center · 1.47 (an inharmonic partner) at −8 dB gives the
   "two surfaces" quality.
5. A brown-noise bed through a lowpass at f_center/3, at −26 dB, glues it.
6. Whole thing through a gentle WaveShaper (drive 1.3) — friction is nonlinear.
```

The parameter that makes it a creak rather than a buzz is `slipRate` in the **8–90 Hz** range,
with **heavy irregularity**. Regular = a synth tone. Irregular = wood.

`build:creak` carries `{ position, severity }`. Map `severity` to four tiers. `BuildSystem` should
quantize to tiers so the sound is categorical and learnable — the player must be able to name
what they just heard.

**Tier 1 — "the tick" (severity ≤ 0.25)**
`slipRate 34, N=3, duration 90 ms, f_center 2400 → 2280, Q=70, gain −30 dB, pitchDrop 90 cents.`
Barely a sound. A single dry tick, like a house at night. `noise:emit` intensity 0.09, radius 8 m.
No mix duck. The player is *allowed* to ignore this one, and that permission is what makes tiers
3 and 4 terrifying.

**Tier 2 — "the complaint" (0.25 < severity ≤ 0.5)**
`slipRate 22, N=9, duration 420 ms, f_center 1650 → 1410, Q=110, gain −20 dB, pitchDrop 260
cents.` A short, high, unmistakable *eeuk*. Add the inharmonic partner at −8 dB.
Intensity 0.24, radius 26 m. Ducks nothing but does trigger a cricket dip (§5.4) at 40% depth.

**Tier 3 — "the groan" (0.5 < severity ≤ 0.8)**
`slipRate 13, N=17, duration 1.15 s, f_center 880 → 620, Q=160, gain −12 dB, pitchDrop 520
cents.` Now it is long enough to be a *sentence*. Add: a sub layer, sine 74 → 58 Hz over the full
duration at −22 dB; and the slip events audibly individuate — the player can count the pops.
Intensity 0.52, radius 55 m. Full mix duck (§2.3). Crickets stop for 4 s.

**Tier 4 — "the failure" (severity > 0.8)**
This one has to be genuinely awful. 2.6 s, in three movements, and it must feel like the building
is *dying*.

1. **0–900 ms, the load.** `frictionOsc`: `slipRate 9, N=8, f_center 640 → 430, Q=220, pitchDrop
   700 cents, gain −8 dB`. The slips are so slow they are individually audible as *knocks*. Under
   it, a sine at 52 Hz, rising in amplitude from −40 to −16 dB.
2. **900–1600 ms, the descent.** `f_center` continues down to **190 Hz** while `Q` climbs to 260.
   Simultaneously, a **subharmonic** appears: a second oscillator at `f_center / 2` (95 Hz),
   amplitude-modulated by the slip clock, at −14 dB. This subharmonic is the psychoacoustic
   nastiness — it is the sound of something too big making a sound too low for its size. Add a
   slow 5.5 Hz tremolo (±4 dB) so it *wobbles*.
3. **1600–2600 ms, the tear.** Trigger `wood.split` (§4.8) at 1600 ms at full level, then a
   descending crackle: `grainTrain(rate = 60 → 6 decelerando, dur 900 ms)` of wood modal ticks
   with random detune ±700 cents. The rate *decelerating* is critical — an accelerating crackle
   reads as building tension, a decelerating one reads as aftermath, as debris settling, as
   *it's over and you can't undo it*.
4. Optional 4th movement, 5% chance, only in the last 2 nights: 400 ms of nothing, then one
   single very quiet tick at −34 dB. The building has one more thing to say.

Intensity **0.95**, radius **120 m**. Every camper on the map orients. If `state.suspicion > 0.5`
when a tier 4 fires, `NightManager` should consider the night lost — and the audio should have
already told the player that before the UI does.

### 4.12 Rain

Three distinct surface models, blended by the listener's position and by what is overhead. All
driven by `weather:change` `{ rain }` in 0..1.

**Rain on leaves** — the default.
- BED: pink noise → bandpass `f=1900, Q=0.55` → highshelf `f=7000, gain=−4` → gain
  `−34 + 22·rain` dB.
- GRAIN: `grainTrain(rate = 30 + 420·rain, jitter=1.0)`, each grain 4 ms noise → bandpass
  `f = 2600·rand(0.5,1.8), Q=2.4` → decay 12 ms, gain −20 dB. Cap the grain rate by
  `settings.tier(60, 140, 300, 450)` and compensate the bed level so `low` still sounds like rain.
- CANOPY: a very slow (0.08 Hz) random-walk on the bed's bandpass `f` between 1500 and 2400 —
  the rain moving through the trees in sheets. Free, and it is 80% of the realism.

**Rain on tin** (under the roof stage, or near the shed)
- BED: pink noise → highpass `f=1400` → bandpass `f=4200, Q=0.7` → gain `−30 + 24·rain`.
- GRAIN: `grainTrain(rate = 50 + 700·rain)`, each grain =
  `modal(impulse(0.4ms), [{f:3900·r,Q:130,g:1,d:35},{f:6800·r,Q:100,g:0.5,d:22}])`, r=rand(0.85,1.2).
  Pitched pings, not noise. This is why tin rain is unmistakable.
- SHEET RESONANCE: route the whole tin rain through `TIN_ROOF` reverb at 0.45 send.
- **This is a gameplay gift:** rain on tin masks the player. `NoiseSystem` should reduce effective
  noise radius by up to 35% during heavy rain, and the mix should make that obvious by getting
  genuinely loud. The player should *feel* covered.

**Rain on water** (the lake)
- BED: pink noise → lowpass `f=900, Q=0.7` → gain `−36 + 18·rain`. Dull, no top.
- PLINKS: `grainTrain(rate = 4 + 26·rain, jitter=1.0)`. Each plink is the classic droplet model:
  a sine whose frequency **rises** `f0 → f0·1.18` over 9 ms then holds, with env `A 1 / D 45` exp,
  `f0 = 900·rand(0.6,2.2)`, gain −22 dB. The *rising* pitch is what makes it read as water and
  not as a bell. Only audible within 25 m of the shoreline; route at 0.6 to `LAKE_EDGE`.

### 4.13 Wind through pines — the noise-band model

The forest bed's most important element. Three parallel bands plus a sizzle:

```
src = PINK NOISE (shared buffer, 3 independent sources with random offsets)

band A: bandpass f=380,  Q=0.75  → gainA
band B: bandpass f=1150, Q=1.10  → gainB
band C: bandpass f=2700, Q=1.40  → gainC
sizzle: highpass f=5200 → bandpass f=7400, Q=0.6 → gainS
                                   ↓
                    sum → [gustLPF] → [windGain] → ambience
```

- `gainA/B/C/S` are each driven by an **independent** random walk: every 400–900 ms, call
  `setTargetAtTime(target, now, τ)` where `target = base·(0.55 + 0.9·rand())` and `τ = 0.35`. The
  independence is the whole trick: the bands drifting against each other produces the endless,
  never-repeating "breathing" of a real treeline. One correlated envelope sounds like a fan.
- `gustLPF` is a lowpass whose cutoff tracks the gust envelope from `Weather`:
  `fc = 900 + 6500·gust`, `Q=0.6`. Gusts open the top end — that is what makes a gust *arrive*.
- `windGain` = `−40 + 26·wind` dB.
- Base band weights at `wind=0.5`: A `1.0`, B `0.62`, C `0.40`, S `0.16`. As `wind` rises, C and
  S rise faster (`^0.7` exponent) than A — a hard wind is a *hiss*, a soft wind is a *sigh*.
- **Directionality:** modulate the stereo balance of band C only, with a slow 0.05 Hz LFO ±0.35.
  The high band is the most directional in reality, and this makes the wind move across the map.

Above `wind > 0.75`, add the **pine whistle**: a `modal` at `f = 2400·rand(0.9,1.15), Q = 340,
decay 2.5 s`, excited by the wind noise itself at −34 dB, retriggering every 4–9 s. A trunk
resonating. Rare, tonal, and the first time a player hears it they will think it is a voice.

### 4.14 Distant thunder (with true delay from flash)

`Weather` (or `Sky`) fires the lightning flash. `AudioEngine` schedules the thunder at
`t_flash + distanceMetres / 343` seconds. **Never fake this.** A 3 km strike is 8.75 s of
silence, and that silence is free horror (§8.4).

Three thunder classes by distance:

- **Near (< 400 m)** — the crack. 8 ms of white noise at −3 dB through a highpass at 300, then
  immediately a 2.2 s rumble (below). Add a `WaveShaper` hard-clip on the first 40 ms. The crack
  is a broadband transient with almost no low end; the low end arrives *after*.
- **Mid (400 m – 2 km)** — no crack. Brown noise → lowpass `fc = 900·(400/d)^0.5` clamped to
  [140, 700], `Q=0.8`. Duration `2.5 + d/500` seconds. Amplitude is a **multi-tap sequence**, not
  a single envelope: schedule 4–8 gain "lumps" at irregular intervals (0.2–1.4 s apart), each a
  `setTargetAtTime` up then down, amplitudes decaying overall by `e^{-t/τ}` with τ = duration/2.5.
  Thunder rolls because different parts of the channel are at different distances — model that
  literally and it will sound right.
- **Far (> 2 km)** — lowpass at 110 Hz, duration 6–9 s, entirely lumps, no transient, peak
  −26 dB, and route it 0.7 wet into `LAKE_EDGE` reverb even if the player is in the woods. Distant
  thunder is *all* reverb.

Every thunder also modulates the wind: a +40% gust arriving 1.5 s after the sound.

### 4.15 Campfire

The camp's audio landmark. Positioned, `refDistance 2.5`, `rolloffFactor 0.6`.
- BED: brown noise → lowpass `f=520, Q=0.7` → gain −30 dB, amplitude random-walked every 250 ms
  by ±3 dB. The roar of combustion.
- CRACKLE: Poisson `grainTrain(rate=9, jitter=1.0)`. Grains:
  `modal(impulse(0.6ms), [{f:2400·r,Q:26,g:1,d:14},{f:5100·r,Q:18,g:0.4,d:8}])`, r=rand(0.5,2.2),
  gain −18 dB.
- POP: 1-in-14 grains is a *pop* instead — add `{f:640·r, Q:12, g:1.2, d:60}` and +7 dB, and (if
  within 8 m) a tiny ember hiss: 90 ms of noise bandpassed at 3800, −26 dB, with a downward
  sweep.
- HISS: when `rain > 0.3`, add a continuous `f=4600, Q=0.6` bandpassed noise at `−34 + 10·rain`
  and drop the bed −4 dB. A fire in the rain is a different, sadder sound.

### 4.16 Zipper (tent doors — the sound that means someone is coming out)

`grainTrain(rate = 110 → 170 → 90 over the duration, jitter 0.15)` — the rate curve is the hand
speed. Each grain: 1.5 ms noise → bandpass `f = 3400·rand(0.92,1.08), Q=6` → decay 7 ms.
Sum → bandpass `f=2900, Q=1.2` → a `modal` "slider body" at `{f:1250, Q:16, decay 40 ms}` excited
by the same train at −10 dB. Duration 400–900 ms. End with a hard stop and a single click
(§4.17's transient).

**This sound is a gameplay siren.** It must be audible at 40 m through moderate rain. Give it
`rolloffFactor 0.75` and a +3 dB presence peak at 3.2 kHz.

### 4.17 Flashlight click

Two-part, 55 ms total, and it must be *crisp* — a camper's thumb on a switch is the most
important 55 ms in the game.
- SWITCH TRANSIENT: 0.8 ms noise → bandpass `f=3600, Q=5.5` → decay 6 ms, −8 dB.
- PLASTIC BODY: `modal([{f:1880,Q:34,g:1,d:38},{f:3720,Q:28,g:0.5,d:26},{f:7100,Q:20,g:0.2,d:14}])`.
- SPRING: 12% chance of a tiny `{f:5400, Q:180, decay 220 ms, gain 0.15}` ring.
Off-click is the same recipe at 0.94× frequency and −2 dB. **The player must be able to tell
on from off by ear**, because in fog the beam appearing is sometimes not visible but the click
always is.

### 4.18 Twig snap

The player's most common mistake and therefore the sound they will most learn to fear.
- 2 ms noise burst → highpass 2200 → −4 dB.
- `modal([{f:920·r,Q:44,g:1,d:60},{f:2140·r,Q:36,g:0.6,d:38},{f:4900·r,Q:24,g:0.25,d:20}])`,
  `r = rand(0.7,1.5)` — thickness variation.
- FIBRE TAIL: pink noise 130 ms, bandpass sweeping `3000 → 1100`, `Q=2`, exp decay, −18 dB.
- Small twig (`r > 1.2`): shorten everything ×0.6, −6 dB, `intensity 0.20, radius 22 m`.
  Big branch (`r < 0.85`): lengthen ×1.7, +4 dB, add a 74 Hz sine thump, `intensity 0.48,
  radius 55 m`.

### 4.19 The player's breathing

Continuous, on the `body` bus, never spatialized, never reverbed. Four states with a shared model.

**Model.** One inhale + one exhale per cycle.
- INHALE: pink noise → bandpass `f_in`, `Q_in` → gain env `A 35% of inhale dur / D 65%`, with the
  bandpass frequency sweeping **upward** across the inhale (air accelerating through the throat).
- EXHALE: pink noise → bandpass `f_ex`, `Q_ex`, frequency sweeping **downward**, env with a fast
  attack and a long tail. Exhale is always ~1.4× the duration of inhale and ~2 dB quieter.
- A `highshelf f=6000, gain=−9` on both — breath has no air on top, it has body.

| State | Period | Inhale dur | f_in sweep | f_ex sweep | Q | Gain |
|---|---|---|---|---|---|---|
| `CALM` | 4.4 s | 1.1 s | 420→680 | 640→380 | 1.1 | −34 dB |
| `WALK` | 3.2 s | 0.9 s | 480→820 | 780→420 | 1.3 | −29 dB |
| `HEAVY` (carrying/running) | 1.9 s | 0.6 s | 560→1150 | 1080→480 | 1.8 | −22 dB |
| `FEAR` | 2.4 s, **irregular** (±30% jitter) | 0.5 s | 700→1350 | 1200→560 | 2.4 | −24 dB |
| `HELD` | — | — | — | — | — | silence |

Rules:
- `HEAVY` adds a **voiced** component: a 108 Hz sawtooth through a lowpass at 700, at −34 dB,
  only on the exhale. The player is a big man and you should hear the weight in his chest. Never
  make it a grunt — he does not perform effort, he just *is* heavy.
- `FEAR` is triggered by `state.suspicion > 0.45` or a camper within 10 m. Its irregularity is the
  tell: the period jitters, and 1 in 5 cycles the inhale is *doubled* (a short catch, 120 ms gap,
  then the rest).
- Transitions between states crossfade over one full cycle. Never cut mid-breath.
- `HELD` is the Held Breath (§2.4) and is the single most effective audio moment in the game.
- Under the mask (§2.5) the breath additionally gets a `+6 dB` peak at 680 Hz and a `−8 dB` shelf
  above 4 k, so the breath is the thing the mask most obviously changes. Wearing the mask should
  make the player sound, to himself, like he is inside a bucket.

### 4.20 Heartbeat

On the `body` bus. Two thumps per beat: `lub` at `t=0`, `dub` at `t = 0.30·period`, dub at −5 dB.

Each thump:
- SUB: sine, `f` from 56 → 38 Hz via `exponentialRampToValueAtTime` over 90 ms, env `A 6 / D 110`.
- THUD: brown noise 45 ms → lowpass `f = hbCutoff, Q=1.0` → −10 dB relative to the sub.

`hbCutoff` is the fear dial: **200 Hz** normally (you feel it, you don't hear it), opening to
**420 Hz** during Held Breath, and **620 Hz** in `phase:'chase'` (now it has an audible *slap*).

BPM: `bpm = 52 + 46·fear + 22·exertion`, clamped [52, 148]. Smooth with `τ = 1.2 s` — the heart
lags the situation, which is exactly right emotionally; it keeps hammering for several seconds
after you are safe. Gain: `−40 + 22·fear` dB, and **0 (silent) when `fear < 0.12`**. The heart
must be genuinely absent most of the time or it means nothing when it arrives.

---

## 5. Ambience

`AudioEngine` maintains an `AmbienceDirector` that owns the bed. All of it is on the `ambience`
bus, all of it carries the −4 dB peaking notch at 3.1 kHz (§1.2), and all of it obeys §8.

### 5.1 The bed

Three always-on layers:
1. **Wind through pines** (§4.13) — the spine.
2. **Room tone** — brown noise → lowpass `f=180, Q=0.6` → −44 dB. Inaudible in isolation; its
   absence is audible. Present in *every* state except `night:failed` (§8.7).
3. **Distance layer** — pink noise → bandpass `f=620, Q=0.4` → 0.55 wet into `OPEN_FOREST` →
   −42 dB. The sound of a very large amount of air. This is what makes the forest feel like it
   extends past the draw distance.

### 5.2 Crickets

The most important ambient element in the game because it is the one we take away.

**Chirp synthesis** (one cricket):
```
A chirp = 4–5 pulses.
Pulse: two detuned sines at f0 and f0·1.004, f0 = 4600 · rand(0.92, 1.12)
       + a third partial at 2·f0 at −11 dB (crickets are not pure)
       env: A 2 ms / hold (pulseDur−5) / D 3 ms   — near-square, this is a stridulation
       pulseDur = 14 ms · rand(0.85,1.2)
       gap between pulses = 15 ms · rand(0.9,1.15)
Whole chirp → bandpass f=f0, Q=6 (the wing's own resonance) → panner
```
Chirp gain −38 dB each. **Chorus:** `settings.tier(8, 18, 34, 48)` cricket instances, scattered on
a ring 6–40 m around the player, each with an independent chirp interval and a slow spatial drift.
Instances beyond 25 m share a single "distant cricket wash" source (a bandpassed noise at 4.6 kHz
with a 12 Hz AM) to save voices.

**Temperature-dependent rate.** Dolbear's Law: `chirpsPerMinute = 4·(T_F − 50) + 40`. The night
cools: `T_F = 68 − 13·state.timeOfNight` (Night 1) down to `T_F = 58 − 15·timeOfNight` by Night 7.
So a warm Night 1 evening chirps at ~112/min and drops to ~60/min by dawn, and the last nights of
the game are audibly *colder*. Rain drops `T_F` by 4 and cuts the chorus size 40%. This single
formula does more atmospheric work than any amount of extra layers: the forest gets slower and
lonelier as the week goes on, and nobody will consciously notice why.

### 5.3 Loon, owl, camp radio

**Loon** — one, over the lake, always at the same bearing (the far shore), 0.85 wet into
`LAKE_EDGE`, fires every 40–120 s. The *wail*:
- Fundamental glide: sine `f: 460 → 880 → 810 Hz` over 1.6 s (up fast, down slow).
- Harmonics 2, 3, 4 at −7, −13, −20 dB, all tracking.
- Formant: bandpass `f=1250, Q=2.2` on the sum, +4 dB.
- Env: `A 180 / S 1200 / R 400`, exp.
- **Tremolo variant** (1 in 4): add AM at 11.5 Hz, depth 0.45, and split the glide into three
  rising steps. This is the "crazy" loon call and it should be rationed — no more than twice a
  night. It reads as a scream and players will jump.

**Owl** — a barred owl, in the trees behind the player's build site, every 90–240 s. Four hoots:
`[0, 340, 900, 1450] ms`, each 220 ms. Each hoot: sine at `f = 340 Hz` with harmonics 2 (−9 dB)
and 3 (−17 dB), a 6 Hz vibrato at ±14 cents, through a bandpass `f=700, Q=1.4`, env
`A 40 / S 120 / R 60`. The final hoot glides down 340 → 260 Hz. −30 dB, 0.5 wet into
`DENSE_TREES`. **The owl stops when the crickets stop** and it never returns in the same night.

**Camp radio** — a transistor radio at the mess hall, 1984. This is procedural too: `Music.js`
generates a short, cheap, cheerful AM-pop loop (a 4-chord I–V–vi–IV in F, a drum machine, a
saccharine synth-brass lead) and it is then destroyed by the transmission chain:

```
signal → bandpass f=1400, Q=0.9  (a 4-inch paper cone in a plastic box)
       → highpass f=520          (no bass exists)
       → WaveShaper (soft clip, drive 2.4)  (the amp is overdriven, always)
       → peaking f=2900, Q=2.5, +6 dB       (the honk)
       → lowpass f=4800
       → + noise bed: pink → bandpass 1600 Q 0.7 → −32 dB   (AM hiss)
       → + fade: a 0.07 Hz random walk on output gain, ±5 dB  (signal drift)
       → mono → panner at the mess hall
```
Every 30–90 s the drift dips hard (−14 dB, 2 s) and comes back. Once a night, it drops out
entirely for 8 s. **The radio is a clock**: it goes off at `timeOfNight 0.55` (lights out) with a
single loud click, and the silence after it is the second-best moment in the audio design.

### 5.4 When the crickets stop

**The rule:** crickets are a proximity sensor with a radius that the player learns.

Fade the entire cricket chorus to silence over **350 ms** (`setTargetAtTime`, τ=0.11) whenever
**any** of these is true:

1. Any camper is within **14 m** of the player, regardless of awareness.
2. Any camper is within **6 m** of the *player's last noise* and actively searching.
3. A `build:creak` of tier ≥ 2 fired in the last 4 s (dip to 40% for tier 2, full stop for 3–4).
4. `state.suspicion > 0.7`.
5. Lightning flash — full stop, and they do not return until 2 s after the thunder.
6. `phase === 'chase'`.

Return: **6.0 s** after the last condition clears, and the return is **staggered** — crickets come
back one at a time over 4 s, nearest last. A forest does not switch back on. That staggered return
is the exhale of the whole game and it must never be a single fade-up.

**Do not cheat this.** The cricket cut must be causally honest. If it ever fires without a camper
nearby, players will stop trusting it, and the moment they stop trusting it, it stops being scary.
One false positive is permitted per night, from a deer (`Props` may emit a `noise:emit` with
`kind:'animal'`) — and the payoff is that the player, having frozen for ten seconds for nothing,
now has to decide whether to trust it next time.

---

## 6. Adaptive Music

`src/audio/Music.js`. **There are no linear tracks and no loops.** Everything is scheduled note by
note against `AudioContext.currentTime` with a 200 ms lookahead scheduler ticking on a 50 ms
`setTimeout` (not `requestAnimationFrame` — the scheduler must survive tab throttling gracefully
and must not be tied to the render loop).

### 6.1 Harmonic language

- **Reference pitch A = 436 Hz** (14 cents flat). Everything in the score is slightly, unplaceably
  flat against nothing, which is exactly the feeling we want. The camp radio (§5.3) is at A = 440.
  When both are audible they beat against each other. That is intentional and it is horrible.
- **Pitch centre: D1 = 36.4 Hz / D2 = 72.8 Hz.** It never modulates. Seven nights, one key.
- Mode: **D Phrygian** (D Eb F G A Bb C) at low dread; drifting to **D Locrian** (Ab replaces A)
  above dread 0.75. **The tritone D–Ab is reserved.** It appears nowhere in the game until a
  camper has actually seen the player. Players will not know why the music got worse; it got a
  new note.
- **No triads, ever.** Harmony is stacked fourths (D–G–C), minor seconds (D–Eb) used as beating
  intervals, and open fifths. When two voices land a minor second, detune one by 11 cents so it
  beats at ~1.5 Hz.

### 6.2 Instrumentation (all synthesized)

**PAD — detuned analog.** Per voice: 3 `OscillatorNode`s (`sawtooth`, `sawtooth`, `triangle`)
detuned `[−7, +6, +13]` cents, plus a sub `sine` an octave down at −9 dB. Into a lowpass
(`f = 240 + 900·dread`, `Q = 3.5`) with a 0.07 Hz sine LFO on cutoff, ±180 Hz. Amp env:
`A 4500 / D — / S 1.0 / R 6000 ms`. Chorus: two `DelayNode`s at 14 ms and 21 ms, each modulated
±3 ms by 0.11/0.17 Hz LFOs, mixed 0.3. Voice count capped at 4.

**PREPARED PIANO.** Modal, 7 partials with string inharmonicity:
`f_n = n·f0·sqrt(1 + B·n²)`, `B = 0.0042`. Q per partial `= 900/n`, decay
`= 3200/n^0.8 ms`. Excited by a 1.5 ms noise burst through a lowpass at `4·f0`. **The
preparation:** partials 3, 4 and 5 are amplitude-modulated by a 64 Hz sine at depth 0.55 — a screw
resting on the string, buzzing. Add a **damper thunk** on note-off: `modal([{f:92,Q:9,g:0.3,d:60}])`.
This instrument plays single notes, never chords, and never more than one note every 4 seconds.

**BOWED METAL.** Continuous pink noise → gain (`bowPressure`) → a bank of 5 very high-Q bandpasses
at `[196, 293, 441, 587, 881] Hz` (a stack of fourths/fifths on D), `Q = 180 + 600·bowPressure`,
→ a soft `WaveShaper` → out. `bowPressure` is ramped over 3–8 s. The result is a slow, hollow,
unstable drone that swells and dies like a bowed cymbal edge. **This is the game's dread meter.**

**THE STRING — one detuned low string.** Karplus-Strong: `DelayNode` (delay = 1/f) in a feedback
loop with `[lowpass f = 2600] → [gain 0.994]`, excited by a 12 ms noise burst.
**Implementation warning:** a `DelayNode` feedback loop in WebAudio has a minimum delay of one
render quantum (128 samples ≈ 2.67 ms at 48 k), which floors the pitch at ~375 Hz — far too high
for our low D. Therefore: on `settings.tier('modal','modal','worklet','worklet')` use an
`AudioWorkletProcessor` (`ks-processor`) for true low KS; on `low`/`medium` fall back to a modal
bank of 9 harmonics of 72.8 Hz with `B=0.0008` and 8 s decays, which is 90% as good and costs a
tenth as much. Struck (not plucked) with a felt exciter: 25 ms of lowpassed noise.

### 6.3 The Dread scalar and the layers

```js
dread = clamp01(
    0.40 * state.suspicion
  + 0.30 * proximity          // 1 - clamp01(nearestCamperDist / 30)
  + 0.15 * lineOfSightTerm    // 1 if a camper's cone contains the player
  + 0.10 * (state.creaks / 6)
  + 0.05 * (1 - buildProgress)
);
```
Smoothed asymmetrically: **rise τ = 0.35 s, fall τ = 4.5 s.** Dread arrives instantly and leaves
slowly. Never the reverse.

| Layer | Instrument | Enters at | Behaviour |
|---|---|---|---|
| **L0 — Ground** | THE STRING, D1, struck once | always | One note every 22–40 s. −30 dB. This is the game's pulse and it is present even at dread 0. |
| **L1 — Air** | PAD, one voice, D2+A2 open fifth | dread > 0.12 | Filter cutoff tracks dread. |
| **L2 — Report** | PREPARED PIANO | build progress, not dread | Fires on `build:place` `correct:true`: a single note from a slowly ascending sequence indexed by stage number (D, F, G, Bb, C, D, Eb...). **The only "reward" music in the game.** Dry, close, −20 dB. |
| **L3 — Attention** | BOWED METAL, bowPressure 0.3 | dread > 0.35 | Swells in over 6 s. |
| **L4 — Pressure** | PAD second voice a minor second above (Eb), + BOWED METAL to 0.7 | dread > 0.60 | The beating starts. |
| **L5 — Seen** | Adds Ab (the reserved tritone) in the pad, THE STRING switches to a 3-note irregular ostinato at ~104 bpm | dread > 0.85 or `player:spotted` | Never plays otherwise. |

**Transition rules.** Layers enter on the next 2-second grid boundary and leave on the next 4-second
boundary, always with ≥ 1.5 s ramps. Never cut a layer. Above dread 0.85 → below 0.4 (the player
escaped) the whole score does a **collapse**: all layers ramp out over 3.5 s *except* L0, and L0
plays one note. Then 20–40 s of no music at all (§8.5).

### 6.4 The stinger — "THE STAPLE"

Every slasher game owes something to `ki-ki-ki, ma-ma-ma`. Ours pays the debt without stealing.

**The figure:** three struck-steel hits followed by one dropped low clang.

```
Hits at t = 0, 118, 214 ms   (accelerando, irregular — NOT even subdivisions)
Each hit: the steel modal bank (§4.5) with decays cut to 180 ms,
          hit 3 detuned DOWN 100 cents (a minor second lower than 1 and 2)
Answer at t = 470 ms: THE STRING, D1, struck hard, plus a 44 Hz sine drop, −8 dB
Slap: single delay 92 ms, feedback 0.42, feedback path through highpass f=900
      → so it "tings" away rather than "shushing"
Total: ~1.4 s. Dry (reverb send 0.10). Mono-ish, centred, but not exactly centred: pan −0.15.
```

**How it differs from the Friday the 13th figure, deliberately and specifically:**
1. **It is not vocal.** No formants, no breath, no whisper, no consonant articulation. It is
   struck metal — it is *hardware*, because this is a game about hardware.
2. **The rhythm is irregular and accelerating** (0 / 118 / 214 ms), not an even repeated
   subdivision. It sounds like something being *hit*, not something being *counted*.
3. **The echo is a single bright slap, not a tape delay.** Manfredini's is a long feedback smear;
   ours is one crisp repeat that decays upward in brightness.
4. **The answering phrase is one clang, not a two-note vocal.** Call-and-response is preserved;
   the material is not.
5. **Most importantly, its function is inverted.** It does not play when the monster appears —
   *the player is the monster*. It plays **1.2 seconds before a camper turns to look in the
   player's direction.** It is a tell, not a sting. It means "you are about to be seen," and it
   is the closest thing this game has to a HUD. Fire it at most **twice per night** so it never
   becomes wallpaper, and never fire it if the player is already spotted.

---

## 7. Voice — Atmosphere Only

**The creator's hard rule: voice is atmosphere in 3D space. Never a narrator, never the star.**
`VoiceBank.js` loads ElevenLabs MP3s from `public/audio/vo/` generated by
`tools/generate-voices.mjs`. If the directory is empty, `VoiceBank` reports `available = false`
and every `audio:vo` emit becomes a no-op — **and the game must still work.** Test this build
weekly.

### 7.1 The half-heard principle

The frightening thing about a voice in the woods is not what it says. It is that you *almost*
caught it. Our target ratio is **4:1 half-heard to clear**. A line that is fully intelligible is a
scripted event; there should be at most three of them per night.

### 7.2 The distance / intelligibility chain

Every VO source runs through:

```
buffer → [preGain] → [voHP] → [voLP] → [voPresence] → [smearGain] → [panner]
                                                  ├──▶ [verbSend] ──▶ convolver
```

- `voLP` (lowpass, Q=0.7): `fc = 16000 / (1 + d/3.2)^1.35`
  → 0 m: 16 k · 6 m: 5.0 k · 15 m: 1.6 k · 30 m: 780 · 45 m: 480 Hz.
- `voHP` (highpass): `fc = 40 + 6.2·d`, clamped to 340. Removes chest and proximity as distance
  grows; a far voice is all midrange.
- `voPresence` (peaking, `f = 2600, Q = 1.4`): `gain = +4 − 0.22·d` dB, clamped to −6. Close
  voices have consonants; far ones do not.
- `verbSend`: `wet = clamp(0.12 + 0.020·d, 0.12, 0.85)`.
- `smearGain`: **the wind gate.** Active when `d > 18` or `weather.wind > 0.4`. A random-walk gain
  that punches holes: every `1/(3 + 5·wind)` seconds, `setTargetAtTime(rand(0.35, 1.0), now, 0.05)`.
  This is what makes a distant conversation come and go in the wind, and it is the single most
  important VO processing decision in the game. **Words drop out. Sentences arrive in fragments.**
- Occlusion (§3.2) applies on top of all of this.

**The intelligibility scalar:**
```js
I = clamp01( (1 - d/26) ) * (1 - 0.55*occlusionT) * (1 - 0.45*wind) * facingTerm
    // facingTerm: 1.0 facing player, 0.4 facing away (via the panner cone)
```
- `I > 0.62` → the line is "clear." Emit `ui:subtitle` `{ text, speaker, ms }` (respecting
  `settings.subtitles`). This is the only place subtitles come from.
- `0.30 < I ≤ 0.62` → half-heard. **No subtitle.** The player hears cadence, gender, emotion, and
  maybe one word. This is the target band.
- `I ≤ 0.30` → presence only. Do not schedule specific lines here; play generic murmur takes
  (see `CHATTER_BED` below) so we do not burn scripted content on inaudibility.

### 7.3 Scheduling conversations

`VoiceBank` runs a `ConversationDirector`:
- A conversation is 2–4 campers with a topic id from `src/story/Script.js`.
- **Max 2 active conversations. Max 4 concurrent VO voices. Hard cap.**
- Turn-taking: gap between lines `= 180 + rand(0,240) ms`. **12% of turns overlap** — the next
  speaker begins 250 ms before the current one ends. Real conversation overlaps; perfectly
  alternating VO sounds like a radio play.
- Laughter is scheduled as a reaction, 300–600 ms after a punchline, from 1–2 non-speakers.
- **Spatial rule: never place two active speakers within 20° of each other in the player's
  azimuth.** If the geometry demands it, delay the second speaker.
- **Cooldown: the same line id never plays twice in a night, and never at `I > 0.62` twice in the
  whole game.** A line the player once heard clearly must, on any repeat, be half-heard.
- `CHATTER_BED`: for each voice profile, generate 6 takes of 4–9 s of non-lexical conversational
  murmur (delivered as real sentences, then processed so hard they are unrecoverable). These are
  what plays at `I ≤ 0.30`. They are the workhorses; scripted lines are the spice.
- **VO stops entirely during any silence rule (§8) except §8.9.**

### 7.4 The six camper voice profiles

Generated by `tools/generate-voices.mjs`. Model `eleven_multilingual_v2`, output
`mp3_44100_128` (we downsample to 24 kHz mono on load — nothing survives the distance chain above
5 kHz anyway, and it quarters our memory).

**Global direction for all six:** they are ordinary teenagers and adults at a summer job. They are
**not** in a horror movie and must never sound like they are. No screaming until Night 6. No
"spooky" delivery, ever. The horror is that they are relaxed.

| # | Name | Character (ElevenLabs voice description) | stability | similarity_boost | style | speaker_boost |
|---|---|---|---|---|---|---|
| 1 | **DENISE**, 22, head counselor | Female, low-mid alto, flat upper-Midwest, unhurried, institutionally calm. The adult in the room. | 0.62 | 0.80 | 0.22 | true |
| 2 | **RANDY**, 19, kitchen | Male, bright tenor, fast, adenoidal, never stops talking, laughs at his own jokes. | 0.34 | 0.72 | 0.55 | true |
| 3 | **TAMMY**, 18, waterfront | Female, dry slight rasp, low energy, deadpan, unimpressed by everything. | 0.55 | 0.78 | 0.30 | true |
| 4 | **KEVIN "SPUD"**, 17, junior counselor | Male, unsettled register, cracks upward under stress, over-eager. | 0.28 | 0.68 | 0.62 | true |
| 5 | **MARCIA**, 20, arts & crafts | Female, warm, breathy, sings to herself constantly, kind. | 0.70 | 0.85 | 0.18 | true |
| 6 | **BUD DIETZ**, 46, maintenance | Male, heavy gravel bass, slow, terse, forty years of cigarettes. **The only one who knows what a joist is.** | 0.75 | 0.88 | 0.15 | false |

Bud has `speaker_boost: false` deliberately — we want his low end intact and un-enhanced, because
he is going to be heard mostly at distance where boost artifacts become obvious.

**Per-category delivery direction** (given as prompt/style notes at generation time; also set
per-category parameter deltas):

| Category | Direction | Param delta |
|---|---|---|
| `CHATTER` | Mid-sentence, no setup, no punchline for the player's benefit. Trail off. Mumble. | style −0.10, stability +0.05 |
| `CALL_NAME` | Shouted across distance, but casually — calling a friend to dinner, not a search party. Long vowels. | style +0.15 |
| `NOTICE_LOW` | "...huh." Barely a reaction. Half a beat of listening. **Under-play this brutally.** | stability +0.15, style −0.20 |
| `NOTICE_HIGH` | Genuine puzzlement, not fear. "Okay, that was definitely something." | style +0.10 |
| `SEARCH` | Talking to themselves at low volume while moving. Breath between words. | stability −0.10 |
| `DISMISS` | Relieved, slightly embarrassed. This is the sound the player wants to hear. | style +0.05 |
| `CONSTRUCTION` | **The comedy engine.** They hear the player's hammering and blame each other, or Bud. Completely straight: "Is Bud working *now*?" Nobody ever suggests a monster is building a house. | no delta |
| `FIRESIDE` | Slow, warm, overlapping, laughing. Long takes (8–20 s) used as a bed near the camp. | stability +0.10 |
| `SCARED` | Nights 6–7 only. Real, ugly, unperformed fear. Short. | stability −0.25, style +0.30 |

Generation hygiene: fixed `seed` per line where the API allows, one file per line id, filenames
`vo_<speaker>_<category>_<index>.mp3`, and a `manifest.json` with duration, category, speaker, and
a `clearOK: bool` flag marking lines permitted to play at `I > 0.62`.

---

## 8. The Silence Rules

**This is the most important section in this document.** Every rule below is implemented as a
priority-ordered stack in `AudioEngine`; the highest-priority active rule wins, and rules do not
blend.

**S1 — The first breath of the night.** On `night:begin`: **2.2 seconds of absolute silence.**
Not room tone. Nothing. Then the bed fades in over 6 s, wind first, then distance layer, then
crickets last (staggered, §5.4). The player's first two seconds of every night are a hole. *Why:*
it resets the ear, it makes the bed feel like it *arrived*, and it establishes on Night 1 that
this game is willing to give you nothing.

**S2 — The cricket cut.** §5.4 in full. The proximity sensor. *Why:* it is the entire stealth
UI and it is diegetic.

**S3 — The naked creak.** On `build:place` with `correct: false`, everything except the creak
ducks −18 dB for 180 ms *before* the creak sounds, then returns over 900 ms. The creak arrives
into a vacuum, unaccompanied, at full level. *Why:* the mistake must be the only thing in the
world for a quarter of a second. It is the audio equivalent of a hard cut to a close-up.

**S4 — The gap before the thunder.** From the lightning flash until the thunder arrives
(`d/343` seconds — up to 9 s), duck everything but rain by −14 dB over 110 ms and hold. The
flash whites out the screen, the world goes quiet, and then, seconds later, the sound arrives.
*Why:* real, free, and it makes the player count. It also means every distant strike buys us a
silence we did not have to justify.

**S5 — The escape.** When dread falls from > 0.85 to < 0.40, the score collapses (§6.3) and then
there is **no music at all for 20–40 s**. The bed returns to normal but the score does not.
*Why:* relief is a musical event, and the only way to score relief is to stop scoring.

**S6 — The clinical pause.** On `build:stage-complete`: **1.4 s of complete silence** across every
bus, and then, alone and dry on `sfxUI`, the manual's completion chime — two clean sine-plus-
triangle tones, `f = 880 and 1174 Hz` (a perfect fourth), 140 ms each, 60 ms apart, no reverb, no
distance, always exactly −16 dB, always identical. Then the world fades back over 1.8 s. *Why:*
this is the funniest moment in the game and it is funny because it is silent. The forest stops,
the furniture-commercial universe intrudes for 340 ms, and then the wet dark night resumes as if
nothing happened. **Do not add a musical sting here. Do not "sell" it. The deadpan is the joke.**

**S7 — The end.** On `night:failed`: hard-mute every bus on the frame it fires — including room
tone, including the heartbeat, including the mask, including everything. **900 ms of true digital
silence.** Then one note: THE STRING at D1, −24 dB, allowed to ring for 11 s into `OPEN_FOREST`.
Nothing else, ever, until the menu. *Why:* the only time the game gives you actual nothing is when
you have lost, and it should be the loudest silence in the medium.

**S8 — Lantern out.** Whenever the player extinguishes the lantern (a deliberate stealth action),
the gas hiss ramps out over 700 ms **and the ambience bed drops −8 dB with a lowpass to 3.2 kHz
for as long as the light is off.** The world gets quieter when you cannot see it. This is
psychoacoustically dishonest and it is the correct choice: it makes darkness feel like holding
your breath, and it rewards the player for a risky action with an audible change of state.

**S9 — The pause.** On `game:pause`: do **not** silence. Ramp all buses to −20 dB over 400 ms and
insert a lowpass at 900 Hz. The forest is still there, behind glass, waiting. `sfxUI` is unaffected
so menu interaction stays crisp. *Why:* a hard mute on pause tells the player the world is a
program. Keeping it breathing at the edge of hearing tells them it is a place.

**S10 — The mask.** On `story:beat` `mask-on`: 400 ms in which everything but the player's own
breath is muted, then the mask filter (§2.5) crossfades in over 1400 ms while the breath rises
+6 dB. The player hears the world go away, hears themselves, and then hears the world come back
wrong. *Why:* it is the only moment in the game where the player's identity changes, and it should
be an ear event, not a cutscene.

**S11 — Pre-dawn.** Above `state.timeOfNight > 0.92`: over 40 s, ramp everything below 300 Hz out
(`highpass` on `master`, sweeping 20 → 300 Hz), reduce the wind to band C and sizzle only, cut the
crickets to 3 instances, and let one single distant bird (a white-throated sparrow: five pure
sine tones, `f = 4200`, first long then four short, 700 ms total, every 25–60 s) exist. Music
silent. *Why:* dawn is the reward and it must sound thin, cold, and survived.

**S12 — Never break silence with a fade-in.** Whatever ends a silence must **arrive** — a
transient, an event, a footstep. If nothing arrives, the silence continues until something does.
Fading the bed back up under a silence is the one unforgivable sin in this document.

---

## 9. Implementation Notes (WebAudio)

### 9.1 Voice pooling and stealing

`AudioEngine` maintains a pool of pre-built "voice slots" per SFX family, each a persistent
subgraph (panner + filters + gains) whose source node is the only thing recreated per play.
`AudioBufferSourceNode` and `OscillatorNode` are one-shot and must be recreated; everything else is
reused forever. Never build a `BiquadFilterNode` inside a `play()` call.

| Tier | Total concurrent voices | 3D panners | Convolvers | Cricket instances | Rain grains/s |
|---|---|---|---|---|---|
| `low` | 24 | 12 (equalpower) | 1 | 8 | 60 |
| `medium` | 40 | 24 (equalpower) | 2 | 18 | 140 |
| `high` | 64 | 40 (HRTF) | 2 | 34 | 300 |
| `ultra` | 96 | 56 (HRTF) | 2 | 48 | 450 |

Use `settings.tier(...)` for all of these. Never branch on the quality string.

**Stealing.** Every voice has `priority` (0–3) and a computed `score = priority·1000 +
20·log10(gain) − 0.4·distance − 0.001·ageMs`. When the pool is full, steal the lowest score, and
release it with an **8 ms** fade, never a stop. Priorities:
- **3 (never stolen):** creaks tier ≥ 2, the stinger, `player:footstep`, the seat thump, breath,
  heartbeat, `sfxUI`, thunder.
- **2:** all other build SFX, VO, camper footsteps, zipper, flashlight click.
- **1:** music voices, campfire, loon, owl.
- **0:** crickets, rain grains, wind bands, glass rattle.

Also enforce **per-family caps**: max 3 simultaneous creaks, 2 hammers, 1 thunder, 4 VO, 6
footsteps (across all agents), 12 rain grains in flight.

### 9.2 Avoiding clicks — the non-negotiables

1. **Never assign `param.value` on a live node.** Always `setTargetAtTime` /
   `linearRampToValueAtTime`.
2. **Minimum 4 ms attack, 8 ms release, on every gain, no exceptions.** A "hard" transient is
   achieved with a 1–2 ms *noise burst source*, not a 0 ms envelope.
3. **`exponentialRampToValueAtTime` cannot target 0.** Ramp to `1e-4`, then
   `setValueAtTime(0, t+ε)`.
4. **Cancel correctly.** `cancelAndHoldAtTime(now)` then ramp. Bare `cancelScheduledValues` jumps
   the param to its last set value and clicks.
5. **Schedule in the future.** All `start()` calls at `ctx.currentTime + 0.02` minimum. Never
   `start()` at `currentTime` — you are racing the audio thread.
6. **Filter frequency jumps click too.** Biquad coefficient changes are not interpolated per
   sample in all engines; ramp `frequency` with `setTargetAtTime(τ ≥ 0.008)`.
7. **DC.** Anything through a `WaveShaper` gets a `highpass f=18, Q=0.7` after it.

### 9.3 CPU budget

`AudioEngine.update(dt)` must cost **< 0.35 ms/frame** (well inside the 1.5 ms/system guardrail).
The audio *thread* is separate but not free — target < 25% of one core on `ultra`.

- **The single biggest cost is `ConvolverNode`.** Two convolvers with 2.5 s IRs at 48 kHz is
  already significant. Generate IRs at **24 kHz** for `low`/`medium` and truncate `LAKE_EDGE` to
  1.6 s below `high`.
- **HRTF panners are the second cost** (~4× equalpower). Hence the tier table. Sources beyond 45 m
  are downgraded to `equalpower` automatically regardless of tier — HRTF cues are meaningless at
  that distance and rolloff dominates.
- **Amortize.** Listener update every frame; per-source distance/occlusion updates round-robin at
  ≤ 8 sources/frame with a 120 ms cache; reverb-space probe every 250 ms; music scheduler on its
  own 50 ms timer.
- **No allocations in `update()`.** Scratch `THREE.Vector3`s at module scope, per
  `ARCHITECTURE.md` §12. Object-pool the voice descriptors.
- **Zero garbage from grain trains.** Pre-allocate the grain scheduler's event ring buffer.
- Kill any voice whose computed gain is below **−60 dB** before building it. At 60 m in the rain,
  a cricket does not need to exist.

### 9.4 Graceful degradation and failure modes

- **Autoplay policy.** The context is created `suspended`. The title screen is silent and says so
  by being silent. `resume()` on the first `pointerdown` anywhere. If `state === 'interrupted'`
  (iOS), poll and resume on `visibilitychange`.
- **No AudioWorklet support** (or `low`/`medium`): the KS string falls back to the modal bank
  (§6.2). Detect once at init; never branch per-note.
- **VO missing** (`public/audio/vo/` empty or fetch fails): `VoiceBank.available = false`, all
  `audio:vo` are no-ops, `ui:subtitle` is never emitted, and the `ConversationDirector` instead
  schedules **non-verbal camper presence**: footsteps, a zipper, a flashlight click, a laugh
  synthesized as a short filtered-noise burst sequence. The stealth game loses nothing. Ship this
  path as the default assumption.
- **Context creation fails entirely:** every `AudioEngine` public method becomes a no-op stub. The
  game runs. Nothing throws. Log once via `Log.debug()`.
- **`dispose()`** must `disconnect()` every node, `stop()` every source, clear every scheduled
  timer, null every `AudioBuffer`, and `close()` the context.
- **Every consumer null-checks:** `ctx.systems.get('Audio')?.play?.(...)`. Audio registers late
  in the order (after `Weather` and `Forest`), so anything running in `init()` must assume it is
  not there yet.

### 9.5 Public API (for other agents)

```js
// src/audio/AudioEngine.js
audio.play(id, { position?, volume?, rate?, priority?, bus? }) -> handle|null
audio.stop(handle, fadeMs = 60)
audio.bus(name)                       // 'master'|'sfxWorld'|'sfxUI'|'ambience'|'music'|'vo'|'body'
audio.duck(busName, dB, attackMs, holdMs, releaseMs)
audio.setSpace(spaceId, weight)       // manual reverb override; omit to use the probe grid
audio.setMask(enabled, fadeMs)
audio.now()                           // AudioContext.currentTime, for schedulers

// src/audio/ProceduralSFX.js
sfx.register(id, factoryFn)           // factoryFn(destNode, params) -> { stop(fadeMs) }
sfx.modal(exciter, modes, dest)
sfx.noise(type)                       // 'white'|'pink'|'brown' -> pooled AudioBufferSourceNode
sfx.grainTrain(opts)

// src/audio/Music.js
music.setDread(x)                     // 0..1, called by Audio from state; asymmetric smoothing internal
music.stinger('staple', { leadMs = 1200 })
music.collapse()

// src/audio/VoiceBank.js
voice.available                       // bool
voice.say(lineId, { position, speaker }) -> handle|null
voice.conversation(topicId, speakers[], position)
```

Everything else in the game talks to audio through the bus (`audio:sfx`, `audio:vo`,
`build:creak`, `player:footstep`, `noise:emit`, `weather:change`). **Do not import `AudioEngine`
into gameplay code.** Emit an event.

---

## 10. The One-Paragraph Version

The forest is warm, dense, and endlessly detailed, and it is built entirely so that we can switch
it off. The player is a very large man breathing inside a mask, carrying a hissing lantern that
squeaks when he hurries and rattles when he steps hard. Wood tells him whether he did it right —
a seated screw thumps, a wrong one groans, and a badly wrong one takes two and a half seconds to
die in front of him. Somewhere across the lake a loon screams and a radio plays something cheerful
in a slightly different tuning. The crickets are a proximity sensor and everybody learns it within
ten minutes without being told. Three times a night, the world stops completely: once when the
night begins, once when he finishes a stage and a clean little furniture-commercial chime plays in
a room that does not exist, and once when someone sees him. Nothing in this game ever winks. The
manual is the comedian; the woods are dead serious; and the silence does most of the work.
