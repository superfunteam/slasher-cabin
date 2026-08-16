/**
 * Headless smoke test for Terrain.js. No WebGL — three's geometry/math side runs fine in Node.
 * Verifies: init() does not throw, the query API is sane, nothing is NaN, and reports the
 * landmark coordinates + node/draw-call counts other agents need.
 */
import * as THREE from 'three';
import { Terrain } from './src/world/Terrain.js';
import { Rand } from './src/core/Rand.js';

const ctx = {
  renderer: null,
  scene: new THREE.Scene(),
  camera: new THREE.PerspectiveCamera(72, 16 / 9, 0.1, 900),
  canvas: null,
  bus: { on: () => () => {}, once: () => {}, off: () => {}, emit: () => {} },
  rand: new Rand(0x51a5cab),
  settings: {
    get: (k) => (k === 'seed' ? 0x51a5cab : undefined),
    tier: (l, m, h, u) => u,
    tierIndex: 3,
  },
  state: {},
  systems: new Map(),
};

const t0 = performance.now();
const terrain = new Terrain(ctx);
await terrain.init();
const genMs = performance.now() - t0;

const out = {};
out.genMs = +genMs.toFixed(0);
out.ready = terrain.ready;
out.boundsIsBox3 = !!terrain.bounds?.isBox3;
out.waterLevel = terrain.waterLevel;
out.campCenter = terrain.campCenter.toArray().map((v) => +v.toFixed(3));
out.buildSiteCenter = terrain.buildSiteCenter.toArray().map((v) => +v.toFixed(3));
out.latrine = terrain.latrine.toArray().map((v) => +v.toFixed(3));
out.dock = terrain.dock.toArray().map((v) => +v.toFixed(3));
out.ridgeLine = terrain.ridgeLine.length;
out.ridgeMaxY = +Math.max(...terrain.ridgeLine.map((p) => p.y)).toFixed(2);
out.streamPath = terrain.streamPath.length;
out.paths = terrain.paths.map((p) => p.id);
out.puddles = terrain.puddles.length;
out.logCrossing = terrain.logCrossing
  ? terrain.logCrossing.position.toArray().map((v) => +v.toFixed(3)) : null;

// ---- scene graph / draw calls -----------------------------------------------------------
const meshes = [];
terrain.group?.traverse((o) => { if (o.isMesh) meshes.push(o); });
out.meshCount = meshes.length;
out.nodeLevels = (terrain._nodes ?? []).map((lv) => lv.list.length);
out.groupInScene = !!terrain.group?.parent;

let tri = 0;
let attrBytes = 0;
const seenBuf = new Set();
for (const m of meshes) {
  const g = m.geometry;
  if (g.index && !seenBuf.has(g.index)) { seenBuf.add(g.index); attrBytes += g.index.array.byteLength; }
  for (const k in g.attributes) attrBytes += g.attributes[k].array.byteLength;
  if (g.index) tri += g.index.count / 3;
}
out.totalTrisIfAllDrawn = tri;
out.attrMB = +(attrBytes / 1048576).toFixed(2);
out.attributes = meshes.length ? Object.keys(meshes[0].geometry.attributes) : [];

// ---- API sanity: NaN hunt over the whole field + far outside it -------------------------
const rand = new Rand(99);
let nan = 0, minY = Infinity, maxY = -Infinity;
const surfCount = {};
const nv = new THREE.Vector3();
for (let i = 0; i < 200000; i++) {
  const x = rand.range(-900, 900), z = rand.range(-900, 900);
  const y = terrain.heightAt(x, z);
  if (!Number.isFinite(y)) nan++;
  if (Math.abs(x) <= 256 && Math.abs(z) <= 256) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  terrain.normalAt(x, z, nv);
  if (!Number.isFinite(nv.x) || !Number.isFinite(nv.y) || !Number.isFinite(nv.z)) nan++;
  if (Math.abs(nv.length() - 1) > 1e-3) nan++;
  const s = terrain.slopeAt(x, z);
  if (!Number.isFinite(s) || s < 0 || s > 1) nan++;
  if (i % 40 === 0) {
    const sf = terrain.surfaceAt(x, z);
    surfCount[sf] = (surfCount[sf] ?? 0) + 1;
  }
}
for (const v of [NaN, Infinity, -Infinity, undefined, null, 1e12]) {
  const y = terrain.heightAt(v, v);
  if (!Number.isFinite(y)) nan++;
  terrain.normalAt(v, v, nv);
  if (!Number.isFinite(nv.y)) nan++;
}
out.nanFailures = nan;
out.heightRangeInBounds = [+minY.toFixed(2), +maxY.toFixed(2)];
out.surfaceHistogram = surfCount;

// normalAt with no `out` must not corrupt shared state
const a = terrain.normalAt(-58, 96);
out.normalAtNoOut = a.toArray().map((v) => +v.toFixed(3));

out.isWaterLake = terrain.isWater(80, -160);
out.isWaterCamp = terrain.isWater(124, -18);
out.raycastDownHit = terrain.raycastDown(124, -18, 50);
out.raycastDownBelow = terrain.raycastDown(124, -18, -50);
out.raycastDownOutside = terrain.raycastDown(9000, 0, 50);

// ---- getSpawnCandidates ------------------------------------------------------------------
const sr = new Rand(1234);
const cands = terrain.getSpawnCandidates(500, (p) => p.surface === 'needles' && p.slope < 0.3, sr);
out.spawnCount = cands.length;
out.spawnSample = cands[0] ? {
  x: +cands[0].x.toFixed(2), y: +cands[0].y.toFixed(2), z: +cands[0].z.toFixed(2),
  slope: +cands[0].slope.toFixed(3), surface: cands[0].surface,
} : null;
out.spawnAllDistinct = new Set(cands.map((c) => `${c.x},${c.z}`)).size === cands.length;
out.spawnDeterministic = (() => {
  const b = terrain.getSpawnCandidates(500, (p) => p.surface === 'needles' && p.slope < 0.3, new Rand(1234));
  return b.length === cands.length && b.every((p, i) => p.x === cands[i].x && p.z === cands[i].z);
})();

// ---- cull: how many draw calls does a real camera produce? -------------------------------
function drawCallsAt(px, pz, yaw) {
  const cam = ctx.camera;
  cam.position.set(px, terrain.heightAt(px, pz) + 1.7, pz);
  cam.rotation.set(0, yaw, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  terrain.update(1 / 60, 0);
  return terrain.stats.drawCalls;
}
const probes = [];
const pr = new Rand(7);
for (let i = 0; i < 240; i++) {
  probes.push(drawCallsAt(pr.range(-230, 230), pr.range(-230, 230), pr.range(-Math.PI, Math.PI)));
}
probes.push(drawCallsAt(124, -18, 0), drawCallsAt(-140, 128, 2.2), drawCallsAt(-58, 96, 1.0));
out.drawCallsMax = Math.max(...probes);
out.drawCallsAvg = +(probes.reduce((s, v) => s + v, 0) / probes.length).toFixed(1);

// ---- dispose ------------------------------------------------------------------------------
try { terrain.dispose(); out.dispose = 'ok'; } catch (e) { out.dispose = `THREW: ${e.message}`; }
try { const t2 = new Terrain(ctx); t2.dispose(); out.disposeBeforeInit = 'ok'; }
catch (e) { out.disposeBeforeInit = `THREW: ${e.message}`; }

console.log(JSON.stringify(out, null, 2));
