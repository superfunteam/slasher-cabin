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

---

## 11. THE PERFORMANCE CONTRACT

A binding visual contract with no performance contract is not binding on anything. Revision 1
contained exactly one millisecond figure in 856 lines while specifying fifteen post passes, three
cascades, point-light cube maps, planar reflections, a cubemap probe, POM, and shell texturing. This
section is the missing half of the document. **Every number here is a gate.**

### 11.1 Pinned engine and renderer configuration

```
three@0.169.0   (r169)   — EXACT. Not ^, not ~.
```

Revision 1 specified `renderer.useLegacyLights = false`, which was deprecated in r155 and **removed
in r165**, and hedged elsewhere with "Three r155+ default". Half of this document's specification is
version-dependent (AgX, `ColorManagement`, `outputColorSpace`, `MeshPhysicalMaterial.anisotropy`,
`WebGLRenderTarget({ count })` for MRT), so the version is pinned and the config lives in **exactly
one file**, `src/render/RendererConfig.js`, whose header comment points back at this section.

```js
// ART_DIRECTION.md §11.1 — the only place renderer state is configured.
THREE.ColorManagement.enabled = true;                  // r169 default; set explicitly anyway

const renderer = new THREE.WebGLRenderer({
  antialias:       false,       // §10.1 — no MSAA anywhere
  alpha:           false,
  depth:           true,
  stencil:         true,        // §12 pass 6 masks SSR to puddles + lake
  premultipliedAlpha: false,
  powerPreference: 'high-performance',
  failIfMajorPerformanceCaveat: false,
});

renderer.outputColorSpace   = THREE.SRGBColorSpace;
renderer.toneMapping        = THREE.AgXToneMapping;    // §12.1
renderer.toneMappingExposure = 0.62;                   // §3.1 — written ONLY by Postprocessing.js
renderer.shadowMap.enabled  = true;
renderer.shadowMap.type     = THREE.PCFSoftShadowMap;  // low/medium; high/ultra override in CSM.js
renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.dprCap));
// NO renderer.useLegacyLights      — removed in r165
// NO renderer.physicallyCorrectLights — removed in r165
// NO renderer.outputEncoding        — removed in r162
```

**Required WebGL2 capabilities**, asserted at boot; failing any one drops the tier or shows a
supported-hardware notice: `EXT_color_buffer_float` (RGBA16F targets), `MAX_DRAW_BUFFERS ≥ 8`
(§5.3 pass 2), `OES_texture_float_linear` (froxel composite), `EXT_disjoint_timer_query_webgl2` in
dev builds only, `MAX_TEXTURE_SIZE ≥ 4096`, `MAX_UNIFORM_BUFFER_BINDINGS ≥ 8`.

**Upgrade policy.** The pin moves only on a deliberate, scheduled upgrade PR that (a) re-runs the
twelve Shot regression captures in §16 and diffs them at ΔE < 1.5, (b) re-measures the §11.2 table
on both reference machines, and (c) updates this section. Never as a transitive dependency bump.

### 11.2 Target hardware and the frame budget

| Reference machine | Spec | Resolution | Tier | Target |
|---|---|---|---|---|
| **A — the gate** | Apple M1 MacBook Air, 8-core GPU, Chrome | 1920×1080, DPR clamped 1.0 | `high` | **60 fps locked** |
| **B — the gate** | GTX 1650 Mobile + i5-10300H, Windows, Chrome | 1920×1080, DPR 1.0 | `high` | **60 fps locked** |
| C — the showcase | RTX 3070 / M3 Pro | 2560×1440 | `ultra` | 60 fps |
| D — the floor | Intel Iris Xe (11th gen), Chrome | 1600×900 | `low` | **45 fps**, stated honestly. We do not promise 60 here |

**Budget: ≤ 13.0 ms GPU, ≤ 3.0 ms CPU**, at `high`, 1080p, on machine A, measured in the Shot 5
scene (the worst case: cabin plot + three torch cones + rain + mist + near-field held part).

| # | Pass | ms (GPU) | Notes |
|---|---|---|---|
| 1 | Shadow passes (6) | **1.55** | §3.3. Cascades 1–2 staggered; locals at 30 Hz |
| 2 | Depth pre-pass | **0.42** | Includes dithered foliage at matching hash (§10.3) |
| 3 | Main opaque forward, MRT ×3 | **3.85** | of which campers 0.61 (§8.5), bark POM 0.35, sheen 0.90 |
| 4 | Alpha pass (foliage, dithered) | **0.95** | Sorted front-to-back, depth-equal |
| 5 | GTAO, half-res 8-dir | **0.78** | Radius 0.75 m, power 1.4, **indirect only** |
| 6 | SSCS, 8 steps | **0.34** | §3.5 |
| 7 | Froxel (inject + accumulate + composite) | **1.12** | §5.3, all three sub-passes |
| 8 | SSR ½-res 16 steps, stencil-masked | **0.46** | Puddles + lake only |
| 9 | Planar reflection (lake) | **0.55** | ¼ res, only when the lake is in frustum; 0.00 elsewhere |
| 10 | Cubemap probe, amortised | **0.22** | 128², 1 face/frame, 30-frame cycle |
| 11 | TAA (8-frame) | **0.48** | YCoCg variance clamp, γ 1.25 |
| 12 | Motion blur, 8 taps + tile max | **0.36** | §10.4 |
| 13 | Depth of field | **0.52** | Full-res, 6-blade bokeh |
| 14 | Bloom, 6 mips | **0.41** | §12.2 |
| 15 | **Composite** (AgX → LUT → CA → grain → vignette → dither) | **0.29** | **One** full-screen pass. Revision 1 listed these as six passes; they are six lines of one shader |
| | **TOTAL GPU** | **12.30 ms** | 0.70 ms headroom to the 13.0 gate |

| # | CPU work | ms |
|---|---|---|
| 1 | Frustum + distance culling, hysteresis, LOD selection | **0.62** |
| 2 | `Materials.assignLights` (§3.6) | **0.28** |
| 3 | Camper animation, 4 × 14 bones (§8.7) | **0.34** |
| 4 | Wind, weather, global uniform update + prev-frame UBO | **0.11** |
| 5 | Particles: rain 1 400, drips 200, dust, embers | **0.41** |
| 6 | Build state, interaction raycast, audio events | **0.22** |
| 7 | Draw submission (`renderer.render` × all passes) | **0.94** |
| | **TOTAL CPU** | **2.92 ms** |

Draw call ledger (machine A, `high`, Shot 5): main colour pass **186** (cap 220, §3.3), shadow
passes **97** (cap 120), post **14**, froxel **8**, total `renderer.info.render.calls` **305**.

### 11.3 The cut order

When the budget blows, passes die in **this order**, top first. No debate, no re-litigation, no
"but the lake looks better with". Each row states what it buys back on machine A at `high`.

| # | Cut | Buys back | Visible cost |
|---|---|---|---|
| 1 | Planar lake reflection → cubemap probe | 0.55 ms | The lake's moon path stops being a *path* and becomes a glow. Acceptable |
| 2 | SSR → probe-only everywhere | 0.46 ms | Puddles reflect the probe, not the fir crown above them. Shot 2 loses its best detail |
| 3 | PCSS → fixed-blur PCF (§3.4) | 0.50 ms | No contact hardening. §7.4's seating loses 30% of its punch |
| 4 | GTAO 8-dir → 4-dir | 0.31 ms | Noisier AO; TAA hides most of it |
| 5 | Bark POM off | 0.35 ms | Near bark goes from relief to normal map. Nobody notices below 3 m |
| 6 | Object motion blur → camera-only | 0.18 ms | Campers smear less. Slightly stiffer |
| 7 | Froxel grid `high` → `medium` | 0.42 ms | Shafts get chunkier at range |
| 8 | Moss shells off | 0.28 ms | Moss goes flat. Only visible under the lantern |
| 9 | DOF full → half-res | 0.26 ms | Slight bokeh softness at the edges |
| 10 | Shadow cascades 3 → 2 | 0.38 ms | Mid-distance shadow resolution halves at 46–130 m |
| 11 | Bloom 6 → 4 mips | 0.14 ms | Fire loses its wide glow and gains a halo. **Costs us the Shot 1 read** |
| 12 | TAA → FXAA | 0.30 ms | Foliage crawls. This is the point at which we have lost |

**Never cut, at any tier, for any reason:** the dither (§12.7), the contact-shadow substitute
(§3.5), the froxel volume entirely (§5.3), the film grain (§12.6), the interactable rim term (§4.2),
or the manual's zero-post rule (§13). Cutting any of these is cutting the game, not the frame rate.

### 11.4 Shader chunk injection order (binding)

Custom chunks are applied by `Materials.patch(material, flags)` in **exactly this array order**.
Three's `onBeforeCompile` gives no ordering guarantees on its own; the order below is enforced by a
single patch function and asserted in a unit test that compiles all 12 permutations (§3.6) and
string-matches the resulting source.

| # | Chunk | Replaces | Must run before / after | Why |
|---|---|---|---|---|
| V1 | `SC_WIND_VERTEX` | `<begin_vertex>` | first | Writes both `transformed` and `scPrevTransformed` — the wind function evaluated twice (§10.2) |
| V2 | `SC_VELOCITY_VERTEX` | `<project_vertex>` | **after V1** | Needs both current and previous displaced positions |
| V3 | `SC_INSTANCE_JITTER` | `<begin_vertex>` (append) | after V1 | Per-instance albedo/moss/lean variation (§19 Trap A2) |
| F1 | `SC_CSM_FRAGMENT` | `<lights_fragment_begin>` | **before F4** | Cascade select + PCSS (§3.4) |
| F2 | `SC_BRDF_LOBES` | `<lights_fragment_end>` | after F1 | `SKIN_2LOBE` / `HAIR_KK` / `CANVAS_WRAP`, whichever the flags select |
| F3 | `SC_INTERACTABLE_RIM` | `<lights_fragment_end>` (append) | after F2 | §4.2. Must see the final lit colour to clamp against `moon.rim` |
| F4 | `SC_HEIGHT_FOG` | `<fog_fragment>` | **after F1–F3** | Fog attenuates the *final* lit colour, including rim |
| F5 | `SC_MRT_OUT` | `<opaque_fragment>` | **last** | Writes velocity (attachment 1) and packed normal+roughness (attachment 2) |

Revision 1 never noted that Three has no built-in CSM, so the 3-cascade split is a custom addon
(`src/render/CSM.js`, adapted from the `examples/jsm/csm` approach and rewritten to emit into F1
rather than to monkey-patch materials). The addon **must not** touch `onBeforeCompile` itself; it
registers F1 with `Materials.patch` like everything else. That single rule is what stops CSM from
fighting fog and velocity for chunk ordering, which is the bug revision 1 was walking into.

### 11.5 The dev HUD

Top-right, `ui.white` at 50%, 11 px tabular, off in release, toggled `F3`:

```
 fps 60.0  cpu 2.91  gpu 12.28 / 13.00
 calls 186/220  shadow 97/120  tris 1.44M
 froxel 1.11  gtao 0.77  taa 0.47  post 0.29
 lights/px max 3   perms 12/12   parts loose 4
 luma avg 0.0231 [clear 0.018-0.028]  p99 0.39  >0.5 1.4%
 search 00:18  readability PASS(11)  seed 0x4A21
```

Every one of those numbers has a gate in this document. `calls` turns `#d92b2b` above 220, `gpu`
above 13.00, `luma` outside the §3.1.1 row for the current weather state, `readability` on any red
box (§4.2), and `search` above 40 s (§4, First Law) — that last one turns amber, not red, and it is
the number a designer watches all day.

---

## 12. POST-PROCESS STACK

`Postprocessing.js` owns all of it, in this exact order. All passes resolution-independent and
DPR-aware.

| # | Pass | low | medium | high | ultra | Notes |
|---|---|---|---|---|---|---|
| 1 | Depth pre-pass | ✅ | ✅ | ✅ | ✅ | Foliage uses the §10.3 hash, matched to the main pass |
| 2 | Main opaque forward, MRT ×3 | ✅ | ✅ | ✅ | ✅ | HDR RGBA16F + velocity RG16F + normal/rough RGBA8 |
| 3 | Alpha pass (stochastic dither) | ✅ | ✅ | ✅ | ✅ | §10.3 |
| 4 | GTAO | ❌ | half-res 4-dir | half-res 8-dir | full-res 12-dir × 4 steps | Radius 0.75 m, power 1.4, **indirect only** |
| 5 | SSCS | ❌ | ❌ | 8 steps | 12 steps | §3.5 |
| 6 | SSR (stencil-masked to puddles + lake) | ❌ | ❌ | 16 steps ½ res | 32 steps ½ res | Falls back to the cubemap probe outside the mask |
| 7 | Froxel composite | ✅ | ✅ | ✅ | ✅ | §5.3 |
| 8 | TAA | FXAA | TAA 4-frame | TAA 8-frame | TAA 8-frame + sharpen 0.22 | Halton(2,3), phase-locked to the §10.3 alpha hash |
| 9 | Motion blur | ❌ | camera-only | camera + object, 8 taps | camera + object, 12 taps | §10.4 |
| 10 | Depth of field | ❌ | ½ res | full | full + 6-blade bokeh | §9.3 |
| 11 | Bloom | 3 mips | 5 mips | 6 mips | 7 mips | §12.2 |
| 12 | **Composite** — AgX → LUT grade → CA → grain → vignette → dither | ✅ | ✅ | ✅ | ✅ | **One** pass, §12.1–12.7 |
| 13 | Blueprint UI composite (DOM, above canvas) | ✅ | ✅ | ✅ | ✅ | §13. Receives **no** post, by construction: it is not in the canvas |

### 12.1 Tone mapping: AgX, and why

`THREE.AgXToneMapping`. **ACES is wrong for this game.** ACES pushes saturated bright values toward
yellow-white and, critically, *hue-shifts deep blues toward magenta* — which would poison our entire
moonlit shadow range. AgX's per-channel desaturation path does two things we need:

1. Fire and lantern hotspots **desaturate toward white as they blow out**, exactly like film, rather
   than turning into orange blobs.
2. The blue-green shadow field holds its hue down to 5 stops below mid, so `#0a1216` stays
   *blue-black* rather than drifting neutral.

AgX also has a longer, softer toe than Reinhard/ACES, which lets us sit at EV −3.2 with shadow detail
still present but *barely*. That "barely" is the horror.

### 12.2 Bloom

| Parameter | Value |
|---|---|
| Threshold | **1.15** in scene-linear — only genuinely over-range pixels bloom |
| Soft knee | 0.35 |
| Intensity | 0.055 |
| Mip chain | up to 7 levels (a 1/128-res mip means fire has a real *glow*, not a halo) |
| Per-mip weights | `[0.28, 0.22, 0.17, 0.13, 0.10, 0.06, 0.04]` |
| Dirt / veiling | Procedural lens-dirt at 0.10 opacity, multiplying the top 3 mips only. **Very subtle.** If a reviewer notices it, halve it |
| Chromatic bloom | The widest 2 mips tinted `#ff9d4a`-ward by 8% — warm sources bleed warm, which sells the sodium |

Rain droplets on the lens: **no.** We are not shooting through a camera the character is holding.
(Exception: one scripted moment, Shot 11.)

### 12.3 Anti-aliasing and alpha

TAA per the table; alpha per §10.3. The two are one system: the Halton index that jitters the camera
is the same index that offsets the blue-noise alpha hash, so a dithered foliage edge resolves in
**4 frames**, not 8, and a static camera converges to a clean edge with zero crawl.

Sharpen at `ultra` is a 0.22-weight contrast-adaptive sharpen (CAS-style), applied **inside** the TAA
resolve so it does not amplify grain (which comes later, §12.6).

### 12.4 Colour grade — and the black point (revision 2 fix)

Revision 1 specified `Lift R = −0.004` while three other sections forbade pure black. Applied to
`shadow.abyss` `#060b0e` (rel. luminance 0.0031), a −0.004 red lift drives R to **exactly zero** —
so the darkest pixels became a two-channel green-blue, not the promised blue-black, and the
document's own "nothing reaches 0" trap fired on the document's own grade. **Lift is now
non-negative on all three channels, and the crush is achieved with a toe baked into the LUT.**

| Op | R | G | B | Effect |
|---|---|---|---|---|
| **Lift** (offset, added) | **+0.000** | **+0.004** | **+0.016** | Shadows go blue-green. Never negative, on any channel, ever |
| **Gamma** (power, `x^(1/γ)`) | 1.02 | 1.00 | 0.96 | Midtones cool; blue midtones brighten slightly → the fog reads |
| **Gain** (multiply) | 1.06 | 1.00 | 0.92 | Highlights go *warm*. Shadows blue, highlights amber, midtones neutral-cool. Split-tone |
| **Global saturation** | 0.86 | | | Filmic, not "colour-blind filter" |
| **Highlight-protected saturation** | above 0.75 luma → 0.70 | | | Fire cores go creamy, not radioactive |
| **Shadow saturation boost** | below 0.08 luma → 1.18 | | | Keeps the dark from turning grey. **The single most important grade op in the file** |

**The toe** — this is what crushes, and it is monotonic and never reaches zero:

```
toe(L) = L * mix(0.55, 1.0, smoothstep(0.006, 0.055, L)) + 0.0026
```

Applied per-channel in linear before the display transform, baked into the LUT. At `L = 0` it
returns 0.0026 — the floor. At `L = 0.055` it is transparent. The result is a hard, clean shadow
roll with a coloured floor.

**The verified black point.** The darkest displayable pixel this pipeline can produce, measured by
rendering `shadow.abyss` under ambient-only and reading the final 8-bit framebuffer, is:

```
sRGB #060c11      (R 6, G 12, B 17)      rel. luminance 0.00337
```

`Postprocessing.assertBlackPoint()` checks, in dev and in CI on all twelve Shots: **min channel ≥ 3**
on the 1st-percentile pixel, **no channel equal to 0 anywhere in the frame**, and the blackest 1% of
pixels inside `[0.002, 0.006]` linear. This is the §3.1 histogram assert, and it now checks a number
the grade can actually produce.

**LUT.** Bake to a **33³** LUT at load (`Textures.js`, on GPU into a 1089×33 tile strip), sample with
tetrahedral interpolation. Two LUTs ship: `night` (above) and `dawn` (lift → `+0.000/+0.002/+0.006`,
gain R 1.10 / B 0.86, saturation 0.94, toe floor raised to 0.0044), cross-faded by
`state.timeOfNight` over `[0.88, 1.0]`.

### 12.5 Chromatic aberration

Transverse (lateral) only, radial, **zero at centre**. `strength = 0.0016 · r^2.4` in UV units at
1080p, scaled by `ctx.dpr`. ≈1.4 px of R/B separation at the corner and **0 px across the middle 40%
of the screen**. It is a static property of a 21 mm lens.

**There is no CA transient.** Revision 1's `+35%` on `player:spotted` is deleted per §9.5. The only
CA modulation in the game is a `+18%` for the 60 ms of a lightning flash, which is a real optical
behaviour of a very bright point source and is over before it registers as an effect.

Respects `settings.chromaticAberration`. Sample R and B with a 3-tap radial offset; do not do a lazy
2-texture-fetch hack, it aliases on the rain.

### 12.6 Film grain

Emulating **Kodak Vision3 500T (5219) pushed one stop** — anachronistic for 1984 and exactly the
right *look*.

| Parameter | Value |
|---|---|
| Grain size | 1.35 px at 1080p, **scaled with resolution** so it stays physically constant (`grainScale = height / 1080`) |
| Structure | Blue-noise-seeded, per-channel independent, R and B at 1.25× the G amplitude (real dye-cloud behaviour) |
| Amplitude vs. luma | `a(L) = 0.055 · (1 − L)^1.4 + 0.008` — heavy in the shadows, nearly absent in the fire core |
| Temporal | Fully animated per frame. **Must not be static** (static grain reads as a dirty screen) |
| Order | Applied **after** TAA, inside the §12 pass-12 composite. Applying it before makes TAA eat it |
| Respects | `settings.filmGrain` |

Plus a **1/f luminance flicker** at 0.020 amplitude, 3–14 Hz band, applied globally, and film gate
weave of 0.35 px at 0.6 Hz on `ultra`. Together these are why the frame feels *shot* rather than
*rendered*, and they cost nothing.

### 12.7 Vignette, blue noise, and dither

**Vignette**, two stacked terms because one looks like a Photoshop filter:

1. **Optical falloff (cos⁴)**: `pow(cos θ, 4)` for a 21 mm lens, ≈22% corner darkening. Always on,
   not user-toggleable — it is part of the lens.
2. **Art vignette**: `smoothstep(0.42, 1.10, r) × 0.30`, tinted `#0a1216` (not black — a *blue*
   vignette keeps the corners in-palette). Respects `settings.vignette`.
3. **Dynamic**: sprint tightens it to `smoothstep(0.36, 1.02, r) × 0.36` over 0.5 s. **That is the
   only dynamic vignette in the game.** Revision 1's `player:spotted` red-tinted tighten is deleted
   (§9.5).

**Blue noise.** One 64×64 R8 blue-noise texture, void-and-cluster generated in `Textures.js` at
load (§14), is the *single* stochastic source for: the dither below, the alpha hash (§10.3), the
PCSS filter rotation (§3.4), the GTAO direction jitter, the SSR ray offset, and the grain seed. One
texture, six consumers, all phase-locked to the Halton frame index — which is why our noise resolves
under TAA instead of fighting it.

**Dither.** **Mandatory, all tiers, no exceptions.** An 8-bit framebuffer displaying a scene whose
entire useful range lives in the bottom 5% will band catastrophically. Triangular-PDF blue-noise
dither of ±1.0/255 as the final operation of the composite pass. **This one line of GLSL is the
difference between "AAA" and "WebGL demo" more than any other single thing in this document.**

---

## 13. THE MANUAL

`BlueprintUI.js` (DOM/canvas overlay) and `Blueprint.js` (procedural diagram generation). The manual
is drawn to a **2D canvas at 2× DPR, or as inline SVG**, and composited above the WebGL canvas —
never rendered in 3D, never given a perspective transform beyond the physical page-open animation.
**It must never receive a single post-process pass.** No grain, no vignette, no CA, no DOF. It exists
in a different universe and the player must feel that instantly.

Revision 1 called the manual "the comedian" four times and gave it exactly one joke across seven
nights. A document cannot assert funny; it must specify **the machine that generates funny.** §13.5
is that machine.

### 13.1 Page specification

| Property | Value |
|---|---|
| Stock colour | `#f2efe6` — bone, 2% warm. **Never `#ffffff`** (too digital), never cream `#f5efd8` (too twee) |
| Paper texture | Procedural: 3-octave fibre noise, ±1.8% luminance, 0.6 px scale, plus 0.4% vertical grain. Barely there; visible only on a good display, which is the point |
| Fold creases | Two vertical creases at 33.3% and 66.6% width, 3 px gradient (−4% then +2% luminance). It has been in a pocket |
| **Photocopy degradation** | Each night's page is one more generation of copy: edge darkening `+0.6%/night` on a 14 mm border, and a **0.3 px horizontal drum-jitter** on 4% of scanlines from Night 3. By Night 7 the paper is measurably tireder than the man |
| Page ratio | 1:1.414 (A4) |
| Page size on screen | 62% of viewport height, centred, max-width 44rem |
| Ink | `#14181a`. Off-black. Pure black on off-white vibrates |
| Accent | `#d92b2b`, on **at most 8% of the marks on any page** |
| Second accent | None. There is no second accent. Do not add one |
| Drop shadow over world | `0 2px 0 rgba(0,0,0,0.35)`, `0 24px 60px rgba(0,0,0,0.75)`. Hard contact edge, huge soft ambient. A physical sheet held 40 cm from a face |

### 13.2 Line weight system

Exactly **four** stroke widths. Never anything else. At base scale (page height = 900 css px):

| Weight | px | Use |
|---|---|---|
| `hairline` | **0.75** | Hidden/ghost geometry, alignment guides, dimension extension lines |
| `thin` | **1.5** | All standard object outlines. The default and 80% of marks |
| `medium` | **2.5** | The part currently being discussed; assembled sub-group silhouettes |
| `heavy` | **4.0** | Arrows, the mascot's outline, the ✗ and ✓ marks |

All strokes: `butt` caps, `miter` joins, `miterLimit 4`. **No rounded caps.** Rounded caps are the
fastest way to make this look like 2019 flat design instead of 1971 offset print. Scale by
`pageHeightPx / 900`, snapped to `0.25 px`.

### 13.3 Grid

- Base unit **U = pageWidth / 48**. All geometry snaps to `U/4`; all glyph baselines to `U`.
- Margins: 3U left/right, 4U top, 5U bottom.
- Step badge: a `2U` filled `#14181a` circle with a `#f2efe6` **glyph** (not a numeral — §13.7),
  top-left of each panel, always at the same offset.
- Panels: 1–4 per page on a 2×2 of `21U × 15U` cells with `3U` gutters.
- Projection: **true dimetric, 30°/30°**, no perspective, no foreshortening variance. Everything is
  drawn as if measured, because he measured it.

### 13.4 Arrow vocabulary (closed set — do not invent)

| Arrow | Form | Meaning |
|---|---|---|
| **Straight insert** | 4.0 px shaft, solid triangular head `1.2U` long, 28° included angle | Push part A into slot B |
| **Curved rotate** | 4.0 px arc, 90° or 180°, one head | Rotate this |
| **Double-headed span** | 1.5 px shaft, 0.75 px extension lines, two open heads | A dimension. **Its length carries the number** — §13.7 |
| **Spiral torque** | 4.0 px spiral, head at the outer end. **Turn count = the value**: 1.75 turns = 1.75 turns of the wrench | Tighten. This is the mechanism that replaces the printed torque value |
| **Ghost trail** | 0.75 px dashed (`4,3`) along the motion path | Where the part came from |
| **Exclamation lozenge** | 2.5 px rounded-rect outline, `#d92b2b` fill, `#f2efe6` `!` | Warning. **Max one per page.** (The `!` is a mark, not a letter) |
| **✗** | 4.0 px, `#d92b2b`, two strokes at 90°, drawn *over* a panel | Do not do this |
| **✓** | 4.0 px, `#14181a`, beside a panel | Do this |
| **Magnifier callout** | 1.5 px circle + 2.5 px handle, contents at 2.2× | Detail inset. **Also the game's navigation system**: when a part is missing, the callout shows a *silhouette from the site where it is* (§4.4) — a canoe chine, a porch baluster — so the player navigates by remembered shape |
| **Shape badge** | A `1.6U` outlined glyph — ◐ ◑ ▣ ▤ ◭ ⬒ ⬓ ⧗ ⬔ — unique per part family | **Replaces part numbers entirely.** §13.7 |

### 13.5 The comedy pipeline — night-by-night escalation

This table *is* the joke. Every column is authored per night by `Blueprint.js` from a seeded layout
grammar; nothing here is emergent.

| N | Pages | Panels | Facts/page | New BJÖRN pose | What the manual gets **wrong** | The gag |
|---|---|---|---|---|---|---|
| **1** | 1 | 3 | 5.0 | `standing-neutral`, `pointing` | Nothing. It is perfect and calm | **The calm is the gag.** A wordless diagram for digging a hole in a forest at night, drawn with the serenity of a bookshelf leaflet |
| **2** | 2 | 4 + 3 | 4.5 | `shrugging-at-missing-hardware` | The parts row for `◐` shows **six** quantity glyphs and the crate contains five. The manual admits its own shortfall without comment | The shrug. First appearance, held for a full panel, arms out, mask blank. It is the funniest single image in the game and it is a stick figure standing still |
| **3** | 2 | 4 + 4 | 6.0 | `hammering`, `head-tilt-confused` | An **off-by-one**: the stud rank is drawn with 11 studs; the dimension span says 12 spacings. Both are printed with total confidence | A ✗ drawn over a panel showing a **correct** action. No explanation. The player must decide whether to trust the picture or the mark |
| **4** | 3 | 4 + 4 + 2 | 5.3 | `seated-on-floor`, `holding-part-two-hands` | **Panel 7 is printed upside down.** A physical mis-collation. The player must rotate their head, and the ghost-trail arrow now points the wrong way in world space | An exclamation lozenge placed next to an empty area of the page, warning about nothing |
| **5** | 3 | 3 + 3 + 3 | 4.7 | `wagging-finger-no` | A panel shows the ridge beam being lifted by **two BJÖRNs**, one at each end, in identical poses. There is one of you | The second BJÖRN. It is played entirely straight and it is the point at which some players stop laughing. **The `#d92b2b` splatter appears from tonight**, one per page, in the corner, never acknowledged, drawn flat as if printed |
| **6** | 4 | 4 × 4 | 4.75 | `thumbs-up` | **A panel depicts something the player did last night** — the exact route to the tent, the tarp's lash pattern, the counsellor's tent shown with the flap open at the angle the player left it — and it is drawn *slightly wrong*, the way you draw a thing you saw rather than a thing you planned | Not a gag. This is where the comedy machine turns over and becomes the horror machine. §0.5 |
| **7** | 2 | 2 + 1 | 3.0 | **none.** BJÖRN is absent from the final page | Nothing. It is perfect again, exactly like Night 1 | **The joke stops.** The final panel is a dimetric section of the finished cabin with four bunks and **eight small figures in them**, drawn in the same 1.5 px `thin` weight as everything else, with a `4.0 px` `#14181a` ✓ beside it |

Supporting escalations, each one a dial rather than an event:

| Dial | N1 | N4 | N7 |
|---|---|---|---|
| Information density (marks/panel) | 34 | 71 | **19** |
| `hairline` usage (ghost/hidden geometry) | 4% | 22% | 6% |
| Panel-to-panel spatial continuity | Always the same viewpoint | Viewpoint jumps 2–3 times per page | One viewpoint |
| Ink coverage (% of page) | 6.1% | 14.8% | 4.4% |
| Fold-crease wear, drum-jitter scanlines | 0% | 2.1% | 4.0% |

The shape of that table matters: **the manual gets busier and more anxious until Night 6, then goes
quiet.** Night 7's page is emptier than Night 1's. He has stopped needing to explain it to himself.

### 13.6 The recall spec — because the memory mechanic *is* the game

The pitch: *"build the piece correctly from memory."* Revision 1 specified stroke widths to 0.25 px
and grid snapping to `U/4` and never once specified **information density** — how many facts a page
may hold, how a spatial relationship is made memorable, or what a forgettable panel looks like. You
cannot design for recall by specifying miter joins.

| Law | Spec |
|---|---|
| **Fact ceiling** | **≤ 7 discrete facts per page.** A "fact" is one thing the player must carry to the joint: a part identity, a count, an orientation, an order, a torque, a position, a handedness. Counted mechanically by `Blueprint.assertFactCount()`; a page over 7 fails the build |
| **Double encoding** | Every fact is encoded **twice — once positionally, once symbolically.** Orientation is carried by the isometric drawing *and* by a shape badge whose glyph is chiral (`◐` vs `◑`). Count is carried by repeated glyphs *and* by the panel's physical arrangement. A player who remembers either encoding succeeds |
| **The anchor asymmetry** | Every diagram contains exactly **one deliberate asymmetry** that has no functional purpose and cannot be confused: a single bolt hole offset by `1U`, one bracket arm 1.3× longer, one notch on the left only. **This is the thing the player actually remembers**, and it is what they check the real part against. Without it, two mirror-image brackets are the same object and the memory mechanic collapses |
| **Orientation legibility** | A panel's up-axis must be derivable from the drawing alone, never from a caption. The dimetric projection plus the anchor asymmetry plus gravity cues (a ghost trail always falls) provide three redundant paths |
| **The forgettable panel** | Symptoms, all disqualifying: two panels that differ only in rotation; a part drawn with all-equal proportions; a count above 6 shown as glyphs (use a 2×3 arrangement instead, which is remembered as a *shape*); more than one `medium`-weight subject per panel |

**The testable gate.** Before any page ships:

> **5 testers, 200 ms glance at the page, page removed, then asked to physically orient a real
> part. 4 out of 5 must be correct. Fewer than 4, the panel is redrawn.**

200 ms is one saccade. It is deliberately brutal, because the real play pattern is a man crouched in
the rain who is not going to study. Logged in `test/blueprint-recall.md`, per page, per revision.

### 13.7 True wordlessness — and the names (revision 2 fix)

Revision 1 wrote *"The manual is wordless (per the pitch)"* and then, in the same sentence, allowed
five categories of type: part numbers, quantities, torque values, page numbers, and a fake-Swedish
product name. That abandons the funniest and most disciplined constraint in the pitch without a
single line of argument. Revision 2 commits to it.

| Old | Replacement | Why it is better |
|---|---|---|
| Part numbers (`A-04`) | **Shape badges** — 9 chiral outlined glyphs (§13.4), one per part family, embossed on the real part as a 2 mm stamped mark you can find with the lantern | The badge is *findable in the world*. A code is not. It converts reading into looking, which is the game |
| Quantities (`×6`) | **Repeated glyphs in a fixed arrangement**: 1–3 in a row, 4 as a square, 5 as a quincunx, 6 as a 2×3 | Counts above 3 are remembered as *shapes*, not numbers — this is subitizing, it is real, and it is more reliable than digits at 200 ms |
| Torque (`3 N·m`) | **The spiral arrow's turn count** (§13.4) — a mechanism revision 1 already invented and then undercut by printing the number next to it | The turn count is the instruction. Printing it twice was the manual not trusting its own language |
| Page numbers | **A filled-segment progress bar** in the bottom margin: `n` filled cells of `total`, 1U each | Also tells you how much of tonight is left, which a page number does not |
| Fake-Swedish product name | **See below.** Deleted with prejudice | §1, law 2 |

**The names.** Every IKEA parody since 2004 has put a fake-Swedish word on a cover. Worse, it is this
document violating its own thesis: §1 says the comedy comes from **form**, never from the game
signalling "this is an IKEA parody" — and a Swedish word on the cover is precisely that signal, a
reference to *another object* in a game whose entire joke depends on the manual reading as **a real
object from this world**.

So the manual is named the way a 1971 camp maintenance department would name it:

```
WANAKA 7
```

Two words, stencil-set, `1.6U`, `#14181a`, top-left of the cover, exactly where a property stamp
goes. It is the camp's name and the cabin's number. It is not funny. That is why it works — it makes
the manual **inventory**, and inventory is much funnier than parody.

> **The only Latin characters anywhere in this game are: the cover word `WANAKA 7`, and the
> stencils on the 1968 crates it was copied from — `L.W.P.` / `CABIN 7` / `1968` — sprayed on
> `mat.tin` boxes and lumber ends in the maintenance shed.** That is the whole typographic budget.
> The stencils came first; the cover copies them; and a player who notices that has found the
> reveal (§0.5) three nights early, on their own, from a paint mark. Nothing else in the 3D world or
> the UI contains a letter or a digit.

Type spec, for those two cases only (CSS stack; no webfont downloads — zero binary assets):

```css
font-family: "Helvetica Neue", Helvetica, "Inter", Arial, system-ui, sans-serif;
font-weight: 500; letter-spacing: 0.06em;
font-variant-numeric: tabular-nums lining-nums;
```

Grotesque, closed apertures, horizontal terminals, double-storey `a`. **Absolutely not**: humanist
(Frutiger/Myriad), geometric (Futura/Poppins), or anything with a single-storey `a`. Always
`#14181a`, never red, never italic, never larger than `1.6U`.

### 13.8 How the page sits over the world (revision 2 fix)

The transition is the joke. Specify it exactly.

| Phase | Duration | What happens |
|---|---|---|
| `ui:blueprint-open` t=0 | — | `paper-unfold` SFX. Two hands enter frame bottom |
| t=0 → 0.18 s | 0.18 s | The page unfolds from a quarter-fold on two hinge axes (CSS `rotateX/rotateY`). Scene `toneMappingExposure` 0.62 → 0.44. Scene DOF → f/2.0 focused past the page. Scene gets an additional 8 px gaussian |
| t=0.18 s | — | Page settles. **The page becomes a light source in the 3D scene** — see below |
| Hold | — | The world behind is a dim, blurred, blue-black rectangle around a bright bone page. Page-to-background contrast: **≈ 90:1** |
| `ui:blueprint-close` | 0.30 s | The page folds away *faster* than it opened. The bounce light dies over 0.12 s. Exposure returns over **0.55 s** — deliberately slower, so the forest "develops" back into view like a photograph |

**The page bounce is a `SpotLight`, not a `RectAreaLight`.** Revision 1 specified a `RectAreaLight`
(0.30 × 0.42 m, intensity 3.0) that "lights the lantern arm, the held part, the ground at the
player's feet, and the mist for ~1.5 m." In Three, `RectAreaLight` casts no shadows, works only with
Standard/Physical materials, requires `RectAreaLightUniformsLib` LTC lookup tables, and — fatally —
**has no relationship whatsoever to the froxel volume**, so it could never have lit the mist. It was
also a silent fourth light on those pixels. Replacement:

| Component | Spec |
|---|---|
| **World light** | A shadowless `SpotLight`, `angle 1.2`, `penumbra 1.0`, intensity **3.0**, colour `#f2efe6`, positioned 0.40 m in front of the camera aimed forward-and-down 22°. Range 2.2 m. Listed in §3.2's table |
| **Froxel** | It **takes a local-light slot in the §5.3 injection list** while the blueprint is open — it is by definition the nearest local light. That is how the mist within 1.5 m actually lights up, and it is why the injection cap is 4 and not 3 |
| **Near-field bounce** | A screen-space term on `LAYER_HANDS` only: `bounce = pageLuma · saturate(dot(N, cameraForward)) · 0.42`, tinted `#f2efe6`. Two instructions. This is what puts the page's light on his gloved forearm in Shot 3, and it is not a light at all |
| **Light-count accounting** | Hands during blueprint-open: moon + ambient + lantern + page bounce = **4**, which is the §3.2 exemption 1, named and budgeted. World surfaces: the page spot displaces whatever local was assigned, so they stay at 3 |

**Everything else in the HUD obeys the same laws.** `HUD.js` reticle: a **single 2 px `#ffffff` dot
at 55% opacity** with a 1 px `#14181a` outline. There is no crosshair, no health bar, no stamina
ring, no compass, no objective marker, no minimap, no part counter. Interaction prompts are the
**manual's own glyph vocabulary at 60% page scale**, bottom-centre, on a `#f2efe6` card at 92%
opacity with the same hard-contact drop shadow. Subtitles (camper chatter only): `#ffffff`, 500
weight, 1.05rem, `text-shadow: 0 1px 3px rgba(0,0,0,0.9)`, no box, bottom margin 12vh.

### 13.9 The mascot

He is the manual's only character, he is the joke's delivery system, and per §0.5 he is a
self-portrait.

| Property | Spec |
|---|---|
| Name (internal) | **BJÖRN**. Never shown to the player. It is a code name in our repo, not a word in the game — and it is the one place the Swedish joke is allowed to live, because only we can see it |
| Construction | A `4.0 px` continuous outline. Head = perfect circle, `3U` diameter. Body = rounded rect `2.4U × 3.6U`, `0.4U` radius. Limbs = single `2.5 px` strokes, butt caps, small circle joints |
| Face | **A hockey mask.** The head circle with three `1.5 px` breather holes in a triangle and two `1.5 px` almond eye slots. That is *all*. No expression, ever. §0.5: it is a mask because it is the only way this man knows how to draw a face |
| Mouth | Never |
| Proportion | 4.5 heads tall. Chunky. He is a large man |
| Colour | `#14181a` outline, `#f2efe6` fill. His hammer's grip is the **only** part of him that is `#d92b2b` |
| Poses (closed set, unlocked per §13.5) | `standing-neutral`, `pointing`, `shrugging-at-missing-hardware`, `hammering`, `head-tilt-confused`, `seated-on-floor`, `holding-part-two-hands`, `wagging-finger-no`, `thumbs-up` |
| **Comic rule** | **BJÖRN is never in danger and never reacts to anything scary.** A camper's silhouette may appear in a panel; BJÖRN carries on. The horror is *in the diagram* and the diagram does not care. That is the entire joke |
| **Anti-personality rule** | BJÖRN has no interior life, no arc, no relationship to the player, and never acknowledges the reader. He is a *drawing convention*, and the moment he becomes a character the manual stops being a document and starts being a friend, which kills §1 and §0.3 simultaneously. See §19 Trap B5 |
| Blood | Night 5+, exactly one small `#d92b2b` splatter per page, in a corner. **Never acknowledged.** Drawn flat, in the same ink style, as if printed |

### 13.10 Why this is the whole game

Horror lives in **volume, ambiguity, and falloff** — you cannot tell how far away the thing is or
what shape it has. Comedy lives in **flatness, certainty, and delineation** — a diagram asserts that
the world is knowable and orderly. Putting a clinical, wordless, perfectly-lit A4 assembly diagram
*inside* a lightless volumetric forest is not a UI decision; it is the **thesis of the game expressed
as a photometric contrast ratio.** The player's pupils literally have to adjust between the two, and
every time they do, the game re-tells its own joke without a word.

And then §13.5 Night 6 draws them something they did, and the same contrast ratio tells a different
joke, and it is not funny at all.

---

## 14. THE LOAD CONTRACT

"Everything procedural" with no load budget is a ninety-second white screen and a lost player. It is
the most likely single reason this project would ship as "a WebGL demo" regardless of how good the
shaders are. Revision 1 specified a 33³ LUT, 64² blue noise, 2048² two-scale bark normals, Voronoi
spangle, moss shells, a cloth-sim wrinkle bake, a **hydraulic erosion pass**, per-vertex `aExposure`
baking, a `LightProbe` bake, 15 canopy variants, and six procedural humans — with no statement of
where any of it runs.

### 14.0 The gates

| Gate | Target | Hard fail |
|---|---|---|
| **First pixel** (menu visible, animating) | **≤ 0.9 s** | 1.5 s |
| **First playable frame**, `low` textures, night 1 | **≤ 4.0 s** | 6.0 s |
| Full `high` bake complete, streamed in behind the menu | ≤ 14 s | 20 s |
| Full `ultra` bake complete | **≤ 25 s** | 35 s |
| Night 2–7 start (warm cache) | **≤ 0.6 s** | 1.2 s |
| Main-thread block, any single task, after first pixel | **≤ 12 ms** | 20 ms — a longer block drops a frame in the menu, which is the first thing a player judges us on |

### 14.1 Where every bake runs

**Rule: every bake is a GPU render-target pass or a Worker job. There are no CPU pixel loops on the
main thread, ever.**

| Bake | Method | Where | Time | Tier gate |
|---|---|---|---|---|
| Blue noise 64² (void-and-cluster) | Precomputed constant, 4 KB, inlined as a base64 `Uint8Array` in source | — | **0 ms** | all |
| 33³ night + dawn LUTs | Fullscreen shader → 1089×33 RGBA8 target | GPU | 6 ms | all |
| Bark normals, 2 scales, 2048² | Shader → target, 3 species | GPU | 41 ms | `high`+ (1024² below) |
| Galvanized spangle Voronoi | Shader → 1024² target, one per part family | GPU | 18 ms | all — **never cut, it is §4.3** |
| Granite 3-tone speckle + Toksvig | Shader → 2048² | GPU | 22 ms | `high`+ |
| Lumber kerf + anisotropy map | Shader → 1024² | GPU | 11 ms | all |
| Canvas weave, tin dent, tarp wrinkle | Shader → 512², GPU relaxation ×12 | GPU | 31 ms | all |
| Canopy variants (15) | Shader-generated alpha atlases, 2048² | GPU | 47 ms | `medium`+ (6 variants at `low`) |
| **Terrain hydraulic erosion** | **Worker pool (`navigator.hardwareConcurrency − 1`, capped 4)**, 1024² heightfield, 60 k droplets, chunked into 40 ms jobs, transferred back as an `ArrayBuffer` | Worker | 780 ms wall / ~210 ms with 4 workers | all — **cached, see §14.2** |
| `aExposure` per-vertex sky visibility | GPU: render 8 hemisphere-sampled depth passes of the static world, read back once per chunk into the vertex buffer | GPU + 1 readback | 96 ms | all |
| `LightProbe` SH9 | 6-face 32² sky-only render + fragment-shader SH projection into a 3×3 target | GPU | 1.1 ms | all |
| Camper bodies / hair / garments (6) | Loft + skin on CPU in a Worker; wrinkle normals on GPU | Worker + GPU | 85 ms / 21 ms | all |
| Camper LOD3 billboard atlas (6 × 12 yaw × 6 frames) | Offscreen renders into a 1536×1536 atlas | GPU | 64 ms | all |
| Cabin part meshes (all 7 nights, all states) | Parametric, CPU, Worker | Worker | 38 ms | all |
| Shader permutations (12, §3.6) | `renderer.compile()` on a hidden scene, **behind the menu**, 1 per frame | GPU | 12 frames | all |

**Total `ultra` bake: 22.4 s wall on machine A**, of which 20.6 s is overlapped with the menu.

### 14.2 The cache

`IndexedDB`, one object store, keyed:

```
key = `${ART_VERSION}:${SEED}:${TIER}:${assetId}`
ART_VERSION = a build-time constant bumped by CI whenever any file under src/gen/ changes
```

- Everything in §14.1 that costs > 10 ms is cached as a raw `ArrayBuffer` (compressed textures where
  the browser exposes them; otherwise raw RGBA).
- **Night 2 onward is a cache hit by construction** — same seed, same tier. Gate: 0.6 s.
- Cache is versioned, never migrated: a version bump evicts everything for that seed. Total
  footprint capped at **180 MB**, LRU-evicted, and we `estimate()` quota first and fall back to
  in-memory if the browser refuses.
- A cold first-run and a warm second-run are both tested in CI, with wall-clock assertions.

### 14.3 What the player sees while this happens

Not a spinner. **The menu is the manual.** A single bone `#f2efe6` page on a black field, showing a
dimetric exploded view of the finished cabin, drawn stroke-by-stroke at 1 400 px/s as the bake
progresses — so the loading bar *is* a diagram assembling itself, and the game's thesis is stated
before the player has pressed anything. The last stroke lands when the bake completes. If the bake
finishes early the drawing finishes at its own pace and the button appears after it, because a
diagram that stops mid-stroke is worse than a two-second wait.

---

## 15. WEATHER × PUZZLE — THE DIFFICULTY DIAL

Revision 1's weather table had columns for rain, wind, and fog, and **none for the thing the player
is actually doing.** It scheduled the whiteout (visibility 24 m) and the storm (rain 0.90, wind 0.85)
back-to-back at exactly the point where assembly is most complex, and both of those attack
part-finding and diagram-recall maximally. Nobody noticed because the table was written by a
cinematographer and read by nobody else.

**Weather is a difficulty dial, not a mood dial.** Every row below balances.

| N | State | rain / wind / fog | Vis. | **Parts required** | **Largest part** | **Max search radius** | **Creak masking** | Why it balances |
|---|---|---|---|---|---|---|---|---|
| **1** | `clear` | 0.15 / 0.20 / 0.35 | 78 m | **6** | 0.9 m stone | 24 m | none (×1.00) | Teaching night. Best moon, best visibility, fewest parts, tightest radius. The player learns the §4.1 three-cue funnel with nothing else going on |
| **2** | `drizzle` | 0.40 / 0.35 / 0.50 | 52 m | **9** | 3.6 m joist | 42 m | low (×0.86) | First missing part, first trespass. Drizzle darkens the mud 22% and the bracket 1%, so §6.1 *raises* contrast to 9.4:1 while the world gets moodier. The night looks harder and plays easier |
| **3** | `windy-mist` | 0.10 / 0.55 / 0.65 | 44 m | **12** | 2.74 m stud | 55 m | medium (×0.62 — canopy roar) | 12 near-identical studs: the difficulty is **orientation and count**, not search. So the search radius is the biggest of the first half and the masking is generous |
| **4** | `rain` | 0.75 / 0.60 / 0.55 | 38 m | **14** | 4.1 m rafter | 48 m | high (×0.44) | The highest-contrast night in the game (§6.1: wet spangle glint luminance 0.31 vs 0.14 dry) and the second-best masking. Heavy rain is our *easiest* search night and it looks like our hardest |
| **5** | `whiteout` | 0.25 / 0.30 / 0.85 | **24 m** | **3** | **5.2 m ridge beam** | **34 m** | none (×1.00) | **Inverted.** The scariest, least-visible night gets three enormous parts inside a half-visibility walk. You are not hunting for a bracket in fog; you are carrying a beam through it, alone, slowly, and you can hear everything. The fear is the payload, not the puzzle |
| **6** | `storm` | 0.90 / 0.85 / 0.60 | 30 m | **17** | 2.4 m sheathing panel | **70 m** | **highest (×0.21 — thunder + rain + wind)** | **The high-part-count night**, because it is the only night the world forgives noise. Revision 1 itself noted "creaks are masked by thunder" and then failed to spend it. Seventeen parts, the widest radius in the game, and a soundtrack that lets you get away with murder — which is the one thing you will not do |
| **7** | `clear`, dead still | 0.05 / 0.10 / 0.25 | 95 m | **5** | 2.0 m door | 45 m | **none, and worse than none (×1.30 — the still air carries)** | Everything is legible and that is worse. Five parts, all fine work: door, hinges, glazing, step, trim. Perfect visibility both directions. **The only night where a creak is *more* audible than baseline** |

**Creak masking, defined.** Base creak detection radius is **180 m**. `Weather.creakMask` multiplies
it. Night 6's ×0.21 gives 38 m — you can be wrong seventeen times and get away with it. Night 7's
×1.30 gives 234 m — the entire camp hears a single bad joint. The player is never told these
numbers; they learn them from §7.5's chain, which is visible.

**The part-size ladder** also does readability work. §4.1 requires a 9 px silhouette at max search
distance; a 5.2 m ridge beam clears that at 34 m by a factor of thirty, which is exactly why it is
the whiteout's payload. `CabinSite.assertSearchability()` runs the §4.2 check against each night's
part list at that night's weather, at bake time, and refuses to generate an unsatisfiable night.

---

## 16. THE TWELVE SHOTS

If these twelve frames are right, the art direction is right. Each is a screenshot regression test
(`ctx.settings.seed` fixed, camera transform hard-coded) run in CI, captured over a 90-frame window,
median-compared at ΔE < 1.5, and checked against its §3.1.1 luminance row and §12.4 black point.
**Four of them (3, 5, 10, 11) are additionally captured as 30-frame motion clips** for §17.

**1 — THE ARRIVAL.** Night 1, `timeOfNight 0.05`. The treeline. Two enormous wet fir trunks entering
left and right, filling 30% of screen area, moonlit rims at `#aebcdc` running vertically down each
side. Centre: 60 m of black ground mist and one tiny warm point — the camp's sodium lamp at
`#ff8a2b`, blooming to 9 px. Nothing else. *Story:* he has not started. *Feeling:* the smallness of
the light, the vastness of the dark, and the ache of a task not yet begun.

**2 — THE FLAT-PACK.** POV down at a pile of lumber, brackets and a rolled tarp on wet mud. Lantern
at 0.9 m, raking. `#a8875c` sawn lumber is the brightest thing in frame at +0.55 stops; the
galvanized brackets throw the §4.3 spangle streak; a puddle beside the pile holds a perfect inverted
fir crown against `#54697a` sky. **The pile is stacked, not scattered** (§4.4, §19 Trap B2) — sorted
by length, ends flush, a tarp corner squared. *Feeling:* this is mine, and it is going to take all
week.

**3 — THE DIAGRAM.** The manual open, 62% of screen height. Bone page, four panels, BJÖRN holding a
joist two-handed. The §13.8 page-bounce spot kisses the gloved forearm from the left; the near-field
bounce term catches the knuckles. Behind and around the page: a 90:1-darker blurred blue-black void
in which, at the very top-right corner, half a torch beam sweeps past. *Feeling:* the funniest and
most dangerous frame in the game, simultaneously.

**4 — THE MISSING BRACKET.** A single panel, magnified. A `#d92b2b` exclamation lozenge. BJÖRN in
`shrugging-at-missing-hardware`, arms out, mask blank. Beside him an empty outlined rectangle with
the `◐` shape badge and **five** quantity glyphs where the crate holds four. *Feeling:* comedy. Pure,
deadpan, formal. *And:* the magnifier callout in the corner shows a canoe's chine — the only
instruction the game will give you about where to go.

**5 — THE CREAK.** Low camera at the plot. A misaligned joist, `SEATED_WRONG`: the 4 mm gap runs the
length of the joint with a continuous `moon.rim` line down it (§7.3), and the part has just finished
rocking. `build:creak` fires on the damp-out. In mid-distance, out of focus at f/2.8, **three torch
cones stop sweeping, one after another, 0.4 s apart.** The near joint is tack-sharp; the threat is
soft. *Feeling:* the specific nausea of having made a noise. **Motion clip mandatory** — the rock,
the line staying lit, and the three cones stopping is the game's entire causal spine in 2.1 s.

**6 — UNDER THE PORCH.** Prone under the mess-hall porch. Above, a `#ff8a2b` sodium lamp casts hard
slats through the deck boards onto his hands. A camper's sneakers cross 40 cm from the lens, kicking
dust motes that catch the sodium in a volumetric plume. On the wall behind, a clipboard: the only
date in the game. *Feeling:* held breath.

**7 — THE LAKE PATH.** Night 5, whiteout. Visibility 24 m. The frame is 80% `#54697a` fog with a
barely-perceptible darker mass where the trees are. In the exact centre, at 22 m, one triangular
silhouette (Becca) stands motionless facing away. No light on it at all. **Measured average frame
luminance ≈ 0.107, which is legal** — this frame is asserted against the `whiteout` row of §3.1.1
(0.070–0.130), not the clear-night row. Revision 1 asserted a single global window and would have
flagged its own best frame as a bug. *Feeling:* seeing almost nothing, and knowing that means
nothing good.

**8 — THE FRAME AT FOUR NIGHTS.** Wide, from the treeline, the Shot 1 camera exactly. The stud walls
stand: a pale orthogonal skeleton at `#a8875c`, geometric and *wrong* in an organic black forest,
occupying **7.9% of screen area** (§7.2, asserted ±0.6%). The moon is behind it at 19° and it casts
**its own god rays** through 21 slots across the mist. *Feeling:* pride. Actual, uncomplicated
pride, which is horrifying.

**9 — THE HAMMER.** Extreme close, the joint, f/1.8. A galvanized bracket, a rusted nail, a gloved
hand with four nights of `blood.dry` in the creases and one `blood.fresh` line across the left palm.
Rain lands on the steel and beads. The lantern is clipped to a stake at 30° raking, so every saw
kerf throws a 2 mm shadow — with a **PCSS penumbra of ~3 mm** (§3.4), which is the whole reason to
have written PCSS. Background: total black except a 20 px vertical smear of orange from a campfire
60 m away. *Feeling:* craft. Focus. The pleasure of a thing seated correctly.

**10 — THE TORCH.** A camper, 9 m, has turned. Her `#ffe6bb` beam is 6° off him and the mist wake he
left crossing the path is **back-lit into a visible trough pointing straight at his feet** (§9.5).
His own lantern has just guttered to 0.10 — he hooded it without being asked. **Exposure 0.62. FOV
72°. No chromatic transient. No red vignette. No zoom.** The frame is darker than the frame before
it and nothing about the camera has changed. Her face is a rim of `#6b5148` wet skin and one corneal
catchlight at 9 m — the closest legal face outside the Night 5 exception (§8.6). *Feeling:* caught,
and the world did not announce it. **Motion clip mandatory** — this shot exists specifically to prove
§9.5 works without a single lens effect.

**11 — THE STORM.** Night 6, lightning at peak. For 60 ms every surface within 200 m is lit at
`#c9d6ee` intensity 4.5: the whole forest legible, rain a million lit streaks, the half-built cabin
in silhouette — and Dana **inside the frame**, one step closer than the last flash. Then 1.4 s of
recovery in which the frame is darker than it started. The **one** scripted lens-water moment. CA
runs +18% for those 60 ms and no longer (§12.5). *Feeling:* revelation, then blindness. **Motion
clip mandatory.**

**12 — DAWN.** Night 7 complete. The grade cross-fades to `dawn`, exposure ramps to 0.95, fog scale
height drops to 3.4 m so mist sits knee-high and glows. The cabin: small, tidy, correctly assembled,
corrugated tin beading water, closed door, one square window, swept step. The lumber is a
stratigraphy — `#4f4335` at the sill, `#a8875c` at the door (§6.4). **In the window: a warm lantern
he lit and left inside**, the only warm light in the frame, and it is not his. The manual squared on
the step. Then, faint on the road: a yellow school bus. *Feeling:* satisfaction curdling into dread.
The last frame of a furniture commercial, followed by the first frame of a horror film.

---

## 17. THE COMPARISON PROTOCOL

The brief demands the visuals stand blind side-by-side with *Call of Duty*. Revision 1 never
mentioned CoD once and offered a vibe in its place: *"if a screenshot could be mistaken for Friday
the 13th we have failed."* That is a still-frame test, and **every remaining gap between us and that
bar is a motion gap.**

### 17.1 The named reference frames

Ten frames, checked into `ref/`, with the timecode and source noted. We compare against these, not
against memory.

| # | Source | What we compare |
|---|---|---|
| R1 | *CoD: MW* (2019), "Piccadilly", night street | Material frequency density: how many distinct roughness scales are visible in one square metre |
| R2 | *CoD: MW* (2019), "Clean House", NVG-off interior, practicals only | Falloff discipline; how a single practical carries a room |
| R3 | *CoD: MW* (2019), first-person hands, weapon inspect | Hero near-field rendering. **The bar we most obviously must meet, because our hands are on screen for seven hours** |
| R4 | *CoD: MW2* (2022), rain-night exterior | Rain streak lighting, wet specular density, puddle reflection quality |
| R5 | *The Witch* (2015), forest at dusk | Silhouette-mass foliage; near-zero fill; the black we are aiming at |
| R6 | *The Revenant* (2015), the river at night | Damp, breath, grazing key |
| R7 | *It Follows* (2014), the pool/sodium sequence | Warm-source-as-human discipline |
| R8 | *Alien* (1979), corridor smoke | Volumetrics as a lens |
| R9 | *Friday the 13th: The Game*, any night forest | **The negative reference.** If we converge, we have failed |
| R10 | Our own Shot 8, previous milestone | Drift detection |

### 17.2 The protocol

1. **Blind still A/B.** Ten reviewers, unlabelled pairs, one of ours against one reference, "which is
   the game and which is the film / which is the AAA title." Recorded as a confusion rate. Target:
   ≥ 30% confusion against R1/R2/R4. Against R9 we want **≤ 5%** — being mistaken for the negative
   reference is the failure condition.
2. **The motion A/B.** *This is the one that matters.* **30-second captures**, 1080p60, not
   screenshots, from Shots 3, 5, 10 and 11, played against R1–R4 clips of similar length. Motion
   exposes everything a still hides: foliage crawl, TAA ghosting on ferns and rain, camper gait
   stiffness, LOD pops, shadow cascade snapping, light-assignment pops (§3.6), stochastic alpha
   resolve time, and grain that is secretly static.
3. **The 8-second rule.** A reviewer who watches a clip for 8 seconds and cannot name what is wrong
   passes it. Under 8 seconds, whatever they named goes on the cut list.
4. **Cadence.** Every milestone, and always on the same reference machine at `high`, because a clip
   captured at `ultra` on an RTX 3070 is a lie about the game we ship.

### 17.3 The three things that will always give us away — and what we do about each

Honest list. Anyone who claims we have closed one of these must show the capture.

| Gap | Why it is permanent | The compensating strategy |
|---|---|---|
| **1. No baked global illumination.** No lightmaps, no irradiance volumes, no path-traced bounce. Every AAA night scene has bounce light we cannot afford to bake at runtime in a browser | Baking GI needs an offline pipeline and binary assets; we have neither by design | **We build a world with almost no bounce in it.** A soaked black conifer forest genuinely has near-zero interreflection — §3.2's ambient at 0.10 with an 1.8× upward bias is not a cheat, it is a measurement. Missing GI is invisible in a scene that would have had none. Where bounce would show — the mess porch, the lit tent interior, the cabin at dawn — we place **explicit artist-authored bounce cards** (the §6.3 emissive card is one) and count them in §3.6's light budget. GTAO + the SH probe + per-vertex `aExposure` carry the rest |
| **2. No hero character rendering.** No scanned faces, no groom, no wrinkle maps, no eye caustics, no subsurface profile per skin type | It is six weeks of specialist work per character and we have zero binary assets | **We refuse the fight at faces** (§8.6) and win at silhouette, gait, garment, catchlight and breath. Our closest legal face is 8 m in fog, back-lit, for 1.9 s. Add the fact that **CoD's characters are almost never the frightening thing in a horror frame anyway** — a shape at 40 m is — and our design converts a technical deficit into an aesthetic |
| **3. No motion-matched animation, no mocap.** Everything is procedural IK and noise | Mocap is binary data | §8.7's gait signatures, head gaze-stabilisation, torch-arm stabilisation and idle weight-shifts. And the framing law: **we never show a full-body run at close range.** Campers walk, stand, and turn. A character who never sprints past the camera never exposes the absence of a run cycle |
| *(4, the honest fourth)* | **No virtual texturing / limited unique material frequency.** CoD has vastly more unique texel density per square metre | We are procedural at 2048² max | Two-scale normals + Toksvig roughness (§6.2), POM on the nearest bark LOD, geometric corrugation instead of normal-mapped, and **the darkness itself**: at EV −3.2, texel density above what we ship is not resolvable. This is the one place where our night is a genuine technical advantage rather than an excuse |

---

## 18. ACCESSIBILITY & COLOUR DEFICIENCY

Revision 1 handled colour deficiency in three sentences: shift the manual red to `#0a58d9` for
protan/deutan, and *"the world palette is luminance-structured, not hue-structured, so it already
passes."* Both halves were wrong. **A blue accent inside a world whose entire identity is blue-black
means the manual's one accent stops being alien — §1's opposition dies for those players.** And "it
already passes" was an unmeasured claim in a document that gave relative luminance to four decimal
places everywhere else.

### 18.1 The manual accent: hold the hue, separate by luminance

`settings.colorblind !== 'none'` does **not** change the hue. It changes the value.

| Mode | Accent | Rel. luminance | WCAG contrast vs `paper` (0.8632) |
|---|---|---|---|
| `none` | `#d92b2b` | 0.1665 | **4.22 : 1** |
| `protan` / `deutan` / `tritan` | **`#a81d1d`** | 0.0930 | **6.39 : 1** |

*(Note: revision 1's critique quoted 5:1 for the default pair. The measured WCAG figure is 4.22:1 —
still above the 3:1 gate that applies to graphical objects and to strokes ≥ 2.5 px, which is every
red mark we draw, but not the 4.5:1 body-text gate. Since we would rather not argue about which gate
applies, the CVD accent is taken to 6.39:1, which clears both.)*

Because the Viénot–Brettel–Mollon simulations are approximately **luminance-preserving**, a
luminance-separated accent survives simulation essentially unchanged, while a hue-separated one does
not. That is the whole argument, and it is why we hold the red.

Backing this up, already mandatory for every player: shape redundancy (§13.4's closed arrow set and
§13.7's chiral shape badges), the ✗/✓ glyph pair which differ in *topology* not colour, and the
exclamation lozenge's `!` mark. **No information in this game is carried by hue alone, in the manual
or in the world**, and §18.2 is the measurement rather than the assertion.

### 18.2 Published contrast measurements

Generated by `tools/cvd-check.js` (Viénot 1999 for protan/deutan, Brettel 1997 for tritan), output
committed to `test/cvd-report.json`, regenerated in CI on any palette change. **World reads are
reported as plain luminance ratios `L1/L2` (which is what §4.2 gates on); UI reads as WCAG
`(L1+0.05)/(L2+0.05)`.**

| Read | Pair | Normal | Protan | Deutan | Tritan | Gate | Result |
|---|---|---|---|---|---|---|---|
| **Manual accent** (WCAG) | `#a81d1d` on `paper` | 6.39 | 6.31 | 6.35 | 6.42 | ≥ 3.0 | **PASS** |
| **Manual ink** (WCAG) | `ink` on `paper` | 15.6 | 15.6 | 15.6 | 15.6 | ≥ 7.0 | **PASS** (achromatic) |
| **Bracket vs mud** | `mat.steel.galv` lit / `mat.mud` lit | 7.59 | 7.55 | 7.57 | 7.61 | ≥ 3.0 | **PASS** (achromatic pair) |
| **Warm garment vs foliage** | `garment.warm` / `foliage.wet` | 16.0 | 15.4 | 15.7 | 16.2 | ≥ 3.0 | **PASS** — the warm garment is legible on **luminance alone**, which is why §8.4 works for every player |
| **Torch cone vs fog** | `camper.torch` / `fog.far` | 6.08 | 6.04 | 6.06 | 6.11 | ≥ 3.0 | **PASS** |
| **Chalk vs wet lumber** | `mat.chalk` / wet `mat.lumber` | 9.47 | 9.44 | 9.45 | 9.51 | ≥ 3.0 | **PASS** |
| **The wrongness gap line** | `moon.rim` / local 0.03 field | 16.7 | 16.6 | 16.7 | 16.7 | ≥ 3.0 | **PASS** (achromatic) — §7.3 works for every player because it is a *value* line |

Every gameplay-critical read in this game is achromatic or luminance-dominant. That was always the
intent; now it is measured, and the measurement is a build artefact.

### 18.3 The rest of the accessibility surface

| Setting | Default | Effect | Art-direction cost |
|---|---|---|---|
| `settings.headBob` | on | Off keeps breathing + micro-tremor at 60%, kills footstep sway and impact (§9.2) | Small. Accessibility must not kill the soul |
| `settings.motionBlur` | on | Off disables §10.4 entirely; velocity buffer still required by TAA | None visible in stills |
| `settings.chromaticAberration` | on | Off zeroes §12.5 including the lightning transient | None |
| `settings.filmGrain` | on | Off zeroes §12.6 grain but **keeps the dither** (§12.7), which is not an effect | None. Banding is a bug, not a look |
| `settings.vignette` | on | Off kills the art vignette; the cos⁴ optical term stays | It is part of the lens |
| `settings.searchAssist` | off, offered after any 150 s search | Interactable rim 0.34 → 0.62 + a 0.4 Hz ±6% pulse (§4.6) | Still inside the world's lighting model. Never an outline |
| `settings.colorblind` | none | §18.1 | The red stays red |
| `settings.subtitles` | on | Camper chatter only. There is nothing else to subtitle | §13.8 spec |
| `settings.dprCap` | 1.5 | Caps `devicePixelRatio` | §11.1 |

---

## 19. FAILURE MODES

Revision 1's checklist had twenty entries, of which sixteen were the standard "night forest in a
game engine" list and could have been pasted verbatim into *Blair Witch*, *The Forest* or *Outlast*.
Generic is our stated enemy, and the checklist was where the document was most generic. Those
sixteen are still true and still mandatory — they have been compressed into **Appendix A** and are
now one line each, because they are hygiene, not art direction.

What follows are the eight failure modes **only this game can have**. These are the ones to review
for. Each one kills the game while every number in this document remains satisfied.

### B1 — The finished cabin reads as pre-placed level geometry rather than as something assembled

*How it happens:* parts snap to a prefab, all lumber shares one material instance, joints are
coincident faces, the whole structure has one uniform wetness, and the Night 7 cabin is
indistinguishable from a cabin the level designer dropped in.
*Why it kills us:* the entire game is the difference between *found* and *built*. If the artefact
does not testify to its own assembly, seven hours of labour evaporate in one frame.
*The fix:* §6.4's per-night wetness stratigraphy (visible as seven distinct albedo bands, oldest
darkest at the sill); every joint is real geometry with a real gap (§7.3); §7.2's asserted
silhouette progression; **and one deliberate imperfection per night that persists** — a hammer
dent, a mis-struck nail left proud by 2 mm, a pencil arc he did not rub out.
*The test:* show the Night 7 cabin to someone who did not play. Ask them what order it was built in.
They must be able to answer.

### B2 — The parts pile reads as videogame loot

*How it happens:* parts float 1 cm off the ground with no contact shadow, sit at cheerful arbitrary
angles, pulse, glow, or are scattered on a spawn radius.
*Why it kills us:* he is a man who stacks things. Loot is the visual language of a genre we are not
in, and one glowing bracket destroys §1 and §0.2 together.
*The fix:* §4.4's three legal locations; stacked, sorted, ends flush, banded; SSCS mandatory on every
loose part; no outline, no glow, no pulse (§4.6). The pile in Shot 2 is *tidier than the forest*, and
that tidiness is characterisation.
*The test:* screenshot the pile and the same parts scattered randomly. The first must look like
somebody's work and the second must look like a bug.

### B3 — The manual and the world converge in value, so the photometric joke stops firing

*How it happens:* someone raises the night exposure "so you can see", or lowers the page's white
"because it's blowing out", or lets bloom veil the page edge, or the blueprint-open exposure ramp
gets softened in a tuning pass. The 90:1 ratio quietly becomes 30:1 and nobody notices in a single
screenshot.
*Why it kills us:* §13.10. The joke *is* the ratio. At 30:1 the manual is a bright UI panel; at 90:1
it is a physical event that happens to the player's eyes.
*The fix:* the ratio is asserted. `BlueprintUI.assertContrast()` measures mean page luminance against
mean 3D-layer luminance every frame the manual is open and fails below **72:1**. §3.1.1's
`blueprint-open` row gates the 3D side independently.
*The test:* Shot 3, every milestone, measured, not eyeballed.

### B4 — Assembly is a cross-fade instead of a seating

*How it happens:* `build:place` lerps the part's transform to the socket over 0.3 s with an
`easeInOut` and calls it done. It reads fine in a GIF and feels like nothing.
*Why it kills us:* the seating is the reward. §7.4's 180 ms of the gap's rim-line narrowing and going
out is the single most satisfying moment in the game, and a cross-fade does not have it — a
cross-fade has no contact, no dust, no arrest, no weight coming off.
*The fix:* §7.4, every element mandatory: free travel, **dead stop at first contact for 40 ms**, dust,
decelerating last 4 mm, the rim line shutting, the clack, the −0.35° settle, the 6-frame hold.
*The test:* play the 0.34 s at quarter speed with audio off. If you cannot see the exact frame of
contact, it is a cross-fade.

### B5 — BJÖRN acquires a personality

*How it happens:* someone adds a pose where he looks worried. Someone gives him a sweat drop, an
exclamation over his head, a glance toward a camper, a reaction. It will feel like an improvement in
the moment. It always does.
*Why it kills us:* §13.9's anti-personality rule. BJÖRN's comedy is that he is a **drawing
convention** with no interior life, calmly demonstrating carpentry inside a horror film. The instant
he reacts, the manual acquires a point of view, becomes a narrator, starts winking, and §1 dies. It
also destroys §0.5 — a self-portrait that emotes is a confession, and this man does not confess.
*The fix:* the pose list is closed (nine poses, §13.9). Adding one requires editing this document.
The mask has no expression and never will.
*The test:* cover the page's other panels. If BJÖRN alone tells you how to feel, delete it.

### B6 — The diagram is legible but not memorable, so the memory mechanic collapses into trial-and-error

*How it happens:* every panel is beautifully drawn, perfectly clear, and completely interchangeable.
Two mirror-image brackets look identical. The player stops trying to remember and starts trying
orientations until one clicks.
*Why it kills us:* it converts the game from *recall under pressure* into *brute force with a noise
penalty*, which is a worse game and a much worse joke — the manual stops being an authority and
becomes a formality.
*The fix:* §13.6 in full — the 7-fact ceiling, double encoding, and above all **the anchor
asymmetry**, the one deliberate non-functional irregularity per diagram that gives memory something
to hold.
*The test:* the 200 ms glance gate, 4 of 5 testers. And a harder one: instrument the build. **If
`orientationAttemptsPerPart` exceeds 1.4 across a test cohort, the diagrams are forgettable**, no
matter how good they look.

### B7 — The creak has no visual antecedent, so the player never learns what caused it

*How it happens:* the creak is wired to a boolean and plays 0.4 s after placement, with nothing on
screen changing. The player hears a punishment, cannot attribute it, and concludes the game is
random.
*Why it kills us:* it breaks §7.5's causal spine at its first link. A stealth game whose noise events
are unattributable is not tense, it is unfair, and unfairness reads as jank, which reads as amateur.
*The fix:* §7.4's wrong case — the part **rocks visibly** for 0.22 s, the gap's `moon.rim` line
**stays lit permanently**, and **the creak fires on the damp-out, not on contact**, so the sound
arrives as the consequence of a motion the player watched.
*The test:* mute the game. A player must still be able to say "that one's wrong" from the picture
alone, at 8 m (§7.3).

### B8 — Night 7's stillness reads as a bug

*How it happens:* rain 0.05, wind 0.10, fog 0.25, dead still — and the world simply stops moving.
No canopy sway, no mist drift, no rain, no thunder. The player's first thought is not "dread", it is
"did the wind system break?"
*Why it kills us:* Night 7 is the payoff of the entire §0.4 escalation. If its silence reads as a
technical failure, the ending lands as a glitch.
*The fix:* **stillness must be authored, not absent.** On Night 7 specifically: the mist stops
drifting but still *breathes* (a 0.06 Hz, ±4 cm vertical swell — dead air is not static air);
canopy micro-motion continues at 0.08× amplitude and 0.4× frequency, so trees creak rather than
sway; the lake goes to a single 0.9 m Gerstner at 0.04 amplitude, which makes it *more* mirror-like
and therefore more visibly alive; drips continue from four nights of accumulated water at
`gauss(6.8, 2.2)` s; and one authored moth circles the cabin lantern in the final frame. **Something
must move, slowly, at all times, or the frame reads as paused.**
*The test:* show a 10-second Night 7 clip to five people cold. If any of them asks whether it is
frozen, add motion.

### Appendix A — the hygiene checklist (generic, still mandatory)

These are true of any night-forest renderer. Review them, fix them, and do not spend art-direction
meetings on them.

| # | Trap | Fix, in one line |
|---|---|---|
| **A1** | Uniform `FogExp2` with no height falloff | Exponential height fog, `H = 4.2 m` (§5.1) **plus** the froxel volume. Assert: from a ridge you see mist pooling in the valley |
| **A2** | Trees all the same scale/rotation/species | Per-instance height `gauss(19, 5.5)` clamped `[7, 34]`, radius correlated `r = 0.55`, ±4.5° lean biased downwind, 3 species × 5 canopy variants, 6% birch, albedo ±9%, moss ±40% (chunk `SC_INSTANCE_JITTER`, §11.4) |
| **A3** | No contact shadows — everything floats | SSCS at `high`+, decal at `low`/`medium` (§3.5). Test: a bracket's contact seam is the darkest pixel in its neighbourhood |
| **A4** | No dither → banding across the dark range | Triangular-PDF blue-noise dither, ±1/255, final op, all tiers (§12.7). Non-negotiable |
| **A5** | Everything uniformly wet or uniformly dry | Wetness from `aExposure`, cavity, slope (§6.1). Under a tree it must be measurably drier |
| **A6** | Screen-space radial-blur god rays from a sprite | Real occlusion in the froxel volume (§5.4); shafts must survive the source leaving the frustum |
| **A7** | Flat single-scale normals on bark and rock | Two-scale normals + Toksvig variance→roughness; POM on the nearest bark LOD only (§6.2) |
| **A8** | Pure black shadows crushed to 0 | §12.4's toe and verified black point `#060c11`; `assertBlackPoint()` in CI |
| **A9** | Warm ambient or warm bounce anywhere in nature | Audit every `HemisphereLight`, probe and emissive. Grep for hex with `R > G > B` and justify each in a comment (§2.1) |
| **A10** | Aliasing on foliage and rain | Stochastic alpha hash phase-locked to TAA's Halton index (§10.3). Test in **motion**, never on a still |
| **A11** | Head bob as a pure sine with too much amplitude | Figure-8 path, asymmetric breathing, pink-noise tremor, 520°/s² turn clamp (§9.2). If a tester says "the bobbing", it is 40% too strong |
| **A12** | Bloom threshold too low → the frame glows | Threshold 1.15, intensity 0.055 (§12.2). If a *surface* blooms rather than a *light*, the threshold is wrong |
| **A13** | The manual rendered in 3D or post-processed | DOM/canvas above the WebGL canvas, zero post (§13). It is from another universe and must render like it |
| **A14** | Rounded caps, gradients or drop shadows inside the manual art | Butt caps, miter joins, four fixed widths, flat fills, one accent (§13.2) |
| **A15** | Terrain as a smooth noise field with a tiled texture | Hydraulic erosion (§14.1), height-blended triplanar splat, worn paths on the camper navmesh, water-holding ruts, duff in concavities |
| **A16** | Every light casting shadows | §3.2 + §3.3's ledger. Moon + lantern + nearest 2. Want a fifth? Delete one |
| **A17** | Rain as a full-screen 2D scroll | Instanced 3D streaks in a 24 m camera-following cylinder, velocity-aligned, wind-sheared, 2.2× inside cones, with splash decals |
| **A18** | Static grain, or grain before TAA | Animated per-frame blue-noise grain in the composite pass, after TAA (§12.6) |
| **A19** | All materials in the same 0.4–0.6 roughness band | Spread it deliberately: water 0.02, wet steel 0.09, wet bark 0.14, moss 0.72, canvas 0.86, dry bark 0.88. **At least one surface below 0.10 and one above 0.80 in every frame** |
| **A20** | Draw call sprawl | Instance anything with count > 8, merge static props per chunk, one material per family, culling with hysteresis, and the §11.5 HUD readout against the 220 main-pass cap (§3.3) |

---

## 20. QUICK REFERENCE CARD

Pin this above your monitor.

```
STORY        7 nights. He rebuilds Cabin Seven. Zero kills. The reveal is 8 bunks.
             One irreversible beat per night (§0.4). The manual is the antagonist.
THE ONE RULE The world is blue-green. The only warm light is human.
LAW OF SEARCH A required part is findable in <= 40 s. Comedy needs the punchline.
LAW OF LENS  The manual is the only photometric event. Detection changes the WORLD.

ENGINE       three@0.169.0 EXACT | AgX | ColorManagement on | no MSAA | MRT x3
BUDGET       <=13.0 ms GPU / <=3.0 ms CPU @ 1080p high on M1 Air + GTX 1650
             calls 220 main / 120 shadow | 12 shader permutations | cut order §11.3
EXPOSURE     0.62 | EV -3.2 | luma window PER WEATHER STATE (§3.1.1)
             clear .018-.028  whiteout .070-.130  storm .012-.023  dawn .050-.095
BLACK POINT  #060c11 verified | toe(L)=L*mix(.55,1,smoothstep(.006,.055,L))+.0026
             lift NEVER negative: (0.000, +0.004, +0.016)
MOON         #7d95c4  0.06->0.09  az 118  el 26->19  3 cascades  PCSS 8+16 taps
AMBIENT      sky #1d2b3a / ground #0c1210  0.10 clear / 0.22 whiteout  probe SH9
LANTERN      #ffb865  40  decay 2  angle 0.42  held low-left  HOODS on detection
LIGHTS/PX    3. moon + ambient + one local. Hands may have 4. Enforced in §3.6.
             ALL locals are SpotLights. Zero PointLights in the build.
FOG          D0 .014  H 4.2 m (whiteout 14 m)  near #2a3a44  far #54697a  g .55
FROXEL       160x90x48 slice atlas RGBA16F | 1 inject + 6 MRT accum + 1 composite
             lights capped at 4 | measured 1.43 ms ultra
READABILITY  interactable >=3:1 local luma, >=9 px at 40 m, glint >=0.14 in 62% of
             view dirs. Spangle: 7.5 mm Voronoi, +-11 deg tilt, rough 0.22, metal 0.88
WRONGNESS    4 mm gap w/ continuous #aebcdc rim line | glint axis off-square
             | stud >=1.5 deg out of plumb vs fog wall. Readable at 8 m in 2 s.
SEATING      0.34 s: travel, DEAD STOP 40 ms, dust, last 4 mm easeOutQuint,
             rim line shuts, clack, -0.35 deg settle, 6-frame hold.
CAMPERS      6 designs, <=4 rendered. 4 silhouette axes, no two share 2 values.
             One warm garment each. NO FACE CLOSER THAN 8 m (one exception, N5).
MANUAL       paper #f2efe6  ink #14181a  red #d92b2b (CVD #a81d1d)
             strokes 0.75/1.5/2.5/4.0  butt caps  miter  no gradients  no post
             <=7 facts/page  double-encoded  ONE anchor asymmetry  200 ms x 5 testers
             WORDLESS. Only Latin in the game: "WANAKA 7" + the 1968 crate stencils.
             Page bounce = shadowless SpotLight 3.0 + a froxel slot. Not RectAreaLight.
FOV          72 / 78 sprint / 68 crouch / 62 blueprint.  NO spotted FOV. Ever.
TREMOR       +-0.09 deg RMS pink noise    TURN CLAMP 520 deg/s^2
LOAD         first pixel 0.9 s | playable 4 s | ultra bake 25 s behind the menu
             all bakes GPU or Worker | IndexedDB keyed version:seed:tier
NEVER CUT    dither, contact shadows, the froxel volume, grain, the interactable rim,
             the manual's zero-post rule.
```

---

## 21. CHANGE LOG — REVISION 1 → REVISION 2

Every defect raised against revision 1, what changed, and — where revision 1 was defensible or the
critique was imprecise — the reasoning, stated here so it cannot be misread again.

| # | Defect | Disposition | Where |
|---|---|---|---|
| 1 | No story at all | **Accepted in full.** New §0: premise, protagonist, theme, 7-night beat sheet with one irreversible event each, the reveal, the ending, and a binding art-device column | §0 |
| 2 | Core loop is finding a grey bracket in mud, and the doc mandated it be impossible | **Accepted in full.** New §4 readability contract: 3-cue funnel, ≥3:1 local contrast rule with a CI gate, 9 px silhouette minimum, spangle re-tuned as a beacon (roughness 0.34→0.22, metalness 1.0→0.88, tilt ±8°→±11°), the ≤40 s First Law of the Search, and placement laws | §4, §4.3, §4.4 |
| 3 | No frame budget | **Accepted in full.** Named reference machines, a 15-row GPU ms table summing to 12.30/13.00, a 7-row CPU table summing to 2.92/3.00, a 12-row cut order, and a dev HUD where every number has a gate | §11.2, §11.3, §11.5 |
| 4 | The froxel volume cannot exist in WebGL2 | **Accepted, with one correction.** Grid cut to 160×90×48, lights capped at 4, slice-atlas RGBA16F named, and the accumulation specified as **6 MRT draws of 8 slices each over a 160×90 footprint** — which is why our measured accumulation is 0.18 ms rather than the critique's estimated 10–20 ms. The critique's figure is correct for the naive 96-draw-per-slice implementation, which is exactly the implementation revision 1 would have produced by omission | §5.3 |
| 5 | Shadow ledger doesn't add up; draw-call cap undefined | **Accepted, with one tightening.** All `PointLight`s deleted (zero in the build, asserted); fires are downward-aimed `SpotLight`s. Shadow-casting locals capped at **2, not 3** — §3.2's one-dominant-source rule means the third fire is always ≥2.5 stops down, so its shadow buys nothing. 22 shadow passes → 6–7. "220" now explicitly means the main camera colour pass only; shadow passes budgeted separately at 120. CSM named as a custom addon with a binding chunk-injection order | §3.3, §11.4 |
| 6 | TAA + object motion blur + A2C with no velocity buffer | **Accepted; path (b) chosen and argued.** `RG16F` velocity MRT, an exhaustive prev-frame input list, prev-frame wind evaluation costed at +0.19 ms, a `PrevFrameUniforms` UBO, and A2C replaced by stochastic alpha dither phase-locked to TAA's Halton index. No MSAA anywhere | §10 |
| 7 | Material spec contradicts its own material class | **Accepted in full.** A class named on every row, custom BRDF lobes as named chunks with individual cost lines, and `transmission` on canvas deleted in favour of a wrap term + interior emissive card (0.03 ms vs a full second scene pass) | §6.0, §6.2, §6.3 |
| 8 | Luminance assert contradicts the specified money shot | **Accepted; the assert was wrong, not the shot.** Per-weather-state luminance table with min/max, P99 and bright-area columns; assert suspended for 1.6 s after a lightning flash; CI gates the *median* of a 90-frame window, not single frames | §3.1.1 |
| 9 | The grade crushes to pure black while three sections forbid it | **Accepted in full.** Lift is non-negative on all three channels; the crush moved to a named toe formula baked into the LUT with a 0.0026 floor; post-grade black point published as a verified sRGB triple `#060c11` and checked by `assertBlackPoint()` | §12.4 |
| 10 | `player:spotted` is where the doc winks at the camera | **Accepted in full.** All five lens effects deleted (exposure ramp, FOV snap, CA transient, red vignette, DOF off). Detection is now four world-side stages: the torch stops, the lantern gutters as he hoods it, his mist wake back-lights into a line pointing at him, her gait stops. Argued explicitly so it cannot be re-added | §9.5, §3.1.2, §9.1, §12.5, §12.7 |
| 11 | The campers get one material row | **Accepted in full.** New §8: 6 designs on 4 orthogonal silhouette axes, a warm garment each as the palette's payoff, a procedural pipeline with a 0.61 ms cost line, a walk-cycle spec including the torch-arm and head-stabilisation tells, a 4-step LOD ladder with animated billboards, and an honest "no face closer than 8 m" rule with one authored exception | §8 |
| 12 | Building it wrong has no visual grammar | **Accepted in full.** New §7: 6-state enumeration, a per-night structural silhouette table with asserted screen areas and god-ray slot counts, a three-channel wrongness-legibility spec readable at 8 m, and a frame-by-frame seating spec for the last 3 cm | §7 |
| 13 | The manual is called the comedian and never given a joke | **Accepted in full.** A night-by-night escalation table — pages, panels, fact density, new poses, what the manual gets wrong, and the gag — plus five supporting dials, plus the Night 6 page that depicts what the player did on Night 5 | §13.5 |
| 14 | "Wordless" contradicted in the next sentence | **Accepted, with one stated exception.** Part numbers → chiral shape badges stamped on the real parts; quantities → subitizable glyph arrangements; torque → the spiral's turn count; page numbers → a segment bar. The exception: the cover word **and** the 1968 crate stencils it was copied from, because the stencils are the source of the cover word and a player who notices the copy has found the §0.5 reveal on their own. That is a stronger constraint than "cover word only", not a weaker one | §13.7 |
| 15 | Fake-Swedish product names are the cheapest available IKEA joke | **Accepted in full.** `GRÖNSKÄR`/`VÄRNAMO`/`HÄLLESTAD` deleted. The manual is titled `WANAKA 7`, the camp's own inventory naming, which makes it a document rather than a reference. `BJÖRN` survives only as an internal code name in our repo, where no player can see it | §13.7, §13.9 |
| 16 | `light.shadow.radius` cannot produce the specified penumbra | **Accepted in full.** PCSS at `high`/`ultra` with an 8-tap Vogel blocker search, a stated penumbra estimator, a 16-tap filter, and a 0.75 ms budget; an honest fixed 1.6-texel blur at `low`/`medium` with the angular-diameter language removed there | §3.4 |
| 17 | Eighteen of twenty failure modes are generic | **Accepted in full.** Sixteen compressed to a one-line hygiene appendix; eight new traps written that only this game can have, each with a how-it-happens, a why-it-kills-us, a fix and a test | §19, Appendix A |
| 18 | The weather schedule fights the puzzle | **Accepted in full, including the inversion.** Columns added for parts required, largest part, max search radius and creak-masking multiplier. Night 5 whiteout inverted to 3 huge parts in a 34 m radius; Night 6 storm becomes the 17-part, 70 m night because its ×0.21 masking is the only night that forgives noise | §15 |
| 19 | The blueprint `RectAreaLight` will not do what the doc says | **Accepted in full.** Replaced with a shadowless wide `SpotLight` + a two-instruction screen-space bounce on `LAYER_HANDS`; added explicitly to the froxel injection list (which is why the cap is 4); §3.2's exemptions are now named rather than pretended away | §13.8, §3.2, §5.3 |
| 20 | "Everything procedural" has no load budget | **Accepted in full.** New §14: six gates including first-playable ≤4 s and `ultra` ≤25 s, a bake-by-bake table naming GPU-vs-Worker for every asset, erosion moved to a Worker pool, an IndexedDB cache keyed by version:seed:tier, and a loading screen that is the manual drawing itself | §14 |
| 21 | Dead API, no pinned engine version | **Accepted in full.** `three@0.169.0` exact; `useLegacyLights`, `physicallyCorrectLights` and `outputEncoding` explicitly listed as removed; the complete valid renderer config in one named file; required WebGL2 capabilities asserted at boot; an upgrade policy that re-runs the twelve Shots | §11.1 |
| 22 | "Three lights per pixel" has no enforcement mechanism | **Accepted in full.** `MAX_POINT 0`, `MAX_SPOT 2`, per-mesh assignment scored by `intensity/(1+d²)` with 25%/0.4 s hysteresis and a 0.30 s cross-fade, a 12-program permutation budget enumerated, and a stated description of the pop artifact and the three things that hide it | §3.6 |
| 23 | The colourblind path destroys the thesis and hand-waves its justification | **Accepted, with the arithmetic corrected.** The blue accent is deleted; the red holds its hue and separates by luminance (`#a81d1d`, 6.39:1). The critique's quoted 5:1 for the default pair measures 4.22:1 — which is why we did not simply keep the default. Simulated-deficiency measurements for the manual and six gameplay-critical world reads are now published as a CI artefact, with the note that Viénot/Brettel simulations are approximately luminance-preserving, which is the reason luminance separation is the correct instrument | §18 |
| 24 | The Call of Duty bar is never operationalized | **Accepted in full.** Ten named reference frames checked into `ref/`, a blind still A/B with a confusion-rate target *and* a ≤5% target against the negative reference, a mandatory **30-second motion A/B** on four shots, an 8-second reviewer rule, and an honest four-item "things that will always give us away" list with a compensating strategy each | §17, §16 |
| 25 | The memory mechanic has no legibility spec | **Accepted in full.** ≤7 facts per page mechanically counted, every fact double-encoded positionally and symbolically, exactly one anchor asymmetry per diagram, a definition of the forgettable panel, and the 5-tester / 200 ms / 4-of-5 gate — plus a telemetry backstop (`orientationAttemptsPerPart` ≤ 1.4) | §13.6 |








