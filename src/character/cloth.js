// Secondary motion for characters (owner: character C): position-based verlet chains that drive extra skinning
// bones. Skirt panels, sash tails, sleeve bags, hair tail, sword tassel, veils and headband tails are all "chains":
// a list of particles whose first node(s) are pinned to a parent bone, the rest free. Every node owns one bone;
// its frame is parallel-transported down the chain from the parent bone, so skinned garments bend and twist
// smoothly with no flips. Chains can be cross-linked (a skirt is a ring of chains with horizontal links, cut at
// the slits) and collide with capsules built from the animated skeleton each frame.
//
// Forces: gravity, aerodynamic drag toward the shared CPU wind (core/wind.js windVector · gust + flutter), and the
// character's own motion (particles live in world space, so running streams the robe behind). Fixed-ish sub-steps
// (≤ 1/60 s), N constraint iterations, a follow-the-leader pass so ribbons never stretch.
//
// Data model (serialisable; built by outfits in BIND space of the chain's parent — the character bind pose for rig
// bones, the weapon's local frame for the sword bone):
//   chain = { name, parent: boneIndex, nodes: [[x,y,z]...], pin: [0..1 per node], side: [x,y,z], radius, mask,
//             drag, gravity, stiff (bend springs 0..1), bone0: first skeleton index of its node bones }
//   link  = { a: [chainIdx, node], b: [chainIdx, node], k }
// No allocation in step(): everything lives in typed arrays created by build().
import * as THREE from 'three';
import { windVector, windFlutter } from '../core/wind.js';

// collision masks
export const COL = { LEGS: 1, PELVIS: 2, TORSO: 4, HEAD: 8, ARMS: 16 };

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4(), _wind = new THREE.Vector2(), _one = new THREE.Vector3(1, 1, 1);
const _pq = new THREE.Quaternion(), _ps = new THREE.Vector3(), _pp = new THREE.Vector3();

/** Shortest-arc quaternion taking unit a to unit b (written into out). */
function arc(out, ax, ay, az, bx, by, bz) {
  const d = ax * bx + ay * by + az * bz;
  if (d < -0.99999) { // opposite: any perpendicular axis
    let px = 0, py = -az, pz = ay;
    if (px * px + py * py + pz * pz < 1e-6) { px = az; py = 0; pz = -ax; }
    const l = Math.hypot(px, py, pz); return out.set(px / l, py / l, pz / l, 0);
  }
  const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
  return out.set(cx, cy, cz, 1 + d).normalize();
}

/**
 * Build the rest frames (quaternions) of a chain by parallel transport, starting from a frame whose Y axis points
 * along the first segment (reversed: Y = up the chain, i.e. -dir) and X along `side`.
 */
export function chainRestFrames(nodes, side) {
  const n = nodes.length;
  const Q = [];
  const d = (i) => {
    const a = nodes[Math.min(i, n - 2)], b = nodes[Math.min(i, n - 2) + 1];
    return new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
  };
  // frame 0: y = -dir0, x = side ⟂ y, z = x × y
  const y = d(0).negate();
  const x = new THREE.Vector3(...side);
  x.addScaledVector(y, -x.dot(y));
  if (x.lengthSq() < 1e-8) x.set(1, 0, 0).addScaledVector(y, -y.x);
  x.normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  Q.push(new THREE.Quaternion().setFromRotationMatrix(m));
  for (let i = 1; i < n; i++) {
    const a = d(i - 1), b = d(i);
    const q = arc(new THREE.Quaternion(), -a.x, -a.y, -a.z, -b.x, -b.y, -b.z).multiply(Q[i - 1]);
    Q.push(q);
  }
  return Q;
}

/**
 * Bone inverse (bind) matrices for a chain's node bones: inverse(T(p_i) R_i) in the parent's bind space.
 */
export function chainBindInverses(chain) {
  const Q = chainRestFrames(chain.nodes, chain.side);
  return chain.nodes.map((p, i) => new THREE.Matrix4().compose(new THREE.Vector3(...p), Q[i], _one).invert());
}

export class ClothSim {
  /**
   * @param {object} spec { chains, links } (see header)
   * @param {THREE.Bone[]} skeletonBones every bone of the rendering skeleton (rig bones + extras), by index
   * @param {THREE.Matrix4[]} bindMatrices bind (world-at-bind) matrix per skeleton bone, for pinning (parent bones)
   * @param {object} opts { capsules: fn(out Float32Array) → count, rootBone }
   */
  constructor(spec, skeletonBones, bindMatrices, opts = {}) {
    this.bones = skeletonBones;
    this.capsuleFn = opts.capsules || null;
    this.root = opts.rootBone || null;
    const chains = spec.chains || [], links = spec.links || [];
    let n = 0;
    for (const c of chains) n += c.nodes.length;
    this.n = n;
    this.x = new Float32Array(n * 3); this.p = new Float32Array(n * 3); this.rest = new Float32Array(n * 3);
    this.local = new Float32Array(n * 3);   // node position in the parent bone's bind-local frame
    this.pin = new Float32Array(n); this.w = new Float32Array(n); this.rad = new Float32Array(n);
    this.mask = new Uint8Array(n); this.drag = new Float32Array(n); this.grav = new Float32Array(n);
    this.flut = new Float32Array(n);
    this.chains = [];
    // per-chain transport data
    let o = 0;
    for (const c of chains) {
      const pb = bindMatrices[c.parent];
      const inv = new THREE.Matrix4().copy(pb).invert();
      const pbq = new THREE.Quaternion(); pb.decompose(_pp, pbq, _ps);
      const Q = chainRestFrames(c.nodes, c.side);
      // rest frame 0 relative to the parent's bind rotation, and rest direction 0 in the same parent-local terms
      const rel0 = pbq.clone().invert().multiply(Q[0]);
      const n0 = c.nodes[0], n1 = c.nodes[1];
      const dir0 = new THREE.Vector3(n1[0] - n0[0], n1[1] - n0[1], n1[2] - n0[2]).normalize().applyQuaternion(pbq.clone().invert());
      const len = [];
      for (let i = 0; i < c.nodes.length; i++) {
        const k = o + i, [px, py, pz] = c.nodes[i];
        this.rest[k * 3] = px; this.rest[k * 3 + 1] = py; this.rest[k * 3 + 2] = pz;
        _v.set(px, py, pz).applyMatrix4(inv);
        this.local[k * 3] = _v.x; this.local[k * 3 + 1] = _v.y; this.local[k * 3 + 2] = _v.z;
        const pin = c.pin?.[i] ?? (i === 0 ? 1 : 0);
        this.pin[k] = pin; this.w[k] = pin >= 1 ? 0 : 1;
        this.rad[k] = c.radius ?? 0.02; this.mask[k] = c.mask ?? 0;
        this.drag[k] = c.drag ?? 1.8; this.grav[k] = c.gravity ?? 1;
        this.flut[k] = (c.flutter ?? 0.4) * (i / Math.max(1, c.nodes.length - 1));
        if (i > 0) { const a = c.nodes[i - 1]; len.push(Math.hypot(px - a[0], py - a[1], pz - a[2])); }
      }
      this.chains.push({ o, n: c.nodes.length, parent: c.parent, rel0, dir0, len: new Float32Array(len), bone0: c.bone0, stiff: c.stiff ?? 0.3, name: c.name, ftl: c.ftl ?? 1.04 });
      o += c.nodes.length;
    }
    // constraints: along-chain (i,i+1), bend (i,i+2), cross links
    const ca = [], cb = [], cl = [], ck = [];
    const add = (a, b, k) => {
      ca.push(a); cb.push(b); ck.push(k);
      cl.push(Math.hypot(this.rest[a * 3] - this.rest[b * 3], this.rest[a * 3 + 1] - this.rest[b * 3 + 1], this.rest[a * 3 + 2] - this.rest[b * 3 + 2]));
    };
    for (const c of this.chains) {
      for (let i = 0; i < c.n - 1; i++) add(c.o + i, c.o + i + 1, 1);
      if (c.stiff > 0) for (let i = 0; i < c.n - 2; i++) add(c.o + i, c.o + i + 2, c.stiff);
    }
    for (const L of links) {
      const a = this.chains[L.a[0]].o + L.a[1], b = this.chains[L.b[0]].o + L.b[1];
      add(a, b, L.k ?? 1);
    }
    this.ca = Int32Array.from(ca); this.cb = Int32Array.from(cb); this.cl = Float32Array.from(cl); this.ck = Float32Array.from(ck);
    this.caps = new Float32Array(16 * 8);  // ax ay az bx by bz r mask
    this.nCaps = 0;
    this.iterations = opts.iterations ?? 4;
    this.windScale = opts.windScale ?? 3.2;   // m/s of air per unit of windVector
    this.enabled = true;
    this.ground = -1e9;
    this._hPrev = 1 / 60;
    this._rootPrev = new THREE.Vector3();
    this._hasPrev = false;
    this.q = Array.from({ length: n }, () => new THREE.Quaternion());
  }

  /** Pinned target of particle k (world) → out. */
  _target(k, parentWorld, out) {
    return out.set(this.local[k * 3], this.local[k * 3 + 1], this.local[k * 3 + 2]).applyMatrix4(parentWorld);
  }

  /** Snap every particle to its skinned rest position (after teleports / pose jumps). */
  reset() {
    for (const c of this.chains) {
      const pw = this.bones[c.parent].matrixWorld;
      for (let i = 0; i < c.n; i++) {
        const k = c.o + i;
        this._target(k, pw, _v);
        this.x[k * 3] = this.p[k * 3] = _v.x; this.x[k * 3 + 1] = this.p[k * 3 + 1] = _v.y; this.x[k * 3 + 2] = this.p[k * 3 + 2] = _v.z;
      }
    }
    if (this.root) this._rootPrev.setFromMatrixPosition(this.root.matrixWorld);
    this._hasPrev = true;
  }

  /** Reset only one chain (e.g. the tassel when the sword jumps between hand and scabbard). */
  resetChain(name) {
    for (const c of this.chains) {
      if (c.name !== name) continue;
      const pw = this.bones[c.parent].matrixWorld;
      for (let i = 0; i < c.n; i++) {
        const k = c.o + i;
        this._target(k, pw, _v);
        this.x[k * 3] = this.p[k * 3] = _v.x; this.x[k * 3 + 1] = this.p[k * 3 + 1] = _v.y; this.x[k * 3 + 2] = this.p[k * 3 + 2] = _v.z;
      }
    }
  }

  /**
   * Advance the simulation. Call after the animator posed the rig and the group's world matrices are current.
   * @param {number} dt scaled sim seconds
   * @param {number} t sim time (wind phase)
   * @param {number} quality 1 = full, 0.5 = fewer iterations (far actors); 0 = skip (keeps last pose attached)
   */
  step(dt, t, quality = 1) {
    if (!this._hasPrev) this.reset();
    // teleport guard: large root jumps reset the cloth instead of whipping it across the map
    if (this.root) {
      _v.setFromMatrixPosition(this.root.matrixWorld);
      if (_v.distanceToSquared(this._rootPrev) > 2.5 * 2.5) this.reset();
      else if (this._hasPrev) {
        // inertia scale: carry most of the root's translation with the cloth, so dodges/lunges make it flutter
        // instead of leaving whole panels behind as rigid boards
        const k = 0.8, dx = (_v.x - this._rootPrev.x) * k, dy = (_v.y - this._rootPrev.y) * k, dz = (_v.z - this._rootPrev.z) * k;
        const X = this.x, P = this.p;
        for (let i = 0; i < this.n; i++) {
          if (this.pin[i] >= 1) continue;
          const i3 = i * 3;
          X[i3] += dx; X[i3 + 1] += dy; X[i3 + 2] += dz; P[i3] += dx; P[i3 + 1] += dy; P[i3 + 2] += dz;
        }
      }
      this._rootPrev.copy(_v);
      this.ground = _v.y;
    }
    if (this.capsuleFn) this.nCaps = this.capsuleFn(this.caps);
    if (dt <= 1e-6 || quality <= 0) { this._pinOnly(); this.writeBones(); return; }
    const steps = Math.min(4, Math.max(1, Math.ceil(dt * 60 - 1e-3)));
    const h = dt / steps;
    const iters = quality >= 1 ? this.iterations : Math.max(2, Math.round(this.iterations * quality));
    // wind at the character (one sample; flutter varies per particle)
    if (this.root) _v.setFromMatrixPosition(this.root.matrixWorld); else _v.set(0, 0, 0);
    windVector(_v.x, _v.z, t, _wind);
    const wx = _wind.x * this.windScale, wz = _wind.y * this.windScale;
    const flut = windFlutter(_v.x, _v.z, t);
    for (let s = 0; s < steps; s++) {
      this._integrate(h, wx, wz, flut, t + h * s);
      for (let it = 0; it < iters; it++) { this._solve(); this._collide(); }
      this._ftl();
      this._clampDeviation();
      this._collide();
      this._hPrev = h;
    }
    this.writeBones();
  }

  _pinOnly() {
    for (const c of this.chains) {
      const pw = this.bones[c.parent].matrixWorld;
      for (let i = 0; i < c.n; i++) {
        const k = c.o + i;
        if (this.pin[k] < 1) continue;
        this._target(k, pw, _v);
        this.x[k * 3] = this.p[k * 3] = _v.x; this.x[k * 3 + 1] = this.p[k * 3 + 1] = _v.y; this.x[k * 3 + 2] = this.p[k * 3 + 2] = _v.z;
      }
    }
  }

  _integrate(h, wx, wz, flut, t) {
    const X = this.x, P = this.p;
    const r = h / Math.max(this._hPrev, 1e-5);
    const h2 = h * h;
    for (const c of this.chains) {
      const pw = this.bones[c.parent].matrixWorld;
      for (let i = 0; i < c.n; i++) {
        const k = c.o + i, k3 = k * 3;
        const pin = this.pin[k];
        if (pin >= 1) {
          this._target(k, pw, _v);
          P[k3] = X[k3]; P[k3 + 1] = X[k3 + 1]; P[k3 + 2] = X[k3 + 2];
          X[k3] = _v.x; X[k3 + 1] = _v.y; X[k3 + 2] = _v.z;
          continue;
        }
        // velocity (verlet, rescaled for variable steps) with light damping
        const damp = 0.985;
        let vx = (X[k3] - P[k3]) * r * damp, vy = (X[k3 + 1] - P[k3 + 1]) * r * damp, vz = (X[k3 + 2] - P[k3 + 2]) * r * damp;
        // air: drag toward the wind velocity (per-particle flutter gives the cloth life)
        const kd = this.drag[k];
        const fph = t * 7.3 + k * 1.618;
        const f = this.flut[k] * (0.6 + 0.4 * flut);
        const ax = kd * (wx * (1 + f * Math.sin(fph)) - vx / h);
        const ay = kd * (f * 1.2 * Math.sin(fph * 1.37 + 1.1) - vy / h) * 0.35 - 9.81 * this.grav[k];
        const az = kd * (wz * (1 + f * Math.cos(fph * 0.83)) - vz / h);
        P[k3] = X[k3]; P[k3 + 1] = X[k3 + 1]; P[k3 + 2] = X[k3 + 2];
        X[k3] += vx + ax * h2; X[k3 + 1] += vy + ay * h2; X[k3 + 2] += vz + az * h2;
        // soft pin: pull toward the skinned rest position (keeps panels in shape without freezing them)
        if (pin > 0) {
          this._target(k, pw, _v);
          const a = 1 - Math.pow(1 - pin, h * 60);
          X[k3] += (_v.x - X[k3]) * a; X[k3 + 1] += (_v.y - X[k3 + 1]) * a; X[k3 + 2] += (_v.z - X[k3 + 2]) * a;
        }
      }
    }
  }

  _solve() {
    const X = this.x, W = this.w, A = this.ca, B = this.cb, L = this.cl, K = this.ck;
    for (let c = 0; c < A.length; c++) {
      const a = A[c], b = B[c], wa = W[a], wb = W[b], ws = wa + wb;
      if (ws <= 0) continue;
      const a3 = a * 3, b3 = b * 3;
      const dx = X[b3] - X[a3], dy = X[b3 + 1] - X[a3 + 1], dz = X[b3 + 2] - X[a3 + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1e-7) continue;
      const s = (d - L[c]) / (d * ws) * K[c];
      X[a3] += dx * s * wa; X[a3 + 1] += dy * s * wa; X[a3 + 2] += dz * s * wa;
      X[b3] -= dx * s * wb; X[b3 + 1] -= dy * s * wb; X[b3 + 2] -= dz * s * wb;
    }
  }

  /** Max deviation from the skinned rest position: 0.2 m at the root of a chain, growing toward the free end. */
  _clampDeviation() {
    const X = this.x;
    for (const c of this.chains) {
      const pw = this.bones[c.parent].matrixWorld;
      for (let i = 1; i < c.n; i++) {
        const k = c.o + i;
        if (this.pin[k] >= 1) continue;
        this._target(k, pw, _v);
        const k3 = k * 3, m = 0.2 + 0.14 * i;
        const dx = X[k3] - _v.x, dy = X[k3 + 1] - _v.y, dz = X[k3 + 2] - _v.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > m) { const s = m / d; X[k3] = _v.x + dx * s; X[k3 + 1] = _v.y + dy * s; X[k3 + 2] = _v.z + dz * s; }
      }
    }
  }

  /** Follow-the-leader: no segment may exceed ftl × rest length (inextensible ribbons, no stretchy skirts). */
  _ftl() {
    const X = this.x;
    for (const c of this.chains) {
      const lim = c.ftl;
      for (let i = 1; i < c.n; i++) {
        const k = c.o + i;
        if (this.w[k] === 0) continue;
        const a3 = (k - 1) * 3, b3 = k * 3;
        const dx = X[b3] - X[a3], dy = X[b3 + 1] - X[a3 + 1], dz = X[b3 + 2] - X[a3 + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz), m = c.len[i - 1] * lim;
        if (d > m) { const s = m / d; X[b3] = X[a3] + dx * s; X[b3 + 1] = X[a3 + 1] + dy * s; X[b3 + 2] = X[a3 + 2] + dz * s; }
      }
    }
  }

  _collide() {
    const X = this.x, C = this.caps, nc = this.nCaps, g = this.ground + 0.012;
    for (let k = 0; k < this.n; k++) {
      if (this.w[k] === 0) continue;
      const k3 = k * 3, m = this.mask[k], pr = this.rad[k];
      let x = X[k3], y = X[k3 + 1], z = X[k3 + 2];
      if (m) for (let c = 0; c < nc; c++) {
        const o = c * 8;
        if (!(C[o + 7] & m)) continue;
        const ax = C[o], ay = C[o + 1], az = C[o + 2];
        const bx = C[o + 3] - ax, by = C[o + 4] - ay, bz = C[o + 5] - az;
        const l2 = bx * bx + by * by + bz * bz;
        let tt = l2 > 1e-9 ? ((x - ax) * bx + (y - ay) * by + (z - az) * bz) / l2 : 0;
        tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
        const px = x - (ax + bx * tt), py = y - (ay + by * tt), pz = z - (az + bz * tt);
        const d2 = px * px + py * py + pz * pz, R = C[o + 6] + pr;
        if (d2 < R * R && d2 > 1e-12) {
          const d = Math.sqrt(d2), s = (R - d) / d;
          x += px * s; y += py * s; z += pz * s;
        }
      }
      if (y < g) y = g;
      X[k3] = x; X[k3 + 1] = y; X[k3 + 2] = z;
    }
  }

  /** Parallel-transport frames down every chain and write each node bone's world matrix. */
  writeBones() {
    const X = this.x;
    for (const c of this.chains) {
      const pw = this.bones[c.parent].matrixWorld;
      pw.decompose(_pp, _pq, _ps);
      // frame 0: parent rotation × rest offset, then swung from the (parent-carried) rest direction to the current one
      _q.copy(_pq).multiply(c.rel0);
      _v.copy(c.dir0).applyQuaternion(_pq);
      let px = _v.x, py = _v.y, pz = _v.z;
      for (let i = 0; i < c.n; i++) {
        const k = c.o + i, k3 = k * 3;
        let dx, dy, dz;
        if (i < c.n - 1) {
          dx = X[k3 + 3] - X[k3]; dy = X[k3 + 4] - X[k3 + 1]; dz = X[k3 + 5] - X[k3 + 2];
          const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1; dx /= l; dy /= l; dz /= l;
        } else { dx = px; dy = py; dz = pz; }
        arc(_q2, px, py, pz, dx, dy, dz);
        _q.premultiply(_q2);
        px = dx; py = dy; pz = dz;
        const bone = this.bones[c.bone0 + i];
        _v2.set(X[k3], X[k3 + 1], X[k3 + 2]);
        bone.matrixWorld.compose(_v2, _q, _one);
      }
    }
  }
}

/** Configure a bone so the scene graph never overwrites the matrixWorld the simulation writes. */
export function makeSimBone(name) {
  const b = new THREE.Bone();
  b.name = name;
  b.matrixAutoUpdate = false;
  b.matrixWorldAutoUpdate = false;
  return b;
}
