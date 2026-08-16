#!/usr/bin/env node
/**
 * Generate ambience beds, hero SFX, and the adaptive score with ElevenLabs.
 *
 * DIVISION OF LABOUR — this matters, and it is deliberate:
 *
 *   ElevenLabs (this tool)          | Procedural WebAudio (src/audio/ProceduralSFX.js)
 *   -------------------------------|--------------------------------------------------
 *   Ambience beds (forest, rain,   | Anything the game must PARAMETERIZE in real time:
 *   wind, lake, fire, camp radio)  | footsteps per surface/speed/mass, carried-lumber
 *   Hero one-shots (thunder, the   | impacts scaled by velocity, creak severity swept
 *   signature creaks, wood split)  | continuously by structural load, wind noise driven
 *   Music beds and stingers        | by the live wind vector.
 *
 * The rule: if the sound must respond continuously to a game variable, synthesize it.
 * If it is a fixed event or a bed, generate it here — a real recording beats an oscillator
 * every time, and this is where the game's atmosphere actually comes from.
 *
 * Beds are generated LONG and looped with a crossfade at runtime (generated audio never
 * loops sample-accurately, so AudioEngine must crossfade — see LOOP_XFADE below).
 *
 * Usage:
 *   node tools/generate-audio.mjs                    # everything missing
 *   node tools/generate-audio.mjs --only <id>
 *   node tools/generate-audio.mjs --group sfx|bed|music
 *   node tools/generate-audio.mjs --force
 *   node tools/generate-audio.mjs --dry-run
 *
 * Output: public/audio/{bed,sfx,music}/<id>.mp3 + public/audio/manifest.json
 * The game must run perfectly with all of it deleted.
 */
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { secret, REPO_ROOT } from './lib/env.mjs';

const OUT_ROOT = join(REPO_ROOT, 'public', 'audio');

/** Seconds of crossfade AudioEngine should use when looping a bed. Baked into the manifest. */
const LOOP_XFADE = 2.0;

const SFX_URL = 'https://api.elevenlabs.io/v1/sound-generation';
const MUSIC_URL = 'https://api.elevenlabs.io/v1/music';

// ---------------------------------------------------------------------------

/** Ambience beds — long, looping, the floor the whole game stands on. */
const BEDS = [
  { id: 'forest-night-calm', seconds: 22, loop: true, influence: 0.35,
    text: 'Quiet deep pine forest at night. Distant crickets, a faint breeze in high branches, ' +
          'occasional single wood creak far away. No animals close. No music. Very low, spacious, ' +
          'natural field recording.' },
  { id: 'forest-night-tense', seconds: 22, loop: true, influence: 0.4,
    text: 'Deep pine forest at night with NO insects and no birds — unnaturally quiet. Only a ' +
          'low wind in high branches and the faint settling of trees. Empty, held, wrong. ' +
          'Field recording, no music.' },
  { id: 'wind-pines-light', seconds: 20, loop: true, influence: 0.4,
    text: 'Steady light wind moving through tall pine needles, a soft continuous hiss rising and ' +
          'falling slowly. Distant, no gusts hitting the microphone. Natural field recording.' },
  { id: 'wind-pines-gust', seconds: 18, loop: true, influence: 0.45,
    text: 'Strong gusting wind through a pine forest, branches groaning and clattering, the hiss ' +
          'surging and dying. Storm building. Natural field recording, no music.' },
  { id: 'rain-on-leaves', seconds: 20, loop: true, influence: 0.4,
    text: 'Steady rain falling on a forest canopy and undergrowth, heavy drips from leaves, ' +
          'no thunder, no wind. Close and enveloping. Natural field recording.' },
  { id: 'rain-on-tin', seconds: 18, loop: true, influence: 0.45,
    text: 'Heavy rain drumming on a corrugated tin roof, bright metallic patter with occasional ' +
          'runs of water. Recorded from underneath. No music.' },
  { id: 'lake-shore', seconds: 20, loop: true, influence: 0.35,
    text: 'Small waves lapping a gravel lake shore at night, very gentle and rhythmic, a wooden ' +
          'dock creaking softly at intervals. Open water ambience. Natural field recording.' },
  { id: 'campfire', seconds: 18, loop: true, influence: 0.4,
    text: 'A medium campfire burning steadily, crackling and popping, embers settling, no voices. ' +
          'Close microphone. Natural field recording.' },
  { id: 'camp-radio-1984', seconds: 18, loop: true, influence: 0.5,
    text: 'A small tinny transistor radio playing muffled indistinct 1980s pop music through a ' +
          'cheap speaker, heard from across a field at night, with faint AM static and drift. ' +
          'Very distant and lo-fi.' },
  { id: 'crickets-dense', seconds: 20, loop: true, influence: 0.35,
    text: 'Dense summer night crickets and katydids, a thick continuous chorus, warm and close. ' +
          'Natural field recording, no other sounds.' },
];

/** Hero one-shots. The creaks are the signature sound of the game. */
const SFX = [
  // --- THE CREAK LADDER: the game's most important sound, in four escalating tiers.
  { id: 'creak-t1', seconds: 3, influence: 0.6,
    text: 'A single short dry wood creak, small and soft, like one floorboard taking weight. ' +
          'Close microphone, no reverb, isolated.' },
  { id: 'creak-t2', seconds: 4, influence: 0.6,
    text: 'A wooden joint creaking under load, a slow rising stick-slip groan of dry timber ' +
          'about a second long. Close, isolated, no music.' },
  { id: 'creak-t3', seconds: 5, influence: 0.65,
    text: 'A large timber frame shifting and groaning under heavy load, deep and long, wood ' +
          'fibres grinding, ending in a sharp knock as it settles. Close, isolated.' },
  { id: 'creak-t4', seconds: 7, influence: 0.7,
    text: 'A huge structural groan of an entire wet timber building settling — long, low, ' +
          'agonised, rising in pitch as the load transfers, with cracking fibres, ending in a ' +
          'heavy resonant thud. Awful and slow. Close, isolated, no music.' },

  { id: 'wood-split', seconds: 3, influence: 0.7,
    text: 'A dry pine board splitting sharply along the grain with a loud crack and a tearing ' +
          'fibrous rip. Isolated, close, no reverb.' },
  { id: 'nail-pull', seconds: 3, influence: 0.65,
    text: 'A long nail being levered out of dry wood with a claw hammer, a rising squealing ' +
          'metallic creak ending in a pop. Isolated and close.' },

  // --- thunder at three distances; the delay from the flash is computed at runtime
  { id: 'thunder-near', seconds: 9, influence: 0.55,
    text: 'A very close lightning strike: a sharp cracking report followed by an enormous ' +
          'rolling boom that decays over several seconds. Outdoors, no rain.' },
  { id: 'thunder-mid', seconds: 11, influence: 0.5,
    text: 'Thunder about two kilometres away, a deep rolling rumble that swells and tumbles ' +
          'for many seconds with no sharp crack. Outdoors.' },
  { id: 'thunder-far', seconds: 12, influence: 0.45,
    text: 'Very distant thunder on the horizon, a low soft continuous rumble, almost felt more ' +
          'than heard, slowly fading. Outdoors, quiet night.' },

  // --- construction one-shots that benefit from real transients
  { id: 'lumber-drop', seconds: 3, influence: 0.6,
    text: 'A heavy wooden beam dropped onto packed dirt, a deep dull thud with a short wooden ' +
          'ring and a small bounce. Isolated, close.' },
  { id: 'lumber-stack', seconds: 3, influence: 0.6,
    text: 'Two heavy timber beams knocking together, a solid hollow wooden clack with a short ' +
          'resonant tail. Isolated, close.' },
  { id: 'hammer-wood', seconds: 2, influence: 0.65,
    text: 'A single hammer blow driving a nail into pine, a sharp percussive knock with a ' +
          'wooden body. Isolated, close, no reverb.' },
  { id: 'hammer-steel', seconds: 2, influence: 0.7,
    text: 'A steel hammer striking a galvanised steel bracket, a bright ringing metallic clang ' +
          'with a long shimmering decay. Isolated, close.' },
  { id: 'bracket-drop-rock', seconds: 2, influence: 0.65,
    text: 'A small steel bracket dropped onto granite, a bright metallic clatter bouncing twice. ' +
          'Isolated, close, outdoors.' },
  { id: 'lantern-shutter', seconds: 2, influence: 0.7,
    text: 'A thin metal lantern shutter sliding closed, a small dry mechanical scrape and click. ' +
          'Isolated, very close, quiet.' },
  { id: 'tarp-flap', seconds: 4, influence: 0.5,
    text: 'A heavy canvas tarpaulin flapping and snapping in gusting wind. Isolated, outdoors.' },
  { id: 'twig-snap', seconds: 2, influence: 0.7,
    text: 'A single dry twig snapping underfoot on a forest floor, sharp and close, followed by ' +
          'a small rustle of pine needles. Isolated.' },
];

/**
 * Score beds. Music.js crossfades between these by tension and layers the procedural
 * synth on top, so each must be a LOOPABLE BED with no strong melodic hook that would
 * become obvious on repetition.
 */
const MUSIC = [
  { id: 'music-title', ms: 60000,
    prompt: 'Sparse, patient 1984 analog horror score for a title screen. A single detuned ' +
            'Prophet-5 style pad on an open fifth, very slow filter sweep, a distant prepared ' +
            'piano note every eight bars. Minor with a flattened second. No drums, no melody, ' +
            'no build. Cold, clinical, beautiful, wrong. Loopable, consistent throughout.' },
  { id: 'music-work', ms: 90000,
    prompt: 'Quiet, oddly domestic 1984 analog synth music for patient manual labour at night. ' +
            'A gentle repeating arpeggio on a warm detuned analog synth, a soft low pad, a ' +
            'prepared piano with felt-damped notes. Almost pleasant. Steady, unhurried, ' +
            'hypnotic, no percussion, no melody line, no development. Loopable and uniform.' },
  { id: 'music-tension', ms: 75000,
    prompt: 'Slowly rising 1984 analog synth dread. Low sustained sub-bass, bowed metal drones ' +
            'beating against each other, a detuned string holding one note. Minor with a ' +
            'flattened second. No percussion, no melody, no resolution. Uniform intensity ' +
            'throughout so it can loop. Claustrophobic.' },
  { id: 'music-hunt', ms: 60000,
    prompt: 'Urgent 1984 analog synth horror chase music. Fast pulsing sixteenth-note bass ' +
            'sequence on a hard detuned analog synth, harsh filtered stabs, metallic percussion ' +
            'hits. Driving and mechanical, not orchestral. Minor, relentless, uniform intensity ' +
            'so it loops. No vocals.' },
  { id: 'music-dawn', ms: 50000,
    prompt: 'Exhausted, quiet 1984 analog synth resolution at first light. A single warm pad ' +
            'slowly opening, a lone prepared piano figure, faint tape hiss. Relieved but hollow ' +
            'and unresolved. Very slow, no percussion, no crescendo.' },
  { id: 'music-night7', ms: 75000,
    prompt: 'Bleak 1984 analog synth score with all the comedy drained out. Very low sustained ' +
            'drone, a detuned string bending microtonally, bowed metal, occasional deep piano ' +
            'strike with a reversed tail. Grieving and final. No percussion, no melody, ' +
            'no relief. Uniform, loopable.' },
];

// --------------------------------------------------------------------------- http

async function post(url, apiKey, body, label) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) return Buffer.from(await res.arrayBuffer());

      const text = await res.text();
      if (res.status < 500 && res.status !== 429) {
        let msg = text.slice(0, 240);
        try { msg = JSON.parse(text).detail?.message ?? JSON.parse(text).detail ?? msg; } catch { /* raw */ }
        throw new Error(`HTTP ${res.status} — ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
      }
      console.warn(`retry  ${label}: HTTP ${res.status} (${attempt}/4)`);
    } catch (e) {
      if (e.message.startsWith('HTTP')) throw e;
      if (attempt === 4) throw new Error(`transport failed: ${e.cause?.code ?? e.message}`);
      console.warn(`retry  ${label}: ${e.cause?.code ?? e.message} (${attempt}/4)`);
    }
    await new Promise((r) => setTimeout(r, 2500 * attempt));
  }
  throw new Error('unreachable');
}

// --------------------------------------------------------------------------- main

async function main() {
  const argv = process.argv.slice(2);
  const arg = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
  const force = argv.includes('--force');
  const dryRun = argv.includes('--dry-run');
  const only = arg('--only');
  const group = arg('--group');

  const jobs = [
    ...BEDS.map((b) => ({ ...b, group: 'bed', dir: 'bed' })),
    ...SFX.map((s) => ({ ...s, group: 'sfx', dir: 'sfx' })),
    ...MUSIC.map((m) => ({ ...m, group: 'music', dir: 'music' })),
  ].filter((j) => (!group || j.group === group) && (!only || j.id === only));

  if (!jobs.length) { console.error('nothing selected'); process.exit(1); }

  const audioSecs = jobs.reduce((n, j) => n + (j.seconds ?? j.ms / 1000), 0);
  console.log(`${jobs.length} assets selected, ~${Math.round(audioSecs)}s of audio.`);
  if (dryRun) {
    for (const j of jobs) console.log(`  ${j.group.padEnd(6)} ${j.id}`);
    console.log('dry run — no API calls made.');
    return;
  }

  const apiKey = secret('ELEVEN');
  const manifest = { generated: true, loopCrossfadeSeconds: LOOP_XFADE, beds: [], sfx: [], music: [] };
  const tally = { ok: 0, skipped: 0, failed: 0 };

  for (const j of jobs) {
    const dir = join(OUT_ROOT, j.dir);
    mkdirSync(dir, { recursive: true });
    const outPath = join(dir, `${j.id}.mp3`);

    const record = (bytes) => {
      const entry = { id: j.id, file: `audio/${j.dir}/${j.id}.mp3`, bytes,
                      seconds: j.seconds ?? j.ms / 1000, loop: !!j.loop };
      manifest[j.group === 'bed' ? 'beds' : j.group].push(entry);
    };

    if (existsSync(outPath) && !force) {
      tally.skipped++; record(statSync(outPath).size); continue;
    }

    const t0 = Date.now();
    try {
      const buf = j.group === 'music'
        ? await post(MUSIC_URL, apiKey, { prompt: j.prompt, music_length_ms: j.ms }, j.id)
        : await post(SFX_URL, apiKey,
            { text: j.text, duration_seconds: j.seconds, prompt_influence: j.influence ?? 0.5 }, j.id);

      // A tiny response is an error page, not audio.
      if (buf.length < 2000) throw new Error(`suspiciously small response (${buf.length}B)`);

      writeFileSync(outPath, buf);
      record(buf.length);
      tally.ok++;
      console.log(`ok     ${j.group.padEnd(6)} ${j.id.padEnd(22)} ${(buf.length / 1024).toFixed(0)}KB  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      tally.failed++;
      console.error(`FAIL   ${j.group.padEnd(6)} ${j.id}: ${e.message}`);
    }

    await new Promise((r) => setTimeout(r, 400));
  }

  // Merge with any existing manifest so partial runs don't drop previously-generated entries.
  const manifestPath = join(OUT_ROOT, 'manifest.json');
  if (existsSync(manifestPath) && (only || group)) {
    try {
      const prev = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(manifestPath, 'utf8')));
      for (const k of ['beds', 'sfx', 'music']) {
        const have = new Set(manifest[k].map((e) => e.id));
        for (const e of prev[k] ?? []) if (!have.has(e.id)) manifest[k].push(e);
      }
    } catch { /* regenerate from scratch */ }
  }
  for (const k of ['beds', 'sfx', 'music']) manifest[k].sort((a, b) => a.id.localeCompare(b.id));

  mkdirSync(OUT_ROOT, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\ndone — ${tally.ok} generated, ${tally.skipped} skipped, ${tally.failed} failed`);
  console.log(`manifest: ${manifest.beds.length} beds, ${manifest.sfx.length} sfx, ${manifest.music.length} music`);
  process.exit(tally.failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
