// Kinematics core for the animator. Owner: animation (A).
//
// The animator works in "rig space" (the character's root frame: +X left, +Y up, +Z forward, metres, unscaled
// skeleton units). A pose is a small set of channels — pelvis offset, spine/neck/head rotations, IK targets for
// both hands (grip point + orientation) and both feet (ankle anchor + orientation) — see `Pose`. `RigSolver`
// turns a Pose into bone rotations: forward kinematics down the spine, then analytic two-bone IK for the arms
// (elbow chosen so the forearm lines up with the fist, anatomical pole, wrist-swing limit, forearm twist split)
// and the legs (soft reach clamp so knees never pop, knee over the toes). Every frame starts from rest, so
// nothing accumulates. No allocations in the per-frame paths.
import * as THREE from 'three';
const _ergoX = new THREE.Vector3(), _ergoD = new THREE.Vector3();

export const D2R = Math.PI / 180;
const EPS = 1e-6;

// ---------------------------------------------------------------------------------------------------------
// small math helpers (all write into `out`)
// ---------------------------------------------------------------------------------------------------------
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();

/** Quaternion from Euler degrees [pitch(X), yaw(Y), roll(Z)] in YXZ order (yaw, then pitch, then roll). */
const _eu = new THREE.Euler(0, 0, 0, 'YXZ');
export function quatFromDeg(p, y, r, out) {
  _eu.set(p * D2R, y * D2R, r * D2R, 'YXZ');
  return out.setFromEuler(_eu);
}

/** Rotation mapping orthonormal frame (a1, b1, a1×b1) onto (a2, b2, a2×b2). Inputs must be unit + orthogonal. */
export function quatFromFrames(a1, b1, a2, b2, out) {
  _z.crossVectors(a1, b1);
  _m1.makeBasis(a1, b1, _z);
  _z.crossVectors(a2, b2);
  _m2.makeBasis(a2, b2, _z);
  _m1.transpose();
  _m2.multiply(_m1);
  return out.setFromRotationMatrix(_m2);
}

/** Quaternion whose local +Z = `fwd` and local +Y ≈ `up` (orthonormalised). */
export function quatLook(fwd, up, out) {
  _z.copy(fwd).normalize();
  _x.crossVectors(up, _z);
  if (_x.lengthSq() < EPS) _x.set(1, 0, 0).cross(_z);
  _x.normalize();
  _y.crossVectors(_z, _x);
  _m1.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m1);
}

/** Split q into swing·twist with twist about unit `axis`. Writes both. */
export function swingTwist(q, axis, swing, twist) {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  twist.set(axis.x * d, axis.y * d, axis.z * d, q.w);
  const l = Math.hypot(twist.x, twist.y, twist.z, twist.w);
  if (l < EPS) twist.identity(); else { twist.x /= l; twist.y /= l; twist.z /= l; twist.w /= l; }
  swing.copy(twist).invert().premultiply(q); // swing = q * twist^-1
  return swing;
}

/** Angle (rad) of a unit quaternion. */
export function quatAngle(q) { return 2 * Math.acos(Math.min(1, Math.abs(q.w))); }

/** Scale the rotation angle of q by k (slerp from identity), in place. */
const _qi = new THREE.Quaternion();
export function quatScale(q, k) { _qi.identity(); return q.copy(_qi.slerp(q, k)); }

/**
 * Analytic two-bone IK. Returns the middle joint position in `outMid` (e.g. elbow/knee).
 * @param a root joint (shoulder/hip) · t target end (wrist/ankle) · poleDir preferred bend direction (unit-ish)
 * @param soft 0..1 fraction of chain length used for soft reach (Nicholas' soft IK) — prevents knee/elbow pops.
 * The effective end position (possibly pulled back toward `a`) is written into `outEnd`.
 */
const _f = new THREE.Vector3(), _p = new THREE.Vector3();
export function twoBoneIK(a, t, poleDir, l1, l2, soft, outMid, outEnd) {
  _f.subVectors(t, a);
  let d = _f.length();
  const L = l1 + l2;
  if (d < EPS) { _f.set(0, -1, 0); d = EPS; } else _f.multiplyScalar(1 / d);
  // soft IK: past (L - s) the reach approaches L asymptotically instead of snapping straight
  const s = soft * L, ds = L - s;
  if (s > 0 && d > ds) d = ds + s * (1 - Math.exp(-(d - ds) / s));
  d = Math.min(d, L * 0.9995);
  d = Math.max(d, Math.abs(l1 - l2) + 1e-4);
  outEnd.copy(a).addScaledVector(_f, d);
  // bend plane from the pole direction, orthogonalised against the chain axis
  _p.copy(poleDir).addScaledVector(_f, -_p.dot(_f));
  if (_p.lengthSq() < EPS) { _p.set(0, 0, 1).addScaledVector(_f, -_f.z); if (_p.lengthSq() < EPS) _p.set(1, 0, 0); }
  _p.normalize();
  const v = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const g = Math.sqrt(Math.max(0, l1 * l1 - v * v));
  outMid.copy(a).addScaledVector(_f, v).addScaledVector(_p, g);
  return d;
}

// ---------------------------------------------------------------------------------------------------------
// Grip: how the weapon sits in the fist. The contract socket (weapon.R: blade +Z, edges ±Y) is rotated at runtime
// so the edges line up with the knuckles (anatomical sword grip: a chop leads with the edge, not the flat) and the
// handle lies diagonally across the palm (grip obliquity), which keeps the wrist straight when the blade points
// along the forearm. Both are local rotations of the socket bone only (no skin weights), so hit sampling via the
// blade's base/tip follows automatically.
// ---------------------------------------------------------------------------------------------------------
export const GRIP = { roll: 90, oblique: 20 };
const _sq = new THREE.Quaternion(), _sq2 = new THREE.Quaternion();
/** Socket rotation (hand → weapon frame) for side sgn (+1 L, −1 R). */
export function gripQ(sgn, out) {
  _sq.setFromAxisAngle(_y.set(0, 1, 0), sgn * GRIP.oblique * D2R);
  _sq2.setFromAxisAngle(_z.set(0, 0, 1), -sgn * GRIP.roll * D2R);
  return out.copy(_sq).multiply(_sq2);
}
export const GRIP_R = gripQ(-1, new THREE.Quaternion());
export const GRIP_L = gripQ(1, new THREE.Quaternion());
export const GRIP_R_INV = GRIP_R.clone().invert();
export const GRIP_L_INV = GRIP_L.clone().invert();
const _twQ = new THREE.Quaternion(), _flipX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);

// ---------------------------------------------------------------------------------------------------------
// Pose: the canonical, blendable description of a body configuration (rig space, unscaled units)
// ---------------------------------------------------------------------------------------------------------
export const ROT_CHANNELS = ['hips', 'spine', 'chest', 'neck', 'head', 'shoulder.L', 'shoulder.R', 'toes.L', 'toes.R'];

export class Pose {
  constructor() {
    this.hips = new THREE.Vector3();                     // pelvis offset from rest (m)
    this.q = {};                                          // local rotations of the FK bones
    for (const n of ROT_CHANNELS) this.q[n] = new THREE.Quaternion();
    this.hand = [new THREE.Vector3(), new THREE.Vector3()];       // [L, R] grip point (rig space)
    this.handQ = [new THREE.Quaternion(), new THREE.Quaternion()]; // [L, R] hand orientation (rig space)
    this.foot = [new THREE.Vector3(), new THREE.Vector3()];       // [L, R] flat-foot ankle anchor on the ground (+y = lift)
    this.footQ = [new THREE.Quaternion(), new THREE.Quaternion()]; // [L, R] foot yaw/roll (rig space), pitch separate
    this.pitch = [0, 0];                                  // rocker pitch (rad): + toes up (heel pivot), − heel up (ball pivot)
    this.lock = [1, 1];                                   // foot plant weight (world lock)
    this.flare = [0, 0];                                  // elbow flare (rad) around the shoulder→wrist axis
    this.twoHand = 0;                                     // 1 = left hand grips the weapon below the right hand
  }
  copy(p) {
    this.hips.copy(p.hips);
    for (const n of ROT_CHANNELS) this.q[n].copy(p.q[n]);
    for (let i = 0; i < 2; i++) {
      this.hand[i].copy(p.hand[i]); this.handQ[i].copy(p.handQ[i]);
      this.foot[i].copy(p.foot[i]); this.footQ[i].copy(p.footQ[i]);
      this.pitch[i] = p.pitch[i]; this.lock[i] = p.lock[i]; this.flare[i] = p.flare[i];
    }
    this.twoHand = p.twoHand;
    return this;
  }
  /** this = lerp(this, p, w) per channel (slerp for rotations). */
  blend(p, w) {
    if (w <= 0) return this;
    if (w >= 1) return this.copy(p);
    this.hips.lerp(p.hips, w);
    for (const n of ROT_CHANNELS) this.q[n].slerp(p.q[n], w);
    for (let i = 0; i < 2; i++) {
      this.hand[i].lerp(p.hand[i], w); this.handQ[i].slerp(p.handQ[i], w);
      this.foot[i].lerp(p.foot[i], w); this.footQ[i].slerp(p.footQ[i], w);
      this.pitch[i] += (p.pitch[i] - this.pitch[i]) * w;
      this.lock[i] += (p.lock[i] - this.lock[i]) * w;
      this.flare[i] += (p.flare[i] - this.flare[i]) * w;
    }
    this.twoHand += (p.twoHand - this.twoHand) * w;
    return this;
  }
  /** Masked blend: upper-body channels with weight wu, lower-body channels with wl. */
  blendMasked(p, wu, wl) {
    if (wl > 0) {
      this.hips.lerp(p.hips, wl);
      this.q.hips.slerp(p.q.hips, wl);
      for (let i = 0; i < 2; i++) {
        this.foot[i].lerp(p.foot[i], wl); this.footQ[i].slerp(p.footQ[i], wl);
        this.pitch[i] += (p.pitch[i] - this.pitch[i]) * wl;
        this.lock[i] += (p.lock[i] - this.lock[i]) * wl;
      }
      this.q['toes.L'].slerp(p.q['toes.L'], wl); this.q['toes.R'].slerp(p.q['toes.R'], wl);
    }
    if (wu > 0) {
      this.q.spine.slerp(p.q.spine, wu * 0.85 + wl * 0.15);
      for (const n of ['chest', 'neck', 'head', 'shoulder.L', 'shoulder.R']) this.q[n].slerp(p.q[n], wu);
      for (let i = 0; i < 2; i++) {
        this.hand[i].lerp(p.hand[i], wu); this.handQ[i].slerp(p.handQ[i], wu);
        this.flare[i] += (p.flare[i] - this.flare[i]) * wu;
      }
      this.twoHand += (p.twoHand - this.twoHand) * wu;
    }
    return this;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Foot geometry (unscaled): offsets from the ankle (foot bone origin) in the foot frame
// ---------------------------------------------------------------------------------------------------------
export const FOOT = {
  ankleH: 0.085,
  heel: new THREE.Vector3(0, -0.085, -0.055),   // heel contact
  ball: new THREE.Vector3(0, -0.085, 0.13),     // ball-of-foot contact
};

const _fq = new THREE.Quaternion(), _fp = new THREE.Quaternion(), _fv = new THREE.Vector3(), _fv2 = new THREE.Vector3();
const AX = new THREE.Vector3(1, 0, 0);
/**
 * Ankle position + full foot rotation from a flat anchor (ground point under the ankle, +y = lift), a yaw/roll
 * rotation and a rocker pitch: pitch > 0 lifts the toes pivoting on the heel, pitch < 0 lifts the heel pivoting
 * on the ball. Scale `s` applies to the foot geometry.
 */
export function footFromAnchor(anchor, qYaw, pitch, s, outAnkle, outQ) {
  _fp.setFromAxisAngle(AX, -pitch);
  outQ.copy(qYaw).multiply(_fp);
  outAnkle.copy(anchor);
  outAnkle.y += FOOT.ankleH * s;
  if (pitch !== 0) {
    const c = pitch > 0 ? FOOT.heel : FOOT.ball;
    _fv.copy(c).multiplyScalar(s).applyQuaternion(qYaw);   // contact offset when flat
    _fv2.copy(c).multiplyScalar(s).applyQuaternion(outQ);  // contact offset when pitched
    outAnkle.add(_fv).sub(_fv2);                           // contact stays put, the ankle rotates around it
  }
  return outAnkle;
}

// ---------------------------------------------------------------------------------------------------------
// RigSolver: Pose → bone local rotations
// ---------------------------------------------------------------------------------------------------------
const ARM = [
  { side: 'L', sgn: 1 },
  { side: 'R', sgn: -1 },
];

export class RigSolver {
  constructor(rig) {
    const B = rig.bones;
    this.B = B;
    this.s = (B.hips?.position.y ?? 0.98) / 0.98;       // rig scale relative to the contract skeleton
    this.twoHandGap = rig.twoHandGap ?? 0.105;          // grip spacing along the handle (katana ≈ 0.165: right at the tsuba, left at the kashira)
    this.twoHandReach = 0.56;                          // min shoulder → grip distance with both hands on the hilt (elbows ≈ 140°)
    this._h1 = new THREE.Vector3();
    this._handR = new THREE.Quaternion(); this._gripR = new THREE.Vector3();
    const off = (n) => (B[n] ? B[n].position.clone() : new THREE.Vector3());
    this.rest = {};
    for (const n of Object.keys(B)) this.rest[n] = off(n);
    this.hipsRest = off('hips');
    const r = this.rest, s = this.s;
    this.arm = ARM.map(({ side, sgn }) => ({
      side, sgn,
      l1: r[`lowerArm.${side}`].length(), l2: r[`hand.${side}`].length(),
      grip: r[`weapon.${side}`].clone(),                 // grip point relative to the hand bone (hand frame)
      axis: new THREE.Vector3(sgn, 0, 0),                // bone axis in the rest frame
      nRest: new THREE.Vector3(0, -sgn, 0),              // elbow hinge normal in the rest frame
    }));
    // legs: the rest thigh/shin offsets are not exactly vertical (the ankle sits 2.5 cm behind the knee), so each
    // segment is aimed along its real rest direction; the knee hinge (+X) is perpendicular to both.
    this.leg = ['L', 'R'].map((side) => ({
      side,
      l1: r[`lowerLeg.${side}`].length(), l2: r[`foot.${side}`].length(),
      axis1: r[`lowerLeg.${side}`].clone().normalize(), axis2: r[`foot.${side}`].clone().normalize(),
      nRest: new THREE.Vector3(1, 0, 0),
    }));
    this.legLen = (this.leg[0].l1 + this.leg[0].l2);
    this.armLen = (this.arm[0].l1 + this.arm[0].l2);
    // world (rig-space) scratch transforms
    this.P = {}; this.Q = {};
    for (const n of Object.keys(B)) { this.P[n] = new THREE.Vector3(); this.Q[n] = new THREE.Quaternion(); }
    this._t = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), d: new THREE.Vector3(), e: new THREE.Vector3(),
      q1: new THREE.Quaternion(), q2: new THREE.Quaternion(), q3: new THREE.Quaternion(), q4: new THREE.Quaternion(), q5: new THREE.Quaternion() };
    this.debug = { elbow: [new THREE.Vector3(), new THREE.Vector3()], knee: [new THREE.Vector3(), new THREE.Vector3()], wrist: [new THREE.Vector3(), new THREE.Vector3()], ankle: [new THREE.Vector3(), new THREE.Vector3()] };
    this.wristLimit = 72 * D2R;
    this.twistSplit = 0.65; // forearm share of the wrist twist (rest on the hand)
  }

  /** FK: rig-space transform of `name` from its parent's already computed transform and a local rotation. */
  _fk(name, parent, qLocal) {
    const P = this.P, Q = this.Q;
    P[name].copy(this.rest[name]).applyQuaternion(Q[parent]).add(P[parent]);
    Q[name].copy(Q[parent]).multiply(qLocal);
  }

  /**
   * Compute the torso chain (hips → head, shoulders) in rig space for pose `pose` WITHOUT touching bones.
   * Used for chest-space authoring and look-at before the full solve.
   */
  torso(pose) {
    const P = this.P, Q = this.Q, s = this.s;
    P.hips.copy(pose.hips).multiplyScalar(s).add(this.hipsRest);
    Q.hips.copy(pose.q.hips);
    this._fk('spine', 'hips', pose.q.spine);
    this._fk('chest', 'spine', pose.q.chest);
    this._fk('neck', 'chest', pose.q.neck);
    this._fk('head', 'neck', pose.q.head);
    this._fk('shoulder.L', 'chest', pose.q['shoulder.L']);
    this._fk('shoulder.R', 'chest', pose.q['shoulder.R']);
    this._fk('upperArm.L', 'shoulder.L', _qi.identity());
    this._fk('upperArm.R', 'shoulder.R', _qi.identity());
    this._fk('upperLeg.L', 'hips', _qi.identity());
    this._fk('upperLeg.R', 'hips', _qi.identity());
  }

  /** Highest pelvis y offset (rig units) for which both legs still reach their ankles (with margin). */
  maxPelvisDrop(pose, ankles, margin = 0.992) {
    // returns the required downward correction (≥0) of the pelvis so each ankle is within reach
    let need = 0;
    for (let i = 0; i < 2; i++) {
      const leg = this.leg[i];
      const h = this.P[`upperLeg.${leg.side}`], a = ankles[i];
      const L = (leg.l1 + leg.l2) * margin;
      const dx = a.x - h.x, dz = a.z - h.z, dy = h.y - a.y;
      const horiz2 = dx * dx + dz * dz;
      if (horiz2 >= L * L) { need = Math.max(need, dy + 0.02); continue; }
      const maxDy = Math.sqrt(L * L - horiz2);
      if (dy > maxDy) need = Math.max(need, dy - maxDy);
    }
    return need / this.s;
  }

  /**
   * Full solve. `ankles`/`footQs` are rig-space ankle positions (scaled) + foot rotations (already resolved by the
   * foot-planting stage). Hands come from the pose (unscaled → scaled here).
   */
  apply(pose, ankles, footQs) {
    const B = this.B, P = this.P, Q = this.Q, s = this.s, T = this._t;
    this.torso(pose);
    // FK bones
    B.hips.position.copy(P.hips);
    B.hips.quaternion.copy(pose.q.hips);
    for (const n of ['spine', 'chest', 'neck', 'head', 'shoulder.L', 'shoulder.R']) if (B[n]) B[n].quaternion.copy(pose.q[n]);

    // ---- two-handed reach: a sword held in both hands is carried out in front on long arms (elbows soft, never
    // folded against the ribs). Both grips are checked against their shoulders; if either is too close the whole
    // weapon is pushed out along the chest's heading.
    const h1 = this._h1.copy(pose.hand[1]);
    if (pose.twoHand > 0.001) {
      const ax = _ergoD.set(0, 0, 1).applyQuaternion(_twQ.copy(pose.handQ[1]).multiply(GRIP_R));   // blade axis
      const fwd = _ergoX.set(0, 0, 1).applyQuaternion(Q.chest); fwd.y = 0; fwd.normalize();
      const want = this.twoHandReach * s;
      for (let it = 0; it < 4; it++) {
        const R = T.a.copy(h1).multiplyScalar(s);
        const L = T.b.copy(R).addScaledVector(ax, -this.twoHandGap * s);
        const need = Math.max(want - L.distanceTo(P['upperArm.L']), want - R.distanceTo(P['upperArm.R']), 0) * Math.min(1, pose.twoHand);
        if (need < 1e-4) break;
        h1.addScaledVector(fwd, need / s);
      }
    }

    // ---- arms (sword arm first: with both hands on the hilt the left fist closes on where the handle really is,
    // after the right wrist's limits, not where the key wanted it) ----
    this._arm(1, pose);
    this._arm(0, pose);

    // ---- legs ----
    for (let i = 0; i < 2; i++) this._leg(i, pose, ankles[i], footQs[i]);
  }

  _arm(i, pose) {
    const arm = this.arm[i], side = arm.side, B = this.B, P = this.P, Q = this.Q, s = this.s, T = this._t;
    if (!B[`upperArm.${side}`]) return;
    const S = P[`upperArm.${side}`];
    const handQ = T.q1.copy(pose.handQ[i]);
    // grip target (two-handed: left hand slides onto the handle below the right hand)
    const grip = T.a.copy(i === 1 ? this._h1 : pose.hand[i]).multiplyScalar(s);
    if (i === 0 && pose.twoHand > 0.001) {
      const tw = pose.twoHand;
      // the weapon frame of the right fist; the left fist closes on the same handle, twoHandGap toward the pommel,
      // wrapped the same way round (edge on its knuckle side too), i.e. its own socket aligned with the weapon
      const qW = _twQ.copy(this._handR).multiply(GRIP_R);        // the solved right fist's weapon frame
      T.b.set(0, 0, -this.twoHandGap * s).applyQuaternion(qW).add(this._gripR);
      grip.lerp(T.b, tw);
      // the left socket frame is the right one mirrored: turned half over about its knuckle axis, the left fist
      // closes over the top of the tsuka exactly like the right one (back of the hand up, fingers wrapping under)
      handQ.slerp(qW.multiply(GRIP_L_INV).multiply(_flipX), tw);
    }
    // ---- ergonomics (real swordplay reads long and open) ----
    if (i === 1 && pose.reach > 0) {
      // cutting arm: through the strike and follow-through the fist travels on a long radius, not hugged to the chest
      const d = grip.distanceTo(S), want = (0.57 - 0.07 * (pose.twoHand || 0)) * s;   // near full extension (two hands: the left arm must still reach the kashira)
      if (d < want && d > 1e-4) grip.sub(S).multiplyScalar((d + (want - d) * pose.reach) / d).add(S);
    }
    if (i === 0 && !(pose.twoHand > 0.001)) {
      // raised off hand (剑指 counter-balance): open it to the side in an arc, never stacked straight over the head
      const up = grip.y - S.y;
      if (up > 0.1 * s) {
        const ox = _ergoX.set(1, 0, 0).applyQuaternion(Q.chest);
        const lateral = _ergoD.subVectors(grip, S).dot(ox);
        const need = 0.12 * s * Math.min(1, (up - 0.1 * s) / (0.2 * s));   // just never across the head's midline
        if (lateral < need) grip.addScaledVector(ox, need - lateral);
      }
    }
    // wrist = grip − R·gripOffset
    const W = T.b.copy(arm.grip).applyQuaternion(handQ).negate().add(grip);
    // knuckle direction (where the forearm "wants" to point): −X of the hand for R, +X for L
    const k = T.c.set(arm.sgn, 0, 0).applyQuaternion(handQ);
    // anatomical pole: elbow down, out and a little back (chest frame)
    const pole = T.d.set(arm.sgn * 0.35, -0.88, -0.22).applyQuaternion(Q.chest);   // elbow mostly down (a sword arm never flares like a wing)
    // wrist-alignment pole: elbow opposite the knuckle direction (so the forearm continues into the fist)
    T.e.copy(k).negate();
    pole.lerp(T.e, 0.35);   // favour the anatomical pole (elbow down, out, back) over wrist alignment
    // keep a minimum outward component so the elbow never folds across the body midline
    T.f = T.f || new THREE.Vector3();
    const ox = T.f.set(arm.sgn, 0, 0).applyQuaternion(Q.chest);
    const outward = pole.dot(ox);
    if (outward < 0.02) pole.addScaledVector(ox, 0.02 - outward);
    // elbow flare: rotate the pole around the shoulder→wrist axis
    if (pose.flare[i]) {
      _fv.subVectors(W, S).normalize();
      T.q2.setFromAxisAngle(_fv, pose.flare[i] * arm.sgn);
      pole.applyQuaternion(T.q2);
    }
    const E = this.debug.elbow[i];
    const Wr = this.debug.wrist[i];
    twoBoneIK(S, W, pole, arm.l1 * s, arm.l2 * s, 0.015, E, Wr);
    // upper arm frame: bone axis → S→E, hinge normal → bend normal
    const d1 = _fv.subVectors(E, S).normalize();
    const d2 = _fv2.subVectors(Wr, E).normalize();
    const n = T.e.crossVectors(d1, d2);
    // straight limb: the bend normal comes from the pole (elbow bends toward it ⇒ n ∝ pole × d1)
    if (n.lengthSq() < 1e-5) n.crossVectors(pole, d1);
    if (n.lengthSq() < 1e-8) n.set(0, arm.sgn, 0).cross(d1);
    n.normalize();
    const qU = T.q2; quatFromFrames(arm.axis, arm.nRest, d1, n, qU);
    const qL = T.q3; quatFromFrames(arm.axis, arm.nRest, d2, n, qL);
    // wrist: relative rotation forearm → hand, split twist into the forearm, clamp swing
    const rel = T.q4.copy(qL).invert().multiply(handQ);
    const sw = T.q5, tw = _fq;
    swingTwist(rel, arm.axis, sw, tw);
    quatScale(tw, this.twistSplit);
    qL.multiply(tw);                                          // forearm roll
    // recompute the hand relative to the rolled forearm and limit the wrist bend
    rel.copy(qL).invert().multiply(handQ);
    swingTwist(rel, arm.axis, sw, tw);
    const ang = quatAngle(sw);
    if (ang > this.wristLimit) quatScale(sw, this.wristLimit / ang);
    rel.copy(sw).multiply(tw);
    // local rotations
    const qSh = Q[`shoulder.${side}`];
    B[`upperArm.${side}`].quaternion.copy(qSh).invert().multiply(qU);
    B[`lowerArm.${side}`].quaternion.copy(qU).invert().multiply(qL);
    B[`hand.${side}`].quaternion.copy(rel);
    if (i === 1) {
      // where the weapon actually is (rig space): the solved hand frame and its grip point
      this._handR.copy(qL).multiply(rel);
      this._gripR.copy(arm.grip).applyQuaternion(this._handR).add(Wr);
    }
  }

  _leg(i, pose, ankle, footQ) {
    const leg = this.leg[i], side = leg.side, B = this.B, P = this.P, Q = this.Q, s = this.s, T = this._t;
    if (!B[`upperLeg.${side}`]) return;
    const H = P[`upperLeg.${side}`];
    // knee pole: forward along the foot, a little outward (bow-legged knees look weak, knock-knees look worse)
    const pole = T.d.set(0, 0, 1).applyQuaternion(footQ);
    pole.y = 0; if (pole.lengthSq() < 1e-6) pole.set(0, 0, 1);
    pole.normalize();
    pole.x += (i === 0 ? 0.12 : -0.12);
    pole.y += 0.15;
    const K = this.debug.knee[i], A = this.debug.ankle[i];
    twoBoneIK(H, ankle, pole, leg.l1 * s, leg.l2 * s, 0.03, K, A);
    const d1 = _fv.subVectors(K, H).normalize();
    const d2 = _fv2.subVectors(A, K).normalize();
    const n = T.e.crossVectors(d1, d2);
    if (n.lengthSq() < 1e-5) n.crossVectors(pole, d1);
    n.normalize();
    // rest hinge: bend normal +X (the shin swings back)
    const qT = T.q2; quatFromFrames(leg.axis1, leg.nRest, d1, n, qT);
    const qS = T.q3; quatFromFrames(leg.axis2, leg.nRest, d2, n, qS);
    B[`upperLeg.${side}`].quaternion.copy(Q.hips).invert().multiply(qT);
    B[`lowerLeg.${side}`].quaternion.copy(qT).invert().multiply(qS);
    B[`foot.${side}`].quaternion.copy(qS).invert().multiply(footQ);
    if (B[`toes.${side}`]) B[`toes.${side}`].quaternion.copy(pose.q[`toes.${side}`]);
  }
}
