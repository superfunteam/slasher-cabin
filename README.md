# Slasher Cabin: Some Assembly Required

**Build it and they will die.**

A first-person horror puzzle game. You are the slasher-movie monster, and you got to the woods
early — because the shack in the clearing didn't build itself.

Each night you are handed a wordless flat-pack assembly diagram and you build the next stage of
your cabin, in the dark, a few hundred metres from a summer camp full of counselors setting up
for the season. Build it correctly and it stands silent. Build it wrong and it **creaks**, and
creaks carry, and someone comes to look.

You are always one bracket short.

---

## Running it

```bash
npm install && npm run dev
```

Then open http://127.0.0.1:5173.

| URL | What it does |
|---|---|
| `/` | the game |
| `/?debug` | verbose logging |
| `/?shots` | list the canonical camera framings |
| `/?shot=ridge` | pose a reproducible shot and freeze the sim for capture |
| `/?quality=low` | force a quality tier (`low`/`medium`/`high`/`ultra`) |
| `/?seed=123` | reseed the world |
| `/?navdebug` `/?noisedebug` `/?texdebug` | system inspectors |

## Controls

`WASD` move · `Shift` sprint · `Ctrl`/`C` crouch · `E` interact · `Q` drop · `G` throw
`R`/`T` rotate the held part · `F` lantern (hold to hood it) · `Tab`/`B` the manual · `Esc` pause

Hooding the lantern is the difference between seeing and being seen. Opening the manual lights
your face.

---

## The documents

The game is specified before it is coded, and the specs are binding. Four documents govern
everything, and any disagreement between code and document is a bug in the code:

| Document | What it governs |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | the engineering contract — module boundaries, the `ctx` object, the canonical event list, quality tiers, performance guardrails |
| [ART_DIRECTION.md](ART_DIRECTION.md) | exact palette, lighting units, material parameters, the post-process stack, and the named failure modes that make a WebGL scene look amateur |
| [GAME_DESIGN.md](GAME_DESIGN.md) | systems spec — movement numbers, the correctness model, the creak formula, the stealth state machine |
| [STORY.md](STORY.md) | the story bible and the full script. Tone is law. |
| [AUDIO_DIRECTION.md](AUDIO_DIRECTION.md) | the mix, the 3D model, and the DSP recipe book |

## Architecture in one paragraph

`Engine` owns the renderer, a fixed-step accumulator, and a registry of *systems*. A system is
any object with `init/update/fixedUpdate/resize/dispose`. Systems never import each other; they
communicate through a single `EventBus` using a closed set of canonical events, and look each
other up defensively through `ctx.systems`. A missing or throwing system is logged and skipped
rather than taking the game down — which is what allows every module to be authored
independently against one branch. The world is fully deterministic from a seed.

`noise:emit` is the nervous system. Anything loud emits it; `NoiseSystem` propagates it with real
terrain and foliage occlusion; `Campers` hear exactly what the player hears. That equality is the
game's fairness contract.

## Assets

The 3D world is **100% procedural** — every texture, mesh, and material is generated at runtime.
There are no model or texture files.

Two generated layers sit on top, and the game runs completely without either:

```bash
node tools/generate-audio.mjs     # ambience beds, hero SFX, adaptive score  (ElevenLabs)
node tools/generate-voices.mjs    # camper VO                                (ElevenLabs)
node tools/generate-images.mjs    # manual art, decal overlays               (gpt-image-2)
```

Keys resolve from the environment, then a gitignored `.env`, then `netlify env:get`. They are
also stored as GitHub repo secrets for the on-demand
[regeneration workflow](.github/workflows/generate-assets.yml).

**On voice:** the VO is atmosphere, not performance. Lines are placed in world space and
distance-filtered to the edge of intelligibility — inside 8m a line is clear, past 45m it is just
a human sound in the trees. The game subtitles only what you could actually make out, because
subtitling a line you couldn't hear destroys the effect. Delete `public/audio/vo/` entirely and
the game is undiminished.

**On synthesis vs. generation:** anything the game must vary continuously — footsteps by surface
and mass, lumber impacts by velocity, creak severity swept by structural load — is synthesized in
WebAudio so it can respond. Fixed beds and one-shots are generated, because a real recording beats
an oscillator. The split is documented at the top of `tools/generate-audio.mjs`.
