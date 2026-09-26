// Animator: keyframed wuxia move set + procedural locomotion + IK, driving the contract skeleton.
// Owner: animation (A).
//
//   import { Animator, CLIPS } from './character/animator.js';
//   const anim = new Animator(ch.rig, { heightAt, normalAt?, style?: 'hero'|'bandit' });
//   anim.play(name, { fade = 0.1, speed = 1, loop })   // action clip (overrides locomotion until it ends)
//   anim.stop(fade)                                     // back to locomotion
//   anim.setLocomotion({ speed, dirX, dirZ, combat, turn })  // m/s, local dir (+Z fwd, +X left), turn = yaw rate rad/s
//   anim.setArmed(bool)                                 // sword in hand (auto-set by draw/sheathe clips)
//   anim.lookAt(worldPos | null)                        // head/torso aim (e.g. lock-on target)
//   const out = anim.update(dt, worldGroup)             // → { rootMotion: Vector3 (local m this frame), rootYaw, events }
//   anim.current / anim.time / anim.normalizedTime / anim.isActing / anim.duration
//   anim.poseAt(name, t)                                // pure evaluation (no locks/state) — tools, previews
//   anim.sampleRoot(name, t, out) → yaw                 // cumulative authored root motion at clip time t
//
// Frame pipeline (evaluated from rest every frame, nothing accumulates):
//   gait (procedural locomotion pose) ─┐
//   action clip (keyed Hermite tracks) ─┴→ layer blend (full / upper-body mask) → inertialization (quintic offset
//   decay that preserves velocity across transitions) → additive layers (lean into acceleration and turns,
//   breathing, idle weight shift, look-at) → foot planting in the world (locks, re-steps, terrain, ground tilt) →
//   pelvis reach correction → two-bone IK (arms: grip + blade orientation; legs: ankles) → bones.
// Events: hitOn/hitOff (index), comboOpen/comboClose, whoosh, step (foot, pos), end, plus clip extras
// (drawn, sheathed, impact, release, plant). Each event carries { type, clip }.
import * as THREE from 'three';
import { RigSolver, Pose, ROT_CHANNELS, D2R, GRIP_R } from './ik.js';
import { FootPlanter } from './ikfeet.js';
import { Gait } from './clips/locomotion.js';
import { COMPILED, CLIPS } from './clips/index.js';

export { CLIPS };

const LOCO = new Set(['idle', 'combatIdle', 'walk', 'run', 'sprint', 'walkBack', 'strafeL', 'strafeR']);
// preview parameters for the locomotion names: [speed, dirX, dirZ, combat]
const LOCO_PREVIEW = { idle: [0, 0, 1, false], combatIdle: [0, 0, 1, true], walk: [1.6, 0, 1, false], run: [5.2, 0, 1, false], sprint: [8.5, 0, 1, false], walkBack: [1.4, 0, -1, true], strafeL: [1.8, 1, 0, true], strafeR: [1.8, -1, 0, true] };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const expK = (rate, dt) => 1 - Math.exp(-rate * dt);
/** 0..1: how strongly the cutting arm should stay extended at clip time t (strike → follow-through). */
function reachWeight(meta, t) {
  if (!meta || !['light', 'heavy', 'thrust', 'special'].includes(meta.type) || !meta.hit?.length) return 0;
  const h0 = meta.hit[0][0], dur = meta.duration;
  return sstep(h0 - 0.07, h0 - 0.01, t) * (1 - sstep(dur * 0.72, dur, t));
}

// ---------------------------------------------------------------------------------------------------------
// Inertialization (Bollo, GDC 2018): at a transition the offset source − target is decayed to zero with a quintic
// that starts with the source's velocity and ends with zero velocity/acceleration.
// ---------------------------------------------------------------------------------------------------------
class Quintic {
  constructor() { this.A = 0; this.B = 0; this.C = 0; this.a0 = 0; this.v0 = 0; this.x0 = 0; this.t1 = 0; }
  init(x0, v0, t1) {
    this.x0 = x0;
    if (x0 < 1e-6) { this.x0 = 0; return; }
    if (v0 > 0) v0 = 0;                              // moving away from the target: don't overshoot further
    if (v0 < 0) t1 = Math.min(t1, -5 * x0 / v0);
    t1 = Math.max(t1, 1e-3);
    let a0 = (-8 * v0 * t1 - 20 * x0) / (t1 * t1);
    if (a0 < 0) a0 = 0;
    const t2 = t1 * t1, t3 = t2 * t1, t4 = t3 * t1, t5 = t4 * t1;
    this.A = -(a0 * t2 + 6 * v0 * t1 + 12 * x0) / (2 * t5);
    this.B = (3 * a0 * t2 + 16 * v0 * t1 + 30 * x0) / (2 * t4);
    this.C = -(3 * a0 * t2 + 12 * v0 * t1 + 20 * x0) / (2 * t3);
    this.a0 = a0; this.v0 = v0; this.t1 = t1;
  }
  at(t) {
    if (this.x0 === 0 || t >= this.t1) return 0;
    const t2 = t * t, t3 = t2 * t;
    return this.A * t3 * t2 + this.B * t2 * t2 + this.C * t3 + 0.5 * this.a0 * t2 + this.v0 * t + this.x0;
  }
}

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0), AX = new THREE.Vector3(1, 0, 0), AZ = new THREE.Vector3(0, 0, 1);

class Inertializer {
  constructor() {
    this.t = 0; this.active = false;
    // channel list: [kind, getter(pose)]; kind 0 = vec3, 1 = quat, 2 = scalar
    const ch = [];
    ch.push([0, (p) => p.hips]);
    for (const n of ROT_CHANNELS) ch.push([1, (p) => p.q[n]]);
    for (let i = 0; i < 2; i++) {
      ch.push([0, (p) => p.hand[i]], [1, (p) => p.handQ[i]], [0, (p) => p.foot[i]], [1, (p) => p.footQ[i]]);
      ch.push([2, (p) => p.pitch, i], [2, (p) => p.flare, i]);
    }
    ch.push([3, null]); // twoHand
    this.ch = ch.map(([kind, get, idx]) => ({ kind, get, idx, q: new Quintic(), dir: new THREE.Vector3(), sign: 1 }));
  }
  /** src = last output, srcPrev = output before it (velocity), tgt = new target pose now. */
  start(src, srcPrev, dtPrev, tgt, t1) {
    this.t = 0; this.active = true;
    const idt = 1 / Math.max(dtPrev, 1 / 240);
    for (const c of this.ch) {
      if (c.kind === 0) {
        const a = c.get(src), b = c.get(tgt), pa = c.get(srcPrev);
        c.dir.subVectors(a, b); const x0 = c.dir.length();
        if (x0 < 1e-6) { c.q.init(0, 0, t1); continue; }
        c.dir.multiplyScalar(1 / x0);
        const v0 = _v.subVectors(a, pa).multiplyScalar(idt).dot(c.dir);
        c.q.init(x0, v0, t1);
      } else if (c.kind === 1) {
        const a = c.get(src), b = c.get(tgt), pa = c.get(srcPrev);
        _q.copy(b).invert().premultiply(a);           // off = a · b⁻¹
        if (_q.w < 0) { _q.x = -_q.x; _q.y = -_q.y; _q.z = -_q.z; _q.w = -_q.w; }
        const x0 = 2 * Math.acos(Math.min(1, _q.w));
        if (x0 < 1e-5) { c.q.init(0, 0, t1); continue; }
        const sn = Math.sqrt(Math.max(1e-12, 1 - _q.w * _q.w));
        c.dir.set(_q.x / sn, _q.y / sn, _q.z / sn);
        // angular velocity of the source
        _q2.copy(pa).invert().premultiply(a);
        if (_q2.w < 0) { _q2.x = -_q2.x; _q2.y = -_q2.y; _q2.z = -_q2.z; _q2.w = -_q2.w; }
        const ang = 2 * Math.acos(Math.min(1, _q2.w));
        const s2 = Math.sqrt(Math.max(1e-12, 1 - _q2.w * _q2.w));
        const v0 = ang > 1e-6 ? (ang * idt) * (_q2.x * c.dir.x + _q2.y * c.dir.y + _q2.z * c.dir.z) / s2 : 0;
        c.q.init(x0, v0, t1);
      } else {
        const a = c.kind === 3 ? src.twoHand : c.get(src)[c.idx];
        const b = c.kind === 3 ? tgt.twoHand : c.get(tgt)[c.idx];
        const pa = c.kind === 3 ? srcPrev.twoHand : c.get(srcPrev)[c.idx];
        const x = a - b; c.sign = x < 0 ? -1 : 1;
        c.q.init(Math.abs(x), (a - pa) * idt * c.sign, t1);
      }
    }
  }
  apply(pose, dt) {
    if (!this.active) return pose;
    this.t += dt;
    let any = false;
    for (const c of this.ch) {
      const x = c.q.at(this.t);
      if (x === 0) continue;
      any = true;
      if (c.kind === 0) c.get(pose).addScaledVector(c.dir, x);
      else if (c.kind === 1) { _q.setFromAxisAngle(c.dir, x); c.get(pose).premultiply(_q); }
      else if (c.kind === 2) c.get(pose)[c.idx] += x * c.sign;
      else pose.twoHand += x * c.sign;
    }
    if (!any && this.t > 0.05) this.active = false;
    return pose;
  }
}

// lean table (deg) over speed
const LEAN = [[0, 0], [1.6, 2], [3.2, 5.5], [5.2, 10], [8.5, 20]];
function leanFor(s) {
  if (s <= 0) return 0;
  for (let i = 1; i < LEAN.length; i++) if (s <= LEAN[i][0]) { const t = (s - LEAN[i - 1][0]) / (LEAN[i][0] - LEAN[i - 1][0]); return LEAN[i - 1][1] + (LEAN[i][1] - LEAN[i - 1][1]) * t; }
  return LEAN[LEAN.length - 1][1];
}

function guessStyle(rig) {
  let o = rig.root;
  for (let i = 0; i < 6 && o; i++, o = o.parent) {
    const n = o.name || '';
    if (/bandit|swordmaster|assassin|enemy/i.test(n)) return 'bandit';
    if (/hero/i.test(n)) return 'hero';
  }
  return null;
}

export class Animator {
  constructor(rig, { heightAt, normalAt, style, kind } = {}) {
    this.rig = rig; this.bones = rig.bones;
    rig.anim = this;                // model skins read the clip clock (baked layers)
    this.solver = new RigSolver(rig);
    this._styleGiven = style ?? (kind ? (kind === 'hero' ? 'hero' : 'bandit') : null);
    this.gait = new Gait(this.solver, { style: this._styleGiven ?? 'hero' });
    this.feet = new FootPlanter(this.solver, { heightAt, normalAt });
    this.heightAt = heightAt;
    this.loco = { speed: 0, dirX: 0, dirZ: 1, combat: false, turn: 0 };
    this.armed = true;
    this.poleArm = kind === 'spearman';
    this.action = null;             // { clip, t, speed, loop, ei (next event idx), yaw, root: Vector3 }
    this.time = 0;
    this.poseL = new Pose(); this.poseA = new Pose(); this.out = new Pose();
    this.last = new Pose(); this.last2 = new Pose(); this.lastDt = 1 / 60; this._hasLast = false;
    this.inert = new Inertializer();
    this._pendingBlend = 0;         // >0: start an inertialization with this duration next update
    this.events = [];
    this.rootMotion = new THREE.Vector3();
    this.rootYaw = 0;
    this._out = { rootMotion: this.rootMotion, rootYaw: 0, events: this.events };
    // additive state
    this.clock = 0;
    this.exertion = 0;
    this.lean = new THREE.Vector2(); // x = pitch (deg), y = roll (deg)
    this._vel = new THREE.Vector2(); this._acc = new THREE.Vector2();
    this.pelvisCorr = 0;
    this.look = { target: new THREE.Vector3(), has: false, w: 0, yaw: 0, pitch: 0 };
    this.upperW = 0;                // current weight of an upper-body action over locomotion legs
    this._rootWorld = new THREE.Matrix4();
    this.weaponSocket = rig.bones['weapon.R'] ?? null;
    this.debug = { planted: [false, false] };
  }

  // ---- contract accessors ----
  get current() { return this.action ? this.action.clip.name : this._locoName(); }
  get isActing() { return !!this.action; }
  get duration() { return this.action ? this.action.clip.duration : 1; }
  get normalizedTime() { return this.action ? this.time / this.action.clip.duration : this.gait.phase; }
  clip(name) { return CLIPS[name]; }
  _locoName() {
    const l = this.loco, s = this.gait.speed;
    if (s < 0.2) return l.combat ? 'combatIdle' : 'idle';
    if (l.dirZ < -0.5) return 'walkBack';
    if (Math.abs(l.dirX) > 0.7) return l.dirX > 0 ? 'strafeL' : 'strafeR';
    if (s < 2.5) return 'walk';
    if (s < 6.5) return 'run';
    return 'sprint';
  }

  play(name, { fade = 0.1, speed = 1, loop } = {}) {
    // style variant (e.g. 'hitFront@bandit') when authored, same name/meta for gameplay
    const clip = COMPILED[`${name}@${this.gait.styleName}`] ?? COMPILED[name];
    if (!clip) { console.warn('[anim] unknown clip', name); return; }
    if (LOCO.has(name)) { this.stop(fade); if (name === 'combatIdle') this.loco.combat = true; return; }
    this.action = { clip, speed, loop: loop ?? clip.loop, ei: 0, yaw: 0, root: new THREE.Vector3(), hitState: 0 };
    this.time = 0;
    this._pendingBlend = Math.max(fade, 0.06);
    if (clip.meta.type === 'light' || clip.meta.type === 'heavy' || clip.meta.type === 'thrust' || clip.meta.type === 'special') this.exertion = Math.min(1, this.exertion + 0.12);
  }
  stop(fade = 0.15) {
    if (!this.action) return;
    this.action = null;
    this._pendingBlend = Math.max(fade, 0.08);
  }
  setLocomotion(l) {
    if (l.speed !== undefined) this.loco.speed = l.speed;
    if (l.dirX !== undefined) this.loco.dirX = l.dirX;
    if (l.dirZ !== undefined) this.loco.dirZ = l.dirZ;
    if (l.combat !== undefined) this.loco.combat = !!l.combat;
    if (l.turn !== undefined) this.loco.turn = l.turn || 0;
  }
  setArmed(v) { this.armed = !!v; }
  lookAt(p) { if (p) { this.look.target.copy(p); this.look.has = true; } else this.look.has = false; }

  /** Cumulative authored root motion of `name` at clip time t (local metres) → returns yaw (rad). */
  sampleRoot(name, t, out = new THREE.Vector3()) { const c = COMPILED[name]; if (!c) { out.set(0, 0, 0); return 0; } return c.rootAt(t, out); }

  /** Pure evaluation: pose the rig at clip time t (feet as authored, no world locks, no additive layers). */
  poseAt(name, t, { lookAt = null } = {}) {
    const pose = this.out;
    if (LOCO.has(name)) {
      const p = LOCO_PREVIEW[name];
      this.gait.setPreview(p[0], p[1], p[2], 0, p[3], this.armed);
      return this.poseLoco(p[0], p[1], p[2], p[0] > 0 ? t / this.gait.cycle : 0, { combat: p[3] });
    }
    const c = COMPILED[name]; if (!c) return;
    c.evaluate(t, pose, this.solver);
    pose.reach = reachWeight(c.meta ?? CLIPS[name]?.meta, t);
    this._solveRigSpace(pose);
    return pose;
  }

  _solveRigSpace(pose) {
    const s = this.solver.s, F = this.feet;
    for (let i = 0; i < 2; i++) {
      _v.copy(pose.foot[i]).multiplyScalar(s);
      F.anchorsRig[i].copy(_v);
      // footFromAnchor via the planter's helper path
      _footFromAnchor(_v, pose.footQ[i], pose.pitch[i], s, F.ankles[i], F.footQ[i]);
    }
    this.solver.torso(pose);
    const need = this.solver.maxPelvisDrop(pose, F.ankles);
    if (need > 0) pose.hips.y -= need;
    this.solver.apply(pose, F.ankles, F.footQ);
    if (this.weaponSocket) this.weaponSocket.quaternion.copy(GRIP_R);
  }

  update(dt, worldGroup) {
    const ev = this.events; ev.length = 0;
    this.rootMotion.set(0, 0, 0); this.rootYaw = 0;
    if (!this._styleGiven && !this._styleChecked) {
      this._styleChecked = true;
      const st = guessStyle(this.rig);
      if (st && st !== 'hero') this.gait = new Gait(this.solver, { style: st });
    }
    this.clock += dt;
    const act = this.action;

    // ---- action clock, events, root motion ----
    if (act) {
      const c = act.clip, m = c.meta;
      const prev = this.time;
      let t = prev + dt * act.speed;
      let ended = false;
      if (t >= c.duration) {
        if (act.loop) { this._fireEvents(c, prev, c.duration); t %= c.duration; act.ei = 0; this._fireEvents(c, -1, t); }
        else { t = c.duration; ended = true; }
      }
      if (!act.loop || t >= prev) this._fireEvents(c, prev, t);
      // root motion (authored, in the clip-start frame) → local frame of this instant
      if (c.root) {
        const yaw1 = c.rootAt(t, _v2);
        _v.copy(_v2).sub(act.root);
        _v.applyAxisAngle(UP, -act.yaw);
        this.rootMotion.copy(_v).multiplyScalar(this.solver.s);   // authored in contract units → this rig's size
        this.rootYaw = yaw1 - act.yaw;
        act.root.copy(_v2); act.yaw = yaw1;
      }
      this.time = t;
      if (ended) {
        if (!act.ended) ev.push({ type: 'end', clip: c.name });
        act.ended = true;
        if (m.type === 'death' || m.hold) { /* hold the last pose */ }
        else { this.action = null; this._pendingBlend = 0.22; }
      }
    }

    // ---- locomotion clock (always runs so upper-body actions keep the legs moving) ----
    const acting = this.action && this.action.clip.layer !== 'upper';
    const locoIn = acting ? _LOCO_STILL : this.loco;
    this.gait.update(dt, locoIn, this.armed);

    // ---- target pose ----
    const out = this.out;
    if (this.action) {
      const c = this.action.clip;
      if (c.layer === 'upper') {
        this.gait.evaluate(this.poseL);
        c.evaluate(this.time, this.poseA, this.solver);
        const legsW = 1 - this.gait.w;
        out.copy(this.poseL).blendMasked(this.poseA, 1, legsW);
      } else {
        c.evaluate(this.time, out, this.solver);
      }
    } else {
      this.gait.evaluate(out);
    }

    // ---- inertialization ----
    if (this._pendingBlend > 0 && this._hasLast) this.inert.start(this.last, this.last2, this.lastDt, out, Math.min(0.5, this._pendingBlend * 1.6));
    this._pendingBlend = 0;
    this.inert.apply(out, dt);
    this.last2.copy(this.last); this.last.copy(out); this.lastDt = Math.max(dt, 1e-4); this._hasLast = true;

    // ---- additive layers ----
    this._additive(out, dt);

    // ---- feet in the world ----
    // Gameplay applies this frame's root motion on its next integrate, so the planter works with the root where it
    // WILL be: feet authored static in the clip-start frame then stay static in the world (no phantom drift/steps).
    const root = this.rig.root;
    if (worldGroup) worldGroup.updateWorldMatrix(true, false);
    root.updateWorldMatrix(true, false);
    _m4.copy(root.matrixWorld);
    if (this.rootMotion.lengthSq() > 0 || this.rootYaw !== 0) {
      _m4b.makeRotationY(this.rootYaw).setPosition(this.rootMotion);
      _m4.multiply(_m4b);
    }
    this.feet.update(dt, out, root.matrixWorld, { predict: _m4, autoStep: !this.action || this.action.clip.meta.autoStep !== false, events: ev, gaitW: this.gait.w });
    for (const e of ev) if (e.type === 'step' && !e.clip) { e.clip = this.current; e.speed = this.gait.speed; }

    // ---- pelvis reach correction (never leave a foot hanging) ----
    this.solver.torso(out);
    const need = this.solver.maxPelvisDrop(out, this.feet.ankles);
    this.pelvisCorr = Math.max(need, this.pelvisCorr * Math.exp(-dt * 10));
    if (this.pelvisCorr > 1e-4) out.hips.y -= this.pelvisCorr;

    // ---- IK solve → bones ----
    out.reach = this.action ? reachWeight(this.action.clip.meta, this.time) : 0;
    // pole arms are held in both hands (the left fist on the shaft behind the right) except while dying
    if (this.poleArm && this.armed) {
      const dying = this.action && (this.action.clip.meta.type === 'death' || this.action.clip.name === 'executed');
      this._pole = (this._pole ?? 1) + ((dying ? 0 : 1) - (this._pole ?? 1)) * Math.min(1, dt * 8);
      out.twoHand = Math.max(out.twoHand, this._pole);
    }
    this.solver.apply(out, this.feet.ankles, this.feet.footQ);
    if (this.weaponSocket) this.weaponSocket.quaternion.copy(GRIP_R);

    this._out.rootYaw = this.rootYaw;
    return this._out;
  }

  _fireEvents(c, t0, t1) {
    const ev = this.events, m = c.meta, name = c.name;
    const cross = (x) => t0 < x && t1 >= x;
    m.hit.forEach(([a, b], i) => {
      if (cross(a)) ev.push({ type: 'hitOn', clip: name, index: i });
      if (cross(b)) ev.push({ type: 'hitOff', clip: name, index: i });
    });
    if (m.combo) { if (cross(m.combo[0])) ev.push({ type: 'comboOpen', clip: name }); if (cross(m.combo[1])) ev.push({ type: 'comboClose', clip: name }); }
    for (const e of c.events) if (cross(e.t)) {
      ev.push({ ...e, clip: name });
      if (e.type === 'drawn') this.armed = true;
      if (e.type === 'sheathed') this.armed = false;
    }
  }

  /** Lean into acceleration and turns, breathing, idle weight shift, look-at. */
  _additive(pose, dt) {
    const g = this.gait, l = this.loco;
    const actW = this.action && this.action.clip.layer !== 'upper' ? 1 : 0;
    this._actW = (this._actW ?? 0) + (actW - (this._actW ?? 0)) * expK(10, dt);
    const locoW = 1 - this._actW;
    // velocity/acceleration in the local frame (x left, y forward)
    const vx = g.dir.x * g.speed, vz = g.dir.y * g.speed;
    const idt = 1 / Math.max(dt, 1e-4);
    const ax = (vx - this._vel.x) * idt, az = (vz - this._vel.y) * idt;
    this._vel.set(vx, vz);
    const k = expK(6, dt);
    this._acc.x += (ax - this._acc.x) * k; this._acc.y += (az - this._acc.y) * k;
    const turn = clamp(l.turn || 0, -6, 6);
    const pitchT = leanFor(g.speed) * Math.max(0, g.dir.y) - leanFor(g.speed) * 0.4 * Math.max(0, -g.dir.y) + clamp(this._acc.y * 1.3, -8, 10);
    const rollT = clamp(-Math.atan2(g.speed * turn, 9.81) / D2R * 0.7 - this._acc.x * 0.8, -16, 16);
    this.lean.x += (pitchT - this.lean.x) * expK(7, dt);
    this.lean.y += (rollT - this.lean.y) * expK(6, dt);
    this._applyLean(pose, this.lean.x * locoW, this.lean.y * locoW);
    // turn anticipation: head and chest lead into the turn
    this._turnLead = (this._turnLead ?? 0) + (turn - (this._turnLead ?? 0)) * expK(8, dt);
    if (Math.abs(this._turnLead) > 1e-3) {
      const a = clamp(this._turnLead, -4, 4) * locoW;
      _q.setFromAxisAngle(UP, a * 0.05); pose.q.chest.premultiply(_q);
      _q.setFromAxisAngle(UP, a * 0.09); pose.q.head.premultiply(_q);
    }
    // exertion & breathing
    this.exertion = Math.max(0, Math.min(1, this.exertion + (g.speed > 4.5 ? 0.06 : 0) * dt - 0.08 * dt));
    const e = this.exertion;
    this._breath = (this._breath ?? 0) + dt * (1.25 + 2.2 * e);
    const b = Math.sin(this._breath);
    const bAmp = (0.9 + 1.6 * e);
    _q.setFromAxisAngle(AX, -b * bAmp * 0.6 * D2R); pose.q.chest.multiply(_q);
    _q.setFromAxisAngle(AX, b * bAmp * 0.3 * D2R); pose.q.neck.multiply(_q);
    _q.setFromAxisAngle(AZ, (b * 0.5 + 0.5) * bAmp * 0.9 * D2R); pose.q['shoulder.L'].multiply(_q);
    _q.setFromAxisAngle(AZ, -(b * 0.5 + 0.5) * bAmp * 0.9 * D2R); pose.q['shoulder.R'].multiply(_q);
    // idle weight shift (pivot at the ankles), two incommensurate sines so it never visibly repeats
    const idleW = (1 - g.w) * locoW;
    if (idleW > 0.01) {
      const t = this.clock;
      const sh = (Math.sin(t * 0.55) * 0.6 + Math.sin(t * 0.23 + 1.3) * 0.4) * idleW;
      pose.hips.x += sh * 0.009;
      pose.hips.z += Math.sin(t * 0.37 + 0.4) * 0.004 * idleW;
      _q.setFromAxisAngle(AZ, -sh * 1.2 * D2R); pose.q.hips.premultiply(_q);
      _q.setFromAxisAngle(AZ, sh * 1.0 * D2R); pose.q.chest.multiply(_q);
      _q.setFromAxisAngle(UP, Math.sin(t * 0.31 + 2.0) * 3 * D2R * idleW); pose.q.head.multiply(_q);
    }
    // look-at
    this._lookAt(pose, dt);
  }

  /** Lean (deg): pitch forward `lp` distributed pelvis → chest, roll `lr` into turns; head stays level. */
  _applyLean(pose, lp, lr) {
    if (Math.abs(lp) + Math.abs(lr) <= 0.01) return;
    _q.setFromAxisAngle(AX, lp * 0.4 * D2R); _q2.setFromAxisAngle(AZ, lr * 0.5 * D2R);
    pose.q.hips.premultiply(_q2).premultiply(_q);
    _q.setFromAxisAngle(AX, lp * 0.3 * D2R); pose.q.spine.premultiply(_q);
    _q.setFromAxisAngle(AX, lp * 0.3 * D2R); _q2.setFromAxisAngle(AZ, lr * 0.3 * D2R); pose.q.chest.premultiply(_q).multiply(_q2);
    _q.setFromAxisAngle(AX, -lp * 0.45 * D2R); pose.q.neck.premultiply(_q);
    _q.setFromAxisAngle(AX, -lp * 0.35 * D2R); _q2.setFromAxisAngle(AZ, -lr * 0.6 * D2R); pose.q.head.premultiply(_q).multiply(_q2);
    pose.hips.z += Math.sin(lp * D2R) * 0.35;
    pose.hips.x += Math.sin(lr * D2R) * -0.3;
  }

  /**
   * Pure locomotion preview (filmstrips, tools): the gait at a fixed speed/direction/phase with its steady-state
   * lean, solved in rig space (no world locks, no clocks).
   */
  poseLoco(speed, dirX, dirZ, phase, { combat = false, armed = this.armed } = {}) {
    const pose = this.out;
    this.gait.setPreview(speed, dirX, dirZ, phase, combat, armed);
    this.gait.evaluate(pose);
    const l = leanFor(speed), n = Math.hypot(dirX, dirZ) || 1;
    this._applyLean(pose, l * Math.max(0, dirZ / n) - l * 0.4 * Math.max(0, -dirZ / n), 0);
    this._solveRigSpace(pose);
    return pose;
  }

  _lookAt(pose, dt) {
    const L = this.look;
    const want = L.has ? 1 : 0;
    L.w += (want - L.w) * expK(L.has ? 5 : 3, dt);
    if (L.w < 1e-3) return;
    if (L.has) {
      // target in rig space relative to the head
      const root = this.rig.root;
      root.updateWorldMatrix(true, false);
      _v.copy(L.target).applyMatrix4(_m4.copy(root.matrixWorld).invert()).multiplyScalar(1 / this.solver.s);
      this.solver.torso(pose);
      const head = _v2.copy(this.solver.P.head).multiplyScalar(1 / this.solver.s);
      _v.sub(head);
      // current facing of the chest in rig space
      const fwd = _v2.set(0, 0, 1).applyQuaternion(this.solver.Q.chest);
      const yawNow = Math.atan2(fwd.x, fwd.z);
      let yaw = Math.atan2(_v.x, _v.z) - yawNow;
      yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
      const pitch = -Math.atan2(_v.y, Math.hypot(_v.x, _v.z));
      const yawC = clamp(yaw, -1.3, 1.3), pitchC = clamp(pitch, -0.6, 0.6);
      const behind = 1 - sstep(1.6, 2.4, Math.abs(yaw)); // give up on targets behind the back
      const k = expK(9, dt);
      L.yaw += (yawC * behind - L.yaw) * k; L.pitch += (pitchC * behind - L.pitch) * k;
    }
    const acting = this.action && this.action.clip.layer !== 'upper';
    const lookK = this.action ? (this.action.clip.meta.look ?? (acting ? 0.35 : 0.8)) : 1;
    const w = L.w * lookK;
    const y = L.yaw * w, p = L.pitch * w;
    const bodyK = acting ? 0.3 : 1;
    _q.setFromAxisAngle(UP, y * 0.12 * bodyK); pose.q.spine.premultiply(_q);
    _q.setFromAxisAngle(UP, y * 0.2 * bodyK); pose.q.chest.premultiply(_q);
    _q.setFromAxisAngle(UP, y * 0.3); _q2.setFromAxisAngle(AX, p * 0.45); pose.q.neck.premultiply(_q).multiply(_q2);
    _q.setFromAxisAngle(UP, y * 0.38); _q2.setFromAxisAngle(AX, p * 0.55); pose.q.head.premultiply(_q).multiply(_q2);
  }
}

const _LOCO_STILL = { speed: 0, dirX: 0, dirZ: 1, combat: true, turn: 0 };
const _m4 = new THREE.Matrix4(), _m4b = new THREE.Matrix4();
import { footFromAnchor as _footFromAnchor } from './ik.js';
