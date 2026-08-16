#!/usr/bin/env node
/**
 * Generate the camper voice bank with ElevenLabs.
 *
 * DESIGN CONSTRAINT (from the creator, and it governs everything here):
 * "Voice should be an atmosphere addition, in 3d space, not a key star of the game."
 *
 * So these are not performances. They are overheard fragments — banal, half-finished,
 * interrupted. They get placed in world space by src/audio/VoiceBank.js and are usually
 * distance-filtered to the edge of intelligibility. The scary part is not catching the words.
 *
 * That has two consequences for generation:
 *   - Record DRY and NEUTRAL. All distance, occlusion, and reverb happen at runtime.
 *     Any drama baked in here fights the 3D mix and makes lines pop out of the world.
 *   - Higher `stability` than you would use for a lead performance, because a line that will
 *     be heard at 40m through trees must not wobble — wobble reads as artifact, not acting.
 *
 * Lines come from src/story/Script.js (Script.voiceLines), which is transcribed from STORY.md.
 *
 * Usage:
 *   node tools/generate-voices.mjs                 # generate everything missing
 *   node tools/generate-voices.mjs --force         # regenerate all
 *   node tools/generate-voices.mjs --only <id>     # one line
 *   node tools/generate-voices.mjs --speaker <id>  # one camper
 *   node tools/generate-voices.mjs --dry-run       # cost estimate only, no API calls
 *
 * Output: public/audio/vo/<line id>.mp3  +  public/audio/vo/manifest.json
 * The game must run perfectly with this entire folder deleted.
 */
import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { secret, REPO_ROOT } from './lib/env.mjs';

const OUT_DIR = join(REPO_ROOT, 'public', 'audio', 'vo');
const SCRIPT_PATH = join(REPO_ROOT, 'src', 'story', 'Script.js');
const MODEL = 'eleven_multilingual_v2';
const FORMAT = 'mp3_44100_128';

/**
 * Camper -> ElevenLabs voice. Keyed by the `id` (or lowercased `name`) in Script.campers.
 * Chosen for silhouette-in-audio: each must be identifiable from three muffled words at 30m.
 * Falls back to positional assignment for any speaker not listed.
 */
const VOICE_BY_SPEAKER = {
  // Cast against the characterizations in Script.campers. Do not let this fall through to the
  // positional fallback — it previously gave Teddy (a 16-year-old boy) a woman's voice and Bev
  // (a 58-year-old woman) a man's.
  robin: 'EXAVITQu4vr4xnSDxMaL',  // Sarah — young F, grounded and unperformed. Robin is 19,
                                  // a boatyard kid; she states technical fact flatly. Never scared-sounding.
  marg:  'FGY2WhTYpPnrIDTdsKH5',  // Laura — young F, bright and forward. Marg runs the dock
                                  // like a small navy and narrates her own logistics.
  coop:  'TX3LPaxmHKxFdv7VOQHJ',  // Liam — young M, energetic and carrying. Coop is the one
                                  // doing bits; his voice has to project across the camp.
  teddy: 'bIHbv24MWmeRgasZH58o',  // Will — young M, soft and low-key. Teddy is 16 and
                                  // homesick; his voice explicitly "does not carry."
  dale:  'CwhRBWXzGAHq8TQ4Fs17',  // Roger — older M, laid-back and resonant. Dale is 27, warm,
                                  // a half-beat behind, two drinks in from nine o'clock.
  bev:   'XrExE9yKIg1WjnnlVkGX',  // Matilda — middle-aged F, authoritative. Bev is 58 and has
                                  // absolute authority at zero volume. She never raises it.
};

const FALLBACK_VOICES = [
  'EXAVITQu4vr4xnSDxMaL', 'TX3LPaxmHKxFdv7VOQHJ', 'FGY2WhTYpPnrIDTdsKH5',
  'bIHbv24MWmeRgasZH58o', 'cgSgspJ2msm6clMCkdW9', 'N2lVS1w4EtoT3dr4eOWO',
];

/**
 * Per-category voice settings. Atmosphere first: stability stays high so distant playback
 * stays clean. `style` is kept low deliberately — expressive delivery draws the ear, and
 * drawing the ear is exactly what this VO must not do.
 */
const CATEGORY_SETTINGS = {
  idle:       { stability: 0.62, similarity_boost: 0.80, style: 0.10 },
  call:       { stability: 0.55, similarity_boost: 0.78, style: 0.28 },  // shouted across camp
  campfire:   { stability: 0.66, similarity_boost: 0.82, style: 0.14 },
  argue:      { stability: 0.48, similarity_boost: 0.76, style: 0.34 },
  heard:      { stability: 0.58, similarity_boost: 0.80, style: 0.22 },  // "did you hear that"
  search:     { stability: 0.56, similarity_boost: 0.80, style: 0.20 },
  falsealarm: { stability: 0.60, similarity_boost: 0.80, style: 0.16 },
  evidence:   { stability: 0.52, similarity_boost: 0.78, style: 0.26 },
  fear:       { stability: 0.42, similarity_boost: 0.74, style: 0.40 },
  late:       { stability: 0.38, similarity_boost: 0.72, style: 0.45 },
  default:    { stability: 0.60, similarity_boost: 0.80, style: 0.15 },
};

// --------------------------------------------------------------------------- script load

async function loadLines() {
  if (!existsSync(SCRIPT_PATH)) {
    throw new Error(`${SCRIPT_PATH} does not exist yet — the Story agent has not written it.`);
  }
  const mod = await import(pathToFileURL(SCRIPT_PATH).href);
  const Script = mod.Script ?? mod.default;
  const lines = Script?.voiceLines;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error('Script.voiceLines is empty — nothing to generate.');
  }
  return { lines, campers: Script.campers ?? [] };
}

function voiceFor(speaker, campers) {
  if (!speaker) return FALLBACK_VOICES[0];
  const key = String(speaker).toLowerCase().trim();

  // Explicit override in the story data always wins.
  const camper = campers.find(
    (c) => String(c.id).toLowerCase() === key || String(c.name).toLowerCase() === key,
  );
  if (camper?.elevenVoiceId) return camper.elevenVoiceId;

  if (VOICE_BY_SPEAKER[key]) return VOICE_BY_SPEAKER[key];

  // Stable positional fallback — same speaker always maps to the same voice.
  const idx = campers.findIndex(
    (c) => String(c.id).toLowerCase() === key || String(c.name).toLowerCase() === key,
  );
  if (idx >= 0) return FALLBACK_VOICES[idx % FALLBACK_VOICES.length];

  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return FALLBACK_VOICES[h % FALLBACK_VOICES.length];
}

// --------------------------------------------------------------------------- generation

async function synth(line, apiKey, campers) {
  const voiceId = voiceFor(line.speaker, campers);
  const base = CATEGORY_SETTINGS[line.category] ?? CATEGORY_SETTINGS.default;

  const settings = {
    stability: line.stability ?? base.stability,
    similarity_boost: line.similarity ?? base.similarity_boost,
    style: line.style ?? base.style,
    use_speaker_boost: true,
  };

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${FORMAT}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: line.text, model_id: MODEL, voice_settings: settings }),
  });

  if (!res.ok) {
    const body = await res.text();
    let msg = body.slice(0, 240);
    try { msg = JSON.parse(body).detail?.message ?? msg; } catch { /* raw */ }
    throw new Error(`HTTP ${res.status} — ${msg}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
  const force = argv.includes('--force');
  const dryRun = argv.includes('--dry-run');
  const only = arg('--only');
  const speaker = arg('--speaker');

  const { lines, campers } = await loadLines();

  let targets = lines;
  if (only) targets = targets.filter((l) => l.id === only);
  if (speaker) {
    targets = targets.filter((l) => String(l.speaker).toLowerCase() === speaker.toLowerCase());
  }

  const chars = targets.reduce((n, l) => n + (l.text?.length ?? 0), 0);
  console.log(`${lines.length} lines in Script.voiceLines; ${targets.length} selected; ${chars} characters.`);

  if (dryRun) {
    const bySpeaker = {};
    for (const l of targets) bySpeaker[l.speaker] = (bySpeaker[l.speaker] ?? 0) + 1;
    console.log('by speaker:', bySpeaker);
    console.log(`voice mapping: ${[...new Set(targets.map(l => `${l.speaker}->${voiceFor(l.speaker, campers)}`))].join(', ')}`);
    console.log('dry run — no API calls made.');
    return;
  }

  const apiKey = secret('ELEVEN');
  mkdirSync(OUT_DIR, { recursive: true });

  const manifest = [];
  const tally = { ok: 0, skipped: 0, failed: 0 };

  for (const line of targets) {
    const outPath = join(OUT_DIR, `${line.id}.mp3`);

    if (existsSync(outPath) && !force) {
      tally.skipped++;
      manifest.push({ id: line.id, speaker: line.speaker, category: line.category,
                      text: line.text, bytes: statSync(outPath).size });
      continue;
    }

    try {
      const buf = await synth(line, apiKey, campers);
      writeFileSync(outPath, buf);
      tally.ok++;
      manifest.push({ id: line.id, speaker: line.speaker, category: line.category,
                      text: line.text, bytes: buf.length });
      console.log(`ok     ${line.id.padEnd(28)} ${String(line.speaker).padEnd(10)} ${(buf.length / 1024).toFixed(0)}KB  "${line.text.slice(0, 46)}"`);
    } catch (e) {
      tally.failed++;
      console.error(`FAIL   ${line.id}: ${e.message}`);
    }

    // ElevenLabs rate-limits concurrent requests on Creator; stay serial and polite.
    await new Promise((r) => setTimeout(r, 220));
  }

  // Rebuild the manifest from disk so it always reflects reality, not just this run.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith('.mp3'));
  const byId = new Map(manifest.map((m) => [m.id, m]));
  for (const f of onDisk) {
    const id = f.replace(/\.mp3$/, '');
    if (!byId.has(id)) {
      const l = lines.find((x) => x.id === id);
      byId.set(id, { id, speaker: l?.speaker ?? 'unknown', category: l?.category ?? 'idle',
                     text: l?.text ?? '', bytes: statSync(join(OUT_DIR, f)).size });
    }
  }

  writeFileSync(
    join(OUT_DIR, 'manifest.json'),
    JSON.stringify({ generated: true, model: MODEL, format: FORMAT,
                     lines: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)) }, null, 2),
  );

  console.log(`\ndone — ${tally.ok} generated, ${tally.skipped} skipped, ${tally.failed} failed`);
  console.log(`manifest: ${byId.size} lines in public/audio/vo/`);
  process.exit(tally.failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
