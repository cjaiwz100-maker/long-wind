// Actor: what the player and every enemy share — a Character (C) driven by an Animator (A), a ground-snapped
// kinematic body with knockback, a gameplay clip clock (CLIPS meta drives timing), motion warping, the swept blade
// sample (previous → current base/tip) and cached hurt capsules. Owner: gameplay (P).
//
// Displacement during actions ("motion warping"): when a clip has authored root motion (animator.sampleRoot), the
// animator's per-frame root delta is applied, rescaled so the move ends at the gameplay distance (magnetism toward
// the target, fixed dodge lengths) and clamped so a lunge never pushes through its target. Clips without authored
// root motion fall back to a smootherstep curve over meta.lunge. Root deltas are applied at the next integrate so
// the animator's world foot-planting always sees a consistent body transform.
//
// Per-frame order (driven by game.js):  think (player/AI) → integrate → pose (animator, secondary motion, blade).
import * as THREE from 'three';
import { Animator } from '../character/animator.js';
import { clamp, smootherstep, yawOf, toLocal } from './util.js';
import { gameMeta } from './moves.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3();
const _l = new THREE.Vector2();
const UP = new THREE.Vector3(0, 1, 0);
const LOCO = new Set(['idle', 'combatIdle', 'walk', 'run', 'sprint', 'walkBack', 'strafeL', 'strafeR']);

/** Gameplay timing for a clip: authored CLIPS meta, completed from the gameplay fallback table (moves.js). */
export const meta = (name) => gameMeta(name);
/** First hit window of a clip ([t0, t1] seconds) or null. */
export const hitWindow = (name) => { const m = meta(name); return m?.hit?.length ? m.hit[0] : null; };

export class Actor {
  constructor(game, ch, { id, kind, team, hp = 100, posture = 100, radius = 0.42 }) {
    this.game = game;
    this.ch = ch;
    this.id = id;
    this.kind = kind;
    this.team = team;
    const AnimatorClass = game.AnimatorClass ?? Animator;
    this.anim = new AnimatorClass(ch.rig, { heightAt: game.heightAt, normalAt: game.normalAt, style: kind === 'hero' ? 'hero' : 'bandit', kind });
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.vel = new THREE.Vector3();          // locomotion velocity (world, horizontal)
    this.knock = new THREE.Vector3();        // knockback velocity (decays)
    this.radius = radius;
    this.maxHp = hp; this.hp = hp;
    this.maxPosture = posture; this.posture = 0; this.postureCool = 0;
    this.alive = true;
    this.active = true;
    this.hop = 0;                            // vertical offset (leaps, sinking corpses)
    this.jolt = new THREE.Vector3(); this.joltV = new THREE.Vector3();   // hit recoil (visual only, spring)
    this.tilt = 0; this.tiltV = 0; this.tiltAxis = new THREE.Vector3(1, 0, 0);
    this.flinch = 0; this.flinchV = 0; this.flinchTwist = 0;   // spine/head bend away from a blow (model skins, spring)
    this.lift = 0; this.liftV = 0; this.airPitch = 0;            // launched off the ground by a heavy blow (ballistic)
    this.yawV = 0;                                               // spun by a blow (rad/s, decays)
    this.frozenPose = false;                 // corpses stop animating once the death clip has played
    // gameplay clip clock (mirrors the animator's action clock; timing always follows CLIPS meta)
    this.clip = null; this.clipT = 0; this.clipPrevT = 0; this.clipMeta = null; this.clipSpeed = 1; this.clipLoop = false;
    this.swingId = 0;
    this.hitSet = new Set();
    // motion warping / lunge
    this.lunge = { dir: new THREE.Vector3(), dist: 0, t0: 0, t1: 1, done: 0, stopAt: null, minGap: 0.9, scale: 1, authored: false };
    this.rmPending = new THREE.Vector3(); this.rmYaw = 0;
    // blade samples (world): prev frame → current frame
    this.base0 = new THREE.Vector3(); this.tip0 = new THREE.Vector3();
    this.base1 = new THREE.Vector3(); this.tip1 = new THREE.Vector3();
    this.bladeValid = false; this.tipSpeed = 0;
    this.caps = []; this._capsFrame = -1;
    this.events = [];
    this.locoState = { speed: 0, dirX: 0, dirZ: 1, combat: false, turn: 0 };
    this._lastYaw = 0;
    this.lookTarget = null;                  // Actor to look at (head/torso aim)
  }

  get group() { return this.ch.group; }
  /** Normalised clip time 0..1 of the current gameplay clip. */
  get clipU() { return this.clipMeta ? this.clipT / this.clipMeta.duration : 1; }
  get clipDone() { return !this.clipMeta || (!this.clipLoop && this.clipT >= this.clipMeta.duration); }

  place(x, z, yaw = this.yaw) {
    this.pos.set(x, this.game.heightAt(x, z), z);
    this.yaw = yaw; this._lastYaw = yaw;
    this.vel.set(0, 0, 0); this.knock.set(0, 0, 0); this.lunge.dist = 0; this.hop = 0;
    this.rmPending.set(0, 0, 0); this.rmYaw = 0;
    this.bladeValid = false;
    this.syncGroup();
  }

  /** Start an action clip. Gameplay timing uses this clock; the animator gets the same name/speed. */
  play(name, { fade = 0.1, speed = 1, loop } = {}) {
    const m = meta(name);
    if (!m) { console.warn('[game] unknown clip', name); return; }
    if (LOCO.has(name)) { this.stopAction(fade); return; }
    try { this.anim.play(name, { fade, speed, loop }); } catch (e) { console.warn('[game] anim.play failed', name, e); }
    this.clip = name; this.clipMeta = m; this.clipT = 0; this.clipPrevT = 0; this.clipSpeed = speed;
    this.clipLoop = loop ?? !!m.loop;
    this.frozenPose = false;
    // authored root motion? (warp it) — otherwise the fallback lunge curve is used when a lunge is requested
    const L = this.lunge;
    L.dist = 0; L.stopAt = null; L.scale = 1; L.requested = false; L.warpEnd = undefined;
    L.authored = false;
    if (typeof this.anim.sampleRoot === 'function') {
      try { this.anim.sampleRoot(name, m.duration, _v); L.authored = _v.lengthSq() > 1e-4; } catch { L.authored = false; }
    }
    this.rmPending.set(0, 0, 0); this.rmYaw = 0;
  }

  /** Leave the current action and return to locomotion. */
  stopAction(fade = 0.15) {
    if (this.clip) {
      if (typeof this.anim.stop === 'function') this.anim.stop(fade);
      else this.anim.play(this.locoState.combat ? 'combatIdle' : 'idle', { fade });
    }
    this.clip = null; this.clipMeta = null; this.clipT = 0; this.clipLoop = false; this.lunge.dist = 0; this.lunge.authored = false;
    this.rmPending.set(0, 0, 0); this.rmYaw = 0;
  }

  /** Did clip time cross `t` (clip seconds) this frame? */
  crossed(t) { return this.clipPrevT < t && this.clipT >= t; }
  /** Is clip time inside [a, b] this frame, or did this frame's interval overlap it? */
  inWindow(a, b) { return this.clipT >= a && this.clipPrevT <= b && this.clipT > 0; }

  /**
   * Move `dist` metres along world `dir` between clip times t0..t1 (the current clip), stopping `minGap` short of
   * `stopAt`. With authored root motion the authored path is kept and only rescaled to `dist`.
   */
  startLunge(dir, dist, t0, t1, stopAt = null, minGap = 0.95) {
    const L = this.lunge;
    L.dir.copy(dir).setY(0);
    if (L.dir.lengthSq() < 1e-6) L.dir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    L.dir.normalize();
    L.dist = dist; L.t0 = t0; L.t1 = Math.max(t1, t0 + 1e-3); L.done = 0; L.stopAt = stopAt; L.minGap = minGap;
    L.scale = 1; L.requested = true;
    if (L.authored && this.clip) {
      // authored displacement up to t1 (local, horizontal length)
      this.anim.sampleRoot(this.clip, L.t1, _v);
      const a = Math.hypot(_v.x, _v.z);
      if (a > 0.05) { L.scale = clamp(dist / a, 0, 3.5); L.warpEnd = L.t1; }
      else L.authored = false; // nothing authored before t1: use the gameplay curve for this move

    }
  }

  setLocomotion(speed, worldVelX, worldVelZ, combat, turn = 0) {
    const s = this.locoState;
    s.speed = speed; s.combat = combat; s.turn = turn;
    if (speed > 0.05) { toLocal(worldVelX, worldVelZ, this.yaw, _l); const n = Math.hypot(_l.x, _l.y) || 1; s.dirX = _l.x / n; s.dirZ = _l.y / n; }
    else { s.dirX = 0; s.dirZ = 1; }
    this.anim.setLocomotion(s);
  }

  faceTowards(x, z, maxRate, dt) {
    const target = yawOf(x - this.pos.x, z - this.pos.z);
    let d = target - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw += clamp(d, -maxRate * dt, maxRate * dt);
  }

  /** Physical step: clip clock, warped root motion / lunge, velocity, knockback, obstacles, ground. */
  integrate(dt) {
    if (this.clip) {
      this.clipPrevT = this.clipT;
      this.clipT += dt * this.clipSpeed;
      if (this.clipLoop && this.clipMeta && this.clipT >= this.clipMeta.duration) {
        this.clipT %= this.clipMeta.duration; this.clipPrevT = 0;
      }
    }
    const L = this.lunge;
    if (this.clip && L.authored) {
      // authored root delta from the last pose, rotated to world and warped
      const past = L.warpEnd !== undefined && this.clipPrevT > L.warpEnd;
      const k = !L.requested ? 1 : past ? Math.min(1, L.scale) : L.scale;
      _w.copy(this.rmPending).applyAxisAngle(UP, this.yaw).multiplyScalar(k);
      _w.y = 0;
      if (L.stopAt) {
        const gx = L.stopAt.x - this.pos.x, gz = L.stopAt.z - this.pos.z, gap = Math.hypot(gx, gz);
        const along = (_w.x * gx + _w.z * gz) / (gap || 1);
        if (along > 0) { const allow = Math.max(0, gap - L.minGap); if (along > allow) _w.multiplyScalar(allow / along); }
      }
      this.pos.add(_w);
      this.yaw += this.rmYaw;
    } else if (L.dist !== 0 && this.clip) {
      const f = smootherstep(L.t0, L.t1, this.clipT);
      let d = L.dist * f - L.done;
      L.done += d;
      if (L.stopAt && d > 0) {
        const gap = Math.hypot(L.stopAt.x - this.pos.x, L.stopAt.z - this.pos.z);
        d = Math.min(d, Math.max(0, gap - L.minGap));
      }
      this.pos.addScaledVector(L.dir, d);
    }
    this.rmPending.set(0, 0, 0); this.rmYaw = 0;
    if (this.yawV) { this.yaw += this.yawV * dt; this.yawV *= Math.exp(-8 * dt); if (Math.abs(this.yawV) < 0.02) this.yawV = 0; }
    this.pos.addScaledVector(this.vel, dt);
    this.pos.addScaledVector(this.knock, dt);
    this.knock.multiplyScalar(Math.exp(-7 * dt));
    this.game.collideStatic(this.pos, this.radius);
    this.pos.y = this.game.heightAt(this.pos.x, this.pos.z);
    // posture recovers when left alone
    if (this.postureCool > 0) this.postureCool -= dt;
    else if (this.posture > 0) this.posture = Math.max(0, this.posture - this.maxPosture * 0.12 * dt);
  }

  /** Visual recoil from a blow: the body is shoved along dir and tips away from it, then springs back. */
  recoil(dirX, dirZ, k = 1) {
    const n = Math.hypot(dirX, dirZ) || 1;
    this.joltV.x += dirX / n * 2.6 * k; this.joltV.z += dirZ / n * 2.6 * k; this.joltV.y -= 0.5 * k;
    this.tiltAxis.set(dirZ / n, 0, -dirX / n);          // tip the top away from the blade
    this.tiltV += 3.2 * k;
    // the spine whips away from the blow and the head snaps after it (the whole-body tilt alone reads as a plank)
    this.flinchV += 7.5 * k;
    this.flinchTwist = (Math.random() < 0.5 ? -1 : 1) * (0.25 + 0.2 * Math.random());
  }

  /** Turn the body by a blow: angular velocity (rad/s); ~1/8 of it is the total turn. */
  spin(w) { this.yawV += w; }

  /** Throw the body up (m/s); it falls back under gravity. onLand() is called when it touches down. */
  launch(vy) {
    this.liftV = Math.max(this.liftV, vy);
    if (this.lift <= 0) this.lift = 1e-3;
  }
  onLand() {}

  _air(dt) {
    if (this.lift <= 0 && this.liftV <= 0) return;
    this.liftV -= 22 * dt;
    this.lift += this.liftV * dt;
    if (this.lift <= 0) { this.lift = 0; const v = this.liftV; this.liftV = 0; this.onLand(-v); }
  }

  syncGroup(dt = 0) {
    const g = this.ch.group;
    if (dt > 0) {
      // critically-damped-ish springs (ω ≈ 22): a ~6–10 cm shove and a few degrees of tilt, gone in ~0.25 s
      const w = 22, z = 0.55, k = Math.min(dt, 1 / 30);
      this.joltV.addScaledVector(this.jolt, -w * w * k).multiplyScalar(Math.max(0, 1 - 2 * z * w * k));
      this.jolt.addScaledVector(this.joltV, k);
      this.tiltV += (-w * w * this.tilt) * k; this.tiltV *= Math.max(0, 1 - 2 * z * w * k);
      this.tilt += this.tiltV * k;
      // looser spring for the spine: it overshoots once, like a body taking a blow
      const wf = 17, zf = 0.38;
      this.flinchV += (-wf * wf * this.flinch) * k; this.flinchV *= Math.max(0, 1 - 2 * zf * wf * k);
      this.flinch += this.flinchV * k;
      this._air(dt);
    }
    const sk = this.ch.skin;
    if (sk) { sk.flinch = this.flinch; sk.flinchAxis = this.tiltAxis; sk.flinchTwist = this.flinchTwist; }
    g.position.set(this.pos.x + this.jolt.x, this.pos.y + this.hop + this.lift + this.jolt.y, this.pos.z + this.jolt.z);
    g.rotation.set(0, this.yaw, 0);
    const tilt = this.tilt + this.airPitch;
    if (Math.abs(tilt) > 1e-4) g.rotateOnWorldAxis(this.tiltAxis, tilt);
    g.updateMatrixWorld(true);
  }

  /** Pose + secondary motion + blade sample. Returns animator events (also stored in this.events). */
  pose(dt, t) {
    this.syncGroup(dt);
    let out = null;
    if (!this.frozenPose) {
      if (this.lookTarget && typeof this.anim.lookAt === 'function') this.anim.lookAt(this.lookTarget.chest(_v));
      else if (this._looking && typeof this.anim.lookAt === 'function') this.anim.lookAt(null);
      this._looking = !!this.lookTarget;
      try { out = this.anim.update(dt, this.ch.group); } catch (e) { if (!this._animErr) { console.error('[game] animator update failed', e); this._animErr = true; } }
    }
    this.events = out?.events ?? [];
    if (out && this.clip) { this.rmPending.add(out.rootMotion); this.rmYaw += out.rootYaw || 0; }
    this.ch.group.updateMatrixWorld(true);
    try { this.ch.update(dt, t); } catch (e) { if (!this._chErr) { console.error('[game] character update failed', e); this._chErr = true; } }
    this.sampleBlade(dt);
    return this.events;
  }

  sampleBlade(dt) {
    const sw = this.ch.sword;
    if (!sw?.base || !sw?.tip) return;
    this.base0.copy(this.base1); this.tip0.copy(this.tip1);
    sw.base.getWorldPosition(this.base1);
    sw.tip.getWorldPosition(this.tip1);
    if (!this.bladeValid) { this.base0.copy(this.base1); this.tip0.copy(this.tip1); this.bladeValid = true; }
    this.tipSpeed = dt > 1e-5 ? this.tip0.distanceTo(this.tip1) / dt : this.tipSpeed;
  }

  /** World-space hurt capsules, refreshed at most once per frame. */
  capsules() {
    const f = this.game.frame;
    if (this._capsFrame !== f) {
      this._capsFrame = f;
      try { this.ch.hurtCapsules(this.caps); } catch { this.caps.length = 0; }
      if (!this.caps.length) {
        // fallback body capsule if the character cannot provide any
        this.caps.push({ a: this.pos.clone().setY(this.pos.y + 0.3), b: this.pos.clone().setY(this.pos.y + 1.5), r: 0.3, part: 'torso' });
      }
    }
    return this.caps;
  }

  /** Chest point (world) for aiming, VFX and camera framing. */
  chest(out = new THREE.Vector3()) { return out.set(this.pos.x, this.pos.y + 1.3 + this.hop + this.lift, this.pos.z); }
  forward(out = new THREE.Vector3()) { return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  distTo(o) { return Math.hypot(o.pos.x - this.pos.x, o.pos.z - this.pos.z); }
  /** Angle (rad, signed) from this actor's facing to the other actor. */
  angleTo(o) {
    const y = yawOf(o.pos.x - this.pos.x, o.pos.z - this.pos.z) - this.yaw;
    return Math.atan2(Math.sin(y), Math.cos(y));
  }
  turnRate(dt) {
    let d = this.yaw - this._lastYaw; d = Math.atan2(Math.sin(d), Math.cos(d));
    this._lastYaw = this.yaw;
    return dt > 1e-5 ? d / dt : 0;
  }
  addPosture(v) {
    this.posture = Math.min(this.maxPosture, this.posture + v);
    this.postureCool = 1.6;
    return this.posture >= this.maxPosture;
  }
  applyKnock(dirX, dirZ, speed) {
    const n = Math.hypot(dirX, dirZ) || 1;
    this.knock.x += dirX / n * speed; this.knock.z += dirZ / n * speed;
  }
}
