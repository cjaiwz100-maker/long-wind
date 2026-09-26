// Keyframe tracks and clip compilation. Owner: animation (A).
//
// A clip is authored as sparse keys of rig-space channels (see CHANNELS below); every channel is compiled into
// its own track and interpolated with time-domain cubic Hermite splines, so velocity stays continuous through
// "passing" keys while extremes ease in and out:
//   tan: 'auto'   non-uniform Catmull-Rom (parabola-fit derivative), clamped at local extremes  (default)
//        'flat'   zero velocity at the key: slow-in / slow-out — use on anticipation and settle poses
//        'linear' segment INTO this key is linear             'step' hold the previous value until this key
// Rotations are authored as Euler degrees [pitch, yaw, roll] (YXZ), so spins past 180° interpolate naturally.
// Hands are authored as a grip point plus two direction vectors (blade `d` + edge `e` for the sword hand, or
// knuckles `f` + palm normal `n` for an empty hand); the vectors are splined and re-orthonormalised, which gives
// clean arcs for the blade. Feet are a flat anchor + yaw/pitch/roll; `lk` is the world-plant weight per foot.
import * as THREE from 'three';
import { D2R, Pose, quatFromDeg, quatLook, GRIP_R, GRIP_R_INV } from '../ik.js';

const TAN = { auto: 0, flat: 1, linear: 2, step: 3 };

// channel name → [dimension, kind]
export const CHANNELS = {
  hip: [3, 'vec'],     // pelvis offset (m)
  pel: [3, 'rot'], sp: [3, 'rot'], ch: [3, 'rot'], nk: [3, 'rot'], hd: [3, 'rot'],
  shL: [3, 'rot'], shR: [3, 'rot'],
  tL: [1, 'toe'], tR: [1, 'toe'],
  lh: [9, 'hand'], rh: [9, 'hand'],   // p(3) Z(3) Y(3) in the hand frame (rig or chest space)
  lf: [6, 'foot'], rf: [6, 'foot'],   // x y z yaw pitch roll
  lk: [2, 'lock'], el: [2, 'flare'], tw: [1, 'two'],
};
const ROT_TARGET = { pel: 'hips', sp: 'spine', ch: 'chest', nk: 'neck', hd: 'head', shL: 'shoulder.L', shR: 'shoulder.R' };

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _q = new THREE.Quaternion();

const _qa = new THREE.Quaternion(), _m = new THREE.Matrix4();
/**
 * Convert a hand spec to the 9-float track layout [p, Z, Y].
 * Left hand tracks store the HAND frame; right hand tracks store the WEAPON frame (hand · GRIP_R), so sword keys
 * ({p, d, e}) and empty-hand keys ({p, f, n}) interpolate in the same space.
 */
function handVec(spec, right) {
  const p = spec.p;
  if (spec.d) {
    // weapon frame: Z = blade direction, Y = edge direction
    const z = _a.fromArray(spec.d).normalize();
    // no edge given → zero vector: the edge/knuckle line is derived at evaluation from the natural arm line
    if (!spec.e) return [...p, z.x, z.y, z.z, 0, 0, 0];
    const y = _b.fromArray(spec.e);
    y.addScaledVector(z, -y.dot(z)).normalize();
    return [...p, z.x, z.y, z.z, y.x, y.y, y.z];
  }
  // hand frame: knuckles f = X·sgn, palm normal n = −Y
  const sgn = right ? -1 : 1;
  const x = _a.fromArray(spec.f).normalize().multiplyScalar(sgn);
  const y = _b.fromArray(spec.n).negate();
  const z = _c.crossVectors(x, y).normalize();
  y.crossVectors(z, x).normalize();
  if (!right) return [...p, z.x, z.y, z.z, y.x, y.y, y.z];
  // right hand: hand frame → weapon frame
  _m.makeBasis(x, y, z); _qa.setFromRotationMatrix(_m).multiply(GRIP_R);
  const zw = _c.set(0, 0, 1).applyQuaternion(_qa).clone(), yw = _b.set(0, 1, 0).applyQuaternion(_qa);
  return [...p, zw.x, zw.y, zw.z, yw.x, yw.y, yw.z];
}

function flatten(name, v) {
  if (name === 'lh') return handVec(v, false);
  if (name === 'rh' || name === 'sw') return handVec(v, true);
  if (typeof v === 'number') return [v];
  return v.slice();
}

/** A compiled per-channel spline. */
class Track {
  constructor(dim, times, vals, tans, loop, duration) {
    this.dim = dim; this.n = times.length; this.t = times; this.v = vals; this.mode = tans;
    this.loop = loop; this.dur = duration;
    this.m = new Float32Array(vals.length); // tangents (units per second)
    this._tangents();
  }
  _tangents() {
    const { n, dim, t, v, m, mode, loop, dur } = this;
    for (let i = 0; i < n; i++) {
      const flat = mode[i] === TAN.flat;
      let ip = i - 1, inx = i + 1, tp, tn;
      if (ip < 0) { if (!loop) { m.fill(0, i * dim, i * dim + dim); continue; } ip = n - 1; tp = t[ip] - dur; } else tp = t[ip];
      if (inx >= n) { if (!loop) { m.fill(0, i * dim, i * dim + dim); continue; } inx = 0; tn = t[0] + dur; } else tn = t[inx];
      const dt0 = Math.max(t[i] - tp, 1e-4), dt1 = Math.max(tn - t[i], 1e-4);
      for (let k = 0; k < dim; k++) {
        if (flat) { m[i * dim + k] = 0; continue; }
        const p0 = v[ip * dim + k], p1 = v[i * dim + k], p2 = v[inx * dim + k];
        const s0 = (p1 - p0) / dt0, s1 = (p2 - p1) / dt1;
        // auto-clamp: local extreme → flat (no overshoot past a pose the animator set)
        if (s0 * s1 <= 0) { m[i * dim + k] = 0; continue; }
        let d = (dt1 * s0 + dt0 * s1) / (dt0 + dt1);
        // Fritsch–Carlson style limit keeps monotone segments monotone
        const lim = 3 * Math.min(Math.abs(s0), Math.abs(s1));
        if (Math.abs(d) > lim) d = Math.sign(d) * lim;
        m[i * dim + k] = d;
      }
    }
  }
  /** Evaluate at time `time` into `out` (array-like, length ≥ dim). */
  eval(time, out) {
    const { n, dim, t, v, m, mode, loop, dur } = this;
    if (n === 1) { for (let k = 0; k < dim; k++) out[k] = v[k]; return out; }
    if (loop) { time = ((time % dur) + dur) % dur; }
    let i0, i1, t0, t1;
    if (time <= t[0]) {
      if (!loop) { for (let k = 0; k < dim; k++) out[k] = v[k]; return out; }
      i0 = n - 1; i1 = 0; t0 = t[n - 1] - dur; t1 = t[0];
    } else if (time >= t[n - 1]) {
      if (!loop) { const o = (n - 1) * dim; for (let k = 0; k < dim; k++) out[k] = v[o + k]; return out; }
      i0 = n - 1; i1 = 0; t0 = t[n - 1]; t1 = t[0] + dur;
    } else {
      // keys are few (≤ ~16): linear scan is faster than a search
      i1 = 1; while (t[i1] < time) i1++;
      i0 = i1 - 1; t0 = t[i0]; t1 = t[i1];
    }
    const h = Math.max(t1 - t0, 1e-5), u = (time - t0) / h;
    const md = mode[i1], a = i0 * dim, b = i1 * dim;
    if (md === TAN.step) { for (let k = 0; k < dim; k++) out[k] = v[a + k]; return out; }
    if (md === TAN.linear) { for (let k = 0; k < dim; k++) out[k] = v[a + k] + (v[b + k] - v[a + k]) * u; return out; }
    const u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    for (let k = 0; k < dim; k++) out[k] = h00 * v[a + k] + h10 * h * m[a + k] + h01 * v[b + k] + h11 * h * m[b + k];
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------------
// channel application (values → Pose)
// ---------------------------------------------------------------------------------------------------------
function applyChannel(name, val, pose, clip, solver) {
  switch (name) {
    case 'hip': pose.hips.set(val[0], val[1], val[2]); break;
    case 'pel': case 'sp': case 'ch': case 'nk': case 'hd': case 'shL': case 'shR':
      quatFromDeg(val[0], val[1], val[2], pose.q[ROT_TARGET[name]]); break;
    case 'tL': quatFromDeg(val[0], 0, 0, pose.q['toes.L']); break;
    case 'tR': quatFromDeg(val[0], 0, 0, pose.q['toes.R']); break;
    case 'lh': case 'rh': {
      const i = name === 'lh' ? 0 : 1;
      const p = pose.hand[i].set(val[0], val[1], val[2]);
      const z = _a.set(val[3], val[4], val[5]), y = _b.set(val[6], val[7], val[8]);
      if (clip.space[i] === 'chest' && solver) {
        // chest-space authoring → rig space (solver.torso(pose) must have run)
        const qc = solver.Q.chest, pc = solver.P.chest, s = solver.s;
        p.applyQuaternion(qc).addScaledVector(pc, 1 / s);
        z.applyQuaternion(qc); y.applyQuaternion(qc);
      }
      const yl = y.length();
      if (i === 1 && yl < 0.98 && solver) {
        // auto edge: knuckles continue the shoulder→grip line (bent down a little), orthogonal to the blade
        const sh = solver.P['upperArm.R'], s = solver.s;
        _c.set(p.x - sh.x / s, p.y - sh.y / s - 0.12, p.z - sh.z / s).normalize();
        _c.addScaledVector(z, -_c.dot(z));
        if (_c.lengthSq() < 1e-4) _c.set(0, -1, 0).addScaledVector(z, -z.y);
        _c.normalize();
        y.addScaledVector(_c, Math.max(0, 1 - yl));
      }
      quatLook(z, y, pose.handQ[i]);
      if (i === 1) pose.handQ[1].multiply(GRIP_R_INV); // weapon frame → hand frame
      break;
    }
    case 'lf': case 'rf': {
      const i = name === 'lf' ? 0 : 1;
      pose.foot[i].set(val[0], val[1], val[2]);
      quatFromDeg(0, val[3], val[5], pose.footQ[i]);
      pose.pitch[i] = val[4] * D2R;
      break;
    }
    case 'lk': pose.lock[0] = val[0]; pose.lock[1] = val[1]; break;
    case 'el': pose.flare[0] = val[0] * D2R; pose.flare[1] = val[1] * D2R; break;
    case 'tw': pose.twoHand = val[0]; break;
  }
}

const ORDER = ['hip', 'pel', 'sp', 'ch', 'nk', 'hd', 'shL', 'shR', 'tL', 'tR', 'lf', 'rf', 'lk', 'el', 'tw', 'lh', 'rh'];
const HAND_ALIAS = { sw: 'rh' };

// start-frame → rig-frame conversion (clips authored with `frame: 'start'`)
const _rv = new THREE.Vector3(), _ry = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);
function toRig(p, R, cy, sy) {
  const x = p.x - R.x, z = p.z - R.z;
  p.x = x * cy - z * sy; p.z = x * sy + z * cy;
}

/**
 * Compile an authored clip.
 * spec: { meta, base: {channels}, keys: [{t, tan?, ...channels}], root?: [[t, x, z, yawDeg?, tan?]] | 'hip',
 *         frame?: 'root'|'start', events?: [{t, type, ...}], space?: {L:'root'|'chest', R:...} }
 *
 * frame 'start': the pelvis offset and the feet are authored in the CLIP-START frame (as if the root never moved:
 * a stepping foot simply gets a new position, a planted foot keeps its numbers). They are carried into the moving
 * rig frame by subtracting the root motion at t, so planted feet stay put in the world by construction. Hands stay
 * in rig space (or chest space) and therefore travel with the body.
 * root 'hip': the root motion is the authored pelvis travel (x, z) relative to the first key — the gameplay
 * capsule follows the body's centre of mass, and gameplay can warp it (lunge magnetism) without re-authoring.
 */
export function compileClip(name, spec, defaults) {
  const meta = spec.meta;
  const duration = meta.duration;
  const loop = !!meta.loop;
  const space = [spec.space?.L ?? 'root', spec.space?.R ?? 'root'];
  // gather per-channel key lists
  const lists = {};
  const base = { ...defaults, ...(spec.base ?? {}) };
  if (base.sw) { base.rh = base.sw; delete base.sw; }
  for (const key of spec.keys ?? []) {
    for (const [k0, v] of Object.entries(key)) {
      if (k0 === 't' || k0 === 'tan') continue;
      const k = HAND_ALIAS[k0] ?? k0;
      if (!CHANNELS[k]) { console.warn(`[anim] ${name}: unknown channel ${k0}`); continue; }
      // plant weights switch exactly at their key (a spline would plant a foot mid-swing, short of its landing)
      const tan = k === 'lk' ? TAN.step : TAN[key.tan ?? 'auto'] ?? 0;
      (lists[k] ??= []).push({ t: key.t, tan, v: flatten(k0, v) });
    }
  }
  const tracks = [];
  const constVals = [];
  for (const ch of ORDER) {
    const L = lists[ch];
    if (L && L.length) {
      L.sort((a, b) => a.t - b.t);
      const dim = CHANNELS[ch][0];
      const times = new Float32Array(L.map((k) => k.t));
      const vals = new Float32Array(L.length * dim);
      L.forEach((k, i) => vals.set(k.v.slice(0, dim), i * dim));
      tracks.push({ ch, tr: new Track(dim, times, vals, new Uint8Array(L.map((k) => k.tan)), loop, duration), buf: new Float32Array(dim) });
    } else if (base[ch] !== undefined) {
      constVals.push({ ch, v: flatten(ch, base[ch]) });
    }
  }
  // root motion: x (left), z (forward), yaw (deg, + left), cumulative from clip start
  let root = null;
  const frameStart = spec.frame === 'start';
  if (spec.root === 'hip' && lists.hip?.length) {
    const L = lists.hip.slice().sort((a, b) => a.t - b.t);
    const x0 = L[0].v[0], z0 = L[0].v[2];
    root = new Track(3, new Float32Array(L.map((k) => k.t)), new Float32Array(L.flatMap((k) => [k.v[0] - x0, k.v[2] - z0, 0])),
      new Uint8Array(L.map((k) => k.tan)), false, duration);
  } else if (Array.isArray(spec.root) && spec.root.length) {
    const R = spec.root.slice().sort((a, b) => a[0] - b[0]);
    root = new Track(3, new Float32Array(R.map((r) => r[0])), new Float32Array(R.flatMap((r) => [r[1] ?? 0, r[2] ?? 0, r[3] ?? 0])),
      new Uint8Array(R.map((r) => TAN[r[4] ?? 'auto'] ?? 0)), false, duration);
  }
  const events = (spec.events ?? []).slice().sort((a, b) => a.t - b.t);
  const handTracks = tracks.filter((t) => t.ch === 'lh' || t.ch === 'rh');
  const bodyTracks = tracks.filter((t) => t.ch !== 'lh' && t.ch !== 'rh');
  const handConsts = constVals.filter((c) => c.ch === 'lh' || c.ch === 'rh');
  const bodyConsts = constVals.filter((c) => c.ch !== 'lh' && c.ch !== 'rh');

  const clip = {
    name, meta, space, root, events, loop, duration, layer: meta.layer ?? 'full',
    /** Pure evaluation of the clip at time t into `pose` (rig space). `solver` enables chest-space hands. */
    evaluate(t, pose, solver) {
      for (const c of bodyConsts) applyChannel(c.ch, c.v, pose, clip, solver);
      for (const k of bodyTracks) applyChannel(k.ch, k.tr.eval(t, k.buf), pose, clip, solver);
      if (frameStart && root) {
        const yaw = clip.rootAt(t, _rv), cy = Math.cos(yaw), sy = Math.sin(yaw);
        _ry.setFromAxisAngle(_up, -yaw);
        toRig(pose.hips, _rv, cy, sy); pose.q.hips.premultiply(_ry);
        for (let i = 0; i < 2; i++) { toRig(pose.foot[i], _rv, cy, sy); pose.footQ[i].premultiply(_ry); }
      }
      if (solver) solver.torso(pose);
      for (const c of handConsts) applyChannel(c.ch, c.v, pose, clip, solver);
      for (const k of handTracks) applyChannel(k.ch, k.tr.eval(t, k.buf), pose, clip, solver);
      return pose;
    },
    /** Cumulative root motion at time t: out = (x, 0, z), returns yaw (rad). */
    rootAt(t, out) {
      if (!root) { out.set(0, 0, 0); return 0; }
      const b = root.eval(Math.min(Math.max(t, 0), duration), _rootBuf);
      out.set(b[0], 0, b[1]);
      return b[2] * D2R;
    },
  };
  return clip;
}
const _rootBuf = new Float32Array(3);

/** Utility for authoring: a fresh Pose evaluated from a channel object (used for base poses in locomotion). */
export function poseFromChannels(channels, solver) {
  const c = compileClip('_pose', { meta: { duration: 1 }, base: channels, keys: [] }, {});
  return c.evaluate(0, new Pose(), solver);
}
