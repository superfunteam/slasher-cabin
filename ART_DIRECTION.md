# Slasher Cabin: Some Assembly Required — ART DIRECTION BIBLE

**Status: BINDING.** This document is the visual contract. `ARCHITECTURE.md` is the code contract;
where the two touch (module names, event names, quality tiers, `Materials.globalUniforms`), the
architecture wins on *shape* and this document wins on *value*. Every number below is a default you
implement first and only tune with a screenshot to justify it.

Owners referenced throughout map to `ARCHITECTURE.md` §9: **Render** (`Postprocessing.js`, `Sky.js`,
`VolumetricFog.js`), **Materials** (`Textures.js`, `Materials.js`), **World** (`Terrain.js`,
`Forest.js`, `Props.js`), **Build** (`CabinSite.js`, `Blueprint.js`), **Player**
(`Flashlight.js`, `Player.js`), **UI** (`HUD.js`, `BlueprintUI.js`, `Menu.js`), **Director**
(`Weather.js`, `NightManager.js`).

---

## 1. THE THESIS

**The world is a wet, blue-black photograph taken at f/1.4 in near-darkness, and the only thing in
it with clean edges, flat light, and a printed grid is the instruction manual.** That single
opposition is the entire game rendered in light. Everything outside the manual is *volumetric*:
soaked pine, ground mist that pools in the ruts, a moon that is a key light and not a lamp, air
you can see. Everything inside the manual is *flat*: 1.5 px black line art on bone paper, one red
accent, no gradients, no shadows, no atmosphere at all. When the player raises the diagram
(`ui:blueprint-open`), the frame goes from an EV of roughly −3 to a hard bright card at EV +2 —
their eyes physically adjust, the forest behind it dies to black, and the joke lands as a
*photometric* event rather than a written one. We never wink. The slasher never jokes. The manual
is the comedian, and the manual is a light source.

Reference points, and precisely what we steal from each:

| Reference | What we take | What we explicitly reject |
|---|---|---|
| *It Follows* (Mike Gioulakis) | Sodium-vapor amber as the **only** human-warm source against a cold ambient; wide lenses that leave the frame's edges dangerously empty | Its daylight suburbia; its steady dolly |
| *The Witch* (Jarin Blaschke) | The wet black forest: near-zero fill, foliage that reads as silhouette mass rather than individual leaves, natural-source-only lighting discipline | Its 1.66 framing and candle-only interiors |
| *The Revenant* (Lubezki) | Breath, damp, low sun/moon angle grazing across a textured world; the camera as a body that has weight | Its constant motion — our camera is patient |
| *Sicario* night-vision sequence | The discipline that darkness is *information-poor on purpose*; you look at shapes and guess | Green NV tint. We never go green-screen |
| *Alien* (Cronenweth) | Practical lights inside the frame doing all the work; hard falloff; smoke as a lens | Its industrial teal-orange saturation |
| IKEA assembly leaflet, 1984 print run | Flat 300-dpi-clean line art, wordlessness, absurd calm, the mascot who is never in danger | Any modern flat-design gradient/rounded-corner language |
| *The Shining* (Alcott) | Symmetry and bureaucratic tidiness as menace; a monster who is *organized* | Its warm hotel gold |

If a screenshot could be mistaken for *Friday the 13th: The Game* we have failed by being generic.
If it could be mistaken for a still from *The Witch* with a flat-pack diagram taped in the corner,
we have won.

---

## 2. PALETTE

Authoring rule: all hex values below are **sRGB display values**. Any value fed to a Three.js
color must go through `new THREE.Color().setHex(0x…)` with `THREE.ColorManagement` enabled (Three
r155+ default), i.e. Three converts to linear for you. **Never** hand-write a linear value.
"Stop" is the exposure stop relative to 18% mid-grey — use it to sanity-check that your material
is landing where the bible says it should.

### 2.1 The One Rule

> **The world is blue-green. The only warm light in the world is human.**

Nothing in nature in this game is warm. Not the moon, not the moss, not the rot, not the water,
not the mud, not the blood in shadow. Warmth means a person: a campfire, a sodium lamp on the
mess-hall porch, a kid's flashlight, the player's own lantern. Consequence: **the player's amber
lantern makes the player a person**, and that is the quietest horror joke in the build — the
monster is carrying the only friendly-coloured light in the forest because he needs to read.
Corollary for every agent: if you are about to author a warm-hued material or light and it is not
motivated by human fire/filament, **you are wrong**. Rust is the single legal exception and it is
desaturated to within an inch of its life.

### 2.2 Master swatch table

| Token | Hex | Rel. luminance | Stops from mid | Where it appears | Owner |
|---|---|---|---|---|---|
| `shadow.abyss` | `#060b0e` | 0.0031 | −5.86 | Under canopy, inside cabin frame, tree cores. The true black of the game — we clip *below* this, never at 0. | Postprocessing |
| `shadow.base` | `#0a1216` | 0.0056 | −5.02 | Scene clear colour, unlit ground, `scene.background` at night depth | Sky |
| `shadow.lift` | `#101c22` | 0.0106 | −4.09 | Ambient-only surfaces facing away from moon; the post-grade lift target | Postprocessing |
| `mid.forest` | `#16241f` | 0.0153 | −3.56 | Mid-distance canopy mass, the dominant screen colour by area | Forest |
| `mid.slate` | `#243740` | 0.0348 | −2.37 | Wet granite, moonlit mud, the "readable dark" | Materials |
| `mid.stone` | `#3b464b` | 0.0582 | −1.63 | Directly moonlit rock face, brightest natural diffuse | Materials |
| `moon.key` | `#7d95c4` | 0.2984 | +0.73 | `DirectionalLight` colour — matches `ARCHITECTURE.md` §11 | Sky |
| `moon.rim` | `#aebcdc` | 0.5013 | +1.48 | Wet-edge rim/sheen on silhouettes, foliage backscatter | Materials |
| `moon.spec` | `#d6e0f2` | 0.7402 | +2.04 | Specular highlights on water, wet steel, eyes | Materials |
| `fog.near` | `#2a3a44` | 0.0394 | −2.19 | Froxel scatter colour ≤ 12 m | VolumetricFog |
| `fog.far` | `#54697a` | 0.1339 | −0.43 | Aerial perspective past 45 m; the distance "wall" | VolumetricFog |
| `fog.lit` | `#8fa6bb` | 0.3670 | +1.03 | Fog inside the moon's shaft / god-ray core | VolumetricFog |
| `foliage.wet` | `#131f1a` | 0.0119 | −3.92 | Pine needles, fern, salal — the default state, Nights 1–7 | Forest |
| `foliage.dry` | `#3b4430` | 0.0528 | −1.77 | Only under the canopy shelter and inside the tent flaps | Forest |
| `foliage.dead` | `#4a4433` | 0.0583 | −1.63 | Needle litter, bracken, the duff layer | Terrain |
| `bark.wet` | `#15120f` | 0.0063 | −4.84 | Douglas fir / hemlock trunks, rain-soaked side | Forest |
| `bark.dry` | `#38312a` | 0.0320 | −2.49 | Lee side of trunks, under-canopy trunks | Forest |
| `bark.birch` | `#b9b6a6` | 0.4652 | +1.37 | **Sparingly.** 6% of trees. The only bright natural vertical — use as compositional punctuation | Forest |
| `water.body` | `#0b171c` | 0.0077 | −4.55 | The lake, puddles, wheel ruts | Terrain |
| `water.spec` | `#9fb6cc` | 0.4519 | +1.33 | Ripple highlight, the lake's moon path | Materials |
| `fire.core` | `#ffca7a` | 0.6491 | +1.85 | Campfire centre, blown-out through bloom | Props |
| `fire.mid` | `#ff9d4a` | 0.4587 | +1.35 | Campfire `PointLight` colour — matches `ARCHITECTURE.md` §11 | Props |
| `fire.ember` | `#c9421a` | 0.1639 | −0.14 | Dying coals, sparks past 0.6 s of life | ProceduralSFX/Props |
| `lantern` | `#ffb865` | 0.5648 | +1.65 | Player `SpotLight` colour — matches `ARCHITECTURE.md` §11 | Flashlight |
| `sodium` | `#ff8a2b` | 0.3961 | +1.14 | Mess-hall porch lamp, the only fixed light at camp | Props |
| `camper.torch` | `#ffe6bb` | 0.8144 | +2.18 | Camper flashlight cones (2900 K filament, whiter than ours on purpose) | Campers |
| `blood.fresh` | `#7a1013` | 0.0456 | −1.98 | Wet blood diffuse | Materials |
| `blood.hot` | `#a8161a` | 0.0897 | −1.00 | Blood catching a warm light directly — the only saturated red in 3D | Materials |
| `blood.dry` | `#3a1113` | 0.0135 | −3.74 | Older blood, the axe head, the tarp | Materials |
| `manual.red` | `#d92b2b` | 0.1665 | −0.11 | **UI only.** Arrows, the ✗ mark, the mascot's hammer stripe | BlueprintUI |
| `paper` | `#f2efe6` | 0.8632 | +2.26 | Manual stock. Slightly warm bone — never pure white, never cream | BlueprintUI |
| `ink` | `#14181a` | 0.0088 | −4.36 | Manual line art. Off-black so it doesn't vibrate against paper | BlueprintUI |
| `ui.white` | `#ffffff` | 1.0000 | +2.47 | Reticle dot, subtitle text, nothing else | HUD |

### 2.3 Sub-palettes by material family (albedo authoring targets)

| Token | Hex | Notes |
|---|---|---|
| `mat.skin.wet` | `#6b5148` | Camper faces. Desaturated, never pink |
| `mat.canvas` | `#5c5b46` | Army-surplus tent duck |
| `mat.steel.galv` | `#9aa0a3` | Bracket, hinge, nail head, spirit level |
| `mat.tin` | `#7d8487` | Corrugated roofing panels |
| `mat.rust` | `#7a4526` | The **only** legal warm non-human hue, and only ≤ 8% coverage |
| `mat.lumber` | `#a8875c` | Freshly sawn face. Brightest large surface in the game — this is what makes the cabin *pop* as an object |
| `mat.mud` | `#2a221b` | Track mud, the plot excavation |

### 2.4 Forbidden colours

Purple. Cyan above 60% saturation. Any green with hue in `[100°, 150°]` and saturation > 0.35
(reads as video-game grass). Teal-orange complementary grading (we do blue-vs-amber, which is a
*narrower*, more specific relationship — the amber only ever appears as **point sources and their
falloff**, never as a global grade lift). Pure `#000000` anywhere in the 3D scene.

---

## 3. LIGHTING MODEL

Physical units per `ARCHITECTURE.md` §10. `renderer.useLegacyLights = false`, AgX tone mapping,
`toneMappingExposure` driven exclusively by `Postprocessing.js`. **No other module may write
`toneMappingExposure`.**

### 3.1 Exposure target — "how dark is dark"

We expose for the **wet mud in the moon**, not for the sky and not for the fire.

| Quantity | Value |
|---|---|
| Target scene key | The moonlit-mud diffuse sits at **0.045 relative luminance** post-tonemap (≈ −2 stops from mid-grey) |
| `toneMappingExposure` base | **0.62** |
| Effective EV (100 ISO equivalent) | **EV −3.2** — half a stop above legally-shootable moonlight, i.e. cinema night, not documentary night |
| Blackest 1% of pixels | must land in `[0.002, 0.006]` linear. **Not zero.** A histogram with a spike at 0 is a bug |
| Brightest 0.1% (fire core, lantern hotspot) | allowed to clip AgX at 1.0. This is the *only* legal clipping |
| Average frame luminance, forest at rest | **0.018 – 0.028**. `Postprocessing` should assert this in dev builds |
| Screen area above 0.5 luminance, forest at rest | **< 2%.** If more, the night is too bright |

Exposure is **not** auto-adaptive as a general rule. We ship a *scripted* exposure curve driven by
`night:begin` / `state.timeOfNight` plus three scripted event ramps:

| Trigger | Target exposure | Attack | Release |
|---|---|---|---|
| default | 0.62 | — | — |
| `ui:blueprint-open` | 0.44 | 0.18 s | — |
| `ui:blueprint-close` | 0.62 | — | 0.55 s (slow, so the world "comes back" as night vision returns) |
| `weather:change` with `fog > 0.7` | 0.70 | 4.0 s | 4.0 s |
| Lightning strike (`uLightning` > 0) | 0.62 → 0.30 over 0.06 s, back over 1.4 s | 0.06 s | 1.4 s |
| `player:spotted` with `level > 0.7` | 0.72 | 0.25 s | 1.2 s (the world lurches brighter — panic, not stealth) |
| `state.timeOfNight` 0.85 → 1.0 (dawn) | 0.62 → 0.95 | linear | — |

### 3.2 The three-light discipline

**Any given pixel is lit by at most three things.** This is a hard rule and the primary reason the
frame will read as photographed rather than rendered.

**1 — MOON KEY (`Sky.js`, `DirectionalLight`)**

| Parameter | Value |
|---|---|
| Colour | `#7d95c4` (`moon.key`) — 4100 K with a magenta-minus bias, i.e. *photographic* moonlight, not blue-gel moonlight |
| Intensity | **0.06** at Night 1, ramping to **0.09** by Night 7 (waxing gibbous → full; narrative escalation is a *lighting* escalation) |
| Azimuth | **118°** (from −Z, clockwise looking down). Behind-right of the camp, so the camp reads as a silhouette from the player's default approach |
| Elevation | **26°** at night start, **19°** at `timeOfNight = 1.0`. Low. Low means long shadows and grazing specular, which is where all the perceived detail lives |
| Angular diameter | 0.6° → `light.shadow.radius` tuned so the penumbra at 10 m occluder distance is ~11 cm |
| Shadow map | `settings.tier(512, 1024, 2048, 4096)`, `PCFSoftShadowMap`, 3-cascade manual split at 12 m / 40 m / 120 m on `high`+, single cascade on `low`/`medium` |
| Shadow bias | `-0.0006`, `normalBias 0.035` (tuned for 1 m-scale bark relief; peter-panning here is worse than acne) |
| Casters | Trees (instanced, only within 40 m), the cabin frame, all parts on the ground, campers, props > 0.5 m |
| Fakers | Undergrowth, needle litter, small debris — these get **baked AO in vertex colour** and a contact-shadow blob, never a real shadow |

**2 — SKY AMBIENT BOUNCE (`Sky.js`, `HemisphereLight` + one small `SH9` probe)**

| Parameter | Value |
|---|---|
| Sky colour | `#1d2b3a` |
| Ground colour | `#0c1210` (the forest floor eats light; ground bounce is nearly nothing) |
| Intensity | **0.10** clear / **0.22** overcast+fog (a foggy night is a *brighter, flatter* night — this is physically true and dramatically useful) |
| Directionality | Deliberately over-weighted to the +Y hemisphere by 1.8×. Downward-facing surfaces must go genuinely black |
| Probe | One `LightProbe` baked once per night from `Sky.js`'s render, updated on `weather:change`. Not per-object |

**3 — ONE MOTIVATED WARM SOURCE (per view, per moment)**

This is the discipline that makes the frame cinematic. In any composed shot, exactly **one** warm
source is dominant. The others are present but ≥ 2.5 stops down or occluded.

| Source | Type | Intensity | Distance | Colour | Owner |
|---|---|---|---|---|---|
| Player lantern | `SpotLight`, `decay: 2`, `angle 0.42 rad`, `penumbra 0.55` | **40** | effective 14 m | `#ffb865` | Flashlight |
| Campfire (main) | `PointLight`, `decay: 2` | **22** base + 1/f noise ±18% at 6.5 Hz | 12 m | `#ff9d4a` | Props |
| Campfire (secondary ×2) | `PointLight` | **9** | 7 m | `#ff9d4a` | Props |
| Mess-hall sodium lamp | `SpotLight`, `angle 1.1`, `penumbra 0.9` | **28** | 16 m | `#ff8a2b` | Props |
| Camper flashlight | `SpotLight`, `angle 0.30`, `penumbra 0.30` | **34** | 18 m | `#ffe6bb` | Campers |
| Lightning | `DirectionalLight`, no shadow, 3-flash envelope | **peak 4.5** | ∞ | `#c9d6ee` | Weather |

Only **moon + player lantern + up to 3 campfires** cast shadows (`ARCHITECTURE.md` §10). Camper
flashlights **do not cast shadows** — they cast a *volumetric cone* only. This is deliberate: it
saves 4 shadow maps and, more importantly, the cone is the gameplay-readable thing. If a camper's
beam threw a shadow the player would read the shadow instead of the beam.

**Player lantern rules (hard):**
- The lantern is **held low and left**, at `(-0.34, -0.22, -0.45)` in camera space, angled 8° down
  and 4° left. It is a *carried object*, not a headlamp. Everything it lights has a bottom-up
  shadow direction, which is the single most horror-coded lighting fact in the frame.
- It has a **hot inner core at 0.42 rad and a long weak spill to 0.95 rad at 6% intensity** (a
  second, cheap, shadowless `SpotLight` — the "spill light"). Real lanterns leak.
- It **flickers** on a 1/f noise at 0.9 Hz, ±7%, plus a hard 40 ms dropout with 0.4% per-second
  probability. Not a strobe. A pressure lamp fighting damp.
- Occluding it (crouch, hand-over) drops it to **0.10 intensity over 0.12 s** — this is a gameplay
  verb that is also a compositional one.

### 3.3 What casts, what fakes — the full ledger

| Object class | Real shadow | Contact shadow | AO source |
|---|---|---|---|
| Trees (< 40 m) | ✅ moon only | ✅ SSCS | vertex AO at trunk base |
| Trees (> 40 m) | ❌ | ❌ | baked vertex AO |
| Undergrowth / fern | ❌ | ❌ | vertex AO gradient, dark at root |
| Cabin frame + placed parts | ✅ moon + lantern + fire | ✅ SSCS | GTAO |
| Loose parts on ground | ✅ moon + lantern | ✅ SSCS **mandatory** | GTAO |
| Campers | ✅ moon + fire | ✅ SSCS | GTAO |
| Rocks / stumps | ✅ moon | ✅ SSCS | vertex AO |
| Tents | ✅ moon + fire | ✅ | vertex AO |
| Rain / particles | ❌ | ❌ | — |
| Ground mist | ❌ | ❌ | froxel self-shadow (one 2-tap) |

**Screen-space contact shadows (SSCS)** are non-negotiable at `high`/`ultra`: 8 ray steps, 0.35 m
max trace, 0.02 m thickness, applied per-pixel on the moon and lantern. Without them every
dropped bracket floats and the game reads as a student demo. On `low`/`medium` we substitute a
projected 0.18 m radial darkening decal under every loose part.

---

## 4. FOG & ATMOSPHERE

`VolumetricFog.js` owns a froxel volume; `Sky.js` owns the distance/aerial term. **Both must exist.**
Analytic exponential-height fog alone will read as grey wash (see §10, Trap 1).

### 4.1 Height fog (analytic, applied in every material via `onBeforeCompile`)

```
density(y) = D0 * exp(-(y - y0) / H)
fogFactor  = 1 - exp(-density(y_avg) * distance * scatterScale)
```

| Parameter | Clear | Light rain | Storm | Dawn |
|---|---|---|---|---|
| `D0` (base density, 1/m) | 0.014 | 0.026 | 0.048 | 0.020 |
| `y0` (fog floor, m) | −1.0 | −1.0 | −1.0 | −1.0 |
| `H` (scale height, m) | **4.2** | 5.5 | 8.0 | 3.4 |
| Near colour (`fog.near`) | `#2a3a44` | `#28353d` | `#232d34` | `#3a4a52` |
| Far colour (`fog.far`) | `#54697a` | `#4a5d6c` | `#3d4c58` | `#6d7e88` |
| Inscatter toward moon (HG `g`) | 0.55 | 0.62 | 0.70 | 0.45 |
| Visible range (5% contrast) | 78 m | 46 m | 24 m | 95 m |

The **4.2 m scale height** is the most important number in this section: it puts the fog ceiling at
roughly the player's shoulders when standing on the lake path, and above his head when crouched.
Crouching should *visibly* put you into the mist. That is a stealth mechanic expressed as
atmosphere.

### 4.2 Ground mist (the character)

Not a fog term — a separate, art-directed layer.

- **Domain**: a 2-channel curl-noise flow field, 256×256, tiled at 24 m, scrolling at
  `0.35 m/s` in the wind direction (`Materials.globalUniforms.uWind`).
- **Height**: mist top = `terrainHeight + 0.55 m + 0.35 * noise`. It **follows the terrain**, pools
  in depressions (`+0.9 m` where terrain curvature is concave), and thins on ridges (`×0.3`).
- **Displacement**: the player and campers push it. `uPlayerPos` drives a radial displacement of
  0.9 m radius, 0.4 falloff exponent, recovering over 2.2 s. **The monster leaves a wake in the
  mist.** From behind, a camper who has just walked past has a visible hole in it.
- **Density modulation**: `×1.6` within 8 m of water, `×0.4` under dense canopy (the canopy holds
  heat), `×2.2` in the excavated cabin plot (cold hole in the ground).
- **Render**: 4-slice raymarched billboard at `low`, 24-step froxel march at `ultra`.

### 4.3 Froxel volumetrics

| Setting | low | medium | high | ultra |
|---|---|---|---|---|
| Froxel grid | 80×45×32 | 120×68×48 | 160×90×64 | 192×108×96 |
| Depth distribution | exponential, `k = 4.0`, far = 140 m | same | same | same |
| Temporal reprojection | off | 2-frame | 4-frame | 8-frame (Halton jitter) |
| Lights injected | moon + lantern | + campfires | + all sodium | + camper cones |
| Cost budget | 0.4 ms | 0.8 ms | 1.3 ms | 2.0 ms |

Scattering is **Henyey–Greenstein**, `g` per the table in §4.1, plus a 0.12 isotropic floor so
back-lit fog never goes fully black.

### 4.4 God rays

God rays come from **occlusion of a real light by real geometry** in the froxel volume. Never a
radial-blur screen-space hack (Trap 6).

| Source | When | Strength | Geometry that cuts it |
|---|---|---|---|
| Moon through canopy | Always, strongest at elevation < 22° | 0.35 | Tree canopy alpha-tested cards |
| Moon through the cabin frame | Once the wall studs are up (Night 3+) | 0.55 | The studs themselves — **the player builds their own god rays.** This is the visual reward for progress |
| Camper flashlight | Whenever a beam crosses the player's view | 0.85 | Trunks, mist, rain |
| Player lantern | Always | 0.45 | Everything in front of it |
| Mess-hall sodium | Approaching camp | 0.60 | Tent lines, laundry, the flagpole |
| Lightning | 3 flashes/strike | 1.0 for 60 ms | Everything. This is the money shot |

Rain streaks **inside** a light cone are lit at 2.2× the ambient rain brightness. This is the single
cheapest "expensive" trick in the game: it costs one dot product and makes every cone look like it
cost a million dollars.

### 4.5 Weather schedule (Director owns; `weather:change` payload)

| Night | rain | wind | fog | Notes |
|---|---|---|---|---|
| 1 | 0.15 | 0.20 | 0.35 | Clear, cold, establishing. Best moon |
| 2 | 0.40 | 0.35 | 0.50 | Drizzle begins. Everything darkens 0.3 stop |
| 3 | 0.10 | 0.55 | 0.65 | Wind, no rain. Mist blows in sheets. Trees move |
| 4 | 0.75 | 0.60 | 0.55 | Real rain. Puddle system fully engaged |
| 5 | 0.25 | 0.30 | 0.85 | **Whiteout fog night.** Visibility 24 m. The scariest night |
| 6 | 0.90 | 0.85 | 0.60 | Storm. Lightning every 25–60 s. Creaks are masked by thunder |
| 7 | 0.05 | 0.10 | 0.25 | Dead still. Full moon. Everything is legible and that is worse |

---

## 5. MATERIALS

All authored in `Textures.js` (procedural PBR bakery) and assembled in `Materials.js`. Every entry
below is `MeshStandardMaterial` unless noted. Texture resolution ladder:
`settings.tier(256, 512, 1024, 2048)` for hero surfaces, one tier down for everything else.

### 5.1 The wetness model (read this before authoring anything)

The world is damp on every night. Wetness is a **per-material scalar `W ∈ [0,1]`** driven by
`Materials.globalUniforms.uRain` (accumulating) plus a per-vertex `aExposure` attribute
(0 = sheltered, 1 = open sky), plus a cavity mask from the material's own AO/height map.

Four simultaneous operations. All four, or it does not read:

1. **Darkened albedo.** `albedo *= mix(1.0, 0.62, W * porosity)`. `porosity`: wood 1.0, bark 0.95,
   soil 1.0, moss 0.85, granite 0.55, canvas 0.9, steel 0.05, tin 0.05. Water fills surface
   micro-voids and kills diffuse backscatter — this is the *physical* reason wet things are dark,
   and non-porous things barely darken at all. Get this right and the metal *pops* against the
   wood the instant it rains.
2. **Crushed roughness.** `roughness = mix(roughness, 0.08, W * (1.0 - cavityMask*0.4))`. Wet
   surfaces become mirrors. Not partially — **aggressively**. A wet fir trunk in moonlight has a
   0.10-roughness rim and that rim is 60% of why the shot reads as expensive.
3. **Puddle accumulation in cavities.** Where `cavity > 0.6 && slope < 18°`, lerp toward a flat
   water layer: `roughness → 0.02`, `normal → flat`, `albedo → #0b171c`, `F0 → 0.02`. Puddles
   accumulate over the night: `puddleLevel = smoothstep(0.15, 0.85, rainAccum)`. Wheel ruts,
   footprints, the excavation, the tarp folds, the upturned canoe. **Puddles must reflect** — a
   single 128×128 cubemap probe re-rendered every 30 frames at the camp is enough; the lake gets
   a planar reflection at `high`+.
4. **Grazing-angle sheen.** A Schlick term with `F0 = 0.02` bumped to `0.06` where `W > 0.5`, plus
   an explicit anisotropic sheen lobe on organics (bark, needles, canvas, hair, skin) using the
   Estevez–Kulla sheen BRDF. This is what makes a backlit fern look photographed.

**Drips.** Any surface with `W > 0.7` and a downward-facing edge spawns a drip every
`gauss(3.4, 1.1)` seconds from a pooled particle system. Cost-capped at 200 live drips. Drips are a
2-frame streak sprite plus one ripple decal on landing. They also emit `audio:sfx` at a trivial
volume, which means the world *sounds* wet, which makes it *look* wetter.

### 5.2 Material table

| Surface | Albedo | Roughness | Metalness | Normal ×  | What makes it read as expensive |
|---|---|---|---|---|---|
| **Bark, Douglas fir** | `#38312a` dry → `#15120f` wet | 0.88 → 0.14 wet | 0.0 | 1.6 | Two-scale normal: 4 cm plate relief + 4 mm fissure detail; a **parallax-occlusion** pass on the near LOD only (8 steps). Trunk-space AO in the fissures. Moss mask driven by north-facing normal + trunk-base height |
| **Bark, birch** | `#b9b6a6` | 0.62 | 0.0 | 0.9 | Peeling curl geometry (4 instanced strips per trunk), translucent at the curl edge via a cheap wrap-lighting term. Horizontal lenticel scars as a stochastic decal band |
| **Pine needles (canopy card)** | `#131f1a` | 0.42 wet | 0.0 | 0.7 | Alpha-to-coverage, **not** alpha-test (no crawling edges). Two-sided with wrap lighting `wrap = 0.35`. A `translucency` term so moon behind canopy glows through the card edges |
| **Fern / undergrowth** | `#1a2a22` | 0.35 | 0.0 | 0.8 | Vertex-colour AO gradient root→tip, per-blade phase offset on the wind uniform, and a **specular sheen so strong the fern reads as a silhouette of highlights**, not a green shape |
| **Wet earth / duff** | `#2a221b` | 0.30 | 0.0 | 1.3 | Triplanar with a 3-octave detail normal; puddle mask from curvature; **footprint decals that deform the normal and go glossy** (a print in wet mud fills with water in ~4 s) |
| **Mud (excavation, tracks)** | `#221b15` | 0.16 | 0.0 | 1.8 | Full puddle layer. Tool-mark relief. This is where the player kneels to build — it must survive a 0.4 m camera distance |
| **Moss** | `#1d2b1c` | 0.72 | 0.0 | 0.5 | Shell-texturing: 4 shells, 3 mm total, at `high`+. Subsurface wrap `0.5`. Only on north faces and shaded rock |
| **Granite** | `#3b464b` | 0.55 dry → 0.09 wet | 0.0 | 1.1 | Three-tone speckle (feldspar `#6a7176`, quartz `#8a929a`, biotite `#191d20`) at 2 mm scale; **micro-specular sparkle from a high-frequency normal that survives at 20 m** because we do NOT mip it away — use a normal-variance-to-roughness conversion (Toksvig) |
| **Sawn lumber (fresh)** | `#a8875c` | 0.68 | 0.0 | 1.0 | Saw-kerf micro-grooves as an anisotropic roughness direction along the cut; end-grain gets a separate high-porosity mask so it soaks visibly darker. **The brightest big surface in the game** |
| **Weathered plank** | `#6b6155` | 0.82 | 0.0 | 1.4 | Raised grain relief, checked splits, nail-hole cavities that fill with water |
| **Galvanized bracket** | `#9aa0a3` | 0.34 | **1.0** | 0.6 | **Spangle.** Real galvanizing has a crystalline spangle pattern — a Voronoi cell map driving a ±0.25 roughness variance and a ±8° normal tilt per cell. It is the single most convincing metal detail in existence and nobody does it. Do it |
| **Canvas tent** | `#5c5b46` | 0.86 | 0.0 | 1.1 | Woven normal at 1.2 mm; **translucency is the point** — a lit tent must glow from inside like a paper lantern. Two-sided, `transmission 0.18`, and a seam/grommet decal pass |
| **Corrugated tin** | `#7d8487` | 0.44 | 1.0 | 0.8 | Real corrugation is **geometry**, not a normal map — 24 segments across a panel. Rain runs in the valleys (animated flow map). Dent noise breaks the specular into a broken, wobbling line |
| **Rusted nail / hinge** | `#7a4526` | 0.78 | 0.35 | 1.5 | Rust is a *blend* between the galv material and the rust material driven by a cavity+age mask, with metalness lerping 1.0 → 0.2 as it corrodes. Bloom on the un-rusted head |
| **Wet skin (campers)** | `#6b5148` | 0.36 | 0.0 | 0.4 | Two-lobe specular (0.28 broad + 0.06 tight); Burley subsurface approximated with a 3-band wrap; **wet strands of hair with an anisotropic Kajiya–Kay lobe**. Eyes get a real corneal specular at roughness 0.02 — that catchlight, from a campfire 20 m away, is what makes a camper read as alive |
| **Blood, fresh** | `#7a1013` | 0.10 | 0.0 | 0.9 | Non-Newtonian: a raised meniscus at the edge (normal ridge), a near-mirror interior, and a **subsurface red bleed** so light through a thin film goes `#a8161a`. Volume-preserving flow decal that runs downhill for 6 s then sets |
| **Blood, dried** | `#3a1113` | 0.74 | 0.0 | 1.2 | Cracked-mud normal pattern at 0.8 mm, matte, slightly raised at crack edges |
| **Lake water** | `#0b171c` | 0.02 | 0.0 | — | Gerstner sum (4 waves), `F0 = 0.02`, planar reflection at `high`+; a **shoreline foam/scum line** with soft depth-fade, and rain-ring normal impulses at `uRain` rate |
| **Tarp (blue poly)** | `#2f4550` | 0.28 | 0.0 | 1.3 | Wrinkle normal from a cloth-sim bake; sheen; water pooled in the sags (this is a great puddle showcase) |

### 5.3 The lumber rule

Sawn lumber at `#a8875c` is **+0.55 stops** and the cabin's structural members are the only large
bright mass in the world. That is intentional: as the player builds, **the cabin literally becomes
the brightest thing in the forest.** By Night 6 there is a pale, geometric, orthogonal object
standing in an organic black world. The construction *is* the visual arc. `CabinSite.js` must not
weather the new lumber; each night's new parts are brighter than the previous night's, which have
darkened by `W` accumulation. The building is a stratigraphy of exposure.

---

## 6. COMPOSITION & CAMERA

### 6.1 Lens

| Parameter | Value | Reason |
|---|---|---|
| Vertical FOV (default) | **72°** (matches `settings.fov`) | ≈ 21 mm full-frame horizontal at 16:9. Wide enough that the frame edges are dangerously empty |
| FOV, sprinting | 78°, eased over 0.35 s (`easeOutCubic`) | Speed you feel in the periphery |
| FOV, crouched + still | 68°, eased over 0.9 s | The world *closes in* when you hide |
| FOV, blueprint open | 62°, eased 0.18 s | Focus. Tunnel vision on the diagram |
| FOV, `player:spotted` level > 0.8 | 82° over 0.15 s | A snap-zoom-out. Dolly-zoom flavour without the dolly |
| Near / far | 0.05 / 400 | Near must be tight — the player holds parts at 0.3 m |
| Eye height | 1.70 standing, 1.06 crouched | Per `ARCHITECTURE.md` §2 |
| Aspect handling | Vertical FOV fixed; ultrawide gains horizontal | Never letterbox in gameplay |

### 6.2 The handheld model — "a big, heavy, patient man"

`Player.js` owns this. It composes **four** additive noise layers on the camera's local transform.
Everything is deterministic (`ctx.rand`) so screenshot tests reproduce.

| Layer | Frequency | Amplitude | Applies to | Notes |
|---|---|---|---|---|
| **Breathing** | 0.24 Hz idle, 0.55 Hz exerted | Y ±1.6 cm, pitch ±0.28°, roll ±0.11° | Always | Asymmetric envelope: inhale 38% of cycle, exhale 62%. A slow inhale is unsettling; a sine wave is not |
| **Micro-tremor** | 1/f pink noise, 0.5–9 Hz band | yaw/pitch ±0.09° RMS | Always | This is the whole "handheld" illusion. Without it, the frame is dead. With too much, it's nausea. **±0.09° RMS is the number** |
| **Footstep sway** | = step rate (1.45 Hz walk, 2.35 Hz sprint, 0.85 Hz crouch) | See below | On move | Figure-8, not a sine |
| **Impact** | one-shot | pitch −0.9° spike, 90 ms decay | On each `player:footstep` | Heel strike. Weight |

**Footstep sway (the figure-8):** at step phase `p ∈ [0, 2π)`,
`x = A_x * sin(p)`, `y = A_y * sin(2p)`, `roll = A_r * sin(p + 0.4)`.

| Gait | `A_x` | `A_y` | `A_r` | Step rate |
|---|---|---|---|---|
| Walk | 3.1 cm | 2.2 cm | 0.72° | 1.45 Hz |
| Sprint | 5.4 cm | 4.6 cm | 1.35° | 2.35 Hz |
| Crouch-walk | 1.4 cm | 0.9 cm | 0.30° | 0.85 Hz |
| Carrying a heavy part | ×1.35 on all, and `A_r` biased +0.4° toward the carry shoulder | | | 1.20 Hz |

**Weight expressed as lag, not shake.** The view target lags mouse input through a critically-damped
spring: `ω = 22 rad/s`, `ζ = 1.0` for look; but **turn acceleration is clamped to 520°/s²**. A large
man cannot snap his head around. Sprint adds a further 0.06 s of lag. This one clamp does more for
"you are a heavy monster" than any animation.

**Landing:** vertical impulse maps to a pitch dip of `min(1.0, fallSpeed/9.0) * 4.2°`, recovering
over 0.42 s with one 12% overshoot.

If `settings.headBob === false`, keep breathing and micro-tremor at 60%, kill footstep sway and
impact. Accessibility must not kill the soul.

### 6.3 Depth of field policy

DOF is **on**, but subtle and never a bokeh showcase.

| Mode | Focus | Aperture (f-stop equiv.) | CoC max |
|---|---|---|---|
| Idle / walk | Autofocus on centre ray, 0.35 s lag, clamped `[2 m, 60 m]` | f/2.8 | 6 px @1080p |
| Holding a part (`build:pickup`) | Locked to the held part (≈0.45 m) | f/1.8 | 14 px @1080p — the background genuinely melts |
| Blueprint open | Locked to the paper plane | f/2.0 | 12 px, and the 3D world behind is additionally blurred |
| Sprinting | Focus pushes to 25 m, aperture → f/5.6 | f/5.6 | 3 px |
| Spotted / chase | DOF **off** (aperture f/11) | — | 0 px |

Near-field DOF only ever affects the lantern arm and held parts. Far-field maxes at 6 px so the
forest never turns to soup. Bokeh shape: **6-blade, slightly polygonal, 2% cat's-eye occlusion at
frame edge.** Disabled at `low`, half-res at `medium`, full at `high`+.

### 6.4 The frame in three states

- **Idle:** the player is a still camera in a moving world. Trees sway, mist drifts, rain falls,
  the frame breathes at 0.24 Hz. Composition: heavy vertical trunks entering frame left and right
  at the edges, a dark centre, one small warm light far away. **Negative space is the subject.**
- **Sprinting:** FOV 78°, DOF pushed back, motion blur at full strength, sway at ×1.7, the lantern
  swinging hard enough to throw the light around. The frame is unreliable. Branches whip into near
  field. Vignette tightens by 15%.
- **Building:** the camera drops to 1.24 m (a kneel), FOV 68°, near-field DOF at f/1.8, the lantern
  clipped to a stake so it sidelights the joint at 30° raking angle. Hands enter frame from the
  bottom third. **The frame becomes a workbench**, quiet and precise — and the world behind it is
  a black void with distant flashlights sweeping. Stillness plus threat.

---

## 7. POST-PROCESS STACK

`Postprocessing.js` owns all of this, in this exact order. All passes resolution-independent and
DPR-aware (`ARCHITECTURE.md` §10).

| # | Pass | low | medium | high | ultra | Notes |
|---|---|---|---|---|---|---|
| 1 | Depth pre-pass + GTAO | ❌ | half-res, 4 dir | half-res, 8 dir | full-res, 12 dir × 4 steps | Radius 0.75 m, power 1.4, applied to **indirect only** |
| 2 | SSCS (contact shadows) | ❌ | ❌ | 8 steps | 12 steps | See §3.3 |
| 3 | Froxel volumetric composite | ✅ | ✅ | ✅ | ✅ | See §4.3 |
| 4 | SSR (puddles + lake only, stencil-masked) | ❌ | ❌ | 16 steps ½ res | 32 steps ½ res | Falls back to cubemap probe outside the mask |
| 5 | Temporal AA | FXAA | TAA 4-frame | TAA 8-frame | TAA 8-frame + sharpen 0.22 | Halton(2,3) jitter. **Critical for rain and foliage** |
| 6 | Motion blur | ❌ | camera-only | camera + object | camera + object, 12 taps | Shutter 180° (0.5 frame). Respects `settings.motionBlur` |
| 7 | Depth of field | ❌ | ½ res | full | full + bokeh | See §6.3 |
| 8 | Bloom | 3 mips | 5 mips | 6 mips | 7 mips | See §7.2 |
| 9 | Tone mapping (AgX) | ✅ | ✅ | ✅ | ✅ | See §7.1 |
| 10 | Color grade (lift/gamma/gain + LUT) | ✅ | ✅ | ✅ | ✅ | See §7.3 |
| 11 | Chromatic aberration | ❌ | ✅ | ✅ | ✅ | See §7.4 |
| 12 | Film grain | ✅ | ✅ | ✅ | ✅ | See §7.5 |
| 13 | Vignette + optical falloff | ✅ | ✅ | ✅ | ✅ | See §7.6 |
| 14 | Dither to 8-bit | ✅ | ✅ | ✅ | ✅ | **Mandatory.** See §7.7 |
| 15 | Blueprint UI composite (DOM, above canvas) | ✅ | ✅ | ✅ | ✅ | §8 |

### 7.1 Tone mapping: AgX, and why

`THREE.AgXToneMapping` per `ARCHITECTURE.md` §10. **ACES is wrong for this game.** ACES pushes
saturated bright values toward yellow-white and, critically, *hue-shifts deep blues toward
magenta* — which would poison our entire moonlit shadow range. AgX's per-channel desaturation path
does two things we need:

1. Our fire and lantern hotspots **desaturate toward white as they blow out**, exactly like film,
   instead of turning into orange blobs.
2. The blue-green shadow field holds its hue down to 5 stops below mid, so `#0a1216` stays
   *blue-black* rather than drifting neutral.

AgX also has a longer, softer toe than Reinhard/ACES, which lets us sit at EV −3.2 with the
shadow detail still present but *barely*. That "barely" is the horror.

Set `renderer.toneMappingExposure` only from `Postprocessing`, per §3.1.

### 7.2 Bloom

| Parameter | Value |
|---|---|
| Threshold | **1.15** in tone-mapped-input (scene-linear) space — i.e. only genuinely over-range pixels bloom |
| Soft knee | 0.35 |
| Intensity | 0.055 |
| Mip chain | up to 7 levels (a 1/128-res mip means the fire has a real *glow*, not a halo) |
| Per-mip weights | `[0.28, 0.22, 0.17, 0.13, 0.10, 0.06, 0.04]` |
| Dirt/veiling | A procedural lens-dirt mask at 0.10 opacity, only multiplying the top 3 mips. **Very subtle.** If a reviewer notices the lens dirt, halve it |
| Chromatic bloom | The widest 2 mips are tinted `#ff9d4a`-ward by 8% — warm sources bleed warm, which sells the sodium |

Rain droplets on the lens: **no.** We are not shooting through a camera the character is holding.
Occasional real water on the *lens* breaks the first-person contract. (Exception: a single scripted
moment on Night 6, Shot 11.)

### 7.3 Color grading — lift / gamma / gain

Applied after tone mapping, in display-referred space, per channel. These are the shipping numbers.

| Op | R | G | B | Effect |
|---|---|---|---|---|
| **Lift** (offset, added) | −0.004 | +0.002 | +0.014 | Shadows go blue-green and *below* black, so blacks crush cleanly and the darkest visible tone is `#0a1216`-ish |
| **Gamma** (power, `x^(1/γ)`) | 1.02 | 1.00 | 0.96 | Midtones cool. Blue midtones brighten slightly → the fog reads |
| **Gain** (multiply) | 1.06 | 1.00 | 0.92 | Highlights go *warm*. This is the trick: shadows blue, highlights amber, midtones neutral-cool. Split-tone |
| **Global saturation** | 0.86 | | | Just enough desaturation to feel filmic, not enough to feel "colour-blind filter" |
| **Highlight-protected saturation** | above 0.75 luma, saturation → 0.70 | | | Fire cores go creamy, not radioactive |
| **Shadow saturation boost** | below 0.08 luma, saturation → 1.18 | | | Keeps the dark from turning grey. **This is the single most important grade op in the file** |

Bake to a **33³ LUT** at load (`Textures.js` can generate it) and sample with tetrahedral
interpolation. Two LUTs ship: `night` (above) and `dawn` (lift → neutral, gain R 1.10 / B 0.86,
saturation 0.94), cross-faded by `state.timeOfNight` over `[0.88, 1.0]`.

Colourblind modes (`settings.colorblind`): do not remap the world. Instead, when `!== 'none'`, the
**manual red** shifts to `#d92b2b` → `#0a58d9` (protan/deutan) or `#d94f0a` (tritan), and the
correctness ✓/✗ glyphs gain shape redundancy. The world palette is luminance-structured, not
hue-structured, so it already passes.

### 7.4 Chromatic aberration

Transverse (lateral) only, radial, **zero at centre**. `strength = 0.0016 * r^2.4` in UV units at
1080p, scaled by `ctx.dpr`. That's ~1.4 px of R/B separation at the frame corner and **0 px across
the middle 40% of the screen**. Add a `+35%` transient during `player:spotted` and lightning.
Respects `settings.chromaticAberration`. Sample R and B with a 3-tap radial offset; do not do a
lazy 2-texture-fetch hack, it aliases on the rain.

### 7.5 Film grain

Emulating **Kodak Vision3 500T (5219) pushed one stop** — the actual stock you would shoot this
movie on in 1984's spiritual sense (it's anachronistic; we don't care, it's the right *look*).

| Parameter | Value |
|---|---|
| Grain size | 1.35 px at 1080p, **scaled with resolution so it stays physically constant** (`grainScale = height / 1080`) |
| Structure | Blue-noise-seeded, per-channel independent, R and B at 1.25× the G amplitude (real dye-cloud behaviour) |
| Amplitude vs. luma | `a(L) = 0.055 * (1 - L)^1.4 + 0.008` — heavy in the shadows, nearly absent in the fire core |
| Temporal | Fully animated per frame. **Must not be static** (static grain reads as a dirty screen) |
| Interaction with TAA | Grain is applied **after** TAA. Applying it before makes TAA eat it |
| Respects | `settings.filmGrain` |

There is also a **1/f luminance flicker** at 0.020 amplitude, 3–14 Hz band, applied globally. Film
gate weave: 0.35 px translation at 0.6 Hz on `ultra` only. These two together are why the frame
will feel *shot* rather than *rendered*, and they cost nothing.

### 7.6 Vignette

Two stacked terms, because one looks like a Photoshop filter:

1. **Optical falloff (cos⁴)**: physically-derived, `pow(cos(θ), 4)` for a 21 mm lens, ≈ 22%
   darkening at corners. Always on, not user-toggleable — it is part of the lens.
2. **Art vignette**: `smoothstep(0.42, 1.10, r)` × 0.30 opacity, tinted `#0a1216` (not black —
   a *blue* vignette keeps the corners in-palette). Respects `settings.vignette`.
3. **Dynamic**: on `player:spotted`, the art vignette tightens to `smoothstep(0.28, 0.95, r)` ×
   0.45 over 0.3 s and gains a `#7a1013` tint at 12%. Adrenaline, not a red flash.

### 7.7 Dither

**Mandatory, all tiers, no exceptions.** An 8-bit framebuffer displaying a scene whose entire
useful range lives in the bottom 5% will band catastrophically. Apply triangular-PDF blue-noise
dither of ±1.0/255 as the final operation, seeded per-frame from a 64×64 blue noise texture
generated in `Textures.js`. **This one line of GLSL is the difference between "AAA" and "WebGL
demo" more than any other single thing in this document.**

---

## 8. THE IKEA UI CONTRAST

`BlueprintUI.js` (DOM/canvas overlay) and `Blueprint.js` (procedural diagram generation) own this.
The manual is drawn to a **2D canvas at 2× DPR, or as inline SVG**, and composited above the WebGL
canvas — never rendered in 3D, never given a perspective transform beyond the physical page-open
animation. **It must never receive a single post-process pass.** No grain, no vignette, no CA, no
DOF. It exists in a different universe and the player must feel that instantly.

### 8.1 Page specification

| Property | Value |
|---|---|
| Stock colour | `#f2efe6` — bone, 2% warm. **Never `#ffffff`** (too digital), never cream `#f5efd8` (too twee) |
| Paper texture | Procedural: 3-octave fibre noise, ±1.8% luminance, 0.6 px scale. Plus a subtle 0.4% vertical grain. Barely there; visible only on a good display, which is the point |
| Fold creases | Two vertical creases at 33.3% and 66.6% width, rendered as a 3 px gradient (−4% then +2% luminance). The manual has been folded in a pocket |
| Page ratio | 1:1.414 (A4). It is a European flat-pack manual |
| Page size on screen | 62% of viewport height, centred, max-width 44rem |
| Ink | `#14181a`. Off-black. Pure black on off-white vibrates |
| Accent | `#d92b2b`, used on **at most 8% of the marks on any page** |
| Second accent | None. There is no second accent. Do not add one |
| Drop shadow of page over world | `0 2px 0 rgba(0,0,0,0.35)`, `0 24px 60px rgba(0,0,0,0.75)`. Hard contact edge, huge soft ambient. It is a physical sheet held 40 cm from a face |

### 8.2 Line weight system (the grid of weights)

Everything is drawn at one of exactly **four** stroke widths. Never anything else. At the base
scale (page height = 900 css px):

| Weight | px | Use |
|---|---|---|
| `hairline` | **0.75** | Hidden/ghost geometry, alignment guides, dimension extension lines |
| `thin` | **1.5** | All standard object outlines. **This is the default and 80% of the marks** |
| `medium` | **2.5** | The part currently being discussed; the silhouette of assembled sub-groups |
| `heavy` | **4.0** | Arrows, the mascot's outline, the ✗ and ✓ marks |

All strokes: `butt` caps, `miter` joins, `miterLimit 4`. **No rounded caps.** Rounded caps are the
single fastest way to make this look like 2019 flat design instead of 1984 offset print. Scale all
weights by `pageHeightPx / 900`, snapped to `0.25 px` increments.

### 8.3 Grid

- Base unit **U = pageWidth / 48**.
- All geometry snaps to `U/4`. All type baselines snap to `U`.
- Margins: 3U left/right, 4U top, 5U bottom.
- Step-number badge: a `2U`-diameter filled `#14181a` circle with `#f2efe6` numeral, top-left of
  each panel, always at the same offset.
- Panels: 1–4 per page, laid out on a 2×2 of `21U × 15U` cells with `3U` gutters.
- Isometric projection for all 3D content: **true dimetric, 30°/30°**, no perspective, no
  foreshortening variance. Everything is drawn as if measured.

### 8.4 The mascot

He is the manual's only character and he is the joke's delivery system.

| Property | Spec |
|---|---|
| Name (internal) | **BJÖRN**. Never shown to the player |
| Construction | A `4.0 px` continuous outline. Head = perfect circle, `3U` diameter. Body = a rounded rectangle `2.4U × 3.6U` with `0.4U` corner radius. Limbs = single `2.5 px` strokes with `butt` caps and small circle joints |
| Face | **A hockey mask.** Drawn as the head circle with three `1.5 px` breather holes in a triangle and two `1.5 px` almond eye slots. That is *all*. He has no expression, ever |
| Mouth | Never |
| Proportion | 4.5 heads tall. Chunky. He is a large man |
| Colour | `#14181a` outline, `#f2efe6` fill. His hammer's grip is the **only** part of him that is `#d92b2b` |
| Poses (fixed vocabulary, no others) | `standing-neutral`, `holding-part-two-hands`, `hammering`, `pointing`, `seated-on-floor`, `shrugging-at-missing-hardware`, `head-tilt-confused`, `thumbs-up`, `wagging-finger-no` |
| Comic rule | **BJÖRN is never in danger and never reacts to anything scary.** A camper's silhouette may appear in a panel; BJÖRN carries on. The horror is *in the diagram* and the diagram does not care. That is the entire joke |
| Blood | On Night 5+, exactly one small `#d92b2b` splatter appears on the corner of one panel. It is **never acknowledged**. It is drawn in the same flat ink style as everything else, as if printed |

### 8.5 Arrow vocabulary (closed set — do not invent)

| Arrow | Form | Meaning |
|---|---|---|
| **Straight insert** | 4.0 px shaft, solid triangular head `1.2U` long, 28° included angle | Push part A into slot B |
| **Curved rotate** | 4.0 px arc, 90° or 180°, one head | Rotate this |
| **Double-headed span** | 1.5 px shaft, 0.75 px extension lines, two open heads | A dimension |
| **Spiral torque** | 4.0 px spiral, 1.75 turns, head at the outer end | Tighten to torque. Turns = torque steps |
| **Ghost trail** | 0.75 px dashed (`4,3`), following the motion path | Where the part came from |
| **Exclamation lozenge** | 2.5 px rounded-rect outline, `#d92b2b` fill, `#f2efe6` `!` | Warning. **Max one per page** |
| **✗** | 4.0 px, `#d92b2b`, two strokes crossing at 90°, drawn *over* a panel | Do not do this |
| **✓** | 4.0 px, `#14181a`, drawn beside a panel | Do this |
| **Magnifier callout** | 1.5 px circle + 2.5 px handle, contents at 2.2× | Detail inset |

### 8.6 Typeface

There is **almost no type**. The manual is wordless (per the pitch). Type appears only as:
part numbers (`A-04`), quantities (`×6`), torque values (`3 N·m`), page numbers, and the
sacred fake-Swedish product name on the cover (`GRÖNSKÄR`, `VÄRNAMO`, `HÄLLESTAD`).

Characteristics (we synthesize with a CSS stack; no webfont downloads — zero binary assets):

```css
font-family: "Helvetica Neue", Helvetica, "Inter", "Arial", system-ui, sans-serif;
font-weight: 500; font-stretch: normal;
letter-spacing: 0.01em; font-variant-numeric: tabular-nums lining-nums;
```

Requirements: grotesque, closed apertures, horizontal terminals, a double-storey `a` and `g`,
uniform stroke contrast. **Absolutely not**: humanist (Frutiger/Myriad), geometric
(Futura/Poppins), or anything with a single-storey `a`. Sizes: `0.75U` for part codes,
`1.0U` for quantities, `1.6U` for the cover word, `0.6U` for the page number. Text is **always**
`#14181a`, **never** red, **never** italic, **never** larger than `1.6U`.

### 8.7 How it sits over the 3D world

The transition is the joke. Specify it exactly:

| Phase | Duration | What happens |
|---|---|---|
| `ui:blueprint-open` t=0 | — | A `paper-unfold` SFX. Two hands enter frame bottom |
| t=0 → 0.18 s | 0.18 s | The page unfolds from a quarter-fold with a real 3D-ish CSS `rotateX/rotateY` on two hinge axes. Scene `toneMappingExposure` 0.62 → 0.44. Scene DOF → f/2.0 focused past the page. Scene gets an additional 8 px gaussian |
| t=0.18 s | — | Page settles. **The page becomes a light source in the 3D scene**: `Flashlight.js` receives an event and a `RectAreaLight` (0.30 × 0.42 m, intensity 3.0, colour `#f2efe6`) appears 0.4 m in front of the camera, facing back at the player and forward into the world. It lights the lantern arm, the held part, the ground at the player's feet, and the mist for ~1.5 m |
| Hold | — | The world behind is a dim, blurred, blue-black rectangle around a bright bone page. Contrast ratio between page and background: **≈ 90:1** |
| `ui:blueprint-close` | 0.30 s | Page folds away *faster* than it opened. `RectAreaLight` dies over 0.12 s. Exposure returns over **0.55 s** — deliberately slower, so the forest "develops" back into view like a photograph |

Everything else in the HUD obeys the same laws: `HUD.js` reticle is a **single 2 px `#ffffff` dot
at 55% opacity** with a 1 px `#14181a` outline. There is no crosshair, no health bar, no stamina
ring, no compass, no objective marker, no minimap. Interaction prompts are the **manual's own icon
vocabulary at 60% page scale**, bottom-centre, on a `#f2efe6` card at 92% opacity with the same
hard-contact drop shadow. Subtitles: `#ffffff`, 500 weight, 1.05rem, `text-shadow: 0 1px 3px
rgba(0,0,0,0.9)`, no box, bottom margin 12vh.

### 8.8 Why this is the whole game

Horror lives in **volume, ambiguity, and falloff** — you cannot tell how far away the thing is or
what shape it has. Comedy lives in **flatness, certainty, and delineation** — a diagram asserts
that the world is knowable and orderly. Putting a clinical, wordless, perfectly-lit A4 assembly
diagram *inside* a lightless volumetric forest is not a UI decision, it is the **thesis of the
game expressed as a photometric contrast ratio.** The player's pupils literally have to adjust
between the two, and every time they do, the game re-tells its own joke without a word.

---

## 9. THE 12 SHOTS

If these twelve frames are right, the art direction is right. Each is a screenshot regression test
(`ctx.settings.seed` fixed, camera transform hard-coded) run in CI.

**1 — THE ARRIVAL.** Night 1, `timeOfNight 0.05`. The player stands at the treeline. Frame:
two enormous wet fir trunks entering left and right edges, filling 30% of screen area, their
moonlit rims at `#aebcdc` running vertically down each side. Centre: 60 m of black ground mist,
and one tiny warm point — the camp's sodium lamp at `#ff8a2b`, blooming to 9 px. Nothing else.
*Feeling:* smallness of the light, vastness of the dark. Also: the ache of a task not yet begun.

**2 — THE FLAT-PACK.** The player's POV looking down at a pile of lumber, brackets and a rolled
tarp on wet mud. Lantern at 0.9 m, raking. The `#a8875c` sawn lumber is the brightest thing in
frame at +0.55 stops; the galvanized brackets throw a spangled specular; a puddle beside the pile
holds a perfect inverted reflection of a fir crown against `#54697a` sky. *Feeling:* this is
mine, and it is going to take all week.

**3 — THE DIAGRAM.** The manual open, filling 62% of screen height. Bone page, four panels,
BJÖRN holding a joist with two hands. The RectAreaLight kisses the player's gloved forearm from
the left. Behind and around the page: a 90:1-darker blurred blue-black void in which, at the very
top-right corner, half a flashlight beam sweeps past. *Feeling:* the funniest and most dangerous
frame in the game, simultaneously.

**4 — THE MISSING BRACKET.** A single panel, magnified. A `#d92b2b` exclamation lozenge. BJÖRN
shrugging, `shrugging-at-missing-hardware` pose, arms out, mask blank. Beside him, an empty
outlined rectangle labelled `B-07 ×1` in hairline. *Feeling:* comedy. Pure, deadpan, formal.

**5 — THE CREAK.** Low camera at the cabin plot. A misaligned joist is half-seated. `build:creak`
has just fired. In the mid-distance, out of focus at f/2.8, **three flashlight cones simultaneously
rotate toward the camera**, their volumetric shafts sweeping through mist. The near joint is
tack-sharp; the threat is soft. *Feeling:* the specific nausea of having made a noise.

**6 — UNDER THE PORCH.** The player prone under the mess-hall porch. Above, a `#ff8a2b` sodium lamp
casts hard slats of light through the deck boards onto the player's hands. A camper's sneakers
walk across, 40 cm from the lens, kicking up dust motes that catch the sodium in a volumetric
plume. *Feeling:* held breath.

**7 — THE LAKE PATH.** Night 5, whiteout fog. Visibility 24 m. The frame is 80% `#54697a` fog with
a barely-perceptible darker mass where the trees are. In the exact centre, at 22 m, one silhouette
stands motionless facing away. No light on it at all. *Feeling:* the fear of being able to see
almost nothing and knowing that means nothing good.

**8 — THE FRAME AT FOUR NIGHTS.** Wide, from the treeline. The cabin's stud walls stand up — a
pale orthogonal skeleton at `#a8875c`, geometric and *wrong* in an organic black forest. The moon
is behind it at 19° elevation and it now casts **its own god rays** through the studs across the
mist. *Feeling:* pride. Actual, uncomplicated pride, which is horrifying.

**9 — THE HAMMER.** Extreme close, the joint. f/1.8. A galvanized bracket, a rusted nail, a
gloved hand. Rain lands on the steel and beads. The lantern is clipped to a stake at 30° raking,
so every saw kerf in the lumber throws a 2 mm shadow. The background is total black except a
20-px-wide vertical smear of orange from a campfire 60 m away. *Feeling:* craft. Focus. The
pleasure of a thing seated correctly.

**10 — THE TORCH IN THE FACE.** A camper, 6 m, has turned. Their `#ffe6bb` beam hits the lens
directly. Full bloom, full CA transient, exposure has just lurched to 0.72, FOV snapped to 82°,
grain in the shadows spiking. Their face is a rim of `#6b5148` wet skin and one corneal catchlight.
*Feeling:* caught. The world got brighter and that is the worst thing that could happen.

**11 — THE STORM.** Night 6. Lightning at peak. For 60 ms every surface in a 200 m radius is lit
at `#c9d6ee` intensity 4.5, the entire forest is legible, the rain is a million lit streaks, and
the half-built cabin stands in silhouette. Then 1.4 s of recovery in which the frame is darker
than it started. The **one** scripted lens-water moment. *Feeling:* revelation, then blindness.

**12 — DAWN.** Night 7 complete. The grade cross-fades to `dawn`, exposure ramps to 0.95, fog
scale-height drops to 3.4 m so mist sits knee-high and glows. The cabin is finished: a small,
tidy, correctly-assembled structure with a corrugated tin roof beading water, a closed door, and
one square window. It is **beautiful**. Then, faint on the road: a yellow school bus. *Feeling:*
satisfaction curdling into dread. The last frame of a furniture commercial, followed by the first
frame of a horror film.

---

## 10. FAILURE MODES

Each of these will individually reduce the game to a student Three.js demo. Each has a fix. Treat
this as a review checklist before any module is marked done.

| # | Trap | Why it kills us | The fix |
|---|---|---|---|
| **1** | **Uniform `THREE.Fog` / `FogExp2` with no height falloff** | A constant-density fog is a flat grey wash. Distance and elevation become unreadable; the forest becomes a wall | Exponential **height** fog (§4.1, `H = 4.2 m`) *plus* the froxel volume. Fog must sit *below* the canopy so trees emerge from it. Assert: from a ridge, you can see mist pooling in the valley below you |
| **2** | **Trees all the same scale/rotation/species** | The eye instantly reads a repeated instance and the world dies | Per-instance: height `gauss(19, 5.5)` m clamped `[7, 34]`, trunk radius correlated at `r = 0.55`, yaw uniform, **±4.5° lean** biased downwind, 3 species with 5 canopy variants each, and a 6% birch punctuation. Additionally vary per-instance albedo brightness ±9% and moss coverage ±40% |
| **3** | **No contact shadows — everything floats** | The dropped bracket sits *on top of* the mud with a visible bright seam. Instantly amateur | SSCS at `high`+, projected darkening decal at `low`/`medium` (§3.3). Every loose part, every rock, every foot. Test: drop a bracket on flat mud in moonlight; the contact seam must be the darkest pixel in the local neighbourhood |
| **4** | **No dither → banding across the entire dark range** | Our whole image lives in the bottom 5% of an 8-bit buffer. Without dither it is visible concentric rings around every light | Triangular-PDF blue-noise dither, ±1/255, final op, all tiers (§7.7). Non-negotiable |
| **5** | **Everything is uniformly wet or uniformly dry** | Uniform wetness reads as "I applied a global roughness value", which is exactly what it is | Wetness is driven by `aExposure` (sky visibility, baked per vertex), cavity masks, and slope. Under a tree it must be measurably drier. Under the tarp, dry. On the ridge, streaming. **The variation is the realism** |
| **6** | **Screen-space radial-blur "god rays" from a sun sprite** | Leaks through geometry, breaks when the source is off-screen, looks like 2008 | God rays come from real occlusion in the froxel volume (§4.4). If the source leaves the frustum the shafts must continue correctly |
| **7** | **Flat, single-scale normal maps on bark and rock** | At 1 m the surface has no macro relief; at 20 m the detail mips into grey mush and the trunk becomes a cylinder | Two-scale normals (macro + detail) with a Toksvig normal-variance→roughness conversion so mipped detail becomes *roughness*, not flatness. Parallax occlusion on the nearest bark LOD only |
| **8** | **Pure black shadows (crushed to 0,0,0)** | Zero-luminance regions read as holes in the render, not as darkness. The eye knows real darkness has colour | Nothing in the 3D scene reaches 0. Ambient floor + shadow-saturation boost (§7.3) keep the darkest visible pixels at `#060b0e`, blue-black. Verify with a histogram overlay in dev builds |
| **9** | **Warm ambient / warm bounce light anywhere in nature** | Breaks The One Rule; the sodium and firelight stop meaning "human"; the whole palette goes muddy | Audit every `HemisphereLight`, every `LightProbe`, every emissive. Grep for hex values with `R > G > B` and justify each one in a comment |
| **10** | **Aliasing on foliage and rain** | Alpha-tested pine cards shimmer horribly in motion. Rain streaks strobe. It looks cheap in exactly the way AAA never does | Alpha-to-coverage + TAA with Halton jitter (§7 pass 5) and a 0.22 post-sharpen. Rain streaks get velocity-aligned soft edges and a minimum 1.2 px width. Test in **motion**, never on a still |
| **11** | **Head bob as a pure sine wave with too much amplitude** | Nausea, and it reads as "camera animation" rather than "a body" | Figure-8 path, asymmetric breathing envelope, pink-noise micro-tremor, and the 520°/s² turn-acceleration clamp (§6.2). If a tester says "the bobbing", it is 40% too strong |
| **12** | **Bloom threshold too low → the whole frame glows** | Everything hazes, contrast dies, and the image goes milky. The classic amateur "cinematic" tell | Threshold 1.15, intensity 0.055, 7-mip chain (§7.2). Only genuinely over-range pixels bloom. If any *surface* is blooming rather than a *light*, the threshold is wrong |
| **13** | **The IKEA UI rendered inside the 3D scene, or post-processed** | Grain and CA on the manual destroys the tonal knife-twist; it becomes just another diegetic prop | DOM/canvas overlay, above the WebGL canvas, zero post (§8). The manual is from another universe and must render like it |
| **14** | **Rounded line caps, gradients, or drop shadows inside the manual art** | Turns 1984 offset print into 2019 SaaS illustration. Kills the joke's specificity | Butt caps, miter joins, four fixed stroke widths, zero gradients, one accent colour, flat fills only (§8.2) |
| **15** | **Terrain that is a smooth noise field with a tiled texture** | Reads as a heightmap demo. No paths, no erosion, no human history | Hydraulic-erosion pass, triplanar splat blending with height-based blend (not linear lerp), **worn paths** carved along the camper navmesh with compacted, glossier, less-vegetated soil, wheel ruts holding water, and a duff litter layer that accumulates in concavities |
| **16** | **Every light casting shadows** | Blows the frame budget and produces a flat, shadow-noisy image with no light hierarchy | The three-light discipline (§3.2). Moon + lantern + ≤3 fires. Camper torches are volumetric-only. If you want a fourth shadow, delete one |
| **17** | **Rain as a full-screen 2D texture scroll** | Has no parallax, no light interaction, no wind response, and instantly reads as a screen effect | Instanced 3D streak quads in a 24 m camera-following cylinder, velocity-aligned, wind-sheared by `uWind`, brightened 2.2× inside light cones, with splash decals and ripple impulses on water and puddles |
| **18** | **Static grain, or grain applied before TAA** | Static grain looks like a dirty monitor; pre-TAA grain gets averaged into nothing | Animated per-frame blue-noise grain applied after TAA, amplitude curve `0.055*(1-L)^1.4 + 0.008` (§7.5) |
| **19** | **All materials at the same roughness band (0.4–0.6)** | The single most common tell of a non-art-directed PBR scene. Nothing has character; nothing catches the moon | Spread the roughness histogram deliberately: water 0.02, wet steel 0.14, wet bark 0.14, moss 0.72, canvas 0.86, dry bark 0.88. **The frame should contain at least one surface below 0.10 and one above 0.80 at all times** |
| **20** | **Draw call sprawl** | Over 220 calls in the forest and we drop frames, and dropped frames destroy the handheld illusion faster than any shader bug | Instance everything with count > 8, merge static props per chunk, one material per family, frustum + distance culling with hysteresis, and an in-dev HUD readout of `renderer.info.render.calls` that turns `#d92b2b` above 220 |

---

## 11. QUICK REFERENCE CARD

Pin this above your monitor.

```
EXPOSURE      0.62   |  AgX  |  EV -3.2  |  avg frame luma 0.018-0.028
MOON          #7d95c4  intensity 0.06-0.09  az 118°  el 26°->19°
AMBIENT       sky #1d2b3a / ground #0c1210  intensity 0.10 (0.22 fog)
LANTERN       #ffb865  40  decay 2  angle 0.42  held low-left
FOG           D0 0.014  H 4.2 m  near #2a3a44  far #54697a  g 0.55
BLOOM         thresh 1.15  knee 0.35  intensity 0.055  7 mips
GRAIN         1.35 px @1080  0.055*(1-L)^1.4+0.008  animated  post-TAA
CA            0.0016 * r^2.4   VIGNETTE cos^4 + smoothstep(0.42,1.10)*0.30
GRADE         lift(-.004,+.002,+.014) gamma(1.02,1.00,0.96) gain(1.06,1.00,0.92)
              sat 0.86  shadow-sat 1.18  highlight-sat 0.70
FOV           72 / 78 sprint / 68 crouch / 62 blueprint / 82 spotted
TREMOR        ±0.09° RMS pink noise    TURN CLAMP 520°/s²
MANUAL        paper #f2efe6  ink #14181a  red #d92b2b  strokes 0.75/1.5/2.5/4.0
              butt caps, miter joins, no gradients, no post, RectAreaLight 3.0
THE ONE RULE  The world is blue-green. The only warm light is human.
```
