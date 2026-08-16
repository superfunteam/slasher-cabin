#!/usr/bin/env node
/**
 * Repo health check. Run this constantly while modules are being authored in parallel.
 *
 * Catches the specific failure modes that show up when many agents write large files:
 *   - syntax errors (including tool-call markup like </content> leaking into the source)
 *   - TRUNCATION: a file that parses fine but is missing methods its contract promises,
 *     which is far more dangerous than a syntax error because everything still "works"
 *     until the missing method is called at runtime
 *   - contract violations: console.log, Math.random(), missing dispose()
 *   - the module failing to transform through Vite
 *
 * Usage: node tools/check.mjs [--vite] [--json]
 *   --vite  also fetch each module from the dev server (must be running) to catch
 *           import-resolution errors that a local parse cannot see
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { REPO_ROOT } from './lib/env.mjs';

const SRC = join(REPO_ROOT, 'src');
const DEV_SERVER = 'http://127.0.0.1:5173';

/**
 * The public API each module must expose, from ARCHITECTURE.md.
 * A module that parses but lacks these is truncated or faked.
 */
const REQUIRED_API = {
  'world/Terrain.js': ['heightAt', 'normalAt', 'surfaceAt', 'slopeAt', 'isWater', 'getSpawnCandidates'],
  'gameplay/Physics.js': ['raycast', 'moveCapsule', 'lineOfSight', 'addCollider', 'overlapSphere'],
  'gameplay/Player.js': ['position', 'velocity', 'isCrouched'],
  'gameplay/Navmesh.js': ['findPath', 'nearestNode', 'randomPatrolTarget', 'isWalkable'],
  'gameplay/NoiseSystem.js': ['audibilityAt', 'recentNoises'],
  'gameplay/Campers.js': ['agents', 'suspicion'],
  'gameplay/BuildSystem.js': ['heldPart', 'progress'],
  'gameplay/Blueprint.js': ['forNight', 'renderPanel'],
  'world/CabinSite.js': ['slots', 'slotWorldTransform', 'setInstalled', 'showGhost', 'partMesh'],
  'render/Textures.js': ['get'],
  'render/Materials.js': ['get', 'globalUniforms'],
  'render/Postprocessing.js': ['render'],
  'render/Sky.js': ['moonDirection', 'flash'],
  'render/VolumetricFog.js': ['target'],
  'audio/AudioEngine.js': ['play', 'setBusVolume'],
  'audio/VoiceBank.js': ['say', 'available'],
  'ui/HUD.js': ['toast', 'subtitle'],
  'ui/BlueprintUI.js': ['open', 'close', 'toggle'],
  'ui/Menu.js': ['showTitle', 'showNightEnd'],
};

/** Markup that must never appear in a source file. */
const LEAKED_MARKUP = /<\/(content|invoke|function_calls|antml:parameter|parameter)>|^</m;

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * Syntax check via `node --check --input-type=module`, which uses V8's own parser and
 * understands real ESM (including `import * as X`). Hand-rolled import stripping produced
 * false positives, so don't do that.
 */
function parseCheck(src) {
  const r = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: src, encoding: 'utf8',
  });
  if (r.status === 0) return null;
  const err = (r.stderr || '').split('\n');
  const line = err.find((l) => /SyntaxError/.test(l)) ?? err[0] ?? 'parse failed';
  const loc = err.find((l) => /^\[stdin\]:\d+/.test(l));
  return loc ? `${line.replace(/^SyntaxError:\s*/, '')} (${loc.trim()})` : line;
}

async function main() {
  const argv = process.argv.slice(2);
  const withVite = argv.includes('--vite');
  const asJson = argv.includes('--json');

  const files = walk(SRC).sort();
  const problems = [];

  for (const abs of files) {
    const rel = relative(SRC, abs).replace(/\\/g, '/');
    const src = readFileSync(abs, 'utf8');
    const lines = src.split('\n').length;
    const add = (severity, kind, detail) => problems.push({ file: `src/${rel}`, severity, kind, detail });

    if (LEAKED_MARKUP.test(src)) {
      const m = src.match(LEAKED_MARKUP);
      add('fatal', 'leaked-markup', `tool markup "${m[0].trim()}" in source — the write was truncated`);
    }

    const syntaxErr = parseCheck(src);
    if (syntaxErr) add('fatal', 'syntax', syntaxErr);

    const isStub = /STATUS: STUB/.test(src);
    if (isStub) { add('info', 'stub', `${lines} lines — not yet implemented`); continue; }

    // Truncation detection: contract methods that never appear.
    const required = REQUIRED_API[rel];
    if (required) {
      const missing = required.filter((m) => {
        const re = new RegExp(`(^|[^\\w.])(${m})\\s*[(=:]|\\bget\\s+${m}\\b|this\\.${m}\\s*=`, 'm');
        return !re.test(src);
      });
      if (missing.length) {
        add('fatal', 'truncated', `missing contract API: ${missing.join(', ')}`);
      }
    }

    // Contract hygiene.
    const consoleHits = rel === 'core/Log.js' ? 0 : (src.match(/(^|[^.\w])console\.(log|warn|error|info|debug)\s*\(/gm) || []).length;
    if (consoleHits) add('warn', 'console', `${consoleHits} console.* call(s) — use Log from core/Log.js`);

    const randHits = (src.match(/Math\.random\s*\(/g) || []).length;
    if (randHits) add('warn', 'math-random', `${randHits} Math.random() call(s) — breaks determinism, use core/Rand.js`);

    if (/export\s+class\s+\w+/.test(src) && !/\bdispose\s*\(/.test(src)) {
      add('warn', 'no-dispose', 'exports a class but has no dispose()');
    }

    // A file that is suspiciously short for a real implementation.
    if (!isStub && lines < 60 && /export\s+class/.test(src)) {
      add('warn', 'thin', `only ${lines} lines — likely incomplete`);
    }
  }

  if (withVite) {
    for (const abs of files) {
      const rel = relative(REPO_ROOT, abs).replace(/\\/g, '/');
      try {
        const res = await fetch(`${DEV_SERVER}/${rel}`);
        if (!res.ok) {
          problems.push({ file: rel, severity: 'fatal', kind: 'vite',
                          detail: `dev server returned ${res.status}` });
        }
      } catch {
        problems.push({ file: rel, severity: 'warn', kind: 'vite',
                        detail: 'dev server unreachable' });
        break;
      }
    }
  }

  if (asJson) { console.log(JSON.stringify(problems, null, 2)); }
  else {
    const order = { fatal: 0, warn: 1, info: 2 };
    problems.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file));
    const icon = { fatal: 'FATAL', warn: 'warn ', info: 'stub ' };
    for (const p of problems) {
      if (p.severity === 'info') continue;
      console.log(`${icon[p.severity]}  ${p.file.padEnd(34)} ${p.kind.padEnd(15)} ${p.detail}`);
    }
    const f = problems.filter((p) => p.severity === 'fatal').length;
    const w = problems.filter((p) => p.severity === 'warn').length;
    const s = problems.filter((p) => p.severity === 'info').length;
    console.log(`\n${files.length} files — ${f} fatal, ${w} warnings, ${s} still stubs`);
  }

  process.exit(problems.some((p) => p.severity === 'fatal') ? 1 : 0);
}

main();
