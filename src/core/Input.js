/**
 * Keyboard + mouse + gamepad input with pointer lock.
 * Owned by: Engine agent.
 *
 * Consumers read state (`input.forward`, `input.lookDelta`) rather than binding events,
 * so input is frame-coherent and replayable.
 */
import { Log } from './Log.js';

/** action -> list of KeyboardEvent.code */
export const BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['ControlLeft', 'KeyC'],
  jump: ['Space'],
  interact: ['KeyE'],
  drop: ['KeyQ'],
  blueprint: ['Tab', 'KeyB'],
  lantern: ['KeyF'],
  throwPart: ['KeyG'],
  pause: ['Escape'],
  rotateCW: ['KeyR'],
  rotateCCW: ['KeyT'],
};

export class Input {
  constructor(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
    this.canvas = ctx.canvas;

    /** @type {Set<string>} raw key codes currently down */
    this._down = new Set();
    /** codes that went down this frame */
    this._pressed = new Set();
    /** codes that went up this frame */
    this._released = new Set();

    // Look accumulation — consumed once per frame by Player.
    this.lookDelta = { x: 0, y: 0 };
    this._lookAccum = { x: 0, y: 0 };

    this.mouse = { left: false, right: false, wheel: 0 };
    this._wheelAccum = 0;

    this.pointerLocked = false;
    this.enabled = true;
    this.gamepadIndex = -1;

    // Analogue movement vector, -1..1. Merged keyboard + gamepad.
    this.move = { x: 0, y: 0 };

    this._bind();
  }

  // ---------------------------------------------------------------- queries

  isDown(action) {
    const codes = BINDINGS[action];
    if (!codes) return false;
    for (const c of codes) if (this._down.has(c)) return true;
    return false;
  }

  /** True only on the frame the action was first pressed. */
  wasPressed(action) {
    const codes = BINDINGS[action];
    if (!codes) return false;
    for (const c of codes) if (this._pressed.has(c)) return true;
    return false;
  }

  wasReleased(action) {
    const codes = BINDINGS[action];
    if (!codes) return false;
    for (const c of codes) if (this._released.has(c)) return true;
    return false;
  }

  // ---------------------------------------------------------------- lifecycle

  _bind() {
    const doc = globalThis.document;
    if (!doc) return;

    this._onKeyDown = (e) => {
      if (!this.enabled) return;
      // Tab would move focus; Space would scroll.
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
      if (e.repeat) return;
      this._down.add(e.code);
      this._pressed.add(e.code);
      this.bus?.emit('input:key', { code: e.code, down: true });
    };

    this._onKeyUp = (e) => {
      this._down.delete(e.code);
      this._released.add(e.code);
      this.bus?.emit('input:key', { code: e.code, down: false });
    };

    this._onMouseDown = (e) => {
      if (!this.enabled) return;
      if (e.button === 0) this.mouse.left = true;
      if (e.button === 2) this.mouse.right = true;
      this.bus?.emit('input:mouse', { button: e.button, down: true });
    };

    this._onMouseUp = (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
      this.bus?.emit('input:mouse', { button: e.button, down: false });
    };

    this._onMouseMove = (e) => {
      if (!this.pointerLocked || !this.enabled) return;
      // Spurious huge deltas happen on lock acquisition in some browsers.
      const dx = e.movementX || 0;
      const dy = e.movementY || 0;
      if (Math.abs(dx) > 400 || Math.abs(dy) > 400) return;
      this._lookAccum.x += dx;
      this._lookAccum.y += dy;
    };

    this._onWheel = (e) => {
      if (!this.enabled) return;
      this._wheelAccum += Math.sign(e.deltaY);
      e.preventDefault();
    };

    this._onContext = (e) => e.preventDefault();

    this._onPointerLockChange = () => {
      this.pointerLocked = doc.pointerLockElement === this.canvas;
      // Dropping lock must not leave keys stuck down.
      if (!this.pointerLocked) this.releaseAll();
      this.bus?.emit(this.pointerLocked ? 'input:lock' : 'input:unlock', {});
    };

    this._onBlur = () => this.releaseAll();

    this._onGamepadConnected = (e) => {
      this.gamepadIndex = e.gamepad.index;
      Log.info('Gamepad connected:', e.gamepad.id);
    };
    this._onGamepadDisconnected = () => { this.gamepadIndex = -1; };

    doc.addEventListener('keydown', this._onKeyDown);
    doc.addEventListener('keyup', this._onKeyUp);
    doc.addEventListener('mousedown', this._onMouseDown);
    doc.addEventListener('mouseup', this._onMouseUp);
    doc.addEventListener('mousemove', this._onMouseMove);
    doc.addEventListener('pointerlockchange', this._onPointerLockChange);
    doc.addEventListener('contextmenu', this._onContext);
    this.canvas?.addEventListener('wheel', this._onWheel, { passive: false });
    globalThis.addEventListener('blur', this._onBlur);
    globalThis.addEventListener('gamepadconnected', this._onGamepadConnected);
    globalThis.addEventListener('gamepaddisconnected', this._onGamepadDisconnected);
  }

  requestPointerLock() {
    try {
      this.canvas?.requestPointerLock?.();
    } catch (e) {
      Log.warn('Pointer lock request failed:', e);
    }
  }

  exitPointerLock() {
    try { globalThis.document?.exitPointerLock?.(); } catch { /* noop */ }
  }

  releaseAll() {
    for (const code of this._down) this._released.add(code);
    this._down.clear();
    this.mouse.left = false;
    this.mouse.right = false;
    this._lookAccum.x = 0;
    this._lookAccum.y = 0;
  }

  // ---------------------------------------------------------------- frame

  update() {
    // Publish accumulated look, then zero for next frame.
    this.lookDelta.x = this._lookAccum.x;
    this.lookDelta.y = this._lookAccum.y;
    this._lookAccum.x = 0;
    this._lookAccum.y = 0;

    this.mouse.wheel = this._wheelAccum;
    this._wheelAccum = 0;

    // Keyboard movement vector.
    let mx = (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0);
    let my = (this.isDown('forward') ? 1 : 0) - (this.isDown('back') ? 1 : 0);

    this._pollGamepad();
    if (this._padMove) {
      // Gamepad wins when it's actually being pushed.
      if (Math.abs(this._padMove.x) > 0.12) mx = this._padMove.x;
      if (Math.abs(this._padMove.y) > 0.12) my = this._padMove.y;
      this.lookDelta.x += this._padLook.x;
      this.lookDelta.y += this._padLook.y;
    }

    // Normalize so diagonal isn't faster.
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    this.move.x = mx;
    this.move.y = my;
  }

  /** Called by Engine after all systems have consumed this frame's input. */
  endFrame() {
    this._pressed.clear();
    this._released.clear();
  }

  _pollGamepad() {
    if (this.gamepadIndex < 0 || !navigator.getGamepads) { this._padMove = null; return; }
    const pad = navigator.getGamepads()[this.gamepadIndex];
    if (!pad) { this._padMove = null; return; }

    const dz = (v) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
    this._padMove = { x: dz(pad.axes[0] ?? 0), y: -dz(pad.axes[1] ?? 0) };
    // Quadratic look curve for fine aim near centre.
    const lx = dz(pad.axes[2] ?? 0), ly = dz(pad.axes[3] ?? 0);
    this._padLook = { x: lx * Math.abs(lx) * 14, y: ly * Math.abs(ly) * 14 };

    // Face buttons -> synthesized key codes so wasPressed() works uniformly.
    const mapBtn = (i, code) => {
      const pressed = !!pad.buttons[i]?.pressed;
      const was = this._down.has(code);
      if (pressed && !was) { this._down.add(code); this._pressed.add(code); }
      else if (!pressed && was) { this._down.delete(code); this._released.add(code); }
    };
    mapBtn(0, 'Space');        // A -> jump
    mapBtn(2, 'KeyE');         // X -> interact
    mapBtn(1, 'KeyQ');         // B -> drop
    mapBtn(3, 'KeyB');         // Y -> blueprint
    mapBtn(10, 'KeyC');        // L3 -> crouch
    mapBtn(6, 'ShiftLeft');    // LT -> sprint
    mapBtn(5, 'KeyF');         // RB -> lantern
    mapBtn(9, 'Escape');       // start -> pause
  }

  dispose() {
    const doc = globalThis.document;
    if (!doc) return;
    doc.removeEventListener('keydown', this._onKeyDown);
    doc.removeEventListener('keyup', this._onKeyUp);
    doc.removeEventListener('mousedown', this._onMouseDown);
    doc.removeEventListener('mouseup', this._onMouseUp);
    doc.removeEventListener('mousemove', this._onMouseMove);
    doc.removeEventListener('pointerlockchange', this._onPointerLockChange);
    doc.removeEventListener('contextmenu', this._onContext);
    this.canvas?.removeEventListener('wheel', this._onWheel);
    globalThis.removeEventListener('blur', this._onBlur);
    globalThis.removeEventListener('gamepadconnected', this._onGamepadConnected);
    globalThis.removeEventListener('gamepaddisconnected', this._onGamepadDisconnected);
  }
}

export default Input;
