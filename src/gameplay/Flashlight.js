/**
 * THE LANTERN — the player's amber kerosene lamp.
 *
 * The class is called `Flashlight` because `ARCHITECTURE.md §9` and `main.js` say so. It is not
 * a flashlight. It is a pressure lamp with a brass fount, a sooted glass chimney, a wire bail
 * and a sheet-metal hood, and it is simultaneously the only reason the player can read the
 * manual and the single most likely reason they get caught.
 *
 * OWNER: Player agent. Owns exactly this file.
 *
 * ---------------------------------------------------------------------------------------------
 * PUBLIC API — the contract other agents code against
 * ---------------------------------------------------------------------------------------------
 *   const lamp = ctx.systems.get('Flashlight');
 *
 *   lamp.on                     bool    is the wick lit (true the instant ignition starts)
 *   lamp.lit                    bool    getter: on AND actually producing light
 *   lamp.toggle()                       tap: ignite (0.9 s) / douse (0.25 s). Emits noise:emit.
 *   lamp.setOn(bool) / ignite() / douse()
 *   lamp.intensity              0..~1.2 effective multiplier on nominal beam intensity.
 *                                       light.intensity === TUNING.coreIntensity * intensity
 *   lamp.fuel                   0..1    normalized fuel. lamp.fuelUnits is the 0..100 GDD value.
 *   lamp.addFuel(units)                 scavengeable refill. Default 45 (GDD §11.2). Returns added.
 *   lamp.refill()                       fill to capacity.
 *   lamp.light                  THREE.SpotLight  — the shadow-casting core. VolumetricFog reads
 *                                       this and samples its shadow map. Frustum: near 0.22,
 *                                       far = light.distance (26 open / 11.7 hooded), fov =
 *                                       2·angle. Three keeps far and fov in step with the beam
 *                                       for us; do not hand-set them.
 *   lamp.spill                  THREE.SpotLight  — shadowless 6% leak (ART_DIRECTION §3.2)
 *   lamp.glow                   THREE.PointLight — near-field: hands, held lumber, the page
 *   lamp.pageLight              THREE.SpotLight  — manual page bounce (ART_DIRECTION §3.2/§13.8)
 *   lamp.object                 THREE.Group      — the lantern mesh. World-space, spring-lagged.
 *
 *   --- THE HOOK (ART_DIRECTION §3.2 / keyart-site.png) ---------------------------------------
 *   lamp.hangAt(v3|Object3D)            hang it at an explicit world point until unhang()
 *   lamp.unhang()                       take it back
 *   lamp.hung                   bool    getter: hangBlend > 0.5
 *   lamp.hangBlend              0..1    0 = in the fist, 1 = on the hook
 *                                       Automatic at the build site — see D7.
 *
 *   --- THE HOOD (GAME_DESIGN §9.6, §11.2) --------------------------------------------------
 *   lamp.hoodLevel              0..1    0 = open (see far, be seen far). 1 = shuttered.
 *                                       ACCESSOR, not a field: assigning it moves the shutter
 *                                       TARGET too, so `lantern.hoodLevel = 1` sticks. See D9.
 *   lamp.setHood(level)                 set the shutter target directly (Campers/HUD may use it)
 *   lamp.hooded                 bool    getter: hoodLevel > 0.5 — the GDD's binary predicate
 *   lamp.hoodFactor             0..1    1.00 open → 0.18 fully hooded (GDD §9.4)
 *
 *   --- WHAT CAMPERS READ -------------------------------------------------------------------
 *   lamp.visibilityContribution 0..1    THE number. GDD §9.4 `flameVisibility` BEFORE the
 *                                       occlusion test. Instantaneous — it samples this frame's
 *                                       flicker, so a gutter is a real detection spike.
 *   lamp.illumination           0..1    GDD §11.2 `lum` contribution: 0.55 open, 0.22 hooded.
 *   lamp.flamePosition          Vector3 world position of the flame. DO NOT MUTATE. Copy it.
 *   lamp.getFlamePosition(out)          safe copy into your own vector.
 *   lamp.flameVisibilityFor(eye)        optional: does the §9.4 LOS ray via Physics for you.
 *   lamp.flameRateFor(eye, fovSens, diffMul)
 *                                       optional: the whole §9.4 `flameRate` formula, one call,
 *                                       so the constant never diverges between two files.
 *
 *   Flashlight.TUNING / lamp.TUNING     every number in one place.
 *
 * ---------------------------------------------------------------------------------------------
 * NUMBERS AND WHERE THEY COME FROM (nothing here is invented)
 * ---------------------------------------------------------------------------------------------
 *   ART_DIRECTION §3.2   core SpotLight #ffb865, decay 2, one shadow map; shadowless spill at
 *                        6% of the core. Intensity/angle/distance/carry offset are retuned
 *                        against the key art — see D4 for the measured numbers. Held low and
 *                        LEFT, aimed down and 4° left.
 *                        Flicker 1/f at 0.9 Hz ±7% plus a 40 ms hard dropout at 0.4%/s.
 *                        Fully hooded reads at 0.10 intensity, reached over 0.12 s.
 *   AUDIO_DIRECTION §4.2 the lantern's flicker LFO sits at 11.5 Hz. That is the third octave.
 *   GAME_DESIGN §11.2    fuel 100 units, burn 0.55/s open, 0.22/s hooded, can restores 45,
 *                        ignite 0.9 s, douse 0.25 s, lum +0.55 / +0.22, below 15 units the
 *                        flame gutters 0.6–1.0 at 3 Hz and the flicker IS a detection spike.
 *   GAME_DESIGN §9.4     hoodFactor 0.18, flame visible to 180 m, R_flame exponent 1.1,
 *                        flameRate = 0.36 * 0.55 * flameRangeF * flameVisibility * fovSens.
 *   GAME_DESIGN §9.6     hood: cone 35%, intensity 40%, burn 0.22/s. Douse click radius 5.
 *
 * The two hood curves are deliberately different exponents and this is the whole mechanic:
 *
 *     beam / lum   fall as  h^1.35   — back-loaded: you keep most of your working light until
 *                                      the shutter is nearly closed
 *     hoodFactor   falls as h^0.80   — front-loaded: the first third of the shutter buys a
 *                                      disproportionate amount of darkness
 *
 * So a half-hood is genuinely the best trade in the game, which is the only justification for
 * making the shutter analog instead of a toggle. Both curves land exactly on the documents'
 * endpoints at h = 1: beam 0.10 (ART), lum 0.55 × 0.40 = 0.22 (GDD), hoodFactor 0.18 (GDD).
 *
 * ---------------------------------------------------------------------------------------------
 * DOCUMENTED DEVIATIONS (flagged, not hidden)
 * ---------------------------------------------------------------------------------------------
 *   D1  The toggle click emits `kind:'brush'` at radius 5, intensity 0.10. GAME_DESIGN §9.6
 *       specifies "the click is radius 5" but the canonical twelve `noise:emit` kinds contain
 *       nothing metallic and quiet. This follows the precedent AUDIO_DIRECTION §1.2 C4 set for
 *       the player's breathing: take the nearest canonical kind campers actually respond to,
 *       keep the document's radius, and say so out loud. Owner to resolve: Director agent.
 *   D2  ART_DIRECTION §3.2 puts the lantern in the LEFT hand; the brief for this file said
 *       lower-right. ART_DIRECTION is a binding rank-3 document and it is also mechanically
 *       right (GAME_DESIGN §4.3 keeps the right hand for the mallet), so left wins. It is one
 *       number: TUNING.handOffset.x, or call setHandOffset().
 *   D3  sfx ids `lantern_ignite` / `lantern_douse` / `lantern_hood` / `lantern_unhood` /
 *       `lantern_refuel` / `lantern_gutter` do not yet exist in AUDIO_DIRECTION's recipe list.
 *       They are emitted anyway; an unknown id is a no-op in AudioEngine. Owner: Audio agent.
 *
 *   D4  ART_DIRECTION §3.2 says core intensity 40 cd, angle 0.42, distance 14. Shipped at
 *       105 / 0.78 / 26. This is measured, not preferred. Captured `?shot=site-close` at
 *       1600×900 and sampled mean relative luminance of the stud band (studs 3.5–8 m from the
 *       flame) against `public/img/keyart-site.png`'s lit post:
 *
 *           key art reference ......... 0.048
 *           40 cd  / 14 m (as spec'd) . 0.0116     ← the frame is not legible, at all
 *           90 cd  / 26 m ............. 0.0292
 *           150 cd / 26 m ............. 0.0486     ← lands on the reference
 *           240 cd / 26 m ............. 0.0816     ← past it
 *
 *       Widening the cone from 0.42 to 0.78 rad then roughly doubled the band again on its
 *       own — at 0.42 the frame was simply outside the beam, penumbra and all — so the
 *       shipped figure came down from 150 to 105. Verified at the end: stud 0.124, sill
 *       0.114, ground pool 0.031, far mud 0.004 against the key art's 0.048 / 0.070 / 0.024
 *       / 0.005, measured while Postprocessing was running ~3× the spec'd exposure. Divide
 *       by that and 105 cd lands on the reference. **If Render restores exposure to §3.1's
 *       0.62 and the frame reads dim, this number is the one to raise, and 150 is where the
 *       clean 0.62-exposure sweep above put it.**
 *
 *       The 40 cd figure was never wrong as a *physical* number — a hurricane lamp really is
 *       ~40 cd — it was wrong against this renderer's exposure and AgX curve, which is what
 *       §3.1's own instruction to "only tune with a screenshot to justify it" is for.
 *       distance 14 additionally cut the far studs by a further 20% via the Frostbite window.
 *       Owner to reconcile in ART_DIRECTION §3.2: Render agent.
 *
 *   D5  `glow` used to sit exactly on the flame, i.e. 3 cm from the lamp's own brass. It is now
 *       0.40 m out along the aim, which is where the hands and the carried lumber actually are.
 *
 *   D7  THE LANTERN WAS COINCIDENT WITH THE CAMERA, so it could not cast a visible shadow.
 *       MEASURED at the `site-close` eye: core SpotLight at (-136.42, 18.20, 131.74), camera at
 *       (-135.5, 18.7, 132.0). 1.07 m from the eye, 0.50 m below it, aimed where the camera
 *       aims. It is a real shadow-casting light — 105 cd, 2048 map — and every shadow it threw
 *       landed directly BEHIND the geometry throwing it, where the camera cannot see it. Zero
 *       cast shadows were visible in any of the twelve canonical frames.
 *
 *       Two changes, and they are different fixes to the same fact:
 *
 *       (a) CARRIED. `handOffset` (-0.40,-0.42,-0.66) → (-0.54,-0.74,-0.38) and a new
 *           `lightDrop` of 0.16 m under the aim line. Further out to the side, much further
 *           below the eye, and much less far in FRONT — forward offset is the one axis that
 *           buys no parallax at all, it only moves the light closer to the thing it is lighting.
 *           `aimTau` 0.085 → 0.26 so the beam lags the look instead of tracking it rigidly.
 *
 *       (b) HUNG, which is the actual key art. `keyart-site.png` derives its whole composition
 *           from a lamp on a post at the corner of the plot, ~2 m up and ~10 m from the eye,
 *           raking metre-long shadows off the studs and across the joists. No hand-carried lamp
 *           produces that image. So the lamp now goes ON THE HOOK when the player is working at
 *           the plot: position and aim become fixed WORLD values with no camera term in them at
 *           all, intensity ×2.3 to pay the extra inverse-square, and the aim points from the
 *           hook at the middle of the deck. `CabinSite._gLanternPost()` already builds the post
 *           and its three hooks; see TUNING.hookLocal for how the position is recovered and the
 *           TODO(api) that should replace it.
 *
 *       MEASURED, `?shot=site-close&quality=ultra`, 1600×900, four captures at one camera
 *       (-135.5, 18.68, 132.0), the lantern's shadow map toggled on and off in each config, ROI
 *       x∈[460,1220] y∈[380,840], each frame normalised to its own ROI p99.5 so the
 *       auto-exposure meter cannot fake the result:
 *
 *                              light→eye    of the lantern-lit area, how much is
 *                                           ≥4× darker with its shadow map on
 *           before (in the fist)  1.068 m    3.6%   (2.4% at ≥10×)   ← the defect
 *           after  (on the hook)  9.843 m   57.9%  (50.4% at ≥10×)
 *
 *       16× more of the lit frame is genuinely occluded. The before run reproduces the
 *       reported light position to the centimetre, (-136.42, 18.19, 131.74), which is how we
 *       know the two rows are the same measurement.
 *
 *       That hand-off was wrong about one thing — this file CAN reach it, by not using the post
 *       at all — and the 57.9% is measuring the defect, not the fix. See D10.
 *
 *   D10 THE HUNG LAMP WAS BEHIND THE BUILDING, and it turned the frame into a silhouette.
 *       D7 hung the lamp on `_gLanternPost`, which stands at site-local (-3.75, -1.95): the
 *       -x -z corner. Every framing of this site looks in from +x +z (`site-close` +4.5/+4.0,
 *       `site-wide` +18/+16, `lightning` +26/+24, `manual` +6/+5). So the lamp was diagonally
 *       opposite the eye, back-lighting the stud wall, and the frame read as a black cut-out
 *       against pale fog with warm light leaking between the studs.
 *
 *       The number that caught it is `%warm` — pixels with R-B > 12 in the delivered sRGB frame,
 *       reported by `tools/luma.mjs`. It is the only figure in the tone contract that notices
 *       WHERE the warm light landed, and it collapsed while every other row stayed in spec:
 *
 *           keyart-site.png (the reference) ...... 22.0%
 *           final-siteclose.png (3 h earlier) .... 19.6%
 *           now-siteclose2.png (the regression) ... 0.7%   ← meanY 0.0182, contract PASS
 *
 *       FIX: `hookLocal` is now a composition measured against the eye rather than a hook
 *       reconstructed from someone else's post. See the comment on it for the four numbers it
 *       is built from. Retuned with it: `hangIntensityMul` 2.6 → 0.62 (the lamp is now 6.8 m off
 *       the eye instead of 9.8 m and 1.35 m off the near studs instead of ~4.5 m — inverse
 *       square, not taste), `hangDown` 0.72 → 0.10 (at 0.72 the aim left the hook 73° below
 *       horizontal and the top plate sat 105° off a 63.5° cone, so the whole upper wall got
 *       nothing but spill — captured and looked at, it was black; at 0.10 the aim is 33° down
 *       and the cone covers the wall to about 2.8 m, with the last 300 mm under the eave falling
 *       off, which reads as the eave shadow it geometrically is), and the hung spill multiplier
 *       1.8 → 0.30 (it is SHADOWLESS; at 1.35 m from the studs it fills in the very shadows the
 *       hook exists to cast).
 *
 *       MEASURED, `?shot=site-close&quality=ultra`, 1600×900, one page load, one camera
 *       (-135.5, 18.675, 132.0), the hook moved between captures with `hangAt()` and everything
 *       else — tuning, fuel, weather, seed — identical:
 *
 *                                          %warm    meanY    p99.9
 *           hook at the post (D7's) ........ 0.9%   0.0183   0.321   ← reproduces the regression
 *                                                                     frame (0.7% / 0.0182)
 *           hook on the camera side ........ 14.3%  0.0262   0.903
 *           …a second capture of the same ... 20.2%  0.0266   0.753   ← the ±6 pt spread is the
 *                                                                     flame flicker, not drift
 *
 *       CAST SHADOWS, same pair, the lantern's shadow map toggled on and off at each hook, each
 *       frame normalised to its own p99.5 so the meter cannot fake it, over the pixels the lamp
 *       actually lights:
 *
 *                              ≥4× darker   ≥10×    meter drift, shadows on vs off
 *           hook at the post ..... 17.4%     4.0%    0.350×   ← the frame is 2.9× darker with
 *                                                              shadows ON, because the light is
 *                                                              occluded from the eye. That is
 *                                                              the defect inflating the metric.
 *           camera-side hook ...... 5.9%     3.5%    1.047×   ← exposure barely moves
 *
 *       So shadow COVERAGE went down and this is still the right trade: at the post, most of the
 *       "lit area" was behind the building. Where the surviving shadows land, from the mask:
 *       stud shadows striped across the interior and the far wall's inner face (≥4×, read
 *       through the near wall's gaps), the platform's shadow on the ground in front of it and
 *       the frame's shadow on the open ground east of the plot (2–4×).
 *
 *       KNOWN LIMIT, and it is geometry, not tuning: with the lamp on the +z side of the plot,
 *       every shadow the FRAME throws goes to -z, i.e. behind the wall the eye is looking at.
 *       `keyart-site.png` gets its long ground shadows because at that build state there is no
 *       wall — it is piers, joists and four posts. `?shot=site-close` stands the cabin to night
 *       4. Ask for the keyart composition with `?shot=site-close&build=2`.
 *
 *   D11 A POSED SHOT WAS NOT REPRODUCIBLE OVER A SESSION, because the wick burns. See the
 *       comment in `_stepFuel()`: at 30 s the site-close lamp is 63.2 cd and at ~5 min it is
 *       26.5 cd with `_flameHealth` 0.46, which is a 2.4× swing in the only light in the frame
 *       and a third of its warm pixels, from elapsed time alone. Three captures I took late in a
 *       session read %warm 9.4–9.9 where the same build reads 14–20 fresh. The tank is now held
 *       full while `Shots.active` is set.
 *
 *   D8  A NUMERICALLY OVERFLOWED NODE, live in the scene graph: the 'lantern-page-bounce'
 *       SpotLight was measured at world Y = -7.02e+99. Root cause is a latch, not a divergence:
 *       its transform was written ONLY inside `if (page.visible)`, so a single frame in which
 *       `camera.matrixWorld` was garbage (teleport, respawn, a zero-dt divide upstream) was
 *       enough to stamp a poisoned position into a node that then went invisible and was never
 *       corrected again. `visible:false` hides it from the eye but not from any bounding volume
 *       computed through it, which is Infinity, which silently breaks frustum culling and shadow
 *       bounds. Fixed three ways: write the transform every frame regardless of visibility,
 *       reject a non-finite camera matrix before it can be latched, and `_guardLights()` — a
 *       per-frame finiteness sweep over all seven owned transforms.
 *
 *   D9  HOODING THE LANTERN DID NOTHING, and the measurement is unambiguous: same camera,
 *       forest-deep (hood 0) mean luminance 0.0699 vs forest-hooded (hood 1) 0.0710 — the
 *       HOODED frame was 1.6% brighter — with an identical lantern-glass peak, 0.6671 vs
 *       0.6667. Three independent causes, all now fixed:
 *
 *       1. `hoodAimPitchDeg` was -31°, which aimed the hooded beam at ground 1.5 m away. Under
 *          decay 2 that hands back more screen luminance than the open beam ever threw into the
 *          far trees, which is most of how "hooding" came out BRIGHTER. Now -12°.
 *       2. The hood only ever took the CORE. The spill survived at 50%, the near-field glow at
 *          40%, and the flame / halo / chimney-glow / chimney-sheen meshes did not move at all
 *          — which is exactly why the lantern-glass peak was the same number twice: the
 *          brightest object in the "hooded" frame was an unshuttered flame. A shutter is a
 *          piece of sheet metal over the chimney and it now takes all of them
 *          (`hoodSpillMul`, `hoodGlowMul`, `hoodEmissiveMul`).
 *       3. `hoodLevel` was a plain field, so an external assignment (`Shots.js` does exactly
 *          that) survived only until `_stepHood` next ran and walked it back toward
 *          `_hoodTarget`. In the harness that happened to come out at h≈0.97 because Shots is
 *          registered last and re-pins the value every frame — so this was NOT the cause of
 *          the measured defect, and it is fixed anyway: the accessor makes an assignment mean
 *          what the caller obviously meant, which matters for HUD and for Campers' reflex hood
 *          where nothing re-pins it.
 *
 *       MEASURED after the fix, `?shot=forest-deep&quality=ultra`, 1600×900, both frames at one
 *       camera (-20, 25.70, 40) with only `hood` changed, meter drift 0.90× (i.e. negligible):
 *
 *                                    hood 0     hood 1     ratio
 *           frame mean luminance     0.01427    0.00413    3.46× darker  (was 0.0699 / 0.0710,
 *                                                                        i.e. 1.6% BRIGHTER)
 *           frame p99                0.2452     0.0739     3.32×
 *           lantern peak             0.9719     0.2696     3.60×  (was 0.6671 / 0.6667)
 *           lit foreground ground    0.03099    0.00027   104×
 *           mean |ΔL| whole frame               0.01189           (was 0.0166 of pure noise)
 *
 *       and on the light side, same pair: core 105.45 → 10.65 cd, cone 0.780 → 0.273 rad,
 *       range 26 → 7.8 m, spill 6.026 → 0.426, near glow 1.105 → 0.201, flame mesh opacity
 *       1.000 → 0.090, chimney emissive 1.306 → 0.119, halo 0.341 → 0.031,
 *       `visibilityContribution` 1.000 → 0.180 (GDD §9.4's hoodFactor exactly) and
 *       `illumination` 0.550 → 0.220 (GDD §11.2's lum exactly). The stealth verb is live.
 *
 *       ADDENDUM, re-measured on the current build: **do not judge the hood by the whole-frame
 *       mean.** With a closed-loop auto-exposure meter in the pipe, killing the frame's dominant
 *       light source makes the meter open up, and the mean can go UP while the verb works
 *       perfectly. `?shot=forest-deep` vs `?shot=forest-hooded&quality=ultra`, 1600×900, only
 *       `hood` differs:
 *
 *                                              hood 0    hood 1     ratio
 *           foreground ground the lamp lights  0.08664   0.00958    9.0× DARKER
 *           …its warm-pixel share               97.8%      0.0%
 *           canopy + fog, moonlit only         0.00844   0.01405    1.67× brighter  ← the meter
 *           far fog wall, moonlit only         0.11322   0.20599    1.82× brighter  ← the meter
 *           WHOLE FRAME MEAN                   0.02998   0.03503    1.17× BRIGHTER
 *
 *       The 1.6%-brighter figure this note opens with was measured the same way as that 1.17×,
 *       and that metric cannot tell a dead hood from a live one: it moves with the meter, not
 *       with the lantern. The instrument that answers the question is a rectangle over what the
 *       lamp actually lights, plus the warm-pixel share. HAND-OFF, Render: if the spec wants the
 *       hooded FRAME darker and not just the hooded GROUND darker, that is the auto-exposure
 *       adaptation rate in Postprocessing, not anything in this file — and a meter that recovers
 *       1.7× the instant the player hoods is also a gameplay question, because it hands most of
 *       the darkness straight back.
 *
 *   D6  THE BLOWN-WHITE LANTERN, and it was not the emissives. All three emitters used to sit
 *       ON the flame — 24 mm from the chimney glass, 30 mm from the brass, and (after the cone
 *       widened to 0.78 rad) with that glass INSIDE the cone. Three's distance attenuation is
 *       `1 / max(pow(d, decay), 0.01)`, i.e. it saturates at 100×, so the core delivered an
 *       irradiance of ~10 500 to its own chimney. Measured proof: sweeping the emissive stack
 *       over a 200:1 range — flameHdr 0.28 → 60, glassEmissive 0.22 → 25 — moved the lamp's
 *       mean relative luminance only 0.164 → 0.214 and its peak not at all (0.273 ± 0.005 in
 *       every single capture). The lamp was pinned against a clip that had nothing to do with
 *       any number in this file's emissive block. `lightOffset` is the actual fix.
 */

import * as THREE from 'three';
import { Log } from '../core/Log.js';
import { Rand } from '../core/Rand.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* ==============================================================================================
 * Module-scope scratch. ARCHITECTURE.md §12: no allocation in update().
 * ============================================================================================ */
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _v3d = new THREE.Vector3();
const _v3e = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _e1 = new THREE.Euler(0, 0, 0, 'YXZ');
const _e2 = new THREE.Euler(0, 0, 0, 'YXZ');
const _colA = new THREE.Color();
const _colB = new THREE.Color();
const _colC = new THREE.Color();

const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;
/** Frame-rate independent exponential approach. */
const approach = (dt, tau) => 1 - Math.exp(-dt / Math.max(1e-4, tau));

/* ==============================================================================================
 * TUNING — every constant, one place, exported so a tuner never has to read the class.
 * ============================================================================================ */
export const TUNING = {
  /* --- colour ------------------------------------------------------------------------- */
  flameColor: 0xffb865,          // ART_DIRECTION §2.3 `lantern`
  flameColorLow: 0xff5f18,       // what a starved wick reddens to
  pageColor: 0xf2efe6,
  glassColor: 0xc0b49c,          // warm bone, not the old cool green-grey
  glassOpacity: 0.26,            // you have to be able to SEE the flame through it
  // The chimney's own glow colour, which is NOT the beam's colour. Authored deliberately
  // over-saturated: measured, this stack desaturates hard on the way to the screen. The
  // chimney at #ffd9a8 (the key art's own sampled hue, sRGB 226/190/157) came back at
  // sRGB 105/100/97 — dead neutral, the grey blob. At #ff9c3a it comes back warm. So this
  // is a pre-compensated authoring value, not a display value, and that is why it does not
  // match the swatch you would pick off the reference with an eyedropper.
  glassGlowColor: 0xff9c3a,

  /* --- how far above 1.0 the emissive bits sit before AgX -------------------------------
   * The flame is a 4 mm teardrop. To read as fire rather than as an orange decal it has to
   * clip; to stop the whole lamp reading as a white blob, only the flame may. So the wick
   * gets a hard over-range, the halo and the chimney stay under it. */
  flameHdr: 1.8,
  haloHdr: 0.80,
  sheenHdr: 0.85,
  glassEmissive: 1.3,

  /* --- core spot (ART_DIRECTION §3.2, retuned — see D4) ------------------------------- */
  coreIntensity: 105,            // D4. 40 cd lit nothing; measured, see D4.
  coreAngle: 0.78,               // 44.7° half-angle: a lantern is a point source, not a torch
  corePenumbra: 0.62,            // no visible cone edge anywhere in the key art
  coreDistance: 26,              // the 14 m cutoff was clipping the beam at the far studs
  decay: 2,
  shadowNear: 0.22,              // the lamp's own body sits at 0.03–0.10 m: inside near, never a caster
  shadowFar: 28.0,               // >= coreDistance, or SpotLightShadow's far plane eats the beam
  shadowBias: -0.00075,
  shadowNormalBias: 0.028,

  /* --- shadowless spill: real lanterns leak ------------------------------------------- */
  spillIntensity: 6,             // ART's 6% of the core. It is shadowless, so every extra
                                 // candela here is contrast the frame does not get back.
  spillAngle: 1.30,              // 74.5°: this is what puts light on the ground at your boots
  spillPenumbra: 1.0,
  spillDistance: 16,

  /* --- HUNG: the key-art state (see D7) -----------------------------------------------
   * `keyart-site.png` is composed entirely around a lamp hanging on the post at the corner
   * of the plot, ~10 m from the eye and ~2 m up, raking across the joists. A lamp in the
   * fist 1 m from the eye cannot produce that image no matter what its intensity is, because
   * every shadow it throws lands behind the thing throwing it. */
  hangEnabled: true,
  hangRadius: 12.0,              // he hangs it when he is at the plot, not before
  hangHysteresis: 1.6,           // metres of dead band so a step does not flap the state
  hangSpeed: 1.6,                // walking faster than this and he takes it back off the hook
  hangBlendSeconds: 0.55,        // the reach up / lift down, and the only time the rig teleports
  // D10. The hook moved from 9.8 m off the eye to 5.5 m, and from 4.5 m off the near stud wall
  // to 1.9 m. Inverse square does the rest: this number was 2.6 to pay for a 10 m throw and at
  // the new distance the same figure is a five-stop overexposure of the near studs. Measured by
  // sweep, see D10's table.
  hangIntensityMul: 0.62,
  // The spill is SHADOWLESS. At 9.8 m it was a faint ambient wash; at 1.9 m from the studs the
  // same candela figure is 26x the irradiance and it fills in every shadow the core throws,
  // which is the whole point of hanging the lamp. It goes DOWN on the hook, not up (it used to
  // be a hardcoded x1.8).
  hangSpillMul: 0.30,
  // A hurricane lamp on a post is very nearly omnidirectional, and the composition depends on
  // it: the pool is centred UNDER the lamp and the studs, which stand ABOVE it, rake their
  // shadows radially outward across the deck and away into the pines. A 0.67 rad cone aimed
  // across the plot lights a stripe and shadows nothing.
  // 1.11 rad = 63.5° half-angle. Higher covers more plot but the shadow camera's fov is 2·angle
  // and a 145° perspective shadow map is mush; 127° is the honest ceiling. Texel at 10 m ≈ 20 mm
  // against a 90 mm stud, which is three texels of penumbra — enough to read as a shadow edge.
  hangAngleMul: 1.42,
  // How much of the hung aim is straight DOWN versus across the plot. At 0.72 the beam left the
  // hook 73 degrees below horizontal; with the hook now 1.9 m from the stud wall and only 1.3 m
  // above its mid-height, the wall sat 69 degrees off the aim — outside a 63.5 degree cone, so
  // the near studs got the spill and nothing else. At 0.45 the aim leaves 53 degrees below
  // horizontal, the wall is 50 degrees off it, and the pool still lands on the ground.
  hangDown: 0.10,
  hangDistanceMul: 1.5,          // 39 m — the far mud has to still be inside the window
  hangSwayHz: 0.23,              // a 0.22 m lamp on a wire bail is a ~2 s pendulum; wind drives it
  hangSwayRad: 0.055,
  /**
   * WHERE THE LAMP HANGS, in CabinSite's own group space (that group is axis-aligned — its yaw
   * is 0 and nothing writes it — so these are world offsets from `CabinSite.center`).
   *
   * This is NOT the hook on `CabinSite._gLanternPost()`. That post is at local (-3.75, -1.95),
   * i.e. the -x -z corner, and every framing that exists of this site (`site-close` +4.5/+4.0,
   * `site-wide` +18/+16, `lightning` +26/+24, `manual` +6/+5) looks in from +x +z. A lamp on
   * that post is diagonally OPPOSITE the eye: it lit the far faces, back-lit the stud wall, and
   * turned the frame into a silhouette with warm light leaking between the studs. See D10.
   *
   * The number below is a composition, measured against the eye and the geometry (all figures
   * site-local; the `site-close` camera resolves to (4.5, 1.60, 4.0), verified at runtime):
   *   - 1.35 m OUTSIDE the south stud wall's outer face (z = 1.65). Across the run of wall the
   *     camera actually reads, the lamp is 0-58 deg off that wall's own normal where the CAMERA
   *     is 62 deg off it — the lamp is squarer to the timber than the eye is, which is what
   *     "modelled" means, and it is the whole difference between this and D10.
   *   - 6.82 m from the eye, and 112 deg away from it as seen from the middle of that wall, so a
   *     stud's shadow is displaced across the line of sight instead of hiding behind itself.
   *   - 2.35 m up — 1.73 m above the 0.62 m deck, so the studs rake outward from below the top
   *     plate and the ground pool sits under the lamp at frame-left, as in `keyart-site.png`.
   *   - lands at 24% across a 1600 px frame (px 388, py 304): in shot, off to one side, not
   *     behind the building.
   * West of this the wall's east third goes to the spill alone; east of it the lamp swings round
   * to graze the wall and the studs stop reading. Closer in than ~1.2 m the near stud is a hot
   * patch and the rest of the wall is 17x down on it.
   *
   * NOTE(api): if CabinSite ever publishes `lanternHook`, it must be on the +z side of the
   * plot or it will re-introduce D10. `hookPreferPublished` below is the switch, and it is off
   * for exactly that reason.
   */
  hookLocal: new THREE.Vector3(-2.20, 2.35, 3.00),
  /**
   * Whether a `CabinSite.lanternHook` / `.hookPosition`, if one appears, outranks `hookLocal`.
   * FALSE, deliberately: the only hook that system models today is the one that caused D10, and
   * a silent regression on someone else's commit is not a trade worth making at this hour. Flip
   * it once CabinSite's published hook is on the camera side of the frame.
   */
  hookPreferPublished: false,

  /* --- near-field glow: the player's own hands and the lumber in them ------------------ */
  glowIntensity: 1.1,
  glowDistance: 3.2,
  glowForward: 0.40,             // pushed clear of its own chimney — see D5

  /* --- THE ONE THAT MATTERED (D6) -----------------------------------------------------
   * How far along the aim the emitters sit, ahead of the physical flame. Three's
   * getDistanceAttenuation is `1 / max(pow(d, decay), 0.01)`, so attenuation SATURATES at
   * 100× — and the lamp's own chimney glass is 24 mm from the wick and inside the cone.
   * 105 cd × 100 = an irradiance of 10 500 on a piece of glass, which clips to white, loses
   * its hue, and is then spread by the defocus into exactly the grey blob this pass exists
   * to kill. Nothing in the emissive stack ever mattered; this number did.
   *
   * At 0.26 m the whole lamp is BEHIND the cone apex — >90° off the aim, so the spot
   * attenuation is a hard zero and the lamp cannot light itself at all. The visible
   * consequence at 5 m is a 3% shift in beam origin, i.e. none. `flamePosition`, which is
   * what Campers see and what the audio pans on, still tracks the real wick.
   */
  lightOffset: 0.26,

  /**
   * ...and how far BELOW the aim line, which is the other half of D7. The emitter belongs at
   * the height of a lamp hanging from a fist, not at the height of the eye. Everything it
   * lights then has a bottom-up shadow direction (ART_DIRECTION §3.2's hard rule) and the
   * shadow lands somewhere the camera can actually see it.
   */
  lightDrop: 0.16,

  /* --- manual page bounce (ART_DIRECTION §3.2 row 9) ---------------------------------- */
  pageIntensity: 3.0,
  pageAngle: 1.2,
  pagePenumbra: 1.0,
  pageDistance: 2.2,

  /* --- where it is carried (ART_DIRECTION §3.2, hard rule) ---------------------------- */
  // Still low and LEFT, but at arm's length and hanging, not shoved into the lens. At 0.45 m
  // the 0.22 m lamp subtended 27° of a 72° FOV — a sixth of the frame. At 0.87 m and 0.84
  // scale it subtends 12°, which is where a carried hurricane lamp actually reads.
  // Measured before/after (camera at the `site-close` eye): the emitter used to sit 1.07 m
  // from the eye with only 0.50 m of that below eye level and 0.92 m lateral. A light that
  // close to the eye, at eye height, aimed where the eye aims, is a light whose every shadow
  // falls behind the caster. Dropped and pushed out to the side; see also `lightDrop`.
  handOffset: new THREE.Vector3(-0.54, -0.74, -0.38),
  meshScale: 0.84,
  stowOffset: new THREE.Vector3(-0.12, -0.20, 0.16),   // added when both hands are full
  aimPitchDeg: -22,              // 22° down: the pool has to reach the ground inside 2.5 m
  aimYawDeg: 11,                 // 11° left — the beam is not the crosshair
  hoodAimPitchDeg: -12,          // extra downward pitch at full hood.
                                 // MEASURED: at -31 the hood aimed the beam at ground 1.5 m
                                 // away, where decay 2 hands back more screen luminance than
                                 // the open beam ever threw into the far trees, so "hooding"
                                 // came out 1.6% BRIGHTER. The hood must not become a floodlight
                                 // pointed at your boots.

  /* --- fuel (GAME_DESIGN §11.2) ------------------------------------------------------- */
  fuelCapacity: 100,
  burnOpen: 0.55,                // units/s → 3:02
  burnHooded: 0.22,              // units/s → 7:35
  canRestores: 45,
  lowFuelUnits: 15,
  gutterHz: 3.0,                 // the low-fuel gutter frequency
  gutterFloor: 0.60,             // low-fuel instantaneous range is 0.60..1.00
  blowoutUnits: 4.0,             // below this a gutter in real wind can put the wick out
  blowoutChance: 0.18,

  /* --- transitions -------------------------------------------------------------------- */
  igniteSeconds: 0.9,
  douseSeconds: 0.25,
  hoodSeconds: 0.42,             // player shutter travel
  hoodPanicSeconds: 0.12,        // ART_DIRECTION §3.2 reflex hood
  tapSeconds: 0.22,              // tap-vs-hold discriminator on Input 'lantern'

  /* --- the hood, as curves (see header) ----------------------------------------------- */
  lumOpen: 0.55,
  hoodLumMul: 0.40,              // GDD §11.2 `lum`: 0.55 open → 0.22 hooded. Reported only.
  hoodBeamMul: 0.10,             // ART §3.2: the beam falls to 0.10
  hoodConeMul: 0.35,             // GDD §9.6: the cone falls to 35%
  hoodDistMul: 0.30,             // 26 m → 7.8 m. The Frostbite window is part of the shutter.
  hoodFactorMin: 0.18,
  hoodVisExp: 0.80,
  hoodIntExp: 1.35,
  /* The three that were missing, and their absence is why the hood measured as a no-op:
   * a shuttered hood is a piece of sheet metal over the chimney, so it must take the LEAK,
   * the NEAR-FIELD FILL and the LAMP'S OWN GLOW down with the beam. Before this, the spill
   * only fell to 50%, the near glow to 40%, and the flame/halo/chimney meshes did not move at
   * ALL — which is why the measured lantern-glass peak was identical open vs hooded
   * (0.6671 vs 0.6667). Those three sources are most of what the hooded frame is made of. */
  hoodSpillMul: 0.07,
  hoodGlowMul: 0.18,
  hoodEmissiveMul: 0.09,         // flame, halo, chimney glow, chimney sheen

  /* --- flicker ------------------------------------------------------------------------ */
  octaveHz: [0.9, 3.7, 11.5],
  octaveAmp: [0.055, 0.022, 0.010],   // ±0.087 at rest ≈ ART's ±7%
  moveGain: 2.4,                      // flicker amplitude vs normalized speed
  windGain: 1.1,
  microChancePerSec: 0.004,           // ART: 40 ms hard dropout at 0.4%/s
  microSeconds: 0.04,
  microDepth: 0.72,
  majorChancePerSec: 0.020,           // the rare big gutter, scaled by wind/speed/low fuel
  majorSecondsMin: 0.22,
  majorSecondsMax: 0.55,
  majorDepthMin: 0.42,
  majorDepthMax: 0.70,
  flickerMin: 0.16,
  flickerMax: 1.22,

  /* --- carriage: the spring that keeps it off the camera ------------------------------ */
  springK: 96,                   // rad²/s² — stiffness of the hand chase
  springZeta: 0.42,              // deliberately under-damped: it swings
  springSnapDist: 1.2,           // teleport guard
  aimTau: 0.26,                  // beam lags the look by this time constant. 0.085 was fast
                                 // enough to read as bolted to the view — the classic amateur
                                 // -FPS tell. A carried lamp arrives where you looked a third
                                 // of a second ago and it is never quite pointed at the middle.
  swingPitchGain: 2.4,
  swingRollGain: 3.0,
  swingMaxRad: 0.34,
  bobAmplitude: 0.021,
  bobHz: 1.9,
  footImpulse: 0.75,
  refSpeed: 3.4,                 // speed that counts as "running" for flicker/swing

  /* --- noise (D1) --------------------------------------------------------------------- */
  clickKind: 'brush',
  clickRadius: 5,
  clickIntensity: 0.10,
  shutterRadius: 3,
  shutterIntensity: 0.06,
};

/** GAME_DESIGN §9.4 — the flame percept, kept here so only one file owns the constants. */
export const FLAME_DETECTION = {
  K: 0.36,
  flameWeight: 0.55,
  range: 180,
  rangeExp: 1.1,
  noiseFloor: 0.02,
};

/* ==============================================================================================
 * The class
 * ============================================================================================ */
export class Flashlight {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx?.bus ?? null;
    this.scene = ctx?.scene ?? null;
    this.camera = ctx?.camera ?? null;
    this.settings = ctx?.settings ?? null;
    this.state = ctx?.state ?? null;

    /** @type {typeof TUNING} */
    this.TUNING = TUNING;

    // ---------------------------------------------------------------- public state
    this.on = false;
    /** Backing field for the `hoodLevel` accessor. See the setter — it is load-bearing. */
    this._hood = 0;
    this.fuel = 1;
    this.intensity = 0;
    this.visibilityContribution = 0;
    this.illumination = 0;
    this.hoodFactor = 1;
    this.flamePosition = new THREE.Vector3();
    /** Live flame colour, recomputed each frame. Read by _applyMesh(). */
    this._flameColorNow = new THREE.Color(TUNING.flameColor);
    /** Live chimney-glow colour — whiter than the flame. See TUNING.glassGlowColor. */
    this._glassColorNow = new THREE.Color(TUNING.glassGlowColor);

    /** @type {THREE.SpotLight|null} */ this.light = null;
    /** @type {THREE.SpotLight|null} */ this.spill = null;
    /** @type {THREE.PointLight|null} */ this.glow = null;
    /** @type {THREE.SpotLight|null} */ this.pageLight = null;
    /** @type {THREE.Group|null} */ this.object = null;

    this.stats = {
      fuelUnits: TUNING.fuelCapacity,
      flicker: 1,
      hood: 0,
      visibility: 0,
      speed: 0,
      wind: 0,
      hang: 0,
    };

    // ---------------------------------------------------------------- internals
    this._fuelUnits = TUNING.fuelCapacity;
    this._ignite = 0;              // 0..1 wick ramp
    this._hoodTarget = 0;
    this._hoodRate = TUNING.hoodSeconds;
    this._flicker = 1;
    this._flameHealth = 1;

    this._gutter = { t: 0, dur: 0, depth: 0 };
    this._micro = { t: 0 };

    this._speed = 0;               // player speed, m/s
    this._speedNorm = 0;
    this._windNorm = 0;
    this._crouched = false;
    this._carryStow = 0;           // 0 = hand free, 1 = both hands full, lamp goes to the belt
    this._carryStowTarget = 0;

    this._handIdeal = new THREE.Vector3();
    this._carryIdeal = new THREE.Vector3();   // hand, or the hook, or somewhere between
    this._lagPos = new THREE.Vector3();
    this._lagVel = new THREE.Vector3();
    this._aimDir = new THREE.Vector3(0, 0, -1);

    // --- the hung state (D7)
    this._hung = false;
    this._hangBlend = 0;               // 0 = in the fist, 1 = on the hook
    this._hookPos = new THREE.Vector3();
    this._hookValid = false;
    this._hookAim = new THREE.Vector3(0, -1, 0);
    this._hookCheck = 0;               // seconds until the next CabinSite poll
    this._hangOverride = null;         // set by hangAt(); wins over CabinSite
    this._targetObj = null;
    this._pageTargetObj = null;
    this._springAccum = 0;
    this._primed = false;          // has the rig been snapped to the camera at least once

    this._bobPhase = 0;
    this._footKick = 0;
    this._footSign = 1;

    // Input tap-vs-hold discriminator.
    this._keyDown = false;
    this._keyHeld = 0;
    this._tapPending = false;
    this._holdEngaged = false;

    this._pageOpen = false;
    this._sfxHoodLatched = false;

    // Deterministic noise. Seeded from settings so the flicker is reproducible for the
    // screenshot harness (ARCHITECTURE.md §6 — the seeded RNG only, never the global one).
    const seed = (ctx?.settings?.get?.('seed') ?? 0x51a5cab) ^ 0x1a37e5;
    this._rand = new Rand(seed);
    this._tables = [
      this._makeNoiseTable(256),
      this._makeNoiseTable(256),
      this._makeNoiseTable(256),
    ];

    // Owned GPU resources, tracked for dispose().
    this._geoms = [];
    this._mats = [];
    this._textures = [];
    this._unsubs = [];

    // Cached refs, resolved lazily and defensively — every one of these may be missing.
    this._globalUniforms = null;
    this._materialsChecked = false;

    // Animated parts of the mesh, filled in by _buildMesh().
    this._parts = {
      flame: null,
      halo: null,
      glass: null,
      glassSheen: null,
      sleeve: null,
      wick: null,
    };

    this._disposed = false;
  }

  /* ------------------------------------------------------------------------------------------
   * Lifecycle
   * ---------------------------------------------------------------------------------------- */

  async init() {
    try {
      this._adoptFuelFromState();
      this._buildMesh();
      this._buildLights();
      this._bindEvents();
      this._snapToCamera();
      Log.debug('Flashlight: lantern ready,', this._fuelUnits.toFixed(0), 'units of kerosene');
    } catch (e) {
      // A broken lantern must not take down the night.
      Log.error('Flashlight.init failed — the player will build in moonlight.', e);
    }
  }

  update(dt, elapsed) {
    if (this._disposed) return;
    const d = clamp(dt || 0, 0, 0.1);

    this._readWorld(d);
    this._readInput(d);
    this._stepHood(d);
    this._stepFuel(d);
    this._stepFlicker(d, elapsed || 0);
    this._stepHang(d);
    this._stepCarriage(d, elapsed || 0);
    this._applyLights();
    this._applyMesh(d);
    this._publish();
  }

  resize(_w, _h) { /* nothing resolution-dependent lives here */ }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    for (const off of this._unsubs) { try { off?.(); } catch { /* noop */ } }
    this._unsubs.length = 0;

    const drop = (o) => { try { o?.parent?.remove(o); } catch { /* noop */ } };

    if (this.light) { this.light.dispose?.(); drop(this.light); }
    if (this.spill) { this.spill.dispose?.(); drop(this.spill); }
    if (this.glow) { this.glow.dispose?.(); drop(this.glow); }
    if (this.pageLight) { this.pageLight.dispose?.(); drop(this.pageLight); }
    drop(this._targetObj);
    drop(this._pageTargetObj);
    if (this.object) drop(this.object);

    for (const g of this._geoms) { try { g.dispose(); } catch { /* noop */ } }
    for (const m of this._mats) { try { m.dispose(); } catch { /* noop */ } }
    for (const t of this._textures) { try { t.dispose(); } catch { /* noop */ } }
    this._geoms.length = 0;
    this._mats.length = 0;
    this._textures.length = 0;

    this.light = null;
    this.spill = null;
    this.glow = null;
    this.pageLight = null;
    this.object = null;
    this._targetObj = null;
    this._pageTargetObj = null;
    this._parts = { flame: null, halo: null, glass: null, glassSheen: null, sleeve: null, wick: null };
  }

  /* ------------------------------------------------------------------------------------------
   * Public verbs
   * ---------------------------------------------------------------------------------------- */

  /**
   * True while there is actually a flame — NOT the same as `on`, which is the input state.
   * Dousing takes 0.25 s and igniting takes 0.9 s, and for those fractions of a second there
   * is still fire in your hand. Campers see it. That is deliberate: tapping F does not make
   * you safe instantly, it makes you safe a quarter-second from now.
   */
  get lit() { return this._ignite > 0.02; }

  /**
   * THE SHUTTER, 0 = open .. 1 = closed.
   *
   * This is an accessor and not a plain field, and that is the entire fix for "hooding the
   * lantern does nothing". `Shots.js` (and HUD, and Campers' reflex hood) assign this
   * directly — `lantern.hoodLevel = 1` — and the old plain field made that assignment a
   * SINGLE FRAME of animation: `_stepHood` saw `hoodLevel > _hoodTarget` on the very next
   * update and drove it straight back to 0 at 1/0.42 per second. The screenshot harness then
   * waits 45 settle frames (0.75 s) before it flags `shotReady`, which is longer than the
   * 0.42 s shutter travel, so `forest-hooded` was captured with the shutter fully OPEN. That
   * is why the two frames measured identical, why the hooded one came out 1.6% brighter (pure
   * flicker noise), and why the lantern-glass peak was the same number twice.
   *
   * An external write is an INSTRUCTION, so it moves the target too. Internal stepping writes
   * `_hood`, which does not.
   */
  get hoodLevel() { return this._hood; }

  set hoodLevel(v) {
    const n = clamp01(Number.isFinite(v) ? v : 0);
    this._hood = n;
    this._hoodTarget = n;
  }

  get hooded() { return this._hood > 0.5; }
  get fuelUnits() { return this._fuelUnits; }
  set fuelUnits(v) { this.setFuelUnits(v); }
  get igniting() { return this.on && this._ignite < 0.999; }

  toggle() { return this.setOn(!this.on); }

  ignite() { return this.setOn(true); }

  douse() { return this.setOn(false); }

  /**
   * @param {boolean} v
   * @returns {boolean} the resulting `on` state — false if there was no fuel to light.
   */
  setOn(v) {
    const want = !!v;
    if (want === this.on) return this.on;
    if (want && this._fuelUnits <= 0) {
      // A dry lamp still makes the noise. That is the joke and it is not a funny one.
      this._emitClick(0.6);
      this._sfx('lantern_ignite', 0.5, 1.14);
      return false;
    }
    this.on = want;
    this._emitClick(1.0);
    this._sfx(want ? 'lantern_ignite' : 'lantern_douse', 1.0, want ? 1.0 : 1.06);
    return this.on;
  }

  /**
   * Set the shutter target. 0 = fully open, 1 = fully hooded.
   * @param {number} level
   * @param {number} [seconds] travel time; defaults to the player's 0.42 s. Pass
   *   TUNING.hoodPanicSeconds for the ART_DIRECTION §3.2 reflex hood.
   */
  setHood(level, seconds) {
    this._hoodTarget = clamp01(level);
    this._hoodRate = Number.isFinite(seconds) ? Math.max(0.02, seconds) : TUNING.hoodSeconds;
    return this._hoodTarget;
  }

  hoodClose(seconds) { return this.setHood(1, seconds); }
  hoodOpen(seconds) { return this.setHood(0, seconds); }

  /* --- THE HOOK (D7) ------------------------------------------------------------------ */

  /** True once the lamp is more than half-way onto the hook. */
  get hung() { return this._hangBlend > 0.5; }

  /** 0 = in the fist, 1 = fully on the hook. Read by anything that wants to blend with it. */
  get hangBlend() { return this._hangBlend; }

  /**
   * Hang the lamp at an explicit world point and keep it there until `unhang()`. Overrides
   * the automatic build-site hook. Pass a Vector3, an Object3D, or `null` to clear.
   * @param {THREE.Vector3|THREE.Object3D|null} where
   */
  hangAt(where) {
    if (!where) { this._hangOverride = null; return false; }
    if (!this._hangOverride) this._hangOverride = new THREE.Vector3();
    if (typeof where.getWorldPosition === 'function') where.getWorldPosition(this._hangOverride);
    else if (Number.isFinite(where.x)) this._hangOverride.set(where.x, where.y, where.z);
    else { this._hangOverride = null; return false; }
    if (!this._finite3(this._hangOverride)) { this._hangOverride = null; return false; }
    this._hookCheck = 0;
    return true;
  }

  /** Take it back off the hook. Clears any `hangAt()` override too. */
  unhang() {
    this._hangOverride = null;
    this._hung = false;
    return false;
  }

  /**
   * Pour in a fuel can. GAME_DESIGN §11.2: a can restores 45 units.
   * @returns {number} units actually added (0 if already full).
   */
  addFuel(units = TUNING.canRestores) {
    const before = this._fuelUnits;
    this.setFuelUnits(this._fuelUnits + (Number.isFinite(units) ? units : 0));
    const added = this._fuelUnits - before;
    if (added > 0.01) this._sfx('lantern_refuel', 0.85, 1.0);
    return added;
  }

  refill() { return this.addFuel(TUNING.fuelCapacity); }

  setFuelUnits(v) {
    const n = Number.isFinite(v) ? v : 0;
    this._fuelUnits = clamp(n, 0, TUNING.fuelCapacity);
    this.fuel = this._fuelUnits / TUNING.fuelCapacity;
    this._writeFuelToState();
    return this._fuelUnits;
  }

  /** ART_DIRECTION §3.2 hard rule is left-hand carry; this is the one number that moves it. */
  setHandOffset(x, y, z) { TUNING.handOffset.set(x, y, z); }

  /** 0 = a hand free, 1 = both hands under a beam and the lamp is on the belt. */
  setCarryLoad(v) { this._carryStowTarget = clamp01(v); }

  /** Safe copy — never hand out `flamePosition` itself. */
  getFlamePosition(out) {
    const v = out ?? new THREE.Vector3();
    return v.copy(this.flamePosition);
  }

  /**
   * GAME_DESIGN §9.4 `flameVisibility`, occlusion included. Optional convenience for Campers —
   * it spends one Physics LOS query (budget 96/frame, ~0.35 µs each).
   * @param {THREE.Vector3} eye camper eye position
   * @returns {number} 0..1
   */
  flameVisibilityFor(eye) {
    if (!this.lit || !eye) return 0;
    const phys = this.ctx?.systems?.get?.('Physics');
    if (phys && typeof phys.lineOfSight === 'function') {
      let clearLine = true;
      try { clearLine = phys.lineOfSight(this.flamePosition, eye) === true; }
      catch { clearLine = true; }
      if (!clearLine) return 0;
    }
    return this.visibilityContribution;
  }

  /**
   * The whole of GAME_DESIGN §9.4 in one call, so the constants never drift between files.
   * `dDetect/dt = max(bodyRate, flameRate)` — the caller still owns that max.
   * @returns {number} detection accrual per second from the flame alone, noise floor applied.
   */
  flameRateFor(eye, fovSens = 1, diffMul = 1) {
    const vis = this.flameVisibilityFor(eye);
    if (vis <= 0) return 0;
    const d = this.flamePosition.distanceTo(eye);
    const rangeF = clamp01(1 - Math.pow(d / FLAME_DETECTION.range, FLAME_DETECTION.rangeExp));
    const rate = FLAME_DETECTION.K * FLAME_DETECTION.flameWeight * rangeF * vis
      * clamp01(fovSens) * (Number.isFinite(diffMul) ? diffMul : 1);
    return rate < FLAME_DETECTION.noiseFloor ? 0 : rate;
  }

  /* ------------------------------------------------------------------------------------------
   * Per-frame stages
   * ---------------------------------------------------------------------------------------- */

  /** Sample the world: player speed, wind, camera. All of it optional. */
  _readWorld(dt) {
    const sys = this.ctx?.systems;

    // Speed. Prefer polling Player (frame-coherent); the player:move listener is the fallback
    // for the frames where Player has not published yet.
    const player = sys?.get?.('Player');
    if (player) {
      if (Number.isFinite(player.speed)) {
        this._speed = player.speed;
      } else if (player.velocity && Number.isFinite(player.velocity.x)) {
        const v = player.velocity;
        this._speed = Math.hypot(v.x, v.z);
      }
      if (typeof player.isCrouched === 'boolean') this._crouched = player.isCrouched;
    }
    this._speedNorm = clamp01(this._speed / TUNING.refSpeed);

    // Wind. Materials owns the canonical uniform; Weather is the fallback.
    if (!this._materialsChecked) {
      this._materialsChecked = true;
      const mats = sys?.get?.('Materials');
      const gu = mats?.globalUniforms;
      if (gu && gu.uWind && gu.uWind.value) this._globalUniforms = gu;
    }
    const gu = this._globalUniforms;
    if (gu) {
      const w = gu.uWind.value;
      const gust = Number.isFinite(gu.uWindGust?.value) ? gu.uWindGust.value : 0;
      this._windNorm = clamp01(Math.hypot(w.x, w.z) / 1.4 * 0.75 + gust * 0.45);
    } else {
      const weather = sys?.get?.('Weather');
      const w = weather?.wind;
      this._windNorm = clamp01(Number.isFinite(w) ? w : 0.2);
    }

    // The carry stow blend.
    this._carryStow += (this._carryStowTarget - this._carryStow) * approach(dt, 0.22);

    // Foot kick decays.
    this._footKick *= Math.exp(-dt * 7.5);
  }

  /**
   * Input: tap toggles, hold hoods. GAME_DESIGN §4.1 binds both to `lantern`.
   * `settings.holdToToggle` accessibility path is honoured if the setting exists.
   */
  _readInput(dt) {
    const input = this.ctx?.systems?.get?.('Input');
    if (!input || typeof input.isDown !== 'function') return;

    // While a real menu is up and a director exists, the lamp does not answer the keyboard.
    const st = this.state;
    if (st && st.phase === 'menu' && this.ctx?.systems?.has?.('NightManager')) return;

    const down = input.isDown('lantern');
    const holdToToggle = this.settings?.get?.('holdToToggle') === true;

    if (down && !this._keyDown) {
      this._keyDown = true;
      this._keyHeld = 0;
      this._tapPending = true;
      this._holdEngaged = false;
    } else if (down) {
      this._keyHeld += dt;
      if (this._tapPending && this._keyHeld >= TUNING.tapSeconds) {
        // Held past the discriminator: this is a hood, not a toggle.
        this._tapPending = false;
        this._holdEngaged = true;
        if (holdToToggle) {
          // Accessibility: one press latches the shutter, a second press releases it.
          this.setHood(this.hoodLevel > 0.5 ? 0 : 1);
        } else {
          this.setHood(1);
        }
      }
    } else if (this._keyDown) {
      this._keyDown = false;
      if (this._tapPending) {
        this.toggle();
      } else if (this._holdEngaged && !holdToToggle) {
        this.setHood(0);
      }
      this._tapPending = false;
      this._holdEngaged = false;
      this._keyHeld = 0;
    }
  }

  /** Shutter travel + the metal cue. */
  _stepHood(dt) {
    const prev = this._hood;
    const step = dt / this._hoodRate;
    // Writes the BACKING FIELD, never the accessor: stepping is animation, not instruction,
    // so it must not move `_hoodTarget`.
    if (this._hood < this._hoodTarget) {
      this._hood = Math.min(this._hoodTarget, this._hood + step);
    } else if (this._hood > this._hoodTarget) {
      this._hood = Math.max(this._hoodTarget, this._hood - step);
    }

    // A real shutter is a two-part sound: the scrape of travel and the latch at the stop.
    // Fire once per direction, on the leading edge, with hysteresis so a jittered key never
    // machine-guns it.
    const h = this._hood;
    if (!this._sfxHoodLatched && h > 0.08 && h > prev) {
      this._sfxHoodLatched = true;
      this._sfx('lantern_hood', 0.9, 1.0);
      this._emitShutter();
    } else if (this._sfxHoodLatched && h < 0.04 && h < prev) {
      this._sfxHoodLatched = false;
      this._sfx('lantern_unhood', 0.75, 1.05);
      this._emitShutter();
    }

    // GDD §9.4's binary predicate, exposed as a smooth curve that hits 0.18 at h = 1.
    this.hoodFactor = mix(1, TUNING.hoodFactorMin, Math.pow(h, TUNING.hoodVisExp));
  }

  /** Kerosene burns whether or not you are using the light. */
  _stepFuel(dt) {
    // Ignition ramp — 0.9 s up (GDD §11.2), 0.25 s down.
    const target = this.on ? 1 : 0;
    const rate = this.on ? 1 / TUNING.igniteSeconds : 1 / TUNING.douseSeconds;
    if (this._ignite < target) this._ignite = Math.min(1, this._ignite + dt * rate);
    else if (this._ignite > target) this._ignite = Math.max(0, this._ignite - dt * rate);

    // D11, AND IT IS A MEASUREMENT BUG, NOT A GAMEPLAY ONE. A posed shot has to be the same
    // frame at t = 20 s and at t = 6 min, and it was not: the wick burns 0.55 units/s, so a
    // review session that takes ten captures over six minutes is measuring a lamp that is dying.
    // MEASURED on `?shot=site-close&quality=ultra`, one page load, nothing else changed:
    //     30 s after shotReady   core 63.2 cd, _flameHealth 1.00, frame %warm 13.8, p99.9 0.887
    //     ~5 min after           core 26.5 cd, _flameHealth 0.46, frame %warm  9.8, p99.9 0.347
    // i.e. a 2.4x swing in the light and a third of the warm pixels, from nothing but elapsed
    // time. So while a shot is posed the tank stays full. `Shots.active` is null in play — this
    // cannot touch the game, and GDD 11.2's burn rates are untouched.
    if (this.ctx?.systems?.get?.('Shots')?.active) {
      this._fuelUnits = TUNING.fuelCapacity;
      this.fuel = 1;
    }

    if (this.on && this._fuelUnits > 0) {
      const burn = mix(TUNING.burnOpen, TUNING.burnHooded, this.hoodLevel);
      // Only a lit wick burns fuel; the ignition ramp burns proportionally.
      this._fuelUnits = Math.max(0, this._fuelUnits - burn * dt * Math.max(0.35, this._ignite));
      if (this._fuelUnits <= 0) {
        this._fuelUnits = 0;
        this.on = false;
        // It does not click out. It just stops, which is worse.
        this._sfx('lantern_gutter', 0.8, 0.92);
        Log.debug('Flashlight: out of kerosene');
      }
      this.fuel = this._fuelUnits / TUNING.fuelCapacity;
      this._writeFuelToState();
    }

    // Below 15 units the flame is starved: shorter, redder, and it gutters (GDD §11.2).
    this._flameHealth = mix(0.46, 1, clamp01(this._fuelUnits / TUNING.lowFuelUnits));
  }

  /**
   * The flicker model. Three value-noise octaves at 0.9 / 3.7 / 11.5 Hz, a movement and wind
   * gain on their amplitude, the ART_DIRECTION 40 ms micro-dropout, a rarer real gutter, and
   * the GDD's 3 Hz starvation wobble below 15 units. Deterministic: the tables come from the
   * seeded RNG, so two runs of the same seed flicker identically.
   */
  _stepFlicker(dt, elapsed) {
    const T = TUNING;

    // --- continuous octaves
    let amp = 0;
    for (let i = 0; i < 3; i++) {
      amp += (this._noise(elapsed * T.octaveHz[i], i) * 2 - 1) * T.octaveAmp[i];
    }
    const agitation = 1 + T.moveGain * this._speedNorm + T.windGain * this._windNorm;
    amp *= agitation;

    // --- low fuel: a 3 Hz wobble. GDD §11.2 is exact — below 15 units the instantaneous value
    //     swings 0.60..1.00 — so the envelope is a full-depth 0→1 cosine, not a partial one.
    //     Slightly biased low with the 0.85 exponent: a starved wick spends more of its time
    //     down than up, which is what makes it read as dying rather than as a strobe.
    const starve = 1 - clamp01(this._fuelUnits / T.lowFuelUnits);
    let starveDip = 0;
    if (starve > 0) {
      const w = Math.pow(0.5 - 0.5 * Math.cos(elapsed * T.gutterHz * Math.PI * 2), 0.85);
      starveDip = starve * (1 - T.gutterFloor) * w;
    }

    // --- discrete events. Poisson-ish, sampled from the seeded stream (not per-frame noise).
    const eventScale = 1 + 2.2 * this._speedNorm + 3.0 * this._windNorm + 4.0 * starve;

    if (this._micro.t > 0) this._micro.t -= dt;
    else if (this._rand.next() < T.microChancePerSec * eventScale * dt) {
      this._micro.t = T.microSeconds;
    }

    const g = this._gutter;
    if (g.t > 0) {
      g.t -= dt;
      if (g.t <= 0) this._maybeBlowOut();
    } else if (this._rand.next() < T.majorChancePerSec * (eventScale - 1) * dt) {
      g.dur = mix(T.majorSecondsMin, T.majorSecondsMax, this._rand.next());
      g.depth = mix(T.majorDepthMin, T.majorDepthMax, this._rand.next());
      g.t = g.dur;
      if (this.lit) this._sfx('lantern_gutter', 0.35 + 0.4 * g.depth, mix(0.9, 1.2, this._rand.next()));
    }

    let gutterDip = 0;
    if (g.t > 0 && g.dur > 0) {
      // Fast collapse, slow recovery — a flame that has been knocked does not snap back.
      const u = 1 - g.t / g.dur;                       // 0 at onset → 1 at the end
      const env = u < 0.22 ? u / 0.22 : Math.pow(1 - (u - 0.22) / 0.78, 1.7);
      gutterDip = g.depth * env;
    }
    const microDip = this._micro.t > 0 ? T.microDepth : 0;

    this._flicker = clamp(1 + amp - starveDip - gutterDip - microDip, T.flickerMin, T.flickerMax);
  }

  /** Wind can take a starving wick. Rare, late, and it is never a surprise you did not earn. */
  _maybeBlowOut() {
    if (!this.on) return;
    if (this._fuelUnits > TUNING.blowoutUnits) return;
    if (this._windNorm < 0.55) return;
    if (this._rand.next() > TUNING.blowoutChance) return;
    this.on = false;
    this._sfx('lantern_douse', 0.7, 0.95);
    Log.debug('Flashlight: the wind took it');
  }

  /**
   * The carriage. A lantern is a pendulum on a bail, hanging from a fist that is itself
   * attached to a big man walking. Nothing here is bolted to the camera: the body chases the
   * hand on an under-damped spring and hangs plumb; the beam chases the look on a slower
   * filter. That lag is the whole reason it does not read as an amateur FPS.
   */
  _stepHang(dt) {
    const T = TUNING;
    if (!T.hangEnabled) { this._hangBlend = 0; this._hung = false; return; }

    // Resolve the hook at 4 Hz — CabinSite rebuilds its group on night transitions and the
    // lookup walks two optional systems, neither of which is worth a per-frame visit.
    this._hookCheck -= dt;
    if (this._hookCheck <= 0) {
      this._hookCheck = 0.25;
      this._resolveHook();
    }

    const cam = this.camera;
    if (!this._hookValid || !cam) {
      this._hung = false;
    } else {
      // Hysteresis on the radius, and he takes it with him the moment he walks off.
      const d = Math.hypot(
        this._hookPos.x - cam.position.x,
        this._hookPos.z - cam.position.z,
      );
      const inner = T.hangRadius - T.hangHysteresis * 0.5;
      const outer = T.hangRadius + T.hangHysteresis * 0.5;
      if (this._speed > T.hangSpeed) this._hung = false;
      else if (!this._hung && d < inner) this._hung = true;
      else if (this._hung && d > outer) this._hung = false;
    }

    const step = dt / Math.max(0.05, T.hangBlendSeconds);
    const want = this._hung ? 1 : 0;
    if (this._hangBlend < want) this._hangBlend = Math.min(1, this._hangBlend + step);
    else if (this._hangBlend > want) this._hangBlend = Math.max(0, this._hangBlend - step);
  }

  /**
   * Where the lamp hangs. `hangAt()` wins; otherwise CabinSite's own hook if it publishes one;
   * otherwise the hook on the lantern post, reconstructed in that system's group space.
   * Everything here is optional and every branch null-checks (ARCHITECTURE §4).
   */
  _resolveHook() {
    this._hookValid = false;

    if (this._hangOverride) {
      this._hookPos.copy(this._hangOverride);
      this._hookValid = this._finite3(this._hookPos);
    } else {
      const site = this.ctx?.systems?.get?.('CabinSite');
      if (site) {
        // D10: a published hook only wins if we have been told it is composed for the eye.
        const pub = TUNING.hookPreferPublished
          ? (site.lanternHook ?? site.hookPosition ?? null)
          : null;
        if (pub && typeof pub.getWorldPosition === 'function') {
          pub.getWorldPosition(this._hookPos);
          this._hookValid = this._finite3(this._hookPos);
        } else if (pub && Number.isFinite(pub.x)) {
          this._hookPos.set(pub.x, pub.y, pub.z);
          this._hookValid = this._finite3(this._hookPos);
        } else if (site.group) {
          site.group.updateMatrixWorld?.();
          this._hookPos.copy(TUNING.hookLocal).applyMatrix4(site.group.matrixWorld);
          this._hookValid = this._finite3(this._hookPos);
        } else if (site.center && Number.isFinite(site.center.x)) {
          this._hookPos.copy(site.center).add(TUNING.hookLocal);
          this._hookValid = this._finite3(this._hookPos);
        }
      }
    }
    if (!this._hookValid) return;

    // Aim: mostly straight DOWN, leaned toward the middle of the plot. A hurricane lamp on a
    // post is near enough omnidirectional and the whole composition depends on that — the pool
    // is centred under the lamp, and the studs, which stand above it, rake their shadows
    // radially outward across the deck. This direction has NOTHING to do with where the camera
    // is looking, which is the entire point of the hook.
    const site = this.ctx?.systems?.get?.('CabinSite');
    const c = site?.center;
    if (c && Number.isFinite(c.x)) {
      _v3a.set(c.x, c.y + 0.35, c.z).sub(this._hookPos);
    } else {
      _v3a.set(0, -1, 0);
    }
    if (_v3a.lengthSq() < 1e-6) _v3a.set(0, -1, 0);
    _v3a.normalize().multiplyScalar(1 - TUNING.hangDown);
    _v3a.y -= TUNING.hangDown;
    if (_v3a.lengthSq() < 1e-6) _v3a.set(0, -1, 0);
    this._hookAim.copy(_v3a).normalize();
  }

  _finite3(v) {
    return !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
      && Math.abs(v.x) < 1e6 && Math.abs(v.y) < 1e6 && Math.abs(v.z) < 1e6;
  }

  _stepCarriage(dt, elapsed) {
    const cam = this.camera;
    if (!cam || !this.object) return;

    cam.updateMatrixWorld?.();
    // A poisoned view matrix must never be latched into a light position — see _guardLights().
    const ce = cam.matrixWorld.elements;
    if (!Number.isFinite(ce[12]) || !Number.isFinite(ce[13]) || !Number.isFinite(ce[14])) return;

    // --- head bob and the footstep kick, in camera space
    const bobGain = (this.settings?.get?.('reducedMotion') ? 0.35 : 1)
      * (this.settings?.get?.('headBob') === false ? 0.5 : 1);
    this._bobPhase += dt * TUNING.bobHz * Math.PI * 2 * (0.55 + 1.1 * this._speedNorm);
    if (this._bobPhase > Math.PI * 4) this._bobPhase -= Math.PI * 4;
    const bobY = Math.sin(this._bobPhase) * TUNING.bobAmplitude * this._speedNorm * bobGain;
    const bobX = Math.sin(this._bobPhase * 0.5) * TUNING.bobAmplitude * 0.8 * this._speedNorm * bobGain;

    // --- ideal hand position, camera space → world
    _v3a.copy(TUNING.handOffset);
    _v3a.addScaledVector(TUNING.stowOffset, this._carryStow);
    if (this._crouched) _v3a.y += 0.06;                 // the fist rides higher when folded up
    _v3a.x += bobX;
    _v3a.y += bobY - this._footKick * 0.018 * bobGain;
    this._handIdeal.copy(_v3a).applyMatrix4(cam.matrixWorld);

    if (!this._primed) this._snapToCamera();

    // --- where the lamp is actually trying to be: the fist, the hook, or on the way between.
    const hb = this._hangBlend;
    this._carryIdeal.copy(this._handIdeal);
    if (hb > 0 && this._hookValid) {
      // Smoothstep so the reach up and the lift down both have ends on them.
      const s = hb * hb * (3 - 2 * hb);
      this._carryIdeal.lerp(this._hookPos, s);
      // The lamp sways on its bail once it is on the hook. Wind drives it; it never stops.
      const sway = TUNING.hangSwayRad * (0.35 + 0.9 * this._windNorm) * s;
      this._carryIdeal.x += Math.sin(elapsed * TUNING.hangSwayHz * Math.PI * 2) * sway * 0.42;
      this._carryIdeal.z += Math.sin(elapsed * TUNING.hangSwayHz * Math.PI * 2 + 1.9) * sway * 0.30;
    }

    // A teleport (night transition, respawn) must not fling the lamp across the map — but a
    // deliberate hang/unhang IS a 10 m move, so the guard stands down while the blend runs.
    const blending = hb > 0.001 && hb < 0.999;
    if (!blending
      && this._lagPos.distanceToSquared(this._carryIdeal) > TUNING.springSnapDist * TUNING.springSnapDist) {
      this._lagPos.copy(this._carryIdeal);
      this._lagVel.set(0, 0, 0);
    }
    if (!this._finite3(this._lagPos) || !this._finite3(this._lagVel)) {
      this._lagPos.copy(this._carryIdeal);
      this._lagVel.set(0, 0, 0);
    }

    // --- spring, substepped at 120 Hz so a 30 fps frame cannot blow it up
    const k = TUNING.springK;
    const c = 2 * TUNING.springZeta * Math.sqrt(k);
    this._springAccum += dt;
    let steps = 0;
    const H = 1 / 120;
    while (this._springAccum >= H && steps < 8) {
      this._springAccum -= H;
      steps++;
      _v3b.copy(this._carryIdeal).sub(this._lagPos).multiplyScalar(k);
      _v3b.addScaledVector(this._lagVel, -c);
      this._lagVel.addScaledVector(_v3b, H);
      this._lagPos.addScaledVector(this._lagVel, H);
    }
    if (steps >= 8) this._springAccum = 0;

    this.object.position.copy(this._lagPos);

    // --- orientation: yaw follows the head, pitch/roll are pendulum only. A hanging lamp
    //     stays plumb no matter where you look, and that is what sells the weight.
    _e1.setFromQuaternion(cam.quaternion, 'YXZ');
    const yaw = _e1.y;

    _v3c.copy(this._carryIdeal).sub(this._lagPos);        // lag vector, world
    _q1.setFromAxisAngle(_v3d.set(0, 1, 0), -yaw);
    _v3c.applyQuaternion(_q1);                            // → yaw-local space

    const swingPitch = clamp(_v3c.z * TUNING.swingPitchGain, -TUNING.swingMaxRad, TUNING.swingMaxRad);
    const swingRoll = clamp(-_v3c.x * TUNING.swingRollGain, -TUNING.swingMaxRad, TUNING.swingMaxRad);
    const kick = this._footKick * this._footSign * 0.10;

    // On the hook the lamp stops answering the head entirely: its yaw is the hook's aim and
    // the footstep kick is somebody else's problem. That is the difference between an object
    // in the world and an object on the lens.
    const hb2 = this._hangBlend;
    const hookYaw = Math.atan2(-this._hookAim.x, -this._hookAim.z);
    _e2.set(
      swingPitch * mix(1, 0.55, hb2),
      mix(yaw, hookYaw, hb2),
      (swingRoll + kick) * mix(1, 0.55, hb2),
      'YXZ',
    );
    this.object.quaternion.setFromEuler(_e2);
    this.object.updateMatrixWorld(true);

    // --- flame world position: the wick sits inside the chimney, 0.115 m above the fount base
    _v3d.set(0, 0.115, 0);
    this.flamePosition.copy(_v3d).applyMatrix4(this.object.matrixWorld);

    // --- beam aim: camera forward, pitched down and yawed left, plus the hood's extra downward
    //     pitch, then filtered. The beam arrives where you looked a third of a second ago.
    const pitch = _e1.x + TUNING.aimPitchDeg * DEG + this._hood * TUNING.hoodAimPitchDeg * DEG;
    _e2.set(clamp(pitch, -1.45, 1.45), yaw + TUNING.aimYawDeg * DEG, 0, 'YXZ');
    _q2.setFromEuler(_e2);
    _v3e.set(0, 0, -1).applyQuaternion(_q2);
    // ...and once it is on the hook the aim is a fixed WORLD direction, not a view direction.
    if (hb2 > 0 && this._hookValid) {
      _v3e.lerp(this._hookAim, hb2 * hb2 * (3 - 2 * hb2));
      if (_v3e.lengthSq() < 1e-6) _v3e.copy(this._hookAim);
      _v3e.normalize();
    }
    this._aimDir.lerp(_v3e, approach(dt, TUNING.aimTau));
    if (this._aimDir.lengthSq() < 1e-6) this._aimDir.copy(_v3e);
    this._aimDir.normalize();
  }

  /** Push every computed scalar into the actual Three lights. */
  _applyLights() {
    const T = TUNING;
    const h = this._hood;

    // The two hood curves. See the header for why they are different exponents.
    const hp = Math.pow(h, T.hoodIntExp);
    const beamMul = mix(1, T.hoodBeamMul, hp);
    const nearMul = mix(1, T.hoodLumMul, hp);
    const coneMul = mix(1, T.hoodConeMul, h);
    const spillMul = mix(1, T.hoodSpillMul, hp);
    const glowMul = mix(1, T.hoodGlowMul, hp);

    // The hook: further away means more inverse-square to pay for, and a slightly tighter
    // cone so the pool still lands on the deck instead of washing the whole clearing.
    const hb = this._hangBlend;
    const hangInt = mix(1, T.hangIntensityMul, hb);
    const hangAng = mix(1, T.hangAngleMul, hb);
    const hangDist = mix(1, T.hangDistanceMul, hb);

    const alive = this._ignite * this._flicker * this._flameHealth;
    this.intensity = clamp(alive * beamMul, 0, 1.4);

    // Colour: a starved wick reddens. Also reddens through a gutter, because it is the same
    // physics — less air, less complete combustion.
    _colA.setHex(T.flameColor);
    _colB.setHex(T.flameColorLow);
    const redness = clamp01((1 - this._flameHealth) / 0.54 * 0.85 + (1 - clamp01(this._flicker)) * 0.5);
    // Instance-owned, not module scratch: _applyMesh() reads this on the same frame and a
    // shared scratch colour across two methods is exactly the kind of coupling that breaks
    // silently the first time someone reorders the update stages.
    const flameCol = this._flameColorNow.copy(_colA).lerp(_colB, redness);
    // The chimney tracks the same starvation curve but starts whiter.
    this._glassColorNow.copy(_colC.setHex(T.glassGlowColor)).lerp(_colB, redness);

    // Emitter position: on the aim, ahead of the wick, and BELOW it. See D6 (the forward push)
    // and D7 (the drop). The drop is what makes the shadows visible: it is the difference
    // between a light at eye height and a light at lamp height.
    _v3c.copy(this.flamePosition).addScaledVector(this._aimDir, T.lightOffset);
    _v3c.y -= T.lightDrop * (1 - this._hangBlend);

    const core = this.light;
    if (core) {
      const on = this.intensity > 0.004;
      core.visible = on;
      core.intensity = T.coreIntensity * this.intensity * hangInt;
      core.angle = T.coreAngle * coneMul * hangAng;
      core.penumbra = mix(T.corePenumbra, 0.92, h);       // a shuttered lamp has no hard edge
      core.distance = T.coreDistance * mix(1, T.hoodDistMul, h) * hangDist;
      core.color.copy(flameCol);
      core.position.copy(_v3c);
      // castShadow is set once from the tier; skip the whole pass when the lamp is dark.
      if (this._shadowCapable) core.castShadow = on && this.intensity > 0.05;
      if (this._targetObj) {
        this._targetObj.position.copy(_v3c).addScaledVector(this._aimDir, 10);
      }
    }

    const spill = this.spill;
    if (spill) {
      spill.visible = this.intensity > 0.004;
      // The spill is a leak, and the hood is a piece of sheet metal over the chimney, so the
      // hood takes the leak with it. It used to survive at 50%, which — being shadowless,
      // 74° wide and aimed at the ground two metres away — is most of what a hooded frame
      // was made of, and it is half of why hooding measured as a no-op.
      // ...and D10: on the hook it comes DOWN. A shadowless 74-degree flood 1.9 m from the studs
      // fills in every shadow the core throws, which is the one thing the hung state exists for.
      spill.intensity = T.spillIntensity * alive * spillMul * mix(1, T.hangSpillMul, hb);
      spill.angle = T.spillAngle * mix(1, 0.55, h);
      spill.distance = T.spillDistance * mix(1, 0.40, h) * mix(1, 1.25, hb);
      spill.color.copy(flameCol);
      spill.position.copy(_v3c);
    }

    const glow = this.glow;
    if (glow) {
      // The near field is what lights the player's own hands and the lumber on their shoulder.
      // GDD §9.6's "intensity 40%" is a statement about `illumination` — the number Campers
      // read — not about this fill, which is a 3.2 m point light 0.4 m from the lens and
      // therefore the single most expensive thing in the frame per candela.
      glow.visible = alive > 0.004 && hb < 0.98;
      glow.intensity = T.glowIntensity * alive * glowMul * (1 - hb);
      glow.distance = T.glowDistance * mix(1, 0.72, h);
      glow.color.copy(flameCol);
      // D5. This used to sit exactly on the flame — i.e. 3 cm from its own brass fount, where
      // decay 2 turns 2.9 cd into an irradiance of ~1800 and clips the whole lamp to white.
      // It is a near-field FILL for the hands and the carried lumber, so it belongs out in
      // front of the lamp, not inside it.
      glow.position.copy(this.flamePosition).addScaledVector(this._aimDir, T.glowForward);
    }

    const page = this.pageLight;
    if (page) {
      page.visible = this._pageOpen && alive > 0.02;
      page.intensity = page.visible ? T.pageIntensity * alive * mix(1, 0.55, hp) : 0;
      // D8: this block used to sit INSIDE `if (page.visible)`, so an invisible page light kept
      // whatever position it was last given, forever, with nothing ever correcting it. One bad
      // frame of `camera.matrixWorld` — a teleport, a respawn, a system that divided by a zero
      // dt — was enough to latch a garbage transform into a node that then sat in the scene
      // graph at y = -7.0e+99 for the rest of the session. It was `visible:false` so nobody saw
      // it, but a bounding volume computed through an overflowed matrix is Infinity, and that
      // quietly breaks frustum culling and shadow bounds for anything that shares the union.
      // Write the transform EVERY frame, and sanitize below.
      const cam = this.camera;
      if (cam) {
        const ce = cam.matrixWorld.elements;
        if (Number.isFinite(ce[12]) && Number.isFinite(ce[13]) && Number.isFinite(ce[14])) {
          // The page hangs in front of the chest; the bounce comes off the paper at the face.
          _v3a.set(0, -0.30, -0.52).applyMatrix4(cam.matrixWorld);
          if (this._finite3(_v3a)) {
            page.position.copy(_v3a);
            if (this._pageTargetObj) this._pageTargetObj.position.set(ce[12], ce[13], ce[14]);
          }
        }
      }
    }

    this._guardLights();
  }

  /**
   * D8, the belt to the braces. Nine object transforms, each checked for finiteness and for
   * having wandered somewhere no scene of this size can legitimately reach. Cost is 27
   * `Number.isFinite` calls a frame and it makes an overflowed node structurally impossible
   * rather than merely unlikely — which matters because the failure is silent, permanent, and
   * poisons every bounding volume computed through the node.
   */
  _guardLights() {
    const cam = this.camera;
    let hx = 0, hy = 0, hz = 0;
    if (cam) {
      const ce = cam.matrixWorld.elements;
      if (Number.isFinite(ce[12])) { hx = ce[12]; hy = ce[13]; hz = ce[14]; }
    }
    const fix = (o) => {
      if (!o) return;
      const p = o.position;
      if (this._finite3(p)) return;
      Log.once('lantern-nan', 'Flashlight: a light transform went non-finite; reset to the eye.');
      p.set(hx, hy, hz);
      o.updateMatrix?.();
      o.updateMatrixWorld?.(true);
    };
    fix(this.light);
    fix(this.spill);
    fix(this.glow);
    fix(this.pageLight);
    fix(this._targetObj);
    fix(this._pageTargetObj);
    fix(this.object);
  }

  /** Drive the mesh: flame size, glass emissive, shutter travel. */
  _applyMesh(dt) {
    const T = TUNING;
    const p = this._parts;
    const h = this._hood;
    const alive = clamp(this._ignite * this._flicker * this._flameHealth, 0, 1.4);

    /**
     * THE SHUTTER, APPLIED TO THE LAMP ITSELF. The sleeve is a piece of sheet metal that rises
     * over the chimney; it therefore occludes the flame, the halo, the chimney glow and the
     * chimney sheen. None of those four moved with the hood before, which is exactly why the
     * measured lantern-glass peak was 0.6671 open and 0.6667 hooded — the brightest object in
     * the hooded frame was an unshuttered flame. Front-loaded (exponent 0.7) so the first third
     * of the travel already visibly kills the object, matching `hoodFactor`'s own curve.
     */
    const shutter = mix(1, T.hoodEmissiveMul, Math.pow(h, 0.7));

    if (p.flame) {
      const vis = alive > 0.01 && shutter > 0.02;
      p.flame.visible = vis;
      if (vis) {
        const s = (0.55 + 0.45 * alive) * mix(1, 0.55, h);
        const w = mix(0.72, 1.0, this._flameHealth) * (0.9 + 0.1 * s) * mix(1, 0.55, h);
        p.flame.scale.set(w, s, w);
        // Lateral lean: wind and running push the flame off the wick.
        const lean = (this._windNorm * 0.22 + this._speedNorm * 0.18) * Math.sin(this._bobPhase * 0.7);
        p.flame.rotation.z = lean;
        if (p.flame.material) {
          p.flame.material.opacity = clamp01(0.55 + 0.45 * alive) * shutter;
          // Over-ranged so the wick is the one thing in the frame allowed to clip AgX
          // (ART_DIRECTION §3.1: brightest 0.1% may clip, and nothing else may). `copy` then
          // scale — never scale `_flameColorNow` itself, the SpotLights read that instance.
          p.flame.material.color.copy(this._flameColorNow)
            .multiplyScalar(T.flameHdr * mix(0.55, 1, clamp01(alive)) * mix(1, 0.30, h));
        }
      }
    }

    if (p.halo) {
      const vis = alive > 0.01 && shutter > 0.02;
      p.halo.visible = vis;
      if (vis) {
        const s = 0.6 + 0.9 * alive * mix(1, 0.4, h);
        p.halo.scale.setScalar(s);
        if (p.halo.material) {
          p.halo.material.opacity = clamp01(0.10 + 0.24 * alive) * shutter;
          // Stays under 1.0: the halo is the bloom SEED, not the highlight.
          p.halo.material.color.copy(this._flameColorNow).multiplyScalar(T.haloHdr);
        }
      }
    }

    // The glass catches it. This is the detail that makes the object read as glass rather than
    // as a transparent cylinder: the chimney itself glows, unevenly, through its own soot.
    // Deliberately kept below 1.0 — a chimney that clips is a white blob, and the brief is that
    // the POOL is the brightest thing in the frame, not the lamp.
    if (p.glass?.material) {
      p.glass.material.emissiveIntensity = alive * T.glassEmissive * shutter;
      p.glass.material.emissive.copy(this._glassColorNow);
    }
    if (p.glassSheen) {
      p.glassSheen.visible = alive > 0.01 && shutter > 0.02;
      if (p.glassSheen.material) {
        p.glassSheen.material.opacity = clamp01(0.08 + 0.22 * alive) * shutter;
        p.glassSheen.material.color.copy(this._glassColorNow).multiplyScalar(T.sheenHdr);
      }
    }

    if (p.wick?.material) {
      // The wick char glows dull red for a moment after a douse.
      p.wick.material.emissiveIntensity = clamp01(this._ignite * 1.6) * shutter;
    }

    // The shutter: a sheet-metal sleeve that rises over the chimney.
    if (p.sleeve) {
      p.sleeve.visible = h > 0.004;
      p.sleeve.position.y = mix(0.062, 0.128, h);
      p.sleeve.scale.y = mix(0.15, 1.0, h);
      p.sleeve.rotation.y = mix(0, 0.55, h);
    }
  }

  /** Publish the numbers other systems read. */
  _publish() {
    const alive = this._ignite * this._flicker;

    // GDD §11.2: "The flicker is a detection spike — lightF and flameVisibility both sample the
    // instantaneous value." Both of the following are therefore this frame's value, not a mean.
    const hp = Math.pow(this._hood, TUNING.hoodIntExp);
    const nearMul = mix(1, TUNING.hoodLumMul, hp);

    if (this.lit) {
      // A guttering flame is smaller but it is still a point of fire in a black forest, so its
      // visibility floors well above its illumination.
      const visHealth = 0.45 + 0.55 * this._flameHealth;
      this.visibilityContribution = clamp01(this.hoodFactor * clamp01(alive) * visHealth);
      this.illumination = clamp01(TUNING.lumOpen * nearMul * clamp01(alive) * this._flameHealth);
    } else {
      this.visibilityContribution = 0;
      this.illumination = 0;
    }

    const s = this.stats;
    s.fuelUnits = this._fuelUnits;
    s.flicker = this._flicker;
    s.hood = this._hood;
    s.visibility = this.visibilityContribution;
    s.speed = this._speed;
    s.wind = this._windNorm;
    s.hang = this._hangBlend;
  }

  /* ------------------------------------------------------------------------------------------
   * Construction
   * ---------------------------------------------------------------------------------------- */

  _buildLights() {
    const scene = this.scene;
    const T = TUNING;
    const tierIdx = this.settings?.tierIndex ?? 3;
    this._shadowCapable = tierIdx >= 1;                    // medium and up (ART §3.3 ledger)

    // --- core, the only shadow caster the player carries
    const core = new THREE.SpotLight(T.flameColor, 0, T.coreDistance, T.coreAngle, T.corePenumbra, T.decay);
    core.name = 'lantern-core';
    core.castShadow = this._shadowCapable;
    // Tight frustum. VolumetricFog samples this map for the cone; a sloppy near/far here is
    // what makes god rays band and swim.
    core.shadow.mapSize.set(
      this.settings?.tier?.(512, 1024, 2048, 2048) ?? 1024,
      this.settings?.tier?.(512, 1024, 2048, 2048) ?? 1024,
    );
    core.shadow.camera.near = T.shadowNear;
    // SpotLightShadow.updateMatrices overwrites `far` with `light.distance` every frame and
    // `fov` with 2·angle·focus, so the frustum tracks the beam automatically — which is the
    // whole reason `coreDistance` and `shadowFar` must never disagree. If they do, the beam
    // lights geometry the shadow map cannot see and every shadow in the pool silently vanishes,
    // taking VolumetricFog's cone with it. Keep this a max(), not an assignment.
    core.shadow.camera.far = Math.max(T.shadowFar, T.coreDistance);
    core.shadow.bias = T.shadowBias;
    core.shadow.normalBias = T.shadowNormalBias;
    core.shadow.focus = 1.0;
    core.shadow.camera.updateProjectionMatrix();
    core.visible = false;

    const target = new THREE.Object3D();
    target.name = 'lantern-aim';
    core.target = target;

    // --- spill: no shadow, wide, weak. Real lanterns leak (ART_DIRECTION §3.2).
    const spill = new THREE.SpotLight(T.flameColor, 0, T.spillDistance, T.spillAngle, T.spillPenumbra, T.decay);
    spill.name = 'lantern-spill';
    spill.castShadow = false;
    spill.target = target;
    spill.visible = false;

    // --- near-field: the player's own hands and whatever is in them
    const glow = new THREE.PointLight(T.flameColor, 0, T.glowDistance, T.decay);
    glow.name = 'lantern-glow';
    glow.castShadow = false;
    glow.visible = false;

    // --- manual page bounce (ART_DIRECTION §3.2 row 9, owned by this file)
    const page = new THREE.SpotLight(T.pageColor, 0, T.pageDistance, T.pageAngle, T.pagePenumbra, T.decay);
    page.name = 'lantern-page-bounce';
    page.castShadow = false;
    page.visible = false;
    const pageTarget = new THREE.Object3D();
    pageTarget.name = 'lantern-page-aim';
    page.target = pageTarget;

    this.light = core;
    this.spill = spill;
    this.glow = glow;
    this.pageLight = page;
    this._targetObj = target;
    this._pageTargetObj = pageTarget;

    if (scene) {
      scene.add(core, target, spill, glow, page, pageTarget);
    } else {
      Log.warn('Flashlight: no scene on ctx — the lantern exists but is not in the world.');
    }
  }

  _buildMesh() {
    const T = TUNING;
    const group = new THREE.Group();
    group.name = 'lantern';
    group.matrixAutoUpdate = true;

    const brassTex = this._makeBrassTexture(192);
    const sootTex = this._makeSootTexture(128);

    // ---------------------------------------------------------------- materials
    const matBrass = new THREE.MeshStandardMaterial({
      // Rougher than a showroom lamp on purpose: a tight GGX lobe 0.36 m from a point light
      // is a specular spike, and a specular spike on a hand prop is the white blob we are
      // getting rid of. This lamp has been in a shed since 1971.
      color: 0x9a7440, metalness: 0.86, roughness: 0.56, map: brassTex ?? null,
    });
    const matBrassDark = new THREE.MeshStandardMaterial({
      color: 0x5e4523, metalness: 0.82, roughness: 0.62, map: brassTex ?? null,
    });
    const matSteel = new THREE.MeshStandardMaterial({
      color: 0x3b3d3f, metalness: 0.88, roughness: 0.54,
    });
    const matSleeve = new THREE.MeshStandardMaterial({
      color: 0x2e3134, metalness: 0.9, roughness: 0.48, side: THREE.DoubleSide,
    });
    const matGlass = new THREE.MeshPhysicalMaterial({
      color: T.glassColor,
      metalness: 0.0,
      roughness: 0.10,
      transparent: true,
      opacity: T.glassOpacity,
      side: THREE.DoubleSide,
      depthWrite: false,
      ior: 1.52,
      emissive: new THREE.Color(T.flameColor),
      emissiveIntensity: 0,
      map: sootTex ?? null,
    });
    const matSheen = new THREE.MeshBasicMaterial({
      color: T.flameColor,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
    });
    const matFlame = new THREE.MeshBasicMaterial({
      color: T.flameColor,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const matHalo = new THREE.MeshBasicMaterial({
      color: T.flameColor,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
    });
    const matWick = new THREE.MeshStandardMaterial({
      color: 0x120d0a, roughness: 1.0, metalness: 0,
      emissive: new THREE.Color(0xff3a08), emissiveIntensity: 0,
    });
    this._mats.push(matBrass, matBrassDark, matSteel, matSleeve, matGlass, matSheen, matFlame, matHalo, matWick);

    // ---------------------------------------------------------------- geometry
    // Everything is in metres. Overall height ~0.22 m, fount radius 0.046 m — a real
    // hurricane lamp, held 0.45 m from the eye, so it occupies the lower-left of frame.

    // Fount: a squat brass reservoir with a rolled foot.
    const fountProfile = [
      [0.000, 0.000], [0.030, 0.000], [0.044, 0.006], [0.047, 0.016],
      [0.046, 0.032], [0.040, 0.044], [0.030, 0.051], [0.022, 0.055],
      [0.021, 0.060], [0.000, 0.060],
    ];
    const gFount = this._lathe(fountProfile, 24);
    const fount = new THREE.Mesh(gFount, matBrass);
    fount.name = 'lantern-fount';
    group.add(fount);

    // Burner gallery — the perforated collar the chimney sits in, plus its crown ring.
    // Merged: two draw calls for two rings of brass is two draw calls too many.
    const gGallery = this._merge([
      { geo: new THREE.CylinderGeometry(0.026, 0.023, 0.016, 20, 1, true), pos: [0, 0.068, 0] },
      { geo: new THREE.TorusGeometry(0.026, 0.0035, 6, 20), pos: [0, 0.077, 0], rot: [Math.PI / 2, 0, 0] },
    ]);
    if (gGallery) group.add(new THREE.Mesh(gGallery, matBrassDark));

    // The wick and its knurled adjuster — the small honest detail that reads at 0.45 m.
    const gWick = new THREE.BoxGeometry(0.013, 0.010, 0.0022);
    this._geoms.push(gWick);
    const wick = new THREE.Mesh(gWick, matWick);
    wick.position.y = 0.082;
    group.add(wick);


    // Glass chimney: bulges over the flame, waists, then flares at the top.
    const chimneyProfile = [
      [0.024, 0.078], [0.030, 0.092], [0.032, 0.108], [0.030, 0.126],
      [0.024, 0.144], [0.021, 0.158], [0.023, 0.168],
    ];
    const gGlass = this._lathe(chimneyProfile, 24, true);
    const glass = new THREE.Mesh(gGlass, matGlass);
    glass.name = 'lantern-chimney';
    glass.renderOrder = 3;
    group.add(glass);

    // A back-side additive shell inside the glass: this is what makes the chimney *catch*
    // the light instead of merely being see-through.
    const gSheen = this._lathe(chimneyProfile.map(([r, y]) => [r * 0.94, y]), 20, true);
    const sheen = new THREE.Mesh(gSheen, matSheen);
    sheen.renderOrder = 4;
    group.add(sheen);

    // All the steelwork in ONE draw call: the wick-adjuster knob, four wire uprights, the cap
    // ring, the bail handle and its two lugs. Nine primitives, none of which move relative to
    // each other, merged at init. ARCHITECTURE §12's draw-call budget is 220 for the whole
    // forest; a hand prop does not get to spend nine of them.
    const steelParts = [
      { geo: new THREE.CylinderGeometry(0.008, 0.008, 0.004, 12), pos: [0.030, 0.062, 0], rot: [0, 0, Math.PI / 2] },
      { geo: new THREE.TorusGeometry(0.030, 0.0028, 6, 18), pos: [0, 0.172, 0], rot: [Math.PI / 2, 0, 0] },
      { geo: new THREE.TorusGeometry(0.040, 0.0022, 6, 22, Math.PI), pos: [0, 0.176, 0], rot: [0, 0.12, 0] },
    ];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      steelParts.push({
        geo: new THREE.CylinderGeometry(0.0016, 0.0016, 0.095, 5),
        pos: [Math.cos(a) * 0.033, 0.124, Math.sin(a) * 0.033],
      });
    }
    for (let i = 0; i < 2; i++) {
      steelParts.push({
        geo: new THREE.CylinderGeometry(0.0026, 0.0026, 0.006, 8),
        pos: [i === 0 ? 0.030 : -0.030, 0.174, 0], rot: [0, 0, Math.PI / 2],
      });
    }
    const gSteel = this._merge(steelParts);
    if (gSteel) {
      const steel = new THREE.Mesh(gSteel, matSteel);
      steel.name = 'lantern-metalwork';
      group.add(steel);
    }

    // THE HOOD. A sheet-metal sleeve that rises over the chimney. It is the mechanic, so it
    // is also the most legible moving part on the object.
    const gSleeve = new THREE.CylinderGeometry(0.036, 0.036, 0.096, 20, 1, true, 0, Math.PI * 1.62);
    this._geoms.push(gSleeve);
    const sleeve = new THREE.Mesh(gSleeve, matSleeve);
    sleeve.name = 'lantern-hood';
    sleeve.position.y = 0.062;
    sleeve.scale.y = 0.15;
    sleeve.visible = false;
    group.add(sleeve);

    // Flame: a teardrop lathe on the wick, additive.
    const flameProfile = [
      [0.0000, 0.000], [0.0042, 0.004], [0.0058, 0.011], [0.0052, 0.020],
      [0.0034, 0.029], [0.0014, 0.036], [0.0000, 0.040],
    ];
    const gFlame = this._lathe(flameProfile, 12);
    const flame = new THREE.Mesh(gFlame, matFlame);
    flame.name = 'lantern-flame';
    flame.position.y = 0.086;
    flame.renderOrder = 6;
    flame.visible = false;
    group.add(flame);

    // Halo: the bloom seed. ART_DIRECTION §2.4 lets the lantern hotspot clip AgX; this is it.
    const gHalo = new THREE.SphereGeometry(0.030, 10, 8);
    this._geoms.push(gHalo);
    const halo = new THREE.Mesh(gHalo, matHalo);
    halo.name = 'lantern-halo';
    halo.position.y = 0.100;
    halo.renderOrder = 7;
    halo.visible = false;
    group.add(halo);

    this._parts.flame = flame;
    this._parts.halo = halo;
    this._parts.glass = glass;
    this._parts.glassSheen = sheen;
    this._parts.sleeve = sleeve;
    this._parts.wick = wick;

    group.scale.setScalar(T.meshScale);
    this.object = group;
    if (this.scene) this.scene.add(group);
  }

  _bindEvents() {
    const bus = this.bus;
    if (!bus || typeof bus.on !== 'function') return;
    const keep = (fn) => { if (typeof fn === 'function') this._unsubs.push(fn); };

    // Speed fallback for the frames Player has not been polled on.
    keep(bus.on('player:move', (p) => {
      if (p && Number.isFinite(p.speed)) this._speed = p.speed;
      if (p && typeof p.crouched === 'boolean') this._crouched = p.crouched;
    }));

    // A footstep kicks the pendulum. `loud` is 0..1 in the canonical payload.
    keep(bus.on('player:footstep', (p) => {
      const loud = p && Number.isFinite(p.loud) ? clamp01(p.loud) : 0.4;
      this._footKick = Math.min(1.4, this._footKick + TUNING.footImpulse * (0.4 + loud));
      this._footSign = -this._footSign;
      this._lagVel.y -= 0.06 * (0.4 + loud);
    }));

    // The manual needs light on it; ART_DIRECTION gives that light to this file.
    keep(bus.on('ui:blueprint-open', () => { this._pageOpen = true; }));
    keep(bus.on('ui:blueprint-close', () => { this._pageOpen = false; }));

    // A full lamp at dusk. He fills it before he starts; he does not light it until he needs it.
    keep(bus.on('night:begin', () => {
      this.setFuelUnits(TUNING.fuelCapacity);
      this.on = false;
      this._ignite = 0;
      this.setHood(0, 0.05);
      this.hoodLevel = 0;
      this._sfxHoodLatched = false;
      this._primed = false;
      // A new night starts with the lamp in his fist at the treeline, not on last night's hook.
      this._hangOverride = null;
      this._hung = false;
      this._hangBlend = 0;
      this._hookValid = false;
      this._hookCheck = 0;
    }));

    const kill = () => { this.on = false; this._pageOpen = false; };
    keep(bus.on('night:complete', kill));
    keep(bus.on('night:failed', kill));

    // Hands full → the lamp goes to the belt and swings a great deal more.
    keep(bus.on('build:pickup', (p) => {
      const m = p?.part?.mass;
      this.setCarryLoad(Number.isFinite(m) ? clamp01((m - 6) / 30) : 0.7);
    }));
    const freeHands = () => this.setCarryLoad(0);
    keep(bus.on('build:drop', freeHands));
    keep(bus.on('build:place', freeHands));

    // Weather is the wind fallback when Materials is absent.
    keep(bus.on('weather:change', (p) => {
      if (!this._globalUniforms && p && Number.isFinite(p.wind)) this._windNorm = clamp01(p.wind);
    }));

    // Shadow map size follows the tier.
    keep(bus.on('settings:changed', ({ key } = {}) => {
      if (key !== 'quality' && key !== '*') return;
      const size = this.settings?.tier?.(512, 1024, 2048, 2048) ?? 1024;
      this._shadowCapable = (this.settings?.tierIndex ?? 3) >= 1;
      if (this.light) {
        this.light.shadow.mapSize.set(size, size);
        this.light.shadow.map?.dispose?.();
        this.light.shadow.map = null;
        this.light.castShadow = this._shadowCapable;
      }
    }));
  }

  /* ------------------------------------------------------------------------------------------
   * Helpers — kept in this file because it owns exactly one file (golden rule 1)
   * ---------------------------------------------------------------------------------------- */

  /**
   * Bake a list of transformed primitives into one geometry, so a nine-part wire assembly
   * costs one draw call instead of nine. The source primitives are consumed: they are
   * transformed in place, merged, and disposed here, so only the result is tracked.
   *
   * `mergeGeometries` needs every input to carry the same attribute set — all the primitives
   * used here are Cylinder/Torus/Box, which all supply position + normal + uv, so they merge
   * cleanly. If that ever stops being true this returns null and the caller silently skips
   * the part rather than throwing during init.
   *
   * @param {{geo: THREE.BufferGeometry, pos?: number[], rot?: number[]}[]} parts
   * @returns {THREE.BufferGeometry|null}
   */
  _merge(parts) {
    const list = [];
    for (const p of parts) {
      const g = p.geo;
      if (!g) continue;
      _e2.set(p.rot?.[0] ?? 0, p.rot?.[1] ?? 0, p.rot?.[2] ?? 0, 'YXZ');
      _q1.setFromEuler(_e2);
      _v3a.set(p.pos?.[0] ?? 0, p.pos?.[1] ?? 0, p.pos?.[2] ?? 0);
      _m4.compose(_v3a, _q1, _v3b.set(1, 1, 1));
      g.applyMatrix4(_m4);
      list.push(g);
    }
    if (!list.length) return null;
    let merged = null;
    try {
      merged = mergeGeometries(list, false);
    } catch (e) {
      Log.once('lantern-merge', 'Flashlight: geometry merge failed, falling back.', e);
    }
    if (!merged) {
      // Degrade rather than lose the part: keep the first primitive, drop the rest.
      for (let i = 1; i < list.length; i++) list[i].dispose();
      this._geoms.push(list[0]);
      return list[0];
    }
    for (const g of list) g.dispose();
    this._geoms.push(merged);
    return merged;
  }

  /** @param {number[][]} profile [radius, y] pairs */
  _lathe(profile, segments, openEnded = false) {
    const pts = [];
    for (const [r, y] of profile) pts.push(new THREE.Vector2(r, y));
    const g = new THREE.LatheGeometry(pts, segments);
    if (openEnded) g.computeVertexNormals();
    this._geoms.push(g);
    return g;
  }

  _makeNoiseTable(n) {
    const t = new Float32Array(n);
    for (let i = 0; i < n; i++) t[i] = this._rand.next();
    return t;
  }

  /** Smoothed 1D value noise over a fixed table. Deterministic, allocation-free, ~8 ns. */
  _noise(x, channel) {
    const tab = this._tables[channel] ?? this._tables[0];
    const n = tab.length;
    const xf = Math.floor(x);
    const f = x - xf;
    const i0 = ((xf % n) + n) % n;
    const i1 = (i0 + 1) % n;
    const u = f * f * (3 - 2 * f);
    return tab[i0] + (tab[i1] - tab[i0]) * u;
  }

  _snapToCamera() {
    const cam = this.camera;
    if (!cam) return;
    cam.updateMatrixWorld?.();
    _v3a.copy(TUNING.handOffset).applyMatrix4(cam.matrixWorld);
    if (!this._finite3(_v3a)) return;
    this._lagPos.copy(_v3a);
    this._handIdeal.copy(_v3a);
    this._carryIdeal.copy(_v3a);
    this._lagVel.set(0, 0, 0);
    cam.getWorldDirection(this._aimDir);
    if (this._aimDir.lengthSq() < 1e-6) this._aimDir.set(0, 0, -1);
    this.flamePosition.copy(_v3a).setY(_v3a.y + 0.115);
    if (this.object) this.object.position.copy(_v3a);
    this._primed = true;
  }

  /* ------------------------------------------------------------------- procedural textures */

  _canvasTexture(size, fill) {
    const doc = globalThis.document;
    if (!doc || typeof doc.createElement !== 'function') return null;
    try {
      const c = doc.createElement('canvas');
      c.width = size;
      c.height = size;
      const g = c.getContext('2d');
      if (!g) return null;
      const img = g.createImageData(size, size);
      fill(img.data, size);
      g.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(c);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      this._textures.push(tex);
      return tex;
    } catch (e) {
      Log.once('lantern-tex', 'Flashlight: canvas texture unavailable, using flat materials.', e);
      return null;
    }
  }

  /** Brass with a lifetime of handling on it: verdigris in the low spots, polish on the high. */
  _makeBrassTexture(size) {
    const rand = new Rand((this.settings?.get?.('seed') ?? 0) ^ 0xb2a55);
    const tab = new Float32Array(64);
    for (let i = 0; i < 64; i++) tab[i] = rand.next();
    const noise = (x, y) => {
      const xi = Math.floor(x) & 7, yi = Math.floor(y) & 7;
      const xf = x - Math.floor(x), yf = y - Math.floor(y);
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      const a = tab[(yi * 8 + xi) & 63];
      const b = tab[(yi * 8 + ((xi + 1) & 7)) & 63];
      const c = tab[(((yi + 1) & 7) * 8 + xi) & 63];
      const d = tab[(((yi + 1) & 7) * 8 + ((xi + 1) & 7)) & 63];
      return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
    };
    return this._canvasTexture(size, (data, n) => {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const u = x / n, v = y / n;
          const grain = noise(u * 7, v * 7) * 0.55 + noise(u * 23, v * 23) * 0.30 + noise(u * 61, v * 61) * 0.15;
          const streak = 0.5 + 0.5 * Math.sin(v * 41 + grain * 5);
          const patina = Math.max(0, grain - 0.62) * 2.4;
          const k = 0.72 + grain * 0.42 + streak * 0.10;
          const i = (y * n + x) * 4;
          data[i] = clamp(196 * k - patina * 90, 0, 255);
          data[i + 1] = clamp(148 * k - patina * 20, 0, 255);
          data[i + 2] = clamp(78 * k + patina * 62, 0, 255);
          data[i + 3] = 255;
        }
      }
    });
  }

  /** Soot on the chimney: heavier at the top, streaked where a thumb has wiped it. */
  _makeSootTexture(size) {
    const rand = new Rand((this.settings?.get?.('seed') ?? 0) ^ 0x50075);
    const tab = new Float32Array(64);
    for (let i = 0; i < 64; i++) tab[i] = rand.next();
    return this._canvasTexture(size, (data, n) => {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const u = x / n, v = y / n;
          const t = tab[(((y >> 3) & 7) * 8 + ((x >> 3) & 7)) & 63];
          const streak = 0.5 + 0.5 * Math.sin(u * 29 + t * 9);
          // v = 0 at the base of the lathe profile, 1 at the top: soot climbs.
          const soot = clamp01(Math.pow(v, 1.6) * (0.55 + 0.45 * t) * (0.6 + 0.4 * streak));
          const k = clamp(232 - soot * 178, 0, 255);
          const i = (y * n + x) * 4;
          data[i] = k;
          data[i + 1] = clamp(k * 1.01, 0, 255);
          data[i + 2] = clamp(k * 0.97, 0, 255);
          data[i + 3] = 255;
        }
      }
    });
  }

  /* ------------------------------------------------------------------------- state plumbing */

  _adoptFuelFromState() {
    const st = this.state;
    if (!st) return;
    // GAME_DESIGN §20.2 requests `lanternFuel` on GameState but ARCHITECTURE §8 does not carry
    // it yet. Adopt it if it is there; otherwise own the number here and never add a field to
    // somebody else's save file.
    if (Number.isFinite(st.lanternFuel)) {
      this._ownsFuelField = true;
      this.setFuelUnits(st.lanternFuel);
    } else {
      this._ownsFuelField = false;
      this.fuel = this._fuelUnits / TUNING.fuelCapacity;
    }
  }

  _writeFuelToState() {
    if (this._ownsFuelField && this.state) this.state.lanternFuel = this._fuelUnits;
  }

  /* ------------------------------------------------------------------------------ emitters */

  /**
   * D1: the metallic click. GAME_DESIGN §9.6 fixes radius 5; the canonical kind list has no
   * quiet metallic entry, so this follows AUDIO_DIRECTION §1.2 C4's precedent and uses the
   * nearest canonical kind campers actually respond to.
   */
  _emitClick(scale = 1) {
    if (!this.bus) return;
    this.bus.emit('noise:emit', {
      // A fresh vector, not `flamePosition` — a listener may hold the payload for a second
      // and a live reference would drift with the player. These fire a handful of times a
      // night, so the allocation is free and the aliasing bug it prevents is not.
      position: this.flamePosition.clone(),
      radius: TUNING.clickRadius * scale,
      intensity: TUNING.clickIntensity * scale,
      kind: TUNING.clickKind,
    });
  }

  _emitShutter() {
    if (!this.bus) return;
    this.bus.emit('noise:emit', {
      position: this.flamePosition.clone(),
      radius: TUNING.shutterRadius,
      intensity: TUNING.shutterIntensity,
      kind: TUNING.clickKind,
    });
  }

  _sfx(id, volume = 1, rate = 1) {
    if (!this.bus) return;
    this.bus.emit('audio:sfx', { id, position: this.flamePosition.clone(), volume, rate });
  }
}

Flashlight.TUNING = TUNING;
Flashlight.FLAME_DETECTION = FLAME_DETECTION;

export default Flashlight;
