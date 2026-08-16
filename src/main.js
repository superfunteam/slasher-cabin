/**
 * Bootstrap. Owned by: Engine agent.
 *
 * Systems are loaded dynamically and INDEPENDENTLY: a module that is missing, still
 * being authored, or throwing on import is logged and skipped rather than taking the
 * whole game down. This is what lets many agents build in parallel against one branch
 * and still have a runnable build at every moment.
 */
import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { Input } from './core/Input.js';
import { Shots } from './core/Shots.js';
import { Log } from './core/Log.js';

/** Registration order — see ARCHITECTURE.md §3. */
const SYSTEMS = [
  ['Textures',       () => import('./render/Textures.js'),          'Textures'],
  ['Materials',      () => import('./render/Materials.js'),         'Materials'],
  ['Terrain',        () => import('./world/Terrain.js'),            'Terrain'],
  ['Physics',        () => import('./gameplay/Physics.js'),         'Physics'],
  ['Player',         () => import('./gameplay/Player.js'),          'Player'],
  ['Flashlight',     () => import('./gameplay/Flashlight.js'),      'Flashlight'],
  ['Forest',         () => import('./world/Forest.js'),             'Forest'],
  ['Props',          () => import('./world/Props.js'),              'Props'],
  ['CabinSite',      () => import('./world/CabinSite.js'),          'CabinSite'],
  ['Navmesh',        () => import('./gameplay/Navmesh.js'),         'Navmesh'],
  ['NoiseSystem',    () => import('./gameplay/NoiseSystem.js'),     'NoiseSystem'],
  ['Campers',        () => import('./gameplay/Campers.js'),         'Campers'],
  ['Blueprint',      () => import('./gameplay/Blueprint.js'),       'Blueprint'],
  ['BuildSystem',    () => import('./gameplay/BuildSystem.js'),     'BuildSystem'],
  ['Weather',        () => import('./gameplay/Weather.js'),         'Weather'],
  ['NightManager',   () => import('./gameplay/NightManager.js'),    'NightManager'],
  ['Sky',            () => import('./render/Sky.js'),               'Sky'],
  ['VolumetricFog',  () => import('./render/VolumetricFog.js'),     'VolumetricFog'],
  ['Audio',          () => import('./audio/AudioEngine.js'),        'AudioEngine'],
  ['Music',          () => import('./audio/Music.js'),              'Music'],
  ['VoiceBank',      () => import('./audio/VoiceBank.js'),          'VoiceBank'],
  ['Postprocessing', () => import('./render/Postprocessing.js'),    'Postprocessing'],
  ['HUD',            () => import('./ui/HUD.js'),                   'HUD'],
  ['BlueprintUI',    () => import('./ui/BlueprintUI.js'),           'BlueprintUI'],
  ['Menu',           () => import('./ui/Menu.js'),                  'Menu'],
];

async function boot() {
  const mount = document.getElementById('app');
  const engine = new Engine(mount);
  const ctx = engine.ctx;

  // Input is core and always present — it must exist before anything reads it.
  engine.register('Input', new Input(ctx));

  const missing = [];

  for (const [name, importer, exportName] of SYSTEMS) {
    let mod;
    try {
      mod = await importer();
    } catch (e) {
      // Vite reports a missing file as a failed dynamic import — expected while
      // modules are still being authored.
      missing.push(name);
      Log.debug(`System '${name}' unavailable:`, e?.message ?? e);
      continue;
    }
    const Ctor = mod[exportName] ?? mod.default;
    if (typeof Ctor !== 'function') {
      Log.warn(`System '${name}' has no '${exportName}' export — skipping.`);
      missing.push(name);
      continue;
    }
    try {
      engine.register(name, new Ctor(ctx));
    } catch (e) {
      Log.error(`System '${name}' constructor threw — skipping.`, e);
      missing.push(name);
    }
  }

  if (missing.length) {
    Log.warn(`${missing.length} system(s) not loaded: ${missing.join(', ')}`);
  }

  // Registered last so it runs after every other system has posed the world, and can
  // override anything that would drift a canonical shot.
  engine.register('Shots', new Shots(ctx));

  await engine.initSystems();

  // Nothing to look at yet? Put up a placeholder so the screen is never black-on-black
  // and the screenshot harness gets a meaningful frame. Checks the scene rather than the
  // system list, because unimplemented stubs register successfully but draw nothing.
  let renderables = 0;
  ctx.scene.traverse((o) => { if (o.isMesh || o.isInstancedMesh || o.isPoints) renderables++; });
  if (renderables === 0) await installPlaceholderScene(ctx);

  engine.start();

  // Expose for the harness and for debugging.
  globalThis.__ENGINE__ = engine;
  globalThis.__CTX__ = ctx;
  document.documentElement.dataset.booted = 'true';
  ctx.bus.emit('engine:booted', { missing });

  return engine;
}

/** Minimal stand-in scene so a partially-built repo still renders something legible. */
async function installPlaceholderScene(ctx) {
  const { scene, camera } = ctx;

  scene.fog = new THREE.FogExp2(0x0a1216, 0.035);
  scene.background = new THREE.Color(0x070c11);

  const moon = new THREE.DirectionalLight(0x7d95c4, 1.2);
  moon.position.set(-40, 55, 30);
  scene.add(moon);
  scene.add(new THREE.HemisphereLight(0x1c2b3a, 0x070a08, 0.35));

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ color: 0x1a2118, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // Crude trees purely as a "the build is alive" signal.
  const trunk = new THREE.CylinderGeometry(0.22, 0.34, 12, 6);
  const mat = new THREE.MeshStandardMaterial({ color: 0x241d18, roughness: 1 });
  const trees = new THREE.InstancedMesh(trunk, mat, 300);
  const m = new THREE.Matrix4();
  for (let i = 0; i < 300; i++) {
    const a = ctx.rand.next() * Math.PI * 2;
    const r = 8 + ctx.rand.next() * 90;
    m.makeTranslation(Math.cos(a) * r, 6, Math.sin(a) * r);
    trees.setMatrixAt(i, m);
  }
  trees.instanceMatrix.needsUpdate = true;
  scene.add(trees);

  camera.position.set(0, 1.7, 6);
  Log.warn('Running with the placeholder scene — world systems are not loaded yet.');
}

boot().catch((e) => {
  Log.error('Fatal boot failure:', e);
  const mount = document.getElementById('app');
  if (mount) {
    mount.innerHTML = `<div style="position:absolute;inset:0;display:grid;place-items:center;
      font:14px/1.6 ui-monospace,monospace;color:#d92b2b;background:#05070a;padding:2rem;
      text-align:center;white-space:pre-wrap">ASSEMBLY HALTED\n\n${String(e?.stack ?? e)}</div>`;
  }
});
