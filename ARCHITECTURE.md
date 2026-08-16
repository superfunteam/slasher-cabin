# Slasher Cabin — Engineering Contract

**READ THIS FULLY BEFORE WRITING ANY CODE.** Every module in this project is authored by a
different agent working in parallel. This document is the only thing keeping them compatible.
If you deviate from it, you break someone else's file.

---

## 1. Stack

- **Three.js `^0.185.1`**, WebGL2 forward rendering (`WebGLRenderer`). **Not** WebGPU/TSL.
- **Vite `^8`**, ESM only, no bundler-specific syntax beyond `import`/`export`.
- **Zero binary art assets.** Every texture, mesh, and sound effect is generated procedurally at
  runtime or authored as code. The only fetched assets are ElevenLabs voice lines in
  `public/audio/vo/` (optional — the game must run perfectly without them).
- Import Three as `import * as THREE from 'three';` and addons as
  `import { X } from 'three/addons/...';` (the `three/addons/*` alias is provided by the
  `three` package's exports map — do not use `three/examples/jsm/...`).

## 2. Golden rules

1. **One agent owns one file.** Never edit a file you do not own. If you need behavior from
   another module, call its documented API. If the API you need is not documented here, add a
   `TODO(api):` comment and code defensively (`if (typeof x?.foo === 'function')`).
2. **No `console.log` in committed code.** Use `Log.debug()` from `src/core/Log.js`.
3. **Everything is disposable.** Every class that allocates GPU resources exposes `dispose()`.
4. **Frame budget: 16.6 ms at 1920×1080 on an M-series Mac.** If your system costs more than
   1.5 ms/frame, amortize it across frames or move it to a worker.
5. **No `Math.random()` at module scope.** Use the seeded RNG (`src/core/Rand.js`) so the world
   is reproducible for screenshot regression tests.
6. **Units are metres.** Player eye height is 1.7. Gravity is -22 (game-feel, not real).
7. **Y is up. -Z is forward.**

## 3. Bootstrap & lifecycle

`src/main.js` constructs `Engine`, then constructs every system and registers it. A *system* is
any object with this shape (all methods optional except `update`):

```js
class MySystem {
  constructor(ctx) {}         // ctx = the Context object, see §4
  async init() {}             // awaited once, before the first frame
  update(dt, elapsed) {}      // every frame, dt in seconds, clamped to <= 0.1
  fixedUpdate(fdt) {}         // 60 Hz, for physics
  resize(width, height) {}    // on canvas resize
  dispose() {}                // teardown
}
```

Systems update in registration order. Registration order is defined in `src/main.js` and is:

```
Input → Time → Player → Physics → Campers → NoiseSystem → BuildSystem → NightManager
→ Weather → Forest → Audio → Sky → Postprocessing → HUD
```

## 4. The Context object (`ctx`)

A single mutable object passed to every system's constructor. Defined and owned by
`src/core/Engine.js`. Never reassign `ctx` properties that you do not own.

```js
ctx = {
  renderer,        // THREE.WebGLRenderer
  scene,           // THREE.Scene
  camera,          // THREE.PerspectiveCamera (the player's eye)
  clock,           // THREE.Clock
  canvas,          // HTMLCanvasElement
  width, height,   // drawing buffer size in CSS px
  dpr,             // effective device pixel ratio (capped, see Settings)
  bus,             // EventBus, see §5
  rand,            // seeded RNG, see §6
  settings,        // Settings, see §7
  state,           // GameState, see §8
  systems,         // Map<string, System> — ctx.systems.get('Player')
}
```

Look systems up with `ctx.systems.get('Campers')`. **Always null-check** — a system may not be
registered yet during `init()`.

## 5. EventBus (`src/core/EventBus.js`) — owned by Engine agent

```js
bus.on(event, fn)      // returns an unsubscribe function
bus.once(event, fn)
bus.off(event, fn)
bus.emit(event, payload)
```

### Canonical event names (the complete list — do not invent new ones without adding them here)

| Event | Payload | Emitted by |
|---|---|---|
| `game:start` | `{}` | NightManager |
| `game:pause` / `game:resume` | `{}` | Engine |
| `night:begin` | `{ night:int, blueprint:Blueprint }` | NightManager |
| `night:complete` | `{ night:int, score:Score }` | NightManager |
| `night:failed` | `{ night:int, reason:string }` | NightManager |
| `player:move` | `{ position:Vector3, speed:float, crouched:bool }` | Player |
| `player:footstep` | `{ position:Vector3, surface:string, loud:float }` | Player |
| `player:spotted` | `{ camper:Camper, level:float }` | Campers |
| `player:hidden` | `{}` | Campers |
| `noise:emit` | `{ position:Vector3, radius:float, intensity:float, kind:string }` | anyone |
| `build:pickup` | `{ part:Part }` | BuildSystem |
| `build:drop` | `{ part:Part }` | BuildSystem |
| `build:place` | `{ part:Part, slot:Slot, correct:bool }` | BuildSystem |
| `build:remove` | `{ part:Part, slot:Slot }` | BuildSystem |
| `build:creak` | `{ position:Vector3, severity:float }` | BuildSystem |
| `build:stage-complete` | `{ stage:int }` | BuildSystem |
| `tool:missing` | `{ toolId:string }` | BuildSystem |
| `tool:found` | `{ toolId:string }` | BuildSystem |
| `ui:blueprint-open` / `ui:blueprint-close` | `{}` | HUD |
| `ui:toast` | `{ text:string, icon?:string, ms?:int }` | anyone |
| `ui:subtitle` | `{ text:string, speaker:string, ms:int }` | Audio |
| `story:beat` | `{ id:string }` | NightManager |
| `audio:sfx` | `{ id:string, position?:Vector3, volume?:float, rate?:float }` | anyone |
| `audio:vo` | `{ id:string, position?:Vector3 }` | anyone |
| `weather:change` | `{ rain:float, wind:float, fog:float }` | Weather |

**`noise:emit` is the game's nervous system.** Anything loud emits it. `Campers` is the only
listener that matters. `intensity` is 0..1, `radius` is metres.

## 6. Determinism (`src/core/Rand.js`) — owned by Engine agent

```js
import { Rand, hash2 } from './core/Rand.js';
const r = new Rand(seed);   // seed: int
r.next()        // [0,1)
r.range(a, b)   // float in [a,b)
r.int(a, b)     // int in [a,b]
r.pick(array)
r.gauss(mu, sigma)
hash2(x, y)     // deterministic [0,1) from two ints — for terrain/scatter
```

`ctx.rand` is the global instance seeded from `ctx.settings.seed` (default `0x51A5CAB`).
**Derive your own instance** for anything spatial: `new Rand(hash2(chunkX, chunkZ) * 1e9 | 0)`.

## 7. Settings (`src/core/Settings.js`) — owned by Engine agent

Persisted to `localStorage` under `slashercabin.settings`. Quality tiers drive everything.

```js
settings = {
  seed: 0x51A5CAB,
  quality: 'ultra',  // 'low' | 'medium' | 'high' | 'ultra'
  dprCap: 2.0,
  fov: 72,
  mouseSensitivity: 1.0,
  invertY: false,
  masterVolume: 0.9, sfxVolume: 1.0, musicVolume: 0.7, voiceVolume: 0.85,
  subtitles: true,
  motionBlur: true, filmGrain: true, chromaticAberration: true, vignette: true,
  headBob: true,
  colorblind: 'none',
}
```

`settings.get(key)`, `settings.set(key, value)` (emits `settings:changed`), and
`settings.tier(low, medium, high, ultra)` → returns the value matching the current quality.
Use `tier()` everywhere instead of branching on quality strings:

```js
const shadowSize = settings.tier(512, 1024, 2048, 4096);
```

## 8. GameState (`src/core/GameState.js`) — owned by Engine agent

Plain serializable object. The save file. Do not put Three.js objects in here.

```js
state = {
  night: 1,                    // 1..7
  phase: 'menu',               // 'menu'|'briefing'|'build'|'chase'|'night-end'|'gameover'
  timeOfNight: 0,              // 0..1, dawn at 1.0
  inventory: [],               // Part ids the player is carrying
  installed: {},               // slotId -> { partId, correct:bool, torque:float }
  toolsFound: [],              // tool ids
  suspicion: 0,                // 0..1 camp-wide alert level
  spotted: false,
  creaks: 0,                   // total wrong-build creaks this night
  stats: { partsCarried:0, metresWalked:0, campersEvaded:0, perfectJoins:0 },
  storyFlags: {},              // id -> true
}
```

## 9. File ownership map

| Path | Owner | Purpose |
|---|---|---|
| `src/main.js` | Engine | bootstrap, system registration |
| `src/core/*.js` | Engine | Engine, EventBus, Rand, Settings, GameState, Input, Log, Time |
| `src/render/Postprocessing.js` | Render | full post stack |
| `src/render/Sky.js` | Render | night sky, moon, stars, aurora, lightning |
| `src/render/VolumetricFog.js` | Render | froxel volumetrics + god rays |
| `src/render/Textures.js` | Materials | procedural PBR texture bakery |
| `src/render/Materials.js` | Materials | shared material library |
| `src/world/Terrain.js` | World | heightfield, ground materials, collision query |
| `src/world/Forest.js` | World | trees, undergrowth, instancing, wind |
| `src/world/Props.js` | World | rocks, stumps, tents, canoes, the camp itself |
| `src/world/CabinSite.js` | Build | the build plot, foundation, slot layout |
| `src/gameplay/Player.js` | Player | FP controller, camera, stamina, carry |
| `src/gameplay/Physics.js` | Player | capsule collision, raycasts, carried-object sim |
| `src/gameplay/Flashlight.js` | Player | the player's lantern + volumetric cone |
| `src/gameplay/BuildSystem.js` | Build | parts, slots, snapping, correctness, creaks |
| `src/gameplay/Blueprint.js` | Build | procedural IKEA-diagram generation |
| `src/gameplay/Campers.js` | AI | camper agents, FSM, senses, flashlight cones |
| `src/gameplay/Navmesh.js` | AI | patrol graph + pathfinding |
| `src/gameplay/NoiseSystem.js` | AI | noise propagation, occlusion |
| `src/gameplay/NightManager.js` | Director | night loop, objectives, pacing, story beats |
| `src/gameplay/Weather.js` | Director | rain, wind, storm, lightning schedule |
| `src/audio/AudioEngine.js` | Audio | WebAudio graph, 3D panning, reverb, occlusion |
| `src/audio/ProceduralSFX.js` | Audio | synthesized SFX (no sample files) |
| `src/audio/Music.js` | Audio | adaptive score |
| `src/audio/VoiceBank.js` | Audio | ElevenLabs VO loading + 3D placement |
| `src/ui/HUD.js` | UI | DOM overlay, reticle, prompts, subtitles |
| `src/ui/BlueprintUI.js` | UI | the fold-out instruction manual |
| `src/ui/Menu.js` | UI | title, pause, settings, night-end card |
| `src/story/Script.js` | Story | all narrative text, VO lines, beat definitions |
| `tools/generate-voices.mjs` | Audio | ElevenLabs generation script |

## 10. Rendering conventions

- `renderer.outputColorSpace = THREE.SRGBColorSpace`
- `renderer.toneMapping = THREE.AgXToneMapping`, `toneMappingExposure` driven by Postprocessing
- **Physical lighting units.** `renderer.useLegacyLights` is false by default in r155+; author
  lights in candela/lumens. The moon is a `DirectionalLight` at intensity ~0.06 with a cool
  tint `#7d95c4`. The flashlight is a `SpotLight` at ~40 intensity, `decay: 2`.
- Shadows: `THREE.PCFSoftShadowMap`. Only the moon + flashlight + up to 3 campfire lights cast.
- **Everything static is instanced or merged.** Draw call budget: **< 220** in the forest.
- Custom shaders: prefer `material.onBeforeCompile` patching over from-scratch `ShaderMaterial`
  so shadows/fog keep working. Register shared uniforms via `Materials.globalUniforms` (a plain
  object of `THREE.Uniform`s, updated once per frame — includes `uTime`, `uWind`, `uPlayerPos`,
  `uRain`, `uLightning`).
- All post-process passes must be **resolution independent** and read `ctx.dpr`.

## 11. Art direction (binding)

Nailing the mood matters more than polygon count. See `ART_DIRECTION.md` for the full spec;
the non-negotiables:

- **Palette:** desaturated blue-green night (`#0a1216` shadow, `#7d95c4` moonlight), broken only
  by warm sodium/firelight (`#ff9d4a`) from the camp and the player's amber lantern (`#ffb865`).
  Blood and the IKEA-manual red (`#d92b2b`) are the *only* saturated reds.
- **Contrast is the horror.** Deep crushed blacks, bloom-blown highlights, no grey mush.
- **Every light source is volumetric.** Fog is a character.
- **Handheld camera.** Constant subtle noise on the view matrix; the player is a big, heavy man.
- **The IKEA parody UI is flat, bright, and clinical** — a deliberate tonal knife-twist against
  the wet, dark 3D world. Helvetica-alike, thin black line art, one red accent.

## 11b. Writing GLSL inside JS — two rules that have already bitten us

Shaders live in tagged template literals (`` const NOISE = /* glsl */`...` ``). Two failure modes
have already cost real time in this repo:

1. **Never put a backtick in a GLSL comment.** A single `` ` `` inside the shader string
   terminates the template literal, and everything after it is parsed as JavaScript. The error
   surfaces hundreds of lines away and looks nothing like the cause. Use `'single quotes'` when
   referring to a variable in a shader comment.
2. **Never emit a placeholder marker and plan to come back.** A file written as
   `// /*__PART2__*/` and finished in a second call is a file that ships half-written when the
   second call does not happen. Write every method in the first pass — compact bodies are fine —
   then deepen them with edits.

Run `node tools/check.mjs` after writing any file. It catches both of these, plus truncation
(a file that parses but is missing the API its contract promises).

## 11c. Inspecting the running game — use 127.0.0.1, never localhost

The dev server is at **http://127.0.0.1:5173**. Do NOT use `http://localhost:5173`.

On this machine another application is listening on the IPv6 loopback `[::1]:5173`. `localhost`
resolves to IPv4 or IPv6 depending on the client, so `localhost:5173` reaches *a different app*
some of the time. A verification agent screenshotted that other app and reported on it before
noticing. `127.0.0.1` is unambiguous.

Engine exposes `window.__ENGINE__` and `window.__CTX__` from its **constructor**, so both are
reachable even when a system throws during `init()` and `boot()` never finishes — which is
exactly when you need them.

Boot takes ~8s (procedural texture baking, terrain generation). Poll
`document.documentElement.dataset.booted` or `dataset.shotReady`; never judge a mid-boot frame.
Other agents editing files triggers a Vite hot reload that restarts boot underneath you — if a
probe returns nothing, poll again rather than concluding the system is broken.

## 12. Performance guardrails

- No allocations in `update()`. Reuse scratch vectors (`const _v = new THREE.Vector3()` at
  module scope, outside the class).
- No `new THREE.Material()` after `init()`. Build the material library up front.
- Instanced meshes only for anything with count > 8.
- Raycasts: max 12 per frame across the whole game. Use `Physics.raycast()` which pools.

## 13. Definition of done for every module

- Runs at 60 fps at 1080p on `quality: 'ultra'`.
- Zero console errors or warnings.
- `dispose()` frees everything (verify with `renderer.info.memory`).
- Degrades correctly at `quality: 'low'` (still playable, still atmospheric).
- No hard dependency on a system that might be missing — null-check everything.
