# Slasher Cabin: Some Assembly Required — ART DIRECTION BIBLE

**Revision 2. Status: BINDING.**

This document is the visual contract. `ARCHITECTURE.md` is the code contract; where the two touch
(module names, event names, quality tiers, `Materials.globalUniforms`), the architecture wins on
*shape* and this document wins on *value*. Every number below is a default you implement first and
only tune with a screenshot — or a captured frame timing — to justify it.

**What changed in revision 2, and why you should care.** Revision 1 was a cinematography bible
wearing a game document's clothes. It specified with four-decimal precision how light would fall
and never specified the story it was lighting, the humans it was falling on, the small grey object
the player has to find in the mud, what a wrongly-built joint looks like, or whether the render
stack it described could run in a browser at all. Revision 2 adds, in order of importance:

- **§0 Story contract** — premise, protagonist, seven-night beat sheet, reveal, ending, and a
  column binding every beat to the art device that carries it. Nothing downstream may say
  "escalation" without pointing at a row in §0.4.
- **§4 Readability contract** — the section that makes a small galvanized bracket findable in wet
  black mud. This is a puzzle game; revision 1 forgot the puzzle.
- **§7 The build** — a per-night structural silhouette table and a *wrongness legibility* spec,
  because "build it wrong and it creaks" was previously an audio event with no picture.
- **§8 The campers** — six designed silhouettes, a procedural human pipeline with a cost line, and
  an honest face-distance rule.
- **§11 Performance contract** — named target hardware, a per-pass millisecond ledger, a cut order,
  a pinned engine version, and the removal of three passes that cannot exist in WebGL2 as
  previously written.
- **§14 Load contract** — because "everything procedural" without a load budget ships as a
  ninety-second white screen, which is the single most likely way this project dies.

Owners referenced throughout map to `ARCHITECTURE.md` §9: **Render** (`Postprocessing.js`,
`Sky.js`, `VolumetricFog.js`), **Materials** (`Textures.js`, `Materials.js`), **World**
(`Terrain.js`, `Forest.js`, `Props.js`), **Build** (`CabinSite.js`, `Blueprint.js`), **Player**
(`Flashlight.js`, `Player.js`), **Campers** (`Campers.js`, `Humanoid.js`), **UI** (`HUD.js`,
`BlueprintUI.js`, `Menu.js`), **Director** (`Weather.js`, `NightManager.js`).

### How to read this document

| If you are about to… | Read first | And you may not ship without |
|---|---|---|
| Write a shader | §11 (budget), §12 (stack order) | A ms number measured on the M1 Air reference machine |
| Author a material | §6.1 (wetness), §6.2 (table), §4 (readability) | The material's class named explicitly, and its BRDF lobe cost |
| Place a light | §3.2, §3.6 (light assignment) | A row in the §3.3 ledger and a froxel injection decision |
| Draw a manual page | §13, §13.6 (recall spec) | Passing the 200 ms glance test, 4/5 |
| Add a narrative moment | §0.4 | The art device column filled in |
| Add a post pass | §11.2 | Naming which existing pass it displaces |

---

## 0. STORY CONTRACT

Everything in this document exists to render §0. If a visual choice does not serve a row in §0.4,
it is decoration and it is cut.

### 0.1 Premise (one paragraph)

Lake Wanaka Pines closed in 1971 after a drowning. Its handyman — a large, quiet man who slept in
the maintenance shed and knew every cabin by its number — was let go with the rest of the staff. In
the summer of 1984 the camp reopens under a new company. He comes back. Cabin Seven, the one he
built with the crew chief in 1968 and the one they tore down in '72, is missing from the row; there
is a gap in the line of cabins and a rectangle of old foundation stones where it stood. He has
seven nights before the buses arrive, and he has the camp's own 1971 maintenance manual — a
wordless, diagrammed, stapled A4 assembly leaflet that he cannot fully remember and must keep
opening. He gathers materials. He digs. He builds Cabin Seven back exactly to spec. He is not
building a lair. He is preparing a room for children who are expected.

### 0.2 Who he is

**He has no name in the game.** Internal name in code and comments: `THE CARETAKER` (`player.*`).
The word never appears on screen.

- **What he thinks a cabin is.** A promise kept. To him a cabin is not shelter and not a trap — it
  is *an expected occupancy*. Eight bunks means eight children were counted, listed, and are coming.
  A gap in a row of cabins is a broken count. He is fixing a count.
- **Why it must be seven nights.** The buses are booked for the 21st. This is written on a
  clipboard in the mess hall (Shot 6) and it is the only date in the game. He did not choose seven.
  Seven was chosen for him by a schedule, which is exactly the kind of authority he obeys.
- **Interiority, expressed only through hands and pace.** He never speaks. He never breathes hard
  except from load. He picks a dropped nail out of the mud rather than taking a new one. He wipes a
  bracket on his thigh before seating it. He sweeps. When a camper passes at 4 m he does not hide
  faster — he *stops*, because a man working does not run.
- **The antagonist.** Not the campers. **The manual.** It is the only thing in the game with
  authority over him, it is progressively wrong, and it is the thing that makes him make noise. The
  campers are weather.
- **Does he kill anyone before Night 7?** **No. There are zero kills in this game.** State it here
  so no one plans art for one. All fresh blood in the build is *his* (splinters, a nail through the
  left palm on Night 4, a barked knuckle) plus dried 1971 blood already on inherited tools and on
  the tarp. `blood.fresh` and `blood.hot` (§2.2) are legal only on the player's own hands, on the
  hammer's claw, and on the manual's page edge where he has held it. That constraint is what makes
  the one `manual` splatter (§13.5) land.
- **The thing he is wrong about.** Nothing, mechanically. The cabin will be correct. He is wrong
  only in that no one asked him, and no one is coming to inspect it, and there is no Cabin Seven on
  the 1984 roster.

### 0.3 Theme

**Care is the horror.** The game's engine of dread is not menace but *diligence*: a man who
measures twice, who reads the instructions, who cleans up after himself, and who has decided,
alone, that eight children belong in a building he is making with his hands. The comedy and the
horror are the same fact viewed at two distances. The manual is funny because it is bureaucratic;
he is terrifying because he obeys it.

### 0.4 The seven-night beat sheet

Exactly one **irreversible narrative event** per night. Each is authored, unmissable, and cannot be
undone by player action. The art device column is binding: that device may not appear before its
night, and must appear on its night.

| N | Build goal | Irreversible event | What it changes forever | **Art device that carries it** |
|---|---|---|---|---|
| **1** | Clear + excavate the plot; set 4 corner stones | He clears the duff and finds the **1968 foundation stones already there, dead level, in the exact footprint**. He does not react. He sets his own stones on top of them. | The site is now his; the game's central rectangle exists | The first orthogonal geometry in an organic world: four `mat.stone` blocks and a string line, and the excavation's cold-hole mist at `×2.2` density (§5.2). The string line is the first perfectly straight edge the player has seen |
| **2** | Sill plates + floor joists | **B-07 is missing.** He walks into camp and takes a box of joist hangers off the mess-hall porch, under the sodium lamp. First trespass. | He has entered camp. The sodium lamp now knows his hands | `sodium #ff8a2b` falls on his forearms — the first time human-warm light touches the player's own body (§2.1 payoff). His shadow crosses a lit tent wall for 0.4 s |
| **3** | Subfloor + wall studs, north and east | A camper (**DANA**, §8.3) sees the frame from the lake path at 60 m and **does not report it**. Her torch stops sweeping and *holds* for 6 s. Then she walks back to camp. | The cabin is known. Torch behaviour changes for the rest of the game | The studs go up and **the player builds their own god rays** (§5.4). The held torch cone is the first light in the game that stops moving |
| **4** | Rafters + ridge board; tarp over | Rain. His own roofless frame does not shelter him. He takes a **tarp off a tent with a sleeping counsellor inside**, and drives a nail through his own left palm getting it free. | He has been inside their camp while they slept; his hands now bleed for the rest of the game | Canvas translucency (§6.2): the tent glows like a paper lantern and *his silhouette crosses it from the inside*. Then `blood.fresh` on the manual's page edge, Night 4 onward, never mentioned |
| **5** | Ridge beam, set alone | Whiteout. Carrying the beam across the lake path he passes a camper at **4 m**. She takes him for staff, says one word, and walks on. He does not answer. | He has been seen, in the open, and accepted | The only human face in the game closer than 8 m (§8.6), and it is 60% dissolved in `fog.far`. Visibility 24 m makes the beam's far end vanish into white |
| **6** | Sheathing + roof tin | Storm. **DANA gets inside the frame.** He stands motionless in the corner holding a joist for 90 s while lightning cuts the scene. He does not touch her. She leaves. | The player learns he *chooses not to*. This is the game's hinge | Lightning is the only edit (§5.4, §16 Shot 11): four legibility flashes, each 60 ms, each showing her one step closer, then 1.4 s darker than before |
| **7** | Door, window, floor swept, lantern hung | He finishes, sweeps the floor, and at dawn draws tomorrow's page. **The diagram is of eight children in four bunks, with a ✓.** | The reveal | The `dawn` LUT (§12.4), mist dropped to knee height, and the game's **last warm light is inside the cabin and he did not light it for himself** — the payoff of The One Rule (§2.1). Then, faint on the road: a yellow school bus |

### 0.5 The reveal, stated plainly

The manual is not from IKEA and it is not a gag prop. **He drew it.** Every dawn, off-screen, he
draws the next night's page from the camp's 1971 maintenance leaflet plus what he did yesterday.
This is why:

- the memory mechanic is diegetic — he cannot hold a plan in his head either;
- the manual gets things progressively *wrong* (§13.5) — he is drawing from a degrading memory;
- on Night 6 a panel depicts something the **player** did on Night 5, drawn slightly wrong;
- the mascot BJÖRN is not a mascot. He is a self-portrait, and he has a hockey mask because that is
  the only way this man knows how to draw a face — as a shape with holes in it;
- the final page has eight small figures in it.

Nobody says any of this. It is carried entirely by §13.5's escalation table and by one page.

### 0.6 The ending

Dawn, Night 7 complete. The cabin is small, tidy, square, correct: tin roof beading water, closed
door, one window, a swept floor, a hung lantern. It is genuinely beautiful and the player is
genuinely proud, and that pride is the trap. Camera does not move. He sets the manual on the step,
squares it to the edge with two fingers, and stands up. On the road: a yellow school bus, 400 m
out, headlights on in daylight. Cut to black on the sound of a diesel downshift. **No kill, no
title card, no wink.** The horror is entirely in what the player has just spent seven hours
lovingly preparing.

### 0.7 What this contract forbids

- No narrator, ever. ElevenLabs voice lines are **atmosphere only**: distant camper chatter in 3D
  space, laughter, one word at 4 m on Night 5. Never the player. Never explanation.
- No collectible lore notes, no diary pages, no found audio logs.
- No on-screen kill, no chase-fail-state gore, no jump scare with a sting. Detection failure is
  §9.5, and it is quiet.
- No moment in which the game tells the player that the slasher is a slasher. The word never
  appears. The player brought that expectation; the game's job is to let them hold it for seven
  hours and then hand them a bunkhouse.

---

## 1. THE THESIS

**The world is a wet, blue-black photograph taken at f/1.4 in near-darkness, and the only thing in
it with clean edges, flat light, and a printed grid is the instruction manual.** That single
opposition is the entire game rendered in light. Everything outside the manual is *volumetric*:
soaked pine, ground mist that pools in the ruts, a moon that is a key light and not a lamp, air you
can see. Everything inside the manual is *flat*: black line art at four fixed stroke widths on bone
paper, one red accent, no gradients, no shadows, no atmosphere at all. When the player raises the
diagram (`ui:blueprint-open`), the frame goes from an EV of roughly −3 to a hard bright card at EV
+2 — their eyes physically adjust, the forest behind it dies to black, and the joke lands as a
*photometric* event rather than a written one.

We never wink. The slasher never jokes. **The manual is the comedian, and the manual is a light
source.**

Two laws follow, and revision 2 enforces both where revision 1 broke them:

1. **The manual is the only photometric event in the game.** No other game-state change may express
   itself through the lens. Revision 1 violated this with a five-effect "DETECTED!" stinger; §9.5
   deletes it.
2. **The comedy comes from FORM, never from the game signalling "this is an IKEA parody."** Revision
   1 violated this with fake-Swedish product names on the cover; §13.7 deletes them. A Swedish word
   is a *reference to another object*. Our manual must read as **a real object from this world**.

Reference points, and precisely what we steal from each:

| Reference | What we take | What we explicitly reject |
|---|---|---|
| *It Follows* (Mike Gioulakis) | Sodium-vapor amber as the **only** human-warm source against a cold ambient; wide lenses that leave the frame's edges dangerously empty | Its daylight suburbia; its steady dolly |
| *The Witch* (Jarin Blaschke) | The wet black forest: near-zero fill, foliage that reads as silhouette mass rather than individual leaves, natural-source-only lighting discipline | Its 1.66 framing and candle-only interiors |
| *The Revenant* (Lubezki) | Breath, damp, low sun/moon angle grazing across a textured world; the camera as a body that has weight | Its constant motion — our camera is patient |
| *Sicario* night-vision sequence | The discipline that darkness is *information-poor on purpose* — **for the atmosphere. Never for the puzzle.** See §4 | Green NV tint. We never go green-screen |
| *Alien* (Cronenweth) | Practical lights inside the frame doing all the work; hard falloff; smoke as a lens | Its industrial teal-orange saturation |
| Camp maintenance leaflet, offset-printed 1971 | Flat line art, wordlessness, absurd calm, the mascot who is never in danger, the smell of a photocopy of a photocopy | Any modern flat-design gradient/rounded-corner language; any Swedish |
| *The Shining* (Alcott) | Symmetry and bureaucratic tidiness as menace; a monster who is *organized* | Its warm hotel gold |
| *Call of Duty: Modern Warfare* (2019), night maps | 60 fps under load as a **visual** property; material frequency density; the discipline of hero-quality first-person hands | Its readability-first exposure, its rim-light-everything character pass. See §17 for the honest gap list |

If a screenshot could be mistaken for *Friday the 13th: The Game* we have failed by being generic.
If it could be mistaken for a still from *The Witch* with a flat-pack diagram taped in the corner,
we have won. **And if it holds up in a 30-second motion A/B against a CoD night map (§17), we have
actually won**, because every remaining gap between us and that bar is a motion gap, not a still
gap.

---

## 2. PALETTE

Authoring rule: all hex values below are **sRGB display values**. Any value fed to a Three.js color
must go through `new THREE.Color().setHex(0x…)` with `THREE.ColorManagement.enabled = true`
(default in the pinned version, §11.1), i.e. Three converts to linear for you. **Never** hand-write
a linear value. "Stop" is the exposure stop relative to 18% mid-grey — use it to sanity-check that
your material is landing where the bible says it should.

### 2.1 The One Rule

> **The world is blue-green. The only warm light in the world is human.**

Nothing in nature in this game is warm. Not the moon, not the moss, not the rot, not the water, not
the mud, not the blood in shadow. Warmth means a person: a campfire, a sodium lamp on the mess-hall
porch, a kid's flashlight, the player's own lantern. Consequence: **the player's amber lantern makes
the player a person**, and that is the quietest horror joke in the build — the monster is carrying
the only friendly-coloured light in the forest because he needs to read.

Corollary for every agent: if you are about to author a warm-hued material or light and it is not
motivated by human fire/filament, **you are wrong**. Rust is the single legal exception and it is
desaturated to within an inch of its life.

**The rule's payoff is scheduled.** Track it:

| Night | Warm light touching the player's own body | Meaning |
|---|---|---|
| 1 | Only his lantern, from below | He is a person to himself |
| 2 | `sodium` across his forearms in camp | Camp's light has touched him |
| 3–4 | A tent's transmitted glow on his back | He is inside their warmth |
| 5 | A camper's `camper.torch` passes across him at 4 m and moves on | He was seen and accepted |
| 6 | Lightning (`#c9d6ee`, cold) — **no warm light at all** | The one night nothing human accepts him |
| 7 | He hangs a lit lantern **inside the cabin** and steps out into the cold | The warmth is now the building's, not his. The cabin has become the person. **This is the last frame's whole meaning** |

### 2.2 Master swatch table

| Token | Hex | Rel. luminance | Stops from mid | Where it appears | Owner |
|---|---|---|---|---|---|
| `shadow.abyss` | `#060b0e` | 0.0031 | −5.86 | Under canopy, inside cabin frame, tree cores. The true black of the game — we clip *below* this, never at 0 | Postprocessing |
| `shadow.base` | `#0a1216` | 0.0056 | −5.02 | Scene clear colour, unlit ground, `scene.background` at night depth | Sky |
| `shadow.lift` | `#101c22` | 0.0106 | −4.09 | Ambient-only surfaces facing away from moon; the post-grade lift target | Postprocessing |
| `mid.forest` | `#16241f` | 0.0153 | −3.56 | Mid-distance canopy mass, the dominant screen colour by area | Forest |
| `mid.slate` | `#243740` | 0.0348 | −2.37 | Wet granite, moonlit mud, the "readable dark" | Materials |
| `mid.stone` | `#3b464b` | 0.0582 | −1.63 | Directly moonlit rock face, brightest natural diffuse. Also the 1968 foundation stones (§0.4 N1) | Materials |
| `moon.key` | `#7d95c4` | 0.2984 | +0.73 | `DirectionalLight` colour — matches `ARCHITECTURE.md` §11 | Sky |
| `moon.rim` | `#aebcdc` | 0.5013 | +1.48 | Wet-edge rim/sheen on silhouettes, foliage backscatter, **and the gap-catching highlight in §7.3** | Materials |
| `moon.spec` | `#d6e0f2` | 0.7402 | +2.04 | Specular highlights on water, wet steel, eyes | Materials |
| `fog.near` | `#2a3a44` | 0.0394 | −2.19 | Froxel scatter colour ≤ 12 m | VolumetricFog |
| `fog.far` | `#54697a` | 0.1339 | −0.43 | Aerial perspective past 45 m; the distance "wall" | VolumetricFog |
| `fog.lit` | `#8fa6bb` | 0.3670 | +1.03 | Fog inside the moon's shaft / god-ray core | VolumetricFog |
| `foliage.wet` | `#131f1a` | 0.0119 | −3.92 | Pine needles, fern, salal — the default state, Nights 1–7 | Forest |
| `foliage.dry` | `#3b4430` | 0.0528 | −1.77 | Only under the canopy shelter and inside the tent flaps | Forest |
| `foliage.dead` | `#4a4433` | 0.0583 | −1.63 | Needle litter, bracken, the duff layer | Terrain |
| `bark.wet` | `#15120f` | 0.0063 | −4.84 | Douglas fir / hemlock trunks, rain-soaked side | Forest |
| `bark.dry` | `#38312a` | 0.0320 | −2.49 | Lee side of trunks, under-canopy trunks | Forest |
| `bark.birch` | `#b9b6a6` | 0.4652 | +1.37 | **Sparingly.** 6% of trees. The only bright natural vertical — compositional punctuation | Forest |
| `water.body` | `#0b171c` | 0.0077 | −4.55 | The lake, puddles, wheel ruts | Terrain |
| `water.spec` | `#9fb6cc` | 0.4519 | +1.33 | Ripple highlight, the lake's moon path | Materials |
| `fire.core` | `#ffca7a` | 0.6491 | +1.85 | Campfire centre, blown-out through bloom | Props |
| `fire.mid` | `#ff9d4a` | 0.4587 | +1.35 | Campfire light colour — matches `ARCHITECTURE.md` §11 | Props |
| `fire.ember` | `#c9421a` | 0.1639 | −0.14 | Dying coals, sparks past 0.6 s of life | ProceduralSFX/Props |
| `lantern` | `#ffb865` | 0.5648 | +1.65 | Player `SpotLight` colour — matches `ARCHITECTURE.md` §11 | Flashlight |
| `sodium` | `#ff8a2b` | 0.3961 | +1.14 | Mess-hall porch lamp, the only fixed light at camp | Props |
| `camper.torch` | `#ffe6bb` | 0.8144 | +2.18 | Camper flashlight cones (2900 K filament, whiter than ours on purpose) | Campers |
| `garment.warm` | `#c4643a` | 0.1904 | +0.04 | **One per camper.** See §8.4 — the palette's payoff on a moving human silhouette | Campers |
| `blood.fresh` | `#7a1013` | 0.0456 | −1.98 | Wet blood diffuse. **His only** (§0.2) | Materials |
| `blood.hot` | `#a8161a` | 0.0897 | −1.00 | Blood catching a warm light directly — the only saturated red in 3D | Materials |
| `blood.dry` | `#3a1113` | 0.0135 | −3.74 | 1971 blood on inherited tools, the axe head, the tarp | Materials |
| `manual.red` | `#d92b2b` | 0.1665 | −0.11 | **UI only.** Arrows, the ✗ mark, the mascot's hammer stripe | BlueprintUI |
| `paper` | `#f2efe6` | 0.8632 | +2.26 | Manual stock. Slightly warm bone — never pure white, never cream | BlueprintUI |
| `ink` | `#14181a` | 0.0088 | −4.36 | Manual line art. Off-black so it doesn't vibrate against paper | BlueprintUI |
| `ui.white` | `#ffffff` | 1.0000 | +2.47 | Reticle dot, subtitle text, nothing else | HUD |

### 2.3 Sub-palettes by material family (albedo authoring targets)

| Token | Hex | Notes |
|---|---|---|
| `mat.skin.wet` | `#6b5148` | Camper faces. Desaturated, never pink. See §8.5 for the three-tone variant set |
| `mat.canvas` | `#5c5b46` | Army-surplus tent duck |
| `mat.steel.galv` | `#9aa0a3` | Bracket, hinge, nail head, spirit level. **Tuned as a beacon, §4.3** |
| `mat.tin` | `#7d8487` | Corrugated roofing panels |
| `mat.rust` | `#7a4526` | The **only** legal warm non-human hue, and only ≤ 8% coverage |
| `mat.lumber` | `#a8875c` | Freshly sawn face. Brightest large surface in the game — this is what makes the cabin *pop* as an object |
| `mat.mud` | `#2a221b` | Track mud, the plot excavation |
| `mat.chalk` | `#cfd3cc` | Carpenter's chalk line, pencil arcs, the string line. **The second-brightest small mark in the world**, and a readability tool (§4.5) |

### 2.4 Forbidden colours

Purple. Cyan above 60% saturation. Any green with hue in `[100°, 150°]` and saturation > 0.35
(reads as video-game grass). Teal-orange complementary grading (we do blue-vs-amber, which is a
*narrower*, more specific relationship — the amber only ever appears as **point sources and their
falloff**, never as a global grade lift). Pure `#000000` anywhere in the 3D scene. Any Latin
character rendered in the 3D world except the stencilled crate codes of §13.7.

---

## 3. LIGHTING MODEL

Physical units per `ARCHITECTURE.md` §10. Renderer configuration is pinned and lives in exactly one
file — see §11.1. AgX tone mapping; `toneMappingExposure` driven exclusively by `Postprocessing.js`.
**No other module may write `toneMappingExposure`.**

### 3.1 Exposure target — "how dark is dark"

We expose for the **wet mud in the moon**, not for the sky and not for the fire.

| Quantity | Value |
|---|---|
| Target scene key | Moonlit-mud diffuse sits at **0.045 relative luminance** post-tonemap (≈ −2 stops from mid-grey) |
| `toneMappingExposure` base | **0.62** |
| Effective EV (100 ISO equivalent) | **EV −3.2** — half a stop above legally-shootable moonlight, i.e. cinema night, not documentary night |
| Blackest 1% of pixels | must land in `[0.002, 0.006]` linear. **Not zero.** A histogram spike at 0 is a bug (§12.4 guarantees this) |
| Brightest 0.1% (fire core, lantern hotspot, lightning) | allowed to clip AgX at 1.0. This is the *only* legal clipping |

### 3.1.1 The luminance assert is per weather state (revision 2 fix)

Revision 1 asserted a single global average-luminance window of `0.018–0.028` and then specified a
money shot (Shot 7, whiteout) that measures ≈ 0.107 — four times the ceiling. The assert was wrong,
not the shot: **a foggy night is a brighter, flatter night, and that is physically true.** Fog
integrates scattered moonlight along the whole view ray; the average frame luminance of a real
whiteout is an order above a clear night. The single-window assert would have flagged the scariest
night in the game as a defect every frame.

`Postprocessing.js` computes average and percentile luminance from the 1/64-res bloom prefilter mip
(free — we already have it) and asserts against the row for `Weather.state`:

| Weather state | Avg frame luma | P99 luma | Screen area > 0.5 luma | Nights |
|---|---|---|---|---|
| `clear` | 0.018 – 0.028 | ≤ 0.42 | < 2.0% | 1, 7 |
| `drizzle` | 0.015 – 0.026 | ≤ 0.38 | < 1.6% | 2 |
| `windy-mist` | 0.021 – 0.034 | ≤ 0.44 | < 2.4% | 3 |
| `rain` | 0.014 – 0.025 | ≤ 0.40 | < 1.8% | 4 |
| `whiteout` | **0.070 – 0.130** | ≤ 0.52 | < 6.0% | 5 |
| `storm` (between flashes) | 0.012 – 0.023 | ≤ 0.36 | < 1.4% | 6 |
| `storm` (flash + 1.6 s recovery) | **assert suspended** | — | — | 6 |
| `dawn` (`timeOfNight` > 0.88) | 0.050 – 0.095 | ≤ 0.70 | < 9.0% | 7 |
| `blueprint-open` (any night) | **assert measured on the 3D layer only**, target 0.006 – 0.012 | ≤ 0.20 | < 0.4% | all |

**What the assert gates.** In dev builds: a console warning plus a red border on the debug HUD, on
the frame. In CI: the twelve Shot regression captures (§16) are measured over a 90-frame window and
the *median* must sit inside the window; a single frame outside is not a failure, a median outside
is a hard fail that blocks merge. The `blueprint-open` row measures the WebGL canvas *before* the
DOM manual composites over it, because the manual is not part of the 3D image (§13).

### 3.1.2 Scripted exposure ramps

Exposure is **not** auto-adaptive. We ship a scripted curve driven by `night:begin` /
`state.timeOfNight` plus these event ramps — and note what revision 2 removed:

| Trigger | Target exposure | Attack | Release |
|---|---|---|---|
| default | 0.62 | — | — |
| `ui:blueprint-open` | 0.44 | 0.18 s | — |
| `ui:blueprint-close` | 0.62 | — | 0.55 s (slow, so the world "comes back" as night vision returns) |
| `weather:change` to `whiteout` | 0.70 | 4.0 s | 4.0 s |
| Lightning (`uLightning` > 0) | 0.62 → 0.30 over 0.06 s, back over 1.4 s | 0.06 s | 1.4 s |
| `state.timeOfNight` 0.85 → 1.0 (dawn) | 0.62 → 0.95 | linear | — |
| ~~`player:spotted`~~ | **DELETED.** See §9.5 | — | — |

### 3.2 The three-light discipline

**Any given pixel is lit by at most three things: the moon, the ambient/probe term, and at most one
local light.** This is a hard rule and the primary reason the frame will read as photographed rather
than rendered. §3.6 gives the enforcement mechanism, because a rule with no mechanism is a wish.

**Named exemptions — there are exactly two, and they are both near-field:**

1. **The player's own hands, forearms, lantern arm, and held part** (render layer `LAYER_HANDS`)
   may receive up to **four**: moon + ambient + lantern core + one of {lantern spill, page bounce}.
   These pixels never exceed 6% of the frame and never contain a gameplay read.
2. **The froxel volume** is not a surface and is not bound by this rule; its light cap is separate
   and lives in §5.3 (moon + lantern + nearest 2 locals).

Any third exemption requires deleting one of these.

**1 — MOON KEY (`Sky.js`, `DirectionalLight` + `CSM.js`)**

| Parameter | Value |
|---|---|
| Colour | `#7d95c4` (`moon.key`) — 4100 K with a magenta-minus bias, i.e. *photographic* moonlight, not blue-gel moonlight |
| Intensity | **0.06** at Night 1 → **0.09** by Night 7 (waxing gibbous → full). This is a lighting curve **bound to §0.4**: the moon rises with the cabin, so Night 7's "everything is legible and that is worse" is earned, not asserted |
| Azimuth | **118°** (from −Z, clockwise looking down). Behind-right of the camp, so the camp reads as a silhouette from the player's default approach |
| Elevation | **26°** at night start, **19°** at `timeOfNight = 1.0`. Low. Low means long shadows and grazing specular, which is where all the perceived detail lives |
| Shadow map | `settings.tier(1024, 1024, 2048, 2048)` **per cascade**; `PCFSoftShadowMap` at `low`/`medium`, custom PCSS at `high`/`ultra` (§3.4) |
| Cascades | 1 at `low`/`medium`; **3** at `high`/`ultra`, practical split λ = 0.72 landing at 14 m / 46 m / 130 m |
| Shadow bias | `-0.0006`, `normalBias 0.035` (tuned for 1 m-scale bark relief; peter-panning here is worse than acne) |
| Casters | Trees within 40 m (instanced), the cabin frame and every placed part, **every loose part on the ground with no distance cull**, campers, props > 0.5 m |
| Fakers | Undergrowth, needle litter, small debris — baked AO in vertex colour plus a contact-shadow blob, never a real shadow |

**2 — SKY AMBIENT BOUNCE (`Sky.js`, `HemisphereLight` + one `LightProbe`)**

| Parameter | Value |
|---|---|
| Sky colour | `#1d2b3a` |
| Ground colour | `#0c1210` (the forest floor eats light; ground bounce is nearly nothing) |
| Intensity | **0.10** clear / **0.16** drizzle / **0.22** whiteout / **0.13** storm |
| Directionality | Deliberately over-weighted to the +Y hemisphere by 1.8×. Downward-facing surfaces must go genuinely black |
| Probe | One `LightProbe`, SH9, baked from a 32×32×6 cube render of `Sky.js` only (no geometry), on `night:begin` and on `weather:change`. GPU-side, 6 draws of a fullscreen sky shader + a compute-free SH projection in a fragment shader writing to a 3×3 texel target. **≤ 1.1 ms, off the main thread's critical path** (§14) |

**3 — ONE MOTIVATED LOCAL SOURCE (per view, per moment)**

In any composed shot, exactly **one** local source is dominant. Others are present but ≥ 2.5 stops
down or occluded. **All local lights are `SpotLight`s.** Revision 1 specified campfires as
`PointLight`s and simultaneously gave them shadows; a shadow-casting point light in Three is a cube
map — six render passes each — which put revision 1 at 22 shadow passes per frame against an
undefined draw-call cap. Fires are now downward-and-outward-aimed spots with a wide cone, which
costs one map, looks identical for a fire in a pit (a real campfire *is* bottom-occluded), and
frees 15 render passes.

| Source | Type | Intensity | Distance | Colour | Shadow | Owner |
|---|---|---|---|---|---|---|
| Player lantern (core) | `SpotLight`, `decay 2`, `angle 0.42`, `penumbra 0.55` | **40** | 14 m | `#ffb865` | ✅ 1 map | Flashlight |
| Player lantern (spill) | `SpotLight`, `angle 0.95`, `penumbra 1.0` | **2.4** (6%) | 9 m | `#ffb865` | ❌ | Flashlight |
| Campfire (main) | `SpotLight`, `angle 1.35`, `penumbra 1.0`, aimed +Y −18° | **26** base + 1/f noise ±18% at 6.5 Hz | 12 m | `#ff9d4a` | ✅ if nearest-2 | Props |
| Campfire (secondary ×2) | `SpotLight`, `angle 1.35` | **11** | 7 m | `#ff9d4a` | ❌ | Props |
| Mess-hall sodium lamp | `SpotLight`, `angle 1.1`, `penumbra 0.9` | **28** | 16 m | `#ff8a2b` | ✅ if nearest-2 | Props |
| Camper flashlight ×6 | `SpotLight`, `angle 0.30`, `penumbra 0.30` | **34** | 18 m | `#ffe6bb` | ❌ **never** | Campers |
| Cabin lantern (Night 7 only) | `SpotLight`, `angle 1.5`, `penumbra 1.0` | **18** | 8 m | `#ffb865` | ✅ | CabinSite |
| Lightning | `DirectionalLight`, no shadow, 3-flash envelope | **peak 4.5** | ∞ | `#c9d6ee` | ❌ | Weather |
| Manual page bounce | `SpotLight`, `angle 1.2`, `penumbra 1.0`, no shadow, `LAYER_HANDS` + world | **3.0** | 2.2 m | `#f2efe6` | ❌ | Flashlight (§13.8) |

Camper flashlights **never** cast shadows — they cast a *volumetric cone* only. Deliberate: it saves
six shadow maps and, more importantly, the cone is the gameplay-readable thing. If a camper's beam
threw a shadow, the player would read the shadow instead of the beam.

**Player lantern rules (hard):**
- Held **low and left**, at `(-0.34, -0.22, -0.45)` in camera space, angled 8° down and 4° left. It
  is a *carried object*, not a headlamp. Everything it lights has a bottom-up shadow direction,
  which is the single most horror-coded lighting fact in the frame.
- Hot inner core at 0.42 rad plus the shadowless spill to 0.95 rad at 6%. Real lanterns leak.
- **Flickers** on 1/f noise at 0.9 Hz, ±7%, plus a hard 40 ms dropout at 0.4%/s probability. Not a
  strobe. A pressure lamp fighting damp.
- Hooding it (crouch, hand-over, or automatically on `stealth:torch-incoming`, §9.5) drops it to
  **0.10 intensity over 0.12 s**. A gameplay verb that is also a compositional one, and after §9.5
  it is *the* detection tell.

### 3.3 Shadow pass ledger (revision 2: the numbers now add up)

Every shadow render pass is a separate camera render with its own draw calls. Budgeted explicitly,
separately from the main pass, and counted in §11.2.

| Tier | Moon cascades | Lantern | Locals (nearest-2 rule) | Cabin lantern (N7) | **Total passes** | Shadow draw calls (cap) |
|---|---|---|---|---|---|---|
| `low` | 1 | 1 | 0 | 0 (uses lantern slot) | **2** | 40 |
| `medium` | 1 | 1 | 1 | 1 | **3–4** | 70 |
| `high` | 3 | 1 | 2 | 1 | **6–7** | 120 |
| `ultra` | 3 | 1 | 2 | 1 | **6–7** | 150 |

Rules that keep this honest:
- **Nearest-2**: of all shadow-*capable* locals (fires, sodium, cabin lantern), only the two nearest
  the camera get a map, chosen with 4 m hysteresis and a 0.35 s cross-fade of `shadowIntensity` so
  a swap is invisible. Third-and-beyond fires still light, they just don't occlude.
- **Cascade update cadence**: cascade 0 every frame, cascade 1 every 2nd frame, cascade 2 every 4th
  frame (staggered, never on the same frame). Static-geometry-only cascades 1–2 are cached and
  re-rendered only when `Forest` streams a chunk or `CabinSite` seats a part.
- **Local light maps** update at 30 Hz (every other frame), alternating.
- **What "draw calls" means** in this document, definitively: `renderer.info.render.calls`
  attributable to the **main camera colour pass (opaque + alpha)**. That is the number the §18
  debug HUD (§11.5) turns `#d92b2b` above **220**. Shadow passes, the froxel passes, and the post chain are
  budgeted separately in the rows above and in §11.2, and are *excluded* from 220. Revision 1 never
  said which, which made the number unenforceable.

### 3.4 Penumbra: PCSS at `high`+, honest fixed blur below (revision 2 fix)

Revision 1 said "angular diameter 0.6° → `light.shadow.radius` tuned so the penumbra at 10 m
occluder distance is ~11 cm." That cannot work: `shadow.radius` is a **constant texel-space blur**,
identical at 0.5 m and 50 m occluder distance, so nothing contact-hardens — which is the entire
physical point of quoting an angular diameter — and it is ignored under `PCFSoftShadowMap` anyway.
Two honest paths, one per tier band:

| Tier | Technique | Spec | Cost |
|---|---|---|---|
| `low`, `medium` | 5-tap rotated Poisson PCF, **fixed blur** | Blur radius **1.6 texels**, constant. We do not claim contact hardening. Do not quote an angular diameter in code comments here | 0.25 ms |
| `high`, `ultra` | **PCSS** | Blocker search: **8 taps**, Vogel disk, search radius = `lightSizeUV * (z - near) / z` with `lightSizeUV = 0.0105` (0.6° at the cascade-0 projection). Penumbra estimate `w = (z - zBlocker)/zBlocker * lightSizeUV`, clamped `[1.0, 9.0]` texels. Filter: **16-tap** Vogel PCF at radius `w`, rotated by the §12.7 blue-noise value, TAA-resolved | 0.75 ms (cascade 0 only; cascades 1–2 use the fixed-blur path — nothing at 46 m needs a contact-hardening penumbra) |

Result at the spec'd geometry: a bracket 4 cm off the mud has a ~3 mm penumbra; the ridge beam 3 m
up has a ~7 cm penumbra; a fir crown 22 m up has a ~34 cm penumbra. That progression is the whole
reason to do this, and it is what sells the **seating** moment in §7.4.

### 3.5 What casts, what fakes — the full ledger

| Object class | Real shadow | Contact shadow | AO source |
|---|---|---|---|
| Trees (< 40 m) | ✅ moon only | ✅ SSCS | vertex AO at trunk base |
| Trees (> 40 m) | ❌ | ❌ | baked vertex AO |
| Undergrowth / fern | ❌ | ❌ | vertex AO gradient, dark at root |
| Cabin frame + placed parts | ✅ moon + lantern + nearest local | ✅ SSCS | GTAO |
| **Loose parts on ground (interactables)** | ✅ moon + lantern, **no distance cull** | ✅ SSCS **mandatory** | GTAO |
| Campers | ✅ moon + nearest local | ✅ SSCS | GTAO |
| Rocks / stumps | ✅ moon | ✅ SSCS | vertex AO |
| Tents | ✅ moon + nearest local | ✅ | vertex AO |
| Rain / particles | ❌ | ❌ | — |
| Ground mist | ❌ | ❌ | froxel self-shadow (one 2-tap) |

**Screen-space contact shadows (SSCS)** are non-negotiable at `high`/`ultra`: 8 ray steps, 0.35 m
max trace, 0.02 m thickness, per-pixel on moon and lantern. Without them every dropped bracket
floats and the game reads as a student demo. At `low`/`medium`, a projected 0.18 m radial darkening
decal under every loose part.

### 3.6 Light assignment — the enforcement mechanism (revision 2 fix)

Three.js forward rendering compiles every material against every light in the scene. Revision 1
asserted "at most three lights per pixel" with no mechanism; at the campfire the real count would
have been ten. Mechanism:

- `Materials.js` compiles **one** program family with `MAX_SPOT_LIGHTS 2` (core + one), `MAX_DIR_LIGHTS 2`
  (moon + lightning), `MAX_HEMI 1`, `MAX_POINT 0`, `MAX_PROBE 1`. There are no `PointLight`s in the
  build; `Props.js` asserts this at startup.
- Every frame, `Materials.assignLights(renderList)` scores each shadow-capable/local light per mesh
  by `intensity / (1 + d²)` against the mesh's bounding-sphere centre, takes the top **1** (top 2 for
  `LAYER_HANDS`), and writes it into that mesh's light slot via a per-object uniform block. Meshes
  are bucketed by assigned light so the sort is `O(n log n)` on ~900 renderables: **0.28 ms CPU**.
- **Hysteresis**: a light must win by 25% for 0.4 s to displace the incumbent, and the swap
  cross-fades both lights' contribution over 0.30 s. Cost: two light slots evaluated during the
  fade window only (a `#define FADING` permutation).
- **Shader permutation budget: 12 programs total**, enumerated: `{opaque, alpha, instanced} ×
  {static, wind} × {fading, not}`. If a change would create a 13th, it needs a line in this
  document. Compile all 12 at load behind the menu (§14), never mid-night.
- **The visible artifact of a light popping** is a mesh's warm falloff jumping. It is hidden by (a)
  the 0.30 s cross-fade, (b) the fact that swaps only ever happen between two fires ≥ 7 m apart
  where the second is already ≥ 2.5 stops down, and (c) never swapping while `ui:blueprint-open` is
  false and the mesh is within 3 m of the camera — near meshes hold their light until the player
  looks away.

---

## 4. THE READABILITY CONTRACT

**This is a puzzle game.** The player's core physical action is finding a specific small object in
a dark wet forest and bringing it to a specific place. Revision 1 specified a world in which that
is impossible: information-poor darkness by design, < 2% of screen above 0.5 luminance, and a
`metalness 1.0`, `roughness 0.34` bracket under a `0.06`-intensity moon — which is, correctly
rendered, **black**. This section is the fix, and it outranks §3 where they conflict.

> **The First Law of the Search.** A required part must be findable, by a player who knows roughly
> where to look, in **≤ 40 seconds** at the 50th percentile and **≤ 75 seconds** at the 90th. The
> game is a comedy. An audience has to *reach the punchline*. A player who spends four minutes
> sweeping mud for a bracket has stopped finding it funny and has started finding it broken.

### 4.1 The three-cue funnel

Every interactable presents a *different* cue at each of three distance bands. The player learns
this grammar on Night 1 and it never changes.

| Band | Distance | Primary cue | Spec |
|---|---|---|---|
| **Locate** | 12 – 40 m | **Silhouette against a lighter ground** | Minimum on-screen silhouette **9 px** on the shortest axis at 40 m, 1080p, 72° FOV. That implies a minimum world footprint of **0.19 m**; parts smaller than that ship inside a container that meets it (§4.4) |
| **Acquire** | 2.5 – 12 m | **Anisotropic glint** | A moving specular highlight that survives at moon intensity — §4.3. Sweeps as the player's head moves; the *motion* is the signal, not the brightness |
| **Confirm** | 0 – 2.5 m | **Contact shadow + local contrast** | SSCS seam (§3.5) plus the ≥ 3:1 rule below. At this range the object must read as a *seated* solid, not a decal |

### 4.2 The 3:1 local contrast rule

> **Every interactable, at every point in the Acquire and Confirm bands, presents ≥ 3:1 luminance
> contrast against the median luminance of its 2 m spherical neighbourhood, in at least one
> contiguous region ≥ 20% of its screen area.**

Achieved by, in priority order:

1. **Value, not hue.** Interactable albedos live in a reserved band: `mat.steel.galv` `#9aa0a3`
   (0.3417 rel. luma) and `mat.lumber` `#a8875c` (0.2786) against a ground median of
   `mat.mud` under moon ≈ 0.045. That is 7.6:1 and 6.2:1 *before* any lighting trick. The rule is
   already satisfied on flat lit ground; it fails in shadow, which is what the next two items fix.
2. **The interactable rim term** (`Materials.INTERACTABLE_RIM`, a named shader chunk). A wrapped
   Fresnel using the **ambient probe's dominant direction**, not the camera: `rim = pow(1 - saturate(dot(N, V)), 3.2) * 0.34 * moonRim`, tinted `moon.rim` `#aebcdc`. It is on **only** for meshes on
   `LAYER_INTERACTABLE`, it costs one dot and one pow (0.04 ms full-screen worst case), and it is
   physically defensible: these are wet, slightly-convex objects in an open-sky forest, and a wet
   edge really does pick up sky. **It is not an outline shader, it is not a highlight colour, and it
   never exceeds `moon.rim` — it cannot make an object brighter than moonlight on wet steel.**
3. **The debt term.** If (1) and (2) still fail the 3:1 test — measured, not guessed — `CabinSite`
   is not allowed to place the part there. See §4.4.

**Instrumentation.** `Debug.readability()` renders the scene to a 1/4-res target, and for every
`LAYER_INTERACTABLE` mesh computes its screen-space luma histogram against a 2 m-radius
neighbourhood sample. It overlays a green box (pass), amber (2:1–3:1), red (< 2:1). CI runs it at
64 camera positions per night seed; **any red is a hard fail.**

### 4.3 Galvanized spangle, tuned as a beacon (revision 2 fix)

Real hot-dip galvanizing has a crystalline **spangle**: zinc grains 3–15 mm across, each a facet at
a slightly different angle. Revision 1 correctly identified this as the most convincing metal detail
nobody does — and then specified it as a *flex*. It is the game's single most important readability
device and it is tuned as one.

| Parameter | Value | Why |
|---|---|---|
| Cell map | Voronoi, **7.5 mm** mean cell, 0.35 jitter, generated in `Textures.js` | Matches real spangle scale; at 12 m a cell is ~1.4 px, which is exactly the size that *twinkles* |
| Per-cell normal tilt | **±11°** (revision 1 said ±8°; raised, measured) | Each cell needs to catch the moon at a *different* head angle so that head motion produces a travelling glint |
| Per-cell roughness | base **0.22**, variance **±0.14** | 0.22 is low enough that a 0.06-intensity moon still returns a visible lobe; 0.34 (revision 1) did not |
| Metalness | **0.88**, not 1.0 | Pure metal has zero diffuse. At 0.88 we retain a small tinted diffuse floor (`#9aa0a3 × 0.12`) which is what keeps the bracket from vanishing when *no* specular lobe is aligned. This is a deliberate, stated physical lie, and it is the difference between a findable game and an unfindable one |
| Anisotropy | Roughness anisotropy 0.45 along the **rolling direction** of the steel, per-part constant | Produces a *streak* rather than a point — a streak survives at 1 px where a point aliases away |
| Glint response | The specular lobe must return **≥ 0.14 relative luminance** for at least one cell whenever the moon's half-vector is within 34° of the part's up-axis | This is the acceptance test. `Debug.glint()` sweeps the view hemisphere and reports the fraction of directions that pass; **≥ 62% required** |
| Wetness interaction | Wet spangle: roughness → 0.09, glint luminance → 0.31 | Rain makes parts *easier* to find. Deliberate, and it's why Night 4 is a high-part-count night (§15) |

The same treatment, weaker, applies to nail heads (3 mm spangle), hinges, and the spirit level's
vial.

### 4.4 Where parts are allowed to be — the placement laws

Findability is 70% placement and 30% shading. `CabinSite.js` and `Props.js` obey these, and they are
authored, not random. **There is no random part scatter in this game.**

| Law | Spec |
|---|---|
| **Parts live in three places only** | (a) the **delivery pile** at the plot edge, (b) a **crate** he carried from the maintenance shed, (c) exactly where a *previous night's* action left it. Never scattered in undergrowth |
| **The missing part is always in a *named* location** | One of nine authored sites (mess porch, canoe rack, tool shed, dock box, laundry line, fire ring, bus turnaround, latrine wall, the lake path culvert). The manual's magnifier callout (§13.4) always shows a **shape from that site** — a canoe's chine, a porch baluster — so the player is navigating by remembered silhouette, not searching |
| **Maximum search radius** | 55 m on Nights 1–4, **34 m on Night 5** (whiteout — visibility is 24 m, so the target must be inside a half-visibility walk), 70 m Night 6, 45 m Night 7. Tabulated with part counts in §15 |
| **Never below knee height in vegetation** | A part on the ground is on **bare** ground: mud, boards, gravel, stone, duff. `Terrain.js` exposes `isBareGround(p)`; placement asserts it |
| **The 3:1 assert is a placement gate** | If `Debug.readability()` fails at a candidate site under that night's weather, `CabinSite` picks the next candidate. This runs at bake time, not runtime |
| **Small parts ship in containers** | Anything with a footprint < 0.19 m (screws, nails, a hinge pin) is never a findable object on its own. It is inside a **`mat.tin` box**, 0.31 × 0.22 × 0.09 m — which clears the 9 px-at-40 m gate at 0.31 m, has a flat lid that returns a full specular lobe, and rattles (`audio:sfx`, 3 m radius). **The player finds boxes. The manual asks for parts.** That gap between what you search for and what you need is the second-best joke in the game and it costs nothing |

### 4.5 Diegetic markers — the legal ones

The world is allowed exactly three non-physical-lighting aids, all of them things this man would
actually do:

| Marker | Form | Meaning | Where |
|---|---|---|---|
| **Chalk** (`mat.chalk` `#cfd3cc`, 0.6437 rel. luma) | A snapped line, an arc, a tick, a circled X — 6 mm wide, drawn on wood/stone/tin only | *He* marked this. Also: the highest-contrast small mark available in the world, 14:1 against wet lumber | Cut lines, stud layout, the plot string line, and **a circle around the site of tonight's missing part**, which he chalked while reading the manual |
| **Flagging tape** (`#c4643a`, the `garment.warm` hue) | 18 mm ribbon, 220 mm long, tied to a branch. Moves in `uWind` at 2.4× the branch's amplitude | Camp's own trail marking, reused by him. The motion is the read: **it is the only warm thing in the forest that flutters** | Route markers on the lake path and at each of the nine named sites |
| **The string line** | 2 mm mason's line, `#e8e4d6`, dead straight, tensioned | The plot's geometry. Establishes "orthogonal = his" on Night 1 | The build plot, all seven nights |

Flagging tape is warm, which appears to violate §2.1. It does not: **it is human.** It is camp
property, tied by a counsellor in daylight. That it is the same hue as the campers' garments (§8.4)
is the point — the forest is already marked by people, and he is following their marks.

### 4.6 Explicit rejections

- **No outline/glow shader on interactables.** Ever. It would put a photometric event outside the
  manual (§1, law 1).
- **No objective marker, no waypoint, no compass.** §13.8 stands.
- **No "hold button to highlight interactables" mode.** If the search needs it, §4.4 placement is
  wrong and gets fixed instead.
- **The accessibility exception**, and it is a real one: `settings.searchAssist` (default off,
  offered in the pause menu after any single search exceeds 150 s) raises the interactable rim term
  from 0.34 to 0.62 and enables a 0.4 Hz, ±6% intensity pulse on it. Still no outline. Still inside
  the world's lighting model. A player who needs it gets a wetter-looking bracket, not a video game.

---

## 5. FOG & ATMOSPHERE

`VolumetricFog.js` owns the froxel volume; `Sky.js` owns the analytic distance/aerial term. **Both
must exist.** Analytic exponential-height fog alone reads as grey wash (§19, Trap A1).

### 5.1 Height fog (analytic, injected into every material)

```
density(y) = D0 * exp(-(y - y0) / H)
fogFactor  = 1 - exp(-density(y_avg) * distance * scatterScale)
```

| Parameter | Clear | Drizzle | Windy-mist | Rain | Whiteout | Storm | Dawn |
|---|---|---|---|---|---|---|---|
| `D0` (1/m) | 0.014 | 0.021 | 0.024 | 0.031 | **0.078** | 0.048 | 0.020 |
| `y0` (fog floor, m) | −1.0 | −1.0 | −1.0 | −1.0 | −1.0 | −1.0 | −1.0 |
| `H` (scale height, m) | **4.2** | 4.8 | 5.2 | 5.5 | **14.0** | 8.0 | 3.4 |
| Near colour | `#2a3a44` | `#28353d` | `#2b3941` | `#26333a` | `#4a5d6c` | `#232d34` | `#3a4a52` |
| Far colour | `#54697a` | `#4a5d6c` | `#51636f` | `#44545f` | `#54697a` | `#3d4c58` | `#6d7e88` |
| Inscatter HG `g` | 0.55 | 0.60 | 0.62 | 0.64 | 0.38 | 0.70 | 0.45 |
| Visible range (5% contrast) | 78 m | 52 m | 44 m | 38 m | **24 m** | 30 m | 95 m |

The **4.2 m clear-night scale height** is the most important number in this section: it puts the fog
ceiling at roughly the player's shoulders on the lake path, and above his head when crouched.
Crouching should *visibly* put you into the mist. That is a stealth mechanic expressed as
atmosphere. **Whiteout inverts it deliberately** — `H = 14 m` means the fog is no longer a layer you
can duck into, it is the whole air, and the crouch mechanic stops working for one night. That is the
Night 5 art device and it is why Night 5 is the whiteout.

Injection is via `onBeforeCompile`, replacing the `<fog_fragment>` chunk. Chunk ordering is
specified once, in §11.4, and is binding.

### 5.2 Ground mist (the character)

Not a fog term — a separate, art-directed layer.

- **Domain**: a 2-channel curl-noise flow field, 256×256, tiled at 24 m, scrolling at `0.35 m/s` in
  the wind direction (`Materials.globalUniforms.uWind`).
- **Height**: mist top = `terrainHeight + 0.55 m + 0.35 * noise`. It **follows the terrain**, pools
  in depressions (`+0.9 m` where terrain curvature is concave), thins on ridges (`×0.3`).
- **Displacement**: the player and campers push it. `uPlayerPos` drives a radial displacement of
  0.9 m radius, 0.4 falloff exponent, recovering over 2.2 s. **The monster leaves a wake in the
  mist.** This is not decoration — it is the §9.5 detection tell.
- **Density modulation**: `×1.6` within 8 m of water, `×0.4` under dense canopy (the canopy holds
  heat), **`×2.2` in the excavated cabin plot** (a cold hole in the ground — the Night 1 art device,
  §0.4).
- **Render**: composited from the same froxel volume as a density boost in the bottom 6 Z-slices at
  `medium`+; a 4-slice raymarched billboard at `low`.

### 5.3 Froxel volumetrics — the WebGL2 implementation (revision 2 fix)

Revision 1 specified a 192×108×96 froxel grid (1.99 M froxels), six injected light types, 8-frame
temporal reprojection, and a 2.0 ms budget, and named no implementation strategy — which means it
never noticed that **WebGL2 has no compute shaders and no groupshared memory.** There is no
`DispatchCompute` here and no parallel prefix scan; the front-to-back accumulation is serial in
depth. Done naively (one draw per Z slice, twice) that is ~192 draws and 10–20 ms, i.e. the entire
frame. Revision 2 names the strategy, cuts the grid, and caps the lights.

**Storage.** A **2D slice atlas**, `RGBA16F`, `NEAREST` filtering, tiled `ceil(sqrt(Z))` across.
Not a `TEXTURE_3D` — we never need hardware trilinear in Z; we do the Z lerp manually in the
composite (two fetches, one `mix`) and it is cheaper than the layer-attachment churn.

| Setting | low | medium | high | ultra |
|---|---|---|---|---|
| Froxel grid `X×Y×Z` | 80×45×24 | 112×63×32 | 144×81×40 | **160×90×48** |
| Scatter atlas | 400×270 | 672×378 | 936×567 | **1120×630** |
| Depth distribution | exponential, `k = 4.0`, far = 140 m | same | same | same |
| Temporal reprojection | off | 2-frame | 4-frame | **8-frame** (Halton(2,3), prev view-proj, 3 % neighbourhood-clamp rejection) |
| Lights injected | moon | moon + lantern | moon + lantern + nearest 1 local | **moon + lantern + nearest 2 locals** |
| Composite | half-res + bilateral upsample | half-res | full-res | full-res |

**Pass 1 — Injection (1 draw).** One full-screen draw over the scatter atlas. Each fragment decodes
its `(x, y, z)`, reconstructs the froxel's world-space centre with the Halton jitter, evaluates:
density (§5.1 + §5.2), the HG phase against each injected light, the moon's cascade-0 shadow (1 tap,
no PCF), the lantern's shadow (1 tap), and the two local cones (no shadow, cone falloff only). Writes
`RGB = σ_s · L_scattered`, `A = σ_t`. **Injected light count is a compile-time `#define`, hard-capped
at 4.**

**Pass 2 — Accumulation (6 draws, MRT).** The serial front-to-back integration, without compute and
without 48 draws. Draw `k ∈ [0, 5]` binds **8 MRT colour attachments** (the WebGL2 guaranteed
minimum is 8; we assert `MAX_DRAW_BUFFERS ≥ 8` and drop to `low` if not) and rasterises a quad
covering only the `X×Y` grid footprint (160×90 = 14 400 pixels). It reads the running
`(accumulated radiance, transmittance)` from the tail attachment of draw `k−1` — a single texel
fetch — then loops **8** slices, integrating analytically per slice:

```
Tslice = exp(-sigma_t * dz);
Lacc  += T * (Lscat * (1.0 - Tslice) / max(sigma_t, 1e-5));
T     *= Tslice;
```

and writes slices `8k … 8k+7` to the eight attachments. Total accumulation work: 6 × 14 400 × 8 =
691 200 slice-integrations of ~12 ALU each. It is *cheap* — the expense in this technique was never
the scan, it was doing the scan as 96 full-screen draws.

**Pass 3 — Composite (1 draw).** Per screen pixel: linearise depth, find the two bracketing Z
slices, two atlas fetches, `mix`, apply `colour = scene * T + Lacc`. At `low` this runs half-res with
a 4-tap depth-bilateral upsample.

**Measured cost.** These are the numbers on the reference machine (§11.1). They are gates, not
aspirations: `VolumetricFog.js` logs its GPU timer-query mean every 120 frames in dev builds and
fails the build if the `ultra` total exceeds budget by > 15% for 3 consecutive samples.

| Pass | low | medium | high | ultra | Budget ceiling (ultra) |
|---|---|---|---|---|---|
| Injection | 0.21 ms | 0.44 ms | 0.72 ms | **0.95 ms** | 1.15 ms |
| Accumulation | 0.04 ms | 0.07 ms | 0.12 ms | **0.18 ms** | 0.25 ms |
| Composite | 0.11 ms | 0.19 ms | 0.28 ms | **0.30 ms** | 0.40 ms |
| **Total** | **0.36 ms** | **0.70 ms** | **1.12 ms** | **1.43 ms** | **1.80 ms** |

Scattering is **Henyey–Greenstein**, `g` per §5.1, plus a 0.12 isotropic floor so back-lit fog never
goes fully black. Whiteout drops `g` to 0.38 — thick fog multiply-scatters and loses its forward
lobe, which is *why* a whiteout has no visible shafts and reads as a flat wall. That is a physical
fact doing narrative work: Night 5 is the one night the player cannot use god rays to navigate.

### 5.4 God rays

God rays come from **occlusion of a real light by real geometry** in the froxel volume. Never a
radial-blur screen-space hack (§19, Trap A6).

| Source | When | Strength | Geometry that cuts it |
|---|---|---|---|
| Moon through canopy | Always, strongest at elevation < 22° | 0.35 | Tree canopy alpha cards (§12.3 dither path) |
| **Moon through the cabin frame** | Night 3+, once studs are up | 0.55 | The studs themselves — **the player builds their own god rays.** The §0.4 N3 art device |
| Camper flashlight | Whenever a beam crosses view | 0.85 | Trunks, mist, rain |
| Player lantern | Always | 0.45 | Everything in front of it |
| Mess-hall sodium | Approaching camp | 0.60 | Tent lines, laundry, the flagpole |
| Lightning | 3 flashes/strike | 1.0 for 60 ms | Everything. The Night 6 money shot |

Only the moon and lantern have shadow taps in the injection pass, so only they produce *true*
occlusion shafts. Camper cones and sodium get their shafts from cone geometry alone, which is
correct — a torch beam in mist is shaped by its own cone, not by what it fails to hit.

Rain streaks **inside** a light cone are lit at 2.2× ambient rain brightness. One dot product; makes
every cone look like it cost a million dollars.

---

## 6. MATERIALS

Authored in `Textures.js` (procedural PBR bakery) and assembled in `Materials.js`. Texture ladder:
`settings.tier(256, 512, 1024, 2048)` for hero surfaces, one tier down for everything else.

### 6.0 Material classes and custom BRDF lobes (revision 2 fix)

Revision 1 declared "every entry is `MeshStandardMaterial` unless noted" and then demanded sheen,
anisotropy, a Kajiya–Kay hair lobe, two-lobe skin, Burley subsurface, and `transmission 0.18` —
none of which `MeshStandardMaterial` supports. Worse, `transmission` in Three drives **an additional
full scene render into a transmission render target every frame**, an unbudgeted second forward
pass, for tents. Revision 2 names the class on every row and prices every lobe.

| Class | Used for | Notes / cost |
|---|---|---|
| `MeshStandardMaterial` | Terrain, mud, moss, granite, weathered plank, tin, rust, dried blood, needle litter | The default. ~68% of renderables |
| `MeshPhysicalMaterial` (`sheen` only) | Canvas, fern, moss, camper garments | Three's `sheen`/`sheenColor`/`sheenRoughness` **is** the Estévez–Kulla sheen BRDF. We get it for free by using the right class. `+0.9 ms` full-screen worst case at ultra, measured over 22% screen coverage |
| `MeshPhysicalMaterial` (`anisotropy` only) | Sawn lumber, galvanized steel, tin | `anisotropy` + `anisotropyRotation`, available in the pinned version. Drives §4.3's beacon streak. `+0.4 ms` |
| `MeshPhysicalMaterial` (`sheen` + `anisotropy`) | Wet bark near-LOD | The only row that takes both. ≤ 4% screen coverage; keep it that way |
| **`MeshStandardMaterial` + chunk `BARK_POM`** | Bark, nearest LOD only (< 6 m) | 8-step parallax occlusion, 4-step refine. `+0.35 ms`, gated to < 6 m and to `high`+ |
| **`MeshStandardMaterial` + chunk `HAIR_KK`** | Camper hair cards | Kajiya–Kay: two shifted anisotropic lobes (primary `#c9bda6` shift +0.02, secondary tinted by base colour shift −0.05, exponents 80 / 12). `+0.22 ms` at ≤ 2% coverage |
| **`MeshStandardMaterial` + chunk `SKIN_2LOBE`** | Camper skin | Two-lobe specular (0.28 broad @ roughness 0.42 + 0.06 tight @ 0.18) + 3-band wrap approximating Burley diffusion (`#e0a08c` at 2 mm, `#c05a4a` at 6 mm, `#8a2f2a` at 14 mm). `+0.31 ms` |
| **`MeshStandardMaterial` + chunk `CANVAS_WRAP`** | Tents | **Replaces `transmission`.** See §6.3 |
| `ShaderMaterial` | Lake, rain streaks, mist billboards (`low` only), sky dome, the froxel composite | Fully custom, no lights |

Every chunk above is a named file in `src/shaders/chunks/`, registered in `THREE.ShaderChunk`, with
its cost line in a header comment quoting this table. **Adding a chunk requires adding a row here.**

### 6.1 The wetness model (read this before authoring anything)

The world is damp every night. Wetness is a **per-material scalar `W ∈ [0,1]`** driven by
`Materials.globalUniforms.uRain` (accumulating) plus a per-vertex `aExposure` attribute (0 =
sheltered, 1 = open sky), plus a cavity mask from the material's own AO/height map.

Four simultaneous operations. All four, or it does not read:

1. **Darkened albedo.** `albedo *= mix(1.0, 0.62, W * porosity)`. `porosity`: wood 1.0, bark 0.95,
   soil 1.0, moss 0.85, granite 0.55, canvas 0.9, steel 0.05, tin 0.05. Water fills surface
   micro-voids and kills diffuse backscatter — the *physical* reason wet things darken, and why
   non-porous things barely do. **This is also a readability engine**: rain darkens the mud by 38%
   and the bracket by 2%, so the bracket's contrast against ground *rises* from 7.6:1 to 12.2:1 in
   rain. §15 uses that.
2. **Crushed roughness.** `roughness = mix(roughness, 0.08, W * (1.0 - cavityMask*0.4))`. Wet
   surfaces become mirrors. Aggressively. A wet fir trunk in moonlight has a 0.10-roughness rim and
   that rim is 60% of why the shot reads as expensive.
3. **Puddle accumulation in cavities.** Where `cavity > 0.6 && slope < 18°`, lerp toward a flat
   water layer: `roughness → 0.02`, `normal → flat`, `albedo → #0b171c`, `F0 → 0.02`. Accumulates
   over the night: `puddleLevel = smoothstep(0.15, 0.85, rainAccum)`. Ruts, footprints, the
   excavation, the tarp folds, the upturned canoe. **Puddles must reflect** — one 128² cubemap probe
   re-rendered at the camp every 30 frames (0.22 ms amortised); the lake gets planar reflection at
   `high`+ (§11.2 line item).
4. **Grazing-angle sheen.** Schlick `F0 = 0.02` bumped to `0.06` where `W > 0.5`, plus the
   `MeshPhysicalMaterial` sheen lobe on organics per §6.0. This is what makes a backlit fern look
   photographed.

**Drips.** Any surface with `W > 0.7` and a downward-facing edge spawns a drip every `gauss(3.4,
1.1)` s from a pooled particle system, capped at 200 live. Two-frame streak sprite plus a landing
ripple decal. They emit `audio:sfx` at trivial volume, so the world *sounds* wet, which makes it
*look* wetter.

### 6.2 Material table

Class column is binding. "×" column is normal-map strength.

| Surface | Class | Albedo | Rough | Metal | × | What makes it read as expensive |
|---|---|---|---|---|---|---|
| **Bark, Douglas fir** | Std + `BARK_POM` (< 6 m); Phys(sheen+aniso) when wet | `#38312a` dry → `#15120f` wet | 0.88 → 0.14 | 0.0 | 1.6 | Two-scale normal: 4 cm plate relief + 4 mm fissure. POM 8 steps on the near LOD only. Trunk-space AO in the fissures. Moss mask from north-facing normal + trunk-base height |
| **Bark, birch** | Std | `#b9b6a6` | 0.62 | 0.0 | 0.9 | Peeling curl geometry (4 instanced strips/trunk), translucent curl edge via wrap lighting. Horizontal lenticel scars as a stochastic decal band |
| **Pine needles (canopy card)** | Std, `alphaHash` | `#131f1a` | 0.42 wet | 0.0 | 0.7 | **Stochastic alpha dither, not alpha-test and not A2C** (§12.3 explains why). Two-sided, wrap `0.35`, translucency so the moon glows through card edges |
| **Fern / undergrowth** | Phys(sheen) | `#1a2a22` | 0.35 | 0.0 | 0.8 | Vertex-colour AO root→tip, per-blade wind phase offset, and **sheen so strong the fern reads as a silhouette of highlights**, not a green shape |
| **Wet earth / duff** | Std | `#2a221b` | 0.30 | 0.0 | 1.3 | Triplanar, 3-octave detail normal; puddle mask from curvature; **footprint decals that deform the normal and go glossy** (a print in wet mud fills with water in ~4 s) |
| **Mud (excavation, tracks)** | Std | `#221b15` | 0.16 | 0.0 | 1.8 | Full puddle layer, tool-mark relief. He kneels here — it must survive a 0.4 m camera |
| **Moss** | Phys(sheen) | `#1d2b1c` | 0.72 | 0.0 | 0.5 | Shell texturing: 4 shells, 3 mm total, `high`+ only, `+0.28 ms`. Subsurface wrap 0.5. North faces and shaded rock only |
| **Granite** | Std | `#3b464b` | 0.55 → 0.09 wet | 0.0 | 1.1 | Three-tone speckle (feldspar `#6a7176`, quartz `#8a929a`, biotite `#191d20`) at 2 mm; **micro-sparkle that survives at 20 m** via Toksvig normal-variance→roughness, so mipping becomes roughness, not flatness |
| **Sawn lumber (fresh)** | Phys(aniso) | `#a8875c` | 0.68 | 0.0 | 1.0 | Saw-kerf micro-grooves as the anisotropy direction along the cut; end grain gets a high-porosity mask so it soaks visibly darker. **The brightest big surface in the game** |
| **Weathered plank** | Std | `#6b6155` | 0.82 | 0.0 | 1.4 | Raised grain relief, checked splits, nail-hole cavities that fill with water |
| **Galvanized bracket** | Phys(aniso) | `#9aa0a3` | **0.22 ±0.14** | **0.88** | 0.6 | **Spangle, tuned as a beacon.** Full spec in §4.3 — this row is subordinate to that one |
| **Canvas tent** | Std + `CANVAS_WRAP` | `#5c5b46` | 0.86 | 0.0 | 1.1 | Woven normal at 1.2 mm; glows from within like a paper lantern **without real transmission** (§6.3); seam/grommet decal pass |
| **Corrugated tin** | Phys(aniso) | `#7d8487` | 0.44 | 1.0 | 0.8 | Corrugation is **geometry**, not a normal map — 24 segments per panel. Rain runs the valleys (animated flow map). Dent noise breaks the specular into a wobbling broken line |
| **Rusted nail / hinge** | Std | `#7a4526` | 0.78 | 0.35 | 1.5 | Rust is a *blend* between galv and rust driven by cavity+age, metalness lerping 1.0 → 0.2 as it corrodes. Bloom on the un-rusted head |
| **Camper skin** | Std + `SKIN_2LOBE` | `#6b5148` (+2 variants, §8.5) | 0.36 | 0.0 | 0.4 | Two-lobe specular + 3-band wrap. Eyes get a real corneal specular at roughness 0.02 — that catchlight from a campfire 20 m away is what makes a camper read as alive |
| **Camper hair** | Std + `HAIR_KK` | 4 authored tones, §8.5 | 0.30 | 0.0 | 0.5 | Kajiya–Kay two-lobe; card-based, 9–14 cards per head, wind-reactive at 0.4× branch amplitude |
| **Camper garment (warm)** | Phys(sheen) | `#c4643a` (`garment.warm`) | 0.74 | 0.0 | 1.0 | Sheen is doing the work: a fleece rim-lit by a campfire at 20 m is the palette's payoff (§8.4) |
| **Blood, fresh** | Std | `#7a1013` | 0.10 | 0.0 | 0.9 | Non-Newtonian: raised meniscus (normal ridge), near-mirror interior, **subsurface red bleed** so thin film reads `#a8161a`. Flow decal runs downhill 6 s then sets. **His only** (§0.2) |
| **Blood, dried (1971)** | Std | `#3a1113` | 0.74 | 0.0 | 1.2 | Cracked-mud normal at 0.8 mm, matte, slightly raised at crack edges |
| **Lake water** | ShaderMaterial | `#0b171c` | 0.02 | 0.0 | — | Gerstner sum (4 waves), `F0 0.02`, planar reflection at `high`+, shoreline foam line with depth fade, rain-ring normal impulses at `uRain` rate |
| **Tarp (blue poly)** | Phys(sheen) | `#2f4550` | 0.28 | 0.0 | 1.3 | Wrinkle normal from a GPU cloth-relaxation bake (§14); sheen; water pooled in the sags — a great puddle showcase, and the Night 4 prize |
| **Chalk mark** | Std, `unlit`-ish (emissive 0) | `#cfd3cc` | 0.94 | 0.0 | 0.2 | Decal, 6 mm, `polygonOffset`. High albedo, high roughness: it reads at any angle, which is the point (§4.5) |

### 6.3 Why the tents do not use `transmission` (revision 2 fix)

`MeshPhysicalMaterial.transmission > 0` makes Three render **the entire scene a second time** into a
transmission target every frame so the material can sample what is behind it. For a tent — an
opaque-ish canvas cone with a lamp inside — that is paying a full forward pass to simulate something
we can author directly. We delete it. Replacement, in chunk `CANVAS_WRAP`:

1. **Two-sided wrap diffuse.** `wrapDiffuse = saturate((dot(N, L) + w) / (1 + w))` with `w = 0.72`,
   evaluated on the *back*-facing normal too. Canvas lit from inside spills round the fold.
2. **Interior emissive card.** One unlit quad inside the tent at 0.62 m, `#ffb865 × 0.34`, occluded
   by the tent's own geometry, sized to the lamp. It is what actually makes the tent glow, and it is
   two triangles.
3. **A thickness ramp** baked into vertex colour: seams and doubled canvas at 0.25, single panel at
   1.0. The seams read as dark lines in a glowing wall, which is the entire visual of a lit tent.

Cost: **0.03 ms**, versus a full second scene pass. Stated here so nobody "fixes" it later.

### 6.4 The lumber rule

Sawn lumber at `#a8875c` is **+0.55 stops** and the cabin's structural members are the only large
bright mass in the world. Intentional: as the player builds, **the cabin literally becomes the
brightest thing in the forest.** `CabinSite.js` must not weather new lumber; each night's new parts
are brighter than the previous night's, which have darkened by `W` accumulation. The building is a
stratigraphy of exposure — you can read the build order off the walls at dawn on Night 7, oldest and
darkest at the bottom.

| Night placed | `W` accumulated by N7 | Albedo at N7 | Reads as |
|---|---|---|---|
| 1 (sill, stones) | 0.94 | `#4f4335` | Old. Part of the ground |
| 2 (joists) | 0.86 | `#5a4c3b` | Settled |
| 3 (studs) | 0.71 | `#6d5c46` | Weathering |
| 4 (rafters) | 0.58 | `#7d6950` | Recent |
| 5 (ridge beam) | 0.41 | `#8f785a` | New |
| 6 (sheathing, tin) | 0.24 | `#9e8259` | Very new |
| 7 (door, window, trim) | 0.06 | `#a8875c` | **Cut today.** The door is the brightest object in the final frame, which is why the final frame is about the door |

---

## 7. THE BUILD — VISUAL GRAMMAR OF ASSEMBLY

The game's central verb is **building it wrong**. Revision 1 gave the cabin a beautiful *tonal* arc
(§6.4) and no *structural* one, and described wrongness only as an audio event: "build it wrong and
it creaks." A creak the player cannot see the cause of teaches nothing, and a mechanic with no
picture is not a mechanic. This section is the picture.

### 7.1 Build-state enumeration

Every part is in exactly one of six states. `CabinSite.js` owns the state machine; the visual
treatment of each state is binding.

| State | Visual treatment | Audio | Duration |
|---|---|---|---|
| `LOOSE` | On `LAYER_INTERACTABLE`. Full §4 readability treatment: rim term on, spangle on, SSCS mandatory | — | Until picked up |
| `HELD` | In hand, 0.42 m, `LAYER_HANDS` (4-light exemption, §3.2). Near-field DOF f/1.8. Its **long axis is aligned to the frame's vertical**, always, so the player can read its profile against the fog | Weight-appropriate handling loop | Until placed |
| `GHOSTED` | Within 1.2 m of its socket: a **`hairline` chalk-white wireframe** of the part's final position, 0.6 mm lines, `#cfd3cc` at 34% — drawn as *geometry* (thin extruded quads), not as a UI overlay, so it fogs and shadows correctly. This is the game's only "UI in the world" and it is a chalk mark, which is diegetic (§4.5) | — | While aiming |
| `SEATING` | The 3 cm travel. §7.4 | Wood-on-wood squeal, rising | 0.34 s |
| `SEATED_TRUE` | Flush. Gap ≤ 0.4 mm. Continuous surface, continuous AO, one shadow | **A single `clack`.** Dry, short, 40 ms, no reverb tail | Permanent |
| `SEATED_WRONG` | Full §7.3 treatment | The **creak**: 0.9 s, 60–140 Hz, and it repeats on load changes (wind gusts, later parts stacking on it) forever until fixed | Until removed and re-seated |

### 7.2 The structural arc (per night)

Screen area is measured from the canonical treeline camera of Shot 1 (§16), 72° FOV, 1080p. "God-ray
slots" = the number of distinct openings in the structure through which the moon at 19–26° elevation
can cut a shaft into the froxel volume (§5.4). It is the number that makes progress *feel* like
progress.

| N | Silhouette added | Tallest point | Screen area from treeline | God-ray slots | The read from 60 m |
|---|---|---|---|---|---|
| **1** | A rectangle of string and four stones. Nothing vertical | 0.42 m | **0.4%** | 0 | A pale geometric scar on the forest floor. You have to know it's there |
| **2** | Floor platform: a raft of joists, one horizontal plane | 0.65 m | **1.1%** | 0 | A flat bright shelf, `#a8875c`, floating in mist. The first horizontal in a vertical world |
| **3** | 22 wall studs, north and east walls. **The first verticals** | 2.74 m | **4.8%** | **14** | A comb. A skeleton. Fourteen shafts of moonlight fan out across the mist from behind it. **This is the frame that changes the game** |
| **4** | Rafters + ridge board, tarp lashed over half | 4.10 m | **7.9%** | 21 | A ribcage under a sagging skin. Rain sheets off the tarp in a visible curtain |
| **5** | Ridge beam true, all four walls studded | 4.35 m | **9.2%** (but in whiteout: **2.1%** and mostly value, not detail) | 26 | In the fog, a darker grid. The one night the cabin is *less* visible than the night before |
| **6** | Sheathing (walls go solid), tin roof on | 4.60 m | **11.6%** | **3** (window rough-openings + door) | **The god rays collapse from 26 to 3.** The building closes. The reward you built is taken away by the next stage of building it, and that is the correct, sad shape of construction |
| **7** | Door hung, window glazed, step, trim | 4.60 m | **11.9%** | 2 (window + the gap under the door) | Finished. Small. Tidy. Warm light in one window |

`CabinSite.js` asserts these areas in CI from the Shot 1 camera, ±0.6% absolute. If Night 3 does not
land at 4.8% the studs are the wrong height or the plot is in the wrong place.

### 7.3 Wrongness legibility — the spec

> **A wrongly-seated joint must be identifiable as wrong, by a player who has never seen the correct
> version, from 8 m, in moonlight, in under 2 seconds.**

Three redundant channels, all three always present, each individually sufficient:

| Channel | Spec | Why it survives the dark |
|---|---|---|
| **1. The gap** | A misseated joint holds a **4.0 mm** gap along the full length of the joint face (min 180 mm). The gap's two lips are chamfered 0.3 mm, so the moon at grazing incidence puts a **continuous `moon.rim` `#aebcdc` line** down it. A correct joint's gap is ≤ 0.4 mm and returns no continuous highlight | A *line* of 0.50 luminance against a 0.03 field is the single most visible thing our lighting model can produce. It is 16:1 and it is 180 mm long, which is 6 px at 8 m |
| **2. The bracket's axis** | Every bracket's spangle anisotropy (§4.3) runs along its **rolling direction**, which we author to coincide with the part's true axis. A bracket seated off-square by ≥ 3° puts its glint streak **visibly off-parallel** with the lumber's own kerf anisotropy | Two anisotropic streaks that should be parallel and aren't. The eye is extraordinarily good at this — it is the same perceptual channel as noticing a crooked picture frame |
| **3. Plumb against the fog wall** | A stud out of plumb by ≥ **1.5°** is silhouetted against `fog.far` (§5.1) — a 2.74 m stud leans 72 mm off true at the top, which at 8 m is **19 px of horizontal displacement** relative to its neighbours in a rank of studs 400 mm on centre | The building is a **repeating grid**, and a repeating grid makes any deviation enormous. This is why the studs are the Night 3 device: from Night 3 onward, the cabin itself is a measuring instrument |

**Correctness is also legible.** A `SEATED_TRUE` joint gets: continuous GTAO across the seam (the two
parts share one occlusion field), one continuous contact shadow instead of two, and — the detail
that sells it — the two parts' wetness `W` **equalises over 8 s**, so a correct joint slowly becomes
one object and a wrong one stays two.

### 7.4 The seating spec — what the last 3 cm looks like

Assembly is never a cross-fade, never a snap, never a part popping into place. It is a **travel**.
`build:place` triggers a 0.34 s authored motion, and every element below is mandatory:

| t | What happens |
|---|---|
| 0 – 0.10 s | The part travels the first 26 mm freely. Near-field DOF holds focus on it. His forearms enter deeper into frame; the lantern's bottom-up key rakes across the joint face |
| 0.10 s | **First contact.** The part stops dead for 40 ms. Dust — 14 particles, `#4a4433`, 3 mm — puffs from the joint and drifts into the lantern cone. A 0.9 mm compression appears in the wood's normal map at the contact line |
| 0.10 – 0.28 s | The last 4 mm, at a decelerating rate (`easeOutQuint`). The gap's `moon.rim` line **narrows visibly** and goes out, like a shutting eye. This is the single most satisfying 180 ms in the game and it must be shot for |
| 0.28 s | **Seated.** One `clack`. The camera takes a **−0.35° pitch dip over 70 ms** — his weight coming off the part. Not a shake. A settle |
| 0.28 – 0.34 s | His hands withdraw 40 mm and pause. DOF racks from the joint (0.42 m) to the next thing (1.4 s lag, §9.3). **He looks at it.** The game holds for 6 frames before returning control |
| Wrong case | At 0.10 s the part **rocks**: ±1.2° over 0.22 s, damped, and comes to rest cocked. The gap's rim line *stays lit*. The creak fires **as the rock damps out**, not on contact — so the sound has a visible antecedent and the player learns, on Night 1, that the rocking is the thing that makes noise |

### 7.5 The chain from mistake to threat

Every link in this chain has a picture. This is the game's causal spine and §19 Trap B7 exists to
protect it.

```
wrong part or wrong orientation
   → the part ROCKS (visible, 0.22 s, ±1.2°)
   → the gap's moon.rim LINE STAYS LIT (visible, permanent, 16:1 contrast)
   → the CREAK (audio, 0.9 s)
   → within 1.4 s, one camper torch cone STOPS SWEEPING (visible at up to 180 m — a cone that
     stops is more alarming than a cone that moves, and it is the only thing in §9.5 that changes)
   → the cone ROTATES toward the plot over 2.2 s
   → footsteps in wet duff (audio, directional)
   → a silhouette resolves out of fog at the §5.1 visibility distance
```

The player must be able to walk this chain backwards from any point. If a tester says "I don't know
why they found me", a link is missing.

---

## 8. THE CAMPERS

Six humans, in a game with zero binary art assets, seen almost always at distance in fog, and they
are the only source of human horror in a horror game. Revision 1 gave them one material row and one
palette swatch. **Procedural humans that do not read as mannequins is the hardest technical art
problem in this project**, and it is a problem we win by *design*, not by fidelity: we win at
silhouette, gait, and garment, and we refuse the fight at faces.

### 8.1 Count and staffing

| Group | Count | Behaviour | Present |
|---|---|---|---|
| Campers (teen counsellors-in-training) | **5** | Patrol, fire ring, tents, lake path. Torches | All nights |
| Adult (COACH RAY) | **1** | Slow, fixed route, clipboard, no torch — he uses the sodium lamp and knows the camp in the dark | N2–N7 |
| Total simultaneously rendered | **≤ 4** | Distance + frustum culled with 12 m hysteresis | — |

Six designs, at most four on screen, is the right ratio: it guarantees the player meets a *new*
silhouette as late as Night 5, and it keeps the skinned-mesh budget at 4 × LOD-appropriate.

### 8.2 The silhouette law

> **Each camper is identifiable by silhouette alone, in one frame, at 40 m in clear weather and at
> 18 m in whiteout, with zero light on them.**

Enforced on four orthogonal axes. No two campers may share more than one axis value.

| Axis | Values used |
|---|---|
| **Aspect** (height × width class) | tall-narrow, tall-broad, short-narrow, short-wide, medium-triangular, medium-square |
| **Head shape** | ponytail, backwards cap, bun, bare/volume, hood-up, flat-cap-and-collar |
| **Limb attitude** | hands in pockets, arms swinging wide, one arm across body (carrying), arms out for balance, one arm up (torch high), one arm down + clipboard |
| **Carried object** (silhouette-bearing) | none, none, big square lantern, whistle-on-lanyard, poncho hem, clipboard |

### 8.3 The six

| # | Name | Aspect | Head | Limbs | Carried | Gait signature | Story role |
|---|---|---|---|---|---|---|---|
| 1 | **DANA** | tall-narrow, 1.71 m | ponytail (swings 0.9× step rate, 90° out of phase) | hands in pockets, coat open so the coat's hem is the moving edge | none | Long stride, 1.31 Hz, **stops often** | §0.4 N3, N6. The one who looks |
| 2 | **MARCUS** | tall-broad, 1.78 m | backwards cap (flat top, hard rectangle) | arms swing wide, 22° | none | Fast, 1.62 Hz, never stops | Noise-maker. Draws attention away |
| 3 | **PRIYA** | short-narrow, 1.55 m | bun (a hard bump, the smallest head profile) | one arm across body | **square battery lantern**, 0.22 m, held low — a *rectangle of light* not a cone | Short steps, 1.74 Hz, leans back against the weight | The only camper whose light is not a cone. Reads instantly at range |
| 4 | **TOM** | short-wide, 1.58 m + a duffel | bare, high hair volume | arms out for balance | whistle on lanyard (swings 2.1× step rate) | Bouncing, 1.55 Hz, 4.4 cm vertical | Comic relief in the world, never in the manual |
| 5 | **BECCA** | medium-triangular, 1.64 m | hood up (no neck — the silhouette is one continuous curve) | one arm up, torch high | poncho | Slow, 1.18 Hz, **the poncho hem lags the body by 0.14 s** | The unreadable one. You cannot tell which way she is facing |
| 6 | **COACH RAY** | medium-square, 1.75 m, heavy | flat cap + raised collar | one arm down, clipboard flat | clipboard | 1.05 Hz, **long stance phase** — he is planted more than he moves | The adult. The only one who would recognise a stranger as a stranger |

**The triangle rule.** Becca is the only triangle in a world of verticals. That is why she is the
scariest and why she gets Night 5's 4 m pass. A triangle at 22 m in fog is unmistakably a person and
tells you nothing else.

### 8.4 One warm garment each — the palette's payoff

§2.1 says *warmth means a person* and revision 1 then never put warmth on a person's **body** — only
on the lights they carried. That was the palette's biggest wasted asset. Each camper wears exactly
one garment in the `garment.warm` family, and it is the only warm *surface* in the game.

| Camper | Warm garment | Hex | Coverage | Where it sits in the silhouette |
|---|---|---|---|---|
| DANA | Fleece under the open coat | `#c4643a` | 11% of body | A vertical warm stripe down the centre — visible only when the coat swings, so **she flickers warm as she walks** |
| MARCUS | Varsity sleeve stripes | `#b8552f` | 7% | Two bands on the swinging arms. Reads as motion, not as a shape |
| PRIYA | Whole sweatshirt | `#c9704a` | 46% | The most warm-covered camper. At range she is a small warm blob and she is the easiest to see coming |
| TOM | Knee socks + whistle cord | `#c4643a` | 5% | Down low, near the ground mist — his warmth is at ankle height, which is *deeply* strange and correct |
| BECCA | Poncho hem band | `#a85333` | 6% | A warm line at the bottom edge of the triangle, lagging 0.14 s. The only warm thing in the game with delay |
| COACH RAY | Windbreaker collar + cuffs | `#9c5433` | 4% | Least warm. He is the least like a child |

Under a `0.06`-intensity moon, `#c4643a` returns about 0.011 relative luminance — **barely** above
`shadow.lift`. That is correct and intended: warmth on a body is not a beacon, it is a *confirmation*
that arrives at 20 m, after the silhouette has already frightened you at 40 m. The order of the
reveal is: shape, then motion, then warmth, then — never — a face.

### 8.5 The procedural human pipeline

`Humanoid.js`. Everything below is generated at load (§14) into a shared vertex buffer; the six
bodies together are **one instanced skinned mesh family, 3 draw calls total** (body, hair, garment).

| Stage | Method | Output | Cost |
|---|---|---|---|
| **Skeleton** | 14 bones (root, hips, spine×2, neck, head, clavicle×2, upper/lower arm ×2, upper/lower leg ×2, foot ×2). Authored proportions per §8.3 | — | — |
| **Body mesh** | Lofted from 22 elliptical cross-sections along the skeleton, with per-camper radius profiles. Catmull-Rom in the loft direction, 16-gon rings. **LOD0 2 400 tris, LOD1 900, LOD2 260, LOD3 a 2-tri card with a baked alpha silhouette** | Skinned, 4 weights | 42 ms bake |
| **Skin** | 3 authored tones — `#6b5148`, `#8a6a52`, `#4a3830` — × per-camper hue jitter ±3°. `SKIN_2LOBE` (§6.0) | — | — |
| **Hair** | 9–14 cards per head, placed on a scalp map, shaped by the head profile. `HAIR_KK`. 4 tones: `#1a1512`, `#3a2a1e`, `#5a4430`, `#7a6448`. Wind at 0.4× branch amplitude | 380 tris | 8 ms |
| **Garment** | Second lofted shell at +12 mm offset with per-vertex "drape slack" 0–40 mm; **not simulated at runtime.** Secondary motion is a 2-bone lag chain on hems and a vertex-shader sway term driven by hip velocity + `uWind` | 620 tris | 14 ms |
| **Cloth wrinkles** | One 512² normal map per garment, baked at load by a **GPU relaxation pass** (12 iterations of a Poisson-ish smoothing on a render target), not a CPU cloth sim | — | 21 ms GPU |
| **Runtime** | Skinning on GPU, 14 bones × 4 campers = 56 matrices in one UBO. Animation evaluated on CPU | — | **0.34 ms CPU, 0.21 ms GPU** for 4 campers at LOD0 |

**Total campers GPU cost, 4 on screen at `ultra`: 0.61 ms** (mesh + hair + garment + `SKIN_2LOBE` +
`HAIR_KK`). Budgeted in §11.2.

### 8.6 Faces — the honest rule

> **We never render a face closer than 8 m, with exactly one authored exception.**

We will not win procedural faces. Saying so here, in the binding document, prevents six weeks of
someone trying.

| Distance | What a head is |
|---|---|
| > 25 m | A dark ovoid. No features. Possibly two 1 px `moon.spec` catchlights if a fire is behind the camera |
| 12 – 25 m | Ovoid + hair silhouette + a value break at the brow. **Two corneal specular points at roughness 0.02**, which is the entire trick: a catchlight from a campfire 20 m away is what makes a shape read as *alive*, and it costs two highlights |
| 8 – 12 m | Add: a jaw shadow, a nose value break, a mouth **line** (not a mouth), and — only if wet — a lip specular. Still no eyes, no brows, no teeth |
| < 8 m | **Does not happen.** Camper AI, camera framing, and level design all conspire against it: torch-carriers turn away, the mess porch has a 9 m sight line, and the one time a camper closes to 4 m (§0.4 N5) is authored |
| **The exception (N5, 4 m)** | Her face is **62% dissolved into `fog.far`** by the whiteout's `D0 = 0.078` over 4 m, back-lit by her own torch spill so it is a *rim*, and on screen for 1.9 s. What the player sees is a wet cheek edge, one catchlight, and breath. That is a face, and we can build that face |

### 8.7 The walk cycle

Procedural, no keyframe data, deterministic from `ctx.rand`.

| Element | Spec |
|---|---|
| **Locomotion** | Two-bone IK per leg to a foot-plant target on the terrain. Stride length = `speed / stepRate`. Foot planted for **58%** of cycle (walk); toe-off eases `easeInQuad` over the last 14% |
| **Hips** | Vertical bob = `A_v · |sin(2πp)|` with `A_v` per §8.3 (2.8–4.4 cm). Roll toward the stance leg, 3.2°. **Counter-rotation vs shoulders: 11° out of phase by π** |
| **Arms** | Swing 14–22° per §8.3, lagging the opposite leg by 0.08 s. **The torch arm does not swing** — it is stabilised, which is the tell that separates a camper who is *looking* from one who is *walking* |
| **Head** | Gaze-stabilised: the head counter-rotates to hold a target for up to 0.6 s, then saccades. **A head that holds still while the body walks is the most human thing in the pipeline** and it is four lines of code |
| **Torch behaviour** | Idle sweep: ±34° at 0.11 Hz, with a 1/f jitter of ±2°. **On `build:creak`: the sweep stops within 1.4 s and holds for 2.1 s, then rotates toward the plot at 16°/s.** That stop is the entire detection language of the game (§9.5) |
| **Breath** | On nights 1–7 the air is cold: every camper emits a 0.7 s breath plume every 3.1 ± 0.9 s, injected into the froxel volume as a local density boost. **You can see a camper breathing at 30 m through fog before you can see the camper** |
| **Idle** | Weight shifts every 4–9 s, 22° hip roll transfer over 1.1 s. Nobody stands still. A perfectly still human at range is a mannequin and the player will know instantly |

### 8.8 Camper LOD ladder

| LOD | Distance | Tris/camper | Skinning | Hair | Garment |
|---|---|---|---|---|---|
| 0 | < 12 m | 2 400 | 14 bones | 14 cards, `HAIR_KK` | Full + lag chain |
| 1 | 12 – 30 m | 900 | 14 bones | 6 cards, Std | Full, no lag chain |
| 2 | 30 – 70 m | 260 | 8 bones | 1 card | Merged into body |
| 3 | > 70 m | 2 (billboard) | — | Baked into the alpha silhouette | Baked |

LOD3's billboard is regenerated per camper per 30° of yaw from the LOD2 mesh at load, into a 128×256
atlas — 12 yaw steps × 6 campers, one 1536×1536 target, baked once. It **still animates**: the
billboard's alpha is picked from a 6-frame walk strip. A distant figure that does not move its legs
is the tell that kills the whole illusion, and it costs us a 6× wider atlas.

---

## 9. COMPOSITION & CAMERA

### 9.1 Lens

| Parameter | Value | Reason |
|---|---|---|
| Vertical FOV (default) | **72°** (matches `settings.fov`) | ≈ 21 mm full-frame horizontal at 16:9. Wide enough that the frame edges are dangerously empty |
| FOV, sprinting | 78°, eased over 0.35 s (`easeOutCubic`) | Speed you feel in the periphery |
| FOV, crouched + still | 68°, eased over 0.9 s | The world *closes in* when you hide |
| FOV, blueprint open | 62°, eased 0.18 s | Focus. Tunnel vision on the diagram |
| ~~FOV, `player:spotted`~~ | **DELETED** | §9.5. A large patient man does not get a dolly zoom |
| Near / far | 0.05 / 400 | Near must be tight — he holds parts at 0.3 m |
| Eye height | 1.70 standing, 1.06 crouched, 1.24 kneeling (build) | Per `ARCHITECTURE.md` §2 |
| Aspect handling | Vertical FOV fixed; ultrawide gains horizontal | Never letterbox in gameplay |

### 9.2 The handheld model — "a big, heavy, patient man"

`Player.js` composes **four** additive noise layers on the camera's local transform. Everything
deterministic (`ctx.rand`) so screenshot tests reproduce.

| Layer | Frequency | Amplitude | Applies to | Notes |
|---|---|---|---|---|
| **Breathing** | 0.24 Hz idle, 0.55 Hz exerted | Y ±1.6 cm, pitch ±0.28°, roll ±0.11° | Always | Asymmetric envelope: inhale 38% of cycle, exhale 62%. A slow inhale is unsettling; a sine wave is not |
| **Micro-tremor** | 1/f pink noise, 0.5–9 Hz band | yaw/pitch ±0.09° RMS | Always | This is the whole handheld illusion. Without it the frame is dead; with too much it is nausea. **±0.09° RMS is the number** |
| **Footstep sway** | step rate (1.45 walk / 2.35 sprint / 0.85 crouch Hz) | below | On move | Figure-8, not a sine |
| **Impact** | one-shot | pitch −0.9° spike, 90 ms decay | Each `player:footstep` | Heel strike. Weight |

**Footstep sway (the figure-8):** at step phase `p ∈ [0, 2π)`, `x = A_x·sin(p)`, `y = A_y·sin(2p)`,
`roll = A_r·sin(p + 0.4)`.

| Gait | `A_x` | `A_y` | `A_r` | Step rate |
|---|---|---|---|---|
| Walk | 3.1 cm | 2.2 cm | 0.72° | 1.45 Hz |
| Sprint | 5.4 cm | 4.6 cm | 1.35° | 2.35 Hz |
| Crouch-walk | 1.4 cm | 0.9 cm | 0.30° | 0.85 Hz |
| Carrying a heavy part | ×1.35 all, `A_r` biased +0.4° toward the carry shoulder | | | 1.20 Hz |
| **Carrying the ridge beam (N5)** | ×1.9 all, `A_r` +1.1°, and a **0.7 Hz longitudinal surge** of ±4 cm as the beam's mass leads and trails him | | | 0.92 Hz |

**Weight expressed as lag, not shake.** The view target lags mouse input through a critically-damped
spring: `ω = 22 rad/s`, `ζ = 1.0`; **turn acceleration clamped to 520°/s²**. A large man cannot snap
his head around. Sprint adds 0.06 s more lag. This one clamp does more for "you are a heavy monster"
than any animation, and it is also the reason §9.5 does not need a lens effect: **he physically
cannot whip round to look at what spotted him, and that is far more frightening than a snap-zoom.**

**Landing:** vertical impulse maps to a pitch dip of `min(1.0, fallSpeed/9.0) · 4.2°`, recovering
over 0.42 s with one 12% overshoot.

If `settings.headBob === false`: keep breathing and micro-tremor at 60%, kill footstep sway and
impact. Accessibility must not kill the soul.

### 9.3 Depth of field policy

DOF is **on**, subtle, never a bokeh showcase.

| Mode | Focus | Aperture (equiv.) | CoC max |
|---|---|---|---|
| Idle / walk | Autofocus on centre ray, 0.35 s lag, clamped `[2 m, 60 m]` | f/2.8 | 6 px @1080p |
| Holding a part (`build:pickup`) | Locked to the held part (≈0.42 m) | f/1.8 | 14 px @1080p — the background genuinely melts |
| **Seating rack (§7.4)** | Joint (0.42 m) → next target, **1.4 s lag**, `easeInOutSine` | f/1.8 → f/2.8 | 14 → 6 px |
| Blueprint open | Locked to the paper plane | f/2.0 | 12 px, and the 3D world behind gets an additional 8 px gaussian |
| Sprinting | Focus pushes to 25 m | f/5.6 | 3 px |
| **Being watched (§9.5)** | **Unchanged from whatever mode is active.** The lens does not know | — | — |

Near-field DOF only ever affects the lantern arm and held parts. Far-field maxes at 6 px so the
forest never turns to soup. Bokeh: **6-blade, slightly polygonal, 2% cat's-eye occlusion at frame
edge.** Off at `low`, half-res at `medium`, full at `high`+.

### 9.4 The frame in three states

- **Idle:** a still camera in a moving world. Trees sway, mist drifts, rain falls, the frame breathes
  at 0.24 Hz. Composition: heavy vertical trunks entering frame left and right, a dark centre, one
  small warm light far away. **Negative space is the subject.**
- **Sprinting:** FOV 78°, DOF pushed back, motion blur at full strength, sway ×1.7, the lantern
  swinging hard enough to throw light around. The frame is unreliable. Branches whip into near
  field. Vignette tightens 15%.
- **Building:** camera drops to 1.24 m, FOV 68°, near-field DOF at f/1.8, the lantern clipped to a
  stake sidelighting the joint at 30° raking. Hands enter from the bottom third. **The frame becomes
  a workbench** — quiet, precise — and the world behind it is a black void with distant torches
  sweeping. Stillness plus threat.

### 9.5 DETECTION — expressed entirely through the world (revision 2 fix)

Revision 1 specified, on `player:spotted`: exposure to 0.72, FOV snapping to 82° over 0.15 s, +35%
chromatic aberration transient, a `#7a1013` vignette tint, and DOF off. That is the complete,
unmodified 2015-AAA "DETECTED!" stinger stack — five simultaneous lens effects announcing a
game-state change. It is precisely the vocabulary of the game §1 names as our failure condition, and
it violates §1's own law that **the manual is the only photometric event in the game.**

Deleted. All five. Replaced with this, which is both quieter and worse:

| Stage | What changes | What does **not** change |
|---|---|---|
| **`stealth:noticed`** (a torch has stopped) | The camper's cone stops sweeping and **holds** (§8.7). Nothing else in the entire frame changes | Exposure, FOV, DOF, CA, vignette, grain, grade, camera behaviour |
| **`stealth:searching`** (cone rotating toward him) | The cone's **volumetric shaft becomes the brightest thing in frame** simply by pointing at the camera — no boost, just geometry. His lantern **gutters and drops to 0.10 over 0.12 s** because he instinctively hoods it (§3.2). The frame gets *darker*, not brighter | Everything else |
| **`stealth:tracked`** (beam within 6° of him) | **His mist wake becomes visible.** The 0.9 m displacement trough he has been leaving in the ground mist (§5.2) is suddenly back-lit by the beam, and it is a line pointing directly at him. This is the game's most frightening image and it is *entirely diegetic* | Everything else |
| **`stealth:seen`** | The camper's torch arm stabilises fully, her gait stops (§8.7), and she says one word. The froxel volume carries her breath plume forward at 2.4× rate | Everything else |

**Why this is better, stated so it cannot be re-litigated:**

1. It is *readable*. The old stack told the player "a state changed." The new one tells them
   *which camper, from which direction, and how much time they have* — three facts, in pictures.
2. It preserves §1. The one photometric event in this game is a bright piece of paper. If getting
   spotted is also a photometric event, the manual stops being special and the thesis is dead.
3. It is scarier. The lantern hooding means **the player loses their light at the exact moment they
   most want it**, and they lose it because their own character did it without asking. A lens effect
   happens to the camera. This happens to *him*.
4. It is free. Zero post-process cost, versus five animated uniform ramps and a CA transient.

The **only** permitted feedback outside the world is audio: his breathing rate goes 0.24 → 0.55 Hz
(which is already in §9.2 as an existing layer) and the score does nothing, because there is no
score.

---

## 10. MOTION & TEMPORAL CONTRACT

Revision 1 demanded TAA (8-frame), object motion blur (12 taps), alpha-to-coverage foliage, and
per-blade wind phase offsets — with **no velocity buffer specified anywhere in the document.**
Object motion vectors require MRT velocity output with previous-frame model matrices for every
instanced tree *and a previous-frame evaluation of the wind function in every vertex shader*. Worse,
alpha-to-coverage requires MSAA render targets, which fights the depth pre-pass (A2C needs `EQUAL`
depth to be correct) and complicates resolving into an MRT post chain. Without any of it, TAA
ghost-trails every fern and every rain streak — producing exactly the cheap smear that revision 1's
own trap list claimed TAA was *fixing*.

**Revision 2 chooses path (b) and specs it in full: stochastic alpha dither + TAA + a real velocity
buffer. No MSAA anywhere in the pipeline.**

### 10.1 Why (b) and not (a)

Path (a) — A2C + MSAA + SMAA, delete TAA and object motion blur — is a legitimate engine. We reject
it for three reasons, stated so this is not revisited on a whim:

1. **MSAA render targets cost us the entire post chain's simplicity.** Every pass would need a
   resolve, and our froxel composite, GTAO, SSCS and SSR all read depth — which under MSAA means
   either resolving depth (wrong) or per-sample shading (unaffordable).
2. **Rain.** 1 400 velocity-aligned streak quads per frame, sub-pixel wide, is a temporal problem,
   not a spatial one. SMAA cannot fix a streak that strobes between frames; TAA can.
3. **Our image lives in the bottom 5% of the range.** TAA's temporal accumulation is worth roughly
   1.5 stops of effective shadow noise reduction on the SSCS and GTAO, which we cannot buy any other
   way at this budget.

### 10.2 The velocity buffer

| Property | Spec |
|---|---|
| Format | **`RG16F`**, full-res, MRT attachment 1 of the main opaque pass (attachment 0 = HDR `RGBA16F`, attachment 2 = packed normal+roughness `RGBA8`) |
| Encoding | NDC-space delta `(p_curr.xy/p_curr.w − p_prev.xy/p_prev.w) * 0.5`, un-jittered on both frames |
| Clear | `(0,0)`. Sky writes camera-only velocity from the depth-1 reprojection |
| Cost | **0.31 ms** (bandwidth: 1920×1080×4 B extra write) |

Every shader that displaces a vertex **must** produce `p_prev` with the *previous frame's* value of
every displacing input. Enumerated exhaustively — if it moves, it is on this list:

| Displacer | Prev-frame input required | Where it comes from |
|---|---|---|
| Camera | `uPrevViewProj` | `Postprocessing.js` global |
| Instanced trees | `uPrevInstanceMatrix` — **not stored per instance.** Trees are static, so `prevModel = model` and the only motion is wind | — |
| **Wind (trunk + branch + blade)** | `uPrevWind` (vec4: dir.xy, strength, time), and the wind function evaluated **twice** in the vertex shader | `Materials.globalUniforms`, double-buffered |
| Skinned campers | `uPrevBoneMatrices` — a second 56-matrix UBO, double-buffered | `Humanoid.js` |
| Rain streaks | Streaks are ballistic; `p_prev = p − v·dt` analytically. **No storage** | — |
| Held part / hands | `uPrevHandMatrix` | `Player.js` |
| Mist billboards (`low`) | `uPrevMistScroll` | `VolumetricFog.js` |

**The wind cost is real and budgeted: evaluating the wind function twice doubles it from 0.19 ms to
0.38 ms** across the forest's vertex load. That is the price of not ghosting, and it is stated here
so nobody discovers it in week nine. The prev-frame uniform block is a single UBO,
`PrevFrameUniforms`, bound at slot 3, written once per frame by `Postprocessing.js` before any
draw — never by individual modules.

### 10.3 Alpha: stochastic dither, not alpha-to-coverage

Canopy cards, ferns, hair cards, tarp edges, camper LOD3 billboards.

| Property | Spec |
|---|---|
| Technique | `alphaHash`-style stochastic discard: `if (alpha < blueNoise(gl_FragCoord.xy, frameIndex)) discard;` |
| Noise source | The §12.7 64² blue-noise texture, offset per frame by the Halton(2,3) index — **the same sequence TAA is jittering with**, so the noise and the accumulator are phase-locked and resolve to a clean edge in 4 frames rather than 8 |
| Depth pre-pass | Foliage participates with the **same hash and the same frame index**, so pre-pass and main pass agree exactly. This is why we can keep the `EQUAL` depth test that A2C would have broken |
| Velocity | Foliage writes velocity from the double-evaluated wind. **Non-negotiable** — dithered alpha without velocity is the worst of both worlds |
| Rejection | TAA neighbourhood clamp in YCoCg, 3×3, with a **variance-based** clamp (γ = 1.25) rather than min/max, because min/max over a dithered edge is a no-op |
| Result | Zero crawling on stills, zero shimmer in motion, no MSAA target anywhere, and the depth pre-pass stays exact |

### 10.4 Motion blur

Camera + object, from the §10.2 velocity buffer. Shutter 180° (0.5 frame). 12 taps at `ultra`,
8 at `high`, camera-only at `medium`, off at `low`. Respects `settings.motionBlur`.

**Tile-based max-velocity** (40×40 px tiles, one 3×3 dilation pass) so a fast camper does not smear
the static forest behind them. Velocity is clamped to 0.8× tile size to prevent the classic
"everything melts on a fast turn" — and note that §9.2's 520°/s² turn clamp means our camera
velocity is bounded by design, which is a rare luxury.

<!--CURSOR-->




