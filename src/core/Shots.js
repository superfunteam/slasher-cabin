/**
 * The screenshot harness. Owned by: Engine agent.
 *
 * Visual-quality review is done by agents who load the game in a real GPU browser, drive it to a
 * canonical viewpoint, and screenshot it. For that to be meaningful the shot must be
 * REPRODUCIBLE — same seed, same camera, same time of night, same weather — so two screenshots
 * taken an hour apart differ only by the code that changed.
 *
 * Usage:  /?shot=ridge            — pose the camera, freeze the sim, signal readiness
 *         /?shot=ridge&free       — pose the camera but let the sim run
 *         /?shots                 — list available shot ids on the page
 *
 * A shot is READY when `document.documentElement.dataset.shotReady === "true"` and
 * `window.__SHOT_READY__` (a promise) resolves. Poll the dataset attribute — it is the most
 * robust signal for an external screenshotter.
 *
 * The twelve canonical framings come from ART_DIRECTION.md §9 "The 12 Shots".
 */
import * as THREE from 'three';
import { Log } from './Log.js';

/**
 * Each shot pins everything that affects the image.
 *
 * Positions are expressed RELATIVE TO A NAMED LANDMARK on Terrain rather than as absolute
 * world coordinates, because absolute coordinates silently rot: the first version of this file
 * hardcoded a build site at (-72,-62) while Terrain actually puts it at (-140,128), so every
 * "canonical" shot framed empty forest. `from` and `at` are landmark names resolved at runtime;
 * `offset` and `aim` are metre offsets applied to them. `eye` is height above ground.
 *
 * Landmarks: 'camp' | 'buildSite' | 'dock' | 'latrine' | 'origin'
 */
export const SHOTS = {
  'site-wide': {
    desc: "The build site from the treeline — the game's establishing shot.",
    from: 'buildSite', offset: [18, 0, 16], at: 'buildSite', aim: [0, 1.4, 0], eye: 2.2,
    timeOfNight: 0.35, rain: 0.15, fog: 0.55, lantern: true, hood: 0,
  },
  'site-close': {
    desc: 'Close on the half-built frame, lantern hung on a stud. Material detail test.',
    from: 'buildSite', offset: [4.5, 0, 4.0], at: 'buildSite', aim: [0, 1.0, 0], eye: 1.6,
    timeOfNight: 0.4, rain: 0.3, fog: 0.5, lantern: true, hood: 0,
  },
  'ridge': {
    desc: 'From the ridge looking down at camp. Silhouette, depth, and fog layering test.',
    from: 'camp', offset: [-72, 0, 22], at: 'camp', aim: [0, 2.0, 0], eye: 2.0,
    timeOfNight: 0.3, rain: 0.0, fog: 0.65, lantern: false,
  },
  'camp-fire': {
    desc: 'Camp firelight through trees. The warm/cool palette collision.',
    from: 'camp', offset: [-34, 0, -6], at: 'camp', aim: [0, 1.2, 0], eye: 1.7,
    timeOfNight: 0.25, rain: 0.0, fog: 0.45, lantern: false,
  },
  'camp-tents': {
    desc: 'Lit canvas tents glowing from within. Translucency and bloom test.',
    from: 'camp', offset: [-16, 0, 20], at: 'camp', aim: [4, 1.5, 6], eye: 1.7,
    timeOfNight: 0.28, rain: 0.1, fog: 0.4, lantern: false,
  },
  'lake': {
    desc: 'From the dock across the lake. Water, reflection, and distance fog.',
    from: 'dock', offset: [0, 0, -6], at: 'dock', aim: [-30, 8, -110], eye: 1.8,
    timeOfNight: 0.5, rain: 0.0, fog: 0.6, lantern: false,
  },
  'forest-deep': {
    desc: 'Deep forest between camp and the site. God rays and volumetric density test.',
    from: 'origin', offset: [-20, 0, 40], at: 'origin', aim: [-46, 1.5, 66], eye: 1.7,
    timeOfNight: 0.45, rain: 0.35, fog: 0.75, lantern: true, hood: 0,
  },
  'forest-hooded': {
    desc: 'Same spot, lantern hooded. The darkness the stealth game actually lives in.',
    from: 'origin', offset: [-20, 0, 40], at: 'origin', aim: [-46, 1.5, 66], eye: 1.7,
    timeOfNight: 0.45, rain: 0.35, fog: 0.75, lantern: true, hood: 1,
  },
  'moon': {
    desc: 'Canopy against the moon. Sky, stars, cloud, and tree silhouette test.',
    from: 'origin', offset: [-30, 0, 20], at: 'origin', aim: [-52, 40, -14], eye: 1.7,
    timeOfNight: 0.4, rain: 0.0, fog: 0.3, lantern: false,
  },
  'lightning': {
    desc: 'Mid-lightning-flash. Everything lit flat and hard for one frame.',
    from: 'buildSite', offset: [26, 0, 24], at: 'buildSite', aim: [0, 2.5, 0], eye: 1.9,
    timeOfNight: 0.55, rain: 0.8, fog: 0.7, lantern: true, hood: 0, lightning: 1.0,
  },
  'manual': {
    desc: 'The open manual over the world. The signature tonal contrast.',
    from: 'buildSite', offset: [6, 0, 5], at: 'buildSite', aim: [0, 1.2, 0], eye: 1.7,
    timeOfNight: 0.4, rain: 0.25, fog: 0.5, lantern: true, hood: 0, manual: true,
  },
  'carry': {
    desc: 'Hauling a sill beam through the trees. Foreground occlusion and scale.',
    from: 'buildSite', offset: [42, 0, -34], at: 'buildSite', aim: [0, 1.5, 0], eye: 1.7,
    timeOfNight: 0.38, rain: 0.2, fog: 0.6, lantern: true, hood: 0.5, carry: 'sill-beam',
  },
};

/** Fallbacks used only when Terrain is unavailable — keeps the harness usable standalone. */
const LANDMARK_FALLBACK = {
  camp: [124, 0, -18],
  buildSite: [-140, 0, 128],
  dock: [106, 0, -72],
  latrine: [96, 0, 34],
  origin: [0, 0, 0],
};

const _pos = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _off = new THREE.Vector3();

export class Shots {
  constructor(ctx) {
    this.ctx = ctx;
    this.active = null;
    this.frozen = false;
    this._settleFrames = 0;

    let params;
    try { params = new URLSearchParams(globalThis.location?.search ?? ''); }
    catch { params = new URLSearchParams(); }

    this.requested = params.get('shot');
    this.free = params.has('free');
    this.listOnly = params.has('shots');

    // Resolve when the frame is stable and safe to capture.
    this.ready = new Promise((resolve) => { this._resolveReady = resolve; });
    globalThis.__SHOT_READY__ = this.ready;
    globalThis.__SHOTS__ = SHOTS;
  }

  async init() {
    if (this.listOnly) {
      this._renderList();
      return;
    }
    if (!this.requested) {
      // Not a shot run — resolve immediately so nothing waits on us.
      this._resolveReady?.({ shot: null });
      return;
    }

    const shot = SHOTS[this.requested];
    if (!shot) {
      Log.error(`Unknown shot '${this.requested}'. Known: ${Object.keys(SHOTS).join(', ')}`);
      this._resolveReady?.({ shot: null, error: 'unknown shot' });
      return;
    }

    this.active = shot;
    this.frozen = !this.free;
    Log.info(`Shot '${this.requested}': ${shot.desc}`);
  }

  /** Applied every frame so no other system can drift the pose out from under us. */
  update() {
    if (!this.active) return;
    const { ctx } = this;
    const s = this.active;

    // --- resolve landmarks, then pose the camera and hold it there
    const terrain = ctx.systems.get('Terrain');
    this._landmark(terrain, s.from, _pos).add(_off.fromArray(s.offset ?? [0, 0, 0]));
    this._landmark(terrain, s.at, _tgt).add(_off.fromArray(s.aim ?? [0, 1.5, 0]));

    // Sit the camera the right height above actual ground, so shots survive terrain edits.
    if (terrain?.heightAt) {
      const groundY = terrain.heightAt(_pos.x, _pos.z);
      if (Number.isFinite(groundY)) _pos.y = groundY + (s.eye ?? 1.7);
      // Aim points given with a small y are meant as "above the ground there", not absolute.
      if ((s.aim?.[1] ?? 0) < 12) {
        const tGround = terrain.heightAt(_tgt.x, _tgt.z);
        if (Number.isFinite(tGround)) _tgt.y = tGround + (s.aim?.[1] ?? 1.5);
      }
    } else {
      _pos.y = s.eye ?? 1.7;
    }

    ctx.camera.position.copy(_pos);
    ctx.camera.lookAt(_tgt);

    if (this.frozen) {
      // Park the player on the camera so systems that follow the player behave.
      const player = ctx.systems.get('Player');
      if (player?.position) {
        player.position.copy(_pos);
        player.velocity?.set?.(0, 0, 0);
      }
    }

    // --- pin world state
    if (s.timeOfNight !== undefined) ctx.state.timeOfNight = s.timeOfNight;

    const weather = ctx.systems.get('Weather');
    if (weather) {
      if (s.rain !== undefined && 'rain' in weather) weather.rain = s.rain;
      if (s.fog !== undefined && 'fog' in weather) weather.fog = s.fog;
      if (s.lightning !== undefined && 'lightning' in weather) weather.lightning = s.lightning;
    }

    const lantern = ctx.systems.get('Flashlight');
    if (lantern && s.lantern !== undefined) {
      lantern.on = !!s.lantern;
      if (s.hood !== undefined && 'hoodLevel' in lantern) lantern.hoodLevel = s.hood;
    }

    if (s.manual) ctx.systems.get('BlueprintUI')?.open?.();

    // --- readiness: give TAA/volumetric temporal accumulation time to converge,
    // otherwise the critic screenshots a noisy, half-resolved frame and blames the art.
    if (this._settleFrames < 45) {
      this._settleFrames++;
      if (this._settleFrames === 45) {
        document.documentElement.dataset.shotReady = 'true';
        this._resolveReady?.({ shot: this.requested, desc: s.desc });
        Log.info(`Shot '${this.requested}' ready to capture.`);
      }
    }
  }

  /** Resolve a landmark name to a world position, writing into `out`. */
  _landmark(terrain, name, out) {
    const key = name ?? 'origin';
    const v = terrain?.[key === 'buildSite' ? 'buildSiteCenter' : key === 'camp' ? 'campCenter' : key];
    if (v && Number.isFinite(v.x)) return out.set(v.x, v.y ?? 0, v.z);
    const f = LANDMARK_FALLBACK[key] ?? LANDMARK_FALLBACK.origin;
    return out.fromArray(f);
  }

  _renderList() {
    const rows = Object.entries(SHOTS)
      .map(([id, s]) => `<tr><td style="padding:4px 16px 4px 0"><a href="?shot=${id}">${id}</a></td><td>${s.desc}</td></tr>`)
      .join('');
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;background:#f4f1e8;color:#16181a;padding:40px;'
      + 'font:14px/1.7 ui-monospace,monospace;overflow:auto;z-index:9999';
    el.innerHTML = `<h1 style="font:600 20px/1.3 sans-serif;margin:0 0 20px">Canonical shots</h1>
      <table>${rows}</table>`;
    document.body.appendChild(el);
    this._resolveReady?.({ shot: null, list: true });
  }

  dispose() {
    delete globalThis.__SHOT_READY__;
    delete globalThis.__SHOTS__;
  }
}

export default Shots;
