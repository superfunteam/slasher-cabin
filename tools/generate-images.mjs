#!/usr/bin/env node
/**
 * Generate the game's raster art with GPT Image 2.
 *
 * The 3D world is 100% procedural by design (ARCHITECTURE.md §1). This tool covers the
 * places where a generative image model genuinely beats procedural code:
 *   - the title treatment and manual cover (one-off illustration)
 *   - grunge/stain/decal OVERLAYS that composite over procedural PBR (tiling doesn't matter
 *     for a decal, so the model's weakness is irrelevant and its detail is a real win)
 *   - the night title cards
 *   - the favicon / social card
 *
 * It deliberately does NOT generate tiling PBR materials — gpt-image-2 cannot guarantee
 * seamlessness, and a visible tile seam is worse than good procedural noise.
 *
 * Usage:  node tools/generate-images.mjs [--only <id>] [--force] [--size 1024x1024]
 * Output: public/img/<id>.png   (committed; the game degrades gracefully if absent)
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { secret, REPO_ROOT } from './lib/env.mjs';

const OUT_DIR = join(REPO_ROOT, 'public', 'img');
const MODEL = 'gpt-image-2';

/** Shared style spine so every image reads as one art department. */
const MANUAL_STYLE =
  'Scandinavian technical assembly-manual illustration, 1984. Warm off-white paper background ' +
  'exactly #f4f1e8. Ink is near-black #16181a. Exactly one accent colour, a signal red #d92b2b, ' +
  'used sparingly. Thin, precise, uniform-weight line art. Flat vector, absolutely no shading, ' +
  'no gradients, no texture, no drop shadows. Clinical, deadpan, unemotional. ' +
  'CRITICAL: contains no text, no letters, no numbers, no words, no logos, no signatures.';

const HORROR_STYLE =
  'Cinematic horror photography, 1984 summer camp in dense Pacific Northwest pine forest at ' +
  'night. Desaturated blue-green palette, deep crushed blacks, moonlight key at #7d95c4. ' +
  'Heavy volumetric fog, wet surfaces, anamorphic lens character, 35mm film grain. ' +
  'The only warm light is human — sodium and firelight at #ff9d4a. ' +
  'No people visible. No text, no letters, no words, no logos.';

const IMAGES = [
  {
    id: 'manual-cover',
    size: '1024x1536',
    prompt:
      `${MANUAL_STYLE} An assembly manual cover for a small timber cabin. A large isometric ` +
      `exploded-view diagram: the cabin's parts float apart along their assembly axes — sill ` +
      `beams, floor joists, wall studs, roof trusses, corrugated roof panels — connected by thin ` +
      `dashed leader lines showing where each part goes. In the lower corner, a small ` +
      `round-shouldered wordless mascot figure with two dots for a face and no mouth stands ` +
      `holding a claw hammer, viewed straight on. Generous white space. Centred composition.`,
  },
  {
    id: 'mascot-sheet',
    size: '1536x1024',
    prompt:
      `${MANUAL_STYLE} A character reference sheet showing the SAME small round-shouldered ` +
      `wordless mascot figure in eight poses, arranged in a neat two-row grid on plain paper. ` +
      `The figure has two dots for a face, no mouth, sloped shoulders, simple mitten hands. ` +
      `Poses: standing with a hammer; kneeling to tighten a bolt; holding a beam over one ` +
      `shoulder; scratching its head, puzzled; giving a single thumbs up; holding a finger up ` +
      `for silence; carrying a long plank that bends; standing very still, arms at its sides, ` +
      `facing the viewer. Identical construction and proportions in every pose.`,
  },
  {
    id: 'title-treatment',
    size: '1536x1024',
    prompt:
      `${MANUAL_STYLE} A stark title-card composition, no text: centred on the page is a single ` +
      `thin-line isometric drawing of a finished small cabin with a corrugated roof and one ` +
      `door. Below it, a horizontal row of six small hardware call-out circles containing ` +
      `drawings of: a carriage bolt, a joist hanger bracket, a wood screw, a washer, an Allen ` +
      `key, and a claw hammer. A single red horizontal rule separates the cabin from the ` +
      `hardware row. Vast empty margins. Severe, balanced, catalogue-like.`,
  },
  {
    id: 'hardware-plate',
    size: '1536x1024',
    prompt:
      `${MANUAL_STYLE} A hardware inventory plate: a neat grid of twenty small isometric ` +
      `line drawings of construction fasteners and tools, each inside a thin circle, evenly ` +
      `spaced with generous gutters. Items: carriage bolt, hex bolt, lag screw, wood screw, ` +
      `washer, lock washer, hex nut, wing nut, joist hanger, hurricane tie, corner brace, ` +
      `flat mending plate, framing nail, roofing nail, claw hammer, hand saw, chisel, ` +
      `spirit level, carpenter's square, adjustable wrench. Clean, uniform, catalogue-precise.`,
  },
  {
    id: 'decal-grunge-01',
    size: '1024x1024',
    prompt:
      'A flat overhead photograph of dark organic grime, water staining and mildew on a pale ' +
      'neutral grey surface, evenly lit with no directional shadow. High detail, irregular ' +
      'organic edges, varied density from near-black to faint. Fills the entire frame edge to ' +
      'edge. Documentary reference photograph. No text, no objects, no people.',
  },
  {
    id: 'decal-rust-01',
    size: '1024x1024',
    prompt:
      'A flat overhead photograph of heavy orange-brown rust bleeding and flaking across a pale ' +
      'neutral grey surface, evenly lit with no directional shadow. Layered scale, pitting, and ' +
      'thin run-off streaks. Fills the entire frame edge to edge. Documentary reference ' +
      'photograph. No text, no objects, no people.',
  },
  {
    id: 'decal-moss-01',
    size: '1024x1024',
    prompt:
      'A flat overhead photograph of clumped forest moss and lichen on a pale neutral grey ' +
      'surface, evenly lit with no directional shadow. Colour varies from yellow-green to ' +
      'blue-green. Soft irregular clumps with thinning ragged edges. Fills the entire frame ' +
      'edge to edge. Documentary reference photograph. No text, no objects, no people.',
  },
  {
    id: 'keyart-lake',
    size: '1536x1024',
    prompt:
      `${HORROR_STYLE} Wide establishing shot across a black still lake at night toward a dark ` +
      `treeline. A single small warm-lit window glows in the distance among the trees. Low mist ` +
      `sits on the water. A wooden dock enters the frame from the lower left. Moonlight rims ` +
      `the clouds. Empty, patient, beautiful, wrong.`,
  },
  {
    id: 'keyart-site',
    size: '1536x1024',
    prompt:
      `${HORROR_STYLE} A small cleared shelf of ground deep in the forest at night, seen from ` +
      `low and close. A half-built timber frame stands in the clearing: sill beams and floor ` +
      `joists complete, four wall studs upright, nothing else. Neatly stacked dimensional ` +
      `lumber and a sawhorse sit beside it. A kerosene lantern hangs from a nail on one stud, ` +
      `throwing a small warm pool of amber light and enormous shadows up into the pines. ` +
      `Rain falls through the lantern beam. Absolutely no people.`,
  },
];

// --------------------------------------------------------------------------- runner

async function generate(img, apiKey, { size, force }) {
  const outPath = join(OUT_DIR, `${img.id}.png`);
  if (existsSync(outPath) && !force) {
    console.log(`skip   ${img.id} (exists — pass --force to regenerate)`);
    return 'skipped';
  }

  const body = {
    model: MODEL,
    prompt: img.prompt,
    size: size || img.size || '1024x1024',
    quality: 'high',
    n: 1,
  };

  const t0 = Date.now();

  // These requests run 30-120s and the connection drops often enough to matter.
  // Retry transport failures and 5xx/429 with backoff; fail fast on 4xx (a bad prompt
  // will not become good by asking again).
  let res, text;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      res = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      text = await res.text();
      if (res.ok) break;
      if (res.status < 500 && res.status !== 429) break;   // real rejection
      console.warn(`retry  ${img.id}: HTTP ${res.status} (attempt ${attempt}/4)`);
    } catch (e) {
      const cause = e.cause?.code ?? e.cause?.message ?? e.message;
      if (attempt === 4) throw new Error(`transport failed after 4 attempts: ${cause}`);
      console.warn(`retry  ${img.id}: ${cause} (attempt ${attempt}/4)`);
      res = null;
    }
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }

  if (!res) throw new Error('no response after retries');
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text).error?.message ?? msg; } catch { /* keep raw */ }
    console.error(`FAIL   ${img.id}: HTTP ${res.status} — ${msg}`);
    return 'failed';
  }

  let json;
  try { json = JSON.parse(text); }
  catch { console.error(`FAIL   ${img.id}: unparseable response`); return 'failed'; }

  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) {
    console.error(`FAIL   ${img.id}: no image in response`);
    return 'failed';
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const buf = Buffer.from(b64, 'base64');
  writeFileSync(outPath, buf);
  console.log(`ok     ${img.id}  ${(buf.length / 1024).toFixed(0)}KB  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return 'ok';
}

async function main() {
  const argv = process.argv.slice(2);
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
  const size = argv.includes('--size') ? argv[argv.indexOf('--size') + 1] : null;
  const force = argv.includes('--force');

  const apiKey = secret('GPTIMAGE');
  const targets = only ? IMAGES.filter((i) => i.id === only) : IMAGES;

  if (!targets.length) {
    console.error(`No image matches --only ${only}. Known ids: ${IMAGES.map(i => i.id).join(', ')}`);
    process.exit(1);
  }

  console.log(`Generating ${targets.length} image(s) with ${MODEL}...`);
  const tally = { ok: 0, skipped: 0, failed: 0 };

  // Serial on purpose: image models rate-limit hard, and this runs rarely.
  for (const img of targets) {
    try {
      tally[await generate(img, apiKey, { size, force })]++;
    } catch (e) {
      console.error(`FAIL   ${img.id}: ${e.message}`);
      tally.failed++;
    }
  }

  console.log(`\ndone — ${tally.ok} generated, ${tally.skipped} skipped, ${tally.failed} failed`);
  process.exit(tally.failed > 0 ? 1 : 0);
}

main();
