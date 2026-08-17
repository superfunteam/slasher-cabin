#!/usr/bin/env node
/**
 * Frame luminance histogram, in the SAME space ART_DIRECTION.md and
 * Postprocessing.assertLuma() are written in: sRGB byte -> LINEAR -> Rec.709 Y.
 *
 * CALIBRATION IS MANDATORY. Two separate instrumentation bugs produced confident, precise,
 * completely wrong numbers on this project — a capture harness that read cold frames, and a
 * luma metric computed on sRGB bytes without linearizing (which inverted the sign of the
 * error). So this tool refuses to report on anything until it reproduces the known reference:
 *
 *     keyart-site.png  ->  meanY 0.0218,  79.77% of pixels below Y 0.02
 *
 * If that check fails, every other number here is worthless and it says so.
 *
 * Usage: node luma.mjs <file.png> [more.png ...]
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

/** Decode a PNG to raw RGBA via macOS sips (no npm deps). */
function decode(path) {
  const tmp = `/tmp/_luma_${process.pid}.tiff`;
  execFileSync('sips', ['-s', 'format', 'tiff', path, '--out', tmp], { stdio: 'ignore' });
  const buf = readFileSync(tmp);
  // Minimal TIFF walk: find StripOffsets/width/height from the IFD.
  const le = buf.readUInt16LE(0) === 0x4949;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  let ifd = u32(4);
  const n = u16(ifd);
  let w = 0, h = 0, spp = 3, offs = [], counts = [], bps = 8;
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
    const valOff = e + 8;
    const readVals = () => {
      const out = [];
      const sz = type === 3 ? 2 : 4;
      const base = cnt * sz <= 4 ? valOff : u32(valOff);
      for (let k = 0; k < cnt; k++) out.push(type === 3 ? u16(base + k * 2) : u32(base + k * 4));
      return out;
    };
    if (tag === 256) w = readVals()[0];
    else if (tag === 257) h = readVals()[0];
    else if (tag === 258) bps = readVals()[0];
    else if (tag === 277) spp = readVals()[0];
    else if (tag === 273) offs = readVals();
    else if (tag === 279) counts = readVals();
  }
  if (bps !== 8) throw new Error(`unsupported bps ${bps}`);
  const px = Buffer.concat(offs.map((o, i) => buf.subarray(o, o + counts[i])));
  return { w, h, spp, px };
}

const s2l = (c) => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};

function stats(path) {
  const { w, h, spp, px } = decode(path);
  const N = w * h;
  const ys = new Float64Array(N);
  let sum = 0, below002 = 0, above08 = 0, zeroCh = 0, minCh = 255, warm = 0;
  for (let i = 0; i < N; i++) {
    const o = i * spp;
    const R = px[o], G = px[o + 1], B = px[o + 2];
    const Y = 0.2126 * s2l(R) + 0.7152 * s2l(G) + 0.0722 * s2l(B);
    ys[i] = Y; sum += Y;
    if (Y < 0.02) below002++;
    if (Y > 0.8) above08++;
    if (R === 0 || G === 0 || B === 0) zeroCh++;
    minCh = Math.min(minCh, R, G, B);
    if (R - B > 12) warm++;
  }
  ys.sort();
  const pct = (p) => ys[Math.min(N - 1, Math.floor(N * p))];
  return {
    file: basename(path), w, h,
    meanY: +(sum / N).toFixed(5),
    p1: +pct(0.01).toFixed(5),
    p50: +pct(0.50).toFixed(5),
    p999: +pct(0.999).toFixed(4),
    pctBelow002: +((below002 / N) * 100).toFixed(2),
    fracAbove08: +(above08 / N).toFixed(6),
    minChannel: minCh,
    pctZeroChannel: +((zeroCh / N) * 100).toFixed(2),
    pctWarm: +((warm / N) * 100).toFixed(2),
  };
}

// ---- calibration gate -------------------------------------------------------
const REF = '/Users/clark/Downloads/Source/slasher-cabin/.claude/worktrees/slasher-cabin-game-8bdb8b/public/img/keyart-site.png';
let ref;
try { ref = stats(REF); } catch (e) { console.error('CALIBRATION FAILED to decode reference:', e.message); process.exit(2); }
const okMean = Math.abs(ref.meanY - 0.0218) < 0.004;
const okBelow = Math.abs(ref.pctBelow002 - 79.77) < 6;
console.log(`calibration  keyart-site: meanY ${ref.meanY} (expect ~0.0218), below0.02 ${ref.pctBelow002}% (expect ~79.77%)  -> ${okMean && okBelow ? 'OK' : 'MISMATCH'}`);
if (!(okMean && okBelow)) {
  console.error('TOOL IS NOT TRUSTWORTHY — it cannot reproduce the known reference. Numbers below are meaningless.');
}
console.log('');

// ---- contract ---------------------------------------------------------------
// ART_DIRECTION 3.1.1 "clear": meanY in [0.018, 0.028]; blackest 1% in [0.002, 0.006];
// min channel >= 3; zero-channel pixels == 0.
const verdict = (s) => {
  const f = [];
  if (s.meanY < 0.018 || s.meanY > 0.028) f.push(`mean ${s.meanY}`);
  if (s.p1 < 0.002 || s.p1 > 0.006) f.push(`p1 ${s.p1}`);
  if (s.minChannel < 3) f.push(`minCh ${s.minChannel}`);
  if (s.pctZeroChannel > 0) f.push(`zeros ${s.pctZeroChannel}%`);
  return f.length ? 'FAIL: ' + f.join(', ') : 'PASS';
};

const hdr = ['file', 'meanY', 'p1', 'p50', 'p99.9', '%<0.02', 'frac>0.8', 'minCh', '%zero', '%warm', 'contract'];
console.log(hdr.map((x, i) => x.padEnd(i === 0 ? 26 : 9)).join(''));
for (const p of [REF, ...process.argv.slice(2)]) {
  let s;
  try { s = stats(p); } catch (e) { console.log(`${basename(p).padEnd(26)}decode failed: ${e.message}`); continue; }
  console.log([
    s.file.padEnd(26), String(s.meanY).padEnd(9), String(s.p1).padEnd(9), String(s.p50).padEnd(9),
    String(s.p999).padEnd(9), String(s.pctBelow002).padEnd(9), String(s.fracAbove08).padEnd(9),
    String(s.minChannel).padEnd(9), String(s.pctZeroChannel).padEnd(9), String(s.pctWarm).padEnd(9),
    p === REF ? '(reference)' : verdict(s),
  ].join(''));
}
