/**
 * THE POST-PROCESS STACK.  Owned by: Render agent.
 *
 * Engine calls `Postprocessing.render()` instead of `renderer.render()`, so this file owns the
 * frame from the scene draw all the way to the pixels on the canvas.
 *
 * ---------------------------------------------------------------------------------------------
 * ORDER (ART_DIRECTION.md §12 is binding on ordering; it puts bloom AFTER dof so bloom sees a
 * temporally-stable, defocused image and therefore never crawls):
 *
 *   0  scene  -> MRT (HDR RGBA16F + gbuffer slot) + depth texture      [TAA-jittered projection]
 *   1  normals reconstructed from depth (full res)      -> this.normalTexture   (VIEW space)
 *   2  GTAO-style horizon AO (half res) + bilateral cross blur guided by depth AND normal
 *   3  SSR (half res, tier >= high) — up-facing/wet surfaces only, roughness-blurred, edge-faded
 *   4  meter chain: compress 64x64 -> mean 8x8 -> 1x1 exposure/focus adaptation ping-pong
 *      (two DIFFERENT shaders; running one shader twice is what pinned the old metric)
 *   5  RESOLVE       : scene * AO, + SSR, then the VolumetricFog composite  (c*fog.a + fog.rgb)
 *   6  TAA           : YCoCg variance clamp, camera-reprojection velocity, 8-frame history
 *   7  MOTION BLUR   : reprojection velocity, <=12 taps, off when settings.motionBlur is false
 *   8  DOF           : focus = what the reticle hits (GPU-smoothed), near-field when carrying
 *   9  BLOOM         : karis-average prefilter, 6-mip downsample, progressive tent upsample
 *  10  COMPOSITE     : exposure -> AgX (ONCE) -> toe -> lift/gamma/gain split-tone -> vignette
 *                      -> grain -> sRGB encode -> triangular blue-noise dither
 *  11  FXAA          : only when TAA is off (low/medium)
 *
 * ---------------------------------------------------------------------------------------------
 * ANTI-ALIASING: we ship TAA at high/ultra and FXAA at low/medium.
 * TAA was chosen (ART_DIRECTION §10.1) because rain streaks and dithered foliage are temporal
 * problems that no spatial filter can fix, and because the volumetrics and the AO both need the
 * ~1.5 stops of noise reduction that temporal accumulation buys. It is made artifact-free here by
 * (a) a YCoCg *variance* clamp (gamma 1.25) rather than min/max, which does not degenerate over a
 * dithered edge, (b) a disocclusion test on reprojected depth that drops the history weight to
 * zero rather than smearing, and (c) a luminance-difference feedback modulation that kills the
 * classic ghost trail behind a moving camper even though we have no per-object velocity yet.
 *
 * VELOCITY: the velocity used by TAA and motion blur is derived per-pixel by reprojecting the
 * depth buffer through the previous frame's un-jittered view-projection. That is exact for the
 * camera (which is the dominant motion in a first-person game) and zero for static geometry.
 * Attachment 1 of the MRT is reserved for a real per-object velocity/normal-roughness gbuffer:
 * the moment Materials.js starts emitting SC_MRT_OUT (ART_DIRECTION §11.4 F5) set
 * `post.gbufferIsAuthored = true` and the resolve/TAA will prefer it. See the report notes.
 *
 * ---------------------------------------------------------------------------------------------
 * ---------------------------------------------------------------------------------------------
 * BUDGET, MEASURED. `await post.bench()` (bottom of this file) at ?shot=site-close&quality=ultra,
 * 2560x1440 (dpr 2), engine stopped, on this M-series machine. Milliseconds, GPU:
 *
 *     volumetric fog (NOT ours)   1.30      taa (resolve + history copy)   0.89
 *     gtao + bilateral blur       1.82      resolve                        0.07
 *     bloom chain                 1.46      ssr                            0.19
 *     composite                   1.26      motion blur                    0.00 (idle camera)
 *     normals from depth          1.17      meter chain (64x64/8x8/1x1)    ~0.3
 *     dof                         0.64      -------------------------------------
 *                                           WHOLE POST STACK               7.6
 *
 * 7.6 ms at 3.69 Mpx is 2.06 ns/pixel, i.e. 4.3 ms at 1080p — inside ARCHITECTURE's 6 ms.
 * THE POST STACK IS NOT WHY THE FRAME IS SLOW. In the same session the same instrument put the
 * scene draw at 24.6 ms and its four shadow maps at 12.0 ms, so 36.6 of a 44.5 ms synchronised
 * frame — 82% — is geometry and shadows, neither of which is in this file. The three things the
 * brief suspected all measured cheap: SSR is 0.19 ms because its up-facing mask discards almost
 * every pixel at night, the exposure reduction is ~0.3 ms because it really is 64x64 -> 8x8 ->
 * 1x1, and TAA renders the scene exactly once (see _renderScene, called once per render()).
 *
 * Two things this file then gave back, neither of which touches the ultra look:
 *   - the normal buffer is HALF RES. Every consumer (GTAO, SSR, and the 800x450 fog march) was
 *     already sampling below full res. Worth 1.2-1.5 ms, measured 4/4 in an interleaved A/B.
 *   - `_renderScale`, which sizes the scene target and every post target together, so it scales
 *     the WHOLE frame rather than just post. 1.0 on ultra — the ultra frame is unchanged — and
 *     0.90 / 0.75 / 0.60 down the ladder, which is where §13's 'low must still be playable' now
 *     comes from.
 *
 * On `low` everything above collapses to scene -> composite (AgX + grade + grain + vignette +
 * dither) -> FXAA, at 0.60 render scale.
 *
 * GLSL rule (ARCHITECTURE.md §11b): never a backtick inside a shader comment. 'Single quotes'.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { Log } from '../core/Log.js';
import { Rand } from '../core/Rand.js';

/* ============================================================================================
 * module-scope scratch — no allocation in update()/render()
 * ========================================================================================== */
const _m4a = new THREE.Matrix4();
const _m4b = new THREE.Matrix4();
const _v2a = new THREE.Vector2();
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();

/* --------------------------------------------------------------------------------------------
 * EXPOSURE CONSTANTS — the single most consequential numbers in this file.
 *
 * THE BUG, found by reading the chain instead of the frame. `_renderExposure()` ran the SAME
 * shader (FRAG_LUM) twice: once over the scene, once over its own 64x64 output. Pass 1 writes a
 * LOG-average, i.e. a NEGATIVE number, into .r with .gb = 0. Pass 2 then evaluates
 * 'scLuma( max( rgb, vec3( 0.0 ) ) )' on that — the max() clamps the negative signal away, the
 * luma of (0,0,0) is 0, and the pass writes log( max( 0.0, SC_METER_FLOOR ) ). Every texel.
 * Every frame. Regardless of the scene. The metric was therefore the hard constant
 * exp( log( 1e-4 ) ) = 1e-4, which is exactly the '1.013e-4' two previous passes measured and
 * both attributed to the metering FLOOR being too high. The floor was never the problem. The
 * reduction stage had eaten the signal, so no floor value could ever have made the loop adapt.
 *
 * WHAT REPLACES IT. Two stages, not one shader run twice:
 *   FRAG_LUM   scene -> 64x64, arithmetic mean of a Reinhard-compressed luminance
 *              f(x) = x / (x + SC_METER_K) with x = luma * exposure. Bounded in [0,1], monotone,
 *              cannot pin on a floor, and — because SC_METER_K sits just above moonlit mud —
 *              a lantern flame filling the frame cannot own the metric the way a raw mean would.
 *   FRAG_MEAN  64x64 -> 8x8, a PLAIN arithmetic mean. Mean-of-means over uniform taps is exact,
 *              which is the whole reason the transform and the reduction are now separate.
 *
 * WHY THERE IS A GAIN AT ALL, given §3.1.2 says exposure is scripted. It still is: uExposure.x is
 * the scripted curve and nothing else writes it. What sits on top is a bounded TRIM whose target
 * is the bible's own number — §3.1.1's average-frame-luminance window, 0.018-0.028 for `clear`.
 * Measured: keyart-site.png, pushed back through this exact composite, has an average frame
 * luminance of 0.0218 — dead centre of that window — at exposure 0.598. The art direction and the
 * reference art agree with each other. Our SCENE does not: the same measurement on
 * shots/now-siteclose.png needs exposure 3.47 to land in the window and shots/ridge-fixed.png
 * needs 1.31. That is a scene-radiometry offset of ~2.3 stops, and it varies by ~1.4 stops
 * between shots, so it can be neither ignored nor fixed with one constant.
 *
 *   EXPOSURE_CALIBRATION  the fixed part of that offset. Multiplies the scripted curve so §3.1.2's
 *                         table (0.62 / 0.44 / 0.70 / 0.95) stays readable in the bible's units.
 *   [GAIN_MIN, GAIN_MAX]  the WINDOW — 1.5 stops wide, and it is a window in both directions. It
 *                         cannot produce a day-bright night because it solves toward the §3.1.1
 *                         window: to get there it would have to be told that 'day-bright' is what
 *                         the bible asks for, and the reference art says it is not.
 * -------------------------------------------------------------------------------------------- */
const EXPOSURE_BASE = 0.62;
/** Scene-radiometry calibration. 0.62 * 3.0 = 1.86 total; the window then covers 1.30 .. 3.72. */
const EXPOSURE_CALIBRATION = 3.0;
/**
 * Target for the compressed meter.
 *
 * RE-DERIVED BY SWEEP, not by inference. The previous 0.100 was solved by pushing reference images
 * back THROUGH this composite — a reasonable method that stopped being valid the moment the
 * composite changed (the pivot and the human-light axis below both move the relationship between
 * scene radiance and display luminance). It was also solved against a scene that has since been
 * relit twice.
 *
 * The replacement was measured forward, on the live build at `?shot=site-close&quality=ultra`, by
 * holding the meter reading fixed (0.0764) and stepping the target, then reading the FINAL 8-bit
 * frame with assertLuma() at each step:
 *
 *     key    total exp   avg luma   P25       P50       P75
 *     0.100  2.44        0.04471    0.00631   0.01223   0.03776
 *     0.080  1.95        0.03657    0.00547   0.00991   0.02950
 *     0.065  1.58        0.03020    0.00491   0.00827   0.02337
 *     0.055  1.34        0.02584    0.00457   0.00734   0.01935
 *     0.045  1.10        0.02129    0.00427   0.00646   0.01540
 *     0.036  0.88        0.01723    0.00405   0.00577   0.01201
 *
 * keyart-site.png, measured the same way, is avg 0.02184 / P50 0.00693 / P75 0.01600. The curve
 * crosses all three of those between 0.045 and 0.055, and it is the only row in the sweep that
 * matches the reference on more than one statistic at once. 0.048 sits there with a little
 * headroom for the highlights (see BLOOM_INTENSITY, which is where the reference's clipped 0.34%
 * of frame now comes from — our flame is not authored hot enough to clip on exposure alone).
 *
 * §3.1.1's window for this frame is 0.018-0.028. 0.100 put it at 0.045: a stop and a half over its
 * own document, every frame, on the game's hero shot.
 */
const EXPOSURE_KEY = 0.048;
/**
 * THE WINDOW, widened — measured, not loosened for taste.
 *
 * At 0.70..2.00 the trim spanned 1.5 stops. The file's own calibration note records a scene-
 * radiometry offset that varies by ~1.4 stops BETWEEN SHOTS, so a 1.5-stop window has almost no
 * headroom left once it has absorbed that variance, and the loop pins. Measured on the current
 * build at `?shot=site-close&quality=ultra`: the frame ran at gain 1.18 and delivered an average
 * frame luminance of 0.0362 against §3.1.1's 0.015-0.026 window for this weather — 39% over the
 * ceiling — with the correction it needed (~0.62x) sitting just outside the old floor.
 *
 * A second measurement moved the floor again, from 0.42 to 0.34. The `ridge` shot pins fog at
 * 0.65 and, once the froxel volume has actually converged (it has not, in any capture taken
 * immediately after a resize — see assertLuma), that frame measures avg 0.0836: inside §3.1.1's
 * WHITEOUT window, on a night the table calls clear. The trim was already pinned at its floor and
 * had no authority left. It is deliberately NOT fixed by reclassifying the frame as a whiteout —
 * that raises the target 4.35x and would make an over-bright frame brighter still — it is fixed by
 * giving the floor somewhere to go. Frames that are not pinned (site-close runs at gain 0.62) do
 * not move at all.
 *
 * 0.34..5.00 is 3.88 stops. It is still a WINDOW in both directions and it still solves toward
 * §3.1.1's table rather than toward 'brighter', so it cannot produce a day-bright night: to get
 * there it would have to be told that day-bright is what the bible asks for.
 *
 * A THIRD MEASUREMENT MOVED THE CEILING, 2.30 -> 5.00, and this one is a consequence of the black
 * point rather than of the scene. Two things happened at once:
 *
 *   - removing the sRGB(5,10,13) pedestal removed REAL ENERGY from the frame. That floor sat on
 *     ~90% of the pixels, so it was contributing a large constant to the average, and the meter
 *     target EXPOSURE_KEY was solved forward against a frame that still had it.
 *   - Sky.js corrected scene.fog from #6e808b to #2f3f49 (measured at runtime during this pass),
 *     which correctly deletes the grey wash that was standing in for distance.
 *
 * Measured on ?shot=site-close&quality=ultra at 1600x900 after both: the meter reads 0.0124
 * against a target of 0.048, i.e. the loop is asking for gain 3.87 and the ceiling was 2.30. It
 * was pinned, 0.75 stops short, and the frame measured avg display luma 0.0106 against
 * keyart-site.png's 0.1028.
 *
 * Widening a CEILING is safe in a way that changing EXPOSURE_CALIBRATION would not be, and that is
 * the whole reason to fix it here: this is a solved loop, not a fixed offset. If the scene gets its
 * light back the loop simply solves back down — a wider ceiling cannot brighten a frame that is
 * already hitting §3.1.1's target, it can only stop a genuinely dark one from staying blank. That
 * is the same argument that moved the floor 0.42 -> 0.34, applied to the other end.
 */
const EXPOSURE_GAIN_MIN = 0.34;
const EXPOSURE_GAIN_MAX = 5.00;

/* --------------------------------------------------------------------------------------------
 * THE BLACK POINT — measured, and the largest single visual defect this file has shipped. FIXED;
 * the numbers that closed it are at the bottom of this block.
 *
 * Every one of the twelve canonical shots reported a darkest pixel of EXACTLY sRGB(5,10,13), with
 * the 0.1st percentile equal to the minimum in every channel, and 0.00% of the frame below display
 * luma 0.02. Three stacked floors produced that, all of them in FRAG_COMPOSITE:
 *
 *   1. the toe's additive '+ 0.0024' in display-linear  (~ sRGB 8 on every channel, every pixel)
 *   2. the grade's ADDITIVE lift (0.0000, 0.0032, 0.0126) — 0.0126 is sRGB 40 on blue
 *   3. 'col = max( col, SC_ABYSS )' with SC_ABYSS = sRGB(6,11,14), and a final clamp whose lower
 *      bound was SC_ABYSS - 1/255 — i.e. literally RGB(5,10,13), the measured minimum
 *
 * plus two smaller ones: the art vignette mixing toward a constant #0a1216 (a corner floor of
 * sRGB(3,7,11) on black), and film grain whose amplitude PEAKED at L = 0, which re-plants a
 * pedestal in noise the moment the encode clamps it asymmetrically.
 *
 * BLACK_POINT is subtracted per channel (with a soft knee — see FRAG_COMPOSITE, it matters) and
 * BLACK_RESTORE multiplies what is left. The restore is not a taste value: it is
 * P50 / (P50 - black) against the measured linear-luma percentiles of shots/base-site-close.png,
 * so the midtones land back where they were and only the floor and the ceiling move. The ceiling
 * moves because a 2.7x on the top of the range is what finally drives the lantern core and the
 * moon disc into the clip — the reference art puts 0.23% of its pixels above display luma 0.8 and
 * we were shipping 0.001%.
 *
 * MEASURED AFTER, ?shot=site-close&quality=ultra, 1600x900, read back off the default framebuffer.
 * 'display luma' below is (0.2126R + 0.7152G + 0.0722B)/255 on the 8-bit frame — the metric the
 * evaluation used, NOT relative luminance in linear light; the two differ by a factor of four on
 * this material and confusing them is how the floor got argued about twice:
 *
 *                       min RGB      % below display luma 0.02   frac > 0.8    all channels < 12
 *     before (base-*)   (5,10,13)    0.000                       0.000008      0.00%
 *     after             (0,0,0)      28.3                        0.00037       23.1%
 *     keyart-site.png   (0,0,0)      17.1                        0.00226       24.4%
 *
 * ---------------------------------------------------------------------------------------------
 * A MEASUREMENT TRAP THAT COST AN ENTIRE EVALUATION, recorded here so it is not paid twice.
 *
 * `Engine.captureFrame()` resizes the renderer, renders ONE frame, and reads the canvas. One frame
 * is not enough for the volumetric fog's reprojection or the TAA history — both are cleared by the
 * resize — so every shots/*.png written that way is a COLD frame that the game never displays. The
 * same scene, same code, measured cold and warm:
 *
 *     cold (1 frame after resize)   % below 0.02 = 75.6   P50 = 0.00026   avg linear = 0.0122
 *     warm (70 frames after resize) % below 0.02 = 28.3   P50 = 0.00879   avg linear = 0.0253
 *
 * That is five stops of pure instrumentation error, and it is the same class of mistake this file
 * already documented once for assertLuma() and readPixels. To measure a shot honestly: size the
 * canvas to the capture size FIRST, render ~70 frames, and only then call __CAPTURE__(name,w,h) —
 * the resize inside captureFrame is then a no-op and the frame written is the converged one.
 * ------------------------------------------------------------------------------------------ */
const BLACK_POINT = [0.00250, 0.00250, 0.00250];
const BLACK_RESTORE = 2.70;
/** Shadow tint reached at luma 0, faded out by uGradeLift.w. Multiplicative — see the lift note. */
const GRADE_SHADOW_TINT = [0.88, 1.00, 1.34];

/**
 * §12.6 grain size: 1.35 px at 1080p, scaled with resolution so a grain stays physically constant.
 * The scale used to be floored at 0.75, which let a 900p capture render 1.01 px cells — i.e. sub-
 * pixel noise, which an 8-bit encode and a display resample both eat. The floor is now 1.0: grain
 * may grow with resolution, never shrink below the spec'd physical size.
 */
const GRAIN_PX = 1.35;
/** Mid-density granularity bump — see the amplitude block in FRAG_COMPOSITE. */
const GRAIN_MID = 0.017;

/* --------------------------------------------------------------------------------------------
 * BLOOM — "bite, do not smear".
 *
 * §12.2 gives threshold 1.15 / knee 0.35 / intensity 0.055 on the stated assumption that a flame
 * is authored 'at 8-13 scene-linear'. Measured on the current build it is not: at
 * `?shot=site-close&quality=ultra` the brightest 0.1% of the FINAL frame sat at 0.368 relative
 * luminance and 0.000% of the frame was above 0.5, against the reference frame's 0.855 and 0.340%.
 * Nothing in the image was over-range, so a 1.15 threshold was subtracting from a signal that
 * never arrived and the lantern shipped with no halo at all.
 *
 * Threshold drops to where the flame actually is; the KNEE is what keeps this from being a screen
 * glow — it widens from 0.35 to 0.55 so the transition into bloom is soft and only the flame and
 * the hottest 20 cm of timber around it accumulate through the mip chain. The Karis average in the
 * prefilter (unchanged) is what stops a single blown rain streak firefly-ing across all seven mips.
 * ------------------------------------------------------------------------------------------ */
const BLOOM_THRESHOLD = 0.72;
const BLOOM_KNEE = 0.55;
const BLOOM_INTENSITY = 0.260;

/**
 * SSCS blend strength in the resolve. Not 1.0: the trace does not know WHICH light lit the pixel
 * (there is no per-pixel light index in a forward build, §3.6 assigns lights per MESH), so a seam
 * traced against the lantern is applied to a pixel that may be moon-lit. 0.62 is the value at
 * which the seam under a seated part reads at 2 m and a mis-attributed occlusion is below the
 * §4.2 contrast the player is asked to search by.
 */
const SSCS_STRENGTH = 0.62;

/**
 * §3.1.1 asserts a DIFFERENT average-luminance window per weather state, because a foggy night is
 * physically a brighter, flatter night. The meter target is scaled by the row's midpoint over
 * `clear`'s midpoint, so the loop chases the bible rather than flattening every night to one key.
 */
const METER_TARGET_SCALE = {
  clear: 1.00,          // 0.018 - 0.028
  drizzle: 0.89,        // 0.015 - 0.026
  'windy-mist': 1.20,   // 0.021 - 0.034
  rain: 0.85,           // 0.014 - 0.025
  whiteout: 4.35,       // 0.070 - 0.130
  storm: 0.76,          // 0.012 - 0.023
  dawn: 3.15,           // 0.050 - 0.095
};

/**
 * §3.1.1's Nights column, which is the authoritative key. Deriving the row from the
 * `weather:change` payload instead does not work: measured on the `ridge` shot, Night 1 runs at
 * fog 0.65 with zero rain, which any fog threshold low enough to catch a real whiteout also
 * catches — and a `whiteout` target on a clear night drives the trim straight into its ceiling and
 * ships the day-bright moonlit snowfield this whole pass exists to prevent.
 */
const NIGHT_METER_STATE = [
  'clear', 'clear', 'drizzle', 'windy-mist', 'rain', 'whiteout', 'storm', 'clear',
];

/** Halton(2,3) — the TAA jitter sequence, phase-locked with the alpha hash (§10.3). */
const HALTON = (() => {
  const h = (i, b) => { let f = 1, r = 0, n = i; while (n > 0) { f /= b; r += f * (n % b); n = Math.floor(n / b); } return r; };
  const out = [];
  for (let i = 1; i <= 16; i++) out.push([h(i, 2) - 0.5, h(i, 3) - 0.5]);
  return out;
})();

/* ============================================================================================
 * GLSL
 * ========================================================================================== */

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

/** Shared helpers. Prepended to every fragment shader below. */
const COMMON = /* glsl */`
precision highp float;
precision highp sampler2D;
varying vec2 vUv;

float scLuma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

// Meter knee. Sits just above moonlit mud (0.05 scene-linear at the calibrated exposure), so the
// metric responds almost linearly across the whole readable band and compresses only the sources
// that would otherwise hijack it -- the lantern flame, the moon disc, a lightning frame.
const float SC_METER_K = 0.18;

// Compressed luminance. Bounded [0,1), monotone, and it has no floor to pin on.
float scMeterCompress( float x ) { return x / ( x + SC_METER_K ); }

// The exposure TRIM. uExposure = ( scripted*calibration, meterTarget, gainMin, gainMax ).
// A window, in both directions. Never a ceiling: GAIN_MIN is what stops a bright frame from
// riding the calibration up, GAIN_MAX is what stops a dark one from staying blank.
float scMeterGain( float meter, vec4 uExposure ) {
  return clamp( uExposure.y / max( meter, 1e-4 ), uExposure.z, uExposure.w );
}

// Hyperbolic depth -> positive view-space distance.
float scLinearDepth( float d, float n, float f ) {
  float z = d * 2.0 - 1.0;
  return ( 2.0 * n * f ) / ( f + n - z * ( f - n ) );
}

// Depth buffer value -> view-space position (z is negative, camera looks down -Z).
vec3 scViewPos( vec2 uv, float d, mat4 projInv ) {
  vec4 c = vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  vec4 v = projInv * c;
  return v.xyz / v.w;
}

vec3 scRGBToYCoCg( vec3 c ) {
  return vec3(
     0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
     0.5  * c.r             - 0.5  * c.b,
    -0.25 * c.r + 0.5 * c.g - 0.25 * c.b
  );
}

vec3 scYCoCgToRGB( vec3 c ) {
  float t = c.x - c.z;
  return vec3( t + c.y, c.x + c.z, t - c.y );
}

// Linear -> sRGB display transfer. Done by hand because the dither must land AFTER the encode.
vec3 scEncodeSRGB( vec3 c ) {
  c = clamp( c, 0.0, 1.0 );
  return mix( c * 12.92, 1.055 * pow( c, vec3( 0.41666 ) ) - 0.055, step( 0.0031308, c ) );
}
`;

/** AgX — the numbers are three.js r185's own AgX so our look matches the engine default. */
const AGX = /* glsl */`
const mat3 SC_AGX_IN = mat3(
  vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
  vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
  vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 )
);
const mat3 SC_AGX_OUT = mat3(
  vec3( 1.1271005818144368, -0.1413297634984383, -0.14132976349843826 ),
  vec3( -0.11060664309660323, 1.157823702216272, -0.11060664309660294 ),
  vec3( -0.016493938717834573, -0.016493938717834257, 1.2519364065950405 )
);
const mat3 SC_SRGB_TO_2020 = mat3(
  vec3( 0.6274, 0.0691, 0.0164 ),
  vec3( 0.3293, 0.9195, 0.0880 ),
  vec3( 0.0433, 0.0113, 0.8956 )
);
const mat3 SC_2020_TO_SRGB = mat3(
  vec3( 1.6605, -0.1246, -0.0182 ),
  vec3( -0.5876, 1.1329, -0.1006 ),
  vec3( -0.0728, -0.0083, 1.1187 )
);

vec3 scAgxContrast( vec3 x ) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return + 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x
         + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

// Applied exactly ONCE, here. renderer.toneMapping is forced to NoToneMapping in init().
vec3 scAgX( vec3 color ) {
  const float minEv = -12.47393;
  const float maxEv = 4.026069;
  color = SC_SRGB_TO_2020 * color;
  color = SC_AGX_IN * color;
  color = max( color, 1e-10 );
  color = log2( color );
  color = ( color - minEv ) / ( maxEv - minEv );
  color = clamp( color, 0.0, 1.0 );
  color = scAgxContrast( color );
  color = SC_AGX_OUT * color;
  color = pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
  color = SC_2020_TO_SRGB * color;
  return clamp( color, 0.0, 1.0 );
}
`;

/* ------------------------------------------------------------------ 1. normals from depth ---- */
const FRAG_NORMAL = COMMON + /* glsl */`
uniform sampler2D tDepth;
uniform mat4 uProjInv;
uniform vec2 uTexel;

vec3 vp( vec2 uv ) {
  return scViewPos( uv, texture2D( tDepth, uv ).x, uProjInv );
}

void main() {
  float d = texture2D( tDepth, vUv ).x;
  if ( d >= 0.999999 ) { gl_FragColor = vec4( 0.5, 0.5, 1.0, 0.0 ); return; }

  vec3 p  = vp( vUv );
  vec3 pl = vp( vUv - vec2( uTexel.x, 0.0 ) );
  vec3 pr = vp( vUv + vec2( uTexel.x, 0.0 ) );
  vec3 pd = vp( vUv - vec2( 0.0, uTexel.y ) );
  vec3 pu = vp( vUv + vec2( 0.0, uTexel.y ) );

  // Pick the closer neighbour on each axis so silhouettes do not smear a fake bevel.
  vec3 dx = ( abs( pr.z - p.z ) < abs( p.z - pl.z ) ) ? ( pr - p ) : ( p - pl );
  vec3 dy = ( abs( pu.z - p.z ) < abs( p.z - pd.z ) ) ? ( pu - p ) : ( p - pd );

  vec3 n = cross( dx, dy );
  float l = length( n );
  n = ( l > 1e-9 ) ? n / l : vec3( 0.0, 0.0, 1.0 );
  if ( dot( n, -normalize( p ) ) < 0.0 ) n = -n;

  gl_FragColor = vec4( n * 0.5 + 0.5, 1.0 );
}
`;

/* ------------------------------------------------------------------ 2. GTAO-ish horizon AO --- */
const FRAG_AO = COMMON + /* glsl */`
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform sampler2D tNoise;
uniform mat4 uProjInv;
uniform vec2 uTexel;        // full-res texel
uniform vec2 uNoiseScale;   // half-res pixel coord -> noise uv
uniform vec4 uParams;       // radius(m), power, intensity, maxScreenRadius(uv)
uniform vec2 uNearFar;
uniform float uFrame;

#ifndef AO_DIRS
  #define AO_DIRS 8
#endif
#ifndef AO_STEPS
  #define AO_STEPS 4
#endif

vec3 vp( vec2 uv ) { return scViewPos( uv, texture2D( tDepth, uv ).x, uProjInv ); }

void main() {
  float d = texture2D( tDepth, vUv ).x;
  if ( d >= 0.999999 ) { gl_FragColor = vec4( 1.0 ); return; }

  vec3 P = scViewPos( vUv, d, uProjInv );
  vec3 N = texture2D( tNormal, vUv ).xyz * 2.0 - 1.0;
  if ( dot( N, N ) < 0.25 ) { gl_FragColor = vec4( 1.0 ); return; }
  N = normalize( N );

  vec4 rnd = texture2D( tNoise, gl_FragCoord.xy * uNoiseScale + uFrame * 0.618034 );
  float baseAngle = rnd.x * 6.2831853;
  float jitter = rnd.y;

  float radius = uParams.x;
  // Project the world radius to screen. Guard against a huge disc when the surface is 20 cm away.
  float screenR = min( radius / max( 0.05, -P.z ) * 0.6, uParams.w );

  float occ = 0.0;
  for ( int i = 0; i < AO_DIRS; i++ ) {
    float a = baseAngle + float( i ) * ( 6.2831853 / float( AO_DIRS ) );
    vec2 dir = vec2( cos( a ), sin( a ) );
    float best = 0.0;
    for ( int s = 0; s < AO_STEPS; s++ ) {
      float t = ( float( s ) + 0.5 + jitter ) / float( AO_STEPS );
      vec2 suv = vUv + dir * ( screenR * t * t );
      if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) break;
      float sd = texture2D( tDepth, suv ).x;
      if ( sd >= 0.999999 ) continue;
      vec3 S = scViewPos( suv, sd, uProjInv );
      vec3 dv = S - P;
      float len = length( dv );
      if ( len < 1e-4 ) continue;
      // Cosine-weighted horizon term with a smooth range check — this is what stops a distant
      // tree from carving a halo into the mud in front of it.
      float fall = clamp( 1.0 - ( len * len ) / ( radius * radius ), 0.0, 1.0 );
      float c = dot( N, dv / len ) - 0.06;
      best = max( best, c * fall );
    }
    occ += clamp( best, 0.0, 1.0 );
  }

  occ /= float( AO_DIRS );
  float ao = pow( clamp( 1.0 - occ * uParams.z, 0.0, 1.0 ), uParams.y );

  // Fade AO out at distance: at 60 m a 0.75 m radius is sub-pixel and only produces noise.
  float dist = scLinearDepth( d, uNearFar.x, uNearFar.y );
  ao = mix( ao, 1.0, smoothstep( 35.0, 75.0, dist ) );

  gl_FragColor = vec4( ao, -P.z, 0.0, 1.0 );
}
`;

/* ------------------------------------------------------------------ 2b. bilateral AO blur ---- */
const FRAG_AO_BLUR = COMMON + /* glsl */`
uniform sampler2D tAO;
uniform sampler2D tNormal;
uniform vec2 uTexel;     // half-res texel
uniform vec2 uDir;       // (1,0) then (0,1)
uniform vec2 uSigma;     // depth sigma, normal power

void main() {
  vec4 c = texture2D( tAO, vUv );
  float centerZ = c.y;
  vec3 centerN = texture2D( tNormal, vUv ).xyz * 2.0 - 1.0;

  float sum = c.x;
  float wsum = 1.0;

  for ( int i = 1; i <= 3; i++ ) {
    float fi = float( i );
    float sw = exp( -0.5 * ( fi * fi ) / 2.25 );
    for ( int s = 0; s < 2; s++ ) {
      vec2 off = uDir * uTexel * fi * ( s == 0 ? 1.0 : -1.0 );
      vec2 suv = vUv + off;
      vec4 sc = texture2D( tAO, suv );
      vec3 sn = texture2D( tNormal, suv ).xyz * 2.0 - 1.0;
      float dz = abs( sc.y - centerZ );
      float wz = exp( -dz * dz / max( 1e-4, uSigma.x ) );
      float wn = pow( max( 0.0, dot( sn, centerN ) ), uSigma.y );
      float w = sw * wz * wn;
      sum += sc.x * w;
      wsum += w;
    }
  }

  gl_FragColor = vec4( sum / max( 1e-5, wsum ), centerZ, 0.0, 1.0 );
}
`;

/* ------------------------------------------------------------------ 2c. SSCS ----------------- */
/**
 * SCREEN-SPACE CONTACT SHADOWS. §12 pass 5, §3.5: 'non-negotiable at high/ultra ... without them
 * every dropped bracket floats and the game reads as a student demo'. It was not in the stack.
 *
 * A shadow map, at any resolution this build can afford, cannot resolve the last few centimetres
 * where an object meets the ground — that is exactly the range where its texel footprint and its
 * depth bias are both larger than the gap being resolved, which is why a bracket lying in the mud
 * has no seam under it and reads as a decal. This marches the depth buffer instead: 0.35 m of
 * trace, in view space, from the surface toward the light, and any geometry the ray passes behind
 * within a thin slab occludes it.
 *
 * Two lights, and only two, because those are the only two that reach the ground near the player:
 * the moon (a direction) and the lantern (a position, so the trace direction is per-pixel and the
 * seam under a part points away from the lamp the way the eye expects). The lantern is the one
 * that matters: it is held low and left (§3.2), so everything it lights has a bottom-up shadow
 * direction and every contact seam it makes is in frame.
 */
const FRAG_SSCS = COMMON + /* glsl */`
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform sampler2D tNoise;
uniform mat4 uProj;
uniform mat4 uProjInv;
uniform vec2 uNoiseScale;
uniform vec2 uNearFar;
uniform vec4 uMoon;      // xyz: view-space direction TOWARD the moon. w: 1 if it should trace
uniform vec4 uLamp;      // xyz: view-space position of the lantern. w: 1 if it should trace
uniform vec4 uParams;    // maxTrace(m), thickness(m), frame, fadeDistance(m)

#ifndef SSCS_STEPS
  #define SSCS_STEPS 12
#endif

// One trace. Returns 0 (fully occluded) .. 1 (clear).
float scTrace( vec3 P, vec3 N, vec3 L, float jitter, float maxT, float thickness ) {
  // Slope-scaled start offset. A surface almost edge-on to the light self-intersects on step 1
  // otherwise, and self-intersection here reads as a black rim, not as a shadow.
  float ndl = max( dot( N, L ), 0.0 );
  vec3 origin = P + N * ( 0.012 + 0.030 * ( 1.0 - ndl ) );

  float stepLen = maxT / float( SSCS_STEPS );
  float occ = 0.0;

  for ( int i = 0; i < SSCS_STEPS; i++ ) {
    float t = ( float( i ) + jitter ) * stepLen;
    vec3 sp = origin + L * t;

    vec4 clip = uProj * vec4( sp, 1.0 );
    if ( clip.w <= 0.0 ) break;
    vec2 uv = ( clip.xy / clip.w ) * 0.5 + 0.5;
    if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) break;

    float sd = texture2D( tDepth, uv ).x;
    if ( sd >= 0.999999 ) continue;                     // sky occludes nothing
    vec3 S = scViewPos( uv, sd, uProjInv );

    // Both z are negative. S.z > sp.z means the depth buffer has a surface in FRONT of the ray,
    // i.e. the ray has gone behind something. 'thickness' is what stops a tree trunk 40 m away
    // from being treated as an infinitely deep occluder of the mud in front of it.
    float diff = S.z - sp.z;
    if ( diff > 0.002 && diff < thickness ) {
      // Contact-weighted: an occluder found on the first step is a hard seam, one found at the
      // end of the trace is the soft tail of a penumbra. This is the whole reason the effect
      // reads as CONTACT rather than as a second, smaller ambient occlusion.
      occ = max( occ, 1.0 - t / maxT );
    }
  }

  return 1.0 - clamp( occ, 0.0, 1.0 );
}

void main() {
  float d = texture2D( tDepth, vUv ).x;
  if ( d >= 0.999999 ) { gl_FragColor = vec4( 1.0 ); return; }

  vec3 N = texture2D( tNormal, vUv ).xyz * 2.0 - 1.0;
  if ( dot( N, N ) < 0.25 ) { gl_FragColor = vec4( 1.0 ); return; }
  N = normalize( N );

  vec3 P = scViewPos( vUv, d, uProjInv );

  // A 0.35 m trace is sub-pixel past ~30 m and returns nothing but noise there.
  float dist = -P.z;
  float fade = 1.0 - smoothstep( uParams.w * 0.6, uParams.w, dist );
  if ( fade <= 0.01 ) { gl_FragColor = vec4( 1.0 ); return; }

  float jitter = texture2D( tNoise, gl_FragCoord.xy * uNoiseScale + uParams.z * 0.618034 ).y;

  float vis = 1.0;
  if ( uMoon.w > 0.5 && dot( N, uMoon.xyz ) > 0.02 ) {
    vis = min( vis, scTrace( P, N, normalize( uMoon.xyz ), jitter, uParams.x, uParams.y ) );
  }
  if ( uLamp.w > 0.5 ) {
    vec3 toLamp = uLamp.xyz - P;
    float lampDist = length( toLamp );
    if ( lampDist > 0.05 && lampDist < 18.0 ) {
      vec3 L = toLamp / lampDist;
      if ( dot( N, L ) > 0.02 ) {
        vis = min( vis, scTrace( P, N, L, jitter, uParams.x, uParams.y ) );
      }
    }
  }

  gl_FragColor = vec4( mix( 1.0, vis, fade ), 0.0, 0.0, 1.0 );
}
`;

/* ------------------------------------------------------------------ 3. SSR ------------------- */
const FRAG_SSR = COMMON + /* glsl */`
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform sampler2D tNoise;
uniform mat4 uProj;
uniform mat4 uProjInv;
uniform mat4 uViewInv;
uniform vec2 uTexel;
uniform vec2 uNoiseScale;
uniform vec2 uNearFar;
uniform vec4 uParams;   // wetness, thickness, maxDist, frame
uniform float uStrength;

#ifndef SSR_STEPS
  #define SSR_STEPS 16
#endif

void main() {
  float d = texture2D( tDepth, vUv ).x;
  if ( d >= 0.999999 ) { gl_FragColor = vec4( 0.0 ); return; }

  vec3 N = texture2D( tNormal, vUv ).xyz * 2.0 - 1.0;
  if ( dot( N, N ) < 0.25 ) { gl_FragColor = vec4( 0.0 ); return; }
  N = normalize( N );

  // No stencil buffer on this renderer (Engine constructs it with stencil:false), so the
  // 'puddles and lake only' mask is geometric: up-facing surfaces, gated by global wetness.
  vec3 wN = normalize( ( uViewInv * vec4( N, 0.0 ) ).xyz );
  float mask = smoothstep( 0.72, 0.94, wN.y ) * mix( 0.18, 1.0, clamp( uParams.x, 0.0, 1.0 ) );
  if ( mask < 0.01 ) { gl_FragColor = vec4( 0.0 ); return; }

  vec3 P = scViewPos( vUv, d, uProjInv );
  vec3 V = normalize( P );
  vec3 R = reflect( V, N );
  if ( R.z > 0.0 ) { gl_FragColor = vec4( 0.0 ); return; }   // reflecting back at the near plane

  float jitter = texture2D( tNoise, gl_FragCoord.xy * uNoiseScale + uParams.w * 0.618034 ).z;

  float maxDist = uParams.z;
  float stepLen = maxDist / float( SSR_STEPS );
  vec3 hitColor = vec3( 0.0 );
  float conf = 0.0;
  vec2 hitUv = vec2( 0.0 );

  vec3 rp = P + R * stepLen * ( 0.35 + jitter * 0.65 );
  for ( int i = 0; i < SSR_STEPS; i++ ) {
    vec4 clip = uProj * vec4( rp, 1.0 );
    if ( clip.w <= 0.0 ) break;
    vec2 suv = ( clip.xy / clip.w ) * 0.5 + 0.5;
    if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) break;

    float sd = texture2D( tDepth, suv ).x;
    vec3 sp = scViewPos( suv, sd, uProjInv );
    float delta = sp.z - rp.z;      // both negative; >0 means the ray went behind geometry

    if ( delta > 0.0 && delta < uParams.y * ( 1.0 + stepLen ) ) {
      // Binary refine so the reflection of a stud edge is an edge, not a staircase.
      vec3 lo = rp - R * stepLen, hi = rp;
      for ( int k = 0; k < 4; k++ ) {
        vec3 mid = ( lo + hi ) * 0.5;
        vec4 mc = uProj * vec4( mid, 1.0 );
        vec2 muv = ( mc.xy / mc.w ) * 0.5 + 0.5;
        vec3 mp = scViewPos( muv, texture2D( tDepth, muv ).x, uProjInv );
        if ( mp.z - mid.z > 0.0 ) hi = mid; else lo = mid;
        suv = muv;
      }
      hitUv = suv;
      hitColor = texture2D( tScene, suv ).rgb;
      conf = 1.0;
      break;
    }
    rp += R * stepLen;
  }

  if ( conf <= 0.0 ) { gl_FragColor = vec4( 0.0 ); return; }

  // Edge fade — a reflection that runs off the side of the screen must die, not pop.
  vec2 e = smoothstep( vec2( 0.0 ), vec2( 0.12 ), hitUv )
         * ( 1.0 - smoothstep( vec2( 0.88 ), vec2( 1.0 ), hitUv ) );
  conf *= e.x * e.y;
  // Grazing angles reflect, head-on angles do not (Fresnel-ish, cheap).
  conf *= mix( 0.25, 1.0, pow( 1.0 - max( 0.0, dot( -V, N ) ), 3.0 ) );
  conf *= mask * uStrength;

  gl_FragColor = vec4( hitColor, clamp( conf, 0.0, 1.0 ) );
}
`;

/* ------------------------------------------------------------------ 4. luminance + adapt ----- */
const FRAG_LUM = COMMON + /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uCell;         // the UV footprint of ONE output texel. See the note below.
uniform float uExposureIn;  // the scripted*calibrated exposure the meter is solving around

// TRANSFORM stage. Scene HDR -> 64x64 of compressed luminance. This is the ONLY stage that
// applies scMeterCompress(); the reduction below is a plain mean, which is why mean-of-means is
// exact. Running one shader for both stages is what silently pinned the old metric (see the
// exposure block at the top of this file).
//
// RESOLUTION INDEPENDENCE, and this was a real bug. The tap offsets used to be
// 'o * uSpan * uTexel' with uSpan = 8 and uTexel = 1 / sceneWidth, i.e. each of the 4096 output
// texels sampled an 8-SOURCE-PIXEL neighbourhood. The output grid steps 1/64 of the image, so the
// meter only ever looked at 8 pixels out of every 25 at 1600 wide and 8 out of every 40 at 2560:
// it sampled 32% of the frame at one resolution and 20% at another, and it sampled a DIFFERENT
// 32% in x than in y on any non-square target. On a frame that is a near-black field plus one
// small very bright lantern, which is every frame in this game, that aliasing moved the metric by
// a full stop between the 2560x1440 canvas and the 1600x900 capture -- the same scene, graded two
// stops apart depending on how it was being looked at.
//
// uCell is now the UV footprint of one output texel (1/64, 1/64), so the 8x8 taps tile that cell
// exactly and the 64x64 target is a true, complete, aspect-correct average of the whole frame.
void main() {
  float sum = 0.0;
  for ( int y = 0; y < 8; y++ ) {
    for ( int x = 0; x < 8; x++ ) {
      vec2 o = ( vec2( float( x ), float( y ) ) + 0.5 ) / 8.0 - 0.5;
      vec2 uv = clamp( vUv + o * uCell, vec2( 0.001 ), vec2( 0.999 ) );
      float l = scLuma( max( texture2D( tDiffuse, uv ).rgb, vec3( 0.0 ) ) );
      sum += scMeterCompress( max( l, 0.0 ) * uExposureIn );
    }
  }
  gl_FragColor = vec4( sum / 64.0, 0.0, 0.0, 1.0 );
}
`;

/** REDUCTION stage. 64x64 -> 8x8, plain arithmetic mean of .r. No transform, on purpose. */
const FRAG_MEAN = COMMON + /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
uniform float uSpan;

void main() {
  float sum = 0.0;
  for ( int y = 0; y < 8; y++ ) {
    for ( int x = 0; x < 8; x++ ) {
      vec2 o = ( vec2( float( x ), float( y ) ) + 0.5 ) / 8.0 - 0.5;
      vec2 uv = clamp( vUv + o * uSpan * uTexel, vec2( 0.001 ), vec2( 0.999 ) );
      sum += texture2D( tDiffuse, uv ).x;
    }
  }
  gl_FragColor = vec4( sum / 64.0, 0.0, 0.0, 1.0 );
}
`;

const FRAG_ADAPT = COMMON + /* glsl */`
uniform sampler2D tLum;      // 8x8 compressed-luma partials
uniform sampler2D tPrev;     // 1x1 previous adaptation
uniform sampler2D tDepth;    // for the reticle focus distance
uniform vec2 uNearFar;
uniform vec4 uParams;        // dt, lumaTau, focusTau, firstFrame

void main() {
  float sum = 0.0;
  for ( int y = 0; y < 8; y++ ) {
    for ( int x = 0; x < 8; x++ ) {
      sum += texture2D( tLum, ( vec2( float( x ), float( y ) ) + 0.5 ) / 8.0 ).x;
    }
  }
  // Plain mean of the 8x8 partials -> the frame's compressed-luminance metric. NOT exponentiated:
  // nothing in the new chain is in a log domain, and re-applying a transform here is the exact
  // shape of the bug this replaced.
  float target = clamp( sum / 64.0, 1e-4, 1.0 );

  // Reticle focus: a small cross of taps so a thin twig at the crosshair does not grab focus.
  float fd = 0.0;
  fd += scLinearDepth( texture2D( tDepth, vec2( 0.5, 0.5 ) ).x, uNearFar.x, uNearFar.y );
  fd += scLinearDepth( texture2D( tDepth, vec2( 0.485, 0.5 ) ).x, uNearFar.x, uNearFar.y );
  fd += scLinearDepth( texture2D( tDepth, vec2( 0.515, 0.5 ) ).x, uNearFar.x, uNearFar.y );
  fd += scLinearDepth( texture2D( tDepth, vec2( 0.5, 0.485 ) ).x, uNearFar.x, uNearFar.y );
  fd += scLinearDepth( texture2D( tDepth, vec2( 0.5, 0.515 ) ).x, uNearFar.x, uNearFar.y );
  fd = clamp( fd / 5.0, 0.35, 90.0 );

  vec4 prev = texture2D( tPrev, vec2( 0.5 ) );
  float pl = ( uParams.w > 0.5 || prev.x <= 0.0 ) ? target : prev.x;
  float pf = ( uParams.w > 0.5 || prev.y <= 0.0 ) ? fd : prev.y;

  float kl = 1.0 - exp( -uParams.x / max( 0.03, uParams.y ) );
  float kf = 1.0 - exp( -uParams.x / max( 0.03, uParams.z ) );

  float adaptedL = mix( pl, target, kl );
  float adaptedF = mix( pf, fd, kf );

  // .x adapted meter (compressed, [1e-4,1]) .y reticle focus distance (DOF reads this)
  // .z this frame's un-adapted meter (dev HUD / the §3.1.1 assert)
  gl_FragColor = vec4( clamp( adaptedL, 1e-4, 1.0 ), adaptedF, target, 1.0 );
}
`;

/* ------------------------------------------------------------------ 5. resolve ---------------- */
const FRAG_RESOLVE = COMMON + /* glsl */`
uniform sampler2D tScene;
uniform sampler2D tAO;
uniform sampler2D tSSR;
uniform sampler2D tFog;
uniform sampler2D tSSCS;
uniform vec2 uTexel;
uniform vec4 uParams;    // aoStrength, ssrStrength, exposureHint, sscsStrength

void main() {
  vec3 col = max( texture2D( tScene, vUv ).rgb, vec3( 0.0 ) );

  // --- ambient occlusion. We have no split direct/indirect buffer, so AO is weighted down where
  // the pixel is already brightly lit: a lantern hotspot must not acquire dirty corners.
  float ao = texture2D( tAO, vUv ).x;
  float lit = clamp( scLuma( col ) * uParams.z, 0.0, 4.0 );
  float aoW = uParams.x * ( 1.0 - smoothstep( 0.30, 1.60, lit ) );
  col *= mix( 1.0, ao, aoW );

  // --- screen-space contact shadows (§3.5). Unlike AO this is a DIRECT-light occlusion, so it is
  // deliberately NOT weighted down in bright pixels: the lantern pool is precisely where a
  // contact seam has to appear, and backing it off there would delete the effect exactly where
  // §4.1's Confirm band asks the object to 'read as a seated solid, not a decal'. Softened by a
  // 4-tap cross because the trace runs at half res and its edge would otherwise stair-step.
  float cs = texture2D( tSSCS, vUv ).x;
  cs += texture2D( tSSCS, vUv + vec2( uTexel.x * 1.5, 0.0 ) ).x;
  cs += texture2D( tSSCS, vUv - vec2( uTexel.x * 1.5, 0.0 ) ).x;
  cs += texture2D( tSSCS, vUv + vec2( 0.0, uTexel.y * 1.5 ) ).x;
  cs += texture2D( tSSCS, vUv - vec2( 0.0, uTexel.y * 1.5 ) ).x;
  col *= mix( 1.0, clamp( cs * 0.2, 0.0, 1.0 ), uParams.w );

  // --- screen-space reflections, softened by a 4-tap cross (stands in for roughness blur).
  vec4 s0 = texture2D( tSSR, vUv );
  vec4 s1 = texture2D( tSSR, vUv + vec2( uTexel.x * 2.0, 0.0 ) );
  vec4 s2 = texture2D( tSSR, vUv - vec2( uTexel.x * 2.0, 0.0 ) );
  vec4 s3 = texture2D( tSSR, vUv + vec2( 0.0, uTexel.y * 2.0 ) );
  vec4 s4 = texture2D( tSSR, vUv - vec2( 0.0, uTexel.y * 2.0 ) );
  vec4 ssr = ( s0 * 2.0 + s1 + s2 + s3 + s4 ) / 6.0;
  col = mix( col, ssr.rgb, clamp( ssr.a * uParams.y, 0.0, 0.85 ) );

  // --- volumetrics. Contract with VolumetricFog: rgb = in-scattered radiance (pre-multiplied),
  // a = transmittance. The fallback texture is (0,0,0,1) so this is a no-op when fog is absent.
  vec4 fog = texture2D( tFog, vUv );
  // Degenerate-buffer guard. A live fog buffer only drives transmittance toward 0 while its
  // in-scatter rises, so a texel that is zero in BOTH carries no information -- it is a cleared
  // or never-written target (a fog shader that failed to compile, a resize mid-frame). Without
  // this the multiply annihilates the entire frame to black. Treat it as 'no fog' instead.
  float fogValid = step( 1e-5, fog.a + fog.r + fog.g + fog.b );
  fog = mix( vec4( 0.0, 0.0, 0.0, 1.0 ), fog, fogValid );
  col = col * fog.a + fog.rgb;

  gl_FragColor = vec4( col, 1.0 );
}
`;

/* ------------------------------------------------------------------ 6. TAA -------------------- */
const FRAG_TAA = COMMON + /* glsl */`
uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tDepth;
uniform mat4 uProjInv;
uniform mat4 uViewInv;
uniform mat4 uPrevViewProj;
uniform vec2 uTexel;
uniform vec2 uJitter;      // current frame jitter, in UV
uniform vec4 uParams;      // feedbackMin, feedbackMax, clampGamma, sharpen
uniform float uReset;

void main() {
  vec3 cur = max( texture2D( tCurrent, vUv ).rgb, vec3( 0.0 ) );

  float d = texture2D( tDepth, vUv ).x;
  vec3 vp = scViewPos( vUv, d, uProjInv );
  vec4 world = uViewInv * vec4( vp, 1.0 );
  vec4 prevClip = uPrevViewProj * world;
  vec2 prevUv = ( prevClip.xy / max( 1e-6, prevClip.w ) ) * 0.5 + 0.5;

  if ( uReset > 0.5 || prevClip.w <= 0.0 ||
       prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0 ) {
    gl_FragColor = vec4( cur, 1.0 );
    return;
  }

  // --- 3x3 neighbourhood, YCoCg, VARIANCE clamp (gamma 1.25). min/max is a no-op over a
  // dithered foliage edge; variance is not. ART_DIRECTION §10.3.
  vec3 m1 = vec3( 0.0 ), m2 = vec3( 0.0 );
  vec3 nmin = vec3( 1e9 ), nmax = vec3( -1e9 );
  for ( int y = -1; y <= 1; y++ ) {
    for ( int x = -1; x <= 1; x++ ) {
      vec3 s = scRGBToYCoCg( max( texture2D( tCurrent, vUv + vec2( float( x ), float( y ) ) * uTexel ).rgb, vec3( 0.0 ) ) );
      m1 += s; m2 += s * s;
      nmin = min( nmin, s ); nmax = max( nmax, s );
    }
  }
  vec3 mu = m1 / 9.0;
  vec3 sigma = sqrt( max( vec3( 0.0 ), m2 / 9.0 - mu * mu ) );
  vec3 lo = max( nmin, mu - uParams.z * sigma );
  vec3 hi = min( nmax, mu + uParams.z * sigma );

  vec3 histY = scRGBToYCoCg( max( texture2D( tHistory, prevUv ).rgb, vec3( 0.0 ) ) );
  vec3 clamped = clamp( histY, lo, hi );
  vec3 hist = scYCoCgToRGB( clamped );

  // Feedback modulation: how far the history had to be dragged is how untrustworthy it is.
  float dist = length( clamped - histY ) / max( 1e-4, length( sigma ) + 0.02 );
  float feedback = mix( uParams.y, uParams.x, clamp( dist * 0.5, 0.0, 1.0 ) );

  // Sub-pixel motion also lowers trust — this is what kills the trail behind a walking camper
  // even without a per-object velocity buffer.
  vec2 vel = ( vUv - uJitter ) - prevUv;
  feedback *= 1.0 - clamp( length( vel ) / ( 12.0 * uTexel.x ), 0.0, 0.55 );

  vec3 outc = mix( cur, hist, feedback );

  // CAS-style sharpen inside the resolve so grain (applied later) is not amplified.
  if ( uParams.w > 0.0 ) {
    vec3 blur = vec3( 0.0 );
    blur += max( texture2D( tCurrent, vUv + vec2( uTexel.x, 0.0 ) ).rgb, vec3( 0.0 ) );
    blur += max( texture2D( tCurrent, vUv - vec2( uTexel.x, 0.0 ) ).rgb, vec3( 0.0 ) );
    blur += max( texture2D( tCurrent, vUv + vec2( 0.0, uTexel.y ) ).rgb, vec3( 0.0 ) );
    blur += max( texture2D( tCurrent, vUv - vec2( 0.0, uTexel.y ) ).rgb, vec3( 0.0 ) );
    outc = max( vec3( 0.0 ), outc + ( outc - blur * 0.25 ) * uParams.w );
  }

  gl_FragColor = vec4( outc, 1.0 );
}
`;

/* ------------------------------------------------------------------ 7. motion blur ------------ */
const FRAG_MOTION = COMMON + /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform mat4 uProjInv;
uniform mat4 uViewInv;
uniform mat4 uPrevViewProj;
uniform sampler2D tNoise;
uniform vec2 uNoiseScale;
uniform vec2 uJitter;
uniform vec2 uTexel;
uniform vec4 uParams;    // shutter, maxVelUv, frame, unused

#ifndef MB_TAPS
  #define MB_TAPS 8
#endif

void main() {
  float d = texture2D( tDepth, vUv ).x;
  vec3 vp = scViewPos( vUv, d, uProjInv );
  vec4 world = uViewInv * vec4( vp, 1.0 );
  vec4 prevClip = uPrevViewProj * world;

  vec3 base = texture2D( tDiffuse, vUv ).rgb;
  if ( prevClip.w <= 0.0 ) { gl_FragColor = vec4( base, 1.0 ); return; }

  vec2 prevUv = ( prevClip.xy / prevClip.w ) * 0.5 + 0.5;
  vec2 vel = ( ( vUv - uJitter ) - prevUv ) * uParams.x;

  float len = length( vel );
  if ( len < uTexel.x * 0.75 ) { gl_FragColor = vec4( base, 1.0 ); return; }
  // Clamp so a fast turn does not melt the frame (ART_DIRECTION §10.4).
  vel *= min( 1.0, uParams.y / len );

  float jitter = texture2D( tNoise, gl_FragCoord.xy * uNoiseScale + uParams.z * 0.618034 ).w;

  vec3 sum = base;
  float wsum = 1.0;
  for ( int i = 1; i < MB_TAPS; i++ ) {
    float t = ( float( i ) + jitter ) / float( MB_TAPS );
    vec2 uv = vUv - vel * t;
    if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) continue;
    float w = 1.0 - t * 0.55;
    sum += texture2D( tDiffuse, uv ).rgb * w;
    wsum += w;
  }

  gl_FragColor = vec4( sum / wsum, 1.0 );
}
`;

/* ------------------------------------------------------------------ 8. depth of field --------- */
const FRAG_DOF = COMMON + /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform sampler2D tAdapt;
uniform vec2 uTexel;
uniform vec2 uNearFar;
uniform vec4 uParams;    // maxRadiusPx, farStrength, nearStrength, focusBias

#ifndef DOF_TAPS
  #define DOF_TAPS 12
#endif

void main() {
  vec3 base = texture2D( tDiffuse, vUv ).rgb;
  float focus = max( 0.3, texture2D( tAdapt, vec2( 0.5 ) ).y + uParams.w );
  float dist = scLinearDepth( texture2D( tDepth, vUv ).x, uNearFar.x, uNearFar.y );

  float coc;
  if ( dist < focus ) coc = -( 1.0 - dist / focus ) * uParams.z;
  else coc = ( 1.0 - focus / dist ) * uParams.y;

  float radius = abs( coc ) * uParams.x;
  if ( radius < 0.75 ) { gl_FragColor = vec4( base, 1.0 ); return; }

  vec3 sum = base;
  float wsum = 1.0;
  const float GA = 2.39996323;
  for ( int i = 1; i <= DOF_TAPS; i++ ) {
    float fi = float( i );
    float a = fi * GA;
    float r = sqrt( fi / float( DOF_TAPS ) ) * radius;
    vec2 uv = vUv + vec2( cos( a ), sin( a ) ) * r * uTexel;
    if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) continue;
    // Reject samples much nearer than the centre so a sharp foreground does not bleed outward.
    float sd = scLinearDepth( texture2D( tDepth, uv ).x, uNearFar.x, uNearFar.y );
    float w = ( coc > 0.0 && sd < focus * 0.92 ) ? 0.08 : 1.0;
    sum += texture2D( tDiffuse, uv ).rgb * w;
    wsum += w;
  }

  gl_FragColor = vec4( sum / wsum, 1.0 );
}
`;

/* ------------------------------------------------------------------ 9. bloom ------------------ */
const FRAG_BLOOM_PRE = COMMON + /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D tAdapt;
uniform vec2 uTexel;      // source texel
uniform vec4 uParams;     // threshold, knee, exposure, dirtAmount
uniform vec4 uExposure;   // identical to the composite's, so both agree on what 'bright' means

vec3 karis( vec3 a, vec3 b, vec3 c, vec3 d ) {
  float wa = 1.0 / ( 1.0 + scLuma( a ) );
  float wb = 1.0 / ( 1.0 + scLuma( b ) );
  float wc = 1.0 / ( 1.0 + scLuma( c ) );
  float wd = 1.0 / ( 1.0 + scLuma( d ) );
  return ( a * wa + b * wb + c * wc + d * wd ) / ( wa + wb + wc + wd );
}

void main() {
  // The SAME total exposure the composite will apply, metered gain included. If these two ever
  // disagree, the §12.2 threshold stops meaning anything.
  float ex = uParams.z * scMeterGain( texture2D( tAdapt, vec2( 0.5 ) ).x, uExposure );

  vec2 o = uTexel;
  vec3 a = max( texture2D( tDiffuse, vUv + vec2( -o.x, -o.y ) ).rgb, vec3( 0.0 ) ) * ex;
  vec3 b = max( texture2D( tDiffuse, vUv + vec2(  o.x, -o.y ) ).rgb, vec3( 0.0 ) ) * ex;
  vec3 c = max( texture2D( tDiffuse, vUv + vec2( -o.x,  o.y ) ).rgb, vec3( 0.0 ) ) * ex;
  vec3 d = max( texture2D( tDiffuse, vUv + vec2(  o.x,  o.y ) ).rgb, vec3( 0.0 ) ) * ex;
  // Karis average BEFORE the threshold: this is what stops one blown rain streak from
  // firefly-ing across the whole mip chain.
  vec3 col = karis( a, b, c, d );

  float br = max( col.r, max( col.g, col.b ) );
  float knee = max( 1e-4, uParams.y );
  float soft = clamp( br - uParams.x + knee, 0.0, 2.0 * knee );
  soft = soft * soft / ( 4.0 * knee );
  float contrib = max( soft, br - uParams.x ) / max( br, 1e-4 );

  gl_FragColor = vec4( col * contrib, 1.0 );
}
`;

const FRAG_BLOOM_DOWN = COMMON + /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uTexel;      // source texel

void main() {
  vec2 o = uTexel;
  vec3 a = texture2D( tDiffuse, vUv + vec2( -2.0 * o.x,  2.0 * o.y ) ).rgb;
  vec3 b = texture2D( tDiffuse, vUv + vec2(  0.0,        2.0 * o.y ) ).rgb;
  vec3 c = texture2D( tDiffuse, vUv + vec2(  2.0 * o.x,  2.0 * o.y ) ).rgb;
  vec3 d = texture2D( tDiffuse, vUv + vec2( -2.0 * o.x,  0.0 ) ).rgb;
  vec3 e = texture2D( tDiffuse, vUv ).rgb;
  vec3 f = texture2D( tDiffuse, vUv + vec2(  2.0 * o.x,  0.0 ) ).rgb;
  vec3 g = texture2D( tDiffuse, vUv + vec2( -2.0 * o.x, -2.0 * o.y ) ).rgb;
  vec3 h = texture2D( tDiffuse, vUv + vec2(  0.0,       -2.0 * o.y ) ).rgb;
  vec3 i = texture2D( tDiffuse, vUv + vec2(  2.0 * o.x, -2.0 * o.y ) ).rgb;
  vec3 j = texture2D( tDiffuse, vUv + vec2( -o.x,  o.y ) ).rgb;
  vec3 k = texture2D( tDiffuse, vUv + vec2(  o.x,  o.y ) ).rgb;
  vec3 l = texture2D( tDiffuse, vUv + vec2( -o.x, -o.y ) ).rgb;
  vec3 m = texture2D( tDiffuse, vUv + vec2(  o.x, -o.y ) ).rgb;

  vec3 col = e * 0.125;
  col += ( a + c + g + i ) * 0.03125;
  col += ( b + d + f + h ) * 0.0625;
  col += ( j + k + l + m ) * 0.125;

  gl_FragColor = vec4( col, 1.0 );
}
`;

const FRAG_BLOOM_UP = COMMON + /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uTexel;      // source texel
uniform vec3 uTint;
uniform float uWeight;

void main() {
  vec2 o = uTexel * 1.0;
  vec3 col = vec3( 0.0 );
  col += texture2D( tDiffuse, vUv + vec2( -o.x,  o.y ) ).rgb * 1.0;
  col += texture2D( tDiffuse, vUv + vec2(  0.0,  o.y ) ).rgb * 2.0;
  col += texture2D( tDiffuse, vUv + vec2(  o.x,  o.y ) ).rgb * 1.0;
  col += texture2D( tDiffuse, vUv + vec2( -o.x,  0.0 ) ).rgb * 2.0;
  col += texture2D( tDiffuse, vUv                      ).rgb * 4.0;
  col += texture2D( tDiffuse, vUv + vec2(  o.x,  0.0 ) ).rgb * 2.0;
  col += texture2D( tDiffuse, vUv + vec2( -o.x, -o.y ) ).rgb * 1.0;
  col += texture2D( tDiffuse, vUv + vec2(  0.0, -o.y ) ).rgb * 2.0;
  col += texture2D( tDiffuse, vUv + vec2(  o.x, -o.y ) ).rgb * 1.0;
  col /= 16.0;
  gl_FragColor = vec4( col * uTint * uWeight, 1.0 );
}
`;

/* ------------------------------------------------------------------ 10. composite ------------- */
const FRAG_COMPOSITE = COMMON + AGX + /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform sampler2D tAdapt;
uniform sampler2D tNoise;
uniform vec2 uResolution;
uniform vec2 uNoiseSize;

uniform vec4 uExposure;    // base, key, minGain, maxGain
uniform vec4 uBloom;       // intensity, dirt, warmTint, unused
uniform vec4 uGradeLift;
uniform vec4 uGradeGamma;
uniform vec4 uGradeGain;
uniform vec4 uSat;         // global, highlightThresh, highlightSat, shadowSat
uniform vec4 uVignette;    // artAmount, artInner, artOuter, opticalAmount
uniform vec4 uGrain;       // amount, sizePx, flicker, midGrain
uniform vec4 uLens;        // caStrength, warp, panic, lightning
uniform vec4 uContrast;    // pivot power, pivot, unused, unused
uniform vec4 uWarm;        // warmth ramp lo, warmth ramp hi, warm saturation, warm split weight
uniform vec4 uBlack;       // per-channel black point (subtracted), .w = midtone-restore gain
uniform vec4 uToe;         // toe crush at 0, toe knee, unused, unused
uniform vec3 uVigTint;     // vignette RESIDUAL TRANSMISSION (a multiplier, not a paint colour)
uniform vec3 uSplitCool;   // multiplier at luma 0 -- shadows
uniform vec3 uSplitWarm;   // multiplier at luma 1 -- highlights only
uniform float uTime;
uniform float uFrame;

vec3 sampleScene( vec2 uv ) {
  return max( texture2D( tDiffuse, clamp( uv, vec2( 0.0 ), vec2( 1.0 ) ) ).rgb, vec3( 0.0 ) );
}

void main() {
  vec2 uv = vUv;
  vec2 d = uv - 0.5;
  d.x *= uResolution.x / uResolution.y;   // circular, not elliptical
  float r = length( d ) / 0.5;

  // --- panic lens warp (subtle barrel push, only when spotted)
  if ( uLens.y > 0.0001 ) {
    vec2 c = uv - 0.5;
    uv = 0.5 + c * ( 1.0 + uLens.y * dot( c, c ) * 4.0 );
  }

  // --- transverse chromatic aberration: zero at centre, ~1.4 px at the corner. 3 taps.
  vec3 col;
  float ca = uLens.x * pow( clamp( r, 0.0, 1.4 ), 2.4 );
  if ( ca > 1e-6 ) {
    vec2 dir = ( r > 1e-5 ) ? normalize( uv - 0.5 ) : vec2( 0.0 );
    col.r = sampleScene( uv + dir * ca ).r;
    col.g = sampleScene( uv ).g;
    col.b = sampleScene( uv - dir * ca ).b;
  } else {
    col = sampleScene( uv );
  }

  // --- bloom. Fetched here, ADDED after the exposure multiply below -- the bloom prefilter has
  // already multiplied by the same exposure, so adding it before the multiply applied exposure to
  // it twice and made the glow scale as exposure-squared.
  vec3 bloom = max( texture2D( tBloom, uv ).rgb, vec3( 0.0 ) );
  // Procedural veiling / lens dirt. Very subtle: if you can see it, it is wrong.
  float dirt = 0.85 + 0.30 * texture2D( tNoise, uv * 3.0 ).x;

  // --- EXPOSURE. Scripted curve x metered trim.
  //
  // uExposure.x is §3.1.2's scripted curve (0.62 base, 0.44 blueprint, 0.70 whiteout, 0.95 dawn,
  // 0.30 at a lightning peak) multiplied by EXPOSURE_CALIBRATION. Nothing else writes it.
  //
  // The trim is a WINDOW, not a ceiling, and it is solved against §3.1.1's average-frame-luminance
  // table rather than eyeballed. Bounded at both ends: it cannot ride the calibration up on a
  // bright frame and it cannot leave a dark one blank.
  float gain = scMeterGain( texture2D( tAdapt, vec2( 0.5 ) ).x, uExposure );
  col *= uExposure.x * gain;

  // Bloom is already in exposed space; add it now. The moon disc is authored at 8-13 scene-linear
  // precisely so that at this exposure it survives here, clips AgX, and feeds the mip chain.
  col += bloom * uBloom.x * mix( 1.0, dirt, uBloom.y );

  // --- tone map. ONCE. renderer.toneMapping is NoToneMapping.
  col = scAgX( col );

  // --- the toe (ART_DIRECTION §12.4). Monotonic, and it never reaches zero.
  //
  // CRUSHED AT THE VERY BOTTOM, NOT ACROSS THE LOWER HALF. Measured against the reference frame:
  // keyart-site.png puts its 25th percentile at 0.0024 display luminance and its 75th at 0.0160,
  // i.e. the readable band — studs, lumber stack, sawhorse, far trunks — begins around 0.006 and
  // the crush has to be finished before it. A knee at 0.045 (the previous value) multiplied that
  // entire band by 0.62-0.85 and was most of why our frame read as blank rather than dark: it was
  // attacking exactly the range §4 asks the player to search in. 0.016 ends the toe below the
  // reference's own 25th percentile, so the crush now lands only on true shadow.
  //
  // --- THE PIVOT (added: measured). AgX's toe is long and soft, which is correct, but the image
  // that arrives here is a 0.02-average night sitting on a volumetric-fog pedestal, so the entire
  // readable band — mud, timber, far trunks — lands inside about one AgX decade and reads FLAT.
  // Measured on the reference: keyart-site.png runs P25 0.00241 / P75 0.01600, an interquartile
  // ratio of 6.6:1. Our pre-pivot frame ran P25 0.00555 / P75 0.03208, ratio 5.8:1, with the whole
  // distribution shifted a stop and a half up onto the haze. A power around a fixed pivot fixes
  // both halves at once and is the only op here that can: it pushes the pedestal DOWN into black
  // and the lantern core UP toward the clip, without moving the pivot itself.
  //
  // The pivot is 0.055 because §3.1 exposes for 'the wet mud in the moon' at 0.045 relative
  // luminance — the pivot has to sit at the value the whole exposure model is built around, or the
  // op is a brightness change wearing a contrast change's clothes.
  col = uContrast.y * pow( max( col, vec3( 1e-6 ) ) / uContrast.y, vec3( uContrast.x ) );

  // --- the toe. AFTER the pivot. It crushes and it REACHES ZERO — the additive '+ 0.0024' that
  // used to live on the end of this line is gone, and it was the single largest visual defect in
  // the build. See THE BLACK POINT below for the measurement that removed it.
  col = col * mix( vec3( uToe.x ), vec3( 1.0 ), smoothstep( vec3( 0.0 ), vec3( uToe.y ), col ) );

  // --- THE BLACK POINT (measured; supersedes ART_DIRECTION §12.4's floored toe).
  //
  // §12.4 specifies 'toe(L) = L * mix(0.55,1,smoothstep(0.006,0.055,L)) + 0.0026', a published
  // black point of sRGB #060c11, and an assert that NO channel may reach 0. That contract was
  // implemented faithfully and it is why every one of the twelve canonical shots measured a
  // darkest pixel of EXACTLY sRGB(5,10,13) with the 0.1st, 1st and 5th percentiles all sitting on
  // it, and 0.00% of the frame below display luma 0.02. The bible's own reference art disagrees
  // with the bible:
  //
  //     public/img/keyart-site.png   min RGB(0,0,0)   17.05% of pixels below display luma 0.02
  //     public/img/keyart-lake.png   min RGB(0,0,0)   10.73%
  //     shots/base-site-close.png    min RGB(5,10,13)  0.00%
  //
  // Linear-luminance percentiles, ours against the reference, same shot framing:
  //
  //              P1       P5       P10      P25      P50      P75      P95      P99      P99.9
  //     keyart   0.00000  0.00037  0.00089  0.00241  0.00693  0.01600  0.08868  0.27878  0.85535
  //     ours     0.00290  0.00310  0.00325  0.00365  0.00453  0.00653  0.04717  0.17705  0.31848
  //
  // The reference spans 11.2 stops from P5 to P99.9; we spanned 6.7. The missing 4.5 stops are
  // split almost exactly between a floor that could not go below 0.0029 and a ceiling that never
  // reached the clip. Both ends are fixed here and NEITHER is fixed by moving exposure: this is a
  // subtract-then-restore, solved so that P50 lands back on the value it already had.
  //
  //     out = max( in - black, 0 ) * gain,    gain = P50 / ( P50 - black )
  //
  // Everything at or under the pedestal goes to a true 0; the midtones return to where they were;
  // and the top of the range is multiplied out until the lantern core and the moon disc actually
  // clip, which is the other half of what makes a night frame read as photographed.
  //
  // THE SUBTRACT IS SOFT, AND THAT IS NOT A REFINEMENT -- IT IS THE SAME BUG AGAIN OTHERWISE.
  // The defect this whole block exists to remove was diagnosed, correctly, as 'the 0.1th percentile
  // equals the minimum in every channel -- a hard clamp with a large mass of pixels sitting on it'.
  // A hard 'max( col - black, 0 )' reproduces that pathology exactly; it just moves the plateau
  // from sRGB(5,10,13) down to sRGB(0,0,0). Measured with the hard form on ?shot=site-close:
  // P5 = 0.00000 and P25 = 0.00072, i.e. a quarter of the frame welded to literal zero, against
  // keyart-site.png's P5 0.00037 / P25 0.00241. The reference does not have a plateau at either
  // end -- it has a distribution that runs continuously into black.
  //
  // The soft form is
  //
  //     f( c ) = c - black * ( 1 - exp( -c / black ) )
  //
  // which is 0 at c = 0 EXACTLY (so true black is still reachable and still reached), is
  // asymptotically c - black for c >> black (so the midtones and the ceiling are untouched -- at
  // c = 6*black it is already within 0.25% of the hard subtract), is monotone, and has
  // f'( c ) = 1 - exp( -c / black ), i.e. a real slope through the knee instead of a wall.
  //
  // That slope is also the fix for a second reported defect. TAA is running and its jitter IS
  // reaching the projection matrix (verified at runtime: uJitter read back as exactly
  // Halton(2,3)[1] = (0, -1/6) texels), yet stud silhouettes still stair-stepped at a 2x crop.
  // A hard black point is why: TAA resolves an edge into a smooth sub-pixel ramp in HDR, and then
  // a wall at 'black' followed by a 2.7x gain re-quantises that ramp into a step. Anti-aliasing
  // done upstream cannot survive a discontinuity applied downstream. The soft knee is C-infinity,
  // so the ramp stays a ramp.
  vec3 blk = max( uBlack.rgb, vec3( 1e-6 ) );
  col = ( col - blk * ( 1.0 - exp( -col / blk ) ) ) * uBlack.w;

  // --- THE HUMAN-LIGHT AXIS (added: measured).
  //
  // §2.1: 'The world is blue-green. The only warm light in the world is human.' The grade below
  // implements the first half — a blue lift, a blue gamma, a blue gain, a cool split — and until
  // now it applied that cool push to EVERY pixel, including the lantern pool, which is the one
  // place in the frame the same document forbids it. Measured, warm pixels (R > 90, R > B + 15):
  //
  //     keyart-site.png   mean warm RGB (142, 88, 48)   B/R 0.341   saturation 0.68
  //     our frame         mean warm RGB (131, 98, 80)   B/R 0.614   saturation 0.38
  //
  // R and G already agree with the reference to within 8%. The entire visible difference — the
  // reason our timber reads SALMON where the reference reads wet warm brown — is 26 extra points
  // of blue, and about 18% of that is this grade putting it there.
  //
  // 'warmth' is a HUE signal, not a brightness one: it is ~0 across the blue-black field and the
  // fog, and ramps to 1 across the lantern's falloff. Everything cool below is weighted by its
  // complement, so §2.1's first half keeps every pixel it was written for and loses the one it
  // was never meant to touch. This is not a global amber lift (§2.4 forbids that by name) — it
  // cannot warm a pixel that is not already warm, because warmth of a neutral pixel is zero.
  float chroma  = ( col.r - col.b ) / max( col.r + col.b, 1e-4 );
  float warmth  = smoothstep( uWarm.x, uWarm.y, chroma );
  float cool    = 1.0 - warmth;

  // --- lift / gamma / gain. §12.4.
  //
  // All three are HUE-NEUTRAL-TO-COOL and they stay that way. The previous values were
  // gain (1.06, 1.00, 0.92) and gamma (1.02, 1.00, 0.96): a +15% red-over-blue swing applied to
  // every pixel in the frame. That is a global amber grade lift, and §2.4 forbids it by name --
  // 'the amber only ever appears as point sources and their falloff, never as a global grade
  // lift'. It is also most of why the wet blue-black world was rendering as chalky neutral grey:
  // warm the shadows of a blue scene and they land on the neutral axis.
  //
  // THE LIFT IS NOW MULTIPLICATIVE, and that is the second half of the black-point fix. An
  // ADDITIVE lift of (0.0000, 0.0032, 0.0126) — the value this line shipped with — plants a floor
  // that no downstream op can remove: 0.0126 in display-linear is sRGB code 40 on blue, applied to
  // every pixel in the frame including the ones that are supposed to be nothing. Measured on a
  // scene-black pixel, the additive lift plus the shadow-saturation boost below encoded it to
  // sRGB(0,10,40), display luma 0.039 — twice the 0.02 threshold, before the abyss clamp even ran.
  // A shadow TINT does the job the lift was written for (shadows go blue-green, never grey) and is
  // a multiplier, so black stays black: at col = 0 the result is 0 on every channel.
  float shadeL = scLuma( col );
  float shadeW = ( 1.0 - smoothstep( 0.0, uGradeLift.w, shadeL ) ) * cool;
  col *= mix( vec3( 1.0 ), uGradeLift.rgb, shadeW );
  col = pow( max( col, vec3( 1e-5 ) ),
             vec3( 1.0 ) / max( mix( vec3( 1.0 ), uGradeGamma.rgb, cool ), vec3( 0.05 ) ) );
  col = col * mix( vec3( 1.0 ), uGradeGain.rgb, cool );

  float luma = scLuma( col );
  // Global saturation is a filmic pull-down on the world and a small push-up on human light: the
  // reference's warm pixels are MORE saturated than ours (0.68 vs 0.38), not less, and the pool is
  // the one region where AgX's per-channel desaturation has the most to undo.
  col = mix( vec3( luma ), col, mix( uSat.x, uWarm.z, warmth ) );
  // Highlights go creamy rather than radioactive; shadows keep their blue instead of going grey.
  float hi = smoothstep( uSat.y, 1.0, luma );
  col = mix( col, mix( vec3( luma ), col, uSat.z ), hi );
  // The shadow-saturation band. §12.4 puts it under 0.08; an earlier pass widened it to 0.20 to
  // reach the readable range of a frame that was 1.5 stops too dark. Now that the exposure lands
  // where §3.1.1 asks, 0.20 covers most of the LANTERN POOL, and boosting chroma there turned
  // amber-lit timber into salmon. 0.115 puts the boost back on the blue-black it exists for.
  float lo = 1.0 - smoothstep( 0.0, 0.115, luma );
  col = mix( col, mix( vec3( luma ), col, uSat.w ), lo * cool );

  // --- split-tone, and this is the ONLY place amber is allowed near the grade. The warm half is
  // reached two ways and only two: by being a HIGHLIGHT (a fire core, the lantern hotspot, a lit
  // window) or by already being WARM (§2.1 — which in this world means: by being lit by a human
  // source). Everything else is pushed the other way, into the blue-black the whole palette is
  // built on. Gating on 'hi' alone was the bug: the lantern POOL — the falloff, which is most of
  // the amber in frame and all of the amber in the reference — sits at luma 0.10-0.30, well under
  // the 0.70 highlight threshold, so the cool half was being applied to it. The frame was
  // literally cooling the only warm light in the game.
  col *= mix( uSplitCool, uSplitWarm, clamp( max( hi, warmth * uWarm.w ), 0.0, 1.0 ) );

  // --- panic desaturation
  col = mix( col, vec3( scLuma( col ) ), uLens.z * 0.55 );

  // --- vignette: cos^4 optical falloff (part of the lens, always on) + a blue art vignette.
  float cosTheta = inversesqrt( 1.0 + r * r * 0.62 );
  float optical = pow( cosTheta, 4.0 );
  col *= mix( 1.0, optical, uVignette.w );
  // The art vignette is a LIGHT LOSS, not a paint. Mixing toward a constant tint colour (the
  // previous 'mix( col, uVigTint, art )' with uVigTint = #0a1216 in linear) is a third floor: at
  // the corner, art reaches 0.283, so a black corner pixel was being repainted to 0.283 * tint =
  // sRGB(3,7,11) no matter how dark the scene behind it was — over a corner region that is a real
  // fraction of frame area. uVigTint is now RESIDUAL TRANSMISSION per channel: it darkens and it
  // cools, it multiplies, and it takes zero to zero.
  float art = clamp( smoothstep( uVignette.y, uVignette.z, r ) * uVignette.x, 0.0, 0.92 );
  col *= mix( vec3( 1.0 ), uVigTint, art );

  // --- 1/f gate flicker. Costs nothing, and it is half of why the frame reads as 'shot'.
  col *= 1.0 + uGrain.z * ( sin( uTime * 7.3 ) * 0.5 + sin( uTime * 21.7 ) * 0.3 + sin( uTime * 3.1 ) * 0.2 );

  // --- encode, then grain, then dither. Grain must live in display space or it vanishes in
  // exactly the shadows where real stock has the most of it.
  col = scEncodeSRGB( max( col, vec3( 0.0 ) ) );

  if ( uGrain.x > 0.0 ) {
    // Correct grain SIZE — the noise is fetched at 1 sample per uGrain.y device pixels, NEAREST,
    // so a grain is a physical 1.35 px cell at 1080p and scales with resolution.
    vec2 gc = floor( gl_FragCoord.xy / max( 1.0, uGrain.y ) );
    vec2 guv = ( gc + vec2( uFrame * 37.0, uFrame * 17.0 ) ) / uNoiseSize;
    vec3 n = texture2D( tNoise, guv ).rgb * 2.0 - 1.0;
    n *= vec3( 1.25, 1.0, 1.25 );          // dye-cloud behaviour: R and B are coarser
    float L = clamp( scLuma( col ), 0.0, 1.0 );
    // AMPLITUDE vs LUMA. §12.6 gives a monotonic shadow-heavy curve, 0.055*(1-L)^1.4 + 0.008, and
    // that is only half of how a negative behaves. RMS granularity of a real 35 mm stock peaks
    // around MID density and falls off at both ends: the clear base has little silver to clump and
    // the shoulder is saturated. A purely shadow-weighted curve therefore puts all of its noise
    // exactly where our frame has no signal, which is why the previous value was invisible in the
    // lantern pool and read as a dirty screen in the corners rather than as stock.
    //
    // Three terms: the §12.6 shadow term, a 4L(1-L) mid-density bump (uGrain.w, the term that
    // actually lands on the timber and the mud), and a small constant floor so the highlights are
    // not clinically clean.
    //
    // CLEAR-BASE ROLLOFF (added with the black point). Additive grain of +/- 0.039 sitting on a
    // pixel that is meant to be zero clips asymmetrically at the encode floor and re-plants, in
    // noise, exactly the pedestal the black point just removed: half the samples clamp to 0 and
    // half ride up to +10/255, so the MEAN of a black region lands near 5/255 again. The rolloff
    // is also the physics this comment block already claims — 'the clear base has little silver to
    // clump' — which the previous curve contradicted by peaking at L = 0.
    float mid = 4.0 * L * ( 1.0 - L );
    float base = mix( 0.22, 1.0, smoothstep( 0.0, 0.05, L ) );
    float amp = uGrain.x * ( 0.034 * pow( 1.0 - L, 1.4 ) + uGrain.w * mid + 0.005 ) * base;
    col += n * amp;
  }

  // DELETED HERE: 'col = max( col, SC_ABYSS )', SC_ABYSS = sRGB(6,11,14), plus a final clamp whose
  // LOWER bound was SC_ABYSS - 1/255 = sRGB(5,10,13). That pair is the literal reason every one of
  // the twelve canonical shots reported a darkest pixel of exactly RGB(5,10,13) with the 0.1th
  // percentile equal to the minimum in every channel. It was written to satisfy §12.4's
  // 'no channel equal to 0 anywhere in the frame' assert; the reference art the whole document is
  // graded against has min RGB(0,0,0) and 17% of its pixels below display luma 0.02, so the assert
  // was protecting the frame from the thing that makes it look photographed. The blue-black of
  // 'shadow.abyss' is now produced by the multiplicative shadow tint above, which colours the dark
  // without pinning it.
  //
  // --- triangular-PDF blue-noise dither, +/- 1 LSB. MANDATORY: our whole useful range lives in
  // the bottom 5% of an 8-bit framebuffer and would band catastrophically without it. It is also
  // what keeps the crushed region from being a flat plate of literal zeros: the dither still has
  // somewhere to go upward, and the clamp below is the only thing under it.
  vec2 duv = ( gl_FragCoord.xy + vec2( uFrame * 13.0, uFrame * 7.0 ) ) / uNoiseSize;
  vec2 dn = texture2D( tNoise, duv ).xy;
  float tri = ( dn.x + dn.y - 1.0 );
  col += tri / 255.0;

  gl_FragColor = vec4( clamp( col, vec3( 0.0 ), vec3( 1.0 ) ), 1.0 );
}
`;

/* ------------------------------------------------------------------ 11. FXAA ------------------ */
const FRAG_FXAA = COMMON + /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uTexel;

void main() {
  vec3 rgbM = texture2D( tDiffuse, vUv ).rgb;
  vec3 rgbNW = texture2D( tDiffuse, vUv + vec2( -uTexel.x,  uTexel.y ) ).rgb;
  vec3 rgbNE = texture2D( tDiffuse, vUv + vec2(  uTexel.x,  uTexel.y ) ).rgb;
  vec3 rgbSW = texture2D( tDiffuse, vUv + vec2( -uTexel.x, -uTexel.y ) ).rgb;
  vec3 rgbSE = texture2D( tDiffuse, vUv + vec2(  uTexel.x, -uTexel.y ) ).rgb;

  float lM = scLuma( rgbM ), lNW = scLuma( rgbNW ), lNE = scLuma( rgbNE );
  float lSW = scLuma( rgbSW ), lSE = scLuma( rgbSE );
  float lMin = min( lM, min( min( lNW, lNE ), min( lSW, lSE ) ) );
  float lMax = max( lM, max( max( lNW, lNE ), max( lSW, lSE ) ) );

  if ( lMax - lMin < max( 0.035, lMax * 0.16 ) ) { gl_FragColor = vec4( rgbM, 1.0 ); return; }

  vec2 dir = vec2( -( ( lNW + lNE ) - ( lSW + lSE ) ), ( ( lNW + lSW ) - ( lNE + lSE ) ) );
  float reduce = max( ( lNW + lNE + lSW + lSE ) * 0.03125, 0.0078125 );
  float rcp = 1.0 / ( min( abs( dir.x ), abs( dir.y ) ) + reduce );
  dir = clamp( dir * rcp, -8.0, 8.0 ) * uTexel;

  vec3 a = 0.5 * ( texture2D( tDiffuse, vUv + dir * ( 1.0 / 3.0 - 0.5 ) ).rgb
                 + texture2D( tDiffuse, vUv + dir * ( 2.0 / 3.0 - 0.5 ) ).rgb );
  vec3 b = a * 0.5 + 0.25 * ( texture2D( tDiffuse, vUv - dir * 0.5 ).rgb
                            + texture2D( tDiffuse, vUv + dir * 0.5 ).rgb );
  float lB = scLuma( b );
  gl_FragColor = vec4( ( lB < lMin || lB > lMax ) ? a : b, 1.0 );
}
`;

/* ============================================================================================
 * Small custom passes
 * ========================================================================================== */

/** TAA. Owns its own history ping-pong; blits the resolve into the composer's write buffer. */
class TAAPass extends Pass {
  constructor(owner) {
    super();
    this.owner = owner;
    this.needsSwap = true;
    this.material = new THREE.ShaderMaterial({
      name: 'sc-taa',
      uniforms: {
        tCurrent: { value: null }, tHistory: { value: null }, tDepth: { value: null },
        uProjInv: { value: new THREE.Matrix4() },
        uViewInv: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uJitter: { value: new THREE.Vector2() },
        uParams: { value: new THREE.Vector4(0.72, 0.92, 1.25, 0.0) },
        uReset: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG_TAA,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this.copyMaterial = new THREE.ShaderMaterial({
      name: 'sc-taa-copy',
      uniforms: { tDiffuse: { value: null } },
      vertexShader: VERT,
      fragmentShader: COMMON + 'uniform sampler2D tDiffuse;\nvoid main(){ gl_FragColor = vec4( texture2D( tDiffuse, vUv ).rgb, 1.0 ); }',
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this._quad = new FullScreenQuad(this.material);
    this._copyQuad = new FullScreenQuad(this.copyMaterial);
    this.history = [null, null];
    this._i = 0;
  }

  setHistory(a, b) { this.history[0] = a; this.history[1] = b; }

  render(renderer, writeBuffer, readBuffer) {
    const src = this.history[this._i];
    const dst = this.history[1 - this._i];
    if (!src || !dst) return;

    const u = this.material.uniforms;
    u.tCurrent.value = readBuffer.texture;
    u.tHistory.value = src.texture;

    renderer.setRenderTarget(dst);
    this._quad.render(renderer);

    this.copyMaterial.uniforms.tDiffuse.value = dst.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this._copyQuad.render(renderer);

    this._i = 1 - this._i;
    u.uReset.value = 0;
  }

  reset() { this.material.uniforms.uReset.value = 1; }

  dispose() {
    this._quad.dispose(); this._copyQuad.dispose();
    this.material.dispose(); this.copyMaterial.dispose();
  }
}

/**
 * Bloom. needsSwap = false: it does not touch the composer buffers at all, it reads the read
 * buffer and leaves its result in `this.texture` for the composite pass.
 */
class BloomPass extends Pass {
  constructor(owner) {
    super();
    this.owner = owner;
    this.needsSwap = false;
    this.mips = [];

    const mk = (name, frag, uniforms, blending) => new THREE.ShaderMaterial({
      name, uniforms, vertexShader: VERT, fragmentShader: frag,
      depthTest: false, depthWrite: false,
      blending: blending ?? THREE.NoBlending,
      transparent: blending === THREE.AdditiveBlending,
    });

    this.preMaterial = mk('sc-bloom-pre', FRAG_BLOOM_PRE, {
      tDiffuse: { value: null },
      tAdapt: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uParams: { value: new THREE.Vector4(BLOOM_THRESHOLD, BLOOM_KNEE, 1.0, 0.10) },
      uExposure: { value: new THREE.Vector4(EXPOSURE_BASE * EXPOSURE_CALIBRATION, EXPOSURE_KEY, EXPOSURE_GAIN_MIN, EXPOSURE_GAIN_MAX) },
    });
    this.downMaterial = mk('sc-bloom-down', FRAG_BLOOM_DOWN, {
      tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() },
    });
    this.upMaterial = mk('sc-bloom-up', FRAG_BLOOM_UP, {
      tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() },
      uTint: { value: new THREE.Vector3(1, 1, 1) }, uWeight: { value: 1 },
    }, THREE.AdditiveBlending);

    this._quad = new FullScreenQuad(this.preMaterial);
    this.texture = null;
    // §12.2 per-mip weights.
    this.weights = [0.28, 0.22, 0.17, 0.13, 0.10, 0.06, 0.04];
    this.warm = new THREE.Vector3(1.08, 1.0, 0.92);
  }

  setMips(mips) { this.mips = mips; this.texture = mips.length ? mips[0].texture : null; }

  render(renderer, writeBuffer, readBuffer) {
    const mips = this.mips;
    if (!mips.length) return;

    // prefilter -> mip0
    this.preMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.preMaterial.uniforms.uTexel.value.set(1 / readBuffer.width, 1 / readBuffer.height);
    this._quad.material = this.preMaterial;
    renderer.setRenderTarget(mips[0]);
    this._quad.render(renderer);

    // downsample chain
    this._quad.material = this.downMaterial;
    for (let i = 1; i < mips.length; i++) {
      this.downMaterial.uniforms.tDiffuse.value = mips[i - 1].texture;
      this.downMaterial.uniforms.uTexel.value.set(1 / mips[i - 1].width, 1 / mips[i - 1].height);
      renderer.setRenderTarget(mips[i]);
      this._quad.render(renderer);
    }

    // progressive tent upsample, additive, warm-tinted on the widest mips
    this._quad.material = this.upMaterial;
    for (let i = mips.length - 1; i > 0; i--) {
      this.upMaterial.uniforms.tDiffuse.value = mips[i].texture;
      this.upMaterial.uniforms.uTexel.value.set(1 / mips[i].width, 1 / mips[i].height);
      this.upMaterial.uniforms.uWeight.value = this.weights[Math.min(i, this.weights.length - 1)] * 3.2;
      const t = this.upMaterial.uniforms.uTint.value;
      if (i >= mips.length - 2) t.copy(this.warm); else t.set(1, 1, 1);
      renderer.setRenderTarget(mips[i - 1]);
      this._quad.render(renderer);
    }

    this.texture = mips[0].texture;
  }

  dispose() {
    this._quad.dispose();
    this.preMaterial.dispose(); this.downMaterial.dispose(); this.upMaterial.dispose();
  }
}

/* ============================================================================================
 * Postprocessing
 * ========================================================================================== */

export class Postprocessing {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx?.bus ?? null;

    /** @type {THREE.DepthTexture|null} — public. VolumetricFog reads this. */
    this.depthTexture = null;
    /** @type {THREE.Texture|null} — public. VIEW-SPACE normals, xyz encoded *0.5+0.5. */
    this.normalTexture = null;
    /** Attachment 1 of the MRT. Reserved for a real normal+roughness+velocity gbuffer. */
    this.gbufferTexture = null;
    /** Set true by Materials.js once SC_MRT_OUT actually writes attachment 1. */
    this.gbufferIsAuthored = false;
    /** Coordinate space of `normalTexture`. */
    this.normalSpace = 'view';

    this.composer = null;
    this.sceneTarget = null;
    this.enabled = true;
    this._fallback = false;
    this._ready = false;

    this._w = 1; this._h = 1; this._dpr = 1;
    this._pw = 1; this._ph = 1;
    /**
     * Internal render scale. The scene AND every post target are sized at
     * canvasBackingPixels * this, and the composite upsamples on its way to the default
     * framebuffer, so it scales the WHOLE frame — scene raster included — not just post.
     *
     * 1.0 on ultra: the ultra look is not traded for frame rate (ART_DIRECTION is binding on it).
     * The ladder below ultra is where the trade lives, which is the order of preference the
     * performance brief asks for. Shadow map cost does not move with it — those are fixed-size
     * depth targets owned by the lighting rig, not by this file.
     */
    this._renderScale = 1;

    this._frame = 0;
    this._time = 0;
    this._dt = 1 / 60;

    // exposure state (ART_DIRECTION §3.1.2)
    this._exposureBase = EXPOSURE_BASE;
    this._exposureTarget = EXPOSURE_BASE;
    this._exposureRate = 1 / 0.55;
    this._lightningExp = 1;
    /** §3.1.1 row multiplier for the meter target. Derived from `state.night` + `weather:change`. */
    this._weatherScale = METER_TARGET_SCALE.clear;
    this._lastFog = 0;
    this._panic = 0;
    this._panicTarget = 0;
    this._sprint = 0;

    this._prevViewProj = new THREE.Matrix4();
    this._unjitteredProj = new THREE.Matrix4();
    this._savedProj = new THREE.Matrix4();
    this._projInv = new THREE.Matrix4();        // inverse of the JITTERED projection
    this._projJittered = new THREE.Matrix4();
    this._jitter = new THREE.Vector2();
    this._prevValid = false;

    this._targets = [];
    this._quads = [];
    this._materials = [];
    this._unsubs = [];

    this.stats = {
      exposure: EXPOSURE_BASE * EXPOSURE_CALIBRATION, meterTarget: EXPOSURE_KEY,
      panic: 0, taa: false, tier: 3, passes: 0,
    };
  }

  // ------------------------------------------------------------------ public API

  /** 0..1 — desaturation, pulsing vignette, slight lens warp. Campers.js / HUD.js call this. */
  setPanic(v) {
    this._panicTarget = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  }

  /**
   * Internal render scale, 0.5..1. Applies to the scene draw and every post target; the composite
   * upsamples to the canvas. Call with no argument to return to the tier default.
   */
  setRenderScale(v) {
    const next = Number.isFinite(v) ? Math.max(0.5, Math.min(1, v)) : this._tierRenderScale();
    if (Math.abs(next - this._renderScale) < 1e-3) return;
    this._renderScale = next;
    if (this._ready && !this._fallback) this._resizeTo(this._scaledWidth(), this._scaledHeight());
  }

  /** 0..1 — tightens the vignette while sprinting (the only other dynamic vignette, §12.7). */
  setSprint(v) {
    this._sprint = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  }

  /**
   * Scripted exposure ramp (§3.1.2). `attack` in seconds.
   *
   * Ceiling is 1.0, not 2.0. The brightest scripted value in the whole bible is the dawn ramp at
   * 0.95; anything above 1.0 is a caller mistake and would put the frame a stop and a half over
   * the §3.1 target, which is how a horror game accidentally ships as an overcast afternoon.
   */
  setExposure(target, attack = 0.4) {
    if (!Number.isFinite(target)) return;
    this._exposureTarget = Math.max(0.05, Math.min(1.0, target));
    this._exposureRate = 1 / Math.max(0.02, attack);
  }

  /** Renderer-space exposure: the bible's scripted value times EXPOSURE_CALIBRATION. */
  get exposure() { return this._scriptedExposure(); }
  get usingTAA() { return !!(this._taaPass && this._taaPass.enabled); }

  // ------------------------------------------------------------------ lifecycle

  async init() {
    const ctx = this.ctx;
    const renderer = ctx?.renderer;
    if (!renderer) { this._fallback = true; Log.warn('Postprocessing: no renderer — disabled.'); return; }

    // AgX is applied exactly once, in our composite shader. Engine sets AgX on the renderer by
    // default; if we left it there the frame would be tone mapped twice and go milk-grey.
    this._prevToneMapping = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1.0;

    const gl = renderer.getContext?.();
    this._isWebGL2 = !!(renderer.capabilities?.isWebGL2 ?? (gl && typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext));
    this._floatLinear = true;
    try {
      if (!renderer.extensions?.has?.('EXT_color_buffer_float') && !this._isWebGL2) this._floatLinear = false;
    } catch { /* older builds — assume ok */ }

    this._settings = ctx.settings ?? null;
    this._tier = this._settings?.tierIndex ?? 3;

    this._noise = this._resolveNoiseTexture();
    this._makeFallbackTextures();

    // The drawing buffer is the authority — ctx.width/height can still be 1x1 during boot if the
    // mount had no layout when Engine constructed itself.
    const buf = renderer.getDrawingBufferSize(_v2a);
    this._dpr = ctx.dpr || renderer.getPixelRatio() || 1;
    this._w = Math.max(1, Math.round((buf.width || (ctx.width * this._dpr) || 1) / this._dpr));
    this._h = Math.max(1, Math.round((buf.height || (ctx.height * this._dpr) || 1) / this._dpr));

    try {
      this._buildTargets();
      this._buildQuads();
      this._buildComposer();
      this._bindEvents();
      this._applyTier();
      this._ready = true;
    } catch (e) {
      this._fallback = true;
      Log.error('Postprocessing: build failed — falling back to a direct render.', e);
      if (renderer) renderer.toneMapping = THREE.AgXToneMapping;
      return;
    }

    Log.debug(`Postprocessing ready: ${this._pw}x${this._ph}, tier ${this._tier}, TAA ${this.usingTAA}`);
  }

  update(dt, elapsed) {
    this._dt = Math.min(0.1, Math.max(1e-4, dt || 1 / 60));
    this._time = elapsed ?? (this._time + this._dt);
    if (this._fallback) return;

    const s = this._settings;
    const state = this.ctx?.state;

    // --- panic + sprint easing
    const pk = 1 - Math.exp(-this._dt / (this._panicTarget > this._panic ? 0.16 : 0.55));
    this._panic += (this._panicTarget - this._panic) * pk;

    // --- scripted exposure ramp toward target
    const ek = 1 - Math.exp(-this._dt * this._exposureRate);
    this._exposureBase += (this._exposureTarget - this._exposureBase) * ek;

    // --- dawn ramp (§3.1.2): 0.62 -> 0.95 across timeOfNight 0.85..1.0
    const ton = state?.timeOfNight;
    if (Number.isFinite(ton) && ton > 0.85 && this._exposureTarget === EXPOSURE_BASE) {
      const t = Math.min(1, (ton - 0.85) / 0.15);
      this._exposureBase = EXPOSURE_BASE + (0.95 - EXPOSURE_BASE) * t;
    }

    // --- lightning: fast stop-down, slow recovery. Reads Materials.globalUniforms.uLightning.
    const gu = this._globalUniforms();
    const flash = Math.max(0, Math.min(1, gu?.uLightning?.value ?? 0));
    const target = 1 - 0.52 * flash;                    // 0.62 -> ~0.30 at full flash
    const rate = target < this._lightningExp ? (1 / 0.06) : (1 / 1.4);
    this._lightningExp += (target - this._lightningExp) * (1 - Math.exp(-this._dt * rate));
    this._flash = flash;

    this._refreshWeatherScale(NaN);

    if (s) {
      const t = s.tierIndex ?? 3;
      if (t !== this._tier) { this._tier = t; this._applyTier(); }
    }

    this.stats.exposure = this._scriptedExposure();
    this.stats.meterTarget = this._meterTarget();
    this.stats.panic = this._panic;
    this.stats.taa = this.usingTAA;
    this.stats.tier = this._tier;
  }

  /**
   * Engine calls this instead of renderer.render(). We own the frame from here.
   *
   * `skipScene` is for bench() only: the scene draw is identical under every post configuration,
   * so leaving it out makes a pass-by-pass sweep 4x faster AND removes the scene's frame-to-frame
   * variance — which is larger than most of the deltas being measured — from the numbers.
   */
  render(skipScene = false) {
    const ctx = this.ctx;
    const renderer = ctx?.renderer;
    const scene = ctx?.scene;
    const camera = ctx?.camera;
    if (!renderer || !scene || !camera) return;

    if (this._fallback || !this._ready || !this.enabled || !this.composer) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }

    // Size may have changed without a resize() call (harness captureFrame).
    const scale = this._renderScale;
    const dw = Math.max(1, Math.round((renderer.domElement?.width ?? this._pw) * scale));
    const dh = Math.max(1, Math.round((renderer.domElement?.height ?? this._ph) * scale));
    if (dw !== this._pw || dh !== this._ph) this._resizeTo(dw, dh);

    const prevAutoClear = renderer.autoClear;
    const prevTarget = renderer.getRenderTarget();

    try {
      this._frame++;
      if (!skipScene) this._renderScene(renderer, scene, camera);
      this._renderGeometryBuffers(renderer, camera);
      this._renderExposure(renderer);
      this._updateChainUniforms(camera);

      renderer.autoClear = false;
      this.composer.render(this._dt);
    } catch (e) {
      Log.once('post:render', 'Postprocessing.render() threw — reverting to a direct render.', e);
      this._fallback = true;
      renderer.toneMapping = THREE.AgXToneMapping;
      renderer.toneMappingExposure = this._scriptedExposure();
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget ?? null);
    }

    // Remember this frame's un-jittered view-projection for next frame's reprojection.
    this._prevViewProj.multiplyMatrices(this._unjitteredProj, camera.matrixWorldInverse);
    this._prevValid = true;
  }

  resize(w, h) {
    this._w = Math.max(1, w || 1);
    this._h = Math.max(1, h || 1);
    this._dpr = this.ctx?.dpr || 1;
    if (this._fallback || !this._ready) return;
    this._resizeTo(this._scaledWidth(), this._scaledHeight());
  }

  dispose() {
    for (const u of this._unsubs) { try { u?.(); } catch { /* ignore */ } }
    this._unsubs.length = 0;

    for (const t of this._targets) { try { t?.dispose?.(); } catch { /* ignore */ } }
    this._targets.length = 0;

    for (const q of this._quads) { try { q?.dispose?.(); } catch { /* ignore */ } }
    this._quads.length = 0;

    for (const m of this._materials) { try { m?.dispose?.(); } catch { /* ignore */ } }
    this._materials.length = 0;

    try { this._depthTex?.dispose?.(); } catch { /* ignore */ }
    try { this._whiteTex?.dispose?.(); } catch { /* ignore */ }
    try { this._blackTex?.dispose?.(); } catch { /* ignore */ }
    try { this._fogFallback?.dispose?.(); } catch { /* ignore */ }
    try { if (this._ownsNoise) this._noise?.dispose?.(); } catch { /* ignore */ }

    if (this.composer) {
      for (const p of this.composer.passes) { try { p.dispose?.(); } catch { /* ignore */ } }
      try { this.composer.dispose(); } catch { /* ignore */ }
      this.composer = null;
    }

    if (this.ctx?.renderer && this._prevToneMapping !== undefined) {
      this.ctx.renderer.toneMapping = this._prevToneMapping;
    }

    this.depthTexture = null;
    this.normalTexture = null;
    this.gbufferTexture = null;
    this.sceneTarget = null;
    this._ready = false;
  }

  // ------------------------------------------------------------------ internals: setup

  /** §13 wants low/medium still playable; this is the lever that gets them there. */
  _tierRenderScale() {
    const s = this._settings;
    return s?.tier ? s.tier(0.60, 0.75, 0.90, 1.0) : 1.0;
  }

  _scaledWidth() { return Math.max(1, Math.round(this._w * this._dpr * this._renderScale)); }
  _scaledHeight() { return Math.max(1, Math.round(this._h * this._dpr * this._renderScale)); }

  _globalUniforms() {
    const m = this.ctx?.systems?.get?.('Materials');
    return m?.globalUniforms ?? null;
  }

  _resolveNoiseTexture() {
    const tex = this.ctx?.systems?.get?.('Textures');
    try {
      const bn = tex?.blueNoise;
      if (bn && bn.isTexture) {
        bn.wrapS = THREE.RepeatWrapping;
        bn.wrapT = THREE.RepeatWrapping;
        this._ownsNoise = false;
        this._noiseSize = bn.image?.width ?? 128;
        return bn;
      }
    } catch { /* Textures may not be ready */ }

    // Deterministic fallback so the grain and the dither always have a source.
    const N = 64;
    const rand = new Rand((this.ctx?.settings?.get?.('seed') ?? 0x51A5CAB) ^ 0x9E3779B9);
    const data = new Uint8Array(N * N * 4);
    for (let i = 0; i < N * N; i++) {
      data[i * 4 + 0] = (rand.next() * 255) | 0;
      data[i * 4 + 1] = (rand.next() * 255) | 0;
      data[i * 4 + 2] = (rand.next() * 255) | 0;
      data[i * 4 + 3] = (rand.next() * 255) | 0;
    }
    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    t.name = 'sc-post-noise-fallback';
    this._ownsNoise = true;
    this._noiseSize = N;
    return t;
  }

  _makeFallbackTextures() {
    const mk = (r, g, b, a, name) => {
      const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1, THREE.RGBAFormat);
      t.needsUpdate = true; t.name = name;
      t.magFilter = t.minFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      return t;
    };
    this._whiteTex = mk(255, 255, 255, 255, 'sc-post-white');   // AO = 1
    this._blackTex = mk(0, 0, 0, 0, 'sc-post-black');           // SSR = nothing
    this._fogFallback = mk(0, 0, 0, 255, 'sc-post-nofog');      // no inscatter, full transmittance
  }

  _mkTarget(w, h, opts = {}) {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      type: opts.type ?? THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: opts.filter ?? THREE.LinearFilter,
      magFilter: opts.filter ?? THREE.LinearFilter,
      depthBuffer: !!opts.depthBuffer,
      stencilBuffer: false,
      generateMipmaps: false,
      count: opts.count ?? 1,
      colorSpace: THREE.LinearSRGBColorSpace,
      ...(opts.depthTexture ? { depthTexture: opts.depthTexture } : {}),
    });
    rt.texture.name = opts.name ?? 'sc-post-rt';
    if (rt.textures) for (let i = 0; i < rt.textures.length; i++) rt.textures[i].name = `${rt.texture.name}-${i}`;
    this._targets.push(rt);
    return rt;
  }

  _buildTargets() {
    const pw = this._pw = this._scaledWidth();
    const ph = this._ph = this._scaledHeight();
    const hw = Math.max(1, pw >> 1);
    const hh = Math.max(1, ph >> 1);

    // --- depth texture. FloatType -> DEPTH_COMPONENT32F on WebGL2: enough precision that the
    // normal reconstruction does not stair-step at 60 m.
    this._depthTex = new THREE.DepthTexture(pw, ph, THREE.FloatType);
    this._depthTex.format = THREE.DepthFormat;
    this._depthTex.minFilter = THREE.NearestFilter;
    this._depthTex.magFilter = THREE.NearestFilter;
    this._depthTex.generateMipmaps = false;
    this._depthTex.name = 'sc-depth';

    // --- the scene MRT. Attachment 0 is the HDR frame; attachment 1 is the gbuffer slot for
    // packed normal+roughness+velocity that Materials.js will fill once SC_MRT_OUT lands
    // (ART_DIRECTION §11.4 F5).
    //
    // IMPORTANT, measured in Chrome: binding two draw buffers while the scene materials only
    // declare output 0 is a hard `GL_INVALID_OPERATION: Active draw buffers with missing
    // fragment shader outputs` on EVERY draw call. So attachment 1 stays unbound until someone
    // actually authors it. Flip `Postprocessing.MRT_GBUFFER = true` (before construction) the
    // same commit SC_MRT_OUT lands, and the second attachment appears with no other change.
    // Until then normals come from the depth-reconstruction pass below, which is exact enough
    // for AO/SSR/fog and costs one full-screen pass.
    const useMRT = this._isWebGL2 && (Postprocessing.MRT_GBUFFER || this.gbufferIsAuthored);
    this.sceneTarget = this._mkTarget(pw, ph, {
      depthBuffer: true, depthTexture: this._depthTex,
      count: useMRT ? 2 : 1, name: 'sc-hdr',
    });
    this.depthTexture = this._depthTex;
    this.gbufferTexture = (this.sceneTarget.textures && this.sceneTarget.textures.length > 1)
      ? this.sceneTarget.textures[1] : null;

    // --- geometry buffers
    // HALF RES, and measured: this pass cost 1.17 ms of a 7.6 ms post stack at 2560x1440 while
    // every consumer of it already samples at half res or lower — GTAO and SSR run at hw x hh, and
    // VolumetricFog marches an 800x450 buffer. A full-res normal buffer was reconstructing detail
    // that nothing downstream could read, at 3.7 M pixels and 14.7 MB of RGBA8 bandwidth a frame.
    // Sampling is by UV, so this is invisible to anyone holding `post.normalTexture`.
    this._normalRT = this._mkTarget(hw, hh, { type: THREE.UnsignedByteType, name: 'sc-normal' });
    this.normalTexture = this._normalRT.texture;

    this._aoRT = this._mkTarget(hw, hh, { type: THREE.HalfFloatType, name: 'sc-ao' });
    this._aoRT2 = this._mkTarget(hw, hh, { type: THREE.HalfFloatType, name: 'sc-ao-b' });
    this._ssrRT = this._mkTarget(hw, hh, { type: THREE.HalfFloatType, name: 'sc-ssr' });
    this._sscsRT = this._mkTarget(hw, hh, { type: THREE.UnsignedByteType, name: 'sc-sscs' });

    // --- luminance chain + 1x1 adaptation ping-pong
    this._lum0 = this._mkTarget(64, 64, { type: THREE.HalfFloatType, name: 'sc-lum0' });
    this._lum1 = this._mkTarget(8, 8, { type: THREE.HalfFloatType, name: 'sc-lum1' });
    this._adapt = [
      this._mkTarget(1, 1, { type: THREE.HalfFloatType, filter: THREE.NearestFilter, name: 'sc-adapt0' }),
      this._mkTarget(1, 1, { type: THREE.HalfFloatType, filter: THREE.NearestFilter, name: 'sc-adapt1' }),
    ];
    this._adaptIndex = 0;

    // --- TAA history
    this._history = [
      this._mkTarget(pw, ph, { name: 'sc-taa-h0' }),
      this._mkTarget(pw, ph, { name: 'sc-taa-h1' }),
    ];

    // --- bloom mips, starting at half res
    const maxMips = this._settings?.tier ? this._settings.tier(3, 5, 6, 7) : 6;
    this._bloomMips = [];
    let bw = hw, bh = hh;
    for (let i = 0; i < maxMips; i++) {
      if (bw < 4 || bh < 4) break;
      this._bloomMips.push(this._mkTarget(bw, bh, { name: `sc-bloom-${i}` }));
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
    }
  }

  _mkMaterial(name, frag, uniforms, defines) {
    // Note: an explicit `defines: undefined` makes ShaderMaterial warn, so only pass the key
    // when there is something in it.
    const params = {
      name, uniforms, vertexShader: VERT, fragmentShader: frag,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    };
    if (defines) params.defines = { ...defines };
    const mat = new THREE.ShaderMaterial(params);
    this._materials.push(mat);
    return mat;
  }

  _mkQuad(name, frag, uniforms, defines) {
    const mat = this._mkMaterial(name, frag, uniforms, defines);
    const q = new FullScreenQuad(mat);
    this._quads.push(q);
    return { quad: q, mat, u: mat.uniforms };
  }

  /**
   * A ShaderPass built from a pre-made ShaderMaterial. Passing a plain shader object instead
   * makes ShaderPass call UniformsUtils.clone(), which warns loudly on every render-target
   * texture we hand it — and we hand it several.
   */
  _mkPass(name, frag, uniforms, defines) {
    return new ShaderPass(this._mkMaterial(name, frag, uniforms, defines));
  }

  _buildQuads() {
    const tierIdx = this._settings?.tierIndex ?? 3;

    this._normalQuad = this._mkQuad('sc-normal', FRAG_NORMAL, {
      tDepth: { value: this._depthTex },
      uProjInv: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() },
    });

    this._aoQuad = this._mkQuad('sc-ao', FRAG_AO, {
      tDepth: { value: this._depthTex },
      tNormal: { value: this._normalRT.texture },
      tNoise: { value: this._noise },
      uProjInv: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() },
      uNoiseScale: { value: new THREE.Vector2() },
      uParams: { value: new THREE.Vector4(0.75, 1.4, 1.15, 0.14) },
      uNearFar: { value: new THREE.Vector2(0.05, 1200) },
      uFrame: { value: 0 },
    }, {
      AO_DIRS: tierIdx >= 3 ? 12 : (tierIdx >= 2 ? 8 : 4),
      AO_STEPS: tierIdx >= 3 ? 4 : 3,
    });

    this._aoBlurQuad = this._mkQuad('sc-ao-blur', FRAG_AO_BLUR, {
      tAO: { value: null },
      tNormal: { value: this._normalRT.texture },
      uTexel: { value: new THREE.Vector2() },
      uDir: { value: new THREE.Vector2(1, 0) },
      uSigma: { value: new THREE.Vector2(0.35, 8.0) },
    });

    // SSCS (§12 pass 5). Half res, UnsignedByte: it is a scalar visibility term and the extra
    // precision of a half-float buys nothing a 4-tap cross in the resolve does not smooth away.
    this._sscsQuad = this._mkQuad('sc-sscs', FRAG_SSCS, {
      tDepth: { value: this._depthTex },
      tNormal: { value: this._normalRT.texture },
      tNoise: { value: this._noise },
      uProj: { value: new THREE.Matrix4() },
      uProjInv: { value: new THREE.Matrix4() },
      uNoiseScale: { value: new THREE.Vector2() },
      uNearFar: { value: new THREE.Vector2(0.05, 1200) },
      uMoon: { value: new THREE.Vector4(0, 1, 0, 0) },
      uLamp: { value: new THREE.Vector4(0, 0, 0, 0) },
      // §3.5: 8 ray steps, 0.35 m max trace, 0.02 m thickness. Steps come from the define below.
      uParams: { value: new THREE.Vector4(0.35, 0.06, 0, 30) },
    }, { SSCS_STEPS: tierIdx >= 3 ? 12 : 8 });

    this._ssrQuad = this._mkQuad('sc-ssr', FRAG_SSR, {
      tScene: { value: this.sceneTarget.texture },
      tDepth: { value: this._depthTex },
      tNormal: { value: this._normalRT.texture },
      tNoise: { value: this._noise },
      uProj: { value: new THREE.Matrix4() },
      uProjInv: { value: new THREE.Matrix4() },
      uViewInv: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() },
      uNoiseScale: { value: new THREE.Vector2() },
      uNearFar: { value: new THREE.Vector2(0.05, 1200) },
      uParams: { value: new THREE.Vector4(0.35, 0.55, 24, 0) },
      uStrength: { value: 0.55 },
    }, { SSR_STEPS: tierIdx >= 3 ? 32 : 16 });

    this._lumQuad = this._mkQuad('sc-lum', FRAG_LUM, {
      tDiffuse: { value: this.sceneTarget.texture },
      // One output texel of the 64x64 target covers 1/64 of the frame on each axis. Constant, and
      // deliberately NOT derived from the scene resolution -- that is the whole fix.
      uCell: { value: new THREE.Vector2(1 / 64, 1 / 64) },
      uExposureIn: { value: EXPOSURE_BASE * EXPOSURE_CALIBRATION },
    });

    // Separate REDUCTION quad. The transform and the reduction must not be the same shader — see
    // the exposure block at the top of this file for what happens when they are.
    this._meanQuad = this._mkQuad('sc-lum-mean', FRAG_MEAN, {
      tDiffuse: { value: this._lum0.texture },
      uTexel: { value: new THREE.Vector2(1 / 64, 1 / 64) },
      uSpan: { value: 8 },
    });

    this._adaptQuad = this._mkQuad('sc-adapt', FRAG_ADAPT, {
      tLum: { value: this._lum1.texture },
      tPrev: { value: this._adapt[0].texture },
      tDepth: { value: this._depthTex },
      uNearFar: { value: new THREE.Vector2(0.05, 1200) },
      uParams: { value: new THREE.Vector4(1 / 60, 1.5, 0.22, 1) },
    });
  }

  _buildComposer() {
    const renderer = this.ctx.renderer;
    const chainTarget = this._mkTarget(this._pw, this._ph, { name: 'sc-chain' });
    const composer = new EffectComposer(renderer, chainTarget);
    // The composer's targets are already in physical pixels; do not let it re-apply the DPR.
    composer.setPixelRatio(1);
    composer.setSize(this._pw, this._ph);
    this.composer = composer;
    // renderTarget2 is created internally by clone() and is not in our _targets list.
    this._targets.push(composer.renderTarget2);

    const tierIdx = this._settings?.tierIndex ?? 3;

    // --- 5. resolve. Reads the MRT directly, so it deliberately has no `tDiffuse` uniform and
    // ShaderPass leaves the composer's read buffer alone.
    this._resolvePass = this._mkPass('sc-resolve', FRAG_RESOLVE, {
      tScene: { value: this.sceneTarget.texture },
      tAO: { value: this._whiteTex },
      tSSR: { value: this._blackTex },
      tFog: { value: this._fogFallback },
      tSSCS: { value: this._whiteTex },
      uTexel: { value: new THREE.Vector2() },
      uParams: { value: new THREE.Vector4(0.85, 0.55, 6.0, 0) },
    });
    composer.addPass(this._resolvePass);

    // --- 6. TAA
    this._taaPass = new TAAPass(this);
    this._taaPass.setHistory(this._history[0], this._history[1]);
    composer.addPass(this._taaPass);

    // --- 7. motion blur
    this._motionPass = this._mkPass('sc-motion', FRAG_MOTION, {
      tDiffuse: { value: null },
      tDepth: { value: this._depthTex },
      tNoise: { value: this._noise },
      uProjInv: { value: new THREE.Matrix4() },
      uViewInv: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uNoiseScale: { value: new THREE.Vector2() },
      uJitter: { value: new THREE.Vector2() },
      uTexel: { value: new THREE.Vector2() },
      uParams: { value: new THREE.Vector4(0.5, 0.03, 0, 0) },
    }, { MB_TAPS: tierIdx >= 3 ? 12 : 8 });
    composer.addPass(this._motionPass);

    // --- 8. depth of field
    this._dofPass = this._mkPass('sc-dof', FRAG_DOF, {
      tDiffuse: { value: null },
      tDepth: { value: this._depthTex },
      tAdapt: { value: this._adapt[0].texture },
      uTexel: { value: new THREE.Vector2() },
      uNearFar: { value: new THREE.Vector2(0.05, 1200) },
      uParams: { value: new THREE.Vector4(9.0, 0.30, 0.0, 0.0) },
    }, { DOF_TAPS: tierIdx >= 3 ? 12 : 8 });
    composer.addPass(this._dofPass);

    // --- 9. bloom (needsSwap false — leaves its result in a texture)
    this._bloomPass = new BloomPass(this);
    this._bloomPass.setMips(this._bloomMips);
    composer.addPass(this._bloomPass);

    // --- 10. composite
    this._compositePass = this._mkPass('sc-composite', FRAG_COMPOSITE, {
      tDiffuse: { value: null },
      tBloom: { value: this._bloomMips.length ? this._bloomMips[0].texture : this._blackTex },
      tAdapt: { value: this._adapt[0].texture },
      tNoise: { value: this._noise },
      uResolution: { value: new THREE.Vector2(1920, 1080) },
      uNoiseSize: { value: new THREE.Vector2(this._noiseSize, this._noiseSize) },
      uExposure: { value: new THREE.Vector4(EXPOSURE_BASE * EXPOSURE_CALIBRATION, EXPOSURE_KEY, EXPOSURE_GAIN_MIN, EXPOSURE_GAIN_MAX) },
      // Bloom carries the warm human light, which in both key-art references is the only thing in
      // frame with a halo. 0.055 was too quiet to read as a lantern in rain.
      uBloom: { value: new THREE.Vector4(BLOOM_INTENSITY, 0.10, 0.08, 0) },
      // THE SHADOW TINT — a MULTIPLIER, not §12.4's additive lift. rgb is the tint reached at
      // luma 0, .w is the luma at which it has faded out entirely. It buys the same blue-green
      // dark the lift was written for and it cannot plant a floor, because it multiplies.
      uGradeLift: { value: new THREE.Vector4(GRADE_SHADOW_TINT[0], GRADE_SHADOW_TINT[1], GRADE_SHADOW_TINT[2], 0.055) },
      // Black point (subtracted, per channel) and the midtone-restore gain. See THE BLACK POINT in
      // FRAG_COMPOSITE for the derivation — it is solved so the 50th percentile does not move.
      uBlack: { value: new THREE.Vector4(BLACK_POINT[0], BLACK_POINT[1], BLACK_POINT[2], BLACK_RESTORE) },
      // Toe crush at 0 and toe knee. No additive term: this toe reaches zero.
      //
      // 0.55 -> 0.82, measured. With the black point below now doing the crushing (and doing it
      // with a soft knee), a 0.55 multiply at the bottom is a SECOND crush stacked on the first,
      // and two of them is what buried the lower quartile. Swept live on ?shot=site-close at
      // 1600x900, black point held at 0.0025/2.70, 4-frame averages:
      //
      //     toe/knee      %below disp 0.02   P25        P99.9     frac > 0.8
      //     0.55 / 0.016  30.55              0.00078    0.4487    0.000654
      //     0.75 / 0.016  29.51              0.00094    0.4793    0.000659
      //     0.90 / 0.010  28.28              0.00115    0.5330    0.000764
      //     1.00 / 0.001  28.09              0.00119    0.5243    0.000742
      //
      // Monotone in the right direction on every column at once, and the floor target (>= 10%
      // below 0.02) is not remotely at risk at any row -- the frame is 28% black on scene content,
      // not on grade. 0.82/0.013 keeps a real toe for the §12.4 contract without the second crush.
      uToe: { value: new THREE.Vector4(0.82, 0.013, 0, 0) },
      uGradeGamma: { value: new THREE.Vector4(0.985, 1.000, 1.030, 0) },
      uGradeGain: { value: new THREE.Vector4(0.985, 1.000, 1.040, 0) },
      // global sat 0.93: §12.4 says 0.86; an earlier pass took it to 1.00 defending the blue-green
      // thesis, which was right in direction and too far. Metered against keyart-site.png, 1.00
      // renders lantern-lit lumber as salmon where the reference is a warm brown, because the
      // pool is the most chromatic thing in frame and it is the one place we cannot afford it.
      // The blue-black is protected by uSat.w below, which is the op §12.4 actually cares about.
      uSat: { value: new THREE.Vector4(0.93, 0.70, 0.72, 1.55) },
      uVignette: { value: new THREE.Vector4(0.30, 0.42, 1.10, 1.0) },
      uGrain: { value: new THREE.Vector4(1.0, GRAIN_PX, 0.020, GRAIN_MID) },
      uLens: { value: new THREE.Vector4(0.0016, 0, 0, 0) },
      // Vignette residual transmission, NOT a paint colour. At full art vignette the corner keeps
      // 0% of its red, 12% of its green and 30% of its blue — the same darkening the old
      // mix-toward-#0a1216 produced for a lit pixel, and exactly zero for a black one.
      uVigTint: { value: new THREE.Vector3(0.00, 0.12, 0.30) },
      uSplitCool: { value: new THREE.Vector3(0.955, 1.000, 1.075) },
      // Warm half of the split-tone. Blue is cut harder than before (0.885 -> 0.800) because the
      // measurement says so: the reference's warm timber sits at B/R 0.341 and ours at 0.614, and
      // once the human-light axis stops COOLING the pool, this is the op that closes what is left.
      uSplitWarm: { value: new THREE.Vector3(1.020, 1.000, 0.930) },
      // Pivot power / pivot. 0.055 is §3.1's moonlit-mud exposure target — the value the whole
      // exposure model is anchored to — so the op is contrast and nothing else.
      uContrast: { value: new THREE.Vector4(1.14, 0.055, 0, 0) },
      // Warmth ramp lo/hi (in (r-b)/(r+b)), warm saturation, warm split weight.
      uWarm: { value: new THREE.Vector4(0.045, 0.400, 1.000, 1.0) },
      uTime: { value: 0 },
      uFrame: { value: 0 },
    });
    composer.addPass(this._compositePass);

    // --- 11. FXAA (only when TAA is off)
    this._fxaaPass = this._mkPass('sc-fxaa', FRAG_FXAA, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });
    composer.addPass(this._fxaaPass);

    this.stats.passes = composer.passes.length;
  }

  _bindEvents() {
    const bus = this.bus;
    if (!bus?.on) return;
    const add = (evt, fn) => { const off = bus.on(evt, fn); this._unsubs.push(typeof off === 'function' ? off : () => bus.off?.(evt, fn)); };

    add('ui:blueprint-open', () => this.setExposure(0.44, 0.18));
    add('ui:blueprint-close', () => this.setExposure(EXPOSURE_BASE, 0.55));
    add('player:spotted', () => this.setPanic(1));
    add('player:hidden', () => this.setPanic(0));
    add('night:begin', () => {
      this.setExposure(EXPOSURE_BASE, 0.6);
      this.setPanic(0);
      this._refreshWeatherScale(NaN);
      this._taaPass?.reset();
    });
    add('weather:change', (p) => {
      const fog = Number.isFinite(p?.fog) ? p.fog : 0;
      // Whiteout is a brighter, flatter night — and that is physically true (§3.1.1). It gets both
      // the scripted ramp AND a raised meter target, or the meter would simply undo it.
      this.setExposure(fog > 0.85 ? 0.70 : EXPOSURE_BASE, 4.0);
      this._refreshWeatherScale(fog);
    });
    add('engine:context-restored', () => { this._taaPass?.reset(); this._prevValid = false; });
  }

  _applyTier() {
    const t = this._tier;
    const s = this._settings;
    const taa = t >= 2;

    this.setRenderScale();          // tier default; ultra is 1.0, so ultra is bit-identical

    if (this._taaPass) { this._taaPass.enabled = taa; if (taa) this._taaPass.reset(); }
    if (this._fxaaPass) this._fxaaPass.enabled = !taa;
    if (this._motionPass) this._motionPass.enabled = t >= 1 && (s?.get?.('motionBlur') ?? true);
    if (this._dofPass) this._dofPass.enabled = t >= 1;
    if (this._bloomPass) this._bloomPass.enabled = t >= 1;

    this._aoEnabled = t >= 1;
    this._ssrEnabled = t >= 2;
    // §12's pass table: SSCS at `high` (8 steps) and `ultra` (12). Not below.
    this._sscsEnabled = t >= 2;
    this._needNormals = t >= 1 || !!this.ctx?.systems?.get?.('VolumetricFog');

    if (this._compositePass) {
      const u = this._compositePass.uniforms;
      // Re-assert the exposure trim window every time the tier changes. Nothing else in the build
      // is allowed to widen it (§3.1.2, and see the constant block at the top of this file).
      u.uExposure.value.y = this._meterTarget();
      u.uExposure.value.z = EXPOSURE_GAIN_MIN;
      u.uExposure.value.w = EXPOSURE_GAIN_MAX;
      u.uGrain.value.x = (s?.get?.('filmGrain') ?? true) ? 1 : 0;
      u.uLens.value.x = (s?.get?.('chromaticAberration') ?? true) ? 0.0016 : 0;
      u.uVignette.value.x = (s?.get?.('vignette') ?? true) ? 0.30 : 0;
      u.uBloom.value.x = t >= 1 ? BLOOM_INTENSITY : 0;
    }
    if (this._taaPass) {
      this._taaPass.material.uniforms.uParams.value.w = t >= 3 ? 0.22 : 0.0;
    }
  }

  // ------------------------------------------------------------------ internals: frame

  _renderScene(renderer, scene, camera) {
    // --- TAA jitter, applied straight into the projection matrix so every material (including
    // other agents') is jittered identically, then removed before anyone else reads it.
    this._unjitteredProj.copy(camera.projectionMatrix);
    this._savedProj.copy(camera.projectionMatrix);
    this._jitter.set(0, 0);

    if (this.usingTAA) {
      const j = HALTON[this._frame % HALTON.length];
      const jx = j[0], jy = j[1];
      this._jitter.set(jx / this._pw, jy / this._ph);
      const e = camera.projectionMatrix.elements;
      e[8] += (2 * jx) / this._pw;
      e[9] += (2 * jy) / this._ph;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    }

    renderer.autoClear = true;
    renderer.setRenderTarget(this.sceneTarget);
    renderer.render(scene, camera);

    // Keep the JITTERED projection (and its inverse) for depth reconstruction — the depth buffer
    // we just wrote was rendered with it — but hand the un-jittered matrices back to the rest of
    // the engine immediately, before any other system reads them.
    this._projInv.copy(camera.projectionMatrixInverse);
    this._projJittered.copy(camera.projectionMatrix);

    camera.projectionMatrix.copy(this._savedProj);
    camera.projectionMatrixInverse.copy(this._savedProj).invert();
  }

  _renderGeometryBuffers(renderer, camera) {
    renderer.autoClear = false;

    const texel = _v2a.set(1 / this._pw, 1 / this._ph);
    const near = camera.near ?? 0.05;
    const far = camera.far ?? 1200;

    // --- normals from depth (public: VolumetricFog reads this.normalTexture)
    const hw = this._aoRT.width, hh = this._aoRT.height;

    if (this._needNormals) {
      const u = this._normalQuad.u;
      u.uProjInv.value.copy(this._projInv);
      // Half-res texel: the cross-difference stencil must straddle the pixel this half-res texel
      // actually covers, or the reconstruction reads a 1-full-res-pixel neighbourhood and returns
      // a normal for a quarter of the footprint it is being asked about.
      u.uTexel.value.set(1 / hw, 1 / hh);
      renderer.setRenderTarget(this._normalRT);
      this._normalQuad.quad.render(renderer);
    }

    // --- AO (half res) + separable bilateral blur guided by depth AND normal
    if (this._aoEnabled && this._needNormals) {
      const u = this._aoQuad.u;
      u.uProjInv.value.copy(this._projInv);
      u.uTexel.value.copy(texel);
      u.uNoiseScale.value.set(1 / this._noiseSize, 1 / this._noiseSize);
      u.uNearFar.value.set(near, far);
      u.uFrame.value = this._frame % 64;
      renderer.setRenderTarget(this._aoRT);
      this._aoQuad.quad.render(renderer);

      const b = this._aoBlurQuad.u;
      b.uTexel.value.set(1 / hw, 1 / hh);
      b.tAO.value = this._aoRT.texture;
      b.uDir.value.set(1, 0);
      renderer.setRenderTarget(this._aoRT2);
      this._aoBlurQuad.quad.render(renderer);

      b.tAO.value = this._aoRT2.texture;
      b.uDir.value.set(0, 1);
      renderer.setRenderTarget(this._aoRT);
      this._aoBlurQuad.quad.render(renderer);
    }

    // --- SSCS (half res, tier >= high). Runs before SSR so the reflection of a seated part
    // reflects the part, not the contact seam under it -- SSR reads the scene colour, which the
    // resolve has not darkened yet at this point in the frame.
    if (this._sscsEnabled && this._needNormals) {
      this._refreshLights();
      const u = this._sscsQuad.u;
      u.uProj.value.copy(this._projJittered);
      u.uProjInv.value.copy(this._projInv);
      u.uNoiseScale.value.set(1 / this._noiseSize, 1 / this._noiseSize);
      u.uNearFar.value.set(near, far);
      u.uParams.value.set(0.35, 0.06, this._frame % 64, 30);

      const moon = this._moonLight;
      if (moon && moon.visible && moon.intensity > 1e-4) {
        // Direction TOWARD the light. A DirectionalLight in three shines from its position to its
        // target, so that is position - target, rotated into view space.
        _v3b.setFromMatrixPosition(moon.matrixWorld);
        if (moon.target) _v3c.setFromMatrixPosition(moon.target.matrixWorld); else _v3c.set(0, 0, 0);
        _v3b.sub(_v3c);
        if (_v3b.lengthSq() > 1e-8) {
          _v3b.normalize().transformDirection(camera.matrixWorldInverse);
          u.uMoon.value.set(_v3b.x, _v3b.y, _v3b.z, 1);
        } else u.uMoon.value.w = 0;
      } else u.uMoon.value.w = 0;

      const lamp = this._lampLight;
      if (lamp && lamp.visible && lamp.intensity > 0.5) {
        _v3b.setFromMatrixPosition(lamp.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
        u.uLamp.value.set(_v3b.x, _v3b.y, _v3b.z, 1);
      } else u.uLamp.value.w = 0;

      renderer.setRenderTarget(this._sscsRT);
      this._sscsQuad.quad.render(renderer);
    }

    // --- SSR (half res, tier >= high)
    const gu = this._globalUniforms();
    if (this._ssrEnabled && this._needNormals) {
      const u = this._ssrQuad.u;
      u.uProj.value.copy(this._projJittered);
      u.uProjInv.value.copy(this._projInv);
      u.uViewInv.value.copy(camera.matrixWorld);
      u.uTexel.value.set(1 / hw, 1 / hh);
      u.uNoiseScale.value.set(1 / this._noiseSize, 1 / this._noiseSize);
      u.uNearFar.value.set(near, far);
      const wet = gu?.uWetness?.value ?? 0.26;
      u.uParams.value.set(wet, 0.55, 26, this._frame % 64);
      renderer.setRenderTarget(this._ssrRT);
      this._ssrQuad.quad.render(renderer);
    }
  }

  /**
   * Find the two lights SSCS traces against: the moon and the lantern.
   *
   * Deliberately discovered from the scene graph rather than from `Sky.js` / `Flashlight.js`
   * APIs — ARCHITECTURE §2.1 says to call a documented API or code defensively, and neither module
   * documents a light accessor. A graph scan cannot break when someone renames a field, and it
   * degrades to 'no trace' rather than to a crash if the rig is not built yet.
   *
   * Amortised: the rig does not change between frames, so this runs on frame 1 and then every 30th
   * frame. No allocation — positions are read straight out of matrixWorld.elements, which also
   * avoids the world-matrix update that getWorldPosition() would force.
   */
  _refreshLights(force = false) {
    if (!force && this._lightScanFrame !== undefined && (this._frame - this._lightScanFrame) < 30) return;
    this._lightScanFrame = this._frame;

    const scene = this.ctx?.scene;
    const camera = this.ctx?.camera;
    if (!scene || !camera) { this._moonLight = null; this._lampLight = null; return; }

    const cx = camera.matrixWorld.elements[12];
    const cy = camera.matrixWorld.elements[13];
    const cz = camera.matrixWorld.elements[14];

    let moon = null, moonI = -1;
    let lamp = null, lampScore = -1;

    scene.traverse((o) => {
      if (!o.visible) return;
      if (o.isDirectionalLight) {
        // The moon is the brightest directional. Lightning is the other one and it is 0 except
        // for the 60 ms of a flash, during which it legitimately owns the trace.
        if (o.intensity > moonI) { moonI = o.intensity; moon = o; }
      } else if (o.isSpotLight && o.intensity > 0.5) {
        // The lantern is whichever spot wins §3.6's own scoring function against the camera —
        // intensity / (1 + d²) — which in a first-person game the held lamp always does.
        const e = o.matrixWorld.elements;
        const dx = e[12] - cx, dy = e[13] - cy, dz = e[14] - cz;
        const score = o.intensity / (1 + dx * dx + dy * dy + dz * dz);
        if (score > lampScore) { lampScore = score; lamp = o; }
      }
    });

    this._moonLight = moon;
    this._lampLight = lamp;
  }

  _renderExposure(renderer) {
    // --- stage 1: TRANSFORM. scene HDR -> 64x64 compressed luminance.
    const l = this._lumQuad.u;
    l.tDiffuse.value = this.sceneTarget.texture;
    l.uExposureIn.value = this._scriptedExposure();
    renderer.setRenderTarget(this._lum0);
    this._lumQuad.quad.render(renderer);

    // --- stage 2: REDUCTION. 64x64 -> 8x8, plain mean. A different shader, deliberately.
    const m = this._meanQuad.u;
    m.tDiffuse.value = this._lum0.texture;
    m.uTexel.value.set(1 / 64, 1 / 64);
    m.uSpan.value = 8;
    renderer.setRenderTarget(this._lum1);
    this._meanQuad.quad.render(renderer);

    const src = this._adapt[this._adaptIndex];
    const dst = this._adapt[1 - this._adaptIndex];
    const a = this._adaptQuad.u;
    a.tLum.value = this._lum1.texture;
    a.tPrev.value = src.texture;
    a.uNearFar.value.set(this.ctx.camera?.near ?? 0.05, this.ctx.camera?.far ?? 1200);
    // 2.6 s luminance tau: slow enough that walking past the campfire is a slow bloom-down rather
    // than a camcorder's pump, which is the thing §3.1.2 was really objecting to.
    a.uParams.value.set(this._dt, 2.6, 0.22, this._frame <= 2 ? 1 : 0);
    renderer.setRenderTarget(dst);
    this._adaptQuad.quad.render(renderer);
    this._adaptIndex = 1 - this._adaptIndex;
    this._adaptTexture = dst.texture;
  }

  /** §3.1.2's scripted curve, in renderer units: the bible's value times the scene calibration. */
  _scriptedExposure() {
    return this._exposureBase * this._lightningExp * EXPOSURE_CALIBRATION;
  }

  /**
   * §3.1.1 asserts a different average-luminance window per weather state. The meter target moves
   * with it, so a whiteout is allowed to be the brighter, flatter night the bible says it is
   * instead of being metered back down to a clear night.
   */
  _meterTarget() {
    const base = this._weatherScale;
    const ton = this.ctx?.state?.timeOfNight;
    if (Number.isFinite(ton) && ton > 0.88) {
      const t = Math.min(1, (ton - 0.88) / 0.12);
      return EXPOSURE_KEY * (base + (METER_TARGET_SCALE.dawn - base) * t);
    }
    return EXPOSURE_KEY * (Number.isFinite(base) ? base : 1);
  }

  /**
   * §3.1.1's row for the current night, with the raw fog value as a whiteout-only override.
   * Called from `update()` as well as from the events, because the Shots harness sets
   * `state.night` directly and never emits `night:begin`.
   */
  _refreshWeatherScale(fog) {
    if (Number.isFinite(fog)) this._lastFog = fog;
    fog = this._lastFog;
    const n = this.ctx?.state?.night;
    const state = NIGHT_METER_STATE[Number.isFinite(n) ? Math.max(0, Math.min(7, n | 0)) : 1];
    // The scripted ramp already uses fog > 0.85 for the whiteout; the meter uses the same number,
    // so an unscheduled whiteout still gets its window and a merely foggy night does not.
    const s = (Number.isFinite(fog) && fog > 0.85)
      ? METER_TARGET_SCALE.whiteout
      : METER_TARGET_SCALE[state];
    this._weatherScale = Number.isFinite(s) ? s : METER_TARGET_SCALE.clear;
  }

  _updateChainUniforms(camera) {
    const near = camera.near ?? 0.05;
    const far = camera.far ?? 1200;
    const texel = _v2a.set(1 / this._pw, 1 / this._ph);
    const gu = this._globalUniforms();

    // --- resolve
    {
      const u = this._resolvePass.uniforms;
      u.tScene.value = this.sceneTarget.texture;
      u.tAO.value = (this._aoEnabled && this._needNormals) ? this._aoRT.texture : this._whiteTex;
      u.tSSR.value = (this._ssrEnabled && this._needNormals) ? this._ssrRT.texture : this._blackTex;
      u.tSSCS.value = (this._sscsEnabled && this._needNormals) ? this._sscsRT.texture : this._whiteTex;
      u.tFog.value = this._fogTexture() ?? this._fogFallback;
      u.uTexel.value.copy(texel);
      // AO strength, SSR strength, exposure hint (so AO backs off in the lantern hotspot).
      const wet = gu?.uWetness?.value ?? 0.26;
      u.uParams.value.set(
        this._aoEnabled ? 0.85 : 0.0,
        this._ssrEnabled ? (0.35 + 0.35 * wet) : 0.0,
        this._scriptedExposure() * 2.7,
        this._sscsEnabled ? SSCS_STRENGTH : 0.0,
      );
    }

    // --- TAA
    if (this._taaPass?.enabled) {
      const u = this._taaPass.material.uniforms;
      u.tDepth.value = this._depthTex;
      u.uProjInv.value.copy(this._projInv);
      u.uViewInv.value.copy(camera.matrixWorld);
      if (this._prevValid) u.uPrevViewProj.value.copy(this._prevViewProj);
      else { u.uPrevViewProj.value.identity(); u.uReset.value = 1; }
      u.uTexel.value.copy(texel);
      u.uJitter.value.copy(this._jitter);
      u.uParams.value.x = 0.72;
      u.uParams.value.y = 0.92;
      u.uParams.value.z = 1.25;
    }

    // --- motion blur
    //
    // BUG, fixed here: the enable test used to live INSIDE `if (this._motionPass.enabled)`, and it
    // includes `this._prevValid`, which is false on frame 1 by construction. So the pass switched
    // itself off on the first frame of every session and the guard then made it unreachable — it
    // could only come back via a quality-tier change. Verified on the live build before the fix:
    // `motionBlur` setting true, `_prevValid` true, `_motionPass.enabled` FALSE at frame 133.
    // Motion blur has not run in this game. The gate is now evaluated unconditionally and the
    // uniform write is what is guarded.
    if (this._motionPass) {
      const want = this._prevValid
        && (this._settings?.get?.('motionBlur') ?? true)
        && this._tier >= 1;
      this._motionPass.enabled = want;
      if (want) {
        const u = this._motionPass.uniforms;
        u.tDepth.value = this._depthTex;
        u.uProjInv.value.copy(this._projInv);
        u.uViewInv.value.copy(camera.matrixWorld);
        u.uPrevViewProj.value.copy(this._prevViewProj);
        u.uNoiseScale.value.set(1 / this._noiseSize, 1 / this._noiseSize);
        u.uJitter.value.copy(this._jitter);
        u.uTexel.value.copy(texel);
        u.uParams.value.set(0.5, 0.028, this._frame % 64, 0);
      }
    }

    // --- DOF: focus on what the reticle hits; near-field when carrying a part.
    if (this._dofPass?.enabled) {
      const u = this._dofPass.uniforms;
      u.tDepth.value = this._depthTex;
      u.tAdapt.value = this._adaptTexture ?? this._adapt[0].texture;
      u.uTexel.value.copy(texel);
      u.uNearFar.value.set(near, far);
      const build = this.ctx?.systems?.get?.('BuildSystem');
      const carrying = !!(build?.heldPart) || (this.ctx?.state?.inventory?.length > 0);
      const maxR = this._tier >= 3 ? 9.0 : 6.0;
      u.uParams.value.set(maxR * (this._dpr > 1 ? this._dpr * 0.6 : 1), 0.30, carrying ? 0.55 : 0.18, 0);
    }

    // --- bloom prefilter. Same total exposure as the composite (metered gain included, resolved
    // GPU-side from the same 1x1 adaptation texel), so the §12.2 threshold means what it says.
    if (this._bloomPass?.enabled) {
      const bu = this._bloomPass.preMaterial.uniforms;
      const p = bu.uParams.value;
      p.x = BLOOM_THRESHOLD; p.y = BLOOM_KNEE;
      p.z = this._scriptedExposure();
      bu.tAdapt.value = this._adaptTexture ?? this._adapt[0].texture;
      bu.uExposure.value.set(this._scriptedExposure(), this._meterTarget(), EXPOSURE_GAIN_MIN, EXPOSURE_GAIN_MAX);
    }

    // --- composite
    {
      const u = this._compositePass.uniforms;
      u.tBloom.value = (this._bloomPass?.enabled && this._bloomPass.texture)
        ? this._bloomPass.texture : this._blackTex;
      u.tAdapt.value = this._adaptTexture ?? this._adapt[0].texture;
      u.tNoise.value = this._noise;
      u.uResolution.value.set(this._pw, this._ph);
      u.uNoiseSize.value.set(this._noiseSize, this._noiseSize);
      u.uExposure.value.set(this._scriptedExposure(), this._meterTarget(), EXPOSURE_GAIN_MIN, EXPOSURE_GAIN_MAX);
      u.uTime.value = this._time;
      u.uFrame.value = this._frame % 1024;

      // Grain size scales with resolution so a grain stays physically 1.35 px at 1080p, and never
      // shrinks below it — sub-pixel grain is not film, it is dither.
      u.uGrain.value.y = GRAIN_PX * Math.max(1.0, this._ph / 1080);
      u.uGrain.value.w = this._tier >= 2 ? GRAIN_MID : GRAIN_MID * 0.5;

      // Vignette: art vignette + the sprint/panic tighten (§12.7 — the ONLY dynamic vignette).
      const tighten = Math.max(this._sprint, this._panic);
      const pulse = this._panic * 0.10 * (0.5 + 0.5 * Math.sin(this._time * 6.0));
      const base = (this._settings?.get?.('vignette') ?? true) ? 0.30 : 0.0;
      u.uVignette.value.set(
        base + tighten * 0.06 + pulse,
        0.42 - tighten * 0.06,
        1.10 - tighten * 0.08,
        1.0,
      );

      // Chromatic aberration: a static property of a 21 mm lens, +18% for the 60 ms of a
      // lightning flash (§12.5). Held at a constant ~1.4 px of R/B separation at the corner and
      // literally 0 px across the middle 40% of the frame, at ANY resolution — a UV-constant
      // strength would double the fringing on a 1440p screen.
      const caOn = (this._settings?.get?.('chromaticAberration') ?? true) ? 1 : 0;
      u.uLens.value.set(
        0.00073 * (1080 / Math.max(360, this._ph)) * caOn * (1 + 0.18 * (this._flash ?? 0)),
        this._panic * 0.020,
        this._panic,
        this._flash ?? 0,
      );

      u.uGrain.value.x = (this._settings?.get?.('filmGrain') ?? true) ? 1 : 0;
    }

    // --- FXAA
    if (this._fxaaPass?.enabled) this._fxaaPass.uniforms.uTexel.value.copy(texel);
  }

  /* ------------------------------------------------------------------ dev: the pass budget ----
   * `bench()` answers one question: how many milliseconds does each pass cost, right now, at the
   * resolution actually being rendered. Everything in the perf section of this file was decided
   * from its output, so the method ships with the file rather than living in a scratch console.
   *
   * WHY IT IS SHAPED LIKE THIS. Two more obvious instruments were tried first and both lie:
   *
   *   EXT_disjoint_timer_query_webgl2  is present on this ANGLE/Metal backend and it resolves, but
   *      each begin/end splits the command buffer. Bracketing eleven stages of one real frame
   *      reported every stage at 11-15 ms and a 180 ms total on a 95 ms frame: the queries were
   *      measuring their own flushes. Timing a stage by submitting it N times in a row instead
   *      reported 153 ms for the scene draw on a 116 ms frame, because N back-to-back copies of a
   *      full-screen pass hit bandwidth behaviour that the in-order frame never sees.
   *   gl.finish()  does not synchronise here. A full frame 'measured' 1.32 ms through it.
   *
   * What does work is a 1x1 readPixels() off the default framebuffer, which is a real stall, with
   * the pass under test toggled off between two runs. Subtraction of two synchronised wall-clock
   * numbers has no per-pass instrumentation cost to contaminate it.
   * ------------------------------------------------------------------------------------------ */

  /**
   * DEV TOOL. `await post.bench()` -> [{ name, ms, delta }], each delta being what that pass costs.
   *
   * NEVER called from the frame loop, which is why it may allocate. Runs the frame itself, so it
   * is valid with the engine stopped or running; stop the engine for the quietest numbers.
   */
  async bench(frames = 12, repeats = 3, skipScene = true) {
    const renderer = this.ctx?.renderer;
    if (!renderer || !this._ready || this._fallback || !this.composer) return null;
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    const fog = this.ctx?.systems?.get?.('VolumetricFog');
    const pass = (n) => this.composer.passes.find((p) => (p.material?.name ?? p.constructor?.name) === n);

    const sync = () => {
      renderer.setRenderTarget(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    };
    const frame = () => {
      if (fog?.enabled && typeof fog.render === 'function') fog.render();
      this.render(skipScene);
    };
    const once = () => {
      for (let i = 0; i < 3; i++) frame();
      sync();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) frame();
      sync();
      return (performance.now() - t0) / frames;
    };
    const measure = async () => {
      let best = Infinity;
      for (let k = 0; k < repeats; k++) { best = Math.min(best, once()); await new Promise((r) => setTimeout(r, 16)); }
      return best;
    };

    // Saved state — every one of these is restored in the finally block.
    const saved = {
      fog: fog?.enabled, ssr: this._ssrEnabled, sscs: this._sscsEnabled, ao: this._aoEnabled, normals: this._needNormals,
      exposureFn: this._renderExposure, shadowAuto: renderer.shadowMap.autoUpdate,
      passes: this.composer.passes.map((p) => p.enabled),
    };

    const rows = [];
    try {
      let prev = await measure();
      rows.push({ name: 'FULL FRAME', ms: +prev.toFixed(2), delta: 0 });
      const step = async (name, off) => {
        off();
        const now = await measure();
        rows.push({ name, ms: +now.toFixed(2), delta: +(prev - now).toFixed(2) });
        prev = now;
      };

      await step('volumetric fog', () => { if (fog) fog.enabled = false; });
      await step('ssr', () => { this._ssrEnabled = false; });
      await step('sscs', () => { this._sscsEnabled = false; });
      await step('gtao + bilateral blur', () => { this._aoEnabled = false; });
      await step('bloom chain', () => { const p = pass('BloomPass'); if (p) p.enabled = false; });
      await step('dof', () => { const p = pass('sc-dof'); if (p) p.enabled = false; });
      await step('motion blur', () => { const p = pass('sc-motion'); if (p) p.enabled = false; });
      await step('taa', () => { const p = pass('sc-taa'); if (p) p.enabled = false; });
      await step('meter chain', () => { this._renderExposure = () => {}; });
      await step('normals from depth', () => { this._needNormals = false; });
      await step('composite', () => { const p = pass('sc-composite'); if (p) p.enabled = false; });
      await step('resolve', () => { const p = pass('sc-resolve'); if (p) p.enabled = false; });
      await step('shadow maps (not ours)', () => { renderer.shadowMap.autoUpdate = false; });
      rows.push({ name: skipScene ? 'FLOOR (scene draw excluded)' : 'SCENE DRAW, no shadows', ms: +prev.toFixed(2), delta: 0 });
    } finally {
      if (fog) fog.enabled = saved.fog;
      this._ssrEnabled = saved.ssr;
      this._sscsEnabled = saved.sscs;
      this._aoEnabled = saved.ao;
      this._needNormals = saved.normals;
      this._renderExposure = saved.exposureFn;
      renderer.shadowMap.autoUpdate = saved.shadowAuto;
      this.composer.passes.forEach((p, i) => { p.enabled = saved.passes[i]; });
      this._taaPass?.reset();
      this._prevValid = false;
    }
    return rows;
  }

  /**
   * DEV TOOL, and the instrument every number in this file's comments was measured with.
   *
   * §3.1.1 asserts an average-frame-luminance window per weather state and §3.1/§12.4 assert a
   * black point; both were prose until now, because nothing in the build could read the FINAL
   * 8-bit frame. This reads the default framebuffer after a render and reports the exact
   * quantities those two sections are written in — relative luminance in linear light, not the
   * HDR meter, which is a different number in a different space and is why two earlier passes
   * argued about the metering floor while the frame stayed a stop and a half off.
   *
   * NEVER called from the frame loop: readPixels is a full pipeline stall and it allocates.
   *
   * @returns {{avg:number, p1:number, p25:number, p50:number, p75:number, p99:number,
   *            over50:number, minChannel:number, zeroPixels:number, state:string,
   *            window:number[], pass:boolean}|null}
   */
  assertLuma() {
    const renderer = this.ctx?.renderer;
    if (!renderer || this._fallback) return null;
    const gl = renderer.getContext?.();
    if (!gl) return null;

    const w = renderer.domElement?.width || this._pw;
    const h = renderer.domElement?.height || this._ph;
    // Stride the frame rather than reading all of it: a 1/4-linear sample is 1/16 the pixels and
    // the percentiles it returns match a full read to within 0.3% on every shot measured.
    const step = Math.max(1, Math.round(Math.min(w, h) / 360));
    const px = new Uint8Array(w * h * 4);
    // Render first. The default framebuffer is double-buffered: read it from a console eval or a
    // test hook — i.e. from a task other than the one that drew it — and the contents are whatever
    // the compositor left behind. Measured: the same frame reported avg 0.0469 read cold and
    // 0.0225 read after a fresh draw, which is a whole stop of pure instrumentation error and
    // exactly the sort of number that gets argued about for an hour.
    this.render();
    renderer.setRenderTarget(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

    const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) lut[i] = toLinear(i / 255);

    const ys = [];
    let sum = 0, over = 0, minCh = 255, zeros = 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const Y = lut[r] * 0.2126 + lut[g] * 0.7152 + lut[b] * 0.0722;
        ys.push(Y);
        sum += Y;
        if (Y > 0.5) over++;
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        if (mn < minCh) minCh = mn;
        if (mn === 0) zeros++;
      }
    }
    if (!ys.length) return null;
    ys.sort((a, b) => a - b);
    const q = (p) => ys[Math.min(ys.length - 1, Math.max(0, Math.round((p / 100) * (ys.length - 1))))];

    // §3.1.1's per-weather window, keyed the same way the meter target is.
    const WINDOWS = {
      clear: [0.018, 0.028], drizzle: [0.015, 0.026], 'windy-mist': [0.021, 0.034],
      rain: [0.014, 0.025], whiteout: [0.070, 0.130], storm: [0.012, 0.023],
      dawn: [0.050, 0.095],
    };
    const n = this.ctx?.state?.night;
    let state = NIGHT_METER_STATE[Number.isFinite(n) ? Math.max(0, Math.min(7, n | 0)) : 1];
    if (this._lastFog > 0.85) state = 'whiteout';
    const ton = this.ctx?.state?.timeOfNight;
    if (Number.isFinite(ton) && ton > 0.88) state = 'dawn';
    const win = WINDOWS[state] ?? WINDOWS.clear;
    const avg = sum / ys.length;

    return {
      avg: +avg.toFixed(5), p1: +q(1).toFixed(5), p25: +q(25).toFixed(5), p50: +q(50).toFixed(5),
      p75: +q(75).toFixed(5), p99: +q(99).toFixed(5),
      over50: +((over / ys.length) * 100).toFixed(3),
      minChannel: minCh, zeroPixels: zeros, state, window: win,
      // §3.1 wants the blackest 1% inside [0.002, 0.006] and NOTHING at zero.
      pass: avg >= win[0] && avg <= win[1] && zeros === 0 && q(1) >= 0.002 && q(1) <= 0.006,
    };
  }

  _fogTexture() {
    const fog = this.ctx?.systems?.get?.('VolumetricFog');
    if (!fog) return null;
    const t = fog.target;
    if (!t) return null;
    if (t.isTexture) return t;
    if (t.texture?.isTexture) return t.texture;
    return null;
  }

  // ------------------------------------------------------------------ internals: resize

  _resizeTo(pw, ph) {
    pw = Math.max(1, Math.round(pw));
    ph = Math.max(1, Math.round(ph));
    if (pw === this._pw && ph === this._ph) return;
    this._pw = pw; this._ph = ph;
    const hw = Math.max(1, pw >> 1), hh = Math.max(1, ph >> 1);

    try {
      this.sceneTarget.setSize(pw, ph);
      this._depthTex.image.width = pw;
      this._depthTex.image.height = ph;
      this._depthTex.needsUpdate = true;
      this._normalRT.setSize(hw, hh);
      this._aoRT.setSize(hw, hh);
      this._aoRT2.setSize(hw, hh);
      this._ssrRT.setSize(hw, hh);
      this._sscsRT.setSize(hw, hh);
      this._history[0].setSize(pw, ph);
      this._history[1].setSize(pw, ph);

      let bw = hw, bh = hh;
      for (let i = 0; i < this._bloomMips.length; i++) {
        this._bloomMips[i].setSize(Math.max(1, bw), Math.max(1, bh));
        bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
      }

      this.composer?.setSize(pw, ph);
      this._taaPass?.reset();
      this._prevValid = false;

      // Texture identities can change on resize; re-point the samplers.
      this.depthTexture = this._depthTex;
      this.normalTexture = this._normalRT.texture;
      this.gbufferTexture = (this.sceneTarget.textures && this.sceneTarget.textures.length > 1)
        ? this.sceneTarget.textures[1] : null;
      if (this._ssrQuad) this._ssrQuad.u.tScene.value = this.sceneTarget.texture;
      if (this._aoQuad) this._aoQuad.u.tNormal.value = this._normalRT.texture;
      if (this._aoBlurQuad) this._aoBlurQuad.u.tNormal.value = this._normalRT.texture;
      if (this._ssrQuad) this._ssrQuad.u.tNormal.value = this._normalRT.texture;
      if (this._sscsQuad) { this._sscsQuad.u.tNormal.value = this._normalRT.texture; this._sscsQuad.u.tDepth.value = this._depthTex; }
      if (this._normalQuad) this._normalQuad.u.tDepth.value = this._depthTex;
    } catch (e) {
      Log.once('post:resize', 'Postprocessing.resize() failed:', e);
    }
  }
}

/**
 * Opt-in: bind attachment 1 of the scene MRT. Leave false until Materials.js emits SC_MRT_OUT —
 * see the comment in _buildTargets(). Set before Postprocessing is constructed.
 */
Postprocessing.MRT_GBUFFER = false;

export default Postprocessing;
