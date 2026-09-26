// Input: keyboard + mouse (pointer lock) + standard gamepad, folded into one per-frame action state. The demo
// autopilot writes into `input.virtual`, which is merged the same way, so gameplay never knows who is playing.
// Owner: gameplay (P).
//
//   const input = new Input(canvas)
//   input.update(rawDt)      — once per frame BEFORE gameplay reads it (latches edges, polls the gamepad)
//   input.move               — Vector2, x = right, y = forward (camera-relative), |move| ≤ 1
//   input.look               — Vector2 radians this frame (x = turn right, y = look down)
//   input.zoom               — wheel steps this frame (+ = out)
//   input.b.<action>         — { down, pressed, released, held (s), pressT (real s) }
//      actions: light, heavy, block, dodge, sprint, lock, special, draw, pause, start, restart
//   input.endFrame()         — clears per-frame deltas (call after gameplay + camera read them)
//   input.requestLock() / input.locked / input.idle (real s since the last human input)
//   input.virtual.press(a) / .hold(a, on) / .setMove(x, y) / .setLook(dx, dy) / .clear()
//
// Defaults (CONTRACTS): WASD move · mouse look · LMB light (hold = heavy charge) · RMB block (press just before
// impact = parry) · Space dodge · Shift sprint · Q/Tab/MMB lock-on · E sword-qi · F draw/sheathe · Esc/P pause.
// Extras: C heavy, Enter start, R restart.
import * as THREE from 'three';

export const ACTIONS = ['light', 'heavy', 'block', 'dodge', 'sprint', 'lock', 'special', 'draw', 'pause', 'start', 'restart'];

const KEYMAP = {
  Space: 'dodge', ShiftLeft: 'sprint', ShiftRight: 'sprint', KeyQ: 'lock', Tab: 'lock', KeyE: 'special',
  KeyF: 'draw', Escape: 'pause', KeyP: 'pause', Enter: 'start', NumpadEnter: 'start', KeyR: 'restart', KeyC: 'heavy',
  KeyJ: 'light', KeyK: 'block', KeyL: 'dodge',
};
const MOVE_KEYS = {
  KeyW: [0, 1], ArrowUp: [0, 1], KeyS: [0, -1], ArrowDown: [0, -1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0],
};
const MOUSE_MAP = ['light', 'lock', 'block']; // button 0, 1 (middle), 2
// standard gamepad mapping
const PAD_MAP = { 0: 'dodge', 1: 'draw', 2: 'light', 3: 'heavy', 4: 'lock', 5: 'block', 6: 'special', 7: 'heavy', 9: 'pause', 10: 'sprint', 11: 'lock' };

function makeButton() { return { down: false, pressed: false, released: false, held: 0, pressT: -1, _p: 0, _r: 0, _raw: false, _pad: false, _vd: false, _vp: 0 }; }

export class Input {
  constructor(canvas, { sensitivity = 0.0022 } = {}) {
    this.canvas = canvas;
    this.move = new THREE.Vector2();
    this.look = new THREE.Vector2();
    this.zoom = 0;
    this.b = {};
    for (const a of ACTIONS) this.b[a] = makeButton();
    this.sens = sensitivity;
    this.padLookSpeed = 3.2;          // rad/s at full stick
    this.locked = false;
    this.real = 0;                    // real clock (s)
    this.lastHuman = 0;               // real time of the last human input (any)
    this.lastLookT = -99;             // real time of the last camera-look input
    this.anyPressed = false;          // any human key/button this frame (title "press any key")
    this._keys = new Set();
    this._mouseLook = new THREE.Vector2();
    this._wheel = 0;
    this._padMove = new THREE.Vector2();
    this._padLook = new THREE.Vector2();
    this._any = 0;
    this.virtual = this._makeVirtual();
    this._bind();
  }

  get idle() { return this.real - this.lastHuman; }
  get lookIdle() { return this.real - this.lastLookT; }

  _makeVirtual() {
    const self = this;
    return {
      active: false, move: new THREE.Vector2(), look: new THREE.Vector2(),
      press(a) { const b = self.b[a]; if (b) b._vp++; },
      hold(a, on) { const b = self.b[a]; if (!b) return; if (on && !b._vd) b._vp++; if (!on && b._vd) b._r++; b._vd = !!on; },
      setMove(x, y) { this.move.set(x, y); if (this.move.lengthSq() > 1) this.move.normalize(); },
      setLook(dx, dy) { this.look.set(dx, dy); },
      clear() { this.move.set(0, 0); this.look.set(0, 0); for (const a of ACTIONS) { if (self.b[a]._vd) self.b[a]._r++; self.b[a]._vd = false; } },
    };
  }

  _human() { this.lastHuman = this.real; }

  _bind() {
    if (typeof window === 'undefined') return;
    const c = this.canvas;
    const onKey = (e, down) => {
      if (e.repeat && down) { if (e.code === 'Tab') e.preventDefault(); return; }
      const a = KEYMAP[e.code];
      if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (down) { this._keys.add(e.code); this._any++; } else this._keys.delete(e.code);
      if (a) this._edge(a, down);
      this._human();
    };
    this._onKeyDown = (e) => onKey(e, true);
    this._onKeyUp = (e) => onKey(e, false);
    this._onMouseDown = (e) => {
      const a = MOUSE_MAP[e.button];
      this._any++;
      if (a) this._edge(a, true);
      this._human();
      c?.focus?.();
    };
    this._onMouseUp = (e) => { const a = MOUSE_MAP[e.button]; if (a) this._edge(a, false); };
    this._onMouseMove = (e) => {
      if (!this.locked) return;
      this._mouseLook.x += e.movementX * this.sens;
      this._mouseLook.y += e.movementY * this.sens;
      if (e.movementX || e.movementY) { this.lastLookT = this.real; this._human(); }
    };
    this._onWheel = (e) => { e.preventDefault(); this._wheel += Math.sign(e.deltaY); this.lastLookT = this.real; this._human(); };
    this._onBlur = () => this.clear();
    this._onLock = () => { this.locked = document.pointerLockElement === c; if (!this.locked) this.onUnlock?.(); };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    (c ?? window).addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMouseMove);
    (c ?? window).addEventListener('wheel', this._onWheel, { passive: false });
    c?.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('pointerlockchange', this._onLock);
  }

  _edge(a, down) {
    const b = this.b[a];
    if (!b) return;
    if (down && !b._raw) b._p++;
    if (!down && b._raw) b._r++;
    b._raw = down;
  }

  /** Release everything (window blur, pause) so no key sticks. */
  clear() {
    this._keys.clear();
    for (const a of ACTIONS) { const b = this.b[a]; if (b._raw) b._r++; b._raw = false; b._pad = false; }
  }

  requestLock() {
    const c = this.canvas;
    if (!c?.requestPointerLock || this.locked) return;
    try {
      const p = c.requestPointerLock({ unadjustedMovement: true });
      if (p?.catch) p.catch(() => { try { c.requestPointerLock()?.catch?.(() => {}); } catch { /* unsupported */ } });
    } catch { /* headless / unsupported */ }
  }
  exitLock() { if (this.locked) document.exitPointerLock?.(); }

  _pollPad(rawDt) {
    this._padMove.set(0, 0); this._padLook.set(0, 0);
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : null;
    if (!pads) return;
    let pad = null;
    for (const p of pads) if (p && p.connected && p.mapping === 'standard') { pad = p; break; }
    if (!pad) return;
    const dz = (v) => (Math.abs(v) < 0.18 ? 0 : (v - Math.sign(v) * 0.18) / 0.82);
    const lx = dz(pad.axes[0] ?? 0), ly = dz(pad.axes[1] ?? 0), rx = dz(pad.axes[2] ?? 0), ry = dz(pad.axes[3] ?? 0);
    this._padMove.set(lx, -ly);
    if (rx || ry) {
      // response curve: fine aim near the centre, fast turns at full deflection
      this._padLook.set(Math.sign(rx) * rx * rx, Math.sign(ry) * ry * ry).multiplyScalar(this.padLookSpeed * rawDt);
      this.lastLookT = this.real;
    }
    let active = !!(lx || ly || rx || ry);
    for (const [i, a] of Object.entries(PAD_MAP)) {
      const btn = pad.buttons[i];
      const down = !!btn && (btn.pressed || btn.value > 0.5);
      const b = this.b[a];
      if (down && !b._pad) { b._p++; this._any++; }
      if (!down && b._pad) b._r++;
      b._pad = down;
      active ||= down;
    }
    if (active) this._human();
  }

  update(rawDt) {
    this.real += rawDt;
    this._pollPad(rawDt);
    // movement: keys + pad + virtual, clamped to the unit disc
    let mx = 0, my = 0;
    for (const k of this._keys) { const m = MOVE_KEYS[k]; if (m) { mx += m[0]; my += m[1]; } }
    mx += this._padMove.x; my += this._padMove.y;
    if (this.virtual.active) { mx += this.virtual.move.x; my += this.virtual.move.y; }
    this.move.set(mx, my);
    if (this.move.lengthSq() > 1) this.move.normalize();
    this.look.copy(this._mouseLook).add(this._padLook);
    if (this.virtual.active) this.look.add(this.virtual.look);
    this._mouseLook.set(0, 0);
    this.zoom = this._wheel; this._wheel = 0;
    this.anyPressed = this._any > 0; this._any = 0;
    for (const a of ACTIONS) {
      const b = this.b[a];
      const presses = b._p + b._vp;
      const nowDown = b._raw || b._pad || b._vd;
      b.pressed = presses > 0;
      b.released = b._r > 0 || (b.down && !nowDown);
      b.down = nowDown;
      if (b.pressed) { b.pressT = this.real; b.held = 0; }
      else if (b.down) b.held += rawDt;
      if (!b.down && !b.pressed) b.held = 0;
      b._p = 0; b._r = 0; b._vp = 0;
    }
  }

  endFrame() { this.look.set(0, 0); this.zoom = 0; }

  dispose() {
    if (typeof window === 'undefined') return;
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    (this.canvas ?? window).removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    (this.canvas ?? window).removeEventListener('wheel', this._onWheel);
    window.removeEventListener('blur', this._onBlur);
    document.removeEventListener('pointerlockchange', this._onLock);
  }
}
