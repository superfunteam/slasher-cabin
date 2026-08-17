/**
 * Secret loading for the asset generation tools.
 *
 * Resolution order:
 *   1. process.env (CI — GitHub Actions injects repo secrets; Netlify injects site env)
 *   2. ./.env at the repo root (local dev cache, gitignored)
 *   3. `netlify env:get NAME` (slow, but always correct if the site is linked)
 *
 * Never log a key. Never write one into a committed file.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let dotenv = null;
function loadDotenv() {
  if (dotenv) return dotenv;
  dotenv = {};
  const p = join(ROOT, '.env');
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) dotenv[m[1]] = m[2].trim();
    }
  }
  return dotenv;
}

export function secret(name, { required = true } = {}) {
  if (process.env[name]) return process.env[name].trim();

  const d = loadDotenv();
  if (d[name]) return d[name];

  try {
    const out = execFileSync('netlify', ['env:get', name], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000,
    });
    const val = out.trim().split('\n').pop().trim();
    if (val && !val.includes(' ')) return val;
  } catch { /* not linked, not installed, or not authed */ }

  if (required) {
    throw new Error(
      `Missing secret ${name}. Provide it via the environment, a .env file at the repo root, ` +
      `or link the Netlify site (netlify link --name slasher-cabin).`,
    );
  }
  return null;
}

export const REPO_ROOT = ROOT;
