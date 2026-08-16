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

<!--CURSOR-->
