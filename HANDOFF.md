# Handoff

State at pause. Read this before touching anything, then read `ARCHITECTURE.md` — especially
**§11d, which is the single most important section in the repo.**

---

## Where the build actually is

**It is a game.** An evaluator completed Night 1 stage 1 with real key presses: spawned 9 m from
the plot, walked to a pier 2.24 m away, picked it up with `E`, carried it at 1.2333 m/s against an
empty 1.6000, watched the ghost preview fire, seated P-01 through P-04 with the normal verb at
torque 1.0, and `build:stage-complete {stage:1}` fired.

| | |
|---|---|
| Modules | 36/36, **0 fatal**, clean production build |
| Frame cost | ~3 ms at 720p (an earlier "9 fps" was browser contention, not cost) |
| Draw calls | **352–358 — over the 220 budget in ARCHITECTURE §10.** Unresolved. |
| Visual, honest | ~5/10 mean over 13 canonical shots; `site-close` and `opening` reach 7 |
| Assets | 14 generated images, 33 audio beds/SFX/score, 90 VO lines |
| Docs | ~12,400 lines across five binding documents |

**The interface is the strongest part** — title screen, the wordless in-engine manual, and the
night-end QC report card are genuinely good. **The 3D is the weakest.** The gap to the key art is
real and named below.

---

## THE MOST IMPORTANT THING: measurement on this project has lied six times

Every one of these produced *confident, precise, wrong numbers*. Several sent real work backwards;
one caused a committed regression. Two were inside the tool built to prevent the others.

1. `Engine.captureFrame()` rendered a frame immediately after a resize, which clears TAA history
   and volumetric reprojection. Every capture was a cold frame the game never displays — 75.6% of
   pixels below luminance 0.02 where the warm frame reads 28.3%. **Five stops.** *Fixed: it now
   converges 70 frames.*
2. A luma metric computed on sRGB bytes **without linearizing**. It inverted the sign of the error
   and "proved" the frame was darker than the reference when it was 2–4× brighter. A regression
   shipped on it. *Fixed: `tools/luma.mjs` is the canonical instrument.*
3. An evaluator worked around a throttled pane by hand-stepping systems and calling `_render()`
   directly. That starves exposure adaptation: it measured `ridge` at meanY 0.1759 where the warm
   harness reads **0.02408 — 7.3× wrong** — and declared a working build broken.
4. Posed captures drifted over a session because the lantern's wick burns down (63 cd at 30 s →
   26 cd at 5 min). *Fixed: fuel is held while `Shots.active` is set.*
5. `Shots.js` forced `lantern.on` every frame, so no capture could observe the game's own lamp
   state. *Fixed: omitting `lantern` (or `null`) means don't touch. `?shot=opening` uses it.*
6. `tools/luma.mjs` reused a stale `/tmp` decode, so a **missing file silently reported the
   reference's numbers**. Caught only because a row came back byte-identical to the keyart.
   *Fixed: errors loudly.*

### The rules that came out of it

- **Capture only via `window.__CAPTURE__(name, w, h)`** after polling
  `document.documentElement.dataset.shotReady === "true"`. Never hand-step systems.
- **Measure luminance only with `tools/luma.mjs`.** It refuses to report until it reproduces
  `keyart-site.png` at meanY 0.0218 / 79.77% below 0.02.
- **A measurement claim must show the instrument reproducing a known reference before it is acted
  on.** "I measured X" is not evidence.
- **Numbers and eyes are both required.** A frame that passed every numeric check was still
  visibly worse than the one before it — the lantern had moved behind the structure and was
  backlighting it. The contract said PASS. It looked wrong.
- **Use `http://127.0.0.1:5173`, never `localhost`** — another app owns `[::1]:5173` on this
  machine and an agent spent a whole run reporting on it.

---

## In flight at pause

A workflow (`wf_d714b60b-fee`) was finishing two fixes. **Verify these landed before building on
them:**

1. **`Postprocessing._meterTarget()` — the lightning flash.** Lightning fires correctly now
   (`flashSeq` increments, `Sky.flash()` runs, 4.5 key light, thunder, mask window) but the
   auto-exposure **stops down 11.7×, harder than the flash brightens**, so the peak gets *darker*
   (p99.9 0.2934 → 0.1990). `_meterTarget()` has a row per weather state and none for a flash.
   With the meter pinned, the same frame reads **p99.9 1.0, 7.26% blown** — see
   `shots/w4-unmetered-fixed.png`. That is the money shot and it is one line away. Freezing
   `tAdapt` during a flash is probably better than scaling: a real eye does not adapt in 120 ms,
   which is why lightning blinds.
2. **`Forest.js` — hundreds of hard dark bars over the fog.** ~557 `pine-l2-v0` + 611
   `fir-l2-v0` LOD2 instances rendering as unlit, aliased, randomly-oriented sticks. Originally
   misattributed to rain; disproved three ways (`shots/w0-norain.png`, `w0-noweather.png`,
   `w0-solidred.png`).

---

## Top gaps, in priority order

1. **Draw calls 352–358 vs a 220 budget.** Nobody has attributed them by owner yet.
2. **The consequence chain is the last unverified pillar.** Build wrong → creak → noise → a camper
   comes. The links exist individually; nobody has observed the whole chain complete.
   **Structural obstacle:** camp is at (124, −18) and the plot at (−140, 128) — **302 m apart**,
   where `GAME_DESIGN §3.3` budgets 142. If no patrol route closes that gap, encounters are
   impossible by construction regardless of AI quality. Check `Navmesh.patrolRoutes` first.
3. **Two first-run traps.** P-01 — the first pier slot of the game — is the only obstructed slot
   in Night 1, its tuning comment literally reads *"Silent. No prompt."*, and holding LMB (the
   natural response to "it won't go in") triggers `_forcePlace`, which scores WRONG_PART. Also,
   the `remove` verb is finished, works, has a HUD pictogram, is advertised by `inspect()` — and
   **nothing calls it.** Both were dispatched; verify.
4. **Visual gaps to the key art:** the lake has no water surface or reflection; tent interiors
   glow *inverted* (openings darker than canvas); cabin windows are flat rectangles with no spill;
   `ridge` is the "grey mush" failure `ART_DIRECTION §11` explicitly forbids.
5. **Deploy is untested.** `netlify.toml` is configured (site `slasher-cabin` linked, `npm run
   build` → `dist`, Node 22). **`dist` is ~59 MB** — a brutal first load, and the generated audio
   and images are likely being copied wholesale. The production build has never been served and
   verified. *Nothing has been deployed. That call is the owner's.*

---

## Things that are RIGHT — do not "fix" these

- The slot graph and world transforms, pickup, the five-outcome correctness model,
  `inspect()`'s diagnosis object, geometry rebuild on install, and remove/re-place. A playtest
  confirmed all of it works.
- Movement matches `GAME_DESIGN §10.1` to three decimals (walk 1.600, 62 kg sill 1.008).
- The night lifecycle: `menu → briefing → build`, with `timeOfNight` only advancing in `build`.
- **`CabinSite`'s coordinate contract:** `Slot.position`/`rotation` are **plot-local**;
  `Slot.px/py/pz` and `slotWorldTransform()` are **world**. Mixing them silently puts every
  candidate 140 m away. This has bitten twice.
- The keyart's own black point is *looser* than the spec: it has min channel 0 and 4.31% clipped
  pixels. `ART_DIRECTION`'s "no zeros, min channel ≥ 3" is stricter than the image it exists to
  match — **do not chase it at the cost of the mean.**

---

## Process notes for whoever runs agents next

- **Single-phase workflows complete reliably. Multi-phase ones died repeatedly** at phase
  boundaries — though the root cause turned out to be session-limit and 529 errors, not a phase
  bug. Retry on failure; nothing was ever corrupted by it.
- **The truncation pattern hit 9 agents.** A large file that parses cleanly, ends with a tidy
  `export default`, and omits its entire public API. `Terrain` shipped with no `heightAt()`;
  `Textures` with no class; `AudioEngine` with a full WebAudio graph and no `play()`;
  `BlueprintUI` with **eleven** undefined methods. `tools/check.mjs` catches this — run it.
- **Never swallow an error in `init()`.** `BlueprintUI` was dead for hours because a `try/catch`
  ate a `ReferenceError`. If you catch, log at error level with the stack.
- **Never put a backtick inside a GLSL comment** — shaders live in template literals here and one
  stray backtick breaks the parse hundreds of lines away. I did this to my own workflow script.
- **Hex literals must be valid hex.** This repo shipped `0x1UMBER`, `0x2U1N` and `0x c4643a`.
- **"One agent owns one file" broke once** — two agents edited `BuildSystem.js` concurrently. Both
  survived because both kept edits surgical and re-read before each `Edit`. Don't rely on it.
- **The best results came from handing an agent a defect measured by a different agent**, with the
  evidence attached and the owning file named. The worst came from vague quality asks.
- Agents that reported a metric going *down* honestly, or refused to fix a non-bug, were right
  every time. One declined to "fix" a `_projInv` collision that did not exist; another reported
  shadow coverage falling 17.4% → 5.9% and explained the old number was inflated by the defect.

---

## Running it

```bash
npm install && npm run dev     # http://127.0.0.1:5173
node tools/check.mjs           # contract + truncation gate
node tools/luma.mjs shots/x.png  # calibrated luminance
```

`/?shots` lists framings · `/?shot=<id>&quality=ultra` poses one · `/?debug` verbose logging.
Regenerate assets with `tools/generate-{images,audio,voices}.mjs` (keys resolve from env, then a
gitignored `.env`, then `netlify env:get`).
