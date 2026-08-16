import * as THREE from 'three';
import { NoiseSystem, TUNING } from './src/gameplay/NoiseSystem.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};
const near = (name, a, b, tol) => ok(name, Math.abs(a - b) <= tol, `got ${a} want ${b}±${tol}`);

// ---------------------------------------------------------------- minimal ctx
function makeBus() {
  const m = new Map();
  return {
    on(e, f) { if (!m.has(e)) m.set(e, new Set()); m.get(e).add(f); return () => m.get(e)?.delete(f); },
    off(e, f) { m.get(e)?.delete(f); },
    emit(e, p) { for (const f of Array.from(m.get(e) ?? [])) f(p); },
  };
}
function makeCtx(opts = {}) {
  return {
    bus: makeBus(),
    scene: new THREE.Scene(),
    camera: { position: new THREE.Vector3(0, 1.7, 0) },
    rand: { next: () => 0.5, range: (a, b) => (a + b) / 2 },
    settings: { tier: (l, m, h, u) => u, get: () => 0 },
    state: { night: opts.night ?? 1, storyFlags: {}, installed: {} },
    systems: new Map(Object.entries(opts.systems ?? {})),
  };
}

// ================================================================ 1. bare construct, no systems
{
  const ns = new NoiseSystem(makeCtx());
  await ns.init();
  ok('constructs+inits with zero systems', true);
  ok('recentNoises is an array', Array.isArray(ns.recentNoises) && ns.recentNoises.length === 0);
  ns.update(0.016, 0.016);
  const ev = ns.emit(new THREE.Vector3(0, 1, 0), 30, 0.6, 'impact');
  ok('emit returns an event', !!ev && ev.kind === 'impact');
  ok('event is live', ns.recentNoises.length === 1);

  // GAME_DESIGN §9.8: heard = intensity * (1-d/r)^1.5 * occ * (1-mask)
  const mask = ns.maskLevel;                     // Night 1 floor = 0.089
  near('night-1 mask floor', mask, 0.089, 0.001);
  const h = ns.audibilityAt(new THREE.Vector3(10, 1, 0), ev);
  const want = 0.6 * Math.pow(1 - 10 / 30, 1.5) * 1 * (1 - 0.089);
  near('audibilityAt matches §9.8', h, want, 1e-6);

  ok('audible past radius is 0', ns.audibilityAt(new THREE.Vector3(31, 1, 0), ev) === 0);
  ok('audible at source is intensity*(1-mask)',
    Math.abs(ns.audibilityAt(new THREE.Vector3(0, 1, 0), ev) - 0.6 * (1 - 0.089)) < 1e-6);

  // solvable radius
  const r = ns.audibleRadius(ev, 0.11);
  const check = ns.audibilityAt(new THREE.Vector3(r, 1, 0), ev);
  near('audibleRadius inverts falloff exactly', check, 0.11, 1e-6);

  // decay: gone after `life`
  for (let i = 0; i < 300; i++) ns.update(0.016, 0.016 * (i + 2));
  ok('event decays out of the buffer', ns.recentNoises.length === 0);
  ns.dispose();
}

// ================================================================ 2. mask floors per night
{
  const floors = [null, 0.089, 0.197, 0.151, 0.357, 0.141, 0.457, 0.037];
  for (let n = 1; n <= 7; n++) {
    const ns = new NoiseSystem(makeCtx({ night: n }));
    await ns.init();
    ns.update(0.016, 0.016);
    near(`night ${n} mask floor`, ns.maskFloor, floors[n], 0.0005);
    ns.dispose();
  }
}

// ================================================================ 3. thunder window
{
  const ns = new NoiseSystem(makeCtx({ night: 6 }));
  await ns.init();
  ns.update(0.016, 0.016);
  near('night-6 floor', ns.maskFloor, 0.457, 0.001);
  ns.emit(new THREE.Vector3(0, 40, 0), 400, 1.0, 'thunder');
  let t = 0.016;
  for (let i = 0; i < 40; i++) { t += 0.016; ns.update(0.016, t); }   // 0.64 s in: ramped
  ok('thunder raises mask to peak', Math.abs(ns.maskLevel - 0.85) < 0.001, `got ${ns.maskLevel}`);
  ok('window reports open', ns.maskWindowOpen === true);
  ok('window remaining is telegraphed', ns.maskWindowRemaining > 5,
    `got ${ns.maskWindowRemaining}`);

  // a hammer struck under thunder must stay masked after the thunder ends
  const hammer = ns.emit(new THREE.Vector3(0, 1, 0), 34, 0.55, 'hammer');
  const heardNow = ns.audibilityAt(new THREE.Vector3(5, 1.6, 0), hammer);
  ok('hammer under thunder is below a counselor threshold', heardNow < 0.11,
    `got ${heardNow.toFixed(3)}`);
  for (let i = 0; i < 40; i++) { t += 0.016; ns.update(0.016, t); }
  const heardLater = ns.audibilityAt(new THREE.Vector3(5, 1.6, 0), hammer);
  near('masked event stays masked as the window closes', heardLater, heardNow, 1e-6);

  // and it does not shrink the radius (§7.5.4)
  ok('thunder does not shrink radius', hammer.radius === 34);
  ns.dispose();
}

// ================================================================ 4. occlusion via a fake Physics
{
  // one "building" wall (0.45) at x=10, plus a trunk (0.88) at x=5
  const colliders = [
    { kind: 'building', occlusion: 0.45, x: 10, z: 0, r: 1.2 },
    { kind: 'trunk', occlusion: 0.88, x: 5, z: 0, r: 0.6 },
  ];
  const physics = {
    LAYER: { TERRAIN: 1, STATIC: 2, BUILD: 4, PROP: 8, FOLIAGE: 16, ACTOR: 32, WATER: 64 },
    overlapSphere(p, rad, out, _mask) {
      let n = 0;
      for (const c of colliders) {
        const d = Math.hypot(p.x - c.x, p.z - c.z);
        if (d <= rad + c.r) out[n++] = c;
      }
      return n;
    },
  };
  const terrain = {
    bounds: { minX: -64, maxX: 64, minZ: -64, maxZ: 64 },
    heightAt: () => 0,
    isWater: () => false,
    forestDensityAt: () => 0.3,
  };
  const ns = new NoiseSystem(makeCtx({ systems: { Physics: physics, Terrain: terrain } }));
  await ns.init();
  for (let i = 0; i < 40; i++) ns.update(0.016, 0.016 * (i + 1));   // let the bake finish
  ok('bake completed', ns.stats.bakeProgress >= 1, `got ${ns.stats.bakeProgress}`);

  const a = new THREE.Vector3(0, 1.6, 0), b = new THREE.Vector3(20, 1.6, 0);
  const occ = ns.occlusionBetween(a, b);
  near('trunk + building product', occ, 0.88 * 0.45, 0.02);

  const clear = ns.occlusionBetween(new THREE.Vector3(0, 1.6, 20), new THREE.Vector3(20, 1.6, 20));
  near('clear line is unoccluded', clear, 1, 1e-6);

  // lowpass agrees with occlusion and darkens with distance
  const lpNear = ns.lowpassFor(1.0, 5);
  const lpWall = ns.lowpassFor(0.45, 5);
  const lpFar = ns.lowpassFor(1.0, 400);
  ok('open lowpass is bright', lpNear > 15000, `got ${lpNear}`);
  ok('wall lowpass is dark', lpWall < 2000 && lpWall > 500, `got ${lpWall}`);
  ok('distance lowpass is a rumble', lpFar < 600, `got ${lpFar}`);

  const ac = ns.acousticsAt(b, ns.emit(a, 30, 0.6, 'impact'));
  near('acousticsAt.attenuation == audibilityAt', ac.attenuation,
    ns.audibilityAt(b, ns.recentNoises[0]), 1e-6);
  ok('acousticsAt reports blockers', ac.blockers >= 2, `got ${ac.blockers}`);
  ok('gainDb is finite', Number.isFinite(ac.gainDb));
  ns.dispose();
}

// ================================================================ 5. ridge + water
{
  const terrain = {
    bounds: { minX: -128, maxX: 128, minZ: -128, maxZ: 128 },
    // a ridge wall between x=18 and x=22
    heightAt: (x) => (x > 18 && x < 22 ? 9 : 0),
    isWater: (x, z) => z < -40,
    forestDensityAt: () => 0.2,
  };
  const ns = new NoiseSystem(makeCtx({ systems: { Terrain: terrain } }));
  await ns.init();
  ns.update(0.016, 0.016);
  const occ = ns.occlusionBetween(new THREE.Vector3(0, 1.6, 0), new THREE.Vector3(40, 1.6, 0));
  near('a ridge is 0.50', occ, 0.5, 1e-6);
  ok('ridge is reported', ns.occlusionBetween(new THREE.Vector3(0, 1.6, 0),
    new THREE.Vector3(40, 1.6, 0)) === 0.5);

  const ev = ns.emit(new THREE.Vector3(0, 1, -60), 30, 0.6, 'drop');
  const overWater = ns.audibleRadius(ev, 0.11, 0, -1);   // straight out over the lake
  const inland = ns.audibleRadius(ev, 0.11);               // unoccluded baseline
  ok('sound carries further over water', overWater > inland * 1.2,
    `water ${overWater.toFixed(1)} vs land ${inland.toFixed(1)}`);
  ns.dispose();
}

// ================================================================ 6. player readout + poll
{
  const ns = new NoiseSystem(makeCtx());
  await ns.init();
  ns.update(0.016, 0.016);
  ns.ctx.bus.emit('player:move', { position: new THREE.Vector3(0, 0, 0), speed: 1.6, crouched: false });
  ns.emit(new THREE.Vector3(0.2, 0.1, 0), 9, 0.18, 'footstep');
  ok('player noise attributed', ns.playerNoise.active && ns.playerNoise.kind === 'footstep');
  ok('player noise reach is sane', ns.playerNoise.reach > 1 && ns.playerNoise.reach < 9,
    `got ${ns.playerNoise.reach}`);
  ok('no direction for a noise under your own boots', ns.playerNoise.dirValid === false);

  ns.emit(new THREE.Vector3(0, 1, 12), 46 + 14, 0.7, 'creak');
  ok('creak points at the cabin', ns.playerNoise.dirValid === true &&
    Math.abs(ns.playerNoise.dirZ - 1) < 1e-6);

  const got = ns.pollNoise(new THREE.Vector3(0, 1.6, 20), 0.11, -1, null, 0);
  ok('pollNoise finds the creak', !!got && got.kind === 'creak');
  ok('error radius follows §9.8', Math.abs(got.errorRadius - (4 + 14 * (1 - got.heard))) < 1e-9);
  ok('investigation point is inside the error disc',
    got.point.distanceTo(new THREE.Vector3(0, got.point.y, 12)) <= got.errorRadius + 1e-6);
  const again = ns.pollNoise(new THREE.Vector3(0, 1.6, 20), 0.11, got.seq, null, 0);
  ok('sinceSeq suppresses a re-poll of the same event', again === null || again.seq !== got.seq);

  // thunder and voice are not camper-relevant
  ns.emit(new THREE.Vector3(0, 1.6, 21), 26, 0.9, 'voice');
  const p2 = ns.pollNoise(new THREE.Vector3(0, 1.6, 20), 0.11, -1, null, 1);
  ok('campers ignore voice', !p2 || p2.kind !== 'voice');
  ns.dispose();
}

// ================================================================ 7. coalescing + footstep bridge
{
  const ns = new NoiseSystem(makeCtx());
  await ns.init();
  ns.update(0.016, 0.016);
  for (let i = 0; i < 20; i++) ns.emit(new THREE.Vector3(0, 1, 0), 90, 0.62, 'saw');
  ok('sustained saw coalesces to one event', ns.recentNoises.length === 1,
    `got ${ns.recentNoises.length}`);
  ok('coalesced repeats counted', ns.recentNoises[0].repeats === 19);

  // player:footstep with no matching noise:emit gets bridged
  const ns2 = new NoiseSystem(makeCtx());
  await ns2.init();
  ns2.update(0.016, 0.016);
  ns2.ctx.bus.emit('player:footstep',
    { position: new THREE.Vector3(3, 0, 0), surface: 'duff', loud: 0.18 });
  ns2.update(0.016, 0.032);
  ok('lone player:footstep is bridged', ns2.recentNoises.length === 1 &&
    ns2.recentNoises[0].kind === 'footstep');

  // ... but not double-counted when Player emits both
  const ns3 = new NoiseSystem(makeCtx());
  await ns3.init();
  ns3.update(0.016, 0.016);
  ns3.ctx.bus.emit('player:footstep',
    { position: new THREE.Vector3(3, 0, 0), surface: 'duff', loud: 0.18 });
  ns3.ctx.bus.emit('noise:emit',
    { position: new THREE.Vector3(3, 0, 0), radius: 9, intensity: 0.18, kind: 'footstep' });
  ns3.update(0.016, 0.032);
  ok('no double count when both events fire', ns3.recentNoises.length === 1,
    `got ${ns3.recentNoises.length}`);
  ns.dispose(); ns2.dispose(); ns3.dispose();
}

// ================================================================ 8. malformed payloads
{
  const ns = new NoiseSystem(makeCtx());
  await ns.init();
  ns.update(0.016, 0.016);
  const bus = ns.ctx.bus;
  bus.emit('noise:emit', null);
  bus.emit('noise:emit', {});
  bus.emit('noise:emit', { position: { x: 1, y: 1, z: 1 } });          // no radius/intensity/kind
  bus.emit('noise:emit', { position: new THREE.Vector3(), kind: 'nonsense' });
  bus.emit('noise:emit', { position: new THREE.Vector3(), radius: NaN, intensity: 'loud', kind: 'drop' });
  ok('malformed payloads do not throw and are repaired', ns.recentNoises.length === 3,
    `got ${ns.recentNoises.length}`);
  const e = ns.recentNoises[0];
  ok('missing fields filled from the canonical table', e.radius === 30 && e.intensity === 0.6);
  ok('audibilityAt(null) is 0', ns.audibilityAt(null, e) === 0 && ns.audibilityAt(new THREE.Vector3(), null) === 0);
  ns.dispose();
  ok('dispose is idempotent', (ns.dispose(), true));
  ok('post-dispose queries are inert', ns.audibilityAt(new THREE.Vector3(), e) === 0);
}

// ================================================================ 9. allocation check
{
  const ns = new NoiseSystem(makeCtx());
  await ns.init();
  ns.update(0.016, 0.016);
  const ev = ns.emit(new THREE.Vector3(0, 1, 0), 60, 0.7, 'creak');
  const L = new THREE.Vector3(20, 1.6, 20);
  for (let i = 0; i < 2000; i++) ns.audibilityAt(L, ev, i % 8);
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  let t = 1;
  for (let i = 0; i < 50000; i++) {
    ns.audibilityAt(L, ev, i % 8);
    if (i % 200 === 0) { t += 0.016; ns.update(0.016, t); ev.age = 0; ev.alive = true; ev.strength = 1; }
  }
  if (global.gc) global.gc();
  const after = process.memoryUsage().heapUsed;
  const mb = (after - before) / 1048576;
  ok('50k queries allocate < 2 MB', mb < 2, `grew ${mb.toFixed(2)} MB`);
  ns.dispose();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
