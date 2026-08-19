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
| Visual, honest | ~5/10 mean over 13 shots; `site-close`/`opening` reach 7; lightning now lands |
| Assets | 14 generated images, 33 audio beds/SFX/score, 90 VO lines |
| First load | `dist` **22 MB** on disk (from 59). **On the wire, the title screen fetches ~20 KB of audio, not 17 MB** — audio is on-demand. |
| Docs | ~12,400 lines across five binding documents |

**The interface is the strongest part** — title screen, the wordless in-engine manual, and the
night-end QC report card are genuinely good. **The 3D is the weakest.** The gap to the key art is
real and named below.

---

## THE MOST IMPORTANT THING: measurement on this project has lied nine times

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
7. `tools/luma.mjs` read **indexed-colour PNGs as if their palette INDICES were RGB.** Its TIFF
   walk assumes 3 samples/pixel and `sips` preserves a palette, so it reported meanY `NaN` for one
   file and "99.81% below 0.02" — i.e. *pitch black* — for a near-white paper texture. Latent
   until `tools/optimise-images.mjs` converted most of `public/img/` to colour-type 3.
   *Fixed: it detects IHDR colour type 3 and refuses, telling you to flatten with
   `magick in.png -type TrueColor out.png`.* **Captures and the keyart are truecolour, so no
   render measurement was ever affected** — but three of the seven failures are now inside the
   one tool built to prevent the other four. Distrust it accordingly; it earns trust only by
   printing `-> OK` on the calibration line.

8. **THE BROWSER PANE CANNOT PRESS THIS GAME'S KEYS.** `src/core/Input.js:12-26` binds every
   action to `KeyboardEvent.code` (`'KeyW'`, `'Tab'`, `'KeyE'`), and `Input.js:94` does
   `this._down.add(e.code)`. Key events delivered through the pane arrive with **`code: ""`** —
   logged directly as `["down","w","",true]`. So **WASD, E, Tab, F, G and R/T are all inert**
   through that path. `Escape` appears to work only because the pause menu reads `e.key`, which
   makes the harness look functional while every gameplay verb silently does nothing. Pointer lock
   is refused in the pane as well, so mouse-look is dead too; the Chrome-extension route is worse
   (background tabs are rAF-throttled — 9 frames in 20 s).
   **Consequence: an agent that "played the game" through the pane and reported the player stuck
   or unresponsive has measured the harness, not the build.** To really drive it, dispatch DOM
   events carrying the correct `code` on `document`, or drive the system directly — and **say
   which method you used for every result you report.** The agents that got real playtests done
   here (the P-01 run, the pry loop) used trusted CDP `Input.dispatchKeyEvent`.

9. **`?shot=opening` was never showing the opening.** `CabinSite._applyPreview()` defaulted that
   framing to `build=4`, so the one canonical shot documented as *"Night 1 as the player first
   sees it"* has always rendered a **roofed cabin standing on the six chalk marks the shot exists
   to show.** Every visual review of the game's opening frame on this project — every score, every
   comparison against the key art — was looking at a built cabin. It is how the chalk being
   *darker than the ground it is drawn on* survived months of review. *Fixed: defaults to
   `build=0`.* **If you hold an `opening` baseline from before this, it is void.**

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

## The two in-flight fixes LANDED — and each corrected the brief it was given

Both are committed. Worth reading, because both agents refused a handed-down diagnosis and were
right to.

**1. The lightning flash works.** p99.9 **0.2411 -> 0.9975**, blown pixels **0 -> 4.7%**. Blown
white sky through the canopy, the forest legible past 60 m, the near trunk a hard black silhouette
against it, rain lit as white streaks, wet ground a field of specular sparkle. `site-close` is
untouched and still PASSES (meanY 0.02712).

**The suggested one-line fix would have made the game worse, and the agent caught it.**
`uParams.value.set(this._dt, 2.6, ...)` is a **tau of 2.6 s, not a rate of 2.6/s**. So
`target * (1 + 11*flash)` steps instantly while the meter has not moved: the gain jumps ~12x and
pins at `EXPOSURE_GAIN_MAX`. Simulated against measured constants, a real 120 ms strike would have
rendered at exposure **3.74 against a pre-flash 0.899, on a scene already 11.7x brighter** — a
white card with the camper invisible in it. In its words: *"the capture would pass and the game
would get worse."* It instead compensates the METER'S RESPONSE, low-passed at the same tau, so the
result is invariant at every timescale and `flash = 0` is bit-identical to the old path.

**2. The dark bars are gone, and the cause was not any of the four I suggested.** LOD2 foliage was
already fully lit, textured, mipped and anisotropic — it shares the *same material instance* as
LOD0. The real cause: 34 quads per tree at 3.71 m x 4.90 m with long-axis elevation **-11 deg to
-36 deg (below horizontal)**, spun through 360 deg of azimuth — and `alphaTest 0.085` sitting
**below the card's ~0.106 mean alpha**, so once mip-averaged at 78-165 m *every card passed
everywhere* and drew as a solid plane. Roughly **36,000 solid near-horizontal planes**. Fixed by
giving LOD2 the impostor's crown-mass treatment with every card's long axis on +Y.

**One open item from that work:** `ridge` now measures meanY 0.02981 against the 0.028 ceiling —
6% over. The Postprocessing agent proved it is not theirs (`_meterFlash` reads exactly 1 there and
the target is bit-identical), and points at the concurrent `Forest.js` change. Pulling ridge down
would push `site-close` out of spec, so this needs judgement rather than a tweak.

## SCOPE, as of 2026-08-18: NIGHT 1 ONLY

Clark has **shelved nights 2-7**. They are authored — night defs, camper rosters, weather
profiles, story beats, the escalation ladder — and deliberately not being verified or polished.

Prioritise by one question: **does a first-time player hit this in Night 1?** If no, it waits,
even if it looks broken. Bugs in shared systems still get fixed when they reach Night 1 — the
`notifySpotted` level bug armed a chase on *every* night and was worth fixing because it fired on
Night 1 too.

The quality bar is unchanged: AAA, benchmarked against `public/img/keyart-*.png`. It is simply
aimed at one night now.

## OPEN: first-person camera shake, reported 2026-08-18

Clark: *"the camera has bad shake... looking with the mouse works great, walking and running feels
good, but there is crazy first-person jitter"* — and on follow-up, **it shakes even when standing
still.** That second detail is the most useful constraint anyone has on this bug.

**One cause is fixed and proven** (see the springs commit): both camera springs used semi-implicit
Euler, unstable above dt 46 ms, diverging to 86 m at 20 fps and 1.3e21 at 10 fps, with a reset test
that was a floor and therefore unreachable once diverged. It rang forever afterwards, at rest as
much as in motion. Now substepped at 1/240 with ceiling guards that fire and log.

**It is NOT confirmed that this was Clark's shake.** If it persists, these are the remaining
candidates, in the order I would test them:

1. **TAA jitter not being resolved.** `Postprocessing._renderScene` offsets the projection matrix
   by Halton(2,3) *every frame* (`uJitter` verified at runtime as exactly `(0, -1/6)` texels). That
   is correct only if the TAA resolve reconstructs it. If history is not accumulating, you see the
   raw jittered image each frame — **the whole picture shakes while the camera is perfectly
   still**, which fits the report better than anything in `Player.js`. TAA is on only at tier >= 2
   (`Postprocessing.js:2726`), so ask what quality tier the reporter is running. Note
   `uParams.w` is *sharpen*, not feedback — the tier gate at :2754 is a red herring; the history
   blend is `uParams.x/y` (feedbackMin/Max).
2. **The 1/f micro-tremor is stepped on the FIXED clock and sampled on the RENDER clock.**
   `Player.js:741` calls `_tremorYaw.step(fdt)` inside the fixed-step loop; `:1906` reads `.value`
   once per frame. When the accumulator delivers 2 substeps one frame and 1 the next, the noise
   advances unevenly. Spec is +/-0.09 deg RMS, which should be invisible — **measure its actual
   RMS in play** rather than trusting `PinkTremor.calibrate()`.
3. **The same fixed-vs-render mismatch on `_bobPhase`** (`:1004` advances it by distance inside the
   fixed loop, `:1873` samples it per frame, and the vertical term is `sin(2p)` so any phase error
   is doubled). This one cannot explain shake at rest — sway is gated by `clamp01(speed / 0.45)` —
   but it may be a second, motion-only artifact worth removing while in there.

**Do not "fix" this by damping the handheld model.** `ART_DIRECTION §9.2`'s breathing, tremor,
figure-8 sway and landing dip are deliberate and Clark likes how walking feels. The goal is to
remove judder, not life. A trace that goes flat means the feel was deleted.

## Top gaps, in priority order

1. **Draw calls 352–358 vs a 220 budget.** Nobody has attributed them by owner yet.
2. **The consequence chain is the last unverified pillar.** Build wrong → creak → noise → a camper
   comes. **Correction to an earlier note here: the "302 m structural blocker" is NOT open — it
   was already solved and this document was stale.** Traced statically end to end:
   `BuildSystem.js:2877` emits `build:creak` and `noise:emit` in a fixed order (§7.1); `NoiseSystem`
   owns propagation; and `Campers` **polls** it (`this._noise`, line 782; hearing at 1359) rather
   than subscribing — §9.8, *"hearing is NoiseSystem's number and only NoiseSystem's number"*, so
   grepping for a `noise:emit` subscription in `Campers.js` finds nothing and proves nothing.
   The distance problem has an explicit answer too: `Campers._tickPlotWatch()` (line 2384, called
   from 1003) measures once a second how close the camp actually gets, publishes `nearestToPlot` /
   `nearestRouteToPlot` so it is checkable from the console, and **if the answer is "never", sends
   one person** — standing off at 30 m for 11 s, no earlier than Night 2, standing down the instant
   a real route delivers the proximity.
   **So what is actually missing is only the observation**: nobody has watched a bad join produce a
   creak that produces a noise that a camper visibly reacts to, in one continuous run. That is a
   playtest, not a repair. Do it before assuming anything is broken.
3. ~~Two first-run traps~~ **BOTH WERE ALREADY FIXED in `f3f6172`. This entry was wrong, and it
   cost a full agent run.** Recorded verbatim as a warning about how to verify a claim like it:
   - *"the `remove` verb — nothing calls it"* was **false**. It is called from `Player.js:1361`,
     bound to **held `Q` with empty hands** (`_updatePry`, 1.10 s), latched so one unbroken press
     cannot also fire another `Q` verb. The grep that "proved" it missing searched for `.remove(`;
     the call site reads `bs.removeJoin(slotId)`. **A grep that finds nothing is not evidence.**
   - *"holding LMB at P-01 scores WRONG_PART"* was **false**. `_forceArmed()` already returns
     false when `ghostBlock === 'obstruction'`. It is also design-correct: `GAME_DESIGN §6.4`'s
     Wrong-part row requires a wrong `acceptsType` **forced**, and an obstruction is not a wrong
     part. Measured: LMB held 5.0 s against a 3.0 s `forcePlaceHold` produced zero `build:place`.

   **What was actually broken, and nobody had looked:** `removeObstruction()` cleared
   `Slot.obstruction` — the gameplay flag — and stopped. The physical 0.045 × 0.92 m post lives in
   `CabinSite`'s site-prep dressing, so after a legitimate pull the stake mesh was still visible
   spanning **y 17.055 → 17.975** against a seated pier top face at **17.475**: half a metre of
   officially-removed stake standing through the finished pier, on the first join of the first
   night. Fixed via a `suppressed` gate ANDed into `_rebuild()`'s `requires` test — a bare
   `node.visible` write gets clobbered on every rebuild, which is the trap to know here.
4. **Visual gaps to the key art:** the lake has no water surface or reflection; tent interiors
   glow *inverted* (openings darker than canvas); cabin windows are flat rectangles with no spill;
   `ridge` is the "grey mush" failure `ART_DIRECTION §11` explicitly forbids.
5. ~~First-load weight~~ **DONE. `dist` is 22 MB** (was 59, then 46). `img/` went 27 MB → 2.3 MB
   and real cold transfer 17,815 KB → 6,694 KB, via `tools/optimise-images.mjs` — which sizes
   each image from the box `Menu.js` actually paints it into, **measured from the running DOM
   rather than read off the CSS**, and that corrected its own arithmetic twice. `keyart-*` is
   excluded by name; it is the calibration target. Six generated images are still not wired to
   anything (`icons-tools`, `icons-parts`, `mascot-sheet`, `hardware-plate`, two decals) and are
   deliberately left in the build rather than stripped — excluding an image that works in dev and
   404s in production the moment someone wires it is the worst kind of trap.
   **Do NOT repeat my mistake about `audio/`.** This entry used to say audio "still ships all 33
   beds up front", and I dispatched work against it. **False** — and the third stale claim in this
   file to send an agent after a non-problem. Audio was **already fully on-demand**: all six fetch
   sites in `src/audio/` are lazy, `index.html` has zero preload links, and the measured audio on
   the wire at the title screen was **985,683 B, not 14.6 MB.** `dist/audio` weighing 17 MB **on
   disk** is not 17 MB **on the wire**, and I conflated the two.
   The real defect there was narrow: `mayFetchGenerated()` gated tier 0 on `started`, which means
   "the AudioContext is running", **not** "a human touched the page" — so `music-title.mp3`
   (960,515 B) hit the wire at 6,491 ms against a reveal at 9,230 ms, competing with the splash
   art for the exact 2.7 s window the preloader exists to protect. Pre-reveal audio is now
   20,196 B. See §"measurement has lied" — the fix for that first landed WITH a regression
   (requiring a gesture made the title score never play at all), caught only by an adversarial
   verifier with an A/B control.

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
- **The preloader's ordering guarantee.** The title used to be painted 888 ms *before* its own
  background — a booklet floating against nothing. It now appears 7,772 ms *after* it, as one
  reveal of a finished composition. That gap is the feature, not latency to optimise away: the
  gate waits on a frame actually presented and on `splash-title.png` **decoded**, not merely on
  the engine reporting ready. Do not "improve" this by showing the title earlier. There is a
  640 ms floor so a warm cache still reads as a deliberate reveal rather than a flash.
- **The night auto-starting under the title screen is the HARNESS, not a bug.** `NightManager.init()`
  arms a 1.2 s auto-start so headless runs, screenshot harnesses and UI-less builds still play.
  `Menu`'s *constructor* disarms it — the only moment early enough, since every constructor runs
  before any `init()` — but **only when the URL carries no `shot`, `shots` or `nomenu` param**. So
  posing a capture legitimately starts the night: phase goes to `build`, the lamp lights, and
  `%warm` jumps. An agent hit this and reported the game "sometimes auto-starts underneath the
  title screen". It is working as designed. **Do not remove the auto-start** — without it every
  headless run renders a menu forever; and do not remove Menu's disarm, or the title screen is
  built, shown, and destroyed 1.2 s later by `night:begin`, which is precisely how it once went
  unseen.
- **`Menu.update()` already drifts the title camera** — a 4½-minute orbit at 27 m breathing ±2.4 m,
  with handheld noise, per `ART §11`'s "never let the frame be still". It yields to `Shots.active`
  so the capture harness always wins. Add light, not more camera.

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
