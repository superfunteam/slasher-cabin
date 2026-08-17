#!/usr/bin/env node
/**
 * Shrink `public/img/` to the size the game actually DISPLAYS.
 *
 * Every PNG in `public/img/` came straight out of gpt-image-2 at generation resolution, 8 bits
 * per channel, full truecolour, with the generator's film grain intact. Nothing on screen is
 * drawn at that resolution: measured on the live build, 27 MB of a 46 MB dist was these files,
 * and a first-time visitor watched the title booklet render against nothing for 2.5 seconds
 * while a 2 MB forest photograph came down behind it.
 *
 * Two levers, both lossy in principle and neither visible in practice:
 *
 *   1. RESOLUTION. Each target below is derived from the CSS in `src/ui/Menu.js` — the actual
 *      box the image is painted into — times a device-pixel-ratio cushion, NOT from a guess.
 *      The per-file `why` string carries that derivation so the next person can check it.
 *   2. PALETTE. The manual idiom (ART_DIRECTION §13.6) is flat line art on flat bone stock:
 *      `paper #f2efe6`, `ink #14181a`, one accent `#d92b2b`, no gradients, no shadows. That is
 *      a handful of colours pretending to be sixteen million. Quantising it undithered is very
 *      nearly lossless and collapses the file by an order of magnitude. The one photograph
 *      (`splash-title`) is quantised in LAB, where 256 entries land where the eye is looking.
 *
 * WHAT IS DELIBERATELY NOT TOUCHED
 *
 *   `keyart-site.png` / `keyart-lake.png` are the art-direction references. `tools/luma.mjs`
 *   refuses to report until it reproduces keyart-site at meanY 0.0218 / 79.77% below 0.02
 *   (ARCHITECTURE §11d), so their pixel values ARE the measurement gate. Re-encoding them would
 *   silently move the calibration target and every luminance number in the project with it.
 *   They already never ship — `stripReferenceArt` in vite.config.js drops them from dist.
 *
 * FORMAT STAYS PNG. `Menu.js` hardcodes '/img/<name>.png' in five places and `Props.js` in one;
 * this tool owns neither. WebP would mean a src change, so the win here is resolution and bit
 * depth only. That is enough: it is a 92% cut.
 *
 * IDEMPOTENCE. There is no sidecar manifest — the images describe themselves. A file is
 * considered done when its width, colourspace and colour count already satisfy its recipe, so a
 * second run is a no-op and a fresh checkout re-optimises only what git restored.
 *
 * ONE TRAP THIS CREATES — READ BEFORE YOU MEASURE ONE OF THESE FILES
 *
 *   Most outputs are now INDEXED (PNG colour-type 3). `tools/luma.mjs` decodes through
 *   `sips -s format tiff`, which preserves the palette into the TIFF, and luma.mjs's minimal
 *   IFD walk assumes 3 samples per pixel — so it reads palette INDICES as RGB and reports
 *   nonsense. It reported meanY NaN for splash-title and "99.81% below 0.02" for a nearly-white
 *   paper texture. The images are fine; the decoder is not.
 *
 *   This does not touch the luma gate itself: keyart-site/lake stay truecolour and untouched, so
 *   luma.mjs still calibrates (verified: meanY 0.02184, 79.77% below 0.02, unchanged), and frames
 *   from `window.__CAPTURE__` are truecolour too. But if you point luma.mjs at anything in
 *   public/img/ other than the keyart, flatten it first:
 *       magick in.png -type TrueColor out.png
 *   Splash-title was verified that way: meanY 0.01986 before, 0.01985 after.
 *
 * Usage:
 *   node tools/optimise-images.mjs                 optimise what needs it, print the table
 *   node tools/optimise-images.mjs --dry-run       report only, touch nothing
 *   node tools/optimise-images.mjs --force         redo every file, even ones already done
 *   node tools/optimise-images.mjs --from-git=REF  re-derive from the originals in a git ref
 *                                                  (use with --force after changing a recipe —
 *                                                  it avoids re-quantising a quantised file)
 *   node tools/optimise-images.mjs --only=splash   restrict to files matching a substring
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMG = join(ROOT, 'public', 'img');

/* ------------------------------------------------------------------ recipes */

/**
 * Reference-only art. Not a recipe — an exclusion. See the header.
 */
const REFERENCE_ONLY = new Set(['keyart-site.png', 'keyart-lake.png']);

/**
 * One entry per file.
 *
 * @typedef {object} Recipe
 * @property {number}  width      target pixel width; height follows the source aspect
 * @property {number}  colors     palette size, or 0 to leave the image truecolour
 * @property {'sRGB'|'LAB'|'Gray'} space  quantisation space; 'Gray' also converts the image
 * @property {string}  why        the derivation. If you change a number, change this.
 */
const RECIPES = {
  // ---- the title screen ---------------------------------------------------------------------
  'splash-title.png': {
    width: 1536, colors: 256, space: 'LAB',
    why: 'full-bleed backdrop, background-size:cover under a 1.06-1.105 drift (Menu.js .sc-splash). '
      + 'MEASURED in the running title screen at 1280x720 DPR 2: the .sc-splash box is 1392x783 CSS '
      + 'px carrying transform scale 1.0874, i.e. ~2780 device px wide against a 1536 px source — it '
      + 'is ALREADY upsampled about 2x before this tool runs, and resolution must not drop by one '
      + 'pixel. The whole win is the palette: the frame is a narrow blue-grey band plus one amber '
      + 'lantern, and 256 LAB entries cover that with no banding visible at display scale even under '
      + '+45 brightness / +35 contrast. Verified meanY 0.01986 -> 0.01985 (Rec.709 linear), so the '
      + 'ART_DIRECTION luminance contract is untouched.',
  },
  'title-treatment.png': {
    width: 1024, colors: 128, space: 'sRGB',
    why: 'MEASURED, not derived: getBoundingClientRect on .sc-plate img in the running title screen '
      + 'at 1280x720 DPR 2 is 439x194 CSS px = 878x388 device px. (Arithmetic off the CSS said '
      + '~360x240 and was wrong in both axes — the height cap is min(27vh, 15rem), which is vh-bound '
      + 'at 194 px, and the padding clamp is nowhere near its 46 px ceiling at that viewport.) So '
      + '1024 is 1.17x the device-pixel width with the sheet at its 30.5rem maximum. Do NOT cut this '
      + 'to 768: that would upsample the game\'s title plate on any ordinary laptop.',
  },

  // ---- the manual plates --------------------------------------------------------------------
  'manual-cover.png': {
    width: 768, colors: 96, space: 'sRGB',
    why: 'pause sheet is min(94vw, 27rem); .sc-cover img is object-fit:cover into aspect 1/.78 with '
      + 'mix-blend-mode:darken, so width binds. ~383 CSS px of content on a desktop = 766 device px '
      + 'at DPR 2, which 768 covers exactly. The one case this does NOT cover is a DPR-3 phone, where '
      + 'the sheet is proportionally wider and the box reaches ~1020 device px — a 1.33x upsample. '
      + 'Checked that case at 1:1 against the 1024 original: the corrugation hatching is a hair '
      + 'softer and nothing else moves, which is the right trade for a decorative plate behind a '
      + 'paused game. Going back to 1024 costs +166 KB and buys only that one case; if the pause '
      + 'cover ever becomes a hero image, spend it.',
  },
  'loading-plate.png': {
    width: 768, colors: 96, space: 'sRGB',
    why: 'boot sheet is min(88vw, 30rem), cropped to aspect 3/1.72 — ~404 CSS px of content on a '
      + 'desktop = 808 device px at DPR 2, and ~954 on a DPR-3 phone. Compared at 954 against the '
      + '1024 original: the claw curve, the hairline board edges and the red handle cap are '
      + 'indistinguishable. This plate is on screen before anything else in the game is, so its '
      + 'bytes matter more per pixel than any other file here.',
  },
  'nightcard-texture.png': {
    width: 768, colors: 64, space: 'sRGB',
    why: 'blank aged stock, MULTIPLIED under the type rather than drawn as a layer (Menu.js '
      + '.sc-card[data-tex]), background-size:cover over the whole viewport — so it is already '
      + 'upsampled ~1.9x from 1024 and its grain is mush before this tool touches it. .sc-card::after '
      + 'lays its own 128 px fibre tile on top, which is where the fine grain actually comes from. '
      + '64 entries is generous for one warm bone tone and three fold creases.',
  },

  // ---- world decals -------------------------------------------------------------------------
  'decal-grunge-01.png': {
    width: 512, colors: 0, space: 'Gray',
    why: 'STAIN_FRAG (Props.js) reads this as dot(t.rgb, Rec.709) and nothing else — it is a '
      + 'luminance mask, remapped through a 0.34-0.86 smoothstep at strength 0.55 over procedural '
      + 'PBR. Converting to Gray is therefore EXACTLY value-preserving for the only quantity the '
      + 'shader computes, and drops two of three channels. Tiled with RepeatWrapping and mipmapped, '
      + 'so 512 is ample for a soft darkening mask.',
  },
  'decal-moss-01.png': {
    width: 512, colors: 256, space: 'LAB',
    why: 'not referenced by any src file today. Kept present because an asset that works in dev '
      + 'and 404s in prod the moment someone wires it is the worst trap available. Left in colour '
      + 'rather than greyscaled with grunge, because nothing yet says it will be used as a mask.',
  },
  'decal-rust-01.png': {
    width: 512, colors: 256, space: 'LAB',
    why: 'unused; see decal-moss-01. Same tile budget as the decal it would sit beside.',
  },

  // ---- sheets not yet wired up ----------------------------------------------------------------
  'icons-parts.png': {
    width: 768, colors: 64, space: 'sRGB',
    why: 'unused. A 4x3 pictogram grid designed to survive 32 px; 768 leaves 192 px per cell, '
      + 'which is 3x a 64 px slot. Flat ink on bone stock, so 64 entries is more than the art has.',
  },
  'icons-tools.png': {
    width: 768, colors: 64, space: 'sRGB',
    why: 'unused; see icons-parts. 4x4 grid, 192 px per cell at 768.',
  },
  'hardware-plate.png': {
    width: 768, colors: 64, space: 'sRGB',
    why: 'unused. 5x4 roundels of line art on bone stock; 153 px per cell at 768.',
  },
  'mascot-sheet.png': {
    width: 768, colors: 64, space: 'sRGB',
    why: 'unused. Eight BJORN poses, pure outline with one red accent — the most quantisable '
      + 'image in the directory.',
  },
};

/* ------------------------------------------------------------------ shell helpers */

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valOf = (f) => { const a = args.find((x) => x.startsWith(`${f}=`)); return a ? a.slice(f.length + 1) : null; };

const DRY = has('--dry-run');
const FORCE = has('--force');
const ONLY = valOf('--only');
const FROM_GIT = valOf('--from-git');

function sh(cmd, argv, opts = {}) {
  return execFileSync(cmd, argv, { encoding: 'utf8', cwd: ROOT, ...opts }).trim();
}

/** ImageMagick 7 is the only thing on this machine that can quantise a palette; sips cannot. */
function requireMagick() {
  try {
    const v = sh('magick', ['-version']).split('\n')[0];
    if (!/ImageMagick 7/.test(v)) throw new Error(v);
    return v;
  } catch {
    process.stderr.write(
      'optimise-images: needs ImageMagick 7 (`magick`).\n'
      + '  brew install imagemagick\n'
      + 'sips can resize but cannot palette-quantise, and the palette is where the win is.\n',
    );
    process.exit(2);
  }
}

/**
 * What the file on disk actually is. Read from the file, never assumed — a tool that trusts its
 * own bookkeeping over the pixels is how you get a confident wrong number (ARCHITECTURE §11d).
 */
function probe(path) {
  const out = sh('magick', ['identify', '-format', '%w %h %[colorspace] %[type]', `${path}[0]`]);
  const [w, h, space, type] = out.split(/\s+/);
  // %[colors] forces a full histogram pass; only ask for it when the answer can matter.
  const colors = Number(sh('magick', ['identify', '-format', '%[colors]', `${path}[0]`]));
  return { w: Number(w), h: Number(h), space, type, colors, bytes: statSync(path).size };
}

/** True when the file already satisfies its recipe and re-running would only cost quality. */
function isDone(cur, r) {
  if (cur.w !== r.width) return false;
  if (r.space === 'Gray') return /Gray/i.test(cur.space) || /Gray/i.test(cur.type);
  if (r.colors > 0 && cur.colors > r.colors) return false;
  return r.colors > 0;
}

/* ------------------------------------------------------------------ the work */

function optimise(src, dst, r) {
  const argv = [src];
  if (r.space === 'Gray') argv.push('-colorspace', 'Gray');
  else if (r.space === 'LAB') argv.push('-quantize', 'LAB');
  // Resize in the source's own space. -filter Lanczos keeps the manual's hairlines from going
  // soft; a box/triangle downscale turns a 1 px rule into a grey smear at these ratios.
  argv.push('-filter', 'Lanczos', '-resize', `${r.width}x`);
  if (r.colors > 0) {
    // NO DITHER, deliberately. Dithering a flat-stock plate scatters the paper into speckle that
    // then costs MORE bytes than the truecolour original (Floyd-Steinberg at 256 measured 2175 KB
    // against a 2086 KB source), and on the photograph it buys nothing the eye can find.
    argv.push('-dither', 'None', '-colors', String(r.colors));
  }
  argv.push('-strip', '-define', 'png:compression-level=9', dst);
  sh('magick', argv);
}

/** The pristine source for a file: a git blob when asked for, otherwise the working copy. */
function sourceFor(name, tmp) {
  if (!FROM_GIT) return join(IMG, name);
  const out = join(tmp, `src-${name}`);
  try {
    const buf = execFileSync('git', ['cat-file', 'blob', `${FROM_GIT}:public/img/${name}`],
      { cwd: ROOT, maxBuffer: 1 << 28 });
    execFileSync('sh', ['-c', `cat > "${out}"`], { input: buf });
    return out;
  } catch {
    process.stdout.write(`  ! ${name}: not in ${FROM_GIT}, falling back to the working copy\n`);
    return join(IMG, name);
  }
}

function kb(n) { return `${(n / 1024).toFixed(0)}`; }
function pad(s, n, right = false) { s = String(s); return right ? s.padStart(n) : s.padEnd(n); }

function main() {
  const version = requireMagick();
  if (!existsSync(IMG)) { process.stderr.write(`optimise-images: no ${IMG}\n`); process.exit(2); }

  const present = readdirSync(IMG).filter((f) => f.toLowerCase().endsWith('.png')).sort();
  const unknown = present.filter((f) => !RECIPES[f] && !REFERENCE_ONLY.has(f));

  process.stdout.write(`${version}\n`);
  process.stdout.write(`public/img — ${present.length} PNG, ${kb(present.reduce((a, f) => a + statSync(join(IMG, f)).size, 0))} KB`
    + `${DRY ? '   [DRY RUN]' : ''}${FORCE ? '   [FORCE]' : ''}${FROM_GIT ? `   [FROM ${FROM_GIT}]` : ''}\n\n`);

  const tmp = mkdtempSync(join(tmpdir(), 'sc-optimg-'));
  const rows = [];
  let totalBefore = 0, totalAfter = 0;

  try {
    for (const name of present) {
      if (REFERENCE_ONLY.has(name)) {
        const b = statSync(join(IMG, name)).size;
        totalBefore += b; totalAfter += b;
        rows.push({ name, before: b, after: b, note: 'reference — luma.mjs calibration', dims: '' });
        continue;
      }
      const r = RECIPES[name];
      if (!r) continue;
      if (ONLY && !name.includes(ONLY)) continue;

      const live = join(IMG, name);
      const before = statSync(live).size;
      const cur = probe(live);
      totalBefore += before;

      if (!FORCE && isDone(cur, r)) {
        totalAfter += before;
        rows.push({ name, before, after: before, note: 'already optimised', dims: `${cur.w}x${cur.h}` });
        continue;
      }

      const src = sourceFor(name, tmp);
      const out = join(tmp, name);
      optimise(src, out, r);
      const got = probe(out);

      // Never let a "win" that is actually a loss through. If the recipe made the file bigger,
      // the recipe is wrong for this image; say so and leave the original alone.
      if (got.bytes >= before) {
        totalAfter += before;
        // Equal bytes is the ordinary --force result: re-applying a recipe to its own output
        // reproduces it, which is the thing that makes this tool safe to re-run. Larger bytes
        // means the recipe is wrong for this image, and it should be read as a complaint.
        const note = got.bytes === before
          ? 'unchanged — recipe reproduces itself'
          : `SKIPPED — recipe would grow it to ${kb(got.bytes)} KB`;
        rows.push({ name, before, after: before, note, dims: `${cur.w}x${cur.h}` });
        continue;
      }

      if (!DRY) copyFileSync(out, live);
      totalAfter += got.bytes;
      rows.push({
        name, before, after: got.bytes, dims: `${got.w}x${got.h}`,
        note: `${r.space === 'Gray' ? 'gray' : `${got.colors}c ${r.space}`}${DRY ? '  (not written)' : ''}`,
      });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const W = Math.max(22, ...rows.map((x) => x.name.length + 1));
  process.stdout.write(`${pad('file', W)}${pad('before', 9, true)}${pad('after', 9, true)}`
    + `${pad('saved', 9, true)}   ${pad('dims', 11)}note\n`);
  process.stdout.write(`${'-'.repeat(W + 27 + 14)}\n`);
  for (const x of rows) {
    const cut = x.before === x.after ? '—' : `${(100 - (x.after / x.before) * 100).toFixed(0)}%`;
    process.stdout.write(`${pad(x.name, W)}${pad(`${kb(x.before)}K`, 9, true)}${pad(`${kb(x.after)}K`, 9, true)}`
      + `${pad(cut, 9, true)}   ${pad(x.dims, 11)}${x.note}\n`);
  }
  process.stdout.write(`${'-'.repeat(W + 27 + 14)}\n`);
  process.stdout.write(`${pad('TOTAL', W)}${pad(`${kb(totalBefore)}K`, 9, true)}${pad(`${kb(totalAfter)}K`, 9, true)}`
    + `${pad(`${(100 - (totalAfter / totalBefore) * 100).toFixed(0)}%`, 9, true)}\n`);

  const shipped = rows.filter((x) => !REFERENCE_ONLY.has(x.name));
  const sb = shipped.reduce((a, x) => a + x.before, 0);
  const sa = shipped.reduce((a, x) => a + x.after, 0);
  process.stdout.write(`${pad('  of which ships', W)}${pad(`${kb(sb)}K`, 9, true)}${pad(`${kb(sa)}K`, 9, true)}`
    + `${pad(`${(100 - (sa / sb) * 100).toFixed(0)}%`, 9, true)}   (keyart is stripped by vite)\n`);

  if (unknown.length) {
    process.stdout.write(`\nNo recipe for: ${unknown.join(', ')}\n`
      + 'Left untouched. Add an entry to RECIPES with the displayed size you measured.\n');
  }
}

main();
