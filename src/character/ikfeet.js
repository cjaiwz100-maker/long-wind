// Foot planting: world-space foot locks, automatic re-steps, terrain following and ground alignment.
// Owner: animation (A).
//
// Every clip (and the procedural gait) outputs, per foot, a desired flat-foot anchor in rig space plus a plant
// weight. Here the anchor is carried into the world (terrain height via heightAt, tilt via the ground normal):
//   · weight ≥ 0.6 → the foot PLANTS at its current world position and stays there however the body moves or
//     turns (no sliding, pivots are real). If the desired anchor drifts too far (turn in place, a clip that
//     wants a different stance, a gameplay lunge), the foot takes an automatic STEP to the new spot.
//   · weight ≤ 0.4 → the foot is FREE and follows the desired anchor; the offset it had at release decays
//     smoothly, so lift-off never pops.
// The result is resolved back into rig space as ankle targets + foot rotations for the leg IK.
import * as THREE from 'three';
import { footFromAnchor, D2R } from './ik.js';

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _n = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _qt = new THREE.Quaternion();
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

class FootState {
  constructor() {
    this.mode = 'free';                   // 'free' | 'planted' | 'step'
    this.P = new THREE.Vector3();         // world anchor while planted
    this.Q = new THREE.Quaternion();      // world yaw/roll while planted
    this.P0 = new THREE.Vector3(); this.Q0 = new THREE.Quaternion();
    this.u = 0; this.dur = 0.22; this.h = 0.07;
    this.rel = new THREE.Vector3();       // release offset (world) decaying after unlock
    this.relQ = new THREE.Quaternion();
    this.relK = 0;
    this.land = new THREE.Vector3();      // touch-down offset (world) decaying after a plant
    this.landK = 0;
    this.outW = new THREE.Vector3();      // last world anchor output
    this.outQW = new THREE.Quaternion();
    this.valid = false;
  }
}

export class FootPlanter {
  constructor(solver, { heightAt, normalAt } = {}) {
    this.solver = solver;
    this.heightAt = heightAt || null;
    this.normalAt = normalAt || null;
    this.feet = [new FootState(), new FootState()];
    this.ankles = [new THREE.Vector3(), new THREE.Vector3()];  // rig space (scaled)
    this.footQ = [new THREE.Quaternion(), new THREE.Quaternion()];
    this.anchorsRig = [new THREE.Vector3(), new THREE.Vector3()];
    this.rootM = new THREE.Matrix4(); this.rootInv = new THREE.Matrix4();
    this.rootQ = new THREE.Quaternion(); this.rootQInv = new THREE.Quaternion();
    this.rootP = new THREE.Vector3(); this._s = new THREE.Vector3();
    this.predM = new THREE.Matrix4(); this.predQ = new THREE.Quaternion(); this._p = new THREE.Vector3();
    this.hop = 0;
    this.autoStep = true;
    this.stepThreshold = 0.13;   // m (rig units)
    this.stepYaw = 32 * D2R;
  }

  reset() { for (const f of this.feet) { f.mode = 'free'; f.valid = false; f.relK = 0; } }

  ground(x, z) { return this.heightAt ? this.heightAt(x, z) : this.rootP.y - this.hop; }

  /**
   * @param dt seconds · pose Pose (rig space, unscaled) · rootMatrixWorld the rig root's world matrix now
   * @param opts { autoStep, events[] (receives step events), predict?: Matrix4 — where the root will be once this
   *   frame's root motion is applied; desired anchors are placed with it, outputs resolve against the current root }
   */
  update(dt, pose, rootMatrixWorld, opts) {
    const s = this.solver.s;
    this.rootM.copy(rootMatrixWorld);
    this.rootM.decompose(this.rootP, this.rootQ, this._s);
    this.rootInv.copy(this.rootM).invert();
    this.rootQInv.copy(this.rootQ).invert();
    this.predM.copy(opts.predict ?? rootMatrixWorld);
    this.predM.decompose(this._p, this.predQ, this._s);
    const g0 = this.heightAt ? this.heightAt(this.rootP.x, this.rootP.z) : this.rootP.y;
    this.hop = this.rootP.y - g0;
    const auto = opts.autoStep && this.autoStep;
    // which foot has the larger drift gets to step first
    let stepping = this.feet[0].mode === 'step' || this.feet[1].mode === 'step';
    const err = [0, 0];

    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      // desired anchor in the world, on the terrain
      const D = _v.copy(pose.foot[i]).multiplyScalar(s).applyMatrix4(this.predM);
      const gy = this.ground(D.x, D.z);
      D.y = gy + pose.foot[i].y * s + this.hop;
      const DQ = _q.copy(this.predQ).multiply(pose.footQ[i]);
      const w = pose.lock[i];
      if (!f.valid) { f.P.copy(D); f.Q.copy(DQ); f.outW.copy(D); f.outQW.copy(DQ); f.mode = w > 0.5 ? 'planted' : 'free'; f.valid = true; }

      if (f.mode === 'planted') {
        if (w < 0.4) {
          // release: remember the offset so the free foot starts exactly where it was
          f.mode = 'free';
          f.rel.subVectors(f.P, D); f.relQ.copy(DQ).invert().premultiply(f.Q); f.relK = 1;
        } else {
          const dx = D.x - f.P.x, dz = D.z - f.P.z;
          const yawErr = 2 * Math.acos(Math.min(1, Math.abs(_q2.copy(f.Q).invert().multiply(DQ).w)));
          err[i] = Math.hypot(dx, dz) / s + yawErr * 0.25;
          if (auto && !stepping && (Math.hypot(dx, dz) > this.stepThreshold * s || yawErr > this.stepYaw)) {
            f.mode = 'step'; f.u = 0; f.P0.copy(f.P); f.Q0.copy(f.Q);
            const dist = Math.hypot(dx, dz) / s;
            // quick pivot steps when the body is turning fast (large yaw error), slower shuffles otherwise
            const urgency = Math.min(1, Math.max(0, (yawErr - this.stepYaw) / 1.2));
            f.dur = Math.min(0.32, 0.17 + dist * 0.25) * (1 - 0.4 * urgency); f.h = Math.min(0.1, 0.035 + dist * 0.12 + urgency * 0.02);
            stepping = true;
          }
        }
      } else if (f.mode === 'free') {
        if (w > 0.6) {
          // touch-down: lock on the AUTHORED spot (clips and the gait both put the foot where it should land), and
          // ease the few centimetres of remaining lag out over ~50 ms so the contact never pops
          f.mode = 'planted'; f.P.copy(D); f.Q.copy(DQ);
          f.land.subVectors(f.outW, D); f.land.y = Math.max(0, f.land.y); f.landK = f.land.lengthSq() < 0.25 ? 1 : 0;
          opts.events?.push({ type: 'step', foot: i === 0 ? 'L' : 'R', pos: f.P.clone() });
        }
      }

      // ---- output ----
      const O = f.outW, OQ = f.outQW;
      if (f.mode === 'planted') {
        O.copy(f.P); OQ.copy(f.Q);
        if (w < 1) { O.lerp(D, 1 - w); OQ.slerp(DQ, 1 - w); }
        if (f.landK > 1e-3) { f.landK *= Math.exp(-dt / 0.05); O.addScaledVector(f.land, f.landK); }
      }
      else if (f.mode === 'step') {
        f.u = Math.min(1, f.u + dt / f.dur);
        const e = f.u * f.u * (3 - 2 * f.u);
        O.lerpVectors(f.P0, D, e);
        O.y += f.h * s * Math.sin(Math.PI * f.u);
        OQ.slerpQuaternions(f.Q0, DQ, e);
        if (f.u >= 1) {
          f.mode = 'planted'; f.P.copy(D); f.Q.copy(DQ);
          opts.events?.push({ type: 'step', foot: i === 0 ? 'L' : 'R', pos: f.P.clone(), shuffle: true });
        }
        if (w < 0.4) { f.mode = 'free'; f.rel.subVectors(O, D); f.relQ.copy(DQ).invert().premultiply(OQ); f.relK = 1; }
      } else {
        f.relK *= Math.exp(-dt / 0.09);
        O.copy(D).addScaledVector(f.rel, f.relK);
        OQ.copy(DQ);
        if (f.relK > 1e-3) { _qt.identity().slerp(f.relQ, f.relK); OQ.premultiply(_qt); }
        // never under the terrain
        const gy2 = this.ground(O.x, O.z) + this.hop;
        if (O.y < gy2) O.y = gy2;
      }

      // ---- terrain tilt (only near the ground) ----
      const hAbove = O.y - (this.ground(O.x, O.z) + this.hop);
      const tiltW = 1 - sstep(0.02 * s, 0.14 * s, hAbove);
      _qt.copy(OQ);
      if (this.normalAt && tiltW > 0) {
        this.normalAt(O.x, O.z, _n);
        const ang = Math.acos(Math.min(1, _n.y));
        const lim = 28 * D2R;
        _q2.setFromUnitVectors(UP, _n);
        if (ang > lim) _q2.slerp(_qi.identity(), 1 - lim / ang);
        _q2.slerp(_qi.identity(), 1 - tiltW);
        _qt.premultiply(_q2);
      }
      // ---- back to rig space ----
      const A = this.anchorsRig[i].copy(O).applyMatrix4(this.rootInv);
      _q2.copy(this.rootQInv).multiply(_qt);
      footFromAnchor(A, _q2, pose.pitch[i], s, this.ankles[i], this.footQ[i]);
    }
    return this;
  }
}
const _qi = new THREE.Quaternion();
