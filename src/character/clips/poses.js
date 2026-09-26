// Shared authoring vocabulary: reference poses and small helpers used by every clip file. Owner: animation (A).
//
// Rig space (unscaled contract skeleton): +X = character's LEFT, +Y up, +Z forward, root on the ground between the
// feet. Landmarks: hip joints y 0.92 (±0.095), shoulders (±0.19, 1.42, −0.02), arm reach shoulder→grip ≈ 0.61 m,
// leg length hip→ankle 0.835 m, ankle height 0.085 m.
//
// Channel cheat-sheet (all optional per key; unkeyed channels come from `base`):
//   hip [x,y,z] pelvis offset (m) · pel/sp/ch/nk/hd/shL/shR [pitch, yaw, roll]° (+pitch bends forward,
//   +yaw turns LEFT, +roll tilts the top to the RIGHT) · lf/rf [x, y, z, yaw°, pitch°, roll°] flat-foot anchor
//   (ground point under the ankle; pitch > 0 toes up on the heel, < 0 heel up on the ball) · lk [L, R] world plant
//   weight · sw {p, d, e} sword: grip point, blade direction, edge direction (≈ where the knuckles/forearm point)
//   · lh/rh {p, f, n} empty hand: grip point, knuckle direction, palm normal · el [L, R] elbow flare° · tw two-hand.

/** Normalise-free vector helper for readability. */
export const v = (x, y, z) => [x, y, z];

/** Sword-hand spec: grip p, blade direction d, edge (knuckle-side) direction e. */
export const sw = (p, d, e) => ({ p, d, e });

/** Empty-hand spec: grip/fist centre p, knuckle direction f, palm normal n. */
export const hand = (p, f, n) => ({ p, f, n });

/** Mirror a channel object left↔right (for symmetric poses). */
export function mirror(ch) {
  const out = {};
  const mx = (a) => [-a[0], a[1], a[2]];
  const rot = (a) => [a[0], -a[1], -a[2]];
  for (const [k, val] of Object.entries(ch)) {
    switch (k) {
      case 'lf': out.rf = [-val[0], val[1], val[2], -val[3], val[4], -val[5]]; break;
      case 'rf': out.lf = [-val[0], val[1], val[2], -val[3], val[4], -val[5]]; break;
      case 'lh': out.rh = { p: mx(val.p), f: mx(val.f), n: mx(val.n) }; break;
      case 'rh': out.lh = { p: mx(val.p), f: mx(val.f), n: mx(val.n) }; break;
      case 'shL': out.shR = rot(val); break;
      case 'shR': out.shL = rot(val); break;
      case 'lk': out.lk = [val[1], val[0]]; break;
      case 'el': out.el = [val[1], val[0]]; break;
      case 'hip': out.hip = mx(val); break;
      case 'pel': case 'sp': case 'ch': case 'nk': case 'hd': out[k] = rot(val); break;
      default: out[k] = val;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Hand vocabulary
// ---------------------------------------------------------------------------------------------------------
/** 剑指 sword-fingers held before the chest, fingers up, palm facing right (toward the blade). */
export const JIANZHI_CHEST = hand([0.09, 1.25, 0.24], [-0.15, 0.95, 0.25], [-0.9, 0.1, 0.4]);
/** 剑指 raised in an arc above/behind the head — the classic counter-balance silhouette. */
export const JIANZHI_HIGH = hand([0.33, 1.74, -0.1], [-0.45, 0.6, 0.45], [0.2, 0.45, 0.87]);   // arced above-behind the head
/** Left hand relaxed at the side. */
export const LH_HANG = hand([0.225, 0.8, 0.04], [0.03, -1, 0.08], [-1, 0, 0.05]);
/** Left hand hanging loose beside the thigh, elbow soft: the free hand of the ready stance. */
export const LH_READY = hand([0.23, 0.72, 0.07], nrm([0.04, -0.97, 0.22]), nrm([-0.98, 0.0, 0.1]));   // hangs: never hovers   // shoulders dropped, arm close to the thigh
/** 负手: left hand resting at the small of the back (the master's idle). */
export const LH_BACK = hand([0.07, 0.98, -0.2], [-0.95, -0.1, -0.2], [0, 0.3, -1]);
/** Left hand on the scabbard throat at the left hip. */
export const LH_SHEATH = hand([0.2, 0.96, 0.14], [0.2, -0.5, 0.85], [-0.9, 0.2, 0.2]);
/** Right hand relaxed at the side (unarmed). */
export const RH_HANG = hand([-0.215, 0.83, 0.03], [-0.03, -1, 0.08], [1, 0, 0.05]);

// ---------------------------------------------------------------------------------------------------------
// Sword vocabulary (right hand)
// ---------------------------------------------------------------------------------------------------------
/** Relaxed carry: blade angled down-forward beside the right leg. */
export const SW_CARRY = sw([-0.23, 0.8, 0.08], nrm([-0.12, -0.62, 0.78]), ortho(nrm([-0.12, -0.62, 0.78]), [0, -0.6, -0.8]));   // 垂剑: loose fist by the thigh, tip hanging down-forward (clear of the ground)
/** Ready: sword hand low by the right hip, the blade slanting down-forward at the opponent's knees — relaxed but
 *  alive (every cut starts from low and whips up). The tip rides ~0.4 m above the ground: the old toward-the-feet
 *  angle scraped the floor in the crouched stance and read as a sword too heavy to lift. */
export const SW_DRAG = sw([-0.24, 0.75, 0.17], nrm([-0.17, -0.36, 0.92]), ortho(nrm([-0.17, -0.36, 0.92]), [0, -0.6, -0.8]));
/** 中平 guard: blade forward-up toward the opponent's throat, forearm forward. */
export const SW_GUARD = sw([-0.12, 1.16, 0.46], [0.08, 0.22, 0.97], [0.1, -0.97, 0.2]);   // 中平剑: arm ~70% extended, tip at the throat

// ---------------------------------------------------------------------------------------------------------
// Whole-body reference poses
// ---------------------------------------------------------------------------------------------------------
/** Neutral relaxed standing pose (baseline for every channel). */
export const NEUTRAL = {
  hip: [0, -0.012, 0], pel: [0, 0, 0], sp: [2, 0, 0], ch: [-1, 0, 0], nk: [3, 0, 0], hd: [-3, 0, 0],
  shL: [0, 0, 0], shR: [0, 0, 0], tL: 0, tR: 0,
  lf: [0.1, 0, -0.01, 7, 0, 0], rf: [-0.1, 0, -0.01, -7, 0, 0], lk: [1, 1], el: [0, 0], tw: 0,
  lh: LH_HANG, sw: SW_CARRY,
};

/** Relaxed contrapposto idle, sword held low, left hand behind the back. */
export const IDLE = {
  ...NEUTRAL,
  hip: [-0.03, -0.018, 0.005], pel: [0, 4, -3.5], sp: [2, -2, 2], ch: [-2, -2, 1.8], nk: [4, -1, 0], hd: [-3, -2, -1],
  lf: [0.12, 0, 0.03, 13, 0, 0], rf: [-0.1, 0, -0.03, -6, 0, 0],
  lh: LH_HANG, sw: SW_CARRY,   // natural hang (LH_BACK 负手 read as a twisted arm from the chase camera)
};

/** Combat stance: right foot forward, knees bent, relaxed ready (blade low ahead), free hand loose. */
export const STANCE = {
  ...NEUTRAL,
  hip: [0.02, -0.095, -0.01], pel: [6, 16, -1], sp: [5, -4, 0], ch: [3, -5, 1], nk: [-3, -4, 0], hd: [-5, -3, 0],
  shL: [0, 0, 0], shR: [0, 0, 0],
  lf: [0.18, 0, -0.17, 32, 0, 0], rf: [-0.14, 0, 0.22, 2, 0, 0],
  lh: LH_READY, sw: SW_DRAG, el: [0, 0], tw: 0,
};

/** Bandit guard: left foot forward, torso loaded to the right, dao up by the right shoulder, off hand forward. */
export const BANDIT_STANCE = {
  ...NEUTRAL,
  hip: [0.0, -0.1, -0.02], pel: [8, -12, 0], sp: [6, -4, 0], ch: [4, -6, 0], nk: [-4, 11, 0], hd: [-6, 9, 0],
  lf: [0.16, 0, 0.18, 18, 0, 0], rf: [-0.18, 0, -0.18, -32, 0, 0],
  lh: hand([0.17, 1.06, 0.34], [0.1, 0.3, 0.95], [-0.9, -0.3, 0.2]),
  // the weapon points at the opponent (tip up ~30°) from a hand in front of the belly: the old shoulder-high guard
  // stood the blade (or a spear shaft) straight through the face
  sw: sw([-0.24, 1.02, 0.3], nrm([0.04, 0.5, 0.86]), ortho(nrm([0.04, 0.5, 0.86]), [0, -1, 0.2])),
};

// ---------------------------------------------------------------------------------------------------------
// Direction helpers for blade choreography
// ---------------------------------------------------------------------------------------------------------
const DEG = Math.PI / 180;
/** Unit vector from azimuth (0 = forward +Z, +90 = left +X, −90 = right, 180 = back) and elevation (+ up), degrees. */
export function az(azDeg, elDeg = 0) {
  const a = azDeg * DEG, e = elDeg * DEG;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}
/** Rotate a vector [x,y,z] about +Y by deg. */
export function ry(v, deg) { const a = deg * DEG, c = Math.cos(a), s = Math.sin(a); return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c]; }
/** Normalised sum helper. */
/** e0 made perpendicular to the (unit) blade direction d, normalised. */
export function ortho(d, e0) { const k = d[0] * e0[0] + d[1] * e0[1] + d[2] * e0[2]; return nrm([e0[0] - k * d[0], e0[1] - k * d[1], e0[2] - k * d[2]]); }
export function nrm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
/** Key builder: full pose `base` overridden by `o`, at time t with tangent mode. */
export const K = (t, base, o = {}, tan) => ({ t, ...base, ...o, ...(tan ? { tan } : {}) });

// ---------------------------------------------------------------------------------------------------------
// Chest-space authoring
// ---------------------------------------------------------------------------------------------------------
// Clips with `space: { L: 'chest', R: 'chest' }` author hands relative to the chest bone, so they ride along with
// the torso (spins, dodges, reactions). `chestSpace(spec, torso)` converts a rig-space hand spec into that frame for
// a reference torso (hip offset + pel/sp/ch rotations), so the familiar rig-space vocabulary can be reused.
import * as THREE from 'three';
import { quatFromDeg } from '../ik.js';
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _p = new THREE.Vector3(), _t = new THREE.Vector3();
function chestFrame(torso) {
  const h = torso.hip ?? [0, 0, 0];
  quatFromDeg(...(torso.pel ?? [0, 0, 0]), _q1);
  quatFromDeg(...(torso.sp ?? [0, 0, 0]), _q2); _q2.premultiply(_q1);          // spine (rig)
  quatFromDeg(...(torso.ch ?? [0, 0, 0]), _q3); _q3.premultiply(_q2);          // chest (rig)
  _p.set(h[0], 0.98 + h[1], h[2]);
  _p.add(_t.set(0, 0.10, -0.01).applyQuaternion(_q1));
  _p.add(_t.set(0, 0.17, 0).applyQuaternion(_q2));
  return { q: _q3.clone().invert(), p: _p.clone() };
}
export function chestSpace(spec, torso) {
  const F = chestFrame(torso);
  const tr = (a) => new THREE.Vector3(...a).applyQuaternion(F.q).toArray();
  const out = { p: new THREE.Vector3(...spec.p).sub(F.p).applyQuaternion(F.q).toArray() };
  if (spec.d) { out.d = tr(spec.d); if (spec.e) out.e = tr(spec.e); } else { out.f = tr(spec.f); out.n = tr(spec.n); }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Free-arm vocabulary in CHEST space (+X left, +Y up, +Z forward; left shoulder ≈ [0.19, 0.15, 0]). 收放: the
// hand gathers in close for the wind-up, flies fully open for the strike, then drops and hangs — it never hovers.
// Use lhC(...) in root-space clips (resolved against each key's own torso by resolveChestHands), or the raw
// spec in chest-space clips.
// ---------------------------------------------------------------------------------------------------------
const armDir = (d, len = 0.6) => { const n = nrm(d); return [0.19 + n[0] * len, 0.15 + n[1] * len, n[2] * len]; };
const lhand = (d, n0, len) => { const f = nrm(d); return hand(armDir(d, len), f, ortho(f, n0)); };
export const L_TUCK = hand([0.17, -0.22, 0.2], nrm([-0.2, -0.35, 0.9]), ortho(nrm([-0.2, -0.35, 0.9]), [-0.9, -0.3, 0]));   // 收: gathered by the belly
export const L_REACH = lhand([0.3, -0.12, 0.95], [-0.5, -0.85, 0], 0.6);      // leads forward, open hand
export const L_SWING = lhand([0.72, -0.4, -0.55], [0.1, -0.7, -0.7], 0.6);    // swinging back against the cut
export const L_OPEN_SIDE = lhand([0.95, -0.18, -0.25], [0, -1, 0], 0.64);      // 放: flung wide, palm down
export const L_OPEN_BACK = lhand([0.62, -0.1, -0.78], [0, -1, 0], 0.64);       // 放: opened behind, level with the shoulder
export const L_LOW_OUT = lhand([0.55, -0.75, 0.3], [0, -1, 0], 0.6);          // low and out for balance (crouch, charge)
export const L_HIGH_BACK = lhand([0.5, 0.55, -0.67], [0, -0.6, -0.8], 0.64); // 剑指 flung up and back (the finish of a cleave)
export const L_POINT = lhand([0.18, 0.02, 1], [-0.2, -0.95, 0], 0.64);        // 剑指 thrust straight at the enemy, shoulder high (亮相)
export const L_HANG = hand([0.23, -0.44, 0.06], nrm([0.04, -0.97, 0.22]), nrm([-0.98, 0.0, 0.1]));
/** Mark a chest-space hand for a root-space clip. */
export const lhC = (h) => ({ ...h, chest: true });
function chestFwd(torso) {
  // root-space clips carry the root with the pelvis (root: 'hip'), so hands exclude the hip's ground travel
  const h = [0, (torso.hip ?? [0, 0, 0])[1], 0];
  quatFromDeg(...(torso.pel ?? [0, 0, 0]), _q1);
  quatFromDeg(...(torso.sp ?? [0, 0, 0]), _q2); _q2.premultiply(_q1);
  quatFromDeg(...(torso.ch ?? [0, 0, 0]), _q3); _q3.premultiply(_q2);
  _p.set(h[0], 0.98 + h[1], h[2]);
  _p.add(_t.set(0, 0.10, -0.01).applyQuaternion(_q1));
  _p.add(_t.set(0, 0.17, 0).applyQuaternion(_q2));
  return { q: _q3.clone(), p: _p.clone() };
}
/** Resolve every `lhC` hand of a root-space clip into rig space using that key's torso. The shoulder rides the
 *  chest exactly, but the arm's direction only follows the chest's heading plus a quarter of its pitch/roll: a
 *  counter-balancing arm stays near level when the body folds over a low cut (instead of pointing at the sky). */
const SHOULDER_L = [0.19, 0.15, 0];
export function resolveChestHands(clip, keepTilt = 0.25) {
  for (const k of clip.keys) {
    if (!k.lh?.chest) continue;
    const F = chestFwd(k);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(F.q);
    const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(fwd.x, fwd.z));
    const qA = yawQ.clone().slerp(F.q, keepTilt);
    const sh = new THREE.Vector3(...SHOULDER_L).applyQuaternion(F.q).add(F.p);
    const arm = new THREE.Vector3(...k.lh.p).sub(new THREE.Vector3(...SHOULDER_L)).applyQuaternion(qA);
    const tr = (a) => new THREE.Vector3(...a).applyQuaternion(qA).toArray();
    k.lh = { p: sh.add(arm).toArray(), f: tr(k.lh.f), n: tr(k.lh.n) };
  }
  return clip;
}

// ---------------------------------------------------------------------------------------------------------
// Scabbard (剑鞘) on the left hip. Convention shared with the character mesh: the hilt rests at SHEATH_HILT with
// the blade inside the scabbard along SHEATH_AXIS (hilt → tip: back, down and slightly out). Draw and sheathe
// clips place the grip on this line so a visibility swap at the handover reads as the blade leaving/entering.
// ---------------------------------------------------------------------------------------------------------
export const SHEATH_AXIS = nrm([0.18, -0.42, -0.89]);
export const SHEATH_HILT = [0.15, 1.0, 0.2];
/** Grip spec when the sword sits in (or is aligned with) the scabbard, `out` metres pulled out along the axis. */
export function swSheath(out = 0, edge = ortho(SHEATH_AXIS, [0, 1, 0])) {   // katana: worn edge-up
  const p = SHEATH_HILT.map((v, i) => v - SHEATH_AXIS[i] * out);
  return sw(p, SHEATH_AXIS, edge);
}

// ---------------------------------------------------------------------------------------------------------
// Stance-relative authoring (one reaction serves every style)
// ---------------------------------------------------------------------------------------------------------
/** Stance descriptors: base channels + which foot leads. */
export const HERO_ST = { ch: STANCE, front: 'rf', back: 'lf' };
export const BANDIT_ST = { ch: BANDIT_STANCE, front: 'lf', back: 'rf' };
const ROT_KEYS = ['hip', 'pel', 'sp', 'ch', 'nk', 'hd'];
/**
 * Key relative to a stance: `hip/pel/sp/ch/nk/hd` are DELTAS added to the stance; feet are addressed by role —
 * `ff` (front foot) / `bf` (back foot) = [dx outward, dy, dz, dyaw outward, pitch, roll] deltas — and `lk` is
 * [front, back]. Hands (`sw`, `lh`) and any other channel are absolute overrides.
 */
export function R(t, st, d = {}, tan) {
  const b = st.ch;
  const o = { t, ...b };
  for (const [k, v] of Object.entries(d)) {
    if (ROT_KEYS.includes(k)) o[k] = b[k].map((x, i) => x + (v[i] ?? 0));
    else if (k === 'ff' || k === 'bf') {
      const name = k === 'ff' ? st.front : st.back, f = b[name], s = name === 'lf' ? 1 : -1;
      o[name] = [f[0] + v[0] * s, f[1] + v[1], f[2] + v[2], f[3] + (v[3] ?? 0) * s, f[4] + (v[4] ?? 0), f[5] + (v[5] ?? 0) * s];
    } else if (k === 'lk') o.lk = st.front === 'rf' ? [v[1], v[0]] : [v[0], v[1]];
    else o[k] = v;
  }
  if (tan) o.tan = tan;
  return o;
}
