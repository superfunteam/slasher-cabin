# Slasher Cabin: Some Assembly Required — Game Design Document

**Version 1.0 — systems spec. This is the document gameplay agents implement.**

Read `ARCHITECTURE.md` first. Everything here is expressed in the module names, event names,
`GameState` fields and `settings.tier()` conventions defined there. **No system in this document
invents a new event.** Where a behaviour needs a channel, it reuses one from the canonical table
in `ARCHITECTURE.md §5`, with `kind` / `id` / `reason` strings enumerated below so all agents
agree on the vocabulary.

---

## 0. Design pillars (binding, in priority order)

1. **The manual is the comedian. The world is not.** Nothing in the 3D scene ever jokes. All
   humour lives in `BlueprintUI.js` line art and the night-end card. If a gag would require the
   slasher to react, cut the gag.
2. **The puzzle is spatial, not textual.** The player must convert an exploded axonometric
   diagram into a world-space placement. Zero words on the page.
3. **Noise is the currency of risk.** Every mechanic (carrying, hammering, creaking, running)
   resolves into a single `noise:emit`. One nervous system, one tuning knob.
4. **Weight is a verb.** The slasher's mass is communicated by acceleration curves and carry
   penalties, not by animation.
5. **Failure escalates; it does not reload.** Getting seen is a story beat with mechanical
   consequences that persist across nights.

---

## 1. The Core Loop

The loop runs **once per build stage**, not once per night. A night contains **3–6 stages**.
`GameState.phase` only takes the values allowed by `ARCHITECTURE.md §8`; the loop phases below
map onto them.

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
        │            ┌─────┴──────┐                              ┌─────────────┐
        │            │ tool:missing│◀─────────────────────────── │   EVADE     │
        │            │ detour      │      (patrol converges)     │ phase=chase │
        │            └────────────┘                              └──────┬──────┘
        │                                                                │
        │                        build:stage-complete                    │
        └────────────────────────────────────────────────────────────────┘
                                        │
                          timeOfNight >= 1.0 or all stages done
                                        ▼
                                ┌───────────────┐
                                │     DAWN      │  night:complete → night-end card
                                │ phase=night-  │  night:failed   → escalation ladder §8
                                │      end      │
                                └───────────────┘
```

### 1.1 Phase timings

Target real-time minutes. `NightManager.js` owns the clock; `timeOfNight` advances
`dt / nightDurationSeconds` and **only during `phase === 'build'` or `'chase'`**. Briefing and
night-end are free.

| Phase | Target (min) | Floor | Ceiling | Clock runs? | Notes |
|---|---|---|---|---|---|
| Briefing | 0:45 | 0:15 | ∞ | No | Player may reopen the manual any time (`ui:blueprint-open`) — but *then* the clock keeps running. |
| Scavenge | 2:30 | 1:00 | 5:00 | Yes | Parts are visible from the site; the *tool* is not. |
| Haul | 2:00 | 0:40 | 4:00 | Yes | The risk phase. 60% of all detections should happen here. |
| Assemble | 3:00 | 1:30 | 6:00 | Yes | Includes the torque check per join. |
| Creak / consequence | 0:20 | 0:00 | 1:30 | Yes | Not player-driven; it is the reaction shot. |
| Evade | 1:00 | 0:00 | 4:00 | Yes | Only entered if suspicion crosses a threshold. |
| Dawn | 0:50 | 0:50 | 0:50 | No | Night-end card. |

**Night lengths** (`nightDurationSeconds`, consumed by `NightManager`):

| Night | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| Seconds | 540 | 660 | 780 | 900 | 1020 | 1140 | 1320 |
| Stages | 3 | 3 | 4 | 4 | 5 | 5 | 6 |
| Slots | 6 | 9 | 14 | 18 | 22 | 20 | 28 |

Pacing rule for `NightManager`: if the player completes a stage with more than 35% of the night
remaining per remaining stage, `Weather` is asked to raise `wind` by +0.15 and `Campers` adds one
patrol. If the player is behind by more than 25%, one Tier-3 part is quietly relocated to Tier-1.
The game hides its rubber band inside the weather.

---

## 2. The Build Puzzle

### 2.1 Part taxonomy

Owned by `BuildSystem.js`. Every part is a procedural mesh from a parameterised generator, so
"silhouette" below is the generator's read at 25 m in moonlight — this is the *only* way the
player identifies a part in the dark.

| Class | Part type | Mass (kg) | Carry class | Slots used | Silhouette | Reads in dark as | Drop noise |
|---|---|---|---|---|---|---|---|
| Structural | **Beam** (3.2 m) | 62 | D | 4 | long straight bar, square section | a line that occludes stars | 0.80 |
| Structural | **Post** (2.4 m) | 41 | D | 4 | shorter bar, chamfered top | a fencepost | 0.72 |
| Structural | **Joist** (2.6 m) | 24 | C | 3 | thin deep rectangle | a plank on edge | 0.55 |
| Structural | **Truss** (4.0 m span) | 55 | D | 4 | triangle with webbing | a shape with a *hole* in it | 0.85 |
| Surface | **Panel** (1.2 × 2.4 m) | 33 | D | 4 | flat rectangle, catches moonlight | a bright grey slab | 0.75 |
| Surface | **Sheathing board** (0.2 × 2.4) | 9 | C | 2 | thin, whippy | a stick | 0.40 |
| Surface | **Roofing shingle bundle** | 27 | C | 3 | soft-edged brick | a sandbag | 0.45 |
| Glazing | **Window unit** | 18 | C | 3 | rectangle with *specular* highlight | the only thing that glints | 0.90 (glass) |
| Hardware | **Bracket** (L / T / gusset) | 1.2 | B | 1 | small angular | a black nothing until lantern-lit | 0.30 |
| Hardware | **Fastener bag** (nominal 12) | 0.6 | A | 0 (pocket) | pouch | invisible; audible rattle | 0.15 |
| Hardware | **Hinge / latch set** | 2.1 | B | 1 | small, two-plate | glints faintly | 0.32 |
| Consumable | **Shim wedge** | 0.3 | A | 0 | wedge | invisible | 0.10 |
| Consumable | **Tallow tin** (grease) | 1.0 | A | 0 | cylinder | invisible | 0.12 |
| Tool | **Mallet / wrench / brace / plumb bob / drawknife** | 2–5 | B | 1 | held, distinctive | held-item glint | 0.25 |

**Carry classes and slots.** The player has **4 carry slots** (two hands, one shoulder = 2 slots,
one belt loop). Class A parts are pocketed and do not consume slots (pocket cap: 8 items).

| Carry class | Mass band | Slots | Speed × | Turn rate × | Can crouch? | Can sprint? | Footstep noise × |
|---|---|---|---|---|---|---|---|
| A (pocket) | < 1.5 kg | 0 | 1.00 | 1.00 | yes | yes | 1.00 |
| B (one-hand) | 1.5–8 | 1 | 0.96 | 0.95 | yes | yes | 1.05 |
| C (two-hand) | 8–35 | 2–3 | 0.82 | 0.72 | yes (0.72×) | no | 1.35 |
| D (shoulder) | 35–70 | 4 | 0.63 | 0.48 | **no** | no | 1.90 |
| E (drag) | > 70 | 4 | 0.34 | 0.30 | no | no | 2.60 + continuous scrape |

Only the **hearth stone** (night 7, 140 kg) and **bodies** are class E. Dragging emits a
continuous `noise:emit { kind:'drag', radius: 22, intensity: 0.38 }` every 0.5 s.

### 2.2 Slots: the build graph

`CabinSite.js` owns the plot and publishes the slot layout; `BuildSystem.js` owns correctness.
A blueprint is a directed acyclic graph:

```js
Slot = {
  id: 'J-04',
  stage: 2,                 // which stage unlocks it
  acceptsType: 'joist',
  transform: { position: Vector3, quaternion: Quaternion },
  axis: 'x' | 'y' | 'z',    // the axis rotation about which is "orientation"
  symmetryOrder: 2,         // 1 = one correct yaw, 2 = 180° also correct, 4 = quarter turns
  requires: ['P-01','P-02'],// slot ids that must be filled AND torque >= 0.5
  ratedMass: 180,           // kg this join is designed to support
  mirrorOf: 'J-03' | null,  // used by grammar G2
  hidden: false,            // true = not drawn in the diagram (grammar G3)
  errata: false             // true = the printed diagram for this slot is wrong (G6)
}
```

Rules:

- A slot only becomes **snappable** when every id in `requires` is filled. Un-met dependencies
  render the ghost preview in `#d92b2b` at 15% opacity and refuse the place.
- **Snap radius 0.65 m, snap angle 28°.** Inside the radius the carried part ghosts into the slot
  transform. Outside, the part behaves as a free physics body.
- Removal (`build:remove`) is always allowed but costs **8 s** and emits
  `noise:emit { kind:'wrench', radius: 24, intensity: 0.45 }` — undoing is loud. This is the
  core tension of the errata grammar.

### 2.3 The correctness model

Every `build:place` resolves to exactly one of four outcomes. `correct` in the event payload is
`true` only for **Seated**.

| Outcome | Test | `correct` | Base wrongness `w` | Immediate feedback | Ongoing consequence |
|---|---|---|---|---|---|
| **Seated** | right type, right slot, yaw within `symmetryOrder` tolerance | `true` | 0.00 | soft *thunk*, `audio:sfx { id:'join_seat' }` | none |
| **Rotated** | right type, right slot, yaw off by a non-symmetric multiple | `false` | 0.35 | seats, but with 6 mm visible offset and a 0.4 s grinding tail | creaks; blocks the *next* dependent slot's ghost by 6 mm so the error compounds visibly |
| **Wrong slot** | right type, wrong slot, dependencies met | `false` | 0.60 | seats normally — **no negative feedback at all** | the part it belonged in can never be seated; a later stage will be short one part and the player must diagnose it |
| **Wrong part** | wrong type, forced with the pry bar | `false` | 1.00 | wood splits: `audio:sfx { id:'join_split' }` + `noise:emit { kind:'impact', radius: 30, intensity: 0.6 }` | permanent 1.0 wrongness on that join; cannot be shimmed below 0.55 |

**Wrong part cannot be placed by accident.** The ghost refuses; the player must hold the place
input for 1.4 s to force it. This is a deliberate, punished choice — usually made at 04:40 when
the player is short a bracket and out of time. That decision is the game.

#### Torque / seating skill check

On a successful snap, `BuildSystem` opens the **seating check**: hold the interact input; a value
`p` ramps 0 → 1.0 over **2.2 s** with an ease-in curve (`p = (t/2.2)^1.35`). A green band sits at
`p ∈ [0.72, 0.88]`.

| Release at | `torque` stored | Result | Noise per turn |
|---|---|---|---|
| `p < 0.72` | `p * 0.9` | under-seated; contributes seating deficit | 3 taps @ 0.30 |
| `p ∈ [0.72, 0.88]` | `1.00` | **perfect join**; `stats.perfectJoins++` | 4 taps @ 0.35 |
| `p ∈ (0.88, 0.96]` | `0.80` | over-torqued, cosmetic dimple | 5 taps @ 0.40 |
| `p > 0.96` | `0.50` + split flag | wood splits, instant severity-0.7 creak | 6 taps @ 0.55 + `impact` |

Every tap is a discrete `noise:emit { kind:'hammer', radius: 34, intensity: 0.30–0.55 }`. **Under
thunder masking (§3.3) the player can hold to `p = 0.88` at zero effective risk.** Skilled play is
timing your hammering to the storm. This is the single most important interaction in the game.

The band narrows with difficulty: `bandWidth = settings.tier(0.28, 0.20, 0.16, 0.16)` — no, use
the **difficulty** setting, not the quality tier (see §10). Quality tiers never affect gameplay.

### 2.4 Why it is a puzzle and not a chore: the five (seven) grammars

`Blueprint.js` generates a wordless exploded axonometric per stage. The player reads it in
`BlueprintUI.js` — a flat, bright, Helvetica-alike overlay with thin black line art and one red
accent, rendered *over* the wet dark world. **Opening the manual does not pause the game.**

**Symbol vocabulary** (the complete set — `Blueprint.js` draws nothing else):

| Glyph | Meaning |
|---|---|
| Thin arrow, straight | insert along this vector |
| Thin arrow, curved | rotate this many degrees (arc length encodes angle) |
| The little masked man | scale reference AND the "you are here" viewpoint indicator |
| Masked man with hand raised | "two people required" — a joke; you are alone; means *heavy* |
| Circle with number | step order |
| Circle with number, dashed | step order is **not** enforced (may be done any time this stage) |
| Mirror glyph (⧗ over dashed axis) | grammar G2 in effect for this figure |
| Dotted outline | a part that exists but is occluded in this view (G3) |
| Bag icon with count | hardware manifest for the stage |
| Red exclamation triangle | over-torque warning at a specific join |
| Red slash-circle | the forbidden variant (usually the one that looks correct) |
| Small telephone icon | the parody "call customer service" — in-world it is the camp payphone. Learning that this icon means *the payphone* is a night-6 story beat. |

**Grammars, in order of introduction:**

| # | Grammar | What the player must do | Introduced | Failure mode it creates |
|---|---|---|---|---|
| **G1** | **Direct axonometric** | Read a 1:1 exploded view and map diagram-space to world-space by matching the masked man's viewpoint to your own. | N1 | Placing from the wrong side of the plot → Rotated. |
| **G2** | **Mirroring** | The figure shows the *left* assembly only, with a mirror glyph. The right assembly is its reflection — bracket handedness flips. | N2 | L-brackets installed handed-wrong → Rotated on every join of the mirrored half. |
| **G3** | **Implied hidden parts** | The bag icon says 8 gussets; the drawing shows 6. Two are behind the visible geometry. The player must reason about occlusion in the axonometric to find where. | N3 | Two unplaced gussets → understrength join → high load factor → chronic creaking. |
| **G4** | **Ambiguous scale** | Two beams differ only in length (3.2 m vs 2.6 m). No dimensions are printed. The only scale reference is the masked man (1.7 m — the player's own eye height). | N4 | Wrong slot: the 2.6 goes in a 3.2 slot, seats, and the far end floats. Discovered a stage later. |
| **G5** | **Sequence dependency** | Numbered steps are *out of drawing order* — step 5 is drawn top-left. Some slots become permanently unreachable if you fill their neighbour first (a panel installed early blocks arm access to a bracket behind it). | N5 | A blocked slot forces an 8 s loud `build:remove` to recover. |
| **G6** | **Deliberate errata** | One printed step is wrong. An **errata slip** exists as a findable world object (Tier-2/3 spawn). Without it, building as printed produces a join that can never exceed `w = 0.35`. With it, `BlueprintUI` stamps a red correction over the figure. | N6 | Trusting the manual. The comedy: the manual is confidently, serenely incorrect. |
| **G7** | **Cross-reference / continuation** | A figure ends in "see fig. 4b" — which is on *tomorrow's* sheet. A slot is deliberately left open across a night boundary; leaving it open is correct. The player must resist filling it. | N7 | Filling the deferred slot → wrong part → permanent 1.0 wrongness on the load-bearing ridge. |

Night 7 uses all seven simultaneously on a single fold-out sheet.

### 2.5 The missing-hardware comedy engine

Every stage generates a **manifest**: the exact parts and fasteners the stage consumes. Then
`Blueprint.js` removes some.

**Selection rules:**

| Night | Shortfalls | Constraint |
|---|---|---|
| 1 | 1 | Must be a tool (the mallet). Tier-1 spawn. Teaches the loop. |
| 2–3 | 1 | Chosen from a step at ≥ 40% stage progress, so the player learns the shape before needing it. |
| 4–6 | 2 | At most one may be Tier-3 (inside camp). |
| 7 | 3 | Exactly one is Tier-3, one is an errata slip, one is a fastener bag that is *short by 3* rather than absent. |

Never: the shortfall may not be the first part of a stage, and may not be a part the player has
already correctly installed elsewhere.

**Spawn tiers:**

| Tier | Distance from site | Location examples | Camper exposure | Lantern needed? |
|---|---|---|---|---|
| 1 | 20–45 m | supply pallet, fallen crate, the truck ruts | none | no |
| 2 | 60–110 m | boathouse eave, the woodpile, the dock lockbox | 1 patrol passes every ~50 s | yes, briefly |
| 3 | 120–190 m | mess hall shelf, tool shed pegboard, counselor's truck bed, the payphone alcove | 2–3 campers, one static | yes, and it is lethal to hold up |

**How the game hints.** Three layers, escalating, all diegetic:

1. **t = 0.** The manual's manifest shows the item with a **red outline and a small map inset** —
   a 40 × 40 m thumbnail of terrain contour only, no labels. It shows the *region*, never the
   object. This is `BlueprintUI` drawing from a `Blueprint` payload.
2. **t = 90 s after `tool:missing`.** `AudioEngine` begins a **1.8 s periodic metallic tick**
   at the item's position, attenuated normally by distance and occlusion — audible from ~35 m.
   `audio:sfx { id:'hardware_tick', position }`. Diegetically it is wind moving metal.
3. **t = 240 s, and only if `settings.puzzleHints !== 'off'`.** The item gets a 0.4-intensity
   rim highlight visible through one layer of foliage within 20 m.

**How finding it feels good.** On pickup: `tool:found` fires; a single clean bell
(`audio:sfx { id:'hardware_chime' }`, a struck 2.1 kHz sine with 1.4 s decay — the *only*
non-diegetic sound in the game); the manual's red outline redraws in black with a small tick mark;
`ui:toast { text:'', icon:'checkbox-filled' }` — **an empty checkbox filling in, with no words.**
That is the whole reward. It is enough because the player earned it in the dark.

---

## 3. The Creak System

The consequence engine. Owned by `BuildSystem.js`, evaluated per **join** (a filled slot).

### 3.1 The formula

Per join, per **creak tick** (every 2.0 s, staggered so no more than 6 joins evaluate per frame):

```
w  = wrongness            // 0.00 Seated | 0.35 Rotated | 0.60 Wrong-slot | 1.00 Wrong-part
s  = 1 - torque           // seating deficit, 0..1
L  = supportedMass / ratedMass                      // load factor, clamped to [0, 2.5]
Mw = 1 + 0.60*wind + 0.20*rain                      // weather stress   (from weather:change)
Mt = 1 + 0.50*timeOfNight                           // cold contraction as night deepens
Md = 1 + 0.25*creakDebt                             // §3.2

lambda = 6.0 * (w + 0.30*s) * (0.40 + 0.90*L) * Mw * Mt * Md   // creaks per minute
P(tick) = 1 - exp(-lambda * 2.0 / 60)
```

A perfectly Seated, perfectly torqued join has `w = 0`, `s = 0` → `lambda = 0`. **A correct cabin
is silent forever.** This must be true; it is the reward for reading the manual.

On a hit:

```
severity  = clamp01(0.25 + 0.55*w + 0.30*s + 0.20*min(L,1.5))
radius    = 14 + 46*severity              // metres
intensity = severity
```

Emits, in this order:

```js
bus.emit('build:creak', { position, severity });
bus.emit('noise:emit', { position, radius, intensity, kind: 'creak' });
bus.emit('audio:sfx',  { id: severity > 0.7 ? 'creak_groan' : 'creak_tick', position, rate: 0.8 + 0.5*(1-severity) });
```

`ProceduralSFX` should synthesize creaks as a filtered-noise stick-slip model: severity maps to
lower centre frequency (1600 Hz → 240 Hz) and longer envelope (0.12 s → 1.9 s).

### 3.2 Compounding — "creak debt"

`creakDebt` is a per-night scalar on the *cabin*, not per join.

- Each creak: `creakDebt += 0.06 * severity`, and `state.creaks++`.
- Decay: `creakDebt -= 0.02 per minute`.
- Clamped `[0, 3.0]`. Feeds `Md` above — **a creaking cabin creaks more.**
- At `creakDebt > 1.2`, `BuildSystem` triggers a **settle cascade**: 3–5 joins creak within 1.5 s,
  radii summed, and `Weather` is asked for a wind gust to cover it. The cascade is the game's
  scariest moment and it is entirely the player's fault.
- `creakDebt` **carries 40% into the next night** — a badly built night 3 haunts night 4. Stored
  in `state.storyFlags` as a numeric via `state.stats` (`stats.creakDebtCarry`).

### 3.3 Mitigation

| Mitigation | Cost | Effect | Notes |
|---|---|---|---|
| **Re-seat** (`build:remove` + re-place) | 8 s, `wrench` noise 0.45 | resets `torque`; cannot fix `w` from Wrong-part | the honest fix |
| **Shim wedge** (class A) | 1 shim, 2.5 s, silent | `s -= 0.35` (floor 0), and `w` reduced by 0.15 for Rotated/Wrong-slot joins | the cheat everyone loves; shims are scarce (§6) |
| **Tallow tin** (class A) | 1 tin, 3.0 s, silent | `lambda × 0.45` for **150 s** on all joins within 3 m | strictly temporary; buys you a haul |
| **Felt pad** (unlocked N5) | 1 pad, 4.0 s | `radius × 0.55` on that join permanently | reduces the *noise*, not the creak |
| **Thunder masking** | free, requires timing | see below | the skill ceiling |

#### Thunder masking (a real mechanic, owned by `Weather.js`)

`Weather` maintains a deterministic storm schedule per night, seeded from `ctx.rand`. It exposes:

```js
Weather.nextStrikeIn()   // seconds until the next lightning flash, or Infinity
Weather.maskLevel()      // 0..1, current global audibility suppression
```

Sequence per strike:

1. **Flash.** `Sky.js` fires the lightning; `Materials.globalUniforms.uLightning` spikes. The
   flash also **silhouettes the player** — see §4.1 (exposure). Lightning is a double-edged tool.
2. **Delay.** `thunderDelay = distance_km * 2.9 s`, distance drawn from `rand.range(0.4, 4.2)`.
   The player learns to count. **This is a genuine skill: the flash tells you when to swing.**
3. **Thunder envelope.** Duration `2.5 + 3.5*(1 - distance/4.2)` seconds. During it,
   `maskLevel()` ramps 0 → 0.85 over 0.4 s, holds, then decays over 1.2 s.
4. `NoiseSystem.js` multiplies every noise's effective intensity by `(1 - maskLevel())` before
   propagation. It does **not** shrink the radius — the noise still exists, campers just don't
   resolve it.

Rain provides a constant floor: `maskFloor = 0.30 * rain`. `maskLevel = max(maskFloor, thunder)`.
Rain also raises creak probability (`Mw`) — **the weather that hides you is the weather that
makes the cabin talk.** That trade is the whole weather design.

---

## 4. Stealth

Owned by `Campers.js` (agents + senses + FSM), `Navmesh.js` (patrol graph), `NoiseSystem.js`
(propagation). Everything below is per-camper.

### 4.1 Vision

```
Cone:      horizontal FOV 110° total, vertical 70°
Foveal:    0–35° off-axis   → sensitivity 1.00
Peripheral:35–55° off-axis  → sensitivity falls 1.00 → 0.20 on smoothstep
Beyond 55°: 0 (with one exception: motion within 3 m always registers at 0.35)
```

| Camper archetype | Base range R (m) | FOV | Torch? | Hearing threshold | Notes |
|---|---|---|---|---|---|
| **Camper (kid)** | 16 | 100° | no | 0.18 | wanders, poor discipline, flees fast |
| **Counselor** | 24 | 110° | yes (flashlight cone) | 0.11 | patrols the navmesh, investigates properly |
| **Head counselor** | 28 | 115° | yes, wide | 0.09 | night 5+; carries the whistle; can raise camp-wide suspicion alone |
| **The Ranger** | 34 | 120° | yes, vehicle lights | 0.08 | night 6+, only after a completed report; §8 |

Detection accrual per second while the player is inside the cone and not fully occluded:

```
rangeF   = clamp01(1 - (d / R)^1.6)
lightF   = 0.25 + 1.75 * lum           // lum = illumination at player, 0..1
motionF  = { still 0.30, crouch-walk 0.65, walk 1.00, sprint 1.65 }
carryF   = 1 + 0.10*carrySlotsUsed     // 1.00 .. 1.40
exposeF  = 1 + 0.50*skylineFraction    // silhouette against sky/water/lightning
occlF    = visibleFraction             // 0..1 from 5 sample raycasts (head, shoulders×2, hips×2)

dDetect/dt = 1.0 * fovSens * rangeF * lightF * motionF * carryF * exposeF * occlF * diffMul
```

**Illumination `lum`** is sampled by `Player.js` each frame (cheap: moon dot + nearest 4 point
lights + own lantern) and published on `player:move` implicitly via `Player.illumination`. Own
lantern on = `lum += 0.55`. A counselor's flashlight cone hitting the player = `lum += 0.70` and
`R × 1.42` inside that cone's 18° core.

**Skyline detection** is real and matters: standing on the ridge above the plot, or on the roof
trusses at night 5, sets `skylineFraction` toward 1.0. `Physics.js` computes it as the fraction of
the 5 sample rays that exit to sky. **A lightning flash forces `exposeF = 2.0` for 0.25 s** — do
not be standing in the open when you called down the thunder you wanted.

**Detection meter behaviour:**

| Detection value | State | Feedback |
|---|---|---|
| 0.00 | clear | nothing |
| 0.01–0.35 | forming | a faint directional smear at screen edge (`HUD`), 8% opacity. No icon, no number. |
| 0.35–0.75 | building | smear brightens; camper plays `audio:vo { id:'vo_hm_*' }` from `VoiceBank` |
| 0.75–0.99 | critical | a single low heartbeat-rate string tone from `Music.js`; camper stops walking |
| 1.00 | **spotted** | `player:spotted { camper, level:1.0 }`; camper → Alerted |

Decay: after **1.2 s** with `occlF === 0` or outside the cone, detection decays at **0.25/s**,
accelerating to 0.45/s below 0.3. Detection **never resets instantly** — breaking line of sight
buys you time, not amnesty. Partial memory: the peak value reached is stored and the decay floor
is `0.15 * peak` for 20 s.

### 4.2 Hearing (`NoiseSystem.js`)

`noise:emit { position, radius, intensity, kind }` → for each camper within `radius`:

```
falloff   = clamp01(1 - d/radius)^1.5
occlusion = product of blocker factors along the ray (max 4 blockers sampled)
mask      = 1 - Weather.maskLevel()
heard     = intensity * falloff * occlusion * mask
```

| Blocker | Factor |
|---|---|
| Tree trunk | 0.88 |
| Dense undergrowth (per 2 m) | 0.92 |
| Terrain ridge (ray below heightfield) | 0.50 |
| Cabin wall / panel | 0.65 |
| Tent canvas | 0.90 |
| Boathouse / mess hall wall | 0.45 |

If `heard > camper.hearingThreshold` the camper takes a **noise hit**: it stores
`lastNoisePos` (with error radius `4 + 14*(1 - heard)` metres — **campers investigate an
approximate point, not your exact position**) and advances the FSM.

**Canonical `noise:emit` kinds** (the complete vocabulary — all agents use these strings):

| kind | radius (m) | intensity | Emitter |
|---|---|---|---|
| `footstep` (crouch) | 4 | 0.08 | Player |
| `footstep` (walk) | 9 | 0.18 | Player |
| `footstep` (sprint) | 20 | 0.45 | Player |
| `footstep` (carry D) | 14 | 0.30 | Player |
| `brush` | 6 | 0.12 | Player vs foliage |
| `drag` | 22 | 0.38 | Player, class E |
| `drop` | 16 / 26 / 40 | 0.35 / 0.55 / 0.80 | BuildSystem, by carry class B/C/D |
| `impact` | 30 | 0.60 | split wood, thrown part landing hard |
| `hammer` | 34 | 0.30–0.55 | BuildSystem torque check |
| `wrench` | 24 | 0.45 | BuildSystem removal |
| `creak` | 14–60 | = severity | BuildSystem |
| `throw` | 18 | 0.40 | Player decoy, emitted **at the impact point** |
| `whistle` | 90 | 0.90 | Campers (head counselor) |
| `thunder` | 400 | 1.00 | Weather (masking only; campers ignore) |
| `voice` | 26 | 0.30 | Campers talking; used for player awareness, campers ignore |

### 4.3 The suspicion state machine

Per camper. Camp-wide `state.suspicion` is separate (§8).

| State | Enter condition | Behaviour | Exit → | Timer |
|---|---|---|---|---|
| **Idle** | default | Follows `Navmesh` patrol loop at 1.2 m/s, or sits at a fire. Scans ±40° every 4 s. | Curious | — |
| **Curious** | one noise hit `heard ∈ (thr, 0.35]`, **or** detection ∈ [0.35, 0.75) | Stops. Turns toward `lastNoisePos`. Raises torch. Speed 0. `audio:vo { id:'vo_curious_*' }` | → Searching if a 2nd hit or detection ≥ 0.75; → Idle after **6 s** quiet | 6 s |
| **Searching** | `heard > 0.35`, or 2 hits in 8 s, or Curious escalation | Walks to `lastNoisePos` at 1.8 m/s, sweeps torch in a 90° arc, checks 2–3 nearby cover points chosen by `Navmesh`. | → Alerted on `player:spotted`; → Curious after **18 s**; → Idle after **30 s** total | 30 s |
| **Alerted** | detection reaches 1.00, or physical contact | Sprints away from the player at 3.4 m/s toward the nearest **rally point** (campfire, cabin porch, counselor). Shouts: `noise:emit { kind:'whistle' }` if counselor. Camp suspicion +0.25. | → Panic if player closes to < 6 m; → Flee/Report on reaching rally | — |
| **Panic** | player within 6 m while Alerted | 4.1 m/s, erratic pathing, drops what it's carrying, screams (`whistle` every 3 s). Cannot be calmed. | → Flee/Report, or removed by the player | — |
| **Flee / Report** | reached a rally point, or reached the payphone | Delivers the report over **12 s**. On completion: camp suspicion +0.40, patrol density +2, `story:beat { id:'report_delivered' }`. | terminal for the night | 12 s |

Interrupting a report: reaching the camper before the 12 s completes cancels it (and forces a
choice — see §8.3). The 12 s window across 90 m of dark forest, while carrying a 62 kg beam, is
the game's best sequence and it should happen on night 4.

### 4.4 The player's tools

| Action | Input | Cost | Effect |
|---|---|---|---|
| **Crouch** | hold/toggle | speed 0.9 m/s | `motionF` 0.65, footstep noise 0.08, height 1.15 m (breaks LOS behind the foundation wall) |
| **Freeze** | release all input | — | `motionF` 0.30 after 0.4 s of stillness; the single strongest defence |
| **Break LOS** | movement | — | starts the 1.2 s grace then 0.25/s decay |
| **Douse lantern** | tap | 0.6 s relight (loud-ish click, `radius 5`) | `lum -= 0.55`; halves effective detection at range in most conditions |
| **Hide behind the build** | positioning | — | the cabin's own panels are `occlusion 0.65` blockers **and** LOS blockers. The thing you are building is your best cover. Panels installed = safety earned. |
| **Throw a bracket** | hold + release | costs 1 hardware item | arcs to a point; `noise:emit { kind:'throw', radius:18, intensity:0.40 }` at impact. Pulls Curious/Searching campers to that point ± error radius. **The comedy: you are throwing away the hardware you are already short of.** |
| **Grab** (N3+) | close contact from behind | 4.5 s, silent if unseen | see §8.3 |

---

## 5. The Player

Owned by `Player.js` + `Physics.js`. Eye height 1.7 m, capsule radius 0.42 m (wide — you bump
things), gravity -22.

### 5.1 Movement

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
| Turn rate cap | **220°/s** | mouse input is rate-limited; you physically cannot whip around |
| Turn accel | 1400°/s² | the first 0.16 s of any turn is slow |
| Crouch transition | 0.42 s down, 0.55 s up | |
| Head bob | 0.055 m vertical @ 1.9 Hz walking | `settings.headBob` |
| View noise | ±0.35° perlin, always on | "handheld camera", per `ARCHITECTURE.md §11` |

**Why this feels heavy, in numbers, not animation:**

1. **Turn acceleration.** 1400°/s² means a 180° turn takes 0.71 s minimum. Most FPS games are
   instant. This single number does 60% of the work.
2. **Decel > accel, and both are low.** You commit to a direction. There is no strafe-dance.
3. **Sprint spin-up of 1.9 s.** Sprinting is a decision made 2 seconds ago, not a panic button.
4. **Crouch-up takes 0.55 s** — standing up is slower than crouching down. Getting small is easy;
   getting mobile is not.
5. **Capsule radius 0.42 m** vs a typical 0.3 — you clip undergrowth constantly, which emits
   `brush` noise. You are too big for this forest.
6. **Camera height 1.7 m with 0.055 m bob at 1.9 Hz** — a slow, long stride, not a jog.

### 5.2 Stamina

```
staminaMax   = 100
sprintDrain  = 16.0 /s   (× 1 + 0.6*carryMassNormalized)
regenDelay   = 2.2 s after sprint ends
regenRate    = 11.0 /s   (crouched: 15.0 /s — the slasher recovers by being still)
exhausted    = stamina hits 0 → sprint locked until stamina ≥ 35
```

Sprinting at class A: 6.25 s of sprint = 26 m. **You cannot outrun a camper (3.4 m/s) for long,
and you should not try — you catch them by cutting them off, using the terrain the level design
gives you.** Class C and D cannot sprint at all.

Breathing: above 60% stamina drain, `AudioEngine` layers a low breath loop at `radius 5,
intensity 0.10` — **your own breathing is an emitted noise**. Campers at < 5 m can hear it.

### 5.3 Carrying

`Physics.js` simulates carried parts as constrained rigid bodies, not attached meshes.

- A carried class C/D part **sways** with a spring (k = 28, damping 0.55). It occupies world
  space. It clips trees.
- **Bumping** a carried part into geometry above 1.2 m/s relative speed →
  `noise:emit { kind:'impact', radius: 18, intensity: 0.25 + 0.4*speedNorm }`.
- Class D parts obstruct **28° of the lower screen**. You cannot see your feet while hauling a
  beam. This is the design.
- **Drop** is instant and loud (§4.2 table). **Set down** takes 2.1 s and is silent. Under
  pressure, everyone drops.
- Carrying two class-C parts is possible (4 slots) but stacks the speed penalty multiplicatively:
  `0.82 × 0.82 = 0.67`.

---

## 6. Resources & Economy

### 6.1 Scavengeable inventory

| Resource | Per-night spawn count | Where | Respawn |
|---|---|---|---|
| Structural parts (this stage's manifest) | exactly N required | supply pallet (Tier 1) | none — they are the puzzle |
| Spare fasteners | `rand.int(4, 9)` bags | scattered Tier 1–2 | +2 at each `build:stage-complete` |
| Shim wedges | `rand.int(2, 4)` | woodpile, sawdust piles | none within a night |
| Tallow tins | `rand.int(1, 2)` | mess hall (Tier 3), boathouse (Tier 2) | none |
| Felt pads (N5+) | 2 | counselor's truck | none |
| Lantern fuel can | 2 | Tier 1 and Tier 2 | one Tier-1 respawn at `timeOfNight > 0.6` |
| Throwables (loose brackets) | 6 | anywhere | none |
| Errata slip (N6+) | 1 | Tier 2 or 3, seeded | none |

All positions come from `new Rand(hash2(night, spawnIndex) * 1e9 | 0)` so the world is
reproducible for screenshot regression, per `ARCHITECTURE.md §6`.

### 6.2 The lantern (`Flashlight.js`)

The player's lantern is amber (`#ffb865`), a `SpotLight` at intensity ~40, `decay: 2`,
volumetric cone.

| Parameter | Value |
|---|---|
| Fuel capacity | 100 units |
| Burn rate (full beam) | 0.55 units/s → **3:02 of continuous light** |
| Burn rate (hooded, 35% cone, 40% intensity) | 0.22 units/s → 7:35 |
| Fuel can restores | 45 units |
| Ignite / douse time | 0.9 s / 0.25 s |
| Detection penalty | `lum += 0.55` full, `+0.22` hooded |
| Below 15 units | flame gutters; intensity flickers 0.6–1.0 at 3 Hz; **flicker itself is a detection spike** (`lightF` samples the instantaneous value) |
| At 0 | you build in moonlight. `Blueprint` figures become nearly unreadable — this is the real punishment. |

The lantern's *deepest* cost is that you cannot read the manual without it.

### 6.3 The only currency: time until dawn

`state.timeOfNight` 0 → 1. Everything else is a means to spend it.

| Action | Time cost |
|---|---|
| Walk 100 m (unloaded) | 62 s |
| Walk 100 m (class D) | 99 s |
| One seating check | 2.2 s + travel |
| One removal + re-place | 8 s + 2.2 s |
| Tier-3 hardware run | 180–320 s |
| Waiting for a Searching camper to give up | 30 s |
| Waiting for thunder to hammer under | 20–90 s |

The night-end card grades against this. `NightManager` displays no clock — the only time
indicators are diegetic: the moon's altitude (`Sky.js`), the fog thickening after 0.7, and the
camp's fires dying at 0.55. **At `timeOfNight > 0.85` the sky's horizon shifts 6% toward
`#2a3340`. Players learn this tell in about three nights and it is terrifying.**

---

## 7. The Seven Nights

One new idea per night. Everything recombines on night 7.

| Night | Build target | New mechanic | New grammar | Campers | Weather | Shortfall | Est. time |
|---|---|---|---|---|---|---|---|
| **1** | 6 foundation piers + sill beams | slots, snapping, seating check | G1 direct axonometric | 1 counselor, distant, on a fixed loop that never reaches the plot | clear, still (`wind 0.05`) | the **mallet**, Tier 1, 30 m | 9 min |
| **2** | 9 floor joists | **creaks** (first wrong join is scripted to creak); throwing a bracket | G2 mirroring | 2 counselors patrolling; first real cone | light wind 0.25 | 4 L-brackets, Tier 2 | 11 min |
| **3** | 14 wall studs + corner posts | **class D hauling**; shims; the **grab** | G3 implied hidden parts | 3 (2 counselors + 1 kid wanderer) | first rain 0.4; mask floor 0.12 | gusset plates ×2, Tier 2 | 13 min |
| **4** | 18 sheathing panels | **tallow / grease**; panels become cover; first report chase | G4 ambiguous scale | 4, incl. patrol overlap at the plot's east edge | rain 0.6, wind 0.4 | 2 shortfalls: a panel + the brace tool (Tier 3, mess hall) | 15 min |
| **5** | 22 roof trusses + purlins | **height + ladder + skyline exposure**; felt pads; **thunder masking becomes mandatory** (the truss hammering is 6 taps × 8 joins) | G5 sequence dependency | 5, head counselor with whistle | **storm**: wind 0.75, rain 0.7, 6 strikes | 3 truss pins + tallow, Tier 3 | 17 min |
| **6** | 20 glazing units, door, hinges | **the errata slip**; the payphone becomes real; the Ranger's truck arrives if you were reported | G6 deliberate errata | 5 + Ranger (conditional) | clearing: fog 0.8, wind 0.2 — **low masking, high visibility. The scariest night.** | errata slip + hinge set + short fastener bag | 19 min |
| **7** | 28 slots: chimney (class E hearth stone), porch, roof cap, **the Chair** | everything; camp is awake; `suspicion` starts at whatever you earned | **all seven**, one fold-out sheet | 7 + head counselor + Ranger | breaking storm → dead calm at `timeOfNight 0.8`. The last 20% has **zero masking.** | 3: Tier-3 item, errata slip, fastener bag short by 3 | 22 min |

**The Chair** (night 7, final slot): a single wooden chair, 4 slots, faces the door. The manual's
last figure is the masked man sitting in it. There is no explanation. This is the only joke the
world tells, and it tells it with a straight face.

**Carryover between nights:** `state.suspicion` decays 45% overnight (floor: 0.10 per prior
report). `creakDebt` carries 40%. Wrong joins **persist** — a Rotated joist from night 2 is still
Rotated on night 7, still creaking, still audible. The cabin is a record of your reading
comprehension.

---

## 8. Fail States & "Failure Is Interesting"

**Being seen is never a game over.** It is the start of a sequence.

### 8.1 The escalation ladder

| Rung | Trigger | Camp effect | Patrols | Player feels |
|---|---|---|---|---|
| 0 | — | `suspicion 0.00–0.15` | base | quiet |
| 1 | 3 noise investigations in one night | `+0.10`, campers pair up | +0 | torches sweeping wider |
| 2 | `player:spotted` once | `+0.25` | +1 | a voice calling a name that isn't a name |
| 3 | A report delivered (`story:beat 'report_delivered'`) | `+0.40`, **camp lights come on** (2 new point lights, `lum` floor +0.15 in camp) | +2 | the mess hall is lit; Tier-3 is now suicide |
| 4 | 2 reports, or a body found | `+0.35`, head counselor spawns with whistle, kids are recalled to cabins (**fewer wanderers — the forest gets emptier and worse**) | +1 counselor, −2 kids | the woods go silent |
| 5 | 3 reports | The Ranger's truck arrives at `timeOfNight + 0.15`. Headlights sweep the treeline on a 40 s cycle: a moving 26 m detection cone with `lightF` 0.9. | +Ranger | a machine is looking for you |
| 6 | **Radio call completes** at the payphone or the truck | **Night ends immediately.** `night:failed { reason: 'reported' }` | — | the run is wounded |

`suspicion` is clamped [0, 1] and drives `Campers.patrolDensity = 2 + floor(suspicion * 6)`,
capped at the night's max.

### 8.2 What actually ends a run

`night:failed` reasons, in the payload's `reason` field:

| `reason` | Condition | Consequence |
|---|---|---|
| `'reported'` | rung 6 reached | Night ends. **Next night starts with `suspicion` 0.45 floor and one fewer stage of buildable slots** (the camp posts a watch on the ridge). Not a game over. |
| `'dawn'` | `timeOfNight >= 1.0` with stage incomplete | Night ends. Unbuilt slots roll into the next night's slot budget. Not a game over. |
| `'exposed'` | The player is fully lit within 8 m of 3+ Alerted campers | Forced retreat: a 45 s escape window with the whole camp Searching. Survive it and the night continues. |
| `'evacuated'` | **Game over.** Three `'reported'` nights, OR any `'reported'` on night 6 or 7. | The camp buses out at dawn. The cabin is finished and empty. Credits over an unused cabin. This is the losing ending and it is quiet and sad and correct. |
| `'incomplete'` | **Game over.** Night 7 ends with the roof cap or door unbuilt. | Campers arrive to an unfinished structure. Different credits. |

`state.phase = 'gameover'` only on `'evacuated'` and `'incomplete'`.

### 8.3 The thing you can do about it

You are the slasher. From night 3 the **grab** exists: 4.5 s of contact from behind an unaware
camper, silent. It solves the immediate problem and creates three new ones:

1. A **body** — class E, must be dragged (2.6× noise, 0.34× speed) at least 40 m from any patrol
   node or hidden under the boathouse / in the lake / under the build.
2. **Body found** → escalation rung 4, immediately and permanently.
3. **The manual notices.** From the next stage onward, `Blueprint` includes a small extra figure
   in the corner: the masked man, standing, with a red slash-circle over a second small figure.
   It is a safety warning. It is not commented on. The player will feel it in their stomach.

Kill count is tracked in `state.storyFlags` and changes only the night-end card's
"customer satisfaction" line and the ending stinger. **The game never says killing is wrong. It
just quietly adds a page to the manual.**

---

## 9. Scoring & the Night-End Card

Rendered by `Menu.js` on `night:complete { night, score }`. Flat, bright, clinical — white paper,
thin black lines, one `#d92b2b` accent, Helvetica-alike. It should feel like a receipt printed by
something that does not know what it is a receipt for.

```
Score = {
  partsInstalled, partsTotal,
  joinsCorrect, joinsRotated, joinsWrongSlot, joinsWrongPart,
  perfectJoins, creaks, peakCreakDebt,
  metresWalked, metresHauled,
  campersEvaded, reportsDelivered,
  timeUsed, timeRemaining,
  hardwareShortfalls, hardwareRecovered,
  satisfaction   // 0..100
}
```

```
satisfaction = clamp(
    100
  - 6.0 * joinsRotated
  - 11.0 * joinsWrongSlot
  - 22.0 * joinsWrongPart
  - 1.5 * creaks
  - 18.0 * reportsDelivered
  + 3.0 * perfectJoins
  + 8.0 * (timeRemaining > 0.15 ? 1 : 0),
  0, 100)
```

**The card copy** (all of it deadpan, none of it acknowledging the murder):

| Line | Example values |
|---|---|
| `ASSEMBLY REPORT — STEP 3 OF 7` | |
| `PARTS INSTALLED` | `14 / 14` |
| `JOINS, CORRECT` | `11` |
| `JOINS, ORIENTED CREATIVELY` | `2` |
| `JOINS, WHICH WE WILL NOT DISCUSS` | `1` |
| `AUDIBLE COMPLAINTS FROM THE STRUCTURE` | `9` |
| `HARDWARE SUPPLIED` | `LARGELY` |
| `HARDWARE ACTUALLY REQUIRED` | `MORE` |
| `DISTANCE CARRIED` | `1,204 m` |
| `PERSONS WHO EXPRESSED CONCERN` | `3` |
| `PERSONS WHO EXPRESSED CONCERN TO OTHERS` | `1` |
| `TIME REMAINING BEFORE SUNRISE` | `00:41` |
| `CUSTOMER SATISFACTION` | `62 / 100` |
| `THANK YOU FOR CHOOSING SELF-ASSEMBLY.` | (always) |

At satisfaction ≥ 95: `PERFECT. WE HAVE NOTHING TO ADD.`
At satisfaction ≤ 20: `PLEASE RETAIN THIS DOCUMENT FOR YOUR RECORDS.`
At any kill count > 0, one extra line, last, in red: `PLEASE ASSEMBLE ALONE.`

---

## 10. Accessibility & Options

**Requested additions to `Settings` (`ARCHITECTURE.md §7`)** — Engine agent to add these exact
keys; every other system reads them via `settings.get()`:

```js
difficulty: 'standard',     // 'story' | 'standard' | 'gristle'
puzzleHints: 'standard',    // 'off' | 'standard' | 'generous'
creakAssist: false,         // true = wrong joins get a persistent diegetic marker
holdToCarry: true,          // false = toggle instead of hold
photosensitive: false,      // caps lightning flash rate + luminance delta
subtitleSize: 'medium',     // 'small'|'medium'|'large'
subtitleBackdrop: true,
directionalAudioIndicator: false,   // arc at screen edge for off-screen noises
reduceViewNoise: false,     // damps the handheld camera noise
```

### 10.1 Difficulty modes

| | `story` | `standard` | `gristle` |
|---|---|---|---|
| `diffMul` (detection accrual) | 0.62 | 1.00 | 1.35 |
| Night duration × | 1.30 | 1.00 | 0.85 |
| Creak `lambda` × | 0.60 | 1.00 | 1.25 |
| Torque green band width | 0.28 | 0.16 | 0.10 |
| Shortfalls per night | −1 (min 1) | as §2.5 | +1 |
| Reports to `'evacuated'` | 5 | 3 | 2 |
| Grammar G6 errata | slip always Tier 1 | as designed | slip may not exist |
| Manual stays open while walking | yes | yes | **no** — you must stop to read |

`gristle` is unlocked from the start. Difficulty is changeable mid-run, no penalty, no shaming
copy. The night-end card does not mention it.

### 10.2 Vision & motion

- **Colorblind** (`settings.colorblind`): the game's only load-bearing colour is the manual's
  `#d92b2b` red. In deuteranopia/protanopia modes it becomes `#0b57d0` blue; in tritanopia,
  `#c2185b` magenta. **Additionally, every red mark is redundantly encoded** with a 1.5 pt dashed
  stroke and a corner tick — colour is never the only channel.
- **Contrast:** a `manualContrast` slider raises the blueprint overlay's paper luminance and
  stroke weight independent of the 3D scene's exposure.
- `settings.motionBlur`, `filmGrain`, `chromaticAberration`, `vignette`, `headBob` all disableable
  per `ARCHITECTURE.md §7`. `reduceViewNoise` damps the handheld noise from ±0.35° to ±0.08°
  without removing it (fully removing it breaks the "big heavy man" read; the game asks first).
- `photosensitive: true` caps lightning to 1 flash per 12 s, luminance delta ≤ 25%, and
  **compensates** by lengthening thunder windows 1.4× so the masking mechanic is unharmed.

### 10.3 Audio & puzzle

- **Subtitles** (`settings.subtitles`) cover all `ui:subtitle` events. Distant camper VO is
  subtitled with a **direction and distance prefix**: `[NE, distant] "...did you hear that?"`.
  Non-verbal but mechanically relevant sounds are captioned too: `[creak — north, near]`,
  `[thunder — 3 seconds]` (the last one is essential for deaf players to use thunder masking).
- `directionalAudioIndicator: true` draws a thin arc at the screen edge for any `noise:emit` the
  player produced above intensity 0.3 and any camper `voice` within 40 m.
- `puzzleHints`:
  - `off` — no map inset, no tick, no rim light. The manual and nothing else.
  - `standard` — the three-layer hint ladder in §2.5.
  - `generous` — adds a persistent diegetic marker: the missing item's location is chalk-marked
    on the manual's map inset with an ✕, and a wrong join shows a small red thread tied to it in
    world-space. Nothing is highlighted through walls; nothing pauses time.
- `creakAssist` — wrong joins get a permanent thin red chalk line drawn on the timber at the
  join. **Recommended default for players who find the diagnostic layer frustrating.** It removes
  the *detective* game, not the *stealth* game.

**The design rule for accessibility here:** the horror lives in darkness, weight, and time
pressure — none of which we relax. The frustration lives in *not knowing what you did wrong*,
which we are happy to relax completely.

---

## 11. The First Five Minutes

Zero text tutorial. Zero prompts beyond the icon-only `ui:toast`. Everything is taught by the
manual and by level design. Night 1, `nightDurationSeconds = 540`, `wind 0.05`, no rain, full
moon, one counselor on a loop that will not reach the plot.

| t | Beat | Systems | What it teaches |
|---|---|---|---|
| **0:00** | Black. A single `audio:sfx { id:'crate_settle' }`. Then rain-off, wind in pines, and one distant camper laugh from 140 m NE (`audio:vo`, 3D). | Audio, Sky | The world before the interface. |
| **0:04** | Fade in over 3 s. You are looking down at your own hands, which are enormous, holding a folded paper. `settings.fov 72`. The manual is already open at 40% of screen. | Player, HUD, BlueprintUI | *This is a game about a piece of paper.* |
| **0:09** | The manual's first figure: the masked man, a single pier block, and a straight arrow pointing down into a square outline on the ground. Below it: `1/6`. | Blueprint (G1) | The whole grammar, in one picture. |
| **0:14** | Player looks up (mouse). Manual auto-lowers to hip. Ahead: six square outlines chalked on cleared ground, glowing faintly in moonlight, and a supply pallet 6 m away with six pier blocks on it. | CabinSite | Diagram-space → world-space. The chalk squares literally match the drawing. |
| **0:22** | First step. Head bob, breath, the 0.23 s accel ramp. A `footstep` noise emits; nothing hears it. | Player, NoiseSystem | Weight. Slowness. |
| **0:34** | The player walks into a low branch (deliberately placed, 1.9 m). `brush` noise. The branch rustles for 1.1 s. Far away, the counselor's torch **stops moving for 2 s**, then resumes. | Campers (Curious→Idle) | *Noise reaches people. People react. You survived it.* Taught without any risk. |
| **0:41** | Reaching the pallet, `ui:toast { icon:'hand' }` — a hand icon, 900 ms, no words. Pick up a pier block (class C, 24 kg). Speed drops to 0.82×. Screen tilts 2°. | BuildSystem, Physics | Carrying costs. |
| **0:55** | Approach the nearest chalk square. A white ghost of the pier appears in the slot at 0.65 m. | BuildSystem | Snapping. |
| **1:02** | Place. `build:place { correct:true }`. Soft thunk. The seating check opens automatically **the first time only**, with the green band drawn at 2× width and time slowed to 0.6× for this one instance. | BuildSystem | The torque check, in a safe room. |
| **1:07** | Perfect join. `stats.perfectJoins = 1`. The manual, still at hip, redraws `1/6` as `1` with a tick. **No sound, no toast.** | BlueprintUI | Progress is legible on the paper, not the HUD. |
| **1:12–2:05** | Piers 2, 3, 4. The player finds their rhythm: pallet → slot → seat. Around pier 3 they will start hammering casually. **On pier 4, a distant camper voice reacts to the hammering** — `[NE, distant] "…what is that?"` — and the torch stops for 4 s. Nothing else happens. | Campers, VoiceBank | The hammering is heard. Bank it. |
| **2:05** | Pier 5. The pallet is **empty**. There are six squares and five blocks were supplied. `tool:missing { toolId:'pier_06' }`. The manual's manifest shows the sixth pier outlined in red, with a 40 m contour inset. | Blueprint, BuildSystem | **The core comedy, in the first three minutes.** |
| **2:12** | The player looks around. Nothing is highlighted. They have to read the contour inset against the terrain they can see. The inset shows a slope and a fallen log. | BlueprintUI, Terrain | Spatial reading is the skill. |
| **2:40** | 32 m NW, down a slope, behind a fallen log: the sixth pier, half-buried, and next to it the **mallet** — which the player did not know they were missing, because they had been using their hands. | CabinSite | The joke lands twice. |
| **2:48** | `tool:found` ×2. The bell. Two red outlines redraw in black. The mallet goes to the belt. | BuildSystem, Audio | The reward feeling, established. |
| **2:55** | Carrying the pier back **uphill** — class C, 0.82× on a 14° grade (further ×0.88) — the counselor's patrol loop crosses the return path at 45 m. The player sees the torch. | Campers, Navmesh | The first real stealth read. The counselor **cannot** reach the plot; this is theatre, and it is safe. But the player does not know that. |
| **3:20** | Most players crouch here without being told. If they do: `motionF 0.65`, footsteps 0.08, and the torch passes. If they don't: detection reaches ~0.30 and decays. Either way they survive. | Campers, Player | Crouching is discovered, not instructed. |
| **3:50** | Pier 6 placed. `build:stage-complete { stage:1 }`. The manual turns its own page with a paper sound. Figure 2: sill beams, class D, 62 kg. | BuildSystem, BlueprintUI | Escalation of mass. |
| **4:05** | First class-D lift. Speed 0.63×. **The beam blocks the lower 28° of the screen.** The player cannot see their feet. They walk 18 m like this. | Physics | The hauling terror, at zero risk, on flat ground. |
| **4:30** | Placing beam 1: the ghost only appears at one yaw. Placing it 180° off is *possible* (`symmetryOrder 2` — it is correct either way). Beam 2 has `symmetryOrder 1`. **If the player rotates it wrong, it seats, and it creaks 9 seconds later.** | BuildSystem | The creak, taught by the player's own hand. |
| **4:39** | The first creak. Severity ~0.45, radius 35 m. A long, wet groan from the wood. `build:creak`. The distant camper voice: `[NE, distant] "…okay, seriously."` The torch turns toward the plot and **starts walking.** | BuildSystem, Campers | **The thesis statement of the entire game, delivered in one sound.** |
| **4:52** | The player must now: re-seat the beam (8 s, loud), or hide, or freeze. All three work. The counselor Searches for 30 s at a point 12 m off, then returns to Idle. | Campers | Every tool in §4.4 is now motivated. |
| **5:00** | The player understands the game. No word has been written on screen. | | |

**The make-or-break test for this sequence:** at 4:39, if the player does not physically flinch
and immediately understand that a badly-built cabin is a monster that tells on them — the game has
failed and the sequence must be retuned until it does.

---

## 12. Implementation notes for module owners

- **`BuildSystem.js`** owns `state.installed`, `state.inventory`, `state.creaks`,
  `stats.perfectJoins`. It is the only writer of `build:*` and `tool:*` events.
- **`Blueprint.js`** exposes `Blueprint.forNight(n, rand)` → `{ stages: [...], manifest, grammars,
  shortfalls, errata }`. It draws nothing; `BlueprintUI.js` renders it to DOM/canvas.
- **`Campers.js`** is the only listener of `noise:emit` that changes behaviour. It owns
  `state.suspicion` and `state.spotted`, and is the only emitter of `player:spotted` /
  `player:hidden`.
- **`Weather.js`** owns `weather:change` and must expose `nextStrikeIn()` and `maskLevel()` as
  plain synchronous methods — `NoiseSystem` calls `maskLevel()` once per frame and caches it.
- **`NightManager.js`** owns `state.night`, `state.phase`, `state.timeOfNight`, and is the only
  emitter of `night:*` and `story:beat`.
- **`Player.js`** must expose `Player.illumination` (0..1) and `Player.carrySlotsUsed` (0..4) as
  read-only properties; `Campers` null-checks both.
- Everything in this document that is a tunable belongs in a single exported `TUNING` object per
  module so a balance pass never requires editing logic.
- **Gameplay constants must never be routed through `settings.tier()`.** Quality tiers change
  pixels, never numbers that affect outcomes.
